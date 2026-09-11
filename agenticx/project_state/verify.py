#!/usr/bin/env python3
"""verify.yaml runner for project_state E2E gates.

Author: Damon Li
"""

from __future__ import annotations

import shlex
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from agenticx.project_state.store import ProjectStateError, ProjectStore
from agenticx.runtime.command_sandbox import (
    WORKSPACE_WRITE,
    CommandSandboxError,
    build_command_sandbox_plan,
)

VERIFY_SCHEMA_VERSION = 1
ALLOWED_STEP_TYPES = {"shell", "pytest", "npm", "lint"}


@dataclass
class StepResult:
    name: str
    type: str
    passed: bool
    exit_code: int
    duration_sec: float
    timeout: bool = False
    log_excerpt: str = ""


@dataclass
class VerifyResult:
    passed: bool
    steps: List[StepResult] = field(default_factory=list)
    summary: str = ""
    log_path: Optional[Path] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "summary": self.summary,
            "log_path": str(self.log_path) if self.log_path else None,
            "steps": [
                {
                    "name": s.name,
                    "type": s.type,
                    "passed": s.passed,
                    "exit_code": s.exit_code,
                    "duration_sec": round(s.duration_sec, 3),
                    "timeout": s.timeout,
                }
                for s in self.steps
            ],
        }


def _load_yaml(path: Path) -> Dict[str, Any]:
    import yaml  # type: ignore

    if not path.is_file():
        raise ProjectStateError(f"verify.yaml not found at {path}")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:  # pragma: no cover - defensive
        raise ProjectStateError(f"verify.yaml parse failed: {exc}") from exc
    if not isinstance(data, dict):
        raise ProjectStateError("verify.yaml root must be a mapping")
    version = int(data.get("schema_version", VERIFY_SCHEMA_VERSION) or VERIFY_SCHEMA_VERSION)
    if version != VERIFY_SCHEMA_VERSION:
        raise ProjectStateError(f"unsupported verify.yaml schema_version: {version}")
    return data


def _build_command(step: Dict[str, Any]) -> List[str]:
    step_type = str(step.get("type", "shell")).strip().lower()
    if step_type not in ALLOWED_STEP_TYPES:
        raise ProjectStateError(f"unsupported verify step type: {step_type}")
    if step_type == "shell":
        cmd = step.get("cmd")
        if not cmd or not isinstance(cmd, str):
            raise ProjectStateError("shell step requires non-empty cmd string")
        return ["bash", "-lc", cmd]
    if step_type == "pytest":
        args = step.get("args") or []
        if not isinstance(args, list):
            raise ProjectStateError("pytest step args must be list")
        return ["python", "-m", "pytest", *[str(x) for x in args]]
    if step_type == "npm":
        script = step.get("script")
        if not script or not isinstance(script, str):
            raise ProjectStateError("npm step requires script string")
        return ["npm", "run", script]
    if step_type == "lint":
        cmd = step.get("cmd")
        if not cmd or not isinstance(cmd, str):
            raise ProjectStateError("lint step requires cmd string")
        return shlex.split(cmd)
    raise ProjectStateError(f"unhandled step type: {step_type}")


def verify_step_commands(
    store: ProjectStore, *, only_step: Optional[str] = None
) -> List[tuple[str, str]]:
    """``(步骤名, 给风险分类器看的命令文本)``，按 verify.yaml 里的顺序。

    调用方拿它在**开跑之前**把每一步过一遍命令风险分类与确认闸。放在这里而不是让
    调用方自己解析 verify.yaml，是为了让「确认时看到的命令」和「真正执行的命令」出自
    同一份解析——两处各解析一次，迟早会出现「问的是 A、跑的是 B」。

    ``shell`` / ``lint`` 步返回用户写的原始 ``cmd``，不是 ``["bash", "-lc", cmd]``。
    分类器看到 ``bash`` 只会得出「bash 是白名单命令」，真正危险的那一串在参数里，
    等于没分类。
    """
    config = _load_yaml(store.verify_yaml_path)
    steps_raw = config.get("steps") or []
    if not isinstance(steps_raw, list):
        raise ProjectStateError("verify.yaml must define a non-empty steps list")

    out: List[tuple[str, str]] = []
    for raw in steps_raw:
        if not isinstance(raw, dict):
            raise ProjectStateError("verify step must be a mapping")
        name = str(raw.get("name") or raw.get("type") or "step").strip()
        if only_step and only_step != name:
            continue
        step_type = str(raw.get("type", "shell")).strip().lower()
        if step_type in {"shell", "lint"}:
            text = str(raw.get("cmd") or "").strip()
        else:
            text = shlex.join(_build_command(raw))
        if text:
            out.append((name, text))
    return out


def run_verify(
    store: ProjectStore,
    *,
    workspace_root: Path,
    feature_id: Optional[str] = None,
    only_step: Optional[str] = None,
    readable_roots: Sequence[Path] = (),
    denied_path_patterns: Sequence[str] = (),
    scope_id: str = "verify",
) -> VerifyResult:
    """Run all (or one) steps from verify.yaml under ``workspace_root``.

    每一步都走和 ``bash_exec`` 同一个 OS 沙箱。以前这里是裸的 ``subprocess.run``——
    于是 verify.yaml 里的一行 ``cmd`` 可以读写主机上任何地方,**绕过工作区边界、
    绕过 path_rules、也绕过 plan 模式**。而 verify.yaml 是仓库里的文件:谁能改这个
    仓,谁就能借 verify_run 拿到工作区之外的东西。

    沙箱不可用时**这一步判失败**,不退回裸执行。这条和 ``bash_exec`` 一致:
    「拿不到边界」不能等于「那就不要边界了」。

    **这里只有文件沙箱那一半。** 命令风险分类与确认闸在
    :func:`agenticx.cli.agent_tools.confirm_verify_steps`,由 ``dispatch_tool_async``
    在调到这里之前跑完——那一层才拿得到会话的确认闸。直接调本函数(比如 CLI 或用例)
    等于跳过了确认这条线,只剩文件边界。要新加一个调用方,先想清楚确认由谁来做。
    """
    config = _load_yaml(store.verify_yaml_path)
    steps_raw = config.get("steps") or []
    if not isinstance(steps_raw, list) or not steps_raw:
        raise ProjectStateError("verify.yaml must define a non-empty steps list")

    workspace_root = Path(workspace_root).expanduser().resolve()
    if not workspace_root.is_dir():
        raise ProjectStateError(f"workspace_root is not a directory: {workspace_root}")

    log_lines: List[str] = []
    step_results: List[StepResult] = []
    overall_passed = True

    for raw in steps_raw:
        if not isinstance(raw, dict):
            raise ProjectStateError("verify step must be a mapping")
        name = str(raw.get("name") or raw.get("type") or "step").strip()
        step_type = str(raw.get("type", "shell")).strip().lower()
        if only_step and only_step != name:
            continue
        timeout_sec = float(raw.get("timeout_sec", 600) or 600)
        cmd = _build_command(raw)
        log_lines.append(f"\n===== step: {name} ({step_type}) =====")
        log_lines.append(f"$ {' '.join(shlex.quote(c) for c in cmd)}")
        start = time.monotonic()
        timed_out = False
        exit_code = -1
        stdout_text = ""
        try:
            plan = build_command_sandbox_plan(
                cmd,
                permissions=WORKSPACE_WRITE,
                writable_roots=[workspace_root],
                readable_roots=list(readable_roots),
                denied_path_patterns=list(denied_path_patterns),
                scope_id=f"{scope_id}|{name}",
                cwd=workspace_root,
            )
        except CommandSandboxError as exc:
            # 拿不到边界就不跑。退回裸执行等于让 verify.yaml 里的一行 cmd 决定
            # 自己有多大权限——而那个文件是仓库内容，不是用户的设置。
            log_lines.append(f"[step {name}] sandbox unavailable: {exc}")
            step_results.append(
                StepResult(
                    name=name,
                    type=step_type,
                    passed=False,
                    exit_code=126,
                    duration_sec=time.monotonic() - start,
                    timeout=False,
                    log_excerpt=f"command sandbox unavailable: {exc}",
                )
            )
            overall_passed = False
            continue
        try:
            proc = subprocess.run(
                list(plan.argv),
                cwd=str(workspace_root),
                env=dict(plan.env),
                capture_output=True,
                text=True,
                timeout=timeout_sec,
                check=False,
            )
            exit_code = int(proc.returncode)
            stdout_text = (proc.stdout or "") + (proc.stderr or "")
        except subprocess.TimeoutExpired as exc:  # pragma: no cover - timing
            timed_out = True
            stdout_text = (exc.stdout or "") + (exc.stderr or "") if isinstance(exc.stdout, str) else ""
            exit_code = 124
        except FileNotFoundError as exc:
            stdout_text = f"command not found: {exc}"
            exit_code = 127

        duration = time.monotonic() - start
        log_lines.append(stdout_text)
        passed = (not timed_out) and exit_code == 0
        excerpt = "\n".join(stdout_text.splitlines()[-100:])
        step_results.append(
            StepResult(
                name=name,
                type=step_type,
                passed=passed,
                exit_code=exit_code,
                duration_sec=duration,
                timeout=timed_out,
                log_excerpt=excerpt,
            )
        )
        if not passed:
            overall_passed = False
            log_lines.append(f"[step {name}] FAIL exit={exit_code} timeout={timed_out}")
            break
        log_lines.append(f"[step {name}] PASS ({duration:.2f}s)")

    summary_lines = [
        f"verify {'PASS' if overall_passed else 'FAIL'}: "
        f"{sum(1 for s in step_results if s.passed)}/{len(step_results)} steps passed",
    ]
    if not overall_passed and step_results:
        last = step_results[-1]
        summary_lines.append(
            f"failed step: {last.name} type={last.type} exit={last.exit_code} timeout={last.timeout}"
        )

    log_path = store.archive_log(
        feature_id or "_general",
        "log",
        "\n".join(log_lines) + "\n",
    )

    return VerifyResult(
        passed=overall_passed,
        steps=step_results,
        summary="\n".join(summary_lines),
        log_path=log_path,
    )
