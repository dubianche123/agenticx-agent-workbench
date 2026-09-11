#!/usr/bin/env python3
"""Strict v2 portable packages for digital experts and expert teams.

The package contains declarative expert/team configuration, references to
registered Skill/MCP capabilities, optional reviewed Markdown resources, and
logical workspace mount requests. It never carries local registry ids,
absolute paths, credentials, model choices, chat history, or live memory.

Every import is parsed strictly and privacy-scanned again before any local
state is created. Resource files are installed under ``package_resources``;
they never overwrite the recipient's live ``MEMORY.md`` or other workspace
state.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import stat
import threading
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Literal, Mapping, Sequence, Tuple

from agenticx.avatar.group_chat import GroupChatConfig, GroupChatRegistry
from agenticx.avatar.package_scanner import (
    PackageContentBlockedError,
    PackageScanReport,
    PackageScanner,
)
from agenticx.avatar.registry import AvatarConfig, AvatarRegistry


SCHEMA_VERSION = 2
MAX_PACKAGE_BYTES = 256 * 1024
MAX_EXPERT_NAME_CHARS = 80
MAX_GROUP_NAME_CHARS = 120
MAX_DESCRIPTION_CHARS = 2_000
MAX_ROLE_CHARS = 160
MAX_SYSTEM_PROMPT_CHARS = 12_000
MAX_TAGS = 8
MAX_TAG_CHARS = 24
MAX_GROUP_MEMBERS = 12
MAX_DEPENDENCIES_PER_KIND = 32
MAX_RESOURCES = 24
MAX_RESOURCE_PATH_BYTES = 240
MAX_RESOURCE_BYTES = 64 * 1024
MAX_RESOURCE_TOTAL_BYTES = 192 * 1024
MAX_WORKSPACE_SLOTS = 8
MAX_PACKAGE_METADATA_BYTES = 64 * 1024

PackageKind = Literal["expert", "group"]
PermissionMode = Literal["plan", "ask", "auto"]

_ENVELOPE_KEYS = frozenset(
    {
        "schema_version",
        "artifact_id",
        "release_version",
        "kind",
        "title",
        "description",
        "recommended_permission_mode",
        "dependencies",
        "resources",
        "workspace_slots",
        "payload",
    }
)
_EXPERT_KEYS = frozenset(
    {
        "name",
        "role",
        "description",
        "tags",
        "system_prompt",
        "color",
        "default_permission_mode",
    }
)
_GROUP_KEYS = frozenset({"name", "members", "host_member_index", "routing"})
_DEPENDENCIES_KEYS = frozenset({"skills", "mcps"})
_SKILL_DEPENDENCY_KEYS = frozenset(
    {"capability_id", "version", "digest", "required"}
)
_MCP_DEPENDENCY_KEYS = frozenset({"capability_id", "version", "required"})
_RESOURCE_KEYS = frozenset({"path", "content", "digest"})
_WORKSPACE_SLOT_KEYS = frozenset({"name", "access", "required"})
_PACKAGE_METADATA_KEYS = frozenset(
    {
        "schema_version",
        "artifact_id",
        "release_version",
        "kind",
        "recommended_permission_mode",
        "dependencies",
        "workspace_slots",
        "resources",
    }
)
_COLORS = frozenset({"blue", "white", "black"})
_PERMISSION_MODES = frozenset({"plan", "ask", "auto"})
_ROUTING_MODES = frozenset(
    {"intelligent", "user-directed", "meta-routed", "round-robin", "team"}
)
_WORKSPACE_ACCESS_MODES = frozenset({"read-only", "read-write"})
_SAFE_ENTITY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_ARTIFACT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
_CAPABILITY_ID_RE = re.compile(
    r"^(?P<kind>skill|mcp):[0-9A-HJKMNP-TV-Z]{26}$"
)
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
_SEMVER_RE = re.compile(
    r"^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_WORKSPACE_SLOT_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_BIDI_CONTROL_CODEPOINTS = frozenset(
    {
        0x061C,
        0x200E,
        0x200F,
        0x202A,
        0x202B,
        0x202C,
        0x202D,
        0x202E,
        0x2066,
        0x2067,
        0x2068,
        0x2069,
    }
)
_IMPORT_LOCK = threading.RLock()


class PortablePackageError(ValueError):
    """Raised when a portable package is missing, malformed, or unsafe."""


class PortablePackageSecurityError(PortablePackageError):
    """A sanitised privacy report blocked publication/import."""

    def __init__(self, report: PackageScanReport):
        self.report = report
        labels = sorted(
            {
                f"{finding.rule_id} at {finding.field}:{finding.line}"
                for finding in report.findings
                if finding.blocking
            }
        )
        super().__init__("unsafe package content: " + ", ".join(labels))


class PortablePackageImportError(PortablePackageError):
    """Raised when a validated package cannot be installed atomically."""


@dataclass(frozen=True)
class PortablePackagePreview:
    """Mutation-free summary suitable for an import confirmation UI."""

    schema_version: int
    artifact_id: str
    release_version: str
    kind: PackageKind
    title: str
    description: str
    summary: str
    byte_size: int
    recommended_permission_mode: PermissionMode
    skill_dependencies: Tuple[str, ...] = ()
    mcp_dependencies: Tuple[str, ...] = ()
    resource_paths: Tuple[str, ...] = ()
    workspace_slots: Tuple[str, ...] = ()
    scan_report: PackageScanReport | None = None
    role: str = ""
    tags: Tuple[str, ...] = ()
    system_prompt: str = ""
    member_count: int = 0
    member_names: Tuple[str, ...] = ()
    member_roles: Tuple[str, ...] = ()
    member_system_prompts: Tuple[str, ...] = ()
    host_member_name: str = ""
    routing: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "artifact_id": self.artifact_id,
            "release_version": self.release_version,
            "kind": self.kind,
            "title": self.title,
            "description": self.description,
            "summary": self.summary,
            "byte_size": self.byte_size,
            "recommended_permission_mode": self.recommended_permission_mode,
            "skill_dependencies": list(self.skill_dependencies),
            "mcp_dependencies": list(self.mcp_dependencies),
            "resource_paths": list(self.resource_paths),
            "workspace_slots": list(self.workspace_slots),
            "scan_report": (
                self.scan_report.to_dict() if self.scan_report is not None else None
            ),
            "role": self.role,
            "tags": list(self.tags),
            "system_prompt": self.system_prompt,
            "member_count": self.member_count,
            "member_names": list(self.member_names),
            "member_roles": list(self.member_roles),
            "member_system_prompts": list(self.member_system_prompts),
            "host_member_name": self.host_member_name,
            "routing": self.routing,
        }


@dataclass(frozen=True)
class PortableImportResult:
    """Result of importing one expert or one complete expert team."""

    kind: PackageKind
    preview: PortablePackagePreview
    expert: AvatarConfig | None = None
    group: GroupChatConfig | None = None
    members: Tuple[AvatarConfig, ...] = ()

    @property
    def created_avatar_ids(self) -> Tuple[str, ...]:
        if self.expert is not None:
            return (self.expert.id,)
        return tuple(member.id for member in self.members)


@dataclass(frozen=True)
class PortablePackageBundleSnapshot:
    """Exact validated package baseline used to roll back managed updates."""

    metadata: bytes
    resources: Tuple[tuple[str, bytes], ...] = ()


def _reject_json_constant(value: str) -> None:
    raise PortablePackageError(f"non-standard JSON constant is not allowed: {value}")


def _strict_object(pairs: Sequence[tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PortablePackageError(f"duplicate JSON key is not allowed: {key}")
        result[key] = value
    return result


def _decode_json(raw: str | bytes | bytearray) -> tuple[Any, int]:
    if isinstance(raw, (bytes, bytearray)):
        encoded = bytes(raw)
        if len(encoded) > MAX_PACKAGE_BYTES:
            raise PortablePackageError(
                f"package exceeds {MAX_PACKAGE_BYTES} byte limit"
            )
        try:
            text = encoded.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PortablePackageError("package must be UTF-8 JSON") from exc
    elif isinstance(raw, str):
        try:
            encoded = raw.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise PortablePackageError("package must contain valid Unicode") from exc
        if len(encoded) > MAX_PACKAGE_BYTES:
            raise PortablePackageError(
                f"package exceeds {MAX_PACKAGE_BYTES} byte limit"
            )
        text = raw
    else:
        raise PortablePackageError("package must be a JSON string or UTF-8 bytes")

    try:
        document = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except PortablePackageError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise PortablePackageError("package is not valid JSON") from exc
    return document, len(encoded)


def _expect_object(value: Any, field: str) -> Mapping[str, Any]:
    if type(value) is not dict:
        raise PortablePackageError(f"{field} must be an object")
    return value


def _expect_exact_keys(
    value: Mapping[str, Any],
    *,
    allowed: frozenset[str],
    required: frozenset[str],
    field: str,
) -> None:
    keys = set(value)
    unknown = sorted(keys - allowed)
    if unknown:
        raise PortablePackageError(
            f"{field} contains unknown field(s): {', '.join(unknown)}"
        )
    missing = sorted(required - keys)
    if missing:
        raise PortablePackageError(
            f"{field} is missing required field(s): {', '.join(missing)}"
        )


def _validate_unicode(value: str, *, field: str, single_line: bool = False) -> None:
    for char in value:
        codepoint = ord(char)
        if 0xD800 <= codepoint <= 0xDFFF:
            raise PortablePackageError(
                f"{field} cannot contain Unicode surrogate code points"
            )
        if codepoint in _BIDI_CONTROL_CODEPOINTS:
            raise PortablePackageError(
                f"{field} cannot contain Unicode direction controls"
            )
        if codepoint < 0x20 and char not in {"\n", "\r", "\t"}:
            raise PortablePackageError(f"{field} cannot contain control characters")
        if 0x7F <= codepoint <= 0x9F:
            raise PortablePackageError(f"{field} cannot contain control characters")
        if single_line and (
            char in {"\n", "\r", "\t"} or codepoint in {0x2028, 0x2029}
        ):
            raise PortablePackageError(f"{field} must be a single line")


def _bounded_string(
    value: Any,
    *,
    field: str,
    max_chars: int,
    required: bool = False,
    single_line: bool = False,
) -> str:
    if type(value) is not str:
        raise PortablePackageError(f"{field} must be a string")
    normalized = value.strip()
    if required and not normalized:
        raise PortablePackageError(f"{field} cannot be empty")
    if len(normalized) > max_chars:
        raise PortablePackageError(f"{field} exceeds {max_chars} character limit")
    _validate_unicode(normalized, field=field, single_line=single_line)
    return normalized


def _exact_text(value: Any, *, field: str, max_bytes: int) -> str:
    if type(value) is not str:
        raise PortablePackageError(f"{field} must be a string")
    _validate_unicode(value, field=field)
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise PortablePackageError(f"{field} must be valid UTF-8") from exc
    if len(encoded) > max_bytes:
        raise PortablePackageError(f"{field} exceeds {max_bytes} byte limit")
    return value


def _validate_semver(value: Any, *, field: str) -> str:
    version = _bounded_string(
        value,
        field=field,
        max_chars=64,
        required=True,
        single_line=True,
    )
    if not _SEMVER_RE.fullmatch(version):
        raise PortablePackageError(f"{field} must be a valid SemVer version")
    return version


def _validate_digest(value: Any, *, field: str) -> str:
    digest = _bounded_string(
        value,
        field=field,
        max_chars=64,
        required=True,
        single_line=True,
    ).lower()
    if not _DIGEST_RE.fullmatch(digest):
        raise PortablePackageError(f"{field} must be a SHA-256 digest")
    return digest


def _validate_required(value: Any, *, field: str) -> bool:
    if type(value) is not bool:
        raise PortablePackageError(f"{field} must be a boolean")
    return value


def _validate_tags(value: Any, *, field: str) -> list[str]:
    if type(value) is not list:
        raise PortablePackageError(f"{field} must be an array")
    if len(value) > MAX_TAGS:
        raise PortablePackageError(f"{field} exceeds {MAX_TAGS} tag limit")
    tags: list[str] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        tag = _bounded_string(
            raw,
            field=f"{field}[{index}]",
            max_chars=MAX_TAG_CHARS,
            required=True,
            single_line=True,
        )
        folded = tag.casefold()
        if folded in seen:
            raise PortablePackageError(f"{field} contains duplicate tag: {tag}")
        seen.add(folded)
        tags.append(tag)
    return tags


def _validate_expert_declaration(value: Any, *, field: str) -> Dict[str, Any]:
    obj = _expect_object(value, field)
    _expect_exact_keys(
        obj,
        allowed=_EXPERT_KEYS,
        required=_EXPERT_KEYS,
        field=field,
    )
    color = _bounded_string(
        obj.get("color"),
        field=f"{field}.color",
        max_chars=16,
        required=True,
        single_line=True,
    ).lower()
    if color not in _COLORS:
        raise PortablePackageError(
            f"{field}.color must be one of: {', '.join(sorted(_COLORS))}"
        )
    permission_mode = _bounded_string(
        obj.get("default_permission_mode"),
        field=f"{field}.default_permission_mode",
        max_chars=8,
        required=True,
        single_line=True,
    )
    if permission_mode not in _PERMISSION_MODES:
        raise PortablePackageError(
            f"{field}.default_permission_mode must be one of: {', '.join(sorted(_PERMISSION_MODES))}"
        )
    return {
        "name": _bounded_string(
            obj.get("name"),
            field=f"{field}.name",
            max_chars=MAX_EXPERT_NAME_CHARS,
            required=True,
            single_line=True,
        ),
        "role": _bounded_string(
            obj.get("role"),
            field=f"{field}.role",
            max_chars=MAX_ROLE_CHARS,
            single_line=True,
        ),
        "description": _bounded_string(
            obj.get("description"),
            field=f"{field}.description",
            max_chars=MAX_DESCRIPTION_CHARS,
        ),
        "tags": _validate_tags(obj.get("tags"), field=f"{field}.tags"),
        "system_prompt": _bounded_string(
            obj.get("system_prompt"),
            field=f"{field}.system_prompt",
            max_chars=MAX_SYSTEM_PROMPT_CHARS,
        ),
        "color": color,
        "default_permission_mode": permission_mode,
    }


def _validate_group_declaration(value: Any, *, field: str) -> Dict[str, Any]:
    obj = _expect_object(value, field)
    _expect_exact_keys(
        obj,
        allowed=_GROUP_KEYS,
        required=_GROUP_KEYS,
        field=field,
    )
    members_raw = obj.get("members")
    if type(members_raw) is not list:
        raise PortablePackageError(f"{field}.members must be an array")
    if not members_raw:
        raise PortablePackageError(f"{field}.members must contain at least one expert")
    if len(members_raw) > MAX_GROUP_MEMBERS:
        raise PortablePackageError(
            f"{field}.members exceeds {MAX_GROUP_MEMBERS} member limit"
        )
    members = [
        _validate_expert_declaration(member, field=f"{field}.members[{index}]")
        for index, member in enumerate(members_raw)
    ]
    host_index = obj.get("host_member_index")
    if type(host_index) is not int:
        raise PortablePackageError(f"{field}.host_member_index must be an integer")
    if host_index < 0 or host_index >= len(members):
        raise PortablePackageError(
            f"{field}.host_member_index must reference an existing member"
        )
    routing = _bounded_string(
        obj.get("routing"),
        field=f"{field}.routing",
        max_chars=32,
        required=True,
        single_line=True,
    )
    if routing not in _ROUTING_MODES:
        raise PortablePackageError(
            f"{field}.routing must be one of: {', '.join(sorted(_ROUTING_MODES))}"
        )
    return {
        "name": _bounded_string(
            obj.get("name"),
            field=f"{field}.name",
            max_chars=MAX_GROUP_NAME_CHARS,
            required=True,
            single_line=True,
        ),
        "members": members,
        "host_member_index": host_index,
        "routing": routing,
    }


def _validate_capability_id(value: Any, *, field: str, kind: str) -> str:
    capability_id = _bounded_string(
        value,
        field=field,
        max_chars=160,
        required=True,
        single_line=True,
    )
    matched = _CAPABILITY_ID_RE.fullmatch(capability_id)
    if matched is None or matched.group("kind") != kind:
        raise PortablePackageError(
            f"{field} must be a canonical {kind}:<ULID> capability reference"
        )
    return capability_id


def _validate_dependencies(value: Any, *, field: str) -> Dict[str, Any]:
    obj = _expect_object(value, field)
    _expect_exact_keys(
        obj,
        allowed=_DEPENDENCIES_KEYS,
        required=_DEPENDENCIES_KEYS,
        field=field,
    )
    skills_raw = obj.get("skills")
    mcps_raw = obj.get("mcps")
    if type(skills_raw) is not list:
        raise PortablePackageError(f"{field}.skills must be an array")
    if type(mcps_raw) is not list:
        raise PortablePackageError(f"{field}.mcps must be an array")
    if len(skills_raw) > MAX_DEPENDENCIES_PER_KIND:
        raise PortablePackageError(
            f"{field}.skills exceeds {MAX_DEPENDENCIES_PER_KIND} dependency limit"
        )
    if len(mcps_raw) > MAX_DEPENDENCIES_PER_KIND:
        raise PortablePackageError(
            f"{field}.mcps exceeds {MAX_DEPENDENCIES_PER_KIND} dependency limit"
        )

    skills: list[Dict[str, Any]] = []
    skill_ids: set[str] = set()
    for index, raw in enumerate(skills_raw):
        item_field = f"{field}.skills[{index}]"
        item = _expect_object(raw, item_field)
        _expect_exact_keys(
            item,
            allowed=_SKILL_DEPENDENCY_KEYS,
            required=_SKILL_DEPENDENCY_KEYS,
            field=item_field,
        )
        capability_id = _validate_capability_id(
            item.get("capability_id"),
            field=f"{item_field}.capability_id",
            kind="skill",
        )
        if capability_id in skill_ids:
            raise PortablePackageError(
                f"{field}.skills contains duplicate dependency: {capability_id}"
            )
        skill_ids.add(capability_id)
        skills.append(
            {
                "capability_id": capability_id,
                "version": _validate_semver(
                    item.get("version"), field=f"{item_field}.version"
                ),
                "digest": _validate_digest(
                    item.get("digest"), field=f"{item_field}.digest"
                ),
                "required": _validate_required(
                    item.get("required"), field=f"{item_field}.required"
                ),
            }
        )

    mcps: list[Dict[str, Any]] = []
    mcp_ids: set[str] = set()
    for index, raw in enumerate(mcps_raw):
        item_field = f"{field}.mcps[{index}]"
        item = _expect_object(raw, item_field)
        _expect_exact_keys(
            item,
            allowed=_MCP_DEPENDENCY_KEYS,
            required=_MCP_DEPENDENCY_KEYS,
            field=item_field,
        )
        capability_id = _validate_capability_id(
            item.get("capability_id"),
            field=f"{item_field}.capability_id",
            kind="mcp",
        )
        if capability_id in mcp_ids:
            raise PortablePackageError(
                f"{field}.mcps contains duplicate dependency: {capability_id}"
            )
        mcp_ids.add(capability_id)
        mcps.append(
            {
                "capability_id": capability_id,
                "version": _validate_semver(
                    item.get("version"), field=f"{item_field}.version"
                ),
                "required": _validate_required(
                    item.get("required"), field=f"{item_field}.required"
                ),
            }
        )
    return {"skills": skills, "mcps": mcps}


def _validate_resource_path(value: Any, *, field: str) -> str:
    path = _bounded_string(
        value,
        field=field,
        max_chars=MAX_RESOURCE_PATH_BYTES,
        required=True,
        single_line=True,
    )
    if len(path.encode("utf-8")) > MAX_RESOURCE_PATH_BYTES:
        raise PortablePackageError(
            f"{field} exceeds {MAX_RESOURCE_PATH_BYTES} byte limit"
        )
    if path.startswith("/") or "\\" in path or ":" in path:
        raise PortablePackageError(f"{field} must be a safe relative POSIX path")
    if unicodedata.normalize("NFC", path) != path:
        raise PortablePackageError(f"{field} must use Unicode NFC normalization")
    normalized_path = str(PurePosixPath(path))
    if normalized_path != path:
        raise PortablePackageError(f"{field} must use a canonical POSIX path")
    parts = PurePosixPath(path).parts
    if not parts or len(parts) > 8 or any(part in {"", ".", ".."} for part in parts):
        raise PortablePackageError(f"{field} must be a safe relative POSIX path")
    if not path.lower().endswith(".md"):
        raise PortablePackageError(f"{field} must name a Markdown (.md) file")
    return path


def _validate_resources(value: Any, *, field: str) -> list[Dict[str, Any]]:
    if type(value) is not list:
        raise PortablePackageError(f"{field} must be an array")
    if len(value) > MAX_RESOURCES:
        raise PortablePackageError(f"{field} exceeds {MAX_RESOURCES} resource limit")
    resources: list[Dict[str, Any]] = []
    seen_paths: set[str] = set()
    total_bytes = 0
    for index, raw in enumerate(value):
        item_field = f"{field}[{index}]"
        item = _expect_object(raw, item_field)
        _expect_exact_keys(
            item,
            allowed=_RESOURCE_KEYS,
            required=_RESOURCE_KEYS,
            field=item_field,
        )
        path = _validate_resource_path(item.get("path"), field=f"{item_field}.path")
        folded = unicodedata.normalize("NFC", path).casefold()
        if folded in seen_paths:
            raise PortablePackageError(f"{field} contains duplicate path: {path}")
        seen_paths.add(folded)
        content = _exact_text(
            item.get("content"),
            field=f"{item_field}.content",
            max_bytes=MAX_RESOURCE_BYTES,
        )
        encoded = content.encode("utf-8")
        total_bytes += len(encoded)
        if total_bytes > MAX_RESOURCE_TOTAL_BYTES:
            raise PortablePackageError(
                f"{field} exceeds {MAX_RESOURCE_TOTAL_BYTES} total byte limit"
            )
        digest = _validate_digest(
            item.get("digest"), field=f"{item_field}.digest"
        )
        actual_digest = hashlib.sha256(encoded).hexdigest()
        if digest != actual_digest:
            raise PortablePackageError(f"{item_field}.digest does not match content")
        resources.append({"path": path, "content": content, "digest": digest})
    return resources


def _validate_workspace_slots(value: Any, *, field: str) -> list[Dict[str, Any]]:
    if type(value) is not list:
        raise PortablePackageError(f"{field} must be an array")
    if len(value) > MAX_WORKSPACE_SLOTS:
        raise PortablePackageError(
            f"{field} exceeds {MAX_WORKSPACE_SLOTS} workspace slot limit"
        )
    slots: list[Dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        item_field = f"{field}[{index}]"
        item = _expect_object(raw, item_field)
        _expect_exact_keys(
            item,
            allowed=_WORKSPACE_SLOT_KEYS,
            required=_WORKSPACE_SLOT_KEYS,
            field=item_field,
        )
        name = _bounded_string(
            item.get("name"),
            field=f"{item_field}.name",
            max_chars=64,
            required=True,
            single_line=True,
        )
        if not _WORKSPACE_SLOT_RE.fullmatch(name):
            raise PortablePackageError(
                f"{item_field}.name must be a logical workspace slot name"
            )
        if name in seen:
            raise PortablePackageError(f"{field} contains duplicate slot: {name}")
        seen.add(name)
        access = _bounded_string(
            item.get("access"),
            field=f"{item_field}.access",
            max_chars=16,
            required=True,
            single_line=True,
        )
        if access not in _WORKSPACE_ACCESS_MODES:
            raise PortablePackageError(
                f"{item_field}.access must be 'read-only' or 'read-write'"
            )
        slots.append(
            {
                "name": name,
                "access": access,
                "required": _validate_required(
                    item.get("required"), field=f"{item_field}.required"
                ),
            }
        )
    return slots


def _validate_document(value: Any) -> Dict[str, Any]:
    envelope = _expect_object(value, "package")
    _expect_exact_keys(
        envelope,
        allowed=_ENVELOPE_KEYS,
        required=_ENVELOPE_KEYS,
        field="package",
    )
    version = envelope.get("schema_version")
    if type(version) is not int or version != SCHEMA_VERSION:
        raise PortablePackageError(
            f"schema_version must be the integer {SCHEMA_VERSION}"
        )
    artifact_id = _bounded_string(
        envelope.get("artifact_id"),
        field="package.artifact_id",
        max_chars=128,
        required=True,
        single_line=True,
    )
    if not _ARTIFACT_ID_RE.fullmatch(artifact_id):
        raise PortablePackageError("package.artifact_id is not a safe stable id")
    release_version = _validate_semver(
        envelope.get("release_version"), field="package.release_version"
    )
    kind = envelope.get("kind")
    if type(kind) is not str or kind not in {"expert", "group"}:
        raise PortablePackageError("kind must be 'expert' or 'group'")
    title = _bounded_string(
        envelope.get("title"),
        field="package.title",
        max_chars=MAX_GROUP_NAME_CHARS,
        required=True,
        single_line=True,
    )
    description = _bounded_string(
        envelope.get("description"),
        field="package.description",
        max_chars=MAX_DESCRIPTION_CHARS,
    )
    permission_mode = _bounded_string(
        envelope.get("recommended_permission_mode"),
        field="package.recommended_permission_mode",
        max_chars=8,
        required=True,
        single_line=True,
    )
    if permission_mode not in _PERMISSION_MODES:
        raise PortablePackageError(
            "package.recommended_permission_mode must be 'plan', 'ask', or 'auto'"
        )
    dependencies = _validate_dependencies(
        envelope.get("dependencies"), field="package.dependencies"
    )
    resources = _validate_resources(
        envelope.get("resources"), field="package.resources"
    )
    workspace_slots = _validate_workspace_slots(
        envelope.get("workspace_slots"), field="package.workspace_slots"
    )

    if kind == "expert":
        payload = _validate_expert_declaration(envelope.get("payload"), field="payload")
        if title != payload["name"]:
            raise PortablePackageError("package.title must match payload.name")
        if description != payload["description"]:
            raise PortablePackageError(
                "package.description must match payload.description for an expert"
            )
    else:
        payload = _validate_group_declaration(envelope.get("payload"), field="payload")
        if title != payload["name"]:
            raise PortablePackageError("package.title must match payload.name")

    return {
        "schema_version": SCHEMA_VERSION,
        "artifact_id": artifact_id,
        "release_version": release_version,
        "kind": kind,
        "title": title,
        "description": description,
        "recommended_permission_mode": permission_mode,
        "dependencies": dependencies,
        "resources": resources,
        "workspace_slots": workspace_slots,
        "payload": payload,
    }


def _scan_fields(document: Mapping[str, Any]) -> Dict[str, str]:
    fields: Dict[str, str] = {
        "package.artifact_id": str(document["artifact_id"]),
        "package.release_version": str(document["release_version"]),
        "package.title": str(document["title"]),
        "package.description": str(document["description"]),
    }

    def collect_strings(value: Any, field: str) -> None:
        if isinstance(value, str):
            fields[field] = value
        elif isinstance(value, list):
            for index, item in enumerate(value):
                collect_strings(item, f"{field}[{index}]")
        elif isinstance(value, Mapping):
            for key, item in value.items():
                collect_strings(item, f"{field}.{key}")

    # Keep this list aligned with the enterprise authoritative scanner: every
    # uploader-controlled payload string is checked before it can be sent to
    # Portal, including color/permission/routing metadata.
    collect_strings(document["payload"], "payload")
    for index, resource in enumerate(document["resources"]):
        fields[f"resources[{index}].path"] = str(resource["path"])
        fields[f"resources[{index}].content"] = str(resource["content"])
    dependencies = document["dependencies"]
    for index, dependency in enumerate(dependencies["skills"]):
        fields[f"dependencies.skills[{index}].capability_id"] = str(
            dependency["capability_id"]
        )
        fields[f"dependencies.skills[{index}].version"] = str(dependency["version"])
    for index, dependency in enumerate(dependencies["mcps"]):
        fields[f"dependencies.mcps[{index}].capability_id"] = str(
            dependency["capability_id"]
        )
        fields[f"dependencies.mcps[{index}].version"] = str(dependency["version"])
    return fields


def _scan_document(
    document: Mapping[str, Any], *, block: bool
) -> PackageScanReport:
    scanner = PackageScanner()
    try:
        if block:
            return scanner.scan_and_block(_scan_fields(document))
        return scanner.scan_fields(_scan_fields(document))
    except PackageContentBlockedError as exc:
        raise PortablePackageSecurityError(exc.report) from exc


def _parse_document(raw: str | bytes | bytearray) -> tuple[Dict[str, Any], int]:
    document, byte_size = _decode_json(raw)
    return _validate_document(document), byte_size


def _load_document(raw: str | bytes | bytearray) -> tuple[Dict[str, Any], int]:
    """Parse and re-scan an untrusted package before callers may mutate state."""
    document, byte_size = _parse_document(raw)
    _scan_document(document, block=True)
    return document, byte_size


def scan_portable_package(raw: str | bytes | bytearray) -> PackageScanReport:
    """Validate a package and return a sanitised report without installing it."""
    document, _ = _parse_document(raw)
    return _scan_document(document, block=False)


def _serialize_document(
    document: Mapping[str, Any], *, allow_scan_findings: bool = False
) -> str:
    normalized = _validate_document(dict(document))
    # Market publication needs a reviewable package so the desktop can show a
    # safe finding report before asking whether to redact.  Ordinary file
    # export/share and every import keep the historical fail-closed behavior.
    _scan_document(normalized, block=not allow_scan_findings)
    text = json.dumps(
        normalized,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    if len(text.encode("utf-8")) > MAX_PACKAGE_BYTES:
        raise PortablePackageError(
            f"package exceeds {MAX_PACKAGE_BYTES} byte limit"
        )
    return text


def make_portable_resource(path: str, content: str) -> Dict[str, str]:
    """Create one digest-bound Markdown resource for an export request."""
    if type(content) is not str:
        raise PortablePackageError("resource content must be a string")
    try:
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    except UnicodeEncodeError as exc:
        raise PortablePackageError("resource content must be valid UTF-8") from exc
    resource = {"path": path, "content": content, "digest": digest}
    return _validate_resources([resource], field="resources")[0]


def _default_artifact_id(kind: PackageKind, entity_id: str) -> str:
    stable = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"https://agenticx.local/portable/{kind}/{entity_id}",
    )
    return f"{kind}:{stable.hex}"


def _expert_declaration(config: AvatarConfig) -> Dict[str, Any]:
    """Project one local expert onto the portable declaration whitelist."""
    return _validate_expert_declaration(
        {
            "name": config.name,
            "role": config.role or "",
            "description": config.description or "",
            "tags": list(config.tags or []),
            "system_prompt": config.system_prompt or "",
            "color": config.color or "blue",
            "default_permission_mode": config.default_permission_mode or "ask",
        },
        field="payload",
    )


def _base_envelope(
    *,
    kind: PackageKind,
    entity_id: str,
    artifact_id: str | None,
    release_version: str,
    title: str,
    description: str,
    recommended_permission_mode: str,
    dependencies: Mapping[str, Any] | None,
    resources: Sequence[Mapping[str, Any]] | None,
    workspace_slots: Sequence[Mapping[str, Any]] | None,
    payload: Mapping[str, Any],
) -> Dict[str, Any]:
    prepared_resources: list[Dict[str, Any]] = []
    for raw in resources or ():
        item = dict(raw)
        if set(item) == {"path", "content"} and type(item.get("content")) is str:
            item["digest"] = hashlib.sha256(item["content"].encode("utf-8")).hexdigest()
        prepared_resources.append(item)
    return {
        "schema_version": SCHEMA_VERSION,
        "artifact_id": artifact_id or _default_artifact_id(kind, entity_id),
        "release_version": release_version,
        "kind": kind,
        "title": title,
        "description": description,
        "recommended_permission_mode": recommended_permission_mode,
        "dependencies": dict(dependencies or {"skills": [], "mcps": []}),
        "resources": prepared_resources,
        "workspace_slots": [dict(slot) for slot in (workspace_slots or ())],
        "payload": dict(payload),
    }


def _preview(document: Mapping[str, Any], byte_size: int) -> PortablePackagePreview:
    kind = document["kind"]
    payload = document["payload"]
    dependencies = document["dependencies"]
    common = {
        "schema_version": SCHEMA_VERSION,
        "artifact_id": str(document["artifact_id"]),
        "release_version": str(document["release_version"]),
        "title": str(document["title"]),
        "description": str(document["description"]),
        "byte_size": byte_size,
        "recommended_permission_mode": str(document["recommended_permission_mode"]),
        "skill_dependencies": tuple(
            str(item["capability_id"]) for item in dependencies["skills"]
        ),
        "mcp_dependencies": tuple(
            str(item["capability_id"]) for item in dependencies["mcps"]
        ),
        "resource_paths": tuple(
            str(resource["path"]) for resource in document["resources"]
        ),
        "workspace_slots": tuple(
            str(slot["name"]) for slot in document["workspace_slots"]
        ),
        "scan_report": _scan_document(document, block=False),
    }
    if kind == "expert":
        role = str(payload["role"])
        description = str(document["description"])
        return PortablePackagePreview(
            kind="expert",
            summary=description or role or str(document["title"]),
            role=role,
            tags=tuple(str(tag) for tag in payload["tags"]),
            system_prompt=str(payload["system_prompt"]),
            **common,
        )

    members = payload["members"]
    member_names = tuple(str(member["name"]) for member in members)
    member_roles = tuple(str(member["role"]) for member in members)
    member_system_prompts = tuple(str(member["system_prompt"]) for member in members)
    host_index = int(payload["host_member_index"])
    description = str(document["description"])
    host_name = member_names[host_index]
    return PortablePackagePreview(
        kind="group",
        summary=description or f"{len(member_names)} 位成员，主持专家：{host_name}",
        member_count=len(member_names),
        member_names=member_names,
        member_roles=member_roles,
        member_system_prompts=member_system_prompts,
        host_member_name=host_name,
        routing=str(payload["routing"]),
        **common,
    )


def preview_portable_package(raw: str | bytes | bytearray) -> PortablePackagePreview:
    """Validate and re-scan a package, then return a display summary."""
    document, byte_size = _load_document(raw)
    return _preview(document, byte_size)


def export_expert_package(
    avatar_id: str,
    *,
    avatar_registry: AvatarRegistry | None = None,
    artifact_id: str | None = None,
    release_version: str | None = None,
    recommended_permission_mode: str = "ask",
    dependencies: Mapping[str, Any] | None = None,
    resources: Sequence[Mapping[str, Any]] | None = None,
    workspace_slots: Sequence[Mapping[str, Any]] | None = None,
    allow_scan_findings: bool = False,
) -> str:
    """Export one local expert as a strict, scanned v2 JSON envelope."""
    registry = avatar_registry or AvatarRegistry()
    safe_id = str(avatar_id or "").strip()
    if not _SAFE_ENTITY_ID_RE.fullmatch(safe_id):
        raise PortablePackageError("expert not found")
    config = registry.ensure_portable_identity(safe_id)
    if config is None:
        raise PortablePackageError(f"expert not found: {avatar_id}")
    payload = _expert_declaration(config)
    return _serialize_document(
        _base_envelope(
            kind="expert",
            entity_id=safe_id,
            artifact_id=artifact_id or config.portable_artifact_id,
            release_version=release_version or config.portable_release_version,
            title=payload["name"],
            description=payload["description"],
            recommended_permission_mode=recommended_permission_mode,
            dependencies=dependencies,
            resources=resources,
            workspace_slots=workspace_slots,
            payload=payload,
        ),
        allow_scan_findings=allow_scan_findings,
    )


def export_group_package(
    group_id: str,
    *,
    avatar_registry: AvatarRegistry | None = None,
    group_registry: GroupChatRegistry | None = None,
    artifact_id: str | None = None,
    release_version: str | None = None,
    recommended_permission_mode: str = "ask",
    dependencies: Mapping[str, Any] | None = None,
    resources: Sequence[Mapping[str, Any]] | None = None,
    workspace_slots: Sequence[Mapping[str, Any]] | None = None,
    allow_scan_findings: bool = False,
) -> str:
    """Export a team, routing included, without any local member ids."""
    avatars = avatar_registry or AvatarRegistry()
    groups = group_registry or GroupChatRegistry()
    safe_id = str(group_id or "").strip()
    if not _SAFE_ENTITY_ID_RE.fullmatch(safe_id):
        raise PortablePackageError("group not found")
    group = groups.ensure_portable_identity(safe_id)
    if group is None:
        raise PortablePackageError(f"group not found: {group_id}")
    if not group.avatar_ids:
        raise PortablePackageError("group has no members")
    if len(group.avatar_ids) > MAX_GROUP_MEMBERS:
        raise PortablePackageError(
            f"group exceeds {MAX_GROUP_MEMBERS} member limit"
        )
    if len(set(group.avatar_ids)) != len(group.avatar_ids):
        raise PortablePackageError("group contains duplicate member ids")

    members: list[Dict[str, Any]] = []
    for avatar_id in group.avatar_ids:
        if not _SAFE_ENTITY_ID_RE.fullmatch(str(avatar_id)):
            raise PortablePackageError("group member not found")
        config = avatars.get_avatar(avatar_id)
        if config is None:
            raise PortablePackageError("group member not found")
        members.append(_expert_declaration(config))
    try:
        host_index = group.avatar_ids.index(group.host_avatar_id)
    except ValueError:
        host_index = 0
    payload = {
        "name": group.name,
        "members": members,
        "host_member_index": host_index,
        "routing": group.routing,
    }
    return _serialize_document(
        _base_envelope(
            kind="group",
            entity_id=safe_id,
            artifact_id=artifact_id or group.portable_artifact_id,
            release_version=release_version or group.portable_release_version,
            title=group.name,
            description=group.description,
            recommended_permission_mode=recommended_permission_mode,
            dependencies=dependencies,
            resources=resources,
            workspace_slots=workspace_slots,
            payload=payload,
        ),
        allow_scan_findings=allow_scan_findings,
    )


def _unique_import_name(
    desired: str,
    existing_casefolded: set[str],
    *,
    max_chars: int,
) -> str:
    base = desired.strip()
    if base.casefold() not in existing_casefolded:
        existing_casefolded.add(base.casefold())
        return base
    counter = 1
    while True:
        suffix = "（导入）" if counter == 1 else f"（导入 {counter}）"
        candidate = f"{base[: max(1, max_chars - len(suffix))]}{suffix}"
        if candidate.casefold() not in existing_casefolded:
            existing_casefolded.add(candidate.casefold())
            return candidate
        counter += 1


def _rollback_created_entries(
    *,
    avatar_registry: AvatarRegistry,
    avatar_ids: Sequence[str],
    group_registry: GroupChatRegistry | None = None,
    group_ids: Sequence[str] = (),
) -> list[str]:
    """Remove only entities whose ids were returned to this import call."""
    errors: list[str] = []
    if group_registry is not None:
        for group_id in reversed(tuple(group_ids)):
            try:
                if not group_registry.delete_group(group_id):
                    errors.append(f"group {group_id}: delete returned false")
            except Exception as exc:
                errors.append(f"group {group_id}: {exc}")

    for avatar_id in reversed(tuple(avatar_ids)):
        try:
            if not avatar_registry.delete_avatar(avatar_id):
                errors.append(f"expert {avatar_id}: delete returned false")
        except Exception as exc:
            errors.append(f"expert {avatar_id}: {exc}")
    return errors


def _create_expert(
    declaration: Mapping[str, Any],
    *,
    registry: AvatarRegistry,
    existing_names: set[str],
) -> AvatarConfig:
    safe_name = _unique_import_name(
        str(declaration["name"]),
        existing_names,
        max_chars=MAX_EXPERT_NAME_CHARS,
    )
    # Capabilities and permissions remain declarations for the confirmation
    # layer. Importing untrusted data never grants them to the new expert.
    return registry.create_avatar(
        name=safe_name,
        role=str(declaration["role"]),
        system_prompt=str(declaration["system_prompt"]),
        description=str(declaration["description"]),
        tags=list(declaration["tags"]),
        created_by="portable_import",
        color=str(declaration["color"]),
        default_permission_mode=str(declaration["default_permission_mode"]),
    )


def _bundle_snapshot_from_document(
    document: Mapping[str, Any],
) -> PortablePackageBundleSnapshot:
    release_metadata = {
        "schema_version": SCHEMA_VERSION,
        "artifact_id": document["artifact_id"],
        "release_version": document["release_version"],
        "kind": document["kind"],
        "recommended_permission_mode": document["recommended_permission_mode"],
        "dependencies": document["dependencies"],
        "workspace_slots": document["workspace_slots"],
        "resources": [
            {"path": item["path"], "digest": item["digest"]}
            for item in document["resources"]
        ],
    }
    metadata = json.dumps(
        release_metadata,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    resources: list[tuple[str, bytes]] = []
    for item in document["resources"]:
        path = _validate_resource_path(item["path"], field="package resource path")
        content = str(item["content"]).encode("utf-8")
        digest = hashlib.sha256(content).hexdigest()
        if not hmac.compare_digest(digest, str(item["digest"])):
            raise PortablePackageImportError("package resource digest changed before install")
        resources.append((path, content))
    return PortablePackageBundleSnapshot(metadata=metadata, resources=tuple(resources))


def _path_exists(path: Path) -> bool:
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def _remove_bundle_path(path: Path) -> None:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return
    if stat.S_ISDIR(mode):
        shutil.rmtree(path)
    else:
        path.unlink()


def capture_package_bundle(
    workspace: Path,
) -> PortablePackageBundleSnapshot | None:
    """Capture only a fully verified package-owned bundle for rollback/comparison."""

    workspace = workspace.expanduser().resolve(strict=False)
    metadata_path = workspace / ".agenticx-package.json"
    if not _path_exists(metadata_path):
        return None
    try:
        metadata_stat = metadata_path.lstat()
        if (
            not stat.S_ISREG(metadata_stat.st_mode)
            or metadata_path.is_symlink()
            or metadata_stat.st_size > MAX_PACKAGE_METADATA_BYTES
        ):
            raise PortablePackageImportError("package metadata is not a safe regular file")
        metadata = metadata_path.read_bytes()
        parsed = json.loads(
            metadata.decode("utf-8"),
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except PortablePackageError:
        raise
    except (
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
        TypeError,
    ) as exc:
        raise PortablePackageImportError("package metadata cannot be verified") from exc
    if not isinstance(parsed, dict) or set(parsed) != _PACKAGE_METADATA_KEYS:
        raise PortablePackageImportError("package metadata has an invalid shape")
    if parsed.get("schema_version") != SCHEMA_VERSION:
        raise PortablePackageImportError("package metadata schema is unsupported")
    resources_value = parsed.get("resources")
    if not isinstance(resources_value, list) or len(resources_value) > MAX_RESOURCES:
        raise PortablePackageImportError("package metadata resources are invalid")

    resource_root = workspace / "package_resources"
    if resources_value:
        try:
            root_stat = resource_root.lstat()
        except FileNotFoundError as exc:
            raise PortablePackageImportError("package resource directory is missing") from exc
        if not stat.S_ISDIR(root_stat.st_mode) or resource_root.is_symlink():
            raise PortablePackageImportError("package resource directory is unsafe")
    root_resolved = resource_root.resolve(strict=False)
    resources: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    total_bytes = 0
    for index, raw in enumerate(resources_value):
        if not isinstance(raw, dict) or set(raw) != {"path", "digest"}:
            raise PortablePackageImportError("package resource metadata is invalid")
        path = _validate_resource_path(
            raw.get("path"), field=f"package metadata resources[{index}].path"
        )
        folded = unicodedata.normalize("NFC", path).casefold()
        if folded in seen:
            raise PortablePackageImportError("package resource metadata is duplicated")
        seen.add(folded)
        digest = _validate_digest(
            raw.get("digest"), field=f"package metadata resources[{index}].digest"
        )
        target = resource_root.joinpath(*PurePosixPath(path).parts)
        try:
            target.relative_to(resource_root)
            target.resolve(strict=False).relative_to(root_resolved)
            target_stat = target.lstat()
        except (OSError, ValueError) as exc:
            raise PortablePackageImportError("package resource path is unsafe") from exc
        if not stat.S_ISREG(target_stat.st_mode) or target.is_symlink():
            raise PortablePackageImportError("package resource is not a safe regular file")
        if target_stat.st_size > MAX_RESOURCE_BYTES:
            raise PortablePackageImportError("package resource exceeds the byte limit")
        try:
            content = target.read_bytes()
            content.decode("utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise PortablePackageImportError("package resource is not valid UTF-8") from exc
        total_bytes += len(content)
        if total_bytes > MAX_RESOURCE_TOTAL_BYTES:
            raise PortablePackageImportError("package resources exceed the total byte limit")
        if not hmac.compare_digest(hashlib.sha256(content).hexdigest(), digest):
            raise PortablePackageImportError("package resource digest does not match metadata")
        resources.append((path, content))
    return PortablePackageBundleSnapshot(metadata=metadata, resources=tuple(resources))


def restore_package_bundle(
    workspace: Path,
    snapshot: PortablePackageBundleSnapshot | None,
) -> None:
    """Atomically replace the package-owned baseline without touching live memory."""

    workspace = workspace.expanduser().resolve(strict=False)
    workspace.mkdir(parents=True, exist_ok=True)
    if not workspace.is_dir():
        raise PortablePackageImportError("package workspace is not a directory")

    token = uuid.uuid4().hex
    stage = workspace / f".agenticx-package-stage-{token}"
    backup_resources = workspace / f".agenticx-package-resources-backup-{token}"
    backup_metadata = workspace / f".agenticx-package-metadata-backup-{token}"
    resource_root = workspace / "package_resources"
    metadata_path = workspace / ".agenticx-package.json"
    stage.mkdir(mode=0o700)
    try:
        if snapshot is not None:
            if len(snapshot.metadata) > MAX_PACKAGE_METADATA_BYTES:
                raise PortablePackageImportError("package metadata exceeds the byte limit")
            stage_resources = stage / "package_resources"
            stage_resources.mkdir()
            for path, content in snapshot.resources:
                safe_path = _validate_resource_path(path, field="package resource path")
                if len(content) > MAX_RESOURCE_BYTES:
                    raise PortablePackageImportError("package resource exceeds the byte limit")
                target = stage_resources.joinpath(*PurePosixPath(safe_path).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            (stage / ".agenticx-package.json").write_bytes(snapshot.metadata)

        resources_backed_up = False
        metadata_backed_up = False
        try:
            if _path_exists(resource_root):
                os.replace(resource_root, backup_resources)
                resources_backed_up = True
            if _path_exists(metadata_path):
                os.replace(metadata_path, backup_metadata)
                metadata_backed_up = True
            if snapshot is not None:
                os.replace(stage / "package_resources", resource_root)
                os.replace(stage / ".agenticx-package.json", metadata_path)
        except Exception:
            _remove_bundle_path(resource_root)
            _remove_bundle_path(metadata_path)
            rollback_errors: list[Exception] = []
            try:
                if resources_backed_up and _path_exists(backup_resources):
                    os.replace(backup_resources, resource_root)
            except Exception as exc:
                rollback_errors.append(exc)
            try:
                if metadata_backed_up and _path_exists(backup_metadata):
                    os.replace(backup_metadata, metadata_path)
            except Exception as exc:
                rollback_errors.append(exc)
            if rollback_errors:
                raise PortablePackageImportError(
                    "package bundle rollback failed; backup was preserved"
                ) from rollback_errors[0]
            raise
        else:
            _remove_bundle_path(backup_resources)
            _remove_bundle_path(backup_metadata)
    except PortablePackageError:
        raise
    except Exception as exc:
        raise PortablePackageImportError("package bundle install failed") from exc
    finally:
        _remove_bundle_path(stage)


def package_bundle_matches(document: Mapping[str, Any], *, workspace: Path) -> bool:
    try:
        return capture_package_bundle(workspace) == _bundle_snapshot_from_document(document)
    except PortablePackageError:
        return False


def _install_package_bundle(
    document: Mapping[str, Any], *, workspace: Path
) -> PortablePackageBundleSnapshot | None:
    """Install one verified bundle and return its prior valid snapshot."""

    try:
        previous = capture_package_bundle(workspace)
    except PortablePackageError:
        # This directory is package-owned. A tampered/incomplete baseline is
        # replaced safely; it is never treated as rollback-worthy trusted data.
        previous = None
    restore_package_bundle(workspace, _bundle_snapshot_from_document(document))
    return previous


def import_portable_package(
    raw: str | bytes | bytearray,
    *,
    avatar_registry: AvatarRegistry | None = None,
    group_registry: GroupChatRegistry | None = None,
) -> PortableImportResult:
    """Re-scan, then atomically install one expert or complete expert team."""
    document, byte_size = _load_document(raw)
    preview = _preview(document, byte_size)
    avatars = avatar_registry or AvatarRegistry()

    with _IMPORT_LOCK:
        existing_avatar_names = {
            avatar.name.casefold() for avatar in avatars.list_avatars()
        }
        if document["kind"] == "expert":
            expert: AvatarConfig | None = None
            try:
                expert = _create_expert(
                    document["payload"],
                    registry=avatars,
                    existing_names=existing_avatar_names,
                )
                _install_package_bundle(
                    document,
                    workspace=Path(expert.workspace_dir),
                )
            except Exception as exc:
                cleanup_errors = _rollback_created_entries(
                    avatar_registry=avatars,
                    avatar_ids=(expert.id,) if expert is not None else (),
                )
                detail = f"expert import failed: {exc}"
                if cleanup_errors:
                    detail += f"; rollback errors: {'; '.join(cleanup_errors)}"
                raise PortablePackageImportError(detail) from exc
            return PortableImportResult(
                kind="expert",
                preview=preview,
                expert=expert,
            )

        groups = group_registry or GroupChatRegistry()
        existing_group_names = {group.name.casefold() for group in groups.list_groups()}
        created_members: list[AvatarConfig] = []
        created_group: GroupChatConfig | None = None
        try:
            payload = document["payload"]
            for declaration in payload["members"]:
                created_members.append(
                    _create_expert(
                        declaration,
                        registry=avatars,
                        existing_names=existing_avatar_names,
                    )
                )
            host_index = int(payload["host_member_index"])
            group_name = _unique_import_name(
                str(payload["name"]),
                existing_group_names,
                max_chars=MAX_GROUP_NAME_CHARS,
            )
            created_group = groups.create_group(
                name=group_name,
                avatar_ids=[member.id for member in created_members],
                routing=str(payload["routing"]),
                host_avatar_id=created_members[host_index].id,
                description=str(document.get("description", "") or ""),
                created_by="portable_import",
            )
            _install_package_bundle(
                document,
                workspace=Path(created_group.workspace_dir),
            )
        except Exception as exc:
            cleanup_errors = _rollback_created_entries(
                avatar_registry=avatars,
                avatar_ids=[member.id for member in created_members],
                group_registry=groups,
                group_ids=(created_group.id,) if created_group is not None else (),
            )
            detail = f"group import failed: {exc}"
            if cleanup_errors:
                detail += f"; rollback errors: {'; '.join(cleanup_errors)}"
            raise PortablePackageImportError(detail) from exc

        return PortableImportResult(
            kind="group",
            preview=preview,
            group=created_group,
            members=tuple(created_members),
        )


__all__ = [
    "MAX_DEPENDENCIES_PER_KIND",
    "MAX_DESCRIPTION_CHARS",
    "MAX_EXPERT_NAME_CHARS",
    "MAX_GROUP_MEMBERS",
    "MAX_GROUP_NAME_CHARS",
    "MAX_PACKAGE_BYTES",
    "MAX_RESOURCE_BYTES",
    "MAX_RESOURCES",
    "MAX_RESOURCE_TOTAL_BYTES",
    "MAX_ROLE_CHARS",
    "MAX_SYSTEM_PROMPT_CHARS",
    "MAX_TAGS",
    "MAX_TAG_CHARS",
    "MAX_WORKSPACE_SLOTS",
    "PortableImportResult",
    "PortablePackageError",
    "PortablePackageImportError",
    "PortablePackagePreview",
    "PortablePackageSecurityError",
    "SCHEMA_VERSION",
    "export_expert_package",
    "export_group_package",
    "import_portable_package",
    "make_portable_resource",
    "preview_portable_package",
    "scan_portable_package",
]
