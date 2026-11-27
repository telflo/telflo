# The telflo chart

The Telflo platform on any Kubernetes cluster, from one chart: the API, the
web app, the gateway, the collector validator and tester, the OTTL
evaluator and one shared Postgres, with the
[opamp-server chart](charts/opamp-server/README.md) (0.3.2, the version
`vendor/opamp-server/PIN` names) as a vendored dependency.

The chart holds nothing specific to a cloud. A cloud's details (its load
balancer's annotations, a workload identity, a storage class) go in your
own values file, outside the chart, through the generic values below.
`scripts/check-chart-cloud-neutral.sh` holds the chart to that.

It is published with each Telflo release as
`oci://ghcr.io/telflo/telflo/charts/telflo`, at the release's version.
[docs/kubernetes.md](../../docs/kubernetes.md) walks through a first
install; this README describes every value, Secret and step. Each block
below is one command, and the ones naming `scripts/` run from a checkout
of this repository (or use the release's own copy of
`create-secrets.sh`). `<context>` is your cluster's kubectl context: every
command names it, so none ever runs against your current one by accident.

## What it installs

| Object | Name | Notes |
|---|---|---|
| StatefulSet, Services | `telflo-postgres`, `telflo-postgres-headless` | the databases `telflo_platform` and `telflo_opamp_server`; both bootstraps at the first start |
| ConfigMap | `telflo-postgres-bootstrap` | `telflo-bootstrap.sql`, `telflo-initdb.sh` |
| Deployment, Service, ServiceAccount | `telflo-api` (port 8080) | its `migrate` init container runs the migrations |
| PersistentVolumeClaim | `telflo-api-file-store` | only with `api.fileStore.kind: local` |
| Deployment, Service | `telflo-web` (port 3000) | the web app's own server |
| Deployment, Service, ConfigMap | `telflo-gateway` (port 80) | nginx with `docker/gateway/default.conf`; the one origin browsers reach |
| ConfigMap | `telflo-gateway-extra-routes` | `gateway.extraRoutes` as nginx locations, empty by default (below) |
| Deployments, Services | `otelcol-validator` (8001), `otelcol-testing` (8002), `ottl-evaluator` (8003) | the sandbox: reached only by the API, reaching nothing |
| NetworkPolicies | one per platform component but the gateway | while `networkPolicy.enabled` (the default) |
| the opamp-server chart | Deployments, Services and NetworkPolicies `telflo-opamp-server-agent` and `-management`; ServiceAccount `telflo-opamp-server`; ConfigMap `-bootstrap` | its own Postgres off, wired to `telflo-postgres`, which admits both components' pods |

There is no Ingress: the gateway routes every HTTP request. Two Services
face outside the cluster, the gateway's and the opamp-server's agent
endpoint, both of type LoadBalancer by default. The opamp-server's
management API is always ClusterIP.

**One release per namespace.** The names are fixed: the gateway's
configuration names `telflo-api` and `telflo-web`, and the API reaches
everything else by name. The chart refuses a second release in a
namespace that holds one.

## The cluster contract

- **Kubernetes 1.25 or later** (`Chart.yaml`'s `kubeVersion`). The
  gateway's sysctl needs 1.22; the opamp-server chart needs 1.25.
- **A default StorageClass**, or `postgres.storageClassName` and
  `api.fileStore.storageClassName`.
- **LoadBalancer Services**, or set `gateway.service.type` and
  `opamp-server.service.agent.type` to `NodePort` (or `ClusterIP`, and
  reach them by a port-forward).
- **A network plugin that enforces NetworkPolicies**, for the sandbox.
  Without one the policies render but hold nothing back.
- **The restricted Pod Security level works:** every pod of the release
  runs non-root with a read-only root, so the release's namespace may
  carry `pod-security.kubernetes.io/enforce: restricted`.
- **The images** come from GHCR: the platform's own
  (`ghcr.io/telflo/telflo/<name>`, tagged with the chart's `appVersion`)
  and the opamp-server's (`ghcr.io/telflo/opamp-server`, public). nginx
  and Postgres come from Docker Hub, each pinned by digest. The chart sets
  no pull Secret (`global.imagePullSecrets` and
  `opamp-server.imagePullSecrets` are both `[]`): the images and the chart
  are public. A registry of your own that needs a login (a mirror) takes
  a pull Secret named in both lists (the chart refuses two different
  lists).

Each release publishes the five images and this chart together, at one
version (the chart's `version` and `appVersion`, which are equal): the
release workflow builds them once, tests those bytes, then copies them to
GHCR (Publishing, below).

## Values

`values.yaml` describes each value, and `values.schema.json` refuses an
unknown one at every level. **No value holds a secret**: a credential is
always a Secret's name. The shape:

- **`publicUrl`** (required): the gateway's public origin (below).
- **`global.imagePullSecrets`**: the pull Secrets' names, for every pod
  (none by default; above).
- **`image.registry`**, and for each component (`api`, `web`, `gateway`,
  `otelcolValidator`, `otelcolTesting`, `ottlEvaluator`, `postgres`) its
  `image` (`registry`, `repository`, `tag`, `digest`, `pullPolicy`). An
  empty tag is the chart's `appVersion`.
- **For each component:** `replicas`, `resources`, `nodeSelector`,
  `tolerations`, `affinity`, `podAnnotations`. Don't give the gateway an
  `ephemeral-storage` limit: it buffers request bodies on its emptyDir,
  and a limit would let a few dozen slow uploads get its pod evicted
  (`docs/conventions/security.md`, "Kubernetes").
- **`existingSecrets`**: the platform's Secrets' names (below).
- **`networkPolicy.enabled`**: the NetworkPolicies (on by default).
- **`site`**: what the install offers beyond the signed-in product,
  rendered on the API's and the web app's pods alike (below).
- **`api`**: `trustProxyHops`, `verificationTokenTtlHours`,
  `salesInquiryTo` (where the sales inquiries go, required while
  `site.salesInquiry` is true; no default address),
  `opampAllowInsecureConnections`, `mail` (`transport` smtp or sendgrid,
  `from`, and for smtp: `host`, `port`, `allowInsecure`, `tls`, `auth` and
  `caSecret`, below), `oidcGoogle.enabled`, `fileStore` (`kind` local or s3, the volume's
  `storageClassName` and `size`, or the bucket's `bucket`, `region`,
  `prefix`, `endpoint` and `forcePathStyle`), and
  `serviceAccount.annotations` (where a cloud's workload identity goes,
  for the bucket).
- **`web.posthog`**: the analytics key and host (empty: no analytics).
- **`gateway.service`**: `type`, `annotations`, `externalTrafficPolicy`,
  `loadBalancerSourceRanges`.
- **`gateway.extraRoutes`**: paths the gateway sends to another Service in
  the namespace, ahead of the platform's own (below). Empty by default.
- **`postgres`**: `storageClassName`, `size`.
- **`opamp-server`**: the opamp-server chart's own values, passed through
  (its README describes them). The defaults wire it to the platform, and
  the chart refuses a change that would break that wiring: its
  `fullnameOverride`, its Postgres off and `externalDatabase` on
  `telflo-postgres`, its `imagePullSecrets` equal to
  `global.imagePullSecrets`, its `networkPolicy.enabled` equal to the
  platform's. You give it `server.publicUrl` (required): the agent
  endpoint's URL as collectors reach it, such as
  `https://opamp.example.com/opamp/api/v1`. In practice http or https
  (the opamp-server chart's schema refuses ws and wss), a host or an IP
  address, an optional port and a path; no user name, password, query or
  fragment.

An install gives at least `publicUrl`, `api.mail.from`,
`api.mail.smtp.host` (with smtp) and `opamp-server.server.publicUrl`.
`tests/profiles/default.yaml` is such a file.

A value that could hold a pasted secret (a URL, a host, an image
reference, a Secret's name) is checked by a guard, never by a schema
pattern: the guard's fixed message names the value's path, never its
value, while Helm's schema refusal would quote it. The opamp-server
chart's own schema still checks some of its values by pattern
(`server.publicUrl`, `auth.existingSecret`), and Helm's refusal then
quotes the value.

## Secrets

The chart reads Secrets by name only and never renders one. Create them
before the first install, in the release's namespace.

| Secret (its value) | Keys | Read by |
|---|---|---|
| `telflo-postgres` (`existingSecrets.postgres`) | `postgres-password`, `owner-password`, `api-password` | Postgres (`postgres-password`, `owner-password`); the migrate init container (`owner-password`, `api-password`); the API (`api-password`) |
| `telflo-opamp-server` (`opamp-server.auth.existingSecret`) | `owner-password`, `runtime-password`, `management-secret`, `encryption-key`; optional `management-secrets-previous`, `encryption-keys-previous` | the opamp-server; Postgres (the opamp bootstrap); the API (`management-secret` only) |
| `telflo-api` (`existingSecrets.api`) | `access-token-secret`, `quick-deploy-encryption-key`, `library-link-signing-key`; optional `quick-deploy-previous-encryption-keys`, `library-link-signing-keys-previous` | the API |
| `telflo-internal-services` (`existingSecrets.internalServices`) | `otelcol-validator-secret`, `otelcol-testing-secret`, `ottl-evaluator-secret` | the API (all three); each service only its own (the tester and the evaluator as a file) |
| `telflo-oidc-google` (`existingSecrets.oidcGoogle`), optional | `client-id`, `client-secret` | the API, while `api.oidcGoogle.enabled` |
| `telflo-mail` (`existingSecrets.mail`), optional | `sendgrid-api-key`; `smtp-username` and `smtp-password` | the API: the key while `api.mail.transport` is sendgrid, the login while `api.mail.smtp.auth` |
| the relay's CA (`api.mail.smtp.caSecret`), optional | `ca.crt` | the API, mounted read-only (below) |
| `ghcr-pull` (`global.imagePullSecrets`), optional | `.dockerconfigjson` | every pod's image pulls, while it is listed (above) |

The five Postgres passwords (`telflo-postgres`'s three, the opamp-server's
`owner-password` and `runtime-password`) must be URL-safe (only `A-Z a-z
0-9 . _ ~ -`): the chart builds database URLs from them. Postgres and the
API's two containers check theirs before they start, and stop with a
fixed message if one isn't.

### `scripts/create-secrets.sh`

The script creates every Secret above from one file, kept out of git (the
`*.secrets.env` pattern is in `.gitignore`). First, a new file with fresh
values:

```sh
scripts/create-secrets.sh --init my.secrets.env
```

`--init` refuses a file that exists. It writes every generated key (the
Postgres passwords as hex, so URL-safe) with mode 0600, and the optional
sections as commented placeholders. It prints a note: **back up the
opamp-server's `encryption-key` outside the cluster.** It encrypts the
enrollment tokens the opamp-server stores; without it they can't be read
again. Keep the whole file somewhere safe.

**The file:** one `[section]` per Secret, then that Secret's `key=value`
lines. The value is everything after the first `=`, with no quotes and no
inline comment. A line starting `#` is a comment.

- **The four required sections are always there:** `[telflo-postgres]`,
  `[telflo-opamp-server]`, `[telflo-api]` and `[telflo-internal-services]`.
  The file is the whole source of truth for them.
- **The optional ones:** `[telflo-oidc-google]`, `[telflo-mail]` (any of
  its three keys; the SMTP login's two together), and
  `[ghcr-pull]` with `username` and `token-file`, a file holding the
  registry token alone (mode 0600; a relative path is read from the
  secrets file's folder). The token is never typed into the secrets file
  or onto a command line. A token that can only read packages is enough.
- **The section names are the chart's default Secret names.** The script
  writes only those, so an install that renames a Secret in
  `existingSecrets` creates that one itself.
- **A `*-previous` list** (a rotation's previous keys) is comma-separated,
  with no space around a comma.

Then the Secrets, into the release's namespace (create it first):

```sh
scripts/create-secrets.sh --context <context> --namespace telflo my.secrets.env
```

`--context` is required: the script never uses your current context.
Every value is checked before kubectl runs, and none goes on a command
line or into the output. Each Secret is written by a **server-side
apply** with the field manager `telflo-create-secrets`, which stores no
`last-applied-configuration` annotation (a client-side apply would keep
every value in it). That field manager owns the Secrets' keys: a re-run
updates them in place, and a key removed from the file (an old key after
a rotation) is removed from its Secret. Run it again after every change
to the file.

A changed Secret reaches a pod only when the pod restarts:

```sh
kubectl --context <context> -n telflo rollout restart deployment/telflo-api
```

The opamp-server chart's README ("Rotating a secret") has the order for
its secrets and keys.

## The public address

`publicUrl` is the gateway's origin as a browser reaches it, with no path:
`https://telflo.example.com`. It is both `TELFLO_PUBLIC_WEB_URL` and
`TELFLO_PUBLIC_API_URL` (one origin serves both).

The session cookies are always Secure, so a browser keeps them only over
https, or over plain http on `localhost`. A plain-http `publicUrl` works
only as `http://localhost:<port>` through a port-forward. Anywhere else,
terminate TLS in front of the gateway and give the https origin.

`api.trustProxyHops` (default 1) counts the proxies that add an
`X-Forwarded-For` entry in front of the API: the gateway. A load balancer
that passes TCP through adds none, so 1 holds behind it. Whether the
gateway sees the visitor's own address, rather than the load balancer's
or a node's, is the load balancer's setting (`gateway.service`'s
`externalTrafficPolicy: Local`, or your load balancer's annotations).
Without it every visitor shares one address for the API's per-address
limits, sign-in's among them.

## The site

`site` holds what an install offers beyond the signed-in product. The chart
renders all fourteen of its variables on the API's and the web app's pods, so
the two always agree;
[docs/configuration.md's "The site"](../../docs/configuration.md#the-site)
describes each. Its defaults are the open source's:

```yaml
site:
  registration: invite-only   # open | invite-only | closed
  playground: false           # /playground, /playground/editor, /public-editor
  anonymousValidate: false    # POST /api/public/v1/validate/anonymous
  publicFlows: false          # the flow showcase and published flows without sign-in
  salesInquiry: false         # POST /api/v1/sales-inquiries (needs api.salesInquiryTo)
  emailNotifications: false   # Settings › Notifications (off: no nav item, the page a 404)
  userFeedback: false         # Contact us, Product admin › User Feedback and their API
  learning: false             # Learning (/library), Product admin › Library and their API
  userAdmin: false            # Product admin › Users and its API
  docsUrl: "https://docs.telflo.com/"   # "" hides the docs links
  terms:
    version: ""               # "" asks for no Terms anywhere
    termsUrl: ""
    privacyUrl: ""
    cookiePolicyUrl: ""       # the consent banner's link
```

So a fresh install takes no sign-ups, shows no playground, Terms,
Settings › Notifications, Contact us, Learning or Product admin's User
Feedback, Library and Users, and answers 404 to the routes switched off. Its
first account, and first product admin, comes from `telflo-admin
bootstrap` (Install, step 5).

Invite-only means someone already on the site has to invite you. The
product admins' switch "Only product admins can create organizations" is
on by default (it lives in the database, on the Product admins page, not
in these values): only product admins create organizations. Turn it off
to let anyone with an account create an organization and invite people
into it.
Unless registration is `open`, a personal workspace sends no invitations:
people join through an organization's admins
([docs/configuration.md](../../docs/configuration.md#telflo_registration)).

The guards refuse, with fixed words naming the value's path: `site` or
`site.terms` that isn't a map; a switch that isn't `true` or `false` (a
null included); `playground: true` without `anonymousValidate` and
`publicFlows`; `salesInquiry: true` without `api.salesInquiryTo`; a Terms
version that isn't 1 to 32 letters, digits and `._-`, or one without
`termsUrl` and `privacyUrl`; and a URL that isn't `https` (a host, an
optional port and path, no user name or password) or a path starting with
a single `/`. The API's settings refuse the same.

## Mail

`api.mail.transport` is `smtp` (the default) or `sendgrid`. For SMTP:

- **`api.mail.smtp.host`** (required) and **`port`** (default 25). The
  host is a name or an address; an IPv6 address goes without brackets.
- **`tls`**: `starttls` (the default: the connection is upgraded, and a
  relay that can't upgrade it gets nothing), `implicit` (TLS from the
  start, port 465's) or `none` (plain SMTP: a development relay only,
  allowed to a host that isn't loopback only with `allowInsecure: true`).
  The relay's certificate is always verified.
- **`auth: true`**: the relay's login, from `existingSecrets.mail`'s
  `smtp-username` and `smtp-password`, which `create-secrets.sh` writes
  from its `[telflo-mail]` section. Refused at the API's start with `tls:
  none` to a host that isn't loopback.
- **`caSecret`**: the name of a Secret whose `ca.crt` holds the CA
  certificates a private relay's certificate is checked against, mounted
  read-only into the API (mode 0444) as `TELFLO_SMTP_CA_FILE`. The file is
  **bare PEM certificate blocks only** (no comment or `subject=` lines, no
  key), and **it replaces the system's CAs** for the relay's connection
  alone. A CA certificate isn't a secret, so `create-secrets.sh` doesn't
  make this one:

  ```sh
  kubectl --context <context> -n telflo create secret generic telflo-mail-ca --from-file=ca.crt=<the CA's PEM file>
  ```

[docs/configuration.md's "Mail"](../../docs/configuration.md#mail) has the
rules in full.

## Routing other paths: `gateway.extraRoutes`

The gateway can send some paths to another Service in the release's
namespace, ahead of the platform's own: a site's own home page at `/`, its
pages under `/home/`, its `robots.txt`. Each entry is a path, a match, a
Service's name and its port:

```yaml
gateway:
  extraRoutes:
    - { path: /, match: exact, service: website, port: 8081 }
    - { path: /home/, match: prefix, service: website, port: 8081 }
```

The chart renders them into the ConfigMap `telflo-gateway-extra-routes`,
which `default.conf` includes inside its server block: `location = <path>`
for `exact`, `location ^~ <path>` for `prefix` (either wins over every
regular-expression location of the platform's), each proxying to
`<service>.<namespace>.svc:<port>` and logging only `crit` and worse to the
error log (an upstream's failure would quote the request line). The access
log's redactions are the server's and cover them. The pods carry a
checksum of the list, so a change rolls them.

**The guards** (the schema, then the chart's own, with fixed words naming
the entry's index):
- `path`: a leading `/`, then letters, digits and `._~/-`, at most 200
  characters, with no empty, `.` or `..` segment; `match`: `exact` or
  `prefix`; `service`: a Service's name (at most 63 lower-case letters,
  digits and `-`); `port`: a number from 1 to 65535; two entries with the
  same match and path are refused.
- **No route may shadow the platform.** Compared in lower case: a `prefix`
  `/` is refused, and for each of the platform's first path segments
  (`api`, `app`, `login`, `register`, `assets`, `_root.data` and the rest,
  `telflo.platformRoots` in `templates/_helpers.tpl`, which a
  render case holds equal to the web app's routes and `public/` folder), a
  path equal to it, under it (`/login/…`) or beside it (`/login.data`), and
  a prefix route that it starts with (`/ap` would take `/api` and `/app`).
  An exact `/`, `/robots.txt`, `/home/` and the old marketing paths are
  allowed.

**What the Service must do:**
- **Exist before the gateway starts.** nginx resolves each Service's name
  once, when it starts: a name that doesn't resolve stops it starting, and
  a Service re-created with a new address is reached only after the
  gateway's pods restart.
- **Admit the gateway's pods** if a NetworkPolicy guards it: the gateway's
  pods carry `app.kubernetes.io/name: telflo` and
  `app.kubernetes.io/component: gateway`. The gateway itself has no
  policy, so nothing holds its side back.
- **Read the request's URI as sent.** `proxy_pass` names no URI, so the
  Service receives the client's URI unchanged (nginx doesn't normalize it
  first) and must normalize and check it itself.

**`/home` without its slash** answers nginx's own 301 to `/home/` for a
`prefix` `/home/` route, an absolute redirect built from the gateway's own
scheme and port, as `/api` does today: behind a load balancer that ends
TLS, link to `/home/` itself. And a `prefix` route takes every path under
it ahead of the gateway's own regular-expression locations, so
`/home/quick-deploy/…` reaches the Service rather than nginx's own 404 (its
access line is still redacted). Both are known limits.

## Install

1. **The namespace**, labeled for the restricted Pod Security level:

   ```sh
   kubectl --context <context> create namespace telflo
   ```

   ```sh
   kubectl --context <context> label namespace telflo pod-security.kubernetes.io/enforce=restricted
   ```

2. **The Secrets** (above).

3. **Your values file**, `my-values.yaml`: at least `publicUrl`, the mail
   settings and `opamp-server.server.publicUrl`, plus your cluster's own
   (storage classes, the Services' annotations), and any `site` value or
   `gateway.extraRoutes` entry you want other than the defaults.

4. **The chart,** at the release's version:

   ```sh
   helm install telflo oci://ghcr.io/telflo/telflo/charts/telflo --version <version> --kube-context <context> -n telflo -f my-values.yaml --wait --timeout 20m
   ```

   From a checkout, `charts/telflo` in place of the OCI reference and its
   `--version` installs the chart as it is in the tree.

   Postgres starts first and runs both bootstraps on its empty volume.
   The API's `migrate` init container fails until Postgres answers, and
   the kubelet starts it again; then it runs the migrations, and the API
   starts. `NOTES.txt` prints the origin and the next commands.

5. **The first admin**, at once. Under the default
   `site.registration: invite-only` nobody can sign up, so the first
   account comes from a command in the API's container, with its settings
   and database role:

   ```sh
   kubectl --context <context> -n telflo exec deploy/telflo-api -c api -- telflo-admin bootstrap --email <email> --organization <name>
   ```

   It makes the account and its group organization, makes it the first
   product admin, and prints a link to set its password once, as the
   output's last line (the password reset's link, once, within 60 minutes);
   it never sends email, so mail needn't be set up yet. The first sign-in
   lands in that organization. That link is a secret: run it in your own
   terminal, never where output is kept (a CI log); `kubectl exec`'s output
   goes to you alone, never to the pod's logs. Lost or expired,
   `telflo-admin reset-link --email <email>` (the same exec) prints a new
   one for any person's account, the earlier one no longer working.
   Otherwise it prints fixed lines and the address only; it works once, and
   is refused once any product admin exists.
   Until it has run, anything that can run SQL as the API's role could
   make the first product admin, so run it before anything else.
   [docs/configuration.md's "Administration"](../../docs/configuration.md#administration)
   has the details and exit codes. The admin then invites everyone else.

**The database owner isn't a superuser.** Postgres's superuser,
`postgres`, runs only the two bootstraps at the first start. The `telflo_platform_owner`
role owns the `telflo_platform` database with `LOGIN CREATEROLE` and nothing more.
It runs the migrations and provisions `telflo_platform`, the API's role, which
holds none of SUPERUSER, BYPASSRLS, CREATEDB or REPLICATION. The owner's
password reaches only Postgres and the `migrate` init container; the API
gets its own role's password only.

## Upgrade

```sh
helm upgrade telflo oci://ghcr.io/telflo/telflo/charts/telflo --version <version> --kube-context <context> -n telflo -f my-values.yaml --wait --timeout 20m
```

Each new API pod runs `migrate` first, as at the install, as the `telflo`
owner. Migrations, the catalog's sync and the role's provisioning each
take an advisory lock, so pods starting together wait for each other, and
a run with no new migration migrates nothing. **Back up the database before
every upgrade:** the migrations run as soon as the new pods start, and
going back means restoring that backup.

## Uninstall

```sh
helm uninstall telflo --kube-context <context> -n telflo
```

**Both volumes are kept:** Postgres's (`data-telflo-postgres-0`), as a
StatefulSet's claims always are, and with the local file store
`telflo-api-file-store`, by its `helm.sh/resource-policy: keep`. Delete
them to remove the data:

```sh
kubectl --context <context> -n telflo delete pvc data-telflo-postgres-0 telflo-api-file-store
```

- **A reinstall onto kept volumes:** Postgres reuses its claim in the same
  namespace and skips its bootstraps (the data exists), so the database
  keeps the passwords it was made with: reinstall with the same Secrets.
  Helm still marks the file store's claim as the release's, so a
  reinstall adopts it only under the same release name in the same
  namespace.
- **Switching `api.fileStore.kind` from local to s3** leaves the file
  store's claim in place, managed by nothing, with its files: copy them to
  the bucket first, then delete the claim yourself.

## The kind smoke

`scripts/smoke-kind.sh` installs this chart into a throwaway kind cluster
and drives it end to end on the chart's defaults: the Secrets, the install
and an upgrade, the policies, the databases' refusals, registration
refused and the first admin made by `telflo-admin bootstrap` (its printed
set-password link, a sign-in landing in its organization, a teammate
invited), a configuration validated, tested and published, a collector
following it, the CLI's anonymous validate refused, and the uninstall. Its
kubeconfig is a file of its own, and it never changes your current
kubectl context.

Its options:
- **`--images <version>`**: run the five images already in the local
  Docker engine as `ghcr.io/telflo/telflo/<name>:<version>`, building
  nothing; without it, it builds them from this tree.
- **`--chart <tgz>`**: install that packaged chart; without it, this
  folder.
- **`--profile <name>`**: the cluster's name (never one that exists).

It needs Docker, kind (`scripts/release/tools.sh fetch`, the pinned
release, never installed system-wide), kubectl, helm, node, jq, curl,
openssl and python3; telflo-core's `node_modules` and a built CLI
(`npm run build -w @telflo/cli` in `telflo-core`); 10.5 GB free in
Docker's disk; and internet access: its NetworkPolicy step checks that a
pod with no policy reaches the outside, so it fails offline by design
(Postgres is pulled inside the node, by the chart's digest). These images
must already be in the local Docker engine (a missing one is refused,
never pulled):
- kind's node image at `scripts/release/tools.lock`'s digest
  (`scripts/release/tools.sh pull kind-node`);
- `nginx:1.30-alpine` at the digest `values.yaml` pins for the gateway,
  and `axllent/mailpit:v1.31`;
- `ghcr.io/telflo/opamp-server` at `vendor/opamp-server/PIN`'s version
  and digest;
- `ghcr.io/telflo/telflo/collector:<version>` at the catalog's default
  version (`catalog/distributions/otelcol-contrib.json`);
- with `--images`, the five release images above; without it, the bases
  the Dockerfiles pin (only `node:24-bookworm-slim` and distroless's
  `static` are pulled, at their pinned digests, when missing, and removed
  again at the end).

Run it on AC power with the lid open; `docs/conventions/testing.md` has
the details, and `--help` lists every option.

## Publishing

A release publishes this chart and the five platform images together.
Pushing a `v<version>` tag on `main` (the version `Chart.yaml` holds)
starts the release workflow: it builds the images for `linux/amd64` and
`linux/arm64` once (`scripts/publish-platform-images.sh --build-oci`),
packages the chart (`scripts/publish-chart.sh --package`), tests those
exact bytes (the Compose stack, an install from the Compose archive, and
this chart in kind), and only then copies them to GHCR
(`--push-oci`, `--push-package`) and pulls them back by digest. Nothing
is published by hand. Locally, the scripts' `--dry-run` checks
everything and pushes nothing:

```sh
scripts/publish-platform-images.sh --dry-run --builder <name>
```

```sh
scripts/publish-chart.sh --dry-run
```

## Tests

`tests/render-tests.sh` renders every profile in `tests/profiles/` and runs
every case in `tests/cases/`, offline:

```sh
bash charts/telflo/tests/render-tests.sh
```

`scripts/check-chart-cloud-neutral.sh` checks the chart holds nothing
cloud-specific, and `scripts/check-opamp-server-pin.sh` that the vendored
chart is the pinned release's (`docs/conventions/opamp-server.md`).
