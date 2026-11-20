# The API, and what holds for the API, the web app and the gateway
# together: no secret value in any rendered output. Sourced by
# tests/render-tests.sh, which defines every helper used here.

API_D="Deployment/telflo-api"
API_POD="$API_D.spec.template.spec"
API_C="$API_POD.containers[api]"
API_M="$API_POD.initContainers[migrate]"
API_PVC="PersistentVolumeClaim/telflo-api-file-store"
API_SA="ServiceAccount/telflo-api"
API_SVC="Service/telflo-api"
# api_words <command...>: its output's lines joined by spaces (each followed by one)
api_words() { "$@" | tr '\n' ' '; }
# api_local <listing>: the profile's file store is the local one
api_local() { eq "$1" "$API_C.env[TELFLO_FILE_STORE].value" '"local"'; }

# --- the objects -------------------------------------------------------------------
api_kinds() {
  local k; k="$(kinds "$1")"
  for want in "$API_SA" "$API_SVC" "$API_D"; do printf '%s\n' "$k" | grep -qx "$want" || return 1; done
  if api_local "$1"; then printf '%s\n' "$k" | grep -qx "$API_PVC"; else ! printf '%s\n' "$k" | grep -q '^PersistentVolumeClaim/'; fi
}
each_profile "API: its ServiceAccount, Service and Deployment telflo-api; the claim telflo-api-file-store only with the local file store" api_kinds
api_local_profiles() {
  api_local "$L" && api_local "$(listing local-file-store)" && api_local "$(listing no-network-policy)" &&
    ! api_local "$(listing s3-file-store)" && ! api_local "$(listing full)"
}
run_case "API: the local file store in default, local-file-store and no-network-policy; S3 in s3-file-store and full" api_local_profiles
api_service() {
  eq "$1" "$API_SVC.spec.type" '"ClusterIP"' && eq "$1" "$API_SVC.spec.ports[http].port" 8080 &&
    eq "$1" "$API_SVC.spec.ports[http].targetPort" '"http"' && no_path "$1" "$API_SVC.spec.ports[1]" &&
    eq "$1" "$API_C.ports[http].containerPort" 8080 && no_path "$1" "$API_C.ports[1]"
}
each_profile "API: Service telflo-api, ClusterIP, port 8080 to the container's 8080" api_service

# The labels the opamp-server chart's management.from selects (its values
# can't be templated, so they are fixed): the API's pods must carry them.
api_labels() {
  local s
  for s in "$API_D.spec.template.metadata.labels" "$API_D.spec.selector.matchLabels" "$API_SVC.spec.selector"; do
    eq "$1" "$s.app.kubernetes.io/name" '"telflo"' && eq "$1" "$s.app.kubernetes.io/component" '"api"' &&
      eq "$1" "$s.app.kubernetes.io/instance" "\"$REL\"" || return 1
  done
  no_path "$1" "$API_D.spec.selector.matchLabels.app.kubernetes.io/version" && no_path "$1" "$API_D.spec.selector.matchLabels.helm.sh/chart"
}
each_profile "API: pods labeled app.kubernetes.io/name telflo and app.kubernetes.io/component api, selected by both (no version in a selector)" api_labels
api_management_from() { # every label management.from names is on the API's pods, with its value
  local np="NetworkPolicy/telflo-opamp-server-management.spec.ingress[0].from[0].podSelector.matchLabels" lines
  lines="$(awk -v p="$np." 'index($0, p) == 1 { print substr($0, length(p) + 1) }' "$L")"
  [ "$(printf '%s\n' "$lines" | grep -c .)" = 2 ] || return 1
  while IFS=' ' read -r key val; do
    [ -n "$key" ] && eq "$L" "$API_D.spec.template.metadata.labels.$key" "$val" || return 1
  done <<EOF
$lines
EOF
}
run_case "API: its pods match the opamp-server's management.from, label for label (the management port's only client)" api_management_from

# --- the images and the commands ---------------------------------------------------
api_image() {
  eq "$L" "$API_C.image" "\"ghcr.io/telflo/telflo/api:$CHART_VERSION\"" && eq "$L" "$API_C.imagePullPolicy" '"IfNotPresent"' &&
    eq "$L" "$API_M.image" "\"ghcr.io/telflo/telflo/api:$CHART_VERSION\"" && eq "$L" "$API_M.imagePullPolicy" '"IfNotPresent"' &&
    eq "$(listing full)" "$API_C.image" '"registry.example.com/api-mirror/platform/api:mirror-test@sha256:1111111111111111111111111111111111111111111111111111111111111111"' &&
    eq "$(listing full)" "$API_M.image" "$(value "$(listing full)" "$API_C.image")" &&
    eq "$(listing full)" "$API_C.imagePullPolicy" '"IfNotPresent"'
}
run_case "API: ghcr.io/telflo/telflo/api at the chart's appVersion by default; api.image's registry, repository, tag and digest (full); the init container runs the same image" api_image
# The chart's commands are the image's own: the API's start and paths in
# telflo-core/Dockerfile's api stage (a change there fails this). The image is
# compiled: dist/ beside src/ for the API and @telflo/db, db's migrations
# copied, the telflo-admin shim on PATH, and no line but a comment names tsx
# or a source file.
api_dockerfile() {
  local stage
  stage="$(awk '/^FROM .* AS api$/ { on = 1; next } /^FROM / { on = 0 } on' "$REPO_DIR/telflo-core/Dockerfile")"
  printf '%s\n' "$stage" | grep -qxF 'CMD ["node", "dist/index.js"]' &&
    printf '%s\n' "$stage" | grep -qxF 'WORKDIR /app/apps/api' && printf '%s\n' "$stage" | grep -qxF 'COPY catalog/ /catalog/' &&
    printf '%s\n' "$stage" | grep -qxF 'USER 1000:1000' &&
    printf '%s\n' "$stage" | grep -qxF 'COPY --from=api-build /app/apps/api/dist /app/apps/api/dist' &&
    printf '%s\n' "$stage" | grep -qxF 'COPY --from=api-build /app/packages/db/dist /app/packages/db/dist' &&
    printf '%s\n' "$stage" | grep -qxF 'COPY --from=api-build /app/packages/db/migrations /app/packages/db/migrations' &&
    printf '%s\n' "$stage" | grep -qF 'exec node /app/apps/api/dist/admin/telflo-admin.js' &&
    ! grep -vE '^[[:space:]]*#' "$REPO_DIR/telflo-core/Dockerfile" | grep -qE 'tsx|src/[a-z-]+\.ts' &&
    grep -qx 'WORKDIR /app' "$REPO_DIR/telflo-core/Dockerfile" &&
    [ -f "$REPO_DIR/telflo-core/packages/db/src/migrate.ts" ] && [ -f "$REPO_DIR/telflo-core/apps/api/src/index.ts" ] &&
    [ -f "$REPO_DIR/telflo-core/apps/api/src/admin/telflo-admin.ts" ] &&
    eq "$L" "$API_C.workingDir" '"/app/apps/api"' && eq "$L" "$API_M.workingDir" '"/app/packages/db"'
}
run_case "API: the image's start (node dist/index.js in /app/apps/api, uid 1000, the catalog at /catalog), dist/migrate.js and the migrations in /app/packages/db and the telflo-admin shim, compiled, no tsx, as telflo-core/Dockerfile's api stage has them" api_dockerfile

# The url_safe checks, exactly (as the flattened listing's JSON: toJson writes
# & and > as their \u escapes).
A_AMP="$(printf '%su0026' '\')"
A_GT="$(printf '%su003e' '\')"
A_FN='url_safe() { case \"$1\" in \"\" | *[!A-Za-z0-9._~-]*) return 1 ;; esac; }\n'
API_MSG='telflo-api: api-password (in the Secret existingSecrets.postgres names) must be set, non-empty and URL-safe (only A-Z a-z 0-9 . _ ~ -); the API was not started'
MIG_MSG='telflo-api migrate: owner-password and api-password (in the Secret existingSecrets.postgres names) must be set, non-empty and URL-safe (only A-Z a-z 0-9 . _ ~ -); nothing was migrated'
api_command_text() {
  local want
  eq "$1" "$API_C.command[0]" '"sh"' && eq "$1" "$API_C.command[1]" '"-c"' && no_path "$1" "$API_C.command[3]" && no_path "$1" "$API_C.args" &&
    eq "$1" "$API_M.command[0]" '"sh"' && eq "$1" "$API_M.command[1]" '"-c"' && no_path "$1" "$API_M.command[3]" && no_path "$1" "$API_M.args" || return 1
  want='"'"$A_FN"'if url_safe \"${TELFLO_API_PASSWORD-}\"; then\n  exec node dist/index.js\nfi\necho \"'"$API_MSG"'\" '"$A_GT$A_AMP"'2\nexit 1\n"'
  eq "$1" "$API_C.command[2]" "$want" || return 1
  want='"'"$A_FN"'if url_safe \"${TELFLO_OWNER_PASSWORD-}\" '"$A_AMP$A_AMP"' url_safe \"${TELFLO_API_PASSWORD-}\"; then\n  exec node dist/migrate.js\nfi\necho \"'"$MIG_MSG"'\" '"$A_GT$A_AMP"'2\nexit 1\n"'
  eq "$1" "$API_M.command[2]" "$want" || return 1
  # Kubernetes expands $(NAME) in a command: the scripts hold none.
  case "$(value "$1" "$API_C.command[2]")$(value "$1" "$API_M.command[2]")" in *'$('*) return 1 ;; esac
}
each_profile "API: both containers check their passwords are set, non-empty and URL-safe before exec node, else a fixed message and exit 1" api_command_text

# The checks, run: each rendered script under sh, with a stand-in node first
# on PATH that only records its arguments. The passwords are fixed test
# strings, never secrets.
mkdir -p "$tmp/apicmd/templates" "$tmp/apistandins" || exit 2
printf 'apiVersion: v2\nname: apicmd\nversion: 0.0.0\n' >"$tmp/apicmd/Chart.yaml"
cat >"$tmp/apicmd/templates/c.yaml" <<'TEMPLATE'
{{- range $raw := regexSplit "(?m)^---$" .Values.doc -1 }}
{{- $d := fromYaml $raw }}
{{- if and (eq (toString $d.kind) "Deployment") (eq (toString $d.metadata.name) $.Values.name) }}
{{- range $c := index $d.spec.template.spec $.Values.list }}
{{- if eq $c.name $.Values.container }}
{{- range $line := splitList "\n" (index $c.command 2) }}
#C {{ $line }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
TEMPLATE
cat >"$tmp/apistandins/node" <<'STANDIN'
#!/bin/sh
echo "node ran: $*" >"$GUARD_LOG"
exit 0
STANDIN
chmod +x "$tmp/apistandins/node"
helm template c "$tmp/apicmd" --set-file "doc=$L.yaml" --set-string name=telflo-api,list=containers,container=api 2>/dev/null |
  sed -n 's/^#C //p' >"$tmp/apicmd-api.sh"
helm template c "$tmp/apicmd" --set-file "doc=$L.yaml" --set-string name=telflo-api,list=initContainers,container=migrate 2>/dev/null |
  sed -n 's/^#C //p' >"$tmp/apicmd-migrate.sh"
# api_guard_run <api|migrate> <start|refuse> <api password> [<owner password>]:
# each a password or "-unset-".
api_guard_run() {
  next_file
  local which="$1" expect="$2" status msg ran
  [ -s "$tmp/apicmd-$which.sh" ] || return 1
  rm -f "$f.log"
  (
    unset TELFLO_API_PASSWORD TELFLO_OWNER_PASSWORD
    [ "$3" = "-unset-" ] || export TELFLO_API_PASSWORD="$3"
    [ "$#" -lt 4 ] || [ "$4" = "-unset-" ] || export TELFLO_OWNER_PASSWORD="$4"
    GUARD_LOG="$f.log" PATH="$tmp/apistandins:$PATH" sh -c "$(cat "$tmp/apicmd-$which.sh")" >"$f.out" 2>"$f.err"
  )
  status=$?
  if [ "$which" = api ]; then msg="$API_MSG"; ran='node ran: dist/index.js'; else msg="$MIG_MSG"; ran='node ran: dist/migrate.js'; fi
  if [ "$expect" = start ]; then
    [ "$status" = 0 ] && grep -qxF -- "$ran" "$f.log"
  else
    [ "$status" = 1 ] && [ ! -e "$f.log" ] && grep -qxF -- "$msg" "$f.err" &&
      [ "$(wc -l <"$f.err" | tr -d ' ')" = 1 ] && [ ! -s "$f.out" ] &&
      # the refusal quotes no password
      ! grep -qF 'cnrypw' "$f.err"
  fi
}
AH1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
AH2=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
run_case "API check: starts with a hex api-password (create-secrets.sh's shape)" api_guard_run api start "$AH1"
run_case "API check: starts with every URL-safe character" api_guard_run api start 'Aa0.cnrypw_~-Zz9'
run_case "API check: refuses api-password unset" api_guard_run api refuse -unset-
run_case "API check: refuses an empty api-password" api_guard_run api refuse ''
run_case "API check: refuses an @ (not URL-safe), quoting nothing" api_guard_run api refuse 'cnrypw@x'
run_case "API check: refuses base64's / + =, quoting nothing" api_guard_run api refuse 'cnrypw/x+y='
run_case "API check: refuses a : and a %, quoting nothing" api_guard_run api refuse 'cnrypw:x%41'
run_case "migrate check: starts with hex owner-password and api-password" api_guard_run migrate start "$AH1" "$AH2"
run_case "migrate check: refuses owner-password unset" api_guard_run migrate refuse "$AH1" -unset-
run_case "migrate check: refuses api-password unset" api_guard_run migrate refuse -unset- "$AH2"
run_case "migrate check: refuses an empty owner-password" api_guard_run migrate refuse "$AH1" ''
run_case "migrate check: refuses an owner-password with an @, quoting nothing" api_guard_run migrate refuse "$AH1" 'cnrypw@x'
run_case "migrate check: refuses an api-password with a space, quoting nothing" api_guard_run migrate refuse 'cnrypw x' "$AH2"

# --- the environment ----------------------------------------------------------------
API_ENV_HEAD="TELFLO_API_PASSWORD TELFLO_DATABASE_URL TELFLO_API_PORT TELFLO_PUBLIC_WEB_URL TELFLO_PUBLIC_API_URL TELFLO_MAIL_TRANSPORT TELFLO_MAIL_FROM"
API_ENV_SMTP="TELFLO_SMTP_HOST TELFLO_SMTP_PORT TELFLO_SMTP_ALLOW_INSECURE TELFLO_SMTP_TLS"
API_ENV_MID="TELFLO_VERIFICATION_TOKEN_TTL_HOURS TELFLO_ACCESS_TOKEN_SECRET TELFLO_TRUST_PROXY_HOPS"
API_ENV_OPAMP="TELFLO_OPAMP_MANAGEMENT_URL TELFLO_OPAMP_MANAGEMENT_SECRET TELFLO_OPAMP_AGENT_PUBLIC_URL TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS"
API_ENV_SERVICES="TELFLO_OTELCOL_VALIDATOR_URL TELFLO_OTELCOL_VALIDATOR_SECRET TELFLO_OTELCOL_TESTING_URL TELFLO_OTELCOL_TESTING_SECRET TELFLO_OTTL_EVALUATOR_URL TELFLO_OTTL_EVALUATOR_SECRET"
# The site's eleven variables, on the API and the web app alike, always rendered.
SITE_ENV="TELFLO_REGISTRATION TELFLO_PLAYGROUND TELFLO_ANONYMOUS_VALIDATE TELFLO_PUBLIC_FLOWS TELFLO_SALES_INQUIRY TELFLO_EMAIL_NOTIFICATIONS TELFLO_DOCS_URL TELFLO_TERMS_VERSION TELFLO_TERMS_URL TELFLO_PRIVACY_URL TELFLO_COOKIE_POLICY_URL"
API_ENV_KEYS="TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS TELFLO_LIBRARY_LINK_SIGNING_KEY TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS"
api_env_names() { # <listing> <expected, space-separated>
  [ "$(api_words env_names "$1" "$API_C")" = "$2 " ] && no_path "$1" "$API_C.envFrom"
}
run_case "API env, default (smtp, the local file store): exactly the platform's variables, TELFLO_SMTP_TLS and the site's eleven among them, in order" api_env_names "$L" \
  "$API_ENV_HEAD $API_ENV_SMTP $API_ENV_MID $SITE_ENV $API_ENV_OPAMP $API_ENV_SERVICES TELFLO_FILE_STORE TELFLO_FILE_STORE_ROOT $API_ENV_KEYS"
run_case "API env, oss-defaults (the site written out at its defaults): the default's exactly" api_env_names "$(listing oss-defaults)" \
  "$API_ENV_HEAD $API_ENV_SMTP $API_ENV_MID $SITE_ENV $API_ENV_OPAMP $API_ENV_SERVICES TELFLO_FILE_STORE TELFLO_FILE_STORE_ROOT $API_ENV_KEYS"
run_case "API env, s3-file-store: the S3 file store's variables in place of the root" api_env_names "$(listing s3-file-store)" \
  "$API_ENV_HEAD $API_ENV_SMTP $API_ENV_MID $SITE_ENV $API_ENV_OPAMP $API_ENV_SERVICES TELFLO_FILE_STORE TELFLO_FILE_STORE_BUCKET TELFLO_FILE_STORE_PREFIX TELFLO_FILE_STORE_S3_REGION TELFLO_FILE_STORE_S3_ENDPOINT TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE $API_ENV_KEYS"
run_case "API env, full: SendGrid's key in place of SMTP's, Google sign-in's client, the sales address, the S3 file store" api_env_names "$(listing full)" \
  "$API_ENV_HEAD TELFLO_SENDGRID_API_KEY $API_ENV_MID TELFLO_OIDC_GOOGLE_CLIENT_ID TELFLO_OIDC_GOOGLE_CLIENT_SECRET TELFLO_SALES_INQUIRY_TO $SITE_ENV $API_ENV_OPAMP $API_ENV_SERVICES TELFLO_FILE_STORE TELFLO_FILE_STORE_BUCKET TELFLO_FILE_STORE_PREFIX TELFLO_FILE_STORE_S3_REGION TELFLO_FILE_STORE_S3_ENDPOINT TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE $API_ENV_KEYS"
run_case "API env, saas: the SMTP login and CA file after TELFLO_SMTP_TLS, the sales address before the site's" api_env_names "$(listing saas)" \
  "$API_ENV_HEAD $API_ENV_SMTP TELFLO_SMTP_USERNAME TELFLO_SMTP_PASSWORD TELFLO_SMTP_CA_FILE $API_ENV_MID TELFLO_SALES_INQUIRY_TO $SITE_ENV $API_ENV_OPAMP $API_ENV_SERVICES TELFLO_FILE_STORE TELFLO_FILE_STORE_ROOT $API_ENV_KEYS"
api_env_s3_no_optional() { # an empty prefix and endpoint set nothing
  next_file
  render_flat "$f" -f "$PROFILES_DIR/s3-file-store.yaml" --set-string api.fileStore.prefix= --set-string api.fileStore.endpoint= || return 1
  no_path "$f" "$API_C.env[TELFLO_FILE_STORE_PREFIX]" && no_path "$f" "$API_C.env[TELFLO_FILE_STORE_S3_ENDPOINT]" &&
    eq "$f" "$API_C.env[TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE].value" '"true"'
}
run_case "API env: an empty api.fileStore.prefix or endpoint sets no variable" api_env_s3_no_optional
API_UNSET="TELFLO_ACCESS_TOKEN_TTL_MINUTES TELFLO_REFRESH_TOKEN_TTL_DAYS TELFLO_WEB_ORIGIN TELFLO_OIDC_GOOGLE_ISSUER TELFLO_TEST_RUNS_PER_TESTER TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS TELFLO_COLLECTOR_IMAGE_REPOSITORY TELFLO_HELM_CHART_REFERENCE TELFLO_HELM_CHART_VERSION TELFLO_INSTALL_TEMPLATES_DIR LOG_LEVEL TSX_DISABLE_CACHE TELFLO_MIGRATION_DATABASE_URL TELFLO_OWNER_PASSWORD"
api_env_unset() { local v; for v in $API_UNSET; do no_path "$1" "$API_C.env[$v]" || return 1; done; }
each_profile "API env: the variables left unset (token lifetimes, the web origin, the issuer, the tester's limits, the install defaults, LOG_LEVEL), TSX_DISABLE_CACHE and the owner's URL never set on the API's container" api_env_unset

api_env_default_values() {
  eq "$L" "$API_C.env[TELFLO_DATABASE_URL].value" '"postgresql://telflo_platform:$(TELFLO_API_PASSWORD)@telflo-postgres:5432/telflo_platform"' &&
    eq "$L" "$API_C.env[TELFLO_API_PORT].value" '"8080"' &&
    eq "$L" "$API_C.env[TELFLO_PUBLIC_WEB_URL].value" '"https://telflo.example.com"' &&
    eq "$L" "$API_C.env[TELFLO_PUBLIC_API_URL].value" '"https://telflo.example.com"' &&
    eq "$L" "$API_C.env[TELFLO_MAIL_TRANSPORT].value" '"smtp"' &&
    eq "$L" "$API_C.env[TELFLO_MAIL_FROM].value" '"noreply@telflo.example.com"' &&
    eq "$L" "$API_C.env[TELFLO_SMTP_HOST].value" '"smtp.example.com"' &&
    eq "$L" "$API_C.env[TELFLO_SMTP_PORT].value" '"25"' &&
    eq "$L" "$API_C.env[TELFLO_SMTP_ALLOW_INSECURE].value" '"false"' &&
    eq "$L" "$API_C.env[TELFLO_SMTP_TLS].value" '"starttls"' &&
    eq "$L" "$API_C.env[TELFLO_VERIFICATION_TOKEN_TTL_HOURS].value" '"24"' &&
    eq "$L" "$API_C.env[TELFLO_TRUST_PROXY_HOPS].value" '"1"' &&
    eq "$L" "$API_C.env[TELFLO_OPAMP_MANAGEMENT_URL].value" '"http://telflo-opamp-server-management:51235"' &&
    eq "$L" "$API_C.env[TELFLO_OPAMP_AGENT_PUBLIC_URL].value" '"https://opamp.example.com/opamp/api/v1"' &&
    eq "$L" "$API_C.env[TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS].value" '"false"' &&
    eq "$L" "$API_C.env[TELFLO_OTELCOL_VALIDATOR_URL].value" '"http://otelcol-validator:8001"' &&
    eq "$L" "$API_C.env[TELFLO_OTELCOL_TESTING_URL].value" '"http://otelcol-testing:8002"' &&
    eq "$L" "$API_C.env[TELFLO_OTTL_EVALUATOR_URL].value" '"http://ottl-evaluator:8003"' &&
    eq "$L" "$API_C.env[TELFLO_FILE_STORE].value" '"local"' &&
    eq "$L" "$API_C.env[TELFLO_FILE_STORE_ROOT].value" '"/var/lib/telflo/file-store"'
}
run_case "API env values, default: the composed telflo_platform URL, port 8080, publicUrl twice, SMTP, 24 hours, 1 hop, the management, agent and internal services' URLs, the local root" api_env_default_values
api_env_other_values() {
  local P S F
  P="$(listing local-file-store)"; S="$(listing s3-file-store)"; F="$(listing full)"
  eq "$P" "$API_C.env[TELFLO_PUBLIC_WEB_URL].value" '"http://localhost:8080"' &&
    eq "$P" "$API_C.env[TELFLO_SMTP_HOST].value" '"mailpit.example.svc"' && eq "$P" "$API_C.env[TELFLO_SMTP_PORT].value" '"1025"' &&
    eq "$P" "$API_C.env[TELFLO_SMTP_ALLOW_INSECURE].value" '"true"' && eq "$P" "$API_C.env[TELFLO_SMTP_TLS].value" '"none"' &&
    eq "$P" "$API_C.env[TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS].value" '"true"' &&
    eq "$P" "$API_C.env[TELFLO_OPAMP_AGENT_PUBLIC_URL].value" '"http://telflo-opamp-server-agent:51234/opamp/api/v1"' &&
    eq "$S" "$API_C.env[TELFLO_FILE_STORE].value" '"s3"' && eq "$S" "$API_C.env[TELFLO_FILE_STORE_BUCKET].value" '"telflo-files"' &&
    eq "$S" "$API_C.env[TELFLO_FILE_STORE_PREFIX].value" '"platform/"' && eq "$S" "$API_C.env[TELFLO_FILE_STORE_S3_REGION].value" '"region-a"' &&
    eq "$S" "$API_C.env[TELFLO_FILE_STORE_S3_ENDPOINT].value" '"https://objects.example.com"' &&
    eq "$S" "$API_C.env[TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE].value" '"true"' &&
    eq "$F" "$API_C.env[TELFLO_MAIL_TRANSPORT].value" '"sendgrid"' && eq "$F" "$API_C.env[TELFLO_VERIFICATION_TOKEN_TTL_HOURS].value" '"48"' &&
    eq "$F" "$API_C.env[TELFLO_TRUST_PROXY_HOPS].value" '"2"' && eq "$F" "$API_C.env[TELFLO_SALES_INQUIRY_TO].value" '"sales@telflo.example.com"' &&
    eq "$F" "$API_C.env[TELFLO_FILE_STORE_PREFIX].value" '"full"' && eq "$F" "$API_C.env[TELFLO_FILE_STORE_S3_REGION].value" '"region-b"' &&
    eq "$F" "$API_C.env[TELFLO_FILE_STORE_S3_ENDPOINT].value" '"http://objects.example.com:9000"'
}
run_case "API env values follow api.* (local-file-store, s3-file-store, full)" api_env_other_values
# A value from values is literal: a "$(NAME)" in it can't name another
# variable (each $ doubled, Kubernetes reads $$ as $).
api_env_literal() {
  next_file
  render_flat "$f" "${D[@]}" --set-string 'api.mail.from=a$(TELFLO_API_PASSWORD)@example.com' --set-string 'api.salesInquiryTo=s$(TELFLO_ACCESS_TOKEN_SECRET)@example.com' || return 1
  eq "$f" "$API_C.env[TELFLO_MAIL_FROM].value" '"a$$(TELFLO_API_PASSWORD)@example.com"' &&
    eq "$f" "$API_C.env[TELFLO_SALES_INQUIRY_TO].value" '"s$$(TELFLO_ACCESS_TOKEN_SECRET)@example.com"'
}
run_case "API env: a \$(NAME) in a value is escaped (\$\$), so it can't read another variable" api_env_literal

# Where each credential comes from.
api_keys_default() {
  local want
  want="$(printf '%s\n' telflo-postgres/api-password telflo-api/access-token-secret telflo-opamp-server/management-secret \
    telflo-internal-services/otelcol-validator-secret telflo-internal-services/otelcol-testing-secret telflo-internal-services/ottl-evaluator-secret \
    telflo-api/quick-deploy-encryption-key telflo-api/quick-deploy-previous-encryption-keys telflo-api/library-link-signing-key \
    telflo-api/library-link-signing-keys-previous | sort | tr '\n' ' ')"
  [ "$(api_words secret_keys "$L" "$API_C")" = "$want" ] &&
    eq "$L" "$API_C.env[TELFLO_API_PASSWORD].valueFrom.secretKeyRef.key" '"api-password"' &&
    eq "$L" "$API_C.env[TELFLO_OPAMP_MANAGEMENT_SECRET].valueFrom.secretKeyRef.name" '"telflo-opamp-server"'
}
run_case "API's container reads api-password (never owner-password), the telflo-api keys, the opamp-server's management-secret and the three internal services' secrets" api_keys_default
api_keys_full() {
  local want
  want="$(printf '%s\n' example-postgres/api-password example-api/access-token-secret example-opamp/management-secret \
    example-internal/otelcol-validator-secret example-internal/otelcol-testing-secret example-internal/ottl-evaluator-secret \
    example-api/quick-deploy-encryption-key example-api/quick-deploy-previous-encryption-keys example-api/library-link-signing-key \
    example-api/library-link-signing-keys-previous example-mail/sendgrid-api-key example-oidc/client-id example-oidc/client-secret | sort | tr '\n' ' ')"
  [ "$(api_words secret_keys "$(listing full)" "$API_C")" = "$want" ]
}
run_case "API's Secrets follow existingSecrets.* and opamp-server.auth.existingSecret, with SendGrid's key and Google's client (full)" api_keys_full
api_optional_keys() { # only the two previous keys may be missing
  local opt
  opt="$(awk -v p="$API_C.env[" 'index($0, p) == 1 && $1 ~ /\.valueFrom\.secretKeyRef\.optional$/ { v = $1; sub(/^.*\.env\[/, "", v); sub(/\].*$/, "", v); print v " " $2 }' "$1" | sort | tr '\n' ' ')"
  [ "$opt" = "TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS true TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS true " ]
}
each_profile "API env: only the two previous keys are optional" api_optional_keys

# --- the migrate init container ---------------------------------------------------------
api_migrate_env() {
  [ "$(api_words env_names "$1" "$API_M")" = "TELFLO_OWNER_PASSWORD TELFLO_API_PASSWORD TELFLO_MIGRATION_DATABASE_URL TELFLO_DATABASE_URL " ] &&
    no_path "$1" "$API_M.envFrom" &&
    eq "$1" "$API_M.env[TELFLO_MIGRATION_DATABASE_URL].value" '"postgresql://telflo_platform_owner:$(TELFLO_OWNER_PASSWORD)@telflo-postgres:5432/telflo_platform"' &&
    eq "$1" "$API_M.env[TELFLO_DATABASE_URL].value" '"postgresql://telflo_platform:$(TELFLO_API_PASSWORD)@telflo-postgres:5432/telflo_platform"'
}
each_profile "migrate env: exactly both passwords, then the owner's and the API's URLs composed from them (no TSX_DISABLE_CACHE: the image is compiled)" api_migrate_env
api_migrate_keys() {
  [ "$(api_words secret_keys "$L" "$API_M")" = "$(printf '%s\n' telflo-postgres/owner-password telflo-postgres/api-password | sort | tr '\n' ' ')" ] &&
    [ "$(api_words secret_keys "$(listing full)" "$API_M")" = "$(printf '%s\n' example-postgres/owner-password example-postgres/api-password | sort | tr '\n' ' ')" ]
}
run_case "migrate reads only owner-password and api-password from existingSecrets.postgres" api_migrate_keys
api_migrate_only_one() { # the only init container; it mounts nothing and has no probe or port
  eq "$1" "$API_POD.initContainers[migrate]#index" 0 && no_path "$1" "$API_POD.initContainers[1]" &&
    no_path "$1" "$API_M.volumeMounts" && no_path "$1" "$API_M.ports" && no_path "$1" "$API_M.readinessProbe" &&
    eq "$1" "$API_POD.containers[api]#index" 0 && no_path "$1" "$API_POD.containers[1]"
}
each_profile "API: one init container, migrate (nothing mounted), and one container, api" api_migrate_only_one

# The owner's URL (and its password) only in the migrate init container: no
# other container of the platform's, the API's own included, ever holds it.
api_owner_url_only_in_migrate() {
  # (only_at names a file by its canary, which can't hold a /.)
  local at
  at="$(awk 'index($0, "postgresql://telflo_platform_owner:") { print $1 }' "$1")"
  [ "$at" = "$API_M.env[TELFLO_MIGRATION_DATABASE_URL].value" ] &&
    [ "$(grep -cF 'postgresql://telflo_platform_owner:' "$1.yaml")" = 1 ] &&
    ! awk '$1 ~ /\.env\[(TELFLO_MIGRATION_DATABASE_URL|TELFLO_OWNER_PASSWORD)\]/ { print $1 }' "$1" |
      grep -vE '^(Deployment/telflo-api\.spec\.template\.spec\.initContainers\[migrate\]|StatefulSet/telflo-postgres\.spec\.template\.spec\.containers\[postgres\])\.env\[' |
      grep -q . &&
    ! secret_keys "$1" "$API_C" | grep -q '/owner-password$' || return 1
  case "$(value "$1" "$API_C.command[2]")" in *TELFLO_OWNER_PASSWORD*) return 1 ;; esac
}
each_profile "API: the owner's database URL and owner-password only in the migrate init container (Postgres holds the password for its bootstrap), never the API's container" api_owner_url_only_in_migrate

# --- probes ------------------------------------------------------------------------
api_probes() {
  eq "$1" "$API_C.readinessProbe.httpGet.path" '"/health"' && eq "$1" "$API_C.readinessProbe.httpGet.port" '"http"' &&
    no_path "$1" "$API_C.readinessProbe.httpGet.scheme" && no_path "$1" "$API_C.readinessProbe.httpGet.httpHeaders" &&
    eq "$1" "$API_C.livenessProbe.tcpSocket.port" '"http"' && no_path "$1" "$API_C.livenessProbe.httpGet" &&
    no_path "$1" "$API_C.livenessProbe.exec" &&
    eq "$1" "$API_C.startupProbe.tcpSocket.port" '"http"' && no_path "$1" "$API_C.startupProbe.httpGet" &&
    no_path "$1" "$API_C.readinessProbe.exec" && no_path "$1" "$API_C.readinessProbe.tcpSocket"
}
each_profile "API probes: readiness GET /health exactly (silent, the database check), liveness and startup TCP on 8080 (no request, never the database)" api_probes

# --- the pod's settings ---------------------------------------------------------------
api_security() {
  local c
  eq "$1" "$API_POD.automountServiceAccountToken" false && eq "$1" "$API_POD.enableServiceLinks" false &&
    eq "$1" "$API_POD.serviceAccountName" '"telflo-api"' &&
    eq "$1" "$API_POD.securityContext.runAsNonRoot" true && eq "$1" "$API_POD.securityContext.runAsUser" 1000 &&
    eq "$1" "$API_POD.securityContext.runAsGroup" 1000 && eq "$1" "$API_POD.securityContext.seccompProfile.type" '"RuntimeDefault"' &&
    no_path "$1" "$API_POD.securityContext.sysctls" && no_path "$1" "$API_POD.hostNetwork" || return 1
  if api_local "$1"; then eq "$1" "$API_POD.securityContext.fsGroup" 1000 || return 1
  else no_path "$1" "$API_POD.securityContext.fsGroup" || return 1; fi
  for c in "$API_C" "$API_M"; do
    eq "$1" "$c.securityContext.allowPrivilegeEscalation" false && eq "$1" "$c.securityContext.readOnlyRootFilesystem" true &&
      eq "$1" "$c.securityContext.runAsNonRoot" true && eq "$1" "$c.securityContext.runAsUser" 1000 &&
      eq "$1" "$c.securityContext.runAsGroup" 1000 &&
      eq "$1" "$c.securityContext.capabilities.drop[0]" '"ALL"' && no_path "$1" "$c.securityContext.capabilities.drop[1]" &&
      no_path "$1" "$c.securityContext.capabilities.add" && no_path "$1" "$c.securityContext.privileged" &&
      eq "$1" "$c.securityContext.seccompProfile.type" '"RuntimeDefault"' || return 1
  done
}
each_profile "API: both containers uid and gid 1000, non-root, read-only root, ALL dropped, no escalation, RuntimeDefault; fsGroup 1000 only with the local file store; no token, no service links" api_security
api_volumes() {
  eq "$1" "$API_C.volumeMounts[tmp].mountPath" '"/tmp"' && eq "$1" "$API_POD.volumes[tmp].emptyDir.sizeLimit" '"64Mi"' || return 1
  if api_local "$1"; then
    eq "$1" "$API_C.volumeMounts[file-store].mountPath" '"/var/lib/telflo/file-store"' &&
      no_path "$1" "$API_C.volumeMounts[file-store].readOnly" &&
      eq "$1" "$API_POD.volumes[file-store].persistentVolumeClaim.claimName" '"telflo-api-file-store"' &&
      eq "$1" "$API_C.env[TELFLO_FILE_STORE_ROOT].value" '"/var/lib/telflo/file-store"' &&
      [ "$(api_words names_at "$1" "$API_C.volumeMounts")" = "tmp file-store $ca" ] &&
      [ "$(api_words names_at "$1" "$API_POD.volumes")" = "tmp file-store $ca" ]
  else
    [ "$(api_words names_at "$1" "$API_C.volumeMounts")" = "tmp $ca" ] && [ "$(api_words names_at "$1" "$API_POD.volumes")" = "tmp $ca" ]
  fi
}
# smtp-ca only with api.mail.smtp.caSecret (the saas profile; site.sh checks it).
api_volumes_ca() { local ca=""; if [ -n "$(value "$1" "$API_C.env[TELFLO_SMTP_CA_FILE].value")" ]; then ca="smtp-ca "; fi; api_volumes "$1"; }
each_profile "API volumes: /tmp a 64Mi emptyDir; with the local file store its claim at TELFLO_FILE_STORE_ROOT, with S3 nothing more; smtp-ca only with the mail's CA" api_volumes_ca
api_claim() {
  eq "$L" "$API_PVC.spec.accessModes[0]" '"ReadWriteOnce"' && no_path "$L" "$API_PVC.spec.accessModes[1]" &&
    eq "$L" "$API_PVC.spec.resources.requests.storage" '"8Gi"' && no_path "$L" "$API_PVC.spec.storageClassName" &&
    eq "$(listing local-file-store)" "$API_PVC.spec.storageClassName" '"standard"' &&
    eq "$(listing local-file-store)" "$API_PVC.spec.resources.requests.storage" '"2Gi"' &&
    eq "$L" "$API_PVC.metadata.labels.app.kubernetes.io/component" '"api"'
}
run_case "API claim: ReadWriteOnce, 8Gi in the default class; api.fileStore.storageClassName and size set it (local-file-store)" api_claim
# `helm uninstall` leaves the claim, as it leaves Postgres's (the
# database names its files): Helm's own resource policy, its only annotation.
api_claim_kept() {
  api_local "$1" || return 0
  eq "$1" "$API_PVC.metadata.annotations.helm.sh/resource-policy" '"keep"' &&
    [ "$(awk -v p="$API_PVC.metadata.annotations." 'index($0, p) == 1' "$1" | wc -l | tr -d ' ')" = 1 ]
}
each_profile "API claim: helm.sh/resource-policy keep, its only annotation, so helm uninstall leaves the local file store's files" api_claim_kept
api_replicas() {
  eq "$L" "$API_D.spec.replicas" 1 && eq "$L" "$API_D.spec.strategy.type" '"Recreate"' && no_path "$L" "$API_D.spec.strategy.rollingUpdate" &&
    eq "$(listing s3-file-store)" "$API_D.spec.replicas" 2 && eq "$(listing s3-file-store)" "$API_D.spec.strategy.type" '"RollingUpdate"' &&
    eq "$(listing s3-file-store)" "$API_D.spec.strategy.rollingUpdate.maxUnavailable" 0 &&
    eq "$(listing full)" "$API_D.spec.replicas" 3
}
run_case "API: one replica, Recreate, with the local file store (its volume moves pod to pod); api.replicas and a rolling update with S3" api_replicas
api_service_account() {
  eq "$L" "$API_SA.automountServiceAccountToken" false && no_path "$L" "$API_SA.metadata.annotations" &&
    eq "$(listing s3-file-store)" "$API_SA.metadata.annotations.example.com/bucket-role" '"telflo-files"' &&
    eq "$(listing full)" "$API_SA.metadata.annotations.example.com/identity" '"telflo-api"' &&
    eq "$L" "$API_SA.metadata.labels.app.kubernetes.io/component" '"api"'
}
run_case "API ServiceAccount: its token never mounted, api.serviceAccount.annotations on it (none by default)" api_service_account
api_full_values() {
  local F; F="$(listing full)"
  eq "$F" "$API_C.resources.requests.cpu" '"200m"' && eq "$F" "$API_C.resources.limits.memory" '"1Gi"' &&
    eq "$F" "$API_M.resources.limits.memory" '"1Gi"' &&
    eq "$F" "$API_POD.nodeSelector.example.com/pool" '"platform"' && eq "$F" "$API_POD.tolerations[0].key" '"example.com/dedicated"' &&
    eq "$F" "$API_POD.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key" '"example.com/pool"' &&
    eq "$F" "$API_D.spec.template.metadata.annotations.example.com/scrape" '"true"' &&
    [ "$(api_words names_at "$F" "$API_POD.imagePullSecrets")" = "registry-pull registry-pull-mirror " ] &&
    eq "$L" "$API_C.resources.requests.memory" '"256Mi"' && no_path "$L" "$API_C.resources.limits" &&
    no_path "$L" "$API_POD.nodeSelector" && no_path "$L" "$API_POD.tolerations" && no_path "$L" "$API_POD.affinity" &&
    no_path "$L" "$API_D.spec.template.metadata.annotations" &&
    no_path "$L" "$API_POD.imagePullSecrets"
}
run_case "API: resources (both containers), scheduling, podAnnotations and pull secrets from values (requests only by default)" api_full_values

# --- no secret value in any rendered output (the API, the web app, the gateway) -----------
# Values carry Secret names only, so a secret can reach a manifest only by a
# template writing one. Every credential the three take is a secretKeyRef
# (never a value), and every URL with a user part composes its password with
# $(VAR). (TELFLO_POSTHOG_KEY is a project's public key, sent to every
# browser.)
no_secret_values() {
  local bad
  # a credential's variable holds no value of its own, and reads a Secret
  bad="$(awk '$1 ~ /^Deployment\/telflo-(api|web|gateway)\.spec\.template\.spec\.(initContainers|containers)\[[^]]*\]\.env\[[^]]*\]#index$/ {
      v = $1; sub(/#index$/, "", v); n = v; sub(/^.*\.env\[/, "", n); sub(/\]$/, "", n)
      if (n ~ /(SECRET|PASSWORD|_KEY$|_KEYS|CLIENT_ID)/ && n != "TELFLO_POSTHOG_KEY") print v }' "$1")"
  [ -n "$bad" ] || return 1
  while IFS= read -r v; do
    no_path "$1" "$v.value" && [ -n "$(value "$1" "$v.valueFrom.secretKeyRef.key")" ] || return 1
  done <<EOF
$bad
EOF
  # every user part in the rendered manifests is <role>:$(<VARIABLE>)
  ! grep -oE '://[^/@" ]+@' "$1.yaml" | grep -vqE '^://[a-z_]+:\$\([A-Z_]+\)@$' &&
    grep -qF 'postgresql://telflo_platform:$(TELFLO_API_PASSWORD)@' "$1.yaml" &&
    ! grep -E '^Deployment/telflo-(api|web|gateway)\.' "$1" | grep -q '\.envFrom'
}
each_profile "no secret value rendered: every credential of the API, web and gateway a secretKeyRef, every URL's password a \$(VAR)" no_secret_values
