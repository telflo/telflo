#!/usr/bin/env bash
# The archive smoke: the README's Quick start, run as written on the
# release's Compose archive, then the install checked from the outside.
#
#   scripts/smoke-compose-install.sh --archive <telflo-compose-<version>.tar.gz> --sums <SHA256SUMS>
#       --work <dir> [--project <name>] [--http-port <p>] [--agent-port <p>] [--mailpit-port <p>]
#
# It reads the Quick start's commands from README.md between its markers
# (scripts/release/quick-start.sh, as scripts/release/check-readme-quick-
# start.sh does) and runs every one of them in order, in one shell, in a
# fresh folder of the work folder, with only these texts replaced (each
# must be in the commands exactly once):
#   https://github.com/telflo/telflo/releases/download/v<version>
#                         file://<work>/release (a copy of --archive and
#                         --sums; curl reads it as it would the web)
#   you@example.com       the run's own address
#   "My team"             the run's own organization
#   http://localhost:8080 and http://localhost:51234
#                         the same with --http-port and --agent-port
# and TELFLO_HTTP_PORT, TELFLO_AGENT_PORT and TELFLO_MAILPIT_PORT exported
# as those ports and --mailpit-port (the shell's environment beats .env in
# Compose), COMPOSE_PROJECT_NAME as --project (default smoke-compose-install;
# never a project that isn't a throwaway), every other TELFLO_*,
# OPAMP_*, AWS_* and COMPOSE_* variable of the caller's unset, so .env alone
# decides the rest. The commands run under umask 022, a person's usual one.
# `docker compose ps` is run again until every service is up, as the README
# says. Each command's output goes to a 0600 file of the work folder
# (outputs/, or secrets/ for the bootstrap's, which prints the set-password
# link), never to this script's output.
#
# Between the bootstrap and `docker compose down` (the README's steps 7-9,
# which a person does in a browser) it works over HTTP, through the gateway
# on 127.0.0.1:<http-port> and Mailpit's API on 127.0.0.1:<mailpit-port>:
# the bootstrap's link's token sets the password (POST
# /api/v1/auth/password-resets) and the account signs in; a teammate is
# invited, the invitation read from Mailpit, and the invitee's account made
# from its link (POST /api/v1/invitation-registrations). Then its own
# checks: every service healthy (one-shots exited 0, Mailpit running); only
# the gateway's and the agent's ports published, on 127.0.0.1, and
# Mailpit's on 127.0.0.1; .env 0600, secrets/ 0700 with its files 0644; no
# development secret in .env or secrets/ (by sha256,
# deploy/compose/setup.sh's list, which check-compose-install.sh holds
# complete); the open-source defaults in force (registration refused 403
# registration_not_open, /playground 404); a configuration created,
# validated (valid, and invalid naming exporters::nosuchexporter) and run in
# the tester; a fleet created and a collector enrolled from its Default
# group's install facts, run on the project's network (the facts' endpoint
# names the published agent port on localhost, which a container doesn't
# reach: its origin becomes http://opamp-server:51234, the rest of
# the facts as they are); every secret of the run searched for in every
# file of the work folder outside secrets/ and the install's .env and
# secrets/ (its outputs, this script's output, every service's and the
# collector's logs), by boolean. Then the README's last commands (`docker
# compose down -v`, the folder removed), and nothing of the project left
# (containers, volumes, networks by its label; the collector's).
#
# What it needs: Docker with Compose, curl, jq, tar, gzip, openssl, and
# shasum or sha256sum. Every image compose.yaml names (the five Telflo
# images ghcr.io/telflo/telflo/<name>:<version>, Postgres, nginx, Mailpit
# and the opamp-server at their pins) and the collector image
# ghcr.io/telflo/telflo/collector:<the catalogue's default version> must
# already be in the local engine: it never pulls one, it refuses.
#
# The refusals (exit 2, before anything starts): usage; the project's name
# (one that is never a throwaway, or one with containers, volumes or
# networks already); the ports (a developer's own stack's and dev servers',
# in use, or the same twice); the work folder (relative, not empty, a path with
# characters a URL or a group's mount can't hold, inside this tree); the
# archive's name or version; README.md's Quick start (markers, a text to
# replace not there exactly once, no bootstrap or `docker compose down`
# command, another version than the archive's); a missing image.
#
# Every docker call runs with DOCKER_CONFIG the work folder's (holding
# {"auths":{"telflo-smoke.invalid":{}}}, no login) and refusing
# docker-credential-* stand-ins first on PATH; a call to one fails the run.
# Secrets (the generated ones, the passwords, the link's and the
# invitation's tokens, the session cookies, the fleet's bearers) stay in
# files of <work>/secrets (0600) and reach commands through files and
# standard input, never argv; they are never printed, and secrets/ and the
# run's folder are removed on every exit.
#
# Exit 0 every step passed; 1 a step failed (named, with the README
# command's index and line, never its output; the cleanup still runs); 2
# usage or refused. bash 3.2 compatible.
set -euo pipefail
set +x

PROGRAM=smoke-compose-install
DEFAULT_PROJECT=smoke-compose-install
RELEASE_REGISTRY=ghcr.io/telflo/telflo
PLATFORM_IMAGES="api web otelcol-validator otelcol-testing ottl-evaluator"
COLLECTOR_REPOSITORY=ghcr.io/telflo/telflo/collector
ADDRESS_PREFIX=https://github.com/telflo/telflo/releases/download/v
EXAMPLE_EMAIL=you@example.com
EXAMPLE_ORGANIZATION='"My team"'
EXAMPLE_PUBLIC_URL=http://localhost:8080
EXAMPLE_AGENT_URL=http://localhost:51234
HEALTH_POLLS=120
HEALTH_INTERVAL=5

usage() {
  echo "usage: scripts/smoke-compose-install.sh --archive <telflo-compose-<version>.tar.gz> --sums <SHA256SUMS>" >&2
  echo "           --work <dir> [--project <name>] [--http-port <p>] [--agent-port <p>] [--mailpit-port <p>]" >&2
}
refuse() { echo "$PROGRAM: refused: $*" >&2; exit 2; }
refuse_usage() { echo "$PROGRAM: $*" >&2; usage; exit 2; }

# ---- The arguments.
ARCHIVE_ARG="" SUMS_ARG="" WORK="" PROJECT="" HTTP_PORT="" AGENT_PORT="" MAILPIT_PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --archive | --sums | --work | --project | --http-port | --agent-port | --mailpit-port)
      [ $# -ge 2 ] && [ -n "$2" ] || refuse_usage "$1 needs a value"
      case "$2" in -*) refuse_usage "$1 needs a value, not an option" ;; esac
      case "$1" in
        --archive) ARCHIVE_ARG=$2 ;;
        --sums) SUMS_ARG=$2 ;;
        --work) WORK=$2 ;;
        --project) PROJECT=$2 ;;
        --http-port) HTTP_PORT=$2 ;;
        --agent-port) AGENT_PORT=$2 ;;
        --mailpit-port) MAILPIT_PORT=$2 ;;
      esac
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    *) refuse_usage "unknown argument ${1%%=*}" ;;
  esac
done
[ -n "$ARCHIVE_ARG" ] || refuse_usage "--archive is required"
[ -n "$SUMS_ARG" ] || refuse_usage "--sums is required"
[ -n "$WORK" ] || refuse_usage "--work is required"
PROJECT=${PROJECT:-$DEFAULT_PROJECT}
HTTP_PORT=${HTTP_PORT:-58280}
AGENT_PORT=${AGENT_PORT:-58281}
MAILPIT_PORT=${MAILPIT_PORT:-58282}

# The project: never the Compose install's, the development stack's or a developer's own running stack.
case "$PROJECT" in
  telflo | telflo-dev | telflo-platform)
    refuse "--project $PROJECT is never a throwaway project (the Compose install's, the development stack's or the owner's running stack)" ;;
esac
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ ]] || refuse "--project must be lower-case letters, digits, '_' and '-' (at most 41)"
for port in "$HTTP_PORT" "$AGENT_PORT" "$MAILPIT_PORT"; do
  [[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] && [ "$port" -le 65535 ] || refuse "a port must be a number from 1000 to 65535"
  case "$port" in
    8080 | 8025 | 51234 | 51235 | 50080 | 58025 | 51025 | 53000 | 55432)
      refuse "port $port is a README default, or one the owner's stack or dev servers use: name another" ;;
  esac
done
[ "$HTTP_PORT" != "$AGENT_PORT" ] && [ "$HTTP_PORT" != "$MAILPIT_PORT" ] && [ "$AGENT_PORT" != "$MAILPIT_PORT" ] ||
  refuse "--http-port, --agent-port and --mailpit-port must differ"

for tool in docker curl jq tar gzip openssl awk sed grep od; do
  command -v "$tool" >/dev/null 2>&1 || refuse "$tool isn't on PATH"
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || refuse "neither sha256sum nor shasum is on PATH"

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
README=$REPO/README.md
SETUP_SOURCE=$REPO/deploy/compose/setup.sh
CATALOG=$REPO/catalog/distributions/otelcol-contrib.json
for path in "$REPO/scripts/release/version.sh" "$REPO/scripts/release/quick-start.sh" "$README" "$SETUP_SOURCE" "$CATALOG"; do
  [ -f "$path" ] || refuse "no $path"
done
# shellcheck source=scripts/release/version.sh
. "$REPO/scripts/release/version.sh"
# shellcheck source=scripts/release/quick-start.sh
. "$REPO/scripts/release/quick-start.sh"

# ---- The work folder: absolute, new or empty, outside this tree; its path goes into a file:// URL and a group's
# mount, so letters, digits, '.', '_', '-' and '/' only.
case "$WORK" in /*) ;; *) refuse "--work must be an absolute path" ;; esac
[[ "$WORK" =~ ^/[A-Za-z0-9._/-]+$ ]] || refuse "--work must be letters, digits, '.', '_', '-' and '/' only"
if [ -e "$WORK" ] || [ -L "$WORK" ]; then
  [ -d "$WORK" ] && [ ! -L "$WORK" ] || refuse "--work $WORK isn't a directory"
  [ -z "$(ls -A "$WORK")" ] || refuse "--work $WORK isn't empty: name a new or an empty folder"
else
  mkdir -p "$WORK" || refuse "couldn't make --work $WORK"
fi
WORK=$(cd "$WORK" && pwd -P)
[[ "$WORK" =~ ^/[A-Za-z0-9._/-]+$ ]] || refuse "--work resolves to a path with characters this script doesn't handle"
case "$WORK/" in "$REPO/"*) refuse "--work $WORK is inside this tree: the generated secrets never go in it" ;; esac
chmod 0700 "$WORK"

# ---- The archive: telflo-compose-<version>.tar.gz, and the checksums file.
for path in "$ARCHIVE_ARG" "$SUMS_ARG"; do
  [ -f "$path" ] && [ ! -L "$path" ] || refuse "$path isn't a file"
done
ARCHIVE_NAME=$(basename "$ARCHIVE_ARG")
VERSION=${ARCHIVE_NAME#telflo-compose-}
VERSION=${VERSION%.tar.gz}
[ "$ARCHIVE_NAME" = "telflo-compose-$VERSION.tar.gz" ] && telflo_version_ok "$VERSION" ||
  refuse "--archive must be named telflo-compose-<version>.tar.gz with a release version (x.y.z)"
COMPOSE_TEXT=$(tar -xzOf "$ARCHIVE_ARG" "telflo-compose-$VERSION/compose.yaml" 2>/dev/null) ||
  refuse "$ARCHIVE_NAME holds no telflo-compose-$VERSION/compose.yaml"
IMAGES=$(printf '%s\n' "$COMPOSE_TEXT" | awk '/^[[:space:]]+image:[[:space:]]*[^[:space:]]+[[:space:]]*$/ { print $2 }' | LC_ALL=C sort -u)
for name in $PLATFORM_IMAGES; do
  printf '%s\n' "$IMAGES" | grep -qxF "$RELEASE_REGISTRY/$name:$VERSION" ||
    refuse "the archive's compose.yaml doesn't name $RELEASE_REGISTRY/$name:$VERSION"
done
COLLECTOR_VERSION=$(jq -r '[.versions[] | select(.default == true) | .version] | if length == 1 then .[0] else empty end' "$CATALOG" 2>/dev/null || true)
[[ "$COLLECTOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "the catalogue names no one default collector version"
COLLECTOR_IMAGE="$COLLECTOR_REPOSITORY:$COLLECTOR_VERSION"

# ---- The README's Quick start, as quick-start.sh reads it: "<line>|<commented>|<command>" a command.
PARSED=$(telflo_quick_start_parse "$README" 2>/dev/null) && [ -n "$PARSED" ] ||
  refuse "README.md's Quick start can't be read: a marker missing or twice, or a block left open (scripts/release/check-readme-quick-start.sh names it)"
RUN_ID="$(date +%s)-$$"
ADMIN_EMAIL="smoke-admin-$RUN_ID@example.com"
INVITEE_EMAIL="smoke-invitee-$RUN_ID@example.com"
ORGANIZATION_NAME="Compose smoke $RUN_ID"
RELEASE_DIR=$WORK/release
# count_of <text> <haystack>: how many times <text> occurs in <haystack>.
count_of() {
  local text=$1 rest=$2 n=0
  while :; do
    case "$rest" in *"$text"*) n=$((n + 1)); rest=${rest#*"$text"} ;; *) break ;; esac
  done
  echo "$n"
}
# replace_all <text> <from> <to>: <text> with every <from> replaced by <to>, as fixed strings.
replace_all() {
  local rest=$1 from=$2 to=$3 out=""
  while :; do
    case "$rest" in
      *"$from"*) out="$out${rest%%"$from"*}$to"; rest=${rest#*"$from"} ;;
      *) break ;;
    esac
  done
  printf '%s' "$out$rest"
}
ALL_COMMANDS=$(printf '%s\n' "$PARSED" | sed 's/^[0-9]*|[01]|//')
[ "$(count_of "$ADDRESS_PREFIX" "$ALL_COMMANDS")" = 1 ] ||
  refuse "the Quick start's commands don't hold the download address ${ADDRESS_PREFIX}<version> exactly once"
readme_version=${ALL_COMMANDS#*"$ADDRESS_PREFIX"}
readme_version=${readme_version%%[!0-9.]*}
[ "$readme_version" = "$VERSION" ] ||
  refuse "the Quick start's download address isn't v$VERSION's, the archive's (README.md and the archive must be the same release's)"
for text in "$EXAMPLE_EMAIL" "$EXAMPLE_ORGANIZATION" "$EXAMPLE_PUBLIC_URL" "$EXAMPLE_AGENT_URL"; do
  [ "$(count_of "$text" "$ALL_COMMANDS")" = 1 ] || refuse "the Quick start's commands don't hold $text exactly once"
done

# The commands, substituted, into arrays (index from 1): the text, its README line.
CMD_COUNT=0
BOOTSTRAP_INDEX=""
DOWN_INDEX=""
CMD_TEXT=("")
CMD_LINE=("")
while IFS= read -r parsed_line; do
  [ -n "$parsed_line" ] || continue
  CMD_COUNT=$((CMD_COUNT + 1))
  line_number=${parsed_line%%|*}
  command=${parsed_line#*|}
  command=${command#*|}
  command=$(replace_all "$command" "$ADDRESS_PREFIX$VERSION" "file://$RELEASE_DIR")
  command=$(replace_all "$command" "$EXAMPLE_EMAIL" "$ADMIN_EMAIL")
  command=$(replace_all "$command" "$EXAMPLE_ORGANIZATION" "\"$ORGANIZATION_NAME\"")
  command=$(replace_all "$command" "$EXAMPLE_PUBLIC_URL" "http://localhost:$HTTP_PORT")
  command=$(replace_all "$command" "$EXAMPLE_AGENT_URL" "http://localhost:$AGENT_PORT")
  CMD_TEXT[CMD_COUNT]=$command
  CMD_LINE[CMD_COUNT]=$line_number
  case "$command" in
    *" telflo-admin bootstrap "*)
      [ -z "$BOOTSTRAP_INDEX" ] || refuse "the Quick start runs telflo-admin bootstrap twice"
      BOOTSTRAP_INDEX=$CMD_COUNT ;;
    "docker compose down"*)
      [ -z "$DOWN_INDEX" ] || refuse "the Quick start runs docker compose down twice"
      DOWN_INDEX=$CMD_COUNT ;;
  esac
done <<EOF
$PARSED
EOF
[ -n "$BOOTSTRAP_INDEX" ] || refuse "the Quick start has no telflo-admin bootstrap command"
[ -n "$DOWN_INDEX" ] || refuse "the Quick start has no docker compose down command"
[ "$BOOTSTRAP_INDEX" -lt "$DOWN_INDEX" ] || refuse "the Quick start's docker compose down comes before its bootstrap"

# ---- The run's folders, Docker's config and the credential helpers' stand-ins (before any docker call).
umask 077
SECRETS_DIR=$WORK/secrets
OUTPUTS=$WORK/outputs
LOGS=$WORK/logs
STATE=$WORK/state
RUN_DIR=$WORK/run
mkdir -p "$SECRETS_DIR/outputs" "$OUTPUTS" "$LOGS" "$STATE" "$WORK/docker-config" "$WORK/bin" "$WORK/tmp"
printf '{"auths":{"telflo-smoke.invalid":{}}}\n' >"$WORK/docker-config/config.json"
export DOCKER_CONFIG="$WORK/docker-config"
HELPERS_LOG=$WORK/credential-helpers.log
: >"$HELPERS_LOG"
for helper in docker-credential-osxkeychain docker-credential-desktop docker-credential-ecr-login; do
  printf '#!/bin/sh\n# A refusing stand-in (smoke-compose-install.sh): logs its name and first argument, never reads its input.\nprintf "%%s %%s\\n" "%s" "$1" >>"%s"\nexit 1\n' \
    "$helper" "$HELPERS_LOG" >"$WORK/bin/$helper"
  chmod 0700 "$WORK/bin/$helper"
done
export PATH="$WORK/bin:$PATH"
export TMPDIR="$WORK/tmp"

# ---- The engine: it answers, holds every image, and nothing of the project exists yet.
docker version --format '{{.Server.Version}}' >/dev/null 2>"$LOGS/preflight-docker.err" ||
  refuse "the Docker engine doesn't answer (docker version)"
docker compose version >/dev/null 2>>"$LOGS/preflight-docker.err" || refuse "docker compose doesn't answer (docker compose version)"
for image in $IMAGES "$COLLECTOR_IMAGE"; do
  docker image inspect --format '{{.Id}}' "$image" >/dev/null 2>&1 ||
    refuse "the image $image isn't in the local engine: this smoke never pulls one (the release's images: scripts/release/load-images.sh; the rest: pull or load them first)"
done
COLLECTOR_CONTAINER="$PROJECT-collector"
COLLECTOR_VOLUME="$PROJECT-collector-opamp"
project_leftovers() {
  {
    docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | sed 's/^/container /'
    docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | sed 's/^/volume /'
    docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" | sed 's/^/network /'
    docker ps -aq --filter "name=^/$COLLECTOR_CONTAINER\$" | sed 's/^/container /'
    docker volume ls -q --filter "name=^$COLLECTOR_VOLUME\$" | sed 's/^/volume /'
  } 2>>"$LOGS/docker.err"
}
[ -z "$(project_leftovers)" ] ||
  refuse "the project $PROJECT has containers, volumes or networks already (or $COLLECTOR_CONTAINER / $COLLECTOR_VOLUME exists): name a new one"
for port in "$HTTP_PORT" "$AGENT_PORT" "$MAILPIT_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    refuse "port $port answers on 127.0.0.1 already: name a free one"
  fi
done

# ---- The environment the commands run in: the caller's Telflo, opamp-server, AWS and Compose settings gone, the
# run's own exported (the shell's environment beats .env in Compose).
for name in $(compgen -v); do
  case "$name" in TELFLO_* | OPAMP_* | AWS_* | COMPOSE_*) unset "$name" ;; esac
done
export COMPOSE_PROJECT_NAME="$PROJECT"
export TELFLO_HTTP_PORT="$HTTP_PORT" TELFLO_AGENT_PORT="$AGENT_PORT" TELFLO_MAILPIT_PORT="$MAILPIT_PORT"
GATEWAY_URL="http://localhost:$HTTP_PORT"
MAILPIT_URL="http://127.0.0.1:$MAILPIT_PORT"
AGENT_ENDPOINT="http://localhost:$AGENT_PORT/opamp/api/v1"
NETWORK_ENDPOINT="http://opamp-server:51234/opamp/api/v1"
JAR=$SECRETS_DIR/cookies
INVITEE_JAR=$SECRETS_DIR/invitee-cookies
REPLY_BODY=$SECRETS_DIR/reply-body
REPLY_HEADERS=$SECRETS_DIR/reply-headers
VALUES=$SECRETS_DIR/values
: >"$VALUES"
: >"$SECRETS_DIR/originals"

# The output, also into the work folder's log (searched at the end like every other file). The tee ignores INT, TERM
# and HUP, so a signal to the whole process group doesn't cut the cleanup's lines.
OUTPUT_LOG=$WORK/output.log
exec > >(trap '' INT TERM HUP; exec tee -a "$OUTPUT_LOG") 2>&1

# ---- Steps.
STARTED_AT=$SECONDS
STEP=0
STEP_TITLE=""
STEP_STARTED=$SECONDS
INSTALL=""
project_started=no
collector_started=no
elapsed() { local seconds=$((SECONDS - STARTED_AT)); echo "$((seconds / 60)) min $((seconds % 60)) s"; }
step() {
  STEP=$((STEP + 1))
  STEP_TITLE=$*
  STEP_STARTED=$SECONDS
  echo "... $STEP. $* (at $(elapsed))"
}
pass() { echo "PASS $STEP. $* [$((SECONDS - STEP_STARTED)) s]"; }
fail() {
  echo "FAIL $STEP. ${STEP_TITLE:-preflight}: $* [$((SECONDS - STEP_STARTED)) s]" >&2
  exit 1
}

# ---- Secrets: files of $SECRETS_DIR only. add_value_file <file>: each non-empty line joins the values searched for,
# with its base64 forms at the three alignments a value can sit at inside a longer base64 text, each cut to the
# characters only the value decides, and each also in base64url. Read by bash's read, written by printf (builtins):
# never on a command line, never printed. A value under 16 characters is refused (so short a needle would match
# ordinary text; no secret of the run is that short).
add_value_file() {
  local line shift encoded rest short=0 LC_ALL=C
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    if [ "${#line}" -lt 16 ]; then
      short=1
      continue
    fi
    printf '%s\n' "$line" >>"$VALUES"
    printf '%s\n' "$line" >>"$SECRETS_DIR/originals"
    for shift in 0 1 2; do
      encoded=$({ [ "$shift" -lt 1 ] || printf '\000'; [ "$shift" -lt 2 ] || printf '\000'; printf '%s' "$line"; } | base64 | tr -d '\n')
      case "$shift" in 1) encoded=${encoded:2} ;; 2) encoded=${encoded:3} ;; esac
      while [ "${encoded%=}" != "$encoded" ]; do encoded=${encoded%=}; done
      rest=$(((shift + ${#line}) % 3))
      [ "$rest" = 0 ] || encoded=${encoded%?}
      [ "${#encoded}" -ge 16 ] || continue
      printf '%s\n' "$encoded" >>"$VALUES"
      printf '%s\n' "$encoded" | tr '+/' '-_' >>"$VALUES"
    done
  done <"$1"
  return "$short"
}
remember() { add_value_file "$1" || fail "a secret under 16 characters can't be searched for: refused (not shown)"; }
# add_jar_values <jar>: the session cookies' values (telflo_access, telflo_refresh) join the values searched for.
add_jar_values() {
  [ -f "$1" ] || return 0
  awk -F '\t' 'NF >= 7 && ($6 == "telflo_access" || $6 == "telflo_refresh") && $7 != "" { print $7 }' "$1" >"$SECRETS_DIR/jar-values"
  remember "$SECRETS_DIR/jar-values"
  rm -f "$SECRETS_DIR/jar-values"
}
originals_count() { LC_ALL=C sort -u "$SECRETS_DIR/originals" 2>/dev/null | grep -c . || true; }
holds_value() { [ -s "$VALUES" ] && LC_ALL=C grep -qaFf "$VALUES" "$1"; }

# ---- The platform, through the gateway. platform <method> <url> [<body file>]: the status into $status, the body
# into $REPLY_BODY, the headers into $REPLY_HEADERS (both in secrets/: a reply may carry a bearer or a cookie).
platform() {
  local args=(-q -s --max-time 60 -o "$REPLY_BODY" -D "$REPLY_HEADERS" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$1" -H 'X-Telflo-CSRF: 1')
  if [ $# -ge 3 ]; then args+=(-H 'content-type: application/json' --data-binary "@$3"); fi
  status=$(: >"$REPLY_BODY" && curl "${args[@]}" "$2" || true)
  if [ "$status" = "401" ] && [ "$(reply_json '.error.code // empty')" = "access_token_expired" ]; then
    curl -q -s -o /dev/null --max-time 30 -b "$JAR" -c "$JAR" -X POST -H 'X-Telflo-CSRF: 1' "$GATEWAY_URL/api/v1/auth/refresh" || true
    status=$(: >"$REPLY_BODY" && curl "${args[@]}" "$2" || true)
  fi
}
reply_json() { jq -r "$@" "$REPLY_BODY" 2>/dev/null || true; }
reply_code() { local code; code=$(reply_json '.error.code // empty'); echo "${code:-no error code}"; }
no_store() { grep -qiE '^cache-control:[[:space:]]*no-store' "$REPLY_HEADERS"; }
# body <name> <jq program> [jq args...]: a request body (no secret) written by jq to the state folder; its path.
body() {
  local name=$1 program=$2
  shift 2
  jq -n "$@" "$program" >"$STATE/$name.json"
  echo "$STATE/$name.json"
}
uuid4() {
  local hex
  hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s-%s-4%s-%x%s-%s\n' "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" $(((0x${hex:16:2} & 0x3f) | 0x80)) "${hex:18:2}" "${hex:20:12}"
}
http_status() { curl -q -s -o /dev/null --max-time 30 -w '%{http_code}' "$@" || true; }

# ---- Compose, in the install's folder (the commands' own project: COMPOSE_PROJECT_NAME and the folder's .env).
in_install() { (cd "$INSTALL" && "$@"); }
# project_containers: "<service> <status> <health|none> <exit code> <restart policy>" a container of the project.
project_containers() {
  local ids
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>>"$LOGS/docker.err") || return 1
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.ExitCode}} {{.HostConfig.RestartPolicy.Name}}' \
    $ids 2>>"$LOGS/docker.err"
}
# service_problems: a line per service of `docker compose config --services` not up yet: a healthcheck's service
# healthy, a one-shot (restart "no") exited 0, any other running. Nothing when all are.
service_problems() {
  local services containers service line
  services=$(in_install docker compose config --services 2>>"$LOGS/docker.err") || { echo "docker compose config --services failed"; return 0; }
  containers=$(project_containers) || { echo "docker inspect failed"; return 0; }
  for service in $services; do
    line=$(printf '%s\n' "$containers" | awk -v s="$service" '$1 == s' | head -n 2)
    if [ -z "$line" ]; then echo "$service: no container"; continue; fi
    [ "$(printf '%s\n' "$line" | grep -c .)" = 1 ] || { echo "$service: more than one container"; continue; }
    # shellcheck disable=SC2086
    set -- $line
    if [ "$3" != none ]; then
      [ "$2" = running ] && [ "$3" = healthy ] || echo "$service: $2, $3"
    elif [ "$5" = no ]; then
      [ "$2" = exited ] && [ "$4" = 0 ] || echo "$service: $2 (exit $4)"
    else
      [ "$2" = running ] || echo "$service: $2"
    fi
  done
}

# ---- The cleanup, on every exit: the collector, the project (by Compose, else by its label), the run's folder and
# secrets/ removed; anything of the project left fails the run.
remove_by_label() {
  local ids
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>>"$LOGS/docker.err" || true)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker rm -f $ids >>"$LOGS/cleanup.log" 2>&1 || true
  ids=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>>"$LOGS/docker.err" || true)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker volume rm $ids >>"$LOGS/cleanup.log" 2>&1 || true
  ids=$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>>"$LOGS/docker.err" || true)
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker network rm $ids >>"$LOGS/cleanup.log" 2>&1 || true
}
remove_collector() {
  docker rm -f "$COLLECTOR_CONTAINER" >>"$LOGS/cleanup.log" 2>&1 || true
  docker volume rm "$COLLECTOR_VOLUME" >>"$LOGS/cleanup.log" 2>&1 || true
}
on_exit() {
  local code=$? left
  trap - EXIT
  set +e
  cd "$WORK" 2>/dev/null || cd /
  if [ "$collector_started" = yes ]; then remove_collector; fi
  if [ "$project_started" = yes ] && [ -n "$(project_leftovers)" ]; then
    echo "     cleanup: the project $PROJECT is still there: docker compose down -v, then by its label"
    if [ -n "$INSTALL" ] && [ -f "$INSTALL/.env" ]; then
      in_install docker compose down -v --remove-orphans >>"$LOGS/cleanup.log" 2>&1
    fi
    remove_by_label
  fi
  if [ "$project_started" = yes ]; then
    left=$(project_leftovers)
    if [ -n "$left" ]; then
      echo "FAIL cleanup: left of the project $PROJECT: $(printf '%s\n' "$left" | tr '\n' ';')" >&2
      code=1
    fi
  fi
  # The run's folder holds the install's .env and secrets/ (when the README's last command didn't remove it), and
  # secrets/ the run's: both go.
  rm -rf "$RUN_DIR" "$SECRETS_DIR" 2>/dev/null
  if [ -e "$RUN_DIR" ] || [ -e "$SECRETS_DIR" ]; then
    echo "FAIL cleanup: couldn't remove $RUN_DIR or $SECRETS_DIR" >&2
    code=1
  fi
  if [ -s "$HELPERS_LOG" ]; then
    echo "FAIL cleanup: a docker credential helper was called ($(sort -u "$HELPERS_LOG" | tr '\n' ';'))" >&2
    code=1
  fi
  if [ "$code" = 0 ]; then
    echo "$PROGRAM: PASS, $STEP steps, in $(elapsed)"
  else
    echo "$PROGRAM: FAIL (exit $code) after $(elapsed): the work folder $WORK keeps the outputs and logs"
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- run_command <index>: the README's command, in this shell (a cd stays), its standard input empty, its output
# into <outputs>/cmd-<index>.out (0600; the bootstrap's into secrets/), under umask 022 with errexit, nounset and
# pipefail off, as a person's shell runs it. Its exit status into $command_status.
command_label() { echo "README command $1 of $CMD_COUNT (line ${CMD_LINE[$1]})"; }
command_output() {
  if [ "$1" = "$BOOTSTRAP_INDEX" ]; then echo "$SECRETS_DIR/outputs/cmd-$1.out"; else echo "$OUTPUTS/cmd-$1.out"; fi
}
run_command() {
  local index=$1 out
  out=$(command_output "$index")
  : >"$out"
  set +euo pipefail
  umask 022
  eval "${CMD_TEXT[$index]}" </dev/null >"$out" 2>&1
  command_status=$?
  umask 077
  set -euo pipefail
}

# =====================================================================================================================
step "the refusals: the project, the ports, the work folder, the archive, README.md's Quick start, the images"
pass "project $PROJECT, ports $HTTP_PORT (gateway), $AGENT_PORT (agent), $MAILPIT_PORT (Mailpit), all free; $ARCHIVE_NAME (v$VERSION); the Quick start's $CMD_COUNT commands, each text to replace once; $(printf '%s\n' "$IMAGES" | grep -c .) images of compose.yaml and $COLLECTOR_IMAGE local"

step "the release folder: $ARCHIVE_NAME and SHA256SUMS copied into $RELEASE_DIR (file://, read by curl as the web)"
mkdir -p "$RELEASE_DIR" "$RUN_DIR"
cp "$ARCHIVE_ARG" "$RELEASE_DIR/$ARCHIVE_NAME" && cp "$SUMS_ARG" "$RELEASE_DIR/SHA256SUMS" || fail "copying the archive and the checksums failed"
chmod 0644 "$RELEASE_DIR/$ARCHIVE_NAME" "$RELEASE_DIR/SHA256SUMS"
pass "the release's two files beside each other"

cd "$RUN_DIR"
index=1
while [ "$index" -le "$CMD_COUNT" ]; do
  # Before `docker compose down`: the browser's steps over HTTP, then the smoke's own checks.
  [ "$index" != "$DOWN_INDEX" ] || break
  step "$(command_label "$index"): ${CMD_TEXT[$index]}"
  # Marked before it runs: a run that ends during the start still cleans the project up.
  case "${CMD_TEXT[$index]}" in
    "docker compose up"*) project_started=yes ;;
  esac
  run_command "$index"
  [ "$command_status" = 0 ] || fail "$(command_label "$index") exited $command_status (its output: $(command_output "$index"), not shown)"
  case "${CMD_TEXT[$index]}" in
    "docker compose ps")
      # The README: "Run it again until every service shows healthy."
      INSTALL=${INSTALL:-$PWD}
      polls=1
      while :; do
        problems=$(service_problems)
        [ -n "$problems" ] || break
        [ "$polls" -lt "$HEALTH_POLLS" ] ||
          fail "after $polls runs of it, $HEALTH_INTERVAL s apart, not every service is up: $(printf '%s\n' "$problems" | tr '\n' ';')"
        sleep "$HEALTH_INTERVAL"
        polls=$((polls + 1))
        run_command "$index"
        [ "$command_status" = 0 ] || fail "$(command_label "$index") exited $command_status on its run $polls (not shown)"
      done
      pass "run $polls times until every service was up" ;;
    "./setup.sh"*)
      INSTALL=$PWD
      [ -f "$INSTALL/compose.yaml" ] && [ -f "$INSTALL/.env" ] && [ -d "$INSTALL/secrets" ] ||
        fail "it didn't write .env and secrets/ beside compose.yaml in $INSTALL"
      # Before anything starts: Compose reads the project's name from COMPOSE_PROJECT_NAME, not compose.yaml's
      # `name: telflo` (only the name line of its output is read).
      project_name=$(in_install docker compose config 2>>"$LOGS/docker.err" | awk '/^name:/ { print $2; exit }' || true)
      [ "$project_name" = "$PROJECT" ] || fail "docker compose config names the project ${project_name:-(none)}, not $PROJECT: nothing started"
      pass "exit 0 in $INSTALL; Compose's project there is $PROJECT" ;;
    *" telflo-admin bootstrap "*)
      out=$(command_output "$index")
      grep -vE 'token=|reset-password' "$out" >"$OUTPUTS/cmd-$index.filtered.out" || true
      [ "$(grep -cE 'token=|reset-password' "$out" || true)" = 1 ] || fail "it printed no set-password link, or more than one (not shown)"
      grep -qxF "Created the account $ADMIN_EMAIL and made it the first product admin." "$OUTPUTS/cmd-$index.filtered.out" &&
        grep -qxF "Created the organization, with the account as its admin." "$OUTPUTS/cmd-$index.filtered.out" &&
        tail -n 1 "$OUTPUTS/cmd-$index.filtered.out" | grep -qE '^Open this link within [0-9]+ minutes to set the password \(it works once\):$' ||
        fail "it didn't print its fixed lines for the account, the organization and the link (its other lines: $OUTPUTS/cmd-$index.filtered.out)"
      # The link: the last line, into a variable only; its token into a file of secrets/.
      link=$(tail -n 1 "$out" | tr -d '\r')
      [[ "$link" =~ ^https?://[^[:space:]#]+/reset-password#token=[A-Za-z0-9_-]+$ ]] || fail "its last line isn't a set-password link (not shown)"
      [[ "$link" == "$GATEWAY_URL/reset-password#token="* ]] || fail "its link isn't the public URL's ($GATEWAY_URL/reset-password, not shown)"
      printf '%s\n' "${link##*token=}" >"$SECRETS_DIR/set-password-token"
      remember "$SECRETS_DIR/set-password-token"
      link=""
      pass "exit 0; the account, its organization and the set-password link printed last (kept in secrets/, never shown)" ;;
    *) pass "exit 0" ;;
  esac
  index=$((index + 1))
done
[ -n "$INSTALL" ] && [ "$project_started" = yes ] ||
  fail "the Quick start's commands before docker compose down didn't run ./setup.sh, docker compose up and docker compose ps"

# =====================================================================================================================
step "every service up (healthy; one-shots exited 0; Mailpit running); only the gateway's ($HTTP_PORT) and the agent's ($AGENT_PORT) ports published, on 127.0.0.1, and Mailpit's ($MAILPIT_PORT) on 127.0.0.1"
problems=$(service_problems)
[ -z "$problems" ] || fail "not every service is up: $(printf '%s\n' "$problems" | tr '\n' ';')"
ids=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")
# shellcheck disable=SC2086
published=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{json .NetworkSettings.Ports}}' $ids |
  while read -r service ports; do
    printf '%s\n' "$ports" | jq -r --arg s "$service" 'to_entries[] | select(.value != null) | .key as $k | .value[] | "\($s) \(.HostIp):\(.HostPort) \($k)"'
  done | LC_ALL=C sort)
expected=$(printf '%s\n' "gateway 127.0.0.1:$HTTP_PORT 80/tcp" "mailpit 127.0.0.1:$MAILPIT_PORT 8025/tcp" \
  "opamp-server 127.0.0.1:$AGENT_PORT 51234/tcp" | LC_ALL=C sort)
[ "$published" = "$expected" ] || fail "the published ports are: $(printf '%s\n' "$published" | tr '\n' ';')"
[ "$(http_status "$GATEWAY_URL/login")" = 200 ] || fail "the gateway's /login doesn't answer 200 on 127.0.0.1:$HTTP_PORT"
[ "$(http_status "http://127.0.0.1:$AGENT_PORT/health")" = 200 ] || fail "the agent endpoint's /health doesn't answer 200 on 127.0.0.1:$AGENT_PORT"
[ "$(http_status "$MAILPIT_URL/api/v1/messages")" = 200 ] || fail "Mailpit's API doesn't answer 200 on 127.0.0.1:$MAILPIT_PORT"
pass "$(in_install docker compose config --services | grep -c .) services up; published: $(printf '%s\n' "$published" | tr '\n' ';')"

# =====================================================================================================================
step ".env 0600, secrets/ 0700 with its files 0644; no development secret in either (by sha256, setup.sh's list)"
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
[ "$(mode_of "$INSTALL/.env")" = 600 ] || fail ".env is mode $(mode_of "$INSTALL/.env"), not 0600"
[ "$(mode_of "$INSTALL/secrets")" = 700 ] || fail "secrets/ is mode $(mode_of "$INSTALL/secrets"), not 0700"
secret_files=$(cd "$INSTALL/secrets" && ls -A)
[ "$(printf '%s\n' "$secret_files" | grep -c .)" = 3 ] || fail "secrets/ holds $(printf '%s\n' "$secret_files" | grep -c .) files, not 3"
for file in $secret_files; do
  [ -f "$INSTALL/secrets/$file" ] && [ ! -L "$INSTALL/secrets/$file" ] && [ "$(mode_of "$INSTALL/secrets/$file")" = 644 ] ||
    fail "secrets/$file isn't a file of mode 0644"
done
DEVELOPMENT_SHA256=$(sed -n '/^DEVELOPMENT_SECRET_SHA256="/,/^"/p' "$SETUP_SOURCE" | grep -E '^[0-9a-f]{64}$' || true)
[ "$(printf '%s\n' "$DEVELOPMENT_SHA256" | grep -c .)" -ge 10 ] || fail "couldn't read setup.sh's development secrets' sha256"
sha256_of_stdin() { openssl dgst -sha256 | awk '{ print $NF }'; }
development_hits=0
checked=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in "" | "#"*) continue ;; esac
  value=${line#*=}
  case "$value" in \'*\') value=${value#\'}; value=${value%\'} ;; esac
  [ -n "$value" ] || continue
  checked=$((checked + 1))
  if printf '%s\n' "$DEVELOPMENT_SHA256" | grep -qxF "$(printf '%s' "$value" | sha256_of_stdin)"; then
    development_hits=$((development_hits + 1))
  fi
done <"$INSTALL/.env"
for file in $secret_files; do
  checked=$((checked + 1))
  if printf '%s\n' "$DEVELOPMENT_SHA256" | grep -qxF "$(sha256_of_stdin <"$INSTALL/secrets/$file")"; then
    development_hits=$((development_hits + 1))
  fi
done
value=""
[ "$development_hits" = 0 ] || fail "$development_hits value(s) of .env or secrets/ are development secrets (not shown)"
# The generated secrets join the values searched for: .env's *PASSWORD, *SECRET and *KEY settings, secrets/'s files.
awk '/^[A-Z0-9_]*(PASSWORD|SECRET|KEY)=/ { v = substr($0, index($0, "=") + 1); if (v != "") print v }' "$INSTALL/.env" >"$SECRETS_DIR/generated"
for file in $secret_files; do
  { cat "$INSTALL/secrets/$file"; printf '\n'; } >>"$SECRETS_DIR/generated"
done
remember "$SECRETS_DIR/generated"
generated_count=$(LC_ALL=C sort -u "$SECRETS_DIR/generated" | grep -c . || true)
rm -f "$SECRETS_DIR/generated"
[ "$generated_count" -ge 13 ] || fail "only $generated_count generated secrets found in .env and secrets/ (13 expected)"
pass "modes as they should be; $checked values checked, none a development secret; $generated_count generated secrets to search for"

# =====================================================================================================================
step "the open-source defaults: registration refused (403 registration_not_open), /playground 404, no email from the bootstrap"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -X POST "$GATEWAY_URL/api/v1/auth/register" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary '{}' || true)
[ "$status" = 403 ] && [ "$(reply_json '.error.code')" = registration_not_open ] ||
  fail "register answered $status ($(reply_code)), not 403 registration_not_open"
[ "$(http_status "$GATEWAY_URL/playground")" = 404 ] || fail "/playground doesn't answer 404"
mail_query=$(jq -rn --arg q "to:\"$ADMIN_EMAIL\"" '$q | @uri')
mails=$(curl -q -s --max-time 30 "$MAILPIT_URL/api/v1/search?query=$mail_query" | jq -r '(.messages // []) | length' 2>/dev/null || true)
[ "$mails" = 0 ] || fail "the bootstrap sent an email to the address, or Mailpit's search answered nothing (${mails:-no answer})"
pass "register 403 registration_not_open; /playground 404; Mailpit holds no email to $ADMIN_EMAIL"

# =====================================================================================================================
step "the README's step 7: the link's token sets the password (POST /api/v1/auth/password-resets), and the account signs in, in its organization"
openssl rand -hex 16 | tr -d '\n' >"$SECRETS_DIR/password"
remember "$SECRETS_DIR/password"
jq -Rs --rawfile p "$SECRETS_DIR/password" '{token: (. | rtrimstr("\n")), password: $p}' <"$SECRETS_DIR/set-password-token" >"$SECRETS_DIR/set-password.json"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -X POST "$GATEWAY_URL/api/v1/auth/password-resets" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$SECRETS_DIR/set-password.json" || true)
[ "$status" = 204 ] || fail "setting the password with the bootstrap's link answered $status ($(reply_code)), not 204"
jq -n --arg e "$ADMIN_EMAIL" --rawfile p "$SECRETS_DIR/password" '{email: $e, password: $p}' >"$SECRETS_DIR/sign-in.json"
status=$(curl -q -s -o "$REPLY_BODY" -D "$REPLY_HEADERS" -w '%{http_code}' --max-time 30 -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/sessions" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$SECRETS_DIR/sign-in.json" || true)
[ "$status" = 200 ] || fail "sign-in answered $status ($(reply_code))"
add_jar_values "$JAR"
platform GET "$GATEWAY_URL/api/v1/auth/me"
[ "$status" = 200 ] || fail "/api/v1/auth/me answered $status ($(reply_code))"
GROUP_ID=$(reply_json '.organization.id')
[ "$(reply_json -c '[.user.email, .organization.name, .organization.type, .organization.role, .isProductAdmin, .termsAcceptanceRequired]')" = \
  "$(jq -cn --arg e "$ADMIN_EMAIL" --arg n "$ORGANIZATION_NAME" '[$e, $n, "group", "admin", true, false]')" ] && [[ "$GROUP_ID" =~ ^[0-9a-f-]{36}$ ]] ||
  fail "/me isn't the bootstrap's product admin in its organization as its admin, asked for no Terms: $(reply_json -c '{organization: (.organization | {type, role}), isProductAdmin, termsAcceptanceRequired}')"
pass "204; signed in as $ADMIN_EMAIL, product admin, admin of \"$ORGANIZATION_NAME\" (where it landed), no Terms"

# =====================================================================================================================
step "the README's step 9: a teammate invited, the invitation read from Mailpit's API (127.0.0.1:$MAILPIT_PORT), the invitee's account made from its link (POST /api/v1/invitation-registrations)"
ORGANIZATION_URL="$GATEWAY_URL/api/v1/organizations/$GROUP_ID"
platform POST "$ORGANIZATION_URL/invitations" "$(body invite '{email: $e, role: "contributor"}' --arg e "$INVITEE_EMAIL")"
[ "$status" = 201 ] || fail "inviting a teammate answered $status ($(reply_code))"
query=$(jq -rn --arg q "to:\"$INVITEE_EMAIL\"" '$q | @uri')
message_id=""
for _ in $(seq 1 30); do
  message_id=$(curl -q -s --max-time 10 "$MAILPIT_URL/api/v1/search?query=$query" | jq -r '.messages[0].ID // empty' 2>/dev/null || true)
  [ -n "$message_id" ] && break
  sleep 1
done
[ -n "$message_id" ] || fail "no invitation to $INVITEE_EMAIL reached Mailpit within 30 s"
curl -q -s --max-time 30 "$MAILPIT_URL/api/v1/message/$message_id" >"$SECRETS_DIR/invitation-message.json" || true
link=$(jq -r '.Text // empty' "$SECRETS_DIR/invitation-message.json" 2>/dev/null | grep -oE 'https?://[^[:space:]]+/accept-invitation#token=[A-Za-z0-9_-]+' | head -n 1 || true)
[[ "$link" == "$GATEWAY_URL/accept-invitation#token="* ]] ||
  fail "the invitation in Mailpit holds no link to the public URL's /accept-invitation (not shown)"
printf '%s\n' "${link##*token=}" >"$SECRETS_DIR/invitation-token"
remember "$SECRETS_DIR/invitation-token"
[ "$(http_status "${link%%#*}")" = 200 ] || fail "the invitation link's page (/accept-invitation) doesn't answer 200 through the gateway"
link=""
openssl rand -hex 16 | tr -d '\n' >"$SECRETS_DIR/invitee-password"
remember "$SECRETS_DIR/invitee-password"
jq -Rs --rawfile p "$SECRETS_DIR/invitee-password" '{token: (. | rtrimstr("\n")), password: $p}' <"$SECRETS_DIR/invitation-token" \
  >"$SECRETS_DIR/invitation-registration.json"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -c "$INVITEE_JAR" -X POST "$GATEWAY_URL/api/v1/invitation-registrations" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$SECRETS_DIR/invitation-registration.json" || true)
[ "$status" = 201 ] && [ "$(reply_json '.organization.id')" = "$GROUP_ID" ] ||
  fail "registering from the invitation answered $status ($(reply_code)), not 201 in the organization"
add_jar_values "$INVITEE_JAR"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -b "$INVITEE_JAR" "$GATEWAY_URL/api/v1/auth/me" || true)
[ "$status" = 200 ] &&
  [ "$(reply_json -c '[.user.email, .organization.id, .organization.role, .isProductAdmin, .termsAcceptanceRequired]')" = \
    "$(jq -cn --arg e "$INVITEE_EMAIL" --arg g "$GROUP_ID" '[$e, $g, "contributor", false, false]')" ] ||
  fail "/me as the invitee answered $status, or isn't a contributor of the organization without Terms"
pass "invited (201); the invitation reached Mailpit, its link the public URL's; the invitee's account made (201), a contributor of \"$ORGANIZATION_NAME\", no Terms"

# =====================================================================================================================
step "the README's step 8: a configuration created, validated (valid, and invalid naming exporters::nosuchexporter) and run in the tester"
CONFIGURATIONS_URL="$ORGANIZATION_URL/configurations"
VALID_YAML=$'# The archive smoke\'s configuration\nreceivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 127.0.0.1:4320\nprocessors:\n  batch: {}\nexporters:\n  debug:\n    verbosity: basic\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [debug]\n'
INVALID_YAML=$'receivers:\n  otlp:\n    protocols:\n      http: {}\nexporters:\n  debug: {}\n  nosuchexporter: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug, nosuchexporter]\n'
TEST_RUN_YAML=$'receivers:\n  otlp:\n    protocols:\n      http: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n'
platform POST "$CONFIGURATIONS_URL" "$(body configuration-create '{name: $n, description: "scripts/smoke-compose-install.sh"}' --arg n "Compose smoke $RUN_ID")"
[ "$status" = 201 ] || fail "creating the configuration answered $status ($(reply_code))"
CONFIGURATION_ID=$(reply_json '.configuration.id')
platform GET "$CONFIGURATIONS_URL/$CONFIGURATION_ID"
V1_ID=$(reply_json '.version.id')
V1_COLLECTOR=$(reply_json '.version.collectorVersion')
[ "$status" = 200 ] && [ -n "$V1_ID" ] && [[ "$V1_COLLECTOR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "reading the configuration answered $status ($(reply_code)), or no version 1 with a collector version"
platform PATCH "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID" "$(body save-v1 '{yamlContent: $y, nodes: [], edges: [], pipelines: []}' --arg y "$VALID_YAML")"
[ "$status" = 200 ] || fail "saving version 1 answered $status ($(reply_code))"
platform POST "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID/validation" "$(body validate-valid '{yaml: $y}' --arg y "$VALID_YAML")"
[ "$status" = 200 ] && [ "$(reply_json -c '[.status, .collectorVersion, (.errors | length)]')" = "$(jq -cn --arg v "$V1_COLLECTOR" '["valid", $v, 0]')" ] ||
  fail "validating version 1's text answered $status: $(reply_json -c '{status, collectorVersion, errors: [.errors[]?.componentPath]}')"
platform POST "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID/validation" "$(body validate-invalid '{yaml: $y}' --arg y "$INVALID_YAML")"
[ "$status" = 200 ] && [ "$(reply_json '.status')" = invalid ] && [ "$(reply_json -c '[.errors[].componentPath]')" = '["exporters::nosuchexporter"]' ] ||
  fail "validating an invalid text answered $status: $(reply_json -c '{status, errors: [.errors[]?.componentPath]}')"
RECORD_BODY="compose smoke record $RUN_ID"
jq -n --arg b "$RECORD_BODY" '{resourceLogs: [{resource: {attributes: [{key: "service.name", value: {stringValue: "compose-smoke"}}]},
  scopeLogs: [{scope: {}, logRecords: [{timeUnixNano: "1700000000000000000", severityText: "INFO", body: {stringValue: $b}}]}]}]}' \
  >"$STATE/smoke-logs.json"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 60 -b "$JAR" -c "$JAR" -X POST "$ORGANIZATION_URL/test-files" -H 'X-Telflo-CSRF: 1' \
  -F 'displayName=Compose smoke logs' -F 'description=' -F "file=@$STATE/smoke-logs.json;type=application/json;filename=smoke-logs.json" || true)
[ "$status" = 201 ] || fail "uploading the test file answered $status ($(reply_code))"
TEST_FILE_ID=$(reply_json '.file.id')
TEST_RUNS_URL="$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID/test-runs"
platform POST "$TEST_RUNS_URL" "$(body test-run '{inputFileId: $f, pipeline: "logs", signal: "logs", durationSeconds: 2, yaml: $y, collectorVersion: $v}' \
  --arg f "$TEST_FILE_ID" --arg y "$TEST_RUN_YAML" --arg v "$V1_COLLECTOR")"
[ "$status" = 201 ] || fail "queuing the test run answered $status ($(reply_code))"
TEST_RUN_ID=$(reply_json '.run.id')
run_status=""
for _ in $(seq 1 180); do
  platform GET "$TEST_RUNS_URL/$TEST_RUN_ID"
  run_status=$(reply_json '.run.status')
  case "$run_status" in succeeded | failed | validation_failed) break ;; esac
  sleep 1
done
[ "$run_status" = succeeded ] || fail "the test run ended ${run_status:-unfinished}: $(reply_json -c '.run | {status, errorCode, strategy, collectorVersion}')"
platform GET "$TEST_RUNS_URL/$TEST_RUN_ID/files/output"
[ "$status" = 200 ] && grep -qF "$RECORD_BODY" "$REPLY_BODY" || fail "the test run's output answered $status, or doesn't hold the record"
pass "created; valid for $V1_COLLECTOR, and invalid naming exporters::nosuchexporter; the test run succeeded in the tester with the record in its output"

# =====================================================================================================================
step "a fleet created, version 1 published and assigned to its Default group, and a collector enrolled there from the group's install facts ($COLLECTOR_IMAGE, on the project's network)"
FLEET_ID=$(uuid4)
FLEETS_URL="$ORGANIZATION_URL/fleets"
FLEET_URL="$FLEETS_URL/$FLEET_ID"
platform POST "$FLEETS_URL" "$(body fleet-create '{id: $id, label: $l, type: "server", rotateExpiresAt: null}' --arg id "$FLEET_ID" --arg l "compose-smoke-$RUN_ID")"
jq -r '.tokens.default.bearer // empty, .tokens.rotate.bearer // empty' "$REPLY_BODY" >"$SECRETS_DIR/fleet-bearers" 2>/dev/null || true
remember "$SECRETS_DIR/fleet-bearers"
[ "$status" = 201 ] || fail "creating the fleet answered $status ($(reply_code))"
no_store || fail "the fleet's create, carrying its bearers, isn't Cache-Control: no-store"
[ "$(grep -c . "$SECRETS_DIR/fleet-bearers")" = 2 ] || fail "the fleet's create answered no two bearers (not shown)"
DEFAULT_GROUP_ID=$(reply_json '.defaultGroup.id')
DEFAULT_TOKEN_ID=$(reply_json '.tokens.default.id')
: >"$REPLY_BODY"
[[ "$DEFAULT_GROUP_ID" =~ ^[0-9a-f-]{36}$ ]] && [[ "$DEFAULT_TOKEN_ID" =~ ^[0-9a-f-]{36}$ ]] || fail "the fleet's create named no Default group or default token"
# A group's install needs a version assigned: the configuration's version 1, published.
platform POST "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID/publish"
[ "$status" = 200 ] || fail "publishing version 1 answered $status ($(reply_code))"
platform PATCH "$FLEET_URL/groups/$DEFAULT_GROUP_ID" "$(body group-assign '{assignedVersionId: $v}' --arg v "$V1_ID")"
[ "$status" = 200 ] || fail "assigning version 1 to the Default group answered $status ($(reply_code))"
platform GET "$FLEET_URL/groups/$DEFAULT_GROUP_ID/install"
[ "$status" = 200 ] || fail "reading the Default group's install facts answered $status ($(reply_code))"
no_store || fail "the install facts aren't Cache-Control: no-store"
FACTS=$STATE/install-facts.json
cp "$REPLY_BODY" "$FACTS"
[ "$(jq -r '[.. | objects | has("bearer")] | any' "$FACTS" 2>/dev/null)" = false ] && ! grep -qE '[A-Za-z0-9+/]{100,}' "$FACTS" ||
  fail "the install facts carry a bearer, or a run of 100 or more base64 characters (not shown)"
[ "$(jq -c '[.imageTag, .endpoint, .groupId, .allowInsecureConnections, (.mounts | length)]' "$FACTS" 2>/dev/null)" = \
  "$(jq -cn --arg i "$COLLECTOR_IMAGE" --arg e "$AGENT_ENDPOINT" --arg g "$DEFAULT_GROUP_ID" '[$i, $e, $g, true, 0]')" ] ||
  fail "the install facts aren't $COLLECTOR_IMAGE, the endpoint $AGENT_ENDPOINT (setup.sh's --agent-url), the Default group, insecure connections allowed and no mount: $(jq -c '{imageTag, endpoint, allowInsecureConnections, mounts}' "$FACTS" 2>/dev/null)"
platform POST "$FLEET_URL/tokens/$DEFAULT_TOKEN_ID/reveal"
[ "$status" = 200 ] || fail "revealing the default token answered $status ($(reply_code))"
no_store || fail "the reveal isn't Cache-Control: no-store"
jq -j '.token.bearer // empty' "$REPLY_BODY" >"$SECRETS_DIR/bearer"
: >"$REPLY_BODY"
[ -s "$SECRETS_DIR/bearer" ] || fail "the reveal answered no bearer"
remember "$SECRETS_DIR/bearer"
# The bearer reaches the container through an env file of secrets/, never a command line.
{ printf 'OPAMP_TOKEN='; cat "$SECRETS_DIR/bearer"; printf '\n'; } >"$SECRETS_DIR/collector.env"
# The facts' endpoint is the published agent port on localhost, as a collector on this machine's own network reaches
# it; a container on the project's network reaches the same endpoint by the service's name.
network_endpoint=$(replace_all "$(jq -r '.endpoint' "$FACTS")" "http://localhost:$AGENT_PORT" "http://opamp-server:51234")
[ "$network_endpoint" = "$NETWORK_ENDPOINT" ] || fail "the facts' endpoint couldn't be moved onto the project's network"
NETWORK="${PROJECT}_default"
docker network inspect "$NETWORK" >/dev/null 2>>"$LOGS/docker.err" || fail "the project's network $NETWORK isn't there"
collector_started=yes
docker run -d --pull never --name "$COLLECTOR_CONTAINER" --network "$NETWORK" -v "$COLLECTOR_VOLUME:/app/opamp" \
  -e "COLLECTOR_GROUP_ID=$(jq -r '.groupId' "$FACTS")" -e "OPAMP_ENDPOINT=$network_endpoint" \
  -e "OPAMP_ALLOW_INSECURE_CONNECTIONS=$(jq -r '.allowInsecureConnections' "$FACTS")" -e OPAMP_SERVER_NAME=compose-smoke-c1 \
  --env-file "$SECRETS_DIR/collector.env" "$(jq -r '.imageTag' "$FACTS")" >"$LOGS/collector-run.out" 2>&1 ||
  fail "running the collector failed (its output: $LOGS/collector-run.out)"
collector=""
for _ in $(seq 1 120); do
  platform GET "$FLEET_URL/collectors?groupId=$DEFAULT_GROUP_ID"
  if [ "$status" = 200 ]; then
    collector=$(jq -c --arg g "$DEFAULT_GROUP_ID" '[.collectors[] | select(.name == "compose-smoke-c1" and .groupId == $g)][0] // empty' "$REPLY_BODY" 2>/dev/null || true)
    [ -n "$collector" ] && break
  fi
  sleep 1
done
docker logs "$COLLECTOR_CONTAINER" >"$LOGS/collector.log" 2>&1 || true
[ -n "$collector" ] || fail "the collector didn't enrol in the Default group within 120 polls (its log: $LOGS/collector.log)"
remove_collector
[ -z "$(docker ps -aq --filter "name=^/$COLLECTOR_CONTAINER\$")" ] || fail "couldn't remove the collector's container"
collector_started=no
pass "the fleet created (201, no-store); the facts named $COLLECTOR_IMAGE and $AGENT_ENDPOINT; compose-smoke-c1 enrolled in the Default group; its container and volume removed"

# =====================================================================================================================
step "every secret of the run searched for in every file of the work folder (outside secrets/ and the install's .env and secrets/), every service's log and the collector's included"
in_install docker compose logs --no-color --timestamps >"$LOGS/compose.log" 2>&1 || fail "docker compose logs failed"
[ -s "$LOGS/compose.log" ] || fail "docker compose logs wrote nothing"
add_jar_values "$JAR"
add_jar_values "$INVITEE_JAR"
searched=0
hits=""
while IFS= read -r file; do
  case "$file" in "$SECRETS_DIR"/* | "$INSTALL/.env" | "$INSTALL/secrets"/*) continue ;; esac
  searched=$((searched + 1))
  if holds_value "$file"; then hits="$hits ${file#"$WORK"/}"; fi
done <<EOF
$(find "$WORK" -type f)
EOF
[ -z "$hits" ] || fail "a secret of the run is in:$hits (not shown)"
pass "$(originals_count) secrets (each with its base64 forms) in none of $searched files"

# =====================================================================================================================
index=$DOWN_INDEX
while [ "$index" -le "$CMD_COUNT" ]; do
  step "$(command_label "$index"): ${CMD_TEXT[$index]}"
  run_command "$index"
  [ "$command_status" = 0 ] || fail "$(command_label "$index") exited $command_status (its output: $(command_output "$index"), not shown)"
  pass "exit 0"
  index=$((index + 1))
done

step "nothing of the project left: no container, volume or network labelled $PROJECT, the README's folder gone"
cd "$WORK"
left=$(project_leftovers)
[ -z "$left" ] || fail "left of the project: $(printf '%s\n' "$left" | tr '\n' ';')"
[ -z "$(ls -A "$RUN_DIR")" ] || fail "the README's last command left $(ls -A "$RUN_DIR" | tr '\n' ' ')in the run's folder"
# The outputs of the last commands and this script's own lines so far, searched too.
hits=""
for file in "$OUTPUT_LOG" "$OUTPUTS"/*; do
  [ -f "$file" ] || continue
  if holds_value "$file"; then hits="$hits ${file#"$WORK"/}"; fi
done
[ -z "$hits" ] || fail "a secret of the run is in:$hits (not shown)"
project_started=no
pass "no container, volume or network of $PROJECT; the run's folder empty; the outputs and this log hold no secret"
