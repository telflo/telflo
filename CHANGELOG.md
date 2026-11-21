# Changelog

Every release, newest first, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Each
release's images, Helm chart and Compose install are on its
[GitHub release](https://github.com/telflo/telflo/releases).

## Unreleased

## 0.2.1 - 2026-11-20

### Security

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
