<p align="center">
  <a href="https://telflo.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="telflo-core/apps/web/public/telflo-logo-full.svg">
      <img alt="Telflo" src="telflo-core/apps/web/public/telflo-logo-dark.svg" height="80">
    </picture>
  </a>
</p>

<h1 align="center">Telflo</h1>

<p align="center">
  <strong>Build, check and roll out OpenTelemetry Collector configurations, on your own infrastructure.</strong>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="#documentation"><strong>Docs</strong></a> ·
  <a href="docs/configuration.md"><strong>Settings</strong></a> ·
  <a href="docs/kubernetes.md"><strong>Kubernetes</strong></a> ·
  <a href="charts/telflo/README.md"><strong>Helm chart</strong></a>
</p>

<p align="center">
  <sub>An open-source project by <a href="https://telflo.com">Telflo</a>.</sub>
</p>

Telflo is a self-hosted web app designed to be used with the open source
[telflo/opamp-server](https://github.com/telflo/opamp-server/) to enable
the management of your OpenTelemetry Collectors. It includes a visual
editor, a YAML editor, configuration validation and testing, fleet
management and a CLI, with no limit on how many collectors you manage.
The AI assistant and the MCP server offered at telflo.com are not part
of it.

Telflo runs as a handful of containers around one PostgreSQL, behind one
gateway, with Docker Compose on one machine or with Helm on Kubernetes.

To run Telflo, use a release: the
[latest release](https://github.com/telflo/telflo/releases/latest) has
its Compose install, its images and its Helm chart. `main` is under active
development and may be ahead of the latest release.

> **Status: before 1.0.** A minor release may still change a setting, the
> Compose install or the Helm chart in ways that need you to act. Each
> release's notes on GitHub say what changed and what to do.

**On this page:** [Pick your path](#pick-your-path) ·
[Core capabilities](#core-capabilities) · [How it works](#how-it-works) ·
[Quick start](#quick-start) · [Kubernetes](#kubernetes) ·
[Settings](#settings) · [What it doesn't do](#what-it-doesnt-do) ·
[Compatibility](#compatibility) · [Troubleshooting](#troubleshooting) ·
[Documentation](#documentation) · [Contributing](#contributing) ·
[License](#license)

## Pick your path

### Try it with Docker Compose

Every part of Telflo on your own machine, from a release, with Mailpit
holding its email. You sign in as its first admin, build a configuration
and invite a teammate. You need Docker.

[Start the Quick start ↓](#quick-start)

### Run it on one machine

The same Compose install for your team: TLS in front of it, a real mail
relay, upgrades and backups. You need one machine with Docker, and a TLS
proxy or a load balancer.

[Run it with Compose →](docs/compose.md)

### Run it on Kubernetes

The Helm chart runs each part as its own Deployment, with one Postgres,
NetworkPolicies around the sandboxed services, and the restricted Pod
Security level. You need a cluster, `kubectl` and Helm.

[Install the chart →](docs/kubernetes.md)

### Develop on it

Run the API and the web app from source against the development stack,
run the tests, and find your way around the repository.

[Set up a checkout →](docs/development.md)

## Core capabilities

### Configurations and the visual builder

- **A canvas and YAML, kept in step.** Build a pipeline from receivers,
  processors and exporters, each with a form for its settings, or edit the
  YAML directly.
- **Versions you can go back to.** Every configuration keeps its
  versions; publishing one freezes it.
- **Start from a flow.** Prebuilt configurations, each solving one
  problem, copied into your organization to edit.
- **Variables.** `${org:NAME}` references, filled in per collector from
  the organization's variables and variable groups.

### Validation and testing

- **Checked by the real collector.** The collector validator runs the
  configuration through the collector version it's pinned to, and the
  editor shows each error where it is.
- **Test runs on your own telemetry.** Upload a sample, run the
  configuration on it in a sandbox, and read what came out.
- **Rules on the output.** Text, regex and OTTL checks on a run's output,
  saved as test suites.

### Fleets and installs

- **Fleets and groups.** Collectors join a fleet with its enrollment
  token; each group runs the version assigned to it.
- **See every collector.** Whether it's online, whether it runs what it
  was sent, and its recent errors.
- **Installs from the browser.** A `docker run` command, a Linux bundle,
  or a Helm values file for Kubernetes, and one-command quick-deploy
  links.

### Organizations and access

- **Organizations, invitations and roles.** Admins invite people and
  choose their role; every account also has a personal workspace.
- **Service accounts and API tokens,** for CI jobs and tooling.
- **Product admins** manage the whole install: users, flows, test
  templates and the library.
- **Sign-in** with a password, or with Google once you configure it.

### The public API and the CLI

- **A public API** (`/api/public/v1`) with its reference page at
  `/api/public/v1/docs/`, authorized by API tokens.
- **The `telflo` CLI** validates, tests, pushes and deploys
  configurations from a terminal or a CI job
  ([telflo-core/apps/cli/README.md](telflo-core/apps/cli/README.md); not
  on npm yet).

## How it works

Browsers reach one origin, the gateway. Collectors reach one other port,
the opamp-server's agent endpoint. Everything else is internal.

```text
 browsers ──▶ gateway (nginx) ──┬──▶ web app
                                └──▶ API ──┬──▶ PostgreSQL: telflo
                                           ├──▶ opamp-server's management API ──▶ PostgreSQL: telflo_opamp_server
                                           ├──▶ collector validator
                                           ├──▶ collector tester  (a sandbox: reaches nothing)
                                           └──▶ OTTL evaluator    (a sandbox: reaches nothing)

 collectors (OpAMP Supervisor) ──▶ opamp-server's agent endpoint
```

| Component | What it does | Image |
|---|---|---|
| Gateway | nginx: the one origin browsers reach, sending `/api/` to the API and every page to the web app | `nginx:1.30-alpine`, pinned by digest |
| Web app | the pages, served by their own Node server | `ghcr.io/telflo/telflo/web` |
| API | the API for interfacing with Telflo's standard functionality | `ghcr.io/telflo/telflo/api` |
| PostgreSQL | two databases, `telflo_platform` and `telflo_opamp_server`, each with its own roles; neither side's roles can open the other's | `postgres:18`, pinned by digest |
| opamp-server | the OpAMP server collectors poll; the API manages it through its management API ([its own repository](https://github.com/telflo/opamp-server)) | `ghcr.io/telflo/opamp-server`, pinned by digest |
| Collector validator | checks a configuration with the collector version it's pinned to | `ghcr.io/telflo/telflo/otelcol-validator` |
| Collector tester | runs test runs: the pinned collector in a locked-down sandbox, fed the run's input | `ghcr.io/telflo/telflo/otelcol-testing` |
| OTTL evaluator | checks test runs' rules (text, regex and OTTL) | `ghcr.io/telflo/telflo/ottl-evaluator` |

The Telflo images share one version, the release's. Each collector runs
under the upstream OpenTelemetry Supervisor, which Telflo's installs set
up; Telflo's own collector image (`ghcr.io/telflo/telflo/collector`)
bundles both.

## Quick start

In the Quick Start you will run Telflo on your own machine with Docker
Compose, sign in as its first admin, build a configuration and invite a
teammate. It takes about fifteen minutes, most of it the first download.

This is for trying Telflo. Its email goes to Mailpit, an inbox on your
machine that keeps every message instead of delivering it, and it answers
only on this machine. The same install runs for real with a mail relay
and TLS in front: [docs/compose.md](docs/compose.md).

### Prerequisites

The steps run on macOS or Linux, in bash or zsh. They use these tools:

| Tool | Used for | Where to get it |
|---|---|---|
| Docker, with Compose v2 | running Telflo (steps 4 to 10) | [Docker Desktop](https://docs.docker.com/get-docker/), or Docker Engine and the `docker-compose-plugin` package on Linux |
| `curl` | downloading the release (step 1) | included with macOS and most Linux distributions |
| `sha256sum` or `shasum` | checking the download (step 2) | included with Linux and macOS |
| `tar` | unpacking it (step 2) | included with macOS and Linux |
| `openssl` | making the install's secrets (step 3) | included with macOS and most Linux distributions |
| A web browser | signing in (steps 7 to 9) | |

Give Docker at least 4 GB of memory and 10 GB of free disk: the
collector validator and tester images hold every collector version Telflo
offers.

Check that they're all installed:

```sh
docker compose version && curl --version && openssl version && tar --version && (sha256sum --version || shasum --version)
```

Each command prints a version. If one answers `command not found`,
install it before you start.

### Steps

Run every command below in one terminal, in order. The `#` lines are
comments that say what the next command does. In zsh (macOS's default
shell), run this first so the comments paste cleanly; bash needs nothing:

```sh
setopt interactivecomments
```

<!-- quick-start:begin -->

**1. Download the release.** The Compose install is one archive, with a
checksums file beside it.

```sh
# Make a folder for Telflo and go into it.
mkdir telflo-quick-start && cd telflo-quick-start

# Save the release's download address, which the next command uses.
release=https://github.com/telflo/telflo/releases/download/v0.2.2

# Download the Compose install's archive and the release's checksums.
curl -fsSL -O "$release/telflo-compose-0.2.2.tar.gz" -O "$release/SHA256SUMS"
```

**2. Check it and unpack it.**

```sh
# Check the archive against the checksums: it prints the archive's name and OK.
grep 'telflo-compose-0.2.2.tar.gz$' SHA256SUMS | if command -v sha256sum >/dev/null; then sha256sum -c -; else shasum -a 256 -c -; fi

# Unpack it, and go into the folder it makes.
tar -xzf telflo-compose-0.2.2.tar.gz && cd telflo-compose-0.2.2
```

**3. Set it up.** `setup.sh` writes the install's settings into a `.env`
file and newly generated secrets into `.env` and `secrets/`. `.env` is
readable by you alone (mode 0600); the `secrets/` folder can be opened
by you alone (mode 0700), and the files in it are readable (mode 0644)
so that each service can read its own secret. `--public-url` is where
your browser reaches Telflo, `--agent-url` where collectors reach it,
and `--mailpit` keeps the email in Mailpit.

```sh
# Write the settings and the secrets for this machine, with email kept in Mailpit.
./setup.sh --public-url http://localhost:8080 --agent-url http://localhost:51234 --mailpit
```

It prints what it wrote and the next steps. If one of its ports is
already in use on your machine, delete `.env` and `secrets/`, then run
it again with `--http-port`, `--agent-port` or `--mailpit-port` set to a
free one (for the first two, with the URL that names it changed to
match). If you find out at step 4 (`docker compose up` says `port is
already allocated`), first run `docker compose down -v`, while `.env` is
still there. `-v` deletes the install's data: that's fine on a first
install, and needed, since its database keeps the first secrets'
passwords ([Troubleshooting](#troubleshooting)). `./setup.sh --help`
prints the options' synopsis;
[docs/compose.md](docs/compose.md#installing) explains each one.

**4. Start it.** The first start downloads the images (a few GB), then
starts the database, the opamp-server, the API, the web app, the
validator, the tester, the evaluator, the gateway and Mailpit.

```sh
# Download the images and start every service in the background.
docker compose up -d
```

**5. Check that it's running.**

```sh
# List the services and their health.
docker compose ps
```

Run it again until every service shows `healthy` (Mailpit may show just
`running`, which is enough), a few minutes the first time. Three
one-shot services, `db-bootstrap`, `migrate` and
`opamp-migrate`, set up the databases and stop: it's normal for
them to show as exited, with code 0.

**6. Make the first admin.** Nobody can sign up on a new install, so the
first account comes from a command in the API's container. It makes you
the product admin, who manages the whole install, and the admin of a new
organization. Put your own email address after `--email`, and your team's
name after `--organization`.

```sh
# Create your account and your organization, and print a link to set your password.
docker compose exec -T api telflo-admin bootstrap --email you@example.com --organization "My team"
```

The last line it prints is a link. It works once, within 60 minutes. It
is a way into your account until you use it: keep it to yourself. The
command sends no email, so it works before any mail is set up.

**7. Set your password and sign in.** Open the link in your browser. On
**Set New Password**, type a password twice and choose **Update
Password**. Telflo takes you to **Sign In to Telflo**: sign in with your
email address and the new password. You land on **Configurations**, in
your new organization.

**8. Build a configuration and check it.** Choose **New configuration**,
then **Start from a flow**, pick a flow, and choose **Create**. The editor
opens on your own copy (a short tour of the editor may start first:
follow it or close it). Open the **YAML** tab. The bar under the editor
says what the collector validator found: `config valid · v` and the
collector version the configuration is pinned to. Type a mistake into
the YAML, such as an exporter that doesn't exist, and the bar counts the
errors; undo it, and it's valid again.

**9. Invite a teammate.** Choose **Permissions** in the sidebar, then
**Invite Member**. Type an address in **Email Addresses** and choose
**Send Invitations**. Open Mailpit's inbox, `http://127.0.0.1:8025` (or
the port you gave `--mailpit-port`): the invitation is there. Its link
opens a page to join your organization; open it in a private window
(you're signed in in this one) to create the teammate's account.

**10. Clean up.** This stops and removes every container and deletes the
install's data, then deletes the folder with its secrets. You can run it
after any step, then start again from step 1.

```sh
# Stop and remove every container, and delete the database's and the files' volumes.
docker compose down -v

# Leave the folders and delete them, with the settings and the secrets.
cd ../.. && rm -rf telflo-quick-start
```

<!-- quick-start:end -->

The images stay on your machine; `docker compose down -v --rmi all`, in
place of the first command, removes them too.

**Connecting a collector.** The Quick start's agent URL is this
machine's own loopback, which a collector in a container or on another
machine can't reach. To connect collectors, give `setup.sh` an
`--agent-url` they reach, then create a fleet under **Fleet** and use its
install command ([docs/compose.md](docs/compose.md)).

**Connecting to the database.** Postgres isn't published to your
machine by default. To reach it, for example with `psql` or a database
tool, publish its port on the loopback only, from the install's folder:

```sh
# Publish Postgres on this machine's loopback, port 5432, in an override Compose reads with compose.yaml.
cat > compose.override.yaml <<'EOF'
services:
  db:
    ports:
      - "127.0.0.1:5432:5432"
EOF

# Recreate the database's container with the port published.
docker compose up -d

# Connect as the superuser, with the password setup.sh wrote into .env.
PGPASSWORD="$(sed -n 's/^TELFLO_POSTGRES_PASSWORD=//p' .env)" psql -h 127.0.0.1 -p 5432 -U postgres -d telflo_platform
```

If another Postgres already uses port 5432 on your machine, change the
first `5432` in the override, and in `psql -p`, to a free port. The
databases are `telflo_platform` and `telflo_opamp_server`. Delete
`compose.override.yaml` and run `docker compose up -d` again to stop
publishing it.

## Kubernetes

The Helm chart, `oci://ghcr.io/telflo/telflo/charts/telflo`, installs the
same images: each part as its own Deployment, one Postgres in a
StatefulSet, NetworkPolicies that keep the tester and the evaluator from
reaching anything, and every pod non-root with a read-only root. You
create its Secrets with `create-secrets.sh` (attached to each release),
install the chart with your public addresses and mail relay, and make the
first admin with the same `telflo-admin bootstrap` in the API's pod.
[docs/kubernetes.md](docs/kubernetes.md) walks through it, and
[the chart's README](charts/telflo/README.md) describes every value.

## Settings

Every setting is an environment variable, read by the API, the web app
or both. In Compose, `setup.sh` writes them into `.env`; with Helm, the
chart sets them from its values and Secrets. These are the ones you must
set:

| Setting | What it is | Compose (`setup.sh`) | Helm chart |
|---|---|---|---|
| [`TELFLO_PUBLIC_WEB_URL`, `TELFLO_PUBLIC_API_URL`](docs/configuration.md#the-public-addresses) | the gateway's origin, as browsers reach it | `--public-url` | `publicUrl` |
| [`OPAMP_SERVER_URL`, `TELFLO_OPAMP_AGENT_PUBLIC_URL`](docs/configuration.md#the-opamp-server) | the agent endpoint, as collectors reach it | `--agent-url` | `opamp-server.server.publicUrl` |
| [The mail settings](docs/configuration.md#mail) | your mail relay | `--mailpit`, or `--smtp-host`, `--smtp-port`, `--mail-from` | `api.mail` |
| [The secrets](docs/configuration.md#the-secrets) | passwords, keys and shared secrets | generated by `setup.sh` | Secrets made by `create-secrets.sh` |

The defaults are the open source's, for an install that only its own
people use:

| What | Default | Setting |
|---|---|---|
| Who may make an account | invitations only | [`TELFLO_REGISTRATION`](docs/configuration.md#telflo_registration) (`invite-only`) |
| Who may create an organization | product admins only | the product admins' switch on their Product admins page |
| The playground, validating without signing in, the flows without signing in | off | [`TELFLO_PLAYGROUND`, `TELFLO_ANONYMOUS_VALIDATE`, `TELFLO_PUBLIC_FLOWS`](docs/configuration.md#the-site) |
| Terms of Service to accept | none | [`TELFLO_TERMS_VERSION`](docs/configuration.md#telflo_terms_version) |
| Settings › Notifications, the sales inquiry form | off | [`TELFLO_EMAIL_NOTIFICATIONS`, `TELFLO_SALES_INQUIRY`](docs/configuration.md#the-site) |
| Contact us and the user feedback, Learning and the library, Product admin › Users | off | [`TELFLO_USER_FEEDBACK`, `TELFLO_LEARNING`, `TELFLO_USER_ADMIN`](docs/configuration.md#the-site) |
| The Docs links | `https://docs.telflo.com/` | [`TELFLO_DOCS_URL`](docs/configuration.md#telflo_docs_url) |
| Analytics | none: nothing is loaded | [`TELFLO_POSTHOG_KEY`](docs/configuration.md#analytics) |
| Google sign-in | off | [`TELFLO_OIDC_GOOGLE_CLIENT_ID`](docs/configuration.md#google-sign-in) |
| The file store | the local disk, in a volume | [`TELFLO_FILE_STORE`](docs/configuration.md#the-file-store) (`local`, or `s3`) |

[docs/configuration.md](docs/configuration.md) explains every setting,
with its Compose and Helm names side by side, and the admin commands.

## What it doesn't do

- **No AI assistant or MCP server.** Those are part of the hosted
  service at [telflo.com](https://telflo.com), not this repository.
- **No TLS of its own.** The gateway and the agent endpoint serve plain
  http; put your TLS proxy or load balancer in front
  ([docs/compose.md](docs/compose.md), [docs/kubernetes.md](docs/kubernetes.md)).
- **No single sign-on beyond Google.** Accounts sign in with a password,
  or with Google once you configure a client. No SAML or other OIDC
  provider is offered.
- **No telemetry storage.** Telflo manages your collectors'
  configurations; your telemetry goes from the collectors to your own
  backends, never through Telflo.
- **No automatic backups.** Back up the database and the file store
  yourself ([docs/compose.md](docs/compose.md) shows how), and before
  every upgrade: migrations run on start, and going back means a restore.
- **One machine with Compose.** For replicas and spreading the parts over
  machines, use the Helm chart.
- **No offline bundle.** The images come from GHCR and Docker Hub. A
  mirror works through the image settings, but no air-gapped package is
  part of the open source.
- **The CLI isn't on npm yet.** It installs from its package file
  ([telflo-core/apps/cli/README.md](telflo-core/apps/cli/README.md)).

## Compatibility

| | Works with | Tested with |
|---|---|---|
| Docker, for the Compose install | Docker Engine 20.10 or later, with Compose 2.6 or later | Docker Desktop on macOS, Compose 2.6.0 |
| Kubernetes, for the Helm chart | 1.25 or later | kind (Kubernetes 1.35), minikube |
| Helm | 3 or later | |
| PostgreSQL | 18, run by the install itself (the Compose file's and the chart's) | 18.7 |
| OpenTelemetry Collector | `otelcol-contrib` 0.159.0 to 0.162.0, run by the OpAMP Supervisor | 0.162.0 |
| Images | `linux/amd64` and `linux/arm64`, non-root | |
| Browsers | current Chrome, Firefox and Safari | Chromium, Firefox and WebKit |

## Troubleshooting

**`docker compose up` stops at once with `run ./setup.sh first`.** A
setting is missing from `.env`, or there is no `.env`: run `./setup.sh`
in the folder that holds `compose.yaml`, and run `docker compose` from
that folder.

**`setup.sh` says `.env exists already: refused`.** It never makes new
secrets over an existing install, since they couldn't read its data. To
start over, `docker compose down -v` deletes the data; then delete `.env`
and `secrets/` and run it again.

**`port is already allocated`.** Another program has one of the
install's ports. On a first install whose `docker compose up` failed so,
run `docker compose down -v` (before anything is deleted: it reads
`.env`), delete `.env` and `secrets/`, and run `setup.sh` again with
`--http-port`, `--agent-port` or `--mailpit-port` set to a free port and
the URLs to match. **`-v` deletes the install's data**, its database and
its files: that's fine on a first install, and needed, since the
database keeps the first secrets' passwords and the new ones can't sign
in to it. On an install whose data you keep, don't: free the port
instead.

**A service stays `unhealthy` or restarts.** `docker compose logs
<service>` says why. `docker compose ps -a` shows the one-shot services:
if `migrate` or `opamp-migrate` exited with a code other
than 0, its log names the problem, and the API waits for it.

**The bootstrap says `A product admin already exists: nothing was
changed.`** It works once per install. For a new link to set a
password, run `docker compose exec -T api telflo-admin reset-link
--email <address>` ([docs/configuration.md](docs/configuration.md#telflo-admin-reset-link)).

**Signing in does nothing, or comes back to the sign-in page.** The
session cookies are Secure unless the public URL is `http://localhost`
(or `127.0.0.1`): over plain http on any other address the browser drops
them. Put TLS in front and give `setup.sh` the `https` address.

**No email arrives in Mailpit.** `docker compose ps` should list
`mailpit`; `.env` holds `COMPOSE_PROFILES=mailpit` when
`setup.sh --mailpit` was used. With a real relay, `docker compose logs
api` names a failed send by its code.

**A collector never appears, or shows online once and then drops.**
Collectors poll the `--agent-url` you gave `setup.sh` (the opamp-server's
`OPAMP_SERVER_URL`): it must be an address the collectors reach, which
`localhost` isn't for a collector in a container or on another machine
([docs/configuration.md](docs/configuration.md#the-opamp-server)).

## Documentation

**Run it**

- [Quick start](#quick-start): Docker Compose on your machine, with Mailpit
- [docs/compose.md](docs/compose.md): the Compose install for real: TLS in
  front, a mail relay, upgrades and backups
- [docs/kubernetes.md](docs/kubernetes.md) and the
  [chart's README](charts/telflo/README.md): the Helm chart and every value

**Configure it**

- [docs/configuration.md](docs/configuration.md): every setting, the
  first admin and the other admin commands

**Develop it**

- [docs/development.md](docs/development.md): running it from source, the
  development stack, the tests and the repository's layout
- [docs/conventions/](docs/conventions/): naming, the API, testing,
  security
- [docs/releasing.md](docs/releasing.md): how a release is built, checked
  and published
- [CHANGELOG.md](CHANGELOG.md): what each release changed

## About this project

The code for telflo.com was originally created by a combination of hand-coded
software and AI (Claude) assisted development. When we decided to open source
the platform, we used Claude to help port the closed-source software to a new
architecture backed by PostgreSQL. This repo is the result of that port.
Currently telflo.com still runs on the original codebase, because we wanted to
prioritize making this solution available over swapping telflo.com. That
effort is ongoing and will take place in the near future. We hope you enjoy
using this solution, and we look forward to your feedback!

## Contributing

Bugs and questions go to the repository's
[issues](https://github.com/telflo/telflo/issues). Report a security
vulnerability privately instead, as [SECURITY.md](SECURITY.md) describes.
[CONTRIBUTING.md](CONTRIBUTING.md) says how to propose a change, and
[docs/development.md](docs/development.md) is the guide to working on it.
A contribution is made under the project's license, below.

## License

The Apache License 2.0: [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
Telflo is provided "as is", without warranty of any kind; sections 7 and
8 of the license say so in full. The Telflo name and logo are trademarks
of Telflo, Inc., and the license grants no rights to them.

---

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/compose.md">Compose</a> ·
  <a href="docs/kubernetes.md">Kubernetes</a> ·
  <a href="docs/configuration.md">Settings</a> ·
  <a href="docs/development.md">Development</a>
</p>
