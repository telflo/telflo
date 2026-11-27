# Changelog

Every release, newest first, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Each
release's images, Helm chart and Compose install are on its
[GitHub release](https://github.com/telflo/telflo/releases).

## Unreleased

## 0.2.5 - 2026-11-27

### Changed

- The opamp-server is 0.3.2 (was 0.3.1), in the Helm chart, the Compose
  install and the development stack. Its `migrate` gives up a connection
  attempt that gets no answer, and retries for up to two minutes while
  the database can't be reached, instead of hanging. No schema or API
  change.

### Fixed

- Helm chart: on a first install, the opamp-server's pods wait for
  `telflo-postgres` to answer before they run their migrations
  (`wait-for-postgres`, from opamp-server 0.3.2's chart). Before, the
  migrations could start while Postgres was still creating its databases
  and fail, and a restarted `migrate` could hang until
  `helm install --wait` timed out.
- Helm chart: the wait runs the platform's own Postgres image
  (`opamp-server.postgres.image`, set to `postgres.image`), so a cluster
  pulls and mirrors one Postgres image. The chart refuses the two set
  differently, and refuses `opamp-server.externalDatabase.urlKeys`, which
  would skip the wait and the check that the opamp-server uses
  `telflo-postgres`.

## 0.2.4 - 2026-11-25

### Changed

- The opamp-server is 0.3.1 (was 0.3.0), in the Helm chart, the Compose
  install and the development stack: its Go dependencies updated
  (`golang.org/x/net` 0.63.0, with `x/crypto`, `x/sync`, `x/sys` and
  `x/text`). No schema or API change.

## 0.2.3 - 2026-11-25

### Security

- The collector validator and the collector tester refuse a configuration
  holding a `!!binary` value. PyYAML reads it as its base64 text, but the
  collector decodes it and expands the configuration provider references
  in what it decodes, so a `${file:…}` or `${http:…}` reference written
  that way got past the neutralization: the collector read the file or
  made the request, and quoted the result in its errors. Such a text is
  now answered `refused`, and no collector runs.
- An install's needed environment variables are read in linear time.
  The scan of a published version's YAML took time in the square of its
  length on a long run of `$`, or of `${env:A:-` with no closing `}`: a
  member's 256 KiB version held the API's event loop, for every
  organization, for up to minutes, each time its install dialog or a
  quick-deploy download was opened.
- The CSRF header is required on every state-changing request but the
  public API's (`/api/public/v1`, which takes a bearer token and no
  cookie), decided by the route the request matched. Before, a spelling of
  the `/api/v1/` prefix the router decodes (`/%61pi/v1/…`) skipped the
  check and still reached the cookie-authenticated route.
- The gateway reads a request line in linear time when it decides whether
  to redact the line's URL as the public API's. The pattern was
  unanchored, with two greedy runs, and backtracked in the cube of the
  line's length: one request of about 6,600 characters, with no
  credentials, held an nginx worker for 20 seconds. The same fix is in the
  Helm chart's gateway, the Compose install's and the development stack's.
- An email confirmation link carries its token in the fragment
  (`/verify-email#token=…`), as the password reset and the invitation
  links do, so it never reaches a server, its logs or a `Referer`. Before,
  it was in the query, and the gateway logged it in full. A link sent
  before still works, and the gateway now logs `/verify-email` without its
  query and redacts a `Referer` naming it.
- `telflo config pull` and `telflo flows pull` print stored YAML to a
  terminal without its control characters, as every other human output
  does. Another member's YAML holding an escape sequence (concealed text,
  a link, a clipboard write) could drive the reader's terminal. Piped or
  redirected output is still the YAML byte for byte.
- `telflo login`'s browser handoff: the CLI's local listener no longer
  stops after ten refused requests, and the approval page sends the token
  (or Cancel's answer) only after the listener proves, with an HMAC of a
  fresh challenge keyed by the login's secret state, that it is this
  login's. Before, another process on the machine could stop the listener
  with ten requests, bind its port, and receive the token. A CLI older
  than this page's check gets the token to paste instead.
- The container install command (the install dialog's "Container image
  — pull and run", `telflo fleet install --platform docker` and the
  public API's docker install) sets the fleet's token and the included
  organization variables before `docker run`
  (`OPAMP_TOKEN='…' NAME='…' docker run … -e OPAMP_TOKEN -e NAME …`), so
  their values are in `docker`'s environment, never its command line,
  which every user on the host can read while it runs.
- The supervisor-collector chart 0.2.0 (the platform's default): the
  Agent's ClusterRole grants `get` on `nodes/stats` and `nodes/pods`, no
  longer `nodes/proxy`. `nodes/proxy` reaches every kubelet path, exec into
  any pod included, and any member who can deploy to the Agent's group
  could have its collector send its token out. `kubeletstats` needs only
  `nodes/stats`, plus `nodes/pods` for `extra_metadata_labels` and the
  request and limit utilization metrics. A kubelet older than Kubernetes
  1.33 (or without fine-grained authorization) asks for `nodes/proxy` for
  those two instead: on such a cluster they answer 403 until the release
  sets `kubeletProxy: true`, which grants it again.
- The same chart's `checksum/collector-env` pod annotation hashes the
  `collectorEnv` values together with the fleet's token. It was the
  values' bare sha256, so anyone who could read pods but not Secrets could
  test guesses at a weak value offline. The pods still roll exactly when a
  value changes.
- Creating an API token asks for the current password, when the account
  has one: a personal token in Settings' Create API token dialog and on
  the page `telflo login` opens, before Approve; a service account's token
  in its Create API token dialog, the admin's password. Before, a
  signed-in session alone could make a write token that never expires, and
  the token outlived the session's sign-out and a password reset (a service
  account's, even the admin's removal). A wrong password is refused and
  audited, counts toward the sign-in's failure limit, and makes nothing.
  An account that signs in only with Google is asked nothing.
  A script that creates tokens through the API sends the password as
  `currentPassword` in the create's body.

## 0.2.2 - 2026-11-22

### Added

- `TELFLO_IMAGE_REGISTRY` for the Compose install: where its five Telflo
  images come from, `ghcr.io/telflo/telflo` when unset or empty. Set it in
  the install's `.env` to pull from a mirror
  ([`docs/compose.md`](docs/compose.md), "Where the images come from").
- CI on every pull request and every push to `main`: the secret scan, the
  static gates, the unit and integration suites, the browser tests
  (Chromium on a pull request, all three browsers on `main`), the three
  services' tests and the full stack. `ci` is the one check a merge needs.
- Three site switches, each `false` by default
  ([`docs/configuration.md`](docs/configuration.md), "The site"):
  `TELFLO_USER_FEEDBACK` (the sidebar's Contact us and Product admin ›
  User Feedback), `TELFLO_LEARNING` (the sidebar's Learning, `/library`,
  and Product admin › Library) and `TELFLO_USER_ADMIN` (Product admin ›
  Users). Off, each one's nav items are hidden, its pages are 404s and
  its API routes answer 404 `not_found`. Their tables stay in every
  install.

### Changed

- A release is published in two steps. The tag's run tests the images,
  the chart and the Compose archive as before, then publishes them to
  `ghcr.io/telflo/telflo-staging` with a draft GitHub Release. The
  Finalize workflow then copies the same bytes, by digest, to
  `ghcr.io/telflo/telflo` and publishes the Release, so a version can be
  tested end to end before it's public
  ([`docs/releasing.md`](docs/releasing.md)).
- Contact us, Learning and Product admin's User Feedback, Library and
  Users are no longer shown by default. To keep them, set
  `TELFLO_USER_FEEDBACK`, `TELFLO_LEARNING` and `TELFLO_USER_ADMIN` to
  `true` (the chart's `site.userFeedback`, `site.learning` and
  `site.userAdmin`).

## 0.2.1 - 2026-11-20

### Security

- The gateway runs nginx 1.30.7 (`nginx:1.30-alpine`, pinned by digest) in
  the Helm chart, the Compose install and the development stack, as do the
  development stack's two forwarders. Before, they ran 1.27.5, which no
  longer gets fixes. Its HTTP/2 vulnerabilities, CVE-2026-123633 and
  CVE-2026-123007, never applied: the gateway speaks only HTTP/1.1.
- The development stack's `docker-compose.yml` publishes Postgres, Mailpit
  and the gateway on `127.0.0.1` only. Before, they listened on every
  interface, and Postgres used its committed development password. The
  release's Compose install (`deploy/compose/`) never published the
  database.

### Added

- [`SECURITY.md`](SECURITY.md): how to report a vulnerability privately,
  through the repository's Security tab, and how to run Telflo safely.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to propose a change, run the
  checks and license your contribution.
- The README's "About this project" says how the code was written.
- A form for the Basic Auth extension (`basicauth`) in the visual editor,
  and a palette entry for it. It edits client mode (`client_auth`) or
  server mode (`htpasswd`), one per instance, and warns about missing
  credentials and settings the collector would refuse.
- Three more flows in the seeded library: Monitor Supabase, Ship OTel data
  to GreptimeDB and Ship OTel data to SereneDB, each on otelcol-contrib
  0.159.0. A migration adds them to an installed database; a flow an admin
  already made with one of their slugs stays as it is.

### Changed

- The README says what Telflo includes, that it has no collector limit,
  and that the AI assistant and MCP server offered at telflo.com aren't
  part of it.
- Comments, docs and script messages no longer cite private planning
  documents. The code is unchanged.

## 0.2.0

The first public release of Telflo.

### Changed

- Telflo is open source, under the Apache License 2.0 ([`LICENSE`](LICENSE),
  [`NOTICE`](NOTICE)), and its repository, images and Helm chart are
  public: an install needs no registry login and no pull Secret.
- The CLI (`telflo`) is Apache-2.0 too, and has no default server: name
  yours with `telflo login --server <url>` or `TELFLO_SERVER`. Without
  either, `telflo login` at a terminal asks for the server's URL; every
  other command stops with a usage error (exit 2) that says how to name
  one.

### Added

- A secret scan: `scripts/release/check-secrets.sh` runs gitleaks (pinned in
  `scripts/release/tools.lock`, sha256-checked) on every file the repository
  holds, as a static gate and in every release's first job.
  `.gitleaksignore` lists the findings reviewed as test fixtures or
  development-only values.
