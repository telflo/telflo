# The web app. Sourced by tests/render-tests.sh, which defines every helper
# used here (api_words is api.sh's).

WEB_D="Deployment/telflo-web"
WEB_POD="$WEB_D.spec.template.spec"
WEB_C="$WEB_POD.containers[web]"
WEB_SVC="Service/telflo-web"

web_kinds() {
  local k; k="$(kinds "$1")"
  printf '%s\n' "$k" | grep -qx "$WEB_SVC" && printf '%s\n' "$k" | grep -qx "$WEB_D" &&
    ! printf '%s\n' "$k" | grep -qx 'ServiceAccount/telflo-web' && ! printf '%s\n' "$k" | grep -qx 'ConfigMap/telflo-web'
}
each_profile "web: its Service and Deployment telflo-web (nothing more)" web_kinds
web_service() {
  local s
  eq "$1" "$WEB_SVC.spec.type" '"ClusterIP"' && eq "$1" "$WEB_SVC.spec.ports[http].port" 3000 &&
    eq "$1" "$WEB_SVC.spec.ports[http].targetPort" '"http"' && no_path "$1" "$WEB_SVC.spec.ports[1]" &&
    eq "$1" "$WEB_C.ports[http].containerPort" 3000 && no_path "$1" "$WEB_C.ports[1]" || return 1
  for s in "$WEB_D.spec.template.metadata.labels" "$WEB_D.spec.selector.matchLabels" "$WEB_SVC.spec.selector"; do
    eq "$1" "$s.app.kubernetes.io/name" '"telflo"' && eq "$1" "$s.app.kubernetes.io/component" '"web"' &&
      eq "$1" "$s.app.kubernetes.io/instance" "\"$REL\"" || return 1
  done
}
each_profile "web: Service telflo-web, ClusterIP, port 3000 to the container's 3000, selecting component web" web_service

web_image() {
  eq "$L" "$WEB_C.image" "\"ghcr.io/telflo/telflo/web:$CHART_VERSION\"" && eq "$L" "$WEB_C.imagePullPolicy" '"IfNotPresent"' &&
    eq "$(listing full)" "$WEB_C.image" '"registry.example.com:5000/telflo/web:mirror-test@sha256:2222222222222222222222222222222222222222222222222222222222222222"' &&
    eq "$(listing full)" "$WEB_C.imagePullPolicy" '"Always"'
}
run_case "web: ghcr.io/telflo/telflo/web at the appVersion by default; image.registry and web.image (full)" web_image
# The image's own command, PORT and NODE_ENV (telflo-core/Dockerfile's web stage).
web_command() {
  local stage
  stage="$(awk '/^FROM .* AS web$/ { on = 1; next } /^FROM / { on = 0 } on' "$REPO_DIR/telflo-core/Dockerfile")"
  printf '%s\n' "$stage" | grep -qxF 'CMD ["node", "server.mjs"]' && printf '%s\n' "$stage" | grep -qxF 'ENV NODE_ENV=production PORT=3000' &&
    printf '%s\n' "$stage" | grep -qxF 'USER 1000:1000' &&
    no_path "$1" "$WEB_C.command" && no_path "$1" "$WEB_C.args" && no_path "$1" "$WEB_C.workingDir"
}
each_profile "web: the image's own command (node server.mjs), PORT 3000 and uid 1000, as telflo-core/Dockerfile's web stage has them" web_command

web_env() {
  [ "$(api_words env_names "$L" "$WEB_C")" = "TELFLO_API_INTERNAL_URL TELFLO_PUBLIC_WEB_URL $SITE_ENV " ] &&
    eq "$L" "$WEB_C.env[TELFLO_API_INTERNAL_URL].value" '"http://telflo-api:8080"' &&
    eq "$L" "$WEB_C.env[TELFLO_PUBLIC_WEB_URL].value" '"https://telflo.example.com"' &&
    eq "$(listing local-file-store)" "$WEB_C.env[TELFLO_PUBLIC_WEB_URL].value" '"http://localhost:8080"'
}
run_case "web env, default: exactly TELFLO_API_INTERNAL_URL (telflo-api:8080), TELFLO_PUBLIC_WEB_URL (publicUrl) and the site's fourteen; no analytics" web_env
web_env_full() {
  local F; F="$(listing full)"
  [ "$(api_words env_names "$F" "$WEB_C")" = "TELFLO_API_INTERNAL_URL TELFLO_PUBLIC_WEB_URL $SITE_ENV TELFLO_POSTHOG_KEY TELFLO_POSTHOG_HOST " ] &&
    eq "$F" "$WEB_C.env[TELFLO_POSTHOG_KEY].value" '"phc_example"' &&
    eq "$F" "$WEB_C.env[TELFLO_POSTHOG_HOST].value" '"https://analytics.example.com"'
}
run_case "web env, full: web.posthog's key and host added" web_env_full
web_api_url_matches() { # the URL is the API's Service, on its port
  eq "$1" "Service/telflo-api.spec.ports[http].port" 8080 && eq "$1" "$WEB_C.env[TELFLO_API_INTERNAL_URL].value" '"http://telflo-api:8080"'
}
each_profile "web: TELFLO_API_INTERNAL_URL names the API's Service and port" web_api_url_matches
web_no_credential() { # the web holds no credential and mounts nothing
  [ -z "$(secret_keys "$1" "$WEB_C")" ] && ! grep -F "$WEB_C.env[" "$1" | grep -q '\.valueFrom' &&
    no_path "$1" "$WEB_C.envFrom" && no_path "$1" "$WEB_C.volumeMounts" && no_path "$1" "$WEB_POD.volumes" &&
    no_path "$1" "$WEB_POD.initContainers" && no_path "$1" "$WEB_POD.containers[1]" && no_path "$1" "$WEB_POD.serviceAccountName"
}
each_profile "web: no Secret read, no volume (its read-only root is all it needs), one container" web_no_credential

# A static file the server answers before its handler: no log line, no call
# to the API. public/favicon.ico is it.
web_probes() {
  local p
  [ -f "$REPO_DIR/telflo-core/apps/web/public/favicon.ico" ] || return 1
  for p in readinessProbe livenessProbe; do
    eq "$1" "$WEB_C.$p.httpGet.path" '"/favicon.ico"' && eq "$1" "$WEB_C.$p.httpGet.port" '"http"' &&
      no_path "$1" "$WEB_C.$p.exec" && no_path "$1" "$WEB_C.$p.tcpSocket" || return 1
  done
}
each_profile "web probes: readiness and liveness GET /favicon.ico (public/, served before the handler: no log line, no API call)" web_probes

web_security() {
  eq "$1" "$WEB_POD.automountServiceAccountToken" false && eq "$1" "$WEB_POD.enableServiceLinks" false &&
    eq "$1" "$WEB_POD.securityContext.runAsNonRoot" true && eq "$1" "$WEB_POD.securityContext.runAsUser" 1000 &&
    eq "$1" "$WEB_POD.securityContext.runAsGroup" 1000 && no_path "$1" "$WEB_POD.securityContext.fsGroup" &&
    eq "$1" "$WEB_POD.securityContext.seccompProfile.type" '"RuntimeDefault"' && no_path "$1" "$WEB_POD.securityContext.sysctls" &&
    eq "$1" "$WEB_C.securityContext.allowPrivilegeEscalation" false && eq "$1" "$WEB_C.securityContext.readOnlyRootFilesystem" true &&
    eq "$1" "$WEB_C.securityContext.runAsNonRoot" true && eq "$1" "$WEB_C.securityContext.runAsUser" 1000 &&
    eq "$1" "$WEB_C.securityContext.runAsGroup" 1000 &&
    eq "$1" "$WEB_C.securityContext.capabilities.drop[0]" '"ALL"' && no_path "$1" "$WEB_C.securityContext.capabilities.drop[1]" &&
    no_path "$1" "$WEB_C.securityContext.capabilities.add" && no_path "$1" "$WEB_C.securityContext.privileged" &&
    eq "$1" "$WEB_C.securityContext.seccompProfile.type" '"RuntimeDefault"' && no_path "$1" "$WEB_POD.hostNetwork"
}
each_profile "web: uid and gid 1000, non-root, read-only root, ALL dropped, no escalation, RuntimeDefault, no token, no service links" web_security
web_full_values() {
  local F; F="$(listing full)"
  eq "$F" "$WEB_D.spec.replicas" 2 && eq "$L" "$WEB_D.spec.replicas" 1 &&
    eq "$F" "$WEB_C.resources.requests.memory" '"256Mi"' && eq "$L" "$WEB_C.resources.requests.memory" '"128Mi"' &&
    no_path "$L" "$WEB_C.resources.limits" &&
    eq "$F" "$WEB_POD.nodeSelector.example.com/pool" '"platform"' && eq "$F" "$WEB_POD.tolerations[0].operator" '"Exists"' &&
    no_path "$F" "$WEB_POD.affinity" && eq "$F" "$WEB_D.spec.template.metadata.annotations.example.com/web" '"yes"' &&
    no_path "$L" "$WEB_D.spec.template.metadata.annotations" && no_path "$L" "$WEB_POD.nodeSelector" &&
    [ "$(api_words names_at "$F" "$WEB_POD.imagePullSecrets")" = "registry-pull registry-pull-mirror " ] &&
    no_path "$L" "$WEB_POD.imagePullSecrets" &&
    eq "$L" "$WEB_D.spec.strategy.rollingUpdate.maxUnavailable" 0
}
run_case "web: replicas, resources, scheduling, podAnnotations and pull secrets from values (full); a rolling update" web_full_values
