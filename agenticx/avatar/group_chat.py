#!/usr/bin/env python3
"""Group chat management for multi-avatar conversations.

Author: Damon Li
"""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import yaml
from agenticx.utils.agx_home import agx_home, lazy_home_path
from agenticx.utils.atomic_writer import atomic_write_text

def _groups_root() -> Path:
    """``$AGX_HOME/groups``，按调用时的 AGX_HOME 解析。

    原来是模块级常量，import 时就被 Path.home() 定死；测试的 HOME 重定向拦不住，
    数据会写进当前 Ontology 根。见 agenticx/utils/agx_home.py。
    """
    return lazy_home_path(__name__, "GROUPS_ROOT", 'groups')


def __getattr__(name: str):
    # PEP 562：给外部读取用；模块内部一律调 _groups_root()。
    if name == "GROUPS_ROOT":
        return agx_home().joinpath('groups')
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
GROUP_CONFIG_FILE = "group.yaml"
MAX_GROUP_DESCRIPTION_CHARS = 2_000
MAX_GROUP_AVATAR_URL_CHARS = 2_500_000
_GROUP_RASTER_DATA_URL_RE = re.compile(
    r"^data:image/(?:png|jpe?g|webp|gif);base64,(?P<data>[A-Za-z0-9+/]+={0,2})$",
    re.IGNORECASE,
)


class GroupChatReadOnlyError(RuntimeError):
    """Raised when a managed group is edited from the local desktop."""


def _resolve_group_workspace_dir(value: Any, *, default: Path) -> str:
    """Validate and initialize a group workspace without following symlinks."""

    raw_workspace = str(value or "").strip()
    candidate = Path(raw_workspace).expanduser() if raw_workspace else default
    try:
        if candidate.is_symlink():
            raise ValueError("group workspace directory must not be a symlink")
        if candidate.exists():
            import stat

            if not stat.S_ISDIR(candidate.lstat().st_mode):
                raise ValueError("group workspace directory must be a regular directory")
        else:
            candidate.mkdir(parents=True, exist_ok=True)
        if candidate.is_symlink() or not candidate.is_dir():
            raise ValueError("group workspace directory must be a regular directory")
        return str(candidate.resolve())
    except OSError as exc:
        raise ValueError(f"group workspace directory cannot be initialized: {exc}") from exc


def normalize_group_description(value: Any) -> str:
    """Normalize the group introduction while keeping it bounded."""

    description = str(value or "").strip()
    if len(description) > MAX_GROUP_DESCRIPTION_CHARS:
        raise ValueError(
            f"group description exceeds {MAX_GROUP_DESCRIPTION_CHARS} character limit"
        )
    return description


def normalize_group_avatar_url(value: Any) -> str:
    """Accept only inline raster images or ordinary HTTP(S) image URLs.

    The desktop stores uploaded images as data URLs.  Remote HTTP(S) URLs are
    retained for an existing trusted image host, while ``file:``, ``javascript:``
    and all other schemes are rejected before they reach the renderer.
    """

    raw = str(value or "").strip()
    if not raw:
        return ""
    if len(raw) > MAX_GROUP_AVATAR_URL_CHARS:
        raise ValueError(
            f"group avatar URL exceeds {MAX_GROUP_AVATAR_URL_CHARS} character limit"
        )
    if raw.lower().startswith("data:"):
        matched = _GROUP_RASTER_DATA_URL_RE.fullmatch(raw)
        if matched is None:
            raise ValueError("group avatar must be a base64 PNG, JPEG, WebP, or GIF image")
        try:
            decoded = base64.b64decode(matched.group("data"), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("group avatar data URL is invalid base64") from exc
        if not decoded:
            raise ValueError("group avatar image cannot be empty")
        return raw
    parsed = urlparse(raw)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        raise ValueError("group avatar URL must use https/http or an inline image data URL")
    if parsed.username or parsed.password:
        raise ValueError("group avatar URL cannot contain embedded credentials")
    return raw


@dataclass
class GroupChatConfig:
    """Persistent group chat definition."""

    id: str
    name: str
    avatar_ids: List[str] = field(default_factory=list)
    routing: str = "intelligent"  # intelligent | user-directed | meta-routed | round-robin | team
    host_avatar_id: str = ""
    # Introduction and optional custom portrait shown in the group profile.
    description: str = ""
    avatar_url: str = ""
    created_by: str = "manual"
    managed_capability_id: str = ""
    managed_digest: str = ""
    # Stable portable-release identity, separate from this installation id.
    portable_artifact_id: str = ""
    portable_release_version: str = "1.0.0"
    workspace_dir: str = ""
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            k: v
            for k, v in asdict(self).items()
            if (v and not (k == "created_by" and v == "manual"))
            or k in {"id", "name", "avatar_ids", "routing", "host_avatar_id"}
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> GroupChatConfig:
        known = set(cls.__dataclass_fields__)
        filtered = {k: v for k, v in data.items() if k in known}
        avatar_ids = [str(value).strip() for value in filtered.get("avatar_ids", []) if str(value).strip()]
        filtered["avatar_ids"] = avatar_ids
        filtered["description"] = normalize_group_description(filtered.get("description", ""))
        filtered["avatar_url"] = normalize_group_avatar_url(filtered.get("avatar_url", ""))
        # Existing groups predate explicit host selection.  Treat their first
        # real member as host; a coordinator that is not in ``avatar_ids`` must
        # never become a visible participant by implication.
        host_avatar_id = str(filtered.get("host_avatar_id", "") or "").strip()
        filtered["host_avatar_id"] = (
            host_avatar_id if host_avatar_id in avatar_ids else (avatar_ids[0] if avatar_ids else "")
        )
        return cls(**filtered)


class GroupChatRegistry:
    """CRUD operations for group chats with YAML persistence."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root) if root else _groups_root()
        self.root.mkdir(parents=True, exist_ok=True)

    def _group_dir(self, group_id: str) -> Path:
        return self.root / group_id

    def _config_path(self, group_id: str) -> Path:
        return self._group_dir(group_id) / GROUP_CONFIG_FILE

    def _read_config(self, group_id: str) -> Optional[GroupChatConfig]:
        path = self._config_path(group_id)
        if not path.exists():
            return None
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            if not isinstance(raw, dict):
                return None
            raw.setdefault("id", group_id)
            return GroupChatConfig.from_dict(raw)
        except Exception:
            return None

    def _write_config(self, config: GroupChatConfig) -> None:
        group_dir = self._group_dir(config.id)
        group_dir.mkdir(parents=True, exist_ok=True)
        path = self._config_path(config.id)
        atomic_write_text(
            path,
            yaml.dump(config.to_dict(), sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

    def list_groups(self) -> List[GroupChatConfig]:
        groups: List[GroupChatConfig] = []
        if not self.root.exists():
            return groups
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            cfg = self._read_config(child.name)
            if cfg is not None:
                groups.append(cfg)
        return groups

    def get_group(self, group_id: str) -> Optional[GroupChatConfig]:
        return self._read_config(group_id)

    def create_group(
        self,
        name: str,
        avatar_ids: List[str],
        routing: str = "intelligent",
        host_avatar_id: str | None = None,
        description: str = "",
        avatar_url: str = "",
        created_by: str = "manual",
        managed_capability_id: str = "",
        managed_digest: str = "",
        portable_artifact_id: str = "",
        portable_release_version: str = "1.0.0",
        workspace_dir: str = "",
    ) -> GroupChatConfig:
        group_id = uuid.uuid4().hex[:12]
        now = datetime.now(timezone.utc).isoformat()
        normalized_description = normalize_group_description(description)
        normalized_avatar_url = normalize_group_avatar_url(avatar_url)
        resolved_workspace = _resolve_group_workspace_dir(
            workspace_dir,
            default=self._group_dir(group_id) / "workspace",
        )
        normalized_avatar_ids = [str(value).strip() for value in avatar_ids if str(value).strip()]
        normalized_host_id = str(host_avatar_id or "").strip()
        if normalized_host_id not in normalized_avatar_ids:
            normalized_host_id = normalized_avatar_ids[0] if normalized_avatar_ids else ""
        config = GroupChatConfig(
            id=group_id,
            name=name,
            avatar_ids=normalized_avatar_ids,
            routing=routing,
            host_avatar_id=normalized_host_id,
            description=normalized_description,
            avatar_url=normalized_avatar_url,
            created_by=str(created_by or "manual").strip() or "manual",
            managed_capability_id=str(managed_capability_id or "").strip(),
            managed_digest=str(managed_digest or "").strip().lower(),
            portable_artifact_id=str(portable_artifact_id or "").strip() or str(uuid.uuid4()),
            portable_release_version=str(portable_release_version or "1.0.0").strip() or "1.0.0",
            workspace_dir=resolved_workspace,
            created_at=now,
            updated_at=now,
        )
        try:
            self._write_config(config)
            from agenticx.workspace.loader import ensure_group_workspace

            ensure_group_workspace(
                config.id,
                group_name=config.name,
                workspace_dir=config.workspace_dir,
            )
        except Exception:
            # Keep creation atomic: callers must never observe a group.yaml
            # without its matching workspace (or vice versa).
            import shutil

            shutil.rmtree(self._group_dir(group_id), ignore_errors=True)
            raise
        return config

    def update_group(self, group_id: str, patch: Dict[str, Any]) -> Optional[GroupChatConfig]:
        config = self._read_config(group_id)
        if config is None:
            return None
        if config.created_by == "enterprise_managed":
            raise GroupChatReadOnlyError("enterprise-managed group is read-only")
        immutable = {
            "id",
            "created_at",
            "created_by",
            "managed_capability_id",
            "managed_digest",
            "portable_artifact_id",
            "portable_release_version",
        }
        for key, value in patch.items():
            if key in immutable:
                continue
            if key == "description":
                config.description = normalize_group_description(value)
                continue
            if key == "avatar_url":
                config.avatar_url = normalize_group_avatar_url(value)
                continue
            if key == "workspace_dir":
                raw_workspace = str(value or "").strip()
                if not raw_workspace:
                    raise ValueError("group workspace directory cannot be empty")
                from agenticx.workspace.loader import ensure_group_workspace

                config.workspace_dir = str(
                    ensure_group_workspace(
                        config.id,
                        group_name=config.name,
                        workspace_dir=_resolve_group_workspace_dir(
                            raw_workspace,
                            default=self._group_dir(config.id) / "workspace",
                        ),
                    )
                )
                continue
            if hasattr(config, key):
                setattr(config, key, value)
        config.avatar_ids = [str(value).strip() for value in config.avatar_ids if str(value).strip()]
        config.host_avatar_id = str(config.host_avatar_id or "").strip()
        if config.host_avatar_id not in config.avatar_ids:
            config.host_avatar_id = config.avatar_ids[0] if config.avatar_ids else ""
        config.updated_at = datetime.now(timezone.utc).isoformat()
        self._write_config(config)
        return config

    def ensure_portable_identity(self, group_id: str) -> Optional[GroupChatConfig]:
        """Persist a stable portable identity for an existing expert team."""

        config = self._read_config(group_id)
        if config is None:
            return None
        changed = False
        try:
            uuid.UUID(str(config.portable_artifact_id))
        except (ValueError, TypeError, AttributeError):
            config.portable_artifact_id = str(uuid.uuid4())
            changed = True
        if not str(config.portable_release_version or "").strip():
            config.portable_release_version = "1.0.0"
            changed = True
        if changed:
            config.updated_at = datetime.now(timezone.utc).isoformat()
            self._write_config(config)
        return config

    def set_portable_release_version(
        self,
        group_id: str,
        release_version: str,
    ) -> Optional[GroupChatConfig]:
        """Record the latest release version after a successful publication."""

        config = self.ensure_portable_identity(group_id)
        if config is None:
            return None
        config.portable_release_version = str(release_version or "").strip()
        config.updated_at = datetime.now(timezone.utc).isoformat()
        self._write_config(config)
        return config

    def delete_group(self, group_id: str) -> bool:
        import shutil
        group_dir = self._group_dir(group_id)
        if not group_dir.exists():
            return False
        try:
            shutil.rmtree(group_dir)
        except OSError:
            return False
        return True
