#!/usr/bin/env bash
# Render tests for charts/supervisor-collector (the platform's chart; the
# first section holds the 8 render tests of the chart it replaces,
# telflo-supervisor-collector 0.3.5).
#
# `helm lint` can't catch these: it lints with whatever values it is given and
# Helm 4's lint only LOGS a guard's `fail`. Every guard, name, checksum and
# quoted key is therefore pinned by a real `helm template` here.
#
# Run:  bash charts/supervisor-collector/tests/render-tests.sh
#
# Offline and credential-free: only `helm template` and `helm lint` (no
# registry, no cluster, no --debug). Every HELM_* variable is unset; Helm's
# homes, HOME and DOCKER_CONFIG are empty directories in a temporary directory
# removed on exit. Each case prints PASS or FAIL and its name, never a value or
# Helm's output (an error's text can hold a value); a failing render is that
# case's FAIL and the script goes on. Exit 1 when any case failed.
# bash 3.2 compatible (macOS's /bin/bash).
set -u

CHART_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v helm >/dev/null 2>&1; then
  echo "render tests: helm is not on PATH" >&2
  exit 2
fi

for v in $(env | sed -n 's/^\(HELM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
tmp="$(mktemp -d "${TMPDIR:-/tmp}/supervisor-collector-render.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "render tests: no temporary directory" >&2; exit 2; fi
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/docker" "$tmp/helm/cache" "$tmp/helm/config" "$tmp/helm/data" "$tmp/kube" || exit 2
export HOME="$tmp/home" DOCKER_CONFIG="$tmp/docker" KUBECONFIG="$tmp/kube/config"
export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"

NS=telflo-collectors
TOKEN=smoketoken-c4n4ry
ENDPOINT=https://smoke.invalid/opamp/api/v1
GID=6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b
NODE_O=3f9a1c2e-default       # the platform's fullnameOverride for fleet 3f9a1c2e-…'s Agent
CLUSTER_O=3f9a1c2e-cluster    # … and its Cluster
NODE_O2=7b20d4aa-default      # a second fleet's
CLUSTER_O2=7b20d4aa-cluster
GATEWAY=gw-edge
ERR_AT='Error: execution error at (supervisor-collector/templates/secret.yaml:1:4): '

# The base values per role, as files: every --set/--set-string a case adds
# overrides them (Helm merges -f files first, whatever the flags' order).
base_values() { # <role> <group>
  printf 'role: %s\ngroup: %s\ntoken: %s\nendpoint: %s\ncollectorGroupId: %s\n' \
    "$1" "$2" "$TOKEN" "$ENDPOINT" "$GID"
}
base_values node node >"$tmp/node.yaml"
base_values cluster cluster >"$tmp/cluster.yaml"
base_values gateway "$GATEWAY" >"$tmp/gateway.yaml"

# A throwaway chart whose template parses a rendered manifest stream with
# Helm's own fromYaml (sigs.k8s.io/yaml over a YAML 1.1 parser: what Helm reads
# a release's manifests with) and lists, one line each, the fields that carry a
# name: "<kind> <field> <kindOf value> <value>"; a Secret's stringData keys as
# "Secret stringData.key <kindOf key> <Go-quoted key> <secret's name>"; a
# document that fails to parse as "ERROR" (never its error's text). Structure
# lines start with "R": a ClusterRole's rules ("R ClusterRole rule <apiGroups>
# <resources> <verbs>", JSON), a pod's mounts ("R <kind> mount <container>
# <name> <mountPath> <readOnly or ->"), volumes ("R <kind> volume <name>
# hostPath <path> <type>") and claim templates ("R <kind> claim <name>"); a
# mount's mountPath and a hostPath volume's path are also listed as fields
# ("<kind> mountPath …", "<kind> hostPath …"), so their kind is checked. Of
# the env, only the identity variables' values are listed (COLLECTOR_GROUP_ID,
# OPAMP_ENDPOINT, OPAMP_ALLOW_INSECURE_CONNECTIONS, OPAMP_SERVER_NAME), every
# fieldRef's path and every secretKeyRef's name and key: never a Secret's
# value. Each line is a YAML comment ("# L …") so the throwaway render itself
# stays valid YAML. The listing goes to a file, never to the output.
mkdir -p "$tmp/yaml11/templates" || exit 2
printf 'apiVersion: v2\nname: yaml11\nversion: 0.0.0\n' >"$tmp/yaml11/Chart.yaml"
cat >"$tmp/yaml11/templates/list.yaml" <<'TEMPLATE'
{{- define "f" }}
# L {{ index . 0 }} {{ index . 1 }} {{ kindOf (index . 2) }} {{ index . 2 }}
{{- end }}
{{- range $raw := regexSplit "(?m)^---$" .Values.doc -1 }}
{{- $d := fromYaml $raw }}
{{- if hasKey $d "Error" }}
# L ERROR
{{- else if hasKey $d "kind" }}
{{- $k := toString $d.kind }}
{{- include "f" (list $k "metadata.name" (dig "metadata" "name" "" $d)) }}
{{- $spec := dig "spec" (dict) $d }}
{{- if hasKey $spec "serviceName" }}{{ include "f" (list $k "serviceName" $spec.serviceName) }}{{ end }}
{{- if eq $k "Service" }}{{ include "f" (list $k "selector.app" (dig "selector" "app" "" $spec)) }}{{ end }}
{{- if has $k (list "DaemonSet" "StatefulSet") }}
{{- include "f" (list $k "selector.app" (dig "selector" "matchLabels" "app" "" $spec)) }}
{{- include "f" (list $k "labels.app" (dig "template" "metadata" "labels" "app" "" $spec)) }}
{{- range $ak, $av := (dig "template" "metadata" "annotations" (dict) $spec) }}{{ include "f" (list $k (printf "annotation.%s" $ak) $av) }}{{ end }}
{{- $pod := dig "template" "spec" (dict) $spec }}
{{- include "f" (list $k "serviceAccountName" (dig "serviceAccountName" "" $pod)) }}
{{- range $c := (dig "containers" (list) $pod) }}
{{- include "f" (list $k "image" (dig "image" "" $c)) }}
{{- range $e := (dig "env" (list) $c) }}
{{- $en := toString $e.name }}
{{- if and (hasKey $e "value") (has $en (list "COLLECTOR_GROUP_ID" "OPAMP_ENDPOINT" "OPAMP_ALLOW_INSECURE_CONNECTIONS" "OPAMP_SERVER_NAME")) }}{{ include "f" (list $k (printf "env.%s.value" $en) $e.value) }}{{ end }}
{{- $fr := dig "valueFrom" "fieldRef" (dict) $e }}
{{- if $fr }}{{ include "f" (list $k (printf "env.%s.fieldRef" $en) (dig "fieldPath" "" $fr)) }}{{ end }}
{{- $ref := dig "valueFrom" "secretKeyRef" (dict) $e }}
{{- if $ref }}{{ include "f" (list $k (printf "env.%s.secretKeyRef" $en) (dig "name" "" $ref)) }}{{ include "f" (list $k (printf "env.%s.secretKeyRef.key" $en) (dig "key" "" $ref)) }}{{ end }}
{{- end }}
{{- range $ef := (dig "envFrom" (list) $c) }}{{ include "f" (list $k "envFrom.secretRef" (dig "secretRef" "name" "" $ef)) }}{{ end }}
{{- end }}
{{- range $vol := (dig "volumes" (list) $pod) }}{{ if hasKey $vol "hostPath" }}{{ include "f" (list $k "hostPath" (dig "hostPath" "path" "" $vol)) }}{{ end }}{{ end }}
{{- range $c := concat (dig "initContainers" (list) $pod) (dig "containers" (list) $pod) }}
{{- range $m := (dig "volumeMounts" (list) $c) }}
# L R {{ $k }} mount {{ $c.name }} {{ $m.name }} {{ $m.mountPath }} {{ toString (dig "readOnly" "-" $m) }}
{{- include "f" (list $k "mountPath" $m.mountPath) }}
{{- end }}
{{- end }}
{{- range $vol := (dig "volumes" (list) $pod) }}
# L R {{ $k }} volume {{ $vol.name }} {{ if hasKey $vol "hostPath" }}hostPath {{ dig "hostPath" "path" "" $vol }} {{ dig "hostPath" "type" "-" $vol }}{{ else }}other{{ end }}
{{- end }}
{{- range $vc := (dig "volumeClaimTemplates" (list) $spec) }}
# L R {{ $k }} claim {{ dig "metadata" "name" "" $vc }}
{{- end }}
{{- end }}
{{- if eq $k "ClusterRole" }}
{{- range $r := (dig "rules" (list) $d) }}
# L R ClusterRole rule {{ toJson (dig "apiGroups" (list) $r) }} {{ toJson (dig "resources" (list) $r) }} {{ toJson (dig "verbs" (list) $r) }}
{{- end }}
{{- end }}
{{- if eq $k "ClusterRoleBinding" }}
{{- include "f" (list $k "roleRef.name" (dig "roleRef" "name" "" $d)) }}
{{- range $s := (dig "subjects" (list) $d) }}{{ include "f" (list $k "subject.name" (dig "name" "" $s)) }}{{ include "f" (list $k "subject.namespace" (dig "namespace" "" $s)) }}{{ end }}
{{- end }}
{{- if eq $k "Secret" }}
{{- range $key, $_ := (dig "stringData" (dict) $d) }}
# L Secret stringData.key {{ kindOf $key }} {{ printf "%q" $key }} {{ dig "metadata" "name" "" $d }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
TEMPLATE

passed=0
failed=0
n=0
next_file() { n=$((n + 1)); f="$tmp/case$n"; }

# render <out> <helm template args...>: stdout to <out>, stderr to <out>.err.
render() { local out="$1"; shift; helm template smoke "$CHART_DIR" -n "$NS" "$@" >"$out" 2>"$out.err"; }
render_as() { local release="$1" out="$2"; shift 2; helm template "$release" "$CHART_DIR" -n "$NS" "$@" >"$out" 2>"$out.err"; }
# parse <rendered> <listing>: the YAML 1.1 listing of a rendered stream.
parse() {
  helm template k "$tmp/yaml11" --set-file "doc=$1" >"$2.raw" 2>"$2.err" || return 1
  sed -n 's/^# L //p' "$2.raw" >"$2"
}
# render_list <listing> <helm template args...>: render, then parse.
render_list() { local out="$1"; shift; render "$out.yaml" "$@" && parse "$out.yaml" "$out"; }
has_line() { grep -qxF -- "$2" "$1"; }
# every field listed parsed as a string, and no document failed to parse
all_strings() { [ -s "$1" ] && ! grep -q '^ERROR$' "$1" && [ -z "$(awk '$1 != "R" && $3 != "string"' "$1")" ]; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
# the one checksum/token annotation of a render (fails when not exactly one)
token_checksum() {
  local lines
  lines="$(sed -n 's/^ *checksum\/token: //p' "$1")"
  [ -n "$lines" ] && [ "$(printf '%s\n' "$lines" | wc -l | tr -d ' ')" = 1 ] || return 1
  printf '%s\n' "$lines"
}

run_case() { # <name> <command...>
  local name="$1"; shift
  if "$@"; then
    echo "PASS - $name"; passed=$((passed + 1))
  else
    echo "FAIL - $name"; failed=$((failed + 1))
  fi
}

# ---------------------------------------------------------------------------
echo "# 0.3.5's eight (collectorGroupId now in the base values)"

# mount_read_only <mountPath> <expected readOnly> <helm args...>
mount_read_only() {
  local mount_path="$1" expected="$2"; shift 2
  next_file
  render "$f" -f "$tmp/node.yaml" "$@" || return 1
  [ "$(grep -A2 "mountPath: \"${mount_path}\"" "$f" | awk '/readOnly:/ { print $2; exit }')" = "$expected" ]
}
run_case "explicit readOnly=false stays writable" mount_read_only /var/lib/otelcol/storage false \
  --set 'volumes[0].hostPath=/var/lib/telflo-collector/storage' \
  --set 'volumes[0].mountPath=/var/lib/otelcol/storage' \
  --set 'volumes[0].readOnly=false'
run_case "explicit readOnly=true stays read-only" mount_read_only /var/log/starfeuds true \
  --set 'volumes[0].hostPath=/var/log/starfeuds' \
  --set 'volumes[0].mountPath=/var/log/starfeuds' \
  --set 'volumes[0].readOnly=true'
run_case "omitted readOnly defaults to read-only" mount_read_only /var/log/starfeuds true \
  --set 'volumes[0].hostPath=/var/log/starfeuds' \
  --set 'volumes[0].mountPath=/var/log/starfeuds'

env_secret_rendered() {
  next_file
  render "$f" -f "$tmp/node.yaml" --set-string collectorEnv.CLICKHOUSE_PASSWORD=secretpass || return 1
  grep -qxF '  "CLICKHOUSE_PASSWORD": "secretpass"' "$f"
}
run_case "collectorEnv renders the Secret (its key quoted)" env_secret_rendered

env_from() { # <expected Secret name> <helm args...>
  local expected="$1"; shift
  next_file
  render_list "$f" -f "$tmp/node.yaml" --set-string collectorEnv.CLICKHOUSE_PASSWORD=secretpass "$@" || return 1
  has_line "$f" "DaemonSet envFrom.secretRef string $expected" &&
    has_line "$f" "Secret metadata.name string $expected"
}
run_case "collectorEnv is delivered via envFrom, under an override" env_from "$NODE_O-collector-env" \
  --set-string "fullnameOverride=$NODE_O"
run_case "collectorEnv is delivered via envFrom, telflo-node-collector-env without one" env_from telflo-node-collector-env

empty_env_renders_nothing() {
  next_file
  render "$f" -f "$tmp/node.yaml" || return 1
  ! grep -q 'collector-env' "$f"
}
run_case "empty collectorEnv renders nothing" empty_env_renders_nothing

token_reaches_secret() {
  next_file
  render "$f" -f "$tmp/node.yaml" || return 1
  grep -qxF "  token: \"$TOKEN\"" "$f"
}
run_case "token reaches the rendered Secret" token_reaches_secret

no_values_refused() {
  next_file
  if helm template smoke "$CHART_DIR" -n "$NS" >"$f" 2>"$f.err"; then return 1; fi
  grep -qxF "${ERR_AT}role must be one of: node, cluster, gateway" "$f.err"
}
run_case "guards fail-fast without values" no_values_refused

# ---------------------------------------------------------------------------
echo "# each guard alone: its own message, no value in the output"

# refused <message> <a value that must not appear, or ""> <helm args...>
refused() {
  local msg="$1" value="$2"; shift 2
  next_file
  if render "$f" "$@"; then return 1; fi
  grep -qxF -- "$ERR_AT$msg" "$f.err" || return 1
  [ "$(grep -c '^Error:' "$f.err")" = 1 ] || return 1
  ! grep -qF -- "$TOKEN" "$f" "$f.err" || return 1
  ! grep -qF -- "$ENDPOINT" "$f" "$f.err" || return 1
  [ -z "$value" ] || ! grep -qF -- "$value" "$f" "$f.err"
}
renders() { next_file; render "$f" "$@"; }

M_ROLE='role must be one of: node, cluster, gateway'
M_GROUP='gateway role requires a group name'
M_GROUP_STRING='group must be a string'
M_GATEWAY_NAME='group must be a DNS-1035 label of at most 52 characters for a gateway'
M_RESERVED='group must not be node, cluster, telflo-node or telflo-cluster for a gateway'
M_OVERRIDE='fullnameOverride must be a DNS-1123 label of at most 52 characters'
M_GID="collectorGroupId must be a collector group's id (a UUID)"
M_BOOT='endpoint and token are required'
G52="g$(printf '%051d' 0 | tr 0 a)"   # 52 characters, a valid label
O52="$(printf '%052d' 0 | tr 0 b)"

run_case "role empty refused" refused "$M_ROLE" "" -f "$tmp/node.yaml" --set-string role=
run_case "role unknown refused" refused "$M_ROLE" edgerolecanary -f "$tmp/node.yaml" --set-string role=edgerolecanary
run_case "a gateway without a group refused" refused "$M_GROUP" "" -f "$tmp/gateway.yaml" --set-string group=
run_case "a gateway's group not a string refused" refused "$M_GROUP_STRING" 4242424 -f "$tmp/gateway.yaml" --set group=4242424
run_case "a gateway name of 53 characters refused" refused "$M_GATEWAY_NAME" "${G52}z" -f "$tmp/gateway.yaml" --set-string "group=${G52}z"
run_case "a gateway name of 52 characters renders" renders -f "$tmp/gateway.yaml" --set-string "group=$G52"
run_case "a gateway name with capitals refused" refused "$M_GATEWAY_NAME" Gw-Canary -f "$tmp/gateway.yaml" --set-string group=Gw-Canary
run_case "a gateway name starting with a digit refused" refused "$M_GATEWAY_NAME" 9gw-canary -f "$tmp/gateway.yaml" --set-string group=9gw-canary
run_case "a gateway name ending with a hyphen refused" refused "$M_GATEWAY_NAME" gw-canary- -f "$tmp/gateway.yaml" --set-string group=gw-canary-
run_case "a gateway name with a dot refused" refused "$M_GATEWAY_NAME" gw.canary -f "$tmp/gateway.yaml" --set-string group=gw.canary
for reserved in node cluster telflo-node telflo-cluster; do
  run_case "a gateway named $reserved refused" refused "$M_RESERVED" "" -f "$tmp/gateway.yaml" --set-string "group=$reserved"
done
run_case "fullnameOverride with capitals refused" refused "$M_OVERRIDE" 3F9A1C2E-Canary -f "$tmp/node.yaml" --set-string fullnameOverride=3F9A1C2E-Canary
run_case "fullnameOverride ending with a hyphen refused" refused "$M_OVERRIDE" 3f9a1c2e-canary- -f "$tmp/node.yaml" --set-string fullnameOverride=3f9a1c2e-canary-
run_case "fullnameOverride with an underscore refused" refused "$M_OVERRIDE" 3f9a1c2e_canary -f "$tmp/cluster.yaml" --set-string fullnameOverride=3f9a1c2e_canary
run_case "fullnameOverride of 53 characters refused" refused "$M_OVERRIDE" "${O52}c" -f "$tmp/node.yaml" --set-string "fullnameOverride=${O52}c"
run_case "fullnameOverride not a string refused" refused "$M_OVERRIDE" 31415926 -f "$tmp/node.yaml" --set fullnameOverride=31415926
run_case "fullnameOverride of 52 characters renders" renders -f "$tmp/node.yaml" --set-string "fullnameOverride=$O52"
run_case "collectorGroupId empty refused" refused "$M_GID" "" -f "$tmp/node.yaml" --set-string collectorGroupId=
run_case "collectorGroupId absent refused" refused "$M_GID" "" -f "$tmp/cluster.yaml" --set collectorGroupId=null
run_case "collectorGroupId not a UUID refused" refused "$M_GID" gid-canary -f "$tmp/gateway.yaml" --set-string collectorGroupId=gid-canary
run_case "collectorGroupId with a character too many refused" refused "$M_GID" "${GID}0" -f "$tmp/node.yaml" --set-string "collectorGroupId=${GID}0"
run_case "collectorGroupId as a list (Helm's {…} --set syntax) refused" refused "$M_GID" "$GID" -f "$tmp/node.yaml" --set-string "collectorGroupId={$GID}"
gid_in_braces() {
  next_file
  printf 'collectorGroupId: "{%s}"\n' "$GID" >"$f.values"
  refused "$M_GID" "{$GID}" -f "$tmp/node.yaml" -f "$f.values"
}
run_case "collectorGroupId the string {uuid} refused" gid_in_braces
run_case "collectorGroupId with a character before it refused (the pattern's ^)" refused "$M_GID" "x$GID" \
  -f "$tmp/node.yaml" --set-string "collectorGroupId=x$GID"
# 36 characters of [0-9a-fA-F-], a hyphen moved: the UUID's shape, not its alphabet
run_case "collectorGroupId of 36 hex characters and hyphens in the wrong shape refused" refused "$M_GID" \
  6f1c2a9e3-b4d-4e5f-8a7b-9c0d1e2f3a4b -f "$tmp/cluster.yaml" --set-string collectorGroupId=6f1c2a9e3-b4d-4e5f-8a7b-9c0d1e2f3a4b
run_case "collectorGroupId not a string refused" refused "$M_GID" 27182818 -f "$tmp/node.yaml" --set collectorGroupId=27182818
run_case "collectorGroupId in capitals renders" renders -f "$tmp/node.yaml" \
  --set-string "collectorGroupId=$(printf '%s' "$GID" | tr 'a-f' 'A-F')"
run_case "endpoint missing refused" refused "$M_BOOT" "" -f "$tmp/node.yaml" --set-string endpoint=
run_case "token missing refused" refused "$M_BOOT" "" -f "$tmp/gateway.yaml" --set-string token=
run_case "a guard stops a render of another template alone" refused "$M_GID" "" -f "$tmp/node.yaml" \
  --set collectorGroupId=null --show-only templates/rbac.yaml

# ---------------------------------------------------------------------------
echo "# names: fullnameOverride for the Agent and the Cluster; a gateway's group"

node_names_follow_override() {
  next_file
  render_list "$f" -f "$tmp/node.yaml" --set-string "fullnameOverride=$NODE_O" \
    --set-string collectorEnv.LEVEL=debug \
    --set-string clickhouse.endpoint=https://clickhouse.invalid:8443 --set-string clickhouse.password=pw || return 1
  local o="$NODE_O" line
  for line in \
    "ServiceAccount metadata.name string $o" \
    "Secret metadata.name string $o-token" \
    "Secret metadata.name string $o-collector-env" \
    "Secret metadata.name string $o-clickhouse" \
    "ClusterRole metadata.name string $o" \
    "ClusterRoleBinding metadata.name string $o" \
    "ClusterRoleBinding roleRef.name string $o" \
    "ClusterRoleBinding subject.name string $o" \
    "ClusterRoleBinding subject.namespace string $NS" \
    "DaemonSet metadata.name string $o" \
    "DaemonSet selector.app string $o" \
    "DaemonSet labels.app string $o" \
    "DaemonSet serviceAccountName string $o" \
    "DaemonSet env.OPAMP_TOKEN.secretKeyRef string $o-token" \
    "DaemonSet env.CLICKHOUSE_PASSWORD.secretKeyRef string $o-clickhouse" \
    "DaemonSet envFrom.secretRef string $o-collector-env" \
    "DaemonSet hostPath string /var/lib/telflo/supervisor/$o" \
    "DaemonSet hostPath string /var/lib/telflo/collector/$o"; do
    has_line "$f" "$line" || return 1
  done
  all_strings "$f" && ! grep -qE 'telflo-(node|cluster)' "$f.yaml"
}
run_case "a node's objects, refs, labels and hostPaths follow fullnameOverride; no telflo-node remains" node_names_follow_override

cluster_names_follow_override() {
  next_file
  render_list "$f" -f "$tmp/cluster.yaml" --set-string "fullnameOverride=$CLUSTER_O" \
    --set-string collectorEnv.LEVEL=debug \
    --set-string clickhouse.endpoint=https://clickhouse.invalid:8443 --set-string clickhouse.password=pw || return 1
  local o="$CLUSTER_O" line
  for line in \
    "ServiceAccount metadata.name string $o" \
    "Secret metadata.name string $o-token" \
    "Secret metadata.name string $o-collector-env" \
    "Secret metadata.name string $o-clickhouse" \
    "ClusterRole metadata.name string $o" \
    "ClusterRoleBinding metadata.name string $o" \
    "ClusterRoleBinding roleRef.name string $o" \
    "ClusterRoleBinding subject.name string $o" \
    "StatefulSet metadata.name string $o" \
    "StatefulSet serviceName string $o" \
    "StatefulSet selector.app string $o" \
    "StatefulSet labels.app string $o" \
    "StatefulSet serviceAccountName string $o" \
    "StatefulSet env.OPAMP_TOKEN.secretKeyRef string $o-token" \
    "StatefulSet env.CLICKHOUSE_PASSWORD.secretKeyRef string $o-clickhouse" \
    "StatefulSet envFrom.secretRef string $o-collector-env"; do
    has_line "$f" "$line" || return 1
  done
  all_strings "$f" && ! grep -qE 'telflo-(node|cluster)' "$f.yaml"
}
run_case "a cluster's objects, refs and labels follow fullnameOverride; no telflo-cluster remains" cluster_names_follow_override

default_names() { # <role> <expected name> <workload kind>
  next_file
  render_list "$f" -f "$tmp/$1.yaml" || return 1
  has_line "$f" "$3 metadata.name string $2" &&
    has_line "$f" "ClusterRole metadata.name string $2" &&
    has_line "$f" "ServiceAccount metadata.name string $2" &&
    has_line "$f" "Secret metadata.name string $2-token"
}
run_case "without an override a node is telflo-node" default_names node telflo-node DaemonSet
run_case "without an override a cluster is telflo-cluster" default_names cluster telflo-cluster StatefulSet

# every object's name and the node state's hostPaths (/var/log/pods, read
# only, is every node's log directory: shared on purpose)
names_of() { awk '$2 == "metadata.name" || ($2 == "hostPath" && $4 ~ /^\/var\/lib\/telflo\//) { print $1 " " $4 }' "$1" | sort -u; }
two_overrides_disjoint() { # <role> <override 1> <override 2>
  next_file; local a="$f"
  render_list "$a" -f "$tmp/$1.yaml" --set-string "fullnameOverride=$2" --set-string collectorEnv.LEVEL=debug || return 1
  next_file; local b="$f"
  render_list "$b" -f "$tmp/$1.yaml" --set-string "fullnameOverride=$3" --set-string collectorEnv.LEVEL=debug || return 1
  names_of "$a" >"$a.names"; names_of "$b" >"$b.names"
  [ "$(wc -l <"$a.names" | tr -d ' ')" -ge 6 ] && [ "$(wc -l <"$b.names" | tr -d ' ')" -ge 6 ] || return 1
  [ -z "$(comm -12 "$a.names" "$b.names")" ] || return 1
  # the cluster-scoped objects, named explicitly
  has_line "$a" "ClusterRole metadata.name string $2" && has_line "$b" "ClusterRole metadata.name string $3" &&
    has_line "$a" "ClusterRoleBinding metadata.name string $2" && has_line "$b" "ClusterRoleBinding metadata.name string $3"
}
run_case "two fleets' Agents share no object name or hostPath" two_overrides_disjoint node "$NODE_O" "$NODE_O2"
run_case "two fleets' Clusters share no object name" two_overrides_disjoint cluster "$CLUSTER_O" "$CLUSTER_O2"

gateway_ignores_override() {
  next_file
  render_list "$f" -f "$tmp/gateway.yaml" --set-string "fullnameOverride=$NODE_O" || return 1
  has_line "$f" "StatefulSet metadata.name string $GATEWAY" &&
    has_line "$f" "StatefulSet serviceName string $GATEWAY" &&
    has_line "$f" "Service metadata.name string $GATEWAY" &&
    has_line "$f" "Service selector.app string $GATEWAY" &&
    has_line "$f" "ServiceAccount metadata.name string $GATEWAY" &&
    has_line "$f" "Secret metadata.name string $GATEWAY-token" &&
    ! grep -qF "$NODE_O" "$f.yaml"
}
run_case "a gateway ignores fullnameOverride" gateway_ignores_override

# ---------------------------------------------------------------------------
echo "# YAML words stay strings (Helm's YAML 1.1 parse)"

word_gateway() { # <name>
  next_file
  render_list "$f" -f "$tmp/gateway.yaml" --set-string "group=$1" --set-string collectorEnv.LEVEL=debug || return 1
  local line
  for line in \
    "StatefulSet metadata.name string $1" \
    "StatefulSet serviceName string $1" \
    "StatefulSet selector.app string $1" \
    "StatefulSet labels.app string $1" \
    "StatefulSet serviceAccountName string $1" \
    "StatefulSet env.OPAMP_TOKEN.secretKeyRef string $1-token" \
    "StatefulSet envFrom.secretRef string $1-collector-env" \
    "Service metadata.name string $1" \
    "Service selector.app string $1" \
    "ServiceAccount metadata.name string $1"; do
    has_line "$f" "$line" || return 1
  done
  all_strings "$f"
}
run_case "a gateway named on keeps the name on" word_gateway on
run_case "a gateway named null keeps the name null" word_gateway null
run_case "a gateway named yes keeps the name yes" word_gateway yes

word_node_names() {
  next_file
  render_list "$f" -f "$tmp/node.yaml" --set-string fullnameOverride=12345678 -n yes || return 1
  has_line "$f" "DaemonSet metadata.name string 12345678" &&
    has_line "$f" "ClusterRoleBinding subject.namespace string yes" &&
    all_strings "$f"
}
run_case "a numeric override and a namespace named yes stay strings" word_node_names

word_override() { # <role> <workload kind> <override>
  next_file
  render_list "$f" -f "$tmp/$1.yaml" --set-string "fullnameOverride=$3" || return 1
  local line
  for line in \
    "$2 metadata.name string $3" \
    "$2 selector.app string $3" \
    "$2 labels.app string $3" \
    "$2 serviceAccountName string $3" \
    "ServiceAccount metadata.name string $3" \
    "ClusterRole metadata.name string $3" \
    "ClusterRoleBinding metadata.name string $3" \
    "ClusterRoleBinding roleRef.name string $3" \
    "ClusterRoleBinding subject.name string $3"; do
    has_line "$f" "$line" || return 1
  done
  if [ "$2" = StatefulSet ]; then has_line "$f" "StatefulSet serviceName string $3" || return 1; fi
  all_strings "$f"
}
run_case "a Cluster whose override is yes keeps the name yes" word_override cluster StatefulSet yes
run_case "an Agent whose override is on keeps the name on" word_override node DaemonSet on

word_env_keys() {
  next_file
  printf 'collectorEnv:\n  "ON": "v1"\n  "yes": "v2"\n  "null": "v3"\n  "~": "v4"\n  "Off": "v5"\n' >"$f.values"
  render_list "$f" -f "$tmp/node.yaml" --set-string "fullnameOverride=$NODE_O" -f "$f.values" || return 1
  local key
  for key in '"ON"' '"yes"' '"null"' '"~"' '"Off"'; do
    has_line "$f" "Secret stringData.key string $key $NODE_O-collector-env" || return 1
  done
  [ "$(grep -c "^Secret stringData.key string .* $NODE_O-collector-env\$" "$f")" = 5 ] && all_strings "$f"
}
run_case "collectorEnv keys ON, yes, null, ~ and Off survive as those names" word_env_keys

# ---------------------------------------------------------------------------
echo "# checksum/token: the sha256 of the rendered token Secret, on every workload"

checksum_is_secrets_sha() { # <role>
  next_file; local all="$f"
  render "$all" -f "$tmp/$1.yaml" || return 1
  next_file; local secret="$f"
  render "$secret" -f "$tmp/$1.yaml" --show-only templates/secret.yaml || return 1
  local got want
  got="$(token_checksum "$all")" || return 1
  want="$(tail -n +3 "$secret" | sha256)"
  [ -n "$want" ] && [ "$got" = "$want" ]
}
run_case "the DaemonSet's checksum/token is the token Secret's sha256" checksum_is_secrets_sha node
run_case "the Cluster's StatefulSet's checksum/token is the token Secret's sha256" checksum_is_secrets_sha cluster
run_case "the gateway's StatefulSet's checksum/token is the token Secret's sha256" checksum_is_secrets_sha gateway

checksum_of() { # <role> <helm args...>: renders into $f (the caller's next_file) and prints its checksum/token
  local role="$1"; shift
  render_as "${RELEASE:-smoke}" "$f" -f "$tmp/$role.yaml" "$@" || return 1
  token_checksum "$f"
}
checksum_changes() { # <role> <args A as one string> <args B as one string>
  local a b
  next_file; a="$(checksum_of "$1" $2)" || return 1
  next_file; b="$(checksum_of "$1" $3)" || return 1
  [ "$a" != "$b" ]
}
checksum_same() {
  local a b
  next_file; a="$(checksum_of "$1" $2)" || return 1
  next_file; b="$(checksum_of "$1" $3)" || return 1
  [ "$a" = "$b" ]
}
# (the arguments below are word-split on purpose: none holds a space)
for role in node cluster gateway; do
  run_case "$role: a new token changes checksum/token" checksum_changes "$role" \
    "--set-string token=first-token-aaaa" "--set-string token=second-token-bbbb"
  run_case "$role: two renders of one token agree" checksum_same "$role" "--set-string token=first-token-aaaa" \
    "--set-string token=first-token-aaaa"
done
run_case "checksum/token unchanged by the endpoint" checksum_same node \
  "--set-string endpoint=https://one.invalid/v1" "--set-string endpoint=https://two.invalid/v1"
run_case "checksum/token unchanged by the image" checksum_same node \
  "--set-string image.tag=0.159.0" "--set-string image.repository=registry.invalid/other,image.tag=0.162.0"
run_case "checksum/token unchanged by collectorEnv" checksum_same cluster \
  "--set-string collectorEnv.LEVEL=debug" "--set-string collectorEnv.LEVEL=info,collectorEnv.OTHER=x"
run_case "checksum/token unchanged by the namespace" checksum_same gateway "-n one" "-n two"
release_same() {
  local a b
  next_file; a="$(RELEASE=telflo-node checksum_of node)" || return 1
  next_file; b="$(RELEASE=other-release checksum_of node)" || return 1
  [ "$a" = "$b" ]
}
run_case "checksum/token unchanged by the release name" release_same
run_case "checksum/token changes with the Secret's name (the fullname)" checksum_changes node \
  "--set-string fullnameOverride=$NODE_O" "--set-string fullnameOverride=$NODE_O2"

env_checksum_of() { # <role> <helm args...>: renders into $f; prints the one checksum/collector-env
  local role="$1" lines; shift
  render "$f" -f "$tmp/$role.yaml" "$@" || return 1
  lines="$(sed -n 's/^ *checksum\/collector-env: //p' "$f")"
  [ -n "$lines" ] && [ "$(printf '%s\n' "$lines" | wc -l | tr -d ' ')" = 1 ] || return 1
  printf '%s\n' "$lines"
}
env_checksum_present() { next_file; env_checksum_of "$1" --set-string collectorEnv.LEVEL=debug >/dev/null; }
env_checksum_changes() {
  local a b
  next_file; a="$(env_checksum_of node --set-string collectorEnv.LEVEL=debug)" || return 1
  next_file; b="$(env_checksum_of node --set-string collectorEnv.LEVEL=info)" || return 1
  [ "$a" != "$b" ]
}
env_checksum_same() {
  local a b
  next_file; a="$(env_checksum_of node --set-string collectorEnv.LEVEL=debug)" || return 1
  next_file; b="$(env_checksum_of node --set-string collectorEnv.LEVEL=debug)" || return 1
  [ "$a" = "$b" ]
}
for role in node cluster gateway; do
  run_case "$role: checksum/collector-env present when collectorEnv is set" env_checksum_present "$role"
done
run_case "checksum/collector-env changes with a value" env_checksum_changes
run_case "checksum/collector-env: two renders of one value agree" env_checksum_same

# ---------------------------------------------------------------------------
echo "# a pod's identity, mounts and RBAC rules (KEPT behaviour is pinned too: a change is deliberate)"

identity() { # <role> <workload kind> <fullname> <insecure "true"|"false"> <helm args...>
  local role="$1" kind="$2" name="$3" insecure="$4"; shift 4
  next_file
  render_list "$f" -f "$tmp/$role.yaml" "$@" || return 1
  local line
  for line in \
    "$kind env.COLLECTOR_GROUP_ID.value string $GID" \
    "$kind env.OPAMP_ENDPOINT.value string $ENDPOINT" \
    "$kind env.OPAMP_ALLOW_INSECURE_CONNECTIONS.value string $insecure" \
    "$kind env.OPAMP_SERVER_NAME.value string \$(POD_NAME)" \
    "$kind env.OPAMP_TOKEN.secretKeyRef string $name-token" \
    "$kind env.OPAMP_TOKEN.secretKeyRef.key string token" \
    "$kind env.POD_NAMESPACE.fieldRef string metadata.namespace" \
    "$kind env.POD_NAME.fieldRef string metadata.name" \
    "$kind env.NODE_NAME.fieldRef string spec.nodeName" \
    "$kind env.HOST_IP.fieldRef string status.podIP"; do
    has_line "$f" "$line" || return 1
  done
  # exactly one of each identity variable
  for line in COLLECTOR_GROUP_ID OPAMP_ENDPOINT OPAMP_ALLOW_INSECURE_CONNECTIONS; do
    [ "$(grep -c "^$kind env\.$line\.value " "$f")" = 1 ] || return 1
  done
  all_strings "$f"
}
run_case "node: the pod's identity variables" identity node DaemonSet "$NODE_O" false --set-string "fullnameOverride=$NODE_O"
run_case "cluster: the pod's identity variables" identity cluster StatefulSet "$CLUSTER_O" false --set-string "fullnameOverride=$CLUSTER_O"
run_case "gateway: the pod's identity variables, allowInsecure true" identity gateway StatefulSet "$GATEWAY" true --set allowInsecure=true

# rules_are <listing> <expected rule lines...>: exactly these rules, no other
rules_are() {
  local listing="$1"; shift
  local line
  for line in "$@"; do grep -qxF -- "R ClusterRole rule $line" "$listing" || return 1; done
  [ "$(grep -c '^R ClusterRole rule ' "$listing")" = "$#" ]
}
node_rules() {
  next_file
  render_list "$f" -f "$tmp/node.yaml" || return 1
  rules_are "$f" '[""] ["nodes/stats","nodes/proxy"] ["get"]'
}
run_case "node: the ClusterRole's rules exactly" node_rules
cluster_rules() {
  next_file
  render_list "$f" -f "$tmp/cluster.yaml" || return 1
  rules_are "$f" \
    '[""] ["pods","nodes","namespaces","events","services","endpoints"] ["get","list","watch"]' \
    '["apps"] ["deployments","replicasets","daemonsets","statefulsets"] ["get","list","watch"]'
}
run_case "cluster: the ClusterRole's rules exactly" cluster_rules
gateway_no_rbac() {
  next_file
  render_list "$f" -f "$tmp/gateway.yaml" || return 1
  ! grep -qE '^(R )?ClusterRole(Binding)? ' "$f" && has_line "$f" "StatefulSet metadata.name string $GATEWAY"
}
run_case "gateway: no ClusterRole and no binding" gateway_no_rbac

# every mount's name has a volume or a claim template of that name
mounts_paired() {
  awk '$1 == "R" && ($3 == "volume" || $3 == "claim") { have[$4] = 1 }
       $1 == "R" && $3 == "mount" { want[$5] = 1; n++ }
       END { if (n == 0) exit 1; for (m in want) if (!(m in have)) exit 1 }' "$1"
}
node_mounts() {
  next_file
  render_list "$f" -f "$tmp/node.yaml" --set-string "fullnameOverride=$NODE_O" \
    --set 'volumes[0].hostPath=/var/log/starfeuds' --set 'volumes[0].mountPath=/var/log/starfeuds' || return 1
  local line
  for line in \
    "R DaemonSet mount supervisor varlogpods /var/log/pods true" \
    "R DaemonSet mount supervisor storage /app/opamp -" \
    "R DaemonSet mount supervisor extra-var-log-starfeuds /var/log/starfeuds true" \
    "R DaemonSet volume varlogpods hostPath /var/log/pods Directory" \
    "R DaemonSet volume storage hostPath /var/lib/telflo/supervisor/$NODE_O DirectoryOrCreate" \
    "R DaemonSet volume extra-var-log-starfeuds hostPath /var/log/starfeuds Directory"; do
    has_line "$f" "$line" || return 1
  done
  [ "$(grep -c '^R DaemonSet mount ' "$f")" = 3 ] && [ "$(grep -c '^R DaemonSet volume ' "$f")" = 3 ] && mounts_paired "$f"
}
run_case "node: mounts and volumes paired by name (an extra volume named by its path's slug)" node_mounts
statefulset_mounts() { # <role>
  next_file
  render_list "$f" -f "$tmp/$1.yaml" \
    --set 'volumes[0].hostPath=/srv/data' --set 'volumes[0].mountPath=/var/lib/otelcol/storage' --set 'volumes[0].readOnly=false' || return 1
  local line
  for line in \
    "R StatefulSet mount supervisor storage /app/opamp -" \
    "R StatefulSet mount supervisor extra-var-lib-otelcol-storage /var/lib/otelcol/storage false" \
    "R StatefulSet volume extra-var-lib-otelcol-storage hostPath /srv/data Directory" \
    "R StatefulSet claim storage"; do
    has_line "$f" "$line" || return 1
  done
  [ "$(grep -c '^R StatefulSet mount ' "$f")" = 2 ] && mounts_paired "$f"
}
run_case "cluster: mounts, volumes and the storage claim paired by name" statefulset_mounts cluster
run_case "gateway: mounts, volumes and the storage claim paired by name" statefulset_mounts gateway
clickstack_mounts() {
  next_file
  render_list "$f" -f "$tmp/node.yaml" --set-string clickhouse.endpoint=https://clickhouse.invalid:8443 --set-string clickhouse.password=pw || return 1
  has_line "$f" "R DaemonSet mount fix-storage-ownership collector-data /var/lib/otelcol -" &&
    has_line "$f" "R DaemonSet volume collector-data hostPath /var/lib/telflo/collector/telflo-node DirectoryOrCreate" &&
    mounts_paired "$f"
}
run_case "node, ClickStack: the init container's and the collector's mounts paired" clickstack_mounts

# Ruling 29: a volume's mountPath and hostPath are written quoted, so a path
# that is a YAML word (bare, as the chart takes any string), or holds one as a
# segment, stays that exact string: never true, false or null.
word_mount_paths() { # <role> <workload kind>
  next_file
  printf '%s\n' 'volumes:' \
    '  - { hostPath: "/yes", mountPath: "/on" }' \
    '  - { hostPath: "/var/log/off/null", mountPath: "/data/yes/~" }' \
    '  - { hostPath: "null", mountPath: "off", readOnly: false }' >"$f.values"
  render_list "$f" -f "$tmp/$1.yaml" -f "$f.values" || return 1
  local line
  for line in \
    "$2 mountPath string /on" \
    "$2 hostPath string /yes" \
    "$2 mountPath string /data/yes/~" \
    "$2 hostPath string /var/log/off/null" \
    "$2 mountPath string off" \
    "$2 hostPath string null" \
    "R $2 mount supervisor extra-on /on true" \
    "R $2 volume extra-on hostPath /yes Directory" \
    "R $2 mount supervisor extra-data-yes /data/yes/~ true" \
    "R $2 volume extra-data-yes hostPath /var/log/off/null Directory" \
    "R $2 mount supervisor extra-off off false" \
    "R $2 volume extra-off hostPath null Directory"; do
    has_line "$f" "$line" || return 1
  done
  mounts_paired "$f" && all_strings "$f"
}
run_case "an Agent's mount and host paths that are YAML words stay those strings" word_mount_paths node DaemonSet
run_case "the Cluster's mount and host paths that are YAML words stay those strings" word_mount_paths cluster StatefulSet
run_case "a gateway's mount and host paths that are YAML words stay those strings" word_mount_paths gateway StatefulSet

# ---------------------------------------------------------------------------
echo "# the image and helm lint"

image_is() { # <role> <expected image> <helm args...>
  local role="$1" want="$2"; shift 2
  next_file
  render_list "$f" -f "$tmp/$role.yaml" "$@" || return 1
  has_line "$f" "$(awk '$2 == "metadata.name" && ($1 == "DaemonSet" || $1 == "StatefulSet") { print $1; exit }' "$f") image string $want"
}
run_case "the image defaults to ghcr.io/telflo/telflo/collector:0.162.0" image_is node ghcr.io/telflo/telflo/collector:0.162.0
run_case "image.tag picks the tag" image_is cluster ghcr.io/telflo/telflo/collector:0.159.0 --set-string image.tag=0.159.0
run_case "image.repository picks the repository" image_is gateway registry.invalid/mirror/collector:0.161.0 \
  --set-string image.repository=registry.invalid/mirror/collector,image.tag=0.161.0

lints() { next_file; helm lint --strict "$CHART_DIR" -n "$NS" "$@" >"$f" 2>&1; }
run_case "helm lint --strict passes for a node with an override" lints -f "$tmp/node.yaml" \
  --set-string "fullnameOverride=$NODE_O" --set-string collectorEnv.ON=x
run_case "helm lint --strict passes for a cluster with an override" lints -f "$tmp/cluster.yaml" \
  --set-string "fullnameOverride=$CLUSTER_O"
run_case "helm lint --strict passes for a gateway" lints -f "$tmp/gateway.yaml" --set replicas=2

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
