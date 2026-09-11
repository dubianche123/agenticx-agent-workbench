from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from agenticx.runtime.feedback_worker import FeedbackDistillationWorker
from agenticx.cli.config_manager import AgxConfig
from agenticx.studio import server as server_module
from agenticx.studio.feedback_learning import (
    CanonicalFeedbackMessage,
    FeedbackCaseStore,
    FeedbackIdentity,
)
from agenticx.studio.feedback_experiences import FeedbackExperienceStore


ROUTE = {
    "provider": "qa",
    "model": "qa-model",
    "provider_config_fingerprint": "cfg-a",
    "provider_authenticated": True,
    "locked": False,
    "attachment_routing_lock": None,
}


def _identity(user: str = "user-a") -> FeedbackIdentity:
    return FeedbackIdentity(
        scope_id='["desktop","tenant-a", "%s"]' % user,
        user_id=user,
        tenant_id="tenant-a",
    )


def _build_fixture(tmp_path: Path, *, count: int = 5):
    identity = _identity()
    case_store = FeedbackCaseStore(tmp_path / "cases")
    experience_store = FeedbackExperienceStore(tmp_path / "experiences")
    sessions = {}
    for index in range(count):
        sid = f"session-{index}"
        sessions[sid] = SimpleNamespace(
            studio_session=SimpleNamespace(provider_name="qa", model_name="qa-model"),
            avatar_id=None,
        )
        case_store.record_vote(
            identity=identity,
            message=CanonicalFeedbackMessage(
                session_id=sid,
                message_id=f"message-{index}",
                question="请按地区整理季度销售报告",
                answer="按地区列出季度销售额并比较变化。",
                subject_id="meta",
                routing_key="route-a",
            ),
            value="like",
            now=1000.0 + index,
        )

    async def resolve_identity():
        return identity

    def resolve_session(session_id: str):
        return sessions.get(session_id)

    def resolve_subject(_managed):
        return "meta"

    def resolve_route(_session):
        return dict(ROUTE)

    def resolve_route_key(_session):
        return "route-a"

    return identity, case_store, experience_store, sessions, {
        "resolve_identity": resolve_identity,
        "resolve_session": resolve_session,
        "resolve_subject": resolve_subject,
        "resolve_route": resolve_route,
        "resolve_route_key": resolve_route_key,
    }


class _AsyncFakeLLM:
    def __init__(self) -> None:
        self.calls: list[tuple[list[dict], dict]] = []

    async def ainvoke(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        payload = json.loads(messages[-1]["content"])
        source_id = payload["evidence"][0]["feedback_id"]
        return SimpleNamespace(
            content=json.dumps(
                {
                    "experiences": [
                        {
                            "applicability": "季度销售报告",
                            "guidance": "保留地区维度并使用表格比较变化。",
                            "keywords": ["地区", "季度"],
                            "confidence": 0.8,
                            "source_feedback_ids": [source_id],
                        }
                    ]
                },
                ensure_ascii=False,
            )
        )


def _worker(fixture, *, llm_factory, **kwargs):
    _identity_value, case_store, experience_store, _sessions, callbacks = fixture
    return FeedbackDistillationWorker(
        case_store=case_store,
        experience_store=experience_store,
        llm_factory=llm_factory,
        is_idle=kwargs.pop("is_idle", lambda: True),
        now=kwargs.pop("now", lambda: 1000.0),
        timeout_seconds=kwargs.pop("timeout_seconds", 1.0),
        **callbacks,
        **kwargs,
    )


def test_worker_run_once_uses_verified_route_and_marks_only_request_ids(tmp_path: Path) -> None:
    fixture = _build_fixture(tmp_path)
    fake = _AsyncFakeLLM()
    worker = _worker(fixture, llm_factory=lambda binding: fake)

    assert asyncio.run(worker.run_once(now=1000.0)) is True
    assert len(fake.calls) == 1
    messages, kwargs = fake.calls[0]
    assert len(messages) == 2
    assert "tools" not in kwargs
    assert kwargs["max_tokens"] == 2048
    assert kwargs["temperature"] == 0.0
    assert kwargs["timeout"] == 1.0
    assert len(fixture[1].pending_cases) == 0
    assert len(fixture[2].experiences) == 1


def test_worker_forever_checks_overdue_work_on_startup(tmp_path: Path) -> None:
    fixture = _build_fixture(tmp_path)
    fake = _AsyncFakeLLM()
    worker = _worker(fixture, llm_factory=lambda binding: fake, poll_seconds=0.01)

    async def run():
        task = asyncio.create_task(worker.run_forever())
        for _ in range(100):
            if fake.calls:
                break
            await asyncio.sleep(0.01)
        assert len(fake.calls) == 1
        await worker.stop()
        await asyncio.wait_for(task, timeout=1.0)

    asyncio.run(run())
    assert len(fixture[2].experiences) == 1


def test_worker_waits_for_foreground_idle_before_claiming(tmp_path: Path) -> None:
    fixture = _build_fixture(tmp_path)
    fake = _AsyncFakeLLM()
    state = {"idle": False}
    worker = _worker(fixture, llm_factory=lambda binding: fake, is_idle=lambda: state["idle"])

    assert asyncio.run(worker.run_once(now=1000.0)) is False
    assert not fake.calls
    assert len(fixture[1].pending_cases) == 5

    state["idle"] = True
    assert asyncio.run(worker.run_once(now=1000.0)) is True
    assert len(fake.calls) == 1


def test_worker_rejects_route_change_before_model_request(tmp_path: Path) -> None:
    fixture = _build_fixture(tmp_path)
    fake = _AsyncFakeLLM()
    route_state = {"key": "route-a"}
    callbacks = fixture[4]
    callbacks["resolve_route_key"] = lambda _session: route_state["key"]

    def factory(_binding):
        route_state["key"] = "route-b"
        return fake

    worker = _worker(fixture, llm_factory=factory)
    assert asyncio.run(worker.run_once(now=1000.0)) is True
    assert not fake.calls
    assert not fixture[2].experiences
    assert len(fixture[1].pending_cases) == 5


def test_worker_rejects_account_switch_after_model_response(tmp_path: Path) -> None:
    fixture = _build_fixture(tmp_path)
    fake = _AsyncFakeLLM()
    account = {"identity": fixture[0]}
    callbacks = fixture[4]

    async def resolve_identity():
        return account["identity"]

    callbacks["resolve_identity"] = resolve_identity

    async def switch_after_response(messages, **kwargs):
        fake.calls.append((messages, kwargs))
        payload = json.loads(messages[-1]["content"])
        account["identity"] = _identity("user-b")
        return SimpleNamespace(
            content=json.dumps(
                {
                    "experiences": [
                        {
                            "applicability": "季度销售报告",
                            "guidance": "保留地区维度。",
                            "keywords": ["地区"],
                            "confidence": 0.8,
                            "source_feedback_ids": [payload["evidence"][0]["feedback_id"]],
                        }
                    ]
                }
            )
        )

    fake.ainvoke = switch_after_response
    worker = _worker(fixture, llm_factory=lambda binding: fake)
    assert asyncio.run(worker.run_once(now=1000.0)) is True
    assert not fixture[2].experiences
    assert len(fixture[1].pending_cases) == 5


def test_worker_timeout_keeps_noncooperative_sync_call_single_inflight(tmp_path: Path) -> None:
    fixture = _build_fixture(tmp_path)
    started = threading.Event()
    release = threading.Event()

    class BlockingSyncLLM:
        def __init__(self):
            self.calls = 0

        def invoke(self, messages, **kwargs):
            self.calls += 1
            started.set()
            release.wait(timeout=2.0)
            return {"experiences": []}

    fake = BlockingSyncLLM()
    worker = _worker(fixture, llm_factory=lambda binding: fake, timeout_seconds=0.05)

    async def run():
        result = await worker.run_once(now=1000.0)
        assert result is True
        assert started.is_set()
        assert worker.inflight is True
        assert await worker.run_once(now=2000.0) is False
        assert fake.calls == 1
        release.set()
        await asyncio.sleep(0.05)
        assert worker.inflight is False

    asyncio.run(run())


def test_worker_stop_drains_active_async_provider(tmp_path: Path) -> None:
    fixture = _build_fixture(tmp_path)

    class ActiveAsyncLLM:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.cancel_count = 0

        async def ainvoke(self, messages, **kwargs):
            self.started.set()
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancel_count += 1
                raise

    fake = ActiveAsyncLLM()
    worker = _worker(
        fixture,
        llm_factory=lambda binding: fake,
        poll_seconds=0.01,
        timeout_seconds=10.0,
    )

    async def run() -> None:
        task = asyncio.create_task(worker.run_forever())
        await asyncio.wait_for(fake.started.wait(), timeout=1.0)
        await worker.stop()
        await asyncio.wait_for(task, timeout=1.0)
        assert fake.cancel_count == 1
        assert worker.inflight is False

    asyncio.run(run())


def test_worker_run_forever_drain_retries_cancel_for_stubborn_async_provider(
    tmp_path: Path,
) -> None:
    fixture = _build_fixture(tmp_path)

    class SwallowFirstCancelLLM:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.cancel_count = 0

        async def ainvoke(self, messages, **kwargs):
            self.started.set()
            while True:
                try:
                    await self.release.wait()
                except asyncio.CancelledError:
                    self.cancel_count += 1
                    if self.cancel_count >= 2:
                        raise

    fake = SwallowFirstCancelLLM()
    worker = _worker(
        fixture,
        llm_factory=lambda binding: fake,
        poll_seconds=0.01,
        timeout_seconds=10.0,
    )

    async def run() -> None:
        task = asyncio.create_task(worker.run_forever())
        await asyncio.wait_for(fake.started.wait(), timeout=1.0)
        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=1.0)
        except asyncio.CancelledError:
            pass
        assert fake.cancel_count >= 2
        assert worker.inflight is False

    asyncio.run(run())


def test_server_route_binding_rejects_disabled_provider_and_tracks_endpoint(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AGX_FEEDBACK_LEARNING_ROOT", str(tmp_path / "feedback"))
    config = AgxConfig(
        providers={
            "qa": {
                "enabled": True,
                "model": "qa-model",
                "api_key": "local-test-key",
                "base_url": "http://127.0.0.1:9001/v1",
            }
        }
    )
    monkeypatch.setattr(
        server_module.ConfigManager,
        "load",
        classmethod(lambda cls: config),
    )
    app = server_module.create_studio_app()
    session = SimpleNamespace(provider_name="qa", model_name="qa-model")

    first = app.state.feedback_source_binding(session)
    assert first is not None
    first_key = app.state.feedback_route_key_resolver(session)
    config.providers["qa"]["base_url"] = "http://127.0.0.1:9002/v1"
    second_key = app.state.feedback_route_key_resolver(session)
    assert first_key and second_key and first_key != second_key

    config.providers["qa"]["enabled"] = False
    assert app.state.feedback_source_binding(session) is None


def _build_route_binding_app(monkeypatch, tmp_path: Path, providers: dict) -> object:
    monkeypatch.setenv("AGX_FEEDBACK_LEARNING_ROOT", str(tmp_path / "feedback"))
    config = AgxConfig(providers=providers)
    monkeypatch.setattr(
        server_module.ConfigManager,
        "load",
        classmethod(lambda cls: config),
    )
    return server_module.create_studio_app()


def _private_attachment_lock() -> dict[str, str]:
    return {
        "provider": "private",
        "model": "private-model",
        "id": "private-model-id",
        "label": "Private",
    }


def test_server_route_binding_accepts_matching_direct_private_lock(monkeypatch, tmp_path: Path) -> None:
    app = _build_route_binding_app(
        monkeypatch,
        tmp_path,
        {
            "private": {
                "enabled": True,
                "model": "private-model",
                "api_key": "private-test-key",
                "base_url": "http://127.0.0.1:9001/v1",
            }
        },
    )
    session = SimpleNamespace(
        provider_name="private",
        model_name="private-model",
        _attachment_routing_lock=_private_attachment_lock(),
    )

    binding = app.state.feedback_source_binding(session)

    assert binding is not None
    assert (binding["provider"], binding["model"]) == ("private", "private-model")


def test_server_route_binding_rejects_mismatched_direct_private_lock(monkeypatch, tmp_path: Path) -> None:
    app = _build_route_binding_app(
        monkeypatch,
        tmp_path,
        {
            "private": {
                "enabled": True,
                "model": "private-model",
                "api_key": "private-test-key",
                "base_url": "http://127.0.0.1:9001/v1",
            },
            "public": {
                "enabled": True,
                "model": "public-model",
                "api_key": "public-test-key",
                "base_url": "http://127.0.0.1:9002/v1",
            },
        },
    )
    session = SimpleNamespace(
        provider_name="public",
        model_name="public-model",
        _attachment_routing_lock=_private_attachment_lock(),
    )

    binding = app.state.feedback_source_binding(session)

    assert binding is None
    assert (session.provider_name, session.model_name) == ("public", "public-model")


def test_server_route_binding_accepts_matching_enterprise_lock_id(monkeypatch, tmp_path: Path) -> None:
    app = _build_route_binding_app(
        monkeypatch,
        tmp_path,
        {
            "enterprise": {
                "enabled": True,
                "model": "private-model-id",
                "api_key": "enterprise-test-key",
                "base_url": "http://127.0.0.1:9003/v1",
            }
        },
    )
    session = SimpleNamespace(
        provider_name="enterprise",
        model_name="private-model-id",
        _attachment_routing_lock=_private_attachment_lock(),
    )

    binding = app.state.feedback_source_binding(session)

    assert binding is not None
    assert (binding["provider"], binding["model"]) == ("enterprise", "private-model-id")


def test_server_route_binding_rejects_mismatched_enterprise_lock_id(monkeypatch, tmp_path: Path) -> None:
    app = _build_route_binding_app(
        monkeypatch,
        tmp_path,
        {
            "enterprise": {
                "enabled": True,
                "model": "wrong-model-id",
                "api_key": "enterprise-test-key",
                "base_url": "http://127.0.0.1:9003/v1",
            }
        },
    )
    session = SimpleNamespace(
        provider_name="enterprise",
        model_name="wrong-model-id",
        _attachment_routing_lock=_private_attachment_lock(),
    )

    binding = app.state.feedback_source_binding(session)

    assert binding is None
    assert (session.provider_name, session.model_name) == ("enterprise", "wrong-model-id")


def test_studio_lifespan_owns_and_stops_feedback_worker(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AGX_FEEDBACK_LEARNING_ROOT", str(tmp_path / "feedback"))
    monkeypatch.setenv("AGX_FEEDBACK_LEARNING_POLL_SECONDS", "0.1")
    monkeypatch.setenv("AGX_LONGRUN_ENABLED", "0")
    # No renderer identity is configured in this test, so startup can only
    # perform a fail-closed identity check and never call a real model.
    monkeypatch.delenv("AGX_DOCUMENT_RENDERER_URL", raising=False)
    monkeypatch.delenv("AGX_DOCUMENT_RENDERER_TOKEN", raising=False)
    app = server_module.create_studio_app()

    with TestClient(app):
        worker = getattr(app.state, "feedback_distillation_worker", None)
        task = getattr(app.state, "feedback_distillation_task", None)
        assert isinstance(worker, FeedbackDistillationWorker)
        assert task is not None and not task.done()

    assert task.done()
