# Changelog

Every release, newest first, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Each
release's images, Helm chart and Compose install are on its
[GitHub release](https://github.com/telflo/telflo/releases).

## Unreleased

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
