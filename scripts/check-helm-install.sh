#!/usr/bin/env bash
# Checks the Helm install for real: against a throwaway compose stack and a
# throwaway minikube profile (CHECK_HELM_PROFILE, default d18-helm), through
# the platform's API as a signed-in person, with the platform's published
# chart and image (oci://ghcr.io/telflo/telflo/charts/supervisor-collector,
# ghcr.io/telflo/telflo/collector: the stack's defaults), it installs an
# Agent, the Cluster and a 2-replica gateway each with the dialog's
# `helm upgrade --install` and values file (both printed by the contracts'
# builders in the API container, as the dialog builds them from the facts and
# a reveal), and one more gateway with a Helm values link's Quick Deploy
# command (its curl downloading the values through the gateway, then the
# install); finds each release's pods by the chart's object name
# (`app=<fullname>`: the facts' fullnameOverride, the fleet id's first 8
# characters and -default or -cluster, else the gateway's name) and checks
# each enrolls in its group through the platform's collector list (its name
# the pod's, handed the rotate token). Then the Agent's install re-pointed at
# another namespace (its saved namespace changed, the release unchanged) must
# be refused by Helm (its ClusterRole belongs to the release in the first
# namespace) and leave nothing in that namespace; then each role moves as its
# namespace warning says: the Agent uninstalled in the first namespace, then
# installed into the moved one, its collectors the same records; the Cluster's
# moved install refused alike, then uninstalled and installed, a new record,
# the old one stopping; a gateway installed into its new namespace first, then
# uninstalled in the old, new records, the old ones stopping, its Service's
# address moving; a second fleet of the same account installs its Agent and
# Cluster into namespaces of its own and enrolls beside the first's, the four
# ClusterRoles and the two DaemonSets' storage hostPaths distinct, the first
# fleet's collectors still moving on. Optionally
# (CHECK_HELM_NEW_DEFAULT_TOKEN=1) it revokes the default token, issues a new
# one and runs the Agent's command again with it: the token's checksum on the
# pod template rolls the DaemonSet (no `kubectl delete pod`):
# `kubectl rollout status`, each old pod waited for until it is deleted, then
# the collectors read, and only the new pods' records seen after that read
# count (only evidence that began after the restart completed), on the rotate
# token, while the others stay connected; it lists the new pod's storage
# directory (the node's /var/lib/telflo/supervisor/<fullname>; names only: no
# file beyond the supervisor's own state may hold what connection settings
# look like). Then it searches every file it leaves in the work directory for
# the secrets (every bearer and link secret it obtains, both fleets' creates,
# the reveals, the printed and the downloaded values files, the link and the
# registry's pull token, joins the secrets file the moment it exists; failing
# closed; a failed run's EXIT path searches them too, before its teardown, and
# names the paths only), uninstalls each release with its printed
# `helm uninstall` and deletes the namespaces it made (their PVCs with them),
# both fleets and the configuration. It never prints a values file, a Secret,
# a bearer or a link's secret: every diagnostic is redacted (`tqd_…` and every
# run of 20 or more base64 or base64url characters, `+` and `/` included), but
# for the storage listing's names, printed as they are once the listing is
# found to hold none of the run's secrets.
#
# Usage (the stack and the profile are the caller's; see
# docs/conventions/testing.md, "The real Helm install"):
#
#   COMPOSE_PROJECT_NAME=<project> COMPOSE_FILE=<its compose file> \
#   TELFLO_GATEWAY_URL=http://localhost:<gateway port> \
#   TELFLO_MAILPIT_API_URL=http://localhost:<mailpit's http port> \
#   KUBECONFIG=<work dir>/kubeconfig [CHECK_HELM_PROFILE=<profile, default d18-helm>] \
#   [CHECK_HELM_LOCAL_IMAGE=<a local image's tag>] [CHECK_HELM_IMAGE_PULLABLE=yes|no] \
#   [CHECK_HELM_NEW_DEFAULT_TOKEN=1] \
#   scripts/check-helm-install.sh <work dir>
#
# It refuses, before touching anything, unless COMPOSE_PROJECT_NAME is set and
# names a throwaway stack (not telflo, the self-host install's, telflo-dev,
# the development stack's, or a developer's own running stack's), the two URLs
# are set and aren't a developer's own stack's ports (50080, 58025), the work
# directory exists, CHECK_HELM_PROFILE (when set) is a DNS-1123 label, isn't
# minikube (a developer's own profile) and isn't a name YAML reads as a
# number, a boolean or null (kubectl writes such a name quoted, which the
# file's reading below refuses), and KUBECONFIG is one file in the work
# directory minified to the profile's context (`minikube -p <profile> kubectl
# -- config view --flatten --minify --context=<profile> > <work dir>/kubeconfig`):
# its only context and cluster the profile, its current context; and the
# server kubectl will use, resolved as kubectl resolves the current context
# (`kubectl config view --minify`), the profile's own https:// server on a
# port that isn't 8080 (as a number), reached directly: no proxy-url, no proxy
# variable (with no server, kubectl would reach http://localhost:8080, a
# developer's own development API); and, before those, the whole file only
# what minikube writes (an allowlist of keys, place by place, read from the
# file's own text, and exactly one cluster, context and user, each the
# profile; no exec plugin, auth-provider, proxy, TLS override or impersonation
# can get through). Every HELM_* variable of the caller's environment is unset
# (`helm env` names them: HELM_KUBECONTEXT, HELM_KUBEAPISERVER,
# HELM_KUBETOKEN, HELM_NAMESPACE, HELM_DRIVER… would send helm elsewhere than
# that context; a note names those unset, never their values), then Helm's
# homes (HELM_CACHE_HOME, HELM_CONFIG_HOME, HELM_DATA_HOME, its registry and
# repository config, its plugins) are set in the work directory, and the
# printed commands run with HOME and DOCKER_CONFIG there too. The chart is
# pulled anonymously, for real (Docker and Helm ask the macOS keychain's
# credential helper when their config holds no auth, and a stored ghcr.io
# login breaks even a public pull): the work directory's Docker config.json
# and Helm registry config are seeded `{"auths":{"telflo-check.invalid":{}}}`,
# and refusing stand-ins for docker-credential-osxkeychain,
# docker-credential-desktop and docker-credential-ecr-login (each logs its
# first argument to credential-helpers.log, never reads its input, exits 1)
# come first on PATH for every printed command: a stand-in called fails the
# run. Then it requires the stack's opamp-server to hand collectors
# OPAMP_SERVER_URL=http://host.minikube.internal:<its published agent
# port>/opamp/api/v1 (the facts' endpoint), and the API's
# TELFLO_PUBLIC_API_URL to be TELFLO_GATEWAY_URL (the link's curl runs on this
# machine); and none of the namespaces it makes may exist yet.
#
# The image: the pods run <the facts' image repository>:<the collector
# version> with pullPolicy IfNotPresent. Unless that tag can be pulled
# anonymously (asked of its registry with curl: a manifest HEAD with an
# anonymous token; CHECK_HELM_IMAGE_PULLABLE=yes or no skips the question),
# the local image CHECK_HELM_LOCAL_IMAGE (required then) is loaded into the
# profile (`minikube -p <profile> image load`) and tagged there as that tag.
# Step 0 runs a pod of that image in the profile that POSTs to the agent
# endpoint through host.minikube.internal and expects the agent door's 401
# (no token): a pod that can't reach the stack fails here, before any install.
#
# Needs docker (with compose), kubectl, helm, minikube, curl and jq. Every
# file it writes is in the work directory, 0600 (the cookie jar, the replies,
# the values files, the printed commands, the logs); the files holding a
# bearer or a link's secret are removed at the end. The account it registers
# stays in the throwaway stack; the profile is the caller's to delete.
set -euo pipefail

PROFILE=${CHECK_HELM_PROFILE:-d18-helm}
# The platform's own packages: the stack's defaults, and what this check installs.
PLATFORM_CHART_REFERENCE="oci://ghcr.io/telflo/telflo/charts/supervisor-collector"
PLATFORM_CHART_VERSION="0.1.0"
PLATFORM_IMAGE_REPOSITORY="ghcr.io/telflo/telflo/collector"
NS_NODE=telflo-hc-node
NS_CLUSTER=telflo-hc-cluster
NS_GATEWAYS=telflo-hc-gateways
NS_REACH=telflo-hc-reach
NS_MOVED=telflo-hc-moved
NS_CMOVED=telflo-hc-cmoved
NS_GMOVED=telflo-hc-gmoved
# Where each moved release runs (the moves below change them), and the records the moves replaced.
agent_dir=telflo-node
agent_ns=$NS_NODE
cluster_dir=telflo-cluster
cluster_ns=$NS_CLUSTER
gateway_ns=$NS_GATEWAYS
stale_ids=""
NS2_NODE=telflo-hc2-node
NS2_CLUSTER=telflo-hc2-cluster
GATEWAY_GROUP=gw-check
LINK_GROUP=gw-link
PASSWORD="a-sufficiently-long-password"
TERMS_VERSION="2026-01-01"

refuse() { echo "check-helm-install: refused: $*" >&2; exit 2; }
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "--- $*"; }
# redact: its standard input for a diagnostic, every tqd_… and every run of 20 or more base64 or base64url
# characters (a link's secret's, a bearer's shape: `+` and `/` included) replaced (bytes: LC_ALL=C).
redact() { LC_ALL=C sed -E -e 's#tqd_[A-Za-z0-9_-]+#[redacted]#g' -e 's#[A-Za-z0-9+/_=-]{20,}#[redacted]#g'; }

# ---- The refusals: nothing is touched before they pass (only kubectl's own reading of the KUBECONFIG file).
[ $# -eq 1 ] || refuse "usage: scripts/check-helm-install.sh <work dir> (see the comment at its top)"
case "$1" in /*) ;; *) refuse "the work directory must be an absolute path" ;; esac
[ -d "$1" ] || refuse "the work directory $1 doesn't exist"
work=$(cd "$1" && pwd -P)
[ -n "${COMPOSE_PROJECT_NAME:-}" ] ||
  refuse "COMPOSE_PROJECT_NAME isn't set: name the throwaway stack's compose project (never telflo, telflo-dev or another stack that isn't a throwaway)"
case "$COMPOSE_PROJECT_NAME" in
  telflo | telflo-dev | telflo-platform) refuse "COMPOSE_PROJECT_NAME is $COMPOSE_PROJECT_NAME, a stack that isn't a throwaway" ;;
esac
local_url='^http://(localhost|127[.]0[.]0[.]1):([0-9]+)$'
[[ "${TELFLO_GATEWAY_URL:-}" =~ $local_url ]] ||
  refuse "TELFLO_GATEWAY_URL must be the throwaway stack's gateway, http://localhost:<port> (or 127.0.0.1)"
[ "${BASH_REMATCH[2]}" != "50080" ] || refuse "TELFLO_GATEWAY_URL names port 50080, the owner's stack's gateway"
[[ "${TELFLO_MAILPIT_API_URL:-}" =~ $local_url ]] ||
  refuse "TELFLO_MAILPIT_API_URL must be the throwaway stack's Mailpit, http://localhost:<port> (or 127.0.0.1)"
[ "${BASH_REMATCH[2]}" != "58025" ] || refuse "TELFLO_MAILPIT_API_URL names port 58025, the owner's Mailpit"
case "${CHECK_HELM_IMAGE_PULLABLE:-}" in "" | yes | no) ;; *) refuse "CHECK_HELM_IMAGE_PULLABLE is yes, no or unset" ;; esac
case "${CHECK_HELM_NEW_DEFAULT_TOKEN:-}" in "" | 0 | 1) ;; *) refuse "CHECK_HELM_NEW_DEFAULT_TOKEN is 1, 0 or unset" ;; esac
if [ -n "${CHECK_HELM_LOCAL_IMAGE:-}" ]; then
  [[ "$CHECK_HELM_LOCAL_IMAGE" =~ ^[a-z0-9]+([._:/-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] ||
    refuse "CHECK_HELM_LOCAL_IMAGE isn't an image name with a tag"
fi
# A profile YAML 1.1 reads as a number (all digits, 1e3, 0x1f, 0o17, 0b101) or as a boolean or null (y, n, yes, no,
# true, false, on, off, null, ~, in any case) is written quoted by kubectl (`name: "123"`), and the kubeconfig's key
# allowlist below reads plain names only: refused here, saying why.
profile_lower=$(printf '%s' "$PROFILE" | tr '[:upper:]' '[:lower:]')
case "$profile_lower" in
  y | n | yes | no | true | false | on | off | null | "~")
    refuse "CHECK_HELM_PROFILE ($PROFILE) is a word YAML reads as a boolean or null: kubectl writes such a name quoted in the kubeconfig, which this check doesn't read; name another profile (default d18-helm)" ;;
esac
# A YAML 1.1 date (2001-12-14) too: kubectl writes it quoted.
[[ ! "$profile_lower" =~ ^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$ ]] ||
  refuse "CHECK_HELM_PROFILE ($PROFILE) is a date to YAML: kubectl writes such a name quoted in the kubeconfig, which this check doesn't read; name another profile (default d18-helm)"
[[ ! "$profile_lower" =~ ^([0-9]+(e-?[0-9]+)?|0x[0-9a-f]+|0o[0-7]+|0b[01]+)$ ]] ||
  refuse "CHECK_HELM_PROFILE ($PROFILE) is a number to YAML: kubectl writes such a name quoted in the kubeconfig, which this check doesn't read; name another profile (default d18-helm)"
[[ "$PROFILE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] && [ "${#PROFILE}" -le 63 ] ||
  refuse "CHECK_HELM_PROFILE must be a minikube profile's name, a DNS-1123 label (lowercase letters, digits and '-', at most 63; default d18-helm)"
[ "$PROFILE" != "minikube" ] ||
  refuse "CHECK_HELM_PROFILE is minikube, the owner's own profile: name a throwaway one (default d18-helm)"
kubeconfig_how="make it with: minikube -p $PROFILE kubectl -- config view --flatten --minify --context=$PROFILE >$work/kubeconfig"
[ -n "${KUBECONFIG:-}" ] || refuse "KUBECONFIG isn't set: $kubeconfig_how"
case "$KUBECONFIG" in *:*) refuse "KUBECONFIG names more than one file: name one, in the work directory" ;; esac
[ -f "$KUBECONFIG" ] && [ ! -L "$KUBECONFIG" ] || refuse "KUBECONFIG ($KUBECONFIG) isn't a regular file: $kubeconfig_how"
[ "$(cd "$(dirname "$KUBECONFIG")" && pwd -P)" = "$work" ] ||
  refuse "KUBECONFIG ($KUBECONFIG) isn't in the work directory $work: $kubeconfig_how"
command -v kubectl >/dev/null || refuse "kubectl isn't on PATH"
kube_contexts=$(kubectl config get-contexts -o name 2>/dev/null || true)
kube_clusters=$(kubectl config view -o jsonpath='{range .clusters[*]}{.name}{"\n"}{end}' 2>/dev/null || true)
kube_current=$(kubectl config current-context 2>/dev/null || true)
[ "$kube_contexts" = "$PROFILE" ] && [ "$kube_clusters" = "$PROFILE" ] ||
  refuse "KUBECONFIG isn't minified to the context $PROFILE (its contexts: $(echo $kube_contexts); its clusters: $(echo $kube_clusters)): $kubeconfig_how"
[ "$kube_current" = "$PROFILE" ] || refuse "KUBECONFIG's current context is ${kube_current:-none}, not $PROFILE: $kubeconfig_how"
# The kubeconfig the check hands kubectl and Helm holds only what minikube writes: an ALLOWLIST, so no key kubectl or
# Helm would act on (a user's exec plugin or auth-provider, a proxy, a TLS override, an impersonation) gets through,
# whatever the key. Two reads, neither printed, both of the file only:
#   1. the file's own text, which both kubectl and Helm read: every line a block-style `key: value` line (no flow
#      mapping but `preferences: {}`, no comment, quote, anchor, tag, block scalar or continuation), so every key
#      shows, and each key allowed at its place (the allowlist below). The text, not kubectl's view, holds the
#      allowlist: kubectl drops the keys its own client-go doesn't know when it reads a kubeconfig, and Helm's
#      client-go is another version, so a key Helm acts on could be missing from kubectl's view;
#   2. the whole file as kubectl reads it (`kubectl config view --raw -o json`, not minified, so a second cluster,
#      context or user shows): exactly one of each, each named the profile, the context's cluster and user the
#      profile, the current context the profile, preferences empty, each extension minikube's.
# A refusal names the key and its place, never a value. minikube writes (pkg/minikube/kubeconfig): one cluster
# (server, certificate-authority and its extension cluster_info), one context (cluster, user, namespace and its
# extension context_info), one user (client-certificate and client-key; their -data forms and a token allowed too),
# each named after the profile, and `preferences: {}`; an extension holds provider minikube.sigs.k8s.io, version
# and last-update only (minikube's kubeconfig Extension).
command -v python3 >/dev/null || refuse "python3 isn't on PATH (it reads the kubeconfig's shape)"
KUBECONFIG_SHAPE_READER='
import json, re, sys
profile, path = sys.argv[1], sys.argv[2]
def refuse(words):
    print(words)
    sys.exit(0)
EXTENSION = {"name", "extension"}
EXTENSION_FIELDS = {"last-update", "provider", "version"}
ALLOWED = {
    (): {"apiVersion", "kind", "clusters", "contexts", "users", "current-context", "preferences"},
    ("clusters",): {"name", "cluster"},
    ("clusters", "cluster"): {"server", "certificate-authority", "certificate-authority-data", "extensions"},
    ("clusters", "cluster", "extensions"): EXTENSION,
    ("clusters", "cluster", "extensions", "extension"): EXTENSION_FIELDS,
    ("contexts",): {"name", "context"},
    ("contexts", "context"): {"cluster", "user", "namespace", "extensions"},
    ("contexts", "context", "extensions"): EXTENSION,
    ("contexts", "context", "extensions", "extension"): EXTENSION_FIELDS,
    ("users",): {"name", "user"},
    ("users", "user"): {"client-certificate", "client-certificate-data", "client-key", "client-key-data", "token", "extensions"},
}
def place(path):
    return " ".join(path) if path else "top level"
line_shape = re.compile(r"^( *)(- )?([A-Za-z][A-Za-z0-9_-]*):( (.*))?$")
try:
    text = open(path, encoding="ascii").read()
except Exception:
    refuse("KUBECONFIG isn'"'"'t a plain ASCII file")
stack = []  # (indent, key) of each mapping open above the line
for number, line in enumerate(text.split("\n"), 1):
    if line == "":
        continue
    found = line_shape.match(line)
    if not found:
        refuse("KUBECONFIG'"'"'s line %d isn'"'"'t a block-style key: value line, the shape kubectl writes" % number)
    indent = len(found.group(1)) + (2 if found.group(2) else 0)
    key, value = found.group(3), found.group(5) or ""
    while stack and stack[-1][0] >= indent:
        stack.pop()
    path = tuple(k for _, k in stack)
    allowed = ALLOWED.get(path)
    if allowed is None or key not in allowed:
        refuse("KUBECONFIG'"'"'s %s holds the key %s, which minikube doesn'"'"'t write there" % (place(path), key))
    if value[:1] in ("{", "[", "&", "*", "!", "|", ">", "\"", "'"'"'", "#", "%", "@", "`") and line != "preferences: {}":
        refuse("KUBECONFIG'"'"'s %s %s isn'"'"'t a plain value (a flow collection, quote, anchor, tag or block scalar)" % (place(path), key))
    stack.append((indent, key))
try:
    config = json.load(sys.stdin)
except Exception:
    refuse("kubectl couldn'"'"'t read KUBECONFIG as a kubeconfig")
if config.get("preferences", {}) != {}:
    refuse("KUBECONFIG'"'"'s preferences aren'"'"'t empty")
for section, entry in (("clusters", "cluster"), ("contexts", "context"), ("users", "user")):
    items = config.get(section) or []
    if len(items) != 1:
        refuse("KUBECONFIG holds %d %s, not exactly one" % (len(items), section))
    if items[0].get("name") != profile:
        refuse("KUBECONFIG'"'"'s %s isn'"'"'t named %s" % (entry, profile))
context = config["contexts"][0].get("context") or {}
if context.get("cluster") != profile or context.get("user") != profile:
    refuse("KUBECONFIG'"'"'s context doesn'"'"'t name the cluster and the user %s" % profile)
if config.get("current-context") != profile:
    refuse("KUBECONFIG'"'"'s current context isn'"'"'t %s" % profile)
for entry, name in (("cluster", "cluster_info"), ("context", "context_info"), ("user", None)):
    for extension in (config[entry + "s"][0].get(entry) or {}).get("extensions") or []:
        if name is None or extension.get("name") != name:
            refuse("KUBECONFIG'"'"'s %s holds an extension minikube doesn'"'"'t write there" % entry)
        if (extension.get("extension") or {}).get("provider") != "minikube.sigs.k8s.io":
            refuse("KUBECONFIG'"'"'s %s extension %s isn'"'"'t minikube'"'"'s (provider minikube.sigs.k8s.io)" % (entry, name))
print("ok")
'
kube_shape=$(kubectl config view --raw -o json 2>/dev/null | python3 -I -c "$KUBECONFIG_SHAPE_READER" "$PROFILE" "$KUBECONFIG" 2>/dev/null || true)
[ "$kube_shape" = "ok" ] ||
  refuse "${kube_shape:-the kubeconfig's shape couldn't be read}: the check takes only minikube's kubeconfig ($kubeconfig_how)"
# No kubectl call may reach anything but the profile's cluster, directly. The server kubectl WILL use is the one the
# current context's cluster names, as `kubectl config view --minify` resolves it (a read of the file only; it fails on
# a context naming a cluster the file doesn't hold): that context's cluster must be the profile; its server an
# https:// address (none, or http://, would send kubectl to http://localhost:8080, a developer's own development API)
# whose port, read as a number, isn't 8080 (no leading zero, digits only); no proxy-url; and no proxy variable in the
# environment (kubectl would reach the server through it). All before any call that talks to a cluster.
minified=$(kubectl config view --minify \
  -o jsonpath='{.contexts[0].context.cluster}{"\n"}{.clusters[0].name}{"\n"}{.clusters[0].cluster.server}{"\n"}{.clusters[0].cluster.proxy-url}{"\n"}' 2>/dev/null) ||
  refuse "KUBECONFIG's current context $PROFILE names a cluster the file doesn't hold (kubectl config view --minify fails): $kubeconfig_how"
kube_context_cluster=$(printf '%s\n' "$minified" | sed -n 1p)
kube_minified_cluster=$(printf '%s\n' "$minified" | sed -n 2p)
kube_server=$(printf '%s\n' "$minified" | sed -n 3p)
kube_proxy_url=$(printf '%s\n' "$minified" | sed -n 4p)
[ "$kube_context_cluster" = "$PROFILE" ] && [ "$kube_minified_cluster" = "$PROFILE" ] ||
  refuse "KUBECONFIG's current context $PROFILE names the cluster '$kube_context_cluster', not $PROFILE: $kubeconfig_how"
[ -z "$kube_proxy_url" ] ||
  refuse "KUBECONFIG's cluster $PROFILE names a proxy-url: kubectl would reach the profile through it, not directly: $kubeconfig_how"
[[ "$kube_server" =~ ^https://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(:([^/]*))?(/.*)?$ ]] ||
  refuse "KUBECONFIG's cluster $PROFILE names the server '$(printf '%s' "$kube_server" | redact)', not an https:// address (kubectl would reach http://localhost:8080, the owner's development API, for an empty one): $kubeconfig_how"
if [ -n "${BASH_REMATCH[2]}" ]; then
  kube_port=${BASH_REMATCH[3]}
  [[ "$kube_port" =~ ^[1-9][0-9]{0,4}$ ]] && [ $((10#$kube_port)) -le 65535 ] ||
    refuse "KUBECONFIG's cluster $PROFILE names a server whose port isn't a port number (digits, no leading zero, at most 65535): $kubeconfig_how"
  [ $((10#$kube_port)) -ne 8080 ] ||
    refuse "KUBECONFIG's cluster $PROFILE names a server on port 8080 (the owner's development API's port), not the profile's: $kubeconfig_how"
fi
for proxy in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; do
  [ -z "${!proxy:-}" ] ||
    refuse "$proxy is set: kubectl and helm would reach the profile through that proxy, not directly (unset it for this check)"
done
export KUBECONFIG
chmod 0600 "$KUBECONFIG"

for tool in docker helm minikube curl jq; do command -v "$tool" >/dev/null || fail "$tool isn't on PATH"; done
umask 077
repo_dir=$(cd "$(dirname "$0")/.." && pwd -P)
# Helm reads where it connects (HELM_KUBEAPISERVER, HELM_KUBETOKEN, HELM_KUBECONTEXT, HELM_KUBECAFILE, HELM_KUBEAS*,
# HELM_KUBEINSECURE_SKIP_TLS_VERIFY, HELM_KUBETLS_SERVER_NAME), its namespace, its release storage (HELM_DRIVER…),
# its plugins and its homes from HELM_* variables: every one the shell holds (the caller's exports among them, by
# bash's own `${!HELM_@}`) is unset (its name noted, never its value), so helm reads only KUBECONFIG's context and
# the work directory's homes set after it.
helm_unset=""
for name in ${!HELM_@}; do
  helm_unset="$helm_unset $name"
  unset "$name"
done
[ -z "$helm_unset" ] || echo "    note: unset from the environment, so helm reads only KUBECONFIG and the work directory:$helm_unset"
export HELM_CACHE_HOME="$work/helm/cache" HELM_CONFIG_HOME="$work/helm/config" HELM_DATA_HOME="$work/helm/data"
export HELM_REGISTRY_CONFIG="$work/helm/registry.json" HELM_REPOSITORY_CACHE="$work/helm/cache/repository"
export HELM_REPOSITORY_CONFIG="$work/helm/config/repositories.yaml" HELM_PLUGINS="$work/helm/data/plugins"
helm_home="$work/helm/home"
helm_docker_config="$work/helm/docker-config"
mkdir -p "$HELM_CACHE_HOME" "$HELM_CONFIG_HOME" "$HELM_DATA_HOME" "$helm_home" "$helm_docker_config"
# The anonymous pull, for real: Docker's config and Helm's registry config hold an auth entry for a name that resolves
# nowhere (so neither looks for a credential store), and refusing stand-ins for the credential helpers Docker and Helm
# would otherwise ask (the macOS keychain's among them) come first on PATH for every printed command. A stand-in logs
# its first argument only (`get`, `list`…), never reads its input, and exits 1; a line in their log fails the run
# (credential_helpers_called).
printf '{"auths":{"telflo-check.invalid":{}}}\n' >"$helm_docker_config/config.json"
printf '{"auths":{"telflo-check.invalid":{}}}\n' >"$HELM_REGISTRY_CONFIG"
CREDENTIAL_HELPERS="$work/credential-helpers"
CREDENTIAL_HELPERS_LOG="$work/credential-helpers.log"
mkdir -p "$CREDENTIAL_HELPERS"
: >"$CREDENTIAL_HELPERS_LOG"
for helper in docker-credential-osxkeychain docker-credential-desktop docker-credential-ecr-login; do
  printf '#!/bin/sh\n# A refusing stand-in (scripts/check-helm-install.sh): logs its name and first argument, never reads its input.\nprintf "%%s %%s\\n" "%s" "$1" >>"$(dirname "$0")/../credential-helpers.log"\nexit 1\n' "$helper" \
    >"$CREDENTIAL_HELPERS/$helper"
  chmod 0700 "$CREDENTIAL_HELPERS/$helper"
done
COMMAND_PATH="$CREDENTIAL_HELPERS:$PATH"
# credential_helpers_called: true (and its lines on stdout, names and first arguments only) when a stand-in ran.
credential_helpers_called() {
  [ -s "$CREDENTIAL_HELPERS_LOG" ] || return 1
  sort -u "$CREDENTIAL_HELPERS_LOG" | tr '\n' ';'
}
JAR="$work/cookies"
REPLY_BODY="$work/reply-body"
REPLY_HEADERS="$work/reply-headers"
SECRETS="$work/secrets"
KEPT="$work/kept-files"
: >"$SECRETS"

# ---- What the run makes, removed at its end or by the EXIT trap, best effort, in this order: each installed
# release by its printed uninstall, the namespaces it made, the Helm link (revoked), the fleets, the
# configuration, then the files holding a secret.
installed_releases=""   # the directories under $work holding an uninstall.sh
made_namespaces=""
fleet_id=""
fleet2_id=""
configuration_id=""
link_id=""
FLEETS_URL=""
CONFIGURATIONS_URL=""
teardown() {
  local dir namespace id
  set +e
  for dir in $installed_releases; do
    echo "--- teardown: helm uninstall (the printed command) for $dir"
    (cd "$work/$dir" && PATH="$COMMAND_PATH" HOME="$helm_home" DOCKER_CONFIG="$helm_docker_config" bash ./uninstall.sh) 2>&1 | redact
  done
  installed_releases=""
  for namespace in $made_namespaces; do
    echo "--- teardown: kubectl delete namespace $namespace"
    kubectl delete namespace "$namespace" --ignore-not-found --wait=true --timeout=300s 2>&1 | redact
  done
  made_namespaces=""
  if [ -n "$link_id" ]; then platform POST "$FLEETS_URL/$fleet_id/quick-deploy-links/$link_id/revoke"; link_id=""; fi
  for id in $fleet_id $fleet2_id; do
    platform DELETE "$FLEETS_URL/$id"
    echo "--- teardown: the fleet $id's delete answered HTTP $status"
  done
  fleet_id=""
  fleet2_id=""
  if [ -n "$configuration_id" ]; then
    platform DELETE "$CONFIGURATIONS_URL/$configuration_id"
    echo "--- teardown: the configuration's delete answered HTTP $status"
    configuration_id=""
  fi
  local file removed=()
  while IFS= read -r -d '' file; do removed+=("$file"); done < <(secret_files)
  [ "${#removed[@]}" = 0 ] || rm -f -- "${removed[@]}"
  set -e
}
# secret_files: the files the teardown removes, NUL-separated, those that exist: the secrets file, the replies' body,
# the jar, the sweep's lists, and in each release's directory (one level down) its printed.json, its values files and
# its Quick Deploy command, and the registry step's token reply and header file (each holds, or may hold, a bearer or
# the link's secret). The one list both the teardown removes and the sweeps skip, so they reach exactly the same
# files, at the same depths.
secret_files() {
  local file
  for file in "$SECRETS" "$REPLY_BODY" "$JAR" "$KEPT" "$KEPT.found" \
    "$work/registry-token.json" "$work/registry-headers" \
    "$work"/*/printed.json "$work"/*/*-values*.yaml "$work"/*/quick-deploy.sh; do
    if [ -e "$file" ]; then printf '%s\0' "$file"; fi
  done
  return 0
}
# list_kept: every other file in the work directory, NUL-separated, into $KEPT (what the sweeps search); false when
# find fails.
list_kept() {
  local file each skip listed=()
  : >"$KEPT"
  : >"$KEPT.found"
  while IFS= read -r -d '' file; do listed+=("$file"); done < <(secret_files)
  find "$work" -type f -print0 >"$KEPT.found" || return 1
  while IFS= read -r -d '' file; do
    skip=no
    for each in ${listed[@]+"${listed[@]}"}; do
      if [ "$file" = "$each" ]; then skip=yes && break; fi
    done
    [ "$skip" = yes ] || printf '%s\0' "$file" >>"$KEPT"
  done <"$KEPT.found"
}
# report_kept: a failed run's sweep, in its EXIT path before the teardown removes the secrets file: each file left that
# holds a bearer or the link's secret (or can't be searched) named by its path, never its contents. Report only: the
# run has failed already.
report_kept() {
  local kept searched=0 named=0
  if [ ! -s "$SECRETS" ]; then
    echo "--- the failed run's sweep: no bearer or link secret was handled yet, nothing to search for"
    return 0
  fi
  echo "--- the failed run's sweep (report only, before the teardown): the files left in $work that hold a bearer or the link's secret, by path"
  if ! list_kept; then
    echo "    listing the files left in $work failed: nothing searched"
    return 0
  fi
  while IFS= read -r -d '' kept; do
    searched=$((searched + 1))
    if ! clean "$kept"; then
      echo "    $kept holds a bearer or the link's secret, or couldn't be searched for them (the file not printed)"
      named=$((named + 1))
    fi
  done <"$KEPT"
  echo "    $searched files searched, $named named"
}
on_exit() {
  local code=$? called
  set +e
  if [ "$code" != 0 ]; then report_kept; fi
  teardown
  if called=$(credential_helpers_called); then echo "--- teardown: a credential helper's stand-in was called: $called" >&2; fi
}
trap on_exit EXIT

# platform <method> <url> [<json body>]: one call through the gateway as the signed-in person (the jar,
# X-Telflo-CSRF); the status into $status, the body into $REPLY_BODY, the headers into $REPLY_HEADERS (0600).
platform() {
  local args=(-s --max-time 60 -o "$REPLY_BODY" -D "$REPLY_HEADERS" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$1"
    -H 'X-Telflo-CSRF: 1')
  if [ $# -ge 3 ]; then args+=(-H 'content-type: application/json' --data-binary "$3"); fi
  status=$(: >"$REPLY_BODY" && curl "${args[@]}" "$2" || true)
  # A long run outlives the access cookie: refreshed once, then the call again.
  if [ "$status" = "401" ] && [ "$(reply_code)" = "access_token_expired" ]; then
    curl -s -o /dev/null --max-time 30 -b "$JAR" -c "$JAR" -X POST -H 'X-Telflo-CSRF: 1' "$TELFLO_GATEWAY_URL/api/v1/auth/refresh" || true
    status=$(: >"$REPLY_BODY" && curl "${args[@]}" "$2" || true)
  fi
}
reply_json() { jq -r "$@" "$REPLY_BODY" 2>/dev/null || true; }
reply_code() { local code; code=$(reply_json '.error.code // empty'); echo "${code:-no error code}"; }
no_store() { grep -qiE '^cache-control:[[:space:]]*no-store' "$REPLY_HEADERS"; }
# clean <file>: true when the file holds none of the secrets (a missing file holds none), false when it holds one
# or can't be searched (grep's 2, an empty or missing secrets file among its causes: it fails closed).
clean() {
  local code=0
  [ -s "$SECRETS" ] || return 1
  [ -e "$1" ] || return 0
  grep -qF -f "$SECRETS" -- "$1" || code=$?
  [ "$code" = "1" ]
}
# secret <value>: adds a bearer or a link's secret to the secrets file (printf is a builtin: no argv).
secret() { printf '%s\n' "$1" >>"$SECRETS"; }
# The invariant: every bearer or link secret the run obtains joins the secrets file the moment it exists, before
# anything else reads or logs what holds it, so no file the run leaves or prints goes unsearched for it. The places it
# obtains one, each audited:
#   1. each fleet's create reply (the first fleet's and the second's): the default and rotate tokens' bearers (each
#      sealed anew, so neither is a later reveal's text): read from the reply into the secrets file, shape-checked,
#      before anything else reads it;
#   2. each fleet's default token's reveal: its bearer;
#   3. the values files printed by the contracts (print_install, from a reveal's or the new token's bearer): each
#      file's token line read back into the secrets file as soon as it is written;
#   4. the Helm link's create reply: its url's secret (the url is the secret's only copy);
#   5. the Quick Deploy command's download (its curl, inside the printed command): the values file it leaves holds a
#      bearer sealed anew for that download, no other's text: its token line read into the secrets file as soon as
#      the printed command returns, before its log is read, printed or searched (run_command), even on a failure;
#   6. the new default token's issue (CHECK_HELM_NEW_DEFAULT_TOKEN=1): its bearer;
#   7. the registry's anonymous pull token (the image's question, unless CHECK_HELM_IMAGE_PULLABLE is set): a bearer
#      for ghcr.io, into the secrets file before it is used, its files removed at once.
# What else it downloads holds none: the facts (checked for a bearer's shape), the collector and link lists, the
# chart (Helm's own pull, its homes searched), the storage listing (names only), the objects' names and paths read
# with kubectl. Neither the email's one-use verification token (spent at once, in no file) nor the session cookies
# (curl's jar, never read here, removed) is a bearer or a link's secret.
BEARER_SHAPE='^[A-Za-z0-9+/]{100,}={0,2}$'
VALUES_TOKEN_LINE='^token: "([A-Za-z0-9+/]{100,}={0,2})"$'
# bearer_secret <value>: a bearer of its shape joins the secrets file (true); anything else is left out (false).
bearer_secret() {
  [[ "$1" =~ $BEARER_SHAPE ]] || return 1
  secret "$1"
}
# values_secret <values file>: every token line of a bearer's shape in the file (the contracts' helmValuesYaml writes
# `token: "<bearer>"`) joins the secrets file, read by bash's own read and match (on no command line, never printed);
# true only when exactly one line has that shape.
values_secret() {
  local line found=0
  [ -f "$1" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ $VALUES_TOKEN_LINE ]]; then
      secret "${BASH_REMATCH[1]}"
      found=$((found + 1))
    fi
  done <"$1"
  [ "$found" = "1" ]
}
# shown <file> [<lines>]: a diagnostic's text: the file's last lines, redacted.
shown() { tail -n "${2:-30}" "$1" 2>/dev/null | redact; }
uuid4() {
  local hex
  hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s-%s-4%s-%x%s-%s\n' "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" $(((0x${hex:16:2} & 0x3f) | 0x80)) "${hex:18:2}" "${hex:20:12}"
}

# ---- The stack and the profile.
step "the throwaway stack $COMPOSE_PROJECT_NAME: the opamp-server's published agent port and OPAMP_SERVER_URL, the API's TELFLO_PUBLIC_API_URL"
published_agent=$(docker compose port telflo-opamp-server 51234 2>/dev/null | tail -n1 || true)
[[ "$published_agent" =~ :([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" != "0" ] ||
  fail "the compose project $COMPOSE_PROJECT_NAME publishes no agent port (docker compose port telflo-opamp-server 51234 answered '$published_agent'): is it up, with COMPOSE_FILE its file?"
agent_port=${BASH_REMATCH[1]}
endpoint="http://host.minikube.internal:$agent_port/opamp/api/v1"
opamp_container=$(docker compose ps -q telflo-opamp-server)
server_url=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$opamp_container" | sed -n 's/^OPAMP_SERVER_URL=//p')
[ "$server_url" = "$endpoint" ] ||
  fail "the opamp-server hands collectors $server_url: start the stack with OPAMP_SERVER_URL=$endpoint (a pod in the profile reaches the stack's published agent port through host.minikube.internal)"
public_api_url=$(docker compose exec -T telflo-api printenv TELFLO_PUBLIC_API_URL) || fail "couldn't read the API's TELFLO_PUBLIC_API_URL"
[ "$public_api_url" = "$TELFLO_GATEWAY_URL" ] ||
  fail "the API's TELFLO_PUBLIC_API_URL is $public_api_url: start the stack with TELFLO_PUBLIC_API_URL=$TELFLO_GATEWAY_URL (the Helm link's curl runs on this machine)"
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$TELFLO_GATEWAY_URL/register" || true)
[ "$status" = "200" ] || fail "the gateway at $TELFLO_GATEWAY_URL answered /register HTTP $status"

step "the profile $PROFILE: its nodes, and none of the namespaces this check makes ($NS_NODE, $NS_CLUSTER, $NS_GATEWAYS, $NS_REACH, $NS_MOVED, $NS_CMOVED, $NS_GMOVED, $NS2_NODE, $NS2_CLUSTER)"
node_count=$(kubectl get nodes -o name 2>"$work/kubectl.err" | grep -c . || true)
[ "${node_count:-0}" -ge 1 ] 2>/dev/null || fail "the profile $PROFILE answers no node: $(shown "$work/kubectl.err" 5)"
for namespace in "$NS_NODE" "$NS_CLUSTER" "$NS_GATEWAYS" "$NS_REACH" "$NS_MOVED" "$NS_CMOVED" "$NS_GMOVED" "$NS2_NODE" "$NS2_CLUSTER"; do
  if kubectl get namespace "$namespace" >/dev/null 2>&1; then
    fail "the namespace $namespace already exists in $PROFILE: this check deletes only what it made (kubectl delete namespace $namespace, then run it again)"
  fi
done

# ---- A person on the platform: registered, verified through the stack's Mailpit, signed in.
email="helm-check-$(date +%s)-$$@example.com"
step "register $email through the gateway, verify it from Mailpit's email and sign in"
status=$(curl -s -o "$REPLY_BODY" -w '%{http_code}' -X POST "$TELFLO_GATEWAY_URL/api/v1/auth/register" -H 'content-type: application/json' \
  -H 'X-Telflo-CSRF: 1' --data-binary "$(jq -cn --arg e "$email" --arg p "$PASSWORD" --arg t "$TERMS_VERSION" \
  '{email: $e, password: $p, acceptedTermsVersion: $t}')" || true)
[ "$status" = "200" ] || fail "register returned HTTP $status: $(reply_code)"
message_id=""
for _ in $(seq 1 30); do
  message_id=$(curl -s "$TELFLO_MAILPIT_API_URL/api/v1/search?query=to:%22$email%22" | jq -r '.messages[0].ID // empty' || true)
  [ -n "$message_id" ] && break
  sleep 1
done
[ -n "$message_id" ] || fail "no verification email to $email reached $TELFLO_MAILPIT_API_URL within 30 s"
verify_token=$(curl -s "$TELFLO_MAILPIT_API_URL/api/v1/message/$message_id" | jq -r '.Text' |
  grep -oE '/verify-email\?token=[A-Za-z0-9_-]+' | head -n1 | sed 's/.*token=//' || true)
[ -n "$verify_token" ] || fail "the verification email holds no link"
status=$(curl -s -o "$REPLY_BODY" -w '%{http_code}' -X POST "$TELFLO_GATEWAY_URL/api/v1/auth/verify-email" -H 'content-type: application/json' \
  -H 'X-Telflo-CSRF: 1' --data-binary "$(jq -cn --arg t "$verify_token" '{token: $t}')" || true)
[ "$status" = "200" ] || fail "verify-email returned HTTP $status: $(reply_code)"
unset verify_token
status=$(curl -s -o "$REPLY_BODY" -w '%{http_code}' -c "$JAR" -X POST "$TELFLO_GATEWAY_URL/api/v1/auth/sessions" -H 'content-type: application/json' \
  -H 'X-Telflo-CSRF: 1' --data-binary "$(jq -cn --arg e "$email" --arg p "$PASSWORD" '{email: $e, password: $p}')" || true)
[ "$status" = "200" ] || fail "sign-in returned HTTP $status: $(reply_code)"
platform GET "$TELFLO_GATEWAY_URL/api/v1/auth/me"
organization_id=$(reply_json '.organization.id')
[ "$status" = "200" ] && [[ "$organization_id" =~ ^[0-9a-f-]{36}$ ]] || fail "/me returned HTTP $status, no organization"
ORGANIZATION_URL="$TELFLO_GATEWAY_URL/api/v1/organizations/$organization_id"
CONFIGURATIONS_URL="$ORGANIZATION_URL/configurations"
FLEETS_URL="$ORGANIZATION_URL/fleets"

step "publish a configuration (an OTLP receiver to the debug exporter) through the gateway: its version 1"
CONFIGURATION_YAML=$'# D17d-2: published by scripts/check-helm-install.sh\nreceivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 127.0.0.1:4320\nprocessors:\n  batch: {}\nexporters:\n  debug:\n    verbosity: basic\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [debug]\n'
platform POST "$CONFIGURATIONS_URL" "$(jq -cn --arg n "Helm check $(date +%s)-$$" '{name: $n, description: "scripts/check-helm-install.sh"}')"
[ "$status" = "201" ] || fail "creating the configuration returned HTTP $status: $(reply_code)"
configuration_id=$(reply_json '.configuration.id')
platform GET "$CONFIGURATIONS_URL/$configuration_id"
version_id=$(reply_json '.version.id')
[ "$status" = "200" ] && [ -n "$version_id" ] || fail "reading the configuration returned HTTP $status: $(reply_code)"
platform PATCH "$CONFIGURATIONS_URL/$configuration_id/versions/$version_id" \
  "$(jq -cn --arg y "$CONFIGURATION_YAML" '{yamlContent: $y, nodes: [], edges: [], pipelines: []}')"
[ "$status" = "200" ] || fail "saving the configuration returned HTTP $status: $(reply_code)"
platform POST "$CONFIGURATIONS_URL/$configuration_id/versions/$version_id/publish"
[ "$status" = "200" ] || fail "publishing the configuration returned HTTP $status: $(reply_code)"

# create_fleet <id> <label>: a kubernetes-supervisor fleet; its default and rotate bearers read only into the secrets
# file (the invariant's place 1, before anything else reads the reply); its Default group's, default and rotate
# tokens' ids into $created_default_group, $created_default_token and $created_rotate_token.
create_fleet() {
  local bearers=0
  platform POST "$FLEETS_URL" "$(jq -cn --arg id "$1" --arg l "$2" '{id: $id, label: $l, type: "kubernetes-supervisor", rotateExpiresAt: null}')"
  bearer_secret "$(reply_json '.tokens.default.bearer')" && bearers=$((bearers + 1))
  bearer_secret "$(reply_json '.tokens.rotate.bearer')" && bearers=$((bearers + 1))
  [ "$status" = "201" ] || fail "creating the fleet $1 returned HTTP $status: $(reply_code)"
  [ "$bearers" = "2" ] || fail "the fleet $1's create answered $bearers of its two bearers of a bearer's shape (neither printed)"
  created_default_group=$(reply_json '.defaultGroup.id')
  created_default_token=$(reply_json '.tokens.default.id')
  created_rotate_token=$(reply_json '.tokens.rotate.id')
  : >"$REPLY_BODY"
}
# save_agent <fleet url> <group id> <namespace>: the Agent's Kubernetes settings saved (role node, that namespace).
save_agent() {
  platform PATCH "$1/groups/$2" "$(jq -cn --arg ns "$3" '{annotations: {telflo: {kubernetes: {role: "node", namespace: $ns, volumes: []}}}}')"
  [ "$status" = "200" ] || fail "saving the Agent's settings (namespace $3) returned HTTP $status: $(reply_code)"
}
# make_group <fleet url> <name> <settings JSON>: a group with version 1 and those Kubernetes settings; its id on stdout.
make_group() {
  platform POST "$1/groups" "$(jq -cn --arg n "$2" --arg v "$version_id" --argjson k "$3" \
    '{name: $n, assignedVersionId: $v, annotations: {telflo: {kubernetes: $k}}}')"
  [ "$status" = "201" ] || fail "creating the group $2 returned HTTP $status: $(reply_code)"
  reply_json '.group.id'
}

fleet_id=$(uuid4)
step "create a kubernetes-supervisor fleet (its two bearers read only into the secrets file), then its groups: the Agent in $NS_NODE, the Cluster in $NS_CLUSTER, the gateways $GATEWAY_GROUP (2 replicas, a read-only hostPath volume) and $LINK_GROUP (1) in $NS_GATEWAYS, each assigned version 1"
create_fleet "$fleet_id" "helm-check-$(date +%s)-$$"
agent_group_id=$created_default_group
default_token_id=$created_default_token
rotate_token_id=$created_rotate_token
FLEET_URL="$FLEETS_URL/$fleet_id"
save_agent "$FLEET_URL" "$agent_group_id" "$NS_NODE"
platform PATCH "$FLEET_URL/groups/$agent_group_id" "$(jq -cn --arg v "$version_id" '{assignedVersionId: $v}')"
[ "$status" = "200" ] || fail "assigning version 1 to the Agent returned HTTP $status: $(reply_code)"
cluster_group_id=$(make_group "$FLEET_URL" cluster "$(jq -cn --arg ns "$NS_CLUSTER" '{role: "cluster", namespace: $ns, volumes: []}')")
gateway_group_id=$(make_group "$FLEET_URL" "$GATEWAY_GROUP" "$(jq -cn --arg ns "$NS_GATEWAYS" '{role: "gateway", namespace: $ns, replicas: 2,
  volumes: [{hostPath: "/var/log", hostPathType: "Directory", mountPath: "/var/log/host", readOnly: true}]}')")
link_group_id=$(make_group "$FLEET_URL" "$LINK_GROUP" "$(jq -cn --arg ns "$NS_GATEWAYS" '{role: "gateway", namespace: $ns, replicas: 1, volumes: []}')")

# facts_of <fleet url> <group id> <file>: the group's Helm facts (no-store, no bearer), its endpoint the stack's, the
# platform's chart and image repository, into <file>.
facts_of() {
  platform GET "$1/groups/$2/install"
  [ "$status" = "200" ] || fail "reading the Helm facts of $2 returned HTTP $status: $(reply_code)"
  no_store || fail "the Helm facts of $2 aren't Cache-Control: no-store"
  if [ "$(reply_json '[.. | objects | has("bearer")] | any')" != "false" ] || grep -qE '[A-Za-z0-9+/]{100,}' "$REPLY_BODY"; then
    fail "the Helm facts of $2 carry a bearer's shape"
  fi
  [ "$(reply_json '.endpoint')" = "$endpoint" ] ||
    fail "the Helm facts name the endpoint $(reply_json '.endpoint'), not $endpoint: the API's TELFLO_OPAMP_AGENT_PUBLIC_URL must be OPAMP_SERVER_URL (compose sets both from it)"
  [ "$(reply_json '.helm.chartReference')" = "$PLATFORM_CHART_REFERENCE" ] && [ "$(reply_json '.helm.chartVersion')" = "$PLATFORM_CHART_VERSION" ] &&
    [ "$(reply_json '.helm.imageRepository')" = "$PLATFORM_IMAGE_REPOSITORY" ] ||
    fail "the Helm facts of $2 name the chart $(reply_json '.helm.chartReference') $(reply_json '.helm.chartVersion') and the image repository $(reply_json '.helm.imageRepository'), not the platform's $PLATFORM_CHART_REFERENCE $PLATFORM_CHART_VERSION and $PLATFORM_IMAGE_REPOSITORY (TELFLO_HELM_CHART_REFERENCE, TELFLO_HELM_CHART_VERSION and TELFLO_COLLECTOR_IMAGE_REPOSITORY must be the defaults: this check installs the published packages)"
  cp "$REPLY_BODY" "$3"
}
# expect_facts <dir> <release> <namespace> <fullnameOverride, or null>: the facts in <dir> name them (the Agent's and
# the Cluster's override the fleet id's first 8 characters and -default or -cluster, a gateway's none).
expect_facts() {
  [ "$(jq -r --arg r "$2" --arg ns "$3" --argjson o "$4" \
    '.helm.release == $r and .helm.namespace == $ns and (.helm | has("fullnameOverride")) and .helm.fullnameOverride == $o' \
    "$work/$1/facts.json")" = "true" ] ||
    fail "the Helm facts in $1 aren't the release $2 in $3 with the fullnameOverride $4: $(jq -c '.helm | {release, namespace, fullnameOverride}' "$work/$1/facts.json")"
}
# fullname_of <dir>: the chart's name for the release's objects (its pods' app label, its ClusterRole, the node's
# state path): the facts' fullnameOverride, else (a gateway) its release, the gateway's name.
fullname_of() { jq -r '.helm.fullnameOverride // .helm.release' "$work/$1/facts.json"; }

step "read the four groups' Helm facts through the platform (no-store, no bearer, the endpoint $endpoint, the platform's chart and image; the Agent's and the Cluster's fullnameOverride ${fleet_id:0:8}-default and ${fleet_id:0:8}-cluster)"
for dir in telflo-node telflo-cluster "$GATEWAY_GROUP" "$LINK_GROUP"; do mkdir -p "$work/$dir"; done
facts_of "$FLEET_URL" "$agent_group_id" "$work/telflo-node/facts.json"
facts_of "$FLEET_URL" "$cluster_group_id" "$work/telflo-cluster/facts.json"
facts_of "$FLEET_URL" "$gateway_group_id" "$work/$GATEWAY_GROUP/facts.json"
facts_of "$FLEET_URL" "$link_group_id" "$work/$LINK_GROUP/facts.json"
expect_facts telflo-node telflo-node "$NS_NODE" "\"${fleet_id:0:8}-default\""
expect_facts telflo-cluster telflo-cluster "$NS_CLUSTER" "\"${fleet_id:0:8}-cluster\""
expect_facts "$GATEWAY_GROUP" "$GATEWAY_GROUP" "$NS_GATEWAYS" null
expect_facts "$LINK_GROUP" "$LINK_GROUP" "$NS_GATEWAYS" null
[ "$(jq -r '.helm.replicas' "$work/$GATEWAY_GROUP/facts.json")" = "2" ] || fail "the Helm facts of $GATEWAY_GROUP don't hold its 2 replicas"
node_fullname=$(fullname_of telflo-node)
cluster_fullname=$(fullname_of telflo-cluster)
image=$(jq -r '.imageTag' "$work/telflo-node/facts.json")
[ "$image" = "$(jq -r '.helm.imageRepository + ":" + .collector.version' "$work/telflo-node/facts.json")" ] ||
  fail "the facts' image $image isn't their repository and collector version"

# ---- The image the pods run.
step "the image $image in the profile: pullable anonymously (asked of its registry with curl), or the local ${CHECK_HELM_LOCAL_IMAGE:-image (CHECK_HELM_LOCAL_IMAGE)} loaded"
pullable=${CHECK_HELM_IMAGE_PULLABLE:-}
if [ -z "$pullable" ]; then
  # Registry metadata only, anonymously (curl -q: no .curlrc; no netrc, no credential): the manifest's HEAD, with
  # the token the registry's challenge names.
  registry=${image%%/*}
  path=${image#*/}
  path=${path%:*}
  tag=${image##*:}
  accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
  manifest_url="https://$registry/v2/$path/manifests/$tag"
  challenge=$(curl -q -s -I --max-time 20 -H "Accept: $accept" "$manifest_url" | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: Bearer //p' || true)
  realm=$(sed -n 's/.*realm="\([^"]*\)".*/\1/p' <<<"$challenge")
  service=$(sed -n 's/.*service="\([^"]*\)".*/\1/p' <<<"$challenge")
  pullable=no
  if [ -n "$realm" ]; then
    curl -q -s --max-time 20 -G "$realm" --data-urlencode "service=$service" --data-urlencode "scope=repository:$path:pull" \
      -o "$work/registry-token.json" || true
    registry_token=$(jq -r '.token // empty' "$work/registry-token.json" 2>/dev/null || true)
    # A bearer too (the invariant's place 7): into the secrets file before its use; one not of a token's shape (20 or
    # more characters of redact()'s class, base64 and base64url, plus '.' for a JWT, which redact() lacks) is never used,
    # so the image counts as not pullable.
    if [[ "$registry_token" =~ ^[A-Za-z0-9+/_.=-]{20,}$ ]]; then secret "$registry_token"; else registry_token=""; fi
    if [ -n "$registry_token" ]; then
      printf 'Authorization: Bearer %s\n' "$registry_token" >"$work/registry-headers"
      code=$(curl -q -s -I -o /dev/null -w '%{http_code}' --max-time 20 -H @"$work/registry-headers" -H "Accept: $accept" "$manifest_url" || true)
      [ "$code" = "200" ] && pullable=yes
    fi
    rm -f "$work/registry-token.json" "$work/registry-headers"
    unset registry_token
  fi
fi
if [ "$pullable" = "yes" ]; then
  echo "    $image can be pulled anonymously: the pods pull it"
else
  local_image=${CHECK_HELM_LOCAL_IMAGE:-}
  [ -n "$local_image" ] ||
    fail "$image can't be pulled anonymously: build it locally (scripts/build-collector-image.sh $(jq -r '.collector.version' "$work/telflo-node/facts.json")) and pass its tag as CHECK_HELM_LOCAL_IMAGE"
  # The image's inspection and minikube's load and tag run under the seeded Docker config and the credential helpers'
  # stand-ins too. The seeded config names no Docker context, so docker (and minikube's Docker client) use the default
  # one (DOCKER_HOST, else /var/run/docker.sock); it must be the engine the caller's config reaches (the same engine
  # id), or the image found here isn't the one minikube loads.
  engine=$(docker info --format '{{.ID}}' 2>/dev/null || true)
  seeded_engine=$(PATH="$COMMAND_PATH" DOCKER_CONFIG="$helm_docker_config" docker info --format '{{.ID}}' 2>/dev/null || true)
  [ -n "$engine" ] && [ "$seeded_engine" = "$engine" ] ||
    fail "the seeded Docker config (no context) reaches another Docker engine than yours (${seeded_engine:-none} against ${engine:-none}): set DOCKER_HOST to your engine's socket, or make /var/run/docker.sock point at it"
  PATH="$COMMAND_PATH" DOCKER_CONFIG="$helm_docker_config" docker image inspect "$local_image" >/dev/null 2>&1 ||
    fail "the local image $local_image isn't on this machine"
  if ! PATH="$COMMAND_PATH" DOCKER_CONFIG="$helm_docker_config" docker run --rm --pull never --entrypoint cat "$local_image" ./entrypoint.sh 2>/dev/null |
    cmp -s - "$repo_dir/docker/collector-image/entrypoint.sh"; then
    echo "    note: $local_image's entrypoint.sh isn't this checkout's docker/collector-image/entrypoint.sh (built from another commit)"
  fi
  PATH="$COMMAND_PATH" DOCKER_CONFIG="$helm_docker_config" minikube -p "$PROFILE" image load "$local_image" >"$work/image-load.log" 2>&1 ||
    fail "minikube -p $PROFILE image load $local_image failed: $(shown "$work/image-load.log" 10)"
  if [ "$local_image" != "$image" ]; then
    PATH="$COMMAND_PATH" DOCKER_CONFIG="$helm_docker_config" minikube -p "$PROFILE" image tag "$local_image" "$image" >>"$work/image-load.log" 2>&1 ||
      fail "minikube -p $PROFILE image tag $local_image $image failed: $(shown "$work/image-load.log" 10)"
  fi
  if called=$(credential_helpers_called); then
    fail "a credential helper was called while minikube loaded the image ($called): Docker or minikube asked a credential store"
  fi
  echo "    loaded $local_image into $PROFILE as $image"
fi

# ---- Step 0: a pod in the profile reaches the stack's agent endpoint.
step "step 0: a pod of $image in $NS_REACH POSTs to $endpoint through host.minikube.internal and is answered the agent door's 401 (no token)"
kubectl create namespace "$NS_REACH" >/dev/null || fail "creating the namespace $NS_REACH failed"
made_namespaces="$made_namespaces $NS_REACH"
kubectl -n "$NS_REACH" run telflo-hc-reach --image="$image" --image-pull-policy=IfNotPresent --restart=Never --command -- \
  curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H 'content-type: application/x-protobuf' --data-binary '' "$endpoint" \
  >/dev/null || fail "starting the reachability pod failed"
phase=""
for _ in $(seq 1 180); do
  phase=$(kubectl -n "$NS_REACH" get pod telflo-hc-reach -o jsonpath='{.status.phase}' 2>/dev/null || true)
  case "$phase" in Succeeded | Failed) break ;; esac
  sleep 1
done
reach=$(kubectl -n "$NS_REACH" logs telflo-hc-reach 2>/dev/null || true)
[ "$reach" = "401" ] ||
  fail "the reachability pod ended ${phase:-unfinished} and printed '$(printf '%s' "$reach" | redact | head -c 200)', not 401: a pod in $PROFILE can't reach the stack's agent port $agent_port through host.minikube.internal ($(kubectl -n "$NS_REACH" describe pod telflo-hc-reach 2>&1 | tail -n 8 | redact | tr '\n' ' '))"

# ---- The dialog's install: values and command printed by the contracts in the API container.
# print_install <dir> <release> <bearer variable's value>: the contracts build, from the group's facts in <dir> (whose
# release must be <release>) and the bearer (by name only), what the Helm dialog's download and screen give: the
# values file (named with a fresh download fragment, after the release, not the directory), `helm upgrade --install …`
# naming it, and `helm uninstall …`. Written into <dir>/<the values file's name> (holding the bearer),
# <dir>/install.sh and <dir>/uninstall.sh, 0600.
print_install() {
  local dir="$work/$1" release=$2 values_file
  [ "$(jq -r '.helm.release' "$dir/facts.json")" = "$release" ] || fail "the Helm facts in $1 aren't the release $release's"
  local script='import { webcrypto } from "node:crypto";
import { HelmInstallFactsSchema, helmDownloadFragment, helmInstallCommand, helmUninstallCommand, helmValuesFileName, helmValuesInputOf, helmValuesYaml } from "@telflo/contracts";
const facts = HelmInstallFactsSchema.parse(JSON.parse(process.env.HC_FACTS));
const { release, chartReference, chartVersion, namespace } = facts.helm;
const valuesFile = helmValuesFileName(release, helmDownloadFragment(webcrypto.getRandomValues(new Uint8Array(4))));
process.stdout.write(JSON.stringify({
  valuesFile,
  values: helmValuesYaml(helmValuesInputOf(facts, process.env.HC_BEARER, [])),
  install: `${helmInstallCommand({ release, chartReference, chartVersion, namespace, valuesFile })}\n`,
  uninstall: `${helmUninstallCommand({ release, namespace })}\n`,
}));'
  HC_FACTS=$(<"$dir/facts.json") HC_BEARER=$3 docker compose exec -T -e HC_FACTS -e HC_BEARER telflo-api \
    node --input-type=module -e "$script" >"$dir/printed.json" 2>"$dir/printed.err" ||
    fail "printing $1's values and commands in the API container failed, redacted: $(shown "$dir/printed.err" 10)"
  local name_pattern="^$release-values-[0-9a-f]{8}[.]yaml\$"
  values_file=$(jq -r '.valuesFile' "$dir/printed.json")
  [[ "$values_file" =~ $name_pattern ]] || fail "the printed values file's name in $1 isn't $release-values-<8 hex>.yaml"
  rm -f "$dir"/*-values*.yaml
  jq -j '.values' "$dir/printed.json" >"$dir/$values_file"
  # The invariant's place 3: the file's own token line (the bearer handed in, as the file holds it).
  values_secret "$dir/$values_file" ||
    fail "the printed values file in $1 doesn't hold exactly one token line of a bearer's shape (the file not printed)"
  jq -j '.install' "$dir/printed.json" >"$dir/install.sh"
  jq -j '.uninstall' "$dir/printed.json" >"$dir/uninstall.sh"
  rm -f "$dir/printed.json"
}
# run_command <dir> <script>: runs the printed command in its directory (Helm's homes, HOME and DOCKER_CONFIG in the
# work directory, the credential helpers' refusing stand-ins first on PATH, umask 022), timed; its output into
# <dir>/<script>.log, printed only redacted; its exit code into $run_code, its time into $run_seconds. A credential
# helper's stand-in called fails the run.
run_command() {
  local dir="$work/$1" started values called
  run_code=0
  started=$(date +%s)
  # Under a person's usual umask (022), so the curl's 0600 values file is the command's own umask 077's.
  (cd "$dir" && umask 022 && PATH="$COMMAND_PATH" HOME="$helm_home" DOCKER_CONFIG="$helm_docker_config" bash "./$2") >"$dir/$2.log" 2>&1 || run_code=$?
  # The invariant's place 5: a values file the command downloaded (the Quick Deploy's curl) holds a bearer sealed for
  # that download: every values file in the directory has its token lines read into the secrets file now, before
  # the log is read, printed or searched, whether or not the command succeeded (the printed ones' are there already).
  for values in "$dir"/*-values*.yaml; do
    if [ -f "$values" ]; then values_secret "$values" || true; fi
  done
  run_seconds=$(($(date +%s) - started))
  if called=$(credential_helpers_called); then
    fail "a credential helper was called while $1's $2 ran ($called): Helm or Docker asked a credential store instead of pulling anonymously"
  fi
}
# run_install <dir> <script>: run_command, which must succeed.
run_install() {
  run_command "$1" "$2"
  if [ "$run_code" != 0 ]; then
    echo "--- $1's $2, its last 30 lines redacted:" >&2
    shown "$work/$1/$2.log" 30 >&2
    kubectl get pods -A -o wide 2>&1 | grep -E "telflo-hc|NAMESPACE" | redact >&2 || true
    fail "$1's printed command ($2) failed"
  fi
  echo "    $1: $2 done in $run_seconds s (helm's --wait --timeout=120s)"
}
# pods_of <namespace> <fullname>: the release's pods' names (the chart labels them app=<fullname>), one a line.
pods_of() {
  kubectl -n "$1" get pods -l "app=$2" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true
}
# ns_of_pod <pod name>: the namespace of one of this check's pods, by its name's prefix (the chart's names), for
# diagnostics.
ns_of_pod() {
  case "$1" in
    "$GATEWAY_GROUP"-*) echo "$gateway_ns" ;;
    "$LINK_GROUP"-*) echo "$NS_GATEWAYS" ;;
    "$node_fullname"-*) echo "$agent_ns" ;;
    "$cluster_fullname"-*) echo "$cluster_ns" ;;
    "${node2_fullname:-telflo-hc-none}"-*) echo "$NS2_NODE" ;;
    "${cluster2_fullname:-telflo-hc-none}"-*) echo "$NS2_CLUSTER" ;;
    *) echo default ;;
  esac
}
# wait_enrolled <fleet url> <rotate token id> <group id> <pod name> <polls> [<jq condition>] [<namespace>]: the
# platform's collector list for the group holds a collector named after the pod, in the group, handed the fleet's
# rotate token (and the condition); its JSON into $collector.
wait_enrolled() {
  local condition=${6:-true} namespace=${7:-default}
  collector=""
  for _ in $(seq 1 "$5"); do
    platform GET "$1/collectors?groupId=$3"
    if [ "$status" = "200" ]; then
      collector=$(jq -c --arg n "$4" --arg g "$3" --arg r "$2" \
        "[.collectors[] | select(.name == \$n and .groupId == \$g and .enrollmentTokenId == \$r and ($condition))][0] // empty" \
        "$REPLY_BODY" 2>/dev/null || true)
      [ -n "$collector" ] && return 0
    fi
    sleep 1
  done
  # A record's name is its pod's only while that pod runs: a moved Agent's records keep their first pods' names, and
  # the platform names a new collector anew while an old record holds its pod's name.
  if kubectl -n "$namespace" get pod "$4" >/dev/null 2>&1; then
    kubectl -n "$namespace" logs "$4" --tail=40 2>&1 | redact >&2 || true
    fail "the pod $4's collector didn't enroll in its group, handed the rotate token, through the platform within $5 polls (last HTTP $status)"
  fi
  fail "the collector record $4 didn't show in its group, handed the rotate token (and seen as asked), through the platform within $5 polls (last HTTP $status; no pod of that name)"
}
# check_enrolled <dir> <namespace> <group id> <pods expected> <fleet url> <rotate token id>: each of the release's
# pods (found by its fullname) enrolls.
check_enrolled() {
  local pods pod count fullname
  fullname=$(fullname_of "$1")
  pods=$(pods_of "$2" "$fullname")
  count=$(printf '%s\n' "$pods" | grep -c . || true)
  [ "$count" = "$4" ] || fail "$1 runs $count pods labelled app=$fullname in $2, not $4: $(kubectl -n "$2" get pods 2>&1 | redact | tr '\n' ';')"
  for pod in $pods; do
    wait_enrolled "$5" "$6" "$3" "$pod" 180 true "$2"
    echo "    $pod enrolled in $1's group, on the rotate token"
  done
}
# moving_on <fleet url> <rotate token id> <collector list file> [<collector ids to leave out>…]: every other
# collector in the list (a read made after the event) is seen later than that read, in its group, on the rotate token.
moving_on() {
  local fleet_url=$1 rotate=$2 list=$3 id name group seen
  shift 3
  for id in $(jq -r '.collectors[].id' "$list"); do
    # Left out too: the records of pods a namespace move replaced (stale_ids: they stopped, as the screen says).
    case " $* $stale_ids " in *" $id "*) continue ;; esac
    name=$(jq -r --arg id "$id" '[.collectors[] | select(.id == $id) | .name][0]' "$list")
    group=$(jq -r --arg id "$id" '[.collectors[] | select(.id == $id) | .groupId][0]' "$list")
    seen=$(jq -r --arg id "$id" '[.collectors[] | select(.id == $id) | .lastSeenAt][0]' "$list")
    wait_enrolled "$fleet_url" "$rotate" "$group" "$name" 120 ".lastSeenAt > \"$seen\"" "$(ns_of_pod "$name")"
    echo "    $name stayed connected"
  done
}

step "reveal the default token (POST .../tokens/:tokenId/reveal; the bearer kept in this shell only) and print the Agent's, the Cluster's and $GATEWAY_GROUP's values and commands with the contracts in the API container"
platform POST "$FLEET_URL/tokens/$default_token_id/reveal"
[ "$status" = "200" ] && no_store || fail "revealing the default token returned HTTP $status: $(reply_code)"
bearer=$(reply_json '.token.bearer')
: >"$REPLY_BODY"
bearer_secret "$bearer" || fail "the reveal answered no bearer of its shape"
print_install telflo-node telflo-node "$bearer"
print_install telflo-cluster telflo-cluster "$bearer"
print_install "$GATEWAY_GROUP" "$GATEWAY_GROUP" "$bearer"

step "install the Agent, the Cluster and $GATEWAY_GROUP each with its printed helm upgrade --install (the chart pulled anonymously from its registry, --create-namespace, --wait)"
# Its namespaces, none there at the start (checked above), are this check's from here on.
made_namespaces="$made_namespaces $NS_NODE $NS_CLUSTER $NS_GATEWAYS"
for dir in telflo-node telflo-cluster "$GATEWAY_GROUP"; do
  installed_releases="$installed_releases $dir"
  run_install "$dir" install.sh
done

step "each pod, found by the chart's name (app=$node_fullname, $cluster_fullname, $GATEWAY_GROUP), enrolls in its group through the platform's collector list: the Agent's $node_count, the Cluster's 1, $GATEWAY_GROUP's 2 (at most 180 polls each)"
check_enrolled telflo-node "$NS_NODE" "$agent_group_id" "$node_count" "$FLEET_URL" "$rotate_token_id"
check_enrolled telflo-cluster "$NS_CLUSTER" "$cluster_group_id" 1 "$FLEET_URL" "$rotate_token_id"
check_enrolled "$GATEWAY_GROUP" "$NS_GATEWAYS" "$gateway_group_id" 2 "$FLEET_URL" "$rotate_token_id"
[ "$(kubectl -n "$NS_GATEWAYS" get pod "$GATEWAY_GROUP-0" -o jsonpath='{range .spec.volumes[*]}{.name}={.hostPath.path}{"\n"}{end}' 2>/dev/null |
  grep -cx 'extra-var-log-host=/var/log' || true)" = "1" ] || fail "$GATEWAY_GROUP-0 doesn't mount its group's hostPath volume /var/log as extra-var-log-host"

# ---- The Helm values link: its Quick Deploy command, curl then helm, on this machine.
step "make a Helm values link for $LINK_GROUP (POST .../quick-deploy-links {kind: helm}) and run its Quick Deploy command, printed by the contracts: the values downloaded through the gateway into $LINK_GROUP-values.yaml (0600), then installed"
platform POST "$FLEET_URL/groups/$link_group_id/quick-deploy-links" '{"kind": "helm", "env": []}'
[ "$status" = "201" ] && no_store || fail "making the Helm link returned HTTP $status: $(reply_code)"
link_url=$(reply_json '.url')
link_id=$(reply_json '.link.id')
: >"$REPLY_BODY"
link_secret=${link_url#"$TELFLO_GATEWAY_URL/api/v1/quick-deploy/"}
[ "$link_secret" != "$link_url" ] && [[ "$link_secret" =~ ^tqd_[A-Za-z0-9_-]{43}$ ]] ||
  fail "the Helm link's url isn't $TELFLO_GATEWAY_URL/api/v1/quick-deploy/tqd_…"
secret "$link_secret"
link_script='import { HelmInstallFactsSchema, helmQuickDeployCommand, helmUninstallCommand } from "@telflo/contracts";
const facts = HelmInstallFactsSchema.parse(JSON.parse(process.env.HC_FACTS));
const { release, chartReference, chartVersion, namespace } = facts.helm;
process.stdout.write(JSON.stringify({
  quickDeploy: `${helmQuickDeployCommand(process.env.HC_URL, { release, chartReference, chartVersion, namespace })}\n`,
  uninstall: `${helmUninstallCommand({ release, namespace })}\n`,
}));'
link_dir="$work/$LINK_GROUP"
HC_FACTS=$(<"$link_dir/facts.json") HC_URL=$link_url docker compose exec -T -e HC_FACTS -e HC_URL telflo-api \
  node --input-type=module -e "$link_script" >"$link_dir/printed.json" 2>"$link_dir/printed.err" ||
  fail "printing the Quick Deploy command in the API container failed, redacted: $(shown "$link_dir/printed.err" 10)"
jq -j '.quickDeploy' "$link_dir/printed.json" >"$link_dir/quick-deploy.sh"
jq -j '.uninstall' "$link_dir/printed.json" >"$link_dir/uninstall.sh"
rm -f "$link_dir/printed.json"
unset link_url
installed_releases="$installed_releases $LINK_GROUP"
run_install "$LINK_GROUP" quick-deploy.sh
[ -n "$(find "$link_dir/$LINK_GROUP-values.yaml" -type f -perm 600 2>/dev/null)" ] ||
  fail "the Quick Deploy command's curl didn't leave $LINK_GROUP-values.yaml 0600"
# Its token joined the secrets file in run_command, before the log was read; the download must hold exactly one.
values_secret "$link_dir/$LINK_GROUP-values.yaml" ||
  fail "the Quick Deploy download's $LINK_GROUP-values.yaml doesn't hold exactly one token line of a bearer's shape (the file not printed)"
check_enrolled "$LINK_GROUP" "$NS_GATEWAYS" "$link_group_id" 1 "$FLEET_URL" "$rotate_token_id"
platform GET "$FLEET_URL/quick-deploy-links"
[ "$status" = "200" ] && [ "$(reply_json --arg id "$link_id" '[.links[] | select(.id == $id) | .downloadCount] == [1]')" = "true" ] ||
  fail "the Helm link isn't listed with its one download (HTTP $status)"

# ---- Each role's namespace move, in the order and with the outcome the group dialog's warning gives
# (KubernetesGroupDialog's namespaceChangeWarning). The Agent and the Cluster own a cluster-wide ClusterRole named
# after the fleet (meta.helm.sh/release-namespace): their install into a new namespace is refused while the release
# runs in the old one, so the screen says to uninstall there first; the Agent's state is the node's hostPath
# (/var/lib/telflo/supervisor/<fullname>, outside any namespace), so its collectors stay the same records; the
# Cluster's is its PVC in the old namespace, so it enrolls again as a new collector (the old one offline). A gateway
# owns nothing cluster-wide: the screen says to install into the new namespace first, then uninstall in the old; its
# pods come back as new collectors (their PVCs are per namespace), and its Service's address (<name>.<namespace>.svc)
# changes. Each outcome is read only from evidence that began after the move completed: the collectors read once the
# new install returned and every old pod was deleted.
# expect_ownership_refusal <dir> <role label> <release> <fullname> <old namespace> <new namespace>: the printed
# install in <dir> (the release moved to <new namespace> while it runs in <old namespace>) is refused by Helm over
# the ClusterRole <fullname>'s release namespace, and leaves nothing in <new namespace>.
expect_ownership_refusal() {
  local dir=$1 label=$2 release=$3 fullname=$4 old_ns=$5 new_ns=$6 left
  run_command "$dir" install.sh
  if [ "$run_code" = 0 ]; then
    installed_releases="$installed_releases $dir"
    fail "Helm accepted the $label's install into $new_ns while its release $release runs in $old_ns: the ClusterRole $fullname's ownership should have refused it (the screen's warning says to uninstall first)"
  fi
  grep -q "ClusterRole \"$fullname\"" "$work/$dir/install.sh.log" &&
    grep -q 'meta.helm.sh/release-namespace' "$work/$dir/install.sh.log" &&
    grep -q "\"$old_ns\"" "$work/$dir/install.sh.log" || {
    echo "--- $dir's install.sh, its last 30 lines redacted:" >&2
    shown "$work/$dir/install.sh.log" 30 >&2
    fail "Helm refused the $label's install into $new_ns, but not over the ClusterRole $fullname's release namespace ($old_ns)"
  }
  echo "    refused in $run_seconds s: Helm names the ClusterRole $fullname, its meta.helm.sh/release-namespace $old_ns"
  if kubectl get namespace "$new_ns" >/dev/null 2>&1; then
    left=$(kubectl -n "$new_ns" get pods,daemonsets,statefulsets,secrets,serviceaccounts -o name 2>"$work/kubectl.err") ||
      fail "listing what is in $new_ns failed: $(shown "$work/kubectl.err" 5)"
    left=$(printf '%s\n' "$left" | grep -vx 'serviceaccount/default' | grep . || true)
    [ -z "$left" ] || fail "the $label's refused install left in $new_ns: $(printf '%s' "$left" | redact | tr '\n' ' ')"
    echo "    $new_ns was made (--create-namespace) and holds nothing of the release"
  else
    echo "    $new_ns wasn't made: nothing is left there"
  fi
  [ "$(kubectl get clusterrole "$fullname" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-namespace}' 2>/dev/null)" = "$old_ns" ] ||
    fail "the ClusterRole $fullname no longer belongs to the release in $old_ns after the refused install"
}
# drop_release <dir>: the directory's release, uninstalled by its printed command, leaves the teardown's list.
drop_release() {
  local dir kept=""
  for dir in $installed_releases; do [ "$dir" = "$1" ] || kept="$kept $dir"; done
  installed_releases=$kept
}
# run_uninstall <dir> <namespace> <fullname>: the printed `helm uninstall` in <dir>, then each of its pods (listed
# before) waited for until it is deleted.
run_uninstall() {
  local pods pod
  pods=$(pods_of "$2" "$3")
  run_command "$1" uninstall.sh
  [ "$run_code" = 0 ] || fail "$1's printed helm uninstall failed: $(shown "$work/$1/uninstall.sh.log" 10)"
  drop_release "$1"
  for pod in $pods; do
    kubectl -n "$2" wait --for=delete "pod/$pod" --timeout=120s >/dev/null 2>"$work/kubectl.err" ||
      fail "$1's pod $pod wasn't deleted within 120 s of its uninstall ($(shown "$work/kubectl.err" 3))"
  done
  echo "    $1: its printed helm uninstall in $2 done, its pods deleted"
}
# group_read <group id> <file>: the group's collectors through the platform, into <file>.
group_read() {
  platform GET "$FLEET_URL/collectors?groupId=$1"
  [ "$status" = "200" ] || fail "listing the group $1's collectors returned HTTP $status: $(reply_code)"
  cp "$REPLY_BODY" "$2"
}
# record_ids <file>: the ids of the records on the rotate token in a group's read, space-separated.
record_ids() { jq -r --arg r "$rotate_token_id" '[.collectors[] | select(.enrollmentTokenId == $r) | .id] | join(" ")' "$1"; }
# wait_pods <namespace> <fullname> <count>: the release's pods in <namespace>, <count> of them (at most 120 polls).
wait_pods() {
  local pods=""
  for _ in $(seq 1 120); do
    pods=$(pods_of "$1" "$2")
    [ "$(printf '%s\n' "$pods" | grep -c . || true)" = "$3" ] && { printf '%s\n' "$pods"; return 0; }
    sleep 1
  done
  fail "$2 runs $(printf '%s\n' "$pods" | grep -c . || true) pods in $1, not $3"
}
# expect_same_records <label> <group id> <old ids> <read>: after the move, the group's collectors are the same
# records (each old id seen later than the read made once the move completed), and no new record appears.
expect_same_records() {
  local label=$1 group=$2 old_ids=$3 read=$4 verdict=""
  for _ in $(seq 1 180); do
    platform GET "$FLEET_URL/collectors?groupId=$group"
    if [ "$status" = "200" ]; then
      verdict=$(jq -r --slurpfile at "$read" --arg r "$rotate_token_id" --arg old "$old_ids" '
        ($at[0].collectors | map({key: .id, value: .lastSeenAt}) | from_entries) as $seen | ($old | split(" ")) as $ids
        | [.collectors[] | select(.enrollmentTokenId == $r)] as $mine
        | ([$mine[] | select((.id as $i | $ids | index([$i])) | not) | .name] | first) as $new
        | if $new != null then "new \($new)"
          elif ([$mine[] | select((.id as $i | $ids | index([$i])) and .lastSeenAt > ($seen[.id] // "")) | .id] | length) == ($ids | length) then "moved"
          else "waiting" end' "$REPLY_BODY" 2>/dev/null || true)
      case "$verdict" in
        new\ *) fail "the $label came back as a new collector record after its move (${verdict#new }): the screen says its collectors stay the same (its state is the node's)" ;;
        moved) echo "    the $label's collectors are the same records ($old_ids), seen after the move completed"; return 0 ;;
      esac
    fi
    sleep 1
  done
  fail "the $label's collector records didn't move on after its move (seen no later than the read made once it completed), within 180 polls"
}
# expect_new_records <label> <group id> <namespace> <fullname> <old ids> <read>: after the move, the release's pods in
# <namespace> come back as new collector records in its group, as many as the pods (ids not among the old ones, seen
# after the read made once the move completed; not matched by name: the platform names a new collector whose pod's
# name an old record of the organization still holds anew: names are unique per organization), and no old record
# moves on, then or 40 s later.
expect_new_records() {
  local label=$1 group=$2 ns=$3 fullname=$4 old_ids=$5 read=$6 pods verdict="" pass when
  pods=$(pods_of "$ns" "$fullname" | tr '\n' ' ')
  for pass in waiting holding; do
    for _ in $(seq 1 180); do
      platform GET "$FLEET_URL/collectors?groupId=$group"
      if [ "$status" = "200" ]; then
        verdict=$(jq -r --slurpfile at "$read" --arg r "$rotate_token_id" --arg old "$old_ids" --arg pods "$pods" '
          ($at[0].collectors | map({key: .id, value: .lastSeenAt}) | from_entries) as $seen | ($old | split(" ")) as $ids
          | [.collectors[] | select(.enrollmentTokenId == $r)] as $mine
          | ([$mine[] | select((.id as $i | $ids | index([$i])) and .lastSeenAt > ($seen[.id] // "")) | .name] | first) as $moved
          | if $moved != null then "old \($moved)"
            elif ([$pods | split(" ")[] | select(. != "")] | length) as $count | $count > 0
                 and ([$mine[] | .id as $i | select((($ids | index([$i])) | not)
                       and ((($seen | has($i)) | not) or .lastSeenAt > $seen[$i]))] | length) >= $count then "new"
            else "waiting" end' "$REPLY_BODY" 2>/dev/null || true)
        case "$verdict" in
          old\ *)
            if [ "$pass" = holding ]; then when="40 s after its new records showed"; else when="while its new records were awaited"; fi
            fail "$label's old collector record ${verdict#old } moved on after its move to $ns ($when): it kept its old record, but the screen says its pods come back as new collectors (the old ones offline)" ;;
        esac
        if [ "$pass" = waiting ] && [ "$verdict" = new ]; then break; fi
        if [ "$pass" = holding ]; then break; fi
      fi
      sleep 1
    done
    if [ "$pass" = waiting ]; then
      [ "$verdict" = new ] ||
        fail "$label's pods ($pods) didn't come back as new collectors in its group after its move to $ns (seen after the read made once it completed), within 180 polls"
      echo "    $label's pods in $ns came back as new collector records; its old records ($old_ids) stopped"
      sleep 40
    fi
  done
  stale_ids="$stale_ids $old_ids"
  echo "    40 s later, none of $label's old records moved on"
}

step "the Agent's saved namespace changed to $NS_MOVED through the platform, its printed install (the release telflo-node unchanged) is refused by Helm over the ClusterRole $node_fullname, which the release in $NS_NODE owns; nothing is left in $NS_MOVED and the Agent keeps running in $NS_NODE"
agent_pods_before_move=$(pods_of "$NS_NODE" "$node_fullname")
save_agent "$FLEET_URL" "$agent_group_id" "$NS_MOVED"
mkdir -p "$work/node-moved"
facts_of "$FLEET_URL" "$agent_group_id" "$work/node-moved/facts.json"
expect_facts node-moved telflo-node "$NS_MOVED" "\"$node_fullname\""
print_install node-moved telflo-node "$bearer"
# The new namespaces aren't there (checked at the start): this check's from here on.
made_namespaces="$made_namespaces $NS_MOVED $NS_CMOVED $NS_GMOVED"
expect_ownership_refusal node-moved Agent telflo-node "$node_fullname" "$NS_NODE" "$NS_MOVED"
[ "$(pods_of "$NS_NODE" "$node_fullname")" = "$agent_pods_before_move" ] ||
  fail "the Agent's pods in $NS_NODE changed with the refused install into $NS_MOVED"

step "then as the Agent's warning says: its printed uninstall in $NS_NODE first, then its install into $NS_MOVED; its collectors stay the same records (the node's state keeps their instance uids) and move on"
group_read "$agent_group_id" "$work/agent-before-move.json"
agent_old_ids=$(record_ids "$work/agent-before-move.json")
[ "$(printf '%s\n' $agent_old_ids | grep -c .)" = "$node_count" ] || fail "the Agent's group holds $(printf '%s\n' $agent_old_ids | grep -c .) records on the rotate token before its move, not $node_count"
run_uninstall telflo-node "$NS_NODE" "$node_fullname"
installed_releases="$installed_releases node-moved"
run_install node-moved install.sh
wait_pods "$NS_MOVED" "$node_fullname" "$node_count" >/dev/null
group_read "$agent_group_id" "$work/agent-moved.json"
expect_same_records Agent "$agent_group_id" "$agent_old_ids" "$work/agent-moved.json"
agent_dir=node-moved
agent_ns=$NS_MOVED

cluster_old_ns=$NS_CLUSTER
step "the Cluster's saved namespace changed to $NS_CMOVED: its printed install is refused by Helm over the ClusterRole $cluster_fullname; then, as its warning says, its printed uninstall in $NS_CLUSTER, then its install: its pod enrolls as a new collector (its PVC is per namespace) and the old record stops"
platform PATCH "$FLEET_URL/groups/$cluster_group_id" "$(jq -cn --arg ns "$NS_CMOVED" '{annotations: {telflo: {kubernetes: {role: "cluster", namespace: $ns, volumes: []}}}}')"
[ "$status" = "200" ] || fail "saving the Cluster's namespace $NS_CMOVED returned HTTP $status: $(reply_code)"
mkdir -p "$work/cluster-moved"
facts_of "$FLEET_URL" "$cluster_group_id" "$work/cluster-moved/facts.json"
expect_facts cluster-moved telflo-cluster "$NS_CMOVED" "\"$cluster_fullname\""
print_install cluster-moved telflo-cluster "$bearer"
expect_ownership_refusal cluster-moved Cluster telflo-cluster "$cluster_fullname" "$NS_CLUSTER" "$NS_CMOVED"
group_read "$cluster_group_id" "$work/cluster-before-move.json"
cluster_old_ids=$(record_ids "$work/cluster-before-move.json")
run_uninstall telflo-cluster "$NS_CLUSTER" "$cluster_fullname"
installed_releases="$installed_releases cluster-moved"
run_install cluster-moved install.sh
wait_pods "$NS_CMOVED" "$cluster_fullname" 1 >/dev/null
group_read "$cluster_group_id" "$work/cluster-moved.json"
expect_new_records "the Cluster" "$cluster_group_id" "$NS_CMOVED" "$cluster_fullname" "$cluster_old_ids" "$work/cluster-moved.json"
cluster_dir=cluster-moved
cluster_ns=$NS_CMOVED

step "$GATEWAY_GROUP's saved namespace changed to $NS_GMOVED: as its warning says, its install into $NS_GMOVED first (no cluster-wide object: Helm accepts it), then its printed uninstall in $NS_GATEWAYS; its pods come back as new collectors, the old ones stop, and its Service's address changes"
platform PATCH "$FLEET_URL/groups/$gateway_group_id" "$(jq -cn --arg ns "$NS_GMOVED" '{annotations: {telflo: {kubernetes: {role: "gateway", namespace: $ns, replicas: 2,
  volumes: [{hostPath: "/var/log", hostPathType: "Directory", mountPath: "/var/log/host", readOnly: true}]}}}}')"
[ "$status" = "200" ] || fail "saving $GATEWAY_GROUP's namespace $NS_GMOVED returned HTTP $status: $(reply_code)"
mkdir -p "$work/gw-moved"
facts_of "$FLEET_URL" "$gateway_group_id" "$work/gw-moved/facts.json"
expect_facts gw-moved "$GATEWAY_GROUP" "$NS_GMOVED" null
print_install gw-moved "$GATEWAY_GROUP" "$bearer"
group_read "$gateway_group_id" "$work/gateway-before-move.json"
gateway_old_ids=$(record_ids "$work/gateway-before-move.json")
service_address='{.metadata.name}.{.metadata.namespace}.svc'
old_address=$(kubectl -n "$NS_GATEWAYS" get service "$GATEWAY_GROUP" -o jsonpath="$service_address" 2>/dev/null || true)
[ "$old_address" = "$GATEWAY_GROUP.$NS_GATEWAYS.svc" ] || fail "$GATEWAY_GROUP's Service in $NS_GATEWAYS reads '$old_address' before its move"
installed_releases="$installed_releases gw-moved"
run_install gw-moved install.sh
wait_pods "$NS_GMOVED" "$GATEWAY_GROUP" 2 >/dev/null
new_address=$(kubectl -n "$NS_GMOVED" get service "$GATEWAY_GROUP" -o jsonpath="$service_address" 2>/dev/null || true)
[ "$new_address" = "$GATEWAY_GROUP.$NS_GMOVED.svc" ] ||
  fail "no Service $GATEWAY_GROUP answers in $NS_GMOVED after its install there (read '$new_address')"
run_uninstall "$GATEWAY_GROUP" "$NS_GATEWAYS" "$GATEWAY_GROUP"
if kubectl -n "$NS_GATEWAYS" get service "$GATEWAY_GROUP" >/dev/null 2>&1; then
  fail "the Service $GATEWAY_GROUP still answers in $NS_GATEWAYS after its release's uninstall there"
fi
echo "    $GATEWAY_GROUP's Service address moved from $old_address to $new_address"
group_read "$gateway_group_id" "$work/gateway-moved.json"
expect_new_records "$GATEWAY_GROUP" "$gateway_group_id" "$NS_GMOVED" "$GATEWAY_GROUP" "$gateway_old_ids" "$work/gateway-moved.json"
gateway_ns=$NS_GMOVED

# ---- The second fleet: the same account, its Agent and Cluster in namespaces of its own.
fleet2_id=$(uuid4)
while [ "${fleet2_id:0:8}" = "${fleet_id:0:8}" ]; do fleet2_id=$(uuid4); done
step "a second fleet (its id's first 8 characters ${fleet2_id:0:8}, not the first's ${fleet_id:0:8}): its Agent in $NS2_NODE and its Cluster in $NS2_CLUSTER, installed with their printed commands (the releases telflo-node and telflo-cluster again), enroll beside the first fleet's"
create_fleet "$fleet2_id" "helm-check-2-$(date +%s)-$$"
agent2_group_id=$created_default_group
default2_token_id=$created_default_token
rotate2_token_id=$created_rotate_token
FLEET2_URL="$FLEETS_URL/$fleet2_id"
save_agent "$FLEET2_URL" "$agent2_group_id" "$NS2_NODE"
platform PATCH "$FLEET2_URL/groups/$agent2_group_id" "$(jq -cn --arg v "$version_id" '{assignedVersionId: $v}')"
[ "$status" = "200" ] || fail "assigning version 1 to the second fleet's Agent returned HTTP $status: $(reply_code)"
cluster2_group_id=$(make_group "$FLEET2_URL" cluster "$(jq -cn --arg ns "$NS2_CLUSTER" '{role: "cluster", namespace: $ns, volumes: []}')")
mkdir -p "$work/f2-node" "$work/f2-cluster"
facts_of "$FLEET2_URL" "$agent2_group_id" "$work/f2-node/facts.json"
facts_of "$FLEET2_URL" "$cluster2_group_id" "$work/f2-cluster/facts.json"
expect_facts f2-node telflo-node "$NS2_NODE" "\"${fleet2_id:0:8}-default\""
expect_facts f2-cluster telflo-cluster "$NS2_CLUSTER" "\"${fleet2_id:0:8}-cluster\""
node2_fullname=$(fullname_of f2-node)
cluster2_fullname=$(fullname_of f2-cluster)
platform POST "$FLEET2_URL/tokens/$default2_token_id/reveal"
[ "$status" = "200" ] && no_store || fail "revealing the second fleet's default token returned HTTP $status: $(reply_code)"
bearer2=$(reply_json '.token.bearer')
: >"$REPLY_BODY"
bearer_secret "$bearer2" || fail "the second fleet's reveal answered no bearer of its shape"
print_install f2-node telflo-node "$bearer2"
print_install f2-cluster telflo-cluster "$bearer2"
unset bearer2
made_namespaces="$made_namespaces $NS2_NODE $NS2_CLUSTER"
for dir in f2-node f2-cluster; do
  installed_releases="$installed_releases $dir"
  run_install "$dir" install.sh
done
check_enrolled f2-node "$NS2_NODE" "$agent2_group_id" "$node_count" "$FLEET2_URL" "$rotate2_token_id"
check_enrolled f2-cluster "$NS2_CLUSTER" "$cluster2_group_id" 1 "$FLEET2_URL" "$rotate2_token_id"

step "the two fleets' ClusterRoles and bindings are four, each named after its fleet and owned by its release's namespace; the two DaemonSets' storage hostPaths are /var/lib/telflo/supervisor/<fullname>, distinct"
roles=""
for spec in "$agent_dir:$agent_ns" "$cluster_dir:$cluster_ns" "f2-node:$NS2_NODE" "f2-cluster:$NS2_CLUSTER"; do
  dir=${spec%%:*}
  namespace=${spec#*:}
  fullname=$(fullname_of "$dir")
  release=$(jq -r '.helm.release' "$work/$dir/facts.json")
  got=$(kubectl get clusterrole "$fullname" \
    -o jsonpath='{.metadata.name} {.metadata.annotations.meta\.helm\.sh/release-name} {.metadata.annotations.meta\.helm\.sh/release-namespace}' 2>"$work/kubectl.err") ||
    fail "reading the ClusterRole $fullname failed: $(shown "$work/kubectl.err" 5)"
  [ "$got" = "$fullname $release $namespace" ] || fail "the ClusterRole $fullname reads '$got', not '$fullname $release $namespace'"
  got=$(kubectl get clusterrolebinding "$fullname" -o jsonpath='{.roleRef.name} {.subjects[0].name} {.subjects[0].namespace}' 2>"$work/kubectl.err") ||
    fail "reading the ClusterRoleBinding $fullname failed: $(shown "$work/kubectl.err" 5)"
  [ "$got" = "$fullname $fullname $namespace" ] || fail "the ClusterRoleBinding $fullname reads '$got', not '$fullname $fullname $namespace'"
  roles="$roles $fullname"
  echo "    ClusterRole $fullname: the release $release in $namespace"
done
[ "$(printf '%s\n' $roles | sort -u | grep -c .)" = "4" ] || fail "the two fleets' ClusterRoles aren't four distinct names:$roles"
storage_paths=""
for spec in "$agent_dir:$agent_ns" "f2-node:$NS2_NODE"; do
  dir=${spec%%:*}
  namespace=${spec#*:}
  fullname=$(fullname_of "$dir")
  got=$(kubectl -n "$namespace" get daemonset "$fullname" -o jsonpath='{range .spec.template.spec.volumes[*]}{.name}={.hostPath.path}{"\n"}{end}' 2>"$work/kubectl.err") ||
    fail "reading the DaemonSet $fullname in $namespace failed: $(shown "$work/kubectl.err" 5)"
  path=$(printf '%s\n' "$got" | sed -n 's/^storage=//p')
  [ "$path" = "/var/lib/telflo/supervisor/$fullname" ] || fail "the DaemonSet $fullname's storage hostPath is '$path', not /var/lib/telflo/supervisor/$fullname"
  storage_paths="$storage_paths $path"
  echo "    DaemonSet $fullname in $namespace: its storage hostPath $path"
done
[ "$(printf '%s\n' $storage_paths | sort -u | grep -c .)" = "2" ] || fail "the two DaemonSets share a storage hostPath:$storage_paths"

step "the first fleet's collectors move on once the second fleet's are enrolled (read now; each seen later than that)"
platform GET "$FLEET_URL/collectors"
[ "$status" = "200" ] || fail "listing the first fleet's collectors returned HTTP $status: $(reply_code)"
cp "$REPLY_BODY" "$work/collectors-fleet2-enrolled.json"
moving_on "$FLEET_URL" "$rotate_token_id" "$work/collectors-fleet2-enrolled.json"

# ---- Optional: a new default token, the Agent's command again: the
# token's checksum on the pod template rolls the DaemonSet.
if [ "${CHECK_HELM_NEW_DEFAULT_TOKEN:-}" = "1" ]; then
  step "a new default token: revoke the default token and issue a new one; the running pods keep working (they hold the rotate token)"
  platform POST "$FLEET_URL/tokens/$default_token_id/revoke"
  [ "$status" = "200" ] || fail "revoking the default token returned HTTP $status: $(reply_code)"
  platform POST "$FLEET_URL/tokens/default"
  [ "$status" = "201" ] && no_store || fail "issuing a new default token returned HTTP $status: $(reply_code)"
  new_bearer=$(reply_json '.token.bearer')
  default_token_id=$(reply_json '.token.id')
  : >"$REPLY_BODY"
  bearer_secret "$new_bearer" || fail "the new default token's reply holds no bearer of its shape"
  # The Agent's pods' last seen now (the platform's own times), to see them move on.
  platform GET "$FLEET_URL/collectors"
  [ "$status" = "200" ] || fail "listing the fleet's collectors returned HTTP $status: $(reply_code)"
  cp "$REPLY_BODY" "$work/collectors-before.json"
  old_agent_pods=$(pods_of "$agent_ns" "$node_fullname")
  [ -n "$old_agent_pods" ] || fail "the Agent ($node_fullname) runs no pod in $agent_ns"
  # The Agent's records by id (since its namespace move they keep the names their first pods gave them).
  agent_records=$(jq -r --arg g "$agent_group_id" --arg r "$rotate_token_id" --arg stale "$stale_ids" \
    '.collectors[] | select(.groupId == $g and .enrollmentTokenId == $r and (.id as $i | $stale | split(" ") | index([$i]) | not)) | .name' \
    "$work/collectors-before.json")
  [ "$(printf '%s\n' $agent_records | grep -c .)" = "$node_count" ] ||
    fail "the Agent's group lists $(printf '%s\n' $agent_records | grep -c .) records on the rotate token, not $node_count"
  for record in $agent_records; do
    seen=$(jq -r --arg n "$record" '[.collectors[] | select(.name == $n) | .lastSeenAt][0] // empty' "$work/collectors-before.json")
    wait_enrolled "$FLEET_URL" "$rotate_token_id" "$agent_group_id" "$record" 120 ".lastSeenAt > \"$seen\"" "$agent_ns"
    echo "    the Agent's $record kept polling after the revoke"
  done

  step "run the Agent's install again with the new bearer (the dialog's command: helm upgrade): the token Secret's checksum on the pod template changes, so the DaemonSet $node_fullname rolls its pods; kubectl rollout status, then each old pod waited for until it is deleted, then the collectors read: only the new pods' records seen after that read count, on the rotate token, and every other pod stays connected"
  print_install "$agent_dir" telflo-node "$new_bearer"
  unset new_bearer bearer
  run_install "$agent_dir" install.sh
  # Only evidence that began after the restart completed counts: an old pod keeps polling on the rotate token while it
  # terminates, and a new pod may connect, then fail, before the rollout ends; so the collectors are read only once
  # the rollout completed and every old pod is deleted, and the Agent's records must then move on from that read (the
  # same record when the node's hostPath state keeps the instance uid). The supervisor keeps no connection settings on
  # disk (its storage directory's listing below shows it), so a new pod reaching the rotate token read the Secret's
  # new default token. No `kubectl delete pod`: the chart's checksum/token rolls the pods.
  kubectl -n "$agent_ns" rollout status "daemonset/$node_fullname" --timeout=180s >"$work/rollout.log" 2>&1 ||
    fail "kubectl rollout status daemonset/$node_fullname didn't complete within 180 s: $(shown "$work/rollout.log" 5)"
  for pod in $old_agent_pods; do
    kubectl -n "$agent_ns" wait --for=delete "pod/$pod" --timeout=120s >/dev/null 2>"$work/kubectl.err" ||
      fail "the Agent's old pod $pod wasn't deleted within 120 s of the rollout's end: the restart didn't complete, so nothing after it can be told from the old pod's polling ($(shown "$work/kubectl.err" 3))"
  done
  new_agent_pods=""
  for _ in $(seq 1 60); do
    listed=$(kubectl -n "$agent_ns" get pods -l "app=$node_fullname" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>"$work/kubectl.err") ||
      fail "listing the Agent's pods once the rollout completed failed: $(shown "$work/kubectl.err" 5)"
    for pod in $old_agent_pods; do
      if printf '%s\n' "$listed" | grep -qx -- "$pod"; then
        fail "the Agent's old pod $pod is listed again once kubectl wait --for=delete returned"
      fi
    done
    new_agent_pods=$listed
    [ "$(printf '%s\n' "$new_agent_pods" | grep -c . || true)" = "$node_count" ] && break
    sleep 1
  done
  [ "$(printf '%s\n' "$new_agent_pods" | grep -c . || true)" = "$node_count" ] ||
    fail "the DaemonSet $node_fullname runs $(printf '%s\n' "$new_agent_pods" | grep -c . || true) new pods once the rollout completed, not $node_count"
  platform GET "$FLEET_URL/collectors"
  [ "$status" = "200" ] || fail "listing the fleet's collectors once the rollout completed returned HTTP $status: $(reply_code)"
  cp "$REPLY_BODY" "$work/collectors-rolled.json"
  olds=$(printf '%s\n' $old_agent_pods $agent_records | jq -R . | jq -sc .)
  claimed=""
  for new_agent_pod in $new_agent_pods; do
    # The node's hostPath state keeps the Agent's instance uid, so a new pod may come back as the same collector
    # (named after an old pod, if the platform keeps the name) or as a new one named after it: either way seen later
    # than that record was in the read made once the rollout completed. A record not in that read is a new one:
    # only the new pod's name counts for it. One record per new pod.
    new_agent=""
    for _ in $(seq 1 180); do
      platform GET "$FLEET_URL/collectors?groupId=$agent_group_id"
      new_agent=$(jq -r --slurpfile at "$work/collectors-rolled.json" --arg new "$new_agent_pod" --argjson olds "$olds" \
        --arg r "$rotate_token_id" --arg claimed "$claimed" '($at[0].collectors | map({key: .id, value: .lastSeenAt}) | from_entries) as $seen
        | [.collectors[] | .id as $id | .name as $name
          | select(.enrollmentTokenId == $r and (($claimed | split(" ") | any(. == $id)) | not)
            and (if ($seen | has($id)) then (($name == $new or any($olds[]; . == $name)) and .lastSeenAt > $seen[$id])
              else $name == $new end))
          | "\(.id) \(.name)"][0] // empty' "$REPLY_BODY" 2>/dev/null || true)
      [ -n "$new_agent" ] && break
      sleep 1
    done
    if [ -z "$new_agent" ]; then
      kubectl -n "$agent_ns" logs "$new_agent_pod" --tail=40 2>&1 | redact >&2 || true
      fail "the Agent's new pod $new_agent_pod didn't connect in the Agent's group, handed the rotate token, after the rollout completed and its old pods were deleted (seen no later than the read made then), within 180 polls"
    fi
    claimed="$claimed ${new_agent%% *}"
    echo "    $new_agent_pod connected in the Agent's group on the new default token after the rollout (listed as ${new_agent#* }), handed the rotate token"
  done
  storage_pod=$(printf '%s\n' $new_agent_pods | head -n1)
  # The Agent's storage directory after the restart, names only, recorded in the run's output: the supervisor's
  # storage.directory /app/opamp, the node's hostPath /var/lib/telflo/supervisor/<fullname> (kept across the roll).
  # opampsupervisor 0.162.0 writes there (its documented storage, and the only file names in its binary)
  # persistent_state.yaml (the instance uid), last_recv_remote_config.dat and last_recv_own_telemetry_config.dat (the
  # last remote and own-telemetry configuration received), effective.yaml (the collector's composed configuration, its
  # OpAMP extension pointed at the supervisor's own local server) and agent.log (the collector's output: the
  # supervisor's default agent log file). Its connection settings (the server's endpoint and headers: the token) are
  # in /app/supervisor-config.yaml (the entrypoint's, in the container, not on the hostPath) and, once an offer is
  # applied, in memory only. The rule: no file but the two last_recv_*.dat files named above may hold what connection
  # settings look like; each other file, persistent_state.yaml too, is searched in the pod (grep -q, nothing printed)
  # for an Authorization header, a Bearer, the agent endpoint's host and port, or its path. A match fails the run (the
  # supervisor keeps connection settings on disk: the step's claim then needs reworking), and so does a file that
  # can't be searched.
  storage="$work/agent-storage.txt"
  kubectl -n "$agent_ns" exec "$storage_pod" --request-timeout=30s -c supervisor -- ls -1A /app/opamp >"$storage" 2>"$work/kubectl.err" ||
    fail "listing the Agent's new pod's storage directory /app/opamp failed: $(shown "$work/kubectl.err" 5)"
  # The names as they are (redact() would hide last_recv_remote_config.dat's), once the listing is known to hold
  # none of the run's secrets.
  clean "$storage" || fail "the Agent's storage listing holds a bearer or the link's secret, or couldn't be searched (not printed)"
  echo "    $storage_pod's /app/opamp (/var/lib/telflo/supervisor/$node_fullname) after the roll (names only): $(tr '\n' ' ' <"$storage")"
  grep -qx 'persistent_state.yaml' "$storage" ||
    fail "the Agent's new pod's /app/opamp holds no persistent_state.yaml: not the supervisor's storage directory"
  while IFS= read -r stored; do
    case "$stored" in last_recv_remote_config.dat | last_recv_own_telemetry_config.dat) continue ;; esac
    search_result=$(kubectl -n "$agent_ns" exec "$storage_pod" --request-timeout=30s -c supervisor -- sh -c \
      'grep -rqiF -e authorization -e bearer -e "$1" -e /opamp/api/v1 -- "$2"; echo "searched: $?"' \
      sh "host.minikube.internal:$agent_port" "/app/opamp/$stored" 2>"$work/kubectl.err" || true)
    case "$search_result" in
      "searched: 1") echo "    /app/opamp/$stored holds no connection settings' look" ;;
      "searched: 0")
        fail "the Agent's /app/opamp/$stored holds what connection settings look like (an Authorization header, a Bearer, the agent endpoint): the supervisor keeps connection settings on disk, so the new default token step's claim needs reworking (the file not printed)" ;;
      *) fail "the Agent's /app/opamp/$stored couldn't be searched ($(printf '%s' "$search_result" | redact | head -c 100)): $(shown "$work/kubectl.err" 5)" ;;
    esac
  done <"$storage"
  # Every other collector in the read made once the rollout completed (not the Agent's records: old or new) moves on.
  others_left_out=$(jq -r --argjson olds "$olds" --arg news "$new_agent_pods" \
    '.collectors[] | .name as $n | select(any($olds[]; . == $n) or ($news | split("\n") | any(. == $n))) | .id' "$work/collectors-rolled.json" | tr '\n' ' ')
  moving_on "$FLEET_URL" "$rotate_token_id" "$work/collectors-rolled.json" $claimed $others_left_out
fi
unset bearer link_secret
new_token_words=""
if [ "${CHECK_HELM_NEW_DEFAULT_TOKEN:-}" = "1" ]; then
  new_token_words=", a new default token rolled the Agent's pods and reached its new pods while the others stayed connected (its storage directory holding no connection settings)"
fi

# Every file the run leaves in the work directory (all but secret_files', which the teardown removes) holds none of
# the secrets: its logs, the printed commands, the facts, the collector lists, the storage listing, Helm's homes.
# clean() fails closed (an empty secrets file or an unsearchable file fails the run); only the file's path is named.
step "the files this check leaves in $work hold neither a bearer nor the link's secret (searched for each, failing closed)"
list_kept || fail "listing the files left in $work failed"
kept_count=0
while IFS= read -r -d '' kept; do
  clean "$kept" || fail "$kept holds a bearer or the link's secret, or couldn't be searched for them (the file not printed)"
  kept_count=$((kept_count + 1))
done <"$KEPT"
[ "$kept_count" -ge 1 ] || fail "found no file to search in $work"
echo "    $kept_count files searched: none holds a secret"

step "uninstall each release with its printed helm uninstall and delete the namespaces this check made (their PVCs with them); revoke the link, delete both fleets and the configuration"
teardown
trap - EXIT
if called=$(credential_helpers_called); then
  fail "a credential helper was called during the teardown ($called): Helm or Docker asked a credential store"
fi
echo "OK: installed the Agent, the Cluster and $GATEWAY_GROUP with the dialog's values and helm upgrade --install, and $LINK_GROUP with a Helm values link's Quick Deploy command, in $PROFILE, from the platform's chart pulled anonymously (no credential helper called); every pod, found by the chart's names, enrolled in its group through the platform; Helm refused the Agent's and the Cluster's install into another namespace while their release ran, then each role's move as its warning says kept the Agent's collectors and gave the Cluster and $GATEWAY_GROUP new ones, its Service's address moved; a second fleet's Agent and Cluster enrolled beside the first's, with their own ClusterRoles and storage paths, while the first's stayed connected$new_token_words; then uninstalled them and deleted the namespaces made"
