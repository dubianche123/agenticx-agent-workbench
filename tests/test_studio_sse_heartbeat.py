"""Focused async regression tests for quiet Studio SSE streams."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agenticx.runtime.events import RuntimeEvent
from agenticx.runtime.group_router import GroupReply
from agenticx.studio.protocols import ChatRequest
from agenticx.studio.server import create_studio_app


class _Request:
    def __init__(self) -> None:
        self.disconnected = False

    async def is_disconnected(self) -> bool:
        return self.disconnected


def _endpoint(app: Any, path: str):
    return next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", "") == path
    )


@pytest.mark.asyncio
async def test_reattach_quiet_stream_heartbeat_does_not_advance_sequence(monkeypatch) -> None:
    from agenticx.studio import server as server_module

    monkeypatch.setattr(server_module, "live_reattach_enabled", lambda: True)
    monkeypatch.setattr(server_module, "_SSE_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    app = create_studio_app()
    manager = app.state.session_manager
    managed = manager.create()
    manager.set_execution_state(managed.session_id, "running")
    hub = manager.ensure_event_hub(managed.session_id)
    request = _Request()
    response = await _endpoint(app, "/api/sessions/{session_id}/stream")(
        session_id=managed.session_id,
        request=request,
        since=None,
        last_event_id=None,
        x_agx_desktop_token=None,
    )

    stream = response.body_iterator
    assert response.headers["cache-control"] == "no-cache, no-transform"
    assert await asyncio.wait_for(anext(stream), timeout=1.0) == ": heartbeat\n\n"
    assert hub.current_seq == 0
    assert hub.is_active

    await hub.publish(RuntimeEvent(type="final", data={"text": "terminal"}))
    await hub.publish_done()
    chunks = [chunk async for chunk in stream]
    body = "".join(chunks)
    assert '"type": "final"' in body
    assert '"type":"done"' in body
    await stream.aclose()


@pytest.mark.asyncio
async def test_reattach_closed_hub_emits_terminal_done_and_stops_heartbeats(monkeypatch) -> None:
    from agenticx.studio import server as server_module

    monkeypatch.setattr(server_module, "live_reattach_enabled", lambda: True)
    monkeypatch.setattr(server_module, "_SSE_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    app = create_studio_app()
    manager = app.state.session_manager
    managed = manager.create()
    manager.set_execution_state(managed.session_id, "running")
    hub = manager.ensure_event_hub(managed.session_id)
    request = _Request()
    response = await _endpoint(app, "/api/sessions/{session_id}/stream")(
        session_id=managed.session_id,
        request=request,
        since=None,
        last_event_id=None,
        x_agx_desktop_token=None,
    )

    stream = response.body_iterator
    assert await asyncio.wait_for(anext(stream), timeout=1.0) == ": heartbeat\n\n"
    assert hub.current_seq == 0

    # Clearing a session closes the captured hub without publishing a
    # sequence-bearing done sentinel.  The reattach stream must still finish
    # with a recognizable terminal frame rather than heartbeat forever.
    manager.clear_event_hub(managed.session_id)
    terminal = await asyncio.wait_for(anext(stream), timeout=1.0)
    assert terminal == 'data: {"type":"done","data":{"reason":"closed"}}\n\n'
    assert hub.current_seq == 0

    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), timeout=1.0)
    await stream.aclose()


@pytest.mark.asyncio
async def test_reattach_closed_hub_drops_queued_event_before_terminal_done(monkeypatch) -> None:
    from agenticx.studio import server as server_module

    monkeypatch.setattr(server_module, "live_reattach_enabled", lambda: True)
    monkeypatch.setattr(server_module, "_SSE_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    app = create_studio_app()
    manager = app.state.session_manager
    managed = manager.create()
    manager.set_execution_state(managed.session_id, "running")
    hub = manager.ensure_event_hub(managed.session_id)
    request = _Request()
    response = await _endpoint(app, "/api/sessions/{session_id}/stream")(
        session_id=managed.session_id,
        request=request,
        since=None,
        last_event_id=None,
        x_agx_desktop_token=None,
    )

    stream = response.body_iterator
    assert await asyncio.wait_for(anext(stream), timeout=1.0) == ": heartbeat\n\n"

    # Leave one runtime event in the subscriber queue, then close the hub. The
    # queued event belongs to the pre-close runtime and must not leak through
    # the reattach stream after the terminal transition.
    await hub.publish(RuntimeEvent(type="token", data={"text": "stale-token"}))
    assert hub.current_seq == 1
    manager.clear_event_hub(managed.session_id)

    terminal = await asyncio.wait_for(anext(stream), timeout=1.0)
    assert terminal == 'data: {"type":"done","data":{"reason":"closed"}}\n\n'
    assert "stale-token" not in terminal
    assert hub.current_seq == 1

    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), timeout=1.0)
    await stream.aclose()


@pytest.mark.asyncio
async def test_reattach_buffered_event_is_one_atomic_frame_before_closed_done(monkeypatch) -> None:
    from agenticx.studio import server as server_module

    monkeypatch.setattr(server_module, "live_reattach_enabled", lambda: True)
    monkeypatch.setattr(server_module, "_SSE_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    app = create_studio_app()
    manager = app.state.session_manager
    managed = manager.create()
    manager.set_execution_state(managed.session_id, "running")
    hub = manager.ensure_event_hub(managed.session_id)
    request = _Request()
    response = await _endpoint(app, "/api/sessions/{session_id}/stream")(
        session_id=managed.session_id,
        request=request,
        since=None,
        last_event_id=None,
        x_agx_desktop_token=None,
    )

    stream = response.body_iterator
    assert await asyncio.wait_for(anext(stream), timeout=1.0) == ": heartbeat\n\n"

    await hub.publish(RuntimeEvent(type="token", data={"text": "queued-token"}))
    assert hub.current_seq == 1

    # An SSE event contains an id line and one or more data lines.  The
    # reattach route must hand the complete event to the ASGI iterator in one
    # chunk, otherwise a close between those yields can expose a stale half
    # frame to the desktop client.
    frame = await asyncio.wait_for(anext(stream), timeout=1.0)
    assert frame.startswith("id: 1\n")
    assert frame.endswith("\n\n")
    assert '"type": "token"' in frame
    assert "queued-token" in frame

    manager.clear_event_hub(managed.session_id)
    terminal = await asyncio.wait_for(anext(stream), timeout=1.0)
    assert terminal == 'data: {"type":"done","data":{"reason":"closed"}}\n\n'
    assert hub.current_seq == 1

    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), timeout=1.0)
    await stream.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("use_hub", [True, False])
async def test_group_chat_quiet_stream_heartbeat_keeps_runtime_running_until_terminal(
    monkeypatch,
    use_hub: bool,
) -> None:
    from agenticx.studio import server as server_module

    monkeypatch.setattr(server_module, "live_reattach_enabled", lambda: use_hub)
    monkeypatch.setattr(server_module, "_SSE_HEARTBEAT_INTERVAL_SECONDS", 0.01)
    # The async route test consumes the body directly; bypass the request-context
    # adapter so this test stays focused on the stream lifecycle.
    monkeypatch.setattr(
        server_module,
        "_stream_with_llm_turn_context",
        lambda stream, _turn_id: stream,
    )

    started = asyncio.Event()
    release = asyncio.Event()

    class _PausedGroupRouter:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        async def run_group_turn(self, **_kwargs: Any):
            started.set()
            await release.wait()
            yield GroupReply(
                agent_id="member-1",
                avatar_name="成员甲",
                avatar_url="",
                content="terminal reply",
            )

    monkeypatch.setattr(server_module, "GroupChatRouter", _PausedGroupRouter)

    app = create_studio_app()
    manager = app.state.session_manager
    managed = manager.create()
    member = app.state.avatar_registry.create_avatar(name="成员甲", role="Engineer")
    group = app.state.group_registry.create_group(
        name="心跳测试群",
        avatar_ids=[member.id],
        routing="intelligent",
    )
    request = _Request()
    response = await _endpoint(app, "/api/chat")(
        ChatRequest(
            session_id=managed.session_id,
            group_id=group.id,
            user_input="静默期间保持连接",
        ),
        request,
        None,
    )

    stream = response.body_iterator
    assert await asyncio.wait_for(anext(stream), timeout=1.0) == ": heartbeat\n\n"
    await asyncio.wait_for(started.wait(), timeout=1.0)
    hub = manager.get_event_hub(managed.session_id)
    if use_hub:
        assert hub is not None
        assert hub.current_seq == 0
        assert hub.is_active
    else:
        assert hub is None
    assert managed.execution_state == "running"

    release.set()
    chunks = [chunk async for chunk in stream]
    body = "".join(chunks)
    assert '"type": "group_reply"' in body
    assert '"type":"done"' in body
    assert managed.execution_state == "idle"
    await stream.aclose()
