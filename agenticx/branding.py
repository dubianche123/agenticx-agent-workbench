#!/usr/bin/env python3
"""Product branding constants (user-visible defaults).

Author: Damon Li
"""

APP_DISPLAY_NAME = "AgenticX Ontology"
DEFAULT_META_PRODUCT_LABEL = "个人助手"
# These labels remain accepted when resolving persisted legacy identities.
LEGACY_META_LABELS = frozenset(
    {
        "Near",
        "near",
        "Machi",
        "machi",
        "meta",
    }
)
