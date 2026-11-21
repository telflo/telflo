#!/bin/bash
# Tests for scripts/publish-chart.sh. The real Helm renders, lints and
# packages; `helm` is a wrapper first on PATH that hands every subcommand to
# the real Helm except `push`, which it records (the argv the real binary
# would get) and answers per case or hands to the real Helm (STANDIN_PUSH=real).
# `crane` (the registry's reads) is a wrapper first on PATH that records every
# call and answers per case (STANDIN_CRANE) or hands it to the real crane.
# Refusing credential-helper stand-ins come first on PATH too: none may be
# called. Two cases run the real crane and the real `helm push` against
# 127.0.0.1:1 (nothing listens there: "connection refused"), proving the
# argv with the real binaries, offline. --push-package runs with the real
# Helm and crane against a throwaway registry:2 on 127.0.0.1 (tools.lock's
# image, local by digest; a login made at run time when htpasswd is there),
# or prints SKIP lines when crane, docker or that image is missing. Nothing
# reaches any other registry. The script runs from
# committed throwaway git repositories holding what it reads (itself, the
# charts, the contracts' helm.ts; for telflo the PIN, the PIN check
# and the files its render tests read): it publishes only what is committed,
# so the checkout's own state never decides a case. Sections 1 to 6 are the
# default chart's (supervisor-collector); section 7 is telflo's row and checks
# that the default's output is --chart supervisor-collector's.
# Run:  bash scripts/publish-chart.test.sh
# bash 3.2 compatible (macOS's /bin/bash).
set -u
# One spelling of the temporary folder (no trailing slash, no //), and no CI:
# the test sets CI itself where a case needs it.
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI
# Hermetic: a caller's tools folder or git setting never changes what these cases test.
unset TELFLO_TOOLS_DIR TELFLO_TOOLS_LOCK TELFLO_TOOLS_PLATFORM GIT_NO_REPLACE_OBJECTS
root="$(cd "$(dirname "$0")/.." && pwd)"
source_script="$root/scripts/publish-chart.sh"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }
check() { # <name> <shell-expr that must succeed>
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}
# For a failed case against the real Helm: the script's own lines and Helm's
# errors (they hold the reference and Helm's answer, nothing else).
explain() { printf '%s\n' "$out" | grep -E '^(publish-chart: |Error: |helm push )' | sed 's/^/       /'; }

real_helm="$(command -v helm 2>/dev/null || true)"
if [ -z "$real_helm" ]; then echo "FAIL - helm is not on PATH"; exit 1; fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/publish-chart-test.XXXXXX")" || exit 1
cleanup() { tr_registry_stop; rm -rf "$tmp"; }
trap cleanup EXIT
bin="$tmp/bin"; logs="$tmp/logs"
mkdir -p "$bin" "$logs" "$tmp/scratch" "$tmp/stub"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/stub/config.json"
TR_DOCKER_CONFIG="$tmp/stub"
real_crane="$("$shell" "$root/scripts/release/tools.sh" path crane 2>/dev/null || command -v crane 2>/dev/null || true)"
for helper in osxkeychain desktop ecr-login; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$logs" >"$bin/docker-credential-$helper"
  chmod +x "$bin/docker-credential-$helper"
done
printf '#!/bin/bash\nreal="%s"\nlog="%s"\n' "$real_helm" "$logs" >"$bin/helm"
cat >>"$bin/helm" <<'EOF'
# The test's helm wrapper: the real Helm, but `push` recorded and answered
# per case (STANDIN_PUSH; `real` hands it over too); `show` is never expected.
{ printf '%q ' "$@"; echo; } >>"$log/helm-calls.log"
{ printf '%q ' "$@"; echo; } >>"$log/all-helm-calls.log"
environment() {
  printf 'HELM_REGISTRY_CONFIG=%s\n' "${HELM_REGISTRY_CONFIG:-}"
  printf 'registry.json=%s\n' "$(cat "${HELM_REGISTRY_CONFIG:-/nonexistent}" 2>/dev/null)"
  printf 'DOCKER_CONFIG=%s\n' "${DOCKER_CONFIG:-}"
  printf 'config.json=%s\n' "$(cat "${DOCKER_CONFIG:-/nonexistent}/config.json" 2>/dev/null)"
  printf 'HELM_CONFIG_HOME=%s\n' "${HELM_CONFIG_HOME:-}"
  printf 'HELM_DEBUG=%s\n' "${HELM_DEBUG:-}"
}
case "${1:-}" in
  package) environment >"$log/package-env" ;;
  show)
    echo "UNEXPECTED $*" >>"$log/helm-calls.log"
    printf '%s\n' "$@" >"$log/show-args"
    environment >"$log/show-env"
    version=""; prev=""
    for a in "$@"; do if [ "$prev" = --version ]; then version="$a"; fi; prev="$a"; done
    case "${STANDIN_SHOW:-absent}" in
      real) exec "$real" "$@" ;;
      present) echo "apiVersion: v2"; echo "Pulled: ${3#oci://}:$version" >&2; exit 0 ;;
      absent) echo "Error: failed to perform \"FetchReference\" on source: ${3#oci://}:$version: not found" >&2; exit 1 ;;
      other-ref) echo "Error: failed to perform \"FetchReference\" on source: ${3#oci://}-other:$version: not found" >&2; exit 1 ;;
      *) echo "Error: failed to perform \"FetchReference\" on source: response status code 403: denied: requested access to the resource is denied" >&2
         echo "a second line" >&2; exit 1 ;;
    esac ;;
  push)
    printf '%s\n' "$@" >"$log/push-args"
    environment >"$log/push-env"
    tar -tzf "${2:-/nonexistent}" >"$log/push-package-files" 2>/dev/null
    cp "${2:-/nonexistent}" "$log/pushed.tgz" 2>/dev/null
    case "${STANDIN_PUSH:-ok}" in
      real) exec "$real" "$@" ;;
      ok) echo "Pushed: recorded"; exit 0 ;;
      *) echo "Error: the push failed" >&2; exit 1 ;;
    esac ;;
  registry) echo "UNEXPECTED $*" >>"$log/helm-calls.log"; exit 97 ;;
esac
exec "$real" "$@"
EOF
chmod +x "$bin/helm"
tr_crane_wrapper "$bin" "$logs" "${real_crane:-/nonexistent/crane}"
PATH="$bin:$PATH"; export PATH
# The crane wrapper answers "absent" unless a case asks for the real crane
# (STANDIN_CRANE empty): no case reads a registry but the throwaway one.
export STANDIN_CRANE=absent
# Never go on unless `helm` and `crane` are the wrappers: pushes run below.
if [ "$(command -v helm)" != "$bin/helm" ] || [ "$(command -v crane)" != "$bin/crane" ]; then
  echo "FAIL - the helm and crane wrappers are not first on PATH"; exit 1
fi

clear_logs() { rm -f "$logs/helm-calls.log" "$logs/package-env" "$logs/push-args" "$logs/push-env" "$logs/push-package-files" "$logs/crane-calls.log" "$logs/crane-config.log"; }
no_crane() { [ ! -s "$logs/crane-calls.log" ]; }
crane_read() { grep -qx "manifest $1 " "$logs/crane-calls.log" 2>/dev/null; }
pkg_n=0
fresh_pkg() { mktemp -d "$tmp/pkg.XXXXXX"; }
# run_script <script> <args...>: sets rc, out (stdout and stderr) and printed (stdout alone).
run_script() {
  local s="$1"; shift
  clear_logs
  printed="$(env -u TELFLO_HELM_CHART_REFERENCE -u HELM_REGISTRY_CONFIG -u DOCKER_CONFIG TMPDIR="$tmp/scratch" \
    "$shell" "$s" "$@" 2>"$tmp/stderr")"
  rc=$?
  out="$(printf '%s\n' "$printed"; cat "$tmp/stderr")"
}
run() { run_script "$script" "$@"; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
no_helm() { [ ! -s "$logs/helm-calls.log" ]; }
helm_ran() { grep -qE "^$1( |$)" "$logs/helm-calls.log" 2>/dev/null; }
line_of() { grep -nE "^$1( |$)" "$logs/helm-calls.log" | sed -n "${2:-1}p" | cut -d: -f1; }
last_line_of() { grep -nE "^$1( |$)" "$logs/helm-calls.log" | tail -n 1 | cut -d: -f1; }
reconstructed_push() { printf "helm push '%s' '%s'" "$(sed -n 2p "$logs/push-args")" "$(sed -n 3p "$logs/push-args")"; }

# A copy of what the script reads (itself, the charts, the contracts' helm.ts,
# the PIN, the PIN check, the files telflo's render tests read),
# committed in a throwaway git repository, to change one thing in.
# What telflo's render tests read beside the chart, as the script
# finds it: every "$REPO_DIR/<path>" its tests/ name.
render_reads="$(grep -rhoE '"\$REPO_DIR/[^"$]+"' "$root/charts/telflo/tests" | tr -d '"' | sed 's#^\$REPO_DIR/##' | sort -u | tr '\n' ' ')"
PLATFORM_READS="$render_reads vendor/opamp-server/PIN scripts/check-opamp-server-pin.sh"
copy_n=0
git_in() { # <repo> <git args...>
  local repo="$1"; shift
  git -C "$repo" -c user.name=telflo-test -c user.email=test@telflo.invalid -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null "$@" >/dev/null 2>&1
}
make_plain_copy() { # -> $copy (not a git repository)
  copy_n=$((copy_n + 1)); copy="$tmp/copy$copy_n"
  mkdir -p "$copy/scripts/release" "$copy/charts" "$copy/telflo-core/packages/contracts/src"
  cp "$source_script" "$copy/scripts/publish-chart.sh"
  cp "$root/scripts/release/oci.sh" "$root/scripts/release/tools.sh" "$root/scripts/release/tools.lock" "$copy/scripts/release/"
  cp -R "$root/charts/supervisor-collector" "$copy/charts/supervisor-collector"
  cp "$root/telflo-core/packages/contracts/src/helm.ts" "$copy/telflo-core/packages/contracts/src/helm.ts"
  cp "$root/.gitignore" "$copy/.gitignore"
  cp -R "$root/charts/telflo" "$copy/charts/telflo"
  local f
  # A read may be a folder (the web app's public/, for the gateway's roots).
  for f in $PLATFORM_READS; do
    if [ -d "$root/$f" ]; then mkdir -p "$copy/$f"; cp -R "$root/$f/." "$copy/$f/"
    else mkdir -p "$copy/$(dirname "$f")"; cp "$root/$f" "$copy/$f"; fi
  done
}
make_copy() { # -> $copy (committed)
  make_plain_copy
  git_in "$copy" init -q && git_in "$copy" add -A && git_in "$copy" commit -q -m inputs
}
commit_copy() { git_in "$copy" add -A && git_in "$copy" commit -q -m change; }
edit() { # <file> <sed expression>
  sed -e "$2" "$1" >"$1.new" && mv "$1.new" "$1"
}
HELM_TS=telflo-core/packages/contracts/src/helm.ts

# The repository most cases run from.
make_copy; repo="$copy"; script="$repo/scripts/publish-chart.sh"
check "the throwaway repository is committed and clean" \
  "[ -n \"\$(git -C '$repo' rev-parse HEAD 2>/dev/null)\" ] && [ -z \"\$(git -C '$repo' status --porcelain 2>&1)\" ]"

# --- 1. refusals before anything runs (exit 2, Helm never called) -------------------
run
check "no mode refused" "[ $rc -eq 2 ] && has '--dry-run, --package or --push-package is required' && no_helm"
run --dry-run --package "$tmp"
check "two modes refused" "[ $rc -eq 2 ] && has 'one mode' && no_helm"
run --dry-run --push
check "--push refused as an unknown argument, naming --package and --push-package" \
  "[ $rc -eq 2 ] && has 'unknown argument: --push' && has '--package <dir>' && has '--push-package <tgz>' && no_helm && no_crane"
run --package "$tmp" --registry 127.0.0.1:5000
check "--registry with --package refused" "[ $rc -eq 2 ] && has '--registry goes with --dry-run and --push-package only' && no_helm"
run --package "$tmp/none"
check "a --package folder that doesn't exist refused" "[ $rc -eq 2 ] && has 'must be an existing directory' && no_helm"
run --push-package "$tmp/none.tgz"
check "a --push-package file that doesn't exist refused" "[ $rc -eq 2 ] && has 'must be an existing file' && no_helm"
for bad in docker.io ghcr.io/telflo/platform ghcr.io/telflo 10.0.0.1:5000 localhost 127.0.0.1:0; do
  run --dry-run --registry "$bad"
  check "--registry '$bad' refused (only ghcr.io or a loopback registry)" "[ $rc -eq 2 ] && has '--registry must be ghcr.io or a loopback registry' && no_helm && no_crane"
done
run --dry-run --bogus
check "an unknown argument refused" "[ $rc -eq 2 ] && has 'unknown argument: --bogus' && no_helm"
make_copy; edit "$copy/charts/supervisor-collector/Chart.yaml" 's/^version: .*/version: 0.1.1/'
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a chart version not the contracts' DEFAULT_HELM_CHART_VERSION refused" \
  "[ $rc -eq 2 ] && has \"is not the contracts' DEFAULT_HELM_CHART_VERSION\" && no_helm"
make_copy; edit "$copy/charts/supervisor-collector/Chart.yaml" 's/^name: .*/name: other-collector/'
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a chart name not the contracts' reference's last segment refused" \
  "[ $rc -eq 2 ] && has \"is not the last segment of the contracts' DEFAULT_HELM_CHART_REFERENCE\" && no_helm"
make_copy; edit "$copy/$HELM_TS" 's/^export const DEFAULT_HELM_CHART_VERSION = "0.1.0";$/export const DEFAULT_HELM_CHART_VERSION = "0.2.0";/'
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "the contracts' version moved without the chart's refused" \
  "[ $rc -eq 2 ] && has \"is not the contracts' DEFAULT_HELM_CHART_VERSION ('0.2.0')\" && no_helm"
make_copy; printf 'export const DEFAULT_HELM_CHART_VERSION = "0.1.0";\n' >>"$copy/$HELM_TS"
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "two DEFAULT_HELM_CHART_VERSION lines refused" "[ $rc -eq 2 ] && has 'expected exactly one line' && no_helm"
make_copy; edit "$copy/$HELM_TS" 's/^export const DEFAULT_HELM_CHART_REFERENCE = /export const DEFAULT_HELM_CHART_REFERENCE: string = /'
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a DEFAULT_HELM_CHART_REFERENCE line not in its exact form refused" "[ $rc -eq 2 ] && has 'found 0' && no_helm"
# TELFLO_HELM_CHART_REFERENCE (the platform's setting) is refused in every
# mode, whatever it names: nothing here reads or writes a reference the
# caller names.
mkdir -p "$tmp/pkg-ref"
ref_refused() { # <reference> <mode args...>
  local reference="$1"; shift
  clear_logs
  out="$(env -u HELM_REGISTRY_CONFIG -u DOCKER_CONFIG TMPDIR="$tmp/scratch" TELFLO_HELM_CHART_REFERENCE="$reference" "$shell" "$script" "$@" 2>&1)"; rc=$?
  check "TELFLO_HELM_CHART_REFERENCE=$reference refused ($*), before Helm or crane runs" \
    "[ $rc -eq 2 ] && has 'TELFLO_HELM_CHART_REFERENCE is refused' && no_helm && no_crane"
}
ref_refused "oci://ghcr.io/telflo/telflo/charts/supervisor-collector" --dry-run
ref_refused "oci://ghcr.io/telflo/platform/charts/supervisor-collector" --dry-run
ref_refused "oci://ghcr.io/telflo/charts/supervisor-collector" --dry-run
ref_refused "oci://127.0.0.1:1/charts/supervisor-collector" --dry-run --registry 127.0.0.1:5999
ref_refused "oci://ghcr.io/telflo/telflo/charts/supervisor-collector" --package "$tmp/pkg-ref"
ref_refused "oci://127.0.0.1:1/charts/telflo" --dry-run --chart telflo
# The contracts' default reference keeps its shape checks.
make_copy; edit "$copy/$HELM_TS" 's#^export const DEFAULT_HELM_CHART_REFERENCE = ".*";$#export const DEFAULT_HELM_CHART_REFERENCE = "oci://ghcr.io/telflo/charts/supervisor-collector";#'
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a contracts' default under the older oci://ghcr.io/telflo/charts/ refused" "[ $rc -eq 2 ] && has \"an older registry path that isn't this repository's\" && no_helm"
make_copy; edit "$copy/$HELM_TS" 's#^export const DEFAULT_HELM_CHART_REFERENCE = ".*";$#export const DEFAULT_HELM_CHART_REFERENCE = "oci://GHCR.io/telflo/telflo/charts/supervisor-collector";#'
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a contracts' default that isn't lowercase oci:// refused" "[ $rc -eq 2 ] && has 'must match' && no_helm"

# --- 2. a dry run: the checks in order, the exact push printed ---------------------------
run --dry-run
want_re="^helm push '$tmp/scratch/publish-chart\.[A-Za-z0-9]+/package/supervisor-collector-0\.1\.0\.tgz' 'oci://ghcr\.io/telflo/telflo/charts'\$"
check "a clean checkout goes on" "[ $rc -eq 0 ] && ! has 'uncommitted' && helm_ran package"
check "a dry run prints exactly: helm push '<package>' 'oci://ghcr.io/telflo/telflo/charts'" \
  "[ $rc -eq 0 ] && [ \$(printf '%s\n' \"\$printed\" | grep -c '') -eq 1 ] && printf '%s\n' \"\$printed\" | grep -qE \"\$want_re\""
check "the package is supervisor-collector-0.1.0.tgz, made in a temporary directory removed afterwards" \
  "has 'supervisor-collector-0.1.0.tgz' && [ -z \"\$(ls '$tmp/scratch')\" ]"
check "the registry asked (crane manifest) for exactly the contracts' reference and version" \
  "[ \"\$(cat '$logs/crane-calls.log')\" = 'manifest ghcr.io/telflo/telflo/charts/supervisor-collector:0.1.0 ' ] && has 'is not in the registry yet'"
check "the render tests ran (helm template) and helm lint --strict for the three roles before packaging" \
  "helm_ran template && [ \$(grep -cE '^lint --strict [^ ]+/charts/supervisor-collector -f [^ ]+/values/(node|cluster|gateway)\.yaml' '$logs/helm-calls.log') -eq 3 ] && [ \"\$(last_line_of template)\" -lt \"\$(line_of package)\" ] && [ \"\$(last_line_of lint)\" -lt \"\$(line_of package)\" ]"
check "nothing pushed" "! helm_ran push && has 'dry run: nothing pushed'"
check "the registry read with a temporary configuration holding no login (both unset)" \
  "grep -qE '^HELM_REGISTRY_CONFIG=$tmp/scratch/publish-chart\.[A-Za-z0-9]+/registry\.json\$' '$logs/package-env' && grep -qx 'registry.json={\"auths\":{\"telflo-publish.invalid\":{}}}' '$logs/package-env' && grep -qE '^$tmp/scratch/publish-chart\.[A-Za-z0-9]+/docker\$' '$logs/crane-config.log' && grep -qx 'config.json={\"auths\":{\"telflo-publish.invalid\":{}}}' '$logs/package-env'"

mkdir -p "$tmp/caller-docker"; printf '%s\n' '{"auths":{"caller.invalid":{}}}' >"$tmp/caller-docker/config.json"
printf '%s\n' '{"auths":{"caller.invalid":{}}}' >"$tmp/caller-registry.json"
clear_logs
out="$(env -u TELFLO_HELM_CHART_REFERENCE TMPDIR="$tmp/scratch" HELM_REGISTRY_CONFIG="$tmp/caller-registry.json" DOCKER_CONFIG="$tmp/caller-docker" \
  HELM_DEBUG=true HELM_CONFIG_HOME="$tmp/caller-helm-config" "$shell" "$script" --dry-run 2>&1)"; rc=$?
check "the caller's HELM_REGISTRY_CONFIG and DOCKER_CONFIG used as given (crane reads DOCKER_CONFIG); other HELM_* settings unset" \
  "[ $rc -eq 0 ] && grep -qx 'HELM_REGISTRY_CONFIG=$tmp/caller-registry.json' '$logs/package-env' && grep -qx '$tmp/caller-docker' '$logs/crane-config.log' && grep -qx 'HELM_DEBUG=' '$logs/package-env' && grep -qE '^HELM_CONFIG_HOME=$tmp/scratch/publish-chart\.[A-Za-z0-9]+/helm/config\$' '$logs/package-env' && [ ! -e '$tmp/caller-helm-config' ]"

# --- 3. the registry's answers (crane manifest) ---------------------
STANDIN_CRANE=present run --dry-run
check "a version the registry holds refused (dry run): nothing printed" \
  "[ $rc -eq 1 ] && has 'is published already' && [ -z \"\$printed\" ]"
STANDIN_CRANE=denied run --dry-run
check "any other answer: the dry run says it can't tell, with crane's error line, and prints the push" \
  "[ $rc -eq 0 ] && has \"can't tell whether oci://ghcr.io/telflo/telflo/charts/supervisor-collector 0.1.0 is published\" && has 'DENIED' && ! has 'No matching credentials' && printf '%s\n' \"\$printed\" | grep -q '^helm push '"
STANDIN_CRANE=name-unknown run --dry-run --registry 127.0.0.1:5999
check "NAME_UNKNOWN is absent; --registry 127.0.0.1:<port>: <registry>/telflo/telflo/charts, the push with --plain-http" \
  "[ $rc -eq 0 ] && crane_read 127.0.0.1:5999/telflo/telflo/charts/supervisor-collector:0.1.0 && printf '%s\n' \"\$printed\" | grep -qE \"^helm push --plain-http '[^']+/supervisor-collector-0\\.1\\.0\\.tgz' 'oci://127\\.0\\.0\\.1:5999/telflo/telflo/charts'\\\$\""
clear_logs
out="$(env -u HELM_REGISTRY_CONFIG -u DOCKER_CONFIG TMPDIR="$tmp/scratch" TELFLO_HELM_CHART_REFERENCE=oci://ghcr.io/telflo/platform/charts/supervisor-collector "$shell" "$script" --dry-run --registry 127.0.0.1:5999 2>&1)"; rc=$?
check "TELFLO_HELM_CHART_REFERENCE refused with --registry" "[ $rc -eq 2 ] && has 'TELFLO_HELM_CHART_REFERENCE is refused' && no_helm && no_crane"

# --- 4. --package: every check but the registry's, then the package --------------------
pkg="$(fresh_pkg)"
run --package "$pkg"
want_sum="$(shasum -a 256 "$pkg/supervisor-collector-0.1.0.tgz" 2>/dev/null | cut -c1-64)"
check "--package writes <dir>/supervisor-collector-0.1.0.tgz and prints its path and sha256, one line" \
  "[ $rc -eq 0 ] && [ -f '$pkg/supervisor-collector-0.1.0.tgz' ] && [ \"\$printed\" = \"$pkg/supervisor-collector-0.1.0.tgz sha256:\$want_sum\" ] && [ \"\$(ls '$pkg')\" = supervisor-collector-0.1.0.tgz ]"
check "--package ran the render tests and lint first, asked no registry, pushed nothing" \
  "helm_ran template && helm_ran lint && helm_ran package && no_crane && ! helm_ran push && [ -z \"\$(ls '$tmp/scratch')\" ]"
tar -tzf "$pkg/supervisor-collector-0.1.0.tgz" >"$logs/package-files" 2>/dev/null
check "the package is the chart, without its tests" \
  "grep -qx 'supervisor-collector/Chart.yaml' '$logs/package-files' && grep -qx 'supervisor-collector/templates/secret.yaml' '$logs/package-files' && ! grep -q '/tests/' '$logs/package-files'"
run --package "$pkg"
check "--package refuses a package that exists (never overwritten)" "[ $rc -eq 1 ] && has 'exists: --package never overwrites' && ! helm_ran package"

# --- 4b. --push-package: that file, compared, pushed, compared again ------------------------
repack() { # <source tgz> <destination tgz> <sed expression on Chart.yaml> [<file to touch>]
  local d; d="$(mktemp -d "$tmp/repack.XXXXXX")"
  tar -xzf "$1" -C "$d" && sed -e "$3" "$d/supervisor-collector/Chart.yaml" >"$d/c" && mv "$d/c" "$d/supervisor-collector/Chart.yaml"
  [ -z "${4:-}" ] || printf '# changed\n' >>"$d/supervisor-collector/$4"
  (cd "$d" && tar -czf "$2" supervisor-collector)
}
the_package="$pkg/supervisor-collector-0.1.0.tgz"
mkdir -p "$tmp/other-version" "$tmp/other-bytes"
repack "$the_package" "$tmp/other-version/supervisor-collector-0.1.1.tgz" 's/^version: .*/version: 0.1.1/'
repack "$the_package" "$tmp/other-bytes/supervisor-collector-0.1.0.tgz" 's/^version: /version: /' values.yaml
run --push-package "$tmp/other-version/supervisor-collector-0.1.1.tgz"
check "a package whose version isn't HEAD's Chart.yaml's refused before the registry" \
  "[ $rc -eq 1 ] && has \"version '0.1.1', but HEAD's charts/supervisor-collector/Chart.yaml is 0.1.0\" && no_crane && ! helm_ran push"
pkg_t="$(fresh_pkg)"; mkdir -p "$pkg_t/x/telflo"
printf 'apiVersion: v2\nname: telflo\nversion: 0.1.0\nappVersion: "0.1.0"\n' >"$pkg_t/x/telflo/Chart.yaml"
(cd "$pkg_t/x" && tar -czf "$pkg_t/telflo-0.1.0.tgz" telflo)
run --push-package "$pkg_t/telflo-0.1.0.tgz"
check "telflo's package with --chart supervisor-collector refused" "[ $rc -eq 1 ] && has 'must hold one top-level folder, supervisor-collector' && no_crane && ! helm_ran push"
clear_logs
out="$(env -u HELM_REGISTRY_CONFIG -u DOCKER_CONFIG TMPDIR="$tmp/scratch" TELFLO_HELM_CHART_REFERENCE=oci://ghcr.io/telflo/telflo/charts/supervisor-collector "$shell" "$script" --push-package "$the_package" 2>&1)"; rc=$?
check "TELFLO_HELM_CHART_REFERENCE refused with --push-package (its destination is fixed)" "[ $rc -eq 2 ] && has 'TELFLO_HELM_CHART_REFERENCE is refused' && no_crane"
STANDIN_CRANE=denied run --push-package "$the_package"
check "--push-package refuses when the registry can't tell (DENIED), nothing pushed" \
  "[ $rc -eq 1 ] && has \"can't tell whether oci://ghcr.io/telflo/telflo/charts/supervisor-collector:0.1.0 is published\" && ! helm_ran push"
STANDIN_CRANE=present STANDIN_DIGEST="sha256:$want_sum" run --push-package "$the_package"
check "--push-package skips a version whose chart layer is this package's sha256, nothing pushed" \
  "[ $rc -eq 0 ] && has 'holds this package already' && [ \"\$printed\" = 'oci://ghcr.io/telflo/telflo/charts/supervisor-collector:0.1.0 sha256:$want_sum' ] && ! helm_ran push"
STANDIN_CRANE=present run --push-package "$the_package"
check "--push-package refuses a version published with another content digest, nothing pushed" \
  "[ $rc -eq 1 ] && has 'is published already with sha256:1111' && has 'nothing pushed' && ! helm_ran push"

push_ok=false
if tr_tools "$root" && [ -n "$real_crane" ]; then
  if tr_registry_start "$tmp/registry"; then push_ok=true; else TR_SKIP="the throwaway registry didn't start"; fi
fi
if $push_ok; then
  REG="$TR_REGISTRY"
  rpush() { # <tgz> [args]: the real Helm and crane with the registry's login
    local f="$1"; shift
    clear_logs
    printed="$(env -u TELFLO_HELM_CHART_REFERENCE TMPDIR="$tmp/scratch" STANDIN_CRANE='' STANDIN_PUSH=real \
      HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" DOCKER_CONFIG="$TR_CONFIG" "$shell" "$script" --push-package "$f" --registry "$REG" "$@" 2>"$tmp/stderr")"
    rc=$?
    out="$(printf '%s\n' "$printed"; cat "$tmp/stderr")"
    printf '%s\n' "$out" >>"$logs/all-output.log"
  }
  layer() { DOCKER_CONFIG="$TR_CONFIG" "$real_crane" manifest "$REG/telflo/telflo/charts/supervisor-collector:0.1.0" 2>/dev/null \
    | python3 -I -c 'import json,sys; print([l["digest"] for l in json.load(sys.stdin)["layers"] if l["mediaType"].endswith("chart.content.v1.tar+gzip")][0])' 2>/dev/null; }
  rpush "$the_package"
  check "--push-package pushes the file (real helm, --plain-http, oci://$REG/telflo/telflo/charts); the chart layer is its sha256" \
    "[ $rc -eq 0 ] && [ \"\$printed\" = 'oci://$REG/telflo/telflo/charts/supervisor-collector:0.1.0 sha256:$want_sum' ] && [ \"\$(layer)\" = 'sha256:$want_sum' ] && [ \"\$(tr '\n' ' ' <'$logs/push-args')\" = 'push --plain-http $the_package oci://$REG/telflo/telflo/charts ' ]"
  check "the registry asked before and after the push" "[ \$(grep -c '^manifest $REG/telflo/telflo/charts/supervisor-collector:0.1.0 ' '$logs/crane-calls.log') -eq 2 ]"
  rpush "$the_package"
  check "a re-run skips the published version (the same sha256): helm push not run" "[ $rc -eq 0 ] && has 'holds this package already' && ! helm_ran push"
  rpush "$tmp/other-bytes/supervisor-collector-0.1.0.tgz"
  check "another package of the same version (another sha256) refused: helm push not run, the chart unchanged" \
    "[ $rc -eq 1 ] && has 'is published already with sha256:$want_sum' && ! helm_ran push && [ \"\$(layer)\" = 'sha256:$want_sum' ]"
  if [ "$TR_AUTH" = 1 ]; then
    clear_logs
    out="$(env -u TELFLO_HELM_CHART_REFERENCE TMPDIR="$tmp/scratch" STANDIN_CRANE='' HELM_REGISTRY_CONFIG="$tmp/stub/config.json" DOCKER_CONFIG="$tmp/stub" \
      "$shell" "$script" --push-package "$the_package" --registry "$REG" 2>&1)"; rc=$?
    check "a registry that answers UNAUTHORIZED (no login): can't tell, refused, nothing pushed" "[ $rc -eq 1 ] && has 'UNAUTHORIZED' && ! helm_ran push"
    check "no file of the test's work folder or output holds the registry's test credential (boolean)" \
      "! tr_secret_in '$tmp/scratch' '$logs' '$tmp/stderr' '$pkg' '$repo'"
  else
    skip "the UNAUTHORIZED and credential cases" "no htpasswd: the throwaway registry has no login"
  fi
else
  for c in "the push and its chart layer" "the skip of the same package" "the refusal of another sha256" "the UNAUTHORIZED and credential cases"; do
    skip "--push-package: $c" "${TR_SKIP:-no crane}"
  done
fi
tr_registry_stop

# --- 5. a failing render test stops everything ------------------------------------------------
make_copy; edit "$copy/charts/supervisor-collector/values.yaml" 's#^  repository: ghcr.io/telflo/telflo/collector$#  repository: registry.invalid/other/collector#'
commit_copy
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a failing render test stops it: nothing linted by the script, packaged, asked or pushed" \
  "[ $rc -eq 1 ] && has 'render tests failed' && helm_ran template && ! helm_ran package && no_crane && ! helm_ran push && [ -z \"\$printed\" ]"

# --- 5b. what is published is exactly what is committed ---------------------------
dirty_case() { # <name> <path relative to the repository> <append|new> [mode]
  local name="$1" path="$2" how="$3" mode="${4:---dry-run}"
  if [ "$how" = append ]; then cp "$repo/$path" "$tmp/saved"; echo "# a change" >>"$repo/$path"; else echo "# new" >"$repo/$path"; fi
  run $mode
  check "$name" "[ $rc -eq 1 ] && has \"refuses uncommitted changes in the chart's inputs\" && has '$path' && no_helm && [ -z \"\$printed\" ]"
  if [ "$how" = append ]; then cp "$tmp/saved" "$repo/$path"; else rm -f "$repo/$path"; fi
}
dirty_case "a changed chart file refused (dry run)" charts/supervisor-collector/values.yaml append
mkdir -p "$tmp/pkg-dirty"
dirty_case "a changed chart file refused (--package)" charts/supervisor-collector/templates/secret.yaml append "--package $tmp/pkg-dirty"
dirty_case "a new chart file refused" charts/supervisor-collector/templates/extra.yaml new
dirty_case "a changed helm.ts refused" "$HELM_TS" append
dirty_case "a changed publish-chart.sh refused" scripts/publish-chart.sh append
check "the repository is clean again" "[ -z \"\$(git -C '$repo' status --porcelain 2>&1)\" ]"
make_plain_copy
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a tree that isn't a git checkout refused" "[ $rc -eq 1 ] && has 'needs a git checkout' && no_helm && [ -z \"\$printed\" ]"
parent="$tmp/parent"
mkdir -p "$parent"; printf 'nested/\n' >"$parent/.gitignore"
git_in "$parent" init -q && git_in "$parent" add -A && git_in "$parent" commit -q -m parent
cp -R "$copy" "$parent/nested"
run_script "$parent/nested/scripts/publish-chart.sh" --dry-run
check "a copy nested in another repository that ignores it refused (the toplevel must be its own)" \
  "[ -z \"\$(git -C '$parent' status --porcelain)\" ] && [ $rc -eq 1 ] && has 'needs a git checkout' && no_helm && [ -z \"\$printed\" ]"

# --- 5c. the chart is taken from the commit itself -------------------------------
mkdir -p "$repo/charts/supervisor-collector/build"
echo "IGNORED=c4n4ry" >"$repo/charts/supervisor-collector/.env"
echo ignored >"$repo/charts/supervisor-collector/.DS_Store"
echo ignored >"$repo/charts/supervisor-collector/build/x"
head_chart_files="$(git -C "$repo" ls-tree -r --name-only HEAD charts/supervisor-collector | grep -v '^charts/supervisor-collector/tests/' | sed 's#^charts/#supervisor-collector/#; s#^supervisor-collector/supervisor-collector/#supervisor-collector/#' | sort)"
run --package "$(fresh_pkg)"
tar -tzf "${printed%% *}" >"$logs/push-package-files" 2>/dev/null
check "files the repository ignores (.env, .DS_Store, build/x) are not packaged: the package is HEAD's chart minus tests/" \
  "[ $rc -eq 0 ] && [ -z \"\$(git -C '$repo' status --porcelain)\" ] && [ -n \"\$head_chart_files\" ] && [ \"\$(sort '$logs/push-package-files')\" = \"\$head_chart_files\" ] && ! grep -qE '/(\.env|\.DS_Store|build/x)\$' '$logs/push-package-files'"
check "lint and package ran on the extraction, not the working tree" \
  "! grep -qF '$repo/charts' '$logs/helm-calls.log' && grep -qE '^package [^ ]+/source/charts/supervisor-collector ' '$logs/helm-calls.log'"
rm -rf "$repo/charts/supervisor-collector/build" "$repo/charts/supervisor-collector/.env" "$repo/charts/supervisor-collector/.DS_Store"

# --- 5d. credential files the caller named ------------------------------
# The valid shape names a registry in a non-empty "auths"; Docker and oras
# read keys case-insensitively.
cred_case() { # <name> <variable> <content, "-" for no file, "-unreadable" for mode 000> <expected words>
  local d="$tmp/cred-$RANDOM$RANDOM"
  mkdir -p "$d/docker"
  printf '%s\n' '{"auths":{"x.invalid":{}}}' >"$d/registry.json"; printf '%s\n' '{"auths":{"x.invalid":{}}}' >"$d/docker/config.json"
  if [ "$2" = HELM_REGISTRY_CONFIG ]; then f="$d/registry.json"; else f="$d/docker/config.json"; fi
  case "$3" in
    -) rm -f "$f" ;;
    -unreadable) chmod 000 "$f" ;;
    *) printf '%s\n' "$3" >"$f" ;;
  esac
  clear_logs
  out="$(env -u TELFLO_HELM_CHART_REFERENCE TMPDIR="$tmp/scratch" HELM_REGISTRY_CONFIG="$d/registry.json" DOCKER_CONFIG="$d/docker" \
    "$shell" "$script" --dry-run 2>&1)"; rc=$?
  check "$1" "[ $rc -eq 1 ] && has '$2: its file' && has \"$4\" && ! has 'c4n4ry' && no_helm"
  chmod 600 "$f" 2>/dev/null
}
for variable in HELM_REGISTRY_CONFIG DOCKER_CONFIG; do
  cred_case "$variable: a missing file refused" $variable - "is missing"
  cred_case "$variable: a file that can't be read refused" $variable -unreadable "can't be read"
  cred_case "$variable: a file that isn't JSON refused" $variable 'c4n4ry {' "isn't JSON"
  cred_case "$variable: a file without an auths object refused" $variable '{"c4n4ry":1}' 'has no \"auths\" object'
  cred_case "$variable: a file that isn't an object refused" $variable '[1]' 'has no \"auths\" object'
  cred_case "$variable: an empty auths refused" $variable '{"auths":{}}' 'has an empty \"auths\" object'
  cred_case "$variable: credsStore refused" $variable '{"auths":{"x.invalid":{}},"credsStore":"c4n4ry"}' "names a credential store or helper"
  cred_case "$variable: credHelpers refused" $variable '{"auths":{"x.invalid":{}},"credHelpers":{"ghcr.io":"c4n4ry"}}' "names a credential store or helper"
  cred_case "$variable: CredsStore refused (any spelling)" $variable '{"auths":{"x.invalid":{}},"CredsStore":"c4n4ry"}' "names a credential store or helper"
  cred_case "$variable: credsstore refused (any spelling)" $variable '{"auths":{"x.invalid":{}},"credsstore":"c4n4ry"}' "names a credential store or helper"
  cred_case "$variable: CredHelpers refused (any spelling)" $variable '{"auths":{"x.invalid":{}},"CredHelpers":{"ghcr.io":"c4n4ry"}}' "names a credential store or helper"
  cred_case "$variable: an AUTHS key refused" $variable '{"auths":{"x.invalid":{}},"AUTHS":{"c4n4ry.invalid":{}}}' 'spelled like \"auths\"'
done

# --- 5e. inputs flagged for git not to check --------------------------------------
cp "$repo/charts/supervisor-collector/values.yaml" "$tmp/saved-values"
git -C "$repo" update-index --assume-unchanged charts/supervisor-collector/values.yaml
echo "# a hidden change" >>"$repo/charts/supervisor-collector/values.yaml"
run --dry-run
check "an input flagged assume-unchanged refused, the flag named" \
  "[ $rc -eq 1 ] && has 'assume-unchanged: charts/supervisor-collector/values.yaml' && no_helm && [ -z \"\$printed\" ]"
cp "$tmp/saved-values" "$repo/charts/supervisor-collector/values.yaml"
git -C "$repo" update-index --no-assume-unchanged charts/supervisor-collector/values.yaml
git -C "$repo" update-index --skip-worktree "$HELM_TS"
run --dry-run
check "an input flagged skip-worktree refused, the flag named" \
  "[ $rc -eq 1 ] && has 'skip-worktree: $HELM_TS' && no_helm && [ -z \"\$printed\" ]"
git -C "$repo" update-index --no-skip-worktree "$HELM_TS"
check "the throwaway repository is clean again (no flag)" "[ -z \"\$(git -C '$repo' status --porcelain)\" ] && ! git -C '$repo' ls-files -v | grep -q '^[a-zS]'"

# --- 5f. HEAD's raw blobs, whatever the local git setup ---------------------------
# A local smudge filter (on values.yaml and the templates: a YAML comment
# appended) and core.autocrlf=true change what `git archive` writes; the
# package must hold HEAD's blobs byte for byte (Chart.yaml aside: Helm
# rewrites it from its fields).
make_copy; frepo="$copy"
printf 'charts/supervisor-collector/values.yaml filter=telflotest\ncharts/supervisor-collector/templates/* filter=telflotest\n' \
  >"$frepo/.git/info/attributes"
git -C "$frepo" config filter.telflotest.smudge 'cat; echo "# SMUDGED"'
git -C "$frepo" config core.autocrlf true
blob_of() { git -C "$frepo" cat-file blob "HEAD:$1"; }
check "the local setup changes git archive's output (this test's premise)" \
  "! git -C '$frepo' archive HEAD charts/supervisor-collector/values.yaml | tar -xOf - | cmp -s - <(blob_of charts/supervisor-collector/values.yaml)"
rm -f "$logs/pushed.tgz"
run_script "$frepo/scripts/publish-chart.sh" --package "$(fresh_pkg)"
cp "${printed%% *}" "$logs/pushed.tgz" 2>/dev/null
mkdir -p "$tmp/pushed"
tar -xzf "$logs/pushed.tgz" -C "$tmp/pushed" 2>/dev/null
package_equals_head() {
  local f n=0
  while IFS= read -r f; do
    case "$f" in */tests/* | */Chart.yaml) continue ;; esac
    cmp -s "$tmp/pushed/supervisor-collector/${f#charts/supervisor-collector/}" <(blob_of "$f") || return 1
    n=$((n + 1))
  done <<<"$(git -C "$frepo" ls-tree -r --name-only HEAD charts/supervisor-collector)"
  [ "$n" -gt 5 ]
}
check "the pushed package holds HEAD's raw blobs, byte for byte (no smudge, no CRLF)" \
  "[ -z \"\$(git -C '$frepo' status --porcelain)\" ] && [ $rc -eq 0 ] && package_equals_head"
GIT_DIR="$tmp/nonexistent" GIT_INDEX_FILE="$tmp/nonexistent-index" run --dry-run
check "inherited GIT_* settings are ignored" "[ $rc -eq 0 ] && printf '%s\n' \"\$printed\" | grep -q '^helm push '"
make_copy
ln -s values.yaml "$copy/charts/supervisor-collector/values-link.yaml"
commit_copy
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a symlink in HEAD's chart refused, named, before Helm runs" \
  "[ -z \"\$(git -C '$copy' status --porcelain)\" ] && [ $rc -eq 1 ] && has \"HEAD's charts/supervisor-collector/values-link.yaml is a symlink\" && no_helm && [ -z \"\$printed\" ]"

# --- 5g. local git objects and untracked files ----------------------------------
make_copy; rrepo="$copy"
real_blob="$(git -C "$rrepo" rev-parse HEAD:charts/supervisor-collector/values.yaml)"
fake_blob="$(cat "$rrepo/charts/supervisor-collector/values.yaml" <(echo '# replaced') | git -C "$rrepo" hash-object -w --stdin)"
git -C "$rrepo" replace "$real_blob" "$fake_blob"
check "a replace ref changes what git cat-file gives (this test's premise)" \
  "git -C '$rrepo' cat-file blob HEAD:charts/supervisor-collector/values.yaml | grep -q '^# replaced'"
rm -f "$logs/pushed.tgz"; rm -rf "$tmp/pushed-r"; mkdir -p "$tmp/pushed-r"
run_script "$rrepo/scripts/publish-chart.sh" --package "$(fresh_pkg)"
cp "${printed%% *}" "$logs/pushed.tgz" 2>/dev/null
tar -xzf "$logs/pushed.tgz" -C "$tmp/pushed-r" 2>/dev/null
check "the pushed values.yaml is HEAD's real blob, not the replacement" \
  "[ -z \"\$(git -C '$rrepo' status --porcelain)\" ] && [ $rc -eq 0 ] && cmp -s '$tmp/pushed-r/supervisor-collector/values.yaml' <(GIT_NO_REPLACE_OBJECTS=1 git -C '$rrepo' cat-file blob '$real_blob')"
# A tampered object store: values.yaml's loose object overwritten
# with Chart.yaml's. git cat-file hands over the other blob's bytes and git
# status stays clean; only the hash check sees it.
make_copy; trepo="$copy"
loose_object() { # <repo> <sha>
  printf '%s/.git/objects/%s/%s' "$1" "$(printf '%s' "$2" | cut -c1-2)" "$(printf '%s' "$2" | cut -c3-)"
}
victim="$(loose_object "$trepo" "$(git -C "$trepo" rev-parse HEAD:charts/supervisor-collector/values.yaml)")"
donor="$(loose_object "$trepo" "$(git -C "$trepo" rev-parse HEAD:charts/supervisor-collector/Chart.yaml)")"
[ -f "$victim" ] && [ -f "$donor" ] && chmod u+w "$victim" && cp "$donor" "$victim"
check "an overwritten loose object changes what git cat-file gives, status clean (this test's premise)" \
  "[ -z \"\$(git -C '$trepo' status --porcelain)\" ] && git -C '$trepo' cat-file blob HEAD:charts/supervisor-collector/values.yaml | cmp -s - '$trepo/charts/supervisor-collector/Chart.yaml'"
run_script "$trepo/scripts/publish-chart.sh" --dry-run
check "a tampered loose blob refused by the hash check, named, before Helm runs" \
  "[ $rc -eq 1 ] && has \"HEAD's charts/supervisor-collector/values.yaml doesn't hash to its tree entry\" && no_helm && [ -z \"\$printed\" ]"
make_copy; git -C "$copy" config status.showUntrackedFiles no
echo "# new" >"$copy/charts/supervisor-collector/templates/hidden.yaml"
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "an untracked chart file refused even with status.showUntrackedFiles=no" \
  "[ -z \"\$(git -C '$copy' status --porcelain)\" ] && [ $rc -eq 1 ] && has 'refuses uncommitted changes' && has 'charts/supervisor-collector/templates/hidden.yaml' && no_helm"
# A git error midway through HEAD's listing: the templates/
# tree object made unreadable. git status stays clean; git ls-tree lists
# Chart.yaml and then fails. The script refuses: no truncated chart packaged.
make_copy
unreadable="$(loose_object "$copy" "$(git -C "$copy" rev-parse HEAD:charts/supervisor-collector/templates)")"
[ -f "$unreadable" ] && chmod 000 "$unreadable"
check "an unreadable tree object: status clean, git ls-tree fails midway after listing a file (this test's premise)" \
  "[ -z \"\$(git -C '$copy' status --porcelain)\" ] && ! git -C '$copy' ls-tree -r -z --full-tree HEAD -- charts/supervisor-collector >'$tmp/premise.list' 2>/dev/null && [ -s '$tmp/premise.list' ]"
run_script "$copy/scripts/publish-chart.sh" --package "$(fresh_pkg)"
check "a git ls-tree failing midway refused, before Helm runs: nothing packaged or pushed" \
  "[ $rc -eq 1 ] && has \"can't list HEAD's charts/supervisor-collector (git ls-tree failed)\" && no_helm && ! helm_ran push && [ -z \"\$printed\" ] && [ -z \"\$(ls '$tmp/scratch')\" ]"
chmod 644 "$unreadable" 2>/dev/null
make_copy
mkdir -p "$copy/charts/supervisor-collector/sub"
git -C "$copy" update-index --add --cacheinfo "160000,$(git -C "$copy" rev-parse HEAD),charts/supervisor-collector/sub"
git_in "$copy" commit -q -m gitlink
run_script "$copy/scripts/publish-chart.sh" --dry-run
check "a submodule in HEAD's chart refused, named, before Helm runs" \
  "[ -z \"\$(git -C '$copy' status --porcelain)\" ] && [ $rc -eq 1 ] && has \"HEAD's charts/supervisor-collector/sub is a submodule\" && no_helm && [ -z \"\$printed\" ]"

# --- 6. the real crane and Helm with the scripts' argv, offline ---------------------------
clear_logs
out="$(env -u HELM_REGISTRY_CONFIG -u DOCKER_CONFIG -u TELFLO_HELM_CHART_REFERENCE TMPDIR="$tmp/scratch" STANDIN_CRANE='' \
  "$shell" "$script" --dry-run --registry 127.0.0.1:1 2>"$tmp/stderr")"; rc=$?
printed="$out"; out="$(printf '%s\n' "$printed"; cat "$tmp/stderr")"
before=$failures
if [ -n "$real_crane" ]; then
  check "the real crane (127.0.0.1:1): connection refused is 'can't tell'; the push printed to <registry>/telflo/telflo/charts" \
    "[ $rc -eq 0 ] && has \"can't tell whether\" && has 'connection refused' && printf '%s\n' \"\$printed\" | grep -qE \"'oci://127\\.0\\.0\\.1:1/telflo/telflo/charts'\\\$\""
else
  skip "the real crane's read" "no crane"
fi
[ "$failures" -eq "$before" ] || explain
clear_logs
out="$(env -u HELM_REGISTRY_CONFIG -u DOCKER_CONFIG -u TELFLO_HELM_CHART_REFERENCE TMPDIR="$tmp/scratch" STANDIN_CRANE=absent STANDIN_PUSH=real \
  "$shell" "$script" --push-package "$the_package" --registry 127.0.0.1:1 2>"$tmp/stderr")"; rc=$?
printed="$out"; out="$(printf '%s\n' "$printed"; cat "$tmp/stderr")"
before=$failures
check "the real helm push takes the script's argv (--plain-http, the package, the destination; it gets as far as the connection, refused)" \
  "[ $rc -ne 0 ] && [ \"\$(tr '\n' ' ' <'$logs/push-args')\" = 'push --plain-http $the_package oci://127.0.0.1:1/telflo/telflo/charts ' ] && has 'connection refused' && has 'helm push failed' && ! printf '%s\n' \"\$out\" | grep -qiE 'unknown (flag|command|shorthand)|usage:|accepts .* arg'"
[ "$failures" -eq "$before" ] || explain

# --- 7. telflo's row -------------------------
PLATFORM=charts/telflo
# The platform chart's real version (its Chart.yaml; the copies are of this tree).
PLATFORM_VERSION="$(awk '$1 == "version:" { print $2; exit }' "$root/$PLATFORM/Chart.yaml")"
[ -n "$PLATFORM_VERSION" ] || { echo "no version in $PLATFORM/Chart.yaml" >&2; exit 1; }
PLATFORM_VERSION_RE="$(printf '%s' "$PLATFORM_VERSION" | sed 's/\./\\./g')"
SUB=charts/telflo/charts/opamp-server
PIN=vendor/opamp-server/PIN
prun() { run "$@" --chart telflo; }
pin_tree_of() { sed -n 's/^chart-tree=//p' "$1/$PIN"; }
# The pinned opamp-server version, read from the real PIN, never written
# here, and two others for the mismatch
# cases, never equal to it.
OPAMP_VERSION="$(sed -n 's/^version=\([0-9][0-9.]*\)$/\1/p' "$root/$PIN")"
[ -n "$OPAMP_VERSION" ] || { echo "FAIL - $PIN names no version"; exit 1; }
OPAMP_OTHER=99.0.1
OPAMP_OTHER2=99.0.2
if [ "$OPAMP_VERSION" = "$OPAMP_OTHER" ] || [ "$OPAMP_VERSION" = "$OPAMP_OTHER2" ]; then OPAMP_OTHER=98.0.1; OPAMP_OTHER2=98.0.2; fi
# The version as a sed basic regular expression (its dots escaped).
OPAMP_VERSION_RE="$(printf '%s' "$OPAMP_VERSION" | sed 's/\./\\./g')"

# 7a. the argument, and the refusals before anything runs (exit 2, Helm never called)
run --help
check "the usage text names --chart and both charts" \
  "[ $rc -eq 0 ] && has 'each with --chart <name>: supervisor-collector (the default) or telflo'"
run --dry-run --chart bogus
check "an unknown chart refused" "[ $rc -eq 2 ] && has \"unknown chart: 'bogus'\" && no_helm"
run --dry-run --chart
check "--chart without a name refused" "[ $rc -eq 2 ] && has \"--chart needs a chart's name\" && no_helm"
run --dry-run --chart telflo --chart supervisor-collector
check "--chart twice refused" "[ $rc -eq 2 ] && has '--chart given more than once' && no_helm"
for bad in telflo/telflo telflo-platform "" platform Telflo; do
  run --dry-run --chart telflo --namespace "$bad"
  check "--namespace '$bad' refused (only telflo or telflo-staging)" \
    "[ $rc -eq 2 ] && has '--namespace must be telflo (the public one) or telflo-staging' && no_helm && no_crane"
done
run --dry-run --namespace telflo-staging
check "--namespace telflo-staging for the supervisor-collector chart refused (it is published to the public namespace alone)" \
  "[ $rc -eq 2 ] && has 'goes with --chart telflo only' && no_helm && no_crane"
run --package "$tmp" --chart telflo --namespace telflo-staging
check "--namespace with --package refused (it reads no registry)" \
  "[ $rc -eq 2 ] && has '--namespace goes with --dry-run and --push-package only' && no_helm"
make_copy; edit "$copy/$PLATFORM/Chart.yaml" 's/^appVersion: .*/appVersion: "9.9.9"/'
run_script "$copy/scripts/publish-chart.sh" --dry-run --chart telflo
check "telflo: an appVersion not the version refused" \
  "[ $rc -eq 2 ] && has \"Chart.yaml's appVersion '9.9.9' is not its version '$PLATFORM_VERSION'\" && no_helm"
make_copy; edit "$copy/$PLATFORM/Chart.yaml" 's/^version: .*/version: 0.1.0-rc.1/; s/^appVersion: .*/appVersion: "0.1.0-rc.1"/'
run_script "$copy/scripts/publish-chart.sh" --dry-run --chart telflo
check "telflo: a version that isn't x.y.z refused" "[ $rc -eq 2 ] && has \"Chart.yaml's version must be x.y.z\" && no_helm"
clear_logs
out="$(env -u HELM_REGISTRY_CONFIG -u DOCKER_CONFIG TMPDIR="$tmp/scratch" TELFLO_HELM_CHART_REFERENCE=oci://127.0.0.1:1/charts/telflo \
  "$shell" "$script" --dry-run --chart telflo 2>&1)"; rc=$?
check "telflo: TELFLO_HELM_CHART_REFERENCE refused (its reference is fixed)" \
  "[ $rc -eq 2 ] && has 'TELFLO_HELM_CHART_REFERENCE is refused' && no_helm"
make_copy
edit "$copy/scripts/publish-chart.sh" 's#^PLATFORM_REFERENCE="oci://ghcr.io/telflo/telflo/charts/telflo"$#PLATFORM_REFERENCE="oci://ghcr.io/telflo/charts/telflo"#'
run_script "$copy/scripts/publish-chart.sh" --dry-run --chart telflo
check "telflo: a reference under the older oci://ghcr.io/telflo/charts/ refused" \
  "grep -q '^PLATFORM_REFERENCE=\"oci://ghcr.io/telflo/charts/telflo\"\$' '$copy/scripts/publish-chart.sh' && [ $rc -eq 2 ] && has \"an older registry path that isn't this repository's\" && no_helm"

# 7b. a dry run: the vendored chart checked, the render tests, lint per profile, the exact push
prun --dry-run
platform_re="^helm push '$tmp/scratch/publish-chart\.[A-Za-z0-9]+/package/telflo-$PLATFORM_VERSION_RE\.tgz' 'oci://ghcr\.io/telflo/telflo/charts'\$"
profiles_n="$(ls "$repo/$PLATFORM/tests/profiles/"*.yaml | grep -c '')"
script_lint_re="^lint --strict [^ ]+/source/charts/telflo -f [^ ]+/source/charts/telflo/tests/profiles/[a-z0-9-]+\.yaml \$"
check "telflo: a dry run prints exactly: helm push '<package>' 'oci://ghcr.io/telflo/telflo/charts'" \
  "[ $rc -eq 0 ] && [ \$(printf '%s\n' \"\$printed\" | grep -c '') -eq 1 ] && printf '%s\n' \"\$printed\" | grep -qE \"\$platform_re\" && [ -z \"\$(ls '$tmp/scratch')\" ]"
check "telflo: the registry asked (crane manifest) for ghcr.io/telflo/telflo/charts/telflo:$PLATFORM_VERSION" \
  "[ \"\$(cat '$logs/crane-calls.log')\" = 'manifest ghcr.io/telflo/telflo/charts/telflo:$PLATFORM_VERSION ' ] && has 'is not in the registry yet'"
check "telflo: the vendored chart checked against HEAD's PIN first" \
  "has \"the vendored opamp-server chart is vendor/opamp-server/PIN's: tree \$(pin_tree_of '$repo'), version $OPAMP_VERSION\""
check "telflo: the render tests, then helm lint --strict once per profile (not --with-subcharts), on the extraction, before packaging" \
  "helm_ran template && [ \$(grep -cE \"\$script_lint_re\" '$logs/helm-calls.log') -eq $profiles_n ] && [ $profiles_n -ge 5 ] && ! grep -q -- '--with-subcharts' '$logs/helm-calls.log' && [ \"\$(last_line_of template)\" -lt \"\$(grep -nE \"\$script_lint_re\" '$logs/helm-calls.log' | head -n 1 | cut -d: -f1)\" ] && [ \"\$(grep -nE \"\$script_lint_re\" '$logs/helm-calls.log' | tail -n 1 | cut -d: -f1)\" -lt \"\$(line_of package)\" ] && ! grep -qF '$repo/charts' '$logs/helm-calls.log' && ! helm_ran push"

# 7c. --package: the package is HEAD's chart, the vendored one in it, no tests
platform_pkg="$(fresh_pkg)"
prun --package "$platform_pkg"
platform_files="$(git -C "$repo" ls-tree -r --name-only HEAD "$PLATFORM" | grep -vE '^charts/telflo/(charts/opamp-server/)?tests/' | sed 's#^charts/##' | sort)"
tar -tzf "$platform_pkg/telflo-$PLATFORM_VERSION.tgz" >"$logs/push-package-files" 2>/dev/null
check "telflo: --package writes <dir>/telflo-$PLATFORM_VERSION.tgz and prints its path and sha256" \
  "[ $rc -eq 0 ] && [ \"\$printed\" = \"$platform_pkg/telflo-$PLATFORM_VERSION.tgz sha256:\$(shasum -a 256 '$platform_pkg/telflo-$PLATFORM_VERSION.tgz' | cut -c1-64)\" ] && no_crane && ! helm_ran push"
check "telflo: the package is HEAD's chart with the vendored opamp-server chart, without either's tests" \
  "grep -qx 'telflo/charts/opamp-server/Chart.yaml' '$logs/push-package-files' && ! grep -q '/tests/' '$logs/push-package-files' && [ \"\$(sort '$logs/push-package-files')\" = \"\$platform_files\" ]"
STANDIN_CRANE=absent STANDIN_PUSH=ok run --push-package "$platform_pkg/telflo-$PLATFORM_VERSION.tgz" --chart telflo
check "telflo: --push-package pushes that file to oci://ghcr.io/telflo/telflo/charts (no --plain-http for ghcr.io), with a temporary configuration holding no login, then reads it back (here: still absent, refused)" \
  "[ $rc -eq 1 ] && has 'after the push' && [ \"\$(tr '\n' ' ' <'$logs/push-args')\" = 'push $platform_pkg/telflo-$PLATFORM_VERSION.tgz oci://ghcr.io/telflo/telflo/charts ' ] && grep -qx 'registry.json={\"auths\":{\"telflo-publish.invalid\":{}}}' '$logs/push-env' && crane_read ghcr.io/telflo/telflo/charts/telflo:$PLATFORM_VERSION"

STANDIN_CRANE=absent STANDIN_PUSH=ok run --push-package "$platform_pkg/telflo-$PLATFORM_VERSION.tgz" --chart telflo --namespace telflo-staging
check "telflo: --push-package --namespace telflo-staging pushes that file to a release's stage, oci://ghcr.io/telflo/telflo-staging/charts, and reads it back there" \
  "[ $rc -eq 1 ] && has 'after the push' && [ \"\$(tr '\n' ' ' <'$logs/push-args')\" = 'push $platform_pkg/telflo-$PLATFORM_VERSION.tgz oci://ghcr.io/telflo/telflo-staging/charts ' ] && crane_read ghcr.io/telflo/telflo-staging/charts/telflo:$PLATFORM_VERSION && ! grep -q 'ghcr.io/telflo/telflo/charts' '$logs/crane-calls.log'"
STANDIN_CRANE=absent prun --dry-run --namespace telflo-staging
check "telflo: a dry run with --namespace telflo-staging asks the stage and prints its push" \
  "[ $rc -eq 0 ] && [ \"\$(cat '$logs/crane-calls.log')\" = 'manifest ghcr.io/telflo/telflo-staging/charts/telflo:$PLATFORM_VERSION ' ] && printf '%s\n' \"\$printed\" | grep -qE \"'oci://ghcr\\.io/telflo/telflo-staging/charts'\\\$\""

# 7d. the vendored chart's tree and version, on HEAD's extraction, before Helm runs (exit 1)
vendoring_refused() { # <name> <expected words>
  run_script "$copy/scripts/publish-chart.sh" --dry-run --chart telflo
  check "$1" "[ -z \"\$(git -C '$copy' status --porcelain)\" ] && [ $rc -eq 1 ] && has \"$2\" && no_helm && [ -z \"\$printed\" ]"
}
make_copy; echo "# a change" >>"$copy/$SUB/values.yaml"; commit_copy
vendoring_refused "telflo: a vendored chart that isn't the PIN's chart-tree refused" \
  "HEAD's $SUB is tree \$(git -C '$copy' rev-parse HEAD:$SUB), but $PIN's chart-tree is \$(pin_tree_of '$copy')"
make_copy; edit "$copy/$PIN" 's/^chart-tree=.*/chart-tree=0123456789abcdef0123456789abcdef01234567/'; commit_copy
vendoring_refused "telflo: a PIN whose chart-tree isn't the vendored chart's refused" \
  "but $PIN's chart-tree is 0123456789abcdef0123456789abcdef01234567"
make_copy; edit "$copy/$PIN" '/^chart-tree=/d'; commit_copy
vendoring_refused "telflo: a PIN without its chart-tree refused" "must have exactly one valid chart-tree= line, found 0"
make_copy; edit "$copy/$PLATFORM/Chart.yaml" "s/^    version: $OPAMP_VERSION_RE\$/    version: $OPAMP_OTHER/"; commit_copy
check "telflo: the case's copy declares opamp-server $OPAMP_OTHER" "grep -qxF '    version: $OPAMP_OTHER' '$copy/$PLATFORM/Chart.yaml'"
vendoring_refused "telflo: a declared dependency version not the PIN's refused" \
  "$PLATFORM/Chart.yaml declares opamp-server $OPAMP_OTHER, but $PIN says $OPAMP_VERSION"
make_copy; edit "$copy/$PIN" "s/^version=$OPAMP_VERSION_RE\$/version=$OPAMP_OTHER/"; commit_copy
check "telflo: the case's copy has a PIN naming $OPAMP_OTHER" "grep -qxF 'version=$OPAMP_OTHER' '$copy/$PIN'"
vendoring_refused "telflo: a PIN version not the declared one refused" \
  "$PLATFORM/Chart.yaml declares opamp-server $OPAMP_VERSION, but $PIN says $OPAMP_OTHER"
make_copy; edit "$copy/$SUB/Chart.yaml" "s/^version: $OPAMP_VERSION_RE\$/version: $OPAMP_OTHER2/"; commit_copy
check "telflo: the case's copy has a vendored Chart.yaml at $OPAMP_OTHER2" "grep -qxF 'version: $OPAMP_OTHER2' '$copy/$SUB/Chart.yaml'"
edit "$copy/$PIN" "s/^chart-tree=.*/chart-tree=$(git -C "$copy" rev-parse HEAD:$SUB)/"; commit_copy
vendoring_refused "telflo: a vendored Chart.yaml version not the PIN's refused (its tree the PIN's)" \
  "$SUB/Chart.yaml's version is '$OPAMP_OTHER2', but $PIN says $OPAMP_VERSION"
make_copy; edit "$copy/$PLATFORM/Chart.yaml" 's#^    repository: oci://ghcr.io/telflo/charts$#    repository: oci://ghcr.io/telflo/other#'; commit_copy
vendoring_refused "telflo: a dependency declared at another repository refused" \
  "opamp-server dependency is at 'oci://ghcr.io/telflo/other', not oci://ghcr.io/telflo/charts"
# A tampered tree object: the vendored chart's loose tree
# overwritten with its templates/ tree. rev-parse still names the PIN's id
# and git status stays clean, but the tree no longer lists the chart (git
# reports a hash mismatch reading it, and the extraction's listing loses the
# vendored files): only the extraction's own tree id sees it.
make_copy
sub_tree="$(git -C "$copy" rev-parse HEAD:$SUB)"
victim="$(loose_object "$copy" "$sub_tree")"; donor="$(loose_object "$copy" "$(git -C "$copy" rev-parse HEAD:$SUB/templates)")"
[ -f "$victim" ] && [ -f "$donor" ] && chmod u+w "$victim" && cp "$donor" "$victim"
check "a tampered tree object: rev-parse unchanged, status clean, the tree no longer lists the chart (this test's premise)" \
  "[ \"\$(git -C '$copy' rev-parse HEAD:$SUB)\" = '$sub_tree' ] && [ -z \"\$(git -C '$copy' status --porcelain)\" ] && ! git -C '$copy' ls-tree -r --name-only HEAD -- $SUB 2>/dev/null | grep -qx $SUB/Chart.yaml"
vendoring_refused "telflo: a tampered vendored tree refused by the extraction's own tree id" \
  "the extracted $SUB doesn't hash to $PIN's chart-tree"
# The render tests' reads beside the chart are HEAD's: one HEAD lacks is refused, named.
make_copy; printf '# reads "$REPO_DIR/nowhere/missing.txt"\n' >>"$copy/$PLATFORM/tests/cases/web.sh"; commit_copy
vendoring_refused "telflo: a file the render tests read that HEAD lacks refused, named, before Helm runs" \
  "HEAD has no file under nowhere/missing.txt"
make_copy; printf '# reads "$REPO_DIR/../outside.txt"\n' >>"$copy/$PLATFORM/tests/cases/web.sh"; commit_copy
vendoring_refused "telflo: a render-test read outside the repository refused" \
  "the render tests read '../outside.txt' beside the chart: refused"

# 7e. uncommitted changes in telflo's inputs refused
pdirty_case() { # <name> <path relative to the repository> <append|new>
  local name="$1" path="$2" how="$3"
  if [ "$how" = append ]; then cp "$repo/$path" "$tmp/saved"; echo "# a change" >>"$repo/$path"; else echo "# new" >"$repo/$path"; fi
  prun --dry-run
  check "$name" "[ $rc -eq 1 ] && has \"refuses uncommitted changes in the chart's inputs\" && has '$path' && no_helm && [ -z \"\$printed\" ]"
  if [ "$how" = append ]; then cp "$tmp/saved" "$repo/$path"; else rm -f "${repo:?}/${path:?}"; fi
}
pdirty_case "telflo: a changed chart file refused" "$PLATFORM/values.yaml" append
pdirty_case "telflo: a new file in the vendored chart refused" "$SUB/templates/extra.yaml" new
pdirty_case "telflo: a changed PIN refused" "$PIN" append
pdirty_case "telflo: a changed PIN check refused" scripts/check-opamp-server-pin.sh append
pdirty_case "telflo: a changed publish-chart.sh refused" scripts/publish-chart.sh append
check "the repository is clean again (telflo's inputs)" "[ -z \"\$(git -C '$repo' status --porcelain 2>&1)\" ]"

# 7f. the default is supervisor-collector, unchanged: its own lines exactly, the same as
# --chart supervisor-collector's, and telflo's inputs aren't its
own_lines() { printf '%s\n' "$out" | grep -E '^(publish-chart: |helm push )' | sed -E "s#$tmp/scratch/publish-chart\.[A-Za-z0-9]+#<tmp>#g"; }
default_want="helm push '<tmp>/package/supervisor-collector-0.1.0.tgz' 'oci://ghcr.io/telflo/telflo/charts'
publish-chart: the chart's render tests
publish-chart: helm lint --strict (node)
publish-chart: helm lint --strict (cluster)
publish-chart: helm lint --strict (gateway)
publish-chart: helm package
publish-chart: oci://ghcr.io/telflo/telflo/charts/supervisor-collector 0.1.0 is not in the registry yet
publish-chart: dry run: nothing pushed (--package makes the package, --push-package pushes that file)"
run --dry-run
default_lines="$(own_lines)"
default_all="$(printf '%s\n' "$out" | sed -E "s#$tmp/scratch/publish-chart\.[A-Za-z0-9]+#<tmp>#g")"
check "the default (no --chart): exactly supervisor-collector's lines" "[ $rc -eq 0 ] && [ \"\$default_lines\" = \"\$default_want\" ]"
run --dry-run --chart supervisor-collector
check "--chart supervisor-collector: the default's output, byte for byte" \
  "[ $rc -eq 0 ] && [ \"\$(printf '%s\n' \"\$out\" | sed -E \"s#$tmp/scratch/publish-chart\.[A-Za-z0-9]+#<tmp>#g\")\" = \"\$default_all\" ]"
cp "$repo/$PIN" "$tmp/saved"; echo "# a change" >>"$repo/$PIN"
run --dry-run
check "the default isn't refused for telflo's inputs (a changed PIN)" "[ $rc -eq 0 ] && [ \"\$(own_lines)\" = \"\$default_want\" ]"
cp "$tmp/saved" "$repo/$PIN"
check "the repository is clean again (the default's case)" "[ -z \"\$(git -C '$repo' status --porcelain 2>&1)\" ]"

# --- 8. never a login, never a credential helper ----------------------------------------------
check "the script never logs in" "! grep -nE '^[^#]*(docker|helm)( [a-z-]+)* login' '$source_script' && ! grep -nE '^[^#]*registry login' '$source_script'"
check "Helm was never asked to log in" "[ -s '$logs/all-helm-calls.log' ] && ! grep -qE '^registry( |$)|(^| )login( |$)' '$logs/all-helm-calls.log'"
check "crane was never asked to log in" "[ -s '$logs/all-crane-calls.log' ] && ! grep -qE '^(auth|login)( |$)' '$logs/all-crane-calls.log' && ! grep -q UNEXPECTED '$logs/all-crane-calls.log'"
check "helm show was never called (the registry's reads are crane's)" "! grep -q '^show ' '$logs/all-helm-calls.log'"
check "no credential helper was called" "[ ! -s '$logs/helper.log' ]"

echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
