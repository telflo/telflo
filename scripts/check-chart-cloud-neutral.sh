#!/usr/bin/env bash
# The charts are cloud-neutral (D33-1 decisions 9 and 32): nothing in a
# chart, or rendered from it, names a cloud provider's annotations, identity
# bindings, API groups, hostnames or storage classes. Cloud details belong in
# an operator's own values files, passed through the charts' annotation
# maps, never in a chart.
#
# Adapted from the opamp-server repository's scripts/check-chart-cloud-neutral.sh
# at v0.1.0 (f0601e7dc3094c14e7241b40048455098e9c61e8; D26 decision 32),
# Copyright the Telflo authors, licensed under the Apache License, Version
# 2.0 (http://www.apache.org/licenses/LICENSE-2.0). The changes: each chart's
# annotation-value paths (and the checksum keys a template may write) come
# from a list per chart (chart_settings below) instead of one hard-coded
# list; with no argument it checks both of the platform's charts, each with
# every one of its profiles; a vendored dependency's templates are checked
# too; and every line names its chart.
#
# Usage: scripts/check-chart-cloud-neutral.sh [CHART_DIR [PROFILES_DIR]]
#   no argument   charts/telflo (the vendored opamp-server chart
#                 included) with charts/telflo/tests/profiles, and
#                 charts/supervisor-collector with
#                 scripts/cloud-neutral-profiles/supervisor-collector
#   CHART_DIR     one chart, its settings chosen by its Chart.yaml's name
#   PROFILES_DIR  default: CHART_DIR/tests/profiles (complete values files)
#
# It fails (exit 1) when, for a chart:
#   - a file the chart packages (every file `helm package` puts in the .tgz:
#     templates, values.yaml, values.schema.json, README.md, NOTES.txt, a
#     vendored chart's files, ...) holds a cloud marker;
#   - the chart rendered with any profile holds one (a chart's defaults
#     can't render alone: a profile is the defaults plus the names an install
#     must give);
#   - a template writes an annotation key itself: annotations come only from
#     the values maps (chart_settings), except a pod template's checksum of
#     something the chart renders (checksum/<name>: a hash, never a cloud's
#     key) and Helm's own helm.sh/resource-policy: keep (that key with that
#     value only: a volume `helm uninstall` leaves; Ruling 331). Checked
#     twice: in the templates' text, and by rendering every profile with
#     those maps emptied, when no other annotation may be left.
#
# Offline: only `helm package` and `helm template`, with every HELM_* variable
# unset and Helm's homes in a temporary directory. Prints PASS/FAIL lines
# naming a chart, a file, a profile and a marker, never a value. Exit 2 when
# it can't run. bash 3.2 compatible.
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# The markers (the design's list): matched anywhere, ignoring case.
MARKERS="amazonaws.com
arn:aws
service.beta.kubernetes.io/aws-
eks.amazonaws.com
elbv2.k8s.aws
iam.gke.io
cloud.google.com
azure.workload.identity
service.beta.kubernetes.io/azure-"
# The clouds' storage classes: matched as whole words, ignoring case.
STORAGE_CLASSES="gp2
gp3
standard-rwo
managed-csi"
# The only annotation keys a template may write itself: a pod template's
# checksum of an object the chart renders, so a change rolls the pods; and
# Helm's own resource policy, with the value keep alone (an object
# `helm uninstall` leaves, such as a volume of data; Ruling 331), written
# exactly so: KEEP_KEY, KEEP_VALUE.
ALLOWED_KEY='checksum/[a-z0-9][a-z0-9.-]*'
KEEP_KEY='helm.sh/resource-policy'
KEEP_VALUE='keep'

# chart_settings <chart name>: sets ANNOTATION_VALUES, the values maps a
# rendered annotation may come from, and PACKAGED_FILES, the files its
# package must hold to be checked. Returns 1 for a chart it doesn't know.
chart_settings() {
  case "$1" in
    telflo)
      ANNOTATION_VALUES="api.podAnnotations
api.serviceAccount.annotations
web.podAnnotations
gateway.podAnnotations
gateway.service.annotations
otelcolValidator.podAnnotations
otelcolTesting.podAnnotations
ottlEvaluator.podAnnotations
postgres.podAnnotations
opamp-server.podAnnotations
opamp-server.service.agent.annotations
opamp-server.service.management.annotations
opamp-server.serviceAccount.annotations
opamp-server.postgres.podAnnotations"
      PACKAGED_FILES="Chart.yaml values.yaml values.schema.json README.md templates/NOTES.txt"
      ;;
    supervisor-collector)
      # It takes no annotation from values; its pods' checksums only.
      ANNOTATION_VALUES=""
      # It has no schema and no NOTES.txt.
      PACKAGED_FILES="Chart.yaml values.yaml README.md"
      ;;
    *) return 1 ;;
  esac
}

if ! command -v helm >/dev/null 2>&1; then echo "cloud-neutral check: helm is not on PATH" >&2; exit 2; fi
if [ "$#" -gt 2 ]; then echo "usage: $0 [CHART_DIR [PROFILES_DIR]]" >&2; exit 2; fi
if [ "$#" -ge 1 ]; then
  [ -f "$1/Chart.yaml" ] || { echo "cloud-neutral check: no chart at the path given" >&2; exit 2; }
  PAIRS="$(cd "$1" && pwd)|${2:-$1/tests/profiles}"
else
  PAIRS="$REPO_DIR/charts/telflo|$REPO_DIR/charts/telflo/tests/profiles
$REPO_DIR/charts/supervisor-collector|$REPO_DIR/scripts/cloud-neutral-profiles/supervisor-collector"
fi

for v in $(env | sed -n 's/^\(HELM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cloud-neutral.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "cloud-neutral check: no temporary directory" >&2; exit 2; fi
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/docker" "$tmp/helm/cache" "$tmp/helm/config" "$tmp/helm/data" "$tmp/kube" || exit 2
export HOME="$tmp/home" DOCKER_CONFIG="$tmp/docker" KUBECONFIG="$tmp/kube/config"
export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"

# A throwaway chart that lists every annotation key a rendered manifest
# stream holds: "# A <Kind>/<name><path>.annotations <key> <JSON value>"
# (D26's walk, one line a key).
mkdir -p "$tmp/annotations/templates" || exit 2
printf 'apiVersion: v2\nname: annotations\nversion: 0.0.0\n' >"$tmp/annotations/Chart.yaml"
cat >"$tmp/annotations/templates/list.yaml" <<'TEMPLATE'
{{- define "walk" }}
{{- $p := index . 0 }}
{{- $v := index . 1 }}
{{- if kindIs "map" $v }}
{{- range $k, $x := $v }}
{{- if and (eq $k "annotations") $x }}
{{- if kindIs "map" $x }}
{{- range $key, $val := $x }}
# A {{ $p }}.annotations {{ $key }} {{ toJson $val }}
{{- end }}
{{- else }}
# A {{ $p }}.annotations ?
{{- end }}
{{- end }}
{{- include "walk" (list (printf "%s.%s" $p $k) $x) }}
{{- end }}
{{- else if kindIs "slice" $v }}
{{- range $i, $x := $v }}{{ include "walk" (list (printf "%s[%d]" $p $i) $x) }}{{ end }}
{{- end }}
{{- end }}
{{- range $raw := regexSplit "(?m)^---$" .Values.doc -1 }}
{{- $d := fromYaml $raw }}
{{- if hasKey $d "Error" }}
# A ERROR
{{- else if hasKey $d "kind" }}
{{- include "walk" (list (printf "%s/%s" $d.kind (dig "metadata" "name" "" $d)) $d) }}
{{- end }}
{{- end }}
TEMPLATE

failures=0
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

# markers_in <file>: each marker the file holds, one a line
markers_in() {
  local m
  while IFS= read -r m; do
    [ -n "$m" ] && grep -qiF -- "$m" "$1" && echo "$m"
  done <<EOF
$MARKERS
EOF
  while IFS= read -r m; do
    [ -n "$m" ] && grep -qiwF -- "$m" "$1" && echo "$m"
  done <<EOF
$STORAGE_CLASSES
EOF
  return 0
}

# check_chart <chart dir> <profiles dir>
check_chart() {
  local chart_dir="$1" profiles_dir="$2" chart work tgz pkg_root found_files before rel profiles name empty_args key left
  chart="$(sed -n 's/^name:[ ]*"\{0,1\}\([A-Za-z0-9_.-]*\)"\{0,1\}[ ]*$/\1/p' "$chart_dir/Chart.yaml" | head -1)"
  if ! chart_settings "$chart"; then
    echo "cloud-neutral check: no settings for the chart named '$chart' (chart_settings)" >&2
    return 2
  fi
  if [ ! -d "$profiles_dir" ]; then
    echo "cloud-neutral check: no profiles directory for $chart at the path given" >&2
    return 2
  fi
  profiles_dir="$(cd "$profiles_dir" && pwd)"
  work="$tmp/$chart"
  rm -rf "$work"
  mkdir -p "$work/pkg" "$work/x" || return 2

  # --- 1. every file the chart packages ---------------------------------------
  if ! helm package "$chart_dir" -d "$work/pkg" >"$work/package.out" 2>&1; then
    echo "cloud-neutral check: helm package failed for $chart" >&2
    return 2
  fi
  tgz="$(ls "$work/pkg"/*.tgz 2>/dev/null | head -1)"
  [ -n "$tgz" ] && tar -xzf "$tgz" -C "$work/x" || { echo "cloud-neutral check: $chart's package can't be read" >&2; return 2; }
  pkg_root="$(ls -d "$work/x"/*/ | head -1)"
  pkg_root="${pkg_root%/}"
  for want in $PACKAGED_FILES; do
    [ -f "$pkg_root/$want" ] || fail "$chart: the package holds no $want to check"
  done
  found_files=0
  before=$failures
  while IFS= read -r file; do
    found_files=$((found_files + 1))
    rel="${file#"$pkg_root"/}"
    for m in $(markers_in "$file"); do fail "$chart: packaged file $rel holds the cloud marker $m"; done
  done <<EOF
$(find "$pkg_root" -type f | sort)
EOF
  [ "$failures" = "$before" ] && echo "PASS - $chart: no cloud marker in the $found_files files the chart packages"

  # --- 2. the chart rendered with each profile --------------------------------
  profiles="$(find "$profiles_dir" -maxdepth 1 -type f -name '*.yaml' | sort)"
  [ -n "$profiles" ] || { echo "cloud-neutral check: no profile to render $chart with" >&2; return 2; }
  while IFS= read -r profile; do
    name="$(basename "$profile")"
    before=$failures
    if ! helm template check "$pkg_root" -f "$profile" >"$work/render.yaml" 2>"$work/render.err"; then
      fail "$chart: the chart doesn't render with the profile $name"
      continue
    fi
    for m in $(markers_in "$work/render.yaml"); do fail "$chart: rendered with $name: holds the cloud marker $m"; done
    [ "$failures" = "$before" ] && echo "PASS - $chart: no cloud marker rendered with $name"
  done <<EOF
$profiles
EOF

  # --- 3. no annotation key written by a template -----------------------------
  # a) The templates' text (the chart's and a vendored chart's): under an
  #    `annotations:` key, every line is a template action ({{ … }}), a
  #    comment, a checksum/<name> key or exactly `helm.sh/resource-policy:
  #    keep`, never another literal key; and no inline `annotations: {…}`
  #    map.
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    rel="${file#"$pkg_root"/}"
    awk -v rel="$rel" -v allowed="^($ALLOWED_KEY):" -v keep="$KEEP_KEY: $KEEP_VALUE" '
      function indent(s) { match(s, /^ */); return RLENGTH }
      {
        line = $0
        if (open) {
          trimmed = line; sub(/^[ \t]+/, "", trimmed)
          if (trimmed == "" || trimmed ~ /^\{\{/ || trimmed ~ /^#/) next
          if (indent(line) > depth) { if (trimmed !~ allowed && trimmed != keep) print rel ":" NR; next }
          open = 0
        }
        if (line ~ /^[ \t-]*annotations:[ \t]*$/) { open = 1; depth = indent(line); next }
        # an inline map with a key, or any other value but a template action or {}
        if (line ~ /^[ \t-]*annotations:[ \t]*[^ \t{#]/ || line ~ /^[ \t-]*annotations:[ \t]*\{[ \t]*[^{} \t]/) print rel ":" NR
      }' "$file"
  done <<EOF >"$work/static.txt"
$(find "$pkg_root" -type f -path '*/templates/*' \( -name '*.yaml' -o -name '*.yml' -o -name '*.tpl' \) | sort)
EOF
  if [ -s "$work/static.txt" ]; then
    while IFS= read -r where; do fail "$chart: template ${where%:*} line ${where##*:} writes an annotation key itself"; done <"$work/static.txt"
  else
    echo "PASS - $chart: no template writes an annotation key itself"
  fi

  # b) Rendered with every annotation map emptied, nothing has an annotation
  #    but a checksum/<name> and helm.sh/resource-policy with the value keep.
  empty_args=""
  for key in $ANNOTATION_VALUES; do empty_args="$empty_args --set $key=null"; done
  while IFS= read -r profile; do
    name="$(basename "$profile")"
    # shellcheck disable=SC2086 # empty_args is a list of words
    if ! helm template check "$pkg_root" -f "$profile" $empty_args >"$work/bare.yaml" 2>"$work/bare.err" ||
      ! helm template a "$tmp/annotations" --set-file "doc=$work/bare.yaml" >"$work/bare.list" 2>"$work/bare.list.err"; then
      fail "$chart: the chart doesn't render with the profile $name and its annotation maps emptied"
      continue
    fi
    left="$(sed -n 's/^# A //p' "$work/bare.list" | awk -v allowed="^($ALLOWED_KEY)$" -v kk="$KEEP_KEY" -v kv="\"$KEEP_VALUE\"" \
      '$2 ~ allowed { next } NF == 3 && $2 == kk && $3 == kv { next } { print $1 }' | sort -u)"
    if [ -n "$left" ]; then
      while IFS= read -r where; do fail "$chart: rendered with $name, every annotation map emptied: an annotation is left at $where"; done <<EOF
$left
EOF
    else
      echo "PASS - $chart: no annotation rendered with $name once its annotation maps are emptied"
    fi
  done <<EOF
$profiles
EOF
  return 0
}

status=0
while IFS='|' read -r chart_dir profiles_dir; do
  [ -n "$chart_dir" ] || continue
  check_chart "$chart_dir" "$profiles_dir" || status=$?
  [ "$status" = 0 ] || exit "$status"
done <<EOF
$PAIRS
EOF

if [ "$failures" -gt 0 ]; then
  echo "cloud-neutral check: $failures failure(s)"
  exit 1
fi
echo "cloud-neutral check: passed"
