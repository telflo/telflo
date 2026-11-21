# Run it with Docker Compose

Telflo's Compose install runs every part of Telflo on one machine, from
the same images, settings and defaults as the Helm chart. The
[Quick start](../README.md#quick-start) tries it on your own machine with
Mailpit; this page runs it for your team: TLS in front of it, a real mail
relay, the settings you can change, upgrades and backups.

- [What the install is](#what-the-install-is)
- [Installing](#installing)
- [The ports and the bind address](#the-ports-and-the-bind-address)
- [TLS in front](#tls-in-front)
- [Mail](#mail)
- [The settings in `.env`](#the-settings-in-env)
- [Where the images come from](#where-the-images-come-from)
- [Upgrading](#upgrading)
- [Backups](#backups)
- [Connecting collectors](#connecting-collectors)

## What the install is

Each release attaches the install as an archive,
`telflo-compose-<version>.tar.gz`, beside a `SHA256SUMS` file. Unpacked,
its folder `telflo-compose-<version>/` holds:

| File | What it is |
|---|---|
| `compose.yaml` | the services, their networks and their volumes, under the fixed project name `telflo` |
| `setup.sh` | run once: writes the settings into `.env` and new secrets into `.env` and `secrets/` |
| `gateway/default.conf`, `gateway/extra-routes.conf` | the gateway's nginx configuration, mounted read-only |
| `postgres/telflo-bootstrap.sql`, `opamp-server/bootstrap.sql` | the databases' roles, run by `db-bootstrap` on every start (nothing changes once they exist) |
| `README.md` | a short pointer to this page |

The services: `db` (Postgres 18, both databases, in the volume
`db-data`), `opamp-server` (the agent endpoint collectors
poll), `api` (its files in the volume `file-store`),
`web`, `otelcol-validator`, `otelcol-testing` and
`ottl-evaluator` (the last two locked down on networks of their
own, with read-only roots and no capabilities), and `gateway`. Three
one-shot services run on every start and stop: `db-bootstrap`,
`migrate` and `opamp-migrate`, so migrations run with every
`docker compose up`. `mailpit` runs only under the profile
`mailpit` (`setup.sh --mailpit`).

The Telflo images are named by the release's version
(`ghcr.io/telflo/telflo/<name>:<version>`, unless
[`TELFLO_IMAGE_REGISTRY`](#where-the-images-come-from) names another
registry); Postgres, nginx, Mailpit and the opamp-server by digest.

## Installing

Download, check and unpack the archive as the Quick start's steps 1 and 2
do, then run `setup.sh` in its folder:

```text
./setup.sh --public-url <url> --agent-url <url> [--http-port <port>]
           [--agent-port <port>] [--bind <address>]
           (--mailpit [--mailpit-port <port>] | --smtp-host <host> --smtp-port <port>
            --mail-from <address> [--smtp-tls starttls|implicit|none]
            [--smtp-username <name> --smtp-password-file <file>])
```

- **`--public-url`** is the gateway's origin as browsers reach it, with
  no path: `https://telflo.example.com`. It is `TELFLO_PUBLIC_WEB_URL` and
  `TELFLO_PUBLIC_API_URL`. `http` is refused unless the host is
  `localhost`, `127.0.0.1` or `[::1]`: anywhere else, the session cookies
  are Secure and need https.
- **`--agent-url`** is the agent endpoint's origin as collectors reach it:
  `https://opamp.example.com`. `/opamp/api/v1` is appended for the
  opamp-server's `OPAMP_SERVER_URL` and the API's
  `TELFLO_OPAMP_AGENT_PUBLIC_URL`; an `http` one lets collectors connect
  without TLS.
- **`--http-port`, `--agent-port` and `--bind`** say where the gateway
  and the agent endpoint are published ([The ports and the bind
  address](#the-ports-and-the-bind-address)).
- **The mail:** `--mailpit` (with `--mailpit-port` to move its inbox) for
  trying Telflo, or your relay's `--smtp-*` and `--mail-from` options
  ([Mail](#mail)).

It writes `.env` (mode 0600) and `secrets/` (mode 0700), and refuses to
run when either exists: it never makes new secrets over an existing
install, since they couldn't read its data. Every secret is new, from
`openssl rand`. It prints no value, only what it wrote and the next steps.
Exit codes: 0 done, 1 refused (nothing written), 2 a usage error.

**Back up `.env` and `secrets/` together, somewhere safe.** They hold
every secret of the install. Without `secrets/opamp-encryption-key`, no
collector's enrollment token can be read again.

Then start it, wait for every service to be healthy, and make the first
admin, who invites everyone else:

```sh
docker compose up -d
docker compose ps
docker compose exec -T api telflo-admin bootstrap --email <your email> --organization "<your organization>"
```

The bootstrap prints a link to set the password, once, as its last line
([docs/configuration.md](configuration.md#telflo-admin-bootstrap)).

## The ports and the bind address

Two ports are published, both on the bind address, and with `--mailpit`
a third, Mailpit's, on 127.0.0.1 only:

| `.env` | Default | `setup.sh` | What it serves |
|---|---|---|---|
| `TELFLO_HTTP_PORT` | 8080 | `--http-port` | the gateway: every page and the API, plain http |
| `TELFLO_AGENT_PORT` | 51234 | `--agent-port` | the opamp-server's agent endpoint, plain http |
| `TELFLO_BIND_ADDRESS` | 127.0.0.1 | `--bind` | the address both are published on |
| `TELFLO_MAILPIT_PORT` | 8025 | `--mailpit-port` (with `--mailpit` only) | Mailpit's inbox, always on 127.0.0.1 only |

The three ports must differ. The database, the opamp-server's management
API and the internal services are never published. Keep the bind address
`127.0.0.1` when your TLS proxy runs on the same machine. Set it to
`0.0.0.0` (or one of the machine's addresses) only when the proxy or
load balancer is on another machine, and then let only that proxy reach
the two ports (a firewall rule or a security group): they serve plain
http.

## TLS in front

The install serves plain http. Put a TLS proxy in front of the two ports,
give `setup.sh` the https origins, and tell the API about the extra proxy.

**With Caddy on the same machine**, which gets and renews the certificates
itself, a `Caddyfile` for the gateway at `telflo.example.com` and the agent
endpoint at `opamp.example.com`, both names pointing at this machine:

```text
telflo.example.com {
	reverse_proxy 127.0.0.1:8080
}

opamp.example.com {
	reverse_proxy 127.0.0.1:51234
}
```

with the install set up as:

```sh
./setup.sh --public-url https://telflo.example.com --agent-url https://opamp.example.com --smtp-host smtp.example.com --smtp-port 587 --mail-from telflo@example.com
```

**Then set `TELFLO_TRUST_PROXY_HOPS=2`** in `.env` and run `docker
compose up -d`. The API counts the proxies that add an `X-Forwarded-For`
entry in front of it: the gateway is one, and Caddy (or any proxy that
adds one) is the second. With the wrong count, every visitor shares the
proxy's address for the API's per-address limits, sign-in's among them.

**With another reverse proxy or a load balancer,** it needs to:
- terminate TLS for both names, and forward the gateway's name to the
  gateway's port and the agent endpoint's name to the agent's port, over
  http;
- add the visitor's address to `X-Forwarded-For` (then
  `TELFLO_TRUST_PROXY_HOPS=2`; a load balancer that passes TCP through
  adds none, and 1 stays right);
- accept request bodies up to 11 MiB (test files and the library's uploads; the gateway
  holds each route to its own, smaller limit);
- not log the paths under `/api/v1/quick-deploy/` and
  `/api/v1/library-links/`: they hold the secrets of quick-deploy and
  library links, which the gateway's own log cuts out.

## Mail

Telflo sends invitations, password resets, email confirmations and
product admins' notices. `setup.sh` takes exactly one of:

- **`--mailpit`**: Mailpit, for trying Telflo only. It keeps every
  message in an inbox on this machine (`http://127.0.0.1:8025`, or the
  port `--mailpit-port` gives) instead of delivering it, and the API sends
  to it in cleartext.
- **A relay:** `--smtp-host`, `--smtp-port` and `--mail-from`, with
  `--smtp-tls` `starttls` (the default: the connection is upgraded, or
  nothing is sent), `implicit` (TLS from the first byte, port 465's) or
  `none` (cleartext, which takes no login). A relay that needs a login
  takes `--smtp-username` and `--smtp-password-file`, a file holding the
  password alone, readable by you alone (mode 0600): a password is never
  given on the command line.

**Moving from Mailpit to a relay** is editing `.env`
([deploy/compose/README.md](../deploy/compose/README.md) has the steps):
stop and remove `mailpit` while `.env` still names its profile,
set `COMPOSE_PROFILES=` (empty), remove `TELFLO_MAILPIT_PORT`, set the
mail lines to your relay's (`TELFLO_MAIL_FROM`, `TELFLO_SMTP_HOST`,
`TELFLO_SMTP_PORT`, `TELFLO_SMTP_TLS`, `TELFLO_SMTP_ALLOW_INSECURE=false`,
and for a login `TELFLO_SMTP_USERNAME` and `TELFLO_SMTP_PASSWORD`), then
`docker compose up -d`. [docs/configuration.md](configuration.md#mail)
has every mail setting's rules.

## The settings in `.env`

`.env` holds every setting `compose.yaml` reads, and the secrets. Edit
it, then run `docker compose up -d`: Compose recreates the services whose
settings changed. A value holding a space or a `#` goes in single quotes.
Keep it mode 0600.

| Lines | What they set |
|---|---|
| `TELFLO_BIND_ADDRESS`, `TELFLO_HTTP_PORT`, `TELFLO_AGENT_PORT` | [the ports](#the-ports-and-the-bind-address) |
| `TELFLO_PUBLIC_WEB_URL`, `TELFLO_PUBLIC_API_URL`, `TELFLO_COOKIE_SECURE`, `TELFLO_TRUST_PROXY_HOPS` | [the public addresses](configuration.md#the-public-addresses) |
| `OPAMP_SERVER_URL`, `TELFLO_OPAMP_AGENT_PUBLIC_URL`, `TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS` | [the agent endpoint](configuration.md#the-opamp-server) |
| `COMPOSE_PROFILES`, `TELFLO_MAILPIT_PORT`, `TELFLO_MAIL_*`, `TELFLO_SMTP_*` | [mail](configuration.md#mail) |
| `TELFLO_REGISTRATION` … `TELFLO_COOKIE_POLICY_URL` | [the site](configuration.md#the-site), the open source's defaults written out |
| `TELFLO_*_PASSWORD`, `TELFLO_OPAMP_MANAGEMENT_SECRET`, `TELFLO_ACCESS_TOKEN_SECRET`, `TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY`, `TELFLO_LIBRARY_LINK_SIGNING_KEY`, the three services' secrets | [the secrets](configuration.md#the-secrets) |

**Settings you can add to `.env`,** which `compose.yaml` passes on when
they are set: the file store on S3 (`TELFLO_FILE_STORE=s3`, the bucket's
`TELFLO_FILE_STORE_*` settings and, without another credential source,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`),
Google sign-in (`TELFLO_OIDC_GOOGLE_CLIENT_ID`,
`TELFLO_OIDC_GOOGLE_CLIENT_SECRET`), SendGrid (`TELFLO_MAIL_TRANSPORT=sendgrid`
and `TELFLO_SENDGRID_API_KEY`), the sales inquiries' recipient
(`TELFLO_SALES_INQUIRY_TO`), analytics (`TELFLO_POSTHOG_KEY`,
`TELFLO_POSTHOG_HOST`), a rotation's previous keys
(`TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS`,
`TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS`), and the Telflo images'
registry (`TELFLO_IMAGE_REGISTRY`, [below](#where-the-images-come-from)).
[docs/configuration.md](configuration.md) has the others' rules.

**Anything else** (a private relay's CA file, the collector image's
repository for a mirror, the test runs' limits, the install templates)
goes in a `compose.override.yaml` beside `compose.yaml`, which Compose
reads with it. Copy it, with `.env` and `secrets/`, at every upgrade.

## Where the images come from

`compose.yaml` names each Telflo image as
`${TELFLO_IMAGE_REGISTRY:-ghcr.io/telflo/telflo}/<name>:<version>`.
Unset or empty, `TELFLO_IMAGE_REGISTRY` is `ghcr.io/telflo/telflo`, where
every release is published. `setup.sh` doesn't write it, so an install
pulls from there unless you set it.

Set it to pull the Telflo images from somewhere else:

- **A mirror of your own**, for a machine that can't reach `ghcr.io`, or
  a registry your organization requires. Copy the five images to it under
  the same names and tags: `<mirror>/api:<version>`,
  `<mirror>/web:<version>`, `<mirror>/otelcol-validator:<version>`,
  `<mirror>/otelcol-testing:<version>` and
  `<mirror>/ottl-evaluator:<version>`.
- **A release staged for testing** before it's published: the registry
  path its images were staged under, at the same version.

It changes only where the five Telflo images come from. Their names and
tags stay the release's, and Postgres, nginx, Mailpit and the
opamp-server keep their pinned images from their own registries.
Mirroring those, or the collector image, goes in a `compose.override.yaml`,
as [anything else](#the-settings-in-env) does.

Add the line to `.env`, the registry and its path with no `https://` and
no final `/`, then download the images and recreate the services:

```text
TELFLO_IMAGE_REGISTRY=registry.example.com/telflo
```

```sh
docker compose pull
docker compose up -d
```

A registry that needs a login takes `docker login registry.example.com`
first. `.env` moves to every upgrade, and the setting with it: the mirror
must hold the new release's images before its `docker compose pull`.
Remove the line, or leave it empty, to go back to `ghcr.io/telflo/telflo`.

## Upgrading

Read the new release's notes first: they say when a setting is new or
changed. Then back up ([Backups](#backups)), and:

```sh
# Unpack the new release beside the one you run, and check it as at the install.
tar -xzf telflo-compose-<new version>.tar.gz

# Copy the settings and the secrets into it, keeping their modes.
cp -p telflo-compose-<old version>/.env telflo-compose-<new version>/
cp -Rp telflo-compose-<old version>/secrets telflo-compose-<new version>/

# From the new folder: download the new images, then recreate the services on them.
cd telflo-compose-<new version>
docker compose pull
docker compose up -d
```

The project's name is always `telflo`, so the new folder's services take
over the old ones' containers and keep their volumes. Migrations run as
the services start; the API waits for them. Keep the old folder until the
new one runs well, then delete it.

Going back to an older release means restoring the backup you made
before upgrading: a database migrated by a newer release can't be used by
an older one.

## Backups

The install's data is in two volumes, the database's and the file
store's, plus `.env` and `secrets/`. Back up all four together, and before
every upgrade. Run these from the install's folder; the files they write
hold everything in Telflo, so they are made readable by you alone:

```sh
# The databases, both of them, as SQL.
(umask 077 && docker compose exec -T db pg_dumpall -U postgres > db.sql)

# The file store (test inputs, runs' files, logos, the library), as a tar archive.
(umask 077 && docker compose exec -T api tar -czf - -C /var/lib/telflo/file-store . > telflo-files.tar.gz)
```

**Restoring** into an install with the same `.env` and `secrets/` (a new
machine: unpack the same release, copy them in first):

```sh
# Stop everything, and delete the database's volume: the restore needs an empty one.
docker compose down
docker volume rm telflo_db-data

# Start Postgres alone; wait until `docker compose ps` shows it healthy.
docker compose up -d db

# Load the backup as the superuser (it reports that the role postgres exists: that's expected).
docker compose exec -T db psql -U postgres -d postgres -q -f - < db.sql

# Start everything, then put the files back into the file store.
docker compose up -d
docker compose exec -T api tar -xzf - -C /var/lib/telflo/file-store < telflo-files.tar.gz
```

These steps are documented, not yet tested end to end by a smoke.

## Connecting collectors

A collector polls the agent endpoint at `--agent-url`, the address the
API also writes into every install command. It must be one your
collectors reach: through your TLS proxy (`https://opamp.example.com`), or
this machine's own address on your network with `--bind` set to match.
`localhost` reaches only collectors running directly on this machine,
never one in a container. Then create a fleet under **Fleet** in the web
app and use its install command.
