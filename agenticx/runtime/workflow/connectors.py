"""Service-owned semantic connector/action catalog for Workflow definitions.

The catalog is intentionally about business intent.  It contains no tokens,
credential references, executable paths or shell/API command templates.  A
managed executor may use these entries to decide how to perform a ready node,
but the editable Workflow never contains that implementation detail.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Dict, Mapping, Optional, Tuple


def _freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


@dataclass(frozen=True)
class ConnectorAction:
    id: str
    label: str
    description: str
    risk: str
    input_schema: Mapping[str, Any]

    def __post_init__(self) -> None:
        if self.risk not in {"read", "write", "external_write"}:
            raise ValueError(f"unsupported connector action risk: {self.risk}")
        object.__setattr__(self, "input_schema", _freeze(dict(self.input_schema)))

    @property
    def action_id(self) -> str:
        """Wire-contract alias; the persisted semantic identifier is ``id``."""

        return self.id

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action_id": self.id,
            "label": self.label,
            "description": self.description,
            "risk": self.risk,
            "input_schema": _thaw(self.input_schema),
        }


@dataclass(frozen=True)
class ConnectorCatalogEntry:
    id: str
    label: str
    description: str
    actions: Tuple[ConnectorAction, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "actions", tuple(self.actions))

    @property
    def connector_id(self) -> str:
        """Wire-contract alias; the persisted catalog identifier is ``id``."""

        return self.id

    def to_dict(self) -> Dict[str, Any]:
        return {
            "connector_id": self.id,
            "label": self.label,
            "description": self.description,
            "actions": [action.to_dict() for action in self.actions],
        }


def _schema(properties: Mapping[str, Mapping[str, Any]], required: Tuple[str, ...] = ()) -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {key: dict(value) for key, value in properties.items()},
        "required": list(required),
        "additionalProperties": False,
    }


def _action(
    action_id: str,
    label: str,
    description: str,
    risk: str,
    properties: Mapping[str, Mapping[str, Any]],
    required: Tuple[str, ...] = (),
) -> ConnectorAction:
    return ConnectorAction(
        id=action_id,
        label=label,
        description=description,
        risk=risk,
        input_schema=_schema(properties, required),
    )


_TEXT = {"type": "string", "maxLength": 4096}
_SHORT_TEXT = {"type": "string", "maxLength": 512}
_LIMIT = {"type": "integer", "minimum": 1, "maximum": 100}


# Construct once and expose only immutable entries.  Keep the IDs stable: they
# are persisted in Workflow snapshots and therefore become part of a digest.
_CATALOG: Tuple[ConnectorCatalogEntry, ...] = (
    ConnectorCatalogEntry(
        id="feishu",
        label="飞书",
        description="飞书文档与消息中的业务协作动作。",
        actions=(
            _action("read_document", "读取文档", "读取指定文档的业务内容。", "read", {"document_ref": _TEXT}, ("document_ref",)),
            _action("propose_document_change", "提议文档变更", "生成待审阅的文档变更提案。", "write", {"document_ref": _TEXT, "change_summary": _TEXT}, ("document_ref", "change_summary")),
            _action("apply_document_change", "应用文档变更", "应用已经获准的文档变更。", "external_write", {"document_ref": _TEXT, "change_ref": _TEXT}, ("document_ref", "change_ref")),
            _action("lookup_message", "查找消息", "按会话或关键词查找业务消息。", "read", {"conversation_ref": _TEXT, "query": _TEXT}, ("query",)),
            _action("send_message", "发送消息", "向指定会话发送业务消息。", "external_write", {"conversation_ref": _TEXT, "message": _TEXT}, ("conversation_ref", "message")),
        ),
    ),
    ConnectorCatalogEntry(
        id="wecom",
        label="企业微信",
        description="企业微信消息与协作中的业务动作。",
        actions=(
            _action("lookup_message", "查找消息", "按会话或关键词查找企业微信消息。", "read", {"conversation_ref": _TEXT, "query": _TEXT}, ("query",)),
            _action("send_message", "发送消息", "向指定企业微信会话发送业务消息。", "external_write", {"conversation_ref": _TEXT, "message": _TEXT}, ("conversation_ref", "message")),
        ),
    ),
    ConnectorCatalogEntry(
        id="github",
        label="GitHub",
        description="代码仓库工作项中的语义读取与更新。",
        actions=(
            _action("read_work_item", "读取仓库工作项", "读取仓库 issue 或 pull request 的业务状态。", "read", {"repository_ref": _TEXT, "work_item_ref": _TEXT}, ("repository_ref", "work_item_ref")),
            _action("update_work_item", "更新仓库工作项", "更新仓库 issue 或 pull request 的业务字段。", "external_write", {"repository_ref": _TEXT, "work_item_ref": _TEXT, "change_summary": _TEXT}, ("repository_ref", "work_item_ref", "change_summary")),
        ),
    ),
    ConnectorCatalogEntry(
        id="tapd",
        label="TAPD",
        description="项目管理工作项中的语义读取与更新。",
        actions=(
            _action("read_work_item", "读取项目工作项", "读取 TAPD 工作项的业务状态。", "read", {"project_ref": _TEXT, "work_item_ref": _TEXT}, ("project_ref", "work_item_ref")),
            _action("update_work_item", "更新项目工作项", "更新 TAPD 工作项的业务字段。", "external_write", {"project_ref": _TEXT, "work_item_ref": _TEXT, "change_summary": _TEXT}, ("project_ref", "work_item_ref", "change_summary")),
        ),
    ),
    ConnectorCatalogEntry(
        id="tencent-meeting",
        label="腾讯会议",
        description="会议查询与排期中的业务动作。",
        actions=(
            _action("list_meetings", "列出会议", "查询与工作相关的会议。", "read", {"query": _TEXT, "limit": _LIMIT}),
            _action("schedule_meeting", "安排会议", "创建一次会议安排提案或会议。", "external_write", {"subject": _SHORT_TEXT, "start_at": _TEXT, "end_at": _TEXT, "participant_refs": {"type": "array", "items": _SHORT_TEXT, "maxItems": 100}}, ("subject", "start_at", "end_at")),
        ),
    ),
    ConnectorCatalogEntry(
        id="qqmail",
        label="Agent Mail",
        description="邮件搜索、起草与发送中的业务动作。",
        actions=(
            _action("search_mail", "搜索邮件", "按关键词搜索邮件。", "read", {"query": _TEXT}, ("query",)),
            _action("draft_mail", "起草邮件（暂不可用）", "当前没有已验证的纯草稿 API；受管执行会明确拒绝，避免把立即发送命令误当成草稿。", "write", {"to": {"type": "array", "items": _SHORT_TEXT, "maxItems": 100}, "subject": _SHORT_TEXT, "body": _TEXT}, ("to", "subject", "body")),
            _action("send_mail", "发送邮件", "发送已经准备好的邮件。", "external_write", {"draft_ref": _TEXT}, ("draft_ref",)),
        ),
    ),
)


def get_connector_catalog() -> Tuple[ConnectorCatalogEntry, ...]:
    """Return all six service entries, independent of connection state."""

    return _CATALOG


def resolve_connector_action(
    connector_id: str,
    action_id: str,
    *,
    catalog: Optional[Any] = None,
) -> Optional[ConnectorAction]:
    """Resolve a catalog action, returning ``None`` for unknown pairs."""

    entries = get_connector_catalog() if catalog is None else catalog
    if isinstance(entries, Mapping):
        entry = entries.get(connector_id)
        if entry is None:
            return None
        actions = entry.get("actions") if isinstance(entry, Mapping) else getattr(entry, "actions", ())
    else:
        actions = ()
        for entry in entries or ():
            entry_key = (
                entry.get("connector_id", entry.get("id"))
                if isinstance(entry, Mapping)
                else getattr(entry, "connector_id", getattr(entry, "id", None))
            )
            if entry_key == connector_id:
                actions = entry.get("actions", ()) if isinstance(entry, Mapping) else getattr(entry, "actions", ())
                break
    if isinstance(actions, Mapping):
        action = actions.get(action_id)
        if action is None:
            return None
        return action if isinstance(action, ConnectorAction) else None
    for action in actions or ():
        candidate = (
            action.get("action_id", action.get("id"))
            if isinstance(action, Mapping)
            else getattr(action, "action_id", getattr(action, "id", None))
        )
        if candidate == action_id:
            return action if isinstance(action, ConnectorAction) else None
    return None


def connector_catalog_to_dict(catalog: Optional[Any] = None) -> list[Dict[str, Any]]:
    entries = get_connector_catalog() if catalog is None else catalog
    result: list[Dict[str, Any]] = []
    for entry in entries:
        if isinstance(entry, ConnectorCatalogEntry):
            result.append(entry.to_dict())
        elif isinstance(entry, Mapping):
            result.append(_thaw(entry))
        else:
            result.append(
                ConnectorCatalogEntry(
                    id=str(getattr(entry, "id")),
                    label=str(getattr(entry, "label", "")),
                    description=str(getattr(entry, "description", "")),
                    actions=tuple(getattr(entry, "actions", ())),
                ).to_dict()
            )
    return result


__all__ = [
    "ConnectorAction",
    "ConnectorCatalogEntry",
    "connector_catalog_to_dict",
    "get_connector_catalog",
    "resolve_connector_action",
]
