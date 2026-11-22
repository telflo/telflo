# Configuring Telflo

Every setting is an environment variable, read once as a process starts:
a change applies when the service restarts. The API checks every setting
it reads before it listens, and refuses to start on a missing or invalid
one, with fixed words naming the variable, never its value. The web app's
server reads a few of the same settings and a few of its own.

Each section's table gives a setting's name in each install:

- **Compose:** how the [Compose install](compose.md) sets it. "`.env`" is
  a line of `.env`, which `setup.sh` writes (the option in brackets) or
  you add; "fixed" means `compose.yaml` sets it; "not passed" means only a
  `compose.override.yaml` of yours can set it.
- **Helm chart:** the [chart's](../charts/telflo/README.md) value, or the
  Secret and key it reads (the chart never takes a secret as a value);
  "fixed" means the chart sets it; "not set" means the default holds.
- **Default:** the value when the variable is absent or empty; "required"
  means the API refuses to start without it.

**Contents:** [The public addresses](#the-public-addresses) ·
[Sessions and accounts](#sessions-and-accounts) ·
[The databases](#the-databases) · [The site](#the-site) · [Mail](#mail) ·
[Google sign-in](#google-sign-in) · [The opamp-server](#the-opamp-server) ·
[The collector validator](#the-collector-validator) ·
[The collector tester](#the-collector-tester) ·
[The OTTL evaluator](#the-ottl-evaluator) ·
[The file store](#the-file-store) ·
[Installing collectors](#installing-collectors) ·
[Quick-deploy links](#quick-deploy-links) ·
[Library links](#library-links) · [Analytics](#analytics) ·
[The secrets](#the-secrets) · [Administration](#administration)

## The public addresses

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| [`TELFLO_PUBLIC_WEB_URL`](#telflo_public_web_url) | API, web | `.env` (`--public-url`) | `publicUrl` | required |
| [`TELFLO_PUBLIC_API_URL`](#telflo_public_api_url) | API | `.env` (`--public-url`) | `publicUrl` | required |
| [`TELFLO_WEB_ORIGIN`](#telflo_web_origin) | API | not passed | not set | `TELFLO_PUBLIC_WEB_URL` |
| [`TELFLO_COOKIE_SECURE`](#telflo_cookie_secure) | API | `.env` (from `--public-url`) | not set | `true` |
| [`TELFLO_TRUST_PROXY_HOPS`](#telflo_trust_proxy_hops) | API | `.env` (`1`) | `api.trustProxyHops` (`1`) | `0` |
| [`TELFLO_API_PORT`](#telflo_api_port) | API | fixed, `8080` | fixed, `8080` | required |
| [`TELFLO_API_INTERNAL_URL`](#telflo_api_internal_url) | web | fixed, `http://api:8080` | fixed | `http://localhost:8080` |
| [`PORT`, `HOST`](#port-and-host) | web | the image's | the image's | `3000`, every address |

### `TELFLO_PUBLIC_WEB_URL`

The web app's origin as browsers reach it: the gateway's, such as
`https://telflo.example.com`. The API builds every link it emails from it
(email confirmations, password resets, invitations, the bootstrap's link),
and the web server its canonical links, `og:url` and the Organization
JSON-LD's address. A trailing `/` is removed. In both installs the web
app and the API share this one origin, through the gateway.

### `TELFLO_PUBLIC_API_URL`

The API's base URL as a host running a Quick Deploy command reaches it:
the gateway's origin, the same as `TELFLO_PUBLIC_WEB_URL` in both
installs. `http` or `https`, a host name or an address, an optional port
and a path of letters, digits and `._~+-` segments; no user name, query,
fragment or `%`; a trailing `/` is removed. An IPv6 address goes in
brackets, and only an IPv6 address may (`http://[fd00::10]:8080`;
`http://[abc]` is refused).

### `TELFLO_WEB_ORIGIN`

The origin the API's CORS answers name. It falls back to
`TELFLO_PUBLIC_WEB_URL`, which is right whenever the web app and the API
share the gateway's origin, as both installs do.

### `TELFLO_COOKIE_SECURE`

Whether the session cookies are Secure: `true` or `false`, default
`true`. `false` is refused unless `TELFLO_PUBLIC_WEB_URL` is an `http` URL
on `localhost`, `127.0.0.1` or `[::1]`, so an insecure cookie can't reach
a real deployment. `setup.sh` writes `false` for such a URL and `true`
otherwise; the chart leaves it at `true`.

### `TELFLO_TRUST_PROXY_HOPS`

How many proxies in front of the API add an entry to `X-Forwarded-For`,
whose addresses the API trusts to find the visitor's own: an integer, 0
or more, default 0. Both installs set 1, the gateway. Add one for each
proxy of yours that adds an entry: 2 behind a TLS proxy such as Caddy
([docs/compose.md](compose.md#tls-in-front)). A load balancer that passes
TCP through adds none. With too few, every visitor shares one address for
the API's per-address limits, sign-in's among them.

### `TELFLO_API_PORT`

The port the API listens on. Both installs use 8080 inside the API's
container; the gateway reaches it there.

### `TELFLO_API_INTERNAL_URL`

Where the web app's server reaches the API directly, for its own loaders:
`http://api:8080` in Compose, the API's Service in the chart.
Default `http://localhost:8080`.

### `PORT` and `HOST`

The web app's server listens on `PORT` (default 3000, a whole number from
1 to 65535; anything else stops it) and on `HOST`, or every address when
`HOST` is unset. The images and the chart keep the defaults.

## Sessions and accounts

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| [`TELFLO_ACCESS_TOKEN_SECRET`](#telflo_access_token_secret) | API | `.env` (generated) | Secret `telflo-api`, `access-token-secret` | required |
| [`TELFLO_ACCESS_TOKEN_TTL_MINUTES`](#telflo_access_token_ttl_minutes-and-telflo_refresh_token_ttl_days) | API | not passed | not set | `15` |
| [`TELFLO_REFRESH_TOKEN_TTL_DAYS`](#telflo_access_token_ttl_minutes-and-telflo_refresh_token_ttl_days) | API | not passed | not set | `30` |
| [`TELFLO_VERIFICATION_TOKEN_TTL_HOURS`](#telflo_verification_token_ttl_hours) | API | fixed, `24` | `api.verificationTokenTtlHours` (`24`) | required |

A session is two HttpOnly cookies: a short-lived access token and a
rotating refresh token, with reuse detection. When a request finds the
access token expired, the web app refreshes it once and retries, so a
session lasts as long as its refresh token. Every state-changing `/api/v1`
request needs the header `X-Telflo-CSRF: 1`.

### `TELFLO_ACCESS_TOKEN_SECRET`

The key that signs the access tokens (HS256): at least 32 bytes, never
logged; a refusal states its length, never the value.

### `TELFLO_ACCESS_TOKEN_TTL_MINUTES` and `TELFLO_REFRESH_TOKEN_TTL_DAYS`

The two lifetimes: the access token's in minutes, 1 to 15 (default 15),
and the refresh token's in days, 1 or more (default 30). Digits only.

### `TELFLO_VERIFICATION_TOKEN_TTL_HOURS`

How long an email confirmation's link works, in hours: a positive
integer.

## The databases

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| [`TELFLO_DATABASE_URL`](#telflo_database_url-and-telflo_migration_database_url) | API, migrations | fixed, with `TELFLO_API_PASSWORD` | fixed, with `telflo-postgres`'s `api-password` | required |
| [`TELFLO_MIGRATION_DATABASE_URL`](#telflo_database_url-and-telflo_migration_database_url) | migrations | fixed, with `TELFLO_OWNER_PASSWORD` | fixed, with `telflo-postgres`'s `owner-password` | required for migrations |

### `TELFLO_DATABASE_URL` and `TELFLO_MIGRATION_DATABASE_URL`

Migrations connect as the database's owner, `telflo_platform_owner`, through
`TELFLO_MIGRATION_DATABASE_URL`; the API connects as its own role,
`telflo_platform`, through `TELFLO_DATABASE_URL`, which row-level security
constrains. The migration step creates that role, or resets its password,
from the URL. The API refuses to start as a superuser, a role that
bypasses row-level security, or the tables' owner. The owner isn't a
superuser either: Postgres's own superuser, `postgres`, only runs the
bootstraps that make the roles and the databases.

Both installs run one Postgres 18 with two databases, `telflo_platform` and the
opamp-server's `telflo_opamp_server`, and build the URLs from the passwords
([The secrets](#the-secrets)). The passwords must be URL-safe (only
`A-Z a-z 0-9 . _ ~ -`); the generated ones are. Neither side's roles can
connect to the other's database.

## The site

What an install offers beyond the signed-in product: who may register,
the playground, the reads without signing in, Settings › Notifications,
the Terms and the docs link. The API and the web app read the same
variables with the same rules, so the two can't disagree: Compose passes
`.env`'s values to both, and the chart its `site` values to both pods. A
value the rules refuse stops the API from starting and fails the web's
pages, with fixed words naming the variable. Unset or `""` is the
default, but for `TELFLO_DOCS_URL`; a switch is exactly `true` or `false`.
The defaults are the open source's: an install that only its own people
use.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| [`TELFLO_REGISTRATION`](#telflo_registration) | API, web | `.env` | `site.registration` | `invite-only` |
| [`TELFLO_PLAYGROUND`](#telflo_playground) | API, web | `.env` | `site.playground` | `false` |
| [`TELFLO_ANONYMOUS_VALIDATE`](#telflo_anonymous_validate) | API, web | `.env` | `site.anonymousValidate` | `false` |
| [`TELFLO_PUBLIC_FLOWS`](#telflo_public_flows) | API, web | `.env` | `site.publicFlows` | `false` |
| [`TELFLO_SALES_INQUIRY`](#telflo_sales_inquiry-and-telflo_sales_inquiry_to) | API, web | `.env` | `site.salesInquiry` | `false` |
| [`TELFLO_SALES_INQUIRY_TO`](#telflo_sales_inquiry-and-telflo_sales_inquiry_to) | API | `.env` (add) | `api.salesInquiryTo` | none |
| [`TELFLO_EMAIL_NOTIFICATIONS`](#telflo_email_notifications) | API, web | `.env` | `site.emailNotifications` | `false` |
| [`TELFLO_USER_FEEDBACK`](#telflo_user_feedback) | API, web | `.env` | `site.userFeedback` | `false` |
| [`TELFLO_LEARNING`](#telflo_learning) | API, web | `.env` | `site.learning` | `false` |
| [`TELFLO_USER_ADMIN`](#telflo_user_admin) | API, web | `.env` | `site.userAdmin` | `false` |
| [`TELFLO_DOCS_URL`](#telflo_docs_url) | API, web | `.env` | `site.docsUrl` | `https://docs.telflo.com/` |
| [`TELFLO_TERMS_VERSION`](#telflo_terms_version) | API, web | `.env` | `site.terms.version` | `""` |
| [`TELFLO_TERMS_URL`, `TELFLO_PRIVACY_URL`](#telflo_terms_url-and-telflo_privacy_url) | API, web | `.env` | `site.terms.termsUrl`, `site.terms.privacyUrl` | `""` |
| [`TELFLO_COOKIE_POLICY_URL`](#telflo_cookie_policy_url) | API, web | `.env` | `site.terms.cookiePolicyUrl` | `""` |

A switched-off page or route answers exactly as one that doesn't exist:
the web's 404 page, the API's 404 `not_found`. `/` answers 302, to `/app`
when signed in and to `/login` otherwise, and `robots.txt` is
`User-agent: *` and `Disallow: /` (an install's pages aren't for search
engines); there is no sitemap. A site that serves its own home page or
`robots.txt` routes them to its own service ahead of the platform's, with
the chart's `gateway.extraRoutes` or the Compose install's
`gateway/extra-routes.conf`.

A URL setting is `https` with a host, an optional port and an optional
path, query or fragment (no user name or password), or a path on this
origin starting with a single `/`, of URL characters only, at most 2,000
characters.

### `TELFLO_REGISTRATION`

Who may create an account: `open`, `invite-only` (the default) or
`closed`.

- **`invite-only`:** registering (`POST /api/v1/auth/register`) answers
  403 `registration_not_open` before it reads the body, a Google sign-in
  with no matching account is refused with the same code and creates
  nothing, and an invitation from a group organization still creates an
  account. The first account comes from
  [`telflo-admin bootstrap`](#telflo-admin-bootstrap).
- **`closed`:** registering from any invitation is refused too; an
  existing account can still accept one.
- **`open`:** anyone signs up, and the sign-in page offers "Sign up".

Signing in, and linking or taking over an existing account with Google,
work in every mode. Unless registration is `open`, a personal workspace
(every account admins its own) sends no invitations: an invite or a
resend from it answers 403 `personal_organization_invitations_disabled`,
and its Invited page says "Invitations can't be sent from a personal
workspace on this site." in Invite Member's place. Leftover invitations
from a personal workspace (sent while the site was open) can still be
canceled, and under `invite-only` they never create an account. An
invited person who creates an account gets their own personal workspace
and joins the organization that invited them; if it made them an admin,
they invite others into it.

**Who may create an organization** isn't an environment setting: it is
the product admins' switch "Only product admins can create
organizations", on their Product admins page
(`/product-admin/product-admins`), stored in the database, changed only by
a product admin and audited. It is on by default, in every registration
mode: a new install lets only product admins create organizations (the
bootstrap's first admin is one), and `POST /api/v1/organizations` answers
403 `organization_creation_restricted` to anyone else, with "Create
Organization" disabled and the reason shown. Turn it off to let anyone
with an account create an organization and invite people into it. It
doesn't touch organizations that already exist: their admins keep
inviting.

### `TELFLO_PLAYGROUND`

`/playground`, `/playground/editor` and `/public-editor`, a sample
workspace for visitors with no account: `false` by default. `true` only
with `TELFLO_ANONYMOUS_VALIDATE` and `TELFLO_PUBLIC_FLOWS` `true` too (the
playground uses both).

### `TELFLO_ANONYMOUS_VALIDATE`

`POST /api/public/v1/validate/anonymous`, the CLI's `telflo validate`
without a login: `false` by default. Off, the CLI says "This server
doesn't validate without a login: run telflo login (or set
TELFLO_TOKEN)." and exits 3.

### `TELFLO_PUBLIC_FLOWS`

The flow showcase (`GET /api/v1/flow-showcase`) and the published flows
(`GET /api/v1/published-flows`, `/:slug`) without signing in: `false` by
default. The signed-in flows gallery (`/app/flows`) is always there.

### `TELFLO_SALES_INQUIRY` and `TELFLO_SALES_INQUIRY_TO`

`POST /api/v1/sales-inquiries`, the contact form of a marketing site
served beside the platform: `false` by default. `TELFLO_SALES_INQUIRY_TO`,
the API's only, is the one address the inquiries go to, required while
`TELFLO_SALES_INQUIRY` is `true`; there is no default address.

### `TELFLO_EMAIL_NOTIFICATIONS`

Settings › Notifications, the two email switches (product updates, tips):
`false` by default. Off, the Settings nav has no Notifications item and
`/settings/notifications` is the app's 404; a person's choices stay
stored either way.

### `TELFLO_USER_FEEDBACK`

The sidebar's Contact us, the form a signed-in person sends feedback
with, and Product admin › User Feedback, where product admins answer it:
`false` by default. Off, neither shows, `/product-admin/user-feedback` is
the app's 404, and `POST /api/v1/feedback` and every
`/api/v1/product-admin/feedback` route answer 404 `not_found`. The
feedback's table is there either way, empty while it's off.

### `TELFLO_LEARNING`

The sidebar's Learning (`/library`), the files a person downloads, and
Product admin › Library, where product admins manage them: `false` by
default. Off, neither shows, `/library` and `/product-admin/library` are
the app's 404, and every `/api/v1/library-files` route and the files'
links (`/api/v1/library-links/…`) answer 404 `not_found`. The library's
table is there either way, empty while it's off.

### `TELFLO_USER_ADMIN`

Product admin › Users, every account with its delete: `false` by
default. Off, the nav has no Users item, `/product-admin/users` is the
app's 404, and `/api/v1/product-admin/users` and its delete answer 404
`not_found`. An organization's admin still removes members on its
Permissions page.

### `TELFLO_DOCS_URL`

Where the docs links go (the sidebar's Docs, the library page's, the
playground's) and where `/docs` and every `/docs/*` path redirect (301):
`https://docs.telflo.com/` when the variable is absent. Set to `""`, every
docs link is hidden and `/docs` is 404.

### `TELFLO_TERMS_VERSION`

`""` by default: no Terms anywhere (no checkbox when registering or
joining from an invitation, no Terms dialog). A version (1 to 32 letters,
digits and `._-`) is the one every user must have accepted, at
registration or in a dialog on `/app`; changing it shows every user the
dialog again. It needs `TELFLO_TERMS_URL` and `TELFLO_PRIVACY_URL`.

### `TELFLO_TERMS_URL` and `TELFLO_PRIVACY_URL`

Where the Terms of Service and the Privacy Policy are read: the
registration forms' and the dialog's links, opened in a new tab.

### `TELFLO_COOKIE_POLICY_URL`

The consent banner's "Cookie Policy" link; empty, the banner names no
policy. The banner shows only with a PostHog key ([Analytics](#analytics)).

## Mail

The API sends its emails (email confirmations, password resets,
invitations, product admins' notices and replies) through an SMTP relay
or SendGrid. The bootstrap's and `reset-link`'s links are printed, never
mailed, so an install works before its mail does.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| [`TELFLO_MAIL_TRANSPORT`](#telflo_mail_transport-and-telflo_mail_from) | API | `.env` (`smtp`) | `api.mail.transport` (`smtp`) | required |
| [`TELFLO_MAIL_FROM`](#telflo_mail_transport-and-telflo_mail_from) | API | `.env` (`--mail-from`) | `api.mail.from` | required |
| [`TELFLO_SMTP_HOST`, `TELFLO_SMTP_PORT`](#telflo_smtp_host-and-telflo_smtp_port) | API | `.env` (`--smtp-host`, `--smtp-port`) | `api.mail.smtp.host`, `api.mail.smtp.port` (`25`) | required with `smtp` |
| [`TELFLO_SMTP_TLS`](#telflo_smtp_tls) | API | `.env` (`--smtp-tls`) | `api.mail.smtp.tls` (`starttls`) | `starttls` |
| [`TELFLO_SMTP_USERNAME`, `TELFLO_SMTP_PASSWORD`](#telflo_smtp_username-and-telflo_smtp_password) | API | `.env` (`--smtp-username`, `--smtp-password-file`) | Secret `telflo-mail`, `smtp-username` and `smtp-password`, with `api.mail.smtp.auth: true` | none |
| [`TELFLO_SMTP_CA_FILE`](#telflo_smtp_ca_file) | API | not passed | `api.mail.smtp.caSecret` | the system's CAs |
| [`TELFLO_SMTP_ALLOW_INSECURE`](#telflo_smtp_allow_insecure) | API | `.env` | `api.mail.smtp.allowInsecure` (`false`) | `false` |
| [`TELFLO_SENDGRID_API_KEY`](#telflo_sendgrid_api_key) | API | `.env` (add) | Secret `telflo-mail`, `sendgrid-api-key` | required with `sendgrid` |

With `setup.sh --mailpit`, the Compose install sends to Mailpit
(`mailpit:1025`, `TELFLO_SMTP_TLS=none`,
`TELFLO_SMTP_ALLOW_INSECURE=true`), for trying Telflo only;
[docs/compose.md](compose.md#mail) moves it to a real relay.

### `TELFLO_MAIL_TRANSPORT` and `TELFLO_MAIL_FROM`

`smtp` or `sendgrid`, with no default; and the sender's address. Only the
chosen transport's settings are read.

### `TELFLO_SMTP_HOST` and `TELFLO_SMTP_PORT`

The relay. The host is a name or an address; an IPv6 address is written
without brackets (`::1`). The port is required with `smtp` (the chart's
default is 25).

### `TELFLO_SMTP_TLS`

`starttls` (the default) upgrades the connection and gives up on a relay
that can't upgrade it, so nothing is sent in clear; `implicit` opens TLS
from the start (port 465's); `none` sends in clear, for a development
relay such as Mailpit. The relay's certificate is always verified, its
host name included, against the system's CAs or `TELFLO_SMTP_CA_FILE`'s.

### `TELFLO_SMTP_USERNAME` and `TELFLO_SMTP_PASSWORD`

The relay's login, both or neither (one alone refuses to start), sent as
PLAIN or LOGIN. Never logged and never in an error. Refused with `none`
unless the host is loopback, even with `TELFLO_SMTP_ALLOW_INSECURE`.
`setup.sh` reads the password from a file (`--smtp-password-file`),
never from its command line.

### `TELFLO_SMTP_CA_FILE`

An absolute path to the CA certificates a private relay's certificate is
checked against, read once as the API starts. **Bare PEM blocks only**:
one or more `-----BEGIN CERTIFICATE-----` … `-----END CERTIFICATE-----`
blocks and nothing else but white space; a bundle carrying comment or
`subject=` lines, a private key or any other text is refused. **It
replaces the system's CAs** for the relay's connection alone: the relay's
certificate must chain to a certificate in the file. No other connection
the API makes trusts it. The chart mounts a Secret's `ca.crt` there
(`api.mail.smtp.caSecret`).

### `TELFLO_SMTP_ALLOW_INSECURE`

`true` or `false` (default `false`): lets `none` send to a host that isn't
loopback, such as the Compose install's `mailpit`. Never against a
real relay. **Loopback is an exact list**: `localhost`, `127.0.0.1` and
`::1`, as written; any other name that happens to resolve to the machine
isn't loopback.

### `TELFLO_SENDGRID_API_KEY`

SendGrid's API key, required with `sendgrid`, never logged.

A connection waits at most 10 s to open, 10 s for the relay's greeting
and 60 s of silence. A failed send is reported in fixed words with the
error's code and the relay's reply code only, never the relay's text,
which can quote the login or the recipient.

## Google sign-in

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| `TELFLO_OIDC_GOOGLE_CLIENT_ID`, `TELFLO_OIDC_GOOGLE_CLIENT_SECRET` | API | `.env` (add) | `api.oidcGoogle.enabled: true` and Secret `telflo-oidc-google`, `client-id` and `client-secret` | off |
| `TELFLO_OIDC_GOOGLE_ISSUER` | API | not passed | not set | `https://accounts.google.com` |

"Sign in with Google" appears on the sign-in page once a Google OAuth
client is configured. Create a *Web application* client in the Google
Cloud Console with the redirect URI
`<TELFLO_PUBLIC_WEB_URL>/api/v1/auth/oidc/google/callback`, then set both
variables and restart the API. With neither set, Google is off; with one
alone, the API refuses to start. While the client's OAuth consent screen
is in "Testing", Google admits only the test users listed on it. Only
`@gmail.com`, `@googlemail.com` and Google Workspace accounts can sign in.
Unless `TELFLO_REGISTRATION` is `open`, a Google sign-in with no matching
account is refused and creates nothing; under `invite-only` an invitee
registers with a password on the invitation's page instead. Signing in,
and linking or taking over an existing account with Google, work in every
mode.

`TELFLO_OIDC_GOOGLE_ISSUER` replaces Google's issuer, for tests against a
fake provider: an `https` URL, or `http` on `localhost`, `127.0.0.1` or
`[::1]` only.

## The opamp-server

The [opamp-server](https://github.com/telflo/opamp-server) holds the
fleets and serves the collectors. The API manages it through its
management API, which neither install publishes.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| [`TELFLO_OPAMP_MANAGEMENT_URL`](#telflo_opamp_management_url-and-telflo_opamp_management_secret) | API | fixed, `http://opamp-server:51235` | fixed | required |
| [`TELFLO_OPAMP_MANAGEMENT_SECRET`](#telflo_opamp_management_url-and-telflo_opamp_management_secret) | API | `.env` (generated) | Secret `telflo-opamp-server`, `management-secret` | required |
| [`TELFLO_OPAMP_AGENT_PUBLIC_URL`](#telflo_opamp_agent_public_url-and-opamp_server_url) | API | `.env` (`--agent-url`) | `opamp-server.server.publicUrl` | required |
| [`OPAMP_SERVER_URL`](#telflo_opamp_agent_public_url-and-opamp_server_url) | opamp-server | `.env` (`--agent-url`) | `opamp-server.server.publicUrl` | required |
| [`TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS`](#telflo_opamp_allow_insecure_connections) | API | `.env` (from `--agent-url`) | `api.opampAllowInsecureConnections` (`false`) | `false` |

### `TELFLO_OPAMP_MANAGEMENT_URL` and `TELFLO_OPAMP_MANAGEMENT_SECRET`

The management API's URL (`http` or `https`, no user name or password)
and its shared secret (at least 32 bytes, never logged), both required.
The opamp-server reads the same secret; its encryption key, which
encrypts the enrollment tokens' bearers, only the opamp-server holds
([The secrets](#the-secrets)).

### `TELFLO_OPAMP_AGENT_PUBLIC_URL` and `OPAMP_SERVER_URL`

The agent endpoint's URL as collectors reach it, ending in
`/opamp/api/v1`, such as `https://opamp.example.com/opamp/api/v1`. The
API writes it into every install command and bundle; the opamp-server
hands it to each collector after its first poll, and the collector polls
it from then on. Both must be the same: Compose sets both from
`--agent-url`, the chart both from `opamp-server.server.publicUrl`.
`http`, `https`, `ws` or `wss` for the API (the chart allows `http` or
`https`), a host, an optional port and a plain path, no user name, query
or fragment. An address only some collectors reach shows the others
`online` once, then `unknown`.

### `TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS`

`true` or `false` (default `false`): whether an installed collector may
connect without TLS checks. `setup.sh` writes `true` for an `http`
`--agent-url` only; a real deployment's endpoint is `https` and keeps
`false`.

The opamp-server's own settings (its database role, rate limits, TLS,
telemetry) are in its
[configuration guide](https://github.com/telflo/opamp-server/blob/main/docs/configuration.md);
the chart passes `opamp-server.*` values to its chart.

## The collector validator

Checks a configuration with the collector version it is pinned to. While
it is down, slow (20 seconds) or busy, an editor's check answers
"unavailable" and nothing else breaks.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| `TELFLO_OTELCOL_VALIDATOR_URL` | API | fixed, `http://otelcol-validator:8001` | fixed | required |
| `TELFLO_OTELCOL_VALIDATOR_SECRET` | API, validator | `.env` (generated) | Secret `telflo-internal-services`, `otelcol-validator-secret` | required |

The URL is `http` or `https` with no user name or password; the secret is
at least 32 bytes, never logged, and the same on both sides (the
validator reads it as `OTELCOL_VALIDATOR_SECRET`).

## The collector tester

Runs a configuration's test runs: the pinned collector in a sandbox, fed
the run's input, with kwok's fake Kubernetes cluster beside it. It sits
on a network with no way out. The API queues the runs, taking turns per
person, and sends one to the tester when a slot is free. While the tester
is down, a new run is refused with "Testing is unavailable right now. Try
again later." and nothing else breaks.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| `TELFLO_OTELCOL_TESTING_URL` | API | fixed, `http://otelcol-testing:8002` | fixed | required |
| `TELFLO_OTELCOL_TESTING_SECRET` | API, tester | `.env` and `secrets/otelcol_testing_secret` (generated) | Secret `telflo-internal-services`, `otelcol-testing-secret` | required |
| `TELFLO_TEST_RUNS_PER_TESTER` | API | not passed | not set | `4` |
| `TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS` | API | not passed | not set | `600` |

The URL and the secret follow the validator's rules; the tester reads its
secret only from a file, never from its environment.
`TELFLO_TEST_RUNS_PER_TESTER` (1 to 64) is how many runs go at once
across every API process, the tester's own cap; the OTTL evaluator checks
at most 4 runs' rules at once, so more only makes bursts wait.
`TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS` (at most 86,400) is how long the
tester may be down before waiting runs fail.

## The OTTL evaluator

Checks test runs' validation rules (text, regex and OTTL) after the
tester answers, and each OTTL or regex rule, and each regex library entry,
when it is saved. It sits alone on a network with no way out. While it
can't be reached, saving a rule that needs checking is refused, a run
that would carry rules is refused when it is queued, and a run already
under way whose rules can't be checked ends Error with its output kept;
runs without rules and everything else work as before.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| `TELFLO_OTTL_EVALUATOR_URL` | API | fixed, `http://ottl-evaluator:8003` | fixed | required |
| `TELFLO_OTTL_EVALUATOR_SECRET` | API, evaluator | `.env` and `secrets/ottl_evaluator_secret` (generated) | Secret `telflo-internal-services`, `ottl-evaluator-secret` | required |

The URL and the secret follow the validator's rules; the evaluator reads
its secret only from a file.

## The file store

Keeps test inputs, runs' files, test suites' inputs, test templates,
organizations' logos and the library's files, named by ids only and
reached only through the API (a logo is read without signing in, by its
two ids). It is one of two kinds: `local`, on disk (both installs' default,
in a volume), or `s3`, as objects in one bucket of AWS S3 or another
S3-protocol server. Only the chosen kind's settings are read. Nothing
prunes the directory or the bucket yet.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| `TELFLO_FILE_STORE` | API | `.env` (add) | `api.fileStore.kind` (`local`) | `local` |
| `TELFLO_FILE_STORE_ROOT` | API | fixed, `/var/lib/telflo/file-store` (the volume `file-store`) | fixed (the claim `telflo-api-file-store`: `api.fileStore.storageClassName`, `size`) | required on `local` |
| `TELFLO_FILE_STORE_BUCKET` | API | `.env` (add) | `api.fileStore.bucket` | required on `s3` |
| `TELFLO_FILE_STORE_PREFIX` | API | `.env` (add) | `api.fileStore.prefix` | none |
| `TELFLO_FILE_STORE_S3_REGION` | API | `.env` (add) | `api.fileStore.region` | required on `s3` |
| `TELFLO_FILE_STORE_S3_ENDPOINT` | API | `.env` (add) | `api.fileStore.endpoint` | AWS's for the region |
| `TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE` | API | `.env` (add) | `api.fileStore.forcePathStyle` (`false`) | `false` |

- **`TELFLO_FILE_STORE`:** `local` or `s3`; anything else refuses to
  start.
- **`TELFLO_FILE_STORE_ROOT`:** an absolute path to a directory that
  exists and that the API can write; checked as the API starts (a
  relative path, or `~`, refuses).
- **`TELFLO_FILE_STORE_BUCKET`:** an S3 bucket name (3 to 63 lower-case
  letters, digits, dots and hyphens, a letter or digit at each end, no
  `..`).
- **`TELFLO_FILE_STORE_PREFIX`:** put before every object's name, so
  installs sharing a bucket keep apart. Segments of lower-case letters,
  digits and `._-` separated by `/`, each beginning with a letter or
  digit, at most 256 characters with its trailing `/` (`acme` and `acme/`
  are the same prefix).
- **`TELFLO_FILE_STORE_S3_REGION`:** 1 to 32 lower-case letters, digits
  and hyphens (`us-east-1`).
- **`TELFLO_FILE_STORE_S3_ENDPOINT`:** for a server other than AWS: a
  lower-case `http` or `https` scheme, a host (an internationalized one in
  its `xn--` form) or a bracketed IPv6 address, an optional port and an
  optional `/`, nothing else (no user name, password, path, query or
  fragment). Its refusal names the variable and the rule, never the
  value. Use `https` for any server off the machine: over plain `http` the
  files and the signed requests travel in clear.
- **`TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE`:** `true` or `false`: name
  the bucket in the URL's path rather than its host, as some S3-protocol
  servers need.

**None of these is a key.** On `s3` the AWS SDK finds its credentials
itself, by its default chain: a workload identity (the chart's
`api.serviceAccount.annotations`), or the standard `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` variables (Compose passes
them from `.env`). The API never reads, logs or shows them. The
credentials need `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on
`<bucket>/<prefix>*`, and `s3:ListBucket` on the bucket (without it S3
answers a missing file with 403, not 404). As it starts, the API writes an
empty probe in the bucket, asks for a name that doesn't exist (which must
answer "not found"), then removes the probe, and refuses to start unless
each step works. Keep the bucket's versioning off, or expire noncurrent
versions and delete markers: on a versioned bucket a remove only adds a
delete marker. Each request has 2 s to connect and 4 s to its reply's
headers (3 attempts), and those 4 s cover an upload's whole body, so a
10 MiB file needs about 2.5 MiB/s or more to the store.

**Switching kind on an install that already holds files needs them copied
first:** nothing moves them, and every one of them answers "not found"
until it is back.

## Installing collectors

A `server` fleet's install dialog gives a `docker run` command for
Telflo's collector image, or a Linux bundle (`.tar.gz`) rendered by the
API from install templates. A `kubernetes-supervisor` fleet's groups
install with Helm: a values file with the fleet's default token, and a
`helm upgrade --install` command for the supervisor-collector chart.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| [`TELFLO_COLLECTOR_IMAGE_REPOSITORY`](#telflo_collector_image_repository) | API | not passed | not set | `ghcr.io/telflo/telflo/collector` |
| [`TELFLO_HELM_CHART_REFERENCE`](#telflo_helm_chart_reference-and-telflo_helm_chart_version) | API | not passed | not set | `oci://ghcr.io/telflo/telflo/charts/supervisor-collector` |
| [`TELFLO_HELM_CHART_VERSION`](#telflo_helm_chart_reference-and-telflo_helm_chart_version) | API | not passed | not set | `0.1.0` |
| [`TELFLO_INSTALL_TEMPLATES_DIR`](#telflo_install_templates_dir) | API | not passed | not set | `/etc/telflo/install-templates` |

The agent endpoint the installs name is
[`TELFLO_OPAMP_AGENT_PUBLIC_URL`](#telflo_opamp_agent_public_url-and-opamp_server_url).

### `TELFLO_COLLECTOR_IMAGE_REPOSITORY`

The container install's image, tagged by the group's published version's
collector version (a mirror's in an air-gapped network); also a Helm
install's `image.repository`.

### `TELFLO_HELM_CHART_REFERENCE` and `TELFLO_HELM_CHART_VERSION`

The chart a Kubernetes group's `helm upgrade --install` names (a
mirror's in an air-gapped network): an `oci://` reference of lowercase
letters, digits and `._:/-`; and its exact version, `x.y.z` (no `v`, no
leading zero), 0.1.0 or later. The API refuses to start otherwise.

### `TELFLO_INSTALL_TEMPLATES_DIR`

An absolute path to a directory holding `linux/all-in-one/` and
`linux/own-binary/`, the Linux bundles' templates. The default is the API
image's copy of the repository's `install-templates/`. The API checks
both sets as it starts and refuses to start when either can't be read; it
reads them again on every download, so an edit applies at the next one.

The templates are trusted code that runs as root on every host installing
from them, so only the operator may write them, mounted read-only. The
Compose install and the chart use the image's copy and have no setting
for a directory of your own yet; a `compose.override.yaml` can mount one
read-only. In a Kubernetes pod spec of your own, either way below works;
never mount them with `subPath`, which never sees an update.

- **A directory on the node:** give the API's pod a read-only `hostPath`
  volume at the templates' path. The files must be readable by the API's
  user. An edit on the node applies at the next download.
- **ConfigMaps,** one per method (a ConfigMap's keys can't hold a `/`),
  each mounted at its method's directory under the templates' path, with
  `TELFLO_INSTALL_TEMPLATES_DIR` left at its default:

  ```sh
  kubectl create configmap telflo-install-all-in-one --from-file=install-templates/linux/all-in-one/
  kubectl create configmap telflo-install-own-binary --from-file=install-templates/linux/own-binary/
  ```

  ```yaml
  # The API's pod spec
  containers:
    - name: api
      volumeMounts:
        - name: install-all-in-one
          mountPath: /etc/telflo/install-templates/linux/all-in-one
          readOnly: true
        - name: install-own-binary
          mountPath: /etc/telflo/install-templates/linux/own-binary
          readOnly: true
  volumes:
    - name: install-all-in-one
      configMap:
        name: telflo-install-all-in-one
    - name: install-own-binary
      configMap:
        name: telflo-install-own-binary
  ```

  Kubelet swaps a ConfigMap's files a minute or two after a change; the
  API reads them again on every download, so a download never mixes two
  versions. A ConfigMap loses file modes: the bundle sets its own
  (`start_supervisor.sh` 0700, the rest 0644).

Installing again (after a new default token, say): on a container host,
remove the old container first (`docker rm -f telflo-collector`); keep
the `telflo-opamp` volume to keep the same collector, or remove it too
(`docker volume rm telflo-opamp`) to install a new collector into another
group or fleet.

## Quick-deploy links

On the Linux methods the install dialog's "Quick Deploy" makes a link that
downloads the bundle without signing in (24 hours, extended or revoked
under Install links on the fleet's Tokens tab), and one command that
downloads it, unpacks it and starts the collector. On a
Kubernetes-supervisor fleet, the Helm install's "Quick Deploy" makes a Helm
values link: its download is a `values.yaml` holding the fleet's default
token. The link is `{TELFLO_PUBLIC_API_URL}/api/v1/quick-deploy/{secret}`;
the secret is stored only as its hash, and the values typed for the
configuration's variables are stored with the link, encrypted. An
organization's admin turns both kinds off in Settings › Organization,
"Public install links".

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| `TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY` | API | `.env` (generated) | Secret `telflo-api`, `quick-deploy-encryption-key` | required |
| `TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS` | API | `.env` (add) | Secret `telflo-api`, `quick-deploy-previous-encryption-keys` | none |

The key is AES-256-GCM's: 32 bytes in standard base64 (44 characters
ending in one `=`), trimmed of white space, never logged (`openssl rand
-base64 32`). After a rotation, the earlier keys go in the previous list,
comma separated (at most 8, none repeated, not the current one), so links
they sealed still download; drop a key once no link it sealed should
download any more.

A load balancer or CDN in front of the gateway logs a link's path, secret
and all, unless it is told not to: the API's request log and the gateway's
access log cut it.

## Library links

A member asks for a link to one library file; for 24 hours the link
downloads the file without signing in. It is signed by the API with
HMAC-SHA256 and stored nowhere, so only deleting the file or retiring the
key ends one. The API answers the link's path only, and the web app puts
the browser's own origin in front of it: that relies on the web app and
the API sharing one origin, as they do behind the gateway.

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| `TELFLO_LIBRARY_LINK_SIGNING_KEY` | API | `.env` (generated) | Secret `telflo-api`, `library-link-signing-key` | required |
| `TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS` | API | `.env` (add) | Secret `telflo-api`, `library-link-signing-keys-previous` | none |

The key is at least 32 bytes of UTF-8 once trimmed of white space, never
logged (`openssl rand -base64 32`). The previous keys still check links:
comma separated, at most 8, each at least 32 bytes, none repeated, not
the current one. With several API processes, rotate in three steps: add
the new key to the previous list everywhere and restart; then move it to
`TELFLO_LIBRARY_LINK_SIGNING_KEY`, put the old one in the list and
restart; drop the old one 24 hours later, once its links have expired. A
leaked key is left out at once, which ends every link it signed once
every process has restarted.

## Analytics

| Setting | Read by | Compose | Helm chart | Default |
|---|---|---|---|---|
| `TELFLO_POSTHOG_KEY` | web | `.env` (add) | `web.posthog.key` | none |
| `TELFLO_POSTHOG_HOST` | web | `.env` (add) | `web.posthog.host` | PostHog's own |

A PostHog key turns on PostHog analytics and the cookie consent banner.
Unset, the default, nothing is loaded and no banner shows: leave it unset
for an install that sends nothing out. A host without a key is ignored.

## The secrets

Every secret is generated: by `setup.sh` into `.env` and `secrets/` for
Compose, or by `scripts/create-secrets.sh --init` into a secrets file for
the chart, whose sections are its Secrets. Each is hex of 32 random bytes
(URL-safe, so the Postgres passwords fit in database URLs), but the
quick-deploy key, base64 of exactly 32 bytes. Neither tool ever takes one
of the development stack's public values.

| Secret | Compose | Helm chart (Secret, key) |
|---|---|---|
| Postgres's superuser's password | `TELFLO_POSTGRES_PASSWORD` | `telflo-postgres`, `postgres-password` |
| The platform's owner's password (`telflo_platform_owner`) | `TELFLO_OWNER_PASSWORD` | `telflo-postgres`, `owner-password` |
| The API's role's password (`telflo_platform`) | `TELFLO_API_PASSWORD` | `telflo-postgres`, `api-password` |
| The opamp-server's owner's and runtime role's passwords | `TELFLO_OPAMP_OWNER_PASSWORD`, `TELFLO_OPAMP_RUNTIME_PASSWORD` | `telflo-opamp-server`, `owner-password`, `runtime-password` |
| The opamp-server's management secret | `TELFLO_OPAMP_MANAGEMENT_SECRET` | `telflo-opamp-server`, `management-secret` |
| The opamp-server's encryption key | `secrets/opamp-encryption-key` | `telflo-opamp-server`, `encryption-key` |
| The access tokens' secret | `TELFLO_ACCESS_TOKEN_SECRET` | `telflo-api`, `access-token-secret` |
| The quick-deploy key | `TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY` | `telflo-api`, `quick-deploy-encryption-key` |
| The library links' key | `TELFLO_LIBRARY_LINK_SIGNING_KEY` | `telflo-api`, `library-link-signing-key` |
| The validator's, tester's and evaluator's secrets | `TELFLO_OTELCOL_VALIDATOR_SECRET`, `TELFLO_OTELCOL_TESTING_SECRET`, `TELFLO_OTTL_EVALUATOR_SECRET` (the last two also in `secrets/`) | `telflo-internal-services`, `otelcol-validator-secret`, `otelcol-testing-secret`, `ottl-evaluator-secret` |

**Back up the opamp-server's encryption key above all**: it encrypts the
collectors' enrollment tokens, which can't be read again without it. The
chart's README has
[the secrets file's format and rotation](../charts/telflo/README.md#secrets).

## Administration

Commands an operator runs beside the API, with the API's settings and
database role: in Compose, `docker compose exec -T api telflo-admin
…`; in Kubernetes, `kubectl exec deploy/telflo-api -c api -- telflo-admin
…`. Each prints fixed lines and the address only, and a link only as its
output's last line, on standard output.

### `telflo-admin bootstrap`

```sh
telflo-admin bootstrap --email <email> --organization <name>
```

A site where nobody can register (the default, `invite-only`, or
`closed`) gets its first account, and its first product admin, from this
command. It makes the account (no password yet, the email unconfirmed,
its personal workspace as every account gets one), makes it a product
admin in the same transaction, creates the group organization named by
`--organization` with the account as its admin, and prints a link to set
the password, once, as the last line of its output, after the line "Open
this link within 60 minutes to set the password (it works once):". It
never sends email, so it works with or without mail. The link is the
password reset's: it works once, for 60 minutes, and setting the password
also confirms the email. The first sign-in lands in the organization the
command created.

The link is a secret, a way into the first product admin's account until
it is used: open it yourself or hand it to that person privately, and run
the command only in a terminal of your own, never where output is kept (a
CI job's log, a shared recording). `docker compose exec` and `kubectl
exec` return the output to you alone; it never reaches the container's
logs.

It works once: while any product admin exists (deleted or not) it is
refused with "A product admin already exists: nothing was changed.", and
from then on product admins grant the role on their Product admins page.
It also refuses an address an account already has, live or deleted. Exit
codes: `0` done; `1` refused, the address taken, or the organization or
the link failing after the account was made (the account and the role
stay: create the organization after signing in, make a link with
`telflo-admin reset-link`); `2` a usage error.

**Run it promptly after an install.** The API's own database role may
make the first product admin, so while none exists anything that can run
SQL as `telflo_platform` could make any live person the first product admin.
Once one exists, that path is closed for good.

With Google sign-in on: a Google sign-in with the same address before the
password is set takes the account over and keeps the role; and under
`invite-only` a new invitee's "Sign in with Google" on the invitation's
page is refused like any Google sign-in with no account: they register
there with a password instead.

### `telflo-admin reset-link`

```sh
telflo-admin reset-link --email <email>
```

A lost or expired link, or any person who can't reset their password
without mail: it prints the same fixed line and then a fresh password
reset link, as its last line (once, within 60 minutes, confirming the
email), and any earlier link for that account stops working. It sends no
email and works whatever the registration mode or the mail settings, for
any person's account (anyone who can run commands in the API's container
can already reach the database as the API's role). An address with no
live person's account (unknown, deleted, or a service account's) is
refused with "No live account has that email address: nothing was
changed." and nothing is written. The same rules as the bootstrap's link
hold: a secret, for your own terminal only. Exit codes: `0` done, `1`
refused, `2` a usage error (`--email` is its only option, once).

### Product admins

A product admin sees "Product Admin" in the sidebar: User Feedback, Test
Templates, Test Regex, Library, Flows, Users and Product admins. Product
admins grant and remove the role on the Product admins page, by the exact
email of a verified account; the last one can't be removed. An operator
can also set or clear it by SQL, as the tables' owner (the role in
`TELFLO_MIGRATION_DATABASE_URL`, `telflo_platform_owner`): a trigger refuses the change
from any other role, the API's included.

```sql
update users set is_product_admin = true
where lower(email) = lower('ben@example.com') and deleted_at is null;
```

`false` in place of `true` revokes it. The API reads the flag on every
request, so either change applies at the person's next request.

The product admins' pages that read across organizations (Users, Product
admins, User Feedback) go through database functions that check the
caller is a live product admin, and each read and write is audited by ids
and counts, never an email, a search's term or a feedback's text. The
Users page lists every live account, searched by email or by an
organization's name. Its one action, Delete, is refused for yourself and
blocked, with the reason, for a member of an organization someone else is
in, for the owner of a personal workspace that has another member or a
pending invitation, and for a product admin (remove their role first).
Any signed-in person writes to the product admins from "Contact us" in
the sidebar; each product admin is emailed a notice naming the sender,
never the text, and answers or dismisses it on the User Feedback page.

### Deleted accounts

The Users page deletes an account for good: its address becomes
`deleted-<24 hex>@deleted-accounts.telflo.invalid`, so the original
address can register again. The original address remains only in the
deletion record, the audit log and invitations sent to it by
organizations that weren't deleted with the account. Only an operator's
SQL reads the deletion record, as the tables' owner:

```sql
select user_id, original_email, deleted_by_user_id, deleted_at
from user_deletion_records order by deleted_at desc;
```
