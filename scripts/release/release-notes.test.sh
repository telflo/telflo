#!/bin/bash
# Tests for scripts/release/release-notes.sh: offline, from digest files and a
# tiny chart package made here. bash 3.2 compatible.
# Run:  bash scripts/release/release-notes.test.sh
set -u
# One spelling of the temporary folder (no trailing slash, no //).
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/release/release-notes.sh"
shell="${BASH:-bash}"

failures=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/release-notes-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT
V=9.9.97
IMAGES="api web otelcol-validator otelcol-testing ottl-evaluator"
oci="$tmp/oci"; mkdir -p "$oci"
n=1
for i in $IMAGES; do printf 'sha256:%064d\n' "$n" >"$oci/$i.digest"; n=$((n + 1)); done
chart() { # <folder> <name> <version> <appVersion>: <folder>/<name>-<version>.tgz
  mkdir -p "$1/src/$2"
  printf 'apiVersion: v2\nname: %s\nversion: %s\nappVersion: "%s"\n' "$2" "$3" "$4" >"$1/src/$2/Chart.yaml"
  (cd "$1/src" && tar -czf "$1/$2-$3.tgz" "$2")
}
chart "$tmp/good" telflo "$V" "$V"
chart "$tmp/sc" supervisor-collector "$V" "$V"
chart "$tmp/old" telflo 9.9.96 9.9.96
chart "$tmp/app" telflo "$V" 9.9.96
package="$tmp/good/telflo-$V.tgz"
sum="$(shasum -a 256 "$package" | cut -c1-64)"

run() { out="$("$shell" "$script" "$@" 2>"$tmp/stderr")"; rc=$?; err="$(cat "$tmp/stderr")"; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
err_has() { printf '%s\n' "$err" | grep -qF -- "$1"; }

run --oci "$oci" --chart "$package"
check "no --version refused (exit 2)" "[ $rc -eq 2 ] && err_has '--version must be x.y.z'"
run --oci "$oci" --chart "$package" --version v$V
check "a version that isn't x.y.z refused (exit 2)" "[ $rc -eq 2 ]"
run --oci "$tmp/none" --chart "$package" --version "$V"
check "a missing --oci folder refused (exit 2)" "[ $rc -eq 2 ]"
run --oci "$oci" --chart "$tmp/none.tgz" --version "$V"
check "a missing chart refused (exit 2)" "[ $rc -eq 2 ]"
run --oci "$oci" --chart "$tmp/sc/supervisor-collector-$V.tgz" --version "$V"
check "a package that isn't the chart telflo refused (exit 1)" "[ $rc -eq 1 ] && err_has \"isn't the chart telflo\" && [ -z \"\$out\" ]"
run --oci "$oci" --chart "$tmp/old/telflo-9.9.96.tgz" --version "$V"
check "a package of another version refused (exit 1)" "[ $rc -eq 1 ] && err_has \"version is '9.9.96', not $V\""
run --oci "$oci" --chart "$tmp/app/telflo-$V.tgz" --version "$V"
check "a package whose appVersion isn't the version refused (exit 1)" "[ $rc -eq 1 ] && err_has \"appVersion is '9.9.96'\""
mv "$oci/web.digest" "$tmp/web.digest"
run --oci "$oci" --chart "$package" --version "$V"
check "a missing digest file refused (exit 1)" "[ $rc -eq 1 ] && err_has 'web.digest is missing'"
printf 'sha256:abc\n' >"$oci/web.digest"
run --oci "$oci" --chart "$package" --version "$V"
check "a malformed digest file refused (exit 1)" "[ $rc -eq 1 ] && err_has \"isn't one line sha256\""
mv "$tmp/web.digest" "$oci/web.digest"

run --oci "$oci" --chart "$package" --version "$V"
# shellcheck disable=SC2034 # read by a check (eval)
first="$out"
check "the notes are written (exit 0), titled with the tag" "[ $rc -eq 0 ] && [ \"\$(printf '%s\n' \"\$out\" | head -n 1)\" = '# Telflo v$V' ]"
all_images=true
n=1
for i in $IMAGES; do
  has "| \`ghcr.io/telflo/telflo/$i:$V\` | \`sha256:$(printf '%064d' "$n")\` |" || all_images=false
  n=$((n + 1))
done
check "each image's reference and index digest, from its digest file" "$all_images"
check "the chart's reference, version and package sha256" "has '\`oci://ghcr.io/telflo/telflo/charts/telflo\`, version \`$V\` (package sha256 \`$sum\`)'"
offered="$("$shell" "$root/scripts/build-collector-image.sh" --list-offered | sed 's/.*/`&`/' | paste -sd, - | sed 's/,/, /g')"
chart_version="$(sed -n 's/^export const DEFAULT_HELM_CHART_VERSION = "\([^"]*\)";$/\1/p' "$root/telflo-core/packages/contracts/src/helm.ts")"
# shellcheck disable=SC2034 # read by a check (eval)
collector_line="Checked against the collector images \`ghcr.io/telflo/telflo/collector\` at $offered and the chart \`oci://ghcr.io/telflo/telflo/charts/supervisor-collector\` $chart_version."
check "the collector versions and the supervisor-collector chart it was checked against" 'has "$collector_line"'
check "links to the Quick start, docs/kubernetes.md and docs/compose.md at the tag" \
  "has 'https://github.com/telflo/telflo/blob/v$V/README.md#quick-start' && has 'https://github.com/telflo/telflo/blob/v$V/docs/kubernetes.md' && has 'https://github.com/telflo/telflo/blob/v$V/docs/compose.md' && has 'telflo-compose-$V.tar.gz'"
check "no date or time in the notes" "! printf '%s\n' \"\$out\" | grep -qE '20[0-9]{2}-[0-9]{2}-[0-9]{2}|[0-9]{2}:[0-9]{2}:[0-9]{2}'"
run --oci "$oci" --chart "$package" --version "$V"
check "deterministic: a second run writes the same bytes" "[ \"\$out\" = \"\$first\" ]"

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILURE(S)"; exit 1; fi
