"""The fake Kubernetes cluster's state, as health answers it (D14a spec
decision 6, Preflight ruling 5, Ruling 26).

The service listens first and starts kwok in the background. While it
starts, health answers 503 `{"status": "starting", "kwok": "starting"}`
and a run is refused with 503 `tester_starting`; once it is up, 200
`{"status": "ok", "kwok": "ready"}`. kwok is part of the tester's health
(Ruling 26): a start that fails is retried, three attempts in all with a
backoff between them (still `starting`); after the last, health answers 503
`{"status": "unavailable", "kwok": "failed"}`, a run is refused with 503
`tester_unavailable`, and the supervisor calls ``on_gave_up``: in the
service, that ends the process with a non-zero status, so compose's restart
policy starts it afresh (`app/main.py`). A run is never served "without
kwok": a Kubernetes pipeline would silently test differently.

Once it is up, the cluster's liveness is re-checked (Ruling 29): by health,
and before each run (``check_alive``). A cluster that no longer answers
(its ``is_alive()`` false or failing) on two probes in a row (Ruling 33: one
stall of a few seconds isn't a dead cluster) moves kwok to `failed`, with
the same consequences: health 503 `unavailable`/`failed`, runs refused with
503 `tester_unavailable`, and ``on_gave_up`` (the service's exit). Checks
that overlap share one probe; a probe that answers resets the count.

The supervisor runs a `starter`, a coroutine that brings the cluster up and
returns its handle (anything with an async `stop()` and a `kubeconfig`
path; `app/kwok_cluster.py`'s ``start_from_environment`` in the service),
or None when there is none to stop (``no_cluster``, the tests' default).
"""

from __future__ import annotations

import asyncio
import enum
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# Ruling 33: probes that must fail in a row before a ready cluster is failed.
LIVENESS_FAILURES_BEFORE_FAILED = 2

# Ruling 26: three attempts, a backoff before each retry.
START_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS: tuple[float, ...] = (2.0, 4.0)


class KwokState(enum.Enum):
    STARTING = "starting"
    READY = "ready"
    FAILED = "failed"


class Cluster(Protocol):
    """A started cluster. It may also have ``async is_alive() -> bool``, the
    liveness probe (`app/kwok_cluster.py`'s); without one it is taken to be
    alive."""

    kubeconfig: Any

    async def stop(self) -> None: ...


@dataclass(frozen=True)
class ClusterEndpoint:
    """What a run's child needs of the cluster (`app/run.py`'s request):
    its kubeconfig, its apiserver's URL, the seed pod's live uid and its
    certificates' directory. Paths and URL as text."""

    kubeconfig: str
    apiserver_url: str | None = None
    seed_pod_uid: str | None = None
    pki_dir: str | None = None


Starter = Callable[[], Awaitable["Cluster | None"]]


async def no_cluster() -> None:
    """No cluster: the tests' starter (the service starts kwok's)."""
    return None


def _text(value: object) -> str | None:
    return None if value is None else str(value)


class KwokSupervisor:
    """Starts the cluster in the background, retrying a failed start, and
    says how it went."""

    def __init__(
        self,
        starter: Starter = no_cluster,
        *,
        attempts: int = START_ATTEMPTS,
        backoff_seconds: Sequence[float] = RETRY_BACKOFF_SECONDS,
        on_gave_up: Callable[[], None] | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        liveness_failures: int = LIVENESS_FAILURES_BEFORE_FAILED,
    ) -> None:
        self._starter = starter
        self._sleep = sleep
        self._attempts = max(attempts, 1)
        self._backoff = tuple(backoff_seconds)
        self._on_gave_up = on_gave_up
        self._task: asyncio.Task[None] | None = None
        self._probe: asyncio.Future[None] | None = None
        self._gave_up = False
        self._liveness_failures_allowed = max(liveness_failures, 1)
        self.liveness_failures = 0  # in a row
        self.state = KwokState.STARTING
        self.cluster: Cluster | None = None
        self.failures = 0

    @property
    def kubeconfig(self) -> str | None:
        """The cluster's kubeconfig path, once it is ready."""
        if self.state is not KwokState.READY or self.cluster is None:
            return None
        path = getattr(self.cluster, "kubeconfig", None)
        return str(path) if path is not None else None

    @property
    def endpoint(self) -> ClusterEndpoint | None:
        """The cluster as a run's child reaches it, once it is ready."""
        kubeconfig = self.kubeconfig
        if kubeconfig is None:
            return None
        return ClusterEndpoint(
            kubeconfig=kubeconfig,
            apiserver_url=_text(getattr(self.cluster, "apiserver_url", None)),
            seed_pod_uid=_text(getattr(self.cluster, "seed_pod_uid", None)),
            pki_dir=_text(getattr(self.cluster, "pki_dir", None)),
        )

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="kwok start")

    def _backoff_before(self, retry: int) -> float:
        if not self._backoff:
            return 0.0
        return self._backoff[min(retry, len(self._backoff) - 1)]

    async def _run(self) -> None:
        for attempt in range(self._attempts):
            if attempt:
                await self._sleep(self._backoff_before(attempt - 1))
            try:
                self.cluster = await self._starter()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - the type only: kwok's messages name paths
                self.failures += 1
                logger.error(
                    "kwok failed to start (attempt %d of %d): %s", attempt + 1, self._attempts, type(error).__name__
                )
                continue
            self.state = KwokState.READY
            return
        self.state = KwokState.FAILED
        logger.error("kwok failed to start %d times; the tester can't serve runs", self._attempts)
        self._give_up()

    def _give_up(self) -> None:
        if self._gave_up:
            return
        self._gave_up = True
        if self._on_gave_up is not None:
            self._on_gave_up()

    async def check_alive(self) -> KwokState:
        """kwok's state, the cluster's liveness re-checked first when it is
        ready (Ruling 29). A probe already running is shared, not repeated;
        a cancelled caller leaves it to finish."""
        if self.state is not KwokState.READY or self.cluster is None:
            return self.state
        probe = getattr(self.cluster, "is_alive", None)
        if probe is None:
            return self.state
        if self._probe is None or self._probe.done():
            self._probe = asyncio.ensure_future(self._check(probe))
        await asyncio.shield(self._probe)
        return self.state

    async def _check(self, probe: Callable[[], Awaitable[bool]]) -> None:
        try:
            alive = await probe()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - the type only: kwok's messages name paths
            logger.error("kwok's liveness probe failed: %s", type(error).__name__)
            alive = False
        if self.state is not KwokState.READY:
            return
        if alive:
            self.liveness_failures = 0
            return
        self.liveness_failures += 1
        if self.liveness_failures < self._liveness_failures_allowed:
            logger.warning(
                "kwok's cluster didn't answer a liveness probe (%d in a row); it is failed at %d",
                self.liveness_failures,
                self._liveness_failures_allowed,
            )
            return
        self.state = KwokState.FAILED
        logger.error("kwok's cluster stopped answering; the tester can't serve runs")
        self._give_up()

    async def stop(self) -> None:
        if self._probe is not None and not self._probe.done():
            self._probe.cancel()
            try:
                await self._probe
            except asyncio.CancelledError:
                pass
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self.cluster is not None:
            cluster, self.cluster = self.cluster, None
            try:
                await cluster.stop()
            except Exception as error:  # noqa: BLE001 - shutting down: logged, never raised
                logger.warning("kwok failed to stop: %s", type(error).__name__)
