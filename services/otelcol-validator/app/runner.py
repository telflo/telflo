"""Running one check, in two halves.

**The service's half** (`run_validation`, on the event loop): take one of a
fixed number of slots (a bounded wait), start the check's child process
(`python -m app.check`, its own process group, the allowlisted environment,
the request on its stdin), and hold the slot until the check has ended. The
child has one hard deadline, `deadline_seconds` (the collector's time limit
plus `DEADLINE_MARGIN_SECONDS`): past it, or when the request is canceled,
the whole group is killed (SIGKILL) and the child reaped, and a check the
deadline ends answers invalid, `Validation timed out after {n}s`. However
the check ends, the service then waits, at most about a second, for the
rest of the group to be gone (a killed collector is gone once something
reaps it: the image's init), removes the check's temporary directory, the
only place the child writes, and only then releases the slot (a second
cancellation while it waits included). The event loop reads the child's
answer (JSON) and nothing else: no YAML parsing, no stderr classifying.

**The child's half** (`check_text`, in the child): the pre-processing (the
organization's values filled in first; then the text's requirements and
errors, the provider neutralization, the Datadog insert, the `${env:}`
placeholders; every parse bounded by `app/bounded_yaml.py`), the collector
subprocess (no shell, an allowlisted environment, the check's directory as
its working directory, its own time limit, capped stderr) and the stderr
parse. None of these steps has its own time bound but the collector's: the
deadline bounds them all.

**Pipes and reaps**: both halves read their subprocess's pipes as the data
arrives, never pausing a pipe (`_Pipes`: the first bytes up to a cap are
kept, the rest dropped), and a reap waits for the process's exit only, then
closes its pipes (`_stop`), so a reap always ends, whatever the pipes still
hold and whoever still holds them.

A crash or an unexplained non-zero exit is invalid
(`The collector stopped without saying why (exit 137).`, a signal reported as
128 + N), and the wait for a slot is bounded.

Nothing here logs the text or what the collector printed: log
lines name the outcome's kind only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import signal
import sys
import tempfile
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from yaml.nodes import MappingNode, Node, ScalarNode

from app import bounded_yaml, org_variables
from app.bounded_yaml import ALIASES_MESSAGE, DEPTH_MESSAGE, TooDeep, TooManyAliases
from app.placeholders import (
    _PROTECTED_ENV_NAME_RE,
    VALIDATION_ENV_OVERRIDES,
    _build_env_var_placeholders,
    _DEFAULT_PLACEHOLDER,
    _inject_datadog_hostname_placeholder,
    directory_key,
    placeholder_directory,
)
from app.providers import (
    _TELFLO_SCHEMES,
    BINARY_MESSAGE,
    apply_splices,
    has_binary_node,
    live_nonenv_schemes,
    neutralize_providers,
    scalar_splice,
)
from app.requirements import (
    confmap_provider_requirement,
    organization_variable_requirements,
    text_errors,
    text_requirements,
)
from app.settings import DEADLINE_MARGIN_SECONDS
from app.stderr import _merge_requirements, parse_stderr

logger = logging.getLogger(__name__)

# Maximum bytes of stderr kept in memory per run. The collector's stderr is
# the validator's primary signal channel, but a YAML that triggers verbose
# construction-phase errors can stream megabytes within the time limit.
# 256 KB × 8 slots keeps the worst case at 2 MB. Truncation appends a marker
# so the bound is visible, not a silent cut. The cut can fall inside a line,
# and a partial line can hold part of a path the scrub can no longer
# recognize (the check's directory), so the kept output ends at its
# last complete line before the marker.
_STDERR_MAX_BYTES = 256 * 1024
_STDERR_TRUNCATION_MARKER = b"\n[stderr truncated by validator]\n"

# Env vars the spawned otelcol-contrib is allowed to read from the parent
# process. Everything else (OTELCOL_VALIDATOR_SECRET, its previous values, any
# future operator-injected secret) is stripped before exec.
#
# Why: the collector supports `${env:VAR}` substitution at config-load time.
# A submitted YAML can interpolate any parent-env value into a typed field
# (e.g. `endpoint: "${env:OTELCOL_VALIDATOR_SECRET}"`) and the parser's failure
# to coerce the substituted value to a URL emits it back in the error message
# — straight into `errors[].message` and out to the caller. Add to this set
# only with a deliberate reason: anything added becomes readable by any YAML
# submitted to the validator.
_ALLOWED_PARENT_ENV: frozenset[str] = frozenset(
    {
        # PATH is needed so the otelcol-contrib binary and its loader can
        # resolve shared libraries via the system path.
        "PATH",
        # Locale + home directory: harmless and many third-party libs expect
        # them. Omitting them produces noisy warnings, not failures.
        "HOME",
        "LANG",
        "LC_ALL",
        # Temp dir resolution — Python and Go both honor these.
        "TMPDIR",
        "TEMP",
        "TMP",
    }
)

# One wording for the collector's own time limit and for the check's
# deadline alike.
TIMEOUT_MESSAGE = "Validation timed out after {seconds}s"
STOPPED_MESSAGE = "The collector stopped without saying why (exit {code})."
REFUSED_PROVIDERS_MESSAGE = (
    "Config references configuration provider(s) that could not be safely "
    "neutralized: {schemes}. Only '${{env:VAR}}' substitution is supported."
)
# The same refusal when no scheme can be named: the text a run would read no
# longer reads as one document.
UNCHECKED_MESSAGE = "Config references configuration provider(s) that could not be checked safely."
# A text PyYAML can't read as one document is answered invalid and never
# reaches the collector: the collector would otherwise decode and expand a
# reference a YAML escape hid, or read a second document the validator never
# neutralized. Only PyYAML's own problem and line are reported — never any of
# the text.
UNREADABLE_MESSAGE = "The configuration can't be read as YAML: {problem}"
# The opamp-server's message for a text its fill-in takes over 1 MiB
# (handlers/poll.go's tooLargeMessage): such a text is never served, so it is
# refused here before it is built.
FILLED_IN_TOO_LONG_MESSAGE = "The configuration with its organization variables filled in is over 1 MiB."


# The check's deadline is the collector's time limit plus
# DEADLINE_MARGIN_SECONDS (2): the margin covers the child's start (about
# 0.1 s), the pre-processing and the stderr parse. The pre-processing
# (`_prepare`, measured on an Apple-silicon laptop, Python 3.12, median of 7
# with the parse cache cleared) takes 0.37 s for a realistic
# 262,144-character configuration (the largest the service takes), 2.1 s for
# the worst text found (a flow sequence of about 131,000 one-character items)
# and 3.5 s for that text with one reference to neutralize (the backstop then
# composes it a second time). So the margin holds for realistic texts but not
# for the worst one with a collector that uses its whole limit: such a check
# answers at the deadline (`Validation timed out after 12s`) rather than at
# the collector's limit. With the default limit of 10 s the deadline is 12 s,
# and ending a check takes at most about a second more (the group's poll,
# below). The deadline starts once the slot is taken, so a request that first
# waited the longest for a slot (5 s) answers within about 18 s, inside the
# platform's 20-second limit on its call.

# The child: this interpreter, the service's own `app` package (the working
# directory is the service's), `-E` (no PYTHON* variable is read) and `-s`
# (no user site directory).
SERVICE_ROOT = Path(__file__).resolve().parents[1]
CHECK_COMMAND: tuple[str, ...] = (sys.executable, "-E", "-s", "-m", "app.check")

# The child's answer, already bounded by bounded() (at most 2,290,356 bytes
# rendered, about 6.9 MB at worst with ensure_ascii's escapes). More is a
# failure.
_ANSWER_MAX_BYTES = 16 * 1024 * 1024

# Once the group is killed and the child reaped, how long to wait for the
# rest of the group (the collector, reaped by init) to be gone: 200 polls
# 5 ms apart, about a second in all. Without an init to reap orphans (a
# container whose first process is the service), a killed collector stays a
# zombie: it runs nothing and holds no memory or files, only its pid (a
# process-table entry) until something reaps it; the wait then gives up at
# its bound, and the slot is released with the zombie left.
_GROUP_GONE_POLLS = 200
_GROUP_GONE_POLL_SECONDS = 0.005

_FAILURE_KIND_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")


def _build_subprocess_env() -> dict[str, str]:
    """Return the env dict for the spawned otelcol-contrib subprocess.

    Composition order (later wins):
      1. Parent env, filtered through ``_ALLOWED_PARENT_ENV``. Secrets in the
         validator's own environment never reach the subprocess.
      2. Static overrides (``VALIDATION_ENV_OVERRIDES``) — placeholder values
         for k8s-aware components that read env at validate time.

    Per-request placeholders for ``${env:VAR}`` references are layered on top
    by ``run_collector``'s caller, kept out of this function so it stays pure
    (no YAML input) and testable in isolation.
    """
    env = {k: v for k, v in os.environ.items() if k in _ALLOWED_PARENT_ENV}
    env.update(VALIDATION_ENV_OVERRIDES)
    return env


def _fixed_env_names() -> frozenset[str]:
    """Every name the collector's environment holds before any placeholder,
    or may hold: the parent allowlist (whether or not the service has the
    variable) and whatever `_build_subprocess_env()` sets. The first run's
    placeholders never set one of these."""
    return _ALLOWED_PARENT_ENV | frozenset(_build_subprocess_env())


def _child_env() -> dict[str, str]:
    """The check child's environment: the same allowlist as the collector's
    (so the child, and through it the collector, never holds
    OTELCOL_VALIDATOR_SECRET, its previous values or any other variable the
    service has). The child gets everything else it needs on its stdin."""
    return {k: v for k, v in os.environ.items() if k in _ALLOWED_PARENT_ENV}


class SlotUnavailable(Exception):
    """No slot freed up within the bounded wait: the caller answers 503."""


class CheckFailed(Exception):
    """The check's child failed unexpectedly. `kind` names how (an exception
    type's name, or `child_exit_<n>`), never the text."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


class CollectorUnavailable(OSError):
    """The child couldn't run the collector (it vanished or can't be
    executed): the caller answers 503, as for any OSError."""


class ChildNotStarted(OSError):
    """The check's child process couldn't be started (the service's own
    interpreter or directory is unusable): the caller answers 503 and logs it
    as such, not as a collector that can't be run. `kind` is the OSError's
    type name."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


@dataclass
class RunOutcome:
    """What one run of the collector came to."""

    kind: str  # "passed", "failed", "timeout", "crashed"
    returncode: int | None = None
    stderr: str = ""


@dataclass
class ValidationResult:
    valid: bool
    errors: list[dict] = field(default_factory=list)
    requirements: list[dict] = field(default_factory=list)
    # The outcome's kind, for the log line: never the text or the output.
    outcome: str = "passed"


class _Pipes(asyncio.SubprocessProtocol):
    """A subprocess's pipes, read as their data arrives and never paused:
    each pipe keeps its first `caps[fd]` bytes and drops the rest, so the
    process never blocks on a full pipe and nothing waits for a reader.
    `exited` resolves once the process has exited; `finished` once it has and
    every pipe has closed (the end of its output).

    asyncio's own streams pause a pipe once 128 KiB wait unread, and its
    `Process.wait()` resolves only after every pipe has closed: a check
    killed while its child wrote a large answer would never end. Here a reap
    waits for the exit alone (`_stop`)."""

    def __init__(self, caps: dict[int, int]) -> None:
        loop = asyncio.get_running_loop()
        self._caps = caps
        self.kept: dict[int, bytearray] = {fd: bytearray() for fd in caps}
        self.dropped: dict[int, bool] = dict.fromkeys(caps, False)
        self.exited: asyncio.Future[None] = loop.create_future()
        self.finished: asyncio.Future[None] = loop.create_future()

    def pipe_data_received(self, fd: int, data: bytes) -> None:
        kept = self.kept.get(fd)
        if kept is None:
            return
        room = self._caps[fd] - len(kept)
        if room > 0:
            kept += data[:room]
        if len(data) > room:
            self.dropped[fd] = True

    def process_exited(self) -> None:
        _resolve(self.exited)

    def connection_lost(self, exc: Exception | None) -> None:
        _resolve(self.exited)
        _resolve(self.finished)


def _resolve(future: asyncio.Future[None]) -> None:
    if not future.done():
        future.set_result(None)


async def _within(future: asyncio.Future[None], seconds: float) -> bool:
    """True when `future` resolves within `seconds`; never cancels it."""
    done, _ = await asyncio.wait({future}, timeout=seconds)
    return bool(done)


async def _stop(transport: asyncio.SubprocessTransport, pipes: _Pipes) -> None:
    """Kill the process if it still runs, wait for its exit (SIGKILL ends
    it), then close its pipes, whatever they still hold: a reap never waits
    on a pipe, so neither unread output nor a writer that outlived the
    process can hold it. Safe to call once the process has finished, and
    more than once."""
    try:
        transport.kill()
    except ProcessLookupError:
        pass  # it exited on its own meanwhile
    # Shield the shared futures: a reap canceled while it awaits them (a
    # dropped task) must not cancel the futures themselves, or a later reap
    # of the same process would raise CancelledError at once and never close
    # the transport. The kill already landed, so the process still exits and
    # these still resolve for whoever waits next.
    await asyncio.shield(pipes.exited)
    stdin = transport.get_pipe_transport(0)
    if isinstance(stdin, asyncio.WriteTransport) and (not stdin.is_closing() or stdin.get_write_buffer_size()):
        stdin.abort()  # a request the process never read
    transport.close()
    await asyncio.shield(pipes.finished)


def exit_code(returncode: int) -> int:
    """The exit status a shell would report: a process killed by signal N
    (Python's negative returncode) exits 128 + N, so SIGKILL is 137."""
    return 128 - returncode if returncode < 0 else returncode


async def acquire_slot(slots: asyncio.Semaphore, wait_seconds: float) -> None:
    """Take one of the run slots, waiting at most `wait_seconds`: the wait is
    bounded."""
    try:
        await asyncio.wait_for(slots.acquire(), timeout=wait_seconds)
    except TimeoutError:
        raise SlotUnavailable() from None


async def run_collector(
    binary_path: Path,
    yaml_content: str,
    env_overlay: dict[str, str],
    *,
    timeout_seconds: int,
    directory: str | None = None,
) -> RunOutcome:
    """Run `otelcol-contrib validate --config=<file>` once (no shell), with
    the allowlisted environment plus `env_overlay`, killed after
    `timeout_seconds`. The text is written as given, to a file in
    `directory` (the check's own, in the child; the system's temporary
    directory otherwise), which is also the collector's working directory;
    the file is always removed. Its stderr is kept up to `_STDERR_MAX_BYTES`
    and the rest dropped as it arrives; its stdout goes nowhere.

    However the run ends (its time limit, or the awaiting task canceled), a
    collector still running is killed and reaped before the temporary file is
    removed and before the caller can release its slot, and the reap waits
    for its exit only, never for its pipes."""
    subprocess_env = _build_subprocess_env()
    subprocess_env.update(env_overlay)
    tmp_path: str | None = None
    transport: asyncio.SubprocessTransport | None = None
    pipes: _Pipes | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", delete=False, encoding="utf-8", dir=directory
        ) as tmp:
            tmp.write(yaml_content)
            tmp_path = tmp.name
        transport, pipes = await asyncio.get_running_loop().subprocess_exec(
            lambda: _Pipes({2: _STDERR_MAX_BYTES}),
            str(binary_path),
            "validate",
            f"--config={tmp_path}",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=subprocess_env,
            cwd=directory,
        )
        if not await _within(pipes.finished, timeout_seconds):
            await _stop(transport, pipes)
            return RunOutcome(kind="timeout", returncode=transport.get_returncode())
        returncode = transport.get_returncode() or 0
        stderr_bytes = bytes(pipes.kept[2])
        if pipes.dropped[2]:
            stderr_bytes = _complete_lines(stderr_bytes) + _STDERR_TRUNCATION_MARKER
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")
        if returncode == 0:
            return RunOutcome(kind="passed", returncode=0, stderr=stderr_text)
        if returncode < 0:
            return RunOutcome(kind="crashed", returncode=returncode, stderr=stderr_text)
        return RunOutcome(kind="failed", returncode=returncode, stderr=stderr_text)
    finally:
        # Canceled while the collector runs (a server shutdown, a dropped
        # task): it must not outlive the check. Otherwise this only closes
        # what the run left open.
        if transport is not None and pipes is not None:
            await _stop(transport, pipes)
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _complete_lines(output: bytes) -> bytes:
    """`output` up to and including its last line break: a cut output's
    partial last line dropped (nothing when no line was complete)."""
    return output[: output.rfind(b"\n") + 1]


def _stopped(returncode: int) -> dict:
    return {"message": STOPPED_MESSAGE.format(code=exit_code(returncode)), "componentPath": None}


@dataclass
class _Prepared:
    """The text as the collector will read it, and what the validator found
    in it before the run."""

    yaml_content: str
    env_overlay: dict[str, str]
    before: list[dict]
    env_requirements: list[dict]
    scanned_requirements: list[dict]
    scanned_errors: list[dict]
    # For the backstop on the rerun's text: what was neutralized,
    # and the requirements a refusal keeps.
    neutralized: list[str] = field(default_factory=list)
    organization_requirements: list[dict] = field(default_factory=list)


def _prepare(
    yaml_content: str, directory: str | None = None, organization_variables: Mapping[str, str] | None = None
) -> _Prepared | ValidationResult:
    """The pre-processing: the organization's values filled in first, then
    the text's requirements and errors, the provider neutralization, the
    Datadog insert, the fail-closed backstop on the result and the `${env:}`
    placeholders. Synchronous and CPU-bound (YAML parses and walks), run in
    the check's child under its deadline. Returns the answer itself when the
    collector mustn't run: a text PyYAML can't read, nesting or aliases past
    their bounds, or a text the backstop refuses, or a text whose fill-in is
    over 1 MiB. `directory` is the check's own, where a directory-valued
    `${env:}` placeholder is made."""
    try:
        return _prepare_text(yaml_content, directory, organization_variables)
    except TooDeep:
        return _refused(DEPTH_MESSAGE, "too_deep")
    except TooManyAliases:
        return _refused(ALIASES_MESSAGE, "aliases")


def _refused(message: str, outcome: str, requirements: list[dict] | None = None) -> ValidationResult:
    return ValidationResult(
        valid=False,
        errors=[{"message": message, "componentPath": None}],
        requirements=requirements or [],
        outcome=outcome,
    )


def _unreadable(error: bounded_yaml.YAMLError) -> ValidationResult:
    """The answer for a text PyYAML can't read as one document: PyYAML's own
    problem and line, never any of the text."""
    problem = getattr(error, "problem", None)
    mark = getattr(error, "problem_mark", None)
    if problem is None:  # our own bounded message (e.g. a non-Unicode character)
        problem = str(error) or "the document is not valid YAML"
    elif mark is not None:
        problem = f"{problem} (line {mark.line + 1})"
    return _refused(UNREADABLE_MESSAGE.format(problem=problem), "unreadable")


def _prepare_text(
    yaml_content: str, directory: str | None = None, organization_variables: Mapping[str, str] | None = None
) -> _Prepared | ValidationResult:
    # The organization's values FIRST: every cleanup and check below reads
    # the text the collector would be served, so a value that adds YAML
    # structure (`x, headers: {…}` in a flow mapping) is parsed, neutralized
    # and checked like the rest of the text. The references are read from the
    # text as written, as the opamp-server's fill-in reads them; the
    # filled-in length is counted before anything is built, and over 1 MiB
    # the text is refused, as the opamp-server never serves it.
    values = organization_variables or {}
    length, names = org_variables.rendered_length(yaml_content, values)
    if length > org_variables.MAX_RENDERED_BYTES:
        return _refused(FILLED_IN_TOO_LONG_MESSAGE, "filled_in_too_long")
    yaml_content, _ = org_variables.render(yaml_content, values)
    filled_in = [name for name in names if name in values]
    name_over_limit = next((name for name in names if len(name) > org_variables.MAX_NAME_LENGTH), None)

    # Read the one document, with every node's source marks. A text PyYAML
    # can't read (a scanner/parser error, or more than one document) is
    # answered invalid and never reaches the collector, so the
    # collector can't decode and expand a reference an escape hid, nor read a
    # second document the validator never saw. `TooDeep` / `TooManyAliases`
    # propagate to `_prepare`.
    try:
        root = bounded_yaml.single_node(yaml_content)
    except bounded_yaml.YAMLError as error:
        return _unreadable(error)

    # The organization variables' requirements: the one row naming the names
    # filled in, a name over 128 characters, and those still unresolved (no
    # value filled them in) or written in an unsupported form, read from the
    # filled-in text's decoded values, so they survive even the fail-closed
    # refusal below.
    organization_requirements = organization_variable_requirements(yaml_content, filled_in, name_over_limit)
    # The text's own requirements and errors, read from the filled-in text.
    scanned_requirements = text_requirements(yaml_content)
    scanned_errors = text_errors(yaml_content)

    # A `!!binary` value is refused before anything else reads the text: the
    # collector decodes it and expands the references in what it decodes,
    # which the neutralization below can't see (providers.BINARY_TAG).
    if has_binary_node(root):
        return _refused(BINARY_MESSAGE, "refused", organization_requirements)

    # Neutralize non-``env`` confmap providers before the collector sees the
    # text: it would otherwise expand ``${file:...}`` / ``${http:...}`` at
    # load time and echo host files and secrets back through its messages.
    # Detection is on the DECODED keys and values, and each reference is
    # spliced out by node position — no re-dump, so nothing else drifts.
    provider_requirements: list[dict] = []
    sent = yaml_content
    yaml_content, neutralized = neutralize_providers(yaml_content, root)
    # The telflo pseudo-scheme (`org`) has its own requirement above;
    # case-sensitive, so `${ORG:X}` is reported as a foreign provider.
    foreign = [s for s in neutralized if s not in _TELFLO_SCHEMES]
    if foreign:
        provider_requirements.append(confmap_provider_requirement(foreign))

    # Datadog exporters get a placeholder ``hostname`` so the constructor
    # skips cloud hostname detection, the last rewrite before the run — a
    # fixed value this inserts, carrying none of the text, on the spliced
    # text so it and the neutralization never disagree.
    yaml_content = _inject_datadog_hostname_placeholder(yaml_content)

    # Fail closed, on the exact text the collector will read, after every
    # splice and insert. When neither changed anything, that text
    # is the one composed above and already found clean, so it isn't composed
    # again.
    if yaml_content != sent:
        refusal = _backstop(yaml_content, neutralized, organization_requirements)
        if refusal is not None:
            return refusal

    # ``${env:VAR}``: typed placeholders in the collector's environment only,
    # found on the decoded values, never for a name its fixed environment
    # holds; a directory-valued one a fresh directory in the check's own.
    env_overlay, env_requirements = _build_env_var_placeholders(yaml_content, _fixed_env_names(), directory)

    return _Prepared(
        yaml_content=yaml_content,
        env_overlay=env_overlay,
        before=organization_requirements + provider_requirements,
        env_requirements=env_requirements,
        scanned_requirements=scanned_requirements,
        scanned_errors=scanned_errors,
        neutralized=neutralized,
        organization_requirements=organization_requirements,
    )


def _still_references(yaml_content: str) -> bool:
    """The fail-closed backstop: True when the text a collector run is about
    to read no longer reads as one YAML document, or still holds a live
    non-env reference in any decoded key or value, or a `!!binary` value."""
    try:
        root = bounded_yaml.single_node(yaml_content)
    except (bounded_yaml.YAMLError, TooDeep, TooManyAliases):
        return True
    return has_binary_node(root) or bool(live_nonenv_schemes(yaml_content, root))


def _backstop(
    yaml_content: str, neutralized: list[str], organization_requirements: list[dict]
) -> ValidationResult | None:
    """Run the fail-closed check on the exact text a collector run reads (the
    first run's and the rerun's, after every splice and insert). None when
    the run may go ahead; otherwise the refusal (the collector isn't run),
    naming the schemes neutralized and any that survived, and keeping the
    organization variables' requirements. Both should be impossible: every
    splice is total and adds no structure."""
    if not _still_references(yaml_content):
        return None
    schemes = set(neutralized)
    try:
        schemes.update(live_nonenv_schemes(yaml_content, bounded_yaml.single_node(yaml_content)))
    except (bounded_yaml.YAMLError, TooDeep, TooManyAliases):
        pass  # unreadable: refused all the same
    if not schemes:
        return _refused(UNCHECKED_MESSAGE, "refused", organization_requirements)
    named = ", ".join(f"{s}:" for s in sorted(schemes))
    return _refused(REFUSED_PROVIDERS_MESSAGE.format(schemes=named), "refused", organization_requirements)


def _log_outcome(kind: str, errors: int, requirements: int, elapsed_ms: int) -> None:
    logger.info(
        "otelcol-contrib validate finished: outcome=%s errors=%d requirements=%d elapsed_ms=%d",
        kind,
        errors,
        requirements,
        elapsed_ms,
    )


# ---------------------------------------------------------------------------
# The child's half
# ---------------------------------------------------------------------------


# What an answer says in place of the check's own directory.
PRIVATE_PATH_TOKEN = "<validator>"

# What one answer holds at most. A text's own references (`${org:X}`,
# `${env:X}`, TLS paths) each make a requirement, and a multi-line key
# aliased into many pipelines made the collector print 130,746 errors
# (4.61 MiB on 0.162.0): without these bounds an answer could outgrow what
# the platform's client reads (4 MiB). Each string is cut to its budget in
# bytes of the answer's JSON (UTF-8, escapes counted), "…" included; past
# MAX_ERRORS the errors end with MORE_ERRORS_MESSAGE, so the answer stays
# invalid and says some weren't shown.
MAX_ERRORS = 200
MAX_REQUIREMENTS = 200
MORE_ERRORS_MESSAGE = "The collector reported more errors than shown."
_ELLIPSIS = "…"
MESSAGE_BUDGET = 4096
COMPONENT_PATH_BUDGET = 1024
TITLE_BUDGET = 1024
DESCRIPTION_BUDGET = 4096
CATEGORY_BUDGET = 64
# The most an answer's JSON can take, in bytes, with every field at its
# budget: 201 errors of `{"message":…,"componentPath":…}` (33 bytes + 4,096
# + 1,024 each, 200 commas), 200 requirements of `{"category":…,"title":…,
# "description":…,"componentPath":…}` (62 + 64 + 1,024 + 4,096 + 1,024 each,
# 199 commas), and the envelope (76 bytes, a distribution and a version of
# at most 64 ASCII characters each): 2,290,356 bytes, about 2.18 MiB,
# within the platform's 4 MiB.
MAX_ANSWER_BYTES = 2_290_356


def _json_bytes(value: str) -> int:
    """`value`'s size in an answer: its JSON string's UTF-8 bytes, without
    the quotes (the service answers with `ensure_ascii=False`)."""
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8", "surrogatepass")) - 2


def clipped(value: str, budget: int) -> str:
    """`value`, or its longest prefix that fits `budget` bytes (as
    `_json_bytes` counts them) with "…" after it. Linear in the budget, not
    in the value: no character costs less than a byte, nor more than six."""
    if len(value) * 6 <= budget or (len(value) <= budget and _json_bytes(value) <= budget):
        return value
    room = budget - _json_bytes(_ELLIPSIS)
    low, high = 0, min(len(value), room)
    while low < high:  # the longest prefix of at most `room` bytes
        middle = (low + high + 1) // 2
        if _json_bytes(value[:middle]) <= room:
            low = middle
        else:
            high = middle - 1
    return value[:low] + _ELLIPSIS


def _clipped_path(path: object) -> object:
    return clipped(path, COMPONENT_PATH_BUDGET) if isinstance(path, str) else path


def bounded(result: ValidationResult) -> ValidationResult:
    """`result` within an answer's bounds: each error's message and path and
    each requirement's fields cut to their budgets; at most MAX_ERRORS
    errors, then MORE_ERRORS_MESSAGE when more were reported; requirements,
    once cut, de-duplicated by (category, title, componentPath), the first of
    each kept in order, and at most MAX_REQUIREMENTS of them. Bounding a
    bounded result changes nothing."""
    errors = [
        {"message": clipped(error["message"], MESSAGE_BUDGET), "componentPath": _clipped_path(error["componentPath"])}
        for error in result.errors[:MAX_ERRORS]
    ]
    if len(result.errors) > MAX_ERRORS:
        # A bounded answer has MAX_ERRORS + 1, this the last: bounded again, the same.
        errors.append({"message": MORE_ERRORS_MESSAGE, "componentPath": None})
    kept: list[dict] = []
    seen: set[tuple[object, object, object]] = set()
    for requirement in result.requirements:
        item = {
            "category": clipped(requirement["category"], CATEGORY_BUDGET),
            "title": clipped(requirement["title"], TITLE_BUDGET),
            "description": clipped(requirement["description"], DESCRIPTION_BUDGET),
            "componentPath": _clipped_path(requirement["componentPath"]),
        }
        key = (item["category"], item["title"], item["componentPath"])
        if key in seen:
            continue
        seen.add(key)
        kept.append(item)
        if len(kept) == MAX_REQUIREMENTS:
            break
    return ValidationResult(valid=result.valid, errors=errors, requirements=kept, outcome=result.outcome)


def _private_paths(directory: str | None) -> tuple[str, ...]:
    """The check's directory as the collector may print it (as given, and
    resolved: /var and /private/var on macOS), longest first."""
    if not directory:
        return ()
    return tuple(sorted({directory, os.path.realpath(directory)}, key=len, reverse=True))


def scrubbed(result: ValidationResult, directory: str | None) -> ValidationResult:
    """`result` with every mention of the check's directory, in every string
    it returns, replaced by PRIVATE_PATH_TOKEN: the validator's own paths
    never reach an answer."""
    paths = _private_paths(directory)
    if not paths:
        return result

    def clean(value: object) -> object:
        if isinstance(value, str):
            for path in paths:
                value = value.replace(path, PRIVATE_PATH_TOKEN)
        return value

    return ValidationResult(
        valid=result.valid,
        errors=[{key: clean(value) for key, value in error.items()} for error in result.errors],
        requirements=[{key: clean(value) for key, value in item.items()} for item in result.requirements],
        outcome=result.outcome,
    )


async def check_text(
    binary_path: Path,
    yaml_content: str,
    *,
    timeout_seconds: int,
    directory: str | None = None,
    organization_variables: Mapping[str, str] | None = None,
) -> ValidationResult:
    """Check one text with one collector, start to finish: what the check's
    child runs (`app/check.py`). The caller bounds it (the child's deadline);
    only the collector has a time limit of its own. The answer never names
    the check's directory, and lists at most MAX_REQUIREMENTS requirements,
    each once. `organization_variables` (name to value) are filled in before
    anything else."""
    result = await _check_text(
        binary_path,
        yaml_content,
        timeout_seconds=timeout_seconds,
        directory=directory,
        organization_variables=organization_variables,
    )
    return bounded(scrubbed(result, directory))


async def _check_text(
    binary_path: Path,
    yaml_content: str,
    *,
    timeout_seconds: int,
    directory: str | None,
    organization_variables: Mapping[str, str] | None = None,
) -> ValidationResult:
    prepared = _prepare(yaml_content, directory, organization_variables)
    if isinstance(prepared, ValidationResult):
        return prepared
    started = time.monotonic()
    outcome = await run_collector(
        binary_path,
        prepared.yaml_content,
        prepared.env_overlay,
        timeout_seconds=timeout_seconds,
        directory=directory,
    )
    private = _private_paths(directory)
    errors, stderr_requirements, kind = _outcome_errors(outcome, prepared.yaml_content, timeout_seconds, private)
    requirements = _collector_first(
        _merge_requirements(
            prepared.before + prepared.env_requirements + prepared.scanned_requirements, stderr_requirements
        ),
        stderr_requirements,
    )

    if kind == "requirements":
        # Every collector complaint was a deployment requirement, so a
        # validate-stage requirement (file_storage's missing directory, a
        # custom node_from_env_var) stopped the collector before the build
        # stage and hid any build-stage error.
        # Meet what the sandbox can and run once more, inside the same
        # deadline; the second run's errors are the answer's, the
        # requirements stay from the first run.
        met = _meet_requirements(prepared.yaml_content, requirements, directory, prepared.env_overlay)
        if met is not None:
            met_yaml, env_additions = met
            # The rerun's text (the directory splice) gets the same backstop
            # as the first run's.
            refusal = _backstop(met_yaml, prepared.neutralized, prepared.organization_requirements)
            if refusal is not None:
                return refusal
            remaining = max(1, timeout_seconds - int(time.monotonic() - started))
            outcome = await run_collector(
                binary_path,
                met_yaml,
                {**prepared.env_overlay, **env_additions},
                timeout_seconds=remaining,
                directory=directory,
            )
            errors, _requirements_second_run, kind = _outcome_errors(outcome, met_yaml, remaining, private)

    errors = errors + prepared.scanned_errors
    return ValidationResult(valid=not errors, errors=errors, requirements=requirements, outcome=kind)


def _collector_first(requirements: list[dict], stderr_requirements: list[dict]) -> list[dict]:
    """`requirements`, in order but for this: first those the collector
    reported (by category and title, as `_merge_requirements` matches them)
    and the confmap providers', then the text scan's (organization and
    environment variables, TLS files, …), which a text can multiply. So the
    cut at MAX_REQUIREMENTS drops the text's own first."""
    reported = {(item["category"], item["title"]) for item in stderr_requirements}

    def first(item: dict) -> bool:
        return item["category"] == "confmap_provider" or (item["category"], item["title"]) in reported

    return [item for item in requirements if first(item)] + [item for item in requirements if not first(item)]


def _outcome_errors(
    outcome: RunOutcome, submitted_text: str, timeout_seconds: int, private: tuple[str, ...] = ()
) -> tuple[list[dict], list[dict], str]:
    """One collector run's errors, its stderr requirements, and the outcome's
    kind. `submitted_text` is the text that run was given, as the collector
    read it: a requirement phrase it holds is an echo, never a
    requirement."""
    kind = outcome.kind
    if outcome.kind == "timeout":
        return [{"message": TIMEOUT_MESSAGE.format(seconds=timeout_seconds), "componentPath": None}], [], kind
    if outcome.kind == "crashed":
        return [_stopped(outcome.returncode or 0)], [], kind
    if outcome.kind != "failed":
        return [], [], kind
    parsed = parse_stderr(outcome.stderr, submitted_text, private)
    if parsed.crashed:
        return [_stopped(outcome.returncode or 0)], [], "crashed"
    errors = parsed.errors
    stderr_requirements = parsed.requirements
    if not errors and not stderr_requirements:
        # A non-zero exit whose output names no error is never valid.
        return [_stopped(outcome.returncode or 0)], [], "unexplained"
    if not errors:
        # Every complaint was a deployment requirement: valid, with the
        # requirements as a checklist.
        return [], stderr_requirements, "requirements"
    return errors, stderr_requirements, kind


# ---------------------------------------------------------------------------
# Meeting a requirement so the collector reaches the build stage
# ---------------------------------------------------------------------------

_FILE_STORAGE_PREFIX = "file_storage"


def _meet_requirements(
    yaml_content: str,
    requirements: list[dict],
    directory: str | None,
    env_overlay: dict[str, str] | None = None,
) -> tuple[str, dict[str, str]] | None:
    """What a rerun needs to meet the requirements the sandbox can, or None
    when none is meetable. Returns `(rewritten_yaml, env_additions)`:
    file_storage extensions are repointed at fresh writable subdirectories of
    the per-check directory (so the directory check passes), so is
    hostmetrics' `root_path` (Linux's validate stage stats it; the
    host_filesystem template), and every
    named-environment-variable requirement is set to a placeholder in the
    collector's environment — unless the name is already in that
    environment (the allowlisted parent variables, the fixed overrides, the
    first run's `env_overlay`) or is one the collector's runtime, loader or
    network stack reads (`_PROTECTED_ENV_NAME_RE`): the name comes from a
    requirement's title, which a text shapes through `${env:NAME}`, so such
    a requirement simply isn't met."""
    present = _fixed_env_names() | set(env_overlay or ())
    env_additions: dict[str, str] = {}
    for requirement in requirements:
        if requirement["category"] in ("env_var", "k8s_downward_api"):
            name = _env_name_from_title(requirement["title"])
            if name is not None and name not in present and not _PROTECTED_ENV_NAME_RE.fullmatch(name):
                env_additions[name] = _DEFAULT_PLACEHOLDER
    rewritten = yaml_content
    met = bool(env_additions)
    for category, repoint in (("directory", _repoint_file_storage), ("host_filesystem", _repoint_hostmetrics_root)):
        if any(requirement["category"] == category for requirement in requirements):
            repointed = repoint(rewritten, directory)
            if repointed is not None:
                rewritten = repointed
                met = True
    if not met:
        return None  # no meetable requirement could be met
    return rewritten, env_additions


_ENV_FROM_TITLE_RES = (
    re.compile(r"^Set environment variable (?P<name>[A-Za-z_][A-Za-z0-9_]*)$"),
    re.compile(r"^Set (?P<name>[A-Za-z_][A-Za-z0-9_]*) via the Kubernetes downward API$"),
)


def _env_name_from_title(title: str) -> str | None:
    for pattern in _ENV_FROM_TITLE_RES:
        match = pattern.match(title)
        if match is not None:
            return match["name"]
    return None


def _repoint_file_storage(yaml_content: str, directory: str | None) -> str | None:
    """Splice each `file_storage` extension's `directory:` value to a
    placeholder directory inside the per-check directory (one per distinct
    value: equal values share one), so the collector's validate-stage
    directory check passes on the rerun. Returns the rewritten text, or None
    when there is nothing to repoint (so no rerun is forced for a requirement
    the sandbox can't meet). No re-dump: only the directory scalars' spans
    change."""
    return _repoint(yaml_content, directory, "extensions", (_FILE_STORAGE_PREFIX,), "directory")


def _repoint_hostmetrics_root(yaml_content: str, directory: str | None) -> str | None:
    """The same for each hostmetrics receiver's `root_path:` (either
    spelling, `hostmetrics` or `host_metrics`): all of them the check's one
    root directory (the collector refuses differing root_paths), the one a
    `${env:}` root_path gets too, which the collector's validate-stage stat
    finds (an empty directory passes, as the image's /hostfs does)."""
    return _repoint(yaml_content, directory, "receivers", _HOSTMETRICS_TYPES, "root_path")


_HOSTMETRICS_TYPES = ("hostmetrics", "host_metrics")


def _repoint(
    yaml_content: str,
    directory: str | None,
    section: str,
    types: tuple[str, ...],
    field: str,
) -> str | None:
    """Splice `field`'s scalar value in every `section` component whose type
    is one of `types` (`type` or `type/name`) to its placeholder directory
    inside `directory` (`placeholder_directory`: past its cap, the shared
    overflow, so every value is met); None when there is nothing
    to repoint or no check directory.
    A scalar several components reach through one anchor is spliced once, by
    its start index, as the provider neutralization dedupes its splices (two
    splices of one span would leave the text unreadable)."""
    if directory is None:
        return None
    try:
        root = bounded_yaml.single_node(yaml_content)
    except (bounded_yaml.YAMLError, TooDeep, TooManyAliases):
        return None
    if not isinstance(root, MappingNode):
        return None
    components = _mapping_get(root, section)
    if not isinstance(components, MappingNode):
        return None
    splices: dict[int, tuple[int, int, str]] = {}
    for key_node, value_node in components.value:
        key = key_node.value if isinstance(key_node, ScalarNode) else None
        if not isinstance(key, str) or key.split("/", 1)[0] not in types:
            continue
        if not isinstance(value_node, MappingNode):
            continue
        field_node = _mapping_get(value_node, field)
        if not isinstance(field_node, ScalarNode) or not isinstance(field_node.value, str):
            continue
        start = field_node.start_mark.index
        if start in splices:
            continue  # the same scalar, through an alias: one splice
        made = placeholder_directory(directory, directory_key(field, field_node.value))
        splices[start] = scalar_splice(yaml_content, field_node, made)
    if not splices:
        return None
    return apply_splices(yaml_content, list(splices.values()))


def _mapping_get(node: MappingNode, key: str) -> Node | None:
    """The value node for `key` in a composed mapping, or None."""
    for key_node, value_node in node.value:
        if isinstance(key_node, ScalarNode) and key_node.value == key:
            return value_node
    return None


# ---------------------------------------------------------------------------
# The service's half
# ---------------------------------------------------------------------------


async def run_validation(
    binary_path: Path,
    yaml_content: str,
    *,
    slots: asyncio.Semaphore,
    slot_wait_seconds: float,
    timeout_seconds: int,
    deadline_seconds: int | None = None,
    organization_variables: Mapping[str, str] | None = None,
) -> ValidationResult:
    """Check one text with one collector, in a child process, while holding
    a slot, the organization's values (`organization_variables`, name to
    value) filled in first, in the child. Raises SlotUnavailable when no slot
    frees up in time, CollectorUnavailable (an OSError) when the collector
    can't be run, and CheckFailed when the child fails otherwise.

    `deadline_seconds` (default: `timeout_seconds` plus
    `DEADLINE_MARGIN_SECONDS`) bounds the whole check; the slot is released
    only once the child's process group is dead and its directory gone."""
    deadline = deadline_seconds if deadline_seconds is not None else timeout_seconds + DEADLINE_MARGIN_SECONDS
    await acquire_slot(slots, slot_wait_seconds)
    started = time.monotonic()
    try:
        logger.info("running a check with otelcol-contrib from %s", binary_path)
        result = await _run_child(
            binary_path,
            yaml_content,
            timeout_seconds=timeout_seconds,
            deadline=deadline,
            organization_variables=organization_variables,
        )
    finally:
        slots.release()
    elapsed_ms = int((time.monotonic() - started) * 1000)
    _log_outcome(result.outcome, len(result.errors), len(result.requirements), elapsed_ms)
    return result


def _make_directory() -> str:
    """The check's own temporary directory (mode 0700)."""
    return tempfile.mkdtemp(prefix="otelcol-check-")


async def _start_child() -> tuple[asyncio.SubprocessTransport, _Pipes]:
    return await asyncio.get_running_loop().subprocess_exec(
        lambda: _Pipes({1: _ANSWER_MAX_BYTES}),
        *CHECK_COMMAND,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        # The child's own failures (a traceback) could quote the text: never
        # kept, never logged.
        stderr=asyncio.subprocess.DEVNULL,
        env=_child_env(),
        cwd=str(SERVICE_ROOT),
        start_new_session=True,  # its own process group, the collector's too
    )


async def _run_child(
    binary_path: Path,
    yaml_content: str,
    *,
    timeout_seconds: int,
    deadline: int,
    organization_variables: Mapping[str, str] | None = None,
) -> ValidationResult:
    directory = _make_directory()
    child: tuple[asyncio.SubprocessTransport, _Pipes] | None = None
    try:
        try:
            child = await _start_child()
        except OSError as error:
            raise ChildNotStarted(type(error).__name__) from None
        transport, pipes = child
        request = json.dumps(
            {
                "binary": str(binary_path),
                "yaml": yaml_content,
                "directory": directory,
                "timeout_seconds": timeout_seconds,
                "organization_variables": dict(organization_variables or {}),
            },
            # Every character as itself, not as `\uXXXX` escapes: 150 values of
            # 1,024 four-byte characters are 600 KiB on the child's stdin,
            # not 1.8 MB. The text and the values are Unicode (parse_body refuses a
            # lone surrogate), so the encoding can't fail.
            ensure_ascii=False,
        ).encode("utf-8")
        stdin = transport.get_pipe_transport(0)
        assert isinstance(stdin, asyncio.WriteTransport)
        stdin.write(request)
        stdin.close()  # once written; a child that is gone just loses it
        if not await _within(pipes.finished, deadline):
            return ValidationResult(
                valid=False,
                errors=[{"message": TIMEOUT_MESSAGE.format(seconds=deadline), "componentPath": None}],
                requirements=[],
                outcome="deadline",
            )
        if pipes.dropped[1]:
            raise CheckFailed("answer_too_long")
        # The child scrubs and bounds its answer; so does the service.
        return bounded(scrubbed(_decode_answer(bytes(pipes.kept[1]), transport.get_returncode()), directory))
    finally:
        if await _end_check(child, directory):
            # A cancellation that arrived while the group was being ended
            # still ends the check, now that nothing of it is left.
            raise asyncio.CancelledError()


_ERROR_FIELDS = {"message": str, "componentPath": (str, type(None))}
_REQUIREMENT_FIELDS = {"category": str, "title": str, "description": str, "componentPath": (str, type(None))}


def _decode_answer(answer: bytes, returncode: int | None) -> ValidationResult:
    """The child's answer: a result, or how it failed (a type's name).
    Anything else raises CheckFailed, never a crash: not JSON (a child that
    died first answers nothing), nested deeper than the decoder recurses
    (RecursionError), or not exactly an answer's fields, each of its type
    (deeper nesting than an answer's own fails there)."""
    stopped = f"child_exit_{exit_code(returncode or 0)}"
    try:
        document = json.loads(answer)
    except (ValueError, RecursionError):
        raise CheckFailed(stopped) from None
    if not isinstance(document, dict):
        raise CheckFailed(stopped)
    if "failure" in document:
        kind = document["failure"]
        kind = kind if isinstance(kind, str) and _FAILURE_KIND_RE.fullmatch(kind) else "unknown"
        if document.get("unavailable") is True:
            raise CollectorUnavailable(kind)
        raise CheckFailed(kind)
    if set(document) != {"valid", "errors", "requirements", "outcome"}:
        raise CheckFailed("malformed_answer")
    valid, errors, requirements, outcome = (
        document["valid"],
        document["errors"],
        document["requirements"],
        document["outcome"],
    )
    if (
        not isinstance(valid, bool)
        or not _records(errors, _ERROR_FIELDS)
        or not _records(requirements, _REQUIREMENT_FIELDS)
        or not isinstance(outcome, str)
        or not _FAILURE_KIND_RE.fullmatch(outcome)
    ):
        raise CheckFailed("malformed_answer")
    return ValidationResult(valid=valid, errors=errors, requirements=requirements, outcome=outcome)


def _records(value: object, fields: dict[str, type | tuple[type, ...]]) -> bool:
    """A list of objects with exactly `fields`, each of its type."""
    return isinstance(value, list) and all(
        isinstance(item, dict)
        and set(item) == set(fields)
        and all(isinstance(item[name], kind) for name, kind in fields.items())
        for item in value
    )


async def _end_check(child: tuple[asyncio.SubprocessTransport, _Pipes] | None, directory: str) -> bool:
    """Kill the check's process group, reap the child, wait (bounded) for
    the rest of the group to be gone, and remove the check's directory,
    whatever happens meanwhile: a cancellation (even a second one) doesn't
    stop it. Returns True when one arrived."""
    cancelled = False
    try:
        if child is not None:
            transport, pipes = child
            pid = transport.get_pid()
            _kill_group(pid)
            ending = asyncio.ensure_future(_reap_group(transport, pipes, pid))
            while not ending.done():
                try:
                    await asyncio.shield(ending)
                except asyncio.CancelledError:
                    cancelled = True
            ending.result()
    finally:
        # Off the event loop: a large directory takes a while,
        # and the loop serves every other request meanwhile. Waited for, never
        # canceled (a cancellation of the wait leaves the removal running),
        # so it isn't left half done; how it ended is read after.
        removing = asyncio.ensure_future(asyncio.to_thread(_remove_directory, directory))
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
            # The errors' types only: their text names the directory.
            logger.warning("a check's directory could not be removed (%s)", ", ".join(sorted(set(failures))))
    return cancelled


def _remove_directory(directory: str) -> list[str]:
    """Remove the check's directory and everything in it, carrying on past
    any entry that can't be removed (a failure doesn't leave the
    rest, the configuration's file included, behind). Returns the type of
    each failure, in order; an entry already gone is no failure."""
    failures: list[str] = []

    def record(_function: object, _path: str, error: BaseException) -> None:
        if not isinstance(error, FileNotFoundError):
            failures.append(type(error).__name__)

    shutil.rmtree(directory, onexc=record)
    return failures


def _kill_group(pgid: int) -> None:
    """SIGKILL every process in the group. A group's id isn't reused while
    any member lives, so whenever there is something to kill, the kill
    reaches only the check's own processes. (On the normal path the group is
    already empty: the child reaped its collector and exited.)"""
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass  # already gone (PermissionError: only zombies left, on macOS)


async def _reap_group(transport: asyncio.SubprocessTransport, pipes: _Pipes, pgid: int) -> None:
    """Reap the child (`_stop` kills it again, by its own pid, so a child
    that somehow isn't its group's leader still dies) and close its pipes,
    then poll, at most `_GROUP_GONE_POLLS` times, until no process of its
    group is left. Every step ends: the reap waits for the child's exit
    only, and the poll is bounded."""
    await _stop(transport, pipes)
    for _ in range(_GROUP_GONE_POLLS):
        try:
            os.killpg(pgid, 0)
        except (ProcessLookupError, PermissionError):
            return  # nobody left (or only zombies, which macOS refuses to signal)
        await asyncio.sleep(_GROUP_GONE_POLL_SECONDS)
    logger.warning("a killed check's processes outlived their kill (no init reaps them)")
