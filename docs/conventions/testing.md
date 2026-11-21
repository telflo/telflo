# Testing strategy

<!-- naming-check: allow-telflow-references -->
<!-- This document quotes the banned misspelling when naming the CI gate that
     bans it. See docs/conventions/naming.md. -->

## Why this section is load-bearing

**The team is very small and cannot manually test frequently.** There is no
QA pass and no one clicking through the product before a release. The test
suite is therefore not a safety net under manual testing — **it is the only
regression detection that exists.** A behavior without a test is a behavior
nobody will notice breaking.

This has a direct consequence for how tests are written. It is not enough to
cover the lines a method executes on its happy path. Before writing a
method, state its contract: what must be true when it returns, what must
never happen, what it does with input it was not designed for. **Test the
contract, not the implementation** — tests coupled to internals break on
every refactor and get deleted, which is worse than having none.

## Test design checklist

Every unit of behavior gets deliberate consideration of each of these. Not
all apply to every method; skipping one should be a decision, not an
oversight.

| Dimension | Ask |
|---|---|
| Happy path | Does it do the thing, with realistic input? |
| Boundaries | Empty, one, many; minimum and maximum lengths; zero and negative; first and last page |
| Error paths | Every `throw` and every error return has a test that reaches it |
| Invalid input | What a caller should never send, but will |
| Security invariants | Can another organization reach it? An unauthenticated caller? A member with the wrong role? |
| Idempotency | Called twice with the same input — is the second call safe? |
| Ordering and concurrency | Where two requests can interleave: double-submit, token reuse, concurrent publish |
| Persistence | Does what was written actually come back, including after a round-trip through the repository? |
| The bug you would file | The one case that, if broken, someone would report. Write that test first |

## Local setup

From `telflo-core/`, `cp .env.example .env` once, before running tests
locally. Every package's `vitest.config.ts` loads that file via a shared
`setupFiles` entry (`vitest.setup.ts` at the workspace root, `telflo-core/`) that calls `process.loadEnvFile()`,
wrapped so a missing file is not an error — so `npm test` does not require
`TELFLO_DATABASE_URL` (or any other `TELFLO_*` variable) to be exported by
hand. The API process itself does the same on boot, in `settings.ts`. `.env`
is gitignored; real deployments inject environment variables directly and
have no `.env` file, which is why absence is normal rather than an error in
both places.

**Tests never touch the development database.**
- **Where the suite runs.** It runs against `<dev database name>_test`,
  which is `telflo_platform_test` locally, or against `TELFLO_TEST_DATABASE_URL` if
  that is set.
- **The guard.** If the test database's name doesn't end in `_test`, the
  suite refuses to run, so a test can never empty a real database.
- **Created automatically.** The vitest `globalSetup`
  (`telflo-core/vitest.global-setup.ts`) creates and migrates the test
  database once per run. `npm run db:migrate` is for the development
  database only. The Postgres user must be allowed to create databases.
- **New packages.** A package whose tests touch the database must declare
  `globalSetup: ["../../vitest.global-setup.ts"]` next to its
  `setupFiles`.
- **Settings.** `vitest.setup.ts` blanks the optional settings a development
  `.env` changes (`TELFLO_COOKIE_SECURE`, `TELFLO_TRUST_PROXY_HOPS`,
  `TELFLO_WEB_ORIGIN`, the two token lifetimes and
  `TELFLO_SMTP_ALLOW_INSECURE`), so tests run with production defaults. A
  test that needs another value passes it to `loadSettings` explicitly. It
  also blanks the relay's login and CA file (`TELFLO_SMTP_USERNAME`,
  `TELFLO_SMTP_PASSWORD`, `TELFLO_SMTP_CA_FILE`), `TELFLO_SALES_INQUIRY_TO`
  and `TELFLO_COOKIE_POLICY_URL`, and **pins the site's settings to the
  SaaS's values**: registration `open`; the playground, anonymous validate
  and public flows on; Settings › Notifications on
  (`TELFLO_EMAIL_NOTIFICATIONS`); the sales inquiries off; the Terms at
  `2026-01-01` with `/home/terms-of-service` and `/home/privacy-policy` (the
  API's tests import it as `TEST_TERMS_VERSION`,
  `apps/api/src/testing/site.ts`); and `TELFLO_SMTP_TLS=none` (Mailpit). So
  the API and CLI tests of the switched routes keep their behavior whatever
  a developer's `.env` says, and a test of the open-source defaults passes
  its own settings. The two `TELFLO_OPAMP_MANAGEMENT_*` settings are
  required, so it can't blank them: it sets placeholders instead, an address
  that never resolves (`http://opamp-server-placeholder.invalid`) and the
  fake's public test secret, so a developer's own opamp-server never
  receives a test's publications. No client is built from them.
- **The opamp-server.** Every test file that builds a server calls
  `useFakeOpampServer()` (`apps/api/src/testing/opamp-server.ts`) at its
  top, outside any `describe`, and passes `opamp.client` as `buildServer`'s
  `opampServer`. That starts one OpenAPI-checked fake per file
  (`testing/fake-opamp-server.ts`, checked against
  `vendor/opamp-server/openapi.yaml`, the pinned release's); its `afterAll`
  closes it, and fails the file if the platform sent a request, or the fake
  a reply, that broke the contract and no test read the violation. Tests
  that inspect what the opamp-server received read `opamp.fake`.

## Layers and tooling

| Layer | Approach |
|---|---|
| Pure logic | Plain functions, dependencies injected, no database |
| Repositories | Integration tests against a real Postgres in Docker |
| **Cross-tenant isolation** | **Generated from a resource registry** — every org-owned resource automatically gets a test asserting organization B cannot read or write organization A's row |
| Contracts | Zod schemas are the single source; a contract change that breaks a consumer is a compile error |
| API | Route-level integration tests using the real contract types |
| Security | Explicit tests for refresh rotation, reuse detection, session revocation, CSRF, token expiry |
| Schema boundary | Integration test asserting zero foreign keys leave the `opamp_server` schema (the opamp-server's, in its own repository); the stack's smoke test shows neither side's role can connect to the other's database |
| Naming | CI grep failing the build on `telflow` in any casing |
| Browser | Playwright in Chromium, Firefox and WebKit (`npm run test:e2e`, files `telflo-core/e2e/*.e2e.ts`). Its own APIs and web dev servers, in two pairs ("Browser tests on two pairs" below: the open-source defaults on API 28080 and web 23100, the SaaS's values on 28081 and 23102), and its own database (`telflo_platform_e2e_test`), so it runs alongside vitest and never touches the development servers. Its API's opamp-server is the same fake, run as a Playwright web server on 127.0.0.1:28085 (`e2e/start-fake-opamp-server.ts`; no Go in the browser tests): each contract violation goes to stderr and a file, and global setup's teardown fails the run on any. The fake also listens on a test-only control port, 127.0.0.1:28084 (`E2E_OPAMP_CONTROL_PORT`), through which the tests enroll collectors and set their last seen, drift state and reported attributes and addresses, record their errors (a pin is made through the contract's routes; there are no imports, and an imports path is a plain `404`), and seed a fleet's token history in number, for its paging, as they drive the collector tester through its control route on 28088; the E2E API never calls it. The API sends some of its calls to the opamp-server after the response (an organization's registration, a deleted configuration's clean-up, the removal of a snapshot whose publish failed to record), so the E2E API (`e2e/start-api.ts` only, never the API itself) counts its after-response jobs (`e2e/support/after-response.ts`'s counting runner) and answers the count on `/__e2e/after-response-pending`; the teardown asks it, at most 50 times, until it reads 0, and only then reads the violations file, failing the run if the jobs never settle. Users are seeded in the database; expiry is simulated by minting an expired access token, never by waiting |

## Registering a resource (the cross-tenant suite)

`apps/api/src/tenancy/resource-registry.ts` declares every application table
once. `apps/api/src/tenancy/cross-tenant.integration.test.ts` generates the
isolation tests from it, so nobody writes them per resource, and it fails
when the database has a table the registry doesn't, or when a table's
row-level security doesn't match its entry. A migration that adds a table
therefore adds an entry in the same change:

- **`global`**, with a `reason`, for a table no organization owns (a
  user's, a session's, or a product-wide one every organization reads and
  only product admins write, as `flows`, `test_templates` and
  `test_regex`). The reason is for the reviewer who asks why it isn't
  scoped.
- **`system`**, with a `reason`, for a table only the product's own
  administration reaches: no organization, no row-level security, and no
  `SELECT` for the API's role, which reaches it only through the
  product-admin functions in the SystemRepository. `user_feedback` (the
  API's role may only insert) and `user_deletion_records` (nothing) are the
  first. The suite checks that each has no row-level security, that the
  system entries are exactly those two, and that the API's role holds no
  `SELECT` on either and is refused one (42501); the db package's
  `schema.integration.test.ts` pins each one's privileges, and
  `tenancy/product-admin-functions.integration.test.ts` shows every
  product-admin function refused under any other context. A new `system`
  table joins `applicationTables` (`packages/db/src/testing.ts`) and that
  test's privileges as well.
- **`organization`**, for a table that belongs to one organization. First
  add it to `organizationScopingColumns` in `tenancy/organization-scope.ts`
  with its scoping column, so its repository can go through the scope. Then
  the entry gives:
  - `table`, `scopingColumn` and `hasRowLevelSecurity`, matching the
    migration;
  - `keyColumn`, the column the repository addresses a row by;
  - `seed(ownerDb, organizationId, userId)`, which inserts one row in that
    organization as the owner, with whatever the row references, and returns
    its key. The organization is a live group organization, and `userId` its
    member as whom the suite acts in A's context: a row visible only to its
    person (a test file) is seeded as theirs;
  - `operations(transaction, context)`: `list`, `read(key)`, `update(key)`
    and `remove(key)`, each over the **real repository** bound to the
    transaction and context, never over raw SQL. Where the repository has
    no multi-row read (the tenant row's single `findActive`), `list` and
    `read` use the organization scope directly, so a lost filter shows
    other organizations' rows every time rather than by chance;
  - `removeUnsupported`, a reason, instead of `remove`, when the
    repository removes no row on its own, and `updateUnsupported`, a reason,
    instead of `update`, when it changes none (a test run, which only the
    dispatcher's functions change). The type requires one or the other of
    each;
  - with row-level security, `rowToInsert(ownerDb, organizationId)`: a row
    naming that organization that would be valid but for the policy.

For every `organization` entry the suite checks that organization B's
context can't list, read, update or remove A's row through the repository
(re-reading A's row as the owner), and that A's own context can. For an
entry with `removeUnsupported`, the two remove tests are replaced by one,
`has no remove: <reason>`, which checks that the operations have none, and
likewise `has no update: <reason>` for `updateUnsupported`. With
row-level security, it also checks, in raw SQL as the application role in
B's context, that `select`, `update` and `delete` reach none of A's rows and
that an insert naming A fails with 42501. When a new kind of table doesn't
fit these operations, change the generator with it: the generator is ours.

**A child table** (`configuration_versions` was the first) belongs to a
parent row that belongs to the organization. Register it as above, and also:
- give it its own `organization_id`, and a composite foreign key
  `(parent_id, organization_id)` to the parent's `unique (id,
  organization_id)`, so a child can never name another organization's
  parent. That key gets its own database test: a child naming a parent with
  another organization's id is refused (23503), even as the owner. The
  generated suite can't show it, since the policy refuses B's insert first;
- `seed` creates the parent (and whoever created it) as the owner, then
  the child;
- when the repository reaches a child only through its parent (a
  `find(parentId, childId)`), the operations must still hand it A's real
  ids, so that its own filter is what refuses B. Looking the parent up from
  the key in B's context would find nothing, and the repository would be
  asked about nothing. `seed` records `childId → parentId` in a
  module-level `Map`, and `read` and `update` pass both;
- where the repository has no list (a child is read one at a time), `list`
  uses the organization scope directly, as the tenant row's does;
- when a child goes only with its parent, declare `removeUnsupported` with
  the reason.

**A table with a composite key into a child table**
(`configuration_version_selections`, which names a configuration and one of
its versions, was the first) is registered as a child table is, and also:
- the child gets a `unique (id, parent_id, organization_id)` as the target,
  and the table's foreign key names all three columns `(child_id,
  parent_id, organization_id)`, beside its own `(parent_id,
  organization_id)` to the parent. So a row can name only a child of its
  own parent in its own organization. Each key gets its own database test,
  as the owner: a row naming another organization's parent is refused
  (23503), and so is a row naming a child of **another parent of the same
  organization**, which a key on `child_id` alone would accept. The
  generated suite can't show either;
- the composite foreign key needs an index of its own, led by the child's
  id, and any column naming a person (`user_id`) one too, so a cascade
  doesn't scan the table;
- when the repository addresses a row by something other than its key (a
  person and a parent, not an id), `seed` records everything the
  operations need, `key → { userId, parentId, childId }`, in a
  module-level `Map`, and `read` and `update` pass A's real values;
- an `update` that is an upsert must read before it writes. In B's
  context the scope makes the insert name B, so an upsert naming A's
  parent fails its foreign key (23503) instead of touching nothing, and
  the generated "can't update A's row" expects no throw. Read the child
  through the scope and its live parent first, and write nothing when it
  isn't there.

## Workspace test parallelism

The workspace-root `npm test` and `npm run test:coverage` (run from
`telflo-core/`) run with `--maxWorkers=1
--minWorkers=1`. This is deliberate, not a default left over from scaffolding.

Every package's `vitest.config.ts` sets `fileParallelism: false`, but that
only serializes test *files within that package*. vitest still runs the
workspace's *projects* (`packages/db`, `apps/api`, ...) in parallel by
default. Once more than one project has integration tests that `truncate`
the same shared Postgres tables — which happened the moment `apps/api`
gained its first integration suite alongside `packages/db`'s — two projects'
`beforeEach` truncations and inserts race against each other. The failures
are not deterministic: which assertion trips depends on which project's
truncate lands mid-test in the other. A bare `npm test` was observed to
fail a different 3–5 tests on each of several consecutive runs, while every
package's own `npm test -w <package>` was consistently green.

A flaky root suite is worse than no gate: it trains everyone to re-run until
green, which is exactly the habit that lets a real regression through. Since
the root suite is what CI runs (`test:coverage`'s command, in four
parts), the workspace runs single-worker so the whole run is as
serialized as each package already claims to be.

**Scaling path:** if a single-worker workspace run becomes too slow as more
integration suites are added, do not raise the worker count back up — that
reintroduces the race. Give each vitest project its own database instead
(e.g. a second Postgres container or database per package), so projects can
run in parallel again without contending on the same tables. The shared
database is the actual constraint; the worker count was never the problem,
only the symptom.

Tests have their own database, separate from development, but it is
still one database shared by every project. So the single-worker rule
still holds. The next step is one database per project.

## The collector image

telflo's collector image (`docker/collector-image/`: otelcol-contrib and the
OpAMP supervisor, `ghcr.io/telflo/telflo/collector:<version>`, a package of
its own) has two tests that need neither Docker nor the network: `bash
docker/collector-image/entrypoint_test.sh` (the supervisor's configuration
written from the environment) and `bash
docker/collector-image/build-collector-image_test.sh` (the build script's
checks, through its `--dry-run`, and its `--build-oci` and `--push-oci` with
a `docker` stand-in and the real crane: "The publish scripts" below).

To build it locally, for one version the catalog offers and the Docker
engine's platform, loaded into the local engine:
`scripts/build-collector-image.sh 0.162.0` (or `--platform linux/amd64` /
`linux/arm64`). The script reads the version's URLs and sha256 from
`catalog/distributions/otelcol-contrib.json`, refuses an unknown or
deprecated version and any value that isn't the catalog's format, and
builds through the Docker-driver builder `desktop-linux` (`BUILDX_BUILDER`
overrides it; a `docker-container` builder is refused, since it would pull
`moby/buildkit`). A build downloads the Debian base, apt's `curl` and
`ca-certificates`, and the two binaries from GitHub. **Publishing is the
collector workflow's** (`.github/workflows/collector.yml`;
`docs/releasing.md`), on a maintainer's yes: `--build-oci <dir>` builds both
platforms once, with their attestations, into an OCI archive, and
`--push-oci <dir>` copies those same bytes ("The publish scripts" below).
There is no `--push`, `--replace` or `scripts/publish-collector-images.sh`
(the workflow's `all` builds every offered version).

## The chart's render tests

The platform's Helm chart (`charts/supervisor-collector/`) is tested by
`bash charts/supervisor-collector/tests/render-tests.sh`: real `helm
template` and `helm lint --strict` renders, offline, needing only `helm` on
`PATH` (no registry, no cluster, no credentials, never `--debug`). Every
`HELM_*` variable is unset, and Helm's homes, `HOME`, `DOCKER_CONFIG` and
`KUBECONFIG` are in a temporary directory removed on exit; it runs on
macOS's bash 3.2. Each case prints `PASS` or `FAIL` and its name, never a
value or Helm's output (an error's text can hold a value); a failing render
is its case's `FAIL` and the script goes on; it exits 1 when any case
failed.

**Why render tests and not `helm lint`**: Helm 4's `lint` only logs a
template's `fail`, and passes with no values at all, so only a render
proves a guard. The cases: eight base cases (mounts' `readOnly`,
`collectorEnv`, the token Secret, a render without values); every guard
alone, failing with its own message and no value in the output; the
names, with and without
`fullnameOverride`, for the Agent and the Cluster (every object, reference
and `hostPath` named after the override, none named `telflo-node` or
`telflo-cluster`), two fleets' overrides naming disjoint sets, a gateway
ignoring one; names, a namespace and `collectorEnv` keys that are YAML
words (`on`, `yes`, `null`, `~`, `ON`) kept as strings after a YAML 1.1
parse by Helm's own `fromYaml`, in a throwaway chart the test writes into
its temporary directory (no PyYAML, no `kubectl`); `checksum/token` on
every workload, equal to the sha256 of the rendered token Secret,
different for two tokens and equal across endpoint, image, `collectorEnv`,
namespace and release changes, and `checksum/collector-env`; each pod's
identity variables, its mounts paired with its volumes and claims, and each
ClusterRole's rules exactly (`HOST_IP` = `status.podIP` and the volume
slug pinned, so changing them is deliberate); the image's
`repository:tag`; `helm lint --strict` for each role with values.

Run them after any change under `charts/supervisor-collector/`. A chart
change is a new chart version (a published version is never overwritten),
with the contracts' `DEFAULT_HELM_CHART_VERSION` bumped in the same commit;
`scripts/publish-chart.sh` runs these tests before it packages. They are in
the full suite's static gates (so in the release workflow's `static` job),
and the collector workflow runs them with the image it built.

## The publish scripts

The platform's images and charts and the collector images are published by
the release and collector workflows (`docs/releasing.md`), each publishing
step one call of these scripts. Each is split into a build into a file and a
push of exactly that file: `--build-oci`/`--push-oci` for the images,
`--package`/`--push-package` for the charts, and `--push` refused, naming
them. Each has a self-test that reaches no registry but a throwaway
`registry:2` on 127.0.0.1, the image `scripts/release/tools.lock` pins,
already local by its digest (`scripts/release/test-registry.sh` starts it,
with a login made at run time when `htpasswd` is there; without crane,
docker or that image, the cases needing it print `SKIP`). Each puts refusing
stand-ins for `docker-credential-osxkeychain`, `docker-credential-desktop`
and `docker-credential-ecr-login` first on `PATH` (each logs its first
argument, never reads its input, exits 1), and fails if one is called. Run
each after any change to its script; `scripts/gates/static.sh` runs them
all:

- `bash scripts/publish-chart.test.sh` (`scripts/publish-chart.sh`): the
  real Helm lints, renders and packages; a `helm` wrapper first on `PATH`
  records `push` (the argv the real binary would get) and a `crane` wrapper
  the registry's reads, each answering per case or handing the call to the
  real binary. Two cases run the real crane and `helm push` against
  `127.0.0.1:1`, where nothing listens, proving the argv offline;
  `--push-package` runs for real against the throwaway registry. The script
  publishes only what is committed, so every case runs it from a committed
  throwaway git repository holding what it reads (itself, the charts, the
  contracts' `helm.ts`; for `telflo` the PIN, the PIN check and the files
  its render tests read): the checkout's own state never decides a case. Its
  sections: the refusals before anything runs (exit 2: `--push`, a registry
  that isn't `ghcr.io` or loopback, `TELFLO_HELM_CHART_REFERENCE` set); the
  dry run's checks in order and its exact push; the registry's answers
  (`crane manifest`: present refused, absent passed, anything else "can't
  tell"); `--package`; `--push-package` (that file compared, pushed,
  compared again; the same digest skipped, another refused, since `helm
  push` overwrites a version silently); a failing render test stopping it;
  what is committed, the caller's credential files, flagged inputs, the
  local git setup and git objects (below); the real binaries' argv;
  `telflo`'s row (the vendored chart's tree and version on HEAD's
  extraction); and never a login.
- `bash scripts/publish-platform-images.test.sh`
  (`scripts/publish-platform-images.sh`): a `docker` stand-in records
  every call and, for `--build-oci`, writes the OCI archive and metadata
  a build would (made offline by `test-registry.sh`'s fixture); a `crane`
  wrapper records every call. Its sections: the refusals; `--dry-run`;
  the version without the chart; `--build` (one image, the named builder,
  no output); `--build-oci` (both platforms, the attestations, the archive
  and its digest file; an existing one refused); `--push-oci` with the
  real crane against the throwaway registry (an absent tag copied and its
  digest read back equal to `<name>.digest`, an equal one skipped, a tag
  holding another digest refused with nothing copied, an archive without
  attestations refused for any registry but a loopback one); uncommitted
  inputs and HEAD's blobs; credentials; never a login.
- `bash docker/collector-image/build-collector-image_test.sh`
  (`scripts/build-collector-image.sh`, "The collector image" above): the
  arguments, the catalog's versions and values (an unknown or
  deprecated version, a value not in the catalog's format), the exact
  `docker buildx` argv of a local build, `--build-oci` and `--push-oci`
  on a committed copy of the image's inputs (the same rules as the
  platform's images, the repository always
  `ghcr.io/telflo/telflo/collector` or a loopback one: the old registry
  paths `ghcr.io/telflo/collector` and `ghcr.io/telflo/platform/…` can't
  be named), `--list-offered` (the workflow's `all`), and never a login.
- The release's own scripts, each with its self-test beside it in
  `scripts/release/`: `oci.sh` (the archives' checks shared by the push
  scripts: one index entry, both platforms, the labels, every blob's sha256,
  the image store's kind), `load-images.sh` (an archive's image for one
  platform, `--platform linux/amd64|linux/arm64`, else the engine's own,
  into the engine through a loopback registry, its image id compared with
  that platform's), `pull-back.sh` (a digest that differs fails),
  `verify-collector-artifacts.sh`, `release-notes.sh` (the same bytes for
  the same inputs), `build-compose-archive.sh` (exactly `deploy/compose`'s
  tracked files, modes kept), and `verify-tag.sh`.

**What is published comes from the commit itself.** The chart's test and the
images' tests each prove it from committed throwaway repositories (the
images' cases through `--build-oci`, the `docker` stand-in keeping the build
context it was handed); where a case is a refusal, the script refuses before
any `helm` or `docker` call, naming the path, flag or variable:
- **Credential files the caller names**: a
  `HELM_REGISTRY_CONFIG` or `DOCKER_CONFIG` (the image's test: `DOCKER_CONFIG`
  only) whose file is missing, can't be read, isn't JSON, isn't an object,
  has no `auths` object or an empty one, or has a `credsStore` or
  `credHelpers` key in any spelling (`CredsStore`, `credsstore`,
  `CredHelpers`), or an `AUTHS` key, is refused, its content (a canary)
  never printed; the valid baseline is `{"auths":{"x.invalid":{}}}`.
- **Files the repository ignores**: `.env`, `.DS_Store` and
  `build/x` in the chart's or the image's directory are not in the package
  or the build context.
- **The local git setup**: a local smudge filter and
  `core.autocrlf=true` change what `git archive` writes (the case checks
  that premise first); the pushed package and the build context still hold
  HEAD's blobs byte for byte (the chart's `Chart.yaml` aside: Helm rewrites
  it); inherited `GIT_*` settings are ignored.
- **Local git objects**: a `git replace` ref (its
  premise checked: `git cat-file` gives the replacement) still publishes
  HEAD's real blob; a tampered loose object (another blob's bytes, `git
  status` clean: the premise checked) is refused by the hash check.
- **What git status could miss**: an untracked input
  while `status.showUntrackedFiles=no`; an input flagged assume-unchanged
  or skip-worktree (the flag named).
- **What isn't a regular file**: a symlink or a
  submodule committed in the chart's or the image's directory.
- **Whose checkout**: a tree that isn't a git checkout,
  and a copy nested in another repository that ignores it (its git top
  level isn't its own).
- **The image's build arguments**: taken from HEAD's
  catalog, not a working-tree catalog `git status` sees as clean (an
  edit of the same size, its `ctime` ignored).

Run the publish scripts against GHCR only with `--dry-run`, and push only to
a throwaway loopback registry (the self-tests, the rehearsal). A push to
GHCR is the release or collector workflow's, on a maintainer's yes
(`docs/releasing.md`; `docs/conventions/security.md`, "The release
pipeline").

## The gateway's logs

`scripts/check-gateway-logs.sh` checks that the gateway's logs never hold a
quick-deploy link's secret. It runs the real `nginx:1.30-alpine` image
(`--pull never`: it must already be on the machine, as the gateway's base;
the script fails saying so otherwise) with the committed
`docker/gateway/default.conf`, unchanged, its upstreams' names pointed at
the container's own loopback (`--add-host`), where two stand-in servers
answer for the API and the web app. It sends a canary secret in every
spelling that reaches the route (encoded letters, doubled slashes, dot
segments, upper case, without `/api/`), in another path's query and in a
Referer, and asserts, with the upstreams up and then down (each answered
`502`): no access or error log line holds the canary; each such request's
access line is the redacted one and went where it goes in the stack; a
`/quick-deploy` path typed without `/api/`, in each spelling nginx routes,
is answered by nginx itself, `404` "Not found." with `Content-Type:
text/plain` (`/quick-deploy/x.html` and `/quick-deploy/tqd_x.js` among them,
which nginx's types would name `text/html` and `application/javascript`),
and the web stand-in, which counts its requests in a file of its own (never
a URL), receives none of them, while a web path holding `tqd_` elsewhere (an
asset's name) still reaches it; an ordinary request is logged as before,
query and Referer included; and an ordinary API request's failure is in the
error log (so the check can't pass on an error log that writes nothing). It
also sends an API token built at run time (never a literal in the file) in a
request line, any letter of its `tf_` percent-encoded once or not, and in a
Referer, and asserts, with the upstreams up (nginx's error log keeps a token
in a failed upstream's query, a recorded residue), that each is logged
redacted and still routed, that no log line holds the token, that a token
sent as an HTTP Basic user name (`curl -u`) leaves the user field `-`, and
that a `User-Agent` or an `X-Forwarded-For` holding one is logged
`[redacted]` while an ordinary `X-Forwarded-For` is logged as before. It
also sends a library link built at run time (`tll_` and 71 characters, never
a literal in the file) on a fresh container, with the upstreams up and then
down: in every spelling of its API path (encoded letters and slashes,
doubled slashes, dot segments, upper case, a trailing slash) and in an
organization's and a library file's path, each proxied to the API (`502`
with it down) and logged `GET /api/v1/library-links/[redacted]`; typed
without `/api/`, each spelling nginx's own plain-text `404`, the web
stand-in receiving none (`/library-links/tqd_x.js` among them, which checks
the locations' order and is logged with the quick-deploy line); a web path
holding `tll_` elsewhere still reaching the web app; and no access or error
log line holding the link. With the upstreams up only (nginx's error log
keeps a link in a failed upstream's query or Referer, a recorded residue), a
link in another path's query, any letter of `tll_` percent-encoded once or
not, is cut too; a Referer, a `User-Agent` or an `X-Forwarded-For` holding
one is logged `[redacted]`; and the library's own paths (`/library`,
`/product-admin/library`, `/api/v1/library-files…`) are logged as before. It
checks the public surface on a fresh container. Its section 5, the upstreams
up: every spelling of a path under `/api/public/v1` (seven `tf_` cases, a
validation pipeline's name in route 14's path raw, behind an encoded slash
and in the query, mixed case, runs of slashes, dot segments, the prefix's
letters and slashes encoded once or twice, the four dot-segment spellings
encoded twice or more, which nginx doesn't resolve and the API does, and
absolute-form request lines) reaches the API stand-in and is logged `"GET
/api/public/v1/[redacted] HTTP/1.1"`, in the image's main format; the body
limits, a body under each location's limit reaching the API and one over it
nginx's `413` (2 MiB on the configuration writes, `/validate` and
`/ottl/lint`, 8 MiB on `/test-runs`, 1 MiB on the other public paths), two
of the `413`s carrying the pipeline's name in route 14's path or the query,
each write logged `"METHOD /api/public/v1/[redacted]"`; no access or error
log line holding a `tf_` canary or the name; ordinary paths logged as
before. Its section 6, the upstreams down: the same spellings answered `502`
and route 14's oversized PUT `413`, each logged as the public line, no
access or error log line holding a canary or the name (every public location
logs crit and worse only), and an ordinary `/api/v1` failure still in the
error log. The container's include of `/etc/nginx/telflo/extra-routes.conf`
reads the compose stack's comments-only `docker/gateway/extra-routes.conf`
in sections 1–10. Its sections 9 and 10, upstreams up and down, send a
marker in the query of an organization's fleets paths and the configurations
list (a trailing slash or not), and in the slug or query of the published
flows' paths, in every spelling nginx routes there (runs of slashes, dot
segments, encoded letters, an encoded or doubly encoded slash, a `;`, `?` or
`#` decoded from the path), and check every line exactly: the fleets' and
the list's `"GET <path as nginx routes it> HTTP/1.1"`, the flows'
`/api/v1/published-flows` or `/api/v1/published-flows/:slug`, no access or
error log line holding a marker; another case logged the same; the
lookalikes (`…/published-flowsx/…`, `…/fleetsx`) and a configuration's own
paths logged as sent (the "query kept" canary is now
`…/configurations/c1/versions?limit=5`). Its section 11 starts a fresh
container whose include reads the chart's rendered snippet
(`charts/telflo/tests/expected/extra-routes.conf`, an exact `/` and a `^~
/home/` to a third stand-in; a render case holds helm's output equal to it):
`nginx -t` accepts it; `/` and every spelling under `/home/` reach the
stand-in; `/home` is nginx's 301; `/homex`, `/HOME/x` and the web app's own
paths still reach the web app and `/api/` the API; the access log's
redactions hold there; with the site down its paths answer 502 with no line
holding their marker; and without the snippet nginx doesn't start. Run it
from anywhere with `scripts/check-gateway-logs.sh` (no argument;
`CHECK_GATEWAY_LOGS_CONTAINER` and `CHECK_GATEWAY_LOGS_PORT`, default
`telflo-check-gateway-logs` and 50089 on 127.0.0.1, name its container and
port). It removes its container and its files at the end. It is in the full
suite's gates; run it after any change to `default.conf`.

**The smoke's quick-deploy steps** run, with the platform's collector image
on the machine (`ghcr.io/telflo/telflo/collector:<the catalog's default
version>`, built locally or pulled from its published package by whoever
runs the smoke: the smoke itself never pulls it; without it the install
steps are skipped, a `SKIPPED` step saying so), only when the API's
`TELFLO_PUBLIC_API_URL` is `http://gateway` (the gateway as a container on
the compose network reaches it); otherwise the smoke fails at that step,
naming the setting. Compose's default, `http://host.docker.internal:50080`,
would send a throwaway stack's Quick Deploy commands to whatever gateway
listens on the host's port 50080 (the default stack's). So a throwaway stack
for the smoke is started with it set, e.g.
`TELFLO_PUBLIC_API_URL=http://gateway docker compose -p
<project> up --build -d`. Its guards fail closed: every
search for the secrets (the logs', the bundle's, the headers', the files'
a check prints) tests grep's status, so one that can't be made (a missing
file, the secrets file among them) fails the run; and a failure prints a
diagnostic whole only when it holds no secret, no `tqd_` and no bearer's
shape, else redacted.

**The smoke and who may create organizations.**
A fresh database starts with the product admins' switch on, so an ordinary
account can't create an organization. On a throwaway stack
(`COMPOSE_PROJECT_NAME` set and not `telflo`, `telflo-dev` or
`telflo-platform`) the smoke checks
that refusal (`/me`'s `mayCreateOrganizations` false, 403
`organization_creation_restricted`), makes its account a product admin by
SQL, turns the switch off through `PATCH /api/v1/product-admin/settings`,
creates its organization, and turns the switch back on by SQL (its EXIT
trap too, if a run dies midway). On any other stack it changes nothing
and stops unless the switch is already off (the Product admins page).

**The smoke on S3.** The full gates run the smoke twice: on the local disk,
then on a throwaway stack started on the object store, `TELFLO_FILE_STORE=s3
docker compose -p <project> --profile s3 up --build -d` (`--build`: an older
API image ignores `TELFLO_FILE_STORE`). Each run sets
`TELFLO_SMOKE_FILE_STORE` (`local`, then `s3`), so a stack on the other kind
fails at once; on `s3` the smoke checks the object store holds the upload,
the run's output and a definition's input, and the API's volume doesn't hold
the upload. A throwaway S3 stack publishes the object store's
`127.0.0.1:51240` too, the port `npm run dev:services`' object store holds,
unless its compose copy remaps it. The smoke never reads the object store's
logs (they name the access key id).

**The smoke's Helm steps** run always, needing neither the collector image
nor a cluster, inside the Kubernetes fleet's block: the platform's fleet
steps' published version assigned to the Agent and the gateway, their Helm
facts read (`no-store`, no bearer), each install refused on the other fleet
type in its direction's words, the organization's "Public install links"
switch read on, a Helm values link made and downloaded from the host with no
session (`text/yaml; charset=utf-8`, attachment `values.yaml`, the public
route's headers), the file compared byte for byte with the contracts'
`helmValuesYaml` of the facts and its own token (printed in the API
container, the token passed by name), the switch turned off (the download
`403` in plain text, both kinds' create `409 public_install_links_disabled`)
and on again (a second download, its token not the first's, made from a
client container on the compose network: its `quick_deploy_link.downloaded`
audit row, read by the link's id through the stack's `psql`, must hold that
container's address (`docker inspect`), not the gateway's, so the API sees
the client behind the gateway, `TELFLO_TRUST_PROXY_HOPS` `"1"` with
`default.conf`'s `X-Forwarded-For`), the link revoked (`410`), and the API's
and the gateway's logs searched: neither the link's secret nor either token
in them, and exactly the block's four downloads (`200` twice, `403`, `410`)
logged by the gateway as `GET /api/v1/quick-deploy/[redacted]`, counted from
the logs read before the first (the quick-deploy steps' downloads, when the
install steps ran, are logged the same way). Two of the quick-deploy steps'
guards are inverted there: the values file holds the bearer by design, so it
is never searched for a bearer's shape and never printed; and each
download's token (each reveal seals a new text) joins the secrets file
before anything is compared or the logs are searched. The link's base is the
API's `TELFLO_PUBLIC_API_URL`, whatever it is (`qd_public_get` sends the
request to the gateway on the host, and `helm_client_get` to
`http://gateway` from its container), so these steps don't need
`http://gateway`; the quick-deploy helpers they share are defined before the
install steps, outside the image's condition. The Agent's facts are compared
exactly with the platform's chart
(`oci://ghcr.io/telflo/telflo/charts/supervisor-collector`, `0.1.0`), its
image repository (`ghcr.io/telflo/telflo/collector`) and its
`fullnameOverride`, the fleet id's first 8 characters and `-default` (the
stack's `TELFLO_HELM_CHART_*` and `TELFLO_COLLECTOR_IMAGE_REPOSITORY` must
be the defaults); the gateway's facts carry `fullnameOverride: null`; and
the downloaded values file holds the line `fullnameOverride: "<8
hex>-default"` among its fixed lines. A variable named by a YAML word (`ON`)
is the browser tests' to check, not the smoke's.

**The smoke's organization variables steps** run always, with the smoke
collector the platform's fleet steps build (no collector image), in those
steps' fleet right after edge-b2's unpin, through the gateway as the group
organization's signed-in admin. They run on edge-b2 in the group
"unassigned-b", never the Default group, whose assignment the later steps
rely on. A variable `SMOKE_TAG` of the value `a$b-1` and one the text
doesn't use are created; a configuration of the block's own, whose
`attributes/variable` processor inserts an attribute of the value
`${org:SMOKE_TAG}`, is published and assigned to "unassigned-b". The script
computes the SHA-256 edge-b2 must apply from the text filled in as the
opamp-server's poll fills it in (`variable_filled_in`: the reference replaced by
the value with every `$` doubled, `a$$b-1`, the bytes around it as
published), and checks its own fill-in first against those bytes; the
collector's resolution keeps the published text's SHA-256. Each change of
something the text uses is a push (`served.at` moves) of its value, read in
sync: the variable's new value, a variable group overriding it bound to
"unassigned-b", then another pinned on edge-b2 (the pin's wins). A change of
the unused variable is not: a poll is counted by edge-b2's `lastSeenAt`
moving, and while it moves 3 times `served.at` and the SHA-256 stay as they
were and every read is in sync. `SMOKE_TAG`'s delete is refused `409
variable_in_use`, its details exactly the version and "unassigned-b" with
the platform's names and the totals, the reply holding neither the
variable's name nor its value. The block then leaves "unassigned-b" as it
found it (edge-b2's pinned variable group, the group's variable group and
its assignment cleared, edge-b2 unassigned again) and deletes the variable
groups, the variables and the configuration (both lists empty, the published
version gone from the opamp-server); a run that ends among those steps
deletes them in the EXIT trap, after the fleet's removal, and the published
version, recorded once the publish answers, through the management API. With
the collectors' 30 s heartbeat (`OPAMP_HEARTBEAT_INTERVAL_SECONDS`' default)
the block takes about four minutes, most of it the unused variable's three
polls.

**The smoke's CLI steps** drive the `telflo` CLI through the gateway. The
gates run the smoke from a `git archive` copy with no build, so the CLI is
the one `TELFLO_SMOKE_CLI` names (the full suite sets it to the package
check's install of the tarball,
`<keep>/lib/node_modules/@telflo/cli/dist/index.js`); by default it is the
checkout's own `telflo-core/apps/cli/dist/index.js` (`npm run build -w
@telflo/cli` first), run with `node`. Before any step the smoke checks it is
there and prints its `-V`, or fails at once in fixed words. The steps sit in
the public API section, after the route-14 413 and before the per-token
limit, so that section's search of the logs for its personal token covers
the CLI's calls. Every CLI run has `HOME` and `TELFLO_CLI_CONFIG_DIR` (0700)
in the work folder and `XDG_CONFIG_HOME`, `TELFLO_TOKEN`, `TELFLO_SERVER`,
`TELFLO_ORG` and `TELFLO_CONFIG_DIR` unset (`cli_env`), its standard input
`printf`'s pipe for `login` and `/dev/null` for every other run, its stdout
and stderr in 0600 files read only by `jq`, `grep` and `cmp`. In order:
- `login` from standard input with the public API section's personal token
  (`printf`, a builtin, into a pipe: never argv), `--server` the gateway,
  `--org` the group organization: exit 0, "Logged in … as <the token's name>
  (…)", the credentials file 0600 in a 0700 folder;
- `whoami` and `org list` (`--json`): the person's write token from the
  file, the group organization current;
- `config create` (a draft v1), `config push` (the draft updated in place,
  validated), `config publish` (v1) and `config pull -o` (the pushed text,
  `cmp` byte for byte);
- `validate --config` (valid, on the pin), then with an empty second config
  folder and `TELFLO_SERVER` the gateway: the anonymous route (valid, exit
  0; an invalid text exit 4 with its errors; nothing written there);
- `ottl lint --context log` (a valid condition exit 0, a broken one exit 4);
- `test --spec --config` (a spec with a sample file and two OTTL rules) in
  the real tester: `succeeded`, both rules passed;
- `fleet create --json` (exactly the route's five keys: no bearer), `fleet
  groups` (the Default group), `deploy --group` (the Default group serves
  v1: an install needs a group serving a version, or 409
  `collector_group_unassigned`), and `fleet install --platform docker`
  (exit 0; its stdout checked by `grep -q '^docker run'` only, never
  printed);
- `logout` (the file removed), then `whoami` exit 3.

Then, counts only: no `tf_`, `tqd_` or `tll_` in the CLI's outputs but
install's stdout, the personal token in none of them, and every non-blank
line of install's stdout (`grep -cF -f`) in none of the other outputs nor
the API's and the gateway's logs; install's stdout is removed. A failure
prints the exit code and the CLI's own fixed words (its JSON error,
`tf_`/`tqd_`/`tll_` redacted), never an install's output. The session is
refreshed after the steps (the per-token step mints its token and the
revoke goes through it). The configuration and the fleet go with the group
organization's delete; the credentials file with the work folder. The OK
line's `$cli_steps` names what ran.

**The smoke's product-administration steps** run only on a throwaway stack,
as the earlier product-admin and library steps do, after the library's: the
account is made a product admin by SQL and drives `/api/v1/product-admin/`
through the gateway (the steps are listed in `docs/development.md`'s smoke
paragraphs and the script's header). A throwaway stack's only product admin
is the smoke's account, so its own removal there is the one real `409
last_product_admin` outside the integration suite. A third account is made
with `register_verified
<email> <password> [<label>]`, the first account's four steps (register,
the verification email, its page, verify) factored into a helper, its
label "the third account" so its address is in no step line. Replies
holding other people's emails or the feedback's text stay in the 0600
reply files and are read by `jq` for ids and booleans; the admins' email
and the logs are searched by counts only (`grep -c`, `qd_none`). The
invitee's flag is granted through the API, so the EXIT trap clears it by
SQL (`product_admin false "$INVITEE_EMAIL"`) as well as the account's. The
steps add four identity requests (the third account's register, verify,
sign-in and refused sign-in), 15 a run in all (`docs/development.md`). The OK line's
`$admin_steps` names what ran.

## Browser tests on shared, global data

The e2e suite runs its workers in parallel on one database, and the
product-administration pages show global data: every account, every product
admin, every pending feedback item and its count. Each spec therefore:
- **makes its own product admins** with `grantProductAdmin` (`docs/configuration.md`'s
  SQL as the owner, `e2e/support/database.ts`) and **revokes them however
  the test ends** (a fixture records each and calls `revokeProductAdmin`
  in its teardown), so many product admins are live at once and none
  outlives its test;
- **finds only its own people and rows**: by searching for its own seeded
  addresses or group names (Users), by its own marked text, following
  "Load more" until it shows (User Feedback), never by a count, the list's
  order, "the whole list" or the empty state; the pending count is
  asserted as an integer ≥ 1, never exactly; the admins' email is read at
  the test's own admin's address;
- **never relies on the real last-admin rule**: other workers' admins are
  always there, so the refusal's UI is tested with a routed `409
  last_product_admin` (`page.route`), and the rule itself in the
  integration suite and the stack smoke; removing yourself uses a
  throwaway second admin of the test's own;
- **keeps other people's data out of a failure's output**: privacy checks
  collect (`e2e/support/privacy.ts`, `maskedPlacesOf` and `within`), go to
  `about:blank`, then assert, counts and booleans only. Synthetic
  `e2e-<uuid>@example.com` addresses in a failed run's messages,
  `error-context.md` and traces are accepted residue, and
  a failed run may leave its feedback pending and its people in the
  database, which later runs ignore by the rules above.

**Browser specs can't run from a linked copy.** A `git archive` copy whose
`node_modules` are links into another tree fails in the browser: Vite's dev
server refuses the linked modules' real paths outside its `/@fs/` allow-list
(403), and its config is never edited to allow them. The specs run from the
checkout.

## Browser tests with no account

The playground's specs (`e2e/playground*.e2e.ts`,
`e2e/public-editor.e2e.ts`) open their pages signed out, in a fresh context
with no session, as a visitor does. They run on the SaaS's pair, where the
playground is on ("Browser tests on two pairs" below):
- **The request recorder.** `recordPlaygroundRequests(context)`
  (`e2e/support/playground.ts`) records every request the context makes from
  then on, across navigations, reloads and new pages: its method, origin,
  path and kind (a document, a React Router `.data` read, anything else),
  never its query or body (so never a visitor's text). `outside()` lists
  every request outside the playground's invariant: an `/api/` request (the
  path decoded as often as that changes it, the prefix in any case) not in
  `PLAYGROUND_API_ALLOWLIST`, a document or `.data` read of a page other
  than `/playground…` and `/public-editor`, a web-origin request by a method
  other than GET or HEAD, or another origin (the PostHog stub only with `{
  analytics: true }`, after consent). A test that leaves the playground on
  purpose (the handoff's `/register`, `/login` and `/app`) calls `leave()`
  first: nothing after it is recorded. The allowlist is exact, a method and
  a path pattern each, a query never allowed: an allowlist, not a deny-list.
  `apiRequests()` names the allowlisted requests seen. Every playground spec
  asserts `outside()` is empty; the walks and most specs also assert the
  exact set of `/api/` requests seen (`[]` where nothing validates or reads
  the flows), and a few only that each one seen is the anonymous validate. A
  guard test sends one request of each outside kind and expects each in
  `outside()`. A new open route the playground calls joins the allowlist and
  `docs/conventions/security.md` together.
- **The address budget.** Every worker sends from one address, and the
  test servers lift only the per-minute counts (`TEST_RATE_LIMITS`): the
  anonymous validate's 1 in flight per address is real. Two checks at once
  answer 200 and 429 with `Retry-After: 1`, and the client waits that long
  and checks again ("Checking paused — try again in N s"). So specs that
  validate run serially within their file
  (`test.describe.configure({ mode: "serial" })`), as walks of one area
  each, about 25 s at most with `test.slow()`; they assert the outcome
  web-first (`config valid · v0.162.0`, an error count) and never that no
  429 came; the countdown's test stubs the 429 with `page.route`. The open
  flow read's 60 a minute per address is lifted in tests like the others.
- **The tour's flag by an init script.** A test that isn't about the tour
  opens the playground as a returning visitor:
  `context.addInitScript` sets `telflo-playground-tour-completed` in
  localStorage before any page script runs, so the welcome dialog never
  opens over it. "No welcome dialog" is said only after the list has
  arrived and about a second has passed (`expectNoWelcomeDialog`: the
  dialog opens in an effect after the list). The public editor's Welcome
  dialog has its own flag, `telflo-public-editor-welcome-done`.
- **Visitor text.** The sample's own words, the page's and the test's own
  markers are asserted as text; a visitor's text and the handoff's created
  configuration are checked with boolean canaries (`includes` → boolean).
  Masking is checked with `support/privacy.ts` (collect, go to
  `about:blank`, then assert). Every editor walk also asserts that each
  field holding a value sits inside `ph-no-capture` (`unmaskedFieldsOf`,
  which names a field by its tag and id, never its value), and the public
  editor's spec that browser storage holds only the named keys (the Welcome
  dialog's flag, the theme word, the tour flags), none holding the text
  shown or typed.

## Browser tests on two pairs

The browser tests run two pairs of an API and a web dev server side by side
(`telflo-core/e2e/support/environment.ts`):

- **The default pair**, API 28080 and web 23100, runs **the open-source
  defaults**: every site variable is set to `""` (the API's settings and
  the dev server would otherwise fill an absent one from `.env`) but the
  docs link, which `""` would hide and which is given its default, so
  registration is `invite-only`, the playground and the reads without
  signing in are off, Settings › Notifications is hidden, and no Terms are
  asked. Most specs run here.
- **The SaaS's pair**, API 28081 and web 23102 (Vite's cache in
  `node_modules/.vite-e2e-saas`), runs **the SaaS's values**
  (`e2eSaasApiEnv`, `e2eSaasWebEnv`): registration `open`; the playground,
  anonymous validate and public flows on; Settings › Notifications on; the
  Terms at
  `E2E_SAAS_TERMS_VERSION` (`2026-01-01`) with `/home/terms-of-service`,
  `/home/privacy-policy` and `/home/cookie-policy` (nothing serves them in
  the tests); no sales inquiries. A whole spec runs here by importing
  `test` from `e2e/support/saas.ts` in place of `@playwright/test`'s
  (`terms`, `federated-sign-in`, the five `playground*` specs,
  `public-editor`); a single test of a default-pair spec by
  `test.use({ baseURL: E2E_SAAS_WEB_URL })` in a describe of its own.
- **The analytics web server** (23101, beside the PostHog stub) runs the
  SaaS's values against the SaaS's API: the playground's analytics need
  the playground and PostHog on one server.
- **`e2e/site-switches.e2e.ts`** runs on the default pair, with its "on"
  cases on the SaaS's: every switched page and route off (404, in server
  rendering and client navigation alike) and on, `/` to `/login` or `/app`,
  `robots.txt`, and no request to PostHog without a key.

Both pairs share `telflo_platform_e2e_test`, Mailpit, the fakes and the file store.
Playwright starts its web servers one after another, and global setup's
teardown waits for both APIs' after-response jobs. A new spec that needs
open registration, the Terms, the playground or a read without signing in
runs on the SaaS's pair; one that checks the open-source behavior, on the
default pair.

## The SMTP test relay

The mail tests send through a real TLS connection to an in-process relay,
`telflo-core/apps/api/src/testing/smtp-relay.ts`, on `node:net` and
`node:tls` only (no SMTP package):

- **Its modes:** `starttls` (offers STARTTLS and upgrades the socket),
  `implicit` (TLS from the start) and `plain` (never offers STARTTLS: the
  relay a `starttls` client must refuse). With a login it offers AUTH
  PLAIN and LOGIN after TLS only, and answers `530` to a message before
  one. It records each message's envelope and data, whether the session
  was TLS, and the mechanism used, with booleans and counts for the logins
  (never their values).
- **Its certificates** come from `createTestCertificates()`: the `openssl`
  CLI, at test time, in a `mkdtemp` folder: two CAs (the one that signs
  and one that signs nothing here), a server certificate for `localhost`
  and `127.0.0.1`, and a second one from the same CA for another host
  (`other.example`, `10.9.9.9`), which only the client's host-name check
  refuses. RSA 2048 and always `-sha256` (macOS's LibreSSL signs SHA-1 by
  default, which Node refuses); extensions from a config the function
  writes. Every private key is read into memory and deleted at once, and
  `remove()` deletes the folder in `afterAll`. **No key is ever
  committed.** `openssl` must be on `PATH` (the coverage run's too).
- **The client dials `127.0.0.1`** (nodemailer resolves a name by real
  DNS, and the tests use no network), so the IP name in the certificate is
  what it checks; the tests shorten the transport's timeouts so a broken
  case fails fast.
- **What the mail tests prove** (`apps/api/src/mail/`, with the relay):
  STARTTLS and implicit TLS each deliver with a login
  and the private CA; `starttls` to the `plain` relay sends nothing; a
  certificate from the other CA, and the other host's certificate, are
  refused in both modes with no AUTH and no message; the boot refusals
  (cleartext off loopback, a login with `none`, half a login); no
  credential in any error (boolean canaries). Deliberate breaks:
  `rejectUnauthorized: false`, `requireTLS` removed, the CA dropped, a
  no-op `checkServerIdentity`.

## The real Helm install

`scripts/check-helm-install.sh <work dir>` installs for real into a
throwaway minikube profile (`CHECK_HELM_PROFILE`, default `telflo-helm-check`),
against a throwaway compose stack, through the platform's API as a person
it registers there, from the platform's **published** chart and image
(`oci://ghcr.io/telflo/telflo/charts/supervisor-collector` at `0.1.0`,
`ghcr.io/telflo/telflo/collector`: the stack's defaults, each group's
facts checked for all three; it has no local-chart option): the Agent, the
Cluster and a 2-replica gateway (with a read-only `hostPath` volume) each
with the Helm dialog's values file and `helm upgrade --install`, printed
by the contracts' builders in the API container as the dialog builds them
(the bearer from a reveal, by name only; the file named after the release
with a fresh download fragment), and a second gateway with a Helm values
link's Quick Deploy command (its `curl` downloading the values through the
gateway into a 0600 file under a umask of 022, then the install). Each
group's facts must name its release and namespace and the
`fullnameOverride` the platform gives it: the fleet id's first 8
characters and `-default` for the Agent, `-cluster` for the Cluster, none
for a gateway. A release's pods are found by the chart's object name, `-l
app=<fullname>` (the facts' `fullnameOverride`, else the gateway's name),
and each must enroll in its group through the platform's collector list
(named after the pod, handed the rotate token).

Then, in order:

- **Each role's namespace move**: every step and outcome the group
  dialog's warning gives (`namespaceChangeWarning`) is proven by the run,
  per role, from evidence that began after the move completed (the
  collectors read once the new install returned and every old pod was
  deleted).
  - **The Agent**: its saved namespace is changed through the platform to
    `telflo-hc-moved` and its printed install (the release `telflo-node`
    unchanged) run while its release runs in `telflo-hc-node`. Helm must
    refuse it: the chart's `ClusterRole` (named after the fleet,
    cluster-scoped) belongs to the release in the first namespace
    (`meta.helm.sh/release-namespace`), and Helm's error must name that
    `ClusterRole` and namespace; a Helm that accepts it fails the check.
    Nothing may be left in `telflo-hc-moved` (no pod, workload, Secret or
    service account but `default`, or no namespace at all: Helm checks
    ownership before `--create-namespace` makes it), the `ClusterRole` still
    belongs to `telflo-hc-node`, and the Agent's pods are unchanged. Then, as
    the warning says: its printed `helm uninstall` in `telflo-hc-node`
    first (its pods waited for until deleted), then the moved install. Its
    collectors must stay the same records (each old id seen later than the
    read; a new record fails the check: the warning says its state is kept
    on each node, the `hostPath` `/var/lib/telflo/supervisor/<fullname>`,
    outside any namespace). It stays in `telflo-hc-moved` for the rest of
    the run.
  - **The Cluster**: its namespace changed to `telflo-hc-cmoved`, its
    printed install is refused the same way (the same words checked), then
    its printed uninstall in `telflo-hc-cluster`, then the install. Its pod
    must come back as a new collector record (an id not among the old ones,
    seen after the read: its state is its PVC, per namespace; counted, not
    matched by name, since the platform names a new collector anew while an
    old record of the organization holds its pod's name: names are unique
    per organization), and its old record must
    not move on, then or 40 s later.
  - **A gateway** (`gw-check`): in the order its warning gives, its install
    into `telflo-hc-gmoved` first (Helm accepts it: a gateway owns nothing
    cluster-wide), then its printed uninstall in `telflo-hc-gateways`. Its
    pods must come back as new collector records and its old ones stop, as
    the Cluster's; its Service's address changes from
    `gw-check.telflo-hc-gateways.svc` to `gw-check.telflo-hc-gmoved.svc`
    (read by jsonpath), the old Service gone.
  The records the moves replaced are left out of every later "stays
  connected" check.
- **The second fleet**: a second Kubernetes-supervisor fleet of the same
  account, its id's first 8 characters other than the first's (a new id is
  drawn on a clash: two fleets sharing them would collide on the
  `ClusterRole`, a recorded limit), installs its Agent in
  `telflo-hc2-node` and its Cluster in `telflo-hc2-cluster` with their
  printed commands (the releases `telflo-node` and `telflo-cluster` again,
  in directories `f2-node` and `f2-cluster` of the work directory), and
  each pod enrolls in its group on its own fleet's rotate token. The four
  `ClusterRole`s and their bindings (read by jsonpath) are each named
  after their fleet, owned by their release's namespace and distinct; the
  two DaemonSets' `storage` `hostPath`s are
  `/var/lib/telflo/supervisor/<fullname>`, distinct; and the first fleet's
  collectors, read once the second's had enrolled, are each seen later
  than that read.
- **The new default token** (only with `CHECK_HELM_NEW_DEFAULT_TOKEN=1`):
  the default token is revoked and a new one issued, the running Agent
  pods must keep polling (they hold the rotate token), and the Agent's
  command is run again with the new bearer. The chart's `checksum/token`
  on the pod template rolls the DaemonSet (no `kubectl delete pod`):
  `kubectl rollout status daemonset/<fullname> --timeout=180s`, then
  `kubectl wait --for=delete pod/<old> --timeout=120s` for each old pod
  (one still there fails the step), then the new pods are listed (none of
  the old names; as many as the profile's nodes) and **then** the
  collectors are read. Only evidence that began after the restart
  completed counts: an old pod keeps polling on the rotate token while it
  terminates, and a new pod may connect and then fail before the rollout
  ends, so each new pod needs a record of its own (the same record as the
  old pod's when the node's state keeps the instance uid; a record not in
  the read is counted only under the new pod's name), handed the rotate
  token and seen later than that read; every other pod of the first fleet
  must move on from the same read. The step's claim (the new pod read the
  Secret's new default token, since the supervisor keeps no connection
  settings on disk) is then checked on the node's state: the new pod's
  storage directory, `kubectl exec <pod> -c supervisor -- ls -1A
  /app/opamp` (the node's `hostPath`
  `/var/lib/telflo/supervisor/<fullname>`; `-A` so dotfiles show,
  `--request-timeout=30s` on its `kubectl exec` calls), is listed by name
  only and recorded in the run's output (the names as they are, once the
  listing holds none of the run's secrets). opampsupervisor 0.162.0 writes
  there only `persistent_state.yaml` (the instance uid),
  `last_recv_remote_config.dat` and `last_recv_own_telemetry_config.dat`
  (the last configurations received), `effective.yaml` (the collector's
  composed configuration, its OpAMP extension pointed at the supervisor's
  own local server) and `agent.log` (the collector's output, its default
  agent log file); its connection settings are in the entrypoint's
  `/app/supervisor-config.yaml`, in the container, and in memory. The
  rule: no file but `last_recv_remote_config.dat` and
  `last_recv_own_telemetry_config.dat` (exactly those two names) may hold
  what connection settings look like; each other file,
  `persistent_state.yaml` and any other `last_recv_*` included, is
  searched in the pod (`grep -q`, nothing printed) for an `Authorization`
  header, a `Bearer`, the agent endpoint's host and port or its path, and
  a match (the claim would then need reworking) or a file that can't be
  searched fails the run, as does a listing with no
  `persistent_state.yaml`.

**The anonymous pull**: the chart is pulled by the printed commands' Helm,
and Docker and Helm ask the macOS keychain's credential helper when their
configuration holds no auth (and a stored ghcr.io login breaks even a
public pull). So the printed commands run with `HOME` and `DOCKER_CONFIG`
in the work directory, its Docker `config.json` and Helm's registry config
seeded `{"auths":{"telflo-check.invalid":{}}}`, and refusing stand-ins for
`docker-credential-osxkeychain`, `docker-credential-desktop` and
`docker-credential-ecr-login` first on `PATH` (each logs its name and
first argument to `credential-helpers.log`, never reads its input, exits
1): a stand-in called while a printed command runs, while `minikube` loads
and tags the local image, or during a successful run's teardown fails the
run, naming the helpers and their first arguments (on a run that has
already failed, one called during its teardown is only reported). The
local image's inspection and `minikube image load`/`image tag` run under
the same seeded config and stand-ins; the seeded config names no Docker
context, so they use the default engine (`DOCKER_HOST`, else
`/var/run/docker.sock`, on Docker Desktop a link to its own socket), which
must have the engine id the caller's config reaches, or the run fails
saying so. The image's question is curl's (`-q`, no netrc): a manifest
`HEAD` with the registry's anonymous token.

Before its teardown it searches every file it leaves in the work directory
(its logs, the printed commands, the facts, the collector lists, the
storage listing, the stand-ins and their log, Helm's homes) for the
bearers and the link's secret. Every bearer or link secret the run obtains
joins its secrets file the moment it exists, before anything else reads or
logs what holds it: each fleet's create reply's default and rotate bearers
(both fleets'), each fleet's reveal, the token line of each values file
the contracts print, the Helm link's secret, the token line of the values
file the Quick Deploy command's `curl` downloads (sealed anew for that
download: read by bash's own match, shape-checked, on no command line, as
soon as the printed command returns and before its log is read, even on a
failure; the download must hold exactly one), the new default token's, and
the registry's anonymous pull token; the script's comment lists each
place. The search fails closed (an empty secrets file or an unreadable
file fails the run) and names only the file. The files it skips are
exactly those the teardown removes (one list: the secrets file, the
replies' body, the jar, the sweep's own file lists (`kept-files` and
`kept-files.found`), and in each release's directory, one level down, its
`printed.json`, values files and Quick Deploy command, and the registry
step's `registry-token.json` and `registry-headers`). A failed run's EXIT
trap runs the same search before its teardown, report only: it names the
path of each file holding a secret (or that can't be searched), never its
contents. At the end (or on a failure, by its EXIT trap) it runs each
release's printed `helm uninstall` (both fleets'), deletes the namespaces
it made (`telflo-hc-node`, `telflo-hc-cluster`, `telflo-hc-gateways`,
`telflo-hc-reach`, `telflo-hc-moved`, `telflo-hc-cmoved`,
`telflo-hc-gmoved`, `telflo-hc2-node`, `telflo-hc2-cluster`; their PVCs
with them), revokes the link, deletes both fleets and the configuration,
and removes its files holding a bearer or a link's secret. Its diagnostics
are redacted (`tqd_…` and every run of 20 or more base64 or base64url
characters, `+` and `/` included); it never prints a values file or a
Secret.

It refuses (exit 2), before touching anything (only `kubectl config` reads
the file), unless `COMPOSE_PROJECT_NAME` is set and isn't `telflo`,
`telflo-dev` or `telflo-platform`, `TELFLO_GATEWAY_URL` and
`TELFLO_MAILPIT_API_URL` name the throwaway stack (not 50080 or 58025),
`CHECK_HELM_IMAGE_PULLABLE` is `yes`, `no` or unset,
`CHECK_HELM_NEW_DEFAULT_TOKEN` is `1`, `0` or unset,
`CHECK_HELM_LOCAL_IMAGE` (when set) is an image name with a tag,
`CHECK_HELM_PROFILE` (when set) is a DNS-1123 label, isn't `minikube` (a
developer's own profile) and isn't a name YAML reads as a number (all
digits, `1e3`, `0x1f`, `0o17`, `0b101`) or as a boolean or null (`y`, `n`,
`yes`, `no`, `true`, `false`, `on`, `off`, `null`, `~`, in any case) or a
date (`2001-12-14`): kubectl writes such a name quoted (`name: "123"`),
which the allowlist below refuses with words that don't say why, so the
profile is refused first, saying so, and `KUBECONFIG` is one file in the
work directory minified to the profile's context (its only context and
cluster, and current), and the server kubectl will use, resolved as
kubectl resolves the current context (`kubectl config view --minify`, a
read of the file), is the profile's own and reached directly: the current
context's cluster exists (`--minify` fails on one the file doesn't hold)
and is the profile, its server is an `https://` address (none, or
`http://`, would send kubectl to `http://localhost:8080`, a developer's
own development API) whose port, read as a number with no leading zero,
isn't 8080 (`:08080` is refused), it names no `proxy-url`, and no
`HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` (either case) is set. Before
those, and first, the kubeconfig must hold only what minikube writes, an
allowlist rather than a list of refused keys: every line of the file a
block-style `key: value` line (no flow mapping but `preferences: {}`, no
comment, quote, anchor, tag, block scalar or bare list item), and each key
allowed at its place: at the top `apiVersion`, `kind`, `clusters`,
`contexts`, `users`, `current-context`, `preferences` (empty); a cluster
`server`, `certificate-authority`, `certificate-authority-data`,
`extensions`; a context `cluster`, `user`, `namespace`, `extensions`; a
user `client-certificate`, `client-certificate-data`, `client-key`,
`client-key-data`, `token`; an extension (a cluster's `cluster_info`, a
context's `context_info`) `last-update`, `provider`
(`minikube.sigs.k8s.io`) and `version`, minikube's own. Any other key (an
`exec` plugin, an `auth-provider`, `proxy-url`, `tls-server-name`,
`insecure-skip-tls-verify`, `as`, `username`…) is refused, naming the key
and its place, never a value. The allowlist reads the file's text, which
both kubectl and Helm read: kubectl's own view drops keys its client-go
doesn't know, and Helm's client-go is another version. The whole file as
kubectl reads it (`kubectl config view --raw -o json`, not minified, never
printed; python3 reads both) must then hold exactly one cluster, context
and user, each named the profile, the context naming the profile's cluster
and user, the current context the profile, and only minikube's extensions.
33 refusal sites in all, which the refusals' harness covers with 44 cases
(with `python3` on `PATH`; the context's cluster being the profile, and a
`proxy-url`, are also caught earlier, by `--minify`, the exact cluster
list and the allowlist, so no case reaches those two alone). Every
`HELM_*` variable of the shell is unset (`${!HELM_@}`, the caller's
exports among them; those `helm env` lists, `HELM_KUBECONTEXT`,
`HELM_KUBEAPISERVER`, `HELM_KUBETOKEN`, `HELM_NAMESPACE` and `HELM_DRIVER`
among them, would send helm elsewhere than that context; a note names the
ones unset, never their values). Helm's homes, its registry and repository
config and its plugins are then in the work directory. The stack must hand
collectors `OPAMP_SERVER_URL=http://host.minikube.internal:<its published
agent port>/opamp/api/v1` (the facts' endpoint), and its API's
`TELFLO_PUBLIC_API_URL` must be `TELFLO_GATEWAY_URL` (the link's curl runs
on the Mac); none of the namespaces it makes may exist yet. Step 0 runs a
pod of the collector image in the profile that POSTs to that endpoint and
expects the agent door's `401`: a profile that can't reach the stack's
port fails there, before any install. The pods run `<the facts' image
repository>:<the collector version>` (`IfNotPresent`): unless its registry
serves that tag anonymously (`CHECK_HELM_IMAGE_PULLABLE=yes` or `no` skips
the question), the local image `CHECK_HELM_LOCAL_IMAGE` is loaded into the
profile (`minikube -p <profile> image load`) and tagged there as that tag;
a local image whose `entrypoint.sh` isn't the checkout's is named in a
note. For example, once the chart and the image are published and public:

```sh
minikube start -p telflo-helm-check --driver=docker
minikube -p telflo-helm-check kubectl -- config view --flatten --minify --context=telflo-helm-check >"$WORK/kubeconfig"
OPAMP_SERVER_URL=http://host.minikube.internal:<agent port>/opamp/api/v1 \
  TELFLO_PUBLIC_API_URL=http://localhost:<gateway port> \
  docker compose -p <project> -f <a copy with its own ports> up -d   # then poll its health
COMPOSE_PROJECT_NAME=<project> COMPOSE_FILE=<that copy> \
  TELFLO_GATEWAY_URL=http://localhost:<gateway port> \
  TELFLO_MAILPIT_API_URL=http://localhost:<mailpit http port> \
  KUBECONFIG="$WORK/kubeconfig" CHECK_HELM_NEW_DEFAULT_TOKEN=1 \
  scripts/check-helm-install.sh "$WORK"
```

(`minikube start` switches `~/.kube/config`'s current context: note it
first and restore it after.) The profile, the stack and the account it
registered there are the caller's to delete. Each DaemonSet's node state
(`/var/lib/telflo/supervisor/<fullname>`, the fleet's own) outlives the
uninstall; a second run makes new fleets, so it never starts from a first
run's instance uid. No workflow runs it: run it by hand after a change to
the Helm install or the chart.

Its dry runs (no cluster): fakes for `kubectl`, `helm` and `minikube`
standing in for the profile, the real `docker`, `curl`, `jq` and API of a
throwaway stack. The fake `helm` keeps each release's objects as the real
chart's render (`helm template` of `charts/supervisor-collector` with the
values file the check handed it) and refuses an install whose
`ClusterRole` another release or namespace owns, as Helm does; the fake
`kubectl` answers the check's jsonpath reads with the real `kubectl
annotate --local … -o jsonpath=…` over those objects (offline); pods are
containers of a local collector image (`host.minikube.internal` as
`host-gateway`, the Agent's node state a named volume at `/app/opamp`).
Besides the normal run (exit 0, ending `OK:`), each fake mode must fail it
with exit 1 and its own `FAIL:` words (the dry runs' harness checks the
words, not only the exit code): `early`, a new pod that connected and was
then cut off the network (`docker network disconnect` inside the fake
`rollout status`, so `kubectl exec` still reaches it) before the rollout
completed, so its only evidence is older than the read ("…didn't connect …
after the rollout completed…"; the fake first records the new pod's own
`Connected to the OpAMP server.` log line, and the harness requires that
record, so a pod that never connected can't pass for this case); `linger`,
an old pod still there after the rollout ("…wasn't deleted within 120 s of
the rollout's end…"); `accept-move`, a `helm` that accepts the namespace
move ("Helm accepted…"); `wrong-refusal`, a `helm` that refuses it for
another reason, `context deadline exceeded` ("…but not over the
ClusterRole…"); `print-token`, a `helm` that prints the token (the final
sweep names the log); `cred-helper`, `cred-minikube` and `cred-uninstall`,
a `helm` install, a `minikube image load` and a `helm uninstall` that call
a credential helper (each its own words: while the printed command ran,
while minikube loaded the image, during the teardown); `owner-mismatch`,
the second fleet's Cluster's `ClusterRole` owned by another namespace
("the ClusterRole … reads…"); `binding-mismatch`, its
`ClusterRoleBinding`'s subject in another namespace ("the
ClusterRoleBinding … reads…"). The fakes keep each role's storage as the
chart does: the Agent's `/app/opamp` one Docker volume per fullname (the
node's `hostPath`, outside any namespace), the Cluster's and a gateway's
one per namespace and pod (their PVCs); and the namespace moves have modes
of their own: `agent-new-uid` (the Agent's state per namespace: "the Agent
came back as a new collector record…"), `cluster-keep-uid` (the Cluster's
shared across namespaces: "the Cluster's old collector record … moved
on…"), `gw-ghost` (an uninstalled gateway pod keeps polling outside the
profile's view: "gw-check's old collector record … moved on…"),
`accept-cluster-move` and `wrong-refusal-cluster` (the Cluster's refusal:
"Helm accepted the Cluster's…", "…but not over the ClusterRole…"),
`silent-node`, `silent-cluster` and `silent-gateway` (the moved pods reach
nothing: "…didn't move on…", "…didn't come back as new collectors…"),
`svc-missing` and `svc-stale` (no Service in the new namespace; the old
one still answers). Each half of the move checks has a mode judged at its
own step's words: `early-node`, `early-cluster` and `early-gateway` (a
moved pod connects, its supervisor's log line recorded, then goes silent
before the install returns, so its only evidence is older than the read:
"the Agent's collector records didn't move on…", "…didn't come back as new
collectors…"; a "later than the read" compare loosened to "not earlier"
fails only at a later step's words), and `gw-ghost-late` (once the check
has read the collectors after the gateway's move and its new pods have
polled since, the old pods' ghosts start 20 s later, so only the 40-s
holding pass sees an old record move: "…moved on after its move to … (40 s
after its new records showed)…"). A later step's wait for a record whose
name is no running pod's (a moved Agent's, a generated one) says "the
collector record …" and tails no pod's log. The facts' chart version is
pinned by a run against a stack whose API sets `TELFLO_HELM_CHART_VERSION`
to `0.1.1` ("the Helm facts of … name the chart … 0.1.1…"). Each half of
the check those modes pin is proven by breaking it in a scratch copy: the
mode named for it must then no longer see its words. A break counts as
caught only when the run then ends `OK:` or with the named downstream
`FAIL:` the break leads to (e.g. the run-time credential check removed:
"…during the teardown…"); a run that failed on the stack or on a rate
limit (`429`) is run again, never counted as a catch. The refusals'
harness checks each new case's words the same way. The fakes run the real
`kubectl` only on files, with the network denied (`sandbox-exec`).

## The platform chart

The platform's own chart, `charts/telflo`, and the scripts around it have
offline tests, each run after any change to what it covers and in the full
suite's static gates. Each prints `PASS` or `FAIL` and a name, never a
value or a tool's output, and runs on macOS's bash 3.2:

- `bash charts/telflo/tests/render-tests.sh`: real `helm template` renders
  of every profile in `tests/profiles/`, then every case in
  `tests/cases/`, offline, with Helm's homes, `HOME`, `DOCKER_CONFIG` and
  `KUBECONFIG` in a temporary directory. The cases pin every guard (with
  no value in its message), every environment variable and its source, no
  rendered `kind: Secret`, the probes, the security contexts, every
  NetworkPolicy's selectors and ports, the gateway's ConfigMap byte for
  byte against `docker/gateway/default.conf`, and `helm lint --strict` per
  profile.
- `bash scripts/check-chart-cloud-neutral.sh`: no cloud marker in a file
  the charts package or in any profile's rendering, and no annotation key
  a template writes itself (but a pod's `checksum/<name>` and exactly
  `helm.sh/resource-policy: keep`), for both of the platform's charts
  (`docs/conventions/security.md`, "The charts stay cloud-neutral").
- `bash scripts/check-chart-cloud-neutral.test.sh`: the check passes on the
  charts as they are and fails on a copy broken each way it must catch.
- `bash scripts/create-secrets.test.sh`: `scripts/create-secrets.sh`
  against a fake `kubectl` that records every argv and standard input.
  Boolean canaries prove no value reaches an argv, stdout or stderr, a
  failure's message included; the cases cover `--init`, the refusals, the
  server-side apply's exact arguments, the token file and the signals'
  cleanup.
- `bash scripts/publish-platform-images.test.sh`: the images' publish
  script with a `docker` stand-in, from committed throwaway repositories:
  its modes and refusals, the credential checks, nothing built by
  `--dry-run`, and `--build-oci` and `--push-oci` ("The publish scripts"
  above).

`scripts/publish-chart.test.sh` covers the `--chart telflo` cases too, and
`scripts/check-opamp-server-pin.test.sh` the vendored chart's
(`docs/conventions/opamp-server.md`).

## The three smokes

Three smokes run the product end to end, each on something of its own that
it removes at the end. Each refuses the Compose projects `telflo` (a
user's install), `telflo-dev` (the development stack) and
`telflo-platform` (a long-running stack, not a throwaway); keeps every
secret it makes or reads in 0600 files of its work folder and hands it to
commands through files and standard input, never argv; never prints one;
and before it ends searches every output it made for each, by boolean. The
full suite runs all three, the stack smoke in both modes; the release
workflow runs each once on the release's own amd64 images ("The release
workflow's tests" below), through `scripts/release/steps.sh`
(`stack-smoke`, `archive-smoke`, `kind-smoke`), which pipes each one's
output through `scripts/gates/redact.sh` into a log of its work folder and
fails on a line it redacted, keeping the smoke's own exit code otherwise;
the rehearsal calls the same steps.

### The stack smoke

`scripts/smoke-test-stack.sh` drives the development stack, every
component in a container, through its gateway (its steps: the sections
above from "The gateway's logs" on, and `docs/development.md`, "The whole
stack in containers"). It takes `TELFLO_SMOKE_SITE=oss|saas`, required,
with no default; unset or anything else exits 2 before anything runs:
- **`saas`**, the SaaS's site values: registration open with the Terms,
  the playground, anonymous validate, the published flows, the sales
  inquiries and email notifications on;
- **`oss`**, the open-source defaults, on a throwaway stack only
  (`COMPOSE_PROJECT_NAME` set and none of the three names): registration
  answers 403 `registration_not_open`; the first account comes from
  `telflo-admin bootstrap` in the API's container (its output in a 0600
  file of the run, the set-password link read from its last line, never
  printed) and lands in its group organization as admin and product
  admin, the flag cleared by SQL afterwards (the EXIT trap too); the
  others join by invitations read from Mailpit, with no Terms; a plain
  account's organization create answers 403; the playground, the
  published flows, anonymous validate and the sales inquiry answer 404.

Its throwaway stack is `scripts/gates/stack.sh`'s: a `git archive` copy of
HEAD in the work folder, its compose file's host ports remapped from
`--port-base` and bound to 127.0.0.1, started with `--no-build` on images
already in the engine (`--images dev-tag:<tag>`, the development images
under that tag, or `release:<version>`, the release's
`ghcr.io/telflo/telflo/<name>:<version>` with `pull_policy: never`), and
`--site oss|saas`; `. scripts/gates/smoke-env.sh oss|saas <work>` then
exports the smoke's settings for it (the site's values, the project, its
URLs). In order:

```sh
bash scripts/gates/stack.sh up --project <name> --work <dir> --images dev-tag:<tag> --site oss
```

```sh
. scripts/gates/smoke-env.sh oss <dir>
```

```sh
scripts/smoke-test-stack.sh
```

```sh
bash scripts/gates/stack.sh down --project <name> --work <dir>
```

`--file-store s3` runs it on the object store instead ("The smoke on S3"
above). Each script's header lists its options.

### The archive smoke

`scripts/smoke-compose-install.sh --archive
<telflo-compose-<version>.tar.gz> --sums <SHA256SUMS> --work <dir>
[--project <name>] [--http-port <p>] [--agent-port <p>] [--mailpit-port
<p>]` runs the README's Quick start as written, read from between its
markers by `scripts/release/quick-start.sh`, on the release's Compose
archive: every command in order, in a fresh folder, with only the download
address (`file://` a copy of the archive and `SHA256SUMS`), the example
email and organization and the ports replaced. The steps a person does in
a browser (the set-password link, the sign-in, the invitation read in
Mailpit) it does over HTTP. Then its own checks: every service healthy;
only the gateway's and the agent's ports published, on 127.0.0.1, and
Mailpit's on 127.0.0.1; the modes of `.env` and `secrets/`; no development
secret; the open-source defaults in force; the invited account made; a
configuration validated and run in the tester; a fleet's collector
enrolled; and, after the README's `docker compose down -v`, nothing of the
project left. The five release images, the Docker Hub images and the
opamp-server at their pins and the collector image must already be in the
engine: it never pulls one. `scripts/release/check-readme-quick-start.sh`
(a static gate) holds the README's side, so an edit of the Quick start
that the smoke couldn't run fails there first.

### The kind smoke

`scripts/smoke-kind.sh` installs the platform chart on a throwaway kind
cluster and drives it end to end. kind is the private tools' (`scripts/
release/tools.sh path kind`, never one on `PATH`) and its node image is
`tools.lock`'s, by digest (`scripts/release/tools.sh pull kind-node`). Its
options:
- `--profile <name>`: the cluster's name (default `smoke-kind`; never
  `kind`, nor one that exists, nor a Docker container, volume or network
  of that name). The cluster runs on a Docker network of the run's own,
  removed at the end;
- `--images <version>`: the release's five images, already in the engine
  as `ghcr.io/telflo/telflo/<name>:<version>`
  (`scripts/release/load-images.sh` puts them there), nothing built, the
  chart's own image references used (pull policy `Never`), so
  `<version>` must be the chart's `appVersion`. Without it, the five
  images are built from this tree under the run's own tags
  (`smoke-kind-<image>:<tag>`);
- `--chart <tgz>`: that packaged chart (`scripts/publish-chart.sh --chart
  telflo --package`'s) instead of `charts/telflo`;
- `--keep`: the cluster left running, with the chart installed again on
  fresh volumes, for a walkthrough; `--help` lists the rest.

The steps (the script's header numbers all 22): the refusals; the images;
`kind create cluster` with `--kubeconfig` a file of the work folder (kind
never writes your kubeconfig); every image loaded with `kind load` and
checked by image id, the chart's `postgres:18` pulled inside the node by
digest; `create-secrets.sh --init`, then `create-secrets.sh`, and no
`kind: Secret` in `helm template`; no pull Secret (every image is local,
the chart's pull-secret lists stay empty); `helm install`, every pod
Ready; a second release refused; the databases (each bootstrap ran once,
each refuses the other side's roles, `telflo_platform_owner` no superuser
and the migrations' owner); `helm upgrade`, every pod new, no migration
run again; the static facts (the management Service ClusterIP, the
namespace's `restricted` label, every container non-root with a read-only
root and no service-account token); the NetworkPolicies, enforced by
kind's own CNI, kindnet (no Calico), probed from the sandbox's pods and
throwaway ones with controls that must stay open (a throwaway pod waits 5
s before it probes); through a port-forward, `/login`, `/api/v1/auth/me`
and the API reference page; registration refused, `telflo-admin bootstrap`
in the API's pod, the password set, a sign-in as a product admin with no
Terms, a teammate invited through Mailpit; a configuration validated, run
in the tester and published; a collector from
`charts/supervisor-collector` following version 2; the CLI's anonymous
`validate` refused; a forged `X-Forwarded-For` not trusted; the web
server's log free of a double-encoded path; 60 s without traffic adding no
log line to any pod; every pod's log and Helm's release record free of the
secrets; `helm uninstall`, both claims kept, then deleted.

**What it needs:** Docker with compose, kubectl, helm, node, jq, curl,
openssl and python3; kind and its node image as above; telflo-core's
`node_modules` (the contracts' builders write the collector's values);
a built CLI (`npm run build -w @telflo/cli` in `telflo-core`, or `--cli
<dist/index.js>`); the images it loads already in the engine (its header
lists them); 10.5 GB free in Docker's disk (check it first: `docker run
--rm alpine df -h /`); and internet access: step 13's control checks that
a pod with no policy reaches the outside (a TCP connection to
1.1.1.1:443), so an offline machine fails it by design.

```sh
scripts/smoke-kind.sh --images 0.1.0 --chart <dir>/telflo-0.1.0.tgz
```

**How long:** a run with `--images` and `--chart` takes about 9½ minutes.
**Run it on AC power, with the lid open:** a laptop that sleeps mid-run
stalls the cluster, and the run's waits time out.

Its discipline is the Helm install check's tool rules: every `kubectl` and
`helm` names the run's own kubeconfig and the context `kind-<profile>`;
your current context and your kubeconfig's sha256 and mtime are recorded
first and checked at the end (a changed context is restored and fails the
run). Helm's and Docker's homes are its own, with refusing
credential-helper stand-ins first on `PATH`. Every exit but `--keep`'s
deletes the cluster and its network and removes the run's two kubeconfigs,
which hold the cluster's admin client key; under `--keep` they stay, as
the run's last lines say, until the cluster is deleted. A signal to the
whole process group still runs the whole cleanup.

`scripts/check-helm-install.sh` ("The real Helm install" above) runs on a
throwaway minikube profile.

## The validator's test image

The validator's `test` target (`services/otelcol-validator/Dockerfile`)
carries the opamp-server's org-token corpus: the root `.dockerignore` lets
in exactly `vendor/opamp-server/org-token-corpus.json`, and only that
stage copies it, so `tests/test_org_variables.py` collects in the image as
it does in the checkout. No runtime image carries it.

## The images hold no development dependency

The API's and the web's images are production-only.
`scripts/check-no-dev-dependencies.mjs <package-lock.json> <root>` reads
the lockfile and fails when any entry the lock marks `"dev": true` exists
under `<root>` (a `devOptional` one is allowed and listed); a root with no
`node_modules` is a failure, never a pass. A built image is checked from
inside, read-only, with no network, the lock and the script mounted
read-only and the image's own `node` (the script's header has the
command):

```sh
bash scripts/check-no-dev-dependencies.test.sh
```

is its self-test: throwaway trees and lockfiles (a development package at
the root, scoped, nested under a workspace and under another package; a
`devOptional` one; a workspace link), then the repository's own lockfile,
read only. The full suite's image part builds the api and web targets and
runs the check in each, with the migrations twice, the API's health, the
reference page and `openapi.json` on a read-only root, the web's `/login`
and `telflo-admin bootstrap`.

## The analytics-key check

`scripts/check-no-analytics-key.sh [root]`
(`docs/conventions/security.md`, "No analytics key") fails on a PostHog
key in a tracked file, printing `file:count` only. Its self-test, `bash
scripts/check-no-analytics-key.test.sh`, runs in throwaway git checkouts
(git with no global or system configuration): the code's own lookalikes
(`phc_test`, `phc_e2e_only_fake_project_key`, the cookie names) pass; a
project key and a personal key made at run time (`openssl rand`, 43
letters and digits) fail, each found by a boolean `grep -q` on the output
and never printed; an untracked file is ignored; a key inside a cookie's
name is found; outside a checkout the script exits 2. Both are static
gates.

## The secret scan

`bash scripts/release/check-secrets.sh` runs gitleaks, at
`scripts/release/tools.lock`'s version and sha256 (fetch it once with
`bash scripts/release/tools.sh fetch gitleaks`; the check never downloads),
over every file git would commit: tracked, and untracked but not ignored. It
uses gitleaks' default rules (a `.gitleaks.toml` in the tree,
`GITLEAKS_CONFIG` and `GITLEAKS_CONFIG_TOML` are never read) and `--redact`,
so a value it finds is never printed. Each finding is a fingerprint,
`<path>:<rule>:<line>`, and must be listed in `.gitleaksignore` at the
root; a listed fingerprint gitleaks no longer finds fails too, so the file
holds exactly today's reviewed findings. A test that adds a fake value lists
its fingerprint in the same commit, after review; an edit that moves a
listed line updates its line number. A real credential is never listed: it
is removed, and rotated.

Its self-test, `bash scripts/release/check-secrets.test.sh`, runs in
throwaway git checkouts with a Stripe-shaped key made at run time and
checked with boolean `grep -q` only: a tracked or untracked key fails and
is never printed, a git-ignored file isn't scanned, a listed finding
passes, a moved or stale entry fails, and neither a `.gitleaks.toml` in the
tree nor `GITLEAKS_CONFIG` can allow a finding. Both are static gates; CI's
`secrets` job runs the check alone on every pull request and push to
`main`, and the release workflow's first job runs it before anything
builds.

## CI gates

A change is not complete until all of these pass:

- Full suite green, with no skipped or `.only` tests
- Browser tests green in all three browsers
- Coverage thresholds met. **Coverage is a floor, not a goal** — it catches
  untested files, never untested behavior
- Cross-tenant isolation suite green for every registered resource
- `opamp_server` schema-boundary test green (in the opamp-server's
  repository, its `make check`, for a release the platform pins)
- `scripts/check-gateway-logs.sh` passes (the gateway's logs hold no
  quick-deploy link's secret, no API token, no library link and no public
  request's path; "The gateway's logs" above)
- `telflow` grep clean
- The collector image's, the chart's and the publish scripts' tests (run
  locally, and by CI's and the release workflow's `static` jobs): `bash
  docker/collector-image/entrypoint_test.sh`, `bash
  docker/collector-image/build-collector-image_test.sh`, `bash
  charts/supervisor-collector/tests/render-tests.sh` and `bash
  scripts/publish-chart.test.sh`
- The opamp-server's drift check and its test (static gates): `bash
  scripts/check-opamp-server-pin.sh` (the PIN, the vendored files and
  compose's two services, as text and as `docker compose config` reads
  them with `-f` and through its own discovery in the root, agree with the
  pinned release; the bootstrap mounts the vendored `bootstrap.sql` and
  runs it with the committed command exactly, no entrypoint; the root's
  compose files are a case-insensitive allowlist, so a personal
  `docker-compose.override.yml` fails it; a local pinned image's revision
  label must be the PIN's commit, and an absent one is said, not failed; a
  gitignored `.env` and exported `COMPOSE_*` settings are out of scope; it
  reads the sibling checkout `../opamp-server`, or `OPAMP_SERVER_SRC`) and
  `bash scripts/check-opamp-server-pin.test.sh`
  (`docs/conventions/opamp-server.md`). The check needs the docker CLI
  with its compose plugin, and python3 (no daemon, registry or network),
  and fails closed without either; without the docker CLI the test prints
  SKIP for the cases that need Compose's reading and runs the rest
- The CLI's build and package check: `npm run build -w @telflo/cli` (in
  `telflo-core`) and `bash scripts/check-cli-package.sh` (the `npm pack`
  tarball holds only `package.json`, `README.md`, `LICENSE`, `dist/**` and
  `skills/**`, keeps `"private": true` and `Apache-2.0`, imports nothing
  from `@telflo/`, installs alone and offline into a prefix of its own,
  and its `telflo -V` and `--help` run; `--keep <dir>` keeps the install
  for the smoke; `docs/conventions/cli.md`)
- The platform chart's and its scripts' tests (static gates): `bash
  charts/telflo/tests/render-tests.sh`, `bash
  scripts/check-chart-cloud-neutral.sh`, `bash
  scripts/check-chart-cloud-neutral.test.sh`, `bash
  scripts/create-secrets.test.sh` and `bash
  scripts/publish-platform-images.test.sh` ("The platform chart" above)
- The analytics-key and development-dependency checks (static gates, but
  the run in the built images, the full suite's): `bash
  scripts/check-no-analytics-key.sh` and `bash
  scripts/check-no-analytics-key.test.sh` ("The analytics-key check"
  above), and `bash scripts/check-no-dev-dependencies.test.sh` with the
  check run in the built api and web images ("The images hold no
  development dependency" above)
- License guard clean: every production dependency carries a license on
  the redistribution allowed list
- Typecheck and lint clean

**What CI runs.** `.github/workflows/ci.yml` runs on every pull request, a
fork's included (a first-time contributor's run waits for a maintainer's
approval), and on every push to `main`, its jobs in parallel:
- `secrets`: the secret scan alone (`scripts/release/check-secrets.sh`),
  so a leak fails within a minute;
- `static`: the static gates, exactly as the release workflow's `static`
  job runs them (`scripts/gates/static.sh`, below);
- `unit`: the unit and integration suites in four parts, each against its
  own Postgres and Mailpit; `unit-coverage` joins the four parts' reports
  and checks the coverage thresholds on the whole (a part alone skips
  them);
- `e2e`: the browser tests, each browser in two parts: Chromium on a pull
  request; Chromium, Firefox and WebKit on `main`;
- `ottl-evaluator`: the evaluator's Go checks and tests
  (`docs/conventions/go.md`);
- `otelcol-validator` and `otelcol-testing`: each service's tests, license
  check and its self-test, then its test image with every offered
  collector and the real-collector tests in it (the tester's kwok tests
  too);
- `stack`: the development stack built and started from an empty
  database (`OTELCOL_VERSIONS=default`), the stack smoke through its
  gateway, and the tester's and the evaluator's container checks.

The `ci` job passes only when every other job passed (a failed, canceled
or skipped one fails it), and it is the one check `main`'s branch
protection requires, so a job added or split needs no settings change. A
pull request's newer push cancels its older run; `main`'s runs never
cancel each other. A pull request's run tests Chromium only, so Firefox
and WebKit are the author's to run before it merges (`npm run test:e2e`),
and `main`'s run tests all three after. CI holds no secret and logs in
nowhere; `scripts/release/check-workflows.sh` holds `ci.yml` to its own
rules ("The release workflow's tests" below). The full suite's other
parts (the three smokes on throwaway stacks, the images' builds, the image
part, the rehearsal) stay local.

**The full suite's static gates**, in this order: the naming check and its
test, the license check and its test, `wait-for-http`'s test, the
collector image's entrypoint and build-script tests, the chart's render
tests, the two publish scripts' tests, the opamp-server's pin check and
its test, `npm run typecheck`, the web's typecheck, `npm run lint`, the
web's build, `cli-build` (`npm run build -w @telflo/cli`), `cli-package`
(`bash scripts/check-cli-package.sh --keep <folder>`, the install the
smoke's `TELFLO_SMOKE_CLI` then names), `scripts/check-gateway-logs.sh`,
then the platform chart's:
- `platform-chart-render` (`bash
  charts/telflo/tests/render-tests.sh`);
- `chart-cloud-neutral` (`bash scripts/check-chart-cloud-neutral.sh`);
- `chart-cloud-neutral-selftest` (`bash
  scripts/check-chart-cloud-neutral.test.sh`);
- `create-secrets-selftest` (`bash scripts/create-secrets.test.sh`);
- `publish-platform-images-selftest` (`bash
  scripts/publish-platform-images.test.sh`);

then `analytics-key` (`bash scripts/check-no-analytics-key.sh`) and its
self-test.

**The static gates are `scripts/gates/static.sh`'s**: `bash
scripts/gates/static.sh --work <new folder>` runs them one at a time — its
fixed list (the gates above, in this order: naming, licenses, the
collector image's entrypoint and build-script tests, the
supervisor-collector chart's render tests, the pin check, typecheck root
and web, lint, the web's build, `cli-build`, `cli-package`, the gateway's
log check, the platform chart's render tests, the cloud-neutral check, the
analytics-key check), then every `scripts/**/*.test.sh` and
`scripts/release/check-*.sh` it finds, sorted, so a new check or self-test
joins in the commit that adds it (`--list` prints them all) — each gate's
log redacted by `scripts/gates/redact.sh` into the work folder, its exit
code recorded, with a summary table, then each failed gate's FAIL lines
and the end of its redacted log (so a runner's job output says why); exit
0 only when every gate passed. Before any gate it points `DOCKER_CONFIG`
at a folder of the work folder holding no login and puts refusing
credential-helper stand-ins first on `PATH`: a call to one fails the run.
Every `scripts/release/check-*.sh` runs offline from the repository's root
with no argument; a check that needs a registry, an argument or the
network is a `verify-*.sh` and isn't discovered. Among the discovered:
`scripts/release/check-version.sh` (one release version everywhere it is
written), `check-compose-install.sh`, `check-readme-quick-start.sh`,
`check-workflows.sh`, and `check-doc-links.sh` (every relative link in
`README.md`, `docs/*.md`, `docs/conventions/*.md`, the chart's README and
`deploy/compose/README.md` leads to a file of the repository, and every
`#anchor` to a heading in it).

**The other gate helpers:** `scripts/gates/stack.sh
up|ready|down` runs the stack smoke's throwaway Compose project (never
`telflo`, `telflo-dev` or `telflo-platform`; ports on 127.0.0.1;
`--images dev-tag:<tag>|release:<version>`; `--site oss|saas`) and
`. scripts/gates/smoke-env.sh oss|saas <work>` exports the smoke's settings
for it ("The three smokes" above); `scripts/release/tools.sh` keeps the
private tools ("The private tools" below). Each has a self-test beside
it.

The full suite also runs the validator's and the tester's test images, the
images' amd64 build (`scripts/publish-platform-images.sh --build`, image
by image), the browser tests on both pairs ("Browser tests on two pairs"
above), an image part ("The images hold no development dependency" above),
the three smokes ("The three smokes" above: the stack smoke in `oss` and
`saas` modes, and once on S3; the archive smoke; the kind smoke on the
chart's defaults, with `--images` and `--chart`) and the rehearsal
(below).

## The private tools

The release's tools that the machine doesn't have, or has too old, are the
repository's own, never installed system-wide:
`scripts/release/tools.lock` pins kind, crane and buildx (each release
binary's URL and sha256 for macOS arm64 and Linux amd64, from the
project's own published sums) and the images the local runs need (the kind
node, `registry:2`, BuildKit, BuildKit's SBOM generator, Postgres and
Mailpit), each by digest. `scripts/release/tools.sh`:
- `fetch [<tool>]` downloads each tool for this machine into the
  git-ignored `.tools/<tool>/<version>/` and checks its sha256 before it
  may run, and the binary's own sha256 when it comes out of an archive
  (crane; a mismatch deletes the download and exits 1);
- `path <tool>` prints the checked binary's path, or exits 1 (it never
  downloads): the binary is hashed again and must be `tools.lock`'s binary
  sha256 for this platform; the scripts take kind and crane only from it
  (in a workflow, crane must be exactly this checked file). With `CI` set,
  `TELFLO_TOOLS_DIR`, `TELFLO_TOOLS_LOCK` and `TELFLO_TOOLS_PLATFORM` are
  refused;
- `docker-config <dir>` makes a temporary `DOCKER_CONFIG` holding no login
  and the checked buildx in its `cli-plugins/`, so `~/.docker` and Docker
  Desktop's settings are never touched;
- `pull <image-key>` pulls an image the lock lists, by its digest only;
  `ref <image-key>` prints that reference;
- `remove` removes the builder the lock names (`telflo-release`), every
  image it marks `remove`, and `.tools/`.

The first `fetch` and each first pull wait for a maintainer's yes, except
the rehearsal's own. A runner installs the same versions, checked against
the same sums, in the workflow (`tonistiigi/binfmt`, QEMU's emulators, is
the runner's only and pinned by digest in the workflow files).

## The release workflow's tests

**What `.github/workflows/release.yml` runs** on a `v*` tag, each job one
call of a committed script: the tag's checks
(`scripts/release/verify-tag.sh`, and
`scripts/release/verify-collector-artifacts.sh`); the static gates
(`scripts/gates/static.sh`: everything above under "CI gates" that is
static, the discovered self-tests and checks included); the five images'
builds for both processor types into OCI archives with their attestations;
the chart's package, the Compose archive, `create-secrets.sh` and
`SHA256SUMS`; then, on the amd64 images taken from those archives
(`scripts/release/load-images.sh`), the stack smoke in `oss` mode only,
the archive smoke and the kind smoke with `--images` and `--chart`, each
through `scripts/release/steps.sh`, its output through
`scripts/gates/redact.sh`; and only after all of them, the stage
(`--push-oci` and `--push-package` with `--namespace telflo-staging`,
`scripts/release/pull-back.sh` of the stage, `steps.sh digests` writing
`digests.txt`, the draft GitHub Release with
`scripts/release/release-notes.sh`'s notes). **What
`.github/workflows/finalize.yml` runs**, by hand once the end-to-end tests
have passed on the stage: the draft and its tag checked (`steps.sh
finalize-check`), the stage copied to the public namespace by digest and
each copy checked by digest (`scripts/release/promote.sh`), the public
tags pulled back against `digests.txt` (`pull-back.sh --digests`), the
collector check, and the draft published (`steps.sh finalize-publish`).
It builds and tests nothing itself: the end-to-end tests are the owner's,
against the stage (`docs/releasing.md`, "Installing a staged release").

**What the release workflow doesn't run**: the unit suites and coverage, the browser tests,
the Go tests, the validator's and the tester's test images and the stack
smoke's `saas` mode. CI runs the suites, the browser tests, the Go tests
and the two test images ("CI gates" above: on the release's pull request,
and again on `main`), and the local full suite runs them all once before
the PR that makes a release commit is merged, and that PR records them.

`scripts/release/check-workflows.sh` (a static gate, with its self-test)
holds `release.yml`, `finalize.yml` and `collector.yml` to their rules:
the triggers (and the dispatch inputs: finalize's one `version`),
`permissions: {}` and each job's own, every action pinned by its full
commit SHA with its version as a comment (each parsed step's, not only
the text's lines), no `${{ … }}` inside a `run:`,
`persist-credentials: false`, `publish` needing every test job and tied
to the `release` environment, a timeout on every job, the concurrency
group, no `--no-attest`, every script a `run:`
names existing, and each job's safety steps present in order by their
exact lines, no step `if:`, each job's `needs` and outputs exactly its
own, each action's `with:` keys, each job's keys and every `env:` name
from allow-lists, and `load-images.sh` named `--platform linux/amd64`; and
each matrix and each job's own `env:` pinned exactly, with the collector
chart job's one allow-listed `!cancelled()` the only status function;
the publish job staging only (`--namespace telflo-staging`, a draft
Release with `digests.txt`), and `finalize.yml` copying only, its `run:`
steps its required ones and their tool setup, nothing that builds,
packages or pushes an archive (`docs/conventions/security.md`, "The
release pipeline"). It holds
`ci.yml` to its own, lighter set: only `pull_request` and pushes to
`main`; `permissions: {}`, each job `contents: read` (the `ci` job's
none); no secret, token or login; every action on the allow-list and
pinned; every checkout without its credential or another ref, repository
or path; exactly its jobs, each with a timeout on `ubuntu-24.04`, with
`ci` needing every other and `if: always()`; no job `if:`, no step `if:`
but on the reports' uploads and the stack's logs and teardown, no
`continue-on-error`, no `GITHUB_ENV`, `GITHUB_PATH` or `GITHUB_OUTPUT`;
the concurrency group; every service's image at `tools.lock`'s digest; the
opamp-server's clone at the PIN's tag; and every script a `run:` starts
existing. Its self-test has a fixture breaking each rule, known bypass
forms among them.

**The rehearsal.** The release workflows run nowhere before a tag, so
their steps are rehearsed on a laptop first: `scripts/release/rehearse.sh
--version <v> --work <dir> [--no-attest]` runs the release's scripts in the
workflow's order on the local Docker engine with the private tools, with a
throwaway `registry:2` on 127.0.0.1 standing in for GHCR (the push scripts
take `--registry` for a loopback address only, so it never names GHCR as a
push target): the tag's checks on a throwaway clone with a local annotated
tag, the collector path (its images and chart pushed to the local
registry, then `verify-collector-artifacts.sh` against it), the static
gates, the five builds, the packages, the loads (the machine's own
platform: `linux/arm64` on an Apple-silicon Mac, natively, where the
workflow loads `linux/amd64`), the three smokes, then the stage
(`--push-oci`, `--push-package` and `pull-back.sh` with `--namespace
telflo-staging` against the local registry, `digests.txt`) and the
notes, and then the finalize's copy (`promote.sh` from that
`digests.txt`) and `pull-back.sh --digests` of the local registry's public
namespace. `--no-attest` is only for a builder too old to attest, and the run
records it. It fetches its private tools and pulls `tools.lock`'s images
itself, refuses the development stack's projects and ports, and a battery,
checks the kube context and kubeconfig before and after, and ends with a
summary; `--keep` and `--cleanup --work <dir>` keep and then remove what
it made (`--cleanup` refuses while a rehearsal runs: its marker's labels).
Its header has the rest; `docs/releasing.md`, "Rehearse a release on your
machine", is how to run it. The full suite runs it once, end to end,
before a release's merge.
