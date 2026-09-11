"""Authenticated Studio REST routes for versioned Workflow runs."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any, Callable, Mapping, Optional

from fastapi import APIRouter, FastAPI, Header, HTTPException, Query


if TYPE_CHECKING:
    from agenticx.runtime.graph.store import GraphRunStore
    from agenticx.runtime.workflow import WorkflowExecutor, WorkflowRuntimeService, WorkflowStore
else:
    # ``from __future__ import annotations`` keeps these aliases out of the
    # cold import path while still allowing ``typing.get_type_hints`` and
    # framework signature inspection to resolve the public annotations.
    GraphRunStore = WorkflowExecutor = WorkflowRuntimeService = WorkflowStore = Any


def register_workflow_routes(
    app: FastAPI,
    *,
    check_token: Callable[[Optional[str]], None],
    require_ordinary_session: Callable[[str], Any],
    owner_scope: str | Callable[[], str],
    workflow_store: Optional[WorkflowStore] = None,
    graph_store: Optional[GraphRunStore] = None,
    runtime_service: Optional[WorkflowRuntimeService] = None,
    workflow_executor: Optional[WorkflowExecutor] = None,
    workflow_executor_factory: Optional[Callable[[WorkflowRuntimeService], WorkflowExecutor]] = None,
    workflow_llm_resolver: Optional[Callable[..., Any]] = None,
    workflow_confirm_gate_resolver: Optional[Callable[..., Any]] = None,
    workflow_tools_resolver: Optional[Callable[..., Any]] = None,
    workflow_session_persist: Optional[Callable[[str, Any], Any]] = None,
    authorize_graph_run_owner: Optional[Callable[..., Any]] = None,
    ensure_session_durable: Optional[Callable[[str], Any]] = None,
) -> Optional[WorkflowRuntimeService]:
    """Attach the Workflow API and return its service for app-state wiring.

    The route module receives narrow callbacks from ``server.py``.  It never
    reads client-supplied owner or principal fields and therefore remains
    usable by the desktop renderer without importing the nested server state.
    """

    if getattr(app.state, "_workflow_routes_registered", False):
        # A default service is deliberately created on demand.  A second
        # registration call before the first authenticated request therefore
        # has no service object to return yet; injected services retain the
        # historical idempotent return value.
        return getattr(app.state, "workflow_runtime_service", None)

    # Do not open SQLite or create the graph-run root while the app factory is
    # merely assembling routes.  The authenticated route handlers call this
    # accessor after their token/session checks.  Keeping construction inside a
    # lock makes the first request single-flight even when a test or an ASGI
    # server drives the app from more than one thread.  Candidate objects stay
    # local until the entire service (including ApprovalStore schema setup) is
    # constructed, so a failed initialization can be retried without leaving
    # a partially published service in app.state.
    workflow_store_ref = workflow_store
    graph_store_ref = graph_store
    runtime_service_ref = runtime_service
    workflow_executor_ref = workflow_executor
    service_init_lock = threading.Lock()

    def _runtime_service() -> WorkflowRuntimeService:
        nonlocal workflow_store_ref, graph_store_ref, runtime_service_ref
        if runtime_service_ref is not None:
            return runtime_service_ref
        with service_init_lock:
            if runtime_service_ref is not None:
                return runtime_service_ref
            # Keep the package import on the authenticated first-use path as
            # well.  The server imports this route module while assembling
            # health/session routes, so importing WorkflowStore here avoids
            # loading the compiler/runtime/approval modules for every cold
            # Studio process that never opens Workflow.
            from agenticx.runtime.graph.store import get_default_store
            from agenticx.runtime.workflow import WorkflowRuntimeService, WorkflowStore

            candidate_workflow_store = (
                workflow_store_ref if workflow_store_ref is not None else WorkflowStore()
            )
            candidate_graph_store = graph_store_ref if graph_store_ref is not None else get_default_store()
            candidate_runtime_service = WorkflowRuntimeService(
                workflow_store=candidate_workflow_store,
                graph_store=candidate_graph_store,
                owner_scope=owner_scope,
                requester_principal=owner_scope,
            )
            # Publish all references only after construction has completed.
            workflow_store_ref = candidate_workflow_store
            graph_store_ref = candidate_graph_store
            runtime_service_ref = candidate_runtime_service
            app.state.workflow_store = candidate_workflow_store
            app.state.workflow_runtime_service = candidate_runtime_service
            app.state.workflow_approval_store = candidate_runtime_service.approval_store
            return candidate_runtime_service

    def _workflow_executor() -> WorkflowExecutor:
        nonlocal workflow_executor_ref
        if workflow_executor_ref is not None:
            app.state.workflow_executor = workflow_executor_ref
            return workflow_executor_ref
        with service_init_lock:
            if workflow_executor_ref is not None:
                app.state.workflow_executor = workflow_executor_ref
                return workflow_executor_ref
            from agenticx.runtime.workflow import WorkflowExecutor

            candidate = (
                workflow_executor_factory(_runtime_service())
                if workflow_executor_factory is not None
                else WorkflowExecutor(
                    _runtime_service(),
                    session_resolver=require_ordinary_session,
                    llm_resolver=workflow_llm_resolver,
                    confirm_gate_resolver=workflow_confirm_gate_resolver,
                    tools_resolver=workflow_tools_resolver,
                    persist_session=workflow_session_persist,
                    owner_scope=owner_scope,
                )
            )
            workflow_executor_ref = candidate
            app.state.workflow_executor = candidate
            return candidate

    def _workflow_store() -> WorkflowStore:
        return _runtime_service().workflow_store

    if runtime_service_ref is not None:
        # Explicitly injected services are already initialized by the caller;
        # preserve the old app.state wiring without touching default storage.
        app.state.workflow_store = runtime_service_ref.workflow_store
        app.state.workflow_runtime_service = runtime_service_ref
        app.state.workflow_approval_store = runtime_service_ref.approval_store
    elif workflow_store_ref is not None or graph_store_ref is not None:
        # A caller that injects either store is opting into the historical
        # eager-construction contract.  Complete service construction now so
        # registration still returns a usable service and publishes all state
        # references, while the no-injection server path remains lazy.
        _runtime_service()

    if workflow_executor_ref is not None:
        app.state.workflow_executor = workflow_executor_ref

    app.state._workflow_routes_registered = True

    router = APIRouter(tags=["workflows"])

    def _auth(token: Optional[str]) -> None:
        check_token(token)

    def _owner() -> str:
        value = owner_scope() if callable(owner_scope) else owner_scope
        return str(value or "").strip()

    def _principal() -> str:
        # This release has one authenticated local desktop principal.  Keep
        # its derivation server-owned even when clients send forged identity
        # fields in request bodies.
        return _owner()

    def _require_sid(value: Any) -> str:
        sid = str(value or "").strip()
        if not sid:
            raise HTTPException(status_code=400, detail="session_id is required")
        require_ordinary_session(sid)
        return sid

    def _authorize_run(run: Any, sid: str, group_id: str = "") -> None:
        if authorize_graph_run_owner is not None:
            authorize_graph_run_owner(run, session_id=sid, group_id=group_id)
        elif str(getattr(run, "session_id", "") or "") != sid:
            raise HTTPException(status_code=403, detail="workflow run does not belong to session")

    def _bound_group_id(sid: str) -> str:
        managed = require_ordinary_session(sid)
        avatar_id = str(getattr(managed, "avatar_id", "") or "").strip()
        return avatar_id[len("group:") :].strip() if avatar_id.startswith("group:") else ""

    def _effective_group_id(sid: str, requested: Any) -> Optional[str]:
        requested_group = str(requested or "").strip()
        bound_group = _bound_group_id(sid)
        if requested_group and not bound_group:
            raise HTTPException(status_code=403, detail="session does not belong to group")
        if requested_group and bound_group and requested_group != bound_group:
            raise HTTPException(status_code=403, detail="session does not belong to group")
        return requested_group or bound_group or None

    def _map_error(exc: Exception, *, definition: bool = False) -> HTTPException:
        # All callers invoke this after authentication and route validation.
        # Importing the exception hierarchy only when an authenticated request
        # needs error translation keeps route registration import-light.
        from agenticx.runtime.workflow import (
            ApprovalConflict,
            ApprovalError,
            ApprovalExpired,
            ApprovalIntentMismatch,
            ApprovalNotFound,
            ApprovalPolicyUnsupported,
            WorkflowCorruptError,
            WorkflowNotFound,
            WorkflowOwnershipError,
            WorkflowRunConflict,
            WorkflowClaimConflict,
            WorkflowExecutorError,
            WorkflowRunCancelled,
            WorkflowRunNotFound,
            WorkflowRunOwnershipError,
            WorkflowRevisionNotPublished,
            WorkflowValidationError,
            WorkflowVersionConflict,
        )

        if isinstance(exc, HTTPException):
            return exc
        if isinstance(exc, WorkflowValidationError):
            return HTTPException(status_code=422, detail=exc.to_dict())
        if isinstance(exc, ApprovalExpired):
            return HTTPException(status_code=410, detail={"error": "approval_expired", "message": str(exc)})
        if isinstance(exc, ApprovalIntentMismatch):
            return HTTPException(status_code=409, detail={"error": "intent_mismatch", "message": str(exc)})
        if isinstance(exc, WorkflowRevisionNotPublished):
            return HTTPException(
                status_code=409,
                detail={
                    "error": "revision_not_published",
                    "workflow_id": exc.workflow_id,
                    "revision": exc.revision,
                    "message": str(exc),
                },
            )
        if isinstance(exc, (WorkflowVersionConflict, WorkflowRunConflict, ApprovalConflict)):
            detail: dict[str, Any] = {"error": "conflict", "message": str(exc)}
            if isinstance(exc, WorkflowVersionConflict):
                detail.update(
                    {
                        "error": "version_conflict",
                        "expected_head_revision": exc.expected,
                        "actual_head_revision": exc.actual,
                    }
                )
            return HTTPException(status_code=409, detail=detail)
        if isinstance(exc, WorkflowClaimConflict):
            return HTTPException(
                status_code=409,
                detail={"error": "claim_conflict", "message": str(exc), "run_id": exc.run_id, "node_id": exc.node_id},
            )
        if isinstance(exc, WorkflowRunCancelled):
            return HTTPException(status_code=409, detail={"error": "run_cancelled", "message": str(exc)})
        if isinstance(exc, WorkflowExecutorError):
            return HTTPException(
                status_code=400,
                detail={"error": "execution_error", "message": str(exc), "run_id": exc.run_id, "node_id": exc.node_id},
            )
        if isinstance(exc, ApprovalPolicyUnsupported):
            return HTTPException(
                status_code=403,
                detail={"error": "approver_policy_not_verifiable", "message": str(exc)},
            )
        if isinstance(exc, (WorkflowNotFound, WorkflowCorruptError, ApprovalNotFound, WorkflowRunNotFound)):
            return HTTPException(status_code=404, detail=str(exc))
        if isinstance(exc, WorkflowOwnershipError):
            return HTTPException(status_code=404 if definition else 403, detail=str(exc))
        if isinstance(exc, WorkflowRunOwnershipError):
            return HTTPException(status_code=403, detail=str(exc))
        if isinstance(exc, ApprovalError):
            return HTTPException(status_code=409, detail={"error": "approval_conflict", "message": str(exc)})
        return HTTPException(status_code=400, detail=str(exc))

    def _definition(value: Any) -> dict[str, Any]:
        if hasattr(value, "to_dict"):
            return value.to_dict()
        return dict(value)

    def _manifest(value: Any) -> dict[str, Any]:
        return value.to_dict() if hasattr(value, "to_dict") else dict(value)

    def _approval(value: Any) -> dict[str, Any]:
        return value.to_dict() if hasattr(value, "to_dict") else dict(value)

    def _run_payload(run: Any, approvals: Optional[list[Any]] = None) -> dict[str, Any]:
        approvals = approvals if approvals is not None else []
        from agenticx.runtime.workflow import workflow_execution_envelope

        return {
            "run": run.to_dict(),
            "ready_node_ids": [
                node_id
                for node_id, node in run.nodes.items()
                if str(getattr(node.status, "value", node.status)) == "ready"
            ],
            "approvals": [_approval(item) for item in approvals],
            "execution": workflow_execution_envelope(run),
        }

    @router.get("/api/workflows/connectors")
    async def get_workflow_connectors(
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        from agenticx.runtime.workflow import connector_catalog_to_dict, get_connector_catalog

        # This is always the full service-owned catalog; renderer visibility
        # settings never remove semantic Workflow capabilities.
        return {"ok": True, "connectors": connector_catalog_to_dict(get_connector_catalog())}

    @router.get("/api/workflows")
    async def list_workflows(
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        try:
            manifests = _workflow_store().list_manifests(_owner())
            return {"ok": True, "workflows": [_manifest(item) for item in manifests]}
        except Exception as exc:
            raise _map_error(exc, definition=True) from exc

    @router.post("/api/workflows")
    async def create_workflow(
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        draft = payload.get("draft") if isinstance(payload.get("draft"), Mapping) else payload
        try:
            store = _workflow_store()
            snapshot = store.create(_owner(), draft)
            manifest = store.load_head(snapshot.workflow_id, _owner())
            snapshot_payload = _definition(snapshot)
            manifest_payload = _manifest(manifest)
            return {
                "ok": True,
                "snapshot": snapshot_payload,
                "manifest": manifest_payload,
                # Keep the historical alias while typed clients consume the
                # explicit definition/manifest pair.
                "workflow": snapshot_payload,
            }
        except Exception as exc:
            raise _map_error(exc, definition=True) from exc

    @router.get("/api/workflows/{workflow_id}")
    async def get_workflow(
        workflow_id: str,
        revision: Optional[int] = Query(default=None),
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        try:
            if revision is None:
                store = _workflow_store()
                head = store.load_head(workflow_id, _owner())
                selected = head.head_revision
            else:
                selected = revision
            store = _workflow_store()
            snapshot = store.load_revision(workflow_id, selected, _owner())
            manifest = store.load_head(workflow_id, _owner())
            snapshot_payload = _definition(snapshot)
            manifest_payload = _manifest(manifest)
            return {
                "ok": True,
                "snapshot": snapshot_payload,
                "manifest": manifest_payload,
                "workflow": snapshot_payload,
            }
        except Exception as exc:
            raise _map_error(exc, definition=True) from exc

    @router.put("/api/workflows/{workflow_id}")
    async def update_workflow(
        workflow_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        expected = payload.get("expected_head_revision", payload.get("expected_revision"))
        if isinstance(expected, bool) or not isinstance(expected, int):
            raise HTTPException(status_code=400, detail="expected_head_revision is required")
        draft = payload.get("draft") if isinstance(payload.get("draft"), Mapping) else payload
        try:
            store = _workflow_store()
            snapshot = store.append_revision(workflow_id, _owner(), expected, draft)
            manifest = store.load_head(workflow_id, _owner())
            snapshot_payload = _definition(snapshot)
            manifest_payload = _manifest(manifest)
            return {
                "ok": True,
                "snapshot": snapshot_payload,
                "manifest": manifest_payload,
                "workflow": snapshot_payload,
            }
        except Exception as exc:
            raise _map_error(exc, definition=True) from exc

    @router.get("/api/workflows/{workflow_id}/revisions")
    async def list_workflow_revisions(
        workflow_id: str,
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        try:
            revisions = _workflow_store().list_revisions(workflow_id, _owner())
            return {"ok": True, "workflow_id": workflow_id, "revisions": [_definition(item) for item in revisions]}
        except Exception as exc:
            raise _map_error(exc, definition=True) from exc

    @router.post("/api/workflows/{workflow_id}/publish")
    async def publish_workflow(
        workflow_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        revision = payload.get("revision", payload.get("workflow_revision"))
        expected = payload.get("expected_head_revision", payload.get("expected_revision"))
        if isinstance(revision, bool) or not isinstance(revision, int):
            raise HTTPException(status_code=400, detail="revision is required")
        if isinstance(expected, bool) or not isinstance(expected, int):
            raise HTTPException(status_code=400, detail="expected_head_revision is required")
        try:
            store = _workflow_store()
            manifest = store.publish(workflow_id, _owner(), revision, expected)
            snapshot = store.load_revision(workflow_id, revision, _owner())
            snapshot_payload = _definition(snapshot)
            manifest_payload = _manifest(manifest)
            return {
                "ok": True,
                "snapshot": snapshot_payload,
                "manifest": manifest_payload,
                "published_revision": revision,
                "workflow": snapshot_payload,
            }
        except Exception as exc:
            raise _map_error(exc, definition=True) from exc

    @router.post("/api/workflows/{workflow_id}/runs")
    async def create_workflow_run(
        workflow_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        sid = _require_sid(payload.get("session_id"))
        try:
            if ensure_session_durable is not None:
                ensured = ensure_session_durable(sid)
                if ensured is False:
                    raise HTTPException(status_code=503, detail="session could not be persisted")
            effective_group_id = _effective_group_id(sid, payload.get("group_id"))
            raw_inputs = payload.get("inputs")
            if raw_inputs is not None and not isinstance(raw_inputs, Mapping):
                raise HTTPException(status_code=400, detail="inputs must be an object")
            result = _runtime_service().create_run(
                workflow_id,
                revision=payload.get("revision", payload.get("workflow_revision")),
                session_id=sid,
                group_id=effective_group_id,
                inputs=raw_inputs,
                run_id=payload.get("run_id"),
                owner_scope=_owner(),
                requester_principal=_principal(),
                acting_agent_id="",
            )
            # Explicit run creation is the demand signal.  The executor is
            # constructed lazily here (after auth/session checks) and owns a
            # bounded in-process pump; app startup never initializes models or
            # connector clients.
            _workflow_executor().request_start(result.run.run_id, sid)
            return {"ok": True, **result.to_dict()}
        except Exception as exc:
            raise _map_error(exc) from exc

    @router.get("/api/workflow-runs/{run_id}")
    async def get_workflow_run(
        run_id: str,
        session_id: str = Query(default=""),
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        sid = _require_sid(session_id)
        try:
            service = _runtime_service()
            run = service.get_run(run_id, sid, owner_scope=_owner())
            approvals = service.list_approvals(run_id, sid, owner_scope=_owner())
            _authorize_run(run, sid)
            return {"ok": True, **_run_payload(run, approvals)}
        except Exception as exc:
            raise _map_error(exc) from exc

    @router.post("/api/workflow-runs/{run_id}/nodes/{node_id}/result")
    async def report_workflow_node_result(
        run_id: str,
        node_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        sid = _require_sid(payload.get("session_id"))
        expected = payload.get("expected_version")
        if isinstance(expected, bool) or not isinstance(expected, int):
            raise HTTPException(status_code=400, detail="expected_version is required")
        attempt_id = payload.get("attempt_id")
        fencing_token = payload.get("fencing_token")
        if attempt_id is not None or fencing_token is not None:
            if not isinstance(attempt_id, str) or not attempt_id.strip():
                raise HTTPException(status_code=400, detail="attempt_id is required with fencing_token")
            if isinstance(fencing_token, bool) or not isinstance(fencing_token, int):
                raise HTTPException(status_code=400, detail="fencing_token is required with attempt_id")
            # Claims are completed only by the service-owned executor.  The
            # renderer may still read the durable claim envelope for progress,
            # but presenting an attempt/fence over HTTP must never become a
            # forged result handoff.
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "executor_owned_attempt",
                    "message": "active workflow attempts can only be completed by the managed executor",
                },
            )
        try:
            service = _runtime_service()
            current = service.get_run(run_id, sid, owner_scope=_owner())
            _authorize_run(current, sid)
            active_claim = service.get_node_claim(
                run_id,
                node_id,
                sid,
                owner_scope=_owner(),
            )
            if active_claim is not None:
                # The HTTP renderer cannot complete an attempt owned by the
                # managed executor.  Exposing this as an explicit conflict
                # gives the UI a stable signal to refresh execution state.
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "executor_owned_attempt",
                        "message": "active workflow attempts can only be completed by the managed executor",
                    },
                )
            run = service.report_node_result(
                run_id,
                node_id,
                sid,
                expected,
                payload.get("outcome", ""),
                payload.get("output_summary", ""),
                payload.get("evidence"),
                payload.get("selected_route"),
                owner_scope=_owner(),
                requester_principal=_principal(),
                attempt_id=attempt_id,
                fencing_token=fencing_token,
                artifacts=payload.get("artifacts"),
                usage_metadata=payload.get("usage_metadata"),
                side_effect_state=payload.get("side_effect_state", "none"),
            )
            approvals = service.list_approvals(run_id, sid, owner_scope=_owner())
            return {"ok": True, **_run_payload(run, approvals)}
        except Exception as exc:
            raise _map_error(exc) from exc

    @router.post("/api/workflow-runs/{run_id}/resume")
    async def resume_workflow_run(
        run_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        """Explicitly resume/recover a durable run after restart or approval."""

        _auth(x_agx_desktop_token)
        sid = _require_sid(payload.get("session_id"))
        expected = payload.get("expected_version")
        if expected is not None and (isinstance(expected, bool) or not isinstance(expected, int)):
            raise HTTPException(status_code=400, detail="expected_version must be an integer")
        try:
            service = _runtime_service()
            current = service.get_run(run_id, sid, owner_scope=_owner())
            _authorize_run(current, sid)
            run = service.advance(
                run_id,
                sid,
                current.version if expected is None else expected,
                owner_scope=_owner(),
                requester_principal=_principal(),
            )
            _workflow_executor().request_start(run_id, sid)
            approvals = service.list_approvals(run_id, sid, owner_scope=_owner())
            return {"ok": True, **_run_payload(run, approvals)}
        except Exception as exc:
            raise _map_error(exc) from exc

    @router.post("/api/workflow-runs/{run_id}/cancel")
    async def cancel_workflow_run(
        run_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        sid = _require_sid(payload.get("session_id"))
        expected = payload.get("expected_version")
        if expected is not None and (isinstance(expected, bool) or not isinstance(expected, int)):
            raise HTTPException(status_code=400, detail="expected_version must be an integer")
        try:
            service = _runtime_service()
            current = service.get_run(run_id, sid, owner_scope=_owner())
            _authorize_run(current, sid)
            run = service.cancel_run(
                run_id,
                sid,
                expected_version=expected,
                owner_scope=_owner(),
                cancelled_by=_principal(),
            )
            # The durable CAS is the authorization boundary.  A stale cancel
            # must return before signalling the in-process pump, otherwise a
            # losing request can stop a newer attempt while leaving its claim
            # RUNNING.  Signal only after cancel_run has committed.
            _workflow_executor().request_cancel(run_id)
            approvals = service.list_approvals(run_id, sid, owner_scope=_owner())
            return {"ok": True, **_run_payload(run, approvals)}
        except Exception as exc:
            raise _map_error(exc) from exc

    @router.post("/api/workflow-runs/{run_id}/nodes/{node_id}/retry")
    async def retry_workflow_node(
        run_id: str,
        node_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        sid = _require_sid(payload.get("session_id"))
        expected = payload.get("expected_version")
        if isinstance(expected, bool) or not isinstance(expected, int):
            raise HTTPException(status_code=400, detail="expected_version is required")
        try:
            service = _runtime_service()
            current = service.get_run(run_id, sid, owner_scope=_owner())
            _authorize_run(current, sid)
            run = service.retry_node(
                run_id,
                node_id,
                sid,
                expected,
                reconcile=bool(payload.get("reconcile", False)),
                owner_scope=_owner(),
            )
            _workflow_executor().request_start(run_id, sid)
            approvals = service.list_approvals(run_id, sid, owner_scope=_owner())
            return {"ok": True, **_run_payload(run, approvals)}
        except Exception as exc:
            raise _map_error(exc) from exc

    @router.get("/api/workflow-runs/{run_id}/approvals")
    async def list_workflow_approvals(
        run_id: str,
        session_id: str = Query(default=""),
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        sid = _require_sid(session_id)
        try:
            service = _runtime_service()
            run = service.get_run(run_id, sid, owner_scope=_owner())
            _authorize_run(run, sid)
            approvals = service.list_approvals(run_id, sid, owner_scope=_owner())
            return {"ok": True, "run_id": run_id, "approvals": [_approval(item) for item in approvals]}
        except Exception as exc:
            raise _map_error(exc) from exc

    @router.post("/api/workflow-approvals/{approval_id}/decision")
    async def decide_workflow_approval(
        approval_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        sid = _require_sid(payload.get("session_id"))
        expected = payload.get("expected_version")
        if isinstance(expected, bool) or not isinstance(expected, int):
            raise HTTPException(status_code=400, detail="expected_version is required")
        expected_run_version = payload.get("expected_run_version")
        if expected_run_version is not None and (
            isinstance(expected_run_version, bool)
            or not isinstance(expected_run_version, int)
            or expected_run_version < 1
        ):
            raise HTTPException(status_code=400, detail="expected_run_version must be a positive integer")
        decision = str(payload.get("decision") or payload.get("status") or "").strip().lower()
        if not decision:
            raise HTTPException(status_code=400, detail="decision is required")
        try:
            service = _runtime_service()
            request = service.approval_store.get(approval_id)
            run = service.get_run(request.run_id, sid, owner_scope=_owner())
            _authorize_run(run, sid)
            result = service.decide_approval(
                approval_id,
                sid,
                decision,
                expected,
                # Client decided_by is intentionally ignored; this principal
                # comes from the authenticated server callback.
                decided_by=_principal(),
                decision_note=payload.get("decision_note"),
                expected_run_version=expected_run_version,
                owner_scope=_owner(),
            )
            return {"ok": True, **result.to_dict()}
        except Exception as exc:
            raise _map_error(exc) from exc

    @router.post("/api/workflow-approvals/{approval_id}/resume")
    async def resume_workflow_approval(
        approval_id: str,
        payload: dict[str, Any],
        x_agx_desktop_token: Optional[str] = Header(default=None),
    ) -> dict[str, Any]:
        _auth(x_agx_desktop_token)
        sid = _require_sid(payload.get("session_id"))
        expected_version = payload.get("expected_version")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int) or expected_version < 1:
            raise HTTPException(status_code=400, detail="expected_version is required")
        expected_run_version = payload.get("expected_run_version")
        if expected_run_version is not None and (
            isinstance(expected_run_version, bool)
            or not isinstance(expected_run_version, int)
            or expected_run_version < 1
        ):
            raise HTTPException(status_code=400, detail="expected_run_version must be a positive integer")
        try:
            service = _runtime_service()
            request = service.approval_store.get(approval_id)
            run = service.get_run(request.run_id, sid, owner_scope=_owner())
            _authorize_run(run, sid)
            result = service.resume_approval(
                approval_id,
                sid,
                expected_version=expected_version,
                expected_run_version=expected_run_version,
                result_digest=payload.get("result_digest"),
                owner_scope=_owner(),
                requester_principal=_principal(),
            )
            _workflow_executor().request_start(result.run.run_id, sid)
            return {"ok": True, **result.to_dict()}
        except Exception as exc:
            raise _map_error(exc) from exc

    app.include_router(router)
    return runtime_service_ref


__all__ = ["register_workflow_routes"]
