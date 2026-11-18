# Go conventions

**Source:** D11a's plan (its Global Constraints and Preflight rulings 4,
6 and 18) and its execution rulings 22 to 29; ADRs 0019, 0020 and 0026.
*Amended by D15a* (2026-10-11; its plan's Preflight rulings 1, 3 and 13):
a second Go service, and each service's own Go version; its Task 3
follow-up (the controller's Ruling 34) marked the parts that are the opamp-server's only, and said
where the evaluator differs. *Amended by D16a* (2026-10-12; its decision
22, Task 1): the opamp-server's Go is 1.26.9, as the evaluator's; and
(Task 11) the fleet model's rules: composite keys and the direct
organization cascade (Preflight rulings 2 and 3), the lock order (Rulings
34 and 38), the targetless `on conflict` (Ruling 32), goose's statement
splitting, caches with staleness bounds (decision 5), and migration
numbers in tests (Preflight ruling 4). *Amended by D26* (2026-10-25; its
decisions 26 and 40): the opamp-server left for its own repository,
`github.com/telflo/opamp-server`, with its rules. Its sections here (the
SQL and migration rules, its toolchain, its stores and caches, its tests'
database harness and the bootstrap's check) moved to that repository's
`CONTRIBUTING.md`, which is where they are kept now; this file keeps the
OTTL evaluator's.

The Go in this repository is one service, the OTTL evaluator
(`services/ottl-evaluator`, D15a), its own module, its CI job written as if
it were its own repository; its `README.md` repeats the rules a contributor
meets first. The opamp-server (D11a), whose rules these began as, has its
own repository since D26: its rules are its `CONTRIBUTING.md`.

## Toolchain and checks

- **The evaluator's `go.mod` names its own Go, and `GOTOOLCHAIN=local` for
  every Go command**, in CI (its job's `setup-go` reads its `go.mod` with
  `go-version-file`), in the scripts, in the image and locally. Without it,
  a dependency that asks for a newer Go makes the `go` command download
  one, and the build silently stops being the one CI checked. Its `go` line
  changes only by a decision of its own: **Go 1.26.9** (D15a decision 29,
  Preflight ruling 1): `pkg/ottl` has declared `go 1.26.0` since v0.160.0,
  so the evaluator can't build on 1.25. Its image builds on
  `golang:1.26-alpine`, pinned by digest. (The opamp-server, in its own
  repository, names the same Go today.)
- **`gofmt -l .` prints nothing and `go vet ./...` is clean.** CI fails
  otherwise.
- **`go test -race`**, always: CI runs nothing else.
- **No dependency the spec doesn't name**, and every one passes the license
  check (ADR 0019): `scripts/check-licenses.sh` runs `go-licenses` v2.0.1
  over the whole module (`./...`, leaving out the module's own packages,
  which carry no license until they are published), against the platform's
  `scripts/license-policy.json`. It builds `go-licenses` natively and scans
  linux/amd64 and linux/arm64, the image's platforms, whatever machine runs
  it (a module only one of them pulls in, such as `klauspost/cpuid/v2` on
  amd64, is checked too). A license it can't classify fails too.
  `scripts/check-licenses.test.sh` shows the check failing on a GPL-3.0
  fixture module. The check also reads the policy's `goModules`: an MPL-2.0
  module passes only when named there at the version the build uses
  (`hashicorp/go-version` v1.9.0 and `hashicorp/golang-lru` v1.0.2, which
  OTTL brings; ADR 0019, amended by D15a), and its self-test shows another
  version and an unnamed module failing.

## Time

**Time comes from an injected clock**, `func() time.Time`, as the platform's
rule says for TypeScript (D11a decision 17): never `time.Now()` inside a
handler. `main` passes `time.Now` only to the evaluate child, whose soft
deadline it reads (`cmd/server/main.go`); `serve`'s clock, the logs'
(`server.Options.Clock`), is `time.Now` by `server.New`'s default
(`internal/server/server.go`); tests pass their own. The evaluator stores
nothing: the only times it reads are its logs' and the child's deadline.

## What is never written down

**No secret, `Authorization` header, YAML, request or response body, or URL
that can carry a password** goes into a log line, an error message, a span
attribute, a span status or a span event. In practice:

- an error names the variable or the field, never its value;
- a request's log line and span name the route's pattern, never the path
  or the query; a method that isn't a standard one is `_OTHER`;
- a panic is logged by its value's type, never the value;
- an error that could quote a telemetry endpoint isn't logged.

Secrets are compared as SHA-256 digests with `subtle.ConstantTimeCompare`,
against every accepted secret with no early exit
(`internal/server/secrets.go`). A test reads the package's source to hold
that no other comparison touches a secret (`constant_time_test.go`, ported
from the opamp-server's).

Tests hold these rules by capturing what the server logs and records, and
asserting the absence of the secret and the YAML.

## Code shape

- **`main` only dispatches** subcommands. Each takes its context, the
  environment as `func(string) string` and its log's writer, so tests run
  it in-process. `serve` is wired by hand, with no DI container.
- **Logs are `log/slog` JSON on stdout**, never a file: the distroless
  image runs as a non-root user that can't write beside the binary
  (Preflight ruling 7).
- **The API's contract is an OpenAPI file**, `openapi.yaml` at the
  evaluator's root. The conformance test (kin-openapi,
  `internal/server/conformance_test.go`) sends every documented request
  through the real handler, validates request and reply against the file,
  and fails on a registered route the file doesn't document. A new route is
  documented in the same commit. kin-openapi is a test-only dependency.

## Tests

- **No test skips, and CI fails on any test-level skip**: it runs `go test
  -json` and fails on a `skip` that names a test. A package with no test
  files also reports a skip; that one doesn't count. The evaluator's tests
  need no database.
- **The Go suite runs alone**: its tests start real child processes.
- **A security-bearing test shows that it fails when its behaviour breaks.**
  Usually that is a deliberate break, made and undone in a scratch copy and
  recorded in the deliverable's ledger. Where a check is itself a scan
  that a break must fool, **the break becomes a permanent detector test**:
  a test that applies the break and asserts the real check, through the
  same helper, sees it (Ruling 22). For example,
  `TestTheConstantTimeScanSeesAnEarlyReturnAndAPlainComparison` does that
  for the source scan.
- **Timing tests bound operation counts**, never milliseconds.
