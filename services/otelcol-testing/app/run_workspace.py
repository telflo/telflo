"""A run's scratch directory and the paths in it.

- **A workspace that already exists is refused, never removed**, so a run
  sent twice can't delete the live run's workspace. Entering one that
  exists raises ``FileExistsError``; the directory is made mode 0700.
- **The service makes each run's workspace** (`app/runner.py`: a fresh
  ``mkdtemp`` directory, removed before the run's slot frees), so the run's
  child wraps that directory with ``RunWorkspace.existing`` and neither
  makes nor removes it. The context-manager form stays for the tests.
- ``staged_input_path`` is the input as the service staged it, its bytes
  untouched (`app/run.py`'s ``input.raw``), so a UTF-16 input reaches the
  OTLP replay's decoder undecoded.

Provides isolation between concurrent runs: each run has its own directory.
The directory is cleaned on context exit unless the run failed and
``keep_on_failure`` is True.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from types import TracebackType
from uuid import UUID

from app.kwok_cluster import (
    SEED_CONTAINER_NAME,
    SEED_NAMESPACE,
    SEED_POD_NAME,
    SEED_POD_UID,
)

logger = logging.getLogger(__name__)

# The input as the service staged it (app/runner.py writes it, app/run.py
# names it).
STAGED_INPUT_NAME = "input.raw"


class RunWorkspace:
    """Per-run scratch directory holding config.yaml, input, and output."""

    def __init__(
        self,
        run_id: UUID,
        base: Path,
        *,
        keep_on_failure: bool = False,
    ) -> None:
        self._root = Path(base) / str(run_id)
        self._keep_on_failure = keep_on_failure

    @classmethod
    def existing(cls, root: Path) -> RunWorkspace:
        """A workspace over ``root``, a directory the service made and will
        remove; never entered as a context manager."""
        workspace = cls.__new__(cls)
        workspace._root = Path(root)
        workspace._keep_on_failure = False
        return workspace

    @property
    def root(self) -> Path:
        return self._root

    @property
    def config_path(self) -> Path:
        return self._root / "config.yaml"

    @property
    def input_path(self) -> Path:
        return self._root / "input.data"

    @property
    def staged_input_path(self) -> Path:
        """The input's bytes as the service staged them."""
        return self._root / STAGED_INPUT_NAME

    @property
    def raw_input_path(self) -> Path:
        """Plaintext fixture for filelog pull-mode runs (raw log lines).
        Distinct from input_path (OTLP-JSON) which the OTLP push path uses.
        """
        return self._root / "input.log"

    def container_log_path(self, pod_uid: str = SEED_POD_UID) -> Path:
        """Container-runtime-shaped staging path for filelog runs whose
        operator chain includes a `container` operator. The trailing
        ``<namespace>_<pod>_<uid>/<container>/<restart>.log`` segments match
        the KWOK seed pod, so ``add_metadata_from_filepath`` derives an
        identity the sandbox apiserver can actually resolve — without this,
        path-derived k8s attributes (and any k8sattributes enrichment keyed
        on them) silently come out empty.

        ``pod_uid`` must be the uid the apiserver ACTUALLY assigned
        (``KwokCluster.seed_pod_uid``): the apiserver ignores the manifest's
        pinned value, and a stale uid in this path makes k8sattributes
        association by ``k8s.pod.uid`` miss the informer store — silently
        dropping deployment/node/annotation enrichment while the
        path-derived attributes still look fine. The constant default
        exists only for callers with no live cluster (kwok disabled).
        """
        return (
            self._root
            / "var"
            / "log"
            / "pods"
            / f"{SEED_NAMESPACE}_{SEED_POD_NAME}_{pod_uid}"
            / SEED_CONTAINER_NAME
            / "0.log"
        )

    @property
    def output_path(self) -> Path:
        return self._root / "output.data"

    def __enter__(self) -> RunWorkspace:
        # Never another run's live directory: refused, not removed.
        self._root.mkdir(parents=True, mode=0o700)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if exc is not None and self._keep_on_failure:
            # The path names the run's directory: it stays out of the log.
            logger.warning("keeping a failed run's workspace for debugging")
            return
        shutil.rmtree(self._root, ignore_errors=True)
