#!/bin/bash
# Tests for scripts/release/rehearse.sh, offline: nothing is built, started,
# pulled or pushed, and the real Docker engine, kubeconfig and power source
# are never asked.
#   1. On this checkout, --dry-run only: the refusals before anything runs,
#      and the plan (the workflows' order, every registry a loopback one).
#   2. On a throwaway copy of the repository (a clean git repository holding
#      rehearse.sh, the files it reads and a stand-in for every script it
#      calls), real runs with stand-ins first on PATH for docker, kubectl,
#      pmset and caffeinate, a fixture kubeconfig (TELFLO_REHEARSE_KUBECONFIG,
#      the script's test-only setting), HOME a folder of the test (git's
#      url.insteadOf points the opamp-server clone at a local repository):
#      battery, low disk, a developer's own project or port, an earlier run's
#      leftovers, a kube context or kubeconfig changed during a run, a step
#      failing, --keep, --cleanup removing only its own names (and images
#      only while their recorded ids hold), a running rehearsal's labels
#      (another run and --cleanup refused; a finishing run leaving its
#      objects alone), Docker's configuration from the first call on, and
#      the dry run showing the prep without doing it.
# Run:  bash scripts/release/rehearse.test.sh   (bash 3.2 compatible)
set -u
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)" || exit 1; export TMPDIR
unset GITHUB_ACTIONS CI REHEARSE_CAFFEINATED
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/release/rehearse.sh"
shell="${BASH:-bash}"

failures=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/rehearse-test.XXXXXX")" || exit 1
tmp="$(cd "$tmp" && pwd -P)"
trap 'cd / && rm -rf "$tmp"' EXIT
version="$(sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$root/charts/telflo/Chart.yaml")"
version_re="$(printf '%s' "$version" | sed 's/\./\\./g')"  # the version as an ERE, its dots literal
run() { out="$(env -u TELFLO_REHEARSE_KUBECONFIG "$shell" "$script" "$@" 2>&1)"; rc=$?; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }

# --- 1. refusals ----------------------------------------------------------------------------
run
check "no arguments: usage (exit 2)" "[ $rc -eq 2 ] && has 'usage: scripts/release/rehearse.sh'"
run --version "$version" --work "$tmp/w" --bogus
check "an unknown argument: usage (exit 2)" "[ $rc -eq 2 ] && has 'unknown argument: --bogus'"
for bad in 0.1 v0.1.0 0.1.0-rc.1 01.0.0 ""; do
  run --version "$bad" --work "$tmp/w"
  check "--version '$bad': refused (exit 2)" "[ $rc -eq 2 ] && has '--version must be x.y.z'"
done
run --version "$version" --work relative/w
check "a relative --work: refused (exit 2)" "[ $rc -eq 2 ] && has '--work must be an absolute path'"
mkdir -p "$tmp/full"; : >"$tmp/full/x"
run --version "$version" --work "$tmp/full"
check "a --work that isn't empty: refused (exit 2)" "[ $rc -eq 2 ] && has \"isn't empty\""
run --version "$version" --work "$root/scripts/rehearse-work"
check "a --work inside the tree: refused (exit 2)" "[ $rc -eq 2 ] && has 'outside this tree' && [ ! -e '$root/scripts/rehearse-work' ]"
for bad in ghcr.io ghcr.io:443 docker.io 10.0.0.1:5000 registry.invalid:5000 127.0.0.1 "127.0.0.1:0"; do
  run --version "$version" --work "$tmp/w" --registry "$bad" --dry-run
  check "--registry '$bad': refused, never a push target here (exit 2)" "[ $rc -eq 2 ] && has 'a rehearsal never pushes to GHCR'"
done
out="$(env GITHUB_ACTIONS=true "$shell" "$script" --version "$version" --work "$tmp/w" --dry-run 2>&1)"; rc=$?
check "in a GitHub Actions job: refused (exit 2)" "[ $rc -eq 2 ] && has 'never in a GitHub Actions job'"
for ci in true 1 yes; do
  out="$(env CI="$ci" TELFLO_REHEARSE_KUBECONFIG="$tmp/kubeconfig" "$shell" "$script" --version "$version" --work "$tmp/w" --dry-run 2>&1)"; rc=$?
  check "the test-only TELFLO_REHEARSE_KUBECONFIG with CI=$ci: refused (exit 2)" "[ $rc -eq 2 ] && has \"a test's setting: never with CI set\""
done
out="$(env CI=true TELFLO_REHEARSE_KUBECONFIG= "$shell" "$script" --version "$version" --work "$tmp/w" --dry-run 2>&1)"; rc=$?
check "TELFLO_REHEARSE_KUBECONFIG named but empty, with CI: refused too (exit 2)" "[ $rc -eq 2 ]"
for pb in 58022 51020 7970 52890 51134 50079 1023 65401 abc 0; do
  run --version "$version" --work "$tmp/w" --port-base "$pb" --dry-run
  check "--port-base $pb (a developer's own stack's port among the rehearsal's, or out of range): refused (exit 2)" \
    "[ $rc -eq 2 ] && { has \"one a developer's own development stack or dev servers use\" || has '--port-base must be a number'; }"
done
for p in telflo telflo-dev telflo-platform; do
  out="$(env COMPOSE_PROJECT_NAME="$p" "$shell" "$script" --version "$version" --work "$tmp/w" --dry-run 2>&1)"; rc=$?
  check "COMPOSE_PROJECT_NAME=$p (a developer's own stack's): refused (exit 2)" "[ $rc -eq 2 ] && has 'COMPOSE_PROJECT_NAME is $p'"
done
run --version 9.9.9 --work "$tmp/w" --dry-run
check "a --version that isn't HEAD's Chart.yaml's: refused (exit 1)" "[ $rc -eq 1 ] && has \"--version must be both\""
run --cleanup --work "$tmp/full"
check "--cleanup on a folder without rehearse.state: refused (exit 2), nothing removed" "[ $rc -eq 2 ] && has 'holds no rehearse.state' && [ -f '$tmp/full/x' ]"
run --cleanup --work "$tmp/full" --keep
check "--cleanup with another option: usage (exit 2)" "[ $rc -eq 2 ] && has '--cleanup takes --work <dir> only'"
run --cleanup --work relative
check "--cleanup with a relative --work: usage (exit 2)" "[ $rc -eq 2 ]"

# --- 1. the plan ----------------------------------------------------------------------------
run --version "$version" --work "$tmp/w" --registry 127.0.0.1:5999 --dry-run
plan="$out"
check "--dry-run: exit 0, nothing started, the work folder not made" "[ $rc -eq 0 ] && has 'nothing is started' && [ ! -e '$tmp/w' ]"
pos() { printf '%s\n' "$plan" | grep -nE "^[0-9]+ $1:" | head -n 1 | cut -d: -f1; }
order_ok=true
last=0
for s in collector-builder 'collector-build-[0-9.]+' collector-chart version-tag version-collectors version-collector-archive static build-builder build-api package-chart package-archive package-files smokes-load stack-smoke archive-smoke kind-smoke publish-images publish-chart publish-pull-back publish-collectors publish-digests publish-notes finalize-promote finalize-pull-back finalize-collectors; do
  p="$(pos "$s")"
  if [ -z "$p" ] || [ "$p" -le "$last" ]; then order_ok=false; echo "     (order: $s at '${p:-none}' after $last)"; fi
  last="${p:-$last}"
done
check "the steps in the workflows' order: the collector path (its builder first), version, static, build, package, the three smokes, the stage, its record and notes, then finalize" "$order_ok"
check "the stage pushes and pulls back --namespace telflo-staging; finalize promotes from its digests.txt, then pulls back the public tags by those digests" \
  "printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ publish-images: [^ ]*bash scripts/publish-platform-images\.sh --push-oci $tmp/w/oci --registry 127\.0\.0\.1:5999 --namespace telflo-staging\$' \
   && printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ publish-chart: .* --registry 127\.0\.0\.1:5999 --namespace telflo-staging\$' \
   && printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ publish-pull-back: .* --namespace telflo-staging\$' \
   && printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ publish-digests: [^ ]*bash scripts/release/steps\.sh digests --oci $tmp/w/oci --version $version --chart $tmp/w/release/telflo-$version\.tgz --out $tmp/w/digests\.txt --registry 127\.0\.0\.1:5999\$' \
   && printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ finalize-promote: [^ ]*bash scripts/release/promote\.sh --version $version --digests $tmp/w/digests\.txt --registry 127\.0\.0\.1:5999\$' \
   && printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ finalize-pull-back: [^ ]*bash scripts/release/pull-back\.sh --digests $tmp/w/digests\.txt --version $version --registry 127\.0\.0\.1:5999 --namespace telflo\$'"
check "the three smokes run through steps.sh (their output through redact.sh, as release.yml calls them), never a smoke script directly" \
  "printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ stack-smoke: [^ ]*bash scripts/release/steps\.sh stack-smoke --version $version ' \
   && printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ archive-smoke: [^ ]*bash scripts/release/steps\.sh archive-smoke --version $version --release $tmp/w/release --work $tmp/w/archive-smoke --project telflo-rehearse-archive --http-port [0-9]+ --agent-port [0-9]+ --mailpit-port [0-9]+\$' \
   && printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ kind-smoke: [^ ]*bash scripts/release/steps\.sh kind-smoke --version $version --release $tmp/w/release --work $tmp/w/kind-smoke --profile telflo-rehearse-kind --port [0-9]+ --mailpit-port [0-9]+ --api-port [0-9]+\$' \
   && ! printf '%s\n' \"\$plan\" | grep -qE 'smoke-(compose-install|kind|test-stack)\.sh'"
check "version-tag, run from the clone, alone is told the checkout's .tools (no export to the steps)" \
  "printf '%s\n' \"\$plan\" | grep -E '^[0-9]+ version-tag: env TELFLO_TOOLS_DIR=' | grep -qF -- '/.tools ' && [ \$(printf '%s\n' \"\$plan\" | grep -c 'TELFLO_TOOLS_DIR=') -eq 1 ]"
offered_n="$("$shell" "$root/scripts/build-collector-image.sh" --list-offered | grep -c '')"
check "every offered collector version built, loaded, tested, pushed and pulled back" \
  "[ \$(printf '%s\n' \"\$plan\" | grep -cE '^[0-9]+ collector-(build|load|test|push|pull-back)-') -eq $((offered_n * 5)) ]"
check "every registry the plan names is the loopback one given (no ghcr.io, no other)" \
  "! printf '%s\n' \"\$plan\" | grep -E '^[0-9]+ ' | grep -qE 'ghcr\\.io|--registry (\\\\?[^1\\\\]|1[^2])' && [ \$(printf '%s\n' \"\$plan\" | grep -c -- '--registry 127.0.0.1:5999') -ge 8 ]"
check "every push, pull-back and registry read carries --registry 127.0.0.1:5999" \
  "! printf '%s\n' \"\$plan\" | grep -E -- '--push-oci|--push-package|pull-back\\.sh|verify-tag\\.sh|verify-collector-artifacts\\.sh|collector-archive|chart-if-new|promote\\.sh|steps\\.sh digests' | grep -qv -- '--registry 127.0.0.1:5999'"
check "the tag is verified in the throwaway clone, with --expect HEAD" \
  "printf '%s\n' \"\$plan\" | grep -qE '^[0-9]+ version-tag: env TELFLO_TOOLS_DIR=[^ ]*/\.tools [^ ]*bash $tmp/w/clone/scripts/release/verify-tag.sh v$version --registry 127.0.0.1:5999 --expect $(git -C "$root" rev-parse HEAD)\$'"
check "without --no-attest, no step builds or checks without attestations" "! has '--no-attest'"
check "no GitHub Release, no login" "! printf '%s\n' \"\$plan\" | grep -qE 'github-release|helm-login|docker login|registry login'"
check "the prep: tools.sh fetch, then tools.lock's images pulled, registry first" \
  "printf '%s\n' \"\$plan\" | grep -qE '^P01 prep-tools: [^ ]*bash scripts/release/tools.sh fetch\$' \
   && printf '%s\n' \"\$plan\" | grep -qE '^P02 prep-pull-registry: [^ ]*bash scripts/release/tools.sh pull registry\$' \
   && [ \$(printf '%s\n' \"\$plan\" | grep -cE '^P[0-9]+ prep-pull-(registry|buildkit|syft-scanner|kind-node|postgres|mailpit): ') -eq 6 ]"
check "the dry run names the checks of a real run (power, disk, ports, kube)" \
  "has 'the power source (pmset' && has 'GB for Docker' && has 'kubeconfig' && has 'ports'"
run --version "$version" --work "$tmp/w" --dry-run --no-attest
check "--no-attest: on every build and pull-back, and said" \
  "[ $rc -eq 0 ] && has 'no attestations' && [ \$(printf '%s\n' \"\$out\" | grep -E '^[0-9]+ (collector-build-|build-(api|web|otelcol|ottl)|collector-pull-back|publish-pull-back|finalize-pull-back)' | grep -vc -- '--no-attest') -eq 0 ]"
run --version "$version" --work "$tmp/w" --dry-run
check "without --registry: the registry it starts, on 127.0.0.1" "[ $rc -eq 0 ] && has '--registry 127.0.0.1:\\<port\\>'"
run --version "$version" --work "$tmp/w" --dry-run --port-base 41000
check "--port-base: the smokes' ports follow it" \
  "[ $rc -eq 0 ] && has '--port-base 41000' && has '--http-port 41100' && has '--agent-port 41101' && has '--mailpit-port 41102' \
   && has '--port 41110' && has '--mailpit-port 41111' && has '--api-port 41112' && has ' 41120'"

# --- 2. real runs on a throwaway copy with stand-ins -----------------------------------------
copy="$tmp/repo"
sd="$tmp/standin"      # the stand-ins' state and logs
sb="$tmp/standin-bin"  # docker, kubectl, pmset, caffeinate
mkdir -p "$copy" "$sb" "$tmp/home" "$tmp/kube"
for f in scripts/release/rehearse.sh scripts/release/version.sh scripts/release/oci.sh scripts/release/tools.lock \
  scripts/gates/redact.sh catalog/distributions/otelcol-contrib.json vendor/opamp-server/PIN \
  charts/telflo/Chart.yaml charts/telflo/values.yaml; do
  mkdir -p "$copy/$(dirname "$f")"
  cp "$root/$f" "$copy/$f"
done
# Every script the prep and the steps call: it logs its name and arguments,
# runs $STANDIN_DIR/hook-<name> (sourced) and fails if fail-<name> exists.
for f in scripts/build-collector-image.sh scripts/release/load-images.sh scripts/release/steps.sh scripts/release/pull-back.sh \
  scripts/release/verify-tag.sh scripts/release/verify-collector-artifacts.sh scripts/gates/static.sh scripts/publish-platform-images.sh \
  scripts/publish-chart.sh scripts/release/build-compose-archive.sh \
  scripts/release/release-notes.sh scripts/release/promote.sh scripts/release/tools.sh; do
  mkdir -p "$copy/$(dirname "$f")"
  cat >"$copy/$f" <<'SH'
#!/bin/bash
me="$(basename "$0")"
if [ "$me" = build-collector-image.sh ] && [ "${1:-}" = --list-offered ]; then printf '0.162.0\n0.161.0\n'; exit 0; fi
printf '%s %s\n' "$me" "$*" >>"$STANDIN_DIR/steps.log"
case "$me" in
  tools.sh)
    case "$1" in
      ref) printf 'standin.invalid/%s@sha256:%s\n' "$2" 0000000000000000000000000000000000000000000000000000000000000000 ;;
      docker-config) mkdir -p "$2/cli-plugins" && echo '{"auths":{"standin.invalid":{}}}' >"$2/config.json" && echo "$2" ;;
    esac ;;
  release-notes.sh) echo "# notes" ;;
esac
# shellcheck disable=SC1090
[ ! -f "$STANDIN_DIR/hook-$me" ] || . "$STANDIN_DIR/hook-$me"
[ ! -f "$STANDIN_DIR/fail-$me" ] || exit 1
exit 0
SH
  chmod 755 "$copy/$f"
done
g() { git -c user.name=rehearse-test -c user.email=rehearse-test@example.invalid -c commit.gpgSign=false -c tag.gpgSign=false \
  -c init.defaultBranch=main -c core.hooksPath=/dev/null "$@"; }
printf 'node_modules/\n' >"$copy/.gitignore"
g init -q "$copy" && g -C "$copy" add -A && g -C "$copy" commit -qm copy
mkdir -p "$copy/telflo-core/node_modules"
pin="$(sed -n 's/^version=//p' "$root/vendor/opamp-server/PIN")"
pin_digest="$(sed -n 's/^digest=//p' "$root/vendor/opamp-server/PIN")"
nginx_digest="$(awk '/^gateway:/{g=1} g && /digest:/{print $2; exit}' "$root/charts/telflo/values.yaml")"
g init -q "$tmp/opamp-src" && echo opamp >"$tmp/opamp-src/README" && g -C "$tmp/opamp-src" add -A && g -C "$tmp/opamp-src" commit -qm o \
  && g -C "$tmp/opamp-src" tag -a "v$pin" -m "v$pin" && g clone -q --bare "$tmp/opamp-src" "$tmp/opamp-server.git"
printf '[url "%s"]\n\tinsteadOf = https://github.com/telflo/opamp-server.git\n' "$tmp/opamp-server.git" >"$tmp/home/.gitconfig"
kube="$tmp/kube/config"

cat >"$sb/docker" <<'SH'
#!/bin/bash
# The stand-in docker: lists in $STANDIN_DIR (containers, volumes, networks:
# names; images: "<ref> <repo digests...> [<id>]", an image's id its third
# field when that is sha256:…, else a sha256 of its reference), changed by
# rm/rmi; labels (JSON) in labels/<name>; every call logged, and the
# DOCKER_CONFIG each one ran with.
d="$STANDIN_DIR"
printf '%s\n' "$*" >>"$d/docker.log"
printf '%s %s\n' "$1" "${DOCKER_CONFIG:-unset}" >>"$d/docker-config.log"
last="${!#}"
listed() { [ -f "$d/$1" ] && grep -qxF -- "$2" "$d/$1"; }
drop() { grep -vxF -- "$2" "$d/$1" >"$d/$1.new"; mv "$d/$1.new" "$d/$1"; }
name_filter() { local a; for a in "$@"; do case "$a" in name=*) echo "${a#name=}" ;; esac; done; }
labels() { if [ -f "$d/labels/$1" ]; then cat "$d/labels/$1"; else echo null; fi; }
labels_json() { # the --label k=v arguments as a JSON object
  local args=()
  while [ $# -gt 0 ]; do if [ "$1" = --label ]; then args+=("$2"); shift 2; else shift; fi; done
  if [ ${#args[@]} -eq 0 ]; then echo null; return; fi
  printf '%s\n' "${args[@]}" | jq -R '(index("=")) as $i | {(.[:$i]): .[$i + 1:]}' | jq -sc 'add'
}
case "$1" in
  version) exit 0 ;;
  ps) grep -F -- "$(name_filter "$@")" "$d/containers" || true ;;
  volume | network)
    list="${1}s"
    case "$2" in
      ls) grep -F -- "$(name_filter "$@")" "$d/$list" || true ;;
      inspect) listed "$list" "$last" || exit 1
        case " $* " in *" --format "*) labels "$last" ;; esac ;;
      rm) listed "$list" "$3" && drop "$list" "$3" && rm -f "$d/labels/$3" ;;
      create) [ "$1" = volume ] || { echo "UNEXPECTED $*" >>"$d/docker.log"; exit 97; }
        listed volumes "$last" || echo "$last" >>"$d/volumes"
        mkdir -p "$d/labels"; [ -f "$d/labels/$last" ] || labels_json "$@" >"$d/labels/$last"
        echo "$last" ;;
      *) echo "UNEXPECTED $*" >>"$d/docker.log"; exit 97 ;;
    esac ;;
  container) [ "$2" = inspect ] && listed containers "$last" || exit 1
    case " $* " in *" --format "*) labels "$last" ;; esac ;;
  rm) shift; for a in "$@"; do case "$a" in -*) ;; *) listed containers "$a" && drop containers "$a" || exit 1 ;; esac; done ;;
  image)
    case "$2" in
      ls) awk -v r="$3" '{ i = index($1, ":"); if (substr($1, 1, i - 1) == r) print substr($1, i + 1) }' "$d/images" ;;
      inspect)
        line="$(awk -v r="$last" '$1 == r' "$d/images")"
        [ -n "$line" ] || exit 1
        case " $* " in
          *" {{.Id}} "*) set -- $line
            case "${3:-}" in sha256:*) echo "$3" ;; *) printf 'sha256:%s\n' "$(printf '%s' "$1" | shasum -a 256 | cut -c1-64)" ;; esac ;;
          *" --format "*) echo "${line#* }" ;;
        esac ;;
      *) echo "UNEXPECTED $*" >>"$d/docker.log"; exit 97 ;;
    esac ;;
  rmi) awk -v r="$2" '$1 == r { found = 1 } END { exit !found }' "$d/images" || exit 1
       awk -v r="$2" '$1 != r' "$d/images" >"$d/images.new" && mv "$d/images.new" "$d/images" ;;
  run)
    case " $* " in
      *" --entrypoint df "*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1 1 %s 1%% /\n' "$(cat "$d/disk-kb")" ;;
      " run -d --name "*) # a detached container (the registry): listed, its labels kept
        name="$4"; echo "$name" >>"$d/containers"; mkdir -p "$d/labels"; labels_json "$@" >"$d/labels/$name"
        echo 0123456789abcdef ;;
      *) echo "UNEXPECTED $*" >>"$d/docker.log"; exit 97 ;;
    esac ;;
  *) echo "UNEXPECTED $*" >>"$d/docker.log"; exit 97 ;;
esac
SH
cat >"$sb/kubectl" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >>"$STANDIN_DIR/kubectl.log"
[ "$*" = "config current-context" ] || { echo "UNEXPECTED $*" >>"$STANDIN_DIR/kubectl.log"; exit 97; }
context="$(sed -n 's/^current-context: //p' "${KUBECONFIG%%:*}" 2>/dev/null)"
[ -n "$context" ] || { echo "error: current-context is not set" >&2; exit 1; }
echo "$context"
SH
cat >"$sb/pmset" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >>"$STANDIN_DIR/pmset.log"
cat "$STANDIN_DIR/power"
SH
cat >"$sb/caffeinate" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >>"$STANDIN_DIR/caffeinate.log"
while [ "${1#-}" != "$1" ]; do shift; done
exec "$@"
SH
cat >"$sb/helm" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >>"$STANDIN_DIR/helm.log"
exit 97
SH
# The stand-in curl: the registry's /v2/ on 127.0.0.1 answers (a run that starts its own
# registry); anything else is unexpected.
cat >"$sb/curl" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >>"$STANDIN_DIR/curl.log"
case "${!#}" in http://127.0.0.1:*/v2/) exit 0 ;; esac
echo "UNEXPECTED $*" >>"$STANDIN_DIR/curl.log"; exit 97
SH
chmod 755 "$sb/docker" "$sb/kubectl" "$sb/pmset" "$sb/caffeinate" "$sb/helm" "$sb/curl"

# A port base whose 18 ports are free here.
free_base() {
  python3 -I -c '
import socket, sys
for base in range(int(sys.argv[1]), 60000, 211):
    ok = True
    for off in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 100, 101, 102, 110, 111, 112, 120):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", base + off))
        except OSError:
            ok = False
        finally:
            s.close()
        if not ok:
            break
    if ok:
        print(base); break
' "$1"
}
pb="$(free_base $((40000 + $$ % 3000)))"
power_ac() { printf "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%%; charged; 0:00 remaining present: true\n" >"$sd/power"; }
power_battery() { printf "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t88%%; discharging; 7:25 remaining present: true\n" >"$sd/power"; }
reset() { # the stand-ins' state: a developer's own things, the pins local, AC, 40 GB free, no hooks
  rm -rf "$sd"; mkdir -p "$sd"
  printf '%s\n' telflo-platform-db-1 telflo-dev-api-1 buildx_buildkit_telflo-multi0 owner-telflo-rehearse-copy >"$sd/containers"
  printf '%s\n' telflo-platform_db buildx_buildkit_telflo-multi0_state >"$sd/volumes"
  printf '%s\n' telflo-platform_default bridge >"$sd/networks"
  printf '%s\n' "postgres:18 postgres@sha256:1" "axllent/mailpit:v1.31 axllent/mailpit@sha256:2" "nginx:1.30-alpine nginx@$nginx_digest" \
    "ghcr.io/telflo/opamp-server:$pin ghcr.io/telflo/opamp-server@$pin_digest" "telflo-smoke-collector:owner-tag x" \
    "ghcr.io/telflo/telflo/collector:0.161.0 kept-from-before" >"$sd/images"
  echo $((40 * 1024 * 1024)) >"$sd/disk-kb"
  power_ac
  printf 'apiVersion: v1\nkind: Config\ncurrent-context: fixture-context\n' >"$kube"
  # What the steps leave in the engine: release images, the builder, a smoke's leftovers.
  cat >"$sd/hook-load-images.sh" <<'HOOK'
case " $* " in
  *" --image collector "*) v="$(printf '%s\n' "$@" | awk 'p { print; exit } $0 == "--version" { p = 1 }')"
    grep -q "^ghcr.io/telflo/telflo/collector:$v " "$STANDIN_DIR/images" || echo "ghcr.io/telflo/telflo/collector:$v x" >>"$STANDIN_DIR/images" ;;
  *) v="$(printf '%s\n' "$@" | awk 'p { print; exit } $0 == "--version" { p = 1 }')"
    for i in api web otelcol-validator otelcol-testing ottl-evaluator; do echo "ghcr.io/telflo/telflo/$i:$v x" >>"$STANDIN_DIR/images"; done ;;
esac
HOOK
  cat >"$sd/hook-steps.sh" <<'HOOK'
case "$1" in
  builder) echo buildx_buildkit_telflo-release0 >>"$STANDIN_DIR/containers"; echo buildx_buildkit_telflo-release0_state >>"$STANDIN_DIR/volumes" ;;
  stack-smoke) echo telflo-rehearse-stack-db-1 >>"$STANDIN_DIR/containers"; echo telflo-rehearse-stack_db >>"$STANDIN_DIR/volumes"
    echo telflo-rehearse-stack_default >>"$STANDIN_DIR/networks"; echo "telflo-smoke-collector:telflo-rehearse-stack-42 x" >>"$STANDIN_DIR/images" ;;
esac
HOOK
}
hrun() { # [VAR=value ...] -- <rehearse.sh args...>
  local vars=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  shift
  out="$(cd "$tmp" && env -u CI -u GITHUB_ACTIONS -u KUBECONFIG -u REHEARSE_CAFFEINATED -u COMPOSE_PROJECT_NAME HOME="$tmp/home" \
    PATH="$sb:$PATH" STANDIN_DIR="$sd" TELFLO_REHEARSE_KUBECONFIG="$kube" ${vars[@]+"${vars[@]}"} \
    "$shell" "$copy/scripts/release/rehearse.sh" "$@" 2>&1)"; rc=$?
}
steps_ran() { [ -f "$sd/steps.log" ] && grep -c '' "$sd/steps.log" || echo 0; }
removals() { grep -E '^(rm|rmi|volume rm|network rm)( |$)' "$sd/docker.log" 2>/dev/null; }
listed() { grep -qxF -- "$2" "$sd/$1"; }
plan_n=$(( 1 + 2 * 5 + 1 + 3 + 1 + 1 + 5 + 3 + 2 + 3 + 6 + 3 ))  # the collector builder; the copy offers 0.162.0 and 0.161.0

# A full run, on AC power.
reset
hrun -- --version "$version" --work "$tmp/w1" --registry 127.0.0.1:5999 --port-base "$pb"
check "a full run (stand-ins): exit 0, PASS" "[ $rc -eq 0 ] && has 'PASS: every step of the release rehearsed'"
check "it wraps itself in caffeinate -is" "[ \"\$(head -n 1 '$sd/caffeinate.log')\" = '-is env REHEARSE_CAFFEINATED=1 $shell $copy/scripts/release/rehearse.sh --version $version --work $tmp/w1 --registry 127.0.0.1:5999 --port-base $pb' ]"
check "it asked pmset for the power source" "grep -qx -- '-g batt' '$sd/pmset.log'"
check "the prep first: tools.sh fetch, then pull registry, then the other five pins, before any step" \
  "[ \"\$(grep -v '^tools.sh ref ' '$sd/steps.log' | head -n 7 | cut -d' ' -f1-3)\" = \"\$(printf 'tools.sh fetch\ntools.sh pull registry\ntools.sh pull buildkit\ntools.sh pull syft-scanner\ntools.sh pull kind-node\ntools.sh pull postgres\ntools.sh pull mailpit')\" ]"
check "every step ran, in the plan's order (collector path first, the stage, its notes, then finalize: the promote, the public pull-back, the collector check last)" \
  "grep -q '^build-collector-image.sh 0.162.0 --build-oci' '$sd/steps.log' && [ \"\$(tail -n 4 '$sd/steps.log' | cut -d' ' -f1 | tr '\n' ' ')\" = 'release-notes.sh promote.sh pull-back.sh verify-collector-artifacts.sh ' ] && grep -q '^steps.sh archive-smoke --version $version --release $tmp/w1/release --work $tmp/w1/archive-smoke --project telflo-rehearse-archive ' '$sd/steps.log' \
   && grep -q '^steps.sh kind-smoke --version $version --release $tmp/w1/release --work $tmp/w1/kind-smoke --profile telflo-rehearse-kind ' '$sd/steps.log'"
check "the summary: each step with its exit and seconds, the total, REDACTED 0, the kube check" \
  "has 'prep-tools' && has 'publish-notes' && has 'total 0 h 0 min' && has '$plan_n of $plan_n steps passed' \
   && has \"secret-shaped lines (redact.sh's marker)\" && has ': 0 (must be 0)' && has 'kube context unchanged: fixture-context' && has 'kubeconfig unchanged'"
check "the summary is kept in <work>/summary.txt" "grep -q 'kube context unchanged' '$tmp/w1/summary.txt'"
check "the end removed, by name: the smoke's leftovers, the builder it made, the images it added" \
  "! listed containers telflo-rehearse-stack-db-1 && ! listed volumes telflo-rehearse-stack_db && ! listed networks telflo-rehearse-stack_default \
   && ! listed containers buildx_buildkit_telflo-release0 && ! listed volumes buildx_buildkit_telflo-release0_state \
   && ! grep -q '^ghcr.io/telflo/telflo/api:$version ' '$sd/images' && ! grep -q '^ghcr.io/telflo/telflo/collector:0.162.0 ' '$sd/images' \
   && ! grep -q '^telflo-smoke-collector:telflo-rehearse-stack-42 ' '$sd/images' && has 'removed:'"
check "nothing else removed: a developer's own containers, volumes, networks and images, a name only containing telflo-rehearse-, an image there before" \
  "listed containers telflo-platform-db-1 && listed containers telflo-dev-api-1 && listed containers buildx_buildkit_telflo-multi0 \
   && listed containers owner-telflo-rehearse-copy && listed volumes telflo-platform_db && listed networks telflo-platform_default \
   && grep -q '^postgres:18 ' '$sd/images' && grep -q '^telflo-smoke-collector:owner-tag ' '$sd/images' \
   && grep -q '^ghcr.io/telflo/telflo/collector:0.161.0 kept-from-before' '$sd/images' \
   && ! removals | grep -qE 'telflo-platform|telflo-dev|telflo-multi|owner-|postgres|mailpit|nginx|opamp-server|collector:0.161.0'"
check "never a prune, never a pull or tag of the docker CLI's own" "! grep -qE 'prune|^pull |^tag |^image (pull|tag)' '$sd/docker.log'"
check "<work> keeps its logs only" \
  "[ -f '$tmp/w1/rehearse.log' ] && [ -d '$tmp/w1/logs' ] && [ -f '$tmp/w1/rehearse.state' ] && [ ! -e '$tmp/w1/clone' ] && [ ! -e '$tmp/w1/oci' ] && [ ! -e '$tmp/w1/opamp-server' ] && [ ! -e '$tmp/w1/docker' ]"
check "kubectl asked current-context only, with the fixture" "[ \"\$(sort -u '$sd/kubectl.log')\" = 'config current-context' ]"
check "rehearse.state named the builder made, the release images absent before (not 0.161.0, there before), and each one's id once loaded" \
  "grep -qx 'builder telflo-release made' '$tmp/w1/rehearse.state' && grep -qx 'absent ghcr.io/telflo/telflo/api:$version' '$tmp/w1/rehearse.state' \
   && grep -qxE 'image ghcr\\.io/telflo/telflo/api:$version_re sha256:[0-9a-f]{64}' '$tmp/w1/rehearse.state' \
   && grep -qxE 'image ghcr\\.io/telflo/telflo/collector:0\\.162\\.0 sha256:[0-9a-f]{64}' '$tmp/w1/rehearse.state' \
   && [ \$(grep -c '^image ghcr.io/telflo/telflo/collector:0.162.0 ' '$tmp/w1/rehearse.state') -eq 1 ] \
   && ! grep -q 'collector:0.161.0' '$tmp/w1/rehearse.state'"
check "the marker volume telflo-rehearse-run made with this run's labels (work folder, pid, start) before the prep, removed at the end" \
  "grep -qE '^volume create --label telflo\\.rehearse\\.work=$tmp/w1 --label telflo\\.rehearse\\.pid=[1-9][0-9]* --label telflo\\.rehearse\\.started=.+ telflo-rehearse-run\$' '$sd/docker.log' \
   && [ \"\$(grep -n '^volume create ' '$sd/docker.log' | cut -d: -f1)\" -lt \"\$(grep -n '^run ' '$sd/docker.log' | head -n 1 | cut -d: -f1)\" ] \
   && grep -qx 'volume rm telflo-rehearse-run' '$sd/docker.log' && ! listed volumes telflo-rehearse-run"
check "Docker ran with a configuration holding no login from its first call: a temporary one for the checks, then <work>/docker; the temporary one removed" \
  "! grep -qE ' unset\$|/\\.docker\$' '$sd/docker-config.log' && [ \"\$(head -n 1 '$sd/docker-config.log' | cut -d' ' -f2 | sed 's#.*/##' | cut -c1-16)\" = rehearse-docker. ] \
   && ! awk '{ print \$2 }' '$sd/docker-config.log' | grep -vxF '$tmp/w1/docker' | grep -v '/rehearse-docker\\.' | grep -q . \
   && ! awk '{ print \$2 }' '$sd/docker-config.log' | sort -u | grep '/rehearse-docker\\.' | while read -r dir; do [ ! -e \"\$dir\" ] || echo left; done | grep -q left"

# Battery.
reset; power_battery
hrun -- --version "$version" --work "$tmp/w2" --registry 127.0.0.1:5999 --port-base "$pb"
check "on battery without --allow-battery: refused (exit 2), caffeinate suggested, nothing fetched or run" \
  "[ $rc -eq 2 ] && has 'this Mac is on battery' && has 'caffeinate -is' && [ \$(steps_ran) -eq 0 ] && [ ! -e '$tmp/w2' ]"
reset; power_battery; : >"$sd/fail-tools.sh"
hrun -- --version "$version" --work "$tmp/w3" --registry 127.0.0.1:5999 --port-base "$pb" --allow-battery
check "on battery with --allow-battery: it goes on (to the prep), saying so" "has 'on battery (--allow-battery)' && [ \$(steps_ran) -ge 1 ]"
check "a prep step failing: exit 1, the summary still printed, the kube still checked" \
  "[ $rc -eq 1 ] && has 'FAIL at prep-tools' && has 'kube context unchanged' && has '0 of $plan_n steps passed'"

# Low disk.
reset; echo $((24 * 1024 * 1024)) >"$sd/disk-kb"
hrun -- --version "$version" --work "$tmp/w4" --registry 127.0.0.1:5999 --port-base "$pb"
check "Docker's disk under 25 GB: fails (exit 1) after the registry's pull, before any other pull or step" \
  "[ $rc -eq 1 ] && has \"Docker's disk has 24 GB free: the rehearsal needs 25 GB\" && [ \"\$(grep -c ' pull ' '$sd/steps.log')\" -eq 1 ] && ! grep -qv '^tools.sh ' '$sd/steps.log'"

# A developer's own project or port; an earlier run's leftovers.
reset
hrun COMPOSE_PROJECT_NAME=telflo-platform -- --version "$version" --work "$tmp/w5" --registry 127.0.0.1:5999 --port-base "$pb"
check "COMPOSE_PROJECT_NAME=telflo-platform: refused (exit 2), nothing run" "[ $rc -eq 2 ] && has 'COMPOSE_PROJECT_NAME is telflo-platform' && [ \$(steps_ran) -eq 0 ]"
python3 -I -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(1)
open(sys.argv[2], "w").close(); time.sleep(60)
' $((pb + 3)) "$tmp/listening" &
listener=$!
for _ in $(seq 1 50); do [ -f "$tmp/listening" ] && break; sleep 0.1; done
hrun -- --version "$version" --work "$tmp/w6" --registry 127.0.0.1:5999 --port-base "$pb"
kill "$listener" 2>/dev/null; wait "$listener" 2>/dev/null
check "one of its ports in use on 127.0.0.1: refused naming it (exit 2), nothing run" \
  "[ $rc -eq 2 ] && has \"port(s) $((pb + 3)), the rehearsal's (--port-base $pb), are in use\" && [ \$(steps_ran) -eq 0 ] && [ ! -e '$tmp/w6' ]"
reset; echo telflo-rehearse-registry >>"$sd/containers"
hrun -- --version "$version" --work "$tmp/w7" --registry 127.0.0.1:5999 --port-base "$pb"
check "an earlier run's telflo-rehearse-registry still there: refused, --cleanup named (exit 2), nothing removed" \
  "[ $rc -eq 2 ] && has 'container:telflo-rehearse-registry is still there' && has '--cleanup --work' && listed containers telflo-rehearse-registry && [ -z \"\$(removals)\" ]"
reset
hrun -- --version "$version" --work "$tmp/w8" --registry 127.0.0.1:5999 --port-base "$pb" --dry-run
check "--dry-run with stand-ins: the prep shown, nothing fetched, pulled or asked (no docker, pmset, kubectl or caffeinate call)" \
  "[ $rc -eq 0 ] && has 'P01 prep-tools' && has 'prep-pull-kind-node' && [ \$(steps_ran) -eq 0 ] && [ ! -e '$sd/docker.log' ] && [ ! -e '$sd/pmset.log' ] && [ ! -e '$sd/kubectl.log' ] && [ ! -e '$sd/caffeinate.log' ]"

# No node_modules in telflo-core.
reset; mv "$copy/telflo-core/node_modules" "$tmp/node_modules.aside"
hrun -- --version "$version" --work "$tmp/w14" --registry 127.0.0.1:5999 --port-base "$pb"
mv "$tmp/node_modules.aside" "$copy/telflo-core/node_modules"
check "no telflo-core/node_modules: fails (exit 1) naming npm ci, never runs it, nothing run" \
  "[ $rc -eq 1 ] && has 'run npm ci in telflo-core first' && [ \$(steps_ran) -eq 0 ] && [ ! -e '$tmp/w14' ]"

# The kube context or the kubeconfig changed during a run.
reset
cat >>"$sd/hook-steps.sh" <<'HOOK'
[ "$1" != kind-smoke ] || printf 'apiVersion: v1\nkind: Config\ncurrent-context: other-context\n' >"$KUBE_FIXTURE"
HOOK
hrun KUBE_FIXTURE="$kube" -- --version "$version" --work "$tmp/w9" --registry 127.0.0.1:5999 --port-base "$pb"
check "the kube context changed during the run: fails (exit 1) naming both" \
  "[ $rc -eq 1 ] && has 'FAIL: the kube context changed: fixture-context before, other-context now' && has 'FAIL: the kubeconfig changed'"
reset
cat >>"$sd/hook-steps.sh" <<'HOOK'
[ "$1" != kind-smoke ] || echo "# touched" >>"$KUBE_FIXTURE"
HOOK
hrun KUBE_FIXTURE="$kube" -- --version "$version" --work "$tmp/w10" --registry 127.0.0.1:5999 --port-base "$pb"
check "the kubeconfig changed (same context) during the run: fails (exit 1)" \
  "[ $rc -eq 1 ] && has 'kube context unchanged: fixture-context' && has 'FAIL: the kubeconfig changed (sha256, mtime or presence)'"

# A step failing.
reset
cat >>"$sd/hook-steps.sh" <<'HOOK'
[ "$1" != archive-smoke ] || exit 1
HOOK
hrun -- --version "$version" --work "$tmp/w11" --registry 127.0.0.1:5999 --port-base "$pb"
check "a step failing: exit 1, the steps after it not run, the summary and the end still done" \
  "[ $rc -eq 1 ] && has 'FAIL at archive-smoke' && grep -q '^steps.sh archive-smoke ' '$sd/steps.log' && ! grep -q '^steps.sh kind-smoke ' '$sd/steps.log' && has 'removed:' && ! listed containers buildx_buildkit_telflo-release0"

# --keep, then --cleanup.
reset
hrun -- --version "$version" --work "$tmp/w12" --registry 127.0.0.1:5999 --port-base "$pb" --keep
check "--keep: exit 0, nothing removed but its marker, what was kept said with the cleanup command" \
  "[ $rc -eq 0 ] && [ \"\$(removals)\" = 'volume rm telflo-rehearse-run' ] && has 'kept (--keep):' && has 'image ghcr.io/telflo/telflo/api:$version' && has 'the builder telflo-release' \
   && has 'remove them with: scripts/release/rehearse.sh --cleanup --work $tmp/w12' && [ -d '$tmp/w12/clone' ] && [ -d '$tmp/w12/docker' ]"
# An edited state: an image that isn't release-named, one without an id, another builder; and one image
# whose id changed after the run loaded it (someone loaded another image under that name).
{ echo "image postgres:18 sha256:$(printf '1%.0s' $(seq 1 64))"; echo "image ghcr.io/telflo/telflo/collector:0.161.0"; echo "builder telflo-multi made"; } >>"$tmp/w12/rehearse.state"
awk -v img="ghcr.io/telflo/telflo/otelcol-testing:$version" '$1 != img' "$sd/images" >"$sd/images.new" && mv "$sd/images.new" "$sd/images"
echo "ghcr.io/telflo/telflo/otelcol-testing:$version x sha256:$(printf 'e%.0s' $(seq 1 64))" >>"$sd/images"
: >"$sd/docker.log"; : >"$sd/docker-config.log"
hrun -- --cleanup --work "$tmp/w12"
check "--cleanup: exit 0, removes the telflo-rehearse-* leftovers, the builder it made, the images it added, then <work>" \
  "[ $rc -eq 0 ] && ! listed containers telflo-rehearse-stack-db-1 && ! listed volumes telflo-rehearse-stack_db && ! listed networks telflo-rehearse-stack_default \
   && ! listed containers buildx_buildkit_telflo-release0 && ! grep -q '^ghcr.io/telflo/telflo/web:$version ' '$sd/images' && [ ! -e '$tmp/w12' ]"
check "--cleanup: an edited rehearse.state's postgres:18 and other builder left alone and named" \
  "grep -q '^postgres:18 ' '$sd/images' && listed containers buildx_buildkit_telflo-multi0 && has \"names the image 'postgres:18', not a release-named one: left alone\" \
   && has \"names the builder 'telflo-multi'\""
check "--cleanup: only telflo-rehearse-* names, the builder telflo-release and release-named images removed; never a prune" \
  "! removals | grep -vE '^(rm -f -v telflo-rehearse-|network rm telflo-rehearse-|volume rm telflo-rehearse-|volume rm buildx_buildkit_telflo-release0_state\$|rm -f buildx_buildkit_telflo-release0\$|rmi ghcr\\.io/telflo/telflo/|rmi telflo-smoke-collector:telflo-rehearse-)' | grep -q . \
   && ! grep -q prune '$sd/docker.log'"
check "--cleanup: a state line without the id the run loaded (collector 0.161.0, there before the run) is left alone and named" \
  "grep -q '^ghcr.io/telflo/telflo/collector:0.161.0 kept-from-before' '$sd/images' && has 'collector:0.161.0 without the id the run loaded: left alone'"
check "--cleanup: an image whose id changed since the run loaded it is left alone and named; the others removed (no '(in use?)' beside them)" \
  "grep -q '^ghcr.io/telflo/telflo/otelcol-testing:$version ' '$sd/images' && has 'otelcol-testing:$version is now sha256:eeee' && has 'not the sha256:' \
   && ! grep -q '^ghcr.io/telflo/telflo/api:$version ' '$sd/images' && has '  - image ghcr.io/telflo/telflo/api:$version' && ! has '(in use?)'"
check "--cleanup: Docker ran with a temporary configuration holding no login, removed after" \
  "[ -s '$sd/docker-config.log' ] && ! grep -qE ' unset\$|/\\.docker\$' '$sd/docker-config.log' && ! awk '{ print \$2 }' '$sd/docker-config.log' | grep -v '/rehearse-docker\\.' | grep -q . \
   && [ ! -e \"\$(head -n 1 '$sd/docker-config.log' | cut -d' ' -f2)\" ]"
mkdir -p "$tmp/w13"; printf 'work /somewhere/else\n' >"$tmp/w13/rehearse.state"
hrun -- --cleanup --work "$tmp/w13"
check "--cleanup on a folder whose rehearse.state names another folder: refused (exit 2), nothing removed" \
  "[ $rc -eq 2 ] && has 'names another folder' && [ -d '$tmp/w13' ]"
# A rehearsal running now: its labels (another process of this test, alive, with its start time).
sleep 300 &
live_pid=$!
live_started="$(ps -o lstart= -p "$live_pid" | sed 's/  */ /g; s/^ //; s/ $//')"
live_labels() { # <name> <work> [<started>]
  mkdir -p "$sd/labels"
  jq -cn --arg w "$2" --arg p "$live_pid" --arg s "${3:-$live_started}" '{"telflo.rehearse.work": $w, "telflo.rehearse.pid": $p, "telflo.rehearse.started": $s}' >"$sd/labels/$1"
}
reset
hrun -- --version "$version" --work "$tmp/w15" --registry 127.0.0.1:5999 --port-base "$pb" --keep
echo telflo-rehearse-registry >>"$sd/containers"; live_labels telflo-rehearse-registry /some/other/rehearsal
: >"$sd/docker.log"
hrun -- --cleanup --work "$tmp/w15"
check "--cleanup while another rehearsal runs (its registry's labels: a live pid, its start): refused (exit 2), nothing removed" \
  "[ $rc -eq 2 ] && has 'a rehearsal is running now' && has '/some/other/rehearsal $live_pid' && [ -z \"\$(removals)\" ] && [ -d '$tmp/w15' ] && listed containers telflo-rehearse-stack-db-1"
live_labels telflo-rehearse-registry "$tmp/w15"
hrun -- --cleanup --work "$tmp/w15"
check "--cleanup of a run's own folder while that run is still running: refused too (exit 2)" "[ $rc -eq 2 ] && has 'a rehearsal is running now' && [ -d '$tmp/w15' ]"
live_labels telflo-rehearse-registry /some/other/rehearsal "Thu Jan  1 00:00:00 1970"
hrun -- --cleanup --work "$tmp/w15"
check "--cleanup when the label's pid now belongs to another process (another start time): not a running rehearsal, removed (exit 0)" \
  "[ $rc -eq 0 ] && ! listed containers telflo-rehearse-registry && [ ! -e '$tmp/w15' ]"
reset
echo telflo-rehearse-run >>"$sd/volumes"; live_labels telflo-rehearse-run /some/other/rehearsal
hrun -- --version "$version" --work "$tmp/w16" --registry 127.0.0.1:5999 --port-base "$pb"
check "a run while another rehearsal runs (its marker's labels): refused (exit 2), nothing run or removed" \
  "[ $rc -eq 2 ] && has 'a rehearsal is running now' && [ \$(steps_ran) -eq 0 ] && [ -z \"\$(removals)\" ] && listed volumes telflo-rehearse-run"
reset
cat >>"$sd/hook-steps.sh" <<HOOK
if [ "\$1" = stack-smoke ]; then
  echo telflo-rehearse-other-registry >>"\$STANDIN_DIR/containers"
  mkdir -p "\$STANDIN_DIR/labels"
  jq -cn --arg p "$live_pid" --arg s "$live_started" '{"telflo.rehearse.work": "/some/other/rehearsal", "telflo.rehearse.pid": \$p, "telflo.rehearse.started": \$s}' >"\$STANDIN_DIR/labels/telflo-rehearse-other-registry"
fi
HOOK
hrun -- --version "$version" --work "$tmp/w17" --registry 127.0.0.1:5999 --port-base "$pb"
check "a finishing run leaves alone an object whose labels name another running rehearsal, and says so; its own removed" \
  "[ $rc -eq 0 ] && listed containers telflo-rehearse-other-registry && has 'telflo-rehearse-other-registry belongs to another rehearsal that is running: left alone' \
   && ! listed containers telflo-rehearse-stack-db-1 && ! listed volumes telflo-rehearse-run"
kill "$live_pid" 2>/dev/null; wait "$live_pid" 2>/dev/null

# A run that starts its own registry (no --registry): the container is labeled with the run's
# work folder, pid and start time (the marker's labels), so while the run goes on it names a
# running rehearsal; removed at the end.
reset
cat >>"$sd/hook-steps.sh" <<'HOOK'
if [ "$1" = stack-smoke ]; then
  l="$STANDIN_DIR/labels/telflo-rehearse-registry"
  p="$(jq -r '."telflo.rehearse.pid" // ""' "$l" 2>/dev/null)"
  st="$(jq -r '."telflo.rehearse.started" // ""' "$l" 2>/dev/null)"
  w="$(jq -r '."telflo.rehearse.work" // ""' "$l" 2>/dev/null)"
  if [ -n "$p" ] && [ -n "$st" ] && [ "$(ps -o lstart= -p "$p" 2>/dev/null | sed 's/  */ /g; s/^ //; s/ $//')" = "$st" ]; then
    echo "live $w" >"$STANDIN_DIR/registry-holder"
  else
    echo "not live" >"$STANDIN_DIR/registry-holder"
  fi
fi
HOOK
hrun -- --version "$version" --work "$tmp/w18" --port-base "$pb"
# shellcheck disable=SC2034 # read by check's eval
reg_line="$(grep '^run -d --name telflo-rehearse-registry ' "$sd/docker.log" 2>/dev/null || true)"
marker_pid="$(sed -n 's/^volume create .*--label telflo\.rehearse\.pid=\([0-9]*\) .*telflo-rehearse-run$/\1/p' "$sd/docker.log" | head -n 1)"
check "a run starting its own registry: exit 0, the registry asked on 127.0.0.1" \
  "[ $rc -eq 0 ] && has 'PASS: every step' && grep -qE '^-fsS -o /dev/null http://127\\.0\\.0\\.1:[0-9]+/v2/\$' '$sd/curl.log' && ! grep -q UNEXPECTED '$sd/curl.log'"
check "the registry container labeled with the run's work folder, pid (the marker's) and start time" \
  "printf '%s' \"\$reg_line\" | grep -qE '^run -d --name telflo-rehearse-registry --label telflo\\.rehearse\\.work=$tmp/w18 --label telflo\\.rehearse\\.pid=$marker_pid --label telflo\\.rehearse\\.started=.+ --pull never -p 127\\.0\\.0\\.1:[0-9]+:5000 ' \
   && [ -n '$marker_pid' ]"
check "while the run went on, the registry's labels named a running rehearsal (pid alive, its start) and its work folder" \
  "[ \"\$(cat '$sd/registry-holder' 2>/dev/null)\" = 'live $tmp/w18' ]"
check "the registry removed at the end" "grep -qx 'rm -f -v telflo-rehearse-registry' '$sd/docker.log' && ! listed containers telflo-rehearse-registry"

check "helm was never called by rehearse.sh itself" "[ ! -e '$sd/helm.log' ]"
check "no step called a docker credential helper (the stand-ins' logs empty)" "! cat '$tmp'/w*/standins.log 2>/dev/null | grep -q ."

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILURE(S)"; exit 1; fi
