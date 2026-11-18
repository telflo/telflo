# The platform's Postgres (D33-1 decisions 2, 3, 15 and 25; Preflight ruling
# 2). Sourced by tests/render-tests.sh, which defines every helper used here.

PG_SS="StatefulSet/telflo-postgres"
PG_POD="$PG_SS.spec.template.spec"
PG_C="$PG_POD.containers[postgres]"
PG_CM="ConfigMap/telflo-postgres-bootstrap"
PG_SVC="Service/telflo-postgres"
PG_HEADLESS="Service/telflo-postgres-headless"
# The digest the platform's Postgres runs: scripts/release/tools.lock's
# `postgres` row (the release scripts pull it from there). The vendored
# opamp-server chart's own Postgres pin is never used here (its Postgres is
# off: the opamp-server's database is on this one server) and moves only
# with an opamp-server release, so it may differ.
PG_LOCK="$REPO_DIR/scripts/release/tools.lock"
PG_DIGEST="$(awk '$1 == "image" && $2 == "postgres" && $3 == "postgres" { print $5; exit }' "$PG_LOCK")"

pg_kinds() {
  local k; k="$(kinds "$1")"
  for want in "$PG_CM" "$PG_SVC" "$PG_HEADLESS" "$PG_SS"; do printf '%s\n' "$k" | grep -qx "$want" || return 1; done
}
each_profile "Postgres: the StatefulSet telflo-postgres, its ClusterIP and headless Services, its bootstrap ConfigMap" pg_kinds
pg_services() {
  eq "$1" "$PG_SS.spec.serviceName" '"telflo-postgres-headless"' && eq "$1" "$PG_SS.spec.replicas" 1 &&
    eq "$1" "$PG_HEADLESS.spec.clusterIP" '"None"' && eq "$1" "$PG_SVC.spec.type" '"ClusterIP"' &&
    eq "$1" "$PG_SVC.spec.ports[postgres].port" 5432 && eq "$1" "$PG_SVC.spec.ports[postgres].targetPort" '"postgres"' &&
    eq "$1" "$PG_HEADLESS.spec.ports[postgres].port" 5432 && eq "$1" "$PG_C.ports[postgres].containerPort" 5432
}
each_profile "Postgres: one replica named by the headless Service; telflo-postgres:5432 a ClusterIP Service" pg_services
pg_selectors() {
  local s
  for s in "$PG_SVC.spec.selector" "$PG_HEADLESS.spec.selector" "$PG_SS.spec.selector.matchLabels" "$PG_SS.spec.template.metadata.labels"; do
    eq "$1" "$s.app.kubernetes.io/name" '"telflo"' && eq "$1" "$s.app.kubernetes.io/instance" "\"$REL\"" &&
      eq "$1" "$s.app.kubernetes.io/component" '"postgres"' || return 1
  done
  no_path "$1" "$PG_SVC.spec.selector.helm.sh/chart" && no_path "$1" "$PG_SS.spec.selector.matchLabels.app.kubernetes.io/version"
}
each_profile "Postgres: Services and StatefulSet select name telflo, the release, component postgres (no version in a selector)" pg_selectors

# The image.
pg_image_default() {
  [ -n "$PG_DIGEST" ] && eq "$L" "$PG_C.image" "\"docker.io/library/postgres:18@$PG_DIGEST\"" &&
    eq "$L" "$PG_C.imagePullPolicy" '"IfNotPresent"'
}
run_case "Postgres: postgres:18 pinned by tools.lock's postgres digest" pg_image_default
pg_image_full() {
  eq "$(listing full)" "$PG_C.image" "\"registry.example.com/mirror/postgres:18@$PG_DIGEST\"" &&
    eq "$(listing full)" "$PG_C.imagePullPolicy" '"IfNotPresent"'
}
run_case "Postgres: its own image.registry replaces image.registry (full)" pg_image_full
pg_no_digest() {
  next_file
  render_flat "$f" "${D[@]}" --set-string postgres.image.digest= --set-string postgres.image.pullPolicy=Never || return 1
  eq "$f" "$PG_C.image" '"docker.io/library/postgres:18"' && eq "$f" "$PG_C.imagePullPolicy" '"Never"'
}
run_case "Postgres: an empty digest is the tag alone, and its own pullPolicy wins" pg_no_digest

# The first-start guard: the command, exactly (as the flattened listing's
# JSON: toJson writes & and > as their \u escapes, built here at run time).
PG_GUARD_MSG='telflo-postgres: the four passwords (postgres-password and owner-password in the Secret existingSecrets.postgres names, owner-password and runtime-password in the opamp-server Secret) must be set, non-empty and URL-safe (only A-Z a-z 0-9 . _ ~ -); Postgres was not started'
J_AMP="$(printf '%su0026' '\')"
J_GT="$(printf '%su003e' '\')"
pg_guard_text() {
  local cmd want
  eq "$L" "$PG_C.command[0]" '"sh"' && eq "$L" "$PG_C.command[1]" '"-c"' && no_path "$L" "$PG_C.args" || return 1
  cmd="$(value "$L" "$PG_C.command[2]")"
  want='"url_safe() { case \"$1\" in \"\" | *[!A-Za-z0-9._~-]*) return 1 ;; esac; }\n'
  want="$want"'if url_safe \"${POSTGRES_PASSWORD-}\" '"$J_AMP$J_AMP"' url_safe \"${TELFLO_OWNER_PASSWORD-}\" '"$J_AMP$J_AMP"
  want="$want"' url_safe \"${OPAMP_OWNER_PASSWORD-}\" '"$J_AMP$J_AMP"' url_safe \"${OPAMP_RUNTIME_PASSWORD-}\"; then\n'
  want="$want"'  exec docker-entrypoint.sh postgres\nfi\necho \"'"$PG_GUARD_MSG"'\" '"$J_GT$J_AMP"'2\nexit 1\n"'
  [ "$cmd" = "$want" ] || return 1
  # Kubernetes expands $(NAME) in a command: the script must hold none.
  case "$cmd" in *'$('*) return 1 ;; esac
}
run_case "Postgres: the command checks the four passwords (set, non-empty, URL-safe) before docker-entrypoint.sh, else a fixed message and exit 1" pg_guard_text

# The guard, run: the rendered script under sh, with a stand-in
# docker-entrypoint.sh first on PATH that only records that it ran. The
# passwords are fixed test strings, never secrets.
mkdir -p "$tmp/pgguard/templates" "$tmp/pgstandins" || exit 2
printf 'apiVersion: v2\nname: pgguard\nversion: 0.0.0\n' >"$tmp/pgguard/Chart.yaml"
cat >"$tmp/pgguard/templates/g.yaml" <<'TEMPLATE'
{{- range $raw := regexSplit "(?m)^---$" .Values.doc -1 }}
{{- $d := fromYaml $raw }}
{{- if and (eq (toString $d.kind) "StatefulSet") (eq (toString $d.metadata.name) "telflo-postgres") }}
{{- range $c := $d.spec.template.spec.containers }}
{{- if eq $c.name "postgres" }}
{{- range $line := splitList "\n" (index $c.command 2) }}
#G {{ $line }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
TEMPLATE
cat >"$tmp/pgstandins/docker-entrypoint.sh" <<'STANDIN'
#!/bin/sh
echo "entrypoint ran: $*" >"$GUARD_LOG"
exit 0
STANDIN
chmod +x "$tmp/pgstandins/docker-entrypoint.sh"
helm template g "$tmp/pgguard" --set-file "doc=$L.yaml" 2>/dev/null | sed -n 's/^#G //p' >"$tmp/pgguard.sh"
# pg_guard_run <start|refuse> <postgres> <owner> <opamp owner> <opamp runtime>:
# each a password or "-unset-".
pg_guard_run() {
  next_file
  [ -s "$tmp/pgguard.sh" ] || return 1
  rm -f "$f.log"
  local expect="$1" status
  shift
  (
    unset POSTGRES_PASSWORD TELFLO_OWNER_PASSWORD OPAMP_OWNER_PASSWORD OPAMP_RUNTIME_PASSWORD
    [ "$1" = "-unset-" ] || export POSTGRES_PASSWORD="$1"
    [ "$2" = "-unset-" ] || export TELFLO_OWNER_PASSWORD="$2"
    [ "$3" = "-unset-" ] || export OPAMP_OWNER_PASSWORD="$3"
    [ "$4" = "-unset-" ] || export OPAMP_RUNTIME_PASSWORD="$4"
    GUARD_LOG="$f.log" PATH="$tmp/pgstandins:$PATH" sh -c "$(cat "$tmp/pgguard.sh")" >"$f.out" 2>"$f.err"
  )
  status=$?
  if [ "$expect" = start ]; then
    [ "$status" = 0 ] && grep -qx 'entrypoint ran: postgres' "$f.log"
  else
    [ "$status" = 1 ] && [ ! -e "$f.log" ] && grep -qxF -- "$PG_GUARD_MSG" "$f.err" &&
      [ "$(wc -l <"$f.err" | tr -d ' ')" = 1 ] && [ ! -s "$f.out" ] &&
      # the refusal quotes no password
      ! grep -qF 'cnrypw' "$f.err"
  fi
}
H1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
H2=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
run_case "Postgres guard: starts with four hex passwords (create-secrets.sh's shape)" pg_guard_run start "$H1" "$H2" "$H1" "$H2"
run_case "Postgres guard: starts with every URL-safe character (A-Z a-z 0-9 . _ ~ -)" pg_guard_run start 'Aa0.cnrypw_~-' 'Zz9._~-cnrypw' 'x' 'Y-'
run_case "Postgres guard: refuses POSTGRES_PASSWORD unset" pg_guard_run refuse -unset- "$H2" "$H1" "$H2"
run_case "Postgres guard: refuses TELFLO_OWNER_PASSWORD unset" pg_guard_run refuse "$H1" -unset- "$H1" "$H2"
run_case "Postgres guard: refuses OPAMP_OWNER_PASSWORD unset" pg_guard_run refuse "$H1" "$H2" -unset- "$H2"
run_case "Postgres guard: refuses OPAMP_RUNTIME_PASSWORD unset" pg_guard_run refuse "$H1" "$H2" "$H1" -unset-
run_case "Postgres guard: refuses an empty password" pg_guard_run refuse "$H1" '' "$H1" "$H2"
run_case "Postgres guard: refuses an @ (not URL-safe), quoting nothing" pg_guard_run refuse 'cnrypw@x' "$H2" "$H1" "$H2"
run_case "Postgres guard: refuses a / (base64's), quoting nothing" pg_guard_run refuse "$H1" "$H2" 'cnrypw/x' "$H2"
run_case "Postgres guard: refuses a + and = (base64's), quoting nothing" pg_guard_run refuse "$H1" "$H2" "$H1" 'cnrypw+x='
run_case "Postgres guard: refuses a % and a : (a URL's own), quoting nothing" pg_guard_run refuse "$H1" 'cnrypw%3A:x' "$H1" "$H2"
run_case "Postgres guard: refuses a space and a newline" pg_guard_run refuse 'cnrypw x' "$H2" "$H1" "$H1
x"

# The environment.
pg_env() {
  [ "$(env_names "$1" "$PG_C" | tr '\n' ' ')" = "POSTGRES_USER POSTGRES_PASSWORD TELFLO_OWNER_PASSWORD OPAMP_OWNER_PASSWORD OPAMP_RUNTIME_PASSWORD OPAMP_DATABASE_NAME " ] &&
    eq "$1" "$PG_C.env[POSTGRES_USER].value" '"postgres"' && eq "$1" "$PG_C.env[OPAMP_DATABASE_NAME].value" '"telflo_opamp_server"' &&
    no_path "$1" "$PG_C.env[POSTGRES_DB]" && no_path "$1" "$PG_C.envFrom"
}
each_profile "Postgres: exactly POSTGRES_USER postgres, the four passwords, OPAMP_DATABASE_NAME telflo_opamp_server; no POSTGRES_DB" pg_env
pg_secret_keys_default() {
  [ "$(secret_keys "$L" "$PG_C" | tr '\n' ' ')" = "telflo-opamp-server/owner-password telflo-opamp-server/runtime-password telflo-postgres/owner-password telflo-postgres/postgres-password " ] &&
    eq "$L" "$PG_C.env[POSTGRES_PASSWORD].valueFrom.secretKeyRef.key" '"postgres-password"' &&
    eq "$L" "$PG_C.env[TELFLO_OWNER_PASSWORD].valueFrom.secretKeyRef.key" '"owner-password"' &&
    eq "$L" "$PG_C.env[OPAMP_OWNER_PASSWORD].valueFrom.secretKeyRef.key" '"owner-password"' &&
    eq "$L" "$PG_C.env[OPAMP_RUNTIME_PASSWORD].valueFrom.secretKeyRef.key" '"runtime-password"' &&
    no_path "$L" "$PG_C.env[POSTGRES_PASSWORD].valueFrom.secretKeyRef.optional"
}
run_case "Postgres reads postgres-password and owner-password from telflo-postgres, owner-password and runtime-password from telflo-opamp-server (never api-password)" pg_secret_keys_default
pg_secret_keys_full() {
  [ "$(secret_keys "$(listing full)" "$PG_C" | tr '\n' ' ')" = "example-opamp/owner-password example-opamp/runtime-password example-postgres/owner-password example-postgres/postgres-password " ]
}
run_case "Postgres's Secrets follow existingSecrets.postgres and opamp-server.auth.existingSecret (full)" pg_secret_keys_full

# The bootstraps' volumes.
pg_initdb() {
  local v="$PG_POD.volumes[initdb].projected.sources"
  eq "$1" "$PG_C.volumeMounts[initdb].mountPath" '"/docker-entrypoint-initdb.d"' &&
    eq "$1" "$PG_C.volumeMounts[initdb].readOnly" true &&
    eq "$1" "$v[0].configMap.name" '"telflo-opamp-server-bootstrap"' &&
    eq "$1" "$v[0].configMap.items[0].key" '"initdb.sh"' && eq "$1" "$v[0].configMap.items[0].path" '"opamp-initdb.sh"' &&
    eq "$1" "$v[0].configMap.items[0].mode" 365 && no_path "$1" "$v[0].configMap.items[1]" &&
    eq "$1" "$v[1].configMap.name" '"telflo-postgres-bootstrap"' &&
    eq "$1" "$v[1].configMap.items[0].key" '"telflo-initdb.sh"' && eq "$1" "$v[1].configMap.items[0].path" '"telflo-initdb.sh"' &&
    eq "$1" "$v[1].configMap.items[0].mode" 365 && no_path "$1" "$v[1].configMap.items[1]" &&
    no_path "$1" "$v[2]"
}
each_profile "Postgres: one projected volume at /docker-entrypoint-initdb.d holding only opamp-initdb.sh and telflo-initdb.sh, each 0555" pg_initdb
pg_sql_mounts() {
  eq "$1" "$PG_C.volumeMounts[opamp-bootstrap].mountPath" '"/opamp-bootstrap"' &&
    eq "$1" "$PG_POD.volumes[opamp-bootstrap].configMap.name" '"telflo-opamp-server-bootstrap"' &&
    eq "$1" "$PG_POD.volumes[opamp-bootstrap].configMap.items[0].key" '"bootstrap.sql"' &&
    eq "$1" "$PG_POD.volumes[opamp-bootstrap].configMap.items[0].path" '"bootstrap.sql"' &&
    eq "$1" "$PG_C.volumeMounts[telflo-bootstrap].mountPath" '"/telflo-bootstrap"' &&
    eq "$1" "$PG_POD.volumes[telflo-bootstrap].configMap.name" '"telflo-postgres-bootstrap"' &&
    eq "$1" "$PG_POD.volumes[telflo-bootstrap].configMap.items[0].key" '"telflo-bootstrap.sql"' &&
    eq "$1" "$PG_POD.volumes[telflo-bootstrap].configMap.items[0].path" '"telflo-bootstrap.sql"' &&
    ! grep -F "$PG_POD.volumes[initdb]" "$1" | grep -q '\.sql"'
}
each_profile "Postgres: the two .sql files mounted outside the init folder (/opamp-bootstrap, /telflo-bootstrap), where their scripts read them" pg_sql_mounts
pg_paths_match_scripts() {
  grep -qF -- '-f /opamp-bootstrap/bootstrap.sql' "$SUBCHART_DIR/files/initdb.sh" &&
    grep -qF -- '-f /telflo-bootstrap/telflo-bootstrap.sql' "$CHART_DIR/files/telflo-initdb.sh"
}
run_case "Postgres: each initdb script reads its .sql where the chart mounts it" pg_paths_match_scripts
pg_data() {
  eq "$1" "$PG_C.volumeMounts[data].mountPath" '"/var/lib/postgresql"' &&
    eq "$1" "$PG_C.volumeMounts[run].mountPath" '"/var/run/postgresql"' && eq "$1" "$PG_POD.volumes[run].emptyDir" '{}' &&
    eq "$1" "$PG_C.volumeMounts[tmp].mountPath" '"/tmp"' && eq "$1" "$PG_POD.volumes[tmp].emptyDir" '{}' &&
    eq "$1" "$PG_SS.spec.volumeClaimTemplates[0].metadata.name" '"data"' &&
    eq "$1" "$PG_SS.spec.volumeClaimTemplates[0].spec.accessModes[0]" '"ReadWriteOnce"' && no_path "$1" "$PG_SS.spec.volumeClaimTemplates[1]"
}
each_profile "Postgres: data on its claim at /var/lib/postgresql, emptyDirs at /var/run/postgresql and /tmp" pg_data
pg_claim_default() {
  eq "$L" "$PG_SS.spec.volumeClaimTemplates[0].spec.resources.requests.storage" '"8Gi"' &&
    no_path "$L" "$PG_SS.spec.volumeClaimTemplates[0].spec.storageClassName"
}
run_case "Postgres: an 8Gi claim in the cluster's default storage class by default" pg_claim_default
pg_claim_set() {
  eq "$(listing local-file-store)" "$PG_SS.spec.volumeClaimTemplates[0].spec.storageClassName" '"standard"' &&
    eq "$(listing local-file-store)" "$PG_SS.spec.volumeClaimTemplates[0].spec.resources.requests.storage" '"2Gi"' &&
    eq "$(listing full)" "$PG_SS.spec.volumeClaimTemplates[0].spec.storageClassName" '"fast"' &&
    eq "$(listing full)" "$PG_SS.spec.volumeClaimTemplates[0].spec.resources.requests.storage" '"50Gi"'
}
run_case "Postgres: postgres.storageClassName and postgres.size set the claim" pg_claim_set

# The bootstrap ConfigMap and its files.
pg_configmap_holds() { # <data key> <file>
  next_file
  helm template j "$tmp/json" --set-file "f=$2" >"$f" 2>"$f.err" || return 1
  [ -n "$(value "$L" "$PG_CM.data.$1")" ] && [ "$(value "$L" "$PG_CM.data.$1")" = "$(sed -n 's/^# J //p' "$f")" ]
}
run_case "Postgres: the ConfigMap's telflo-bootstrap.sql is the file, byte for byte" pg_configmap_holds telflo-bootstrap.sql "$CHART_DIR/files/telflo-bootstrap.sql"
run_case "Postgres: the ConfigMap's telflo-initdb.sh is the file, byte for byte" pg_configmap_holds telflo-initdb.sh "$CHART_DIR/files/telflo-initdb.sh"
pg_initdb_lines() {
  local s="$CHART_DIR/files/telflo-initdb.sh"
  [ "$(head -1 "$s")" = '#!/bin/sh' ] && grep -qx 'set -eu' "$s" &&
    grep -qxF "PGOPTIONS='-c log_min_error_statement=panic'" "$s" && grep -qxF 'export PGOPTIONS' "$s" &&
    grep -qxF 'exec psql -X -v ON_ERROR_STOP=1 --no-password --username "$POSTGRES_USER" --dbname postgres \' "$s" &&
    grep -qxF '  -f /telflo-bootstrap/telflo-bootstrap.sql' "$s" &&
    [ "$(grep -n 'PGOPTIONS=' "$s" | cut -d: -f1)" -lt "$(grep -n '^exec psql' "$s" | cut -d: -f1)" ] &&
    ! grep -v '^#' "$s" | grep -q 'PASSWORD'
}
run_case "telflo-initdb.sh: PGOPTIONS log_min_error_statement=panic, then exec psql on /telflo-bootstrap/telflo-bootstrap.sql, no password on its command line" pg_initdb_lines
pg_sql() {
  local s="$CHART_DIR/files/telflo-bootstrap.sql"
  grep -qx '\\getenv owner_password TELFLO_OWNER_PASSWORD' "$s" && grep -qx '\\unset owner_password' "$s" &&
    grep -qF "'create role telflo_platform_owner login createrole nosuperuser nocreatedb nobypassrls noreplication password %L'" "$s" &&
    grep -qx 'alter role telflo_platform_owner login createrole nosuperuser nocreatedb nobypassrls noreplication' "$s" &&
    grep -qF "select 'create database telflo_platform owner telflo_platform_owner encoding ''UTF8'' template template0'" "$s" &&
    grep -qx "alter database telflo_platform owner to telflo_platform_owner;" "$s" &&
    ! grep -v '^--' "$s" | grep -qiE 'log_statement|[^o]superuser|createdb[^ ]|grant .* to telflo_platform_owner'
}
run_case "telflo-bootstrap.sql: telflo_platform_owner LOGIN CREATEROLE and nothing more, its password from TELFLO_OWNER_PASSWORD, the database telflo_platform from template0, UTF8" pg_sql

# The pod's settings.
pg_security() {
  eq "$1" "$PG_POD.automountServiceAccountToken" false && eq "$1" "$PG_POD.enableServiceLinks" false &&
    eq "$1" "$PG_POD.securityContext.runAsNonRoot" true && eq "$1" "$PG_POD.securityContext.runAsUser" 999 &&
    eq "$1" "$PG_POD.securityContext.runAsGroup" 999 && eq "$1" "$PG_POD.securityContext.fsGroup" 999 &&
    eq "$1" "$PG_POD.securityContext.seccompProfile.type" '"RuntimeDefault"' &&
    eq "$1" "$PG_C.securityContext.allowPrivilegeEscalation" false && eq "$1" "$PG_C.securityContext.readOnlyRootFilesystem" true &&
    eq "$1" "$PG_C.securityContext.runAsNonRoot" true && eq "$1" "$PG_C.securityContext.runAsUser" 999 &&
    eq "$1" "$PG_C.securityContext.capabilities.drop[0]" '"ALL"' && no_path "$1" "$PG_C.securityContext.capabilities.drop[1]" &&
    no_path "$1" "$PG_C.securityContext.capabilities.add" && no_path "$1" "$PG_C.securityContext.privileged" &&
    eq "$1" "$PG_C.securityContext.seccompProfile.type" '"RuntimeDefault"' && no_path "$1" "$PG_POD.hostNetwork" &&
    no_path "$1" "$PG_POD.serviceAccountName"
}
each_profile "Postgres: non-root 999, read-only root, ALL dropped, no escalation, RuntimeDefault, no token, no service links" pg_security
pg_probes() {
  local c='["pg_isready","-h","127.0.0.1","-p","5432","-U","postgres","-d","postgres"]'
  [ "$(grep -F "$PG_C.readinessProbe.exec.command[" "$1" | awk '{ print $2 }' | tr '\n' ',' | sed 's/,$//; s/^/[/; s/$/]/')" = "$c" ] &&
    [ "$(grep -F "$PG_C.livenessProbe.exec.command[" "$1" | awk '{ print $2 }' | tr '\n' ',' | sed 's/,$//; s/^/[/; s/$/]/')" = "$c" ]
}
each_profile "Postgres: readiness and liveness are pg_isready over TCP on 127.0.0.1" pg_probes
pg_pull_secrets() {
  no_path "$L" "$PG_POD.imagePullSecrets" &&
    [ "$(names_at "$(listing full)" "$PG_POD.imagePullSecrets" | tr '\n' ' ')" = "registry-pull registry-pull-mirror " ]
}
run_case "Postgres: imagePullSecrets is global.imagePullSecrets (none by default)" pg_pull_secrets
pg_full_values() {
  local F; F="$(listing full)"
  eq "$F" "$PG_C.resources.requests.cpu" '"500m"' && eq "$F" "$PG_C.resources.limits.memory" '"2Gi"' &&
    eq "$F" "$PG_POD.nodeSelector.example.com/pool" '"data"' && eq "$F" "$PG_POD.tolerations[0].key" '"example.com/data"' &&
    eq "$F" "$PG_SS.spec.template.metadata.annotations.example.com/postgres" '"yes"' &&
    eq "$L" "$PG_C.resources.requests.memory" '"256Mi"' && no_path "$L" "$PG_C.resources.limits" &&
    no_path "$L" "$PG_POD.nodeSelector" && no_path "$L" "$PG_POD.tolerations" && no_path "$L" "$PG_POD.affinity" &&
    no_path "$L" "$PG_SS.spec.template.metadata.annotations"
}
run_case "Postgres: resources, nodeSelector, tolerations and podAnnotations from postgres.* (none but requests by default)" pg_full_values
