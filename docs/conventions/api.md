# API conventions

**Source:** design spec §3.12 (API)

| Rule | Example |
|---|---|
| REST, kebab-case, plural nouns | `/api/v1/organizations/:organizationId/configurations` |
| Surfaces | `/api/v1/*` (cookie session; the anonymous downloads below need none), `/api/public/v1/*` (`tf_` tokens) |
| JSON is camelCase; the database is snake_case | Mapping happens in the repository layer, exactly once |
| Error envelope | `{ error: { code, message, details? } }` |
| Pagination | `?limit=&cursor=` → `{ items, nextCursor }` |
| No verbs in paths | `POST /configurations` |

## Error envelope

Every error response — across both `/api/v1/*` and `/api/public/v1/*` — uses
the same shape, but for the anonymous downloads' (below):

```json
{ "error": { "code": "...", "message": "...", "details": { } } }
```

`code` is machine-readable and stable; `message` is human-readable and may
change; `details` is optional and endpoint-specific.

**The anonymous downloads**, which serve anyone without a session, live
under `/api/v1/`, not `/api/public/v1/` (the `tf_` token surface):
`GET /api/v1/quick-deploy/{secret}`,
`GET /api/v1/organization-logos/{organizationId}/{logoId}` and
`GET /api/v1/library-links/{link}`. They read no session, cookie or CSRF
header, and answer their refusals in plain text with the platform's own
short words (`createPublicDownloadErrorHandler`), never the envelope: a
browser or curl shows the words as they are, and they never quote the path,
which may hold a secret. A framework error on a path that may hold a
quick-deploy or a library link answers in plain text too (`errors.ts`,
`respondToFrameworkError`).

**The open reads**, which answer anyone without a session in the JSON
envelope, live under `/api/v1/` too: `GET /api/v1/flow-showcase` (the
published flows' cards, no YAML), `GET /api/v1/auth/oidc-providers`, and
the open flow read, `GET /api/v1/published-flows` (`{ flows }`) and
`GET /api/v1/published-flows/{slug}` (`{ flow }`), the published flows in
full but their id, `published`, `sortOrder` and `createdAt`
(`PublishedFlowSchema`), for the playground. A hidden or unknown slug is
404 `flow_not_found`; every reply is `Cache-Control: no-store`; 60 requests
a minute per address over both (429 `rate_limited` with `Retry-After`); the
request line logs the route's pattern only. There is no list of open
`/api/v1/` routes in code (the public OpenAPI document covers
`/api/public/v1/` only): each is a route with no `preHandler`, named here
and in `docs/conventions/security.md`, and
`route-verification.integration.test.ts` reaches them outside the public
surface's check.

## The public surface

`/api/public/v1/*` is the API's own, for the CLI, CI jobs and servers, in
the platform's format: the paths, camelCase fields, the error envelope and
`{ items, nextCursor }` lists are the platform's. The gateway routes it
with its headers.

**The routes**, each declaring the access it needs:

| Access | Routes |
|---|---|
| none (the open routes) | `GET /health`, `GET /openapi.json`, `GET /docs/` (the reference page; `/docs` answers `301` to it); `POST /validate/anonymous` |
| read | `GET /whoami`, `GET /orgs`; `GET /configurations`, `/configurations/{configurationId}`, its `/versions` and `/versions/{versionNumber}`; `GET …/versions/{versionNumber}/validation-pipelines`; `POST /validate`; `POST /ottl/lint`; `GET /fleets`, `/fleets/{fleetId}/groups`, `/fleets/{fleetId}/groups/{groupId}`; `GET /flows`, `/flows/{slug}`; `GET /test-runs/{runId}` and its `/output` |
| write | `POST /configurations`, `PATCH /configurations/{configurationId}`; `POST …/versions`, `PATCH …/versions/{versionNumber}` (`?validate=true` validates first), `POST …/versions/{versionNumber}/publish`; `PUT …/validation-pipelines/{pipeline}` (the name may hold `/`); `POST /fleets`, `POST /fleets/{fleetId}/groups`, `PATCH /fleets/{fleetId}/groups/{groupId}`, `POST /fleets/{fleetId}/install`; `POST /test-runs` |

**The anonymous validate:** `POST /api/public/v1/validate/anonymous`
validates a text with no token and no organization, for `telflo validate`
without a login and the playground. It is the one open route that does
work, on `OPEN_PUBLIC_ROUTES` as `POST` only. Its body and answer are
`/validate`'s (`{ yaml, distribution?, collectorVersion? }`, strict;
`{ valid, collectorVersion, errors }`), every reply `no-store`, with the
same `400`s for an unknown or retired version or distribution and
`503 validation_unavailable`. The organization's variables are never read:
a `${org:NAME}` stays as written. An `Authorization` header sent is never
read: it isn't checked, nor counted against any token's limits or the
address's failures. Its limits are its own (below). Its record is the
request log's line only; the text and the validator's errors are only in
the reply, never a log line, an error or a span, and it writes no audit
row.

Path parameters are ids, but for a version's `versionNumber` (a positive
integer of at most nine digits) and a flow's `slug`. A malformed id answers
the resource's `404`. `write` implies `read`; a `read` token on a `write`
route answers `403 insufficient_access`.

**The headers:**
- **`Authorization: Bearer tf_…`** on every route but the open ones: the
  scheme case aside, one space, then the token, exactly `tf_` and 43
  base64url characters. A token is a service account's (its organization's)
  or a person's own (made on their Account page). No cookie is read and no
  CSRF header is needed (the CSRF guard exempts the public surface's
  routes, by the route matched, and nothing else). No public
  route checks the terms, for either kind. A `tf_` token sent to `/api/v1/`
  is no session there: `401 unauthenticated`.
- **`X-Telflo-Org: <organizationId>`** with a personal token, on every
  token route but `/whoami` and `/orgs`, where a header that is sent is
  still checked (the open routes read no header). Missing or not a uuid: `400 organization_required`.
  An organization the person isn't a live member of (unknown, deleted, or
  theirs no longer) answers one `403 organization_access_denied`, which
  never says which. `/orgs` lists the organizations to choose from. A
  service account's token ignores the header.
- **CORS** allows no `authorization` header, so a cross-origin browser page
  can't call the surface. The reference page is served on the same origin.

```
GET /api/public/v1/whoami
Authorization: Bearer tf_…
  → 200 { "organizationId": "…", "tokenName": "…", "access": "read" | "write", "kind": "service_account" }
     or { "organizationId": "…" | null, "tokenName": "…", "access": …, "kind": "person" }
    Cache-Control: no-store
```

**The format:** camelCase JSON; lists as `{ items, nextCursor }`
(configurations and fleets take `?limit=&cursor=`; the other lists are
small and answer every item with `nextCursor: null`). Bodies are strict: an
unknown field is `400`. Every reply under the public plugin is `no-store`
unless its route sets its own, refusals included (the root verification's
401 and the router's 400 and 414 for a public path too); the open routes
keep theirs (`/openapi.json` is `public, max-age=300`). Install's reply
holds a fleet's bearer (or a link's secret whose download answers it) and
is a secret (`docs/conventions/security.md`).

**The limits:**
- **60 requests a minute per token**, counted once the token is accepted,
  keyed by the token's id (never the bearer), before a personal token's
  organization check: `429 rate_limited` with `Retry-After`. The open
  routes don't count.
- **Each feature's own limits** apply inside it, per the token's user
  (for a person, their browser use too): validations, the evaluator's rule
  checks, OTTL lint's 30 a minute, test runs' 20 a minute and 50 waiting,
  the fleets' bearer budget (fleet create and install spend it), uploads.
  OTTL lint also holds at most 2 lints in flight per person and
  organization (`429 rate_limited`, `Retry-After: 1`).
- **The failure limit:** 30 failed tokens from one client address in 5
  minutes block that address (`429 rate_limited`, `Retry-After` the
  window's remaining time, before the header is read). Attempts in flight
  count too, so more than 30 concurrent requests from one address are
  refused, valid tokens' included, with `Retry-After: 1`. A request with
  no `Authorization` header counts nothing, and a success takes back only
  its own count. A refused organization doesn't count.
- **The anonymous validate's limits:** per client address (`request.ip`,
  which honors `TELFLO_TRUST_PROXY_HOPS`) 10 a minute and 1 in flight;
  across every anonymous caller 120 a minute and 4 in flight, so the
  validator keeps room for signed-in validations. One limiter checks both
  levels before recording either; the count is taken after the body is
  parsed and checked (a malformed or oversized body isn't counted), before
  the catalog's reads. A refusal is `429 rate_limited` with
  `Retry-After`. The counts are each API process's own (in memory), so the
  totals grow with replicas; behind a proxy the API needs
  `TELFLO_TRUST_PROXY_HOPS`, or every caller shares the proxy's address.
- **Body limits:** 2 MiB for a configuration's create, a version's
  append and PATCH, `/validate` and `/ottl/lint`; 8 MiB for `POST /test-runs` (a sample of
  at most 1 MiB decoded, `413 payload_too_large` past it); 1 MiB for the
  rest, the anonymous validate included (the gateway's catch-all for
  public paths). The gateway's limits equal the routes'. A body over the gateway's
  limit gets nginx's own `413`, an HTML page, not the envelope, as do its
  `502` (the API unreachable) and `504` (no answer in time): a client
  reads those by their status.

**The errors** use the envelope above, with the platform's codes; each
operation's codes are in the OpenAPI document. Messages are fixed words:
never a name, a YAML, a rule, a sample, a token or a downstream service's
text.
- **The one 401**: every token refusal (no header, another scheme, a
  malformed, unknown, revoked or expired token, a deleted account; for a
  service account's token, a removed membership or a deleted
  organization) answers the same body, `{ "error": { "code": "invalid_api_token", "message": "Missing or invalid API token" } }`,
  with `WWW-Authenticate: Bearer`. A personal token whose organization
  the person can't act in (a removed membership, a deleted organization)
  answers `403 organization_access_denied` instead (the headers, above).
  An unknown path answers `404 not_found`
  only after the check, naming no path (`No route for GET
  /api/public/v1/[unmatched]`). A request under the prefix, in any
  spelling, that something other than a public route would answer gets
  the 401 too (the surface's guards, `docs/conventions/security.md`).
- **A schema's 400** (`invalid_request`) names each issue's place and Zod's
  code only, `details: [{ path, code }]`: never the value sent, and an
  unknown key as `"<unknown>"`. A route's own 400s (a signal or a
  distribution that doesn't match, the fleets' own refusals, a list's bad
  cursor) carry `[{ path, message }]` in fixed words. So a public
  `400 invalid_request` has one of two detail shapes: `{ path, code }` or
  `{ path, message }`.
- **A text that doesn't validate**: `422 configuration_invalid`, with
  `details.errors: [{ message, componentPath }]`.
- **The router's own refusals** answer before the check: a malformed
  percent escape `400 invalid_request`, a path parameter over 100
  characters `414`.
- **The gateway's own replies** (`413`, `502`, `504`) are nginx's HTML
  pages, not the envelope (the body limits, above).

**The reference:** `GET /api/public/v1/openapi.json` is the hand-written
OpenAPI 3.1 document (`apps/api/src/modules/public-api/openapi/`, one
fragment per area), served without a token, `Cache-Control: public,
max-age=300`. Tests fail on a route missing from it, an operation with no
route, an access that differs, or a reply that doesn't validate against it.
`GET /api/public/v1/docs/` is Swagger UI over it, with try-it (vendored at
5.32.15): the one page where a token is typed (its handling is in
`docs/conventions/security.md`).

`docs/conventions/security.md`, "Service accounts and API tokens", has the
token's format, storage and check, personal tokens, and the surface's
guards; "The telflo CLI" has the CLI's side. The CLI itself is
`telflo-core/apps/cli` (`docs/conventions/cli.md`).

## Pagination

Cursor-based, not offset-based:

```
GET /configurations?limit=20&cursor=<opaque>
  → { "items": [...], "nextCursor": "<opaque-or-null>" }
```

## JSON casing and its one exception

JSON request and response bodies are camelCase; the database is snake_case.
The mapping between the two happens in the repository layer, exactly once —
no camelCase leaks into SQL, and no snake_case leaks into a response body.

**JWT claims are the one exception to camelCase JSON.** They follow JWT
convention (`sub`, `iat`, `organization_id`) instead, because they sit
alongside registered claims (`sub`, `iat`, `exp`, `iss`, `aud`) that are
snake_case by specification — inventing a camelCase dialect for the
application-specific claims in the same token would be inconsistent with the
registered ones next to them, not more consistent.
