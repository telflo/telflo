# The platform's NetworkPolicies. Sourced by tests/render-tests.sh, which
# defines every helper used here.
#
# On by default (networkPolicy.enabled), none at all when off:
# - the validator, tester and evaluator: ingress from the API's pods only,
#   on their own port; no egress at all;
# - the API: ingress from the gateway's and the web app's pods only, on 8080;
# - the web app: from the gateway's pods only, on 3000;
# - Postgres: from the API's pods and the opamp-server's, on 5432;
# - the gateway: no policy (the public way in);
# - the opamp-server's own two (its chart's, -agent and -management;
#   render-tests.sh checks their ports).

NP_PLATFORM="NetworkPolicy/otelcol-testing NetworkPolicy/otelcol-validator NetworkPolicy/ottl-evaluator NetworkPolicy/telflo-api NetworkPolicy/telflo-postgres NetworkPolicy/telflo-web"

# policy_kinds <listing>: the platform's six and the opamp-server's two,
# nothing else.
policy_kinds() {
  [ "$(kinds "$1" | grep '^NetworkPolicy/' | sort | tr '\n' ' ')" = "$(printf '%s\n' $NP_PLATFORM NetworkPolicy/telflo-opamp-server-agent NetworkPolicy/telflo-opamp-server-management | sort | tr '\n' ' ')" ]
}
# Every profile but no-network-policy has them on.
np_on() { [ "$(basename "$1")" = no-network-policy ] || policy_kinds "$1"; }
each_profile "policies (on): exactly the six platform policies and the opamp-server's two, none for the gateway" np_on
np_off() {
  local l; l="$(listing no-network-policy)"
  profile_ok no-network-policy && ! kinds "$l" | grep -q '^NetworkPolicy/' && ! grep -q 'NetworkPolicy' "$l.yaml"
}
run_case "networkPolicy.enabled false (no-network-policy): no NetworkPolicy rendered at all" np_off
np_off_set() {
  next_file
  render_flat "$f" "${D[@]}" --set networkPolicy.enabled=false --set opamp-server.networkPolicy.enabled=false || return 1
  ! kinds "$f" | grep -q '^NetworkPolicy/' && kinds "$f" | grep -qx 'Deployment/otelcol-testing'
}
run_case "networkPolicy.enabled false (set over the defaults): no NetworkPolicy, the services still rendered" np_off_set
np_show_only_off() {
  next_file
  render "$f" "${D[@]}" --set networkPolicy.enabled=false --set opamp-server.networkPolicy.enabled=false \
    --show-only templates/networkpolicies.yaml && return 1
  grep -qF 'could not find template templates/networkpolicies.yaml' "$f.err"
}
run_case "networkPolicy.enabled false: networkpolicies.yaml renders nothing" np_show_only_off

# count_under <listing> <path>: how many leaves lie under <path>.
count_under() { awk -v p="$2." 'index($0, p) == 1 { n++ } END { print n + 0 }' "$1"; }
# selects <listing> <path to matchLabels> <component>: exactly the platform's
# three selector labels for that component.
selects() {
  eq "$1" "$2.app.kubernetes.io/name" '"telflo"' && eq "$1" "$2.app.kubernetes.io/instance" "\"$REL\"" &&
    eq "$1" "$2.app.kubernetes.io/component" "\"$3\"" &&
    [ "$(count_under "$1" "$2")" = 3 ]
}
# only_peers <listing> <policy> <component...>: one ingress rule, whose peers
# are exactly those components' pods (podSelector only: no namespaceSelector,
# no ipBlock).
only_peers() {
  local l="$1" p="NetworkPolicy/$2" i=0; shift 2
  no_path "$l" "$p.spec.ingress[1]" || return 1
  for comp in "$@"; do
    selects "$l" "$p.spec.ingress[0].from[$i].podSelector.matchLabels" "$comp" &&
      no_path "$l" "$p.spec.ingress[0].from[$i].namespaceSelector" && no_path "$l" "$p.spec.ingress[0].from[$i].ipBlock" &&
      no_path "$l" "$p.spec.ingress[0].from[$i].podSelector.matchExpressions" || return 1
    i=$((i + 1))
  done
  no_path "$l" "$p.spec.ingress[0].from[$i]"
}
# one_port <listing> <policy> <port>
one_port() {
  eq "$1" "NetworkPolicy/$2.spec.ingress[0].ports[0].port" "$3" &&
    eq "$1" "NetworkPolicy/$2.spec.ingress[0].ports[0].protocol" '"TCP"' &&
    no_path "$1" "NetworkPolicy/$2.spec.ingress[0].ports[0].endPort" && no_path "$1" "NetworkPolicy/$2.spec.ingress[0].ports[1]"
}

# The sandbox.
sandbox_policy() { # <listing> <component> <port>
  local p="NetworkPolicy/$2"
  selects "$1" "$p.spec.podSelector.matchLabels" "$2" && no_path "$1" "$p.spec.podSelector.matchExpressions" &&
    eq "$1" "$p.spec.policyTypes[0]" '"Ingress"' && eq "$1" "$p.spec.policyTypes[1]" '"Egress"' &&
    no_path "$1" "$p.spec.policyTypes[2]" &&
    only_peers "$1" "$2" api && one_port "$1" "$2" "$3" &&
    eq "$1" "$p.spec.egress" '[]' && no_path "$1" "$p.spec.egress[0]"
}
np_validator() { np_on_only "$1" sandbox_policy otelcol-validator 8001; }
np_tester() { np_on_only "$1" sandbox_policy otelcol-testing 8002; }
np_evaluator() { np_on_only "$1" sandbox_policy ottl-evaluator 8003; }
# np_on_only <listing> <check> <args...>: the check on a profile with policies on.
np_on_only() { local l="$1" c="$2"; shift 2; [ "$(basename "$l")" = no-network-policy ] || "$c" "$l" "$@"; }
each_profile "validator's policy: ingress from the API's pods on 8001 only; Egress with no rule (nothing out)" np_validator
each_profile "tester's policy: ingress from the API's pods on 8002 only; Egress with no rule (nothing out)" np_tester
each_profile "evaluator's policy: ingress from the API's pods on 8003 only; Egress with no rule (nothing out)" np_evaluator

# The API, the web app and Postgres: ingress only (they keep their egress).
ingress_only() { # <listing> <policy> <component>
  local p="NetworkPolicy/$2"
  selects "$1" "$p.spec.podSelector.matchLabels" "$3" && eq "$1" "$p.spec.policyTypes[0]" '"Ingress"' &&
    no_path "$1" "$p.spec.policyTypes[1]" && no_path "$1" "$p.spec.egress"
}
np_api() { ingress_only "$1" telflo-api api && only_peers "$1" telflo-api gateway web && one_port "$1" telflo-api 8080; }
np_web() { ingress_only "$1" telflo-web web && only_peers "$1" telflo-web gateway && one_port "$1" telflo-web 3000; }
np_on_only_api() { np_on_only "$1" np_api; }
np_on_only_web() { np_on_only "$1" np_web; }
each_profile "API's policy: ingress from the gateway's and the web app's pods only, on 8080; egress not restricted by this policy" np_on_only_api
each_profile "web's policy: ingress from the gateway's pods only, on 3000; egress not restricted by this policy" np_on_only_web

# Postgres: the API's pods (the migrate init container's) and the
# opamp-server's, labelled as that chart labels them: its name and this
# release, and component agent or management (since its 0.2.4, two
# Deployments, each with its own migrate init container, and both
# serve from the database).
OPAMP_PEER_SEL="NetworkPolicy/telflo-postgres.spec.ingress[0].from[1].podSelector"
OPAMP_PEER="$OPAMP_PEER_SEL.matchLabels"
OPAMP_PEER_EXPR="$OPAMP_PEER_SEL.matchExpressions"
np_postgres() {
  local p="NetworkPolicy/telflo-postgres" t c
  ingress_only "$1" telflo-postgres postgres && one_port "$1" telflo-postgres 5432 && no_path "$1" "$p.spec.ingress[1]" &&
    selects "$1" "$p.spec.ingress[0].from[0].podSelector.matchLabels" api &&
    eq "$1" "$OPAMP_PEER.app.kubernetes.io/name" '"opamp-server"' && eq "$1" "$OPAMP_PEER.app.kubernetes.io/instance" "\"$REL\"" &&
    [ "$(count_under "$1" "$OPAMP_PEER")" = 2 ] &&
    eq "$1" "$OPAMP_PEER_EXPR[0].key" '"app.kubernetes.io/component"' && eq "$1" "$OPAMP_PEER_EXPR[0].operator" '"In"' &&
    eq "$1" "$OPAMP_PEER_EXPR[0].values[0]" '"agent"' && eq "$1" "$OPAMP_PEER_EXPR[0].values[1]" '"management"' &&
    no_path "$1" "$OPAMP_PEER_EXPR[0].values[2]" && no_path "$1" "$OPAMP_PEER_EXPR[1]" &&
    no_path "$1" "$p.spec.ingress[0].from[1].namespaceSelector" && no_path "$1" "$p.spec.ingress[0].from[2]" || return 1
  # Each of the opamp-server's Deployments' pods matches the peer: its name
  # and instance labels, and its component among the expression's values.
  for c in agent management; do
    t="Deployment/telflo-opamp-server-$c.spec.template.metadata.labels"
    for k in name instance; do
      [ "$(value "$1" "$OPAMP_PEER.app.kubernetes.io/$k")" = "$(value "$1" "$t.app.kubernetes.io/$k")" ] || return 1
    done
    eq "$1" "$t.app.kubernetes.io/component" "\"$c\"" || return 1
  done
}
np_on_only_postgres() { np_on_only "$1" np_postgres; }
each_profile "Postgres's policy: ingress from the API's pods and the opamp-server's agent and management pods (that chart's own labels) only, on 5432" np_on_only_postgres
# The opamp-server's pods keep matching under its nameOverride.
np_opamp_name_override() {
  next_file
  render_flat "$f" "${D[@]}" --set-string opamp-server.nameOverride=opamp || return 1
  eq "$f" "$OPAMP_PEER.app.kubernetes.io/name" '"opamp"' &&
    eq "$f" "Deployment/telflo-opamp-server-agent.spec.template.metadata.labels.app.kubernetes.io/name" '"opamp"' &&
    eq "$f" "Deployment/telflo-opamp-server-management.spec.template.metadata.labels.app.kubernetes.io/name" '"opamp"'
}
run_case "Postgres's policy: follows opamp-server.nameOverride, as that chart's pods do" np_opamp_name_override
np_release_name() {
  next_file
  helm template other "$CHART_DIR" -n "$NS" "${D[@]}" >"$f.yaml" 2>"$f.err" && flat "$f.yaml" "$f" || return 1
  eq "$f" "NetworkPolicy/otelcol-testing.spec.ingress[0].from[0].podSelector.matchLabels.app.kubernetes.io/instance" '"other"' &&
    eq "$f" "NetworkPolicy/otelcol-testing.spec.podSelector.matchLabels.app.kubernetes.io/instance" '"other"' &&
    eq "$f" "$OPAMP_PEER.app.kubernetes.io/instance" '"other"'
}
run_case "every policy's selectors name the release (another release name)" np_release_name

# Each policy selects the pods its component's workload runs (whatever
# template renders the workload).
np_matches_pods() {
  [ "$(basename "$1")" = no-network-policy ] && return 0
  local pol wl comp k
  for pair in otelcol-validator:Deployment/otelcol-validator otelcol-testing:Deployment/otelcol-testing \
    ottl-evaluator:Deployment/ottl-evaluator telflo-postgres:StatefulSet/telflo-postgres \
    telflo-api:Deployment/telflo-api telflo-web:Deployment/telflo-web; do
    pol="NetworkPolicy/${pair%%:*}"; wl="${pair#*:}"
    grep -qF "$wl.kind " "$1" || continue
    for k in name instance component; do
      [ "$(value "$1" "$pol.spec.podSelector.matchLabels.app.kubernetes.io/$k")" = \
        "$(value "$1" "$wl.spec.template.metadata.labels.app.kubernetes.io/$k")" ] || return 1
    done
  done
  for comp in gateway web api; do
    wl="Deployment/telflo-$comp"
    grep -qF "$wl.kind " "$1" || continue
    [ "$(value "$1" "$wl.spec.template.metadata.labels.app.kubernetes.io/component")" = "\"$comp\"" ] || return 1
  done
  # The internal services are always rendered.
  grep -qF "Deployment/otelcol-testing.kind " "$1"
}
each_profile "each policy selects its workload's pods; the peers' components are the workloads' labels" np_matches_pods
# No policy selects the gateway's pods.
np_no_gateway() { ! grep -E '^NetworkPolicy/[^ ]*\.spec\.podSelector\.matchLabels\.app\.kubernetes\.io/component ' "$1" | grep -qF '"gateway"'; }
each_profile "no policy selects the gateway's pods (its ingress stays open)" np_no_gateway
