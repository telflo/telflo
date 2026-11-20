# Developing Telflo

<!-- naming-check: allow-telflow-references -->
<!-- This document quotes the banned misspelling when it states the naming rule
     (Naming, below). See docs/conventions/naming.md. -->

How to work on Telflo from a checkout: the design, running the API and
the web app from source, the services they need, the development stack in
containers, the tests and the repository's layout. To install a release
instead, see the [README](../README.md).

**Contents:** [Background](#background) · [Design](#design) ·
[Running locally](#running-locally) ·
[The services in development](#the-services-in-development) ·
[The file store in development](#the-file-store-in-development) ·
[The collector image](#the-collector-image) ·
[Sign-in and sessions in development](#sign-in-and-sessions-in-development) ·
[The tests](#the-tests) ·
[The whole stack in containers](#the-whole-stack-in-containers) ·
[Testing](#testing) · [Naming](#naming) ·
[Repository layout](#repository-layout)

## Background

Telflo is built on its own Node/TypeScript API and Postgres, with the
opamp-server, its own open-source project, behind a clean code and schema
boundary and a management API secured by a shared secret. It is a
self-hosted install, invitation-only by default. A hosted service or
another package built on it does so from its own repository, through
generic extension points only.

## Design

The design's highlights, which a contribution keeps:

- **Stack** — Fastify + TypeScript, Kysely over `pg`, Postgres 18 with
  `uuidv7()` primary keys, `node-pg-migrate`, Zod contracts shared by API and
  web, Vitest, React Router v7 + Zustand + Tailwind.
- **Authorization** — structural service-layer org scoping that cannot be
  bypassed, a generated cross-tenant test suite, and row-level security as a
  targeted database backstop.
- **Identity** — short-lived access JWT plus rotating opaque refresh token, both
  in `HttpOnly` cookies, with reuse detection. Federated sign-in built as
  generic OIDC rather than as Google.
- **No account without an organization** — registration creates a personal
  organization and an admin membership in the same transaction as the user,
  and deferred database triggers refuse any change that would leave an
  account with no membership.
- **The opamp-server is reached only through its API** — it has its own
  database, `telflo_opamp_server`, and neither side's roles can connect to the
  other's database, so the open-source boundary is verifiable rather than a
  convention.

## Running locally

Requires Node.js ≥22 and Docker.

```bash
git clone <this repo> && cd telflo/telflo-core   # all npm commands run from here
npm install
cp .env.example .env             # defaults already match docker-compose.yml's ports

npm run dev:services             # postgres (55432) + mailpit (SMTP 51025, UI 58025) + the opamp-server (51235; collectors poll 51234) + the collector validator (51236) + the collector tester (through its forwarder, 51237) + the OTTL evaluator (through its forwarder, 51238) + the object store (S3 on 51240) — waits until healthy
mkdir -p ~/.telflo/file-store    # the file store's root; set TELFLO_FILE_STORE_ROOT in .env to it (docs/configuration.md)
                                 # and set TELFLO_INSTALL_TEMPLATES_DIR in .env to this checkout's install-templates/
npm run db:migrate               # migrates as the owner, syncs the collector catalog, then creates the API's own database role

npm run dev --workspace=apps/api # API on :8080
npm run dev --workspace=apps/web # web on :53000, in another terminal
```

[http://localhost:53000](http://localhost:53000) sends you to the sign-in
page, or to `/app` once you're signed in. With the open-source defaults
([the site's settings](configuration.md#the-site)) nobody can register:
make the first account with `telflo-admin bootstrap`
([Administration](configuration.md#telflo-admin-bootstrap); from
`telflo-core/`, with the API's environment:
`npx tsx apps/api/src/admin/telflo-admin.ts bootstrap --email <email> --organization <name>`).
It prints a link to set the password, as its last line; it never emails
one. Mailpit's own UI is [http://localhost:58025](http://localhost:58025).
To register instead, set `TELFLO_REGISTRATION=open` for both the API and
the web dev server, then open
[http://localhost:53000/register](http://localhost:53000/register), submit
the form and click the verification email's link in Mailpit. Registration
also creates your personal organization. Then sign in at
[http://localhost:53000/login](http://localhost:53000/login): you land on
`/app` inside the signed-in shell, and the organization button at the
bottom of the sidebar opens the account popover with Logout. A new sign-in
starts in the organization you were last in (your most recently used
earlier session's), else the one you joined most recently, else your
personal organization: the first admin's first sign-in lands in the
bootstrap's organization. On `/login`, "Forgot password?" emails a reset
link to Mailpit; it sets a new password and signs out every session.

## The services in development

Every setting below is described in
[docs/configuration.md](configuration.md); this section is how
`npm run dev:services` and `.env.example` wire them for a native API.

**The opamp-server** is required: the API refuses to start without
`TELFLO_OPAMP_MANAGEMENT_URL` and `TELFLO_OPAMP_MANAGEMENT_SECRET`, which
`.env.example` sets to the local one (`http://127.0.0.1:51235` and
compose's development-only secret). `npm run dev:services` starts it, after
the one-shot containers that create its roles and database
(`opamp-bootstrap`, re-run each time, which changes nothing) and migrate it
(`opamp-migrate`), then waits for its `/health`, printing its logs if it
doesn't answer. The opamp-server has its own repository,
`github.com/telflo/opamp-server` (public, Apache-2.0), and the stack runs
its published release, `ghcr.io/telflo/opamp-server`, pinned by version and
digest (`vendor/opamp-server/PIN`; 0.3.0 since Telflo 0.1.2). The image is
public: the first run pulls it with no login. To run a change to the
opamp-server before it is released (built from a clone beside this one,
`../opamp-server`, with `docker-compose.opamp-server-dev.yml`), and to take
a merged change through testing and a release, see
[`docs/conventions/opamp-server.md`](conventions/opamp-server.md). Tests
and browser tests never use it: they run the API against an OpenAPI-checked
fake, checked against the release's `openapi.yaml`
(`vendor/opamp-server/openapi.yaml`).

**The collector validator** (`services/otelcol-validator`) checks a
configuration with the collector version it is pinned to. `npm run
dev:services` starts it and waits for its `/health` on
`http://127.0.0.1:51236`. Its first start builds its image,
`telflo-otelcol-validator:dev`, from the repository's root, with every
collector version the catalog offers (four today: about 1.7 GB, a few
minutes); `OTELCOL_VERSIONS=default npm run dev:services` bakes only the
default version (about 570 MB). The variable counts only when the image is
built, and Compose reuses the image it has: to change what an existing one
holds, or after a catalog or service change, rebuild it from the
repository root with `docker compose build otelcol-validator`
(every offered version; prefix `OTELCOL_VERSIONS=default` for the lighter
one), then run `npm run dev:services` again. The API requires it: it refuses
to start without `TELFLO_OTELCOL_VALIDATOR_URL` and
`TELFLO_OTELCOL_VALIDATOR_SECRET`, which `.env.example` sets to the local
one (`http://127.0.0.1:51236` and compose's development-only secret). An
editor's check goes through the API's
`POST …/versions/{versionId}/validation`; when the validator is down, slow
(20 seconds) or busy, the check answers "unavailable" and nothing else
breaks. Tests and browser tests never use it: they run the API against an
OpenAPI-checked fake.

**The collector tester** (`services/otelcol-testing`) runs
a configuration's test runs: the pinned collector in a sandbox, fed the
run's input, with kwok's fake Kubernetes cluster beside it. `npm run
dev:services` starts it (`otelcol-testing`) and its forwarder
(`otelcol-testing-forward`), and waits for its health on
`http://127.0.0.1:51237/testing/v1/health`. The tester sits on a Docker
network with no way out, where Docker publishes no port, so only the
forwarder, an nginx pass-through, publishes it, on the host's
`127.0.0.1:51237` for the natively run API. Its first start builds
`telflo-otelcol-testing:dev` from the repository's root with every offered
collector and kwok (about 2.0 GB); `OTELCOL_VERSIONS=default npm run
dev:services` bakes only the default collector (about 0.88 GB), and
`docker compose build otelcol-testing` rebuilds it, as for the
validator. It answers 503 for a few seconds after a start, until kwok's
cluster is up. Its secret is read from a file,
`docker/otelcol-testing/development-secret`, never from its environment.
The API requires two settings and reads two more
([docs/configuration.md](configuration.md#the-collector-tester)).

A run is queued by the API, which takes turns per person and sends it to
the tester when a slot is free. While the tester is down, a new run is
refused with "Testing is unavailable right now. Try again later." and
nothing else breaks. Tests and browser tests never use it: they run the API
against an OpenAPI-checked fake.

**The OTTL evaluator** (`services/ottl-evaluator`) checks test runs'
validation rules (text, regex and OTTL) after the tester answers, and each
OTTL or regex rule, and each regex library entry, when it is saved.
`npm run dev:services` starts it (`ottl-evaluator`) and its own forwarder
(`ottl-evaluator-forward`), and waits for its health on
`http://127.0.0.1:51238/health`. Like the tester, it sits alone on a Docker
network with no way out, so only its forwarder publishes it, on the host's
`127.0.0.1:51238`. Its first start builds `telflo-ottl-evaluator:dev` from
`services/ottl-evaluator` (a small Go image); after changing its code,
rebuild it with `docker compose build ottl-evaluator` from the repository
root. Its secret is read from a file,
`docker/ottl-evaluator/development-secret`, never from its environment. The
API requires two settings
([docs/configuration.md](configuration.md#the-ottl-evaluator)).

While the evaluator can't be reached, saving a rule that needs checking is
refused ("Rules can't be checked right now. Try again shortly."), a run
that would carry rules is refused when it is queued, and a run already
under way whose rules can't be checked ends Error with its output kept;
runs without rules and everything else work as before. It checks at most 4
runs' rules at once, so `TELFLO_TEST_RUNS_PER_TESTER` above 4 (the tester's
own cap too) only makes bursts wait or fail. Tests and browser tests never
use it: they run the API against an OpenAPI-checked fake.

## The file store in development

The file store's kinds and settings are in
[docs/configuration.md](configuration.md#the-file-store). In
development, `.env.example`'s root is `/var/tmp/telflo/file-store`; create
the directory you name first (`mkdir -p ~/.telflo/file-store`) and give
its absolute path (`/Users/<you>/.telflo/file-store`): a relative path,
or `~`, refuses to start. To run the API natively on `s3`, point the
settings at `npm run dev:services`' object store (`.env.example` has the
lines, commented) and export its development-only keys, the
`TELFLO_TEST_S3_*` values below, as `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` in that shell only. Running the whole stack on S3
is under [The whole stack in containers](#the-whole-stack-in-containers).

The tests build their stores from explicit settings: the local store on
temporary directories of their own, and the S3 store against `npm run
dev:services`' object store (`object-store`, a pinned SeaweedFS
4.48, on the host's `127.0.0.1:51240`), in a bucket of their own
(`telflo-test`). They read `TELFLO_TEST_S3_ENDPOINT`,
`TELFLO_TEST_S3_ACCESS_KEY_ID` and `TELFLO_TEST_S3_SECRET_ACCESS_KEY`,
which `.env.example` sets to compose's development-only values (they
unlock only that local container), refuse an endpoint that isn't on the
loopback, and fail when any is unset rather than skip. They clear every
`AWS_*` variable (set to empty) and point the shared AWS files at a path
that doesn't exist first, so your own AWS identity never reaches a test.
The first `npm run dev:services` pulls the pinned SeaweedFS
image (about 500 MB on disk); a failed pull, or another program on port
51240, fails its second `up -d`, and so the whole command.

## The collector image

The container install's image is built from
`docker/collector-image/` (otelcol-contrib and the OpAMP supervisor, one tag
per collector version), published as `ghcr.io/telflo/telflo/collector`
for every collector version the catalog offers, with the
supervisor-collector chart (`charts/supervisor-collector/`). Both are
published by the collector workflow, started by hand, never by a person's
push. To build one image locally,
`scripts/build-collector-image.sh <version>`. Their tests:
`docs/conventions/testing.md`, "The collector image", "The chart's render
tests" and "The publish scripts". A host installing from the container
stack must reach the agent endpoint the command names: compose publishes
51234 on the host's 127.0.0.1 only, so a VM on the LAN needs the port
published on the LAN and `OPAMP_SERVER_URL` set to the host's LAN address.

The development stack's API mounts the repository's `install-templates/`
over the image's copy, read-only
([docs/configuration.md](configuration.md#telflo_install_templates_dir)).

## Sign-in and sessions in development

**Google sign-in** ([docs/configuration.md](configuration.md#google-sign-in))
needs a Google OAuth client with the redirect URI
`http://localhost:53000/api/v1/auth/oidc/google/callback` (and
`http://localhost:50080/…` for the container stack). Set
`TELFLO_OIDC_GOOGLE_CLIENT_ID` and `TELFLO_OIDC_GOOGLE_CLIENT_SECRET` in
`telflo-core/.env`, and restart the API dev server: settings are read only
at startup. The tests never call Google: they use a fake provider.

**Mail** goes to Mailpit, in plain SMTP (`TELFLO_SMTP_TLS=none` in
`.env.example` and compose); Mailpit's own UI is
[http://localhost:58025](http://localhost:58025).

`TELFLO_API_INTERNAL_URL` is read by the web server's loaders. The web
server has settings of its own. The dev server reads them from
`telflo-core/apps/web/.env` (gitignored) or the shell, not from
`telflo-core/.env`; restart it after changing them. Locally,
`TELFLO_PUBLIC_WEB_URL` is `http://localhost:53000`. No PostHog key is ever
committed: `scripts/check-no-analytics-key.sh` fails on one in a tracked
file. The cookie banner links to `TELFLO_COOKIE_POLICY_URL`.

The access token lasts 15 minutes; when a request finds it expired, the web
client refreshes it once and retries, so a session lasts as long as its
30-day refresh token. Every state-changing `/api/v1` request needs the
header `X-Telflo-CSRF: 1`.

## The tests

`npm test` runs the whole suite
against the same services (`dev:services` must be up first). It uses its own
`telflo_platform_test` database, created and migrated automatically, so your
development data is never touched. See
[Testing](#testing) below and `docs/conventions/testing.md` for the rest
(`npm run test:coverage`, `npm run typecheck`, `npm run lint`).

`npm run test:e2e` runs the browser tests (`telflo-core/e2e/*.e2e.ts`) in
Chromium, Firefox and WebKit with Playwright. Install the browsers once
with `npx playwright install chromium firefox webkit`. The tests start two
pairs of an API and a web dev server: the default pair (API 28080, web
23100) runs the open-source defaults, and the SaaS's pair (API 28081, web
23102) the SaaS's site values (registration open, the playground and the
reads without signing in on, the Terms asked), for the tests of those; then
a web dev server on 23101 (the one with analytics on, on the SaaS's values,
beside a PostHog stub on 127.0.0.1:28095), fake Google on 127.0.0.1:28090
(another site from `localhost`, as Google is), the OpenAPI-checked fake
opamp-server on 127.0.0.1:28085 (with a test-only control port on 28084,
`E2E_OPAMP_CONTROL_PORT`, through which the tests enroll collectors, set
their state and reported attributes, record their errors, and seed a
fleet's token history), the fake collector validator on 127.0.0.1:28086,
the fake collector tester on 127.0.0.1:28087 (with a test-only control
route on 28088) and the fake OTTL evaluator on 127.0.0.1:28089, against
their own `telflo_platform_e2e_test` database and file store
(`telflo-core/test-results/file-store`), so they run alongside your dev
servers and a vitest run. Only Postgres and Mailpit must be up. Playwright
refuses to start if any of those ports is already taken.

## The whole stack in containers

To run the product the way it's installed, every component in a container
behind one gateway, from the repository root:

```bash
docker compose up --build --wait # everything at http://localhost:50080 (Mailpit UI on :58025)
TELFLO_SMOKE_SITE=saas ./scripts/smoke-test-stack.sh   # through the gateway: accounts, organizations, invitations; the opamp-server through the platform's client; configurations, versions and a publish; a fleet with real collectors; an organization's logo and a library link; robots.txt, the playground and a sales inquiry (on the SaaS's values: below)
docker compose down              # add -v to also delete the volumes: the database's, the file store's and the object store's
```

The smoke takes `TELFLO_SMOKE_SITE=oss|saas`, required, with no default,
and `scripts/gates/smoke-env.sh` sets each mode's values
(`docs/conventions/testing.md`). `oss` runs the open-source defaults, on a
throwaway stack only (`COMPOSE_PROJECT_NAME` set and none of the guarded
projects `telflo`, `telflo-dev` and `telflo-platform`, which aren't
throwaways): registration is refused, the first account comes from
`telflo-admin bootstrap`, which the smoke runs itself, and the others join
by invitations read from Mailpit. `saas` runs the SaaS's values, described
below.

This needs a current Docker Compose. v2.6 waits forever on the one-shot
containers (the migrations, and the opamp-server's bootstrap), so on an old
version use `docker compose up --build -d` and check `docker compose ps`
instead. The stack and the native setup above share Postgres and Mailpit,
so both can run at the same time. `scripts/smoke-test-stack.sh` runs this
stack locally.

The stack runs the site's settings from the shell, with the open-source
defaults for any unset: invitation-only, so its first account comes from
`docker compose exec api telflo-admin bootstrap --email <email> --organization <name>`,
which prints the link to set the password as its last line (no email). In
`saas` mode the smoke test registers (accepting the Terms at version
`2026-01-01`), opens the playground and sends a sales inquiry, so it needs
the stack started with the SaaS's values (the browser tests' SaaS pair's,
plus the inquiries): `TELFLO_REGISTRATION=open`, `TELFLO_PLAYGROUND=true`,
`TELFLO_ANONYMOUS_VALIDATE=true`, `TELFLO_PUBLIC_FLOWS=true`,
`TELFLO_TERMS_VERSION=2026-01-01` with `TELFLO_TERMS_URL` and
`TELFLO_PRIVACY_URL` set (`/home/terms-of-service` and
`/home/privacy-policy`), `TELFLO_EMAIL_NOTIFICATIONS=true`,
`TELFLO_SALES_INQUIRY=true` and `TELFLO_SALES_INQUIRY_TO` set to an
address, exported in the shell that runs both `docker compose up` and the
smoke, which reads `TELFLO_SALES_INQUIRY_TO` too and fails when it is
empty.

The stack includes the opamp-server, in three containers:
`opamp-bootstrap` creates its roles and its database, `telflo_opamp_server`,
on the stack's Postgres; `opamp-migrate` migrates it; and
`opamp-server` serves its management API, which the API container
reaches as `http://opamp-server:51235` with the stack's
development-only secret. Compose publishes the port in plain HTTP on the
host's 127.0.0.1 only, at `http://127.0.0.1:51235`. The server can speak
TLS instead (`OPAMP_MANAGEMENT_TLS_CERT_FILE` and
`OPAMP_MANAGEMENT_TLS_KEY_FILE`, optional); the `README.md` of its
repository, `github.com/telflo/opamp-server`, is its self-hoster's guide.
`opamp-migrate` and `opamp-server` run its published release,
`ghcr.io/telflo/opamp-server`, pinned by version and digest
(`vendor/opamp-server/PIN`), and the bootstrap runs that release's
`bootstrap.sql` (`vendor/opamp-server/bootstrap.sql`); the image is public,
so pulling it needs no login.
`scripts/check-opamp-server-pin.sh` checks that the PIN, the vendored files
and compose's two image lines agree, and
[`docs/conventions/opamp-server.md`](conventions/opamp-server.md) is the
guide to running an unreleased change with
`docker-compose.opamp-server-dev.yml` and to releasing it.

Before its configuration steps, the smoke test posts, reads, lists and
deletes a publication with the platform's real client, run inside the API
container; it then publishes version 2 through
the gateway, checks in the real opamp-server that the snapshot is version
2's, by its id, and holds the YAML saved, by its SHA-256, and that none is
left once the configuration is deleted; and it checks that each side's role
is refused the other's database.

Collectors reach the opamp-server's agent endpoint on its own port,
published at `http://127.0.0.1:51234/opamp/api/v1`, never through the
gateway; a collector is handed `OPAMP_SERVER_URL`, by default
`http://host.docker.internal:51234/opamp/api/v1`, which a container on
Docker Desktop reaches (set it to `http://localhost:51234/opamp/api/v1` for
a collector run natively). The bearers' key is the committed development
file `docker/opamp-server/development-encryption-key`. The smoke test then
creates a fleet through the management API, starts real collectors (the
OpAMP supervisor 0.162.0 with `otelcol-contrib`, `docker/smoke-collector/`)
with its default token, and sees them take the rotate token, one apply a
published version and another, with nothing assigned, poll through a second
replica and be sent no configuration, and a revoked token refused on both
replicas. Its collectors must reach the URL the server hands them: the
development default works on Docker Desktop with the stack's own published
51234; elsewhere start the stack with
`OPAMP_SERVER_URL=http://opamp-server:51234/opamp/api/v1`, as CI's stack
job does.

With the collector image built locally for the catalog's default version
(`scripts/build-collector-image.sh <version>`; without it the install steps
are skipped, saying why), the smoke test also installs collectors through
the platform, and makes quick-deploy links whose Quick Deploy command it
runs for real in the image on the compose network. Those steps need the
API's `TELFLO_PUBLIC_API_URL` to be `http://gateway`, the gateway as a
container on the compose network reaches it, and fail naming it otherwise:
compose's default, `http://host.docker.internal:50080`, would send the
commands to whatever gateway listens on the host's port 50080. Start a
throwaway stack for the smoke with `TELFLO_PUBLIC_API_URL=http://gateway`
set (`docs/conventions/testing.md`).

In the group organization, the smoke test also sets a 2 MiB PNG logo
through the gateway, finds its id in `/me`, and reads it back
publicly with no cookie, checking its bytes and headers (`image/png`,
immutable caching, `nosniff`, `Content-Security-Policy: sandbox`,
`Cross-Origin-Resource-Policy: cross-origin`, no `Set-Cookie`); a body over
3 MiB is the gateway's own 413. After the organization's delete the logo's
read is a plain-text 404. Only on a throwaway stack (as the regex library's
product-admin steps below, granting and clearing the flag on their own),
it adds a 10 MiB library file as a product admin (11 MiB and a byte is the
gateway's 413), makes its link and downloads it from the host through the
gateway with no session (its bytes, `application/octet-stream`,
`no-store`, `nosniff`, `attachment`), deletes the file (the link then
404), and finds no `tll_` in the API's or the gateway's logs, the access
log holding exactly one redacted `GET /api/v1/library-links/[redacted]`
line with 200 and one with 404. It never prints the link. A run that stops
partway deletes the file's row by SQL. On `s3`, it also checks that the
object store holds the logo at its key with its size, and that the object
is gone after the organization's delete.

Then, only on a throwaway stack (as the library's steps, granting and
clearing the flag on their own), the account is made a product admin by
SQL and drives the product-admin routes through the gateway, every answer
`no-store`. It finds itself the only product admin listed (the run fails
otherwise), grants the invitee by email (201, then 200), lists both,
removes the invitee, and is refused its own removal, 409
`last_product_admin` (the one real last-admin refusal outside the
integration tests: the browser tests' database holds other workers'
admins). The invitee sends feedback; the product admins' email reaches the
account in Mailpit naming the invitee, without the text; the item is
listed, dismissed, and then 404. The invitee's delete is refused 409
`user_delete_blocked` (a member of the group organization), the account's
own 409 `user_delete_self`. A third account is registered, verified and
signed in, found by its address, and deleted: its `/me` and refresh are
then 401, its sign-in 401, its personal organization (registered in the
opamp-server before the delete) is gone from it, and by SQL its deletion
record and its anonymous address are there, its address is free, no
organization's name holds it and none of its sessions holds an IP address
or user agent. The API's and the gateway's logs hold the
search's term on no line, and the gateway logged the search by its path
alone. Replies holding other people's emails or the feedback's text are
never printed, and the third account's address is in no step line. A run
that stops partway clears the invitee's flag and its own by SQL.

The stack includes the collector validator, `otelcol-validator`,
which the API container reaches as `http://otelcol-validator:8001`;
Compose also publishes it on the host's `127.0.0.1:51236`, for the native
API. `docker compose up --build` builds its image with every collector
version the catalog offers (four today, about 1.7 GB). For a lighter
stack, `OTELCOL_VERSIONS=default docker compose up --build --wait` bakes
only the catalog's default (about 570 MB), as CI's stack job does; a
version the image doesn't hold is answered as unavailable. The stack and
`npm run dev:services` share the image (`telflo-otelcol-validator:dev`), so
the next `docker compose up --build` without the variable, or `docker
compose build otelcol-validator`, returns it to every offered
version.

The stack includes the collector tester,
`otelcol-testing`, which the API container reaches as
`http://otelcol-testing:8002` on the tester's internal network, and
its forwarder, `otelcol-testing-forward`, on the host's
`127.0.0.1:51237`. `OTELCOL_VERSIONS` works as for the validator. The
tester runs with a read-only root filesystem, no Linux capabilities and
its secret from compose's `secrets:`; `services/otelcol-testing/README.md`
has the details. The API keeps its files on the volume `file-store`
(or in the object store, below), which `docker compose down -v` deletes.
The smoke test checks the tester's health through the forwarder, then
uploads a small OTLP document through the gateway, queues a real run on
the version's pin and reads its output back, then runs a test suite's
configuration made from that file.

The stack can keep the API's files in an object store instead:
`TELFLO_FILE_STORE=s3 docker compose --profile s3 up --build -d` starts
`object-store`, a pinned SeaweedFS 4.48 (Apache-2.0), with its bucket
`telflo-files` and its data on the volume `object-store`, and runs the API
on it (the API waits for the bucket through the one-shot
`file-store-ready`). Its S3 port is published on the host's
`127.0.0.1:51240` only, and its other ports, which take requests without
credentials, sit on a network of its own that only the API and the one-shot
join. Its keys are compose's development-only values: they unlock only that
container. It is a development and test server here, in no bundle or chart.
Two things to know. **A plain `docker compose up -d` on a stack running on
S3 recreates the API on the local disk**: keep `TELFLO_FILE_STORE=s3` and
`--profile s3` on every `up` (on the local disk, the files written on S3
answer "not found" until the API is back on S3, and the other way round).
**A plain `docker compose down -v` deletes the object store's volume too**,
with the database's and the file store's. `TELFLO_FILE_STORE=s3` without
the profile makes the one-shot give up after about a minute, saying to
start the stack with `--profile s3`, and the API doesn't start, unless the
object store is already running (`npm run dev:services` starts it in the
same project). On `s3`, the smoke test also checks that the object store
holds the uploaded file at its key with its size, the run's output and a
definition's input, and that the API's volume doesn't hold the upload;
`TELFLO_SMOKE_FILE_STORE=local` or `s3` makes it fail when the stack runs
on the other kind. Never print the object store's logs: they name the
access key id.

The stack includes the OTTL evaluator, `ottl-evaluator`, which the API
container reaches as `http://ottl-evaluator:8003` on the evaluator's own
internal network, and its forwarder, `ottl-evaluator-forward`, on the
host's `127.0.0.1:51238`. It runs with a read-only root filesystem, no
Linux capabilities, its secret from compose's `secrets:`, and limits on
memory and processes; `services/ottl-evaluator/README.md` has the details,
and `services/ottl-evaluator/scripts/check-container.sh` checks a running
one from the inside. The smoke test checks its health through the forwarder
and its refusals without the secret, then, through the gateway, saves
validation rules the real evaluator checks (refusing a broken condition and
regex), runs a test whose rules pass and one that ends Validation Failed,
and finds the rules copied to version 2. It reads the regex library, saves
a library entry as a rule and a rule as Compare's "Create an OTTL rule"
writes one, and runs them on a file whose extra record carries the
attribute `y`, finding that record, `y` and all, in the run's output. Only
on a throwaway stack, with `COMPOSE_PROJECT_NAME` set and not `telflo-dev`
(this file's project), `telflo` or `telflo-platform`, does it then make its
account a product admin by SQL on the stack's own database, create, rename
and delete an entry (a lookahead refused by RE2) and clear the flag again;
otherwise it skips those steps and prints why. A run that stops partway
through them deletes the entry it created, if it's still there, and clears
the flag. A smoke run against a throwaway stack on other ports sets
`TELFLO_OTTL_EVALUATOR_HOST_URL` to its forwarder, as it sets the other
host URLs. The identity routes allow 30 requests per IP in 5 minutes. A run
makes 11 of them (register, verify, three sign-ins and the old password's
refused one, the invitation's preview and registration, the reset's request
and reset, and Google's start), 15 on a throwaway stack (the third account
registers, verifies, signs in and is refused once deleted), so a third
quick run in a row is refused 429 at register or sign-in until the window
moves on.

Compose reads `.env` from the repository root, not `telflo-core/.env`. To
give the stack your Google client, pass it explicitly:
`docker compose --env-file telflo-core/.env up --build -d`.
`./scripts/smoke-test-stack.sh` checks that no OIDC provider is listed, so it
fails on a stack started that way; run it on one started without
`--env-file`.

Ports are project-specific, not the tools' own defaults, so they don't collide
with a Postgres or Vite instance you already have running — see the comments
in `.env.example` and `docker-compose.yml` for why each one was chosen.

## Testing

The team is small and cannot manually test frequently. **The test suite is
the only regression detection that exists**, so tests are written against
each method's contract rather than its implementation.

## Naming

`telflo`, never `telflow`. Checked locally: `npm run check:naming` in
`telflo-core/` runs `scripts/check-naming.sh` over the whole repository.
The full naming standard and ubiquitous language are in
`docs/conventions/naming.md`.

## Repository layout

The root holds only what applies to the whole repository. Each technology's
tooling lives in the directory it serves.

```
telflo-core/             The TypeScript npm workspace: its own package.json,
│                        lockfile, node_modules, tsconfig, eslint, vitest, .env
├── apps/
│   ├── api/             Fastify + TypeScript
│   └── web/             React Router v7 + Zustand + Tailwind
└── packages/
    ├── contracts/       Zod schemas + inferred types — used by BOTH apps
    ├── db/              migrations, Kysely types, repository base
    └── tsconfig/        shared TS, ESLint, Vitest config
services/                Go and Python services: otelcol-validator, otelcol-testing, ottl-evaluator; the opamp-server has its own repository
catalog/                 The collector catalog: distributions and versions, read by several components (catalog/README.md)
vendor/opamp-server/     The opamp-server's contract files (openapi.yaml, bootstrap.sql, the fill-in corpus), byte for byte its pinned release's, and PIN
scripts/check-naming.sh  Repository-wide naming guard (bash; scans every file)
scripts/check-licenses.mjs  License guard: shipped npm deps must be redistributable
scripts/check-opamp-server-pin.sh  The opamp-server's drift check: the PIN, vendor/opamp-server/ and compose's image lines agree
scripts/check-no-analytics-key.sh  Fails on a PostHog key in a tracked file
scripts/release/check-secrets.sh  The secret scan: gitleaks on every file git would commit; .gitleaksignore lists the reviewed fakes
charts/telflo/           The platform's Helm chart, with the opamp-server's vendored (its README.md)
charts/supervisor-collector/  The chart a Kubernetes fleet's collectors install with
deploy/compose/          The Compose install: compose.yaml, setup.sh and their files, released as an archive (docs/compose.md)
scripts/gates/           The full suite's static gates, the throwaway stack and the smoke's settings
scripts/release/         The release's scripts and checks: versions, the Compose archive, OCI copies, the private tools
docker/gateway/          nginx config for the stack's single entry point, and the comments-only extra-routes.conf compose mounts
docker/otelcol-testing/  The collector tester's development secret and its forwarder's nginx config
docker/ottl-evaluator/   The OTTL evaluator's development secret and its forwarder's nginx config
docker/collector-image/  telflo's collector image (otelcol-contrib and the OpAMP supervisor) for the container install
install-templates/       The Linux install bundles' default templates, read by the API from TELFLO_INSTALL_TEMPLATES_DIR
docker-compose.yml       The development stack (project telflo-dev): the whole product built from source, the opamp-server as its pinned release
docker-compose.opamp-server-dev.yml  Builds the opamp-server from ../opamp-server instead (docs/conventions/opamp-server.md)
docs/
├── configuration.md     Every setting, and the admin commands
├── compose.md           The Compose install, run for real
├── kubernetes.md        The Helm chart, installed
├── development.md       This file
├── releasing.md         How a release is built, checked and published
├── third-party-assets.md  Third-party logos and vendored files, with their sources and licenses
└── conventions/         naming · api · testing · security · go · opamp-server · cli
```
