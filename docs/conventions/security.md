# Security conventions

## Token design

| | Access token | Refresh token |
|---|---|---|
| Format | JWT (`sub`, `organization_id`, `sid`, `exp`, `iat`, `iss`, `aud`, `jti`) | Opaque random string, **not** a JWT |
| Lifetime | 10–15 minutes | 30 days |
| Storage | — | Hashed at rest, treated as a password |
| Rotation | — | Rotates on every use |

**Reuse detection:** presenting an already-consumed refresh token revokes
the entire session family, once the 10-second grace window for concurrent
refreshes has passed.

**Transport:** both tokens are `HttpOnly; Secure; SameSite` cookies. No
token is reachable from JavaScript, which is the largest available XSS
mitigation, and SSR authentication becomes trivial. CSRF is handled by
`SameSite=Lax` plus a required custom header.

**Organization switching** is an explicit token exchange:

```
POST /auth/switch-organization { organizationId }
  → verify membership                            (else 403)
  → update sessions set active_organization_id   (authoritative)
  → issue a new access token carrying the new organization_id
  → write an audit event
```

The session row is the source of truth; the access token carries a
short-lived cached copy. Without this, a token refresh would silently
revert to the previous organization. Because the access token names the
organization, audit logs can record which organization each request acted
as — and because the session row is authoritative, no shared session store
is required, keeping Redis out of the on-prem bundle.

**In the API** it is `PUT /api/v1/auth/sessions/current/organization` (no
verbs in paths). The switch locks the session, then the target organization
and membership, and writes `session.organization_switched`. A live session
whose token names another organization, for the same user, gets
`access_token_expired`, so another tab refreshes into the session's current
organization instead of signing out. Removing a member, or deleting an
organization, moves the sessions active in it to the user's personal
organization, else their first other organization by name, else revokes
them.

**Where a new sign-in lands:** a password or a provider's sign-in starts its
session in the active organization of the person's most recently used
earlier session (the latest `last_refreshed_at`, which a session's creation
sets and each refresh advances; revoked and expired sessions count), while
the organization is live and the person a live member of it; otherwise in
the live organization they joined most recently (their newest live
membership's `created_at`); otherwise in their personal organization, which
sign-in still reads first and whose absence still fails it (500,
`no_personal_organization`). The choice is made inside the session's
transaction (`startSession`'s `landing`), in the person's own database
context (row-level security shows them only their memberships; the sessions
read is filtered by their id), and a candidate is taken only under the
switch's locks: the organization `for share`, then the membership
`for share`, both candidates in id order, all before the check's lock on the
user (organization -> user -> session). A removal or a delete committed
first is passed over; one that starts later waits and then reassigns the new
session as any other. An invitation's registration or sign-in-and-join still
names its organization. Service accounts never sign in (their address isn't
found, and `sessions_human_only` refuses their sessions).

Revocation falls out for free: logout revokes the session row, "sign out
everywhere" revokes all rows for a user, and both take effect immediately
because every request already checks session liveness. The person can also
sign out one other session of theirs
(`DELETE /api/v1/auth/sessions/{sessionId}`, revoked as
`signed_out_elsewhere`), with the same immediate effect ("Account settings",
below). A completed password reset revokes every session the user has, with
the same immediate effect. A password changed from Settings keeps them all.

Machine tokens for the public API (`tf_`) are a separate path: long-lived,
hashed, organization-scoped at issue, no refresh cycle. They are a service
account's tokens, checked on `/api/public/v1/` ("Service accounts and API
tokens", below).

Role is deliberately **not** carried in the token: if it were, demoting an
administrator would not take effect until the token expired. Since the
membership check already runs per request, it returns the role for free, so
role changes and revocations are immediate.

## Federated identity and account linking policy

Google sign-in is built as **generic OIDC, not as Google**, via an
`oidc_provider` abstraction implemented with `openid-client`
(authorization-code flow with PKCE, state and nonce). A `user_identities`
table holds `{ user_id, provider, provider_subject, email, linked_at }`,
unique on `(provider, provider_subject)`.

**Account linking policy.** When a federated sign-in matches the email of an
existing password account, link automatically **only when the provider
reports `email_verified` AND the existing account's email is already
verified**. Otherwise require explicit linking while signed in.

**Narrower still:** a sign-in links to, takes over or creates an account
only when the provider is *authoritative* for the email (for Google,
`@gmail.com`, `@googlemail.com` or a Workspace `hd` claim, and only from
Google's own issuer), since `email_verified` for other addresses only says
the address was verified once. An existing account whose email isn't
verified is taken over: confirmed, its password deleted, its links, sessions
and terms acceptance cleared. Providers come from settings
(`TELFLO_OIDC_GOOGLE_*`); none configured is the on-prem flag. The flow's
state, nonce and PKCE verifier travel in a signed, ten-minute cookie,
`__Secure-telflo_oidc` (`telflo_oidc` when cookies aren't `Secure`), and the
ID token's signature is checked against the provider's keys.

**Explicit linking while signed in** happens from Settings › Account's
Sign-in methods card: by `sub`, after the current password when the account
has one, without the authority rule ("Account settings", below).

This closes account pre-hijacking: an attacker registers
`victim@example.com`, the real owner later signs in with Google, and naive
auto-linking would merge the accounts leaving the attacker with access.
Telflo already requires email verification before an account is usable, so
an unverified account cannot exist in a usable state — the safe policy costs
nothing on the happy path. **This invariant must not be relaxed without
revisiting this policy.**

Federated sign-in is unavailable in air-gapped deployments — it requires
egress to the provider and a registered OAuth client. Like billing, it is
present in the codebase and feature-flagged off for on-prem builds.

## Authorization model

Most large multi-tenant products (GitLab, GitHub, Shopify, Stripe,
Atlassian) authorize in the application layer. RLS is disproportionately
common in exactly one situation — when the database is directly exposed to
untrusted clients, which is the architecture of backend-as-a-service
platforms and the reason it exists there. A trusted API server removes that condition.

No compliance framework (HIPAA, PCI-DSS, SOC 2, FedRAMP) requires RLS. They
require demonstrable access control, least privilege and auditability. RLS
is one way to evidence isolation; automated cross-tenant tests are another.
Note also that RLS does not constrain a superuser, so it offers little
against an on-prem customer's own DBAs — audit logging and encryption do.

Isolation is therefore made **structural** rather than a matter of
developer discipline:

1. **One `AuthContext`** per request — `{ userId, organizationId, role, sessionId }`
   — built once from the token, never assembled ad hoc.
2. **Repositories constructed *from* an AuthContext**, with org scoping
   injected by the base query builder. No method can return unscoped rows.
3. **A generated cross-tenant test suite** — for every resource,
   organization B can neither read nor write organization A's row.
   Generated from a resource registry so a new resource cannot silently
   skip its isolation test.
4. **RLS on high-value tables only** — configurations, organization
   membership, tokens, deployments — as a database-level backstop.
5. **Append-only audit logging**, built in rather than retrofitted.

**How it holds.** The API connects as a login role in
`telflo_platform_runtime`, never the owner or a superuser, and refuses to
start otherwise; migrations connect as the owner.
`apps/api/src/database/context.ts` alone sets `telflo.user_id` and
`telflo.organization_id`, per transaction (`set_config(…, true)`), and
policies read them with `nullif(…, '')::uuid`. `AuthContext` is built once
per request by `authenticate`. Organization-scoped repositories take their
queries from `createOrganizationScope`, and the resource registry generates
the cross-tenant suite. `organization_members` has the first policy: a user
sees their own memberships and those of the organization they act in.
Functions that must see past a policy are `SECURITY DEFINER`; the two the
API calls refuse any organization but the context's.

**Invitations.** `organization_invitations` has the same policy shape. An
invitee doesn't belong to the organization yet, so one definer function,
`organization_invitation_by_token_hash`, finds an invitation by the sha-256
of its link's token: an exact match on a 256-bit random secret, read-only.
After that the service sets the context to the invitation's organization and
goes through the scoped repository as usual, comparing the hash again under
the lock. The token travels in the link's fragment and in request bodies,
never in a URL a server sees. The API's logger drops `detail` and `where`
from every logged error, since a constraint violation on a table without
row-level security prints the failing row.

**Quick-deploy links.** `quick_deploy_links` has the same policy shape, and
the second definer function keyed by a secret,
`quick_deploy_link_by_secret_hash`: whoever holds a quick-deploy link
downloads without signing in, so the link's secret (`tqd_` and 32 random
bytes in base64url) finds its row by its sha-256, an exact match, before any
context can be set. It answers only the link's id, its organization and
whether that organization is live, is executable by
`telflo_platform_runtime` alone, and has one caller
(`findQuickDeployLinkBySecretHash`); the route then sets the context to the
link's organization with no person (`withOrganizationContext`, called only
from `modules/quick-deploy/routes.ts`, pinned by a source-scan test) and
reads through the policies. Unlike an invitation's token, this secret is in
a URL's path: see "Quick-deploy links" below for what cuts it from the logs.
A library link is the other secret in a URL's path, and needs no such
function: it is signed by the API, not stored, and names a global file (see
"Library links" below).

**Configurations.** `configurations` has the same policy shape. A
configuration write locks its organization `for share` and re-reads the
caller's membership, so a member removed mid-request can't write after their
removal. Every data endpoint runs `requireCurrentTerms` after
`authenticate`: a user who hasn't accepted the current terms gets 403
`terms_acceptance_required`. Endpoints about the user's own session and
terms, and organization management, stay open. The list's search text stays
out of what the platform records: the API's request log drops the list's
query, `q` included, and session replay's recorded requests to `/api/` lose
their whole query; the gateway's access log still records it.

**Versions.** `configuration_versions` has the same policy shape, and its
composite foreign key to `configurations (id, organization_id)` keeps a
version in its configuration's organization. A save takes a configuration
write's locks, then locks the configuration `for update`. A configuration's
YAML can hold secrets, so it is stored only in
`configuration_versions.yaml_content`, and as copies of each component's
config in the same row's `nodes` column (nothing reads them back). Neither
is ever written to:
- **logs:** the API's request log carries no bodies, and the save's path
  holds only ids;
- **audit rows:** `configuration.version_saved` records only `versionId`
  and `versionNumber`;
- **analytics:** the editor captures no events, and autocapture sends no
  text or attributes;
- **DOM attributes:** no attribute the editor renders carries the YAML, nor
  a component's label, an instance name, a pipeline's name or a config
  value. The builder's ids are opaque (`node_<n>`, `group_<n>`,
  `pipeline_<n>`, `edge_<n>`), and the save's contract refuses any other
  form, because React Flow writes ids into `data-id`, `data-testid` and
  `aria-label`;
- **caches:** the responses that carry it, the configuration's read, the
  save's answer, a version's read and the create's answer, say
  `cache-control: no-store`, so neither the browser nor a proxy keeps a
  copy;
- **refusals:** a refused save answers with the error envelope alone, never
  the YAML or a piece of it.

Session replay masks it: the signed-in app's root and `<body>` carry
`ph-mask`, and replay runs with `maskAllInputs`.

**Body limits.** The API's default is 1 MiB (`bodyLimit` in
`telflo-core/apps/api/src/server.ts`), and the gateway's
(`client_max_body_size 1m` in `docker/gateway/default.conf`) matches it. A
route that carries a configuration's text sets its own `bodyLimit`, and
the gateway gives its path a location of its own, so a body too large is
refused at the edge rather than streamed in to be refused (413
`payload_too_large`, nothing written):
- **5 MiB:** a version's save (`PATCH …/versions/:versionId`) and create
  (`POST …/versions`): JSON escaping can more than double 256 Ki characters
  of YAML, and the builder's graph adds three columns of at most 1 MiB of
  JSON each. So is a configuration's create
  (`POST /api/v1/organizations/:organizationId/configurations`), which may
  carry a flow's text and graph as version 1. The gateway's locations
  `^/api/v1/organizations/[^/]+/configurations/[^/]+/versions(/[^/]+)?$` and
  `^/api/v1/organizations/[^/]+/configurations$`, `5m`.
- **2 MiB:** a version's validation
  (`POST …/versions/:versionId/validation`), the YAML alone. The gateway's
  location
  `^/api/v1/organizations/[^/]+/configurations/[^/]+/versions/[^/]+/validation$`,
  `2m`.
- **4 MiB:** a flow's create and change (`POST /api/v1/flows`,
  `PATCH /api/v1/flows/:id`): the YAML and the description, 262,144
  characters each, up to 1.5 MiB each once JSON escapes them. The gateway's
  location `^/api/v1/flows(/[^/]+)?$`, `4m`. The flows' security check
  (`POST /api/v1/flows/lint`) falls in that location too, but its route
  allows 2 MiB (the YAML alone), so the API refuses a body between the two.
- **1 MiB:** every other path.

Each of these routes runs `authenticate` in `onRequest`, before Fastify
reads the body, so a signed-out caller is refused (401) before the body is
parsed ("Large bodies before authentication", below).

**Version selections.** `configuration_version_selections` has the same
policy shape, and two composite foreign keys: one to
`configurations (id, organization_id)`, and one to
`configuration_versions (id, configuration_id, organization_id)`, so a
selection can only name a version of its own configuration. Creating a
version is a save of new content: it carries the YAML on the same terms, and
its route and the gateway allow the same 5 MiB.
- **Version labels are private text,** as configuration names are. The
  editor shows them only as text: never in an attribute (`title`,
  `aria-label`, an option's value), a URL, a log or an analytics event. The
  address and the picker's values hold only opaque ids, and so does the
  selection's request. An audit row carries a label only as a rename's
  `from` and `to` (`configuration.version_renamed`);
  `configuration.version_created` records ids and the number. The creator's
  email in the picker's rows follows the same rule.
- **A person's version selection is never shown to anyone else.** The
  repository reads and writes it by person; the policy limits it only to
  the organization. No endpoint reads another person's, and recording one
  is not audited.

**Drafts and published versions** (migrations 020, 021 and 022).
- **Drafts are private to their author.** A member sees their own drafts and
  every published configuration (one with a published version), and every
  version and selection of a configuration they can see; another member's
  draft answers `404 configuration_not_found`, as for one that doesn't
  exist. Two layers hold it, each tested on its own: the configuration and
  version repositories take the viewer (`{ organizationId, userId }`) and
  filter by it, and migration 021's policies on `configurations`,
  `configuration_versions` and `configuration_version_selections` admit the
  same rows in raw SQL as the application role. The insert policy admits
  only a configuration created by the context's user, so sign-up sets the
  full context before the starter configuration.
- **The definer helper is the one way a policy looks across the two
  tables.** A `configurations` policy reading `configuration_versions`,
  whose policies read `configurations`, recursed. So the configurations
  policies call
  `configuration_is_published(configuration_id, organization_id)`, a
  `SECURITY DEFINER` function that reads the versions as the tables' owner,
  past their policy; the versions' and selections' policies look into
  `configurations` directly. The helper carries the other definer functions'
  backstop: `false` for any organization but the context's, one boolean out,
  a fixed `search_path` and a schema-qualified table, `EXECUTE` for
  `telflo_platform_runtime` only. It holds only while neither table is
  `FORCE`d.
- **A published version is immutable**, in the database as well as the API.
  A before-update trigger refuses any change to its content, its label, its
  publish columns (`published_by_user_id` may only become null, for its
  cascade) and its identity, for every role on a plain `UPDATE`, the tables'
  owner included. It guards updates only, so the application role deletes no
  configuration and no version at all (migration 022's delete policies are
  `using (false)`) and inserts only versions with the publish columns null:
  it can't remove a published version, directly or by its configuration's
  cascade, nor insert it again with other content. Deleting a configuration
  sets `deleted_at`, and who may (its author or an organization admin,
  `403 configuration_delete_forbidden` otherwise) is the API's rule, by
  design: the database refuses every hard delete of a configuration or a
  version by the API's role, and keeps the author. A second trigger keeps a
  configuration's author: `created_by_user_id` may only become null (the
  users cascade), so a member can't make themselves the author that rule
  reads. What still bypasses them is operator-level: the owner's
  `ALTER TABLE … DISABLE TRIGGER`, a superuser's
  `session_replication_role = replica`, and a hard delete of an organization
  or an account, which cascades. The API's role can do neither of the first
  two, and no code of the API's hard-deletes an organization or an account.
  The API answers `409 configuration_version_published` before the trigger.
- **A publish never takes a save its tab didn't see.** The editor sends the
  version's `updatedAt` as it last loaded or saved it (`expectedUpdatedAt`);
  the publish's check compares it to the millisecond and refuses a version
  saved since with `409 configuration_version_changed`, before any call to
  the opamp-server, and the editor reloads the version. A save between the
  check and the record is refused by the record itself, which guards the
  YAML and the label the opamp-server took. A caller with no tab (the public
  API) leaves it out and publishes what is saved.
- **Only the publish's record writes the publish columns.** The policies let
  the API's role update a draft it can see, so a stray write of
  `published_at`, `publication_id` or `published_by_user_id` could publish
  text no snapshot holds. One statement in the version repository writes
  them, `recordPublish`, for a draft still holding the YAML the opamp-server
  took, and a source-scanning test (`publish-columns-source.test.ts`) fails
  on a write of them anywhere else in the API's code. It sees direct writes
  only, not one through a column-name constant: the same limit as
  `context-source.test.ts`'s.
- **Publishing's privacy.** The snapshot's YAML and the management secret
  are never logged; `configuration.version_published` records ids and the
  version's number only; the dialog, banner and toasts name only the version
  number.

**The collector catalog** (migrations 023 and 024).
- **The collector catalog's tables are global.** `collector_distributions`
  and `collector_versions` belong to no organization: no organization
  column, no row-level security, and every organization reads the same rows.
  Migration 009's default privileges would give `telflo_platform_runtime`
  `SELECT`, `INSERT`, `UPDATE` and `DELETE` on a new table, so 023 revokes
  the last three: the API's role holds exactly `SELECT` on both, and a test
  checks it. The resource registry declares them `kind: "global"`, so the
  cross-tenant suite knows they are global on purpose.
- **Only the migration step writes them.** Its sync reads
  `catalog/distributions/*.json`, refuses the whole catalog if any file
  fails the validator (download URLs only under upstream's
  `open-telemetry/opentelemetry-collector-releases/releases/download/`,
  naming their own version and platform; sha256 64 lowercase hex; no
  unknown key), then writes as the tables' owner, in one transaction under
  an advisory lock, with parameters (never SQL built from the file). It
  never deletes: a row the files no longer list rolls the sync back. The
  API process never reads the files (a source-scanning test fails on an
  API source naming `catalog/`), only the tables. The catalog endpoint
  (`GET /api/v1/collector-distributions`) needs a session but not the
  current terms, since it holds no one's data, and leaves out the
  binaries and images.
- **A configuration keeps its distribution.** A before-update trigger,
  `configurations_collector_distribution_unchanged`, refuses any change of
  `configurations.collector_distribution`, for every role on a plain
  `UPDATE`, the tables' owner included (P0001; a same-value write passes),
  as migration 022's author trigger does. Two composite foreign keys keep a
  version's pin honest: `(configuration_id, collector_distribution)` →
  `configurations (id, collector_distribution)` keeps it the
  configuration's own distribution, and `(collector_distribution,
  collector_version)` → `collector_versions` keeps it a catalog version
  (23503 otherwise, for the owner too). Migration 024 indexes the first
  key's lookups.
- **A published version's collector version is immutable**, like its
  content: 023 replaces migration 020's guard so the same trigger refuses a
  change to `collector_distribution` or `collector_version` on a published
  version, and the API answers `409 configuration_version_published` first.
  The publish's record also re-checks the pin the opamp-server took, beside
  the YAML and the label, so a save that changes it between the put and the
  record is refused. The same operator-level bypasses as above apply.
- **The database accepts a deprecated version; the API is the gate.** A save
  or a version's create may name a new pin only among the distribution's
  non-deprecated versions (`400 collector_version_unknown`), and a
  configuration's create only an offered distribution
  (`400 collector_distribution_unknown`); a pin already on a version is kept
  even once its version is deprecated.
- **Nothing private in the catalog UI's attributes:** the list's
  distribution tag's tooltip is fixed text carrying the catalog's label of
  the distribution, and the pickers' values, labels and the deprecated pin's
  tooltip are the catalog's own text, which is the same for everyone.

**Product admins and flows** (migration 026).
- **Product admin is a flag only the tables' owner sets.**
  `users.is_product_admin` (false by default) is set and cleared by an
  operator's SQL, run as the tables' owner (the role in
  `TELFLO_MIGRATION_DATABASE_URL`; README). *(The first one is made by
  `telflo-admin bootstrap` through a definer function the API's role may
  call while no product admin exists: "The first product admin" below.)* A
  before-insert-or-update trigger, `users_product_admin_owner_only`, refuses
  an insert with the flag true and an update that changes it unless
  `current_user` is a member of the `users` table's owner (SQLSTATE 42501, a
  message naming only the user's id). It is not `SECURITY DEFINER`, since it
  must see the role that runs the write, and pins its `search_path`. The
  API's role can't grant or revoke the flag, nor disable, drop or replace
  the trigger; every write the API makes to `users` (none names the flag)
  still works. An insert setting the flag to null is refused by `NOT NULL`
  (23502), not the trigger. **A later `BEFORE` trigger on `users` must not
  change the flag:** this one runs before it only by the alphabetical order
  of the triggers' names. The bypasses are operator-level, as for published
  versions.
- **The flag is read live.** The session check's one query
  (`findLiveWithUser`) reads it on every request, so a revocation takes
  effect on the user's next request; no token carries it. `requireProductAdmin`
  answers `403 product_admin_required` without it, whatever the person's
  organization role, and `/product-admin` checks it on the server before
  anything renders.
- **`flows` is global:** no organization column, no row-level security,
  declared `kind: "global"` in the resource registry. The API's role holds
  `SELECT`, `INSERT`, `UPDATE` and `DELETE` on it (migration 009's default
  privileges), so who may write is the API's rule: every write (`POST`,
  `PATCH`, `DELETE /api/v1/flows…`) and the security check
  (`POST /api/v1/flows/lint`) require the flag. Each write is audit-logged
  (`flow.created`, `flow.updated`, `flow.deleted`), naming the slug and the
  changed fields, never the YAML. A hidden flow and an unknown slug answer
  the same 404 to anyone without the flag.
- **`test_templates` and `test_regex` are global too**, as `flows`: no
  organization column, no row-level security, `kind: "global"` in the
  resource registry, the API's role holding the same four privileges
  (migration 009's default privileges). A signed-in person with the current
  terms reads them (a product admin without them too, for the admin pages);
  every write requires the flag (`requireProductAdmin`, 403
  `product_admin_required`) and is audit-logged in no organization, ids and
  changed fields' names only (`test_template.created`, `.updated`,
  `.deleted`; `test_regex.created`, `.updated`, `.deleted`). A library
  entry's regex is checked by the OTTL evaluator's RE2 before it is saved,
  each check counted on the admin's own 30 a minute; its name, category,
  description and regex reach no log line or audit row.
- **A flow's text is public, the admin's input isn't.** A published flow's
  YAML is public content, but the admin dialog's YAML textarea and the
  security check's findings are treated as configuration text (an admin may
  paste a secret, which is what the check looks for): they sit inside
  `ph-no-capture`, and nothing from them reaches an attribute, a log line or
  the audit row. A write refused by validation answers 400 `invalid_request`
  whose `details` (Zod's issues) never hold the YAML or the description;
  they may echo an enum's received value (`signals`) and an unknown field's
  name, by design of the error handler.
- **`configurations.source_flow_slug`** records the flow a configuration
  was created from; it has no foreign key (a flow may be deleted) and no
  response returns it.

**Product administration** (migrations 041 and 042). Paths are under
`telflo-core/`. The platform's **cross-organization path**: Users, Product
admins and User Feedback list people from every organization, so every such
read and write goes through one database context, one set of database
functions and one repository, and each call is audited.
- **The context.** `withProductAdminContext(db, actor, work)`
  (`apps/api/src/database/context.ts`) opens a READ COMMITTED transaction
  with `telflo.product_admin = 'on'`, `telflo.user_id` the caller and
  `telflo.organization_id` empty: row-level security shows it no
  organization's rows, so it reaches people and feedback only through the
  functions below. `context-source.test.ts` pins it: `telflo.product_admin`
  is named only in `context.ts` and migrations; `withProductAdminContext`
  is called only from `modules/product-admin/repositories/system-repository.ts`;
  `assert_product_admin` and the `product_admin_…` functions are named only
  there and in migrations; and `is_product_admin` only in an exact list of
  six production files (the session check's two, the contract and schema
  types, the SystemRepository and feedback's recipients' query).
- **The gate in the database** (`packages/db/migrations/1700000000041_product_administration.js`).
  `assert_product_admin()` raises 42501, with the hint
  `telflo_product_admin_gate`, unless `telflo.product_admin` is `on`,
  `telflo.organization_id` is empty, `telflo.dispatcher` isn't `on`, and
  `telflo.user_id` names a live human whose flag is true, read in that
  statement; `EXECUTE` on it is held by no one (migration 028's
  `test_runs_require_dispatcher` pattern). Each product-admin function
  (`product_admin_list_users`, `_list_product_admins`, `_grant`, `_revoke`,
  `_list_feedback`, `_count_pending_feedback`, `_handle_feedback`, and
  migration 042's `_delete_account`) is `SECURITY DEFINER`, owned by the
  migration role, `search_path = pg_catalog, platform` with schema-qualified
  tables, `EXECUTE` revoked from `public` and granted to
  `telflo_platform_runtime` only, and begins with `perform
  platform.assert_product_admin()`. A route's `requireProductAdmin` and this
  gate are independent: a bug in either alone is refused by the other. Only
  the gate's own 42501 (by its hint) is answered `403
  product_admin_required`; any other 42501 stays a server error.
- **The caller re-read under a lock.** `assert` reads the flag without a
  lock, so every function that writes re-reads the caller under a row lock
  (`for share` or stronger), taken with or after its other locks, users
  always in id order, and answers `forbidden` (`403
  product_admin_required`) when the caller is no longer a live product
  admin: a removal committed while the write waited wins.
- **The product-admin flag's trigger still holds.** The functions run as the
  tables' owner, so `users_product_admin_owner_only` lets the grant and the
  removal change the flag; the API's role still can't. The grant takes a
  live, verified human (never a service account) by `lower(email)`, locks
  {caller, target} by id and re-reads both; the removal locks every live
  product admin's row (`for update`, by id) and refuses the last one
  (`409 last_product_admin`): two admins removing each other leave one.
- **The two tables are `system` resources** (no organization, no row-level
  security; `apps/api/src/tenancy/resource-registry.ts`). Migration 009's
  default privileges are revoked explicitly: the API's role holds only
  `INSERT` on `user_feedback` (the sender's request writes it, with an id
  from `select uuidv7()` and no `RETURNING`) and nothing on
  `user_deletion_records`, which only the delete function writes and only
  an operator's SQL reads (README). The cross-tenant suite checks both have
  no row-level security and that the API's role can't `select` either
  (42501).
- **The SystemRepository**
  (`modules/product-admin/repositories/system-repository.ts`) is the only
  caller of the functions, one method per operation, each writing its audit
  row in the same transaction, in no organization, the actor's columns as
  usual and `metadata` holding ids, counts and fixed values only:
  `product_admin.users_listed` `{count, searched}` (a search's term is never
  stored), `product_admin.product_admins_listed` and
  `product_admin.feedback_listed` `{count}` (the rows returned),
  `product_admin.granted`, `product_admin.grant_unchanged`,
  `product_admin.revoked` `{self}`, `feedback.acknowledged`,
  `feedback.dismissed`, `user.deleted`
  `{deletedOrganizations, deletedServiceAccounts, revokedSessions}` with an
  `organization.deleted`
  `{reason: "account_deleted", deletedServiceAccounts}` in each organization
  the delete removes, and `product_admin.refused` `{operation, outcome}` for
  a write's refusal (never an email). A refusal by the gate itself rolls the
  transaction back and writes nothing. **Two named exceptions:** the pending
  count (a number, through its gated function, unaudited) and feedback's
  recipients, a plain query on `users` in the sender's own request
  (`modules/feedback/repositories/feedback-repository.ts`,
  `listFeedbackRecipients`, pinned by the scanning test), whose emails go
  only to the mailer.
- **A person's delete** (`product_admin_delete_account`, migration 042) is
  one transaction under locks taken in the order every existing path takes
  them: the person's live organizations by id (`for no key update`), then
  the person's row (`for update`) and the caller's (`for share`) together by
  id, then the membership set re-read under the locks (changed: a
  savepoint's rollback releases the locks and the attempt restarts from the
  organizations, at most three times, then `409 user_delete_busy`), then
  their service accounts' users. It refuses `not_found`, `self`,
  `forbidden`, and a block (the flag, or an organization not theirs alone:
  `409 user_delete_blocked` with `details: {kind}` only), re-read under the
  locks. Otherwise it deletes each organization the person has alone (its
  service accounts as Settings › Service Accounts deletes one, their tokens
  revoked; every live session acting in it revoked), revokes the person's
  sessions (`account_deleted`) and personal tokens, deletes their
  identities, settings and reset and verification tokens, writes the
  deletion record, and sets the email to
  `deleted-<24 hex>@deleted-accounts.telflo.invalid`, no password,
  `deleted_at`. After the commit the service tells the opamp-server and
  removes each logo (`modules/product-admin/users-service.ts`). The
  anonymization goes further: the deleted personal organization takes the
  anonymous address's workspace name, the invitations to the original
  address in the organizations deleted with the person take the anonymous
  address, and every session of the person's loses its IP address and user
  agent. The original address then remains only in
  `user_deletion_records.original_email` (the person's row), the audit log
  as a whole (append-only: any `audit_events` row may hold it —
  `actor_email`, and `metadata` derived from it, such as
  `organization_invitation.created`'s and `sales_inquiry.received`'s address
  or `organization.renamed`'s former name of a personal organization) and
  `organization_invitations.email` in organizations not deleted with the
  person; the person's own audit rows keep their IP addresses and user
  agents (append-only).
- **The reserved domain.** Registration, inviting, registering from an
  invitation and Google sign-in refuse `@deleted-accounts.telflo.invalid`
  as they refuse the service-account domain (`email_reserved`;
  `isReservedEmail` in `packages/contracts/src/service-accounts.ts`), so an
  anonymous address can never be registered (it answered 500 before).
- **Limits** (`apps/api/src/http/rate-limits.ts`): 30 writes a minute per
  product admin (grant, remove, acknowledge, dismiss), 10 deletes a minute,
  10 feedback messages an hour per person, each counted after validation
  and the guards.
- **Other people's personal data** on these pages: "Product
  administration: other people's personal data" below.

Three repository base classes make intent visible in review:

| Base | Scoping | Used for |
|---|---|---|
| `OrgScopedRepository` | `organization_id = ctx.organizationId`, not bypassable | The default |
| `GlobalRepository` | None | Genuinely global data (`users`, collector version catalog) |
| `SystemRepository` | None, **audit-logged on every call** | Product-admin cross-organization operations: `apps/api/src/modules/product-admin/repositories/system-repository.ts`, the only caller of the product-admin context and functions (above) |

The test generator enumerates all three, so a table must be *declared*
global or system rather than merely omitted. `user_feedback` and
`user_deletion_records` are `system` entries.

### Org scoping is a column predicate, never a join

Membership validation happens **once per request**, at AuthContext
construction — a single indexed query that simultaneously confirms the
session is live, the membership is valid, and returns the current role. Row
scoping is then `where organization_id = $1` with no join, because every
organization-owned table carries `organization_id` as a real column, backed
by a composite foreign key against its parent so drift is structurally
impossible. The RLS backstop becomes a single column compared to a session
variable, which is essentially free and index-friendly:

```sql
using (organization_id = current_setting('telflo.organization_id', true)::uuid)
```

In practice the setting is read with
`nullif(current_setting('telflo.organization_id', true), '')::uuid`: after a
transaction ends, a setting made by `set_config(…, true)` is `''`, and
`''::uuid` raises.

## The opamp-server's boundary

The opamp-server has its own repository, `github.com/telflo/opamp-server`,
whose `README.md` gives the self-hoster's view, with the rotation procedures
step by step. The platform runs its published image, pinned; pulling it is
under "Publishing the chart and the image" below.

### The management secret

The platform reaches the opamp-server only through its management API, which
takes one **shared secret**: `Authorization: Bearer <secret>`, checked
against `OPAMP_MANAGEMENT_SECRET` (at least 32 bytes) on the opamp-server's
side and sent from `TELFLO_OPAMP_MANAGEMENT_SECRET` on the platform's. It
was chosen over signed short-lived tokens, and the trade is this: **the
secret is one string that opens every organization's publications and
fleets** until it is rotated; that includes revealing or minting any fleet's
enrollment-token bearers, which collectors are served configurations with.
These rules are what bound that:

- **Only the platform and self-hosters of the open-source server hold it.**
  telflo customers never do: they use the platform's public API with `tf_`
  tokens, and the platform calls the opamp-server for them. No endpoint,
  screen or support path hands the secret to a customer.
- **The management port is never public.** It listens in plain HTTP unless
  `OPAMP_MANAGEMENT_TLS_CERT_FILE` and `OPAMP_MANAGEMENT_TLS_KEY_FILE` are
  both set (TLS 1.2 or later; one without the other refuses to start). In
  plain HTTP the secret crosses the network in the clear, so the port stays
  on a private network that only its callers reach; a caller across a
  network that isn't trusted needs TLS, the server's own or a terminating
  proxy's. The platform's client accepts an `https://` URL, and a private CA
  through Node's `NODE_EXTRA_CA_CERTS`. `OPAMP_MANAGEMENT_HOST` chooses the
  interface it listens on (every interface by default, as a container
  needs). Compose publishes `51235` in plain HTTP on the host's 127.0.0.1
  only, for development; the Compose install and the chart don't publish it.
- **It is never logged**, on either side: not the secret, not the
  `Authorization` header, in no log line, error message or span. Settings
  errors name the variable, never its value. The platform's client sends it
  with `redirect: manual`, so it never follows a redirect to another host.
- **Compared in constant time.** The opamp-server keeps only each accepted
  secret's SHA-256 digest and compares the presented one's digest with every
  accepted digest using `subtle.ConstantTimeCompare`, without stopping at a
  match, so neither the secret's length nor which secret matched shows in
  the time a request takes. A missing, malformed or wrong header (or two
  `Authorization` headers) gets the same `401`.
- **Rotated without an outage.** `OPAMP_MANAGEMENT_SECRETS_PREVIOUS`,
  comma-separated, lists secrets still accepted: the new secret goes into
  `OPAMP_MANAGEMENT_SECRET` and the old one into the previous list, the
  platform is rolled onto the new one, then the old one is dropped. A leaked
  secret skips the previous list and accepts the `401`s until both sides
  have restarted.
- **Each deployment generates its own.** The compose stack's
  `development-only-opamp-management-secret-not-for-production` is public in
  the repository.

`/health` is the only route without the secret, and it touches no data.

**The library link's signing key** is the platform's own and is held to the
same rules where they apply; the link it signs is in "Library links" below.
`TELFLO_LIBRARY_LINK_SIGNING_KEY` is required, trimmed (a key read from a
mounted secret file often ends in a newline), and at least 32 bytes of UTF-8
(`apps/api/src/settings.ts`, `librarySettings`). **Rotated without an
outage:** `TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS`, comma separated (each
entry trimmed, empty ones dropped), holds at most 8 other keys, each at
least 32 bytes, none repeated and none the current one, which still check
the links they signed. Both settings are read once, as the API starts, so
each step applies when every API process has restarted; with several
processes, a link one signs may be checked by another, so the order is:
first add the new key to the previous list everywhere and restart; then move
the new key from the previous list to the current setting, put the old one
in the previous list (the API refuses to start with a previous list holding
the current key: `settings.ts`' `librarySettings`), and restart; drop the
old key 24 hours after the last process restarted, once its links have
expired. A leaked key skips the previous list, which ends every link it
signed once every process has restarted. **It is never logged:** every
refusal of either setting names the variable and the rule, never a value; it
is in no error message, span, audit row, report, commit or test's printed
output. Unlike the management secret, it never leaves the API: no other
service holds it, and only the API signs and checks a link. **Each
deployment generates its own** (`openssl rand -base64 32`): compose's and
`.env.example`'s `telflo-development-only-library-link-signing-key` is
public in the repository, and the tests set their own test-only keys.

### Neither side can connect to the other's database

The platform and the opamp-server share a Postgres server but no database
object. Postgres lets every role connect to a new database, because `PUBLIC`
holds `CONNECT`, so a grant, a join or a foreign key across the boundary
would otherwise be stopped only by table grants and by tests noticing.
Instead, **each side's database refuses the other side's roles at connect**:

- the opamp-server's `deploy/bootstrap.sql` revokes `CONNECT` on
  `telflo_opamp_server` from `PUBLIC` and grants it only to its two login
  roles, `telflo_opamp_server_owner` and `telflo_opamp_server`. It also
  revokes `TEMPORARY` from `PUBLIC`, so no role creates temporary tables
  there unless granted, and `serve` refuses a role that can create in the
  database or the schema;
- the platform's migration 019 (`1700000000019_connect_only_by_application`)
  revokes `CONNECT` on its own database from `PUBLIC` and grants it to
  `telflo_platform_runtime`, which `telflo_platform` inherits. The role migrations run
  as keeps connecting because it owns the database or is a superuser.

The stack's smoke test checks both refusals over the network, with each
role's real password: `telflo_platform` is refused `telflo_opamp_server`, and
`telflo_opamp_server` is refused `telflo_platform` ("permission denied for database"). A
superuser still connects to both, as it does to everything; that is the
server's administrator, not either application.

### The agent endpoint

Collectors reach the opamp-server on **its own port, 51234, behind its own
load balancer, never the web gateway**. Unlike the management port it faces
the collectors' networks, the internet included, so every request is
authenticated by an enrollment token's bearer and its cost is bounded before
it is trusted:

- **TLS, or a TLS-terminating load balancer.** The agent listener speaks
  TLS 1.2 or later when given `OPAMP_AGENT_TLS_CERT_FILE` and
  `_KEY_FILE`, else plain HTTP and a log line that a terminating load
  balancer is expected. A bearer crosses any hop without TLS in the clear:
  terminate at the edge, and keep the hop to the pods private. Compose
  publishes 51234 on the host's 127.0.0.1 only (the development key is
  committed).
- **Its order of checks:** a declared length over 4 MiB is refused before
  anything; the pod's concurrency slots; the credential, from the
  `Authorization` header alone (a bearer over 1 KiB refused before
  decoding); the organization's share of the pod's slots (25); the
  collector's own guard by its `OpAMP-Instance-Uid` header, when it has one
  (a runaway collector is refused before it spends its organization's rate;
  a header that isn't one UUID is `400`, and the body's instance uid must be
  the header's, else `400`); the organization's rate; only then the body, at
  most 4 MiB, gzip included, within 5 seconds; the database work within 5
  more. An unauthenticated caller never has its body read, and one
  organization's credential (a fleet's default token never expires) holds at
  most its share of a pod's slots, each for at most 5 s reading a body and
  at most 30 s (the listener's `WriteTimeout`) for a client that doesn't
  read its answer.
- **Every limit is per pod** (the limit × the pods across a cluster); a
  fleet-wide limit is the load balancer's. Every map is bounded: the
  per-collector guard tracks at most 20,000 collectors of one organization
  per pod (a ceiling, not a setting), 200,000 in all. That per-organization
  share is a constant, filled by distinct `OpAMP-Instance-Uid` headers only
  with the organization's own credentials, within its own concurrency share,
  each such request counted by its own rate: a tenant rotating the header
  can only shed its own collectors (their new uids refused `429` until a
  sweep frees keys), never another organization's.
- **Answers say nothing**: one `401` body for every bad credential, one
  `403` for an archived fleet, a foreign group, no group or another fleet's
  collector, and "collector limit reached" for the cap, naming no id or
  count; a database failure is `503` with `Retry-After`. No CORS header: no
  browser calls it.
- **Refusals are sampled where a caller can repeat them at will**: the
  `401`s and the other refusals made before a credential is read, and the
  `403`s (an archived fleet's, a fleet of another type's, the cap's, a
  foreign group's, no group's, a collector of another fleet's: a supervisor
  keeps polling through a `403`), are a log line a minute per outcome (the
  `403`s per outcome and organization, so one organization's never hide
  another's; at most 10,000 pairs, a sweep a minute, past them a line a
  minute saying the sampler is full), with the count since the last, on the
  injected clock; a lost credential and a failure are a line each. A pair's
  refusals after its last line are a trailing count, written at its next
  refusal on that pod a minute or more on, else by the first sweep a minute
  or more after its last line (each sampler — the authentication's `403`s,
  the poll's, the guard's — sweeps at a refusal it counts on that pod a
  minute or more after its last sweep, so up to about two minutes of that
  sampler's activity); a pod that refuses nothing more writes nothing more.
  The collector guard's refusals past an organization's share are sampled
  the same way, per organization.
- **A collector new to its organization is enrolled only by a message
  carrying its agent description**, so the group it names is always checked:
  one without is asked for its full state, never enrolled into the Default
  group, so a foreign group's `403` can't be undone by a later,
  description-less message.
- **Every new collector names its group** (`handlers/report.go`'s
  `reportedGroup`): a description whose `telflo.collector_group_id` is
  absent or blank after trimming is refused `403` (the fixed body, outcome
  `no_group`, sampled as above), on both fleet types, never enrolled into
  the Default group; a value that isn't a group of the token's fleet is
  `foreign_group`. An enrolled collector is never checked again, so one
  enrolled into the Default group by an earlier release keeps polling until
  its record is deleted. The collector image refuses to start without
  `COLLECTOR_GROUP_ID` (blank after trimming included;
  `docker/collector-image/entrypoint.sh`), and Telflo's own installs always
  name the group.
- **A deleted group's collectors are refused:** a group's delete deletes its
  collectors (below), so a collector still running finds no record at its
  next poll and only the agent description it sends can enroll it again, its
  group checked as any new collector's; a message without one is asked for
  the collector's full state first (`handlers/poll.go:209-246`), and since a
  supervisor sends its description only in its full state, in practice its
  next poll is asked for it. A collector installed into the deleted group
  (its install names the group) names it in that description and is refused
  `403 foreign_group`; its supervisor keeps polling through the `403`
  (sampled), and the collector keeps its last configuration until it is
  uninstalled or reinstalled into another group. A collector moved into the
  deleted group by hand from another group names the group its install
  names, so it enrolls again there, as a new record (nothing pinned).
- **pprof and the admission view are on the management port**, behind the
  management secret (`/api/v1/debug/`), never on the agent port (no
  `OPAMP_PPROF_TOKEN` there).
- **Revoking a fleet's default token strands its restarted collectors**: the
  supervisor doesn't persist a pushed rotate token, so after a restart it
  presents the default token, which is refused, until a new token reaches it
  through the install flow.
- **A revoked or expired rotate token strands the collectors holding it
  until their supervisors restart**: refused `401`, the supervisor keeps the
  refused bearer, and a later rotation can't reach it; after a restart it
  comes back through the default token. Rotate before expiry; revoke a
  rotate token knowing that.

### Enrollment tokens and the encryption key

A bearer is the format the collectors already hold:
`base64(nonce ‖ AES-256-GCM ‖ tag)` of `{"token_id","deployment_id"}` (the
fleet's id), the AES key the SHA-256 of `OPAMP_ENCRYPTION_KEY`'s text.
**Only the opamp-server holds the key**: its management API mints every
bearer (a fleet's create, a rotation, a reveal, a new default token), and
the platform never sees the key.

- **Bearers are never stored.** A token's row holds its id, kind, expiry and
  revocation; a reveal encrypts it afresh and writes a `viewed` audit row.
  Every reply carrying a bearer, and a collector's reads and update (its
  list, its read, its error history and its update's answer), which carry
  its reported attributes and error text, is `Cache-Control: no-store`.
- **A token authenticates** only when its row exists, the bearer's fleet
  equals the row's (the bearer's own is never trusted alone), it isn't revoked or
  expired, and its fleet is active and server-class; the organization, the
  fleet and the kind come from the row.
- **The token cache is ≤ 10 seconds**: each replica keeps a token's row at
  most 10 s from the moment its read began (a slower, older read never
  replaces a newer one), keyed by the token's id, never the bearer, found
  rows only. So a revocation is refused by every replica within 10 s.
- **The key's files.** `OPAMP_ENCRYPTION_KEY_FILE` and
  `OPAMP_ENCRYPTION_KEYS_PREVIOUS_FILE` (a compose or Kubernetes secret,
  at most 64 KiB, its final line ending dropped) are preferred to the value
  variables: `serve` unsets those after reading them, but a value stays in
  `/proc/<pid>/environ`. Exactly one of the current pair, at most one of the
  previous pair, at most 8 previous keys. Compose's development key,
  `docker/opamp-server/development-encryption-key`, is public in the
  repository.
- **Used exactly as written.** A key with whitespace at either end is
  refused at startup, so a key moved to the previous list derives the same
  AES key; an older key with such whitespace must be replaced, never
  trimmed (trimmed, it would open none of its bearers).
- **Rotated without refusing a collector**: the new key current, the old one
  previous, bearers re-minted (a rotation of each fleet's rotate token
  pushes them; default tokens are redeployed), then the old key dropped. The
  opamp-server's `README.md`, in its own repository, has the steps, in three
  phases, so that every running pod holds every key another one mints with.
  The phases always apply, with one replica too: a rolling update runs old
  and new pods side by side.
- **What memguard protects, and what it doesn't.** Each derived key sits in
  locked memory (not swapped, wiped on exit; every key is destroyed and
  memguard purged on every way out of `serve`), and the bytes read from a
  key file are zeroed once derived. But each encryption or decryption
  expands the key into AES's key schedule on Go's heap for that call, and
  deriving it passes the text through SHA-256's state on the heap: the Go
  runtime promises to wipe neither. memguard narrows where the key lives; a
  dump of the process's memory still isn't safe to hand out.

### Postgres's own log

The database's server log is outside the opamp-server's control, so what
reaches it is kept from it at the source:

- **A taken name is found without raising.** A unique key's violation
  makes Postgres log the refused value in its `DETAIL`, and the values the
  opamp-server keeps unique are configuration text (a fleet's label, a
  group's or a collector's name). The stores look for the name first
  (`on conflict do nothing`, `where not exists`, under the locks they
  already take), so only two writes of one name racing each other reach
  the unique key, still answered as taken.
- **`log_error_verbosity` is `terse` for the server's role**
  (`deploy/bootstrap.sql`, role-wide, only a superuser may change it): even
  that race's `DETAIL`, `HINT`, `QUERY` and `CONTEXT` stay out of the log;
  what stays in is the error's message and the statement
  (`log_min_error_statement`), whose values are bound, so it carries `$1`,
  never a value (`log_parameter_max_length_on_error` is 0 by default; leave
  it so). `scripts/check-bootstrap.sh` fails without it. A managed Postgres
  without a superuser can't run the bootstrap (it needs a superuser): run as
  an admin role it stops part way, and its refused
  `alter role telflo_opamp_server … nosuperuser … nobypassrls … password`
  writes the runtime role's password to the server's log through
  `log_min_error_statement` (set a new one if that happened). There the
  operator makes the roles and the database by hand with the provider's
  tools, following the bootstrap as a checklist, sets
  `log_error_verbosity = terse` server-wide through the provider's parameter
  group (a superset of the role setting, and safe), and checks what
  `serve`'s startup checks don't (no `CREATEDB` or `CREATEROLE` on the
  server's role, `PUBLIC` without `CONNECT` or `TEMPORARY`, the
  `search_path`, terse errors); the server's README lists the checks.

### Audit rows and URLs

- **Audit rows** (`enrollment_token_events`: `issued`, `viewed`, `rotated`,
  `revoked`) carry ids (the token's, the fleet's) and the actor, an id and
  an email snapshot as the caller sends them; never a bearer, a fleet's
  label or any configuration text. *(They are read back through
  `GET …/fleets/{fleetId}/tokens/events`, paged, with no bearer and no token
  kind: "The platform's fleet routes", below.)*
- **The management API's `q`** (a collector search) puts a collector's name
  or address in a URL. The opamp-server never logs a path or a query; **its
  callers, the platform's client included, and any proxy in between must not
  log full URLs to the management API**. *(The platform's client logs
  nothing, and its request log drops the query of every fleet route: "The
  platform's fleet routes", below.)*

### Isolation without row-level security

One opamp-server serves every organization, with no row-level security:
every link between an organization's rows is a composite foreign key
carrying `organization_id`, so a link across organizations can't be stored;
every query filters on the organization first, but the two exceptions each
by its nature: the authentication's `Lookup` reads a token by its id alone
(the bearer names it; the row then gives the organization), and the error
history's `Cleanup` deletes across organizations; and tests call every store
method and every management route with another organization's ids (a plain
`404`, nothing changed). The opamp-server's `CONTRIBUTING.md`, in its own
repository, has the rules.

## Calling an internal service from an endpoint

A new endpoint that calls an internal service does what the collector
validator's endpoint does:

- **The browser reaches only the API.** The service listens on a private
  port, never behind the gateway; compose publishes it on the host's
  127.0.0.1 only. The endpoint checks the session, the terms and the
  tenancy and draft rules first, and takes what the service acts on from
  the server's records (the configuration's distribution, the version's
  pin), never from the browser.
- **One shared secret, as above:** a required setting (at least 32 bytes,
  a URL with userinfo refused), sent as `Authorization: Bearer`, compared
  in constant time against a current and a previous list, never logged; the
  service refuses to start without it. The client never follows a
  redirect.
- **Outside any transaction, bounded.** Read and commit first, then call.
  One timer covers the request and the reading of the answer, and the
  answer is capped in size and checked against zod mirrors of the
  service's `openapi.yaml` schemas (the client's `schemas.ts`); only the
  test double checks the file itself, both directions, in the API's tests.
- **Every failure is one answer.** Down, slow, busy, refusing the secret,
  or answering what its contract doesn't allow: the person gets one
  `503` that says nothing was done, never a result that wasn't produced.
  The reason is logged, never the text, the answer or the secret.
- **Per-person limits** before the call: a count per minute and a cap on
  calls in flight (`429` with `Retry-After`), so one person can't hold the
  service's capacity.
- **Untrusted input** (a configuration the service runs): each unit of
  work in its own process group under one deadline, killed whole; answers
  scrubbed of the service's own paths.
- **Work the service starts and holds for a while** (the collector
  tester): the endpoint only queues it, and a background dispatcher calls
  the service. It claims through SECURITY DEFINER functions reachable only
  from its own database context, with a lease. It stores an answer only
  while the lease is still its own, and never sends a unit of work twice.
  Each API process watches the service's health, and the endpoint refuses
  new work at once while the service is down. The service holds no
  database or storage credentials, and its container is hardened: the
  secret in a file, no route out, a read-only root, no capabilities.

### The platform's fleet routes

The routes under `/api/v1/organizations/{organizationId}/fleets…` and
`…/configurations/{configurationId}/fleet-usage`
(`telflo-core/apps/api/src/modules/fleets/`) call the opamp-server's
management API, as above. One opamp-server serves every organization
behind one secret that opens all of them, so the platform alone decides
whose fleets a request reaches. What they add to the pattern:

- **Tenancy first.** A body or a query that breaks its contract (the
  `.strict()` zod schemas of `packages/contracts/src/fleets.ts`, which
  mirror the opamp-server's bounds and are stricter in one: a group's
  annotations nest at most 64 arrays and objects deep, where the
  opamp-server and its Postgres would take more) is `400 invalid_request`
  first, before the session's `401`: Fastify checks the schema before the
  route's hooks, and the refusal says nothing of the organization. Then
  each route runs `authenticate` and `requireCurrentTerms` (`403
  terms_acceptance_required` first), then `assertActiveOrganization`: a
  path naming any organization but the session's active one is `404
  organization_not_found`, before the route does anything of its own. Each
  path id (a fleet's, a group's, a token's, a collector's, a
  configuration's) must be a canonical UUID, else its own `404` with no
  call (the opamp-server would answer `400`, a `503` here). Every call
  names the session's organization, never the path's spelling or the
  body's, and the actor sent with a fleet's create, a rotation, a reveal,
  a revoke or a new default token is the session's person (`{id, email}`),
  never the body's. The opamp-server answers another organization's ids as
  not found, and the routes' tests send them (a `404`, nothing changed).
- **Every member may do all of it**: there is no role check, tokens
  included. A non-member gets the same `404`.
- **A published version is resolved only from the organization's own
  records, as the person sees them.** The browser never sends a
  publication id: an assignment or a pin names a configuration version,
  which the platform resolves before any call, in a short committed
  transaction, through the organization scope, among live configurations
  and under the draft rules (`visibleTo`: the person's own drafts and
  every published configuration). None is `404
  configuration_version_not_found` (another organization's, another
  member's draft, a deleted configuration's); a draft is `422
  configuration_version_not_published`. A reply names each published
  version by its id (`publishedVersionId`; a group's
  `assignedPublishedVersionId`) with the platform's configuration and
  version beside it (`version`; a group's `assignedVersion`), described in
  one query under the same rules, `null` where no such version records the
  id. A configuration's fleet usage answers only for a configuration the
  person can see.
- **Read and commit first, then call**; no lock is held across a call. A
  fleet's create registers the organization when it has to
  (`ensureOrganization`) and afterwards takes it `for share`: deleted
  meanwhile, the delete hook runs again and the answer is `404`.
- **One `503 fleets_unavailable`** for every failure that isn't the
  person's to fix: down, slow, an oversized reply, the secret refused, an
  answer or ids the contract doesn't allow, a `413`, a `422
  publication_not_found` for a version the platform resolved (the two
  sides disagree; logged at error), any other throw of a call (a bug,
  logged at error with its name only), or the opamp-server's own `503
  delete_in_progress` (a delete it is already running; the client reads no
  `5xx` body). Unlike the validator's, it can't say nothing was done: a
  reply lost after the opamp-server committed a write looks the same (a
  rotation isn't idempotent), so its message is "Fleet management is
  unavailable right now. A change you were making may or may not have been
  made: reload before trying again." The configuration delete's usage
  check runs before anything is deleted, so its `503`, the same code, says
  "Couldn't check whether a fleet uses this configuration, so nothing was
  deleted." (both in `packages/contracts/src/fleets.ts`). Each is logged
  with ids and the result's kind, never a body, a URL or the secret.
- **Per person, per organization, before any call**
  (`http/rate-limits.ts`): 240 reads and 240 writes a minute, 10 replies
  carrying a bearer a minute (a fleet's create, a reveal, a rotation or a
  new default token, one count for the four), and 16 requests in flight
  across all of them. Each request is one count and one slot, whatever it
  calls, taken after the platform's own checks and given back in a
  `finally` (one check comes after: a group's write against its fleet's
  type, read from the opamp-server inside the slot at a create and at an
  update carrying a name or annotations (and, for an update carrying a
  Kubernetes group's settings, the group too), so those `400`s and `409
  collector_group_name_fixed` spend the write; no count is given back);
  past a limit, `429 rate_limited` with `Retry-After` (1 second for the
  in-flight cap). A published configuration's delete spends a read and a
  slot on its usage check. In memory, per API process, as every limit is.
- **Bearers cross the platform only in four replies**: a fleet's create
  (both, once; a retry's `200` carries none), a token's reveal, a rotation
  and a new default token, each `Cache-Control: no-store`, set by the
  platform (the opamp-server's header isn't forwarded), as are a
  collector's reads and update (its list, its read, its error history and
  its update's answer), which carry its reported attributes and error
  text. A bearer is never logged, audited or put in an error, and the
  platform never holds `OPAMP_ENCRYPTION_KEY`. Outside a session, one
  reply carries a bearer: a Helm values link's public download ("The Helm
  values link" below), revealed with no actor.
- **A fleet's token events are a read**: `GET
  …/fleets/{fleetId}/tokens/events?limit&cursor` (`FleetsPageQuerySchema`:
  `limit` 1–100, default 50; the opamp-server's opaque cursor) passes the
  opamp-server's page through, newest first: each event its id, its
  token's id, what happened (`issued`, `viewed`, `rotated`, `revoked`),
  when, and the member who did it (`{userId, email}`, null for none);
  never a bearer or a token's kind. It spends one of the person's reads
  (the read limit, above), its reply is read under the M class's 1 MiB cap
  (below), a `limit` or cursor outside the contract is its `400
  invalid_request`, an unknown fleet (another organization's too) is `404
  fleet_not_found`, a cursor the opamp-server refuses is `400
  invalid_request` on `cursor` ("reload the list"), and any other refusal
  is the one `503`. It isn't `no-store`: it holds ids, times and members'
  emails, as the tokens list's creators do, and `no-store` is kept for
  configuration text and secrets.
- **A new default token**: `POST …/fleets/{fleetId}/tokens/default` (no
  body; the actor is the session's) calls the opamp-server's route of the
  same path, which issues one only while the fleet has no valid default
  token (all revoked: `409 enrollment_token_default_exists` otherwise,
  also for the loser of two racing issues; `409 fleet_archived`). It
  spends one of the person's bearer replies (above), answers `201`
  `{token: {id, kind, bearer, expiresAt}}` with `Cache-Control: no-store`,
  and is audited `enrollment_token.issued` with ids only; the opamp-server
  keeps its own `issued` event with the actor.
- **Installing collectors**. `GET
  …/fleets/{fleetId}/groups/{groupId}/install` (the install's facts: the
  image tag, the agent endpoint, whether insecure connections are allowed,
  the group's collector version, its mounts and the names of the variables
  its published version reads; a Kubernetes group's are its Helm facts,
  below) spends a read; `POST …/groups/{groupId}/install-bundle` (a Linux
  bundle) a write. **Neither carries a bearer**: the facts are sent
  `no-store` anyway (the variables' names are configuration text), and the
  bundle holds none (the person sets `OPAMP_TOKEN` on the host from a
  reveal). The bundle is **rendered on the server from validated fields
  only**: the request's method, arch, root path, executable path and
  variables (each name one the facts offer, each value 1–4,096 characters
  with no control character and no lone surrogate, for every install; the
  contract's `.strict()` schema, then the facts' names), the settings, the
  group's id and the catalog's URLs and sha256 (each checked again
  against its allow-list), never a string the browser built for a script
  (a bundle never pastes the browser's substitutions into a script run as
  root). It answers `application/gzip` as an `attachment` named by the
  method and the arch only, `no-store`, `nosniff`, and is audited
  `fleet.install_bundle_downloaded` with `{fleetId, groupId, method,
  arch}`, never a path, a variable's name or a value. The request log
  keeps these routes' paths (ids) and never a body; a template's text and
  a render's output are never logged. Both refuse, before anything is
  rendered, a fleet that is archived (`409 fleet_archived`); the bundle
  refuses a fleet that isn't a `server` fleet (`409
  fleet_type_not_installable` with "A Kubernetes-supervisor fleet's
  collectors are installed with Helm: use Install with Helm."), while the
  facts answer a Kubernetes group with its Helm facts (`installable`'s
  path: `"server"` for the bundle and a Linux link, `"helm"` for a Helm
  values link, `"any"` for the facts). Both refuse a group with no
  published version or one of a deleted configuration (`409
  collector_group_unassigned`, `409 collector_group_assignment_deleted`),
  and a version built for another distribution or no longer offered; the
  bundle also refuses a version with no binaries for the arch. Those three
  version cases share one code, `409 collector_version_not_offered`, each
  with its own message.
- **A group's annotations are checked against its fleet's type**
  (`modules/fleets/service.ts`' `refusalForFleetType`). The opamp-server
  stores a group's `annotations` and never reads them; a Kubernetes
  group's role, namespace, replicas and volumes live there, under
  `telflo.kubernetes` (the opamp-server's groups have no such columns), so
  the platform alone validates them (the contracts'
  `KubernetesAnnotationsSchema`, `.strict()`, within the annotations' 16
  KiB and 64 levels). The fleet's type is read under the session's
  organization before any type refusal (another organization's fleet is
  `404 fleet_not_found` first). A `server` fleet's group refuses
  `telflo.kubernetes` (`400` at `annotations.telflo.kubernetes`); a
  `kubernetes-supervisor` fleet's group refuses `telflo.dockerMounts`
  (`400` at `annotations.telflo.dockerMounts`), any rename (`409
  collector_group_name_fixed`), a create named neither `cluster` nor a
  gateway's name (`400` at `name`), a create or an annotations update
  without `telflo.kubernetes` (`400` at `annotations.telflo.kubernetes`)
  and settings naming another role than the group's (`400` at
  `annotations.telflo.kubernetes.role`). No refusal repeats a name, a
  namespace or a path: their words are fixed.
- **A group's delete deletes its collectors** (both fleet types): the
  opamp-server deletes the group's collectors (their error history by its
  cascade) and the group in one transaction, the collectors locked in id
  order after the fleet and the group (the lock order), the Default group
  still refused (`409 collector_group_is_default`). It runs as a fleet's
  delete does (below): on the long delete context, a `40P01` run again at
  most 3 times, the platform waiting 25 seconds. The browser confirms it
  by the group's name typed (ASCII white space at the ends ignored), in an
  uncontrolled input inside `ph-no-capture`. Not audited, as no group
  write is.
- **Audit rows hold ids, and no label, name or bearer**: `fleet.created`
  (and the fleet's type), `fleet.updated` (the names of the fields sent,
  and the status), `fleet.deleted`, `enrollment_token.revealed` (and the
  token's kind), `.rotated`, `.revoked` (every revoke asked, an already
  revoked token's included) and `.issued` (a new default token: `{fleetId,
  tokenId}`), and `fleet.install_bundle_downloaded` (`{fleetId, groupId,
  method, arch}`, never a path, a variable's name or value), each written
  after the opamp-server's success (the bundle's, once it is rendered) in
  its own transaction; a failed write is an error log, and the success
  stands. The quick-deploy links' rows are written in the change's own
  transaction instead (below). A fleet's delete that outlasts the
  platform's 25-second wait (below) answers the one `503` and writes no
  `fleet.deleted`, though the opamp-server then finishes it; the person's
  retry gets `404 fleet_not_found` (an accepted residue), and that `404`
  removes the fleet's quick-deploy links, still with no row (below).
  Groups, collectors and pins aren't audited; the opamp-server keeps its
  own token events with the actor.
- **No query of a `/fleets` route is logged.** The request log
  (`http/request-log.ts`) drops the query of every request under
  `/api/v1/organizations/:organizationId/fleets`, by the route it matched,
  by the path's prefix, or by the path percent-decoded (an encoded path
  with a trailing slash matches no route), each spelling with its runs of
  slashes made one (a doubled slash matches no route either), as it does
  the configurations list's: a collector list's `q` holds a name or an
  address, and its cursor, sorted by name, is the base64url of a
  three-byte header, the name and the collector's id. The OIDC rule checks
  the same spellings, its runs of slashes made one. The client logs
  nothing, and no error it raises carries a URL, a path, a query, a bearer
  or configuration text.
- **Every reply is read under a cap**, by one shared reader
  (`apps/api/src/http/read-capped.ts`: a `Content-Length` over the cap
  refused before reading, else the body counted as it streams and the read
  canceled past the cap), which the validator's, the evaluator's and the
  tester's clients use too. The opamp-server client's caps are four
  classes, each above its operations' worst documented reply as the real
  server encodes it: S 64 KiB, M 1 MiB, U 4 MiB (the unpaged groups,
  tokens and usage; the organization's variables, its variable groups and
  one variable group with its overrides, at most about 1.85 MB, 0.94 MB
  and 0.94 MB at their bounds), L 10 MiB (a page of collectors or of a
  collector's errors, a publication). An oversized reply is `unavailable`
  (`oversized_reply`): the one `503`.
- **An organization's delete is retried until it lands**
  (`modules/organizations/opamp-registration.ts`), after the response:
  five attempts, at once, then 5 s, 30 s, 2 minutes and 10 minutes later
  (the waits, not counting each attempt's own up to 25 s), each from an
  unref'd timer through `runAfterResponse`. `unavailable` is retried (the
  opamp-server's `503 delete_in_progress` included); deleted or `404` is
  done; a refusal, a misconfiguration or any other throw stops at once, at
  error. A delete that never lands is an error log with the organization's
  id, to reconcile by hand; at shutdown, the organizations with a retry
  pending are logged at error, and their retries are lost.
- **An organization's, a fleet's or a group's delete outlives the
  platform's wait** (a group's, because it deletes the group's
  collectors). Their cascade can be long (an organization of 40,000
  collectors with their error history took about 8 seconds), so the client
  waits 25 seconds for `deleteOrganization`, `deleteFleet` and
  `deleteCollectorGroup` (`DELETE_OPAMP_SERVER_TIMEOUT_MS`,
  `LONG_DELETES`; 5 seconds for every other call), and the opamp-server,
  once a delete has started, finishes it even if the platform hangs up,
  within 5 minutes of its own (`management/deletes.go`'s `deleteContext`),
  a deadlock (`40P01`) run again at most 3 times; a retry then answers
  `404` (the organization's retry counts it done; a person retrying a
  fleet's delete gets `404 fleet_not_found`, a group's `404
  collector_group_not_found`, which the Groups tab counts as deleted). A
  repeat of an organization's or a fleet's delete that reaches the replica
  still running it is answered `503 delete_in_progress` at once rather
  than waiting behind it with a database connection; a repeated group
  delete has no such check: it waits on the group's row, holding a
  connection, then finds it gone. Only two things cut one off, each
  rolling it back, deleting nothing, for the next retry to run again: its
  own 5-minute bound, and the opamp-server's stop, when it is still
  running as the in-flight requests' 10 seconds pass. A person's fleet or
  group delete past 25 seconds answers the one `503` (see the audit rows
  above).

**The install templates are trusted operator code**. The API reads the
Linux bundles' templates on every render from
`TELFLO_INSTALL_TEMPLATES_DIR` (`linux/all-in-one/`, `linux/own-binary/`;
the repository's `install-templates/`, copied into the API's image, is the
default set): an operator's directory, a Kubernetes ConfigMap or a
`hostPath`, whose scripts run as root on every host that installs from
them. Whoever can write that directory can run commands as root on those
hosts, so it is the operator's, mounted read-only into the API, never a
member's. The loader (`apps/api/src/install/templates.ts`) keeps its
reading safe, not its contents: the root's realpath once and the method's
directory's on every read, under it; names starting with `.` skipped
(kubelet's `..data`); a symbolic link followed only inside the method's
directory (a flat ConfigMap's keys, through `..data` resolved once per
read); each entry a regular file by `lstat` before it is opened, then
`O_NOFOLLOW | O_NONBLOCK` and `fstat`; at most 32 files of at most 256 KiB
of UTF-8 each; a refusal naming the relative path and a line, never the
text (the API refuses to start, and a render answers `503
install_unavailable`). The renderer (`apps/api/src/install/render.ts`)
keeps **Telflo's values** where their quoting holds: a placeholder is
exactly `${UPPER_SNAKE}`, one of its method's own set, filled in one pass
(a typed `${ROOT_PATH}` stays text), and may sit only where the loader
allows it, else the template is refused: in a script (`*.sh`), as the
whole right side of an assignment line (`name=${ROOT_PATH}`, written as
one single-quoted word, `'` as `'\''`), or, for a block of shell lines the
server builds (`COLLECTOR_ENV_EXPORTS`, `SUPERVISOR_VERSION_CASES`), alone
on its line, and never on a line that begins inside a quote, a heredoc or
a backslash continuation; in YAML (`*.yaml`, `*.yml`), as the whole value
of a mapping or sequence line, written as one double-quoted scalar (a
value holding `"`, `\`, `$`, a control character or a Unicode line break
refused, never escaped) or a lone `true`/`false`; in any other file (the
README), as it is. It doesn't make a template's own commands safe.

**The bundle's security** (the collector image's entrypoint keeps the same
rules). Every value written into the supervisor's YAML as a string is a
double-quoted scalar (the start script's own ServerName and token lines
with `\` and `"` escaped and `$` doubled); the booleans are bare `true` or
`false`. The agent's attribute values (the group's id, a UUID;
`host.name`; `host.ip`, an address's characters only) never hold `"`, `\`,
`$` or a control character: the supervisor copies them unescaped into the
collector's configuration, which expands `${env:…}` again. The collector
never holds the bearer in its environment: the start script writes it into
the supervisor's configuration and `opamp.env` (each 0600) and unsets
`OPAMP_TOKEN` as soon as it has, before the downloads, the collector's
`--version` and the supervisor (the image's entrypoint unsets it, with the
install's four other variables, before its `exec`). The start script is
mode 0700 (it holds the values typed for the configuration's variables).
The binaries are downloaded over https only, checked by sha256, unpacked
with `tar --no-same-owner` and installed root-owned, mode 0755. The root
path (own-binary's script: its own directory) must be owned by the user
running the script (root) and writable by no other user or group, a
symbolic link judged by its target and its own directory, and so must
`opamp.env` when the token is read from it. Accepted residue: the
collector runs as root, so a published configuration with a file-reading
receiver could read the token's files; every member may reveal the fleet's
tokens anyway; a separate collector user isn't planned yet.

**The deploy order:** the opamp-server is migrated and deployed before the
platform. Its migrations 10 and 11 (a new default token's index; groups'
`annotations`) are expand only, and the platform's client requires
`annotations` in every group reply (a reply without it breaks the
contract: the one `503`) and calls the new default token's route. A
platform deployed first would answer every group read `503` until the
opamp-server caught up, and every fleet create too: the opamp-server makes
the fleet, but its reply's Default group lacks `annotations`, so the
person sees a `503` and the reply's bearers are lost (the fleet is listed,
and its tokens' bearers can be revealed later).

**The quick-deploy links' deploy order:** the platform's migration
`1700000000032` (`quick_deploy_links` and
`quick_deploy_link_by_secret_hash`) runs before the API that reads it is
deployed. Compose's `migrate` enforces it (the API starts only once it has
completed); a deployment that runs migrations by hand runs them first. An
unmigrated API answers `500` on the links' routes and on the public
download, and loses every `fleet.deleted` audit row: the delete stands,
but the transaction that removes the fleet's links and writes the row
fails (one error line of ids). The opamp-server needs no change for them.

**Quick-deploy links**. A link lets whoever holds it download a fleet's
install without signing in, so its secret is a credential, as a bearer is.
- **Hashed, shown once.** The secret (`tqd_` and 32 random bytes in
  base64url, so secret scanners can match it) is stored only as its sha-256
  (`quick_deploy_links.secret_hash`), crosses the platform once, inside the
  create's `url` (`201`, `no-store`), and is never logged, audited, put in
  an error or returned again: no list item, link, choice or audit row holds
  it or its hash. Another host later gets a new link.
- **The typed values are sealed.** The values typed for the
  configuration's variables are stored with the link, encrypted with
  AES-256-GCM (`modules/quick-deploy/sealed-values.ts`, `node:crypto`)
  under `TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY`, the organization's and the
  link's ids as associated data (a value moved to another link fails to
  open), the key's id beside the ciphertext so a rotation's
  `TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS` still open older links. A
  key is 32 bytes in base64; its errors name the variable, never the
  value. They are opened only by the public download, into the bundle's
  start script; the list and View show the variables' names, never a
  value. Anyone holding the link gets them in the bundle, so the link is
  as sensitive as they are.
- **Every member** makes, lists, views, extends and revokes any link in
  the organization's fleets, with the fleet routes' tenancy, limits and
  refusals; an unknown link, another organization's or fleet's too, is
  `404 quick_deploy_link_not_found`. A link stores the bundle request's
  validated fields only (never a string the browser built) and the fleet's
  default token's id: a create needs a valid default token (`409
  enrollment_token_default_missing`), whose bearer the copied command
  carries; no token is minted. A link of either kind (a Linux link or a
  Helm values link) is made only while the organization's "Public install
  links" switch is on (`409 public_install_links_disabled`; "The
  organization's switch" below).
- **The cap**: at most 100 links neither expired nor revoked per fleet,
  counted under a transaction-scoped advisory lock on the organization's
  fleet in the create's transaction, and in every extend's: an extend
  counts the fleet's other links active at its `now` and is refused when
  they are already 100 (an active link of a full fleet has 99 others, so
  in practice an expired link's extend is the one refused); whether the
  link is active is never decided before the lock (else a link active at
  the extend's `now` but expired at a racing create's would be counted by
  neither): `409 quick_deploy_link_limit_reached`.
- **A fleet's delete removes its links**: after the opamp-server's
  success, in one transaction with the `fleet.deleted` row; after its
  `404` too (the fleet, or the organization, unknown to it), with no row,
  since that may be the retry of a delete that outlasted the platform's
  wait, whose links, their sealed values with them, would otherwise stay
  forever. A failed removal is one error line of ids; the links left
  download `410` (their fleet is gone).
- **Audit** in the change's own transaction: `quick_deploy_link.created`
  (`{linkId, fleetId, groupId, method, arch, systemd}`, a Helm values
  link's `{linkId, fleetId, groupId, kind: "helm"}`, the member),
  `.extended` (`{linkId, fleetId, by, expiresAt}`), `.revoked` (`{linkId,
  fleetId}`, every revoke asked) and `.downloaded` (below); never the
  secret, its hash, a path, a variable's name or a value.

**The public download, the pattern for unauthenticated downloads**. `GET
/api/v1/quick-deploy/{secret}` (`modules/quick-deploy/routes.ts`) is the
platform's first route that serves a download to someone who isn't signed
in; the air-gapped binaries endpoint reuses its machinery, and any later
unauthenticated download follows it:
- **Registered outside the session's hooks**: no `authenticate`, no cookie
  read, no CSRF header (a `GET`, whose only writes are the link's counter and
  its audit row), no CORS of its own (never `*`); `exposeHeadRoute: false` (a `HEAD` would have run the handler).
- **Limited before anything is read**: a per-IP limit as the route's
  `onRequest` hook (`rateLimiters.quickDeployPerIp`, 30 a minute on
  `request.ip`, the trusted hops honored: every request counts, an
  unknown or malformed secret's included), then a per-key limit on the
  thing the secret found, keyed by its id, never by the secret
  (`createPerKeyLimiter`, 60 a minute per link, bounded in memory), then a
  slot among at most 8 renders in flight per process (`createInFlightCap`,
  `503 downloads_busy` with `Retry-After: 1`). `429`s carry `Retry-After`.
  In memory, per API process, as every limit.
- **In a fixed order**, each refusal before any later read: the per-IP
  limit; the secret's shape and its lookup by hash (`404`, alike); the
  per-link limit; revoked, expired, the organization gone (`410`); the
  organization's switch off (`403`, read with the link); the render slot;
  the fleet's and the group's checks of the bundle, the link's variables
  still read, its default token still valid (`410`), the values opened,
  the templates and the binaries; the render (a Helm values link's: "The
  Helm values link" below); then the switch again, the counter and the
  audit row.
- **Hashed at once**: the handler hashes the secret before the lookup, and
  only the hash and ids go further.
- **Plain text and fixed headers**: the bundle `application/gzip`,
  `attachment` named by the method and the arch only (`sendDownload`: a
  file name of plain characters), and every reply, each refusal and `429`
  included, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`
  and `Referrer-Policy: no-referrer` (a browser that opens a link never
  sends it as a Referer). Every refusal is `text/plain` with the
  platform's own short words (`sendPlainTextRefusal`, through the route's
  `errorHandler`, `createPublicDownloadErrorHandler`), never the secret, a
  label, a name, a path or a value; a framework error on such a path (a
  malformed escape, a parameter too long) answers the same way, logging
  its code only (`errors.ts`' `respondToFrameworkError`). A Linux link's
  reply carries no bearer (a Helm values link's does: below): the bundle
  is the tokenless one, rendered at each download from the link's stored
  choices and the group's current published version, read with no person
  (`isPublished`, the link's organization as the context).
- **Audited after the build**: the counter (the row locked while still
  active, else `410`) and `quick_deploy_link.downloaded` (no actor; the
  organization; `{linkId, fleetId, groupId, method, arch}`, a Helm values
  link's `{linkId, fleetId, groupId, kind: "helm"}`; the requester's
  address by `clientIpForAudit` and the user agent's first 512 characters,
  `requesterOf` (`[redacted]` when it may hold a credential:
  `auditUserAgent`); the client's address behind the gateway,
  `TELFLO_TRUST_PROXY_HOPS` `"1"`, which the stack smoke checks) in one
  transaction, after the render. **A failed write fails closed**: both
  roll back and the download is `503`, nothing served or counted (the
  command's `curl --retry 3` covers a blip), unlike the signed-in bundle,
  which is served and its failed row logged.
- **Logged at the right level, with ids only**: an expected `5xx` refusal
  at warn with the link's ids and the code, no stack (the route's
  `errorHandler`); its cause once at error where it happened, ids only
  (`quickDeployBundle`'s values that can't be opened and `templatesOf`'s
  templates in the fleets service, the route's fail-closed unrecorded
  download in `modules/quick-deploy/routes.ts`; the opamp-server's logged
  by the service's own calls as on every fleet route, at warn when it
  couldn't be asked); **a render refusal answers `503` on both paths**: a
  Linux link's bundle the render refuses (`InstallRenderError`, its rule's
  fixed words as the line's reason) and a Helm values link's builder
  refusal (`HelmBuildError`, its field only) are each one line of ids and
  the refusal's `source`, no stack, answered `503
  quick_deploy_unavailable` ("Downloads aren't available right now. Try
  again in a moment."), nothing counted or audited; **at warn when the
  cause is the link's own data, at error when it is the operator's**
  (`source` `"choices"` for a Linux link's paths, variables, arch, or
  method and executable pairing and a Helm link's `collectorEnv` fields;
  `"operator"` for the catalog's binaries and allow-lists, the
  templates, the endpoint, the group's id, the collector version and the
  quoted values, and every Helm field but `collectorEnv`'s: the image, the
  endpoint, the group's id and settings, the token); any other error
  inside the Helm builder at error by its name only, no stack (its input
  holds the bearer), also `503`; an unexpected error elsewhere at error
  with its stack, answered `500` with generic words; the request log's
  line redacted (below).

**The Helm values link: a bearer in a public download.** A Linux link's
bundle is tokenless, but **one link kind carries a bearer**, the Helm
values link: whoever holds a Helm values link downloads a `values.yaml`
holding the fleet's default token, which never expires, so the link is as
sensitive as that token. What holds:
- **The link is a quick-deploy link**: its secret (`tqd_`, hashed, shown
  once), its path (`/api/v1/quick-deploy/{secret}`, so the redaction below
  covers it unchanged), its limits, lifetimes, Extend and Revoke, its
  typed values sealed; its choices `{kind: "helm", role, release,
  namespace, envNames}` come from the server's state at its making, never
  the browser's, and hold no value or secret.
- **Made only by the Quick Deploy click** (never at the opening of a
  view), only for a Kubernetes-supervisor fleet's group
  (`installable`'s `"helm"` path; a server fleet's group `409
  fleet_type_not_installable`), its settings readable, its variables
  offered and carried by the chart, with a valid default token and the
  organization's switch on (below).
- **The public route's Helm reply** (`quickDeployHelmValues` in
  `modules/fleets/service.ts`): after the public download's checks and the
  switch, the group's **current** Helm facts (`helmFactsOf`), the stored
  variables still offered and carried (else `409
  collector_group_variables_changed`), the values opened, then the link's
  default token's bearer **revealed last**, once nothing else can refuse,
  **with no actor** (the opamp-server's `viewed` event names no person;
  revoked, expired or unknown `410`), built by the contracts'
  `helmValuesYaml` (ASCII scalars; backstops that name a field, never a
  value). `200` `text/yaml; charset=utf-8`, `attachment;
  filename="values.yaml"`, `Cache-Control: no-store`, `nosniff`,
  `Referrer-Policy: no-referrer`; then the switch again, the counter and
  `quick_deploy_link.downloaded` `{linkId, fleetId, groupId, kind:
  "helm"}` in one transaction, failing closed. The file is never logged:
  the request log keeps no reply body, and a builder's refusal is logged
  with ids, its `source` and its field only (`HelmBuildError`), no stack,
  answered `503` (its level by its cause: above); any other error there at
  error with its name only, also `503`. The reveal's per-person limit
  doesn't apply (no person); the per-IP and per-link limits do.
- **The command** (`helmQuickDeployCommand`, contracts): the link on curl's
  standard input (`-K -`), never on its command line; the download in a
  `( umask 077 && … )` subshell, so `<release>-values.yaml` is created
  0600 and the person's umask is left as it was; `&&` before the install,
  so a refused download runs no `helm`.

Residues of the Helm values link. **The link alone yields the default
token.** **A values file already downloaded keeps the token after the
link's revoke**: only a new default token takes it back (Install Links'
help and the revoke's words say so). **Each download is a reveal with no
actor, and the reveals pile up**: a `viewed` event, "Revealed" with no
member in the Tokens tab's History. The opamp-server limits no management
reveal (its limiters are on the agent listener only) and keeps every
`viewed` event; the platform's limits are in memory per API process (30 a
minute per address, 60 a minute per link); and a fleet's links (at most
100 active) all carry its one default token, so that token can be revealed
up to 60 a minute for each active link, per API process. One is left
behind when the counter's write then fails. **A reveal before a switch-off
mid-render**: a download already past the switch's first read when an
admin turns links off has revealed the bearer before the counter's re-read
refuses it `403`, nothing served. **`curl -o` keeps an existing file's
mode**: the umask sets only a new file's (the screen says to delete the
file once the release is installed). **A link's path spelt otherwise** (a
trailing slash or an extra segment, a `HEAD`, or `/API/…`) is answered by
the API's generic JSON `404` or the CSRF `403`, not the public route's
plain text and headers; its body and the logs hold the secret redacted, so
nothing leaks. The Quick Deploy command, the link's secret in it, stays in
the shell's history, as a Linux link's does.

**The organization's switch, "Public install links"**.
`organizations.public_install_links_enabled` (migration
`1700000000033_public_install_links`, `boolean not null default true`)
governs both link kinds. Any member reads it (`GET
/api/v1/organizations/{organizationId}/settings`); **only an admin changes
it** (`PATCH`, CSRF as every `PATCH`): `assertAdminRole`, then
`lockAsAdmin` in the write's transaction as a rename does, so an admin
demoted while the change waits on the lock is refused `403`; the active
organization only (another's is `404`); the value it already has writes
and audits nothing; a change is **audited**
`organization.settings_changed` with the member and
`{publicInstallLinks}`, its value only. It is **read in the transaction
that acts on it**: a link's create reads it `for share` with the
organization (`findSettingsForShare`, `409 public_install_links_disabled`
while off), so an admin's change and a create wait on each other; the
public download reads it with the link (off: `403` plain text "Install
links are turned off for this organization.", after the `410`s and before
the render slot, counted by the per-IP and per-link limits only, never by
the download count, never audited) and again `for share` in the counter's
transaction (off there: `403`, nothing served or counted). While it is off
the links stay listed and work again once it is on, unless expired or
revoked; the signed-in downloads (the bundle, the container command,
Download values.yaml) are unaffected. The install dialogs read it at their
opening only to hide their link buttons (a failed read counts as on); the
API's refusals are the guard.

**A link's secret is cut from the logs, but for the residues below**,
since it is in the URL's path. The exceptions: nginx's error log keeps one
in an ordinary path's query or Referer when that path's upstream fails; a
spelling nginx doesn't decode, which only a client crafting the URL sends,
is logged as sent (by the gateway, and by the API's request log on any
path but the download's or a `/quick-deploy` path); and a load balancer
the platform doesn't configure logs the link as sent. The web server
writes no request's URL or path ("Kubernetes", below).
- **The API's request log** (`http/request-log.ts`): a request whose
  matched route is the download's, or whose path in any spelling the log
  checks (as spelt, percent-decoded once, runs of `/` made one) holds a
  `/quick-deploy/` segment or ends in `/quick-deploy`, or whose whole URL
  holds `tqd_` (a secret pasted into another route's query, or after a raw
  `#`), case aside, is logged as `/api/v1/quick-deploy/[redacted]`, query
  and all. The links' own routes (`/quick-deploy-links`) hold only ids and
  are logged in full. The `404` handler's reply names the URL through the
  same rule (a secret, an OIDC callback's query or a fleet route's is
  never echoed), and framework errors log their code only.
- **The gateway** (`docker/gateway/default.conf`): `access_log` with its
  own `log_format telflo`, the image's `main` but for two fields. The
  request field is `"METHOD /api/v1/quick-deploy/[redacted] PROTOCOL"` for
  a request whose decoded, normalized `$uri` holds `/quick-deploy/` (or
  ends in it) or `tqd_`, or whose raw request line holds `tqd_` with any
  of its letters percent-encoded once or not; the referer field is
  `[redacted]` for a Referer holding either (a page opened from a link
  refers to it). A `/quick-deploy` path typed without `/api/` (a
  `/quick-deploy/` segment or a path ending in `/quick-deploy`, in any
  spelling nginx routes: case aside, escapes decoded, runs of `/` merged,
  dot segments resolved) is answered by nginx itself, `404` "Not found."
  in plain text (`Content-Type: text/plain` whatever the path's extension:
  `types { }`), and never proxied: the web server's request log (below)
  never sees one. nginx's error log quotes the request line and the
  upstream's URL when an upstream fails and its format can't change, so
  the quick-deploy paths' locations (`^/api/…` to the API, that `404`, a
  web path holding `tqd_` to the web app) log only `crit`.
  `scripts/check-gateway-logs.sh` runs the committed file in the real
  `nginx:1.27-alpine`, upstreams up and down, the web stand-in counting
  its requests and nginx's own `404`s checked for their content type
  (`docs/conventions/testing.md`).
- **Analytics** (`apps/web/app/lib/analytics.ts`): any URL or path that
  may hold a secret is replaced whole by
  `<origin>/quick-deploy/[redacted]` in every property, replay's pages and
  recorded requests; an autocapture event whose `$elements_chain`,
  `$el_text` or any `$elements` entry's text or `attr__…` value may hold
  one has the chain, if sent, replaced by a fixed one and the other two
  dropped; PostHog never starts in a document whose address or referrer
  may hold one (below).

Residues of quick-deploy links. **A load balancer, CDN or proxy the
platform doesn't configure logs the link's path as sent**. **nginx's error
log for an ordinary path** still quotes a secret pasted into its query or
Referer if that path's upstream fails, and nginx's own upstream
diagnostics are given up for the quick-deploy paths. **Spellings nginx
doesn't decode**: a prefix percent-encoded twice (`%2574qd_`), or a
hand-encoded `quick-deploy` in a Referer whose prefix is cut off, is
logged as sent. The API's request log, which reads a spelling as sent and
decoded once, also keeps a doubly encoded prefix on any path but the
download's route or a `/quick-deploy` path, routed or not (but in a query
it drops anyway: an OIDC, configurations-list or fleet route's), and the
no-route `404`'s reply echoes it to its sender (`apps/api/src/errors.ts`).
Only a client crafting the URL sends one, and analytics catches both.
**posthog-js's storage** would hold the page's address and referrer before
any `before_send`, so PostHog never starts in such a document; a
sign-out's reset isn't applied there and feature flags read false. **The
copied command stays in the host's shell history**, bearer and secret, as
the signed-in install's command does. **The download's audit rows keep the
requester's IP and user agent forever**, as every audit row is kept, and
expired links are never cleaned up.

A residue of both kinds of link, in development and the browser tests
only: **Vite's development server** proxies `/api` to the API
(`apps/web/vite.config.ts`), and when it can't pass a request on it prints
the request's full URL to its terminal (Vite's `http proxy error: <url>`),
so a quick-deploy or library link fetched through the development or
browser-test web server while the API is down or restarting is printed
there. No container stack runs it: the gateway proxies `/api` there.

Residues, recorded. **A fleet's create with an id another organization's
fleet holds answers `409 fleet_conflict`** (whichever organization holds
it), so a person can learn that some organization has a fleet with an id
they chose: one bit about a random UUID, accepted: fleet ids are unique
across organizations, so any answer but a success says the id is taken.
**Nothing bounds the memory of large replies across the API process**: a
10 MiB collector page takes about 38 MB while the platform reads, parses
and answers it, and a person may hold 16 at once in each organization. **A
path spelt with a `/./` dot segment, a backslash, another letter case, a
double-encoded slash or a `%23` keeps its query in the API's request log**
(accepted): such a path matches no route (the router is case-sensitive and
decodes once), the rules above don't normalize it, and a browser
normalizes dot segments and backslashes before it sends a request while
nothing in the platform builds the other three, so only a client crafting
the path sends one. A raw `#` in a request target does reach a route (the
router ends the path at a `#` as at a `?`), so the request log cuts there
too. And the API's `404` for a path that matches no route echoes the URL
in its reply to the caller (`apps/api/src/errors.ts`), as the request log
spells it (`loggedRequestUrl`: a quick-deploy secret's path redacted, the
OIDC, configurations-list and fleet routes' queries dropped), any other
route's query included.

**In the browser**. A new fleet's two bearers live only in the create
dialog's state and are shown inside a `ph-no-capture` box
(`telflo-core/apps/web/app/components/secrets/SecretCopyBox.tsx`, shared
by the screens that show a secret once and kept out of `components/ui/` so
nothing that replay should see reuses it), as the text of a `<code>` with
its Copy button inside the box, so replay records nothing of it and
autocapture skips the click. A bearer never reaches a toast (a refused
clipboard toasts fixed words), a URL, browser storage, an attribute (the
button's name is "Copy default token" or "Copy rotate token") or an
analytics property; Done clears the state before it opens the fleet's
page. Both fleet pages' titles are fixed ("Fleets - Telflo", "Fleet -
Telflo"), since posthog-js sends `document.title` with each page view and
replay records `<head>`, outside `ph-mask`; a fleet's label likewise never
goes in an attribute but an open dialog's Name input's `value`, which
replay's `maskAllInputs` masks. The fleet routes' queries (the list's
`status` and cursor) are never put in a page's URL: the pages carry ids
and `?tab=` only.

**In the browser, a server fleet's collectors**. A collector's reported
attributes and its error text (the details' Error row and its error
history) are shown only inside `ph-no-capture` elements, as text, never in
an attribute or a toast (a refused clipboard toasts fixed words). No
collector, group or fleet name, and no IP address, goes in an
`aria-label`, `title`, `alt`, placeholder, `data-*` attribute, URL or
analytics property (never an IP in a `title`): a row's buttons and
checkbox are named through `aria-labelledby` pointing at hidden text
("Edit {name}"), and names and addresses are text in the masked shell. The
grid's search box is uncontrolled (`defaultValue` and a ref read on
Enter), so what is typed never becomes its `value` attribute; the search,
the Group filter, the sort and the page stay out of the URL. A Radix
`Select`'s item values are ids or fixed sentinels (the Group filter's
`"all"`; the Pin choices `"follow"`, `"version"` and `"orphan"`), never
names: inside a `<form>` Radix writes them into a hidden native
`<select>`'s `<option value>`. The named exception is an input whose
`value` replay's `maskAllInputs` masks: an open dialog's Name input. The
details' error `<pre>`s (the Error row's and each message's in the error
history, each at most 12rem tall and scrolling) are focusable
(`tabIndex={0}`), so a keyboard can scroll them, and no attribute names or
quotes their text: each is named by the fixed words "Error message" (each
a "group", so the name counts, which adds no landmarks). The other
accessible names the screens add hold no private text either: the
selection bar is the region "Selected collectors", its buttons "Pin
selected collectors" and "Delete selected collectors".

**In the browser, a server fleet's groups and tokens**. A bearer is shown
at two moments only, a rotation's result (the new rotate token's) and a
reveal (either token's, one `POST …/reveal` per opening and one per Try
again after an unknown outcome, each recorded in the token history), each
time in a `SecretCopyBox` inside `ph-no-capture` ("Copy rotate token",
"Copy default token"), as text. It lives only in that dialog's state and
leaves it as the dialog closes, and it never reaches a toast, an
attribute, a URL, browser storage, the page's title or an analytics
property. A group's or configuration's name, a fleet's label, a version's
label and a member's email are visible text in the masked shell only,
never an `aria-label`, `title`, `alt`, placeholder or `data-*` attribute:
the rows' buttons are named through `aria-labelledby` pointing at hidden
text ("More about {name}", "Assign {name}", "Edit {name}", "Delete
{name}"; a token's by its kind and creation, "Reveal the rotate token
created {date}", with no names), and a group's published version links to
the editor by ids alone (`/editor/{configurationId}/{versionId}`), with no
`title`. The History's By column is the member's email as plain text,
never a link ("—" for none). The group dialog's `Select` item values are
ids or fixed sentinels: its assignment choice `"version"`, `"nothing"`,
`"orphan"`, the version picker's configuration and version ids; the
rotation's presets are native radios valued by their ids; never a name;
the named exception is an open dialog's Name input, masked by
`maskAllInputs`. The page's title stays "Fleet - Telflo", the tabs put
nothing in the URL but `?tab=groups` and `?tab=tokens`, and they send no
analytics event of their own.

**In the browser, installing collectors**. The install's bearer is the
fleet's **default token**, revealed afresh (`POST …/tokens/{id}/reveal`,
audited `viewed`, one per opening of the install dialog, shared by the
container command and the Linux token screen); no token is minted for an
install. An install command holding it is the same secret: it is built in
the browser from the install's facts (no bearer) and the reveal, and shown
only in a `SecretCopyBox` inside `ph-no-capture` (the container's "Copy
command", the Linux token screen's "Copy commands"), as text. The masked
preview (`containerPreview`, which takes no bearer) and the token screen's
lines before its Reveal hold `••••••••••••••••` in its place. The reveal's
click hands one chain to the clipboard (Safari's rule), which throws once
the dialog has closed or the organization has changed, so a late reveal
never reaches the clipboard; the clipboard gets the command only through
that chain or the box's copy button. The bearer lives in the dialog's
state only and leaves it as the dialog closes; it never reaches a URL, a
toast (a refused copy toasts fixed words), browser storage, an attribute,
a log, an error or an analytics property. A new default token's bearer
(the Tokens tab's "New default token") is shown the same way, once, in its
dialog's `SecretCopyBox` ("Copy default token"), and leaves as it closes.
The values typed for an install (the display name, the root and executable
paths, the configuration's variables' values), the variables' names and
the group's mounts' paths are configuration text: inside `ph-no-capture`,
never in an attribute but an input's own `value`, never stored; the rows'
ids are `useId`'s and indexes, a mount's Remove is named by its number,
and a group's Install by "Install into {name}" through `aria-labelledby`.
The bundle's file name holds the method and the arch only. No analytics
event is added.

**In the browser, Quick Deploy and Install Links**. A Quick Deploy command
holds the fleet's default token's bearer and the link's secret: the same
secret as an install command. It is built in the browser from the create's
reply (`{link, url}`, the `url` the one copy of the secret, `no-store`)
and the reveal of the link's default token (audited `viewed`), by the
contracts' `quickDeployCommands`, and shown at one moment only: the Quick
Deploy screen, after "Reveal & copy command", in a `SecretCopyBox` inside
`ph-no-capture` ("Copy command"), as text. Before the reveal the screen
shows `quickDeployPreview`, which takes no bearer and masks the secret
(`••••••••••••••••`, `tqd_••••••••`). The reveal's click hands one chain
to the clipboard (Safari's rule), which throws once the dialog has closed
or the organization has changed; a link's create answered after a close is
dropped (the link stays listed, and expires). The `url`, the bearer and
the command live in the dialog's state only and leave it as the dialog
closes (the screen's title, words and masked preview kept through the exit
animation, its Reveal disabled once the `url` is gone); none reaches a URL
the app navigates to, an `<a href>` or any attribute, a toast (a refused
copy toasts fixed words), browser storage, a log, an error or an analytics
property. In the command itself neither secret is on a process's command
line on the host (the link reaches curl on its standard input, the bearer
`opamp.env` from the subshell's environment), and the token is exported
only inside the command's subshell, never in the environment of the
person's shell; the command does stay in the shell's history once pasted
(a residue, as the signed-in install's command does). It needs a
POSIX-style shell (bash, sh, dash or zsh). Pasted into an interactive csh
or tcsh, which runs each line of a paste that parses, no line of it runs:
the `(` line and the last line (which the subshell's `)` closes) hold an
unbalanced paren, each command's line between ends in a dangling ` &&`,
and the systemd unit's text lines fail for their own reasons ("No match.",
"Command not found."; checked with a real tcsh and csh through a pty);
fish isn't checked (not installed). curl retries only a transient failure
(`--retry 3`: a timeout, `408`, `429`, `500`, `502`, `503` or `504`,
honoring `Retry-After`), never a refusal (`404`, `409`, `410`); each try
counts toward the per-IP and per-link limits. A refused reveal on the
Quick Deploy screen reads the tokens again and says "This link's token was
revoked: make a new link." when another valid default token exists, never
naming a token. **Install Links** holds no secret, hash or value: a row
shows the member's email and the group's name as text in the masked shell;
View shows the paths and the variables' names (each "set", never its
value) inside `ph-no-capture`; the rows' actions are named through
`aria-labelledby` by the link's creation only, to the second ("Extend the
install link created {date and time}"), never a name, a path or an email;
each dialog is keyed per opening on a snapshot of its row; Extend's
presets are native radios valued by their ids. **Analytics** never sees a
link: a URL or path that may hold a secret (`tqd_` however spelt, or a
`/quick-deploy/` segment) is replaced by
`<origin>/quick-deploy/[redacted]` in every event property, replay's page
addresses and recorded requests; an autocapture event's `$elements_chain`,
`$el_text` (sent whole, where the chain keeps an element's first 400
characters) and `$elements` entries' text and `attr__…` values are each
checked, and when one may hold a secret the chain, if sent, becomes a
fixed one, `$elements` and `$el_text` dropped; and PostHog never starts in
a document whose address or `document.referrer` may hold one, decided once
per document (posthog-js would store both in its own localStorage and
`ph_…` cookie before any `before_send`). No analytics event is added.

**In the browser, a Kubernetes fleet's page and groups**. A Kubernetes
group's namespace, a gateway's name, a volume's host and mount paths, a
collector's node name (its reported `k8s.node.name`) and the text typed to
confirm a group's delete are configuration text, as a server group's
mounts' paths are. In a dialog's fields and in a group's details they sit
inside `ph-no-capture` (`KubernetesGroupDialog`'s gateway name, namespace,
replicas, namespace warning and the gateway's in-cluster address;
`VolumesEditor`'s rows; `KubernetesGroupDetailsDialog`'s Group, Namespace
and Volumes), in no attribute but an input's own `value`, which replay's
`maskAllInputs` masks; elsewhere they are visible text in the masked shell
only (the Groups table's Group and Namespace columns, the Collectors
grid's Group column and filter, a dialog's title). None goes in an
`aria-label`, `title`, `alt`, placeholder, `data-*` attribute, URL, log
line, error, audit row or analytics property (the API's refusals of them
are fixed words: "A group's annotations are checked against its fleet's
type" above). The Groups table's rows are keyed by group ids, the
Cluster's by its role (stable across its first Assign), never a name, and
their buttons are named through `aria-labelledby` pointing at hidden text
("More about {Agent | Cluster | the gateway's name}", "Assign …", "Edit
…", "Delete …"); the Group column's role badges have help popovers
labeled by fixed words ("What is an Agent?", "What is a Cluster?", "What
is a Gateway?", since `HelpPopover` puts its label in an `aria-label` and
a `title`), and the Agent's line under Volumes is fixed words; a volume's
Remove is named by its number ("Remove volume {n}"), the rows' ids are
`useId`'s and indexes, the placeholders are fixed ("traces-sampling",
"telflo-collectors", "/var/log/app"), and the Type select's values are the
four hostPath types. The typed confirmation of a group's delete (both
fleet types) is an **uncontrolled** input inside `ph-no-capture`, so no
`value` attribute ever holds the text, empty at each opening; its label,
"Type {name} to confirm", shows the group's name as bold visible text
inside the same `ph-no-capture`, and the input has no placeholder (one
holding the name would be an attribute replay records), so the name
reaches the input's accessible name only as the label's text. A
collector's details show the Node row's value inside `ph-no-capture`, with
its other reported attributes. The page's title stays "Fleet - Telflo",
the tabs put nothing in the URL but `?tab=`, and no analytics event is
added.

**In the browser, the Helm install**. A Helm `values.yaml` holds the
fleet's default token's bearer: the same secret as an install command. It
is built in the browser at the Download click, from the group's Helm facts
(no bearer), read again with the tokens, and the reveal of the valid
default token (`POST …/tokens/{id}/reveal`, audited `viewed`), by the
contracts' `helmValuesYaml`, and handed at once to `downloadBlob` as a
`text/yaml` Blob (an anchor never appended to the page, its object URL
revoked); the bearer and the file are locals of the click's chain, never
in state, a URL the app navigates to, an attribute, a toast, browser
storage, a log, an error or an analytics property. Each download is named
`<release>-values-<8 hex>.yaml`, its fragment fresh from
`crypto.getRandomValues`, so the printed command reads exactly that file.
The command screen names that file in its two sentences (where it was
saved, and the warning to delete it) as text inside a `ph-no-capture`
span, the rest fixed words: the name holds the release, so a gateway's
name. The commands, the install command (no secret), the Quick Deploy
command (the link's secret), each `helm uninstall` line (a collector's,
the bulk delete's, a group's) and **the namespace warning's command**, are
shown only in a `SecretCopyBox` inside `ph-no-capture`, as text, their
copy buttons named by fixed words ("Copy install command", "Copy command",
"Copy uninstall command", "Copy uninstall commands"). **Helm Quick Deploy
is one click, with no reveal**: the link's create, then its command shown
once (the create's `url`, the one copy of the secret; the bearer comes
with the link's download); the command leaves the state as the dialog
closes (a test finds the secret in the state before Done and nowhere in it
after the close). The namespace warning's command and every uninstall line
name the release in the namespace the dialog's opening derived
(`releaseNamespaceOf`, which follows the API's `helmFactsOf` step for
step: the saved one, or the Agent's default `telflo-collectors` while none
is saved; and none at all where the facts refuse, so no line for
unreadable settings, a Cluster or gateway without settings, a stored role
that isn't the group's or a gateway whose name fails
`gatewayNameProblem`), so an Agent installed before its first save gets
its `helm uninstall` too, inside the same `ph-no-capture` box, and the
warning's sentence never shows without its command. The group's release,
namespace and a gateway's address are text inside `ph-no-capture`; the
variables' names and typed values as an install's (inside `ph-no-capture`,
in no attribute but an input's own `value`, never stored); the Group
select's values are ids (the Cluster's its role), never names; a row's
Install is named "Install {name}" through `aria-labelledby`; the dialog's
title is fixed ("Install with Helm"). Install Links' View shows a Helm
link's release and namespace inside `ph-no-capture`. The switch's card
holds fixed words only. No analytics event is added.

## Publishing the chart and the image

The images and the charts are published by two workflows, each publishing
step one of these scripts, with the job's own `GITHUB_TOKEN` ("The release
pipeline" below; `docs/releasing.md`): `scripts/publish-chart.sh` (a chart:
`charts/supervisor-collector`, to
`oci://ghcr.io/telflo/telflo/charts/supervisor-collector`, or
`charts/telflo`) and `scripts/build-collector-image.sh` (a collector image,
to `ghcr.io/telflo/telflo/collector`). Each script builds into a file and
pushes exactly that file (`--build-oci`/`--push-oci`,
`--package`/`--push-package`); `--push` and the image's `--replace` are
refused; the registry's answers come from `crane` (`crane digest`, `crane
manifest`). The packages are under `ghcr.io/telflo/telflo/` and are
**public**, and every install pulls them anonymously: they hold no secret
(the image is generic; the chart's values come from each install). A new
package starts private until a maintainer changes its visibility once.

**What the public packages show:** the chart is HEAD's
`charts/supervisor-collector` minus `tests/`, with no credential, host,
address, e-mail or key in it (`token`, `secret` and `password` only as
names, their defaults empty). Each image holds the Debian base, `curl` and
`ca-certificates`, the two upstream binaries, `entrypoint.sh` and the `nop`
`otelcol-config.yaml`; its environment `PATH` only; no `USER` (it runs as
root, a known limit); its history the upstream URLs and sha256s; and its
labels `title`, `description`, `version`, `source`
(`https://github.com/telflo/telflo`) and `revision` (the commit it was
built from).

**A registry credential is a secret like a bearer**: a GitHub CLI token, a
registry's push or pull token. It is never on a command's argv, in a file
of the repository, a log, a report or printed.

**The scripts never log in** (their tests check that no line of theirs runs
a `login` and that no call they make is one). They read and write the
registry with the caller's `DOCKER_CONFIG` and, for the chart,
`HELM_REGISTRY_CONFIG`: the configuration that holds the caller's login.
When either is unset, a temporary one holding no login
(`{"auths":{"telflo-publish.invalid":{}}}`, mode 0600) is used instead,
because Docker and Helm ask the macOS keychain's credential helper when
their configuration holds no auth at all (Helm calls
`docker-credential-osxkeychain`): **no credential helper is ever
consulted** by a script on its own. **A file the caller names is checked
first**, before any `docker` or `helm` call, and refused (exit 1, naming
the variable and the file, never printing its content) unless it is a
readable JSON object whose `auths` object is non-empty (Docker and oras ask
the keychain's helper when `auths` is empty) and has no `credsStore` or
`credHelpers` key in any spelling (Go's `encoding/json`, which Docker and
oras use, matches keys without regard to case: `CredsStore` and
`credsstore` count) and no other spelling of `auths`. The image's check
runs under `--build-oci` and `--push-oci` only: a local build uses the
caller's own Docker configuration (`~/.docker`), as ordinary Docker does,
and its base image's pull may consult Docker Desktop's helper.
`publish-chart.sh` also unsets every other `HELM_*` setting and keeps
Helm's cache, config and data homes and `KUBECONFIG` in its temporary
directory, removed on exit.

**A push by hand logs in to a temporary configuration**: in a temporary
directory (0700), a Docker `config.json` and a Helm registry file seeded
as above (mode 0600), and refusing stand-ins for
`docker-credential-osxkeychain`, `-desktop` and `-ecr-login` first on
`PATH` (each logs its first argument only, never reads its input, exits
1); `gh auth token` piped to `docker login ghcr.io --password-stdin` (the
token never on argv), which stores the login unencrypted in that
temporary `config.json`, and to `helm registry login ghcr.io
--password-stdin` into the temporary registry file. After the logins both
files are checked: `auths` naming only `ghcr.io` and the seeded
placeholder host, no `credsStore` or `credHelpers` key, mode 0600. The
script's push runs with `DOCKER_CONFIG` (and, for the chart,
`HELM_REGISTRY_CONFIG`) pointed there; then `docker logout ghcr.io` and
`helm registry logout ghcr.io`, after which both files hold only the
placeholder host, and the directory is removed. The person's own
`~/.docker`, Helm configuration and macOS keychain are never addressed;
if anything would reach the keychain, the person runs that step by hand
instead. Nothing is pasted into a session, so nothing needs revoking
afterwards.

**What the scripts refuse**, before any build or push, in the dry run too
(the image's in `--build-oci`'s dry run and `--push-oci`):
- **A published version again.** The chart asks the registry first
  (`crane manifest`): present is refused (a published chart version is
  never overwritten: a change is a new version, the contracts'
  `DEFAULT_HELM_CHART_VERSION` bumped with it), but `--push-package` skips
  a version whose chart layer is the file's own sha256 (a re-run);
  `MANIFEST_UNKNOWN` or `NAME_UNKNOWN` is absent; any other answer makes
  the push refuse and the dry run say it can't tell. The image asks the
  same of `crane digest <tag>`: a tag holding the archive's digest is
  skipped (a re-run), one holding another digest is refused, nothing
  pushed. There is no `--replace`: a published tag's bytes never change.
- **The old registry paths.** The chart refuses a reference under
  `oci://ghcr.io/telflo/charts/`; the image's `--build-oci` and
  `--push-oci` refuse `ghcr.io/telflo/collector` (they name only
  `ghcr.io/telflo/telflo/collector`, or a loopback registry's).
- **Uncommitted inputs** (what is published is exactly what is
  committed). The chart refuses, in every mode, uncommitted changes in
  `charts/supervisor-collector`, the contracts' `helm.ts` or the script
  itself; the image's `--build-oci` and `--push-oci` refuse changes in
  `docker/collector-image`, the catalog or the build script (its
  `revision` label is HEAD), and any catalog but the repository's. Both
  count untracked files even where the repository's
  `status.showUntrackedFiles` is `no` (`git status --porcelain
  --untracked-files=all`), and refuse an input flagged assume-unchanged or
  skip-worktree (`git ls-files -v`), whose changes `git status` would not
  show.
- **Someone else's checkout:** a tree that isn't a git checkout, or whose
  git top level isn't the script's own repository (a copy nested inside
  another repository, which could ignore it).
- **A chart that disagrees with the platform**: `Chart.yaml`'s name not the
  last segment of the contracts' `DEFAULT_HELM_CHART_REFERENCE`, or its
  version not `DEFAULT_HELM_CHART_VERSION`. Its render tests and `helm lint
  --strict` run before it packages.

**What is published is HEAD's own bytes**, never the working tree's: the
chart (`--package` and `--dry-run`) and the images' build contexts
(`--build-oci` and its dry run) are HEAD's raw blobs under
`charts/supervisor-collector` and `docker/collector-image`, listed by `git
ls-tree -r -z --full-tree HEAD` and written by `git cat-file blob` into the
script's temporary directory, so no ignored or untracked file is packaged
or built, and no local attribute, filter or line-ending setting alters a
file (as `git archive`'s output would: a local smudge filter's text would
reach the pushed files that way). A symlink, a submodule or any mode but a
regular file's is refused, naming its path; the executable mode is kept.
Every inherited `GIT_*` setting is unset first (`GIT_DIR`,
`GIT_INDEX_FILE`, `GIT_CONFIG_*`: none chooses the repository, index or
configuration git reads), `GIT_NO_REPLACE_OBJECTS=1` is set (a local `git
replace` never stands in for HEAD's object), and each file written must
hash to its tree entry (`git hash-object --no-filters -t blob` equal to the
`ls-tree` sha), else the script refuses ("doesn't hash to its tree entry:
refused (a local substitution of git objects)"): a replaced or tampered
object is refused, never published. The image's build arguments come from
HEAD's catalog blob too. A swapped tree object is the one thing the
scripts don't check; `git fsck --no-dangling` sees it.

**The chart's `checksum/token` annotation** is the sha256 of the rendered
token Secret, whose secret is the sealed bearer: a hash of it, never the
bearer, readable by whoever can read the pods. The bearer is high-entropy
(each reveal seals it afresh with a new nonce), so the hash reveals nothing
usable; it changes with every download, which is why each Install with Helm
again restarts the group's pods.

**The packages are the platform's alone:** the old registry paths
`ghcr.io/telflo/collector` and
`oci://ghcr.io/telflo/charts/telflo-supervisor-collector` aren't this
repository's and are never written by the platform's scripts, which
refuse them (above); the platform's are under `ghcr.io/telflo/telflo/`.

**A variable named by a YAML word** (`ON`, `yes`, `null`) is offered for
Helm like any other since the chart quotes `collectorEnv`'s keys; its name
and its typed value are configuration text under the rules of "In the
browser, the Helm install" above.

**Pulling the opamp-server's image.** The stack runs
`ghcr.io/telflo/opamp-server` at the public release
`vendor/opamp-server/PIN` names, so pulling it needs no login and no
registry token. The pull still proves the PIN's digest (the image's
`RepoDigests`, and its `revision` label equal to the PIN's commit, which
the drift check then compares whenever the image is local). No registry
token is put in a cluster for it (the kind smoke pulls on the host and
loads the image). The platform's own images take no pull Secret by default
either (both `imagePullSecrets` lists are `[]`); a pull Secret is added
only for a registry of the operator's own that needs a login ("The pull
secret" below).

## The Compose install

The install itself is described in `docs/compose.md` and in
`deploy/compose/setup.sh`'s header (which hold the details: this section
only names what must stay true).

- **Modes:** `setup.sh` writes `.env` with mode 0600 and `secrets/` with
  mode 0700, its files 0644 (Compose mounts a secret as it is, and each
  service reads it as its own user; the 0700 folder keeps everyone else
  out).
- **Refusals:** `setup.sh` refuses to write any of the development stack's
  public secrets (it holds their sha256 only;
  `scripts/release/check-compose-install.sh` checks the list is complete),
  refuses to run when `.env` or `secrets/` exists (it never overwrites, so
  never makes new secrets over an existing database), and refuses an http
  `--public-url` on any host but `localhost`, `127.0.0.1` or `[::1]`.
- **Ports:** only the gateway and the agent endpoint are published, both on
  `TELFLO_BIND_ADDRESS` (127.0.0.1 unless `--bind` says otherwise).
  Mailpit, only under its profile (`setup.sh --mailpit`), is published on
  127.0.0.1 alone, never on the bind address. The opamp-server's
  management API and the database are never published.

The archive smoke (`scripts/smoke-compose-install.sh`) checks the modes,
the ports and that no development secret was written, on every release.

## The release pipeline

The steps for whoever releases are in `docs/releasing.md`.

Two workflows publish, and nothing else does:
`.github/workflows/release.yml`, on a `v*` tag (the five platform images,
the chart `telflo` and the GitHub Release), and
`.github/workflows/collector.yml`, started by hand (the collector images and
the supervisor-collector chart). Every step of either is tool setup, moving
artifacts, or one call of a committed script, so each rule below is held by
a script and its self-test, and `scripts/release/check-workflows.sh` (a
static gate) holds the workflow files themselves.

- **The job's own `GITHUB_TOKEN`, and nothing else.** No repository or
  organization secret, no personal token, no deploy key: a publish logs
  in to GHCR with the token GitHub makes for that job and revokes when it
  ends (`docker/login-action`; `helm registry login --password-stdin`).
  The repository's default token is read-only, and Actions may not create
  or approve pull requests (repository settings, `docs/releasing.md`).
- **Least privilege.** The top-level `permissions: {}`; each job asks for
  `contents: read` only; the jobs that check what exists add `packages:
  read` (they read the packages); only the jobs that publish hold
  `packages: write`, and only the release workflow's `publish` `contents:
  write` (the GitHub Release).
- **The triggers.** `release.yml` runs only on `push: tags: ["v*"]`;
  `collector.yml` only on `workflow_dispatch`, from `main`, its `publish`
  input false by default. No `pull_request`, no `pull_request_target`.
- **The yes.** Only repository admins create, move or delete `v*` tags (a
  tag ruleset, `docs/releasing.md`), and `scripts/release/verify-tag.sh`
  refuses a lightweight tag, a tag that isn't `v` plus `Chart.yaml`'s
  version, a commit off `main`, and a version of which anything is on GHCR
  already. Pushing the tag is the maintainers' yes to publish. The
  publishing jobs run in the protected `release` environment (admitting
  only `v*` tags and `main`), whose required reviewer, a maintainer, must
  approve each publish. A collector run with `publish: true` is a
  maintainer's yes alike.
- **Every action pinned by its full commit SHA**, its version in a
  comment, and the same SHA as the opamp-server's workflow where the action
  is the same. The repository's Actions setting allows only the selected
  actions, exactly those SHAs, with SHA pinning required, so an action
  unlisted or named by a tag can't run even from a changed workflow file.
- **`persist-credentials: false`** on every checkout: the token is never
  left in `.git/config` for a later step, a script or an artifact.
- **No `${{ … }}` inside a `run:`.** The tag, the version, the collector
  version and every other value reach a script only through `env:`, never
  pasted into a script's text (where a crafted value would run as shell);
  the tag only after `verify-tag.sh`'s pattern check, a collector version
  only one the catalog offers.
- **The publish job's registry files.** Before it logs in, the job points
  `DOCKER_CONFIG` and `HELM_REGISTRY_CONFIG` at files under `runner.temp`,
  so the logins write the token there, as plain `auths` with no credential
  store (what the scripts' credential checks accept, "Publishing the chart
  and the image" above), and the runner is thrown away after the job.
- **In a workflow, crane is `tools.sh`'s checked one only**: with `CI` set,
  `scripts/release/oci.sh` takes exactly the file `scripts/release/tools.sh
  path crane` gives, hashed again against `tools.lock`'s sha256 of the
  binary itself for the runner's platform (not only the record its fetch
  wrote), with `TELFLO_TOOLS_DIR` ignored and a `.tools` that is a link
  refused; a `TELFLO_CRANE` must resolve to that same file. `tools.sh`
  itself refuses `TELFLO_TOOLS_DIR`, `TELFLO_TOOLS_LOCK` and
  `TELFLO_TOOLS_PLATFORM` when `CI` is set. So no earlier step, `GITHUB_ENV`
  entry, `env:` or `PATH` folder can put another binary between the token
  and the registry.
- **The workflow files hold their safety steps**: `check-workflows.sh`
  checks that each job holds its safety steps in order, each by its exact
  `run:` line and `env:` values (the tag's check; the smokes' loads and the
  smokes; the pushes, the pull-back and the GitHub Release last), that no
  step carries an `if:`, that each job needs exactly its set, that the
  version job's outputs come only from the tag's check (and the collector
  archive's step), and, structurally on the parsed files: every `uses:` on
  the allow-list, pinned and commented; each action's `with:` keys from an
  allow-list (no checkout of another repository, no other run's artifacts);
  a job's keys from a fixed set (no `container:`, `services:` or
  `defaults:`); and every `env:` naming only what the scripts read, never a
  variable that changes what runs or where (`BASH_ENV`, `NODE_OPTIONS`,
  `LD_*`, `PATH`, `TELFLO_TOOLS_*` …) or a `TELFLO_CRANE` with a value. Each
  job's matrix is pinned exactly (the release's five images; the collector
  workflow's versions only from the check job's output, no `include` or
  `exclude`), and a job's own `env:` is the publishing jobs'
  `TELFLO_CRANE: ""` and nothing else. No `always()`, `failure()` or
  `continue-on-error` anywhere: the one status function is the collector
  workflow's chart job's `!cancelled()`, in one exact allow-listed
  expression that still requires the check and the publish to have passed,
  or the publish skipped for having nothing to build.
- **The GitHub Release names the tested commit**: just before it is made,
  `steps.sh github-release` asks GitHub's API again that the tag is still
  the annotated tag of the version job's commit
  (`scripts/release/github-tag.sh`, which `verify-tag.sh` uses too); the
  version job's token is unset once its API calls are done, before any
  registry read.
- **Attestations required off loopback**: `--push-oci` refuses, before any
  registry call, an archive without its SBOM and provenance for any registry
  but a loopback one (`--no-attest` is for a rehearsal on a builder too old
  to attest), and `check-workflows.sh` refuses `--no-attest` in a workflow
  file.
- **What is published is what was tested**: each image is built once into an
  OCI archive, which the test jobs and the publish all take from the same
  run's artifacts. The push checks every archive first (index.json's one
  entry is the digest file's, both platforms, the version and revision
  labels, and every blob hashed: pass 1) and asks every tag before it pushes
  any; then, for each, it checks the archive again and the unpacked layout's
  entry before `crane push`, and reads the tag's digest back. A tag holding
  another digest refuses the run, nothing overwritten; `helm push`
  overwrites a chart version silently, so `publish-chart.sh` compares the
  version's content digest with the file's sha256 first.
  `scripts/release/pull-back.sh` compares once more before the GitHub
  Release is made.
- **One run at a time.** The workflow's concurrency group, never canceled
  part way, keeps two runs of a version from both passing the "absent" check
  before either pushes. GitHub keeps one pending run per group: a newer one
  cancels an older waiting one, which must then be re-run by hand, so
  release tags are pushed one at a time (`docs/releasing.md`).
- **A published collector version is never pushed again**: the collector
  workflow refuses an explicit version already on GHCR, and `all` builds and
  publishes only the offered versions not yet there.
- **No secret is a build argument**: the provenance attestation (`mode=max`)
  records every build argument, and publishes it with the image. The only
  ones are `VERSION` and `REVISION` (and, for a collector image, the
  catalog's download URLs and sums).
- **No secret in a log, an artifact or the Release**: the smokes make their
  secrets at run time in 0700/0600 folders of `$RUNNER_TEMP`, never print
  them and write the bootstrap's set-password link to a 0600 file; all three
  (stack, archive and kind) run through `scripts/release/steps.sh`
  (`stack-smoke`, `archive-smoke`, `kind-smoke`), which pipes each one's
  output through `scripts/gates/redact.sh` and fails the job on a line it
  redacted. `scripts/release/check-workflows.sh` holds the workflow to those
  exact calls. The only artifacts are the images' archives, the chart, the
  Compose archive, `create-secrets.sh` and `SHA256SUMS`, kept 3 days: never
  a smoke's work folder or a log.
- **A bad version is deleted.** A package's visibility covers every
  version, so a version found bad is deleted from GHCR, with the
  `sha256-<digest>` tags crane leaves beside its images (the OCI
  referrers' fallback tags that point at the attestations).

## Organization variables: configuration text, never secrets

**There are no secret variables.** No secret flag, no encryption, no sealed
column, no mask: a variable's value, name and description, and a variable
group's name and description, are **configuration text**, kept in plaintext
in `telflo_opamp_server` like a published version's YAML and readable by
every member of the organization (there is no viewer role). **A secret stays
`${env:NAME}`**, set on the collector when it is installed (the install
dialogs' variables, never stored). The Variables and Variable groups pages
say so in a warning atop each: "Not for secrets. Keep passwords, tokens and
keys in environment variables (`${env:NAME}`), set when you install."; the
Variables page's adds that a test run keeps the values it used with its
results (the Variable groups page's stops there). `OPAMP_ENCRYPTION_KEY`
still seals bearers only.

**The opamp-server owns them**, as it owns the fleet model: the platform
keeps no copy and reaches them only through the management API, behind the
one secret ("The opamp-server's boundary", above). Every query filters on
the organization first and every link is a composite key carrying it, so
another organization's variable, variable group or override is a plain
`404`.

**A value is filled in literally**: the poll writes each `$` of a value as
`$$`, so a value can't open a confmap provider (`${env:…}`, `${file:…}`) in
the collector; values are single-line. The fill-in doesn't read the YAML
around a reference, so a value can still change how YAML reads an unquoted
scalar (` #`, `: `): quote the reference.

**Values are filled in before every cleanup and check**: filling them in
after the tester's rewrites would circumvent the cleanup. The test-run
tester and the validator each run their provider neutralizer, checks and
backstop on the filled-in text, so a value that adds YAML structure is
seen like the rest:

- **A test run** stores and returns its `yaml` as written (`${org:NAME}`);
  only when the text holds a live reference, the API reads the
  organization's values from the opamp-server at queue (to refuse early:
  `503 variables_unavailable`, "The organization's variables couldn't be
  reached. Try again.", or `400 filled_in_too_long`, "The configuration
  with its organization variables filled in is over 262,144 characters.",
  measured without building it) and again at dispatch, and sends the
  filled-in text to the tester alone (no filled-in copy is stored). The
  tester's `mutatedYaml` is kept as returned, values included: what ran.
  Values aren't secrets, so that is fine.
- **Validation** sends the validator only the values of the names the text
  references (`organizationVariables`: at most 150, each at most 1,024
  characters; the body cap 2 MiB, over the longest body the validator
  accepts, about 1.61 MiB (the platform's own about 1.42 MB)), and the
  validator fills them in first in `_prepare_text`, the 1 MiB filled-in cap
  counted before anything is built ("The configuration with its organization
  variables filled in is over 1 MiB.", the opamp-server's words).

**What never carries one:**

- **The opamp-server**: no log line, error message, span or audit row
  holds a value, name or description; its error messages are fixed, and
  names and ids travel only in a reply's `details` (`variable_in_use`,
  `variable_group_in_use`, `variables_undefined`, at most 100 entries with
  their totals). Replies are written with HTML escaping off (`writeJSON`).
  Its stores look a taken name up rather than raise the unique key's
  violation ("Postgres's own log", above). `handlers/privacy_test.go` and
  the management API's Postgres tests carry canaries through every route
  and refusal.
- **The platform's API** (`modules/variables`): every route's path names
  ids only, none takes a query, and every reply with a body is
  `Cache-Control: no-store`. Its log lines carry ids, the operation and a
  failure's kind, never a value, name or description: a thrown error is
  logged by its name only, and the client's misconfiguration error by its
  own message, which names the operation and the status. Its audit rows are ids only: `organization_variable.created`,
  `.updated`, `.deleted` (`{variableId, fields}`), `variable_group.created`,
  `.updated`, `.deleted` (`{variableGroupId, fields}`),
  `variable_group.override_set` and `.override_reset` (`{variableGroupId,
  variableId}`), written after the opamp-server's success. The `409`
  details it answers add the configuration, version, fleet and group
  names it looks up (each nullable: a lookup that fails leaves `null`, and
  the refusal stands). A configuration's drafts warning reads by the
  variable's id; the name never reaches a URL.
- **The web**: a value, name or description is typed or shown in a dialog's
  fields inside `ph-no-capture` (the value cells of the lists too), and is
  visible text inside the masked shell otherwise; never in an `aria-label`,
  `title`, `alt`, `placeholder`, `data-*` attribute, URL, analytics
  property, toast or page title (dialog titles and toasts are fixed words:
  "Edit variable", "Variable saved"). The Variables page's search input is
  inside `ph-no-capture` and the search runs client-side, never in a URL (no
  `?q=`). Nothing about variables goes to `localStorage`, `sessionStorage`
  or IndexedDB. The `$` picker's shared read holds names and descriptions
  only, never a value; the variable groups' shared names read holds ids and
  names only; logout forgets both (`lib/use-logout.ts`). The variable-group
  choices' Select sits whole inside `ph-no-capture`: its trigger, the hidden
  native `<select>` Radix renders beside it (its options hold the names as
  text) and its list (a portal, with its own class); its item values are ids
  or fixed choices (`components/fleets/VariableGroupChoice.tsx`).

## Account settings

Paths below are under `telflo-core/`. Settings › Account is the person's
own: its routes are under `/api/v1/auth`, run `authenticate` only, never
`requireCurrentTerms` (the terms dialog blocks the shell anyway), and take
no user id: the person is always the session's user
(`apps/api/src/modules/account/routes.ts:43-52`).

**Re-authentication, at a glance:**

| Action | Route | Needs | Audit | Email |
|---|---|---|---|---|
| Change the password | `PUT /auth/me/password` | the current password | `user.password_changed` | "Your Telflo password was changed" |
| Set a password (an account without one) | `POST /auth/password-reset-requests`, for the account's own email | the emailed link | `user.password_reset_requested` and `user.password_reset` | the reset email |
| Link Google | `POST /auth/me/identity-link-requests`, then the provider | the current password when the account has one, then the provider's sign-in | `user.identity_linked` `{provider, via: "settings"}` | "Google sign-in was linked to your Telflo account" |
| Unlink Google | `DELETE /auth/me/identities/{provider}` | a password set, and the current password | `user.identity_unlinked` `{provider}` | "Google sign-in was removed from your Telflo account" |
| Sign out one session | `DELETE /auth/sessions/{sessionId}` | the session only | `user.session_revoked` | none |
| Sign out everywhere | `DELETE /auth/sessions` | a confirm in the page; the route itself, the session only | `user.signed_out_everywhere` `{count}` | none |
| Change a preference | `PATCH /auth/me/preferences` | the session only | none | none |

A wrong current password, on any of the three routes that ask for it, is
`400 current_password_incorrect` ("The current password is incorrect."),
never `401`, which the web client reads as the session's end, and writes
`user.reauthentication_failed` `{purpose}` (`password_change`,
`identity_link` or `identity_unlink`), as sign-in audits its failures. The
verify is one Argon2id check outside any transaction, so no row is held for
its duration (`apps/api/src/modules/account/reauthenticate.ts:63-82`).

**One budget with sign-in, per address.** The three routes take the shared
per-IP bucket first (`identityPerIp`, 30 requests per 5 minutes), then,
after `authenticate`, sign-in's own per-email failure budget (10 failures
per 15 minutes), keyed by the address the session's user row holds, never by
anything in the body (`apps/api/src/http/rate-limits.ts:685-701`). One
failure is counted up front, and the route settles the request exactly once,
in a `finally`: a verified current password clears the address, as a
successful sign-in does; only `current_password_incorrect` keeps the count;
anything else (a `404`, a `409`, a `503`, a server failure, a link started
by an account with no password to ask for) takes it back. So the sign-in
form and Settings share one budget: guessing through Settings gets no more
tries than through the sign-in form.

**Changing the password**
(`apps/api/src/modules/account/service.ts:99-152`). The new password is
registration's rule (12–128 characters, not trimmed), the current one
sign-in's (1–128). An account without a password is `409 password_not_set`
("Set a password" sends the reset link instead). The current password is
verified and the new one hashed, both outside any transaction; then one
transaction:
- locks the user's row first (`lockForUpdate`; the lock order: the user,
  then token rows, then sessions);
- **rereads the hash under the lock** (`findPasswordHashForShare`) and
  refuses as `current_password_incorrect`, with the same audit row, when
  it changed since the verify (a reset or another change committed in
  between: the password verified is no longer the account's);
- sets the new hash (`setPasswordHash`, which never touches
  `email_verified_at`);
- **consumes every outstanding reset link** (`consumeAllForUser`): a link
  requested before the change, by the person or by whoever reads the
  mailbox, would otherwise replace the new password within its hour. The
  reset's own rule is the same: only the newest link works;
- audits `user.password_changed` (ids only, no metadata).

**Every session is kept**, this one included, and no cookie is set or
cleared. The person can sign out the others from the sessions list, or
everywhere. A sign-in racing the change rereads the hash `for share` before
its session starts (`apps/api/src/modules/sessions/service.ts:386-400`) and
is refused if it verified the old one. A completed reset, unlike a change,
still revokes every session.

**The sessions list** (`apps/api/src/modules/sessions/routes.ts:251-329`).
`GET /api/v1/auth/sessions` answers the caller's **live** sessions: not
revoked, and refreshed within the refresh token's lifetime
(`last_refreshed_at` after now minus `TELFLO_REFRESH_TOKEN_TTL_DAYS`, by the
injected clock), since an idle session past it can never refresh again. One
query gives the current session first, then the most recently active, at
most 100, with the exact total
(`apps/api/src/modules/sessions/repositories/session-repository.ts:277-301`).
Each item is `{id, isCurrent, signedInAt, lastActiveAt, ipAddress, browser,
os}`: `signedInAt` is the session's `created_at`; `lastActiveAt` is its
`last_refreshed_at`, set at sign-in and at each rotation, so exact to an
access token's lifetime; `ipAddress` is the IP it signed in from, written
once (null when none was recorded). **The raw user agent never leaves the
API**: our own table-driven parser
(`apps/api/src/modules/sessions/user-agent.ts`; no dependency, since
`ua-parser-js` v2 is AGPL) reads its first 512 characters with plain
substring tests, so nothing can backtrack, into fixed families (`browser`
firefox, chrome, edge, safari, opera or other; `os` macos, windows, linux,
ios, android, chromeos or other), and the strict reply schema
(`packages/contracts/src/account.ts:70-80`) holds nothing else.

**Signing out one session.** `DELETE /api/v1/auth/sessions/{sessionId}` →
`204` revokes one of the caller's **own live** sessions with the reason
`signed_out_elsewhere`, in one `update` scoped by the user and liveness and
stamped by the injected clock, and audits `user.session_revoked` (subject
the session) in the same transaction. **Another user's session, an unknown
one and an ended one are the same `404 session_not_found`**: nothing says
which. The caller's own session is `409 cannot_revoke_current_session` (Log
out is its way out). **The id is canonicalized before it is compared**: the
params schema accepts a uuid in capitals, and Postgres matches it to the
same row, so a string comparison would let the caller's own session through
as `signed_out_elsewhere` with its cookies left in place. The route
lower-cases the id with `canonicalIdOf`
(`apps/api/src/modules/organizations/service.ts:186`, the API's convention
for a request's ids) before the current-session check, the update and the
audit row; every account route that compares a uuid from a request does the
same, and the flow cookie's ids are read lowercased. A non-uuid is `400
invalid_request`, and Logout's static `/auth/sessions/current` still wins
over the parameter. The revoked browser's next request, and its next
refresh, is refused.

**Where possible, the database decides**: `revokeOwn`'s one update also
excludes the current session, `id <> $current`, which Postgres compares as
uuids whatever the spelling, behind the route's `409`
(`apps/api/src/modules/sessions/repositories/session-repository.ts:303-326`).
The same class in the organization switch (`PUT
/api/v1/auth/sessions/current/organization`) is settled too:
`switchOrganization` lower-cases the requested id before any comparison
(`apps/api/src/modules/sessions/service.ts:635-638`), so the current
organization in capitals is the no-op, with no audit row and no new access
token.

**Linking a provider from Settings.** `POST
/api/v1/auth/me/identity-link-requests` `{provider, currentPassword?}` →
`201 {authorizationUrl}` (`apps/api/src/modules/oidc/service.ts:821-880`):
- an unknown provider is the OIDC start's `404 not_found`; a provider the
  account already has is `409 identity_already_linked`;
- an account with a password must send the current one: missing or wrong,
  it is `400 current_password_incorrect`, audited and limited as above. An
  account without one (Google only) is asked nothing;
- a provider whose discovery fails is `503 provider_unavailable`;
- the reply is `cache-control: no-store` and sets the sign-in's flow cookie
  (the same name, `Path=/api/v1/auth/oidc`, ten minutes). Its signed claims
  gain `intent`, `sign_in` or `link`, and a link's carry the signed-in
  `user_id` and `session_id`
  (`apps/api/src/modules/oidc/flow-cookie.ts:120-135`). No intent (an older
  cookie) or `sign_in` is a sign-in and carries neither id; `link` needs
  both, as uuids, read lowercased; anything else is refused.

The callback checks the flow, the state, a provider's error and the
exchange exactly as a sign-in's do (a link refused there ends in
`link_failed`; a missing or unreadable flow cookie can't be known as a
link, so it gets the sign-in's refusal, `/login?error=oauth_failed`), then
takes the link branch
(`apps/api/src/modules/oidc/link.ts:112-169`), one transaction:
1. the user's row is locked first; the user must be live, and the flow's
   session live and the user's own, held `for share` so a sign-out waits
   for the link; else `link_failed`;
2. the ID token's `email` must parse and `email_verified` be the boolean
   `true` (the snapshot the card shows is one the provider verified); else
   `email_unverified`;
3. **by the provider's `sub`**: linked to another account is
   `identity_in_use`; already this account's is `linked` with nothing
   written (a double submit); this account holding another identity at the
   provider is `identity_exists`; else the link, and `user.identity_linked`
   `{provider, via: "settings"}` with the session's organization. A lost
   unique-index race is read again and mapped the same way.

**The email-authority rule is not applied to a link**: it guards matching by
email, and nothing here is matched by email. The signed-in person proves the
account (the session, and the current password when there is one) and the
provider's account (at the provider), so the provider's address may be any,
the account's or another's. Later sign-ins find the account by `sub`. The
authority rule still governs every sign-in.

A link starts **no session** and sets **no session or theme cookie**: the
browser goes to `/settings/account?link=<code>`, a fixed code (`linked`,
`identity_in_use`, `identity_exists`, `email_unverified`, `link_failed`)
and no personal data. Every refusal writes `user.identity_link_failed`
`{provider, reason, error?}` (`error` is the sign-in rows' fixed label, for
`provider_error`, `exchange_failed` and `internal_error`), whose actor is
the flow's user by the address their row holds, never the provider's. The
callback's last-resort error handler, a `429` included, reads the flow
cookie itself, writes no audit row and sets no session or theme cookie: it
sends a link to `/settings/account?link=link_failed` and anything else to
`/login` (`apps/api/src/modules/oidc/routes.ts:179-197`).

**Unlinking** (`apps/api/src/modules/oidc/service.ts:882-954`). `DELETE
/api/v1/auth/me/identities/{provider}` with the body `{currentPassword}` (a
body, so the password stays out of the URL) → `204`. No identity at the
provider is `404 identity_not_linked`. **Only an account with a password can
unlink** (`409 unlink_requires_password` otherwise: it would leave no way to
sign in). The current password is verified outside any transaction, under
the limits above; then the user's row is locked, the hash rechecked as the
change's is, the identity deleted and `user.identity_unlinked` `{provider}`
audited. The sessions are kept. An identity whose provider is no longer
configured is still listed and can still be unlinked.

**Unlinking doesn't stop a sign-in with the account's own address.** A
provider with an email-authority rule (only Google today; every other
provider has none, `apps/api/src/modules/oidc/providers.ts:102-109`) can
still sign in to the account after an unlink when the provider account's
verified address is the account's own and the provider is authoritative for
it (a Gmail or Workspace address): the sign-in finds no identity by `sub`,
matches the account by that address and links it again
(`apps/api/src/modules/oidc/service.ts:550-571`), silently, as any sign-in's
link. It gains nothing: that provider account controls the mailbox, so it
could reset the password anyway. The words say so, "If your Telflo address
is this Google account's address, signing in with Google links it again.",
**exactly when the provider re-links by email**: it is configured, and it
has an email-authority rule. One predicate decides it, the provider
registry's `relinksByEmail`
(`apps/api/src/modules/oidc/providers.ts:166-168`), and both places read it:
- the Unlink dialog, after "You can still sign in with your password.",
  from the identity's `relinksByEmail` in the sign-in methods' reply
  (`packages/contracts/src/account.ts:97-111`;
  `apps/web/app/components/settings/UnlinkProviderDialog.tsx:106-110`);
- the removed email's opening, from the same flag passed to its builder
  (`apps/api/src/modules/identity/emails.ts:229-257`).

A provider no longer configured offers no sign-in, and one without the
rule (or a Google client with another issuer) never matches by email, so
neither says the sentence.

A provider account with another address, once unlinked, never reaches
the account again: its next sign-in by that `sub` matches by its own
address, never this account's.

**The security emails** (`apps/api/src/modules/identity/emails.ts:165-257`).
"Your Telflo password was changed", "Google sign-in was linked to your
Telflo account" and "Google sign-in was removed from your Telflo account"
("Google" is the provider's configured name) go to the account's address
through the after-response runner, once the change has committed: an email
never announces a change that rolled back, and a failed send is logged and
never undoes the change; nothing is retried. They are transactional, so no
preference switches them off. Each names no provider address, no IP and no
device, and escapes every interpolated value in its HTML part. The
password-changed and removed emails end with the way back: "If this wasn't
you, reset your password" with the `/forgot-password` link, and "A reset
signs out every browser." **The linked email's only way back is the ordered
recovery**: "If this wasn't you, remove it in Settings › Account, then
choose Sign out everywhere, and change your password:" with the
`/settings/account` link, and no reset link
(`apps/api/src/modules/identity/emails.ts:203-227`). Neither an unlink nor a
reset alone recovers from a link someone else made: an unlink keeps every
session, the one that Google account started included, and a reset leaves
the identity linked, so that Google account can sign in again. **The full
recovery from a hostile link is to unlink, then Sign out everywhere**, then
to change the password if it may be known; that is why the linked email
carries no reset line, which would say a reset is enough. The removed email
also says what unlinking doesn't stop (above). **Only a change made from
Settings sends one**: a link made by a Google sign-in to an existing
password account stays silent
(`apps/api/src/modules/oidc/service.ts:368-383`). A double submit's second
callback writes nothing and sends nothing.

**Preferences.** `PATCH /api/v1/auth/me/preferences` merges in one upsert:
each group present is merged with `||` onto the stored group, and the theme
column set when given, so concurrent changes each land their own keys, the
last write winning per key
(`apps/api/src/modules/account/repositories/user-settings-repository.ts:67-92`).
They aren't security events: no audit row, no limit, `authenticate` only.
The web saves one key per `PATCH`, shown at once, and **its confirmed copy
of each key is the server's last known value**: every save's answer, taken
or overtaken, and every `/me` answer update it, and a failed save shows it
again, unless a later choice of the key is pending. Saves and `/me` reads
are numbered from one counter when they are sent, so an answer confirms a
key only when it is newer than the save that last confirmed it, and a `/me`
read sent before a save never overwrites that save's answer. A `/me` answer
is applied only when its read is the newest applied so far
(`highestReadApplied`), so an older read answered after a newer one never
overwrites it; React Router aborts a stale navigation's loader today, so
this is defense in depth (`apps/web/app/lib/stores/user-store.ts:67-110`,
`:250-270`).

**The limits of numbering at sending.** The numbers give the order the
browser sent the requests in, not the order the API applied them in, so two
orders leave a key's confirmed value stale until a later `/me` read, sent
after both, heals it:
- a `/me` read sent after a save, but read by the API before the save's
  write and answered after the save's answer: its number is the higher, so
  it confirms the value from before the save (the page still shows the
  save's value, unless a failure later restores the stale one);
- two saves of one key that the API applies in the reverse order: the
  later-sent save's answer confirms its value while the server holds the
  earlier-sent one's.

Only a preferences revision the server keeps, returned by `/me` and by each
save, would order them as the server applied them (not built yet).

**The `telflo_theme` cookie.** One word, `light`, `dark` or `navy`, nothing
personal: `HttpOnly` (only root's server loader reads it; a page learns its
theme from loader data), `Path=/`, `SameSite=Lax`, `Secure` as the session
cookies, a year (`apps/api/src/modules/sessions/cookies.ts:104-118`).
- **The API is its one writer.** Every reply that sets session cookies
  also sets the stored theme (Dark with no row): the password sign-in, the
  refresh's rotation and its grace answer alike, and the OIDC sign-in; the
  invitation registration, always a new account, sets `dark` with no read.
  A `PATCH /auth/me/preferences` carrying `theme` sets the new one.
- **It is never cleared.** Logout, sign out everywhere and a reset leave
  it (`clearSessionCookies` doesn't touch it), so the sign-in screen keeps
  the person's theme after sign-out.
- **The read on a sign-in or a refresh is best-effort**
  (`apps/api/src/modules/account/theme-cookie.ts:16-44`). It runs after
  the session cookies are set, outside the rotation's transaction, and any
  failure logs a warning with the user's id only (never the error, whose
  text could name a value) and sets nothing. A thrown read would answer
  `500` without the new refresh cookie, and the browser's next refresh,
  past the ten-second grace, would revoke the session as a reuse.
- **The web reads only the word.** Root's loader
  (`apps/web/app/root.tsx:38-40`) passes the first `telflo_theme` in the
  `Cookie` header through contracts' `themeFromCookie`
  (`apps/web/app/lib/theme.server.ts:15-17`): anything but the three words
  (absent, another case, an encoding, an oversized value) is Dark, and
  nothing else from the header is read or passed on. After a client-side
  navigation, the auth screens use the theme the page last learned, kept
  in memory and never in browser storage.

**The Account page** (`apps/web/app/routes/settings/account.tsx`, its fixed
words in `apps/web/app/lib/account.ts`). Its cards, in order:
1. **Account**: "Email", the address as text, and "Your email address
   cannot be changed".
2. **Change Password** ("Current Password", "New Password", "Confirm New
   Password", "Update Password", "Updating..." while it runs). Before
   sending, the web checks "Passwords do not match", then "Password must be
   at least 12 characters", then "Password must be at most 128
   characters": the API's refusal said first, in fixed words, rather than
   a `maxLength`, which would cut a pasted password short without a word
   (the register and reset forms have neither, and the API
   refuses there). A wrong current password shows the API's message under
   its field; success toasts "Password updated successfully".
   An account without a password sees **Set a Password** instead ("Your
   account signs in with Google. We'll email you a link to set a
   password.", "Email me a link"), then, as text, "We sent a link to
   {email}. Open it to set your password. Setting it signs you out on
   every device."
3. **Sign-in methods** ("How you can sign in to Telflo"), hidden when no
   provider is configured and the account has no identity: "Password",
   "Set" or "Not set"; then each provider, "Linked as {email} on {date}"
   with "Unlink", or "Link {provider}". An account without a password has
   Unlink disabled beside "Set a password first", which sends the same
   reset link. "Link {provider}" first asks for the current password in a
   dialog when the account has one ("Enter your current password to
   continue to {provider}."), else starts at once; the browser goes to the
   provider and comes back to `?link=<code>`, whose words are toasted
   ("Google sign-in linked.", "That Google account is already linked to
   another Telflo account.", "Your account already has a Google sign-in.",
   "Google didn't confirm that account's email address.", "Linking Google
   didn't work. Try again.") and the parameter removed with `replace`.
   - **Only to the provider**: the browser follows the start's
     `authorizationUrl` only when `isProviderAddress` accepts it, https, or
     http only on a loopback host (`localhost`, `127.0.0.1`, `[::1]`, the
     API's `isLoopbackHttpIssuer` set, for the fake provider in the browser
     tests), since the contract's `url()` also accepts `javascript:` and
     `data:`. Any other address is refused with an error in fixed words
     (never the address), and the link's failure words are toasted
     (`apps/web/app/components/settings/LinkProviderDialog.tsx:25-51`).
   - **Back from the provider**: a page the browser restores from its
     back/forward cache (`pageshow` with `persisted`) is usable again, the
     dialog (Cancel, Escape, a new start) and the Link buttons, as the
     sign-in page is (`useBackForwardRestore`, `:53-68`).
   - Unlink's dialog asks for the current password ("Enter your current
     password to remove this sign-in. You can still sign in with your
     password.", and the re-link sentence when the identity's
     `relinksByEmail` is true, above), then toasts "{provider} sign-in
     removed.".
4. **Sessions** ("Browsers signed in to your account"): each row "{browser}
   on {system}" ("Unknown browser", "unknown system" for `other`), "This
   browser" on the current one, "Signed in …", "Last active …" and "IP
   address …"; "Sign out" on every other row, with no confirm, then
   "Session signed out." and the list read again. "Sign out everywhere"
   below the list confirms ("Sign out everywhere?", "This signs you out of
   Telflo in every browser, this one included.", "Cancel", "Sign out
   everywhere"), then revokes every session, runs Logout's clean-up
   (`signOutWith`: the session-ended handler suspended meanwhile, the
   stores cleared, PostHog reset; the theme cookie and the remembered theme
   kept), toasts "Signed out everywhere" and goes to `/login`.

**Loading and failed reads.** The sign-in methods are read once for the
second and third cards, and the Sessions card reads its own list, each
under a 10-second hang guard (`useAccountRead`,
`apps/web/app/lib/account.ts:118-163`). While a read runs, its place says
"Loading…" (`role="status"`); a failed read says "Failed to load sign-in
methods" or "Failed to load sessions", with "Try again". A read again
keeps what is shown until it answers (after a failure, "Loading…" again),
and a later read wins over an earlier one's late answer. The Account card
needs no read: the email comes from `/me`.

**Failures** say the API's fixed message for an account refusal or a
limit, else fixed words: "Failed to update password", "Failed to send the
link", "Failed to remove the sign-in", "Failed to sign out the session",
and, for a link start that fails, a provider that can't be reached or an
address refused, "Linking Google didn't work. Try again.". A session that
ended says nothing: the session-ended handler takes the browser to sign
in. **Sign out everywhere always toasts its own fixed words**, "Failed to
sign out everywhere", whatever the failure, an ended session included, as
Logout does: its session-ended handler is suspended while it runs
(`apps/web/app/components/settings/SignOutEverywhereDialog.tsx:28-38`).

**A wrong current password, and where the focus goes.** After a wrong
current password, Change Password and the Link and Unlink dialogs show the
API's fixed message under the field with `role="alert"`, so it is announced,
tie it to the field (`aria-invalid`, `aria-describedby`), and put the focus
back in the field once it is enabled again, in a layout effect, so the focus
lands in the same commit as the message
(`apps/web/app/components/settings/ChangePasswordCard.tsx:54-66`,
`:116-134`). The dialogs have no Radix trigger, so the Sign-in methods card
places the focus as one closes: back on the button that opened it, or, when
the Unlink dialog's answer reads the methods again (an Unlink, or a refusal
that closed it), on the card's heading, since that button is about to go
(`apps/web/app/components/settings/SignInMethodsCard.tsx:113-121`). After a
row's Sign out succeeds, the Sessions card's heading takes the focus, unless
it has moved elsewhere meanwhile
(`apps/web/app/components/settings/SessionsCard.tsx:54-63`).

**Personal data on the account screens.** The account's email, a linked
identity's email snapshot, a session's IP address, its browser and OS
families and its times are personal data. The rules:
- **The API.** Error messages are fixed: never an email, a provider's email,
  an IP, a user agent or a password. The request log carries no body and no
  user agent (`apps/api/src/http/request-log.ts:160-169`: the method, the
  URL, the version, the host, the address and the port), so no password; the
  callback's query, which holds the code and the state, is dropped from the
  URL it logs (`loggedRequestUrl`, above). No log line carries a user agent,
  and the sessions reply carries the two families, never the raw string.
  Audit rows hold ids, provider ids and fixed values, with the IP and user
  agent only in their own columns, as every row has. A user agent that may
  hold a `tf_`, `tll_` or `tqd_` is stored `[redacted]` in an audit row and
  a session alike (`apps/api/src/http/audit-user-agent.ts`).
- **The web.** Each of these is visible text only, inside the masked shell
  (`ph-mask` on `<body>`), and never goes in an `aria-label`, `title`,
  `alt`, placeholder, `data-*` attribute, URL, toast, page title, browser
  storage or analytics property. The Account card shows the email as text,
  not as a disabled input, whose `value` is an attribute
  (`apps/web/app/components/settings/AccountCard.tsx`); Set a Password's "We
  sent a link to {email}. …" is text in the card, never a toast. A Sessions
  row's "Sign out" is named through `aria-labelledby`, pointing at hidden
  text, by fixed words and the session's sign-in time to the second, so two
  rows read apart: "Sign out the session signed in Oct 9, 2026, 7:58:30 AM"
  (`apps/web/app/components/settings/SessionsCard.tsx:42-45`); never an IP,
  a browser or a system. An identity's "Unlink" is named "Unlink
  {provider}", by the provider's configured name.
- **Password fields are uncontrolled**: React writes a controlled input's
  value into its `value` attribute, which the rule above forbids. Change
  Password's three fields and the Link and Unlink dialogs' current password
  have no `value` prop: each form is read through `FormData` when it is
  sent, emptied by `form.reset()` after every answer from the API (a check
  that fails in the browser keeps what was typed;
  `apps/web/app/components/settings/ChangePasswordCard.tsx:68-99`), and a
  dialog's field goes with the dialog when it closes. Replay's
  `maskAllInputs` masks them (`apps/web/app/lib/analytics.ts:581`). This
  holds for the account screens' forms only; the exceptions are below.
- **Fixed words.** Toasts, dialog titles and the link's result codes are
  fixed words. The one value some carry is the provider's configured name,
  configuration and not personal data: the dialogs "Link {provider}" and
  "Unlink {provider}", and the toast "{provider} sign-in removed.".
  Nothing goes to browser storage: there is no persisted settings store,
  and the theme cookie is HttpOnly and holds one word.
- **The exceptions:**
  - **The auth forms are controlled**: `LoginForm`, `RegisterForm`,
    `ResetPasswordForm` and `AcceptInvitation`
    (`apps/web/app/components/auth/`) give their inputs a `value` prop, so
    what is typed, the passwords and the email, sits in the DOM's `value`
    attribute; `AcceptInvitation` also puts the invitee's email in a
    read-only input's `value`
    (`apps/web/app/components/auth/AcceptInvitation.tsx:369`). Replay's
    `maskAllInputs` masks them in a recording. Making them uncontrolled too
    is still to do.
  - **PostHog's `identify`** sends the account's email as a person property
    once the visitor has accepted (`apps/web/app/lib/analytics.ts:148-158`).
    posthog-js also carries that email in its `/flags/` request's body and
    keeps a copy in its localStorage. Beyond these, the account's email
    appears nowhere else.

## Service accounts and API tokens

Paths below are under `telflo-core/`, but for the gateway's,
`docker/gateway/default.conf`, and the gateway check's,
`scripts/check-gateway-logs.sh`, at the repository's root.

**A service account is a user that never signs in.** It is a `users` row of
kind `service`, a fixed contributor of one organization, created with its
membership in one transaction and never with a personal organization. Only
the organization's admins see or manage accounts and their tokens, reads
included: the request's role first (`assertAdminRole`), then, for a write,
the organization's `for no key update` lock and the admin re-check under it
(`lockAsAdmin`, `apps/api/src/modules/organizations/service.ts`). Its
routes, under `/api/v1/organizations/{organizationId}/service-accounts`, run
`authenticate` only. The database holds the backstops (migration
`packages/db/migrations/1700000000035_service_accounts.js`), each one for
the API's role whatever an API path forgets:
- `ck_users_service_account_credentials`: a service account has no
  password and a verified email;
- `ck_users_service_account_domain`: `@service-accounts.telflo.invalid`
  (exactly, case aside) is held by service accounts and by nobody else;
- `users_kind_immutable`: `kind` changes only by the tables' owner (42501
  for anyone else);
- `user_identities_human_only`, `sessions_human_only` and
  `service_accounts_service_only`, each
  `before insert or update of user_id`: a service account links no identity
  and holds no session, and a `service_accounts` row names a service
  account, never a person (23514, the user's id only).

Only an operator bypasses one: the tables' owner disabling a trigger or
dropping a check, or a superuser with `session_replication_role = replica`
(which skips the triggers, not the checks).

**People's flows never find one.** `users.findByEmail` and
`findByEmailIncludingDeleted` match `kind = 'human'`
(`apps/api/src/modules/identity/repositories/user-repository.ts:238`,
`:262`). So a service account's address reads as no account wherever a
person's flow looks it up, and each flow keeps its enumeration-safe answer:
sign-in's `invalid_credentials` after the dummy verify, the reset's and
resend's `202`, the invitation preview's `hasAccount: false`. Registration,
inviting and registering from an invitation answer `422 email_reserved`
"This address can't be used" for any address at the domain, before any
lookup by email (the invite also before it spends the mail budget). Google
sign-in redirects with `oauth_email_reserved`, audited
`user.oidc_sign_in_failed` `{ reason: "email_reserved" }`. Each refusal is
about the domain, never about an account, so it says nothing about which
addresses exist. `members.findByEmail` (the invite's already-a-member check)
keeps every kind.

**Permissions never shows one.** The members list and the page's three
counts leave out kind `service`. A role change, a removal or a restoration
naming one answers `409 member_is_service_account` "Service accounts are
managed in Settings › Service Accounts.", checked right after the member is
locked and before anything is written. Deleting an account, from its own
Settings list, is one transaction under the organization's lock: the user
locked, every token not yet revoked revoked by the admin, the membership
soft-deleted, the user's and the row's `deleted_at` set, one audit row. It
runs as the API's real role, whose grants and policies every write passes (a
test checks it under that role: a fix tested under another role can still
fail under the real one). Its configurations keep its address as their
creator; it can't be undone. Deleting the organization soft-deletes its
service accounts, and their tokens fail the lookup.

**The token** (`apps/api/src/modules/service-accounts/tokens.ts`). `tf_` and
the base64url of 32 bytes from `randomBytes`: 46 characters, 256 random
bits. It is stored only as `hashToken`'s SHA-256 hex of the whole token
(`api_tokens.token_hash`, unique, checked `^[0-9a-f]{64}$`) and its first 11
characters (`token_prefix`, checked `^tf_[A-Za-z0-9_-]{8}$`). A keyed hash
isn't needed: an unkeyed SHA-256 suffices for a secret of 256 random bits.
**Shown once**: the create reply, `201 { apiToken, token }` with
`Cache-Control: no-store`, is the only place it crosses the API. It is never
logged, audited, put in an error or returned again. The list holds the
prefix (shown as `tf_AbC12xYz…`), and no read selects `token_hash` (a
repository test pins the list's keys). Its access, `read` or `write`, is
stored and reported, and enforced per route. An expiry is optional, 1 to
3650 days of 24 hours from its creation. A token is revoked, never deleted
by the API (`revoked_at` and `revoked_by_user_id`): it leaves the list and
frees its name. An expired token stays listed with its Expired badge, its
name taken, until revoked (no index can read the clock). Limits, each
counted under the organization's lock: 100 live accounts an organization
(the account's row and its user not deleted) and 20 live tokens an account
(a live token: neither revoked nor expired).

**The check** (`apps/api/src/modules/public-api/authenticate-api-token.ts`).
The public surface, `/api/public/v1/`, is the API's own. Its plugin's
`onRequest` hook (`apps/api/src/modules/public-api/plugin.ts`) runs this
check before any body is read or validated, never `authenticate` and never
`requireCurrentTerms`: a service account never accepts the terms, so a terms
bump locks none out, and a person's own token doesn't check them either (a
CI job never stops on a terms change). CSRF doesn't apply (the guard covers
`/api/v1/` only, and a browser never attaches a bearer on its own), and CORS
allows no `authorization` header, so a cross-origin page can't call it. In
order:
1. the client address's failure budget: blocked → `429 rate_limited` with
   `Retry-After`, before the header is read;
2. no `Authorization` header → the 401, counting nothing (it guesses
   nothing);
3. any header, whatever its scheme, counts one attempt **in flight**,
   before the lookup, so parallel guesses can't outrun the count;
4. the header's form: `Bearer` (the scheme case aside), one space, then
   exactly `^tf_[A-Za-z0-9_-]{43}$`; anything else → the attempt settles as
   a failure, and the 401;
5. the lookup by the token's hash at the API's clock; no row → a failure,
   and the 401;
6. accepted: the request's own attempt is taken back (never a reset: the
   window and the address's other failures stand); a lookup that throws is
   taken back too and surfaces as a 500, so an outage spends no budget.
   Settling is structural: everything after the count runs in a
   `try`/`finally` that takes back any attempt still unsettled, whatever
   throws, and settling twice does nothing, so a refusal's failure and an
   acceptance's refund stand;
7. the token's context (a service account's at once; a person's after
   the organization check below), then "Last used".

Then, in the plugin's hook, in this order: the token's minute, 60 requests
keyed `token:<tokenId>` (never the bearer; `429 rate_limited` with
`Retry-After`), counted before a person's organization check so a refused
organization still spends it; a personal token's organization (below); the
route's access, a `read` token on a `write` route answering
`403 insufficient_access`. Every route declares its access, and the plugin
refuses to register one that doesn't (`access.ts`), so no route fails open.
An unknown path answers the one 401 to a caller the check refuses, and `404`
only after the check.

**The one 401**, for every refusal alike (a missing header, another scheme,
a malformed, unknown, revoked or expired token, a deleted account, a
removed membership, a deleted organization): `{ "error": { "code":
"invalid_api_token", "message": "Missing or invalid API token" } }` with
`WWW-Authenticate: Bearer` (`apps/api/src/modules/public-api/errors.ts`),
so a caller can't tell them apart.

**The failure limit:** `RATE_LIMITS.apiTokenFailuresPerIp`, 30 failures per
5 minutes, keyed by `request.ip` (which honors `TELFLO_TRUST_PROXY_HOPS`),
never by the token; in memory per API process, as every limit
(`createApiTokenFailureLimiter`, `apps/api/src/http/rate-limits.ts`). An
address is blocked while its settled failures and its attempts in flight
together reach 30. Blocked by settled failures, the 429's `Retry-After` is
the window's remaining time; blocked only by attempts in flight, which
settle within a lookup's time, it is 1 second. So **more than 30 concurrent
requests from one address are refused**, valid tokens' included, and told to
retry in a second.

**The lookup and its grants.** The check's only way past row-level security
is `find_live_api_token_by_hash(p_token_hash, p_at)`, migration 032's
pattern: SECURITY DEFINER, `stable` (it only reads), a fixed `search_path`
and schema-qualified tables, `revoke execute … from public` and
`grant execute … to telflo_platform_runtime`. It answers a row only for a
token neither revoked nor expired at `p_at`, the API's clock (never the
database's), of either kind: a service account's, whose `service_accounts`
row, user (of kind `service`), membership and organization are live; or a
person's own (`personal_api_tokens`), whose user is a live person (kind
`human`, not deleted). Every refusal is no row. It answers only what the
context needs (`kind`, the token's id, its user, the user's address for
audit rows, its access, and for a service account its organization and the
membership's role; a person's come per request), not the name. **One
caller**, pinned by source scans in
`apps/api/src/database/context-source.test.ts` (`:120`, `:131`, `:142`,
`:199`; the scans skip Vite's short-lived bundled config,
`*.timestamp-<ms>-<hex>.mjs`, which a browser run can delete mid-scan):
`createApiTokenContext` is named only in `authenticate-api-token.ts`;
`createApiTokenStore` only there and in `modules/public-api/routes.ts`;
`findLiveApiTokenByHash` is called only from `authenticate-api-token.ts`;
the SQL name appears only in
`modules/service-accounts/repositories/api-token-repository.ts` and the
migrations. Nothing caches a lookup: every request reads the database, so a
revoke, an account's deletion, a removed membership or a deleted
organization refuses a token on the very next request: a revoke and an
account's deletion through their routes in
`apps/api/src/modules/public-api/token-check.integration.test.ts` (over the
real store, on a test-only route registered only in that file), a removed
membership and a deleted organization among the refusals of
`apps/api/src/modules/public-api/whoami.integration.test.ts:237`.

**The token's context.** A frozen `ApiTokenContext`
`{ userId, organizationId, role, kind, tokenId, access }`
(`apps/api/src/database/context.ts`), built only by `createApiTokenContext`,
honestly not a session's. Both it and `AuthContext` extend `ActorContext`
`{ userId, organizationId, role }`, which every data service takes;
`AuthContext` keeps its non-null `sessionId` for sessions, OIDC and the
account, and `createAuthContext` stays `authenticate`'s alone. Database work
for a token runs in `withDatabaseContext` with the account as the user and
the token's organization: the account acts as itself there, under the
policies, and sees what any contributor sees, its own drafts included. A
route that forgets the preHandler fails closed
(`requireApiTokenAuthentication` throws the 401). **A token is no session**:
a `tf_` Bearer on `/api/v1/` answers the session's `401 unauthenticated` and
makes no session (`authenticate` reads the access cookie only). `/whoami`
reads the token's name through the policies in its context, and a token
revoked since the check names none and gets the 401.

**"Last used":** after a successful lookup, in the token's context, one
update setting `last_used_at` where the token isn't revoked and was last
used at least a minute before (or never), so concurrent checks write once a
minute. Best-effort: a failure is logged at warn with `{ tokenId, code }`
only (never the error, whose detail could hold the hash) and never refuses
the request.

**The audit rows:** `service_account.created`, `.renamed` and `.deleted`
(`{ revokedTokens }`), `api_token.created`
(`{ serviceAccountId, access, expiresAt }`) and `api_token.revoked`
(`{ serviceAccountId }`), each with the acting admin and the IP and user
agent in their own columns. Ids and fixed values only: never the token, its
prefix, its name or the account's name. No row for a successful check, and
no emails. **A credential in `User-Agent` never reaches a stored row**:
every site that keeps a `User-Agent` (audit rows, sessions, the public
download's requester, a sales inquiry) reads it through `auditUserAgent`
(`apps/api/src/http/audit-user-agent.ts`), which stores `[redacted]` when
the header may hold a `tf_`, `tll_` or `tqd_` in any spelling the request
log recognizes (`mayHoldCredential`), else the header as sent, so a CI
runner's name holding a token isn't kept for good.

**A `tf_` token is a secret like a bearer.** Never in a log line, an error
message, a span, an audit row, a URL, a toast, an attribute, browser
storage, an analytics property, a report, a commit or a test's printed
output. In the browser it lives only in the account page's state from the
create reply and is shown only in "Copy your token", in the shared
`SecretCopyBox` (`apps/web/app/components/secrets/`, `ph-no-capture`), put
on the clipboard only by its "Copy token" button and cleared when the dialog
closes, however it closes; the token list is read again only once it has
closed (`apps/web/app/components/settings/ServiceAccountDetailSection.tsx`).
Test fixtures build tokens at run time; no test compares a structure that
could hold a token or its prefix before boolean canaries have passed, and no
web or browser test hands a node that could hold one to a printing matcher.
Gate logs and reports are searched with `tf_[A-Za-z0-9_-]+`, and no
committed file holds a literal token.

**Kept out of the logs and analytics.** A token travels in the
`Authorization` header and never belongs in a URL or any other header; these
rules cover one pasted there. The invariant: **no logged field holding a
client-supplied value carries a `tf_` token**.
- **The API's request log** (`apps/api/src/http/request-log.ts`): a URL
  any spelling of which (as sent, percent-decoded once, runs of `/` made
  one) holds `tf_`, case aside, is logged as `/[redacted]`, query and all,
  after the quick-deploy rule (`loggedRequestUrl`); the `404` handler's
  reply follows the same rule. Every other field a client can write goes
  through `loggedClientField`, `[redacted]` when a spelling of it holds
  `tf_`: the `Accept-Version` header, the host (the `Host` header, or
  `X-Forwarded-Host` once proxy hops are trusted) and the address
  (`X-Forwarded-For`'s, once they are). The request log carries no other
  header, so never the `Authorization` header.
- **The API's request log under the public prefix**: an allowlist. The
  validation-pipeline route's path holds a validation pipeline's NAME
  (configuration text), a client may append any query, and redacting
  spellings kept missing variants, so a request that `http/public-path.ts`
  puts under `/api/public/v1` (in any spelling: absolute form, encoded once
  or more, any case, runs of slashes, dot segments), or that a public route
  matched, is logged by its matched route's PATTERN only
  (`/api/public/v1/configurations/:configurationId/versions/:versionNumber/validation-pipelines/*`),
  or the fixed `/api/public/v1/[unmatched]` when none matched: never the raw
  path or its query. The plugin's `404` reply says the same. The
  quick-deploy, library-link and `tf_` rules still come first.
- **The gateway's access log** (`docker/gateway/default.conf`): a request
  whose raw line holds `tf_`, any of its letters percent-encoded once or
  not, case aside, is logged `"METHOD /[redacted] PROTOCOL"` (the
  quick-deploy line when it holds both), and a Referer, a `User-Agent` or an
  `X-Forwarded-For` holding it is logged `[redacted]` (an absent or empty
  one `-`). **No field of the access log is derived from the `Authorization`
  header**: the user field is a fixed `-`, never `$remote_user`, which nginx
  fills from an `Authorization: Basic` header's user name (a token sent as
  one, `curl -u "tf_…:"`, would otherwise be logged whole). The format's
  other fields are nginx's own: the socket's address, the time, the status,
  the byte count. **The public surface's twin**: a request under
  `/api/public/v1`, by nginx's `$uri` (case aside) or by its raw request
  line (the prefix's three words, a slash or an encoded one before each, any
  character percent-encoded once or more, and any path characters between
  the words: runs of slashes, dot segments, encoded or doubly encoded ones),
  is logged as the fixed `"METHOD /api/public/v1/[redacted] PROTOCOL"`,
  never its path or query; a quick-deploy or library-link line wins over it,
  and it wins over the `tf_` line. Its error log: every public location (the
  2 MiB and 8 MiB ones and a final public catch-all) logs crit and worse
  only, 413s included, so neither an upstream's failure nor a body over the
  limit quotes a public request line; nginx's diagnostics for the surface
  are given up, and the API's logs keep its failures. The catch-all matches,
  case aside, the spellings of the public surface that would otherwise reach
  `location /api/` (or `location /`) (encoded prefixes, any path between the
  words), so a mixed-case public path reaches the API's one 401, not the web
  app. `scripts/check-gateway-logs.sh` checks each in the real image
  (`docs/conventions/testing.md`, "The gateway's logs").
- **Analytics** (`apps/web/app/lib/analytics.ts`): a URL or path whose path
  or query holds `tf_` (as spelt or percent-decoded once, case aside) is
  replaced whole by `/[redacted]`, after its origin, in every URL-valued
  property and in replay's page addresses and recorded requests
  (`withoutTokens`, `withoutTokensInRequest`), and PostHog never starts in a
  document whose address (its fragment included) or referrer holds it, as
  for a quick-deploy secret (`startAnalytics`): posthog-js would store them
  before any `before_send`. The three emailed-link pages (reset, verify,
  accept an invitation) take their token out of the address bar before the
  root starts analytics, so in practice only a `tf_` pasted into a URL, or a
  referrer holding one, blocks a document.
- False positives (an opaque cursor or an asset's name holding `tf_`) only
  lose a log line's URL, a field, or a page's analytics.

**Names and addresses.** A service account's name and its address are
organization content: visible text inside the masked shell (`ph-mask`), and
inside `ph-no-capture` where typed (the create and rename fields, the
type-to-confirm field). They never go in an `aria-label`, `title`, `alt`,
placeholder, `data-*` attribute, URL (routes take ids), toast, page title,
browser storage or analytics property. Every name field is uncontrolled,
with no `value` and no `defaultValue` (React writes both into the `value`
attribute), Rename prefilled through the input's `.value` property. Row
actions are named through `aria-labelledby` by fixed hidden words and the
row's name cell; toasts and titles are fixed words; the revoke and delete
dialogs' titles hold the name as visible text, inside the mask. A token's
name follows the same rules, and its prefix is visible text in the masked
list only. On the API, error messages are fixed words (never a name, an
address, a token or its prefix), and logs hold ids only.

**Personal tokens** (`apps/api/src/modules/account/personal-api-tokens.ts`).
A person's own `tf_` token, made on their Account page, the same secret as a
service account's under every rule above. It acts as that person, with their
role and their drafts, in any organization they belong to.
- **Only its person sees it.** `personal_api_tokens` (migration 038) has
  row-level security on the context's user, so a person reads and changes
  their own rows only; the routes are the account routes
  (`/api/v1/auth/me/api-tokens`, session and CSRF, `authenticate` only). No
  organization admin lists or revokes one: removing the person from an
  organization stops it there.
- **The cap:** 20 live tokens per person, a live token neither revoked nor
  expired (as for a service account's), counted under a lock on the user's
  row (`409 api_token_limit_reached`). A name is unique, case aside, among
  the person's tokens not yet revoked, expired ones included. A revoked or
  another person's token answers `404 api_token_not_found`. No terms check,
  no emails.
- **`X-Telflo-Org`** names the organization on each request (an id only:
  it is never logged). Missing where a route needs it (every route but
  `/whoami` and `/orgs`), or not a uuid wherever it is sent: `400
  organization_required`. Then the person's live membership in that live organization is
  read on every request, with no cache (`findLiveMembershipRole`), so a
  removal or a role change takes effect on the next request. **One 403**:
  `organization_access_denied`, with the same status, body and headers for
  an organization that doesn't exist, has been deleted, or that the person
  isn't in. A refused organization doesn't count toward the failure limit
  (the token was accepted), but it does spend the token's minute.
- **"Last used"** is written in the context `{ userId, organizationId:
  null }`, which the table's policies require.
- **Audit rows:** `personal_api_token.created` and `.revoked`, ids and fixed
  values only (the access, the expiry), under the session's active
  organization, as the other account audits are.
- **In the browser:** the Account page's "API tokens" card, last
  (`apps/web/app/components/settings/PersonalApiTokensCard.tsx`): a service
  account's table, create, reveal and revoke dialogs, the token in the
  card's state for the reveal alone. A token's name is the person's content:
  visible text inside the masked shell only, never an attribute, a toast, a
  title, storage or an analytics property.

**The surface's invariant**
(`apps/api/src/modules/public-api/route-guard.ts`): no request under
`/api/public/v1`, in any spelling, is answered outside the public plugin's
checks.
- **The verification, at request time** (the guarantee): a root
  `onRequest` hook, the first thing `buildServer` adds. A request that
  `http/public-path.ts` puts under the prefix (its one normalizer, the
  request log's too: absolute form stripped, decoded until stable, slashes
  collapsed, dot segments resolved, the prefix matched case aside) must
  have matched a route the public plugin's own `onRoute` marked, with a
  private token good for its exact method and URL (or one of the open
  routes' allowlist, or the CORS `OPTIONS *`). A request no route matched
  passes only to the public plugin's OWN not-found handler, which answers
  after the token check. Anything else answers the one 401 and logs a warn
  naming the route's pattern. So neither a root route with a parameter or
  a wildcard (`/api/:x/v1/…`, `/api/*`) nor another plugin's
  `setNotFoundHandler` can answer a public path.
- **The registration guard** (an early failure): a root `onRoute` hook
  refuses, so the server doesn't start, a route that could match a public
  path (segment by segment, parameters and wildcards matching) unless it is
  the plugin's, on the open allowlist (`GET` and `HEAD` of `/health`,
  `/openapi.json`, `/docs`, `/docs/*`), or the CORS preflight.
- **Pinned:** `claimPublicSurface` (called only by `plugin.ts` and
  `open-routes.ts`) refuses an instance that already holds a surface, and
  `setNotFoundHandler` is called only in `errors.ts` and `plugin.ts`
  (`apps/api/src/database/context-source.test.ts`).
- **No caller value in a public 400**: a schema's `400 invalid_request`
  names each issue's path and Zod's code only, never a value, an enum's
  options or an unknown key's name, so a pasted token isn't echoed
  (`publicValidationDetails`, `apps/api/src/errors.ts`). A route's own 400
  carries `{ path, message }` in fixed words (the fleets' refusals and a bad
  cursor included). The browser's routes still echo Zod's issues (a known
  residue).

**Install replies are bearer replies.**
`POST /api/public/v1/fleets/{fleetId}/install` answers a ready command
holding the fleet's default token's bearer (docker), the bearer and a
quick-deploy link's secret (linux), or a Helm values link's secret, whose
download answers the bearer (kubernetes): a secret on every platform. A
fourth place a bearer crosses the API, after the browser's fleet create,
reveal and rotate.
- `write` access; `Cache-Control: no-store`; built only by the shared
  command builders (`packages/contracts/src/install-commands.ts`, the
  web's dialogs' too, byte-identical); never logged, audited or echoed in
  an error.
- On every platform, one spend of the fleets' bearer budget (10 a minute),
  taken first, and the reveal's audit row `enrollment_token.revealed`
  (ids, with `via: "public_api_install"` and `platform`). For kubernetes
  the row is written beside the link's create, with no reveal call.
- A linux install whose reveal fails revokes the link it just made,
  best-effort: a failed revoke is logged (ids only) and the link expires in
  24 hours. So retries don't pile live links toward the 100-link cap.
- Tests check the command with boolean canaries only. Fleet create through
  the public API answers no bearer.

**The reference page** (`apps/api/src/modules/public-api/docs/`).
`GET /api/public/v1/docs/` serves Swagger UI with try-it from the API's own
origin, the one page where a token is typed.
- **Its CSP:** `default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri
  'none'; form-action 'none'; frame-ancestors 'none'`, with
  `Referrer-Policy: no-referrer` and `nosniff`. Through the gateway it is
  the app's origin, so try-it calls are same-origin and CORS is unchanged.
- **The token in memory only** (`init.js`): `persistAuthorization:
  false`; `autocomplete="off"` on every input (Firefox's form history
  stored the token on disk); the curl block shows `Authorization: Bearer
  $TELFLO_TOKEN`, never the token (the DOM held it); try-it requests send
  no cookie (`credentials: "omit"`); `deepLinking` and
  `queryConfigEnabled` off, `validatorUrl` null. No token reaches a URL,
  browser storage, a log, an error or a toast. `X-Telflo-Org` holds an
  organization's id only.
- **No analytics:** PostHog isn't on the page, which isn't the web app's.
- **Vendored** at swagger-ui-dist 5.32.15 (not an npm dependency: its own
  dependency runs install-time telemetry), its files read once at start and
  served from a fixed map (no request names a file). The bundle's own
  license list is partial (webpack kept only the marked banners;
  `docs/third-party-assets.md`).
- **No cache keeps a try-it call:** every reply under the public plugin is
  `no-store` unless its route sets its own (Firefox's disk cache would
  otherwise keep try-it GET URLs), the refusals included.
- **Its browser test** never holds the token past a bounded phase: every
  step bounded, no trace, the token set without `fill`, so a hang reaches
  about:blank before the test's timeout and no `error-context.md` or report
  holds the token.

**YAML test runs.** A public run may carry a raw YAML, an inline sample and
inline rules: configuration text, never in a log line, an error message, a
span, an audit row or a URL (the run's audit row holds
`{ source: "yaml", inputFileId }`). A YAML run has no configuration
(migration 040): its row-level security lets only its creator, in its
organization, see it, no browser page lists it, and the claim fails a
waiting run of a deleted organization. Inline rules are used once, never
saved, checked as Save checks. The sample is stored as the caller's test
file; a service account's is removed once the run holds its copy (nobody can
reach it), a person's stays in their My Files.

Residues. **nginx's error log keeps a token pasted into a URL's query, or
into the `Host` header**, when that path's upstream fails (its line quotes
the request and `host: "…"`), as it keeps a quick-deploy secret in another
path's query (no routing change; the gateway check runs the `tf_` cases
outside `/api/public/v1` with the upstreams up only). Under
`/api/public/v1`, in any spelling, the locations log crit and worse only,
and the check runs its public cases with the upstreams down too. **A
quick-deploy secret in a client-supplied field**: the rules for the
`User-Agent`, `X-Forwarded-For` (the gateway) and the API log's host,
version and address cover `tf_` only, so a `tqd_` written there is logged as
sent. That holds for the LOGS only: a stored row's `User-Agent` (an audit
row, a session, the download's requester, a sales inquiry) is `[redacted]`
when it may hold a `tf_`, `tll_` or `tqd_`. **A failed browser run's
`trace.zip` and its `error-context.md`** (the page's snapshot) hold the
e2e-only token when the reveal is open at the failure, as for every spec
that shows a bearer. **The list of expired tokens** is bounded only by an
admin revoking them (a person's own, by the person): expired tokens don't
count toward the 20 and stay listed. **An `/api/v1` size location crafted to
climb into the public prefix**: such a location (the configurations', the
test files' and the others with a larger body limit) is matched before the
public ones, and a request crafted with a doubly encoded parameter (a dot
segment the API decodes again) can reach the public prefix through it, so
its error log, at the image's level, quotes that line when its upstream
fails: the caller's own text only, never a validation pipeline's name, and
the API answers it the one 401.

## The telflo CLI

The CLI is `telflo-core/apps/cli` (`docs/conventions/cli.md`), a client of
the public API above with no access of its own; paths below are under it
unless they name `apps/web` or `apps/api`.

**A token never goes on argv.** `telflo login` reads it at a hidden prompt
(`src/prompt.ts`: raw mode, nothing echoed, the terminal restored on
Ctrl-C), from standard input when that isn't a terminal (one line, at most 4
KiB), or from the `/cli-auth` page's handoff; `TELFLO_TOKEN` serves scripts.
There is no `--token` flag. A token that isn't `tf_` and 43 base64url
characters is refused without being echoed (exit 2), and every token is
checked by `GET /whoami` before anything is stored (a 401 stores nothing).
The token `/whoami` proves valid is any valid token, not necessarily the
person's own: login's last line names it, "Logged in to <server> as <token
name> (<organization name>).", so a person sees which token and organization
the CLI acts with.

**Nothing prints a token**, not even its prefix (`whoami` names the token by
its name). There is no verbose or debug mode: nothing prints a request, a
header or a reply's body. Errors are fixed words (`src/output.ts`,
`src/api.ts`): the envelope's `message` (the API's own fixed words), or the
CLI's by status for anything else (the gateway's HTML `413`, `502` and
`504`, "Unexpected reply (HTTP n)."); a network error names the origin only.
Every error message, commander's usage errors included, goes through
`withoutTokens` (a `tf_` value replaced), and a server's string on the
terminal loses its C0 and C1 control characters and DEL (`terminalText`), so
a name holding an escape sequence can't drive the terminal; `--json` output
needs no stripping. The data a command was asked for (a pulled YAML, a run's
output, the install command) stays byte for byte. Replies are read with a
size cap.

**The credentials file** (`src/credentials.ts`):
`$TELFLO_CLI_CONFIG_DIR/credentials.json`, else
`$XDG_CONFIG_HOME/telflo/credentials.json`, else
`~/.config/telflo/credentials.json`; JSON `{ version: 1, server, token,
kind, tokenName, organizationId }` (no expiry: `/whoami` carries none).
- Written atomically: a temporary file in the same folder, created with
  mode 0600 (`wx`), synced, then renamed over the old one; the folder is
  created 0700.
- On POSIX, a file readable or writable by group or others, or a folder
  writable by them, is refused with the `chmod` to run (exit 3), and
  nothing is read from it. A link or a FIFO in the file's place is refused
  without being followed or waited on (`O_NOFOLLOW`, `O_NONBLOCK`). An
  unknown `version` or shape is refused ("run telflo login"), never
  guessed.
- `~/.telflo/credentials.json` is never read, nor `TELFLO_CONFIG_DIR`: the
  CLI's variable is `TELFLO_CLI_CONFIG_DIR`.
- `telflo logout` deletes the file (a folder, link or FIFO in its place is
  left, with fixed words) and says the token still works until it expires
  or is revoked: the Account page (a personal token) or Settings › Service
  Accounts. No OS keychain.

**The server and the origin rule** (`src/server.ts`, `src/context.ts`):
`--server` (on `login` only), else `TELFLO_SERVER`, else the stored server,
else `https://telflo.com`.
- It is reduced to an origin; a path, query, fragment or user part is
  refused with fixed words (the typed text is never echoed: a user part
  could hold a password).
- **HTTPS only**, except `http://localhost`, `http://127.0.0.0/8` and
  `http://[::1]` on any port; there is no flag to allow another plain-http
  server.
- **A token goes only to the origin it was entered for.** The stored token
  is sent only to the stored server: `TELFLO_SERVER` naming another origin
  is refused (exit 3, "run telflo login --server …"). `TELFLO_TOKEN` pairs
  with `TELFLO_SERVER` or the default, never the stored server.
- **No redirect is followed** (`redirect: "manual"`): a 3xx is fixed words
  with its status, so the `Authorization` header never goes to another
  location.
- Every request has a timeout (30 s; 120 s for a test run's create and
  output). `X-Telflo-Org` goes with a person's token only, never on
  `/whoami`, `/orgs` or the anonymous validate.
- **A 429** is retried after its `Retry-After` (a malformed value counts as
  5 s; each wait at most 60 s; at most 3 retries; a stderr line each time):
  every 429 is answered before its route does any work, so a retried write
  is safe. A 429 without `Retry-After` (`test_run_queue_full`) is not
  retried.

**The login listener** (`src/login-listener.ts`, `src/login-browser.ts`),
the CLI's side of `/cli-auth`:
- It binds `127.0.0.1` on a free port and serves one path, `/callback`,
  until an accepted answer, Cancel on the page, five minutes, or ten
  refused requests (each exit 3 but the answer).
- `state` is 32 random bytes, base64url (43 characters), compared in
  constant time.
- It accepts only `POST /callback` with `Origin` equal to the server's
  origin, `Host` equal to `127.0.0.1:<port>`, `Content-Type:
  application/json`, a body of at most 4 KiB (past it a 403 at once, the
  connection dropped) and `{ state, token }` or `{ state, error: "denied"
  }`; and the CORS preflight for it, answered with
  `Access-Control-Allow-Methods: POST`, `-Headers: content-type`, and
  `Access-Control-Allow-Private-Network: true` only when the preflight asks
  for it. Anything else answers 403 or 404 with no body and keeps waiting.
- **Every reply** (the preflight's, the 204, a 403 or 404) carries
  `Access-Control-Allow-Origin: <the server's origin>`, never `*`, so the
  page can read the answer.
- It imports only node's built-ins and `src/version.ts` (the browser tests
  import it).
- The browser is opened (`open`, `xdg-open` or `cmd /c start`) on `<server>/cli-auth#state=…&port=…&host=…`, the URL
  printed too, with the hidden prompt open beside it for a pasted token;
  whichever answers first wins, the other is closed.
- `host` is the machine's host name cut to 32 characters of
  `[A-Za-z0-9.-]`, `unknown-host` when none is left.

**Residues, recorded:**
- **The state's local residue.** The state is on the browser opener's argv
  while the login waits (other local users can read it in `ps`), and a
  local process can forge `Origin` and `Host`, so a local process that
  reads it could hand the CLI a valid token of its own. Accepted: the
  machine's other users and processes are outside what the CLI can defend,
  and login's last line names the token and organization it took.
- **Machines that share a name share the revoke.** Approve revokes the
  person's earlier tokens named `CLI — <host> · …`, so two machines with
  the same host name (or both `unknown-host`) revoke each other's CLI
  token at each login; the other then logs in again. Documented in the
  CLI's README.

**The `/cli-auth` page** (`apps/web/app/routes/cli-auth.tsx`,
`components/cli-auth/`, `lib/cli-auth.ts`), inside the signed-in layout,
mints a personal token through the Account page's own routes; no API or
public route changed for it:
- **Its parameters travel in the URL's fragment**, which reaches no access
  log, request log or `Referer` (the reason the emailed links use
  `#token=`). The server render and the first client render show neutral
  words; an effect then reads `state`, `port` (1024–65535) and `host` from
  the fragment and removes it from the address bar (`history.replaceState`);
  a reload, or a missing or malformed one, shows "This sign-in link isn't
  valid. Run telflo login again." and nothing else. A signed-out visitor's
  302 keeps the fragment on `/login?redirectTo=%2Fcli-auth`, and `LoginForm`
  carries it after a password sign-in to `/cli-auth` only; a Google
  sign-in's round trip, the layout's client-side refresh failure and
  `/register` lose it (the invalid link's words; `telflo login` run again
  then works at once). `robots.txt` disallows `/cli-auth`.
- **Approve** (disabled while in flight) creates the token (`POST
  /api/v1/auth/me/api-tokens`, named `CLI — <host> · <YYYY-MM-DD
  HH:MM:SS>` UTC, the access and expiry chosen: write and 30 days by
  default, read, or 1, 7 or 90 days), then lists the person's tokens and
  revokes the unrevoked ones whose names start exactly with `CLI — <host> ·
  ` (never the new one; a failed revoke is a fixed warning), then posts `{
  state, token }` to `http://127.0.0.1:<port>/callback` (`credentials:
  "omit"`). A `TypeError` (blocked, refused) or 60 s without an answer
  shows the fallback, the request left open (a later 204 switches to
  "Done."); another status (a stale port, another process) shows it at
  once. The create comes first, so 20 live tokens refuse it (`409
  api_token_limit_reached`, the API's words and a link to the Account
  page). Cancel posts `{ state, error: "denied" }`.
- **The token** exists in the page only in the create's reply, a ref used
  for the handoff and the fallback's display: inside `ph-no-capture`
  (`SecretCopyBox`), on the clipboard only through its Copy button, never
  in a URL, storage, a toast, an attribute, a log or an analytics
  property, and gone when the page is left.
- **The host is personal data** (the person's machine name may name them):
  visible text inside `ph-no-capture` only on the page, never an attribute,
  a title, a toast or an analytics property. It also lives in the token's
  name (`CLI — <host> · …`), which the Account page lists under the rules
  for a token's name: visible text in the masked shell (ph-mask), never an
  attribute, a toast, a title, storage or an analytics property; masked in
  replay.
- **PostHog never starts** in a document whose path is `/cli-auth`, or
  `/login` with a `redirectTo` naming it (as spelt or decoded once or twice,
  case aside, a trailing slash): `lib/analytics.ts`' `blocked`, since
  posthog-js stores `location.href` before any `before_send` and replay
  records the sign-in buttons' links. The scrubber also drops every fragment
  from URL-valued properties. Toasts and the page's title are fixed words.
- **A residue, recorded:** `blocked` decides per document, so a client-side
  navigation to `/cli-auth` in a document where PostHog already runs would
  record the page's path `/cli-auth` and the listener's loopback URL in
  replay's network entries (bodies and headers off; the review found no
  state, host or token there). No link inside the app leads to `/cli-auth`
  (the CLI opens a new document): **`/cli-auth` must stay unlinked inside
  the app**, as a comment on `blocked` says.
- The page's routes log no bodies, so it adds nothing to the API's logs.

**The anonymous validate**
(`apps/api/src/modules/public-api/validate/anonymous.ts`;
`docs/conventions/api.md`): the public surface's first open route that does
work, so its risk is the validator's CPU.
- No token and no organization: an `Authorization` header sent is never
  read (no token check, nothing counted against a token or the address's
  failures); the organization's variables are never read
  (`validateAnonymousText`, no opamp-server read).
- **Its limits** (`apps/api/src/http/rate-limits.ts`, one two-level limiter,
  both levels checked before either is recorded): per address (`request.ip`)
  10 a minute and 1 in flight; across every anonymous caller 120 a minute
  and 4 in flight. The count is taken after the body is parsed and checked,
  before the catalog's reads. **The counts are each API process's own**
  (in memory), so the totals grow with replicas, and `request.ip` is the
  caller's only when `TELFLO_TRUST_PROXY_HOPS` matches the proxies in front
  of the API: otherwise every caller behind the gateway shares one address's
  10 a minute.
- **Body limit 1 MiB** at the API (`413 payload_too_large`, before the
  count), as the gateway's catch-all for public paths.
- **Its record** is the request log's line only (method, the fixed path,
  status); the text and the validator's errors are only in the reply,
  `no-store`, never a log line, an error message or a span. No audit row.

**`telflo fleet install`** prints a secret: its command holds the fleet's
bearer (docker), the bearer and a quick-deploy link's secret (linux), or a
Helm values link's secret whose download answers the bearer (kubernetes).
It goes to stdout only, exactly once, never into an error; `--json` prints
the reply as is to stdout; the notes go to stderr. An `--env` value is
configuration text: a malformed `--env` is named by its position, never
echoed.

**Tests** check tokens, bearers and install commands with boolean canaries
only, the canary before any comparison of a command's output. Every CLI run
in a test, a probe or the stack smoke uses a `TELFLO_CLI_CONFIG_DIR` and a
HOME of its own (`tests/setup.ts` blanks `TELFLO_TOKEN`, `TELFLO_SERVER`,
`TELFLO_ORG` and `TELFLO_CONFIG_DIR`); a probe of the default server points
at a loopback stand-in. The e2e spec (`e2e/cli-auth.e2e.ts`, under
`telflo-core/`) keeps no trace, screenshot or video, and passes only the
token's SHA-256 into the page. The stack smoke's CLI steps search its
outputs and the API's and gateway's logs with counts only
(`docs/conventions/testing.md`).

## The file store's credentials

Paths below are under `telflo-core/`, but for `docker-compose.yml` and
`scripts/`, at the repository's root.

**No key is a Telflo setting.** On `TELFLO_FILE_STORE=s3`, the S3 client is
built with no `credentials` (`apps/api/src/file-store/s3-file-store.ts`,
`createClient`), so the AWS SDK's default chain finds them on the first
request: the standard `AWS_*` variables, the shared config and credentials
files, a web-identity token, a container or an instance role. On EKS that is
the pod's IAM role, through IRSA (the API's Kubernetes service account
annotated with a role granted the install's bucket only). `loadSettings`
never reads an `AWS_*` variable (`apps/api/src/settings.ts`,
`fileStoreSettings`), so no key passes through Telflo's settings, their
errors or their tests, and the bucket, prefix, region and endpoint are no
secret. The endpoint is checked against an allowlist before it is parsed (a
lower-case `http` or `https` scheme, a host, an optional port from 1 to
65535 and an optional `/`: no user name, password, path, query or fragment),
and **no refusal of it ever shows its value**, only the variable and the
rule: a mistyped value can hold a password or a pasted presigned URL's
signature. The client has no `logger`, and sets
`ignoreConfiguredEndpointUrls`, so only Telflo's setting picks where
requests (and their signatures) go, never `AWS_ENDPOINT_URL*` or a config
file's `endpoint_url`. An S3 access key, a secret access key, a session
token, a SigV4 signature and an `Authorization` header are secrets: never in
a log line, an error message, a report, a commit, a test's printed output, a
URL or a reply.

**The development-only keys unlock only a local SeaweedFS.** Compose's
anchors `x-object-store-access-key` and `x-object-store-secret-key`
(`docker-compose.yml:73-74`) are `object-store`'s admin identity and
the stack's API's `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`;
`.env.example`'s `TELFLO_TEST_S3_ACCESS_KEY_ID` and
`TELFLO_TEST_S3_SECRET_ACCESS_KEY` (`:233-235`) are the same values, for the
tests against `npm run dev:services`' object store. They are public in the
repository and open nothing but that container, which publishes only its
S3 port, on the host's loopback (`127.0.0.1:51240`), and keeps its filer,
master and volume ports, which take requests without credentials, on its
own network. A real deployment never sets a key in Telflo's settings or
its chart.

**The store's errors keep a token code and the operation only**
(`s3-file-store.ts:44-74`). The SDK's errors quote the bucket, the
object's name (which holds the key's ids), the server's text, the endpoint
or the request's `Authorization` header in `message`, `stack`,
`$response`, `Resource`, `Key`, `BucketName`, a non-XML reply's `body`
and a network error's `address` and `port`. So every failure becomes a new
`FileStoreError` whose `code` is the first of the error's `Code`, `name`
and `code` that matches `^[A-Za-z][A-Za-z0-9.]{0,63}$` and isn't a generic
name (`Error`, `Unknown`, `UnknownError`, `S3ServiceException`), whose
`syscall` is the operation (`PutObject`, `GetObject`, `DeleteObject`), and
which keeps no `cause`. A read's body is the store's own stream, whose
errors are replaced the same way. The startup check's refusals name the
bucket, the prefix, the step and that code only. An abort rejects with the
signal's own reason. The store logs nothing: no key, no bytes, no name.
The errors of a source stream a caller hands to `write` pass through
unchanged, so keeping them free of server text is the caller's.

**A developer's own AWS identity never reaches a test.** `vitest.setup.ts`
(`:36-73`), right after its `.env` fill, sets to `""` every `AWS_` variable
present and every variable the default chain reads (deleted, `settings.ts`'s
own `.env` load would refill an absent one), points `AWS_CONFIG_FILE` and
`AWS_SHARED_CREDENTIALS_FILE` at a path that doesn't exist (the SDK reads
both for every client), and sets `AWS_EC2_METADATA_DISABLED=true`. The S3
tests then put only their test server's two keys in the environment, with
`vi.stubEnv`, through the same chain, refuse an endpoint off the loopback,
and compare a key's presence, never its value (no `toEqual`,
`objectContaining` or message comparison on anything that could hold one).

**SeaweedFS logs the access key id** (never the secret). No gate, report
or wait prints `object-store`'s logs: `npm run dev:services` waits
on its `/healthz` without the compose file and service that would print
them on a give-up (`scripts/wait-for-http.mjs`), and the stack smoke's log
scans name `api` and the gateway only. Don't print its logs, and
redact `SECRET_ACCESS_KEY=…` in reports and gate logs.

Off the machine, point `TELFLO_FILE_STORE_S3_ENDPOINT` at an `https`
endpoint. The setting accepts plain `http` (the local SeaweedFS needs it),
but over `http` to a remote server the files' bytes and the signed requests
travel in clear: the secret key is never sent, and each signature is bound
to its request and expires, yet the traffic can be read.

## Organization logos

Paths below are under `telflo-core/`, but for `docker/`, at the
repository's root.

**A file from a person is untrusted.** A logo is typed from its first bytes,
never its name or the browser's type: `imageTypeOf`
(`packages/contracts/src/images.ts`) knows a PNG
(`89 50 4E 47 0D 0A 1A 0A`), a JPEG (`FF D8 FF`) and a WebP (`RIFF`, a size,
`WEBP`) and nothing else, so SVG (which can carry script), GIF, HTML and an
empty file are `415 organization_logo_type_unsupported`. At most 2 MiB
(2,097,152 bytes): the multipart parser cuts the file there and the upload's
`finish` refuses it, `413 organization_logo_too_large`; the gateway takes 3
MiB on the create and change paths only
(`location ~ ^/api/v1/organizations(/[^/]+)?$`). The body is read whole and
checked before any byte is written
(`apps/api/src/modules/organizations/routes.ts`, `readOrganizationUpload`);
a malformed one is `400 invalid_request` with no details, which could echo
the name. The web checks the size and the first bytes with the same
`imageTypeOf` before sending, and the API checks again. No sanitizer,
resizing or re-encoding.

**Any admin sets one, personal organizations too**: in Edit's Save, under
the existing admin rule (`assertAdminRole`, then `lockAsAdmin`), and in
Create organization, whose creator becomes its admin; each is one request,
all or nothing. Contributors see the logo and no picker. Audited
`organization.logo_changed` (`{ logoId }`) or `organization.logo_removed`
(`{}`), ids only, in the change's own transaction.

**Public by its ids**:
`GET /api/v1/organization-logos/{organizationId}/{logoId}`
(`apps/api/src/modules/organizations/logo-routes.ts`) takes no session, no
cookie and no CSRF header, and answers only while the organization is live
and its `logo_id` is the path's; both ids go through `canonicalIdOf` before
the database. Whoever knows the two ids sees the picture, as the switcher's
and the cards' `<img>` need, and a later email or page elsewhere may
(`Cross-Origin-Resource-Policy: cross-origin`). A malformed id the route
receives, an old or removed logo's id, a deleted organization and bytes that
are gone answer the same plain-text `404` "Not found."; a URL the route
never receives answers as any API path does, in the JSON envelope (an
over-long id `414`, a malformed escape `400`, a missing or extra segment the
no-route `404`). The bytes go with the type stored at upload,
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`
whatever the type, so a picture opened on its own runs nothing, and
`Cache-Control: public, max-age=31536000, immutable`: a new upload is a new
id, and a replaced or removed logo's bytes are removed after the commit,
though a cache that kept them may still show them. 600 requests a minute per
address (`organizationLogosPerIp`); no `HEAD` route. The URL holds ids only,
so the request log needs no rule for it.

**Organization content on the web.** A logo is shown only as an
`<img alt="">` with `ph-no-capture` on the element itself (`AvatarImage`
carries it, `apps/web/app/components/ui/avatar.tsx`; shown by
`apps/web/app/components/org/OrganizationLogo.tsx`), falling back to the
initials when it fails to load; its URL holds ids only. It is never in a
title, aria-label, data-* attribute, toast, page title or analytics
property. **A logo's address appears only as the `src` of an `<img>` inside
`ph-no-capture`**: `AvatarImage` sets `fetchPriority="low"`, so React's
server rendering puts no `<link rel="preload">` for a logo in `<head>`,
outside `ph-no-capture`, where replay would record it; a request for a logo
that replay records (once the PostHog project turns network capture on) is
named `<origin>/api/v1/organization-logos/[redacted]`, never its ids
(`apps/web/app/lib/analytics.ts`, `withoutTokensInRequest`); and
`before_send` redacts a logo's address in any property's value, arrays
included (a web-vitals event's entries can carry an image's address). A
residue: a string with a tab or newline inside the word `organization-logos`
passes the redaction's cheap first check; only a crafted string can hold
one, since an address the browser requested arrives cleaned, and the image
itself stays blocked from replay. The picker's file input and the picked
file's name are inside `ph-no-capture` (replay records an input's
`C:\fakepath\<name>` value), and the preview is an object URL, revoked when
it is replaced, removed or closed. The logo's bytes and type reach no log
line; a removal that fails after a commit logs the organization's id and the
error's codes only.

## Library links

Paths below are under `telflo-core/`, but for `docker/` and `scripts/`, at
the repository's root. The signing key's rules are beside "The management
secret" above.

A library link lets whoever holds it download one library file without
signing in, for 24 hours, so it is a credential, as a quick-deploy link's
secret is. It is signed by the API rather than stored: no row holds it or
its hash.

- **Signed and checked by the API alone**
  (`apps/api/src/modules/library-files/link.ts`): an HMAC-SHA256 tag under
  the signing key, over a fixed domain string, a version, the file's id
  and the expiry. A check accepts only the canonical spelling (53 decoded
  bytes that re-encode to the same text; without that, a few one-character
  changes of a link would still verify), computes the tag under every key,
  current and previous, and compares each with `timingSafeEqual` without
  stopping at a match. A link of the wrong shape, one no key signed and
  one whose file is gone answer the same plain-text `404` "Not found."; an
  expired one `410`. Only the file's id and the expiry (for the per-link
  count) go on from a checked link, and only ids reach a log line.
- **Made for a member, in one reply.** `POST
  /api/v1/library-files/{fileId}/link`, for a member with the current
  terms (30 a minute per person), answers `201 { path }` with
  `Cache-Control: no-store`: the only reply that holds a link. The path
  has no host: the web puts the browser's own origin in front of it
  (`apps/web/app/components/library/LibraryPage.tsx`,
  `libraryFileCurlCommand(window.location.origin + path, …)`), which
  relies on the web and the API sharing one origin. Neither a link made
  nor a download through one is audited.
- **Ended only in bulk.** Deleting the file or retiring the key that signed
  it ends a link; a single link can't be revoked. A leaked link is ended by
  deleting the file and adding it again, or by a key rotation that skips
  the previous list, which ends every link.
- **The public download's pattern** ("The public download" above): `GET
  /api/v1/library-links/{link}` is registered outside the session's hooks
  (no `authenticate`, no cookie read, no CSRF header), with
  `exposeHeadRoute: false`; limited before anything is read, 30 a minute
  per address as its `onRequest` hook, then, once the link is checked, 60
  a minute per link counted by the file's id and the expiry (never the
  link), then one of 8 places in flight per process, held until the
  reply's socket closes (the body streams up to 10 MiB after the handler
  returns). Every refusal is plain text
  (`createPublicDownloadErrorHandler`). The bytes go as
  `application/octet-stream` with `nosniff`, `no-store`,
  `Content-Disposition: attachment` with no file name (no person's text in
  a header) and `Referrer-Policy: no-referrer`.
- **Copy curl's command**: `curl -fL '<link>' -o '<file name>'`, both
  values single-quoted by `shellQuote`
  (`packages/contracts/src/library-files.ts`, `libraryFileCurlCommand`),
  so nothing in either expands when pasted into a POSIX shell. The file's
  name is refused at upload when it holds a control character (Unicode's
  `Cc`) or a bidirectional or invisible formatting character (U+061C,
  U+200B, U+200E, U+200F, U+202A–U+202E, U+2060, U+2066–U+2069, U+FEFF;
  ZWNJ, ZWJ and the soft hyphen stay allowed), `/` or `\`, is `.` or `..`,
  or starts with `-` (`libraryFileFileNameProblem`: real curl wrote
  outside the working directory for a `/`, and to stdout for `-`). The
  link is visible in the process list while curl runs (accepted). The
  command holds the link, so it is the same secret. **Kept out of the
  logs.** The invariant, as for API tokens' `tf_`: **no logged field
  holding a client-supplied value carries `tll_`**.
- **The API's request log** (`apps/api/src/http/request-log.ts`): a URL
  whose matched route is the link's, a spelling of whose path (as sent,
  percent-decoded once, runs of `/` made one) holds a `/library-links`
  segment, or a spelling of which holds `tll_`, case aside, is logged as
  `/api/v1/library-links/[redacted]`, query and all, checked right after
  the quick-deploy rule (`loggedRequestUrl`). `loggedClientField` writes
  `[redacted]` for the `Accept-Version` header, the host or the address
  when a spelling of it holds `tll_`, as for `tf_`. A framework error on
  such a URL (`apps/api/src/errors.ts`, `respondToFrameworkError`, through
  `urlMayHoldPublicLinkSecret`) answers the public route's plain text and
  logs its code only. The library's errors name no file, name or link.
- **The gateway's access log** (`docker/gateway/default.conf`): a request
  whose path as nginx routes it holds a `/library-links` segment (or ends
  in `/library-links`) or `tll_`, or whose raw request line holds `tll_`
  with any of its letters percent-encoded or not, case aside, is logged
  `"METHOD /api/v1/library-links/[redacted] PROTOCOL"` (the quick-deploy
  line when it holds a `tqd_` too); a Referer holding `tll_` or
  `/library-links`, and a `User-Agent` or an `X-Forwarded-For` holding
  `tll_`, are logged `[redacted]`. Its locations come in a binding order
  (another order can leak a link into the error log): the quick-deploy API
  location; an `/api/` path holding a `/library-links` segment or `tll_`,
  to the API, its errors logged at `crit` only; the quick-deploy `404`; a
  `/library-links` path outside `/api/`, nginx's own plain-text `404`,
  never sent to the web app; a `tqd_` web path; a `tll_` elsewhere in a
  web path, to the web app, `crit` only. `scripts/check-gateway-logs.sh`
  runs the `tll_` cases in the real image.
- **The residues**, as quick-deploy's ("A link's secret is cut from the
  logs, but for the residues below"). **nginx's error log for an ordinary
  path** quotes the request line and the Referer when that path's upstream
  fails, and its format can't change: a link pasted into an ordinary API
  path's query (`/api/v1/organizations?x=tll_…`), into a web page's query
  (`/register?s=tll_…`), or sent as the Referer of another path is quoted
  there (the access log still redacts each). **Spellings nginx doesn't
  decode**: a prefix percent-encoded twice (`%2574ll_`) is logged as sent
  by the gateway; the API's request log, which reads a spelling as sent
  and decoded once, keeps it on any path but the link's route or a
  `/library-links` path, routed or not (but in a query it drops anyway: an
  OIDC, configurations-list or fleet route's), and the no-route `404`'s
  reply echoes it to its sender; only a client crafting the URL sends one.
  **A validation `400` echoes a pasted `tll_` back to its sender only**: a
  link sent as a key of a JSON body whose schema refuses unknown keys
  comes back in the reply's `details` (zod's unrecognized key); the sender
  already holds it, and the reply is never logged
  (`apps/api/src/errors.ts`). **The copied command stays in the person's
  shell history**, link and all; it is usable until the link expires.
  **Vite's development server** prints a link it fails to pass to the API,
  in development and the browser tests only ("A residue of both kinds of
  link" above). **A load balancer, CDN or proxy the platform doesn't
  configure** logs the link as sent unless it is told not to.
- **Nowhere else:** never in an error message, a span, an audit row, a
  toast, an attribute, browser storage, an analytics property, a report, a
  commit or a test's printed output. On the web the link and the command
  exist only in the link request's reply body and the clipboard, never the
  DOM or a state: Copy curl builds the command inside the promise it hands
  to `copyTextFromPromise`
  (`apps/web/app/components/library/LibraryPage.tsx`). Analytics redacts
  `tll_` and a `/library-links` path as it does `tqd_`
  (`apps/web/app/lib/analytics.ts`): in page URLs, every URL property,
  autocapture's element chain and replay's recorded requests, and PostHog
  never starts in a document whose address or referrer holds one. Tests
  check a link with boolean canaries (`includes`, `test`), never a matcher
  that could print one; hand-written `tll_FAKE…` fixtures are not links.
  Gate logs and reports are searched with `tll_[A-Za-z0-9_-]+` and the
  key's variables.

**The library's content**: names, descriptions and file names are Telflo's
own content. On the web they are only text inside the masked shell
(`apps/web/app/components/library/columns.tsx`, the admin page's table and
dialogs), never an attribute or a toast (each row's buttons are described
by the name's text through `aria-describedby`); they are never in an audit
row (`library_file.updated` holds `changedFields`, the fields' names) or a
log line. The API puts no file name in a header (a download's
`Content-Disposition` is a bare `attachment`): the web names the saved
file from the list's `fileName`, on a detached anchor
(`apps/web/app/lib/download.ts`, `downloadBlob`), and curl names it by
`-o`. Any type is accepted, at most 10 MiB (`413 library_file_too_large`;
the gateway takes 11 MiB on the create path only), and only product admins
write.

## Product administration: other people's personal data

Paths below are under `telflo-core/`, but for `docker/` and `scripts/`, at
the repository's root. The path itself (the context, the functions, the
audit) is the cross-organization path under "Authorization model" above.

A product admin sees other people's personal data across every
organization: their emails, organization names and roles, the feedback
they sent, the reply typed to them, and the email typed to confirm a
delete or to grant the flag. All of it is personal data, as a person's own
account data is.

- **On the web** (`apps/web/app/components/admin/UsersAdminPage.tsx`,
  `UserDeleteDialog.tsx`, `ProductAdminsPage.tsx`,
  `UserFeedbackAdminPage.tsx`, `components/feedback/ContactUsDialog.tsx`):
  visible text only inside `ph-mask`, which the shell puts on its root and
  on `<body>`, where Radix portals its dialogs and the toasts
  (`components/layout/AppLayout.tsx`). Where it is typed (the Users
  search, the delete's confirmation, the grant's email, "Contact us"'s
  textarea and the acknowledgement's reply) the field is uncontrolled,
  inside `ph-no-capture`: no `value` attribute holds the text (the Users
  search keeps its term in React state only, for its re-reads).
  Never in an aria-label, title, alt, placeholder, data-* attribute, the
  page's address (routes take ids; the search's term is never in the
  address bar), a toast or page title (fixed words), browser storage or an
  analytics property. Row actions (Delete, Remove, Acknowledge, Dismiss) are
  named through `aria-labelledby`, by a fixed-word span and the row's email
  cell, so the attribute holds ids only. The truncated feedback's button
  has no `title` (it would hold the text).
- **In the API:** never in a log line, an error's message or `details`
  (`user_delete_blocked` carries the block's kind only), a span, or audit
  `metadata` (the existing `actor_email` column only). The Users search
  reaches the API as the query `q`, which **the request log drops** for
  every `/api/v1/product-admin/` route, by its matched route and by its
  path as sent, case aside (`apps/api/src/http/request-log.ts`,
  `isProductAdminRoute`, `isProductAdminPath`), as the fleets' rule. The
  deletion record's original email is written once by the delete function
  and never read by the API's role.
- **In the gateway** (`docker/gateway/default.conf`): the access log writes
  any request whose path as nginx routes it (`$uri`) begins
  `/api/v1/product-admin`, case aside, as `"METHOD $uri PROTOCOL"`, never
  its query (a quick-deploy, library-link, public or `tf_` line wins over
  it); those requests have a location of their own, `location ~
  ^/api/v1/product-admin(/|$)`, after the four secret locations, whose
  error log keeps `crit` and worse only, since nginx quotes the request
  line, query included, when the API can't be reached.
  `scripts/check-gateway-logs.sh` runs the cases in the real image (a term
  in every spelling, upstream up and down), and the stack smoke counts the
  search's term in both logs (none) and the search's path-only line.
- **The emails** (`apps/api/src/modules/feedback/emails.ts`): each product
  admin, separately, is told who sent a new message ("Requested by:
  <email>") and where to review it, never the text (the builder isn't given
  it); the acknowledgement's reply goes to its one sender and is never
  stored. Each send runs in its own `try/catch` after the response and a
  failed one logs ids and fixed words only, never the error (an SMTP or
  SendGrid error can quote the recipient); one admin's failure doesn't stop
  the others (`modules/feedback/service.ts`,
  `modules/product-admin/feedback-admin-service.ts`).
- **After a person's delete** their original address remains only in
  `user_deletion_records.original_email` (their row), the audit log as a
  whole (append-only: `actor_email` and metadata derived from it, such as
  invitations', sales inquiries' and a renamed personal organization's)
  and `organization_invitations.email` in organizations not deleted with
  them (those deleted with them have their invitations to it anonymized).
  Their deleted personal organization takes the anonymous address's
  workspace name, their sessions hold no IP address or user agent, and
  their own audit rows keep theirs (append-only).
- **Tests** check emails and feedback text with boolean canaries only (a
  seeded value matched with `includes` or `test`, never `toEqual`,
  `toContain` on a value, `toHaveText` or a snapshot of another person's
  data). In the browser no page showing another person's data is open
  when an assertion can fail: privacy checks collect
  (`e2e/support/privacy.ts`, `maskedPlacesOf`), go to `about:blank`, then
  assert. Reports and logs never quote a seeded person's email or feedback
  text.
- **The residues**:
  - **a path in another case**: `/API/V1/PRODUCT-ADMIN/…?q=` isn't an API
    path to nginx's `/api/` prefix or the API's router (both
    case-sensitive), so it goes to the web app; the access log drops its
    query (the map is case-insensitive), the web app's own server logs no
    request's URL, and with the web app down nginx's error log quotes it.
    `/api/v1/PRODUCT-ADMIN/…?q=` reaches the API's `/api/` location
    instead of the product-admin one (case-sensitive), so with the API
    down nginx's error log quotes it there (the API itself answers 404 and
    logs the path only). Only the sender's own text, on a path no client
    uses;
  - **an organization created at the instant of a delete**: a person
    creating an organization at the very moment of their delete may leave
    a live organization whose only member is the deleted account; nobody
    can sign in to it. Joining one is refused: an invitation's acceptance
    and an admin's restore of a removed member lock the person's row after
    the organization and answer 401 and 404 `member_not_found` for a
    deleted account;
  - **a failed browser run's output**: ordinary locators on the
    product-admin pages name synthetic `e2e-<uuid>@example.com` addresses
    in a failed run's messages, `error-context.md` and traces (fixtures,
    no real person).

## The playground's open reads

Paths below are under `telflo-core/`, but for `docker/`, at the
repository's root.

The playground (`/playground…`) and the blank `/public-editor` serve
anonymous visitors: no account, no organization. They call the platform
for two things only, so their exposure is two open routes. *(All of it is
off by default: the pages with `TELFLO_PLAYGROUND`, the anonymous validate
with `TELFLO_ANONYMOUS_VALIDATE`, the open flow reads and the showcase
with `TELFLO_PUBLIC_FLOWS`, each answering 404 while off; "The open-source
product" below.)*

- **The request allowlist**: on every playground page and the blank public
  editor, the only `/api/` requests are `POST
  /api/public/v1/validate/anonymous` (above), `GET
  /api/v1/published-flows` and `GET /api/v1/published-flows/:slug`, each
  with no query. Everything else the page loads is the web's own (GET or
  HEAD of a web-origin path outside `/api/`, judged after decoding; a page
  document or `.data` read only of `/playground…` or `/public-editor`,
  since a signed-in page's loaders read the session; any other web-origin
  fetch only of a playground page; and a web-origin HTML answer or
  redirect outside the playground's pages is outside whatever its path or
  type), and analytics go to PostHog's origin only, per consent. No `/me`,
  no refresh, no configuration, fleet, testing, rules, regex, catalog or
  organization read, no write: the sample workspace answers every reused
  reader in the browser (`apps/web/app/lib/workspace-reads.ts`). The
  browser specs record every request against this exact list
  (`e2e/support/playground.ts`'s `PLAYGROUND_API_ALLOWLIST`, a list of
  method and path pattern, never a deny-list), and a missed seam can't
  send the browser to `/login`: the playground suspends the session-ended
  handler while mounted. A route added to the playground's calls is added
  to that list and to this section together.
- **The open flow read** (`apps/api/src/modules/flows/routes.ts`): `GET
  /api/v1/published-flows` (`{ flows }`) and `GET
  /api/v1/published-flows/:slug` (`{ flow }`), for the playground's
  gallery and a flow's page.
  - **No session**: no preHandler; a cookie sent is never read. The flow
    service reads with `publicFlowReader` (never a product admin), so a
    hidden flow is never listed and its slug is 404 `flow_not_found`,
    exactly as an unknown one (no existence leak), whoever asks.
  - **What it answers** (`PublishedFlowSchema`, strict): a published flow
    in full, YAML included, but its id, `published`, `sortOrder` and
    `createdAt`. Flows are Telflo's catalog content, public once
    published; nothing of an organization's is there.
  - **Never from a cache**: every reply, the 200s, the 404 and the 429,
    carries `Cache-Control: no-store` (a route `onSend`), so a flow hidden
    since is never served from a copy.
  - **Its limit** (`apps/api/src/http/rate-limits.ts`,
    `publishedFlowReadsPerIp`): 60 requests a minute per address
    (`request.ip`) over both routes together, one bucket, counted in an
    `onRequest` hook before anything is read (an unknown slug's request
    counts); past it, 429 `rate_limited` with `Retry-After`. The
    playground reads it from the visitor's browser only, never in a server
    loader, so the count is the visitor's, never the web server's own
    address. As every limit, it is each API process's own and needs
    `TELFLO_TRUST_PROXY_HOPS` to match the proxies. The showcase (`GET
    /api/v1/flow-showcase`, cards with no YAML) keeps no limit: the web
    server calls it for every landing view. *(The platform answers it only
    with `TELFLO_PUBLIC_FLOWS` on.)*
  - **Its record** is the request log's line only: the method, the route's
    pattern (`/api/v1/published-flows` or `/api/v1/published-flows/:slug`)
    and the status; never the slug as sent nor a query, matched or not (a
    spelling under the prefix that matches no route logs the pattern it
    falls under: the list's when it normalizes to the list's path, else
    the slug's, in any decoding (as sent or after each of up to three
    rounds), a `..` resolving outside the prefix, or a `;`, `?` or `#`
    after the prefix once decoded, included;
    `apps/api/src/http/request-log.ts`). No audit row; the YAML never
    reaches a log line.
  - **The gateway's access log** writes the list and
    `/api/v1/published-flows/:slug` by pattern, as the request log does,
    never a slug as sent nor a query, and its location logs `crit` and
    worse only ("The gateway's maps and `extraRoutes`" below). The body
    limit is the server's 1 MiB.
- **A visitor's text**: the YAML typed in the playground's editor and a
  name typed for Save are configuration text, under every rule for it;
  neither open read carries it (the slug, taken from the page's own
  address, is all the open read's path holds, and the API's log never
  keeps it).
- **The staged edit**: the visitor's text kept in this browser's
  localStorage under one key, at most 7 days, sent only by the dialog's
  Save, and removed by Save, Discard and every client-side sign-out
  (`lib/signed-out.ts`). A browser whose cookies have lapsed keeps it.

## The open-source product

Paths below are under `telflo-core/`, but for `charts/`, `scripts/` and
`docker/`, at the repository's root. The operator's view is
`docs/configuration.md` ("The site", "Mail", "Administration":
`telflo-admin bootstrap`) and the chart's README.

### The first product admin

An install whose registration isn't open makes its first product admin
with `telflo-admin bootstrap`:

- **The function**
  (`packages/db/migrations/1700000000043_first_product_admin.js`):
  `bootstrap_first_product_admin(p_user_id, p_at)`, `SECURITY DEFINER`,
  owned by the migration role (the tables' owner, so the flag's owner-only
  trigger lets it set the flag), `search_path = pg_catalog, platform` with
  schema-qualified tables, `EXECUTE` revoked from `public` and granted to
  `telflo_platform_runtime` only (041's pattern). In order: `22023` for a
  null argument; a **transaction advisory lock** on one constant key, so
  concurrent calls run one after the other and the second sees the first's
  flag (not a table lock: the command's own insert would deadlock two
  bootstraps); `42501` with HINT `telflo_product_admin_exists` when
  **any** user holds the flag, deleted or not; `42501` with HINT
  `telflo_bootstrap_user_not_found` unless the user is a live human (never
  a service account); otherwise the flag and an audit row,
  `product_admin.bootstrapped`, the user as actor and subject, at the
  API's time. Its messages are fixed words, never an email or an id.
- **The command** (`apps/api/src/admin/`; the image's `telflo-admin`) runs
  with the API's settings and its role (`telflo_platform`); it has no
  mailer of the API's (the organization and reset services it builds get
  `REFUSING_MAILER`, which refuses every send). The account and the
  function's call share one transaction, through
  `AccountWrites.bootstrapFirstProductAdmin` inside `createAccount`'s
  `onCreated`, so a refusal rolls the account back. It never reads
  `is_product_admin` (`database/context-source.test.ts` pins which files
  may): "an admin exists" is the function's HINT, first asked with a
  random id in a transaction that is rolled back: the call takes the
  function's advisory lock and that rollback releases it, so it holds no
  lock afterwards and writes nothing that stays
  (`identity/repositories/user-repository.ts`). It writes registration's
  audit rows (`user.registered` with `via: "bootstrap"`,
  `organization.created`, `organization_member.added`) and takes its link
  from the password reset's service, so the link is the reset's: the token
  stored as its hash, 60 minutes, used once, the earlier ones consumed. It
  prints fixed lines and the address typed, never a token, and the link
  only as its last line (below); exit 0 done, 1 refused, the address
  taken, or the organization or the link failing, 2 usage (an unknown
  option, `--print-link` among them).
- **The link, always printed, never mailed.** The command always prints
  the link **once, on standard output, as its last line**, after a fixed
  line, and sends nothing (its mailer refuses, so none can leave).
  `IPasswordResetService.issueResetLink` hands back requestReset's token
  as its link (one `issue` behind both, no second token logic) and audits
  `user.password_reset_requested` with `{ outcome: "returned" }`, never
  the link. The printed link is a secret, a way into the first product
  admin's account until it is used or its 60 minutes pass: the terminal
  only. It never reaches a log line (the command has no logger; the API's
  request log never sees it, its token travels in the reset's request
  body), an error, an audit row or standard error. Under Kubernetes
  `kubectl exec`'s output goes back to the caller alone and never into the
  pod's logs; don't run it where output is kept (a CI job's log, a
  recorded session).
- **`telflo-admin reset-link --email <address>`.** A lost or expired
  printed link's way back without mail: a fresh link for a live person's
  account through the same `issueResetLink` (the account's earlier links
  consumed), printed as `bootstrap` prints one (the fixed line, then the
  link as stdout's last line), no email (its mailer refuses), in every
  registration mode. Audited `user.password_reset_requested` `{ outcome:
  "returned", via: "admin_command" }`, never the link (the bootstrap's own
  request stays `{ outcome: "returned" }`). The same
  secret-on-the-terminal rules as the bootstrap's link. It works for
  **any** person's account: **anyone who can exec into the API's container
  can reset any account's password**, as they can already reach the
  database as `telflo_platform` (and read the settings' secrets); exec
  access to the API is administrator access. An address with no live
  person's account, a service account's or a deleted account's included,
  is refused (exit 1) in one fixed line, before anything is written (no
  token, no audit row), so the command tells such an operator nothing they
  couldn't read already. Its option reading is `bootstrap`'s (strict, each
  option once, exit 2).
- **The trade.** The API's role may call the function, so **while no
  product admin exists, any SQL run as `telflo_platform` can make any live
  person the first product admin.** It is the price of the command running
  as the API's role rather than the migration role's; the probe above adds
  no oracle (`telflo_platform` can already read the flag). The window
  closes for good when the first admin exists (the function counts deleted
  admins too): the README tells operators to run the bootstrap at once
  after an install.
- **Tests:** the function's own (`apps/api/src/tenancy/`), the first call,
  each refusal, the trigger still refusing a direct update, and a race of
  two connections; the command's paths, with a command-level race (an
  owner's connection holds the lock until both runs wait at it: one exits
  0, one 1, one user, one audit row, the winner's link, no mail).
  Deliberate breaks: the function without its lock (both race tests fail),
  without its "admin exists" check. The link's tests
  (`admin/bootstrap.integration.test.ts`) check it with boolean canaries
  only: one link line, the last; none on stderr, in a stray console or
  process write, an audit row, the token table (hash only) or the API's
  log while it is completed; no email (`REFUSING_MAILER.send` never
  called, Mailpit empty); the password set, the email confirmed, a sign-in
  landing in the bootstrap's organization, a second use refused; the
  refusals print no link; a link that can't be made (its insert refused)
  exits 1 with a fixed line and no link; `--print-link` is refused as a
  usage error (`admin/bootstrap.test.ts`). Deliberate break: the link
  written to the console too fails the canary test. `reset-link`'s tests
  (the same file): two lines, the link last, a new token; nothing on
  stderr, in stray output, the audit rows or the API's log; no email
  (every registration mode); the earlier link refused, the new one setting
  the password once; unknown, deleted and service-account addresses exit 1
  with nothing printed or written. Deliberate break: `findByEmail` without
  its account-kind check fails the service-account case.

### Registration, Terms and the switches

- **Registration modes**
  (`apps/api/src/modules/identity/registration.ts`): `invite-only` and
  `closed` refuse `POST /api/v1/auth/register`, and `closed` also `POST
  /api/v1/invitation-registrations`, with `403 registration_not_open` in
  fixed words, from an `onRequest` hook **first in the route's array**:
  after the global CSRF guard, before the per-IP limit counts the request
  and before its body is read, parsed or validated (a malformed or 2 MB
  body is refused alike). Deliberate break: the gate as a `preHandler`
  answers 400 for an invalid body. An OIDC sign-in with no matching
  account is refused with the same code where registration isn't open,
  creating nothing; linking and taking over an existing account work in
  every mode. **Accepted residue:** under `invite-only` with Google on, a
  new invitee's "Sign in with Google" on the invitation page is refused
  like any sign-in with no account; they register with a password.
- **Who may bring new people in.** Invite-only means someone already on
  the site has to invite you, through an organization: every account is
  the admin of its own personal workspace, but unless registration is
  `open` a personal workspace invites no one (below). With the switch
  below off, anyone with an account can create an organization and invite
  people into it. Turn the switch on to keep that to product admins; it is
  on by default. Three guards:
  - **The switch**, "Only product admins can create organizations"
    (migration 044's one-row `site_settings`, `product_admins` by default,
    in every registration mode; the tests' baseline, set by `truncateAll`
    and the browser tests' global setup, is `everyone`). The API's role
    reads the row and changes it only through
    `product_admin_set_organization_creation`, migration 041's pattern
    (definer, `assert_product_admin()` first, the row then the caller
    locked, `forbidden` when the caller lost the flag), called from the
    SystemRepository alone (`context-source.test.ts`), which audits
    `product_admin.organization_creation_changed` or `…_unchanged` with `{
    from, to }` (fixed values). `GET`/`PATCH
    /api/v1/product-admin/settings` behind `requireProductAdmin`. On,
    `create()` refuses anyone but a product admin (the flag as the
    request's session check read it) with 403
    `organization_creation_restricted`, before any id is picked or logo
    byte written; a switch turned on while a create is past that check
    lets that one through (accepted). Organizations that already exist are
    untouched: their admins keep inviting. `/me`'s
    `mayCreateOrganizations` drives the disabled "Create Organization".
  - **Under `invite-only`, a personal organization's invitation never
    makes an account**: `POST /api/v1/invitation-registrations` answers
    403 `registration_not_open` (its own fixed words) once the token has
    found a live, pending invitation (a bad, expired or accepted one
    answers as in any mode), before the address is looked up or anything
    is written. An existing account still accepts it, signed in. The
    preview's `mayRegister` (the mode and the organization's type, nothing
    about the address) has the page offer sign-in only. A personal
    organization sends no invitation under `invite-only` (below), so this
    is the backstop for invitations sent while the site was open. An
    inviter still never learns whether an address has an account.
  - **Unless registration is `open`, a personal organization sends no
    invitation**: `invite()` and `resendInvitation()` answer 403
    `personal_organization_invitations_disabled` (fixed words, the
    contracts' `PERSONAL_ORGANIZATION_INVITATIONS_DISABLED_MESSAGE`) under
    the organization's lock, where its type is read: after the request's
    role and the per-inviter mail limit (which counts it, as every refusal
    past the role), before anything is written, so no row, no audit row
    and no email. Listing and canceling stay open, so leftover
    invitations can be cleared. The mode is the API's settings
    (`site.registration`, fixed per process); `mayInviteFrom` in the
    contracts is the one rule the API and the web share. The web hides
    Invite Member and Resend there and says why in the button's place, and
    its sidebar leaves Permissions out (`/org-admin` stays reachable by
    address for leftovers). Tests:
    `tenancy/product-admin-functions.integration.test.ts` (the function
    under every refused context, its race, its answers, the table's writes
    refused), the SystemRepository's audits,
    `product-admin/settings-routes.integration.test.ts`,
    `invitations.integration.test.ts`'s registration-mode block,
    `service.test.ts`'s personal-organization block, and
    `e2e/organization-creation.e2e.ts`. Deliberate breaks: the create
    without its check; the registration without its check; the invite
    without its check.
- **Terms are generic**: the version is the site's setting, not a
  constant. With none set, the session check answers "Terms satisfied"
  (`requireCurrentTerms` passes), `/me` answers `termsAcceptanceRequired:
  false`, registration and invitation registration ask for nothing and
  store `null`, and the acceptance `PUT` answers 400
  `terms_version_not_current`. With one set, the terms are checked against
  it. The Terms, privacy and cookie-policy URLs are `https` or a path with
  a single leading `/`, of URL characters only (`SITE_URL_PATTERN` in
  `packages/contracts/src/site.ts`, the chart's guard the same pattern):
  no `//host`, `/\host`, `javascript:`, user name, space or newline. Their
  links open in a new tab with `rel="noopener noreferrer"`.
- **A switched-off route is not there**. The API's `notFoundWhen(off)`
  (`apps/api/src/http/not-found-when.ts`) is an `onRequest` hook first in
  each switched route's array (before the per-IP limits): off, it answers
  exactly as an unknown `/api/v1` path, 404 `not_found`; the routes stay
  registered (the anonymous validate stays in the public plugin's open
  list). The web's switched pages throw a 404 from a **server** loader
  (`notFoundUnless`, `apps/web/app/lib/site.server.ts`), never a client
  loader, so a document request and a client navigation's data request
  both answer 404. **Accepted:** with anonymous validate off, its path
  answers 404 where another unknown public POST answers the public
  plugin's 401.
- **The site's values are no secret**: the root loader sends the whole
  `site` object to every browser.

### Mail through a real relay

`apps/api/src/mail/smtp-mailer.ts`:

- **The relay's certificate is always checked**: `tls.rejectUnauthorized`
  is the literal `true`, and Node's host-name check runs. `starttls` (the
  default) sets `requireTLS`, so a relay that can't upgrade gets nothing in
  clear; `implicit` is TLS from the first byte.
- **A private CA replaces the system's roots, for this connection only**:
  `TELFLO_SMTP_CA_FILE`'s certificates go to the transport's `tls.ca`,
  never to `NODE_EXTRA_CA_CERTS`, which would widen every connection the
  API makes. A site that sets one trusts exactly it. The file is read
  once, at boot, and must be **bare PEM certificate blocks only**: no
  private key, no other block, no stray text, each block a certificate
  `node:crypto` parses; its refusal names the variable, never the file's
  text. In the chart, `api.mail.smtp.caSecret`'s `ca.crt` alone, mounted
  read-only (0444).
- **Cleartext is opt-in and loopback-bound.** `none` to a host outside the
  exact set `localhost`, `127.0.0.1`, `::1` (as written: `LOCALHOST`,
  `[::1]`, `127.0.0.2`, `::ffff:127.0.0.1` and names that resolve to the
  machine are outside it) needs `TELFLO_SMTP_ALLOW_INSECURE=true`; **a
  login with `none` off loopback is refused even with the override**: it
  would put the relay's credentials on the wire. Both refusals are thrown
  when the mailer is built, at boot.
- **The login is a secret.** Its two variables are set together or not at
  all (one alone refuses to boot); in the chart they come only from the
  mail Secret's `smtp-username` and `smtp-password` by `secretKeyRef`, and
  `create-secrets.sh` writes them as it writes every key (never on argv or
  in output). nodemailer runs with no logger and no debug.
- **A failed send is fixed words** (`SmtpSendError`): nodemailer's code
  and the relay's numeric reply code only, never nodemailer's message, the
  relay's reply text, the command, the recipient or a `cause` (a relay's
  reply can quote the username or the address).
- **Bounded waits**: 10 s to connect, 10 s for the greeting, 60 s of
  silence, where nodemailer's own are 2 minutes, 30 s and 10 minutes.
- **Tests** run an in-process relay (`apps/api/src/testing/smtp-relay.ts`,
  `node:net` and `node:tls` only) with STARTTLS or implicit TLS and AUTH
  PLAIN and LOGIN after TLS only, on certificates the `openssl` CLI makes
  at test time (`docs/conventions/testing.md`, "The SMTP test relay"); no
  key is committed. Deliberate breaks: `rejectUnauthorized: false` (4
  failures), `requireTLS` removed, the CA dropped, a no-op
  `checkServerIdentity` (the foreign-name certificate cases fail).

### The gateway's maps and `extraRoutes`

- **Three more requests lose their query in the access log**
  (`docker/gateway/default.conf`, the chart's copy byte for byte): any
  path as nginx routes it (`$uri`), case aside, under
  `/api/v1/organizations/<id>/fleets` (a collector search's `q`, a
  name-sorted cursor) or for the configurations list (`…/configurations`,
  a trailing slash or not; its `q`) is logged `"METHOD $uri PROTOCOL"`, as
  product administration's. A request under `/api/v1/published-flows` is
  logged by pattern, as the API's request log logs it: the list, or
  `/api/v1/published-flows/:slug` for anything after it (a slash, a `;`, a
  `?` or `#` decoded from the path, or any of them percent-encoded once or
  more), never a slug as sent nor a query. Their locations log `crit` and
  worse only (an upstream's failure would quote the request line), the
  configurations list's create (5 MiB) included. A quick-deploy,
  library-link, public or `tf_` line wins over each. Deliberate break: the
  fleets line of the map removed (6 failures in `check-gateway-logs.sh`).
- **Their residues:**
  - **another case** (as product administration's): `/API/V1/…/FLEETS?q=`
    drops its query from the access log (the maps are case-insensitive),
    but the case-sensitive locations miss it, so with its upstream down
    nginx's error log quotes it;
  - **an encoded slash inside the organization's segment**:
    `/api/v1/organizations/a%2Fb/fleets?q=…` is `a/b` to nginx's `$uri`,
    so the map's single `[^/]+` segment doesn't match and the access line
    keeps its query. The API answers 400 (the id isn't a uuid); such a
    path never names a real organization. The pattern stays `[^/]+`: a
    looser one would match across segments.
- **`gateway.extraRoutes`**: a site's own pages, routed by the gateway to
  another Service in the namespace. The chart renders each entry into
  `telflo-gateway-extra-routes` (mounted read-only, 0444, at the exact
  path `default.conf` includes: a missing file stops nginx), `location =`
  or `location ^~`, each with `error_log … crit` and `proxy_pass` to
  `<service>.<namespace>.svc:<port>`. Every value is checked twice (the
  schema, then a guard that fails the render, for one that skips the
  schema): a path of `/` and `[A-Za-z0-9._~/-]`, at most 200 characters,
  with no empty, `.` or `..` segment; a Service's DNS label; a port a
  number from 1 to 65535. **The shadow guard** refuses, in lower case
  (React Router matches without case), a prefix `/`, and any path equal to
  one of the platform's first segments, under it, beside it
  (`/login.data`) or, for a prefix, one they start with; a render case
  holds that list equal to `routes.ts`, `public/` and the gateway's own
  paths, so a new route can't slip past it. `/robots.txt` stays outside
  the list (the site serves its own). Deliberate breaks: a root dropped
  from the list, the `/R.` rule or the lower-casing removed, the mode 0644
  (each fails its case). **Residues:** the routed Service receives the
  request's URI as sent, unnormalized, and must check it itself; `/home`
  answers nginx's absolute 301 (as `/api` does); a `^~` route takes its
  paths ahead of the gateway's regex locations (`/home/quick-deploy/…`
  reaches the site, its access line still redacted); the Service's own
  NetworkPolicy must admit the gateway's pods.

### Large bodies before authentication

The configurations create, a version's save and create, a validation, the
flows' product-admin writes and the test runs' queue run `authenticate` in
`onRequest`, so a signed-out request is refused (401) before its body is
read or parsed; the role and Terms checks stay in `preHandler` in their
order. An unauthenticated body over a route's limit answers 401 from the
API (through the gateway, nginx's own 413 first: its limits equal the
API's), an authenticated one
413. Deliberate break: one route back to `preHandler` (its 401 cases
fail).

### No analytics key

`scripts/check-no-analytics-key.sh`, a static gate, fails on a PostHog
project or personal key (`ph[cx]_` and 32 or more letters and digits) in
any file git tracks, printing `file:count` only, never the line; exit 2
when it can't read the checkout. Its self-test makes a key at run time and
never prints it. The chart's, compose's and `.env.example`'s PostHog
values stay empty.

### The secret scan

`scripts/release/check-secrets.sh`, a static gate and the release
workflow's first check, runs gitleaks (pinned and sha256-checked in
`scripts/release/tools.lock`) with its default rules over every file git
would commit, printing fingerprints only (`--redact`). `.gitleaksignore`
lists the findings reviewed as test fixtures or development-only values,
and nothing else: a finding it doesn't list fails, and so does a listed one
gitleaks no longer finds. A real credential found is removed and rotated,
never listed. `docs/conventions/testing.md`, "The secret scan", has the
details.

## Kubernetes

The chart is `charts/telflo`; its `README.md` is the operator's view.
Paths below are under `telflo-core/`, but for `charts/`, `scripts/`,
`docker/` and `services/`, at the repository's root.

### The Secrets

The chart reads seven Secrets, each by a name in its values (these are
the defaults; the keys are fixed):

| Secret | Keys | Read by |
|---|---|---|
| `telflo-postgres` | `postgres-password`, `owner-password`, `api-password` | Postgres (`postgres-password`, `owner-password`); the migrate init container (`owner-password`, `api-password`); the API (`api-password`) |
| `telflo-opamp-server` (the opamp-server chart's `auth.existingSecret`) | `owner-password`, `runtime-password`, `management-secret`, `encryption-key`, optional `management-secrets-previous` and `encryption-keys-previous` | the opamp-server; Postgres (the opamp bootstrap); the API (`management-secret` only) |
| `telflo-api` | `access-token-secret`, `quick-deploy-encryption-key`, `library-link-signing-key`, optional `quick-deploy-previous-encryption-keys` and `library-link-signing-keys-previous` | the API |
| `telflo-internal-services` | `otelcol-validator-secret`, `otelcol-testing-secret`, `ottl-evaluator-secret` | the API (all three); each service only its own (the tester and the evaluator as a file) |
| `telflo-oidc-google` (optional) | `client-id`, `client-secret` | the API |
| `telflo-mail` (optional) | `sendgrid-api-key`; `smtp-username` and `smtp-password` | the API |
| `ghcr-pull` (optional) | `.dockerconfigjson` | the pods' `imagePullSecrets`, only when the two lists name it (both default to `[]`: "The pull secret" below) |

The API may also mount `api.mail.smtp.caSecret`'s `ca.crt`, a private
relay's CA: no secret, read-only (0444), its key alone ("Mail through a
real relay" above).

Each container gets only its own credentials. The superuser's password is
only in Postgres's container. The owner's database URL is only in the
API's migrate init container, never in the API's own container. The tester
and the evaluator read their secret from a projected file (mode 0440, the
service's group), never from their environment: the tester refuses a
secret there (`services/otelcol-testing/app/settings.py`), and the
evaluator reads only the file (`LoadSecrets` in
`services/ottl-evaluator/internal/server/secrets.go`). The validator reads
its own from its environment.

**Database URLs are composed, never rendered.** A container's URL names
its password variable (`$(TELFLO_API_PASSWORD)`), which Kubernetes fills
in from the `secretKeyRef` listed before it. The five Postgres passwords
must be URL-safe (`A-Z a-z 0-9 . _ ~ -`): Node's URL error quotes the
whole URL, password and all. So `create-secrets.sh` generates hex and
refuses any other, and Postgres and the API's two containers check theirs
before they start, with a fixed message.

### Secret names only, never values

- **No template renders a `kind: Secret`**, and no value holds a secret.
  The render tests refuse a rendered Secret, and the kind smoke checks
  `helm template` again, then searches every pod's log and Helm's release
  record for each secret (by boolean).
- **A Secret's name is checked as a name** (`checkedSecretName` in
  `charts/telflo/templates/_helpers.tpl`): a DNS name of at most
  63 characters, with no part of 16 or more characters holding a digit
  (the shape of a generated value). Its refusal names the value's path,
  never the value.
- **No schema pattern on a value that could carry a secret**. Helm's
  schema refusal quotes the rejected value, so `publicUrl`, the image
  registries and repositories, `api.mail.smtp.host` and
  `api.fileStore.endpoint` are typed only in `values.schema.json`, and a
  guard checks their shape with a fixed message. (The `site` URLs and
  Terms version follow the same rule, typed and bounded in the schema,
  shaped by a guard; `gateway.extraRoutes`' path and Service keep schema
  patterns, repeated by a guard; `api.mail.smtp.caSecret` is checked as a
  Secret's name.) A guard also checks `opamp-server.server.publicUrl`,
  which the API hands to every collector and its start-up error would
  quote: the contracts' agent-endpoint shape (a host or an IP address, an
  optional port, a path; no user name, password, query or fragment). The
  opamp-server chart's own schema pattern on it still runs first (below).
- **The opamp-server chart's schema still quotes a pasted value**
  (recorded). The opamp-server chart, vendored unchanged, checks
  `auth.existingSecret`, `imagePullSecrets[].name`, `server.publicUrl` and
  `externalDatabase.host` by pattern, and Helm's refusal quotes the value
  before any of the platform's guards runs. A later opamp-server release
  can follow the rule above.
- **`scripts/create-secrets.sh`** creates the Secrets from one git-ignored
  file (`*.secrets.env`). A value never goes on argv, stdout, stderr or
  into an error: kubectl reads files from a 0700 temporary folder, both
  commands' stderr stays in that folder, and every message is fixed. It
  applies **server-side** (`--field-manager=telflo-create-secrets`), which
  stores no `last-applied-configuration` annotation; a client-side apply
  would keep every value in it. `--context` is required and never
  defaults. The registry token comes from a 0600 file, never typed.

### The sandbox

Compose's `internal: true` networks and its container limits, in
Kubernetes:

- **NetworkPolicies, on by default** (`networkPolicy.enabled`;
  `templates/networkpolicies.yaml`):
  - the validator, the tester and the evaluator admit only the API's
    pods, on their own port, and reach nothing at all, DNS included;
  - the API admits only the gateway's and the web app's pods, on 8080, so
    no other pod can forge `X-Forwarded-For` under one trusted hop;
  - the web app admits only the gateway's pods, on 3000;
  - Postgres admits only the API's pods (their migrate init container
    included) and the opamp-server's, on 5432;
  - the opamp-server chart's own: its management port only from the API's
    pods (`networkPolicy.management.from`), its agent port from anywhere;
  - the gateway has none: it is the public way in.

  They hold only where the network plugin enforces them. The kind smoke
  runs on kind's own kindnet, which enforces every one, and probes each:
  the sandbox reaches neither the outside nor the API, and a pod without
  labels reaches neither the API, Postgres, web, the sandbox nor the
  management port, while the controls (the gateway, the agent port) stay
  open.
- **No service-account token in any pod**
  (`automountServiceAccountToken: false` on every ServiceAccount and pod).
  The validator's image bakes a fake token at that path, and a user's
  collector configuration could read a real one. No platform pod needs
  the Kubernetes API.
- **No service links** (`enableServiceLinks: false`): no platform pod gets
  variables naming every Service.
- **Every container:** a numeric non-root user (api and web 1000, nginx
  101, the validator and the tester 10001, the evaluator 65532, Postgres
  999), `readOnlyRootFilesystem`, every capability dropped,
  `allowPrivilegeEscalation: false`, the `RuntimeDefault` seccomp profile;
  emptyDirs where a service writes. So the release runs under the
  restricted Pod Security level, which the smoke enforces on its
  namespace.

**The recorded departures:**
- **The opamp-server chart's pods keep service links** (Kubernetes'
  default): the vendored chart isn't edited.
- **Two of compose's limits have no pod equivalent**: `pids_limit` (only
  the kubelet's `podPidsLimit`, a node's setting) and a `noexec` tmpfs (an
  emptyDir can't be `noexec`). An operator sets or accepts both on their
  own cluster.

**The recorded residues**:
- **The gateway buffers request bodies before any authentication.** nginx
  writes a body larger than its memory buffer to `/var/cache/nginx`, an
  emptyDir, and `default.conf`'s largest `client_max_body_size` is 11m, so
  anonymous senders choose what it holds. With a size limit, about 24 slow
  uploads would fill it and the kubelet would evict the gateway's pod: an
  outage of the whole site, and repeatable. The emptyDir has no size
  limit, which raises the bar without removing the outage: under the
  node's DiskPressure the kubelet evicts before the disk is full, and
  picks the gateway first (no ephemeral-storage request, the largest
  emptyDir), after gigabytes of uploads in flight rather than 256Mi. An
  ephemeral-storage limit on the gateway would bring the per-pod eviction
  back, so none is set; don't add one. The fix belongs in `default.conf`
  (a per-address `limit_conn`, or `proxy_request_buffering off` on the 11m
  locations), which the chart ships byte for byte.
- **The tester's emptyDirs evict all its runs when full.** Its `/tmp`
  (1Gi) and its home (512Mi) are size-limited, and a pod past either is
  evicted with every run in it. Lower risk than the gateway's: only the
  API reaches the tester, with at most `TELFLO_TEST_RUNS_PER_TESTER` runs
  at once, so a run that fills them is a signed-in person's, and the cost
  is the runs in flight until the pod restarts.

### The charts stay cloud-neutral

- **The rule**: no chart holds anything specific to a cloud. A cloud's
  details (a load balancer's annotations, a workload identity, a storage
  class) live only in an operator's own values files, through the charts'
  generic values.
- **`scripts/check-chart-cloud-neutral.sh`** (a static gate) checks both of
  the platform's charts, the vendored opamp-server chart included. It
  fails on a cloud marker (a cloud's annotation prefixes, identity
  bindings, API groups, hostnames or storage classes) in a file the chart
  packages or in any profile's rendering, and on an annotation key a
  template writes itself rather than taking from a values map.
- **Two keys a template may write**: a pod's `checksum/<name>` (a hash of
  an object the chart renders, so a change rolls the pods) and exactly
  `helm.sh/resource-policy: keep` (the file store's kept claim). Neither
  names a cloud. Every other annotation key a template writes fails the
  check.

### The management API stays internal

The opamp-server's management Service is always ClusterIP (the subchart's
own rule), and its NetworkPolicy admits the management port only from the
API's pods, by their fixed labels (`app.kubernetes.io/name:
telflo`, `app.kubernetes.io/component: api`). It has no
LoadBalancer, NodePort or Ingress, and the API reaches it by its Service
name. The management secret's rules ("The management secret" above) hold
as in compose; in the cluster its plain HTTP crosses only the pod
network. Only the agent endpoint faces collectors, through its own
LoadBalancer Service ("The agent endpoint" above).

### The pull secret

The platform's images and chart are public on GHCR, as the opamp-server's
are, so an install needs no pull Secret, and the chart names none by
default (`global.imagePullSecrets` and `opamp-server.imagePullSecrets` are
both `[]`). A registry of the operator's own that needs a login (a mirror)
takes `ghcr-pull`, a `kubernetes.io/dockerconfigjson` Secret, named in
both lists (the chart's README); the opamp-server's pods take the same
list harmlessly:

- `create-secrets.sh` builds it from a token in a file of mode 0600; the
  token is never typed into the secrets file or onto a command line;
- a token that can only read packages is enough, and the right one: the
  Secret is readable by whoever can read Secrets in the namespace;
- the opamp-server chart reads only its own `imagePullSecrets`, so the
  chart refuses a list that differs from `global.imagePullSecrets`.

### The gateway's logs behind a load balancer

The gateway's access log and its redactions are compose's
(`docker/gateway/default.conf`, shipped byte for byte). What changes
behind a cluster's load balancer:

- **The address it logs** is its TCP peer. Unless the load balancer keeps
  the visitor's address, that is the load balancer's or a node's, for
  every visitor, in the gateway's log, the API's audit rows and every
  per-address limit. The hop count stays 1 (`api.trustProxyHops`): a load
  balancer that passes TCP through adds no `X-Forwarded-For`.
- **The load balancer's own logs**, if turned on, hold every request as
  sent: no redaction of `tf_` tokens or quick-deploy, Helm values or
  library links in a path or query. They stay off, or are kept as secret
  as the secrets they can hold.
- **Its health check** is a TCP check of the port, never an HTTP request:
  an HTTP check would write a gateway line and a web render each time.
- **The error log's residues** (above, in each link's section) ship with
  the pod's logs: nginx quotes a request line when its upstream fails.

### The non-superuser owner

In the cluster, the migrations don't run as a superuser:

- **Postgres's superuser** (`postgres`) runs only the two bootstraps, once,
  when Postgres first creates its data. Its password is only in Postgres's
  container.
- **The `telflo_platform_owner` role** owns the `telflo_platform` database, with `LOGIN
  CREATEROLE` and nothing more (`files/telflo-bootstrap.sql`). It runs the
  migrations from the API's migrate init container and provisions
  `telflo_platform` (`packages/db/src/application-role.ts`).
- **The invariant: the API's login holds none of SUPERUSER, BYPASSRLS,
  CREATEDB or REPLICATION**, on both paths. A superuser provisioner names
  `nosuperuser nobypassrls nocreatedb noreplication`; a non-superuser one
  can't set those attributes, so it names only `login nocreaterole
  inherit` and the password, and refuses an existing `telflo_platform`
  that holds any of the four, or one it holds no ADMIN option on, each
  with a fixed message.
- **No `log_statement`**: provisioning runs `create role … password`
  ("Postgres's own log" above).

The smoke checks it in the cluster: `telflo_platform_owner` is no superuser and owns
`pgmigrations`, and the upgrade's second run re-provisions `telflo_platform`
cleanly.

### The web server writes no request's URL or path

**The invariant: the web server's stdout and stderr never hold a request's
URL or path**. `apps/web/server.mjs` replaces `react-router-serve`, which
logs every URL whole through morgan, a pasted token or link secret
included. Each sink that could carry request text is closed:

- **No per-request log.** The gateway's redacted access log is the record
  of requests. The start line is fixed.
- **The edge refusal**: a request whose path, or any query key or value,
  doesn't decode is answered 400 (fixed body, `nosniff`, no log) before
  the static mounts and React Router.
- **`handleError`** (`app/entry.server.tsx`): a 404 and an aborted request
  write nothing, another route error response its status only, and a
  server error its message and stack with the request's URL and path
  taken out. The express error handler does the same for its 5xx and
  writes nothing for a 4xx.
- **The `console.warn` sink filter**: React Router's `decodePath` warns
  `The URL path "<path>" could not be decoded` when a value decodes once
  to something that doesn't decode again (the manifest route's `paths`),
  which the edge can't refuse without refusing a legitimate `?q=100%25`.
  `installWarnFilter()`, installed first in the served process, drops
  exactly that warning. **Its stop rule:** two sweeps of react-router
  7.18.4's server code found it the only console call that can carry
  request text. **Recheck on every react-router upgrade**.

The smoke sends a double-encoded manifest request with the build's
version and checks the web pod's log holds no such line.

### No health check writes a log line

**The invariant: no health check writes a log line**, neither the
kubelet's probes nor the API's service-health monitors, which ask the
tester and the evaluator every 5 s:

- **The API:** readiness on `/health` (the database check), its route
  silent even when it fails; liveness and start-up TCP probes;
- **web:** `/favicon.ico`, a static file served before React Router;
- **the gateway:** TCP probes;
- **the evaluator:** TCP probes, and its request log skips `GET /health`
  exactly, which the API's monitor calls;
- **the validator and the tester:** a logging filter on `uvicorn.access`
  drops the health path's line only; the tester's health check asks kwok's
  apiserver through httpx2, whose logger is set to WARNING in the
  service's process;
- **the opamp-server:** its chart's own probes.

Every other request keeps its line. The smoke's 60 s without traffic must
add no line to any of the release's pods.
