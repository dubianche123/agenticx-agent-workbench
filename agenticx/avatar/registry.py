#!/usr/bin/env python3
"""Avatar registry with YAML-backed persistence.

Each avatar is stored as $AGX_HOME/avatars/<id>/avatar.yaml
with its own workspace directory for isolated identity and memory.

Author: Damon Li
"""

from __future__ import annotations

import os
import shutil
import stat
import tempfile
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import yaml
from agenticx.utils.agx_home import agx_home, lazy_home_path
from agenticx.avatar.portrait import (
    generate_avatar_portrait_url,
    needs_portrait_refresh,
    PORTRAIT_STYLE,
)
from agenticx.utils.atomic_writer import atomic_write_text
from agenticx.runtime.permission_mode import (
    DEFAULT_PERMISSION_MODE,
    normalize_permission_mode,
)

def _avatars_root() -> Path:
    """``$AGX_HOME/avatars``，按调用时的 AGX_HOME 解析。

    原来是模块级常量，import 时就被 Path.home() 定死；测试的 HOME 重定向拦不住，
    数据会写进当前 Ontology 根。见 agenticx/utils/agx_home.py。
    """
    return lazy_home_path(__name__, "AVATARS_ROOT", 'avatars')


def __getattr__(name: str):
    # PEP 562：给外部读取用；模块内部一律调 _avatars_root()。
    if name == "AVATARS_ROOT":
        return agx_home().joinpath('avatars')
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
AVATAR_CONFIG_FILE = "avatar.yaml"

# Must stay aligned with desktop/src/utils/avatar-color.ts AVATAR_PALETTE.
AVATAR_COLOR_KEYS = frozenset({"blue", "white", "black"})

# These are the only workspace documents that the expert settings surface may
# read or write.  Keeping the allow-list here (rather than accepting a path
# from a request) makes the registry the security boundary shared by HTTP and
# Desktop IPC callers.
CORE_MEMORY_FILENAMES = ("IDENTITY.md", "SOUL.md", "MEMORY.md")
CORE_MEMORY_MAX_BYTES = 64 * 1024
_CORE_MEMORY_LOCK = threading.RLock()


class AvatarCoreMemoryError(ValueError):
    """Raised when an expert core-memory workspace is missing or unsafe."""


class AvatarReadOnlyError(PermissionError):
    """Raised when a server-managed expert is edited outside reconciliation."""


def normalize_avatar_color(value: Any) -> str:
    """Return a valid expert background color, defaulting to blue."""
    key = str(value or "").strip().lower()
    return key if key in AVATAR_COLOR_KEYS else "blue"


AVATAR_TAGS_MAX_COUNT = 8
AVATAR_TAG_MAX_LEN = 24


def normalize_avatar_tags(value: Any) -> List[str]:
    """Sanitize gallery-card skill tags: trim, dedupe, cap count/length."""
    if not isinstance(value, list):
        return []
    out: List[str] = []
    seen = set()
    for item in value:
        tag = str(item or "").strip()[:AVATAR_TAG_MAX_LEN]
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
        if len(out) >= AVATAR_TAGS_MAX_COUNT:
            break
    return out

IDENTITY_TEMPLATE = """# IDENTITY.md - {name}

- Name: {name}
- Role: {role}
- Vibe: Pragmatic, structured, concise, execution-first
- Language: Chinese by default
"""

MEMORY_TEMPLATE = """# MEMORY.md - Long-Term Anchors

## 用户偏好（本主体理解）
- （本分身所理解的用户偏好，可由 agent 动态更新或用户手动编辑）

## Agent Notes
- Avatar created: {created_at}
- Keep this file short and curated.
"""


@dataclass
class AvatarConfig:
    """Persistent avatar definition."""

    id: str
    name: str
    role: str = ""
    avatar_url: str = ""
    portrait_style: str = ""
    system_prompt: str = ""
    # Short blurb shown on the gallery card, distinct from system_prompt (behavior rules).
    description: str = ""
    # Skill tags shown as chips on the gallery card, e.g. ["PyTorch优化", "GPU性能调优"].
    tags: List[str] = field(default_factory=list)
    workspace_dir: str = ""
    created_by: str = "manual"
    # Per-expert default for new sessions and group member runs.  ``ask`` is
    # deliberately the fail-closed default for malformed/missing values.
    default_permission_mode: str = DEFAULT_PERMISSION_MODE
    default_provider: str = ""
    default_model: str = ""
    pinned: bool = False
    # Expert background color from the monochrome AVATAR_PALETTE.
    color: str = "blue"
    # User-defined display order (lower = earlier). 0 = unset/created order.
    sort_order: int = 0
    tools_enabled: Dict[str, bool] = field(default_factory=dict)
    skills_enabled: Optional[Dict[str, bool]] = None
    # None = mount global brains only; "*" = all visible brains; list = explicit ids
    brains_enabled: Optional[Any] = None
    # Set only by the authenticated enterprise managed-package reconciler.
    # These markers are deliberately persisted with the entity instead of only
    # in a separate ledger: cleanup must be able to prove that a ledger id still
    # points at the entity created for that exact enterprise capability.
    managed_capability_id: str = ""
    managed_digest: str = ""
    # Stable identity for user-facing portable releases.  This is distinct
    # from the local avatar id, which names one installation on one machine.
    portable_artifact_id: str = ""
    portable_release_version: str = "1.0.0"
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        d = {k: v for k, v in asdict(self).items() if v or k in {"id", "name", "pinned", "sort_order"}}
        if self.brains_enabled is not None:
            d["brains_enabled"] = self.brains_enabled
        if self.skills_enabled is not None:
            d["skills_enabled"] = self.skills_enabled
        # Always persist the expert background color.
        d["color"] = normalize_avatar_color(self.color)
        d["default_permission_mode"] = normalize_permission_mode(
            self.default_permission_mode
        )
        if self.tags:
            d["tags"] = normalize_avatar_tags(self.tags)
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> AvatarConfig:
        known = set(cls.__dataclass_fields__.keys())
        filtered = {k: v for k, v in data.items() if k in known}
        if "color" in filtered:
            filtered["color"] = normalize_avatar_color(filtered.get("color"))
        if "tags" in filtered:
            filtered["tags"] = normalize_avatar_tags(filtered.get("tags"))
        filtered["default_permission_mode"] = normalize_permission_mode(
            filtered.get("default_permission_mode")
        )
        return cls(**filtered)


class AvatarRegistry:
    """CRUD operations for avatars with YAML persistence."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root) if root else _avatars_root()
        self.root.mkdir(parents=True, exist_ok=True)

    def _avatar_dir(self, avatar_id: str) -> Path:
        return self.root / avatar_id

    def _config_path(self, avatar_id: str) -> Path:
        return self._avatar_dir(avatar_id) / AVATAR_CONFIG_FILE

    def _read_config(self, avatar_id: str) -> Optional[AvatarConfig]:
        path = self._config_path(avatar_id)
        if not path.exists():
            return None
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            if not isinstance(raw, dict):
                return None
            raw.setdefault("id", avatar_id)
            return AvatarConfig.from_dict(raw)
        except Exception:
            return None

    def _write_config(self, config: AvatarConfig) -> None:
        avatar_dir = self._avatar_dir(config.id)
        avatar_dir.mkdir(parents=True, exist_ok=True)
        path = self._config_path(config.id)
        atomic_write_text(
            path,
            yaml.dump(config.to_dict(), sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

    def list_avatars(self) -> List[AvatarConfig]:
        """Return all avatars sorted by pinned-first then created_at desc."""
        avatars: List[AvatarConfig] = []
        if not self.root.exists():
            return avatars
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            cfg = self._read_config(child.name)
            if cfg is not None:
                avatars.append(cfg)
        missing = [
            item
            for item in avatars
            if needs_portrait_refresh(
                item.avatar_url,
                portrait_style=getattr(item, "portrait_style", ""),
                created_by=item.created_by,
            )
        ]
        for config in missing:
            self._ensure_portrait(config)
        avatars.sort(
            key=lambda a: (
                not a.pinned,
                getattr(a, "sort_order", 0),  # optional user-defined order
                a.created_at or "",    # fallback: creation time
            ),
            reverse=False,
        )
        return avatars

    def _ensure_portrait(self, config: AvatarConfig) -> AvatarConfig:
        """Fill an illustrated portrait once if the avatar has no image yet.

        Existing generated portraits are upgraded to the bundled collection.
        Explicit user uploads are never replaced.
        """
        if not needs_portrait_refresh(
            config.avatar_url,
            portrait_style=getattr(config, "portrait_style", ""),
            created_by=config.created_by,
        ):
            return config
        portrait = generate_avatar_portrait_url(
            name=config.name,
            role=config.role,
            description=config.description,
            tags=list(config.tags or []),
            avatar_id=config.id,
        )
        if not portrait:
            return config
        config.avatar_url = portrait
        config.portrait_style = PORTRAIT_STYLE
        self._write_config(config)
        return config

    def get_avatar(self, avatar_id: str) -> Optional[AvatarConfig]:
        return self._read_config(avatar_id)

    def create_avatar(
        self,
        name: str,
        role: str = "",
        *,
        avatar_url: str = "",
        system_prompt: str = "",
        description: str = "",
        tags: Optional[List[str]] = None,
        created_by: str = "manual",
        default_permission_mode: str = DEFAULT_PERMISSION_MODE,
        default_provider: str = "",
        default_model: str = "",
        tools_enabled: Optional[Dict[str, bool]] = None,
        skills_enabled: Optional[Dict[str, bool]] = None,
        brains_enabled: Optional[Any] = None,
        workspace_dir: str = "",
        color: str = "blue",
        sort_order: int = 0,
        managed_capability_id: str = "",
        managed_digest: str = "",
        portable_artifact_id: str = "",
        portable_release_version: str = "1.0.0",
    ) -> AvatarConfig:
        """Create a new avatar with isolated workspace.

        When ``workspace_dir`` is a non-empty string it is used as the avatar's
        working directory (user-chosen, optional). Otherwise it defaults to the
        per-avatar ``$AGX_HOME/avatars/<id>/workspace``.
        """
        avatar_id = uuid.uuid4().hex[:12]
        now = datetime.now(timezone.utc).isoformat()
        custom_ws = str(workspace_dir or "").strip()
        if custom_ws:
            workspace_dir = str(Path(custom_ws).expanduser().resolve())
        else:
            workspace_dir = str(self._avatar_dir(avatar_id) / "workspace")
        se: Optional[Dict[str, bool]] = None
        if skills_enabled is not None and len(skills_enabled) > 0:
            se = {str(k): bool(v) for k, v in skills_enabled.items() if str(k).strip()}
        resolved_avatar_url = str(avatar_url or "").strip()
        portrait_style = "custom"
        if not resolved_avatar_url:
            resolved_avatar_url = generate_avatar_portrait_url(
                name=name,
                role=role,
                description=str(description or "").strip(),
                tags=normalize_avatar_tags(tags),
                avatar_id=avatar_id,
            )
            portrait_style = PORTRAIT_STYLE
        config = AvatarConfig(
            id=avatar_id,
            name=name,
            role=role,
            avatar_url=resolved_avatar_url,
            portrait_style=portrait_style,
            system_prompt=system_prompt,
            description=str(description or "").strip(),
            tags=normalize_avatar_tags(tags),
            workspace_dir=workspace_dir,
            created_by=created_by,
            default_permission_mode=normalize_permission_mode(default_permission_mode),
            default_provider=default_provider,
            default_model=default_model,
            tools_enabled=dict(tools_enabled or {}),
            skills_enabled=se,
            brains_enabled=brains_enabled,
            managed_capability_id=str(managed_capability_id or "").strip(),
            managed_digest=str(managed_digest or "").strip().lower(),
            portable_artifact_id=str(portable_artifact_id or "").strip() or str(uuid.uuid4()),
            portable_release_version=str(portable_release_version or "1.0.0").strip() or "1.0.0",
            color=normalize_avatar_color(color),
            sort_order=sort_order,
            created_at=now,
            updated_at=now,
        )
        try:
            self._write_config(config)
            self._ensure_avatar_workspace(config)
        except Exception:
            # A failed create must not leave a half-installed expert behind.
            # Import flows rely on this local atomicity so their rollback only
            # ever needs to remove entities that were returned successfully.
            shutil.rmtree(self._avatar_dir(avatar_id), ignore_errors=True)
            raise
        return config

    def update_avatar(self, avatar_id: str, patch: Dict[str, Any]) -> Optional[AvatarConfig]:
        """Update avatar fields. Returns updated config or None if not found."""
        config = self._read_config(avatar_id)
        if config is None:
            return None
        if config.created_by == "enterprise_managed":
            raise AvatarReadOnlyError("enterprise-managed avatar is read-only")
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
            if key == "skills_enabled":
                if value is None or (isinstance(value, dict) and len(value) == 0):
                    config.skills_enabled = None
                elif isinstance(value, dict):
                    config.skills_enabled = {
                        str(k): bool(v) for k, v in value.items() if str(k).strip()
                    }
                continue
            if key == "brains_enabled":
                if value is None or value == "":
                    config.brains_enabled = None
                elif value == "*":
                    config.brains_enabled = "*"
                elif isinstance(value, list):
                    config.brains_enabled = [str(x).strip() for x in value if str(x).strip()]
                else:
                    config.brains_enabled = value
                continue
            if key == "color":
                config.color = normalize_avatar_color(value)
                continue
            if key == "default_permission_mode":
                config.default_permission_mode = normalize_permission_mode(value)
                continue
            if key == "workspace_dir":
                raw_candidate = str(value or "").strip()
                if not raw_candidate:
                    raise AvatarCoreMemoryError(
                        "workspace directory cannot be empty"
                    )
                candidate = Path(raw_candidate).expanduser()
                try:
                    candidate_stat = candidate.lstat()
                except FileNotFoundError as exc:
                    raise AvatarCoreMemoryError(
                        "workspace directory does not exist"
                    ) from exc
                except OSError as exc:
                    raise AvatarCoreMemoryError(
                        f"workspace directory cannot be inspected: {exc}"
                    ) from exc
                if candidate.is_symlink() or not stat.S_ISDIR(candidate_stat.st_mode):
                    raise AvatarCoreMemoryError(
                        "workspace directory must be a regular directory"
                    )
                config.workspace_dir = str(candidate.resolve())
                continue
            if key == "tags":
                config.tags = normalize_avatar_tags(value)
                continue
            if key == "avatar_url":
                config.avatar_url = str(value or "").strip()
                config.portrait_style = "custom" if config.avatar_url else ""
                continue
            if hasattr(config, key):
                setattr(config, key, value)
        config.updated_at = datetime.now(timezone.utc).isoformat()
        self._write_config(config)
        return config

    def _core_memory_workspace(self, config: AvatarConfig) -> Path:
        """Return a verified expert workspace for the fixed core documents.

        The workspace is configured on the avatar, but its final path and each
        document are checked with ``lstat``.  This intentionally rejects
        symlinks and special files before any content is exposed or replaced.
        """

        raw_workspace = str(config.workspace_dir or "").strip()
        if not raw_workspace:
            raise AvatarCoreMemoryError("avatar workspace is not configured")
        workspace = Path(raw_workspace).expanduser()
        try:
            workspace_stat = workspace.lstat()
        except FileNotFoundError as exc:
            raise AvatarCoreMemoryError("avatar workspace does not exist") from exc
        except OSError as exc:
            raise AvatarCoreMemoryError(f"avatar workspace cannot be inspected: {exc}") from exc
        if workspace.is_symlink() or not stat.S_ISDIR(workspace_stat.st_mode):
            raise AvatarCoreMemoryError("avatar workspace must be a regular directory")
        return workspace

    @staticmethod
    def _read_core_memory_files(workspace: Path) -> Dict[str, str]:
        documents: Dict[str, str] = {}
        for filename in CORE_MEMORY_FILENAMES:
            path = workspace / filename
            try:
                file_stat = path.lstat()
            except FileNotFoundError:
                documents[filename] = ""
                continue
            except OSError as exc:
                raise AvatarCoreMemoryError(
                    f"{filename} cannot be inspected: {exc}"
                ) from exc
            if path.is_symlink() or not stat.S_ISREG(file_stat.st_mode):
                raise AvatarCoreMemoryError(
                    f"{filename} must be a regular file, not a symlink or special file"
                )
            if file_stat.st_size > CORE_MEMORY_MAX_BYTES:
                raise AvatarCoreMemoryError(
                    f"{filename} exceeds the {CORE_MEMORY_MAX_BYTES} byte limit"
                )
            try:
                content_bytes = path.read_bytes()
                content = content_bytes.decode("utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                raise AvatarCoreMemoryError(
                    f"{filename} must be a valid UTF-8 text file"
                ) from exc
            if len(content_bytes) > CORE_MEMORY_MAX_BYTES:
                raise AvatarCoreMemoryError(
                    f"{filename} exceeds the {CORE_MEMORY_MAX_BYTES} byte limit"
                )
            documents[filename] = content
        return documents

    @staticmethod
    def _validate_core_memory_documents(
        documents: Dict[str, Any],
    ) -> Dict[str, str]:
        if not isinstance(documents, dict):
            raise AvatarCoreMemoryError("documents must be an object")
        unknown = sorted(set(documents) - set(CORE_MEMORY_FILENAMES))
        if unknown:
            raise AvatarCoreMemoryError(
                "only IDENTITY.md, SOUL.md, and MEMORY.md may be edited"
            )
        validated: Dict[str, str] = {}
        for filename, value in documents.items():
            if not isinstance(value, str):
                raise AvatarCoreMemoryError(f"{filename} content must be text")
            try:
                encoded = value.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise AvatarCoreMemoryError(f"{filename} must be valid UTF-8") from exc
            if len(encoded) > CORE_MEMORY_MAX_BYTES:
                raise AvatarCoreMemoryError(
                    f"{filename} exceeds the {CORE_MEMORY_MAX_BYTES} byte limit"
                )
            if "\x00" in value:
                raise AvatarCoreMemoryError(f"{filename} contains an invalid NUL character")
            validated[filename] = value
        return validated

    def read_core_memory(self, avatar_id: str) -> Dict[str, str]:
        """Read the three fixed expert identity/memory documents safely."""

        config = self._read_config(avatar_id)
        if config is None:
            raise AvatarCoreMemoryError("avatar not found")
        with _CORE_MEMORY_LOCK:
            return self._read_core_memory_files(self._core_memory_workspace(config))

    def update_core_memory(
        self,
        avatar_id: str,
        documents: Dict[str, Any],
    ) -> Dict[str, str]:
        """Atomically update a subset of the three fixed core documents.

        The caller cannot name arbitrary paths.  Existing files are staged and
        swapped in the same directory with rollback if any replacement fails;
        unrelated workspace files are never touched.
        """

        config = self._read_config(avatar_id)
        if config is None:
            raise AvatarCoreMemoryError("avatar not found")
        if config.created_by == "enterprise_managed":
            raise AvatarReadOnlyError("enterprise-managed avatar is read-only")
        validated = self._validate_core_memory_documents(documents)
        with _CORE_MEMORY_LOCK:
            workspace = self._core_memory_workspace(config)
            current = self._read_core_memory_files(workspace)
            if not validated:
                return current
            token = uuid.uuid4().hex
            stage = Path(tempfile.mkdtemp(prefix=f".agenticx-core-stage-{token}-", dir=str(workspace)))
            backups: Dict[str, Path] = {}
            replaced: list[str] = []
            commit_complete = False
            try:
                for filename, content in validated.items():
                    staged = stage / filename
                    staged.write_text(content, encoding="utf-8")
                for index, (filename, _content) in enumerate(validated.items()):
                    target = workspace / filename
                    backup = workspace / f".agenticx-core-backup-{token}-{index}"
                    try:
                        target.lstat()
                    except FileNotFoundError:
                        pass
                    else:
                        os.replace(target, backup)
                        backups[filename] = backup
                    os.replace(stage / filename, target)
                    replaced.append(filename)
                commit_complete = True
            except Exception as exc:
                rollback_errors: list[Exception] = []
                for filename in reversed(replaced):
                    target = workspace / filename
                    try:
                        target.unlink()
                    except FileNotFoundError:
                        pass
                    except OSError:
                        pass
                # A failure can happen after the original was moved to its
                # backup but before the staged replacement is installed.  In
                # that case ``filename`` is not in ``replaced`` yet; restore
                # every backup independently so the old content is not lost.
                for filename, backup in backups.items():
                    target = workspace / filename
                    if backup is not None:
                        try:
                            try:
                                target.unlink()
                            except FileNotFoundError:
                                pass
                            os.replace(backup, target)
                        except OSError as rollback_exc:
                            rollback_errors.append(rollback_exc)
                if rollback_errors:
                    raise AvatarCoreMemoryError(
                        "failed to save expert core memory; rollback failed and backup files were preserved"
                    ) from rollback_errors[0]
                raise AvatarCoreMemoryError(
                    f"failed to save expert core memory: {exc}"
                ) from exc
            finally:
                shutil.rmtree(stage, ignore_errors=True)
                if commit_complete:
                    for backup in backups.values():
                        try:
                            backup.unlink()
                        except FileNotFoundError:
                            pass
                        except OSError:
                            pass
            current.update(validated)
            return current

    def ensure_portable_identity(self, avatar_id: str) -> Optional[AvatarConfig]:
        """Persist a stable portable identity for an existing expert.

        Experts created before portable releases were introduced may not have
        an artifact id yet.  Assigning it lazily keeps export deterministic
        without rewriting every expert at application startup.
        """

        config = self._read_config(avatar_id)
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
        avatar_id: str,
        release_version: str,
    ) -> Optional[AvatarConfig]:
        """Record the latest release version after a successful publication."""

        config = self.ensure_portable_identity(avatar_id)
        if config is None:
            return None
        config.portable_release_version = str(release_version or "").strip()
        config.updated_at = datetime.now(timezone.utc).isoformat()
        self._write_config(config)
        return config

    def delete_avatar(self, avatar_id: str) -> bool:
        """Delete avatar and its workspace."""
        avatar_dir = self._avatar_dir(avatar_id)
        if not avatar_dir.exists():
            return False
        try:
            from agenticx.brain.registry import BrainRegistry

            BrainRegistry.instance().delete_private_brains_for_avatar(avatar_id)
            shutil.rmtree(avatar_dir)
        except OSError:
            return False
        return True

    def _ensure_avatar_workspace(self, config: AvatarConfig) -> Path:
        """Create workspace directory with default identity files."""
        ws = Path(config.workspace_dir)
        ws.mkdir(parents=True, exist_ok=True)
        memory_dir = ws / "memory"
        memory_dir.mkdir(parents=True, exist_ok=True)

        identity_path = ws / "IDENTITY.md"
        if not identity_path.exists():
            identity_path.write_text(
                IDENTITY_TEMPLATE.format(name=config.name, role=config.role or "General Assistant"),
                encoding="utf-8",
            )

        memory_path = ws / "MEMORY.md"
        if not memory_path.exists():
            memory_path.write_text(
                MEMORY_TEMPLATE.format(created_at=config.created_at or "unknown"),
                encoding="utf-8",
            )
        return ws
