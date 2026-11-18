# Changelog

Every release, newest first, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style. Each
release's images, Helm chart and Compose install are on its
[GitHub release](https://github.com/telflo/telflo/releases).

## Unreleased

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
