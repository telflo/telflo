# otelcol-validator

Checks an OpenTelemetry Collector configuration with `otelcol-contrib
validate` of the collector version it is pinned to, and says what a host
must provide to run it. The platform's API is its only caller
(`POST /api/v1/organizations/{organizationId}/configurations/{configurationId}/versions/{versionId}/validation`);
browsers never reach it, and it never sits behind the gateway.

`openapi.yaml` is the contract: the API and its shared secret. It is an
internal service that runs untrusted configurations.

## The API

- `GET /health`: `{"status": "ok"}`, without the secret.
- `POST /validator/v1/validate/{distribution}/{version}` with
  `{"yaml": "…", "organizationVariables": {"NAME": "value", …}}` (the
  values optional: at most 150 of at most 1,024 characters, the opamp-server's bounds): `200 {valid, errors: [{message, componentPath}],
  requirements: [{category, title, description, componentPath}],
  distribution, version}`. A distribution or version the catalog doesn't
  list is 404, a deprecated version 409 `version_retired`, an offered version
  whose collector isn't here 503 `version_unavailable`, all before the body is
  read; a malformed path or body 400; a body over 2 MiB 413 (refused while it
  is read), and a `yaml` over 262,144 characters (the platform's limit) 413
  too; no free slot within 5 seconds 503 `validator_busy`.
- Every request but `/health` needs `Authorization: Bearer <secret>`.

Requirements never count as errors: `valid` is false exactly when `errors`
isn't empty. An answer is bounded:
- at most 200 errors; when the collector reported more, a 201st says `The
  collector reported more errors than shown.` (componentPath null);
- each requirement once (by category, title and `componentPath`, the first
  kept) and at most 200 of them, the collector's and the confmap
  providers' first, then the text scan's (organization and environment
  variables, TLS files, …), the rest dropped;
- every string cut with `…` to a budget in bytes of the answer's JSON: an
  error's message 4 KiB and path 1 KiB; a requirement's title 1 KiB,
  description 4 KiB, path 1 KiB.

A text's own references each make a requirement, and a multi-line key
aliased into many pipelines made 0.162.0 print 130,746 errors; bounded, an
answer is at most 2,290,356 bytes (`MAX_ANSWER_BYTES` in `app/runner.py`),
within the 4 MiB the platform reads.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OTELCOL_VALIDATOR_SECRET` | (required) | The shared secret, at least 32 bytes. Without it the service refuses to start. |
| `OTELCOL_VALIDATOR_SECRETS_PREVIOUS` | empty | Comma-separated secrets still accepted during a rotation, each at least 32 bytes. |
| `OTELCOL_VALIDATOR_MAX_CONCURRENCY` | `8` | Collectors run at once (each holds about 80 MB). |
| `OTELCOL_VALIDATE_TIMEOUT` | `10` | Seconds one `validate` may run. A whole check may run 2 s more (its deadline: 12 s by default); with the longest wait for a slot (5 s) and ending the check (at most about 1 s), a request answers within about 18 s, inside the platform's 20-second limit on its call. |
| `OTELCOL_BINARY_DIR` | `/opt/otelcol` | Holds `v<version>/otelcol-contrib` for each version baked in. |
| `OTELCOL_CATALOG_DIR` | the repository's `catalog/distributions` | The catalog the validator reads (the image sets its own copy). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | When set, `telemetry.py` exports the service's own traces, logs and runtime metrics. |

The secrets are kept only as SHA-256 digests and compared in constant time.
Neither they nor the text nor the collector's output ever reach a log line.

## What a check does

A check takes one of `OTELCOL_VALIDATOR_MAX_CONCURRENCY` slots (waiting at
most 5 seconds for one), then runs in a child process of its own,
`python -m app.check`: its own process group, the collector's allowlisted
environment (never the service's secret), the request on its stdin and its
answer on its stdout. The service's event loop only starts it and reads its
answer: it never parses the text or the collector's output.

The child has one hard deadline, `OTELCOL_VALIDATE_TIMEOUT` plus 2 seconds
(12 s by default). At the deadline, or when the request is canceled, the
service kills the child's whole process group (SIGKILL: the child and its
collector) and reaps the child; a check the deadline ends is invalid,
`Validation timed out after 12s`. However a check ends, the service then waits
for the rest of the group to be gone, at most about a second, removes the
check's temporary directory (the only place the child writes; in a thread, off
the event loop; a removal that fails is logged by the error's type, never its
path) and only then releases the slot. Nothing inside the child has a time
bound of its own but the collector; the deadline bounds everything else.

A reap waits for the process's exit only, never for its pipes: both the
service and the child read their subprocess's output as it arrives, keep the
first bytes up to a cap and drop the rest, and close the pipes once the
process has exited, whatever they still hold. (asyncio's streams pause a pipe
at 128 KiB unread and its `wait()` waits for every pipe to close: a check
killed while its child wrote a large answer never ended.)

A killed collector is the child's orphan: the image runs tini as its PID 1,
which reaps it. Run elsewhere without an init, it stays a zombie, which runs
nothing and holds nothing but its pid; the service's wait for the group then
gives up after about a second, and the slot is released with the zombie left.

In the child, the organization's values are filled in FIRST
(`app/org_variables.py`, the opamp-server's fill-in ported and held to its
corpus): each live `${org:NAME}` with a value is replaced by it, every `$` of
the value doubled, and every step below reads the filled-in text, so a value
that adds YAML structure is parsed, neutralized and checked like the rest. The
filled-in length is counted first: over 1 MiB of UTF-8 the text is invalid
with `The configuration with its organization variables filled in is over 1
MiB.` (the opamp-server never serves it), and nothing is built. Measured: a
dense flow text that fills in to 1 MiB took about 9.4 s and a peak of about
462 MB to pre-process, against about 2.2 s and 168 MB for a text of 262,144
characters with nothing filled in. Such a text passes the 1 MiB bound but uses
up the check's deadline, so it answers `Validation timed out after 12s` while
the opamp-server would serve it. A memory limit for the validator's container
is deployment hardening, left for later. Then, on the filled-in text:

0. Every YAML parse goes through `app/bounded_yaml.py` (libyaml's loader): a
   text whose mappings and sequences nest more than 100 deep, in the text or
   once its aliases are expanded, is invalid with
   `The configuration nests too deeply.`, and one whose aliases add more than
   100,000 nodes when expanded (or contain themselves) with
   `The configuration expands too many YAML aliases.`; the collector isn't run
   for either. The text's own nesting is counted from the parser's events
   before anything is built, and the expanded nesting from the composed
   document before anything is constructed, so nothing recurses past the
   bound. A plain scalar PyYAML would read as a timestamp, as `=`, or as an
   int or float it can't construct (`2001-13-45`, `0b_`) is a string, as the
   collector reads it; a value that can't be constructed otherwise (`!!int x`)
   makes the text unparseable. A text PyYAML can't read as **one** document —
   a scanner or parser error, or **more than one document** (a `---`
   separator) — is invalid with
   `The configuration can't be read as YAML: <PyYAML's problem> (line N)` and
   a null path, and the collector is never run: the collector would otherwise
   decode an escape that hides a reference, or load a second document the
   validator never neutralized.
1. Organization variables: one row, `Organization variables filled in`, names
   the names filled in; a `${org:X}` left (no value) is reported as
   `Unresolved organization variable: X`, found on the **decoded** keys and
   values of the filled-in text, so a reference a YAML escape hid from the raw
   text is caught; a reference to a name over 128 characters gets its own row
   too (no variable can have it, and Publish refuses it); the legacy
   `$orgvar:X`, which nothing fills in, `Unsupported: write ${org:X}`.
2. Every non-`env` confmap provider (`${file:…}`, `${http:…}`, …) is
   detected on the **decoded** keys and scalar values — PyYAML's composed
   nodes, whose value is what the collector's confmap layer reads — and
   neutralized by replacing **only that node's source span** with a
   double-quoted rendering of its placeholder (parity-aware escaping and
   typed placeholders). Every other byte stays as sent:
   no whole-document re-dump, so an escape (`"\x24{file:…}"`) can't hide
   a live reference and no untouched scalar's type drifts (`1:30` stays
   `1:30`, not 90). There is no raw-text scan or fallback. The exact text
   each collector run reads (after every splice and insert, the rerun's
   below included) is re-read, and the collector isn't run if it no longer
   reads as one document or any live non-env reference survives.
   A text holding a `!!binary` value, in any spelling of the tag, is refused
   before this step with `The configuration holds a '!!binary' value, …`:
   PyYAML composes it as its base64 text, but the collector decodes it and
   expands the references in what it decodes, which no scan here can see.
3. Datadog exporters without a `hostname` get a placeholder one (so the
   constructor skips cloud hostname detection).
4. `${env:X}` gets a placeholder value in the collector's environment only,
   which is otherwise an allowlist (`PATH`, `HOME`, locale, temp) plus fake
   cluster state. A protected name (`GO[A-Z0-9]*`, `LD_*`, `DYLD_*`,
   `*_PROXY`/`*_proxy`, `SSL_CERT_*`, `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`,
   `LANG`, `LC_*`) gets no placeholder, only its requirement. A reference that
   is the whole value of a key named `root_path` or `directory` (any such key
   qualifies, whatever its component: hostmetrics' and file_storage's are the
   ones the collector stats at `validate`) gets an empty directory inside the
   check's own directory: every `root_path` the one root directory (the
   collector refuses receivers whose root_paths differ), each other variable
   its own. A check makes at most 64 directories of its own for other keys;
   past that, every further variable (and every further distinct value the
   rerun below repoints) shares one overflow directory, so it still names a
   directory that exists and the check behaves as below the cap, except that
   those values no longer differ from one another. The root's directory is
   never counted and never the overflow. A variable's **first** reference in
   the text decides its placeholder: named first under `root_path` or
   `directory`, it is a directory everywhere it appears (an `endpoint` too);
   named first elsewhere, it is a string placeholder everywhere (under
   `root_path` too). The text is written as is to a file in the check's
   directory. The scans for `${env:}`, `${org:}` and the providers are linear
   in the text (never the square of its length on unterminated references).
5. `otelcol-contrib validate --config=<file>` runs with no shell, in the
   check's directory, killed after `OTELCOL_VALIDATE_TIMEOUT` seconds;
   stderr capped at 256 KB. A cut output ends at its last complete line
   before the truncation marker, so no part of a path the scrub below can't
   recognize survives the cut.
6. Its stderr is read by stage (resolve, unmarshal, validate, build;
   `app/stderr.py`), each error with its causes; an error is a deployment
   requirement only when every cause matches a requirement template whole (see
   "Requirements"). A crash, or a non-zero exit whose output names no error,
   is invalid: `The collector stopped without saying why (exit 137).` The
   parse is linear in the output, and a cause longer than 4,096 characters is
   an error without any template tried. A cause a validator placeholder filled
   (every placeholder directory's name starts `otelvalidatorplaceholder-`),
   one naming the check's own directory, or one carrying a line break, is
   never a requirement. No answer names the check's directory: every string
   the child and the service return has it replaced by `<validator>`. When a
   run ends with requirements only (no errors) and the sandbox can meet one of
   them — file_storage's missing `directory` (one directory in the check's
   directory per distinct value, past the cap the overflow) or hostmetrics'
   missing `root_path` (every one the check's one root directory) or a named
   environment variable (set to a placeholder; never a name already in the
   collector's environment, nor `GO[A-Z0-9]*`, `LD_*`, `DYLD_*`,
   `*_PROXY`/`*_proxy`, `SSL_CERT_*`, `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`,
   `LANG`, `LC_*`, which go unmet) — the collector runs **once** more with
   those met, inside the same deadline, and that run's errors are the answer's
   errors while the requirements stay from the first run: a validate-stage
   requirement no longer hides a build-stage error.
7. The text itself adds requirements for TLS files, the file exporter's
   directory (a relative one quoted and said to be relative to the
   collector's working directory) and components that need the cluster's
   API, and an error for a tail_sampling OTTL policy with no conditions.

`validate` creates every component without starting it, so constructors run;
the protection is the neutralization above. Further hardening, and a review of
PyYAML's decoding against the collector's yaml.v3, are open work.

## Requirements

What the collector prints becomes a requirement only by template: a cause (in
the validate stage a line's message after its path; in the build stage what
follows `failed to create "<id>" <kind>…: `; in the unmarshal stage each line
of a component's block) must match one of `TEMPLATES` in `app/stderr.py` from
its first character to its last, each template taken from an output the
collector really printed (`tests/fixtures/collector-outputs.json`, and
`tests/fixtures/collector-outputs-linux.json` for what only Linux prints,
recorded in the image), its variable parts an environment variable's name or
an absolute path without whitespace, quotes, brackets, `$`, `:`, `;`, `,` or a
backslash. Anything else is an error: patterns found anywhere in a line would
let the configuration's own words (an echoed key or value, or one the
collector expanded: `$${y}`, a `${env:}` placeholder) pass for a requirement
and hide its error. A cause the submitted text itself holds, or whose quotes
are left open, is an error too, whatever template it matches.

| Template (source case) | Category | Title |
|---|---|---|
| file_storage's `directory must exist: stat <path>: no such file or directory. You can enable the create_directory option to automatically create it` (`req-file-storage-directory`, `reqs`) | `directory` | `Ensure <path> exists at runtime` |
| k8sattributes' `` `node_from_env_var` is configured but envvar "K8S_NODE_NAME" is not set `` (`k8sattr-node`) | `k8s_downward_api` | `Set K8S_NODE_NAME via the Kubernetes downward API` |
| the same, another variable (`req-k8sattr-node-env-custom`) | `env_var` | `Set environment variable <name>` |
| resourcedetection's `failed creating detector type "k8snode": failed creating k8snode detector: failed to create K8s API client: open /var/run/secrets/<path>: no such file or directory` (`req-rd-k8snode-service-account`, darwin; in the image, which stages the service account, `validate` prints nothing for it) | `k8s_in_cluster` | `Mount a Kubernetes service account` |
| hostmetrics' `invalid root_path: stat <path>: no such file or directory` (`req-hostmetrics-root-path`, Linux only, recorded in the image; the image holds `/hostfs`) | `host_filesystem` | `Mount the host filesystem at <path>` |

The image's Linux outputs were recorded (with its staged service
account and directories, `--network none`) for the requirement patterns
that had none. Only hostmetrics' root_path printed one. The rest printed nothing
for any text tried (`validate` passed), so they don't fire from the output:
in-cluster configuration missing (`unable to load k8s config, …`: the
service always sets `KUBERNETES_SERVICE_HOST`, and `auth_type: kubeConfig`
passes too), the service account read by anything but the k8snode detector,
the placeholder CA (`x509: certificate signed by unknown authority`, `tls:
failed to verify certificate`) and the apiserver unreachable (`… kubernetes…
dial tcp …`: no component calls the API at `validate`), an unset variable
without k8sattributes' lead (`envvar "X" is not set`, `environment variable
"X" not found`), TLS files under `tls:` (`failed to load TLS config: open
…`: no component loads them at `validate`) and a bare `stat <path>: no such
file or directory`. The text-scan requirements (TLS files, the file
exporter's directory, the cluster's API; step 7) are unaffected. Two
outputs stay errors: kubeletstats' own TLS files (`auth_type: tls`; `cert
path <path> could not be read: open <path>: …`, recorded as
`linux-kubeletstats-tls-files`) and the k8snode detector's custom
`node_from_env_var` unset (`node name can't be found. …`).

## Layout

- `app/main.py`: routes, the bearer check, the body limit, the error envelope.
- `app/settings.py`: the environment and the secrets.
- `app/catalog.py`: reads `catalog/distributions/*.json` (distribution,
  version, deprecated; every other field ignored).
- `app/runner.py`: one check: the service's half (the slot, the child, its
  deadline and its process group) and the child's half (the steps above).
- `app/check.py`: the check's child process, `python -m app.check`.
- `app/stderr.py`: the collector's output and the requirement templates.
- `app/providers.py`: the confmap provider neutralization (detected on
  decoded nodes, spliced by source span; parity-aware escaping and linear
  brace matching).
- `app/bounded_yaml.py`: the one YAML loader, nesting and alias expansion
  bounded.
- `app/placeholders.py`: `${env:}` placeholders, the placeholder
  directories and Datadog's `hostname`.
- `app/requirements.py`: organization variables and the text's own
  requirements.
- `telemetry.py`: the service's own traces and metrics.
- `Dockerfile`: the image (below); `scripts/download-binaries.py` fetches and
  checks what it bakes in.
- `scripts/check-licenses.sh` (with `evaluate-licenses.py` and a self-test):
  the license check (below).

## Developing

Python 3.12. Use a virtual environment outside the checkout, or `.venv/`
here (ignored), and install from the hash-pinned locks:

```bash
python3.12 -m venv .venv
.venv/bin/pip install --require-hashes -r requirements.txt
.venv/bin/pip install --require-hashes -r requirements-dev.txt
.venv/bin/python -m pytest          # warnings are errors
```

`pytest -m binary` runs the tests that need real collectors under
`OTELCOL_BINARY_DIR` (inside the image), on every offered version:

- a smoke check and the real requirement outputs
  (`tests/test_binary_smoke.py`);
- the collector's renames (`tests/test_binary_renames.py`: every rename the
  catalog's `renamedTypes` lists; catalog/README.md says what to do when
  a version adds one);
- the palette's defaults (`tests/test_binary_palette.py`): each text of
  `tests/fixtures/palette-defaults.json`, what a drop of each palette entry
  writes on each offered version in the smallest configuration around it,
  passes its version's collector, but for the refusals accepted as they are,
  each asserted with its answer: the memory_limiter extension, routing's empty
  table and failover's empty levels. The web writes the fixture
  (`npm run fixture:palette-defaults --workspace @telflo/web`, from
  `telflo-core/`) and its suite fails while it is stale;
- 11 routing and failover cases
  (`tests/test_binary_connectors.py`);
- forward-connector (2) and complex-configuration (3) validation cases
  (`tests/test_binary_builder_texts.py`), on texts its generator wrote
  (`tests/builder_texts.py`, copies of the web's corpus files, which
  `tests/test_builder_texts.py` checks);
- the component forms' cases, each with its answer per version, and the
  start-only cases (`tests/test_binary_handoffs.py`);
- the 20 seeded flows (`tests/test_binary_flows.py`): each text of
  `tests/fixtures/seeded-flows.json` passes its own pin's collector with no
  error, its requirements exactly as listed. The db workspace writes the
  fixture from the `seededFlows` of migrations 1700000000026,
  1700000000045 and 1700000000046 (`npm run fixture:seeded-flows --workspace @telflo/db`, from
  `telflo-core/`) and its suite fails while it is stale. A pin is checked only by an image
  that holds it: `OTELCOL_VERSIONS=all`, or a list naming every pin (0.159.0
  and 0.162.0 today).

An offered version the image doesn't hold is skipped, unless the image was
built to hold it: the `test` target sets `OTELCOL_EXPECTED_VERSIONS` to its
`OTELCOL_VERSIONS`, and a version it names that isn't held fails
(`tests/binary_support.py`). The locks are made with pip-tools:

```bash
pip-compile --generate-hashes --allow-unsafe --strip-extras --output-file=requirements.txt requirements.in
pip-compile --generate-hashes --allow-unsafe --strip-extras --output-file=requirements-dev.txt requirements-dev.in
```

To run it by hand (from this directory):

```bash
OTELCOL_VALIDATOR_SECRET=… OTELCOL_BINARY_DIR=… uvicorn app.main:app --port 8001
```

`tests/fixtures/collector-outputs.json` holds real `validate` outputs of
0.147.0 and 0.162.0 (darwin) that the stderr parser is tested on (0.147.0 is
no longer offered, but its recordings stay), and
`tests/fixtures/collector-outputs-linux.json` what only Linux prints, recorded
in the test image on every offered version; record a new case the same way
when the collector's output changes, and take a new requirement template only
from a recorded output.

## The image

`Dockerfile` builds with the **repository's root** as its context, so the
image carries `catalog/`; the root `.dockerignore` lets in this directory,
without `.venv`, bytecode or caches. From the root:

```bash
docker build -f services/otelcol-validator/Dockerfile -t telflo-otelcol-validator .
docker run --rm -p 127.0.0.1:8001:8001 -e OTELCOL_VALIDATOR_SECRET=<32 bytes or more> telflo-otelcol-validator
```

The build argument `OTELCOL_VERSIONS` picks the collectors it bakes in:

| Value | Bakes | Size (arm64) |
|---|---|---|
| `all` (the default) | every version `catalog/distributions/otelcol-contrib.json` offers (not deprecated) | 1.68 GB with four (0.159.0–0.162.0) |
| `default` | the catalog's default version only | 571 MB |
| `0.162.0,0.160.0` | those versions, each of which the catalog must offer | |

The download stage runs `scripts/download-binaries.py` (Python's standard
library: no curl or jq): for each version, upstream's
`otelcol-contrib_<version>_linux_<arch>.tar.gz` (Docker's `TARGETARCH`,
amd64 or arm64), its sha256 checked against the catalog's, the one file
`otelcol-contrib` extracted to `/opt/otelcol/v<version>/otelcol-contrib` and
the tarball deleted in the same step. A version the catalog doesn't offer,
an empty entry or a sha256 that doesn't match fails the build; each baked
collector must then run in the image and print its own version. The image
always carries the whole catalog, so a version it offers but the image
doesn't hold answers 503 `version_unavailable` (the editor shows the check
as unavailable). Each collector is 363 to 380 MB unpacked (arm64). A
download that fails in transfer (a network error, or a connection closed
before all its bytes arrived) is tried again, three attempts in all; a
sha256 mismatch is never retried.

What else is in it:

- `python:3.12-slim`, pinned by digest (a reviewed component),
  without the `openssl` command (the base image's only one of curl, jq and
  openssl); the hash-pinned runtime lock only, as wheels, before which a
  check fails the build unless PyYAML has libyaml (`yaml.CSafeLoader`);
- the service as uid 10001 (`otelcol-validator`), never root, in
  `/app/services/otelcol-validator`, with the catalog in
  `/app/catalog/distributions` (`OTELCOL_CATALOG_DIR`) and the collectors in
  `/opt/otelcol` (`OTELCOL_BINARY_DIR`), both read-only to it;
- tini (v0.19.0, MIT, its sha256 pinned) as PID 1, which reaps the
  collectors a killed check leaves;
- a fake cluster state, which constructors read at `validate`
  time: a service-account token, namespace and a CA certificate (made with
  openssl in a build stage, its key thrown away) under
  `/var/run/secrets/kubernetes.io/serviceaccount/`, the directories it
  pre-created (`/hostfs`, `/var/lib/otelcol/file_storage`,
  `/var/lib/otelcol-contrib/file_storage`, `/var/log/otelcol`,
  `/var/log/journal`, `/etc/otelcol/certs`), and its environment's
  placeholder values (`K8S_NODE_NAME`, `KUBERNETES_SERVICE_HOST`, ...);
- port 8001 and a health check, a Python `urllib` call to `/health`.

The `test` target is the runtime plus the development lock, `procps` (the
process tests read `ps`) and the tests, for the real-collector tests with
no network:

```bash
docker build -f services/otelcol-validator/Dockerfile --target test -t telflo-otelcol-validator-test .
docker run --rm --network none telflo-otelcol-validator-test pytest -m binary -q
docker run --rm --network none telflo-otelcol-validator-test pytest -q   # the rest, on Linux
```

The compose stack builds the runtime target as `telflo-otelcol-validator:dev`
with `OTELCOL_VERSIONS` from the environment (`all` when unset), publishes
it on the host's `127.0.0.1:51236` only, and shares its development secret
with `api` (`docker-compose.yml`); `npm run dev:services` starts it
and waits for its `/health`.

## Licenses

Every Python package the image installs must carry a license on the
platform's allowed list (`scripts/license-policy.json`):

```bash
scripts/check-licenses.sh        # needs a Python with requirements-dev.txt installed (python3, or $PYTHON)
scripts/check-licenses.test.sh   # its self-test, on wheels it makes itself
```

It installs only `requirements.txt` into a throwaway virtual environment,
reads each package's license with pip-licenses (its PEP 639 expression,
else its `License` field, else its trove classifiers mapped to SPDX) and
refuses one that isn't allowed or can't be known, and a report that names
a package twice. The base image, the collectors and tini aren't Python
packages; they are reviewed components. Nor does pip-licenses see the
native libraries a wheel bundles (grpcio's BoringSSL, abseil and zlib,
PyYAML's libyaml).

## CI

The `otelcol-validator` job (`.github/workflows/ci.yml`), written as if the
service were its own repository, like the opamp-server's: Python 3.12, both
locks installed with `--require-hashes`, `pytest -q`, the license check and
its self-test; then, after freeing the runner's disk, it builds the `test`
target with every offered version and runs `pytest -m binary -q` in it with
`--network none`. The `stack` job builds the compose stack with
`OTELCOL_VERSIONS=default`.

