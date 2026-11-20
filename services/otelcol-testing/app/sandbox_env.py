"""Environment-variable overrides for the spawned otelcol-contrib subprocess.

The parent-environment allowlist is `app/environment.py`'s, so the run's
child and its collector are filtered by one list; this module adds the
sandbox's fixed overrides on top of it. ``_ALLOWED_PARENT_ENV`` names that
same set for the tests.

User pipelines often reference env vars the runtime is expected to provide
(``${env:MY_POD_IP}``, ``${env:K8S_NODE_NAME}`` from the downward API,
``$HOSTNAME``, etc). In production those come from the pod spec; in the
sandbox there is no pod spec, so the collector either fails at config-load
time ("envvar X is not set") or starts but produces wrong attributes.

This module sets placeholder values aligned with what the kwok cluster
actually contains — see ``fixtures/kwok/default-cluster.yaml``. The same
pattern (parent-env allowlist + static overrides) lives in the validator
(`services/otelcol-validator`) for the validate path; it is mirrored here
for the test-run path so a YAML that validates also runs.

Note: receivers / exporters / extensions referencing env vars (``MY_POD_IP``
in the user's ``otlp`` receiver and ``health_check`` extension) get
swapped/stripped by the mutator before spawn, so those env vars are
strictly speaking unnecessary post-mutation. We still set them — defensive
against components we don't currently mutate, and harmless when unread.
"""

from __future__ import annotations

from app.environment import ALLOWED_PARENT_ENV, allowed

# Aligned with fixtures/kwok/default-cluster.yaml. If you change the seed
# manifest's namespace / node / pod names, change these too — k8sattributes'
# ``node_from_env_var`` filter matches against the env var, so a mismatch
# means the processor finds zero pods and emits no enrichment.
#
# Exposed (no underscore prefix) because the OTLP executor's informer-sync
# poll also needs them — it hits the kwok apiserver and waits for this
# specific pod to be listable before letting the user's pipeline replay
# data. Importing from one place keeps the sandbox-env overrides and the
# readiness probe in lockstep.
KWOK_SEED_NODE = "kwok-node-0"
KWOK_SEED_POD = "telflo-test-pod"
KWOK_SEED_NAMESPACE = "demo"

# Backwards-compatible private aliases — the original underscore-prefixed
# names were the established import surface inside this module. Keeping
# them lets the SANDBOX_ENV_OVERRIDES literal below stay unchanged.
_KWOK_SEED_NODE = KWOK_SEED_NODE
_KWOK_SEED_POD = KWOK_SEED_POD
_KWOK_SEED_NAMESPACE = KWOK_SEED_NAMESPACE

# Env vars the spawned otelcol-contrib subprocess is allowed to read from the
# parent process: `app/environment.py`'s list. Everything else (a future
# operator-injected secret, the telemetry endpoint) is stripped before exec.
#
# Why: collector configs support `${env:VAR}` substitution at config-load time.
# A user-submitted YAML can interpolate any parent-env value into a processor
# attribute and read it back from the `file/test_out` exporter output. The
# allowlist closes that exfiltration path. Add to it only with a deliberate
# reason — anything added becomes readable by any pipeline submitted to the
# testing service.
_ALLOWED_PARENT_ENV: frozenset[str] = ALLOWED_PARENT_ENV


SANDBOX_ENV_OVERRIDES: dict[str, str] = {
    # Downward-API placeholders for k8sattributes.filter.node_from_env_var,
    # resourcedetection's k8snode detector (when pointed at env), etc.
    "K8S_NODE_NAME": _KWOK_SEED_NODE,
    "K8S_POD_NAME": _KWOK_SEED_POD,
    "K8S_NAMESPACE": _KWOK_SEED_NAMESPACE,
    "K8S_CLUSTER_NAME": "telflo-test",
    # Generic host/IP placeholders for receivers/extensions whose endpoints
    # interpolate ${env:MY_POD_IP}. Everything in the sandbox listens on
    # 127.0.0.1 anyway so this is the right default.
    "MY_POD_IP": "127.0.0.1",
    "HOSTNAME": _KWOK_SEED_POD,
    # NOTE: do NOT add OTEL_SERVICE_NAME or OTEL_RESOURCE_ATTRIBUTES here.
    # The resourcedetection processor's ``env`` detector reads exactly
    # those two env vars and emits them as resource attributes — and by
    # default with ``override: true`` clobbers whatever ``service.name``
    # (and other ``service.*`` attributes) the user's records already
    # carried. Setting these in the sandbox makes every test run
    # report ``service.name=otelcol-testing`` regardless of what the
    # user's app actually sent, which defeats the point of the sandbox
    # for any pipeline that uses ``resourcedetection`` with ``env``. A
    # user pipeline that genuinely needs these env vars set should
    # declare them via the resource processor (``insert`` / ``upsert``
    # actions) in their YAML, not rely on sandbox state.
}


def build_subprocess_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Return the env dict for the spawned otelcol-contrib subprocess.

    Composition order (later wins):
      1. Parent env, filtered through the allowlist (`app/environment.py`).
         Secrets in the testing service's own environment never reach the
         subprocess.
      2. Static sandbox overrides (``SANDBOX_ENV_OVERRIDES``).
      3. Caller-supplied ``extra`` (typically ``{"KUBECONFIG": ...}`` from the
         kwok wiring).
    """
    env = allowed()
    env.update(SANDBOX_ENV_OVERRIDES)
    if extra:
        env.update(extra)
    return env
