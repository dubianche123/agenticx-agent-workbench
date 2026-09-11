"""Focused lifecycle and backpressure tests for Studio Team SSE."""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

from agenticx.collaboration.workforce.events import (
    WorkforceAction,
    WorkforceEvent,
    WorkforceEventBus,
)
from agenticx.studio.server import create_studio_app


class _Request:
    def __init__(self, disconnected: bool = False) -> None:
        self.disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self.disconnected


def _team_event_endpoint(app: Any):
    return next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", "") == "/api/groups/{group_id}/events"
    )


def _setup_team_stream() -> tuple[Any, Any, Any, str, str, WorkforceEventBus]:
    app = create_studio_app()
    manager = app.state.session_manager
    groups = app.state.group_registry
    avatars = app.state.avatar_registry
    managed = manager.create()
    member = avatars.create_avatar(name="Team SSE 成员", role="Engineer")
    group = groups.create_group(
        name="Team SSE 安全测试群",
        avatar_ids=[member.id],
        routing="team",
    )
    manager.apply_avatar_binding(
        managed,
        avatar_id=f"group:{group.id}",
        avatar_name=group.name,
    )
    bus = WorkforceEventBus()
    bus_key = f"{group.id}::{managed.session_id}"
    app.state.group_team_event_buses[bus_key] = bus
    return (
        app,
        _team_event_endpoint(app),
        group,
        managed.session_id,
        bus_key,
        bus,
    )


@pytest.mark.asyncio
async def test_team_events_bound_queue_emits_replay_gap_and_unsubscribes() -> None:
    app, endpoint, group, session_id, bus_key, bus = _setup_team_stream()
    for seq in range(257):
        bus.publish(
            WorkforceEvent(
                action=WorkforceAction.TASK_STARTED,
                data={"seq": seq},
            )
        )

    response = await endpoint(
        group_id=group.id,
        request=_Request(),
        session_id=session_id,
        x_agx_desktop_token=None,
    )
    stream = response.body_iterator
    frame = await anext(stream)
    assert json.loads(frame[6:]) == {
        "type": "replay_gap",
        "data": {"reason": "team_event_subscriber_queue_full"},
    }
    await stream.aclose()

    assert bus.get_subscriber_count()["sync"] == 0
    assert app.state.group_team_event_subscribers.get(bus_key, 0) == 0


@pytest.mark.asyncio
async def test_team_events_limit_subscribers_and_return_slot_on_close() -> None:
    app, endpoint, group, session_id, bus_key, bus = _setup_team_stream()
    bus.publish(
        WorkforceEvent(
            action=WorkforceAction.WORKFORCE_STARTED,
            data={"mode": "execution"},
        )
    )

    streams = []
    for _ in range(8):
        response = await endpoint(
            group_id=group.id,
            request=_Request(),
            session_id=session_id,
            x_agx_desktop_token=None,
        )
        stream = response.body_iterator
        assert "workforce_started" in (await anext(stream))
        streams.append(stream)

    with pytest.raises(HTTPException) as exc_info:
        await endpoint(
            group_id=group.id,
            request=_Request(),
            session_id=session_id,
            x_agx_desktop_token=None,
        )
    assert exc_info.value.status_code == 429
    assert app.state.group_team_event_subscribers[bus_key] == 8
    assert bus.get_subscriber_count()["sync"] == 8

    for stream in streams:
        await stream.aclose()
    assert app.state.group_team_event_subscribers.get(bus_key, 0) == 0
    assert bus.get_subscriber_count()["sync"] == 0


@pytest.mark.asyncio
async def test_team_events_bounds_history_and_detects_disconnect() -> None:
    app, endpoint, group, session_id, bus_key, bus = _setup_team_stream()
    limits: list[int | None] = []
    original_get_history = bus.get_event_history

    def _get_history(*, limit=None, **filters):
        limits.append(limit)
        return original_get_history(limit=limit, **filters)

    bus.get_event_history = _get_history  # type: ignore[method-assign]
    response = await endpoint(
        group_id=group.id,
        request=_Request(disconnected=True),
        session_id=session_id,
        x_agx_desktop_token=None,
    )
    stream = response.body_iterator
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    await stream.aclose()

    assert limits == [400]
    assert bus.get_subscriber_count()["sync"] == 0
    assert app.state.group_team_event_subscribers.get(bus_key, 0) == 0


def test_studio_lifespan_cancels_instance_background_tasks(monkeypatch) -> None:
    started = threading.Event()
    cancelled = threading.Event()

    async def _pending_graph_bootstrap() -> None:
        started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(
        "agenticx.runtime.mcp_crash_guard.install_mcp_crash_guard",
        lambda loop=None: None,
    )
    gmcp = SimpleNamespace(
        schedule_restore=lambda: None,
        close_all=lambda: asyncio.sleep(0),
    )
    monkeypatch.setattr(
        "agenticx.runtime.global_mcp_manager.GlobalMcpManager.load_or_init",
        lambda: gmcp,
    )
    monkeypatch.setattr(
        "agenticx.runtime.global_mcp_manager.GlobalMcpManager.singleton",
        lambda: gmcp,
    )
    monkeypatch.setattr(
        "agenticx.studio.supervisor.maybe_start_supervisor",
        lambda *_args, **_kwargs: asyncio.sleep(0),
    )
    monkeypatch.setattr(
        "agenticx.memory.graph.config.load_memory_graph_config",
        lambda: SimpleNamespace(enabled=True),
    )
    monkeypatch.setattr(
        "agenticx.memory.graph.deps.ensure_graphiti_if_enabled",
        lambda: _pending_graph_bootstrap(),
    )
    monkeypatch.setattr(
        "agenticx.memory.graph.writer.MemoryGraphWriter._ensure_worker",
        lambda self: None,
    )

    app = create_studio_app()
    with TestClient(app):
        assert started.wait(timeout=2.0)
        assert app.state.background_tasks

    assert cancelled.is_set()
    assert app.state.background_tasks == set()


def test_studio_background_task_exception_is_consumed_and_logged(
    monkeypatch,
    caplog,
) -> None:
    failed = threading.Event()

    async def _failed_graph_bootstrap() -> None:
        failed.set()
        raise RuntimeError("graph bootstrap failed in test")

    monkeypatch.setattr(
        "agenticx.runtime.mcp_crash_guard.install_mcp_crash_guard",
        lambda loop=None: None,
    )
    gmcp = SimpleNamespace(
        schedule_restore=lambda: None,
        close_all=lambda: asyncio.sleep(0),
    )
    monkeypatch.setattr(
        "agenticx.runtime.global_mcp_manager.GlobalMcpManager.load_or_init",
        lambda: gmcp,
    )
    monkeypatch.setattr(
        "agenticx.runtime.global_mcp_manager.GlobalMcpManager.singleton",
        lambda: gmcp,
    )
    monkeypatch.setattr(
        "agenticx.studio.supervisor.maybe_start_supervisor",
        lambda *_args, **_kwargs: asyncio.sleep(0),
    )
    monkeypatch.setattr(
        "agenticx.memory.graph.config.load_memory_graph_config",
        lambda: SimpleNamespace(enabled=True),
    )
    monkeypatch.setattr(
        "agenticx.memory.graph.deps.ensure_graphiti_if_enabled",
        lambda: _failed_graph_bootstrap(),
    )
    monkeypatch.setattr(
        "agenticx.memory.graph.writer.MemoryGraphWriter._ensure_worker",
        lambda self: None,
    )

    app = create_studio_app()
    with caplog.at_level(logging.WARNING, logger="agenticx.studio.server"):
        with TestClient(app):
            assert failed.wait(timeout=2.0)

    assert any(
        "Studio background task memory-graph-graphiti-bootstrap failed" in record.message
        and "graph bootstrap failed in test" in record.message
        for record in caplog.records
    )
    assert app.state.background_tasks == set()
