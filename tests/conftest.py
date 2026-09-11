#!/usr/bin/env python3
"""Repository-wide pytest isolation for AgenticX product data.

All product persistence is routed through ``AGX_HOME``.  This fixture assigns a
throwaway per-test Ontology root without changing the host ``HOME`` or
``USERPROFILE``; external OS paths such as ``~/.ssh`` therefore retain their
normal meaning while product data remains hermetic.

Author: Damon Li
"""

from __future__ import annotations

import os

from pathlib import Path
from typing import Iterator

import pytest

from agenticx.runtime.confirm import ConfirmGate


@pytest.fixture(autouse=True)
def _isolated_agenticx_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Prevent tests from writing into either real product data root."""
    fake_home = tmp_path / "agx_home" / ".agenticx-ontology"
    fake_home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AGX_HOME", str(fake_home))
    # 同一类问题的另一半：工作区产物（session-memory 快照等）过去按 Path.cwd() 落盘，
    # 于是跑一次测试就在仓库根目录留下一个 memory/。$HOME 管不到它，得单独指。
    workspace = fake_home / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("AGENTICX_WORKSPACE_DIR", str(workspace))
    yield


def _real_agx_home_fingerprint() -> dict[str, int]:
    """真实 HC ``~/.agenticx`` 下每个顶级子目录的**递归**条目数。

    一轮全量下来大概三万多个路径，扫两次（session 开始/结束各一次）代价可以接受。
    """
    root = Path(os.path.expanduser("~/.agenticx"))
    return _product_home_fingerprint(root)


def _real_ontology_home_fingerprint() -> dict[str, int]:
    """真实 Ontology ``~/.agenticx-ontology`` fingerprint."""
    return _product_home_fingerprint(Path.home() / ".agenticx-ontology")


def _product_home_fingerprint(root: Path) -> dict[str, int]:
    """Return recursive counts for a product root without creating it."""
    if not root.exists():
        return {}
    out: dict[str, int] = {}
    for child in root.iterdir():
        if child.is_dir():
            try:
                # 递归数，不能只数一层：曾经有一次泄漏是往已存在的
                # deliveries/demo-portal-poc/ 里塞子目录，顶层直接子项数一点没变。
                out[child.name] = sum(1 for _ in child.rglob("*"))
            except OSError:
                pass
    return out


def _session_row_count(root: Path) -> int:
    """Count session rows in one product root; a missing DB is zero."""
    import sqlite3

    db = root / "memory" / "sessions.sqlite"
    if not db.exists():
        return 0
    try:
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
            # 会话列表读的是 session_summaries；session_messages 一并算上，免得只写了
            # 消息还没写摘要的那一类漏掉。
            total = 0
            for table in ("session_summaries", "session_messages"):
                row = conn.execute(
                    f"SELECT COUNT(DISTINCT session_id) FROM {table}"  # noqa: S608 - 表名是常量
                ).fetchone()
                total += int(row[0])
            return total
    except Exception:
        return -1


def _real_session_row_count() -> int:
    """开发者真实 HC 会话库里的记录数；库不存在就当 0。"""
    return _session_row_count(Path(os.path.expanduser("~/.agenticx")))


@pytest.fixture(scope="session", autouse=True)
def _guard_real_agenticx_home() -> Iterator[None]:
    """跑完测试后，开发者真实的 HC/Ontology 根都不应该被写入。

    为什么需要这道闸：模块级的 ``Path.home()`` 常量在 import 时就把路径定死了，而 HOME
    重定向是用例开始时才生效的，两者一错位，测试数据就写进真实目录。实测过一轮全量会
    新增 171 个条目——133 个 avatar、65 个 group，其中一个目录名直接叫
    ``<MagicMock name='mock.bound_avatar_id' id='...'>``，而且它们会出现在桌面端的
    数字专家 / 项目群列表里。

    已知的几处已经改成调用时解析（session_store、ConfigManager、avatar registry /
    group_chat、delivery store、workspace_memory、chat_attachments、bash_bg 日志、
    brain registry）。这道闸负责保证不再冒出新的。
    """
    before_rows = _real_session_row_count()
    before_ontology_rows = _session_row_count(Path.home() / ".agenticx-ontology")
    before_home = _real_agx_home_fingerprint()
    before_ontology_home = _real_ontology_home_fingerprint()
    yield
    after_rows = _real_session_row_count()
    after_ontology_rows = _session_row_count(Path.home() / ".agenticx-ontology")
    after_home = _real_agx_home_fingerprint()
    after_ontology_home = _real_ontology_home_fingerprint()

    problems: list[str] = []
    if before_rows >= 0 and after_rows > before_rows:
        problems.append(f"会话库多了 {after_rows - before_rows} 条记录（{before_rows} → {after_rows}）")
    if before_ontology_rows >= 0 and after_ontology_rows > before_ontology_rows:
        problems.append(
            "Ontology 会话库多了 "
            f"{after_ontology_rows - before_ontology_rows} 条记录（{before_ontology_rows} → {after_ontology_rows}）"
        )
    for name, after_n in sorted(after_home.items()):
        before_n = before_home.get(name, 0)
        if after_n > before_n:
            problems.append(f"~/.agenticx/{name}/ 多了 {after_n - before_n} 项（{before_n} → {after_n}）")
    for name in sorted(set(after_home) - set(before_home)):
        problems.append(f"新建了目录 ~/.agenticx/{name}/")
    for name, after_n in sorted(after_ontology_home.items()):
        before_n = before_ontology_home.get(name, 0)
        if after_n > before_n:
            problems.append(
                f"~/.agenticx-ontology/{name}/ 多了 {after_n - before_n} 项（{before_n} → {after_n}）"
            )
    for name in sorted(set(after_ontology_home) - set(before_ontology_home)):
        problems.append(f"新建了目录 ~/.agenticx-ontology/{name}/")

    if problems:
        pytest.fail(
            "测试写进了开发者真实的 HC/Ontology 用户根：\n  - "
            + "\n  - ".join(problems)
            + "\n多半是又有模块在 import 时定死了用户根，AGX_HOME 隔离拦不住它。"
            "改成调用时解析（参考 agenticx/utils/agx_home.py）。",
            pytrace=False,
        )


class ApprovingConfirmGate(ConfirmGate):
    """一个「用户点了同意」的确认闸，给直接调 dispatch 的用例用。

    ``send_bug_report_email`` / ``schedule_task`` / ``create_avatar`` /
    ``create_group_chat`` / ``set_taskspace`` / ``update_email_config`` 现在都要过
    确认闸。在此之前它们不过——于是用例里一句 ``dispatch_meta_tool_async(...)`` 就能
    把一个分身写进注册表，而那正是「运行模式没覆盖到这些工具」最直接的证据。

    用例要么用这个显式表示「用户批准了」，要么传一个拒绝的闸来断言副作用没发生。
    不传的话会落到 ``SyncConfirmGate`` 的 ``input()``——pytest 下没有 stdin，直接报错。
    这是有意的：**默认不能是放行**。
    """

    def __init__(self, approve: bool = True) -> None:
        self.approve = bool(approve)
        self.requests: list[tuple[str, dict]] = []

    async def request_confirm(self, question: str, context: dict | None = None) -> bool:
        self.requests.append((question, dict(context or {})))
        return self.approve


@pytest.fixture()
def approving_confirm_gate() -> ApprovingConfirmGate:
    return ApprovingConfirmGate()
