#!/usr/bin/env bash
# Smoke-tests the full container stack (docker-compose.yml) from the outside,
# the way a user reaches it: through the gateway, with real email delivery.
# Run after `docker compose up --build --wait`. Needs curl and jq. Expects
# the stack to run without Google settings, as CI's does: no
# TELFLO_OIDC_GOOGLE_* reaches docker-compose.yml.
#
# Which site: TELFLO_SMOKE_SITE=oss|saas, required, with
# no default (unset or anything else exits 2 before anything runs; the gates'
# scripts/gates/smoke-env.sh sets it beside the site's values). `saas` is the
# run described below, on the SaaS's values. `oss` runs the open-source
# defaults, on a throwaway stack only (COMPOSE_PROJECT_NAME set and naming
# a throwaway stack, see throwaway_stack; otherwise it exits 2 before anything
# runs): POST /api/v1/auth/register answers 403 registration_not_open; the
# first account is made by `telflo-admin bootstrap --email <it>
# --organization <the group organization>` in the API's container (`docker
# compose exec -T`), its standard output in a 0600 file of the work folder,
# the set-password link read from its last line into a variable and never
# printed; the link's page loads through the gateway (its path: the token is
# in the fragment) and its token sets the password (POST
# /api/v1/auth/password-resets, 204); the sign-in lands in the group
# organization the bootstrap made, where /me shows the
# account its admin and a product admin, asked for no Terms; the flag is then
# cleared by SQL (marked before the bootstrap runs, so the EXIT trap clears it
# too), and the ordinary account's create is 403
# organization_creation_restricted (the switch is on by default), so no
# organization is made through the gateway; the invitee joins by the
# invitation read from Mailpit, with no Terms; the product-administration
# steps' third account joins the group organization by an invitation too, and
# is removed from it (DELETE .../members/:userId, 204) before its delete; the
# playground's three pages are 404, the published flows' anonymous reads 404
# not_found, the sales inquiry 404 not_found (nothing reaches Mailpit) and the
# CLI's anonymous validate exits 3 login_required. Every other step is the
# same. Last, in both modes, the API's, the gateway's and the web server's
# logs are searched (grep -cF -f, counts only) for the run's secrets: both
# passwords, the invitation's token and, in oss, the set-password link's
# token.
#
# Checks the paths that only the assembled stack exercises: the gateway
# routes pages to the web app and /api/ to the API, the public surface
# included (/api/public/v1/whoami without a token is the
# API's one 401 invalid_api_token with WWW-Authenticate: Bearer, no token
# sent or printed), migrations ran, the API
# reaches Postgres and Mailpit over the compose network, the emailed link
# points at the gateway's origin, nginx passes the CSRF header through, the
# session cookies work and rotate through the gateway, a session switches
# to an organization it created and back, an invitation to it arrives by email
# and a new account joins it from the link's token, a configuration is
# created, listed, deleted and gone from the list, the
# new account lists its Initial Configuration, and a configuration's version
# is read, saved with a small graph and read back equal, and saved
# again with a body over 2 MiB (on the route the gateway allows 5 MiB), a
# second version is created from the first with a body over 2 MiB (the
# create's path has the gateway's 5 MiB too), renamed, the first selected,
# and both read back, the second is published through the gateway, its
# snapshot found in the opamp-server (the second version's, by its id,
# holding the YAML saved, by its SHA-256, for the configuration's collector
# distribution and the version's collector version), and none found there once
# the configuration is deleted, a password reset arrives by email and takes
# effect, the web server's loaders reach the
# API over TELFLO_API_INTERNAL_URL, and with no OIDC provider configured the
# API lists none and has no Google start endpoint. robots.txt disallows every
# path, and a sales inquiry reaches Mailpit at TELFLO_SALES_INQUIRY_TO (the
# gates' smoke-env.sh runs the SaaS's values, the inquiries on). The
# playground, signed out: /playground, /playground/editor and /public-editor
# render with their titles, and the open read of the published
# flows (no session, no-store) lists log-volume-cost-control, answers its YAML
# by slug and 404s an unknown slug flow_not_found. The inquiry is limited to 3
# per IP per 10 minutes, so a fourth run within 10 minutes fails there with
# 429. The identity routes (register, verify, sign-in, password reset, the
# invitation's preview and registration, Google's start) share a limit of 30
# requests per IP per 5 minutes (RATE_LIMITS' identityPerIp; refresh has its
# own bucket of 150): a run makes 11 of them, 15 on a throwaway stack (the
# product-administration steps' third account); an oss run 13 (each account's
# register and verify become one request: the set-password link's, the third
# account's invitation registration; the refused register isn't counted, its
# gate answering first), so two quick runs in a row from one address fit and a
# third fails at register or sign-in with 429 until the window moves on. The
# opamp-server: its management API answers /health on its published
# port and refuses an /api/ call without the secret; the platform's real
# client, run inside the API container, registers an organization and posts,
# reads, lists and deletes a publication under it through the real server,
# then deletes the organization; the platform registers there the account's
# personal organization (checked before the configurations, since a publish
# registers its organization too) and the group organization created above,
# and, at the end, after the account signs in again, renames the group
# organization there when it's renamed through the gateway and removes it
# there when it's deleted through the gateway, the account keeping its
# personal organization; and each side's login role is
# refused a connection to the other's database, over the network, so the
# password path is exercised rather than the server container's local trust.
# Who may create an organization: a fresh stack lets only product admins. On a
# throwaway stack, before the organization above is created, /me's
# mayCreateOrganizations is false and the account's create 403
# organization_creation_restricted; the account, a product admin
# by SQL for that one call, turns the switch off through PATCH
# /api/v1/product-admin/settings (200, no-store), creates the organization
# as an ordinary account, and the switch goes back on by SQL (the EXIT trap
# too, for a run that ends in between). On any other stack the switch must
# be off already, or the run fails saying so.
# The collector validator: it answers /health on its published port
# and refuses a validate call without the secret; and through the gateway,
# the platform checks a version's text with the real collector of the
# version's pin: a valid text answers `valid`, a text
# naming an unknown component `invalid` with that component's path. The
# configuration's version 1 is pinned to the catalog's default version,
# the one the image always holds (every offered one by default; CI's stack
# job and the throwaway gate stacks build it with OTELCOL_VERSIONS=default,
# the catalog's default only). The collector tester: it answers
# /testing/v1/health through its forwarder's published port (the tester
# itself sits only on an internal network) and refuses a run without the
# secret there; and through the gateway, a real run: a small OTLP logs
# document is uploaded to the account's test files, a run of a text piping
# an OTLP receiver to the debug exporter is queued on version 1's pin, the
# API's dispatcher sends it to the tester, whose collector runs it, and the
# run, polled until it ends, succeeds with an output holding the record.
# Test suites: through the gateway, a suite is created on version 1
# with a test configuration copied from that file, Played (queued by its
# definition's id, on version 1's pin), and its run succeeds carrying the
# suite's and the configuration's names as its breadcrumb, with the same
# record in its output; version 2, created from version 1 below, lists a copy
# of the suite and its configuration.
# Validation rules: the OTTL evaluator answers /health through its
# forwarder's published port (it sits only on an internal network of its
# own) and refuses, before routing, a call without the secret, with a wrong
# one, and on an unknown path; and through the gateway, a validation
# pipeline is created for version 1's `logs` pipeline, an OTTL rule and a
# regex rule are saved, each checked by the real evaluator, a broken OTTL
# condition and a regex RE2 can't compile are refused with the evaluator's
# words (400 validation_rule_invalid), a run of the uploaded file whose rules
# pass succeeds with a passed result per rule, and once a rule the record
# breaks is saved (every record tagged env: prod), a second run ends
# `validation_failed`, its failed result carrying its detail; version 2 lists
# a copy of the validation pipeline and its rules.
# The regex library and Compare's rules: through the gateway, the account, a
# member, reads the library (at least 35 entries, the seed's count; "US Social
# Security Number"'s regex byte for byte), saves its "AWS Access Key" as a
# not_contains_regex rule as the picker does and an OTTL rule as Compare's
# "Create an OTTL rule" writes it for a key with quotes and brackets (stored
# byte for byte), each checked by the real evaluator, and once "Production
# only" is deleted a run of a second file, whose extra record carries the
# attribute `y`, succeeds with every rule passing, in order (the key read
# unescaped, as the two keys `x` and `y`, would fail there); a member's write
# to the library is 403 product_admin_required. Then, only on a throwaway
# stack (COMPOSE_PROJECT_NAME set and naming a throwaway stack;
# otherwise these steps are skipped with a line saying why),
# is_product_admin is set by SQL on the stack's own database (psql in
# opamp-bootstrap, as the databases' refusals below), /me shows it,
# and the account creates, renames and deletes an entry, a lookahead regex
# is refused 400 test_regex_invalid in the real evaluator's RE2 words, a
# second delete is 404; the flag is cleared again, and the next write is
# 403. A run that ends between those steps deletes the entry it created, if
# it's still there, and clears the flag (the EXIT trap). The copy to version
# 2 carries the four rules left.
# The fleet model: the opamp-server's agent endpoint answers /health
# on its published port; through its management API (curl, the secret in a
# 0600 header file) a server fleet is created in the personal organization,
# with a group "gateways"; a configuration of the fleet's own is published
# through the gateway and assigned to the fleet's Default group, and its
# published version, in use, can't be deleted (409 publication_in_use); a
# real collector (the OpAMP supervisor 0.162.0 running otelcol-contrib
# 0.162.0, docker/smoke-collector, built from the stack's validator image)
# started with the fleet's default bearer, edge-01, naming the Default group
# (every smoke collector names its group), enrolls there, is handed
# the rotate token and applies the published version (its
# effective SHA-256 the saved YAML's, in sync); a second opamp-server replica
# is started (`docker compose run`), and edge-02, on the same local file in
# "gateways" with nothing assigned, enrolled through it, is read through the
# first replica unassigned (no pin, nothing resolved, nothing served: it
# keeps running its own file), and the fleet's former imports path
# answers 404; hand-made polls on the default token show the agent's door
# requiring a group: a fresh collector naming no group is refused
# 403 "Forbidden" and not enrolled, one naming a group "doomed" (made through
# the management API) enrolls there, and once that group is deleted (204) its
# collector is gone (404 collector_not_found) and the same instance uid naming
# it again is refused 403; once the rotate token is revoked, a fresh
# collector's poll on it is refused 401 by both replicas within 15 polls;
# then the collectors, the replica, the fleet and the image are removed, and
# the fleet's configuration is deleted through the gateway, whose
# after-response delete then removes its published version, no longer in
# use, from the opamp-server (a run that ends among those steps removes what
# it made in the EXIT trap).
# The server must hand collectors a URL they reach from the compose network:
# CI's stack job, and a throwaway stack, start it with
# OPAMP_SERVER_URL=http://opamp-server:51234/opamp/api/v1; the
# development default (host.docker.internal) works on Docker Desktop with the
# stack's own published 51234. Before any step, the agent URL this script
# polls (TELFLO_OPAMP_AGENT_HOST_URL) must be the agent port the stack
# publishes (`docker compose port opamp-server 51234`), and the smoke
# collector's binary (docker/smoke-collector) the catalog's default
# version, the one the validator image always holds: a run against either
# fails at once, naming what to change.
# The fleet model through the platform: in the group organization, after its
# rename and before its delete, through the gateway as its signed-in admin
# (the cookie jar and X-Telflo-CSRF), a configuration of its own is published
# and its versions' list (filter=published) answers exactly that version, its
# id, number, label and published date only; a fleet is created
# with an id the script chose (201, no-store, both bearers) and again with
# the same id (200, the fleet without bearers), listed and read; the
# published version is assigned to its Default group by its version id
# (before any collector starts) and answered with its configuration and
# version beside it; edge-b1, from the smoke collector's image, started with
# the platform's default bearer and naming the Default group, is read
# through the platform's collector
# list (no-store) holding the rotate token and applying the published
# version (its SHA-256, in sync, the served version named), then read alone
# and its error history read (each no-store), and edge-b2, in a group with
# nothing assigned, is read through the platform unassigned (no pin, nothing
# resolved, nothing served), and the platform's former imports path
# answers 404 not_found; edge-b2 is pinned to the published version through
# the platform (200, no-store), read applying it from its pin (in sync), and
# unpinned (200, unassigned again, still served that version); the
# configuration's delete is refused 409
# configuration_in_use and its fleet usage lists the Default group; the
# default token is revealed (no-store), its bearer the token sealed anew
# (not the create's text); the rotate token is rotated with 120 s of grace
# and edge-b1 follows it; the old one is revoked, and the token list carries
# no bearer; once the assignment is cleared the configuration is deleted
# (204) and its published version leaves the opamp-server; and after the
# group organization's delete the management API answers its fleets 404
# organization_not_found. A run that
# ends among those steps removes its collectors, the fleet (through the
# management API), the image and the configuration (the EXIT trap).
# Installing: in that fleet, after its token history and while its published
# version is assigned, a group with that version and a read-only mount; its
# install facts read through the platform (no-store, no bearer, this stack's
# endpoint, the image of the catalog's default version); the container
# install run from the facts in the local ghcr.io/telflo/telflo/collector
# image (`--pull never`; without it these steps are skipped, saying why), its
# bearer from a reveal passed only through the environment, enrolling in the
# group; the All In One bundle downloaded, unpacked (its four files and modes,
# no placeholder, no bearer) and run in that image as root, downloading
# otelcol-contrib and the supervisor for the image's arch from GitHub
# (sha256-checked), enrolling a second; then the default token revoked, a new
# one issued, and the container install run again with it on the same volume,
# reconnecting as the same collector. Its containers and volume are named for
# the compose project and removed at the end (or by the EXIT trap), then the
# group, whose delete deletes its three collectors with it (each read 404, the
# fleet's count down by three).
# Quick-deploy links: in that group, after the All In One collector enrolls
# and before the default token is revoked, the API's TELFLO_PUBLIC_API_URL
# must be http://gateway (a throwaway stack is started with it; compose's
# default would send the commands to the host's gateway); a foreground link
# made (201, no-store, its url), listed (active, no download, no secret),
# downloaded from the host through the gateway with no session (the download's
# headers, the four files, no bearer), and its Quick Deploy command, printed
# by the contracts' builder in the API container, run for real in the
# collector image on the compose network (a `sudo` shim; the All In One's
# binaries mounted so nothing is downloaded again), enrolling a third
# collector; a systemd link's command run with the `sudo` shim and a recording
# `systemctl` (no systemd there): opamp.env 0600 root's holding the bearer,
# the unit's text exact, daemon-reload, enable and restart in order, no
# secret on a shim's arguments; the API's and the gateway's logs holding
# neither link's secret nor the bearer; the first link revoked and its
# download refused 410 in plain text, its count unchanged; and once the
# default token is revoked, the systemd link's download refused 410, and
# the logs searched again after both refusals. The link's secret and the
# bearer never reach a command line, nor a failed check's message. Without the
# collector image these steps are skipped with the install's.
# A Kubernetes fleet's groups: through the gateway, in the group organization,
# before its delete, a server fleet's group refuses the annotations'
# Kubernetes key (400 at annotations.telflo.kubernetes), on its create and on
# a save; a kubernetes-supervisor fleet made through the platform lists its
# Default group alone; the Cluster (named cluster, role cluster) and a gateway
# (2 replicas, a hostPath volume) are made, each answered with its annotations
# as sent; that fleet's creates refuse telflo.dockerMounts, a gateway named
# node, a role not the name's and no telflo.kubernetes at all (each 400 at
# its field), its groups a rename (409 collector_group_name_fixed), its
# Default group a save naming the role gateway (400) and the gateway a save
# of annotations without its settings (400), none of them written;
# the Default group's save naming node is answered 200; the gateway and then
# the fleet are deleted (204 each). A run that ends among those steps removes
# the fleet (the EXIT trap).
# The Helm install through the platform, in that Kubernetes fleet before its
# gateway's delete, with no collector image or cluster: the published version
# of edge-b1's fleet (above) assigned to the Agent and the gateway, their Helm
# facts read (no-store, no bearer, the platform's chart and image, release,
# the Agent's fullnameOverride from the fleet's id and none for the gateway,
# namespace, replicas and volumes); the Linux bundle and a Linux
# link refused on the Kubernetes fleet and a Helm link on edge-b1's server
# fleet, each 409 fleet_type_not_installable in its direction's words; the
# organization's "Public install links" switch read on; a Helm values link
# made for the Agent (201, no-store, its choices by kind) and downloaded from
# the host through the gateway with no session (200 text/yaml;
# charset=utf-8, no-store, nosniff, no-referrer, attachment values.yaml), its
# fixed lines (its fullnameOverride after group), one token line of a
# bearer's shape, and the file byte for byte
# the contracts' helmValuesYaml of the facts and that token, printed in the
# API container; the switch turned off (the download 403 "Install links are
# turned off for this organization." in plain text, a Helm and a Linux
# link's create 409 public_install_links_disabled, nothing counted) and on
# again (200, downloaded from a client container on the compose network,
# its quick_deploy_link.downloaded audit row holding that container's
# address, not the gateway's), the link revoked (410); the API's
# and the gateway's logs holding neither the link's secret nor a downloaded
# token. The values file
# holds the bearer by design: never printed, never searched for a bearer's
# shape; each download's token joins the secrets the logs are searched for.
# Organization variables: in edge-b1's fleet, after edge-b2's unpin and before
# the configuration's in-use refusal, through the gateway as the group
# organization's signed-in admin, on edge-b2 in "unassigned-b" (never the
# Default group, whose assignment the later steps rely on): the variables
# SMOKE_TAG (a$b-1) and SMOKE_UNUSED are created (201, no-store); a
# configuration of its own, whose processor attributes/variable inserts an
# attribute of the value ${org:SMOKE_TAG}, is published and assigned to
# "unassigned-b"; edge-b2 applies the text filled in, by the SHA-256 the
# script computes with the value's `$` doubled (a$$b-1; the resolution keeps
# the published text's), in sync; SMOKE_TAG's new value is pushed (served.at
# moves, a new SHA-256, in sync again); SMOKE_UNUSED's change is not
# (served.at and the SHA-256 unchanged, in sync at every read, while edge-b2's
# lastSeenAt moves 3 times: its polls); SMOKE_TAG's delete is refused 409
# variable_in_use, its details exactly the version and "unassigned-b" with
# their names and the totals, holding neither the variable's name nor its
# value; a variable group overriding SMOKE_TAG bound to "unassigned-b", then
# another pinned on edge-b2, each pushes its own value; then edge-b2's pinned
# variable group, the group's variable group and its assignment are cleared
# (edge-b2 unassigned again), and the variable groups, the variables and the
# configuration are deleted (204 each, both lists empty, its published
# version gone from the opamp-server). A run that ends among those steps
# deletes them (the EXIT trap). With the collectors' 30 s heartbeat these
# steps take about four minutes.
# The file store: before any step, the API's TELFLO_FILE_STORE is read from
# its container, local or s3, and must be TELFLO_SMOKE_FILE_STORE when that is
# set; on s3 (a stack started with TELFLO_FILE_STORE=s3 and --profile s3), the
# object store's filer, read inside object-store, holds the uploaded test file
# at its key with its size (the API's volume doesn't), the first run's output,
# and the test configuration's input under test-definition-inputs/. The object
# store's logs are never read: they name the access key id.
# Logos and the library: after the Helm install's logs check, in the group
# organization, a 2 MiB PNG logo is set through the gateway (a multipart
# PATCH: its name, then the file; the gateway's 3 MiB location) and read back
# publicly with no cookie (its bytes; image/png, immutable caching, nosniff,
# CSP sandbox, CORP cross-origin, no Set-Cookie), /me names its id, and a body
# over 3 MiB is the gateway's own 413; on s3 the object is at its key. Then,
# on a throwaway stack only (as the regex library's product-admin steps,
# granting and clearing the flag on their own), a 10 MiB library file is added
# (an 11 MiB + 1 body is the gateway's 413), its link made (201, no-store, the
# path's pattern) and downloaded from the host through the gateway with no
# session (its bytes; octet-stream, no-store, nosniff, attachment), the file
# deleted (204) and its link then 404 "Not found." in plain text; the API's
# and the gateway's logs hold no tll_ and log both downloads as GET
# /api/v1/library-links/[redacted] (200, 404). The link is built from the
# gateway's own origin and its path, never printed: sizes and
# statuses only. A run that ends between the file's create and its delete
# deletes its row by SQL (the EXIT trap). After the group organization's
# delete, the logo's read is 404 "Not found."; on s3 its object is gone
# (polled).
# Product administration: after the library's steps, on a throwaway stack only
# (as the regex library's product-admin steps, granting and clearing the flag
# on their own), both sessions refreshed, the account is made a product admin
# by SQL and, through the gateway's /api/v1/product-admin/ routes (every
# answer no-store), finds itself the only product admin listed (fails
# otherwise), grants the invitee by email (201 with their id, then 200), lists
# both, removes the invitee (204) and is refused its own removal, 409
# last_product_admin (the one real last-admin refusal outside the integration
# suite). The invitee sends feedback (201); the product admins' email reaches
# the account in Mailpit naming the invitee and the gateway's User Feedback
# page, its text and HTML holding the feedback's marker on 0 lines; the
# item is listed (its cursor followed until found), dismissed (204) and
# again 404 feedback_not_found. The invitee's delete is 409
# user_delete_blocked { kind: member } (the group organization), the
# account's own 409 user_delete_self. A third account is registered and
# verified (register_verified, the first account's four steps, its
# address never printed), signed in, found by its address (?q=, one
# person, no block) and deleted (204); then its /me and refresh are 401
# unauthenticated and its sign-in 401 invalid_credentials, and by SQL its
# deletion record (its address, deleted by the account), its anonymous
# deleted-<24 hex>@deleted-accounts.telflo.invalid row with no password,
# its freed address, the organizations whose name holds its address and
# its sessions holding an IP address or user agent count 1, 1, 0, 0 and 0; its
# personal organization, found registered in the opamp-server before the
# delete (stack_smoke <id>), is gone from it after (stack_smoke group-gone).
# The API's and the gateway's logs hold the search's term on 0 lines and the
# gateway's access log the search as "GET /api/v1/product-admin/users HTTP/…"
# (no query; counts only), and the flag is cleared. Replies are read by jq
# for ids and booleans, never printed; a failure prints statuses, error
# codes and counts. A run that ends between the invitee's grant and its
# removal clears the invitee's flag by SQL too (the EXIT trap clears both
# flags); a run that dies mid-block leaves the third account and the
# feedback item on the throwaway stack.
# The public API: in the group organization, after the library's and the
# product-administration steps and before the gateway's delete,
# its admin's session mints a service account's write and read tokens and a
# personal write token (each checked by its shape, never printed); through
# the gateway each drives the public surface: /whoami for both kinds, /orgs,
# the person's 400 organization_required then 200 with X-Telflo-Org, a read
# token on a write route 403, a configuration created, PATCHed ?validate=true
# (the real validator: an invalid text 422, a valid one 200), route 14's PUT
# on a pipeline whose name holds a marker (raw and %2F), published (the
# opamp-server holds it), /validate, /ottl/lint (the real evaluator's lint
# endpoint), a fleet, a group and a docker install (no-store, its command a
# docker run: a boolean), a YAML test run with an inline sample and a rule
# run by the real tester and read back with its output, /openapi.json,
# /docs/ with its CSP and /docs's 301, a 2.2 MiB body to /validate and a
# route-14 PUT over 1 MiB naming the pipeline nginx's 413s; a token minted for
# it alone sends 61 /whoami (the 61st the per-token limit's 429 with
# Retry-After), and the personal token is revoked (then 401); last, the
# API's and the gateway's logs hold none of the tokens and not the marker
# (grep -cF counts only). The session is refreshed first.
# The telflo CLI: before any step, the CLI TELFLO_SMOKE_CLI names (by default
# the checkout's telflo-core/apps/cli/dist/index.js, run with node; the gates
# name the package check's install of the tarball) must be there and print its
# -V, or the run fails at once. In the public API's section, after the
# route-14 413 and before the per-token limit (so that section's log search
# for the personal token covers it), the CLI, with a HOME and a
# TELFLO_CLI_CONFIG_DIR (0700) of the work folder's and XDG_CONFIG_HOME,
# TELFLO_TOKEN, TELFLO_SERVER, TELFLO_ORG and TELFLO_CONFIG_DIR unset, logs in
# from its standard input with the personal token (--server the gateway, --org
# the group organization; the credentials file 0600 in a 0700 folder), then
# runs whoami and org list, config create, push (the draft in place), publish
# and pull -o (byte for byte), validate on the pin and anonymously with an
# empty config folder (valid, and an invalid text exit 4), ottl lint (exit 0
# and 4), test (a spec, a sample file and two OTTL rules, in the real tester),
# fleet create (no bearer), fleet groups, deploy --group (the Default group:
# an install needs a group that serves a version), fleet install --platform
# docker (its stdout 0600, only grepped: its first line the OPAMP_TOKEN
# assignment, a line of its own `docker run`), logout (then whoami
# exit 3); every output goes to 0600 files read by jq, grep and cmp. Then no
# tf_, tqd_ or tll_ in its outputs but install's stdout, and install's
# stdout's lines (grep -cF -f) in none of its other outputs nor the API's
# and the gateway's logs, counts only; the session is refreshed again.
# Behavior is tested by the workspace's own suites; this proves the pieces
# are wired together.
#
# Every `docker compose` call here takes its project from the environment
# (COMPOSE_FILE, COMPOSE_PROJECT_NAME), so the script can drive a throwaway
# copy of the stack on other host ports when those, the seven URLs and the
# replica's port below are set.
set -euo pipefail

# throwaway_stack: true when COMPOSE_PROJECT_NAME names a throwaway stack: set,
# and none of telflo (the self-host install's), telflo-dev (the development
# stack's) and telflo-platform (a developer's own running stack's).
throwaway_stack() {
  case "${COMPOSE_PROJECT_NAME:-}" in
    "" | telflo | telflo-dev | telflo-platform) return 1 ;;
  esac
}

# The site the stack runs: required, no default, checked
# before anything runs (exit 2). `oss` makes its first account with
# telflo-admin bootstrap and clears a product admin's flag by SQL: a throwaway
# stack's only.
SMOKE_SITE="${TELFLO_SMOKE_SITE:-}"
case "$SMOKE_SITE" in
  oss | saas) ;;
  *)
    echo "usage: TELFLO_SMOKE_SITE=oss|saas $0: TELFLO_SMOKE_SITE is required (no default): oss, the open-source defaults, or saas, the SaaS's values (scripts/gates/smoke-env.sh sets it)" >&2
    exit 2
    ;;
esac
if [ "$SMOKE_SITE" = "oss" ] && ! throwaway_stack; then
  echo "refused: TELFLO_SMOKE_SITE=oss runs on a throwaway stack only (COMPOSE_PROJECT_NAME set, naming a throwaway stack): COMPOSE_PROJECT_NAME is ${COMPOSE_PROJECT_NAME:-unset}" >&2
  exit 2
fi

GATEWAY_URL="${TELFLO_GATEWAY_URL:-http://localhost:50080}"
MAILPIT_URL="${TELFLO_MAILPIT_API_URL:-http://localhost:58025}"
# 127.0.0.1, not localhost: compose publishes the management port on the
# host's IPv4 loopback only, and localhost may resolve to ::1 first.
OPAMP_MANAGEMENT_URL="${TELFLO_OPAMP_MANAGEMENT_HOST_URL:-http://127.0.0.1:51235}"
# The collector validator's published port, on the same loopback only.
OTELCOL_VALIDATOR_URL="${TELFLO_OTELCOL_VALIDATOR_HOST_URL:-http://127.0.0.1:51236}"
# The collector tester's, through its forwarder, on the same loopback only.
OTELCOL_TESTING_URL="${TELFLO_OTELCOL_TESTING_HOST_URL:-http://127.0.0.1:51237}"
# The OTTL evaluator's, through its own forwarder, on the same loopback only.
# The default, 127.0.0.1:51238, is the dev stack's evaluator port (`npm run
# dev:services`, a developer's own stack), so a run against a throwaway stack
# must set TELFLO_OTTL_EVALUATOR_HOST_URL to its own forwarder's port, as it
# sets the other host URLs above.
OTTL_EVALUATOR_URL="${TELFLO_OTTL_EVALUATOR_HOST_URL:-http://127.0.0.1:51238}"
# The opamp-server's agent endpoint, where collectors poll, on the
# same loopback only, and the host port the fleet steps publish their second
# opamp-server replica's agent endpoint on.
OPAMP_AGENT_URL="${TELFLO_OPAMP_AGENT_HOST_URL:-http://127.0.0.1:51234}"
OPAMP_REPLICA_PORT="${TELFLO_OPAMP_REPLICA_HOST_PORT:-51239}"
EMAIL="stack-smoke-$(date +%s)-$$@example.com"
PASSWORD="a-sufficiently-long-password"
# The Terms a registration accepts: the SaaS's version; the open-source
# defaults ask for none, so no registration sends one.
if [ "$SMOKE_SITE" = "saas" ]; then TERMS_VERSION="2026-01-01"; else TERMS_VERSION=""; fi
# The group organization: the bootstrap's (oss) or created through the
# gateway (saas), below.
ORGANIZATION_NAME="Stack smoke $(date +%s)-$$"

# docker-compose.yml turns the cookies' Secure attribute off (Safari refuses
# Secure cookies on http://localhost), so curl's jar keeps and sends them
# either way; this script does not assert the attribute.
work_dir=$(mktemp -d)
# A run that ends inside the regex library's product-admin steps (below)
# deletes the library entry it created, by id, if it's still there, then
# clears the account's flag again: each best effort, in a subshell so a
# failure there can't skip the rest, the entry first (while the run still
# knows its id; the delete is SQL, so the flag isn't needed for it). Then the
# work directory goes. In oss, telflo-admin bootstrap makes the account the
# first product admin: marked here before it runs, so a run that ends before
# the flag is cleared (below) clears it too.
product_admin_granted=""
created_regex_id=""
# The library steps (below) do the same with the library file they add:
# its row deleted by SQL (delete_created_library_file), before the flag.
created_library_file_id=""
# The product-administration steps (below) grant the invitee the flag
# through the API: a run that ends between that grant and its removal clears
# the invitee's flag by SQL too (product_admin false "$INVITEE_EMAIL"), so
# the EXIT trap clears both flags.
invitee_product_admin_granted=""
# The organization steps (below) turn the product admins' switch off on a
# throwaway stack, for the account's create, and on again at once: a run
# that ends between the two puts it back on by SQL (organization_creation_on).
organization_creation_opened=""
# The fleet steps (below) leave, until their last steps remove them: the
# collectors' containers, the second replica's, the fleet, the smoke
# collector's image, and the fleet's configuration and its published
# version. A run that ends among them removes what it made, by name and id,
# best effort, before the work directory (which holds the management API's
# header file and the cookies) goes: the configuration through the gateway,
# then its published version through the management API, in case the
# platform's after-response delete didn't.
fleet_id=""
fleet_containers=""
replica_container=""
fleet_configuration_id=""
fleet_publication_id=""
smoke_collector_image=""
fleet_cleanup_failed=""
remove_fleet_steps() {
  fleet_cleanup_failed=""
  local container
  for container in $fleet_containers $replica_container; do
    docker rm -f "$container" >/dev/null 2>&1 || fleet_cleanup_failed="$fleet_cleanup_failed the container $container;"
  done
  fleet_containers=""
  replica_container=""
  if [ -n "$fleet_id" ]; then
    management DELETE "$FLEETS_URL/$fleet_id"
    [ "$status" = "204" ] || fleet_cleanup_failed="$fleet_cleanup_failed the fleet (HTTP $status);"
    fleet_id=""
  fi
  if [ -n "$smoke_collector_image" ]; then
    docker rmi "$smoke_collector_image" >/dev/null 2>&1 || fleet_cleanup_failed="$fleet_cleanup_failed the image $smoke_collector_image;"
    smoke_collector_image=""
  fi
}
# The platform fleet steps (below), in the group organization, leave until
# their last steps remove them: edge-b1's and edge-b2's containers, the fleet
# (the organization's delete removes it in the opamp-server), the smoke
# collector's image built again for them, and their configuration. A run
# that ends among them removes each, best effort: the containers, the fleet
# through the management API (so the configuration is no longer in use),
# the image, then the configuration through the gateway.
managed_containers=""
managed_fleet_id=""
managed_image=""
managed_configuration_id=""
# The Kubernetes fleet (below), made through the platform in the group
# organization, until its last step deletes it: removed the same way.
k8s_fleet_id=""
remove_managed_steps() {
  local container
  for container in $managed_containers; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  if [ -n "$managed_fleet_id" ]; then
    management DELETE "$OPAMP_MANAGEMENT_URL/api/v1/organizations/$group_id/fleets/$managed_fleet_id" || true
  fi
  if [ -n "$k8s_fleet_id" ]; then
    management DELETE "$OPAMP_MANAGEMENT_URL/api/v1/organizations/$group_id/fleets/$k8s_fleet_id" || true
  fi
  if [ -n "$managed_image" ]; then docker rmi "$managed_image" >/dev/null 2>&1 || true; fi
  if [ -n "$managed_configuration_id" ]; then
    curl -s -o /dev/null --max-time 30 -b "$JAR" -X DELETE \
      "$GATEWAY_URL/api/v1/organizations/$group_id/configurations/$managed_configuration_id" -H 'X-Telflo-CSRF: 1' || true
  fi
}
# The organization-variable steps (below), in edge-b1's fleet's group
# "unassigned-b", leave until their last steps delete them: two variables, two
# variable groups and a configuration, each through the platform. A run that
# ends among them deletes each by id, best effort, through the gateway, once
# edge-b1's fleet is removed (remove_managed_steps, before), so nothing uses
# them any more: the variable groups, then the variables, then the
# configuration, then its published version through the management API, in
# case the platform's after-response delete didn't.
variable_ids=""
variable_group_ids=""
variable_configuration_id=""
variable_publication_id=""
remove_variable_steps() {
  local id organization_url="$GATEWAY_URL/api/v1/organizations/$group_id"
  for id in $variable_group_ids; do
    curl -s -o /dev/null --max-time 30 -b "$JAR" -X DELETE "$organization_url/variable-groups/$id" -H 'X-Telflo-CSRF: 1' || true
  done
  for id in $variable_ids; do
    curl -s -o /dev/null --max-time 30 -b "$JAR" -X DELETE "$organization_url/variables/$id" -H 'X-Telflo-CSRF: 1' || true
  done
  if [ -n "$variable_configuration_id" ]; then
    curl -s -o /dev/null --max-time 30 -b "$JAR" -X DELETE "$organization_url/configurations/$variable_configuration_id" \
      -H 'X-Telflo-CSRF: 1' || true
  fi
  if [ -n "$variable_publication_id" ]; then
    management DELETE "$OPAMP_MANAGEMENT_URL/api/v1/organizations/$group_id/publications/$variable_publication_id" || true
  fi
}
# The install steps (below), in edge-b1's fleet, leave until their last
# step removes them: the installed collectors' containers (the container
# install's and the All In One bundle's) and the container install's
# volume, each named for the compose project. A run that ends among them
# removes each by name, best effort, the containers before the volume (the
# fleet and the group go with edge-b1's fleet).
install_containers=""
install_volume=""
# The public API steps (below) make a personal token on the account, revoked
# at their end: a run that ends among them revokes it (on_exit). Everything
# else they make is the group organization's.
public_api_personal_token_id=""
remove_install_steps() {
  local container
  for container in $install_containers; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  if [ -n "$install_volume" ]; then docker volume rm "$install_volume" >/dev/null 2>&1 || true; fi
}
on_exit() {
  if [ -n "$organization_creation_opened" ]; then (organization_creation_on) >/dev/null 2>&1 || true; fi
  if [ -n "$created_regex_id" ]; then (delete_created_regex "$created_regex_id") >/dev/null 2>&1 || true; fi
  if [ -n "$created_library_file_id" ]; then
    (delete_created_library_file "$created_library_file_id") >/dev/null 2>&1 || true
  fi
  if [ -n "$invitee_product_admin_granted" ]; then (product_admin false "$INVITEE_EMAIL") >/dev/null 2>&1 || true; fi
  if [ -n "$product_admin_granted" ]; then (product_admin false) >/dev/null 2>&1 || true; fi
  if [ -n "$fleet_id$fleet_containers$replica_container$smoke_collector_image" ]; then
    (remove_fleet_steps) >/dev/null 2>&1 || true
  fi
  if [ -n "$fleet_configuration_id" ]; then
    curl -s -o /dev/null --max-time 30 -b "$JAR" -X DELETE "$CONFIGURATIONS_URL/$fleet_configuration_id" \
      -H 'X-Telflo-CSRF: 1' >/dev/null 2>&1 || true
  fi
  if [ -n "$fleet_publication_id" ]; then
    (management DELETE "$ORGANIZATION_MANAGEMENT_URL/publications/$fleet_publication_id") >/dev/null 2>&1 || true
  fi
  if [ -n "$install_containers$install_volume" ]; then
    (remove_install_steps) >/dev/null 2>&1 || true
  fi
  if [ -n "$managed_containers$managed_fleet_id$managed_image$managed_configuration_id$k8s_fleet_id" ]; then
    (remove_managed_steps) >/dev/null 2>&1 || true
  fi
  if [ -n "$variable_ids$variable_group_ids$variable_configuration_id$variable_publication_id" ]; then
    (remove_variable_steps) >/dev/null 2>&1 || true
  fi
  # The public API steps' personal token, revoked through the session (the service account and its tokens go with the
  # group).
  if [ -n "$public_api_personal_token_id" ]; then
    curl -s -o /dev/null --max-time 30 -b "$JAR" -X DELETE "$GATEWAY_URL/api/v1/auth/me/api-tokens/$public_api_personal_token_id" \
      -H 'X-Telflo-CSRF: 1' >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap on_exit EXIT
JAR="$work_dir/cookies"

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "--- $*"; }

# The run's secrets, one a line in a 0600 file of the work folder (gone with
# it), for the last step's search of the logs (grep -cF -f, counts only):
# both passwords, the invitation's token and, in oss, the set-password
# link's token. Never printed.
RUN_SECRETS="$work_dir/run-secrets"
remember_secret() {
  [ -n "$1" ] || fail "a secret to search the logs for is empty"
  (umask 077 && printf '%s\n' "$1" >>"$RUN_SECRETS") || fail "writing the run's secrets file failed"
}
remember_secret "$PASSWORD"

# stack_psql [psql -v settings…]: runs the SQL on standard input as the
# telflo_platform_owner superuser on the stack's own database (the project's, from
# COMPOSE_FILE and COMPOSE_PROJECT_NAME), through opamp-bootstrap's
# psql as refused_connection below does (the service's environment carries
# the superuser's password). The SQL goes in on standard input, since psql
# doesn't interpolate -v variables in -c; every value is a psql variable,
# quoted by psql. Unaligned tuples only on standard output, psql's errors in
# $work_dir/stack-psql-stderr.
stack_psql() {
  docker compose run --rm -T --no-deps opamp-bootstrap \
    psql -h db -U telflo_platform_owner -d telflo_platform -X -q -t -A -v ON_ERROR_STOP=1 "$@" 2>"$work_dir/stack-psql-stderr"
}

# product_admin true|false [<email>]: sets is_product_admin by SQL
# (stack_psql) on the account with <email>, the smoke's account ($EMAIL) by
# default. Fails unless exactly one id comes back. The smoke's account's
# grant is marked (product_admin_granted) before it's sent, so a run that
# dies after an UPDATE that went through (whatever psql answered) still has
# the EXIT trap clear it; its revoke is unmarked only once it's known to
# have gone through. Another account's mark is its caller's (the
# product-administration steps' invitee, granted through the API:
# invitee_product_admin_granted). The session needs no new sign-in: every
# request reads the flag from the user's row.
product_admin() {
  local flag=$1 email=${2:-$EMAIL} output ids
  if [ "$flag" = "true" ] && [ "$email" = "$EMAIL" ]; then product_admin_granted=yes; fi
  output=$(stack_psql -v flag="$flag" -v email="$email" <<'SQL'
update users set is_product_admin = :'flag'::boolean where lower(email) = lower(:'email') returning id;
SQL
  ) || fail "setting is_product_admin to $flag failed: $output $(cat "$work_dir/stack-psql-stderr")"
  ids=$(grep -cE '^[0-9a-f-]{36}$' <<<"$output" || true)
  [ "$ids" = "1" ] && [ "$(grep -cv '^$' <<<"$output" || true)" = "1" ] ||
    fail "setting is_product_admin to $flag answered $ids ids, not one: $output"
  if [ "$flag" != "true" ] && [ "$email" = "$EMAIL" ]; then product_admin_granted=""; fi
}

# organization_creation_on: puts the product admins' switch "Only product
# admins can create organizations" back on by SQL (stack_psql), as a fresh
# stack has it: the organization steps' clean-up, and the EXIT
# trap's when a run ends while they have it off.
organization_creation_on() {
  stack_psql <<'SQL'
update site_settings set organization_creation = 'product_admins';
SQL
}

# The settings and files the fleet steps rely on, checked before any step, so
# a run against the wrong ones fails at once, naming what to change.
# The agent URL this script polls must be the agent port this
# stack publishes: compose's own answer, whatever the host URL settings say.
step "TELFLO_OPAMP_AGENT_HOST_URL is the agent port this stack publishes: docker compose port opamp-server 51234"
published_agent=$(docker compose port opamp-server 51234 2>/dev/null | tail -n1 || true)
[[ "$OPAMP_AGENT_URL" =~ ^http://([^/:]+):([0-9]+)/?$ ]] ||
  fail "TELFLO_OPAMP_AGENT_HOST_URL ($OPAMP_AGENT_URL) isn't http://<host>:<port>: set it to this stack's published agent port, http://${published_agent:-<host>:<port>}"
agent_url_host=${BASH_REMATCH[1]}
agent_url_port=${BASH_REMATCH[2]}
[[ "$published_agent" =~ ^(.+):([0-9]+)$ ]] && [ "${BASH_REMATCH[2]}" != "0" ] ||
  fail "this stack publishes no agent port (docker compose port opamp-server 51234 answered '${published_agent}'): is opamp-server running in this compose project (COMPOSE_FILE, COMPOSE_PROJECT_NAME)?"
published_agent_host=${BASH_REMATCH[1]}
published_agent_port=${BASH_REMATCH[2]}
if [ "$agent_url_port" != "$published_agent_port" ] ||
  { [ "$published_agent_host" != "0.0.0.0" ] && [ "$published_agent_host" != "[::]" ] && [ "$published_agent_host" != "$agent_url_host" ]; }; then
  fail "TELFLO_OPAMP_AGENT_HOST_URL is $OPAMP_AGENT_URL, but this stack publishes the opamp-server's agent port on $published_agent: set TELFLO_OPAMP_AGENT_HOST_URL=http://$published_agent"
fi

# The smoke collector (docker/smoke-collector) copies its collector out of
# the stack's validator image, which always holds the catalog's default
# version (CI's stack job and the throwaway gate stacks build it with
# OTELCOL_VERSIONS=default), and runs it under the supervisor image of the
# same version (its FROM tag): all three must name the same version.
step "the smoke collector's collector and supervisor are the catalog's default version"
repo_dir="$(dirname "$0")/.."
catalog_default=$(jq -r '[.versions[] | select(.default == true) | .version] | if length == 1 then .[0] else empty end' \
  "$repo_dir/catalog/distributions/otelcol-contrib.json")
[ -n "$catalog_default" ] || fail "catalog/distributions/otelcol-contrib.json doesn't name one default version"
smoke_collector_version=$(sed -n 's|^COPY --from=validator .*/opt/otelcol/v\([^/]*\)/otelcol-contrib .*|\1|p' \
  "$repo_dir/docker/smoke-collector/Dockerfile")
smoke_supervisor_version=$(sed -n 's|^FROM otel/opentelemetry-collector-opampsupervisor:\([^@ ]*\).*|\1|p' \
  "$repo_dir/docker/smoke-collector/Dockerfile")
[ "$smoke_collector_version" = "$catalog_default" ] && [ "$smoke_supervisor_version" = "$catalog_default" ] ||
  fail "docker/smoke-collector/Dockerfile copies /opt/otelcol/v${smoke_collector_version:-?}/otelcol-contrib and runs it under the supervisor image ${smoke_supervisor_version:-?} (its FROM tag), but the catalogue's default (catalog/distributions/otelcol-contrib.json) is $catalog_default, the one version the validator image always holds: move the smoke collector to $catalog_default (its COPY path, and its supervisor image's FROM tag and digest)"

# The CLI steps (in the public API section, below) run the CLI that TELFLO_SMOKE_CLI names
# (the gates set it to the package check's install of the tarball), by default the checkout's own build, with node.
# The gate runs this script from a copy with no build, so a missing or broken CLI fails here, before any step. Every
# CLI run has a HOME and a TELFLO_CLI_CONFIG_DIR of the work folder's (0700), and XDG_CONFIG_HOME, TELFLO_TOKEN,
# TELFLO_SERVER, TELFLO_ORG and TELFLO_CONFIG_DIR unset (cli_env): it never reads or writes a real login.
SMOKE_CLI="${TELFLO_SMOKE_CLI:-$repo_dir/telflo-core/apps/cli/dist/index.js}"
CLI_DIR="$work_dir/cli"
CLI_HOME="$work_dir/cli-home"
CLI_CONFIG="$work_dir/cli-config"
CLI_ANONYMOUS_CONFIG="$work_dir/cli-config-anonymous"
mkdir -m 700 "$CLI_DIR" "$CLI_HOME" "$CLI_CONFIG" "$CLI_ANONYMOUS_CONFIG" || fail "creating the CLI's folders in the work folder failed"
# cli_env <NAME=value>... <command> [<args>...]: the command with HOME the work folder's and every variable that
# could name a real login unset (an assignment given after them, such as TELFLO_SERVER, sets it again).
cli_env() {
  env -u XDG_CONFIG_HOME -u TELFLO_TOKEN -u TELFLO_SERVER -u TELFLO_ORG -u TELFLO_CONFIG_DIR HOME="$CLI_HOME" "$@"
}
step "the CLI the smoke runs (TELFLO_SMOKE_CLI, by default telflo-core/apps/cli/dist/index.js) is there, and node runs its -V"
[ -f "$SMOKE_CLI" ] ||
  fail "the CLI isn't there: no $SMOKE_CLI (build it with npm run build -w @telflo/cli in telflo-core, or set TELFLO_SMOKE_CLI to an installed copy's dist/index.js)"
smoke_cli_version=$(cli_env TELFLO_CLI_CONFIG_DIR="$CLI_CONFIG" node "$SMOKE_CLI" -V </dev/null 2>/dev/null) ||
  fail "node $SMOKE_CLI -V failed: rebuild the CLI (npm run build -w @telflo/cli), or set TELFLO_SMOKE_CLI to a working copy"
[[ "$smoke_cli_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "node $SMOKE_CLI -V printed no version"

# The file store the stack's API runs on: compose's TELFLO_FILE_STORE, local unless the stack was
# started with TELFLO_FILE_STORE=s3 and the profile s3. A run told which to
# expect (TELFLO_SMOKE_FILE_STORE, as the gates' two runs are; not
# TELFLO_FILE_STORE, which the shell running this may hold for its own
# reasons) fails at once on the other: a plain `up -d` quietly recreates an
# S3 stack's API on the local disk. On s3, the test-file steps below also
# read the object store's filer from inside object-store (its filer
# is on the object store's own network only); never its logs, which name
# the access key id.
step "the API's file store: docker compose exec api printenv TELFLO_FILE_STORE"
file_store_kind=$(docker compose exec -T api printenv TELFLO_FILE_STORE) ||
  fail "couldn't read the API's TELFLO_FILE_STORE"
[ "$file_store_kind" = "local" ] || [ "$file_store_kind" = "s3" ] ||
  fail "the API's TELFLO_FILE_STORE is '$file_store_kind', neither local nor s3"
[ -z "${TELFLO_SMOKE_FILE_STORE:-}" ] || [ "$file_store_kind" = "$TELFLO_SMOKE_FILE_STORE" ] ||
  fail "the stack's API runs on the file store $file_store_kind, not TELFLO_SMOKE_FILE_STORE=$TELFLO_SMOKE_FILE_STORE: start the stack with TELFLO_FILE_STORE=s3 and --profile s3 for s3, without them for local"

# On s3: the filer's record of an object under the bucket telflo-files, as
# JSON (`?metadata=true`; a directory's listing, its Entries, without it).
# Answers nothing and fails when there is none, and when the exec itself
# fails (its errors, Compose's too, are hidden): a failure means "couldn't
# read, or there's no object".
object_store_json() {
  docker compose exec -T object-store wget -q -O - --header 'Accept: application/json' \
    "http://127.0.0.1:8888/buckets/telflo-files/$1" 2>/dev/null
}

# object_store_missing <path>: whether the filer answers a definite 404 for <path> under the bucket
# telflo-files (BusyBox wget's error line names the status), not a read that failed any other way (the
# container down, a refused connection, a 5xx): those are not "gone".
object_store_missing() {
  local said
  said=$(docker compose exec -T object-store wget -q -O /dev/null --header 'Accept: application/json' \
    "http://127.0.0.1:8888/buckets/telflo-files/$1" 2>&1 >/dev/null) && return 1
  grep -q 'server returned error: HTTP/[0-9.]* 404' <<<"$said"
}

# The platform's real client against the real opamp-server, over the compose
# network, with the API container's own TELFLO_OPAMP_MANAGEMENT_* settings
# (its working directory is /app/apps/api). Its arguments are
# stack-smoke.ts's: a personal organization's id, or group-registered <id>
# <name>, group-renamed <id> <name>, group-gone <id>, publications
# <organization id> <configuration id> <count> [version number] or
# publication <organization id> <configuration id> <version number>
# <version id> <sha256> <distribution> <collector version>. It prints
# one line per step and never the secret, the YAML or an organization's or a
# configuration's name, and asks for what the platform sends after its
# responses for up to about 10 s.
stack_smoke() { docker compose exec -T api node dist/opamp-server/stack-smoke.js "$@"; }

# The SHA-256 (hex) of standard input's bytes: sha256sum where there is one
# (Linux), else shasum (macOS).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

step "gateway serves the web app's register page"
status=$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY_URL/register")
[ "$status" = "200" ] || fail "GET /register returned HTTP $status"

step "gateway routes /api/public/v1/ to the API: /whoami without a token is 401 invalid_api_token, WWW-Authenticate: Bearer"
response=$(curl -s -D "$work_dir/whoami-headers" -w '\n%{http_code}' "$GATEWAY_URL/api/public/v1/whoami")
status=$(tail -n1 <<<"$response")
[ "$status" = "401" ] || fail "GET /api/public/v1/whoami without a token returned HTTP $status, not 401"
[ "$(jq -r '.error.code' <<<"$(sed '$d' <<<"$response")" 2>/dev/null || true)" = "invalid_api_token" ] ||
  fail "GET /api/public/v1/whoami without a token answered $(sed '$d' <<<"$response"), not invalid_api_token"
grep -qi '^www-authenticate: Bearer' "$work_dir/whoami-headers" ||
  fail "GET /api/public/v1/whoami without a token answered no WWW-Authenticate: Bearer"

# register_verified <email> <password> [<label>]: registers <email> with <password> and the current terms
# through the gateway, finds its verification email in Mailpit (30 s at most), loads the emailed link's page
# through the gateway and verifies the account with the link's token: the four steps of the smoke's first
# account, below, and the product-administration steps' third account's. Its step lines and failures name
# <label>, the email by default; those steps pass fixed words, so the third account's address is never
# printed.
register_verified() {
  local email=$1 password=$2 label=${3:-$1} body response status message_id text link token verified
  step "gateway routes /api/ to the API: register $label"
  body=$(jq -n --arg email "$email" \
    --arg password "$password" \
    --arg terms "$TERMS_VERSION" \
    '{email: $email, password: $password, acceptedTermsVersion: $terms}')
  response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/auth/register" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' -d "$body")
  status=$(tail -n1 <<<"$response")
  [ "$status" = "200" ] || fail "register returned HTTP $status: $(sed '$d' <<<"$response")"

  step "the API delivered the verification email to Mailpit"
  message_id=""
  for _ in $(seq 1 30); do
    message_id=$(curl -s "$MAILPIT_URL/api/v1/search?query=to:%22$email%22" | jq -r '.messages[0].ID // empty')
    [ -n "$message_id" ] && break
    sleep 1
  done
  [ -n "$message_id" ] || fail "no email to $label arrived in Mailpit within 30s"

  text=$(curl -s "$MAILPIT_URL/api/v1/message/$message_id" | jq -r '.Text')
  link=$(grep -oE 'https?://[^[:space:]]+/verify-email#token=[A-Za-z0-9_-]+' <<<"$text" | head -n1)
  [ -n "$link" ] || fail "the email contains no verification link, its token in the fragment"
  [[ "$link" == "$GATEWAY_URL/verify-email#token="* ]] ||
    fail "the link points at ${link%%#*}, not the gateway ($GATEWAY_URL)"

  step "the emailed link's page loads through the gateway (curl sends no fragment)"
  status=$(curl -s -o /dev/null -w '%{http_code}' "${link%%#*}")
  [ "$status" = "200" ] || fail "GET ${link%%#*} returned HTTP $status"

  step "the token from the email verifies the account"
  token="${link##*token=}"
  response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/auth/verify-email" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' -d "$(jq -n --arg token "$token" '{token: $token}')")
  status=$(tail -n1 <<<"$response")
  verified=$(sed '$d' <<<"$response" | jq -r '.status // empty')
  [ "$status" = "200" ] && [ "$verified" = "verified" ] ||
    fail "verify-email returned HTTP $status: $(sed '$d' <<<"$response")"
}

if [ "$SMOKE_SITE" = "saas" ]; then
  register_verified "$EMAIL" "$PASSWORD"
else
  # The open-source defaults: nobody registers; the first account is the bootstrap's (as a Compose
  # install makes it), and its password is set through the link the command prints.
  step "registration isn't open (invite-only): POST /api/v1/auth/register is 403 registration_not_open"
  response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/auth/register" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg email "$EMAIL" --arg password "$PASSWORD" '{email: $email, password: $password}')")
  status=$(tail -n1 <<<"$response")
  code=$(sed '$d' <<<"$response" | jq -r '.error.code // empty' 2>/dev/null || true)
  [ "$status" = "403" ] && [ "$code" = "registration_not_open" ] ||
    fail "register returned HTTP $status ${code:-with no error code}, not 403 registration_not_open"

  step "telflo-admin bootstrap in the API's container makes $EMAIL the first product admin and the group organization: docker compose exec -T api telflo-admin bootstrap --email --organization exits 0 (its standard output in a 0600 file, never printed)"
  bootstrap_out="$work_dir/bootstrap-stdout"
  bootstrap_err="$work_dir/bootstrap-stderr"
  # Marked before it runs: a run that ends after the account is made clears its flag (the EXIT trap).
  product_admin_granted=yes
  bootstrap_code=0
  (umask 077 && docker compose exec -T api telflo-admin bootstrap --email "$EMAIL" --organization "$ORGANIZATION_NAME" \
    </dev/null >"$bootstrap_out" 2>"$bootstrap_err") || bootstrap_code=$?
  # Its standard error holds fixed lines only (the link is standard output's alone).
  [ "$bootstrap_code" = "0" ] || fail "telflo-admin bootstrap exited $bootstrap_code: $(cat "$bootstrap_err")"

  step "the bootstrap printed its fixed lines, then the set-password link as its last line, at the gateway's origin (read into a variable, never printed)"
  bootstrap_lines=$(grep -c '' "$bootstrap_out" || true)
  [ "$bootstrap_lines" = "4" ] || fail "the bootstrap's standard output has ${bootstrap_lines:-no} lines, not 4 (not printed)"
  [ "$(sed -n 1p "$bootstrap_out" | tr -d '\r')" = "Created the account $EMAIL and made it the first product admin." ] &&
    [ "$(sed -n 2p "$bootstrap_out" | tr -d '\r')" = "Created the organization, with the account as its admin." ] &&
    sed -n 3p "$bootstrap_out" | tr -d '\r' | grep -qE '^Open this link within [0-9]+ minutes to set the password \(it works once\):$' ||
    fail "the bootstrap's first three lines aren't its fixed lines (account, organization, link) (not printed)"
  bootstrap_link=$(tail -n 1 "$bootstrap_out" | tr -d '\r')
  rm -f "$bootstrap_out"
  [[ "$bootstrap_link" =~ ^https?://[^[:space:]#]+/reset-password#token=[A-Za-z0-9_-]+$ ]] ||
    fail "the bootstrap's last line isn't a set-password link (not printed)"
  [[ "$bootstrap_link" == "$GATEWAY_URL/reset-password#token="* ]] ||
    fail "the set-password link points at ${bootstrap_link%%#*}, not the gateway ($GATEWAY_URL)"
  bootstrap_token="${bootstrap_link##*token=}"
  remember_secret "$bootstrap_token"
  bootstrap_err_hits=$(grep -cF -f "$RUN_SECRETS" -- "$bootstrap_err" || true)
  [ "$bootstrap_err_hits" = "0" ] ||
    fail "the bootstrap's standard error holds a secret of the run on ${bootstrap_err_hits:-an unread number of} lines (not printed)"

  step "the set-password link's page loads through the gateway (its path: the token is in the fragment)"
  status=$(curl -s -o /dev/null -w '%{http_code}' "${bootstrap_link%%#*}")
  [ "$status" = "200" ] || fail "GET ${bootstrap_link%%#*} returned HTTP $status"

  step "the link's token sets the account's password: POST /api/v1/auth/password-resets answers 204"
  response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/auth/password-resets" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg token "$bootstrap_token" --arg password "$PASSWORD" '{token: $token, password: $password}')")
  status=$(tail -n1 <<<"$response")
  [ "$status" = "204" ] || fail "setting the password with the bootstrap's link returned HTTP $status: $(sed '$d' <<<"$response")"
  unset bootstrap_link bootstrap_token
fi

step "sign in through the gateway sets both session cookies"
headers="$work_dir/sign-in-headers"
response=$(curl -s -w '\n%{http_code}' -D "$headers" -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/sessions" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg email "$EMAIL" --arg password "$PASSWORD" '{email: $email, password: $password}')")
status=$(tail -n1 <<<"$response")
[ "$status" = "200" ] || fail "sign-in returned HTTP $status: $(sed '$d' <<<"$response")"
grep -qi '^set-cookie: telflo_access=[^;]' "$headers" || fail "sign-in set no telflo_access cookie"
grep -qi '^set-cookie: telflo_refresh=[^;]' "$headers" || fail "sign-in set no telflo_refresh cookie"
# Kept to prove, after sign-out, that the server revoked the session rather
# than the jar merely forgetting the cookie.
cp "$JAR" "$work_dir/signed-in-cookies"

step "GET /api/v1/auth/me returns the signed-in user and their workspace"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$GATEWAY_URL/api/v1/auth/me")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] ||
  fail "GET /api/v1/auth/me returned HTTP $status (did curl send the session cookies?): $body"
[ "$(jq -r '.user.email' <<<"$body")" = "$EMAIL" ] || fail "/me returned the wrong user: $body"
if [ "$SMOKE_SITE" = "saas" ]; then
  [ "$(jq -r '.organization.name' <<<"$body")" = "$EMAIL" ] ||
    fail "/me returned the wrong organization: $body"
  # The personal organization, which the organization steps switch back to.
  personal_id=$(jq -r '.organization.id' <<<"$body")
else
  # The sign-in lands in the organization joined last: the bootstrap's group organization,
  # the account its admin and the first product admin; the open-source defaults ask for no Terms.
  [ "$(jq -c '[.organization.name, .organization.type, .organization.role, .isProductAdmin, .mayCreateOrganizations, .termsAcceptanceRequired]' <<<"$body")" = \
    "$(jq -cn --arg name "$ORGANIZATION_NAME" '[$name, "group", "admin", true, true, false]')" ] ||
    fail "/me isn't the bootstrap's product admin, in its group organization as its admin, asked for no Terms: $body"
  group_id=$(jq -r '.organization.id' <<<"$body")
  [ -n "$group_id" ] && [ "$group_id" != "null" ] || fail "/me named no group organization id"
  # The personal organization every account gets, which the organization steps switch to.
  personal_id=$(jq -r '[.organizations[] | select(.type == "personal") | .id] | if length == 1 then .[0] else empty end' <<<"$body")
  [ -n "$personal_id" ] || fail "/me lists $(jq -r '[.organizations[] | select(.type == "personal")] | length' <<<"$body") personal organizations, not one"
fi
[ -n "$personal_id" ] && [ "$personal_id" != "null" ] ||
  fail "/me named no organization id: its organization's fields were $(jq -c '.organization | keys? // empty' <<<"$body" 2>/dev/null)"
# The account's id, in its test files' keys (the S3 checks below).
user_id=$(jq -r '.user.id' <<<"$body")
[ -n "$user_id" ] && [ "$user_id" != "null" ] ||
  fail "/me named no user id: its user's fields were $(jq -c '.user | keys? // empty' <<<"$body" 2>/dev/null)"

# The value of a cookie in curl's Netscape-format jar (HttpOnly cookies are
# written on lines prefixed "#HttpOnly_", which awk still reads).
jar_cookie() { awk -F '\t' -v name="$1" '$6 == name { value = $7 } END { print value }' "$JAR"; }

step "POST /api/v1/auth/refresh through the gateway rotates the refresh cookie"
old_refresh=$(jar_cookie telflo_refresh)
[ -n "$old_refresh" ] || fail "the jar holds no telflo_refresh cookie to refresh with"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/refresh" \
  -H 'X-Telflo-CSRF: 1')
status=$(tail -n1 <<<"$response")
[ "$status" = "200" ] || fail "refresh returned HTTP $status: $(sed '$d' <<<"$response")"
new_refresh=$(jar_cookie telflo_refresh)
[ -n "$new_refresh" ] && [ "$new_refresh" != "$old_refresh" ] ||
  fail "refresh did not rotate the telflo_refresh cookie in the jar"

step "GET /api/v1/auth/me with the rotated cookies returns the signed-in user"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$GATEWAY_URL/api/v1/auth/me")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "GET /api/v1/auth/me after refresh returned HTTP $status: $body"
[ "$(jq -r '.user.email' <<<"$body")" = "$EMAIL" ] || fail "/me after refresh returned the wrong user: $body"

step "GET /app renders for the signed-in user (web loader reached the API)"
read -r status content_type < <(curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -b "$JAR" "$GATEWAY_URL/app")
[ "$status" = "200" ] || fail "GET /app returned HTTP $status"
[[ "$content_type" == text/html* ]] || fail "GET /app returned $content_type, not HTML"

# Who may create an organization: the product admins' switch "Only product
# admins can create organizations" is on in a fresh stack. On a throwaway
# stack (as the product-admin steps below), the account, an ordinary one, is
# refused first; made a product admin by SQL for one call, it turns the switch
# off through the real PATCH /api/v1/product-admin/settings, and its flag is
# cleared again; it creates its group organization as the ordinary account it
# is, and the switch goes back on by SQL at once (or in the EXIT trap), so the
# next run finds a fresh stack's default. On any other stack (it may be a
# developer's own) nothing changes: the create needs the switch off already,
# and a run that finds it on fails saying so. In oss the bootstrap made the
# group organization as the first product admin; once its flag is cleared, the
# account's own create is refused, and nothing changes the switch.
# /api/v1/auth/me's mayCreateOrganizations for the account: true or false.
may_create_organizations() {
  curl -s --max-time 30 -b "$JAR" "$GATEWAY_URL/api/v1/auth/me" | jq -r '.mayCreateOrganizations' 2>/dev/null || true
}
# POST /api/v1/organizations named $1, by default $ORGANIZATION_NAME: the answer into $status and $body.
create_organization() {
  response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$GATEWAY_URL/api/v1/organizations" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg name "${1:-$ORGANIZATION_NAME}" '{name: $name}')")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
}

if [ "$SMOKE_SITE" = "oss" ]; then
  # The bootstrap made the group organization as the first product admin (above). Its flag goes now, by SQL as
  # the product-admin steps below clear theirs: the account is an ordinary admin of its organizations, as every
  # step after assumes, and the EXIT trap clears it should this fail.
  step "the bootstrap's flag cleared by SQL: /api/v1/auth/me's isProductAdmin and mayCreateOrganizations are false, and the account's POST /api/v1/organizations is 403 organization_creation_restricted (the switch on by default)"
  product_admin false
  response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" "$GATEWAY_URL/api/v1/auth/me" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] && [ "$(jq -c '[.isProductAdmin, .mayCreateOrganizations]' <<<"$body" 2>/dev/null)" = '[false,false]' ] ||
    fail "after the flag's clearing, GET /api/v1/auth/me returned HTTP $status, isProductAdmin and mayCreateOrganizations $(jq -c '[.isProductAdmin, .mayCreateOrganizations]' <<<"$body" 2>/dev/null), not both false"
  create_organization "$ORGANIZATION_NAME refused"
  [ "$status" = "403" ] && [ "$(jq -r '.error.code // empty' <<<"$body" 2>/dev/null)" = "organization_creation_restricted" ] ||
    fail "an ordinary account's create returned HTTP $status $(jq -r '.error.code // empty' <<<"$body" 2>/dev/null), not 403 organization_creation_restricted"
elif throwaway_stack; then
  step "only product admins create organizations, as a fresh stack has it: /api/v1/auth/me's mayCreateOrganizations is false, and the account's POST /api/v1/organizations is 403 organization_creation_restricted"
  [ "$(may_create_organizations)" = "false" ] ||
    fail "/api/v1/auth/me's mayCreateOrganizations is $(may_create_organizations), not false: is the switch on, as a fresh stack has it?"
  create_organization
  [ "$status" = "403" ] && [ "$(jq -r '.error.code // empty' <<<"$body" 2>/dev/null)" = "organization_creation_restricted" ] ||
    fail "an ordinary account's create returned HTTP $status $(jq -r '.error.code // empty' <<<"$body" 2>/dev/null), not 403 organization_creation_restricted"

  step "a product admin turns the switch off: PATCH /api/v1/product-admin/settings {organizationCreation: everyone} is 200, no-store (the account's flag set by SQL for the call, then cleared)"
  product_admin true
  organization_creation_opened=yes
  settings_headers="$work_dir/settings-headers"
  response=$(curl -s -w '\n%{http_code}' -D "$settings_headers" -b "$JAR" -X PATCH "$GATEWAY_URL/api/v1/product-admin/settings" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' -d '{"organizationCreation":"everyone"}')
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] && [ "$(jq -c . <<<"$body" 2>/dev/null)" = '{"organizationCreation":"everyone"}' ] ||
    fail "turning the switch off returned HTTP $status: $body"
  grep -qiE '^cache-control:[[:space:]]*no-store' "$settings_headers" ||
    fail "PATCH /api/v1/product-admin/settings isn't Cache-Control: no-store"
  product_admin false
  [ "$(may_create_organizations)" = "true" ] ||
    fail "with the switch off, /api/v1/auth/me's mayCreateOrganizations is $(may_create_organizations), not true"
else
  step "SKIPPED: turning the product admins' switch off for the create (a product admin by SQL) runs only on a throwaway stack: COMPOSE_PROJECT_NAME is ${COMPOSE_PROJECT_NAME:-unset}, not a throwaway stack's"
  [ "$(may_create_organizations)" = "true" ] ||
    fail "only product admins may create organizations on this stack (a fresh stack's default): turn \"Only product admins can create organizations\" off on its Product admins page, or run on a throwaway stack (COMPOSE_PROJECT_NAME)"
fi

if [ "$SMOKE_SITE" = "saas" ]; then
  step "create an organization through the gateway: POST /api/v1/organizations"
  create_organization
  [ "$status" = "201" ] || fail "creating an organization returned HTTP $status: $body"
  group_id=$(jq -r '.organization.id' <<<"$body")
  [ -n "$group_id" ] && [ "$group_id" != "null" ] || fail "the created organization has no id: $body"
fi

if [ -n "$organization_creation_opened" ]; then
  step "the switch back on by SQL, as a fresh stack has it: /api/v1/auth/me's mayCreateOrganizations is false again"
  organization_creation_on || fail "turning the switch back on failed: $(cat "$work_dir/stack-psql-stderr")"
  organization_creation_opened=""
  [ "$(may_create_organizations)" = "false" ] ||
    fail "with the switch back on, /api/v1/auth/me's mayCreateOrganizations is $(may_create_organizations), not false"
fi

step "the platform registered the group organization in the opamp-server under its name"
stack_smoke group-registered "$group_id" "$ORGANIZATION_NAME" ||
  fail "the group organization $group_id is not registered in the opamp-server under its name (above)"

# Switches the session to organization $1 and checks that the new access
# cookie, alone, makes /me answer in it: only the access cookie is sent to
# /me, so the refresh cookie can't stand in for it.
switch_to() {
  local organization_id="$1" headers="$work_dir/switch-headers" access
  response=$(curl -s -w '\n%{http_code}' -D "$headers" -b "$JAR" -c "$JAR" -X PUT \
    "$GATEWAY_URL/api/v1/auth/sessions/current/organization" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg id "$organization_id" '{organizationId: $id}')")
  status=$(tail -n1 <<<"$response")
  [ "$status" = "200" ] || fail "switching to $organization_id returned HTTP $status: $(sed '$d' <<<"$response")"
  grep -qi '^set-cookie: telflo_access=[^;]' "$headers" || fail "the switch set no telflo_access cookie"
  if grep -qi '^set-cookie: telflo_refresh=' "$headers"; then fail "the switch set the refresh cookie too"; fi
  access=$(jar_cookie telflo_access)
  response=$(curl -s -w '\n%{http_code}' -H "Cookie: telflo_access=$access" "$GATEWAY_URL/api/v1/auth/me")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] || fail "GET /api/v1/auth/me with the new access cookie returned HTTP $status: $body"
  [ "$(jq -r '.organization.id' <<<"$body")" = "$organization_id" ] ||
    fail "after the switch, /me names another organization: $body"
}

if [ "$SMOKE_SITE" = "saas" ]; then
  step "switch to it: PUT /api/v1/auth/sessions/current/organization, and the new access cookie works on /me"
  switch_to "$group_id"
  [ "$(jq -r '.organization.name' <<<"$body")" = "$ORGANIZATION_NAME" ] ||
    fail "after the switch, /me names the wrong organization: $body"
else
  # A switch to the active organization changes nothing and sets no cookie; the switches below go to the personal
  # organization and back.
  step "the session is in it already: the sign-in landed there (/api/v1/auth/me above), so no switch"
fi

# Invitations act on the active organization, so the admin invites
# while the session is in the group organization.
INVITEE_EMAIL="stack-smoke-invitee-$(date +%s)-$$@example.com"
step "invite $INVITEE_EMAIL to it: POST /api/v1/organizations/:id/invitations"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$GATEWAY_URL/api/v1/organizations/$group_id/invitations" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg email "$INVITEE_EMAIL" '{email: $email, role: "contributor"}')")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "inviting returned HTTP $status: $body"
[ "$(jq -r '.invitation.email' <<<"$body")" = "$INVITEE_EMAIL" ] || fail "the invitation names another address: $body"

step "the API delivered the invitation email to Mailpit"
# The organization's name carries no quotes, so the subject can go into
# Mailpit's search as a quoted phrase.
invitation_query=$(jq -rn \
  --arg query "to:\"$INVITEE_EMAIL\" subject:\"You've been invited to join $ORGANIZATION_NAME on Telflo\"" '$query | @uri')
message_id=""
for _ in $(seq 1 30); do
  message_id=$(curl -s "$MAILPIT_URL/api/v1/search?query=$invitation_query" | jq -r '.messages[0].ID // empty')
  [ -n "$message_id" ] && break
  sleep 1
done
[ -n "$message_id" ] || fail "no invitation email to $INVITEE_EMAIL arrived in Mailpit within 30s"

text=$(curl -s "$MAILPIT_URL/api/v1/message/$message_id" | jq -r '.Text')
# The token is in the link's fragment, which a browser never sends to a
# server.
link=$(grep -oE 'https?://[^[:space:]]+/accept-invitation#token=[A-Za-z0-9_-]+' <<<"$text" | head -n1)
[ -n "$link" ] || fail "the invitation email contains no accept link with #token="
[[ "$link" == "$GATEWAY_URL/accept-invitation#token="* ]] ||
  fail "the accept link points at ${link%%#*}, not the gateway ($GATEWAY_URL)"
invitation_token="${link##*token=}"
remember_secret "$invitation_token"

step "the accept page loads through the gateway"
status=$(curl -s -o /dev/null -w '%{http_code}' "${link%%#*}")
[ "$status" = "200" ] || fail "GET ${link%%#*} returned HTTP $status"

step "preview the invitation with its token: POST /api/v1/invitation-previews"
response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/invitation-previews" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg token "$invitation_token" '{token: $token}')")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "invitation-previews returned HTTP $status: $body"
# mayRegister: a group organization's invitation may make an account in every registration mode but
# closed (the SaaS's open, oss's invite-only). organizationType: the page names a personal workspace by
# its type.
expected_preview=$(jq -Scn --arg name "$ORGANIZATION_NAME" --arg email "$INVITEE_EMAIL" \
  '{organizationName: $name, organizationType: "group", email: $email, role: "contributor", status: "pending", hasAccount: false, mayRegister: true}')
[ "$(jq -Sc '.invitation' <<<"$body")" = "$expected_preview" ] ||
  fail "the preview is $body, not {invitation: $expected_preview}"

# invitation_registration_body <token>: an invitation-registration's JSON, with $PASSWORD and the Terms'
# version when the site asks for Terms (saas); oss's open-source defaults ask for none, so none is sent.
invitation_registration_body() {
  jq -n --arg token "$1" --arg password "$PASSWORD" --arg terms "$TERMS_VERSION" \
    '{token: $token, password: $password} + (if $terms == "" then {} else {acceptedTermsVersion: $terms} end)'
}
step "create the invitee's account from it: POST /api/v1/invitation-registrations, signed in, in the organization"
INVITEE_JAR="$work_dir/invitee-cookies"
response=$(curl -s -w '\n%{http_code}' -c "$INVITEE_JAR" -X POST "$GATEWAY_URL/api/v1/invitation-registrations" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(invitation_registration_body "$invitation_token")")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "invitation-registrations returned HTTP $status: $body"
[ "$(jq -r '.organization.id' <<<"$body")" = "$group_id" ] || fail "the registration joined another organization: $body"
response=$(curl -s -w '\n%{http_code}' -b "$INVITEE_JAR" "$GATEWAY_URL/api/v1/auth/me")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "GET /api/v1/auth/me as the invitee returned HTTP $status: $body"
[ "$(jq -r '.user.email' <<<"$body")" = "$INVITEE_EMAIL" ] || fail "/me as the invitee returned the wrong user: $body"
[ "$(jq -r '.organization.id' <<<"$body")" = "$group_id" ] ||
  fail "the invitee's session is not in the inviting organization: $body"
[ "$(jq -r '.organization.role' <<<"$body")" = "contributor" ] ||
  fail "the invitee joined in another role: $body"

step "switch back to the personal organization"
switch_to "$personal_id"
[ "$(jq -r '.organization.type' <<<"$body")" = "personal" ] ||
  fail "after switching back, /me is not in the personal organization: $body"

# The opamp-server, before the configurations: the publish below registers the
# organization itself, so it would hide a broken registration hook. The
# personal organization must be registered by now, by the platform's hook
# alone.
step "the opamp-server's management API answers /health on its published port"
status=$(curl -s -o /dev/null -w '%{http_code}' "$OPAMP_MANAGEMENT_URL/health")
[ "$status" = "200" ] || fail "GET $OPAMP_MANAGEMENT_URL/health returned HTTP $status"

# A documented route (any ids will do: the secret is checked first).
step "the opamp-server refuses an /api/ call without the secret"
response=$(curl -s -w '\n%{http_code}' \
  "$OPAMP_MANAGEMENT_URL/api/v1/organizations/0a0a0a0a-0000-4000-8000-00000000000a/publications/1a1a1a1a-0000-4000-8000-00000000001a")
status=$(tail -n1 <<<"$response")
code=$(sed '$d' <<<"$response" | jq -r '.error.code // empty')
[ "$status" = "401" ] && [ "$code" = "unauthorized" ] ||
  fail "an /api/ call without the secret returned HTTP $status: $(sed '$d' <<<"$response")"

# Its argument is the personal organization of the account registered at
# the start, which the API registered in the opamp-server after that
# response.
step "the platform's client registers an organization and posts, reads, lists and deletes a publication in the opamp-server, and finds $EMAIL's personal organization registered"
stack_smoke "$personal_id" || fail "the platform's client against the opamp-server failed (above)"

# The collector validator. A valid and an invalid text are checked
# through the gateway below, once there is a configuration.
step "the collector validator answers /health on its published port"
status=$(curl -s -o /dev/null -w '%{http_code}' "$OTELCOL_VALIDATOR_URL/health")
[ "$status" = "200" ] || fail "GET $OTELCOL_VALIDATOR_URL/health returned HTTP $status"

# Any distribution and version will do: the secret is checked first.
step "the collector validator refuses a validate call without the secret"
response=$(curl -s -w '\n%{http_code}' -H 'Content-Type: application/json' \
  --data '{"yaml": "receivers: {}\n"}' \
  "$OTELCOL_VALIDATOR_URL/validator/v1/validate/otelcol-contrib/0.162.0")
status=$(tail -n1 <<<"$response")
code=$(sed '$d' <<<"$response" | jq -r '.error.code // empty')
[ "$status" = "401" ] && [ "$code" = "unauthorized" ] ||
  fail "a validate call without the secret returned HTTP $status: $(sed '$d' <<<"$response")"

# The collector tester. It answers 503 until kwok's fake cluster is up,
# a few seconds after it starts (compose's --wait doesn't wait for it: the API
# depends on it started, not healthy), so its health is asked for up to 120
# times, each ask cut off after 5 s (a connection the forwarder accepts but
# never answers would otherwise hang the loop). A curl that
# fails (refused, reset, cut off: exit 7, 28, 52, 56) writes 000 and must not
# end the script under `set -e`, so the loop asks again. A real
# run is queued through the gateway below, once there is a configuration.
#
# Each curl in the tester's sections ends `|| true`: one that fails reports
# through `fail`, with the status it got, rather than ending the script
# silently.
step "the collector tester answers /testing/v1/health through its forwarder's published port"
status=""
for _ in $(seq 1 120); do
  status=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$OTELCOL_TESTING_URL/testing/v1/health" || true)
  [ "$status" = "200" ] && break
  sleep 1
done
[ "$status" = "200" ] || fail "GET $OTELCOL_TESTING_URL/testing/v1/health returned HTTP $status for 120s"

# The secret is checked before the body is read, so an empty one will do.
step "the collector tester refuses a run without the secret"
response=$(curl -s -w '\n%{http_code}' -H 'Content-Type: application/json' --data '{}' \
  "$OTELCOL_TESTING_URL/testing/v1/runs" || true)
status=$(tail -n1 <<<"$response")
code=$(sed '$d' <<<"$response" | jq -r '.error.code // empty')
[ "$status" = "401" ] && [ "$code" = "unauthorized" ] ||
  fail "a run without the secret returned HTTP $status: $(sed '$d' <<<"$response")"

# Reads the field $1 (a jq filter) of the JSON text $2, or "" when $2 isn't
# JSON: a reply that isn't (a forwarder's HTML 502, a body cut off) then
# reaches `fail` with what was read, rather than ending the script inside a
# command substitution with no FAIL: line. Used by the OTTL
# evaluator's and the validation rules' steps.
json_field() { jq -r "$1" <<<"$2" 2>/dev/null || true; }
json_compact() { jq -c "$1" <<<"$2" 2>/dev/null || true; }

# The OTTL evaluator. It sits on an internal network of its own and is
# reached here through its forwarder's published port, as the tester is.
# Its health is asked for up to 60 times, each ask cut off after 5 s; a curl
# that fails writes 000 and the loop asks again. Health needs no secret;
# every other path is refused before routing without the right one, an
# unknown path included. Each curl ends `|| true`, as
# the tester's do.
step "the OTTL evaluator answers /health through its forwarder's published port"
status=""
body=""
for _ in $(seq 1 60); do
  response=$(curl -s --max-time 5 -w '\n%{http_code}' "$OTTL_EVALUATOR_URL/health" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] && break
  sleep 1
done
[ "$status" = "200" ] || fail "GET $OTTL_EVALUATOR_URL/health returned HTTP $status for 60s: $(head -c 500 <<<"$body")"
[ "$(json_field '.status // empty' "$body")" = "ok" ] && [ -n "$(json_field '.ottlVersion // empty' "$body")" ] ||
  fail "the OTTL evaluator's health answered $(head -c 500 <<<"$body")"

# Asks the evaluator for $1 $2 with the extra curl arguments after them, and
# expects its 401 `unauthorized` envelope; $3 says which refusal it is.
expect_evaluator_refusal() {
  local method="$1" path="$2" what="$3"
  shift 3
  response=$(curl -s --max-time 10 -w '\n%{http_code}' -X "$method" "$@" "$OTTL_EVALUATOR_URL$path" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "401" ] && [ "$(json_field '.error.code // empty' "$body")" = "unauthorized" ] ||
    fail "$what returned HTTP $status: $(head -c 500 <<<"$body")"
}

# The secret is checked before the body is read, so an empty one will do.
step "the OTTL evaluator refuses an evaluate call without the secret"
expect_evaluator_refusal POST /ottl/v1/evaluate "an evaluate call without the secret" \
  -H 'Content-Type: application/json' --data '{}'

step "the OTTL evaluator refuses an evaluate call with a wrong secret"
expect_evaluator_refusal POST /ottl/v1/evaluate "an evaluate call with a wrong secret" \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer not-the-evaluator-secret-but-long-enough-0123456789' \
  --data '{}'

step "the OTTL evaluator refuses an unknown path without the secret, before routing"
expect_evaluator_refusal GET /ottl/v1/functions "GET /ottl/v1/functions without the secret"

# Configurations act on the active organization, now the personal one.
CONFIGURATIONS_URL="$GATEWAY_URL/api/v1/organizations/$personal_id/configurations"
CONFIGURATION_NAME="Stack smoke $(date +%s)-$$"

# Lists the configurations (the first page is all of them: the account is
# new) into $body, and their ids, one per line, into $listed_ids. Called
# directly, not in $(...), so a failure here ends the script.
list_configurations() {
  response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$CONFIGURATIONS_URL")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] || fail "listing configurations returned HTTP $status: $body"
  listed_ids=$(jq -r '.items[].id' <<<"$body")
}

step "create a configuration: POST /api/v1/organizations/:id/configurations"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$CONFIGURATIONS_URL" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg name "$CONFIGURATION_NAME" '{name: $name, description: "Made by the stack smoke test"}')")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "creating a configuration returned HTTP $status: $body"
configuration_id=$(jq -r '.configuration.id' <<<"$body")
[ -n "$configuration_id" ] && [ "$configuration_id" != "null" ] || fail "the created configuration has no id: $body"
# Its collector distribution, which the published snapshot must name.
configuration_distribution=$(jq -r '.configuration.collectorDistribution' <<<"$body")
[[ "$configuration_distribution" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] ||
  fail "the created configuration has no collector distribution: $body"
[ "$(jq -r '.configuration.name' <<<"$body")" = "$CONFIGURATION_NAME" ] ||
  fail "the created configuration has another name: $body"
[ "$(jq -r '.configuration.createdBy.email' <<<"$body")" = "$EMAIL" ] ||
  fail "the created configuration names another creator: $body"

step "list it, beside the new account's Initial Configuration: GET /api/v1/organizations/:id/configurations"
list_configurations
grep -qx "$configuration_id" <<<"$listed_ids" ||
  fail "the list does not include the created configuration $configuration_id: $body"
jq -e 'any(.items[]; .name == "Initial Configuration")' <<<"$body" >/dev/null ||
  fail "the new account's list does not include its Initial Configuration: $body"

# Reads the configuration and its version into $body, and the version's
# id into $version_id. Called directly, not in $(...), so a failure here ends
# the script.
get_configuration() {
  response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$CONFIGURATIONS_URL/$configuration_id")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] || fail "reading the configuration returned HTTP $status: $body"
  [ "$(jq -r '.configuration.id' <<<"$body")" = "$configuration_id" ] || fail "the read names another configuration: $body"
  [ "$(jq -r '.version.versionNumber' <<<"$body")" = "1" ] || fail "the read's version is not version 1: $body"
  version_id=$(jq -r '.version.id' <<<"$body")
  [ -n "$version_id" ] && [ "$version_id" != "null" ] || fail "the read's version has no id: $body"
}

# Saves the JSON body in file $1 over the version: PATCH
# /api/v1/organizations/:id/configurations/:configurationId/versions/:versionId.
# The response goes into $body. A file, not an argument: the large body is
# over 1 MiB.
save_version() {
  response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X PATCH "$CONFIGURATIONS_URL/$configuration_id/versions/$version_id" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$1")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] || fail "saving the version returned HTTP $status: $(head -c 500 <<<"$body")"
}

step "read it: GET /api/v1/organizations/:id/configurations/:configurationId, version 1 with empty YAML"
get_configuration
[ "$(jq -c '.version.yamlContent' <<<"$body")" = '""' ] || fail "the new configuration's YAML is not empty: $body"

[ "$(jq -c '[.version.nodes, .version.edges, .version.pipelines]' <<<"$body")" = '[[],[],[]]' ] ||
  fail "the new configuration's graph is not empty: $body"

# The builder's graph as a save stores it: a pipeline's
# group, two components in it and the edge between them. jsonb keeps no key
# order, so the graph read back is compared with its keys sorted (jq -S).
graph_of() { jq -S '{nodes, edges, pipelines}' "$@"; }
step "save YAML and a graph over its version: PATCH .../configurations/:configurationId/versions/:versionId"
SMOKE_YAML=$'# Saved by the stack smoke test\nreceivers:\n  otlp:\n    protocols:\n      grpc: {}\n'
jq -n --arg yaml "$SMOKE_YAML" '{
  yamlContent: $yaml,
  nodes: [
    {id: "group_0", type: "pipelineGroup", position: {x: 50, y: 30}, style: {width: 980, height: 240},
     data: {label: "traces", pipelineId: "pipeline_0", signalType: "traces", color: "#f97316"}},
    {id: "node_0", type: "receiver", parentId: "group_0", position: {x: 50.5, y: 70},
     data: {label: "OTLP", componentType: "receiver", componentSubType: "otlp",
            config: {protocols: {grpc: {}}}, sharedConfigId: "receiver-otlp"}},
    {id: "node_1", type: "exporter", parentId: "group_0", position: {x: 300, y: 70},
     data: {label: "Debug", componentType: "exporter", componentSubType: "debug", config: null}}
  ],
  edges: [{id: "edge_0", source: "node_0", target: "node_1", type: "smoothstep"}],
  pipelines: [{id: "pipeline_0", name: "traces", signalType: "traces", color: "#f97316"}]
}' >"$work_dir/save-body.json"
save_version "$work_dir/save-body.json"
[ "$(jq -r '.version.id' <<<"$body")" = "$version_id" ] || fail "the save answered another version: $body"
[ "$(jq -c '.version.yamlContent' <<<"$body")" = "$(jq -c '.yamlContent' "$work_dir/save-body.json")" ] ||
  fail "the saved version holds other YAML: $body"
[ "$(jq '.version' <<<"$body" | graph_of)" = "$(graph_of "$work_dir/save-body.json")" ] ||
  fail "the saved version holds another graph: $body"

step "read it again: the version holds the saved YAML and graph"
get_configuration
[ "$(jq -c '.version.yamlContent' <<<"$body")" = "$(jq -c '.yamlContent' "$work_dir/save-body.json")" ] ||
  fail "the read does not return the saved YAML: $body"
[ "$(jq '.version' <<<"$body" | graph_of)" = "$(graph_of "$work_dir/save-body.json")" ] ||
  fail "the read does not return the saved graph: $body"

# The platform's validation: the version's text checked
# by the real collector of its pin, through the gateway. The body's YAML is
# what is checked, not what the version holds. The answer's collectorVersion
# is the version's pin, read above.
VALIDATION_URL="$CONFIGURATIONS_URL/$configuration_id/versions/$version_id/validation"
version_collector=$(jq -r '.version.collectorVersion' <<<"$body")
[[ "$version_collector" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version 1 has no collector version: $(jq -c '.version | {collectorVersion}' <<<"$body")"
VALID_YAML=$'receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n'
INVALID_YAML=$'receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\nexporters:\n  debug: {}\n  nosuchexporter: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug, nosuchexporter]\n'

# Checks the YAML in $1 for version 1: POST .../versions/:versionId/validation.
# The response goes into $body. Called directly, not in $(...), so a failure
# here ends the script.
validate_yaml() {
  response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$VALIDATION_URL" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg yaml "$1" '{yaml: $yaml}')")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] || fail "checking the YAML returned HTTP $status: $body"
}

step "check a valid text through the gateway: POST .../versions/:versionId/validation answers valid for $version_collector"
validate_yaml "$VALID_YAML"
[ "$(jq -c '{status, collectorVersion, errors}' <<<"$body")" = "$(jq -cn --arg version "$version_collector" \
  '{status: "valid", collectorVersion: $version, errors: []}')" ] ||
  fail "the valid text wasn't answered valid for $version_collector: $body"

step "check a text naming an unknown component: invalid, with the component's path"
validate_yaml "$INVALID_YAML"
[ "$(jq -r '.status' <<<"$body")" = "invalid" ] && [ "$(jq -r '.collectorVersion' <<<"$body")" = "$version_collector" ] ||
  fail "the text with an unknown component wasn't answered invalid for $version_collector: $body"
[ "$(jq -c '[.errors[].componentPath]' <<<"$body")" = '["exporters::nosuchexporter"]' ] ||
  fail "the invalid text's errors don't name exporters::nosuchexporter: $body"

# A real test run: the account's own test file, uploaded through the
# gateway as the browser does (multipart, its parts in the API's order), a
# run of version 1 queued with a text piping an OTLP receiver to the debug
# exporter on the version's pin, the dispatcher's send to the tester over the
# tester's internal network, the collector's run in the sandbox, and the
# output it captured, read back through the gateway. The record's body is
# unique to this run.
TEST_FILES_URL="$GATEWAY_URL/api/v1/organizations/$personal_id/test-files"
TEST_RUNS_URL="$CONFIGURATIONS_URL/$configuration_id/versions/$version_id/test-runs"
TEST_RECORD_BODY="stack smoke record $(date +%s)-$$"
jq -n --arg body "$TEST_RECORD_BODY" '{resourceLogs: [{
  resource: {attributes: [{key: "service.name", value: {stringValue: "stack-smoke"}}]},
  scopeLogs: [{scope: {}, logRecords: [{timeUnixNano: "1700000000000000000", severityText: "INFO",
    body: {stringValue: $body}}]}]
}]}' >"$work_dir/stack-smoke-logs.json"
TEST_RUN_YAML=$'receivers:\n  otlp:\n    protocols:\n      http: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n'

step "upload a small OTLP logs document: POST /api/v1/organizations/:id/test-files"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$TEST_FILES_URL" -H 'X-Telflo-CSRF: 1' \
  -F 'displayName=Stack smoke logs' -F 'description=' \
  -F "file=@$work_dir/stack-smoke-logs.json;type=application/json;filename=stack-smoke-logs.json" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "uploading the test file returned HTTP $status: $body"
test_file_id=$(jq -r '.file.id' <<<"$body")
[ -n "$test_file_id" ] && [ "$test_file_id" != "null" ] || fail "the uploaded test file has no id: $body"
[ "$(jq -r '.file.sizeBytes' <<<"$body")" = "$(wc -c <"$work_dir/stack-smoke-logs.json" | tr -d ' ')" ] ||
  fail "the uploaded test file has another size: $body"

# On s3: the upload is an object at its key (the account's own test inputs),
# its size the file's, and not a file on the API's volume. Compose 2.6.0's
# exec answers 1 also when the service is stopped or unknown, so the look
# carries its own control and codes: 3 when the volume's directory isn't
# there, 0 when the file is, 4 when it isn't; anything else is exec's own
# failure.
if [ "$file_store_kind" = "s3" ]; then
  test_file_key="organizations/$personal_id/users/$user_id/test-inputs/$test_file_id"
  step "S3: the object store holds the uploaded file at its key with its size, and the API's volume doesn't: the filer's metadata in object-store, test -e in api"
  object_metadata=$(object_store_json "$test_file_key?metadata=true") ||
    fail "couldn't read, or the object store holds no object at, the uploaded test file's key"
  [ "$(jq -r '.FileSize' <<<"$object_metadata" 2>/dev/null)" = "$(wc -c <"$work_dir/stack-smoke-logs.json" | tr -d ' ')" ] ||
    fail "the object store's object at the uploaded test file's key has another size: $(jq -c '{FileSize}' <<<"$object_metadata" 2>/dev/null)"
  volume_status=0
  docker compose exec -T api sh -c 'test -d /var/lib/telflo/file-store || exit 3; test -e "$1" && exit 0; exit 4' \
    sh "/var/lib/telflo/file-store/$test_file_key" || volume_status=$?
  [ "$volume_status" != "0" ] || fail "the API's volume holds the uploaded test file too: the API didn't write it to the object store"
  [ "$volume_status" = "4" ] || fail "couldn't look for the uploaded test file on the API's volume (docker compose exec answered $volume_status)"
fi

step "queue a run of an OTLP receiver piped to the debug exporter on $version_collector: POST .../versions/:versionId/test-runs"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$TEST_RUNS_URL" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg file "$test_file_id" --arg yaml "$TEST_RUN_YAML" --arg version "$version_collector" \
    '{inputFileId: $file, pipeline: "logs", signal: "logs", durationSeconds: 2, yaml: $yaml, collectorVersion: $version}')" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "queuing the test run returned HTTP $status: $body"
test_run_id=$(jq -r '.run.id' <<<"$body")
[ -n "$test_run_id" ] && [ "$test_run_id" != "null" ] || fail "the queued run has no id: $body"
[ "$(jq -r '.run.status' <<<"$body")" = "queued" ] || fail "the queued run isn't queued: $(jq -c '.run | {status}' <<<"$body")"

# The run's budget is about 64 s plus its duration at most; it is polled for
# up to 180 s, the tester's collector start and kwok's informer included.
step "the dispatcher runs it in the tester: GET .../test-runs/:runId until it succeeds"
run_status=""
for _ in $(seq 1 180); do
  response=$(curl -s --max-time 10 -w '\n%{http_code}' -b "$JAR" "$TEST_RUNS_URL/$test_run_id" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] || fail "reading the test run returned HTTP $status: $body"
  run_status=$(jq -r '.run.status' <<<"$body")
  [ "$run_status" = "succeeded" ] || [ "$run_status" = "failed" ] && break
  sleep 1
done
[ "$run_status" = "succeeded" ] ||
  fail "the test run ended $run_status, not succeeded: $(jq -c '.run | {status, errorCode, errorMessage, strategy, collectorVersion}' <<<"$body")"
[ "$(jq -r '.run.collectorVersion' <<<"$body")" = "$version_collector" ] && [ "$(jq -r '.run.strategy' <<<"$body")" = "otlp" ] ||
  fail "the test run didn't run OTLP on $version_collector: $(jq -c '.run | {strategy, collectorVersion}' <<<"$body")"
[ "$(jq -r '.run.outputSizeBytes | type' <<<"$body")" = "number" ] ||
  fail "the test run stored no output: $(jq -c '.run | {outputSizeBytes, outputTruncated}' <<<"$body")"

step "the run's output holds the record: GET .../test-runs/:runId/files/output"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$TEST_RUNS_URL/$test_run_id/files/output" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "reading the run's output returned HTTP $status: $(head -c 500 <<<"$body")"
grep -qF "$TEST_RECORD_BODY" <<<"$body" ||
  fail "the run's output doesn't hold the record ($TEST_RECORD_BODY): $(head -c 500 <<<"$body")"

# On s3: the run's output, which the dispatcher wrote, is an object too.
if [ "$file_store_kind" = "s3" ]; then
  step "S3: the object store holds the run's output at its key: the filer's metadata in object-store"
  object_store_json "organizations/$personal_id/test-runs/$test_run_id/output?metadata=true" >/dev/null ||
    fail "couldn't read, or the object store holds no object at, the run's output's key"
fi

# A suite's run: a suite on version 1, through the gateway, and a test
# configuration in it whose input the API copies from the test file uploaded
# above, then Played as the Suites subtab's Run test does:
# {definitionId, yaml, collectorVersion}, the API taking the input, pipeline,
# signal and duration from the configuration. The dispatcher sends it to the
# tester as any run, and it succeeds carrying its breadcrumb: the suite's and
# the configuration's ids and names.
TEST_SUITES_URL="$CONFIGURATIONS_URL/$configuration_id/versions/$version_id/test-suites"
SUITE_NAME="Stack smoke suite $(date +%s)-$$"
# Not the test file's display name ("Stack smoke logs") nor its file name, so
# the breadcrumb check below can tell the configuration's name from theirs.
DEFINITION_NAME="Stack smoke test configuration"

step "create a test suite on version 1: POST .../versions/:versionId/test-suites"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$TEST_SUITES_URL" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg name "$SUITE_NAME" '{name: $name, description: "Made by the stack smoke test."}')" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "creating the test suite returned HTTP $status: $body"
suite_id=$(jq -r '.suite.id' <<<"$body")
[ -n "$suite_id" ] && [ "$suite_id" != "null" ] || fail "the created test suite has no id: $body"

step "create a test configuration in it from the uploaded file: POST .../test-suites/:suiteId/definitions"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$TEST_SUITES_URL/$suite_id/definitions" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg file "$test_file_id" --arg name "$DEFINITION_NAME" \
    '{inputFileId: $file, name: $name, pipeline: "logs", signal: "logs", durationSeconds: 2}')" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "creating the test configuration returned HTTP $status: $body"
definition_id=$(jq -r '.definition.id' <<<"$body")
[ -n "$definition_id" ] && [ "$definition_id" != "null" ] || fail "the created test configuration has no id: $body"
[ "$(jq -r '.definition.inputName' <<<"$body")" = "stack-smoke-logs.json" ] ||
  fail "the test configuration's input isn't the uploaded file's copy: $(jq -c '.definition | {inputName}' <<<"$body")"

# On s3: the store's copy of the file (a read, then a write) is an object of
# the file's size under the organization's definition inputs, which the reply
# doesn't name by id. The listing's entries hold a small file's bytes
# (Content): only sizes are read from it.
if [ "$file_store_kind" = "s3" ]; then
  step "S3: the object store holds the test configuration's input under test-definition-inputs/, the file's size: the filer's listing in object-store"
  definition_inputs=$(object_store_json "organizations/$personal_id/test-definition-inputs/") ||
    fail "couldn't read, or the object store holds nothing under, the organization's test-definition-inputs/"
  jq -e --argjson size "$(wc -c <"$work_dir/stack-smoke-logs.json" | tr -d ' ')" \
    'any(.Entries[]?; .FileSize == $size)' <<<"$definition_inputs" >/dev/null 2>&1 ||
    fail "the object store lists no object of the uploaded file's size under the organization's test-definition-inputs/: $(jq -c '[.Entries[]?.FileSize]' <<<"$definition_inputs" 2>/dev/null)"
fi

step "Play it: POST .../versions/:versionId/test-runs with {definitionId, yaml, collectorVersion}"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$TEST_RUNS_URL" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg definition "$definition_id" --arg yaml "$TEST_RUN_YAML" --arg version "$version_collector" \
    '{definitionId: $definition, yaml: $yaml, collectorVersion: $version}')" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "queuing the test configuration's run returned HTTP $status: $body"
suite_run_id=$(jq -r '.run.id' <<<"$body")
[ -n "$suite_run_id" ] && [ "$suite_run_id" != "null" ] || fail "the queued suite run has no id: $body"
[ "$(jq -c '.run | {status, collectorVersion}' <<<"$body")" = "$(jq -cn --arg version "$version_collector" \
  '{status: "queued", collectorVersion: $version}')" ] ||
  fail "the suite run wasn't queued on $version_collector: $(jq -c '.run | {status, collectorVersion}' <<<"$body")"

step "the dispatcher runs it in the tester: GET .../test-runs/:runId until it succeeds"
run_status=""
for _ in $(seq 1 180); do
  response=$(curl -s --max-time 10 -w '\n%{http_code}' -b "$JAR" "$TEST_RUNS_URL/$suite_run_id" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] || fail "reading the suite run returned HTTP $status: $body"
  run_status=$(jq -r '.run.status' <<<"$body")
  [ "$run_status" = "succeeded" ] || [ "$run_status" = "failed" ] && break
  sleep 1
done
[ "$run_status" = "succeeded" ] ||
  fail "the suite run ended $run_status, not succeeded: $(jq -c '.run | {status, errorCode, errorMessage, strategy, collectorVersion}' <<<"$body")"

step "the run carries its breadcrumb and the configuration's input, pipeline and duration"
expected=$(jq -cn --arg suite "$suite_id" --arg suiteName "$SUITE_NAME" --arg definition "$definition_id" \
  --arg definitionName "$DEFINITION_NAME" \
  '{suiteId: $suite, suiteName: $suiteName, definitionId: $definition, definitionName: $definitionName,
    inputName: "stack-smoke-logs.json", pipeline: "logs", signal: "logs", durationSeconds: 2}')
actual=$(jq -c '.run | {suiteId, suiteName, definitionId, definitionName, inputName, pipeline, signal, durationSeconds}' <<<"$body")
[ "$actual" = "$expected" ] || fail "the suite run's breadcrumb or input isn't the configuration's: $actual, not $expected"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$TEST_RUNS_URL/$suite_run_id/files/output" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "reading the suite run's output returned HTTP $status: $(head -c 500 <<<"$body")"
grep -qF "$TEST_RECORD_BODY" <<<"$body" ||
  fail "the suite run's output doesn't hold the record ($TEST_RECORD_BODY): $(head -c 500 <<<"$body")"

# Validation rules: a validation pipeline on version 1 for its `logs`
# pipeline, through the gateway, with rules the API has the real evaluator
# check at Save, then two runs of the uploaded file, which the dispatcher
# has the evaluator check after the tester answers: one whose rules pass
# (succeeded) and, once a rule the record breaks is saved, one that ends
# validation_failed. Every reply is read with json_field, so one that isn't
# JSON ends in a FAIL: line.
VALIDATION_PIPELINES_URL="$CONFIGURATIONS_URL/$configuration_id/versions/$version_id/validation-pipelines"
SSN_PATTERN='\b\d{3}-\d{2}-\d{4}\b'

# POSTs the rule in $1 (JSON) to the validation pipeline's rules: the answer
# into $status and $body.
post_rule() {
  response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" -X POST "$VALIDATION_PIPELINES_URL/$validation_pipeline_id/rules" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' -d "$1" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
}

# Saves the rule in $1 (JSON), named $2, and expects 201: its id into
# $saved_rule_id.
save_rule() {
  post_rule "$1"
  [ "$status" = "201" ] || fail "saving the rule \"$2\" returned HTTP $status: $(head -c 500 <<<"$body")"
  saved_rule_id=$(json_field '.rule.id // empty' "$body")
  [ -n "$saved_rule_id" ] && [ "$(json_field '.rule.name' "$body")" = "$2" ] ||
    fail "the saved rule \"$2\" has no id or another name: $(head -c 500 <<<"$body")"
}

# Expects the rule in $1 (JSON) refused 400 validation_rule_invalid, its
# message starting with $2 (the API's prefix to the evaluator's own words)
# and naming the field $3; $4 says which rule it is.
expect_rule_refused() {
  post_rule "$1"
  local code message field
  code=$(json_field '.error.code // empty' "$body")
  message=$(json_field '.error.message // empty' "$body")
  field=$(json_field '.error.details.problems[0].field // empty' "$body")
  [ "$status" = "400" ] && [ "$code" = "validation_rule_invalid" ] ||
    fail "$4 returned HTTP $status: $(head -c 500 <<<"$body")"
  [[ "$message" == "$2"?* ]] || fail "$4 was refused without the evaluator's words: $(head -c 500 <<<"$body")"
  [ "$field" = "$3" ] || fail "$4 was refused naming the field \"$field\", not $3: $(head -c 500 <<<"$body")"
}

# Queues a run of version 1's `logs` pipeline on the uploaded test file (or
# on the test file whose id is $2), as the run dialog does; $1 says which
# run. Its id into $queued_run_id.
queue_file_run() {
  response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" -X POST "$TEST_RUNS_URL" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg file "${2:-$test_file_id}" --arg yaml "$TEST_RUN_YAML" --arg version "$version_collector" \
      '{inputFileId: $file, pipeline: "logs", signal: "logs", durationSeconds: 2, yaml: $yaml, collectorVersion: $version}')" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "201" ] || fail "queuing $1 returned HTTP $status: $(head -c 500 <<<"$body")"
  queued_run_id=$(json_field '.run.id // empty' "$body")
  [ -n "$queued_run_id" ] || fail "$1 has no id: $(head -c 500 <<<"$body")"
}

# Reads run $1 until it ends (succeeded, failed or validation_failed): up to
# 180 reads a second apart, each cut off after 10 s. A read cut off or
# refused (000) is asked again; any other answer but 200 fails, and so does
# a run still going after the last read. The last read into $body, its
# status into $run_status.
poll_run() {
  run_status=""
  for _ in $(seq 1 180); do
    response=$(curl -s --max-time 10 -w '\n%{http_code}' -b "$JAR" "$TEST_RUNS_URL/$1" || true)
    status=$(tail -n1 <<<"$response")
    body=$(sed '$d' <<<"$response")
    if [ "$status" = "200" ]; then
      run_status=$(json_field '.run.status // empty' "$body")
      case "$run_status" in succeeded | failed | validation_failed) return 0 ;; esac
    elif [ "$status" != "000" ]; then
      fail "reading the run $1 returned HTTP $status: $(head -c 500 <<<"$body")"
    fi
    sleep 1
  done
  fail "the run $1 hadn't ended after 180 reads: ${run_status:-no status read}"
}

step "create a validation pipeline for version 1's logs pipeline: POST .../versions/:versionId/validation-pipelines"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" -X POST "$VALIDATION_PIPELINES_URL" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' -d '{"pipeline": "logs"}' || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "creating the validation pipeline returned HTTP $status: $(head -c 500 <<<"$body")"
validation_pipeline_id=$(json_field '.validationPipeline.id // empty' "$body")
[ -n "$validation_pipeline_id" ] && [ "$(json_compact '.validationPipeline | {pipeline, signal}' "$body")" = '{"pipeline":"logs","signal":"logs"}' ] ||
  fail "the validation pipeline has no id, or isn't logs's: $(head -c 500 <<<"$body")"

step "save an OTTL rule, checked by the real evaluator: POST .../validation-pipelines/:id/rules"
RECORD_RULE_NAME="The record came through"
save_rule "$(jq -n --arg body "$TEST_RECORD_BODY" --arg name "$RECORD_RULE_NAME" \
  '{kind: "ottl", target: "output", ottl: {context: "log", quantifier: "any", condition: "body == \"\($body)\""}, name: $name}')" \
  "$RECORD_RULE_NAME"
record_rule_id=$saved_rule_id

step "save a regex rule, compiled by the real evaluator's RE2"
SSN_RULE_NAME="SSN guard"
save_rule "$(jq -n --arg pattern "$SSN_PATTERN" --arg name "$SSN_RULE_NAME" \
  '{kind: "not_contains_regex", target: "output", pattern: $pattern, name: $name}')" "$SSN_RULE_NAME"
ssn_rule_id=$saved_rule_id

step "a broken OTTL condition is refused in the evaluator's words: 400 validation_rule_invalid"
expect_rule_refused "$(jq -n '{kind: "ottl", target: "output", ottl: {context: "log", quantifier: "all", condition: "attributes[\"env\"] == \"prod"}}')" \
  "OTTL syntax error: " ottl.condition "the broken OTTL condition"

step "a regex RE2 can't compile (a lookbehind) is refused in the evaluator's words"
expect_rule_refused "$(jq -n '{kind: "contains_regex", target: "output", pattern: "(?<=secret)[0-9]+"}')" \
  "Invalid regex: " pattern "the lookbehind regex"

step "the validation pipeline holds the two rules saved, in order: GET .../validation-pipelines/:id/rules"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" "$VALIDATION_PIPELINES_URL/$validation_pipeline_id/rules" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "listing the rules returned HTTP $status: $(head -c 500 <<<"$body")"
[ "$(json_compact '[.rules[] | .id]' "$body")" = "$(jq -cn --arg a "$record_rule_id" --arg b "$ssn_rule_id" '[$a, $b]')" ] ||
  fail "the validation pipeline holds other rules: $(json_compact '[.rules[] | {id, kind, position}]' "$body")"

step "a run whose rules pass: queued on the uploaded file, it succeeds with a passed result per rule"
queue_file_run "the run whose rules pass"
passing_run_id=$queued_run_id
poll_run "$passing_run_id"
[ "$run_status" = "succeeded" ] ||
  fail "the run whose rules pass ended $run_status: $(json_compact '.run | {status, errorCode, errorMessage, validationResults}' "$body")"
[ "$(json_compact '[.run.validationRules[] | .id]' "$body")" = "$(jq -cn --arg a "$record_rule_id" --arg b "$ssn_rule_id" '[$a, $b]')" ] ||
  fail "the run didn't copy the two rules in order: $(json_compact '[.run.validationRules[] | {id, position}]' "$body")"
[ "$(json_compact '[.run.validationResults[] | .passed]' "$body")" = "[true,true]" ] ||
  fail "the run's results aren't two passes: $(json_compact '.run.validationResults' "$body")"

# A Record attribute rule: every record tagged env: prod.
# The uploaded record has no env attribute, so it breaks it.
step "save a rule the record breaks: all log records have env == \"prod\""
PROD_RULE_NAME="Production only"
save_rule "$(jq -n --arg name "$PROD_RULE_NAME" \
  '{kind: "ottl", target: "output", ottl: {context: "log", quantifier: "all", condition: "attributes[\"env\"] == \"prod\""}, name: $name}')" \
  "$PROD_RULE_NAME"
prod_rule_id=$saved_rule_id

step "a run whose rule fails: it ends validation_failed, the failed result carrying its detail"
queue_file_run "the run whose rule fails"
failing_run_id=$queued_run_id
poll_run "$failing_run_id"
[ "$run_status" = "validation_failed" ] ||
  fail "the run whose rule fails ended $run_status: $(json_compact '.run | {status, errorCode, errorMessage, validationResults}' "$body")"
[ "$(json_compact '[.run.validationResults[] | [.id, .passed]]' "$body")" = "$(jq -cn \
  --arg a "$record_rule_id" --arg b "$ssn_rule_id" --arg c "$prod_rule_id" '[[$a, true], [$b, true], [$c, false]]')" ] ||
  fail "the run's results aren't pass, pass, fail: $(json_compact '[.run.validationResults[] | {id, passed, error}]' "$body")"
[ "$(json_compact '.run.validationResults[2].detail | {kind, totalCount, matchedCount}' "$body")" = \
  '{"kind":"record_mismatch","totalCount":1,"matchedCount":0}' ] ||
  fail "the failed result's detail isn't the record's mismatch: $(json_compact '.run.validationResults[2]' "$body")"
[ "$(json_field '.run.errorCode' "$body")" = "null" ] && [ "$(json_field '.run.outputSizeBytes | type' "$body")" = "number" ] ||
  fail "the validation_failed run has an error or no output: $(json_compact '.run | {errorCode, outputSizeBytes}' "$body")"

# The regex library and Compare's rules. Through the gateway, as the smoke's
# account, a member: the library is read (at least 35 entries, the seed's
# count; the SSN's regex byte for byte), one of its entries is saved as a rule
# the way the picker saves it, and a rule is saved the way Compare's "Create
# an OTTL rule" writes one, for an attribute key built to break out of its
# string literal unless escaped; the real evaluator checks both at Save, and
# with "Production only" deleted a run of a second file succeeds with every
# rule passing, in order. Then, on a throwaway stack only, the account is made
# a product admin by SQL on the stack's database, creates, renames and deletes
# an entry, a lookahead is refused by the real evaluator's RE2, and the flag
# is cleared again.
TEST_REGEXES_URL="$GATEWAY_URL/api/v1/test-regexes"
SEEDED_SSN_REGEX='\d{3}-\d{2}-\d{4}'

# delete_created_regex <id>: the EXIT trap's clean-up of the library entry
# this run created, by its id, by SQL (stack_psql): a global row every
# account of the stack would otherwise list. Deletes nothing if it's gone.
delete_created_regex() {
  stack_psql -v id="$1" <<'SQL'
delete from test_regex where id = :'id'::uuid;
SQL
}

# delete_created_library_file <id>: the EXIT trap's clean-up of the library
# file the library steps added (below), by its id, by SQL (stack_psql), as
# delete_created_regex's: a global row every account of the stack would
# otherwise list. Deletes nothing if it's gone. Its bytes stay in the
# throwaway stack's file store, unreachable with no row.
delete_created_library_file() {
  stack_psql -v id="$1" <<'SQL'
delete from library_files where id = :'id'::uuid;
SQL
}

# Reads /api/v1/auth/me and expects its isProductAdmin to be $1.
expect_product_admin() {
  response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" "$GATEWAY_URL/api/v1/auth/me" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] && [ "$(json_field '.isProductAdmin' "$body")" = "$1" ] ||
    fail "GET /api/v1/auth/me returned HTTP $status, isProductAdmin $(json_field '.isProductAdmin' "$body"), not $1"
}

# Sends $1 to the library ($2 a path under it, "" for the collection) with
# the JSON body $3 ("" for none): the answer into $status and $body.
test_regex_request() {
  local method=$1 path=$2 data=$3
  local args=(-s --max-time 30 -w '\n%{http_code}' -b "$JAR" -X "$method" -H 'X-Telflo-CSRF: 1')
  if [ -n "$data" ]; then args+=(-H 'content-type: application/json' -d "$data"); fi
  response=$(curl "${args[@]}" "$TEST_REGEXES_URL$path" || true)
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
}

# Expects the last answer to be $1 with the error code $2; $3 says which call.
expect_error() {
  [ "$status" = "$1" ] && [ "$(json_field '.error.code // empty' "$body")" = "$2" ] ||
    fail "$3 returned HTTP $status, not $1 $2: $(head -c 500 <<<"$body")"
}

step "read the regex library as a member: GET /api/v1/test-regexes lists at least 35 entries (the seed's count)"
test_regex_request GET "" ""
[ "$status" = "200" ] || fail "GET /api/v1/test-regexes returned HTTP $status: $(head -c 500 <<<"$body")"
library=$body
library_count=$(json_field '.testRegexes | length' "$library")
[[ "$library_count" =~ ^[0-9]+$ ]] && [ "$library_count" -ge 35 ] ||
  fail "the regex library lists ${library_count:-no} entries, not at least 35"
# Compared as jq strings, so every backslash is checked from the seed to the
# answer: the SSN's is \d{3}-\d{2}-\d{4}, without the rule's \b … \b.
[ "$(jq -r --arg name "US Social Security Number" --arg regex "$SEEDED_SSN_REGEX" \
  '[.testRegexes[] | select(.name == $name)] | length == 1 and .[0].regex == $regex' <<<"$library" 2>/dev/null)" = "true" ] ||
  fail "the library's \"US Social Security Number\" isn't one entry with the regex $SEEDED_SSN_REGEX: $(jq -c \
    '[.testRegexes[] | select(.name == "US Social Security Number") | {name, regex}]' <<<"$library" 2>/dev/null)"

# As the picker does (RegexLibraryPickerDialog): the entry's regex as the
# pattern, its name, and its description, else its name.
step "save the library's \"AWS Access Key\" as a not_contains_regex rule, as the picker would"
aws_entry=$(jq -c '[.testRegexes[] | select(.name == "AWS Access Key")] | if length == 1 then .[0] else empty end' <<<"$library" 2>/dev/null || true)
[ -n "$aws_entry" ] || fail "the library has no one \"AWS Access Key\" entry"
aws_rule=$(jq -c '{kind: "not_contains_regex", target: "output", pattern: .regex, name: .name, description: (.description // .name)}' <<<"$aws_entry")
AWS_RULE_NAME=$(jq -r '.name' <<<"$aws_rule")
save_rule "$aws_rule" "$AWS_RULE_NAME"
aws_rule_id=$saved_rule_id
[ "$(json_compact '.rule | {kind, target, pattern, name, description}' "$body")" = "$aws_rule" ] ||
  fail "the saved library rule isn't the picker's: $(json_compact '.rule | {kind, target, pattern, name, description}' "$body")"

# The key `x"] != nil or attributes["y`, removed by a run, as Compare's
# "Create an OTTL rule" writes it (candidatePrefill: none of the records has
# it; ottlStringLiteral escapes its quotes and backslashes). Checked here:
# the condition is stored byte for byte; the real evaluator accepts it at
# Save (a half-escaped key, one quote escaped and not the other, it would
# refuse, failing the save); and the run below is of a second file whose
# extra record carries the attribute `y` and reaches the output (checked),
# so the key read unescaped, as the two keys `x` and `y`
# (`attributes["x"] != nil or attributes["y"] != nil`), would fail the
# `none` rule there, where the one escaped key, which no record has,
# passes. No record carries the crafted key itself, so the run doesn't show
# the rule fails on one that does: the evaluator's Go suite does
# (services/ottl-evaluator/internal/rules/compare_prefills_test.go).
step "save a Compare-shaped OTTL rule for a key with quotes and brackets, escaped as Compare writes it"
COMPARE_RULE_NAME="Compare: the crafted key stays removed"
COMPARE_CONDITION='attributes["x\"] != nil or attributes[\"y"] != nil'
compare_ottl=$(jq -cn --arg condition "$COMPARE_CONDITION" '{context: "log", quantifier: "none", condition: $condition}')
save_rule "$(jq -n --argjson ottl "$compare_ottl" --arg name "$COMPARE_RULE_NAME" \
  '{kind: "ottl", target: "output", ottl: $ottl, name: $name}')" "$COMPARE_RULE_NAME"
compare_rule_id=$saved_rule_id
[ "$(json_compact '.rule.ottl | {context, quantifier, condition}' "$body")" = "$compare_ottl" ] ||
  fail "the Compare-shaped rule's OTTL wasn't stored as sent: $(json_compact '.rule.ottl' "$body")"

step "delete \"Production only\": DELETE .../validation-pipelines/:id/rules/:ruleId"
status=$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE \
  "$VALIDATION_PIPELINES_URL/$validation_pipeline_id/rules/$prod_rule_id" -H 'X-Telflo-CSRF: 1' || true)
[ "$status" = "204" ] || fail "deleting the rule \"$PROD_RULE_NAME\" returned HTTP $status"

# The second file: the first file's record, and one carrying the attribute
# `y` (its body unique to this run too). The first file stays as it was, so
# the runs above keep their one record.
Y_RECORD_BODY="stack smoke record with y $(date +%s)-$$"
jq -n --arg body "$TEST_RECORD_BODY" --arg ybody "$Y_RECORD_BODY" '{resourceLogs: [{
  resource: {attributes: [{key: "service.name", value: {stringValue: "stack-smoke"}}]},
  scopeLogs: [{scope: {}, logRecords: [
    {timeUnixNano: "1700000000000000000", severityText: "INFO", body: {stringValue: $body}},
    {timeUnixNano: "1700000000000000001", severityText: "INFO", body: {stringValue: $ybody},
      attributes: [{key: "y", value: {stringValue: "present"}}]}
  ]}]
}]}' >"$work_dir/stack-smoke-logs-y.json"

step "upload a second OTLP logs document, its extra record carrying the attribute y: POST .../test-files"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" -X POST "$TEST_FILES_URL" -H 'X-Telflo-CSRF: 1' \
  -F 'displayName=Stack smoke logs with y' -F 'description=' \
  -F "file=@$work_dir/stack-smoke-logs-y.json;type=application/json;filename=stack-smoke-logs-y.json" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "uploading the second test file returned HTTP $status: $(head -c 500 <<<"$body")"
y_file_id=$(json_field '.file.id // empty' "$body")
[ -n "$y_file_id" ] || fail "the second test file has no id: $(head -c 500 <<<"$body")"

step "a run of the second file with the library rule and the Compare-shaped rule: it succeeds, every rule passing, in order"
queue_file_run "the run with the library and Compare-shaped rules" "$y_file_id"
library_run_id=$queued_run_id
poll_run "$library_run_id"
[ "$run_status" = "succeeded" ] ||
  fail "the run with the library and Compare-shaped rules ended $run_status: $(json_compact '.run | {status, errorCode, errorMessage, validationResults}' "$body")"
expected_rules=$(jq -cn --arg a "$record_rule_id" --arg b "$ssn_rule_id" --arg c "$aws_rule_id" --arg d "$compare_rule_id" '[$a, $b, $c, $d]')
[ "$(json_compact '[.run.validationRules[] | .id]' "$body")" = "$expected_rules" ] ||
  fail "the run didn't copy the four rules in order: $(json_compact '[.run.validationRules[] | {id, position}]' "$body")"
[ "$(json_compact '[.run.validationResults[] | [.id, .passed]]' "$body")" = "$(jq -c '[.[] | [., true]]' <<<"$expected_rules")" ] ||
  fail "the run's results aren't four passes in order: $(json_compact '[.run.validationResults[] | {id, passed, error}]' "$body")"

# The record carrying `y` came through, `y` and all: else the `none` rule's
# pass would prove nothing about the key read as two. The output is one
# OTLP document or `{"records": [...]}`; its log records are read with jq, and
# the one with this run's body must carry `y`.
step "the run's output holds the record carrying y: GET .../test-runs/:runId/files/output"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" "$TEST_RUNS_URL/$library_run_id/files/output" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "reading the run's output returned HTTP $status: $(head -c 500 <<<"$body")"
grep -qF "$Y_RECORD_BODY" <<<"$body" ||
  fail "the run's output doesn't hold the record carrying y ($Y_RECORD_BODY): $(head -c 500 <<<"$body")"
y_in_record=$(jq -r --arg body "$Y_RECORD_BODY" '
  [(if type == "object" and has("records") then .records[] else . end)
    | .resourceLogs[]?.scopeLogs[]?.logRecords[]?
    | select(.body.stringValue? == $body)]
  | if length == 0 then "no record"
    elif all(any(.attributes[]?; .key == "y" and .value.stringValue? == "present")) then "true"
    else "no y" end' <<<"$body" 2>/dev/null || true)
[ "$y_in_record" = "true" ] ||
  fail "the run's output has its record ($Y_RECORD_BODY) without the attribute y (${y_in_record:-unreadable}): $(head -c 500 <<<"$body")"

step "a member can't write to the library: POST /api/v1/test-regexes is 403 product_admin_required"
SMOKE_REGEX_NAME="stack-smoke-$(date +%s)-$$"
test_regex_request POST "" "$(jq -n --arg name "$SMOKE_REGEX_NAME" \
  '{name: $name, category: "Stack smoke", description: "Made by the stack smoke test", regex: "secret-[0-9]+"}')"
expect_error 403 product_admin_required "a member's POST /api/v1/test-regexes"

# The product-admin steps write as a product admin on the stack's own
# database: the flag by SQL, and a global library entry every account of the
# stack lists while it lasts. So they run only on a throwaway stack, named by
# COMPOSE_PROJECT_NAME and a throwaway stack's (throwaway_stack); without it, `docker compose` would take the project
# from the compose file (the development stack's `name: telflo-dev`).
# Otherwise they're skipped, with a line saying why.
if throwaway_stack; then
  product_admin_steps="had a product admin create, rename and delete a library entry (a lookahead refused in RE2's words)"
  step "make the account a product admin by SQL on the stack's database: /api/v1/auth/me shows isProductAdmin true"
  product_admin true
  expect_product_admin true

  step "as a product admin, create an entry: POST /api/v1/test-regexes is 201"
  test_regex_request POST "" "$(jq -n --arg name "$SMOKE_REGEX_NAME" \
    '{name: $name, category: "Stack smoke", description: "Made by the stack smoke test", regex: "secret-[0-9]+"}')"
  [ "$status" = "201" ] || fail "creating the entry returned HTTP $status: $(head -c 500 <<<"$body")"
  smoke_regex_id=$(json_field '.testRegex.id // empty' "$body")
  # Until it's deleted below, the EXIT trap deletes it if the run ends first.
  created_regex_id=$smoke_regex_id
  [ -n "$smoke_regex_id" ] && [ "$(json_compact '.testRegex | {name, category, description, regex}' "$body")" = "$(jq -cn \
    --arg name "$SMOKE_REGEX_NAME" '{name: $name, category: "Stack smoke", description: "Made by the stack smoke test", regex: "secret-[0-9]+"}')" ] ||
    fail "the created entry has no id or other fields: $(head -c 500 <<<"$body")"

  step "rename it and change its description: PATCH /api/v1/test-regexes/:id is 200"
  RENAMED_REGEX_NAME="$SMOKE_REGEX_NAME renamed"
  test_regex_request PATCH "/$smoke_regex_id" "$(jq -n --arg name "$RENAMED_REGEX_NAME" \
    '{name: $name, description: "Renamed by the stack smoke test"}')"
  [ "$status" = "200" ] || fail "renaming the entry returned HTTP $status: $(head -c 500 <<<"$body")"
  [ "$(json_compact '.testRegex | {id, name, description, regex}' "$body")" = "$(jq -cn --arg id "$smoke_regex_id" \
    --arg name "$RENAMED_REGEX_NAME" '{id: $id, name: $name, description: "Renamed by the stack smoke test", regex: "secret-[0-9]+"}')" ] ||
    fail "the rename answered $(head -c 500 <<<"$body")"

  step "a lookahead is refused by the real evaluator's RE2: PATCH its regex to secret(?=:) is 400 test_regex_invalid at regex"
  test_regex_request PATCH "/$smoke_regex_id" '{"regex": "secret(?=:)"}'
  expect_error 400 test_regex_invalid "the lookahead PATCH"
  [[ "$(json_field '.error.message // empty' "$body")" == "Invalid regex: "?* ]] ||
    fail "the lookahead was refused without the evaluator's words: $(head -c 500 <<<"$body")"
  [ "$(json_field '.error.details.problems[0].field // empty' "$body")" = "regex" ] ||
    fail "the lookahead was refused naming another field: $(head -c 500 <<<"$body")"

  step "delete it: DELETE /api/v1/test-regexes/:id is 204, and again 404 test_regex_not_found"
  test_regex_request DELETE "/$smoke_regex_id" ""
  [ "$status" = "204" ] || fail "deleting the entry returned HTTP $status: $(head -c 500 <<<"$body")"
  created_regex_id=""
  test_regex_request DELETE "/$smoke_regex_id" ""
  expect_error 404 test_regex_not_found "deleting the entry again"

  step "clear the flag by SQL: /api/v1/auth/me shows isProductAdmin false, and the next write is 403"
  product_admin false
  expect_product_admin false
  test_regex_request POST "" "$(jq -n --arg name "$SMOKE_REGEX_NAME" \
    '{name: $name, category: "Stack smoke", regex: "secret-[0-9]+"}')"
  expect_error 403 product_admin_required "a POST /api/v1/test-regexes after the flag was cleared"
else
  product_admin_steps="skipped the product-admin steps (not a throwaway stack)"
  step "SKIPPED: the product-admin steps (grant the flag by SQL, create, rename and delete a library entry, clear the flag) run only on a throwaway stack: COMPOSE_PROJECT_NAME is ${COMPOSE_PROJECT_NAME:-unset}, not a throwaway stack's"
fi

# 262,144 characters of YAML, the limit, each written \u0001 in JSON (about
# 1.5 MiB), and 5,000 nodes, the contract's bound (about 0.8 MiB): over 2 MiB,
# the default limit, which the save route and the gateway raise to 5 MiB.
step "save 262,144 × U+0001 and 5,000 nodes through the gateway: a body over 2 MiB is accepted on the save route"
jq -n '{
  yamlContent: ("\u0001" * 262144),
  nodes: [range(0; 5000) | {id: "node_\(.)", type: "processor", position: {x: ., y: 0},
    data: {label: "Batch", componentType: "processor", componentSubType: "batch", config: {timeout: "1s"}}}],
  edges: [],
  pipelines: []
}' >"$work_dir/large-save-body.json"
large_size=$(wc -c <"$work_dir/large-save-body.json" | tr -d ' ')
[ "$large_size" -gt 2097152 ] || fail "the large body is only $large_size bytes, not over 2 MiB"
save_version "$work_dir/large-save-body.json"
[ "$(jq -r '.version.yamlContent | length' <<<"$body")" = "262144" ] ||
  fail "the large save returned YAML of another length: $(jq -r '.version.yamlContent | length' <<<"$body")"
get_configuration
[ "$(jq '.version' <<<"$body" | graph_of)" = "$(graph_of "$work_dir/large-save-body.json")" ] ||
  fail "the read does not return the large save's 5,000 nodes: $(jq '.version.nodes | length' <<<"$body") of them"

# Versions. The create sends the editor's content as the save does, so
# its body can be as large: the large save's body with the source version,
# over 2 MiB, on the create's path, which the gateway also allows 5 MiB.
step "create version 2 from version 1 with a body over 2 MiB: POST .../configurations/:configurationId/versions"
jq --arg source "$version_id" '. + {sourceVersionId: $source}' \
  "$work_dir/large-save-body.json" >"$work_dir/create-version-body.json"
create_size=$(wc -c <"$work_dir/create-version-body.json" | tr -d ' ')
[ "$create_size" -gt 2097152 ] || fail "the create's body is only $create_size bytes, not over 2 MiB"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$CONFIGURATIONS_URL/$configuration_id/versions" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$work_dir/create-version-body.json")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "creating a version returned HTTP $status: $(head -c 500 <<<"$body")"
second_version_id=$(jq -r '.version.id' <<<"$body")
[ -n "$second_version_id" ] && [ "$second_version_id" != "null" ] && [ "$second_version_id" != "$version_id" ] ||
  fail "the created version has no id of its own: $(head -c 500 <<<"$body")"
[ "$(jq -r '.version.versionNumber' <<<"$body")" = "2" ] ||
  fail "the created version is not version 2: $(jq -c '.version | {versionNumber, label}' <<<"$body")"
[ "$(jq -r '.version.yamlContent | length' <<<"$body")" = "262144" ] ||
  fail "the created version holds YAML of another length: $(jq -r '.version.yamlContent | length' <<<"$body")"
[ "$(jq -r '.version.createdBy.email' <<<"$body")" = "$EMAIL" ] ||
  fail "the created version names another creator: $(jq -c '.version.createdBy' <<<"$body")"

SECOND_VERSION_LABEL="Stack smoke version 2"
step "rename it: PUT .../versions/:versionId/label"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X PUT "$CONFIGURATIONS_URL/$configuration_id/versions/$second_version_id/label" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg label "$SECOND_VERSION_LABEL" '{label: $label}')")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "renaming the version returned HTTP $status: $body"
[ "$(jq -r '.version.id' <<<"$body")" = "$second_version_id" ] && [ "$(jq -r '.version.label' <<<"$body")" = "$SECOND_VERSION_LABEL" ] ||
  fail "the rename answered $body"

step "select version 1: PUT .../configurations/:configurationId/selected-version"
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT "$CONFIGURATIONS_URL/$configuration_id/selected-version" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg id "$version_id" '{versionId: $id}')")
[ "$status" = "204" ] || fail "selecting version 1 returned HTTP $status"

step "read the configuration: the selected version 1, and both versions listed"
get_configuration
[ "$(jq '.versions | length' <<<"$body")" = "2" ] ||
  fail "the read lists $(jq '.versions | length' <<<"$body") versions, not 2: $(jq -c '[.versions[] | {versionNumber, label}]' <<<"$body")"
[ "$(jq -c '[.versions[] | {id, versionNumber, label}]' <<<"$body")" = "$(jq -cn \
  --arg second "$second_version_id" --arg first "$version_id" --arg label "$SECOND_VERSION_LABEL" \
  '[{id: $second, versionNumber: 2, label: $label}, {id: $first, versionNumber: 1, label: null}]')" ] ||
  fail "the read lists other versions: $(jq -c '[.versions[] | {id, versionNumber, label}]' <<<"$body")"

step "read version 2: GET .../configurations/:configurationId/versions/:versionId"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$CONFIGURATIONS_URL/$configuration_id/versions/$second_version_id")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "reading version 2 returned HTTP $status: $(head -c 500 <<<"$body")"
[ "$(jq -c '.version | {id, versionNumber, label}' <<<"$body")" = "$(jq -cn \
  --arg id "$second_version_id" --arg label "$SECOND_VERSION_LABEL" '{id: $id, versionNumber: 2, label: $label}')" ] ||
  fail "the read answered another version: $(jq -c '.version | {id, versionNumber, label}' <<<"$body")"
[ "$(jq -r '.version.yamlContent | length' <<<"$body")" = "262144" ] ||
  fail "version 2 holds YAML of another length: $(jq -r '.version.yamlContent | length' <<<"$body")"
[ "$(jq '.versions | length' <<<"$body")" = "2" ] || fail "version 2's read lists $(jq '.versions | length' <<<"$body") versions, not 2"

# The version copy: version 2, created from version 1, has its own copy of
# version 1's suite and of its test configuration, under their names, with new
# ids.
SECOND_TEST_SUITES_URL="$CONFIGURATIONS_URL/$configuration_id/versions/$second_version_id/test-suites"
step "version 2 carries a copy of the suite: GET .../versions/:versionId/test-suites"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$SECOND_TEST_SUITES_URL" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "listing version 2's test suites returned HTTP $status: $body"
[ "$(jq -c '[.suites[] | {name, versionId}]' <<<"$body")" = "$(jq -cn --arg name "$SUITE_NAME" --arg version "$second_version_id" \
  '[{name: $name, versionId: $version}]')" ] ||
  fail "version 2 doesn't list one copy of the suite: $(jq -c '[.suites[] | {id, name, versionId}]' <<<"$body")"
copied_suite_id=$(jq -r '.suites[0].id' <<<"$body")
[ "$copied_suite_id" != "$suite_id" ] || fail "version 2's suite is version 1's, not a copy: $copied_suite_id"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$SECOND_TEST_SUITES_URL/$copied_suite_id/definitions" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "listing the copied suite's test configurations returned HTTP $status: $body"
[ "$(jq -c '[.definitions[] | {name, inputName, pipeline}]' <<<"$body")" = "$(jq -cn --arg name "$DEFINITION_NAME" \
  '[{name: $name, inputName: "stack-smoke-logs.json", pipeline: "logs"}]')" ] ||
  fail "the copied suite doesn't hold one copy of the test configuration: $(jq -c '[.definitions[] | {id, name, inputName, pipeline}]' <<<"$body")"
[ "$(jq -r '.definitions[0].id' <<<"$body")" != "$definition_id" ] ||
  fail "the copied suite's test configuration is version 1's, not a copy"

# The validation pipelines' copy: version 2 has its own copy of version 1's
# validation pipeline and its four rules, in order (the two that pass, then
# the library and Compare-shaped rules; "Production only" was deleted before
# the copy).
SECOND_VALIDATION_PIPELINES_URL="$CONFIGURATIONS_URL/$configuration_id/versions/$second_version_id/validation-pipelines"
step "version 2 carries a copy of the validation pipeline and its rules: GET .../versions/:versionId/validation-pipelines"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" "$SECOND_VALIDATION_PIPELINES_URL" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "listing version 2's validation pipelines returned HTTP $status: $(head -c 500 <<<"$body")"
[ "$(json_compact '[.validationPipelines[] | {pipeline, versionId}]' "$body")" = "$(jq -cn --arg version "$second_version_id" \
  '[{pipeline: "logs", versionId: $version}]')" ] ||
  fail "version 2 doesn't list one copy of the validation pipeline: $(json_compact '[.validationPipelines[] | {id, pipeline, versionId}]' "$body")"
copied_validation_pipeline_id=$(json_field '.validationPipelines[0].id // empty' "$body")
[ -n "$copied_validation_pipeline_id" ] && [ "$copied_validation_pipeline_id" != "$validation_pipeline_id" ] ||
  fail "version 2's validation pipeline is version 1's, not a copy: $copied_validation_pipeline_id"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" "$SECOND_VALIDATION_PIPELINES_URL/$copied_validation_pipeline_id/rules" || true)
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "listing the copied validation pipeline's rules returned HTTP $status: $(head -c 500 <<<"$body")"
[ "$(json_compact '[.rules[] | .name]' "$body")" = "$(jq -cn --arg a "$RECORD_RULE_NAME" --arg b "$SSN_RULE_NAME" \
  --arg c "$AWS_RULE_NAME" --arg d "$COMPARE_RULE_NAME" '[$a, $b, $c, $d]')" ] ||
  fail "the copied validation pipeline doesn't hold the four rules in order: $(json_compact '[.rules[] | {name, position}]' "$body")"
for original in "$record_rule_id" "$ssn_rule_id" "$aws_rule_id" "$compare_rule_id"; do
  [ "$(json_field "[.rules[] | .id] | index(\"$original\")" "$body")" = "null" ] ||
    fail "the copied validation pipeline holds version 1's rule $original, not a copy"
done

# Publishing: version 2, holding the large save's YAML, through the
# gateway; the platform puts its snapshot in the opamp-server first, then
# records it.
step "publish version 2: POST .../versions/:versionId/publish"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST \
  "$CONFIGURATIONS_URL/$configuration_id/versions/$second_version_id/publish" -H 'X-Telflo-CSRF: 1')
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "publishing version 2 returned HTTP $status: $(head -c 500 <<<"$body")"
[ "$(jq -c '.version | {id, versionNumber}' <<<"$body")" = "$(jq -cn --arg id "$second_version_id" '{id: $id, versionNumber: 2}')" ] ||
  fail "the publish answered another version: $(jq -c '.version | {id, versionNumber}' <<<"$body")"
[ "$(jq -r '.version.publishedAt | type' <<<"$body")" = "string" ] && [ "$(jq -r '.version.publishedBy.email' <<<"$body")" = "$EMAIL" ] ||
  fail "the publish didn't answer version 2 as published by $EMAIL: $(jq -c '.version | {publishedAt, publishedBy}' <<<"$body")"
# The collector version version 2 is pinned to, which the
# published snapshot must name.
second_version_collector=$(jq -r '.version.collectorVersion' <<<"$body")
[[ "$second_version_collector" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "the publish answered no collector version: $(jq -c '.version | {collectorVersion}' <<<"$body")"

# The snapshot is version 2's, by its id, holds the YAML saved as version 2,
# by its SHA-256: jq -j writes the saved string's UTF-8 bytes as they are,
# with no newline added, and names the collector it was
# published for, the configuration's distribution and version 2's pin, as
# the real opamp-server stored it.
second_version_sha256=$(jq -j '.yamlContent' "$work_dir/create-version-body.json" | sha256_of)
[[ "$second_version_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "couldn't compute the SHA-256 of version 2's YAML"
step "the opamp-server holds the configuration's one snapshot: version 2's, holding the YAML saved, for $configuration_distribution $second_version_collector"
stack_smoke publication "$personal_id" "$configuration_id" 2 "$second_version_id" "$second_version_sha256" \
  "$configuration_distribution" "$second_version_collector" ||
  fail "the opamp-server doesn't hold the one snapshot of version 2 ($second_version_id) of $configuration_id with the YAML saved, for $configuration_distribution $second_version_collector (above)"

step "delete it: DELETE /api/v1/organizations/:id/configurations/:configurationId"
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE "$CONFIGURATIONS_URL/$configuration_id" \
  -H 'X-Telflo-CSRF: 1')
[ "$status" = "204" ] || fail "deleting the configuration returned HTTP $status"

step "list again: the deleted configuration is gone"
list_configurations
if grep -qx "$configuration_id" <<<"$listed_ids"; then
  fail "the list still includes the deleted configuration $configuration_id: $body"
fi

# The platform removes a deleted configuration's snapshots after the
# response, so this asks for up to about 10 s.
step "the platform removed the deleted configuration's snapshots from the opamp-server"
stack_smoke publications "$personal_id" "$configuration_id" 0 ||
  fail "the opamp-server still holds snapshots of the deleted configuration $configuration_id (above)"

# The fleet model: a real collector, the OpAMP supervisor 0.162.0
# running otelcol-contrib 0.162.0 (docker/smoke-collector, built here under
# a throwaway tag from the stack's own validator image and removed at the
# end), enrolled through the opamp-server's management API and its agent
# endpoint. In the personal organization, still signed in, after the
# publishing steps: the fleet's published version is a configuration
# of its own, since one in use can't be deleted (409 publication_in_use)
# and the configuration's delete above must still pass. The management API is
# called with curl, its secret (the API container's own setting) in a 0600
# header file under the work directory, never on a command line; so are the
# bearers, which reach a collector by a bare `docker run -e`. Every wait is
# a bounded number of polls. A run that ends inside these steps removes its
# collectors, the second replica, the fleet, the published version and the
# image (the EXIT trap).
step "the opamp-server's agent endpoint answers /health on its published port"
status=$(curl -s -o /dev/null -w '%{http_code}' "$OPAMP_AGENT_URL/health")
[ "$status" = "200" ] || fail "GET $OPAMP_AGENT_URL/health returned HTTP $status"

opamp_container=$(docker compose ps -q opamp-server)
[ -n "$opamp_container" ] || fail "no opamp-server container in this compose project"
compose_project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$opamp_container")
compose_network=$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$opamp_container" | awk '{print $1}')
[ -n "$compose_project" ] && [ -n "$compose_network" ] || fail "couldn't read the opamp-server container's compose project and network"
# The URL the server hands every collector with its rotate token: the smoke's
# collectors start on it too, so it must reach this stack's opamp-server
# from the compose network: its service name, or (on Docker Desktop) the
# host's published agent port.
server_url=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$opamp_container" | sed -n 's/^OPAMP_SERVER_URL=//p')
[[ "$server_url" =~ ^http://([^/:]+):([0-9]+)/opamp/api/v1$ ]] || fail "the opamp-server's OPAMP_SERVER_URL isn't an http URL of /opamp/api/v1: $server_url"
server_host=${BASH_REMATCH[1]}
server_port=${BASH_REMATCH[2]}
{ [ "$server_host" = "opamp-server" ] && [ "$server_port" = "51234" ]; } ||
  { [ "$server_host" = "host.docker.internal" ] && [ "$server_port" = "$published_agent_port" ]; } ||
  fail "the opamp-server hands collectors $server_url, which isn't this stack's agent endpoint as a container reaches it: start the stack with OPAMP_SERVER_URL=http://opamp-server:51234/opamp/api/v1 (CI's stack job does)"

MANAGEMENT_HEADERS="$work_dir/management-headers"
management_secret=$(docker compose exec -T api printenv TELFLO_OPAMP_MANAGEMENT_SECRET) ||
  fail "couldn't read the API's TELFLO_OPAMP_MANAGEMENT_SECRET"
(umask 077 && printf 'Authorization: Bearer %s\n' "$management_secret" >"$MANAGEMENT_HEADERS")
unset management_secret
ORGANIZATION_MANAGEMENT_URL="$OPAMP_MANAGEMENT_URL/api/v1/organizations/$personal_id"
FLEETS_URL="$ORGANIZATION_MANAGEMENT_URL/fleets"

# management <method> <url> [<json body>]: one call to the management API;
# its status goes into $status and its body into $body.
management() {
  local method=$1 url=$2
  if [ $# -ge 3 ]; then
    response=$(curl -s --max-time 30 -w '\n%{http_code}' -H @"$MANAGEMENT_HEADERS" -H 'content-type: application/json' \
      -X "$method" "$url" --data-binary "$3")
  else
    response=$(curl -s --max-time 30 -w '\n%{http_code}' -H @"$MANAGEMENT_HEADERS" -X "$method" "$url")
  fi
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
}

response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$GATEWAY_URL/api/v1/auth/me")
[ "$(tail -n1 <<<"$response")" = "200" ] || fail "GET /api/v1/auth/me before the fleet steps returned HTTP $(tail -n1 <<<"$response")"
actor=$(sed '$d' <<<"$response" | jq -c '{id: .user.id, email: .user.email}')

FLEET_LABEL="stack-smoke-$(date +%s)-$$"
step "create a fleet: POST .../organizations/:id/fleets answers its Default group and both tokens' bearers"
management POST "$FLEETS_URL" "$(jq -cn --arg label "$FLEET_LABEL" --argjson actor "$actor" \
  '{label: $label, type: "server", rotateExpiresAt: null, actor: $actor}')"
# The reply holds the bearers: only its error code is ever printed.
[ "$status" = "201" ] || fail "creating the fleet returned HTTP $status: $(json_field '.error.code // "no error code"' "$body")"
fleet_id=$(json_field '.fleet.id' "$body")
default_group_id=$(json_field '.defaultGroup.id' "$body")
default_token_id=$(json_field '.tokens.default.id' "$body")
rotate_token_id=$(json_field '.tokens.rotate.id' "$body")
default_bearer=$(json_field '.tokens.default.bearer' "$body")
rotate_bearer=$(json_field '.tokens.rotate.bearer' "$body")
for value in "$fleet_id" "$default_group_id" "$default_token_id" "$rotate_token_id" "$default_bearer" "$rotate_bearer"; do
  [ -n "$value" ] && [ "$value" != "null" ] || fail "the fleet's creation answered no fleet, Default group, token or bearer"
done
body=""

step "create the fleet's group \"gateways\": POST .../fleets/:fleetId/groups"
management POST "$FLEETS_URL/$fleet_id/groups" '{"name": "gateways"}'
[ "$status" = "201" ] || fail "creating the group returned HTTP $status: $body"
gateways_group_id=$(json_field '.id' "$body")
[ "$(json_field '.isDefault' "$body")" = "false" ] && [ "$(json_field '.assignedPublicationId' "$body")" = "null" ] ||
  fail "the new group isn't an unassigned group: $body"

# The fleet's own configuration, published through the gateway as a user
# publishes; the supervisor merges it over its local file and reports the
# SHA-256 of the bytes it was served.
FLEET_YAML=$'# Published by the stack smoke test for its fleet\nreceivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 127.0.0.1:4319\nprocessors:\n  batch: {}\nexporters:\n  debug:\n    verbosity: basic\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [debug]\n'
step "publish the fleet's configuration through the gateway: create it, save its YAML and publish version 1"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST "$CONFIGURATIONS_URL" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg name "Stack smoke fleet $(date +%s)-$$" '{name: $name, description: "The stack smoke test fleet'"'"'s configuration"}')")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "201" ] || fail "creating the fleet's configuration returned HTTP $status: $body"
fleet_configuration_id=$(jq -r '.configuration.id' <<<"$body")
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$CONFIGURATIONS_URL/$fleet_configuration_id")
[ "$(tail -n1 <<<"$response")" = "200" ] || fail "reading the fleet's configuration returned HTTP $(tail -n1 <<<"$response")"
fleet_version_id=$(sed '$d' <<<"$response" | jq -r '.version.id')
jq -n --arg yaml "$FLEET_YAML" '{yamlContent: $yaml, nodes: [], edges: [], pipelines: []}' >"$work_dir/fleet-save-body.json"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X PATCH "$CONFIGURATIONS_URL/$fleet_configuration_id/versions/$fleet_version_id" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$work_dir/fleet-save-body.json")
[ "$(tail -n1 <<<"$response")" = "200" ] || fail "saving the fleet's configuration returned HTTP $(tail -n1 <<<"$response"): $(sed '$d' <<<"$response" | head -c 500)"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X POST \
  "$CONFIGURATIONS_URL/$fleet_configuration_id/versions/$fleet_version_id/publish" -H 'X-Telflo-CSRF: 1')
[ "$(tail -n1 <<<"$response")" = "200" ] || fail "publishing the fleet's configuration returned HTTP $(tail -n1 <<<"$response"): $(sed '$d' <<<"$response" | head -c 500)"
fleet_yaml_sha256=$(jq -j '.yamlContent' "$work_dir/fleet-save-body.json" | sha256_of)
management GET "$ORGANIZATION_MANAGEMENT_URL/publications?configurationId=$fleet_configuration_id"
[ "$status" = "200" ] || fail "listing the fleet configuration's publications returned HTTP $status: $body"
fleet_publication_id=$(json_field '.publications[0].id' "$body")
[ "$(json_field '.publications | length' "$body")" = "1" ] && [ "$(json_field '.publications[0].sha256' "$body")" = "$fleet_yaml_sha256" ] ||
  fail "the opamp-server doesn't hold the one published version of the fleet's configuration, with the YAML saved: $body"

# Assigned before the first collector starts.
step "assign it to the fleet's Default group: PATCH .../groups/:groupId"
management PATCH "$FLEETS_URL/$fleet_id/groups/$default_group_id" "$(jq -cn --arg id "$fleet_publication_id" '{assignedPublicationId: $id}')"
[ "$status" = "200" ] && [ "$(json_field '.assignedPublicationId' "$body")" = "$fleet_publication_id" ] ||
  fail "assigning the published version returned HTTP $status: $body"

step "the published version in use can't be deleted: DELETE .../publications/:id answers 409 publication_in_use"
management DELETE "$ORGANIZATION_MANAGEMENT_URL/publications/$fleet_publication_id"
[ "$status" = "409" ] && [ "$(json_field '.error.code' "$body")" = "publication_in_use" ] ||
  fail "deleting the published version in use returned HTTP $status: $body"

step "build the smoke collector from the stack's validator image: docker/smoke-collector"
validator_container=$(docker compose ps -q otelcol-validator)
validator_image=$(docker inspect --format '{{.Config.Image}}' "$validator_container")
[ -n "$validator_image" ] || fail "couldn't read the validator container's image"
smoke_collector_image="telflo-smoke-collector:$compose_project-$$"
if ! output=$(docker build -q --build-arg "VALIDATOR_IMAGE=$validator_image" -t "$smoke_collector_image" \
  "$(dirname "$0")/../docker/smoke-collector" 2>&1); then
  smoke_collector_image=""
  fail "building the smoke collector failed: $output"
fi

# start_collector <name> <endpoint> <bearer> <group id> starts one
# collector, a container of its own on the compose network (its instance
# uid made on its first start), named <project>-<name>. The group is
# required: the opamp-server refuses a collector naming none, and
# the smoke collector's image has no script of its own to refuse it.
start_collector() {
  local container="$compose_project-$1"
  [ -n "$4" ] || fail "start_collector $1: no group id (the opamp-server refuses a collector naming no group)"
  fleet_containers="$fleet_containers $container"
  TELFLO_COLLECTOR_NAME=$1 TELFLO_OPAMP_ENDPOINT=$2 TELFLO_OPAMP_BEARER=$3 TELFLO_COLLECTOR_GROUP_ID=$4 \
    docker run -d --name "$container" --network "$compose_network" \
    -e TELFLO_COLLECTOR_NAME -e TELFLO_OPAMP_ENDPOINT -e TELFLO_OPAMP_BEARER -e TELFLO_COLLECTOR_GROUP_ID \
    "$smoke_collector_image" >/dev/null || fail "starting the collector $1 failed"
}

# wait_for_collector <name> <polls> <jq condition>: reads the fleet's
# collector of that name through the first replica's management API, once a
# second, until the condition holds of it; $collector holds it.
wait_for_collector() {
  local name=$1 polls=$2 condition=$3
  collector=""
  for _ in $(seq 1 "$polls"); do
    management GET "$FLEETS_URL/$fleet_id/collectors?q=$name"
    if [ "$status" = "200" ]; then
      collector=$(jq -c --arg name "$name" '[.collectors[] | select(.name == $name)][0] // empty' <<<"$body")
      if [ -n "$collector" ] && [ "$(jq -r "$condition" <<<"$collector")" = "true" ]; then return 0; fi
    fi
    sleep 1
  done
  fail "the collector $name didn't reach the state wanted within $polls polls: ${collector:-not enrolled}"
}

step "start edge-01 with the fleet's default bearer, in the Default group"
start_collector edge-01 "$server_url" "$default_bearer" "$default_group_id"

step "edge-01 enrolled in the Default group and was handed the rotate token (at most 30 polls)"
wait_for_collector edge-01 30 "(.enrollmentTokenId == \"$rotate_token_id\") and (.groupId == \"$default_group_id\")"
edge01_id=$(jq -r '.id' <<<"$collector")

step "edge-01 applied the published version: effective applied with the saved YAML's SHA-256, in sync (at most 60 polls)"
wait_for_collector edge-01 60 "(.effective.status == \"applied\") and (.effective.sha256 == \"$fleet_yaml_sha256\") and (.sync == \"inSync\") and (.served.id == \"$fleet_publication_id\")"

step "start a second replica of the opamp-server: docker compose run ... opamp-server serve"
replica_name="$compose_project-opamp-replica-2"
replica_url="http://$replica_name:51234/opamp/api/v1"
replica_container="$replica_name"
docker compose run -d --no-deps --name "$replica_name" -e "OPAMP_SERVER_URL=$replica_url" \
  -p "127.0.0.1:$OPAMP_REPLICA_PORT:51234" opamp-server serve >/dev/null ||
  fail "starting the second replica failed"
REPLICA_AGENT_URL="http://127.0.0.1:$OPAMP_REPLICA_PORT"
replica_status=""
for _ in $(seq 1 30); do
  replica_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$REPLICA_AGENT_URL/health" || true)
  [ "$replica_status" = "200" ] && break
  sleep 1
done
[ "$replica_status" = "200" ] || fail "the second replica's agent endpoint didn't answer /health within 30 polls: $(docker logs --tail 20 "$replica_name" 2>&1)"

step "start edge-02 through the second replica, on the same local file, in \"gateways\" with nothing assigned"
start_collector edge-02 "$replica_url" "$default_bearer" "$gateways_group_id"

step "edge-02, with nothing assigned, is unassigned and sent no configuration, read through the first replica (at most 30 polls)"
wait_for_collector edge-02 30 "(.pin == null) and (.resolution == null) and (.served == null) and (.sync == \"unassigned\") and (.groupId == \"$gateways_group_id\") and (.enrollmentTokenId == \"$rotate_token_id\")"
step "the fleet's former imports path answers 404 not_found"
management GET "$FLEETS_URL/$fleet_id/imports"
[ "$status" = "404" ] && [ "$(json_field '.error.code' "$body")" = "not_found" ] ||
  fail "the fleet's former imports path returned HTTP $status: $body"

# The agent's door requires a group: hand-made AgentToServer messages of
# fresh instance uids (field 1, 16 bytes) on the default token's bearer, from
# a 0600 header file, to the first replica's agent endpoint. One whose agent
# description (field 3) names no group is refused 403 with the fixed body
# "Forbidden", enrolling nothing. A group "doomed" is made through the
# management API, and a message naming it (field 3's non-identifying
# attribute telflo.collector_group_id) enrolls a collector there; the group's
# delete deletes that collector with it, and the same instance uid naming it
# again is refused 403 (its group no longer exists). A 200's body holds the
# rotate token's bearer (the enrolment hands it over): every reply body goes
# to a 0600 file, is never printed, and is removed once read; a failure
# prints statuses and ids only.
(umask 077 && printf 'Authorization: Bearer %s\n' "$default_bearer" >"$work_dir/default-headers")
# group_poll <payload file>: one message on the default token; its HTTP
# status on standard output (000 when curl fails), its body in
# $work_dir/group-poll-body.
group_poll() {
  (umask 077 && curl -s -o "$work_dir/group-poll-body" -w '%{http_code}' --max-time 10 -H @"$work_dir/default-headers" \
    -H 'content-type: application/x-protobuf' --data-binary "@$work_dir/$1" "$OPAMP_AGENT_URL/opamp/api/v1") || true
}
# Whether the last poll's body is exactly "Forbidden" (and a line break):
# middleware.WriteForbidden's fixed body. A missing body is not.
poll_forbidden() {
  local reply
  reply=$(cat "$work_dir/group-poll-body" 2>/dev/null) || return 1
  [ "$reply" = "Forbidden" ]
}
# fresh_uid <file>: 16 random bytes into <file>; $uid then holds them as the
# opamp-server prints an instance uid (a UUID's lower-case hex form).
fresh_uid() {
  local hex
  head -c 16 /dev/urandom >"$1"
  hex=$(od -An -v -tx1 "$1" | tr -d ' \n')
  [[ "$hex" =~ ^[0-9a-f]{32}$ ]] || fail "couldn't make an instance uid: $hex"
  uid="${hex:0:8}-${hex:8:4}-${hex:12:4}-${hex:16:4}-${hex:20:12}"
}
# named_message <uid file> <group id> <payload file>: a message of that uid
# whose description names the group: field 3 (69 bytes) holding field 2, a
# KeyValue (67 bytes) of the key telflo.collector_group_id (25 bytes) and an
# AnyValue (38 bytes) whose string (36 bytes) is the group's id.
named_message() {
  [[ "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || fail "named_message: the group id isn't a UUID: $2"
  { printf '\n\020'; cat "$1"; printf '\032\105\022\103\n\031%s\022\046\n\044%s' telflo.collector_group_id "$2"; } >"$work_dir/$3"
}

step "a fresh collector whose agent description names no group is refused 403 \"Forbidden\" on the default token, and isn't enrolled"
fresh_uid "$work_dir/no-group-uid.bin"
no_group_uid=$uid
# Field 3, an AgentDescription present and empty.
{ printf '\n\020'; cat "$work_dir/no-group-uid.bin"; printf '\032\000'; } >"$work_dir/no-group.pb"
status=$(group_poll no-group.pb)
if [ "$status" != "403" ] || ! poll_forbidden; then
  rm -f "$work_dir/group-poll-body"
  fail "the poll naming no group returned HTTP $status, not 403 with the body \"Forbidden\""
fi
rm -f "$work_dir/group-poll-body"
management GET "$FLEETS_URL/$fleet_id/collectors?limit=100"
[ "$status" = "200" ] && [ "$(json_field "any(.collectors[]; .instanceUid == \"$no_group_uid\")" "$body")" = "false" ] ||
  fail "the fleet's collectors (HTTP $status) hold the collector refused for naming no group: $(json_compact '[.collectors[]? | {id, instanceUid, groupId}]' "$body")"

step "create the group \"doomed\" through the management API; a fresh collector naming it enrolls (200) and is listed in it (at most 10 polls)"
management POST "$FLEETS_URL/$fleet_id/groups" '{"name": "doomed"}'
[ "$status" = "201" ] || fail "creating the group \"doomed\" returned HTTP $status: $body"
doomed_group_id=$(json_field '.id' "$body")
fresh_uid "$work_dir/doomed-uid.bin"
doomed_uid=$uid
named_message "$work_dir/doomed-uid.bin" "$doomed_group_id" doomed.pb
status=$(group_poll doomed.pb)
rm -f "$work_dir/group-poll-body"
[ "$status" = "200" ] || fail "the poll naming the group \"doomed\" returned HTTP $status"
doomed_collector_id=""
for _ in $(seq 1 10); do
  management GET "$FLEETS_URL/$fleet_id/collectors?groupId=$doomed_group_id"
  if [ "$status" = "200" ] && [ "$(json_field "(.collectors | length) == 1 and .collectors[0].instanceUid == \"$doomed_uid\"" "$body")" = "true" ]; then
    doomed_collector_id=$(json_field '.collectors[0].id' "$body")
    break
  fi
  sleep 1
done
[ -n "$doomed_collector_id" ] ||
  fail "the collector naming \"doomed\" isn't its group's one collector within 10 polls (HTTP $status): $(json_compact '[.collectors[]? | {id, instanceUid, groupId}]' "$body")"

step "delete the group \"doomed\": 204, its collector deleted with it (404 collector_not_found), and the same instance uid naming it again refused 403 \"Forbidden\""
management DELETE "$FLEETS_URL/$fleet_id/groups/$doomed_group_id"
[ "$status" = "204" ] || fail "deleting the group \"doomed\" returned HTTP $status: $body"
management GET "$FLEETS_URL/$fleet_id/collectors/$doomed_collector_id"
[ "$status" = "404" ] && [ "$(json_field '.error.code' "$body")" = "collector_not_found" ] ||
  fail "the deleted group's collector $doomed_collector_id is still there: HTTP $status $(json_field '.error.code // empty' "$body")"
status=$(group_poll doomed.pb)
if [ "$status" != "403" ] || ! poll_forbidden; then
  rm -f "$work_dir/group-poll-body"
  fail "the deleted group's collector, naming it again, returned HTTP $status, not 403 with the body \"Forbidden\""
fi
rm -f "$work_dir/group-poll-body"

# A hand-made AgentToServer of a fresh instance uid (field 1, 16 bytes),
# sent with the rotate token's bearer, from a 0600 header file, to each
# replica's agent endpoint: answered before the revocation, refused after it
# by both within the token cache's 10 seconds. It carries no agent
# description, so it is answered 200 with an ask for the full state and
# never enrolled; the bearer is checked first all the same.
(umask 077 && printf 'Authorization: Bearer %s\n' "$rotate_bearer" >"$work_dir/rotate-headers")
{ printf '\n\020'; head -c 16 /dev/urandom; } >"$work_dir/agent-to-server.pb"
agent_poll() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H @"$work_dir/rotate-headers" \
    -H 'content-type: application/x-protobuf' --data-binary "@$work_dir/agent-to-server.pb" "$1/opamp/api/v1" || true
}
step "revoke the rotate token: a fresh collector's poll on it is answered 200 by both replicas, then 401 by both (at most 15 polls)"
for url in "$OPAMP_AGENT_URL" "$REPLICA_AGENT_URL"; do
  status=$(agent_poll "$url")
  [ "$status" = "200" ] || fail "the rotate token's poll to $url returned HTTP $status before the revocation"
done
management POST "$FLEETS_URL/$fleet_id/tokens/$rotate_token_id/revoke" "$(jq -cn --argjson actor "$actor" '{actor: $actor}')"
[ "$status" = "200" ] && [ "$(json_field '.revokedAt | type' "$body")" = "string" ] || fail "revoking the rotate token returned HTTP $status: $body"
first_refused="" replica_refused=""
for _ in $(seq 1 15); do
  if [ -z "$first_refused" ] && [ "$(agent_poll "$OPAMP_AGENT_URL")" = "401" ]; then first_refused=yes; fi
  if [ -z "$replica_refused" ] && [ "$(agent_poll "$REPLICA_AGENT_URL")" = "401" ]; then replica_refused=yes; fi
  if [ -n "$first_refused" ] && [ -n "$replica_refused" ]; then break; fi
  sleep 1
done
[ -n "$first_refused" ] && [ -n "$replica_refused" ] ||
  fail "the revoked token wasn't refused 401 by both replicas within 15 polls (the first: ${first_refused:-no}; the second: ${replica_refused:-no})"

step "remove the collectors, the second replica, the fleet and the smoke collector's image"
remove_fleet_steps
[ -z "$fleet_cleanup_failed" ] || fail "removing the fleet's pieces failed: $fleet_cleanup_failed"

# With the fleet gone its published version is in use no longer, so the
# platform's after-response delete, which a group's assignment refused (409
# publication_in_use, logged), now succeeds.
step "delete the fleet's configuration through the gateway: its published version leaves the opamp-server"
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -b "$JAR" -X DELETE "$CONFIGURATIONS_URL/$fleet_configuration_id" \
  -H 'X-Telflo-CSRF: 1')
[ "$status" = "204" ] || fail "deleting the fleet's configuration returned HTTP $status"
stack_smoke publications "$personal_id" "$fleet_configuration_id" 0 ||
  fail "the opamp-server still holds the published version of the fleet's deleted configuration $fleet_configuration_id (above)"
fleet_configuration_id=""
fleet_publication_id=""

step "sign out: DELETE /api/v1/auth/sessions/current"
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X DELETE \
  "$GATEWAY_URL/api/v1/auth/sessions/current" -H 'X-Telflo-CSRF: 1')
[ "$status" = "204" ] || fail "sign-out returned HTTP $status"

step "after sign-out, /me is 401, even with the old cookie, and /app redirects to /login"
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$GATEWAY_URL/api/v1/auth/me")
[ "$status" = "401" ] || fail "GET /api/v1/auth/me after sign-out returned HTTP $status"
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$work_dir/signed-in-cookies" "$GATEWAY_URL/api/v1/auth/me")
[ "$status" = "401" ] || fail "the signed-out access cookie still works: HTTP $status"
read -r status location < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -b "$JAR" "$GATEWAY_URL/app")
[[ "$status" =~ ^(302|303|307)$ ]] || fail "GET /app after sign-out returned HTTP $status, not a redirect"
[[ "$location" == "$GATEWAY_URL/login"* ]] || fail "GET /app after sign-out redirected to $location, not /login"

step "request a password reset through the gateway, without the session cookies"
response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/auth/password-reset-requests" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' -d "$(jq -n --arg email "$EMAIL" '{email: $email}')")
status=$(tail -n1 <<<"$response")
[ "$status" = "202" ] || fail "password-reset-requests returned HTTP $status: $(sed '$d' <<<"$response")"

step "the API delivered the reset email to Mailpit"
# Searched by recipient and subject: the verification email to the same
# address is already there, and the reset email is sent after the response.
reset_query=$(jq -rn --arg query "to:\"$EMAIL\" subject:\"Reset your Telflo password\"" '$query | @uri')
message_id=""
for _ in $(seq 1 30); do
  message_id=$(curl -s "$MAILPIT_URL/api/v1/search?query=$reset_query" | jq -r '.messages[0].ID // empty')
  [ -n "$message_id" ] && break
  sleep 1
done
[ -n "$message_id" ] || fail "no reset email to $EMAIL arrived in Mailpit within 30s"

text=$(curl -s "$MAILPIT_URL/api/v1/message/$message_id" | jq -r '.Text')
# The token is in the link's fragment, which a browser never sends to a
# server.
link=$(grep -oE 'https?://[^[:space:]]+/reset-password#token=[A-Za-z0-9_-]+' <<<"$text" | head -n1)
[ -n "$link" ] || fail "the reset email contains no reset link with #token="
[[ "$link" == "$GATEWAY_URL/reset-password#token="* ]] ||
  fail "the reset link points at ${link%%#*}, not the gateway ($GATEWAY_URL)"

step "the token from the reset email sets a new password"
NEW_PASSWORD="another-sufficiently-long-password"
remember_secret "$NEW_PASSWORD"
token="${link##*token=}"
response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/auth/password-resets" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg token "$token" --arg password "$NEW_PASSWORD" '{token: $token, password: $password}')")
status=$(tail -n1 <<<"$response")
[ "$status" = "204" ] || fail "password-resets returned HTTP $status: $(sed '$d' <<<"$response")"

step "sign in works with the new password and not the old one"
sign_in_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/api/v1/auth/sessions" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg email "$EMAIL" --arg password "$1" '{email: $email, password: $password}')"
}
status=$(sign_in_status "$NEW_PASSWORD")
[ "$status" = "200" ] || fail "sign-in with the new password returned HTTP $status"
status=$(sign_in_status "$PASSWORD")
[ "$status" = "401" ] || fail "sign-in with the old password returned HTTP $status, not 401"

step "the API's CSRF guard is reached through the gateway: a POST without the header is 403"
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/api/v1/auth/sessions" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg email "$EMAIL" --arg password "$PASSWORD" '{email: $email, password: $password}')")
[ "$status" = "403" ] || fail "a POST without X-Telflo-CSRF returned HTTP $status"

step "with no Google settings, GET /api/v1/auth/oidc-providers lists no providers"
response=$(curl -s -w '\n%{http_code}' "$GATEWAY_URL/api/v1/auth/oidc-providers")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "GET /api/v1/auth/oidc-providers returned HTTP $status: $body"
[ "$(jq -c . <<<"$body")" = '{"providers":[]}' ] ||
  fail "GET /api/v1/auth/oidc-providers returned $body, not {\"providers\":[]} (is TELFLO_OIDC_GOOGLE_* set?)"

step "with no Google settings, GET /api/v1/auth/oidc/google is 404"
status=$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY_URL/api/v1/auth/oidc/google")
[ "$status" = "404" ] || fail "GET /api/v1/auth/oidc/google returned HTTP $status, not 404"

step "robots.txt through the gateway disallows every path, with no sitemap"
status=$(curl -s -o "$work_dir/robots.txt" -w '%{http_code}' "$GATEWAY_URL/robots.txt")
[ "$status" = "200" ] || fail "GET /robots.txt returned HTTP $status"
# Byte for byte, its newlines included.
printf 'User-agent: *\nDisallow: /\n' | cmp -s - "$work_dir/robots.txt" ||
  fail "robots.txt is not exactly 'User-agent: *' and 'Disallow: /': $(cat "$work_dir/robots.txt")"

if [ "$SMOKE_SITE" = "saas" ]; then
  # The playground, signed out: its pages render through the gateway with
  # their fixed titles, and the open read of the published flows answers from
  # the flows table (migration 026 seeds log-volume-cost-control) with no
  # session, no-store. The anonymous validate the editors call is the CLI's
  # step below ($cli_steps).
  for page in "/playground|Playground - Telflo" "/playground/editor|Playground Editor - Telflo" \
    "/public-editor|Public Editor - Telflo"; do
    page_path=${page%%|*}
    page_title=${page#*|}
    step "the playground renders through the gateway, signed out: GET $page_path"
    response=$(curl -s -w '\n%{http_code}' "$GATEWAY_URL$page_path")
    status=$(tail -n1 <<<"$response")
    body=$(sed '$d' <<<"$response")
    [ "$status" = "200" ] || fail "GET $page_path returned HTTP $status"
    grep -qF "<title>$page_title</title>" <<<"$body" || fail "GET $page_path has no <title>$page_title</title>"
  done

  PUBLISHED_FLOW_SLUG="log-volume-cost-control"
  step "GET /api/v1/published-flows, with no session, lists $PUBLISHED_FLOW_SLUG, no-store"
  headers="$work_dir/published-flows-headers"
  response=$(curl -s -D "$headers" -w '\n%{http_code}' "$GATEWAY_URL/api/v1/published-flows")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] || fail "GET /api/v1/published-flows returned HTTP $status: $(json_field '.error.code // "no error code"' "$body")"
  jq -e --arg slug "$PUBLISHED_FLOW_SLUG" '.flows | any(.slug == $slug)' <<<"$body" >/dev/null 2>&1 ||
    fail "GET /api/v1/published-flows does not list $PUBLISHED_FLOW_SLUG"
  grep -qiE '^cache-control:[[:space:]]*no-store' "$headers" ||
    fail "GET /api/v1/published-flows isn't Cache-Control: no-store"

  step "GET /api/v1/published-flows/$PUBLISHED_FLOW_SLUG, with no session, answers its YAML, no-store"
  response=$(curl -s -D "$headers" -w '\n%{http_code}' "$GATEWAY_URL/api/v1/published-flows/$PUBLISHED_FLOW_SLUG")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  [ "$status" = "200" ] ||
    fail "GET /api/v1/published-flows/$PUBLISHED_FLOW_SLUG returned HTTP $status: $(json_field '.error.code // "no error code"' "$body")"
  jq -e --arg slug "$PUBLISHED_FLOW_SLUG" '.flow.slug == $slug and (.flow.yaml | type == "string" and length > 0)' \
    <<<"$body" >/dev/null 2>&1 || fail "GET /api/v1/published-flows/$PUBLISHED_FLOW_SLUG has no non-empty .flow.yaml"
  grep -qiE '^cache-control:[[:space:]]*no-store' "$headers" ||
    fail "GET /api/v1/published-flows/$PUBLISHED_FLOW_SLUG isn't Cache-Control: no-store"

  step "GET /api/v1/published-flows/<an unknown slug> is 404 flow_not_found"
  response=$(curl -s -w '\n%{http_code}' "$GATEWAY_URL/api/v1/published-flows/no-such-flow-smoke")
  status=$(tail -n1 <<<"$response")
  body=$(sed '$d' <<<"$response")
  code=$(json_field '.error.code // empty' "$body")
  [ "$status" = "404" ] && [ "$code" = "flow_not_found" ] ||
    fail "GET /api/v1/published-flows/no-such-flow-smoke returned HTTP $status ${code:-with no error code}, not 404 flow_not_found"
  playground_steps="opened the playground, its editor and the public editor signed out (each with its title), and read the published flows with no session (the list holding $PUBLISHED_FLOW_SLUG and its YAML by slug, both no-store; an unknown slug 404 flow_not_found)"

  # The inquiry goes to TELFLO_SALES_INQUIRY_TO, which the stack's API was
  # given (required while TELFLO_SALES_INQUIRY is on; no
  # default address); the name, unique to this run and free of quotes, is in
  # the subject.
  INQUIRY_NAME="Stack smoke $(date +%s)-$$"
  SALES_INQUIRY_TO=${TELFLO_SALES_INQUIRY_TO:-}
  [ -n "$SALES_INQUIRY_TO" ] ||
    fail "TELFLO_SALES_INQUIRY_TO is empty: the smoke runs the SaaS's values (the sales inquiries on, with an address; the gates' smoke-env.sh)"
  step "a sales inquiry through the gateway: POST /api/v1/sales-inquiries from $INQUIRY_NAME"
  response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/sales-inquiries" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg name "$INQUIRY_NAME" --arg email "$EMAIL" \
      '{name: $name, email: $email, message: "We run about 80 collectors.", website: ""}')")
  status=$(tail -n1 <<<"$response")
  [ "$status" = "202" ] || fail "sales-inquiries returned HTTP $status: $(sed '$d' <<<"$response")"

  step "the API delivered the inquiry to Mailpit"
  inquiry_query=$(jq -rn \
    --arg query "to:\"$SALES_INQUIRY_TO\" subject:\"Pricing inquiry from $INQUIRY_NAME\"" '$query | @uri')
  message_id=""
  for _ in $(seq 1 30); do
    message_id=$(curl -s "$MAILPIT_URL/api/v1/search?query=$inquiry_query" | jq -r '.messages[0].ID // empty')
    [ -n "$message_id" ] && break
    sleep 1
  done
  [ -n "$message_id" ] || fail "no inquiry from $INQUIRY_NAME to $SALES_INQUIRY_TO arrived in Mailpit within 30s"
  reply_to=$(curl -s "$MAILPIT_URL/api/v1/message/$message_id" | jq -r '.ReplyTo[0].Address // empty')
  [ "$reply_to" = "$EMAIL" ] || fail "the inquiry's Reply-To is '$reply_to', not the submitter ($EMAIL)"
  inquiry_steps="delivered a sales inquiry"
else
  # The open-source defaults: the playground, the published flows' anonymous reads and the
  # sales inquiry are off, each a 404: the pages the web app's, the routes the API's
  # not_found, answered before anything else reads the request (the inquiry's limit included).
  for page_path in /playground /playground/editor /public-editor; do
    step "the playground is off (TELFLO_PLAYGROUND=false): GET $page_path through the gateway, signed out, is 404"
    status=$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY_URL$page_path")
    [ "$status" = "404" ] || fail "GET $page_path returned HTTP $status, not 404"
  done
  PUBLISHED_FLOW_SLUG="log-volume-cost-control"
  for flows_path in /api/v1/published-flows "/api/v1/published-flows/$PUBLISHED_FLOW_SLUG" /api/v1/published-flows/no-such-flow-smoke; do
    step "the published flows' anonymous reads are off (TELFLO_PUBLIC_FLOWS=false): GET $flows_path, with no session, is 404 not_found"
    response=$(curl -s -w '\n%{http_code}' "$GATEWAY_URL$flows_path")
    status=$(tail -n1 <<<"$response")
    code=$(json_field '.error.code // empty' "$(sed '$d' <<<"$response")")
    [ "$status" = "404" ] && [ "$code" = "not_found" ] ||
      fail "GET $flows_path returned HTTP $status ${code:-with no error code}, not 404 not_found"
  done
  playground_steps="found the playground, its editor and the public editor 404 and the published flows' anonymous reads 404 not_found (the open-source defaults)"

  INQUIRY_NAME="Stack smoke $(date +%s)-$$"
  step "the sales inquiries are off (TELFLO_SALES_INQUIRY=false): POST /api/v1/sales-inquiries from $INQUIRY_NAME is 404 not_found"
  response=$(curl -s -w '\n%{http_code}' -X POST "$GATEWAY_URL/api/v1/sales-inquiries" \
    -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
    -d "$(jq -n --arg name "$INQUIRY_NAME" --arg email "$EMAIL" \
      '{name: $name, email: $email, message: "We run about 80 collectors.", website: ""}')")
  status=$(tail -n1 <<<"$response")
  code=$(json_field '.error.code // empty' "$(sed '$d' <<<"$response")")
  [ "$status" = "404" ] && [ "$code" = "not_found" ] ||
    fail "sales-inquiries returned HTTP $status ${code:-with no error code}, not 404 not_found"
  inquiry_steps="found the sales inquiries off (404 not_found)"
fi

# refused_connection <role> <password> <database>: <role> logging in to
# <database> from another container must authenticate and then be refused
# for want of CONNECT. opamp-bootstrap's image is only a psql client
# here (--no-deps: the stack is up, and its one-shots aren't rerun). The
# password goes in on standard input, never a command line, and a wrong one
# would fail authentication, not with "permission denied", so the check
# can't pass by accident. (A bare `-e PGPASSWORD` would be neater, but
# Compose 2.6.0 doesn't copy its value from the environment.)
refused_connection() {
  local role=$1 password=$2 database=$3 output
  if output=$(docker compose run --rm -T --no-deps opamp-bootstrap \
    sh -c 'IFS= read -r PGPASSWORD && export PGPASSWORD &&
      exec psql -h db -U "$1" -d "$2" -X -c "select 1"' \
    refused_connection "$role" "$database" <<<"$password" 2>&1); then
    fail "$role connected to $database: $output"
  fi
  grep -qF "permission denied for database \"$database\"" <<<"$output" ||
    fail "$role's connection to $database failed, but not for want of CONNECT: $output"
}

step "telflo_platform, the platform's role, is refused the opamp-server's database"
refused_connection telflo_platform telflo-api-local telflo_opamp_server

step "telflo_opamp_server, the opamp-server's role, is refused the platform's database"
refused_connection telflo_opamp_server telflo-opamp-local telflo_platform

# The group organization's rename and delete reach the opamp-server too.
# Last, so no step above depends on the group organization.
# Both act on the active organization and need its admin, so the account,
# signed out above, signs in again and switches to it.
step "sign in again with the new password and switch to the group organization"
response=$(curl -s -w '\n%{http_code}' -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/sessions" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg email "$EMAIL" --arg password "$NEW_PASSWORD" '{email: $email, password: $password}')")
status=$(tail -n1 <<<"$response")
[ "$status" = "200" ] || fail "signing in again returned HTTP $status: $(sed '$d' <<<"$response")"
switch_to "$group_id"
[ "$(jq -r '.organization.type' <<<"$body")" = "group" ] && [ "$(jq -r '.organization.role' <<<"$body")" = "admin" ] ||
  fail "after the switch, /me is not the group organization's admin: $body"

RENAMED_ORGANIZATION_NAME="Stack smoke renamed $(date +%s)-$$"
step "rename the group organization: PATCH /api/v1/organizations/:id"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -X PATCH "$GATEWAY_URL/api/v1/organizations/$group_id" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' \
  -d "$(jq -n --arg name "$RENAMED_ORGANIZATION_NAME" '{name: $name}')")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "renaming the organization returned HTTP $status: $body"
[ "$(jq -r '.organization.id' <<<"$body")" = "$group_id" ] &&
  [ "$(jq -r '.organization.name' <<<"$body")" = "$RENAMED_ORGANIZATION_NAME" ] || fail "the rename answered $body"

step "the platform renamed the group organization in the opamp-server"
stack_smoke group-renamed "$group_id" "$RENAMED_ORGANIZATION_NAME" ||
  fail "the group organization $group_id does not have its new name in the opamp-server (above)"

# The fleet model through the platform: the platform's fleet routes, through
# the gateway, as the group organization's signed-in admin, with a real
# collector. After the fleet steps (which built the smoke collector, and the
# management API's header file) and before the group organization's delete,
# which then removes the fleet in the opamp-server. Every call goes through
# platform(): the cookie jar, X-Telflo-CSRF, the reply's headers and body each
# in a 0600 file under the work directory. A reply that carries a bearer (a
# create's, a reveal's, a rotation's) is never printed: a failure there prints
# only its error code.
# The bearers reach a collector by a bare `docker run -e`, never a command
# line. Every wait is a bounded number of polls. A run that ends inside these
# steps removes what they made (the EXIT trap: remove_managed_steps).
GROUP_ORGANIZATION_URL="$GATEWAY_URL/api/v1/organizations/$group_id"
GROUP_CONFIGURATIONS_URL="$GROUP_ORGANIZATION_URL/configurations"
GROUP_FLEETS_URL="$GROUP_ORGANIZATION_URL/fleets"
PLATFORM_REPLY_HEADERS="$work_dir/platform-reply-headers"
PLATFORM_REPLY_BODY="$work_dir/platform-reply-body"

# platform <method> <url> [<json body>]: one call to the platform through
# the gateway; its status goes into $status, its body into $body (and
# $PLATFORM_REPLY_BODY), its headers into $PLATFORM_REPLY_HEADERS, both
# files 0600. A curl that fails writes 000 and doesn't end the script, so
# the step's own check reports it.
platform() {
  local method=$1 url=$2
  local args=(-s --max-time 30 -o "$PLATFORM_REPLY_BODY" -D "$PLATFORM_REPLY_HEADERS" -w '%{http_code}' -b "$JAR"
    -X "$method" -H 'X-Telflo-CSRF: 1')
  if [ $# -ge 3 ]; then args+=(-H 'content-type: application/json' --data-binary "$3"); fi
  status=$(umask 077 && : >"$PLATFORM_REPLY_BODY" && curl "${args[@]}" "$url" || true)
  body=$(cat "$PLATFORM_REPLY_BODY")
}
# Whether the last reply told every cache to keep no copy.
no_store() { grep -qiE '^cache-control:[[:space:]]*no-store' "$PLATFORM_REPLY_HEADERS"; }
# jq's answer (raw) of the last reply's body, with jq's own arguments (`--arg …`, the filter), or "" when it isn't JSON.
# Read from the 0600 file: a reply carrying a bearer never goes through a here-string (a temporary file of bash's own).
reply_json() { jq -r "$@" "$PLATFORM_REPLY_BODY" 2>/dev/null || true; }
# The last reply's error code, the only thing a bearer reply's failure prints.
reply_code() {
  local code
  code=$(reply_json '.error.code // empty')
  echo "${code:-no error code}"
}
# Whether the last reply's body holds the text $1 (a bearer), without printing either: the file read
# and the match are bash's own ($(<file), [[ == ]]), so the bearer is in no command's argv (ps). A reply file
# that isn't there or can't be read counts as holding it: every caller's guard then fails
# closed. It is opened first (`true <file`, a regular builtin) so a failed read never meets errexit: bash 5.2
# exits on a failed $(<file) even inside `||`.
reply_holds() {
  local reply
  { [ -f "$PLATFORM_REPLY_BODY" ] && true <"$PLATFORM_REPLY_BODY"; } 2>/dev/null || return 0
  reply=$(<"$PLATFORM_REPLY_BODY")
  [[ "$reply" == *"$1"* ]]
}

MANAGED_YAML=$'# Published by the stack smoke test, managed through the platform\nreceivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 127.0.0.1:4320\nprocessors:\n  batch: {}\nexporters:\n  debug:\n    verbosity: basic\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [debug]\n'
MANAGED_CONFIGURATION_NAME="Stack smoke managed $(date +%s)-$$"
step "publish a configuration in the group organization through the gateway: create it, save its YAML and publish version 1"
platform POST "$GROUP_CONFIGURATIONS_URL" "$(jq -cn --arg name "$MANAGED_CONFIGURATION_NAME" \
  '{name: $name, description: "The stack smoke test fleet'"'"'s configuration, managed through the platform"}')"
[ "$status" = "201" ] || fail "creating the managed configuration returned HTTP $status: $(head -c 500 <<<"$body")"
managed_configuration_id=$(json_field '.configuration.id' "$body")
[ -n "$managed_configuration_id" ] && [ "$managed_configuration_id" != "null" ] || fail "the managed configuration has no id: $body"
platform GET "$GROUP_CONFIGURATIONS_URL/$managed_configuration_id"
[ "$status" = "200" ] || fail "reading the managed configuration returned HTTP $status: $(head -c 500 <<<"$body")"
managed_version_id=$(json_field '.version.id' "$body")
platform PATCH "$GROUP_CONFIGURATIONS_URL/$managed_configuration_id/versions/$managed_version_id" \
  "$(jq -cn --arg yaml "$MANAGED_YAML" '{yamlContent: $yaml, nodes: [], edges: [], pipelines: []}')"
[ "$status" = "200" ] || fail "saving the managed configuration returned HTTP $status: $(head -c 500 <<<"$body")"
platform POST "$GROUP_CONFIGURATIONS_URL/$managed_configuration_id/versions/$managed_version_id/publish"
[ "$status" = "200" ] && [ "$(json_field '.version.publishedAt | type' "$body")" = "string" ] ||
  fail "publishing the managed configuration returned HTTP $status: $(head -c 500 <<<"$body")"
managed_yaml_sha256=$(jq -j -n --arg yaml "$MANAGED_YAML" '$yaml' | sha256_of)

step "list the configuration's published versions: GET .../configurations/:configurationId/versions?filter=published answers exactly version 1, its id, number, label and published date only"
platform GET "$GROUP_CONFIGURATIONS_URL/$managed_configuration_id/versions?filter=published"
[ "$status" = "200" ] || fail "listing the managed configuration's published versions returned HTTP $status: $(reply_code)"
[ "$(reply_json --arg id "$managed_version_id" '(.versions | length) == 1 and .versions[0].id == $id and .versions[0].versionNumber == 1 and (.versions[0].publishedAt | type) == "string"')" = "true" ] ||
  fail "the managed configuration's published versions aren't exactly its version 1: $(reply_json -c '[.versions[]? | {id, versionNumber, publishedAt}]')"
[ "$(reply_json '[.versions[] | keys == ["id", "label", "publishedAt", "versionNumber"]] | all')" = "true" ] ||
  fail "the managed configuration's versions' list carries more than each version's id, number, label and published date: $(reply_json -c '[.versions[]? | keys]')"

# The id a browser chooses for a safe retry: a random UUID v4,
# from /dev/urandom so neither uuidgen nor a GNU date is needed. Recorded
# before the create, so a create whose reply is lost is still removed.
managed_hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
managed_fleet_id="${managed_hex:0:8}-${managed_hex:8:4}-4${managed_hex:13:3}-$(printf '%x' $(((0x${managed_hex:16:2} & 0x3f) | 0x80)))${managed_hex:18:2}-${managed_hex:20:12}"
[[ "$managed_fleet_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "couldn't make a UUID for the fleet: $managed_fleet_id"
MANAGED_FLEET_LABEL="stack-smoke-managed-$(date +%s)-$$"
managed_create_body=$(jq -cn --arg id "$managed_fleet_id" --arg label "$MANAGED_FLEET_LABEL" \
  '{id: $id, label: $label, type: "server", rotateExpiresAt: null}')
step "create a fleet through the platform with the browser's id: POST .../fleets answers 201, no-store, its Default group and both tokens' bearers"
platform POST "$GROUP_FLEETS_URL" "$managed_create_body"
[ "$status" = "201" ] || fail "creating the fleet through the platform returned HTTP $status: $(reply_code)"
no_store || fail "the fleet's creation, carrying its bearers, isn't Cache-Control: no-store"
[ "$(reply_json '.fleet.id')" = "$managed_fleet_id" ] && [ "$(reply_json '.fleet.label')" = "$MANAGED_FLEET_LABEL" ] &&
  [ "$(reply_json '.defaultGroup.isDefault')" = "true" ] ||
  fail "the fleet's creation didn't answer the fleet $managed_fleet_id with its Default group"
managed_default_group_id=$(reply_json '.defaultGroup.id')
managed_default_token_id=$(reply_json '.tokens.default.id')
managed_rotate_token_id=$(reply_json '.tokens.rotate.id')
managed_default_bearer=$(reply_json '.tokens.default.bearer')
managed_rotate_bearer=$(reply_json '.tokens.rotate.bearer')
for value in "$managed_default_group_id" "$managed_default_token_id" "$managed_rotate_token_id" "$managed_default_bearer" "$managed_rotate_bearer"; do
  [ -n "$value" ] && [ "$value" != "null" ] || fail "the fleet's creation answered no Default group, token or bearer"
done
body=""

step "create it again with the same id, label and type: 200, no-store, the fleet without bearers"
platform POST "$GROUP_FLEETS_URL" "$managed_create_body"
[ "$status" = "200" ] || fail "creating the fleet again returned HTTP $status: $(reply_code)"
no_store || fail "the fleet's creation again isn't Cache-Control: no-store"
[ "$(reply_json '.fleet.id')" = "$managed_fleet_id" ] && [ "$(reply_json 'has("tokens") or has("defaultGroup")')" = "false" ] ||
  fail "creating the fleet again didn't answer the fleet alone: $(reply_json -c '{fleet: .fleet.id, keys: keys}')"
if reply_holds "$managed_default_bearer" || reply_holds "$managed_rotate_bearer" || reply_holds '"bearer"'; then
  fail "creating the fleet again answered a bearer"
fi

step "list the organization's fleets and read the fleet: GET .../fleets and GET .../fleets/:fleetId"
platform GET "$GROUP_FLEETS_URL"
[ "$status" = "200" ] && [ "$(reply_json --arg id "$managed_fleet_id" 'any(.fleets[]; .id == $id)')" = "true" ] ||
  fail "the fleets' list (HTTP $status) doesn't hold the fleet $managed_fleet_id: $(head -c 500 <<<"$body")"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id"
[ "$status" = "200" ] && [ "$(json_field '.fleet.label' "$body")" = "$MANAGED_FLEET_LABEL" ] &&
  [ "$(json_field '.fleet.type' "$body")" = "server" ] && [ "$(json_field '.fleet.summary.collectors' "$body")" = "0" ] ||
  fail "reading the fleet returned HTTP $status: $(head -c 500 <<<"$body")"

# The summary's last seen and rotate token, from the read above: no collector
# yet, and the create's one rotate token, valid and never expiring, with no
# grace.
step "the new fleet's summary answers no last seen and one valid rotate token that never expires, in no grace"
[ "$(reply_json '.fleet.summary.lastSeenAt == null and .fleet.summary.rotateToken == {expiresAt: null, graceEndsAt: null, validCount: 1}')" = "true" ] ||
  fail "the new fleet's summary isn't unseen with one rotate token: $(reply_json -c '.fleet.summary | {lastSeenAt, rotateToken}')"

# Assigned before any collector starts. The browser names the version; the
# platform resolves its published copy and answers the configuration and
# version beside it.
step "assign the published version to the Default group by its version id: PATCH .../groups/:groupId answers its configuration and version"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_default_group_id" \
  "$(jq -cn --arg id "$managed_version_id" '{assignedVersionId: $id}')"
[ "$status" = "200" ] || fail "assigning the managed configuration's version returned HTTP $status: $(head -c 500 <<<"$body")"
[ "$(json_compact '.group.assignedVersion | {configurationId, configurationName, versionId, versionNumber}' "$body")" = \
  "$(jq -cn --arg c "$managed_configuration_id" --arg n "$MANAGED_CONFIGURATION_NAME" --arg v "$managed_version_id" \
    '{configurationId: $c, configurationName: $n, versionId: $v, versionNumber: 1}')" ] ||
  fail "the assignment isn't answered with the managed configuration's version 1 beside it: $(json_compact '.group' "$body")"
managed_publication_id=$(json_field '.group.assignedPublishedVersionId' "$body")
[[ "$managed_publication_id" =~ ^[0-9a-f-]{36}$ ]] || fail "the assignment names no published version: $(json_compact '.group' "$body")"

# A collector of this block: a container of its own on the compose network,
# named <project>-<name>, built from the smoke collector's image again
# (the fleet steps removed theirs).
step "build the smoke collector again for the platform fleet steps: docker/smoke-collector"
managed_image="telflo-smoke-collector:$compose_project-managed-$$"
if ! output=$(docker build -q --build-arg "VALIDATOR_IMAGE=$validator_image" -t "$managed_image" \
  "$(dirname "$0")/../docker/smoke-collector" 2>&1); then
  managed_image=""
  fail "building the smoke collector failed: $output"
fi
# managed_start_collector <name> <bearer> <group id>: as start_collector, on
# this stack's agent URL; the group required likewise.
managed_start_collector() {
  local container="$compose_project-$1"
  [ -n "$3" ] || fail "managed_start_collector $1: no group id (the opamp-server refuses a collector naming no group)"
  managed_containers="$managed_containers $container"
  TELFLO_COLLECTOR_NAME=$1 TELFLO_OPAMP_ENDPOINT=$server_url TELFLO_OPAMP_BEARER=$2 TELFLO_COLLECTOR_GROUP_ID=$3 \
    docker run -d --name "$container" --network "$compose_network" \
    -e TELFLO_COLLECTOR_NAME -e TELFLO_OPAMP_ENDPOINT -e TELFLO_OPAMP_BEARER -e TELFLO_COLLECTOR_GROUP_ID \
    "$managed_image" >/dev/null || fail "starting the collector $1 failed"
}

# redact_secrets: its standard input for a failure's message, every tqd_… (a
# quick-deploy link's secret), every tf_… (an API token) and every run of
# 100 or more base64 characters (a bearer's shape) replaced.
redact_secrets() {
  LC_ALL=C sed -E -e 's#tqd_[A-Za-z0-9_-]+#[redacted]#g' -e 's#tf_[A-Za-z0-9_-]+#[redacted]#g' \
    -e 's#[A-Za-z0-9+/]{100,}#[a long base64 run, redacted]#g'
}
# wait_for_managed_collector <name> <polls> <jq condition> [<container>] [<redaction>]:
# reads the fleet's collector of that name through the platform's collector
# list (searched by `q`), once a second, until the condition holds of it;
# $collector holds it. The reply that satisfies it must be no-store. When it
# never holds, <container>'s last 50 lines of output are printed before the
# failure, and the collector last read in it, both through <redaction> (a
# function filtering its standard input; redact_secrets when none is given;
# the quick-deploy steps pass qd_diagnostic: whole when it holds no secret,
# else redacted).
wait_for_managed_collector() {
  local name=$1 polls=$2 condition=$3 logs_of=${4:-} redaction=${5:-redact_secrets}
  collector=""
  for _ in $(seq 1 "$polls"); do
    platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors?q=$name"
    if [ "$status" = "200" ]; then
      collector=$(jq -c --arg name "$name" '[.collectors[] | select(.name == $name)][0] // empty' <<<"$body" 2>/dev/null || true)
      if [ -n "$collector" ] && [ "$(jq -r "$condition" <<<"$collector")" = "true" ]; then
        no_store || fail "the collector list, carrying reported attributes and error text, isn't Cache-Control: no-store"
        return 0
      fi
    fi
    sleep 1
  done
  # The container's output, never its environment (which holds the token). Its scripts never print the token
  # (start_supervisor.sh writes it into 0600 files and unsets it before anything runs); it is redacted all the
  # same, and so is the collector printed.
  if [ -n "$logs_of" ]; then
    echo "--- the last 50 lines of $logs_of's output:" >&2
    { docker logs --tail 50 "$logs_of" 2>&1 | "$redaction"; } >&2 || true
  fi
  fail "the collector $name didn't reach the state wanted through the platform within $polls polls (last HTTP $status): $(printf '%s\n' "${collector:-not listed}" | "$redaction")"
}

step "start edge-b1 with the platform's default bearer, in the Default group"
managed_start_collector edge-b1 "$managed_default_bearer" "$managed_default_group_id"

step "create the group \"unassigned-b\" with nothing assigned through the platform: POST .../groups, and start edge-b2 in it"
platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/groups" '{"name": "unassigned-b"}'
[ "$status" = "201" ] && [ "$(json_field '.group.isDefault' "$body")" = "false" ] && [ "$(json_field '.group.assignedVersion' "$body")" = "null" ] ||
  fail "creating the group returned HTTP $status: $(head -c 500 <<<"$body")"
managed_unassigned_group_id=$(json_field '.group.id' "$body")
managed_start_collector edge-b2 "$managed_default_bearer" "$managed_unassigned_group_id"

step "edge-b1, read through the platform, holds the rotate token and applies the published version: its SHA-256, in sync, the served version named (at most 60 polls)"
wait_for_managed_collector edge-b1 60 "(.enrollmentTokenId == \"$managed_rotate_token_id\") and (.groupId == \"$managed_default_group_id\") and (.effective.status == \"applied\") and (.effective.sha256 == \"$managed_yaml_sha256\") and (.drift == \"inSync\") and (.served.kind == \"version\") and (.served.publishedVersionId == \"$managed_publication_id\") and (.served.version.versionId == \"$managed_version_id\") and (.served.version.configurationId == \"$managed_configuration_id\")"

step "read edge-b1 alone and its error history through the platform: GET .../collectors/:collectorId and .../errors, each no-store"
managed_edge_b1_id=$(jq -r '.id' <<<"$collector")
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$managed_edge_b1_id"
[ "$status" = "200" ] && [ "$(reply_json '.collector.id')" = "$managed_edge_b1_id" ] ||
  fail "reading edge-b1 through the platform returned HTTP $status: $(reply_code)"
no_store || fail "a collector's read, carrying its reported attributes and error text, isn't Cache-Control: no-store"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$managed_edge_b1_id/errors"
[ "$status" = "200" ] && [ "$(reply_json '.errors | type')" = "array" ] ||
  fail "reading edge-b1's error history through the platform returned HTTP $status: $(reply_code)"
no_store || fail "a collector's error history, carrying its error text, isn't Cache-Control: no-store"

# The fleet's last seen is its collectors' latest: a time
# of the last 5 minutes by jq's clock (the reply's milliseconds dropped for
# fromdateiso8601), once edge-b1 polls. Read until it is, a second apart,
# then the list must agree.
step "the fleet's summary answers a last seen of the last 5 minutes, in its read and the list (at most 10 polls)"
managed_seen=""
for _ in $(seq 1 10); do
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id"
  if [ "$status" = "200" ] &&
    [ "$(reply_json '.fleet.summary.lastSeenAt | if type == "string" then (sub("\\.[0-9]{3}Z$"; "Z") | fromdateiso8601) as $t | ($t > now - 300 and $t < now + 60) else false end')" = "true" ]; then
    managed_seen=yes
    break
  fi
  sleep 1
done
[ -n "$managed_seen" ] ||
  fail "the fleet's summary (last HTTP $status) didn't answer a last seen of the last 5 minutes within 10 polls: $(reply_json -c '.fleet.summary.lastSeenAt')"
platform GET "$GROUP_FLEETS_URL"
[ "$status" = "200" ] && [ "$(reply_json --arg id "$managed_fleet_id" '[.fleets[] | select(.id == $id) | .summary.lastSeenAt | type] == ["string"]')" = "true" ] ||
  fail "the fleets' list (HTTP $status) doesn't answer the fleet's last seen: $(reply_json -c --arg id "$managed_fleet_id" '[.fleets[] | select(.id == $id) | .summary.lastSeenAt]')"

step "edge-b2, with nothing assigned, is unassigned and sent no configuration, read through the platform; its former imports path answers 404 not_found (at most 60 polls)"
wait_for_managed_collector edge-b2 60 "(.pin == null) and (.resolution == null) and (.served == null) and (.drift == \"unassigned\") and (.groupId == \"$managed_unassigned_group_id\") and (.enrollmentTokenId == \"$managed_rotate_token_id\")"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/imports"
[ "$status" = "404" ] && [ "$(reply_code)" = "not_found" ] ||
  fail "the platform's former imports path returned HTTP $status: $(head -c 500 <<<"$body")"

# A pin through the platform: edge-b2 is pinned to the
# published version, applies it as its pin's (in sync), and is unpinned
# before the configuration's in-use and delete steps below, so only the
# Default group's assignment uses the version there.
step "pin edge-b2 to the published version through the platform: PATCH .../collectors/:collectorId with a version pin answers it pinned, no-store"
managed_edge_b2_id=$(jq -r '.id' <<<"$collector")
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$managed_edge_b2_id" \
  "$(jq -cn --arg id "$managed_version_id" '{pin: {kind: "version", versionId: $id}}')"
[ "$status" = "200" ] && [ "$(reply_json '.collector.pin.kind')" = "version" ] &&
  [ "$(reply_json '.collector.pin.versionId')" = "$managed_version_id" ] &&
  [ "$(reply_json '.collector.pin.publishedVersionId')" = "$managed_publication_id" ] ||
  fail "pinning edge-b2 returned HTTP $status: $(reply_json -c 'if .collector then (.collector | {pin, resolution, served, drift}) else .error end')"
no_store || fail "a collector's pin's reply, carrying its reported attributes and error text, isn't Cache-Control: no-store"

step "edge-b2, read through the platform, applies its pinned version: resolved from its pin, its SHA-256, in sync, the served version named (at most 60 polls)"
wait_for_managed_collector edge-b2 60 "(.pin.kind == \"version\") and (.pin.versionId == \"$managed_version_id\") and (.resolution.from == \"pinnedVersion\") and (.resolution.publishedVersionId == \"$managed_publication_id\") and (.effective.status == \"applied\") and (.effective.sha256 == \"$managed_yaml_sha256\") and (.drift == \"inSync\") and (.served.publishedVersionId == \"$managed_publication_id\") and (.groupId == \"$managed_unassigned_group_id\")"

step "unpin edge-b2 through the platform: PATCH .../collectors/:collectorId with pin null answers it unpinned and unassigned, still served the version it was sent"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$managed_edge_b2_id" '{"pin": null}'
[ "$status" = "200" ] && [ "$(reply_json '.collector.pin')" = "null" ] && [ "$(reply_json '.collector.resolution')" = "null" ] &&
  [ "$(reply_json '.collector.drift')" = "unassigned" ] && [ "$(reply_json '.collector.served.publishedVersionId')" = "$managed_publication_id" ] ||
  fail "unpinning edge-b2 returned HTTP $status: $(reply_json -c 'if .collector then (.collector | {pin, resolution, served, drift}) else .error end')"

# Organization variables reaching a real supervisor: on edge-b2 in
# "unassigned-b", never the Default group, whose assignment the steps below
# rely on. Through the platform, as the group organization's signed-in admin:
# a variable SMOKE_TAG (a$b-1) and one the text doesn't use; a configuration
# of this block's own whose processor attributes/variable inserts an attribute of
# the value ${org:SMOKE_TAG}, assigned to "unassigned-b"; edge-b2 applies the
# text filled in, every `$` of the value doubled (`a$$b-1`, which the
# collector's own pass reads as a$b-1), its SHA-256 computed here
# (variable_filled_in_sha256) and never the published text's. Each change of
# what it uses (the value, a variable group bound to its group, one pinned on
# it) is a push (served.at moves) of that level's value, in sync again; a
# change of the unused variable is none: served.at stays while edge-b2 polls
# three times (its lastSeenAt moving), in sync throughout. SMOKE_TAG's delete
# is refused while the version is assigned (409 variable_in_use, naming the
# version and its group, with the totals). The block ends as it found
# "unassigned-b": nothing assigned, no variable group, edge-b2 unpinned; then
# its variable groups, variables and configuration are deleted. A run that
# ends among these steps removes them (the EXIT trap: remove_variable_steps,
# after the fleet's removal, so nothing uses them any more; the published
# version, recorded once the publish answers, through the management API).
VARIABLES_URL="$GROUP_ORGANIZATION_URL/variables"
VARIABLE_GROUPS_URL="$GROUP_ORGANIZATION_URL/variable-groups"
VARIABLE_YAML=$'# Published by the stack smoke test, filled in with an organization variable\nreceivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 127.0.0.1:4321\nprocessors:\n  attributes/variable:\n    actions:\n      - key: telflo.smoke.tag\n        value: ${org:SMOKE_TAG}\n        action: insert\n  batch: {}\nexporters:\n  debug:\n    verbosity: basic\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [attributes/variable, batch]\n      exporters: [debug]\n'
VARIABLE_CONFIGURATION_NAME="Stack smoke variable $(date +%s)-$$"
# The values each level gives SMOKE_TAG: the organization's, then its new
# one, the collector group's variable group's and the pinned one's.
VARIABLE_VALUE='a$b-1'
VARIABLE_NEW_VALUE='a$b-2'
VARIABLE_GROUP_VALUE='a$b-group'
VARIABLE_PIN_VALUE='a$b-pin'

# variable_uuid: a random UUID v4, as the fleet's id above (the browser's own
# id for a create, which makes a retry safe).
variable_uuid() {
  local hex
  hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s-%s-4%s-%x%s-%s\n' "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" $(((0x${hex:16:2} & 0x3f) | 0x80)) "${hex:18:2}" "${hex:20:12}"
}
# variable_filled_in <value>: VARIABLE_YAML filled in as the opamp-server's poll
# fills it in (orgvariables.Render): its one live reference replaced by the
# value, every `$` of it doubled, the bytes around it as published.
# Printed with no newline added (jq -j).
variable_filled_in() {
  jq -j -n --arg yaml "$VARIABLE_YAML" --arg value "$1" '$yaml | split("${org:SMOKE_TAG}") | join($value | split("$") | join("$$"))'
}
# variable_filled_in_sha256 <value>: the SHA-256 the collector applies.
variable_filled_in_sha256() { variable_filled_in "$1" | sha256_of; }
# variable_create <url> <list> <jq filter> [<jq arguments>...]: a create under
# an id of the script's, its body the filter's output (the id as $id), the id
# recorded first in the trap's list named <list> (variable_ids or
# variable_group_ids), so a create whose reply is lost is still removed; 201,
# no-store. $created_id holds the id.
variable_create() {
  local url=$1 list=$2 filter=$3
  shift 3
  created_id=$(variable_uuid)
  [[ "$created_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "couldn't make a UUID: $created_id"
  printf -v "$list" '%s %s' "${!list}" "$created_id"
  platform POST "$url" "$(jq -cn --arg id "$created_id" "$@" "$filter")"
  [ "$status" = "201" ] || fail "the create at ${url##*/} returned HTTP $status: $(reply_code)"
  no_store || fail "the create at ${url##*/}, carrying configuration text, isn't Cache-Control: no-store"
}
# variable_forget <list> <id>: the id removed from the trap's list once deleted.
variable_forget() {
  local kept="" id
  for id in ${!1}; do [ "$id" = "$2" ] || kept="$kept $id"; done
  printf -v "$1" '%s' "$kept"
}
# variable_wait_for_push <step's words> <value> <jq condition>: edge-b2,
# read through the platform's collector list, applies its group's assigned
# version filled in with <value>, in sync, sent anew since
# $variable_served_at (served.at moved), and the condition holds of it
# besides; then $variable_served_at is its new served.at. At most 60 polls
# (its heartbeat is 30 s).
variable_wait_for_push() {
  local sha
  sha=$(variable_filled_in_sha256 "$2")
  [ "$sha" != "$variable_published_sha256" ] || fail "the text filled in with $1's value is the published text"
  wait_for_managed_collector edge-b2 60 "(.groupId == \"$managed_unassigned_group_id\") and (.pin == null) and (.resolution.from == \"groupVersion\") and (.resolution.publishedVersionId == \"$variable_publication_id\") and (.resolution.sha256 == \"$variable_published_sha256\") and (.served.publishedVersionId == \"$variable_publication_id\") and (.served.sha256 == \"$sha\") and ((.served.at | type) == \"string\") and (.served.at > \"$variable_served_at\") and (.effective.status == \"applied\") and (.effective.sha256 == \"$sha\") and (.drift == \"inSync\") and ($3)"
  variable_served_at=$(jq -r '.served.at' <<<"$collector")
  variable_sha256=$sha
}

step "create the organization variables SMOKE_TAG = $VARIABLE_VALUE and SMOKE_UNUSED through the platform: POST .../variables answers each 201, no-store, as sent"
variable_create "$VARIABLES_URL" variable_ids '{id: $id, name: "SMOKE_TAG", value: $value, description: null}' --arg value "$VARIABLE_VALUE"
smoke_tag_id=$created_id
[ "$(reply_json --arg id "$smoke_tag_id" --arg value "$VARIABLE_VALUE" '.variable | .id == $id and .name == "SMOKE_TAG" and .value == $value and .description == null')" = "true" ] ||
  fail "SMOKE_TAG's create didn't answer it as sent: $(reply_json -c '.variable | {id, name, value, description}' | redact_secrets)"
variable_create "$VARIABLES_URL" variable_ids '{id: $id, name: "SMOKE_UNUSED", value: "unused-1", description: null}'
smoke_unused_id=$created_id
[ "$(reply_json --arg id "$smoke_unused_id" '.variable | .id == $id and .name == "SMOKE_UNUSED" and .value == "unused-1"')" = "true" ] ||
  fail "SMOKE_UNUSED's create didn't answer it as sent: $(reply_json -c '.variable | {id, name, value, description}' | redact_secrets)"

step "publish a configuration of its own whose attributes/variable inserts \${org:SMOKE_TAG}: create it, save it and publish version 1"
platform POST "$GROUP_CONFIGURATIONS_URL" "$(jq -cn --arg name "$VARIABLE_CONFIGURATION_NAME" \
  '{name: $name, description: "The stack smoke test'"'"'s configuration filled in with an organization variable"}')"
[ "$status" = "201" ] || fail "creating the variable configuration returned HTTP $status: $(reply_code)"
variable_configuration_id=$(reply_json '.configuration.id')
[[ "$variable_configuration_id" =~ ^[0-9a-f-]{36}$ ]] || fail "the variable configuration has no id: $(reply_json -c '.configuration | {id}')"
platform GET "$GROUP_CONFIGURATIONS_URL/$variable_configuration_id"
[ "$status" = "200" ] || fail "reading the variable configuration returned HTTP $status: $(reply_code)"
variable_version_id=$(reply_json '.version.id')
platform PATCH "$GROUP_CONFIGURATIONS_URL/$variable_configuration_id/versions/$variable_version_id" \
  "$(jq -cn --arg yaml "$VARIABLE_YAML" '{yamlContent: $yaml, nodes: [], edges: [], pipelines: []}')"
[ "$status" = "200" ] || fail "saving the variable configuration returned HTTP $status: $(reply_code)"
platform POST "$GROUP_CONFIGURATIONS_URL/$variable_configuration_id/versions/$variable_version_id/publish"
[ "$status" = "200" ] && [ "$(reply_json '.version.publishedAt | type')" = "string" ] ||
  fail "publishing the variable configuration returned HTTP $status: $(reply_code)"
# Its published version, recorded as soon as the publish answers, so a run
# that ends before the assignment still removes it (the EXIT trap): the
# configuration's one publication in the opamp-server, holding the text
# saved.
management GET "$OPAMP_MANAGEMENT_URL/api/v1/organizations/$group_id/publications?configurationId=$variable_configuration_id"
[ "$status" = "200" ] || fail "listing the variable configuration's publications returned HTTP $status: $(json_field '.error.code // "no error code"' "$body")"
variable_publication_id=$(json_field '.publications[0].id' "$body")
[ "$(json_field '.publications | length' "$body")" = "1" ] && [[ "$variable_publication_id" =~ ^[0-9a-f-]{36}$ ]] &&
  [ "$(json_field '.publications[0].sha256' "$body")" = "$(jq -j -n --arg yaml "$VARIABLE_YAML" '$yaml' | sha256_of)" ] ||
  fail "the opamp-server doesn't hold the one published version of the variable configuration, with the text saved: $(json_compact '[.publications[]? | {id, sha256}]' "$body")"
# The published text's SHA-256 (the resolution's: the opamp-server keeps the
# text as published), and this script's own fill-in checked against the
# bytes it must give: the value with its `$` doubled where the reference
# was, and nothing else changed.
variable_published_sha256=$(jq -j -n --arg yaml "$VARIABLE_YAML" '$yaml' | sha256_of)
variable_reference='${org:SMOKE_TAG}'
variable_expected="${VARIABLE_YAML%%"$variable_reference"*}"'a$$b-1'"${VARIABLE_YAML#*"$variable_reference"}"
[ "$(variable_filled_in_sha256 "$VARIABLE_VALUE")" = "$(printf '%s' "$variable_expected" | sha256_of)" ] ||
  fail "the script's fill-in (variable_filled_in) doesn't write $VARIABLE_VALUE as a\$\$b-1 in place of \${org:SMOKE_TAG}"

step "assign it to \"unassigned-b\" by its version id: PATCH .../groups/:groupId answers its configuration and version"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_unassigned_group_id" \
  "$(jq -cn --arg id "$variable_version_id" '{assignedVersionId: $id}')"
[ "$status" = "200" ] &&
  [ "$(reply_json --arg c "$variable_configuration_id" --arg v "$variable_version_id" '.group.assignedVersion | .configurationId == $c and .versionId == $v and .versionNumber == 1')" = "true" ] &&
  [ "$(reply_json '.group.variableGroupId')" = "null" ] ||
  fail "assigning the variable configuration's version returned HTTP $status: $(reply_json -c 'if .group then (.group | {assignedPublishedVersionId, variableGroupId}) else .error end' | redact_secrets)"
[ "$(reply_json '.group.assignedPublishedVersionId')" = "$variable_publication_id" ] ||
  fail "the variable configuration's assignment doesn't name its published version $variable_publication_id: $(reply_json -c '.group.assignedPublishedVersionId')"

step "edge-b2 applies the text filled in with $VARIABLE_VALUE (\$ doubled), by its SHA-256, in sync, the resolution's the published text's (at most 60 polls)"
# Before this push edge-b2 was served the Default group's published version: any served time counts.
variable_served_at=""
variable_wait_for_push "SMOKE_TAG" "$VARIABLE_VALUE" "(.pinnedVariableGroupId == null)"

step "change SMOKE_TAG's value to $VARIABLE_NEW_VALUE: PATCH .../variables/:variableId answers it, no-store; edge-b2 is sent the text again (served.at moves), its new SHA-256, in sync (at most 60 polls)"
platform PATCH "$VARIABLES_URL/$smoke_tag_id" "$(jq -cn --arg value "$VARIABLE_NEW_VALUE" '{value: $value}')"
[ "$status" = "200" ] && [ "$(reply_json --arg value "$VARIABLE_NEW_VALUE" '.variable.value == $value and .variable.name == "SMOKE_TAG"')" = "true" ] ||
  fail "changing SMOKE_TAG's value returned HTTP $status: $(reply_code)"
no_store || fail "a variable's update, carrying its value, isn't Cache-Control: no-store"
variable_wait_for_push "SMOKE_TAG's new" "$VARIABLE_NEW_VALUE" "(.pinnedVariableGroupId == null)"

# A poll is counted by edge-b2's lastSeenAt moving (each 30 s heartbeat
# moves it), from its read after the change: of three moves, at least two
# are polls made wholly after it.
# A push follows the bytes (handlers/poll.go): an unchanged text is never
# sent again whatever the marker says, so it is the in-sync read at every
# read, from the first after the change, that holds the marker to the
# names the text uses.
step "change SMOKE_UNUSED, which the text doesn't use: edge-b2 is sent nothing (served.at and its SHA-256 as they were) and reads in sync at every read while its lastSeenAt moves 3 times (at most 180 reads)"
platform PATCH "$VARIABLES_URL/$smoke_unused_id" '{"value": "unused-2"}'
[ "$status" = "200" ] && [ "$(reply_json '.variable.value')" = "unused-2" ] ||
  fail "changing SMOKE_UNUSED's value returned HTTP $status: $(reply_code)"
no_store || fail "SMOKE_UNUSED's update, carrying its value, isn't Cache-Control: no-store"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$managed_edge_b2_id"
variable_seen=$(reply_json '.collector.lastSeenAt')
[ "$status" = "200" ] && [ -n "$variable_seen" ] && [ "$variable_seen" != "null" ] ||
  fail "reading edge-b2 after SMOKE_UNUSED's change returned HTTP $status: $(reply_code)"
variable_moves=0
for _ in $(seq 1 180); do
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$managed_edge_b2_id"
  [ "$status" = "200" ] || fail "reading edge-b2 while it polls returned HTTP $status: $(reply_code)"
  [ "$(reply_json --arg at "$variable_served_at" --arg sha "$variable_sha256" \
    '.collector | .served.at == $at and .served.sha256 == $sha and .effective.sha256 == $sha and .drift == "inSync"')" = "true" ] ||
    fail "after SMOKE_UNUSED's change, edge-b2 was sent its text again or read out of sync: $(reply_json -c '.collector | {served: (.served | {sha256, at}), effective: (.effective | {sha256, status}), drift, lastSeenAt}' | redact_secrets)"
  variable_now_seen=$(reply_json '.collector.lastSeenAt')
  if [ "$variable_now_seen" != "$variable_seen" ]; then
    variable_moves=$((variable_moves + 1))
    variable_seen=$variable_now_seen
  fi
  [ "$variable_moves" -lt 3 ] || break
  sleep 1
done
[ "$variable_moves" -ge 3 ] || fail "edge-b2's lastSeenAt moved $variable_moves times, not 3, within 180 reads"

step "SMOKE_TAG's delete is refused while its version is assigned: DELETE .../variables/:variableId answers 409 variable_in_use naming the version and \"unassigned-b\", with the totals, and neither the variable's name nor its value"
platform DELETE "$VARIABLES_URL/$smoke_tag_id"
[ "$status" = "409" ] && [ "$(reply_code)" = "variable_in_use" ] ||
  fail "deleting SMOKE_TAG while it is used returned HTTP $status: $(reply_code)"
[ "$(reply_json --arg p "$variable_publication_id" --arg c "$variable_configuration_id" --arg n "$VARIABLE_CONFIGURATION_NAME" \
  --arg v "$variable_version_id" --arg f "$managed_fleet_id" --arg l "$MANAGED_FLEET_LABEL" --arg g "$managed_unassigned_group_id" \
  '.error.details == {usedBy: [{publishedVersionId: $p, configurationId: $c, configurationName: $n, versionId: $v, versionNumber: 1,
    groups: [{fleetId: $f, fleetLabel: $l, groupId: $g, groupName: "unassigned-b"}], pinnedCollectors: 0}],
    totalPublications: 1, totalGroups: 1, totalPinnedCollectors: 0}')" = "true" ] ||
  fail "SMOKE_TAG's refusal doesn't name exactly the variable configuration's version and \"unassigned-b\" with the totals: $(reply_json -c '.error.details' | redact_secrets)"
if reply_holds "SMOKE_TAG" || reply_holds "$VARIABLE_NEW_VALUE"; then
  fail "SMOKE_TAG's refusal holds the variable's name or value (its message is fixed, its details ids and the platform's names)"
fi
platform GET "$VARIABLES_URL"
[ "$status" = "200" ] &&
  [ "$(reply_json --arg id "$smoke_tag_id" --arg value "$VARIABLE_NEW_VALUE" '[.variables[] | select(.id == $id) | .value] == [$value]')" = "true" ] ||
  fail "after the refused delete, the variables' list (HTTP $status) doesn't hold SMOKE_TAG with its value: $(reply_code)"
no_store || fail "the variables' list, carrying their values, isn't Cache-Control: no-store"

step "bind a variable group overriding SMOKE_TAG with $VARIABLE_GROUP_VALUE to \"unassigned-b\": POST .../variable-groups, PUT .../overrides/:variableId, PATCH .../groups/:groupId; edge-b2 is sent the override's value, in sync (at most 60 polls)"
variable_create "$VARIABLE_GROUPS_URL" variable_group_ids '{id: $id, name: "smoke-variable-group", description: null}'
group_variable_group_id=$created_id
[ "$(reply_json --arg id "$group_variable_group_id" '.variableGroup | .id == $id and .name == "smoke-variable-group" and .overrideCount == 0')" = "true" ] ||
  fail "the variable group's create didn't answer it as sent: $(reply_json -c '.variableGroup | {id, overrideCount}')"
platform PUT "$VARIABLE_GROUPS_URL/$group_variable_group_id/overrides/$smoke_tag_id" \
  "$(jq -cn --arg value "$VARIABLE_GROUP_VALUE" '{value: $value}')"
[ "$status" = "200" ] &&
  [ "$(reply_json --arg id "$smoke_tag_id" --arg value "$VARIABLE_GROUP_VALUE" '.override.variableId == $id and .override.value == $value')" = "true" ] ||
  fail "overriding SMOKE_TAG in the group's variable group returned HTTP $status: $(reply_code)"
no_store || fail "an override's reply, carrying its value, isn't Cache-Control: no-store"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_unassigned_group_id" \
  "$(jq -cn --arg id "$group_variable_group_id" '{variableGroupId: $id}')"
[ "$status" = "200" ] && [ "$(reply_json '.group.variableGroupId')" = "$group_variable_group_id" ] &&
  [ "$(reply_json '.group.assignedPublishedVersionId')" = "$variable_publication_id" ] ||
  fail "binding the variable group to \"unassigned-b\" returned HTTP $status: $(reply_code)"
variable_wait_for_push "the group's variable group's" "$VARIABLE_GROUP_VALUE" "(.pinnedVariableGroupId == null)"

step "pin another variable group, overriding SMOKE_TAG with $VARIABLE_PIN_VALUE, on edge-b2: PATCH .../collectors/:collectorId with pinnedVariableGroupId answers it, no version pinned; edge-b2 is sent the pinned group's value, in sync (at most 60 polls)"
variable_create "$VARIABLE_GROUPS_URL" variable_group_ids '{id: $id, name: "smoke-variable-pin", description: null}'
pin_variable_group_id=$created_id
platform PUT "$VARIABLE_GROUPS_URL/$pin_variable_group_id/overrides/$smoke_tag_id" \
  "$(jq -cn --arg value "$VARIABLE_PIN_VALUE" '{value: $value}')"
[ "$status" = "200" ] && [ "$(reply_json --arg value "$VARIABLE_PIN_VALUE" '.override.value == $value')" = "true" ] ||
  fail "overriding SMOKE_TAG in the pinned variable group returned HTTP $status: $(reply_code)"
no_store || fail "the pinned variable group's override reply, carrying its value, isn't Cache-Control: no-store"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$managed_edge_b2_id" \
  "$(jq -cn --arg id "$pin_variable_group_id" '{pinnedVariableGroupId: $id}')"
[ "$status" = "200" ] && [ "$(reply_json '.collector.pinnedVariableGroupId')" = "$pin_variable_group_id" ] &&
  [ "$(reply_json '.collector | has("pin") and .pin == null')" = "true" ] ||
  fail "pinning the variable group on edge-b2 returned HTTP $status: $(reply_json -c 'if .collector then (.collector | {pin, pinnedVariableGroupId}) else .error end' | redact_secrets)"
no_store || fail "a collector's update's reply, carrying its reported attributes and error text, isn't Cache-Control: no-store"
variable_wait_for_push "the pinned variable group's" "$VARIABLE_PIN_VALUE" "(.pinnedVariableGroupId == \"$pin_variable_group_id\")"

step "clean up, leaving \"unassigned-b\" as it was: edge-b2's pinned variable group cleared, then the group's variable group and assignment (PATCH each answers null), edge-b2 unassigned again (at most 60 polls)"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$managed_edge_b2_id" '{"pinnedVariableGroupId": null}'
[ "$status" = "200" ] &&
  [ "$(reply_json '.collector | has("pin") and .pin == null and has("pinnedVariableGroupId") and .pinnedVariableGroupId == null')" = "true" ] ||
  fail "clearing edge-b2's pinned variable group returned HTTP $status: $(reply_code)"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_unassigned_group_id" '{"variableGroupId": null, "assignedVersionId": null}'
[ "$status" = "200" ] && [ "$(reply_json '.group | .variableGroupId == null and .assignedPublishedVersionId == null and .assignedVersion == null')" = "true" ] ||
  fail "clearing \"unassigned-b\"'s variable group and assignment returned HTTP $status: $(reply_code)"
wait_for_managed_collector edge-b2 60 "(.groupId == \"$managed_unassigned_group_id\") and (.pin == null) and (.pinnedVariableGroupId == null) and (.resolution == null) and (.drift == \"unassigned\")"

step "delete the two variable groups, the two variables (no longer in use) and the configuration: each DELETE answers 204, the lists are empty, and its published version leaves the opamp-server"
for created_id in "$pin_variable_group_id" "$group_variable_group_id"; do
  platform DELETE "$VARIABLE_GROUPS_URL/$created_id"
  [ "$status" = "204" ] || fail "deleting the variable group $created_id returned HTTP $status: $(reply_code)"
  variable_forget variable_group_ids "$created_id"
done
for created_id in "$smoke_tag_id" "$smoke_unused_id"; do
  platform DELETE "$VARIABLES_URL/$created_id"
  [ "$status" = "204" ] || fail "deleting the variable $created_id returned HTTP $status: $(reply_code)"
  variable_forget variable_ids "$created_id"
done
platform GET "$VARIABLES_URL"
[ "$status" = "200" ] && [ "$(reply_json '.variables == []')" = "true" ] ||
  fail "after the deletes, the variables' list (HTTP $status) isn't empty: $(reply_json -c '[.variables[]? | .id]')"
platform GET "$VARIABLE_GROUPS_URL"
[ "$status" = "200" ] && [ "$(reply_json '.variableGroups == []')" = "true" ] ||
  fail "after the deletes, the variable groups' list (HTTP $status) isn't empty: $(reply_json -c '[.variableGroups[]? | .id]')"
no_store || fail "the variable groups' list, carrying their names and descriptions, isn't Cache-Control: no-store"
platform DELETE "$GROUP_CONFIGURATIONS_URL/$variable_configuration_id"
[ "$status" = "204" ] || fail "deleting the variable configuration returned HTTP $status: $(reply_code)"
variable_deleted_configuration_id=$variable_configuration_id
variable_configuration_id=""
stack_smoke publications "$group_id" "$variable_deleted_configuration_id" 0 ||
  fail "the opamp-server still holds the published version of the variable configuration $variable_deleted_configuration_id after its delete (above)"
variable_publication_id=""

step "the configuration's delete is refused while the Default group uses its published version: 409 configuration_in_use"
platform DELETE "$GROUP_CONFIGURATIONS_URL/$managed_configuration_id"
[ "$status" = "409" ] && [ "$(reply_code)" = "configuration_in_use" ] ||
  fail "deleting the configuration in use returned HTTP $status: $(head -c 500 <<<"$body")"

step "its fleet usage lists the Default group: GET .../configurations/:configurationId/fleet-usage"
platform GET "$GROUP_CONFIGURATIONS_URL/$managed_configuration_id/fleet-usage"
[ "$status" = "200" ] && [ "$(json_field '.usage.inUse' "$body")" = "true" ] &&
  [ "$(reply_json --arg p "$managed_publication_id" --arg f "$managed_fleet_id" --arg g "$managed_default_group_id" \
    'any(.usage.publishedVersions[]; .publishedVersionId == $p and any(.groups[]; .fleetId == $f and .groupId == $g))')" = "true" ] ||
  fail "the configuration's fleet usage (HTTP $status) doesn't list the Default group: $(head -c 500 <<<"$body")"

step "reveal the default token: POST .../tokens/:tokenId/reveal answers a bearer, no-store"
platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/$managed_default_token_id/reveal"
[ "$status" = "200" ] || fail "revealing the default token returned HTTP $status: $(reply_code)"
no_store || fail "the reveal, carrying a bearer, isn't Cache-Control: no-store"
[ "$(reply_json '.token.id')" = "$managed_default_token_id" ] && [ "$(reply_json '.token.kind')" = "default" ] &&
  [ "$(reply_json '.token.bearer | type')" = "string" ] ||
  fail "the reveal didn't answer the default token with its bearer"
managed_revealed_bearer=$(reply_json '.token.bearer')
body=""
# The same token encrypted anew under a fresh nonce (bearers are never
# stored, each reveal seals the token again): as long as the create's, not
# the same text. Compared by bash's own [ ], never a command's argv.
[ -n "$managed_revealed_bearer" ] && [ "${#managed_revealed_bearer}" -eq "${#managed_default_bearer}" ] &&
  [ "$managed_revealed_bearer" != "$managed_default_bearer" ] ||
  fail "the reveal's bearer isn't the default token's sealed anew (its length differs, or it repeats the create's)"

# The grace's end in RFC 3339 with seconds, from jq's clock: no GNU date
# needed. Kept, for the summary's check after it.
step "rotate the rotate token with 120 s of grace: POST .../tokens/rotate answers the new token, its predecessor the old one, no-store"
managed_grace_ends_at=$(jq -rn 'now + 120 | floor | todate')
platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/rotate" \
  "$(jq -cn --arg g "$managed_grace_ends_at" '{expiresAt: null, graceEndsAt: $g}')"
[ "$status" = "201" ] || fail "rotating the rotate token returned HTTP $status: $(reply_code)"
no_store || fail "the rotation, carrying a bearer, isn't Cache-Control: no-store"
managed_new_rotate_token_id=$(reply_json '.token.id')
managed_new_rotate_bearer=$(reply_json '.token.bearer')
[ "$(reply_json '.token.predecessorId')" = "$managed_rotate_token_id" ] &&
  [[ "$managed_new_rotate_token_id" =~ ^[0-9a-f-]{36}$ ]] && [ "$managed_new_rotate_token_id" != "$managed_rotate_token_id" ] &&
  [ -n "$managed_new_rotate_bearer" ] && [ "$managed_new_rotate_bearer" != "null" ] ||
  fail "the rotation didn't answer a new token whose predecessor is $managed_rotate_token_id"
body=""

# During the grace: the new token current and never expiring, the old one
# valid until the grace's end (answered with milliseconds), two valid.
step "the fleet's summary answers the rotation's grace: two valid rotate tokens, the grace ending when the rotation said (at most 5 polls)"
managed_rotating=""
for _ in $(seq 1 5); do
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id"
  if [ "$status" = "200" ] &&
    [ "$(reply_json --arg g "$managed_grace_ends_at" '.fleet.summary.rotateToken == {expiresAt: null, graceEndsAt: ($g | sub("Z$"; ".000Z")), validCount: 2}')" = "true" ]; then
    managed_rotating=yes
    break
  fi
  sleep 1
done
[ -n "$managed_rotating" ] ||
  fail "the fleet's summary (last HTTP $status) didn't answer the grace ending at $managed_grace_ends_at with two valid rotate tokens within 5 polls: $(reply_json -c '.fleet.summary.rotateToken')"

# The rotated token tells its collectors to move to its successor; edge-b1
# hears it on its next poll (its heartbeat is 30 s).
step "edge-b1 follows the rotation: it holds the new rotate token (at most 60 polls)"
wait_for_managed_collector edge-b1 60 "(.enrollmentTokenId == \"$managed_new_rotate_token_id\")"

step "revoke the old rotate token: POST .../tokens/:tokenId/revoke"
platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/$managed_rotate_token_id/revoke"
[ "$status" = "200" ] && [ "$(json_field '.token.id' "$body")" = "$managed_rotate_token_id" ] &&
  [ "$(json_field '.token.revokedAt | type' "$body")" = "string" ] ||
  fail "revoking the old rotate token returned HTTP $status: $(head -c 500 <<<"$body")"

step "the fleet's summary answers the grace over: one valid rotate token, in no grace"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id"
[ "$status" = "200" ] && [ "$(reply_json '.fleet.summary.rotateToken == {expiresAt: null, graceEndsAt: null, validCount: 1}')" = "true" ] ||
  fail "the fleet's summary (HTTP $status) after the revoke isn't one rotate token in no grace: $(reply_json -c '.fleet.summary.rotateToken')"

step "list the tokens: the old one revoked, the new one live, and no bearer: GET .../tokens"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/tokens"
[ "$status" = "200" ] || fail "listing the tokens returned HTTP $status: $(reply_code)"
if [ "$(reply_json '[.. | objects | has("bearer")] | any')" != "false" ] ||
  reply_holds "$managed_default_bearer" || reply_holds "$managed_rotate_bearer" || reply_holds "$managed_revealed_bearer" ||
  reply_holds "$managed_new_rotate_bearer"; then
  fail "the token list carries a bearer"
fi
[ "$(reply_json --arg id "$managed_rotate_token_id" '[.tokens[] | select(.id == $id) | .revokedAt | type] == ["string"]')" = "true" ] &&
  [ "$(reply_json --arg id "$managed_new_rotate_token_id" '[.tokens[] | select(.id == $id) | {kind, revokedAt}] == [{kind: "rotate", revokedAt: null}]')" = "true" ] &&
  [ "$(reply_json --arg id "$managed_default_token_id" '[.tokens[] | select(.id == $id) | .revokedAt] == [null]')" = "true" ] ||
  fail "the token list doesn't hold the old rotate token revoked and the new one and the default one live: $(reply_json -c '[.tokens[] | {id, kind, revokedAt}]')"

# The token history through the platform: the fleet's
# six events so far (its create's two `issued`, the reveal's `viewed`, the
# rotation's `rotated` and `issued`, the revoke's `revoked`), newest first,
# each by the smoke's person, and no bearer anywhere in the reply; then a
# page of 1 and its cursor reach the second event. Not no-store (ids, times
# and the person's email).
step "read the token history through the platform: GET .../tokens/events answers issued, viewed, rotated and revoked, newest first, each by the smoke's person, no bearer; a page of 1 and its cursor"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/events"
[ "$status" = "200" ] || fail "reading the token history returned HTTP $status: $(reply_code)"
if [ "$(reply_json '[.. | objects | has("bearer")] | any')" != "false" ] ||
  reply_holds "$managed_default_bearer" || reply_holds "$managed_rotate_bearer" || reply_holds "$managed_revealed_bearer" ||
  reply_holds "$managed_new_rotate_bearer"; then
  fail "the token history carries a bearer"
fi
no_store && fail "the token history is Cache-Control: no-store, though it holds no bearer (only ids, times and the person's email)"
[ "$(reply_json '.nextCursor')" = "null" ] &&
  [ "$(reply_json '[.events[].event] | sort == ["issued", "issued", "issued", "revoked", "rotated", "viewed"]')" = "true" ] &&
  [ "$(reply_json --arg e "$EMAIL" 'all(.events[]; .actor.email == $e and (.actor.userId | type) == "string")')" = "true" ] &&
  [ "$(reply_json --arg id "$managed_rotate_token_id" '.events[0].event == "revoked" and .events[0].tokenId == $id')" = "true" ] &&
  [ "$(reply_json --arg id "$managed_default_token_id" 'any(.events[]; .event == "viewed" and .tokenId == $id)')" = "true" ] &&
  [ "$(reply_json --arg id "$managed_new_rotate_token_id" 'any(.events[]; .event == "issued" and .tokenId == $id)')" = "true" ] &&
  [ "$(reply_json '[.events[].occurredAt] == ([.events[].occurredAt] | sort | reverse)')" = "true" ] ||
  fail "the token history isn't the fleet's six events, newest first, by the smoke's person: $(reply_json -c '[.events[] | {event, tokenId, by: (.actor != null)}]')"
managed_first_event_id=$(reply_json '.events[0].id')
managed_second_event_id=$(reply_json '.events[1].id')
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/events?limit=1"
managed_events_cursor=$(reply_json '.nextCursor')
[ "$status" = "200" ] && [ "$(reply_json '.events | length')" = "1" ] && [ "$(reply_json '.events[0].id')" = "$managed_first_event_id" ] &&
  [[ "$managed_events_cursor" =~ ^[A-Za-z0-9_-]+$ ]] ||
  fail "a page of 1 of the token history (HTTP $status) isn't its newest event with a cursor: $(reply_code)"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/events?limit=1&cursor=$managed_events_cursor"
[ "$status" = "200" ] && [ "$(reply_json '.events | length')" = "1" ] && [ "$(reply_json '.events[0].id')" = "$managed_second_event_id" ] &&
  [ "$(reply_json '.nextCursor | type')" = "string" ] ||
  fail "the token history's cursor (HTTP $status) didn't reach its second event: $(reply_code)"

# The public download's helpers, shared by the quick-deploy steps (with the collector image) and
# the Helm install's values link (always): every file they read or write is in $qd_dir, 0700.
qd_dir="$work_dir/quick-deploy"
(umask 077 && mkdir -p "$qd_dir")
# qd_public_get <url> <name> [<base>]: a GET of the link <url> (its base, <base> or http://gateway,
# replaced by $GATEWAY_URL: the host reaches the gateway there) from the host, as the command's curl reads it,
# the link a config line on curl's standard input; the body into $qd_dir/<name>, the headers into
# $qd_dir/<name>.headers, the status into $status.
qd_public_get() {
  local host_url="$GATEWAY_URL${1#"${3:-http://gateway}"}"
  status=$(umask 077 && printf 'url = "%s"\n' "$host_url" |
    curl -q -g -s --max-time 60 -K - -o "$qd_dir/$2" -D "$qd_dir/$2.headers" -w '%{http_code}' || true)
}
# qd_header_is <name> <header> <value>: the reply has the header line `<header>: <value>` exactly, the whole
# line (its CR aside), the header's name in any case, the value as given.
qd_header_is() {
  awk -v name="$2" -v value="$3" '
    { sub(/\r$/, ""); colon = index($0, ":") }
    colon > 1 && tolower(substr($0, 1, colon - 1)) == tolower(name) && substr($0, colon + 1) == " " value { found = 1 }
    END { exit found ? 0 : 1 }' "$qd_dir/$1.headers"
}
# qd_redact: its standard input for a failure's message, every tqd_…, tll_… (a library link), tf_… (an API
# token) and every run of 20 or more base64 or base64url characters (a link's secret's, a bearer's shape)
# replaced (bytes, not characters: LC_ALL=C).
qd_redact() {
  LC_ALL=C sed -E -e 's#tqd_[A-Za-z0-9_-]+#[redacted]#g' -e 's#tll_[A-Za-z0-9_-]+#[redacted]#g' \
    -e 's#tf_[A-Za-z0-9_-]+#[redacted]#g' -e 's#[A-Za-z0-9+/_=-]{20,}#[redacted]#g'
}
# qd_redacted <file> [<bytes>]: the file's text redacted (qd_redact), its lines joined by `;`, cut to its first
# <bytes> AFTER the redaction (a cut before it could leave a secret's first characters too short to redact).
qd_redacted() {
  qd_redact <"$1" | tr '\n' ';' | head -c "${2:-4000}"
}
# qd_secrets <secret>...: the 0600 file of the secrets, one a line, that grep reads (`-f`); printf is a builtin.
qd_secrets() { (umask 077 && printf '%s\n' "$@" >"$qd_dir/secrets"); }
# qd_clean <file>: true when the file holds none of the secrets (a missing file holds none), false when it
# holds one or can't be searched (grep's 2, a missing or empty secrets file among its causes: it fails closed).
qd_clean() {
  local code=0
  [ -s "$qd_dir/secrets" ] || return 1
  [ -e "$1" ] || return 0
  grep -qF -f "$qd_dir/secrets" -- "$1" || code=$?
  [ "$code" = "1" ]
}
# qd_none <what> <grep's arguments>...: true when `grep -q` finds no line (its 1), false when it finds one (its
# 0); any other status (a file or the pattern file unread) fails the run, naming <what>: a guard fails closed.
qd_none() {
  local what=$1 code=0
  shift
  grep -q "$@" || code=$?
  case "$code" in
    1) return 0 ;;
    0) return 1 ;;
    *) fail "$what couldn't be searched (grep exited $code)" ;;
  esac
}
# qd_logs_clean <file> <when>: the API's and the gateway's logs in <file> hold none of the secrets, the secrets
# file and the logs there and grep's status tested (qd_none); a secret found fails with its lines counted only.
qd_logs_clean() {
  [ -s "$qd_dir/secrets" ] || fail "the API's and the gateway's logs$2 couldn't be searched: the secrets file is missing or empty"
  [ -f "$1" ] || fail "the API's and the gateway's logs$2 couldn't be searched: they weren't written"
  qd_none "the API's and the gateway's logs$2" -F -f "$qd_dir/secrets" -- "$1" ||
    fail "the API's or the gateway's logs$2 hold a link's secret or the bearer, on $(grep -cF -f "$qd_dir/secrets" -- "$1") lines"
}
# qd_printable <file>: true when the file may be printed whole for a failure's message: it exists, it is clean
# (qd_clean) and it holds no tqd_ and no tll_ (any link's secret, one not yet known here among them) and no
# run of 100 or more base64 characters (a bearer's shape), grep's status tested: a search that fails says no.
qd_printable() {
  local code=0
  [ -f "$1" ] && qd_clean "$1" || return 1
  grep -qE 'tqd_|tll_|[A-Za-z0-9+/]{100,}' -- "$1" || code=$?
  [ "$code" = "1" ]
}
# qd_shown <file> [<bytes>]: a diagnostic for a failure's message: the file's text whole when qd_printable (its
# lines joined by `;`, cut to its first <bytes>), else redacted (qd_redacted).
qd_shown() {
  if qd_printable "$1"; then tr '\n' ';' <"$1" | head -c "${2:-4000}"; else qd_redacted "$1" "${2:-4000}"; fi
}
# qd_diagnostic: a filter (wait_for_managed_collector's <redaction>): its standard input kept in a 0600 file and
# printed whole when qd_printable, else redacted (qd_redact).
qd_diagnostic() {
  (umask 077 && cat >"$qd_dir/diagnostic")
  if qd_printable "$qd_dir/diagnostic"; then cat "$qd_dir/diagnostic"; else qd_redact <"$qd_dir/diagnostic"; fi
}
# qd_search <what> <file>...: fails, printing nothing of them, unless every file is clean (qd_clean).
qd_search() {
  local what=$1 file
  shift
  for file in "$@"; do
    qd_clean "$file" || fail "$what holds a link's secret or the bearer, or couldn't be searched for them (not printed)"
  done
}
# qd_reply <jq's arguments>... and qd_reply_code: the last reply's jq answer (reply_json) or error code
# (reply_code) for a failure's message, printed only when the reply holds no tqd_ and no tll_ (any link's
# secret, one not yet known here among them) and is clean (qd_clean); otherwise a note that it isn't printed.
qd_reply_printable() { ! reply_holds tqd_ && ! reply_holds tll_ && qd_clean "$PLATFORM_REPLY_BODY"; }
qd_reply() {
  if qd_reply_printable; then reply_json "$@"; else echo "(not printed: the reply holds a link's secret or the bearer)"; fi
}
qd_reply_code() {
  if qd_reply_printable; then reply_code; else echo "(not printed: the reply holds a link's secret or the bearer)"; fi
}
# qd_refused <name> <text> [<status>]: a refusal (410, or <status>) in its plain text, with the public route's headers.
qd_refused() {
  [ "$status" = "${3:-410}" ] && [ "$(<"$qd_dir/$1")" = "$2" ] && qd_header_is "$1" content-type "text/plain; charset=utf-8" &&
    qd_header_is "$1" cache-control no-store && qd_header_is "$1" x-content-type-options nosniff &&
    qd_header_is "$1" referrer-policy no-referrer
}

# Installing collectors through the platform, in edge-b1's fleet, while its
# published version is still assigned: a group "install-i" with that version
# and one read-only mount; the install's facts read through the platform; the
# container install run from them in the collector image built locally
# (scripts/build-collector-image.sh <the catalog's default>, never pulled:
# `--pull never`), with the bearer of a reveal; the All In One bundle
# downloaded, unpacked into a fresh directory, and run in that image as root
# (it downloads otelcol-contrib and the supervisor for the image's arch from
# GitHub, checked by sha256); both collectors enroll in "install-i". Then the
# default token is revoked, a new one issued, and the container install run
# again with it on the same volume: the collector reconnects (its id and
# instance uid kept), no new one enrolls. Without the image these steps are
# skipped, with a line saying why.
#
# The run is built from the facts (install_run_args), never by evaluating a
# rendered command; a bearer reaches a container only through its
# environment (`OPAMP_TOKEN=… docker run … -e OPAMP_TOKEN`), never a command
# line. Every container and the volume are named for the compose project and
# removed at the end, or by the EXIT trap.

# install_run_args <facts file> <container> <volume> <display name> <network>:
# docker's arguments for the container install, beginning with `run` (call it
# as `docker "${install_args[@]}"`; the container install's command), built
# from the install's facts (GET .../groups/:groupId/install), in the array
# install_args: detached, never pulled, named <container> on <network>,
# the image's state on the volume <volume>, a `-v` per group mount (`:ro`
# when read-only), the group's id, the endpoint, whether insecure
# connections are allowed, the display name (when one is given), the token by
# name only (its value from the caller's environment), and the image last.
# Each value is one argument as the facts hold it: no shell reads it. Facts
# not of that shape (a value empty or holding a line break, a mount path
# holding `:`, which Docker's -v splits on) return 1, install_args empty.
install_run_args() {
  local facts=$1 container=$2 volume=$3 name=$4 network=$5 mount
  install_args=()
  jq -e '(.imageTag | type) == "string" and (.endpoint | type) == "string" and (.groupId | type) == "string" and
    (.allowInsecureConnections | type) == "boolean" and (.mounts | type) == "array" and
    all(.mounts[]; (.hostPath | type) == "string" and (.containerPath | type) == "string" and (.readOnly | type) == "boolean") and
    all(.imageTag, .endpoint, .groupId; . != "" and (test("[\\n\\r]") | not)) and
    all(.mounts[] | .hostPath, .containerPath; startswith("/") and (test("[\\n\\r:]") | not))' "$facts" >/dev/null 2>&1 || return 1
  install_args=(run -d --pull never --name "$container" --network "$network" -v "$volume:/app/opamp")
  while IFS= read -r mount; do
    install_args+=(-v "$mount")
  done < <(jq -r '.mounts[] | "\(.hostPath):\(.containerPath)\(if .readOnly then ":ro" else "" end)"' "$facts")
  install_args+=(-e "COLLECTOR_GROUP_ID=$(jq -r '.groupId' "$facts")")
  install_args+=(-e "OPAMP_ENDPOINT=$(jq -r '.endpoint' "$facts")")
  install_args+=(-e "OPAMP_ALLOW_INSECURE_CONNECTIONS=$(jq -r '.allowInsecureConnections' "$facts")")
  if [ -n "$name" ]; then install_args+=(-e "OPAMP_SERVER_NAME=$name"); fi
  install_args+=(-e OPAMP_TOKEN "$(jq -r '.imageTag' "$facts")")
}

install_image="ghcr.io/telflo/telflo/collector:$catalog_default"
if ! docker image inspect "$install_image" >/dev/null 2>&1; then
  install_steps="skipped the install steps ($install_image isn't here)"
  step "SKIPPED: the install steps (the container install, the All In One bundle, the quick-deploy links, a reconnect after a new default token) need the collector image $install_image here, never pulled by this script: build it with scripts/build-collector-image.sh $catalog_default, or pull the published one, first"
else
  install_steps="installed two real collectors through the platform's install (the container install run from its facts, with a group's mount, and the All In One bundle run as root, downloading its binaries checked by sha256), both enrolling in their group, made two quick-deploy links (one's Quick Deploy command run for real, enrolling a third collector; the systemd one's writing opamp.env and the unit and calling systemctl in order), downloaded through the gateway with no session, their secrets in no log, a revoked link and a revoked default token's link refused, and after a new default token re-ran the container install, which reconnected as the same collector, then deleted their group and its collectors with it"
  install_group_name="install-i"
  install_mount_host="$work_dir/install-mount"
  mkdir -p "$install_mount_host"
  [[ "$install_mount_host" =~ ^/[A-Za-z0-9._/-]*$ ]] ||
    fail "the work directory's path ($install_mount_host) isn't one a group's mount takes (letters, digits, '.', '_', '-' and '/'): set TMPDIR to such a directory"
  install_mounts=$(jq -cn --arg h "$install_mount_host" '[{hostPath: $h, containerPath: "/var/log/telflo-smoke", readOnly: true}]')

  step "create the group \"$install_group_name\" with the published version and a read-only mount through the platform: POST .../groups answers its annotations"
  platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/groups" "$(jq -cn --arg name "$install_group_name" --arg v "$managed_version_id" \
    --argjson mounts "$install_mounts" '{name: $name, assignedVersionId: $v, annotations: {telflo: {dockerMounts: $mounts}}}')"
  [ "$status" = "201" ] && [ "$(reply_json --argjson mounts "$install_mounts" '.group.annotations == {telflo: {dockerMounts: $mounts}}')" = "true" ] &&
    [ "$(reply_json --arg v "$managed_version_id" '.group.assignedVersion.versionId == $v')" = "true" ] ||
    fail "creating the install's group returned HTTP $status: $(head -c 500 <<<"$body")"
  install_group_id=$(reply_json '.group.id')

  step "read the install's facts through the platform: GET .../groups/:groupId/install answers no-store, $install_image, this stack's agent endpoint, the group and its mount, and no bearer"
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$install_group_id/install"
  [ "$status" = "200" ] || fail "reading the install's facts returned HTTP $status: $(reply_code)"
  no_store || fail "the install's facts, carrying configuration text, aren't Cache-Control: no-store"
  # No bearer by its shape (each reveal seals a new one, so no earlier bearer's text can show it): a bearer is
  # 100 or more base64 characters in a row; nothing in the facts runs past 64 (a sha256).
  if [ "$(reply_json '[.. | objects | has("bearer")] | any')" != "false" ] || grep -qE '[A-Za-z0-9+/]{100,}' "$PLATFORM_REPLY_BODY"; then
    fail "the install's facts carry a bearer, or a run of 100 or more base64 characters"
  fi
  [ "$(reply_json '.imageTag')" = "$install_image" ] &&
    [ "$(reply_json --arg v "$catalog_default" '.collector == {distribution: "otelcol-contrib", version: $v}')" = "true" ] ||
    fail "the install's facts name the image $(reply_json '.imageTag') for the collector $(reply_json -c '.collector'), not $install_image (TELFLO_COLLECTOR_IMAGE_REPOSITORY must be the default for these steps)"
  [ "$(reply_json '.endpoint')" = "$server_url" ] ||
    fail "the install's facts name the endpoint $(reply_json '.endpoint'), but the opamp-server hands collectors $server_url: the API's TELFLO_OPAMP_AGENT_PUBLIC_URL must be the opamp-server's OPAMP_SERVER_URL (compose sets both from OPAMP_SERVER_URL)"
  [ "$(reply_json --arg g "$install_group_id" --argjson mounts "$install_mounts" '.groupId == $g and .mounts == $mounts and .envVarNames == []')" = "true" ] ||
    fail "the install's facts aren't the group's id and mount, with no variables: $(reply_json -c '{groupId, mounts, envVarNames}')"
  install_facts="$work_dir/install-facts.json"
  (umask 077 && cp "$PLATFORM_REPLY_BODY" "$install_facts")

  step "reveal the default token for the install: POST .../tokens/:tokenId/reveal"
  platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/$managed_default_token_id/reveal"
  [ "$status" = "200" ] && [ "$(reply_json '.token.kind')" = "default" ] || fail "revealing the default token for the install returned HTTP $status: $(reply_code)"
  install_bearer=$(reply_json '.token.bearer')
  body=""
  [ -n "$install_bearer" ] && [ "$install_bearer" != "null" ] || fail "the reveal for the install answered no bearer"

  install_container="$compose_project-install-c1"
  install_volume="$compose_project-install-opamp"
  step "run the container install built from the facts: $install_image, never pulled, on the compose network, the bearer only in its environment"
  install_run_args "$install_facts" "$install_container" "$install_volume" install-c1 "$compose_network" ||
    fail "the install's facts aren't ones the container install can be built from: $(jq -c '{imageTag, endpoint, groupId, mounts}' "$install_facts")"
  install_containers="$install_containers $install_container"
  OPAMP_TOKEN=$install_bearer docker "${install_args[@]}" >/dev/null || fail "running the container install failed"

  step "the container install holds the group's mount read-only, and its state on the volume at /app/opamp: docker inspect"
  install_container_mounts=$(docker inspect --format '{{json .Mounts}}' "$install_container")
  [ "$(jq -r --arg volume "$install_volume" '
      ([.[] | select(.Destination == "/var/log/telflo-smoke")] | length == 1 and .[0].Type == "bind" and .[0].RW == false) and
      ([.[] | select(.Destination == "/app/opamp")] | length == 1 and .[0].Type == "volume" and .[0].Name == $volume)' <<<"$install_container_mounts")" = "true" ] ||
    fail "the container install's mounts aren't the group's read-only mount and its volume: $install_container_mounts"

  step "install-c1 enrolls in \"$install_group_name\" through the platform, handed the rotate token (at most 60 polls)"
  wait_for_managed_collector install-c1 60 "(.groupId == \"$install_group_id\") and (.enrollmentTokenId == \"$managed_new_rotate_token_id\")"
  install_c1_id=$(jq -r '.id' <<<"$collector")
  install_c1_uid=$(jq -r '.instanceUid' <<<"$collector")

  install_arch=$(docker image inspect --format '{{.Architecture}}' "$install_image")
  case "$install_arch" in
    amd64 | arm64) ;;
    *) fail "the collector image $install_image is for $install_arch: the bundles are for amd64 and arm64" ;;
  esac
  install_bundle_name="telflo-collector-all-in-one-$install_arch.tar.gz"
  install_bundle="$work_dir/$install_bundle_name"
  install_bundle_headers="$work_dir/install-bundle-headers"
  step "download the All In One bundle for $install_arch: POST .../groups/:groupId/install-bundle answers application/gzip, no-store, attachment $install_bundle_name"
  status=$(curl -s --max-time 60 -o "$install_bundle" -D "$install_bundle_headers" -w '%{http_code}' -b "$JAR" -X POST \
    -H 'X-Telflo-CSRF: 1' -H 'content-type: application/json' \
    --data-binary "$(jq -cn --arg arch "$install_arch" '{method: "all-in-one", arch: $arch, rootPath: "/etc/otelcol", env: []}')" \
    "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$install_group_id/install-bundle" || true)
  [ "$status" = "200" ] || fail "downloading the bundle returned HTTP $status: $(head -c 500 "$install_bundle")"
  grep -qiE '^content-type:[[:space:]]*application/gzip' "$install_bundle_headers" &&
    grep -qiE '^cache-control:[[:space:]]*no-store' "$install_bundle_headers" &&
    grep -qiF "content-disposition: attachment; filename=\"$install_bundle_name\"" "$install_bundle_headers" ||
    fail "the bundle's reply isn't application/gzip, no-store, attachment $install_bundle_name: $(grep -iE '^(content-type|cache-control|content-disposition):' "$install_bundle_headers" | tr -d '\r' | tr '\n' ' ')"

  step "unpack it into a fresh directory: its four files, start_supervisor.sh 0700 and the others 0644, no placeholder left, no bearer (no run of 100 or more base64 characters)"
  install_unpacked=$(mktemp -d "$work_dir/install-bundle.XXXXXX")
  tar -xzpf "$install_bundle" -C "$install_unpacked" || fail "the bundle isn't a gzipped tar the system tar reads"
  [ "$(cd "$install_unpacked" && ls -A | sort | tr '\n' ' ')" = "README.md otelcol-config.yaml start_supervisor.sh supervisor-config.yaml " ] ||
    fail "the bundle holds $(cd "$install_unpacked" && ls -A | tr '\n' ' '), not the All In One's four files"
  [ -n "$(find "$install_unpacked/start_supervisor.sh" -type f -perm 700)" ] &&
    [ "$(find "$install_unpacked" -type f -perm 644 | wc -l | tr -d ' ')" = "3" ] ||
    fail "the bundle's modes aren't start_supervisor.sh 0700 and the others 0644: $(ls -l "$install_unpacked" | tr '\n' ' ')"
  if grep -lE '\$\{[A-Z_][A-Z0-9_]*\}' "$install_unpacked"/* >/dev/null; then
    fail "the bundle holds a placeholder left unfilled: $(cd "$install_unpacked" && grep -lE '\$\{[A-Z_][A-Z0-9_]*\}' -- * | tr '\n' ' ')"
  fi
  # No bearer by its shape: each reveal seals a new bearer, so comparing with one revealed here could never fail.
  # A bearer is 100 or more base64 characters in a row; a real bundle's longest run is 64 (a sha256). The
  # pattern alone is grep's argument: no bearer is in any command's argv.
  if grep -qE '[A-Za-z0-9+/]{100,}' "$install_unpacked"/*; then
    fail "the bundle holds a run of 100 or more base64 characters (a bearer's shape): $(cd "$install_unpacked" && grep -lE '[A-Za-z0-9+/]{100,}' -- * | tr '\n' ' ')"
  fi
  grep -qF "$install_group_id" "$install_unpacked/supervisor-config.yaml" && grep -qF "$server_url" "$install_unpacked/supervisor-config.yaml" ||
    fail "the bundle's supervisor-config.yaml doesn't name the group $install_group_id and the endpoint $server_url"

  install_aio_container="$compose_project-install-aio"
  step "run the bundle in the collector image as root: unpacked into a fresh /etc/otelcol and started there as the token screen says, the token only in its environment; it downloads and checks otelcol-contrib and the supervisor for $install_arch, and install-aio enrolls in \"$install_group_name\" (at most 300 polls)"
  install_containers="$install_containers $install_aio_container"
  OPAMP_TOKEN="Bearer $install_bearer" docker run -d --pull never --name "$install_aio_container" --network "$compose_network" \
    -v "$install_bundle:/bundle/$install_bundle_name:ro" -e OPAMP_TOKEN --entrypoint bash "$install_image" \
    -c 'set -euo pipefail; mkdir -p /etc/otelcol; tar -xzf "/bundle/$1" -C /etc/otelcol; cd /etc/otelcol; exec ./start_supervisor.sh --OPAMP_SERVER_NAME="$2"' \
    install-aio "$install_bundle_name" install-aio >/dev/null || fail "running the All In One bundle failed"
  wait_for_managed_collector install-aio 300 "(.groupId == \"$install_group_id\") and (.enrollmentTokenId == \"$managed_new_rotate_token_id\")" "$install_aio_container"

  step "the fleet's collectors in \"$install_group_name\" are both installed ones: GET .../collectors?groupId="
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors?groupId=$install_group_id"
  [ "$status" = "200" ] && [ "$(reply_json '[.collectors[].name] | sort == ["install-aio", "install-c1"]')" = "true" ] ||
    fail "the group's collectors (HTTP $status) aren't install-c1 and install-aio: $(reply_json -c '[.collectors[]?.name]')"

  # Quick-deploy links, in "install-i", while the default token the install
  # revealed is still valid:
  # L1 (All In One, foreground) made, listed, downloaded from the host through
  # the gateway, and its Quick Deploy command run for real in the collector
  # image on the compose network, enrolling install-qd1; L2 (the systemd
  # service) made and its command run with a recording `systemctl` (the image
  # has no systemd), its opamp.env, unit and calls checked; the API's and the
  # gateway's logs searched for both links' secrets and the bearer; L1 revoked
  # and refused 410; L2 refused 410 once the default token is revoked (below);
  # the logs searched again after those two refusals. Five public requests
  # (L1's from the host and its command's, L1's 410, L2's command's, L2's
  # 410): the per-IP limit (30 a minute) and the per-link one (60) never bind.
  #
  # The secrets known so far (the bearer, then each link's as it is made) are
  # written, one a line, to a 0600 file that grep reads (`-f`), never onto a
  # command line, before anything is compared or printed. A failed check
  # prints no secret: every file, reply or output it prints is
  # either searched for them first (qd_search, failing with no excerpt;
  # qd_reply and qd_reply_code, which also refuse a reply holding any tqd_),
  # printed whole only when it holds none of them, no tqd_ and no run of 100
  # or more base64 characters, else redacted (qd_shown, qd_diagnostic), or
  # printed only redacted (qd_redact, qd_redacted), and a command given a
  # secret writes its error output to a file, never to the terminal. Every
  # guard's search tests grep's status (qd_none, qd_clean): one that
  # couldn't be made (a missing file, the secrets file among them) fails.
  #
  # Each command is the one the install dialog shows, printed by the
  # contracts' quickDeployCommands in the API container (qd_command), never a
  # copy written here. The link's secret and the bearer are on no command
  # line: they reach the printing by name (`docker compose exec -e NAME`, the
  # value from this shell's environment), the printed command is a 0600 file
  # mounted read-only, curl here reads a link as a config line on its
  # standard input (qd_public_get), and every comparison is bash's own. The
  # image runs as root and has no sudo: a `sudo` on PATH (/qd/bin, mounted
  # read-only) records its arguments and runs the rest, keeping the
  # environment; a `systemctl` there only records. install-aio's binaries
  # (above) are mounted read-only into the root path, so the start script
  # downloads nothing again. Their containers are named for the compose
  # project and removed with the install's (or by the EXIT trap).
  step "the API's TELFLO_PUBLIC_API_URL is http://gateway, the gateway as a container on the compose network reaches it"
  qd_public_api_url=$(docker compose exec -T api printenv TELFLO_PUBLIC_API_URL) ||
    fail "couldn't read the API's TELFLO_PUBLIC_API_URL"
  [ "$qd_public_api_url" = "http://gateway" ] ||
    fail "the API's TELFLO_PUBLIC_API_URL is $qd_public_api_url, not http://gateway: start this stack with TELFLO_PUBLIC_API_URL=http://gateway (compose's default, http://host.docker.internal:50080, would send its Quick Deploy commands to whatever gateway listens on the host's port 50080, a developer's own development stack's)"
  (umask 077 && mkdir -p "$qd_dir/bin" "$qd_dir/l1-out" "$qd_dir/l2-out")
  chmod 0755 "$qd_dir/bin"
  # The shims: no secret reaches either (the command puts none on a command line), which the calls' check shows.
  cat >"$qd_dir/bin/sudo" <<'SHIM'
#!/bin/sh
# The stack smoke's sudo: the collector image runs as root and has none.
# Records its arguments in /qd-out/calls, takes the one option the Quick
# Deploy command passes (--preserve-env=OPAMP_TOKEN: the environment is kept
# as it is) and runs the rest.
printf 'sudo %s\n' "$*" >>/qd-out/calls
case "$1" in
  --preserve-env=OPAMP_TOKEN) shift ;;
  -*) echo "the smoke's sudo takes no option $1" >&2; exit 64 ;;
esac
exec "$@"
SHIM
  cat >"$qd_dir/bin/systemctl" <<'SHIM'
#!/bin/sh
# The stack smoke's systemctl: the collector image has no systemd. Records its
# arguments in /qd-out/calls, and succeeds.
printf 'systemctl %s\n' "$*" >>/qd-out/calls
SHIM
  chmod 0755 "$qd_dir/bin/sudo" "$qd_dir/bin/systemctl"
  docker cp "$install_aio_container:/etc/otelcol/otelcol-contrib" "$qd_dir/otelcol-contrib" >/dev/null &&
    docker cp "$install_aio_container:/etc/otelcol/supervisor" "$qd_dir/supervisor" >/dev/null ||
    fail "copying install-aio's otelcol-contrib and supervisor out of $install_aio_container failed"

  # qd_command <url> <root path> <display name> <systemd: true|false> <file>: the Quick Deploy command for the
  # link <url> and the install's bearer, printed by the contracts' quickDeployCommands in the API container (its
  # working directory /app/apps/api; the image's compiled @telflo/contracts), into <file>, 0600, its error
  # output into <file>.err, 0600 (printed only redacted). The link and the bearer reach it by
  # name only.
  qd_command() {
    local script='import { quickDeployCommands } from "@telflo/contracts";
const { QD_URL, QD_BEARER, QD_ROOT, QD_NAME, QD_SYSTEMD } = process.env;
process.stdout.write(`${quickDeployCommands({ url: QD_URL, rootPath: QD_ROOT, bearer: QD_BEARER, displayName: QD_NAME, systemd: QD_SYSTEMD === "true" })}\n`);'
    (umask 077 && QD_URL=$1 QD_BEARER=$install_bearer QD_ROOT=$2 QD_NAME=$3 QD_SYSTEMD=$4 \
      docker compose exec -T -e QD_URL -e QD_BEARER -e QD_ROOT -e QD_NAME -e QD_SYSTEMD api \
      node --input-type=module -e "$script" >"$5" 2>"$5.err")
  }
  QD_LINKS_URL="$GROUP_FLEETS_URL/$managed_fleet_id/quick-deploy-links"
  QD_URL_PATTERN='^http://gateway/api/v1/quick-deploy/tqd_[A-Za-z0-9_-]{43}$'
  # The bearer first: every reply, file and output below is searched for it.
  qd_secrets "$install_bearer"

  step "make link L1 for \"$install_group_name\" (All In One, $install_arch, /etc/otelcol, in the foreground): POST .../groups/:groupId/quick-deploy-links answers 201, no-store, the link and its url"
  platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$install_group_id/quick-deploy-links" \
    "$(jq -cn --arg arch "$install_arch" '{method: "all-in-one", arch: $arch, rootPath: "/etc/otelcol", env: [], systemd: false}')"
  [ "$status" = "201" ] || fail "making L1 returned HTTP $status: $(qd_reply_code)"
  no_store || fail "L1's reply, carrying the link's secret, isn't Cache-Control: no-store"
  qd_l1_url=$(reply_json '.url')
  [[ "$qd_l1_url" =~ $QD_URL_PATTERN ]] || fail "L1's url isn't http://gateway/api/v1/quick-deploy/tqd_ and 43 base64url characters"
  qd_l1_secret=${qd_l1_url##*/}
  # L1's secret too, before anything else is compared or printed.
  qd_secrets "$qd_l1_secret" "$install_bearer"
  qd_l1_id=$(reply_json '.link.id')
  [ "$(reply_json --arg g "$install_group_id" --arg t "$managed_default_token_id" --arg arch "$install_arch" '
      .link.groupId == $g and .link.groupName == "install-i" and .link.defaultTokenId == $t and .link.status == "active"
      and .link.downloadCount == 0 and .link.revokedAt == null and (.link.expiresAt | type) == "string"
      and .link.choices == {method: "all-in-one", arch: $arch, rootPath: "/etc/otelcol", executablePath: null, systemd: false, envNames: []}')" = "true" ] ||
    fail "L1's link isn't the group's, on the default token, active with no download, as asked"

  step "list the fleet's links: GET .../quick-deploy-links answers L1 active with no download, and no secret"
  platform GET "$QD_LINKS_URL"
  if reply_holds "$qd_l1_secret" || reply_holds "tqd_"; then fail "the links' list holds a link's secret"; fi
  [ "$status" = "200" ] && [ "$(reply_json --arg id "$qd_l1_id" '[.links[] | select(.id == $id) | .status == "active" and .downloadCount == 0 and .lastDownloadedAt == null] == [true]')" = "true" ] ||
    fail "the links' list (HTTP $status) doesn't answer L1 active with no download: $(qd_reply_code)"

  qd_bundle_name="telflo-collector-all-in-one-$install_arch.tar.gz"
  step "download L1 from the host through the gateway, with no session: 200, application/gzip, no-store, nosniff, no-referrer, attachment $qd_bundle_name; the bundle's four files, no bearer (no run of 100 or more base64 characters)"
  qd_public_get "$qd_l1_url" l1-bundle
  # Its headers searched first (none of the public route's may hold a secret): a failure below prints them.
  qd_search "L1's download's headers" "$qd_dir/l1-bundle.headers"
  [ "$status" = "200" ] || fail "downloading L1 returned HTTP $status, redacted: $(qd_redacted "$qd_dir/l1-bundle" 300)"
  qd_header_is l1-bundle content-type application/gzip && qd_header_is l1-bundle cache-control no-store &&
    qd_header_is l1-bundle x-content-type-options nosniff && qd_header_is l1-bundle referrer-policy no-referrer &&
    qd_header_is l1-bundle content-disposition "attachment; filename=\"$qd_bundle_name\"" ||
    fail "L1's download isn't application/gzip, no-store, nosniff, no-referrer, attachment $qd_bundle_name: $(grep -iE '^(content-type|cache-control|x-content-type-options|referrer-policy|content-disposition):' "$qd_dir/l1-bundle.headers" | tr -d '\r' | tr '\n' ' ')"
  qd_none "L1's download's headers" -i '^set-cookie:' -- "$qd_dir/l1-bundle.headers" || fail "L1's download sets a cookie"
  qd_unpacked=$(mktemp -d "$qd_dir/l1-unpacked.XXXXXX")
  tar -xzpf "$qd_dir/l1-bundle" -C "$qd_unpacked" 2>"$qd_dir/l1-tar.err" ||
    fail "L1's download isn't a gzipped tar the system tar reads, tar's error redacted: $(qd_redacted "$qd_dir/l1-tar.err" 300)"
  # The bundle's names are printed only redacted (and its contents never).
  [ "$(cd "$qd_unpacked" && ls -A | sort | tr '\n' ' ')" = "README.md otelcol-config.yaml start_supervisor.sh supervisor-config.yaml " ] ||
    fail "L1's bundle holds $(cd "$qd_unpacked" && ls -A | qd_redact | tr '\n' ' '), not the All In One's four files (redacted)"
  qd_none "L1's bundle" -E '[A-Za-z0-9+/]{100,}' -- "$qd_unpacked"/* ||
    fail "L1's bundle holds a run of 100 or more base64 characters (a bearer's shape): $(cd "$qd_unpacked" && grep -lE '[A-Za-z0-9+/]{100,}' -- * | qd_redact | tr '\n' ' ')"
  grep -qF "$install_group_id" "$qd_unpacked/supervisor-config.yaml" || fail "L1's bundle doesn't name the group $install_group_id"

  qd1_container="$compose_project-install-qd1"
  step "run L1's Quick Deploy command (printed by the contracts' builder in the API container) in $install_image on the compose network: a sudo on PATH, install-aio's binaries in /etc/otelcol; install-qd1 enrolls in \"$install_group_name\" (at most 120 polls)"
  qd_command "$qd_l1_url" /etc/otelcol install-qd1 false "$qd_dir/l1-command" ||
    fail "printing L1's Quick Deploy command in the API container failed, its error redacted: $(qd_redacted "$qd_dir/l1-command.err" 600)"
  [ "$(head -n1 "$qd_dir/l1-command")" = "(" ] &&
    [ "$(tail -n1 "$qd_dir/l1-command")" = "cd '/etc/otelcol' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh --OPAMP_SERVER_NAME='install-qd1' )" ] ||
    fail "the printed command isn't the foreground Quick Deploy command (a subshell closing on the start script's line)"
  install_containers="$install_containers $qd1_container"
  docker run -d --pull never --name "$qd1_container" --network "$compose_network" \
    -v "$qd_dir/l1-command:/qd/command:ro" -v "$qd_dir/bin:/qd/bin:ro" -v "$qd_dir/l1-out:/qd-out" \
    -v "$qd_dir/otelcol-contrib:/etc/otelcol/otelcol-contrib:ro" -v "$qd_dir/supervisor:/etc/otelcol/supervisor:ro" \
    --entrypoint bash "$install_image" -c 'PATH=/qd/bin:$PATH exec bash /qd/command' >/dev/null ||
    fail "starting L1's Quick Deploy command failed"
  wait_for_managed_collector install-qd1 120 "(.groupId == \"$install_group_id\") and (.enrollmentTokenId == \"$managed_new_rotate_token_id\")" "$qd1_container" qd_diagnostic
  # The calls searched first: a failure below prints them whole when they hold no tqd_ and no bearer's shape
  # either, else redacted (qd_shown).
  qd_search "a shim's arguments in L1's command (its calls)" "$qd_dir/l1-out/calls"
  [ "$(<"$qd_dir/l1-out/calls")" = "sudo mkdir -p /etc/otelcol
sudo tar -xzf - -C /etc/otelcol
sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh --OPAMP_SERVER_NAME=install-qd1" ] ||
    fail "L1's command ran sudo otherwise than mkdir, tar and the start script (its calls differ): $(qd_shown "$qd_dir/l1-out/calls")"

  qd2_container="$compose_project-install-qd2"
  step "make link L2 (the systemd service) and run its command with the sudo and a recording systemctl: opamp.env 0600 root's, one line, the bearer's; the unit 0644 root's, its text exact; daemon-reload, enable and restart in order; neither secret on a shim's arguments"
  platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$install_group_id/quick-deploy-links" \
    "$(jq -cn --arg arch "$install_arch" '{method: "all-in-one", arch: $arch, rootPath: "/etc/otelcol", env: [], systemd: true}')"
  [ "$status" = "201" ] && no_store && [ "$(reply_json '.link.choices.systemd')" = "true" ] || fail "making L2 returned HTTP $status: $(qd_reply_code)"
  qd_l2_url=$(reply_json '.url')
  [[ "$qd_l2_url" =~ $QD_URL_PATTERN ]] || fail "L2's url isn't http://gateway/api/v1/quick-deploy/tqd_ and 43 base64url characters"
  qd_l2_secret=${qd_l2_url##*/}
  # Both links' secrets and the bearer, before L2's command runs: every file it leaves is searched for them.
  qd_secrets "$qd_l1_secret" "$qd_l2_secret" "$install_bearer"
  qd_command "$qd_l2_url" /etc/otelcol install-qd2 true "$qd_dir/l2-command" ||
    fail "printing L2's Quick Deploy command in the API container failed, its error redacted: $(qd_redacted "$qd_dir/l2-command.err" 600)"
  install_containers="$install_containers $qd2_container"
  # The container ends 0 whatever the command's status (the files it left copied out, if any), so a failed
  # command reaches the status's check below, with its output redacted, rather than this run's. Its own error
  # output (none of the command's: that goes to /qd-out/output) can hold no secret: no secret is in its argv,
  # its environment or its script.
  docker run --pull never --name "$qd2_container" --network "$compose_network" \
    -v "$qd_dir/l2-command:/qd/command:ro" -v "$qd_dir/bin:/qd/bin:ro" -v "$qd_dir/l2-out:/qd-out" \
    --entrypoint bash "$install_image" -c 'PATH=/qd/bin:$PATH bash /qd/command >/qd-out/output 2>&1; echo "$?" >/qd-out/status
      umask 022
      for file in /etc/otelcol/opamp.env /etc/systemd/system/telflo-supervisor.service; do
        stat -c "%a %u:%g %F" "$file"
      done >/qd-out/stats 2>&1
      cat /etc/otelcol/opamp.env >/qd-out/opamp.env 2>/dev/null
      cat /etc/systemd/system/telflo-supervisor.service >/qd-out/unit 2>/dev/null
      exit 0' >/dev/null ||
    fail "running L2's Quick Deploy command's container failed"
  # Every file it left that a check below prints or diffs, searched first (opamp.env, which holds the bearer, is
  # compared whole and never printed; the command's output is printed only redacted).
  qd_search "L2's command's exit status file" "$qd_dir/l2-out/status"
  qd_search "a shim's arguments in L2's command (its calls)" "$qd_dir/l2-out/calls"
  qd_search "the stat of opamp.env and the unit" "$qd_dir/l2-out/stats"
  qd_search "the unit L2's command wrote" "$qd_dir/l2-out/unit"
  [ "$(<"$qd_dir/l2-out/status")" = "0" ] ||
    fail "L2's Quick Deploy command exited $(<"$qd_dir/l2-out/status"), its last 20 lines redacted: $(qd_redact <"$qd_dir/l2-out/output" | tail -n 20)"
  [ "$(<"$qd_dir/l2-out/stats")" = "600 0:0 regular file
644 0:0 regular file" ] || fail "opamp.env and the unit aren't 0600 and 0644, root's: $(tr '\n' ';' <"$qd_dir/l2-out/stats")"
  qd_env=$(<"$qd_dir/l2-out/opamp.env")
  [ "$(wc -l <"$qd_dir/l2-out/opamp.env" | tr -d ' ')" = "1" ] && [ "$qd_env" = "OPAMP_TOKEN='Bearer $install_bearer'" ] ||
    fail "opamp.env isn't one line OPAMP_TOKEN='Bearer …' holding the install's bearer"
  unset qd_env
  cat >"$qd_dir/unit-expected" <<'UNIT'
[Unit]
Description=Telflo OpAMP Supervisor
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/etc/otelcol
ExecStart=/etc/otelcol/start_supervisor.sh "--OPAMP_SERVER_NAME=install-qd2"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  # The unit was searched above: its diff prints none of the secrets.
  diff -u "$qd_dir/unit-expected" "$qd_dir/l2-out/unit" >&2 || fail "the unit L2's command wrote isn't telflo-supervisor.service's text (above)"
  # L1's calls searched again, L2's secret now among the secrets: neither link's secret nor the bearer is on
  # its shims' arguments (a guard alone: no check below prints them).
  qd_search "a shim's arguments in L1's command (its calls)" "$qd_dir/l1-out/calls"
  [ "$(<"$qd_dir/l2-out/calls")" = "sudo mkdir -p /etc/otelcol
sudo tar -xzf - -C /etc/otelcol
sudo install -m 600 /dev/stdin /etc/otelcol/opamp.env
sudo install -m 644 /dev/stdin /etc/systemd/system/telflo-supervisor.service
sudo systemctl daemon-reload
systemctl daemon-reload
sudo systemctl enable telflo-supervisor.service
systemctl enable telflo-supervisor.service
sudo systemctl restart telflo-supervisor.service
systemctl restart telflo-supervisor.service" ] ||
    fail "L2's command's sudo and systemctl calls aren't the install, the unit and daemon-reload, enable and restart in order (its calls differ): $(qd_shown "$qd_dir/l2-out/calls")"

  step "the API's and the gateway's logs hold neither link's secret nor the bearer, and log the public route as /api/v1/quick-deploy/[redacted]: docker compose logs api gateway"
  (umask 077 && docker compose logs --no-color api gateway >"$qd_dir/logs" 2>&1) || fail "reading the API's and the gateway's logs failed"
  qd_logs_clean "$qd_dir/logs" ""
  grep -qF "GET /api/v1/quick-deploy/[redacted]" "$qd_dir/logs" ||
    fail "the gateway's access log doesn't name the public route's requests as GET /api/v1/quick-deploy/[redacted]"

  step "revoke L1: POST .../quick-deploy-links/:linkId/revoke; its download from the host is then 410 \"This install link is revoked: make a new one.\" in plain text, and its count stays 2"
  platform POST "$QD_LINKS_URL/$qd_l1_id/revoke"
  [ "$status" = "200" ] && [ "$(reply_json '.link.status == "revoked" and (.link.revokedAt | type) == "string"')" = "true" ] ||
    fail "revoking L1 returned HTTP $status: $(qd_reply_code)"
  qd_public_get "$qd_l1_url" l1-revoked
  qd_refused l1-revoked "This install link is revoked: make a new one." ||
    fail "L1's download once revoked returned HTTP $status, not 410 in plain text, redacted: $(qd_redacted "$qd_dir/l1-revoked" 300)"
  platform GET "$QD_LINKS_URL"
  [ "$status" = "200" ] && [ "$(reply_json --arg id "$qd_l1_id" '[.links[] | select(.id == $id) | .status == "revoked" and .downloadCount == 2] == [true]')" = "true" ] ||
    fail "L1 isn't listed revoked with its 2 downloads (the host's and install-qd1's): HTTP $status $(qd_reply -c --arg id "$qd_l1_id" '[.links[]? | select(.id == $id) | {status, downloadCount}]')"

  step "revoke the default token: POST .../tokens/:tokenId/revoke"
  platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/$managed_default_token_id/revoke"
  [ "$status" = "200" ] && [ "$(reply_json '.token.revokedAt | type')" = "string" ] ||
    fail "revoking the default token returned HTTP $status: $(qd_reply_code)"

  step "L2's download once the default token its command carries is revoked: 410 \"This link's token was revoked: make a new link.\" in plain text"
  qd_public_get "$qd_l2_url" l2-token-revoked
  qd_refused l2-token-revoked "This link's token was revoked: make a new link." ||
    fail "L2's download once the default token was revoked returned HTTP $status, not 410 in plain text, redacted: $(qd_redacted "$qd_dir/l2-token-revoked" 300)"

  step "the API's and the gateway's logs, after the two refusals, still hold neither link's secret nor the bearer, and log both refusals as GET /api/v1/quick-deploy/[redacted] … 410: docker compose logs api gateway"
  (umask 077 && docker compose logs --no-color api gateway >"$qd_dir/logs-after" 2>&1) || fail "reading the API's and the gateway's logs failed"
  qd_logs_clean "$qd_dir/logs-after" " after the refusals"
  # The positive half: the logs read are the ones holding the two refusals, so an empty or a truncated
  # file can't pass the check above. grep -c prints its count (0 too) unless the file can't be read: then the
  # count is empty and the comparison fails.
  qd_refusals=$(grep -cE '"GET /api/v1/quick-deploy/\[redacted\] HTTP/[0-9.]+" 410 ' -- "$qd_dir/logs-after" 2>/dev/null || true)
  [ -n "$qd_refusals" ] && [ "$qd_refusals" -ge 2 ] 2>/dev/null ||
    fail "the gateway's access log doesn't hold the two refusals as GET /api/v1/quick-deploy/[redacted] … 410 (${qd_refusals:-unread} such lines)"
  unset qd_l1_url qd_l1_secret qd_l2_url qd_l2_secret

  step "issue a new default token: POST .../tokens/default answers 201, no-store, a default token and its bearer; a second issue is 409 enrollment_token_default_exists"
  platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/default"
  [ "$status" = "201" ] || fail "issuing a new default token returned HTTP $status: $(reply_code)"
  no_store || fail "the new default token's reply, carrying a bearer, isn't Cache-Control: no-store"
  [ "$(reply_json --arg old "$managed_default_token_id" '.token.kind == "default" and .token.id != $old and (.token.bearer | type) == "string"')" = "true" ] ||
    fail "the new default token's reply isn't a new default token with its bearer"
  install_new_bearer=$(reply_json '.token.bearer')
  body=""
  platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/tokens/default"
  [ "$status" = "409" ] && [ "$(reply_code)" = "enrollment_token_default_exists" ] ||
    fail "a second new default token returned HTTP $status: $(reply_code)"

  step "re-run the container install with the new default token on the same volume: install-c1 reconnects, the same collector (its id and instance uid), and no new one enrolls (at most 60 polls)"
  docker rm -f "$install_container" >/dev/null || fail "removing the first container install failed"
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id"
  install_count_before=$(reply_json '.fleet.summary.collectors')
  [ "$status" = "200" ] && [[ "$install_count_before" =~ ^[0-9]+$ ]] ||
    fail "reading the fleet's collector count before the re-run returned HTTP $status: $(reply_code)"
  # Read once its container is gone: a later last seen is the new container's.
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$install_c1_id"
  install_seen_before=$(reply_json '.collector.lastSeenAt')
  [ "$status" = "200" ] && [ -n "$install_seen_before" ] && [ "$install_seen_before" != "null" ] ||
    fail "reading install-c1 before its re-run returned HTTP $status: $(reply_code)"
  install_run_args "$install_facts" "$install_container" "$install_volume" install-c1 "$compose_network" ||
    fail "the install's facts aren't ones the container install can be built from"
  OPAMP_TOKEN=$install_new_bearer docker "${install_args[@]}" >/dev/null || fail "re-running the container install failed"
  wait_for_managed_collector install-c1 60 "(.id == \"$install_c1_id\") and (.instanceUid == \"$install_c1_uid\") and (.lastSeenAt > \"$install_seen_before\") and (.groupId == \"$install_group_id\")"
  # A new enrollment would be named afresh (install-c1 is taken), so no name check finds it: the wait's id and
  # instance uid, and the fleet's collector count, do.
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id"
  [ "$status" = "200" ] && [ "$(reply_json '.fleet.summary.collectors')" = "$install_count_before" ] ||
    fail "the fleet's collectors went from $install_count_before to $(reply_json '.fleet.summary.collectors') with the re-run: it enrolled anew"

  # The group's delete deletes its collectors with it: read before it, the group's three collectors and the
  # fleet's count; after it, each collector 404 and the count down by three. The containers go first, so
  # none polls again meanwhile.
  step "remove the installed collectors, their volume and the group \"$install_group_name\", whose delete deletes its three collectors with it: each 404 collector_not_found, the fleet's count down by three"
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors?groupId=$install_group_id"
  install_group_collector_ids=$(reply_json '[.collectors[].id] | join(" ")')
  [ "$status" = "200" ] && [ "$(reply_json '[.collectors[].name] | sort == ["install-aio", "install-c1", "install-qd1"]')" = "true" ] ||
    fail "the group's collectors before its delete (HTTP $status) aren't install-c1, install-aio and install-qd1: $(reply_json -c '[.collectors[]?.name]')"
  install_cleanup_failed=""
  for container in $install_containers; do
    docker rm -f "$container" >/dev/null 2>&1 || install_cleanup_failed="$install_cleanup_failed the container $container;"
  done
  install_containers=""
  docker volume rm "$install_volume" >/dev/null 2>&1 || install_cleanup_failed="$install_cleanup_failed the volume $install_volume;"
  install_volume=""
  [ -z "$install_cleanup_failed" ] || fail "removing the installed collectors failed: $install_cleanup_failed"
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id"
  install_fleet_count_before=$(reply_json '.fleet.summary.collectors')
  [ "$status" = "200" ] && [[ "$install_fleet_count_before" =~ ^[0-9]+$ ]] ||
    fail "reading the fleet's collector count before the group's delete returned HTTP $status: $(reply_code)"
  platform DELETE "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$install_group_id"
  [ "$status" = "204" ] || fail "deleting the install's group returned HTTP $status: $(reply_code)"
  for install_collector_id in $install_group_collector_ids; do
    platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/collectors/$install_collector_id"
    [ "$status" = "404" ] && [ "$(reply_code)" = "collector_not_found" ] ||
      fail "the deleted group's collector $install_collector_id is still there: HTTP $status $(reply_code)"
  done
  platform GET "$GROUP_FLEETS_URL/$managed_fleet_id"
  [ "$status" = "200" ] && [ "$(reply_json '.fleet.summary.collectors')" = "$((install_fleet_count_before - 3))" ] ||
    fail "the fleet's collectors went from $install_fleet_count_before to $(reply_json '.fleet.summary.collectors') (HTTP $status) with its group's delete, not down by its three"
  unset install_bearer install_new_bearer
fi

# A Kubernetes fleet's groups through the platform: the platform keeps a
# group's Kubernetes settings in its annotations, under telflo.kubernetes
# ({role, namespace, replicas (a gateway's only), volumes}), and checks them
# by the fleet's type. In the group organization: a server fleet's group
# (edge-b1's fleet's) refuses the key; a kubernetes-supervisor fleet made
# through the platform (its id chosen and recorded first, as edge-b1's
# fleet's) lists its Default group (the Agent) alone; the Cluster (named
# cluster, role cluster) and a gateway (role gateway, with replicas and a
# hostPath volume) are made, each answered with its annotations as sent (the
# platform passes them through as the opamp-server stores them: no defaults
# added); that fleet's creates refuse telflo.dockerMounts, a gateway named
# node, a role not the name's and a create carrying no telflo.kubernetes, and
# its groups any rename (409 collector_group_name_fixed); none of the refused
# is written. The update side: the server group "unassigned-b" refuses the
# key, the Kubernetes fleet's Default group (the Agent, role node whether
# stored or not) refuses a save naming the role gateway, and the gateway
# refuses a save of annotations without its settings (once written, a
# Kubernetes group's settings are never dropped), none written; its first
# save, naming node, is answered 200 with its annotations as sent. Then the
# gateway is deleted (204), then the fleet (204). The fleet's create carries
# its bearers: never printed, the body dropped at once. A failed refusal
# prints the status, the error code and the details' field paths only (never a
# name, namespace or path). A run that ends inside these steps removes the
# fleet (the EXIT trap: remove_managed_steps).
# k8s_refused <status> <code> [<field path>]: whether the last reply is that
# refusal, naming that field (a detail's instancePath) when one is given.
k8s_refused() {
  [ "$status" = "$1" ] && [ "$(reply_code)" = "$2" ] &&
    { [ $# -lt 3 ] || [ "$(reply_json --arg p "$3" 'any(.error.details[]?; .instancePath == $p)')" = "true" ]; }
}
# What a failed refusal prints: its status, error code and the details' field paths.
k8s_refusal_seen() { echo "HTTP $status $(reply_code) at $(reply_json -c '[.error.details[]?.instancePath]')"; }
# k8s_group_names: the last reply's (a group list's) names, Default as "(default)", sorted, one line.
k8s_group_names() { reply_json -c '[.groups[]? | if .isDefault then "(default)" else .name end] | sort'; }
K8S_GATEWAY_KEY=$(jq -cn '{role: "gateway", namespace: "telflo-smoke-gateways", replicas: 2,
  volumes: [{hostPath: "/var/log/telflo-smoke", hostPathType: "DirectoryOrCreate", mountPath: "/var/log/telflo-smoke", readOnly: true}]}')
K8S_CLUSTER_KEY='{"role":"cluster","namespace":"telflo-collectors","volumes":[]}'
K8S_NODE_KEY='{"role":"node","namespace":"telflo-collectors","volumes":[]}'
# k8s_key_absent <group id>: whether the last reply is that group, holding no
# telflo key in its annotations (nothing written there).
k8s_key_absent() {
  [ "$(reply_json --arg id "$1" '.group.id == $id and ((.group.annotations // {}) | has("telflo") | not)')" = "true" ]
}

step "a server fleet's group refuses the annotations' Kubernetes key: POST .../groups answers 400 invalid_request at annotations.telflo.kubernetes"
platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/groups" "$(jq -cn --argjson k "$K8S_GATEWAY_KEY" '{name: "k8s-on-server", annotations: {telflo: {kubernetes: $k}}}')"
k8s_refused 400 invalid_request /annotations/telflo/kubernetes ||
  fail "a server fleet's group with the Kubernetes key wasn't refused at annotations.telflo.kubernetes: $(k8s_refusal_seen)"

k8s_hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
k8s_fleet_id="${k8s_hex:0:8}-${k8s_hex:8:4}-4${k8s_hex:13:3}-$(printf '%x' $(((0x${k8s_hex:16:2} & 0x3f) | 0x80)))${k8s_hex:18:2}-${k8s_hex:20:12}"
[[ "$k8s_fleet_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "couldn't make a UUID for the Kubernetes fleet: $k8s_fleet_id"
K8S_FLEET_URL="$GROUP_FLEETS_URL/$k8s_fleet_id"
step "create a kubernetes-supervisor fleet through the platform: POST .../fleets answers 201 and its Default group; its groups list the Default group alone"
platform POST "$GROUP_FLEETS_URL" "$(jq -cn --arg id "$k8s_fleet_id" --arg label "stack-smoke-k8s-$(date +%s)-$$" \
  '{id: $id, label: $label, type: "kubernetes-supervisor", rotateExpiresAt: null}')"
body=""
[ "$status" = "201" ] || fail "creating the Kubernetes fleet returned HTTP $status: $(reply_code)"
[ "$(reply_json '.fleet.type')" = "kubernetes-supervisor" ] && [ "$(reply_json '.defaultGroup.isDefault')" = "true" ] ||
  fail "the Kubernetes fleet's creation didn't answer a kubernetes-supervisor fleet with its Default group"
k8s_default_group_id=$(reply_json '.defaultGroup.id')
# Its default token's id (not its bearer): the Helm install's link names it.
k8s_default_token_id=$(reply_json '.tokens.default.id')
: >"$PLATFORM_REPLY_BODY"
platform GET "$K8S_FLEET_URL/groups"
[ "$status" = "200" ] && [ "$(reply_json --arg id "$k8s_default_group_id" '(.groups | length) == 1 and .groups[0].id == $id and .groups[0].isDefault')" = "true" ] ||
  fail "the new Kubernetes fleet's groups (HTTP $status) aren't its Default group alone: $(k8s_group_names)"

step "create the Cluster (named cluster, role cluster) and a gateway (role gateway, 2 replicas, a hostPath volume): POST .../groups answers 201 and each group's annotations as sent"
platform POST "$K8S_FLEET_URL/groups" "$(jq -cn --argjson k "$K8S_CLUSTER_KEY" '{name: "cluster", annotations: {telflo: {kubernetes: $k}}}')"
[ "$status" = "201" ] && [ "$(reply_json --argjson k "$K8S_CLUSTER_KEY" '.group.name == "cluster" and (.group.isDefault | not) and .group.annotations == {telflo: {kubernetes: $k}}')" = "true" ] ||
  fail "creating the Cluster answered $(k8s_refusal_seen), or not the Cluster with its annotations as sent"
platform POST "$K8S_FLEET_URL/groups" "$(jq -cn --argjson k "$K8S_GATEWAY_KEY" '{name: "gw-smoke", annotations: {telflo: {kubernetes: $k}}}')"
[ "$status" = "201" ] && [ "$(reply_json --argjson k "$K8S_GATEWAY_KEY" '.group.name == "gw-smoke" and .group.annotations == {telflo: {kubernetes: $k}}')" = "true" ] ||
  fail "creating the gateway answered $(k8s_refusal_seen), or not the gateway with its annotations as sent"
k8s_gateway_id=$(reply_json '.group.id')

step "the Kubernetes fleet's creates refuse telflo.dockerMounts (400 at annotations.telflo.dockerMounts), a gateway named node (400 at name), a role not the name's (400 at annotations.telflo.kubernetes.role) and no telflo.kubernetes at all (400 at annotations.telflo.kubernetes), and its groups a rename (409 collector_group_name_fixed); none is written"
platform POST "$K8S_FLEET_URL/groups" "$(jq -cn --argjson k "$K8S_GATEWAY_KEY" \
  '{name: "gw-mounts", annotations: {telflo: {kubernetes: $k, dockerMounts: [{hostPath: "/var/log/telflo-smoke", containerPath: "/var/log/telflo-smoke", readOnly: true}]}}}')"
k8s_refused 400 invalid_request /annotations/telflo/dockerMounts ||
  fail "a Kubernetes fleet's group with telflo.dockerMounts wasn't refused at annotations.telflo.dockerMounts: $(k8s_refusal_seen)"
platform POST "$K8S_FLEET_URL/groups" "$(jq -cn --argjson k "$K8S_GATEWAY_KEY" '{name: "node", annotations: {telflo: {kubernetes: $k}}}')"
k8s_refused 400 invalid_request /name || fail "a gateway named node wasn't refused at name: $(k8s_refusal_seen)"
platform POST "$K8S_FLEET_URL/groups" "$(jq -cn --argjson k "$K8S_CLUSTER_KEY" '{name: "gw-mismatch", annotations: {telflo: {kubernetes: $k}}}')"
k8s_refused 400 invalid_request /annotations/telflo/kubernetes/role ||
  fail "a gateway's create with the role cluster wasn't refused at annotations.telflo.kubernetes.role: $(k8s_refusal_seen)"
# A create carrying no telflo.kubernetes: its settings are required.
platform POST "$K8S_FLEET_URL/groups" '{"name": "gw-bare"}'
k8s_refused 400 invalid_request /annotations/telflo/kubernetes ||
  fail "a gateway's create with no Kubernetes settings wasn't refused at annotations.telflo.kubernetes: $(k8s_refusal_seen)"
platform PATCH "$K8S_FLEET_URL/groups/$k8s_gateway_id" '{"name": "gw-renamed"}'
k8s_refused 409 collector_group_name_fixed || fail "a Kubernetes group's rename wasn't refused 409 collector_group_name_fixed: $(k8s_refusal_seen)"
platform GET "$K8S_FLEET_URL/groups"
[ "$status" = "200" ] && [ "$(k8s_group_names)" = '["(default)","cluster","gw-smoke"]' ] ||
  fail "after the refusals, the Kubernetes fleet's groups (HTTP $status) aren't the Default group, cluster and gw-smoke: $(k8s_group_names)"

step "the update side: a server group's save with telflo.kubernetes (400 at annotations.telflo.kubernetes), the Kubernetes Default group's save naming the role gateway (400 at annotations.telflo.kubernetes.role) and the gateway's save of annotations without its settings (400 at annotations.telflo.kubernetes) are refused, none written; the Default group's save naming node is answered 200 with its annotations as sent"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_unassigned_group_id" "$(jq -cn --argjson k "$K8S_GATEWAY_KEY" '{annotations: {telflo: {kubernetes: $k}}}')"
k8s_refused 400 invalid_request /annotations/telflo/kubernetes ||
  fail "a server fleet's group's save with the Kubernetes key wasn't refused at annotations.telflo.kubernetes: $(k8s_refusal_seen)"
platform GET "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_unassigned_group_id"
[ "$status" = "200" ] && k8s_key_absent "$managed_unassigned_group_id" ||
  fail "after the refused save, the server group \"unassigned-b\" (HTTP $status) holds the platform's key: $(reply_json -c '.group.annotations | if type == "object" then keys else type end')"
platform PATCH "$K8S_FLEET_URL/groups/$k8s_default_group_id" "$(jq -cn --argjson k "$K8S_GATEWAY_KEY" '{annotations: {telflo: {kubernetes: $k}}}')"
k8s_refused 400 invalid_request /annotations/telflo/kubernetes/role ||
  fail "the Default group's save naming the role gateway wasn't refused at annotations.telflo.kubernetes.role: $(k8s_refusal_seen)"
platform GET "$K8S_FLEET_URL/groups/$k8s_default_group_id"
[ "$status" = "200" ] && k8s_key_absent "$k8s_default_group_id" ||
  fail "after the refused save, the Kubernetes fleet's Default group (HTTP $status) holds the platform's key: $(reply_json -c '.group.annotations | if type == "object" then keys else type end')"
platform PATCH "$K8S_FLEET_URL/groups/$k8s_gateway_id" '{"annotations": {"acme": 1}}'
k8s_refused 400 invalid_request /annotations/telflo/kubernetes ||
  fail "the gateway's save of annotations without its settings wasn't refused at annotations.telflo.kubernetes: $(k8s_refusal_seen)"
platform GET "$K8S_FLEET_URL/groups/$k8s_gateway_id"
[ "$status" = "200" ] && [ "$(reply_json --argjson k "$K8S_GATEWAY_KEY" '.group.annotations == {telflo: {kubernetes: $k}}')" = "true" ] ||
  fail "after the refused save, the gateway (HTTP $status) doesn't hold its settings as created: $(reply_json -c '.group.annotations | if type == "object" then keys else type end')"
platform PATCH "$K8S_FLEET_URL/groups/$k8s_default_group_id" "$(jq -cn --argjson k "$K8S_NODE_KEY" '{annotations: {telflo: {kubernetes: $k}}}')"
[ "$status" = "200" ] && [ "$(reply_json --argjson k "$K8S_NODE_KEY" '.group.isDefault and .group.annotations == {telflo: {kubernetes: $k}}')" = "true" ] ||
  fail "the Default group's save naming node answered $(k8s_refusal_seen), or not the Default group with its annotations as sent"

# The Helm install through the platform, in that Kubernetes fleet, before its
# gateway's and its own delete. No collector image and no cluster: the values
# file and the switch are the platform's (the real install is
# scripts/check-helm-install.sh).
# The Default group's published version in edge-b1's fleet is assigned to the
# Agent and the gateway; their Helm facts are read (no-store, no bearer: the
# chart, the image's repository, the release, role, namespace, replicas,
# volumes); the Linux bundle and a Linux link are refused on this fleet, and a
# Helm link on edge-b1's server fleet, each 409 fleet_type_not_installable in
# its direction's words; the organization's "Public install links" switch
# reads on; a Helm values link is made for the Agent (201, no-store, its
# choices by kind) and downloaded from the host through the gateway with no
# session: 200 text/yaml; charset=utf-8, no-store, nosniff, no-referrer,
# attachment values.yaml, its fixed lines, one token line of a bearer's shape,
# and the whole file byte for byte the contracts' helmValuesYaml of the
# Agent's facts and that token (printed in the API container: qd_command's
# way, the token by name only); then the switch is turned off by its PATCH
# (the download 403 "Install links are turned off for this organization." in
# plain text, a Helm and a Linux link's create 409
# public_install_links_disabled, the count unchanged), on again (the download
# 200 again, its token not the first's, made from a client container on the
# compose network, whose quick_deploy_link.downloaded audit row, read by the
# link's id through stack_psql, holds that container's address, never the
# gateway's: the API sees the client behind the gateway,
# TELFLO_TRUST_PROXY_HOPS "1" with default.conf's X-Forwarded-For), the link
# revoked (its download 410); the API's and the gateway's logs hold neither
# the link's secret nor either downloaded token, and log
# exactly the four public requests as GET /api/v1/quick-deploy/[redacted]
# with their statuses (counted from the logs read before the first).
#
# The values file holds the bearer by design: it is never printed, never
# searched for a bearer's shape (the quick-deploy check, inverted
# here), and its token, read by bash's own regex match (on no command
# line), joins the secrets file (qd_secrets) before anything is compared or
# printed, as each download's does: each reveal seals a new text. Every
# diagnostic goes through the quick-deploy guards (qd_search, qd_reply_code,
# qd_shown). The link's base is the API's TELFLO_PUBLIC_API_URL whatever it
# is: qd_public_get sends the request to $GATEWAY_URL, helm_client_get to
# http://gateway from its container. Four public requests:
# no limit binds. A run that ends among these steps leaves the fleet to the
# EXIT trap and the switch as it was then, on the smoke's own group
# organization: deleted below on a successful run, left (turned off,
# perhaps) in the throwaway stack by a failed one, which is harmless.
# The platform's own chart and image: the settings' defaults.
HELM_CHART_REFERENCE="oci://ghcr.io/telflo/telflo/charts/supervisor-collector"
HELM_CHART_VERSION="0.2.0"
HELM_IMAGE_REPOSITORY="ghcr.io/telflo/telflo/collector"
HELM_TOKEN_LINE='^token: "([A-Za-z0-9+/]+={0,2})"$'
# helm_token_of <file>: the values file's one token line's bearer, into $helm_token ("" unless exactly one line
# has a bearer's shape); bash's own read and match, so the bearer is on no command line.
helm_token_of() {
  local line found=0
  helm_token=""
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ $HELM_TOKEN_LINE ]] && [ "${#BASH_REMATCH[1]}" -ge 100 ]; then
      helm_token=${BASH_REMATCH[1]}
      found=$((found + 1))
    fi
  done <"$1"
  [ "$found" = "1" ] || helm_token=""
}
# helm_values_built <facts file> <file>: the contracts' helmValuesYaml(helmValuesInputOf(facts, $helm_token, [])),
# printed in the API container (its working directory /app/apps/api; the image's compiled @telflo/contracts), into
# <file>, 0600, its error output into <file>.err, 0600 (printed only redacted). The token reaches it by name only.
helm_values_built() {
  local script='import { HelmInstallFactsSchema, helmValuesInputOf, helmValuesYaml } from "@telflo/contracts";
const facts = HelmInstallFactsSchema.parse(JSON.parse(process.env.HV_FACTS));
process.stdout.write(helmValuesYaml(helmValuesInputOf(facts, process.env.HV_TOKEN, [])));'
  (umask 077 && HV_FACTS=$(<"$1") HV_TOKEN=$helm_token \
    docker compose exec -T -e HV_FACTS -e HV_TOKEN api \
    node --input-type=module -e "$script" >"$2" 2>"$2.err")
}
# helm_client_get <url> <name> <base>: qd_public_get's GET of the link, made instead from a client container on the
# compose network ($compose_project-helm-client, the gateway's own image, `--pull never`, removed after it, and by
# the EXIT trap as edge-b1's and edge-b2's containers are): the link's base <base> replaced by http://gateway, the
# link a config line on curl's standard input (on no command line); the body and the headers copied out into
# $qd_dir/<name> and $qd_dir/<name>.headers (0600), the status into $status, the container's and the gateway's
# addresses on the compose network (docker inspect) into $helm_client_ip and $helm_gateway_ip.
helm_client_get() {
  local container="$compose_project-helm-client" gateway_container image
  gateway_container=$(docker compose ps -q gateway)
  [ -n "$gateway_container" ] || fail "no gateway container in this compose project"
  image=$(docker inspect --format '{{.Config.Image}}' "$gateway_container") || fail "couldn't read the gateway's image"
  helm_gateway_ip=$(docker inspect --format "{{with index .NetworkSettings.Networks \"$compose_network\"}}{{.IPAddress}}{{end}}" "$gateway_container") ||
    fail "couldn't read the gateway's address on $compose_network"
  [ -n "$helm_gateway_ip" ] || fail "the gateway has no address on the compose network $compose_network"
  managed_containers="$managed_containers $container"
  docker run -d --pull never --name "$container" --network "$compose_network" --entrypoint sleep "$image" 300 >/dev/null ||
    fail "starting the client container $container from $image failed"
  helm_client_ip=$(docker inspect --format "{{with index .NetworkSettings.Networks \"$compose_network\"}}{{.IPAddress}}{{end}}" "$container") ||
    fail "couldn't read the client container's address on $compose_network"
  [ -n "$helm_client_ip" ] || fail "the client container has no address on the compose network $compose_network"
  status=$(printf 'url = "%s"\n' "http://gateway${1#"$3"}" |
    docker exec -i "$container" curl -q -g -s --max-time 60 -K - -o /tmp/values -D /tmp/headers -w '%{http_code}' || true)
  (umask 077 && docker exec "$container" cat /tmp/values >"$qd_dir/$2" && docker exec "$container" cat /tmp/headers >"$qd_dir/$2.headers") ||
    fail "the client container's download returned HTTP $status, and its body or headers couldn't be copied out"
  docker rm -f "$container" >/dev/null || fail "removing the client container $container failed"
  managed_containers=${managed_containers/" $container"/}
}
# helm_refused <status> <code> <message>: whether the last reply is that refusal, in those words.
helm_refused() {
  [ "$status" = "$1" ] && [ "$(reply_code)" = "$2" ] && [ "$(reply_json '.error.message')" = "$3" ]
}
FLEET_TYPE_NOT_INSTALLABLE_WORDS="A Kubernetes-supervisor fleet's collectors are installed with Helm: use Install with Helm."
FLEET_TYPE_NOT_HELM_INSTALLABLE_WORDS="A server fleet's groups have no Helm install: use Install collector."
LINKS_DISABLED_WORDS="Public install links are turned off for this organization: an admin can turn them on in Settings → Organization."
LINKS_DISABLED_DOWNLOAD_WORDS="Install links are turned off for this organization."
HELM_SETTINGS_URL="$GROUP_ORGANIZATION_URL/settings"
HELM_LINKS_URL="$K8S_FLEET_URL/quick-deploy-links"

step "assign the published version of edge-b1's fleet's Default group to the Kubernetes fleet's Agent and gateway: PATCH .../groups/:groupId answers each with it"
for helm_group_id in "$k8s_default_group_id" "$k8s_gateway_id"; do
  platform PATCH "$K8S_FLEET_URL/groups/$helm_group_id" "$(jq -cn --arg v "$managed_version_id" '{assignedVersionId: $v}')"
  [ "$status" = "200" ] && [ "$(reply_json --arg v "$managed_version_id" '.group.assignedVersion.versionId == $v')" = "true" ] ||
    fail "assigning the published version to the Kubernetes group $helm_group_id answered $(k8s_refusal_seen)"
done

helm_agent_facts="$qd_dir/helm-agent-facts.json"
step "read the Agent's Helm facts: GET .../groups/:groupId/install answers no-store, no bearer, $install_image, this stack's endpoint, chart $HELM_CHART_VERSION, release telflo-node in telflo-collectors, fullnameOverride ${k8s_fleet_id:0:8}-default, no replicas, no volumes"
platform GET "$K8S_FLEET_URL/groups/$k8s_default_group_id/install"
[ "$status" = "200" ] || fail "reading the Agent's Helm facts returned HTTP $status: $(reply_code)"
no_store || fail "the Agent's Helm facts, carrying configuration text, aren't Cache-Control: no-store"
if [ "$(reply_json '[.. | objects | has("bearer")] | any')" != "false" ] || grep -qE '[A-Za-z0-9+/]{100,}' "$PLATFORM_REPLY_BODY"; then
  fail "the Agent's Helm facts carry a bearer, or a run of 100 or more base64 characters"
fi
[ "$(reply_json --arg image "$install_image" --arg v "$catalog_default" --arg endpoint "$server_url" --arg g "$k8s_default_group_id" \
    --arg chart "$HELM_CHART_REFERENCE" --arg chartVersion "$HELM_CHART_VERSION" --arg repository "$HELM_IMAGE_REPOSITORY" \
    --arg o "${k8s_fleet_id:0:8}-default" '
    (.allowInsecureConnections | type) == "boolean" and del(.allowInsecureConnections) == {
      imageTag: $image, endpoint: $endpoint, collector: {distribution: "otelcol-contrib", version: $v}, envVarNames: [], groupId: $g,
      helm: {chartReference: $chart, chartVersion: $chartVersion, imageRepository: $repository, release: "telflo-node", fullnameOverride: $o,
        role: "node", namespace: "telflo-collectors", replicas: null, volumes: []}}')" = "true" ] ||
  fail "the Agent's Helm facts aren't its group's, this stack's endpoint ($server_url), $install_image, chart $HELM_CHART_REFERENCE $HELM_CHART_VERSION and fullnameOverride ${k8s_fleet_id:0:8}-default (TELFLO_COLLECTOR_IMAGE_REPOSITORY and TELFLO_HELM_CHART_* must be the defaults for these steps): $(reply_json -c '{imageTag, endpoint, groupId, envVarNames, helm: (.helm | {chartReference, chartVersion, imageRepository, fullnameOverride, role, replicas})}')"
(umask 077 && cp "$PLATFORM_REPLY_BODY" "$helm_agent_facts")

step "read the gateway's Helm facts: no-store, no bearer, its release gw-smoke, no fullnameOverride, role gateway, namespace, 2 replicas and its volume as saved"
platform GET "$K8S_FLEET_URL/groups/$k8s_gateway_id/install"
[ "$status" = "200" ] || fail "reading the gateway's Helm facts returned HTTP $status: $(reply_code)"
no_store || fail "the gateway's Helm facts, carrying configuration text, aren't Cache-Control: no-store"
# No bearer (as in the install facts), grep's status tested (qd_none: an unread reply fails the run).
if [ "$(reply_json '[.. | objects | has("bearer")] | any')" != "false" ] ||
  ! qd_none "the gateway's Helm facts" -E '[A-Za-z0-9+/]{100,}' -- "$PLATFORM_REPLY_BODY"; then
  fail "the gateway's Helm facts carry a bearer, or a run of 100 or more base64 characters"
fi
[ "$(reply_json --argjson k "$K8S_GATEWAY_KEY" --arg g "$k8s_gateway_id" '.groupId == $g and .helm.release == "gw-smoke" and .helm.role == "gateway"
    and (.helm | has("fullnameOverride")) and .helm.fullnameOverride == null
    and .helm.namespace == $k.namespace and .helm.replicas == $k.replicas and .helm.volumes == $k.volumes')" = "true" ] ||
  fail "the gateway's Helm facts aren't its release, no fullnameOverride, role, namespace, replicas and volume as saved: $(reply_json -c '.helm | if type == "object" then {release, fullnameOverride, role, replicas} else type end')"

step "each install refuses the other fleet type in its direction's words: the Linux bundle and a Linux link on the Kubernetes fleet's Agent, a Helm link on edge-b1's server fleet (409 fleet_type_not_installable each)"
platform POST "$K8S_FLEET_URL/groups/$k8s_default_group_id/install-bundle" '{"method": "all-in-one", "arch": "amd64", "rootPath": "/etc/otelcol", "env": []}'
helm_refused 409 fleet_type_not_installable "$FLEET_TYPE_NOT_INSTALLABLE_WORDS" ||
  fail "the Linux bundle on the Kubernetes fleet's Agent answered HTTP $status $(reply_code), not 409 fleet_type_not_installable in the Kubernetes direction's words"
platform POST "$K8S_FLEET_URL/groups/$k8s_default_group_id/quick-deploy-links" \
  '{"method": "all-in-one", "arch": "amd64", "rootPath": "/etc/otelcol", "env": [], "systemd": false}'
helm_refused 409 fleet_type_not_installable "$FLEET_TYPE_NOT_INSTALLABLE_WORDS" ||
  fail "a Linux link on the Kubernetes fleet's Agent answered HTTP $status $(qd_reply_code), not 409 fleet_type_not_installable in the Kubernetes direction's words"
platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_default_group_id/quick-deploy-links" '{"kind": "helm", "env": []}'
helm_refused 409 fleet_type_not_installable "$FLEET_TYPE_NOT_HELM_INSTALLABLE_WORDS" ||
  fail "a Helm link on edge-b1's server fleet answered HTTP $status $(qd_reply_code), not 409 fleet_type_not_installable in the server direction's words"

step "the organization's settings: GET .../settings answers publicInstallLinks true (the default)"
platform GET "$HELM_SETTINGS_URL"
[ "$status" = "200" ] && [ "$(reply_json -c '.')" = '{"publicInstallLinks":true}' ] ||
  fail "reading the organization's settings returned HTTP $status: $(reply_code) $(reply_json -c 'if type == "object" then keys else type end')"

step "make a Helm values link for the Agent: POST .../groups/:groupId/quick-deploy-links {kind: helm} answers 201, no-store, its url, the default token's id and its choices by kind"
helm_public_api_url=$(docker compose exec -T api printenv TELFLO_PUBLIC_API_URL) || fail "couldn't read the API's TELFLO_PUBLIC_API_URL"
platform POST "$K8S_FLEET_URL/groups/$k8s_default_group_id/quick-deploy-links" '{"kind": "helm", "env": []}'
[ "$status" = "201" ] || fail "making the Helm link returned HTTP $status: $(qd_reply_code)"
no_store || fail "the Helm link's reply, carrying the link's secret, isn't Cache-Control: no-store"
helm_url=$(reply_json '.url')
helm_secret=${helm_url#"$helm_public_api_url/api/v1/quick-deploy/"}
[ "$helm_secret" != "$helm_url" ] && [[ "$helm_secret" =~ ^tqd_[A-Za-z0-9_-]{43}$ ]] ||
  fail "the Helm link's url isn't the API's TELFLO_PUBLIC_API_URL ($helm_public_api_url), /api/v1/quick-deploy/, tqd_ and 43 base64url characters"
# The link's secret first: every reply, file and output below is searched for it.
qd_secrets "$helm_secret"
helm_link_id=$(reply_json '.link.id')
[ "$(reply_json --arg g "$k8s_default_group_id" --arg t "$k8s_default_token_id" '
    .link.groupId == $g and .link.defaultTokenId == $t and .link.status == "active" and .link.downloadCount == 0
    and .link.revokedAt == null and (.link.expiresAt | type) == "string"
    and .link.choices == {kind: "helm", role: "node", release: "telflo-node", namespace: "telflo-collectors", envNames: []}')" = "true" ] ||
  fail "the Helm link isn't the Agent's, on the fleet's default token, active with no download, its choices kind helm, telflo-node in telflo-collectors: $(qd_reply -c '.link | if type == "object" then {status, downloadCount, choices} else type end')"

# The gateway's access log before the Helm link's first download: the positive half of the logs' check (below)
# counts exactly the lines this block adds, the quick-deploy links' downloads (when the install steps ran)
# logged the same way.
# helm_access_count <status> <file>: the lines GET /api/v1/quick-deploy/[redacted] … <status> in <file>; grep -c
# prints its count (0 too) unless the file can't be read (then nothing).
helm_access_count() {
  grep -cE "\"GET /api/v1/quick-deploy/\\[redacted\\] HTTP/[0-9.]+\" $1 " -- "$2" 2>/dev/null || true
}
(umask 077 && docker compose logs --no-color api gateway >"$qd_dir/helm-logs-before" 2>&1) ||
  fail "reading the API's and the gateway's logs before the Helm link's downloads failed"

step "download the Helm link from the host through the gateway, with no session: 200, text/yaml; charset=utf-8, no-store, nosniff, no-referrer, attachment values.yaml; its fixed lines, one token line of a bearer's shape (never printed)"
qd_public_get "$helm_url" helm-values "$helm_public_api_url"
# Its headers searched first (none of the public route's may hold a secret): a failure below prints them.
qd_search "the Helm link's download's headers" "$qd_dir/helm-values.headers"
[ "$status" = "200" ] || fail "downloading the Helm link returned HTTP $status, redacted: $(qd_redacted "$qd_dir/helm-values" 300)"
qd_header_is helm-values content-type "text/yaml; charset=utf-8" && qd_header_is helm-values cache-control no-store &&
  qd_header_is helm-values x-content-type-options nosniff && qd_header_is helm-values referrer-policy no-referrer &&
  qd_header_is helm-values content-disposition 'attachment; filename="values.yaml"' ||
  fail "the Helm link's download isn't text/yaml; charset=utf-8, no-store, nosniff, no-referrer, attachment values.yaml: $(grep -iE '^(content-type|cache-control|x-content-type-options|referrer-policy|content-disposition):' "$qd_dir/helm-values.headers" | tr -d '\r' | tr '\n' ' ')"
qd_none "the Helm link's download's headers" -i '^set-cookie:' -- "$qd_dir/helm-values.headers" || fail "the Helm link's download sets a cookie"
# The token by its line (the pattern alone is grep's argument), then into the secrets file before anything else.
helm_token_lines=$(grep -cE '^token: "[A-Za-z0-9+/]{100,}={0,2}"$' -- "$qd_dir/helm-values" || true)
helm_token_of "$qd_dir/helm-values"
[ "$helm_token_lines" = "1" ] && [ -n "$helm_token" ] ||
  fail "the Helm link's values.yaml doesn't hold exactly one token line of a bearer's shape (${helm_token_lines:-unread} such lines; the file not printed)"
qd_secrets "$helm_secret" "$helm_token"
for helm_line in "# This file holds the fleet's default token: delete it once the release is installed." \
  'role: "node"' 'group: "node"' "fullnameOverride: \"${k8s_fleet_id:0:8}-default\"" "collectorGroupId: \"$k8s_default_group_id\"" \
  "  repository: \"$HELM_IMAGE_REPOSITORY\"" \
  "  tag: \"$catalog_default\"" "endpoint: \"$server_url\"" 'volumes: []'; do
  grep -qxF -- "$helm_line" "$qd_dir/helm-values" ||
    fail "the Helm link's values.yaml has no line $helm_line (the file not printed: it holds the bearer)"
done
qd_none "the Helm link's values.yaml" -E '^(replicas|collectorEnv):' -- "$qd_dir/helm-values" ||
  fail "the Agent's values.yaml has replicas or collectorEnv (the file not printed: it holds the bearer)"

step "the values.yaml is byte for byte the contracts' helmValuesYaml of the Agent's facts and its own token, printed in the API container (neither printed here)"
helm_values_built "$helm_agent_facts" "$qd_dir/helm-values-built" ||
  fail "printing the Agent's values in the API container failed, its error redacted: $(qd_redacted "$qd_dir/helm-values-built.err" 600)"
cmp -s -- "$qd_dir/helm-values" "$qd_dir/helm-values-built" ||
  fail "the Helm link's values.yaml isn't the contracts' helmValuesYaml of the Agent's facts and its token (neither file printed: both hold the bearer)"

step "the fleet's links list the Helm link active with one download, and no secret"
platform GET "$HELM_LINKS_URL"
if reply_holds "$helm_secret" || reply_holds "tqd_" || reply_holds "$helm_token"; then fail "the links' list holds the link's secret or the bearer"; fi
[ "$status" = "200" ] && [ "$(reply_json --arg id "$helm_link_id" '[.links[] | select(.id == $id) | .status == "active" and .downloadCount == 1 and .choices.kind == "helm"] == [true]')" = "true" ] ||
  fail "the links' list (HTTP $status) doesn't answer the Helm link active with one download: $(qd_reply_code)"

step "turn the organization's public install links off: PATCH .../settings answers false; the Helm link's download is then 403 \"$LINKS_DISABLED_DOWNLOAD_WORDS\" in plain text, a Helm and a Linux link's create 409 public_install_links_disabled, and the count stays 1"
platform PATCH "$HELM_SETTINGS_URL" '{"publicInstallLinks": false}'
[ "$status" = "200" ] && [ "$(reply_json -c '.')" = '{"publicInstallLinks":false}' ] || fail "turning the public install links off returned HTTP $status: $(reply_code)"
platform GET "$HELM_SETTINGS_URL"
[ "$status" = "200" ] && [ "$(reply_json '.publicInstallLinks')" = "false" ] || fail "the settings once turned off (HTTP $status) don't read publicInstallLinks false"
qd_public_get "$helm_url" helm-off "$helm_public_api_url"
qd_search "the refused Helm download's headers" "$qd_dir/helm-off.headers"
qd_refused helm-off "$LINKS_DISABLED_DOWNLOAD_WORDS" 403 ||
  fail "the Helm link's download while the links are off returned HTTP $status, not 403 in plain text, redacted: $(qd_redacted "$qd_dir/helm-off" 300)"
platform POST "$K8S_FLEET_URL/groups/$k8s_default_group_id/quick-deploy-links" '{"kind": "helm", "env": []}'
helm_refused 409 public_install_links_disabled "$LINKS_DISABLED_WORDS" ||
  fail "a Helm link's create while the links are off answered HTTP $status $(qd_reply_code), not 409 public_install_links_disabled in its words"
platform POST "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_default_group_id/quick-deploy-links" \
  '{"method": "all-in-one", "arch": "amd64", "rootPath": "/etc/otelcol", "env": [], "systemd": false}'
helm_refused 409 public_install_links_disabled "$LINKS_DISABLED_WORDS" ||
  fail "a Linux link's create on edge-b1's server fleet while the links are off answered HTTP $status $(qd_reply_code), not 409 public_install_links_disabled in its words"
platform GET "$HELM_LINKS_URL"
[ "$status" = "200" ] && [ "$(reply_json --arg id "$helm_link_id" '[.links[] | select(.id == $id) | .status == "active" and .downloadCount == 1] == [true]') $(reply_json '[.links[] | select(.choices.kind == "helm")] | length')" = "true 1" ] ||
  fail "while the links are off, the fleet's links (HTTP $status) aren't the one Helm link, active with its one download: $(qd_reply_code)"

step "turn them on again: PATCH .../settings answers true, and the Helm link's download, from a client container on the compose network, is 200 text/yaml again, with a token of its own (revealed anew)"
platform PATCH "$HELM_SETTINGS_URL" '{"publicInstallLinks": true}'
[ "$status" = "200" ] && [ "$(reply_json -c '.')" = '{"publicInstallLinks":true}' ] || fail "turning the public install links on again returned HTTP $status: $(reply_code)"
helm_first_token=$helm_token
helm_client_get "$helm_url" helm-on "$helm_public_api_url"
qd_search "the second Helm download's headers" "$qd_dir/helm-on.headers"
[ "$status" = "200" ] && qd_header_is helm-on content-type "text/yaml; charset=utf-8" ||
  fail "the Helm link's download once the links are on again returned HTTP $status, redacted: $(qd_redacted "$qd_dir/helm-on" 300)"
helm_token_of "$qd_dir/helm-on"
[ -n "$helm_token" ] || fail "the second download's values.yaml doesn't hold exactly one token line of a bearer's shape (the file not printed)"
qd_secrets "$helm_secret" "$helm_first_token" "$helm_token"
# Each reveal seals a new text: the second download's token isn't the first's ([ is a builtin: neither on argv).
[ "$helm_token" != "$helm_first_token" ] ||
  fail "the second download's token is the first download's: each reveal should seal a new text (neither printed)"
# The logs' search below finds the second token only if it joined the secrets file: the file holding it must then
# match the secrets file (qd_none's 1; grep's status tested, an unreadable file failing the run).
if qd_none "the second download's values.yaml" -F -f "$qd_dir/secrets" -- "$qd_dir/helm-on"; then
  fail "the secrets file doesn't hold the second download's token: the logs' search would miss it (neither printed)"
fi

# The per-IP limits and the audit's requester are the client's only when the API trusts the gateway's
# one hop (docker-compose.yml's TELFLO_TRUST_PROXY_HOPS "1", default.conf's X-Forwarded-For); with none trusted
# every client is the gateway. The link's downloaded rows by its id, oldest first (ids and addresses only: the
# metadata, which holds ids, isn't read); the second is the client container's.
step "the API sees the client's address behind the gateway: the second download's quick_deploy_link.downloaded audit row holds the client container's address ($helm_client_ip), not the gateway's ($helm_gateway_ip)"
[ "$helm_client_ip" != "$helm_gateway_ip" ] || fail "the client container's address is the gateway's ($helm_gateway_ip)"
helm_audit_ips=$(stack_psql -v id="$helm_link_id" <<'SQL'
select coalesce(host(ip_address), 'none') from audit_events
where action = 'quick_deploy_link.downloaded' and subject_type = 'quick_deploy_link' and subject_id = :'id'
order by occurred_at, id;
SQL
) || fail "reading the Helm link's downloaded audit rows failed: $(cat "$work_dir/stack-psql-stderr")"
helm_audit_rows=$(grep -c . <<<"$helm_audit_ips" || true)
helm_audit_second=$(sed -n 2p <<<"$helm_audit_ips")
helm_audit_note=""
[ "$helm_audit_second" != "$helm_gateway_ip" ] || helm_audit_note=": the gateway's, so the API trusts no hop (TELFLO_TRUST_PROXY_HOPS)"
[ "$helm_audit_rows" = "2" ] && [ "$helm_audit_second" = "$helm_client_ip" ] ||
  fail "the Helm link's quick_deploy_link.downloaded rows hold the addresses $(tr '\n' ' ' <<<"$helm_audit_ips")($helm_audit_rows rows), the second not the client container's $helm_client_ip$helm_audit_note"

step "revoke the Helm link: POST .../quick-deploy-links/:linkId/revoke; its download is then 410 \"This install link is revoked: make a new one.\" in plain text, and its count stays 2"
platform POST "$HELM_LINKS_URL/$helm_link_id/revoke"
[ "$status" = "200" ] && [ "$(reply_json '.link.status == "revoked" and .link.choices.kind == "helm"')" = "true" ] ||
  fail "revoking the Helm link returned HTTP $status: $(qd_reply_code)"
qd_public_get "$helm_url" helm-revoked "$helm_public_api_url"
qd_refused helm-revoked "This install link is revoked: make a new one." ||
  fail "the Helm link's download once revoked returned HTTP $status, not 410 in plain text, redacted: $(qd_redacted "$qd_dir/helm-revoked" 300)"
platform GET "$HELM_LINKS_URL"
[ "$status" = "200" ] && [ "$(reply_json --arg id "$helm_link_id" '[.links[] | select(.id == $id) | .status == "revoked" and .downloadCount == 2] == [true]')" = "true" ] ||
  fail "the Helm link isn't listed revoked with its 2 downloads: HTTP $status $(qd_reply -c --arg id "$helm_link_id" '[.links[]? | select(.id == $id) | {status, downloadCount}]')"

step "the API's and the gateway's logs hold neither the Helm link's secret nor either downloaded token, and log its downloads (200), the switch's refusal (403) and the revoked one's (410) as GET /api/v1/quick-deploy/[redacted]: docker compose logs api gateway"
(umask 077 && docker compose logs --no-color api gateway >"$qd_dir/helm-logs" 2>&1) || fail "reading the API's and the gateway's logs failed"
qd_logs_clean "$qd_dir/helm-logs" " after the Helm link's downloads"
# The positive half: the logs read hold the requests just made, so an empty or a truncated
# file can't pass the check above; exactly those, counted from the log read before the first download.
for helm_seen in "200 2" "403 1" "410 1"; do
  helm_code=${helm_seen% *}
  helm_before=$(helm_access_count "$helm_code" "$qd_dir/helm-logs-before")
  helm_count=$(helm_access_count "$helm_code" "$qd_dir/helm-logs")
  [ -n "$helm_before" ] && [ -n "$helm_count" ] && [ "$((helm_count - helm_before))" = "${helm_seen#* }" ] 2>/dev/null ||
    fail "the gateway's access log doesn't hold exactly ${helm_seen#* } new lines GET /api/v1/quick-deploy/[redacted] … $helm_code for the Helm link (${helm_before:-unread} before its downloads, ${helm_count:-unread} after)"
done
unset helm_url helm_secret helm_token helm_first_token

# Logos and the library, in the group organization, its admin's session (the switch above). Every call goes
# through platform() or platform_form(); the logo's public reads and the library link's downloads go from the
# host through the gateway with no cookie. The library link is a secret: it lives in shell variables, reaches
# curl on its standard input (qd_public_get), and is never printed; every failure here prints statuses, sizes
# and error codes only (qd_reply_code).
# platform_form <method> <url> <curl's form arguments>...: platform() with a multipart body, its parts in the
# order given (names and descriptions by --form-string: curl reads no @ or < in them); 120 s for 11 MiB.
platform_form() {
  local method=$1 url=$2
  shift 2
  status=$(umask 077 && : >"$PLATFORM_REPLY_BODY" && curl -s --max-time 120 -o "$PLATFORM_REPLY_BODY" -D "$PLATFORM_REPLY_HEADERS" \
    -w '%{http_code}' -b "$JAR" -X "$method" -H 'X-Telflo-CSRF: 1' "$@" "$url" || true)
  body=$(cat "$PLATFORM_REPLY_BODY")
}
# gateway_refused_too_large: the last reply is nginx's own 413 (its HTML page, no error code of the API's): the
# gateway refused the body before the API read it.
gateway_refused_too_large() {
  [ "$status" = "413" ] && grep -qiE '^content-type:[[:space:]]*text/html' "$PLATFORM_REPLY_HEADERS" &&
    [ "$(reply_code)" = "no error code" ]
}

# The session's access cookie is refreshed first (the steps above take minutes; it lasts 15). The session stays
# in the group organization: the /me step below checks it.
step "refresh the session's access cookie before the logo's steps: POST /api/v1/auth/refresh answers 200"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/refresh" \
  -H 'X-Telflo-CSRF: 1') || fail "refreshing before the logo's steps got no reply (curl exit $?)"
status=$(tail -n1 <<<"$response")
[ "$status" = "200" ] || fail "refreshing before the logo's steps returned HTTP $status: $(sed '$d' <<<"$response")"

LOGO_BYTES=2097152
step "set the group organization's logo through the gateway: PATCH /api/v1/organizations/:id multipart (its name, then a $LOGO_BYTES-byte PNG, at the gateway's 3 MiB location) answers 200 with a new logoId"
logo_file="$work_dir/logo.png"
{ printf '\211PNG\r\n\032\n'; head -c $((LOGO_BYTES - 8)) /dev/urandom; } >"$logo_file"
[ "$(wc -c <"$logo_file" | tr -d ' ')" = "$LOGO_BYTES" ] || fail "couldn't write the $LOGO_BYTES-byte logo"
platform_form PATCH "$GATEWAY_URL/api/v1/organizations/$group_id" \
  --form-string "name=$RENAMED_ORGANIZATION_NAME" -F "file=@$logo_file;type=image/png;filename=logo.png"
logo_id=$(reply_json '.organization.logoId // empty')
[ "$status" = "200" ] && [[ "$logo_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] &&
  [ "$(reply_json '.organization.id')" = "$group_id" ] && [ "$(reply_json '.organization.name')" = "$RENAMED_ORGANIZATION_NAME" ] ||
  fail "setting the logo returned HTTP $status: $(reply_code) (logoId ${logo_id:-none})"

step "/api/v1/auth/me names the group organization's new logo: organization.logoId"
platform GET "$GATEWAY_URL/api/v1/auth/me"
[ "$status" = "200" ] && [ "$(reply_json '.organization.id')" = "$group_id" ] && [ "$(reply_json '.organization.logoId')" = "$logo_id" ] ||
  fail "GET /api/v1/auth/me returned HTTP $status, its organization $(reply_json '.organization.id // empty') with logoId $(reply_json '.organization.logoId // empty'), not $group_id with $logo_id"

step "read the logo publicly through the gateway with no cookie: GET /api/v1/organization-logos/:organizationId/:logoId answers 200, its bytes, image/png, immutable, nosniff, CSP sandbox, CORP cross-origin, no Set-Cookie"
status=$(curl -s --max-time 30 -o "$qd_dir/logo-read" -D "$qd_dir/logo-read.headers" -w '%{http_code}' \
  "$GATEWAY_URL/api/v1/organization-logos/$group_id/$logo_id" || true)
[ "$status" = "200" ] || fail "the logo's public read returned HTTP $status"
cmp -s "$logo_file" "$qd_dir/logo-read" ||
  fail "the logo's public read answered $(wc -c <"$qd_dir/logo-read" | tr -d ' ') bytes, not the $LOGO_BYTES uploaded"
qd_header_is logo-read content-type image/png && qd_header_is logo-read cache-control "public, max-age=31536000, immutable" &&
  qd_header_is logo-read x-content-type-options nosniff && qd_header_is logo-read content-security-policy sandbox &&
  qd_header_is logo-read cross-origin-resource-policy cross-origin ||
  fail "the logo's public read's headers aren't image/png, immutable, nosniff, sandbox and cross-origin: $(grep -iE '^(content-type|cache-control|x-content-type-options|content-security-policy|cross-origin-resource-policy):' "$qd_dir/logo-read.headers" | tr -d '\r' | tr '\n' ';')"
qd_none "the logo's public read's headers" -i '^set-cookie:' -- "$qd_dir/logo-read.headers" || fail "the logo's public read sets a cookie"

# On s3: the logo is an object at its key (organizations/<id>/logos/<logoId>), its size the file's.
logo_key="organizations/$group_id/logos/$logo_id"
if [ "$file_store_kind" = "s3" ]; then
  step "S3: the object store holds the logo at its key with its size: the filer's metadata in object-store"
  object_metadata=$(object_store_json "$logo_key?metadata=true") ||
    fail "couldn't read, or the object store holds no object at, the logo's key"
  [ "$(jq -r '.FileSize' <<<"$object_metadata" 2>/dev/null)" = "$LOGO_BYTES" ] ||
    fail "the object store's object at the logo's key has another size: $(jq -c '{FileSize}' <<<"$object_metadata" 2>/dev/null)"
fi

step "a body over 3 MiB on the organization's path is the gateway's own 413 (nginx's page, before the API)"
logo_too_large="$work_dir/logo-too-large.png"
{ printf '\211PNG\r\n\032\n'; head -c $((3 * 1048576 + 1 - 8)) /dev/zero; } >"$logo_too_large"
platform_form PATCH "$GATEWAY_URL/api/v1/organizations/$group_id" \
  --form-string "name=$RENAMED_ORGANIZATION_NAME" -F "file=@$logo_too_large;type=image/png;filename=logo.png"
gateway_refused_too_large ||
  fail "a $((3 * 1048576 + 1))-byte logo returned HTTP $status ($(reply_code)), not the gateway's 413"

# switched_off <method> <url>: the route answers 404 not_found, as a path
# nothing serves, its site switch off (http/not-found-when.ts: before the
# session, the limits and the body). The CSRF header, so a write's 404 is
# the switch's, not the guard's 403.
switched_off() {
  local response code
  response=$(curl -s --max-time 30 -w '\n%{http_code}' -X "$1" "$2" -H 'X-Telflo-CSRF: 1' || true)
  status=$(tail -n1 <<<"$response")
  code=$(json_field '.error.code // empty' "$(sed '$d' <<<"$response")")
  [ "$status" = "404" ] && [ "$code" = "not_found" ] ||
    fail "$1 $2 returned HTTP $status ${code:-with no error code}, not 404 not_found"
}

# The library: off on the open-source defaults (TELFLO_LEARNING), its
# routes 404. On the SaaS's values, a product admin's file, as the regex
# library's product-admin steps above, only on a throwaway stack, with its
# own grant and clear of the flag.
if [ "$SMOKE_SITE" = "oss" ]; then
  library_steps="found the library's routes off (TELFLO_LEARNING: 404 not_found)"
  step "the library is off (TELFLO_LEARNING=false): GET /api/v1/library-files, POST /api/v1/library-files and GET /api/v1/library-links/:link answer 404 not_found"
  switched_off GET "$GATEWAY_URL/api/v1/library-files"
  switched_off POST "$GATEWAY_URL/api/v1/library-files"
  switched_off GET "$GATEWAY_URL/api/v1/library-links/tll_smoke"
elif throwaway_stack; then
  library_steps="had a product admin add a 10 MiB library file (11 MiB + 1 refused by the gateway), made its link and downloaded it through the gateway with no session (no tll_ in the logs), deleted it (its link then 404)"
  step "make the account a product admin by SQL on the stack's database: /api/v1/auth/me shows isProductAdmin true"
  product_admin true
  expect_product_admin true

  LIBRARY_BYTES=10485760
  step "as a product admin, add a library file: POST /api/v1/library-files multipart (name, description, a $LIBRARY_BYTES-byte file) answers 201, no-store"
  library_file="$work_dir/library.bin"
  head -c "$LIBRARY_BYTES" /dev/urandom >"$library_file"
  LIBRARY_FILE_NAME="Stack smoke library $(date +%s)-$$"
  platform_form POST "$GATEWAY_URL/api/v1/library-files" --form-string "name=$LIBRARY_FILE_NAME" \
    --form-string "description=Made by the stack smoke test" -F "file=@$library_file;type=application/octet-stream;filename=stack-smoke.bin"
  library_file_id=$(reply_json '.libraryFile.id // empty')
  # Until it's deleted below, the EXIT trap deletes its row if the run ends first.
  if [[ "$library_file_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    created_library_file_id=$library_file_id
  fi
  [ "$status" = "201" ] && [ -n "$created_library_file_id" ] || fail "adding the library file returned HTTP $status: $(reply_code)"
  no_store || fail "the library file's create isn't Cache-Control: no-store"
  [ "$(reply_json -c '.libraryFile | {name, description, fileName, sizeBytes}')" = "$(jq -cn --arg name "$LIBRARY_FILE_NAME" \
    --argjson size "$LIBRARY_BYTES" '{name: $name, description: "Made by the stack smoke test", fileName: "stack-smoke.bin", sizeBytes: $size}')" ] ||
    fail "the library file's create answered other fields: sizeBytes $(reply_json '.libraryFile.sizeBytes // empty'), fileName $(reply_json '.libraryFile.fileName // empty')"

  step "a library body over 11 MiB is the gateway's own 413 (nginx's page, before the API)"
  library_too_large="$work_dir/library-too-large.bin"
  head -c $((11 * 1048576 + 1)) /dev/zero >"$library_too_large"
  platform_form POST "$GATEWAY_URL/api/v1/library-files" --form-string "name=$LIBRARY_FILE_NAME too large" \
    --form-string "description=Made by the stack smoke test" -F "file=@$library_too_large;type=application/octet-stream;filename=too-large.bin"
  gateway_refused_too_large ||
    fail "an $((11 * 1048576 + 1))-byte library file returned HTTP $status ($(reply_code)), not the gateway's 413"

  step "make the file's link: POST /api/v1/library-files/:id/link answers 201, no-store, a path /api/v1/library-links/tll_ and 71 base64url characters (never printed)"
  platform POST "$GATEWAY_URL/api/v1/library-files/$library_file_id/link"
  [ "$status" = "201" ] || fail "making the library link returned HTTP $status: $(qd_reply_code)"
  no_store || fail "the library link's reply, carrying the link, isn't Cache-Control: no-store"
  library_path=$(reply_json '.path')
  library_link=${library_path#/api/v1/library-links/}
  [ "$library_link" != "$library_path" ] && [[ "$library_link" =~ ^tll_[A-Za-z0-9_-]{71}$ ]] &&
    [ "$(reply_json -c 'keys')" = '["path"]' ] ||
    fail "the library link's reply isn't one path /api/v1/library-links/, tll_ and 71 base64url characters"
  # The link first: every log read below is searched for it.
  qd_secrets "$library_link"
  # The link as the web builds it: the origin the browser reached, here the gateway's, and the path.
  library_url="$GATEWAY_URL$library_path"

  # The gateway's access log before the link's first download: the logs' check (below) counts exactly the
  # lines these downloads add.
  # library_access_count <status> <file>: the lines GET /api/v1/library-links/[redacted] … <status> in <file>;
  # grep -c prints its count (0 too) unless the file can't be read (then nothing).
  library_access_count() {
    grep -cE "\"GET /api/v1/library-links/\\[redacted\\] HTTP/[0-9.]+\" $1 " -- "$2" 2>/dev/null || true
  }
  (umask 077 && docker compose logs --no-color api gateway >"$qd_dir/library-logs-before" 2>&1) ||
    fail "reading the API's and the gateway's logs before the library link's downloads failed"

  step "download the link from the host through the gateway with no session: 200, its bytes, application/octet-stream, no-store, nosniff, attachment, no Set-Cookie"
  qd_public_get "$library_url" library-download "$GATEWAY_URL"
  [ "$status" = "200" ] || fail "downloading the library link returned HTTP $status"
  cmp -s "$library_file" "$qd_dir/library-download" ||
    fail "the library link's download answered $(wc -c <"$qd_dir/library-download" | tr -d ' ') bytes, not the $LIBRARY_BYTES added"
  qd_search "the library link's download's headers" "$qd_dir/library-download.headers"
  qd_header_is library-download content-type application/octet-stream && qd_header_is library-download cache-control no-store &&
    qd_header_is library-download x-content-type-options nosniff && qd_header_is library-download content-disposition attachment ||
    fail "the library link's download's headers aren't octet-stream, no-store, nosniff and attachment: $(qd_redacted "$qd_dir/library-download.headers" 600)"
  qd_none "the library link's download's headers" -i '^set-cookie:' -- "$qd_dir/library-download.headers" ||
    fail "the library link's download sets a cookie"

  step "delete the file: DELETE /api/v1/library-files/:id answers 204; its link is then 404 \"Not found.\" in plain text"
  platform DELETE "$GATEWAY_URL/api/v1/library-files/$library_file_id"
  [ "$status" = "204" ] || fail "deleting the library file returned HTTP $status: $(reply_code)"
  created_library_file_id=""
  qd_public_get "$library_url" library-gone "$GATEWAY_URL"
  qd_search "the deleted file's link's reply" "$qd_dir/library-gone" "$qd_dir/library-gone.headers"
  qd_refused library-gone "Not found." 404 ||
    fail "the deleted file's link returned HTTP $status, not 404 Not found. in plain text, redacted: $(qd_redacted "$qd_dir/library-gone" 300)"

  step "the API's and the gateway's logs hold neither the link nor any tll_, and log its downloads as GET /api/v1/library-links/[redacted] (one 200, one 404): docker compose logs api gateway"
  (umask 077 && docker compose logs --no-color api gateway >"$qd_dir/library-logs" 2>&1) ||
    fail "reading the API's and the gateway's logs failed"
  qd_logs_clean "$qd_dir/library-logs" " after the library link's downloads"
  qd_none "the API's and the gateway's logs" -F tll_ -- "$qd_dir/library-logs" ||
    fail "the API's or the gateway's logs hold tll_, on $(grep -cF tll_ -- "$qd_dir/library-logs") lines"
  for library_seen in "200 1" "404 1"; do
    library_code=${library_seen% *}
    library_before=$(library_access_count "$library_code" "$qd_dir/library-logs-before")
    library_count=$(library_access_count "$library_code" "$qd_dir/library-logs")
    [ -n "$library_before" ] && [ -n "$library_count" ] && [ "$((library_count - library_before))" = "${library_seen#* }" ] 2>/dev/null ||
      fail "the gateway's access log doesn't hold exactly ${library_seen#* } new line GET /api/v1/library-links/[redacted] … $library_code for the library link (${library_before:-unread} before its downloads, ${library_count:-unread} after)"
  done
  unset library_path library_link library_url

  step "clear the flag by SQL: /api/v1/auth/me shows isProductAdmin false"
  product_admin false
  expect_product_admin false
else
  library_steps="skipped the library's product-admin steps (not a throwaway stack)"
  step "SKIPPED: the library's steps (grant the flag by SQL, add a library file, make and download its link, delete it, clear the flag) run only on a throwaway stack: COMPOSE_PROJECT_NAME is ${COMPOSE_PROJECT_NAME:-unset}, not a throwaway stack's"
fi

# Product administration, after the library's steps, on a throwaway stack only (as the regex library's and the
# library's product-admin steps, granting and clearing the flag on their own). The smoke's
# account, its flag set by SQL, drives the product-admin routes through the gateway (/api/v1/product-admin/,
# every answer no-store): it grants the invitee (verified when they joined from the invitation) by email and
# removes them, is refused its own removal as the stack's only product admin (the one real last-admin refusal
# outside the integration suite: the browser tests' database holds other workers' admins). On the SaaS's
# values it then dismisses the invitee's feedback, is refused the invitee's delete (a member of the group
# organization) and its own, and deletes a third account it registers, verifies and finds by search; on the
# open-source defaults it finds the user feedback's and Users' routes off (404 not_found). The replies hold other people's emails
# and a feedback's text: they stay in platform()'s 0600 files and are read by jq for ids and booleans only; the
# step lines are fixed words (never the third account's address); a failure prints statuses, error codes and
# counts. The logs are searched for the search's term by counts only. The EXIT trap clears the flags only: a run
# that ends between the invitee's grant and removal clears the invitee's by SQL, and the account's, as before; a
# run that dies mid-block leaves the third account and the feedback item on the throwaway stack.
# admin_call <jar> <method> <url> [<JSON body>]: platform() for the session in <jar> (the account's $JAR, the
# invitee's $INVITEE_JAR or the third account's): the status into $status, the body and the headers into
# platform()'s 0600 files (reply_json, reply_code and no_store read them); $body isn't set.
admin_call() {
  local jar=$1 method=$2 url=$3
  local args=(-s --max-time 30 -o "$PLATFORM_REPLY_BODY" -D "$PLATFORM_REPLY_HEADERS" -w '%{http_code}' -b "$jar"
    -X "$method" -H 'X-Telflo-CSRF: 1')
  if [ $# -ge 4 ]; then args+=(-H 'content-type: application/json' --data-binary "$4"); fi
  status=$(umask 077 && : >"$PLATFORM_REPLY_BODY" && curl "${args[@]}" "$url" || true)
}
# admin_reply_is [jq's --arg ...] <jq condition>: the last reply's JSON satisfies it (a boolean: nothing printed).
admin_reply_is() { [ "$(reply_json "$@")" = "true" ]; }
# admin_refused <status> <code> <what>: the last reply is the refusal <status> <code>, no-store, or the run fails.
admin_refused() {
  [ "$status" = "$1" ] && [ "$(reply_code)" = "$2" ] && no_store ||
    fail "$3 returned HTTP $status $(reply_code), not $1 $2 with Cache-Control: no-store"
}
if throwaway_stack; then
  if [ "$SMOKE_SITE" = "saas" ]; then
    admin_steps="had a product admin list the product admins (its account alone), grant the invitee by email (201, then 200) and remove them, be refused its own removal as the last one (409 last_product_admin), find and dismiss the invitee's feedback (the admins' email naming the sender without the text), be refused the invitee's delete (a member) and its own, and delete a third account (registered and verified) found by search (its session, refresh and sign-in then refused, its deletion record and anonymous address in the database, no organization named with its address, no session holding its IP or user agent, its personal organization registered in the opamp-server before and gone after), with the search's term in no log"
  else
    admin_steps="had a product admin list the product admins (its account alone), grant the invitee by email (201, then 200) and remove them, be refused its own removal as the last one (409 last_product_admin), and found the user feedback and Users off (TELFLO_USER_FEEDBACK, TELFLO_USER_ADMIN: 404 not_found)"
  fi
  PRODUCT_ADMIN_URL="$GATEWAY_URL/api/v1/product-admin"

  # The steps above take minutes; the access cookie lasts 15. The invitee's session hasn't been used since they
  # joined: its refresh cookie, from then, is still live.
  step "refresh the account's and the invitee's sessions (POST /api/v1/auth/refresh answers 200 for each) and read the invitee's id from /api/v1/auth/me"
  for admin_jar in "$JAR" "$INVITEE_JAR"; do
    status=$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' -b "$admin_jar" -c "$admin_jar" -X POST \
      "$GATEWAY_URL/api/v1/auth/refresh" -H 'X-Telflo-CSRF: 1' || true)
    [ "$status" = "200" ] || fail "refreshing a session before the product-administration steps returned HTTP $status"
  done
  admin_call "$INVITEE_JAR" GET "$GATEWAY_URL/api/v1/auth/me"
  admin_invitee_id=$(reply_json '.user.id // empty')
  [ "$status" = "200" ] && [ -n "$admin_invitee_id" ] && admin_reply_is --arg email "$INVITEE_EMAIL" '.user.email == $email' ||
    fail "GET /api/v1/auth/me as the invitee returned HTTP $status $(reply_code), not the invitee"

  step "make the account a product admin by SQL on the stack's database: /api/v1/auth/me shows isProductAdmin true"
  product_admin true
  expect_product_admin true

  step "list the product admins: GET /api/v1/product-admin/product-admins answers 200, no-store, the account alone (a throwaway stack's only one)"
  admin_call "$JAR" GET "$PRODUCT_ADMIN_URL/product-admins"
  [ "$status" = "200" ] && no_store && admin_reply_is --arg id "$user_id" '[.items[].id] == [$id]' ||
    fail "the product admins' list returned HTTP $status $(reply_code), $(reply_json '.items | length') items, not the account alone with no-store"

  step "grant the invitee by email: POST /api/v1/product-admin/product-admins answers 201 with their id and email, then 200 again, no-store"
  admin_grant=$(jq -cn --arg email "$INVITEE_EMAIL" '{email: $email}')
  # Marked before it's sent: the EXIT trap clears the invitee's flag if the run ends before the removal below.
  invitee_product_admin_granted=yes
  for admin_expected in 201 200; do
    admin_call "$JAR" POST "$PRODUCT_ADMIN_URL/product-admins" "$admin_grant"
    [ "$status" = "$admin_expected" ] && no_store &&
      admin_reply_is --arg id "$admin_invitee_id" --arg email "$INVITEE_EMAIL" '. == {id: $id, email: $email}' ||
      fail "granting the invitee returned HTTP $status $(reply_code), not $admin_expected with their id and email and no-store"
  done

  step "the product admins' list holds the account and the invitee"
  admin_call "$JAR" GET "$PRODUCT_ADMIN_URL/product-admins"
  [ "$status" = "200" ] && no_store &&
    admin_reply_is --arg a "$user_id" --arg b "$admin_invitee_id" '([.items[].id] | sort) == ([$a, $b] | sort)' ||
    fail "the product admins' list returned HTTP $status $(reply_code), $(reply_json '.items | length') items, not the account and the invitee"

  step "remove the invitee: DELETE /api/v1/product-admin/product-admins/:userId answers 204, no-store"
  admin_call "$JAR" DELETE "$PRODUCT_ADMIN_URL/product-admins/$admin_invitee_id"
  [ "$status" = "204" ] && no_store || fail "removing the invitee returned HTTP $status $(reply_code), not 204 with no-store"
  invitee_product_admin_granted=""

  step "the last product admin's removal is refused: removing the account itself answers 409 last_product_admin, and /api/v1/auth/me still shows isProductAdmin true"
  admin_call "$JAR" DELETE "$PRODUCT_ADMIN_URL/product-admins/$user_id"
  admin_refused 409 last_product_admin "removing the last product admin"
  expect_product_admin true

  # The user feedback and Users: on in the SaaS's values; off on the open-source defaults, their routes 404.
  if [ "$SMOKE_SITE" = "saas" ]; then
    FEEDBACK_MARKER="smokefeedbackmarker$(date +%s)$$"
    FEEDBACK_TEXT="Sent by the stack smoke test: $FEEDBACK_MARKER"
    step "the invitee sends feedback: POST /api/v1/feedback answers 201 with its id"
    admin_call "$INVITEE_JAR" POST "$GATEWAY_URL/api/v1/feedback" "$(jq -cn --arg text "$FEEDBACK_TEXT" '{text: $text}')"
    admin_feedback_id=$(reply_json '.id // empty')
    [ "$status" = "201" ] && [ -n "$admin_feedback_id" ] ||
      fail "sending the invitee's feedback returned HTTP $status $(reply_code), not 201 with an id"

    # Sent after the response, to every product admin: the account alone, once the invitee's flag is removed.
    step "the product admins' email reached the account in Mailpit, naming the invitee and linking to the gateway's User Feedback page, without the feedback's text (counted)"
    admin_query=$(jq -rn --arg query "to:\"$EMAIL\" subject:\"Telflo - New User Feedback Request\"" '$query | @uri')
    message_id=""
    for _ in $(seq 1 30); do
      message_id=$(curl -s "$MAILPIT_URL/api/v1/search?query=$admin_query" | jq -r '.messages[0].ID // empty')
      [ -n "$message_id" ] && break
      sleep 1
    done
    [ -n "$message_id" ] || fail "no feedback email to the account arrived in Mailpit within 30s"
    admin_mail="$work_dir/product-admin-email"
    (umask 077 && curl -s "$MAILPIT_URL/api/v1/message/$message_id" | jq -r '.Text, .HTML' >"$admin_mail") ||
      fail "reading the feedback email from Mailpit failed"
    admin_marker_lines=$(grep -cF -e "$FEEDBACK_MARKER" -- "$admin_mail" || true)
    [ "$admin_marker_lines" = "0" ] || fail "the product admins' email holds the feedback's text on ${admin_marker_lines:-unread} lines"
    grep -qF -e "Requested by: $INVITEE_EMAIL" -- "$admin_mail" &&
      grep -qF -e "Review Request: $GATEWAY_URL/product-admin/user-feedback" -- "$admin_mail" ||
      fail "the product admins' email doesn't name the invitee and link to $GATEWAY_URL/product-admin/user-feedback"

    step "list the pending feedback: GET /api/v1/product-admin/feedback answers 200, no-store, holding the invitee's item with its text and sender (its cursor followed until found)"
    admin_url="$PRODUCT_ADMIN_URL/feedback"
    admin_found=""
    for _ in $(seq 1 20); do
      admin_call "$JAR" GET "$admin_url"
      [ "$status" = "200" ] && no_store || fail "listing the feedback returned HTTP $status $(reply_code), not 200 with no-store"
      if admin_reply_is --arg id "$admin_feedback_id" --arg email "$INVITEE_EMAIL" --arg text "$FEEDBACK_TEXT" \
        'any(.items[]; .id == $id and .email == $email and .text == $text and .authorDeleted == false)'; then
        admin_found=yes
        break
      fi
      admin_cursor=$(reply_json '.nextCursor // empty')
      [ -n "$admin_cursor" ] || break
      admin_url="$PRODUCT_ADMIN_URL/feedback?cursor=$(jq -rn --arg cursor "$admin_cursor" '$cursor | @uri')"
    done
    [ -n "$admin_found" ] || fail "the pending feedback doesn't hold the invitee's item with its text and sender"

    step "dismiss it: POST /api/v1/product-admin/feedback/:id/dismiss answers 204, no-store, then again 404 feedback_not_found"
    admin_call "$JAR" POST "$PRODUCT_ADMIN_URL/feedback/$admin_feedback_id/dismiss"
    [ "$status" = "204" ] && no_store || fail "dismissing the feedback returned HTTP $status $(reply_code), not 204 with no-store"
    admin_call "$JAR" POST "$PRODUCT_ADMIN_URL/feedback/$admin_feedback_id/dismiss"
    admin_refused 404 feedback_not_found "dismissing the feedback again"

    step "the invitee's delete is refused, a member of the group organization: DELETE /api/v1/product-admin/users/:userId answers 409 user_delete_blocked, its details { kind: member }"
    admin_call "$JAR" DELETE "$PRODUCT_ADMIN_URL/users/$admin_invitee_id"
    admin_refused 409 user_delete_blocked "deleting the invitee"
    admin_reply_is '.error.details == {kind: "member"}' ||
      fail "deleting the invitee was refused with the details $(reply_json -c '.error.details'), not { kind: member }"

    step "the account's own delete is refused: DELETE /api/v1/product-admin/users/:userId answers 409 user_delete_self"
    admin_call "$JAR" DELETE "$PRODUCT_ADMIN_URL/users/$user_id"
    admin_refused 409 user_delete_self "deleting the account itself"

    # A third account, made here to be deleted. Its address is never printed: the step lines say "the third
    # account", and register_verified's name it so.
    DELETED_ACCOUNT_LOCAL="stack-smoke-deleted-$(date +%s)-$$"
    DELETED_ACCOUNT_EMAIL="$DELETED_ACCOUNT_LOCAL@example.com"
    DELETED_ACCOUNT_JAR="$work_dir/deleted-account-cookies"
    step "register and verify a third account through the gateway (its address never printed)"
    register_verified "$DELETED_ACCOUNT_EMAIL" "$PASSWORD" "the third account"

    step "sign the third account in: POST /api/v1/auth/sessions answers 200, and /api/v1/auth/me names it"
    admin_sign_in=$(jq -cn --arg email "$DELETED_ACCOUNT_EMAIL" --arg password "$PASSWORD" '{email: $email, password: $password}')
    status=$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' -c "$DELETED_ACCOUNT_JAR" -X POST "$GATEWAY_URL/api/v1/auth/sessions" \
      -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "$admin_sign_in" || true)
    [ "$status" = "200" ] || fail "signing the third account in returned HTTP $status"
    admin_call "$DELETED_ACCOUNT_JAR" GET "$GATEWAY_URL/api/v1/auth/me"
    deleted_account_id=$(reply_json '.user.id // empty')
    # Its personal organization (the one a sign-in lands in).
    deleted_account_organization_id=$(reply_json '[.organizations[] | select(.type == "personal") | .id] | if length == 1 then .[0] else empty end')
    [ "$status" = "200" ] && [ -n "$deleted_account_id" ] && [ -n "$deleted_account_organization_id" ] &&
      admin_reply_is --arg email "$DELETED_ACCOUNT_EMAIL" '.user.email == $email' ||
      fail "GET /api/v1/auth/me as the third account returned HTTP $status $(reply_code), not the third account"


    step "find the third account by its address: GET /api/v1/product-admin/users?q= answers 200, no-store, that one person, no block, no next page"
    admin_call "$JAR" GET "$PRODUCT_ADMIN_URL/users?q=$(jq -rn --arg q "$DELETED_ACCOUNT_EMAIL" '$q | @uri')"
    [ "$status" = "200" ] && no_store && admin_reply_is --arg id "$deleted_account_id" --arg email "$DELETED_ACCOUNT_EMAIL" \
      '.nextCursor == null and (.items | length) == 1 and (.items[0] | .id == $id and .email == $email and .isProductAdmin == false and .block == null)' ||
      fail "searching for the third account returned HTTP $status $(reply_code), $(reply_json '.items | length') items, not that one person with no block and no-store"

    # So the check that it's gone after the delete can't pass vacuously. stack_smoke's personal-organization mode
    # also runs its own publication sequence first (as for the first account) and prints no name.
    step "the platform registered the third account's personal organization in the opamp-server (under a personal organization's name)"
    stack_smoke "$deleted_account_organization_id" ||
      fail "the third account's personal organization $deleted_account_organization_id isn't registered in the opamp-server (above)"

    step "delete the third account: DELETE /api/v1/product-admin/users/:userId answers 204, no-store"
    admin_call "$JAR" DELETE "$PRODUCT_ADMIN_URL/users/$deleted_account_id"
    [ "$status" = "204" ] && no_store || fail "deleting the third account returned HTTP $status $(reply_code), not 204 with no-store"

    step "the third account's session ended: GET /api/v1/auth/me and POST /api/v1/auth/refresh with its cookies answer 401 unauthenticated"
    admin_call "$DELETED_ACCOUNT_JAR" GET "$GATEWAY_URL/api/v1/auth/me"
    [ "$status" = "401" ] && [ "$(reply_code)" = "unauthenticated" ] ||
      fail "GET /api/v1/auth/me as the deleted third account returned HTTP $status $(reply_code), not 401 unauthenticated"
    admin_call "$DELETED_ACCOUNT_JAR" POST "$GATEWAY_URL/api/v1/auth/refresh"
    [ "$status" = "401" ] && [ "$(reply_code)" = "unauthenticated" ] ||
      fail "refreshing the deleted third account's session returned HTTP $status $(reply_code), not 401 unauthenticated"

    step "the third account's sign-in is refused: POST /api/v1/auth/sessions with its address and password answers 401 invalid_credentials"
    admin_call "$DELETED_ACCOUNT_JAR" POST "$GATEWAY_URL/api/v1/auth/sessions" "$admin_sign_in"
    [ "$status" = "401" ] && [ "$(reply_code)" = "invalid_credentials" ] ||
      fail "signing the deleted third account in returned HTTP $status $(reply_code), not 401 invalid_credentials"

    step "by SQL on the stack's database, the third account's deletion record (its original address, deleted by the account) and its anonymous address (no password, deleted_at set), its address freed, no organization named with it, no session of its holding an IP address or user agent: counts 1, 1, 0, 0 and 0"
    admin_counts=$(stack_psql -v id="$deleted_account_id" -v email="$DELETED_ACCOUNT_EMAIL" -v admin="$user_id" <<'SQL'
  select count(*) from user_deletion_records
   where user_id = :'id'::uuid and original_email = lower(:'email') and deleted_by_user_id = :'admin'::uuid
     and deleted_at is not null;
  select count(*) from users
   where id = :'id'::uuid and deleted_at is not null and password_hash is null and kind = 'human'
     and email ~ '^deleted-[0-9a-f]{24}@deleted-accounts\.telflo\.invalid$';
  select count(*) from users where lower(email) = lower(:'email');
  select count(*) from organizations where strpos(lower(name), lower(:'email')) > 0;
  select count(*) from sessions
   where user_id = :'id'::uuid and (ip_address is not null or user_agent is not null);
SQL
    ) || fail "reading the third account's rows by SQL failed: $(sed "s/$DELETED_ACCOUNT_LOCAL/[the third account]/g" "$work_dir/stack-psql-stderr")"
    [ "$(tr '\n' ' ' <<<"$admin_counts")" = "1 1 0 0 0 " ] ||
      fail "the third account's deletion record, anonymous address, freed address, organizations named with it and sessions holding an IP or user agent counted $(tr '\n' ' ' <<<"$admin_counts"), not 1 1 0 0 0"

    # stack_smoke's group-gone checks any organization by its id (its line calls it a group organization).
    step "the platform removed the third account's personal organization from the opamp-server"
    stack_smoke group-gone "$deleted_account_organization_id" ||
      fail "the third account's personal organization $deleted_account_organization_id is still registered in the opamp-server (above)"

    step "the API's and the gateway's logs hold no search term, and the gateway logged the search by its path alone: docker compose logs api gateway (counts only)"
    admin_logs="$work_dir/product-admin-logs"
    (umask 077 && docker compose logs --no-color api gateway >"$admin_logs" 2>&1) ||
      fail "reading the API's and the gateway's logs failed"
    qd_none "the API's and the gateway's logs" -F -e "$DELETED_ACCOUNT_LOCAL" -- "$admin_logs" ||
      fail "the API's or the gateway's logs hold the Users search's term on $(grep -cF -e "$DELETED_ACCOUNT_LOCAL" -- "$admin_logs") lines"
    admin_search_lines=$(grep -cF -e '"GET /api/v1/product-admin/users HTTP/' -- "$admin_logs" || true)
    [[ "$admin_search_lines" =~ ^[1-9][0-9]*$ ]] ||
      fail "the gateway's access log holds ${admin_search_lines:-no} lines \"GET /api/v1/product-admin/users HTTP/…\", not at least one for the search"
  else
    step "the user feedback is off (TELFLO_USER_FEEDBACK=false): POST /api/v1/feedback and GET /api/v1/product-admin/feedback answer 404 not_found"
    switched_off POST "$GATEWAY_URL/api/v1/feedback"
    switched_off GET "$PRODUCT_ADMIN_URL/feedback"
    step "Users is off (TELFLO_USER_ADMIN=false): GET /api/v1/product-admin/users and DELETE /api/v1/product-admin/users/:userId answer 404 not_found"
    switched_off GET "$PRODUCT_ADMIN_URL/users"
    switched_off DELETE "$PRODUCT_ADMIN_URL/users/$admin_invitee_id"
  fi

  step "clear the flag by SQL: /api/v1/auth/me shows isProductAdmin false"
  product_admin false
  expect_product_admin false
else
  admin_steps="skipped the product-administration steps (not a throwaway stack)"
  step "SKIPPED: the product-administration steps (grant the flag by SQL, grant and remove the invitee, send and dismiss feedback, delete a third account, clear the flag) run only on a throwaway stack: COMPOSE_PROJECT_NAME is ${COMPOSE_PROJECT_NAME:-unset}, not a throwaway stack's"
fi

# The public API, in the group organization, through the gateway: its admin's session mints a service
# account's write and read tokens and a personal write token (each checked by its shape, never printed: shell
# variables, curl's standard input as a config line, grep's -f files 0600); then each token alone drives the
# public surface. The configuration's YAML names a pipeline holding a marker (configuration text) that route
# 14's path carries; the API's and the gateway's logs are then searched for every token and the marker, counts
# only. The personal token is revoked at the end (and by the EXIT trap); the service account and everything
# made here go with the group organization's delete below.
# public_api_call <token's variable> <method> <path under /api/public/v1> [<JSON body file>] [<X-Telflo-Org>]:
# one call; the status into $status, the body and headers into platform()'s 0600 files (reply_json, reply_code,
# no_store read them). The token reaches curl as a config line on its standard input (printf is a builtin):
# never argv.
PUBLIC_API_URL="$GATEWAY_URL/api/public/v1"
public_api_call() {
  local token_name=$1 method=$2 path=$3 data=${4:-} organization=${5:-}
  local args=(-q -s --max-time 30 -o "$PLATFORM_REPLY_BODY" -D "$PLATFORM_REPLY_HEADERS" -w '%{http_code}' -X "$method" -K -)
  if [ -n "$data" ]; then args+=(-H 'content-type: application/json' --data-binary "@$data"); fi
  if [ -n "$organization" ]; then args+=(-H "X-Telflo-Org: $organization"); fi
  status=$(umask 077 && : >"$PLATFORM_REPLY_BODY" && printf 'header = "Authorization: Bearer %s"\n' "${!token_name}" |
    curl "${args[@]}" "$PUBLIC_API_URL$path" || true)
}
# public_api_body <name> <jq's arguments>...: jq -n's answer into $work_dir/public-api-<name>.json (0600); its
# path into $public_api_file.
public_api_body() {
  local name=$1
  shift
  public_api_file="$work_dir/public-api-$name.json"
  (umask 077 && jq -n "$@" >"$public_api_file") || fail "building the public API body $name failed"
}
# public_api_reply_is [jq's --arg ...] <jq condition>: the last reply's JSON satisfies it.
public_api_reply_is() { [ "$(reply_json "$@")" = "true" ]; }
# api_token_shaped <token's variable>: tf_ and 43 base64url characters (bash's own match: nothing printed).
api_token_shaped() { [[ "${!1}" =~ ^tf_[A-Za-z0-9_-]{43}$ ]]; }
# mint_api_token <variable> <url> <name> <access> [<id variable>]: creates a token at <url> through the session
# (201, no-store), its token into <variable> (from the 0600 reply file, never printed), its id into
# $minted_token_id and <id variable>, set first, before any check, so the EXIT trap can revoke a token whose
# checks fail.
mint_api_token() {
  local variable=$1 url=$2 name=$3 access=$4 id_variable=${5:-}
  # A token's create asks the signed-in person's current password: the reset's (NEW_PASSWORD, remembered as a secret).
  platform POST "$url" "$(jq -cn --arg name "$name" --arg access "$access" --arg password "$NEW_PASSWORD" \
    '{name: $name, access: $access, expiresInDays: 1, currentPassword: $password}')"
  body=""
  minted_token_id=$(reply_json '.apiToken.id // empty')
  if [ -n "$id_variable" ]; then printf -v "$id_variable" '%s' "$minted_token_id"; fi
  [ "$status" = "201" ] || fail "creating the $name token returned HTTP $status: $(reply_code)"
  no_store || fail "the $name token's create reply isn't Cache-Control: no-store"
  printf -v "$variable" '%s' "$(reply_json '.token // empty')"
  api_token_shaped "$variable" && [ -n "$minted_token_id" ] ||
    fail "the $name token's create reply isn't a token tf_ and 43 base64url characters with an id (not printed)"
  (umask 077 && : >"$PLATFORM_REPLY_BODY")
}

PIPELINE_MARKER="smokepipelinemarker$(date +%s)$$"
PUBLIC_API_YAML=$'receivers:\n  otlp:\n    protocols:\n      http: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n    logs/'"$PIPELINE_MARKER"$':\n      receivers: [otlp]\n      exporters: [debug]\n'
PUBLIC_API_INVALID_YAML=$'receivers:\n  not_a_receiver: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [not_a_receiver]\n      exporters: [debug]\n'

# The steps above take minutes; the access cookie lasts 15 (as the refresh before the logo).
step "refresh the session's access cookie: POST /api/v1/auth/refresh answers 200"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/refresh" \
  -H 'X-Telflo-CSRF: 1') || fail "refreshing before the public API steps got no reply (curl exit $?)"
status=$(tail -n1 <<<"$response")
[ "$status" = "200" ] || fail "refreshing before the public API steps returned HTTP $status: $(sed '$d' <<<"$response")"

step "mint a service account's write and read tokens and a personal write token through the session (201, no-store; each tf_ and 43 base64url characters, never printed)"
platform POST "$GROUP_ORGANIZATION_URL/service-accounts" "$(jq -cn --arg name "Stack smoke public API $(date +%s)-$$" '{name: $name}')"
[ "$status" = "201" ] || fail "creating the public API service account returned HTTP $status: $(reply_code)"
public_api_service_account_id=$(reply_json '.serviceAccount.id // empty')
[ -n "$public_api_service_account_id" ] || fail "the public API service account's create answered no id"
mint_api_token public_api_write_token "$GROUP_ORGANIZATION_URL/service-accounts/$public_api_service_account_id/api-tokens" "smoke write token" write
mint_api_token public_api_read_token "$GROUP_ORGANIZATION_URL/service-accounts/$public_api_service_account_id/api-tokens" "smoke read token" read
mint_api_token public_api_personal_token "$GATEWAY_URL/api/v1/auth/me/api-tokens" "smoke personal token" write public_api_personal_token_id
(umask 077 && printf '%s\n' "$public_api_write_token" >"$work_dir/public-api-secret-write" && printf '%s\n' "$public_api_read_token" >"$work_dir/public-api-secret-read" &&
  printf '%s\n' "$public_api_personal_token" >"$work_dir/public-api-secret-personal" && printf '%s\n' "$PIPELINE_MARKER" >"$work_dir/public-api-marker") ||
  fail "writing the public API search files failed"

step "GET /whoami as the service account (service_account, the group organization) and as the person (person, no organization header needed)"
public_api_call public_api_write_token GET /whoami
[ "$status" = "200" ] && no_store && public_api_reply_is --arg org "$group_id" '.kind == "service_account" and .organizationId == $org and .access == "write"' ||
  fail "the service account's /whoami returned HTTP $status: $(reply_code)"
public_api_call public_api_personal_token GET /whoami
[ "$status" = "200" ] && public_api_reply_is '.kind == "person" and .access == "write"' ||
  fail "the person's /whoami returned HTTP $status: $(reply_code)"

step "GET /orgs: the service account's one organization; the person's memberships, the group's among them"
public_api_call public_api_read_token GET /orgs
[ "$status" = "200" ] && public_api_reply_is --arg org "$group_id" '[.items[].id] == [$org]' ||
  fail "the service account's /orgs returned HTTP $status: $(reply_code)"
public_api_call public_api_personal_token GET /orgs
[ "$status" = "200" ] && public_api_reply_is --arg org "$group_id" --arg personal "$personal_id" '([.items[].id] | index($org) != null and index($personal) != null)' ||
  fail "the person's /orgs returned HTTP $status: $(reply_code)"

step "the person without X-Telflo-Org is 400 organization_required; with the group's id, GET /configurations is 200"
public_api_call public_api_personal_token GET /configurations
[ "$status" = "400" ] && [ "$(reply_code)" = "organization_required" ] ||
  fail "the person's /configurations without X-Telflo-Org returned HTTP $status $(reply_code), not 400 organization_required"
public_api_call public_api_personal_token GET /configurations "" "$group_id"
[ "$status" = "200" ] && no_store && public_api_reply_is '.items | type == "array"' ||
  fail "the person's /configurations with X-Telflo-Org returned HTTP $status: $(reply_code)"

step "a read token on a write route: POST /configurations is 403 insufficient_access"
public_api_body create --arg name "Stack smoke public API $(date +%s)-$$" --arg yaml "$PUBLIC_API_YAML" '{name: $name, yaml: $yaml}'
public_api_call public_api_read_token POST /configurations "$public_api_file"
[ "$status" = "403" ] && [ "$(reply_code)" = "insufficient_access" ] ||
  fail "a read token's POST /configurations returned HTTP $status $(reply_code), not 403 insufficient_access"

step "create a configuration (201), PATCH its version 1 ?validate=true with the real validator (an invalid text 422, nothing saved; a valid one 200)"
public_api_call public_api_write_token POST /configurations "$public_api_file"
[ "$status" = "201" ] || fail "creating the public API configuration returned HTTP $status: $(reply_code)"
public_api_configuration_id=$(reply_json '.id // empty')
[ -n "$public_api_configuration_id" ] && public_api_reply_is --arg org "$group_id" '.organizationId == $org and .versionNumber == 1' ||
  fail "the public API configuration's create answered no id or another organization: $(reply_json -c '{organizationId, versionNumber}')"
public_api_body invalid --arg yaml "$PUBLIC_API_INVALID_YAML" '{yaml: $yaml}'
public_api_call public_api_write_token PATCH "/configurations/$public_api_configuration_id/versions/1?validate=true" "$public_api_file"
[ "$status" = "422" ] && [ "$(reply_code)" = "configuration_invalid" ] ||
  fail "an invalid text's PATCH ?validate=true returned HTTP $status $(reply_code), not 422 configuration_invalid"
public_api_body valid --arg yaml "$PUBLIC_API_YAML" '{yaml: $yaml}'
public_api_call public_api_write_token PATCH "/configurations/$public_api_configuration_id/versions/1?validate=true" "$public_api_file"
[ "$status" = "200" ] && public_api_reply_is '.versionNumber == 1 and .status == "draft"' ||
  fail "a valid text's PATCH ?validate=true returned HTTP $status: $(reply_code)"

step "route 14: PUT .../validation-pipelines/logs/<the marker> and its %2F spelling replace its rules (200), and the list shows them"
public_api_body rules '{signal: "logs", rules: [{kind: "contains_text", target: "output", pattern: "stack smoke"}]}'
public_api_call public_api_write_token PUT "/configurations/$public_api_configuration_id/versions/1/validation-pipelines/logs/$PIPELINE_MARKER" "$public_api_file"
[ "$status" = "200" ] || [ "$status" = "201" ] || fail "PUT route 14 (a raw slash) returned HTTP $status: $(reply_code)"
public_api_call public_api_write_token PUT "/configurations/$public_api_configuration_id/versions/1/validation-pipelines/logs%2F$PIPELINE_MARKER" "$public_api_file"
[ "$status" = "200" ] || [ "$status" = "201" ] || fail "PUT route 14 (an encoded slash) returned HTTP $status: $(reply_code)"
public_api_call public_api_read_token GET "/configurations/$public_api_configuration_id/versions/1/validation-pipelines"
[ "$status" = "200" ] && public_api_reply_is --arg name "logs/$PIPELINE_MARKER" '[.items[] | select(.pipeline == $name) | .rules | length] == [1]' ||
  fail "the version's validation pipelines returned HTTP $status, or not the marker's pipeline with its one rule"

step "publish version 1 (200): the opamp-server holds it"
public_api_call public_api_write_token POST "/configurations/$public_api_configuration_id/versions/1/publish"
[ "$status" = "200" ] && public_api_reply_is '.publishedVersionNumber == 1 and .isPublished == true' ||
  fail "publishing the public API configuration's version 1 returned HTTP $status: $(reply_code)"
stack_smoke publications "$group_id" "$public_api_configuration_id" 1 ||
  fail "the opamp-server doesn't hold the public API configuration's published version (above)"

step "POST /validate with the real validator: a valid text is valid, an invalid one names its errors"
public_api_call public_api_read_token POST /validate "$work_dir/public-api-valid.json"
[ "$status" = "200" ] && public_api_reply_is '.valid == true and (.errors | length) == 0' ||
  fail "/validate of a valid text returned HTTP $status: $(reply_code)"
public_api_call public_api_read_token POST /validate "$work_dir/public-api-invalid.json"
[ "$status" = "200" ] && public_api_reply_is '.valid == false and (.errors | length) > 0' ||
  fail "/validate of an invalid text returned HTTP $status: $(reply_code)"

step "POST /ottl/lint with the real evaluator's lint endpoint: a valid and a broken condition, each item answered"
public_api_body lint '{context: "log", conditions: ["attributes[\"env\"] == \"prod\"", "attributes[\"env\" =="]}'
public_api_call public_api_read_token POST /ottl/lint "$public_api_file"
[ "$status" = "200" ] && public_api_reply_is '.valid == false and .ottlVersion != null and .checked == 2 and [.items[].valid] == [true, false]' ||
  fail "/ottl/lint returned HTTP $status: $(reply_code) $(reply_json -c '{valid, checked, ottlVersion}')"

step "a fleet (201, no bearer in the reply), a group assigned the published version (201), and a docker install (200, no-store, its command a docker run: a boolean, never printed)"
public_api_body fleet --arg label "public-api-$(date +%s)-$$" '{label: $label, type: "server"}'
public_api_call public_api_write_token POST /fleets "$public_api_file"
# Exactly the route's five keys (jq's keys are sorted): no bearer, no tokens object, nothing else.
[ "$status" = "201" ] && public_api_reply_is 'keys == ["id","label","tokenExpiresAt","tokenId","type"]' ||
  fail "creating the public API fleet returned HTTP $status: $(reply_code) $(reply_json -c 'keys')"
public_api_fleet_id=$(reply_json '.id // empty')
[ -n "$public_api_fleet_id" ] || fail "the public API fleet's create answered no id"
public_api_body group --arg configuration "$public_api_configuration_id" '{name: "public-api-group", configurationId: $configuration, versionNumber: 1}'
public_api_call public_api_write_token POST "/fleets/$public_api_fleet_id/groups" "$public_api_file"
[ "$status" = "201" ] && public_api_reply_is '.name == "public-api-group" and .versionNumber == 1' ||
  fail "creating the public API group returned HTTP $status: $(reply_code)"
public_api_group_id=$(reply_json '.id // empty')
public_api_body install --arg group "$public_api_group_id" '{platform: "docker", groupId: $group}'
public_api_call public_api_write_token POST "/fleets/$public_api_fleet_id/install" "$public_api_file"
[ "$status" = "200" ] || fail "the public API docker install returned HTTP $status: $(reply_code)"
no_store || fail "the public API docker install's reply, holding the fleet's bearer, isn't Cache-Control: no-store"
public_api_reply_is '.platform == "docker" and (.command | startswith("OPAMP_TOKEN=\u0027")) and any(.command | split("\n")[]; startswith("docker run "))' ||
  fail "the public API docker install's command isn't a docker run (not printed)"
(umask 077 && : >"$PLATFORM_REPLY_BODY")

step "a YAML test run with an inline sample and a rule (202 queued), run by the real tester: read back with the read token until it ends succeeded, then its output holds the record"
public_api_body run --arg yaml "$TEST_RUN_YAML" --rawfile sample "$work_dir/stack-smoke-logs.json" --arg record "$TEST_RECORD_BODY" \
  '{yaml: $yaml, sample: $sample, signal: "logs", pipeline: "logs", durationSeconds: 2, rules: [{kind: "contains_text", target: "output", pattern: $record}]}'
public_api_call public_api_write_token POST /test-runs "$public_api_file"
[ "$status" = "202" ] && public_api_reply_is '.status == "queued"' || fail "queuing the public API YAML run returned HTTP $status: $(reply_code)"
public_api_run_id=$(reply_json '.id // empty')
# Two seconds apart: the read token's 60 a minute is never reached.
public_api_run_status=""
for _ in $(seq 1 90); do
  public_api_call public_api_read_token GET "/test-runs/$public_api_run_id"
  [ "$status" = "200" ] || [ "$status" = "000" ] || fail "reading the public API run returned HTTP $status: $(reply_code)"
  public_api_run_status=$(reply_json '.status // empty')
  case "$public_api_run_status" in succeeded | failed | validation_failed) break ;; esac
  sleep 2
done
[ "$public_api_run_status" = "succeeded" ] && public_api_reply_is '.success == true and ([.validationResults[].passed] == [true])' ||
  fail "the public API YAML run ended ${public_api_run_status:-unread}: $(reply_json -c '{status, success, errorMessage}')"
public_api_call public_api_read_token GET "/test-runs/$public_api_run_id/output"
[ "$status" = "200" ] && grep -qF "$TEST_RECORD_BODY" "$PLATFORM_REPLY_BODY" ||
  fail "the public API run's output returned HTTP $status, or doesn't hold the record"

step "GET /openapi.json (OpenAPI 3.1, no token) and GET /docs/ (the reference page with its CSP), /docs a 301 to /docs/"
status=$(curl -q -s --max-time 30 -o "$work_dir/public-api-openapi.json" -w '%{http_code}' "$PUBLIC_API_URL/openapi.json" || true)
[ "$status" = "200" ] && [ "$(jq -r '.openapi | startswith("3.1")' "$work_dir/public-api-openapi.json" 2>/dev/null)" = "true" ] ||
  fail "GET /api/public/v1/openapi.json returned HTTP $status, or not an OpenAPI 3.1 document"
status=$(curl -q -s --max-time 30 -o "$work_dir/public-api-docs.html" -D "$work_dir/public-api-docs.headers" -w '%{http_code}' "$PUBLIC_API_URL/docs/" || true)
DOCS_CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
[ "$status" = "200" ] && grep -qF 'src="/api/public/v1/docs/swagger-ui-bundle.js"' "$work_dir/public-api-docs.html" &&
  grep -qixF "content-security-policy: $DOCS_CSP"$'\r' "$work_dir/public-api-docs.headers" &&
  grep -qiE '^referrer-policy: no-referrer' "$work_dir/public-api-docs.headers" ||
  fail "GET /api/public/v1/docs/ returned HTTP $status, or not the page with its CSP and no-referrer: $(grep -iE '^(content-security-policy|referrer-policy):' "$work_dir/public-api-docs.headers" | tr '\r\n' '  ')"
status=$(curl -q -s --max-time 30 -o /dev/null -D "$work_dir/public-api-docs-redirect.headers" -w '%{http_code}' "$PUBLIC_API_URL/docs" || true)
[ "$status" = "301" ] && grep -qiE '^location: /api/public/v1/docs/'$'\r''?$' "$work_dir/public-api-docs-redirect.headers" ||
  fail "GET /api/public/v1/docs returned HTTP $status, not a 301 to /api/public/v1/docs/"
for public_api_asset in swagger-ui-bundle.js swagger-ui.css init.js; do
  status=$(curl -q -s --max-time 30 -o /dev/null -w '%{http_code}' "$PUBLIC_API_URL/docs/$public_api_asset" || true)
  [ "$status" = "200" ] || fail "GET /api/public/v1/docs/$public_api_asset returned HTTP $status"
done

step "a 2.2 MiB body to /validate is the gateway's own 413 (nginx's page, before the API)"
public_api_large="$work_dir/public-api-too-large.json"
(umask 077 && { printf '{"yaml":"'; head -c 2306867 /dev/zero | tr '\0' 'a'; printf '"}'; } >"$public_api_large")
public_api_call public_api_read_token POST /validate "$public_api_large"
gateway_refused_too_large || fail "a 2.2 MiB body to /validate returned HTTP $status ($(reply_code)), not the gateway's 413"

step "route 14's PUT with a body over 1 MiB, its path and query naming the pipeline, is the gateway's own 413 (its error log line, crit only)"
public_api_large_put="$work_dir/public-api-too-large-put.json"
(umask 077 && { printf '{"signal":"logs","rules":[{"kind":"contains_text","target":"output","pattern":"'; head -c 1258291 /dev/zero | tr '\0' 'a'; printf '"}]}'; } >"$public_api_large_put")
public_api_call public_api_write_token PUT "/configurations/$public_api_configuration_id/versions/1/validation-pipelines/logs/$PIPELINE_MARKER?q=$PIPELINE_MARKER" "$public_api_large_put"
gateway_refused_too_large || fail "a 1.2 MiB body to route 14 returned HTTP $status ($(reply_code)), not the gateway's 413"

# The telflo CLI ($SMOKE_CLI, checked at the start) drives the same public surface through the gateway, logged in
# from its standard input with the public API steps' personal token in the group organization, before those steps'
# last ones, so their search of the logs for that token covers these calls too. Each run's stdout and stderr go to
# 0600 files in $CLI_DIR, read only by jq, grep and cmp (booleans and counts): no token, bearer or install command
# is ever printed, and a failure prints the exit code and the CLI's own fixed words (its JSON error, tokens
# redacted), never an install's. The token reaches the CLI on a pipe from printf (a builtin): never argv. The
# configuration and the fleet made here go with the group organization's delete below; the credentials file goes
# with the work folder.
# cli_run <name> <args>...: one run of the CLI on the stored login ($CLI_CONFIG), its standard input /dev/null, its
# stdout and stderr into $CLI_DIR/<name>.out and .err; its exit code into $cli_code.
cli_run() {
  local name=$1
  shift
  cli_code=0
  (umask 077 && cli_env TELFLO_CLI_CONFIG_DIR="$CLI_CONFIG" node "$SMOKE_CLI" "$@" </dev/null >"$CLI_DIR/$name.out" 2>"$CLI_DIR/$name.err") ||
    cli_code=$?
}
# cli_json_is <name> [jq's --arg ...] <jq condition>: the run's stdout (one JSON document, --json) satisfies it.
cli_json_is() {
  local name=$1
  shift
  [ "$(jq -r "$@" "$CLI_DIR/$name.out" 2>/dev/null)" = "true" ]
}
# cli_json <name> <jq filter>: jq's raw answer on the run's stdout, or "".
cli_json() { jq -r "$2" "$CLI_DIR/$1.out" 2>/dev/null || true; }
# cli_said <name>: what a failing run says, for a failure's message: its exit code and its --json error's code and
# fixed words (or its stderr's last line), cut short, tf_, tqd_ and tll_ redacted. Never used for fleet install.
cli_said() {
  local said
  said=$(jq -r '"\(.error.code): \(.error.message)"' "$CLI_DIR/$1.err" 2>/dev/null || tail -n1 "$CLI_DIR/$1.err" 2>/dev/null || true)
  printf 'exit %s, %s' "$cli_code" \
    "$(sed -E 's/tf_[A-Za-z0-9_-]+/tf_[redacted]/g; s/tqd_[A-Za-z0-9_-]+/tqd_[redacted]/g; s/tll_[A-Za-z0-9_-]+/tll_[redacted]/g' <<<"${said:-nothing on stderr}" | head -c 300)"
}
CLI_STAMP="$(date +%s)-$$"

step "telflo login reads the public API steps' personal token from its standard input (--server the gateway, --org the group organization): exit 0, 'Logged in … as smoke personal token (…)', the credentials file 0600 in a 0700 folder"
cli_code=0
(umask 077 && printf '%s\n' "$public_api_personal_token" |
  cli_env TELFLO_CLI_CONFIG_DIR="$CLI_CONFIG" node "$SMOKE_CLI" login --server "$GATEWAY_URL" --org "$group_id" \
    >"$CLI_DIR/login.out" 2>"$CLI_DIR/login.err") || cli_code=$?
[ "$cli_code" = "0" ] && grep -qE '^Logged in to https?://[^ ]+ as smoke personal token \(.+\)\.$' "$CLI_DIR/login.out" ||
  fail "telflo login from stdin failed: $(cli_said login)"
[ -n "$(find "$CLI_CONFIG" -maxdepth 0 -type d -perm 700)" ] && [ -n "$(find "$CLI_CONFIG/credentials.json" -maxdepth 0 -type f -perm 600 2>/dev/null)" ] ||
  fail "telflo login's credentials file isn't $CLI_CONFIG/credentials.json with mode 0600 in a 0700 folder"

step "telflo whoami and telflo org list (--json): the person's write token, smoke personal token, from the file, in the group organization, the current one of its organizations"
cli_run whoami --json whoami
[ "$cli_code" = "0" ] &&
  cli_json_is whoami --arg org "$group_id" '.kind == "person" and .source == "file" and .tokenName == "smoke personal token" and .access == "write" and .organizationId == $org' ||
  fail "telflo whoami didn't answer the person's token in the group organization: $(cli_said whoami)"
cli_run org-list --json org list
[ "$cli_code" = "0" ] && cli_json_is org-list --arg org "$group_id" '.current == $org and ([.items[].id] | index($org)) != null' ||
  fail "telflo org list didn't list the group organization as the current one: $(cli_said org-list)"

step "telflo config create (draft v1), config push (the draft updated in place, validated), config publish (v1) and config pull -o (the pushed text, byte for byte)"
(umask 077 && printf '%s' "$TEST_RUN_YAML" >"$CLI_DIR/config.yaml" && printf '# Pushed by the telflo CLI\n%s' "$TEST_RUN_YAML" >"$CLI_DIR/config-pushed.yaml") ||
  fail "writing the CLI's configuration files failed"
cli_run config-create --json config create --name "Stack smoke CLI $CLI_STAMP" -f "$CLI_DIR/config.yaml"
cli_configuration_id=$(cli_json config-create '.id // empty')
[ "$cli_code" = "0" ] && [ -n "$cli_configuration_id" ] &&
  cli_json_is config-create --arg org "$group_id" '.organizationId == $org and .versionNumber == 1 and .publishedVersionNumber == null' ||
  fail "telflo config create didn't create a draft v1 in the group organization: $(cli_said config-create)"
cli_run config-push --json config push "$cli_configuration_id" -f "$CLI_DIR/config-pushed.yaml"
[ "$cli_code" = "0" ] && cli_json_is config-push '.action == "patched" and .versionNumber == 1 and .published == false' ||
  fail "telflo config push didn't update the draft v1 in place: $(cli_said config-push)"
cli_run config-publish --json config publish "$cli_configuration_id" --version 1
[ "$cli_code" = "0" ] && cli_json_is config-publish '.isPublished == true and .publishedVersionNumber == 1' ||
  fail "telflo config publish didn't publish v1: $(cli_said config-publish)"
cli_run config-pull --json config pull "$cli_configuration_id" -o "$CLI_DIR/config-pulled.yaml"
[ "$cli_code" = "0" ] && cli_json_is config-pull '.versionNumber == 1' && cmp -s "$CLI_DIR/config-pushed.yaml" "$CLI_DIR/config-pulled.yaml" ||
  fail "telflo config pull -o didn't write v1's text as pushed: $(cli_said config-pull)"

if [ "$SMOKE_SITE" = "saas" ]; then
  cli_anonymous="the open route: valid exit 0, an invalid text exit 4 with its errors"
else
  cli_anonymous="the open route off: both exit 3 login_required"
fi
step "telflo validate, logged in on the configuration's pin (valid, exit 0), then anonymously with an empty config folder ($cli_anonymous; no login written)"
cli_run validate --json validate "$CLI_DIR/config-pushed.yaml" --config "$cli_configuration_id"
[ "$cli_code" = "0" ] && cli_json_is validate '.valid == true and (.errors | length) == 0' ||
  fail "telflo validate --config of a valid text didn't answer valid: $(cli_said validate)"
(umask 077 && printf '%s' "$PUBLIC_API_INVALID_YAML" >"$CLI_DIR/config-invalid.yaml") || fail "writing the CLI's invalid configuration failed"
# No login (an empty config folder, no TELFLO_TOKEN): the CLI takes the anonymous route, on TELFLO_SERVER (else it
# would ask https://telflo.com).
cli_code=0
(umask 077 && cli_env TELFLO_CLI_CONFIG_DIR="$CLI_ANONYMOUS_CONFIG" TELFLO_SERVER="$GATEWAY_URL" node "$SMOKE_CLI" --json validate "$CLI_DIR/config.yaml" \
  </dev/null >"$CLI_DIR/validate-anonymous.out" 2>"$CLI_DIR/validate-anonymous.err") || cli_code=$?
# cli_login_required <name>: oss's answer (its anonymous route off, the API's 404): exit 3,
# its --json error login_required.
cli_login_required() { [ "$cli_code" = "3" ] && [ "$(jq -r '.error.code // empty' "$CLI_DIR/$1.err" 2>/dev/null)" = "login_required" ]; }
if [ "$SMOKE_SITE" = "saas" ]; then
  [ "$cli_code" = "0" ] && cli_json_is validate-anonymous '.valid == true' ||
    fail "telflo validate without a login didn't answer valid: $(cli_said validate-anonymous)"
else
  cli_login_required validate-anonymous ||
    fail "telflo validate without a login, its anonymous route off, didn't exit 3 login_required: $(cli_said validate-anonymous)"
fi
cli_code=0
(umask 077 && cli_env TELFLO_CLI_CONFIG_DIR="$CLI_ANONYMOUS_CONFIG" TELFLO_SERVER="$GATEWAY_URL" node "$SMOKE_CLI" --json validate "$CLI_DIR/config-invalid.yaml" \
  </dev/null >"$CLI_DIR/validate-anonymous-invalid.out" 2>"$CLI_DIR/validate-anonymous-invalid.err") || cli_code=$?
if [ "$SMOKE_SITE" = "saas" ]; then
  [ "$cli_code" = "4" ] && cli_json_is validate-anonymous-invalid '.valid == false and (.errors | length) > 0' ||
    fail "telflo validate without a login of an invalid text didn't exit 4 with its errors: $(cli_said validate-anonymous-invalid)"
else
  cli_login_required validate-anonymous-invalid ||
    fail "telflo validate without a login of an invalid text, its anonymous route off, didn't exit 3 login_required: $(cli_said validate-anonymous-invalid)"
fi
[ -z "$(ls -A "$CLI_ANONYMOUS_CONFIG")" ] || fail "telflo validate without a login wrote into its config folder"

step "telflo ottl lint --context log: a valid condition (exit 0), a broken one (exit 4, its item invalid)"
cli_run ottl-lint --json ottl lint --context log --expr 'attributes["env"] == "prod"'
[ "$cli_code" = "0" ] && cli_json_is ottl-lint '.valid == true and .checked == 1' ||
  fail "telflo ottl lint of a valid condition didn't pass: $(cli_said ottl-lint)"
cli_run ottl-lint-broken --json ottl lint --context log --expr 'attributes["env" =='
[ "$cli_code" = "4" ] && cli_json_is ottl-lint-broken '.valid == false and [.items[].valid] == [false]' ||
  fail "telflo ottl lint of a broken condition didn't exit 4: $(cli_said ottl-lint-broken)"

step "telflo test --spec (a sample file and two OTTL rules) --config, on the published v1 in the real tester: succeeded, both rules passed (exit 0)"
(umask 077 && cp "$work_dir/stack-smoke-logs.json" "$CLI_DIR/sample.json" &&
  jq -n --arg body "$TEST_RECORD_BODY" '{signal: "logs", pipeline: "logs", duration: 2, sample: "./sample.json", rules: [
    {name: "the record came through", context: "log", quantifier: "any", condition: ("body == \"" + $body + "\"")},
    {name: "nothing else came through", context: "log", quantifier: "none", condition: "body == \"not in the sample\""}]}' \
    >"$CLI_DIR/spec.yaml") || fail "writing the CLI's test spec failed"
cli_run test --json test --spec "$CLI_DIR/spec.yaml" --config "$cli_configuration_id"
[ "$cli_code" = "0" ] &&
  cli_json_is test '.status == "succeeded" and .rulesSource == "inline" and ([.results[] | [.name, .passed]] == [["the record came through", true], ["nothing else came through", true]])' ||
  fail "telflo test didn't end succeeded with both rules passed: $(cli_said test) (status $(cli_json test '.status // empty'))"

step "telflo fleet create --json (no bearer in its reply), fleet groups (the Default group), deploy --group (the Default group serves v1) and fleet install --platform docker (exit 0, its stdout a docker run: a boolean, never printed)"
cli_run fleet-create --json fleet create --label "cli-$CLI_STAMP" --type server
cli_fleet_id=$(cli_json fleet-create '.id // empty')
# Exactly the route's five keys (jq's keys are sorted), as the public API steps' fleet: no bearer, nothing
# else.
[ "$cli_code" = "0" ] && [ -n "$cli_fleet_id" ] && cli_json_is fleet-create 'keys == ["id","label","tokenExpiresAt","tokenId","type"] and .type == "server"' ||
  fail "telflo fleet create didn't answer a server fleet's five keys: $(cli_said fleet-create)"
cli_run fleet-groups --json fleet groups "$cli_fleet_id"
cli_default_group_id=$(cli_json fleet-groups '[.[] | select(.isDefault)] | if length == 1 then .[0].id else empty end')
[ "$cli_code" = "0" ] && [ -n "$cli_default_group_id" ] || fail "telflo fleet groups didn't list one Default group: $(cli_said fleet-groups)"
# A group must serve a published version before an install joins it (409 collector_group_unassigned otherwise).
cli_run deploy --json deploy --fleet "$cli_fleet_id" --config "$cli_configuration_id" --group "$cli_default_group_id"
[ "$cli_code" = "0" ] &&
  cli_json_is deploy --arg group "$cli_default_group_id" --arg configuration "$cli_configuration_id" \
    '.action == "updated" and .id == $group and .configurationId == $configuration and .versionNumber == 1' ||
  fail "telflo deploy --group didn't put v1 on the Default group: $(cli_said deploy)"
cli_run install fleet install "$cli_fleet_id" --platform docker
[ "$cli_code" = "0" ] || fail "telflo fleet install --platform docker exited $cli_code (its output not printed)"
{ head -n 1 "$CLI_DIR/install.out" | grep -q "^OPAMP_TOKEN='" && grep -q '^docker run ' "$CLI_DIR/install.out"; } || fail "telflo fleet install's stdout isn't a docker run (not printed)"

step "telflo logout --json removes the credentials file; telflo whoami is then exit 3, not logged in"
cli_run logout --json logout
[ "$cli_code" = "0" ] && cli_json_is logout '.removed == true' && [ ! -e "$CLI_CONFIG/credentials.json" ] ||
  fail "telflo logout didn't remove the credentials file: $(cli_said logout)"
cli_run whoami-after --json whoami
[ "$cli_code" = "3" ] && [ "$(jq -r '.error.code // empty' "$CLI_DIR/whoami-after.err" 2>/dev/null)" = "auth_error" ] ||
  fail "telflo whoami after logout wasn't exit 3 auth_error: $(cli_said whoami-after)"

step "no tf_, tqd_ or tll_ in the CLI's outputs but install's stdout, and install's stdout in none of the other outputs nor the API's and the gateway's logs: grep -c, counts only"
# The CLI's outputs: every run's stdout and stderr (19 runs) but install's stdout, and the YAML config pull wrote.
cli_outputs=("$CLI_DIR/config-pulled.yaml")
for cli_file in "$CLI_DIR"/*.out "$CLI_DIR"/*.err; do
  [ "$cli_file" = "$CLI_DIR/install.out" ] || cli_outputs+=("$cli_file")
done
[ "${#cli_outputs[@]}" -ge 38 ] || fail "the CLI's runs left ${#cli_outputs[@]} output files, not the 38 expected, so the search proves less"
cli_count=$(cat -- "${cli_outputs[@]}" | grep -cE 'tf_[A-Za-z0-9_-]+|tqd_[A-Za-z0-9_-]+|tll_[A-Za-z0-9_-]+' || true)
[ "$cli_count" = "0" ] || fail "the CLI's outputs hold a tf_, tqd_ or tll_ value on ${cli_count:-an unread number of} lines (not printed)"
cli_count=$(cat -- "$CLI_DIR"/*.out "$CLI_DIR"/*.err | grep -cF -f "$work_dir/public-api-secret-personal" || true)
[ "$cli_count" = "0" ] || fail "the CLI's outputs hold the personal token on ${cli_count:-an unread number of} lines (not printed)"
# Every non-blank line of install's stdout is a pattern (a blank one would match every line).
(umask 077 && grep -v '^[[:space:]]*$' "$CLI_DIR/install.out" >"$work_dir/cli-install-patterns") || fail "reading install's stdout failed"
[ -s "$work_dir/cli-install-patterns" ] || fail "install's stdout has no line to search for"
cli_count=$(cat -- "${cli_outputs[@]}" | grep -cF -f "$work_dir/cli-install-patterns" || true)
[ "$cli_count" = "0" ] || fail "the CLI's other outputs hold a line of install's command on ${cli_count:-an unread number of} lines (not printed)"
(umask 077 && docker compose logs --no-color api gateway >"$work_dir/cli-logs" 2>&1) ||
  fail "reading the API's and the gateway's logs failed"
[ -s "$work_dir/cli-logs" ] || fail "the API's and the gateway's logs are empty, so the search proves nothing"
cli_count=$(grep -cF -f "$work_dir/cli-install-patterns" -- "$work_dir/cli-logs" || true)
[ "$cli_count" = "0" ] || fail "the API's or the gateway's logs hold a line of install's command on ${cli_count:-an unread number of} lines (not printed)"
rm -f "$CLI_DIR/install.out" "$work_dir/cli-install-patterns" "$work_dir/cli-logs"
cli_steps="drove the telflo CLI ($smoke_cli_version) through the gateway: logged in from stdin with the personal token (the credentials file 0600 in a 0700 folder), whoami, org list, a configuration created, pushed, published and pulled back byte for byte, validated on its pin and anonymously ($cli_anonymous), OTTL linted (exit 0 and 4), tested in the real tester (both rules passed), a fleet created (no bearer), its Default group deployed to, a docker install (a docker run, never printed) and logout (then exit 3), with no token in its outputs and its install command in no other output and no log"

# The CLI's steps take minutes; the access cookie lasts 15, and the per-token step mints its token and the next
# step revokes the personal one through the session.
step "refresh the session's access cookie: POST /api/v1/auth/refresh answers 200"
response=$(curl -s --max-time 30 -w '\n%{http_code}' -b "$JAR" -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/refresh" \
  -H 'X-Telflo-CSRF: 1') || fail "refreshing after the CLI's steps got no reply (curl exit $?)"
status=$(tail -n1 <<<"$response")
[ "$status" = "200" ] || fail "refreshing after the CLI's steps returned HTTP $status: $(sed '$d' <<<"$response")"

step "the per-token limit, 60 a minute, on a token minted for it alone: 61 GET /whoami, the first 60 answered 200, the 61st 429 rate_limited with Retry-After"
# A fresh token: its minute starts with its first request, so the 61 run in one window (an older token's could
# reset part-way).
mint_api_token public_api_limit_token "$GROUP_ORGANIZATION_URL/service-accounts/$public_api_service_account_id/api-tokens" "smoke limit token" read
(umask 077 && printf '%s\n' "$public_api_limit_token" >"$work_dir/public-api-secret-limit") || fail "writing the public API search files failed"
public_api_allowed=0
for public_api_request in $(seq 1 60); do
  public_api_call public_api_limit_token GET /whoami
  [ "$status" = "200" ] && public_api_allowed=$((public_api_allowed + 1))
done
[ "$public_api_allowed" = "60" ] || fail "of a fresh token's first 60 /whoami, $public_api_allowed answered 200, not 60 (the last HTTP $status $(reply_code))"
public_api_call public_api_limit_token GET /whoami
[ "$status" = "429" ] && [ "$(reply_code)" = "rate_limited" ] ||
  fail "a fresh token's 61st /whoami returned HTTP $status $(reply_code), not 429 rate_limited"
grep -qiE '^retry-after: [1-9][0-9]*'$'\r''?$' "$PLATFORM_REPLY_HEADERS" || fail "the per-token limit's 429 has no Retry-After"

step "revoke the personal token through the session (204); it's then the one 401"
platform DELETE "$GATEWAY_URL/api/v1/auth/me/api-tokens/$public_api_personal_token_id"
[ "$status" = "204" ] || fail "revoking the personal token returned HTTP $status: $(reply_code)"
public_api_personal_token_id=""
public_api_call public_api_personal_token GET /whoami
[ "$status" = "401" ] && [ "$(reply_code)" = "invalid_api_token" ] ||
  fail "the revoked personal token's /whoami returned HTTP $status $(reply_code), not 401 invalid_api_token"

step "after every public API call: the API's and the gateway's logs hold no token and no pipeline name: grep -cF of each, counts only (docker compose logs api gateway)"
(umask 077 && docker compose logs --no-color api gateway >"$work_dir/public-api-logs" 2>&1) ||
  fail "reading the API's and the gateway's logs failed"
[ -s "$work_dir/public-api-logs" ] || fail "the API's and the gateway's logs are empty, so the search proves nothing"
for public_api_secret in write read personal limit; do
  public_api_count=$(grep -cF -f "$work_dir/public-api-secret-$public_api_secret" -- "$work_dir/public-api-logs" || true)
  [ "$public_api_count" = "0" ] || fail "the API's or the gateway's logs hold the $public_api_secret token on ${public_api_count:-an unread number of} lines (not printed)"
done
public_api_count=$(grep -cF -f "$work_dir/public-api-marker" -- "$work_dir/public-api-logs" || true)
[ "$public_api_count" = "0" ] || fail "the API's or the gateway's logs hold the pipeline name on ${public_api_count:-an unread number of} lines"
grep -qF '"PUT /api/public/v1/[redacted] HTTP/1.1"' "$work_dir/public-api-logs" ||
  fail "the gateway's access log holds no PUT /api/public/v1/[redacted] line for route 14"
unset public_api_write_token public_api_read_token public_api_personal_token public_api_limit_token
public_api_steps="drove the public API through the gateway with a service account's write and read tokens and a personal token (whoami and orgs for both kinds, the person's organization header 400 then 200, a read token refused a write, a configuration created, checked by the real validator and published to the opamp-server, a pipeline's rules replaced by its name, /validate, the real evaluator's /ottl/lint, a fleet, a group and a docker install, a YAML test run in the real tester read back with its output, the document, the reference page with its CSP, nginx's 413 and the per-token 429), no token or pipeline name in the API's or the gateway's logs"

step "delete the gateway (204: the Default group and the Cluster left), then the Kubernetes fleet (204)"
platform DELETE "$K8S_FLEET_URL/groups/$k8s_gateway_id"
[ "$status" = "204" ] || fail "deleting the gateway returned HTTP $status: $(reply_code)"
platform GET "$K8S_FLEET_URL/groups"
[ "$status" = "200" ] && [ "$(k8s_group_names)" = '["(default)","cluster"]' ] ||
  fail "after the gateway's delete, the Kubernetes fleet's groups (HTTP $status) aren't the Default group and cluster: $(k8s_group_names)"
platform DELETE "$K8S_FLEET_URL"
[ "$status" = "204" ] || fail "deleting the Kubernetes fleet returned HTTP $status: $(reply_code)"
k8s_fleet_id=""

step "clear the Default group's assignment: PATCH .../groups/:groupId with assignedVersionId null"
platform PATCH "$GROUP_FLEETS_URL/$managed_fleet_id/groups/$managed_default_group_id" '{"assignedVersionId": null}'
[ "$status" = "200" ] && [ "$(json_field '.group.assignedVersion' "$body")" = "null" ] && [ "$(json_field '.group.assignedPublishedVersionId' "$body")" = "null" ] ||
  fail "clearing the assignment returned HTTP $status: $(head -c 500 <<<"$body")"

step "the configuration, used no longer, is deleted: DELETE .../configurations/:configurationId answers 204, and its published version leaves the opamp-server"
platform DELETE "$GROUP_CONFIGURATIONS_URL/$managed_configuration_id"
[ "$status" = "204" ] || fail "deleting the configuration once unassigned returned HTTP $status: $(head -c 500 <<<"$body")"
managed_deleted_configuration_id=$managed_configuration_id
managed_configuration_id=""
# The platform's after-response delete, which the Default group's assignment
# would have refused, now removes it (as the fleet steps check theirs).
stack_smoke publications "$group_id" "$managed_deleted_configuration_id" 0 ||
  fail "the opamp-server still holds the published version of the managed configuration $managed_deleted_configuration_id after its delete (above)"

step "remove edge-b1, edge-b2 and the smoke collector's image"
managed_cleanup_failed=""
for container in $managed_containers; do
  docker rm -f "$container" >/dev/null 2>&1 || managed_cleanup_failed="$managed_cleanup_failed the container $container;"
done
managed_containers=""
docker rmi "$managed_image" >/dev/null 2>&1 || managed_cleanup_failed="$managed_cleanup_failed the image $managed_image;"
managed_image=""
[ -z "$managed_cleanup_failed" ] || fail "removing the managed fleet's collectors failed: $managed_cleanup_failed"
unset managed_default_bearer managed_rotate_bearer managed_revealed_bearer managed_new_rotate_bearer

# The id is the group organization's, never the personal one's, and the
# platform refuses to delete a personal organization anyway; the account
# keeps its personal organization, which the last step checks.
step "delete the group organization: DELETE /api/v1/organizations/:id"
[ "$group_id" != "$personal_id" ] || fail "the group organization's id is the personal organization's"
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE "$GATEWAY_URL/api/v1/organizations/$group_id" \
  -H 'X-Telflo-CSRF: 1')
[ "$status" = "204" ] || fail "deleting the organization returned HTTP $status"

# The organization's logo went with it: its public read is the plain 404 at once (no live
# organization), and on s3 its object is removed after the delete's commit (polled). A poll counts only the
# filer's definite 404 for the key (object_store_missing), never a read that failed some other way, and is then
# checked against the bucket's own listing, so a filer that can't be read never passes for one without the
# object.
step "the deleted organization's logo: GET /api/v1/organization-logos/:organizationId/:logoId answers 404 \"Not found.\" in plain text"
status=$(curl -s --max-time 30 -o "$qd_dir/logo-gone" -D "$qd_dir/logo-gone.headers" -w '%{http_code}' \
  "$GATEWAY_URL/api/v1/organization-logos/$group_id/$logo_id" || true)
qd_refused logo-gone "Not found." 404 ||
  fail "the deleted organization's logo returned HTTP $status, not 404 Not found. in plain text: $(qd_redacted "$qd_dir/logo-gone" 300)"
if [ "$file_store_kind" = "s3" ]; then
  step "S3: the object store no longer holds the logo at its key (at most 30 polls)"
  logo_object_gone=""
  for _ in $(seq 1 30); do
    if object_store_missing "$logo_key?metadata=true"; then
      object_store_json "" >/dev/null || fail "couldn't read the object store's bucket telflo-files to confirm the logo's object is gone"
      logo_object_gone=yes
      break
    fi
    sleep 1
  done
  [ -n "$logo_object_gone" ] || fail "the object store still holds the deleted organization's logo at its key after 30 polls"
fi

step "the platform removed the group organization from the opamp-server"
stack_smoke group-gone "$group_id" ||
  fail "the group organization $group_id is still registered in the opamp-server (above)"

# The organization's delete reaches the opamp-server and
# takes its fleets with it: the management API then answers the
# organization's fleets 404 organization_not_found. Polled: the platform's
# delete runs after its response, retried on a failure.
step "the opamp-server removed the group organization's fleets with it: GET .../organizations/:id/fleets answers 404 organization_not_found (at most 30 polls)"
managed_fleets_gone=""
for _ in $(seq 1 30); do
  management GET "$OPAMP_MANAGEMENT_URL/api/v1/organizations/$group_id/fleets"
  if [ "$status" = "404" ] && [ "$(json_field '.error.code' "$body")" = "organization_not_found" ]; then
    managed_fleets_gone=yes
    break
  fi
  sleep 1
done
[ -n "$managed_fleets_gone" ] ||
  fail "the management API still answers the deleted group organization's fleets after 30 polls: HTTP $status $(json_field '.error.code // empty' "$body")"
managed_fleet_id=""

# The delete moved the session to the account's fallback organization: its
# access cookie is answered access_token_expired, and a refresh issues one
# for the personal organization.
step "the account is kept: its session refreshes into its personal organization"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/refresh" \
  -H 'X-Telflo-CSRF: 1')
status=$(tail -n1 <<<"$response")
[ "$status" = "200" ] || fail "refreshing after the delete returned HTTP $status: $(sed '$d' <<<"$response")"
response=$(curl -s -w '\n%{http_code}' -b "$JAR" "$GATEWAY_URL/api/v1/auth/me")
status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")
[ "$status" = "200" ] || fail "GET /api/v1/auth/me after the delete returned HTTP $status: $body"
[ "$(jq -r '.user.email' <<<"$body")" = "$EMAIL" ] && [ "$(jq -r '.organization.id' <<<"$body")" = "$personal_id" ] &&
  [ "$(jq -r '.organization.type' <<<"$body")" = "personal" ] ||
  fail "after the delete, /me is not the account in its personal organization: $body"


# The run's secrets in no log: both passwords, the invitation's token and, in oss, the
# bootstrap's set-password link's token (run-secrets, written as each was read), searched in the API's, the
# gateway's and the web server's logs at the end of the run, counts only.
if [ "$SMOKE_SITE" = "saas" ]; then
  secret_kinds="both passwords and the invitation's token"
  expected_secrets=3
else
  secret_kinds="both passwords, the invitation's token and the set-password link's token"
  expected_secrets=4
fi
step "last: the API's, the gateway's and the web server's logs hold none of the run's secrets ($secret_kinds): grep -cF -f, counts only (docker compose logs api gateway web)"
secret_lines=$(grep -c '' "$RUN_SECRETS" || true)
[ "$secret_lines" = "$expected_secrets" ] ||
  fail "the run's secrets file holds ${secret_lines:-no} lines, not the $expected_secrets this site's run reads, so the search proves less"
(umask 077 && docker compose logs --no-color api gateway web >"$work_dir/final-logs" 2>&1) ||
  fail "reading the API's, the gateway's and the web server's logs failed"
[ -s "$work_dir/final-logs" ] || fail "the API's, the gateway's and the web server's logs are empty, so the search proves nothing"
secret_hits=$(grep -cF -f "$RUN_SECRETS" -- "$work_dir/final-logs" || true)
[ "$secret_hits" = "0" ] ||
  fail "the API's, the gateway's or the web server's logs hold a secret of the run on ${secret_hits:-an unread number of} lines (not printed)"
rm -f "$work_dir/final-logs"
if [ "$SMOKE_SITE" = "saas" ]; then
  first_account_steps="registered, emailed, verified, signed in"
else
  first_account_steps="refused a registration (invite-only), bootstrapped the first account with telflo-admin (its set-password link never printed) and set its password through it, signed in"
fi

echo "OK: the full stack ($SMOKE_SITE) $first_account_steps, refreshed, created and switched organizations, invited $INVITEE_EMAIL (who joined from the emailed token), created, listed and deleted a configuration, read, saved (over 2 MiB too) and read back its YAML and graph, checked a valid and an invalid text with the collector of its pin, created (over 2 MiB), renamed, selected and read its versions, published one and found its snapshot, with its collector, in the opamp-server and none after the delete, ran a real test of it in the collector tester and read the record back from its output, ran a suite's test configuration of it there, its run carrying its breadcrumb, found the suite copied to version 2, had the OTTL evaluator check a validation pipeline's rules at Save (refusing a broken condition and regex in its words) and after two runs (one passed, one ended validation_failed), read the regex library, saved one of its entries and a Compare-shaped rule and ran them, $product_admin_steps, found the validation pipeline copied to version 2, found the OTTL evaluator healthy and refusing calls without its secret, found the Initial Configuration, signed out and reset the password of $EMAIL through $GATEWAY_URL, lists no OIDC providers, serves robots.txt disallowing every path, $playground_steps, $inquiry_steps, and reached the opamp-server through the platform's client, which found the new account's personal organization registered, with each side refused the other's database, and found the group organization registered there, renamed there after its rename and gone after its delete, the account kept in its personal organization; and enrolled a real collector in a fleet through the opamp-server's agent endpoint, which applied the version assigned to its group, left another, with nothing assigned, unassigned through a second replica (sent no configuration), refused a collector naming no group, deleted a group's collector with the group (refused when it named that group again), and refused a revoked token on both replicas; and, through the platform, listed a published configuration's published versions (ids, numbers, labels and dates only), created a fleet (and again, safely; its summary unseen, with one rotate token in no grace), assigned a published version to its Default group, read two real collectors (one applying it, one unassigned; the summary's last seen recent in the fleet's read and the list; the collector list, a collector's read and its error history no-store), pinned the unassigned one to the published version (applied in sync from its pin) and unpinned it, refused to delete the configuration in use, revealed a token (sealed anew), rotated one (the collector following it; the summary in the rotation's grace) and revoked the old one (the summary out of grace), read the token history (every event by the person, newest first, no bearer, paged by its cursor), $install_steps, refused the Kubernetes key on a server fleet's group (its create and a save), made a Kubernetes fleet's Cluster and a gateway (refusing Docker mounts, a gateway named node, a role not the name's, a create without the key, a rename and the Default group's save naming another role there), saved the Default group as the Agent, read the Agent's and the gateway's Helm facts, refused each install on the other fleet type, downloaded a Helm values link's values.yaml (the contracts' file, its token in no log) through the gateway with no session, refused it while the organization's public install links were off (and a link's create), served it again once on (to a client container, its audit row holding that container's address, not the gateway's) and refused it once revoked, and set the group organization's logo (a 2 MiB PNG; over 3 MiB the gateway's 413) and read it back publicly with its headers, $library_steps, $admin_steps, $public_api_steps, $cli_steps, deleted the gateway and the fleet, deleted the configuration once unassigned (its published version leaving the opamp-server), found the fleets and the logo gone with the group organization, and found none of the run's secrets in its logs"
