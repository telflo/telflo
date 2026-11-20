"""Helpers shared across executor strategies.

The rules:

1. **Readiness** (``_wait_for_ready``): a TCP probe with a 10 s limit. It
   never drains or reads the collector's pipes (they are drained as the
   collector runs, `app/processes.py`) and its error names no output of the
   collector's (raw stderr in the message would reach the person
   unscrubbed). What the collector printed is in the run's logs, scrubbed.
   **The filelog strategy's readiness** (``_wait_for_ready_marker``): the
   hold doesn't start at spawn, so a slow start can't eat into it. It
   waits, within the same limit, for the collector's own "Everything is
   ready" line.
2. **The free port's race, closed while runs overlap** (``_hold_free_port``):
   an ephemeral port released before the collector binds it leaves a window
   another run (or any outgoing connection) could take the port in. Each
   run leases a port from a range below
   the kernels' ephemeral ranges (so no outgoing connection is ever given
   one) with a lock file that every run's child honours, held until the run
   ends; the probe socket that proves the port free is released just before
   the collector starts.
3. **The informer wait verifies the cluster** (``_wait_for_pod_listable``):
   polling the kwok apiserver's HTTPS port without its CA or a client
   certificate would make every kwok run wait the full 5.2 s. It verifies
   with the cluster's ``pki/ca.crt`` and presents ``admin.crt`` and
   ``admin.key``.
4. ``_finalize_run`` and ``_drain_stderr`` are gone: `app/run.py` stops the
   collector in a ``finally``, reaps it while its pipes drain, and reads the
   output in the answer's form (`app/output_reader.py`).
5. The OTLP replay's client is ``httpx2`` (``httpx`` brings ``certifi``,
   MPL-2.0), imported as ``httpx``.

``build_kwok_env``: ``KUBECONFIG`` only when the pipeline
uses a Kubernetes processor and the cluster is there.

6. **Every strategy waits for the informer** (``wait_for_informer``, Ruling
   30): without it, a strategy's first records could pass ``k8sattributes``
   before its informer had listed the seed pod. All three strategies call
   it between ready and feed.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import logging
import os
import random
import socket
import ssl
import tempfile
import time
from pathlib import Path

import httpx2 as httpx

from app.executors.base import CollectorNotReady, KwokEndpoint
from app.sandbox_env import KWOK_SEED_NAMESPACE, KWOK_SEED_POD, build_subprocess_env
from app.settings import COLLECTOR_READY_SECONDS

logger = logging.getLogger(__name__)

_READY_TIMEOUT_SECONDS = COLLECTOR_READY_SECONDS
_READY_POLL_INTERVAL_SECONDS = 0.1

# What the collector prints once its pipelines run (otelcol's own log line,
# "Everything is ready. Begin running and processing data.").
READY_MARKER = b"Everything is ready"

# Ports runs listen on: below Linux's ephemeral range (32768-60999) and
# macOS's (49152-65535), and above the well-known and registered ports most
# services take, so the kernel never hands one to an outgoing connection.
PORT_RANGE = (20000, 32000)
_PORT_ATTEMPTS = 256


def _port_lock_dir() -> Path:
    """Where runs' port locks live: one directory every run's child of this
    service shares (the system's temporary directory, the image's tmpfs)."""
    directory = Path(tempfile.gettempdir()) / "otelcol-testing-ports"
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


class _hold_free_port:
    """Lease a free 127.0.0.1 port for a run, for as long as the run lasts.

    ``with _hold_free_port() as port:`` picks a port in ``PORT_RANGE``,
    takes its lock (an exclusive ``flock`` on ``<port>.lock``, which no
    other run's child can take until this one lets go or dies), and binds a
    probe socket to it. ``release_socket()`` closes the probe just before
    the collector starts, so the collector can bind the port; the lock stays
    held until the context exits, so no overlapping run is ever given the
    same port. Each step is retried on another port when it fails.
    """

    def __init__(self, *, lock_dir: Path | None = None, rng: random.Random | None = None) -> None:
        self._lock_dir = lock_dir
        self._rng = rng or random.SystemRandom()
        self._socket: socket.socket | None = None
        self._lock: int | None = None
        self.port: int | None = None

    def __enter__(self) -> int:
        lock_dir = self._lock_dir or _port_lock_dir()
        for _ in range(_PORT_ATTEMPTS):
            port = self._rng.randrange(*PORT_RANGE)
            lock = _take_lock(lock_dir / f"{port}.lock")
            if lock is None:
                continue
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                probe.close()
                os.close(lock)
                continue
            self._socket, self._lock, self.port = probe, lock, port
            return port
        raise RuntimeError("no free port for the run's listener")

    def release_socket(self) -> None:
        """Close the probe socket (the lock stays held)."""
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    def __exit__(self, *exc: object) -> None:
        self.release_socket()
        if self._lock is not None:
            os.close(self._lock)  # closing the descriptor drops the flock
            self._lock = None


def _take_lock(path: Path) -> int | None:
    """An open descriptor holding ``path``'s exclusive lock, or None when
    another run holds it."""
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    except OSError:
        return None
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(descriptor)
        return None
    return descriptor


def build_kwok_env(kwok_cluster: KwokEndpoint | None, *, enabled: bool) -> dict[str, str]:
    """Build the subprocess environment for a collector run, injecting
    ``KUBECONFIG`` only when the user's pipeline actually uses k8s
    processors AND a kwok cluster is available. The KUBECONFIG path itself
    is logged at INFO without the value — see ``sandbox_env.build_subprocess_env``
    for the downward-API placeholders that always go through.
    """
    extra: dict[str, str] = {}
    if enabled and kwok_cluster is not None:
        extra["KUBECONFIG"] = str(kwok_cluster.kubeconfig_path)
        logger.info(
            "test run uses k8s processors; KUBECONFIG configured from kwok cluster"
        )
    return build_subprocess_env(extra)


async def _wait_for_ready(
    collector,  # noqa: ANN001 - app.executors.base.Collector
    host: str,
    port: int,
    *,
    timeout_seconds: float | None = None,
) -> None:
    """Poll until ``host:port`` accepts a TCP connection or we give up.

    Two failure modes, each raised as ``CollectorNotReady`` with fixed
    words (the collector's output is in the run's logs, not the message):

    1. **Process exited early** (e.g. config parse error).
    2. **Timed out with the collector still running** (e.g.
       ``k8sattributes`` blocking on missing kube creds). The caller stops
       the collector.
    """
    limit = _READY_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        if collector.returncode is not None:
            raise CollectorNotReady(
                f"collector exited before becoming ready (code {collector.returncode})"
            )
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port),
                timeout=_READY_POLL_INTERVAL_SECONDS,
            )
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            return
        except (OSError, asyncio.TimeoutError):
            await collector.exited_within(_READY_POLL_INTERVAL_SECONDS)

    if collector.returncode is not None:
        raise CollectorNotReady(
            f"collector exited before becoming ready (code {collector.returncode})"
        )
    raise CollectorNotReady(f"otlp endpoint {host}:{port} not ready within {limit}s")


async def _wait_for_ready_marker(
    collector,  # noqa: ANN001 - app.executors.base.Collector
    *,
    timeout_seconds: float | None = None,
) -> bool:
    """The filelog strategy's readiness: wait until the collector has printed
    ``READY_MARKER``. True once it has; False when the limit passes with
    the collector still running (the hold then starts anyway). A collector
    that exits first raises ``CollectorNotReady``."""
    limit = _READY_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
    deadline = time.monotonic() + limit
    while True:
        if READY_MARKER in collector.output_so_far():
            return True
        if collector.returncode is not None:
            raise CollectorNotReady(
                f"collector exited before becoming ready (code {collector.returncode})"
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        await collector.exited_within(min(_READY_POLL_INTERVAL_SECONDS / 2, remaining))


# Pause between "the collector is ready" and "feed it" when the pipeline has
# a k8sattributes / k8sobjects / k8s_cluster processor: those processors
# create a Kubernetes informer that does an initial list+watch sync against
# the apiserver; records fed before that sync silently miss the k8s.*
# attributes. The run's 5.2 s informer phase is these two together.
K8S_INFORMER_SYNC_TIMEOUT_SECONDS = 5.0
K8S_INFORMER_POST_LIST_BUFFER_SECONDS = 0.2


async def wait_for_informer(cluster: KwokEndpoint | None) -> None:
    """Give a Kubernetes processor's informer a moment to populate before the
    input is fed (each strategy's ``wait_for_cluster``; `app/run.py` calls it
    only for a pipeline that uses one, with the cluster up): the seed pod
    listable from the apiserver, then a short buffer."""
    if cluster is None or cluster.apiserver_url is None:
        return
    await _wait_for_pod_listable(
        cluster.apiserver_url,
        KWOK_SEED_NAMESPACE,
        KWOK_SEED_POD,
        timeout_seconds=K8S_INFORMER_SYNC_TIMEOUT_SECONDS,
        pki_dir=cluster.pki_dir,
    )
    await asyncio.sleep(K8S_INFORMER_POST_LIST_BUFFER_SECONDS)


def _cluster_ssl_context(pki_dir: Path) -> ssl.SSLContext:
    """The kwok cluster's TLS: its CA verifies the apiserver, and the admin
    certificate is presented to it."""
    context = ssl.create_default_context(cafile=str(pki_dir / "ca.crt"))
    context.load_cert_chain(str(pki_dir / "admin.crt"), str(pki_dir / "admin.key"))
    return context


async def _wait_for_pod_listable(
    apiserver_url: str,
    namespace: str,
    pod_name: str,
    *,
    timeout_seconds: float,
    poll_interval_seconds: float = 0.1,
    pki_dir: Path | None = None,
    warn_on_timeout: bool = True,
) -> bool:
    """Poll the kwok apiserver until ``pod_name`` in ``namespace`` returns
    200 OK, or the timeout elapses. With ``pki_dir`` (the cluster's), the
    apiserver is verified with its CA and the admin certificate presented.

    Returns True on success, False on timeout (the liveness probe,
    `app/kwok_cluster.py`'s ``is_alive``, passes ``warn_on_timeout=False``
    and logs its own words). Caller decides whether to
    proceed or raise — today we proceed in both cases: if the apiserver is
    unresponsive the k8sattributes processor's own startup error will
    surface in the logs, which is more informative than a synthetic raise.

    Why pre-existence of the pod is a sufficient proxy for informer-cache
    sync: the processor's informer does a list+watch against the same
    apiserver. Once a GET on the pod URL returns 200, a LIST in the same
    namespace will include it (apiserver consistency model). The processor
    sees that LIST result, builds its cache, and the next attribute lookup
    succeeds.
    """
    deadline = time.monotonic() + timeout_seconds
    url = f"{apiserver_url}/api/v1/namespaces/{namespace}/pods/{pod_name}"
    options: dict[str, object] = {"timeout": 1.0, "trust_env": False}
    if pki_dir is not None:
        try:
            options["verify"] = _cluster_ssl_context(pki_dir)
        except (OSError, ssl.SSLError) as error:
            logger.warning("kwok's certificates could not be read (%s); polling without them", type(error).__name__)
    async with httpx.AsyncClient(**options) as client:
        while time.monotonic() < deadline:
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    logger.debug("kwok pod %s/%s listable", namespace, pod_name)
                    return True
            except httpx.RequestError as e:
                logger.debug("apiserver poll transport error: %s", type(e).__name__)
            await asyncio.sleep(poll_interval_seconds)
    if warn_on_timeout:
        logger.warning(
            "kwok pod %s/%s not listable within %.1fs; proceeding anyway",
            namespace,
            pod_name,
            timeout_seconds,
        )
    return False
