#!/usr/bin/env python3
"""Enterprise desired-state reconciliation for portable experts and groups.

This module is intentionally separate from the user-facing portable import
flow.  A normal import is a confirmed copy operation and always creates a new,
independent entity.  Managed reconciliation instead keeps one stable mapping
from an enterprise capability id to the local entities created for it, so a
Desktop bootstrap can be applied repeatedly, updated, and safely withdrawn.

The local ledger is never sufficient authority to delete an entity.  Every
delete also verifies the entity's persisted ``created_by``, capability id, and
content digest markers.  A forged or stale ledger therefore cannot delete a
manual or ordinary ``portable_import`` expert/group.
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from agenticx.avatar.group_chat import GroupChatConfig, GroupChatRegistry
from agenticx.avatar.portable_package import (
    MAX_PACKAGE_BYTES,
    PortablePackageBundleSnapshot,
    PortablePackageError,
    _install_package_bundle,
    _load_document,
    _rollback_created_entries,
    package_bundle_matches,
    restore_package_bundle,
)
from agenticx.avatar.registry import AvatarConfig, AvatarRegistry
from agenticx.utils.agx_home import agx_home, lazy_home_path
from agenticx.utils.atomic_writer import atomic_write_json


MANAGED_CREATED_BY = "enterprise_managed"
MANAGED_LEDGER_SCHEMA_VERSION = 1
MAX_MANAGED_PACKAGES = 64
# ``raw`` is embedded as a JSON string in the Desktop -> Studio wrapper.  A
# valid package made mostly of quotes/backslashes can therefore approach 2x
# its original UTF-8 size on the wire.  Derive the aggregate request bound
# from the advertised per-package/item limits so every otherwise-valid
# 64-package snapshot remains representable.
MAX_MANAGED_REQUEST_BYTES = (
    MAX_MANAGED_PACKAGES * ((MAX_PACKAGE_BYTES * 2) + 1024) + 4096
)
MAX_MANAGED_LEDGER_BYTES = 2 * 1024 * 1024

_CAPABILITY_ID_RE = re.compile(
    r"^(expert|group):[0-9A-HJKMNP-TV-Z]{26}$"
)
_DIGEST_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_LOCAL_ENTITY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_RECONCILE_LOCK = threading.RLock()


def managed_portable_ledger_path() -> Path:
    """Resolve the ledger lazily so pytest/portable HOME overrides are honored."""

    return lazy_home_path(
        __name__,
        "MANAGED_PORTABLE_LEDGER_PATH",
        "enterprise",
        "managed-portable-packages.json",
    )


def __getattr__(name: str):
    if name == "MANAGED_PORTABLE_LEDGER_PATH":
        return agx_home() / "enterprise" / "managed-portable-packages.json"
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


class ManagedPortableError(RuntimeError):
    """Base error for the enterprise managed portable boundary."""


class ManagedPortableRequestError(ManagedPortableError, ValueError):
    """The desired-state request is malformed; no mutation may occur."""


class ManagedPortableLedgerError(ManagedPortableError):
    """The local ownership ledger is unreadable or cannot be persisted."""


@dataclass(frozen=True)
class ManagedPortableSpec:
    capability_id: str
    kind: str
    digest: str
    raw: str
    document: Mapping[str, Any]


@dataclass(frozen=True)
class ManagedGeneration:
    digest: str
    avatar_ids: tuple[str, ...]
    group_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "digest": self.digest,
            "avatar_ids": list(self.avatar_ids),
            "group_id": self.group_id,
        }


@dataclass
class ManagedLedgerEntry:
    kind: str
    active: ManagedGeneration | None
    stale: list[ManagedGeneration] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "active": self.active.to_dict() if self.active is not None else None,
            "stale": [generation.to_dict() for generation in self.stale],
        }


@dataclass(frozen=True)
class ManagedPortableIssue:
    capability_id: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {"id": self.capability_id, "message": self.message}


@dataclass
class ManagedPortableReconcileResult:
    installed: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    errors: list[ManagedPortableIssue] = field(default_factory=list)
    entries: dict[str, ManagedLedgerEntry] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        managed: list[dict[str, Any]] = []
        for capability_id in sorted(self.entries):
            entry = self.entries[capability_id]
            if entry.active is None and not entry.stale:
                continue
            active = entry.active
            managed.append(
                {
                    "id": capability_id,
                    "kind": entry.kind,
                    "digest": active.digest if active is not None else "",
                    "avatar_ids": list(active.avatar_ids) if active is not None else [],
                    "group_id": active.group_id if active is not None else "",
                    "pending_cleanup": [item.to_dict() for item in entry.stale],
                }
            )
        return {
            "ok": self.ok,
            "installed": sorted(self.installed),
            "updated": sorted(self.updated),
            "removed": sorted(self.removed),
            "unchanged": sorted(self.unchanged),
            "errors": [item.to_dict() for item in self.errors],
            "managed": managed,
        }


def _capability_kind(capability_id: str) -> str:
    match = _CAPABILITY_ID_RE.fullmatch(capability_id)
    if match is None:
        raise ManagedPortableRequestError(
            "package id must be expert:<ULID> or group:<ULID>"
        )
    return match.group(1)


def _sha256(raw: str) -> str:
    try:
        encoded = raw.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ManagedPortableRequestError("package raw must contain valid Unicode") from exc
    if len(encoded) > MAX_PACKAGE_BYTES:
        raise ManagedPortableRequestError(
            f"package exceeds {MAX_PACKAGE_BYTES} byte limit"
        )
    return hashlib.sha256(encoded).hexdigest()


def validate_managed_package_specs(value: Any) -> list[ManagedPortableSpec]:
    """Validate the complete desired state before any local mutation.

    Invalid input must never be interpreted as an empty or partial desired set,
    because doing so would withdraw otherwise valid managed entities.
    """

    if type(value) is not list:
        raise ManagedPortableRequestError("packages must be an array")
    if len(value) > MAX_MANAGED_PACKAGES:
        raise ManagedPortableRequestError(
            f"packages exceeds {MAX_MANAGED_PACKAGES} item limit"
        )

    specs: list[ManagedPortableSpec] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        if type(item) is not dict:
            raise ManagedPortableRequestError(f"packages[{index}] must be an object")
        if set(item) != {"id", "digest", "raw"}:
            raise ManagedPortableRequestError(
                f"packages[{index}] must contain exactly: digest, id, raw"
            )
        capability_id = item.get("id")
        digest = item.get("digest")
        raw = item.get("raw")
        if type(capability_id) is not str:
            raise ManagedPortableRequestError(f"packages[{index}].id must be a string")
        if type(digest) is not str:
            raise ManagedPortableRequestError(f"packages[{index}].digest must be a string")
        if type(raw) is not str:
            raise ManagedPortableRequestError(f"packages[{index}].raw must be a string")
        if capability_id in seen:
            raise ManagedPortableRequestError(f"duplicate package id: {capability_id}")
        seen.add(capability_id)

        kind = _capability_kind(capability_id)
        if _DIGEST_RE.fullmatch(digest) is None:
            raise ManagedPortableRequestError(
                f"packages[{index}].digest must be a SHA-256 hex digest"
            )
        normalized_digest = digest.lower()
        actual_digest = _sha256(raw)
        if not hmac.compare_digest(normalized_digest, actual_digest):
            raise ManagedPortableRequestError(
                f"packages[{index}].digest does not match raw"
            )
        try:
            document, _byte_size = _load_document(raw)
        except PortablePackageError as exc:
            raise ManagedPortableRequestError(
                f"packages[{index}] is not a valid portable package: {exc}"
            ) from exc
        if document["kind"] != kind:
            raise ManagedPortableRequestError(
                f"packages[{index}].id kind must match package kind"
            )
        specs.append(
            ManagedPortableSpec(
                capability_id=capability_id,
                kind=kind,
                digest=normalized_digest,
                raw=raw,
                document=document,
            )
        )
    return specs


def _strict_ledger_object(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ManagedPortableLedgerError(f"duplicate ledger key: {key}")
        out[key] = value
    return out


def _ledger_generation(
    value: Any,
    *,
    capability_id: str,
    field_name: str,
    active: bool,
) -> ManagedGeneration:
    if type(value) is not dict or set(value) != {"digest", "avatar_ids", "group_id"}:
        raise ManagedPortableLedgerError(
            f"ledger {capability_id}.{field_name} has invalid fields"
        )
    digest = value.get("digest")
    avatar_ids = value.get("avatar_ids")
    group_id = value.get("group_id")
    if type(digest) is not str or _DIGEST_RE.fullmatch(digest) is None:
        raise ManagedPortableLedgerError(
            f"ledger {capability_id}.{field_name}.digest is invalid"
        )
    if type(avatar_ids) is not list or any(type(item) is not str for item in avatar_ids):
        raise ManagedPortableLedgerError(
            f"ledger {capability_id}.{field_name}.avatar_ids is invalid"
        )
    if type(group_id) is not str:
        raise ManagedPortableLedgerError(
            f"ledger {capability_id}.{field_name}.group_id is invalid"
        )
    normalized_ids = tuple(avatar_ids)
    if len(set(normalized_ids)) != len(normalized_ids) or any(
        _LOCAL_ENTITY_ID_RE.fullmatch(item) is None for item in normalized_ids
    ):
        raise ManagedPortableLedgerError(
            f"ledger {capability_id}.{field_name}.avatar_ids is unsafe"
        )
    if group_id and _LOCAL_ENTITY_ID_RE.fullmatch(group_id) is None:
        raise ManagedPortableLedgerError(
            f"ledger {capability_id}.{field_name}.group_id is unsafe"
        )
    kind = capability_id.split(":", 1)[0]
    if active:
        if kind == "expert" and (len(normalized_ids) != 1 or group_id):
            raise ManagedPortableLedgerError(
                f"ledger {capability_id}.{field_name} is not an expert generation"
            )
        if kind == "group" and (not normalized_ids or not group_id):
            raise ManagedPortableLedgerError(
                f"ledger {capability_id}.{field_name} is not a group generation"
            )
    elif not normalized_ids and not group_id:
        raise ManagedPortableLedgerError(
            f"ledger {capability_id}.{field_name} is empty"
        )
    return ManagedGeneration(
        digest=digest.lower(),
        avatar_ids=normalized_ids,
        group_id=group_id,
    )


def _load_ledger(path: Path) -> dict[str, ManagedLedgerEntry]:
    if not path.exists():
        return {}
    try:
        stat = path.lstat()
        if path.is_symlink() or not path.is_file():
            raise ManagedPortableLedgerError("managed portable ledger must be a regular file")
        if stat.st_size > MAX_MANAGED_LEDGER_BYTES:
            raise ManagedPortableLedgerError("managed portable ledger is too large")
        raw = path.read_text(encoding="utf-8")
        document = json.loads(
            raw,
            object_pairs_hook=_strict_ledger_object,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ManagedPortableLedgerError(
                    f"non-standard ledger JSON constant is not allowed: {value}"
                )
            ),
        )
    except ManagedPortableLedgerError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ManagedPortableLedgerError("managed portable ledger is unreadable") from exc

    if type(document) is not dict or set(document) != {"schema_version", "packages"}:
        raise ManagedPortableLedgerError("managed portable ledger has invalid top-level fields")
    if document.get("schema_version") != MANAGED_LEDGER_SCHEMA_VERSION:
        raise ManagedPortableLedgerError("managed portable ledger schema version is unsupported")
    packages = document.get("packages")
    if type(packages) is not dict:
        raise ManagedPortableLedgerError("managed portable ledger packages must be an object")

    entries: dict[str, ManagedLedgerEntry] = {}
    for capability_id, raw_entry in packages.items():
        try:
            kind = _capability_kind(capability_id)
        except ManagedPortableRequestError as exc:
            raise ManagedPortableLedgerError(f"unsafe ledger capability id: {capability_id}") from exc
        if type(raw_entry) is not dict or set(raw_entry) != {"kind", "active", "stale"}:
            raise ManagedPortableLedgerError(f"ledger entry {capability_id} has invalid fields")
        if raw_entry.get("kind") != kind:
            raise ManagedPortableLedgerError(f"ledger entry {capability_id} kind mismatch")
        raw_active = raw_entry.get("active")
        active_generation = (
            None
            if raw_active is None
            else _ledger_generation(
                raw_active,
                capability_id=capability_id,
                field_name="active",
                active=True,
            )
        )
        raw_stale = raw_entry.get("stale")
        if type(raw_stale) is not list:
            raise ManagedPortableLedgerError(f"ledger entry {capability_id}.stale is invalid")
        stale = [
            _ledger_generation(
                generation,
                capability_id=capability_id,
                field_name=f"stale[{index}]",
                active=False,
            )
            for index, generation in enumerate(raw_stale)
        ]
        if active_generation is None and not stale:
            raise ManagedPortableLedgerError(f"ledger entry {capability_id} is empty")
        entries[capability_id] = ManagedLedgerEntry(
            kind=kind,
            active=active_generation,
            stale=stale,
        )
    return entries


def _write_ledger(path: Path, entries: Mapping[str, ManagedLedgerEntry]) -> None:
    document = {
        "schema_version": MANAGED_LEDGER_SCHEMA_VERSION,
        "packages": {
            capability_id: entries[capability_id].to_dict()
            for capability_id in sorted(entries)
        },
    }
    try:
        atomic_write_json(path, document, indent=2)
        os.chmod(path, 0o600)
    except OSError as exc:
        raise ManagedPortableLedgerError("managed portable ledger write failed") from exc


def _managed_avatar_owned(
    config: AvatarConfig | None,
    capability_id: str,
) -> bool:
    return bool(
        config is not None
        and config.created_by == MANAGED_CREATED_BY
        and config.managed_capability_id == capability_id
    )


def _managed_avatar_matches(
    config: AvatarConfig | None,
    capability_id: str,
    digest: str,
) -> bool:
    return _managed_avatar_owned(config, capability_id) and bool(
        config is not None and config.managed_digest == digest
    )


def _managed_group_owned(
    config: GroupChatConfig | None,
    capability_id: str,
) -> bool:
    return bool(
        config is not None
        and config.created_by == MANAGED_CREATED_BY
        and config.managed_capability_id == capability_id
    )


def _managed_group_matches(
    config: GroupChatConfig | None,
    capability_id: str,
    digest: str,
) -> bool:
    return _managed_group_owned(config, capability_id) and bool(
        config is not None and config.managed_digest == digest
    )


def _avatar_declaration_matches(config: AvatarConfig, declaration: Mapping[str, Any]) -> bool:
    return (
        config.name == declaration["name"]
        and config.role == declaration["role"]
        and config.description == declaration["description"]
        and list(config.tags or []) == list(declaration["tags"])
        and config.system_prompt == declaration["system_prompt"]
        and config.color == declaration["color"]
        and config.default_permission_mode == declaration["default_permission_mode"]
        and config.default_provider == ""
        and config.default_model == ""
        and config.tools_enabled == {}
        and config.skills_enabled is None
        and config.brains_enabled is None
    )


def _active_generation_matches_spec(
    generation: ManagedGeneration,
    spec: ManagedPortableSpec,
    *,
    avatar_registry: AvatarRegistry,
    group_registry: GroupChatRegistry,
) -> bool:
    if generation.digest != spec.digest:
        return False
    payload = spec.document["payload"]
    if spec.kind == "expert":
        if len(generation.avatar_ids) != 1 or generation.group_id:
            return False
        avatar = avatar_registry.get_avatar(generation.avatar_ids[0])
        return bool(
            _managed_avatar_matches(avatar, spec.capability_id, spec.digest)
            and avatar is not None
            and _avatar_declaration_matches(avatar, payload)
            and package_bundle_matches(
                spec.document,
                workspace=Path(avatar.workspace_dir),
            )
        )

    if not generation.group_id or len(generation.avatar_ids) != len(payload["members"]):
        return False
    group = group_registry.get_group(generation.group_id)
    if not _managed_group_matches(group, spec.capability_id, spec.digest) or group is None:
        return False
    if (
        group.name != payload["name"]
        or group.description != str(spec.document.get("description", "") or "")
        or group.routing != payload["routing"]
    ):
        return False
    if list(group.avatar_ids) != list(generation.avatar_ids):
        return False
    host_index = int(payload["host_member_index"])
    if group.host_avatar_id != generation.avatar_ids[host_index]:
        return False
    for avatar_id, declaration in zip(generation.avatar_ids, payload["members"]):
        avatar = avatar_registry.get_avatar(avatar_id)
        if not _managed_avatar_matches(avatar, spec.capability_id, spec.digest):
            return False
        if avatar is None or not _avatar_declaration_matches(avatar, declaration):
            return False
    return package_bundle_matches(
        spec.document,
        workspace=Path(group.workspace_dir),
    )


def _create_managed_avatar(
    declaration: Mapping[str, Any],
    *,
    capability_id: str,
    digest: str,
    avatar_registry: AvatarRegistry,
) -> AvatarConfig:
    return avatar_registry.create_avatar(
        name=str(declaration["name"]),
        role=str(declaration["role"]),
        system_prompt=str(declaration["system_prompt"]),
        description=str(declaration["description"]),
        tags=list(declaration["tags"]),
        created_by=MANAGED_CREATED_BY,
        color=str(declaration["color"]),
        default_permission_mode=str(declaration["default_permission_mode"]),
        managed_capability_id=capability_id,
        managed_digest=digest,
    )


def _apply_managed_avatar_declaration(
    config: AvatarConfig,
    declaration: Mapping[str, Any],
    *,
    digest: str,
    avatar_registry: AvatarRegistry,
) -> AvatarConfig:
    """Replace package-owned fields while preserving local identity/workspace state."""

    updated = copy.deepcopy(config)
    updated.name = str(declaration["name"])
    updated.role = str(declaration["role"])
    updated.description = str(declaration["description"])
    updated.tags = list(declaration["tags"])
    updated.system_prompt = str(declaration["system_prompt"])
    updated.color = str(declaration["color"])
    updated.default_permission_mode = str(declaration["default_permission_mode"])
    updated.default_provider = ""
    updated.default_model = ""
    updated.tools_enabled = {}
    updated.skills_enabled = None
    updated.brains_enabled = None
    updated.managed_digest = digest
    updated.updated_at = datetime.now(timezone.utc).isoformat()
    avatar_registry._write_config(updated)
    return updated


def _apply_managed_group_declaration(
    config: GroupChatConfig,
    payload: Mapping[str, Any],
    *,
    avatar_ids: Sequence[str],
    digest: str,
    group_registry: GroupChatRegistry,
    description: str = "",
) -> GroupChatConfig:
    """Replace package-owned group fields without replacing its workspace."""

    updated = copy.deepcopy(config)
    updated.name = str(payload["name"])
    updated.description = str(description or "")
    updated.avatar_ids = list(avatar_ids)
    updated.routing = str(payload["routing"])
    updated.host_avatar_id = updated.avatar_ids[int(payload["host_member_index"])]
    updated.managed_digest = digest
    updated.updated_at = datetime.now(timezone.utc).isoformat()
    group_registry._write_config(updated)
    return updated


@dataclass(frozen=True)
class _ManagedInPlaceTransition:
    generation: ManagedGeneration
    removed: ManagedGeneration | None
    avatar_snapshots: tuple[AvatarConfig, ...]
    group_snapshot: GroupChatConfig | None = None
    created_avatar_ids: tuple[str, ...] = ()
    created_group_id: str = ""
    bundle_workspace: Path | None = None
    bundle_snapshot: PortablePackageBundleSnapshot | None = None


def _rollback_in_place_transition(
    transition: _ManagedInPlaceTransition,
    *,
    avatar_registry: AvatarRegistry,
    group_registry: GroupChatRegistry,
) -> list[str]:
    errors: list[str] = []
    if transition.group_snapshot is not None:
        try:
            group_registry._write_config(transition.group_snapshot)
        except Exception as exc:
            errors.append(f"group rollback failed: {exc}")
    for snapshot in transition.avatar_snapshots:
        try:
            avatar_registry._write_config(snapshot)
        except Exception as exc:
            errors.append(f"expert {snapshot.id} rollback failed: {exc}")
    if transition.created_group_id or transition.created_avatar_ids:
        errors.extend(
            _rollback_created_entries(
                avatar_registry=avatar_registry,
                avatar_ids=transition.created_avatar_ids,
                group_registry=group_registry,
                group_ids=(transition.created_group_id,)
                if transition.created_group_id
                else (),
            )
        )
    if transition.bundle_workspace is not None:
        try:
            restore_package_bundle(
                transition.bundle_workspace,
                transition.bundle_snapshot,
            )
        except Exception as exc:
            errors.append(f"package baseline rollback failed: {exc}")
    return errors


def _update_generation_in_place(
    generation: ManagedGeneration,
    spec: ManagedPortableSpec,
    *,
    avatar_registry: AvatarRegistry,
    group_registry: GroupChatRegistry,
) -> _ManagedInPlaceTransition:
    """Apply a managed release without replacing retained local entities."""

    payload = spec.document["payload"]
    if spec.kind == "expert":
        if len(generation.avatar_ids) != 1 or generation.group_id:
            raise ManagedPortableError("managed expert ledger shape is invalid")
        avatar = avatar_registry.get_avatar(generation.avatar_ids[0])
        if not _managed_avatar_owned(avatar, spec.capability_id) or avatar is None:
            raise ManagedPortableError("managed expert ownership check failed")
        snapshot = copy.deepcopy(avatar)
        bundle_workspace = Path(avatar.workspace_dir)
        try:
            bundle_snapshot = _install_package_bundle(
                spec.document,
                workspace=bundle_workspace,
            )
        except Exception as exc:
            raise ManagedPortableError(
                f"managed expert package baseline update failed: {exc}"
            ) from exc
        transition = _ManagedInPlaceTransition(
            generation=ManagedGeneration(
                digest=spec.digest,
                avatar_ids=generation.avatar_ids,
            ),
            removed=None,
            avatar_snapshots=(snapshot,),
            bundle_workspace=bundle_workspace,
            bundle_snapshot=bundle_snapshot,
        )
        try:
            _apply_managed_avatar_declaration(
                avatar,
                payload,
                digest=spec.digest,
                avatar_registry=avatar_registry,
            )
        except Exception as exc:
            rollback_errors = _rollback_in_place_transition(
                transition,
                avatar_registry=avatar_registry,
                group_registry=group_registry,
            )
            detail = f"managed expert update failed: {exc}"
            if rollback_errors:
                detail += f"; rollback errors: {'; '.join(rollback_errors)}"
            raise ManagedPortableError(detail) from exc
        return transition

    if not generation.group_id or not generation.avatar_ids:
        raise ManagedPortableError("managed group ledger shape is invalid")
    group = group_registry.get_group(generation.group_id)
    if not _managed_group_owned(group, spec.capability_id) or group is None:
        raise ManagedPortableError("managed group ownership check failed")
    if list(group.avatar_ids) != list(generation.avatar_ids):
        raise ManagedPortableError("managed group membership no longer matches its ledger")

    old_members: list[AvatarConfig] = []
    for avatar_id in generation.avatar_ids:
        avatar = avatar_registry.get_avatar(avatar_id)
        if not _managed_avatar_owned(avatar, spec.capability_id) or avatar is None:
            raise ManagedPortableError(
                f"managed group member ownership check failed: {avatar_id}"
            )
        old_members.append(avatar)

    avatar_snapshots = tuple(copy.deepcopy(avatar) for avatar in old_members)
    group_snapshot = copy.deepcopy(group)
    if len(payload["members"]) != len(old_members):
        replacement = _create_generation(
            spec,
            avatar_registry=avatar_registry,
            group_registry=group_registry,
        )
        return _ManagedInPlaceTransition(
            generation=replacement,
            removed=generation,
            avatar_snapshots=(),
            created_avatar_ids=replacement.avatar_ids,
            created_group_id=replacement.group_id,
        )

    bundle_workspace = Path(group.workspace_dir)
    try:
        bundle_snapshot = _install_package_bundle(
            spec.document,
            workspace=bundle_workspace,
        )
    except Exception as exc:
        raise ManagedPortableError(
            f"managed group package baseline update failed: {exc}"
        ) from exc

    new_avatar_ids: list[str] = []
    try:
        for index, declaration in enumerate(payload["members"]):
            updated = _apply_managed_avatar_declaration(
                old_members[index],
                declaration,
                digest=spec.digest,
                avatar_registry=avatar_registry,
            )
            new_avatar_ids.append(updated.id)
        _apply_managed_group_declaration(
            group,
            payload,
            avatar_ids=new_avatar_ids,
            description=str(spec.document.get("description", "") or ""),
            digest=spec.digest,
            group_registry=group_registry,
        )
    except Exception as exc:
        transition = _ManagedInPlaceTransition(
            generation=generation,
            removed=None,
            avatar_snapshots=avatar_snapshots,
            group_snapshot=group_snapshot,
            bundle_workspace=bundle_workspace,
            bundle_snapshot=bundle_snapshot,
        )
        rollback_errors = _rollback_in_place_transition(
            transition,
            avatar_registry=avatar_registry,
            group_registry=group_registry,
        )
        detail = f"managed group update failed: {exc}"
        if rollback_errors:
            detail += f"; rollback errors: {'; '.join(rollback_errors)}"
        raise ManagedPortableError(detail) from exc

    return _ManagedInPlaceTransition(
        generation=ManagedGeneration(
            digest=spec.digest,
            avatar_ids=tuple(new_avatar_ids),
            group_id=generation.group_id,
        ),
        removed=None,
        avatar_snapshots=avatar_snapshots,
        group_snapshot=group_snapshot,
        bundle_workspace=bundle_workspace,
        bundle_snapshot=bundle_snapshot,
    )


def _create_generation(
    spec: ManagedPortableSpec,
    *,
    avatar_registry: AvatarRegistry,
    group_registry: GroupChatRegistry,
) -> ManagedGeneration:
    payload = spec.document["payload"]
    if spec.kind == "expert":
        avatar: AvatarConfig | None = None
        try:
            avatar = _create_managed_avatar(
                payload,
                capability_id=spec.capability_id,
                digest=spec.digest,
                avatar_registry=avatar_registry,
            )
            _install_package_bundle(
                spec.document,
                workspace=Path(avatar.workspace_dir),
            )
        except Exception as exc:
            cleanup_errors = _rollback_created_entries(
                avatar_registry=avatar_registry,
                avatar_ids=(avatar.id,) if avatar is not None else (),
            )
            detail = f"managed expert install failed: {exc}"
            if cleanup_errors:
                detail += f"; rollback errors: {'; '.join(cleanup_errors)}"
            raise ManagedPortableError(detail) from exc
        return ManagedGeneration(digest=spec.digest, avatar_ids=(avatar.id,))

    created_members: list[AvatarConfig] = []
    created_group: GroupChatConfig | None = None
    try:
        for declaration in payload["members"]:
            created_members.append(
                _create_managed_avatar(
                    declaration,
                    capability_id=spec.capability_id,
                    digest=spec.digest,
                    avatar_registry=avatar_registry,
                )
            )
        host_index = int(payload["host_member_index"])
        created_group = group_registry.create_group(
            name=str(payload["name"]),
            avatar_ids=[member.id for member in created_members],
            routing=str(payload["routing"]),
            host_avatar_id=created_members[host_index].id,
            description=str(spec.document.get("description", "") or ""),
            created_by=MANAGED_CREATED_BY,
            managed_capability_id=spec.capability_id,
            managed_digest=spec.digest,
        )
        _install_package_bundle(
            spec.document,
            workspace=Path(created_group.workspace_dir),
        )
    except Exception as exc:
        cleanup_errors = _rollback_created_entries(
            avatar_registry=avatar_registry,
            avatar_ids=[member.id for member in created_members],
            group_registry=group_registry,
            group_ids=(created_group.id,) if created_group is not None else (),
        )
        detail = f"managed group install failed: {exc}"
        if cleanup_errors:
            detail += f"; rollback errors: {'; '.join(cleanup_errors)}"
        raise ManagedPortableError(detail) from exc
    return ManagedGeneration(
        digest=spec.digest,
        avatar_ids=tuple(member.id for member in created_members),
        group_id=created_group.id,
    )


def _cleanup_generation(
    generation: ManagedGeneration,
    *,
    capability_id: str,
    kind: str,
    avatar_registry: AvatarRegistry,
    group_registry: GroupChatRegistry,
) -> tuple[ManagedGeneration | None, list[str]]:
    """Delete only entities that prove exact managed ownership.

    A missing entity is already clean.  A marker mismatch is reported and
    removed from the ledger (never retried as ours).  An owned entity whose
    filesystem deletion fails remains in the returned generation for retry.
    """

    errors: list[str] = []
    remaining_group_id = ""
    remaining_avatar_ids: list[str] = []

    # A managed group must disappear before its dedicated member experts.
    if generation.group_id:
        group = group_registry.get_group(generation.group_id)
        if group is not None:
            if not _managed_group_owned(group, capability_id):
                errors.append(
                    f"refused to delete unowned group {generation.group_id}"
                )
            else:
                try:
                    deleted = group_registry.delete_group(generation.group_id)
                except Exception as exc:
                    deleted = False
                    errors.append(f"group {generation.group_id} cleanup failed: {exc}")
                if not deleted and group_registry.get_group(generation.group_id) is not None:
                    remaining_group_id = generation.group_id
                    if not any(generation.group_id in message for message in errors):
                        errors.append(f"group {generation.group_id} cleanup failed")

    for avatar_id in generation.avatar_ids:
        avatar = avatar_registry.get_avatar(avatar_id)
        if avatar is None:
            continue
        if not _managed_avatar_owned(avatar, capability_id):
            errors.append(f"refused to delete unowned expert {avatar_id}")
            continue
        try:
            deleted = avatar_registry.delete_avatar(avatar_id)
        except Exception as exc:
            deleted = False
            errors.append(f"expert {avatar_id} cleanup failed: {exc}")
        if not deleted and avatar_registry.get_avatar(avatar_id) is not None:
            remaining_avatar_ids.append(avatar_id)
            if not any(avatar_id in message for message in errors):
                errors.append(f"expert {avatar_id} cleanup failed")

    if not remaining_group_id and not remaining_avatar_ids:
        return None, errors
    return (
        ManagedGeneration(
            digest=generation.digest,
            avatar_ids=tuple(remaining_avatar_ids),
            group_id=remaining_group_id,
        ),
        errors,
    )


def _cleanup_stale(
    entry: ManagedLedgerEntry,
    *,
    capability_id: str,
    avatar_registry: AvatarRegistry,
    group_registry: GroupChatRegistry,
) -> list[str]:
    errors: list[str] = []
    remaining: list[ManagedGeneration] = []
    for generation in entry.stale:
        kept, generation_errors = _cleanup_generation(
            generation,
            capability_id=capability_id,
            kind=entry.kind,
            avatar_registry=avatar_registry,
            group_registry=group_registry,
        )
        errors.extend(generation_errors)
        if kept is not None:
            remaining.append(kept)
    entry.stale = remaining
    return errors


def _rollback_new_generation(
    generation: ManagedGeneration,
    *,
    capability_id: str,
    kind: str,
    avatar_registry: AvatarRegistry,
    group_registry: GroupChatRegistry,
) -> list[str]:
    remaining, errors = _cleanup_generation(
        generation,
        capability_id=capability_id,
        kind=kind,
        avatar_registry=avatar_registry,
        group_registry=group_registry,
    )
    if remaining is not None:
        errors.append("new managed generation could not be fully rolled back")
    return errors


def _issue(result: ManagedPortableReconcileResult, capability_id: str, message: str) -> None:
    result.errors.append(
        ManagedPortableIssue(capability_id=capability_id, message=message)
    )


def reconcile_managed_portable_packages(
    packages: Any,
    *,
    avatar_registry: AvatarRegistry | None = None,
    group_registry: GroupChatRegistry | None = None,
    ledger_path: Path | None = None,
) -> ManagedPortableReconcileResult:
    """Reconcile a fully validated enterprise desired state.

    The function is best-effort per package.  A failed update leaves the prior
    active generation and ledger entry intact.  Missing desired ids are only
    withdrawn after *all* request entries have passed strict validation.
    """

    specs = validate_managed_package_specs(packages)
    avatars = avatar_registry or AvatarRegistry()
    groups = group_registry or GroupChatRegistry()
    path = Path(ledger_path) if ledger_path is not None else managed_portable_ledger_path()

    with _RECONCILE_LOCK:
        entries = _load_ledger(path)
        result = ManagedPortableReconcileResult(entries=entries)
        desired_ids = {spec.capability_id for spec in specs}

        for spec in specs:
            capability_id = spec.capability_id
            existing = entries.get(capability_id)
            if (
                existing is not None
                and existing.active is not None
                and _active_generation_matches_spec(
                    existing.active,
                    spec,
                    avatar_registry=avatars,
                    group_registry=groups,
                )
            ):
                stale_before = [generation.to_dict() for generation in existing.stale]
                for message in _cleanup_stale(
                    existing,
                    capability_id=capability_id,
                    avatar_registry=avatars,
                    group_registry=groups,
                ):
                    _issue(result, capability_id, message)
                if stale_before != [generation.to_dict() for generation in existing.stale]:
                    try:
                        _write_ledger(path, entries)
                    except ManagedPortableLedgerError as exc:
                        _issue(result, capability_id, str(exc))
                result.unchanged.append(capability_id)
                continue

            if existing is not None and existing.active is not None:
                try:
                    transition = _update_generation_in_place(
                        existing.active,
                        spec,
                        avatar_registry=avatars,
                        group_registry=groups,
                    )
                except Exception as exc:
                    _issue(result, capability_id, str(exc))
                    continue

                stale = list(existing.stale)
                if transition.removed is not None:
                    stale.insert(0, transition.removed)
                replacement = ManagedLedgerEntry(
                    kind=spec.kind,
                    active=transition.generation,
                    stale=stale,
                )
                entries[capability_id] = replacement
                try:
                    _write_ledger(path, entries)
                except ManagedPortableLedgerError as exc:
                    entries[capability_id] = existing
                    rollback_errors = _rollback_in_place_transition(
                        transition,
                        avatar_registry=avatars,
                        group_registry=groups,
                    )
                    detail = str(exc)
                    if rollback_errors:
                        detail += f"; rollback errors: {'; '.join(rollback_errors)}"
                    _issue(result, capability_id, detail)
                    continue

                for message in _cleanup_stale(
                    replacement,
                    capability_id=capability_id,
                    avatar_registry=avatars,
                    group_registry=groups,
                ):
                    _issue(result, capability_id, message)
                try:
                    _write_ledger(path, entries)
                except ManagedPortableLedgerError as exc:
                    _issue(result, capability_id, str(exc))
                result.updated.append(capability_id)
                continue

            try:
                new_generation = _create_generation(
                    spec,
                    avatar_registry=avatars,
                    group_registry=groups,
                )
            except Exception as exc:
                _issue(result, capability_id, str(exc))
                continue

            old_entry = existing
            stale = [] if old_entry is None else list(old_entry.stale)
            if old_entry is not None and old_entry.active is not None:
                stale.insert(0, old_entry.active)
            entries[capability_id] = ManagedLedgerEntry(
                kind=spec.kind,
                active=new_generation,
                stale=stale,
            )

            # Persist ownership of the new generation before touching the old
            # one.  If this transition write fails, the new copy is rolled back
            # and the last-known-good entry remains untouched.
            try:
                _write_ledger(path, entries)
            except ManagedPortableLedgerError as exc:
                if old_entry is None:
                    entries.pop(capability_id, None)
                else:
                    entries[capability_id] = old_entry
                rollback_errors = _rollback_new_generation(
                    new_generation,
                    capability_id=capability_id,
                    kind=spec.kind,
                    avatar_registry=avatars,
                    group_registry=groups,
                )
                detail = str(exc)
                if rollback_errors:
                    detail += f"; rollback errors: {'; '.join(rollback_errors)}"
                _issue(result, capability_id, detail)
                continue

            current = entries[capability_id]
            for message in _cleanup_stale(
                current,
                capability_id=capability_id,
                avatar_registry=avatars,
                group_registry=groups,
            ):
                _issue(result, capability_id, message)
            try:
                _write_ledger(path, entries)
            except ManagedPortableLedgerError as exc:
                # The already-written transition ledger still tracks both the
                # new active generation and every old generation for retry.
                _issue(result, capability_id, str(exc))
            if old_entry is None or old_entry.active is None:
                result.installed.append(capability_id)
            else:
                result.updated.append(capability_id)

        # Only a request whose entire desired list passed validation reaches
        # this phase.  Network/JSON/digest errors therefore cannot masquerade as
        # an empty desired set and revoke everything.
        for capability_id in sorted(set(entries) - desired_ids):
            entry = entries[capability_id]
            if entry.active is not None:
                entry.stale.insert(0, entry.active)
                entry.active = None
                try:
                    _write_ledger(path, entries)
                except ManagedPortableLedgerError as exc:
                    # Do not delete without first persisting the tombstone.
                    entry.active = entry.stale.pop(0)
                    _issue(result, capability_id, str(exc))
                    continue
            for message in _cleanup_stale(
                entry,
                capability_id=capability_id,
                avatar_registry=avatars,
                group_registry=groups,
            ):
                _issue(result, capability_id, message)
            if not entry.stale:
                entries.pop(capability_id, None)
                result.removed.append(capability_id)
            try:
                _write_ledger(path, entries)
            except ManagedPortableLedgerError as exc:
                # The previous on-disk tombstone remains safe and will be
                # compacted on the next successful reconcile.
                _issue(result, capability_id, str(exc))

        result.entries = entries
        return result


__all__ = [
    "MANAGED_CREATED_BY",
    "MANAGED_LEDGER_SCHEMA_VERSION",
    "MAX_MANAGED_PACKAGES",
    "MAX_MANAGED_REQUEST_BYTES",
    "ManagedPortableError",
    "ManagedPortableIssue",
    "ManagedPortableLedgerError",
    "ManagedPortableReconcileResult",
    "ManagedPortableRequestError",
    "ManagedPortableSpec",
    "managed_portable_ledger_path",
    "reconcile_managed_portable_packages",
    "validate_managed_package_specs",
]
