"""One run, start to finish, in the run's child process (`app/run_child.py`).

The service's half (`app/runner.py`) bounds all of it: the child has one
deadline (57 + d s), past which its whole process group, the collector
included, is killed. Nothing here has to bound itself to be safe, but each
phase keeps to its own limit (ruling 2) so a run answers before that.

D14a Task 3 built the run's frame and its protections; Task 4 fills the
seam (``_prepare_strategy``): the compatibility refusal and its "sandbox
refused to run pipeline: …" message, the strategy pick and the
fixture-shape advisory first, the status from the collector's exit (the
exit codes 0, -15 and 143 as a clean stop, a fully rejected replay as a
failure), the stop, the scrubbed logs with the ``[replay]`` block and the
output read:

1. the neutraliser's bounded read and splices (`app/neutralise.py`); R-105's
   advisory comes from the schemes it found;
2. **the seam** (``_prepare_strategy``): the text read with ruamel (a text
   it can't read, or one not shaped as a collector configuration, is C-000),
   the compatibility checks C-002 to C-006 (a refusal answers ``refused``
   with "sandbox refused to run pipeline: …"; C-003 rides along as an
   advisory), the strategy for the target pipeline (OTLP replay, filelog
   pull, syslog push), the
   fixture-shape advisory (F-001 to F-003), and the strategy's input staging
   and mutations (R-001 to R-008, R-100, R-101, R-103, R-106);
3. the backstop on the exact text the collector reads, and beside it the
   file-settings check on the same text, walking the node graph the
   backstop's own reader composes (`bounded_yaml.single_node`; C-006 again,
   C-000 for a text it can't compose; Rulings 32, 34);
4. the collector (`<binary> --config <file>`, no shell, the allowlisted
   environment and the sandbox's fixed overrides, ``KUBECONFIG`` for a
   Kubernetes processor, the workspace as its working directory, its pipes
   drained as they arrive), then the strategy: ready (a TCP probe, or the
   collector's ready line for filelog), the kwok informer wait for a
   Kubernetes processor (every strategy's, Ruling 30), the feed (the OTLP
   replay within its 30 s budget, the syslog push, filelog's input staged
   once the informer wait is over when there was one), the hold
   for the run's duration while an output watchdog stops a collector whose
   file passes 16 MiB (ruling 4), then the stop (SIGTERM, 5 s, SIGKILL, the
   reap), always, in a ``finally``;
5. the answer: the scrubbed logs with the replay's ``[replay]`` block (at
   most ``LOGS_KEPT_BYTES`` kept here; the service cuts them to 256 KiB
   after its own scrub), the text it ran, the output in the answer's form
   (one record, or ``{"records": […]}``, compact, at most 10 MiB, R-006), the
   decoded input (OTLP runs), the timings.

Nothing here logs the text, the input, the output or what the collector
printed (ADR 0024).
"""

from __future__ import annotations

import asyncio
import base64
import errno
import math
import os
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path

from app import compatibility, processes
from app.executors import pick_strategy
from app.executors._shared import build_kwok_env
from app.executors.base import CollectorNotReady, ExecutorContext, FeedFailed, KwokEndpoint, TestStrategy
from app.executors.otlp_replay import _prepend_replay_summary, _ReplaySummary
from app.fixture_shape import SNIFF_BYTES, detect_fixture_shape, detect_otlp_signal, fixture_strategy_mismatch_advisory
from app.neutralise import Refusal, backstop, neutralise
from app.output_reader import MAX_OUTPUT_BYTES, encode_output
from app.run_workspace import STAGED_INPUT_NAME, RunWorkspace
from app.scrub import Scrub
from app.settings import STOP_GRACE_SECONDS
from app.yaml_mutations import processor_needs_k8s

# What the child keeps of the collector's output (stdout and stderr, one
# pipe), at most; the service cuts the scrubbed logs to 256 KiB.
LOGS_KEPT_BYTES = 1024 * 1024
LOGS_TRUNCATION_MARKER = b"\n[logs truncated by the tester]\n"
# The decoded input an answer carries, at most (ruling 1: `errors="replace"`
# can turn 10 MiB into 30 MiB). The child sends a little more and says
# whether there was more than the cap: the service scrubs the secret first,
# then cuts at the cap (Ruling 27), so a secret across the cut never leaves
# part of itself behind.
MAX_DECODED_INPUT_BYTES = 10 * 1024 * 1024
DECODED_INPUT_SLACK_BYTES = 64 * 1024
# The output watchdog (ruling 4): a collector whose output file passes this
# is stopped, so one run can't fill the shared /tmp.
OUTPUT_WATCHDOG_BYTES = 16 * 1024 * 1024
OUTPUT_WATCHDOG_POLL_SECONDS = 0.05

CONFIG_NAME = "config.yaml"
INPUT_NAME = STAGED_INPUT_NAME
OUTPUT_NAME = "output.data"

STOPPED_MESSAGE = "The collector stopped with exit code {code}."
REJECTED_MESSAGE = "The collector rejected every payload of the input."
REFUSED_PREFIX = "sandbox refused to run pipeline: "
# The exit codes of a collector that ended because the run stopped it.
_STOPPED_CLEANLY = (0, -15, 143)

__all__ = ["MAX_OUTPUT_BYTES", "INPUT_NAME", "CollectorExecFailed", "RunRequest", "Strategy", "execute"]


# The errors of the exec itself (Ruling 29): the binary is missing (ENOENT),
# not executable or on a noexec mount (EACCES, EPERM), or not an executable
# this system runs (ENOEXEC). Anything else from starting the collector (a
# fork that fails: EAGAIN, ENOMEM; a pipe that can't be made: EMFILE, ENFILE)
# is the tester's own trouble, a 500, never "this version isn't available".
EXEC_ERRNOS = frozenset({errno.ENOENT, errno.EACCES, errno.ENOEXEC, errno.EPERM})


class CollectorExecFailed(Exception):
    """The collector's binary couldn't be executed (an OSError of
    ``EXEC_ERRNOS`` from the exec itself): the only failure the service
    answers as 503 ``version_unavailable`` (Rulings 27, 29). ``kind`` is the
    error's type."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


@dataclass(frozen=True)
class RunRequest:
    """What the service hands its child (on stdin, as JSON)."""

    binary: Path
    yaml: str
    pipeline: str
    signal: str
    duration_seconds: int
    version: str
    workspace: Path
    kubeconfig: str | None = None
    service_dirs: tuple[str, ...] = ()
    # The tester's fake cluster, when it is up (app/kwok.py).
    apiserver_url: str | None = None
    seed_pod_uid: str | None = None
    kwok_pki: str | None = None

    @classmethod
    def from_json(cls, document: dict) -> RunRequest:
        return cls(
            binary=Path(document["binary"]),
            yaml=document["yaml"],
            pipeline=document["pipeline"],
            signal=document["signal"],
            duration_seconds=int(document["durationSeconds"]),
            version=document["version"],
            workspace=Path(document["workspace"]),
            kubeconfig=document.get("kubeconfig"),
            service_dirs=tuple(document.get("serviceDirs", ())),
            apiserver_url=document.get("apiserverUrl"),
            seed_pod_uid=document.get("seedPodUid"),
            kwok_pki=document.get("kwokPki"),
        )

    @property
    def input_path(self) -> Path:
        return self.workspace / INPUT_NAME

    @property
    def kwok(self) -> KwokEndpoint | None:
        if not self.kubeconfig:
            return None
        return KwokEndpoint(
            kubeconfig_path=Path(self.kubeconfig),
            apiserver_url=self.apiserver_url,
            seed_pod_uid=self.seed_pod_uid,
            pki_dir=Path(self.kwok_pki) if self.kwok_pki else None,
        )


@dataclass
class Timings:
    total_ms: int = 0
    ready_ms: int | None = None
    informer_ms: int | None = None
    replay_ms: int | None = None
    hold_ms: int | None = None
    stop_ms: int | None = None

    def as_json(self) -> dict:
        return {
            "totalMs": self.total_ms,
            "readyMs": self.ready_ms,
            "informerMs": self.informer_ms,
            "replayMs": self.replay_ms,
            "holdMs": self.hold_ms,
            "stopMs": self.stop_ms,
        }


@dataclass
class Strategy:
    """What the seam decides for a run: the text the collector reads, the
    strategy's name, the mutations and compatibility findings (as the answer
    carries them), whether kwok is used, and the strategy that stages,
    readies and feeds (None runs the collector unfed, as Task 3's seam did).
    ``close`` lets go of what the strategy holds (its port's lease)."""

    text: str
    name: str | None = None
    mutations: list[dict] = field(default_factory=list)
    compatibility: list[dict] = field(default_factory=list)
    kwok_enabled: bool = False
    executor: TestStrategy | None = None
    context: ExecutorContext | None = None

    def close(self) -> None:
        if self.executor is not None:
            self.executor.close()


def _ms(since: float) -> int:
    return int((time.monotonic() - since) * 1000)


def plain(value: object) -> object:
    """A JSON value of plain types: ruamel's mappings, sequences and scalars
    (which a configuration's values are) made dicts, lists, strings and
    numbers; keys made strings; anything else (a tagged scalar, a date, a
    non-finite float) its text."""
    if isinstance(value, dict):
        return {key if isinstance(key, str) else str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value) if math.isfinite(value) else str(value)
    if isinstance(value, str):
        return str(value)
    return str(value)


def _finding(model: object) -> dict:
    return plain(model.model_dump())  # type: ignore[attr-defined,return-value]


def answer(
    request: RunRequest,
    timings: Timings,
    started: float,
    *,
    status: str,
    error: dict | None = None,
    strategy: Strategy | None = None,
    mutations: list[dict] | None = None,
    compatibility: list[dict] | None = None,
    logs: str = "",
    mutated_yaml: str | None = None,
    output: dict | None = None,
    decoded_input: dict | None = None,
) -> dict:
    timings.total_ms = _ms(started)
    document: dict = {
        "status": status,
        "strategy": strategy.name if strategy else None,
        "kwokEnabled": strategy.kwok_enabled if strategy else False,
        "collectorVersion": request.version,
        "logs": logs,
        "mutatedYaml": mutated_yaml,
        "mutations": mutations if mutations is not None else [],
        "compatibility": compatibility if compatibility is not None else [],
        "output": output,
        "decodedInput": decoded_input,
        "timings": timings.as_json(),
    }
    if error is not None:
        document["error"] = error
    return document


def _refused(request: RunRequest, timings: Timings, started: float, refusal: Refusal, mutations: list[dict]) -> dict:
    return answer(
        request,
        timings,
        started,
        status="failed",
        error={"code": refusal.code, "message": refusal.message},
        mutations=mutations,
        compatibility=refusal.compatibility,
    )


def _unreadable(message: str, error_type: str) -> Refusal:
    issue = compatibility.unparseable_issue(message, error_type)
    return Refusal(code="unreadable", message=message, compatibility=[_finding(issue)])


def _read_head(path: Path, size: int) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return b""
    with os.fdopen(descriptor, "rb") as file:
        return file.read(size)


def _prepare_strategy(request: RunRequest, text: str) -> Strategy | Refusal:
    """THE SEAM: compatibility, the strategy pick and the mutations, on the
    neutralised text. Refusals are C-000 to C-006."""
    try:
        doc = compatibility.parse(text)
    except Exception as error:  # ruamel's: its problem and line only
        return _unreadable(compatibility.unparseable_message(error), type(error).__name__)
    problem = compatibility.configuration_shape_problem(doc)
    if problem is not None:
        return _unreadable(f"{compatibility.UNPARSEABLE_PREFIX}{problem}", "ShapeError")
    issues = compatibility.check_compatibility_doc(
        doc,
        duration_seconds=request.duration_seconds,
        signal_type=request.signal,
        target_pipeline=request.pipeline,
    )
    if compatibility.has_refusal(issues):
        summary = "; ".join(
            f"{issue.id} {issue.component}: {issue.message}" for issue in issues if issue.severity == "refuse"
        )
        return Refusal(code="refused", message=REFUSED_PREFIX + summary, compatibility=[_finding(i) for i in issues])

    kwok = request.kwok
    context = ExecutorContext(
        yaml_config=text,
        signal_type=request.signal,
        cached_fixture=request.input_path,
        run_workspace=RunWorkspace.existing(request.workspace),
        binary=request.binary,
        duration_seconds=request.duration_seconds,
        kwok_cluster=kwok,
        max_output_bytes=MAX_OUTPUT_BYTES,
        target_pipeline=request.pipeline,
    )
    executor, kind = pick_strategy(text, request.signal, target_pipeline=request.pipeline)
    # Sniff a bounded prefix of the input once, against the strategy the
    # target pipeline takes.
    sniff = _read_head(request.input_path, SNIFF_BYTES)
    mismatch = fixture_strategy_mismatch_advisory(
        detect_fixture_shape(sniff),
        kind,
        signal_type=request.signal,
        fixture_signal=detect_otlp_signal(sniff),
    )
    mutated, advisories = executor.prepare(context)
    # The warning first, ahead of the always-on info advisories (R-001,
    # R-002, R-008).
    mutations = ([_finding(mismatch)] if mismatch is not None else []) + [_finding(a) for a in advisories]
    return Strategy(
        text=mutated,
        name=kind,
        mutations=mutations,
        compatibility=[_finding(i) for i in issues],
        kwok_enabled=kwok is not None and processor_needs_k8s(doc),
        executor=executor,
        context=context,
    )


def _final_file_settings(strategy: Strategy) -> Refusal | None:
    """Rulings 32 and 34, beside the backstop on the same text and composed
    by the backstop's own reader (`bounded_yaml.single_node`): a processor
    setting that names a file and survived to the exact text the collector
    reads is refused (C-006, naming the processor and the key only),
    whatever let it through; a text that can't be composed is refused too
    (C-000, `unreadable`), never let through."""
    issues = compatibility.final_file_settings(strategy.text)
    if not issues:
        return None
    if any(issue.id == "C-000" for issue in issues):
        return Refusal(code="unreadable", message=issues[0].message, compatibility=[_finding(i) for i in issues])
    summary = "; ".join(f"{issue.id} {issue.component}: {issue.message}" for issue in issues)
    return Refusal(code="refused", message=REFUSED_PREFIX + summary, compatibility=[_finding(i) for i in issues])


def _write_new(path: Path, data: bytes) -> None:
    """Create `path` (never an existing file, never through a symlink), mode
    0600, and write `data`."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)


def _logs(pipes: processes.Pipes, scrub: Scrub, summary: _ReplaySummary | None) -> str:
    kept = bytes(pipes.kept[1])
    if pipes.dropped[1]:
        kept = processes.complete_lines(kept) + LOGS_TRUNCATION_MARKER
    text = kept.decode("utf-8", errors="replace")
    if summary is not None:
        text = _prepend_replay_summary(text, summary)
    return scrub.text(text)


class RunningCollector:
    """The collector as the strategies watch it (`app/executors/base.py`'s
    ``Collector``)."""

    def __init__(self, transport: asyncio.SubprocessTransport, pipes: processes.Pipes) -> None:
        self.transport = transport
        self.pipes = pipes

    @property
    def returncode(self) -> int | None:
        return self.transport.get_returncode()

    def output_so_far(self) -> bytes:
        return bytes(self.pipes.kept[1])

    async def exited_within(self, seconds: float) -> bool:
        return await processes.within(self.pipes.exited, seconds)


async def _watch_output(path: Path, collector: RunningCollector, fired: list[int], limit: int) -> None:
    """Ruling 4's watchdog: once the output file passes ``limit`` bytes, stop
    the collector (SIGTERM, then SIGKILL after the grace) and record the
    size.

    The outcome (Ruling 29): a collector that stops on SIGTERM exits 0, -15
    or 143, a clean stop, so the run succeeds with its output cut at 10 MiB
    and R-006. One that ignores SIGTERM is killed after the grace (-9): the
    run fails, ``collector_failed`` "The collector stopped with exit code
    137.", still answering its output cut at 10 MiB with R-006, as a
    collector killed at the hold's own stop does."""
    while collector.returncode is None:
        await asyncio.sleep(OUTPUT_WATCHDOG_POLL_SECONDS)
        try:
            size = os.lstat(path).st_size
        except OSError:
            continue
        if size > limit:
            fired.append(size)
            try:
                collector.transport.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                return
            if not await collector.exited_within(STOP_GRACE_SECONDS):
                try:
                    collector.transport.kill()
                except ProcessLookupError:
                    pass
            return


def _decoded_input(strategy: Strategy, scrub: Scrub) -> dict | None:
    """The OTLP replay's decoded input, as UTF-8, scrubbed of the run's
    paths, at most ``MAX_DECODED_INPUT_BYTES`` plus a slack (cut at a
    character), and whether it was longer than the cap: the service scrubs
    the secret, then cuts at the cap (`app/runner.py`)."""
    if strategy.executor is None:
        return None
    decoded = strategy.executor.decoded_input()
    if decoded is None:
        return None
    data = scrub.data(decoded.encode("utf-8", "replace"))
    truncated = len(data) > MAX_DECODED_INPUT_BYTES
    if len(data) > MAX_DECODED_INPUT_BYTES + DECODED_INPUT_SLACK_BYTES:
        data = data[: MAX_DECODED_INPUT_BYTES + DECODED_INPUT_SLACK_BYTES].decode("utf-8", "ignore").encode("utf-8")
    return {"base64": base64.b64encode(data).decode("ascii"), "truncated": truncated}


async def execute(request: RunRequest) -> dict:
    """Run one request; returns the answer (app/runner.py checks its shape)."""
    started = time.monotonic()
    timings = Timings()
    scrub = Scrub.for_run(
        workspace=str(request.workspace),
        kubeconfig=request.kubeconfig,
        service_dirs=request.service_dirs,
    )

    neutralised = neutralise(request.yaml)
    if isinstance(neutralised, Refusal):
        return _refused(request, timings, started, neutralised, [])

    strategy = _prepare_strategy(request, neutralised.text)
    if isinstance(strategy, Refusal):
        return _refused(request, timings, started, strategy, neutralised.mutations)
    try:
        return await _run(request, strategy, neutralised.schemes, neutralised.mutations, timings, started, scrub)
    finally:
        strategy.close()


async def _run(
    request: RunRequest,
    strategy: Strategy,
    schemes: list[str],
    r105: list[dict],
    timings: Timings,
    started: float,
    scrub: Scrub,
) -> dict:
    mutations = [*strategy.mutations, *r105]
    refusal = backstop(strategy.text, schemes) or _final_file_settings(strategy)
    if refusal is not None:
        return answer(
            request,
            timings,
            started,
            status="failed",
            error={"code": refusal.code, "message": refusal.message},
            mutations=mutations,
            compatibility=[*strategy.compatibility, *refusal.compatibility],
        )

    config = request.workspace / CONFIG_NAME
    _write_new(config, strategy.text.encode("utf-8"))
    collector_env = build_kwok_env(request.kwok, enabled=strategy.kwok_enabled)
    executor, context = strategy.executor, strategy.context
    if executor is not None:
        executor.before_spawn()

    try:
        transport, pipes = await asyncio.get_running_loop().subprocess_exec(
            lambda: processes.Pipes({1: LOGS_KEPT_BYTES}),
            str(request.binary),
            "--config",
            str(config),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=collector_env,
            cwd=str(request.workspace),
        )
    except OSError as error:
        if error.errno in EXEC_ERRNOS:  # the binary can't be executed: the version isn't available
            raise CollectorExecFailed(type(error).__name__) from None
        raise  # a fork or a pipe that failed: the run's child answers a plain failure (500)
    collector = RunningCollector(transport, pipes)
    overflow: list[int] = []
    watchdog = asyncio.create_task(
        _watch_output(request.workspace / OUTPUT_NAME, collector, overflow, OUTPUT_WATCHDOG_BYTES),
        name="output watchdog",
    )
    failure: str | None = None
    summary: _ReplaySummary | None = None
    try:
        if executor is not None and context is not None:
            phase = time.monotonic()
            try:
                await executor.wait_ready(context, collector)
            except CollectorNotReady as error:
                failure = error.message
            timings.ready_ms = _ms(phase)
            if failure is None and strategy.kwok_enabled and hasattr(executor, "wait_for_cluster"):
                phase = time.monotonic()
                await executor.wait_for_cluster(context)
                timings.informer_ms = _ms(phase)
            if failure is None:
                phase = time.monotonic()
                try:
                    fed = await executor.feed(context, collector)
                except FeedFailed as error:
                    failure = error.message
                else:
                    summary = fed if isinstance(fed, _ReplaySummary) else None
                timings.replay_ms = _ms(phase)
        if failure is None:
            holding = time.monotonic()
            await processes.within(pipes.exited, request.duration_seconds)
            timings.hold_ms = _ms(holding)
        stopping = time.monotonic()
        await processes.terminate(transport, pipes, STOP_GRACE_SECONDS)
        timings.stop_ms = _ms(stopping)
    finally:
        # Whatever happened (an error, a cancellation), the collector never
        # outlives the run.
        watchdog.cancel()
        await processes.stop(transport, pipes)

    returncode = transport.get_returncode()
    logs = _logs(pipes, scrub, summary)
    encoded = encode_output(request.workspace / OUTPUT_NAME)
    if encoded.advisory is not None:
        mutations = [*mutations, _finding(encoded.advisory)]
    output = None
    if encoded.data is not None:
        output = {
            "base64": base64.b64encode(scrub.data(encoded.data)).decode("ascii"),
            "bytesOnDisk": encoded.bytes_on_disk,
            "truncated": encoded.truncated,
        }
    common = {
        "strategy": strategy,
        "mutations": mutations,
        "compatibility": strategy.compatibility,
        "logs": logs,
        "mutated_yaml": scrub.text(strategy.text),
        "output": output,
        "decoded_input": _decoded_input(strategy, scrub),
    }
    if failure is not None:
        error = {"code": "collector_failed", "message": failure}
    elif returncode not in _STOPPED_CLEANLY:
        error = {
            "code": "collector_failed",
            "message": STOPPED_MESSAGE.format(code=processes.exit_code(returncode or 0)),
        }
    elif summary is not None and summary.fully_rejected and not overflow:
        # (A collector the watchdog stopped mid-replay refused the rest for
        # that reason: its output overflowed, R-006 says so.)
        error = {"code": "replay_rejected", "message": REJECTED_MESSAGE}
    else:
        return answer(request, timings, started, status="succeeded", **common)
    return answer(request, timings, started, status="failed", error=error, **common)
