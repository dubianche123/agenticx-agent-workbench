"""Desktop enterprise self-service policy, read from the global config only.

The renderer hides managed-off entry points, but the Agent runtime must enforce
the same decision: a model can call installation tools without ever opening
Settings.  Reads deliberately bypass project config so a workspace cannot
override an administrator-delivered policy.
"""

from __future__ import annotations

import logging
from typing import Any

from agenticx.cli.config_manager import ConfigManager

logger = logging.getLogger(__name__)


def _enterprise_config() -> dict[str, Any] | None:
    try:
        config = ConfigManager._load_yaml(ConfigManager.GLOBAL_CONFIG_PATH)
    except Exception:
        # Existing non-enterprise installations must keep working if their
        # config cannot be read.  The renderer/main process still provide the
        # first two enforcement layers.
        logger.warning("enterprise capability policy unreadable", exc_info=True)
        return None
    enterprise = config.get("enterprise") if isinstance(config, dict) else None
    if not isinstance(enterprise, dict):
        return None
    if enterprise.get("enabled") is not True or not str(
        enterprise.get("token") or ""
    ).strip():
        return None
    return enterprise


def _capability_value(*, snake: str, camel: str) -> bool:
    enterprise = _enterprise_config()
    if enterprise is None:
        return True
    policy = enterprise.get("policy")
    capabilities: Any = (
        policy.get("capability_policy") if isinstance(policy, dict) else None
    )
    if not isinstance(capabilities, dict):
        return True
    # Only a real boolean false locks the capability.  Unknown/malformed data
    # keeps the pre-policy behavior for old tenants.
    return (
        capabilities.get(snake) is not False
        and capabilities.get(camel) is not False
    )


def local_skill_install_allowed() -> bool:
    return _capability_value(
        snake="allow_local_skill_install",
        camel="allowLocalSkillInstall",
    )


def _skill_coordinate(value: Any) -> tuple[str, str]:
    """Return a normalized ``(slug, namespace)`` marketplace coordinate."""
    raw = str(value or "").strip()
    if raw.startswith("@") and "/" in raw:
        namespace, slug = raw[1:].split("/", 1)
        return slug.strip("/").strip().lower(), namespace.strip().lstrip("@").lower()
    return raw.strip("/").lower(), ""


def enterprise_skill_marketplace_approved(
    skill_name: str,
    namespace: str = "",
) -> bool:
    """Whether the active enterprise capability list approves this Skill.

    Scoped approvals match the same publisher exactly.  A deliberately bare
    capability name approves that slug without inventing a publisher.  This
    mirrors the Desktop main-process guard so calling the local HTTP API cannot
    bypass the marketplace restriction.
    """
    enterprise = _enterprise_config()
    if enterprise is None:
        return False
    requested_slug, parsed_namespace = _skill_coordinate(skill_name)
    requested_namespace = str(namespace or parsed_namespace).strip().lstrip("@").lower()
    if not requested_slug:
        return False
    capabilities = enterprise.get("capabilities")
    if not isinstance(capabilities, list):
        return False
    for capability in capabilities:
        if not isinstance(capability, dict) or capability.get("kind") != "skill":
            continue
        approved_slug, approved_namespace = _skill_coordinate(capability.get("name"))
        if approved_slug != requested_slug:
            continue
        if approved_namespace:
            if approved_namespace == requested_namespace:
                return True
            continue
        return True
    return False


def registry_skill_install_allowed(skill_name: str, namespace: str = "") -> bool:
    """Allow public installs, or an explicitly approved enterprise Skill."""
    if local_skill_install_allowed():
        return True
    return enterprise_skill_marketplace_approved(skill_name, namespace)


def local_mcp_install_allowed() -> bool:
    return _capability_value(
        snake="allow_local_mcp_install",
        camel="allowLocalMcpInstall",
    )


def mcp_auto_discovery_allowed() -> bool:
    return _capability_value(
        snake="allow_mcp_auto_discovery",
        camel="allowMcpAutoDiscovery",
    )
