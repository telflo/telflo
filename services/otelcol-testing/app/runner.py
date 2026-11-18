"""Running one test, the service's half (D14a spec decision 5; Preflight
rulings 1 to 4), as the validator runs a check (D13b rulings 26, 27, 33):

1. Take one of a fixed number of slots (the cap, 4 by default), waiting at
   most 5 s; past that the request answers 503 `tester_busy`.
2. Make the run's workspace (a fresh directory, mode 0700), stage the input
   there, and start the run's child process (`python -m app.run_child`) in
   its own session and process group, with the allowlisted environment and
   the request on its stdin. The child runs the neutraliser, the collector
   and the rest (`app/run.py`); the collector is in the child's group.
3. Wait for the child's answer under ONE deadline, 57 + d s (d the run's
   duration). Past it, or when the request is cancelled (the client gone,
   the request's 64 + d s budget spent, a shutdown), the whole group is
   killed (SIGKILL), the child reaped while its pipes keep draining, and the
   rest of the group waited for (bounded).
4. Remove the workspace, the only place the run writes, and only then
   release the slot, whatever happened (a second cancellation included).
5. Check the child's answer strictly; then, with the slot free, scrub every
   field of it (`app/scrub.py`: the run's workspace, which only this half
   knows for every field (`record_workspace`), the kubeconfig and service
   paths, and the secret's exact value), cut the logs to 256 KiB at a line,
   cut the files to 10 MiB only once they are scrubbed (the output at a
   record, the decoded input at a character: a secret across a cut never
   leaves part of itself behind; Ruling 27), and render it, at most 32 MiB
   (ruling 1), off the event loop.

The event loop parses nothing of the text or of what the collector printed.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from app import environment, processes
from app.kwok import ClusterEndpoint
from app.run import INPUT_NAME, MAX_OUTPUT_BYTES
from app.scrub import Scrub

logger = logging.getLogger(__name__)

# The child: this interpreter, the service's own `app` package (the working
# directory is the service's), `-E` (no PYTHON* variable is read) and `-s`
# (no user site directory).
SERVICE_ROOT = Path(__file__).resolve().parents[1]
RUN_COMMAND: tuple[str, ...] = (sys.executable, "-E", "-s", "-m", "app.run_child")

# The child's answer, at most: two base64 files of 10 MiB (13,981,016 bytes
# each), the logs and the text it ran. More is a failure.
CHILD_ANSWER_MAX_BYTES = 40 * 1024 * 1024
# What the service answers, at most (ruling 1: the platform reads 32 MiB).
MAX_ANSWER_BYTES = 32 * 1024 * 1024
# The logs an answer carries, at most, in UTF-8 bytes (ruling 1: 256 KiB).
MAX_LOGS_BYTES = 256 * 1024
LOGS_TRUNCATION_MARKER = "\n[logs truncated by the tester]\n"
# The text the collector ran: the person's (262,144 characters at most),
# each neutralised reference grown to its placeholder (`${f:x}`, 6
# characters, becomes 34) and the sandbox's swaps. Four times the text is
# more than they add; the whole answer is still held to MAX_ANSWER_BYTES.
MAX_MUTATED_YAML_CHARACTERS = 4 * 262_144

TIMED_OUT_MESSAGE = "The run didn't finish within its {seconds} s budget and was stopped."

STATUSES = frozenset({"succeeded", "failed"})
ERROR_CODES = frozenset({"refused", "collector_failed", "replay_rejected", "timed_out", "unreadable"})
STRATEGIES = frozenset({"otlp", "filelog", "syslog"})
MUTATION_SEVERITIES = frozenset({"info", "caution", "warn"})
# The findings' ids, as openapi.yaml's patterns read: the sandbox's
# mutations (R-*) and the fixture-shape advisories (F-*), and the
# compatibility checks (C-*).
_MUTATION_ID_RE = re.compile(r"[RF]-[0-9]{3}")
_COMPATIBILITY_ID_RE = re.compile(r"C-[0-9]{3}")
COMPATIBILITY_SEVERITIES = frozenset({"refuse", "advisory"})
TIMING_KEYS = ("totalMs", "readyMs", "informerMs", "replayMs", "holdMs", "stopMs")

_FAILURE_KIND_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")


class SlotUnavailable(Exception):
    """No slot freed up within the bounded wait: the caller answers 503."""


class RunFailed(Exception):
    """The run's child failed unexpectedly. `kind` names how (an exception
    type's name, or `child_exit_<n>`), never the text."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


class CollectorUnavailable(OSError):
    """The child couldn't run the collector: the caller answers 503
    `version_unavailable`."""


class ChildNotStarted(OSError):
    """The run's child process couldn't be started (the service's own
    interpreter or directory is unusable, a fork or a pipe failed): the
    tester's own trouble, 500 ``internal_error`` (Ruling 29), logged as
    such; never 503 ``version_unavailable``."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


@dataclass(frozen=True)
class Job:
    """A checked request (app/main.py), ready to run."""

    run_id: str
    binary: Path
    yaml: str
    pipeline: str
    signal: str
    duration_seconds: int
    version: str
    input: bytes


async def acquire_slot(slots: asyncio.Semaphore, wait_seconds: float) -> None:
    """Take one of the run slots, waiting at most `wait_seconds` (ruling 2:
    5 s), else SlotUnavailable."""
    try:
        await asyncio.wait_for(slots.acquire(), timeout=wait_seconds)
    except TimeoutError:
        raise SlotUnavailable() from None


def make_workspace() -> str:
    """The run's own directory (mkdtemp: mode 0700), under the system's
    temporary directory (the image's tmpfs)."""
    return tempfile.mkdtemp(prefix="otelcol-run-")


def _stage_input(workspace: str, data: bytes) -> None:
    descriptor = os.open(
        os.path.join(workspace, INPUT_NAME), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)


async def _start_child() -> tuple[asyncio.SubprocessTransport, processes.Pipes]:
    return await asyncio.get_running_loop().subprocess_exec(
        lambda: processes.Pipes({1: CHILD_ANSWER_MAX_BYTES}),
        *RUN_COMMAND,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        # The child's own failures (a traceback) could quote the text: never
        # kept, never logged.
        stderr=asyncio.subprocess.DEVNULL,
        env=environment.allowed(),
        cwd=str(SERVICE_ROOT),
        start_new_session=True,  # its own process group, the collector's too
    )


def timed_out_answer(job: Job, seconds: float, elapsed_ms: int) -> dict:
    return {
        "status": "failed",
        "error": {"code": "timed_out", "message": TIMED_OUT_MESSAGE.format(seconds=int(seconds))},
        "strategy": None,
        "kwokEnabled": False,
        "collectorVersion": job.version,
        "logs": "",
        "mutatedYaml": None,
        "mutations": [],
        "compatibility": [],
        "output": None,
        "decodedInput": None,
        "timings": {"totalMs": elapsed_ms, **dict.fromkeys(TIMING_KEYS[1:])},
    }


async def run_test(
    job: Job,
    *,
    slots: asyncio.Semaphore,
    slot_wait_seconds: float,
    deadline_seconds: float,
    service_dirs: tuple[str, ...] = (),
    cluster: ClusterEndpoint | None = None,
    record_workspace: Callable[[str], None] | None = None,
) -> dict:
    """Run one test while holding a slot; returns the child's checked answer,
    not yet scrubbed of the secret (`finish_answer` does that).
    ``record_workspace`` is told the run's workspace as soon as it is made,
    so the caller's scrub replaces it in every field (Ruling 27). Raises
    SlotUnavailable, CollectorUnavailable (503) or ChildNotStarted (500;
    both OSErrors), and RunFailed. The slot is released only once the run's
    process group is dead and its workspace gone."""
    await acquire_slot(slots, slot_wait_seconds)
    started = time.monotonic()
    try:
        return await _run_child(
            job,
            deadline_seconds=deadline_seconds,
            service_dirs=service_dirs,
            cluster=cluster,
            started=started,
            record_workspace=record_workspace,
        )
    finally:
        slots.release()


async def _run_child(
    job: Job,
    *,
    deadline_seconds: float,
    service_dirs: tuple[str, ...],
    cluster: ClusterEndpoint | None,
    started: float,
    record_workspace: Callable[[str], None] | None = None,
) -> dict:
    workspace = make_workspace()
    if record_workspace is not None:
        record_workspace(workspace)
    child: tuple[asyncio.SubprocessTransport, processes.Pipes] | None = None
    try:
        try:
            await asyncio.to_thread(_stage_input, workspace, job.input)
        except OSError as error:  # the service's own disk: not the collector's fault
            raise RunFailed(f"input_not_staged_{type(error).__name__}") from None
        try:
            child = await _start_child()
        except OSError as error:
            raise ChildNotStarted(type(error).__name__) from None
        transport, pipes = child
        request = json.dumps(
            {
                "binary": str(job.binary),
                "yaml": job.yaml,
                "pipeline": job.pipeline,
                "signal": job.signal,
                "durationSeconds": job.duration_seconds,
                "version": job.version,
                "workspace": workspace,
                "kubeconfig": cluster.kubeconfig if cluster else None,
                "apiserverUrl": cluster.apiserver_url if cluster else None,
                "seedPodUid": cluster.seed_pod_uid if cluster else None,
                "kwokPki": cluster.pki_dir if cluster else None,
                "serviceDirs": list(service_dirs),
            }
        ).encode("utf-8")
        stdin = transport.get_pipe_transport(0)
        assert isinstance(stdin, asyncio.WriteTransport)
        stdin.write(request)
        stdin.close()  # once written; a child that is gone just loses it
        if not await processes.within(pipes.finished, deadline_seconds):
            return timed_out_answer(job, deadline_seconds, int((time.monotonic() - started) * 1000))
        if pipes.dropped[1]:
            raise RunFailed("answer_too_long")
        return await asyncio.to_thread(decode_answer, bytes(pipes.kept[1]), transport.get_returncode())
    finally:
        if await _end_run(child, workspace):
            # A cancellation that arrived while the group was being ended
            # still ends the run, now that nothing of it is left.
            raise asyncio.CancelledError()


async def _end_run(child: tuple[asyncio.SubprocessTransport, processes.Pipes] | None, workspace: str) -> bool:
    """Kill the run's process group, reap the child, wait (bounded) for the
    rest of the group to be gone, and remove the workspace, whatever happens
    meanwhile: a cancellation (even a second one) doesn't stop it. Returns
    True when one arrived."""
    cancelled = False
    try:
        if child is not None:
            transport, pipes = child
            pid = transport.get_pid()
            processes.kill_group(pid)
            ending = asyncio.ensure_future(processes.reap_group(transport, pipes, pid))
            while not ending.done():
                try:
                    await asyncio.shield(ending)
                except asyncio.CancelledError:
                    cancelled = True
            ending.result()
    finally:
        # Off the event loop; waited for, never cancelled, so it isn't left
        # half done.
        removing = asyncio.ensure_future(asyncio.to_thread(processes.remove_directory, workspace))
        while not removing.done():
            try:
                await asyncio.wait({removing})
            except asyncio.CancelledError:
                cancelled = True
        try:
            failures = removing.result()
        except Exception as error:  # noqa: BLE001 - logged, never raised: the answer stands
            failures = [type(error).__name__]
        if failures:
            # The errors' types only: their text names the workspace.
            logger.warning("a run's workspace could not be removed (%s)", ", ".join(sorted(set(failures))))
    return cancelled


# ---------------------------------------------------------------------------
# The child's answer, checked
# ---------------------------------------------------------------------------


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _check_finding(
    item: object, severities: frozenset[str], fields: tuple[str, ...], ids: re.Pattern[str]
) -> bool:
    return (
        isinstance(item, dict)
        and set(item) == {*fields, "severity", "details"}
        and all(isinstance(item[name], str) for name in fields)
        and ids.fullmatch(item["id"]) is not None
        and item["severity"] in severities
        and isinstance(item["details"], dict)
    )


def _check_file(value: object, fields: dict[str, type]) -> bool:
    if value is None:
        return True
    if not isinstance(value, dict) or set(value) != set(fields):
        return False
    for name, kind in fields.items():
        if kind is int:
            if not _is_count(value[name]):
                return False
        elif not isinstance(value[name], kind):
            return False
    return True


ANSWER_FIELDS = frozenset(
    {
        "status",
        "strategy",
        "kwokEnabled",
        "collectorVersion",
        "logs",
        "mutatedYaml",
        "mutations",
        "compatibility",
        "output",
        "decodedInput",
        "timings",
    }
)


def check_answer(document: object) -> bool:
    """Whether `document` is exactly a run's answer, each field of its type."""
    if not isinstance(document, dict):
        return False
    keys = set(document)
    if keys - {"error"} != ANSWER_FIELDS:
        return False
    if document["status"] not in STATUSES:
        return False
    error = document.get("error")
    if document["status"] == "failed":
        if not (
            isinstance(error, dict)
            and set(error) == {"code", "message"}
            and error["code"] in ERROR_CODES
            and isinstance(error["message"], str)
        ):
            return False
    elif "error" in document:
        return False
    if document["strategy"] is not None and document["strategy"] not in STRATEGIES:
        return False
    if not isinstance(document["kwokEnabled"], bool) or not isinstance(document["collectorVersion"], str):
        return False
    if not isinstance(document["logs"], str):
        return False
    mutated = document["mutatedYaml"]
    if mutated is not None and (not isinstance(mutated, str) or len(mutated) > MAX_MUTATED_YAML_CHARACTERS):
        return False
    if not isinstance(document["mutations"], list) or not all(
        _check_finding(item, MUTATION_SEVERITIES, ("id", "message"), _MUTATION_ID_RE) for item in document["mutations"]
    ):
        return False
    if not isinstance(document["compatibility"], list) or not all(
        _check_finding(item, COMPATIBILITY_SEVERITIES, ("id", "component", "message"), _COMPATIBILITY_ID_RE)
        for item in document["compatibility"]
    ):
        return False
    if not _check_file(document["output"], {"base64": str, "bytesOnDisk": int, "truncated": bool}):
        return False
    if not _check_file(document["decodedInput"], {"base64": str, "truncated": bool}):
        return False
    timings = document["timings"]
    if not isinstance(timings, dict) or set(timings) != set(TIMING_KEYS) or not _is_count(timings["totalMs"]):
        return False
    return all(timings[name] is None or _is_count(timings[name]) for name in TIMING_KEYS[1:])


def decode_answer(raw: bytes, returncode: int | None) -> dict:
    """The child's answer, or how it failed. Anything but an answer exactly
    of its shape raises RunFailed, never a crash."""
    stopped = f"child_exit_{processes.exit_code(returncode or 0)}"
    try:
        document = json.loads(raw)
    except (ValueError, RecursionError):
        raise RunFailed(stopped) from None
    if isinstance(document, dict) and "failure" in document:
        kind = document["failure"]
        kind = kind if isinstance(kind, str) and _FAILURE_KIND_RE.fullmatch(kind) else "unknown"
        if document.get("unavailable") is True:
            raise CollectorUnavailable(kind)
        raise RunFailed(kind)
    if not check_answer(document):
        raise RunFailed("malformed_answer")
    return document


# ---------------------------------------------------------------------------
# The answer, scrubbed, bounded and rendered
# ---------------------------------------------------------------------------


def bounded_logs(logs: str) -> str:
    """`logs` within MAX_LOGS_BYTES of UTF-8: cut at the last complete line
    that fits, then the marker (a cut never leaves part of a line)."""
    encoded = logs.encode("utf-8", "replace")
    if len(encoded) <= MAX_LOGS_BYTES:
        return logs
    marker = LOGS_TRUNCATION_MARKER.encode("utf-8")
    kept = processes.complete_lines(encoded[: MAX_LOGS_BYTES - len(marker)])
    return (kept + marker).decode("utf-8", "replace")


def _compact(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace")


def _cut_output(data: bytes, cap: int) -> bytes | None:
    """The output's form (one record, or ``{"records": [...]}``, compact) cut
    to ``cap`` bytes at a record: trailing records dropped; None when not
    even one fits."""
    if len(data) <= cap:
        return data
    document = json.loads(data)
    if isinstance(document, dict) and set(document) == {"records"} and isinstance(document["records"], list):
        records = list(document["records"])
        while records:
            records.pop()
            form = _compact(records[0]) if len(records) == 1 else _compact({"records": records})
            if len(form) <= cap:
                return form
    return None


def _scrubbed_file(value: dict | None, scrub: Scrub, *, output: bool) -> dict | None:
    """A file of the answer scrubbed, THEN cut to 10 MiB (the output at a
    record, the decoded input at a character), so a secret across the cut is
    replaced whole before anything of it could be cut off."""
    if value is None:
        return None
    data = scrub.data(base64.b64decode(value["base64"], validate=True))
    cut = len(data) > MAX_OUTPUT_BYTES
    if cut and output:
        kept = _cut_output(data, MAX_OUTPUT_BYTES)
        if kept is None:
            return None
        data = kept
    elif cut:
        data = data[:MAX_OUTPUT_BYTES].decode("utf-8", "ignore").encode("utf-8")
    scrubbed = dict(value)
    scrubbed["base64"] = base64.b64encode(data).decode("ascii")
    scrubbed["truncated"] = value["truncated"] or cut
    return scrubbed


def finish_answer(document: dict, scrub: Scrub) -> bytes:
    """The answer as the service sends it: every string and both files
    scrubbed (the files then cut), the logs bounded, rendered compact as
    UTF-8 JSON. Raises RunFailed when the scrubbed text it ran passes its
    bound or the answer would pass MAX_ANSWER_BYTES."""
    finished = dict(document)
    for name in ("logs", "mutatedYaml", "mutations", "compatibility", "error"):
        if name in finished:
            finished[name] = scrub.value(finished[name])
    finished["logs"] = bounded_logs(finished["logs"])
    mutated = finished["mutatedYaml"]
    if mutated is not None and len(mutated) > MAX_MUTATED_YAML_CHARACTERS:
        raise RunFailed("mutated_yaml_too_long")
    try:
        finished["output"] = _scrubbed_file(finished["output"], scrub, output=True)
        finished["decodedInput"] = _scrubbed_file(finished["decodedInput"], scrub, output=False)
    except (ValueError, RecursionError):
        raise RunFailed("malformed_file") from None
    rendered = json.dumps(finished, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace")
    if len(rendered) > MAX_ANSWER_BYTES:
        raise RunFailed("answer_too_large")
    return rendered
