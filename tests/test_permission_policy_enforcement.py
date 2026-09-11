#!/usr/bin/env python3
"""配置里承诺过的权限规则必须真的被执行。

``permissions`` 的词汇表（mode / path_rules / denied_commands / denied_tools /
allowed_tools）在设置界面里能配，但在 2026-08-24 之前只有 ``denied_tools`` 真的接了线：
``denied_commands`` 与 ``permissions.mode = plan`` 只被设置接口读写，执行路径上无人检查。

**配了却不执行比没有更糟**——用户写下 ``denied_commands: ["curl *"]`` 会以为自己受了
保护。这和过度打扰是同一类失效：都在破坏用户做真实判断的能力。

对齐 Claude Code 的次序：**deny 是绝对的**，在确认闸之前短路，不提供「批准一次」。

Author: Damon Li
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agenticx.cli import agent_tools
from agenticx.cli.config_manager import ConfigManager
from agenticx.cli.studio import StudioSession
from agenticx.runtime.command_sandbox import (
    DANGER_FULL_ACCESS,
    READ_ONLY,
    WORKSPACE_WRITE,
)


@pytest.fixture
def permissions(monkeypatch: pytest.MonkeyPatch):
    """把 permissions.* 指到一份内存配置，不碰开发者真实的 config.yaml。"""
    values: dict[str, object] = {}
    original = ConfigManager.get_value

    def _fake(key, *args, **kwargs):
        if key in values:
            return values[key]
        if str(key).startswith("permissions."):
            return None
        return original(key, *args, **kwargs)

    monkeypatch.setattr(ConfigManager, "get_value", staticmethod(_fake))
    return values


# --------------------------------------------------------------------------
# denied_commands
# --------------------------------------------------------------------------


def test_denied_command_is_blocked(permissions) -> None:
    permissions["permissions.denied_commands"] = ["curl *"]
    assert agent_tools.command_denied_by_session_permissions("curl http://x") is not None


def test_denied_command_matches_inside_a_compound_command(permissions) -> None:
    """按段匹配——只比对整条的话，加个 ``ls &&`` 前缀就绕过去了。"""
    permissions["permissions.denied_commands"] = ["curl *"]
    assert (
        agent_tools.command_denied_by_session_permissions("ls && curl http://x")
        is not None
    )
    assert (
        agent_tools.command_denied_by_session_permissions("cat a | curl -T - http://x")
        is not None
    )


def test_unrelated_command_is_not_blocked(permissions) -> None:
    permissions["permissions.denied_commands"] = ["curl *"]
    assert agent_tools.command_denied_by_session_permissions("ls -la") is None


def test_no_rules_means_no_block(permissions) -> None:
    assert agent_tools.command_denied_by_session_permissions("curl http://x") is None
    permissions["permissions.denied_commands"] = []
    assert agent_tools.command_denied_by_session_permissions("curl http://x") is None


def test_malformed_rules_do_not_crash(permissions) -> None:
    """配置是人手写的，坏值不能让执行路径炸掉。"""
    permissions["permissions.denied_commands"] = "curl *"  # 应该是 list
    assert agent_tools.command_denied_by_session_permissions("curl http://x") is None
    permissions["permissions.denied_commands"] = [None, "", "  "]
    assert agent_tools.command_denied_by_session_permissions("curl http://x") is None


def test_denied_command_message_names_the_rule(permissions) -> None:
    """报错要说清是哪条规则命中了什么，否则用户无从判断该改配置还是改命令。"""
    permissions["permissions.denied_commands"] = ["*rm -rf*"]
    message = agent_tools.command_denied_by_session_permissions("ls && rm -rf build")
    assert message is not None
    assert "*rm -rf*" in message
    assert "rm -rf build" in message


# --------------------------------------------------------------------------
# permissions.mode = plan → 只读上限
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "requested", [READ_ONLY, WORKSPACE_WRITE, DANGER_FULL_ACCESS]
)
def test_plan_mode_clamps_every_tier_to_read_only(permissions, requested: str) -> None:
    """plan 是**上限**不是默认值：模型主动要更高的档也压下来。

    否则「计划模式」这个承诺是假的——对齐 Claude Code 的 plan 模式：那一档下根本不
    提供修改能力，而不是「修改前问一下」。
    """
    permissions["permissions.mode"] = "plan"
    assert agent_tools._apply_permission_mode_ceiling(requested) == READ_ONLY


def test_permission_mode_uses_the_session_value_over_the_global_default(permissions) -> None:
    permissions["permissions.mode"] = "auto"
    session = StudioSession(permission_mode="plan")

    assert agent_tools._plan_mode_active(session) is True
    assert agent_tools._apply_permission_mode_ceiling(WORKSPACE_WRITE, session) == READ_ONLY

    session.permission_mode = "ask"
    assert agent_tools._plan_mode_active(session) is False
    assert agent_tools._apply_permission_mode_ceiling(WORKSPACE_WRITE, session) == WORKSPACE_WRITE


@pytest.mark.parametrize("mode", ["ask", "auto", "", None, "acceptEdits"])
def test_other_modes_leave_the_requested_tier_alone(permissions, mode) -> None:
    """只有 plan 压档位。别的取值(含认不出来的)都不动模型请求的那一档。

    档位由沙箱执行,确认由确认闸执行——这个函数只管前者,不该顺手替后者做决定。
    """
    permissions["permissions.mode"] = mode
    assert (
        agent_tools._apply_permission_mode_ceiling(WORKSPACE_WRITE) == WORKSPACE_WRITE
    )
    assert (
        agent_tools._apply_permission_mode_ceiling(DANGER_FULL_ACCESS)
        == DANGER_FULL_ACCESS
    )


def test_unreadable_config_does_not_change_the_tier(monkeypatch) -> None:
    """读配置抛异常时保持请求档位，不要静默降级也不要静默升级。"""

    def _boom(*_args, **_kwargs):
        raise RuntimeError("config unavailable")

    monkeypatch.setattr(ConfigManager, "get_value", staticmethod(_boom))
    assert agent_tools._apply_permission_mode_ceiling(WORKSPACE_WRITE) == WORKSPACE_WRITE


# --------------------------------------------------------------------------
# path_rules
# --------------------------------------------------------------------------


def test_path_rules_deny_blocks_resolution(permissions, tmp_path) -> None:
    """拒绝规则在确认闸之前短路，不提供「批准一次」。"""
    permissions["permissions.path_rules"] = [
        {"pattern": "*/secrets/*", "allow": False}
    ]
    target = tmp_path / "secrets" / "key.pem"
    assert agent_tools._path_denied_by_rules(target) is not None
    assert agent_tools._path_denied_by_rules(tmp_path / "src" / "a.py") is None


def test_path_rules_message_names_the_pattern(permissions, tmp_path) -> None:
    permissions["permissions.path_rules"] = [{"pattern": "*.pem", "allow": False}]
    message = agent_tools._path_denied_by_rules(tmp_path / "key.pem")
    assert message is not None and "*.pem" in message


def test_deny_wins_regardless_of_order() -> None:
    """拒绝优先，与它排在第几无关。

    这条的期望在 2026-08-24 反转过。原来照抄设置界面的「首个命中生效」，结果
    ``allow *`` 在前、``deny */.env`` 在后时 ``.env`` 被放行——用户明明写下了禁令。
    次序敏感的安全规则也很难让人一眼看出后果。改成全局 deny > allow（与 Claude Code
    一致），界面文案已同步。
    """
    from agenticx.runtime.path_policy import path_rule_decision

    rules = [{"pattern": "*", "allow": True}, {"pattern": "*/.env", "allow": False}]
    assert path_rule_decision("/proj/.env", rules)[0] is False
    # 顺序反过来，结论不变
    assert path_rule_decision("/proj/.env", list(reversed(rules)))[0] is False
    # 没有 deny 命中时，按顺序取第一条 allow
    assert path_rule_decision("/proj/a.py", rules)[0] is True


def test_first_allow_wins_among_allows() -> None:
    from agenticx.runtime.path_policy import path_rule_decision

    rules = [{"pattern": "*/src/*", "allow": True}, {"pattern": "*", "allow": True}]
    assert path_rule_decision("/proj/src/a.py", rules) == (True, "*/src/*")


def test_allow_rule_only_skips_confirmation(permissions, tmp_path) -> None:
    """allow 是「免确认」，不是「放开沙箱」。

    一条手滑写成 ``/**`` 的 allow 规则不该把工作区隔离作废——边界由
    _resolve_workspace_path 与 OS 沙箱负责，配置项没有拆掉它的能力。
    """
    permissions["permissions.path_rules"] = [{"pattern": "/**", "allow": True}]
    outside = Path("/etc/passwd")
    assert agent_tools._path_allowed_without_confirm(outside) is True
    # 但它仍然是受保护路径，解析阶段照样拒绝
    assert agent_tools._is_protected_path(Path.home() / ".ssh" / "id_rsa") is True


def test_missing_allow_field_defaults_to_allow(permissions, tmp_path) -> None:
    """与前端一致：只有显式 false 才是拒绝。"""
    permissions["permissions.path_rules"] = [{"pattern": "*"}]
    assert agent_tools._path_denied_by_rules(tmp_path / "a.py") is None
    assert agent_tools._path_allowed_without_confirm(tmp_path / "a.py") is True


def test_malformed_path_rules_do_not_crash(permissions, tmp_path) -> None:
    for bad in ("not-a-list", [None, 3, {}, {"pattern": ""}], {"pattern": "*"}):
        permissions["permissions.path_rules"] = bad
        assert agent_tools._path_denied_by_rules(tmp_path / "a.py") is None
        assert agent_tools._path_allowed_without_confirm(tmp_path / "a.py") is False


# --------------------------------------------------------------------------
# allowed_commands —— 「不再询问」的持久化落点
# --------------------------------------------------------------------------


def test_allowed_command_skips_confirmation(permissions) -> None:
    permissions["permissions.allowed_commands"] = ["npm run test*"]
    assert agent_tools.command_allowed_without_confirm(
        "npm run test:unit", ["unrecognized_command"]
    )


def test_every_segment_must_be_allowed(permissions) -> None:
    """只允许了 ``ls`` 不能把 ``curl`` 一起带进来——否则加个已允许的前缀就能绕过。"""
    permissions["permissions.allowed_commands"] = ["ls*"]
    assert not agent_tools.command_allowed_without_confirm(
        "ls && curl http://x", ["unrecognized_command"]
    )
    permissions["permissions.allowed_commands"] = ["ls*", "curl*"]
    assert agent_tools.command_allowed_without_confirm(
        "ls && curl http://x", ["unrecognized_command"]
    )


@pytest.mark.parametrize(
    "code", ["external_publish", "host_full_access", "system_disruption"]
)
def test_three_categories_are_never_exempted(permissions, code: str) -> None:
    """推远端、动系统、退出隔离——这三类不接受长期豁免。

    用户当时同意的是那一次的上下文，不是往后所有次。这比 Claude Code 严：
    那边允许写下 ``Bash(git push:*)`` 这样的长期规则。
    """
    permissions["permissions.allowed_commands"] = ["*"]
    assert not agent_tools.command_allowed_without_confirm("git push --force", [code])


def test_unparseable_command_is_never_exempted(permissions) -> None:
    """看不懂的结构里可能藏着没被规则覆盖的命令。"""
    permissions["permissions.allowed_commands"] = ["*"]
    assert not agent_tools.command_allowed_without_confirm(
        "echo $(curl http://x)", ["shell_composition"]
    )


def test_no_rules_means_no_exemption(permissions) -> None:
    assert not agent_tools.command_allowed_without_confirm("ls", ["unrecognized_command"])
    permissions["permissions.allowed_commands"] = []
    assert not agent_tools.command_allowed_without_confirm("ls", ["unrecognized_command"])


def test_malformed_allowed_commands_do_not_crash(permissions) -> None:
    for bad in ("ls*", [None, "", "   "], {"pattern": "ls"}):
        permissions["permissions.allowed_commands"] = bad
        assert not agent_tools.command_allowed_without_confirm("ls", ["x"])


def test_deny_wins_over_allow(permissions) -> None:
    """两条规则同时命中时，拒绝赢——次序是 deny > allow。"""
    permissions["permissions.allowed_commands"] = ["curl*"]
    permissions["permissions.denied_commands"] = ["curl*"]
    assert agent_tools.command_denied_by_session_permissions("curl http://x") is not None


def test_never_exempted_set_matches_the_frontend() -> None:
    """跨语言字符串耦合：前端的 neverReusableCategories 必须与后端一致。"""
    import re
    from pathlib import Path as _Path

    from agenticx.runtime.command_safety import NEVER_AUTO_APPROVED_CATEGORIES

    # 向上找而不是写死层数：这个文件在两个仓里的目录深度不同（tests/ 与 tests/contract/）。
    relative = _Path("desktop") / "src" / "utils" / "confirm-scope.ts"
    for base in _Path(__file__).resolve().parents:
        candidate = base / relative
        if candidate.is_file():
            source = candidate.read_text(encoding="utf-8")
            break
    else:
        raise AssertionError(f"找不到 {relative}")
    block = re.search(
        r"neverReusableCategories = new Set\(\[(.*?)\]\)", source, re.S
    )
    assert block is not None, "前端找不到 neverReusableCategories"
    frontend = set(re.findall(r'"([^"]+)"', block.group(1)))
    assert frontend == set(NEVER_AUTO_APPROVED_CATEGORIES), (
        f"前端 {sorted(frontend)} 与后端 {sorted(NEVER_AUTO_APPROVED_CATEGORIES)} 不一致——"
        "改一边必须同步改另一边。"
    )


# --------------------------------------------------------------------------
# plan 模式必须覆盖全部写入路径（不只是 bash 沙箱档位）
# --------------------------------------------------------------------------


def test_plan_mode_blocks_every_write_not_just_bash(permissions, tmp_path) -> None:
    """file_write / file_edit / 技能写入都不走 bash 那条路径。

    只钳制 sandbox_permissions 的话，「计划模式完全不修改」这个承诺对文件工具是假的。
    所有要写的解析都必须先过 ``_resolve_workspace_path(for_write=True)``，闸设在那里。
    """
    permissions["permissions.mode"] = "plan"
    assert agent_tools._plan_mode_active() is True
    with pytest.raises(ValueError, match="plan"):
        agent_tools._resolve_workspace_path(str(tmp_path / "a.txt"), None, for_write=True)


def test_plan_mode_still_allows_reads(permissions, tmp_path) -> None:
    """计划模式是「不修改」，不是「不能看」——读照常。"""
    permissions["permissions.mode"] = "plan"
    # 读路径不经过 for_write 闸。断言要对准 plan 模式那条具体信息——用子串 "plan" 判断
    # 会被 pytest 的临时目录名（test_plan_mode_...）误伤。
    try:
        agent_tools._resolve_workspace_path(str(tmp_path / "a.txt"), None, for_write=False)
    except ValueError as exc:
        assert "read-only): writing is disabled" not in str(exc), (
            f"读也被 plan 模式挡了：{exc}"
        )


def test_unreadable_config_does_not_lock_writes(monkeypatch) -> None:
    """读配置失败不该把用户锁死在只读里。"""

    def _boom(*_a, **_kw):
        raise RuntimeError("config unavailable")

    monkeypatch.setattr(ConfigManager, "get_value", staticmethod(_boom))
    assert agent_tools._plan_mode_active() is False


# --------------------------------------------------------------------------
# 持久化批准绑定工作区
# --------------------------------------------------------------------------


def test_workspace_scoped_rule_binds_to_the_running_directory(
    permissions, tmp_path
) -> None:
    """判据是「这条命令现在跑在哪」，不是「会话挂载过哪些根」。

    原实现检查授权工作区是否出现在会话的任意挂载根里。一个会话可以同时挂载 A、B；
    那样写的话，在 A 里按下的批准会连带放行在 B 里跑的同一条命令——CodeX 复现过。
    """
    project_a = tmp_path / "a"
    project_b = tmp_path / "b"
    project_a.mkdir()
    project_b.mkdir()
    permissions["permissions.allowed_commands"] = [
        {"pattern": "npm run build", "workspace": str(project_a)}
    ]

    assert agent_tools.command_allowed_without_confirm(
        "npm run build", ["x"], cwd=project_a
    )
    assert not agent_tools.command_allowed_without_confirm(
        "npm run build", ["x"], cwd=project_b
    ), "在 B 里跑的命令被 A 的规则放行了"
    # 子目录算在授权工作区内
    nested = project_a / "packages" / "web"
    nested.mkdir(parents=True)
    assert agent_tools.command_allowed_without_confirm(
        "npm run build", ["x"], cwd=nested
    )


def test_unknown_running_directory_honours_only_global_rules(
    permissions, tmp_path
) -> None:
    """取不到执行目录时宁可多问，不拿别处的授权放行。"""
    permissions["permissions.allowed_commands"] = [
        {"pattern": "npm run build", "workspace": str(tmp_path)}
    ]
    assert not agent_tools.command_allowed_without_confirm("npm run build", ["x"], cwd=None)


def test_legacy_string_rules_stay_global(permissions, tmp_path) -> None:
    """旧的裸字符串配置不能因为加了工作区限定就失效。"""
    permissions["permissions.allowed_commands"] = ["npm run *"]
    assert agent_tools.command_allowed_without_confirm("npm run build", ["x"], cwd=tmp_path)



# --------------------------------------------------------------------------
# allowed_tools —— 语义定为「免确认」
# --------------------------------------------------------------------------
#
# 这个字段长期没有定义过语义:「只允许这些工具」和「这些工具免确认」两种读法的安全
# 含义完全相反。选前者的三条理由写在 tool_allowed_without_confirm 的 docstring 里,
# 核心是:同一份配置里的 allowed_commands 已经是「免确认」,同一个 allowed_ 前缀在
# 相邻两行表示相反的东西,是最容易读错的那种设计。


def test_allowed_tool_skips_the_confirm(permissions) -> None:
    permissions["permissions.allowed_tools"] = ["file_write"]
    assert agent_tools.tool_allowed_without_confirm("file_write") is True
    assert agent_tools.tool_allowed_without_confirm("file_edit") is False


def test_allowed_tools_accepts_fnmatch_patterns(permissions) -> None:
    permissions["permissions.allowed_tools"] = ["file_*"]
    assert agent_tools.tool_allowed_without_confirm("file_write") is True
    assert agent_tools.tool_allowed_without_confirm("bash_exec") is False


def test_deny_still_wins_over_allow(permissions) -> None:
    """次序不能颠倒:deny 是绝对的,allow 只能免除询问。"""
    permissions["permissions.allowed_tools"] = ["bash_exec"]
    permissions["permissions.denied_tools"] = ["bash_exec"]
    assert agent_tools.tool_denied_by_session_permissions("bash_exec") is not None
    assert agent_tools.tool_policy_denial("bash_exec") is not None


def test_plan_ceiling_still_wins_over_allow(permissions) -> None:
    permissions["permissions.allowed_tools"] = ["file_write"]
    permissions["permissions.mode"] = "plan"
    assert agent_tools.tool_policy_denial("file_write") is not None


@pytest.mark.parametrize(
    "code", ["external_publish", "host_full_access", "system_disruption"]
)
def test_the_three_categories_are_never_exempted_by_allowed_tools(
    permissions, code: str
) -> None:
    """``allowed_tools: ["bash_exec"]`` 等价于 ``allowed_commands: ["*"]``。

    那是一个已经支持、也已经被测试钉住的配置——三类高危照样逐次问,所以这不是
    新开的口子。
    """
    permissions["permissions.allowed_tools"] = ["bash_exec"]
    assert agent_tools.tool_allowed_without_confirm("bash_exec", [code]) is False
    assert agent_tools.tool_allowed_without_confirm("bash_exec", ["unrecognized_command"]) is True


def test_malformed_allowed_tools_do_not_crash(permissions) -> None:
    for bad in ("not-a-list", 42, {"a": 1}, [None, "", 3]):
        permissions["permissions.allowed_tools"] = bad
        assert agent_tools.tool_allowed_without_confirm("file_write") is False


def test_unset_allowed_tools_changes_nothing(permissions) -> None:
    assert agent_tools.tool_allowed_without_confirm("file_write") is False


# --------------------------------------------------------------------------
# plan 模式在统一调度入口拦写工具
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tool",
    ["file_write", "file_edit", "codegen", "memory_append", "skill_manage",
     "hook_manage", "schedule_task", "todo_write", "mcp_connect"],
)
def test_plan_mode_blocks_write_tools_at_dispatch(permissions, tool: str) -> None:
    """写工具大多不经过 _resolve_workspace_path(for_write=True)。

    codegen 用普通读路径解析后直接写文件；memory_append / skill_manage / hook_manage /
    定时任务各有自己的写入路径。只靠文件路径校验兜底的话，「计划模式完全不修改」
    对这些工具全是假的。策略必须在统一工具调度入口先拦一道。
    """
    permissions["permissions.mode"] = "plan"
    assert agent_tools.tool_blocked_by_plan_mode(tool) is not None


@pytest.mark.parametrize(
    "tool",
    ["file_read", "list_files", "grep" , "knowledge_search", "session_search",
     "lsp_hover", "web_search", "request_clarification", "bash_exec"],
)
def test_plan_mode_leaves_read_tools_alone(permissions, tool: str) -> None:
    """计划模式是「不修改」，不是「不能看」。

    bash_exec 也不在拦截名单里：它由沙箱档位钳到 read-only，命令能跑但写不进去，
    比一刀切拒绝更有用——plan 模式仍然要能 grep、能看 git log。
    """
    permissions["permissions.mode"] = "plan"
    assert agent_tools.tool_blocked_by_plan_mode(tool) is None


def test_non_plan_mode_blocks_nothing(permissions) -> None:
    permissions["permissions.mode"] = "default"
    assert agent_tools.tool_blocked_by_plan_mode("file_write") is None


def test_plan_mode_does_not_break_bash_cwd_resolution(permissions, tmp_path) -> None:
    """plan 下 bash 显式传 cwd 时，只读命令不能被写闸误伤。

    cwd 是「进到哪个目录」不是「往哪写」。用 for_write=True 解析它，会让 plan 下的
    ``ls`` 也被拒——那是 2026-08-24 加 plan 闸时引入的回归。
    """
    permissions["permissions.mode"] = "plan"
    try:
        agent_tools._resolve_workspace_path(str(tmp_path), None, for_write=False)
    except ValueError as exc:
        assert "writing is disabled" not in str(exc), f"只读解析被 plan 闸误伤：{exc}"


# --------------------------------------------------------------------------
# 统一入口：dispatch_tool_async 才是唯一的执行口
# --------------------------------------------------------------------------
#
# 2026-08-24 的第一版把策略闸挂在 AgentRuntime 的聊天主循环上，并把那里称作「统一
# 工具调度入口」。它不是：``dispatch_tool_async`` 才是。语音工具代理
# （studio/voice_endpoints.py 的 /api/voice/tool_call）直接调后者，而语音的默认工具
# 集里就有 mcp_call；知识预取和同步版 dispatch_tool 也一样。
#
# 实测过的绕过：denied_tools=["mcp_call"] 下主循环拒绝，直接调度执行到底。


def test_policy_gate_is_shared_by_both_checks(permissions) -> None:
    """一个入口一次判定：denied_tools 和 plan 上限走同一个函数。"""
    permissions["permissions.denied_tools"] = ["mcp_call"]
    assert agent_tools.tool_policy_denial("mcp_call") is not None
    permissions["permissions.denied_tools"] = []
    permissions["permissions.mode"] = "plan"
    assert agent_tools.tool_policy_denial("file_write") is not None
    assert agent_tools.tool_policy_denial("file_read") is None


def test_denied_tool_is_blocked_at_dispatch_not_only_in_the_chat_loop(permissions) -> None:
    """绕开聊天主循环直接调度，也必须被拒。

    这条盯的是语音代理那条路径。断言用 dispatch_tool_async 本身，而不是主循环——
    主循环那次检查是给界面用的（能生成一张被拒卡片），不是安全边界。
    """
    import asyncio

    permissions["permissions.denied_tools"] = ["mcp_call"]

    class _Session:
        mcp_hub = None
        _team_manager = None

    out = asyncio.run(
        agent_tools.dispatch_tool_async("mcp_call", {"tool_name": "x"}, _Session())
    )
    assert "已被会话权限策略拒绝" in out, out
    # 「no MCP hub connected」说明请求已经跑进了工具实现里——闸没拦住。
    assert "no MCP hub" not in out


def test_plan_mode_blocks_write_tools_at_dispatch_too(permissions) -> None:
    import asyncio

    permissions["permissions.mode"] = "plan"

    class _Session:
        mcp_hub = None
        _team_manager = None

    out = asyncio.run(
        agent_tools.dispatch_tool_async(
            "memory_append", {"content": "x"}, _Session()
        )
    )
    assert "plan" in out and "disabled" in out, out


@pytest.mark.parametrize(
    "tool",
    ["verify_run", "feature_select", "feature_complete", "mcp_call",
     "send_bug_report_email", "update_email_config",
     "create_avatar", "create_group_chat", "set_taskspace"],
)
def test_plan_mode_covers_the_side_effecting_tools_outside_the_file_path(
    permissions, tool: str
) -> None:
    """写入面不止文件工具。

    verify_run 最典型：它 subprocess.run 项目 verify.yaml 里写的命令，既不过命令沙箱
    也不过路径校验。plan 模式下漏掉它，「只读」就能被一条项目配置绕开。
    """
    permissions["permissions.mode"] = "plan"
    assert agent_tools.tool_blocked_by_plan_mode(tool) is not None


@pytest.mark.parametrize(
    "tool", ["spawn_subagent", "query_subagent_status", "send_message_to_agent"]
)
def test_plan_mode_leaves_delegation_alone(permissions, tool: str) -> None:
    """委派方不拦：被委派方的每次工具调用都会再过一次同一个闸。

    拦在这里换不来额外的只读保证，只会让 plan 模式没法并行调研。
    """
    permissions["permissions.mode"] = "plan"
    assert agent_tools.tool_blocked_by_plan_mode(tool) is None


def test_meta_dispatcher_enforces_policy_on_its_own(permissions) -> None:
    """meta-only 工具在 AgentRuntime 里走的是绕过 dispatch_tool_async 的分支。

    create_group_chat / set_taskspace 这些名字根本不在 META_TOOL_NAMES 里，
    从 dispatch_tool_async 走会落到「unknown tool」；它们的真实入口是
    dispatch_meta_tool_async，所以闸也要在那边有一份。
    """
    import asyncio

    from agenticx.runtime.meta_tools import dispatch_meta_tool_async

    permissions["permissions.denied_tools"] = ["create_group_chat"]
    out = asyncio.run(
        dispatch_meta_tool_async(
            "create_group_chat", {"name": "x"}, team_manager=object()
        )
    )
    assert "已被会话权限策略拒绝" in out, out


def test_dynamic_mcp_tools_are_judged_as_mcp_call(permissions) -> None:
    """动态 MCP 工具用公开名执行，入口那次判定认不出它是 MCP 调用。

    原来的注释写着「catalog 只在 mcp_call 允许时才有内容，父级已经把过关」。
    但 catalog 是 tool_search 阶段建的，事后再禁 mcp_call 或切到 plan 模式都不会
    重建它——那句话在配置变更后就不成立了。
    """
    permissions["permissions.mode"] = "plan"
    # 公开名本身没有被 plan 拦（它不在名单里），但 mcp_call 被拦了。
    assert agent_tools.tool_blocked_by_plan_mode("browser_navigate") is None
    assert agent_tools.tool_policy_denial("mcp_call") is not None


# --------------------------------------------------------------------------
# 「不再询问」的作用域必须在默认工作目录下也命中
# --------------------------------------------------------------------------


def test_workspace_scoped_approval_matches_the_default_cwd(permissions, tmp_path) -> None:
    """绝大多数 bash_exec 调用不传 cwd。

    第一版把 ``cwd = default_cwd`` 的兜底放在构建沙箱计划之前，而作用域判定发生在
    更早的位置——于是工作区限定的规则只在显式传 cwd 时才可能命中，等于这个功能
    对常见调用不存在。
    """
    workspace = tmp_path / "proj-a"
    workspace.mkdir()
    permissions["permissions.allowed_commands"] = [
        {"pattern": "npm run test", "workspace": str(workspace)}
    ]
    patterns = agent_tools._allowed_command_patterns_for_workspace(
        permissions["permissions.allowed_commands"], workspace
    )
    assert patterns == [agent_tools.AllowedCommandRule("npm run test", literal=True)]
    # 拿不到执行目录时只认全局规则——宁可多问。
    assert agent_tools._allowed_command_patterns_for_workspace(
        permissions["permissions.allowed_commands"], None
    ) == []


def test_relative_redirect_after_cd_is_judged_by_the_stricter_candidate(
    permissions, tmp_path, monkeypatch
) -> None:
    """候选集判不准时按只读那种算。

    ``cd <只读挂载> && echo >> requirements.txt`` 的相对落点有两种解释：cwd 下的
    （可写）和 cd 目标下的（只读）。守卫不解析 shell 的 cd 语义，所以两个都是候选。
    把 cwd 兜底提前之后，可写那个排在前面——原来的「撞到第一个可写就收工」等于在
    两种解释里挑了放行的那种，只读挂载就被写进去了。
    """
    import json

    from agenticx.cli.agent_tools import dispatch_tool
    from agenticx.cli.studio import StudioSession

    monkeypatch.delenv("AGX_DESKTOP_UNRESTRICTED_FS", raising=False)
    ws = tmp_path / "ws"
    ws.mkdir()
    ref = tmp_path / "ref"
    ref.mkdir()
    (ref / "requirements.txt").write_text("base\n", encoding="utf-8")
    (ws / ".agx-mounts.json").write_text(
        json.dumps(
            {
                "version": 1,
                "mounts": [
                    {
                        "name": "ref",
                        "mode": "reference",
                        "source_path": str(ref.resolve()),
                        "linked_at": 1.0,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("AGX_WORKSPACE_ROOT", str(ws))
    session = StudioSession()
    session.workspace_dir = str(ws)
    session.taskspaces = [
        {"id": "default", "label": "默认工作区", "path": str(ws), "mount_mode": "link"},
    ]
    result = dispatch_tool(
        "bash_exec",
        {"command": f"cd {ref} && echo 'x' >> requirements.txt"},
        session,
    )
    assert "read-only" in result, result


# --------------------------------------------------------------------------
# 界面写下的规则是「这一条」，不是「这一类」
# --------------------------------------------------------------------------


def test_ui_written_rules_match_the_exact_command_only(permissions, tmp_path) -> None:
    """按钮上写的是「以后都不再问**这条**命令」，那就得是这条。

    规则用 fnmatch 存的话，命令里恰好带 ``*`` 就会把「这一条」悄悄放大成「这一类」，
    而设置界面上仍然只显示那条命令——用户没有任何机会发现自己批准的范围变了。
    """
    permissions["permissions.allowed_commands"] = [
        {"pattern": "rm -rf build/*", "workspace": str(tmp_path)}
    ]
    assert agent_tools.command_allowed_without_confirm(
        "rm -rf build/*", ["x"], cwd=tmp_path
    )
    # 同一条规则不能顺带放行别的 rm。
    assert not agent_tools.command_allowed_without_confirm(
        "rm -rf build/../src", ["x"], cwd=tmp_path
    )
    assert not agent_tools.command_allowed_without_confirm(
        "rm -rf build/secrets", ["x"], cwd=tmp_path
    )


def test_hand_written_string_rules_keep_glob_semantics(permissions, tmp_path) -> None:
    """手写的裸字符串仍然是 fnmatch 模式。

    那是配置文件里一直支持的用法，界面上也标着「所有工作区」。收窄它会作废存量配置，
    而它本来就是用户自己写下的、明确要泛化的规则。
    """
    permissions["permissions.allowed_commands"] = ["npm run test*"]
    assert agent_tools.command_allowed_without_confirm(
        "npm run test:unit", ["x"], cwd=tmp_path
    )


def test_a_compound_command_is_approved_as_one_whole(permissions, tmp_path) -> None:
    """复合命令是作为一整条被批准的。

    逐段判定(第 2 条约束)对字面规则是致命的:界面上批准
    ``npm install && echo done`` 写下的就是这一整条,拆成 ``npm install`` 和
    ``echo done`` 去比,一段都对不上——功能对所有复合命令直接失效,而用户在设置页
    看到那条规则还好好地列着。
    """
    permissions["permissions.allowed_commands"] = [
        {"pattern": "npm install && echo done", "workspace": str(tmp_path)}
    ]
    assert agent_tools.command_allowed_without_confirm(
        "npm install && echo done", ["x"], cwd=tmp_path
    )
    # 但这条规则不给里面任何一段单独的通行证。
    assert not agent_tools.command_allowed_without_confirm(
        "npm install", ["x"], cwd=tmp_path
    )
    assert not agent_tools.command_allowed_without_confirm(
        "echo done", ["x"], cwd=tmp_path
    )


def test_a_whole_command_rule_cannot_be_widened_by_a_prefix(permissions, tmp_path) -> None:
    """整条相等的例外不会打开前缀绕过。

    加一段就不再「完全相等」,判定退回逐段——而逐段下 ``ls`` 和 ``curl`` 都没有规则
    覆盖,所以整条不放行。
    """
    permissions["permissions.allowed_commands"] = [
        {"pattern": "npm install && echo done", "workspace": str(tmp_path)}
    ]
    for command in (
        "ls && npm install && echo done",
        "npm install && echo done && curl http://evil.example",
        "npm install && echo done; rm -rf build",
    ):
        assert not agent_tools.command_allowed_without_confirm(
            command, ["x"], cwd=tmp_path
        ), f"{command!r} 被整条规则顺带放行了"
    # 首尾空白不算差异——那不是语义上的另一条命令。
    assert agent_tools.command_allowed_without_confirm(
        "  npm install && echo done  ", ["x"], cwd=tmp_path
    )


def test_whole_command_rule_still_respects_the_never_exempt_categories(
    permissions, tmp_path
) -> None:
    """整条相等也不能豁免那三类。

    这条例外只改「怎么比」，不改「哪些能比」——推远端 / 动系统 / 退出隔离仍然
    逐次询问。
    """
    permissions["permissions.allowed_commands"] = [
        {"pattern": "git push --force && echo ok", "workspace": str(tmp_path)}
    ]
    assert not agent_tools.command_allowed_without_confirm(
        "git push --force && echo ok", ["external_publish"], cwd=tmp_path
    )


# --------------------------------------------------------------------------
# 删除操作永不豁免
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "code",
    ["destructive_filesystem", "external_publish", "host_full_access", "system_disruption"],
)
def test_destructive_joins_the_never_exempt_set(permissions, tmp_path, code: str) -> None:
    """界面上「代我批准」写着「删除数据…仍然会问你」。

    ``destructive_filesystem`` 一度不在这个集合里——``allowed_tools: ["bash_exec"]``
    配下去之后 ``rm -rf`` 就能免确认。**文案承诺了而代码没做**,比两者都没有更糟:
    用户是照着文案决定要不要开这一档的。
    """
    permissions["permissions.allowed_tools"] = ["bash_exec"]
    permissions["permissions.allowed_commands"] = [
        {"pattern": "rm -rf build", "workspace": str(tmp_path)}
    ]
    assert agent_tools.tool_allowed_without_confirm("bash_exec", [code]) is False
    assert (
        agent_tools.command_allowed_without_confirm("rm -rf build", [code], cwd=tmp_path)
        is False
    )


def test_ordinary_commands_are_still_exemptible(permissions, tmp_path) -> None:
    """收紧不能把这一档变得没法用——不带这四类的命令照常免确认。"""
    permissions["permissions.allowed_tools"] = ["bash_exec"]
    assert agent_tools.tool_allowed_without_confirm(
        "bash_exec", ["unrecognized_command"]
    ) is True


# --------------------------------------------------------------------------
# 有持久 / 对外副作用的工具必须过确认闸
# --------------------------------------------------------------------------
#
# 在这之前，「每次询问 / 代我批准」实际只覆盖 Shell 与文件操作：这几个工具从头到尾
# 不调 _confirm。于是运行模式更准确的名字是「Shell 与文件确认模式」，而设置页写的是
# 「沙箱兜不住的操作，每次都问你」。
#
# create_avatar 最能说明问题：它的 schema 里写着「必须先调 request_action_confirmation
# 拿到 [ACTION_CONFIRMED] 再调用本工具」，运行时对此没有任何强制。那是一句写给模型看
# 的话——权限模型的一部分建立在「模型会遵守描述文字」上。


class _RecordingGate:
    """记下问了什么，并按预设答复。"""

    def __init__(self, approve: bool) -> None:
        self.approve = approve
        self.requests: list[tuple[str, dict]] = []
        self.last_denial_note = ""

    async def request_confirm(self, question: str, context: dict | None = None) -> bool:
        self.requests.append((question, dict(context or {})))
        return self.approve

    def should_emit_prompt(self, context: dict | None = None) -> bool:
        return False

    def is_service_mode(self) -> bool:
        return True


SIDE_EFFECT_TOOLS = sorted(agent_tools.SIDE_EFFECT_CONFIRM_SPECS)


@pytest.mark.parametrize("tool", SIDE_EFFECT_TOOLS)
def test_side_effecting_tools_ask_before_they_run(permissions, tool: str) -> None:
    import asyncio

    gate = _RecordingGate(approve=True)
    refusal = asyncio.run(
        agent_tools.confirm_side_effect_tool(
            tool, {"name": "x", "to_email": "a@b.c", "path": "/tmp/x"}, confirm_gate=gate
        )
    )
    assert refusal is None
    assert len(gate.requests) == 1, f"{tool} 没有问"


@pytest.mark.parametrize("tool", SIDE_EFFECT_TOOLS)
def test_refusing_stops_the_tool(permissions, tool: str) -> None:
    """拒绝要返回 CANCELLED 文案，而不是让调用继续往下走。"""
    import asyncio

    gate = _RecordingGate(approve=False)
    refusal = asyncio.run(
        agent_tools.confirm_side_effect_tool(tool, {"name": "x"}, confirm_gate=gate)
    )
    assert refusal is not None and refusal.startswith("CANCELLED"), refusal


@pytest.mark.parametrize("tool", SIDE_EFFECT_TOOLS)
def test_none_of_them_is_marked_low_risk(tool: str) -> None:
    """``low`` 在「代我批准」档下会被确认闸直接放行。

    这几条每一条都是持久的或者对外的——发出去的邮件收不回来，定时任务此后在没人看着
    的时候跑。把它们标成 low 等于换了个地方绕过确认。
    """
    from agenticx.runtime.confirm import is_protected_confirm

    spec = agent_tools.SIDE_EFFECT_CONFIRM_SPECS[tool]
    assert spec.risk != "low"
    assert is_protected_confirm({"risk": spec.risk}) is True


@pytest.mark.parametrize("tool", SIDE_EFFECT_TOOLS)
def test_the_question_names_the_object_not_just_the_tool(tool: str) -> None:
    """「要创建一个分身吗」和「要创建名为 X 的分身吗」是两个问题。

    只有工具名没有对象的确认框，用户没有可判断的东西，只会一路点同意——那时候确认
    框就只是在收集点击，不是在收集决定。
    """
    import asyncio

    gate = _RecordingGate(approve=True)
    arguments = {
        "name": "宣传片脚本",
        "to_email": "ops@example.com",
        "subject": "崩溃报告",
        "path": "/Users/me/secrets",
        "frequency": "每天",
        "time": "09:00",
        "workspace": "/Users/me/proj",
        "smtp_host": "smtp.example.com",
        "members": ["a", "b"],
    }
    asyncio.run(
        agent_tools.confirm_side_effect_tool(tool, arguments, confirm_gate=gate)
    )
    question = gate.requests[0][0]
    assert any(
        token in question
        for token in ("宣传片脚本", "ops@example.com", "/Users/me/secrets", "smtp_host")
    ), question


def test_unlisted_tools_are_not_slowed_down(permissions) -> None:
    """这张表只覆盖有持久/对外副作用的那几个，别的工具一次也不该被问。"""
    import asyncio

    gate = _RecordingGate(approve=True)
    assert (
        asyncio.run(
            agent_tools.confirm_side_effect_tool("file_read", {}, confirm_gate=gate)
        )
        is None
    )
    assert gate.requests == []


def test_deny_still_short_circuits_before_the_question(permissions) -> None:
    """次序不能颠倒：denied_tools 是绝对的，不该先问一遍再拒绝。

    先问后拒会教会用户「问了也没用」，而且把一次本来干净的拒绝变成一次打扰。
    """
    import asyncio

    from agenticx.runtime.meta_tools import dispatch_meta_tool_async

    gate = _RecordingGate(approve=True)
    permissions["permissions.denied_tools"] = ["create_avatar"]
    out = asyncio.run(
        dispatch_meta_tool_async(
            "create_avatar",
            {"name": "x"},
            team_manager=object(),
            confirm_gate=gate,
        )
    )
    assert out.startswith("ERROR:")
    assert gate.requests == []


def test_plan_mode_short_circuits_before_the_question(permissions) -> None:
    import asyncio

    from agenticx.runtime.meta_tools import dispatch_meta_tool_async

    gate = _RecordingGate(approve=True)
    permissions["permissions.mode"] = "plan"
    out = asyncio.run(
        dispatch_meta_tool_async(
            "send_bug_report_email",
            {"to_email": "a@b.c"},
            team_manager=object(),
            confirm_gate=gate,
        )
    )
    assert out.startswith("ERROR:")
    assert gate.requests == []


def test_allowed_tools_still_exempts_them(permissions) -> None:
    """``allowed_tools`` 的语义是免确认，对这几个工具也照常生效。

    不然就成了「这张表比用户自己写下的规则还大」——新加的闸不该顺手改掉已有语义。
    四类高危仍然永不豁免，那条在 tool_allowed_without_confirm 里。
    """
    import asyncio

    gate = _RecordingGate(approve=False)
    permissions["permissions.allowed_tools"] = ["create_avatar"]
    refusal = asyncio.run(
        agent_tools.confirm_side_effect_tool(
            "create_avatar", {"name": "x"}, confirm_gate=gate
        )
    )
    assert refusal is None
    assert gate.requests == []
