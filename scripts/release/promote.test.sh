#!/bin/bash
# Tests for scripts/release/promote.sh. Its refusals run offline. The promote
# itself runs with the real crane and helm against a throwaway registry:2 on
# 127.0.0.1 (tools.lock's image, local by digest; a login made at run time
# when htpasswd is there; test-registry.sh) holding a stage made here: OCI
# archives made offline (test-registry.sh's fixture) pushed to
# telflo/telflo-staging, and a tiny chart pushed beside them; SKIP lines when
# crane, docker, helm or that image is missing. A crane wrapper records every
# call. Refusing credential-helper stand-ins come first on PATH: none may be
# called.
# Run:  bash scripts/release/promote.test.sh
# (TELFLO_TEST_REGISTRY_NAME / TELFLO_TEST_REGISTRY_PORT name the registry's
# container and port.) bash 3.2 compatible.
set -u
# One spelling of the temporary folder (no trailing slash, no //), and no CI.
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/release/promote.sh"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }

IMAGES="api otelcol-testing otelcol-validator ottl-evaluator web"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/promote-test.XXXXXX")" || exit 1
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
export TELFLO_CRANE="$bin/crane"
export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"

run() { # <DOCKER_CONFIG> <args...>: sets rc, out (stdout and stderr) and printed (stdout)
  local config="$1"; shift
  : >"$logs/crane-calls.log"
  env TMPDIR="$tmp/t" DOCKER_CONFIG="$config" "$shell" "$script" "$@" >"$tmp/stdout" 2>"$tmp/stderr" </dev/null
  rc=$?
  printed="$(cat "$tmp/stdout")"
  out="$(cat "$tmp/stdout" "$tmp/stderr")"
  cat "$tmp/stdout" "$tmp/stderr" >>"$logs/all-output.log"
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
no_crane() { [ -f "$logs/crane-calls.log" ] && [ ! -s "$logs/crane-calls.log" ]; }
copies() { grep -c '^copy ' "$logs/crane-calls.log" 2>/dev/null || true; }
# digests_file <file> <api> <otelcol-testing> <otelcol-validator> <ottl-evaluator> <web> <chart> <package>
digests_file() {
  local file="$1"; shift
  printf 'api %s\notelcol-testing %s\notelcol-validator %s\nottl-evaluator %s\nweb %s\ncharts/telflo %s\ncharts/telflo.tgz %s\n' "$@" >"$file"
}
ONES=sha256:1111111111111111111111111111111111111111111111111111111111111111
TWOS=sha256:2222222222222222222222222222222222222222222222222222222222222222

# --- 1. usage and refusals, offline ------------------------------------------------------
digests_file "$tmp/good.txt" "$ONES" "$ONES" "$ONES" "$ONES" "$ONES" "$ONES" "$TWOS"
run "$tmp/stub" --digests "$tmp/good.txt"
check "no --version refused (exit 2), nothing asked" "[ $rc -eq 2 ] && has '--version must be x.y.z' && no_crane"
for bad in v9.9.9 9.9 09.9.9 9.9.9-rc.1 "\$(echo EXPANDED)"; do
  run "$tmp/stub" --version "$bad" --digests "$tmp/good.txt"
  check "--version '$bad' refused (exit 2), nothing expanded or asked" "[ $rc -eq 2 ] && ! has \"got 'EXPANDED'\" && no_crane"
done
for bad in docker.io ghcr.io/telflo/telflo-staging ghcr.io/telflo/telflo 10.0.0.1:5000 127.0.0.1:0 ghcr.io:443; do
  run "$tmp/stub" --version 9.9.9 --digests "$tmp/good.txt" --registry "$bad"
  check "--registry '$bad' refused (exit 2), nothing asked" "[ $rc -eq 2 ] && has '--registry must be ghcr.io or a loopback registry' && no_crane"
done
run "$tmp/stub" --version 9.9.9
check "no --digests refused (exit 2)" "[ $rc -eq 2 ] && has '--digests <file> must be an existing file'"
run "$tmp/stub" --version 9.9.9 --digests "$tmp/none.txt"
check "a --digests file that doesn't exist refused (exit 2)" "[ $rc -eq 2 ]"
run "$tmp/stub" --version 9.9.9 --digests "$tmp/good.txt" --namespace telflo-staging
check "no --namespace (the two namespaces are fixed): refused as an unknown argument (exit 2)" "[ $rc -eq 2 ] && has 'unknown argument: --namespace'"
bad_file() { # <name> <the file's content (printf format)>
  # shellcheck disable=SC2059 # the content is a format
  printf "$2" >"$tmp/bad.txt"
  run "$tmp/stub" --version 9.9.9 --digests "$tmp/bad.txt"
  check "a digests file with $1: refused (exit 1), nothing asked or copied" "[ $rc -eq 1 ] && has \"isn't a stage's digests.txt\" && no_crane"
}
good_lines="api $ONES\notelcol-testing $ONES\notelcol-validator $ONES\nottl-evaluator $ONES\nweb $ONES\ncharts/telflo $ONES\ncharts/telflo.tgz $TWOS\n"
bad_file "its lines in another order" "otelcol-testing $ONES\napi $ONES\notelcol-validator $ONES\nottl-evaluator $ONES\nweb $ONES\ncharts/telflo $ONES\ncharts/telflo.tgz $TWOS\n"
bad_file "a line missing (the package's)" "api $ONES\notelcol-testing $ONES\notelcol-validator $ONES\nottl-evaluator $ONES\nweb $ONES\ncharts/telflo $ONES\n"
bad_file "an extra line" "${good_lines}collector $ONES\n"
bad_file "a digest that isn't sha256:<64 hex>" "$(printf '%s' "$good_lines" | sed "s/^api $ONES/api sha256:abc/")"
bad_file "a carriage return" "$(printf '%s' "$good_lines" | sed 's/\\n/\\r\\n/')"
bad_file "no final newline" "$(printf '%s' "$good_lines" | sed 's/\\n$//')"
bad_file "a name of its own (a path outside the stage)" "$(printf '%s' "$good_lines" | sed 's#\\nweb #\\n../web #')"

# --- 2. against a throwaway registry -------------------------------------------------------
reg_ok=false
if tr_tools "$root" && [ -n "$real_crane" ] && command -v helm >/dev/null 2>&1; then
  if tr_registry_start "$tmp/registry"; then reg_ok=true; else TR_SKIP="the throwaway registry didn't start"; fi
fi
if $reg_ok; then
  REG="$TR_REGISTRY"
  STAGED="$REG/telflo/telflo-staging"
  PUBLIC="$REG/telflo/telflo"
  revision=0123456789abcdef0123456789abcdef01234567
  remote() { DOCKER_CONFIG="$TR_CONFIG" "$real_crane" digest "$1" 2>/dev/null; }
  # stage <version> [<image left out>]: the five images (fixtures) and a tiny chart pushed to
  # telflo/telflo-staging at <version>; <tmp>/stage-<version>/digests.txt their record.
  stage() {
    local v="$1" leave="${2:-}" dir="$tmp/stage-$1" i chart_digest package_sum lines=""
    mkdir -p "$dir/chart/telflo/templates"
    for i in $IMAGES; do
      tr_fixture "$dir/$i.oci.tar" "$v" "$revision" "S-$v-$i" >"$dir/$i.digest"
      [ "$i" = "$leave" ] || tr_put "$dir/$i.oci.tar" "$STAGED/$i:$v" "$real_crane" "$TR_CONFIG"
      lines="$lines $(cat "$dir/$i.digest")"
    done
    printf 'apiVersion: v2\nname: telflo\nversion: %s\nappVersion: "%s"\n' "$v" "$v" >"$dir/chart/telflo/Chart.yaml"
    printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n' >"$dir/chart/telflo/templates/cm.yaml"
    (cd "$dir/chart" && helm package telflo --destination "$dir" >/dev/null)
    HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" helm push --plain-http "$dir/telflo-$v.tgz" "oci://$STAGED/charts" >/dev/null 2>&1
    chart_digest="$(remote "$STAGED/charts/telflo:$v")"
    package_sum="sha256:$(shasum -a 256 "$dir/telflo-$v.tgz" | cut -c1-64)"
    # shellcheck disable=SC2086 # the five digests, one argument each
    digests_file "$dir/digests.txt" $lines "$chart_digest" "$package_sum"
  }
  every_public() { # <version> <digests file>: each public tag answers its line
    local name want
    for name in $IMAGES charts/telflo; do
      want="$(awk -v n="$name" '$1 == n { print $2 }' "$2")"
      [ "$(remote "$PUBLIC/$name:$1")" = "$want" ] || return 1
    done
  }

  V=9.9.91
  stage "$V"
  run "$TR_CONFIG" --version "$V" --digests "$tmp/stage-$V/digests.txt" --registry "$REG"
  check "a clean promote: exit 0, every public tag the stage's digest (five images, the chart)" \
    "[ $rc -eq 0 ] && every_public '$V' '$tmp/stage-$V/digests.txt' && has 'promoted: $V'"
  check "it prints <public ref>@<digest> for each, the record's digests" \
    "[ \"\$(printf '%s\n' \"\$printed\" | grep -c \"^$PUBLIC/\")\" -eq 6 ] && printf '%s\n' \"\$printed\" | grep -qxF \"$PUBLIC/charts/telflo:$V@\$(awk '\$1 == \"charts/telflo\" { print \$2 }' '$tmp/stage-$V/digests.txt')\""
  check "every copy is from the stage by digest to the public tag: crane copy <staged>/<name>@<digest> <public>/<name>:<v>" \
    "[ \$(copies) -eq 6 ] && [ \$(grep -cE \"^copy $STAGED/[a-z/-]+@sha256:[0-9a-f]{64} $PUBLIC/[a-z/-]+:$V \\\$\" '$logs/crane-calls.log') -eq 6 ]"
  check "every staged and public tag asked before the first copy" \
    "[ \"\$(grep -nE '^(digest|manifest) ' '$logs/crane-calls.log' | sed -n 19p | cut -d: -f1)\" -lt \"\$(grep -n '^copy ' '$logs/crane-calls.log' | head -n 1 | cut -d: -f1)\" ]"
  check "the attestations came along: the public index is the staged one, byte for byte" \
    "[ \"\$(DOCKER_CONFIG='$TR_CONFIG' '$real_crane' manifest '$PUBLIC/api:$V' | shasum -a 256 | cut -c1-64)\" = \"\$(DOCKER_CONFIG='$TR_CONFIG' '$real_crane' manifest '$STAGED/api:$V' | shasum -a 256 | cut -c1-64)\" ]"
  helm_pulled="$(mkdir -p "$tmp/pulled" && HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" helm pull --plain-http "oci://$PUBLIC/charts/telflo" --version "$V" --destination "$tmp/pulled" >/dev/null 2>&1 && shasum -a 256 "$tmp/pulled/telflo-$V.tgz" | cut -c1-64)"
  check "helm pulls the public chart: the staged package, byte for byte" "[ 'sha256:$helm_pulled' = \"\$(awk '\$1 == \"charts/telflo.tgz\" { print \$2 }' '$tmp/stage-$V/digests.txt')\" ]"

  run "$TR_CONFIG" --version "$V" --digests "$tmp/stage-$V/digests.txt" --registry "$REG"
  check "a re-run: exit 0, every public tag skipped with a line (the same bytes), nothing copied" \
    "[ $rc -eq 0 ] && [ \$(copies) -eq 0 ] && [ \$(printf '%s\n' \"\$out\" | grep -c 'skipped (the same bytes)') -eq 6 ] && [ \"\$(printf '%s\n' \"\$printed\" | grep -c \"^$PUBLIC/\")\" -eq 6 ]"

  # A promote that stopped part way: api and the chart public already, the rest not.
  V=9.9.92
  stage "$V"
  DOCKER_CONFIG="$TR_CONFIG" "$real_crane" copy "$STAGED/api@$(cat "$tmp/stage-$V/api.digest")" "$PUBLIC/api:$V" >/dev/null 2>&1
  DOCKER_CONFIG="$TR_CONFIG" "$real_crane" copy "$STAGED/charts/telflo:$V" "$PUBLIC/charts/telflo:$V" >/dev/null 2>&1
  run "$TR_CONFIG" --version "$V" --digests "$tmp/stage-$V/digests.txt" --registry "$REG"
  check "a promote that stopped part way, run again: what is public skipped, the rest copied (exit 0)" \
    "[ $rc -eq 0 ] && [ \$(copies) -eq 4 ] && has '$PUBLIC/api:$V holds' && every_public '$V' '$tmp/stage-$V/digests.txt'"

  # The record isn't the stage's: web's line another digest (another archive, pushed by digest only).
  V=9.9.93
  stage "$V"
  other="$(tr_fixture "$tmp/other.oci.tar" "$V" "$revision" OTHER)"
  tr_put "$tmp/other.oci.tar" "$STAGED/web@$other" "$real_crane" "$TR_CONFIG"
  sed "s#^web .*#web $other#" "$tmp/stage-$V/digests.txt" >"$tmp/wrong.txt"
  run "$TR_CONFIG" --version "$V" --digests "$tmp/wrong.txt" --registry "$REG"
  check "a wrong digest (web's staged tag is another): refused (exit 1), named, nothing copied or public" \
    "[ $rc -eq 1 ] && has \"$STAGED/web:$V is \$(cat '$tmp/stage-$V/web.digest'), not the stage's record $other\" && has 'nothing copied' && [ \$(copies) -eq 0 ] && [ -z \"\$(remote '$PUBLIC/api:$V')\" ]"
  sed "s#^charts/telflo.tgz .*#charts/telflo.tgz $TWOS#" "$tmp/stage-$V/digests.txt" >"$tmp/wrong-package.txt"
  run "$TR_CONFIG" --version "$V" --digests "$tmp/wrong-package.txt" --registry "$REG"
  check "a package line that isn't the staged chart's layer: refused (exit 1), nothing copied" \
    "[ $rc -eq 1 ] && has \"chart layer is sha256:\" && has \"not the stage's package $TWOS\" && [ \$(copies) -eq 0 ]"

  # A staged image missing (otelcol-validator never pushed).
  V=9.9.94
  stage "$V" otelcol-validator
  run "$TR_CONFIG" --version "$V" --digests "$tmp/stage-$V/digests.txt" --registry "$REG"
  check "a staged image missing: refused (exit 1), named, nothing copied" \
    "[ $rc -eq 1 ] && has '$STAGED/otelcol-validator:$V is missing' && [ \$(copies) -eq 0 ] && [ -z \"\$(remote '$PUBLIC/api:$V')\" ]"

  # A public tag that already exists with another digest.
  V=9.9.95
  stage "$V"
  tr_fixture "$tmp/public-web.oci.tar" "$V" "$revision" PUBLIC-WEB >/dev/null
  tr_put "$tmp/public-web.oci.tar" "$PUBLIC/web:$V" "$real_crane" "$TR_CONFIG"
  before="$(remote "$PUBLIC/web:$V")"
  run "$TR_CONFIG" --version "$V" --digests "$tmp/stage-$V/digests.txt" --registry "$REG"
  check "a public tag holding another digest: refused (exit 1), never overwritten, nothing else copied" \
    "[ $rc -eq 1 ] && has '$PUBLIC/web:$V holds $before, not the stage' && has 'never overwritten' && [ \$(copies) -eq 0 ] && [ \"\$(remote '$PUBLIC/web:$V')\" = '$before' ] && [ -z \"\$(remote '$PUBLIC/api:$V')\" ]"

  if [ "$TR_AUTH" = 1 ]; then
    V=9.9.96
    stage "$V"
    run "$tmp/stub" --version "$V" --digests "$tmp/stage-$V/digests.txt" --registry "$REG"
    check "no login: the stage can't be read (UNAUTHORIZED), refused (exit 1), nothing copied" \
      "[ $rc -eq 1 ] && has \"can't tell whether\" && has 'UNAUTHORIZED' && [ \$(copies) -eq 0 ]"
    check "no file of the test's work folder or output holds the registry's test credential (boolean)" \
      "! tr_secret_in '$tmp/t' '$logs'"
  else
    skip "the login cases" "no htpasswd: the throwaway registry has no login"
  fi
else
  for c in "a clean promote" "a re-run" "a promote that stopped part way" "a wrong digest" "a missing staged image" "a public tag that exists" "the login cases"; do
    skip "promote: $c" "${TR_SKIP:-no docker, crane or helm}"
  done
fi
tr_registry_stop
check "no credential helper was called" "[ ! -s '$logs/helper.log' ]"

echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
