# The internal services: the collector validator, the collector tester and
# the OTTL evaluator. Sourced by tests/render-tests.sh, which defines
# every helper used here.
#
# What matters most: the tester's and the evaluator's secrets reach them
# ONLY as files (the tester refuses to start with its secret, or any value
# containing it, in its environment: services/otelcol-testing/app/
# settings.py), no pod mounts a service-account token (the validator's
# image bakes a fake one at that path), and every container runs locked
# down.

# <component> <container port>: the three, as their Deployment, Service and
# container are named.
IS_ALL="otelcol-validator:8001 otelcol-testing:8002 ottl-evaluator:8003"
is_pod() { printf 'Deployment/%s.spec.template.spec' "$1"; }
is_c() { printf 'Deployment/%s.spec.template.spec.containers[%s]' "$1" "$1"; }

is_kinds() {
  local k e n; k="$(kinds "$1")"
  for e in $IS_ALL; do
    n="${e%%:*}"
    printf '%s\n' "$k" | grep -qx "Deployment/$n" && printf '%s\n' "$k" | grep -qx "Service/$n" || return 1
  done
}
each_profile "internal services: a Deployment and a Service each (otelcol-validator, otelcol-testing, ottl-evaluator)" is_kinds

is_services() {
  local e n port s
  for e in $IS_ALL; do
    n="${e%%:*}"; port="${e##*:}"; s="Service/$n"
    eq "$1" "$s.spec.type" '"ClusterIP"' && eq "$1" "$s.spec.ports[http].port" "$port" &&
      eq "$1" "$s.spec.ports[http].targetPort" '"http"' && eq "$1" "$s.spec.ports[http].protocol" '"TCP"' &&
      no_path "$1" "$s.spec.ports[1]" && [ "$(names_at "$1" "$s.spec.ports")" = http ] &&
      eq "$1" "$(is_c "$n").ports[http].containerPort" "$port" && [ "$(names_at "$1" "$(is_c "$n").ports")" = http ] || return 1
  done
}
each_profile "internal services: ClusterIP Services on 8001, 8002 and 8003, each the container's one port" is_services

# The URLs the API is given (from _helpers.tpl) name these Services and ports.
is_urls_match() {
  local h="$CHART_DIR/templates/_helpers.tpl"
  grep -qxF '{{- define "telflo.validatorUrl" -}}http://otelcol-validator:8001{{- end }}' "$h" &&
    grep -qxF '{{- define "telflo.testerUrl" -}}http://otelcol-testing:8002{{- end }}' "$h" &&
    grep -qxF '{{- define "telflo.evaluatorUrl" -}}http://ottl-evaluator:8003{{- end }}' "$h"
}
run_case "internal services: the API's URLs for them (the helpers) name these Services and ports" is_urls_match

is_selectors() {
  local e n s
  for e in $IS_ALL; do
    n="${e%%:*}"
    for s in "Service/$n.spec.selector" "Deployment/$n.spec.selector.matchLabels" "Deployment/$n.spec.template.metadata.labels"; do
      eq "$1" "$s.app.kubernetes.io/name" '"telflo"' && eq "$1" "$s.app.kubernetes.io/instance" "\"$REL\"" &&
        eq "$1" "$s.app.kubernetes.io/component" "\"$n\"" || return 1
    done
    no_path "$1" "Service/$n.spec.selector.helm.sh/chart" && no_path "$1" "Deployment/$n.spec.selector.matchLabels.app.kubernetes.io/version" || return 1
  done
}
each_profile "internal services: Services and Deployments select name telflo, the release, their component" is_selectors

# --- images -------------------------------------------------------------------
is_images_default() {
  eq "$L" "$(is_c otelcol-validator).image" "\"ghcr.io/telflo/telflo/otelcol-validator:$CHART_VERSION\"" &&
    eq "$L" "$(is_c otelcol-testing).image" "\"ghcr.io/telflo/telflo/otelcol-testing:$CHART_VERSION\"" &&
    eq "$L" "$(is_c ottl-evaluator).image" "\"ghcr.io/telflo/telflo/ottl-evaluator:$CHART_VERSION\"" &&
    eq "$L" "$(is_c otelcol-validator).imagePullPolicy" '"IfNotPresent"' &&
    eq "$L" "$(is_c otelcol-testing).imagePullPolicy" '"IfNotPresent"' &&
    eq "$L" "$(is_c ottl-evaluator).imagePullPolicy" '"IfNotPresent"'
}
run_case "internal services: images ghcr.io/telflo/telflo/<name>:<appVersion>, IfNotPresent" is_images_default
is_images_full() {
  local F; F="$(listing full)"
  eq "$F" "$(is_c otelcol-validator).image" "\"registry.example.com:5000/telflo/otelcol-validator:$CHART_VERSION@sha256:3333333333333333333333333333333333333333333333333333333333333333\"" &&
    eq "$F" "$(is_c otelcol-testing).image" "\"registry.example.com:5000/telflo/otelcol-testing:$CHART_VERSION@sha256:4444444444444444444444444444444444444444444444444444444444444444\"" &&
    eq "$F" "$(is_c ottl-evaluator).image" "\"registry.example.com:5000/telflo/ottl-evaluator:$CHART_VERSION@sha256:5555555555555555555555555555555555555555555555555555555555555555\"" &&
    eq "$F" "$(is_c otelcol-testing).imagePullPolicy" '"Always"'
}
run_case "internal services: image.registry, a digest and image.pullPolicy (full)" is_images_full
is_image_own() {
  next_file
  render_flat "$f" "${D[@]}" --set-string otelcolTesting.image.registry=registry.example.com/local \
    --set-string otelcolTesting.image.tag=dev --set-string otelcolTesting.image.pullPolicy=Never || return 1
  eq "$f" "$(is_c otelcol-testing).image" '"registry.example.com/local/otelcol-testing:dev"' &&
    eq "$f" "$(is_c otelcol-testing).imagePullPolicy" '"Never"'
}
run_case "internal services: a component's own registry, tag and pullPolicy win" is_image_own

# --- the secrets --------------------------------------------------------------
# The validator: its own key only, from secretKeyRef, as it reads it.
is_validator_env() {
  local c secret; c="$(is_c otelcol-validator)"
  secret=telflo-internal-services; [ "$(basename "$1")" = full ] && secret=example-internal
  [ "$(env_names "$1" "$c" | tr '\n' ' ')" = "OTELCOL_VALIDATOR_SECRET " ] &&
    [ "$(secret_keys "$1" "$c")" = "$secret/otelcol-validator-secret" ] &&
    no_path "$1" "$c.env[OTELCOL_VALIDATOR_SECRET].value" && no_path "$1" "$c.env[OTELCOL_VALIDATOR_SECRET].valueFrom.secretKeyRef.optional" &&
    no_path "$1" "$c.envFrom" && no_path "$1" "$(is_pod otelcol-validator).initContainers" &&
    [ "$(names_at "$1" "$(is_pod otelcol-validator).containers")" = otelcol-validator ]
}
each_profile "validator: OTELCOL_VALIDATOR_SECRET only, from its own key (otelcol-validator-secret) by secretKeyRef" is_validator_env

# file_only <listing> <component> <key> <variable> <other variables...>: the
# container's environment is exactly <variable> and the others, none from a
# Secret (no valueFrom at all, no envFrom), the variable naming the projected
# item's path; the item is <key> of existingSecrets.internalServices, mode
# 0440; and the pod has no other container and no init container.
file_only() {
  local l="$1" n="$2" key="$3" var="$4"; shift 4
  local pod c secret want
  pod="$(is_pod "$n")"; c="$(is_c "$n")"
  secret='"telflo-internal-services"'; [ "$(basename "$l")" = full ] && secret='"example-internal"'
  want="$var"; for v in "$@"; do want="$want $v"; done
  [ "$(env_names "$l" "$c" | tr '\n' ' ' | sed 's/ $//')" = "$want" ] || return 1
  ! awk -v p="$c.env[" 'index($0, p) == 1' "$l" | grep -qF '.valueFrom' || return 1
  no_path "$l" "$c.envFrom" && no_path "$l" "$pod.initContainers" && [ "$(names_at "$l" "$pod.containers")" = "$n" ] &&
    eq "$l" "$c.env[$var].value" "\"/run/secrets/telflo/$key\"" &&
    eq "$l" "$c.volumeMounts[secret].mountPath" '"/run/secrets/telflo"' && eq "$l" "$c.volumeMounts[secret].readOnly" true &&
    eq "$l" "$pod.volumes[secret].projected.sources[0].secret.name" "$secret" &&
    no_path "$l" "$pod.volumes[secret].projected.sources[1]" &&
    eq "$l" "$pod.volumes[secret].projected.sources[0].secret.items[0].key" "\"$key\"" &&
    eq "$l" "$pod.volumes[secret].projected.sources[0].secret.items[0].path" "\"$key\"" &&
    eq "$l" "$pod.volumes[secret].projected.sources[0].secret.items[0].mode" 288 &&
    no_path "$l" "$pod.volumes[secret].projected.sources[0].secret.items[1]" &&
    no_path "$l" "$pod.volumes[secret].projected.sources[0].secret.optional"
}
tester_file_only() { file_only "$1" otelcol-testing otelcol-testing-secret OTELCOL_TESTING_SECRET_FILE; }
each_profile "tester: its secret ONLY as a file (OTELCOL_TESTING_SECRET_FILE -> a projected otelcol-testing-secret, mode 0440); no variable from a Secret" tester_file_only
evaluator_file_only() { file_only "$1" ottl-evaluator ottl-evaluator-secret OTTL_EVALUATOR_SECRET_FILE GOMAXPROCS; }
each_profile "evaluator: its secret ONLY as a file (OTTL_EVALUATOR_SECRET_FILE -> a projected ottl-evaluator-secret, mode 0440); no variable from a Secret" evaluator_file_only
# Anywhere in the tester's or evaluator's Deployment: no secretKeyRef, no
# envFrom, no secretRef (only the projected volume names the Secret).
no_secret_env_anywhere() {
  local n
  for n in otelcol-testing ottl-evaluator; do
    grep -qF "Deployment/$n." "$1" || return 1
    ! grep -F "Deployment/$n." "$1" | awk '{ print $1 }' | grep -qE 'secretKeyRef|envFrom|secretRef' || return 1
  done
}
each_profile "tester and evaluator: nothing in their Deployments is a secretKeyRef, envFrom or secretRef" no_secret_env_anywhere
# Each service reads only its own key; the API reads all three.
own_key_only() {
  local keys
  keys="$(awk '$1 ~ /^Deployment\/(otelcol-validator|otelcol-testing|ottl-evaluator)\.spec\.template\.spec\.volumes\[[^]]*\]\.projected\.sources\[[0-9]+\]\.secret\.items\[[0-9]+\]\.key$/ { print $2 }' "$1" | sort | tr '\n' ' ')"
  [ "$keys" = '"ottl-evaluator-secret" "otelcol-testing-secret" ' ] || [ "$keys" = '"otelcol-testing-secret" "ottl-evaluator-secret" ' ] || return 1
  [ "$(secret_keys "$1" "$(is_c otelcol-validator)" | sed 's/^.*\///')" = otelcol-validator-secret ]
}
each_profile "internal services: each reads only its own key of the Secret" own_key_only
evaluator_gomaxprocs() { eq "$1" "$(is_c ottl-evaluator).env[GOMAXPROCS].value" '"4"'; }
each_profile "evaluator: GOMAXPROCS \"4\"" evaluator_gomaxprocs
# No secret's value rendered: compose's committed development secrets, the
# ones the services would hold, never appear in any rendering.
no_dev_secret() { ! grep -qiE 'development-only|not-for-production' "$1.yaml"; }
each_profile "no development secret's value rendered (development-only, not-for-production)" no_dev_secret

# --- the pods' settings ----------------------------------------------------------
# is_locked <listing> <component> <uid> <fsGroup or "">
is_locked() {
  local l="$1" n="$2" uid="$3" fs="$4" pod c
  pod="$(is_pod "$n")"; c="$(is_c "$n")"
  eq "$l" "$pod.automountServiceAccountToken" false && eq "$l" "$pod.enableServiceLinks" false &&
    no_path "$l" "$pod.serviceAccountName" && no_path "$l" "$pod.hostNetwork" && no_path "$l" "$pod.hostPID" &&
    no_path "$l" "$pod.hostIPC" && no_path "$l" "$pod.shareProcessNamespace" &&
    eq "$l" "$pod.securityContext.runAsNonRoot" true && eq "$l" "$pod.securityContext.runAsUser" "$uid" &&
    eq "$l" "$pod.securityContext.runAsGroup" "$uid" && eq "$l" "$pod.securityContext.seccompProfile.type" '"RuntimeDefault"' &&
    no_path "$l" "$pod.securityContext.sysctls" &&
    { if [ -n "$fs" ]; then eq "$l" "$pod.securityContext.fsGroup" "$fs"; else no_path "$l" "$pod.securityContext.fsGroup"; fi; } &&
    eq "$l" "$c.securityContext.allowPrivilegeEscalation" false && eq "$l" "$c.securityContext.readOnlyRootFilesystem" true &&
    eq "$l" "$c.securityContext.runAsNonRoot" true && eq "$l" "$c.securityContext.runAsUser" "$uid" &&
    eq "$l" "$c.securityContext.runAsGroup" "$uid" &&
    eq "$l" "$c.securityContext.capabilities.drop[0]" '"ALL"' && no_path "$l" "$c.securityContext.capabilities.drop[1]" &&
    no_path "$l" "$c.securityContext.capabilities.add" && no_path "$l" "$c.securityContext.privileged" &&
    eq "$l" "$c.securityContext.seccompProfile.type" '"RuntimeDefault"'
}
locked_validator() { is_locked "$1" otelcol-validator 10001 ""; }
each_profile "validator: no token, no service links; uid and gid 10001, read-only root, ALL dropped, no escalation, RuntimeDefault" locked_validator
locked_tester() { is_locked "$1" otelcol-testing 10001 10001; }
each_profile "tester: no token, no service links; uid, gid and fsGroup 10001, read-only root, ALL dropped, no escalation, RuntimeDefault" locked_tester
locked_evaluator() { is_locked "$1" ottl-evaluator 65532 65532; }
each_profile "evaluator: no token, no service links; uid, gid and fsGroup 65532, read-only root, ALL dropped, no escalation, RuntimeDefault" locked_evaluator

# Every platform pod (whatever template renders it): no token, no service
# links. The vendored chart's pods: no token (its own default).
every_pod_no_token() {
  local pods p n=0
  pods="$(awk '$1 ~ /^(Deployment|StatefulSet)\/[^ ]*\.spec\.template\.metadata\.labels\.app\.kubernetes\.io\/name$/ && $2 == "\"telflo\"" { sub(/\.metadata\.labels\..*$/, "", $1); print $1 }' "$1" | sort -u)"
  for p in $pods; do
    eq "$1" "$p.spec.automountServiceAccountToken" false && eq "$1" "$p.spec.enableServiceLinks" false || return 1
    n=$((n + 1))
  done
  for want in otelcol-validator otelcol-testing ottl-evaluator; do
    printf '%s\n' $pods | grep -qx "Deployment/$want.spec.template" || return 1
  done
  [ "$n" -ge 4 ] && eq "$1" "Deployment/telflo-opamp-server-agent.spec.template.spec.automountServiceAccountToken" false &&
    eq "$1" "Deployment/telflo-opamp-server-management.spec.template.spec.automountServiceAccountToken" false
}
each_profile "every platform pod: automountServiceAccountToken false and no service links; the opamp-server's: no token" every_pod_no_token

# The writable paths: emptyDirs, with their sizes.
is_writable() {
  local v t; v="$(is_pod otelcol-validator)"; t="$(is_pod otelcol-testing)"
  [ "$(names_at "$1" "$v.volumes" | tr '\n' ' ')" = "tmp " ] &&
    eq "$1" "$v.volumes[tmp].emptyDir.sizeLimit" '"256Mi"' && eq "$1" "$(is_c otelcol-validator).volumeMounts[tmp].mountPath" '"/tmp"' &&
    [ "$(names_at "$1" "$(is_c otelcol-validator).volumeMounts" | tr '\n' ' ')" = "tmp " ] &&
    [ "$(names_at "$1" "$t.volumes" | tr '\n' ' ')" = "secret tmp home " ] &&
    eq "$1" "$t.volumes[tmp].emptyDir.sizeLimit" '"1Gi"' && eq "$1" "$t.volumes[home].emptyDir.sizeLimit" '"512Mi"' &&
    no_path "$1" "$t.volumes[tmp].emptyDir.medium" && no_path "$1" "$t.volumes[home].emptyDir.medium" &&
    eq "$1" "$(is_c otelcol-testing).volumeMounts[tmp].mountPath" '"/tmp"' &&
    eq "$1" "$(is_c otelcol-testing).volumeMounts[home].mountPath" '"/home/otelcol-testing"' &&
    [ "$(names_at "$1" "$(is_c otelcol-testing).volumeMounts" | tr '\n' ' ')" = "secret tmp home " ] &&
    [ "$(names_at "$1" "$(is_pod ottl-evaluator).volumes" | tr '\n' ' ')" = "secret " ] &&
    [ "$(names_at "$1" "$(is_c ottl-evaluator).volumeMounts" | tr '\n' ' ')" = "secret " ]
}
each_profile "writable paths: the validator's /tmp (256Mi); the tester's /tmp (1Gi) and home (512Mi); the evaluator none" is_writable

# --- probes ---------------------------------------------------------------------
# probe <listing> <container path> <probe> <path>
probe() { eq "$1" "$2.$3.httpGet.path" "\"$4\"" && eq "$1" "$2.$3.httpGet.port" '"http"' && no_path "$1" "$2.$3.httpGet.host"; }
is_probes() {
  local v t e; v="$(is_c otelcol-validator)"; t="$(is_c otelcol-testing)"; e="$(is_c ottl-evaluator)"
  probe "$1" "$v" readinessProbe /health && probe "$1" "$v" livenessProbe /health && no_path "$1" "$v.startupProbe" &&
    probe "$1" "$t" startupProbe /testing/v1/health && probe "$1" "$t" readinessProbe /testing/v1/health &&
    probe "$1" "$t" livenessProbe /testing/v1/health
}
each_profile "probes: the validator's /health; the tester's /testing/v1/health, startup, readiness and liveness" is_probes
# The evaluator logs every request it serves, /health included (server.go's
# observe), and a probe writes no log line: its probes are TCP on its port,
# and none of its probes makes an HTTP request.
evaluator_tcp_probes() {
  local e p; e="$(is_c ottl-evaluator)"
  for p in readinessProbe livenessProbe; do
    eq "$1" "$e.$p.tcpSocket.port" '"http"' && no_path "$1" "$e.$p.tcpSocket.host" || return 1
  done
  eq "$1" "$e.ports[http].containerPort" 8003 && no_path "$1" "$e.startupProbe" &&
    ! grep -F "$e." "$1" | awk '{ print $1 }' | grep -qE '\.(httpGet|grpc|exec)(\.|$)'
}
each_profile "evaluator: readiness and liveness are TCP on 8003; no HTTP, gRPC or exec probe reaches it (it logs every request)" evaluator_tcp_probes
# kwok's start, its worst case computed from the tester's own code: each
# attempt that fails at kwokctl's create runs a delete of a leftover cluster
# (COMMAND_TIMEOUT_SECONDS), the create (CREATE_COMMAND_TIMEOUT_SECONDS) and
# the failed start's delete (stop_after_failed_start, COMMAND_TIMEOUT_SECONDS);
# KWOK_START_ATTEMPTS of them, with KWOK_RETRY_BACKOFF_SECONDS before each
# retry (the last repeated). The attempts and backoffs in effect are
# app/settings.py's (the Settings defaults main.py passes to the
# supervisor); app/kwok.py's START_ATTEMPTS and RETRY_BACKOFF_SECONDS are
# only the supervisor's own defaults, and a difference between the two
# copies fails the case. The startup probe must allow at least the worst
# case before liveness counts. A constant that can't be read fails the case.
KWOK_WORST="$(python3 -I - "$REPO_DIR/services/otelcol-testing/app/kwok_cluster.py" "$REPO_DIR/services/otelcol-testing/app/kwok.py" \
  "$REPO_DIR/services/otelcol-testing/app/settings.py" "$REPO_DIR/services/otelcol-testing/app/main.py" 2>/dev/null <<'PY'
import math, re, sys
cluster, kwok, settings, main = (open(p).read() for p in sys.argv[1:5])
def num(text, name):
    return float(re.search(r"^%s\s*=\s*([0-9.]+)\s*$" % name, text, re.M).group(1))
def floats(text, name):
    found = re.search(r"^%s[^=]*=\s*\(([^)]*)\)" % name, text, re.M).group(1)
    return [float(x) for x in found.split(",") if x.strip()]
command = num(cluster, "COMMAND_TIMEOUT_SECONDS")
create = num(cluster, "CREATE_COMMAND_TIMEOUT_SECONDS")
attempts = int(num(settings, "KWOK_START_ATTEMPTS"))
backoff = floats(settings, "KWOK_RETRY_BACKOFF_SECONDS")
# The supervisor's own defaults agree with the settings in effect.
assert int(num(kwok, "START_ATTEMPTS")) == attempts and floats(kwok, "RETRY_BACKOFF_SECONDS") == backoff
# The settings in effect are these: Settings' defaults, passed by main.py.
assert re.search(r"^\s+kwok_start_attempts: int = KWOK_START_ATTEMPTS$", settings, re.M)
assert re.search(r"^\s+kwok_retry_backoff_seconds: [^=]+= KWOK_RETRY_BACKOFF_SECONDS$", settings, re.M)
assert "attempts=loaded.kwok_start_attempts," in main and "backoff_seconds=loaded.kwok_retry_backoff_seconds," in main
assert "stop_after_failed_start()" in cluster and attempts >= 1 and backoff
retries = sum(backoff[min(i, len(backoff) - 1)] for i in range(attempts - 1))
print(math.ceil(attempts * (command + create + command) + retries))
PY
)"
tester_startup_budget() {
  local t p f; t="$(is_c otelcol-testing)"
  p="$(value "$1" "$t.startupProbe.periodSeconds")"; f="$(value "$1" "$t.startupProbe.failureThreshold")"
  [ -n "$KWOK_WORST" ] && [ "$KWOK_WORST" -ge 456 ] && [ -n "$p" ] && [ -n "$f" ] && [ $((p * f)) -ge "$KWOK_WORST" ] &&
    no_path "$1" "$t.livenessProbe.initialDelaySeconds"
}
each_profile "tester: the startup probe allows kwok's worst start (three failing creates and the backoffs, from the code) before liveness counts" tester_startup_budget

# --- the evaluator's limits (compose's) and the scheduling values ------------------
evaluator_limits() {
  local e; e="$(is_c ottl-evaluator)"
  eq "$1" "$(is_pod ottl-evaluator).terminationGracePeriodSeconds" 45 && eq "$1" "$e.resources.limits.memory" '"3Gi"' &&
    eq "$1" "$e.args[0]" '"serve"' && no_path "$1" "$e.args[1]" && no_path "$1" "$e.command"
}
each_profile "evaluator: serve, a 3Gi memory limit, a 45 s termination grace" evaluator_limits
is_full_values() {
  local F n; F="$(listing full)"
  for n in otelcol-validator otelcol-testing ottl-evaluator; do
    eq "$F" "Deployment/$n.spec.replicas" 2 && eq "$F" "$(is_pod "$n").nodeSelector.example.com/pool" '"sandbox"' &&
      [ "$(names_at "$F" "$(is_pod "$n").imagePullSecrets" | tr '\n' ' ')" = "registry-pull registry-pull-mirror " ] &&
      eq "$L" "Deployment/$n.spec.replicas" 1 && no_path "$L" "$(is_pod "$n").nodeSelector" &&
      no_path "$L" "$(is_pod "$n").tolerations" && no_path "$L" "$(is_pod "$n").affinity" &&
      no_path "$L" "Deployment/$n.spec.template.metadata.annotations" &&
      no_path "$L" "$(is_pod "$n").imagePullSecrets" || return 1
  done
  eq "$F" "Deployment/otelcol-validator.spec.template.metadata.annotations.example.com/validator" '"yes"' &&
    eq "$F" "Deployment/otelcol-testing.spec.template.metadata.annotations.example.com/tester" '"yes"' &&
    eq "$F" "Deployment/ottl-evaluator.spec.template.metadata.annotations.example.com/evaluator" '"yes"' &&
    eq "$F" "$(is_c otelcol-testing).resources.requests.memory" '"1Gi"' && eq "$L" "$(is_c otelcol-testing).resources.requests.memory" '"512Mi"' &&
    no_path "$L" "$(is_c otelcol-testing).resources.limits" && no_path "$L" "$(is_c otelcol-validator).resources.limits"
}
run_case "internal services: replicas, resources, nodeSelector, podAnnotations and pull secrets from values (defaults: one replica, requests only)" is_full_values
is_null_annotations() {
  next_file
  render_flat "$f" "${D[@]}" --set otelcolValidator.podAnnotations=null --set otelcolTesting.podAnnotations=null \
    --set ottlEvaluator.podAnnotations=null || return 1
  no_path "$f" "Deployment/otelcol-testing.spec.template.metadata.annotations"
}
run_case "internal services: a null podAnnotations renders" is_null_annotations
