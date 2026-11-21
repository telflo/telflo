"""Sandbox YAML mutations.

Its IDs and messages are stable:

- **R-105 is not a walk here.** Every live non-``env`` confmap reference
  is spliced out of the text before this module ever sees it, on the decoded
  keys and values (`app/neutralise.py`, the validator's neutralizer), and the
  exact text these mutations produce is checked again before any collector
  reads it (the backstop). R-105's advisory is built there from the schemes
  the neutralizer returns.
- **R-106**: the ``consul``, ``openshift`` and ``docker`` resourcedetection
  detectors are stripped with their settings, since they query services the
  sandbox doesn't have and could read files named in the text. R-101, R-103
  and R-106 match both spellings of the processor (``resource_detection`` and
  ``resourcedetection``).
- A component configuration that isn't a mapping is left for the collector
  to judge rather than raising (``rewrite_k8s_auth``), and a pipeline whose
  value is empty is rewired as an empty mapping (``swap_pipeline_endpoints``
  and the operator-test orchestrator), never raising. The run
  checks the configuration's overall shape before any mutation
  (`app/compatibility.py`'s ``configuration_shape_problem``).

Each user's pipeline is rewritten before the test runner spawns
``otelcol-contrib`` so that (a) the user's receivers/exporters don't reach
real backends and (b) the sandbox doesn't collide with itself on parallel
runs. This module hosts the mutation primitives as small, composable
functions so additional rewrites (e.g. the kwok ``auth_type`` rewrite,
R-100) can be added without touching
the core orchestration.

Each primitive takes the parsed ``doc``, a ``MutationContext``, and an
``advisories`` list. If — and only if — the primitive actually changed the
config, it appends a ``MutationAdvisory`` to ``advisories`` keyed to a stable
ID from SANDBOX_REWRITES.md so the frontend can render an explanation.

One thin orchestrator (``mutate_for_otlp_replay``) composes the primitives in
order. It returns ``(mutated_yaml, advisories)``; the run answers both so
users can audit what we did.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field
from ruamel.yaml import YAML

from app.kwok_cluster import (
    SEED_CONTAINER_NAME,
    SEED_NAMESPACE,
    SEED_POD_NAME,
    SEED_POD_UID,
)
from app.testable_receivers import (
    detect_testable_receiver,
    has_container_operator,
    synthesize_filelog,
    synthesize_syslog,
)

OTLP_IN_NAME = "otlp/test_in"
FILE_OUT_NAME = "file/test_out"

# Processor names that touch the Kubernetes API. Both spellings of
# k8sattributes (the alias is deprecated upstream but still common in user
# YAML) need to match. Pipeline keys can be suffixed (`/foo`) to declare
# multiple instances; we normalize before comparing.
K8S_TOUCHING_PROCESSORS = frozenset(
    {
        "k8sattributes",
        "k8s_attributes",
        "k8sobjects",
        "k8s_cluster",
    }
)

Severity = Literal["info", "caution", "warn"]


class MutationAdvisory(BaseModel):
    """A user-facing record of a single mutation the test runner made.

    ``id`` is its stable code (e.g. "R-001"; the service's README lists them);
    ``message`` is the rendered string for the UI; ``details`` is optional
    structured context (e.g., the names of components the runner replaced)
    for filtering or expanded views.

    Pydantic (rather than a dataclass) so the model serializes cleanly into
    the run's answer (``model_dump``); the platform stores it on the run.
    """

    id: str
    severity: Severity
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


@dataclass
class MutationContext:
    """Inputs each mutation primitive may need.

    Not every primitive uses every field. ``otlp_port`` is set for OTLP
    replay; ``input_path`` is set for file replay. Both modes set
    ``signal_type`` and ``output_path``.
    """

    signal_type: str
    output_path: Path
    otlp_port: int | None = None
    input_path: Path | None = None
    fixture_path: Path | None = None
    syslog_port: int | None = None
    # The exact ``service.pipelines`` key the user chose to test (e.g.
    # ``traces/in``). When set, ``drop_non_target_pipelines`` (R-005) keeps
    # only this one pipeline instead of every same-signal pipeline — so a
    # config that links same-signal pipelines via connectors is unit-tested
    # one chain at a time rather than as a misleading union of all chains
    # (issue #248). None => legacy signal-type filtering.
    target_pipeline: str | None = None


# A primitive mutates ``doc`` in place, may append to ``advisories``, and
# returns the (possibly same) ``doc`` for chaining.
Mutation = Callable[[dict, MutationContext, list[MutationAdvisory]], dict]


# ---------------------------------------------------------------------------
# Mutation primitives
# ---------------------------------------------------------------------------


def sub_receivers_otlp(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-001 (OTLP variant): replace all top-level receivers with an OTLP
    HTTP listener bound to the test runner's chosen ephemeral port."""
    original = sorted((doc.get("receivers") or {}).keys())
    doc["receivers"] = {
        OTLP_IN_NAME: {
            "protocols": {
                "http": {"endpoint": f"127.0.0.1:{ctx.otlp_port}"},
            },
        },
    }
    if original:
        advisories.append(
            MutationAdvisory(
                id="R-001",
                severity="info",
                message=(
                    f"Your receivers ({', '.join(original)}) were replaced "
                    f"with a sandbox OTLP/HTTP source. The data flowing through "
                    f"your processor chain comes from the fixture you selected, "
                    f"not from the original receivers."
                ),
                details={
                    "original_receivers": original,
                    "test_receiver": OTLP_IN_NAME,
                },
            )
        )
    return doc


def sub_exporters(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-002: replace all top-level exporters with a single ``file/test_out``
    capture so nothing leaks to user-configured backends."""
    original = sorted((doc.get("exporters") or {}).keys())
    doc["exporters"] = {
        FILE_OUT_NAME: {"path": str(ctx.output_path)},
    }
    if original:
        advisories.append(
            MutationAdvisory(
                id="R-002",
                severity="info",
                message=(
                    f"Your exporters ({', '.join(original)}) were replaced "
                    f"with a sandbox capture. Your processor chain's output is "
                    f"shown in the test result; nothing was sent to your real "
                    f"backends."
                ),
                details={
                    "original_exporters": original,
                    "test_exporter": FILE_OUT_NAME,
                },
            )
        )
    return doc


def strip_connectors(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-007: drop the top-level ``connectors`` block.

    Connectors (``forward``, ``routing``, ``spanmetrics``, ``servicegraph``,
    ``count``, ``failover``, …) glue pipelines together — typically routing
    events between pipelines or transforming across signal types
    (e.g., spanmetrics: traces → metrics). The sandbox tests one pipeline's
    processor chain at a time:

      - cross-signal connectors' destination pipelines are dropped by R-005
        (we only keep pipelines matching the test's signal_type), leaving
        the connector with nowhere to emit;
      - same-signal multi-pipeline connectors get all their destinations
        flattened to the single ``file/test_out`` capture by
        ``swap_pipeline_endpoints``, so the user can't observe whether the
        connector routed correctly.

    Either way the connector's user-controlled logic (OTTL conditions,
    dimensions, bucket boundaries, …) cannot be faithfully exercised in the
    current sandbox. Stripping makes that explicit instead of leaving an
    orphan connector in the config that the collector either no-ops or
    refuses to start over. ``swap_pipeline_endpoints`` (which runs after
    this primitive) replaces every pipeline's receivers/exporters arrays
    wholesale, so any stale connector references in those arrays are
    cleaned up implicitly.

    No defense-in-depth claim is made here: today's connector inventory
    doesn't reach the network. The point of the strip is honesty about
    what the sandbox can test, plus future-proofing — a future connector
    with network behavior would otherwise land in the subprocess
    unflagged.
    """
    connector_names = sorted((doc.get("connectors") or {}).keys())
    if not connector_names:
        return doc
    doc.pop("connectors", None)
    advisories.append(
        MutationAdvisory(
            id="R-007",
            severity="info",
            message=(
                f"Your connectors ({', '.join(connector_names)}) were removed "
                "before running this test. The sandbox tests one pipeline's "
                "processor chain at a time and can't faithfully exercise "
                "connector logic that spans pipelines or signal types. Test "
                "connector behavior in a real collector deployment, or with "
                "the connector's own upstream tests."
            ),
            details={"removed_connectors": connector_names},
        )
    )
    return doc


def strip_extensions(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-003: drop the top-level ``extensions`` block and ``service.extensions``
    so common extensions (health_check, pprof, zpages) don't bind fixed ports
    that would collide on parallel runs."""
    extension_names = sorted((doc.get("extensions") or {}).keys())
    had_extensions = bool(extension_names)
    doc.pop("extensions", None)

    service = doc.get("service") or {}
    had_service_ext = "extensions" in service
    service.pop("extensions", None)
    doc["service"] = service

    if had_extensions or had_service_ext:
        advisories.append(
            MutationAdvisory(
                id="R-003",
                severity="info",
                message=(
                    "Extensions are not run during testing — your test "
                    "result reflects only the receivers → processors → "
                    "exporters path."
                ),
                details={"removed_extensions": extension_names},
            )
        )
    return doc


def force_telemetry_off(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-004: overwrite ``service.telemetry`` so the collector's default
    Prometheus endpoint at :8888 doesn't collide between parallel runs.

    Emits an advisory only when the user had a non-trivial ``telemetry``
    block — pre-fix this rewrite was silent, so a user who had configured
    a custom log level (or any other telemetry knob) would see no trace
    of it in the run record and might not realize their config was inert
    during the test. Empty/missing blocks are not user-visible and not
    worth a note.
    """
    service = doc.get("service") or {}
    original_telemetry = service.get("telemetry")
    had_user_telemetry = isinstance(original_telemetry, dict) and bool(
        original_telemetry
    )
    service["telemetry"] = {"metrics": {"level": "none"}}
    doc["service"] = service
    if had_user_telemetry:
        advisories.append(
            MutationAdvisory(
                id="R-004",
                severity="info",
                message=(
                    "Your `service.telemetry` block was replaced with "
                    "`metrics: {level: none}` so the collector's internal "
                    "Prometheus endpoint (:8888) wouldn't collide on parallel "
                    "test runs. Your telemetry settings are not active during "
                    "this test — they'll apply normally in production."
                ),
                details={"original_telemetry": original_telemetry},
            )
        )
    return doc


def drop_non_target_pipelines(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-005: narrow the config to the pipeline(s) under test.

    Two modes:

    - **Single-pipeline target** (``ctx.target_pipeline`` set and present in
      the config): keep only that one pipeline; drop everything else,
      *including other pipelines of the same signal*. This is the issue #248
      fix — the user picked a specific pipeline in the Run dialog, so the
      sandbox tests exactly that chain instead of unioning every same-signal
      pipeline (which, for connector-linked configs, produced duplicated and
      partially-unprocessed output that broke rule authoring).

    - **Signal-type filter** (``ctx.target_pipeline`` is None, or names a
      pipeline that no longer exists in the config): keep every pipeline whose
      signal type matches ``ctx.signal_type``. This is the legacy behavior and
      the safe fallback — callers without a pipeline selection (saved test
      definitions, suite play-all) and stale targets land here rather than
      keeping zero pipelines (which would fail collector startup).

    Pipeline keys look like ``metrics`` or ``metrics/foo``; signal matching is
    on the part before the slash. Dropped pipelines are removed wholesale so
    their (possibly network-bound) components never run.
    """
    service = doc.get("service") or {}
    pipelines = service.get("pipelines") or {}

    target = ctx.target_pipeline
    target_present = target is not None and target in pipelines

    if target_present:
        kept = {target: pipelines[target]}
        dropped = [name for name in pipelines if name != target]
        service["pipelines"] = kept
        doc["service"] = service

        if dropped:
            advisories.append(
                MutationAdvisory(
                    id="R-005",
                    severity="caution",
                    message=(
                        f"You selected the `{target}` pipeline to test. The "
                        f"other {len(dropped)} pipeline(s) in this config "
                        f"({', '.join(dropped)}) were excluded — including any "
                        "that link to it via connectors. The output below is "
                        f"`{target}`'s processor chain alone, not an "
                        "end-to-end run across linked pipelines. Test the "
                        "others by selecting each one in turn."
                    ),
                    details={
                        "dropped_pipelines": dropped,
                        "target_pipeline": target,
                        "target_signal": ctx.signal_type,
                        "mode": "single_pipeline",
                    },
                )
            )
        return doc

    # Signal-type filter (legacy / fallback).
    kept = {}
    dropped = []
    for name, pipeline in pipelines.items():
        base = name.split("/", 1)[0]
        if base == ctx.signal_type:
            kept[name] = pipeline
        else:
            dropped.append(name)
    service["pipelines"] = kept
    doc["service"] = service

    if dropped:
        advisories.append(
            MutationAdvisory(
                id="R-005",
                severity="caution",
                message=(
                    f"Your config includes {len(dropped)} additional pipeline(s) "
                    f"for signals other than {ctx.signal_type} "
                    f"({', '.join(dropped)}). They were excluded from this test. "
                    f"Test each signal type separately."
                ),
                details={
                    "dropped_pipelines": dropped,
                    "target_signal": ctx.signal_type,
                    "mode": "signal_type",
                },
            )
        )
    return doc


def processor_needs_k8s(yaml_str_or_doc: str | dict) -> bool:
    """True if the parsed YAML contains a processor that talks to the
    Kubernetes API. Used by the executor to decide whether to wire the
    kwok kubeconfig into the otelcol-contrib subprocess. Accepts either a
    raw YAML string or an already-parsed doc to avoid re-parsing in hot
    paths.
    """
    if isinstance(yaml_str_or_doc, str):
        _, doc = _load(yaml_str_or_doc)
    else:
        doc = yaml_str_or_doc
    processors = (doc.get("processors") or {})
    for name in processors.keys():
        # Strip optional `/instance` suffix so `k8sattributes/foo` matches.
        base = name.split("/", 1)[0]
        if base in K8S_TOUCHING_PROCESSORS:
            return True
    return False


def rewrite_k8s_auth(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-100: rewrite k8s-touching processors' ``auth_type`` to ``kubeConfig``.

    The sandbox's kwok cluster is HTTP-only. The default ``serviceAccount``
    auth path uses Kubernetes' ``InClusterConfig()`` which forces HTTPS +
    bearer token + CA cert from
    ``/var/run/secrets/kubernetes.io/serviceaccount/`` — none of which we
    provide. Rewriting to ``kubeConfig`` means the processor reads the
    apiserver URL from the ``KUBECONFIG`` env var the executor injects.

    Applied to every processor whose name (stripped of any ``/instance``
    suffix) is in :data:`K8S_TOUCHING_PROCESSORS`. The implicit-default
    case (``auth_type`` absent — defaults to ``serviceAccount``) is also
    rewritten. ``auth_type: kubeConfig`` already in the user's config is
    left alone — it's already compatible.
    """
    processors = doc.get("processors") or {}
    rewritten: list[str] = []
    for name, cfg in list(processors.items()):
        base = name.split("/", 1)[0]
        if base not in K8S_TOUCHING_PROCESSORS:
            continue
        cfg = cfg or {}
        if not isinstance(cfg, dict):
            continue  # not a mapping: the collector judges it
        current = cfg.get("auth_type")
        if current == "kubeConfig":
            continue
        cfg["auth_type"] = "kubeConfig"
        processors[name] = cfg
        rewritten.append(name)

    if rewritten:
        advisories.append(
            MutationAdvisory(
                id="R-100",
                severity="warn",
                message=(
                    f"Your {', '.join(rewritten)} processor(s) had `auth_type` "
                    f"rewritten to `kubeConfig` so they could connect to the "
                    f"sandbox's simulated Kubernetes API (kwok). The processor "
                    f"runs, but the cluster state it sees is the test fixture's "
                    f"fake pods — not your real cluster."
                ),
                details={
                    "rewritten_processors": rewritten,
                    "from_auth_type": "serviceAccount",
                    "to_auth_type": "kubeConfig",
                },
            )
        )
    return doc


# The resourcedetection processor's type, by both of its spellings: the
# catalog's `resource_detection` (since 0.153.0) and its deprecated
# `resourcedetection`, which every offered collector still accepts. R-101,
# R-103 and R-106 strip detectors from either (matching the old spelling only
# would let a `resource_detection` processor keep every detector).
RESOURCE_DETECTION_TYPES = frozenset({"resourcedetection", "resource_detection"})


# Resourcedetection detectors that require in-cluster Kubernetes auth
# (token + ca.crt at /var/run/secrets/kubernetes.io/serviceaccount/...).
# The sandbox doesn't simulate ServiceAccount mounting and these detectors
# don't have a kubeConfig fallback, so leaving them in causes collector
# startup to fail with "K8S_SERVICE_HOST must be defined" / "failed to load
# in-cluster config". The kwok cluster doesn't help here — these detectors
# bypass KUBECONFIG and go straight for InClusterConfig.
_IN_CLUSTER_DETECTORS = frozenset({"k8snode"})

# Resourcedetection detectors that reach a cloud metadata service over the
# network — 169.254.169.254 for AWS / Azure, metadata.google.internal for
# GCP, etc. In the sandbox there is no such service to reach; left alone,
# the detector spends its full configured timeout (default 2s per detector,
# user-configurable up to minutes) blocking on a TCP connect that will
# eventually fail. During that window the otelcol-testing container is
# making real outbound HTTP — exactly the side-channel the docs warned
# about ("the sandbox assumption 'only processors run, so no network' isn't
# airtight"). Stripping them in the mutator stops the request from ever
# being attempted.
#
# Elasticbeanstalk and lambda are listed because they're "cloud detectors"
# in the user's mental model even though they read env vars / config files
# rather than hitting metadata over HTTP. Including them in the strip set
# keeps the rule simple (one bucket: "anything cloud-specific in a sandbox
# without cloud context is noise"). If a user has a genuine reason to keep
# a non-network cloud detector, they can use `env` + `system` instead and
# the test result will not include the cloud-specific attributes either way.
_CLOUD_DETECTORS = frozenset(
    {
        "gcp", "gke",  # GCP / GKE
        "aws", "ec2", "ecs", "eks",  # AWS family
        "azure", "aks",  # Azure family
        "elasticbeanstalk", "lambda",  # AWS service-specific
    }
)


def strip_in_cluster_detectors(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-101: drop in-cluster-only detectors from every ``resourcedetection``
    processor. Other detectors (``env``, ``system``, ``ec2``, ``gcp``, …)
    are kept.

    If stripping leaves the detectors list empty, the processor itself is
    removed entirely — both from the top-level ``processors`` block and
    from every pipeline's ``processors`` list. ``resourcedetection`` with
    ``detectors: []`` is rejected as a config error by some otelcol-contrib
    versions, so leaving the processor in place there would break startup.

    Real-world impact: resource attributes the user expected from k8snode
    (``host.name`` derived from the node's hostname, ``k8s.node.uid``) are
    absent in the test output. The advisory says so explicitly so the user
    knows whether the missing attributes downstream are sandbox-specific
    or a real pipeline gap.
    """
    processors = doc.get("processors") or {}
    service = doc.get("service") or {}
    pipelines = service.get("pipelines") or {}

    trimmed: list[tuple[str, list[str]]] = []
    removed: list[tuple[str, list[str]]] = []

    for name in list(processors.keys()):
        if not isinstance(name, str):
            continue
        base = name.split("/", 1)[0]
        if base not in RESOURCE_DETECTION_TYPES:
            continue
        cfg = processors[name]
        if not isinstance(cfg, dict):
            continue
        detectors = cfg.get("detectors")
        if not isinstance(detectors, list):
            continue
        stripped = [d for d in detectors if d not in _IN_CLUSTER_DETECTORS]
        if stripped == detectors:
            continue
        dropped = [d for d in detectors if d in _IN_CLUSTER_DETECTORS]
        if stripped:
            cfg["detectors"] = stripped
            trimmed.append((name, dropped))
        else:
            # Empty detectors would break collector startup. Remove the
            # processor entirely and unwire it from every pipeline.
            del processors[name]
            for pipeline in pipelines.values():
                if not isinstance(pipeline, dict):
                    continue
                plist = pipeline.get("processors")
                if isinstance(plist, list) and name in plist:
                    pipeline["processors"] = [p for p in plist if p != name]
            removed.append((name, dropped))

    if trimmed or removed:
        advisories.append(
            MutationAdvisory(
                id="R-101",
                severity="warn",
                message=_format_r101_message(trimmed, removed),
                details={
                    "trimmed": [
                        {"processor": name, "removed_detectors": dropped}
                        for name, dropped in trimmed
                    ],
                    "removed_processors": [
                        {"processor": name, "removed_detectors": dropped}
                        for name, dropped in removed
                    ],
                },
            )
        )
    return doc


def _format_r101_message(
    trimmed: list[tuple[str, list[str]]],
    removed: list[tuple[str, list[str]]],
) -> str:
    parts: list[str] = []
    if trimmed:
        parts.append(
            "Stripped in-cluster detectors from "
            f"{len(trimmed)} resourcedetection processor(s): "
            + ", ".join(
                f"{name} (removed: {', '.join(dropped)})"
                for name, dropped in trimmed
            )
        )
    if removed:
        parts.append(
            f"Removed {len(removed)} resourcedetection processor(s) entirely "
            "because all their detectors were in-cluster only: "
            + ", ".join(
                f"{name} (had: {', '.join(dropped)})"
                for name, dropped in removed
            )
        )
    parts.append(
        "Resource attributes that would have come from the affected "
        "detectors are absent in the test output."
    )
    return " ".join(parts)


def strip_cloud_detectors(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-103: drop cloud-metadata detectors from every ``resourcedetection``
    processor. The sandbox can't reach cloud metadata services (no
    ``169.254.169.254`` route, no ``metadata.google.internal`` DNS), so
    these detectors otherwise sit blocked on TCP connect for their full
    configured timeout — and during that timeout the testing container is
    making real outbound HTTP, which is a network-reconnaissance side
    channel out of the sandbox.

    Mirrors :func:`strip_in_cluster_detectors` (R-101) in shape: trim the
    detector from each processor's list, remove the processor entirely if
    its detectors list goes empty (and unwire it from every pipeline that
    references it, since empty ``detectors: []`` breaks collector startup
    on some otelcol-contrib versions).

    Cloud-specific attributes (``cloud.provider``, ``cloud.region``,
    ``host.id``, ``faas.id``, …) are absent from the test output as a
    result. The advisory says so explicitly so the user can tell whether
    a missing downstream attribute is sandbox-specific or a real pipeline
    gap.
    """
    processors = doc.get("processors") or {}
    service = doc.get("service") or {}
    pipelines = service.get("pipelines") or {}

    trimmed: list[tuple[str, list[str]]] = []
    removed: list[tuple[str, list[str]]] = []

    for name in list(processors.keys()):
        if not isinstance(name, str):
            continue
        base = name.split("/", 1)[0]
        if base not in RESOURCE_DETECTION_TYPES:
            continue
        cfg = processors[name]
        if not isinstance(cfg, dict):
            continue
        detectors = cfg.get("detectors")
        if not isinstance(detectors, list):
            continue
        stripped = [d for d in detectors if d not in _CLOUD_DETECTORS]
        if stripped == detectors:
            continue
        dropped = [d for d in detectors if d in _CLOUD_DETECTORS]
        if stripped:
            cfg["detectors"] = stripped
            trimmed.append((name, dropped))
        else:
            del processors[name]
            for pipeline in pipelines.values():
                if not isinstance(pipeline, dict):
                    continue
                plist = pipeline.get("processors")
                if isinstance(plist, list) and name in plist:
                    pipeline["processors"] = [p for p in plist if p != name]
            removed.append((name, dropped))

    if trimmed or removed:
        advisories.append(
            MutationAdvisory(
                id="R-103",
                severity="warn",
                message=_format_r103_message(trimmed, removed),
                details={
                    "trimmed": [
                        {"processor": name, "removed_detectors": dropped}
                        for name, dropped in trimmed
                    ],
                    "removed_processors": [
                        {"processor": name, "removed_detectors": dropped}
                        for name, dropped in removed
                    ],
                },
            )
        )
    return doc


def _format_r103_message(
    trimmed: list[tuple[str, list[str]]],
    removed: list[tuple[str, list[str]]],
) -> str:
    parts: list[str] = []
    if trimmed:
        parts.append(
            "Stripped cloud detectors from "
            f"{len(trimmed)} resourcedetection processor(s): "
            + ", ".join(
                f"{name} (removed: {', '.join(dropped)})"
                for name, dropped in trimmed
            )
        )
    if removed:
        parts.append(
            f"Removed {len(removed)} resourcedetection processor(s) entirely "
            "because all their detectors were cloud-metadata-only: "
            + ", ".join(
                f"{name} (had: {', '.join(dropped)})"
                for name, dropped in removed
            )
        )
    parts.append(
        "The sandbox has no cloud-metadata service to reach, so these "
        "detectors would have timed out blocking on real outbound HTTP. "
        "Cloud-specific attributes (cloud.provider, cloud.region, host.id, …) "
        "are absent in the test output as a result."
    )
    return " ".join(parts)


# Resourcedetection detectors that query a service outside the collector:
# `consul` asks a Consul agent (its `token_file` is read and sent to its
# `address`), `openshift` asks an OpenShift API server (its `tls` files are
# read), `docker` asks the Docker daemon. The sandbox has none of these
# services, and every run's collector runs as the same user in the same
# container, so a detector that reads a file named in the text could read
# another run's files, or the tester's, and send them on. They're stripped
# with their own settings, as R-103 strips the cloud detectors.
_SERVICE_DETECTORS = ("consul", "openshift", "docker")


def strip_service_detectors(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-106: drop the ``consul``, ``openshift`` and ``docker`` detectors
    from every resourcedetection processor (either spelling), and each one's
    own settings block (``consul:``, ``openshift:``, ``docker:``), listed or
    not, so none of the files they name survives into the text the collector
    reads.

    Mirrors :func:`strip_cloud_detectors` (R-103) in shape: a processor whose
    detectors list goes empty is removed entirely and unwired from every
    pipeline (``detectors: []`` breaks collector startup on some versions).
    """
    processors = doc.get("processors") or {}
    service = doc.get("service") or {}
    pipelines = service.get("pipelines") or {}

    trimmed: list[tuple[str, list[str]]] = []
    removed: list[tuple[str, list[str]]] = []
    unused: list[tuple[str, list[str]]] = []

    for name in list(processors.keys()):
        if not isinstance(name, str):
            continue
        base = name.split("/", 1)[0]
        if base not in RESOURCE_DETECTION_TYPES:
            continue
        cfg = processors[name]
        if not isinstance(cfg, dict):
            continue
        detectors = cfg.get("detectors")
        listed = detectors if isinstance(detectors, list) else []
        dropped = [d for d in listed if d in _SERVICE_DETECTORS]
        settings = [d for d in _SERVICE_DETECTORS if d in cfg]
        for detector in settings:
            del cfg[detector]
        if dropped:
            stripped = [d for d in listed if d not in _SERVICE_DETECTORS]
            if stripped:
                cfg["detectors"] = stripped
                trimmed.append((name, dropped))
            else:
                del processors[name]
                for pipeline in pipelines.values():
                    if not isinstance(pipeline, dict):
                        continue
                    plist = pipeline.get("processors")
                    if isinstance(plist, list) and name in plist:
                        pipeline["processors"] = [p for p in plist if p != name]
                removed.append((name, dropped))
        elif settings:
            unused.append((name, settings))

    if trimmed or removed or unused:
        advisories.append(
            MutationAdvisory(
                id="R-106",
                severity="warn",
                message=_format_r106_message(trimmed, removed, unused),
                details={
                    "trimmed": [
                        {"processor": name, "removed_detectors": dropped}
                        for name, dropped in trimmed
                    ],
                    "removed_processors": [
                        {"processor": name, "removed_detectors": dropped}
                        for name, dropped in removed
                    ],
                    "removed_settings": [
                        {"processor": name, "detectors": settings}
                        for name, settings in unused
                    ],
                },
            )
        )
    return doc


def _format_r106_message(
    trimmed: list[tuple[str, list[str]]],
    removed: list[tuple[str, list[str]]],
    unused: list[tuple[str, list[str]]],
) -> str:
    parts: list[str] = []
    if trimmed:
        parts.append(
            "Stripped detectors that query a service outside the collector from "
            f"{len(trimmed)} resourcedetection processor(s): "
            + ", ".join(
                f"{name} (removed: {', '.join(dropped)})"
                for name, dropped in trimmed
            )
        )
    if removed:
        parts.append(
            f"Removed {len(removed)} resourcedetection processor(s) entirely "
            "because all their detectors query a service outside the "
            "collector: "
            + ", ".join(
                f"{name} (had: {', '.join(dropped)})"
                for name, dropped in removed
            )
        )
    if unused:
        parts.append(
            "Removed the settings of detectors your config doesn't run from "
            f"{len(unused)} resourcedetection processor(s): "
            + ", ".join(
                f"{name} ({', '.join(settings)})"
                for name, settings in unused
            )
        )
    parts.append(
        "The sandbox has no Consul agent, OpenShift API server or Docker "
        "daemon for these detectors to reach, and they could read files "
        "(tokens, TLS certificates) on the sandbox's disk. Attributes they "
        "would have added (host.name, host.id, cloud.region, k8s.cluster.name, "
        "os.type, …) are absent in the test output as a result."
    )
    return " ".join(parts)


def _staged_pod_identity(fixture_path) -> tuple[str, str, str, str]:
    """(namespace, pod, uid, container) encoded in a container-runtime
    staging path (``…/<ns>_<pod>_<uid>/<container>/0.log``). Parsed from the
    ACTUAL path chosen by ``choose_staging_path`` so the R-008 advisory
    reports the live uid the apiserver assigned this boot, not the stale
    pinned constant. Falls back to the seed constants if the path shape
    surprises us (k8s names cannot contain ``_``, so the split is safe)."""
    try:
        path = Path(fixture_path)
        parts = path.parent.parent.name.split("_")
        if len(parts) == 3:
            return parts[0], parts[1], parts[2], path.parent.name
    except (TypeError, ValueError):
        pass
    return SEED_NAMESPACE, SEED_POD_NAME, SEED_POD_UID, SEED_CONTAINER_NAME


def sub_receiver_synthesized(
    doc: dict, ctx: MutationContext, advisories: list[MutationAdvisory]
) -> dict:
    """R-008: replace a filelog/syslog receiver with a freshly synthesized
    one (operators + parsing knobs preserved; transport/source discarded).

    Unlike sub_receivers_otlp this keeps exactly one receiver — the one we
    are testing — under its original name so the user's pipeline still
    references it. Called only when detect_testable_receiver matched.
    Detection is scoped to the run's target pipeline / signal so a sibling
    pipeline's filelog can't be synthesized in place of the selected one.
    """
    tr = detect_testable_receiver(
        doc,
        signal_type=ctx.signal_type,
        target_pipeline=ctx.target_pipeline,
    )
    if tr is None:
        return doc
    user_cfg = (doc.get("receivers") or {}).get(tr.name) or {}
    if tr.kind == "filelog":
        synth = synthesize_filelog(user_cfg, fixture_path=str(ctx.fixture_path))
        replaced = "file source, storage and polling"
    else:
        synth = synthesize_syslog(user_cfg, listen_port=ctx.syslog_port)
        replaced = "network listener and TLS"
    doc["receivers"] = {tr.name: synth}
    message = (
        f"Your `{tr.name}` receiver's operator chain and parsing "
        f"options were preserved and tested. Its {replaced} were "
        f"replaced by the sandbox so the test reads only the fixture."
    )
    if tr.kind == "filelog" and has_container_operator(user_cfg):
        ns, pod, uid, container = _staged_pod_identity(ctx.fixture_path)
        message += (
            f" Because the chain includes a `container` operator, the fixture "
            f"was staged at a container-runtime log path for the sandbox "
            f"cluster's seed pod (namespace `{ns}`, pod "
            f"`{pod}`, uid `{uid}`, container "
            f"`{container}`) — `add_metadata_from_filepath` derives "
            f"that identity and `k8sattributes` can resolve it. Fixture lines "
            f"must be in a container runtime format the operator parses (e.g. "
            f"CRI: `2026-01-01T00:00:00.000000000Z stdout F <message>`)."
        )
    advisories.append(
        MutationAdvisory(
            id="R-008",
            severity="info",
            message=message,
            details={"receiver": tr.name, "kind": tr.kind},
        )
    )
    return doc


def swap_pipeline_endpoints(
    doc: dict,
    ctx: MutationContext,
    advisories: list[MutationAdvisory],
    *,
    in_name: str,
    out_name: str,
) -> dict:
    """Rewire each remaining pipeline's ``receivers``/``exporters`` lists to
    reference the sandbox components installed by ``sub_receivers_*`` /
    ``sub_exporters``. Without this the pipelines would still name the user's
    original components, which no longer exist in the receivers/exporters
    blocks.

    No advisory is emitted: R-001 and R-002 already cover the user-visible
    aspect.
    """
    service = doc.get("service") or {}
    pipelines = service.get("pipelines") or {}
    for name, pipeline in pipelines.items():
        new_pipeline = dict(pipeline or {})
        new_pipeline["receivers"] = [in_name]
        new_pipeline["exporters"] = [out_name]
        pipelines[name] = new_pipeline
    return doc


# ---------------------------------------------------------------------------
# Orchestrators
# ---------------------------------------------------------------------------
#
# R-105 (confmap provider neutralization) no longer runs here: see the module
# docstring.


def _load(yaml_str: str) -> tuple[YAML, dict]:
    yaml = YAML()
    yaml.preserve_quotes = True
    return yaml, yaml.load(yaml_str) or {}


def _dump(yaml: YAML, doc: dict) -> str:
    buf = io.StringIO()
    yaml.dump(doc, buf)
    return buf.getvalue()


def mutate_for_otlp_replay(
    yaml_str: str,
    signal_type: str,
    output_path: Path,
    otlp_port: int,
    target_pipeline: str | None = None,
) -> tuple[str, list[MutationAdvisory]]:
    """Compose the OTLP-replay sandbox mutations and return the rewritten
    YAML plus the advisories accumulated along the way.

    ``target_pipeline`` (when set) narrows the run to a single named pipeline
    via R-005; None keeps the legacy "all same-signal pipelines" behavior.
    """
    yaml, doc = _load(yaml_str)
    ctx = MutationContext(
        signal_type=signal_type,
        output_path=output_path,
        otlp_port=otlp_port,
        target_pipeline=target_pipeline,
    )
    advisories: list[MutationAdvisory] = []

    # Order matters: drop_non_target_pipelines before swap_pipeline_endpoints
    # so we only rewire the pipelines we keep. sub_receivers/sub_exporters
    # define the components that swap_pipeline_endpoints then references.
    sub_receivers_otlp(doc, ctx, advisories)
    sub_exporters(doc, ctx, advisories)
    strip_extensions(doc, ctx, advisories)
    strip_connectors(doc, ctx, advisories)
    drop_non_target_pipelines(doc, ctx, advisories)
    swap_pipeline_endpoints(
        doc, ctx, advisories, in_name=OTLP_IN_NAME, out_name=FILE_OUT_NAME
    )
    rewrite_k8s_auth(doc, ctx, advisories)
    strip_in_cluster_detectors(doc, ctx, advisories)
    strip_cloud_detectors(doc, ctx, advisories)
    strip_service_detectors(doc, ctx, advisories)
    force_telemetry_off(doc, ctx, advisories)

    return _dump(yaml, doc), advisories


def mutate_for_operator_test(
    yaml_str: str,
    signal_type: str,
    output_path: Path,
    fixture_path: Path | None,
    syslog_port: int | None,
    target_pipeline: str | None = None,
) -> tuple[str, list[MutationAdvisory]]:
    """Compose the operator-test sandbox mutations: synthesize the
    filelog/syslog receiver (R-008), keep the user's processors, strip
    exporters/extensions/connectors/telemetry, rewire pipeline endpoints
    so the kept receiver feeds file/test_out.

    ``target_pipeline`` (when set) narrows the run to a single named pipeline
    via R-005; None keeps the legacy "all same-signal pipelines" behavior.
    """
    yaml, doc = _load(yaml_str)
    ctx = MutationContext(
        signal_type=signal_type,
        output_path=output_path,
        fixture_path=fixture_path,
        syslog_port=syslog_port,
        target_pipeline=target_pipeline,
    )
    advisories: list[MutationAdvisory] = []

    tr = detect_testable_receiver(
        doc, signal_type=signal_type, target_pipeline=target_pipeline
    )
    receiver_name = tr.name if tr is not None else OTLP_IN_NAME

    sub_receiver_synthesized(doc, ctx, advisories)
    sub_exporters(doc, ctx, advisories)
    strip_extensions(doc, ctx, advisories)
    strip_connectors(doc, ctx, advisories)
    drop_non_target_pipelines(doc, ctx, advisories)
    pipelines = ((doc.get("service") or {}).get("pipelines")) or {}
    for pname, pipeline in pipelines.items():
        new_pipeline = dict(pipeline or {})
        new_pipeline["receivers"] = [receiver_name]
        new_pipeline["exporters"] = [FILE_OUT_NAME]
        pipelines[pname] = new_pipeline
    rewrite_k8s_auth(doc, ctx, advisories)
    strip_in_cluster_detectors(doc, ctx, advisories)
    strip_cloud_detectors(doc, ctx, advisories)
    strip_service_detectors(doc, ctx, advisories)
    force_telemetry_off(doc, ctx, advisories)

    return _dump(yaml, doc), advisories

