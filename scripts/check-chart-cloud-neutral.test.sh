#!/usr/bin/env bash
# The cloud-neutral check's self-test: the check passes on the platform's
# two charts as they are, and fails on a copy broken each way it must
# catch:
#   - a cloud marker in a file the chart packages: a template (the chart's
#     and the vendored opamp-server chart's), values.yaml, values.schema.json,
#     the README, NOTES.txt;
#   - a cloud marker only in the rendered output (an annotation passed
#     through a values map; a cloud's storage class);
#   - an annotation key written by a template: literally, built at render
#     time, in a branch no profile renders, as an inline map, in the
#     vendored chart, and in supervisor-collector; and an annotation map
#     left out of the chart's list.
# A checksum/<name> key, which a template may write, passes, and so does
# exactly `helm.sh/resource-policy: keep`; that key with another value, a key
# beside it, or another helm.sh key still fails.
#
# Run: scripts/check-chart-cloud-neutral.test.sh
# Offline; prints PASS/FAIL lines only; exit 1 when any case failed. Every
# copy is a throwaway repository layout (the script, both charts, the
# profiles) in a temporary directory removed on exit; the repository's own
# files are only read. bash 3.2 compatible.
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cloud-neutral-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0
n=0
run_case() { # <name> <command...>
  local name="$1"; shift
  if "$@"; then
    echo "PASS - $name"; passed=$((passed + 1))
  else
    echo "FAIL - $name"; failed=$((failed + 1))
  fi
}

# fresh: a new copy in $c (the script, both charts, the profiles); P is its
# telflo chart, S its supervisor-collector. check: run the copy's
# script (args passed on), its output in $c.out and its exit status in $c.rc.
fresh() {
  n=$((n + 1)); c="$tmp/case$n"
  mkdir -p "$c/scripts" "$c/charts" &&
    cp "$REPO_DIR/scripts/check-chart-cloud-neutral.sh" "$c/scripts/" &&
    cp -R "$REPO_DIR/scripts/cloud-neutral-profiles" "$c/scripts/" &&
    cp -R "$REPO_DIR/charts/telflo" "$REPO_DIR/charts/supervisor-collector" "$c/charts/" || return 1
  P="$c/charts/telflo"
  S="$c/charts/supervisor-collector"
}
check() { TMPDIR="$tmp" bash "$c/scripts/check-chart-cloud-neutral.sh" "$@" >"$c.out" 2>"$c.err"; echo $? >"$c.rc"; }
has() { grep -qxF -- "$1" "$c.out"; }
fails_with() { # <expected FAIL lines...>: exit 1, and each line among its failures
  local line
  [ "$(cat "$c.rc")" = 1 ] || return 1
  for line in "$@"; do has "FAIL - $line" || return 1; done
}
no_fail_matching() { ! grep -q -- "^FAIL - $1" "$c.out"; }
line_of() { grep -n -- "$2" "$1" | head -1 | cut -d: -f1; }

# The fixtures.
marker_template() { # a template holding a cloud marker (an identity's ARN), which renders it too
  cat <<'EOF'
# A fixture for check-chart-cloud-neutral.test.sh.
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-fixture
data:
  role: "arn:aws:iam::000000000000:role/fixture"
EOF
}
hard_coded_key() { # a template writing an annotation key itself (no marker: the key alone is the fault)
  cat <<'EOF'
# A fixture for check-chart-cloud-neutral.test.sh.
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-fixture
  annotations:
    example.invalid/hard-coded: "yes"
data: {}
EOF
}
built_key() { # a key built at render time, which only the output shows
  cat <<'EOF'
# A fixture for check-chart-cloud-neutral.test.sh.
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-fixture
  annotations:
    {{ printf "%s/%s" "example.invalid" "built" }}: "yes"
data: {}
EOF
}
unrendered_key() { # a hard-coded key in a branch no profile renders, which only the text shows
  cat <<'EOF'
# A fixture for check-chart-cloud-neutral.test.sh.
{{- if .Values.fixtureNeverSet }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-fixture
  annotations:
    example.invalid/unrendered: "yes"
data: {}
{{- end }}
EOF
}
inline_key() { # an inline annotation map
  cat <<'EOF'
# A fixture for check-chart-cloud-neutral.test.sh.
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-fixture
  annotations: {example.invalid/inline: "yes"}
data: {}
EOF
}
checksum_key() { # a pod template's checksum, which a template may write
  cat <<'EOF'
# A fixture for check-chart-cloud-neutral.test.sh.
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-fixture
  annotations:
    checksum/fixture-config: {{ "fixture" | sha256sum | quote }}
data: {}
EOF
}
keep_key() { # Helm's resource policy, <value> (keep, the one allowed), and <extra key line> beside it, if any
  cat <<EOF
# A fixture for check-chart-cloud-neutral.test.sh.
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-fixture
  annotations:
    helm.sh/resource-policy: $1
$2
data: {}
EOF
}

# ---------------------------------------------------------------------------
as_they_are() {
  fresh && check || return 1
  [ "$(cat "$c.rc")" = 0 ] && has "cloud-neutral check: passed" && ! grep -q '^FAIL' "$c.out" &&
    grep -q '^PASS - telflo: ' "$c.out" && grep -q '^PASS - supervisor-collector: ' "$c.out" &&
    for p in default full local-file-store no-network-policy s3-file-store; do
      has "PASS - telflo: no cloud marker rendered with $p.yaml" &&
        has "PASS - telflo: no annotation rendered with $p.yaml once its annotation maps are emptied" || return 1
    done &&
    for p in node cluster gateway; do has "PASS - supervisor-collector: no cloud marker rendered with $p.yaml" || return 1; done
}
run_case "both charts as they are pass, every profile rendered" as_they_are
the_repo_itself() { TMPDIR="$tmp" bash "$REPO_DIR/scripts/check-chart-cloud-neutral.sh" >"$tmp/repo.out" 2>&1 && grep -qx 'cloud-neutral check: passed' "$tmp/repo.out"; }
run_case "the repository's own charts pass" the_repo_itself

# --- the first half: markers in the chart -------------------------------------
in_template() {
  fresh && marker_template >"$P/templates/marker-template.yaml" && check
  fails_with "telflo: packaged file templates/marker-template.yaml holds the cloud marker arn:aws" \
    "telflo: rendered with default.yaml: holds the cloud marker arn:aws" &&
    no_fail_matching "supervisor-collector"
}
run_case "a marker in a template fails (the packaged file and the output)" in_template
in_vendored() {
  fresh && marker_template >"$P/charts/opamp-server/templates/marker-template.yaml" && check
  fails_with "telflo: packaged file charts/opamp-server/templates/marker-template.yaml holds the cloud marker arn:aws" \
    "telflo: rendered with full.yaml: holds the cloud marker arn:aws"
}
run_case "a marker in the vendored opamp-server chart's template fails" in_vendored
in_values() {
  fresh && printf '# A fixture line for check-chart-cloud-neutral.test.sh:\n# storageClassName: gp3\n' >>"$P/values.yaml" && check
  fails_with "telflo: packaged file values.yaml holds the cloud marker gp3" && no_fail_matching "telflo: rendered with"
}
run_case "a marker only in values.yaml (a comment, never rendered) fails" in_values
in_schema() {
  fresh && sed 's|"title": "telflo chart values"|"title": "telflo chart values azure.workload.identity/client-id"|' \
    "$REPO_DIR/charts/telflo/values.schema.json" >"$P/values.schema.json" && check
  fails_with "telflo: packaged file values.schema.json holds the cloud marker azure.workload.identity" &&
    no_fail_matching "telflo: rendered with"
}
run_case "a marker in values.schema.json fails" in_schema
in_readme() {
  fresh && printf '\nA fixture paragraph: set `service.beta.kubernetes.io/aws-load-balancer-type: external`.\n' >>"$P/README.md" && check
  fails_with "telflo: packaged file README.md holds the cloud marker service.beta.kubernetes.io/aws-" &&
    no_fail_matching "telflo: rendered with"
}
run_case "a marker in the README fails" in_readme
in_notes() {
  fresh && printf 'A fixture line: annotate the account with iam.gke.io/gcp-service-account.\n' >>"$P/templates/NOTES.txt" && check
  fails_with "telflo: packaged file templates/NOTES.txt holds the cloud marker iam.gke.io"
}
run_case "a marker in NOTES.txt fails" in_notes
in_supervisor() {
  fresh && marker_template >"$S/templates/marker-template.yaml" && check
  fails_with "supervisor-collector: packaged file templates/marker-template.yaml holds the cloud marker arn:aws" \
    "supervisor-collector: rendered with gateway.yaml: holds the cloud marker arn:aws" && no_fail_matching "telflo:"
}
run_case "a marker in supervisor-collector's template fails, naming that chart" in_supervisor

# --- the second half: markers only in the rendered output ------------------------
# required_profile <file> <opamp-server's extra lines>: the default
# profile's values, written whole (a second top-level key would be YAML's
# duplicate), with more lines under opamp-server.
required_profile() {
  printf 'publicUrl: https://telflo.example.com\napi:\n  mail:\n    from: noreply@telflo.example.com\n    smtp:\n      host: smtp.example.com\n' >"$1" &&
    printf 'opamp-server:\n  server:\n    publicUrl: https://opamp.example.com/opamp/api/v1\n%s\n' "$2" >>"$1"
}
only_output() {
  fresh && required_profile "$P/tests/profiles/output-only.yaml" \
    "$(printf '  service:\n    agent:\n      annotations:\n        service.beta.kubernetes.io/azure-load-balancer-internal: "true"')" && check
  fails_with "telflo: rendered with output-only.yaml: holds the cloud marker service.beta.kubernetes.io/azure-" &&
    no_fail_matching "telflo: packaged file" && no_fail_matching "telflo: rendered with default.yaml"
}
run_case "a marker only in the output (a cloud annotation through opamp-server.service.agent.annotations) fails" only_output
identity_output() {
  fresh && required_profile "$P/tests/profiles/identity.yaml" \
    "$(printf '  serviceAccount:\n    annotations:\n      eks.amazonaws.com/role-arn: fixture')" && check
  fails_with "telflo: rendered with identity.yaml: holds the cloud marker eks.amazonaws.com" && no_fail_matching "telflo: packaged file"
}
run_case "a cloud identity through the vendored chart's serviceAccount.annotations fails (the output)" identity_output
storage_class() {
  fresh && cat "$P/tests/profiles/default.yaml" >"$P/tests/profiles/storage-class.yaml" &&
    printf 'postgres:\n  storageClassName: managed-csi\n' >>"$P/tests/profiles/storage-class.yaml" && check
  fails_with "telflo: rendered with storage-class.yaml: holds the cloud marker managed-csi" && no_fail_matching "telflo: packaged file"
}
run_case "a cloud's storage class in the output fails" storage_class

# --- the third half: annotation keys written by a template ------------------------
hard_coded() {
  fresh && hard_coded_key >"$P/templates/hard-coded-key.yaml" && check
  fails_with "telflo: template templates/hard-coded-key.yaml line $(hard_coded_key >"$c.fx"; line_of "$c.fx" 'example.invalid/hard-coded') writes an annotation key itself" \
    "telflo: rendered with default.yaml, every annotation map emptied: an annotation is left at ConfigMap/check-fixture.metadata.annotations" &&
    no_fail_matching "telflo: packaged file" && no_fail_matching "telflo: rendered with default.yaml:"
}
run_case "a hard-coded annotation key fails (the templates' text and the output)" hard_coded
built() {
  fresh && built_key >"$P/templates/hard-coded-key-built.yaml" && check
  fails_with "telflo: rendered with full.yaml, every annotation map emptied: an annotation is left at ConfigMap/check-fixture.metadata.annotations" &&
    no_fail_matching "telflo: template "
}
run_case "an annotation key built at render time fails (the output)" built
unrendered() {
  fresh && unrendered_key >"$P/templates/hard-coded-key-unrendered.yaml" && check
  fails_with "telflo: template templates/hard-coded-key-unrendered.yaml line $(unrendered_key >"$c.fx"; line_of "$c.fx" 'example.invalid/unrendered') writes an annotation key itself" &&
    no_fail_matching "telflo: rendered with"
}
run_case "a hard-coded key in a branch no profile renders fails (the templates' text)" unrendered
inline() {
  fresh && inline_key >"$P/templates/hard-coded-key-inline.yaml" && check
  fails_with "telflo: template templates/hard-coded-key-inline.yaml line $(inline_key >"$c.fx"; line_of "$c.fx" 'annotations: {') writes an annotation key itself" \
    "telflo: rendered with s3-file-store.yaml, every annotation map emptied: an annotation is left at ConfigMap/check-fixture.metadata.annotations"
}
run_case "an inline annotation map fails" inline
vendored_key() {
  fresh && hard_coded_key >"$P/charts/opamp-server/templates/hard-coded-key.yaml" && check
  fails_with "telflo: template charts/opamp-server/templates/hard-coded-key.yaml line $(hard_coded_key >"$c.fx"; line_of "$c.fx" 'example.invalid/hard-coded') writes an annotation key itself"
}
run_case "a hard-coded key in the vendored chart's template fails" vendored_key
supervisor_key() {
  fresh && hard_coded_key >"$S/templates/hard-coded-key.yaml" && check
  fails_with "supervisor-collector: template templates/hard-coded-key.yaml line $(hard_coded_key >"$c.fx"; line_of "$c.fx" 'example.invalid/hard-coded') writes an annotation key itself" \
    "supervisor-collector: rendered with node.yaml, every annotation map emptied: an annotation is left at ConfigMap/check-fixture.metadata.annotations"
}
run_case "a hard-coded key in supervisor-collector's template fails" supervisor_key
checksum_ok() {
  fresh && checksum_key >"$P/templates/checksum-key.yaml" && check || return 1
  [ "$(cat "$c.rc")" = 0 ] && has "cloud-neutral check: passed"
}
run_case "a checksum/<name> key a template writes passes (supervisor-collector's checksum/token among them)" checksum_ok
keep_ok() {
  fresh && keep_key keep "" >"$P/templates/keep-key.yaml" && keep_key keep "" >"$S/templates/keep-key.yaml" && check || return 1
  [ "$(cat "$c.rc")" = 0 ] && has "cloud-neutral check: passed" &&
    has "PASS - telflo: no template writes an annotation key itself" &&
    has "PASS - supervisor-collector: no template writes an annotation key itself" &&
    grep -qx '    helm.sh/resource-policy: keep' "$REPO_DIR/charts/telflo/templates/api.yaml"
}
run_case "exactly helm.sh/resource-policy: keep passes, in either chart (the API's file-store claim holds it)" keep_ok
keep_other_value() {
  fresh && keep_key delete "" >"$P/templates/keep-key.yaml" && check
  fails_with "telflo: template templates/keep-key.yaml line $(keep_key delete "" >"$c.fx"; line_of "$c.fx" 'helm.sh/resource-policy') writes an annotation key itself" \
    "telflo: rendered with default.yaml, every annotation map emptied: an annotation is left at ConfigMap/check-fixture.metadata.annotations"
}
run_case "helm.sh/resource-policy with another value fails (the templates' text and the output)" keep_other_value
keep_quoted() {
  fresh && keep_key '"keep"' "" >"$P/templates/keep-key.yaml" && check
  fails_with "telflo: template templates/keep-key.yaml line $(keep_key '"keep"' "" >"$c.fx"; line_of "$c.fx" 'helm.sh/resource-policy') writes an annotation key itself"
}
run_case "helm.sh/resource-policy written other than exactly (quoted) fails (the templates' text)" keep_quoted
keep_beside() {
  fresh && keep_key keep '    example.invalid/hard-coded: "yes"' >"$P/templates/keep-key.yaml" && check
  fails_with "telflo: template templates/keep-key.yaml line $(keep_key keep '    example.invalid/hard-coded: "yes"' >"$c.fx"; line_of "$c.fx" 'example.invalid/hard-coded') writes an annotation key itself" \
    "telflo: rendered with full.yaml, every annotation map emptied: an annotation is left at ConfigMap/check-fixture.metadata.annotations" &&
    no_fail_matching "telflo: template templates/keep-key.yaml line $(line_of "$c.fx" 'helm.sh/resource-policy') "
}
run_case "another hard-coded key beside helm.sh/resource-policy: keep still fails (and only it, in the text)" keep_beside
other_helm_key() {
  fresh && keep_key keep '    helm.sh/hook-weight: "1"' >"$P/templates/keep-key.yaml" && check
  fails_with "telflo: template templates/keep-key.yaml line $(keep_key keep '    helm.sh/hook-weight: "1"' >"$c.fx"; line_of "$c.fx" 'helm.sh/hook-weight') writes an annotation key itself" \
    "telflo: rendered with default.yaml, every annotation map emptied: an annotation is left at ConfigMap/check-fixture.metadata.annotations"
}
run_case "another helm.sh/ key (helm.sh/hook-weight) still fails" other_helm_key
keep_built() { # the key built at render time with another value: only the output shows it
  fresh && keep_key keep "" | sed 's|helm.sh/resource-policy: keep|{{ printf "%s" "helm.sh/resource-policy" }}: {{ "retain" }}|' >"$P/templates/keep-key.yaml" && check
  fails_with "telflo: rendered with s3-file-store.yaml, every annotation map emptied: an annotation is left at ConfigMap/check-fixture.metadata.annotations"
}
run_case "helm.sh/resource-policy rendered with another value fails (the output checks the value too)" keep_built
list_matters() {
  fresh || return 1
  grep -qx 'postgres.podAnnotations' "$c/scripts/check-chart-cloud-neutral.sh" || return 1
  sed '/^postgres\.podAnnotations$/d' "$REPO_DIR/scripts/check-chart-cloud-neutral.sh" >"$c/scripts/check-chart-cloud-neutral.sh" && check
  fails_with "telflo: rendered with full.yaml, every annotation map emptied: an annotation is left at StatefulSet/telflo-postgres.spec.template.metadata.annotations" &&
    no_fail_matching "telflo: rendered with default.yaml"
}
run_case "the chart's list of annotation maps is what's emptied: one left out of it (postgres.podAnnotations) fails" list_matters

# --- arguments ---------------------------------------------------------------------
one_chart() {
  fresh && marker_template >"$S/templates/marker-template.yaml" && check "$P" || return 1
  [ "$(cat "$c.rc")" = 0 ] && has "cloud-neutral check: passed" && ! grep -q 'supervisor-collector' "$c.out"
}
run_case "CHART_DIR checks that chart alone, with its own profiles" one_chart
unknown_chart() {
  fresh && sed 's/^name: telflo$/name: another-chart/' "$REPO_DIR/charts/telflo/Chart.yaml" >"$P/Chart.yaml" && check "$P"
  [ "$(cat "$c.rc")" = 2 ] && grep -qF "no settings for the chart named 'another-chart'" "$c.err"
}
run_case "a chart it has no settings for can't be checked (exit 2)" unknown_chart
no_notes() {
  fresh && rm "$P/templates/NOTES.txt" && check
  fails_with "telflo: the package holds no templates/NOTES.txt to check" && no_fail_matching "supervisor-collector"
}
run_case "the platform chart's package must hold its NOTES.txt (its list of files to check)" no_notes
no_schema() {
  fresh && rm "$P/values.schema.json" && check
  fails_with "telflo: the package holds no values.schema.json to check"
}
run_case "the platform chart's package must hold its values.schema.json" no_schema
no_profiles() { fresh && rm -rf "$P/tests/profiles" && check; [ "$(cat "$c.rc")" = 2 ]; }
run_case "a chart without profiles can't be checked (exit 2)" no_profiles

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
