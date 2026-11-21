# The gateway, and gateway.extraRoutes. Sourced by tests/render-tests.sh,
# which defines every helper used here (api_words is api.sh's).

GW_D="Deployment/telflo-gateway"
GW_POD="$GW_D.spec.template.spec"
GW_C="$GW_POD.containers[nginx]"
GW_SVC="Service/telflo-gateway"
GW_CM="ConfigMap/telflo-gateway"
GW_EXTRA_CM="ConfigMap/telflo-gateway-extra-routes"
GW_SOURCE="$REPO_DIR/docker/gateway/default.conf"
GW_COPY="$CHART_DIR/files/gateway-default.conf"

gw_kinds() {
  local k; k="$(kinds "$1")"
  for want in "$GW_CM" "$GW_EXTRA_CM" "$GW_SVC" "$GW_D"; do printf '%s\n' "$k" | grep -qx "$want" || return 1; done
  ! printf '%s\n' "$k" | grep -qx 'ServiceAccount/telflo-gateway'
}
each_profile "gateway: its ConfigMaps telflo-gateway and telflo-gateway-extra-routes, Service and Deployment telflo-gateway" gw_kinds

# --- default.conf, byte for byte -----------------------------------------------------
gw_copy_same() { [ -s "$GW_SOURCE" ] && cmp -s "$GW_SOURCE" "$GW_COPY"; }
run_case "gateway: files/gateway-default.conf is docker/gateway/default.conf, byte for byte" gw_copy_same
# The ConfigMap's text against the repository's file (not the chart's
# copy): a change to either fails it.
gw_configmap_is_source() {
  local got
  next_file
  helm template j "$tmp/json" --set-file "f=$GW_SOURCE" >"$f" 2>"$f.err" || return 1
  got="$(value "$1" "$GW_CM.data.default.conf")"
  [ -n "$got" ] && [ "$got" = "$(sed -n 's/^# J //p' "$f")" ] &&
    [ "$(awk -v p="$GW_CM.data." 'index($0, p) == 1' "$1" | wc -l | tr -d ' ')" = 1 ]
}
each_profile "gateway: the ConfigMap's default.conf (its only key) is docker/gateway/default.conf, byte for byte" gw_configmap_is_source
# The configuration routes to the Services the chart names so.
gw_upstreams() {
  grep -qxF 'upstream telflo_platform { server telflo-api:8080; }' "$GW_SOURCE" &&
    grep -qxF 'upstream telflo_web { server telflo-web:3000; }' "$GW_SOURCE" &&
    grep -qxF '    listen 80;' "$GW_SOURCE" && [ "$(grep -c 'listen ' "$GW_SOURCE")" = 1 ] &&
    eq "$1" "Service/telflo-api.spec.ports[http].port" 8080 && eq "$1" "Service/telflo-web.spec.ports[http].port" 3000 &&
    eq "$1" "$GW_C.ports[http].containerPort" 80
}
each_profile "gateway: default.conf's upstreams telflo-api:8080 and telflo-web:3000 are the chart's Services; it listens on 80, the container's port" gw_upstreams
gw_mount() {
  eq "$1" "$GW_C.volumeMounts[config].mountPath" '"/etc/nginx/conf.d/default.conf"' &&
    eq "$1" "$GW_C.volumeMounts[config].subPath" '"default.conf"' && eq "$1" "$GW_C.volumeMounts[config].readOnly" true &&
    eq "$1" "$GW_POD.volumes[config].configMap.name" '"telflo-gateway"' &&
    eq "$1" "$GW_POD.volumes[config].configMap.items[0].key" '"default.conf"' &&
    eq "$1" "$GW_POD.volumes[config].configMap.items[0].path" '"default.conf"' &&
    eq "$1" "$GW_POD.volumes[config].configMap.items[0].mode" 292 && no_path "$1" "$GW_POD.volumes[config].configMap.items[1]"
}
each_profile "gateway: the ConfigMap mounted read-only at /etc/nginx/conf.d/default.conf (0444)" gw_mount
gw_checksum() { # a changed configuration rolls the pods
  local sum; sum="$(shasum -a 256 "$GW_SOURCE" | cut -d' ' -f1)"
  [ -n "$sum" ] && eq "$1" "$GW_D.spec.template.metadata.annotations.checksum/gateway-config" "\"$sum\""
}
each_profile "gateway: the pods' checksum/gateway-config is default.conf's sha256" gw_checksum

# --- nginx as uid 101 on port 80 -----------------------------------------------------
gw_security() {
  eq "$1" "$GW_POD.automountServiceAccountToken" false && eq "$1" "$GW_POD.enableServiceLinks" false &&
    eq "$1" "$GW_POD.securityContext.runAsNonRoot" true && eq "$1" "$GW_POD.securityContext.runAsUser" 101 &&
    eq "$1" "$GW_POD.securityContext.runAsGroup" 101 && no_path "$1" "$GW_POD.securityContext.fsGroup" &&
    eq "$1" "$GW_POD.securityContext.seccompProfile.type" '"RuntimeDefault"' &&
    eq "$1" "$GW_C.securityContext.allowPrivilegeEscalation" false && eq "$1" "$GW_C.securityContext.readOnlyRootFilesystem" true &&
    eq "$1" "$GW_C.securityContext.runAsNonRoot" true && eq "$1" "$GW_C.securityContext.runAsUser" 101 &&
    eq "$1" "$GW_C.securityContext.runAsGroup" 101 &&
    eq "$1" "$GW_C.securityContext.capabilities.drop[0]" '"ALL"' && no_path "$1" "$GW_C.securityContext.capabilities.drop[1]" &&
    no_path "$1" "$GW_C.securityContext.capabilities.add" && no_path "$1" "$GW_C.securityContext.privileged" &&
    eq "$1" "$GW_C.securityContext.seccompProfile.type" '"RuntimeDefault"' && no_path "$1" "$GW_POD.hostNetwork" &&
    no_path "$1" "$GW_POD.serviceAccountName"
}
each_profile "gateway: uid and gid 101, non-root, read-only root, ALL dropped (no NET_BIND_SERVICE), no escalation, RuntimeDefault, no token, no service links" gw_security
# The pod's sysctl lets uid 101 bind port 80 (Docker's and minikube's runtime
# default is 0, so only this case proves it is there).
gw_sysctl() {
  # (names_at skips a name holding a dot, so the elements are counted here.)
  local p="$GW_POD.securityContext.sysctls["
  [ "$(awk -v p="$p" 'index($0, p) == 1 && $0 ~ /\]#index [0-9]+$/' "$1" | wc -l | tr -d ' ')" = 1 ] &&
    eq "$1" "${p}net.ipv4.ip_unprivileged_port_start]#index" 0 &&
    eq "$1" "${p}net.ipv4.ip_unprivileged_port_start].value" '"80"'
}
each_profile "gateway: the pod's sysctl net.ipv4.ip_unprivileged_port_start=80, and no other" gw_sysctl
gw_writable() {
  eq "$1" "$GW_C.volumeMounts[cache].mountPath" '"/var/cache/nginx"' && eq "$1" "$GW_POD.volumes[cache].emptyDir" '{}' &&
    no_path "$1" "$GW_POD.volumes[cache].emptyDir.sizeLimit" &&
    eq "$1" "$GW_C.volumeMounts[run].mountPath" '"/run"' && eq "$1" "$GW_POD.volumes[run].emptyDir.sizeLimit" '"1Mi"' &&
    [ "$(awk -v p="$GW_POD.volumes[run].emptyDir." 'index($0, p) == 1' "$1" | wc -l | tr -d ' ')" = 1 ] &&
    [ "$(api_words names_at "$1" "$GW_C.volumeMounts")" = "config extra-routes cache run " ] &&
    [ "$(api_words names_at "$1" "$GW_POD.volumes")" = "config extra-routes cache run " ] &&
    eq "$1" "$GW_C.volumeMounts[config].readOnly" true && eq "$1" "$GW_C.volumeMounts[extra-routes].readOnly" true
}
each_profile "gateway: emptyDirs at /var/cache/nginx (no sizeLimit: a full one would evict the pod) and /run (1Mi: the pid file), nothing else writable" gw_writable
gw_probes() {
  local p
  for p in readinessProbe livenessProbe; do
    eq "$1" "$GW_C.$p.tcpSocket.port" '"http"' && no_path "$1" "$GW_C.$p.httpGet" && no_path "$1" "$GW_C.$p.exec" || return 1
  done
}
each_profile "gateway probes: readiness and liveness TCP on port 80 (no request, no access-log line)" gw_probes
gw_container() { # the image's own entrypoint and command; no credential
  no_path "$1" "$GW_C.command" && no_path "$1" "$GW_C.args" && no_path "$1" "$GW_C.env" && no_path "$1" "$GW_C.envFrom" &&
    no_path "$1" "$GW_POD.initContainers" && no_path "$1" "$GW_POD.containers[1]"
}
each_profile "gateway: nginx's own entrypoint, no environment, one container" gw_container
gw_image() {
  eq "$L" "$GW_C.image" '"docker.io/library/nginx:1.30-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3"' &&
    eq "$L" "$GW_C.imagePullPolicy" '"IfNotPresent"' &&
    eq "$(listing full)" "$GW_C.image" '"registry.example.com/mirror/nginx:1.30-alpine"'
}
run_case "gateway: nginx:1.30-alpine pinned by digest by default; gateway.image (full)" gw_image

# --- the Service ---------------------------------------------------------------------
gw_service_default() {
  eq "$L" "$GW_SVC.spec.type" '"LoadBalancer"' && eq "$L" "$GW_SVC.spec.ports[http].port" 80 &&
    eq "$L" "$GW_SVC.spec.ports[http].targetPort" '"http"' && no_path "$L" "$GW_SVC.spec.ports[1]" &&
    no_path "$L" "$GW_SVC.metadata.annotations" && no_path "$L" "$GW_SVC.spec.externalTrafficPolicy" &&
    no_path "$L" "$GW_SVC.spec.loadBalancerSourceRanges" &&
    eq "$L" "$GW_SVC.spec.selector.app.kubernetes.io/component" '"gateway"' &&
    eq "$L" "$GW_D.spec.template.metadata.labels.app.kubernetes.io/component" '"gateway"' &&
    eq "$L" "$GW_D.spec.selector.matchLabels.app.kubernetes.io/component" '"gateway"'
}
run_case "gateway Service: telflo-gateway, a LoadBalancer on port 80 by default, no annotation, policy or ranges" gw_service_default
gw_service_full() {
  local F; F="$(listing full)"
  eq "$F" "$GW_SVC.metadata.annotations.example.com/load-balancer" '"external"' &&
    eq "$F" "$GW_SVC.spec.externalTrafficPolicy" '"Local"' &&
    [ "$(grep -F "$GW_SVC.spec.loadBalancerSourceRanges[" "$F" | awk '{ print $2 }' | tr '\n' ' ')" = '"203.0.113.0/24" "2001:db8::/32" ' ]
}
run_case "gateway Service: gateway.service's annotations, externalTrafficPolicy and loadBalancerSourceRanges (full)" gw_service_full
gw_service_clusterip() {
  next_file
  render_flat "$f" "${D[@]}" --set-string gateway.service.type=ClusterIP || return 1
  eq "$f" "$GW_SVC.spec.type" '"ClusterIP"' && no_path "$f" "$GW_SVC.spec.externalTrafficPolicy"
}
run_case "gateway Service: gateway.service.type ClusterIP" gw_service_clusterip
gw_service_null_type() { # a null type is LoadBalancer, never Kubernetes' ClusterIP default
  next_file
  render_flat "$f" "${D[@]}" --set gateway.service.type=null || return 1
  eq "$f" "$GW_SVC.spec.type" '"LoadBalancer"'
}
run_case "gateway Service: a null gateway.service.type is LoadBalancer, not an empty type (ClusterIP)" gw_service_null_type
gw_full_values() {
  local F; F="$(listing full)"
  eq "$F" "$GW_D.spec.replicas" 2 && eq "$L" "$GW_D.spec.replicas" 1 &&
    eq "$F" "$GW_C.resources.requests.memory" '"64Mi"' && eq "$L" "$GW_C.resources.requests.memory" '"32Mi"' &&
    no_path "$L" "$GW_C.resources.limits" &&
    eq "$F" "$GW_POD.nodeSelector.example.com/pool" '"edge"' && no_path "$L" "$GW_POD.nodeSelector" &&
    eq "$F" "$GW_D.spec.template.metadata.annotations.example.com/gateway" '"yes"' &&
    [ "$(awk -v p="$GW_D.spec.template.metadata.annotations." 'index($0, p) == 1' "$L" | wc -l | tr -d ' ')" = 2 ] &&
    [ "$(api_words names_at "$F" "$GW_POD.imagePullSecrets")" = "registry-pull registry-pull-mirror " ] &&
    no_path "$L" "$GW_POD.imagePullSecrets" &&
    eq "$L" "$GW_D.spec.strategy.rollingUpdate.maxUnavailable" 0
}
run_case "gateway: replicas, resources, scheduling, podAnnotations (beside the two checksums) and pull secrets from values" gw_full_values

# --- gateway.extraRoutes -------------------------------------------------------------
GW_FIXTURE="$CHART_DIR/tests/expected/extra-routes.conf"
GW_EMPTY_SUM=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
gw_extra_mount() {
  eq "$1" "$GW_C.volumeMounts[extra-routes].mountPath" '"/etc/nginx/telflo/extra-routes.conf"' &&
    eq "$1" "$GW_C.volumeMounts[extra-routes].subPath" '"extra-routes.conf"' &&
    eq "$1" "$GW_POD.volumes[extra-routes].configMap.name" '"telflo-gateway-extra-routes"' &&
    eq "$1" "$GW_POD.volumes[extra-routes].configMap.items[0].key" '"extra-routes.conf"' &&
    eq "$1" "$GW_POD.volumes[extra-routes].configMap.items[0].path" '"extra-routes.conf"' &&
    eq "$1" "$GW_POD.volumes[extra-routes].configMap.items[0].mode" 292 &&
    no_path "$1" "$GW_POD.volumes[extra-routes].configMap.items[1]" &&
    [ "$(awk -v p="$GW_EXTRA_CM.data." 'index($0, p) == 1' "$1" | wc -l | tr -d ' ')" = 1 ]
}
each_profile "gateway: telflo-gateway-extra-routes' extra-routes.conf (its only key) mounted read-only (0444) at /etc/nginx/telflo/extra-routes.conf, default.conf's include" gw_extra_mount
gw_extra_empty() { # <listing>: every profile but saas has no route: an empty file, and its checksum
  [ "$(basename "$1")" = saas ] && return 0
  eq "$1" "$GW_EXTRA_CM.data.extra-routes.conf" '""' &&
    eq "$1" "$GW_D.spec.template.metadata.annotations.checksum/gateway-extra-routes" "\"$GW_EMPTY_SUM\""
}
each_profile "gateway: no extraRoutes renders an empty extra-routes.conf (nginx needs the file), checksum/gateway-extra-routes the empty file's sha256 (every profile but saas)" gw_extra_empty
# The saas profile holds the fixture's values (an exact / and a /home/
# prefix to website:8081, in the tests' namespace): Helm's rendering is
# the fixture, byte for byte, the file scripts/check-gateway-logs.sh's
# section 11 runs nginx with.
gw_extra_fixture() {
  local got sum S; S="$(listing saas)"
  profile_ok saas && [ -s "$GW_FIXTURE" ] || return 1
  next_file
  helm template j "$tmp/json" --set-file "f=$GW_FIXTURE" >"$f" 2>"$f.err" || return 1
  got="$(value "$S" "$GW_EXTRA_CM.data.extra-routes.conf")"
  [ -n "$got" ] && [ "$got" = "$(sed -n 's/^# J //p' "$f")" ] || return 1
  sum="$(shasum -a 256 "$GW_FIXTURE" | cut -d' ' -f1)"
  [ -n "$sum" ] && eq "$S" "$GW_D.spec.template.metadata.annotations.checksum/gateway-extra-routes" "\"$sum\""
}
run_case "gateway: the saas profile's extraRoutes render as tests/expected/extra-routes.conf, byte for byte, and its sha256 is the pods' checksum/gateway-extra-routes" gw_extra_fixture
gw_extra_namespace() { # the Service's namespace is the release's
  next_file
  helm template "$REL" "$CHART_DIR" -n other-ns -f "$PROFILES_DIR/saas.yaml" >"$f.yaml" 2>"$f.err" && flat "$f.yaml" "$f" || return 1
  value "$f" "$GW_EXTRA_CM.data.extra-routes.conf" | grep -qF 'proxy_pass http://website.other-ns.svc:8081;' &&
    ! value "$f" "$GW_EXTRA_CM.data.extra-routes.conf" | grep -qF '.telflo.svc'
}
run_case "gateway: an extra route proxies to <service>.<the release's namespace>.svc:<port>" gw_extra_namespace

# route_args <path> <match> [service] [port]: --set flags for one route
route_args() { printf '%s\n' --set-string "gateway.extraRoutes[0].path=$1" --set-string "gateway.extraRoutes[0].match=$2" \
  --set-string "gateway.extraRoutes[0].service=${3:-website}" --set "gateway.extraRoutes[0].port=${4:-8081}"; }
# extra_refused <message> <path> <match> [helm args...]
extra_refused() {
  local msg="$1" path="$2" match="$3" a; shift 3
  local args=()
  while IFS= read -r a; do args+=("$a"); done < <(route_args "$path" "$match")
  refused "$msg" "" "${D[@]}" "${args[@]}" "$@"
}
extra_renders() { # <path> <match>
  local a args=()
  while IFS= read -r a; do args+=("$a"); done < <(route_args "$1" "$2")
  renders "${D[@]}" "${args[@]}"
}
M_SHADOW() { printf "gateway.extraRoutes[0].path would shadow the platform's %s" "$1"; }

# The platform's roots: the chart's list (telflo.platformRoots)
# against its sources, read now (never copied here): the first segment of
# every path in telflo-core/apps/web/app/routes.ts (a nested route's own
# path is under its parent's; a layout adds none), robots.txt aside (ruling
# 15 allows it: a site may answer it); every entry of the web app's public/
# folder (a dot file aside); and api assets __manifest _root.data
# quick-deploy library-links.
# Two reads, named one by one (publish-chart.test.sh copies each $REPO_DIR
# path this folder names into its throwaway repository).
WEB_ROUTES="$REPO_DIR/telflo-core/apps/web/app/routes.ts"
WEB_PUBLIC="$REPO_DIR/telflo-core/apps/web/public"
gw_sources_roots() {
  { python3 -I -c '
import re, sys
src = open(sys.argv[1]).read()
tokens = re.compile(r"\"(?:[^\"\\]|\\.)*\"|//[^\n]*|/\*.*?\*/|\b(route|layout|index)\s*\(|\[|\]", re.S)
stack, last, want_path, roots = [], None, False, set()
for m in tokens.finditer(src):
    t = m.group(0)
    if t.startswith("//") or t.startswith("/*"):
        continue
    if t.startswith("\""):
        if want_path:
            want_path = False
            if all(s in ("root", "layout") for s in stack):
                roots.add(t[1:-1].split("/")[0].lower())
        continue
    if t == "[":
        stack.append(last or "root"); last = None
    elif t == "]":
        if not stack: sys.exit(1)
        stack.pop(); last = None
    else:
        last = m.group(1); want_path = last == "route"
if stack or not roots: sys.exit(1)
roots.discard("robots.txt")
print("\n".join(sorted(roots)))' "$WEB_ROUTES" || return 1
    ls -A "$WEB_PUBLIC" | grep -v '^\.' | tr 'A-Z' 'a-z'
    printf '%s\n' api assets __manifest _root.data quick-deploy library-links
  } | LC_ALL=C sort -u
}
gw_chart_roots() {
  sed -n 's/^{{- define "telflo.platformRoots" -}}\(.*\){{- end }}$/\1/p' "$CHART_DIR/templates/_helpers.tpl" | tr ' ' '\n' | LC_ALL=C sort
}
gw_roots_equal() {
  local want got
  want="$(gw_sources_roots)" && got="$(gw_chart_roots)" || return 1
  [ -n "$want" ] && [ "$want" = "$got" ] &&
    printf '%s\n' "$got" | grep -qx login && printf '%s\n' "$got" | grep -qx favicon.ico && ! printf '%s\n' "$got" | grep -qx robots.txt
}
run_case "gateway: the shadow guard's roots are routes.ts's first segments (robots.txt aside), public/'s entries and api assets __manifest _root.data quick-deploy library-links" gw_roots_equal
# Each root refused, by the sources' list (a root missing from the chart's
# list fails its own case).
for root in $(gw_sources_roots); do
  run_case "guard: gateway.extraRoutes exact /$root refused (shadows the platform's /$root)" extra_refused "$(M_SHADOW "/$root")" "/$root" exact
done
run_case "guard: gateway.extraRoutes prefix / refused" extra_refused \
  "gateway.extraRoutes[0]: a prefix / would take every path the platform answers" / prefix
run_case "guard: gateway.extraRoutes /LOGIN refused (React Router matches without case)" extra_refused "$(M_SHADOW /login)" /LOGIN exact
run_case "guard: gateway.extraRoutes a page under a root (/app/x) refused" extra_refused "$(M_SHADOW /app)" /app/x exact
run_case "guard: gateway.extraRoutes a root's data request (/Login.data) refused" extra_refused "$(M_SHADOW /login)" /Login.data exact
run_case "guard: gateway.extraRoutes a prefix a root starts with (/ap) refused" extra_refused "$(M_SHADOW /api)" /ap prefix
run_case "guard: gateway.extraRoutes a prefix under a root (/settings/) refused" extra_refused "$(M_SHADOW /settings)" /settings/ prefix
gw_extra_allowed() {
  extra_renders / exact && extra_renders /robots.txt exact && extra_renders /home/ prefix && extra_renders /home exact &&
    extra_renders /pricing prefix && extra_renders /blog/ prefix && extra_renders /changelog exact &&
    extra_renders /ap exact && extra_renders /loginx prefix
}
run_case "guard: gateway.extraRoutes exact /, /robots.txt, /home/, the old marketing paths, an exact /ap and a prefix /loginx render" gw_extra_allowed
gw_extra_duplicate() {
  local dup="$tmp/routes-dup.yaml"
  printf 'gateway:\n  extraRoutes:\n' >"$dup"
  printf '    - {path: /home/, match: prefix, service: website, port: 8081}\n' >>"$dup"
  printf '    - {path: /home/, match: exact, service: website, port: 8081}\n' >>"$dup"
  renders "${D[@]}" -f "$dup" || return 1
  printf '    - {path: /home/, match: prefix, service: other-site, port: 8082}\n' >>"$dup"
  refused "gateway.extraRoutes[2] repeats an earlier route's match and path" "" "${D[@]}" -f "$dup"
}
run_case "guard: gateway.extraRoutes a second route of the same match and path refused (an exact and a prefix of one path render)" gw_extra_duplicate
# The template's own checks, with the schema skipped: nothing else reaches
# nginx's configuration.
SKIP=--skip-schema-validation
run_case "guard: gateway.extraRoutes' path checked without the schema (a space, not quoted)" extra_refused \
  "gateway.extraRoutes[0].path must be at most 200 characters: a leading / then letters, digits and ._~/-" "/home cnrypath" prefix "$SKIP"
run_case "guard: gateway.extraRoutes' path checked without the schema (a ; and a brace)" extra_refused \
  "gateway.extraRoutes[0].path must be at most 200 characters: a leading / then letters, digits and ._~/-" "/home/;}" prefix "$SKIP"
run_case "guard: gateway.extraRoutes' path checked without the schema (201 characters)" extra_refused \
  "gateway.extraRoutes[0].path must be at most 200 characters: a leading / then letters, digits and ._~/-" "/$(printf 'a%.0s' $(seq 1 200))" prefix "$SKIP"
run_case "guard: gateway.extraRoutes' path checked without the schema (no leading /)" extra_refused \
  "gateway.extraRoutes[0].path must be at most 200 characters: a leading / then letters, digits and ._~/-" "home/" prefix "$SKIP"
run_case "guard: gateway.extraRoutes' match checked without the schema" extra_refused \
  "gateway.extraRoutes[0].match must be exact or prefix" /home/ regex "$SKIP"
# No empty, . or .. segment (inert, as nginx matches the normalized path,
# but refused so the guard reads plainly); a segment that only starts with
# a dot is a name.
M_SEGMENT="gateway.extraRoutes[0].path must hold no empty, . or .. segment (nginx matches the normalised path)"
for bad in //home/ /home//x /home/./x /home/../login /./ /home/. /home/..; do
  run_case "guard: gateway.extraRoutes path $bad refused (an empty, . or .. segment)" extra_refused "$M_SEGMENT" "$bad" prefix
done
gw_extra_dot_names() { extra_renders /.well-known/ prefix && extra_renders /home/a..b exact && extra_renders /home/.x exact; }
run_case "guard: gateway.extraRoutes segments that only start with a dot (/.well-known/, /home/.x) or hold dots (/home/a..b) render" gw_extra_dot_names
gw_extra_service_port() {
  refused "gateway.extraRoutes[0].service must be a Service's name in this namespace (at most 63 lower-case letters, digits and -)" "" \
    "${D[@]}" "$SKIP" --set-string 'gateway.extraRoutes[0].path=/home/' --set-string gateway.extraRoutes[0].match=prefix \
    --set-string 'gateway.extraRoutes[0].service=site;x' --set gateway.extraRoutes[0].port=8081 &&
    refused "gateway.extraRoutes[0].port must be a port, 1 to 65535" "" \
      "${D[@]}" "$SKIP" --set-string 'gateway.extraRoutes[0].path=/home/' --set-string gateway.extraRoutes[0].match=prefix \
      --set-string gateway.extraRoutes[0].service=website --set gateway.extraRoutes[0].port=65536 &&
    refused "gateway.extraRoutes[0].port must be a port, 1 to 65535" "" \
      "${D[@]}" "$SKIP" --set-string 'gateway.extraRoutes[0].path=/home/' --set-string gateway.extraRoutes[0].match=prefix \
      --set-string gateway.extraRoutes[0].service=website --set-string 'gateway.extraRoutes[0].port=80;x' &&
    gw_port_text 010 && gw_port_text 8081
}
# gw_port_text <text>: a port given as text refused ("010" once rendered
# :8), whatever its digits
gw_port_text() {
  refused "gateway.extraRoutes[0].port must be a port, 1 to 65535" "" \
    "${D[@]}" "$SKIP" --set-string 'gateway.extraRoutes[0].path=/home/' --set-string gateway.extraRoutes[0].match=prefix \
    --set-string gateway.extraRoutes[0].service=website --set-string "gateway.extraRoutes[0].port=$1"
}
run_case "guard: gateway.extraRoutes' service and port checked without the schema (a port over 65535, or text: 80;x, 010, 8081)" gw_extra_service_port
run_case "guard: gateway.extraRoutes not a list refused without the schema" refused \
  "gateway.extraRoutes must be a list of {path, match, service, port}" "" "${D[@]}" "$SKIP" --set-string gateway.extraRoutes=x
