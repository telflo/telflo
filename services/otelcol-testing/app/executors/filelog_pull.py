"""Filelog pull-mode strategy: synthesize a fresh filelog receiver pointing
at a staged ``input.log``, run the collector, wait until it is ready, hold,
stop.

D14a Task 4:

- **Readiness** (``wait_ready``): the hold doesn't count from the spawn, so
  a slow start can't eat into it. It starts once the collector says it is
  ready (`_shared._wait_for_ready_marker`), or at the
  readiness limit if it never says so.
- The staged file is the input's own bytes, written without following a
  symlink; the directories of a container-runtime path are made inside the
  run's workspace, mode 0700.
- The strategy is split into its phases (`app/executors/base.py`).
- **A pipeline with a Kubernetes processor waits for its informer**
  (Ruling 30), as the OTLP replay does: the input isn't staged before the
  collector starts but once it is ready and the informer wait is over
  (``feed``), written beside the staged path and renamed onto it, so filelog
  finds the whole file at its next poll (a file that appears after start is
  read from its beginning) and its first record can't pass ``k8sattributes``
  before the seed pod is in the informer's cache (staged before the spawn,
  filelog would read it while the informer was still syncing). Without a
  Kubernetes processor (or a cluster) the input is staged before the spawn.

There is **no OTLP listener** to bind, no port to reserve, and no HTTP
replay push. The collector reads the file itself via filelog. The user's
operator chain runs unchanged inside the synthesized receiver — that's the
whole point. See ``testable_receivers.synthesize_filelog`` for the
fail-closed allowlist of knobs that carry over.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from ruamel.yaml import YAML

from app.executors._shared import _wait_for_ready_marker, wait_for_informer
from app.executors.base import ExecutorContext
from app.testable_receivers import (
    detect_testable_receiver,
    has_container_operator,
)
from app.yaml_mutations import MutationAdvisory, mutate_for_operator_test, processor_needs_k8s

logger = logging.getLogger(__name__)


def choose_staging_path(ctx: ExecutorContext) -> Path:
    """Pick where the raw-lines fixture is staged. Chains with a
    ``container`` operator get the container-runtime-shaped path matching
    the KWOK seed pod, so ``add_metadata_from_filepath`` derives a resolvable
    identity instead of parsing nothing out of ``input.log``.

    The uid segment comes from the LIVE cluster (``seed_pod_uid`` read back
    after seeding) — the apiserver assigns pod uids server-side, so baking
    the manifest's pinned constant here made k8sattributes association by
    ``k8s.pod.uid`` miss and silently disabled deployment/node/annotation
    enrichment."""
    try:
        doc = YAML().load(ctx.yaml_config) or {}
    except Exception:
        return ctx.run_workspace.raw_input_path
    if not isinstance(doc, dict):
        return ctx.run_workspace.raw_input_path
    tr = detect_testable_receiver(
        doc, signal_type=ctx.signal_type, target_pipeline=ctx.target_pipeline
    )
    if tr is None:
        return ctx.run_workspace.raw_input_path
    user_cfg = (doc.get("receivers") or {}).get(tr.name) or {}
    if has_container_operator(user_cfg):
        if ctx.kwok_cluster is not None and ctx.kwok_cluster.seed_pod_uid:
            return ctx.run_workspace.container_log_path(
                ctx.kwok_cluster.seed_pod_uid
            )
        return ctx.run_workspace.container_log_path()
    return ctx.run_workspace.raw_input_path


# Where a deferred staging writes before its rename: the workspace's root,
# which the synthesized receiver's ``include`` (the staged path only) never
# names.
STAGING_TEMPORARY_NAME = "input.staging"


def _staging_directories(staged: Path, root: Path) -> None:
    """Make the staged path's directories (mode 0700) inside ``root``, the
    run's workspace."""
    staged.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not staged.resolve().is_relative_to(root.resolve()):
        raise ValueError("the staging path leaves the run's workspace")


def _write_new(path: Path, source: Path) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(source.read_bytes())


def _stage(source: Path, staged: Path, root: Path) -> None:
    """Copy the input's bytes to ``staged`` (inside ``root``, the run's
    workspace), making its directories (mode 0700) and never following a
    symlink to the file."""
    _staging_directories(staged, root)
    _write_new(staged, source)


def _stage_whole(source: Path, staged: Path, root: Path) -> None:
    """Stage the input while the collector runs (Ruling 30): written in
    full beside it first, then renamed onto ``staged``, so filelog never
    reads part of it."""
    temporary = root / STAGING_TEMPORARY_NAME
    _write_new(temporary, source)
    os.rename(temporary, staged)


class FilelogPullStrategy:
    """filelog operator-test strategy (PULL: collector tails staged file)."""

    kind = "filelog"

    def __init__(self) -> None:
        self.staged: Path | None = None
        self.ready_marker_seen: bool | None = None
        # Staged in ``feed``, after the informer wait (Ruling 30).
        self.deferred = False

    def prepare(self, ctx: ExecutorContext) -> tuple[str, list[MutationAdvisory]]:
        staged = choose_staging_path(ctx)
        # The run waits for the informer exactly when the pipeline has a
        # Kubernetes processor and the cluster is up (`app/run.py`'s
        # ``kwok_enabled``): then the input is staged once that wait is over.
        self.deferred = ctx.kwok_cluster is not None and processor_needs_k8s(ctx.yaml_config)
        if self.deferred:
            _staging_directories(staged, ctx.run_workspace.root)
        else:
            _stage(ctx.cached_fixture, staged, ctx.run_workspace.root)
        self.staged = staged
        return mutate_for_operator_test(
            ctx.yaml_config,
            ctx.signal_type,
            ctx.run_workspace.output_path,
            fixture_path=staged,
            syslog_port=None,
            target_pipeline=ctx.target_pipeline,
        )

    def before_spawn(self) -> None:
        return None

    async def wait_ready(self, ctx: ExecutorContext, collector) -> None:  # noqa: ANN001
        # Hold the collector open while filelog drains the staged file and
        # runs the user's operator chain on every line; the hold starts once
        # the collector is ready.
        self.ready_marker_seen = await _wait_for_ready_marker(collector)

    async def wait_for_cluster(self, ctx: ExecutorContext) -> None:
        await wait_for_informer(ctx.kwok_cluster)

    async def feed(self, ctx: ExecutorContext, collector) -> None:  # noqa: ANN001
        # No port to probe, no push to coordinate: a deferred input is
        # staged now, once the informer wait is over (Ruling 30).
        if self.deferred and self.staged is not None:
            await asyncio.to_thread(_stage_whole, ctx.cached_fixture, self.staged, ctx.run_workspace.root)
        return None

    def decoded_input(self) -> str | None:
        return None

    def close(self) -> None:
        return None
