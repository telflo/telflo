"""OTLP-replay strategy: replace all user receivers with a sandbox OTLP/HTTP
listener, then HTTP-POST the user's fixture (OTLP-JSON) to it.

- **The input arrives as bytes** (the staged ``input.raw``), never decoded
  first, so ``_decode_fixture``'s UTF-16 handling is reachable.
- **The replay's 30 s total budget**: each POST has 5 s at most, and once the
  budget is spent the remaining payloads aren't sent; the hold still runs,
  and the ``[replay]`` block says "N of M payloads not sent: the replay's
  30 s budget ran out". Both are hard bounds: every POST is awaited under
  ``asyncio.wait_for(min(what is left of the budget, 5 s))``, since httpx's
  own timeouts bound each read, not the request, and a receiver answering a
  byte at a time would outlast them. A POST that runs out its 5 s is a
  rejection ("no answer within 5 s"); one the budget's end cuts short counts
  as not sent.
- The strategy is split into its phases (`app/executors/base.py`): the
  collector is spawned, stopped and read by `app/run.py`.
- The informer wait verifies the cluster with its certificates
  (`_shared._wait_for_pod_listable`).
- ``httpx2`` replaces ``httpx``, imported as ``httpx``; the client ignores
  proxy variables (``trust_env=False``).
- ``_decode_fixture`` replaces what it can't decode after a BOM, so a
  malformed UTF-8 or UTF-16 file that begins with one never raises.

This is the default for any pipeline whose target-signal receivers aren't
``filelog`` or ``syslog``. OTLP-only helpers (``_replay_file``,
``_decode_fixture``, ``_iter_payloads``, ``_prepend_replay_summary``,
``_ReplaySummary``) live in this file because no other strategy uses them.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx2 as httpx

from app.executors._shared import (
    _hold_free_port,
    _wait_for_ready,
    wait_for_informer,
)
from app.executors.base import ExecutorContext
from app.settings import REPLAY_POST_SECONDS, REPLAY_TOTAL_SECONDS
from app.yaml_mutations import MutationAdvisory, mutate_for_otlp_replay

logger = logging.getLogger(__name__)

_SIGNAL_PATHS = {
    "metrics": "/v1/metrics",
    "traces": "/v1/traces",
    "logs": "/v1/logs",
}


class OtlpReplayStrategy:
    """Default strategy: synthesize OTLP/HTTP listener + HTTP-POST replay."""

    kind = "otlp"

    def __init__(self) -> None:
        self._lease: _hold_free_port | None = None
        self.port: int | None = None
        self._decoded: str | None = None

    def prepare(self, ctx: ExecutorContext) -> tuple[str, list[MutationAdvisory]]:
        # Decode once here so the run can answer the OTLP-shaped input
        # alongside the output (the platform's Compare viewer reads it).
        self._decoded = _decode_fixture(ctx.cached_fixture.read_bytes())
        # Hold the picker socket open through mutation + config write, and
        # the port's lease through the whole run (`_hold_free_port`).
        lease = _hold_free_port()
        self.port = lease.__enter__()
        self._lease = lease
        try:
            return mutate_for_otlp_replay(
                ctx.yaml_config,
                ctx.signal_type,
                ctx.run_workspace.output_path,
                self.port,
                target_pipeline=ctx.target_pipeline,
            )
        except BaseException:
            self.close()
            raise

    def before_spawn(self) -> None:
        # Release the picker socket immediately before spawn so the OS won't
        # complain "address in use" when the collector binds.
        if self._lease is not None:
            self._lease.release_socket()

    async def wait_ready(self, ctx: ExecutorContext, collector) -> None:  # noqa: ANN001
        assert self.port is not None
        await _wait_for_ready(collector, "127.0.0.1", self.port)

    async def wait_for_cluster(self, ctx: ExecutorContext) -> None:
        """If the user's pipeline has k8sattributes (or similar), give the
        informer cache a moment to populate before sending data. Without
        this, the first records arrive while the watcher is still
        listing/syncing and enrichment silently doesn't happen
        (`_shared.wait_for_informer`, which the other strategies share)."""
        await wait_for_informer(ctx.kwok_cluster)

    async def feed(self, ctx: ExecutorContext, collector) -> _ReplaySummary:  # noqa: ANN001
        assert self.port is not None
        signal_path = _SIGNAL_PATHS[ctx.signal_type]
        url = f"http://127.0.0.1:{self.port}{signal_path}"
        return await _replay_file(url, ctx.cached_fixture)

    def decoded_input(self) -> str | None:
        return self._decoded

    def close(self) -> None:
        if self._lease is not None:
            self._lease.__exit__(None, None, None)
            self._lease = None


# ---------------------------------------------------------------------------
# OTLP-only replay helpers (rejections, decoding, payload iteration)
# ---------------------------------------------------------------------------


@dataclass
class _ReplayRejection:
    """One non-blank fixture line the collector refused or couldn't reach.

    ``status`` is the HTTP status code returned, or ``None`` for transport
    errors (connection refused mid-replay, etc.). ``body_excerpt`` is the
    first chunk of the response body — bounded so a misbehaving collector
    can't blow up the run's logs.
    """

    lineno: int
    status: int | None
    body_excerpt: str


@dataclass
class _ReplaySummary:
    """Aggregate result of replaying a fixture: how many non-blank lines
    there were, how many were sent, and which ones were rejected. Total is
    needed to render 'N of M' in the user-visible summary so an absolute
    number isn't misleading on a single-line fixture vs a thousand-line one.

    ``sent`` is None when every payload was sent; otherwise the count sent
    before the budget ran out.
    """

    total_lines: int
    rejections: list[_ReplayRejection]
    sent: int | None = None
    budget_seconds: float = REPLAY_TOTAL_SECONDS

    @property
    def sent_count(self) -> int:
        return self.total_lines if self.sent is None else self.sent

    @property
    def not_sent(self) -> int:
        return self.total_lines - self.sent_count

    @property
    def fully_rejected(self) -> bool:
        """True when at least one payload was sent and *every* one sent was
        rejected. The run's output is then meaningless (nothing reached the
        pipeline), so the run fails rather than letting an empty output
        stand as a success."""
        return self.sent_count > 0 and len(self.rejections) == self.sent_count


def _decode_fixture(data: bytes) -> str:
    """Decode a fixture file to text, tolerating the encodings users actually
    upload.

    Windows tooling (PowerShell ``>``/``Out-File``, Notepad "Unicode", some
    editors) routinely produces UTF-16 or BOM-prefixed UTF-8. The OTLP/HTTP
    receiver only accepts UTF-8 and rejects the NUL padding bytes of UTF-16
    on the first byte, so without normalization a perfectly valid fixture is
    100% rejected and the run silently shows no output. Detect the common
    cases by BOM, fall back to a UTF-16 attempt when a strict UTF-8 decode
    fails, and only then lossily replace so we still post *something* with a
    diagnosable error rather than crashing the run.
    """
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig", errors="replace")
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        return data.decode("utf-16", errors="replace")
    # BOM-less UTF-16 can't be caught by a UTF-8 try/except: ASCII-range
    # UTF-16 is just ASCII bytes interleaved with NULs, and NUL (U+0000) is
    # a *valid* UTF-8 codepoint, so `decode("utf-8")` succeeds and yields
    # text full of "\x00" — which is exactly what the collector rejected.
    # Detect it by the NUL density in the bytes instead, and infer
    # endianness from which offset parity the NULs sit on.
    sample = data[:4096]
    if sample and sample.count(0) >= len(sample) // 4:
        be_nuls = sum(1 for i in range(0, len(sample), 2) if sample[i] == 0)
        le_nuls = sum(1 for i in range(1, len(sample), 2) if sample[i] == 0)
        codec = "utf-16-be" if be_nuls >= le_nuls else "utf-16-le"
        with contextlib.suppress(UnicodeDecodeError):
            return data.decode(codec)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def _iter_payloads(text: str) -> list[tuple[int, str]]:
    """Split a decoded fixture into ``(label, payload_json)`` units to POST.

    Accepts the three shapes users actually have:

    1. A single OTLP document — possibly pretty-printed across many lines
       (``{"resourceLogs": [...]}``). Posted as one request.
    2. A JSON array of OTLP documents — each element posted separately.
    3. Newline-delimited JSON — one complete OTLP document per line.

    ``label`` is a 1-based index for whole-document/array modes and the
    source line number for NDJSON, used only for the user-facing rejection
    summary.
    """
    stripped = text.strip()
    if stripped:
        try:
            doc = json.loads(stripped)
        except (ValueError, RecursionError):
            doc = None
        if isinstance(doc, dict):
            return [(1, stripped)]
        if isinstance(doc, list):
            return [
                (i, json.dumps(item, separators=(",", ":")))
                for i, item in enumerate(doc, start=1)
            ]
    payloads: list[tuple[int, str]] = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if line:
            payloads.append((lineno, line))
    return payloads


async def _replay_file(
    url: str,
    input_path: Path,
    *,
    budget_seconds: float = REPLAY_TOTAL_SECONDS,
    post_timeout_seconds: float = REPLAY_POST_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> _ReplaySummary:
    """POST each payload of the fixture to ``url``, each within
    ``post_timeout_seconds``, all within ``budget_seconds``, both hard bounds
    (``asyncio.wait_for``): once the budget is spent, the rest aren't sent
    (``_ReplaySummary.sent``). Nothing of a payload or an answer is logged."""
    rejections: list[_ReplayRejection] = []
    payloads = _iter_payloads(_decode_fixture(input_path.read_bytes()))
    deadline = clock() + budget_seconds
    sent = 0
    ran_out = False
    async with httpx.AsyncClient(timeout=post_timeout_seconds, trust_env=False) as client:
        for label, payload in payloads:
            remaining = deadline - clock()
            if remaining <= 0:
                ran_out = True
                break
            post = client.post(
                url,
                content=payload.encode("utf-8", "replace"),
                headers={"Content-Type": "application/json"},
            )
            # A hard bound on this POST: its own 5 s, or what is
            # left of the budget when that is less.
            budget_bound = remaining <= post_timeout_seconds
            try:
                resp = await asyncio.wait_for(post, timeout=remaining if budget_bound else post_timeout_seconds)
            except TimeoutError:
                if budget_bound:
                    # The budget ran out while this payload was in flight: it
                    # counts as not sent, and no more are.
                    ran_out = True
                    break
                # The receiver didn't answer within the POST's 5 s: a
                # rejection, as a transport error is; the replay goes on.
                sent += 1
                rejections.append(
                    _ReplayRejection(
                        lineno=label,
                        status=None,
                        body_excerpt=f"transport error: no answer within {post_timeout_seconds:g} s",
                    )
                )
                continue
            except httpx.RequestError as e:
                sent += 1
                rejections.append(
                    _ReplayRejection(
                        lineno=label,
                        status=None,
                        body_excerpt=f"transport error: {e}",
                    )
                )
                continue
            sent += 1
            if resp.status_code >= 400:
                rejections.append(
                    _ReplayRejection(
                        lineno=label,
                        status=resp.status_code,
                        body_excerpt=resp.text[:200],
                    )
                )
    return _ReplaySummary(
        total_lines=len(payloads),
        rejections=rejections,
        sent=sent if ran_out else None,
        budget_seconds=budget_seconds,
    )


def _prepend_replay_summary(stderr: str, summary: _ReplaySummary) -> str:
    """If any replay lines were rejected, or the budget left some unsent,
    prepend a structured ``[replay]`` block to the collector's logs so the
    user sees it at the top of the run-detail view. No-op otherwise — keeps
    the success path's logs unchanged.
    """
    lines: list[str] = []
    if summary.rejections:
        lines.append(
            f"[replay] {len(summary.rejections)} of {summary.total_lines} "
            "fixture line(s) rejected by the collector:"
        )
        for r in summary.rejections[:5]:
            status = str(r.status) if r.status is not None else "transport"
            lines.append(f"  line {r.lineno} ({status}): {r.body_excerpt}")
        if len(summary.rejections) > 5:
            lines.append(f"  … +{len(summary.rejections) - 5} more")
    if summary.not_sent > 0:
        lines.append(
            f"[replay] {summary.not_sent} of {summary.total_lines} payloads not sent: "
            f"the replay's {summary.budget_seconds:g} s budget ran out"
        )
    if not lines:
        return stderr
    block = "\n".join(lines)
    if not stderr:
        return block + "\n"
    return block + "\n\n" + stderr
