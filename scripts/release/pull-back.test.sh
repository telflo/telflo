#!/bin/bash
# Tests for scripts/release/pull-back.sh. Its refusals run offline. The
# pull-back itself runs with the real crane, docker and helm against a
# throwaway registry:2 on 127.0.0.1 (tools.lock's image, local by digest; a
# login made at run time when htpasswd is there) holding OCI archives made
# offline (test-registry.sh's fixture) and a tiny chart, or prints SKIP lines
# when crane, docker or that image is missing. Refusing credential-helper
# stand-ins come first on PATH: none may be called.
# Run:  bash scripts/release/pull-back.test.sh
# (TELFLO_TEST_REGISTRY_NAME / TELFLO_TEST_REGISTRY_PORT name the registry's
# container and port.) bash 3.2 compatible.
set -u
# One spelling of the temporary folder (no trailing slash, no //), and no CI:
# the test sets CI itself where a case needs it.
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/release/pull-back.sh"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }

V=9.9.97
IMAGES="api web otelcol-validator otelcol-testing ottl-evaluator"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pull-back-test.XXXXXX")" || exit 1
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
# A docker wrapper: every call recorded and handed to the real docker, but
# STANDIN_STORE=containerd answers `docker info`'s driver status as
# containerd's image store, and STANDIN_ID answers `image inspect --format
# {{.Id}}` (the engine's id) for the release's references.
printf '#!/bin/bash\nlog="%s"\nreal="%s"\n' "$logs" "${real_docker:-/nonexistent/docker}" >"$bin/docker"
cat >>"$bin/docker" <<'EOF'
{ printf '%q ' "$@"; echo; } >>"$log/docker-calls.log"
if [ "${1:-}" = info ] && [ -n "${STANDIN_STORE:-}" ]; then
  [ "$STANDIN_STORE" = containerd ] && echo '[["driver-type","io.containerd.snapshotter.v1"]]' || echo '[["Backing Filesystem","extfs"]]'
  exit 0
fi
if [ -n "${STANDIN_ID:-}" ] && [ "$1 ${2:-} ${3:-} ${4:-}" = "image inspect --format {{.Id}}" ]; then
  echo "$STANDIN_ID"; exit 0
fi
exec "$real" "$@"
EOF
chmod +x "$bin/docker"
real_crane="$("$shell" "$root/scripts/release/tools.sh" path crane 2>/dev/null || command -v crane 2>/dev/null || true)"
tr_crane_wrapper "$bin" "$logs" "${real_crane:-/nonexistent/crane}"
PATH="$bin:$PATH"; export PATH
# The script runs from the checkout, whose fetched crane it would prefer: the
# wrapper is named explicitly.
export TELFLO_CRANE="$bin/crane"
export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"

run() { # <DOCKER_CONFIG> <args...>: sets rc, out
  local config="$1"; shift
  rm -f "$logs/crane-calls.log"
  out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$config" HELM_REGISTRY_CONFIG="$config/config.json" "$shell" "$script" "$@" 2>&1)"; rc=$?
  printf '%s\n' "$out" >>"$logs/all-output.log"
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }

# --- 1. usage and refusals ---------------------------------------------------------------
oci="$tmp/oci"; mkdir -p "$oci"; : >"$tmp/chart.tgz"
run "$tmp/stub" --version "$V" --no-chart
check "no --oci refused (exit 2)" "[ $rc -eq 2 ] && has '--oci <dir> must be an existing directory'"
run "$tmp/stub" --oci "$oci" --version v9.9.97 --no-chart
check "a version that isn't x.y.z refused (exit 2)" "[ $rc -eq 2 ] && has '--version must be x.y.z'"
run "$tmp/stub" --oci "$oci" --version "$V"
check "neither --chart nor --no-chart refused (exit 2)" "[ $rc -eq 2 ] && has '--chart <tgz> (an existing file) or --no-chart is required'"
run "$tmp/stub" --oci "$oci" --version "$V" --chart "$tmp/chart.tgz" --no-chart
check "--chart with --no-chart refused (exit 2)" "[ $rc -eq 2 ] && has 'not both'"
for bad in docker.io ghcr.io/telflo/platform 10.0.0.1:5000; do
  run "$tmp/stub" --oci "$oci" --version "$V" --no-chart --registry "$bad"
  check "--registry '$bad' refused (exit 2)" "[ $rc -eq 2 ] && has '--registry must be ghcr.io or a loopback registry'"
done
run "$tmp/stub" --oci "$oci" --version "$V" --no-chart --image redis
check "an unknown image refused (exit 2)" "[ $rc -eq 2 ] && has \"unknown image 'redis'\""
run "$tmp/stub" --oci "$oci" --version "$V" --no-chart
check "a missing digest file refused (exit 1) before any registry read" "[ $rc -eq 1 ] && has 'api.digest is missing' && [ ! -s '$logs/crane-calls.log' ]"
for bad in telflo/telflo telflo-platform "" platform; do
  run "$tmp/stub" --oci "$oci" --version "$V" --no-chart --namespace "$bad"
  check "--namespace '$bad' refused (exit 2): only telflo or telflo-staging" "[ $rc -eq 2 ] && has '--namespace must be telflo (the public one) or telflo-staging'"
done
run "$tmp/stub" --oci "$oci" --version "$V" --no-chart --image collector --namespace telflo-staging
check "the collector image with --namespace telflo-staging refused (exit 2): it is public only" "[ $rc -eq 2 ] && has 'the collector image is published to the public namespace alone'"
D1=sha256:1111111111111111111111111111111111111111111111111111111111111111
printf 'api %s\notelcol-testing %s\notelcol-validator %s\nottl-evaluator %s\nweb %s\ncharts/telflo %s\ncharts/telflo.tgz %s\n' "$D1" "$D1" "$D1" "$D1" "$D1" "$D1" "$D1" >"$tmp/d1.txt"
run "$tmp/stub" --digests "$tmp/d1.txt" --oci "$oci" --version "$V"
check "--digests with --oci refused (exit 2)" "[ $rc -eq 2 ] && has '--oci or --digests, not both'"
run "$tmp/stub" --digests "$tmp/d1.txt" --version "$V" --chart "$tmp/chart.tgz"
check "--digests with --chart refused (exit 2): the file names the chart" "[ $rc -eq 2 ] && has '--digests names the chart itself'"
run "$tmp/stub" --digests "$tmp/d1.txt" --version "$V" --no-chart
check "--digests with --no-chart refused (exit 2)" "[ $rc -eq 2 ] && has '--digests names the chart itself'"
run "$tmp/stub" --digests "$tmp/d1.txt" --version "$V" --image api
check "--digests with --image refused (exit 2)" "[ $rc -eq 2 ] && has 'no --image'"
run "$tmp/stub" --digests "$tmp/none.txt" --version "$V"
check "a --digests file that doesn't exist refused (exit 2)" "[ $rc -eq 2 ] && has '--digests <file> must be an existing file'"
sed '1{h;d;};2{G;}' "$tmp/d1.txt" >"$tmp/d-bad.txt"
run "$tmp/stub" --digests "$tmp/d-bad.txt" --version "$V"
check "a --digests file that isn't a stage's digests.txt (its lines reordered) refused (exit 1) before any registry read" \
  "[ $rc -eq 1 ] && has \"isn't a stage's digests.txt\" && [ ! -s '$logs/crane-calls.log' ]"

# --- 2. the pull-back against a throwaway registry ------------------------------------------
push_ok=false
if tr_tools "$root" && [ -n "$real_docker" ] && [ -n "$real_crane" ] && command -v helm >/dev/null 2>&1; then
  if tr_registry_start "$tmp/registry"; then push_ok=true; else TR_SKIP="the throwaway registry didn't start"; fi
fi
if $push_ok; then
  REG="$TR_REGISTRY"
  revision=0123456789abcdef0123456789abcdef01234567
  # put <tar> <ref>: the archive's layout pushed as the release's push does.
  put() { tr_put "$1" "$2" "$real_crane" "$TR_CONFIG"; }
  for i in $IMAGES; do
    tr_fixture "$oci/$i.oci.tar" "$V" "$revision" "P-$i" >"$oci/$i.digest"
    put "$oci/$i.oci.tar" "$REG/telflo/telflo/$i:$V"
  done
  # A tiny chart telflo at the version, packaged and pushed with Helm.
  mkdir -p "$tmp/chart/telflo/templates"
  printf 'apiVersion: v2\nname: telflo\nversion: %s\nappVersion: "%s"\n' "$V" "$V" >"$tmp/chart/telflo/Chart.yaml"
  printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n' >"$tmp/chart/telflo/templates/cm.yaml"
  (cd "$tmp/chart" && helm package telflo --destination "$tmp/chart" >/dev/null)
  package="$tmp/chart/telflo-$V.tgz"
  HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" helm push --plain-http "$package" "oci://$REG/telflo/telflo/charts" >/dev/null 2>&1
  run "$TR_CONFIG" --oci "$oci" --version "$V" --chart "$package" --registry "$REG"
  check "everything the registry serves is what was tested: exit 0 (five images, their attestations, the chart)" \
    "[ $rc -eq 0 ] && has 'pulled back: everything is what was tested' && [ \$(printf '%s\n' \"\$out\" | grep -c ', attested; the amd64 image pulled)') -eq 5 ] && has 'is the package (sha256'"
  amd64_of_api="$(DOCKER_CONFIG="$TR_CONFIG" "$real_crane" manifest "$REG/telflo/telflo/api:$V" | python3 -I -c 'import json,sys; print([m["digest"] for m in json.load(sys.stdin)["manifests"] if (m.get("platform") or {}).get("architecture") == "amd64"][0])')"
  check "the amd64 images were pulled by digest and untagged afterwards" \
    "! DOCKER_CONFIG='$tmp/stub' '$real_docker' image inspect '$REG/telflo/telflo/api@$amd64_of_api' >/dev/null 2>&1"
  amd64_config_of_api="$(DOCKER_CONFIG="$TR_CONFIG" "$real_crane" manifest "$REG/telflo/telflo/api@$amd64_of_api" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["config"]["digest"])')"
  # The engine's image id (a docker stand-in for the id and the store).
  STANDIN_ID=sha256:4444444444444444444444444444444444444444444444444444444444444444 run "$TR_CONFIG" --oci "$oci" --version "$V" --no-chart --image api --registry "$REG"
  check "pull-back.sh fails when the engine's id for the pulled amd64 image is another (the classic store: its config digest expected)" \
    "[ $rc -eq 1 ] && has \"DIFFERENT: the pulled $REG/telflo/telflo/api@$amd64_of_api is image sha256:4444\" && has 'not $amd64_config_of_api (classic image store)'"
  STANDIN_STORE=containerd STANDIN_ID="$amd64_of_api" run "$TR_CONFIG" --oci "$oci" --version "$V" --no-chart --image api --registry "$REG"
  check "containerd's image store: the id is the manifest digest, accepted" "[ $rc -eq 0 ]"
  STANDIN_STORE=containerd STANDIN_ID="$amd64_config_of_api" run "$TR_CONFIG" --oci "$oci" --version "$V" --no-chart --image api --registry "$REG"
  check "containerd's image store: the config digest as the id is refused (the store decides which digest)" \
    "[ $rc -eq 1 ] && has 'not $amd64_of_api (containerd image store)'"
  # One image's tag holds another digest: the first difference is named.
  tr_fixture "$tmp/other-web.oci.tar" "$V" "$revision" OTHER >/dev/null
  put "$tmp/other-web.oci.tar" "$REG/telflo/telflo/web:$V"
  run "$TR_CONFIG" --oci "$oci" --version "$V" --chart "$package" --registry "$REG"
  check "pull-back.sh fails when one image's digest differs, naming it (exit 1)" \
    "[ $rc -eq 1 ] && has \"DIFFERENT: $REG/telflo/telflo/web:$V is sha256:\" && has \"not the tested \$(cat '$oci/web.digest')\" && ! has 'pulled back: everything'"
  put "$oci/web.oci.tar" "$REG/telflo/telflo/web:$V"
  # The chart's bytes differ (another package of the same version).
  mkdir -p "$tmp/chart2"; cp -R "$tmp/chart/telflo" "$tmp/chart2/"; printf '# other\n' >>"$tmp/chart2/telflo/templates/cm.yaml"
  (cd "$tmp/chart2" && helm package telflo --destination "$tmp/chart2" >/dev/null)
  run "$TR_CONFIG" --oci "$oci" --version "$V" --chart "$tmp/chart2/telflo-$V.tgz" --registry "$REG"
  check "pull-back.sh fails when the chart's sha256 differs from the package's (exit 1)" \
    "[ $rc -eq 1 ] && has \"DIFFERENT: oci://$REG/telflo/telflo/charts/telflo $V's sha256 is\""
  # A release's stage: the same archives and chart under telflo/telflo-staging, then a stage's
  # digests.txt for --digests (the finalize workflow's pull-back, which has no archives).
  for i in $IMAGES; do put "$oci/$i.oci.tar" "$REG/telflo/telflo-staging/$i:$V"; done
  HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" helm push --plain-http "$package" "oci://$REG/telflo/telflo-staging/charts" >/dev/null 2>&1
  run "$TR_CONFIG" --oci "$oci" --version "$V" --chart "$package" --registry "$REG" --namespace telflo-staging
  check "--namespace telflo-staging: the stage pulled back from <registry>/telflo/telflo-staging (exit 0)" \
    "[ $rc -eq 0 ] && has 'pulled back: everything is what was tested' && has '$REG/telflo/telflo-staging/api:$V is' && has 'oci://$REG/telflo/telflo-staging/charts/telflo $V is the package' && ! has '$REG/telflo/telflo/api'"
  chart_digest="$(DOCKER_CONFIG="$TR_CONFIG" "$real_crane" digest "$REG/telflo/telflo-staging/charts/telflo:$V")"
  package_sum="sha256:$(shasum -a 256 "$package" | cut -c1-64)"
  record() { # <chart digest> <package sha256>
    printf 'api %s\notelcol-testing %s\notelcol-validator %s\nottl-evaluator %s\nweb %s\ncharts/telflo %s\ncharts/telflo.tgz %s\n' \
      "$(cat "$oci/api.digest")" "$(cat "$oci/otelcol-testing.digest")" "$(cat "$oci/otelcol-validator.digest")" \
      "$(cat "$oci/ottl-evaluator.digest")" "$(cat "$oci/web.digest")" "$1" "$2"
  }
  record "$chart_digest" "$package_sum" >"$tmp/digests.txt"
  run "$TR_CONFIG" --digests "$tmp/digests.txt" --version "$V" --registry "$REG" --namespace telflo-staging
  check "--digests: the five images and the chart checked from a stage's digests.txt alone, no archive (exit 0)" \
    "[ $rc -eq 0 ] && has 'pulled back: everything is what was tested' && [ \$(printf '%s\n' \"\$out\" | grep -c ', attested; the amd64 image pulled)') -eq 5 ] && has \"is the package (sha256 \${package_sum#sha256:})\""
  DOCKER_CONFIG="$TR_CONFIG" "$real_crane" copy "$REG/telflo/telflo-staging/charts/telflo@$chart_digest" "$REG/telflo/telflo/charts/telflo:$V" >/dev/null 2>&1
  run "$TR_CONFIG" --digests "$tmp/digests.txt" --version "$V" --registry "$REG" --namespace telflo
  check "--digests --namespace telflo: the public tags checked against the stage's record (exit 0)" \
    "[ $rc -eq 0 ] && has '$REG/telflo/telflo/api:$V is' && has 'oci://$REG/telflo/telflo/charts/telflo $V is the package'"
  record "$(cat "$oci/api.digest")" "$package_sum" >"$tmp/digests-chart.txt"
  run "$TR_CONFIG" --digests "$tmp/digests-chart.txt" --version "$V" --registry "$REG" --namespace telflo-staging
  check "--digests: a chart tag that isn't the record's charts/telflo line fails, named (exit 1)" \
    "[ $rc -eq 1 ] && has \"DIFFERENT: $REG/telflo/telflo-staging/charts/telflo:$V is $chart_digest, not the stage's\""
  record "$chart_digest" "sha256:$(printf '%064d' 7)" >"$tmp/digests-package.txt"
  run "$TR_CONFIG" --digests "$tmp/digests-package.txt" --version "$V" --registry "$REG" --namespace telflo-staging
  check "--digests: a pulled chart whose sha256 isn't the record's package line fails (exit 1)" \
    "[ $rc -eq 1 ] && has \"DIFFERENT: oci://$REG/telflo/telflo-staging/charts/telflo $V's sha256 is \${package_sum#sha256:}, not the package's $(printf '%064d' 7)\""
  # Images without attestations: refused unless --no-attest.
  tr_fixture "$tmp/noattest.oci.tar" "$V" "$revision" NA no-attest >"$tmp/noattest.digest"
  mkdir -p "$tmp/oci-na"; for i in $IMAGES; do cp "$oci/$i.digest" "$tmp/oci-na/"; done; cp "$tmp/noattest.digest" "$tmp/oci-na/ottl-evaluator.digest"
  put "$tmp/noattest.oci.tar" "$REG/telflo/telflo/ottl-evaluator:$V"
  run "$TR_CONFIG" --oci "$tmp/oci-na" --version "$V" --no-chart --image ottl-evaluator --registry "$REG"
  check "an image without attestation manifests fails the pull-back" "[ $rc -eq 1 ] && has 'image has no attestation manifest'"
  run "$TR_CONFIG" --oci "$tmp/oci-na" --version "$V" --no-chart --image ottl-evaluator --registry "$REG" --no-attest
  check "--no-attest (a rehearsal's builds) accepts it" "[ $rc -eq 0 ]"
  run "$TR_CONFIG" --oci "$oci" --version 9.9.96 --no-chart --image api --registry "$REG"
  check "a tag that isn't there: refused, named" "[ $rc -eq 1 ] && has \"DIFFERENT: $REG/telflo/telflo/api:9.9.96 can't be read\" && has 'MANIFEST_UNKNOWN'"
  if [ "$TR_AUTH" = 1 ]; then
    run "$tmp/stub" --oci "$oci" --version "$V" --no-chart --image api --registry "$REG"
    check "no login: the read fails (UNAUTHORIZED), refused" "[ $rc -eq 1 ] && has 'UNAUTHORIZED'"
    check "no file of the test's work folder or output holds the registry's test credential (boolean)" \
      "! tr_secret_in '$tmp/t' '$logs' '$oci' '$tmp/chart'"
  else
    skip "the login cases" "no htpasswd: the throwaway registry has no login"
  fi
else
  for c in "the equal case" "one image's digest differing" "the chart differing" "attestations" "the login cases"; do skip "pull-back: $c" "${TR_SKIP:-no docker, crane or helm}"; done
fi
tr_registry_stop
check "no credential helper was called" "[ ! -s '$logs/helper.log' ]"

echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
