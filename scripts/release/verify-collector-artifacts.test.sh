#!/bin/bash
# Tests for scripts/release/verify-collector-artifacts.sh. The registry's
# answers come from a crane wrapper first on PATH (STANDIN_CRANE: absent,
# denied) or the real crane against a throwaway registry:2 on 127.0.0.1
# (tools.lock's image, local by digest) holding collector images made offline
# (test-registry.sh's fixture) for every version the catalog offers and the
# supervisor-collector chart packaged from charts/supervisor-collector; SKIP
# lines when crane, docker or that image is missing. Refusing
# credential-helper stand-ins come first on PATH: none may be called.
# Run:  bash scripts/release/verify-collector-artifacts.test.sh
# (TELFLO_TEST_REGISTRY_NAME / TELFLO_TEST_REGISTRY_PORT name the registry's
# container and port.) bash 3.2 compatible.
set -u
# One spelling of the temporary folder (no trailing slash, no //), and no CI:
# the test sets CI itself where a case needs it.
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/release/verify-collector-artifacts.sh"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-collector-artifacts-test.XXXXXX")" || exit 1
cleanup() { tr_registry_stop; rm -rf "$tmp"; }
trap cleanup EXIT
real_docker="$(command -v docker 2>/dev/null || true)"
TR_DOCKER="${real_docker:-docker}"
bin="$tmp/bin"; logs="$tmp/logs"
mkdir -p "$bin" "$logs" "$tmp/stub" "$tmp/t" "$tmp/helm"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/stub/config.json"
TR_DOCKER_CONFIG="$tmp/stub"
for helper in osxkeychain desktop ecr-login; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$logs" >"$bin/docker-credential-$helper"
  chmod +x "$bin/docker-credential-$helper"
done
real_crane="$("$shell" "$root/scripts/release/tools.sh" path crane 2>/dev/null || command -v crane 2>/dev/null || true)"
tr_crane_wrapper "$bin" "$logs" "${real_crane:-/nonexistent/crane}"
PATH="$bin:$PATH"; export PATH
# The script runs from the checkout, whose fetched crane it would prefer: the
# wrapper is named explicitly.
export TELFLO_CRANE="$bin/crane"
export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"
offered="$("$shell" "$root/scripts/build-collector-image.sh" --list-offered)"
chart_version="$(sed -n 's/^export const DEFAULT_HELM_CHART_VERSION = "\([^"]*\)";$/\1/p' "$root/telflo-core/packages/contracts/src/helm.ts")"

run() { # <DOCKER_CONFIG> <args...>: sets rc, out
  local config="$1"; shift
  rm -f "$logs/crane-calls.log"
  out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$config" "$shell" "$script" "$@" 2>&1)"; rc=$?
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }

# --- 1. usage, and the registry's answers ----------------------------------------------------
STANDIN_CRANE=absent run "$tmp/stub" --bogus
check "an unknown argument refused (exit 2)" "[ $rc -eq 2 ] && has 'unknown argument: --bogus'"
for bad in docker.io ghcr.io/telflo/platform ghcr.io/telflo/collector 10.0.0.1:5000; do
  STANDIN_CRANE=absent run "$tmp/stub" --registry "$bad"
  check "--registry '$bad' refused (exit 2)" "[ $rc -eq 2 ] && has '--registry must be ghcr.io or a loopback registry'"
done
check "the catalog offers versions (this test's premise)" "[ -n '$offered' ] && [ -n '$chart_version' ]"
STANDIN_CRANE=absent run "$tmp/stub"
all_named=true
for v in $offered; do printf '%s\n' "$out" | grep -qF "ghcr.io/telflo/telflo/collector:$v is missing: run the collector workflow for $v" || all_named=false; done
check "absent everywhere: every offered version and the chart named with 'run the collector workflow for <version>' (exit 1)" \
  "[ $rc -eq 1 ] && $all_named && has 'oci://ghcr.io/telflo/telflo/charts/supervisor-collector:$chart_version is missing: run the collector workflow for supervisor-collector $chart_version'"
check "every offered version and the contracts' chart version asked (crane manifest), on ghcr.io/telflo/telflo" \
  "[ \$(grep -c '^manifest ghcr.io/telflo/telflo/collector:' '$logs/crane-calls.log') -eq $(printf '%s\n' "$offered" | grep -c '') ] && grep -qx 'manifest ghcr.io/telflo/telflo/charts/supervisor-collector:$chart_version ' '$logs/crane-calls.log'"
STANDIN_CRANE=denied run "$tmp/stub"
check "a registry that can't tell (DENIED) fails the check (exit 1), crane's error line named" "[ $rc -eq 1 ] && has \"can't tell whether ghcr.io/telflo/telflo/collector:\" && has 'DENIED' && ! has 'No matching credentials'"

# --- 2. against a throwaway registry ----------------------------------------------------------
push_ok=false
if tr_tools "$root" && [ -n "$real_crane" ] && command -v helm >/dev/null 2>&1; then
  if tr_registry_start "$tmp/registry"; then push_ok=true; else TR_SKIP="the throwaway registry didn't start"; fi
fi
if $push_ok; then
  REG="$TR_REGISTRY"
  put() { tr_put "$1" "$2" "$real_crane" "$TR_CONFIG"; }
  first="$(printf '%s\n' "$offered" | head -n 1)"
  for v in $offered; do
    [ "$v" = "$first" ] && continue
    tr_fixture "$tmp/c-$v.oci.tar" "$v" 0123456789abcdef0123456789abcdef01234567 "C-$v" >/dev/null
    put "$tmp/c-$v.oci.tar" "$REG/telflo/telflo/collector:$v"
  done
  helm package "$root/charts/supervisor-collector" --destination "$tmp/chart" >/dev/null
  HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" helm push --plain-http "$tmp/chart/supervisor-collector-$chart_version.tgz" "oci://$REG/telflo/telflo/charts" >/dev/null 2>&1
  run "$TR_CONFIG" --registry "$REG"
  check "one offered version missing: exit 1, only it named" \
    "[ $rc -eq 1 ] && has '$REG/telflo/telflo/collector:$first is missing: run the collector workflow for $first' && [ \$(printf '%s\n' \"\$out\" | grep -c 'run the collector workflow') -eq 1 ] && has '1 collector artefact(s) missing'"
  tr_fixture "$tmp/c-$first.oci.tar" "$first" 0123456789abcdef0123456789abcdef01234567 "C-$first" >/dev/null
  put "$tmp/c-$first.oci.tar" "$REG/telflo/telflo/collector:$first"
  run "$TR_CONFIG" --registry "$REG"
  check "every offered version (linux/amd64 and linux/arm64) and the chart there: exit 0" \
    "[ $rc -eq 0 ] && has 'and supervisor-collector $chart_version are there' && [ \$(printf '%s\n' \"\$out\" | grep -c ': linux/amd64 and linux/arm64') -eq $(printf '%s\n' "$offered" | grep -c '') ]"
  # A tag that holds one platform's image only, not an index.
  amd64="$(DOCKER_CONFIG="$TR_CONFIG" "$real_crane" manifest "$REG/telflo/telflo/collector:$first" | python3 -I -c 'import json,sys; print([m["digest"] for m in json.load(sys.stdin)["manifests"] if (m.get("platform") or {}).get("architecture") == "amd64"][0])')"
  DOCKER_CONFIG="$TR_CONFIG" "$real_crane" copy "$REG/telflo/telflo/collector@$amd64" "$REG/telflo/telflo/collector:$first" >/dev/null 2>&1
  run "$TR_CONFIG" --registry "$REG"
  check "a tag holding a single image, not an index of both platforms, fails (exit 1)" \
    "[ $rc -eq 1 ] && has \"$REG/telflo/telflo/collector:$first isn't an image index: run the collector workflow for $first\""
else
  for c in "a missing version" "everything there" "a single-platform tag"; do skip "verify-collector-artifacts: $c" "${TR_SKIP:-no crane or helm}"; done
fi
tr_registry_stop
check "no crane call was a login; no credential helper was called" "! grep -qE '^(auth|login) ' '$logs/all-crane-calls.log' && [ ! -s '$logs/helper.log' ]"

echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
