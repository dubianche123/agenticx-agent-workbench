from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from agenticx.studio.feedback_learning import (
    CanonicalFeedbackMessage,
    FeedbackCaseStore,
    FeedbackIdentity,
    lexical_similarity,
    register_feedback_learning_routes,
)


def _identity(*, scope: str = '["desktop","tenant-a","user-a"]', user: str = "user-a", tenant: str = "tenant-a") -> FeedbackIdentity:
    return FeedbackIdentity(scope_id=scope, user_id=user, tenant_id=tenant)


def _message(
    session_id: str,
    message_id: str,
    *,
    subject_id: str | None = "meta",
    question: str = "请帮我说明电池健康管理方案和充电策略",
    answer: str = "可以从充电上限、温度控制和周期校准三个方面制定方案。",
) -> CanonicalFeedbackMessage:
    return CanonicalFeedbackMessage(
        session_id=session_id,
        message_id=message_id,
        question=question,
        answer=answer,
        subject_id=subject_id,
    )


def test_raw_cross_session_recall_is_removed_and_similarity_remains_available(tmp_path: Path) -> None:
    assert lexical_similarity("请继续说明电池健康管理方案和充电策略", "电池健康管理方案和充电策略") >= 0.2
    assert lexical_similarity("请继续说明电池健康管理方案和充电策略", "设计前端按钮的颜色和间距") < 0.2

    store = FeedbackCaseStore(tmp_path, max_cases=32)
    identity = _identity()
    for index in range(4):
        store.record_vote(
            identity=identity,
            message=_message(f"session-{index}", f"message-{index}"),
            value="like",
        )

    recalled = store.recall(
        identity=identity,
        query="请继续说明电池健康管理方案和充电策略",
        subject_id="meta",
        limit=20,
    )
    assert recalled == ()
    assert store.recall_context(
        identity=identity,
        query="请继续说明电池健康管理方案和充电策略",
        subject_id="meta",
    ).count == 0

    # A new process/store instance still sees the cross-session projection.
    assert FeedbackCaseStore(tmp_path).recall(
        identity=identity,
        query="电池健康管理方案和充电策略",
        subject_id="meta",
    ) == ()


def test_identity_subject_and_unknown_scope_are_isolated(tmp_path: Path) -> None:
    store = FeedbackCaseStore(tmp_path)
    identity = _identity()
    store.record_vote(
        identity=identity,
        message=_message("session-a", "message-a", subject_id="avatar-research"),
        value="like",
    )

    query = "说明电池健康管理方案和充电策略"
    assert store.session_cases(
        identity=identity,
        session_id="session-a",
        subject_id="avatar-research",
    )
    assert store.session_cases(
        identity=identity,
        session_id="session-a",
        subject_id="avatar-writing",
    ) == ()
    assert store.session_cases(
        identity=_identity(user="user-b"),
        session_id="session-a",
        subject_id="avatar-research",
    ) == ()
    assert store.session_cases(
        identity=_identity(tenant="tenant-b", scope='["desktop","tenant-b","user-a"]'),
        session_id="session-a",
        subject_id="avatar-research",
    ) == ()
    assert store.session_cases(identity=None, session_id="session-a", subject_id="avatar-research") == ()


def test_vote_reversal_and_cancel_remove_the_learned_case_without_preference_files(tmp_path: Path) -> None:
    store = FeedbackCaseStore(tmp_path)
    identity = _identity()
    message = _message("session-a", "message-a")
    store.record_vote(identity=identity, message=message, value="like")
    store.record_vote(identity=identity, message=message, value="dislike")
    assert store.session_cases(identity=identity, session_id=message.session_id, subject_id="meta")[0].value == "dislike"

    assert store.remove_vote(identity=identity, session_id=message.session_id, message_id=message.message_id)
    assert not store.remove_vote(identity=identity, session_id=message.session_id, message_id=message.message_id)
    assert store.session_cases(identity=identity, session_id=message.session_id, subject_id="meta") == ()
    assert not (tmp_path / "MEMORY.md").exists()
    assert not (tmp_path / "USER.md").exists()


def test_route_uses_authenticated_identity_and_canonical_local_message(tmp_path: Path) -> None:
    app = FastAPI()
    identity = _identity()
    canonical = _message("session-a", "message-a", question="服务端保存的问题")

    def check_token(token: str | None) -> None:
        if token != "secret":
            raise HTTPException(status_code=401, detail="invalid token")

    def resolve_identity(_request) -> FeedbackIdentity:
        return identity

    def resolve_message(session_id: str, message_id: str) -> CanonicalFeedbackMessage | None:
        if (session_id, message_id) == (canonical.session_id, canonical.message_id):
            return canonical
        return None

    store = register_feedback_learning_routes(
        app,
        check_token=check_token,
        resolve_identity=resolve_identity,
        resolve_local_message=resolve_message,
        store=FeedbackCaseStore(tmp_path),
    )
    client = TestClient(app)

    unauthorized = client.post(
        "/api/session/feedback-learning",
        json={"session_id": "session-a", "message_id": "message-a", "value": "like"},
    )
    assert unauthorized.status_code == 401

    learned = client.post(
        "/api/session/feedback-learning",
        headers={"x-agx-desktop-token": "secret"},
        # These client supplied text fields must be ignored by the route.
        json={
            "session_id": "session-a",
            "message_id": "message-a",
            "value": "like",
            "expected_scope_id": identity.scope_id,
            "question": "客户端伪造的问题",
            "answer": "客户端伪造的答案",
        },
    )
    assert learned.status_code == 200
    assert learned.json()["value"] == "like"
    assert store.cases[0].question == "服务端保存的问题"

    cancelled = client.post(
        "/api/session/feedback-learning",
        headers={"x-agx-desktop-token": "secret"},
        json={
            "session_id": "session-a",
            "message_id": "message-a",
            "value": None,
            "expected_scope_id": identity.scope_id,
        },
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["removed"] is True
    assert store.cases == ()

    legacy = client.post(
        "/api/session/feedback-learning",
        headers={"x-agx-desktop-token": "secret"},
        json={
            "session_id": "session-a",
            "message_id": "legacy",
            "value": "like",
            "expected_scope_id": identity.scope_id,
        },
    )
    assert legacy.status_code == 409


def test_route_fails_closed_for_unknown_identity(tmp_path: Path) -> None:
    app = FastAPI()
    register_feedback_learning_routes(
        app,
        check_token=lambda _token: None,
        resolve_identity=lambda _request: None,
        resolve_local_message=lambda _session_id, _message_id: _message("session-a", "message-a"),
        store=FeedbackCaseStore(tmp_path),
    )
    response = TestClient(app).post(
        "/api/session/feedback-learning",
        headers={"x-agx-desktop-token": "secret"},
        json={
            "session_id": "session-a",
            "message_id": "message-a",
            "value": "like",
            "expected_scope_id": _identity().scope_id,
        },
    )
    assert response.status_code == 403
    assert not (tmp_path / "cases.jsonl").exists()


def test_route_rejects_delayed_old_scope_before_recording_under_account_switch(tmp_path: Path) -> None:
    app = FastAPI()
    account = {"identity": _identity()}
    identity_a = account["identity"]
    identity_b = _identity(
        scope='["desktop","tenant-b","user-b"]',
        user="user-b",
        tenant="tenant-b",
    )
    canonical_a = _message("session-a", "message-a")
    canonical_b = _message("session-b", "message-b")

    def resolve_identity(_request) -> FeedbackIdentity:
        return account["identity"]

    def resolve_message(session_id: str, message_id: str) -> CanonicalFeedbackMessage | None:
        if (session_id, message_id) == (canonical_a.session_id, canonical_a.message_id):
            return canonical_a
        if (session_id, message_id) == (canonical_b.session_id, canonical_b.message_id):
            return canonical_b
        return None

    store = register_feedback_learning_routes(
        app,
        check_token=lambda _token: True,
        resolve_identity=resolve_identity,
        resolve_local_message=resolve_message,
        store=FeedbackCaseStore(tmp_path),
    )
    client = TestClient(app)

    # Capture A's scope, then switch the trusted resolver to B before the
    # delayed mirror arrives.  The request must be rejected without creating a
    # case in B.
    account["identity"] = identity_b
    stale = client.post(
        "/api/session/feedback-learning",
        json={
            "session_id": "session-a",
            "message_id": "message-a",
            "value": "like",
            "expected_scope_id": identity_a.scope_id,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "identity_changed"
    assert store.cases == ()

    # B's own captured scope remains valid and records only a B case.
    valid_b = client.post(
        "/api/session/feedback-learning",
        json={
            "session_id": "session-b",
            "message_id": "message-b",
            "value": "like",
            "expected_scope_id": identity_b.scope_id,
        },
    )
    assert valid_b.status_code == 200
    assert len(store.cases) == 1
    assert store.cases[0].identity_key == identity_b.key
    assert store.session_cases(identity=identity_a, session_id=canonical_a.session_id, subject_id="meta") == ()
    assert store.session_cases(identity=identity_b, session_id=canonical_b.session_id, subject_id="meta")


def test_route_requires_expected_scope_id(tmp_path: Path) -> None:
    app = FastAPI()
    identity = _identity()
    register_feedback_learning_routes(
        app,
        check_token=lambda _token: True,
        resolve_identity=lambda _request: identity,
        resolve_local_message=lambda _session_id, _message_id: _message("session-a", "message-a"),
        store=FeedbackCaseStore(tmp_path),
    )
    response = TestClient(app).post(
        "/api/session/feedback-learning",
        json={"session_id": "session-a", "message_id": "message-a", "value": "like"},
    )
    assert response.status_code == 422
    assert not (tmp_path / "cases.jsonl").exists()
