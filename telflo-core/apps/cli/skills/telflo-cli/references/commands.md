# telflo command reference

Global: `--json` on every command: one JSON document on stdout; on
stderr one JSON object a line, `{"note": "…"}` per note then `{"error":
{"code", "message", "status"}}` on failure (a usage error, a missing
required option say, is `usage_error`, exit 2); only an interactive
login's prompts and browser lines are plain text. `telflo -V` (or
`--cli-version`) prints the CLI's version; `--version <n>` is always a
configuration version's *number* (`config pull`, `config publish`, `config
rules`, `deploy`, `test`).

Environment: `TELFLO_TOKEN` (a token for this shell, over the stored login),
`TELFLO_SERVER` (the server; there is no default), `TELFLO_ORG`
(a personal token's organization for this shell), `TELFLO_CLI_CONFIG_DIR`
(the folder of `credentials.json`; else `$XDG_CONFIG_HOME/telflo`, else
`~/.config/telflo`). No command takes a token on argv.

Exit codes: 0 OK · 1 API, network or run error · 2 usage · 3 auth (not
logged in, 401, 403) · 4 a check found a problem (invalid YAML, a lint or a
test failed).

Ids are UUIDs; any case is accepted, a malformed one is exit 2.

## Login

- `telflo login [--server <url>] [--org <id>] [--no-browser]` — the token
  from standard input when it isn't a terminal (one line), else the browser
  (`<server>/cli-auth`: approve, and the page hands a new personal token to
  the CLI on `127.0.0.1`, revoking that machine's earlier CLI token; the
  hidden prompt beside it takes a token pasted from the page's fallback, an
  empty Enter ignored), or with `--no-browser` a hidden prompt alone (a
  pasted or piped token revokes nothing). A warning when `TELFLO_TOKEN` is
  set (it still wins over the stored login).
  The token is checked (`/whoami`; a 401 stores nothing), the organization
  chosen (a service account's own; a personal token's `--org`, its only
  one, or a number typed at a terminal), then stored. JSON: `{server, kind,
  tokenName, access, organizationId, organizationName}`. `kind` is `person`
  or `service_account`.
- `telflo whoami` — JSON: `{server, source ("file"|"environment"), kind,
  tokenName, access ("read"|"write"), organizationId, organizationName}`.
  Never the token.
- `telflo logout` — removes the credentials file (JSON `{removed}`). The
  token itself isn't revoked: the Account page (personal) or Settings ›
  Service Accounts.
- `telflo org list` — the organizations the token can act in. JSON:
  `{items: [{id, name, type, role}], current}`.
- `telflo org use <id>` — the stored personal login's organization (checked
  against `org list`). JSON: `{organizationId, organizationName}`. Not for
  a service account or `TELFLO_TOKEN` (set `TELFLO_ORG` instead).

## validate

- `telflo validate <file|-> [--collector-version <v>] [--distribution <d>]
  [--config <id>]` — a real collector checks the YAML; nothing is stored.
  Logged in: the organization's route (its variables filled in).
  Not logged in: the anonymous route where the server turns it on (no
  variables; a few a minute); off, the CLI says to log in (exit 3).
  `--config <id>` validates on that configuration's pin (explicit flags
  win) and needs a login. JSON: `{valid, collectorVersion, errors:
  [{message, componentPath}]}`. Exit 4 invalid; 2 for an unknown
  distribution, or an unknown or retired version; 1 "Couldn't validate (not a verdict on the
  YAML)" when the validator is unavailable.

## ottl

- `telflo ottl lint [file|-] [--context <ctx>] [--kind
  condition|statement|value|valueExpression] [--expr <ottl>]...` — without
  `--context` the file is a collector configuration and every OTTL
  expression in `transform`, `filter`, `routing` and `tail_sampling` is
  checked; with `--context` (`log`, `span`, `spanevent`, `metric`,
  `datapoint`, `resource`, `scope`), the `--expr` values and the file's
  lines are expressions of `--kind` (default `condition`). JSON: `{valid,
  ottlVersion, checked, items: [{kind, index, input, valid, error, context,
  location, note}], skipped}`. Exit 4 when an item is invalid, or the YAML
  itself isn't valid (its errors are the output); 2 for a usage error; 1
  "Couldn't lint" when the linter is unavailable. Needs a login.

## config

- `telflo config list` — every configuration. JSON: an array of `{id, name,
  description, organizationId, isPublished, distribution, collectorVersion,
  versionNumber (the latest), publishedVersionNumber (the highest
  published, or null), updatedAt}`.
- `telflo config get <id>` — the configuration (with its latest `yaml`)
  and `versions: [{id, versionNumber, status (draft|published), label,
  distribution, collectorVersion, createdAt, publishedAt}]`, highest first.
- `telflo config pull <id> [--version <n>] [-o <file>]` — the YAML exactly
  as stored, to stdout or the file; its pin on stderr (with `-o`, in
  stdout's "Wrote …" line instead). JSON: `{id,
  versionNumber, yaml, distribution, collectorVersion}` (`out` in place of
  `yaml` with `-o`).
- `telflo config create --name <name> -f <file|->` — a new configuration
  with its draft v1. JSON: the configuration.
- `telflo config push <id> -f <file|-> [--publish] [--label <text>]` — a
  draft latest is updated in place (validated); a published latest gets a
  new version (validated on its pin first). `--description` is `--label`'s
  alias; a label names a new version only (a note says so on a draft).
  JSON: `{action: "patched"|"appended", versionNumber, published}`; an
  invalid text: `{status: "invalid", errors}` and exit 4, nothing saved. A
  409 says to run it again (someone changed the version meanwhile).
- `telflo config publish <id> --version <n>` — publish a version. JSON: the
  configuration.
- `telflo config rules <id> [--version <n>]` — the validation pipelines
  saved on a version (default the latest): what `telflo test --saved` runs
  and the Validation tab shows. JSON: `{configurationId, versionNumber,
  items: [{id, pipeline, signal, versionNumber, rules: [{id, name, kind,
  target, pattern, ottl, isApiOwned, …}], …}]}`.

## flows

- `telflo flows list` — Telflo's prebuilt configurations. JSON: an array of
  `{id, slug, name, summary, source, authorName, authorUrl, signals, tags,
  collectorVersion, distribution, sourceUrl, updatedAt}`.
- `telflo flows get <slug>` — the same, with `description` (Markdown) and
  `yaml`.
- `telflo flows pull <slug> [-o <file>]` — the YAML to stdout or the file.
  JSON: `{slug, distribution, collectorVersion, yaml}` (`out` in place of
  `yaml` with `-o`).

## fleet and deploy

- `telflo fleet list` — JSON: an array of `{id, label, type, status,
  createdAt}`.
- `telflo fleet create --label <label> --type server|kubernetes-supervisor
  [--expires-in 180d|1y|2y|never]` — JSON: `{id, label, type, tokenId,
  tokenExpiresAt}`; no bearer (the install command carries the fleet's
  credentials).
- `telflo fleet groups <fleet-id>` — JSON: an array of `{id, fleetId, name,
  isDefault, role, namespace, replicas, assignedPublishedVersionId,
  configurationId, versionNumber, createdAt, updatedAt}`, the Default group
  first.
- `telflo fleet install <fleet-id> --platform docker|linux|kubernetes
  [--group <id>] [--display-name <name>] [--arch amd64|arm64] [--root-path
  <dir>] [--no-systemd] [--env NAME=value]...` — the command that installs
  a collector, on stdout only; notes on stderr. **A secret**: it holds the
  fleet's credentials. `docker` and `linux` need a `server` fleet (its
  Default group unless `--group`), `kubernetes` a `kubernetes-supervisor`
  fleet (its only group; with several, `--group`). The group must serve a
  published version (`deploy` first: a new fleet's Default group serves
  none). `linux` always sends `--arch` (amd64), `--root-path`
  (`/etc/otelcol`) and systemd (`--no-systemd` runs the collector in the
  foreground); its command's link works for 24 hours. JSON: `{fleetId,
  fleetType, platform, groupId, groupName, command, notes, expiresAt}`.
- `telflo deploy --fleet <id> --config <id> [--version <n>] [--group <id> |
  --name <name>] [--replicas <n>] [--namespace <ns>] [--role
  node|cluster|gateway]` — the version (default the highest published; none
  published is exit 4) to the fleet: the one group serving that
  configuration is updated (several serving: exit 2, naming them);
  `--group` names the group to update; `--name` creates one; with neither,
  when no group serves the configuration, the Default group is assigned if
  it serves no version yet (a new fleet's first deploy), else `--name` is
  needed. A Kubernetes group's role comes from its name (`cluster` for a
  group named `cluster`, `gateway` for any other; the Default group is the
  Agent, `node`): `--role`, if given, must match. `--role cluster` or
  `gateway` asks for a new group, so without `--name` it is refused (exit
  2, "pass --name"); `--role node` is never valid on a create (alone, it
  may still go to the Default group); on a group that exists `--role` does
  nothing (a note). JSON: the group and `action: "updated"|"created"`.

## test

- `telflo test --spec <spec.yaml|-> (-f <yaml|-> | --config <id> [--version
  <n>] | -f <yaml> --config <id>) [--collector-version <v>] [--distribution
  <d>] [--save | --saved] [--output <file>] [--timeout <seconds>]` — the
  spec's sample and rules run on a real collector in the sandbox, then the
  CLI waits for the run. The collector: the flags, then for `-f` with
  `--config` the configuration's pin over the spec's `collector_version` /
  `distribution`; for `--config` alone the spec's fields over the stored
  version's pin; for `-f` alone the spec's fields; else the server's
  default. `--save` (a stored version only) replaces the
  version's API-owned rules on the spec's pipeline, then runs the saved
  rules; `--saved` runs the saved rules as they are (the spec's rules are
  ignored, with a note). `--output` saves the run's output (a failure there
  is a warning on stderr; the run's result stands). The spec's rules are
  checked before anything is sent (exit 2 naming the rule and the field).
  JSON: the run `{id, status (succeeded|failed|validation_failed), success,
  signal, pipeline, durationMs, collectorVersion, distribution,
  validationResults, errorMessage, …}` plus `rulesSource
  ("inline"|"saved")`, `results: [{position, name, id, passed, error,
  advisory, detail}]` and, with `--save`, `savedPipeline: {id, pipeline,
  created, rulesReplaced, rulesKept}`. Exit 0 succeeded, 4 failed or
  validation_failed, 1 a run that didn't end by the deadline (`--timeout`,
  else its duration and 120 s), a full queue, or `--saved` with nothing
  saved; 2 usage (`--save` or `--saved` with `-f`, both together, an
  unknown distribution, or an unknown or retired collector version).

## skills

- `telflo skills install [--project | --global]` — copies this skill into
  `./.claude/skills/telflo-cli` (the default) or
  `~/.claude/skills/telflo-cli`, replacing an earlier copy there. JSON:
  `{installed, files}`.
