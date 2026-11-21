# telflo

The command-line interface for Telflo: validate, test, push and deploy
OpenTelemetry Collector configurations from your terminal, your CI jobs,
or an AI coding agent. It talks to a Telflo server's public API
(`<server>/api/public/v1`).

## Requirements

- Node.js 22 or newer.
- A Telflo server, and an account on it.

## Install

This version (0.3.0) isn't on npm yet: it is installed from its package
file (`telflo-cli-0.3.0.tgz`, made with `npm pack`). Install it into a
folder of its own, so it can't clash with another `telflo` on your PATH:

```bash
npm install -g --prefix ~/.local/telflo-cli ./telflo-cli-0.3.0.tgz
export PATH="$HOME/.local/telflo-cli/bin:$PATH"   # in your shell's profile, to keep it
telflo -V                                          # 0.3.0
```

`telflo -V` (or `--cli-version`) prints the CLI's version. Remove it with
`rm -rf ~/.local/telflo-cli`.

## Log in

```bash
telflo login --server https://telflo.example.com
```

There is no default server: name yours with `--server` (or
`TELFLO_SERVER`). Without either, `telflo login` at a terminal asks for
its URL; later commands use the server of the stored login.

The CLI opens your browser on Telflo's `/cli-auth` page (and prints the
address, in case it doesn't open). Signed in, you choose the access (Write,
the default, or Read) and how long the login lasts (1, 7, 30 or 90 days; 30
by default), then **Approve**. The page makes a personal token named
`CLI — <your machine's name> · <date and time>`, revokes the token an
earlier `telflo login` on this machine made, and hands the new one to the
CLI over `127.0.0.1`. Your browser may ask to allow access to this device:
allow it. If the browser can't reach the CLI, the page shows the token once
with a Copy button: paste it into the waiting terminal (an empty Enter
there is ignored, so the login keeps waiting for the browser).

The CLI then checks the token and picks the organization: the only one
it can act in, or, when there are several, the one you type the number of
at a terminal (without a terminal, pass `--org`). Then it says:

```
Logged in to https://telflo.example.com as CLI — laptop · 2026-10-26 14:03:51 (Acme).
```

Check that the token and organization are the ones you expect: they name
who the CLI acts as. Other ways to log in:

```bash
telflo login --no-browser                 # paste a token at a hidden prompt (make one on the Account page)
telflo login --org <organization-id>      # choose the organization (telflo org list shows the ids)
telflo login                              # at a terminal: asks for the server's URL (else TELFLO_SERVER, or the stored login's)
telflo login --server <url> --org <id> < token.txt # a token from standard input, for scripts
```

A token is never typed on the command line: there is no `--token` flag. A
service account's token (Settings › Service Accounts, for organization
admins) works too, pasted or from standard input: it acts in its own
organization, so it takes no `--org`.

The browser flow's **Approve** replaces that machine's previous CLI token,
found by the machine's name (a token pasted or read from standard input
revokes nothing). Two machines with the same name (or with no usable name:
both `unknown-host`) replace each other's: the other one then needs
`telflo login` again.

`telflo login` warns when `TELFLO_TOKEN` is set in the shell: that token
still takes the place of the stored login until it's unset.

### Organizations

A personal token can act in every organization you belong to; the CLI
uses one at a time:

```bash
telflo org list            # the organizations, * the current one
telflo org use <id>        # switch, without logging in again
telflo whoami              # the server, the token's name and access, the organization
```

### CI and scripts

Set the token in the environment instead of logging in:

```bash
export TELFLO_TOKEN=...                     # from your CI's secret store; never echo it
export TELFLO_SERVER=https://telflo.example.com   # required: there is no default server
export TELFLO_ORG=<organization-id>         # a personal token only
```

`TELFLO_TOKEN` takes the place of the stored login. It goes only to
`TELFLO_SERVER`, never to a stored login's server; without
`TELFLO_SERVER` every command stops with a usage error (exit 2). A
service account's token acts in its own organization (`TELFLO_ORG` is
refused with it); a personal one needs `TELFLO_ORG`. Give read tokens to
jobs that only validate and test, write tokens to those that push and
deploy.

### Log out

```bash
telflo logout
```

removes the stored login. The token still works until it expires or is
revoked: revoke a personal token on your Account page, a service account's
under Settings › Service Accounts.

## Quick start

```bash
telflo config list                               # find a configuration's id
telflo config pull <id> -o config.yaml           # its latest YAML (and its collector pin)
# ... edit config.yaml ...
telflo ottl lint config.yaml                     # every OTTL expression parses
telflo validate config.yaml --config <id>        # a real collector, the one that configuration is pinned to
telflo config push <id> -f config.yaml --publish
telflo test --spec test.yaml --config <id>       # run a sample through it and check the output
telflo deploy --fleet <fleet-id> --config <id>   # roll the published version out
```

Each configuration version is pinned to a collector distribution and
version. `--collector-version` and `--distribution` always win. Otherwise
`config push` validates on the pin; `validate file --config <id>` and
`test -f file --config <id>` run a local file on that configuration's pin
(for `test`, over the spec's `collector_version` and `distribution`);
`test --config <id>` alone runs the stored version on the spec's fields
when it has them, else on the pin. Without `--config`, a local file runs on
the spec's fields (`test`), else the server's default. The full rules are
in `skills/telflo-cli/references/testing.md`.

`config push` updates the latest version in place while it's a draft, and
adds a new version when the latest is published (published versions never
change). The text is validated first: an invalid one saves nothing.

## Commands

| Command | What it does |
|---|---|
| `telflo login` / `whoami` / `logout` | log in, show who the CLI acts as, remove the stored login |
| `telflo org list` / `org use <id>` | list and switch a personal token's organization |
| `telflo validate <file>` | validate collector YAML with a real collector (without a login too, where the server allows it) |
| `telflo ottl lint [<file>]` | parse-check every OTTL expression in a configuration, or expressions with `--context` and `--expr` |
| `telflo config list` / `get <id>` / `pull <id>` | browse configurations and their versions, download one's YAML |
| `telflo config create --name <n> -f <file>` | create a configuration from a YAML file |
| `telflo config push <id> -f <file> [--publish] [--label <text>]` | save YAML as the latest draft or the next version |
| `telflo config publish <id> --version <n>` | publish a version |
| `telflo config rules <id> [--version <n>]` | show the validation rules saved on a version |
| `telflo test --spec <spec> (-f <file> \| --config <id>)` | run a pipeline test in Telflo's sandbox |
| `telflo fleet list` / `create` / `groups <id>` | list and create fleets, list a fleet's groups |
| `telflo fleet install <id> --platform docker\|linux\|kubernetes` | print the command that installs a collector into a fleet |
| `telflo deploy --fleet <id> --config <id>` | send a published version to a fleet's group |
| `telflo flows list` / `get <slug>` / `pull <slug>` | browse Telflo's prebuilt configurations and take their YAML |
| `telflo skills install [--global]` | install the CLI's skill for AI coding agents |

`telflo <command> --help` lists every flag. Every command takes `--json`
(one JSON document on stdout, JSON lines on stderr: "Exit codes and
output", below). `--version <n>` on
`config pull`, `config publish`, `config rules`, `deploy` and `test` is a
version's *number*; the CLI's own version is `-V`.

### Validating

```bash
telflo validate config.yaml                       # the server's default collector
telflo validate config.yaml --config <id>         # the collector that configuration is pinned to
telflo validate - --collector-version 0.147.0 < config.yaml
```

Logged in, the organization's variables (`${org:NAME}`) are filled in
first. Without a login, `telflo validate` works anonymously only on a
server that turns that on (it is off by default; the CLI then says to log
in, exit 3): no variables, and a few validations a minute. Set
`TELFLO_SERVER` to name the server: there is no default.

### Linting OTTL

OTTL is the expression language of `transform`, `filter`, `routing` and
`tail_sampling`. `telflo ottl lint` parses every expression with the real
grammar and names the YAML location of each problem; it also catches a
single-escaped regex (`"\d"`) that parses but never matches.

```bash
telflo ottl lint config.yaml
telflo ottl lint --context log --expr 'severity_number >= 17'
telflo ottl lint rules.txt --context span --kind statement   # one expression a line
```

### Pipeline tests

A test spec is a small YAML file: the pipeline to exercise, a sample to
send through it, and OTTL rules about what comes out.

```yaml
signal: logs
pipeline: logs/in
sample: ./sample.json
rules:
  - name: card numbers are redacted
    context: log
    quantifier: none
    condition: IsMatch(String(body), "[0-9]{4}[ -][0-9]{4}[ -][0-9]{4}[ -][0-9]{4}")
```

```bash
telflo test --spec test.yaml --config <id>               # the latest version, on its pin
telflo test --spec test.yaml -f local.yaml --config <id> # a local file, on that configuration's pin
telflo test --spec test.yaml --config <id> --save        # save the rules to the version's Validation tab, then run them
telflo test --spec test.yaml --config <id> --saved       # run the rules already saved there
```

The spec's rules are checked before anything is sent. Exit code 4 means a
rule failed (or the run did). The full format ships with the CLI in
`skills/telflo-cli/references/testing.md`.

### Installing collectors

A fleet is where collectors connect; each collector joins one of its
groups, and a group serves a published configuration version. A new fleet
has its Default group, which serves nothing yet; the first `deploy` puts
the configuration's published version on it:

```bash
telflo fleet create --label prod --type server
telflo deploy --fleet <fleet-id> --config <id>       # the Default group now serves the published version
```

The install command holds the fleet's credentials, so make the file yours
alone first (the redirect keeps its 0600 mode):

```bash
install -m 600 /dev/null install.sh
```

```bash
telflo fleet install <fleet-id> --platform docker --display-name web-1 > install.sh
```

`deploy` updates the fleet's one group serving that configuration. When
none does, it uses the Default group if that serves no version yet;
otherwise pass `--name <name>` to create a group, or `--group <id>` (`telflo
fleet groups <fleet-id>` lists them) to choose one. An install joins a
group that serves a version.

The command goes to stdout and notes to stderr, so `> install.sh` captures
exactly what to run. **It holds the fleet's credentials**: write it only
into a file made with mode 0600 first (as above), keep it like a
password, run it only on the machine or cluster the collector belongs on,
and don't paste it anywhere else. Docker and Linux installs need a `server`
fleet (they join its Default group unless `--group` names another). A
Linux install's command holds a link that works for 24 hours. Give values
the configuration reads with `--env NAME=value`.

Kubernetes (`--platform kubernetes`, a Helm install) needs a
`kubernetes-supervisor` fleet. A new one has its Default group, the Agent
(role `node`), so `fleet create`, `deploy` and `fleet install` work as
above. A group you add takes its role from its name: `cluster` for a group
named `cluster`, `gateway` for any other name (`telflo deploy … --name
<name>`; `--role`, if given, must be that role, and `node` never is: a
`--role cluster` or `gateway` asks for a new group, so it needs `--name`,
and on a group that exists `--role` does nothing). Once
the fleet has more than one group, `fleet install --platform kubernetes`
needs `--group <id>`.

### Starting from a flow

```bash
telflo flows list
telflo flows get <slug>                          # its description and YAML
telflo flows pull <slug> -o config.yaml
telflo config create --name "My pipeline" -f config.yaml
```

## AI coding agents

The CLI ships a skill that teaches agents such as Claude Code to use it:
the edit, validate, push, test and deploy loop, writing test specs, and
reading the results.

```bash
telflo skills install            # into ./.claude/skills/telflo-cli for this project
telflo skills install --global   # into ~/.claude/skills/telflo-cli for every project
```

It replaces only its own folder there. Log in yourself first (`telflo
login`), or give the agent's environment a token through `TELFLO_TOKEN`.

## Exit codes and output

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | an API, network or run error (a validator or linter that couldn't check counts here: nothing was checked) |
| 2 | a usage error (a flag, an id, a test spec; for `validate` and `test`, an unknown distribution, or an unknown or retired collector version) |
| 3 | not logged in, the token refused or expired (run `telflo login`), or not allowed (a read-only token on a write) |
| 4 | a check found a problem: invalid YAML, an OTTL lint failure, a failed test |

With `--json`, stdout is one JSON document, and stderr is one JSON object
a line: `{"note": "…"}` for each note (a warning, a retry's wait), then
`{"error": {"code", "message", "status"}}` when the command fails (a
usage error such as a missing required option is `usage_error`, exit 2).
Only an interactive `telflo login`'s prompts and browser lines at a
terminal stay plain text. The CLI's messages are fixed
words: it never prints a reply's body, a request, a header or a token.

A busy server's "rate limited" reply is retried after the wait it names (at
most three times, each wait at most 60 s, a line on stderr each time). The
CLI waits at most 30 s for a reply (120 s for a test run's), and never
follows a redirect.

## Servers and security

- There is no default server: `--server` (on `telflo login`),
  `TELFLO_SERVER` or the stored login names it. With none, `telflo login`
  at a terminal asks for it; anything else is a usage error (exit 2).
- The server is an origin (`https://host[:port]`, no path). It must use
  `https://`; plain `http://` is allowed only for this machine
  (`localhost`, `127.x.x.x`, `[::1]`).
- A token goes only to the server it was entered for. With a stored login,
  `TELFLO_SERVER` naming another server is refused: log in to that one.
- The browser login's listener answers only on `127.0.0.1`, only the
  server's own page, for at most five minutes. The one-time value that ties
  the page to the CLI is in the address the CLI opens, which is on the
  browser opener's command line: another user or program on the same
  machine could read it while the login waits, and hand the CLI a token of
  its own. So check that the "Logged in … as …" line names your token and
  organization.

## Credentials

The login is stored in `credentials.json`:

1. `$TELFLO_CLI_CONFIG_DIR/credentials.json` when that's set;
2. else `$XDG_CONFIG_HOME/telflo/credentials.json`;
3. else `~/.config/telflo/credentials.json`.

The file holds the server, the token, its name and kind, and the
organization. It's written with mode 0600 in a folder of mode 0700; a file
others can read, or a folder others can write, is refused (with the `chmod`
to run). `telflo logout` removes it.

## Support

Questions and bugs go to the project's
[GitHub issues](https://github.com/telflo/telflo/issues).

## License

The Apache License 2.0, as the rest of the repository: its `LICENSE` and
`NOTICE` files. The CLI is provided "as is", without warranty of any
kind; sections 7 and 8 of the license say so in full.
