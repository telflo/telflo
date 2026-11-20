#!/usr/bin/env bash
# static.sh: the full suite's static gates (docs/conventions/testing.md,
# "CI gates"), one at a time.
#
#   bash scripts/gates/static.sh [--tree <dir>] --work <dir> [--redact-literals <file>] [--discovered-only]
#   bash scripts/gates/static.sh [--tree <dir>] --list [--discovered-only]
#
# The gates, in this order:
#   1. the fixed list, in testing.md's order: naming, licenses, the collector
#      image's entrypoint and build-script tests, the supervisor-collector
#      chart's render tests, the opamp-server's pin check, typecheck (root,
#      web), lint, the web's build, cli-build, cli-package (`--keep
#      <work>/cli`: the install the stack smoke's TELFLO_SMOKE_CLI names), the
#      gateway's log check, the platform chart's render tests, the
#      cloud-neutral check, the analytics-key check;
#   2. every scripts/**/*.test.sh it finds, sorted, then every
#      scripts/release/check-*.sh (not *.test.sh), sorted: a new check or
#      self-test joins the static gates in the commit that adds it.
#      (Every scripts/release/check-*.sh runs offline from the tree's root
#      with no argument; one that needs more is a verify-*.sh.)
# --discovered-only runs part 2 only (for static.test.sh's fixtures).
#
# <work> must be new or empty. Before any gate, DOCKER_CONFIG is <work>'s
# docker-config/ (holding {"auths":{"telflo-gates.invalid":{}}}, no login)
# and refusing docker-credential-* stand-ins are first on PATH; a call to
# one fails the run (the gate `credential-helpers`). TMPDIR is <work>/tmp.
# Each gate's output goes through redact.sh (with --redact-literals' file,
# when given) into <work>/logs/<gate>.log, its exit code into
# <work>/static.codes; a summary table (gate, exit, seconds, REDACTED lines)
# follows the gates and is kept in <work>/summary.txt. Then, for each gate
# that failed, its FAIL and `not ok` lines (the first 40) and its log's last
# 40 lines, from that redacted log, so a runner's job output says why (the
# logs stay in <work>/logs). Exit 0 only if every gate passed; 1 otherwise;
# 2 usage.
#
# The settings the gates read come from the caller's environment (e.g.
# OPAMP_SERVER_SRC for the pin check, CHECK_GATEWAY_LOGS_CONTAINER and
# CHECK_GATEWAY_LOGS_PORT for the gateway's log check; the test settings for
# anything that reads telflo-core/.env otherwise). On macOS the run keeps the
# machine awake (caffeinate -is). bash 3.2 compatible.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
usage() {
  sed -n 's/^#   bash scripts\/gates\/static\.sh /static.sh /p' "$0" >&2
  exit 2
}

tree="" work="" list=0 discovered_only=0 literals=""
orig_args=("$@")
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tree) [ "$#" -ge 2 ] || usage; tree=$2; shift 2 ;;
    --work) [ "$#" -ge 2 ] || usage; work=$2; shift 2 ;;
    --redact-literals) [ "$#" -ge 2 ] || usage; literals=$2; shift 2 ;;
    --list) list=1; shift ;;
    --discovered-only) discovered_only=1; shift ;;
    *) echo "static.sh: unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$tree" ] || tree="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -d "$tree/scripts" ] || { echo "static.sh: --tree $tree has no scripts/" >&2; exit 2; }
tree="$(cd "$tree" && pwd)"
if [ "$list" = 0 ]; then
  [ -n "$work" ] || usage
  case "$work" in /*) ;; *) echo "static.sh: --work must be an absolute path" >&2; exit 2 ;; esac
  if [ -e "$work" ] && [ -n "$(ls -A "$work" 2>/dev/null)" ]; then
    echo "static.sh: --work $work isn't empty: use a new folder" >&2; exit 2
  fi
  [ -z "$literals" ] || [ -r "$literals" ] || { echo "static.sh: --redact-literals names no readable file" >&2; exit 2; }
  if [ -z "${STATIC_CAFFEINATED:-}" ] && command -v caffeinate >/dev/null 2>&1; then
    exec caffeinate -is env STATIC_CAFFEINATED=1 "$BASH" "$0" "${orig_args[@]}"
  fi
fi

# The platform chart's folder.
platform_chart=charts/telflo

FIXED="naming licenses collector-entrypoint collector-build-script supervisor-chart-render opamp-server-pin typecheck typecheck-web lint web-build cli-build cli-package gateway-logs platform-chart-render chart-cloud-neutral analytics-key"

# gate <name>: sets G_DIR (relative to the tree) and G_CMD for a fixed gate.
gate() {
  G_DIR=.
  case "$1" in
    naming) G_CMD=(bash scripts/check-naming.sh) ;;
    licenses) G_DIR=telflo-core; G_CMD=(npm run check:licenses) ;;
    collector-entrypoint) G_CMD=(bash docker/collector-image/entrypoint_test.sh) ;;
    collector-build-script) G_CMD=(bash docker/collector-image/build-collector-image_test.sh) ;;
    supervisor-chart-render) G_CMD=(bash charts/supervisor-collector/tests/render-tests.sh) ;;
    opamp-server-pin) G_CMD=(bash scripts/check-opamp-server-pin.sh) ;;
    typecheck) G_DIR=telflo-core; G_CMD=(npm run typecheck) ;;
    typecheck-web) G_DIR=telflo-core; G_CMD=(npm run typecheck --workspace=@telflo/web) ;;
    lint) G_DIR=telflo-core; G_CMD=(npm run lint) ;;
    web-build) G_DIR=telflo-core/apps/web; G_CMD=(npm run build) ;;
    cli-build) G_DIR=telflo-core; G_CMD=(npm run build -w @telflo/cli) ;;
    cli-package) G_CMD=(bash scripts/check-cli-package.sh --keep "${work:-<work>}/cli") ;;
    gateway-logs) G_CMD=(bash scripts/check-gateway-logs.sh) ;;
    platform-chart-render) G_CMD=(bash "$platform_chart/tests/render-tests.sh") ;;
    chart-cloud-neutral) G_CMD=(bash scripts/check-chart-cloud-neutral.sh) ;;
    analytics-key) G_CMD=(bash scripts/check-no-analytics-key.sh "$tree") ;;
    *) return 1 ;;
  esac
}

# The discovered gates' paths, relative to the tree, sorted.
discovered() {
  (
    cd "$tree" || exit 1
    find scripts -name node_modules -prune -o -type f -name '*.test.sh' -print | LC_ALL=C sort
    [ ! -d scripts/release ] ||
      find scripts/release -maxdepth 1 -type f -name 'check-*.sh' ! -name '*.test.sh' -print | LC_ALL=C sort
  )
}
# A discovered gate's name: its path under scripts/, '/' as '-', no .sh.
gate_name() { local p=${1#scripts/}; p=${p%.sh}; printf '%s' "$p" | tr '/' '-'; }

NAMES=()
PATHS=()
if [ "$discovered_only" = 0 ]; then
  for name in $FIXED; do NAMES+=("$name"); PATHS+=(""); done
fi
while IFS= read -r path; do
  [ -n "$path" ] || continue
  NAMES+=("$(gate_name "$path")")
  PATHS+=("$path")
done <<EOF
$(discovered)
EOF
[ "${#NAMES[@]}" -gt 0 ] || { echo "static.sh: no gates found" >&2; exit 2; }

set_gate() { # <index>: G_DIR, G_CMD
  if [ -n "${PATHS[$1]}" ]; then G_DIR=.; G_CMD=(bash "${PATHS[$1]}"); else gate "${NAMES[$1]}"; fi
}

if [ "$list" = 1 ]; then
  i=0
  while [ "$i" -lt "${#NAMES[@]}" ]; do
    set_gate "$i"
    printf '%-40s (cd %s && %s)\n' "${NAMES[$i]}" "$G_DIR" "${G_CMD[*]}"
    i=$((i + 1))
  done
  exit 0
fi

# --- the run --------------------------------------------------------------------
umask 077
mkdir -p "$work/logs" "$work/tmp" "$work/bin" "$work/docker-config" || { echo "static.sh: cannot make $work" >&2; exit 1; }
work="$(cd "$work" && pwd)"
printf '{"auths":{"telflo-gates.invalid":{}}}\n' >"$work/docker-config/config.json"
export DOCKER_CONFIG="$work/docker-config"
: >"$work/helper.log"
for helper in osxkeychain desktop ecr-login; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$work" >"$work/bin/docker-credential-$helper"
  chmod 755 "$work/bin/docker-credential-$helper"
done
export PATH="$work/bin:$PATH"
export TMPDIR="$work/tmp"
codes="$work/static.codes"
: >"$codes"
redact=(bash "$SCRIPT_DIR/redact.sh")
[ -z "$literals" ] || redact+=(--literals "$literals")

echo "static.sh: $((${#NAMES[@]})) gates on $tree$(git -C "$tree" rev-parse --short HEAD >/dev/null 2>&1 && printf ' (HEAD %s, %s uncommitted paths)' "$(git -C "$tree" rev-parse --short HEAD)" "$(git -C "$tree" status --porcelain 2>/dev/null | wc -l | tr -d ' ')")"
SECONDS_LIST=()
i=0
while [ "$i" -lt "${#NAMES[@]}" ]; do
  name=${NAMES[$i]}
  set_gate "$i"
  log="$work/logs/$name.log"
  start=$(date +%s)
  printf '%s %s: (cd %s && %s)\n' "$(date '+%F %T')" "$name" "$G_DIR" "${G_CMD[*]}"
  { printf '=== %s: (cd %s && %s)\n' "$name" "$G_DIR" "${G_CMD[*]}"
    ( cd "$tree/$G_DIR" && "${G_CMD[@]}" ) </dev/null 2>&1
    rc=$?
    printf '=== %s: exit %s\n' "$name" "$rc"
    exit "$rc"
  } | "${redact[@]}" >"$log"
  rc=${PIPESTATUS[0]}
  SECONDS_LIST+=("$(($(date +%s) - start))")
  printf '%s %s\n' "$name" "$rc" >>"$codes"
  i=$((i + 1))
done

# A call to a credential helper's stand-in fails the run.
if [ -s "$work/helper.log" ]; then
  printf '%s %s\n' credential-helpers 1 >>"$codes"
else
  printf '%s %s\n' credential-helpers 0 >>"$codes"
fi
SECONDS_LIST+=(0)

status=0
{
  printf '%-40s %5s %8s %9s\n' gate exit seconds redacted
  i=0
  while read -r name rc; do
    redacted=0
    [ ! -f "$work/logs/$name.log" ] || redacted=$(grep -c REDACTED "$work/logs/$name.log")
    printf '%-40s %5s %8s %9s\n' "$name" "$rc" "${SECONDS_LIST[$i]}" "$redacted"
    i=$((i + 1))
  done <"$codes"
} >"$work/summary.txt"
cat "$work/summary.txt"
failed=$(awk '$2 != 0 { print $1 }' "$codes" | tr '\n' ' ')
if [ -n "$failed" ]; then
  for name in $failed; do
    [ -f "$work/logs/$name.log" ] || continue
    echo "--- $name: its FAIL lines (the first 40), then its log's last 40 lines (redacted)"
    grep -E '^(FAIL|not ok)([^A-Za-z]|$)' "$work/logs/$name.log" | head -n 40 | sed 's/^/  | /'
    echo "  | ..."
    tail -n 40 "$work/logs/$name.log" | sed 's/^/  | /'
  done
  echo "static.sh: FAILED: $failed(logs in $work/logs)"
  status=1
else
  echo "static.sh: every gate passed"
fi
exit "$status"
