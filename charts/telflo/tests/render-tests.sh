#!/usr/bin/env bash
# Render tests for charts/telflo, modeled on the opamp-server chart's own
# (charts/opamp-server/tests/render-tests.sh at its first release). The
# opamp-server's version is read from vendor/opamp-server/PIN, and the chart's
# own from its Chart.yaml (through scripts/release/version.sh), never written
# here: a patch release needs no test edit.
#
# `helm lint --strict` can't catch most of these: it lints with the values it
# is given, and only warns on a failing `required`. So every guard, name,
# credential reference and security setting is pinned here by a real
# `helm template`.
#
# Run:  bash charts/telflo/tests/render-tests.sh
#
# The harness renders every profile in tests/profiles/ once (the defaults
# plus what an install must give, and variations), checks what holds for the
# whole chart, then sources every tests/cases/*.sh in name order. A case
# file uses the helpers below; each_profile runs a check against every
# profile's rendering. Tasks add their components' cases as new files.
#
# Offline and credential-free: only `helm template` and `helm lint` (no
# registry, no cluster, no --debug). Every HELM_* variable is unset; Helm's
# homes, HOME, DOCKER_CONFIG and KUBECONFIG are empty directories in a
# temporary directory removed on exit. Each case prints PASS or FAIL and its
# name, never a value or Helm's output (an error's text can quote a value); a
# failing render is that case's FAIL and the script goes on. Exit 1 when any
# case failed. bash 3.2 compatible (macOS's /bin/bash).
set -u

CHART_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$CHART_DIR/../.." && pwd)"
PROFILES_DIR="$CHART_DIR/tests/profiles"
CASES_DIR="$CHART_DIR/tests/cases"
SUBCHART_DIR="$CHART_DIR/charts/opamp-server"
# The pinned opamp-server release (vendor/opamp-server/PIN, read with sed,
# never sourced).
PIN_VERSION="$(sed -n 's/^version=//p' "$REPO_DIR/vendor/opamp-server/PIN")"
PIN_DIGEST="$(sed -n 's/^digest=//p' "$REPO_DIR/vendor/opamp-server/PIN")"
# The chart's version and appVersion (the platform images' tag), and the
# release versions' one pattern.
# shellcheck source=scripts/release/version.sh
. "$REPO_DIR/scripts/release/version.sh"
CHART_VERSION="$(telflo_chart_field "$CHART_DIR/Chart.yaml" version)" || CHART_VERSION=""
CHART_APP_VERSION="$(telflo_chart_field "$CHART_DIR/Chart.yaml" appVersion)" || CHART_APP_VERSION=""

if ! command -v helm >/dev/null 2>&1; then
  echo "render tests: helm is not on PATH" >&2
  exit 2
fi

for v in $(env | sed -n 's/^\(HELM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
tmp="$(mktemp -d "${TMPDIR:-/tmp}/telflo-render.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "render tests: no temporary directory" >&2; exit 2; fi
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/docker" "$tmp/helm/cache" "$tmp/helm/config" "$tmp/helm/data" "$tmp/kube" "$tmp/p" || exit 2
export HOME="$tmp/home" DOCKER_CONFIG="$tmp/docker" KUBECONFIG="$tmp/kube/config"
export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"

REL=rel
NS=telflo

# A throwaway chart that flattens a rendered manifest stream, parsed with
# Helm's own fromYaml (what Helm reads a release's manifests with), into one
# line per leaf: "<Kind>/<name><path> <JSON value>". A list element that is a
# map with a "name" is addressed by it ("env[TELFLO_DATABASE_URL]") and also
# gets a line "<path>[<name>]#index <i>", for the order; any other element by
# its index. An empty map or list is "{}" or "[]"; a document that fails to
# parse is "ERROR" (never its error's text). The listing goes to a file,
# never to the output.
mkdir -p "$tmp/flat/templates" "$tmp/json/templates" || exit 2
printf 'apiVersion: v2\nname: flat\nversion: 0.0.0\n' >"$tmp/flat/Chart.yaml"
cat >"$tmp/flat/templates/list.yaml" <<'TEMPLATE'
{{- define "walk" }}
{{- $p := index . 0 }}
{{- $v := index . 1 }}
{{- if kindIs "map" $v }}
{{- if not $v }}
# L {{ $p }} {}
{{- end }}
{{- range $k, $x := $v }}{{ include "walk" (list (printf "%s.%s" $p $k) $x) }}{{ end }}
{{- else if kindIs "slice" $v }}
{{- if not $v }}
# L {{ $p }} []
{{- end }}
{{- range $i, $x := $v }}
{{- $seg := toString $i }}
{{- if and (kindIs "map" $x) (hasKey $x "name") }}
{{- $seg = toString $x.name }}
# L {{ $p }}[{{ $seg }}]#index {{ $i }}
{{- end }}
{{- include "walk" (list (printf "%s[%s]" $p $seg) $x) }}
{{- end }}
{{- else }}
# L {{ $p }} {{ toJson $v }}
{{- end }}
{{- end }}
{{- range $raw := regexSplit "(?m)^---$" .Values.doc -1 }}
{{- $d := fromYaml $raw }}
{{- if hasKey $d "Error" }}
# L ERROR
{{- else if hasKey $d "kind" }}
{{- include "walk" (list (printf "%s/%s" $d.kind (dig "metadata" "name" "" $d)) $d) }}
{{- end }}
{{- end }}
TEMPLATE
# Another prints a file's content as the same JSON encoder does, to compare
# a ConfigMap's data with the file it came from.
printf 'apiVersion: v2\nname: json\nversion: 0.0.0\n' >"$tmp/json/Chart.yaml"
printf '# J {{ toJson .Values.f }}\n' >"$tmp/json/templates/j.yaml"

passed=0
failed=0
n=0
next_file() { n=$((n + 1)); f="$tmp/case$n"; }

# render <out> <helm template args...>: stdout to <out>, stderr to <out>.err.
render() { local out="$1"; shift; helm template "$REL" "$CHART_DIR" -n "$NS" "$@" >"$out" 2>"$out.err"; }
# flat <rendered> <listing>
flat() {
  helm template k "$tmp/flat" --set-file "doc=$1" >"$2.raw" 2>"$2.err" || return 1
  sed -n 's/^# L //p' "$2.raw" >"$2"
  [ -s "$2" ] && ! grep -qx 'ERROR' "$2"
}
# render_flat <listing> <helm template args...>: render to <listing>.yaml, then flatten.
render_flat() { local out="$1"; shift; render "$out.yaml" "$@" && flat "$out.yaml" "$out"; }
has_line() { grep -qxF -- "$2" "$1"; }
# value <listing> <path>: the JSON value at exactly <path> (nothing when absent)
value() { awk -v p="$2" 'index($0, p " ") == 1 && length($0) > length(p) + 1 { print substr($0, length(p) + 2) }' "$1"; }
eq() { [ "$(value "$1" "$2")" = "$3" ]; }
# no_path <listing> <path>: nothing at <path> or under it
no_path() { ! awk -v p="$2" 'index($0, p) == 1 && index(" .[#", substr($0, length(p) + 1, 1)) { found = 1 } END { exit !found }' "$1"; }
# names_at <listing> <list path>: the names of a list's named elements, in order, one a line
names_at() {
  awk -v p="$2[" 'index($0, p) == 1 && $0 ~ /\]#index [0-9]+$/ {
      rest = substr($0, length(p) + 1); name = rest; sub(/\]#index [0-9]+$/, "", name)
      if (index(name, "[") || index(name, ".")) next
      i = rest; sub(/^.*\]#index /, "", i); print i " " name }' "$1" | sort -n | cut -d' ' -f2
}
# env_names <listing> <container path>: its variables' names, in order
env_names() { names_at "$1" "$2.env"; }
# kinds <listing>: "<Kind>/<name>" of every document, sorted
kinds() { sed -n 's/^\([A-Za-z]*\/[^ .]*\)\.kind .*/\1/p' "$1" | sort; }
# secret_keys <listing> <container path>: the "<Secret's name>/<key>" its secretKeyRefs read, sorted
secret_keys() {
  awk -v p="$2.env[" 'index($0, p) == 1 && $1 ~ /\.valueFrom\.secretKeyRef\.(name|key)$/ {
      v = $1; sub(/\]\.valueFrom.*$/, "", v)
      if ($1 ~ /\.name$/) n[v] = $2; else k[v] = $2 }
    END { for (v in n) { gsub(/"/, "", n[v]); gsub(/"/, "", k[v]); print n[v] "/" k[v] } }' "$1" | sort
}
# only_at <listing> <canary> <allowed path regex>: present, and only at such paths
only_at() {
  awk -v c="$2" 'index($0, c) { print }' "$1" >"$1.$2" || return 1
  [ -s "$1.$2" ] || return 1
  RE="$3" awk '{ split($0, a, " "); if (a[1] !~ ENVIRON["RE"]) bad = 1 } END { exit bad }' "$1.$2"
}

run_case() { # <name> <command...>
  local name="$1"; shift
  if "$@"; then
    echo "PASS - $name"; passed=$((passed + 1))
  else
    echo "FAIL - $name"; failed=$((failed + 1))
  fi
}

# The profiles, rendered and flattened once: $tmp/p/<name> (the listing) and
# $tmp/p/<name>.yaml (the manifests). PROFILES holds their names.
PROFILES=""
for profile in "$PROFILES_DIR"/*.yaml; do
  [ -f "$profile" ] || continue
  name="$(basename "$profile" .yaml)"
  PROFILES="$PROFILES $name"
  if render_flat "$tmp/p/$name" -f "$profile"; then : >"$tmp/p/$name.ok"; fi
done
# listing <profile>: its listing's path
listing() { printf '%s\n' "$tmp/p/$1"; }
profile_ok() { [ -e "$tmp/p/$1.ok" ]; }
# each_profile <name> <command...>: the command with every profile's listing
# appended, one PASS/FAIL line a profile ("[<profile>] <name>"). A profile
# that didn't render fails. Its variables have names no case uses, so a case
# function that assigns a variable without `local` can't change them (bash
# scopes dynamically).
each_profile() {
  local __ep_name="$1" __ep_profile; shift
  for __ep_profile in $PROFILES; do
    if profile_ok "$__ep_profile" && "$@" "$tmp/p/$__ep_profile"; then
      echo "PASS - [$__ep_profile] $__ep_name"; passed=$((passed + 1))
    else
      echo "FAIL - [$__ep_profile] $__ep_name"; failed=$((failed + 1))
    fi
  done
}
L="$(listing default)"
D=(-f "$PROFILES_DIR/default.yaml")

# refused <message> <a value that must not appear, or ""> <helm args...>: the
# render fails with exactly one error, the template guard's <message> (from
# any of the chart's templates, the vendored chart's included).
refused() {
  local msg="$1" canary="$2"; shift 2
  next_file
  if render "$f" "$@"; then return 1; fi
  [ "$(grep -c '^Error:' "$f.err")" = 1 ] || return 1
  sed -n 's/^Error: execution error at (telflo\/\(charts\/opamp-server\/\)\{0,1\}templates\/[A-Za-z_.-]*:[0-9]*:[0-9]*): //p' "$f.err" >"$f.msg"
  grep -qxF -- "$msg" "$f.msg" || return 1
  [ -z "$canary" ] || ! grep -qF -- "$canary" "$f" "$f.err"
}
# schema_refused <JSON pointer> <reason fragment> <helm args...>: refused by
# a values.schema.json at <pointer>. Its error may quote the value, so callers
# pass canary values only, and nothing of it is printed.
schema_refused() {
  local pointer="$1" reason="$2"; shift 2
  next_file
  if render "$f" "$@"; then return 1; fi
  grep -qF "values don't meet the specifications of the schema" "$f.err" || return 1
  grep -F -- "- at '$pointer': " "$f.err" | grep -qF -- "$reason"
}
renders() { next_file; render "$f" "$@"; }

# ---------------------------------------------------------------------------
echo "# the chart"

profiles_found() { [ -n "$PROFILES" ] && for p in default local-file-store s3-file-store no-network-policy full oss-defaults saas; do
  [ -f "$PROFILES_DIR/$p.yaml" ] || return 1; done; }
run_case "the seven profiles exist (default, local-file-store, s3-file-store, no-network-policy, full, oss-defaults, saas)" profiles_found
renders_ok() { [ -s "$1" ]; }
each_profile "renders" renders_ok
lint_ok() { # <listing>: helm lint --strict with that profile, no warning
  local p; p="$(basename "$1")"
  helm lint --strict "$CHART_DIR" -n "$NS" -f "$PROFILES_DIR/$p.yaml" >"$1.lint" 2>&1 &&
    ! grep -qE '^\[(WARNING|ERROR)\]' "$1.lint"
}
each_profile "helm lint --strict passes with no warning" lint_ok
chart_yaml() {
  local c="$CHART_DIR/Chart.yaml"
  grep -qx 'name: telflo' "$c" && telflo_version_ok "$CHART_VERSION" && [ "$CHART_APP_VERSION" = "$CHART_VERSION" ] &&
    grep -q '^kubeVersion: ' "$c" && grep -qx 'dependencies:' "$c" && grep -qx '  - name: opamp-server' "$c" &&
    [ -n "$PIN_VERSION" ] && grep -qxF "    version: $PIN_VERSION" "$c" && grep -qx '    repository: oci://ghcr.io/telflo/charts' "$c"
}
run_case "Chart.yaml: name, version a release version (x.y.z) and appVersion the same, kubeVersion, the opamp-server dependency at the PIN's version at oci://ghcr.io/telflo/charts" chart_yaml
# platform_images <listing>: "<container path> <image>" of every container
# (init containers included) whose image is in the default registry, sorted.
platform_images() {
  awk '$1 ~ /\.(initContainers|containers)\[[^]]*\]\.image$/ && index($2, "\"ghcr.io/telflo/telflo/") == 1 { print $1, $2 }' "$1" | LC_ALL=C sort
}
# A patch release: a scratch copy of the chart with Chart.yaml's version and
# appVersion one patch on (x.y.z -> x.y.z+1) renders every platform image (the
# API's migrate init container's included) at that tag: exactly these six
# containers in the default registry, so none left at the committed one.
next_patch_tags() {
  local copy="$tmp/next-patch" next p want got
  telflo_version_ok "$CHART_VERSION" || return 1
  next="${CHART_VERSION%.*}.$((${CHART_VERSION##*.} + 1))"
  telflo_version_ok "$next" || return 1
  cp -R "$CHART_DIR" "$copy" || return 1
  sed -e "s/^version: .*/version: $next/" -e "s/^appVersion: .*/appVersion: \"$next\"/" "$CHART_DIR/Chart.yaml" >"$copy/Chart.yaml" || return 1
  [ "$(telflo_chart_field "$copy/Chart.yaml" version)" = "$next" ] && [ "$(telflo_chart_field "$copy/Chart.yaml" appVersion)" = "$next" ] || return 1
  helm template "$REL" "$copy" -n "$NS" "${D[@]}" >"$copy.yaml" 2>"$copy.err" && flat "$copy.yaml" "$copy.l" || return 1
  want=""
  for p in "Deployment/telflo-api.spec.template.spec.containers[api]" "Deployment/telflo-api.spec.template.spec.initContainers[migrate]" \
    "Deployment/telflo-web.spec.template.spec.containers[web]" \
    "Deployment/otelcol-validator.spec.template.spec.containers[otelcol-validator]" \
    "Deployment/otelcol-testing.spec.template.spec.containers[otelcol-testing]" \
    "Deployment/ottl-evaluator.spec.template.spec.containers[ottl-evaluator]"; do
    want="$want$p.image \"ghcr.io/telflo/telflo/$(printf '%s' "$p" | sed 's/^.*\[\(.*\)\]$/\1/; s/^migrate$/api/'):$next\"
"
  done
  got="$(platform_images "$copy.l")"
  [ "$got" = "$(printf '%s' "$want" | LC_ALL=C sort)" ]
}
run_case "a scratch copy at the next patch version (Chart.yaml only) renders every platform image (api and its migrate, web, otelcol-validator, otelcol-testing, ottl-evaluator) at that tag, none at the committed one" next_patch_tags
no_lock() { [ ! -e "$CHART_DIR/Chart.lock" ] && [ ! -e "$CHART_DIR/requirements.lock" ] && [ -z "$(find "$CHART_DIR/charts" -maxdepth 1 -name '*.tgz')" ]; }
run_case "no Chart.lock and no packaged dependency: the vendored chart is unpacked" no_lock
helmignore() { grep -qx 'tests/' "$CHART_DIR/.helmignore" && grep -qx 'charts/opamp-server/tests/' "$CHART_DIR/.helmignore"; }
run_case ".helmignore leaves both charts' tests/ out of the package" helmignore
schema_closed() { # every object in values.schema.json with properties closes them
  python3 -I -c '
import json, sys
def walk(node, path):
    if isinstance(node, dict):
        if "properties" in node and node.get("additionalProperties") is not False:
            sys.exit(path or "/")
        for k, v in node.items():
            walk(v, path + "/" + k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, path + "/" + str(i))
walk(json.load(open(sys.argv[1])), "")' "$CHART_DIR/values.schema.json" >/dev/null 2>&1
}
run_case "values.schema.json: additionalProperties false wherever properties are listed" schema_closed
schema_unknown_root() { schema_refused "" "additional properties 'cnryKey' not allowed" "${D[@]}" --set cnryKey=1; }
run_case "an unknown key at the root refused by the schema" schema_unknown_root
schema_unknown_nested() {
  schema_refused /api "additional properties 'cnryKey' not allowed" "${D[@]}" --set api.cnryKey=1 &&
    schema_refused /api/fileStore "additional properties 'cnryKey' not allowed" "${D[@]}" --set api.fileStore.cnryKey=1 &&
    schema_refused /gateway/service "additional properties 'cnryKey' not allowed" "${D[@]}" --set gateway.service.cnryKey=1 &&
    schema_refused /postgres/image "additional properties 'cnryKey' not allowed" "${D[@]}" --set postgres.image.cnryKey=1 &&
    schema_refused /existingSecrets "additional properties 'cnryKey' not allowed" "${D[@]}" --set existingSecrets.cnryKey=x &&
    schema_refused /global "additional properties 'cnryKey' not allowed" "${D[@]}" --set global.cnryKey=1
}
run_case "unknown keys refused at every level (api, api.fileStore, gateway.service, postgres.image, existingSecrets, global)" schema_unknown_nested

# ---------------------------------------------------------------------------
echo "# nothing that could carry a credential"

no_kind() { ! kinds "$2" | grep -q "^$1/"; }
each_profile "no Secret rendered" no_kind Secret
each_profile "no Job rendered (migrations run in an init container, never a hook)" no_kind Job
each_profile "no CronJob rendered" no_kind CronJob
each_profile "no Ingress rendered (the gateway's Service is the way in)" no_kind Ingress
no_hook() { ! grep -q 'helm\.sh/hook' "$1.yaml"; }
each_profile "no Helm hook rendered" no_hook
no_kind_secret_text() { ! grep -rqE '^kind: *Secret' "$CHART_DIR/templates" "$SUBCHART_DIR/templates"; }
run_case "no template (the vendored chart's included) holds kind: Secret" no_kind_secret_text
# No container sets log_statement, in its command, args or environment: the
# bootstraps' password statements would be logged. (The bootstrap files'
# comments name it.)
no_log_statement() { ! grep -E '\.(initContainers|containers)\[[^]]*\]\.(command|args|env)' "$1" | grep -qiE 'log_statement|PGOPTIONS'; }
each_profile "no container sets log_statement (a password statement would be logged)" no_log_statement
no_aws_env() { ! grep -qE '^ *- name: "?AWS_' "$1.yaml"; }
each_profile "no AWS_* variable set (the S3 client reads the cloud's identity itself)" no_aws_env
no_cookie_secure() { ! grep -q 'TELFLO_COOKIE_SECURE' "$1.yaml"; }
each_profile "TELFLO_COOKIE_SECURE never set (cookies always Secure)" no_cookie_secure
no_token_mounted() { # every pod spec says automountServiceAccountToken: false
  local pods p
  pods="$(awk '$1 ~ /^(Deployment|StatefulSet)\/[^ ]*\.spec\.template\.spec\.containers\[[^]]*\]#index$/ { sub(/\.containers\[.*$/, "", $1); print $1 }' "$1" | sort -u)"
  [ -n "$pods" ] || return 1
  for p in $pods; do eq "$1" "$p.automountServiceAccountToken" false || return 1; done
}
each_profile "no pod mounts a service-account token (the vendored chart's included)" no_token_mounted

# Every value the chart takes as a Secret's name set to a canary (the full
# profile's names): each appears only where a Secret's name belongs (a
# secretKeyRef's name, a volume's secretName, a projected secret's name, an
# imagePullSecrets entry), never in a variable's value, a URL or a command.
canary_names() {
  local listing c; listing="$(listing full)"
  profile_ok full || return 1
  local allowed='(\.valueFrom\.secretKeyRef\.name|\.secret\.secretName|\.secret\.name|\.imagePullSecrets\[[^]]*\](\.name|#index))$'
  only_at "$listing" example-postgres "$allowed" && only_at "$listing" example-opamp "$allowed" &&
    only_at "$listing" registry-pull "$allowed" &&
    for c in example-api example-internal example-oidc example-mail; do not_elsewhere "$listing" "$c" "$allowed" || return 1; done
}
# not_elsewhere <listing> <canary> <allowed path regex>: wherever it is, only
# at such paths (the Secrets that only some templates read).
not_elsewhere() { ! awk -v c="$2" 'index($0, c) { print $1 }' "$1" | RE="$3" awk '$1 !~ ENVIRON["RE"] { bad = 1 } END { exit !bad }'; }
run_case "Secret names (the full profile's) appear only where a Secret's name belongs" canary_names
# (The full profile's names only: the default Secret names telflo-api and
# telflo-postgres are also Services' names, which a variable may hold.)
no_value_names_secret() { ! awk '$1 ~ /\.env\[[^]]*\]\.value$/' "$1" | grep -qE 'example-(postgres|opamp|api|internal|oidc|mail)|registry-pull|ghcr-pull'; }
each_profile "no variable's value holds a Secret's name" no_value_names_secret

# ---------------------------------------------------------------------------
echo "# the vendored opamp-server chart and its wiring"

OPAMP=telflo-opamp-server
# Since 0.2.4 the opamp-server runs as two Deployments, <fullname>-agent
# (`serve agent`) and <fullname>-management (`serve management`), each with
# its own migrate init container: every check on its pods runs on both.
OPAMP_PODS="Deployment/$OPAMP-agent.spec.template.spec Deployment/$OPAMP-management.spec.template.spec"
subchart_version() { [ -n "$PIN_VERSION" ] && grep -qxF "version: $PIN_VERSION" "$SUBCHART_DIR/Chart.yaml" && grep -qx 'name: opamp-server' "$SUBCHART_DIR/Chart.yaml"; }
run_case "the vendored chart is opamp-server at the PIN's version" subchart_version
opamp_kinds() {
  local k; k="$(kinds "$1")"
  for want in "ConfigMap/$OPAMP-bootstrap" "Deployment/$OPAMP-agent" "Deployment/$OPAMP-management" "Service/$OPAMP-agent" "Service/$OPAMP-management" "ServiceAccount/$OPAMP"; do
    printf '%s\n' "$k" | grep -qx "$want" || return 1
  done
  [ "$(printf '%s\n' "$k" | grep -c "^Deployment/$OPAMP")" = 2 ] &&
    ! printf '%s\n' "$k" | grep -q "^StatefulSet/$OPAMP-postgres$" && ! printf '%s\n' "$k" | grep -q "^Service/$OPAMP-postgres$"
}
each_profile "the opamp-server's objects as telflo-opamp-server (the -agent and -management Deployments), its bootstrap ConfigMap, and no Postgres of its own" opamp_kinds
opamp_digest() {
  local pod
  [ -n "$PIN_VERSION" ] && [ -n "$PIN_DIGEST" ] || return 1
  for pod in $OPAMP_PODS; do
    eq "$1" "$pod.containers[serve].image" "\"ghcr.io/telflo/opamp-server:$PIN_VERSION@$PIN_DIGEST\"" &&
      eq "$1" "$pod.initContainers[migrate].image" "\"ghcr.io/telflo/opamp-server:$PIN_VERSION@$PIN_DIGEST\"" || return 1
  done
}
each_profile "the opamp-server's image (both Deployments, serve and migrate) is pinned by vendor/opamp-server/PIN's version and digest" opamp_digest
opamp_db() {
  local pod
  for pod in $OPAMP_PODS; do
    eq "$1" "$pod.containers[serve].env[OPAMP_DATABASE_URL].value" '"postgresql://telflo_opamp_server:$(OPAMP_RUNTIME_PASSWORD)@telflo-postgres:5432/telflo_opamp_server?sslmode=disable"' &&
      eq "$1" "$pod.initContainers[migrate].env[OPAMP_MIGRATION_DATABASE_URL].value" '"postgresql://telflo_opamp_server_owner:$(OPAMP_OWNER_PASSWORD)@telflo-postgres:5432/telflo_opamp_server?sslmode=disable"' || return 1
  done
}
each_profile "the opamp-server (both Deployments) reaches telflo-postgres's telflo_opamp_server (sslmode disable)" opamp_db
# The cold start: telflo-postgres and the opamp-server start together, and
# migrate gives up after two minutes without a database, so (since
# opamp-server 0.3.2) each pod first runs wait-for-postgres: pg_isready
# against telflo-postgres until it answers, on the platform's own Postgres
# image (the one the StatefulSet runs, a mirror's in the full profile), with
# no credential, as the image's user 999 with a read-only root.
opamp_wait() {
  local pod w pg_image
  pg_image="$(value "$1" "StatefulSet/telflo-postgres.spec.template.spec.containers[postgres].image")"
  [ -n "$pg_image" ] || return 1
  for pod in $OPAMP_PODS; do
    w="$pod.initContainers[wait-for-postgres]"
    [ "$(names_at "$1" "$pod.initContainers" | tr '\n' ' ')" = "wait-for-postgres migrate " ] &&
      eq "$1" "$w.image" "$pg_image" && eq "$1" "$w.imagePullPolicy" '"IfNotPresent"' &&
      eq "$1" "$w.command[0]" '"sh"' && eq "$1" "$w.command[1]" '"-c"' &&
      eq "$1" "$w.command[2]" '"until pg_isready; do sleep 2; done"' && no_path "$1" "$w.command[3]" && no_path "$1" "$w.args" &&
      [ "$(env_names "$1" "$w" | tr '\n' ' ')" = "PGHOST PGPORT PGUSER PGDATABASE " ] &&
      eq "$1" "$w.env[PGHOST].value" '"telflo-postgres"' && eq "$1" "$w.env[PGPORT].value" '"5432"' &&
      eq "$1" "$w.env[PGUSER].value" '"telflo_opamp_server_owner"' && eq "$1" "$w.env[PGDATABASE].value" '"telflo_opamp_server"' &&
      [ -z "$(secret_keys "$1" "$w")" ] && no_path "$1" "$w.envFrom" && no_path "$1" "$w.volumeMounts" &&
      eq "$1" "$w.securityContext.runAsUser" 999 && eq "$1" "$w.securityContext.runAsNonRoot" true &&
      eq "$1" "$w.securityContext.readOnlyRootFilesystem" true && eq "$1" "$w.securityContext.allowPrivilegeEscalation" false || return 1
  done
}
each_profile "the opamp-server's pods (both Deployments) wait for telflo-postgres (wait-for-postgres: pg_isready, the platform's Postgres image, no credential) before migrate" opamp_wait
opamp_services() { eq "$1" "Service/$OPAMP-agent.spec.type" '"LoadBalancer"' && eq "$1" "Service/$OPAMP-management.spec.type" '"ClusterIP"'; }
each_profile "the agent Service is a LoadBalancer; the management Service ClusterIP" opamp_services
opamp_pull() {
  local want got pod
  want="$(names_at "$1" "StatefulSet/telflo-postgres.spec.template.spec.imagePullSecrets")"
  for pod in $OPAMP_PODS; do
    got="$(names_at "$1" "$pod.imagePullSecrets")"
    [ "$want" = "$got" ] || return 1
  done
}
each_profile "the opamp-server's pods (both Deployments) take the platform's pull secrets" opamp_pull
management_from() {
  local np="NetworkPolicy/$OPAMP-management.spec.ingress"
  eq "$L" "$np[0].from[0].podSelector.matchLabels.app.kubernetes.io/name" '"telflo"' &&
    eq "$L" "$np[0].from[0].podSelector.matchLabels.app.kubernetes.io/component" '"api"' &&
    no_path "$L" "$np[0].from[1]" && no_path "$L" "$np[1]" &&
    eq "$L" "$np[0].ports[0].port" 51235 && no_path "$L" "$np[0].ports[1]"
}
run_case "the management port admits only pods labeled app.kubernetes.io/name telflo, component api" management_from
agent_open() {
  local np="NetworkPolicy/$OPAMP-agent.spec.ingress"
  no_path "$L" "$np[0].from" && eq "$L" "$np[0].ports[0].port" 51234 && no_path "$L" "$np[0].ports[1]" && no_path "$L" "$np[1]"
}
run_case "the agent port is open to every peer (collectors poll it), and only it" agent_open
no_opamp_policy() { ! kinds "$(listing no-network-policy)" | grep -q '^NetworkPolicy/'; }
run_case "no-network-policy: no NetworkPolicy from either chart" no_opamp_policy

# ---------------------------------------------------------------------------
echo "# pull secrets"

# pod_specs <listing>: every pod template's spec path, sorted.
pod_specs() {
  awk '$1 ~ /^(Deployment|StatefulSet|DaemonSet)\/[^ ]*\.spec\.template\.spec\.containers\[[^]]*\]#index$/ {
      sub(/\.containers\[.*$/, "", $1); print $1 }' "$1" | sort -u
}
# pulls_on_every_pod <want> <listing>: every pod's imagePullSecrets names are
# <want> (space-separated, a space after each; "" for none), the
# opamp-server's two Deployments among the pods; for none, no
# imagePullSecrets at all in the rendered manifests (not even an empty one).
pulls_on_every_pod() {
  local want="$1" pods p
  pods="$(pod_specs "$2")"
  for p in $OPAMP_PODS; do printf '%s\n' "$pods" | grep -qxF -- "$p" || return 1; done
  [ "$(printf '%s\n' "$pods" | grep -c .)" -ge 9 ] || return 1
  for p in $pods; do
    [ "$(names_at "$2" "$p.imagePullSecrets" | tr '\n' ' ')" = "$want" ] || return 1
  done
  [ -n "$want" ] || ! grep -q 'imagePullSecrets' "$2.yaml"
}
# Only the full profile sets the two lists (registry-pull, registry-pull-mirror).
profile_pulls() {
  case "$(basename "$1")" in
    full) pulls_on_every_pod "registry-pull registry-pull-mirror " "$1" ;;
    *) pulls_on_every_pod "" "$1" ;;
  esac
}
each_profile "pull secrets: none on any pod by default (no imagePullSecrets rendered); the full profile's list on every pod, the opamp-server's included" profile_pulls
printf 'global:\n  imagePullSecrets:\n    - name: ghcr-pull\nopamp-server:\n  imagePullSecrets:\n    - name: ghcr-pull\n' >"$tmp/pull-set.yaml"
pull_set() { next_file; render_flat "$f" "${D[@]}" -f "$tmp/pull-set.yaml" && pulls_on_every_pod "ghcr-pull " "$f"; }
run_case "pull secrets set as the chart's README says (both lists [ghcr-pull]): ghcr-pull on every pod, both opamp-server Deployments included" pull_set

# ---------------------------------------------------------------------------
# The cases, in name order.
for case_file in "$CASES_DIR"/*.sh; do
  [ -f "$case_file" ] || continue
  echo "# cases: $(basename "$case_file")"
  # shellcheck source=/dev/null
  . "$case_file"
done

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
