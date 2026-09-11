#!/usr/bin/env python3
"""``/api/permissions`` 是权限设置界面唯一的读写口。

这里盯三件事:

1. **mode 是运行模式唯一的持久化字段。** 曾经是两处——这里存 default/plan,桌面端
   配置另存一个 confirm_strategy。两处写入就有写成一半的可能,于是又要做回滚和对账,
   而「请求失败」并不等于「没写进去」。合成一个字段之后那套补偿逻辑整个删掉了。
   读写两侧都只认 plan/ask/auto,**没有旧配置兼容**:桌面端还没公开,没有需要被迁移的
   人,而那条迁移分支本身就是第二个真相的来源(它读的那个字段用户在界面上改不掉)。

2. **「不再询问」写下的规则必须能被读回来。** 一条只能写不能读的授权等于用户失去
   了对它的控制:看不到,也撤销不了。

3. **追加动作在后端做。** 让渲染层读改写的话,两个窗口同时按下按钮会互相覆盖,
   而规则一旦丢了用户不会发现——他只会觉得「不再询问」没生效。

Author: Damon Li
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agenticx.cli.config_manager import ConfigManager
from agenticx.studio.server import create_studio_app


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    """把配置指到临时文件,不碰开发者真实的 config.yaml。"""
    monkeypatch.delenv("AGX_DESKTOP_TOKEN", raising=False)
    monkeypatch.setattr(ConfigManager, "GLOBAL_CONFIG_PATH", tmp_path / "config.yaml")
    monkeypatch.setattr(ConfigManager, "PROJECT_CONFIG_PATH", tmp_path / "project.yaml")
    return TestClient(create_studio_app())


# --------------------------------------------------------------------------
# mode
# --------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["plan", "ask", "auto"])
def test_supported_modes_are_accepted(client: TestClient, mode: str) -> None:
    res = client.put("/api/permissions", json={"mode": mode})
    assert res.status_code == 200, res.text
    assert res.json()["mode"] == mode
    assert client.get("/api/permissions").json()["mode"] == mode


@pytest.mark.parametrize(
    "mode", ["acceptEdits", "bypassPermissions", "yolo", "default", "semi-auto", ""]
)
def test_modes_without_an_implementation_are_rejected(client: TestClient, mode: str) -> None:
    """只有三个真实取值。

    ``default`` / ``semi-auto`` 是历史取值，现在读写两侧都不认。
    acceptEdits / bypassPermissions 是最危险的一类：名字听起来正好是用户想要的东西，
    存进去之后界面还会显示回来，执行路径上却零引用。
    """
    res = client.put("/api/permissions", json={"mode": mode})
    assert res.status_code == 400, res.text
    assert "unsupported permissions.mode" in res.text
    # 被拒之后配置不能被改脏。
    assert client.get("/api/permissions").json()["mode"] == "ask"


def test_a_fresh_config_reads_as_ask(client: TestClient) -> None:
    """没配过的用户落在「每次询问」，不是「代我批准」。"""
    assert client.get("/api/permissions").json()["mode"] == "ask"


@pytest.mark.parametrize("stored", ["default", "full_auto", "semi-auto", "yolo", ""])
def test_unrecognised_stored_values_fall_back_to_ask(client: TestClient, stored: str) -> None:
    """认不出来的一律 ask——**往严的方向兜底**。

    落到 auto 会让人在不知情的情况下少收到确认，而他没有任何迹象可以发现。
    """
    ConfigManager.set_value("permissions.mode", stored)
    assert client.get("/api/permissions").json()["mode"] == "ask"


def test_the_legacy_confirm_strategy_field_has_no_effect(client: TestClient) -> None:
    """``confirm_strategy`` 不再参与任何判定——包括迁移。

    这个字段是上一轮那个 bug 的全部内容：执行路径先看它、设置接口先看
    ``permissions.mode``，于是用户在界面上选「每次询问」、配置里也确实写成了 ask，
    而确认闸仍在自动批准低风险操作。**他改不掉那个字段，也看不到它。**

    以前的补救是「只允许它参与一次迁移」。现在直接删掉：桌面端还没公开，没有需要被
    迁移的人，为一个不存在的用户留一条会改变确认行为的分支不划算。
    """
    ConfigManager.set_value("permissions.mode", "ask")
    ConfigManager.set_value("confirm_strategy", "auto")
    assert client.get("/api/permissions").json()["mode"] == "ask"

    # 连 permissions.mode 缺失时也不去看它。
    ConfigManager.set_value("permissions.mode", "")
    assert client.get("/api/permissions").json()["mode"] == "ask"


def test_reading_the_mode_does_not_rewrite_the_config(client: TestClient) -> None:
    """读接口不写配置。

    迁移那版会在 GET 里把值写回去，于是一次纯读取会改变磁盘上的配置。没有迁移就
    没有这个副作用——存什么读什么。
    """
    ConfigManager.set_value("permissions.mode", "plan")
    assert client.get("/api/permissions").json()["mode"] == "plan"
    assert str(ConfigManager.get_value("permissions.mode")) == "plan"


def test_permission_mode_belongs_to_a_session_not_the_global_default(
    client: TestClient,
) -> None:
    """Settings changes affect future sessions, not existing conversations."""

    client.put("/api/permissions", json={"mode": "auto"})
    first = client.post("/api/sessions", json={"permission_mode": "plan"})
    assert first.status_code == 200, first.text
    first_sid = first.json()["session_id"]
    assert first.json()["permission_mode"] == "plan"

    # The Settings page changes only the default for sessions created later.
    changed = client.put("/api/permissions", json={"mode": "ask"})
    assert changed.status_code == 200, changed.text
    second = client.post("/api/sessions", json={})
    assert second.status_code == 200, second.text
    second_sid = second.json()["session_id"]
    assert second.json()["permission_mode"] == "ask"

    first_mode = client.get(f"/api/sessions/{first_sid}/permissions")
    second_mode = client.get(f"/api/sessions/{second_sid}/permissions")
    assert first_mode.json()["mode"] == "plan"
    assert second_mode.json()["mode"] == "ask"
    assert first_mode.json()["global_default"] == "ask"

    # Changing one conversation must not mutate the Settings default or another session.
    updated = client.put(
        f"/api/sessions/{first_sid}/permissions", json={"mode": "auto"}
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["mode"] == "auto"
    assert client.get("/api/permissions").json()["mode"] == "ask"
    assert client.get(f"/api/sessions/{second_sid}/permissions").json()["mode"] == "ask"


# --------------------------------------------------------------------------
# allowed_commands —— 「不再询问」的读 / 写 / 撤销
# --------------------------------------------------------------------------


def test_allowed_commands_round_trip(client: TestClient) -> None:
    """写得进去,也读得回来。GET 不返回它的话,界面上就撤销不了。"""
    res = client.post(
        "/api/permissions/allowed_commands",
        json={"pattern": "npm run test", "workspace": "/proj/a"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["added"] is True
    listed = client.get("/api/permissions").json()["allowed_commands"]
    assert listed == [{"pattern": "npm run test", "workspace": "/proj/a"}]


def test_appending_the_same_rule_twice_is_a_no_op(client: TestClient) -> None:
    body = {"pattern": "npm run test", "workspace": "/proj/a"}
    client.post("/api/permissions/allowed_commands", json=body)
    res = client.post("/api/permissions/allowed_commands", json=body)
    assert res.json()["added"] is False
    assert len(client.get("/api/permissions").json()["allowed_commands"]) == 1


def test_the_same_command_in_another_workspace_is_a_separate_rule(client: TestClient) -> None:
    """同一条命令在两个仓里的含义可以完全不同。

    在 A 项目按下的「不再询问」不该连带放行 B 项目里跑的同一条命令,所以这里必须
    是两条独立的规则,而不是去重成一条。
    """
    client.post(
        "/api/permissions/allowed_commands",
        json={"pattern": "make deploy", "workspace": "/proj/a"},
    )
    client.post(
        "/api/permissions/allowed_commands",
        json={"pattern": "make deploy", "workspace": "/proj/b"},
    )
    listed = client.get("/api/permissions").json()["allowed_commands"]
    assert [rule["workspace"] for rule in listed] == ["/proj/a", "/proj/b"]


def test_a_rule_without_a_workspace_is_refused(client: TestClient) -> None:
    """没有工作区就只能写成全局规则,那正是「跨项目泛化」的来源。

    宁可这次不写(下次再问一遍),也不要悄悄扩大作用域。
    """
    res = client.post(
        "/api/permissions/allowed_commands", json={"pattern": "make deploy"}
    )
    assert res.status_code == 400
    assert "workspace is required" in res.text
    assert client.get("/api/permissions").json()["allowed_commands"] == []


def test_empty_pattern_is_refused(client: TestClient) -> None:
    res = client.post(
        "/api/permissions/allowed_commands",
        json={"pattern": "   ", "workspace": "/proj/a"},
    )
    assert res.status_code == 400
    assert "pattern is required" in res.text


def test_revoking_writes_the_whole_list_back(client: TestClient) -> None:
    """撤销走 PUT 整表回写——界面上删掉一行之后,剩下的就是完整列表。"""
    for name in ("a", "b"):
        client.post(
            "/api/permissions/allowed_commands",
            json={"pattern": f"make {name}", "workspace": "/proj"},
        )
    remaining = [{"pattern": "make b", "workspace": "/proj"}]
    res = client.put("/api/permissions", json={"allowed_commands": remaining})
    assert res.status_code == 200, res.text
    assert client.get("/api/permissions").json()["allowed_commands"] == remaining


def test_legacy_bare_string_rules_survive_a_read(client: TestClient) -> None:
    """手写的旧格式是裸字符串,全局生效。

    界面要能把它显示出来(并提示作用域是全局),否则用户会以为自己没配过东西,
    却一直在被一条看不见的规则放行。
    """
    ConfigManager.set_value("permissions.allowed_commands", ["npm run test*"])
    assert client.get("/api/permissions").json()["allowed_commands"] == ["npm run test*"]
    # 追加新规则不会把旧的挤掉。
    client.post(
        "/api/permissions/allowed_commands",
        json={"pattern": "make deploy", "workspace": "/proj"},
    )
    listed = client.get("/api/permissions").json()["allowed_commands"]
    assert listed[0] == "npm run test*"
    assert listed[1] == {"pattern": "make deploy", "workspace": "/proj"}


def test_the_execution_path_reads_the_same_value_the_settings_page_shows(
    client: TestClient,
) -> None:
    """界面显示的模式和确认闸执行的模式必须是同一个值。

    这是上一轮那个 bug 的不变式版本。当时两边各有一个读法，平时看不出来，
    只在**不一致**时显形——而不一致恰好倒向危险的一侧：显示「每次询问」，实际自动批准。
    """
    from agenticx.studio import server

    for mode in ("plan", "ask", "auto"):
        client.put("/api/permissions", json={"mode": mode})
        shown = client.get("/api/permissions").json()["mode"]
        assert shown == mode
        assert server._effective_permission_mode() == shown


# --------------------------------------------------------------------------
# 撤销走 DELETE：与追加对称，且按值删
# --------------------------------------------------------------------------


def test_revoking_removes_exactly_one_rule(client: TestClient) -> None:
    for name in ("a", "b"):
        client.post(
            "/api/permissions/allowed_commands",
            json={"pattern": f"make {name}", "workspace": "/proj"},
        )
    res = client.request(
        "DELETE",
        "/api/permissions/allowed_commands",
        params={"pattern": "make a", "workspace": "/proj"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["removed"] == 1
    assert client.get("/api/permissions").json()["allowed_commands"] == [
        {"pattern": "make b", "workspace": "/proj"}
    ]


def test_revoking_is_scoped_to_the_workspace_it_was_granted_in(client: TestClient) -> None:
    """同一条命令在两个仓里是两条规则，撤销一条不能连带撤掉另一条。

    反过来更要紧：撤销 A 项目那条却删掉了 B 项目那条，用户会以为 B 还受保护。
    """
    for workspace in ("/proj/a", "/proj/b"):
        client.post(
            "/api/permissions/allowed_commands",
            json={"pattern": "make deploy", "workspace": workspace},
        )
    client.request(
        "DELETE",
        "/api/permissions/allowed_commands",
        params={"pattern": "make deploy", "workspace": "/proj/a"},
    )
    assert client.get("/api/permissions").json()["allowed_commands"] == [
        {"pattern": "make deploy", "workspace": "/proj/b"}
    ]


def test_revoking_a_bare_string_rule_needs_no_workspace(client: TestClient) -> None:
    """手写的裸字符串规则是全局的，撤销时不带 workspace。"""
    ConfigManager.set_value("permissions.allowed_commands", ["npm run test*"])
    res = client.request(
        "DELETE", "/api/permissions/allowed_commands", params={"pattern": "npm run test*"}
    )
    assert res.json()["removed"] == 1
    assert client.get("/api/permissions").json()["allowed_commands"] == []


def test_revoking_a_scoped_rule_without_a_workspace_removes_nothing(
    client: TestClient,
) -> None:
    """少带一个参数不能变成「删掉所有同名规则」。

    撤销的失败模式是不对称的：少删一条，用户以为收回了授权而实际没有；多删一条，
    下次再问一遍。所以这里宁可什么都不删，并如实回报 removed=0。
    """
    client.post(
        "/api/permissions/allowed_commands",
        json={"pattern": "make deploy", "workspace": "/proj"},
    )
    res = client.request(
        "DELETE", "/api/permissions/allowed_commands", params={"pattern": "make deploy"}
    )
    assert res.json()["removed"] == 0
    assert len(client.get("/api/permissions").json()["allowed_commands"]) == 1


def test_revoking_something_that_is_not_there_is_not_an_error(client: TestClient) -> None:
    """两个窗口同时撤销同一条时，后一个不该看到报错。

    但 removed 必须如实是 0——界面据此判断「这次到底删掉了什么」。
    """
    res = client.request(
        "DELETE",
        "/api/permissions/allowed_commands",
        params={"pattern": "make gone", "workspace": "/proj"},
    )
    assert res.status_code == 200
    assert res.json()["removed"] == 0


def test_revoking_without_a_pattern_is_refused(client: TestClient) -> None:
    res = client.request(
        "DELETE", "/api/permissions/allowed_commands", params={"pattern": "   "}
    )
    assert res.status_code == 400
    assert "pattern is required" in res.text
