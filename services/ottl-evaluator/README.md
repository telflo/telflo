# ottl-evaluator

The evaluator checks a test run's **validation rules** against the
collector's output and log: text rules, regex rules and
[OTTL](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/pkg/ottl)
rules. The platform's API calls it after the tester answers a run, and when a
rule is saved. Only the API reaches it, on an internal network.
`PROVENANCE.md` names the OpenTelemetry modules it builds on and their
licenses.

- **`pkg/ottlassert`**: the OTTL assertion library. It parses
  OTLP/JSON (one document, a JSON array, or NDJSON), evaluates an OTTL
  **condition** per record in a **context** (`span`, `spanevent`, `metric`,
  `datapoint`, `log`, `resource`, `scope`), and folds the outcomes with a
  **quantifier** (`all`, `any`, `none`, `count`, or `distinct`, which counts
  the distinct values of an expression).
- **`internal/rules`**: the five kinds of rule, checked one at a time: the
  work of a child process (below).
- **`internal/server`** and **`cmd/server`**: the HTTP side. It checks the
  secret and the request's shape, runs each request's work in a child
  process under its limits, and writes the answer.

Pinned to contrib **v0.162.0**, the catalogue's default collector version
(`catalog/distributions/otelcol-contrib.json` at the repository's root):
`TestOTTLVersionIsTheCatalogueDefault` fails when `go.mod`'s `pkg/ottl` and the
catalogue's default differ, so they move together.

## API

`openapi.yaml` is the contract; `internal/server/conformance_test.go` sends
every documented request through the real server and validates the request
and the answer against it both ways. Every request but `GET /health` carries
`Authorization: Bearer <secret>`. Errors are `{"error": {"code", "message"}}`:
401 `unauthorized`, 404 `not_found`, 405 `method_not_allowed`, 413
`payload_too_large`, 400 `invalid_request`, 503 `evaluator_busy` (with
`Retry-After: 1`) and 500 `internal_error`. A message never quotes the request.

### `POST /ottl/v1/evaluate`

A run's rules against its output and the collector's log:

```json
{
  "signal": "logs",
  "output": {"base64": "eyJyZWNvcmRzIjpbLi4uXX0=", "truncated": false},
  "log": "2026-10-11T10:00:00Z info service started\n",
  "rules": [
    {"id": "r1", "kind": "not_contains_regex", "target": "output", "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b"},
    {"id": "r2", "kind": "contains_text", "target": "stderr", "pattern": "service started"},
    {"id": "r3", "kind": "ottl", "target": "output",
     "ottl": {"context": "log", "quantifier": "all", "condition": "attributes[\"env\"] == \"prod\""}}
  ]
}
```

- `output` is the tester's output, its bytes as they are (one OTLP/JSON
  document, or several as `{"records": [...]}`), or `null` when the collector
  wrote no record. OTTL rules read the records unwrapped; text and regex rules
  search the bytes. `log` is the collector's log, which `stderr` rules search.
- **Text rules** (`contains_text`, `not_contains_text`) are
  whitespace-tolerant: the text is split at its whitespace, and its words
  match in order with any run of whitespace, or none, between them, so
  `"stringValue": "prod"` copied from the viewer matches the stored
  `"stringValue":"prod"`, and `api key` matches `apikey`. Words match byte for
  byte. **Regex rules** use Go's `regexp` (RE2) and match exactly.
- The answer is `{ottlVersion, results}`: one result per rule, in the
  request's order, each `{id, passed, error, advisory, detail}`. A rule's own
  problem (a regex that doesn't compile, a condition that doesn't parse, a
  context the signal doesn't have) is that rule's `error`, never the
  request's. `detail` explains a failure: `no_match`, `unexpected_match` (up
  to 5 matches, each with its text, 40 bytes either side on its line, and its
  record: the element of the output and the JSON path inside it, or the
  log's line), `record_mismatch` (the first 5 records against the rule and
  their snippets: for `all` and `any` those that evaluated to false, for
  `none` those that matched; a `count` rule lists none) or
  `distinct_mismatch` (up to 5 values). `advisory` says when an `all` or
  `none` rule passed over zero records, when a not-contains regex failed on
  matches that were all empty (`x*`, `^`, `\b`: no detail, the advisory
  counts them), and when the output was truncated.

### `POST /ottl/v1/validate`

One rule, checked as a run would check it, at Save:

```json
{"signal": "logs", "rule": {"kind": "ottl", "target": "output",
  "ottl": {"context": "log", "quantifier": "all", "condition": "attributes[\"env\"] == \"prod"}}}
```

The answer is `{valid, problems?, ottlVersion}`; each problem is `{field,
message}`. The checks are evaluate's: the lengths, OTTL nesting of 12 at
most, the contexts the signal allows (logs: `log`, `resource`, `scope`;
traces: `span`, `spanevent`, `resource`, `scope`; metrics: `metric`,
`datapoint`, `resource`, `scope`), the quantifier, count and expression
agreeing, a single-escaped `\b` refused in OTTL (it is correct RE2), the
parse with the converters-only parser runs use, and the regex's compile. A
problem's message is exactly the rule error a run gives for it, so Save and a
run read alike: a parse error after "OTTL syntax error: ", a regex's after
"Invalid regex: ", anything else in its own words.

`pkg/ottlassert.Lint`, a lint of conditions, statements and value
expressions with the editors registered too, is kept with its tests, but no
route calls it, and Save never uses it: it accepts editors, which a run can't
evaluate.

### `POST /ottl/v1/lint`

The platform's public API's OTTL lint: texts parse-checked against one
context, never run.

```json
{"context": "log", "conditions": ["severity_number >= 17"],
  "statements": ["set(attributes[\"env\"], \"prod\")"], "valueExpressions": ["body"]}
```

One to 200 texts in all, each at most 8,192 characters. The answer is
`{ottlVersion, items}`: one `{kind, index, valid, error?}` per text
(`condition`, `statement` or `valueExpression`, its place in its own array),
the conditions first, then the statements, then the value expressions. It
never echoes a text. Each text gets evaluate's guards first (8,192 bytes,
nesting of 12, a single-escaped `\b`), then the parse with the standard
functions, editors included (`pkg/ottlassert.NewLinter`); a parse error
follows "OTTL syntax error: ".

### `GET /health`

Unauthenticated: `{"status": "ok", "ottlVersion": "v0.162.0"}`.

There is no `GET /ottl/v1/functions`: 404 with the secret, 401 without.

## Limits

Each evaluate, validate and lint request's work runs in a **child process**
of the same binary (`evaluate-child`, `validate-child`, `lint-child`): its
own process group, an empty environment but `GOMEMLIMIT=640MiB` and
`GOMAXPROCS=2` (each child is a whole Go runtime: few threads), and on Linux `oom_score_adj` 1000, so the
kernel kills it first when memory runs out, and SIGKILL when serve dies
(`Pdeathsig`), so no child outlives it. A Go regexp call and OTTL's parser
can't be interrupted; a process group can be killed whole. The in-flight caps
may be lowered, never raised: compose's `pids_limit` counts threads, and is
sized for serve and 4 + 8 children at once. Compose gives serve itself
`GOMAXPROCS=4`, so its own threads don't grow with the host's CPUs; the
children don't inherit it.

- **Evaluate:** a 20 s deadline checked inside the child (before each rule
  and document, every 256 records, every 4,096 candidate positions of the
  text matcher, every 64 KiB of the scans); the group is killed at 25 s. Each
  rule left without a result fails "Not checked: the rules took longer than
  20 s to check." (or "…ran out of memory." when the kernel or the Go runtime
  killed the child for memory). The rules finished keep their results.
- **Validate:** killed at 2 s: `valid: false`, "The condition is too complex
  to check." (or "The pattern …", "The expression …": the field it was
  checking).
- **Lint:** killed at 10 s; each text it hadn't reached is `valid: false`,
  "Not checked: the expressions took too long to check." (or "…ran out of
  memory."). 200 texts nested 12 deep parse in about half a second.
- **In flight:** 4 evaluations and 8 validations, lints sharing the
  validations' slots; a request waits 5 s (1 s) for a slot, taken before its
  body is read, then gets 503 `evaluator_busy`. The slot is freed only once
  the child is reaped.
- **Sizes:** an evaluate body of 36 MiB, a validate body of 64 KiB, a lint
  body of 10 MiB (200 texts of 8,192 characters, escaped); an output
  of 10 MiB decoded; a log of 262,144 characters; 200 rules; each pattern,
  condition and expression 8,192 bytes; OTTL nesting 12; past 1,000,000 JSON
  objects in the output, each OTTL rule fails "The output is too large to
  check with OTTL rules." while text and regex rules run.

## Configuration

`serve` reads its settings from the environment; the children get none of
it (compose's `GOMAXPROCS=4` is serve's alone).

| Variable | Default | |
|---|---|---|
| `OTTL_EVALUATOR_SECRET_FILE` | (required) | The secret's file: at least 32 bytes after trimming. |
| `OTTL_EVALUATOR_SECRETS_PREVIOUS_FILE` | none | Secrets still accepted during a rotation, one per line. |
| `OTTL_EVALUATOR_PORT` | 8003 | |
| `OTTL_EVALUATOR_HOST` | every interface | An IP address to listen on. |
| `OTTL_EVALUATOR_MAX_EVALUATIONS` | 4 | 1 to 4: may be lowered, not raised. |
| `OTTL_EVALUATOR_MAX_VALIDATIONS` | 8 | 1 to 8: may be lowered, not raised. |
| `OTTL_EVALUATOR_MAX_EVALUATE_BODY_BYTES` | 37748736 | May be lowered, not raised. |
| `OTTL_EVALUATOR_MAX_VALIDATE_BODY_BYTES` | 65536 | May be lowered, not raised. |
| `OTTL_EVALUATOR_MAX_LINT_BODY_BYTES` | 10485760 | May be lowered, not raised. |
| `OTTL_EVALUATOR_MAX_OUTPUT_OBJECTS` | 1000000 | May be lowered, not raised. |

The secret is read from a file, never from the environment: `serve` makes
itself non-dumpable (`PR_SET_DUMPABLE`, Linux) before reading it, and refuses
to start without a secret of 32 bytes or more, with `OTTL_EVALUATOR_SECRET`
set, or with a secret's text in any environment variable. Only the secrets'
SHA-256 digests are kept, compared in constant time with every secret. A
setting that doesn't parse refuses the start. Logs are JSON on stdout: each
request's method, route pattern, status and duration, never a body, a rule, a
message or a snippet. `GET /health` logs nothing: probes and the platform's
health monitor call it every few seconds.

## Development

**Go 1.26.9**, as `go.mod` says (`pkg/ottl` has needed Go 1.26 since
v0.160.0), and `GOTOOLCHAIN=local` for every Go command, so Go never
downloads another toolchain. The checks, from this directory:

```bash
export GOTOOLCHAIN=local
go vet ./...
gofmt -l .            # prints nothing
go mod tidy -diff
go mod verify
go test -race -count=1 ./...
```

`TestOTTLVersionIsTheCatalogueDefault` reads `../../catalog/`, so the tests
run inside the repository's checkout, not from this directory alone. The
server's tests run their child processes from the test binary itself
(`internal/server/main_test.go`'s `TestMain`). `github.com/getkin/kin-openapi`
is a test-only dependency (the conformance test); no other file may import it.

Run the service:

```bash
GOTOOLCHAIN=local go build -o ottl-evaluator ./cmd/server
OTTL_EVALUATOR_SECRET_FILE=/path/to/secret ./ottl-evaluator serve
```

The license check, and its self-test:

```bash
./scripts/check-licenses.sh        # go-licenses v2.0.1 against ../../scripts/license-policy.json
./scripts/check-licenses.test.sh
```

The check builds `go-licenses` for this machine and scans the module for
both platforms the image is built for, linux/amd64 and linux/arm64 (its
report and `go list -deps` under each `GOOS`/`GOARCH`, `CGO_ENABLED=0`),
whatever machine runs it: `klauspost/cpuid/v2` (MIT), for one, is in the
amd64 build only. Every module the binary is built from must carry a license
on the policy's `allowed` list, but for the two MPL-2.0 modules OTTL brings,
named with their versions in its `goModules` (`hashicorp/go-version` v1.9.0
and `hashicorp/golang-lru` v1.0.2): a new version of either, or another
MPL-2.0 module, fails until it is reviewed and named. CI's `ottl-evaluator`
job runs all of the above, and fails on a skipped test.

## The image and the stack

The `Dockerfile` builds a static binary on `golang:1.26-alpine` and runs it
on distroless `static-debian12:nonroot` (uid 65532), both pinned by digest;
the build context is this directory. The binary's subcommands: `serve` (the
default), `healthcheck` (the container's health check: there is no curl),
`evaluate-child`, `validate-child` and `lint-child` (serve's children) and
`selfcheck`.

The root `docker-compose.yml` runs it as `ottl-evaluator`, locked down: a
read-only root, no capabilities, `no-new-privileges`, `mem_limit: 3g`,
`pids_limit: 256` (threads: serve and its 12 children at once peaked at
118, and at 117 with serve at `GOMAXPROCS=4`), `stop_grace_period: 45s`,
`GOMAXPROCS=4` for serve, the secret as a compose secret
(`docker/ottl-evaluator/development-secret`, development only), alone on its
own internal network `ottl-evaluator`, which the API joins. Its forwarder,
`ottl-evaluator-forward`, publishes it on the host's `127.0.0.1:51238` for
the API run natively (`npm run dev:services` starts both and waits for its
health). Check a running container from the inside with:

```bash
./scripts/check-container.sh [docker compose options, e.g. -p <project> -f <file>]
```

It runs `ottl-evaluator selfcheck` in the container (its user, capabilities,
read-only root, no route out, no secret in its environment, serve
non-dumpable, a child that raises its `oom_score_adj`), then the forwarder's
checks. The "no route out" checks pass by failing: on an internal network
Docker drops the packets, so each dial (1.1.1.1:443, 8.8.8.8:53) and the
lookup of `example.com` ends at its 3 s timeout. So they come after a
positive control, which must pass: the evaluator's own service name,
`ottl-evaluator`, resolves through Docker's DNS to the container, and
serve answers there. An external lookup that then fails fails because the
outside is blocked, not because DNS doesn't work at all.
