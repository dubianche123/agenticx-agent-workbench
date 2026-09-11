#!/usr/bin/env python3
"""Smoke test: base LiteLLMProvider.stream_with_tools forwards reasoning_content.

Regression guard for the MiniMax M2.x/M3 "已停滞" stall bug: reasoning models
stream `reasoning_content` before `content` (especially in the round right after
a tool call). The base provider previously dropped those deltas, so the backend
emitted zero tokens during the entire thinking phase and the UI falsely showed
"已停滞" / triggered an idle timeout. The provider must now wrap reasoning in
<think>...</think> and forward it so the silent timer keeps refreshing.

Author: Damon Li
"""

from __future__ import annotations

from types import SimpleNamespace

import agenticx.llms.litellm_provider as litellm_provider_module
from agenticx.llms.litellm_provider import LiteLLMProvider


def _chunk(*, reasoning=None, reasoning_details=None, content=None, finish_reason=None):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                finish_reason=finish_reason,
                delta=SimpleNamespace(
                    reasoning_content=reasoning,
                    reasoning_details=reasoning_details,
                    content=content,
                    tool_calls=None,
                ),
            )
        ],
        usage=None,
    )


def _collect_content(stream_chunks):
    return "".join(
        item.get("text", "")
        for item in stream_chunks
        if isinstance(item, dict) and item.get("type") == "content"
    )


def test_stream_with_tools_forwards_reasoning_as_think_tags(monkeypatch):
    chunks = [
        _chunk(reasoning="thinking about "),
        _chunk(reasoning="AI gateway"),
        _chunk(content="final answer", finish_reason="stop"),
    ]

    def _fake_completion(**kwargs):
        return iter(chunks)

    monkeypatch.setattr(litellm_provider_module.litellm, "completion", _fake_completion)

    provider = LiteLLMProvider(model="openai/MiniMax-M3", api_key="k", base_url="https://example/v1")
    text = _collect_content(provider.stream_with_tools([{"role": "user", "content": "hi"}], tools=[]))

    assert text == "<think>thinking about AI gateway</think>\nfinal answer"


def test_stream_with_tools_forwards_reasoning_details(monkeypatch):
    chunks = [
        _chunk(reasoning_details=[{"text": "plan "}]),
        _chunk(reasoning_details=[{"text": "search"}]),
        _chunk(content="answer", finish_reason="stop"),
    ]

    def _fake_completion(**kwargs):
        return iter(chunks)

    monkeypatch.setattr(litellm_provider_module.litellm, "completion", _fake_completion)

    provider = LiteLLMProvider(model="openai/MiniMax-M2.7", api_key="k", base_url="https://example/v1")
    text = _collect_content(provider.stream_with_tools([{"role": "user", "content": "hi"}], tools=[]))

    assert text == "<think>plan search</think>\nanswer"


def test_stream_with_tools_closes_think_when_only_reasoning(monkeypatch):
    # Round that ends with reasoning only (e.g. before a tool call) must still
    # close the think tag so downstream parsing isn't left open.
    chunks = [
        _chunk(reasoning="deciding to call tool"),
        _chunk(finish_reason="tool_calls"),
    ]

    def _fake_completion(**kwargs):
        return iter(chunks)

    monkeypatch.setattr(litellm_provider_module.litellm, "completion", _fake_completion)

    provider = LiteLLMProvider(model="openai/MiniMax-M3", api_key="k", base_url="https://example/v1")
    text = _collect_content(provider.stream_with_tools([{"role": "user", "content": "hi"}], tools=[]))

    assert text == "<think>deciding to call tool</think>"


def test_stream_with_tools_restores_qwen38_implicit_think_prefix(monkeypatch):
    """Private Qwen3.8 omits the opening marker and may split the close tag."""
    chunks = [
        _chunk(content="We need "),
        _chunk(content="inspect the request"),
        _chunk(content="</thi"),
        _chunk(content="nk>\nfinal answer", finish_reason="stop"),
    ]

    monkeypatch.setattr(
        litellm_provider_module.litellm,
        "completion",
        lambda **_kwargs: iter(chunks),
    )

    provider = LiteLLMProvider(
        model="openai/examplecloud/qwen3.8",
        api_key="k",
        base_url="https://example/v1",
    )
    emitted = list(
        provider.stream_with_tools([{"role": "user", "content": "hi"}], tools=[])
    )
    deltas = [
        item.get("text", "")
        for item in emitted
        if isinstance(item, dict) and item.get("type") == "content"
    ]

    assert deltas[0] == "<think>We need "
    assert "".join(deltas) == "<think>We need inspect the request</think>\nfinal answer"


def test_stream_with_tools_does_not_apply_implicit_thinking_to_other_qwen(
    monkeypatch,
):
    chunks = [_chunk(content="direct answer", finish_reason="stop")]
    monkeypatch.setattr(
        litellm_provider_module.litellm,
        "completion",
        lambda **_kwargs: iter(chunks),
    )

    provider = LiteLLMProvider(
        model="openai/moma/Qwen/Qwen3.7-Max",
        api_key="k",
        base_url="https://example/v1",
    )
    text = _collect_content(
        provider.stream_with_tools([{"role": "user", "content": "hi"}], tools=[])
    )

    assert text == "direct answer"


def test_private_qwen_auto_tool_stream_accepts_raw_dict_deltas(monkeypatch):
    """vLLM/Qwen auto-tool may expose raw dict chunks through a custom gateway."""
    chunks = [
        {
            "choices": [
                {
                    "finish_reason": None,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_qwen_1",
                                "function": {
                                    "name": "file_write",
                                    "arguments": {"path": "demo.txt", "content": "ok"},
                                },
                            }
                        ]
                    },
                }
            ]
        },
        {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "delta": {},
                }
            ]
        },
    ]
    monkeypatch.setattr(
        litellm_provider_module.litellm,
        "completion",
        lambda **_kwargs: iter(chunks),
    )
    provider = LiteLLMProvider(
        model="openai/examplecloud/qwen3.8",
        api_key="k",
        base_url="https://example/v1",
    )

    emitted = list(provider.stream_with_tools([{"role": "user", "content": "write"}], tools=[]))
    tool_deltas = [item for item in emitted if item.get("type") == "tool_call_delta"]

    assert tool_deltas[0] == {
        "type": "tool_call_delta",
        "tool_index": 0,
        "tool_call_id": "call_qwen_1",
        "tool_name": "file_write",
        "arguments_delta": '{"path": "demo.txt", "content": "ok"}',
    }
    assert emitted[-1] == {"type": "done", "finish_reason": "tool_calls"}


def test_private_qwen_auto_tool_stream_accepts_legacy_function_call(monkeypatch):
    chunks = [
        {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "delta": {
                        "tool_call_id": "call_legacy",
                        "function_call": {
                            "name": "bash_exec",
                            "arguments": '{"command":"pwd"}',
                        },
                    },
                }
            ]
        }
    ]
    monkeypatch.setattr(
        litellm_provider_module.litellm,
        "completion",
        lambda **_kwargs: iter(chunks),
    )
    provider = LiteLLMProvider(
        model="openai/examplecloud/qwen3.8",
        api_key="k",
        base_url="https://example/v1",
    )

    emitted = list(provider.stream_with_tools([{"role": "user", "content": "pwd"}], tools=[]))

    assert emitted[0]["type"] == "tool_call_delta"
    assert emitted[0]["tool_call_id"] == "call_legacy"
    assert emitted[0]["tool_name"] == "bash_exec"
    assert emitted[0]["arguments_delta"] == '{"command":"pwd"}'
    assert emitted[-1] == {"type": "done", "finish_reason": "tool_calls"}


def test_parse_response_preserves_reasoning_content():
    provider = LiteLLMProvider(model="openai/deepseek-v4-pro", api_key="k")
    response = SimpleNamespace(
        id="resp-ds",
        model="openai/deepseek-v4-pro",
        created=0,
        usage=SimpleNamespace(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        choices=[
            SimpleNamespace(
                index=0,
                finish_reason="tool_calls",
                message=SimpleNamespace(
                    content=" ",
                    reasoning_content="plan the search",
                    tool_calls=None,
                ),
            )
        ],
        _response_ms=1,
        custom_llm_provider="openai",
    )

    parsed = provider._parse_response(response)

    assert parsed.reasoning_content == "plan the search"
    assert parsed.content == " "


def test_parse_response_restores_qwen38_implicit_think_prefix():
    provider = LiteLLMProvider(model="openai/examplecloud/qwen3.8", api_key="k")
    response = SimpleNamespace(
        id="resp-qwen",
        model="qwen3.8",
        created=0,
        usage=SimpleNamespace(prompt_tokens=1, completion_tokens=2, total_tokens=3),
        choices=[
            SimpleNamespace(
                index=0,
                finish_reason="stop",
                message=SimpleNamespace(
                    content="internal reasoning</think>\nfinal answer",
                    reasoning_content=None,
                    tool_calls=None,
                ),
            )
        ],
        _response_ms=1,
        custom_llm_provider="openai",
    )

    parsed = provider._parse_response(response)

    assert parsed.content == "<think>internal reasoning</think>\nfinal answer"
