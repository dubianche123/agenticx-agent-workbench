#!/usr/bin/env python3
"""只读档：写全被拒，因而文件类风险不必再问。

三档的分工（对齐 deepseek-harness 把 sandbox/mode 与 approval/policy 拆成两个旋钮的做法）：

    read-only          写全部被拒 → 这次会话改不了任何东西
    workspace-write    只有工作区可写 → 工作区内的不可逆操作仍要问
    danger-full-access 不做约束 → 每条都带 host_full_access 问

**只读档不是网络隔离。** 文件沙箱只管文件效果，bwrap / seatbelt / mxc 都不管网络。
所以 ``git push``、``shutdown``、``python -c``（能开 socket）、以及认不出来的命令
在只读档下照样要问。这个边界必须写在测试里，否则很容易被当成「只读 = 绝对安全」。

Author: Damon Li
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from agenticx.runtime.command_safety import (
    CONTAINED_BY_READ_ONLY,
    categories_requiring_approval,
)
from agenticx.runtime.command_sandbox import (
    COMMAND_SANDBOX_PERMISSIONS,
    DANGER_FULL_ACCESS,
    READ_ONLY,
    WORKSPACE_WRITE,
    build_command_sandbox_plan,
    normalize_command_permissions,
)


def test_read_only_is_a_supported_tier() -> None:
    assert READ_ONLY in COMMAND_SANDBOX_PERMISSIONS
    assert normalize_command_permissions("read-only") == READ_ONLY
    assert normalize_command_permissions("  READ-ONLY  ") == READ_ONLY


def test_read_only_grants_no_workspace_write_root() -> None:
    """只读档下工作区不在可写根里——这是这一档的全部意义。"""
    workspace = Path(tempfile.mkdtemp()).resolve()
    plan = build_command_sandbox_plan(
        ["/bin/echo", "hi"],
        permissions=READ_ONLY,
        writable_roots=[workspace],
        cwd=workspace,
    )
    roots = {root.resolve() for root in plan.writable_roots}
    assert workspace not in roots, "只读档把工作区放进了可写根，这一档就没有意义了"
    # 仍然留一块本次执行专属的临时目录：shell 与 git/python 没有可写 temp 会直接坏掉，
    # 而它在工作区之外、用完即弃。
    assert len(roots) == 1


def test_workspace_write_still_grants_the_workspace() -> None:
    """对照组：不能因为加了只读档就把 workspace-write 一起收紧了。"""
    workspace = Path(tempfile.mkdtemp()).resolve()
    plan = build_command_sandbox_plan(
        ["/bin/echo", "hi"],
        permissions=WORKSPACE_WRITE,
        writable_roots=[workspace],
        cwd=workspace,
    )
    roots = {root.resolve() for root in plan.writable_roots}
    assert workspace in roots


def test_read_only_does_not_require_a_writable_root() -> None:
    """workspace-write 没有可写根要报错；只读档本来就不需要。"""
    plan = build_command_sandbox_plan(
        ["/bin/echo", "hi"], permissions=READ_ONLY, writable_roots=[], cwd=None
    )
    assert plan.permissions == READ_ONLY


@pytest.mark.parametrize(
    "code",
    ["destructive_filesystem", "dependency_change", "version_control_change"],
)
def test_file_effect_categories_are_contained_by_read_only(code: str) -> None:
    """危害全部落在写盘上的类别，只读档下不必再问。"""
    assert categories_requiring_approval(READ_ONLY, [code]) == []
    # 对照：workspace-write 下照旧要问
    assert categories_requiring_approval(WORKSPACE_WRITE, [code]) == [code]


@pytest.mark.parametrize(
    "code",
    [
        "external_publish",        # git push：网络
        "system_disruption",       # shutdown / kill：进程与设备
        "arbitrary_code_execution",  # python -c：写不了盘，但能开 socket
        "unrecognized_command",    # 认不出来，可能就是 curl
        "host_full_access",
    ],
)
def test_non_file_effects_still_ask_under_read_only(code: str) -> None:
    """只读档不是网络隔离——文件沙箱管不到的效果照样要问。"""
    assert categories_requiring_approval(READ_ONLY, [code]) == [code], (
        f"{code} 的危害不只是写盘，只读档拦不住它，不能因为进了只读档就不问。"
    )
    assert code not in CONTAINED_BY_READ_ONLY


def test_mixed_categories_keep_only_the_uncontained_ones() -> None:
    """``git push --force`` 同时命中两类：写盘那半被兜住，网络那半留下。"""
    codes = ["external_publish", "version_control_change"]
    assert categories_requiring_approval(READ_ONLY, codes) == ["external_publish"]
    assert categories_requiring_approval(WORKSPACE_WRITE, codes) == sorted(codes)


def test_danger_full_access_is_left_untouched() -> None:
    """这一档保持逐条询问。改成「进档位时批准一次」需要会话级状态，是产品决策。"""
    codes = ["destructive_filesystem", "external_publish"]
    assert categories_requiring_approval(DANGER_FULL_ACCESS, codes) == sorted(codes)
