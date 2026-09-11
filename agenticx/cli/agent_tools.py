#!/usr/bin/env python3
"""Tool definitions and dispatchers for Studio agent loop.

Author: Damon Li
"""

from __future__ import annotations

import asyncio
import base64
import codecs
import contextlib
import difflib
import fnmatch
import hashlib
import json
import logging
import os
import re
import shlex
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from collections import deque
from dataclasses import dataclass
from urllib.parse import urlparse
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Iterable, Iterator, List, Mapping, NamedTuple, Optional, Tuple, Union

from agenticx.cli.config_manager import ConfigManager
from agenticx.cli.codegen_engine import CodeGenEngine, infer_output_path, write_generated_file
from agenticx.cli.studio_mcp import (
    import_mcp_config,
    load_available_servers,
    mcp_call_tool_async,
    mcp_connect,
)
from agenticx.cli.studio_skill import (
    get_all_skill_summaries,
    skill_is_allowed_for_session,
    skill_use as studio_skill_use,
)
from agenticx.llms.provider_resolver import ProviderResolver
from agenticx.features import local_knowledge_enabled
from agenticx.memory.session_store import SessionStore
from agenticx.memory.workspace_memory import WorkspaceMemoryStore
from agenticx.skills.guard import scan_skill, should_allow
from agenticx.tools.skill_bundle import SkillBundleLoader
from agenticx.tools.adapters.video_frames import VideoFrameExtractor
from agenticx.runtime.confirm import (
    ConfirmGate,
    SyncConfirmGate,
    confirm_denial_note,
    is_protected_confirm,
    protected_confirm_reason,
)
from agenticx.runtime.clarify import (
    AsyncClarifyGate,
    AutoSuspendClarifyGate,
    ClarifyGate,
)
from agenticx.runtime.path_policy import normalize_path_rules, path_rule_decision
from agenticx.runtime.command_safety import (
    NEVER_AUTO_APPROVED_CATEGORIES,
    absolute_redirect_targets,
    categories_requiring_approval,
    classify_simple_command,
    split_simple_commands,
)
from agenticx.runtime.command_sandbox import (
    READ_ONLY,
    DANGER_FULL_ACCESS,
    WORKSPACE_WRITE,
    CommandSandboxError,
    build_command_sandbox_plan,
    normalize_command_permissions,
)
from agenticx.runtime.token_budget import TOKEN_BUDGET_SCRATCHPAD_KEY
from agenticx.runtime.permission_mode import permission_mode_for_session
from agenticx.runtime.document_delivery import (
    DOCUMENT_MAX_BYTES,
    DocumentDeliveryError,
    append_current_turn_publication,
    archive_superseded_document,
    document_format_for_path,
    document_mime_type,
    fingerprint_bytes,
    fingerprint_document,
    fsync_directory,
    is_supported_document_path,
    remove_document_if_unchanged,
    restore_archived_document,
)
from agenticx.workspace.loader import (
    append_daily_memory,
    append_long_term_memory,
    ensure_workspace,
)
from agenticx.utils.agx_home import agx_home

if TYPE_CHECKING:
    from agenticx.cli.studio import StudioSession
else:
    StudioSession = Any

_log = logging.getLogger(__name__)
_CC_BRIDGE_AUTO_PROC: Optional[subprocess.Popen[str]] = None
_CC_BRIDGE_IDLE_TASK: Optional[asyncio.Task[Any]] = None
_CC_BRIDGE_LAST_ACTIVE_MONO: float = 0.0


#: 已退役。判定改成了「逐段解析 + 按参数判」，见
#: :mod:`agenticx.runtime.command_safety`。这张 18 条的名单同时又吵又漏：
#: 名单外的 ``sort`` / ``jq`` / ``stat`` 全要人批准，而名单内的 ``find`` 连
#: ``-delete`` 和 ``-exec rm`` 都直接放行——按命令名判断天然表达不了「哪个参数危险」。
#: 保留这个名字只为不破坏外部导入；生产代码里已无人使用。
SAFE_COMMANDS: frozenset[str] = frozenset()

MAX_READ_CHARS = 20_000
MAX_READ_CHARS_CODE_DEV = 8_000
# Cap bash_exec command string size (defense in depth; matches audit remediation).
MAX_BASH_EXEC_COMMAND_CHARS = 65536
PATH_GUARDED_READ_COMMANDS = {"cat", "head", "tail", "grep", "find", "wc", "ls", "tree"}
MAX_BASH_OUTPUT_TAIL_CHARS = 32_000
MAX_BASH_OUTPUT_LINE_CHARS = 8_192
MAX_BASH_OUTPUT_LINES = 512
_BASH_PIPE_READ_CHUNK = 64 * 1024
# Main-process credentials are for the dedicated Python bridge client only;
# never inherit them into model-invoked shell children where `env`/`printenv`
# could disclose them in a tool result.
_SENSITIVE_DESKTOP_CHILD_ENV = frozenset(
    {
        "AGX_ENTERPRISE_ACTION_BROKER_TOKEN",
        "AGX_ENTERPRISE_ACTION_BROKER_URL",
    }
)

# Tools safe to run concurrently when appearing in the same assistant tool_calls batch.
def _plan_mode_active(session: Optional[StudioSession] = None) -> bool:
    """Whether the owning session is in the read-only ``plan`` mode.

    Sessions created by SessionManager carry an explicit mode.  The fallback in
    :func:`permission_mode_for_session` keeps direct CLI/test sessions working.
    """
    return permission_mode_for_session(session) == "plan"


def _apply_permission_mode_ceiling(
    requested: str,
    session: Optional[StudioSession] = None,
) -> str:
    """Clamp the requested sandbox tier to what the session mode allows.

    ``permissions.mode = "plan"`` 在配置里一直写着「read-only」，但在加上只读沙箱档之前
    没有任何东西强制它——模型照样可以要 workspace-write 并且真的写进去。现在 plan 模式
    是一道**上限**：模型请求哪一档都会被压到 read-only。

    这是上限不是默认值：plan 模式下模型主动要 danger-full-access 也一样被压下来，
    否则「计划模式」这个承诺就是假的。对齐 Claude Code 的 plan 模式——那一档下
    根本不提供修改能力，而不是「修改前问一下」。
    """
    return READ_ONLY if _plan_mode_active(session) else requested


class AllowedCommandRule(NamedTuple):
    """一条「不再询问」规则,以及它按哪种语义匹配。

    ``literal=True`` 的规则**一字不差**地比对整段命令,不做 glob 展开。界面上按下
    「以后都不再问这条命令」写下的就是这种——用户当时看着的是一条具体命令,他同意的
    也就是那一条。命令里恰好带 ``*`` 时(``rm -rf *``、``ls *.py``)按 fnmatch 存,
    会把「这一条」悄悄放大成「这一类」,而界面上仍然只显示那条命令。
    """

    pattern: str
    literal: bool


def _allowed_command_patterns_for_workspace(
    raw: list,
    cwd: Optional[Path],
) -> List[AllowedCommandRule]:
    """Rules that apply to the session's current workspace.

    两种写法都收，语义不同：

    - ``"npm run test*"`` —— 手写的旧格式，**fnmatch 模式**，**全局生效**。保留是为了
      不作废已有配置，但它正是「跨项目泛化」的来源。
    - ``{"pattern": "npm run test", "workspace": "/path/to/proj"}`` —— 界面写的，
      **整段完全相等**才算命中，且只在该工作区（及其子目录）内生效。在 A 项目按下的
      「不再询问」不该悄悄作用于 B 项目：同一条命令在两个仓里的含义可以完全不同。

    绑定的是**命令实际执行的目录**，不是会话挂载的所有根。一个会话可以同时挂载 A、B 两个
    项目；只要「授权工作区出现在任意挂载根里」就放行的话，在 A 里按下的批准会连带放行在
    B 里跑的同一条命令。判据必须是「这条命令现在跑在哪」。

    取不到执行目录时，**只认全局规则**——宁可多问，也不拿一条别处的授权来放行。
    """
    current: Optional[Path] = None
    if cwd is not None:
        try:
            current = _safe_resolve_path(Path(cwd))
        except Exception:
            current = None

    out: List[AllowedCommandRule] = []
    for entry in raw:
        if isinstance(entry, str):
            pattern = entry.strip()
            if pattern:
                out.append(AllowedCommandRule(pattern, literal=False))
            continue
        if not isinstance(entry, dict):
            continue
        pattern = str(entry.get("pattern", "") or "").strip()
        if not pattern:
            continue
        scope = str(entry.get("workspace", "") or "").strip()
        if not scope:
            # 界面永远会带上工作区（后端也拒绝不带的写入）。手写成 dict 但漏了
            # workspace 的，按全局规则处理，语义仍然是「完全相等」。
            out.append(AllowedCommandRule(pattern, literal=True))
            continue
        try:
            scope_path = _safe_resolve_path(Path(scope).expanduser())
        except Exception:
            continue
        if current is not None and _is_path_under_root(current, scope_path):
            out.append(AllowedCommandRule(pattern, literal=True))
    return out


def command_allowed_without_confirm(
    command: str,
    risk_codes: Iterable[str] = (),
    cwd: Optional[Path] = None,
) -> bool:
    """Whether ``permissions.allowed_commands`` says this command never needs asking.

    这是「不再询问」的落点：界面上按下那个按钮，写下的就是一条用户本可以手写的
    fnmatch 规则，然后由这里读。**不另建一套机制**——多一套并行的记忆，就多一处会和
    配置界面显示不一致的地方（对齐 Claude Code 的做法：允许规则就是 settings 里的
    一行）。

    三条约束：

    1. **deny 永远赢。** 调用方在此之前已经走过
       :func:`command_denied_by_session_permissions`，这里不重复判断，但次序不能颠倒。
    2. **每一段都要被允许。** ``ls && curl x`` 里只允许了 ``ls`` 不算数——否则
       加个已允许的前缀就能把任何命令带进来。

       例外是**整条完全相等的字面规则**：界面上批准 ``npm install && echo done``
       写下的就是这一整条，逐段去比它当然一段都对不上。这不是放宽——按下按钮时
       用户看到的、同意的，就是这一整条复合命令本身，一字不差地再来一次没有引入
       任何新东西。前缀绕过在这里不成立：换成 ``ls && npm install && echo done``
       整条就不再相等，会退回逐段判定。
    3. **三类高危永不豁免**（:data:`NEVER_AUTO_APPROVED_CATEGORIES`）：推远端、动系统、
       退出工作区隔离。用户当时同意的是那一次的上下文，不是往后所有次。
    """
    codes = {str(code).strip() for code in risk_codes}
    if codes & NEVER_AUTO_APPROVED_CATEGORIES:
        return False
    try:
        raw = ConfigManager.get_value("permissions.allowed_commands")
    except Exception:
        return False
    if not isinstance(raw, list):
        return False
    patterns = _allowed_command_patterns_for_workspace(raw, cwd)
    if not patterns:
        return False

    text = str(command or "").strip()
    if not text:
        return False

    # 整条完全相等的字面规则先判：复合命令是作为一整条被批准的，拆开逐段比对
    # 永远对不上（见上面第 2 条的例外说明）。
    if any(rule.literal and text == rule.pattern for rule in patterns):
        return True

    leaves = split_simple_commands(text)
    if leaves is None:
        # 拆不动就不豁免：看不懂的结构里可能藏着没被规则覆盖的命令。
        return False
    segments = [" ".join(leaf) for leaf in leaves] or [text]

    def _matches(segment: str, rule: AllowedCommandRule) -> bool:
        if rule.literal:
            return segment == rule.pattern
        return fnmatch.fnmatch(segment, rule.pattern)

    return all(
        any(_matches(segment, rule) for rule in patterns) for segment in segments
    )


def command_denied_by_session_permissions(command: str) -> Optional[str]:
    """Return a denial message if ``permissions.denied_commands`` matches.

    与 :func:`tool_denied_by_session_permissions` 同一个立场：**deny 是绝对的**，
    在确认闸之前短路，不提供「批准一次」的选项（ADR 0001；也是 Claude Code 的
    deny > ask > allow 次序）。用户写下一条禁令，就不该再被问「要不要破例」。

    **按段匹配**，不是整条匹配：``denied_commands: ["curl *"]`` 必须能拦住
    ``ls && curl http://x``。只比对整条命令的话，加一个 ``ls &&`` 前缀就绕过去了。
    拆不动的命令（命令替换等）退回整条比对——那种情况本来就会因为
    ``shell_composition`` 走确认闸。

    Patterns use :func:`fnmatch.fnmatch`（例如 ``curl *``、``*rm -rf*``）。
    """
    raw = ConfigManager.get_value("permissions.denied_commands")
    if not isinstance(raw, list):
        return None
    text = str(command or "").strip()
    if not text:
        return None

    leaves = split_simple_commands(text)
    candidates = [text]
    if leaves:
        candidates.extend(" ".join(leaf) for leaf in leaves)

    for entry in raw:
        pattern = str(entry or "").strip()
        if not pattern:
            continue
        for candidate in candidates:
            if fnmatch.fnmatch(candidate, pattern):
                return (
                    f"command blocked by permissions.denied_commands "
                    f"(pattern {pattern!r} matched {candidate!r})"
                )
    return None


#: plan（只读）模式下必须拒绝的工具。
#:
#: 「计划模式完全不修改」这个承诺不能只靠文件路径校验兜底：codegen 用普通读路径解析后
#: 直接写文件，memory_append / skill_manage / hook_manage / 定时任务 / 项目状态 / 经验库
#: 也各有自己的写入路径，都不走 ``_resolve_workspace_path(for_write=True)``。
#:
#: 所以策略要在**统一工具调度入口**先拦一道（与 denied_tools 同一处），具体路径校验只是
#: 第二道防线。名单按「这个工具会不会产生本次会话之外的持久副作用」来划——只读检索、
#: 诊断、澄清一律放行，plan 模式是「不修改」，不是「不能看」。
PLAN_MODE_BLOCKED_TOOLS: frozenset[str] = frozenset({
    # 文件与代码
    "file_write", "file_edit", "codegen", "document_generate", "document_publish",
    # 长期记忆与经验
    "memory_append", "memory_forget", "task_experience_learn", "task_experience_clear",
    # 技能与扩展
    "skill_manage", "skill_market_install", "skill_import_repo",
    # 钩子与项目状态
    "hook_manage", "project_init",
    # 项目状态的写入面：feature_select / feature_complete 改的是特性表，
    # verify_run 更狠——它直接 subprocess.run 项目 verify.yaml 里写的命令，
    # 不经过命令沙箱。plan 模式下这等于「只读」承诺被一条项目配置绕开。
    "feature_select", "feature_complete", "verify_run",
    # 定时任务
    "schedule_task", "update_scheduled_task", "cancel_scheduled_task",
    # 会话内草稿与进度（会落盘，且会影响后续运行）
    "scratchpad_write", "progress_append", "todo_write",
    # 外部桥接：能在别处产生副作用
    "cc_bridge_send", "cc_bridge_start", "cc_bridge_stop", "cc_bridge_permission",
    "mcp_connect", "mcp_import",
    # MCP：服务端能写文件、开浏览器、发消息，这里看不到它具体要干什么。
    # 动态 MCP 工具用的是公开工具名，不叫 mcp_call——那条路径在
    # dispatch_tool_async 的动态分支里单独按 mcp_call 判一次。
    "mcp_call",
    # 外发与配置
    "send_bug_report_email", "update_email_config",
    # 会创建长期存在的实体（分身工作区、项目群、任务空间）
    "create_avatar", "create_group_chat", "install_portable_package", "set_taskspace",
})

# 委派类工具（spawn_subagent / delegate_to_avatar / send_message_to_agent …）
# 故意不在名单里：被委派方同样跑在这个进程里，它的每次工具调用都会再经过
# tool_policy_denial，plan 上限是继承的。挡在这里只会让 plan 模式没法并行调研，
# 换不来任何额外的只读保证。


def tool_blocked_by_plan_mode(
    tool_name: str,
    session: Optional[StudioSession] = None,
) -> Optional[str]:
    """Return a denial message when plan (read-only) mode forbids this tool.

    与 :func:`tool_denied_by_session_permissions` 挂在同一处：**统一工具调度入口**，
    在 hook 与确认闸之前。只在 bash 那条路径上钳制沙箱档位是不够的——大多数写工具
    根本不经过 bash。

    ``bash_exec`` / ``bash_bg_start`` 不在名单里：它们由沙箱档位钳到 read-only，
    命令能跑但写不进去，比一刀切拒绝更有用（plan 模式仍然要能 grep、能看 git log）。
    """
    if not _plan_mode_active(session):
        return None
    name = str(tool_name or "").strip()
    if name in PLAN_MODE_BLOCKED_TOOLS:
        return (
            f"tool '{name}' is disabled while this session is in 'plan' (read-only) mode. "
            "Switch the permission mode before making changes."
        )
    return None


def tool_denied_by_session_permissions(tool_name: str) -> Optional[str]:
    """Return a denial message if ``permissions.denied_tools`` matches the tool.

    Policy deny must short-circuit before confirm gates (see ADR 0001).
    Patterns use :func:`fnmatch.fnmatch` (e.g. ``bash_*``).
    """
    raw = ConfigManager.get_value("permissions.denied_tools")
    if not isinstance(raw, list):
        return None
    name = str(tool_name or "").strip()
    if not name:
        return None
    for entry in raw:
        pat = str(entry or "").strip()
        if not pat:
            continue
        if fnmatch.fnmatch(name, pat) or fnmatch.fnmatch(name.lower(), pat.lower()):
            return f"工具「{name}」已被会话权限策略拒绝（匹配规则: {pat}）。"
    return None


def tool_policy_denial(
    tool_name: str,
    session: Optional[StudioSession] = None,
) -> Optional[str]:
    """The one gate: ``denied_tools`` + plan 上限，供**每一条**调度路径调用。

    以前这两条检查只挂在 ``AgentRuntime`` 的聊天主循环里。那不是统一入口——
    ``dispatch_tool_async`` 才是：语音工具代理（studio/voice_endpoints.py）直接调它，
    知识预取和同步版 ``dispatch_tool`` 也直接调它。实测在 ``denied_tools=["mcp_call"]``
    下，主循环拒绝、直接调度照常执行。

    所以真正的闸放在 ``dispatch_tool_async`` 的第一行；主循环里那次保留，
    因为它能在发出 TOOL_CALL 事件的位置给出被拒卡片，属于更好的反馈而不是安全边界。
    """
    return tool_denied_by_session_permissions(tool_name) or tool_blocked_by_plan_mode(
        tool_name,
        session,
    )


_CONCURRENCY_SAFE_STUDIO_TOOLS = frozenset(
    {
        "file_read",
        "skill_list",
        "scratchpad_read",
        "memory_search",
        "memory_forget",
        "session_search",
        "list_files",
        "liteparse",
        "video_understand",
        "lsp_goto_definition",
        "lsp_find_references",
        "lsp_hover",
        "lsp_diagnostics",
        "code_outline",
        "list_scheduled_tasks",
        "get_automation_task_logs",
        "cc_bridge_list",
        "bash_bg_poll",
        "knowledge_search",  # Plan-Id: machi-kb-stage1-local-mvp — read-only vector search.
        "knowledge_synthesize",
        "web_search",
        "get_current_datetime",
        "web_fetch",
        "view_image",
        "show_widget",
        "list_data_sources",
    }
)


def _bash_exec_is_read_only(arguments: Dict[str, Any]) -> bool:
    """Heuristic: treat obvious mutating shell patterns as non-read-only."""
    cmd = str(arguments.get("command", "") or "")
    if not cmd.strip():
        return True
    if ">>" in cmd:
        return False
    # Single `>` redirect (not `>=` etc.)
    for i, ch in enumerate(cmd):
        if ch == ">" and (i == 0 or cmd[i - 1] not in ">="):
            return False
    lowered = " " + cmd.lower() + " "
    for needle in (" rm ", " mv ", " mkdir ", " touch ", " tee ", "git push", "git commit"):
        if needle in lowered:
            return False
    stripped = cmd.strip().lower()
    if stripped.startswith(("rm ", "mv ", "mkdir ", "touch ")):
        return False
    return True


def studio_tool_is_concurrency_safe(tool_name: str, arguments: Dict[str, Any]) -> bool:
    """Return True if this invocation may run in parallel with other safe tools."""
    name = str(tool_name or "").strip().lower()
    if not name or name == "none":
        return False
    if name == "bash_exec":
        return _bash_exec_is_read_only(arguments)
    return name in _CONCURRENCY_SAFE_STUDIO_TOOLS


def _workspace_root() -> Path:
    configured = os.getenv("AGX_WORKSPACE_ROOT", "").strip()
    if configured:
        try:
            return Path(configured).expanduser().resolve(strict=False)
        except Exception:
            pass
    from agenticx.workspace.loader import resolve_workspace_dir

    return resolve_workspace_dir()


def _load_default_workspace_mounts(default_root: Path) -> List[Dict[str, Any]]:
    """Load ``.agx-mounts.json`` from a session default workspace root."""
    mounts_file = Path(default_root) / ".agx-mounts.json"
    try:
        raw = json.loads(mounts_file.read_text(encoding="utf-8"))
    except Exception:
        return []
    rows = raw.get("mounts") if isinstance(raw, dict) else None
    if not isinstance(rows, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in rows:
        if isinstance(item, dict):
            out.append(item)
    return out


def _session_workspace_root_sets(
    session: Optional[StudioSession],
) -> tuple[List[Path], List[Path]]:
    """Return ``(read_roots, write_roots)`` for this session.

    - ``write_roots``: session default workspace + link mounts' source paths +
      non-reference taskspace roots.
    - ``read_roots``: write_roots + reference mount source paths (read-only).
    """
    write_roots: List[Path] = []
    read_only_roots: List[Path] = []
    seen_write: set[str] = set()
    seen_read: set[str] = set()

    def _add(raw: str, *, writable: bool) -> None:
        text = (raw or "").strip()
        if not text:
            return
        try:
            candidate = Path(text).expanduser().resolve(strict=False)
        except Exception:
            return
        key = str(candidate)
        if writable:
            if key in seen_write:
                return
            seen_write.add(key)
            write_roots.append(candidate)
        if key in seen_read:
            return
        seen_read.add(key)
        if not writable:
            read_only_roots.append(candidate)

    default_paths: List[str] = []
    if session is not None:
        taskspaces = getattr(session, "taskspaces", None)
        if isinstance(taskspaces, list):
            for item in taskspaces:
                if not isinstance(item, dict):
                    continue
                raw_path = str(item.get("path", "") or "").strip()
                if not raw_path:
                    continue
                ts_id = str(item.get("id", "") or "").strip()
                mode = str(item.get("mount_mode") or "link").strip().lower()
                source_path = str(item.get("source_path") or "").strip()
                if ts_id == "default":
                    # 先记下、循环结束后再加。Desktop 传过来的 taskspaces 里"默认工作区"
                    # 恒在第一位，如果在这里就 _add，它会占住 write_roots[0]，于是
                    # list_files(".")、相对路径的 file_write 全都落到数字专家自己的
                    # $AGX_HOME/avatars/<id>/workspace，而不是用户在工作区面板里绑定的
                    # 目录。c33a31c0 当初就是为这件事把 extra/default 分开收集的，
                    # ee5b7d6c 重写成 read/write 两套 root 时把这个顺序丢了。
                    # 注意这条路径只在用户没点过工作区页签（active_taskspace_id 为空，
                    # 也就是 Desktop 的默认状态）时生效；点过就走下面的 active 置顶。
                    default_paths.append(raw_path)
                    continue
                if mode == "reference":
                    _add(source_path or raw_path, writable=False)
                else:
                    _add(raw_path, writable=True)
                    if mode == "link" and source_path:
                        _add(source_path, writable=True)
        for raw_path in default_paths:
            _add(raw_path, writable=True)
        _add(str(getattr(session, "workspace_dir", "") or ""), writable=True)

    for p in default_paths:
        try:
            default_root = Path(p).expanduser().resolve(strict=False)
        except Exception:
            continue
        for mount in _load_default_workspace_mounts(default_root):
            mode = str(mount.get("mode") or "link").strip().lower()
            source_path = str(mount.get("source_path") or "").strip()
            if not source_path:
                continue
            if mode == "reference":
                _add(source_path, writable=False)
            elif mode == "link":
                _add(source_path, writable=True)
            # copy mode: destination already under default_root (writable)

    # Fallback only. Desktop sets AGX_WORKSPACE_ROOT to the user home, so adding
    # it unconditionally would make everything under $HOME writable and defeat
    # per-mount permissions.
    if not write_roots:
        _add(str(_workspace_root()), writable=True)
    if not write_roots and not read_only_roots:
        _add(str(Path.cwd().resolve(strict=False)), writable=True)

    if session is not None:
        raw_active = getattr(session, "active_taskspace_id", None)
        active_id = str(raw_active).strip() if raw_active is not None else ""
        if active_id:
            taskspaces_active = getattr(session, "taskspaces", None)
            if isinstance(taskspaces_active, list):
                for item in taskspaces_active:
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("id", "") or "").strip() != active_id:
                        continue
                    raw_path = str(item.get("path", "") or "").strip()
                    if not raw_path:
                        break
                    try:
                        target = Path(raw_path).expanduser().resolve(strict=False)
                    except Exception:
                        break
                    tkey = str(target)
                    write_roots = [r for r in write_roots if str(r) != tkey]
                    write_roots.insert(0, target)
                    seen_write.add(tkey)
                    break

    read_roots = list(write_roots) + [r for r in read_only_roots if str(r) not in seen_write]
    return read_roots, write_roots


def _context_files_read_allowlist(session: Optional[StudioSession]) -> List[Path]:
    """Exact files explicitly attached or @-referenced in this session."""

    if session is None:
        return []
    raw = getattr(session, "context_files", None)
    if not isinstance(raw, dict) or not raw:
        return []
    from agenticx.studio.context_file_keys import disk_path_from_context_file_key

    allowed: List[Path] = []
    seen: set[str] = set()
    for key in raw.keys():
        disk = disk_path_from_context_file_key(str(key))
        if not disk:
            continue
        candidate = Path(disk)
        try:
            if candidate.exists() and not candidate.is_file():
                continue
        except OSError:
            continue
        if disk in seen:
            continue
        seen.add(disk)
        allowed.append(candidate)
    return allowed


def _is_context_file_read_allowed(
    resolved: Path,
    session: Optional[StudioSession],
) -> bool:
    wanted = str(_safe_resolve_path(resolved))
    return any(
        str(_safe_resolve_path(candidate)) == wanted
        for candidate in _context_files_read_allowlist(session)
    )


def _session_workspace_roots(session: Optional[StudioSession]) -> List[Path]:
    """Ordered filesystem roots for this session (read-capable)."""
    read_roots, _write_roots = _session_workspace_root_sets(session)
    return read_roots


def _is_path_under_root(candidate: Path, root: Path) -> bool:
    try:
        cand = _safe_resolve_path(candidate)
        base = _safe_resolve_path(root)
        cand.relative_to(base)
        return True
    except ValueError:
        return False


_SYSTEM_ALIAS_TARGETS = {
    "/var": "/private/var",
    "/tmp": "/private/tmp",
}


def _path_has_unsafe_symlink_component(path: Path) -> bool:
    """Check lexical components before ``resolve`` for write safety."""

    expanded = path.expanduser()
    if not expanded.is_absolute():
        expanded = Path.cwd() / expanded
    lexical = Path(os.path.abspath(os.fspath(expanded)))
    current = Path(lexical.anchor) if lexical.anchor else Path()
    parts = lexical.parts[1:] if lexical.anchor else lexical.parts
    for part in parts:
        current = current / part
        try:
            if current.is_symlink():
                expected = _SYSTEM_ALIAS_TARGETS.get(str(current))
                if expected and str(current.resolve(strict=False)) == expected:
                    continue
                return True
        except OSError:
            return True
    return False


def _safe_resolve_path(path: Path) -> Path:
    """Resolve path; for missing leaves, resolve the nearest existing ancestor."""
    expanded = path.expanduser()
    try:
        return expanded.resolve(strict=False)
    except Exception:
        return expanded.absolute()


def _desktop_unrestricted_fs_enabled() -> bool:
    value = os.getenv("AGX_DESKTOP_UNRESTRICTED_FS", "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _detect_target(text: str) -> str:
    lowered = text.lower()
    if "workflow" in lowered or "工作流" in lowered or "pipeline" in lowered:
        return "workflow"
    if "tool" in lowered or "工具" in lowered:
        return "tool"
    if "skill" in lowered or "技能" in lowered:
        return "skill"
    return "agent"


from agenticx.runtime.prompts.tool_discipline import (
    QUERY_DATA_SOURCE_USAGE,
    SHOW_WIDGET_USAGE,
    SKILL_MANAGE_USAGE,
)

STUDIO_TOOLS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "request_clarification",
            "description": (
                "Ask the user an open-ended question and BLOCK until they answer. Use this whenever you need a "
                "human decision before proceeding: plan sign-off, choosing between options, missing parameters, "
                "color/style/preference, scope confirmation. Do NOT write the question as plain text and end the "
                "turn -- call this tool instead so the user gets a blocking prompt with option buttons and a free-"
                "text box, and your turn continues from their answer. The tool result text is the user's answer; "
                "continue the same turn based on it. In unattended/automation sessions this returns a suspended "
                "sentinel -- wrap up the turn and persist the pending question as a todo."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The question to ask the user, in natural language. Be specific.",
                    },
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Flat preset options (0-8) when all choices are independent toggles "
                            "or a single combined question. User may select multiple. Prefer "
                            "`decisions` instead when you need separate answers per dimension."
                        ),
                    },
                    "decisions": {
                        "type": "array",
                        "description": (
                            "Structured multi-part sign-off: one entry per independent decision "
                            "(e.g. duration / copy / color). Each item has its own question and "
                            "options; the UI renders a decision chain. Use this when prompt mentions "
                            "multiple key decisions — do NOT flatten into one options list."
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "Stable id, e.g. duration / copy / palette.",
                                },
                                "question": {
                                    "type": "string",
                                    "description": "The decision question for this dimension.",
                                },
                                "options": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": (
                                        "2-6 options for this dimension. Mutually exclusive when "
                                        "selection_mode is single (default); combinable when multiple."
                                    ),
                                },
                                "selection_mode": {
                                    "type": "string",
                                    "enum": ["single", "multiple"],
                                    "description": "Selection behavior for this decision. Defaults to single.",
                                },
                                "exclusive_options": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": (
                                        "Exact option labels that cannot be combined with other selections. "
                                        "Only used when selection_mode is multiple."
                                    ),
                                },
                            },
                            "required": ["question", "options"],
                            "additionalProperties": False,
                        },
                    },
                    "allow_free_text": {
                        "type": "boolean",
                        "description": "Whether the user can type a custom answer (default true).",
                    },
                    "context": {
                        "type": "object",
                        "description": "Optional extra context to show in the prompt card (e.g. plan summary).",
                    },
                },
                "required": ["prompt"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "request_action_confirmation",
            "description": (
                "Ask the user to confirm or cancel an irreversible / external write action and BLOCK until they "
                "decide. Use for sending email, submitting approvals, publishing content, deleting remote "
                "resources, etc. Do NOT end the turn with plain-text 'please confirm' — call this tool so the UI "
                "shows equal-width Confirm/Cancel buttons (and typed 确认/取消 still works). The tool result tells "
                "you whether to proceed in the SAME turn. Do NOT put secrets, OAuth tokens, or confirmation "
                "tokens in arguments. Permission confirms for shell/file tools still use confirm_required."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short confirmation title shown on the card (1-200 chars).",
                    },
                    "summary": {
                        "type": "array",
                        "description": "0-12 summary rows shown to the user before they confirm.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "value": {"type": "string"},
                            },
                            "required": ["label", "value"],
                            "additionalProperties": False,
                        },
                    },
                    "approve_label": {
                        "type": "string",
                        "description": "Primary button label (default 确认执行, max 20 chars).",
                    },
                    "reject_label": {
                        "type": "string",
                        "description": "Secondary button label (default 取消, max 20 chars).",
                    },
                    "expires_in_seconds": {
                        "type": "integer",
                        "description": "TTL for this confirmation (clamped 30-1800). Default 300.",
                    },
                    "source": {
                        "type": "string",
                        "description": "Optional human-readable source label (e.g. Agent Mail).",
                    },
                },
                "required": ["title"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash_exec",
            "description": (
                "Execute a shell command in the session workspace. Prefer the cwd parameter for the working "
                "directory instead of leading `cd ... &&` (cd && is auto-peeled when cwd is omitted). "
                "After headless `claude -p` / codegen, verify artifacts with list_files or `test -f` — do not "
                "trust exit_code alone."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to execute."},
                    "cwd": {"type": "string", "description": "Working directory (preferred over cd in command)."},
                    "timeout_sec": {"type": "integer", "description": "Timeout seconds, default 30."},
                    "sandbox_permissions": {
                        "type": "string",
                        "enum": ["read-only", "workspace-write", "danger-full-access"],
                        "description": (
                            "OS filesystem permission level. Defaults to workspace-write. "
                            "Use read-only for pure investigation: every write is denied, so the "
                            "command cannot change anything and needs far fewer approvals. "
                            "Use danger-full-access only when the command must write outside the session "
                            "workspace; it always requires explicit user approval."
                        ),
                    },
                },
                "required": ["command"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash_bg_start",
            "description": (
                "Start an interactive or long-running shell command in background without timeout kill. "
                "Use for QR/auth/login commands that wait for user actions. Returns job_id, first-screen output, "
                "and extracted auth URLs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to run in background."},
                    "cwd": {"type": "string", "description": "Working directory (preferred over cd in command)."},
                    "first_wait_sec": {
                        "type": "integer",
                        "description": "Collect initial output for this many seconds before returning (default 4, max 15).",
                    },
                    "sandbox_permissions": {
                        "type": "string",
                        "enum": ["read-only", "workspace-write", "danger-full-access"],
                        "description": (
                            "OS filesystem permission level. Defaults to workspace-write. "
                            "read-only denies every write; danger-full-access always requires "
                            "explicit user approval."
                        ),
                    },
                },
                "required": ["command"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash_bg_poll",
            "description": (
                "Poll incremental output and status for a background bash job started by bash_bg_start."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Background bash job id."},
                },
                "required": ["job_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash_bg_input",
            "description": "Write one line of text to stdin of a running background bash job.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Background bash job id."},
                    "text": {"type": "string", "description": "One line input to send."},
                },
                "required": ["job_id", "text"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash_bg_stop",
            "description": "Stop a background bash job by id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Background bash job id."},
                    "force": {"type": "boolean", "description": "If true, kill instead of terminate."},
                },
                "required": ["job_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_read",
            "description": "Read file content with optional line range.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path."},
                    "start_line": {"type": "integer", "description": "Start line (1-based)."},
                    "end_line": {"type": "integer", "description": "End line (inclusive)."},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "code_outline",
            "description": (
                "Return class/function signatures and one-line docstrings for code files "
                "(no function bodies). Prefer this before file_read to save context. "
                "Supports single file or directory (max 50 files)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace file or directory path.",
                    },
                    "query": {
                        "type": "string",
                        "description": "Optional filter by symbol or path substring.",
                    },
                    "max_files": {
                        "type": "integer",
                        "description": "Max files when path is a directory (default 50).",
                    },
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_write",
            "description": (
                "Write full file content; show unified diff and ask confirmation before writing. "
                "Use from_path to copy from a local file instead of inline content."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path."},
                    "content": {"type": "string", "description": "New full content (omit when using from_path)."},
                    "from_path": {
                        "type": "string",
                        "description": "Copy content from this local file path (workspace-relative or absolute).",
                    },
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_edit",
            "description": "Replace text in file; show unified diff and ask confirmation before writing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path."},
                    "old_text": {"type": "string", "description": "Text to replace."},
                    "new_text": {"type": "string", "description": "Replacement text."},
                    "occurrence": {
                        "type": "integer",
                        "description": "Which occurrence to replace (1-based). Default replaces first.",
                    },
                },
                "required": ["path", "old_text", "new_text"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "document_generate",
            "description": (
                "Render Markdown as a final md, html, or Word-compatible doc artifact through the "
                "authenticated local Electron document renderer. Intermediate files stay in the private "
                "turn output directory; use output_path only when the user explicitly requested a workspace file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "format": {
                        "type": "string",
                        "enum": ["md", "html", "doc"],
                        "description": "Final document format.",
                    },
                    "title": {
                        "type": "string",
                        "description": "Document title used for the generated filename.",
                    },
                    "markdown": {
                        "type": "string",
                        "description": "Markdown source to render.",
                    },
                    "output_path": {
                        "type": "string",
                        "description": (
                            "Optional explicit workspace destination. Omit it to deliver into the private "
                            "turn output directory without dirtying the workspace."
                        ),
                    },
                    "replaces_path": {
                        "type": "string",
                        "description": (
                            "Optional exact path of a previously published document in this session. "
                            "Use it when this revision should replace that document; do not infer a source "
                            "from a similar filename."
                        ),
                    },
                },
                "required": ["format", "title", "markdown"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "document_publish",
            "description": (
                "Publish an already-created md, markdown, html, htm, doc, or docx file as the current turn's "
                "document deliverable. The file must already exist in this session's authorized workspace or "
                "private turn output directory. Use replaces_path with the exact path of a previously published "
                "document when this file is a deliberate revision; ambiguous lineage is kept as an additional "
                "artifact without deleting an old file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Existing final document path (absolute or authorized workspace-relative).",
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional card title; defaults to the file name.",
                    },
                    "replaces_path": {
                        "type": "string",
                        "description": (
                            "Optional exact path of a prior published document from this same session and lineage."
                        ),
                    },
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "codegen",
            "description": "Generate code artifact using existing CodeGenEngine.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Generation target: agent/workflow/tool/skill.",
                    },
                    "description": {"type": "string", "description": "Generation requirement text."},
                    "output_path": {
                        "type": "string",
                        "description": "Optional explicit output file path. If omitted, the tool will propose a default path and ask user confirmation before writing.",
                    },
                },
                "required": ["description"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mcp_connect",
            "description": (
                "Connect one configured MCP server. API keys belong in AgenticX Ontology Settings → MCP "
                "($AGX_HOME/mcp.json env) or OS environment—never ask the user to paste secrets in chat."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "MCP server name from config."},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cc_bridge_start",
            "description": (
                "Start a local Claude Code headless session via the CC bridge HTTP server (run "
                "`agx cc-bridge serve` in another terminal). Token is read from AGX_CC_BRIDGE_TOKEN or "
                "$AGX_HOME/config.yaml cc_bridge.token (auto-generated on first use). Then cc_bridge_send "
                "with the returned session_id; verify output files on disk afterward."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "cwd": {
                        "type": "string",
                        "description": "Working directory for claude child; defaults to session workspace_dir.",
                    },
                    "auto_allow_permissions": {
                        "type": "boolean",
                        "description": "If true, bridge auto-approves can_use_tool control_request lines.",
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["headless", "visible_tui"],
                        "description": (
                            "Optional explicit mode override. If omitted, runtime auto-selects by intent: "
                            "autonomous/report tasks prefer headless; interactive terminal tasks prefer visible_tui."
                        ),
                    },
                },
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cc_bridge_send",
            "description": (
                "Send a user turn to an existing CC bridge session. In headless mode it waits for result/timeout; "
                "in visible_tui mode it only writes input to PTY and returns immediately (no final result inference). "
                "Requires bridge at cc_bridge.url (default 127.0.0.1:9742) and matching bearer token. "
                "Afterward confirm any expected files with file_read or bash_exec test -f."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Bridge session UUID."},
                    "prompt": {"type": "string", "description": "User message text."},
                    "wait_seconds": {
                        "type": "number",
                        "description": "Max wait for stream-json result success line (default 120).",
                    },
                },
                "required": ["session_id", "prompt"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cc_bridge_list",
            "description": "List active CC bridge sessions (pid, cwd) from the local bridge HTTP server.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cc_bridge_stop",
            "description": "Terminate a CC bridge session by session_id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Bridge session UUID."},
                    "force": {
                        "type": "boolean",
                        "description": "Force stop even when visible_tui is still active.",
                    },
                },
                "required": ["session_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cc_bridge_permission",
            "description": (
                "Reply to a pending can_use_tool control_request when auto_allow is off. "
                "Use request_id from bridge logs or captured NDJSON."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string"},
                    "request_id": {"type": "string"},
                    "allow": {"type": "boolean"},
                    "deny_message": {"type": "string", "description": "Used when allow is false."},
                    "tool_use_id": {"type": "string", "description": "Optional; echo from control_request."},
                    "tool_input": {
                        "type": "object",
                        "description": "When allow is true, pass the tool input object from control_request.",
                        "additionalProperties": True,
                    },
                },
                "required": ["session_id", "request_id", "allow"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mcp_call",
            "description": (
                "Call one connected MCP tool by exact name with JSON arguments. "
                "Before using this, call list_mcps and pick tool_name from returned mcp_tool_names; "
                "do not invent names like web.fetch.* or list_tools."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "tool_name": {"type": "string", "description": "Connected MCP tool name."},
                    "arguments": {
                        "type": "object",
                        "description": "Tool arguments object.",
                        "additionalProperties": True,
                    },
                    "args": {
                        "type": "object",
                        "description": "Alias of arguments; accepted for compatibility.",
                        "additionalProperties": True,
                    },
                },
                "required": ["tool_name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "tool_search",
            "description": (
                "Search deferred tools (builtin and connected MCP) by keyword. "
                "Matched tool schemas become available on the NEXT model round. "
                "Use select:<exact_name> for exact match; +token requires token."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "max_results": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 20,
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mcp_import",
            "description": (
                "Import MCP server configs from external mcp.json into AgenticX workspace config. "
                "Do not collect API keys in chat; user fills env in Settings → MCP."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_path": {"type": "string", "description": "Source path to mcp.json."},
                },
                "required": ["source_path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "install_portable_package",
            "description": (
                "Inspect and import a shared AgenticX digital expert or project-group "
                "configuration file. Use this only for files named "
                "*.agx-expert.json or *.agx-group.json that the user explicitly asks "
                "to import. The importer accepts declarative expert/group settings "
                "plus explicitly published Markdown baseline resources, canonical "
                "Skill/MCP dependency references, and logical workspace slots. It "
                "rejects chat history, local user memory, model settings, Skill/MCP "
                "credentials or executable content, absolute paths, and unknown fields. "
                "A runtime confirmation is requested before local experts or groups "
                "are created."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "Absolute path or current-session workspace path to the "
                            "shared .agx-expert.json/.agx-group.json file."
                        ),
                    },
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "skill_use",
            "description": (
                "Activate a skill into current context_files (key: skill:<name>). "
                "After calling this tool, use the injected content directly; do not guess paths or run bash to cat SKILL.md."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Skill name."},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "skill_list",
            "description": (
                "List available skills with source/location/path metadata. "
                "Use these returned paths when you must inspect files; avoid hardcoded $AGX_HOME/skills guesses."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "skill_market_install",
            "description": (
                "Install an existing published skill from SkillHub/ClawHub by package name. "
                "Use this immediately whenever the user asks to install a marketplace skill; "
                "do not read installation guides, run curl/npm/bash, or recreate the SKILL.md with skill_manage. "
                "This tool resolves the registry source, downloads, security-scans, installs, and refreshes the "
                "skills list. It only asks the user for a plain-language confirmation when policy or a high-risk "
                "scan requires one. Scoped references such as @clawhub_publisher/skill-name are accepted."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Published skill slug or SkillHub package reference.",
                    },
                    "source": {
                        "type": "string",
                        "description": (
                            "Optional configured registry source name. Omit it for automatic SkillHub/ClawHub resolution."
                        ),
                    },
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "skill_manage",
            "description": (
                "Create, patch, or delete skills stored under $AGX_HOME/skills/. "
                "For 'create': provide action + name + content, or use from_path/from_url "
                "instead of inline content for large SKILL.md files. "
                "For 'patch': provide action + name + old_string + new_string. "
                "For 'delete': provide action + name. "
                "Sub-paths are supported (e.g. name='ima/notes'). "
                "IMPORTANT: never call with empty arguments — action and name are always required."
                + SKILL_MANAGE_USAGE
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "patch", "delete", "history", "rollback"],
                        "description": "Operation: create/patch/delete/history/rollback.",
                    },
                    "name": {
                        "type": "string",
                        "description": (
                            "Skill directory name under $AGX_HOME/skills/. "
                            "Simple names like 'ima' or sub-paths like 'ima/notes' are both valid. "
                            "Each segment must be alphanumeric with optional hyphens/underscores (no spaces, no leading dots)."
                        ),
                    },
                    "content": {
                        "type": "string",
                        "description": (
                            "For 'create': full SKILL.md text with YAML frontmatter. "
                            "Prefer from_path/from_url for large files instead of inline content."
                        ),
                    },
                    "from_path": {
                        "type": "string",
                        "description": (
                            "For 'create': read SKILL.md from this local path (workspace or $AGX_HOME/). "
                            "Mutually exclusive with content/from_url."
                        ),
                    },
                    "from_url": {
                        "type": "string",
                        "description": (
                            "For 'create': download SKILL.md from an allowlisted https URL "
                            "(raw.githubusercontent.com, gist, registry.clawhub.ai). "
                            "Mutually exclusive with content/from_path."
                        ),
                    },
                    "old_string": {"type": "string", "description": "Required for 'patch': exact substring to find and replace in the existing SKILL.md."},
                    "new_string": {"type": "string", "description": "Required for 'patch': replacement text for old_string."},
                    "mode": {
                        "type": "string",
                        "enum": ["preview", "apply"],
                        "description": "Patch mode. preview only computes diff/token and does not write; apply writes changes.",
                    },
                    "patch_token": {
                        "type": "string",
                        "description": "Token returned by preview; when provided to apply, must match current content hash and patch payload.",
                    },
                    "before_context": {
                        "type": "string",
                        "description": "Optional context before old_string for disambiguation.",
                    },
                    "after_context": {
                        "type": "string",
                        "description": "Optional context after old_string for disambiguation.",
                    },
                    "target_index": {
                        "type": "integer",
                        "description": "Optional index in multi-match candidates; required when preview returns multiple matches and replace_all is false.",
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "If true, patch all matches. Default false.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "For history action: number of versions to return (1-200).",
                    },
                    "to_version": {
                        "type": "string",
                        "description": "For rollback action: target version id from history.",
                    },
                },
                "required": ["action", "name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "hook_manage",
            "description": (
                "Create, delete, list, or toggle declarative hooks persisted to "
                "$AGX_HOME/config.yaml (hooks.declarative[]). "
                "Declarative hooks run shell commands, HTTP webhooks, model prompts, or "
                "agent reasoning at key lifecycle events (before_tool_call, after_tool_call, "
                "session_start, session_end). "
                "command-type hooks are scanned for dangerous patterns before being saved. "
                "IMPORTANT: action and name are always required except for action='list'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "delete", "list", "toggle"],
                        "description": (
                            "'create': add a new declarative hook; "
                            "'delete': remove by name; "
                            "'list': return all declarative hooks; "
                            "'toggle': enable or disable a hook by name."
                        ),
                    },
                    "name": {
                        "type": "string",
                        "description": "Unique hook name (required for create/delete/toggle).",
                    },
                    "event": {
                        "type": "string",
                        "enum": ["before_tool_call", "after_tool_call", "session_start", "session_end"],
                        "description": "Lifecycle event that fires this hook (required for create).",
                    },
                    "type": {
                        "type": "string",
                        "enum": ["command", "http", "prompt", "agent"],
                        "description": "Hook execution type (required for create). Default: 'command'.",
                    },
                    "command": {
                        "type": "string",
                        "description": "Shell command to run (for type='command'). Supports {tool} placeholder.",
                    },
                    "url": {
                        "type": "string",
                        "description": "HTTP endpoint to POST to (for type='http').",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Model prompt text (for type='prompt' or 'agent').",
                    },
                    "matcher": {
                        "type": "string",
                        "description": "Glob pattern to filter which tool names trigger this hook (optional).",
                    },
                    "block_on_failure": {
                        "type": "boolean",
                        "description": "If true, abort the tool call when the hook fails. Default: false.",
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "Hook execution timeout in seconds (1-600). Default: 30.",
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "For 'toggle': set to true to enable or false to disable the hook.",
                    },
                },
                "required": ["action"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "skill_import_repo",
            "description": (
                "Bulk install skills from a GitHub repository into $AGX_HOME/skills/. "
                "Use dry_run=true first to list pending skills without writing. "
                "Preferred for installing many skills (e.g. mattpocock/skills)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {
                        "type": "string",
                        "description": "GitHub repo as owner/name (e.g. mattpocock/skills).",
                    },
                    "branch": {"type": "string", "description": "Branch name (default main)."},
                    "path_glob": {
                        "type": "string",
                        "description": "Glob for SKILL.md paths in the repo tree (default skills/**/SKILL.md).",
                    },
                    "exclude": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Glob patterns to exclude (default deprecated/in-progress).",
                    },
                    "dry_run": {
                        "type": "boolean",
                        "description": "If true, only return pending/skipped lists without installing.",
                    },
                    "overwrite": {
                        "type": "boolean",
                        "description": "If true, replace existing skills with the same name.",
                    },
                },
                "required": ["repo"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "todo_write",
            "description": "Update structured task list for current agent session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {"type": "string"},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                                "active_form": {"type": "string"},
                                "activeForm": {"type": "string"},
                            },
                            "required": ["content", "status"],
                            "additionalProperties": True,
                        },
                    }
                },
                "required": ["items"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scratchpad_write",
            "description": "Write intermediate result to session scratchpad.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "value": {"type": "string"},
                },
                "required": ["key", "value"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scratchpad_read",
            "description": "Read one scratchpad key or list all keys.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "list_only": {"type": "boolean"},
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_append",
            "description": (
                "Append note to the current subject's workspace memory (meta/avatar/group) "
                "or global user baseline. Default scope=subject writes to this pane's MEMORY.md; "
                "use scope=user_global only when the user wants all subjects to remember "
                "(e.g. a lesson from avatar A that avatar B should also avoid). "
                "Content must be a concise, self-contained fact (max ~400 chars)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "enum": ["daily", "long_term"]},
                    "content": {"type": "string"},
                    "scope": {
                        "type": "string",
                        "enum": ["subject", "user_global"],
                        "description": "subject (default) = current meta/avatar/group; user_global = $AGX_HOME/workspace/USER.md baseline for all subjects.",
                    },
                },
                "required": ["target", "content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_search",
            "description": (
                "Search workspace Markdown memory (MEMORY.md, memory/*.md). "
                "When memory graph is enabled, merges graph facts for the current pane partition. "
                "Chinese keywords use substring matching; English supports FTS."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "mode": {"type": "string", "enum": ["fts", "semantic", "hybrid"]},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_forget",
            "description": (
                "Forget memories matching a topic in the current subject (meta/avatar/group). "
                "Removes matching graph episodes and MEMORY.md bullets (default scope=both). "
                "Pinned episodes are protected. Irreversible."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "scope": {"type": "string", "enum": ["graph", "text", "both"]},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "session_search",
            "description": (
                "Search past conversation sessions by keyword. "
                "Returns matching message excerpts grouped by session."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search keywords (FTS5 syntax supported). Empty returns recent sessions.",
                    },
                    "role_filter": {
                        "type": "string",
                        "description": "Comma-separated roles to filter: user,assistant,tool,system",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max sessions to return (1-5, default 3).",
                    },
                },
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files/directories under a path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path, default current directory."},
                    "recursive": {"type": "boolean", "description": "Whether to recurse into subdirectories."},
                    "limit": {"type": "integer", "description": "Maximum entries to return, default 200."},
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "liteparse",
            "description": (
                "Parse a document file (PDF, DOCX, PPTX, XLSX, images) via LiteParse "
                "and return extracted text."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or workspace-relative path to the document.",
                    },
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "video_understand",
            "description": (
                "Understand a local video file (mp4/mov/mkv/webm/avi). Probes metadata "
                "(duration, resolution, audio track) and extracts representative frames "
                "adaptively based on duration, then attaches them for the vision model to "
                "view in the next turn. Prefer this over calling ffmpeg via bash_exec: it is "
                "one atomic call with adaptive sampling. Requires a vision-capable model. "
                "Optionally pass `question` to bias sampling toward what the user asks."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or workspace-relative path to the video file.",
                    },
                    "question": {
                        "type": "string",
                        "description": "Optional: what the user wants to know about the video.",
                    },
                    "max_frames": {
                        "type": "integer",
                        "description": "Optional cap on extracted frames (clamped to server hard max).",
                    },
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_data_sources",
            "description": (
                "List enabled external data source plugins (finance/macro/academic/"
                "enterprise/legal domains) and their available APIs. Call this first "
                "when unsure which data_source_name or api_name to use with "
                "query_data_source."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "domain": {
                        "type": "string",
                        "description": "Optional filter, e.g. 'finance', 'macro', 'academic'.",
                    },
                    "verbose": {
                        "type": "boolean",
                        "description": "If true, include full params_schema for each API.",
                    },
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_data_source",
            "description": (
                "Unified gateway to query an external data source plugin (stock prices, "
                "macro indicators, academic papers, company registry, legal statutes, etc). "
                "Call list_data_sources first if you don't know the exact api_name or "
                "params shape. Returns structured JSON; follow up with show_widget to "
                "visualize when appropriate (e.g. price history as a chart)."
                + QUERY_DATA_SOURCE_USAGE
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "data_source_name": {
                        "type": "string",
                        "description": "Plugin id, e.g. 'akshare', 'world_bank', 'tushare'.",
                    },
                    "api_name": {
                        "type": "string",
                        "description": "API id exposed by the plugin, from list_data_sources.",
                    },
                    "params": {
                        "type": "object",
                        "description": "API-specific parameters.",
                    },
                },
                "required": ["data_source_name", "api_name", "params"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "show_widget",
            "description": (
                "Render an inline visualization in the chat. REQUIRED whenever you "
                "would show a flow, pipeline, sequence, architecture, MitM/proxy path, or any "
                "A->B->C style diagram — including simple 3-node chains. NEVER substitute "
                "markdown text/code blocks (```text```, arrow chains, ↓ lines). "
                "For flowcharts, architecture, pipelines, and sequence diagrams: set "
                "widget_format='mermaid' and pass Mermaid source (no Markdown fence). "
                "Before calling: output 1-3 sentences of visible intro prose in the same turn "
                "(not in reasoning/thinking). Then call show_widget, then explain in detail. "
                "For structured stock/macro charts, widget_code MUST be JSON starting with "
                '\'{"type": "stock_chart", ...}\' — the "type" field is REQUIRED, omitting it '
                "will render as unreadable raw text instead of a chart."
                + SHOW_WIDGET_USAGE
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Widget title shown on the card.",
                    },
                    "widget_code": {
                        "type": "string",
                        "description": (
                            "Mermaid source (flowchart/sequenceDiagram/...), "
                            "SVG string starting with '<svg', OR an HTML fragment. "
                            "Mermaid: no Markdown fence. SVG: viewBox='0 0 680 H' width='100%' "
                            "and CSS vars like var(--text-primary), var(--text-muted)."
                        ),
                    },
                    "widget_format": {
                        "type": "string",
                        "enum": ["svg", "html", "mermaid"],
                        "description": (
                            "Explicit widget source format. Use mermaid for flowcharts, "
                            "architecture, pipelines, and sequence diagrams; svg for custom "
                            "free-form vector graphics; html for interactive widgets."
                        ),
                    },
                    "loading_messages": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional rotating loading messages shown before render.",
                    },
                },
                "required": ["title", "widget_code"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lsp_goto_definition",
            "description": "Jump to symbol definition at given file position.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Absolute or workspace-relative file path."},
                    "line": {"type": "integer", "description": "Line number (1-based)."},
                    "column": {"type": "integer", "description": "Column number (1-based)."},
                },
                "required": ["file", "line", "column"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lsp_find_references",
            "description": "Find all references to a symbol at given file position.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Absolute or workspace-relative file path."},
                    "line": {"type": "integer", "description": "Line number (1-based)."},
                    "column": {"type": "integer", "description": "Column number (1-based)."},
                },
                "required": ["file", "line", "column"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lsp_hover",
            "description": "Get type info and documentation for a symbol at given file position.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Absolute or workspace-relative file path."},
                    "line": {"type": "integer", "description": "Line number (1-based)."},
                    "column": {"type": "integer", "description": "Column number (1-based)."},
                },
                "required": ["file", "line", "column"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lsp_diagnostics",
            "description": "Get lint/type diagnostics for a file or all opened files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file": {"type": "string", "description": "Optional file path."},
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "schedule_task",
            "description": (
                "Create a persistent scheduled/automated task. "
                "The task is saved to disk and executed automatically by the Desktop scheduler at the specified time. "
                "The user can also view, edit and manage the task in the sidebar '定时' section. "
                "Before calling this tool: if the task runs Python scripts, prepare the runtime under the task root only — "
                "the root is the user-provided workspace if set, else $AGX_HOME/crontask/<task_id>/. "
                "Create <task_root>/.venv, pip install there, smoke-run with <task_root>/.venv/bin/python, and reference that path in instruction."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Human-readable task name (e.g. 'A股大盘收盘价日报')"},
                    "instruction": {
                        "type": "string",
                        "description": (
                            "Prompt for the automation runner on each trigger. Must use the same Python/paths as verified during setup. "
                            "Meta-Agent should have already installed deps (pip) in the task workspace or a dedicated venv and confirmed the script runs."
                        ),
                    },
                    "frequency_type": {
                        "type": "string",
                        "enum": ["daily", "interval", "once"],
                        "description": "Schedule type. 'daily' = run at a fixed time on selected days; 'interval' = every N hours; 'once' = one-time on a specific date. Default: 'daily'",
                    },
                    "time": {
                        "type": "string",
                        "description": "Trigger time in HH:MM 24h format (e.g. '22:15'). Required for 'daily' and 'once'. Default: '09:00'",
                    },
                    "days": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Days of week to run (1=Mon … 7=Sun). Default: [1,2,3,4,5,6,7] (every day). For 'once' this is ignored.",
                    },
                    "interval_hours": {
                        "type": "integer",
                        "description": "For frequency_type='interval': run every N hours. Default: 4",
                    },
                    "date": {
                        "type": "string",
                        "description": "For frequency_type='once': the date in YYYY-MM-DD format",
                    },
                    "workspace": {
                        "type": "string",
                        "description": (
                            "Task root directory: all scripts, venv (.venv inside this path), logs, and temp files for this job belong here. "
                            "If omitted, defaults to $AGX_HOME/crontask/<task_id>/ (one directory per task, created automatically)."
                        ),
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "Whether the task is enabled immediately. Default: true",
                    },
                    "provider": {
                        "type": "string",
                        "description": "Studio LLM provider id (must be set together with model). Optional.",
                    },
                    "model": {
                        "type": "string",
                        "description": "Model name for this task (must be set together with provider). Optional.",
                    },
                },
                "required": ["name", "instruction"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_scheduled_tasks",
            "description": "List all persistent scheduled/automated tasks from disk, including their status, frequency and last run info.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_scheduled_task",
            "description": "Disable or remove a scheduled task by task_id. The task will no longer execute automatically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "ID of the task to disable/cancel"},
                },
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_scheduled_task",
            "description": (
                "Partially update an existing scheduled/automated task by task_id. "
                "Only fields explicitly provided will be changed; omitted fields keep their current value. "
                "Use this to tweak an existing task's name, prompt, frequency, workspace, enabled flag or effective date range "
                "via natural-language dialog — no need to delete and recreate."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "ID of the task to update (obtain via list_scheduled_tasks)."},
                    "name": {"type": "string", "description": "New human-readable task name."},
                    "instruction": {
                        "type": "string",
                        "description": (
                            "New prompt for the automation runner. When provided, the tool re-runs MCP preflight and re-injects "
                            "the Execution Contract, replacing any previously auto-injected contract block."
                        ),
                    },
                    "frequency_type": {
                        "type": "string",
                        "enum": ["daily", "interval", "once"],
                        "description": "If provided, rebuilds the frequency. Omitted frequency fields fall back to the task's current values.",
                    },
                    "time": {"type": "string", "description": "HH:MM 24h time for daily/once."},
                    "days": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Days of week (1=Mon … 7=Sun) for daily/interval.",
                    },
                    "interval_hours": {"type": "integer", "description": "Run every N hours when frequency_type='interval'."},
                    "date": {"type": "string", "description": "YYYY-MM-DD date when frequency_type='once'."},
                    "workspace": {
                        "type": "string",
                        "description": "New task root directory. Pass empty string to reset to default ($AGX_HOME/crontask/<task_id>/).",
                    },
                    "enabled": {"type": "boolean", "description": "Enable/disable the task."},
                    "effective_date_range_start": {"type": "string", "description": "Optional effective start date (YYYY-MM-DD). Empty string clears it."},
                    "effective_date_range_end": {"type": "string", "description": "Optional effective end date (YYYY-MM-DD). Empty string clears it."},
                    "provider": {
                        "type": "string",
                        "description": "LLM provider for scheduled runs (set together with model; empty clears both).",
                    },
                    "model": {
                        "type": "string",
                        "description": "LLM model id for scheduled runs (set together with provider; empty clears both).",
                    },
                },
                "required": ["task_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_automation_task_logs",
            "description": (
                "Read the tail of a scheduled/automated task's execution log file "
                "($AGX_HOME/logs/automation/<task_id>.log). "
                "Each run writes [run.begin], [run.session_created|session_reused], [chat.request], "
                "[chat.sse ...], [chat.done|stream_ended|http_error|sse.error|exception], and [run.end] lines. "
                "Use this to diagnose why a task failed (e.g. terminated/timeout, http error, tool error) before proposing a fix."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "Task id (obtain via list_scheduled_tasks)."},
                    "tail": {
                        "type": "integer",
                        "description": "Last N lines to return (default 200, max 2000).",
                    },
                },
                "required": ["task_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        # Plan-Id: machi-kb-stage1-local-mvp (plan §2.3).
        "type": "function",
        "function": {
            "name": "knowledge_search",
            "description": (
                "Search mounted document brains (知识库 / docs brain) for the current session. "
                "Returns {hits, by_brain, used_top_k, brains} — hits are merged top-k; "
                "by_brain groups results per brain. Respects avatar brain mount settings. "
                "Optional brain_id searches a single brain. If nothing is mounted, returns a hint."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural-language search query."},
                    "top_k": {
                        "type": "integer",
                        "description": "Maximum number of chunks to return (1-20). Omit to use KB setting default Top-K.",
                    },
                    "brain_id": {
                        "type": "string",
                        "description": "Optional: search only this docs brain id (must be visible to the session avatar).",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "knowledge_synthesize",
            "description": (
                "Synthesize an answer from mounted document brains with [N] citations and gap analysis. "
                "Use when the user wants a composed answer from the knowledge base rather than raw chunks. "
                "Requires synthesis to be enabled in brain settings. For raw retrieval only, use knowledge_search."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Question to answer from the knowledge base."},
                    "top_k": {
                        "type": "integer",
                        "description": "Maximum source chunks to retrieve before synthesis (1-20).",
                    },
                    "brain_id": {
                        "type": "string",
                        "description": "Optional: synthesize from a single docs brain id.",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the public web for up-to-date information (news, live data, documentation "
                "beyond knowledge cutoff). Prefer this for time-sensitive or externally verifiable "
                "facts before answering. "
                "Do NOT use this tool to determine the current date, weekday or clock time; "
                "use get_current_datetime instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keywords or question."},
                    "max_results": {
                        "type": "integer",
                        "description": (
                            "Number of results (>=1). Omit to use workspace default; "
                            "values are capped by the configured maximum."
                        ),
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_current_datetime",
            "description": (
                "Return the authoritative current date and time from the local system clock "
                "(local ISO datetime, date, weekday, timezone and UTC offset). Use this instead "
                "of web_search whenever the current date, weekday or clock time matters."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": (
                "Fetch a single web URL and return its readable text content plus a list of "
                "in-page image URLs. Use this when the user provides a URL whose content you "
                "need to understand. Returns markdown-ish text (HTML stripped) and a structured "
                "tail block '[discovered_images]' listing absolute image URLs in source order. "
                "Combine with view_image when visual content matters. Max page size 2 MB."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Absolute http(s) URL to fetch.",
                    },
                    "max_images": {
                        "type": "integer",
                        "description": "Cap on how many image URLs to return (default 20, hard max 50).",
                    },
                },
                "required": ["url"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "document_read_pages",
            "description": (
                "Render more pages of a PDF that was attached to this conversation, so you can "
                "read them visually in the next turn. Use this when an attachment note says only "
                "part of the document was rendered — do NOT guess what the unread pages contain. "
                "Pages are 1-based and inclusive of start_page. Returns an error if the file is "
                "not a PDF attached to this session."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path of the PDF, exactly as given in the attachment note.",
                    },
                    "start_page": {
                        "type": "integer",
                        "description": "First page to render (1-based). Clamped to the document length.",
                    },
                    "max_pages": {
                        "type": "integer",
                        "description": "How many pages to render this time. Defaults to the deployment cap.",
                    },
                },
                "required": ["path", "start_page"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "view_image",
            "description": (
                "Load an image so the model can visually inspect it in the next turn. Accepts a "
                "local absolute/relative file path, a http(s) URL (e.g. one returned by "
                "web_fetch's [discovered_images]), or a data:image/* URL. Use when visual content "
                "is necessary to answer (e.g. user asked 'describe the first image'). Returns an "
                "error if the current model is not vision-capable. Each turn caps total attached "
                "images at 4."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "File path, http(s) URL, or data:image/* URL.",
                    },
                    "note": {
                        "type": "string",
                        "description": "Optional short label used in the placeholder text (e.g. 'cover image').",
                    },
                },
                "required": ["target"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_image",
            "description": (
                "Analyze an image with the configured vision-capable fallback model and return "
                "a textual understanding. Use ONLY when the current session model is text-only "
                "(view_image reports the model does not support vision, or a system notice says "
                "attached images were omitted). Accepts a local file path, http(s) URL, or "
                "data:image/* URL; when target is omitted, the most recently attached image in "
                "this session is used. The returned text description is your only window into "
                "the image — quote specifics from it when continuing the task."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "description": "Optional. File path, http(s) URL, or data:image/* URL. Omit to use the latest session image.",
                    },
                    "question": {
                        "type": "string",
                        "description": "Optional focus for the vision pass, e.g. '识别图中的组织名称与 Logo 文字'.",
                    },
                },
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    # ── task_experience tools (group team session cross-task memory) ──────────
    {
        "type": "function",
        "function": {
            "name": "task_experience_retrieve",
            "description": (
                "Retrieve relevant task experience from previous group team sessions. "
                "Call at the start of every complex task to check for reusable lessons. "
                "Uses hybrid search (BM25 + vector) against $AGX_HOME/groups/<group_id>/experience.json."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Describe the current task or challenge to match past experience.",
                    },
                    "group_id": {
                        "type": "string",
                        "description": "Group ID to scope the experience store. Defaults to current session group.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max number of experience entries to return (1-10, default 5).",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "task_experience_learn",
            "description": (
                "Record a key finding, rule, or lesson from the current task into the group experience store. "
                "Call before the final reply to preserve reusable knowledge for future sessions. "
                "Recording failed tool calls is especially valuable."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The experience or lesson content to record.",
                    },
                    "section": {
                        "type": "string",
                        "description": "Category label (e.g. 'debugging', 'code_pattern', 'api_usage'). Default 'general'.",
                    },
                    "when_to_use": {
                        "type": "string",
                        "description": "Describe when this experience should be applied in the future.",
                    },
                    "title": {
                        "type": "string",
                        "description": "Short title for the experience entry.",
                    },
                    "group_id": {
                        "type": "string",
                        "description": "Group ID to scope the experience store. Defaults to current session group.",
                    },
                },
                "required": ["content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "task_experience_clear",
            "description": (
                "Clear all stored task experience for a group. "
                "Only call when explicitly requested by the user. Always confirm before clearing."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "group_id": {
                        "type": "string",
                        "description": "Group ID whose experience store should be cleared.",
                    },
                    "confirm": {
                        "type": "boolean",
                        "description": "Must be true to actually clear. Prevents accidental deletion.",
                    },
                },
                "required": ["confirm"],
                "additionalProperties": False,
            },
        },
    },
]

def document_renderer_available() -> bool:
    """Whether a local authenticated Electron renderer is configured.

    Remote server workers intentionally do not advertise ``document_generate``:
    the renderer is a Desktop-local capability and there is no cross-machine
    fallback protocol.  The dispatcher still keeps its defensive unavailable
    error for stale callers that invoke the name directly.
    """

    renderer_url = str(os.getenv("AGX_DOCUMENT_RENDERER_URL", "") or "").strip()
    token = str(os.getenv("AGX_DOCUMENT_RENDERER_TOKEN", "") or "").strip()
    if not renderer_url or not token:
        return False
    try:
        parsed = urlparse(renderer_url)
        host = (parsed.hostname or "").strip().lower()
        return parsed.scheme in {"http", "https"} and host in {"127.0.0.1", "localhost", "::1"}
    except ValueError:
        return False


def without_unavailable_document_renderer(
    tools: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Drop the Desktop-only document tool when no local renderer is present."""

    rows = list(tools)
    if document_renderer_available():
        return rows
    return [
        tool
        for tool in rows
        if str((tool.get("function") or {}).get("name", "")).strip() != "document_generate"
    ]


def studio_tools_for_session(session: Optional[StudioSession] = None) -> List[Dict[str, Any]]:
    """Return the Studio tool list for a session."""
    _ = session
    return without_unavailable_document_renderer(STUDIO_TOOLS)


META_TOOL_NAMES = {
    "spawn_subagent",
    "cancel_subagent",
    "retry_subagent",
    "query_subagent_status",
    "send_message_to_agent",
    "check_resources",
    "recommend_subagent_model",
    "list_skills",
    "list_mcps",
    "send_bug_report_email",
    "update_email_config",
    "schedule_task",
    "list_scheduled_tasks",
    "cancel_scheduled_task",
    "update_scheduled_task",
    "get_automation_task_logs",
}


def _cancelled(what: str, confirm_gate: ConfirmGate) -> str:
    """CANCELLED 文案，带上「为什么没通过」。

    以前一律写 user denied。无人值守跑批时根本没人在场，用户回头看日志会去找一个
    不存在的点击；等待超时同理。原因由 _confirm 在拒绝时挂到 gate 上。
    """

    note = getattr(confirm_gate, "last_denial_note", "")
    # 只认真正的字符串。gate 可能是测试替身或第三方实现，getattr 拿回来的东西直接
    # str() 会把 <MagicMock ...> 这种原样拼进给模型看的工具结果里。
    if not isinstance(note, str) or not note.strip():
        note = "用户拒绝"
    return f"CANCELLED: {what}（{note.strip()}）"


def tool_allowed_without_confirm(
    tool_name: str,
    risk_codes: Iterable[str] = (),
) -> bool:
    """Whether ``permissions.allowed_tools`` says this tool never needs asking.

    **语义定在「免确认」**，不是「只允许这些工具」。两种读法的安全含义完全相反，
    所以这里写清楚为什么选前者：

    1. 同一份配置里的 ``allowed_commands`` 已经是「免确认」。同一个 ``allowed_``
       前缀在相邻两行里表示相反的东西，是最容易读错的那种设计。
    2. 对齐 Claude Code：它的 ``permissions.allow`` 也是「自动批准」，
       ``deny`` 才是禁止。
    3. 「只允许这些工具存在」是**工具收窄**，是另一个功能——真要做该用另一个字段名
       （比如 ``exposed_tools``），而不是让一个字段在不同上下文里换意思。

    次序与 ``allowed_commands`` 完全一致：

    - ``denied_tools`` 与 plan 上限**优先**。调用方在此之前已经走过
      :func:`tool_policy_denial`，这里不重复判断，但次序不能颠倒。
    - :data:`NEVER_AUTO_APPROVED_CATEGORIES` 三类高危**永不豁免**。所以
      ``allowed_tools: ["bash_exec"]`` 的效果等价于 ``allowed_commands: ["*"]``——
      一个已经支持、也已经被测试钉住的配置，不是新开的口子。

    **不覆盖澄清提问**（``request_clarification`` 那条路径）。那不是权限确认，
    是模型在问用户一个开放问题；自动答应它等于把答案丢掉。
    """
    codes = {str(code).strip() for code in risk_codes}
    if codes & NEVER_AUTO_APPROVED_CATEGORIES:
        return False
    try:
        raw = ConfigManager.get_value("permissions.allowed_tools")
    except Exception:
        return False
    if not isinstance(raw, list):
        return False
    name = str(tool_name or "").strip()
    if not name:
        return False
    for entry in raw:
        pattern = str(entry or "").strip()
        if not pattern:
            continue
        if fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(name.lower(), pattern.lower()):
            return True
    return False


async def _confirm(
    question: str,
    *,
    confirm_gate: ConfirmGate,
    context: Optional[Dict[str, Any]] = None,
    emit_event: Optional[Any] = None,
) -> bool:
    payload_context = dict(context or {})
    request_id = str(payload_context.get("request_id") or uuid.uuid4())
    payload_context["request_id"] = request_id
    # permissions.allowed_tools：用户写下的「这个工具不用问我」。放在这里是因为
    # _confirm 是所有**权限确认**的唯一入口——放到各个工具里就会漏。澄清提问走的是
    # 另一个函数，不受影响。deny 与 plan 上限在更早的 tool_policy_denial 已经短路过，
    # 次序不会颠倒。
    if tool_allowed_without_confirm(
        payload_context.get("tool", ""),
        (
            item.get("code", "")
            for item in (payload_context.get("risk_categories") or [])
            if isinstance(item, dict)
        ),
    ):
        _log.info(
            "[confirm] auto-approved id=%s tool=%s by permissions.allowed_tools",
            request_id,
            payload_context.get("tool"),
        )
        return True
    # 受保护的请求带上「为什么问你」。界面自己也能按 risk 推，但理由由后端给出才有
    # 唯一出处——risk 取值将来加一个，不用记得同步改两处文案。
    if is_protected_confirm(payload_context):
        payload_context["protected_reason"] = protected_confirm_reason(payload_context)
    _log.info(
        "[confirm] requested id=%s question=%s risk=%s tool=%s",
        request_id,
        question,
        payload_context.get("risk"),
        payload_context.get("tool"),
    )
    # Gate capability, rather than concrete type, decides whether an event is
    # needed. A risk-aware auto gate emits only for protected interactive work;
    # low-risk and unattended requests must not create phantom UI prompts.
    emit_prompt = emit_event is not None and confirm_gate.should_emit_prompt(payload_context)
    if emit_prompt:
        # Register the pending request before publishing its ID. Otherwise a
        # fast UI callback can arrive before AsyncConfirmGate.resolve() has a
        # future to resolve and the turn hangs until timeout.
        confirm_task = asyncio.create_task(
            confirm_gate.request_confirm(question, payload_context)
        )
        await asyncio.sleep(0)
        try:
            await emit_event(
                {
                    "type": "confirm_required",
                    "data": {
                        "id": request_id,
                        "question": question,
                        "context": payload_context,
                    },
                }
            )
            approved = await confirm_task
        except BaseException:
            confirm_task.cancel()
            await asyncio.gather(confirm_task, return_exceptions=True)
            raise
    else:
        approved = await confirm_gate.request_confirm(question, payload_context)
    _log.info("[confirm] resolved id=%s approved=%s", request_id, approved)
    if not approved:
        # 调用方拼 CANCELLED 文案时读这一条：是人按的拒绝，还是无人值守直接拦下的。
        setattr(confirm_gate, "last_denial_note", confirm_denial_note(confirm_gate, request_id))
    if emit_prompt:
        await emit_event(
            {
                "type": "confirm_response",
                "data": {
                    "id": request_id,
                    "approved": approved,
                },
            }
        )
    return approved


class SideEffectConfirmSpec(NamedTuple):
    """确认一个自己不调 :func:`_confirm` 的副作用工具需要的东西。

    Attributes:
        risk: 走 ``is_protected_confirm`` 那套取值。**没有一个是 ``low``**——
            ``low`` 在「代我批准」档下会被直接放行,而这里每一条都是持久的或者
            对外的,批准它需要用户真的看一眼。
        what: 拒绝时拼进 CANCELLED 文案的名词。
        summarize: 从 arguments 里取出用户最需要看到的那一项(收件人、路径、
            任务名)。只有名字没有对象的确认框等于没有确认框——「要创建一个分身吗」
            和「要创建名为 X 的分身吗」是两个问题。
    """

    risk: str
    what: str
    summarize: Any


def _summary_send_bug_report_email(arguments: Dict[str, Any]) -> str:
    to = str(arguments.get("to_email") or "").strip() or "已配置的默认收件人"
    subject = str(arguments.get("subject") or "").strip() or "(无主题)"
    tail = "，并附带最近的对话内容" if arguments.get("include_recent_chat") else ""
    return f"向 {to} 发送邮件「{subject}」{tail}"


def _summary_update_email_config(arguments: Dict[str, Any]) -> str:
    keys = sorted(str(k) for k in arguments if str(k).strip())
    fields = "、".join(keys) if keys else "(空)"
    return f"改写本机的邮件发送配置：{fields}"


def _summary_schedule_task(arguments: Dict[str, Any]) -> str:
    name = str(arguments.get("name") or "").strip() or "(未命名)"
    when = " ".join(
        str(arguments.get(key) or "").strip()
        for key in ("frequency", "date", "time")
        if str(arguments.get(key) or "").strip()
    ) or "(未指定时间)"
    workspace = str(arguments.get("workspace") or "").strip()
    tail = f"，工作目录 {workspace}" if workspace else ""
    return f"创建定时任务「{name}」，{when} 自动执行{tail}"


def _summary_create_avatar(arguments: Dict[str, Any]) -> str:
    name = str(arguments.get("name") or "").strip() or "(未命名)"
    role = str(arguments.get("role") or "").strip()
    return f"创建数字分身「{name}」{f'（{role}）' if role else ''}并写入注册表"


def _summary_create_group_chat(arguments: Dict[str, Any]) -> str:
    name = str(arguments.get("name") or "").strip() or "(未命名)"
    members = arguments.get("members")
    listed = "、".join(str(m) for m in members) if isinstance(members, list) else ""
    return f"创建项目群「{name}」{f'，成员：{listed}' if listed else ''}"


def _summary_set_taskspace(arguments: Dict[str, Any]) -> str:
    path = str(arguments.get("path") or "").strip() or "(未指定)"
    return f"把 {path} 挂进本会话的工作区（该目录随后可写）"


#: 有持久或对外副作用、但代码里自己不调 :func:`_confirm` 的工具。
#:
#: 在此之前,「每次询问 / 代我批准」实际只覆盖 Shell 与文件操作——这几个工具从
#: 头到尾没有确认闸。``create_avatar`` 最能说明问题:它的 schema 里写着「必须先
#: 调 request_action_confirmation 拿到 [ACTION_CONFIRMED] 再调用本工具」,
#: 而运行时对此**没有任何强制**。那是一句写给模型看的话,模型不照做也不会怎么样,
#: 于是权限模型的一部分建立在「模型会遵守描述文字」上。
#:
#: ``mcp_call`` 与动态 MCP 工具**不在这里**,是个明确的取舍:那条路径一轮里可能
#: 有几十次调用(浏览器、检索),逐条问会让「代我批准」失去意义,用户学会的第一件
#: 事就是把弹出来的框当噪音。要管住它,该管的单位是「哪个 server 可信」而不是
#: 「哪一次调用」——那是另一种规则,不在本轮范围内。现状:它仍受 ``denied_tools``
#: 和 plan 上限约束。
SIDE_EFFECT_CONFIRM_SPECS: Dict[str, SideEffectConfirmSpec] = {
    "send_bug_report_email": SideEffectConfirmSpec(
        # 内容一旦发出去就收不回来,而且默认会带上对话原文。
        risk="high",
        what="邮件未发送",
        summarize=_summary_send_bug_report_email,
    ),
    "update_email_config": SideEffectConfirmSpec(
        risk="policy",
        what="邮件配置未修改",
        summarize=_summary_update_email_config,
    ),
    "schedule_task": SideEffectConfirmSpec(
        # 批准一次,之后每次都在没人看着的时候跑。
        risk="high",
        what="定时任务未创建",
        summarize=_summary_schedule_task,
    ),
    "create_avatar": SideEffectConfirmSpec(
        risk="policy",
        what="分身未创建",
        summarize=_summary_create_avatar,
    ),
    "create_group_chat": SideEffectConfirmSpec(
        risk="policy",
        what="项目群未创建",
        summarize=_summary_create_group_chat,
    ),
    "set_taskspace": SideEffectConfirmSpec(
        # 这条是自助放宽沙箱:挂进来的目录默认是 link(可写),等于让模型自己给自己
        # 加一个写入根。它比列表里其余几条都更接近「权限」本身。
        risk="permission_escalation",
        what="工作区未变更",
        summarize=_summary_set_taskspace,
    ),
}


async def confirm_side_effect_tool(
    name: str,
    arguments: Dict[str, Any],
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> Optional[str]:
    """Ask before a side-effecting tool runs; return a CANCELLED string if refused.

    放在 :func:`agenticx.runtime.meta_tools.dispatch_meta_tool_async` 的开头,
    和 :func:`tool_policy_denial` 同一个位置——那是这几个工具**唯一**的公共入口
    (``dispatch_tool_async`` 的 meta 分支和 AgentRuntime 的直连分支都汇到那里)。
    挨个塞进每个工具体内就一定会漏下一个。

    次序与别处一致:``denied_tools`` / plan 上限先短路,然后才轮到确认。
    ``permissions.allowed_tools``(免确认)由 :func:`_confirm` 内部照常生效。

    Returns:
        None 表示放行;非空字符串是给模型看的工具结果,直接返回给它。
    """
    spec = SIDE_EFFECT_CONFIRM_SPECS.get(str(name or "").strip())
    if spec is None:
        return None
    summary = spec.summarize(arguments if isinstance(arguments, dict) else {})
    approved = await _confirm(
        f"{summary}？",
        confirm_gate=confirm_gate,
        context={"tool": name, "risk": spec.risk, "summary": summary},
        emit_event=emit_event,
    )
    if approved:
        return None
    return _cancelled(spec.what, confirm_gate)


def build_clarification_tool_result(answer: Dict[str, Any]) -> str:
    """Render a structured clarification answer as natural-language tool result.

    The agent reads this text as the tool result of ``request_clarification``
    and continues the same turn. Sentinels ``__timeout__`` / ``__suspended__``
    are translated into explicit guidance so the model wraps up gracefully
    instead of asking again.
    """
    if isinstance(answer, dict):
        if answer.get("__timeout__"):
            return (
                "[CLARIFICATION_TIMEOUT] 用户未在时限内回复该提问。"
                "请把待确认项写入待办并优雅结束本轮，不要重复发起同一提问。"
            )
        if answer.get("__suspended__"):
            return (
                "[CLARIFICATION_PENDING] 当前为无人值守/自动化会话，已向用户发起提问但暂无人回复。"
                "请把待确认项写入待办并结束本轮，等待用户下次回来时再继续。"
            )
    answer_text = str((answer or {}).get("answer_text", "") or "").strip()
    selected = list((answer or {}).get("selected_options", []) or [])
    parts: List[str] = []
    if selected:
        parts.append("用户选择：" + "；".join(selected))
    if answer_text:
        parts.append(f"自定义补充：{answer_text}")
    if not parts:
        return "用户未提供具体内容（视为按你的默认方案推进）。"
    return "；".join(parts) + "。"


def _normalize_clarification_decisions(raw: Any) -> List[Dict[str, Any]]:
    """Parse structured decision groups for multi-part sign-off cards.

    Each decision gets ``selection_mode`` (``single`` | ``multiple``, default
    ``single``) and ``exclusive_options`` (only meaningful for ``multiple``;
    filtered to labels that exist in ``options``).
    """
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for idx, item in enumerate(raw[:6]):
        if not isinstance(item, dict):
            continue
        question = str(item.get("question", "") or "").strip()
        raw_opts = item.get("options") or []
        if not question or not isinstance(raw_opts, list):
            continue
        options = [str(opt).strip() for opt in raw_opts if str(opt).strip()][:8]
        if not options:
            continue
        decision_id = str(item.get("id", "") or "").strip() or f"decision-{idx + 1}"
        selection_mode = (
            "multiple" if str(item.get("selection_mode", "") or "").strip() == "multiple" else "single"
        )
        exclusive_options: List[str] = []
        if selection_mode == "multiple":
            raw_exclusive = item.get("exclusive_options") or []
            if isinstance(raw_exclusive, list):
                seen: set[str] = set()
                option_set = set(options)
                for label in raw_exclusive:
                    text = str(label).strip()
                    if not text or text not in option_set or text in seen:
                        continue
                    seen.add(text)
                    exclusive_options.append(text)
        out.append(
            {
                "id": decision_id,
                "question": question,
                "options": options,
                "selection_mode": selection_mode,
                "exclusive_options": exclusive_options,
            }
        )
    return out


_ACTION_CONFIRM_MIN_TTL = 30
_ACTION_CONFIRM_MAX_TTL = 1800
_ACTION_CONFIRM_DEFAULT_TTL = 300


def _clamp_action_confirmation_ttl(raw: Any) -> float:
    """Clamp expires_in_seconds into the supported action-confirmation window."""
    try:
        val = float(raw)
    except (TypeError, ValueError):
        val = float(_ACTION_CONFIRM_DEFAULT_TTL)
    if val <= 0:
        val = float(_ACTION_CONFIRM_DEFAULT_TTL)
    return max(float(_ACTION_CONFIRM_MIN_TTL), min(float(_ACTION_CONFIRM_MAX_TTL), val))


def _normalize_action_confirmation_summary(raw: Any) -> List[Dict[str, str]]:
    """Normalize summary rows for the action-confirmation card."""
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, str]] = []
    for item in raw:
        if len(out) >= 12:
            break
        if not isinstance(item, dict):
            continue
        label = str(item.get("label", "") or "").strip()[:40]
        value = str(item.get("value", "") or "").strip()[:1000]
        if not label or not value:
            continue
        out.append({"label": label, "value": value})
    return out


def build_action_confirmation_tool_result(
    answer: Dict[str, Any],
    *,
    approve_label: str = "确认执行",
    reject_label: str = "取消",
) -> str:
    """Render action-confirmation answers as explicit tool-result guidance."""
    if isinstance(answer, dict):
        if answer.get("__timeout__"):
            return (
                "[ACTION_CONFIRMATION_EXPIRED] 确认已失效。不得继续该动作，"
                "若仍需执行必须重新生成预览。"
            )
        if answer.get("__suspended__"):
            return "[ACTION_CONFIRMATION_SUSPENDED] 无人值守会话不能确认外部写操作。"

    answer_text = str((answer or {}).get("answer_text", "") or "").strip()
    selected = [str(x).strip() for x in list((answer or {}).get("selected_options", []) or []) if str(x).strip()]
    approve = str(approve_label or "确认执行").strip() or "确认执行"
    reject = str(reject_label or "取消").strip() or "取消"

    lowered = answer_text.lower()
    approve_hits = {approve, "确认", "确认发送", "同意", "继续", "yes", "y", "ok"}
    reject_hits = {reject, "取消", "拒绝", "不用了", "no", "n"}

    if any(opt in approve_hits or opt.lower() in approve_hits for opt in selected):
        return "[ACTION_CONFIRMED] 用户已确认执行。"
    if any(opt in reject_hits or opt.lower() in reject_hits for opt in selected):
        return "[ACTION_REJECTED] 用户已取消执行。不得继续该动作。"
    if answer_text in approve_hits or lowered in {x.lower() for x in approve_hits if x.isascii()}:
        return "[ACTION_CONFIRMED] 用户已确认执行。"
    if answer_text in reject_hits or lowered in {x.lower() for x in reject_hits if x.isascii()}:
        return "[ACTION_REJECTED] 用户已取消执行。不得继续该动作。"

    # Ambiguous / empty answers must never silently approve an external write.
    return "[ACTION_REJECTED] 用户未明确确认。不得继续该动作。"


async def _request_action_confirmation(
    title: str,
    *,
    summary: Optional[List[Dict[str, Any]]] = None,
    approve_label: str = "确认执行",
    reject_label: str = "取消",
    expires_in_seconds: Any = None,
    source: str = "",
    clarify_gate: Optional[ClarifyGate] = None,
    emit_event: Optional[Any] = None,
    is_unattended: bool = False,
    caller_context: Optional[Dict[str, Any]] = None,
    action_confirmation_context: Optional[Dict[str, Any]] = None,
) -> str:
    """Block for a binary action confirmation via the clarification transport.

    Emits ``clarification_required`` with ``context.kind = action_confirmation``
    so Desktop can render the dedicated confirm card while still resolving
    through ``POST /api/clarify``.
    """
    title_text = str(title or "").strip()[:200]
    if not title_text:
        return (
            "ERROR: request_action_confirmation requires a non-empty `title`. "
            "请立即重新调用并填写 title。"
        )

    approve = str(approve_label or "确认执行").strip()[:20] or "确认执行"
    reject = str(reject_label or "取消").strip()[:20] or "取消"
    summary_rows = _normalize_action_confirmation_summary(summary)
    ttl = _clamp_action_confirmation_ttl(expires_in_seconds)
    source_text = str(source or "").strip()[:80]
    request_id = str(uuid.uuid4())
    expires_at_ms = int((time.time() + ttl) * 1000)

    # Controlled context only — never trust caller-provided kind/secrets.
    payload_context: Dict[str, Any] = {
        "kind": "action_confirmation",
        "request_id": request_id,
        "title": title_text,
        "summary": summary_rows,
        "approve_label": approve,
        "reject_label": reject,
        "expires_at_ms": expires_at_ms,
    }
    if source_text:
        payload_context["source"] = source_text
    # caller_context is intentionally ignored for security (kind/token scrubbing).
    _ = caller_context
    # Only the trusted enterprise-action dispatcher may provide an operation
    # binding. Keep this separate from caller_context so the generic model
    # facing request_action_confirmation tool cannot smuggle an operation id or
    # auth generation into a UI card.
    if isinstance(action_confirmation_context, dict):
        operation_id = str(action_confirmation_context.get("operation_id", "") or "").strip()
        action_id = str(action_confirmation_context.get("action_id", "") or "").strip()
        session_id = str(action_confirmation_context.get("session_id", "") or "").strip()
        permission_mode = str(action_confirmation_context.get("permission_mode", "") or "").strip().lower()
        auth_generation = action_confirmation_context.get("auth_generation")
        if (
            operation_id
            and action_id
            and session_id
            and permission_mode in {"plan", "ask", "auto"}
            and isinstance(auth_generation, int)
            and not isinstance(auth_generation, bool)
        ):
            payload_context.update(
                {
                    "enterprise_confirmation": True,
                    "operation_id": operation_id[:160],
                    "action_id": action_id[:128],
                    "session_id": session_id[:160],
                    "permission_mode": permission_mode,
                    "auth_generation": auth_generation,
                }
            )

    if is_unattended or isinstance(clarify_gate, AutoSuspendClarifyGate):
        _log.info(
            "[action_confirm] suspended id=%s title=%s (unattended)",
            request_id,
            title_text[:80],
        )
        if emit_event is not None:
            await emit_event(
                {
                    "type": "clarification_suspended",
                    "data": {
                        "id": request_id,
                        "prompt": title_text,
                        "options": [approve, reject],
                        "decisions": [],
                        "allow_free_text": True,
                        "context": payload_context,
                    },
                }
            )
        return build_action_confirmation_tool_result({"__suspended__": True})

    gate = clarify_gate or AsyncClarifyGate()
    emit_prompt = emit_event is not None and isinstance(gate, AsyncClarifyGate)
    if emit_prompt:
        await emit_event(
            {
                "type": "clarification_required",
                "data": {
                    "id": request_id,
                    "prompt": title_text,
                    "options": [approve, reject],
                    "decisions": [],
                    "allow_free_text": True,
                    "context": payload_context,
                },
            }
        )

    _log.info("[action_confirm] requested id=%s title=%s ttl=%.1fs", request_id, title_text[:80], ttl)
    try:
        answer = await asyncio.wait_for(
            gate.request_clarification(
                title_text,
                options=[approve, reject],
                allow_free_text=True,
                context=payload_context,
            ),
            timeout=ttl,
        )
    except asyncio.TimeoutError:
        _log.warning("[action_confirm] timed out id=%s after %.1fs", request_id, ttl)
        # Best-effort: resolve pending future so the gate does not linger.
        if isinstance(gate, AsyncClarifyGate):
            gate.resolve(request_id, {"__timeout__": True})
        answer = {"__timeout__": True}

    _log.info("[action_confirm] resolved id=%s answer=%s", request_id, answer)
    if emit_prompt:
        await emit_event(
            {
                "type": "clarification_response",
                "data": {
                    "id": request_id,
                    "answer": answer,
                },
            }
        )
    return build_action_confirmation_tool_result(
        answer if isinstance(answer, dict) else {},
        approve_label=approve,
        reject_label=reject,
    )


async def _request_clarification(
    prompt: str,
    *,
    options: Optional[List[str]] = None,
    decisions: Optional[List[Dict[str, Any]]] = None,
    allow_free_text: bool = True,
    context: Optional[Dict[str, Any]] = None,
    clarify_gate: Optional[ClarifyGate] = None,
    emit_event: Optional[Any] = None,
    is_unattended: bool = False,
) -> str:
    """Block inside a tool call to ask the user an open-ended question.

    Emits ``clarification_required`` (or ``clarification_suspended`` for
    unattended sessions), waits on the clarify gate, and returns a tool-result
    string built by :func:`build_clarification_tool_result`.
    """
    options = list(options or [])
    decisions = list(decisions or [])
    # A clarification without any selectable choice is necessarily open-ended.
    # Never emit an impossible prompt that offers neither choices nor a text
    # answer surface; desktop also mirrors this invariant for persisted rows.
    if not options and not decisions:
        allow_free_text = True
    payload_context = dict(context or {})
    # Reserved enterprise confirmation bindings may only be injected by the
    # trusted enterprise-action dispatcher. A model-supplied clarification
    # context must never turn the generic question tool into a confirmation
    # transport for an operation id it happens to know.
    for key in (
        "enterprise_confirmation",
        "operation_id",
        "action_id",
        "session_id",
        "permission_mode",
        "auth_generation",
    ):
        payload_context.pop(key, None)
    request_id = str(payload_context.get("request_id") or uuid.uuid4())
    payload_context["request_id"] = request_id

    # Unattended/automation sessions must never block -- there is no UI to
    # answer. AutoSuspendClarifyGate also hits this branch via isinstance.
    if is_unattended or isinstance(clarify_gate, AutoSuspendClarifyGate):
        _log.info(
            "[clarify] suspended id=%s prompt=%s (unattended)",
            request_id,
            prompt[:80],
        )
        if emit_event is not None:
            await emit_event(
                {
                    "type": "clarification_suspended",
                    "data": {
                        "id": request_id,
                        "prompt": prompt,
                        "options": options,
                        "decisions": decisions,
                        "allow_free_text": allow_free_text,
                        "context": payload_context,
                    },
                }
            )
        return build_clarification_tool_result({"__suspended__": True})

    gate = clarify_gate or AsyncClarifyGate()
    emit_prompt = emit_event is not None and isinstance(gate, AsyncClarifyGate)
    if emit_prompt:
        await emit_event(
            {
                "type": "clarification_required",
                "data": {
                    "id": request_id,
                    "prompt": prompt,
                    "options": options,
                    "decisions": decisions,
                    "allow_free_text": allow_free_text,
                    "context": payload_context,
                },
            }
        )
    _log.info("[clarify] requested id=%s prompt=%s", request_id, prompt[:80])
    answer = await gate.request_clarification(
        prompt,
        options=options,
        allow_free_text=allow_free_text,
        context=payload_context,
    )
    _log.info("[clarify] resolved id=%s answer=%s", request_id, answer)
    if emit_prompt:
        await emit_event(
            {
                "type": "clarification_response",
                "data": {
                    "id": request_id,
                    "answer": answer,
                },
            }
        )
    return build_clarification_tool_result(answer)


def _path_from_arg(path_arg: str) -> Path:
    return Path(path_arg).expanduser()


def _is_protected_config_path(path: Path) -> bool:
    """Backward-compatible alias for config.yaml protection."""
    return _is_protected_path(path)


def denied_path_patterns_for_sandbox() -> List[str]:
    """``permissions.path_rules`` 里的拒绝模式，交给 OS 沙箱去挡。

    第一方文件工具（file_write / file_edit / codegen）走
    :func:`_path_denied_by_rules`，那条路径是完整的。Shell 不是：
    ``_ensure_bash_write_targets_allowed`` 只能可靠地认出重定向和 tee 的落点，
    ``rm -f secrets/key`` 根本不经过它。

    所以把拒绝模式下沉到沙箱后端——那是进程真正读写文件时的边界，不依赖我们能不能
    把一条 shell 命令解析对。macOS 与 Linux 上它读写一起挡；Windows 只挡写。

    allow 规则不下沉：它的语义是**免确认**，不是「放开沙箱」，把它塞进沙箱等于让
    一条配置项有拆掉工作区隔离的能力。
    """
    try:
        raw = ConfigManager.get_value("permissions.path_rules")
    except Exception:
        return []
    return [pattern for pattern, allow in normalize_path_rules(raw) if not allow]


def _path_denied_by_rules(path: Path) -> Optional[str]:
    """Return a denial message when ``permissions.path_rules`` rejects this path.

    与 ``permissions.denied_commands`` 同一个立场：**deny 是绝对的**，在确认闸之前
    短路，不提供「批准一次」。allow 规则在这里不产生任何效果——它只负责免除确认
    （见 :func:`_path_allowed_without_confirm`），不能让路径越出工作区。

    **读也拒，写也拒。** Shell 那一侧由 OS 沙箱执行同一批规则，macOS 与 Linux 上
    ``cat``/``rg``/``sed`` 同样读不到被拒绝的路径（见
    :mod:`agenticx.runtime.command_sandbox`）。Windows 的读隔离还没做，
    :func:`~agenticx.runtime.command_sandbox.shell_read_isolation_for_host` 会如实
    报出来，界面据此措辞。
    """
    try:
        raw = ConfigManager.get_value("permissions.path_rules")
    except Exception:
        return None
    decision, pattern = path_rule_decision(path, raw)
    if decision is False:
        return (
            f"path blocked by permissions.path_rules "
            f"(pattern {pattern!r} matched {path})"
        )
    return None


def _path_allowed_without_confirm(path: Path) -> bool:
    """Whether a user rule says this path never needs a per-write confirmation.

    等价于 Claude Code 的 ``Edit(src/**)`` 允许规则：这条路径上的写不再逐次弹框。
    它**不放开沙箱**——工作区边界仍由 ``_resolve_workspace_path`` 与 OS 沙箱负责。
    """
    try:
        raw = ConfigManager.get_value("permissions.path_rules")
    except Exception:
        return False
    decision, _pattern = path_rule_decision(path, raw)
    return decision is True


def _is_protected_path(path: Path) -> bool:
    """Sensitive paths blocked for both read and write (above any root allowlist)."""
    resolved = _safe_resolve_path(path)
    home = Path.home()  # host-user root for OS credential directories
    protected: List[Path] = [
        agx_home() / "config.yaml",
        agx_home() / "serve.token",
        agx_home() / "wechat_credentials.json",
        agx_home() / "feishu_binding.json",
        home / ".ssh",
        home / ".aws",
        home / ".gnupg",
    ]
    for item in protected:
        try:
            base = item.resolve(strict=False)
        except Exception:
            continue
        if resolved == base:
            return True
        try:
            resolved.relative_to(base)
            return True
        except ValueError:
            continue
    if resolved.name == "config.yaml" and (
        ".agenticx" in resolved.parts or ".agenticx-ontology" in resolved.parts
    ):
        return True
    return False


def _is_private_runtime_document_path(path: Path, session: StudioSession) -> bool:
    """Whether a document path points at turn bookkeeping storage.

    The per-turn ``outputs`` directory is intentionally user-visible and is
    the default destination for ``document_generate``.  Only scratch, logs,
    and checkpoint data are private runtime surfaces.
    """

    private_root = _document_private_root(session)
    if private_root is None:
        return False
    return any(
        _is_path_under_root(path, private_root / name)
        for name in ("scratch", "logs", "checkpoint")
    )


_TOOL_METADATA_LINE_RE = re.compile(r"^\s*(call_[A-Za-z0-9]+|sa-[a-z0-9]+)\s*$")


def _strip_tool_metadata_noise_lines(text: str) -> str:
    if not text:
        return text
    had_trailing_newline = text.endswith("\n")
    lines = text.splitlines()
    filtered = [line for line in lines if not _TOOL_METADATA_LINE_RE.fullmatch(line)]
    out = "\n".join(filtered)
    if had_trailing_newline and out:
        out += "\n"
    return out


def _command_touches_protected_config(command: str, parts: List[str]) -> bool:
    home_cfg = str((agx_home() / "config.yaml").resolve(strict=False))
    markers = {
        "$AGX_HOME/config.yaml",
        ".agenticx/config.yaml",
        ".agenticx-ontology/config.yaml",
        home_cfg,
    }
    lowered_command = command.lower()
    if any(marker.lower() in lowered_command for marker in markers):
        return True
    for token in parts:
        expanded = token.strip().strip("\"'").replace("\\ ", " ")
        if not expanded:
            continue
        if expanded in markers:
            return True
        if expanded.endswith("/.agenticx/config.yaml") or expanded.endswith("/.agenticx-ontology/config.yaml"):
            return True
    return False


def _resolve_workspace_path(
    path_arg: str,
    session: Optional[StudioSession] = None,
    *,
    pick_existing: bool = False,
    for_write: bool = False,
) -> Path:
    raw_path = _path_from_arg(path_arg)
    if for_write and _plan_mode_active(session):
        # The plan ceiling must apply even when the desktop is configured for
        # unrestricted path handling; otherwise that early branch would let a
        # file tool write despite the session being read-only.
        raise ValueError(
            "this session is in 'plan' (read-only) mode: writing is disabled. "
            "Switch the session permission mode before modifying files."
        )
    if for_write and _path_has_unsafe_symlink_component(raw_path):
        raise ValueError("path may not traverse a symlink when writing")
    if _desktop_unrestricted_fs_enabled():
        if raw_path.is_absolute():
            resolved = _safe_resolve_path(raw_path)
        else:
            resolved = _safe_resolve_path(_workspace_root() / raw_path)
        if _is_protected_path(resolved):
            raise ValueError(f"path is protected: {resolved}")
        rule_deny = _path_denied_by_rules(resolved)
        if rule_deny:
            raise ValueError(rule_deny)
        return resolved

    read_roots, write_roots = _session_workspace_root_sets(session)
    # A turn's scratch root is an explicit, private writable area.  Keep it
    # after the user workspace so relative file tools retain their historical
    # destination, while shell commands running with the private cwd can still
    # resolve absolute redirect/script paths without widening access to $HOME.
    private_exec = str(getattr(session, "_private_execution_root", "") or "").strip()
    if private_exec:
        try:
            if _path_has_unsafe_symlink_component(Path(private_exec)):
                raise ValueError("private execution path contains a symlink")
            private_path = _safe_resolve_path(Path(private_exec))
            if not any(str(private_path) == str(item) for item in read_roots):
                read_roots.append(private_path)
            if not any(str(private_path) == str(item) for item in write_roots):
                write_roots.append(private_path)
        except (OSError, RuntimeError, ValueError) as exc:
            if for_write:
                raise ValueError(f"private execution path is not safe for writing: {exc}") from exc
            pass
    roots = write_roots if for_write else read_roots
    if not roots:
        raise ValueError("path escapes workspace: no roots configured")

    def _format_escape(resolved: Path) -> str:
        allowed = ", ".join(str(r) for r in roots[:8])
        more = "" if len(roots) <= 8 else f" (+{len(roots) - 8} more)"
        return f"path escapes workspace: {resolved} (allowed roots: {allowed}{more})"

    def _format_readonly_reference(resolved: Path) -> str:
        # Distinct from "escapes workspace" so the model stops retrying the same write
        # (including via bash_exec redirects / tee).
        return (
            f"path is read-only (mounted as reference): {resolved}. "
            "Do not retry file_edit/file_write/bash_exec on this path. "
            "Ask the user to remount the parent folder as link (直连), "
            "or write a copy under the session workspace."
        )

    def _under_any_root(resolved: Path, candidates: list[Path]) -> bool:
        return any(_is_path_under_root(resolved, root) for root in candidates)

    if raw_path.is_absolute():
        if for_write and _path_has_unsafe_symlink_component(raw_path):
            raise ValueError("path may not traverse a symlink when writing")
        resolved = _safe_resolve_path(raw_path)
        if _is_protected_path(resolved):
            raise ValueError(f"path is protected: {resolved}")
        rule_deny = _path_denied_by_rules(resolved)
        if rule_deny:
            raise ValueError(rule_deny)
        for root in roots:
            if _is_path_under_root(resolved, root):
                return resolved
        if (not for_write) and _is_context_file_read_allowed(resolved, session):
            return resolved
        # Readable via reference/copy metadata, but not in write roots.
        if for_write and _under_any_root(resolved, read_roots):
            raise ValueError(_format_readonly_reference(resolved))
        if for_write and _is_context_file_read_allowed(resolved, session):
            raise ValueError(
                f"path is read-only (context_files attachment): {resolved}. "
                "Do not retry file_edit/file_write/bash_exec on this path."
            )
        raise ValueError(_format_escape(resolved))

    if pick_existing:
        for root in roots:
            candidate = _safe_resolve_path(root / raw_path)
            if for_write and _path_has_unsafe_symlink_component(root / raw_path):
                continue
            if not _is_path_under_root(candidate, root):
                continue
            if _is_protected_path(candidate) or _path_denied_by_rules(candidate):
                continue
            if candidate.exists():
                return candidate

    primary = roots[0]
    if for_write and _path_has_unsafe_symlink_component(primary / raw_path):
        raise ValueError("path may not traverse a symlink when writing")
    resolved = _safe_resolve_path(primary / raw_path)
    if _is_protected_path(resolved):
        raise ValueError(f"path is protected: {resolved}")
    rule_deny = _path_denied_by_rules(resolved)
    if rule_deny:
        raise ValueError(rule_deny)
    if not _is_path_under_root(resolved, primary):
        if for_write and _under_any_root(resolved, read_roots):
            raise ValueError(_format_readonly_reference(resolved))
        raise ValueError(_format_escape(resolved))
    return resolved


def _format_diff(path: Path, old_text: str, new_text: str) -> str:
    diff_lines = difflib.unified_diff(
        old_text.splitlines(),
        new_text.splitlines(),
        fromfile=f"{path} (old)",
        tofile=f"{path} (new)",
        lineterm="",
    )
    return "\n".join(diff_lines)


def _extract_guarded_paths(command_name: str, parts: List[str]) -> List[str]:
    """Extract path-like arguments for guarded read commands."""
    args = parts[1:]
    if not args:
        return []

    if command_name in {"cat", "ls", "tree", "wc"}:
        return [arg for arg in args if arg != "--" and not arg.startswith("-")]

    if command_name in {"head", "tail"}:
        paths: List[str] = []
        skip_next = False
        for arg in args:
            if skip_next:
                skip_next = False
                continue
            if arg == "--":
                continue
            if arg in {"-n", "-c"}:
                skip_next = True
                continue
            if arg.startswith("-"):
                continue
            paths.append(arg)
        return paths

    if command_name == "grep":
        pattern_consumed = False
        explicit_pattern_provided = False
        paths = []
        skip_next = False
        for arg in args:
            if skip_next:
                skip_next = False
                continue
            if arg == "--":
                continue
            if arg in {"-e", "-f", "-m", "-A", "-B", "-C"}:
                if arg == "-e":
                    explicit_pattern_provided = True
                skip_next = True
                continue
            if arg.startswith("-e") and len(arg) > 2:
                explicit_pattern_provided = True
                continue
            if arg.startswith("-"):
                continue
            if not pattern_consumed and not explicit_pattern_provided:
                pattern_consumed = True
                continue
            paths.append(arg)
        return paths

    if command_name == "find":
        paths = []
        for arg in args:
            if arg in {"--", ".", ".."}:
                paths.append(arg)
                continue
            if arg.startswith("-") or arg in {"(", ")", "!", ","}:
                break
            paths.append(arg)
        return paths if paths else ["."]

    return []


def _ensure_paths_within_workspace(
    paths: List[str],
    session: Optional[StudioSession] = None,
) -> Optional[str]:
    """Validate all path arguments stay within session workspace roots."""
    for path_arg in paths:
        if path_arg == "-":
            continue
        try:
            _resolve_workspace_path(path_arg, session, pick_existing=True)
        except ValueError as exc:
            return f"ERROR: {exc}"
    return None


# Redirect / tee write targets (aligned with desktop session-artifacts BASH_REDIRECT_RE).
_BASH_WRITE_REDIRECT_RE = re.compile(
    r"(?:>>?|\btee\b(?:\s+-a)?)\s+(['\"]?)([^\s'\"|;&<>]+)\1",
    re.IGNORECASE,
)
_BASH_CD_SEGMENT_RE = re.compile(
    r"(?:^|[;&|]|\|\||&&)\s*cd\s+(['\"]?)([^\s'\"|;&]+)\1",
    re.IGNORECASE,
)
_BASH_ABS_PATH_TOKEN_RE = re.compile(
    r"(?:/(?:Users|home|tmp|var|opt|private|Volumes)[^\s'\"|;&<>]+|~/[^\s'\"|;&<>]+)"
)


def _extract_bash_write_target_paths(command: str) -> List[str]:
    """Best-effort extract of shell redirect / tee write destinations."""
    paths: List[str] = []
    seen: set[str] = set()

    def _add(raw: str) -> None:
        text = (raw or "").strip().strip("'\"")
        if not text or text == "-":
            return
        if text in seen:
            return
        seen.add(text)
        paths.append(text)

    for match in _BASH_WRITE_REDIRECT_RE.finditer(command or ""):
        _add(match.group(2))

    try:
        parts = shlex.split(command or "")
    except ValueError:
        parts = []
    i = 0
    while i < len(parts):
        tok = parts[i]
        if tok in {">", ">>"} and i + 1 < len(parts):
            _add(parts[i + 1])
            i += 2
            continue
        if Path(tok).name == "tee":
            j = i + 1
            while j < len(parts) and parts[j].startswith("-") and parts[j] not in {">", ">>"}:
                j += 1
            while j < len(parts) and parts[j] not in {">", ">>", "|", "||", "&&", ";"}:
                if not parts[j].startswith("-"):
                    _add(parts[j])
                j += 1
            i = j
            continue
        i += 1
    return paths


def _bash_cd_bases_in_command(command: str) -> List[str]:
    return [m.group(2) for m in _BASH_CD_SEGMENT_RE.finditer(command or "")]


def _ensure_bash_write_targets_allowed(
    command: str,
    session: Optional[StudioSession],
    cwd: Optional[Path],
) -> Optional[str]:
    """Block bash_exec writes into reference (read-only) mounts — including ``>>`` / tee.

    ``file_edit`` already enforces write roots; without this, models bypass via shell.
    """
    if _bash_exec_is_read_only({"command": command}):
        return None

    targets = _extract_bash_write_target_paths(command)
    cd_bases = _bash_cd_bases_in_command(command)

    def _candidates_for(raw: str) -> List[str]:
        out: List[str] = []
        expanded = Path(raw).expanduser()
        if expanded.is_absolute():
            out.append(str(expanded))
            return out
        if cwd is not None:
            out.append(str((cwd / raw).expanduser()))
        for base in cd_bases:
            try:
                base_path = Path(base).expanduser()
                if not base_path.is_absolute() and cwd is not None:
                    base_path = cwd / base_path
                out.append(str(base_path / raw))
            except Exception:
                continue
        out.append(raw)
        return out

    def _deny_if_readonly(path_arg: str) -> Optional[str]:
        try:
            _resolve_workspace_path(path_arg, session, for_write=True)
            return None
        except ValueError as exc:
            msg = str(exc)
            if "read-only" in msg or "escapes workspace" in msg or "protected" in msg:
                return f"ERROR: {msg}"
            return f"ERROR: {msg}"

    for raw in targets:
        any_ok = False
        last_err: Optional[str] = None
        # 每个候选都要看完，不能碰到第一个「可写」就收工。这里的候选集是**猜**出来的——
        # 相对重定向落在哪，取决于命令跑到那一段时的 cwd，而这个守卫不解析 shell 的
        # cd 语义。`cd <只读挂载> && echo >> requirements.txt` 就同时有两个候选：
        # cwd 下的（可写）和 cd 目标下的（只读）。先撞上可写那个就 break，等于在两种
        # 解释里挑了放行的那种。既然判不准，就得按只读那种算。
        for cand in _candidates_for(raw):
            err = _deny_if_readonly(cand)
            if err is None:
                any_ok = True
                continue
            if "read-only" in err:
                return err
            last_err = err
        if not any_ok and last_err:
            return last_err

    # No redirect/tee target parsed (e.g. python -c open(...)): still block
    # absolute paths that land on reference mounts. Skip when redirects were
    # already checked so `cat <ref> && echo >> <writable>` stays allowed.
    if not targets:
        for match in _BASH_ABS_PATH_TOKEN_RE.finditer(command or ""):
            err = _deny_if_readonly(match.group(0))
            if err is not None and "read-only" in err:
                return err

    return None


def _first_non_option_token(
    parts: List[str],
    *,
    start: int = 1,
    options_with_value: Optional[set[str]] = None,
) -> Optional[str]:
    """Return first non-option token while skipping known option values."""
    options_with_value = options_with_value or set()
    idx = start
    while idx < len(parts):
        token = parts[idx]
        if token == "--":
            idx += 1
            break
        if token in options_with_value:
            idx += 2
            continue
        if token.startswith("-"):
            idx += 1
            continue
        return token
    if idx < len(parts):
        return parts[idx]
    return None


def _first_non_option_index(
    parts: List[str],
    *,
    start: int = 1,
    options_with_value: Optional[set[str]] = None,
) -> Optional[int]:
    """Return the index of the first semantic token after command options."""

    options_with_value = options_with_value or set()
    idx = start
    while idx < len(parts):
        token = parts[idx]
        if token == "--":
            return idx + 1 if idx + 1 < len(parts) else None
        if token in options_with_value:
            idx += 2
            continue
        if token.startswith("-"):
            idx += 1
            continue
        return idx
    return None


def _command_approval_prefix(command_name: str, parts: List[str]) -> str:
    """Build a stable, reviewable command prefix for approval rules.

    Dispatcher subcommands and package scripts stay distinct (for example,
    ``git status`` versus ``git push``). This is policy metadata only; the OS
    sandbox remains the enforcement boundary.
    """

    executable = str(command_name or "unknown").strip() or "unknown"
    lowered = executable.lower()
    if lowered.endswith(".exe"):
        lowered = lowered[:-4]
        executable = executable[:-4]

    prefix: List[str] = [executable]
    if len(parts) <= 1:
        return shlex.join(prefix)

    if lowered == "git":
        idx = _first_non_option_index(
            parts,
            options_with_value={"-c", "-C", "--git-dir", "--work-tree"},
        )
        if idx is not None:
            prefix.append(parts[idx])
        return shlex.join(prefix)

    if lowered in {"npm", "pnpm", "yarn"}:
        idx = _first_non_option_index(parts)
        if idx is not None:
            prefix.append(parts[idx])
            if parts[idx] in {"run", "run-script", "exec", "dlx"} and idx + 1 < len(parts):
                prefix.append(parts[idx + 1])
        return shlex.join(prefix)

    if lowered in {"python", "python3", "py", "node"}:
        if "-m" in parts[1:]:
            idx = parts.index("-m", 1)
            prefix.append("-m")
            if idx + 1 < len(parts):
                prefix.append(parts[idx + 1])
            return shlex.join(prefix)
        if any(flag in parts[1:] for flag in ("-c", "-e", "--eval")):
            flag = next(flag for flag in ("-c", "-e", "--eval") if flag in parts[1:])
            prefix.append(flag)
            return shlex.join(prefix)

    prefix.append(parts[1])
    return shlex.join(prefix)


def _bash_confirm_context(
    *,
    tool_name: str,
    command: str,
    command_name: str,
    parts: List[str],
    risk: str,
    sandbox_permissions: str,
    write_roots: List[Path],
    cwd: Optional[Path],
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Return one structured confirmation scope shared by every Bash risk path."""

    context: Dict[str, Any] = {
        "tool": tool_name,
        "command": command,
        "command_prefix": _command_approval_prefix(command_name, parts),
        "risk": risk,
        "sandbox_permissions": sandbox_permissions,
        "workspace_roots": [str(root) for root in write_roots],
    }
    effective_cwd = cwd or (write_roots[0] if write_roots else None)
    if effective_cwd is not None:
        context["cwd"] = str(effective_cwd)
    if extra:
        context.update(extra)
    return context


def _risk_finding(code: str, evidence: str) -> Dict[str, str]:
    return {"code": code, "evidence": evidence}


def _append_risk_finding(
    findings: List[Dict[str, str]],
    code: str,
    evidence: str,
) -> None:
    finding = _risk_finding(code, evidence)
    if finding not in findings:
        findings.append(finding)


def _collect_subcommand_risk_findings(
    command_name: str,
    parts: List[str],
) -> List[Dict[str, str]]:
    """Return structured risk categories for subcommands and flags."""
    findings: List[Dict[str, str]] = []
    if command_name == "python":
        if any(token in {"-c", "-m"} for token in parts[1:]):
            _append_risk_finding(
                findings,
                "arbitrary_code_execution",
                "python -c/-m 可执行任意 Python 代码",
            )

    if command_name == "pip":
        pip_subcommand = _first_non_option_token(parts)
        if pip_subcommand in {"install", "uninstall", "download", "wheel"}:
            _append_risk_finding(
                findings,
                "dependency_change",
                f"pip {pip_subcommand} 会变更 Python 环境或生成安装产物",
            )

    if command_name == "git":
        git_subcommand = _first_non_option_token(
            parts,
            options_with_value={"-c", "-C", "--git-dir", "--work-tree"},
        )
        if git_subcommand and git_subcommand not in {"status", "log", "diff", "show", "branch"}:
            _append_risk_finding(
                findings,
                "version_control_change",
                f"git {git_subcommand} 会变更版本库状态",
            )
        if git_subcommand == "push":
            _append_risk_finding(
                findings,
                "external_publish",
                "git push 会把版本库状态发布到远端",
            )

    # npm install / yarn add / pnpm add change workspace or global deps
    if command_name == "npm":
        npm_sub = _first_non_option_token(parts)
        if npm_sub in {"install", "i", "uninstall", "un", "update", "upgrade"}:
            _append_risk_finding(
                findings,
                "dependency_change",
                f"npm {npm_sub} 会变更项目依赖",
            )
    if command_name in {"yarn", "pnpm"}:
        sub = _first_non_option_token(parts)
        if sub in {"add", "remove", "install", "update", "upgrade"}:
            _append_risk_finding(
                findings,
                "dependency_change",
                f"{command_name} {sub} 会变更项目依赖",
            )

    # system package managers
    if command_name in {"brew", "apt-get", "apt", "yum", "dnf", "choco", "snap"}:
        sub = _first_non_option_token(parts)
        if sub in {"install", "remove", "uninstall", "upgrade", "autoremove"}:
            _append_risk_finding(
                findings,
                "dependency_change",
                f"{command_name} {sub} 会变更系统软件包",
            )

    # node -e executes arbitrary code (like python -c)
    if command_name == "node":
        if any(token in {"-e", "--eval"} for token in parts[1:]):
            _append_risk_finding(
                findings,
                "arbitrary_code_execution",
                "node -e 可执行任意 JavaScript 代码",
            )

    return findings


def _collect_leaf_risk_findings(
    command_name: str,
    parts: List[str],
) -> List[Dict[str, str]]:
    """Escalation rules for ONE simple command (no pipes, no redirects).

    以前这些规则只看整条命令的第一个 token，于是 ``echo x && git push --force`` 只会报
    ``shell_composition``——最危险的那次反而拿到最没信息量的理由，而且 ``shell_composition``
    不在「不可复用」集合里，藏在 ``&&`` 后面的 force push 比裸写的还容易被复用。
    改成逐段调用之后，每一段的能力都会被各自归类。
    """

    findings = _collect_subcommand_risk_findings(command_name, parts)
    if command_name == "python" and _extract_python_script_arg(parts):
        _append_risk_finding(
            findings,
            "arbitrary_code_execution",
            "执行 Python 脚本可运行任意代码",
        )
    if command_name == "rm" and any(
        flag in {"-rf", "-fr", "-r", "-R", "-f", "--no-preserve-root"}
        for flag in parts[1:]
    ):
        _append_risk_finding(
            findings,
            "destructive_filesystem",
            "rm 使用了递归、强制或不保护根目录的参数",
        )
    if command_name == "git":
        if len(parts) >= 3 and parts[1] == "reset" and parts[2] == "--hard":
            _append_risk_finding(
                findings,
                "destructive_filesystem",
                "git reset --hard 会丢弃工作树和暂存区改动",
            )
        if len(parts) >= 2 and parts[1] == "clean" and any(
            flag.startswith("-f") for flag in parts[2:]
        ):
            _append_risk_finding(
                findings,
                "destructive_filesystem",
                "git clean -f 会删除未跟踪文件",
            )
        if len(parts) >= 2 and parts[1] == "push" and any(
            "--force" in flag for flag in parts[2:]
        ):
            _append_risk_finding(
                findings,
                "external_publish",
                "git push --force 可能覆盖远端历史",
            )
    if command_name in {"dd", "mkfs", "shutdown", "reboot", "poweroff"}:
        _append_risk_finding(
            findings,
            "system_disruption",
            f"{command_name} 可能影响设备、文件系统或系统可用性",
        )
    return findings


def _collect_command_risk_findings(
    command_name: str,
    parts: List[str],
    command: str,
) -> List[Dict[str, str]]:
    """Classify every protected capability in a command, segment by segment.

    判定的原则：确认框留给**越出沙箱**或**沙箱内不可逆**的效果。workspace-write 已经兜住
    的事不再问第二遍——重定向的落点由 ``_ensure_bash_write_targets_allowed`` 在更早的阶段
    校验过，写不出工作区；沙箱后端本身没有不安全降级（找不到 bwrap / mxc 就直接拒绝执行）。

    过度打扰不是「更安全」：问得太勤会把人训练成闭眼点批准，于是真正该拦的那次也被点过去。
    所以只在 ``command_safety`` 判定「这一段沙箱兜不住」时才追加 ``unrecognized_command``，
    而不是按命令名是否在一张 18 条的白名单上。
    """

    findings: List[Dict[str, str]] = []
    for target in absolute_redirect_targets(command):
        # 相对路径重定向落在 cwd（一定在工作区内）且会被 _ensure_bash_write_targets_allowed
        # 再校验一次；绝对路径这里证明不了它在工作区内，交回去问。
        _append_risk_finding(
            findings,
            "shell_composition",
            f"重定向写入绝对路径 {target}，此处无法确认它落在工作区内",
        )
    leaves = split_simple_commands(command)
    if leaves is None:
        # 拆不动（命令替换、进程替换、后台执行、引号不闭合……）：不假装看懂，退回受保护。
        _append_risk_finding(
            findings,
            "shell_composition",
            "命令结构无法确定地拆解，可能藏有额外命令",
        )
        leaves = [parts] if parts else []

    for leaf in leaves:
        if not leaf:
            continue
        leaf_name = leaf[0].rsplit("/", 1)[-1]
        specific = _collect_leaf_risk_findings(leaf_name, list(leaf))
        for item in specific:
            _append_risk_finding(findings, item["code"], item["evidence"])

        verdict = classify_simple_command(leaf)
        if verdict.contained:
            continue
        # 去重按**段**做，不是全局：这一段已经有更具体的理由（pip install、git push…）
        # 就不再叠一条泛化的「不是只读命令」；但只要这一段没有具体理由，通用理由必须留下，
        # 否则 chmod / ssh / sudo 这类没有专门规则的命令会静默放行。
        if specific:
            continue
        for item in verdict.findings:
            _append_risk_finding(findings, item.code, item.evidence)
    return findings


def _protected_command_reuse_mode(findings: List[Dict[str, str]]) -> str:
    """Only contained, deterministic command effects may be reused in one run."""

    non_reusable = NEVER_AUTO_APPROVED_CATEGORIES
    codes = {str(item.get("code", "")) for item in findings}
    return "none" if codes & non_reusable else "exact-command"


def _extract_python_script_arg(parts: List[str]) -> Optional[str]:
    """Extract python script path for `python <script>.py` style execution."""
    if any(token in {"-c", "-m"} for token in parts[1:]):
        return None

    idx = 1
    while idx < len(parts):
        token = parts[idx]
        if token == "--":
            idx += 1
            break
        if token in {"-W", "-X"}:
            idx += 2
            continue
        if token.startswith("-"):
            idx += 1
            continue
        return token

    if idx < len(parts):
        return parts[idx]
    return None


def _bash_exec_shell_argv(command: str) -> List[str]:
    """Argv for ``subprocess.run(..., shell=False)`` to run ``command`` in a system shell.

    On Windows, ``/bin/bash`` is not available; use ``cmd.exe`` (COMSPEC) with ``/d /s /c``.
    """
    if sys.platform == "win32":
        comspec = os.environ.get("COMSPEC") or shutil.which("cmd.exe") or "cmd.exe"
        return [comspec, "/d", "/s", "/c", command]
    return ["/bin/bash", "-c", command]


class _BoundedOutputTail:
    """Keep only a small tail while the complete stream is written to disk.

    ``asyncio.StreamReader.__aiter__`` uses ``readline`` and can allocate an
    entire no-newline 16 MB response.  Reading fixed-size chunks and retaining
    a deque of chunks keeps peak live output bounded independently of the child
    process's output size.
    """

    def __init__(self, max_chars: int = MAX_BASH_OUTPUT_TAIL_CHARS) -> None:
        self.max_chars = max(1, int(max_chars))
        self._chunks: deque[str] = deque()
        self._size = 0

    def append(self, value: str) -> None:
        text = str(value or "")
        if not text:
            return
        if len(text) > self.max_chars:
            text = text[-self.max_chars :]
            self._chunks.clear()
            self._size = 0
        self._chunks.append(text)
        self._size += len(text)
        while self._size > self.max_chars and self._chunks:
            old = self._chunks.popleft()
            over = self._size - self.max_chars
            if len(old) <= over:
                self._size -= len(old)
            else:
                keep = old[over:]
                self._chunks.appendleft(keep)
                self._size -= over
                break

    @property
    def text(self) -> str:
        return "".join(self._chunks)

    def __bool__(self) -> bool:
        return self._size > 0


def _private_process_log_path(session: Optional[StudioSession], name: str, fallback: Path) -> Path:
    """Select a per-turn private log path, with a safe legacy fallback."""

    sid = _bash_bg_session_id(session)
    turn_id = str(getattr(session, "_active_turn_id", "") or "").strip() if session is not None else ""
    if sid != "default" and turn_id:
        try:
            from agenticx.runtime.private_workspace import private_log_path

            return private_log_path(sid, turn_id, name)
        except Exception:
            pass
    try:
        fallback.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return fallback


def _bash_exec_default_timeout_sec() -> int:
    """Studio global default for bash_exec when the model omits timeout_sec."""
    try:
        raw = ConfigManager.get_value("tools_options.bash_exec.default_timeout_sec")
    except Exception:
        raw = None
    if raw is None:
        return 30
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return 30
    return max(30, min(3600, v))


_CD_PEEL_BLOCK_METACHAR_RE = re.compile(r"\|\||\||>|<|\$\(|`")


def _command_blocks_cd_prefix_peel(command: str) -> bool:
    """If True, do not peel ``cd … &&`` into cwd + argv — preserves pipes/redirs/subshells."""
    return bool(_CD_PEEL_BLOCK_METACHAR_RE.search(command))


_STDERR_REDIRECT_PEEL_HINT_RES = (
    re.compile(r"unrecognized arguments:.*2>", re.I),
    re.compile(r"syntax error.*unexpected token", re.I),
    re.compile(r"unexpected token.*'\|'", re.I),
    re.compile(r"command not found.*&&", re.I),
)


def _stderr_suggests_redirect_peel_damage(text: str) -> bool:
    return any(rx.search(text) for rx in _STDERR_REDIRECT_PEEL_HINT_RES)


def _bash_stdout_output_hint(stdout: str) -> str:
    """Append-only hint so models notice answers already in stdout (FR-10)."""
    if not stdout or not stdout.strip():
        return ""
    lines = [ln for ln in stdout.splitlines() if ln.strip()]
    paths: List[str] = []
    for m in re.finditer(r"(?:/[\w./+\-]{3,}|~/[\w./+\-]{2,})", stdout[:50_000]):
        g = m.group(0)
        if g not in paths:
            paths.append(g)
        if len(paths) >= 2:
            break
    path_part = ", ".join(paths[:2]) if paths else "(无路径匹配)"
    return (
        f"\nOUTPUT_HINT: stdout 已包含 {len(lines)} 个非空行，主要文件路径线索 = {path_part}\n"
    )


def _try_peel_cd_prefix_parts(
    parts: List[str],
    session: Optional[StudioSession],
) -> Optional[Tuple[Path, List[str]]]:
    """If argv is ``cd <path> && ...`` or ``cd <path>; ...``, return cwd + remaining argv."""
    if len(parts) < 4:
        return None
    if parts[0].lower() != "cd":
        return None
    if parts[2] not in ("&&", ";"):
        return None
    rest = parts[3:]
    if not rest:
        return None
    try:
        resolved = _resolve_workspace_path(parts[1], session)
    except ValueError:
        return None
    try:
        if not resolved.is_dir():
            return None
    except OSError:
        return None
    return (resolved, rest)


@dataclass
class _BashPrepared:
    """Prepared shell execution payload shared by sync/background bash tools."""

    argv: List[str]
    cwd: Optional[Path]
    use_shell: bool
    command: str
    command_name: str
    env: Dict[str, str]
    sandbox_permissions: str
    sandbox_backend: str


@dataclass
class _BashBgJob:
    """In-memory background bash job state."""

    job_id: str
    session_id: str
    command: str
    cwd: Optional[str]
    proc: asyncio.subprocess.Process
    lines: List[str]
    read_cursor: int
    started_at: float
    log_path: Path
    drain_task: Optional[asyncio.Task[Any]]
    exit_code: Optional[int]
    sandbox_permissions: str
    sandbox_backend: str
    dropped_lines: int = 0


def _append_background_output(job: _BashBgJob, text: str) -> None:
    """Append a bounded output fragment for polling/UI display."""

    value = str(text or "")
    if not value:
        return
    if len(value) > MAX_BASH_OUTPUT_LINE_CHARS:
        value = value[-MAX_BASH_OUTPUT_LINE_CHARS:]
    if len(job.lines) >= MAX_BASH_OUTPUT_LINES:
        job.lines.pop(0)
        job.dropped_lines += 1
        if job.read_cursor:
            job.read_cursor -= 1
    job.lines.append(value)


def _signal_process(proc: Any, *, force: bool = False) -> None:
    """Signal a command and its POSIX process group when one was created."""

    sig = signal.SIGKILL if force else signal.SIGTERM
    if os.name == "posix":
        try:
            pid = int(getattr(proc, "pid", 0) or 0)
            if pid > 0:
                os.killpg(pid, sig)
                return
        except (OSError, ProcessLookupError, ValueError):
            pass
    try:
        (proc.kill if force else proc.terminate)()
    except (OSError, ProcessLookupError, AttributeError):
        pass


def _bash_bg_log_dir() -> Path:
    """``$AGX_HOME/logs/bash_bg``，按调用时的 AGX_HOME 解析（见 utils/agx_home.py）。"""
    from agenticx.utils.agx_home import lazy_home_path

    return lazy_home_path(__name__, "_BASH_BG_LOG_DIR", "logs", "bash_bg")
_BASH_BG_MAX_JOBS_DEFAULT = 8
_AUTH_URL_RE = re.compile(r"https?://[^\s'\"<>）)]+")
_BASH_BG_JOBS: Dict[str, _BashBgJob] = {}
_BASH_BG_PENDING_STARTS: Dict[str, Dict[str, float]] = {}
_BASH_BG_COMPLETED_RETENTION = 128


def active_background_writers(session_id: Optional[str] = None) -> List[Dict[str, str]]:
    """Return conservative metadata for owned background writers.

    A job remains active until its drain task has reaped the process and set
    ``exit_code``.  This includes commands that were launched with an explicit
    workspace cwd and commands using the private scratch cwd; the lifecycle
    layer intentionally does not attempt to infer write intent from shell
    text.  ``session_id=None`` returns the process-wide view used by undo
    admission, because two sessions may share a workspace.
    """

    sid = str(session_id or "").strip()
    rows: List[Dict[str, str]] = []
    pending_by_session = (
        {sid: _BASH_BG_PENDING_STARTS.get(sid, {})}
        if sid
        else _BASH_BG_PENDING_STARTS
    )
    for owner_sid, pending in sorted(pending_by_session.items()):
        for token in sorted(pending):
            rows.append(
                {
                    "job_id": token,
                    "cwd": "",
                    "command": "",
                    "session_id": owner_sid,
                    "reason": "background writer is starting",
                }
            )
    for job in list(_BASH_BG_JOBS.values()):
        if sid and job.session_id != sid:
            continue
        # ``bash_bg_stop`` records the direct child's return code before it
        # has finished draining pipes. Keep the job active until that drain
        # task completes, since a surviving process-group member may still be
        # writing during the short handoff window.
        drain_pending = job.drain_task is not None and not job.drain_task.done()
        if job.exit_code is not None and not drain_pending:
            continue
        rows.append(
            {
                "job_id": job.job_id,
                "cwd": str(job.cwd or ""),
                "command": str(job.command or ""),
                "session_id": str(job.session_id),
                "reason": "owned background writer is active",
            }
        )
    return rows


def _bash_bg_trim_completed_jobs() -> None:
    """Bound completed in-memory job metadata while retaining recent polls/logs."""

    completed = [job for job in _BASH_BG_JOBS.values() if job.exit_code is not None]
    excess = len(completed) - _BASH_BG_COMPLETED_RETENTION
    if excess <= 0:
        return
    completed.sort(key=lambda job: (job.started_at, job.job_id))
    for job in completed[:excess]:
        _BASH_BG_JOBS.pop(job.job_id, None)


def _bash_bg_default_first_wait_sec() -> float:
    """Default bounded wait to capture first-screen output."""
    try:
        raw = ConfigManager.get_value("tools_options.bash_bg.first_wait_sec")
    except Exception:
        raw = None
    if raw is None:
        return 4.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 4.0
    return max(1.0, min(15.0, value))


def _bash_bg_first_wait_sec(arguments: Dict[str, Any]) -> float:
    """Resolve first wait seconds from args or config."""
    raw = arguments.get("first_wait_sec")
    if raw is None:
        return _bash_bg_default_first_wait_sec()
    if isinstance(raw, str) and not raw.strip():
        return _bash_bg_default_first_wait_sec()
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return _bash_bg_default_first_wait_sec()
    return max(1.0, min(15.0, value))


def _bash_bg_max_jobs() -> int:
    """Maximum concurrent running background jobs per session."""
    try:
        raw = ConfigManager.get_value("tools_options.bash_bg.max_jobs")
    except Exception:
        raw = None
    if raw is None:
        return _BASH_BG_MAX_JOBS_DEFAULT
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return _BASH_BG_MAX_JOBS_DEFAULT
    return max(1, min(32, value))


def _extract_auth_urls(text: str) -> List[str]:
    """Extract auth/login URLs from tool output text."""
    urls: List[str] = []
    for match in _AUTH_URL_RE.findall(text or ""):
        if match not in urls:
            urls.append(match)
        if len(urls) >= 5:
            break
    return urls


def _bash_bg_session_id(session: Optional[StudioSession]) -> str:
    """Stable session id key for ownership checks.

    Real ``StudioSession`` instances carry the session id as ``_session_id``
    (set via ``setattr(session, "_session_id", ...)`` in ``studio/server.py``);
    the class has no ``session_id`` field. Reading the wrong attribute would
    make every session collapse into the same "default" bucket and defeat
    background-job ownership isolation across sessions.
    """
    if session is None:
        return "default"
    sid = str(getattr(session, "_session_id", "") or getattr(session, "session_id", "") or "").strip()
    return sid or "default"


def _reserve_bash_bg_writer(session_id: str, token: str) -> Optional[str]:
    """Reserve a writer slot atomically with lifecycle rewind admission."""

    try:
        from agenticx.runtime.turn_lifecycle import TurnAlreadyRunning, TurnLifecycleStore

        TurnLifecycleStore.reserve_background_writer(session_id, token)
    except TurnAlreadyRunning as exc:
        return str(exc)
    except Exception as exc:
        return f"background writer reservation failed: {exc}"
    _BASH_BG_PENDING_STARTS.setdefault(session_id, {})[token] = time.time()
    return None


def _release_bash_bg_writer_reservation(session_id: str, token: str) -> None:
    _BASH_BG_PENDING_STARTS.get(session_id, {}).pop(token, None)
    if not _BASH_BG_PENDING_STARTS.get(session_id):
        _BASH_BG_PENDING_STARTS.pop(session_id, None)
    try:
        from agenticx.runtime.turn_lifecycle import TurnLifecycleStore

        TurnLifecycleStore.release_background_writer(session_id, token)
    except Exception:
        pass


def _bash_bg_owned_job(job_id: str, session: Optional[StudioSession]) -> Union[_BashBgJob, str]:
    """Resolve a job id and validate it belongs to the current session."""
    key = str(job_id or "").strip()
    if not key:
        return "ERROR: job_id is required"
    job = _BASH_BG_JOBS.get(key)
    if job is None:
        return f"ERROR: unknown or not-owned job_id: {key}"
    if job.session_id != _bash_bg_session_id(session):
        return f"ERROR: unknown or not-owned job_id: {key}"
    return job


def _bash_bg_running_jobs_for_session(session_id: str) -> int:
    """Count running jobs for a session."""
    return sum(1 for job in _BASH_BG_JOBS.values() if job.session_id == session_id and job.exit_code is None)


async def _bash_bg_drain(job: _BashBgJob) -> None:
    """Drain stdout/stderr to a complete private log and bounded poll tail."""

    async def _pump(stream: Optional[asyncio.StreamReader]) -> None:
        if stream is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            raw = await stream.read(_BASH_PIPE_READ_CHUNK)
            if not raw:
                break
            # Preserve exact bytes in the private log.  Decoding each read in
            # isolation would turn a UTF-8 code point split at a chunk boundary
            # into replacement characters in the supposedly complete log.
            try:
                with job.log_path.open("ab") as handle:
                    handle.write(raw)
            except Exception:
                pass
            text = decoder.decode(raw, final=False)
            if not text:
                continue
            for line in text.splitlines() or [text]:
                _append_background_output(job, line.rstrip("\r\n"))
        tail = decoder.decode(b"", final=True)
        if tail:
            for line in tail.splitlines() or [tail]:
                _append_background_output(job, line.rstrip("\r\n"))

    try:
        await asyncio.gather(_pump(job.proc.stdout), _pump(job.proc.stderr))
        await job.proc.wait()
    finally:
        try:
            job.exit_code = job.proc.returncode
        except Exception:
            if job.exit_code is None:
                job.exit_code = -1
        # StreamReader has no close operation.  stdin is a writer and can be
        # closed after the child has been reaped.
        try:
            if job.proc.stdin is not None and hasattr(job.proc.stdin, "close"):
                job.proc.stdin.close()
        except Exception:
            pass
        _bash_bg_trim_completed_jobs()


async def _bash_exec_prepare(
    command: str,
    arguments: Dict[str, Any],
    session: Optional[StudioSession],
    *,
    tool_name: str,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any],
) -> Union[_BashPrepared, str]:
    """Shared validation and argv construction for sync/background bash tools."""
    command = str(command or "").strip()
    if not command:
        return "ERROR: missing command"
    if len(command) > MAX_BASH_EXEC_COMMAND_CHARS:
        return f"ERROR: command exceeds maximum length ({MAX_BASH_EXEC_COMMAND_CHARS} characters)"

    perm_deny = tool_denied_by_session_permissions(tool_name) or tool_blocked_by_plan_mode(
        tool_name,
        session,
    )
    if perm_deny:
        return f"ERROR: {perm_deny}"

    command_deny = command_denied_by_session_permissions(command)
    if command_deny:
        return f"ERROR: {command_deny}"

    try:
        sandbox_permissions = _apply_permission_mode_ceiling(
            normalize_command_permissions(arguments.get("sandbox_permissions")),
            session,
        )
    except CommandSandboxError as exc:
        return f"ERROR: {exc}"

    read_roots, write_roots = _session_workspace_root_sets(session)
    private_exec = str(getattr(session, "_private_execution_root", "") or "").strip()
    if private_exec:
        try:
            if _path_has_unsafe_symlink_component(Path(private_exec)):
                raise ValueError("private execution path contains a symlink")
            private_path = _safe_resolve_path(Path(private_exec))
            if not any(str(private_path) == str(item) for item in read_roots):
                read_roots.append(private_path)
            if not any(str(private_path) == str(item) for item in write_roots):
                write_roots.append(private_path)
        except (OSError, RuntimeError, ValueError) as exc:
            return f"ERROR: private execution path is not safe: {exc}"
    # During a managed turn, scripts and implicit shell output belong in the
    # private scratch cwd.  Explicit ``cwd`` and an explicit ``cd`` prefix still
    # select the user's mounted workspace after the normal path checks.
    default_cwd = (
        _safe_resolve_path(Path(private_exec))
        if private_exec
        else (write_roots[0] if write_roots else None)
    )

    cwd_arg = arguments.get("cwd")
    if cwd_arg:
        try:
            if sandbox_permissions == DANGER_FULL_ACCESS:
                candidate = Path(str(cwd_arg)).expanduser()
                if not candidate.is_absolute() and default_cwd is not None:
                    candidate = default_cwd / candidate
                if _path_has_unsafe_symlink_component(candidate):
                    return "ERROR: working directory may not traverse a symlink"
                cwd = candidate.resolve(strict=False)
                if not cwd.is_dir():
                    return f"ERROR: working directory not found: {cwd}"
            else:
                # cwd 是「进到哪个目录」，不是「往哪写」。用 for_write=True 解析是为了
                # 防止 cd 进只读引用挂载后再写；但 plan 模式下沙箱本就拒绝一切写，
                # 再套一层写权限校验只会让 `ls` 这类只读命令也被拒——那是我 2026-08-24
                # 加 plan 闸时引入的回归。
                cwd = _resolve_workspace_path(
                    str(cwd_arg), session, for_write=not _plan_mode_active(session)
                )
        except (OSError, RuntimeError, ValueError) as exc:
            return f"ERROR: {exc}"
    else:
        cwd = None

    try:
        parts = shlex.split(command)
    except ValueError as exc:
        return f"ERROR: command parse failed: {exc}"
    if not parts:
        return "ERROR: empty command"

    if cwd is None:
        peeled = (
            None
            if _command_blocks_cd_prefix_peel(command)
            else _try_peel_cd_prefix_parts(parts, session)
        )
        if peeled:
            cwd, parts = peeled
            command = shlex.join(parts)

    # 兜底到会话默认目录必须发生在这里，不能等到构建沙箱计划前。下面
    # 「不再询问」的作用域判定（command_allowed_without_confirm）拿 cwd 去比工作区，
    # cwd 还是 None 的话，工作区限定的规则一条都命中不了——绝大多数命令根本不传 cwd，
    # 等于那个功能只在显式传 cwd 时才存在。
    # 顺带让 _ensure_bash_write_targets_allowed 也能把相对路径落到真正的执行目录上。
    if cwd is None:
        cwd = default_cwd

    command_name = Path(parts[0]).name
    if command_name.startswith("firecrawl_"):
        return (
            f"ERROR: '{command_name}' is an MCP tool name, not a shell command. "
            "Use mcp_call with JSON arguments, e.g. "
            "{\"tool_name\":\"firecrawl_scrape\",\"arguments\":{\"url\":\"https://example.com\"}}. "
            "For multiple URLs, iterate single-url calls or use firecrawl_crawl/firecrawl_map."
        )
    if session is not None and getattr(session, "mcp_hub", None) is not None:
        try:
            routed = getattr(session.mcp_hub, "_tool_routing", {}) or {}
            if command_name in routed:
                return (
                    f"ERROR: '{command_name}' is an MCP tool name, not a shell command. "
                    "Use mcp_call with JSON arguments. "
                    "Tip: call list_mcps and copy tool_name from mcp_tool_names."
                )
        except Exception:
            pass
    if command_name == "cd" and len(parts) <= 2:
        target = str(parts[1]) if len(parts) > 1 else "~"
        try:
            if sandbox_permissions == DANGER_FULL_ACCESS:
                candidate = Path(target).expanduser()
                if not candidate.is_absolute() and default_cwd is not None:
                    candidate = default_cwd / candidate
                resolved = candidate.resolve(strict=False)
            else:
                resolved = _resolve_workspace_path(target, session)
        except (OSError, RuntimeError, ValueError) as exc:
            return f"ERROR: {exc}"
        if not resolved.exists() or not resolved.is_dir():
            return f"ERROR: target directory not found: {resolved}"
        return (
            f"OK: cd {resolved}\n"
            "说明：`cd` 是 shell 内建命令，不会在无 shell 的单次执行中持久化。\n"
            "请在后续 bash_exec 调用里通过 `cwd` 参数指定工作目录。"
        )

    if sandbox_permissions == WORKSPACE_WRITE:
        # Reference mounts remain read-only inside the broader writable-root set.
        write_guard_error = _ensure_bash_write_targets_allowed(command, session, cwd)
        if write_guard_error:
            return write_guard_error

    if _command_touches_protected_config(command, parts):
        return (
            "ERROR: direct access to $AGX_HOME/config.yaml is blocked for safety. "
            "Use update_email_config for notifications.email.* changes."
        )

    if sandbox_permissions == WORKSPACE_WRITE and command_name in PATH_GUARDED_READ_COMMANDS:
        guarded_paths = _extract_guarded_paths(command_name, parts)
        validation_error = _ensure_paths_within_workspace(guarded_paths, session)
        if validation_error:
            return validation_error

    if sandbox_permissions == WORKSPACE_WRITE and command_name == "python":
        python_script = _extract_python_script_arg(parts)
        if python_script and python_script != "-":
            try:
                _resolve_workspace_path(python_script, session, pick_existing=True)
            except ValueError as exc:
                return f"ERROR: {exc}"

    command_risk_findings = _collect_command_risk_findings(command_name, parts, command)

    if sandbox_permissions == DANGER_FULL_ACCESS:
        full_access_findings = [
            _risk_finding(
                "host_full_access",
                "danger-full-access 会退出工作区写入隔离",
            ),
            *command_risk_findings,
        ]
        if not await _confirm(
            "This command requests danger-full-access and may write anywhere on the host. Execute anyway?",
            confirm_gate=confirm_gate,
            context=_bash_confirm_context(
                tool_name=tool_name,
                command=command,
                command_name=command_name,
                parts=parts,
                risk="permission_escalation",
                sandbox_permissions=sandbox_permissions,
                write_roots=write_roots,
                cwd=cwd,
                extra={
                    "approval_reuse": "none",
                    "protected_reason": "该命令申请退出工作区写入隔离",
                    "risk_categories": full_access_findings,
                    "reasons": [item["evidence"] for item in full_access_findings],
                },
            ),
            emit_event=emit_event,
        ):
            return _cancelled("未批准 danger-full-access，命令未执行", confirm_gate)
    else:
        # unrecognized_command 现在由 _collect_command_risk_findings 逐段判定
        # （见 agenticx/runtime/command_safety.py）。这里不再按第一个 token 是否在
        # 一张 18 条的白名单上追加——那既会把 sort/jq/stat 这类只读命令报上来，
        # 又会因为 find 在名单上而放行 `find . -delete`。

        # 档位决定哪些类别还需要人来定：只读档下文件类风险已被沙箱拒绝，不必再问一遍
        # （见 command_safety.categories_requiring_approval）。
        approval_codes = set(
            categories_requiring_approval(
                sandbox_permissions,
                (item["code"] for item in command_risk_findings),
            )
        )
        command_risk_findings = [
            item for item in command_risk_findings if item["code"] in approval_codes
        ]

        if command_risk_findings and command_allowed_without_confirm(
            command,
            (item["code"] for item in command_risk_findings),
            cwd=cwd,
        ):
            # 用户按过「不再询问」（或手写了 permissions.allowed_commands）。
            # 三类高危不受此豁免，判定在 command_allowed_without_confirm 里。
            command_risk_findings = []

        if command_risk_findings:
            risk_codes = {item["code"] for item in command_risk_findings}
            risk = "non_whitelisted" if risk_codes == {"unrecognized_command"} else "high"
            risk_reasons = [item["evidence"] for item in command_risk_findings]
            joined_reasons = ", ".join(risk_reasons)
            if not await _confirm(
                f"Protected command detected ({joined_reasons}). Execute anyway?",
                confirm_gate=confirm_gate,
                context=_bash_confirm_context(
                    tool_name=tool_name,
                    command=command,
                    command_name=command_name,
                    parts=parts,
                    risk=risk,
                    sandbox_permissions=sandbox_permissions,
                    write_roots=write_roots,
                    cwd=cwd,
                    extra={
                        "approval_reuse": _protected_command_reuse_mode(command_risk_findings),
                        "protected_reason": "命令命中需要人工批准的安全规则",
                        "risk_categories": command_risk_findings,
                        "reasons": risk_reasons,
                    },
                ),
                emit_event=emit_event,
            ):
                return _cancelled("受保护命令未执行", confirm_gate)

    use_shell = bool(re.search(r"(;|&&|\|\||\||`|\$\(|>|<|\n)", command))
    if not use_shell:
        use_shell = bool(
            re.match(
                r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+[^\s].*$",
                command,
            )
        ) or command.lstrip().startswith("export ")
    if sys.platform == "win32" and not use_shell and parts:
        resolved0 = shutil.which(parts[0])
        if resolved0:
            parts = [resolved0] + list(parts[1:])
    argv = _bash_exec_shell_argv(command) if use_shell else parts
    scope_id = f"{_bash_bg_session_id(session)}|{'|'.join(str(root) for root in write_roots)}"
    try:
        sandbox_plan = build_command_sandbox_plan(
            argv,
            denied_path_patterns=denied_path_patterns_for_sandbox(),
            permissions=sandbox_permissions,
            writable_roots=write_roots,
            readable_roots=read_roots,
            scope_id=scope_id,
            cwd=cwd,
            platform_name=sys.platform,
        )
    except CommandSandboxError as exc:
        return (
            f"ERROR: command sandbox unavailable: {exc}. "
            "The command was not run. If unrestricted host access is necessary, retry with "
            "sandbox_permissions='danger-full-access'; that request always requires user approval."
        )
    child_env = dict(sandbox_plan.env)
    for key in _SENSITIVE_DESKTOP_CHILD_ENV:
        child_env.pop(key, None)
    return _BashPrepared(
        argv=list(sandbox_plan.argv),
        cwd=cwd,
        use_shell=use_shell,
        command=command,
        command_name=command_name,
        env=child_env,
        sandbox_permissions=sandbox_plan.permissions,
        sandbox_backend=sandbox_plan.backend,
    )


def _bash_bg_status_line(job: _BashBgJob) -> str:
    """Return running/exited status text."""
    return "exited" if job.exit_code is not None else "running"


def _bash_bg_render_urls(urls: List[str]) -> str:
    """Render URL list for tool response text."""
    if not urls:
        return "(none)"
    return "\n".join(f"- {url}" for url in urls)


async def _tool_bash_bg_start(
    arguments: Dict[str, Any],
    session: Optional[StudioSession] = None,
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> str:
    command = str(arguments.get("command", "")).strip()
    prepared = await _bash_exec_prepare(
        command,
        arguments,
        session,
        tool_name="bash_bg_start",
        confirm_gate=confirm_gate,
        emit_event=emit_event,
    )
    if isinstance(prepared, str):
        return prepared

    session_id = _bash_bg_session_id(session)
    max_jobs = _bash_bg_max_jobs()
    if _bash_bg_running_jobs_for_session(session_id) >= max_jobs:
        return (
            f"ERROR: too many running background jobs (max {max_jobs}). "
            "Stop one with bash_bg_stop first."
        )

    try:
        _bash_bg_log_dir().mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    job_id = uuid.uuid4().hex[:12]
    reservation_token = f"pending:{job_id}"
    reservation_error = _reserve_bash_bg_writer(session_id, reservation_token)
    if reservation_error:
        return f"ERROR: {reservation_error}"
    try:
        log_path = _private_process_log_path(
            session,
            f"bash-bg-{job_id}",
            _bash_bg_log_dir() / f"{job_id}.log",
        )
        proc = await asyncio.create_subprocess_exec(
            *prepared.argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(prepared.cwd) if prepared.cwd else None,
            env=prepared.env,
            start_new_session=(os.name == "posix"),
        )
    except BaseException as exc:
        _release_bash_bg_writer_reservation(session_id, reservation_token)
        if isinstance(exc, asyncio.CancelledError):
            raise
        return f"ERROR: command failed to start: {exc}"

    job = _BashBgJob(
        job_id=job_id,
        session_id=session_id,
        command=prepared.command,
        cwd=str(prepared.cwd) if prepared.cwd else None,
        proc=proc,
        lines=[],
        read_cursor=0,
        started_at=time.time(),
        log_path=log_path,
        drain_task=None,
        exit_code=None,
        sandbox_permissions=prepared.sandbox_permissions,
        sandbox_backend=prepared.sandbox_backend,
    )
    _BASH_BG_JOBS[job_id] = job
    _release_bash_bg_writer_reservation(session_id, reservation_token)
    job.drain_task = asyncio.create_task(_bash_bg_drain(job))

    first_wait_sec = _bash_bg_first_wait_sec(arguments)
    deadline = asyncio.get_event_loop().time() + first_wait_sec
    while asyncio.get_event_loop().time() < deadline:
        if job.exit_code is not None or job.lines:
            break
        await asyncio.sleep(0.2)

    captured_output = "\n".join(job.lines)[-MAX_BASH_OUTPUT_TAIL_CHARS:].strip()
    auth_urls = _extract_auth_urls(captured_output)
    job.read_cursor = len(job.lines)
    status = _bash_bg_status_line(job)
    exit_code = str(job.exit_code) if job.exit_code is not None else "null"
    cwd_text = job.cwd or "(session workspace)"
    return (
        f"job_id={job.job_id}\n"
        f"status={status}\n"
        f"exit_code={exit_code}\n"
        f"cwd={cwd_text}\n"
        f"command={job.command}\n"
        f"sandbox_permissions={job.sandbox_permissions}\n"
        f"sandbox_backend={job.sandbox_backend}\n"
        f"captured_output:\n{captured_output or '(empty)'}\n"
        f"auth_urls:\n{_bash_bg_render_urls(auth_urls)}\n"
        "NOTE: Process is running in background and is not timeout-killed.\n"
        f"NOTE: output tail is bounded to {MAX_BASH_OUTPUT_TAIL_CHARS} characters; complete output is in {job.log_path}.\n"
        "- If auth_urls is not empty, relay them verbatim to the user and ask for scan/authorize.\n"
        "- If command requires input, use bash_bg_input(job_id, text).\n"
        "- After user confirms completion, call bash_bg_poll for final exit_code and output."
    )


async def _tool_bash_bg_poll(
    arguments: Dict[str, Any],
    session: Optional[StudioSession] = None,
) -> str:
    owned = _bash_bg_owned_job(str(arguments.get("job_id", "") or ""), session)
    if isinstance(owned, str):
        return owned
    job = owned
    new_lines = job.lines[job.read_cursor:]
    job.read_cursor = len(job.lines)
    new_output = "\n".join(new_lines)[-MAX_BASH_OUTPUT_TAIL_CHARS:].strip()
    auth_urls = _extract_auth_urls(new_output)
    status = _bash_bg_status_line(job)
    exit_code = str(job.exit_code) if job.exit_code is not None else "null"
    body = (
        f"job_id={job.job_id}\n"
        f"status={status}\n"
        f"exit_code={exit_code}\n"
        f"sandbox_permissions={job.sandbox_permissions}\n"
        f"sandbox_backend={job.sandbox_backend}\n"
        f"new_output:\n{new_output or '(none)'}\n"
        f"auth_urls:\n{_bash_bg_render_urls(auth_urls)}"
    )
    if job.dropped_lines:
        body += (
            f"\nNOTE: {job.dropped_lines} earlier output fragments were dropped from the in-memory tail; "
            f"complete output is in {job.log_path}."
        )
    if status == "running" and not new_output:
        body += (
            "\nHINT: job still running with no new output. "
            "It may be waiting for user scan/authorization or stdin input."
        )
    return body


#: 沙箱拒绝时 shell 会说的那几句话。三个后端措辞不同,而模型只看得到这段文本。
_SANDBOX_DENIAL_MARKERS: tuple[str, ...] = (
    "operation not permitted",
    "read-only file system",
    "permission denied",
)


def _sandbox_denial_hint(blob: str, permissions: str) -> str:
    """告诉模型这次失败是沙箱拒绝，以及**它自己解决不了**。

    读隔离上线之后，「读不到那个文件」会是一类新的常见失败。没有这段提示，模型看到的
    是一句 ``Operation not permitted``，然后它会去试 ``sudo``、试相对路径、试 ``find``——
    每一次都失败，一轮就烧在这上面。

    这段话的重点是**出口在用户那边**，不是让模型自己去要更高权限:优先建议把目录挂成
    只读引用（长期、设置页里看得见），``danger-full-access`` 放在最后且写明要用户逐次
    批准。反过来写的话，模型每次读不到东西就会先申请一次全主机访问。
    """
    if permissions == DANGER_FULL_ACCESS:
        return ""
    lowered = blob.lower()
    if not any(marker in lowered for marker in _SANDBOX_DENIAL_MARKERS):
        return ""
    return (
        "\n\n[HINT] 这次失败来自 OS 沙箱，不是命令本身写错了。"
        "沙箱允许读写会话工作区、显式挂进来的只读引用和本次执行的临时目录；"
        "工作区之外的读写会被拒绝，命中 permissions.path_rules 拒绝规则的路径也一样"
        "（macOS / Linux 上读写都拒）。\n"
        "不要用 sudo 或换个写法重试——边界不在命令这一层。"
        "确实需要工作区外的内容时，请让用户把那个目录挂成只读引用（设置里可见、可撤销）；"
        "只有在必须写到工作区外时，才用 sandbox_permissions='danger-full-access' 重试，"
        "那一档每次都要用户单独批准。\n"
    )


async def confirm_verify_steps(
    session: Optional[StudioSession],
    arguments: Dict[str, Any],
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> Optional[str]:
    """把 verify.yaml 的每一步过一遍命令风险分类与确认闸。

    上一轮只给 ``verify_run`` 接了**文件沙箱**——工作区边界有了,``path_rules`` 也生效了,
    但命令风险这条线完全没接:``ask`` / ``auto`` 档下,verify.yaml 里一行
    ``cmd: rm -rf dist && git push`` 照跑不误,一次都不问。而 verify.yaml 是仓库内容,
    改它不需要碰用户的设置。plan 档整体拦住了 ``verify_run``,别的档没有。

    判定复用 ``bash_exec`` 完全同一套:同一个分类器、同一份
    ``categories_requiring_approval`` 的档位裁剪、同一个 ``allowed_commands`` 豁免、
    同一个 ``NEVER_AUTO_APPROVED_CATEGORIES``。**另写一套判定就是另一套语义**——
    用户在确认框里按下的「以后不再问这条命令」必须在两处含义相同。

    **先全部问完再开跑。** verify.yaml 的步骤在执行前就全知道,边跑边问只会让用户在
    一次运行里被打断好几次,而且第三步被拒时前两步已经落地了。任何一步被拒就整个不跑。

    Returns:
        None 表示可以跑；非空字符串是给模型看的工具结果。
    """
    from agenticx.project_state.store import ProjectStateError
    from agenticx.project_state.tools import _open_store, _resolve_workspace_root
    from agenticx.project_state.verify import verify_step_commands

    try:
        store = _open_store(session)
        steps = verify_step_commands(
            store, only_step=str(arguments.get("only_step") or "").strip() or None
        )
    except ProjectStateError:
        # 没有项目状态、verify.yaml 写坏了——``verify_run_tool`` 紧接着会用更具体的
        # 信息报同一个错，而且那时一步都不会执行。这里不代它拒。
        return None
    except Exception as exc:
        # 预期外的失败必须挡下来。写成 `except Exception: return None` 的话，预检一旦
        # 出岔子，确认闸就**静默消失**而命令照跑——这一整轮修的就是这种失效。
        _log.warning("verify_run preflight failed: %s", exc)
        return f"ERROR: verify_run 预检失败，未执行任何步骤：{exc}"

    write_roots = _session_workspace_root_sets(session)[1]
    try:
        cwd = _resolve_workspace_root(session)
    except Exception:
        cwd = write_roots[0] if write_roots else None

    for name, command in steps:
        deny = command_denied_by_session_permissions(command)
        if deny:
            return f"ERROR: verify step {name!r}: {deny}"
        try:
            parts = shlex.split(command)
        except ValueError:
            parts = []
        if not parts:
            continue
        command_name = Path(parts[0]).name
        findings = _collect_command_risk_findings(command_name, parts, command)
        approval_codes = set(
            categories_requiring_approval(
                WORKSPACE_WRITE, (item["code"] for item in findings)
            )
        )
        findings = [item for item in findings if item["code"] in approval_codes]
        if findings and command_allowed_without_confirm(
            command, (item["code"] for item in findings), cwd=cwd
        ):
            findings = []
        if not findings:
            continue
        risk_codes = {item["code"] for item in findings}
        risk = "non_whitelisted" if risk_codes == {"unrecognized_command"} else "high"
        reasons = [item["evidence"] for item in findings]
        if not await _confirm(
            f"verify.yaml 的步骤 {name!r} 要执行 `{command}`（{', '.join(reasons)}）。执行吗？",
            confirm_gate=confirm_gate,
            context=_bash_confirm_context(
                tool_name="verify_run",
                command=command,
                command_name=command_name,
                parts=parts,
                risk=risk,
                sandbox_permissions=WORKSPACE_WRITE,
                write_roots=write_roots,
                cwd=cwd,
                extra={
                    "approval_reuse": _protected_command_reuse_mode(findings),
                    "protected_reason": "verify.yaml 里的命令命中需要人工批准的安全规则",
                    "risk_categories": findings,
                    "reasons": reasons,
                    "verify_step": name,
                },
            ),
            emit_event=emit_event,
        ):
            return _cancelled(f"verify 步骤 {name!r} 未获批准，本次 verify_run 未执行", confirm_gate)
    return None


async def _tool_bash_bg_input(
    arguments: Dict[str, Any],
    session: Optional[StudioSession] = None,
) -> str:
    owned = _bash_bg_owned_job(str(arguments.get("job_id", "") or ""), session)
    if isinstance(owned, str):
        return owned
    job = owned
    if job.exit_code is not None:
        return "ERROR: job already exited"
    text = str(arguments.get("text", ""))
    stream = job.proc.stdin
    if stream is None:
        return "ERROR: job stdin is not available"
    payload = f"{text}\n".encode("utf-8")
    try:
        stream.write(payload)
        await stream.drain()
    except Exception as exc:
        return f"ERROR: failed to write stdin: {exc}"
    return f"OK: wrote {len(payload)} bytes to stdin of {job.job_id}"


async def _tool_bash_bg_stop(
    arguments: Dict[str, Any],
    session: Optional[StudioSession] = None,
) -> str:
    owned = _bash_bg_owned_job(str(arguments.get("job_id", "") or ""), session)
    if isinstance(owned, str):
        return owned
    job = owned
    if job.exit_code is not None:
        _bash_bg_trim_completed_jobs()
        return f"OK: job already exited (exit_code={job.exit_code})"

    force = bool(arguments.get("force", False))
    try:
        _signal_process(job.proc, force=force)
        try:
            await asyncio.wait_for(job.proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            _signal_process(job.proc, force=True)
            await job.proc.wait()
    except Exception as exc:
        return f"ERROR: failed to stop job: {exc}"

    job.exit_code = job.proc.returncode
    if job.drain_task is not None and not job.drain_task.done():
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await asyncio.wait_for(job.drain_task, timeout=2.0)
    _bash_bg_trim_completed_jobs()
    return f"OK: stopped {job.job_id} (exit_code={job.exit_code})"


async def _tool_bash_exec(
    arguments: Dict[str, Any],
    session: Optional[StudioSession] = None,
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> str:
    command = str(arguments.get("command", "")).strip()
    raw_timeout = arguments.get("timeout_sec")
    if raw_timeout is None:
        timeout_sec = _bash_exec_default_timeout_sec()
    elif isinstance(raw_timeout, str) and not str(raw_timeout).strip():
        timeout_sec = _bash_exec_default_timeout_sec()
    else:
        try:
            timeout_sec = int(raw_timeout)
        except (TypeError, ValueError):
            timeout_sec = _bash_exec_default_timeout_sec()
    timeout_sec = max(1, min(3600, timeout_sec))

    prepared = await _bash_exec_prepare(
        command,
        arguments,
        session,
        tool_name="bash_exec",
        confirm_gate=confirm_gate,
        emit_event=emit_event,
    )
    if isinstance(prepared, str):
        return prepared

    try:
        proc = await asyncio.create_subprocess_exec(
            *prepared.argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(prepared.cwd) if prepared.cwd else None,
            env=prepared.env,
            start_new_session=(os.name == "posix"),
        )
    except Exception as exc:
        return f"ERROR: command failed to start: {exc}"

    log_id = uuid.uuid4().hex[:12]
    log_path = _private_process_log_path(
        session,
        f"bash-{log_id}",
        _bash_bg_log_dir() / f"{log_id}.log",
    )
    stdout_tail = _BoundedOutputTail()
    stderr_tail = _BoundedOutputTail()
    _STREAM_THROTTLE_SEC = 0.2
    _last_emit_time = 0.0

    async def _read_pipe(
        stream: asyncio.StreamReader,
        target: _BoundedOutputTail,
        label: str,
    ) -> None:
        nonlocal _last_emit_time
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        iterator = None
        if not callable(getattr(stream, "read", None)):
            iterator = stream.__aiter__()
        while True:
            # Keep compatibility with small async-iterator test adapters while
            # using fixed-size reads for real subprocess pipes.
            read = getattr(stream, "read", None)
            if callable(read):
                raw = await read(_BASH_PIPE_READ_CHUNK)
            else:
                try:
                    raw = await iterator.__anext__()
                except StopAsyncIteration:
                    raw = b""
            if not raw:
                break
            try:
                with log_path.open("ab") as handle:
                    handle.write(raw)
            except Exception:
                pass
            text = decoder.decode(raw, final=False)
            if not text:
                continue
            target.append(text)
            if emit_event is not None:
                now = asyncio.get_event_loop().time()
                if now - _last_emit_time >= _STREAM_THROTTLE_SEC:
                    _last_emit_time = now
                    try:
                        await emit_event({
                            "type": "tool_output",
                            "data": {
                                "stream": label,
                                "line": text[-MAX_BASH_OUTPUT_LINE_CHARS:],
                            },
                        })
                    except Exception:
                        pass
        tail = decoder.decode(b"", final=True)
        if tail:
            target.append(tail)

    async def _stop_process() -> None:
        """Terminate and reap a child before a timeout/cancellation returns."""

        # The shell leader may have exited while a grandchild still owns the
        # stdout/stderr pipe. Signal its process group even when returncode is
        # already populated; returning early lets that grandchild continue
        # writing after cancellation.
        _signal_process(proc)
        try:
            # Give a well-behaved shell a short chance to flush and exit, but
            # do not use the leader's return code as proof that its process
            # group is gone.  Pipelines/background children can outlive it.
            await asyncio.wait_for(proc.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            pass
        finally:
            # Always kill the group after the bounded grace period.  This is
            # required when a descendant ignores SIGTERM and retains the pipe
            # (and may otherwise keep writing a private log after cancellation).
            _signal_process(proc, force=True)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), timeout=1.0)

    reader_group = asyncio.gather(
        _read_pipe(proc.stdout, stdout_tail, "stdout"),
        _read_pipe(proc.stderr, stderr_tail, "stderr"),
        return_exceptions=True,
    )

    async def _join_readers(timeout: float) -> None:
        """Retrieve every reader result, cancelling only after a bounded wait.

        Keep the gather future named and awaited on every exit path.  In
        particular, cancelling the request must not leave a detached gather
        future reporting ``CancelledError`` after the HTTP handler returned.
        ``shield`` lets us reap the process and drain its pipes before the
        bounded timeout path decides that a descendant has kept a pipe open.
        """

        if reader_group.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reader_group
            return
        try:
            await asyncio.wait_for(asyncio.shield(reader_group), timeout=timeout)
        except asyncio.TimeoutError:
            if not reader_group.done():
                reader_group.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reader_group
        except asyncio.CancelledError:
            if not reader_group.done():
                reader_group.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await reader_group

    timed_out = False
    try:
        await asyncio.wait_for(
            asyncio.shield(reader_group),
            timeout=max(1, timeout_sec),
        )
        await proc.wait()
    except asyncio.TimeoutError:
        timed_out = True
    except asyncio.CancelledError:
        # A cancelled request must not leave a child alive and writing to a
        # private log after its caller has moved on.
        await _stop_process()
        raise

    finally:
        if timed_out:
            await _stop_process()
            # Capture any bytes already buffered after reaping the child, with
            # a bound so a descendant holding a pipe open cannot block the
            # tool forever.  The named gather is always retrieved.
            await _join_readers(2.0)
        elif proc.returncode is None:
            await _stop_process()
            await _join_readers(2.0)
        else:
            # The normal path already awaited the gather, but retrieving the
            # completed future here keeps cleanup correct if a reader adapter
            # finished just as the process wait returned.
            await _join_readers(0.0)
        # StreamReader has no close() method.  Closing it is ineffective and
        # breaks test adapters; stdin is the only writer that needs closing.
        with contextlib.suppress(Exception):
            if proc.stdin is not None and hasattr(proc.stdin, "close"):
                proc.stdin.close()

    if timed_out:
        return f"ERROR: command timeout after {timeout_sec}s"

    stdout = stdout_tail.text.strip()
    stderr = stderr_tail.text.strip()
    out = (
        f"sandbox_permissions={prepared.sandbox_permissions}\n"
        f"sandbox_backend={prepared.sandbox_backend}\n"
        f"exit_code={proc.returncode}\n"
        f"stdout:\n{stdout or '(empty)'}\n"
        f"stderr:\n{stderr or '(empty)'}\n"
        f"output_log={log_path}\n"
        f"NOTE: stdout/stderr return tails are bounded to {MAX_BASH_OUTPUT_TAIL_CHARS} characters; complete output is in the private log."
    )
    if proc.returncode != 0:
        blob = f"{stdout}\n{stderr}"
        hint = _sandbox_denial_hint(blob, prepared.sandbox_permissions)
        if hint:
            out += hint
        if _stderr_suggests_redirect_peel_damage(blob):
            out += (
                "\n\n[HINT] 检测到 shell 元字符（如 2>&1 / | / > 等）可能因 `cd` 前缀剥离或参数拆分被破坏。"
                "建议：(a) 移除命令内的 cd 前缀并在 bash_exec 的 cwd 参数指定工作目录；"
                "或 (b) 使用 bash -c '...' 显式包裹整条命令。\n"
            )
    elif stdout and len(stdout) >= 200:
        hint_line = _bash_stdout_output_hint(stdout)
        if hint_line:
            out += hint_line
    return out


def _max_read_chars_for_session(session: Optional[StudioSession]) -> int:
    if session is None:
        return MAX_READ_CHARS
    try:
        from agenticx.runtime.session_mode import is_code_dev

        return MAX_READ_CHARS_CODE_DEV if is_code_dev(session) else MAX_READ_CHARS
    except Exception:
        return MAX_READ_CHARS


def _tool_code_outline(arguments: Dict[str, Any], session: Optional[StudioSession] = None) -> str:
    from agenticx.runtime.code_outline import build_outline, format_outline_result

    raw_path = str(arguments.get("path", "")).strip()
    if not raw_path:
        return "ERROR: path is required"
    try:
        resolved = _resolve_workspace_path(raw_path, session, pick_existing=True)
    except ValueError as exc:
        return f"ERROR: {exc}"
    query = str(arguments.get("query", "") or "").strip() or None
    max_files = int(arguments.get("max_files") or 50)
    max_files = min(max(max_files, 1), 50)
    payload = build_outline(resolved, query=query, max_files=max_files)
    if payload.get("error"):
        return f"ERROR: {payload['error']}"
    return format_outline_result(payload)


def _tool_file_read(arguments: Dict[str, Any], session: Optional[StudioSession] = None) -> str:
    try:
        path = _resolve_workspace_path(str(arguments.get("path", "")), session, pick_existing=True)
    except ValueError as exc:
        return f"ERROR: {exc}"
    if not path.exists():
        return f"ERROR: file not found: {path}"
    if not path.is_file():
        return f"ERROR: not a file: {path}"

    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"ERROR: read failed: {exc}"

    start_line = arguments.get("start_line")
    end_line = arguments.get("end_line")
    max_chars = _max_read_chars_for_session(session)
    whole_file = start_line is None and end_line is None
    if start_line is not None or end_line is not None:
        lines = content.splitlines()
        start = max(1, int(start_line or 1))
        end = min(len(lines), int(end_line or len(lines)))
        if start > end:
            return "ERROR: invalid line range"
        selected = lines[start - 1 : end]
        numbered = [f"{idx+start}|{line}" for idx, line in enumerate(selected)]
        out = "\n".join(numbered)
        if session is not None:
            from agenticx.runtime.code_read_cache import record_file_read

            record_file_read(session, path, start_line=start, end_line=end, total_lines=len(lines))
            tracker = getattr(session, "file_state_tracker", None)
            if tracker is not None:
                tracker.refresh_from_disk(str(path))
        return out

    if session is not None:
        try:
            from agenticx.runtime.code_read_cache import record_file_read
            from agenticx.runtime.session_mode import (
                EXPLORE_WHOLE_FILE_READ_WARN_KEY,
                PHASE_EXPLORE,
                get_session_phase,
                is_code_dev,
            )

            record_file_read(
                session,
                path,
                start_line=None,
                end_line=None,
                total_lines=len(content.splitlines()),
            )
            if is_code_dev(session) and get_session_phase(session) == PHASE_EXPLORE:
                scratch = getattr(session, "scratchpad", None) or {}
                if isinstance(scratch, dict):
                    count = int(scratch.get(EXPLORE_WHOLE_FILE_READ_WARN_KEY, 0) or 0) + 1
                    scratch[EXPLORE_WHOLE_FILE_READ_WARN_KEY] = str(count)
        except Exception:
            pass

    if len(content) > max_chars:
        suffix = (
            f"\n... (truncated, total {len(content)} chars)"
            + (
                " 建议：code_dev 模式下请使用 start_line/end_line 缩小范围，或先用 code_outline。"
                if max_chars <= MAX_READ_CHARS_CODE_DEV
                else ""
            )
        )
        out = content[:max_chars] + suffix
    else:
        out = content
    if session is not None:
        tracker = getattr(session, "file_state_tracker", None)
        if tracker is not None and whole_file:
            tracker.record_read(str(path), content)
    return out


def _autoheal_skill_md_after_write(path: Path, base_msg: str) -> str:
    """Ensure a SKILL.md written via file tools is discoverable by the Skills system.

    When ``path`` points at ``<...>/skills/<name>/SKILL.md`` we normalize the YAML
    frontmatter (injecting ``name=<dir>`` / placeholder description when missing) and
    verify the SkillBundleLoader can parse it.  This guarantees that any "saved"
    reply for a skill equals "searchable in Settings → Skills".  Non-skill writes are
    returned unchanged.
    """
    try:
        if path.name != "SKILL.md":
            return base_msg
        parts = [p for p in path.parts]
        if "skills" not in parts:
            return base_msg
        skill_dir = path.parent
        # SKILL.md must live in skills/<name>/SKILL.md, not directly under skills/.
        if not skill_dir.name or skill_dir.name == "skills":
            return base_msg

        from agenticx.skills.frontmatter import (
            SkillFrontmatterError,
            normalize_skill_md,
            verify_skill_discoverable,
        )

        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            return base_msg

        try:
            normalized, fixed = normalize_skill_md(content, skill_dir.name)
        except SkillFrontmatterError as exc:
            return (
                f"ERROR: skill 不会被收录 — {exc}。"
                "SKILL.md 必须以 YAML frontmatter（`---\\nname: <名称>\\ndescription: <描述>\\n---`）开头。"
                f"文件已写入 {path}，但**不会**出现在设置 → Skills，请修正 frontmatter 后重写。"
            )

        if fixed:
            try:
                path.write_text(normalized, encoding="utf-8")
            except OSError as exc:
                return f"{base_msg}\n[warn] 自动补全 frontmatter 失败：{exc}（skill 可能无法被检索）"

        discoverable, skill_name, errors = verify_skill_discoverable(skill_dir)
        if not discoverable:
            detail = "; ".join(errors) if errors else "unknown parse failure"
            return (
                f"ERROR: skill 写入后仍不可被检索（{detail}）。"
                f"文件已写入 {path}，但**不会**出现在设置 → Skills。"
            )

        note = f"（已自动补全 frontmatter：{', '.join(fixed)}）" if fixed else ""
        return f"{base_msg}\nOK: skill '{skill_name}' 已可在设置 → Skills 检索{note}"
    except Exception:
        # Never let auto-heal failures break the underlying write result.
        return base_msg


async def _tool_file_write(
    arguments: Dict[str, Any],
    session: StudioSession,
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> str:
    raw_path = str(arguments.get("path", "")).strip()
    if not raw_path:
        return (
            "ERROR: missing required parameter 'path'. "
            "You must provide a full file path, e.g. file_write(path='/Users/.../file.py', content='...')"
        )
    from_path_arg = str(arguments.get("from_path", "") or "").strip()
    raw_content = arguments.get("content")
    if from_path_arg:
        try:
            src = _resolve_workspace_path(from_path_arg, session, pick_existing=True)
        except ValueError as exc:
            return f"ERROR: {exc}"
        if not src.is_file():
            return f"ERROR: from_path not found: {src}"
        try:
            new_text = _strip_tool_metadata_noise_lines(src.read_text(encoding="utf-8", errors="replace"))
        except OSError as exc:
            return f"ERROR: read from_path failed: {exc}"
    elif raw_content is None:
        return (
            "ERROR: missing required parameter 'content' or 'from_path'. "
            "You must provide file content, e.g. file_write(path='/Users/.../file.py', content='...')"
        )
    else:
        new_text = _strip_tool_metadata_noise_lines(str(raw_content))
    # In an ordinary non-Git workspace, an implicit relative file_write is
    # usually an intermediate generated script/document. Keep it in the
    # turn's private scratch directory so a successful chat does not dirty the
    # user's folder. Git workspaces retain their established source-edit
    # semantics; an explicit absolute path remains authoritative.
    path_arg = raw_path
    private_exec = str(getattr(session, "_private_execution_root", "") or "").strip()
    if private_exec and not Path(raw_path).expanduser().is_absolute():
        _read_roots, _write_roots = _session_workspace_root_sets(session)
        primary = _write_roots[0] if _write_roots else None
        is_git_workspace = False
        if primary is not None:
            try:
                probe = subprocess.run(
                    ["git", "-C", str(primary), "rev-parse", "--show-toplevel"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=3,
                )
                is_git_workspace = probe.returncode == 0
            except (OSError, subprocess.SubprocessError):
                is_git_workspace = False
        if not is_git_workspace:
            path_arg = str(Path(private_exec) / Path(raw_path).expanduser())
    try:
        path = _resolve_workspace_path(path_arg, session, for_write=True)
    except ValueError as exc:
        return f"ERROR: {exc}"
    if _is_protected_path(path):
        return (
            "ERROR: writes to protected paths are blocked for safety "
            "(e.g. $AGX_HOME/config.yaml, ~/.ssh). "
            "Use update_email_config meta tool for notifications.email.* updates."
        )
    old_text = ""
    if path.exists():
        if not path.is_file():
            return f"ERROR: not a file: {path}"
        try:
            old_text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return f"ERROR: read old file failed: {exc}"

    diff = _format_diff(path, old_text, new_text)
    # 用户在 permissions.path_rules 里对这条路径写了 allow，就不再逐次弹框
    # （等价于 Claude Code 的 Edit(src/**) 允许规则）。它不放开沙箱：路径能走到这里，
    # 说明已经通过了 _resolve_workspace_path 的工作区校验。
    if not _path_allowed_without_confirm(path) and not await _confirm(
        f"Write changes to {path}?",
        confirm_gate=confirm_gate,
        context={"tool": "file_write", "path": str(path), "diff": diff, "risk": "low"},
        emit_event=emit_event,
    ):
        return _cancelled("文件未写入", confirm_gate)

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(new_text, encoding="utf-8")
    except OSError as exc:
        return f"ERROR: write failed: {exc}"
    scratchpad = getattr(session, "scratchpad", None)
    if isinstance(scratchpad, dict):
        scratchpad["__taskspace_hint__"] = str(path)
    result = _autoheal_skill_md_after_write(path, f"OK: wrote {path}")
    tracker = getattr(session, "file_state_tracker", None)
    if tracker is not None:
        tracker.refresh_from_disk(str(path))
    return result


async def render_document_via_local_renderer(
    document_format: str,
    title: str,
    markdown: str,
) -> tuple[str, str, str]:
    """Render Markdown through the authenticated Electron host without writing.

    Workflow artifact delivery uses this render-only half of
    ``document_generate``.  The renderer remains the single Markdown/HTML
    implementation, while the managed Workflow executor owns the final
    contract path and atomic write after approval.  The returned tuple is
    ``(renderer_filename, mime_type, content)``.
    """

    document_format = str(document_format or "").strip().lower()
    if document_format not in {"md", "html", "doc"}:
        raise ValueError("format must be one of: md, html, doc")
    title = str(title or "").strip()
    markdown = str(markdown or "")
    if not title:
        raise ValueError("title is required")
    if len(title) > 500:
        raise ValueError("title is too long (maximum 500 characters)")
    request_payload = {"format": document_format, "title": title, "markdown": markdown}
    request_bytes = json.dumps(request_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # Keep this in sync with the Electron host's transport guard.  Checking
    # encoded bytes matters for CJK text; a character-only check can exceed the
    # request limit while still appearing small to the caller.
    if len(request_bytes) > 2 * 1024 * 1024:
        raise ValueError("document request exceeds the 2 MiB renderer limit")

    renderer_url = str(os.getenv("AGX_DOCUMENT_RENDERER_URL", "") or "").strip().rstrip("/")
    renderer_token = str(os.getenv("AGX_DOCUMENT_RENDERER_TOKEN", "") or "").strip()
    if not renderer_url or not renderer_token:
        raise ValueError(
            "local document renderer is unavailable. "
            "Start the Electron document renderer before calling document_generate."
        )
    try:
        parsed = urlparse(renderer_url)
    except ValueError as exc:
        raise ValueError("invalid AGX_DOCUMENT_RENDERER_URL") from exc
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("document renderer URL must point to a local loopback host")

    try:
        import httpx

        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0), trust_env=False) as client:
            response = await client.post(
                f"{renderer_url}/render",
                content=request_bytes,
                headers={
                    "content-type": "application/json",
                    "x-agx-document-renderer-token": renderer_token,
                },
            )
            if response.status_code >= 400:
                detail = response.text[:500]
                raise ValueError(f"local document renderer returned HTTP {response.status_code}: {detail}")
            if len(response.content) > 32 * 1024 * 1024:
                raise ValueError("rendered document exceeds the 32 MiB renderer limit")
            payload = response.json()
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"local document renderer request failed: {exc}") from exc

    if not isinstance(payload, dict):
        raise ValueError("local document renderer returned an invalid response")
    filename = str(payload.get("filename", "") or "").strip()
    mime_type = str(payload.get("mimeType", "") or "").strip()
    content = payload.get("content")
    if not filename or Path(filename).name != filename or filename in {".", ".."}:
        raise ValueError("local document renderer returned an invalid filename")
    if not mime_type or not isinstance(content, str):
        raise ValueError("local document renderer response must contain filename, mimeType, and string content")

    allowed_suffixes = {
        "md": frozenset({".md", ".markdown"}),
        "html": frozenset({".html", ".htm"}),
        "doc": frozenset({".doc"}),
    }
    if Path(filename).suffix.lower() not in allowed_suffixes[document_format]:
        raise ValueError(f"renderer filename does not match format '{document_format}'")
    if len(content.encode("utf-8")) > 32 * 1024 * 1024:
        raise ValueError("rendered document exceeds the 32 MiB renderer limit")
    return filename, mime_type, content


def _document_private_root(session: StudioSession) -> Optional[Path]:
    """Return the active turn root after lexical symlink validation."""

    raw = str(getattr(session, "_private_workspace_root", "") or "").strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    try:
        if not candidate.is_absolute():
            candidate = Path.cwd() / candidate
        candidate = Path(os.path.abspath(os.fspath(candidate)))
        if _path_has_unsafe_symlink_component(candidate):
            return None
        resolved = _safe_resolve_path(candidate)
        if not resolved.is_dir():
            return None
        return resolved
    except (OSError, RuntimeError, ValueError):
        return None


def _document_private_session_root(session: StudioSession) -> Optional[Path]:
    current = _document_private_root(session)
    if current is not None:
        try:
            # .../sessions/<sid>/turns/<turn_id> -> .../sessions/<sid>
            root = current.parents[1]
            if _path_has_unsafe_symlink_component(root):
                return None
            return _safe_resolve_path(root)
        except (IndexError, OSError, RuntimeError, ValueError):
            return None
    sid = _bash_bg_session_id(session)
    if sid == "default":
        return None
    try:
        from agenticx.runtime.private_workspace import private_session_root

        return private_session_root(sid)
    except (OSError, RuntimeError, ValueError):
        return None


def _document_allowed_roots(
    session: StudioSession,
    *,
    include_session_private: bool = False,
) -> list[Path]:
    """Build document roots without including read-only reference mounts."""

    _read_roots, write_roots = _session_workspace_root_sets(session)
    roots: list[Path] = []
    seen: set[str] = set()
    for raw in [*write_roots, _document_private_root(session)]:
        if raw is None:
            continue
        try:
            path = _safe_resolve_path(Path(raw))
            if _path_has_unsafe_symlink_component(Path(raw)):
                continue
        except (OSError, RuntimeError, ValueError):
            continue
        if str(path) not in seen:
            seen.add(str(path))
            roots.append(path)
    if include_session_private:
        root = _document_private_session_root(session)
        if root is not None and str(root) not in seen:
            roots.append(root)
    return roots


def _resolve_document_path(
    value: str,
    session: StudioSession,
    *,
    must_exist: bool,
    include_session_private: bool = False,
) -> Path:
    """Resolve a document path only inside writable workspace/private roots."""

    raw = Path(str(value or "").strip()).expanduser()
    if not str(raw).strip():
        raise ValueError("document path is required")
    roots = _document_allowed_roots(
        session,
        include_session_private=include_session_private,
    )
    if not roots:
        raise ValueError("no authorized document workspace is configured")
    candidates = [raw] if raw.is_absolute() else [root / raw for root in roots]
    for candidate in candidates:
        try:
            if _path_has_unsafe_symlink_component(candidate):
                continue
            resolved = _safe_resolve_path(candidate)
            if _is_protected_path(resolved):
                continue
            if _is_private_runtime_document_path(resolved, session):
                continue
            if not any(_is_path_under_root(resolved, root) for root in roots):
                continue
            if must_exist and (not resolved.exists() or not resolved.is_file()):
                continue
            if resolved.is_symlink():
                continue
            return resolved
        except (OSError, RuntimeError, ValueError):
            continue
    if raw.is_absolute():
        shown = str(raw)
    else:
        shown = str(raw)
    raise ValueError(f"document path is outside authorized writable roots or unavailable: {shown}")


def _document_current_manifest(session: StudioSession) -> Optional[dict[str, Any]]:
    private = _document_private_root(session)
    if private is None:
        return None
    path = private / "checkpoint" / "manifest.json"
    try:
        if path.is_symlink() or _path_has_unsafe_symlink_component(path):
            return None
        if path.stat().st_size > 4 * 1024 * 1024:
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
        return None
    return dict(raw) if isinstance(raw, dict) else None


def _document_registration(
    session: StudioSession,
    path: Path,
) -> Optional[dict[str, Any]]:
    """Find exact same-session publication metadata, including after restart."""

    sid = _bash_bg_session_id(session)
    if sid == "default":
        return None
    try:
        from agenticx.runtime.private_workspace import private_sessions_root
        from agenticx.runtime.turn_lifecycle import TurnLifecycleStore

        private_root = _document_private_root(session)
        root = private_sessions_root(private_root.parents[2]) if private_root is not None else private_sessions_root()
        store = TurnLifecycleStore(root)
        return store.find_registered_document(sid, path, session=session)
    except (OSError, RuntimeError, ValueError, TypeError):
        return None


def _document_replacement_context(
    session: StudioSession,
    new_path: Path,
    raw_replaces_path: Any,
) -> tuple[Optional[Path], Optional[dict[str, Any]], Optional[str]]:
    """Validate exact lineage and current-turn rollback coverage.

    A missing/ambiguous lineage is intentionally a non-destructive outcome:
    callers may still publish the new path, but receive a concrete warning to
    provide the exact registered source path on a retry.
    """

    raw = str(raw_replaces_path or "").strip()
    if not raw:
        return None, None, None
    try:
        old_path = _resolve_document_path(
            raw,
            session,
            must_exist=True,
            include_session_private=True,
        )
    except ValueError:
        return None, None, (
            "document lineage is ambiguous; publish succeeded as an additional artifact. "
            "Provide the exact path of a previously published document in this session as replaces_path."
        )
    if not is_supported_document_path(old_path):
        return None, None, (
            "document lineage source must be a registered md/html/doc/docx document; "
            "publish succeeded as an additional artifact."
        )
    registration = _document_registration(session, old_path)
    manifest = _document_current_manifest(session)
    if registration is None or manifest is None:
        return None, None, (
            "document lineage is ambiguous; publish succeeded as an additional artifact. "
            "Provide the exact path of a previously published document in this session as replaces_path."
        )
    if str(registration.get("session_id", "") or "").strip() not in {"", _bash_bg_session_id(session)}:
        return None, None, (
            "document lineage belongs to another session; publish succeeded as an additional artifact. "
            "Provide a same-session source path."
        )
    before = manifest.get("before_files")
    record = before.get(str(old_path)) if isinstance(before, Mapping) else None
    if not isinstance(record, Mapping) or not bool(record.get("exists")) or not record.get("snapshot"):
        return None, None, (
            "document lineage source has no recoverable pre-turn snapshot; "
            "publish succeeded as an additional artifact. Provide an explicitly registered source path."
        )
    try:
        from agenticx.runtime.private_workspace import ensure_private_workspace
        from agenticx.runtime.turn_lifecycle import TurnLifecycleStore

        private = ensure_private_workspace(
            _bash_bg_session_id(session),
            str(manifest.get("turn_id", "")),
            root=_document_private_root(session).parents[2],
        )
        TurnLifecycleStore(private.root.parents[2])._validate_snapshot_record(
            str(old_path),
            record,
            private=private,
            field="before_files",
        )
    except (OSError, RuntimeError, ValueError, TypeError, IndexError):
        return None, None, (
            "document lineage source cannot be recovered safely; publish succeeded as an additional artifact. "
            "Provide an explicitly registered source path."
        )
    # A renamed replacement removes the source path.  Require its current
    # bytes to match the publication row before allowing that destructive
    # step; a manual edit since the earlier publication is an ambiguity fence.
    if old_path != new_path:
        expected_sha = str(registration.get("sha256", "") or "").strip().lower()
        expected_size = registration.get("size")
        if expected_sha:
            try:
                current = fingerprint_document(old_path, max_bytes=DOCUMENT_MAX_BYTES)
                size_matches = expected_size is None or int(expected_size) == int(current.get("size", -1))
                if current.get("sha256", "").lower() != expected_sha or not size_matches:
                    return None, None, (
                        "document lineage source changed since its last publication; "
                        "publish succeeded as an additional artifact. Provide the exact current source path."
                    )
            except (DocumentDeliveryError, OSError, TypeError, ValueError, OverflowError):
                return None, None, (
                    "document lineage source could not be revalidated; publish succeeded as an additional artifact. "
                    "Provide the exact current source path."
                )
    if old_path == new_path:
        return old_path, registration, None
    return old_path, registration, None


def _write_document_bytes_atomically(path: Path, data: bytes) -> dict[str, Any]:
    """Write a generated document without exposing a partial file."""

    metadata = fingerprint_bytes(data, max_bytes=DOCUMENT_MAX_BYTES)
    path.parent.mkdir(parents=True, exist_ok=True)
    mode: Optional[int] = None
    try:
        if path.exists() and path.is_file() and not path.is_symlink():
            mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        pass
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=path.suffix or ".tmp",
        dir=str(path.parent),
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            try:
                os.chmod(temp_path, mode)
            except OSError as exc:
                raise DocumentDeliveryError(
                    f"could not preserve document permissions: {path}"
                ) from exc
        os.replace(temp_path, path)
        fsync_directory(path.parent)
        observed = fingerprint_document(path, max_bytes=DOCUMENT_MAX_BYTES)
        if observed.get("size") != metadata.get("size") or observed.get("sha256") != metadata.get("sha256"):
            raise DocumentDeliveryError(f"generated document verification failed: {path}")
        return observed
    finally:
        with contextlib.suppress(FileNotFoundError, OSError):
            temp_path.unlink()


def _document_publication_row(
    session: StudioSession,
    path: Path,
    *,
    title: str,
    source: str,
    metadata: Mapping[str, Any],
    replaced_path: Optional[Path],
    registration: Optional[Mapping[str, Any]],
    warning: Optional[str],
    archive: Optional[Mapping[str, Any]],
) -> dict[str, Any]:
    lineage_id = str(
        (registration or {}).get("lineage_id", "")
        or (registration or {}).get("lineageId", "")
        or uuid.uuid4().hex
    ).strip()
    row: dict[str, Any] = {
        "path": str(path),
        "title": str(title or path.stem).strip()[:500] or path.stem,
        "format": document_format_for_path(path),
        "filename": path.name,
        "mimeType": document_mime_type(path),
        "size": int(metadata.get("size", 0) or 0),
        "sha256": str(metadata.get("sha256", "") or ""),
        # ``outputs`` under the active private turn is a user-visible
        # publication surface.  The path resolver rejects scratch/logs/
        # checkpoint, so published rows must not carry the generic private
        # flag that would make the Desktop hide a valid generated document.
        "private": False,
        "published": True,
        "source": source,
        "lineage_id": lineage_id,
    }
    if replaced_path is not None:
        row["replaces_path"] = str(replaced_path)
        row["superseded_path"] = str(replaced_path)
    if archive is not None:
        row["superseded_sha256"] = str(archive.get("sha256", "") or "")
        row["superseded_size"] = int(archive.get("size", 0) or 0)
        row["superseded_archive_path"] = str(archive.get("archive_path", "") or "")
    if warning:
        row["lineage_ambiguous"] = True
        row["needs_source_path"] = True
        row["warning"] = warning
    return row


def _record_document_publication(
    session: StudioSession,
    row: Mapping[str, Any],
    *,
    content: Optional[str] = None,
    replaced_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Update the explicit publication channel and the in-memory artifact map."""

    path = Path(str(row.get("path", "")))
    artifacts = getattr(session, "artifacts", None)
    if isinstance(artifacts, dict):
        if replaced_path is not None and replaced_path != path:
            artifacts.pop(replaced_path, None)
        # A binary document is represented by an empty marker.  The actual
        # bytes stay on disk and are read only by the preview/download path.
        artifacts[path] = content if isinstance(content, str) else ""
    return append_current_turn_publication(
        session,
        row,
        replaced_path=str(replaced_path) if replaced_path is not None else None,
    )


def _publish_generated_document(
    session: StudioSession,
    path: Path,
    data: bytes,
    *,
    title: str,
    replaces_path: Any = None,
) -> tuple[dict[str, Any], Optional[str]]:
    """Publish renderer bytes with a stage/archive/commit transaction."""

    if not is_supported_document_path(path):
        raise DocumentDeliveryError(f"unsupported document format: {path}")
    if _path_has_unsafe_symlink_component(path) or _is_protected_path(path):
        raise DocumentDeliveryError(f"document output path is unsafe: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    old_path, registration, warning = _document_replacement_context(
        session,
        path,
        replaces_path,
    )
    archive: Optional[dict[str, Any]] = None
    if old_path is None or old_path == path:
        metadata = _write_document_bytes_atomically(path, data)
        row = _document_publication_row(
            session,
            path,
            title=title,
            source="document_generate",
            metadata=metadata,
            replaced_path=old_path,
            registration=registration,
            warning=warning,
            archive=archive,
        )
        return _record_document_publication(
            session,
            row,
            content=data.decode("utf-8", errors="replace"),
            replaced_path=old_path,
        ), warning

    private_root = _document_private_root(session)
    if private_root is None:
        warning = (
            "document lineage is ambiguous because no active private turn archive exists; "
            "publish succeeded as an additional artifact. Provide an exact source path on retry."
        )
        old_path = None
        registration = None
        metadata = _write_document_bytes_atomically(path, data)
        row = _document_publication_row(
            session,
            path,
            title=title,
            source="document_generate",
            metadata=metadata,
            replaced_path=None,
            registration=None,
            warning=warning,
            archive=None,
        )
        return _record_document_publication(
            session,
            row,
            content=data.decode("utf-8", errors="replace"),
            replaced_path=None,
        ), warning

    # Snapshot the in-memory publication channel before beginning the
    # filesystem transaction.  A failed archive/record must not leave a stale
    # card or lineage row pointing at a file that was rolled back.
    artifacts = getattr(session, "artifacts", None)
    artifact_state: dict[Path, tuple[bool, Any]] = {}
    if isinstance(artifacts, dict):
        for key in (old_path, path):
            artifact_state[key] = (key in artifacts, artifacts.get(key))
    pending_present = hasattr(session, "_turn_deliverables")
    pending = getattr(session, "_turn_deliverables", None)
    pending_state = list(pending) if isinstance(pending, list) else []
    registry_present = hasattr(session, "_document_lineage")
    registry = getattr(session, "_document_lineage", None)
    registry_state = dict(registry) if isinstance(registry, dict) else {}

    staged: Optional[Path] = None
    target_backup: Optional[Path] = None
    target_before: Optional[dict[str, Any]] = None
    source_before: Optional[dict[str, Any]] = None
    generated: Optional[dict[str, Any]] = None
    generated_expected: Optional[dict[str, Any]] = None
    target_backup_reserved = False
    target_commit_started = False

    def _same_state(observed: Mapping[str, Any], expected: Mapping[str, Any]) -> bool:
        try:
            return (
                int(observed.get("size", -1)) == int(expected.get("size", -2))
                and str(observed.get("sha256", "")) == str(expected.get("sha256", ""))
                and (
                    expected.get("mode") is None
                    or int(observed.get("mode", -1)) == int(expected.get("mode"))
                )
            )
        except (TypeError, ValueError, OverflowError):
            return False

    def _path_matches(path_value: Path, expected: Mapping[str, Any]) -> bool:
        try:
            return _same_state(
                fingerprint_document(path_value, max_bytes=DOCUMENT_MAX_BYTES),
                expected,
            )
        except (DocumentDeliveryError, OSError, ValueError):
            return False

    def _new_backup_path() -> Path:
        try:
            fd, raw = tempfile.mkstemp(
                prefix=f".{path.name}.backup-",
                suffix=".agenticx-backup",
                dir=str(path.parent),
            )
            os.close(fd)
            candidate = Path(raw)
            candidate.unlink()
            return candidate
        except OSError as exc:
            raise DocumentDeliveryError(f"could not prepare target backup: {path}") from exc

    def _backup_matches_target() -> bool:
        if target_backup is None or target_before is None:
            return True
        try:
            info = target_backup.stat()
            if not stat.S_ISREG(info.st_mode) or target_backup.is_symlink():
                return False
            size = int(info.st_size)
            if size != int(target_before.get("size", -1)) or size > DOCUMENT_MAX_BYTES:
                return False
            digest = hashlib.sha256()
            with target_backup.open("rb") as handle:
                remaining = size
                while remaining:
                    chunk = handle.read(min(64 * 1024, remaining))
                    if not chunk:
                        return False
                    digest.update(chunk)
                    remaining -= len(chunk)
            return (
                digest.hexdigest() == str(target_before.get("sha256", ""))
                and stat.S_IMODE(info.st_mode) == int(target_before.get("mode", -1))
            )
        except (OSError, TypeError, ValueError, OverflowError):
            return False

    def _restore_target_backup() -> None:
        """Restore the pre-existing target only while our bytes still own it."""

        if target_backup is None or not target_backup.exists():
            return
        if _path_has_unsafe_symlink_component(path) or _path_has_unsafe_symlink_component(target_backup):
            raise DocumentDeliveryError(
                f"document target or backup path became unsafe during rollback: {path}"
            )
        if not _backup_matches_target():
            raise DocumentDeliveryError(
                f"original target backup changed during rollback; refusing to restore: {path}"
            )
        owned_target = generated or generated_expected
        if owned_target is not None and path.exists():
            if not _path_matches(path, owned_target):
                # A user/manual write won the race.  Keep the exact original
                # bytes in the private checkpoint rather than overwriting it.
                raise DocumentDeliveryError(
                    f"generated target changed during rollback; refusing to overwrite: {path}"
                )
        elif target_commit_started and not path.exists() and not path.is_symlink():
            # Once our replace succeeded, a missing path means another actor
            # removed it.  Restoring the old target would overwrite that
            # manual deletion, so leave the private backup for recovery.
            raise DocumentDeliveryError(
                f"generated target was removed during rollback; refusing to restore: {path}"
            )
        elif path.exists() or path.is_symlink():
            raise DocumentDeliveryError(
                f"target changed during rollback; refusing to overwrite: {path}"
            )
        try:
            os.replace(target_backup, path)
            fsync_directory(path.parent)
        except OSError as exc:
            raise DocumentDeliveryError(f"could not restore original target: {path}") from exc

    def _remove_generated_target() -> None:
        owned_target = generated or generated_expected
        if not target_commit_started or owned_target is None or not path.exists():
            return
        remove_document_if_unchanged(
            path,
            owned_target,
            max_bytes=DOCUMENT_MAX_BYTES,
        )

    def _restore_old_source() -> None:
        if archive is None:
            return
        archive_path = Path(str(archive.get("archive_path", "") or ""))
        if not archive_path:
            raise DocumentDeliveryError("superseded archive path is missing during rollback")
        expected_old = {
            "size": archive.get("size", 0),
            "sha256": archive.get("sha256", ""),
            "mode": archive.get("mode"),
        }
        restore_archived_document(
            archive_path,
            old_path,
            expected_old,
            max_bytes=DOCUMENT_MAX_BYTES,
        )
        remove_document_if_unchanged(
            archive_path,
            expected_old,
            max_bytes=DOCUMENT_MAX_BYTES,
        )

    def _quarantine_target_backup() -> None:
        """Keep an un-restorable exact backup inside the private checkpoint."""

        if target_backup is None or not target_backup.exists():
            return
        backup_dir = private_root / "checkpoint" / "target-backups"
        if _path_has_unsafe_symlink_component(backup_dir):
            raise DocumentDeliveryError(f"target backup directory is unsafe: {backup_dir}")
        try:
            backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(backup_dir, 0o700)
            retained = backup_dir / f"{uuid.uuid4().hex}.agenticx-backup"
            os.replace(target_backup, retained)
            fsync_directory(backup_dir)
            fsync_directory(path.parent)
        except OSError as exc:
            raise DocumentDeliveryError(
                f"could not retain original target backup privately: {backup_dir}"
            ) from exc

    def _restore_publication_state() -> None:
        if isinstance(artifacts, dict):
            for key, (was_present, value) in artifact_state.items():
                if was_present:
                    artifacts[key] = value
                else:
                    artifacts.pop(key, None)
        if pending_present:
            if isinstance(getattr(session, "_turn_deliverables", None), list):
                session._turn_deliverables[:] = pending_state
            else:
                setattr(session, "_turn_deliverables", list(pending_state))
        elif hasattr(session, "_turn_deliverables"):
            try:
                delattr(session, "_turn_deliverables")
            except AttributeError:
                pass
        if registry_present:
            setattr(session, "_document_lineage", dict(registry_state))
        elif hasattr(session, "_document_lineage"):
            try:
                delattr(session, "_document_lineage")
            except AttributeError:
                pass

    try:
        expected = fingerprint_bytes(data, max_bytes=DOCUMENT_MAX_BYTES)
        source_before = fingerprint_document(old_path, max_bytes=DOCUMENT_MAX_BYTES)
        target_exists = path.exists() or path.is_symlink()
        if target_exists:
            if path.is_symlink():
                raise DocumentDeliveryError(f"document output path is unsafe: {path}")
            target_before = fingerprint_document(path, max_bytes=DOCUMENT_MAX_BYTES)

        fd, temp_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=path.suffix or ".tmp",
            dir=str(path.parent),
        )
        staged = Path(temp_name)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if target_before is not None and target_before.get("mode") is not None:
            try:
                os.chmod(staged, stat.S_IMODE(int(target_before["mode"])))
            except OSError as exc:
                raise DocumentDeliveryError(
                    f"could not preserve document target permissions: {path}"
                ) from exc
        staged_meta = fingerprint_document(staged, max_bytes=DOCUMENT_MAX_BYTES)
        if not _same_state(staged_meta, expected):
            raise DocumentDeliveryError(f"generated document verification failed: {path}")
        generated_expected = {
            **expected,
            "mode": staged_meta.get("mode"),
        }

        if target_before is not None:
            # Re-fingerprint immediately before moving the old target away;
            # this prevents a manual edit between the initial check and the
            # transaction from being silently hidden in the backup.
            current_before = fingerprint_document(path, max_bytes=DOCUMENT_MAX_BYTES)
            if not _same_state(current_before, target_before):
                raise DocumentDeliveryError(
                    f"document target changed before publication; refusing to overwrite: {path}"
                )
            target_backup = _new_backup_path()
            os.replace(path, target_backup)
            target_backup_reserved = True
            fsync_directory(path.parent)
        elif path.exists() or path.is_symlink():
            raise DocumentDeliveryError(
                f"document target appeared during publication; refusing to overwrite: {path}"
            )

        os.replace(staged, path)
        target_commit_started = True
        staged = None
        fsync_directory(path.parent)
        generated = fingerprint_document(path, max_bytes=DOCUMENT_MAX_BYTES)
        if not _same_state(generated, expected):
            raise DocumentDeliveryError(f"generated document verification failed: {path}")

        current_source = fingerprint_document(old_path, max_bytes=DOCUMENT_MAX_BYTES)
        if source_before is not None and not _same_state(current_source, source_before):
            raise DocumentDeliveryError(
                f"document source changed during publication; refusing to archive: {old_path}"
            )
        archive = archive_superseded_document(
            old_path,
            private_root / "checkpoint",
            max_bytes=DOCUMENT_MAX_BYTES,
        )
        row = _document_publication_row(
            session,
            path,
            title=title,
            source="document_generate",
            metadata=generated,
            replaced_path=old_path,
            registration=registration,
            warning=warning,
            archive=archive,
        )
        clean = _record_document_publication(
            session,
            row,
            content=data.decode("utf-8", errors="replace"),
            replaced_path=old_path,
        )
        if target_backup is not None and target_backup.exists():
            # The target directory was synced after both the backup move and
            # generated-file install.  The backup is private, so do not turn
            # a best-effort cleanup sync into a publication failure after the
            # durable user-visible state has already committed.
            target_backup.unlink()
        return clean, warning
    except Exception as exc:
        rollback_errors: list[str] = []
        # Restore the old source first when archive_superseded_document already
        # removed it.  It refuses to overwrite a manual change at old_path.
        try:
            _restore_old_source()
        except Exception as rollback_exc:
            rollback_errors.append(str(rollback_exc))
        try:
            if generated is not None:
                if target_backup is None:
                    _remove_generated_target()
                else:
                    _restore_target_backup()
            elif target_backup_reserved:
                _restore_target_backup()
        except Exception as rollback_exc:
            rollback_errors.append(str(rollback_exc))
        if target_backup is not None and target_backup.exists():
            try:
                _quarantine_target_backup()
            except Exception as quarantine_exc:
                rollback_errors.append(str(quarantine_exc))
        _restore_publication_state()
        if rollback_errors:
            raise DocumentDeliveryError(
                f"document publication failed: {exc}; rollback incomplete: {'; '.join(rollback_errors)}"
            ) from exc
        if isinstance(exc, OSError):
            raise DocumentDeliveryError(f"document publication failed: {exc}") from exc
        raise
    finally:
        if staged is not None:
            with contextlib.suppress(FileNotFoundError, OSError):
                staged.unlink()


async def _tool_document_publish(
    arguments: Dict[str, Any],
    session: StudioSession,
) -> str:
    """Register an existing document and archive an explicitly replaced row."""

    try:
        path = _resolve_document_path(
            str(arguments.get("path", "") or ""),
            session,
            must_exist=True,
        )
        if not is_supported_document_path(path):
            raise DocumentDeliveryError(
                "document_publish supports only md, markdown, html, htm, doc, and docx files"
            )
        metadata = fingerprint_document(path, max_bytes=DOCUMENT_MAX_BYTES)
        old_path, registration, warning = _document_replacement_context(
            session,
            path,
            arguments.get("replaces_path"),
        )
        archive: Optional[dict[str, Any]] = None
        if old_path is not None and old_path != path:
            private_root = _document_private_root(session)
            if private_root is None:
                warning = (
                    "document lineage is ambiguous because no active private turn archive exists; "
                    "publish succeeded as an additional artifact. Provide an exact source path on retry."
                )
                old_path = None
                registration = None
            else:
                archive = archive_superseded_document(
                    old_path,
                    private_root / "checkpoint",
                    max_bytes=DOCUMENT_MAX_BYTES,
                )
        title = str(arguments.get("title", "") or path.stem).strip()[:500] or path.stem
        try:
            row = _document_publication_row(
                session,
                path,
                title=title,
                source="document_publish",
                metadata=metadata,
                replaced_path=old_path,
                registration=registration,
                warning=warning,
                archive=archive,
            )
            clean = _record_document_publication(
                session,
                row,
                replaced_path=old_path,
            )
        except Exception:
            if archive is not None and old_path is not None:
                expected_old = {
                    "size": archive.get("size", 0),
                    "sha256": archive.get("sha256", ""),
                    "mode": archive.get("mode"),
                }
                try:
                    restore_archived_document(
                        archive["archive_path"],
                        old_path,
                        expected_old,
                        max_bytes=DOCUMENT_MAX_BYTES,
                    )
                    remove_document_if_unchanged(
                        archive["archive_path"],
                        expected_old,
                        max_bytes=DOCUMENT_MAX_BYTES,
                    )
                except Exception as rollback_exc:
                    raise DocumentDeliveryError(
                        f"document publication record failed and rollback was incomplete: {rollback_exc}"
                    ) from rollback_exc
            raise
        # Do not read a binary document into the artifact map or tool result.
        return json.dumps(
            {
                "ok": True,
                "path": clean["path"],
                "title": clean["title"],
                "format": clean["format"],
                "filename": clean["filename"],
                "mimeType": clean["mimeType"],
                "size": clean["size"],
                "sha256": clean["sha256"],
                "private": clean.get("private", False),
                "published": clean.get("published", True),
                "lineage_id": clean.get("lineage_id", ""),
                **(
                    {
                        "replaces_path": clean["replaces_path"],
                        "superseded_path": clean["superseded_path"],
                        "superseded_sha256": clean.get("superseded_sha256", ""),
                        "superseded_size": clean.get("superseded_size", 0),
                        "superseded_archive_path": clean.get("superseded_archive_path", ""),
                    }
                    if clean.get("replaces_path")
                    else {}
                ),
                **(
                    {
                        "lineage_ambiguous": True,
                        "needs_source_path": True,
                        "warning": clean["warning"],
                    }
                    if clean.get("lineage_ambiguous")
                    else {}
                ),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except (DocumentDeliveryError, ValueError, OSError) as exc:
        return f"ERROR: document_publish failed: {exc}"


async def _tool_document_generate(
    arguments: Dict[str, Any],
    session: StudioSession,
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> str:
    """Render a final document through the authenticated local Electron host."""

    document_format = str(arguments.get("format", "") or "").strip().lower()
    title = str(arguments.get("title", "") or "").strip()
    markdown = str(arguments.get("markdown", "") or "")
    try:
        filename, mime_type, content = await render_document_via_local_renderer(
            document_format,
            title,
            markdown,
        )
    except ValueError as exc:
        return f"ERROR: {exc}"
    content_bytes = content.encode("utf-8")
    allowed_suffixes = {
        "md": frozenset({".md", ".markdown"}),
        "html": frozenset({".html", ".htm"}),
        "doc": frozenset({".doc"}),
    }

    output_path_raw = str(arguments.get("output_path", "") or "").strip()
    is_private_output = not output_path_raw
    if output_path_raw:
        try:
            output_path = _resolve_workspace_path(output_path_raw, session, for_write=True)
        except ValueError as exc:
            return f"ERROR: invalid output_path: {exc}"
        if _is_protected_path(output_path):
            return f"ERROR: output_path is protected: {output_path}"
        if output_path.suffix.lower() not in allowed_suffixes[document_format]:
            expected = ", ".join(sorted(allowed_suffixes[document_format]))
            return f"ERROR: output_path extension must match format '{document_format}' ({expected})"
        if not _path_allowed_without_confirm(output_path) and not await _confirm(
            f"Write generated document to {output_path}?",
            confirm_gate=confirm_gate,
            context={
                "tool": "document_generate",
                "path": str(output_path),
                "format": document_format,
                "title": title,
                "content_chars": len(content),
                "risk": "low",
            },
            emit_event=emit_event,
        ):
            return _cancelled("生成文档未写入", confirm_gate)
    else:
        private_root = str(getattr(session, "_private_workspace_root", "") or "").strip()
        if private_root:
            # Re-open the path through the same validated private workspace
            # helper used by the turn lease.  A plain ``resolve()/mkdir`` here
            # would follow a replaced symlink and turn a private output into a
            # write outside the session root.
            sid = _bash_bg_session_id(session)
            turn_id = str(getattr(session, "_active_turn_id", "") or "").strip()
            try:
                from agenticx.runtime.private_workspace import ensure_private_workspace

                private_hint = Path(private_root).expanduser()
                if not private_hint.is_absolute():
                    private_hint = Path.cwd() / private_hint
                private_hint = Path(os.path.abspath(os.fspath(private_hint)))
                if _path_has_unsafe_symlink_component(private_hint):
                    raise ValueError("active private workspace contains a symlink")
                private_base = private_hint.parents[2]
                private = ensure_private_workspace(sid, turn_id, root=private_base)
                if private.root.resolve(strict=False) != private_hint.resolve(strict=False):
                    raise ValueError("active private workspace does not match turn identity")
                output_dir = private.outputs
            except (IndexError, OSError, RuntimeError, ValueError) as exc:
                return f"ERROR: invalid private output workspace: {exc}"
        else:
            # Direct CLI/test sessions may not have an active server turn. Keep
            # that fallback private as well, while managed turns always use the
            # turn-specific outputs directory above.
            sid = _bash_bg_session_id(session)
            if sid != "default":
                from agenticx.runtime.private_workspace import session_private_execution_root

                output_dir = session_private_execution_root(sid) / "outputs"
            else:
                # A direct, unmanaged CLI session has no session identity. Use
                # one private directory per invocation rather than a shared
                # /tmp target whose contents could be mixed across requests.
                output_dir = Path(tempfile.mkdtemp(prefix="agenticx-document-output-"))
                try:
                    output_dir.chmod(0o700)
                except OSError:
                    pass
        if _path_has_unsafe_symlink_component(output_dir):
            return "ERROR: invalid private output workspace: output directory contains a symlink"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / filename

    try:
        clean, warning = _publish_generated_document(
            session,
            output_path,
            content_bytes,
            title=title,
            replaces_path=arguments.get("replaces_path"),
        )
    except (DocumentDeliveryError, ValueError, OSError) as exc:
        return f"ERROR: failed to publish generated document: {exc}"
    if not is_private_output and isinstance(getattr(session, "scratchpad", None), dict):
        session.scratchpad["__taskspace_hint__"] = str(output_path)
    # Keep the tool result machine-readable so the Desktop artifact collector
    # can register the actual generated path without scraping prose.  The
    # document body remains available from the registered artifact/file.
    payload: dict[str, Any] = {
        "ok": True,
        "path": clean["path"],
        "title": clean["title"],
        "format": clean["format"],
        "filename": clean["filename"],
        "mimeType": clean["mimeType"],
        "size": clean["size"],
        "sha256": clean["sha256"],
        "private": clean.get("private", False),
        "published": clean.get("published", True),
        "lineage_id": clean.get("lineage_id", ""),
        "content_chars": len(content),
    }
    if clean.get("replaces_path"):
        payload.update(
            {
                "replaces_path": clean["replaces_path"],
                "superseded_path": clean["superseded_path"],
                "superseded_sha256": clean.get("superseded_sha256", ""),
                "superseded_size": clean.get("superseded_size", 0),
                "superseded_archive_path": clean.get("superseded_archive_path", ""),
            }
        )
    if clean.get("lineage_ambiguous"):
        payload.update(
            {
                "lineage_ambiguous": True,
                "needs_source_path": True,
                "warning": clean.get("warning") or warning or "",
            }
        )
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    )


async def _tool_file_edit(
    arguments: Dict[str, Any],
    session: Optional[StudioSession] = None,
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> str:
    try:
        # for_write=True: reference mounts are read-only and must not be editable.
        path = _resolve_workspace_path(
            str(arguments.get("path", "")),
            session,
            pick_existing=True,
            for_write=True,
        )
    except ValueError as exc:
        return f"ERROR: {exc}"
    if _is_protected_path(path):
        return (
            "ERROR: edits to protected paths are blocked for safety "
            "(e.g. $AGX_HOME/config.yaml, ~/.ssh). "
            "Use update_email_config meta tool for notifications.email.* updates."
        )
    old_text_snippet = str(arguments.get("old_text", ""))
    new_text_snippet = _strip_tool_metadata_noise_lines(str(arguments.get("new_text", "")))
    occurrence = int(arguments.get("occurrence", 1) or 1)
    if old_text_snippet == "":
        return "ERROR: old_text cannot be empty"
    if occurrence < 1:
        return "ERROR: occurrence must be >= 1"
    if not path.exists() or not path.is_file():
        return f"ERROR: file not found: {path}"

    tracker = getattr(session, "file_state_tracker", None) if session is not None else None
    if tracker is not None:
        stale = tracker.check_staleness(str(path))
        if stale:
            return stale

    try:
        old_text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"ERROR: read failed: {exc}"
    if old_text_snippet not in old_text:
        return "ERROR: old_text not found in file"

    start_idx = -1
    cursor = 0
    for _ in range(occurrence):
        start_idx = old_text.find(old_text_snippet, cursor)
        if start_idx < 0:
            return f"ERROR: old_text occurrence {occurrence} not found"
        cursor = start_idx + len(old_text_snippet)

    end_idx = start_idx + len(old_text_snippet)
    updated_text = old_text[:start_idx] + new_text_snippet + old_text[end_idx:]

    diff = _format_diff(path, old_text, updated_text)
    # 用户在 permissions.path_rules 里对这条路径写了 allow，就不再逐次弹框
    # （等价于 Claude Code 的 Edit(src/**) 允许规则）。它不放开沙箱。
    if not _path_allowed_without_confirm(path) and not await _confirm(
        f"Apply edit to {path}?",
        confirm_gate=confirm_gate,
        context={"tool": "file_edit", "path": str(path), "diff": diff, "risk": "low"},
        emit_event=emit_event,
    ):
        return _cancelled("文件未修改", confirm_gate)

    try:
        path.write_text(updated_text, encoding="utf-8")
    except OSError as exc:
        return f"ERROR: write failed: {exc}"
    result = _autoheal_skill_md_after_write(path, f"OK: edited {path}")
    if tracker is not None:
        tracker.refresh_from_disk(str(path))
    return result


async def _tool_codegen(
    arguments: Dict[str, Any],
    session: StudioSession,
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> str:
    description = str(arguments.get("description", "")).strip()
    if not description:
        return "ERROR: description is required"
    target = str(arguments.get("target") or _detect_target(description)).strip().lower()

    try:
        llm = ProviderResolver.resolve(
            provider_name=session.provider_name,
            model=session.model_name,
        )
    except Exception as exc:
        return f"ERROR: cannot resolve provider: {exc}"

    try:
        engine = CodeGenEngine(llm)
        generated = engine.generate(target=target, description=description, context={"reference_files": dict(session.context_files)})
    except Exception as exc:
        return f"ERROR: code generation failed: {exc}"

    output_path_raw = str(arguments.get("output_path", "")).strip()
    if output_path_raw:
        try:
            output_path = _resolve_workspace_path(output_path_raw, session)
        except ValueError as exc:
            return f"ERROR: invalid output_path: {exc}"
    else:
        # If user did not explicitly provide output directory/path, require confirmation
        # on the inferred destination to prevent writing to unexpected locations.
        inferred = infer_output_path(target=target, description=description)
        try:
            output_path = _resolve_workspace_path(str(inferred), session)
        except ValueError as exc:
            return f"ERROR: inferred output path invalid: {exc}"
        should_confirm = confirm_gate.is_service_mode() or sys.stdin.isatty()
        if should_confirm and not await _confirm(
            (
                "未检测到你显式指定落盘目录。"
                f"建议写入：{output_path}。是否确认按该路径生成？"
            ),
            confirm_gate=confirm_gate,
            context={"tool": "codegen", "path": str(output_path), "target": target, "risk": "low"},
            emit_event=emit_event,
        ):
            return (
                _cancelled("推断的落盘路径未获批准", confirm_gate)
                + " Please provide output_path explicitly, e.g. "
                '{"target":"agent","description":"...","output_path":"./docs/xxx.md"}'
            )
    try:
        write_generated_file(output_path, generated.code)
    except Exception as exc:
        return f"ERROR: failed to write generated file: {exc}"
    if not output_path.exists() or not output_path.is_file():
        return f"ERROR: write returned but output missing on disk: {output_path}"

    session.artifacts[output_path] = generated.code
    try:
        from agenticx.cli.studio import HistoryRecord

        session.history.append(HistoryRecord(description=description, file_path=output_path, target=target))
    except Exception:
        pass
    return f"OK: generated {output_path.resolve()}"


def _tool_mcp_connect(arguments: Dict[str, Any], session: StudioSession) -> str:
    name = str(arguments.get("name", "")).strip()
    if not name:
        return "ERROR: missing server name"

    ok, detail = mcp_connect(session.mcp_hub, session.mcp_configs, session.connected_servers, name)
    if ok:
        return "OK"
    d = (detail or "").strip()
    return f"ERROR: connect failed: {d}" if d else "ERROR: connect failed"


def _find_git_root_for_cc_bridge(start: Path, *, max_up: int = 48) -> Optional[Path]:
    """Walk upward from start looking for a `.git` directory."""
    cur = start
    for _ in range(max_up):
        try:
            if (cur / ".git").exists():
                return cur
        except OSError:
            break
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return None


def _session_default_cwd_for_cc_bridge(session: StudioSession) -> str:
    w = str(getattr(session, "workspace_dir", "") or "").strip()
    if w:
        base = Path(w).expanduser().resolve(strict=False)
        git_root = _find_git_root_for_cc_bridge(base)
        if git_root is not None:
            return str(git_root)
        return str(base)
    return str(Path.cwd().resolve(strict=False))


def _cc_bridge_is_loopback_base(base_url: str) -> tuple[bool, str, int]:
    """Parse bridge URL and return (is_loopback, host, port)."""
    try:
        parsed = urlparse(base_url)
    except ValueError:
        return (False, "127.0.0.1", 9742)
    host = (parsed.hostname or "").strip().lower()
    port = int(parsed.port or 9742)
    is_loopback = host in {"127.0.0.1", "localhost", "::1", "[::1]"}
    return (is_loopback, host or "127.0.0.1", port)


def _cc_bridge_http_client_kwargs(base_url: str, timeout_sec: float) -> Dict[str, Any]:
    """Build httpx client kwargs; bypass env proxies for localhost bridge calls."""
    kwargs: Dict[str, Any] = {"timeout": timeout_sec}
    is_loopback, _host, _port = _cc_bridge_is_loopback_base(base_url)
    if is_loopback:
        # Avoid SOCKS/HTTP proxy hijacking localhost requests (common source of bridge 502).
        kwargs["transport"] = __import__("httpx").AsyncHTTPTransport()
        kwargs["trust_env"] = False
    return kwargs


def _cc_bridge_proc_running() -> bool:
    global _CC_BRIDGE_AUTO_PROC
    return _CC_BRIDGE_AUTO_PROC is not None and _CC_BRIDGE_AUTO_PROC.poll() is None


def _cc_bridge_idle_stop_seconds() -> int:
    """Idle timeout for auto-started local bridge (0 disables auto-stop)."""
    raw = os.getenv("AGX_CC_BRIDGE_IDLE_STOP_SECONDS", "").strip()
    if not raw:
        try:
            cfg = ConfigManager.get_value("cc_bridge.idle_stop_seconds")
        except Exception:
            cfg = None
        if cfg is not None:
            raw = str(cfg).strip()
    if not raw:
        return 600
    try:
        v = int(raw)
    except ValueError:
        return 600
    return max(0, min(86400, v))


async def _cc_bridge_has_active_sessions(base_url: str, token: str) -> bool:
    try:
        import httpx
    except ImportError:
        return True
    try:
        async with httpx.AsyncClient(**_cc_bridge_http_client_kwargs(base_url, 5.0)) as client:
            r = await client.get(
                f"{base_url}/v1/sessions",
                headers={"Authorization": f"Bearer {token}"},
            )
    except Exception:
        return True
    if r.status_code != 200:
        return True
    try:
        body = r.json()
    except Exception:
        return True
    sessions = body.get("sessions")
    return isinstance(sessions, list) and len(sessions) > 0


async def _cc_bridge_idle_reaper(base_url: str, token: str, idle_sec: int) -> None:
    global _CC_BRIDGE_AUTO_PROC
    global _CC_BRIDGE_LAST_ACTIVE_MONO
    if idle_sec <= 0:
        return
    await asyncio.sleep(float(idle_sec))
    if not _cc_bridge_proc_running():
        return
    if (time.monotonic() - _CC_BRIDGE_LAST_ACTIVE_MONO) < float(idle_sec):
        return
    if await _cc_bridge_has_active_sessions(base_url, token):
        return
    proc = _CC_BRIDGE_AUTO_PROC
    if proc is None:
        return
    try:
        proc.terminate()
        try:
            await asyncio.to_thread(proc.wait, 3)
        except Exception:
            proc.kill()
    except Exception:
        pass
    _CC_BRIDGE_AUTO_PROC = None


def _touch_cc_bridge_activity(base_url: str, token: str) -> None:
    global _CC_BRIDGE_IDLE_TASK
    global _CC_BRIDGE_LAST_ACTIVE_MONO
    if not _cc_bridge_proc_running():
        return
    idle_sec = _cc_bridge_idle_stop_seconds()
    if idle_sec <= 0:
        return
    _CC_BRIDGE_LAST_ACTIVE_MONO = time.monotonic()
    if _CC_BRIDGE_IDLE_TASK is not None and not _CC_BRIDGE_IDLE_TASK.done():
        _CC_BRIDGE_IDLE_TASK.cancel()
    _CC_BRIDGE_IDLE_TASK = asyncio.create_task(
        _cc_bridge_idle_reaper(base_url, token, idle_sec)
    )


def _ensure_cc_bridge_local_process(base_url: str, token: str) -> tuple[bool, str]:
    """Best-effort lazy autostart for local cc-bridge process."""
    global _CC_BRIDGE_AUTO_PROC
    if _cc_bridge_proc_running():
        return (True, "already running")
    is_loopback, host, port = _cc_bridge_is_loopback_base(base_url)
    if not is_loopback:
        return (False, "non-loopback URL; skip autostart")

    visible = os.getenv("AGX_CC_BRIDGE_AUTOSTART_VISIBLE_TERMINAL", "").strip().lower() in {
        "1", "true", "yes", "on"
    }
    if visible and sys.platform == "darwin":
        try:
            agx_path = shutil.which("agx") or "agx"
            cmd = (
                f"export CC_BRIDGE_TOKEN={shlex.quote(token)} AGX_CC_BRIDGE_TOKEN={shlex.quote(token)}; "
                f"if command -v {shlex.quote(agx_path)} >/dev/null 2>&1; then "
                f"{shlex.quote(agx_path)} cc-bridge serve --host {shlex.quote(host)} --port {port}; "
                f"else {shlex.quote(sys.executable)} -m agenticx.cli.main cc-bridge serve "
                f"--host {shlex.quote(host)} --port {port}; fi"
            )
            cmd_escaped = cmd.replace("\\", "\\\\").replace('"', '\\"')
            script = (
                'tell application "Terminal"\n'
                "activate\n"
                f'do script "{cmd_escaped}"\n'
                "end tell\n"
            )
            subprocess.Popen(
                ["osascript", "-e", script],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
                text=True,
            )
            return (True, "started in visible Terminal.app")
        except Exception as exc:
            _log.warning("visible cc-bridge terminal launch failed: %s", exc)

    env = os.environ.copy()
    if token:
        env.setdefault("CC_BRIDGE_TOKEN", token)
        env.setdefault("AGX_CC_BRIDGE_TOKEN", token)

    candidates: list[list[str]] = []
    agx_bin = shutil.which("agx")
    if agx_bin:
        candidates.append([agx_bin, "cc-bridge", "serve", "--host", host, "--port", str(port)])
    candidates.append([sys.executable, "-m", "agenticx.cli.main", "cc-bridge", "serve", "--host", host, "--port", str(port)])

    last_err = "unknown"
    for cmd in candidates:
        try:
            _CC_BRIDGE_AUTO_PROC = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                env=env,
                start_new_session=True,
                text=True,
            )
            return (True, f"started pid={_CC_BRIDGE_AUTO_PROC.pid}")
        except Exception as exc:  # pragma: no cover - platform/env specific
            last_err = str(exc)
            continue
    _CC_BRIDGE_AUTO_PROC = None
    return (False, f"failed to spawn bridge process: {last_err}")


async def _tool_cc_bridge_http(
    session: StudioSession,
    method: str,
    path: str,
    json_body: Optional[Dict[str, Any]] = None,
    *,
    timeout_sec: float = 300.0,
) -> str:
    _ = session
    from agenticx.cc_bridge.settings import (
        cc_bridge_base_url,
        cc_bridge_token,
        validate_bridge_url_for_studio,
    )

    try:
        import httpx
    except ImportError:
        return "ERROR: httpx is required for cc_bridge tools"

    base = cc_bridge_base_url()
    err = validate_bridge_url_for_studio(base)
    if err:
        return f"ERROR: {err}"
    token = cc_bridge_token()
    headers = {"Authorization": f"Bearer {token}"}
    url = f"{base}{path}"
    client_kwargs = _cc_bridge_http_client_kwargs(base, timeout_sec)

    async def _do_request() -> Any:
        async with httpx.AsyncClient(**client_kwargs) as client:
            m = method.upper()
            if m == "GET":
                return await client.get(url, headers=headers)
            elif m == "POST":
                return await client.post(url, headers=headers, json=json_body)
            elif m == "DELETE":
                return await client.delete(url, headers=headers)
            else:
                return f"ERROR: unsupported HTTP method {method}"
    tried_autostart = False
    try:
        r = await _do_request()
        if isinstance(r, str):
            return r
    except httpx.ConnectError as exc:
        started, detail = _ensure_cc_bridge_local_process(base, token)
        if started:
            tried_autostart = True
            await asyncio.sleep(0.9)
            try:
                r = await _do_request()
                if isinstance(r, str):
                    return r
            except httpx.ConnectError as exc2:
                return (
                    "ERROR: CC bridge not reachable and autostart did not become healthy. "
                    f"Autostart: {detail}. URL: {base}. Details: {exc2}"
                )
            except httpx.TimeoutException as exc2:
                return f"ERROR: CC bridge autostart succeeded but HTTP timed out: {exc2}"
            except httpx.HTTPError as exc2:
                return f"ERROR: bridge HTTP failed after autostart: {exc2}"
        else:
            return (
                "ERROR: CC bridge not reachable (connection refused). "
                f"Autostart skipped/failed: {detail}. "
                "You can still start manually: agx cc-bridge serve "
                f"(expects {base}). Details: {exc}"
            )
    except httpx.TimeoutException as exc:
        return f"ERROR: CC bridge HTTP timed out: {exc}"
    except httpx.HTTPError as exc:
        return f"ERROR: bridge HTTP failed: {exc}"
    # Bridge may be reachable but unhealthy (e.g., stale process / boot race / reverse proxy 5xx).
    if r.status_code >= 500:
        started, detail = _ensure_cc_bridge_local_process(base, token)
        if started:
            tried_autostart = True
            await asyncio.sleep(0.9)
            try:
                r2 = await _do_request()
                if isinstance(r2, str):
                    return r2
                r = r2
            except httpx.HTTPError as exc:
                return f"ERROR: bridge HTTP failed after 5xx recovery: {exc}"
            except Exception as exc:
                return f"ERROR: bridge 5xx recovery failed: {exc}"
        if r.status_code >= 500:
            # one-shot lightweight diagnostics for clearer operator message
            health_hint = ""
            try:
                async with httpx.AsyncClient(**_cc_bridge_http_client_kwargs(base, 5.0)) as client:
                    hr = await client.get(f"{base}/health")
                    health_hint = f"health={hr.status_code}"
            except Exception:
                health_hint = "health=unreachable"
            body = (r.text or "").strip()
            if not body:
                body = "<empty>"
            return (
                f"ERROR: bridge {r.status_code}: {body[:400]} "
                f"(diag: {health_hint}, autostart={detail})"
            )
    text = r.text
    if r.status_code in (401, 403):
        return (
            f"ERROR: CC bridge auth rejected (HTTP {r.status_code}). "
            "Use the same token on the bridge as in $AGX_HOME/config.yaml (cc_bridge.token) "
            f"or set matching CC_BRIDGE_TOKEN / AGX_CC_BRIDGE_TOKEN. Body: {text[:800]}"
        )
    if r.status_code >= 400:
        return f"ERROR: bridge {r.status_code}: {text[:2000]}"
    _touch_cc_bridge_activity(base, token)
    if tried_autostart:
        return f"{text}\n\n[cc-bridge] autostarted in background."
    return text


async def _tool_cc_bridge_start(arguments: Dict[str, Any], session: StudioSession) -> str:
    from agenticx.cc_bridge.settings import cc_bridge_mode, cc_bridge_mode_configured

    explicit_mode = str(arguments.get("mode", "") or "").strip().lower()
    if explicit_mode not in {"", "headless", "visible_tui"}:
        return "ERROR: mode must be one of: headless, visible_tui"

    def _latest_user_intent() -> str:
        hist = getattr(session, "chat_history", None) or []
        for msg in reversed(hist):
            if str(msg.get("role", "")) == "user":
                return str(msg.get("content", "") or "")
        return ""

    def _choose_mode(config_mode: str, configured_mode: str | None) -> str:
        if explicit_mode in {"headless", "visible_tui"}:
            return explicit_mode
        sid = str(getattr(session, "session_id", "") or "").strip().lower()
        if sid.startswith("im-"):
            return "headless"
        # Respect explicit user config from Settings first; only auto-infer when
        # no persisted mode is set.
        if configured_mode in {"headless", "visible_tui"}:
            return configured_mode
        intent = _latest_user_intent().lower()
        interactive_hints = (
            "visible_tui",
            "visible tui",
            "可见",
            "交互",
            "终端",
            "手动",
            "按键",
            "点击确认",
            "在cc里",
        )
        autonomous_hints = (
            "自动",
            "直接给我结果",
            "报告",
            "摘要",
            "总结",
            "分析",
            "不要改代码",
            "无需交互",
            "无需确认",
            "session_id +",
        )
        if any(k in intent for k in interactive_hints):
            return "visible_tui"
        if any(k in intent for k in autonomous_hints):
            return "headless"
        return config_mode

    cwd = str(arguments.get("cwd", "") or "").strip()
    if not cwd:
        cwd = _session_default_cwd_for_cc_bridge(session)
    auto = bool(arguments.get("auto_allow_permissions", False))
    resolved_mode = _choose_mode(cc_bridge_mode(), cc_bridge_mode_configured())
    return await _tool_cc_bridge_http(
        session,
        "POST",
        "/v1/sessions",
        {"cwd": cwd, "auto_allow_permissions": auto, "mode": resolved_mode},
        timeout_sec=60.0,
    )


async def _cc_bridge_resolve_session_mode(session: StudioSession, sid: str) -> Tuple[Optional[str], str]:
    """Resolve headless|visible_tui for sid via GET /v1/sessions/{id}, then list fallback.

    Returns (mode, ""). If session is missing, (None, error_text).
    """
    from agenticx.cc_bridge.settings import (
        cc_bridge_base_url,
        cc_bridge_mode,
        cc_bridge_token,
        validate_bridge_url_for_studio,
    )

    try:
        import httpx
    except ImportError:
        return (None, "ERROR: httpx is required for cc_bridge tools")

    detail = await _tool_cc_bridge_http(
        session, "GET", f"/v1/sessions/{sid}", None, timeout_sec=15.0
    )
    if not detail.startswith("ERROR:"):
        try:
            obj = json.loads(detail)
            if isinstance(obj, dict):
                mv = str(obj.get("mode", "")).strip().lower()
                if mv in {"headless", "visible_tui"}:
                    return (mv, "")
        except Exception:
            pass
    else:
        err = detail
        if "session not found" in err.lower():
            return (None, err)

    resolved_mode = str(cc_bridge_mode() or "headless").strip().lower()
    if resolved_mode not in {"headless", "visible_tui"}:
        resolved_mode = "headless"

    base = cc_bridge_base_url()
    err = validate_bridge_url_for_studio(base)
    if not err:
        token = cc_bridge_token()
        headers = {"Authorization": f"Bearer {token}"}
        list_url = f"{base}/v1/sessions"
        try:
            async with httpx.AsyncClient(**_cc_bridge_http_client_kwargs(base, 15.0)) as client:
                r = await client.get(list_url, headers=headers)
            if r.status_code < 400:
                payload = r.json() if r.content else {}
                if isinstance(payload, dict):
                    sessions = payload.get("sessions")
                    if isinstance(sessions, list):
                        for item in sessions:
                            if not isinstance(item, dict):
                                continue
                            if str(item.get("session_id", "")).strip() != sid:
                                continue
                            mode_value = str(item.get("mode", "")).strip().lower()
                            if mode_value in {"headless", "visible_tui"}:
                                return (mode_value, "")
                            break
        except Exception:
            pass

    return (resolved_mode, "")


async def _tool_cc_bridge_send(arguments: Dict[str, Any], session: StudioSession) -> str:
    sid = str(arguments.get("session_id", "")).strip()
    prompt = str(arguments.get("prompt", "") or "")
    if not sid or not prompt:
        return "ERROR: session_id and prompt are required"
    wait = arguments.get("wait_seconds", 120.0)
    try:
        wait_f = float(wait)
    except (TypeError, ValueError):
        wait_f = 120.0
    wait_f = max(1.0, min(3600.0, wait_f))

    resolved_mode, resolve_err = await _cc_bridge_resolve_session_mode(session, sid)
    if resolved_mode is None:
        return resolve_err

    async def _post_message() -> str:
        return await _tool_cc_bridge_http(
            session,
            "POST",
            f"/v1/sessions/{sid}/message",
            {"text": prompt, "wait_seconds": wait_f},
            timeout_sec=wait_f + 45.0,
        )

    def _decorate_message_response(resp_text: str, *, mode_corrected: bool) -> str:
        if not mode_corrected:
            return resp_text
        if resp_text.startswith("ERROR:"):
            return resp_text
        try:
            obj = json.loads(resp_text)
            if isinstance(obj, dict):
                obj["mode_corrected"] = True
                return json.dumps(obj, ensure_ascii=False)
        except Exception:
            pass
        return f"{resp_text}\n[cc-bridge] mode_corrected=true"

    if resolved_mode == "visible_tui":
        write_res = await _tool_cc_bridge_http(
            session,
            "POST",
            f"/v1/sessions/{sid}/write",
            {"data": f"{prompt}\r"},
            timeout_sec=30.0,
        )
        if write_res.startswith("ERROR:") and "write is only for visible_tui" in write_res.lower():
            msg_res = await _post_message()
            return _decorate_message_response(msg_res, mode_corrected=True)
        if write_res.startswith("ERROR:"):
            return write_res
        return json.dumps(
            {
                "ok": True,
                "mode": "visible_tui",
                "interactive": True,
                "parsed_response": "",
                "parse_confidence": 0.0,
                "tail": "",
                "status": "sent",
                "final_available": False,
                "evidence_level": "none",
                "must_not_summarize_as_complete": True,
                "message": "Prompt sent to visible TUI terminal",
                "next_action": "wait_for_user_terminal_interaction",
            },
            ensure_ascii=False,
        )

    resp_text = await _post_message()
    if resp_text.startswith("ERROR:"):
        return resp_text
    try:
        obj = json.loads(resp_text)
        if isinstance(obj, dict):
            ok = bool(obj.get("ok", False))
            if not ok:
                obj.setdefault("final_available", False)
                obj.setdefault("evidence_level", "low")
                obj.setdefault("must_not_summarize_as_complete", True)
                obj.setdefault(
                    "message",
                    "No verified final output from cc_bridge_send; report status and next action only.",
                )
                return json.dumps(obj, ensure_ascii=False)
    except Exception:
        pass
    return resp_text


async def _tool_cc_bridge_list(arguments: Dict[str, Any], session: StudioSession) -> str:
    _ = arguments
    return await _tool_cc_bridge_http(session, "GET", "/v1/sessions", None, timeout_sec=30.0)


async def _tool_cc_bridge_stop(arguments: Dict[str, Any], session: StudioSession) -> str:
    from agenticx.cc_bridge.settings import (
        cc_bridge_base_url,
        cc_bridge_token,
        validate_bridge_url_for_studio,
    )

    try:
        import httpx
    except ImportError:
        return "ERROR: httpx is required for cc_bridge tools"

    sid = str(arguments.get("session_id", "") or "").strip()
    force = bool(arguments.get("force", False))
    if not sid:
        return "ERROR: session_id required"
    if not force:
        base = cc_bridge_base_url()
        err = validate_bridge_url_for_studio(base)
        if not err:
            token = cc_bridge_token()
            headers = {"Authorization": f"Bearer {token}"}
            try:
                async with httpx.AsyncClient(**_cc_bridge_http_client_kwargs(base, 10.0)) as client:
                    resp = await client.get(f"{base}/v1/sessions", headers=headers)
                if resp.status_code < 400:
                    payload = resp.json() if resp.content else {}
                    rows = payload.get("sessions") if isinstance(payload, dict) else None
                    if isinstance(rows, list):
                        for row in rows:
                            if not isinstance(row, dict):
                                continue
                            if str(row.get("session_id", "")).strip() != sid:
                                continue
                            mode = str(row.get("mode", "")).strip().lower()
                            poll = row.get("poll")
                            if mode == "visible_tui" and poll is None:
                                return (
                                    "ERROR: visible_tui session is still active; stopping now may lose interactive state. "
                                    "Only stop after user confirms terminal flow is done, or call cc_bridge_stop with force=true."
                                )
                            break
            except Exception:
                pass
    return await _tool_cc_bridge_http(session, "DELETE", f"/v1/sessions/{sid}", None, timeout_sec=30.0)


async def _tool_cc_bridge_permission(arguments: Dict[str, Any], session: StudioSession) -> str:
    sid = str(arguments.get("session_id", "") or "").strip()
    rid = str(arguments.get("request_id", "") or "").strip()
    if not sid or not rid:
        return "ERROR: session_id and request_id are required"
    if "allow" not in arguments:
        return "ERROR: allow is required"
    allow = bool(arguments.get("allow"))
    deny_message = str(arguments.get("deny_message", "") or "Denied by operator")
    body: Dict[str, Any] = {
        "request_id": rid,
        "allow": allow,
        "deny_message": deny_message,
    }
    tuid = arguments.get("tool_use_id")
    if tuid is not None and str(tuid).strip():
        body["tool_use_id"] = str(tuid).strip()
    tin = arguments.get("tool_input")
    if isinstance(tin, dict):
        body["tool_input"] = tin
    return await _tool_cc_bridge_http(
        session,
        "POST",
        f"/v1/sessions/{sid}/permission",
        body,
        timeout_sec=30.0,
    )


_SCREENSHOT_TOOL_NAMES = frozenset({
    "browser_screenshot", "screenshot", "take_screenshot",
    "browser_take_screenshot", "computer_screenshot",
})


def _is_non_vision_model(session: StudioSession) -> bool:
    provider = str(getattr(session, "provider_name", "") or "").strip().lower()
    model = str(getattr(session, "model_name", "") or "").strip().lower()
    if not model:
        return False
    from agenticx.llms.vision import is_vision_capable

    return not is_vision_capable(provider, model)


_SCREENSHOT_NON_VISION_HINT = (
    "\n\n⚠️ 当前模型不支持图片识别，无法查看截图内容。"
    "请改用以下文本工具获取页面信息：\n"
    "- browser_get_state：获取页面 URL、标题和可交互元素列表\n"
    "- browser_extract_content(query='...')：按查询提取页面文本内容\n"
    "- browser_get_html：获取页面 HTML 源码\n"
    "请勿再次调用 browser_screenshot。"
)


_MCP_REPEAT_GUARD_KEY = "__mcp_repeat_guard__"
_MCP_REPEAT_GUARDED_TOOLS = frozenset({"browser_type", "browser_navigate"})


def _mcp_action_signature(tool_name: str, args_obj: Dict[str, Any]) -> str | None:
    if tool_name == "browser_type":
        index = args_obj.get("index")
        text = str(args_obj.get("text", "")).strip()
        if index is None or not text:
            return None
        return f"browser_type::{index}::{text}"
    if tool_name == "browser_navigate":
        url = str(args_obj.get("url", "")).strip()
        if not url:
            return None
        return f"browser_navigate::{url}"
    return None


def _check_mcp_repeat_guard(session: StudioSession, tool_name: str, args_obj: Dict[str, Any]) -> str | None:
    scratchpad = getattr(session, "scratchpad", None)
    if not isinstance(scratchpad, dict):
        session.scratchpad = {}
        scratchpad = session.scratchpad

    if tool_name not in _MCP_REPEAT_GUARDED_TOOLS:
        scratchpad.pop(_MCP_REPEAT_GUARD_KEY, None)
        return None

    sig = _mcp_action_signature(tool_name, args_obj)
    if not sig:
        scratchpad.pop(_MCP_REPEAT_GUARD_KEY, None)
        return None

    raw_state = scratchpad.get(_MCP_REPEAT_GUARD_KEY)
    state = raw_state if isinstance(raw_state, dict) else {}
    prev_sig = str(state.get("sig", "")).strip()
    prev_count = int(state.get("count", 0) or 0)
    count = prev_count + 1 if prev_sig == sig else 1
    scratchpad[_MCP_REPEAT_GUARD_KEY] = {"sig": sig, "count": count}

    if count < 3:
        return None

    if tool_name == "browser_type":
        return (
            "ERROR: repeated browser_type detected (same index/text called >=3 times). "
            "Do not type again. Next action must be one of: "
            "1) browser_click on the search/submit button, or "
            "2) browser_get_state to refresh interactive elements."
        )
    return (
        "ERROR: repeated browser_navigate detected (same url called >=3 times). "
        "Do not navigate again. Next action must be browser_get_state or browser_click."
    )


def _tool_tool_search(
    arguments: Dict[str, Any],
    session: StudioSession,
    *,
    runtime_tool_context: Optional[Any] = None,
) -> str:
    """Run local ToolSearch ranking; schemas load on the next model round."""
    if runtime_tool_context is None:
        return json.dumps(
            {"error": "tool_search unavailable in this context"},
            ensure_ascii=False,
        )
    from agenticx.runtime.tool_search import (
        apply_search,
        dump_state_to_scratchpad,
    )

    query = str((arguments or {}).get("query") or "").strip()
    if not query:
        return json.dumps({"error": "query is required"}, ensure_ascii=False)
    max_results_raw = (arguments or {}).get("max_results", 5)
    try:
        max_results = int(max_results_raw)
    except (TypeError, ValueError):
        max_results = 5
    new_ctx, result = apply_search(
        runtime_tool_context,
        query,
        max_results=max_results,
    )
    # Mutate turn-local context so the next round projection sees loaded ids.
    try:
        runtime_tool_context.state = new_ctx.state
    except Exception:
        pass
    scratchpad = getattr(session, "scratchpad", None)
    if not isinstance(scratchpad, dict):
        scratchpad = {}
        try:
            setattr(session, "scratchpad", scratchpad)
        except Exception:
            pass
    dump_state_to_scratchpad(scratchpad, new_ctx.state)
    return json.dumps(result, ensure_ascii=False)


async def _tool_mcp_call_async(arguments: Dict[str, Any], session: StudioSession) -> str:
    if session.mcp_hub is None:
        return "ERROR: no MCP hub connected"
    tool_name = str(arguments.get("tool_name", "")).strip()
    if not tool_name:
        return "ERROR: missing tool_name"

    raw_args = arguments.get("arguments", None)
    if raw_args is None and "args" in arguments:
        raw_args = arguments.get("args")
    args_obj = raw_args if raw_args is not None else {}
    if not isinstance(args_obj, dict):
        return "ERROR: arguments/args must be an object"

    # Firecrawl scrape is a single-url API. Guard common misuse early.
    if (
        tool_name == "firecrawl_scrape"
        and "url" not in args_obj
        and isinstance(args_obj.get("urls"), list)
    ):
        return (
            "ERROR: firecrawl_scrape expects a single 'url' string, not 'urls' array. "
            "Use: {\"url\":\"https://example.com\"}. "
            "For multiple pages, iterate firecrawl_scrape per URL or use firecrawl_crawl/firecrawl_map."
        )
    repeat_guard_error = _check_mcp_repeat_guard(session, tool_name, args_obj)
    if repeat_guard_error:
        return repeat_guard_error
    if tool_name in _SCREENSHOT_TOOL_NAMES and _is_non_vision_model(session):
        return (
            f'{{"size_bytes": 0, "viewport": {{}}, "skipped": true}}'
            + _SCREENSHOT_NON_VISION_HINT
        )
    result = await mcp_call_tool_async(
        session.mcp_hub,
        tool_name,
        json.dumps(args_obj, ensure_ascii=False),
        echo=False,
    )
    return result


def _tool_mcp_import(arguments: Dict[str, Any], session: StudioSession) -> str:
    from agenticx.studio.enterprise_capability_policy import local_mcp_install_allowed

    if not local_mcp_install_allowed():
        return "ERROR: 企业管理员已关闭员工本地 MCP 安装与修改"
    source_path = str(arguments.get("source_path", "")).strip()
    if not source_path:
        return "ERROR: missing source_path"
    result = import_mcp_config(source_path)
    if not result.get("ok"):
        return f"ERROR: {result.get('error', 'mcp_import failed')}"
    try:
        session.mcp_configs = load_available_servers()
    except Exception:
        pass
    return json.dumps(result, ensure_ascii=False)


def _tool_skill_use(arguments: Dict[str, Any], session: StudioSession) -> str:
    name = str(arguments.get("name", "")).strip()
    if not name:
        return "ERROR: missing skill name"
    bound = str(getattr(session, "bound_avatar_id", "") or "").strip() or None
    allowed, err = skill_is_allowed_for_session(name, bound_avatar_id=bound)
    if not allowed:
        return f"ERROR: {err}"
    ok = studio_skill_use(
        session.context_files, name, bound_avatar_id=bound, quiet=True
    )
    if not ok:
        from pathlib import Path

        hint = (
            f"Skill '{name}' was not found in the skill index. "
            "Common causes: SKILL.md missing YAML `name:` (only `title:` is not enough), "
            "skill not under a scanned path, or name mismatch vs frontmatter. "
            "Run skill_list for discoverable names, or fix frontmatter then retry skill_use."
        )
        guessed = agx_home() / "skills" / name / "SKILL.md"
        if guessed.is_file():
            hint += (
                f" File exists at {guessed} but is not indexed — add "
                f"`name: {name}` to frontmatter (or use skill_manage create/patch)."
            )
        return f"ERROR: skill activation failed. {hint}"

    meta = SkillBundleLoader().get_skill(name)
    try:
        from agenticx.learning.skill_usage_tracker import record_use
        skill_dir = meta.base_dir if meta else None
        if skill_dir:
            sid = str(getattr(session, "session_id", "") or getattr(session, "id", "") or "")
            record_use(skill_dir, session_id=sid)
    except Exception:
        pass
    if meta is None:
        return f"OK: activated skill '{name}' into context_files key 'skill:{name}'"
    return (
        f"OK: activated skill '{name}' into context_files key 'skill:{name}'. "
        f"source={meta.source}, location={meta.location}, "
        f"base_dir={meta.base_dir}, skill_md={meta.skill_md_path}"
    )


def _tool_skill_list(session: StudioSession) -> str:
    try:
        bound = str(getattr(session, "bound_avatar_id", "") or "").strip() or None
        summaries = get_all_skill_summaries(bound_avatar_id=bound)
    except Exception as exc:
        return f"ERROR: list skill failed: {exc}"
    if not summaries:
        return "No skills found."
    lines = []
    for item in summaries:
        source = str(item.get("source", "unknown"))
        location = str(item.get("location", "unknown"))
        base_dir = str(item.get("base_dir", ""))
        lines.append(
            f"- {item['name']}: {item['description']} "
            f"[source={source}, location={location}, base_dir={base_dir}]"
        )
    return "\n".join(lines)


def _tool_todo_write(arguments: Dict[str, Any], session: StudioSession) -> str:
    items = arguments.get("items", [])
    todo_manager = getattr(session, "todo_manager", None)
    if todo_manager is None:
        return "ERROR: todo manager unavailable in session"
    try:
        return todo_manager.update(items)
    except ValueError as exc:
        return f"ERROR: {exc}"


def _tool_scratchpad_write(arguments: Dict[str, Any], session: StudioSession) -> str:
    key = str(arguments.get("key", "")).strip()
    value = str(arguments.get("value", ""))
    scratchpad = getattr(session, "scratchpad", None)
    if not isinstance(scratchpad, dict):
        session.scratchpad = {}
        scratchpad = session.scratchpad
    if not key:
        return "ERROR: key is required"
    if key == TOKEN_BUDGET_SCRATCHPAD_KEY:
        return "ERROR: key is reserved for internal session accounting"
    if key not in scratchpad and len(scratchpad) >= 50:
        return "ERROR: scratchpad key limit exceeded (50)"
    if len(value) > 10_000:
        value = value[:10_000] + "\n... (truncated to 10000 chars)"
    old_value = scratchpad.get(key, "")
    scratchpad[key] = value
    try:
        from agenticx.runtime.session_mode import (
            PHASE_AUTHOR,
            PHASE_READ,
            PHASE_SCRATCH_KEY,
            is_code_dev,
        )

        if is_code_dev(session) and key == PHASE_SCRATCH_KEY:
            prev = str(old_value or "").strip().lower()
            new = value.strip().lower()
            if prev == PHASE_READ and new == PHASE_AUTHOR:
                setattr(session, "_code_dev_phase_compact_pending", True)
    except Exception:
        pass
    return f"OK: scratchpad[{key}] updated"


def _tool_scratchpad_read(arguments: Dict[str, Any], session: StudioSession) -> str:
    scratchpad = getattr(session, "scratchpad", None)
    if not isinstance(scratchpad, dict):
        return "No scratchpad entries."
    if bool(arguments.get("list_only", False)):
        keys = sorted(key for key in scratchpad.keys() if key != TOKEN_BUDGET_SCRATCHPAD_KEY)
        return "\n".join(keys) if keys else "No scratchpad entries."
    key = str(arguments.get("key", "")).strip()
    if not key:
        keys = sorted(key for key in scratchpad.keys() if key != TOKEN_BUDGET_SCRATCHPAD_KEY)
        return "\n".join(keys) if keys else "No scratchpad entries."
    if key == TOKEN_BUDGET_SCRATCHPAD_KEY:
        return "ERROR: key is reserved for internal session accounting"
    if key not in scratchpad:
        return f"ERROR: key not found: {key}"
    return str(scratchpad[key])


async def _tool_memory_append(
    arguments: Dict[str, Any],
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
    session: Optional["StudioSession"] = None,
) -> str:
    target = str(arguments.get("target", "")).strip().lower()
    content = str(arguments.get("content", "")).strip()
    scope = str(arguments.get("scope", "subject") or "subject").strip().lower()
    if target not in {"daily", "long_term"}:
        return "ERROR: target must be daily or long_term"
    if scope not in {"subject", "user_global"}:
        return "ERROR: scope must be subject or user_global"
    if not content:
        return "ERROR: content is required"

    from datetime import date

    from agenticx.workspace.loader import (
        DAILY_MEMORY_TEMPLATE,
        append_daily_memory,
        append_long_term_memory,
        append_user_global_preference,
        resolve_subject_workspace_dir,
        resolve_workspace_dir,
    )

    if scope == "user_global":
        if target != "long_term":
            return "ERROR: user_global scope only supports target=long_term"
        if not await _confirm(
            "Append preference to global USER.md (all subjects)?",
            confirm_gate=confirm_gate,
            context={
                "tool": "memory_append",
                "scope": scope,
                "preview": content[:200],
                "risk": "policy",
                "approval_reuse": "none",
                "protected_reason": "内容将写入全局长期记忆",
                "risk_categories": [
                    _risk_finding("persistent_memory_change", "写入全局 USER.md")
                ],
            },
            emit_event=emit_event,
        ):
            return _cancelled("记忆未写入", confirm_gate)
        append_user_global_preference(content)
        workspace_dir = resolve_workspace_dir()
    else:
        workspace_dir = resolve_subject_workspace_dir(session=session)
        workspace_dir.mkdir(parents=True, exist_ok=True)
        if target == "long_term":
            if not await _confirm(
                "Append note into this subject's long-term MEMORY.md?",
                confirm_gate=confirm_gate,
                context={
                    "tool": "memory_append",
                    "target": target,
                    "preview": content[:200],
                    "risk": "policy",
                    "approval_reuse": "none",
                    "protected_reason": "内容将写入该智能体的长期记忆",
                    "risk_categories": [
                        _risk_finding("persistent_memory_change", "写入长期 MEMORY.md")
                    ],
                },
                emit_event=emit_event,
            ):
                return _cancelled("记忆未写入", confirm_gate)
            append_long_term_memory(workspace_dir, content)
        else:
            memory_dir = workspace_dir / "memory"
            memory_dir.mkdir(parents=True, exist_ok=True)
            today_file = memory_dir / f"{date.today().isoformat()}.md"
            if not today_file.exists():
                today_file.write_text(
                    DAILY_MEMORY_TEMPLATE.format(today=date.today().isoformat()),
                    encoding="utf-8",
                )
            append_daily_memory(workspace_dir, content)

    try:
        store = WorkspaceMemoryStore()
        store.index_workspace_sync(workspace_dir)
        global_ws = resolve_workspace_dir()
        if workspace_dir.resolve(strict=False) != global_ws.resolve(strict=False):
            store.index_workspace_sync(global_ws)
    except Exception:
        pass
    return f"OK: appended to {target} (scope={scope})"


def _read_knowledge_config_for_tool() -> Tuple[Optional[Any], Optional[str]]:
    """Read the compatibility KB config without leaking a raw runtime error."""
    try:
        from agenticx.studio.kb import KBManager

        return KBManager.instance().read_config(), None
    except Exception as exc:
        reason = str(exc).strip() or type(exc).__name__
        _log.warning("knowledge base unavailable during tool config read: %s", reason)
        return None, f"knowledge base unavailable: {reason}"


def _tool_knowledge_search(
    arguments: Dict[str, Any], session: Optional["StudioSession"] = None
) -> str:
    """Search mounted docs brains (multi-brain architecture)."""

    query = str(arguments.get("query", "")).strip()
    if not query:
        return json.dumps(
            {"ok": False, "error": "query is required", "hits": []},
            ensure_ascii=False,
        )
    try:
        from agenticx.brain.search import search_docs_brains
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": f"KB subsystem unavailable: {exc}", "hits": []},
            ensure_ascii=False,
        )

    cfg, cfg_error = _read_knowledge_config_for_tool()
    if cfg is None:
        return json.dumps(
            {"ok": False, "error": cfg_error or "knowledge base unavailable", "hits": []},
            ensure_ascii=False,
        )
    default_top_k = int(getattr(getattr(cfg, "retrieval", None), "top_k", 5) or 5)
    raw_top_k = arguments.get("top_k")
    try:
        top_k = int(raw_top_k) if raw_top_k is not None else default_top_k
    except (TypeError, ValueError):
        top_k = default_top_k
    top_k = max(1, min(20, top_k))

    avatar_id = None
    if session is not None:
        avatar_id = str(getattr(session, "bound_avatar_id", "") or "").strip() or None
    brain_id = str(arguments.get("brain_id") or "").strip() or None

    try:
        payload = search_docs_brains(
            query=query,
            top_k=top_k,
            avatar_id=avatar_id,
            brain_id=brain_id,
        )
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": f"search failed: {exc}", "hits": []},
            ensure_ascii=False,
        )
    return json.dumps(payload, ensure_ascii=False)


def _tool_knowledge_synthesize(
    arguments: Dict[str, Any], session: Optional["StudioSession"] = None
) -> str:
    query = str(arguments.get("query", "")).strip()
    if not query:
        return json.dumps(
            {"ok": False, "error": "query is required", "answer": ""},
            ensure_ascii=False,
        )
    try:
        from agenticx.brain.synthesis import synthesize_docs_brains
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": f"KB subsystem unavailable: {exc}", "answer": ""},
            ensure_ascii=False,
        )

    cfg, cfg_error = _read_knowledge_config_for_tool()
    if cfg is None:
        return json.dumps(
            {"ok": False, "error": cfg_error or "knowledge base unavailable", "answer": ""},
            ensure_ascii=False,
        )
    default_top_k = int(getattr(getattr(cfg, "retrieval", None), "top_k", 5) or 5)
    raw_top_k = arguments.get("top_k")
    try:
        top_k = int(raw_top_k) if raw_top_k is not None else default_top_k
    except (TypeError, ValueError):
        top_k = default_top_k
    top_k = max(1, min(20, top_k))

    avatar_id = None
    if session is not None:
        avatar_id = str(getattr(session, "bound_avatar_id", "") or "").strip() or None
    brain_id = str(arguments.get("brain_id") or "").strip() or None

    try:
        payload = synthesize_docs_brains(
            query=query,
            top_k=top_k,
            avatar_id=avatar_id,
            brain_id=brain_id,
        )
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": f"synthesis failed: {exc}", "answer": ""},
            ensure_ascii=False,
        )
    return json.dumps(payload, ensure_ascii=False)


def _tool_web_search(arguments: Dict[str, Any], session: Optional["StudioSession"] = None) -> str:
    query = str(arguments.get("query", "")).strip()
    if not query:
        return "ERROR: web_search requires a non-empty query"
    raw_mr = arguments.get("max_results")
    try:
        from agenticx.studio.web_search.service import WebSearchService
        from agenticx.studio.references import queue_web_search_batch

        svc = WebSearchService.from_config()
        mr: int | None = None
        if raw_mr is not None and str(raw_mr).strip() != "":
            mr = int(raw_mr)
        hits = svc.search(query, max_results=mr)
        if session is not None:
            queue_web_search_batch(
                session,
                query=query,
                hits=hits,
                provider=str(svc.last_provider or "duckduckgo"),
            )
        return WebSearchService.format_results(hits)
    except Exception as exc:
        return f"ERROR: web_search failed: {exc}"


def _tool_get_current_datetime(arguments: Dict[str, Any]) -> str:
    """Return local clock facts as JSON for the model to quote verbatim."""
    from agenticx.runtime.prompts.current_time import get_current_time_facts

    payload = dict(get_current_time_facts())
    payload["source"] = "local_system_clock"
    return json.dumps(payload, ensure_ascii=False)


PENDING_VISUAL_ATTACHMENTS_KEY = "__pending_visual_attachments__"
VIEW_IMAGE_INJECT_LLM_TEXT = (
    "<system-injected> attached images requested via view_image tool:"
)
VIEW_IMAGE_INJECT_METADATA_SOURCE = "view_image_inject"
_WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024
_WEB_FETCH_BODY_CHAR_LIMIT = 12_000
_VIEW_IMAGE_MAX_BYTES = 8 * 1024 * 1024
_VIEW_IMAGE_MAX_PENDING = 4
_VIDEO_UNDERSTAND_DEFAULT_MAX_FRAMES = 12
_VIDEO_UNDERSTAND_HARD_MAX_FRAMES = 24
_VIDEO_UNDERSTAND_DEFAULT_INTERVAL_SECONDS = 8.0
_VIDEO_UNDERSTAND_MIN_FRAMES = 4
_VIDEO_UNDERSTAND_MAX_VIDEO_BYTES = 512 * 1024 * 1024
_ALLOWED_WEB_FETCH_CONTENT_TYPES = (
    "text/html",
    "application/xhtml",
    "text/plain",
    "text/markdown",
)


def _httpx_transport_for_url(url: str):
    import httpx

    host = (urlparse(url).hostname or "").lower()
    if host in {"127.0.0.1", "localhost", "::1"}:
        return httpx.AsyncHTTPTransport()
    return None


def _detect_image_mime(data: bytes) -> str | None:
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 6 and data[:6] in {b"GIF87a", b"GIF89a"}:
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 2 and data[:2] == b"BM":
        return "image/bmp"
    return None


def _filename_from_url(url: str, mime: str) -> str:
    path = urlparse(url).path.rsplit("/", 1)[-1].strip()
    if path and "." in path:
        return path
    ext = "png"
    if "jpeg" in mime or "jpg" in mime:
        ext = "jpg"
    elif "webp" in mime:
        ext = "webp"
    elif "gif" in mime:
        ext = "gif"
    elif "bmp" in mime:
        ext = "bmp"
    return f"image.{ext}"


def _data_url_from_bytes(data: bytes, mime: str) -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _parse_data_image_url(target: str) -> tuple[bytes, str] | None:
    raw = str(target or "").strip()
    if not raw.startswith("data:image/"):
        return None
    header, _, payload = raw.partition(",")
    if not payload:
        return None
    mime = header[5:].split(";", 1)[0].strip() or "image/png"
    try:
        if ";base64" in header.lower():
            data = base64.b64decode(payload, validate=False)
        else:
            from urllib.parse import unquote_to_bytes

            data = unquote_to_bytes(payload)
    except Exception:
        return None
    return data, mime


async def _fetch_http_bytes(url: str, *, timeout: float, max_bytes: int) -> tuple[bytes, str, str]:
    import httpx

    transport = _httpx_transport_for_url(url)
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=True,
        transport=transport,
    ) as client:
        response = await client.get(url)
        final_url = str(response.url)
        if response.status_code != 200:
            raise ValueError(f"http {response.status_code}")
        content_type = str(response.headers.get("content-type", "") or "").split(";", 1)[0].strip().lower()
        data = response.content
        if len(data) > max_bytes:
            raise ValueError("too-large")
        return data, content_type, final_url


async def _tool_document_read_pages(
    arguments: Dict[str, Any], session: Optional["StudioSession"] = None
) -> str:
    """接着读 PDF 的后续页。

    只允许读**本会话已附加**的文件。这个工具会把任意路径渲染成图送进上下文，不限制
    范围就等于给模型开了一个读本机任意 PDF 的口子。
    """
    from agenticx.studio.document_pages import (
        DEFAULT_MAX_PAGES,
        pdf_rendering_available,
        render_pdf_pages,
    )

    raw_path = str(arguments.get("path", "") or "").strip()
    if not raw_path:
        return "ERROR: document_read_pages requires 'path'"
    if session is None:
        return "ERROR: no active session"
    context_files = getattr(session, "context_files", None)
    if not isinstance(context_files, dict) or raw_path not in context_files:
        return (
            f"ERROR: '{raw_path}' is not an attachment of this conversation. "
            "Use the exact path from the attachment note."
        )
    if not pdf_rendering_available():
        return "ERROR: PDF rendering is unavailable in this deployment (PyMuPDF missing)."
    try:
        start_page = int(arguments.get("start_page") or 1)
    except (TypeError, ValueError):
        return "ERROR: start_page must be an integer"
    try:
        max_pages = int(arguments.get("max_pages") or DEFAULT_MAX_PAGES)
    except (TypeError, ValueError):
        max_pages = DEFAULT_MAX_PAGES

    result = render_pdf_pages(raw_path, first_page=start_page, max_pages=max_pages)
    if not result.available:
        return f"ERROR: {result.error}"

    display = os.path.basename(raw_path)
    pending = _pending_visual_attachments(session)
    for page in result.pages:
        pending.append(
            {
                "data_url": page.data_url,
                "name": f"{display} · 第 {page.page_number} 页",
                "source": "document_pages",
            }
        )
    first = result.pages[0].page_number
    last = result.pages[-1].page_number
    tail = ""
    if result.next_page is not None:
        tail = (
            f" 还有第 {result.next_page}–{result.total_pages} 页未读，"
            f'需要时再调用 document_read_pages(path="{raw_path}", start_page={result.next_page})。'
        )
    return (
        f"已渲染 {display} 第 {first}–{last} 页（共 {result.total_pages} 页），"
        f"将在下一轮作为图片出现在你的输入中。{tail}"
    )


def _pending_visual_attachments(session: Optional[StudioSession]) -> list[dict[str, Any]]:
    if session is None:
        return []
    scratchpad = getattr(session, "scratchpad", None)
    if not isinstance(scratchpad, dict):
        session.scratchpad = {}
        scratchpad = session.scratchpad
    pending = scratchpad.get(PENDING_VISUAL_ATTACHMENTS_KEY)
    if not isinstance(pending, list):
        pending = []
        scratchpad[PENDING_VISUAL_ATTACHMENTS_KEY] = pending
    return pending


def _session_vision_capable(session: Optional[StudioSession]) -> bool:
    from agenticx.llms.vision import is_vision_capable

    provider = str(getattr(session, "provider_name", "") or "")
    model = str(getattr(session, "model_name", "") or "")
    return is_vision_capable(provider, model)


async def _tool_web_fetch(arguments: Dict[str, Any], session: Optional[StudioSession] = None) -> str:
    url = str(arguments.get("url", "") or "").strip()
    if not url:
        return "ERROR: missing required parameter 'url'"
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return "ERROR: only http(s) URLs are supported"
    raw_max_images = arguments.get("max_images")
    try:
        max_images = int(raw_max_images) if raw_max_images is not None else 20
    except (TypeError, ValueError):
        max_images = 20
    max_images = max(1, min(max_images, 50))
    try:
        body, content_type, final_url = await _fetch_http_bytes(
            url,
            timeout=15.0,
            max_bytes=_WEB_FETCH_MAX_BYTES,
        )
    except ValueError as exc:
        reason = str(exc)
        if reason == "too-large":
            return "ERROR: page exceeds 2MB limit"
        if reason.startswith("http "):
            return f"ERROR: {reason}"
        return f"ERROR: network"
    except Exception:
        return "ERROR: network"
    if not any(content_type.startswith(prefix) for prefix in _ALLOWED_WEB_FETCH_CONTENT_TYPES):
        return f"ERROR: unsupported content-type {content_type or '(missing)'}"
    from agenticx.tools.html_extractor import extract_readable_text

    html = body.decode("utf-8", errors="replace")
    extracted = extract_readable_text(html, final_url)
    title = str(extracted.get("title", "") or "").strip() or "(untitled)"
    text = str(extracted.get("text", "") or "").strip()
    total_chars = len(text)
    truncated = False
    if total_chars > _WEB_FETCH_BODY_CHAR_LIMIT:
        text = text[:_WEB_FETCH_BODY_CHAR_LIMIT]
        truncated = True
    lines = [f"Title: {title}", f"URL: {final_url}", "", text]
    if truncated:
        lines.append(f"...[truncated, total ~{total_chars} chars]")
    images = list(extracted.get("images") or [])[:max_images]
    if images:
        lines.append("")
        lines.append("[discovered_images]")
        for idx, image_url in enumerate(images, start=1):
            lines.append(f"{idx}. {image_url}")
    return "\n".join(lines).strip()


async def _load_image_target(
    target: str,
    session: Optional[StudioSession],
) -> Tuple[bytes, str, str, str]:
    """Resolve an image target to (data, mime, name, source).

    Shared by view_image and analyze_image. Raises ValueError with a
    user-facing message (without the "ERROR: " prefix) on failure.
    """
    parsed = urlparse(target)
    if target.startswith("data:image/"):
        parsed_data = _parse_data_image_url(target)
        if parsed_data is None:
            raise ValueError("unsupported image type")
        data, mime = parsed_data
        return data, mime, "clipboard-image", target
    if parsed.scheme in {"http", "https"}:
        try:
            data, content_type, final_url = await _fetch_http_bytes(
                target,
                timeout=10.0,
                max_bytes=_VIEW_IMAGE_MAX_BYTES,
            )
        except ValueError as exc:
            reason = str(exc)
            if reason == "too-large":
                raise ValueError("image exceeds 8MB limit") from exc
            if reason.startswith("http "):
                raise ValueError(reason) from exc
            raise ValueError("network") from exc
        except Exception as exc:
            raise ValueError("network") from exc
        mime = _detect_image_mime(data) or (
            content_type if content_type.startswith("image/") else None
        )
        if not mime:
            raise ValueError("unsupported image type")
        return data, mime, _filename_from_url(final_url, mime), final_url
    if parsed.scheme in {"file", ""} or target.startswith("/") or (len(target) > 2 and target[1] == ":"):
        if session is not None:
            try:
                from agenticx.studio.chat_attachments import resolve_session_chat_image

                session_hit = resolve_session_chat_image(session, target)
            except Exception:
                session_hit = None
            if session_hit is not None:
                return session_hit
        try:
            path = _resolve_workspace_path(target, session, pick_existing=True)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        if not path.exists() or not path.is_file():
            raise ValueError(f"file not found: {path}")
        data = path.read_bytes()
        if len(data) > _VIEW_IMAGE_MAX_BYTES:
            raise ValueError("image exceeds 8MB limit")
        mime = _detect_image_mime(data)
        if not mime:
            raise ValueError("unsupported image type")
        return data, mime, path.name, str(path)
    raise ValueError("only http(s) URLs, data:image/* URLs, and local file paths are supported")


async def _tool_view_image(arguments: Dict[str, Any], session: Optional[StudioSession] = None) -> str:
    target = str(arguments.get("target", "") or "").strip()
    note = str(arguments.get("note", "") or "").strip()
    if not target:
        return "ERROR: missing required parameter 'target'"
    if not _session_vision_capable(session):
        model = str(getattr(session, "model_name", "") or "unknown")
        return (
            f"ERROR: current model '{model}' does not support vision; "
            "use analyze_image(target=...) to read it via the vision fallback model, "
            "or switch to a vision-capable model."
        )
    pending = _pending_visual_attachments(session)
    if len(pending) >= _VIEW_IMAGE_MAX_PENDING:
        return "ERROR: too many pending visual attachments (max 4 per turn)"
    try:
        data, mime, name, source = await _load_image_target(target, session)
    except ValueError as exc:
        return f"ERROR: {exc}"
    if len(data) > _VIEW_IMAGE_MAX_BYTES:
        return "ERROR: image exceeds 8MB limit"
    data_url = _data_url_from_bytes(data, mime)
    pending.append(
        {
            "name": name,
            "data_url": data_url,
            "mime_type": mime,
            "size": len(data),
            "source": source,
            "note": note,
        }
    )
    size_kb = max(1, len(data) // 1024)
    note_clause = f" ({note})" if note else ""
    return (
        f"[image loaded: {name} ({size_kb} KB, {mime}); "
        f"will be visually attached in next turn{note_clause}]"
    )


async def _tool_analyze_image(arguments: Dict[str, Any], session: Optional[StudioSession] = None) -> str:
    target = str(arguments.get("target", "") or "").strip()
    question = str(arguments.get("question", "") or "").strip()
    if _session_vision_capable(session):
        return (
            "ERROR: current model already supports vision; use view_image(target=...) instead "
            "so the image is attached to your own next turn."
        )
    from agenticx.llms.vision_fallback import resolve_vision_fallback

    info = resolve_vision_fallback(session=session)
    if not info.get("available"):
        return (
            "ERROR: no vision-capable fallback model is configured. Tell the user to add a "
            "vision model (a SKU whose name carries a v/vision/vl marker, e.g. glm-4.6v) in "
            "Settings → 模型服务, or set vision_fallback.provider/model in $AGX_HOME/config.yaml."
        )
    if target:
        try:
            data, mime, name, source = await _load_image_target(target, session)
        except ValueError as exc:
            return f"ERROR: {exc}"
        if len(data) > _VIEW_IMAGE_MAX_BYTES:
            return "ERROR: image exceeds 8MB limit"
        data_url = _data_url_from_bytes(data, mime)
    else:
        from agenticx.studio.chat_attachments import (
            image_data_url_from_attachment,
            iter_session_image_attachments,
        )

        atts = iter_session_image_attachments(session) if session is not None else []
        if not atts:
            return (
                "ERROR: no image found in this session; "
                "pass target explicitly (path, http(s) URL, or data:image/* URL)"
            )
        att = atts[-1]
        data_url = image_data_url_from_attachment(att)
        if not data_url:
            return "ERROR: latest image attachment has no readable bytes"
        name = str(att.get("name", "") or "image")
        source = str(att.get("storage_path", "") or "session-upload")

    prompt_text = question or (
        "请详细描述这张图片的关键内容（其中的文字、标识/Logo、界面元素、图表数据等），"
        "以便后续据此检索与推理。"
    )
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt_text},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }
    ]
    try:
        from agenticx.llms.provider_resolver import ProviderResolver

        llm = ProviderResolver.resolve(
            provider_name=str(info["provider"]),
            model=str(info["model"]),
        )
        resp = await llm.ainvoke(messages)
    except Exception as exc:
        return (
            f"ERROR: vision fallback call failed "
            f"({info.get('label') or info.get('model')}): {exc}"
        )
    desc = str(getattr(resp, "content", "") or "").strip()
    if not desc:
        return "ERROR: vision fallback returned empty content"
    label = str(info.get("label") or f"{info.get('provider')}/{info.get('model')}")
    return (
        f"[analyze_image: 视觉解读由 {label} 提供；图片 {name}，来源 {source}]\n"
        f"{desc}\n"
        "[/analyze_image] 请基于以上文字解读继续完成用户请求（如需检索请调用 web_search）。"
    )


async def _tool_memory_search(arguments: Dict[str, Any], session: StudioSession) -> str:
    query = str(arguments.get("query", "")).strip()
    if not query:
        return "ERROR: query is required"
    mode = str(arguments.get("mode", "hybrid") or "hybrid").strip().lower()
    limit = int(arguments.get("limit", 5) or 5)
    avatar_id = str(getattr(session, "bound_avatar_id", "") or "").strip() or None
    session_id = str(getattr(session, "session_id", "") or "").strip() or None
    try:
        from agenticx.memory.recall import search_memory_for_chat

        recall = await search_memory_for_chat(
            query,
            limit=max(1, limit),
            mode=mode,
            avatar_id=avatar_id,
            session_id=session_id,
        )
        rows = recall.matches
    except Exception as exc:
        return f"ERROR: memory search failed: {exc}"
    if not rows:
        return "No memory matches."
    lines: List[str] = []
    for idx, row in enumerate(rows, start=1):
        text = str(row.get("text", "")).replace("\n", " ")
        if len(text) > 240:
            text = text[:240] + "..."
        source = str(row.get("source") or "workspace")
        path = str(row.get("path") or "")
        loc = f"path={path}:{row.get('start_line')}-{row.get('end_line')}" if path else f"source={source}"
        lines.append(
            f"{idx}. score={row.get('score', 0.0)} {loc} text={text}"
        )
    if recall.graph_skipped_reason:
        lines.append(f"(graph skipped: {recall.graph_skipped_reason})")
    return "\n".join(lines)


async def _tool_memory_forget(arguments: Dict[str, Any], session: StudioSession) -> str:
    query = str(arguments.get("query", "")).strip()
    scope = str(arguments.get("scope", "both") or "both").strip().lower()
    avatar_id = str(getattr(session, "bound_avatar_id", "") or "").strip() or None
    session_id = str(getattr(session, "session_id", "") or "").strip() or None
    try:
        from agenticx.memory.graph.forget import forget_memory_for_session

        result = await forget_memory_for_session(
            query,
            scope=scope,
            avatar_id=avatar_id,
            session_id=session_id,
        )
    except Exception as exc:
        return f"ERROR: memory forget failed: {exc}"
    return json.dumps(result, ensure_ascii=False)


def _skill_manage_enabled() -> bool:
    from agenticx.studio.enterprise_capability_policy import local_skill_install_allowed

    if not local_skill_install_allowed():
        return False
    v = os.environ.get("AGX_SKILL_MANAGE", "0").strip().lower()
    if v in {"1", "true", "yes", "on"}:
        return True
    if os.environ.get("AGX_CONFIRM_STRATEGY", "").strip().lower() == "auto":
        return True
    return False


def _skill_market_scan_label(scan: Any) -> tuple[str, int]:
    payload = scan if isinstance(scan, dict) else {}
    verdict = str(payload.get("overall", "") or "").strip().lower()
    label = {
        "safe": "未发现高危内容",
        "caution": "发现需注意内容",
        "dangerous": "发现高风险内容",
    }.get(verdict, "扫描结果未知")
    rows = payload.get("skills")
    findings_count = 0
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            findings = row.get("findings")
            if isinstance(findings, list):
                findings_count += len(findings)
    return label, findings_count


async def _tool_skill_market_install(
    arguments: Dict[str, Any],
    session: Optional[StudioSession],
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> str:
    """Install one published skill through the shared marketplace flow."""
    from agenticx.studio.enterprise_capability_policy import local_skill_install_allowed

    if not local_skill_install_allowed():
        return json.dumps(
            {"ok": False, "error": "企业管理员已关闭员工本地 Skill 安装与修改"},
            ensure_ascii=False,
        )
    raw_name = str(arguments.get("name", "") or "").strip()
    if not raw_name:
        return json.dumps(
            {"ok": False, "error": "name is required"},
            ensure_ascii=False,
        )

    from agenticx.extensions.skill_market_install import (
        discard_market_skill_preview,
        install_market_skill,
        load_non_high_risk_auto_install,
        preview_market_skill,
    )

    source_name = str(arguments.get("source", "") or "").strip()
    preview = await asyncio.to_thread(
        preview_market_skill,
        raw_name,
        source_name=source_name,
    )
    if not preview.get("ok"):
        return json.dumps(preview, ensure_ascii=False)

    scan = preview.get("scan") if isinstance(preview.get("scan"), dict) else {}
    verdict = str(scan.get("overall", "") or "").strip().lower()
    auto_non_high = load_non_high_risk_auto_install()
    needs_high_confirmation = verdict == "dangerous"
    needs_policy_confirmation = verdict in ("safe", "caution") and not auto_non_high

    approved = True
    if needs_high_confirmation or needs_policy_confirmation:
        scan_label, findings_count = _skill_market_scan_label(scan)
        resolved_name = str(preview.get("name") or raw_name)
        risk_note = f"（命中 {findings_count} 项）" if findings_count else ""
        question = (
            f"准备安装第三方技能「{resolved_name}」。\n\n"
            "系统会从 SkillHub 获取该技能并加入你的技能列表。"
            f"安全扫描：{scan_label}{risk_note}。\n\n"
            + (
                "该技能包含高风险内容，只有你明确允许后才会继续。是否仍要安装？"
                if needs_high_confirmation
                else "当前安全策略要求先获得你的允许。是否继续安装？"
            )
        )
        approved = await _confirm(
            question,
            confirm_gate=confirm_gate,
            context={
                "tool": "skill_market_install",
                "action": "install",
                "skill": resolved_name,
                "risk": "high" if needs_high_confirmation else "policy",
                "approval_reuse": "none",
                "protected_reason": "安装内容会作为第三方技能参与后续运行",
                "risk_categories": [
                    _risk_finding(
                        "third_party_extension",
                        f"安全扫描结果：{scan_label}{risk_note}",
                    )
                ],
            },
            emit_event=emit_event,
        )
    if not approved:
        discard_market_skill_preview(
            str(preview.get("name") or raw_name),
            source_name=str(preview.get("source") or source_name),
            namespace=str(preview.get("namespace") or ""),
            preview_token=str(preview.get("preview_token") or ""),
        )
        return json.dumps(
            {
                "ok": False,
                "error": "user_cancelled",
                "message": "用户已取消安装。",
                "name": preview.get("name") or raw_name,
            },
            ensure_ascii=False,
        )

    result = await asyncio.to_thread(
        install_market_skill,
        str(preview.get("name") or raw_name),
        source_name=str(preview.get("source") or source_name),
        namespace=str(preview.get("namespace") or ""),
        origin_source=str(preview.get("origin_source") or ""),
        preview_token=str(preview.get("preview_token") or ""),
        acknowledge_high_risk=needs_high_confirmation,
        confirm_non_high_risk=needs_policy_confirmation,
        auto_non_high=auto_non_high,
        provenance_source="skillhub",
    )
    return json.dumps(result, ensure_ascii=False)


def _safe_skill_dir_name(name: str) -> Optional[str]:
    """Validate a skill name, allowing sub-paths like ``ima/notes``.

    Each path segment must start with an alphanumeric character and contain
    only alphanumerics, dots, underscores, or hyphens.  Back-references
    (``..``) and hidden segments (starting with ``.``) are rejected.
    """
    n = str(name or "").strip().replace("\\", "/")
    if not n:
        return None
    _SEG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
    segments = n.split("/")
    for seg in segments:
        if not seg or seg.startswith(".") or seg == "..":
            return None
        if not _SEG.fullmatch(seg):
            return None
    return n


def _agent_created_skill_root() -> Path:
    return agx_home() / "skills"


def _skill_url_allowlist() -> List[str]:
    defaults = [
        "raw.githubusercontent.com",
        "gist.githubusercontent.com",
        "registry.clawhub.ai",
    ]
    try:
        from agenticx.cli.config_manager import ConfigManager

        raw = ConfigManager.get_value("skill_manage.url_allowlist")
        if isinstance(raw, list) and raw:
            return [str(x).strip().lower() for x in raw if str(x).strip()]
    except Exception:
        pass
    return defaults


def _skill_max_url_bytes() -> int:
    try:
        from agenticx.cli.config_manager import ConfigManager

        raw = ConfigManager.get_value("skill_manage.max_url_payload_bytes")
        if raw is not None:
            return max(1024, int(raw))
    except Exception:
        pass
    return 1_048_576


def _resolve_skill_content_path(path_arg: str, session: Optional[StudioSession]) -> Path:
    """Resolve a local path for skill content (workspace or $AGX_HOME/)."""
    agx_root = agx_home().resolve()
    try:
        resolved = _resolve_workspace_path(path_arg, session, pick_existing=True)
    except ValueError:
        raw = _path_from_arg(path_arg)
        if not raw.is_absolute():
            raw = (agx_home() / raw).resolve(strict=False)
        else:
            raw = raw.resolve(strict=False)
        if not _is_path_under_root(raw, agx_root) and not _desktop_unrestricted_fs_enabled():
            raise ValueError(f"path must be under workspace or $AGX_HOME/: {raw}") from None
        resolved = raw
    if not resolved.is_file():
        raise ValueError(f"file not found: {resolved}")
    return resolved


def _fetch_skill_content_from_url(url: str) -> str:
    from urllib.parse import urlparse
    import urllib.request

    parsed = urlparse(str(url or "").strip())
    if parsed.scheme != "https":
        raise ValueError("only https URLs are allowed for from_url")
    host = (parsed.hostname or "").lower()
    allow = _skill_url_allowlist()
    if host not in allow:
        raise ValueError(f"host not in skill_manage.url_allowlist: {host}")
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    max_bytes = _skill_max_url_bytes()
    if len(data) > max_bytes:
        raise ValueError(f"URL payload exceeds max_url_payload_bytes ({max_bytes})")
    return data.decode("utf-8")


def _resolve_skill_create_content(arguments: Dict[str, Any], session: Optional[StudioSession]) -> Tuple[Optional[str], Optional[str]]:
    from_path = str(arguments.get("from_path", "") or "").strip()
    from_url = str(arguments.get("from_url", "") or "").strip()
    content = str(arguments.get("content", "") or "")
    if from_path and from_url:
        return None, "ERROR: from_path and from_url are mutually exclusive"
    if from_path:
        try:
            path = _resolve_skill_content_path(from_path, session)
            return path.read_text(encoding="utf-8"), None
        except ValueError as exc:
            return None, f"ERROR: {exc}"
        except OSError as exc:
            return None, f"ERROR: read failed: {exc}"
    if from_url:
        try:
            return _fetch_skill_content_from_url(from_url), None
        except Exception as exc:
            return None, f"ERROR: from_url fetch failed: {exc}"
    if not content.strip():
        return None, "ERROR: content is required for create (or provide from_path/from_url)"
    return content, None


def _skill_manage_error(code: str, message: str) -> str:
    return f"ERROR[{code.upper()}]: {message}"


def _skill_patch_token_payload(
    *,
    name: str,
    strategy: str,
    old_hash: str,
    old_string: str,
    new_string: str,
    before_context: str,
    after_context: str,
    ranges: list[dict[str, int]],
) -> dict[str, Any]:
    return {
        "v": 1,
        "name": name,
        "strategy": strategy,
        "old_hash": old_hash,
        "old_string_sha256": hashlib.sha256(old_string.encode("utf-8")).hexdigest(),
        "new_string_sha256": hashlib.sha256(new_string.encode("utf-8")).hexdigest(),
        "before_context_sha256": hashlib.sha256(before_context.encode("utf-8")).hexdigest() if before_context else "",
        "after_context_sha256": hashlib.sha256(after_context.encode("utf-8")).hexdigest() if after_context else "",
        "ranges": ranges,
        "issued_at": int(time.time()),
    }


def _encode_patch_token(payload: dict[str, Any]) -> str:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    checksum = hashlib.sha256(body).hexdigest()
    envelope = {"p": payload, "c": checksum}
    raw = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_patch_token(token: str) -> Tuple[Optional[dict[str, Any]], Optional[str]]:
    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii"))
        obj = json.loads(raw.decode("utf-8"))
        payload = obj.get("p")
        checksum = str(obj.get("c", ""))
        if not isinstance(payload, dict):
            return None, "invalid patch token payload"
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        expected = hashlib.sha256(body).hexdigest()
        if checksum != expected:
            return None, "patch token checksum mismatch"
        return payload, None
    except Exception as exc:
        return None, f"invalid patch token: {exc}"


def _looks_like_stock_chart_payload(parsed: Dict[str, Any]) -> bool:
    """Detect a stock_chart JSON even if the model forgot the `type` field.

    Models sometimes emit `{"chart_type": ..., "watchlist": [...]}` without the
    literal `"type": "stock_chart"` marker. Recognizing the shape (watchlist /
    points-with-OHLC-keys) avoids silently degrading to a raw-JSON HTML widget.
    """
    if parsed.get("type") == "stock_chart":
        return True
    if parsed.get("type") not in (None, "", "stock_chart"):
        return False
    watchlist = parsed.get("watchlist") or parsed.get("instruments") or parsed.get("series")
    if isinstance(watchlist, list) and watchlist:
        first = watchlist[0]
        if isinstance(first, dict) and isinstance(first.get("points") or first.get("data"), list):
            return True
    rows = parsed.get("points") or parsed.get("data")
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        keys = {str(k).lower() for k in rows[0].keys()}
        ohlc_keys = {"open", "high", "low", "close", "开盘", "最高", "最低", "收盘"}
        if keys & ohlc_keys:
            return True
    return False


def _tool_show_widget(arguments: Dict[str, Any]) -> str:
    """Return a widget payload JSON consumed by the Desktop ToolCallCard.

    The backend does no rendering; it validates and passes the widget code
    through to the frontend as a structured JSON string.
    """
    title = str(arguments.get("title") or "").strip()
    widget_code = str(arguments.get("widget_code") or "")
    raw_msgs = arguments.get("loading_messages")
    loading_messages = (
        [str(m).strip() for m in raw_msgs if str(m).strip()]
        if isinstance(raw_msgs, list)
        else []
    )
    if not widget_code.strip():
        return "ERROR: show_widget requires non-empty widget_code."
    widget_format_raw = arguments.get("widget_format")
    widget_format = (
        str(widget_format_raw).strip().lower()
        if widget_format_raw is not None
        else ""
    )
    if widget_format and widget_format not in {"svg", "html", "mermaid"}:
        return (
            "ERROR: show_widget widget_format must be one of: svg, html, mermaid."
        )
    stripped = widget_code.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict) and _looks_like_stock_chart_payload(parsed):
                parsed.setdefault("type", "stock_chart")
                return json.dumps(parsed, ensure_ascii=False)
        except json.JSONDecodeError:
            pass
    payload = {
        "type": "widget",
        "title": title,
        "widget_code": widget_code,
        "loading_messages": loading_messages,
    }
    if widget_format:
        payload["widget_format"] = widget_format
    return json.dumps(payload, ensure_ascii=False)


_DATA_SOURCE_REGISTRY: Optional[Any] = None


def _get_data_source_registry() -> Any:
    global _DATA_SOURCE_REGISTRY
    if _DATA_SOURCE_REGISTRY is None:
        from agenticx.data_sources.registry import build_registry_from_config

        _DATA_SOURCE_REGISTRY = build_registry_from_config()
    return _DATA_SOURCE_REGISTRY


def reset_data_source_registry_cache() -> None:
    """Clear cached registry (e.g. after config changes from Desktop settings)."""
    global _DATA_SOURCE_REGISTRY
    _DATA_SOURCE_REGISTRY = None


async def _tool_list_data_sources(arguments: Dict[str, Any]) -> str:
    registry = _get_data_source_registry()
    domain_filter = str(arguments.get("domain") or "").strip().lower()
    verbose = bool(arguments.get("verbose", False))
    items: List[Dict[str, Any]] = []
    for plugin in registry.list_plugins():
        if domain_filter and plugin.domain.lower() != domain_filter:
            continue
        apis = plugin.list_apis()
        items.append(
            {
                "name": plugin.name,
                "display_name": plugin.display_name,
                "domain": plugin.domain,
                "requires_credential": plugin.requires_credential,
                "apis": [
                    {"name": a.name, "description": a.description}
                    if not verbose
                    else {
                        "name": a.name,
                        "description": a.description,
                        "params_schema": a.params_schema,
                    }
                    for a in apis
                ],
            }
        )
    return json.dumps({"data_sources": items}, ensure_ascii=False)


async def _tool_query_data_source(arguments: Dict[str, Any]) -> str:
    from agenticx.data_sources.errors import DataSourceError, MissingCredentialError

    registry = _get_data_source_registry()
    data_source_name = str(arguments.get("data_source_name") or "").strip()
    api_name = str(arguments.get("api_name") or "").strip()
    params = arguments.get("params") or {}
    if not isinstance(params, dict):
        return "ERROR: query_data_source params must be an object."
    if not data_source_name or not api_name:
        return "ERROR: query_data_source requires data_source_name and api_name."
    try:
        result = await registry.call(data_source_name, api_name, params)
    except MissingCredentialError:
        return (
            f"ERROR: data source '{data_source_name}' requires credentials. "
            "Configure via Desktop 设置 → 数据源."
        )
    except DataSourceError as exc:
        return f"ERROR: {exc}"
    except Exception as exc:
        logging.getLogger("agenticx.cli.agent_tools").warning(
            "query_data_source unexpected failure: %s", exc
        )
        return f"ERROR: query_data_source failed unexpectedly: {exc}"
    return json.dumps(result.to_dict(), ensure_ascii=False, default=str)


def _tool_session_search(arguments: Dict[str, Any], session: Optional[StudioSession]) -> str:
    _ = session
    from agenticx.memory.session_store import session_fts_enabled

    store = SessionStore()
    raw_q = str(arguments.get("query", "") or "").strip()
    role_raw = str(arguments.get("role_filter", "") or "").strip()
    role_parts = [x.strip().lower() for x in role_raw.split(",") if x.strip()] if role_raw else None
    lim = int(arguments.get("limit", 3) or 3)
    lim = max(1, min(lim, 5))

    if not raw_q:
        rows = store._list_latest_sessions_sync(lim)
        sessions = [
            {
                "session_id": r["session_id"],
                "created_at": r["created_at"],
                "metadata": r["metadata"],
            }
            for r in rows
        ]
        return json.dumps({"mode": "recent", "sessions": sessions}, ensure_ascii=False)

    if not session_fts_enabled():
        return json.dumps({"mode": "search", "sessions": []}, ensure_ascii=False)

    hits = store._search_session_messages_sync(raw_q, role_parts, limit=500)
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for h in hits:
        sid = h["session_id"]
        if sid not in groups:
            if len(groups) >= lim:
                continue
            groups[sid] = []
        groups[sid].append(h)

    def _truncate_hits(items: List[Dict[str, Any]], max_chars: int = 10_000) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        total = 0
        for it in items:
            frag = json.dumps(it, ensure_ascii=False)
            if total + len(frag) > max_chars and out:
                break
            out.append(it)
            total += len(frag) + 1
        return out

    sessions_out = [{"session_id": sid, "hits": _truncate_hits(items)} for sid, items in groups.items()]
    return json.dumps({"mode": "search", "sessions": sessions_out}, ensure_ascii=False)


def _should_queue_skill_write() -> bool:
    from agenticx.learning.config import get_learning_config

    cfg = get_learning_config()
    if bool(cfg.get("agent_writes_require_approval", True)):
        return True
    if bool(cfg.get("freeze_during_session", True)):
        try:
            from agenticx.runtime.session_freeze import is_frozen

            return is_frozen()
        except Exception:
            return False
    return False


def _queue_skill_proposal(
    *,
    action: str,
    name: str,
    skill_md_text: str,
    session: Optional[StudioSession],
    diff_summary: str = "",
    candidate_index: int = 1,
    total_candidates: int = 1,
    review_model: str = "",
    scores: Optional[Dict[str, float]] = None,
) -> str:
    from agenticx.learning.gepa_proposer import write_proposal

    session_id = ""
    if session is not None:
        session_id = str(
            getattr(session, "_session_id", "")
            or getattr(session, "_usage_owner_session_id", "")
            or getattr(session, "session_id", "")
            or ""
        ).strip()
        if not review_model:
            review_model = str(getattr(session, "model_name", "") or "").strip()
    pdir = write_proposal(
        base_skill=name,
        action=action,
        skill_md_text=skill_md_text,
        session_id=session_id,
        review_model=review_model,
        diff_summary=diff_summary,
        candidate_index=candidate_index,
        total_candidates=total_candidates,
        scores=scores,
    )
    pid = pdir.name
    payload: Dict[str, Any] = {
        "ok": True,
        "action": f"{action}_pending",
        "name": name,
        "path": str(pdir / "SKILL.md"),
        "proposal_id": pid,
        "message": f"Proposal queued for approval: {pid}",
    }
    return json.dumps(payload, ensure_ascii=False)


def _skill_manage_success_payload(
    *,
    action: str,
    skill_md: Path,
    discoverable: bool,
    skill_name: Optional[str],
    frontmatter_fixed: List[str],
    validation_warnings: List[str],
    extra: Optional[Dict[str, Any]] = None,
) -> str:
    payload: Dict[str, Any] = {
        "ok": True,
        "action": action,
        "path": str(skill_md),
        "discoverable": discoverable,
        "skill_name": skill_name,
        "frontmatter_fixed": frontmatter_fixed,
        "validation_warnings": validation_warnings,
    }
    if extra:
        payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)


def _write_skill_md_with_checks(
    *,
    action: str,
    skill_dir: Path,
    content: str,
    canonical_name: str,
    on_rollback: Optional[Any] = None,
    extra: Optional[Dict[str, Any]] = None,
    skip_queue: bool = False,
) -> Tuple[Optional[str], Optional[str]]:
    """Normalize, write, guard-scan, and verify discoverability.

    Returns:
        (success_json, error_message) — exactly one is non-None.
    """
    from agenticx.skills.frontmatter import (
        SkillFrontmatterError,
        normalize_skill_md,
        verify_skill_discoverable,
    )

    try:
        normalized, frontmatter_fixed = normalize_skill_md(content, canonical_name)
    except SkillFrontmatterError as exc:
        return None, f"ERROR: {exc}"

    if action == "create":
        from agenticx.skills.frontmatter import ensure_skill_source, write_skill_provenance

        normalized = ensure_skill_source(normalized, "agent_created")

    from agenticx.learning.config import get_learning_config
    from agenticx.learning.skill_quality_gate import check_size_limits
    from agenticx.skills.frontmatter import get_description_from_frontmatter

    _cfg = get_learning_config()
    _desc = get_description_from_frontmatter(normalized) or ""
    _size = check_size_limits(
        normalized,
        _desc,
        max_bytes=int(_cfg.get("max_skill_bytes", 15360)),
        max_desc_chars=int(_cfg.get("max_description_chars", 500)),
    )
    if not _size["ok"]:
        return None, _skill_manage_error("size_limit", f"{_size['error']}. {_size['hint']}")

    session_obj = extra.get("_session") if isinstance(extra, dict) else None
    if not skip_queue and _should_queue_skill_write():
        queued = _queue_skill_proposal(
            action=action,
            name=canonical_name,
            skill_md_text=normalized,
            session=session_obj,
        )
        if on_rollback:
            on_rollback()
        return queued, None

    # Defense-in-depth: block classic remote pipe-to-shell patterns even if
    # guard pattern sets or confidence filters drift over time.
    if re.search(r"(curl|wget)[^\n]*\|\s*(?:ba)?sh\b", normalized, re.IGNORECASE):
        return None, _skill_manage_error("policy", "危险命令模式：检测到远程下载并管道执行 shell")

    validation_warnings: List[str] = []
    skill_md = skill_dir / "SKILL.md"
    try:
        skill_md.write_text(normalized, encoding="utf-8")
        if action == "create":
            from agenticx.skills.frontmatter import write_skill_provenance

            write_skill_provenance(skill_dir, "agent_created", extra={"name": canonical_name})
        result = scan_skill(skill_dir, source="agent-created")
        ok, reason = should_allow(result, "agent-created")
        if not ok:
            if on_rollback:
                on_rollback()
            else:
                skill_md.unlink(missing_ok=True)
            from agenticx.skills.guard import format_guard_rejection_message

            return None, format_guard_rejection_message(result, action=action)

        discoverable, skill_name, errors = verify_skill_discoverable(skill_dir)
        if not discoverable:
            if on_rollback:
                on_rollback()
            else:
                skill_md.unlink(missing_ok=True)
            detail = "; ".join(errors) if errors else "unknown parse failure"
            return None, f"ERROR: skill not discoverable after write ({detail})"

        return (
            _skill_manage_success_payload(
                action=action,
                skill_md=skill_md,
                discoverable=discoverable,
                skill_name=skill_name,
                frontmatter_fixed=frontmatter_fixed,
                validation_warnings=validation_warnings,
                extra=extra,
            ),
            None,
        )
    except OSError as exc:
        if on_rollback:
            on_rollback()
        else:
            skill_md.unlink(missing_ok=True)
        return None, f"ERROR: {exc}"


def _hook_manage_enabled() -> bool:
    """Whether hook_manage is allowed. Default-on; set AGX_HOOK_MANAGE=0 to disable."""
    v = os.environ.get("AGX_HOOK_MANAGE", "1").strip().lower()
    return v in {"1", "true", "yes", "on"}


def _scan_hook_command(command: str) -> Optional[str]:
    """Scan a command-type hook body for dangerous patterns via the skill guard.

    Returns a human-readable reason string when the command must be blocked,
    or ``None`` when it is allowed. Wraps the command in a fenced shell block so
    both v1 and v2 guard scanners inspect it.
    """
    try:
        from agenticx.skills.guard import scan_skill_markdown_text, should_allow
    except ImportError:
        return None
    fenced = f"```bash\n{command}\n```\n"
    try:
        result = scan_skill_markdown_text(fenced, source="agent-created")
        allowed, reason = should_allow(result, source="agent-created")
    except Exception:
        return None
    if not allowed:
        return reason
    return None


def _tool_hook_manage(arguments: Dict[str, Any], session: Optional[StudioSession]) -> str:  # noqa: ARG001
    """Implement the hook_manage agent tool — create/delete/list/toggle declarative hooks."""
    if not _hook_manage_enabled():
        return (
            "ERROR: hook_manage is disabled (AGX_HOOK_MANAGE=0). "
            "Re-enable it in settings to create/modify hooks."
        )
    action = str(arguments.get("action", "")).strip().lower()
    if action not in ("create", "delete", "list", "toggle"):
        return "ERROR: hook_manage requires action='create'|'delete'|'list'|'toggle'."

    try:
        from agenticx.cli.config_manager import ConfigManager
        from agenticx.hooks.list_api import invalidate_hooks_list_cache
    except ImportError as exc:
        return f"ERROR: config subsystem unavailable: {exc}"

    def _load_declarative() -> List[Dict[str, Any]]:
        raw = ConfigManager.get_value("hooks.declarative") or []
        return [d for d in raw if isinstance(d, dict)]

    def _save_declarative(entries: List[Dict[str, Any]]) -> None:
        ConfigManager.set_value("hooks.declarative", entries)
        invalidate_hooks_list_cache()

    if action == "list":
        entries = _load_declarative()
        if not entries:
            return json.dumps({"ok": True, "hooks": [], "count": 0}, ensure_ascii=False)
        return json.dumps({"ok": True, "hooks": entries, "count": len(entries)}, ensure_ascii=False)

    name = str(arguments.get("name", "")).strip()
    if not name:
        return "ERROR: 'name' is required for action='create'|'delete'|'toggle'."

    entries = _load_declarative()

    if action == "delete":
        new_entries = [e for e in entries if e.get("name") != name]
        if len(new_entries) == len(entries):
            return json.dumps({"ok": False, "error": f"hook '{name}' not found"}, ensure_ascii=False)
        _save_declarative(new_entries)
        return json.dumps({"ok": True, "action": "deleted", "name": name}, ensure_ascii=False)

    if action == "toggle":
        enabled_val = arguments.get("enabled")
        if enabled_val is None:
            return "ERROR: 'enabled' (true/false) is required for action='toggle'."
        target = next((e for e in entries if e.get("name") == name), None)
        if target is None:
            return json.dumps({"ok": False, "error": f"hook '{name}' not found"}, ensure_ascii=False)
        target["enabled"] = bool(enabled_val)
        _save_declarative(entries)
        state = "enabled" if bool(enabled_val) else "disabled"
        return json.dumps({"ok": True, "action": state, "name": name}, ensure_ascii=False)

    # action == "create"
    event = str(arguments.get("event", "")).strip()
    valid_events = {"before_tool_call", "after_tool_call", "session_start", "session_end"}
    if event not in valid_events:
        return f"ERROR: 'event' must be one of {sorted(valid_events)}."

    hook_type = str(arguments.get("type", "command")).strip()
    valid_types = {"command", "http", "prompt", "agent"}
    if hook_type not in valid_types:
        return f"ERROR: 'type' must be one of {sorted(valid_types)}."

    if hook_type == "command":
        cmd_body = str(arguments.get("command", "")).strip()
        if not cmd_body:
            return "ERROR: 'command' is required for type='command'."
        block_reason = _scan_hook_command(cmd_body)
        if block_reason:
            return json.dumps(
                {
                    "ok": False,
                    "error": f"command hook blocked by safety scan: {block_reason}",
                    "hint": "Revise the command to avoid dangerous patterns, or use type='http'/'prompt'/'agent'.",
                },
                ensure_ascii=False,
            )
    if hook_type == "http" and not str(arguments.get("url", "")).strip():
        return "ERROR: 'url' is required for type='http'."
    if hook_type in ("prompt", "agent") and not str(arguments.get("prompt", "")).strip():
        return "ERROR: 'prompt' is required for type='prompt'/'agent'."

    if any(e.get("name") == name for e in entries):
        return json.dumps({"ok": False, "error": f"hook '{name}' already exists; use delete first to replace."}, ensure_ascii=False)

    new_hook: Dict[str, Any] = {
        "name": name,
        "event": event,
        "type": hook_type,
        "enabled": True,
    }
    if hook_type == "command":
        new_hook["command"] = str(arguments.get("command", "")).strip()
    elif hook_type == "http":
        new_hook["url"] = str(arguments.get("url", "")).strip()
    elif hook_type in ("prompt", "agent"):
        new_hook["prompt"] = str(arguments.get("prompt", "")).strip()

    for opt_field in ("matcher", "block_on_failure", "timeout_seconds"):
        val = arguments.get(opt_field)
        if val is not None:
            new_hook[opt_field] = val

    entries.append(new_hook)
    _save_declarative(entries)
    return json.dumps({"ok": True, "action": "created", "hook": new_hook}, ensure_ascii=False)


async def _tool_skill_manage(
    arguments: Dict[str, Any],
    session: Optional[StudioSession],
    *,
    confirm_gate: Optional[ConfirmGate] = None,
    emit_event: Optional[Any] = None,
) -> str:
    _ = session
    if not _skill_manage_enabled():
        return (
            "ERROR: skill_manage is disabled. Set AGX_SKILL_MANAGE=1 "
            "or AGX_CONFIRM_STRATEGY=auto (Run Everything hook)."
        )
    # Interactive mode: user approves/rejects inline in the chat.
    # Non-interactive (e.g. session_review_hook): falls back to pending queue.
    _interactive = (
        emit_event is not None
        and confirm_gate is not None
        and confirm_gate.is_service_mode()
    )
    action = str(arguments.get("action", "") or "").strip().lower()
    if not action:
        return (
            "ERROR: 'action' is required. "
            "Call skill_manage with action='create'|'patch'|'delete'|'history'|'rollback', name=<skill-name>, "
            "and content=<full SKILL.md text> for create."
        )
    raw_name = str(arguments.get("name", "") or "").strip()
    if not raw_name:
        return (
            "ERROR: 'name' is required. "
            "Provide the skill directory name, e.g. name='my-skill' or name='ima/notes'."
        )
    name = _safe_skill_dir_name(raw_name)
    if name is None:
        return (
            f"ERROR: invalid skill name {raw_name!r}. "
            "Name must be alphanumeric with hyphens/underscores. "
            "Sub-paths like 'ima/notes' are allowed; spaces and leading dots are not."
        )
    root = _agent_created_skill_root().expanduser().resolve(strict=False)
    skill_dir = (root / name).resolve(strict=False)
    try:
        skill_dir.relative_to(root)
    except ValueError:
        return "ERROR: skill path outside skills root"

    if action == "create":
        content, content_err = _resolve_skill_create_content(arguments, session)
        if content_err:
            return content_err
        assert content is not None
        if skill_dir.exists():
            return "ERROR: skill already exists"
        from agenticx.skills.frontmatter import SkillFrontmatterError, normalize_skill_md

        try:
            normalize_skill_md(content, name)
        except SkillFrontmatterError as exc:
            return f"ERROR: {exc}"
        if _interactive:
            preview = content[:400] + ("\n\n…（已截断）" if len(content) > 400 else "")
            approved = await _confirm(
                f"skill_manage 请求**创建**新技能「{name}」\n\n内容预览：\n\n```\n{preview}\n```\n\n确认写入 `$AGX_HOME/skills/{name}/SKILL.md`？",
                confirm_gate=confirm_gate,  # type: ignore[arg-type]
                context={
                    "tool": "skill_manage",
                    "action": "create",
                    "skill": name,
                    "risk": "policy",
                    "approval_reuse": "none",
                    "risk_categories": [
                        _risk_finding("agent_extension_change", "创建本地技能")
                    ],
                },
                emit_event=emit_event,
            )
            if not approved:
                return "CANCELLED: 用户拒绝了 skill_manage create 操作"
        skill_dir.mkdir(parents=True, exist_ok=True)
        success, err = _write_skill_md_with_checks(
            action="create",
            skill_dir=skill_dir,
            content=content,
            canonical_name=name,
            on_rollback=lambda: shutil.rmtree(skill_dir, ignore_errors=True),
            extra={"_session": session},
            skip_queue=_interactive,
        )
        if err:
            if skill_dir.exists() and not (skill_dir / "SKILL.md").is_file():
                shutil.rmtree(skill_dir, ignore_errors=True)
            return err
        try:
            from agenticx.skills.versioning import append_changelog

            append_changelog(skill_dir, action="create", summary="agent-created skill")
        except Exception:
            pass
        return success or "ERROR: unknown create failure"

    if action == "patch":
        old_s = str(arguments.get("old_string", ""))
        new_s = str(arguments.get("new_string", ""))
        mode = str(arguments.get("mode", "apply") or "apply").strip().lower()
        if mode not in {"preview", "apply"}:
            return _skill_manage_error("validation", "mode must be 'preview' or 'apply'")
        replace_all = bool(arguments.get("replace_all", False))
        before_context = str(arguments.get("before_context", "") or "")
        after_context = str(arguments.get("after_context", "") or "")
        target_index_raw = arguments.get("target_index")
        target_index: Optional[int] = None
        if target_index_raw is not None:
            try:
                target_index = int(target_index_raw)
            except Exception:
                return _skill_manage_error("validation", "target_index must be an integer")
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            return _skill_manage_error("validation", "SKILL.md not found")
        try:
            original = skill_md.read_text(encoding="utf-8")
        except OSError as exc:
            return _skill_manage_error("validation", f"read failed: {exc}")
        from agenticx.skills.fuzzy_patch import fuzzy_find_and_replace, fuzzy_find_matches
        from agenticx.skills.guard import scan_skill_markdown_text

        matches_info = fuzzy_find_matches(
            original,
            old_s,
            before_context=before_context,
            after_context=after_context,
        )
        if matches_info.get("error"):
            return _skill_manage_error("validation", str(matches_info["error"]))
        ranges = list(matches_info.get("matches", []))
        strategy = str(matches_info.get("strategy", "") or "")
        if not ranges:
            return _skill_manage_error("validation", "Could not find a match for old_string in the file")
        if len(ranges) > 1 and not replace_all:
            if target_index is None:
                payload = {
                    "ok": False,
                    "action": "patch",
                    "mode": mode,
                    "requires_target_selection": True,
                    "strategy": strategy,
                    "match_count": len(ranges),
                    "target_ranges": ranges,
                }
                return json.dumps(payload, ensure_ascii=False)
            if target_index < 0 or target_index >= len(ranges):
                return _skill_manage_error("validation", "target_index out of range")
            selected = ranges[target_index]
            ranges = [selected]
            s = int(selected.get("start", 0))
            e = int(selected.get("end", s))
            before_context = original[max(0, s - 80) : s]
            after_context = original[e : min(len(original), e + 80)]
            replace_all = False

        updated, match_count, strategy2, match_err = fuzzy_find_and_replace(
            original,
            old_s,
            new_s,
            replace_all=replace_all,
            before_context=before_context,
            after_context=after_context,
        )
        if match_err:
            return _skill_manage_error("validation", match_err)
        strategy = strategy2 or strategy

        old_hash = hashlib.sha256(original.encode("utf-8")).hexdigest()
        token_payload = _skill_patch_token_payload(
            name=name,
            strategy=strategy or "exact",
            old_hash=old_hash,
            old_string=old_s,
            new_string=new_s,
            before_context=before_context,
            after_context=after_context,
            ranges=ranges,
        )
        patch_token = _encode_patch_token(token_payload)
        quick_result = scan_skill_markdown_text(updated, source="agent-created")
        quick_allowed, quick_reason = should_allow(quick_result, "agent-created")
        preview_payload = {
            "ok": True,
            "action": "patch",
            "mode": "preview",
            "strategy": strategy,
            "match_count": match_count,
            "target_ranges": ranges,
            "old_sha256": old_hash,
            "new_sha256": hashlib.sha256(updated.encode("utf-8")).hexdigest(),
            "patch_token": patch_token,
            "risk": {
                "verdict": quick_result.verdict,
                "allowed": quick_allowed,
                "reason": quick_reason,
                "findings": [f.pattern_name for f in quick_result.findings[:8]],
            },
            "diff": "\n".join(
                difflib.unified_diff(
                    original.splitlines(),
                    updated.splitlines(),
                    fromfile="SKILL.md (old)",
                    tofile="SKILL.md (new)",
                    lineterm="",
                )
            ),
        }
        if mode == "preview":
            return json.dumps(preview_payload, ensure_ascii=False)

        token_arg = str(arguments.get("patch_token", "") or "").strip()
        if token_arg:
            decoded, token_err = _decode_patch_token(token_arg)
            if token_err:
                return _skill_manage_error("validation", token_err)
            assert decoded is not None
            if str(decoded.get("name", "")) != name:
                return _skill_manage_error("validation", "patch token skill mismatch")
            if str(decoded.get("old_hash", "")) != old_hash:
                return _skill_manage_error("validation", "patch token outdated: file changed since preview")
            if str(decoded.get("old_string_sha256", "")) != hashlib.sha256(old_s.encode("utf-8")).hexdigest():
                return _skill_manage_error("validation", "patch token old_string mismatch")
            if str(decoded.get("new_string_sha256", "")) != hashlib.sha256(new_s.encode("utf-8")).hexdigest():
                return _skill_manage_error("validation", "patch token new_string mismatch")
            if str(decoded.get("before_context_sha256", "")) != (
                hashlib.sha256(before_context.encode("utf-8")).hexdigest() if before_context else ""
            ):
                return _skill_manage_error("validation", "patch token before_context mismatch")
            if str(decoded.get("after_context_sha256", "")) != (
                hashlib.sha256(after_context.encode("utf-8")).hexdigest() if after_context else ""
            ):
                return _skill_manage_error("validation", "patch token after_context mismatch")

        backup = original

        def _rollback_patch() -> None:
            skill_md.write_text(backup, encoding="utf-8")

        if _interactive:
            old_preview = old_s[:200] + ("…" if len(old_s) > 200 else "")
            new_preview = new_s[:200] + ("…" if len(new_s) > 200 else "")
            approved = await _confirm(
                f"skill_manage 请求**修改**技能「{name}」（{match_count} 处替换）\n\n"
                f"**旧内容：**\n```\n{old_preview}\n```\n\n"
                f"**新内容：**\n```\n{new_preview}\n```\n\n"
                f"确认应用补丁？",
                confirm_gate=confirm_gate,  # type: ignore[arg-type]
                context={
                    "tool": "skill_manage",
                    "action": "patch",
                    "skill": name,
                    "risk": "policy",
                    "approval_reuse": "none",
                    "risk_categories": [
                        _risk_finding("agent_extension_change", "修改本地技能")
                    ],
                },
                emit_event=emit_event,
            )
            if not approved:
                return "CANCELLED: 用户拒绝了 skill_manage patch 操作"

        try:
            from agenticx.skills.skill_versions import save_snapshot

            save_snapshot(
                skills_root=root,
                skill_name=name,
                content=original,
                actor="agent",
                session_id=str(getattr(session, "session_id", "") or ""),
                summary=f"pre-patch fuzzy:{strategy}",
            )
        except Exception:
            pass

        success, err = _write_skill_md_with_checks(
            action="patch",
            skill_dir=skill_dir,
            content=updated,
            canonical_name=name,
            on_rollback=_rollback_patch,
            extra={"strategy": strategy, "matches": match_count, "mode": "apply", "_session": session},
            skip_queue=_interactive,
        )
        if err:
            if err.startswith("ERROR: 技能内容被安全策略拦截"):
                return _skill_manage_error("policy", err)
            return _skill_manage_error("validation", err)
        try:
            from agenticx.skills.versioning import append_changelog

            append_changelog(
                skill_dir,
                action="patch",
                summary=f"fuzzy:{strategy}, {match_count} replacement(s)",
            )
        except Exception:
            pass
        return success or _skill_manage_error("validation", "unknown patch failure")

    if action == "delete":
        if not skill_dir.exists():
            return json.dumps({"ok": True, "action": "delete", "removed": False}, ensure_ascii=False)
        if _interactive:
            approved = await _confirm(
                f"skill_manage 请求**删除**技能「{name}」\n\n路径：`$AGX_HOME/skills/{name}/`\n\n此操作不可撤销（除非系统有版本快照），确认删除？",
                confirm_gate=confirm_gate,  # type: ignore[arg-type]
                context={
                    "tool": "skill_manage",
                    "action": "delete",
                    "skill": name,
                    "risk": "destructive",
                    "approval_reuse": "none",
                    "risk_categories": [
                        _risk_finding("agent_extension_change", "删除本地技能"),
                        _risk_finding("destructive_filesystem", "技能删除不可逆"),
                    ],
                },
                emit_event=emit_event,
            )
            if not approved:
                return "CANCELLED: 用户拒绝了 skill_manage delete 操作"
        try:
            from agenticx.skills.versioning import append_changelog
            append_changelog(skill_dir, action="delete", summary="skill deleted by agent")
        except Exception:
            pass
        try:
            shutil.rmtree(skill_dir)
        except OSError as exc:
            return f"ERROR: delete failed: {exc}"
        return json.dumps({"ok": True, "action": "delete", "removed": True}, ensure_ascii=False)

    if action == "history":
        limit = int(arguments.get("limit", 50) or 50)
        limit = max(1, min(limit, 200))
        try:
            from agenticx.skills.skill_versions import list_versions

            versions = list_versions(skills_root=root, skill_name=name, limit=limit)
        except Exception as exc:
            return _skill_manage_error("validation", f"history failed: {exc}")
        payload = {
            "ok": True,
            "action": "history",
            "name": name,
            "versions": [
                {
                    "version": v.version,
                    "created_at": v.created_at,
                    "actor": v.actor,
                    "session_id": v.session_id,
                    "content_sha256": v.content_sha256,
                    "summary": v.summary,
                }
                for v in versions
            ],
        }
        return json.dumps(payload, ensure_ascii=False)

    if action == "rollback":
        to_version = str(arguments.get("to_version", "") or "").strip()
        if not to_version:
            return _skill_manage_error("validation", "to_version is required for rollback")
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            return _skill_manage_error("validation", "SKILL.md not found")
        try:
            from agenticx.skills.skill_versions import get_version_content, save_snapshot
        except Exception as exc:
            return _skill_manage_error("validation", f"versioning unavailable: {exc}")
        try:
            original = skill_md.read_text(encoding="utf-8")
            target = get_version_content(skills_root=root, skill_name=name, version=to_version)
        except FileNotFoundError as exc:
            return _skill_manage_error("validation", str(exc))
        except Exception as exc:
            return _skill_manage_error("validation", f"rollback read failed: {exc}")

        def _rollback_original() -> None:
            skill_md.write_text(original, encoding="utf-8")

        try:
            save_snapshot(
                skills_root=root,
                skill_name=name,
                content=original,
                actor="agent",
                session_id=str(getattr(session, "session_id", "") or ""),
                summary=f"pre-rollback -> {to_version}",
            )
        except Exception:
            pass

        success, err = _write_skill_md_with_checks(
            action="rollback",
            skill_dir=skill_dir,
            content=target,
            canonical_name=name,
            on_rollback=_rollback_original,
            extra={"to_version": to_version, "_session": session},
        )
        if err:
            if err.startswith("ERROR: 技能内容被安全策略拦截"):
                return _skill_manage_error("policy", err)
            return _skill_manage_error("validation", err)
        try:
            from agenticx.skills.versioning import append_changelog

            append_changelog(skill_dir, action="edit", summary=f"rollback to {to_version}")
        except Exception:
            pass
        return success or _skill_manage_error("validation", "unknown rollback failure")

    return "ERROR: unknown action"


def _tool_skill_import_repo(arguments: Dict[str, Any], session: Optional[StudioSession]) -> str:
    _ = session
    if not _skill_manage_enabled():
        return (
            "ERROR: skill_import_repo is disabled. Set AGX_SKILL_MANAGE=1 "
            "or AGX_CONFIRM_STRATEGY=auto (Run Everything hook)."
        )
    repo = str(arguments.get("repo", "") or "").strip()
    if not repo:
        return "ERROR: repo is required (owner/name)"
    branch = str(arguments.get("branch", "main") or "main").strip() or "main"
    path_glob = str(arguments.get("path_glob", "skills/**/SKILL.md") or "skills/**/SKILL.md").strip()
    exclude_raw = arguments.get("exclude")
    exclude: Optional[List[str]] = None
    if isinstance(exclude_raw, list):
        exclude = [str(x) for x in exclude_raw if str(x).strip()]
    dry_run = bool(arguments.get("dry_run", False))
    overwrite = bool(arguments.get("overwrite", False))
    from agenticx.skills.import_repo import import_skills_from_repo, result_to_json

    result = import_skills_from_repo(
        repo=repo,
        branch=branch,
        path_glob=path_glob,
        exclude=exclude,
        dry_run=dry_run,
        overwrite=overwrite,
    )
    return result_to_json(result)


def _tool_ask_user(arguments: Dict[str, Any], *, service_mode: bool = False) -> str:
    if service_mode:
        return (
            "ERROR: ask_user is not supported in service mode; "
            "use the request_clarification tool to ask the user an open-ended question."
        )
    question = str(arguments.get("question", "")).strip()
    if not question:
        return "ERROR: missing question"
    answer = input(f"{question}\n> ").strip()
    return answer or "(empty)"


_LIST_FILES_IGNORED_DIR_NAMES = frozenset(
    {
        # VCS / editor metadata and generated dependency trees.
        ".git",
        ".hg",
        ".svn",
        ".bzr",
        ".idea",
        ".vscode",
        "node_modules",
        "bower_components",
        "vendor",
        "third_party",
        # Python / JavaScript / Rust build and cache output.
        "__pycache__",
        ".venv",
        "venv",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".nox",
        ".cache",
        ".parcel-cache",
        ".next",
        ".nuxt",
        ".turbo",
        "coverage",
        "dist",
        "build",
        "target",
    }
)
_LIST_FILES_IGNORED_FILE_SUFFIXES = (".pyc", ".pyo")


def _list_files_entry_is_ignored(name: str, *, is_dir: bool) -> bool:
    """Whether a directory entry is generated/internal noise for list_files.

    Hidden entries are omitted deliberately: list_files is primarily a source and
    artifact discovery tool, and exposing ``.git``/``.agenticx`` internals makes a
    recursive call both noisy and needlessly expensive.  The caller's explicitly
    resolved root is still honored; this predicate only applies to its children.
    """
    if name.startswith("."):
        return True
    if name in _LIST_FILES_IGNORED_DIR_NAMES or name.endswith(".egg-info"):
        return True
    if is_dir:
        return False
    return name.endswith(_LIST_FILES_IGNORED_FILE_SUFFIXES)


def _iter_list_files_entries(
    root: Path,
    *,
    recursive: bool,
) -> Iterator[Tuple[Path, bool]]:
    """Yield visible ``(path, is_directory)`` entries with bounded traversal.

    ``os.scandir`` is kept as a stack of live iterators instead of converting a
    whole subtree to ``Path.rglob``/lists.  The consumer can stop after the
    requested limit plus one probe entry, which closes the generator and all
    outstanding directory iterators.  ``follow_symlinks=False`` and the explicit
    symlink check ensure a link to an external directory is listed at most as one
    entry and is never descended into.
    """
    def _close_scandir(iterator: Any) -> None:
        close = getattr(iterator, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass

    stack: List[Tuple[Path, Iterator[Any]]] = []
    try:
        stack.append((root, os.scandir(root)))
    except OSError:
        return

    try:
        while stack:
            _current, entries = stack[-1]
            try:
                entry = next(entries)
            except StopIteration:
                _close_scandir(entries)
                stack.pop()
                continue
            except OSError:
                _close_scandir(entries)
                stack.pop()
                continue

            try:
                # Do not follow a symlink even for the is_dir check.  A regular
                # directory is the only kind allowed onto the traversal stack.
                is_symlink = entry.is_symlink()
                is_dir = (not is_symlink) and entry.is_dir(follow_symlinks=False)
                if _list_files_entry_is_ignored(entry.name, is_dir=is_dir):
                    continue
            except OSError:
                # Entries can disappear or become inaccessible while the agent is
                # scanning.  Match pathlib's best-effort behavior and continue.
                continue

            item = Path(entry.path)
            yield item, is_dir
            if recursive and is_dir:
                try:
                    stack.append((item, os.scandir(item)))
                except OSError:
                    continue
    finally:
        for _current, entries in stack:
            _close_scandir(entries)


def _tool_list_files(arguments: Dict[str, Any], session: Optional[StudioSession] = None) -> str:
    path_arg = str(arguments.get("path", "."))
    try:
        root = _resolve_workspace_path(path_arg, session, pick_existing=True)
    except ValueError as exc:
        return f"ERROR: {exc}"
    recursive = bool(arguments.get("recursive", False))
    limit = int(arguments.get("limit", 200) or 200)
    if limit < 1:
        limit = 1
    if limit > 2000:
        limit = 2000
    if not root.exists():
        return f"ERROR: path not found: {root}"
    if not root.is_dir():
        return f"ERROR: not a directory: {root}"

    lines: List[str] = []
    truncated = False
    entries = _iter_list_files_entries(root, recursive=recursive)
    try:
        for index, (item, is_dir) in enumerate(entries):
            if index >= limit:
                truncated = True
                break
            suffix = "/" if is_dir else ""
            lines.append(str(item) + suffix)
    finally:
        # Explicitly close the generator on the limit probe so a large scan does
        # not retain open directory descriptors until a later garbage-collection
        # cycle (the generator itself also closes them on normal exhaustion).
        close = getattr(entries, "close", None)
        if callable(close):
            close()
    if truncated:
        # The old implementation reported an exact total after fully walking the
        # tree.  That exact count is precisely the unbounded work this tool must
        # avoid, so retain the established marker shape with a truthful lower
        # bound instead.
        lines.append(f"... (truncated, total >{limit} entries)")
    return "\n".join(lines) if lines else "(empty directory)"


async def _tool_install_portable_package(
    arguments: Dict[str, Any],
    session: Optional[StudioSession],
    *,
    confirm_gate: ConfirmGate,
    emit_event: Optional[Any] = None,
) -> str:
    """Validate, confirm, then install one data-only expert/group package."""
    raw_path = str(arguments.get("path", "") or "").strip()
    if not raw_path:
        return json.dumps(
            {"ok": False, "error": "path is required"},
            ensure_ascii=False,
        )
    try:
        package_path = _resolve_workspace_path(raw_path, session, pick_existing=True)
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    lower_name = package_path.name.lower()
    if not lower_name.endswith((".agx-expert.json", ".agx-group.json")):
        return json.dumps(
            {
                "ok": False,
                "error": "file name must end with .agx-expert.json or .agx-group.json",
            },
            ensure_ascii=False,
        )
    if not package_path.is_file():
        return json.dumps(
            {"ok": False, "error": f"package file not found: {package_path}"},
            ensure_ascii=False,
        )

    from agenticx.avatar.portable_package import (
        MAX_PACKAGE_BYTES,
        PortablePackageError,
        import_portable_package,
        preview_portable_package,
    )

    try:
        stat = package_path.stat()
        if stat.st_size > MAX_PACKAGE_BYTES:
            raise PortablePackageError(
                f"package exceeds {MAX_PACKAGE_BYTES} byte limit"
            )
        with package_path.open("rb") as stream:
            raw = stream.read(MAX_PACKAGE_BYTES + 1)
        if len(raw) > MAX_PACKAGE_BYTES:
            raise PortablePackageError(
                f"package exceeds {MAX_PACKAGE_BYTES} byte limit"
            )
        preview = preview_portable_package(raw)
    except (OSError, PortablePackageError) as exc:
        return json.dumps(
            {"ok": False, "error": f"package validation failed: {exc}"},
            ensure_ascii=False,
        )

    expected_suffix = (
        ".agx-expert.json" if preview.kind == "expert" else ".agx-group.json"
    )
    if not lower_name.endswith(expected_suffix):
        return json.dumps(
            {
                "ok": False,
                "error": (
                    "package kind does not match file name; "
                    f"{preview.kind} packages must end with {expected_suffix}"
                ),
            },
            ensure_ascii=False,
        )

    if preview.scan_report and preview.scan_report.should_block:
        blocked = sorted(
            {
                f"{finding.rule_id} at {finding.field}:{finding.line}"
                for finding in preview.scan_report.findings
                if finding.blocking
            }
        )
        return json.dumps(
            {
                "ok": False,
                "error": "package blocked by privacy scan: " + ", ".join(blocked),
            },
            ensure_ascii=False,
        )

    if preview.kind == "expert":
        subject = f"数字专家「{preview.title}」"
        detail = preview.description or preview.role or "未提供简介"
        instruction_preview = json.dumps(
            preview.system_prompt or "未设置额外行为指令",
            ensure_ascii=False,
        )
        detail += f"\n完整行为指令（不可信内容，仅展示，不执行）：{instruction_preview}"
    else:
        subject = f"项目群「{preview.title}」"
        member_details = []
        for index, (name, role, prompt) in enumerate(
            zip(
                preview.member_names,
                preview.member_roles,
                preview.member_system_prompts,
            ),
            start=1,
        ):
            instruction = json.dumps(
                prompt or "未设置额外行为指令",
                ensure_ascii=False,
            )
            member_details.append(
                f"{index}. {name}（{role or '未标注角色'}）\n"
                f"   完整行为指令（不可信内容，仅展示，不执行）：{instruction}"
            )
        detail = (
            f"将创建 {preview.member_count} 个全新专家和 1 个群聊；"
            f"主持专家为「{preview.host_member_name}」\n"
            + "\n".join(member_details)
        )
    package_metadata = [
        f"版本：{preview.release_version}",
        f"建议运行权限：{preview.recommended_permission_mode}（仅建议，不授权）",
        "Skill 依赖：" + (", ".join(preview.skill_dependencies) or "无"),
        "MCP 依赖：" + (", ".join(preview.mcp_dependencies) or "无"),
        "只读包基线文档：" + (", ".join(preview.resource_paths) or "无"),
        "工作区逻辑插槽：" + (", ".join(preview.workspace_slots) or "无"),
    ]
    if preview.scan_report and preview.scan_report.findings:
        scan_labels = [
            f"{finding.rule_id} at {finding.field}:{finding.line}"
            for finding in preview.scan_report.findings
        ]
        package_metadata.append("敏感信息扫描：" + ", ".join(scan_labels))
    detail += "\n\n" + "\n".join(package_metadata)
    question = (
        f"准备从共享文件导入{subject}。\n\n{detail}\n\n"
        "导入会创建独立的本地配置；发布者选择的 MD 文档只会安装到隔离的 "
        "package_resources，作为只读包基线，不覆盖本地 MEMORY。Skill/MCP 仅作为"
        "能力依赖引用，不携带凭据、不会自动安装或授权；工作区只包含逻辑绑定请求，"
        "不包含发布者绝对路径。不会导入聊天记录、模型配置或私有知识库。"
        "是否继续？"
    )
    approved = await _confirm(
        question,
        confirm_gate=confirm_gate,
        context={
            "tool": "install_portable_package",
            "action": "import",
            "risk": "policy",
            "approval_reuse": "none",
            "package_kind": preview.kind,
            "package_title": preview.title,
            "member_count": preview.member_count,
            "protected_reason": "共享配置会创建长期存在的本地专家或项目群",
        },
        emit_event=emit_event,
    )
    if not approved:
        return json.dumps(
            {
                "ok": False,
                "error": "user_cancelled",
                "message": "用户已取消导入。",
            },
            ensure_ascii=False,
        )

    try:
        result = await asyncio.to_thread(import_portable_package, raw)
    except PortablePackageError as exc:
        return json.dumps(
            {"ok": False, "error": f"package import failed: {exc}"},
            ensure_ascii=False,
        )
    if result.kind == "expert" and result.expert is not None:
        return json.dumps(
            {
                "ok": True,
                "kind": "expert",
                "avatar_id": result.expert.id,
                "name": result.expert.name,
                "message": f"数字专家「{result.expert.name}」已导入。",
            },
            ensure_ascii=False,
        )
    if result.kind == "group" and result.group is not None:
        return json.dumps(
            {
                "ok": True,
                "kind": "group",
                "group_id": result.group.id,
                "name": result.group.name,
                "member_ids": [member.id for member in result.members],
                "member_names": [member.name for member in result.members],
                "host_avatar_id": result.group.host_avatar_id,
                "message": (
                    f"项目群「{result.group.name}」及 {len(result.members)} 位专家已导入。"
                ),
            },
            ensure_ascii=False,
        )
    return json.dumps(
        {"ok": False, "error": "package import returned no entity"},
        ensure_ascii=False,
    )


async def _tool_liteparse(arguments: Dict[str, Any], session: Optional[StudioSession] = None) -> str:
    """Parse one document strictly via LiteParse adapter."""
    raw_path = str(arguments.get("path", "")).strip()
    if not raw_path:
        return "ERROR: missing required parameter 'path'."
    try:
        path = _resolve_workspace_path(raw_path, session, pick_existing=True)
    except ValueError as exc:
        return f"ERROR: {exc}"
    if not path.exists():
        return f"ERROR: file not found: {path}"
    if path.is_dir():
        return f"ERROR: expected a file path, got directory: {path}"

    from agenticx.tools.adapters.liteparse import LiteParseAdapter

    if not LiteParseAdapter.is_available():
        return (
            "ERROR: liteparse CLI is not available. "
            "Install with: npm i -g @llamaindex/liteparse"
        )

    try:
        adapter = LiteParseAdapter(config={"debug": False})
        content = await adapter.parse_to_text(path)
    except Exception as exc:
        return f"ERROR: liteparse parsing failed: {exc}"

    if not content.strip():
        return "ERROR: liteparse returned empty content."
    return content


def _video_understand_settings() -> Dict[str, Any]:
    """Read video_understanding.* from config with safe fallbacks."""

    def _int(key: str, default: int) -> int:
        raw = ConfigManager.get_value(f"video_understanding.{key}")
        try:
            return int(raw) if raw is not None else default
        except (TypeError, ValueError):
            return default

    def _float(key: str, default: float) -> float:
        raw = ConfigManager.get_value(f"video_understanding.{key}")
        try:
            return float(raw) if raw is not None else default
        except (TypeError, ValueError):
            return default

    def _bool(key: str, default: bool) -> bool:
        raw = ConfigManager.get_value(f"video_understanding.{key}")
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str):
            return raw.strip().lower() in {"1", "true", "yes", "on"}
        return default

    def _str(key: str, default: str) -> str:
        raw = ConfigManager.get_value(f"video_understanding.{key}")
        if raw is None:
            return default
        return str(raw)

    max_frames = min(
        _int("max_frames", _VIDEO_UNDERSTAND_DEFAULT_MAX_FRAMES),
        _VIDEO_UNDERSTAND_HARD_MAX_FRAMES,
    )
    return {
        "max_frames": max(1, max_frames),
        "interval_seconds": max(
            1.0,
            _float("interval_seconds", _VIDEO_UNDERSTAND_DEFAULT_INTERVAL_SECONDS),
        ),
        "min_frames": max(1, _int("min_frames", _VIDEO_UNDERSTAND_MIN_FRAMES)),
        "use_scene_detection": _bool("use_scene_detection", False),
        "enable_audio_transcription": _bool("enable_audio_transcription", True),
        "transcription_language": _str("transcription_language", "").strip(),
    }


async def _transcribe_video_audio(audio_path: Path, language: str) -> tuple[str, str]:
    """Best-effort audio transcription that never breaks video visual flow."""
    try:
        # Inline import avoids circular dependency:
        # voice_endpoints imports STUDIO_TOOLS/dispatch_tool_async from this module.
        from agenticx.studio.voice_endpoints import (
            _resolve_transcribe_provider,
            _transcribe_doubao_flash,
            _transcribe_openai_whisper,
        )
    except Exception as exc:
        return "", f"transcription module unavailable: {exc}"

    try:
        provider = _resolve_transcribe_provider()
    except Exception as exc:
        return "", f"transcribe provider resolve failed: {exc}"
    if not provider:
        return "", "no transcription backend configured (see 设置 → 语音)"

    try:
        raw = audio_path.read_bytes()
    except OSError as exc:
        return "", f"cannot read extracted audio: {exc}"

    try:
        if provider == "openai_whisper":
            text = await _transcribe_openai_whisper(
                raw,
                filename=audio_path.name,
                content_type="audio/mpeg",
                language=(language or "zh"),
            )
        elif provider == "doubao_flash":
            text = await _transcribe_doubao_flash(raw)
        else:
            return "", f"unknown transcription provider: {provider}"
    except Exception as exc:
        return "", f"transcription failed ({provider}): {exc}"
    return (text or "").strip(), ""


async def _tool_video_understand(arguments: Dict[str, Any], session: Optional[StudioSession] = None) -> str:
    """Probe and extract representative video frames, then stage for vision input."""
    raw_path = str(arguments.get("path", "")).strip()
    if not raw_path:
        return "ERROR: missing required parameter 'path'."

    if not _session_vision_capable(session):
        model = str(getattr(session, "model_name", "") or "unknown")
        return (
            f"ERROR: current model '{model}' does not support vision; "
            "switch to a vision-capable model before understanding a video."
        )

    try:
        path = _resolve_workspace_path(raw_path, session, pick_existing=True)
    except ValueError as exc:
        return f"ERROR: {exc}"
    if not path.exists() or not path.is_file():
        return f"ERROR: video not found: {path}"

    ext = path.suffix.lower()
    if ext not in VideoFrameExtractor.SUPPORTED_FORMATS:
        return (
            f"ERROR: unsupported video format '{ext}'. "
            f"Supported: {', '.join(VideoFrameExtractor.SUPPORTED_FORMATS)}"
        )

    try:
        size = path.stat().st_size
    except OSError as exc:
        return f"ERROR: cannot stat video: {exc}"
    if size > _VIDEO_UNDERSTAND_MAX_VIDEO_BYTES:
        return f"ERROR: video too large ({size // (1024 * 1024)} MB); limit is 512 MB."

    if not VideoFrameExtractor.is_available():
        return (
            "ERROR: ffmpeg/ffprobe not found. Install with: brew install ffmpeg "
            "(macOS) or your platform package manager."
        )

    settings = _video_understand_settings()
    req_max = arguments.get("max_frames")
    if req_max is not None:
        try:
            settings["max_frames"] = max(
                1,
                min(int(req_max), _VIDEO_UNDERSTAND_HARD_MAX_FRAMES),
            )
        except (TypeError, ValueError):
            pass

    extractor = VideoFrameExtractor()
    tmp_dir = Path(tempfile.mkdtemp(prefix="agenticx_video_"))
    probe = None
    result = None
    staged = 0
    transcript = ""
    degrade_reason = ""
    try:
        probe = await extractor.probe(path)
        frame_count = extractor.plan_frame_count(
            probe.duration_seconds,
            interval=settings["interval_seconds"],
            min_frames=settings["min_frames"],
            max_frames=settings["max_frames"],
        )
        if settings["use_scene_detection"]:
            result = await extractor.extract_scene(
                path,
                tmp_dir,
                max_frames=settings["max_frames"],
                probe=probe,
            )
        if result is None or len(result.frames) < 2:
            result = await extractor.extract_interval(
                path,
                tmp_dir,
                frame_count=frame_count,
                probe=probe,
            )
        if not result.frames:
            return "ERROR: failed to extract any frame from the video."

        pending = _pending_visual_attachments(session)
        for idx, frame_path in enumerate(result.frames):
            try:
                data = frame_path.read_bytes()
            except OSError:
                continue
            ts = result.timestamps[idx] if idx < len(result.timestamps) else 0.0
            data_url = _data_url_from_bytes(data, "image/png")
            pending.append(
                {
                    "name": f"{path.stem}_frame_{idx + 1:02d}_t{ts:.1f}s.png",
                    "data_url": data_url,
                    "mime_type": "image/png",
                    "size": len(data),
                    "source": str(path),
                    "note": f"video frame @ {ts:.1f}s",
                }
            )
            staged += 1
        if staged == 0:
            return "ERROR: extracted frames could not be read for attachment."

        if probe.has_audio and settings.get("enable_audio_transcription", True):
            audio_path = await extractor.extract_audio(path, tmp_dir)
            if audio_path is None:
                degrade_reason = "audio extraction unavailable"
            else:
                transcript, degrade_reason = await _transcribe_video_audio(
                    audio_path,
                    str(settings.get("transcription_language", "") or ""),
                )
    except Exception as exc:
        return (
            f"ERROR: video_understand failed for {path.name}: {exc}\n"
            f"{traceback.format_exc(limit=3)}"
        )
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    if probe is None or result is None:
        return "ERROR: internal video_understand state error."
    audio_note = (
        "with audio (transcribed)"
        if transcript
        else ("with audio (not transcribed)" if probe.has_audio else "no audio track")
    )
    lines = [
        f"[video_understand] {path.name}",
        (
            f"duration={probe.duration_seconds:.1f}s resolution={probe.width}x{probe.height} "
            f"{audio_note} strategy={result.strategy} frames_attached={staged}"
        ),
        "Frames are attached as images in the NEXT turn; combine them with the transcript below.",
    ]
    if transcript:
        clipped = transcript if len(transcript) <= 6000 else transcript[:6000] + " ...[truncated]"
        lines.append("")
        lines.append("[audio_transcript]")
        lines.append(clipped)
    elif probe.has_audio:
        lines.append(
            f"NOTE: audio present but not transcribed ({degrade_reason or 'unknown'})."
        )
    return "\n".join(lines)


def _resolve_lsp_settings() -> tuple[bool, float]:
    try:
        global_data = ConfigManager._load_yaml(ConfigManager.GLOBAL_CONFIG_PATH)
        project_data = ConfigManager._load_yaml(ConfigManager.PROJECT_CONFIG_PATH)
        merged = ConfigManager._deep_merge(global_data, project_data)
        enabled_raw = ConfigManager._get_nested(merged, "lsp.enabled")
        timeout_raw = ConfigManager._get_nested(merged, "lsp.startup_timeout")
    except Exception:
        enabled_raw = None
        timeout_raw = None

    if enabled_raw is None:
        enabled = True
    elif isinstance(enabled_raw, bool):
        enabled = enabled_raw
    elif isinstance(enabled_raw, str):
        lowered = enabled_raw.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            enabled = True
        elif lowered in {"0", "false", "no", "off"}:
            enabled = False
        else:
            enabled = True
    else:
        enabled = bool(enabled_raw)
    try:
        timeout = float(timeout_raw if timeout_raw is not None else 30.0)
    except (TypeError, ValueError):
        timeout = 30.0
    timeout = max(1.0, min(120.0, timeout))
    return enabled, timeout


def _infer_lsp_workspace_root(session: StudioSession) -> str:
    roots = _session_workspace_roots(session)
    return str(roots[0]) if roots else str(_workspace_root())


async def _dispatch_lsp_tool(name: str, arguments: Dict[str, Any], session: StudioSession) -> str:
    from agenticx.tools.lsp_manager import LSPManager

    mgr: Optional[LSPManager] = getattr(session, "_lsp_manager", None)
    enabled, startup_timeout = _resolve_lsp_settings()
    if mgr is None:
        mgr = LSPManager(
            _infer_lsp_workspace_root(session),
            startup_timeout=startup_timeout,
            enabled=enabled,
        )
        setattr(session, "_lsp_manager", mgr)

    file_path = str(arguments.get("file", "")).strip()
    line_raw = arguments.get("line", 1)
    column_raw = arguments.get("column", 1)
    try:
        line = int(line_raw)
    except (TypeError, ValueError):
        line = 1
    try:
        column = int(column_raw)
    except (TypeError, ValueError):
        column = 1

    try:
        if name == "lsp_goto_definition":
            return await mgr.tool_goto_definition(file_path, line, column)
        if name == "lsp_find_references":
            return await mgr.tool_find_references(file_path, line, column)
        if name == "lsp_hover":
            return await mgr.tool_hover(file_path, line, column)
        if name == "lsp_diagnostics":
            return await mgr.tool_diagnostics(file_path or None)
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"LSP error: {exc}"}, ensure_ascii=False)
    return json.dumps({"ok": False, "error": f"unknown LSP tool: {name}"}, ensure_ascii=False)


# Project state harness tools (.agx/project state machine).
try:
    from agenticx.project_state.tools import project_state_tool_schemas as _project_state_schemas

    STUDIO_TOOLS.extend(_project_state_schemas())
except Exception as _exc:  # pragma: no cover - defensive import isolation
    logging.getLogger(__name__).warning(
        "project_state tool registration skipped: %s", _exc,
    )


LOCAL_KNOWLEDGE_TOOL_NAMES = frozenset({"knowledge_search", "knowledge_synthesize"})


def without_local_knowledge_tools(tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remove local document-brain tools while preserving the remaining order."""

    return [
        tool
        for tool in tools
        if str((tool.get("function") or {}).get("name", "")).strip()
        not in LOCAL_KNOWLEDGE_TOOL_NAMES
    ]


if not local_knowledge_enabled():
    STUDIO_TOOLS[:] = without_local_knowledge_tools(STUDIO_TOOLS)


_TOOL_REQUIRED_PARAMS: Dict[str, List[str]] = {}
for _td in STUDIO_TOOLS:
    _fn = _td.get("function", {})
    _name = _fn.get("name", "")
    _req = _fn.get("parameters", {}).get("required", [])
    if _name and _req:
        _TOOL_REQUIRED_PARAMS[_name] = _req


def _repair_malformed_file_tool_arguments(name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Best-effort repair for malformed file tool arguments from weaker models."""
    if name not in {"file_write", "file_edit"}:
        return arguments
    if not isinstance(arguments, dict):
        return arguments

    def _is_tool_metadata_noise(value: Any) -> bool:
        text = _strip_tool_metadata_noise_lines(str(value or "")).strip()
        if not text:
            return False
        return bool(re.fullmatch(r"(call_[A-Za-z0-9]+|sa-[a-z0-9]+)", text))

    def _collect_safe_extra_payload(extra_keys: List[str]) -> str:
        # Only merge text-like alias fields; drop unknown keys to avoid
        # leaking streamed tool-call metadata fragments into file content.
        alias_keys = {"text", "body", "code", "value", "new_content", "newText"}
        payloads: List[str] = []
        for key in extra_keys:
            if key not in alias_keys:
                continue
            raw = repaired.get(key, "")
            if _is_tool_metadata_noise(raw):
                continue
            text = _strip_tool_metadata_noise_lines(str(raw)).strip()
            if text:
                payloads.append(text)
        return "\n".join(payloads)

    repaired = dict(arguments)
    if name == "file_edit":
        for src, dst in (
            ("old_str", "old_text"),
            ("old_string", "old_text"),
            ("new_str", "new_text"),
            ("new_string", "new_text"),
        ):
            if src in repaired and dst not in repaired:
                repaired[dst] = repaired.pop(src)
            elif src in repaired:
                repaired.pop(src, None)
    elif name == "file_write":
        for src, dst in (
            ("text", "content"),
            ("body", "content"),
            ("new_content", "content"),
        ):
            if src in repaired and dst not in repaired:
                repaired[dst] = repaired.pop(src)
            elif src in repaired:
                repaired.pop(src, None)

    if name == "file_write":
        allowed_keys = {"path", "content"}
        extra_keys = [k for k in repaired.keys() if k not in allowed_keys]
        if not extra_keys:
            return repaired
        extra_payload = _collect_safe_extra_payload(extra_keys)
        existing_content = _strip_tool_metadata_noise_lines(str(repaired.get("content", "")))
        if extra_payload:
            repaired["content"] = f"{existing_content}\n{extra_payload}".strip() if existing_content else extra_payload
        for key in extra_keys:
            repaired.pop(key, None)
        _log.warning(
            "[tool-args-repair] repaired malformed file_write args, removed keys=%s",
            extra_keys,
        )
        return repaired

    allowed_keys = {"path", "old_text", "new_text", "occurrence"}
    extra_keys = [k for k in repaired.keys() if k not in allowed_keys]
    if not extra_keys:
        return repaired
    extra_payload = _collect_safe_extra_payload(extra_keys)
    if extra_payload:
        base_new_text = _strip_tool_metadata_noise_lines(str(repaired.get("new_text", "")))
        repaired["new_text"] = f"{base_new_text}\n{extra_payload}".strip() if base_new_text else extra_payload
    for key in extra_keys:
        repaired.pop(key, None)
    _log.warning(
        "[tool-args-repair] repaired malformed file_edit args, removed keys=%s",
        extra_keys,
    )
    return repaired


# ── task_experience implementation ────────────────────────────────────────────

def _experience_path(group_id: str) -> Path:
    """Return the JSON file path for a group's experience store."""
    import pathlib
    base = agx_home() / "groups" / group_id
    base.mkdir(parents=True, exist_ok=True)
    return base / "experience.json"


def _experience_load(group_id: str) -> List[Dict[str, Any]]:
    p = _experience_path(group_id)
    if not p.exists():
        return []
    try:
        import json as _json
        return _json.loads(p.read_text(encoding="utf-8")) or []
    except Exception:
        return []


def _experience_save(group_id: str, entries: List[Dict[str, Any]]) -> None:
    import json as _json
    p = _experience_path(group_id)
    p.write_text(_json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


def _experience_retrieve_impl(query: str, group_id: str, limit: int = 5) -> str:
    """Simple keyword-based retrieval from the JSON experience store.

    Falls back to pure keyword search when WorkspaceMemoryStore is unavailable.
    Hybrid search integration can be added without changing the tool schema.
    """
    import json as _json
    entries = _experience_load(group_id)
    if not entries:
        return _json.dumps({"status": "no_experience", "results": [], "group_id": group_id})

    q_lower = query.casefold()
    q_tokens = set(q_lower.split())

    def _score(entry: Dict[str, Any]) -> float:
        text = (
            (entry.get("content") or "")
            + " " + (entry.get("title") or "")
            + " " + (entry.get("when_to_use") or "")
        ).casefold()
        return sum(1 for t in q_tokens if t in text) / max(len(q_tokens), 1)

    scored = sorted(entries, key=_score, reverse=True)
    top = [e for e in scored if _score(e) > 0][:limit] or scored[:limit]
    return _json.dumps({
        "status": "ok",
        "group_id": group_id,
        "count": len(top),
        "results": top,
    }, ensure_ascii=False)


def _experience_learn_impl(
    content: str,
    group_id: str,
    section: str = "general",
    when_to_use: str = "",
    title: str = "",
) -> str:
    import json as _json
    import uuid
    from datetime import datetime, timezone
    entries = _experience_load(group_id)
    entry = {
        "id": uuid.uuid4().hex[:12],
        "section": section or "general",
        "content": content,
        "title": title or content[:60],
        "when_to_use": when_to_use,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    entries.append(entry)
    _experience_save(group_id, entries)
    return _json.dumps({"status": "ok", "group_id": group_id, "entry_id": entry["id"]})


def _experience_clear_impl(group_id: str, confirm: bool) -> str:
    import json as _json
    if not confirm:
        return _json.dumps({"status": "aborted", "reason": "confirm must be true"})
    p = _experience_path(group_id)
    if p.exists():
        p.write_text("[]", encoding="utf-8")
    return _json.dumps({"status": "cleared", "group_id": group_id})


def _resolve_group_id(session: "StudioSession", arg_group_id: str | None) -> str:
    """Best-effort resolution of group_id from session or argument."""
    if arg_group_id and str(arg_group_id).strip():
        return str(arg_group_id).strip()
    # Try to read from session scratchpad if set by run_group_turn.
    scratchpad = getattr(session, "scratchpad", {}) or {}
    gid = str(scratchpad.get("__group_id", "") or "").strip()
    return gid or "default"


async def dispatch_tool_async(
    name: str,
    arguments: Dict[str, Any],
    session: StudioSession,
    *,
    confirm_gate: Optional[ConfirmGate] = None,
    event_callback: Optional[Any] = None,
    team_manager: Optional[Any] = None,
    clarify_gate: Optional[ClarifyGate] = None,
    is_unattended: bool = False,
    runtime_tool_context: Optional[Any] = None,
) -> str:
    """Dispatch one tool call asynchronously and return result text.

    这里是**唯一**的工具执行入口：聊天主循环、语音工具代理、知识预取、同步版
    ``dispatch_tool`` 全走这一条。策略闸必须在这里，不能只在主循环里。
    """
    policy_denial = tool_policy_denial(name, session)
    if policy_denial:
        return f"ERROR: {policy_denial}"
    arguments = _repair_malformed_file_tool_arguments(name, arguments)
    required = _TOOL_REQUIRED_PARAMS.get(name)
    if required and not arguments:
        # FR-B.1：空参数往往源于流式工具调用被截断或弱模型忘填字段；
        # 错误文本必须强引导"立即重试本工具"，避免模型读到 ERROR 后转去
        # 自言自语而放弃任务。对常见的文件类工具补充字段释义。
        param_hints = {
            "file_write": (
                "path（绝对路径，不要省略）, content（要写入的完整文档正文，至少几百字的实际内容，不能是空字符串或省略号）"
            ),
            "file_edit": (
                "path（绝对路径）, old_string（原文片段）, new_string（替换后的内容）"
            ),
            "skill_manage": (
                "action（create / patch / delete）, name（skill 名称，可含子路径如 ima/notes）, "
                "以及 content / from_path / from_url（create）或 old_string / new_string（patch）"
            ),
            "skill_market_install": (
                "name（SkillHub/ClawHub 技能名或 @clawhub_发布者/技能名）；source 通常省略自动解析"
            ),
            "skill_import_repo": (
                "repo（owner/name）, 可选 branch/path_glob/exclude/dry_run/overwrite"
            ),
            "schedule_task": (
                "name（任务名）、frequency / time / date 至少一项、instruction（具体指令）、workspace（执行目录）"
            ),
        }
        guidance = param_hints.get(name, "见工具 schema 中的 required 列表")
        return (
            f"ERROR: {name}() called with empty arguments. "
            f"Required parameters: {', '.join(required)}.\n"
            f"参数说明：{guidance}\n"
            f"行动要求：请立即重新调用 {name} 一次，并把上述所有必填参数完整填入；"
            f"不要换其他工具、不要把这次失败汇报给用户、不要在没有重新调用前给出最终回复。"
            f"如果你忘记了目标路径或正文内容，请回头查看用户最近的原始任务描述（含 [user-pending-question] 与 [user-goal-anchor]）以及 system prompt 里的工作区根，再生成完整调用。"
        )
    gate = confirm_gate or SyncConfirmGate()
    try:
        if name in {"enterprise_capabilities", "enterprise_action"}:
            from agenticx.studio.enterprise_actions import dispatch_enterprise_action

            enterprise_result = await dispatch_enterprise_action(
                name,
                arguments,
                session,
                clarify_gate=clarify_gate,
                emit_event=event_callback,
                is_unattended=is_unattended,
            )
            if enterprise_result is not None:
                return enterprise_result
        # Group members publish through an explicit, turn-local action channel.
        # The schemas are exposed only by GroupChatRouter, so these names cannot
        # be invoked from ordinary one-to-one sessions without prepared state.
        if name in {
            "publish_group_message",
            "react_group_message",
            "pass_group_turn",
        }:
            from agenticx.runtime.group_public_actions import (
                dispatch_group_public_action,
            )

            group_result = await dispatch_group_public_action(
                name,
                arguments,
                session,
                event_callback=event_callback,
            )
            if group_result is not None:
                return group_result
        if name in META_TOOL_NAMES:
            tm = team_manager or getattr(session, "_team_manager", None)
            import logging as _logging
            _logging.getLogger("agenticx.cli.agent_tools").debug(
                "[dispatch_tool] meta_tool=%s session=%s tm=%s (explicit=%s, attr=%s)",
                name,
                id(session),
                id(tm) if tm else "None",
                id(team_manager) if team_manager else "None",
                id(getattr(session, "_team_manager", None)) if getattr(session, "_team_manager", None) else "None",
            )
            if tm is None:
                return "ERROR: meta tool requires team manager in session"
            from agenticx.runtime.meta_tools import dispatch_meta_tool_async

            return await dispatch_meta_tool_async(
                name,
                arguments,
                team_manager=tm,
                session=session,
                # 副作用工具的确认闸在 dispatch_meta_tool_async 里，gate 必须传下去，
                # 否则那边会落到 SyncConfirmGate 的 input()——服务端没有 stdin。
                confirm_gate=gate,
                emit_event=event_callback,
            )
        if name == "bash_exec":
            return await _tool_bash_exec(arguments, session, confirm_gate=gate, emit_event=event_callback)
        if name == "bash_bg_start":
            return await _tool_bash_bg_start(arguments, session, confirm_gate=gate, emit_event=event_callback)
        if name == "bash_bg_poll":
            return await _tool_bash_bg_poll(arguments, session)
        if name == "bash_bg_input":
            return await _tool_bash_bg_input(arguments, session)
        if name == "bash_bg_stop":
            return await _tool_bash_bg_stop(arguments, session)
        if name == "code_outline":
            return _tool_code_outline(arguments, session)
        if name == "file_read":
            return _tool_file_read(arguments, session)
        if name == "file_write":
            return await _tool_file_write(arguments, session, confirm_gate=gate, emit_event=event_callback)
        if name == "document_generate":
            return await _tool_document_generate(
                arguments,
                session,
                confirm_gate=gate,
                emit_event=event_callback,
            )
        if name == "document_publish":
            return await _tool_document_publish(arguments, session)
        if name == "file_edit":
            return await _tool_file_edit(arguments, session, confirm_gate=gate, emit_event=event_callback)
        if name == "codegen":
            return await _tool_codegen(arguments, session, confirm_gate=gate, emit_event=event_callback)
        if name == "mcp_connect":
            return _tool_mcp_connect(arguments, session)
        if name == "cc_bridge_start":
            return await _tool_cc_bridge_start(arguments, session)
        if name == "cc_bridge_send":
            return await _tool_cc_bridge_send(arguments, session)
        if name == "cc_bridge_list":
            return await _tool_cc_bridge_list(arguments, session)
        if name == "cc_bridge_stop":
            return await _tool_cc_bridge_stop(arguments, session)
        if name == "cc_bridge_permission":
            return await _tool_cc_bridge_permission(arguments, session)
        if name == "mcp_call":
            return await _tool_mcp_call_async(arguments, session)
        if name == "tool_search":
            return _tool_tool_search(arguments, session, runtime_tool_context=runtime_tool_context)
        if name == "mcp_import":
            return _tool_mcp_import(arguments, session)
        if name == "install_portable_package":
            return await _tool_install_portable_package(
                arguments,
                session,
                confirm_gate=gate,
                emit_event=event_callback,
            )
        if name == "skill_use":
            return _tool_skill_use(arguments, session)
        if name == "skill_list":
            return _tool_skill_list(session)
        if name == "hook_manage":
            return _tool_hook_manage(arguments, session)
        if name == "skill_market_install":
            return await _tool_skill_market_install(
                arguments,
                session,
                confirm_gate=gate,
                emit_event=event_callback,
            )
        if name == "skill_manage":
            return await _tool_skill_manage(arguments, session, confirm_gate=gate, emit_event=event_callback)
        if name == "skill_import_repo":
            return _tool_skill_import_repo(arguments, session)
        if name == "todo_write":
            return _tool_todo_write(arguments, session)
        if name == "scratchpad_write":
            return _tool_scratchpad_write(arguments, session)
        if name == "scratchpad_read":
            return _tool_scratchpad_read(arguments, session)
        if name in {
            "project_init",
            "project_status",
            "feature_select",
            "feature_complete",
            "progress_append",
            "verify_run",
        }:
            from agenticx.project_state.tools import dispatch_project_state_tool

            if name == "verify_run":
                # verify.yaml 里的命令要和 bash_exec 走同一套风险判定。它的文件沙箱
                # 在 run_verify 里，命令确认在这里——两条线都接上才算收口。
                refusal = await confirm_verify_steps(
                    session, arguments, confirm_gate=gate, emit_event=event_callback
                )
                if refusal:
                    return refusal
            return await asyncio.to_thread(
                dispatch_project_state_tool, name, arguments, session
            )
        if name == "memory_append":
            return await _tool_memory_append(
                arguments,
                confirm_gate=gate,
                emit_event=event_callback,
                session=session,
            )
        if name == "memory_search":
            return await _tool_memory_search(arguments, session)
        if name == "memory_forget":
            return await _tool_memory_forget(arguments, session)
        if name == "knowledge_search":
            return await asyncio.to_thread(_tool_knowledge_search, arguments, session)
        if name == "knowledge_synthesize":
            return await asyncio.to_thread(_tool_knowledge_synthesize, arguments, session)
        if name == "web_search":
            return await asyncio.to_thread(_tool_web_search, arguments, session)
        if name == "get_current_datetime":
            return _tool_get_current_datetime(arguments)
        if name == "web_fetch":
            return await _tool_web_fetch(arguments, session)
        if name == "view_image":
            return await _tool_view_image(arguments, session)
        if name == "document_read_pages":
            return await _tool_document_read_pages(arguments, session)
        if name == "analyze_image":
            return await _tool_analyze_image(arguments, session)
        if name == "session_search":
            return _tool_session_search(arguments, session)
        if name == "ask_user":
            return _tool_ask_user(arguments, service_mode=gate.is_service_mode())
        if name == "request_clarification":
            prompt = str(arguments.get("prompt", "") or "").strip()
            if not prompt:
                return (
                    "ERROR: request_clarification requires a non-empty `prompt`. "
                    "请立即重新调用 request_clarification 并填写 prompt。"
                )
            raw_options = arguments.get("options") or []
            if not isinstance(raw_options, list):
                raw_options = []
            options = [str(opt).strip() for opt in raw_options if str(opt).strip()]
            options = options[:8]
            raw_decisions = arguments.get("decisions") or []
            decisions = _normalize_clarification_decisions(raw_decisions)
            allow_free_text = bool(arguments.get("allow_free_text", True))
            ctx = arguments.get("context")
            if not isinstance(ctx, dict):
                ctx = None
            return await _request_clarification(
                prompt,
                options=options,
                decisions=decisions,
                allow_free_text=allow_free_text,
                context=ctx,
                clarify_gate=clarify_gate,
                emit_event=event_callback,
                is_unattended=is_unattended,
            )
        if name == "request_action_confirmation":
            title = str(arguments.get("title", "") or "").strip()
            if not title:
                return (
                    "ERROR: request_action_confirmation requires a non-empty `title`. "
                    "请立即重新调用并填写 title。"
                )
            raw_summary = arguments.get("summary") or []
            if not isinstance(raw_summary, list):
                raw_summary = []
            return await _request_action_confirmation(
                title,
                summary=raw_summary,
                approve_label=str(arguments.get("approve_label", "") or "确认执行"),
                reject_label=str(arguments.get("reject_label", "") or "取消"),
                expires_in_seconds=arguments.get("expires_in_seconds"),
                source=str(arguments.get("source", "") or ""),
                clarify_gate=clarify_gate,
                emit_event=event_callback,
                is_unattended=is_unattended,
            )
        if name == "list_files":
            return await asyncio.to_thread(_tool_list_files, arguments, session)
        if name == "liteparse":
            return await _tool_liteparse(arguments, session)
        if name == "video_understand":
            return await _tool_video_understand(arguments, session)
        if name == "list_data_sources":
            return await _tool_list_data_sources(arguments)
        if name == "query_data_source":
            return await _tool_query_data_source(arguments)
        if name == "show_widget":
            return _tool_show_widget(arguments)
        if name == "task_experience_retrieve":
            gid = _resolve_group_id(session, arguments.get("group_id"))
            limit = min(max(int(arguments.get("limit") or 5), 1), 10)
            return _experience_retrieve_impl(
                query=str(arguments.get("query", "")),
                group_id=gid,
                limit=limit,
            )
        if name == "task_experience_learn":
            gid = _resolve_group_id(session, arguments.get("group_id"))
            return _experience_learn_impl(
                content=str(arguments.get("content", "")),
                group_id=gid,
                section=str(arguments.get("section") or "general"),
                when_to_use=str(arguments.get("when_to_use") or ""),
                title=str(arguments.get("title") or ""),
            )
        if name == "task_experience_clear":
            gid = _resolve_group_id(session, arguments.get("group_id"))
            confirm = bool(arguments.get("confirm", False))
            return _experience_clear_impl(group_id=gid, confirm=confirm)
        if name.startswith("lsp_"):
            return await _dispatch_lsp_tool(name, arguments, session)
    except Exception as exc:
        return f"ERROR: {name} crashed: {exc}"
    if name.startswith("confirm_"):
        return (
            "ERROR: Desktop mode does not provide confirm_* tools. "
            "To request approval, directly call the real tool (e.g. bash_exec); "
            "runtime will emit confirm_required and wait for UI confirmation."
        )
    # --- Dynamic MCP function tools loaded via tool_search (public names) ---
    if runtime_tool_context is not None:
        try:
            from agenticx.runtime.mcp_tool_catalog import resolve_mcp_execution_name
            from agenticx.cli.studio_mcp import mcp_call_tool_async

            routed = resolve_mcp_execution_name(
                name,
                getattr(runtime_tool_context, "catalog", None).descriptors
                if getattr(runtime_tool_context, "catalog", None) is not None
                else (),
            )
            if routed:
                # 动态 MCP 工具用的是公开工具名（browser_navigate…），入口那次策略判定
                # 认的是这个名字，判不出它其实是一次 MCP 调用。原来这里写着「父级已经
                # 把过关」——catalog 只在 mcp_call 允许时才有内容——但 catalog 是
                # tool_search 阶段建的，事后再禁 mcp_call 或切到 plan 模式都不会重建它。
                # 所以拿真名再判一次：公开名与 mcp_call 任一被拒就拒。
                routed_denial = tool_policy_denial(name, session) or tool_policy_denial(
                    "mcp_call",
                    session,
                )
                if routed_denial:
                    return f"ERROR: {routed_denial}"
                hub = getattr(session, "mcp_hub", None)
                if hub is None:
                    return "ERROR: no MCP hub connected"
                args_obj = arguments if isinstance(arguments, dict) else {}
                repeat_guard_error = _check_mcp_repeat_guard(session, routed, args_obj)
                if repeat_guard_error:
                    return repeat_guard_error
                return await mcp_call_tool_async(
                    hub,
                    routed,
                    json.dumps(args_obj, ensure_ascii=False),
                    echo=False,
                )
        except Exception as mcp_dyn_exc:
            return f"ERROR: dynamic MCP tool '{name}' failed: {mcp_dyn_exc}"

    return f"ERROR: unknown tool '{name}'"


def dispatch_tool(
    name: str,
    arguments: Dict[str, Any],
    session: StudioSession,
    *,
    confirm_gate: Optional[ConfirmGate] = None,
) -> str:
    """Backward-compatible sync dispatcher for tests/CLI."""
    return asyncio.run(
        dispatch_tool_async(
            name,
            arguments,
            session,
            confirm_gate=confirm_gate,
        )
    )
