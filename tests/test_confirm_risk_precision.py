#!/usr/bin/env python3
"""确认框的**精度**护栏——recall 的另一半。

``test_confirm_risk_recall.py`` 只保证危险命令不漏。但漏和吵是同一个问题的两面：
问得太勤会把人训练成闭着眼点「批准」，于是真正该拦的那次也被点过去了。
**过度打扰本身就是安全失效**，不是「更保险」。

判定原则：确认框留给**越出沙箱**或**沙箱内不可逆**的效果。workspace-write 已经兜住的
不再问第二遍——沙箱后端没有不安全降级（找不到 bwrap / mxc 就拒绝执行，见
agenticx/runtime/command_sandbox.py），所以「兜住了」这个前提是硬的。

这里断言的是「这些不该弹框」。任何一条变红，说明精度退回去了。

Author: Damon Li
"""

from __future__ import annotations

import pytest

from agenticx.cli.agent_tools import _collect_command_risk_findings


def _codes(command: str) -> set[str]:
    parts = command.split()
    return {
        item["code"]
        for item in _collect_command_risk_findings(
            parts[0] if parts else "", parts, command
        )
    }


#: 纯读命令。一个字节都不写，没有任何理由打扰用户。
READ_ONLY_COMMANDS = [
    "ls -la",
    "cat README.md",
    "head -n 20 a.py",
    "tail -f log.txt",
    "grep -rn TODO .",
    "rg --json pattern",
    "wc -l a.py",
    "sed -n '1,50p' a.py",
    "awk '{print $1}' a.txt",
    "sort a.txt",
    "uniq -c a.txt",
    "cut -d, -f1 a.csv",
    "tr a b",
    "diff a.txt b.txt",
    "jq .name package.json",
    "basename /x/y.py",
    "dirname /x/y.py",
    "realpath a.py",
    "stat a.py",
    "file a.bin",
    "du -sh .",
    "df -h",
    "date",
    "whoami",
    "id -u",
    "uname -a",
    "hostname",
    "pwd",
    "which python",
    "echo hello",
    "printf '%s\\n' x",
    "seq 1 10",
    "shasum -a 256 a.bin",
    "tree -L 2",
    "find . -name '*.py'",
    "git status",
    "git log --oneline -5",
    "git diff HEAD~1",
    "tar -tzf archive.tgz",
]


@pytest.mark.parametrize("command", READ_ONLY_COMMANDS)
def test_read_only_commands_do_not_need_approval(command: str) -> None:
    assert _codes(command) == set(), (
        f"{command!r} 只读却要用户批准。问得太勤会让人闭眼点批准，"
        "真正危险的那次就跟着过去了。"
    )


#: 每一段都安全的复合命令。管道和 && 只决定先后，不给任何一段增加能力。
SAFE_COMPOSITIONS = [
    "ls | head",
    "ls -la && pwd",
    "grep -rn foo . | wc -l",
    "cat a.txt | sort | uniq -c",
    "cat a.txt | sort | uniq | head -20",
    "git status && git diff",
    "find . -name '*.py' | xargs wc -l",
    "echo hi > out.txt",
    "cat a.txt >> b.txt",
    "ls 2>/dev/null",
]


@pytest.mark.parametrize("command", SAFE_COMPOSITIONS)
def test_safe_compositions_do_not_need_approval(command: str) -> None:
    assert _codes(command) == set(), (
        f"{command!r} 的每一段都安全，却因为出现了连接符被判成受保护。"
        "shell_composition 应该只用于**拆不动**的结构（命令替换、进程替换等），"
        "不是「见到管道就问」。"
    )


def test_relative_redirect_is_contained_but_absolute_is_not() -> None:
    """相对路径落在 cwd（在工作区内）；绝对路径这里证明不了，得问。"""
    assert _codes("echo hi > out.txt") == set()
    assert "shell_composition" in _codes("cat secrets.env > /tmp/leak.txt")


def test_known_tools_are_not_reported_as_unrecognized() -> None:
    """认得的工具只报它具体的风险，不再叠一条「未归类命令」。

    两条理由说同一件事会让确认卡更难读，用户更容易直接点过。
    """
    codes = _codes("python -c 'print(1)'")
    assert "arbitrary_code_execution" in codes
    assert "unrecognized_command" not in codes

    codes = _codes("pip install requests")
    assert "dependency_change" in codes
    assert "unrecognized_command" not in codes


def test_dangerous_leaf_keeps_its_specific_category() -> None:
    """危险的那段藏在连接符后面，归类不能退化成 shell_composition。

    这条以前是错的：``echo x && git push --force`` 只报 shell_composition，于是
    (1) 确认卡上显示的是最没信息量的理由，恰好在最危险的时候；
    (2) shell_composition 不在「不可复用」集合里，藏在 && 后面的 force push
        反而比裸写的更容易在同一次任务里被复用。
    """
    codes = _codes("echo x && git push --force origin main")
    assert "external_publish" in codes
    codes = _codes("ls | pip install evil-pkg")
    assert "dependency_change" in codes
