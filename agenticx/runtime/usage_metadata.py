#!/usr/bin/env python3
"""Map LLM response usage fields to DeerFlow-style usage_metadata for SSE.

Supports extended fields used by usage accounting (cached / reasoning tokens).

Author: Damon Li
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from agenticx.llms.usage import has_token_usage, merge_token_usage, token_usage_dict

def _response_field(response: Any, name: str) -> Any:
    if isinstance(response, Mapping):
        return response.get(name)
    return getattr(response, name, None)


def extract_cached_reasoning(usage: Any) -> tuple[int, int]:
    """Compatibility view over the provider-neutral usage normalizer."""
    normalized = merge_token_usage(usage)
    return normalized.cached_tokens, normalized.reasoning_tokens


def normalize_stream_usage(usage: Any) -> dict[str, int] | None:
    """Flatten streamed provider usage without dropping cache metadata."""
    normalized = merge_token_usage(usage)
    if not has_token_usage(normalized):
        return None
    return token_usage_dict(normalized)


def _extract_cached_reasoning_from_usage(usage: Any) -> tuple[int, int]:
    """Private alias kept for existing callers and tests."""
    return extract_cached_reasoning(usage)


def usage_metadata_from_llm_response(response: Any) -> dict[str, int] | None:
    """Return usage_metadata dict or None.

    Keys: input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens.
    Aligns with DeerFlow frontend expectations for input/output/total.
    Returns None when usage is missing or all meaningful counts are zero.
    """
    if response is None:
        return None
    metadata = _response_field(response, "metadata")
    raw_metadata_usage = None
    if isinstance(metadata, Mapping):
        raw_metadata_usage = metadata.get("usage") or metadata.get("raw_usage")
    usage = merge_token_usage(
        _response_field(response, "token_usage"),
        _response_field(response, "usage"),
        raw_metadata_usage,
    )
    if not has_token_usage(usage):
        return None
    return {
        "input_tokens": usage.prompt_tokens,
        "output_tokens": usage.completion_tokens,
        "total_tokens": usage.total_tokens,
        "cached_tokens": usage.cached_tokens,
        "reasoning_tokens": usage.reasoning_tokens,
    }
