"""Syslog push-mode strategy: synthesize a loopback-only TCP syslog receiver,
wait for it to bind, replay the user's pre-framed fixture as raw bytes, hold,
stop.

- The port is leased for the whole run (`_shared._hold_free_port`), so an
  overlapping run can't be given it.
- The push is bounded by the replay's 30 s budget; a push that can't
  connect or runs out of budget fails the run with a message naming what
  happened (never an exception's text).
- The fixture is streamed from the staged input's own bytes.
- The strategy is split into its phases (`app/executors/base.py`).
- A pipeline with a Kubernetes processor waits for its informer before the
  push (``wait_for_cluster``, as the OTLP replay does): a connection from
  127.0.0.1 is the seed pod's, which ``from: connection`` resolves only once
  the informer has listed it.

The fixture is already syslog-framed (RFC3164/5424) — ``_replay_syslog_tcp``
streams it byte-for-byte without reframing.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path

from app.executors._shared import (
    _hold_free_port,
    _wait_for_ready,
    wait_for_informer,
)
from app.executors.base import ExecutorContext, FeedFailed
from app.settings import REPLAY_TOTAL_SECONDS
from app.yaml_mutations import MutationAdvisory, mutate_for_operator_test

logger = logging.getLogger(__name__)

NOT_SENT_MESSAGE = "the input could not be sent to the collector's syslog listener"
OUT_OF_BUDGET_MESSAGE = "the input was not fully sent: the replay's {seconds:g} s budget ran out"


class SyslogPushStrategy:
    """syslog operator-test strategy (PUSH: we stream bytes to loopback)."""

    kind = "syslog"

    def __init__(self) -> None:
        self._lease: _hold_free_port | None = None
        self.port: int | None = None

    def prepare(self, ctx: ExecutorContext) -> tuple[str, list[MutationAdvisory]]:
        lease = _hold_free_port()
        self.port = lease.__enter__()
        self._lease = lease
        try:
            return mutate_for_operator_test(
                ctx.yaml_config,
                ctx.signal_type,
                ctx.run_workspace.output_path,
                fixture_path=None,
                syslog_port=self.port,
                target_pipeline=ctx.target_pipeline,
            )
        except BaseException:
            self.close()
            raise

    def before_spawn(self) -> None:
        if self._lease is not None:
            self._lease.release_socket()

    async def wait_ready(self, ctx: ExecutorContext, collector) -> None:  # noqa: ANN001
        assert self.port is not None
        await _wait_for_ready(collector, "127.0.0.1", self.port)

    async def wait_for_cluster(self, ctx: ExecutorContext) -> None:
        await wait_for_informer(ctx.kwok_cluster)

    async def feed(self, ctx: ExecutorContext, collector) -> None:  # noqa: ANN001
        assert self.port is not None
        try:
            await asyncio.wait_for(
                _replay_syslog_tcp("127.0.0.1", self.port, ctx.cached_fixture),
                timeout=REPLAY_TOTAL_SECONDS,
            )
        except TimeoutError:
            raise FeedFailed(OUT_OF_BUDGET_MESSAGE.format(seconds=REPLAY_TOTAL_SECONDS)) from None
        except OSError:
            raise FeedFailed(NOT_SENT_MESSAGE) from None
        return None

    def decoded_input(self) -> str | None:
        return None

    def close(self) -> None:
        if self._lease is not None:
            self._lease.__exit__(None, None, None)
            self._lease = None


async def _replay_syslog_tcp(host: str, port: int, fixture_path: Path) -> None:
    """Stream the raw fixture bytes to a loopback syslog TCP listener and
    half-close so the receiver flushes the final message. The fixture is
    already syslog-framed (RFC3164/5424) — we do not reframe it.
    """
    reader, writer = await asyncio.open_connection(host, port)
    try:
        writer.write(fixture_path.read_bytes())
        await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
