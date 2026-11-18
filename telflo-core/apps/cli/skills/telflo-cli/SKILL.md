---
name: telflo-cli
description: Use the telflo CLI to push, validate, test and deploy OpenTelemetry Collector configurations in a Telflo organization. Use when asked to update a collector configuration in Telflo, validate collector YAML with a real collector, lint OTTL, run pipeline tests on a configuration, or deploy a configuration's version to a fleet from the terminal or CI.
---

# Telflo CLI

`telflo` works with Telflo's configurations, fleets and test runs from the
terminal, through Telflo's public API (`<server>/api/public/v1`). It needs
Node.js 22 or newer. If `telflo` isn't on the PATH, ask the user to install
it (the CLI's README says how); don't install it yourself. Every command:
[references/commands.md](references/commands.md). Writing test specs:
[references/testing.md](references/testing.md).

## Tokens are secrets

A Telflo token is `tf_` and 43 characters. Never put one on a command line
(no command takes one as a flag), in a file of the repository, in a commit,
in chat or in your output. Never print `TELFLO_TOKEN` or the credentials
file. The CLI never prints a token itself: `whoami` names the token by its
name. The command `telflo fleet install` prints holds a fleet's
credentials: never show it, paste it into chat or commit it.

## Logging in

**For agents and CI (non-interactive):** the user sets the environment;
no login command is needed:

```bash
export TELFLO_TOKEN=...          # set by the user, never typed by you on a command line
export TELFLO_SERVER=https://...  # the Telflo server: there is no default
export TELFLO_ORG=<org-id>        # only for a personal token: the organization it acts in
```

A service account's token (Settings › Service Accounts, organization admins
only) acts in its own organization: `TELFLO_ORG` is refused for it. A
personal token (the Account page) can act in any organization its person
belongs to, so it needs `TELFLO_ORG` (`telflo org list` shows the ids).
`TELFLO_TOKEN` goes only to `TELFLO_SERVER` (required with it: there is no
default server), never to the server of a stored login.

**For a person at a terminal:** ask the user to run `telflo login`
themselves, then check it with `telflo whoami`:

- `telflo login` opens the browser on `<server>/cli-auth`; the signed-in
  person approves (write or read access, 1, 7, 30 or 90 days; write and 30
  by default), which mints a personal token named `CLI — <host> · <time>`
  and revokes that machine's earlier CLI token. When the browser can't
  hand the token back, the page shows it once to paste into the waiting
  terminal (an empty Enter there is ignored).
- `telflo login --no-browser` asks for a token at a hidden prompt (made on
  the Account page, or a service account's). A pasted token, or one from
  standard input, revokes nothing.
- `telflo login` warns when `TELFLO_TOKEN` is set: that token still wins
  over the stored login until it's unset.
- A token on standard input, for scripts:
  `telflo login --server <url> --org <id> < token-file`.
- `--server <url>` picks the server (on `login` only; without it, and
  without `TELFLO_SERVER` or a stored login, `telflo login` asks for the
  server's URL at a terminal and refuses without one); `--org <id>` the
  organization of a personal token (one organization is taken; several are
  listed at a terminal to choose from; without a terminal, `--org` is
  needed).
- `telflo org list` and `telflo org use <id>` switch a personal token's
  organization without logging in again.
- `telflo logout` removes the stored login only: the token still works
  until it expires or is revoked (the Account page for a personal token,
  Settings › Service Accounts for a service account's).

**The server rule:** the server is an origin only (no path); `https://`
only, except `http://localhost`, `http://127.x.x.x` and `http://[::1]`. A
stored token goes only to the server it was entered for: `TELFLO_SERVER`
naming another is refused (exit 3; run `telflo login --server …`). No
redirect is followed.

The login is stored in `$TELFLO_CLI_CONFIG_DIR/credentials.json`, else
`$XDG_CONFIG_HOME/telflo/credentials.json`, else
`~/.config/telflo/credentials.json` (mode 0600 in a 0700 folder; a file
others can read is refused). Never read or print it.

## Output contract

`--json` (anywhere on the command line) prints one JSON document on stdout,
and stderr is then one JSON object a line: `{"note": "…"}` per note, then
`{"error": {"code", "message", "status"}}` on failure (a usage error
such as a missing required option is `usage_error`, exit 2). Only an
interactive `telflo login`'s prompts and browser lines stay plain text.
Exit codes:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | an API, network or run error (a 503 from the validator: nothing was checked) |
| 2 | a usage error (a flag, an id, a test spec; an unknown collector version) |
| 3 | not logged in, the token refused (401) or not allowed (403; a read-only token on a write) |
| 4 | a check found a problem: invalid YAML, an OTTL lint failure, a failed test |

Branch on the exit code; read the details from stdout's JSON. Error
messages are fixed words: no reply body is ever shown.

## The core loop (edit → validate → push → test → deploy)

```bash
telflo config list --json                         # find the configuration's id
telflo config pull <id> -o config.yaml            # its latest YAML (the "Wrote …" line names its collector pin)
# ... edit config.yaml ...
telflo ottl lint config.yaml                      # every OTTL expression parses (exit 4 if not)
telflo validate config.yaml --config <id>         # a real collector, on that configuration's pin (exit 4 = invalid)
telflo config push <id> -f config.yaml --publish  # saved (validated first), and published
telflo test --spec test.yaml --config <id>        # exit 4 = a rule failed
telflo deploy --fleet <fleet-id> --config <id>    # the published version to the fleet's group serving it
```

## Which collector runs (validate and test)

Every configuration version is pinned to a collector distribution and
version (`config pull` prints it). The `--collector-version` and
`--distribution` flags always win; then:

- `validate file --config <id>`: that configuration's pin; without
  `--config`, the server's default (`config push` always validates on the
  pin).
- `test --spec s.yaml -f file --config <id>` (a local file): the
  configuration's pin, over the spec's `collector_version` /
  `distribution`, then the server's default.
- `test --spec s.yaml --config <id>` (a stored version): the spec's
  `collector_version` / `distribution`, over the stored version's pin.
- `test --spec s.yaml -f file` (no `--config`): the spec's fields, then
  the server's default.

When you validate or test a local file that belongs to a stored
configuration, always pass `--config <id>`: without it the file is checked
on the default collector, which may not be the one it will run on.

Logged in, validation and test runs fill in the organization's variables
(`${org:NAME}`). Without a login, `telflo validate` uses the anonymous
route where the server turns it on (off by default: the CLI then says to
log in): no organization, `${org:NAME}` left as written, a few validations
a minute.

## Versions (why push behaves as it does)

Versions are numbered by the server, and **published versions never
change**:

- `config push` updates the latest version in place when it is a draft
  (validated first), and adds a new version when the latest is published
  (validated on its pin first). Read the version's number from push's
  JSON (`versionNumber`, `action` `patched` or `appended`); never assume
  it. An invalid text exits 4 with the collector's errors; nothing is
  saved.
- A 409 (`configuration_version_changed` or
  `configuration_version_published`) means someone changed it meanwhile:
  run the push again.
- `deploy` sends the highest published version unless `--version` names
  one; with nothing published it exits 4 (`config push --publish` or
  `config publish` first).
- `deploy` updates the fleet's one group serving that configuration;
  `--group <id>` names one (`telflo fleet groups <fleet-id>`), and `--name
  <name>` creates one. With neither, when no group serves it, the fleet's
  Default group is assigned if it serves no version yet (a new fleet's
  first deploy); otherwise `--name` is needed.

## Lint OTTL before you push

Run `telflo ottl lint config.yaml` after editing any `transform`, `filter`,
`routing` or `tail_sampling` block, and `telflo ottl lint --context <ctx>
--expr '<ottl>'` while drafting one expression (`--kind statement` for
`set(...)`-style statements). Exit 4: something doesn't parse (each `FAIL`
names the YAML location and the grammar's error); a `note` is advisory; a
`skip` is an expression the linter can't judge. A single-escaped regex
(`"\d"`) is an error even though it parses: write `"\\d"`. Exit 1 "Couldn't
lint": the linter is unavailable and nothing was checked.

## Installing collectors

A collector joins a group that serves a published version. For a new
fleet:

```bash
telflo fleet create --label <l> --type <server or kubernetes-supervisor>
telflo deploy --fleet <fleet-id> --config <id>      # the new fleet's Default group now serves the published version
```

Then, only when the user asks for the command in a file, make the file
private first (the redirect keeps its 0600 mode), then write it:

```bash
install -m 600 /dev/null install.sh
```

```bash
telflo fleet install <fleet-id> --platform <docker, linux or kubernetes> > install.sh
```

A new fleet's Default group serves nothing, so the first `deploy` assigns
it; later ones update the group serving that configuration (`--name <n>`
creates another group, `--group <id>` names one: `telflo fleet groups
<fleet-id>`). `fleet install` prints the command to run on the target host
or cluster: the command on stdout only, notes on stderr. **The command
holds the fleet's credentials:** don't run it on the user's workstation
unless that is the target, don't show it, hand it over only as the user
asks, and write it only into a file made with mode 0600 first (as
above).
`docker` and `linux` need a `server` fleet, `kubernetes` a
`kubernetes-supervisor` fleet. A Kubernetes fleet's Default group is the
Agent (role `node`); a group added with `--name` takes its role from its
name (`cluster` for `cluster`, `gateway` for any other; `--role node` is
never valid on a new group, and when no group serves the configuration,
`--role cluster` or `gateway` without `--name` is refused, exit 2; on a
group that already serves it, `--role` does nothing and prints a note).
Once the fleet has more than one group, `fleet install --platform
kubernetes` needs `--group <id>`. Pass values the configuration
reads with `--env NAME=value` (the notes name the ones not given).

`telflo flows list` / `flows get <slug>` / `flows pull <slug> -o file.yaml`
read Telflo's prebuilt configurations; start one with `telflo config create
--name <n> -f file.yaml`.

## Pipeline tests

Write a test spec (the format and the rules for writing one:
[references/testing.md](references/testing.md)), then:

```bash
telflo test --spec test.yaml -f config.yaml                 # a local file (the spec's collector, or the default)
telflo test --spec test.yaml -f config.yaml --config <id>   # a local file on that configuration's pin
telflo test --spec test.yaml --config <id>                  # a stored version (the latest, or --version)
```

The run uses a real collector in Telflo's sandbox. Assert classes of
behaviour, not the sample's literals. When the rules pass, `--save` puts
them in the version's Validation tab (`telflo test --spec test.yaml --config
<id> --save`); rules people wrote there are kept. `--saved` runs what is
saved.

## Common failures

| What you see | Meaning | What to do |
|---|---|---|
| exit 3, "Not logged in" | no stored login and no `TELFLO_TOKEN` | ask the user to log in or set `TELFLO_TOKEN` |
| exit 3 after a 401 | the token expired or was revoked | ask the user to run `telflo login` again |
| exit 3, "read-only" | a read token on a write | ask for a write token |
| exit 3, "The stored login is for …" | `TELFLO_SERVER` names another server | unset it, or log in to that server |
| exit 2, "needs TELFLO_ORG" | a personal token in `TELFLO_TOKEN` | set `TELFLO_ORG` to an id from `telflo org list` |
| exit 4 on validate or push | the collector refused the YAML | read the errors (stdout, or the JSON's `errors`) |
| exit 1, "Couldn't validate (not a verdict…)" | the validator is unavailable: nothing was checked | try again later |
| exit 4 on test | a rule failed, or the run failed | read `results` and `errorMessage` in `--json` |
| exit 1, "Rate limited: try again in N s." | the server's limit, after three retries | wait, then run it again |
| exit 1 on `fleet install`, "Assign a published version to this group first" | the group serves no version yet (a new fleet) | `telflo deploy --fleet <fleet-id> --config <id>` first |
| exit 1 on `fleet install`, "several groups" | a Kubernetes fleet with more than one group | pass `--group <id>` (`telflo fleet groups <fleet-id>`) |
