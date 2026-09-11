from __future__ import annotations

import inspect

from agenticx.cli.main import _is_loopback_bind_host, serve


def test_serve_defaults_to_loopback() -> None:
    option = inspect.signature(serve).parameters["host"].default
    assert option.default == "127.0.0.1"


def test_only_loopback_bind_targets_are_considered_local() -> None:
    assert _is_loopback_bind_host("127.0.0.1")
    assert _is_loopback_bind_host("::1")
    assert _is_loopback_bind_host("[::1]")
    assert _is_loopback_bind_host("localhost")
    assert not _is_loopback_bind_host("0.0.0.0")
    assert not _is_loopback_bind_host("::")
    assert not _is_loopback_bind_host("192.168.1.20")
