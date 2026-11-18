# telflo collector

A ready-to-run [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
(`otelcol-contrib`) bundled with the [OpAMP supervisor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/cmd/opampsupervisor),
so the collector takes its configuration from your telflo fleet instead of a
static file you manage by hand.

```bash
docker pull ghcr.io/telflo/telflo/collector:0.162.0
```

The image is **generic**: it ships no endpoints, tokens or open ports. You
give it those at run time, the supervisor connects to your fleet's OpAMP
server, and telflo sends the collector its group's published version.

The platform's install dialog writes the command below for you. It is the
platform's own image, published as `ghcr.io/telflo/telflo/collector`
(D18); the older `ghcr.io/telflo/collector` isn't this repository's and is
never written from here.

## Quick start

On the fleet's page, choose **Install collector**, then the method
**Container image — pull and run**, and copy the command. It looks like this:

```bash
docker run -d --restart unless-stopped --name telflo-collector \
  -v telflo-opamp:/app/opamp \
  -e COLLECTOR_GROUP_ID='<group id>' \
  -e OPAMP_ENDPOINT='<the fleet OpAMP endpoint>' \
  -e OPAMP_ALLOW_INSECURE_CONNECTIONS='false' \
  -e OPAMP_TOKEN='<the fleet token>' \
  'ghcr.io/telflo/telflo/collector:0.162.0'
```

The tag is the collector version of the group's published version. Within
about a minute the collector connects, joins its group, receives the group's
published version and starts collecting; it appears in the fleet's
Collectors tab.

**Installing again** (after a new default token, say). On a container host,
remove the old container first (`docker rm -f telflo-collector`); keep the
telflo-opamp volume to keep the same collector, or remove it too
(`docker volume rm telflo-opamp`) to install a new collector into another
group or fleet.

**Publishing ports.** The image opens no ports on its own. When the
published version uses a receiver that listens (OTLP, Prometheus, ...), map
the port with `docker run -p`, e.g. `-p 4317:4317` for OTLP/gRPC.

## Configuration

The connection settings are environment variables, applied on **every**
container start: change a value and restart, with no rebuild.

| Variable | Required | Description |
|----------|----------|-------------|
| `OPAMP_ENDPOINT` | yes | The fleet's OpAMP server URL. |
| `OPAMP_TOKEN` | yes | The fleet's bearer token. Treat it as a secret. |
| `OPAMP_SERVER_NAME` | no | The collector's display name in the fleet. Without it, telflo names it. |
| `OPAMP_ALLOW_INSECURE_CONNECTIONS` | no | `true` turns TLS off for a development OpAMP server. Defaults to `false`; keep it `false` in production. |
| `COLLECTOR_GROUP_ID` | yes | The id of the collector group the collector joins when it first enrolls (reported as `telflo.collector_group_id`), from the fleet's install command or Helm values; moving it to another group later sticks. Required: the container refuses to start without it, or when it is blank after trimming white space (the OpAMP server trims it the same way), as the OpAMP server refuses a collector naming no group. |

`POD_NAMESPACE`, `POD_NAME`, `NODE_NAME` and `HOST_IP` (optional) are reported
as the collector's Kubernetes attributes when set.

**On Kubernetes** a Kubernetes-supervisor fleet's **Install with Helm**
installs this image with the platform's chart (`supervisor-collector`
0.1.0, `charts/supervisor-collector/`, published as
`oci://ghcr.io/telflo/telflo/charts/supervisor-collector`), whose values
file the platform builds, and the chart sets every
variable above: `OPAMP_TOKEN` from the release's Secret (the values'
`token`, the fleet's default token as the reveal gives it: this image adds
`Bearer `), `OPAMP_ENDPOINT`, `OPAMP_ALLOW_INSECURE_CONNECTIONS`,
`COLLECTOR_GROUP_ID` (the values' `collectorGroupId`, which the platform
always sets), `OPAMP_SERVER_NAME` the pod's name, and `POD_NAMESPACE`,
`POD_NAME`, `NODE_NAME` and `HOST_IP` (the pod's IP) from the pod. The
values' `collectorEnv` reaches the collector as pipeline environment
variables (below). A pod reads the token only as it starts, so the chart
puts a checksum of the token's Secret on each workload's pods: a `helm
upgrade` with a new default token changes it, and Kubernetes restarts the
pods with the new token (D18).

Every value is written into the supervisor's configuration exactly as given,
quoted, so a name such as `2024`, `true` or `#east` stays text and the
supervisor never expands a `${...}` in it. A value holding a line break or
a control character is refused. `COLLECTOR_GROUP_ID` and the Kubernetes
attributes are stricter: the supervisor copies them, unescaped, into the
collector's merged configuration (`service.telemetry.resource`), where a
`"` or a `\` stops it from starting and the collector expands a `$` again
(`${env:OPAMP_TOKEN}` would write the token into every log line), so a
`"`, a `\` or a `$` there is refused. Ids and Kubernetes names never hold
them; the display name, a header that is never copied there, may. The
supervisor adds the container's hostname to the same attributes, so the
hostname gets the same rule: a `docker run --hostname` holding a `"`, a
`\`, a `$`, a line break or a control character is refused at start (the
message never echoes it).

### Pipeline environment variables

A configuration can read environment variables with the collector's
`${env:NAME}` syntax (or `${env:NAME:-default}` for a fallback), e.g.
`endpoint: ${env:BACKEND_ENDPOINT}`. Set them with more `-e` flags on
`docker run`: the collector inherits the container's environment.

```bash
docker run -d --restart unless-stopped --name telflo-collector \
  -v telflo-opamp:/app/opamp \
  -e OPAMP_ENDPOINT='<the fleet OpAMP endpoint>' \
  -e OPAMP_TOKEN='<the fleet token>' \
  -e BACKEND_ENDPOINT='https://otlp.example.com:4318' \
  'ghcr.io/telflo/telflo/collector:0.162.0'
```

The install dialog offers an input for every variable the published
version reads. For secrets, prefer `--env-file` to inline flags, to keep the
values out of your shell's history.

### Persistence

Mount a volume at `/app/opamp` (as in the quick start). It holds the
collector's OpAMP instance UID, its identity in the fleet. Without a
persistent volume, every restart enrolls a **new** collector and leaves the
old one behind.

## What's inside

| Path | What it is |
|------|------------|
| `/app/otelcol-contrib` | The OpenTelemetry Collector Contrib binary. |
| `/app/supervisor` | The OpAMP supervisor: it runs the collector and talks to telflo. |
| `/app/otelcol-config.yaml` | The starting configuration (a `nop` receiver and exporter). It binds no ports and is replaced by the group's published version once the OpAMP server answers. |
| `/app/supervisor-config.yaml` | Written at each container start from the environment. |
| `/app/entrypoint.sh` | The container's entrypoint, which writes it. |

The base is `debian:bookworm-slim`, pinned by its index digest, with
Debian's `curl` and `ca-certificates`. The image is built for
**linux/amd64** and **linux/arm64**.

It runs as **root** (a collector often reads host
files a mount brings in, such as logs, that only root can read; pass
`--user` to run it as another user that can read them and write
`/app/opamp`), and it keeps **curl**, which the build uses to download the
binaries (handy for checking the endpoint from inside the container; the
collector and the supervisor don't use it).

## Tags

- `ghcr.io/telflo/telflo/collector:<version>`: one tag per collector
  version the catalogue offers, each with that version's OpAMP supervisor.
  The binaries are pinned by sha256 in the catalogue, so a tag always holds
  the same binaries.
- **0.159.0, 0.160.0, 0.161.0 and 0.162.0**, each for `linux/amd64` and
  `linux/arm64`, are built again under this name by the collector
  workflow before the platform's first release (D36-2 decision 111); the
  package is private until the repository goes public (D36-3), so until
  then pulling them needs a GHCR login.
- Each image carries the OCI labels `org.opencontainers.image.source`
  (`https://github.com/telflo/telflo`), `.version` (the collector
  version), `.revision` (the commit it was built from), `.title` and
  `.description`.

The publish pushes only the version's tag; no `latest` is published
(the install command always names the version of the group's published
version). An air-gapped mirror keeps the same tags under
its own repository (the platform's `TELFLO_COLLECTOR_IMAGE_REPOSITORY`).

## Security

- **The token is a secret.** Pass it at run time in an environment variable
  or from a secret store; never bake it into an image layer or commit it. If
  it leaks, revoke it on the fleet's Tokens tab, issue a new default token,
  and re-run the install command on each host.
- **The collector never has the token in its environment.** The supervisor
  reads it from `/app/supervisor-config.yaml` (mode 0600), and the
  entrypoint unsets `OPAMP_TOKEN`, the other `OPAMP_*` variables and
  `COLLECTOR_GROUP_ID` before the supervisor starts, so the collector it
  runs inherits none of them: no `${env:OPAMP_TOKEN}` in a configuration can
  read the bearer. Your pipeline's own variables (`-e BACKEND_ENDPOINT=…`)
  still reach it. The collector runs as root in the container, though, so a
  configuration with a receiver that reads files could read
  `/app/supervisor-config.yaml` and the token in it: the same access any
  member of the organization already has through the token's Reveal.
- **No secrets in the image.** It holds no fleet credentials or endpoints.
- **TLS on by default.** `OPAMP_ALLOW_INSECURE_CONNECTIONS=true` is for local
  development against a server without TLS only.

## Troubleshooting

The supervisor reports connection problems in the container's logs:

```bash
docker logs telflo-collector
```

| Symptom | Likely cause |
|---------|--------------|
| The container exits at once | `OPAMP_ENDPOINT` or `OPAMP_TOKEN` is missing; a value holds a line break or a control character; or a bad value in the supervisor's configuration (the log's first error names it). |
| It never appears in the fleet | A wrong endpoint or token, or the token was revoked. |
| TLS handshake or certificate errors | The endpoint isn't reachable over TLS, or a development server needs `OPAMP_ALLOW_INSECURE_CONNECTIONS=true`. |
| A new collector appears on every restart | `/app/opamp` isn't on a persistent volume. |

---

## Maintainers

This directory is the source of `ghcr.io/telflo/telflo/collector`
(D17c-1; its own repository since D18, ADR 0031).

- **Tests** run without Docker or network:
  `bash docker/collector-image/entrypoint_test.sh` (the entrypoint) and
  `bash docker/collector-image/build-collector-image_test.sh` (the build
  script's checks).
- **A local build** of one catalogue version, for the machine's platform,
  loaded into the local Docker engine:

  ```bash
  scripts/build-collector-image.sh 0.162.0                      # the engine's platform
  scripts/build-collector-image.sh 0.162.0 --platform linux/amd64
  ```

  It reads the version's URLs and sha256 from
  `catalog/distributions/otelcol-contrib.json` (an unknown or deprecated
  version is refused) and builds through the Docker-driver builder
  `desktop-linux` (`BUILDX_BUILDER` overrides it). It downloads the Debian
  base, apt's `curl` and `ca-certificates`, and the two binaries.
- **Publishing** is the collector workflow's (`.github/workflows/collector.yml`,
  D36-2 decision 85; ADR 0031's D36-2 amendment), started by hand from
  `main` with `collector_version` (a version the catalogue offers, or
  `all`) and `publish` (false by default: build and test only; true is
  the owner's yes), as `docs/releasing.md` says. Each version goes through
  this directory's build script twice:

  ```bash
  scripts/build-collector-image.sh 0.162.0 --build-oci <dir> --builder <name>
  scripts/build-collector-image.sh 0.162.0 --push-oci <dir>
  ```

  `--build-oci` builds `linux/amd64` and `linux/arm64` once, with
  BuildKit's SBOM and provenance attestations, through a
  `docker-container` builder (never created by the script), into
  `<dir>/collector-<version>.oci.tar` and its index digest into
  `<dir>/collector-<version>.digest`; the archive is checked (one index
  entry, both platforms, the version and revision labels). `--push-oci`
  copies that archive, unchanged, to
  `ghcr.io/telflo/telflo/collector:<version>` with crane, then reads the
  tag's digest back: a tag already holding the same digest is skipped (a
  re-run), one holding another refuses the run, nothing overwritten; for
  any registry but a loopback one (`--registry 127.0.0.1:<port>`, the
  rehearsal's) the archive must carry its attestations. `--dry-run` with
  `--build-oci` prints the exact `docker buildx` argv, one shell-quoted
  argument a line. There is no `--push` or `--replace` (D36-2: they built
  and pushed in one step and re-pushed a published tag), and
  `scripts/publish-collector-images.sh` is gone.

  Before anything runs, both modes refuse a repository other than
  `ghcr.io/telflo/telflo/collector` (the older registry paths
  `ghcr.io/telflo/collector` and `ghcr.io/telflo/platform/collector` can't
  be named), a
  catalogue other than the repository's, a checkout that isn't this
  repository's own (a copy nested in another repository), uncommitted or
  untracked changes in this directory, the catalogue, the build script or
  the release's `oci.sh`, `tools.sh` and `tools.lock` (the `revision`
  label must describe the image), an input flagged assume-unchanged or
  skip-worktree, and a caller's `DOCKER_CONFIG` whose `config.json` could
  make Docker consult a credential helper. `--build-oci` builds from the
  commit itself: HEAD's raw blobs of this directory, each checked against
  its tree entry's hash (a symlink or submodule refused), written into a
  temporary directory, with HEAD's catalogue for the build arguments. The
  scripts never create a builder or log in to a registry: the push uses
  the caller's `DOCKER_CONFIG` (the workflow's job token;
  `docs/conventions/security.md`, "The release pipeline").
  `scripts/build-collector-image.sh --list-offered` prints the versions
  the catalogue offers, newest first (the workflow's `all`).
