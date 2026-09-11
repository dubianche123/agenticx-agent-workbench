"""Managed execution adapters for the Workflow connector catalog.

The connector catalog deliberately contains business intent rather than
implementation details.  This module is the trusted boundary that turns a
catalogued action into either a parameterised managed CLI call or a routed MCP
call from the authenticated Studio session.

There are two important properties of this boundary:

* user supplied values are always separate argv entries (or a structured MCP
  argument mapping); no action can become a shell fragment;
* a command/API failure is surfaced as a real failed or uncertain result.  An
  adapter never returns a fabricated success merely because a connector is
  present in the semantic catalog.

The default binary resolver follows the same ``AGX_HOME`` connector locations
used by the Desktop native connector installer.  Tests and embedding callers
can inject a runner, binary path, or MCP hub resolver without touching the
machine or a third party service.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import re
import shutil
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol, Union

from agenticx.utils.agx_home import agx_home

from .connectors import get_connector_catalog
from .execution import AdapterAvailability, AdapterContext, AdapterResult


MAX_CONNECTOR_OUTPUT_CHARS = 64 * 1024
MAX_CONNECTOR_ERROR_CHARS = 4 * 1024
DEFAULT_CONNECTOR_TIMEOUT_SECONDS = 30.0
MAX_CONNECTOR_TIMEOUT_SECONDS = 10 * 60.0
PROCESS_CLEANUP_TIMEOUT_SECONDS = 0.75
STREAM_CLEANUP_TIMEOUT_SECONDS = 1.0

_SAFE_REPOSITORY_REF = re.compile(
    r"^(?:[A-Za-z0-9][A-Za-z0-9_.-]*/)?[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$"
)
_WORK_ITEM_REF = re.compile(r"^(?:(issue|pr|pull)(?:[:/#])?)?(\d+)$", re.IGNORECASE)
_SECRET_KEY = re.compile(
    r"(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization)",
    re.IGNORECASE,
)
_KEY_VALUE_SECRET = re.compile(
    r"(?i)(\b(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization)\b\s*[=:]\s*)([^\s,;]+)"
)
_BEARER_SECRET = re.compile(r"(?i)(\bbearer\s+)([^\s,;]+)")
_PROPOSAL_COMMANDS = frozenset(
    {"append", "overwrite", "str_replace", "block_insert_after", "block_replace"}
)
_PROPOSAL_FIELDS = frozenset(
    {"command", "content", "pattern", "block_id", "doc_format", "revision_id"}
)
_GITHUB_CHANGE_FIELDS = frozenset(
    {
        "title",
        "body",
        "labels",
        "add_labels",
        "remove_labels",
        "assignees",
        "add_assignees",
        "remove_assignees",
        "milestone",
        "remove_milestone",
    }
)


@dataclass(frozen=True)
class CommandResult:
    """Bounded result returned by :class:`AsyncSubprocessRunner`.

    ``cancelled`` and ``timed_out`` are explicit so adapters can distinguish a
    process that never completed from a normal non-zero CLI exit.  ``error``
    contains only a local process error (for example, executable missing), and
    is redacted before it crosses the adapter boundary.
    """

    returncode: Optional[int]
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    cancelled: bool = False
    output_truncated: bool = False
    error: str = ""


class CommandRunner(Protocol):
    """Small injectable command runner used by CLI adapters and tests."""

    async def run(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        cancellation: Optional[asyncio.Event] = None,
    ) -> CommandResult:
        ...


def _bounded_text(value: Any, limit: int) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 32)] + "\n[… output truncated …]"


def _redaction_values() -> tuple[str, ...]:
    """Return process credential values without ever returning their names."""

    values: list[str] = []
    for key, value in os.environ.items():
        if not _SECRET_KEY.search(str(key)):
            continue
        text = str(value or "")
        if len(text) >= 4:
            values.append(text)
    # Longest first prevents a short prefix from leaving the suffix visible.
    return tuple(sorted(set(values), key=len, reverse=True))


def _redact_text(value: Any, limit: int = MAX_CONNECTOR_OUTPUT_CHARS) -> str:
    text = str(value or "")
    for secret in _redaction_values():
        text = text.replace(secret, "[REDACTED]")
    text = _KEY_VALUE_SECRET.sub(r"\1[REDACTED]", text)
    text = _BEARER_SECRET.sub(r"\1[REDACTED]", text)
    return _bounded_text(text, limit)


def _json_text(value: Any, *, limit: int = MAX_CONNECTOR_OUTPUT_CHARS) -> str:
    """Serialize an MCP/CLI value to bounded, redacted text."""

    if isinstance(value, str):
        return _redact_text(value, limit)
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = repr(value)
    return _redact_text(encoded, limit)


def _coerce_command_result(value: Any) -> CommandResult:
    if isinstance(value, CommandResult):
        return value
    if isinstance(value, Mapping):
        raw_code = value.get("returncode", value.get("code", value.get("exit_code")))
        try:
            code = None if raw_code is None else int(raw_code)
        except (TypeError, ValueError):
            code = None
        return CommandResult(
            returncode=code,
            stdout=_redact_text(value.get("stdout", "")),
            stderr=_redact_text(value.get("stderr", ""), MAX_CONNECTOR_ERROR_CHARS),
            timed_out=bool(value.get("timed_out", value.get("timeout", False))),
            cancelled=bool(value.get("cancelled", value.get("canceled", False))),
            output_truncated=bool(value.get("output_truncated", value.get("truncated", False))),
            error=_redact_text(value.get("error", ""), MAX_CONNECTOR_ERROR_CHARS),
        )
    if isinstance(value, tuple) and len(value) >= 3:
        try:
            code = None if value[0] is None else int(value[0])
        except (TypeError, ValueError):
            code = None
        return CommandResult(
            returncode=code,
            stdout=_redact_text(value[1]),
            stderr=_redact_text(value[2], MAX_CONNECTOR_ERROR_CHARS),
        )
    return CommandResult(returncode=None, error="command runner returned an invalid result")


def _validate_argv(argv: Sequence[str]) -> tuple[str, ...]:
    values = tuple(str(item) for item in argv)
    if not values or not values[0].strip():
        raise ValueError("connector command is empty")
    if any("\x00" in item for item in values):
        raise ValueError("connector command contains a NUL byte")
    return values


@dataclass(frozen=True)
class _StreamCapture:
    text: str
    truncated: bool = False


async def _read_stream(
    stream: Any,
    max_chars: int,
    overflow: Optional[asyncio.Event] = None,
) -> _StreamCapture:
    """Read a subprocess stream with a hard byte-ish bound."""

    if stream is None:
        return _StreamCapture("")
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await stream.read(8192)
        if not chunk:
            break
        if isinstance(chunk, str):
            encoded = chunk.encode("utf-8", errors="replace")
        else:
            encoded = bytes(chunk)
        remaining = max_chars - size
        if remaining > 0:
            chunks.append(encoded[:remaining])
            size += min(len(encoded), remaining)
        if len(encoded) > remaining:
            if overflow is not None:
                overflow.set()
            # Stop consuming this pipe as soon as its hard bound is reached;
            # the runner observes the event and terminates the process.  This
            # prevents an untrusted CLI from making the worker drain an
            # unbounded output stream while still retaining the bounded prefix.
            return _StreamCapture(
                b"".join(chunks).decode("utf-8", errors="replace"),
                truncated=True,
            )
    return _StreamCapture(b"".join(chunks).decode("utf-8", errors="replace"))


async def _terminate_process(process: Any) -> None:
    """Stop a managed child without leaving a command running in the worker."""

    def _send_group(signal_number: int) -> bool:
        pid = getattr(process, "pid", None)
        if os.name != "posix" or not isinstance(pid, int) or pid <= 0:
            return False
        try:
            os.killpg(pid, signal_number)
            return True
        except (ProcessLookupError, OSError):
            return False

    # Signal the process group even when the parent already exited.  A helper
    # can inherit stdout/stderr and keep the reader tasks blocked after the
    # command's parent has returned; checking ``returncode`` here would leave
    # that child group alive indefinitely.
    term_sent = _send_group(getattr(os, "SIGTERM", 15))
    if not term_sent:
        try:
            if getattr(process, "returncode", None) is None:
                process.terminate()
        except (AttributeError, ProcessLookupError, OSError):
            pass
    try:
        await asyncio.wait_for(process.wait(), timeout=PROCESS_CLEANUP_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, AttributeError, ProcessLookupError, OSError):
        pass
    # A process can ignore SIGTERM.  Send SIGKILL to the group regardless of
    # the parent's return code so grandchildren cannot retain the pipes.
    kill_sent = _send_group(getattr(os, "SIGKILL", 9))
    if not kill_sent:
        try:
            if getattr(process, "returncode", None) is None:
                process.kill()
        except (AttributeError, ProcessLookupError, OSError):
            pass
    try:
        await asyncio.wait_for(process.wait(), timeout=PROCESS_CLEANUP_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, AttributeError, ProcessLookupError, OSError):
        pass


async def _cancel_tasks(tasks: Sequence[Optional[asyncio.Task[Any]]]) -> None:
    pending = [task for task in tasks if task is not None and not task.done()]
    if not pending:
        return
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


async def _wait_process_exit(process: Any) -> Optional[int]:
    """Observe the parent exit without waiting for inherited pipe closure.

    ``asyncio.subprocess.Process.wait()`` completes only after the subprocess
    transport has disconnected all of its pipes.  A grandchild that inherits a
    pipe can therefore keep that coroutine pending even though the parent has
    already exited.  The transport publishes ``returncode`` as soon as the
    parent exits, so poll that bounded scalar for the lifecycle race and keep
    ``Process.wait()`` only for the final reap.
    """

    while True:
        returncode = getattr(process, "returncode", None)
        if returncode is not None:
            try:
                return int(returncode)
            except (TypeError, ValueError):
                return None
        await asyncio.sleep(0.01)


async def _cleanup_process_tasks(
    process: Any,
    stdout_task: asyncio.Task[_StreamCapture],
    stderr_task: asyncio.Task[_StreamCapture],
    wait_task: asyncio.Task[Any],
) -> None:
    """Terminate the process group and bound all pipe/reap awaits.

    This runs in a separate task so a caller cancellation can be caught by
    ``AsyncSubprocessRunner.run`` while cleanup continues to completion.  The
    stream readers are cancelled after a finite grace period because a
    grandchild may keep an inherited pipe open even after the parent exits.
    """

    await _terminate_process(process)
    tasks = (stdout_task, stderr_task, wait_task)
    try:
        await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=STREAM_CLEANUP_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        await _cancel_tasks(tasks)


async def _await_cleanup(cleanup_task: asyncio.Task[Any]) -> None:
    """Wait for cleanup while preserving the caller's cancellation signal."""

    while not cleanup_task.done():
        try:
            await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            # The outer task may be cancelled while cleanup is in progress.
            # Keep waiting for the bounded cleanup task before re-raising from
            # the caller, otherwise the process group can outlive the worker.
            continue
    try:
        cleanup_task.result()
    except BaseException:
        # Cleanup is best effort after the process signals have been sent.  The
        # original run exception/result remains the contract visible to the
        # adapter and should not be replaced by a cleanup implementation error.
        pass


class AsyncSubprocessRunner:
    """Run a fixed executable with argv, timeout and event cancellation."""

    def __init__(self, *, max_output_chars: int = MAX_CONNECTOR_OUTPUT_CHARS) -> None:
        self.max_output_chars = max(1024, int(max_output_chars))

    async def run(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        cancellation: Optional[asyncio.Event] = None,
    ) -> CommandResult:
        values = _validate_argv(argv)
        if cancellation is not None and cancellation.is_set():
            return CommandResult(returncode=None, cancelled=True)
        try:
            process = await asyncio.create_subprocess_exec(
                *values,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # Do not set shell=True.  ``env=None`` inherits the authenticated
                # process environment without serializing credentials in a result.
                env=None,
                # A managed CLI may start helper children.  Put the whole
                # command in its own process group so timeout/cancel/overflow
                # cannot leave a child running after the workflow claim ends.
                start_new_session=(os.name == "posix"),
            )
        except (FileNotFoundError, PermissionError, OSError) as exc:
            return CommandResult(
                returncode=None,
                error=_redact_text(f"unable to start connector command: {exc}", MAX_CONNECTOR_ERROR_CHARS),
            )

        overflow_event = asyncio.Event()
        stdout_task = asyncio.create_task(_read_stream(process.stdout, self.max_output_chars, overflow_event))
        stderr_task = asyncio.create_task(_read_stream(process.stderr, MAX_CONNECTOR_ERROR_CHARS, overflow_event))
        # Keep parent-exit detection independent from pipe closure; the latter
        # can be held open by a descendant that inherited stdout/stderr.
        exit_task = asyncio.create_task(_wait_process_exit(process))
        wait_task = asyncio.create_task(process.wait())
        cancellation_task = (
            asyncio.create_task(cancellation.wait()) if cancellation is not None else None
        )
        overflow_task = asyncio.create_task(overflow_event.wait())
        # Only lifecycle signals participate in FIRST_COMPLETED.  A normal
        # EOF on stdout/stderr must not be mistaken for process completion.
        watch_tasks = {exit_task}
        if cancellation_task is not None:
            watch_tasks.add(cancellation_task)
        watch_tasks.add(overflow_task)
        timed_out = False
        cancelled = False
        output_truncated = False
        cleanup_task: Optional[asyncio.Task[Any]] = None

        async def cleanup() -> None:
            await _cleanup_process_tasks(process, stdout_task, stderr_task, wait_task)

        async def ensure_cleanup() -> None:
            nonlocal cleanup_task
            if cleanup_task is None:
                cleanup_task = asyncio.create_task(cleanup())
            await _await_cleanup(cleanup_task)

        try:
            done, _ = await asyncio.wait(
                watch_tasks,
                timeout=max(0.05, float(timeout)),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancellation_task is not None and cancellation_task in done and cancellation_task.result():
                cancelled = True
            elif overflow_task in done and overflow_task.result():
                output_truncated = True
            elif exit_task not in done:
                timed_out = True
            # Always terminate the process group once the command lifecycle is
            # over.  Normal parent completion still needs this for descendants
            # that inherited stdout/stderr.
            await ensure_cleanup()
        except BaseException:
            # ``asyncio.wait_for`` and direct task cancellation both arrive
            # here.  Reap readers and the process group before preserving the
            # original cancellation/exception for the caller.
            await ensure_cleanup()
            raise
        finally:
            if cancellation_task is not None and not cancellation_task.done():
                cancellation_task.cancel()
                await asyncio.gather(cancellation_task, return_exceptions=True)
            if not overflow_task.done():
                overflow_task.cancel()
                await asyncio.gather(overflow_task, return_exceptions=True)
            if not exit_task.done():
                exit_task.cancel()
                await asyncio.gather(exit_task, return_exceptions=True)
        output_truncated = output_truncated or overflow_event.is_set()
        def capture(task: asyncio.Task[_StreamCapture]) -> _StreamCapture:
            if not task.done():
                return _StreamCapture("")
            try:
                value = task.result()
            except BaseException:
                return _StreamCapture("")
            return value if isinstance(value, _StreamCapture) else _StreamCapture("")

        stdout_capture = capture(stdout_task)
        stderr_capture = capture(stderr_task)
        return CommandResult(
            returncode=getattr(process, "returncode", None),
            stdout=_redact_text(stdout_capture.text),
            stderr=_redact_text(stderr_capture.text, MAX_CONNECTOR_ERROR_CHARS),
            timed_out=timed_out,
            cancelled=cancelled,
            output_truncated=output_truncated or stdout_capture.truncated or stderr_capture.truncated,
        )


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def _run_with_runner(
    runner: Any,
    argv: Sequence[str],
    *,
    timeout: float,
    cancellation: Optional[asyncio.Event],
) -> CommandResult:
    """Invoke an injected runner while accepting callable test doubles."""

    method = getattr(runner, "run", None)
    if callable(method):
        try:
            value = method(argv, timeout=timeout, cancellation=cancellation)
        except TypeError:
            # Small test/embedding doubles sometimes implement only
            # ``run(argv, timeout=...)``.  The fallback remains structured and
            # never turns the argv into a shell command.
            value = method(argv, timeout=timeout)
    elif callable(runner):
        try:
            value = runner(argv, timeout=timeout, cancellation=cancellation)
        except TypeError:
            value = runner(argv, timeout=timeout)
    else:
        return CommandResult(returncode=None, error="connector command runner is unavailable")
    return _coerce_command_result(await _maybe_await(value))


def _context_timeout(context: AdapterContext, default: float) -> float:
    value = context.node_config.get("timeout_seconds") if isinstance(context.node_config, Mapping) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and float(value) > 0:
        return max(0.05, min(float(value), MAX_CONNECTOR_TIMEOUT_SECONDS))
    return max(0.05, min(float(default), MAX_CONNECTOR_TIMEOUT_SECONDS))


def _input(context: AdapterContext, name: str, *, default: Any = None) -> Any:
    value = context.inputs.get(name, default)
    # Direct adapter callers do not necessarily pass through executor JSON
    # sanitisation.  Reject mappings here rather than interpolating them into
    # argv or silently accepting a value with surprising stringification.
    return value


def _required_text(context: AdapterContext, name: str) -> str:
    value = _input(context, name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"connector input {name!r} must be a non-empty string")
    if "\x00" in value:
        raise ValueError(f"connector input {name!r} contains a NUL byte")
    return value.strip()


def _optional_text(context: AdapterContext, name: str) -> Optional[str]:
    value = _input(context, name)
    if value is None or value == "":
        return None
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError(f"connector input {name!r} must be text")
    return value.strip()


def _default_binary_candidates(connector_id: str, executable: str) -> tuple[Path, ...]:
    """Resolve Desktop managed binaries without guessing arbitrary paths."""

    candidates: list[Path] = []
    env_name = f"AGX_{connector_id.upper().replace('-', '_')}_CLI"
    configured = str(os.environ.get(env_name, "") or "").strip()
    if configured:
        candidates.append(Path(os.path.expanduser(configured)))
    found = shutil.which(executable)
    if found:
        candidates.append(Path(found))

    try:
        root = agx_home() / "connectors" / connector_id
        # Native Desktop installers use versioned directories.  Only inspect
        # those exact connector directories and expected executable names.
        if connector_id == "tencent-meeting":
            candidates.extend(sorted(root.glob("*/dist/tmeet-*"), reverse=True))
        else:
            candidates.extend(sorted(root.glob(f"*/bin/{executable}"), reverse=True))
    except (OSError, ValueError):
        pass
    return tuple(candidates)


def _default_binary_resolver(connector_id: str, executable: str) -> Callable[[], Optional[str]]:
    def resolve() -> Optional[str]:
        for candidate in _default_binary_candidates(connector_id, executable):
            try:
                if candidate.is_file() and not candidate.is_dir():
                    return str(candidate)
            except OSError:
                continue
        return None

    return resolve


def _fixed_binary_resolver(path: Optional[str], fallback: Callable[[], Optional[str]]) -> Callable[[], Optional[str]]:
    fixed = str(path or "").strip()

    def resolve() -> Optional[str]:
        if fixed:
            # Explicit paths are trusted constructor configuration, rather
            # than graph data.  Let the runner report a missing/unexecutable
            # path; this also keeps deterministic command fixtures independent
            # of a host filesystem.
            return fixed
        return fallback()

    return resolve


def _probe_authenticated(connector_id: str, result: CommandResult) -> bool:
    """Interpret only explicit negative probe signals; never show credentials."""

    if result.returncode not in (0, None):
        return False
    if result.error:
        return False
    if not result.stdout.strip():
        return result.returncode == 0
    try:
        payload = json.loads(result.stdout)
    except (TypeError, ValueError, json.JSONDecodeError):
        return result.returncode == 0
    if isinstance(payload, Mapping):
        for key in ("logged_in", "authenticated", "connected"):
            if key in payload and payload[key] is False:
                return False
        if connector_id == "github" and "hosts" in payload:
            hosts = payload.get("hosts")
            if isinstance(hosts, Sequence) and not isinstance(hosts, (str, bytes)):
                return any(isinstance(item, Mapping) for item in hosts)
            if isinstance(hosts, Mapping):
                return bool(hosts)
    return result.returncode == 0


@dataclass
class CommandConnectorAdapter:
    """Base adapter for one fixed connector/action command mapping."""

    connector_id: str
    action_id: str
    risk: str
    binary_resolver: Callable[[], Optional[str]]
    argv_builder: Callable[[str, AdapterContext], Sequence[str]]
    runner: Any
    probe_builder: Optional[Callable[[str, AdapterContext], Sequence[str]]] = None
    availability_reason: str = ""
    timeout_seconds: float = DEFAULT_CONNECTOR_TIMEOUT_SECONDS

    @property
    def adapter_id(self) -> str:
        return f"{self.connector_id}:{self.action_id}"

    async def availability(self, context: AdapterContext) -> AdapterAvailability:
        if self.availability_reason:
            return AdapterAvailability(
                False,
                self.availability_reason,
                adapter_id=self.adapter_id,
                details={"connector_id": self.connector_id, "action_id": self.action_id},
            )
        binary = self.binary_resolver()
        if not binary:
            return AdapterAvailability(
                False,
                f"{self.connector_id} managed CLI is not installed or configured",
                adapter_id=self.adapter_id,
                details={"connector_id": self.connector_id, "executable": self.connector_id},
            )
        if self.probe_builder is None:
            return AdapterAvailability(
                True,
                "",
                adapter_id=self.adapter_id,
                details={"connector_id": self.connector_id, "binary": Path(binary).name},
            )
        try:
            probe_argv = _validate_argv(self.probe_builder(binary, context))
        except (TypeError, ValueError) as exc:
            return AdapterAvailability(
                False,
                f"{self.connector_id} managed CLI probe is invalid: {_redact_text(exc, MAX_CONNECTOR_ERROR_CHARS)}",
                adapter_id=self.adapter_id,
            )
        result = await _run_with_runner(
            self.runner,
            probe_argv,
            timeout=min(_context_timeout(context, self.timeout_seconds), 15.0),
            cancellation=context.cancellation,
        )
        if result.cancelled:
            return AdapterAvailability(False, "connector authentication check was cancelled", adapter_id=self.adapter_id)
        if result.timed_out:
            return AdapterAvailability(False, "connector authentication check timed out", adapter_id=self.adapter_id)
        if not _probe_authenticated(self.connector_id, result):
            reason = f"{self.connector_id} CLI is unavailable or not authenticated"
            if result.error or result.stderr:
                detail = _redact_text(result.error or result.stderr, MAX_CONNECTOR_ERROR_CHARS)
                if detail:
                    reason = f"{reason}: {detail}"
            return AdapterAvailability(False, reason, adapter_id=self.adapter_id)
        return AdapterAvailability(
            True,
            "",
            adapter_id=self.adapter_id,
            details={"connector_id": self.connector_id, "binary": Path(binary).name},
        )

    async def execute(self, context: AdapterContext) -> AdapterResult:
        if context.cancellation.is_set():
            return _cancelled_result(self.adapter_id, self.risk)
        binary = self.binary_resolver()
        if not binary:
            return AdapterResult(
                outcome="blocked",
                reason=f"{self.connector_id} managed CLI is not installed or configured",
            )
        try:
            argv = _validate_argv(self.argv_builder(binary, context))
        except (TypeError, ValueError) as exc:
            return AdapterResult(outcome="blocked", reason=_redact_text(exc, MAX_CONNECTOR_ERROR_CHARS))
        result = await _run_with_runner(
            self.runner,
            argv,
            timeout=_context_timeout(context, self.timeout_seconds),
            cancellation=context.cancellation,
        )
        return _command_to_result(self.adapter_id, self.risk, result)


def _cancelled_result(adapter_id: str, risk: str) -> AdapterResult:
    if risk == "external_write":
        return AdapterResult(
            outcome="uncertain",
            reason=f"{adapter_id} was cancelled after dispatch; reconcile the external resource before retrying",
            side_effect_state="uncertain",
        )
    return AdapterResult(outcome="blocked", reason=f"{adapter_id} was cancelled before completion")


def _command_to_result(adapter_id: str, risk: str, result: CommandResult) -> AdapterResult:
    if result.cancelled:
        return _cancelled_result(adapter_id, risk)
    if result.output_truncated:
        return AdapterResult(
            outcome="uncertain" if risk == "external_write" else "failed",
            output=_redact_text(result.stdout),
            reason=(
                f"{adapter_id} exceeded the output limit; the truncated result was not accepted"
                + (" and the external effect must be reconciled" if risk == "external_write" else "")
            ),
            evidence=(f"{adapter_id}: output limit exceeded; manual review required",),
            side_effect_state="uncertain" if risk == "external_write" else "none",
        )
    if result.timed_out:
        if risk == "external_write":
            return AdapterResult(
                outcome="uncertain",
                output=_redact_text(result.stdout),
                reason=f"{adapter_id} timed out after dispatch; the external effect is uncertain",
                evidence=(f"{adapter_id}: timeout; manual reconciliation required",),
                side_effect_state="uncertain",
            )
        return AdapterResult(
            outcome="failed",
            output=_redact_text(result.stdout),
            reason=f"{adapter_id} timed out",
            evidence=(f"{adapter_id}: timeout",),
        )
    if result.error:
        return AdapterResult(
            outcome="uncertain" if risk == "external_write" else "failed",
            reason=_redact_text(result.error, MAX_CONNECTOR_ERROR_CHARS),
            evidence=(f"{adapter_id}: command could not be completed",),
            side_effect_state="uncertain" if risk == "external_write" else "none",
        )
    combined = result.stdout.strip() or result.stderr.strip()
    output = _json_text(combined)
    if result.returncode not in (0, None):
        detail = _redact_text(result.stderr or result.stdout, MAX_CONNECTOR_ERROR_CHARS)
        reason = f"{adapter_id} CLI exited with status {result.returncode}"
        if detail:
            reason = f"{reason}: {detail}"
        if risk == "external_write":
            return AdapterResult(
                outcome="uncertain",
                output=output,
                reason=f"{reason}; the external effect may have occurred",
                evidence=(f"{adapter_id}: non-zero exit; manual reconciliation required",),
                side_effect_state="uncertain",
            )
        return AdapterResult(
            outcome="failed",
            output=output,
            reason=reason,
            evidence=(f"{adapter_id}: non-zero exit",),
        )
    return AdapterResult(
        outcome="done",
        output=output,
        evidence=(f"{adapter_id}: managed CLI completed",),
        side_effect_state="applied" if risk == "external_write" else "none",
    )


class UnavailableConnectorAdapter:
    """Explicit fail-closed adapter for a catalog action without a verified mapping."""

    def __init__(self, connector_id: str, action_id: str, reason: str) -> None:
        self.connector_id = connector_id
        self.action_id = action_id
        self.adapter_id = f"{connector_id}:{action_id}"
        self.reason = reason

    async def availability(self, context: AdapterContext) -> AdapterAvailability:
        code = "action_unavailable" if self.reason.startswith("action_unavailable:") else "connector_unavailable"
        return AdapterAvailability(
            False,
            self.reason,
            adapter_id=self.adapter_id,
            details={
                "connector_id": self.connector_id,
                "action_id": self.action_id,
                "mapping": "unverified",
                "code": code,
            },
        )

    async def execute(self, context: AdapterContext) -> AdapterResult:
        return AdapterResult(outcome="blocked", reason=self.reason)


def _parse_json_mapping(value: str, *, label: str) -> Optional[Mapping[str, Any]]:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, Mapping):
        raise ValueError(f"{label} must be a JSON object")
    return parsed


def _proposal_payload(document_ref: str, change_summary: str) -> dict[str, Any]:
    """Build the frozen, path-free document proposal carried between nodes."""

    parsed = _parse_json_mapping(change_summary, label="change_summary")
    if parsed is None:
        payload: dict[str, Any] = {
            "command": "append",
            "content": change_summary,
            "doc_format": "markdown",
            "revision_id": -1,
        }
    else:
        unknown = set(str(key) for key in parsed) - _PROPOSAL_FIELDS
        if unknown:
            raise ValueError(f"unsupported document proposal field(s): {', '.join(sorted(unknown))}")
        payload = {str(key): parsed[key] for key in parsed}
        payload.setdefault("command", "append")
        payload.setdefault("doc_format", "markdown")
        payload.setdefault("revision_id", -1)
    command = str(payload.get("command") or "").strip()
    if command not in _PROPOSAL_COMMANDS:
        raise ValueError(f"unsupported document proposal command: {command!r}")
    content = payload.get("content")
    if not isinstance(content, str) or not content:
        raise ValueError("document proposal content must be non-empty text")
    doc_format = str(payload.get("doc_format") or "").strip().lower()
    if doc_format not in {"markdown", "xml"}:
        raise ValueError("document proposal doc_format must be markdown or xml")
    revision_id = payload.get("revision_id", -1)
    if not isinstance(revision_id, int) or isinstance(revision_id, bool) or revision_id < -1:
        raise ValueError("document proposal revision_id must be an integer >= -1")
    if command in {"str_replace"} and not isinstance(payload.get("pattern"), str):
        raise ValueError("str_replace document proposals require a pattern")
    if command in {"block_insert_after", "block_replace"} and not isinstance(payload.get("block_id"), str):
        raise ValueError(f"{command} document proposals require a block_id")
    if any(key in payload and not isinstance(payload[key], str) for key in ("pattern", "block_id")):
        raise ValueError("document proposal pattern and block_id must be text")
    normalized = {
        "command": command,
        "content": content,
        "doc_format": doc_format,
        "revision_id": revision_id,
    }
    for key in ("pattern", "block_id"):
        if key in payload:
            normalized[key] = payload[key]
    proposal = {
        "version": 1,
        "document_ref": document_ref,
        **normalized,
    }
    canonical = json.dumps(proposal, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    proposal["proposal_digest"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return proposal


def _parse_frozen_proposal(change_ref: str, document_ref: str) -> dict[str, Any]:
    parsed = _parse_json_mapping(change_ref, label="change_ref")
    if parsed is None:
        raise ValueError("change_ref must be the structured proposal emitted by propose_document_change")
    if isinstance(parsed.get("proposal"), Mapping):
        parsed = parsed["proposal"]
    proposal = {str(key): parsed[key] for key in parsed}
    if proposal.get("version") != 1:
        raise ValueError("unsupported document proposal version")
    if proposal.get("document_ref") != document_ref:
        raise ValueError("document proposal is bound to a different document")
    digest = str(proposal.pop("proposal_digest", "") or "")
    if not digest:
        raise ValueError("document proposal digest is missing")
    canonical = json.dumps(proposal, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if digest != expected:
        raise ValueError("document proposal was changed after approval")
    proposal["proposal_digest"] = digest
    # Re-run all command/content/version validation against the frozen value.
    return _proposal_payload(document_ref, json.dumps({key: proposal[key] for key in proposal if key not in {"version", "document_ref", "proposal_digest"}}, ensure_ascii=False, separators=(",", ":"))) | {
        "version": 1,
        "document_ref": document_ref,
        "proposal_digest": digest,
    }


def _feishu_document_proposal_argv(binary: str, proposal: Mapping[str, Any], *, dry_run: bool) -> tuple[str, ...]:
    argv: list[str] = [
        binary,
        "docs",
        "+update",
        "--doc",
        str(proposal["document_ref"]),
        "--command",
        str(proposal["command"]),
        "--doc-format",
        str(proposal["doc_format"]),
        "--content",
        str(proposal["content"]),
        "--revision-id",
        str(proposal.get("revision_id", -1)),
        "--format",
        "json",
        "--as",
        "user",
    ]
    if proposal.get("pattern") is not None:
        argv.extend(("--pattern", str(proposal["pattern"])))
    if proposal.get("block_id") is not None:
        argv.extend(("--block-id", str(proposal["block_id"])))
    if dry_run:
        argv.append("--dry-run")
    return tuple(argv)


class FeishuConnectorAdapter(CommandConnectorAdapter):
    """Verified lark-cli document/message actions."""

    async def execute(self, context: AdapterContext) -> AdapterResult:
        if self.action_id == "propose_document_change":
            try:
                document_ref = _required_text(context, "document_ref")
                change_summary = _required_text(context, "change_summary")
                proposal = _proposal_payload(document_ref, change_summary)
            except ValueError as exc:
                return AdapterResult(outcome="blocked", reason=_redact_text(exc, MAX_CONNECTOR_ERROR_CHARS))
            binary = self.binary_resolver()
            if not binary:
                return AdapterResult(outcome="blocked", reason="feishu managed CLI is not installed or configured")
            result = await _run_with_runner(
                self.runner,
                _feishu_document_proposal_argv(binary, proposal, dry_run=True),
                timeout=_context_timeout(context, self.timeout_seconds),
                cancellation=context.cancellation,
            )
            command_result = _command_to_result(self.adapter_id, self.risk, result)
            if command_result.normalized_outcome() == "done":
                preview = {
                    "proposal": proposal,
                    "preview": command_result.output,
                    "change_ref": json.dumps(proposal, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                }
                command_result.output = _json_text(preview)
            return command_result
        return await super().execute(context)


def _build_feishu_argv(action_id: str, binary: str, context: AdapterContext) -> Sequence[str]:
    if action_id == "read_document":
        return (
            binary,
            "docs",
            "+fetch",
            "--doc",
            _required_text(context, "document_ref"),
            "--doc-format",
            "markdown",
            "--detail",
            "simple",
            "--format",
            "json",
            "--as",
            "user",
        )
    if action_id == "lookup_message":
        query = _required_text(context, "query")
        argv: list[str] = [
            binary,
            "im",
            "+messages-search",
            "--query",
            query,
            "--no-reactions",
            "--format",
            "json",
            "--as",
            "user",
        ]
        conversation_ref = _optional_text(context, "conversation_ref")
        if conversation_ref:
            argv.extend(("--chat-id", conversation_ref))
        return tuple(argv)
    if action_id == "send_message":
        conversation_ref = _required_text(context, "conversation_ref")
        message = _required_text(context, "message")
        # The executor's durable attempt ID prevents duplicate sends when the
        # same approved action is resumed by the worker.
        idempotency_key = re.sub(r"[^A-Za-z0-9_.-]", "-", context.attempt_id)[:50] or "workflow-send"
        return (
            binary,
            "im",
            "+messages-send",
            "--chat-id",
            conversation_ref,
            "--text",
            message,
            "--idempotency-key",
            idempotency_key,
            "--format",
            "json",
            "--as",
            "user",
        )
    if action_id == "apply_document_change":
        document_ref = _required_text(context, "document_ref")
        proposal = _parse_frozen_proposal(_required_text(context, "change_ref"), document_ref)
        return _feishu_document_proposal_argv(binary, proposal, dry_run=False)
    raise ValueError(f"unsupported feishu action {action_id!r}")


def _build_gh_work_item(context: AdapterContext) -> tuple[str, str, str]:
    repository_ref = _required_text(context, "repository_ref")
    if not _SAFE_REPOSITORY_REF.fullmatch(repository_ref):
        raise ValueError("repository_ref must be owner/repository or host/owner/repository")
    work_item_ref = _required_text(context, "work_item_ref")
    match = _WORK_ITEM_REF.fullmatch(work_item_ref)
    if not match:
        raise ValueError("work_item_ref must be a number or issue:/pr:/pull: followed by a number")
    kind = (match.group(1) or "issue").lower()
    if kind == "pull":
        kind = "pr"
    return repository_ref, kind, match.group(2)


def _string_list(value: Any, *, field: str) -> list[str]:
    if isinstance(value, str):
        values = [item.strip() for item in value.split(",") if item.strip()]
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        values = []
        for item in value:
            if not isinstance(item, str) or not item.strip():
                raise ValueError(f"{field} must contain only non-empty strings")
            values.append(item.strip())
    else:
        raise ValueError(f"{field} must be a string or string array")
    if any("\x00" in item for item in values):
        raise ValueError(f"{field} contains a NUL byte")
    return values


def _github_change_flags(value: str) -> list[str]:
    parsed = _parse_json_mapping(value, label="change_summary")
    if parsed is None:
        return ["--body", value]
    unknown = set(str(key) for key in parsed) - _GITHUB_CHANGE_FIELDS
    if unknown:
        raise ValueError(f"unsupported GitHub change field(s): {', '.join(sorted(unknown))}")
    flags: list[str] = []
    for key in ("title", "body", "milestone"):
        if key in parsed:
            if not isinstance(parsed[key], str) or not parsed[key].strip():
                raise ValueError(f"GitHub change field {key!r} must be non-empty text")
            flags.extend((f"--{key}", parsed[key]))
    for key, flag in (
        ("labels", "--add-label"),
        ("add_labels", "--add-label"),
        ("remove_labels", "--remove-label"),
        ("assignees", "--add-assignee"),
        ("add_assignees", "--add-assignee"),
        ("remove_assignees", "--remove-assignee"),
    ):
        if key not in parsed:
            continue
        values = _string_list(parsed[key], field=key)
        if values:
            flags.extend((flag, ",".join(values)))
    if parsed.get("remove_milestone") is True:
        flags.append("--remove-milestone")
    if not flags:
        raise ValueError("GitHub change_summary must include at least one editable field")
    return flags


def _build_github_argv(action_id: str, binary: str, context: AdapterContext) -> Sequence[str]:
    repository_ref, kind, number = _build_gh_work_item(context)
    if action_id == "read_work_item":
        return (
            binary,
            kind,
            "view",
            number,
            "--repo",
            repository_ref,
            "--json",
            "number,title,body,state,url",
        )
    if action_id == "update_work_item":
        return tuple(
            [binary, kind, "edit", number, "--repo", repository_ref]
            + _github_change_flags(_required_text(context, "change_summary"))
        )
    raise ValueError(f"unsupported github action {action_id!r}")


def _build_qqmail_argv(action_id: str, binary: str, context: AdapterContext) -> Sequence[str]:
    if action_id == "search_mail":
        return (binary, "message", "+search", "--q", _required_text(context, "query"))
    # ``agently-cli message +send`` sends immediately.  It is not a draft
    # API, so never let a similarly named catalog action reach this builder.
    raise ValueError(f"action_unavailable: qqmail:{action_id} has no verified safe mapping")


def _probe_lark(binary: str, context: AdapterContext) -> Sequence[str]:
    return (binary, "auth", "status", "--json")


def _probe_github(binary: str, context: AdapterContext) -> Sequence[str]:
    hostname = "github.com"
    try:
        repository_ref = _optional_text(context, "repository_ref") or ""
        parts = repository_ref.split("/")
        if len(parts) == 3:
            hostname = parts[0]
    except ValueError:
        pass
    return (binary, "auth", "status", "--hostname", hostname, "--json", "hosts")


def _probe_qqmail(binary: str, context: AdapterContext) -> Sequence[str]:
    return (binary, "+me")


class McpConnectorAdapter:
    """Resolve and call a semantic action from a connected session MCP hub."""

    def __init__(
        self,
        connector_id: str,
        action_id: str,
        risk: str,
        *,
        hub_resolver: Optional[Callable[[AdapterContext], Any]] = None,
    ) -> None:
        self.connector_id = connector_id
        self.action_id = action_id
        self.risk = risk
        self.adapter_id = f"{connector_id}:{action_id}"
        self.hub_resolver = hub_resolver

    async def _hub(self, context: AdapterContext) -> Any:
        if self.hub_resolver is not None:
            return await _maybe_await(self.hub_resolver(context))
        session = context.session
        return getattr(session, "mcp_hub", None) if session is not None else None

    @staticmethod
    def _attribute(value: Any, name: str, default: Any = None) -> Any:
        if isinstance(value, Mapping):
            return value.get(name, default)
        return getattr(value, name, default)

    async def _snapshots(self, hub: Any) -> list[Any]:
        if hub is None:
            return []
        list_snapshots = getattr(hub, "list_tool_snapshots", None)
        snapshots = list_snapshots() if callable(list_snapshots) else []
        if inspect.isawaitable(snapshots):
            snapshots = await snapshots
        if not snapshots:
            discover = getattr(hub, "discover_all_tools", None)
            if callable(discover):
                try:
                    await _maybe_await(discover())
                except Exception:
                    return []
                snapshots = list_snapshots() if callable(list_snapshots) else []
                if inspect.isawaitable(snapshots):
                    snapshots = await snapshots
        return list(snapshots or ())

    def _select(self, snapshots: Sequence[Any]) -> Optional[Any]:
        family = self.connector_id.lower().replace("_", "-")
        action_words = {
            "read_work_item": {"read", "get", "fetch", "query", "search", "list"},
            "update_work_item": {"update", "edit", "modify", "patch", "change"},
            "lookup_message": {"lookup", "read", "get", "fetch", "query", "search", "list", "message", "messages", "msg"},
            "send_message": {"send", "post", "create", "message", "messages", "msg"},
        }.get(self.action_id, {self.action_id.lower()})
        resource_words = (
            {"message", "messages", "msg", "chat", "conversation"}
            if self.action_id in {"lookup_message", "send_message"}
            else {"work", "item", "story", "bug", "task", "requirement", "issue"}
        )
        ranked: list[tuple[int, Any]] = []
        for snap in snapshots:
            server = str(self._attribute(snap, "server_name", "") or "").lower().replace("_", "-")
            original = str(self._attribute(snap, "original_name", "") or "").lower().replace("_", "-")
            routed = str(self._attribute(snap, "routed_name", "") or "").lower().replace("_", "-")
            description = str(self._attribute(snap, "description", "") or "").lower()
            combined = " ".join((server, original, routed, description))
            if family not in combined:
                continue
            tokens = set(re.findall(r"[a-z0-9]+", combined))
            score = 0
            if original.replace("-", "_") == self.action_id:
                score += 100
            if routed.replace("-", "_") == f"{family.replace('-', '_')}__{self.action_id}":
                score += 90
            action_matches = len(action_words & tokens)
            resource_matches = len(resource_words & tokens)
            if action_matches == 0 and resource_matches == 0:
                continue
            score += 10 * action_matches
            score += 4 * resource_matches
            if bool(self._attribute(snap, "enabled", True)):
                score += 2
            else:
                score -= 100
            if score > 0:
                ranked.append((score, snap))
        if not ranked:
            return None
        ranked.sort(key=lambda item: item[0], reverse=True)
        return ranked[0][1]

    async def _selected(self, context: AdapterContext) -> tuple[Any, Any] | tuple[None, None]:
        hub = await self._hub(context)
        snap = self._select(await self._snapshots(hub))
        return hub, snap

    def _arguments(self, snapshot: Any, context: AdapterContext) -> dict[str, Any]:
        inputs = dict(context.inputs or {})
        schema = self._attribute(snapshot, "input_schema", {})
        properties = schema.get("properties", {}) if isinstance(schema, Mapping) else {}
        if not isinstance(properties, Mapping) or not properties:
            return {str(key): value for key, value in inputs.items() if not _SECRET_KEY.search(str(key))}
        aliases = {
            "project_ref": ("project_ref", "project_id", "workspace_id", "project"),
            "work_item_ref": ("work_item_ref", "work_item_id", "story_id", "bug_id", "task_id", "issue_id", "id"),
            "change_summary": ("change_summary", "description", "body", "content", "summary"),
        }
        arguments: dict[str, Any] = {}
        for key, value in inputs.items():
            if _SECRET_KEY.search(str(key)):
                continue
            choices = aliases.get(str(key), (str(key),))
            target = next((candidate for candidate in choices if candidate in properties), None)
            if target:
                arguments[target] = value
        return arguments

    async def availability(self, context: AdapterContext) -> AdapterAvailability:
        hub, snapshot = await self._selected(context)
        if hub is None:
            return AdapterAvailability(
                False,
                f"{self.connector_id} requires a connected authorized MCP session",
                adapter_id=self.adapter_id,
            )
        if snapshot is None:
            return AdapterAvailability(
                False,
                f"no verified {self.connector_id} MCP tool is available for {self.action_id}",
                adapter_id=self.adapter_id,
                details={"connector_id": self.connector_id, "action_id": self.action_id},
            )
        if not bool(self._attribute(snapshot, "enabled", True)):
            return AdapterAvailability(
                False,
                f"{self.connector_id} MCP action is disabled in the current session",
                adapter_id=self.adapter_id,
            )
        return AdapterAvailability(
            True,
            "",
            adapter_id=self.adapter_id,
            details={
                "server_name": str(self._attribute(snapshot, "server_name", "")),
                "routed_tool": str(self._attribute(snapshot, "routed_name", "")),
            },
        )

    async def execute(self, context: AdapterContext) -> AdapterResult:
        if context.cancellation.is_set():
            return _cancelled_result(self.adapter_id, self.risk)
        hub, snapshot = await self._selected(context)
        if hub is None or snapshot is None:
            return AdapterResult(outcome="blocked", reason=f"no verified {self.adapter_id} MCP tool is available")
        if not bool(self._attribute(snapshot, "enabled", True)):
            return AdapterResult(outcome="blocked", reason=f"{self.adapter_id} MCP action is disabled")
        routed_name = str(self._attribute(snapshot, "routed_name", "") or "").strip()
        if not routed_name:
            return AdapterResult(outcome="blocked", reason=f"{self.adapter_id} MCP tool has no routed name")
        arguments = self._arguments(snapshot, context)
        call_tool = getattr(hub, "call_tool", None)
        if not callable(call_tool):
            return AdapterResult(outcome="blocked", reason=f"{self.connector_id} MCP hub cannot call tools")
        call_task = asyncio.create_task(call_tool(routed_name, arguments))
        cancellation_task = asyncio.create_task(context.cancellation.wait())
        try:
            done, _ = await asyncio.wait(
                {call_task, cancellation_task},
                timeout=_context_timeout(context, DEFAULT_CONNECTOR_TIMEOUT_SECONDS),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancellation_task in done and cancellation_task.result():
                call_task.cancel()
                await asyncio.gather(call_task, return_exceptions=True)
                return _cancelled_result(self.adapter_id, self.risk)
            if call_task not in done:
                call_task.cancel()
                await asyncio.gather(call_task, return_exceptions=True)
                return AdapterResult(
                    outcome="uncertain" if self.risk == "external_write" else "failed",
                    reason=(
                        f"{self.adapter_id} MCP call timed out; reconcile the external effect"
                        if self.risk == "external_write"
                        else f"{self.adapter_id} MCP call timed out"
                    ),
                    side_effect_state="uncertain" if self.risk == "external_write" else "none",
                )
            try:
                raw = call_task.result()
                extract = getattr(hub, "extract_tool_result", None)
                value = extract(routed_name, raw) if callable(extract) else raw
                value = await _maybe_await(value)
            except Exception as exc:
                reason = _redact_text(exc, MAX_CONNECTOR_ERROR_CHARS)
                return AdapterResult(
                    outcome="uncertain" if self.risk == "external_write" else "failed",
                    reason=f"{self.adapter_id} MCP call failed: {reason}",
                    evidence=(f"{self.adapter_id}: MCP tool {routed_name} failed",),
                    side_effect_state="uncertain" if self.risk == "external_write" else "none",
                )
            return AdapterResult(
                outcome="done",
                output=_json_text(value),
                evidence=(f"{self.adapter_id}: MCP tool {routed_name} completed",),
                side_effect_state="applied" if self.risk == "external_write" else "none",
            )
        finally:
            if not cancellation_task.done():
                cancellation_task.cancel()
            await asyncio.gather(cancellation_task, return_exceptions=True)


def _registry_add(registry: dict[Any, Any], adapter: Any) -> None:
    connector_id = str(getattr(adapter, "connector_id", ""))
    action_id = str(getattr(adapter, "action_id", ""))
    registry[(connector_id, action_id)] = adapter
    registry[f"{connector_id}:{action_id}"] = adapter


def _adapter_from_catalog(
    connector_id: str,
    action_id: str,
    *,
    runner: Any,
    binary_paths: Mapping[str, str],
    binary_resolvers: Mapping[str, Callable[[], Optional[str]]],
    hub_resolver: Optional[Callable[[AdapterContext], Any]],
    timeout_seconds: float,
) -> Any:
    if connector_id == "feishu":
        fallback = _default_binary_resolver(connector_id, "lark-cli")
        resolver = binary_resolvers.get(connector_id) or _fixed_binary_resolver(binary_paths.get(connector_id), fallback)
        probe = _probe_lark
        builder = lambda binary, context: _build_feishu_argv(action_id, binary, context)
        return FeishuConnectorAdapter(
            connector_id,
            action_id,
            "external_write" if action_id in {"apply_document_change", "send_message"} else ("write" if action_id == "propose_document_change" else "read"),
            resolver,
            builder,
            runner,
            probe_builder=probe,
            timeout_seconds=timeout_seconds,
        )
    if connector_id == "github":
        fallback = _default_binary_resolver(connector_id, "gh")
        resolver = binary_resolvers.get(connector_id) or _fixed_binary_resolver(binary_paths.get(connector_id), fallback)
        return CommandConnectorAdapter(
            connector_id,
            action_id,
            "external_write" if action_id == "update_work_item" else "read",
            resolver,
            lambda binary, context: _build_github_argv(action_id, binary, context),
            runner,
            probe_builder=_probe_github,
            timeout_seconds=timeout_seconds,
        )
    if connector_id == "qqmail" and action_id == "search_mail":
        fallback = _default_binary_resolver(connector_id, "agently-cli")
        resolver = binary_resolvers.get(connector_id) or _fixed_binary_resolver(binary_paths.get(connector_id), fallback)
        return CommandConnectorAdapter(
            connector_id,
            action_id,
            "read",
            resolver,
            lambda binary, context: _build_qqmail_argv(action_id, binary, context),
            runner,
            probe_builder=_probe_qqmail,
            timeout_seconds=timeout_seconds,
        )
    if connector_id == "qqmail" and action_id == "draft_mail":
        return UnavailableConnectorAdapter(
            connector_id,
            action_id,
            "action_unavailable: Agent Mail has no verified draft API; the CLI send command sends immediately and will not be invoked",
        )
    if connector_id == "tapd":
        return McpConnectorAdapter(connector_id, action_id, "external_write" if action_id == "update_work_item" else "read", hub_resolver=hub_resolver)
    if connector_id == "wecom":
        # Native source documents the CLI category/method envelope but does
        # not publish stable message method names.  A configured dynamic MCP
        # tool is safe to use; guessing ``msg search/send`` would be unsafe.
        return McpConnectorAdapter(connector_id, action_id, "external_write" if action_id == "send_message" else "read", hub_resolver=hub_resolver)
    reason = (
        "腾讯会议受管 CLI 仅公开通用 command 入口；本版本没有已验证的列会/排期参数，"
        "因此不会猜测命令或宣称动作可用。"
        if connector_id == "tencent-meeting"
        else "Agent Mail 的已验证 CLI 没有与 send_mail(draft_ref) 对应的发送草稿命令；为避免误发不会猜测。"
    )
    return UnavailableConnectorAdapter(connector_id, action_id, reason)


def build_connector_adapters(
    *,
    runner: Any = None,
    command_runner: Any = None,
    binary_paths: Optional[Mapping[str, str]] = None,
    binary_resolvers: Optional[Mapping[str, Callable[[], Optional[str]]]] = None,
    hub_resolver: Optional[Callable[[AdapterContext], Any]] = None,
    timeout_seconds: float = DEFAULT_CONNECTOR_TIMEOUT_SECONDS,
) -> dict[Any, Any]:
    """Build adapters for every catalogued connector/action pair.

    The returned mapping contains both ``(connector_id, action_id)`` and the
    ``"connector_id:action_id"`` wire form used by ``WorkflowExecutor``.  No
    bare action IDs are registered because names such as ``lookup_message``
    are ambiguous across connector families.
    """

    selected_runner = runner or command_runner or AsyncSubprocessRunner()
    paths = {str(key): str(value) for key, value in (binary_paths or {}).items() if str(value).strip()}
    resolvers = dict(binary_resolvers or {})
    try:
        timeout = max(0.05, min(float(timeout_seconds), MAX_CONNECTOR_TIMEOUT_SECONDS))
    except (TypeError, ValueError):
        timeout = DEFAULT_CONNECTOR_TIMEOUT_SECONDS
    registry: dict[Any, Any] = {}
    for entry in get_connector_catalog():
        connector_id = str(entry.id)
        for action in entry.actions:
            adapter = _adapter_from_catalog(
                connector_id,
                str(action.id),
                runner=selected_runner,
                binary_paths=paths,
                binary_resolvers=resolvers,
                hub_resolver=hub_resolver,
                timeout_seconds=timeout,
            )
            _registry_add(registry, adapter)
    return registry


__all__ = [
    "AsyncSubprocessRunner",
    "CommandConnectorAdapter",
    "CommandResult",
    "CommandRunner",
    "FeishuConnectorAdapter",
    "McpConnectorAdapter",
    "MAX_CONNECTOR_ERROR_CHARS",
    "MAX_CONNECTOR_OUTPUT_CHARS",
    "UnavailableConnectorAdapter",
    "build_connector_adapters",
]
