#!/usr/bin/env bash
# rehearse.sh: the release, rehearsed on this machine before any tag (an
# end-to-end test anyone can re-run from a clean checkout with one command;
# docs/releasing.md "Rehearse a release on your machine"): the scripts the two
# workflows call, in their order, on the local Docker engine with the private
# tools, a throwaway registry:2 on 127.0.0.1 standing in for GHCR. Nothing
# reaches GitHub or GHCR: no push but to that registry, no login, no GitHub
# Release.
#
#   scripts/release/rehearse.sh --version <x.y.z> --work <dir> [--no-attest] [--keep]
#                               [--allow-battery] [--port-base <n>]
#                               [--registry 127.0.0.1:<port>|localhost:<port>] [--dry-run]
#   scripts/release/rehearse.sh --cleanup --work <dir>
#
# Before the steps (each logged and timed like a step):
#   prep      tools.sh fetch (kind, crane, buildx: release binaries, each
#             checked against tools.lock's sha256, into .tools/), then
#             tools.sh pull for each image tools.lock pins (registry first,
#             then buildkit, syft-scanner, kind-node, postgres, mailpit: by
#             digest only; one already local isn't pulled again);
# then the steps (the first failure stops the run; the end still runs):
#   collector.yml: steps.sh builder (telflo-release, as its build job), then
#   for every version the catalogue offers:
#     build-collector-image.sh <v> --build-oci, load-images.sh --image
#     collector, steps.sh collector-test, --push-oci to the registry,
#     pull-back.sh --image collector --no-chart; then steps.sh chart-if-new
#     (the supervisor-collector chart);
#   release.yml:
#     version   verify-tag.sh v<version> in a throwaway clone (<work>/clone,
#               whose origin's main is HEAD) holding the local annotated tag;
#               verify-collector-artifacts.sh; steps.sh collector-archive
#     static    scripts/gates/static.sh on this checkout (OPAMP_SERVER_SRC: a
#               clone of github.com/telflo/opamp-server at vendor/opamp-
#               server/PIN's tag, in <work>)
#     build     tools.sh docker-config, steps.sh builder (telflo-release),
#               publish-platform-images.sh --build-oci (the five images)
#     package   publish-chart.sh --chart telflo --package,
#               build-compose-archive.sh, steps.sh release-files
#     smokes    load-images.sh (the five, and the default collector from
#               collector-archive's file; each the engine's own platform,
#               natively: linux/arm64 on an Apple-silicon Mac, where the
#               workflows name linux/amd64, the runner's), then steps.sh
#               stack-smoke (oss), archive-smoke and kind-smoke, as
#               release.yml calls them (each smoke's output through
#               redact.sh)
#     publish   --push-oci, --push-package, pull-back.sh,
#               verify-collector-artifacts.sh, all against the registry, and
#               release-notes.sh into <work>/release-notes.md (no Release)
#
# Refused before anything runs (exit 2): usage; a GitHub Actions job (the
# workflow is the real run); TELFLO_REHEARSE_KUBECONFIG named with CI set (a
# test's setting only); a --version that isn't x.y.z; a --work that isn't
# absolute, isn't new or empty, or is inside this tree; a --registry that
# isn't a loopback one (ghcr.io included: never a push target here); a
# --port-base whose ports (below) include one of a developer's own stack or
# dev servers (50080, 51025, 51234, 51235, 53000, 55432, 58025, 8080); a
# COMPOSE_PROJECT_NAME naming one of OWNER_PROJECTS (below). Refused
# next (exit 1): --version not HEAD's charts/telflo/Chart.yaml version and
# appVersion. --dry-run stops here: it prints the checks, the prep and the
# steps' commands and starts nothing (no fetch, no pull, no Docker call).
# Then, on a real run: on macOS (pmset), running on battery is refused
# (exit 2) unless --allow-battery; the run keeps the machine awake
# (caffeinate -is, which it wraps itself in); a checkout with changes or
# untracked files fails (exit 1: the rehearsal is of the commit, and
# static.sh reads the tree), and so do Docker not running, one of git, jq,
# python3, curl, node, npm, helm and kubectl not on PATH, and no
# telflo-core/node_modules (npm ci there first: never run here); a
# rehearsal running now (its labels, below), a container, volume or network
# named telflo-rehearse-* (an earlier run's: --cleanup) or one of its ports
# in use on 127.0.0.1 is refused (exit 2); the work folder's disk under 10 GB free
# fails (the archives, about 4 GB, the clones and the unpacked layouts), and
# Docker's disk under 25 GB free fails after the registry image's pull (the
# runner's largest job needs 18 GB, the kind smoke's; here every job's
# images, the builder's cache and a kind node add up to about 20 GB, and 5 GB
# more keeps Docker's disk, which a developer's own stack shares, from
# filling); an image the smokes run by tag that isn't local fails (never
# pulled or re-tagged here: postgres:18, axllent/mailpit:v1.31,
# nginx:1.27-alpine at the chart's digest, ghcr.io/telflo/opamp-server at the
# PIN's).
#
# The rehearsal's own names and ports: projects, clusters and containers
# telflo-rehearse-* (the registry telflo-rehearse-registry, the stack smoke's
# telflo-rehearse-stack, the archive smoke's telflo-rehearse-archive, the
# kind smoke's telflo-rehearse-kind, the gateway check's
# telflo-rehearse-gateway-logs, load-images.sh's telflo-rehearse-load-images);
# ports on 127.0.0.1 from --port-base (default 34600): +1 to +11 the stack
# smoke, +100 to +102 the archive smoke, +110 and +111 the kind smoke, +120
# the gateway check; the registry a port the system hands out. No gate needs
# a database or a Mailpit of the rehearsal's: the stack and archive smokes
# run their own (in their projects), the kind smoke its own in the cluster.
# The settings every gate and smoke reads are the rehearsal's: every
# inherited TELFLO_*, OPAMP_*, AWS_*, COMPOSE_*, PG* and DATABASE_URL
# variable is unset before the steps, then only these are set: DOCKER_CONFIG
# and HELM_REGISTRY_CONFIG (<work>/docker: no login, the checked buildx),
# TMPDIR (<work>/tmp), OPAMP_SERVER_SRC,
# CHECK_GATEWAY_LOGS_CONTAINER/_PORT and TELFLO_LOAD_IMAGES_NAME. Nothing
# reads telflo-core/.env or .superpowers/.
#
# The kube context and the kubeconfig (KUBECONFIG's files, else
# ~/.kube/config): before the prep and at the end, the current context
# (`kubectl config current-context` with those files: nothing else is read)
# and each file's sha256 and mtime are recorded; any change fails the run.
# TELFLO_REHEARSE_KUBECONFIG (tests only, refused with CI set) names the
# file in their place.
#
# A running rehearsal is marked: right after its checks it makes the volume
# telflo-rehearse-run, and starts its registry, labelled with its work
# folder, its pid and that process's start time
# (telflo.rehearse.work/.pid/.started). While that process runs, another
# rehearsal refuses to start and --cleanup refuses to remove anything (exit
# 2); a finishing run leaves alone any object whose labels name another
# running rehearsal. The smokes' objects (their Compose projects, the kind
# cluster) carry no label: they are known by their telflo-rehearse-* names
# only, which no other run can hold while this one runs (it would have
# refused to start).
#
# The end, whatever happened: a table (each step, its exit code and
# seconds), the total time, the log's REDACTED count (which must be 0), the
# kube check, and what was removed or kept, also in <work>/summary.txt.
# Without --keep it removes, by name, what the run made: every container,
# volume and network named telflo-rehearse-* (its marker, the registry it
# started, a smoke's leftovers), the stack smoke's telflo-smoke-collector:
# telflo-rehearse-* images, the telflo-release builder (its container and
# state volume) if this run created it, the release-named images it loaded
# into the engine (ghcr.io/telflo/telflo/<name>:<version> and
# .../collector:<v>, absent before the run: rehearse.state records each
# one's image id right after the step that loads it, and it is removed only
# while its id is still that one), and everything in <work> except the logs
# (rehearse.log, logs/, summary.txt, release-notes.md, rehearse.state,
# static/logs and static/summary.txt). --keep leaves the registry, <work>,
# the images and the builder for inspection (its marker is removed), says
# what it kept, and names the command that removes them:
#   rehearse.sh --cleanup --work <dir>  removes what <dir>'s run made (its
#             rehearse.state names the images, with their ids, and the
#             builder), the telflo-rehearse-* containers, volumes and
#             networks, then <dir>; refused while any rehearsal runs.
# Neither ever prunes. Beyond the telflo-rehearse-* names, the builder and
# the images rehearse.state names, they remove nothing. The private tools
# (.tools/ and tools.lock's images) are kept for the next run:
# scripts/release/tools.sh remove deletes them.
#
# --no-attest builds without attestations (a builder too old to attest; the
# registry is loopback, so the push scripts accept it) and says so.
# --registry names a registry:2 already running on loopback (never
# removed); otherwise one is started (tools.lock's image, --pull never, no
# login).
#
# Every command's output goes through scripts/gates/redact.sh into
# <work>/logs/<n>-<step>.log and <work>/rehearse.log. From the first Docker
# call on (the checks before the work folder exists, and --cleanup's),
# DOCKER_CONFIG is a temporary configuration holding no login; then Docker
# and Helm read <work>/docker; refusing docker-credential-* stand-ins are
# first on PATH,
# and a call to one fails the run. Exit 0 every step passed; 1 a step or
# check failed; 2 usage or refused. bash 3.2 compatible.
set -uo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." >/dev/null && pwd)"
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
# The rehearsal's own git calls ignore replace refs. A function, not an
# export: the steps run with git's defaults (their tests make replace refs).
git() { GIT_NO_REPLACE_OBJECTS=1 command git "$@"; }
# shellcheck source=scripts/release/version.sh
. "$ROOT/scripts/release/version.sh"
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"

PROGRAM=rehearse
IMAGES="api web otelcol-validator otelcol-testing ottl-evaluator"
BUILDER=telflo-release
PREFIX=telflo-rehearse
REGISTRY_NAME="$PREFIX-registry"
OWNER_PROJECTS="telflo telflo-dev telflo-platform"
OWNER_PORTS="50080 51025 51234 51235 53000 55432 58025 8080"
IMAGE_KEYS="registry buildkit syft-scanner kind-node postgres mailpit"
DOCKER_NEED_GB=25
HOST_NEED_GB=10
NAME_RE='^telflo-rehearse-[A-Za-z0-9_.-]+$'
MADE_IMAGE_RE='^ghcr\.io/telflo/telflo/(api|web|otelcol-validator|otelcol-testing|ottl-evaluator|collector):(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

usage() {
  echo "usage: scripts/release/rehearse.sh --version <x.y.z> --work <dir> [--no-attest] [--keep] [--allow-battery] [--port-base <n>] [--registry 127.0.0.1:<port>|localhost:<port>] [--dry-run]" >&2
  echo "       scripts/release/rehearse.sh --cleanup --work <dir>" >&2
}
refuse() { echo "$PROGRAM: refused: $1" >&2; exit 2; }
refuse_usage() { echo "$PROGRAM: $1" >&2; usage; exit 2; }
fail() { echo "$PROGRAM: FAIL: $1" >&2; exit 1; }
note() { echo "$PROGRAM: $1" >&2; }

orig_args=("$@")
version="" work="" no_attest=false registry="" dry_run=false keep=false allow_battery=false
port_base=34600 cleanup_mode=false others=false
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || refuse_usage "--version needs a value"; version="$2"; others=true; shift 2 ;;
    --work) [ $# -ge 2 ] || refuse_usage "--work needs a folder"; work="$2"; shift 2 ;;
    --registry) [ $# -ge 2 ] || refuse_usage "--registry needs a value"; registry="$2"; others=true; shift 2 ;;
    --port-base) [ $# -ge 2 ] || refuse_usage "--port-base needs a number"; port_base="$2"; others=true; shift 2 ;;
    --no-attest) no_attest=true; others=true; shift ;;
    --dry-run) dry_run=true; others=true; shift ;;
    --keep) keep=true; others=true; shift ;;
    --allow-battery) allow_battery=true; others=true; shift ;;
    --cleanup) cleanup_mode=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) refuse_usage "unknown argument: ${1%%=*}" ;;
  esac
done
[ "${GITHUB_ACTIONS:-}" != true ] || refuse "a rehearsal runs on a workstation, never in a GitHub Actions job (the workflow is the real run)"
if [ -n "${TELFLO_REHEARSE_KUBECONFIG+set}" ] && telflo_in_ci; then
  refuse "TELFLO_REHEARSE_KUBECONFIG is a test's setting: never with CI set"
fi

TOOLS="$ROOT/scripts/release/tools.sh"
docker_up() { command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1; }
# docker_stub_config: from the first Docker call on, DOCKER_CONFIG is a
# temporary configuration holding no login (never ~/.docker); the run moves
# to <work>/docker once it exists. Removed at the end.
pre_docker=""
docker_stub_config() {
  pre_docker="$(mktemp -d "${TMPDIR:-/tmp}/rehearse-docker.XXXXXX")" || fail "no temporary directory"
  (umask 077 && printf '%s\n' '{"auths":{"telflo-rehearse.invalid":{}}}' >"$pre_docker/config.json") || fail "no temporary directory"
  export DOCKER_CONFIG="$pre_docker"
  trap 'rm -rf "$pre_docker"' EXIT
}
rel_path() { # <path>: its real path, or nothing
  (cd "$1" 2>/dev/null && pwd -P)
}
# remove_named: every container, volume and network named telflo-rehearse-*,
# and the stack smoke's telflo-smoke-collector:telflo-rehearse-* images;
# each name printed. Never a prune.
removed=()
try_remove() { # <what> <command...>: <what> recorded as removed, or named
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then removed+=("$what"); else note "couldn't remove $what"; fi
}
# A run's own objects carry labels naming it: the marker volume
# telflo-rehearse-run and the registry it starts. The smokes' (Compose
# projects, the kind cluster) carry none: they are known by name only.
LABEL_WORK=telflo.rehearse.work
LABEL_PID=telflo.rehearse.pid
LABEL_STARTED=telflo.rehearse.started
MARKER="$PREFIX-run"
started_of() { # <pid>: the process's start time, one spelling, or nothing
  ps -o lstart= -p "$1" 2>/dev/null | sed 's/  */ /g; s/^ //; s/ $//'
}
labels_of() { # container|volume <name>: its labels as JSON (null when none)
  if [ "$1" = volume ]; then
    docker volume inspect --format '{{json .Labels}}' "$2" 2>/dev/null
  else
    docker container inspect --format '{{json .Config.Labels}}' "$2" 2>/dev/null
  fi
}
# live_holder <labels JSON>: prints "<work> <pid>" when the labels name a
# rehearsal whose process is still running (its pid alive, started when the
# label says: never a reused pid); nothing otherwise.
live_holder() {
  local work pid started
  work="$(printf '%s' "$1" | jq -r --arg k "$LABEL_WORK" 'if type == "object" then (.[$k] // "") else "" end' 2>/dev/null)"
  pid="$(printf '%s' "$1" | jq -r --arg k "$LABEL_PID" 'if type == "object" then (.[$k] // "") else "" end' 2>/dev/null)"
  started="$(printf '%s' "$1" | jq -r --arg k "$LABEL_STARTED" 'if type == "object" then (.[$k] // "") else "" end' 2>/dev/null)"
  [ -n "$work" ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ -n "$started" ] || return 0
  [ "$(started_of "$pid")" = "$started" ] || return 0
  printf '%s %s\n' "$work" "$pid"
}
# live_runs: "<work> <pid>" for each running rehearsal holding a telflo-rehearse-* name.
live_runs() {
  local name
  for name in $(docker ps -a --filter "name=$PREFIX-" --format '{{.Names}}' 2>/dev/null | grep -E "$NAME_RE"); do
    live_holder "$(labels_of container "$name")"
  done
  for name in $(docker volume ls --filter "name=$PREFIX-" --format '{{.Name}}' 2>/dev/null | grep -E "$NAME_RE"); do
    live_holder "$(labels_of volume "$name")"
  done
}
# other_run <container|volume> <name>: exit 0 when its labels name another
# running rehearsal than this one (OWN_WORK): never removed.
OWN_WORK=""
other_run() {
  local holder
  holder="$(live_holder "$(labels_of "$1" "$2")")"
  [ -n "$holder" ] && [ "${holder% *}" != "$OWN_WORK" ]
}
remove_named() {
  local name tag
  for name in $(docker ps -a --filter "name=$PREFIX-" --format '{{.Names}}' 2>/dev/null | grep -E "$NAME_RE"); do
    if other_run container "$name"; then note "container $name belongs to another rehearsal that is running: left alone"; continue; fi
    try_remove "container $name" docker rm -f -v "$name"
  done
  for name in $(docker network ls --filter "name=$PREFIX-" --format '{{.Name}}' 2>/dev/null | grep -E "$NAME_RE"); do
    try_remove "network $name" docker network rm "$name"
  done
  for name in $(docker volume ls --filter "name=$PREFIX-" --format '{{.Name}}' 2>/dev/null | grep -E "$NAME_RE"); do
    if other_run volume "$name"; then note "volume $name belongs to another rehearsal that is running: left alone"; continue; fi
    try_remove "volume $name" docker volume rm "$name"
  done
  for tag in $(docker image ls telflo-smoke-collector --format '{{.Tag}}' 2>/dev/null | grep -E "$NAME_RE"); do
    try_remove "image telflo-smoke-collector:$tag" docker rmi "telflo-smoke-collector:$tag"
  done
}
# remove_recorded <state file>: the builder (if the run made it) and the
# images it loaded, as its state file names them: each image only while its
# id is still the one the run recorded when it loaded it.
remove_recorded() {
  local kind value extra builder_name now
  builder_name="$(awk '$1 == "builder" { print $2; exit }' "$ROOT/scripts/release/tools.lock")"
  while read -r kind value extra; do
    case "$kind" in
      builder)
        if [ "$value" != "$builder_name" ] || [ "$extra" != made ]; then
          [ "$extra" = existed ] || note "rehearse.state names the builder '$value' ($extra): not tools.lock's, or not made by the run: left alone"
          continue
        fi
        if docker container inspect "buildx_buildkit_${value}0" >/dev/null 2>&1; then
          try_remove "the builder $value's container" docker rm -f "buildx_buildkit_${value}0"
        fi
        if docker volume inspect "buildx_buildkit_${value}0_state" >/dev/null 2>&1; then
          try_remove "the builder $value's state volume" docker volume rm "buildx_buildkit_${value}0_state"
        fi
        ;;
      image)
        if ! [[ "$value" =~ $MADE_IMAGE_RE ]]; then
          note "rehearse.state names the image '$value', not a release-named one: left alone"
          continue
        fi
        if ! [[ "$extra" =~ $TELFLO_OCI_DIGEST_RE ]]; then
          note "rehearse.state names the image $value without the id the run loaded: left alone"
          continue
        fi
        now="$(docker image inspect --format '{{.Id}}' "$value" 2>/dev/null)" || continue
        if [ "$now" != "$extra" ]; then
          note "image $value is now $now, not the $extra the run loaded: left alone"
          continue
        fi
        if docker rmi "$value" >/dev/null 2>&1; then removed+=("image $value"); else note "couldn't remove image $value (in use?)"; fi
        ;;
    esac
  done <"$1"
}

# ---- --cleanup --work <dir> ------------------------------------------------------------------
if $cleanup_mode; then
  $others && refuse_usage "--cleanup takes --work <dir> only"
  case "$work" in /*) ;; *) refuse_usage "--cleanup needs --work <the run's folder>, an absolute path" ;; esac
  real="$(rel_path "$work")" || refuse "--work $work isn't a folder"
  [ -f "$real/rehearse.state" ] || refuse "$work holds no rehearse.state: not a rehearsal's work folder"
  [ "$(awk '$1 == "work" { print $2; exit }' "$real/rehearse.state")" = "$real" ] \
    || refuse "$work's rehearse.state names another folder: not this run's"
  case "$real/" in "$(rel_path "$ROOT")/"*) refuse "--work must be outside this tree" ;; esac
  case "$real" in / | "$(rel_path "$HOME" || echo /)") refuse "--work $work is / or your home folder" ;; esac
  command -v jq >/dev/null 2>&1 || fail "jq isn't on PATH: --cleanup reads the labels with it (nothing removed)"
  docker_stub_config
  docker_up || fail "Docker isn't running: nothing removed"
  live="$(live_runs | sort -u)"
  [ -z "$live" ] || refuse "a rehearsal is running now (its work folder and pid: $(printf '%s' "$live" | tr '\n' ';')): --cleanup removes nothing while one runs"
  OWN_WORK="$real"
  remove_named
  remove_recorded "$real/rehearse.state"
  cd / || exit 1
  try_remove "the work folder $real" rm -rf "$real"
  if [ "${#removed[@]}" -eq 0 ]; then echo "$PROGRAM: nothing to remove"; else
    echo "$PROGRAM: removed:"; for r in "${removed[@]}"; do echo "  - $r"; done
  fi
  echo "$PROGRAM: kept: the private tools (.tools/ and tools.lock's images: scripts/release/tools.sh remove deletes them)"
  exit 0
fi

# ---- The arguments and settings ---------------------------------------------------------------
telflo_version_ok "$version" || refuse_usage "--version must be x.y.z (got '$version')"
case "$work" in /*) ;; *) refuse_usage "--work must be an absolute path" ;; esac
[ ! -e "$work" ] || [ -z "$(ls -A "$work" 2>/dev/null)" ] || refuse "--work $work isn't empty: use a new folder"
work_parent="$(cd "$(dirname "$work")" 2>/dev/null && pwd -P)" || refuse "--work's parent folder doesn't exist"
case "$work_parent/" in "$(cd "$ROOT" && pwd -P)/"*) refuse "--work must be outside this tree" ;; esac
if [ -n "$registry" ]; then
  telflo_registry_loopback "$registry" \
    || refuse "--registry must be a loopback registry, 127.0.0.1:<port> or localhost:<port>: a rehearsal never pushes to GHCR or anywhere else"
fi
[[ "$port_base" =~ ^[1-9][0-9]{3,4}$ ]] && [ "$port_base" -ge 1024 ] && [ "$port_base" -le 65400 ] \
  || refuse_usage "--port-base must be a number from 1024 to 65400"
PORTS=""
for offset in 1 2 3 4 5 6 7 8 9 10 11 100 101 102 110 111 112 120; do PORTS="$PORTS $((port_base + offset))"; done
for p in $PORTS; do
  for owner in $OWNER_PORTS; do
    [ "$p" != "$owner" ] || refuse "--port-base $port_base puts a rehearsal port on $p, one a developer's own development stack or dev servers use: name another"
  done
done
for p in $OWNER_PROJECTS; do
  [ "${COMPOSE_PROJECT_NAME:-}" != "$p" ] \
    || refuse "COMPOSE_PROJECT_NAME is $p, a developer's own development stack's: unset it (the rehearsal's compose calls name their own telflo-rehearse-* projects)"
done
# The kubeconfig guarded (never read here but by its hash and kubectl's current-context).
if [ -n "${TELFLO_REHEARSE_KUBECONFIG+set}" ]; then
  KUBE_FILES="$TELFLO_REHEARSE_KUBECONFIG"
elif [ -n "${KUBECONFIG:-}" ]; then
  KUBE_FILES="$KUBECONFIG"
else
  KUBE_FILES="$HOME/.kube/config"
fi

git_() { git -C "$ROOT" "$@"; }
commit="$(git_ rev-parse HEAD 2>/dev/null)" || fail "$ROOT isn't a git checkout"
chart_tmp="$(mktemp "${TMPDIR:-/tmp}/rehearse-chart.XXXXXX")" || fail "no temporary file"
git_ cat-file blob HEAD:charts/telflo/Chart.yaml >"$chart_tmp" 2>/dev/null || { rm -f "$chart_tmp"; fail "HEAD has no charts/telflo/Chart.yaml"; }
chart_version="$(telflo_chart_field "$chart_tmp" version)" || chart_version=""
app_version="$(telflo_chart_field "$chart_tmp" appVersion)" || app_version=""
rm -f "$chart_tmp"
[ "$chart_version" = "$version" ] && [ "$app_version" = "$version" ] \
  || fail "HEAD's charts/telflo/Chart.yaml has version '$chart_version' and appVersion '$app_version': --version must be both"
collector_default="$(jq -r '[.versions[] | select(.default == true) | .version] | if length == 1 then .[0] else empty end' "$ROOT/catalog/distributions/otelcol-contrib.json")"
telflo_version_ok "$collector_default" || fail "the catalogue names no one default collector version"
offered="$("${BASH:-bash}" "$ROOT/scripts/build-collector-image.sh" --list-offered)" || fail "the catalogue's offered versions couldn't be read"
opamp_version="$(sed -n 's/^version=//p' "$ROOT/vendor/opamp-server/PIN")"
opamp_digest="$(sed -n 's/^digest=//p' "$ROOT/vendor/opamp-server/PIN")"
telflo_version_ok "$opamp_version" || fail "vendor/opamp-server/PIN's version isn't x.y.z"
nginx_digest="$(awk '/^gateway:/{g=1} g && /digest:/{print $2; exit}' "$ROOT/charts/telflo/values.yaml")"

attest=()
$no_attest && attest=(--no-attest)
reg="${registry:-127.0.0.1:<port>}"
W="$work"
B="${BASH:-bash}"

# ---- The prep and the plan: one line per step, `<name> <command...>` (run from this tree).
prep=()
plan=()
add_prep() { local IFS=$'\x1f'; prep+=("$*"); }
add() { local IFS=$'\x1f'; plan+=("$*"); }
add_prep prep-tools "$B" scripts/release/tools.sh fetch
for key in $IMAGE_KEYS; do add_prep "prep-pull-$key" "$B" scripts/release/tools.sh pull "$key"; done
add collector-builder "$B" scripts/release/steps.sh builder
for v in $offered; do
  add "collector-build-$v" "$B" scripts/build-collector-image.sh "$v" --build-oci "$W/collector-oci" --builder "$BUILDER" ${attest[@]+"${attest[@]}"}
  add "collector-load-$v" "$B" scripts/release/load-images.sh --oci "$W/collector-oci" --version "$v" --image collector
  add "collector-test-$v" "$B" scripts/release/steps.sh collector-test --version "$v"
  add "collector-push-$v" "$B" scripts/build-collector-image.sh "$v" --push-oci "$W/collector-oci" --registry "$reg"
  add "collector-pull-back-$v" "$B" scripts/release/pull-back.sh --oci "$W/collector-oci" --version "$v" --image collector --no-chart --registry "$reg" ${attest[@]+"${attest[@]}"}
done
add collector-chart "$B" scripts/release/steps.sh chart-if-new --out "$W/collector-chart" --registry "$reg"
# verify-tag runs from the throwaway clone (no .tools/ of its own): this step alone is
# told where the checked tools are (never exported to the steps).
add version-tag env "TELFLO_TOOLS_DIR=$ROOT/.tools" "$B" "$W/clone/scripts/release/verify-tag.sh" "v$version" --registry "$reg" --expect "$commit"
add version-collectors "$B" scripts/release/verify-collector-artifacts.sh --registry "$reg"
add version-collector-archive "$B" scripts/release/steps.sh collector-archive --out "$W/collector" --registry "$reg"
add static "$B" scripts/gates/static.sh --work "$W/static"
add build-builder "$B" scripts/release/steps.sh builder
for image in $IMAGES; do
  add "build-$image" "$B" scripts/publish-platform-images.sh --build-oci "$W/oci" --builder "$BUILDER" --image "$image" ${attest[@]+"${attest[@]}"}
done
add package-chart "$B" scripts/publish-chart.sh --chart telflo --package "$W/release"
add package-archive "$B" scripts/release/build-compose-archive.sh --out "$W/release"
add package-files "$B" scripts/release/steps.sh release-files --out "$W/release"
add smokes-load "$B" scripts/release/load-images.sh --oci "$W/oci" --version "$version"
add smokes-load-collector "$B" scripts/release/load-images.sh --oci "$W/collector" --version "$collector_default" --image collector
add stack-smoke "$B" scripts/release/steps.sh stack-smoke --version "$version" --work "$W/stack-smoke" --project "$PREFIX-stack" --port-base "$port_base"
add archive-smoke "$B" scripts/release/steps.sh archive-smoke --version "$version" --release "$W/release" --work "$W/archive-smoke" \
  --project "$PREFIX-archive" --http-port $((port_base + 100)) --agent-port $((port_base + 101)) --mailpit-port $((port_base + 102))
add kind-smoke "$B" scripts/release/steps.sh kind-smoke --version "$version" --release "$W/release" --work "$W/kind-smoke" \
  --profile "$PREFIX-kind" --port $((port_base + 110)) --mailpit-port $((port_base + 111)) --api-port $((port_base + 112))
add publish-images "$B" scripts/publish-platform-images.sh --push-oci "$W/oci" --registry "$reg"
add publish-chart "$B" scripts/publish-chart.sh --chart telflo --push-package "$W/release/telflo-$version.tgz" --registry "$reg"
add publish-pull-back "$B" scripts/release/pull-back.sh --oci "$W/oci" --version "$version" --chart "$W/release/telflo-$version.tgz" --registry "$reg" ${attest[@]+"${attest[@]}"}
add publish-collectors "$B" scripts/release/verify-collector-artifacts.sh --registry "$reg"
add publish-notes "$B" scripts/release/release-notes.sh --oci "$W/oci" --chart "$W/release/telflo-$version.tgz" --version "$version"

say_lines() { # <prefix letter or ""> <lines...>
  local letter="$1" line n=0 name
  shift
  for line in "$@"; do
    n=$((n + 1))
    name="${line%%$'\x1f'*}"
    printf '%s%02d %s:' "$letter" "$n" "$name"
    local IFS=$'\x1f'
    # shellcheck disable=SC2086 # split on the unit separator only
    set -f; set -- ${line#*$'\x1f'}; set +f
    printf ' %q' "$@"
    printf '\n'
  done
}

if $dry_run; then
  echo "$PROGRAM: dry run of $commit, version $version, registry $reg$($no_attest && echo ', no attestations'): nothing is started"
  if [ -n "$(git_ status --porcelain 2>/dev/null)" ]; then echo "$PROGRAM: (a real run refuses this checkout: it has changes or untracked files)"; fi
  echo "$PROGRAM: a real run checks first: the power source (pmset; battery refused without --allow-battery), under caffeinate -is;"
  echo "$PROGRAM:   a clean checkout; no telflo-rehearse-* container, volume or network; the ports$PORTS free on 127.0.0.1;"
  echo "$PROGRAM:   $HOST_NEED_GB GB free for the work folder, $DOCKER_NEED_GB GB for Docker; the kube context and the kubeconfig ($KUBE_FILES) recorded, compared at the end"
  echo "$PROGRAM: the prep (downloads only what isn't there: each tool sha256-checked, each image by its digest):"
  say_lines P "${prep[@]}"
  echo "$PROGRAM: the throwaway clone $W/clone (origin's main = $commit) and its tag v$version; OPAMP_SERVER_SRC=$W/opamp-server (github.com/telflo/opamp-server at v$opamp_version)"
  echo "$PROGRAM: the steps:"
  say_lines "" "${plan[@]}"
  if $keep; then
    echo "$PROGRAM: --keep: the registry, $W, the images and the builder kept at the end (rehearse.sh --cleanup --work $W removes them)"
  else
    echo "$PROGRAM: at the end: what the run made removed by name, $W's logs kept"
  fi
  exit 0
fi

# ---- A real run: the machine ------------------------------------------------------------------
if [ -z "${REHEARSE_CAFFEINATED:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -is env REHEARSE_CAFFEINATED=1 "$B" "$0" "${orig_args[@]}"
fi
if command -v pmset >/dev/null 2>&1; then
  power="$(pmset -g batt 2>/dev/null | sed -n "s/^Now drawing from '\\(.*\\)'.*/\\1/p" | head -n 1)"
  case "$power" in
    "AC Power") note "on AC power" ;;
    "Battery Power")
      $allow_battery || refuse "this Mac is on battery: plug it in (the rehearsal takes 1.5 to 2.5 hours), or pass --allow-battery; it keeps the machine awake itself (caffeinate -is)"
      note "on battery (--allow-battery): caffeinate -is can't stop a sleep on battery; keep the lid open" ;;
    *) note "the power source couldn't be read (pmset -g batt): carrying on" ;;
  esac
fi
[ -z "$(git_ status --porcelain 2>/dev/null)" ] \
  || fail "this checkout has changes or untracked files: a rehearsal is of the commit (commit or remove them first)"
docker_stub_config
docker_up || fail "Docker isn't running"
for tool in git jq python3 curl node npm helm kubectl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool isn't on PATH (docs/releasing.md, \"Rehearse a release on your machine\": the prerequisites)"
done
[ -d "$ROOT/telflo-core/node_modules" ] \
  || fail "telflo-core has no node_modules: run npm ci in telflo-core first (the static gates and the smokes' CLI need it)"
live="$(live_runs | sort -u)"
[ -z "$live" ] || refuse "a rehearsal is running now (its work folder and pid: $(printf '%s' "$live" | tr '\n' ';')): wait for it to end"
left=""
for name in $(docker ps -a --filter "name=$PREFIX-" --format '{{.Names}}' 2>/dev/null | grep -E "$NAME_RE"); do left="$left container:$name"; done
for name in $(docker volume ls --filter "name=$PREFIX-" --format '{{.Name}}' 2>/dev/null | grep -E "$NAME_RE"); do left="$left volume:$name"; done
for name in $(docker network ls --filter "name=$PREFIX-" --format '{{.Name}}' 2>/dev/null | grep -E "$NAME_RE"); do left="$left network:$name"; done
[ -z "$left" ] || refuse "an earlier run's$left is still there: scripts/release/rehearse.sh --cleanup --work <its folder> (it was kept, or that run stopped)"
# shellcheck disable=SC2086 # the ports, one argument each
busy="$(python3 -I -c '
import socket, sys
busy = []
for port in sys.argv[1:]:
    p = int(port)
    probe = socket.socket()
    probe.settimeout(0.3)
    try:
        probe.connect(("127.0.0.1", p))
        busy.append(port)
        continue
    except OSError:
        pass
    finally:
        probe.close()
    bind = socket.socket()
    try:
        bind.bind(("127.0.0.1", p))
    except OSError:
        busy.append(port)
    finally:
        bind.close()
print(" ".join(busy))
' $PORTS)" || fail "couldn't check the ports"
[ -z "$busy" ] || refuse "127.0.0.1's port(s) $busy, the rehearsal's (--port-base $port_base), are in use: stop what holds them, or name another --port-base"
host_free="$(df -Pk "$work_parent" 2>/dev/null | awk 'NR == 2 { print $4 }')"
[[ "$host_free" =~ ^[0-9]+$ ]] || fail "couldn't read the work folder's free disk"
[ "$host_free" -ge $((HOST_NEED_GB * 1024 * 1024)) ] \
  || fail "the work folder's disk has $((host_free / 1024 / 1024)) GB free: the rehearsal needs $HOST_NEED_GB GB there (the archives, about 4 GB, the clones, the unpacked layouts)"

# The kube context and the kubeconfig, before anything changes.
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi; }
mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
kube_files_state() {
  local f IFS=:
  for f in $KUBE_FILES; do
    if [ -f "$f" ]; then echo "file $f $(sha256_of "$f") $(mtime_of "$f")"; else echo "file $f absent"; fi
  done
}
kube_context() {
  if command -v kubectl >/dev/null 2>&1; then
    KUBECONFIG="$KUBE_FILES" kubectl config current-context 2>/dev/null || echo "(none)"
  else
    echo "(no kubectl)"
  fi
}
KUBE_CONTEXT_BEFORE="$(kube_context)"
KUBE_FILES_BEFORE="$(kube_files_state)"

# ---- The work folder, the log, the settings -----------------------------------------------------
started=$(date +%s)
mkdir -p "$W/logs" "$W/tmp" "$W/standins" "$W/collector-oci" "$W/collector-chart" "$W/collector" "$W/oci" "$W/release" || fail "can't make $W's folders"
chmod 700 "$W"
W="$(cd "$W" && pwd -P)"
LOG="$W/rehearse.log"
: >"$LOG"
STATE="$W/rehearse.state"
(umask 077 && printf '# rehearse.sh: what this run made (rehearse.sh --cleanup --work <this folder> reads it)\nwork %s\nversion %s\n' "$W" "$version" >"$STATE")
# The labels naming this run on the objects it starts (the marker volume, the registry).
OWN_WORK="$W"
OWN_STARTED="$(started_of $$)"
[ -n "$OWN_STARTED" ] || fail "this run's start time couldn't be read (ps -o lstart=)"
OWN_LABELS=(--label "$LABEL_WORK=$W" --label "$LABEL_PID=$$" --label "$LABEL_STARTED=$OWN_STARTED")
# record_loaded <ref>...: after a load step, each ref absent before the run
# and in the engine now, with its id (the line replaced when a later step of
# the run loads it again).
record_loaded() {
  local ref id
  for ref in "$@"; do
    awk -v r="$ref" '$1 == "absent" && $2 == r { found = 1 } END { exit !found }' "$STATE" || continue
    id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null)" || continue
    [[ "$id" =~ $TELFLO_OCI_DIGEST_RE ]] || continue
    (umask 077 && awk -v r="$ref" '!($1 == "image" && $2 == r)' "$STATE" >"$STATE.new" && mv "$STATE.new" "$STATE" \
      && printf 'image %s %s\n' "$ref" "$id" >>"$STATE")
  done
}
log() { printf '%s\n' "$1" | tee -a "$LOG"; }
for helper in osxkeychain desktop ecr-login; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/standins.log"\nexit 1\n' "$W" >"$W/standins/docker-credential-$helper"
  chmod 755 "$W/standins/docker-credential-$helper"
done
: >"$W/standins.log"
# The rehearsal's own settings only (nothing of the caller's shell reaches a gate or smoke).
for v in $(env | sed -nE 's/^((TELFLO|OPAMP|AWS|COMPOSE|PG)[A-Za-z0-9_]*|DATABASE_URL)=.*/\1/p'); do unset "$v"; done
unset CI
export PATH="$W/standins:$PATH"
export TMPDIR="$W/tmp"
export OPAMP_SERVER_SRC="$W/opamp-server"
export CHECK_GATEWAY_LOGS_CONTAINER="$PREFIX-gateway-logs" CHECK_GATEWAY_LOGS_PORT=$((port_base + 120))
export TELFLO_LOAD_IMAGES_NAME="$PREFIX-load-images"
log "$PROGRAM: $commit, version $version$($no_attest && echo ', NO attestations (--no-attest)'), port base $port_base; the work folder's disk: $((host_free / 1024 / 1024)) GB free"
log "$PROGRAM: kube context before: $KUBE_CONTEXT_BEFORE (kubeconfig: $KUBE_FILES)"

summary=()
n=0
status=0
steps_done=0
started_registry=""
marker_made=false
# run_step <name> <command...>: logged through redact.sh, timed, in the summary.
run_step() {
  local name="$1" step_log start seconds
  shift
  n=$((n + 1))
  step_log="$W/logs/$(printf '%02d' "$n")-$name.log"
  log "== $(printf '%02d' "$n") $name: $(printf '%q ' "$@")"
  start=$(date +%s)
  if [ "$name" = publish-notes ]; then
    (cd "$ROOT" && "$@") >"$W/release-notes.md" 2>"$step_log.raw"
    status=$?
    "$B" "$ROOT/scripts/gates/redact.sh" <"$step_log.raw" >"$step_log"
    rm -f "$step_log.raw"
  else
    (cd "$ROOT" && "$@") 2>&1 | "$B" "$ROOT/scripts/gates/redact.sh" >"$step_log"
    status=${PIPESTATUS[0]}
  fi
  seconds=$(($(date +%s) - start))
  cat "$step_log" >>"$LOG"
  summary+=("$(printf '%-34s %4s %6ss' "$name" "$status" "$seconds")")
  if [ -s "$W/standins.log" ]; then status=1; log "$PROGRAM: a docker credential helper was called during $name"; fi
  if [ "$status" -ne 0 ]; then
    log "$PROGRAM: FAIL at $name (exit $status): $step_log"
    return 1
  fi
  log "-- $name passed (${seconds}s)"
}
run_line() { # <line>: a prep or plan line, the registry's real address put in
  local line="$1" name cmd i
  name="${line%%$'\x1f'*}"
  IFS=$'\x1f' read -r -a cmd <<<"${line#*$'\x1f'}"
  for i in "${!cmd[@]}"; do [ "${cmd[i]}" != "127.0.0.1:<port>" ] || cmd[i]="$registry"; done
  run_step "$name" "${cmd[@]}"
}

# The end, whatever happened (an EXIT trap): the summary, the removal or
# the kept list, the kube check.
# shellcheck disable=SC2329 # run by the EXIT trap
finish() {
  local rc=$? redacted total kube_after_context kube_after_files kube_ok=true r
  trap - EXIT
  [ "$rc" -ne 0 ] || [ "$steps_done" -eq "${#plan[@]}" ] || rc=1
  redacted="$(grep -c REDACTED "$LOG" 2>/dev/null || true)"
  [ -n "$redacted" ] || redacted=0
  removed=()
  kept=()
  if $keep; then
    # The marker only says "a run is going on": removed even so.
    if [ "$marker_made" = true ] && ! other_run volume "$MARKER"; then try_remove "volume $MARKER (this run's marker)" docker volume rm "$MARKER"; fi
    [ -z "$started_registry" ] || kept+=("the registry $started_registry on $registry")
    kept+=("the work folder $W (archives, clones, logs)")
    while read -r kind value extra; do
      case "$kind" in
        image) docker image inspect "$value" >/dev/null 2>&1 && kept+=("image $value") ;;
        builder) [ "$extra" != made ] || kept+=("the builder $value (buildx_buildkit_${value}0)") ;;
      esac
    done <"$STATE"
  else
    remove_named
    remove_recorded "$STATE"
    cd "$W" || exit 1
    for entry in * .[!.]*; do
      [ -e "$entry" ] || continue
      case "$entry" in
        rehearse.log | logs | summary.txt | release-notes.md | rehearse.state) ;;
        static)
          for inner in static/* static/.[!.]*; do
            [ -e "$inner" ] || continue
            case "$inner" in static/logs | static/summary.txt) ;; *) rm -rf "$inner" ;; esac
          done ;;
        *) rm -rf "$entry" ;;
      esac
    done
    cd / || exit 1
    removed+=("everything in $W but its logs")
  fi
  total=$(($(date +%s) - started))
  kube_after_context="$(kube_context)"
  kube_after_files="$(kube_files_state)"
  {
    echo ""
    echo "step                               exit   time"
    for r in ${summary[@]+"${summary[@]}"}; do echo "$r"; done
    echo "$PROGRAM: total $((total / 3600)) h $((total % 3600 / 60)) min ($total s); $steps_done of ${#plan[@]} steps passed"
    echo "$PROGRAM: secret-shaped lines (redact.sh's marker) in $LOG: $redacted (must be 0)"
    if [ "$kube_after_context" = "$KUBE_CONTEXT_BEFORE" ]; then
      echo "$PROGRAM: kube context unchanged: $kube_after_context"
    else
      echo "$PROGRAM: FAIL: the kube context changed: $KUBE_CONTEXT_BEFORE before, $kube_after_context now"
    fi
    if [ "$kube_after_files" = "$KUBE_FILES_BEFORE" ]; then
      echo "$PROGRAM: kubeconfig unchanged (sha256 and mtime): $KUBE_FILES"
    else
      echo "$PROGRAM: FAIL: the kubeconfig changed (sha256, mtime or presence): $KUBE_FILES"
    fi
    if [ "${#removed[@]}" -gt 0 ]; then echo "$PROGRAM: removed:"; for r in "${removed[@]}"; do echo "  - $r"; done; fi
    if [ "${#kept[@]}" -gt 0 ]; then
      echo "$PROGRAM: kept (--keep):"; for r in "${kept[@]}"; do echo "  - $r"; done
      echo "$PROGRAM: remove them with: scripts/release/rehearse.sh --cleanup --work $W"
    else
      echo "$PROGRAM: kept: $W's logs (rehearse.log, logs/, summary.txt)"
    fi
    echo "$PROGRAM: kept for the next run: the private tools (.tools/ and tools.lock's images: scripts/release/tools.sh remove deletes them)"
  } >"$W/summary.txt"
  tee -a "$LOG" <"$W/summary.txt"
  [ -z "$pre_docker" ] || rm -rf "$pre_docker"
  [ "$kube_after_context" = "$KUBE_CONTEXT_BEFORE" ] && [ "$kube_after_files" = "$KUBE_FILES_BEFORE" ] || kube_ok=false
  $kube_ok || rc=1
  [ "$redacted" -eq 0 ] || { log "$PROGRAM: FAIL: secret-shaped text reached the output ($redacted lines)"; rc=1; }
  if [ "$rc" -eq 0 ]; then
    log "$PROGRAM: PASS: every step of the release rehearsed against $registry; notes in $W/release-notes.md"
  else
    log "$PROGRAM: FAIL (exit $rc): the summary is $W/summary.txt, each step's log is in $W/logs/"
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT TERM HUP

# The marker: a volume labelled with this run's work folder, pid and start,
# so another run refuses to start and --cleanup refuses to remove anything
# while this one runs.
docker volume create "${OWN_LABELS[@]}" "$MARKER" >/dev/null || { log "$PROGRAM: FAIL: the marker volume $MARKER couldn't be made"; exit 1; }
[ "$(live_holder "$(labels_of volume "$MARKER")")" = "$W $$" ] \
  || { log "$PROGRAM: FAIL: the volume $MARKER names another run (one that started at the same moment?): nothing done"; exit 1; }
marker_made=true
log "$PROGRAM: the marker volume $MARKER names this run (pid $$)"

# ---- The prep: the private tools and tools.lock's images ---------------------------------------
for line in "${prep[@]}"; do
  run_line "$line" || exit 1
  if [ "${line%%$'\x1f'*}" = prep-pull-registry ]; then
    disk="$(docker run --rm --pull never --network none --entrypoint df "$("$B" "$TOOLS" ref registry)" -Pk / 2>/dev/null | awk 'NR == 2 { print $4 }')"
    [[ "$disk" =~ ^[0-9]+$ ]] || { log "$PROGRAM: FAIL: couldn't read Docker's free disk"; exit 1; }
    log "$PROGRAM: Docker's disk: $((disk / 1024 / 1024)) GB free"
    [ "$disk" -ge $((DOCKER_NEED_GB * 1024 * 1024)) ] \
      || { log "$PROGRAM: FAIL: Docker's disk has $((disk / 1024 / 1024)) GB free: the rehearsal needs $DOCKER_NEED_GB GB (about 20 GB of images, builder cache and a kind node, and room for the rest of the engine)"; exit 1; }
  fi
done
"$B" "$TOOLS" docker-config "$W/docker" >/dev/null || { log "$PROGRAM: FAIL: tools.sh docker-config failed"; exit 1; }
export DOCKER_CONFIG="$W/docker"
export HELM_REGISTRY_CONFIG="$W/docker/config.json"
rm -rf "$pre_docker"
pre_docker=""
# The images the smokes run by tag: local already (never pulled or re-tagged here).
missing=""
for image in postgres:18 axllent/mailpit:v1.31; do docker image inspect "$image" >/dev/null 2>&1 || missing="$missing $image"; done
docker image inspect --format '{{join .RepoDigests " "}}' nginx:1.27-alpine 2>/dev/null | tr ' ' '\n' | grep -qx "nginx@$nginx_digest" \
  || missing="$missing nginx:1.27-alpine@$nginx_digest"
docker image inspect --format '{{join .RepoDigests " "}}' "ghcr.io/telflo/opamp-server:$opamp_version" 2>/dev/null | tr ' ' '\n' | grep -qx "ghcr.io/telflo/opamp-server@$opamp_digest" \
  || missing="$missing ghcr.io/telflo/opamp-server:$opamp_version@$opamp_digest"
[ -z "$missing" ] || { log "$PROGRAM: FAIL: the smokes run these images by tag and they aren't local:$missing (pull each by that digest and tag it so; the rehearsal never re-tags)"; exit 1; }

# What the run may add to the engine, recorded before it does (rehearse.state).
if docker container inspect "buildx_buildkit_${BUILDER}0" >/dev/null 2>&1; then
  echo "builder $BUILDER existed" >>"$STATE"
else
  echo "builder $BUILDER made" >>"$STATE"
fi
# Images absent now that the run's loads may add: each recorded with its id
# right after the step that loads it (record_loaded), and removed at the end
# only while that id is still theirs.
for image in $IMAGES; do
  docker image inspect "ghcr.io/telflo/telflo/$image:$version" >/dev/null 2>&1 || echo "absent ghcr.io/telflo/telflo/$image:$version" >>"$STATE"
done
for v in $offered; do
  docker image inspect "ghcr.io/telflo/telflo/collector:$v" >/dev/null 2>&1 || echo "absent ghcr.io/telflo/telflo/collector:$v" >>"$STATE"
done

if [ -z "$registry" ]; then
  port="$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')" || { log "$PROGRAM: FAIL: no free port"; exit 1; }
  docker run -d --name "$REGISTRY_NAME" "${OWN_LABELS[@]}" --pull never -p "127.0.0.1:$port:5000" "$("$B" "$TOOLS" ref registry)" >/dev/null \
    || { log "$PROGRAM: FAIL: the registry didn't start"; exit 1; }
  started_registry="$REGISTRY_NAME"
  registry="127.0.0.1:$port"
  for _ in $(seq 1 100); do curl -fsS -o /dev/null "http://$registry/v2/" 2>/dev/null && break; sleep 0.2; done
  curl -fsS -o /dev/null "http://$registry/v2/" 2>/dev/null || { log "$PROGRAM: FAIL: the registry at $registry didn't answer"; exit 1; }
  log "$PROGRAM: the throwaway registry $REGISTRY_NAME on $registry"
fi

# The throwaway clone: its origin's main is HEAD, and the tag is made there only.
git clone -q --bare --no-local "$ROOT" "$W/origin.git" || { log "$PROGRAM: FAIL: cloning $ROOT failed"; exit 1; }
git -C "$W/origin.git" update-ref refs/heads/main "$commit" || { log "$PROGRAM: FAIL: setting the throwaway origin's main failed"; exit 1; }
git clone -q --no-local "$W/origin.git" "$W/clone" || { log "$PROGRAM: FAIL: cloning the throwaway origin failed"; exit 1; }
git -C "$W/clone" -c user.name=rehearse -c user.email=rehearse@telflo.invalid -c tag.gpgSign=false \
  tag -a "v$version" -m "Telflo $version (rehearsal)" "$commit" || { log "$PROGRAM: FAIL: tagging the throwaway clone failed"; exit 1; }
git clone -q --branch "v$opamp_version" https://github.com/telflo/opamp-server.git "$W/opamp-server" >/dev/null 2>&1 \
  || { log "$PROGRAM: FAIL: cloning github.com/telflo/opamp-server at v$opamp_version failed"; exit 1; }
log "$PROGRAM: the clone $W/clone (tag v$version on $commit), the opamp-server at v$opamp_version"

# ---- The steps.
for line in "${plan[@]}"; do
  step_status=0
  run_line "$line" || step_status=1
  case "${line%%$'\x1f'*}" in
    collector-load-*) name="${line%%$'\x1f'*}"; record_loaded "ghcr.io/telflo/telflo/collector:${name#collector-load-}" ;;
    smokes-load) for image in $IMAGES; do record_loaded "ghcr.io/telflo/telflo/$image:$version"; done ;;
    smokes-load-collector) record_loaded "ghcr.io/telflo/telflo/collector:$collector_default" ;;
  esac
  [ "$step_status" -eq 0 ] || exit 1
  steps_done=$((steps_done + 1))
done
exit 0
