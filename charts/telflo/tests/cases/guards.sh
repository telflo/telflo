# The guards (D33-1 decision 26, Preflight rulings 3 and 5): each refuses
# with one fixed message naming the value, never quoting it. Sourced by
# tests/render-tests.sh, which defines every helper used here.
#
# Where the vendored opamp-server chart guards the same value itself
# (server.publicUrl, auth.existingSecret), its templates render first, so
# its own fixed message is the one shown.

# --- required values ---------------------------------------------------------
run_case "guard: publicUrl missing" refused \
  "publicUrl is required: the gateway's public origin, such as https://telflo.example.com" "" "${D[@]}" --set-string publicUrl=
run_case "guard: opamp-server.server.publicUrl missing (the opamp-server chart's own message)" refused \
  "server.publicUrl is required: the agent endpoint's URL as collectors reach it, such as https://opamp.example.com/opamp/api/v1" "" \
  "${D[@]}" --set-string opamp-server.server.publicUrl=
M_URL="publicUrl must be an http or https origin (a host and an optional port), with no user name, password, path, query or fragment"
run_case "guard: publicUrl holding a user and password refused, not quoted" refused "$M_URL" "cnrypw" \
  "${D[@]}" --set-string 'publicUrl=https://cnryuser:cnrypw@telflo.example.com'
run_case "guard: publicUrl with a path refused" refused "$M_URL" "" "${D[@]}" --set-string 'publicUrl=https://telflo.example.com/app'
run_case "guard: publicUrl with a query refused, not quoted" refused "$M_URL" "cnrysig" "${D[@]}" --set-string 'publicUrl=https://telflo.example.com?sig=cnrysig'
run_case "guard: publicUrl without a scheme refused" refused "$M_URL" "" "${D[@]}" --set-string 'publicUrl=telflo.example.com'
public_url_ok() { renders "${D[@]}" --set-string 'publicUrl=http://localhost:8080' && renders "${D[@]}" --set-string 'publicUrl=https://telflo.example.com'; }
run_case "guard: an http or https origin with an optional port renders" public_url_ok
run_case "guard: api.mail.smtp.host holding a user and password refused, not quoted" refused \
  "api.mail.smtp.host must be a host name or address (letters, digits, . and -, or an IPv6 address without brackets), with no user name, password or port" "cnrypw" \
  "${D[@]}" --set-string 'api.mail.smtp.host=cnryuser:cnrypw@smtp.example.com'
run_case "guard: image.registry holding a user and password refused, not quoted" refused \
  "image.registry must be a registry host (and port), then path parts, with no user name or password" "cnrypw" \
  "${D[@]}" --set-string 'image.registry=cnryuser:cnrypw@ghcr.io/telflo'
for key in api web gateway otelcolValidator otelcolTesting ottlEvaluator postgres; do
  run_case "guard: $key.image.registry holding a token refused, not quoted" refused \
    "$key.image.registry must be empty or a registry host (and port), then path parts, with no user name or password" "cnrytok" \
    "${D[@]}" --set-string "$key.image.registry=cnrytok@registry.example.com"
done
run_case "guard: api.image.repository holding a user and password refused, not quoted" refused \
  "api.image.repository must be an image's path (lower-case letters, digits, . _ - and /)" "cnrypw" \
  "${D[@]}" --set-string 'api.image.repository=cnryuser:cnrypw@x/api'
# The agent URL (Ruling 338): the contracts' agent-endpoint shape.
M_AGENT="opamp-server.server.publicUrl must be an http, https, ws or wss URL with a host, an optional port and a path of letters, digits and ._~%/+- (no user name, password, query or fragment)"
run_case "guard: the agent URL holding a user and password refused, not quoted" refused "$M_AGENT" "cnrypw" \
  "${D[@]}" --set-string 'opamp-server.server.publicUrl=https://cnryuser:cnrypw@opamp.example.com/opamp/api/v1'
run_case "guard: the agent URL holding a query refused, not quoted" refused "$M_AGENT" "cnrysig" \
  "${D[@]}" --set-string 'opamp-server.server.publicUrl=https://opamp.example.com/opamp/api/v1?token=cnrysig'
run_case "guard: the agent URL holding a fragment refused, not quoted" refused "$M_AGENT" "cnryfrag" \
  "${D[@]}" --set-string 'opamp-server.server.publicUrl=https://opamp.example.com/opamp/api/v1#cnryfrag'
run_case "guard: the agent URL with a quote in its path refused, not quoted" refused "$M_AGENT" "cnryq" \
  "${D[@]}" --set-string "opamp-server.server.publicUrl=https://opamp.example.com/a'cnryq"
# A scheme other than http or https never reaches the guard: the opamp-server
# chart's own schema refuses it first (and, being a schema, quotes it; the
# vendored chart isn't edited), so this value holds nothing secret.
agent_bad_scheme() {
  next_file
  ! render "$f" "${D[@]}" --set-string 'opamp-server.server.publicUrl=ftp://opamp.example.com/opamp/api/v1' &&
    grep -qF "values don't meet the specifications of the schema" "$f.err" && grep -qF -- "- at '/server/publicUrl'" "$f.err"
}
run_case "guard: the agent URL with an ftp scheme refused (by the opamp-server chart's schema)" agent_bad_scheme
agent_ok() {
  renders "${D[@]}" --set-string 'opamp-server.server.publicUrl=https://opamp.example.com:443/opamp/api/v1' &&
    renders "${D[@]}" --set-string 'opamp-server.server.publicUrl=http://telflo-opamp-server-agent:51234/opamp/api/v1' &&
    renders "${D[@]}" --set-string 'opamp-server.server.publicUrl=http://10.0.0.7:51234'
}
run_case "guard: an agent URL with a host or address, a port and a path renders" agent_ok
run_case "guard: no values at all (publicUrl or the agent URL named first)" refused \
  "server.publicUrl is required: the agent endpoint's URL as collectors reach it, such as https://opamp.example.com/opamp/api/v1" ""
run_case "guard: api.mail.from missing" refused \
  "api.mail.from is required: the sender address of the platform's email" "" "${D[@]}" --set-string api.mail.from=
run_case "guard: api.mail.smtp.host missing with smtp" refused \
  "api.mail.smtp.host is required while api.mail.transport is smtp" "" "${D[@]}" --set-string api.mail.smtp.host=
sendgrid_no_host() { renders "${D[@]}" --set-string api.mail.transport=sendgrid --set-string api.mail.smtp.host=; }
run_case "guard: no SMTP host needed with sendgrid" sendgrid_no_host

M_REQ() { printf '%s is required: the name of a Secret' "$1"; }
for key in postgres api internalServices; do
  run_case "guard: existingSecrets.$key missing" refused "$(M_REQ "existingSecrets.$key")" "" "${D[@]}" --set-string "existingSecrets.$key="
done
oidc_off_no_name() { renders "${D[@]}" --set-string existingSecrets.oidcGoogle=; }
run_case "guard: existingSecrets.oidcGoogle may be empty while api.oidcGoogle.enabled is false" oidc_off_no_name
run_case "guard: existingSecrets.oidcGoogle missing while api.oidcGoogle.enabled" refused "$(M_REQ existingSecrets.oidcGoogle)" "" \
  "${D[@]}" --set api.oidcGoogle.enabled=true --set-string existingSecrets.oidcGoogle=
mail_smtp_no_name() { renders "${D[@]}" --set-string existingSecrets.mail=; }
run_case "guard: existingSecrets.mail may be empty with smtp" mail_smtp_no_name
run_case "guard: existingSecrets.mail missing with sendgrid" refused "$(M_REQ existingSecrets.mail)" "" \
  "${D[@]}" --set-string api.mail.transport=sendgrid --set-string existingSecrets.mail=
run_case "guard: opamp-server.auth.existingSecret missing (the opamp-server chart's own message)" refused \
  "auth.existingSecret is required: the name of the Secret holding the server's credentials" "" \
  "${D[@]}" --set-string opamp-server.auth.existingSecret=
# pulls <file> <second name>: both lists [ghcr-pull, <second name>] in a values file.
pulls() {
  printf 'global:\n  imagePullSecrets:\n    - name: ghcr-pull\n    - name: "%s"\nopamp-server:\n  imagePullSecrets:\n    - name: ghcr-pull\n    - name: "%s"\n' \
    "$2" "$3" >"$1"
}
pulls "$tmp/pull-empty.yaml" "" ""
run_case "guard: a global.imagePullSecrets entry with an empty name" refused "$(M_REQ 'global.imagePullSecrets[1].name')" "" \
  "${D[@]}" -f "$tmp/pull-empty.yaml"

# --- a value that looks like a secret where a name belongs ---------------------
# Each canary is shaped like a generated secret (and holds "cnry", so a
# leak is found): the refusal names the value's path and quotes nothing of
# it, in stdout or stderr.
M_NAME() { printf "%s must be the name of a Secret (at most 63 lower-case letters, digits, - and .), never a secret's value" "$1"; }
HEX32=cnry0123456789abcdef0123456789abcdef
HEX64=cnry0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
B64='cnryQUJD+ZGVm/Z2hp=='
TF='tf_cnryAbCdEf0123456789'
UPPER=CnryTelfloPostgres
for key in postgres api internalServices oidcGoogle mail; do
  run_case "guard: existingSecrets.$key holding hex (32) refused, not quoted" refused "$(M_NAME "existingSecrets.$key")" "$HEX32" \
    "${D[@]}" --set-string "existingSecrets.$key=$HEX32"
done
run_case "guard: existingSecrets.postgres holding hex (64, too long) refused, not quoted" refused "$(M_NAME existingSecrets.postgres)" "$HEX64" \
  "${D[@]}" --set-string "existingSecrets.postgres=$HEX64"
run_case "guard: existingSecrets.api holding base64 (+ / =) refused, not quoted" refused "$(M_NAME existingSecrets.api)" "cnryQUJD" \
  "${D[@]}" --set-string "existingSecrets.api=$B64"
run_case "guard: existingSecrets.internalServices holding a tf_ token refused, not quoted" refused "$(M_NAME existingSecrets.internalServices)" "cnryAbCdEf" \
  "${D[@]}" --set-string "existingSecrets.internalServices=$TF"
run_case "guard: existingSecrets.postgres in upper case refused, not quoted" refused "$(M_NAME existingSecrets.postgres)" "$UPPER" \
  "${D[@]}" --set-string "existingSecrets.postgres=$UPPER"
run_case "guard: opamp-server.auth.existingSecret holding hex refused, not quoted" refused "$(M_NAME opamp-server.auth.existingSecret)" "$HEX32" \
  "${D[@]}" --set-string "opamp-server.auth.existingSecret=$HEX32"
run_case "guard: global.imagePullSecrets[0].name holding hex refused, not quoted" refused "$(M_NAME 'global.imagePullSecrets[0].name')" "$HEX32" \
  "${D[@]}" --set-string "global.imagePullSecrets[0].name=$HEX32" --set-string "opamp-server.imagePullSecrets[0].name=$HEX32"
# (Only the platform's list holds it: the opamp-server chart's schema checks
# its own list's names with a pattern, and a schema's refusal quotes the
# value.)
pulls "$tmp/pull-b64.yaml" "$B64" "other-pull"
run_case "guard: global.imagePullSecrets[1].name holding base64 refused, not quoted" refused "$(M_NAME 'global.imagePullSecrets[1].name')" "cnryQUJD" \
  "${D[@]}" -f "$tmp/pull-b64.yaml"
names_ok() {
  renders "${D[@]}" --set-string existingSecrets.postgres=pg.platform-2026 --set-string existingSecrets.api=a \
    --set-string existingSecrets.internalServices=internal-services-prod-zone-1 --set-string opamp-server.auth.existingSecret=opamp
}
run_case "guard: real names pass (dots, digits in short parts, one letter)" names_ok

# --- the opamp-server chart's wiring ------------------------------------------
run_case "guard: opamp-server.fullnameOverride other than telflo-opamp-server" refused \
  "opamp-server.fullnameOverride must be telflo-opamp-server: the API's management URL and Postgres's bootstrap name it" "" \
  "${D[@]}" --set-string opamp-server.fullnameOverride=opamp
run_case "guard: opamp-server.postgres.enabled true" refused \
  "opamp-server.postgres.enabled must be false: the platform's one Postgres (telflo-postgres) holds the opamp-server's database" "" \
  "${D[@]}" --set opamp-server.postgres.enabled=true --set-string opamp-server.postgres.auth.existingSecret=telflo-postgres
M_DB="opamp-server.externalDatabase must be the platform's Postgres: host telflo-postgres, port 5432, database telflo_opamp_server"
run_case "guard: opamp-server.externalDatabase.host elsewhere" refused "$M_DB" "" "${D[@]}" --set-string opamp-server.externalDatabase.host=db.example.com
run_case "guard: opamp-server.externalDatabase.port other" refused "$M_DB" "" "${D[@]}" --set opamp-server.externalDatabase.port=5433
run_case "guard: opamp-server.externalDatabase.database other" refused "$M_DB" "" "${D[@]}" --set-string opamp-server.externalDatabase.database=opamp
M_PULL="opamp-server.imagePullSecrets must be the same list as global.imagePullSecrets: the opamp-server chart reads only its own"
run_case "guard: global.imagePullSecrets set alone (the defaults both empty)" refused "$M_PULL" "" "${D[@]}" --set-string 'global.imagePullSecrets[0].name=ghcr-pull'
run_case "guard: opamp-server.imagePullSecrets set alone (the defaults both empty)" refused "$M_PULL" "" "${D[@]}" --set-string 'opamp-server.imagePullSecrets[0].name=ghcr-pull'
run_case "guard: global.imagePullSecrets changed alone (both set)" refused "$M_PULL" "" \
  -f "$PROFILES_DIR/full.yaml" --set-string 'global.imagePullSecrets[0].name=other-pull'
run_case "guard: opamp-server.imagePullSecrets emptied alone (both set)" refused "$M_PULL" "" \
  -f "$PROFILES_DIR/full.yaml" --set 'opamp-server.imagePullSecrets=null'
run_case "guard: the two pull-secret lists in another order" refused "$M_PULL" "" \
  -f "$PROFILES_DIR/full.yaml" --set-string 'opamp-server.imagePullSecrets[0].name=registry-pull-mirror' \
  --set-string 'opamp-server.imagePullSecrets[1].name=registry-pull'
no_pull_secrets() { renders "${D[@]}" --set 'global.imagePullSecrets=null' --set 'opamp-server.imagePullSecrets=null'; }
run_case "guard: no pull secrets on either side renders (null as well as the default [])" no_pull_secrets
M_NP="opamp-server.networkPolicy.enabled must equal networkPolicy.enabled"
run_case "guard: networkPolicy off, the opamp-server's on" refused "$M_NP" "" "${D[@]}" --set networkPolicy.enabled=false
run_case "guard: networkPolicy on, the opamp-server's off" refused "$M_NP" "" "${D[@]}" --set opamp-server.networkPolicy.enabled=false
run_case "guard: management.from empty while the policies are on" refused \
  "opamp-server.networkPolicy.management.from must not be empty while its policies are on: it names the API's pods" "" \
  "${D[@]}" --set 'opamp-server.networkPolicy.management.from=null'
from_empty_off() { renders -f "$PROFILES_DIR/no-network-policy.yaml" --set 'opamp-server.networkPolicy.management.from=null'; }
run_case "guard: management.from may be empty with both policies off" from_empty_off

# --- the API's file store -------------------------------------------------------
run_case "guard: the local file store with two API replicas" refused \
  "api.replicas must be 1 while api.fileStore.kind is local: its volume is ReadWriteOnce" "" "${D[@]}" --set api.replicas=2
s3_replicas() { renders -f "$PROFILES_DIR/s3-file-store.yaml" --set api.replicas=5; }
run_case "guard: S3 with five API replicas renders" s3_replicas
run_case "guard: S3 without its bucket" refused "api.fileStore.bucket is required while api.fileStore.kind is s3" "" \
  -f "$PROFILES_DIR/s3-file-store.yaml" --set-string api.fileStore.bucket=
run_case "guard: S3 without its region" refused "api.fileStore.region is required while api.fileStore.kind is s3" "" \
  -f "$PROFILES_DIR/s3-file-store.yaml" --set-string api.fileStore.region=
M_EP="api.fileStore.endpoint must be an http or https origin (a host and an optional port), with no user name, password, path, query or fragment"
run_case "guard: an endpoint holding a user and password refused, not quoted" refused "$M_EP" "cnrypw" \
  -f "$PROFILES_DIR/s3-file-store.yaml" --set-string 'api.fileStore.endpoint=https://cnryuser:cnrypw@objects.example.com'
run_case "guard: an endpoint holding a presigned query refused, not quoted" refused "$M_EP" "cnrysig" \
  -f "$PROFILES_DIR/s3-file-store.yaml" --set-string 'api.fileStore.endpoint=https://objects.example.com/b?X-Amz-Signature=cnrysig'
run_case "guard: an endpoint with a path refused" refused "$M_EP" "" \
  -f "$PROFILES_DIR/s3-file-store.yaml" --set-string 'api.fileStore.endpoint=https://objects.example.com/bucket'
endpoint_ok() {
  renders -f "$PROFILES_DIR/s3-file-store.yaml" --set-string 'api.fileStore.endpoint=http://seaweedfs.storage:8333/' &&
    renders -f "$PROFILES_DIR/s3-file-store.yaml" --set-string 'api.fileStore.endpoint='
}
run_case "guard: an origin with a port (and a trailing /), or none, renders" endpoint_ok

# --- the gateway's Service -----------------------------------------------------
run_case "guard: loadBalancerSourceRanges without a LoadBalancer" refused \
  "gateway.service.loadBalancerSourceRanges needs gateway.service.type LoadBalancer" "" \
  "${D[@]}" --set-string gateway.service.type=NodePort --set 'gateway.service.loadBalancerSourceRanges={10.9.9.0/24}'
run_case "guard: externalTrafficPolicy with a ClusterIP gateway" refused \
  "gateway.service.externalTrafficPolicy needs gateway.service.type LoadBalancer or NodePort" "" \
  "${D[@]}" --set-string gateway.service.type=ClusterIP --set-string gateway.service.externalTrafficPolicy=Local
# A null type is a LoadBalancer (gateway.yaml's default), for the guards as
# for the Service: source ranges with it render. (An empty one never reaches
# the templates: the schema's enum refuses it.)
lb_default_type() { # <how to set the type>
  next_file
  render_flat "$f" "${D[@]}" "$@" --set 'gateway.service.loadBalancerSourceRanges={10.9.9.0/24}' || return 1
  eq "$f" "Service/telflo-gateway.spec.type" '"LoadBalancer"' &&
    eq "$f" "Service/telflo-gateway.spec.loadBalancerSourceRanges[0]" '"10.9.9.0/24"'
}
run_case "guard: loadBalancerSourceRanges with a null gateway.service.type (a LoadBalancer) renders" lb_default_type --set gateway.service.type=null
lb_empty_type() { schema_refused /gateway/service/type "value must be one of" "${D[@]}" --set-string gateway.service.type=; }
run_case "an empty gateway.service.type refused by the schema" lb_empty_type
# NOTES.txt names the type with the same default (helm template never
# renders NOTES, so its text is checked): every gateway.service.type in it
# is `default "LoadBalancer" .Values.gateway.service.type`.
notes_default_type() {
  local n="$CHART_DIR/templates/NOTES.txt" all with
  all="$(grep -o 'gateway\.service\.type' "$n" | wc -l | tr -d ' ')"
  with="$(grep -oF '{{ default "LoadBalancer" .Values.gateway.service.type }}' "$n" | wc -l | tr -d ' ')"
  [ "$with" -ge 1 ] && [ "$all" = "$with" ]
}
run_case "NOTES.txt: the gateway's type through default \"LoadBalancer\", as gateway.yaml renders it" notes_default_type
# Every kubectl line in NOTES.txt names --context <context> (the README's
# rule), and the uninstall note names the file store's claim with the local
# file store (Ruling 331).
notes_context() {
  local n="$CHART_DIR/templates/NOTES.txt"
  [ "$(grep -cE '^ *kubectl ' "$n")" -ge 5 ] && ! grep -E '^ *kubectl ' "$n" | grep -vqF 'kubectl --context <context> -n {{ .Release.Namespace }} '
}
run_case "NOTES.txt: every kubectl command names --context <context>" notes_context
notes_volumes() {
  local n="$CHART_DIR/templates/NOTES.txt"
  grep -qxF '{{- if eq .Values.api.fileStore.kind "local" }}' "$n" &&
    grep -qF "and the API's file store (telflo-api-file-store)" "$n" &&
    grep -qF 'delete pvc data-telflo-postgres-0 telflo-api-file-store' "$n" &&
    [ "$(grep -c 'delete pvc data-telflo-postgres-0' "$n")" = 2 ]
}
run_case "NOTES.txt: uninstall keeps Postgres's volume, and with the local file store telflo-api-file-store too" notes_volumes

# --- one release per namespace ---------------------------------------------------
# lookup reads the cluster only during install and upgrade (helm template
# and lint see nothing). So the guards pass what lookup found to
# telflo.oneReleaseGuard, which a throwaway chart calls here with
# fake objects (a copy of _helpers.tpl and one template).
mkdir -p "$tmp/onerelease/templates" || exit 2
printf 'apiVersion: v2\nname: onerelease\nversion: 0.0.0\n' >"$tmp/onerelease/Chart.yaml"
cp "$CHART_DIR/templates/_helpers.tpl" "$tmp/onerelease/templates/_helpers.tpl"
printf '{{- $_ := include "telflo.oneReleaseGuard" (list .Values.existing .Release.Name) }}\n# passed\n' >"$tmp/onerelease/templates/t.yaml"
M_ONE="this namespace already holds another telflo release (or a Service named telflo-api): one release per namespace"
one_release() { # <expect: pass|refuse> <values file content>
  next_file
  printf '%s\n' "$2" >"$f.values"
  if helm template rel "$tmp/onerelease" -f "$f.values" >"$f" 2>"$f.err"; then
    [ "$1" = pass ] && grep -qx '# passed' "$f"
  else
    [ "$1" = refuse ] && [ "$(grep -c '^Error:' "$f.err")" = 1 ] && grep -qF -- "$M_ONE" "$f.err"
  fi
}
run_case "guard: one release: no telflo-api Service found (a first install) passes" one_release pass 'existing: {}'
run_case "guard: one release: the Service this release owns (an upgrade) passes" one_release pass \
  "$(printf 'existing:\n  metadata:\n    name: telflo-api\n    annotations:\n      meta.helm.sh/release-name: rel')"
run_case "guard: one release: a Service another release owns is refused" one_release refuse \
  "$(printf 'existing:\n  metadata:\n    name: telflo-api\n    annotations:\n      meta.helm.sh/release-name: other')"
run_case "guard: one release: a Service no release owns (no annotation) is refused" one_release refuse \
  "$(printf 'existing:\n  metadata:\n    name: telflo-api\n    labels:\n      app: telflo-api')"
one_release_wired() {
  grep -qF '{{- $_ = include "telflo.oneReleaseGuard" (list (lookup "v1" "Service" .Release.Namespace (include "telflo.apiName" .)) .Release.Name) }}' \
    "$CHART_DIR/templates/_helpers.tpl"
}
run_case "guard: the guards pass lookup's telflo-api Service to oneReleaseGuard" one_release_wired
other_release_name() { renders "${D[@]}" && next_file && helm template other "$CHART_DIR" -n "$NS" "${D[@]}" >"$f" 2>"$f.err"; }
run_case "guard: offline, any release name renders (lookup finds nothing)" other_release_name

# --- every template carries the guards -------------------------------------------
show_only_guarded() {
  local t
  for t in "$CHART_DIR"/templates/*.yaml "$CHART_DIR"/templates/NOTES.txt; do
    [ -f "$t" ] || continue
    head -1 "$t" | grep -qE '^\{\{-? include "telflo\.guards" \. -?\}\}$' || return 1
  done
  refused "publicUrl is required: the gateway's public origin, such as https://telflo.example.com" "" \
    "${D[@]}" --set-string publicUrl= --show-only templates/postgres.yaml
}
run_case "guard: every template starts with the guards, so --show-only of one is refused the same way" show_only_guarded
