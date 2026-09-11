"""Desktop personal-assistant enterprise action bridge.

The Studio process intentionally knows only the authenticated loopback broker
credential.  Enterprise PATs, Portal URLs and short-lived Portal session
tokens stay in Electron's main process.  These helpers are injected only into
the dedicated Desktop assistant session; ordinary Studio sessions do not see
or dispatch these tools.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Dict, Mapping, Optional
from urllib.parse import urlparse

from agenticx.runtime.permission_mode import permission_mode_for_session

ENTERPRISE_CAPABILITIES_TOOL = "enterprise_capabilities"
ENTERPRISE_ACTION_TOOL = "enterprise_action"
ENTERPRISE_ACTION_TOOL_NAMES = frozenset(
    {ENTERPRISE_CAPABILITIES_TOOL, ENTERPRISE_ACTION_TOOL}
)

_BROKER_URL_ENV = "AGX_ENTERPRISE_ACTION_BROKER_URL"
_BROKER_TOKEN_ENV = "AGX_ENTERPRISE_ACTION_BROKER_TOKEN"
_BROKER_TIMEOUT_SECONDS = 25.0
_MAX_TOOL_RESULT_CHARS = 12_000
_MAX_ARGUMENT_BYTES = 64 * 1024
_MAX_CAPABILITY_CACHE_AGE_SECONDS = 20.0
_ENTERPRISE_CONTEXT_ATTR = "_enterprise_assistant_context"
_ENTERPRISE_CONTEXT_METADATA_KEY = "_agx_enterprise_context"
# ``authGeneration`` is intentionally process-local.  A fresh Python process
# must rely on the stable authorization version instead of treating a counter
# reset as a permission change.
_PROCESS_EPOCH = uuid.uuid4().hex

_CONTROL_METADATA_KEYS = (
    "authorizationVersion",
    "authorization_version",
    "authorization_version_id",
    "operationId",
    "operation_id",
    "authGeneration",
    "status",
    "ok",
    "code",
    "actionId",
    "action_id",
    "runId",
    "run_id",
)
_JSON_OMIT = object()

# Only these explicit authentication revocation responses authorize rotating
# the local transcript. Network failures, unavailable snapshots, and a stale
# session binding must preserve the current session so the user can retry.
_AUTH_REVOCATION_CODES = frozenset(
    {
        "ASSISTANT_REAUTH_REQUIRED",
        "ASSISTANT_AUTH_REVOKED",
        "ASSISTANT_SESSION_REVOKED",
        "ENTERPRISE_REAUTH_REQUIRED",
        "ENTERPRISE_AUTH_REVOKED",
        "ENTERPRISE_SESSION_REVOKED",
    }
)

_READ_EFFECTS = frozenset(
    {
        "read",
        "readonly",
        "read-only",
        "read_only",
        "query",
        "observe",
        "health",
        "diagnostic",
    }
)


def _broker_url() -> str:
    value = str(os.getenv(_BROKER_URL_ENV, "") or "").strip().rstrip("/")
    try:
        parsed = urlparse(value)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"}:
        return ""
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        return ""
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return ""
    return value


def enterprise_action_broker_available() -> bool:
    """Whether this Python process has a valid local broker credential."""

    return bool(_broker_url() and str(os.getenv(_BROKER_TOKEN_ENV, "") or "").strip())


def _is_personal_assistant_session(session: Any) -> bool:
    # The marker is copied from the server-owned managed session before the
    # runtime starts. Never derive this from a display name or user prompt.
    return str(getattr(session, "_session_purpose", "") or "").strip().lower() == "environment-assistant"


def _session_id(session: Any) -> str:
    return str(
        getattr(session, "_session_id", "")
        or getattr(session, "session_id", "")
        or "",
    ).strip()


def _normalized_authorization_version(value: Any) -> str:
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, (str, int, float)):
        text = str(value).strip()
        return text[:200]
    return ""


def _context_version_from_value(value: Any) -> str:
    if isinstance(value, Mapping):
        for key in ("authorizationVersion", "authorization_version", "authorization_version_id"):
            version = _normalized_authorization_version(value.get(key))
            if version:
                return version
        nested = value.get("result")
        if isinstance(nested, (Mapping, str)):
            version = _context_version_from_value(nested)
            if version:
                return version
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return ""
        return _context_version_from_value(parsed)
    return ""


def _remember_enterprise_context(session: Any, response: Mapping[str, Any]) -> None:
    """Record only an authorization version/generation for turn-boundary fencing.

    The marker is private session state. It contains no PAT, Portal URL, user,
    tenant, or action result; the actual transcript remains the model-visible
    history and is discarded by the caller when the version changes.
    """

    version = _context_version_from_value(response)
    generation = response.get("authGeneration")
    if not version and not isinstance(generation, int):
        return
    current = getattr(session, _ENTERPRISE_CONTEXT_ATTR, None)
    marker = dict(current) if isinstance(current, Mapping) else {}
    # ``restored`` fences only the first successful preflight after a process
    # restart.  Once this process has observed a current snapshot, later
    # authGeneration changes in the same process must fence immediately.
    marker.pop("restored", None)
    marker["enterpriseContext"] = True
    if version:
        marker["authorizationVersion"] = version
    if isinstance(generation, int) and not isinstance(generation, bool):
        marker["authGeneration"] = generation
    marker["processEpoch"] = _PROCESS_EPOCH
    marker["observedAt"] = int(time.time())
    # Keep this off StudioSession.scratchpad: that store is intentionally
    # rendered into the model prompt, while this is an internal turn fence.
    setattr(session, _ENTERPRISE_CONTEXT_ATTR, marker)


def _remembered_enterprise_context(session: Any) -> dict[str, Any]:
    marker = getattr(session, _ENTERPRISE_CONTEXT_ATTR, None)
    if isinstance(marker, Mapping):
        return dict(marker)
    return {}


def enterprise_context_marker_for_persistence(session: Any) -> dict[str, Any]:
    """Return the small private marker safe to store with managed metadata.

    The marker is deliberately separate from ``scratchpad`` and message rows:
    both of those can be included in a model prompt.  Only the stable version
    and the fact that enterprise material was seen cross the process boundary;
    process-local generation/epoch values are never persisted.
    """

    marker = _remembered_enterprise_context(session)
    has_context = bool(marker.get("enterpriseContext")) or bool(marker)
    history_version = _context_version_from_history(session)
    version = _normalized_authorization_version(
        marker.get("authorizationVersion") if marker else None
    ) or history_version
    if not has_context and not session_has_enterprise_context(session):
        return {}
    persisted: dict[str, Any] = {"enterpriseContext": True}
    if version:
        persisted["authorizationVersion"] = version
    return persisted


def restore_enterprise_context_marker(session: Any, value: Any) -> None:
    """Restore a server-written private marker without accepting prompt data."""

    if not isinstance(value, Mapping):
        return
    version = _normalized_authorization_version(value.get("authorizationVersion"))
    if not version:
        version = _normalized_authorization_version(value.get("authorization_version"))
    present = bool(
        value.get("enterpriseContext")
        or value.get("has_enterprise_context")
        or version
    )
    if not present:
        return
    marker: dict[str, Any] = {"enterpriseContext": True, "restored": True}
    if version:
        marker["authorizationVersion"] = version
    # Do not restore authGeneration/processEpoch: they identify the old
    # process and are not stable authorization identities across a restart.
    setattr(session, _ENTERPRISE_CONTEXT_ATTR, marker)


def copy_enterprise_context_marker(source: Any, target: Any) -> None:
    """Copy the private runtime marker when a managed runtime is cloned."""

    marker = _remembered_enterprise_context(source)
    if not marker:
        # A legacy session can still have a trusted enterprise tool row even
        # when its transient marker was lost.  Carry only the recoverable
        # stable version into the clone; ordinary prompt/context fields are
        # never accepted as a marker source.
        marker = enterprise_context_marker_for_persistence(source)
    if not marker:
        return
    copied = {
        key: marker[key]
        for key in ("enterpriseContext", "authorizationVersion", "authGeneration", "processEpoch", "observedAt")
        if key in marker
    }
    if copied:
        setattr(target, _ENTERPRISE_CONTEXT_ATTR, copied)


def session_has_enterprise_context(session: Any) -> bool:
    """Detect enterprise material without probing the Portal for pure env turns."""

    if _remembered_enterprise_context(session):
        return True
    tool_names = ENTERPRISE_ACTION_TOOL_NAMES
    for collection_name in ("chat_history", "agent_messages"):
        rows = getattr(session, collection_name, None)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            name = str(row.get("tool_name") or row.get("name") or "").strip()
            if name in tool_names:
                return True
            calls = row.get("tool_calls")
            if isinstance(calls, list) and any(
                isinstance(call, Mapping)
                and isinstance(call.get("function"), Mapping)
                and str(call["function"].get("name") or "").strip() in tool_names
                for call in calls
            ):
                return True
    return False


def _context_version_from_history(session: Any) -> str:
    for collection_name in ("chat_history", "agent_messages"):
        rows = getattr(session, collection_name, None)
        if not isinstance(rows, list):
            continue
        for row in reversed(rows):
            if not isinstance(row, Mapping):
                continue
            name = str(row.get("tool_name") or row.get("name") or "").strip()
            if name not in ENTERPRISE_ACTION_TOOL_NAMES:
                continue
            version = _context_version_from_value(row.get("content"))
            if version:
                return version
    return ""


async def enterprise_authorization_preflight(session: Any) -> dict[str, Any]:
    """Check a previously enterprise-enriched session before a new LLM turn.

    No request is sent for a session that has never used an enterprise tool.
    When a marker exists, the broker obtains a fresh server-owned capability
    snapshot; a changed authorization version or auth generation invalidates
    the old context before the model can read it.
    """

    if not _is_personal_assistant_session(session) or not session_has_enterprise_context(session):
        return {"checked": False, "ok": True, "stale": False}
    # A restored transcript may still contain an enterprise tool row while the
    # in-memory marker is absent (for example after an older process crashed).
    # Reconstruct only the local fence from that trusted history shape; never
    # treat ordinary request/context fields as a marker source.
    marker = _remembered_enterprise_context(session)
    if not marker:
        marker = {"enterpriseContext": True}
        history_version = _context_version_from_history(session)
        if history_version:
            marker["authorizationVersion"] = history_version
        setattr(session, _ENTERPRISE_CONTEXT_ATTR, marker)
    sid = _valid_id(_session_id(session))
    if not sid:
        return {"checked": True, "ok": False, "stale": True, "code": "ENTERPRISE_CONTEXT_INVALID", "message": "个人助手企业上下文无有效会话绑定。"}
    mode = str(permission_mode_for_session(session) or "ask").strip().lower()
    if mode not in {"plan", "ask", "auto"}:
        mode = "ask"
    client = getattr(session, "_enterprise_action_broker_client", None)
    if client is None or not callable(getattr(client, "preflight", None)):
        client = EnterpriseActionBrokerClient()
        setattr(session, "_enterprise_action_broker_client", client)
    try:
        response = await client.preflight(sid, mode)
    except Exception:
        # A transport/runtime failure says nothing about whether the user's
        # role changed. Preserve the marker and let the caller block this turn
        # for a retry rather than rotating or exposing an exception upstream.
        return {
            "checked": True,
            "ok": False,
            "stale": False,
            "blocked": True,
            "code": "ENTERPRISE_AUTH_UNAVAILABLE",
            "message": "当前企业权限暂时无法核验，当前会话已保留，请稍后重试。",
        }
    if response.get("ok") is not True:
        code = str(response.get("code") or "ENTERPRISE_AUTH_UNAVAILABLE").strip().upper()
        revoked = code in _AUTH_REVOCATION_CODES
        return {
            "checked": True,
            "ok": False,
            "stale": revoked,
            "blocked": True,
            "code": code,
            "message": response.get("message") or "当前企业权限无法核验。",
            "authorizationVersion": response.get("authorizationVersion"),
            "authGeneration": response.get("authGeneration"),
        }
    marker = _remembered_enterprise_context(session)
    known_version = _normalized_authorization_version(
        marker.get("authorizationVersion") if marker else None
    ) or _context_version_from_history(session)
    current_version = _normalized_authorization_version(response.get("authorizationVersion"))
    known_generation = marker.get("authGeneration") if marker else None
    current_generation = response.get("authGeneration")
    if not current_version:
        # A missing version is an unavailable fresh authorization snapshot. It
        # must block the next model turn while preserving the old context; it
        # is not evidence that permissions changed.
        return {
            "checked": True,
            "ok": False,
            "stale": False,
            "blocked": True,
            "code": "ASSISTANT_AUTH_VERSION_UNAVAILABLE",
            "message": "企业权限版本无法核验，当前会话已保留，请稍后重试。",
            "authGeneration": current_generation,
        }
    if not known_version:
        # Enterprise material exists, but its original stable authorization
        # version cannot be recovered (truncated tool JSON, old compaction, or
        # a damaged transcript).  Current permissions must never retroactively
        # bless that material; isolate it before model admission.
        return {
            "checked": True,
            "ok": False,
            "stale": True,
            "blocked": True,
            "code": "ENTERPRISE_CONTEXT_STALE",
            "message": "旧企业上下文缺少可恢复的权限版本，已隔离，请重新打开个人助手。",
            "authorizationVersion": current_version,
            "authGeneration": current_generation,
        }
    generation_changed_in_process = bool(
        marker.get("restored") is not True
        and isinstance(known_generation, int)
        and isinstance(current_generation, int)
        and known_generation != current_generation
    )
    stale = bool(
        (known_version and current_version and known_version != current_version)
        or generation_changed_in_process
    )
    if not stale and (current_version or isinstance(current_generation, int)):
        _remember_enterprise_context(session, response)
    return {
        "checked": True,
        "ok": not stale,
        "stale": stale,
        "code": "ENTERPRISE_CONTEXT_STALE" if stale else None,
        "message": "企业权限已更新，旧企业上下文已失效。" if stale else "",
        "authorizationVersion": response.get("authorizationVersion"),
        "authGeneration": current_generation,
    }


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _bounded_json_value(value: Any, budget: int) -> Any:
    """Build a JSON-safe value that fits within ``budget`` characters."""

    budget = max(0, int(budget))
    try:
        encoded = _json_dumps(value)
    except Exception:
        return _JSON_OMIT
    if len(encoded) <= budget:
        return value

    if isinstance(value, str):
        suffix = "…[内容已截断]"
        if len(_json_dumps(suffix)) > budget:
            return _JSON_OMIT
        low, high = 0, len(value)
        best = suffix
        while low <= high:
            mid = (low + high) // 2
            candidate = value[:mid] + suffix
            if len(_json_dumps(candidate)) <= budget:
                best = candidate
                low = mid + 1
            else:
                high = mid - 1
        return best

    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        keys = list(value.keys())
        ordered_keys = [
            key
            for key in _CONTROL_METADATA_KEYS
            if key in value
        ] + [key for key in keys if key not in _CONTROL_METADATA_KEYS]
        for raw_key in ordered_keys:
            key = str(raw_key)
            current_len = len(_json_dumps(result))
            # Account for the comma, key and colon before recursively bounding
            # the child.  A child that cannot fit is omitted as a whole.
            child_budget = budget - current_len - len(_json_dumps(key)) - 4
            if child_budget <= 0:
                break
            bounded = _bounded_json_value(value[raw_key], child_budget)
            if bounded is _JSON_OMIT:
                continue
            candidate = {**result, key: bounded}
            if len(_json_dumps(candidate)) <= budget:
                result = candidate
        return result if len(_json_dumps(result)) <= budget else _JSON_OMIT

    if isinstance(value, list):
        result: list[Any] = []
        for item in value:
            current_len = len(_json_dumps(result))
            child_budget = budget - current_len - 2
            if child_budget <= 0:
                break
            bounded = _bounded_json_value(item, child_budget)
            if bounded is _JSON_OMIT:
                break
            candidate = [*result, bounded]
            if len(_json_dumps(candidate)) > budget:
                break
            result = candidate
        if len(result) < len(value):
            omitted = {"truncated": True, "omitted": len(value) - len(result)}
            candidate = [*result, omitted]
            if len(_json_dumps(candidate)) <= budget:
                result = candidate
        return result if len(_json_dumps(result)) <= budget else _JSON_OMIT

    # Numbers/bools/null have already been tested above.  An exotic JSON value
    # cannot be safely shortened without changing its type, so omit it.
    return _JSON_OMIT


def _safe_json(value: Any, *, max_chars: int = _MAX_TOOL_RESULT_CHARS) -> str:
    """Serialize a tool result without cutting through JSON syntax.

    Enterprise control metadata is placed first and retained whenever the
    configured budget permits.  Large result/data/capability fields are
    recursively bounded and carry an explicit ``truncated`` marker so a model
    can re-query instead of treating an incomplete payload as authoritative.
    """

    try:
        text = _json_dumps(value)
    except Exception:
        fallback = _json_dumps({"status": "error", "message": "结果无法序列化"})
        try:
            limit = max(1, int(max_chars))
        except (TypeError, ValueError):
            limit = _MAX_TOOL_RESULT_CHARS
        return fallback if len(fallback) <= limit else "null"
    try:
        # Honour the caller's bound exactly.  Very small custom budgets may
        # have no room for both control metadata and a truncation marker; in
        # that case the final valid ``null`` fallback is safer than exceeding
        # the advertised limit.
        limit = max(1, int(max_chars))
    except (TypeError, ValueError):
        limit = _MAX_TOOL_RESULT_CHARS
    if len(text) <= limit:
        return text

    original_chars = len(text)
    if isinstance(value, Mapping):
        bounded: dict[str, Any] = {}

        def _try_add(raw_key: Any, raw_value: Any) -> None:
            key = str(raw_key)
            if key in bounded:
                return
            current_len = len(_json_dumps(bounded))
            child_budget = limit - current_len - len(_json_dumps(key)) - 4
            if child_budget <= 0:
                return
            child = _bounded_json_value(raw_value, child_budget)
            if child is _JSON_OMIT:
                return
            candidate = {**bounded, key: child}
            if len(_json_dumps(candidate)) <= limit:
                bounded.update({key: child})

        # Control fields are serialized before the verbose payload.  This is
        # the invariant that prevents a large result from evicting the version
        # or operation id used by the authorization fence.
        for key in _CONTROL_METADATA_KEYS:
            if key in value:
                _try_add(key, value[key])
        _try_add("truncated", True)
        _try_add("originalChars", original_chars)
        _try_add("truncationNotice", "结果已截断，需重新调用动作获取完整内容")
        for key in ("result", "data", "capabilities", "proposal"):
            if key in value:
                _try_add(key, value[key])
        for key, raw_value in value.items():
            if str(key) in bounded or key in _CONTROL_METADATA_KEYS:
                continue
            _try_add(key, raw_value)
        candidate_text = _json_dumps(bounded)
    else:
        bounded_value = _bounded_json_value(value, limit - 120)
        bounded = {
            "truncated": True,
            "originalChars": original_chars,
            "truncationNotice": "结果已截断，需重新调用动作获取完整内容",
        }
        if bounded_value is not _JSON_OMIT:
            bounded["value"] = bounded_value
        candidate_text = _json_dumps(bounded)

    if len(candidate_text) <= limit:
        return candidate_text
    # The normal path above has enough room for the default budget.  Keep a
    # final valid fallback for callers supplying an unusually tiny budget.
    minimal = _json_dumps({"truncated": True})
    return minimal if len(minimal) <= limit else "null"


def _error_result(name: str, response: Mapping[str, Any]) -> str:
    code = str(response.get("code") or "ENTERPRISE_ACTION_ERROR").strip()[:120]
    message = str(response.get("message") or response.get("error") or "企业动作失败").strip()
    # The broker already strips credential values; keep model-facing errors
    # short so a Portal proxy cannot turn an error into an unbounded prompt.
    return f"ERROR: {name} [{code}] {message[:500]}"


def _valid_id(value: Any, *, max_length: int = 160) -> str:
    text = str(value or "").strip()
    if not text or len(text) > max_length:
        return ""
    if any(ch in text for ch in "/\\?#%\x00\r\n"):
        return ""
    return text


def _action_effect_is_read(effect: Any) -> bool:
    normalized = str(effect or "").strip().lower().replace(" ", "_")
    return normalized in _READ_EFFECTS


def _capability_rows(response: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = response.get("capabilities")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw[:128]:
        if not isinstance(row, Mapping):
            continue
        action_id = _valid_id(row.get("id"), max_length=128)
        if not action_id:
            continue
        schema = row.get("inputSchema")
        out.append(
            {
                "id": action_id,
                "label": str(row.get("label") or action_id)[:200],
                "description": str(row.get("description") or "")[:600],
                "inputSchema": schema if isinstance(schema, Mapping) else {},
                "effect": str(row.get("effect") or "unknown")[:80],
            }
        )
    return out


def _proposal_summary(proposal: Any) -> list[dict[str, str]]:
    if not isinstance(proposal, Mapping):
        return []
    rows: list[dict[str, str]] = []
    title = str(proposal.get("title") or "企业操作")[:200].strip()
    if title:
        rows.append({"label": "操作", "value": title})
    changes = proposal.get("changes")
    if changes is not None:
        if isinstance(changes, str):
            value = changes
        else:
            value = _safe_json(changes, max_chars=2500)
        if value.strip(): rows.append({"label": "变更", "value": value[:2500]})
    return rows[:12]


class EnterpriseActionBrokerClient:
    """Small Python client for the authenticated Electron loopback broker."""

    def __init__(self) -> None:
        self._capabilities_cache: Dict[tuple[str, str], tuple[float, list[dict[str, Any]], Any]] = {}

    async def _request(
        self,
        method: str,
        path: str,
        payload: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        base = _broker_url()
        token = str(os.getenv(_BROKER_TOKEN_ENV, "") or "").strip()
        if not base or not token:
            return {
                "ok": False,
                "code": "ENTERPRISE_BROKER_UNAVAILABLE",
                "message": "当前 Desktop 未提供企业动作桥接。",
            }
        if not path.startswith("/") or "?" in path or "#" in path:
            return {"ok": False, "code": "INVALID_BROKER_PATH", "message": "企业桥接路径无效。"}
        try:
            import httpx
        except Exception:
            return {"ok": False, "code": "HTTP_CLIENT_UNAVAILABLE", "message": "企业桥接依赖不可用。"}
        try:
            transport = httpx.AsyncHTTPTransport()
            timeout = httpx.Timeout(_BROKER_TIMEOUT_SECONDS, connect=5.0)
            async with httpx.AsyncClient(
                timeout=timeout,
                transport=transport,
                trust_env=False,
            ) as client:
                response = await client.request(
                    method,
                    f"{base}{path}",
                    headers={
                        "accept": "application/json",
                        "content-type": "application/json",
                        "x-agx-enterprise-action-broker-token": token,
                    },
                    json=dict(payload) if payload is not None else None,
                )
        except Exception:
            return {
                "ok": False,
                "code": "ENTERPRISE_BROKER_UNAVAILABLE",
                "message": "企业服务暂时不可用，请稍后重试。",
            }
        try:
            body = response.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        if response.status_code >= 400:
            body.setdefault("ok", False)
            body.setdefault("code", f"HTTP_{response.status_code}")
            body.setdefault("message", "企业动作请求失败。")
        else:
            body.setdefault("ok", True)
        return body

    async def capabilities(self, session_id: str, permission_mode: str) -> Dict[str, Any]:
        key = (session_id, permission_mode)
        cached = self._capabilities_cache.get(key)
        if cached and time.monotonic() - cached[0] < _MAX_CAPABILITY_CACHE_AGE_SECONDS:
            return {
                "ok": True,
                "capabilities": cached[1],
                "authorizationVersion": cached[2],
                "authGeneration": None,
            }
        response = await self._request(
            "POST",
            "/capabilities",
            {"sessionId": session_id, "permissionMode": permission_mode},
        )
        if response.get("ok") is True:
            rows = _capability_rows(response)
            self._capabilities_cache[key] = (
                time.monotonic(),
                rows,
                response.get("authorizationVersion"),
            )
            response["capabilities"] = rows
        return response

    async def preflight(self, session_id: str, permission_mode: str) -> Dict[str, Any]:
        """Fetch only the current authorization snapshot for turn fencing."""

        return await self._request(
            "POST",
            "/preflight",
            {"sessionId": session_id, "permissionMode": permission_mode},
        )

    async def action(
        self,
        session_id: str,
        permission_mode: str,
        action_id: str,
        arguments: Mapping[str, Any],
        idempotency_key: str,
        run_id: str,
    ) -> Dict[str, Any]:
        return await self._request(
            "POST",
            "/actions",
            {
                "sessionId": session_id,
                "permissionMode": permission_mode,
                "actionId": action_id,
                "arguments": dict(arguments),
                "idempotencyKey": idempotency_key,
                "runId": run_id,
            },
        )

    async def operation(self, operation_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/operations/{operation_id}")


def enterprise_action_tools() -> list[dict[str, Any]]:
    """OpenAI tool schemas injected into personal-assistant sessions only."""

    return [
        {
            "type": "function",
            "function": {
                "name": ENTERPRISE_CAPABILITIES_TOOL,
                "description": (
                    "Discover the currently authorized enterprise actions for this signed-in user. "
                    "Call only when the user asks about organization, profile, quota, members, gateway, "
                    "usage, or audit information. The result is a bounded role-scoped action list."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": ENTERPRISE_ACTION_TOOL,
                "description": (
                    "Execute one action from enterprise_capabilities using its exact action id and arguments. "
                    "The Portal rechecks role, tenant and target authorization on every call. "
                    "Never invent an action id, URL, actor/principal field, or identity override. "
                    "Mutating actions may pause for the user's real Desktop confirmation card."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "actionId": {
                            "type": "string",
                            "description": "Exact action id returned by enterprise_capabilities.",
                        },
                        "arguments": {
                            "type": "object",
                            "description": "Arguments matching the selected action's inputSchema.",
                        },
                        "idempotencyKey": {
                            "type": "string",
                            "description": "Optional client idempotency key; generated when omitted.",
                        },
                        "runId": {
                            "type": "string",
                            "description": "Optional turn/run identifier; generated when omitted.",
                        },
                    },
                    "required": ["actionId", "arguments"],
                    "additionalProperties": False,
                },
            },
        },
    ]


def _remembered_capability(
    client: EnterpriseActionBrokerClient,
    session_id: str,
    permission_mode: str,
    action_id: str,
) -> Optional[dict[str, Any]]:
    cached = client._capabilities_cache.get((session_id, permission_mode))
    if not cached or time.monotonic() - cached[0] >= _MAX_CAPABILITY_CACHE_AGE_SECONDS:
        return None
    return next((row for row in cached[1] if row.get("id") == action_id), None)


async def dispatch_enterprise_action(
    name: str,
    arguments: Mapping[str, Any],
    session: Any,
    *,
    clarify_gate: Any = None,
    emit_event: Any = None,
    is_unattended: bool = False,
) -> Optional[str]:
    """Dispatch a personal-assistant enterprise tool.

    ``None`` means the caller does not own an enterprise tool name.  All
    security failures return an explicit model-facing error string.
    """

    if name not in ENTERPRISE_ACTION_TOOL_NAMES:
        return None
    if not _is_personal_assistant_session(session):
        return f"ERROR: {name} 只允许个人助手专用会话调用。"
    if not enterprise_action_broker_available():
        return f"ERROR: {name} 当前仅可在本地 Desktop 企业登录会话中使用。"
    sid = _valid_id(_session_id(session))
    if not sid:
        return f"ERROR: {name} 缺少有效的个人助手会话绑定。"
    mode = str(permission_mode_for_session(session) or "ask").strip().lower()
    if mode not in {"plan", "ask", "auto"}:
        mode = "ask"
    client = getattr(session, "_enterprise_action_broker_client", None)
    if not isinstance(client, EnterpriseActionBrokerClient):
        client = EnterpriseActionBrokerClient()
        setattr(session, "_enterprise_action_broker_client", client)

    if name == ENTERPRISE_CAPABILITIES_TOOL:
        response = await client.capabilities(sid, mode)
        if response.get("ok") is not True:
            return _error_result(name, response)
        _remember_enterprise_context(session, response)
        return _safe_json(
            {
                "status": "ok",
                "capabilities": response.get("capabilities", []),
                "authorizationVersion": response.get("authorizationVersion"),
            }
        )

    action_id = _valid_id(arguments.get("actionId"), max_length=128)
    raw_args = arguments.get("arguments")
    if not action_id:
        return "ERROR: enterprise_action requires a valid actionId from enterprise_capabilities."
    if not isinstance(raw_args, Mapping):
        return "ERROR: enterprise_action requires arguments as a JSON object."
    if len(json.dumps(dict(raw_args), ensure_ascii=False).encode("utf-8")) > _MAX_ARGUMENT_BYTES:
        return "ERROR: enterprise_action arguments are too large."

    # Refresh the role-scoped action snapshot before a plan-mode write. This is
    # lazy (only after an explicit enterprise action request), and makes the
    # local read-only guarantee fail closed before asking the Portal to execute.
    capability = _remembered_capability(client, sid, mode, action_id)
    if mode == "plan":
        if capability is None:
            cap_response = await client.capabilities(sid, mode)
            if cap_response.get("ok") is not True:
                return _error_result(name, cap_response)
            capability = _remembered_capability(client, sid, mode, action_id)
        if capability is None or not _action_effect_is_read(capability.get("effect")):
            return "ERROR: enterprise_action 在 plan 模式只允许服务端声明的只读动作。"

    idempotency_key = _valid_id(arguments.get("idempotencyKey"), max_length=160) or uuid.uuid4().hex
    run_id = _valid_id(arguments.get("runId"), max_length=160) or uuid.uuid4().hex
    response = await client.action(sid, mode, action_id, raw_args, idempotency_key, run_id)
    if response.get("ok") is not True:
        return _error_result(name, response)
    _remember_enterprise_context(session, response)
    status = str(response.get("status") or "").strip().lower()
    if status == "succeeded":
        return _safe_json(
            {
                "status": "succeeded",
                "actionId": action_id,
                "result": response.get("result"),
                "authorizationVersion": response.get("authorizationVersion"),
            }
        )
    if status != "awaiting_confirmation":
        return _safe_json(
            {
                "status": status or "pending",
                "actionId": action_id,
                "operationId": response.get("operationId"),
                "result": response.get("result"),
                "authorizationVersion": response.get("authorizationVersion"),
            }
        )

    operation_id = _valid_id(response.get("operationId"), max_length=160)
    if not operation_id:
        return "ERROR: enterprise_action returned an invalid confirmation operation."
    if not isinstance(response.get("authGeneration"), int) or isinstance(response.get("authGeneration"), bool):
        return "ERROR: enterprise_action confirmation is missing a trusted auth generation."
    proposal = response.get("proposal") if isinstance(response.get("proposal"), Mapping) else {}
    title = str(proposal.get("title") or f"确认企业动作：{action_id}").strip()[:200]
    summary = _proposal_summary(proposal)
    expires_at = proposal.get("expiresAt")
    expires_in: Optional[float] = None
    try:
        if isinstance(expires_at, (int, float)):
            expires_ms = float(expires_at) if float(expires_at) > 10_000_000_000 else float(expires_at) * 1000
            expires_in = max(1.0, expires_ms / 1000.0 - time.time())
        elif expires_at:
            from datetime import datetime

            expires_in = max(1.0, datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")).timestamp() - time.time())
    except Exception:
        expires_in = None
    trusted_context = {
        "operation_id": operation_id,
        "action_id": action_id,
        "session_id": sid,
        "permission_mode": mode,
        "auth_generation": response.get("authGeneration"),
        "enterprise_confirmation": True,
    }
    # Import lazily to keep this module independent from the large tool module
    # during Studio startup and tests.
    from agenticx.cli.agent_tools import _request_action_confirmation

    confirmation = await _request_action_confirmation(
        title,
        summary=summary,
        approve_label="确认执行",
        reject_label="取消",
        expires_in_seconds=expires_in,
        source="enterprise",
        clarify_gate=clarify_gate,
        emit_event=emit_event,
        is_unattended=is_unattended,
        action_confirmation_context=trusted_context,
    )
    if "[ACTION_CONFIRMED]" not in confirmation:
        return confirmation

    # The UI has already performed the only confirmation POST through main IPC
    # before releasing the clarify gate. Read status/result through the broker;
    # this path cannot confirm or fabricate a successful operation.
    operation_response = await client.operation(operation_id)
    if operation_response.get("ok") is not True:
        return _error_result("enterprise_action", operation_response)
    _remember_enterprise_context(session, operation_response)
    return _safe_json(
        {
            "status": operation_response.get("status") or "pending",
            "actionId": action_id,
            "operationId": operation_id,
            "result": operation_response.get("result"),
            "authorizationVersion": operation_response.get("authorizationVersion"),
        }
    )


__all__ = [
    "ENTERPRISE_ACTION_TOOL",
    "ENTERPRISE_ACTION_TOOL_NAMES",
    "ENTERPRISE_CAPABILITIES_TOOL",
    "EnterpriseActionBrokerClient",
    "dispatch_enterprise_action",
    "enterprise_authorization_preflight",
    "enterprise_action_broker_available",
    "enterprise_context_marker_for_persistence",
    "restore_enterprise_context_marker",
    "copy_enterprise_context_marker",
    "session_has_enterprise_context",
    "enterprise_action_tools",
]
