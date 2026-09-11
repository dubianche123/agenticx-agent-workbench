#!/usr/bin/env python3
"""附件自动路由 · 运行时判定。

策略由企业后台在 ``/api/desktop/bootstrap`` 下发，Desktop 主进程写进全局配置的
``enterprise.attachment_routing``（与 PAT、portal origin 同一处）。规则的唯一出处在
服务端，这里只负责执行——和 :mod:`agenticx.studio.web_search.enterprise` 同样的形态。

为什么运行时也要判一遍，而不是只在 Electron 里做：Desktop 的聊天框不是唯一入口。
CLI、定时任务、子智能体、分身委派都不经过那段 UI 代码，只在前端拦一道就是个洞——
而这条策略拦的是"文档内容会不会离开私有部署"，漏一条路径就等于没做。

判定必须在调用模型**之前**发生。Office 文档最终会被抽成文本进上下文，先解析后决定
的话，文本已经发给公网模型了才想起来要切。
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

logger = logging.getLogger(__name__)

DEFAULT_MAX_RENDERED_PAGES = 20

# These values bound the only model metadata that is persisted into session
# summaries and sent back to Desktop.  Model ids can contain vendor prefixes
# and slashes, but none of these fields needs to carry arbitrary prose (or a
# secret).  Rejecting an overlong value is safer than truncating an address:
# truncation could point at a different model while still looking valid.
MAX_ROUTING_PROVIDER_CHARS = 128
MAX_ROUTING_MODEL_CHARS = 256
MAX_ROUTING_ID_CHARS = 256
MAX_ROUTING_LABEL_CHARS = 256


@dataclass(frozen=True)
class RoutingModelRef:
    """三种寻址方式一起下发，因为两端寻址不一样。

    portal 直接用 ``provider`` + ``model``；Desktop 把企业下发的模型全部挂在**单一**
    ``enterprise`` provider 下、拿 ``id``（``<provider>/<model>``）当模型名——见
    main.ts 的 applyEnterpriseProvider。只带 provider/model 的话客户端就得自己拼 id，
    拼错就是切到一个不存在的模型。
    """

    provider: str
    model: str
    label: str
    id: str = ""


@dataclass(frozen=True)
class AttachmentRoutingPolicy:
    enabled: bool = False
    allow_public_override: bool = False
    document_target: Optional[RoutingModelRef] = None
    document_extensions: tuple[str, ...] = ()
    image_strategy: str = "vision-fallback"
    vision_fallback: Optional[RoutingModelRef] = None
    max_rendered_pages: int = DEFAULT_MAX_RENDERED_PAGES


ROUTING_OFF = AttachmentRoutingPolicy()


def _model_ref(raw: Any) -> Optional[RoutingModelRef]:
    if not isinstance(raw, dict):
        return None

    def bounded_text(key: str, limit: int) -> Optional[str]:
        value = raw.get(key)
        if not isinstance(value, str):
            return None
        value = value.strip()
        if not value or len(value) > limit:
            return None
        return value

    provider = bounded_text("provider", MAX_ROUTING_PROVIDER_CHARS)
    model = bounded_text("model", MAX_ROUTING_MODEL_CHARS)
    if provider is None or model is None:
        return None

    raw_label = raw.get("label")
    if raw_label is None or (isinstance(raw_label, str) and not raw_label.strip()):
        label = f"{provider}/{model}"
    else:
        label = bounded_text("label", MAX_ROUTING_LABEL_CHARS)
        if label is None:
            return None

    raw_id = raw.get("id")
    if raw_id is None or (isinstance(raw_id, str) and not raw_id.strip()):
        ref_id = f"{provider}/{model}"
    else:
        ref_id = bounded_text("id", MAX_ROUTING_ID_CHARS)
        if ref_id is None:
            return None
    if len(label) > MAX_ROUTING_LABEL_CHARS or len(ref_id) > MAX_ROUTING_ID_CHARS:
        return None
    return RoutingModelRef(provider=provider, model=model, label=label, id=ref_id)


def _normalize_model_ref(raw: Any) -> Optional[RoutingModelRef]:
    """Validate both wire dictionaries and in-memory refs at one boundary."""
    if isinstance(raw, RoutingModelRef):
        raw = {
            "provider": raw.provider,
            "model": raw.model,
            "label": raw.label,
            "id": raw.id,
        }
    return _model_ref(raw)


def read_policy(raw: Any = None) -> AttachmentRoutingPolicy:
    """读下发快照。**默认关**，只有明确认得的内容才启用。

    取不到目标模型时整条关掉，而不是让"检测到文档但无处可切"发生——那会把附件落回
    公网模型，而用户已经被告知它留在私有部署里。
    """
    if raw is None:
        raw = _load_from_global_config()
    if not isinstance(raw, dict) or raw.get("enabled") is not True:
        return ROUTING_OFF
    target = _model_ref(raw.get("documentTarget") or raw.get("document_target"))
    if target is None:
        return ROUTING_OFF
    raw_exts = raw.get("documentExtensions") or raw.get("document_extensions") or []
    extensions = tuple(
        ext
        for ext in (
            str(item or "").strip().lower()
            for item in raw_exts
            if isinstance(item, str)
        )
        if ext.startswith(".") and len(ext) > 1
    )
    if not extensions:
        return ROUTING_OFF
    try:
        pages = int(raw.get("maxRenderedPages") or raw.get("max_rendered_pages") or 0)
    except (TypeError, ValueError):
        pages = 0
    strategy = str(raw.get("imageStrategy") or raw.get("image_strategy") or "").strip()
    return AttachmentRoutingPolicy(
        enabled=True,
        allow_public_override=(
            raw.get("allowPublicOverride") is True
            or raw.get("allow_public_override") is True
        ),
        document_target=target,
        document_extensions=extensions,
        image_strategy="sticky" if strategy == "sticky" else "vision-fallback",
        vision_fallback=_model_ref(raw.get("visionFallback") or raw.get("vision_fallback")),
        max_rendered_pages=pages if pages >= 1 else DEFAULT_MAX_RENDERED_PAGES,
    )


def _load_from_global_config() -> Dict[str, Any]:
    """只读全局用户配置。

    和企业 PAT / portal origin 同一条纪律：**不走 ``ConfigManager.get_value()``**，
    否则一个项目级 config 就能覆盖企业下发的策略，本地放一份
    ``{"enabled": false}`` 就能把附件送回公网模型。
    """
    try:
        from agenticx.cli.config_manager import ConfigManager

        global_config = ConfigManager._load_yaml(ConfigManager.GLOBAL_CONFIG_PATH)
    except Exception:
        # 读不到全局配置和"没配过"在这里是同一种结果（策略关闭），但成因完全不同。
        # 对一个 containment 特性来说，静默地退化成"关闭"是最不该发生的事——至少要在
        # 正常日志级别留下痕迹，否则运维只会看到"路由怎么没生效"。
        logger.warning("attachment routing: global config unreadable", exc_info=True)
        return {}
    enterprise = global_config.get("enterprise")
    if not isinstance(enterprise, dict):
        return {}
    raw = enterprise.get("attachment_routing") or enterprise.get("attachmentRouting")
    return raw if isinstance(raw, dict) else {}


def attachment_extension_of(name: str) -> str:
    """Return the real extension from a filename or a workspace reference.

    Desktop context-file keys can append a reference after the filename, such
    as ``report.pdf:3-5``, ``book.xlsx#Sheet1!A1`` or
    ``page.html:snippet-*``.  ``os.path.splitext`` on the complete key would
    include that reference in the extension and skip the containment lock.
    Delimiters after the last dot are treated as reference metadata: a false
    positive keeps the document private, while a false negative could send it
    to a public model.
    """
    raw = str(name or "").strip().lower().replace("\\", "/")
    base = os.path.basename(raw)
    dot = base.rfind(".")
    if dot <= 0 or dot == len(base) - 1:
        return ""

    reference_positions = [
        index
        for delimiter in (":", "#")
        for index in (base.find(delimiter, dot + 1),)
        if index >= 0
    ]
    if reference_positions:
        base = base[: min(reference_positions)]
    _, extension = os.path.splitext(base)
    return extension if len(extension) > 1 else ""


# Keep the private alias for callers/tests that used the original helper while
# the public name documents the cross-runtime contract.
_extension_of = attachment_extension_of


def has_routed_document(
    filenames: Iterable[str], policy: AttachmentRoutingPolicy
) -> bool:
    """这批文件里有没有会触发锁定的文档。只看扩展名——判定发生在解析之前。"""
    if not policy.enabled or policy.document_target is None:
        return False
    wanted = set(policy.document_extensions)
    return any(attachment_extension_of(name) in wanted for name in filenames)


@dataclass(frozen=True)
class RoutingDecision:
    """``action`` 取 ``"none"`` 或 ``"lock"``。"""

    action: str
    target: Optional[RoutingModelRef] = None
    announce: bool = False


def decide(
    *,
    policy: AttachmentRoutingPolicy,
    filenames: Sequence[str],
    locked_target: Optional[RoutingModelRef],
) -> RoutingDecision:
    """决定这一轮要不要锁模型。

    sticky 的含义：**一旦锁定，本会话不再解锁**。理由不止是"别泄露"——文档内容已经
    进了这段对话的上下文（PDF 是页图，Office 是文本），换回纯文本云端模型要么看不见
    它，要么得把它抽成文本再发出去。所以后续每一轮都返回 lock，只是不再 announce。
    """
    if locked_target is not None:
        # A sticky lock remains authoritative even when the policy is currently
        # disabled or malformed (read_policy represents both as ROUTING_OFF).
        # When a new, valid target is actually delivered, follow that target;
        # otherwise preserve the last known private address rather than falling
        # through to the caller-selected/public model.
        target = (
            policy.document_target
            if policy.enabled and policy.document_target
            else locked_target
        )
        return RoutingDecision(action="lock", target=target, announce=False)
    if not policy.enabled or policy.document_target is None:
        return RoutingDecision(action="none")
    if not has_routed_document(filenames, policy):
        return RoutingDecision(action="none")
    return RoutingDecision(action="lock", target=policy.document_target, announce=True)


#: Desktop 企业登录后所有模型都挂在这个 provider 下。
ENTERPRISE_PROVIDER = "enterprise"


def address_for_session(session: Any, target: RoutingModelRef) -> tuple[str, str]:
    """把目标模型翻译成这个会话能用的 (provider, model)。

    企业托管的 Desktop 会话只有一个 ``enterprise`` provider，模型名就是全 id；直连
    配置的会话则按 provider/model 寻址。判错的后果是切到一个不存在的模型，所以看当前
    会话实际在用哪种，而不是猜。
    """
    if str(getattr(session, "provider_name", "") or "").strip() == ENTERPRISE_PROVIDER:
        return ENTERPRISE_PROVIDER, (target.id or f"{target.provider}/{target.model}")
    return target.provider, target.model


LOCK_ATTR = "_attachment_routing_lock"
_MISSING_LOCK = object()
_INVALID_LOCK = object()


def session_locked_target(session: Any) -> Optional[RoutingModelRef]:
    raw = getattr(session, LOCK_ATTR, _MISSING_LOCK)
    if raw is _MISSING_LOCK or raw is _INVALID_LOCK or raw is None:
        return None
    return _normalize_model_ref(raw)


def session_has_attachment_routing_lock(session: Any) -> bool:
    """Whether this session crossed the attachment boundary.

    This intentionally differs from :func:`session_locked_target`: an invalid
    persisted marker is still a lock marker and must fail closed because its
    private destination cannot be reconstructed safely.
    """
    raw = getattr(session, LOCK_ATTR, _MISSING_LOCK)
    return raw is not _MISSING_LOCK and raw is not None


def remember_lock(session: Any, target: RoutingModelRef) -> bool:
    normalized = _normalize_model_ref(target)
    try:
        # Preserve an invalid marker so route_turn can stop rather than letting
        # an untrusted/overlong target silently become an unlocked session.
        setattr(session, LOCK_ATTR, normalized if normalized is not None else _INVALID_LOCK)
    except Exception:
        logger.error("attachment routing lock could not be persisted", exc_info=True)
        return False
    return normalized is not None


def lock_snapshot(session: Any) -> Optional[Dict[str, str]]:
    """Return the small JSON-safe lock marker persisted with session metadata."""
    target = session_locked_target(session)
    return lock_snapshot_from_raw(target)


def lock_snapshot_from_raw(raw: Any) -> Optional[Dict[str, str]]:
    """Normalize an untrusted persisted lock into the public JSON shape.

    Session metadata can come from SQLite/files written by older clients, so
    the session list/detail APIs must not echo the raw object.  Keep the
    response deliberately small and require both addressing fields before a
    lock is considered usable.
    """
    target = _normalize_model_ref(raw)
    if target is None:
        return None
    return {
        "id": target.id,
        "provider": target.provider,
        "model": target.model,
        "label": target.label,
    }


def restore_lock(session: Any, raw: Any) -> Optional[RoutingModelRef]:
    """Restore a persisted lock marker without consulting the current policy.

    The next turn still resolves the *current* administrator-selected target in
    :func:`decide`; this marker only preserves the fact that the session already
    crossed the document boundary and therefore remains sticky after restart.
    """
    if raw is None:
        try:
            delattr(session, LOCK_ATTR)
        except AttributeError:
            pass
        return None
    target = _normalize_model_ref(raw)
    if target is not None:
        remember_lock(session, target)
    else:
        # Keep the fact that this session has crossed the boundary, while the
        # snapshot/API remains fail-closed and emits no untrusted metadata.
        try:
            setattr(session, LOCK_ATTR, _INVALID_LOCK)
        except Exception:
            pass
    return target


class AttachmentRoutingUnavailable(RuntimeError):
    """策略本该生效，但没能应用上。调用方必须中止本轮，不能回退到公网模型。"""


def lock_reason(target: RoutingModelRef) -> str:
    return (
        f"本会话包含文档附件，已锁定到「{target.label}」（私有部署）。"
        "文档内容不会离开这台部署。"
    )


def apply_to_session(
    session: Any,
    *,
    filenames: Sequence[str],
    policy: Optional[AttachmentRoutingPolicy] = None,
) -> Optional[RoutingDecision]:
    """判定并把结果落到 session 上。

    必须在解析 LLM **之前**调用：下游是拿 ``session.provider_name`` /
    ``session.model_name`` 去 ``ProviderResolver.resolve`` 的，晚一步就来不及了。

    Args:
        filenames: 本轮附件的名字或路径。只看扩展名，不看内容——判定发生在解析之前。
        policy: 覆盖下发策略，仅供测试。

    Returns:
        锁定时返回决策（``announce`` 为真表示这是本会话第一次锁定，该告诉用户），
        不需要动模型时返回 ``None``。
    """
    locked_target = session_locked_target(session)
    if session_has_attachment_routing_lock(session) and locked_target is None:
        raise AttachmentRoutingUnavailable(
            "persisted attachment routing lock is invalid or unavailable"
        )
    if policy is None:
        try:
            resolved = read_policy()
        except Exception:
            if locked_target is None:
                raise
            # A valid sticky lock remains private even when the latest policy
            # snapshot cannot be read.
            logger.warning(
                "attachment routing policy unavailable; preserving session lock",
                exc_info=True,
            )
            resolved = ROUTING_OFF
    else:
        resolved = policy
    decision = decide(
        policy=resolved,
        filenames=list(filenames),
        locked_target=locked_target,
    )
    target = decision.target
    if decision.action != "lock" or target is None:
        return None
    provider, model = address_for_session(session, target)
    switched = (
        str(getattr(session, "provider_name", "") or "") != provider
        or str(getattr(session, "model_name", "") or "") != model
    )
    session.provider_name = provider
    session.model_name = model
    if switched:
        # declared_context_window 是跟着客户端选的那个模型一起传上来的。模型被我们
        # 换掉之后它就是错的，留着会让运行时按错误的窗口做预算，清掉以回落到按模型
        # 名推断。
        try:
            session.declared_context_window = None
        except Exception:
            pass
    normalized_target = _normalize_model_ref(target)
    if (
        normalized_target is None
        or not remember_lock(session, target)
        or session_locked_target(session) != normalized_target
    ):
        raise AttachmentRoutingUnavailable(
            "attachment routing lock could not be persisted safely"
        )
    return decision


def route_turn(
    session: Any,
    *,
    filenames: Sequence[str],
    policy: Optional[AttachmentRoutingPolicy] = None,
    public_override: bool = False,
) -> Optional[RoutingDecision]:
    """聊天回合的入口：读策略、应用、决定失败时能不能放行。

    读策略失败和应用策略失败的含义完全不同，所以分开兜底：

    * **读不到策略** == 没配过 == 保持原样。绝大多数装机就是这种，拦掉等于把没接企业
      的用户全挡在门外。记一条 warning 让它可观测就够了。
    * **读到了、本轮确实有文档（或会话已经锁定）、但应用失败** == containment 失败。
      继续往下走，文档就会发给调用方指定的那个公网模型——正是这个特性存在的理由。
      抛 :class:`AttachmentRoutingUnavailable`，由调用方转成对用户可见的失败。

    已锁定的会话尤其不能放行：调用方通常刚把客户端传来的 provider/model 落到 session
    上，应用失败就等于回到客户端选的模型，而这段历史里已经有文档内容了。

    Raises:
        AttachmentRoutingUnavailable: 必须中止本轮。
    """
    names = list(filenames)
    lock_present = session_has_attachment_routing_lock(session)
    locked_target = session_locked_target(session)
    if lock_present and locked_target is None:
        raise AttachmentRoutingUnavailable(
            "persisted attachment routing lock is invalid or unavailable"
        )
    if policy is None:
        try:
            policy = read_policy()
        except Exception:
            logger.warning(
                "attachment routing unavailable; this turn will not be routed", exc_info=True
            )
            # A locked session cannot be made public merely because its current
            # policy snapshot could not be read.  ROUTING_OFF still lets
            # apply_to_session preserve the existing private target.
            if not lock_present:
                return None
            policy = ROUTING_OFF
    # 公网例外只适用于“尚未锁定、且本轮刚命中文档”的边界选择。已经锁定的会话里
    # 文档内容已经进入私有模型上下文，不能靠后续请求里的一个字段把 sticky 锁解开。
    if (
        public_override
        and policy.allow_public_override
        and session_locked_target(session) is None
        and has_routed_document(names, policy)
    ):
        return None
    try:
        return apply_to_session(session, filenames=names, policy=policy)
    except Exception as exc:
        must_contain = bool(lock_present or has_routed_document(names, policy))
        # 只记数量不记文件名：日志的落点和模型不是一回事。
        logger.warning(
            "attachment routing failed (attachments=%d, containment_required=%s)",
            len(names),
            must_contain,
            exc_info=True,
        )
        if must_contain:
            raise AttachmentRoutingUnavailable(
                "attachment routing failed while containment was required"
            ) from exc
        return None
