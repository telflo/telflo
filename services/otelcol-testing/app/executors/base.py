"""What a run's strategy works with, and what it reports.

D14a Task 4:

- A strategy never spawns or stops the collector, or reads its output:
  `app/run.py` does those for every strategy (the pipes drained as the
  collector runs, the collector stopped in a ``finally``, the output read in
  the answer's form). A strategy is the per-kind part: it stages the input
  and mutates the text (``prepare``), says when the collector is ready
  (``wait_ready``), waits for a Kubernetes processor's informer
  (``wait_for_cluster``, Ruling 30) and feeds it (``feed``).
- ``cached_fixture`` is the input exactly as the service staged it (its
  bytes, never decoded first), and ``kwok_cluster`` is the cluster's
  endpoint as the service passes it to the run's child (``KwokEndpoint``):
  the kubeconfig, the apiserver's URL, the seed pod's live uid and the
  cluster's certificates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from app.run_workspace import RunWorkspace
from app.yaml_mutations import MutationAdvisory


@dataclass(frozen=True)
class KwokEndpoint:
    """The tester's fake cluster, as a run's child sees it."""

    kubeconfig_path: Path
    apiserver_url: str | None = None
    seed_pod_uid: str | None = None
    pki_dir: Path | None = None


@dataclass
class ExecutorContext:
    """Per-run inputs handed to a strategy.

    ``cached_fixture`` is the input as the service staged it in the run's
    workspace; ``kwok_cluster`` is set when the tester's cluster is up.
    """

    yaml_config: str
    signal_type: str
    cached_fixture: Path
    run_workspace: RunWorkspace
    binary: Path
    duration_seconds: int
    kwok_cluster: KwokEndpoint | None
    max_output_bytes: int
    # The single pipeline key the user chose to test. When set, R-005 keeps
    # only this pipeline; None keeps all same-signal pipelines.
    target_pipeline: str | None = None


class CollectorNotReady(Exception):
    """The collector exited, or never listened, before the run could feed
    it. ``message`` is fixed words, without the collector's output (that
    is in the run's logs, scrubbed)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class FeedFailed(Exception):
    """The input couldn't be fed to a ready collector (the syslog
    listener refused the connection, say). ``message`` names what failed."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class Collector(Protocol):
    """The running collector, as a strategy watches it (`app/run.py`'s)."""

    @property
    def returncode(self) -> int | None: ...

    def output_so_far(self) -> bytes: ...

    async def exited_within(self, seconds: float) -> bool: ...


class TestStrategy(Protocol):
    """One kind of run: stage the input, mutate the text, say when the
    collector is ready, feed it. A ``Protocol`` (not an ABC): strategies are
    plain classes; ``pick_strategy`` returns whichever matches the text."""

    kind: str

    def prepare(self, ctx: ExecutorContext) -> tuple[str, list[MutationAdvisory]]: ...

    def before_spawn(self) -> None: ...

    async def wait_ready(self, ctx: ExecutorContext, collector: Collector) -> None: ...

    async def wait_for_cluster(self, ctx: ExecutorContext) -> None:
        """The kwok informer wait, between ready and feed, for a pipeline
        with a Kubernetes processor (every strategy's, Ruling 30)."""
        ...

    async def feed(self, ctx: ExecutorContext, collector: Collector) -> object | None: ...

    def decoded_input(self) -> str | None: ...

    def close(self) -> None: ...


@dataclass
class RunOutcome:
    # Did the collector itself start, run, and shut down cleanly? This is
    # distinct from "produced output" — a pipeline whose `filter` processor
    # legitimately drops every record runs cleanly but emits nothing. The
    # run's answer is `succeeded` when it did (D14a decision 4: a run ends
    # Success or Error; rules are D15's).
    collector_ok: bool
    output: dict = field(default_factory=dict)
    stderr: str = ""
    duration_ms: int = 0
    # The YAML actually executed by otelcol-contrib, after sandbox mutations.
    # Answered so users can audit what we ran vs. what they wrote.
    mutated_yaml: str = ""
    # Stable-ID advisories describing each mutation (the service's README
    # lists them).
    advisories: list[MutationAdvisory] = field(default_factory=list)
    # True iff this run actually exercised the kwok-simulated apiserver
    # (the user's pipeline contained a k8s-touching processor AND a kwok
    # cluster was available).
    kwok_enabled: bool = False
    # Decoded fixture text the executor sent to the receiver. Populated by
    # the OTLP-replay strategy; filelog/syslog leave it empty.
    decoded_input: str = ""
