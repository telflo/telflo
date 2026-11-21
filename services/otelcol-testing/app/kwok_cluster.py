"""Singleton lifecycle manager for the kwok-simulated Kubernetes cluster.

Kwok's own code is never touched.

- **A baked kwokctl configuration** (``config``, the service's
  ``kwok/kwokctl.yaml``) is passed as ``kwokctl -c <file>`` on every call:
  Kubernetes v1.31.6, every component on 127.0.0.1, the image's four
  binaries, and kube-apiserver's ``advertise-address``. Without it kwokctl
  0.7.0 retries a kubectl download forever with no route out.
- Nothing seeds kwokctl's kubectl cache (the configuration names the baked
  kubectl).
- ``kwokctl create cluster`` gets ``--timeout 60s``, and every command a
  subprocess timeout (``_run``). A command that runs past it is killed with
  its process group, and fails.
- Every command gets the service's allowlisted environment
  (`app/environment.py`), never all of it.
- ``kubeconfig`` and ``pki_dir`` (the cluster's CA and admin certificate,
  which the informer wait uses) are exposed; log lines name no output of
  kwok's (its messages name paths).
- ``is_alive``: the supervisor re-checks a started cluster's liveness through
  it.
- ``start_from_environment`` is the service's starter: it resolves the
  image's binaries, starts the cluster, and on a failed start removes what
  it began (`app/kwok.py` retries it).

The test runner spins this up once at service startup and tears it down on
shutdown. All test runs share the same cluster — kwok-touching processors
(``k8sattributes``, ``k8s_cluster``, ``k8sobjects``) only ever read from the
apiserver, so concurrent runs cannot corrupt state. (The kubeconfig is an
admin certificate that could write the cluster; no component that survives
the sandbox's mutations writes to it.) The cluster is seeded with a
deterministic Deployment → ReplicaSet → Pod chain at start so processors that
walk owner references resolve to stable values.

Runtime selection is auto:

- **darwin** → ``--runtime=docker`` (no upstream kube-apiserver build for
  Mac, so kwokctl spawns the components as Linux containers)
- **linux** → ``--runtime=binary`` (production path: kwokctl spawns
  vendored binaries as subprocesses inside the otelcol-testing container)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import signal
from dataclasses import dataclass, field
from pathlib import Path

from app import environment
from app.kwok_binary import FilesystemKwokBinaries, KwokBinaries

logger = logging.getLogger(__name__)

# The service's own directory: the baked kwokctl configuration and the seed
# manifest live here.
SERVICE_ROOT = Path(__file__).resolve().parents[1]
KWOK_BINARY_DIR_VARIABLE = "KWOK_BINARY_DIR"
KWOKCTL_CONFIG_VARIABLE = "KWOKCTL_CONFIG"
DEFAULT_KWOK_BINARY_DIR = Path("/opt/kwok")
DEFAULT_KWOKCTL_CONFIG = SERVICE_ROOT / "kwok" / "kwokctl.yaml"
SEED_MANIFEST = SERVICE_ROOT / "fixtures" / "kwok" / "default-cluster.yaml"
KWOK_VERSION = "0.7.0"
CLUSTER_NAME = "telflo-test"

# The liveness probe: the seed pod read from the apiserver, as the
# informer wait reads it, retried for at most this long before the cluster is
# taken to be dead (a busy apiserver gets a few seconds; a dead one refuses at
# once and is retried until then).
LIVENESS_TIMEOUT_SECONDS = 3.0

# kwokctl waits this long for its cluster to be ready (its own --timeout),
# and its process gets a little more before it is killed.
KWOKCTL_CREATE_TIMEOUT = "60s"
CREATE_COMMAND_TIMEOUT_SECONDS = 90.0
# Every other command (kwokctl delete, kubectl apply/patch/get).
COMMAND_TIMEOUT_SECONDS = 30.0


KwokRuntime = str  # "binary" | "docker"


def _default_runtime() -> KwokRuntime:
    """Auto-select kwokctl --runtime based on host OS.

    Linux gets the binary path because we vendor a linux ``kube-apiserver``;
    everything else falls back to docker because Kubernetes upstream
    doesn't ship a darwin/windows kube-apiserver. See Phase 1 of the
    integration plan for the rationale.
    """
    return "binary" if platform.system().lower() == "linux" else "docker"


# Identity of the single workload seeded by fixtures/kwok/default-cluster.yaml.
# Everything that needs "a pod the sandbox apiserver knows" — sample resource
# attributes, the container-runtime staging path for filelog fixtures — must
# reference THIS identity; no other pod exists in the cluster.
#
# UID caveat: the apiserver assigns pod UIDs server-side and ignores the
# manifest's pinned value, so the LIVE uid differs every cluster boot.
# SEED_POD_UID is only the last-resort fallback when the post-seed read-back
# failed — always prefer ``KwokCluster.seed_pod_uid``. Staging a fixture
# under the stale fallback uid makes k8sattributes association by
# ``k8s.pod.uid`` miss the informer store, which silently disables ALL
# API-side enrichment (deployment name, node name, annotations) — observed
# live 2026-08-22.
SEED_NAMESPACE = "demo"
SEED_POD_NAME = "telflo-test-pod"
SEED_POD_UID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
SEED_CONTAINER_NAME = "app"
SEED_NODE_NAME = "kwok-node-0"


# Pod status patches applied after `kubectl apply -f default-cluster.yaml`.
# `kubectl apply` doesn't write the status subresource, and kwok's default
# Stages otherwise overwrite podIP from the node's InternalIP — patching the
# status directly is the deterministic path. Keep this list tight; if it
# grows, move to a fixture file alongside default-cluster.yaml.
_POD_STATUS_PATCHES: list[tuple[str, str, dict]] = [
    (
        SEED_NAMESPACE,
        SEED_POD_NAME,
        {
            "status": {
                "phase": "Running",
                "podIP": "127.0.0.1",
                "podIPs": [{"ip": "127.0.0.1"}],
                "hostIP": "127.0.0.1",
                "containerStatuses": [
                    {
                        "name": "app",
                        "ready": True,
                        "started": True,
                        "restartCount": 0,
                        "image": "nginx:1.27",
                        "imageID": "docker.io/library/nginx@sha256:test",
                        "containerID": "containerd://test-container-id",
                        "state": {"running": {"startedAt": "2026-04-24T00:00:00Z"}},
                    }
                ],
            }
        },
    ),
]


@dataclass
class KwokCluster:
    """Manages a kwokctl-backed cluster for the lifetime of the FastAPI app.

    The class is designed to be safe to call ``start()`` on more than once
    (subsequent calls are no-ops) and to ``stop()`` on a never-started
    instance (also a no-op). Idempotency matters because lifespan handlers
    can race with shutdown signals.
    """

    binaries: KwokBinaries
    cluster_name: str
    runtime: KwokRuntime
    seed_manifest: Path
    # The baked kwokctl configuration, passed with ``-c`` on every kwokctl
    # call; None only in the tests' fakes.
    config: Path | None = None

    _started: bool = field(default=False, init=False)
    _kubeconfig_path: Path | None = field(default=None, init=False)
    _apiserver_url: str | None = field(default=None, init=False)
    _seed_pod_uid: str | None = field(default=None, init=False)

    @property
    def kubeconfig_path(self) -> Path:
        if self._kubeconfig_path is None:
            raise RuntimeError("KwokCluster has not been started")
        return self._kubeconfig_path

    @property
    def kubeconfig(self) -> Path:
        """The supervisor's name for ``kubeconfig_path`` (`app/kwok.py`)."""
        return self.kubeconfig_path

    @property
    def pki_dir(self) -> Path:
        """The cluster's certificates (``ca.crt``, ``admin.crt``,
        ``admin.key``), beside its kubeconfig: the informer wait verifies the
        apiserver with the CA and presents the admin certificate (without
        either, every wait would run out)."""
        return self.kubeconfig_path.parent / "pki"

    @property
    def apiserver_url(self) -> str:
        if self._apiserver_url is None:
            raise RuntimeError("KwokCluster has not been started")
        return self._apiserver_url

    @property
    def is_started(self) -> bool:
        return self._started

    @property
    def seed_pod_uid(self) -> str:
        """The seed pod's LIVE uid as the apiserver assigned it this boot.

        The apiserver ignores the manifest's pinned ``metadata.uid``, so the
        real value is only knowable by reading it back after seeding.
        Falls back to the pinned SEED_POD_UID constant when the read-back
        failed (never happened in practice; the fallback just preserves the
        pre-fix behavior instead of crashing run staging)."""
        return self._seed_pod_uid or SEED_POD_UID

    async def is_alive(self, *, timeout_seconds: float = LIVENESS_TIMEOUT_SECONDS) -> bool:
        """Whether the started cluster still answers: its apiserver serves
        the seed pod, verified with the cluster's CA and the admin
        certificate, within ``timeout_seconds``. The supervisor
        (`app/kwok.py`) asks on health and before each run."""
        if not self._started or self._apiserver_url is None:
            return False
        # Imported here: the executors import this module's seed constants.
        from app.executors._shared import _wait_for_pod_listable

        return await _wait_for_pod_listable(
            self._apiserver_url,
            SEED_NAMESPACE,
            SEED_POD_NAME,
            timeout_seconds=timeout_seconds,
            pki_dir=self.pki_dir,
            warn_on_timeout=False,
        )

    async def start(self) -> None:
        if self._started:
            return
        # The baked configuration names the image's kubectl, so no kubectl
        # cache is seeded.
        # Idempotency: tear down any leftover cluster of the same name
        # from a crashed previous process.
        await self._delete_cluster(quiet=True)
        await self._create_cluster()
        await self._discover_endpoints()
        await self._apply_seed()
        await self._patch_pod_statuses()
        await self._fix_owner_reference_uids()
        await self._read_seed_pod_uid()
        self._started = True
        logger.info(
            "KwokCluster ready: name=%s runtime=%s apiserver=%s seed_pod_uid=%s",
            self.cluster_name,
            self.runtime,
            self._apiserver_url,
            self.seed_pod_uid,
        )

    async def stop_after_failed_start(self) -> None:
        """Remove whatever a failed ``start`` began (``stop`` does nothing
        before the kubeconfig is known), quietly."""
        await self._delete_cluster(quiet=True)
        self._started = False
        self._kubeconfig_path = None
        self._apiserver_url = None
        self._seed_pod_uid = None

    async def stop(self) -> None:
        if not self._started and self._kubeconfig_path is None:
            return
        await self._delete_cluster(quiet=True)
        self._started = False
        self._kubeconfig_path = None
        self._apiserver_url = None
        self._seed_pod_uid = None
        logger.info("KwokCluster torn down: name=%s", self.cluster_name)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _kwokctl(self, *arguments: str) -> list[str]:
        """A kwokctl command, with the baked configuration when there is one."""
        command = [str(self.binaries.kwokctl)]
        if self.config is not None:
            command += ["-c", str(self.config)]
        return [*command, *arguments]

    async def _create_cluster(self) -> None:
        """Run ``kwokctl create cluster`` with our vendored binaries.

        We disable kube-controller-manager and kube-scheduler unconditionally
        because the seed manifest hand-authors the full Deployment →
        ReplicaSet → Pod chain. That saves ~100 MB of memory and a couple
        seconds of startup; the controllers exist to expand higher-level
        objects into pods, which we don't need.
        """
        cmd = self._kwokctl(
            "create",
            "cluster",
            "--name",
            self.cluster_name,
            "--runtime",
            self.runtime,
            "--disable",
            "kube-controller-manager",
            "--disable",
            "kube-scheduler",
            "--timeout",
            KWOKCTL_CREATE_TIMEOUT,
        )
        if self.runtime == "binary":
            # --runtime=binary needs explicit binary paths; --runtime=docker
            # pulls images instead and ignores these flags.
            cmd += [
                "--kube-apiserver-binary",
                str(self.binaries.kube_apiserver) if self.binaries.kube_apiserver else "",
                "--etcd-binary",
                str(self.binaries.etcd),
                "--kwok-controller-binary",
                str(self.binaries.kwok),
            ]

        rc, stdout, stderr = await _run(cmd, timeout=CREATE_COMMAND_TIMEOUT_SECONDS)
        if rc != 0:
            raise RuntimeError(
                f"kwokctl create cluster failed (rc={rc}): {stderr or stdout}"
            )

    async def _delete_cluster(self, *, quiet: bool) -> None:
        """Tear down by name. ``quiet`` suppresses errors when the cluster
        doesn't exist (pre-start cleanup, post-stop double-delete)."""
        cmd = self._kwokctl(
            "delete",
            "cluster",
            "--name",
            self.cluster_name,
        )
        rc, _, stderr = await _run(cmd)
        if rc != 0 and not quiet:
            raise RuntimeError(f"kwokctl delete cluster failed: {stderr}")

    async def _discover_endpoints(self) -> None:
        """Ask kwokctl where the cluster's kubeconfig and apiserver URL are.

        Uses ``kwokctl get kubeconfig --name=<name>`` for the kubeconfig
        path. The apiserver URL is parsed from the kubeconfig (kwokctl
        writes it as the only cluster.server entry).
        """
        # `kwokctl get kubeconfig --name=<n>` prints the kubeconfig YAML to
        # stdout. We need the path, not the contents — but kwokctl always
        # writes it to a known location under ~/.kwok/clusters/<name>/.
        kubeconfig_path = (
            Path.home() / ".kwok" / "clusters" / self.cluster_name / "kubeconfig.yaml"
        )
        if not kubeconfig_path.is_file():
            raise RuntimeError(
                f"expected kwokctl to write kubeconfig at {kubeconfig_path}"
            )
        self._kubeconfig_path = kubeconfig_path

        # Parse the apiserver URL out of the kubeconfig. We avoid pulling in
        # PyYAML for this one field — a simple line scan is enough since the
        # kubeconfig kwokctl writes is well-shaped.
        for line in kubeconfig_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("server:"):
                self._apiserver_url = line.split(":", 1)[1].strip()
                return
        raise RuntimeError(f"no `server:` entry in kubeconfig {kubeconfig_path}")

    async def _apply_seed(self) -> None:
        """Apply the canonical seed manifest. We use the vendored kubectl,
        not ``kwokctl <name> kubectl``, to keep the call simple and avoid
        kwokctl's cache-download path."""
        cmd = [
            str(self.binaries.kubectl),
            "--kubeconfig",
            str(self.kubeconfig_path),
            "apply",
            "-f",
            str(self.seed_manifest),
        ]
        rc, stdout, stderr = await _run(cmd)
        if rc != 0:
            raise RuntimeError(f"kubectl apply seed failed: {stderr or stdout}")

    async def _patch_pod_statuses(self) -> None:
        """Apply the post-create status patches that ``kubectl apply`` can't.

        We have to do this in a small retry loop because kwokctl returns
        success from `create cluster` before the apiserver is fully ready
        to accept status writes — typically takes <500ms but can spike."""
        for namespace, name, patch in _POD_STATUS_PATCHES:
            cmd = [
                str(self.binaries.kubectl),
                "--kubeconfig",
                str(self.kubeconfig_path),
                "patch",
                "pod",
                name,
                "--namespace",
                namespace,
                "--subresource",
                "status",
                "--type",
                "merge",
                "-p",
                json.dumps(patch),
            ]
            last_err = ""
            for attempt in range(10):
                rc, _, stderr = await _run(cmd)
                if rc == 0:
                    break
                last_err = stderr
                await asyncio.sleep(0.2)
            else:
                raise RuntimeError(
                    f"kubectl patch pod/{namespace}/{name} status failed after retries: {last_err}"
                )

    async def _fix_owner_reference_uids(self) -> None:
        """Rewrite the seed pod's ownerReferences[].uid to the ReplicaSet's
        LIVE uid.

        The manifest pins the RS uid (bbbb…) in the pod's ownerReferences,
        but the apiserver assigns the actual ReplicaSet a fresh uid at apply
        time — and k8sattributes resolves ``k8s.deployment.name`` by looking
        the owning ReplicaSet up BY UID in its informer store, then reading
        that RS's own ownerReference to the Deployment. A stale uid in the
        pod's ownerReferences therefore silently kills deployment-name
        enrichment while everything else (node, labels, annotations)
        works. This is the "post-apply UID-rewrite pass" the seed manifest
        comment anticipated. Best-effort: on failure we log and continue —
        the cluster still serves every other enrichment."""
        get_rs_uid = [
            str(self.binaries.kubectl),
            "--kubeconfig",
            str(self.kubeconfig_path),
            "get",
            "replicaset",
            "telflo-test-deployment-7d8c9",
            "--namespace",
            SEED_NAMESPACE,
            "-o",
            "jsonpath={.metadata.uid}",
        ]
        rs_uid = ""
        for _attempt in range(10):
            rc, stdout, _stderr = await _run(get_rs_uid)
            rs_uid = stdout.strip()
            if rc == 0 and rs_uid:
                break
            await asyncio.sleep(0.2)
        if not rs_uid:
            logger.warning(
                "could not read seed ReplicaSet uid; k8s.deployment.name "
                "enrichment will not resolve in the sandbox"
            )
            return

        patch = json.dumps(
            [
                {
                    "op": "replace",
                    "path": "/metadata/ownerReferences/0/uid",
                    "value": rs_uid,
                }
            ]
        )
        patch_pod = [
            str(self.binaries.kubectl),
            "--kubeconfig",
            str(self.kubeconfig_path),
            "patch",
            "pod",
            SEED_POD_NAME,
            "--namespace",
            SEED_NAMESPACE,
            "--type",
            "json",
            "-p",
            patch,
        ]
        rc, _stdout, _stderr = await _run(patch_pod)
        if rc != 0:
            logger.warning(
                "could not rewrite seed pod ownerReferences uid (rc=%d); "
                "k8s.deployment.name enrichment will not resolve",
                rc,
            )

    async def _read_seed_pod_uid(self) -> None:
        """Read back the uid the apiserver actually assigned to the seed pod.

        Everything that must match the informer store — the filelog
        container-runtime staging path above all — uses this value via
        ``seed_pod_uid``. Best-effort with retries: on total failure we log
        and leave the fallback constant in place rather than failing
        startup; runs then behave exactly as before this read-back existed."""
        cmd = [
            str(self.binaries.kubectl),
            "--kubeconfig",
            str(self.kubeconfig_path),
            "get",
            "pod",
            SEED_POD_NAME,
            "--namespace",
            SEED_NAMESPACE,
            "-o",
            "jsonpath={.metadata.uid}",
        ]
        last_err = ""
        for _attempt in range(10):
            rc, stdout, stderr = await _run(cmd)
            uid = stdout.strip()
            if rc == 0 and uid:
                self._seed_pod_uid = uid
                return
            last_err = stderr or f"empty uid (rc={rc})"
            await asyncio.sleep(0.2)
        logger.warning(
            "could not read seed pod uid; falling back to pinned %s — "
            "k8sattributes association by k8s.pod.uid will not match",
            SEED_POD_UID,
        )


async def _run(cmd: list[str], *, timeout: float = COMMAND_TIMEOUT_SECONDS) -> tuple[int, str, str]:
    """Run a command, capture stdout/stderr, return (returncode, stdout,
    stderr). The command gets the service's allowlisted environment and its
    own process group; past ``timeout`` seconds (or when canceled) the
    whole group is killed and the command fails (returncode -1)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=environment.allowed(),
        start_new_session=True,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        _kill_group(proc.pid)
        await proc.wait()
        return -1, "", f"timed out after {timeout:g} s"
    except asyncio.CancelledError:
        _kill_group(proc.pid)
        raise
    return (
        proc.returncode if proc.returncode is not None else -1,
        stdout_b.decode("utf-8", errors="replace"),
        stderr_b.decode("utf-8", errors="replace"),
    )


def _kill_group(pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def kwok_binary_dir(environ: dict[str, str] | None = None) -> Path:
    source = os.environ if environ is None else environ
    return Path(source.get(KWOK_BINARY_DIR_VARIABLE) or DEFAULT_KWOK_BINARY_DIR)


def kwokctl_config(environ: dict[str, str] | None = None) -> Path:
    source = os.environ if environ is None else environ
    return Path(source.get(KWOKCTL_CONFIG_VARIABLE) or DEFAULT_KWOKCTL_CONFIG)


async def start_from_environment() -> KwokCluster:
    """The service's kwok starter (`app/kwok.py` calls it, up to three
    times): the image's binaries (``KWOK_BINARY_DIR``, ``/opt/kwok`` by
    default), the baked configuration (``KWOKCTL_CONFIG``), the seed
    manifest. A start that fails removes whatever it began before it
    raises."""
    binaries = FilesystemKwokBinaries(kwok_binary_dir()).resolve(KWOK_VERSION)
    cluster = KwokCluster(
        binaries=binaries,
        cluster_name=CLUSTER_NAME,
        runtime=_default_runtime(),
        seed_manifest=SEED_MANIFEST,
        config=kwokctl_config(),
    )
    try:
        await cluster.start()
    except BaseException:
        stopping = asyncio.ensure_future(cluster.stop_after_failed_start())
        await asyncio.shield(stopping)
        raise
    return cluster
