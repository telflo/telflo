# otelcol-testing

The collector tester. It runs one test of an OpenTelemetry Collector
configuration: it starts the pinned `otelcol-contrib` in a sandbox, feeds
it the test's input, holds it for the run's duration, and answers what
came out. Two things shape it:

- **It is database-free.** It holds no database or storage credentials.
  The platform's API queues runs in its own Postgres. Its dispatcher sends
  each run here with its text, settings and input, and stores the answer
  itself (the files in its FileStore, the rest on the run's row).
- **It is hardened** for running text any member of an organization can
  type.

The platform's API is its only caller. Browsers never reach it, and it is
never behind the gateway.

## The contract

`openapi.yaml` (OpenAPI 3.1) is the contract. The platform's client checks
answers against Zod mirrors of it, and the platform's fake
(`telflo-core/apps/api/src/testing/fake-otelcol-testing.ts`) is checked
against the file in both directions. JSON goes both ways, with the files
as base64.

- `GET /testing/v1/health` needs no secret. It answers:
  - 200 `{"status":"ok","kwok":"ready"}`;
  - 503 `{"status":"starting","kwok":"starting"}` while kwok's cluster
    starts;
  - 503 `{"status":"unavailable","kwok":"failed"}` once it has failed.
- `POST /testing/v1/runs` needs `Authorization: Bearer <secret>`, checked
  before routing and before the body is read: without it, every path gets
  the same 401.
  - **The request:** `runId` (a log label), `yaml` (1–262,144
    characters), `pipeline`, `signal` (`traces`, `metrics` or `logs`),
    `durationSeconds` (a whole number, 1–60), `distribution`
    (`otelcol-contrib` only), `version` (`major.minor.patch`), and
    `input: {base64}` (at most 10 MiB decoded). No other field is allowed,
    and there is no file name.
  - **The answer (200):**
    - `status`, `succeeded` or `failed`, and `error: {code, message}` when
      failed. The codes are `refused`, `unreadable`, `collector_failed`,
      `replay_rejected` and `timed_out`.
    - `strategy`, `kwokEnabled`, `collectorVersion`.
    - `logs`: scrubbed, at most 256 KiB, with the replay's `[replay]`
      block.
    - `mutatedYaml`: the text the collector ran, scrubbed.
    - `mutations[]` and `compatibility[]`.
    - `output: {base64, bytesOnDisk, truncated} | null`.
    - `decodedInput: {base64, truncated} | null` (OTLP runs only).
    - `timings: {totalMs, readyMs, informerMs, replayMs, holdMs, stopMs}`.
  - **The output** is serialized compact: one record
    unwrapped, several as `{"records":[…]}`, at most 10 MiB. Past that,
    trailing records are dropped and R-006 is added.
- **Errors** use the platform's envelope, `{"error":{"code","message"}}`,
  and a message never quotes the request:

  | Status | Code | When |
  |---|---|---|
  | 401 | `unauthorized` | No secret, or a wrong one |
  | 404 | `not_found` | No such route (after authentication) |
  | 413 | `payload_too_large`, `input_too_large` | A body past 16 MiB or a text past 262,144 characters; an input past 10 MiB |
  | 400 | `invalid_request` | Anything else the contract refuses |
  | 400 | `version_unknown` | A version this tester's catalog doesn't list |
  | 409 | `version_retired` | A version the catalog deprecates |
  | 503 | `tester_busy` | No slot freed within 5 s |
  | 503 | `version_unavailable` | An offered version this image doesn't hold |
  | 503 | `tester_starting`, `tester_unavailable` | kwok is starting, or has failed |
  | 500 | `internal_error` | Anything unexpected |

  The platform puts a run back in its queue only on `tester_busy`,
  `tester_starting` or `tester_unavailable`, or when nothing was sent. A
  run that may have started is never sent twice. When the tester's
  catalog and the platform's disagree, the run fails with its own code,
  logged at warn: on `version_retired`, "Collector v{x} is no longer
  offered by the tester. Pick a newer collector version."; on
  `version_unknown`, "Collector v{x} isn't available in the tester. Pick
  another collector version."

## A run

At most `OTELCOL_TESTING_MAX_CONCURRENCY` runs at once (default 4). Each
run is its own child process (`python -m app.run_child`) in its own
session and process group, with the collector inside it. The service only
starts it, waits, and kills it: its own event loop parses nothing. In the
child (`app/run.py`):

1. **The neutralizer** (`app/neutralise.py`, over the validator's
   `providers.py`, `bounded_yaml.py` and `placeholders.py`, copied byte for
   byte). It reads the text with bounds (nesting 100 deep, 100,000 nodes
   of alias expansion; anything it can't read is C-000). It finds every
   live non-`env` confmap reference on the decoded keys and scalars, tagged
   ones included, and splices each out by its source span, putting in the
   validator's typed placeholder (R-105). A text holding a `!!binary` value
   is refused first (`refused`): the collector decodes it and expands the
   references in what it decodes, which no scan here can see.
2. **The run:**
   - the text read with ruamel (C-000 if it can't be read, or isn't shaped
     as a collector configuration);
   - the compatibility checks C-001 to C-006 (`app/compatibility.py`). A
     refusal answers `refused`, "sandbox refused to run pipeline: …";
   - the strategy for the target pipeline (`app/executors/`): **OTLP
     replay** to a sandbox OTLP/HTTP receiver, **filelog pull** of the input
     staged as a file, or **syslog push** over TCP. The `filelog` receiver
     is spelt either way: `file_log` is its name from collector 0.149.0
     (the catalog's `renamedTypes`), and both take the pull;
   - the fixture-shape advisory, F-001 to F-003 (`app/fixture_shape.py`);
   - the strategy's mutations (`app/yaml_mutations.py`).
3. **Two checks on the exact text the collector will read**, just before
   it starts:
   - the backstop refuses a surviving live reference ("…could not be
     checked safely");
   - the file-settings check (C-006 again) walks the node graph that the
     backstop's own reader composes, and refuses on any read failure (C-000).
4. **The collector**: `<binary> --config <file>`, with no shell, the
   allowlisted environment (`app/environment.py`) and the sandbox's fixed
   overrides (`app/sandbox_env.py`). It gets `KUBECONFIG` for a Kubernetes
   processor, and the run's workspace as its working directory. Its pipes
   are drained as they arrive. Then:
   - **ready:** a TCP probe, or the collector's ready line for
     filelog;
   - **the kwok informer wait**, when a processor needs Kubernetes;
   - **the feed:** the replay within its 30 s budget (each POST under
     5 s), the syslog push, or filelog's staged input;
   - **the hold** for the run's duration, while a watchdog stops a
     collector whose output passes 16 MiB;
   - **the stop:** SIGTERM, 5 s, then SIGKILL and the reap, always, in a
     `finally`.
5. **The answer:**
   - the logs with the `[replay]` block, which says how many payloads
     weren't sent if the replay's budget ran out;
   - the text it ran, the output, the decoded input and the timings;
   - all of it scrubbed by the service of the run's workspace, kwok's
     kubeconfig, the service's own directories and the secret's exact value
     (`app/scrub.py`), in every field.

**The budgets** (`app/settings.py`): slot wait 5 s, preparation 2 s,
collector ready 10 s, kwok informer 5.2 s, replay 30 s, hold d, stop 6 s,
finish 3 s. A run's process group is killed 57 + d s after its child
starts, and a request has 64 + d s in all. At the deadline, or when the
request is canceled or its client goes away, the whole group is killed
(`killpg`) and reaped. The workspace is removed before the slot frees. The
platform's client waits 74 + d s, and its lease is 174 + d s (the platform
follows a run's answer with the OTTL evaluator's check of its rules).

## Codes

The mutations' and the compatibility findings' ids are stable, with the
newer ones marked. A finding or an advisory may name the text's components
and keys, never a value. The platform shows them only in the results panel,
inside `ph-no-capture`, and logs none of them.

**Mutations** (`mutations[]`, each `{id, severity, message, details}`):

| Id | What the sandbox changed |
|---|---|
| R-001 | The target pipeline's receivers replaced by a sandbox OTLP/HTTP receiver (OTLP replay) |
| R-002 | The exporters replaced by a file exporter that captures the output |
| R-003 | Extensions removed: they don't run in a test |
| R-004 | `service.telemetry` replaced, so parallel runs don't collide on its ports |
| R-005 | The other pipelines excluded: only the target pipeline runs |
| R-006 | The output passed the 10 MiB cap (or the 16 MiB watchdog): trailing records dropped |
| R-007 | Connectors removed |
| R-008 | A filelog or syslog receiver re-synthesized: its operators and parsing kept, its source replaced by the input |
| R-100 | A Kubernetes processor's `auth_type` rewritten to the fake cluster's kubeconfig |
| R-101 | resourcedetection's in-cluster detectors stripped |
| R-103 | resourcedetection's cloud detectors stripped |
| R-105 | Configuration provider references neutralized (the validator's neutralizer) |
| R-106 | *New.* resourcedetection's `consul`, `openshift` and `docker` detectors stripped, with their settings |

R-102 and R-104 are reserved and never emitted.

**Compatibility** (`compatibility[]`, each `{id, severity, component,
message, details}`; `refuse` blocks the run):

| Id | Severity | What it finds |
|---|---|---|
| C-000 | refuse | A text that can't be read, isn't shaped as a collector configuration, or holds a duplicate key (named by its line, never quoted); also a final text the file-settings check can't read |
| C-001 | refuse | A refused receiver. The list is empty |
| C-002 | refuse | A processor that pins `kube_config_path` |
| C-003 | advisory | A timing window longer than the run (`tail_sampling.decision_wait`), with a recommended duration |
| C-004 | refuse | An operator test (filelog or syslog) that can't run: more than one such receiver, other receivers beside it, a logs-only receiver in another signal, an operator outside the allowlist |
| C-005 | refuse | *New.* The `geoip` processor (reads a database file), `schema` (fetches schema files from URLs, `file://` included) and `remotetap` (starts its own server) |
| C-006 | refuse | *New.* Any processor setting whose key ends in `_file` or `_path` and holds a value, anywhere in its configuration: the sandbox can't give a run files. Checked on the text, then again on the final text |

**Fixture shape** (a warning among the mutations; the browser runs the
same check before queuing, with "Run Anyway"):

| Id | What it warns |
|---|---|
| F-001 | The target pipeline replays OTLP, but the input is raw text lines or NDJSON |
| F-002 | The target pipeline reads lines (filelog or syslog), but the input is OTLP JSON |
| F-003 | The input's OTLP signal isn't the pipeline's |

The parity corpus, `tests/fixtures/fixture-shape-corpus.json`, is the one
copy both this service's tests and the web's
(`telflo-core/apps/web/app/lib/test-runs/fixture-shape.parity.test.ts`)
read.

## The protections

- **The secret is in a file** (`OTELCOL_TESTING_SECRET_FILE`, at least 32
  bytes; previous secrets in `OTELCOL_TESTING_SECRETS_PREVIOUS_FILE`). A
  token is checked against their SHA-256 digests, in constant time; their
  values are held only to scrub them from every answer (`Redactions`, never
  logged or shown by a repr). The service refuses
  to start without a readable secret, with `OTELCOL_TESTING_SECRET` set, or
  with the secret's text in any variable.
- **Not dumpable.** `PR_SET_DUMPABLE` 0 is set at start, before the secret
  is read (`app/hardening.py`). `exec` resets it for the collectors and
  kwok, which is why the secret is in no environment.
- **An environment allowlist** for each run's processes (`PATH`, `HOME`,
  the locale and temporary variables) plus the sandbox's fixed overrides.
- **No route out.** In compose the service is only on the internal network
  `otelcol-testing`, which the API joins. The forwarder
  `otelcol-testing-forward` (nginx, `docker/otelcol-testing/
  forward.conf`) publishes it on the host's `127.0.0.1:51237` only, for an
  API run natively and the smoke test.
- **A read-only root** with tmpfs: `/tmp` (1 GiB, each run's workspace)
  and the home directory (512 MiB, kwok's cluster). Every binary sits under
  `/opt`, owned by root.
- **No capabilities** (`cap_drop: [ALL]`) and `no-new-privileges`, as uid
  10001; tini is PID 1.
- **The cap and the budgets** above, and the output watchdog.
- **The refusals and strips** above (C-005, C-006, R-106), because every
  run shares one uid.

`scripts/check-container.sh [compose options…]` checks the running
container from the inside: the uid, the read-only root and tmpfs (noexec),
no route out, the secret in no environment, the process not dumpable, no
capabilities. It checks the forwarder too. CI's `stack` job runs it.

## kwok

For Kubernetes processors (k8sattributes), the service runs one fake
cluster with kwok, started in the background once the service listens:

- **The binaries** are kwok's pinned releases: kwok and kwokctl v0.7.0,
  kubectl and kube-apiserver v1.31.6, and etcd v3.5.21. They are listed in
  `kwok/binaries.json` with each one's sha256, fetched and checked by
  `scripts/download-kwok.py`, and baked under `/opt/kwok/v0.7.0/`. All are
  Apache-2.0. kwok's code is never changed.
- **Its configuration**, `kwok/kwokctl.yaml`, is passed with `-c`: it pins
  Kubernetes v1.31.6, binds 127.0.0.1, names the baked binaries, and gives
  kube-apiserver `advertise-address=127.0.0.1`. Without it, kwokctl retries
  downloads forever when there is no network.
- **One pod is seeded** from `fixtures/kwok/default-cluster.yaml`. A
  filelog input with a `container` operator is staged at that pod's log
  path, so `k8sattributes` can resolve it.
- **The kubeconfig is an admin certificate** that can write the cluster.
  No component that survives the mutations writes it, and every run shares
  the cluster.
- **kwok is part of the health.** A failed start is retried: three
  attempts, 2 s and then 4 s apart. Once all have failed, health answers
  `unavailable`, runs get 503 `tester_unavailable`, and the process exits 1,
  so compose's `restart: unless-stopped` starts it afresh. Once up, the
  cluster's liveness is re-checked on health and before every run, and two
  failed probes in a row fail it the same way. A run is never served
  without kwok.

## Settings

| Variable | Meaning |
|---|---|
| `OTELCOL_TESTING_SECRET_FILE` | Required. A file holding the shared secret, at least 32 bytes, readable by uid 10001. Compose 2.6.0 ignores `secrets:`' `uid`, `gid` and `mode`, so the development file is committed 0644. The platform's `TELFLO_OTELCOL_TESTING_SECRET` holds the same text. |
| `OTELCOL_TESTING_SECRETS_PREVIOUS_FILE` | Optional. Previous secrets during a rotation, one per line. |
| `OTELCOL_TESTING_MAX_CONCURRENCY` | Optional, default 4: runs at once. Keep it equal to the platform's `TELFLO_TEST_RUNS_PER_TESTER`. |
| `OTELCOL_BINARY_DIR` | Optional, default `/opt/otelcol`: the collectors, as `v<version>/otelcol-contrib`. |
| `OTELCOL_CATALOG_DIR` | Optional: the catalog. The image sets its own copy; from the checkout, the repository's `catalog/distributions`. |
| `KWOK_BINARY_DIR` | Optional, default `/opt/kwok`: kwok's binaries, as `v0.7.0/{kwok,kwokctl,kubectl,etcd,kube-apiserver}`. |
| `KWOKCTL_CONFIG` | Optional: the kwokctl configuration, `kwok/kwokctl.yaml` by default. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional: the service's own telemetry (`telemetry.py`), off unless set. |

The development secret is `docker/otelcol-testing/development-secret`. It
is public in the repository: every real deployment generates its own, for
example with `openssl rand -base64 48`.

## The image

`Dockerfile` builds from the repository's root (so the image carries
`catalog/`), in three stages:

- **download:** the collectors from the catalog, each checked against
  its sha256 by the validator's `scripts/download-binaries.py`; kwok's five
  binaries; tini v0.19.0;
- **runtime:** the default target, on the validator's pinned
  `python:3.12-slim` digest, as uid 10001, with tini as PID 1 and a
  healthcheck;
- **test:** the runtime plus the development lock, procps and the tests.

The build argument `OTELCOL_VERSIONS` picks the collectors: `all` (the
default, every version the catalog offers; about 2.0 GB), `default` (the
catalog's default only; about 0.88 GB, as CI's stack job and throwaway
stacks build it), or a comma-separated list. A version the image doesn't
hold answers 503 `version_unavailable`.

In `docker-compose.yml` the service is `otelcol-testing`
(`telflo-otelcol-testing:dev`); `npm run dev:services` starts it with its
forwarder.

## Tests

With Python 3.12, from this directory, in a virtual environment outside
the checkout (or `.venv/`, which is ignored):

```sh
python3.12 -m venv /path/to/venv
/path/to/venv/bin/pip install --require-hashes -r requirements.txt
/path/to/venv/bin/pip install --require-hashes --no-deps -r requirements-dev.txt
/path/to/venv/bin/python -m pytest
```

Warnings fail the run. The repository suite runs the service against fake
collectors, and includes:
- the neutralizer's canaries;
- the identity test of the copied modules
  (`tests/test_neutraliser_identity.py`, which reads
  `../otelcol-validator/app`);
- the contract (`tests/test_openapi.py`);
- the fixture-shape parity corpus.

Two markers are deselected by default (`pytest.ini`):
- **`binary`** runs a real `otelcol-contrib` from `OTELCOL_BINARY_DIR`
  (`tests/test_binary_*.py`): OTLP replay for each signal, filelog,
  syslog, the canaries, failures, UTF-16 input, R-006, a run killed at its
  budget, and the image's catalog;
- **`kwok`** starts kwok's cluster from the image's binaries.

Both run inside the image's `test` target, on every collector version it
holds, with no network (CI's `otelcol-testing` job), from the repository's
root:

```sh
docker build -f services/otelcol-testing/Dockerfile --target test \
  --build-arg OTELCOL_VERSIONS=all -t telflo-otelcol-testing-test .
docker run --rm --network none telflo-otelcol-testing-test pytest -m "binary or kwok" -q
```

## Dependencies and licenses

`requirements.in` is compiled to the hash-locked `requirements.txt` against
the validator's lock (`-c ../otelcol-validator/requirements.txt`), so the
packages both services ship are pinned alike. `requirements-dev.in` is
compiled to `requirements-dev.txt` the same way. `httpx2` (BSD-3-Clause)
stands in for `httpx`, whose `certifi` is MPL-2.0.

These two commands check every runtime package's license against the
repository's `scripts/license-policy.json`, and test the check
itself:

```sh
PYTHON=/path/to/venv/bin/python ./scripts/check-licenses.sh
PYTHON=/path/to/venv/bin/python ./scripts/check-licenses.test.sh
```

The image's base, the collectors, tini and kwok's binaries are reviewed
components, pinned by digest or sha256.
