#!/usr/bin/env bash
# The platform chart's kind smoke: charts/telflo (or a packaged chart,
# --chart) installed on a throwaway kind cluster, with images built from this
# tree (or the release's, --images), and driven end to end. It runs the
# chart's defaults, the open source's: no one can register, so the first
# account is made by `telflo-admin bootstrap` in the API's pod, and a second
# joins by an invitation.
#
#   scripts/smoke-kind.sh [--profile <name>] [--work <dir>] [--images <version>] [--chart <tgz>]
#       [--image-tag <tag>] [--skip-build] [--keep-images] [--otelcol-versions all|default]
#       [--port <gateway port>] [--mailpit-port <port>] [--api-port <port>] [--core <telflo-core dir>]
#       [--cli <telflo CLI's dist/index.js>] [--timeout <seconds>] [--keep]
#
# --images <version>: the five platform images are the release's, already in
# the local engine under their final names, ghcr.io/telflo/telflo/<name>:
# <version> (scripts/release/load-images.sh puts them there); nothing is
# built, and the chart's own image references are used as they are (only
# their pull policy set to Never), so <version> must be the installed chart's
# appVersion. --chart <tgz>: that packaged chart (scripts/publish-chart.sh
# --chart telflo --package's) is installed instead of this tree's
# charts/telflo. Without --images, the images are built as below.
#
# What it needs: internet access (step 13's outside control, and postgres:18
# pulled in the node), Docker (with compose), kubectl, helm, node, jq, curl,
# openssl and python3; kind from scripts/release/tools.sh (`tools.sh path
# kind`; never one on PATH) and, in the local engine, its node image at
# tools.lock's digest (`scripts/release/tools.sh pull kind-node`); on the
# local Docker engine, the images it loads (nginx:1.27-alpine at the chart's
# digest, axllent/mailpit:v1.31, ghcr.io/telflo/opamp-server at
# vendor/opamp-server/PIN's version and digest, and
# ghcr.io/telflo/telflo/collector:<the catalog's default version>) and,
# without --images, the Dockerfiles' pinned bases; 10.5 GB free in Docker's
# disk; a telflo-core with its node_modules (--core, default this tree's) for
# the contracts' builders, and a built CLI (--cli, default
# <core>/apps/cli/dist/index.js).
#
# The steps, in order, one line each (PASS or FAIL, with its seconds):
#   1. the refusals (exit 2, nothing started): the cluster's name (never
#      `kind`, never one that exists, nor a Docker container, volume or
#      network of that name), the tools, the local images, the ports, the
#      work folder, 10.5 GB free in Docker's disk.
#   2. the platform's five images (api, web, otelcol-validator,
#      otelcol-testing, ottl-evaluator): with --images, the release's, each
#      present with its numeric user; otherwise built from this tree with a
#      compose project of the run's own (<profile>-build) and an override
#      naming its own tags, smoke-kind-<image>:<tag> (the tag HEAD's short id,
#      -dirty when the build's inputs differ from HEAD; --image-tag otherwise,
#      required outside a git checkout); never a developer's own telflo-*:dev.
#      The bases the Dockerfiles pin are used from the local engine; only
#      node:24-bookworm-slim and distroless/static at their pinned digests are
#      pulled when missing, and removed again at the end. --skip-build reuses
#      the tags.
#   3. kind create cluster --name <profile> --image <tools.lock's node, by
#      digest> --kubeconfig <a file of the work folder> --config <the work
#      folder's kind-config.yaml: the API server on 127.0.0.1:<--api-port>, a
#      port the run checked free, never one kind picks>, on a Docker network of
#      the run's own (KIND_EXPERIMENTAL_DOCKER_NETWORK=<profile>, removed at
#      the end; never kind's shared `kind` network): one node, kind's own CNI
#      (kindnet, which enforces NetworkPolicies) and its local-path storage.
#   4. every image loaded into the node (`kind load docker-image`), checked by
#      image id as the engine's image store gives it (smoke-kind/image-id.sh:
#      the config digest on the classic store, the manifest digest on
#      containerd's); the chart's own postgres:18 pinned by digest pulled
#      inside the node, so the chart's default Postgres reference runs as is.
#   5. the release's namespace (labeled pod-security.kubernetes.io/enforce=
#      restricted) and the collectors' namespace (no label: the collector
#      chart's pods set no securityContext); the Mailpit fixture
#      (smoke-kind/mailpit.yaml) in the release's.
#   6. create-secrets.sh --init <work>/smoke.secrets.env, then
#      create-secrets.sh against the cluster: the four required Secrets. No
#      pull Secret: every image is local, and the chart's pull-secret lists
#      stay their default, empty (the [ghcr-pull] section's mechanics are
#      create-secrets.test.sh's).
#   7. helm template with the smoke's values renders no `kind: Secret`.
#   8. helm install --wait (Postgres first; the API's migrate init container
#      retries until Postgres answers), every pod Ready; a pod that can't
#      start (an image or a Secret missing) fails at once; each platform pod
#      runs the image the run means (with --images, the chart's own
#      reference, ghcr.io/telflo/telflo/<name>:<version>).
#   9. a second release in the namespace refused by the chart's
#      oneReleaseGuard (its fixed message; Helm's ownership check refusing
#      it instead fails the step: the guard didn't fire).
#  10. psql in telflo-postgres-0, before the upgrade: the bootstraps ran once
#      (the first start's log), each database refuses the other side's
#      roles, telflo_platform_owner is no superuser and owns pgmigrations; the migrations
#      counted.
#  11. helm upgrade (a pod annotation on every component, so every pod
#      restarts), every pod Ready again and new; the API's migrate init
#      container migrated nothing (pgmigrations unchanged), re-provisioned
#      telflo_platform, and Postgres's restart skipped its initialization.
#  12. the static facts: the management Service ClusterIP; the namespace's
#      label; every pod of the release non-root, every container's root
#      read-only, no service-account token mounted (spec, and inside every
#      container with a shell).
#  13. the NetworkPolicies, enforced by kindnet: the tester and the validator
#      (kubectl exec, Python's urllib) reach neither the outside nor the API; a
#      throwaway pod carrying the evaluator's labels (never Ready, so never its
#      Service's endpoint) reaches nothing; a throwaway pod without labels
#      reaches neither the API, Postgres, web, the sandbox nor the management
#      port, but does reach the gateway, the agent port, Mailpit and the
#      outside (the controls: a failed control fails the step); the gateway
#      reaches web and the API. A throwaway pod waits 5 s before it probes
#      (kindnet doesn't police a new pod's first moments). A closed target must
#      time out (a policy's drop), and its Service must serve the port with a
#      ready endpoint. It needs internet access: the outside control (a TCP
#      connection to 1.1.1.1:443) must be open, so an offline machine fails
#      this step by design.
#  14. kubectl port-forward to the gateway and Mailpit on 127.0.0.1: /login
#      200, /api/v1/auth/me 401, the API reference page
#      (/api/public/v1/docs 301, /docs/ 200 with its CSP, nosniff and
#      no-referrer).
#  15. registration refused (403 registration_not_open: the chart's default is
#      invite-only); `telflo-admin bootstrap` in the API's pod (kubectl exec)
#      makes the first product admin and its group organization and prints its
#      set-password link as its last line: its stdout goes to a 0600 file of
#      the run's secrets, never the logs, the link is read from its last line
#      into a variable and never printed, no email reaches the address, and the
#      password is set; sign in (curl keeps the Secure session cookie over
#      http://localhost: checked), a product admin with no Terms to accept,
#      landing in the group organization (the switch to it a no-op), a teammate
#      invited, the invitation's email read and an account made from it (no
#      Terms), in the organization as a contributor; in the group organization
#      a configuration created, validated (valid and invalid), a test run in
#      the tester, version 1 published.
#  16. a kubernetes-supervisor fleet and a gateway-role collector from this
#      tree's charts/supervisor-collector in the collectors' namespace, its
#      values written by the contracts' builders (smoke-kind/
#      collector-values.mjs, the bearer on standard input): it enrolls and
#      applies version 1, then follows version 2.
#  17. the CLI's anonymous `validate` over loopback http, refused as the
#      chart's defaults have it (anonymous validation off: exit 3 with the
#      sign-in message, `--json`'s login_required and 404; no login written).
#  18. a sign-in with a forged X-Forwarded-For: 203.0.113.7: its audit row
#      holds 127.0.0.1 (the gateway's peer through the port-forward).
#  19. GET /__manifest?paths=<a double-encoded path holding a marker>&version=
#      <the build's>: the web pod's log holds no "The URL path" line and no
#      marker.
#  20. the collector uninstalled, then 60 s with no traffic add no log line in
#      any of the release's pods (probes are silent).
#  21. every pod's log and Helm's release record searched for the secrets.
#  22. helm uninstall: both PVCs (Postgres's and the file store's) are kept
#      by policy, then deleted explicitly.
#  With --keep, the chart is then installed again on fresh volumes for the
#  walkthrough and the cluster is left running, with the port-forward commands
#  printed (the processes are stopped).
#
# The discipline: kind writes the cluster's kubeconfig only to a file in the
# work folder (`--kubeconfig`, for create and delete); every kubectl and helm
# runs with --kubeconfig <a flattened file of the run's> --context
# kind-<profile>, and KUBECACHEDIR is the work folder's; your current context
# and your kubeconfig's sha256 and mtime are recorded first and checked at the
# end (a changed context is restored and fails the run). Helm's homes, Docker's
# config (`{"auths":{"telflo-smoke.invalid":{}}}`) and refusing
# credential-helper stand-ins (first on PATH) are the work folder's: a stand-in
# called fails the run. Every secret stays in files of the work folder (mode
# 0600) and reaches commands through files, pipes and standard input, never
# argv; at the end the work folder, the run's output, the pods' logs (the
# collector's among them) and Helm's release record are searched for each (the
# generated values, both accounts' passwords, the set-password link's and the
# invitation email's tokens, the session cookies and the bearers; each also in
# its base64 forms at the three alignments, and in base64url), by boolean, and
# the files holding them are removed. The run's two kubeconfigs hold the
# cluster's admin client key: they are removed on every exit but --keep's
# (whose printed instructions say so). kind create's output is removed once the
# start is checked, and again on every exit. A signal to the whole process
# group (TERM, HUP, a closed terminal) still runs the whole cleanup: the
# cluster deleted, its Docker network removed. Diagnostics are redacted
# (`(PASSWORD|SECRET|KEY)=…` and runs of 40 or more base64 characters).
#
# Exit status: 0 every step passed and the cleanup completed; 1 a step or the
# cleanup failed (after the cleanup; with --keep the cluster is left); 2
# refused before anything started. bash 3.2 compatible.
set -euo pipefail
set +x

PROGRAM=smoke-kind
DEFAULT_PROFILE=smoke-kind
RELEASE=telflo
NS=telflo-smoke
NS_COLLECTORS=telflo-smoke-collectors
GATEWAY_GROUP=smoke-gw
MIN_DOCKER_FREE_KB=$((105 * 1024 * 1024 / 10))
NODE_BASE="node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9"
DISTROLESS_BASE="gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab"
LOCAL_BASES="python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f golang:1.26-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade"
NGINX_IMAGE="nginx:1.27-alpine"
MAILPIT_IMAGE="axllent/mailpit:v1.31"
COLLECTOR_REPOSITORY="ghcr.io/telflo/telflo/collector"
RELEASE_REGISTRY="ghcr.io/telflo/telflo"
PLATFORM_IMAGES="api web otelcol-validator otelcol-testing ottl-evaluator"
OUTSIDE_IP=1.1.1.1

refuse() { echo "$PROGRAM: refused: $*" >&2; exit 2; }
usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }

# ---- The arguments.
PROFILE=$DEFAULT_PROFILE
WORK=""
IMAGES_VERSION=""
CHART_ARG=""
IMAGE_TAG=""
SKIP_BUILD=no
KEEP=no
KEEP_IMAGES=no
OTELCOL_VERSIONS_ARG=all
PORT=58180
MAILPIT_PORT=58181
API_PORT=58182
CORE=""
CLI=""
WAIT_TIMEOUT=1200
while [ $# -gt 0 ]; do
  case "$1" in
    --profile | --work | --images | --chart | --image-tag | --otelcol-versions | --port | --mailpit-port | --api-port | --core | --cli | --timeout)
      [ $# -ge 2 ] || refuse "$1 needs a value"
      case "$2" in -*) refuse "$1 needs a value, not an option" ;; esac
      case "$1" in
        --profile) PROFILE=$2 ;;
        --work) WORK=$2 ;;
        --images) IMAGES_VERSION=$2 ;;
        --chart) CHART_ARG=$2 ;;
        --image-tag) IMAGE_TAG=$2 ;;
        --otelcol-versions) OTELCOL_VERSIONS_ARG=$2 ;;
        --port) PORT=$2 ;;
        --mailpit-port) MAILPIT_PORT=$2 ;;
        --api-port) API_PORT=$2 ;;
        --core) CORE=$2 ;;
        --cli) CLI=$2 ;;
        --timeout) WAIT_TIMEOUT=$2 ;;
      esac
      shift 2
      ;;
    --skip-build) SKIP_BUILD=yes; shift ;;
    --keep) KEEP=yes; shift ;;
    --keep-images) KEEP_IMAGES=yes; shift ;;
    -h | --help) usage; exit 0 ;;
    *) refuse "unknown argument '$1' (--help lists them)" ;;
  esac
done

[[ "$PROFILE" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]] ||
  refuse "--profile must be a kind cluster's name: a lower-case letter, then letters, digits and '-' (at most 32; default $DEFAULT_PROFILE)"
[ "$PROFILE" != kind ] || refuse "--profile kind is kind's own default cluster: name a throwaway one (default $DEFAULT_PROFILE)"
case "$OTELCOL_VERSIONS_ARG" in all | default) ;; *) refuse "--otelcol-versions is all or default" ;; esac
for value in "$PORT" "$MAILPIT_PORT" "$API_PORT"; do
  [[ "$value" =~ ^[1-9][0-9]{3,4}$ ]] && [ "$value" -le 65535 ] || refuse "a port must be a number from 1000 to 65535"
done
[ "$PORT" != "$MAILPIT_PORT" ] && [ "$PORT" != "$API_PORT" ] && [ "$MAILPIT_PORT" != "$API_PORT" ] ||
  refuse "--port, --mailpit-port and --api-port must differ"
for value in "$PORT" "$MAILPIT_PORT" "$API_PORT"; do
  case "$value" in
    50080 | 58025 | 51025 | 53000 | 8080 | 51234 | 51235) refuse "port $value is one a developer's own development stack or dev servers use: name another" ;;
  esac
done
[[ "$WAIT_TIMEOUT" =~ ^[1-9][0-9]{1,4}$ ]] || refuse "--timeout is a number of seconds"
if [ -n "$IMAGE_TAG" ]; then
  [[ "$IMAGE_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || refuse "--image-tag must be an image tag (letters, digits, . _ -)"
fi
if [ -n "$IMAGES_VERSION" ]; then
  [ -z "$IMAGE_TAG" ] && [ "$SKIP_BUILD" = no ] || refuse "--images names the release's images: --image-tag and --skip-build are for the images this script builds"
fi

for tool in docker kubectl helm node jq curl openssl python3 shasum base64 gzip; do
  command -v "$tool" >/dev/null 2>&1 || refuse "$tool isn't on PATH"
done

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
# shellcheck source=scripts/release/version.sh
. "$REPO/scripts/release/version.sh"
# The engine's image store (telflo_engine_store), and step 4's image-id check.
# shellcheck source=scripts/release/oci.sh
. "$REPO/scripts/release/oci.sh"
# shellcheck source=scripts/smoke-kind/image-id.sh
. "$REPO/scripts/smoke-kind/image-id.sh"
COLLECTOR_CHART=$REPO/charts/supervisor-collector
FIXTURES=$REPO/scripts/smoke-kind
for path in "$REPO/charts/telflo/Chart.yaml" "$COLLECTOR_CHART/Chart.yaml" "$REPO/docker-compose.yml" "$REPO/scripts/create-secrets.sh" \
  "$FIXTURES/mailpit.yaml" "$FIXTURES/image-id.sh" "$FIXTURES/tcp-probe.js" "$FIXTURES/sandbox-probe.py" "$FIXTURES/collector-values.mjs" \
  "$REPO/vendor/opamp-server/PIN" "$REPO/catalog/distributions/otelcol-contrib.json"; do
  [ -f "$path" ] || refuse "no $path"
done
[ -n "$CORE" ] || CORE=$REPO/telflo-core
[ -d "$CORE" ] || refuse "--core $CORE isn't a directory"
CORE=$(cd "$CORE" && pwd -P)
[ -e "$CORE/node_modules/tsx" ] && [ -e "$CORE/node_modules/@telflo/contracts" ] ||
  refuse "$CORE has no node_modules with tsx and @telflo/contracts (--core names a telflo-core whose dependencies are installed)"
[ -n "$CLI" ] || CLI=$CORE/apps/cli/dist/index.js
[ -f "$CLI" ] || refuse "no CLI at $CLI (build it: npm run build -w @telflo/cli in telflo-core, or name one with --cli)"

# kind: the private tools', never one on PATH; its node image at tools.lock's digest, local.
KIND=$(bash "$REPO/scripts/release/tools.sh" path kind 2>/dev/null) ||
  refuse "kind isn't fetched and checked (scripts/release/tools.sh fetch kind)"
KIND_NODE_IMAGE=$(bash "$REPO/scripts/release/tools.sh" ref kind-node 2>/dev/null) ||
  refuse "scripts/release/tools.lock pins no kind-node image"
[[ "$KIND_NODE_IMAGE" =~ ^kindest/node@sha256:[0-9a-f]{64}$ ]] || refuse "tools.lock's kind-node isn't kindest/node by digest"
CONTEXT="kind-$PROFILE"
NODE="$PROFILE-control-plane"

# The image tag (the images this script builds): --image-tag, else HEAD's short id (-dirty when the build's inputs
# differ from HEAD).
if [ -z "$IMAGE_TAG" ] && [ -z "$IMAGES_VERSION" ]; then
  if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    IMAGE_TAG=$(git -C "$REPO" rev-parse --short HEAD)
    if [ -n "$(git -C "$REPO" status --porcelain -- telflo-core catalog install-templates services vendor .dockerignore docker-compose.yml 2>/dev/null)" ]; then
      IMAGE_TAG="$IMAGE_TAG-dirty"
    fi
  else
    refuse "$REPO isn't a git checkout: name the images' tag with --image-tag"
  fi
fi
# image_of <name>: the platform image the run installs, as the engine names it.
if [ -n "$IMAGES_VERSION" ]; then
  image_of() { echo "$RELEASE_REGISTRY/$1:$IMAGES_VERSION"; }
else
  image_of() { echo "smoke-kind-$1:$IMAGE_TAG"; }
fi
# ref_of <name>: the same image as a pod names it (the node's runtime normalizes a bare name to docker.io/library/).
ref_of() {
  case "$(image_of "$1")" in
    */*) image_of "$1" ;;
    *) echo "docker.io/library/$(image_of "$1")" ;;
  esac
}

# The work folder: a new or empty one, never inside this tree.
if [ -z "$WORK" ]; then
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/telflo-smoke.XXXXXX")
else
  case "$WORK" in /*) ;; *) refuse "--work must be an absolute path" ;; esac
  if [ -e "$WORK" ]; then
    [ -d "$WORK" ] && [ ! -L "$WORK" ] || refuse "--work $WORK isn't a directory"
    [ -z "$(ls -A "$WORK")" ] || refuse "--work $WORK isn't empty: name a new or an empty folder"
  else
    mkdir -p "$WORK"
  fi
fi
WORK=$(cd "$WORK" && pwd -P)
case "$WORK/" in "$REPO/"*) refuse "--work $WORK is inside this tree: the generated secrets never go in it" ;; esac
case "$WORK" in *[[:space:]]*) refuse "--work holds a space, which this script doesn't handle" ;; esac
chmod 0700 "$WORK"

# The chart: --chart's packaged file (its Chart.yaml and values.yaml read from the archive), else this tree's.
if [ -n "$CHART_ARG" ]; then
  case "$CHART_ARG" in *.tgz) ;; *) refuse "--chart names a packaged chart, a .tgz (scripts/publish-chart.sh --chart telflo --package)" ;; esac
  [ -f "$CHART_ARG" ] && [ ! -L "$CHART_ARG" ] || refuse "--chart $CHART_ARG isn't a file"
  CHART=$(cd "$(dirname "$CHART_ARG")" && pwd -P)/$(basename "$CHART_ARG")
  case "$CHART" in *[[:space:]]*) refuse "--chart's path holds a space, which this script doesn't handle" ;; esac
  chart_file() { tar -xzOf "$CHART" "telflo/$1" 2>/dev/null; }
else
  CHART=$REPO/charts/telflo
  chart_file() { cat "$CHART/$1"; }
fi
CHART_META=$WORK/chart.yaml
chart_file Chart.yaml >"$CHART_META" || { rm -f "$CHART_META"; refuse "$CHART holds no telflo/Chart.yaml"; }
CHART_NAME=$(telflo_chart_field "$CHART_META" name || true)
CHART_VERSION=$(telflo_chart_field "$CHART_META" version || true)
CHART_APP_VERSION=$(telflo_chart_field "$CHART_META" appVersion || true)
rm -f "$CHART_META"
[ "$CHART_NAME" = telflo ] || refuse "$CHART isn't the chart telflo (its name is '${CHART_NAME:-none}')"
telflo_version_ok "$CHART_APP_VERSION" || refuse "$CHART's appVersion '${CHART_APP_VERSION:-none}' isn't a release version"
CHART_VALUES=$(chart_file values.yaml) || refuse "$CHART holds no values.yaml"

# The platform's images: --images's release names, else this run's own tags.
if [ -n "$IMAGES_VERSION" ]; then
  telflo_version_ok "$IMAGES_VERSION" || refuse "--images takes a release version (x.y.z), not '$IMAGES_VERSION'"
  [ "$IMAGES_VERSION" = "$CHART_APP_VERSION" ] ||
    refuse "--images $IMAGES_VERSION isn't the chart's appVersion $CHART_APP_VERSION: the chart names its own images by its appVersion"
fi

# The pinned references, read from the tree and the chart.
OPAMP_DIGEST=$(sed -n 's/^digest=\(sha256:[0-9a-f]\{64\}\)$/\1/p' "$REPO/vendor/opamp-server/PIN")
[ -n "$OPAMP_DIGEST" ] || refuse "vendor/opamp-server/PIN holds no digest= line"
# The version as text from the PIN too, never written here.
OPAMP_VERSION=$(sed -n 's/^version=\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' "$REPO/vendor/opamp-server/PIN")
[ -n "$OPAMP_VERSION" ] || refuse "vendor/opamp-server/PIN holds no version= line"
OPAMP_IMAGE="ghcr.io/telflo/opamp-server:$OPAMP_VERSION"
NGINX_DIGEST=$(printf '%s\n' "$CHART_VALUES" | awk '/^gateway:/{g=1} g && /digest:/{print $2; exit}')
POSTGRES_DIGEST=$(printf '%s\n' "$CHART_VALUES" | awk '/^postgres:/{g=1} g && /digest:/{print $2; exit}')
[[ "$NGINX_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] && [[ "$POSTGRES_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  refuse "couldn't read the gateway's and Postgres's digests from the chart's values.yaml"
POSTGRES_PINNED="docker.io/library/postgres:18@$POSTGRES_DIGEST"
COLLECTOR_VERSION=$(jq -r '[.versions[] | select(.default == true) | .version] | if length == 1 then .[0] else empty end' \
  "$REPO/catalog/distributions/otelcol-contrib.json")
[ -n "$COLLECTOR_VERSION" ] || refuse "the catalogue names no one default collector version"
COLLECTOR_IMAGE="$COLLECTOR_REPOSITORY:$COLLECTOR_VERSION"

# ---- Your kubeconfig, recorded before anything else runs: its sha256 and mtime, and the current context
# (kubectl only reads it here).
case "$HOME" in *[[:space:]]*) refuse "HOME holds a space, which this script doesn't handle" ;; esac
CALLER_KUBECONFIG=${KUBECONFIG:-}
GUARDED=$HOME/.kube/config
guarded_state() {
  if [ -f "$GUARDED" ]; then
    echo "$(shasum -a 256 "$GUARDED" | cut -d' ' -f1) $(stat -c %Y "$GUARDED" 2>/dev/null || stat -f %m "$GUARDED")"
  else
    echo absent
  fi
}
caller_context() {
  if [ -n "$CALLER_KUBECONFIG" ]; then
    KUBECONFIG=$CALLER_KUBECONFIG kubectl config current-context 2>/dev/null || true
  else
    env -u KUBECONFIG kubectl config current-context 2>/dev/null || true
  fi
}
GUARDED_BEFORE=$(guarded_state)
CONTEXT_BEFORE=$(caller_context)

# ---- The run's folders and settings.
umask 077
STATE=$WORK/state
LOGS=$WORK/logs
SECRETS_DIR=$WORK/secrets
VALUES=$SECRETS_DIR/values
SECRETS_FILE=$WORK/smoke.secrets.env
STEPS=$WORK/steps.txt
OUTPUT_LOG=$WORK/output.log
mkdir -p "$STATE" "$LOGS" "$SECRETS_DIR" "$WORK/cli" "$WORK/cli-home" "$WORK/cli-config" "$WORK/tmp"
: >"$STEPS"
: >"$VALUES"
: >"$SECRETS_DIR/originals"
# The output, also into the log. The tee ignores INT, TERM and HUP: a signal to the whole process group (a closed
# terminal, a TERM to the group) must not kill it, or the cleanup's first line would die on a broken pipe.
exec > >(trap '' INT TERM HUP; exec tee -a "$OUTPUT_LOG") 2>&1

helm_unset=""
for name in ${!HELM_@}; do
  helm_unset="$helm_unset $name"
  unset "$name"
done
export HELM_CACHE_HOME="$WORK/helm/cache" HELM_CONFIG_HOME="$WORK/helm/config" HELM_DATA_HOME="$WORK/helm/data"
export HELM_REGISTRY_CONFIG="$WORK/helm/registry.json" HELM_REPOSITORY_CACHE="$WORK/helm/cache/repository"
export HELM_REPOSITORY_CONFIG="$WORK/helm/config/repositories.yaml" HELM_PLUGINS="$WORK/helm/data/plugins"
mkdir -p "$HELM_CACHE_HOME" "$HELM_CONFIG_HOME" "$HELM_DATA_HOME" "$WORK/docker-config" "$WORK/bin"
printf '{"auths":{"telflo-smoke.invalid":{}}}\n' >"$WORK/docker-config/config.json"
printf '{"auths":{"telflo-smoke.invalid":{}}}\n' >"$HELM_REGISTRY_CONFIG"
export DOCKER_CONFIG="$WORK/docker-config"
HELPERS_LOG=$WORK/credential-helpers.log
: >"$HELPERS_LOG"
for helper in docker-credential-osxkeychain docker-credential-desktop docker-credential-ecr-login; do
  printf '#!/bin/sh\n# A refusing stand-in (smoke-kind.sh): logs its name and first argument, never reads its input.\nprintf "%%s %%s\\n" "%s" "$1" >>"%s"\nexit 1\n' \
    "$helper" "$HELPERS_LOG" >"$WORK/bin/$helper"
  chmod 0700 "$WORK/bin/$helper"
done
export PATH="$WORK/bin:$PATH"
export KUBECACHEDIR="$WORK/kube-cache"
export TMPDIR="$WORK/tmp"
# kind's cluster on a Docker network of the run's own, never kind's shared `kind` network:
# kind makes it and leaves it after a delete, so the cleanup removes it.
export KIND_EXPERIMENTAL_DOCKER_NETWORK="$PROFILE"
KIND_KUBECONFIG=$WORK/kubeconfig
KC=$WORK/kube/config
mkdir -p "$WORK/kube"
# Anything that still reads KUBECONFIG reads the run's own file, never yours.
export KUBECONFIG="$KC"
BUILD_PROJECT="$PROFILE-build"
VALUES_FILE=$STATE/values-smoke.yaml
UPGRADE_VALUES=$STATE/values-upgrade.yaml
GATEWAY_URL="http://localhost:$PORT"
MAILPIT_URL="http://localhost:$MAILPIT_PORT"
AGENT_URL="http://telflo-opamp-server-agent.$NS.svc:51234/opamp/api/v1"
JAR=$SECRETS_DIR/cookies
REPLY_BODY=$SECRETS_DIR/reply-body
# Response headers that can carry Set-Cookie (the session cookies) live with the secrets, removed at the end.
REPLY_HEADERS=$SECRETS_DIR/reply-headers
SIGN_IN_HEADERS=$SECRETS_DIR/sign-in.headers

# ---- The run's state, which the cleanup reads.
STARTED_AT=$SECONDS
STEP=0
STEP_TITLE=""
STEP_STARTED=$SECONDS
cluster_created=no
network_created=no
built_images=""
pulled_bases=""
forward_pids=""
helm_pid=""
probes_made=no
logs_collected=no
cleanup_failures=""

elapsed() { local seconds=$((SECONDS - STARTED_AT)); echo "$((seconds / 60)) min $((seconds % 60)) s"; }
step() {
  STEP=$((STEP + 1))
  STEP_TITLE=$*
  STEP_STARTED=$SECONDS
  echo "... $STEP. $* (at $(elapsed))"
}
pass() {
  local line
  line="PASS $STEP. $* [$((SECONDS - STEP_STARTED)) s]"
  echo "$line"
  echo "$line" >>"$STEPS"
}
fail() {
  local line
  line="FAIL $STEP. ${STEP_TITLE:-preflight}: $* [$((SECONDS - STEP_STARTED)) s]"
  echo "$line" >&2
  echo "$line" >>"$STEPS"
  exit 1
}
note() { echo "     $*"; }
# redact: a diagnostic's text with anything after PASSWORD=, SECRET= or KEY=, a kubeadm bootstrap token's shape
# (6.16 lower-case letters and digits) and every run of 40 or more base64, base64url or hex characters masked
# (bytes: LC_ALL=C).
redact() { LC_ALL=C sed -E -e 's#((PASSWORD|SECRET|KEY)=)[^[:space:]]*#\1[redacted]#g' -e 's#[a-z0-9]{6}\.[a-z0-9]{16}#[redacted]#g' -e 's#[A-Za-z0-9+/_=-]{40,}#[redacted]#g'; }
shown() { tail -n "${2:-12}" "$1" 2>/dev/null | redact | sed 's/^/       | /'; }
helpers_called() {
  [ -s "$HELPERS_LOG" ] || return 1
  sort -u "$HELPERS_LOG" | tr '\n' ';'
}
# add_value_file <file>: each non-empty line of the file joins the values searched for, with its base64 forms at the
# three alignments a value can sit at inside a longer base64 text (0, 1 or 2 bytes before it), each cut to the
# characters only the value decides (no leading character shared with what precedes it, no trailing one shared with
# what follows, no padding), and each of those in base64url too. Read by bash's read, written by printf (a
# builtin): never on a command line, never printed. $SECRETS_DIR/originals counts the values themselves. A value
# under 16 characters is refused, loudly (a fixed message; it returns 1): so short a needle would match ordinary
# text, and no secret of the run is that short.
add_value_file() {
  local line shift encoded rest short=0 LC_ALL=C
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    if [ "${#line}" -lt 16 ]; then
      echo "     a value under 16 characters can't be searched for: refused (not shown)" >&2
      short=1
      continue
    fi
    printf '%s\n' "$line" >>"$VALUES"
    printf '%s\n' "$line" >>"$SECRETS_DIR/originals"
    for shift in 0 1 2; do
      encoded=$({ [ "$shift" -lt 1 ] || printf '\000'; [ "$shift" -lt 2 ] || printf '\000'; printf '%s' "$line"; } | base64 | tr -d '\n')
      case "$shift" in 1) encoded=${encoded:2} ;; 2) encoded=${encoded:3} ;; esac
      while [ "${encoded%=}" != "$encoded" ]; do encoded=${encoded%=}; done
      rest=$(((shift + ${#line}) % 3))
      [ "$rest" = 0 ] || encoded=${encoded%?}
      [ "${#encoded}" -ge 16 ] || continue
      printf '%s\n' "$encoded" >>"$VALUES"
      printf '%s\n' "$encoded" | tr '+/' '-_' >>"$VALUES"
    done
  done <"$1"
  return "$short"
}
# add_jar_values <jar>: the session cookies' values in a curl jar (Netscape format: name field 6, value field 7),
# telflo_access and telflo_refresh only (the theme cookie's one word is no secret), join the values searched for.
add_jar_values() {
  local code=0
  [ -f "$1" ] || return 0
  awk -F '\t' 'NF >= 7 && ($6 == "telflo_access" || $6 == "telflo_refresh") && $7 != "" { print $7 }' "$1" >"$SECRETS_DIR/jar-values"
  add_value_file "$SECRETS_DIR/jar-values" || code=$?
  rm -f "$SECRETS_DIR/jar-values"
  return "$code"
}
secrets_count() { sort -u "$SECRETS_DIR/originals" 2>/dev/null | grep -c . || true; }
# image_id_built <image>: the id the image had right after this run built it (none when it didn't).
image_id_built() { awk -v i="$1" '$1 == i { print $2 }' "$STATE/built-ids" 2>/dev/null || true; }
holds_value() { [ -s "$VALUES" ] && LC_ALL=C grep -qaFf "$VALUES" "$1"; }

# kube and helmk: only ever the run's cluster, by its context in the run's flattened kubeconfig, which must exist
# and be non-empty (kubectl without one would ask http://localhost:8080).
kube() {
  [ -s "$KC" ] || fail "the run's kubeconfig ($KC) is missing or empty: kubectl isn't run without it"
  kubectl --kubeconfig "$KC" --context "$CONTEXT" "$@"
}
kns() { kube -n "$NS" "$@"; }
helmk() {
  [ -s "$KC" ] || fail "the run's kubeconfig ($KC) is missing or empty: helm isn't run without it"
  helm --kubeconfig "$KC" --kube-context "$CONTEXT" "$@"
}
# kind_cluster create|delete <flags...>: the private tools' kind (never one on PATH) creating or deleting the run's
# cluster, always with the run's own kubeconfig file, so it never reads or writes yours. (`kind get clusters` and
# `kind load` touch no kubeconfig.)
kind_cluster() {
  local action=$1
  shift
  "$KIND" "$action" cluster --name "$PROFILE" --kubeconfig "$KIND_KUBECONFIG" "$@"
}
# remove_create_log: kind create's output (kubeadm's progress) is no record the run needs: removed once the start is
# checked, and again on every exit (a failed start's among them), and checked gone.
remove_create_log() {
  rm -f -- "$LOGS/kind-create.log" 2>/dev/null || true
  [ ! -e "$LOGS/kind-create.log" ]
}

# ---- The platform, through the gateway (curl; the jar's cookies; X-Telflo-CSRF). platform <method> <url> [<body
# file>]: the status into $status, the body into $REPLY_BODY (0600, the secrets folder), the headers into
# $REPLY_HEADERS.
platform() {
  local args=(-q -s --max-time 60 -o "$REPLY_BODY" -D "$REPLY_HEADERS" -w '%{http_code}' -b "$JAR" -c "$JAR" -X "$1" -H 'X-Telflo-CSRF: 1')
  if [ $# -ge 3 ]; then args+=(-H 'content-type: application/json' --data-binary "@$3"); fi
  status=$(: >"$REPLY_BODY" && curl "${args[@]}" "$2" || true)
  if [ "$status" = "401" ] && [ "$(reply_json '.error.code // empty')" = "access_token_expired" ]; then
    curl -q -s -o /dev/null --max-time 30 -b "$JAR" -c "$JAR" -X POST -H 'X-Telflo-CSRF: 1' "$GATEWAY_URL/api/v1/auth/refresh" || true
    status=$(: >"$REPLY_BODY" && curl "${args[@]}" "$2" || true)
  fi
}
reply_json() { jq -r "$@" "$REPLY_BODY" 2>/dev/null || true; }
reply_code() { local code; code=$(reply_json '.error.code // empty'); echo "${code:-no error code}"; }
# body <name> <jq program> [jq args...]: a request body written by jq to the state folder; its path on stdout.
body() {
  local name=$1 program=$2
  shift 2
  jq -n "$@" "$program" >"$STATE/$name.json"
  echo "$STATE/$name.json"
}
uuid4() {
  local hex
  hex=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s-%s-4%s-%x%s-%s\n' "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" $(((0x${hex:16:2} & 0x3f) | 0x80)) "${hex:18:2}" "${hex:20:12}"
}

# ---- Pods: their problems, readiness and logs.
# The release's pods that can't start by themselves: an image the node doesn't hold, a Secret or key missing, a
# failed pod. Each line names the pod, the container and the reason only (never a message). A crash loop is not one:
# the API's and the opamp-server's migrations exit until Postgres answers.
PROBLEMS_JQ='
[.items[] | select(.metadata.deletionTimestamp == null)] as $pods
| ( $pods[] | .metadata.name as $pod
    | ((.status.initContainerStatuses // []) + (.status.containerStatuses // []))[]
    | (.state.waiting.reason // "") as $reason
    | select($reason | test("^(CreateContainerConfigError|CreateContainerError|ErrImage.*|ImagePullBackOff|InvalidImageName|RunContainerError)$"))
    | "\($pod) \(.name) \($reason)" ),
  ( $pods[] | select(.status.phase == "Failed") | "\(.metadata.name) - Failed" )
'
SUMMARY_JQ='
.items[] | select(.metadata.deletionTimestamp == null)
| "\(.metadata.name): \(.status.phase), "
  + ([(.status.containerStatuses // [])[] | select(.ready)] | length | tostring) + "/"
  + ((.status.containerStatuses // []) | length | tostring) + " ready, restarts "
  + ([((.status.initContainerStatuses // []) + (.status.containerStatuses // []))[] | "\(.name)=\(.restartCount)"] | join(","))
'
pods_json() { kns get pods -l "app.kubernetes.io/instance=$RELEASE" -o json 2>>"$LOGS/kubectl.err"; }
pods_summary() { pods_json | jq -r "$SUMMARY_JQ" 2>/dev/null | sed 's/^/       /'; }
# run_watched <label> <log> <command...>: the command (a helm install or upgrade with --wait) in the background,
# the release's pods watched meanwhile: a pod that can't start fails the step at once.
# The background command's PID is $helm_pid while it runs, so on_exit stops it on any exit.
run_watched() {
  local label=$1 log=$2 problems code=0
  shift 2
  "$@" >"$log" 2>&1 &
  helm_pid=$!
  while kill -0 "$helm_pid" 2>/dev/null; do
    problems=$(pods_json | jq -r "$PROBLEMS_JQ" 2>/dev/null | sort -u || true)
    if [ -n "$problems" ]; then
      stop_helm
      echo "$problems" | redact | sed 's/^/       /' >&2
      pods_summary >&2
      fail "$label: a pod can't start ($(echo "$problems" | head -n1 | redact)), so the run stops rather than wait"
    fi
    sleep 5
  done
  wait "$helm_pid" || code=$?
  helm_pid=""
  if [ "$code" != 0 ]; then
    shown "$log" 15 >&2
    pods_summary >&2
    fail "$label failed (exit $code; log $log)"
  fi
}
# every_pod_ready: every live pod of the release Ready, none terminating; its summary printed.
every_pod_ready() {
  pods_json >"$STATE/pods.json" || return 1
  jq -e '([.items[] | select(.metadata.deletionTimestamp != null)] | length) == 0
    and (.items | length) > 0
    and all(.items[]; any(.status.conditions[]?; .type == "Ready" and .status == "True"))' "$STATE/pods.json" >/dev/null
}
wait_every_pod_ready() {
  local deadline=$((SECONDS + ${1:-300}))
  until every_pod_ready; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      pods_summary >&2
      fail "the release's pods weren't all Ready within ${1:-300} s"
    fi
    sleep 3
  done
}
pod_of() { kns get pods -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=$1" -o json 2>>"$LOGS/kubectl.err" |
  jq -r '[.items[] | select(.metadata.deletionTimestamp == null)][0].metadata.name // empty'; }
# collect_logs <label>: every container's log (init containers' too, and a previous run's) of every pod in both
# namespaces, into the logs folder, for the searches.
collect_logs() {
  local namespace pod container
  for namespace in "$NS" "$NS_COLLECTORS"; do
    for pod in $(kube -n "$namespace" get pods -o jsonpath='{.items[*].metadata.name}' 2>>"$LOGS/kubectl.err"); do
      for container in $(kube -n "$namespace" get pod "$pod" -o jsonpath='{.spec.initContainers[*].name} {.spec.containers[*].name}' 2>>"$LOGS/kubectl.err"); do
        kube -n "$namespace" logs "$pod" -c "$container" >"$LOGS/pod-$1-$namespace-$pod-$container.log" 2>&1 || true
        kube -n "$namespace" logs "$pod" -c "$container" --previous >"$LOGS/pod-$1-$namespace-$pod-$container.previous.log" 2>/dev/null || true
      done
    done
  done
}

# ---- The cleanup, on every exit.
cleanup_failed() {
  echo "     cleanup FAILED: $*" >&2
  cleanup_failures="$cleanup_failures; $*"
}
stop_forwards() {
  local pid
  for pid in $forward_pids; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  forward_pids=""
}
stop_helm() {
  [ -n "$helm_pid" ] || return 0
  kill "$helm_pid" 2>/dev/null || true
  wait "$helm_pid" 2>/dev/null || true
  helm_pid=""
}
# cleanup_probes: under --keep, the throwaway probe pods and their ConfigMap (otherwise the cluster goes with them).
cleanup_probes() {
  [ "$probes_made" = yes ] && [ -s "$KC" ] || return 0
  kubectl --kubeconfig "$KC" --context "$CONTEXT" -n "$NS" delete pod smoke-probe-plain smoke-probe-evaluator --ignore-not-found --wait=false \
    >>"$LOGS/probes.log" 2>&1 || cleanup_failed "deleting the probe pods"
  kubectl --kubeconfig "$KC" --context "$CONTEXT" -n "$NS" delete configmap smoke-probes --ignore-not-found >>"$LOGS/probes.log" 2>&1 ||
    cleanup_failed "deleting the probes' ConfigMap"
  probes_made=no
}
# cleanup_kubeconfigs: the run's two kubeconfigs (kind's and the flattened one) hold the cluster's admin client key:
# removed on every exit but --keep's, and checked gone.
cleanup_kubeconfigs() {
  [ -e "$KC" ] || [ -e "$KIND_KUBECONFIG" ] || return 0
  rm -f -- "$KC" "$KIND_KUBECONFIG" || true
  if [ -e "$KC" ] || [ -e "$KIND_KUBECONFIG" ]; then
    cleanup_failed "removing the run's kubeconfigs ($KC, $KIND_KUBECONFIG)"
  else
    echo "     removed the run's kubeconfigs ($KC, $KIND_KUBECONFIG): they held a cluster-admin client key"
  fi
}
cleanup_cluster() {
  echo "--- cleanup: kind delete cluster --name $PROFILE (at $(elapsed))"
  if ! kind_cluster delete >"$LOGS/kind-delete.log" 2>&1; then
    cleanup_failed "kind delete cluster --name $PROFILE (log: $LOGS/kind-delete.log)"
    return 0
  fi
  if docker container inspect "$NODE" >/dev/null 2>&1; then
    cleanup_failed "the cluster's node container $NODE is still there after kind delete"
  elif "$KIND" get clusters 2>/dev/null | grep -qx "$PROFILE"; then
    cleanup_failed "kind still lists the cluster $PROFILE after its delete"
  else
    cluster_created=no
    echo "     deleted the cluster $PROFILE"
  fi
}
# cleanup_network: the run's own Docker network (kind leaves it after a delete), removed once the cluster is gone.
cleanup_network() {
  [ "$network_created" = yes ] || return 0
  if ! docker network inspect "$PROFILE" >/dev/null 2>&1; then
    network_created=no
    return 0
  fi
  if docker network rm "$PROFILE" >>"$LOGS/kind-delete.log" 2>&1; then
    network_created=no
    echo "     removed the cluster's Docker network $PROFILE"
  else
    cleanup_failed "removing the Docker network $PROFILE"
  fi
}
cleanup_images() {
  local image current recorded
  if [ "$KEEP_IMAGES" = yes ]; then
    [ -z "$built_images" ] || echo "     --keep-images: kept$built_images"
  else
    # Each tag removed only while it still names the image this run built (its id recorded then). A tag the build
    # didn't produce is skipped; one with no id recorded (a build interrupted by a signal) wasn't there before the
    # run, so it is the run's.
    for image in $built_images; do
      current=$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true)
      if [ -z "$current" ]; then
        echo "     $image isn't there (the build didn't produce it): nothing to remove"
        continue
      fi
      recorded=$(image_id_built "$image")
      if [ -n "$recorded" ] && [ "$current" != "$recorded" ]; then
        cleanup_failed "$image no longer names the image this run built: left in place"
        continue
      fi
      if docker image rm "$image" >>"$LOGS/cleanup-images.log" 2>&1; then echo "     removed the image $image"; else cleanup_failed "removing $image"; fi
    done
  fi
  built_images=""
  # The pinned bases this run pulled are removed always: they weren't on the machine before it.
  for image in $pulled_bases; do
    docker image inspect "$image" >/dev/null 2>&1 || { cleanup_failed "$image (pulled by this run) is gone already"; continue; }
    if docker image rm "$image" >>"$LOGS/cleanup-images.log" 2>&1; then echo "     removed the base $image (pulled by this run)"; else cleanup_failed "removing $image"; fi
  done
  pulled_bases=""
}
cleanup_kubeconfig() {
  local context now
  echo "--- cleanup: your kubeconfig and its context"
  context=$(caller_context)
  if [ "$context" != "$CONTEXT_BEFORE" ] && [ -n "$CONTEXT_BEFORE" ]; then
    echo "     your current context changed to '${context:-none}': restoring '$CONTEXT_BEFORE'"
    if [ -n "$CALLER_KUBECONFIG" ]; then
      KUBECONFIG=$CALLER_KUBECONFIG kubectl config use-context "$CONTEXT_BEFORE" >/dev/null 2>&1 || true
    else
      env -u KUBECONFIG kubectl config use-context "$CONTEXT_BEFORE" >/dev/null 2>&1 || true
    fi
    cleanup_failed "your kubectl context had changed (restored to '$CONTEXT_BEFORE')"
    context=$(caller_context)
  fi
  [ "$context" = "$CONTEXT_BEFORE" ] || cleanup_failed "your current context is '${context:-none}', not '${CONTEXT_BEFORE:-none}'"
  now=$(guarded_state)
  if [ "$now" = "$GUARDED_BEFORE" ]; then
    echo "     unchanged: the context ${CONTEXT_BEFORE:-(none)}, and $GUARDED's sha256 and mtime"
  else
    cleanup_failed "$GUARDED changed during the run (its sha256 or mtime differs)"
  fi
}
# The search: every file left in the work folder (the output log, the pods' logs, Helm's release record and
# manifests among them), but the files that hold the secrets by design, for each value and its base64 form
# (boolean; a file holding one is named, never shown). Then those files are removed.
cleanup_search() {
  local file searched=0 named=0 count
  echo "--- cleanup: the work folder searched for the secrets (at $(elapsed))"
  # The session cookies as they are now (a refresh rotates them).
  add_jar_values "$JAR" || cleanup_failed "a session cookie under 16 characters couldn't be searched for"
  add_jar_values "$SECRETS_DIR/forged-jar" || cleanup_failed "a session cookie under 16 characters couldn't be searched for"
  add_jar_values "$SECRETS_DIR/invitee-jar" || cleanup_failed "a session cookie under 16 characters couldn't be searched for"
  count=$(secrets_count)
  if [ "$count" -lt 1 ]; then
    echo "     no secret was generated yet: nothing to search for"
  else
    find "$WORK" \( -path "$SECRETS_DIR" -o -path "$SECRETS_FILE" -o -path "$WORK/tmp" \) -prune -o -type f -print \
      >"$STATE/searched-files.txt"
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      searched=$((searched + 1))
      if LC_ALL=C grep -qaFf "$VALUES" "$file"; then
        echo "     $file holds a secret (not shown)" >&2
        named=$((named + 1))
      fi
    done <"$STATE/searched-files.txt"
    if [ "$named" = 0 ]; then
      echo "     none of the $count secrets, nor their base64 and base64url forms, in any of the $searched files searched (the output log, the pods' logs and Helm's release record among them)"
    else
      cleanup_failed "$named of $searched files hold a secret"
    fi
  fi
  rm -rf -- "$SECRETS_DIR" "$SECRETS_FILE" "$WORK/tmp" || cleanup_failed "removing the secrets' files"
  [ ! -e "$SECRETS_DIR" ] && [ ! -e "$SECRETS_FILE" ] &&
    echo "     removed the secrets' files ($SECRETS_FILE, $SECRETS_DIR)"
}
summary() {
  local code=$1 total=$((SECONDS - STARTED_AT))
  echo
  echo "=== $PROGRAM: the steps"
  sed 's/^/  /' "$STEPS"
  if [ "$code" = 0 ]; then
    echo "=== $PROGRAM: PASS ($(grep -c '^PASS' "$STEPS") steps) in $((total / 60)) min $((total % 60)) s; work folder $WORK"
  elif [ "$code" = 2 ]; then
    echo "=== $PROGRAM: REFUSED (exit 2) before anything was started; work folder $WORK"
  else
    echo "=== $PROGRAM: FAIL (exit $code) at step $STEP after $((total / 60)) min $((total % 60)) s; work folder $WORK"
  fi
}
keep_instructions() {
  echo
  echo "=== $PROGRAM: --keep: the kind cluster $PROFILE is left running with the release $RELEASE in $NS (fresh volumes)."
  echo "  The port-forwards (their processes were stopped; run each in a terminal of its own):"
  echo "    kubectl --kubeconfig $KC --context $CONTEXT -n $NS port-forward --address 127.0.0.1 svc/telflo-gateway $PORT:80"
  echo "    kubectl --kubeconfig $KC --context $CONTEXT -n $NS port-forward --address 127.0.0.1 svc/mailpit $MAILPIT_PORT:8025"
  echo "  Then open $GATEWAY_URL (the release's publicUrl) and $MAILPIT_URL (the emails). No one can register (the"
  echo "  chart's defaults): make the first admin, then follow its set-password email:"
  echo "    kubectl --kubeconfig $KC --context $CONTEXT -n $NS exec deploy/telflo-api -c api -- telflo-admin bootstrap --email <email> --organization <name>"
  echo "  When done, the cluster, then its Docker network (kind leaves it):"
  echo "    $KIND delete cluster --name $PROFILE --kubeconfig $KIND_KUBECONFIG"
  echo "    docker network rm $PROFILE"
  echo "  The kubeconfigs $KC and $KIND_KUBECONFIG hold the cluster's admin client key: keep them to"
  echo "  yourself, and delete both once the cluster is deleted:"
  echo "    rm -f $KC $KIND_KUBECONFIG"
}
on_exit() {
  local code=$? called
  # First: the cleanup's output must never die on a broken pipe.
  trap '' PIPE
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  [ "$code" = 0 ] || [ "$code" = 2 ] || echo "--- the run failed (exit $code): cleaning up (at $(elapsed))"
  stop_helm
  stop_forwards
  if [ "$cluster_created" = yes ] && [ "$logs_collected" = no ] && [ -s "$KC" ]; then
    collect_logs failed 2>/dev/null
  fi
  if [ "$cluster_created" = yes ]; then
    if [ "$KEEP" = yes ]; then
      cleanup_probes
      echo "--- cleanup: --keep: the kind cluster $PROFILE is left running"
    else
      cleanup_cluster
    fi
  fi
  # The run's network goes once no cluster of the run's is on it (kept under --keep, with its cluster).
  [ "$cluster_created" = yes ] || cleanup_network
  [ "$KEEP" = yes ] && [ "$cluster_created" = yes ] || cleanup_kubeconfigs
  remove_create_log || cleanup_failed "removing kind create's output ($LOGS/kind-create.log)"
  cleanup_images
  [ "$code" = 2 ] || cleanup_kubeconfig
  if called=$(helpers_called); then cleanup_failed "a credential helper's stand-in was called: $called"; fi
  cleanup_search
  if [ -n "$cleanup_failures" ]; then
    echo "FAIL: the cleanup:${cleanup_failures#;}" >&2
    [ "$code" != 0 ] || code=1
  fi
  summary "$code"
  if [ "$KEEP" = yes ] && [ "$cluster_created" = yes ]; then keep_instructions; fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# =====================================================================================================================
step "the refusals: the cluster's name, the images, the ports, Docker's engine and disk"
[ -z "$helm_unset" ] || note "unset, so helm reads only the run's kubeconfig and homes:$helm_unset"
note "$("$KIND" version 2>/dev/null | cut -d' ' -f1-2) (scripts/release/tools.sh), $(kubectl version --client 2>/dev/null | head -n 1), helm $(helm version --short 2>/dev/null), Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), $(curl --version | head -n 1 | cut -d' ' -f1-2)"
note "work folder $WORK; your context ${CONTEXT_BEFORE:-(none)}; the tree $REPO"
if [ -n "$IMAGES_VERSION" ]; then
  note "the release's images ($RELEASE_REGISTRY/<name>:$IMAGES_VERSION); the chart $CHART ($CHART_VERSION, appVersion $CHART_APP_VERSION)"
else
  note "the images' tag $IMAGE_TAG; the chart $CHART ($CHART_VERSION, appVersion $CHART_APP_VERSION)"
fi
# Docker under the run's own config only (never yours): it names no context, so the default engine (or DOCKER_HOST).
docker compose version >/dev/null 2>&1 || refuse "docker compose isn't available"
engine=$(docker info --format '{{.ID}}' 2>/dev/null || true)
[ -n "$engine" ] || refuse "Docker doesn't answer (docker info, under the run's Docker config: the default engine, or DOCKER_HOST)"
note "the Docker engine $(docker info --format '{{.Name}}' 2>/dev/null) ($([ -n "${DOCKER_HOST:-}" ] && echo "DOCKER_HOST" || echo "the default socket"))"
clusters=$("$KIND" get clusters 2>"$LOGS/kind-get-clusters.err") || refuse "kind get clusters failed: $(shown "$LOGS/kind-get-clusters.err" 3)"
if printf '%s\n' "$clusters" | grep -qx "$PROFILE"; then
  refuse "the kind cluster $PROFILE exists already: this script only uses a cluster it creates"
fi
# Its node container, and the run's own network and kubeconfig names, are new too (the network is the cluster's name).
for object in container volume network; do
  if docker "$object" inspect "$PROFILE" >/dev/null 2>&1; then refuse "a Docker $object named $PROFILE exists: name another cluster"; fi
done
if docker container inspect "$NODE" >/dev/null 2>&1; then refuse "a Docker container named $NODE (a kind node's name) exists: name another cluster"; fi
docker image inspect "$KIND_NODE_IMAGE" >/dev/null 2>&1 ||
  refuse "kind's node image $KIND_NODE_IMAGE (tools.lock's kind-node) isn't in the local engine (scripts/release/tools.sh pull kind-node)"
docker image inspect "$NGINX_IMAGE" --format '{{join .RepoDigests " "}}' 2>/dev/null | tr ' ' '\n' | grep -qx "nginx@$NGINX_DIGEST" ||
  refuse "$NGINX_IMAGE at the chart's digest $NGINX_DIGEST isn't in the local engine"
docker image inspect "$OPAMP_IMAGE" --format '{{join .RepoDigests " "}}' 2>/dev/null | tr ' ' '\n' | grep -qx "ghcr.io/telflo/opamp-server@$OPAMP_DIGEST" ||
  refuse "$OPAMP_IMAGE at the PIN's digest $OPAMP_DIGEST isn't in the local engine"
docker image inspect "$MAILPIT_IMAGE" >/dev/null 2>&1 || refuse "$MAILPIT_IMAGE isn't in the local engine"
docker image inspect "$COLLECTOR_IMAGE" >/dev/null 2>&1 || refuse "$COLLECTOR_IMAGE (the catalogue's default collector) isn't in the local engine"
if [ -n "$IMAGES_VERSION" ]; then
  for name in $PLATFORM_IMAGES; do
    docker image inspect "$(image_of "$name")" >/dev/null 2>&1 || refuse "--images: $(image_of "$name") isn't in the local engine (scripts/release/load-images.sh)"
  done
elif [ "$SKIP_BUILD" = yes ]; then
  for name in $PLATFORM_IMAGES; do
    docker image inspect "$(image_of "$name")" >/dev/null 2>&1 || refuse "--skip-build: $(image_of "$name") isn't in the local engine"
  done
else
  for ref in $LOCAL_BASES; do
    docker image inspect "$ref" >/dev/null 2>&1 || refuse "the Dockerfiles' base $ref isn't in the local engine (this script pulls only node and distroless)"
  done
fi
for value in "$PORT" "$MAILPIT_PORT" "$API_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$value") 2>/dev/null; then refuse "something listens on 127.0.0.1:$value already: name another port"; fi
done
DISK_IMAGE=alpine:3
docker image inspect "$DISK_IMAGE" >/dev/null 2>&1 || DISK_IMAGE=$NGINX_IMAGE
docker_free_kb() { docker run --rm --pull never --network none --entrypoint df "$DISK_IMAGE" -Pk / 2>/dev/null | awk 'NR == 2 { print $4 }' || true; }
free_kb=$(docker_free_kb)
[[ "$free_kb" =~ ^[0-9]+$ ]] || refuse "couldn't read Docker's free disk space"
[ "$free_kb" -ge "$MIN_DOCKER_FREE_KB" ] ||
  refuse "Docker's disk has $((free_kb / 1024 / 1024)) GB free, under 10.5 GB (the smoke peaks near 8 GB): free some first"
pass "the cluster $PROFILE is new (and its node and network names), kind's node image is local by digest, the engine is yours, the local images are there, ports $PORT, $MAILPIT_PORT and $API_PORT (the API server's) free, $(awk -v k="$free_kb" 'BEGIN { printf "%.1f", k / 1024 / 1024 }') GB free in Docker's disk"

# =====================================================================================================================
# check_image_users: each platform image runs as its numeric user.
check_image_users() {
  local name user want
  for name in $PLATFORM_IMAGES; do
    user=$(docker image inspect "$(image_of "$name")" --format '{{.Config.User}}' 2>/dev/null || true)
    case "$name" in
      api | web) want=1000:1000 ;;
      ottl-evaluator) want=65532:65532 ;;
      *) want=10001 ;;
    esac
    case "$user" in "$want" | "$want:$want") ;; *) fail "$(image_of "$name") runs as '$user', not $want" ;; esac
  done
}
if [ -n "$IMAGES_VERSION" ]; then
  step "the platform's images: --images $IMAGES_VERSION, the release's, nothing built"
  check_image_users
  pass "the release's $(for name in $PLATFORM_IMAGES; do printf '%s (%s MB) ' "$(image_of "$name")" "$(($(docker image inspect "$(image_of "$name")" --format '{{.Size}}') / 1000000))"; done)with their numeric users"
elif [ "$SKIP_BUILD" = yes ]; then
  step "the platform's images: --skip-build, reused"
  pass "reused $(for name in $PLATFORM_IMAGES; do printf '%s ' "$(image_of "$name")"; done)"
else
  step "the platform's images built from $REPO (compose project $BUILD_PROJECT, tags smoke-kind-*:$IMAGE_TAG, OTELCOL_VERSIONS=$OTELCOL_VERSIONS_ARG)"
  for ref in "$NODE_BASE" "$DISTROLESS_BASE"; do
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      docker pull "$ref" >>"$LOGS/pull-bases.log" 2>&1 || fail "pulling the pinned base $ref failed: $(shown "$LOGS/pull-bases.log" 5)"
      pulled_bases="$pulled_bases $ref"
      note "pulled the pinned base $ref (removed at the end)"
    fi
  done
  if called=$(helpers_called); then fail "a credential helper was called while pulling the bases ($called)"; fi
  {
    echo "# The smoke's own tags (scripts/smoke-kind.sh): never a developer's own telflo-*:dev."
    echo "services:"
    echo "  telflo-api: {image: \"$(image_of api)\"}"
    echo "  telflo-web: {image: \"$(image_of web)\"}"
    echo "  telflo-otelcol-validator: {image: \"$(image_of otelcol-validator)\"}"
    echo "  telflo-otelcol-testing: {image: \"$(image_of otelcol-testing)\"}"
    echo "  telflo-ottl-evaluator: {image: \"$(image_of ottl-evaluator)\"}"
  } >"$STATE/compose-override.yml"
  for name in $PLATFORM_IMAGES; do
    if docker image inspect "$(image_of "$name")" >/dev/null 2>&1; then
      note "$(image_of "$name") exists already: rebuilt over, and not removed at the end"
    else
      built_images="$built_images $(image_of "$name")"
    fi
  done
  build_code=0
  (cd "$REPO" && DOCKER_BUILDKIT=1 COMPOSE_DOCKER_CLI_BUILD=1 OTELCOL_VERSIONS=$OTELCOL_VERSIONS_ARG \
    docker compose -p "$BUILD_PROJECT" -f "$REPO/docker-compose.yml" -f "$STATE/compose-override.yml" \
    build telflo-api telflo-web telflo-otelcol-validator telflo-otelcol-testing telflo-ottl-evaluator) >"$LOGS/build.log" 2>&1 || build_code=$?
  # Each tag's id, recorded before the build's status is acted on (a failed build may still have produced some), so
  # the cleanup removes a tag only while it still names this run's image; a tag the build didn't produce is skipped.
  for image in $built_images; do
    id=$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true)
    if [ -n "$id" ]; then
      echo "$image $id" >>"$STATE/built-ids"
    else
      note "$image wasn't produced by the build: nothing to remove for it"
    fi
  done
  [ "$build_code" = 0 ] || fail "the build failed (exit $build_code): $(shown "$LOGS/build.log" 15)"
  if called=$(helpers_called); then fail "a credential helper was called during the build ($called)"; fi
  for name in $PLATFORM_IMAGES; do
    docker image inspect "$(image_of "$name")" >/dev/null 2>&1 || fail "the build left no $(image_of "$name")"
  done
  check_image_users
  pass "built $(for name in $PLATFORM_IMAGES; do printf '%s (%s MB) ' "$(image_of "$name")" "$(($(docker image inspect "$(image_of "$name")" --format '{{.Size}}') / 1000000))"; done)with their numeric users"
fi

# =====================================================================================================================
step "kind create cluster --name $PROFILE (node $KIND_NODE_IMAGE, its kubeconfig $KIND_KUBECONFIG, the Docker network $PROFILE, the API server on 127.0.0.1:$API_PORT)"
# The API server's host port is the run's (checked free in step 1), never one kind picks: a port kind
# picked was taken by the time Docker bound it in a rehearsal.
printf 'kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnetworking:\n  apiServerAddress: "127.0.0.1"\n  apiServerPort: %s\n' "$API_PORT" >"$WORK/kind-config.yaml"
# The network is new (step 1): kind makes it, so the cleanup removes it, whatever happens from here.
network_created=yes
cluster_created=yes
if ! kind_cluster create --image "$KIND_NODE_IMAGE" --config "$WORK/kind-config.yaml" --wait 300s >"$LOGS/kind-create.log" 2>&1; then
  fail "kind create cluster failed: $(shown "$LOGS/kind-create.log" 15)"
fi
[ "$(caller_context)" = "$CONTEXT_BEFORE" ] || fail "your current context changed when kind created the cluster (the cleanup restores it)"
[ "$(guarded_state)" = "$GUARDED_BEFORE" ] || fail "$GUARDED changed when kind created the cluster"
[ -s "$KIND_KUBECONFIG" ] || fail "kind create cluster wrote no kubeconfig at $KIND_KUBECONFIG"
docker network inspect "$PROFILE" >/dev/null 2>&1 || fail "the cluster isn't on the run's own Docker network $PROFILE"
[ "$(docker container inspect "$NODE" --format '{{range $name, $v := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null)" = "$PROFILE " ] ||
  fail "the node $NODE isn't on the Docker network $PROFILE alone"
kubectl --kubeconfig "$KIND_KUBECONFIG" config view --flatten --minify --context "$CONTEXT" >"$KC" 2>"$LOGS/kubeconfig.err" ||
  fail "flattening the cluster's kubeconfig failed"
[ "$(kubectl --kubeconfig "$KC" config get-contexts -o name 2>/dev/null)" = "$CONTEXT" ] || fail "the flattened kubeconfig doesn't hold exactly the context $CONTEXT"
server=$(kubectl --kubeconfig "$KC" config view --minify --context "$CONTEXT" -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)
[ "$server" = "https://127.0.0.1:$API_PORT" ] || fail "the cluster's API server isn't https://127.0.0.1:$API_PORT (the run's --api-port)"
nodes=$(kube get nodes -o name 2>>"$LOGS/kubectl.err" | grep -c . || true)
[ "$nodes" -ge 1 ] || fail "the cluster answers no node"
kindnet=$(kube -n kube-system get pods -l app=kindnet -o jsonpath='{.items[*].status.phase}' 2>>"$LOGS/kubectl.err" || true)
case "$kindnet" in *Running*) ;; *) fail "kindnet's pod isn't running (phase '$kindnet')" ;; esac
storage=$(kube get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{end}' 2>>"$LOGS/kubectl.err" || true)
[ -n "$storage" ] || fail "the cluster has no default StorageClass (the chart's volumes need one)"
remove_create_log || fail "removing kind create's output failed"
pass "the cluster started ($server, Kubernetes $(kube version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion'), kindnet running, the default StorageClass $storage); your context and $GUARDED untouched"

# =====================================================================================================================
step "the images loaded into the node (kind load docker-image), and postgres:18 pinned pulled in the node"
LOADED="$(for name in $PLATFORM_IMAGES; do printf '%s ' "$(image_of "$name")"; done)$NGINX_IMAGE $MAILPIT_IMAGE $OPAMP_IMAGE $COLLECTOR_IMAGE"
# Each image's id compared as the engine's image store gives it (scripts/smoke-kind/image-id.sh): the
# config digest on the classic store, the manifest digest on containerd's (the runner's Docker may use it).
ENGINE_STORE=$(telflo_engine_store)
for image in $LOADED; do
  "$KIND" load docker-image --name "$PROFILE" "$image" >>"$LOGS/image-load.log" 2>&1 ||
    fail "loading $image into the node failed: $(shown "$LOGS/image-load.log" 5)"
  smoke_kind_image_ids "$image" "$NODE" "$ENGINE_STORE" ||
    fail "$image in the node has the id ${SK_NODE_ID:-none}, not the host's ${SK_HOST_ID:-none} (the engine's $ENGINE_STORE image store)${SK_NODE_ERR:+; crictl said: $SK_NODE_ERR}; kind load said: $(shown "$LOGS/image-load.log" 3)"
done
docker exec "$NODE" crictl pull "$POSTGRES_PINNED" >"$LOGS/pull-postgres.log" 2>&1 ||
  fail "pulling $POSTGRES_PINNED inside the node failed: $(shown "$LOGS/pull-postgres.log" 5)"
docker exec "$NODE" crictl inspecti -o json "$POSTGRES_PINNED" 2>/dev/null | jq -r '.status.repoDigests[]?' 2>/dev/null |
  grep -qx "docker.io/library/postgres@$POSTGRES_DIGEST" || fail "the node's postgres image doesn't carry the pinned digest"
if called=$(helpers_called); then fail "a credential helper was called while the images loaded ($called)"; fi
pass "$(echo "$LOADED" | wc -w | tr -d ' ') images loaded, each the host's image id ($ENGINE_STORE image store); postgres:18@${POSTGRES_DIGEST:0:19}… pulled in the node"

# =====================================================================================================================
step "the namespaces ($NS labeled pod-security.kubernetes.io/enforce=restricted; $NS_COLLECTORS unlabeled) and the Mailpit fixture"
kube create namespace "$NS" >"$LOGS/namespaces.log" 2>&1 || fail "creating $NS failed"
kube label namespace "$NS" pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest >>"$LOGS/namespaces.log" 2>&1 ||
  fail "labelling $NS failed"
kube create namespace "$NS_COLLECTORS" >>"$LOGS/namespaces.log" 2>&1 || fail "creating $NS_COLLECTORS failed"
kns apply -f "$FIXTURES/mailpit.yaml" >"$LOGS/mailpit.log" 2>&1 || fail "applying the Mailpit fixture failed: $(shown "$LOGS/mailpit.log" 5)"
kns rollout status deployment/mailpit --timeout=180s >>"$LOGS/mailpit.log" 2>&1 || fail "Mailpit didn't become ready: $(shown "$LOGS/mailpit.log" 5)"
grep -qi warning "$LOGS/mailpit.log" && fail "applying Mailpit warned (Pod Security?): $(shown "$LOGS/mailpit.log" 5)"
pass "both namespaces made; Mailpit ready under the restricted standard"

# =====================================================================================================================
step "the Secrets: create-secrets.sh --init $SECRETS_FILE, then create-secrets.sh --context $CONTEXT (no pull Secret: every image is local)"
bash "$REPO/scripts/create-secrets.sh" --init "$SECRETS_FILE" >"$LOGS/create-secrets-init.log" 2>&1 ||
  fail "create-secrets.sh --init failed: $(shown "$LOGS/create-secrets-init.log" 5)"
# The values searched for: every key=value line's value.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in "#"* | "["* | "") continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  printf '%s\n' "${line#*=}" >>"$SECRETS_DIR/generated"
done <"$SECRETS_FILE"
add_value_file "$SECRETS_DIR/generated" || fail "a secret under 16 characters can't be searched for: refused"
rm -f "$SECRETS_DIR/generated"
bash "$REPO/scripts/create-secrets.sh" --context "$CONTEXT" --kubeconfig "$KC" --namespace "$NS" "$SECRETS_FILE" >"$LOGS/create-secrets.log" 2>&1 ||
  fail "create-secrets.sh failed: $(shown "$LOGS/create-secrets.log" 5)"
for secret in telflo-postgres telflo-opamp-server telflo-api telflo-internal-services; do
  kns get secret "$secret" >/dev/null 2>&1 || fail "the Secret $secret wasn't created"
  [ -z "$(kns get secret "$secret" -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}' 2>/dev/null)" ] ||
    fail "the Secret $secret carries a last-applied-configuration annotation"
done
if kns get secret ghcr-pull >/dev/null 2>&1; then fail "a ghcr-pull Secret was created (the smoke sets no pull Secret)"; fi
pass "four Secrets created by server-side apply (no last-applied annotation; keys only ever read here), no pull Secret; $(secrets_count) values held for the searches"

# =====================================================================================================================
{
  echo "# The kind smoke's values (scripts/smoke-kind.sh): names and plain settings only."
  echo "publicUrl: \"$GATEWAY_URL\""
  echo "# Every image is local (loaded into the node): no pull secret (the chart's default), nothing pulled."
  if [ -n "$IMAGES_VERSION" ]; then
    echo "# The platform's images: the chart's own references (ghcr.io/telflo/telflo/<name>:<appVersion>), the release's."
  fi
  for key in api web otelcolValidator otelcolTesting ottlEvaluator; do
    case "$key" in
      api) name=api ;; web) name=web ;; otelcolValidator) name=otelcol-validator ;;
      otelcolTesting) name=otelcol-testing ;; ottlEvaluator) name=ottl-evaluator ;;
    esac
    echo "$key:"
    if [ -n "$IMAGES_VERSION" ]; then
      echo "  image: {pullPolicy: Never}"
    else
      echo "  image: {registry: docker.io/library, repository: \"smoke-kind-$name\", tag: \"$IMAGE_TAG\", digest: \"\", pullPolicy: Never}"
    fi
    if [ "$key" = api ]; then
      echo "  opampAllowInsecureConnections: true"
      echo "  mail:"
      echo "    transport: smtp"
      echo "    from: telflo-smoke@example.com"
      echo "    # The fixture's Mailpit takes plain SMTP: tls none (the chart's default, starttls, is a real relay's)."
      echo "    smtp: {host: mailpit, port: 1025, allowInsecure: true, tls: none}"
      echo "  fileStore: {kind: local, size: 1Gi}"
    fi
  done
  echo "gateway:"
  echo "  image: {digest: \"\", pullPolicy: Never}"
  echo "# Postgres: the chart's own reference, postgres:18 at its digest, pulled into the node first."
  echo "postgres:"
  echo "  size: 2Gi"
  echo "opamp-server:"
  echo "  image: {digest: \"\", pullPolicy: Never}"
  echo "  server:"
  echo "    publicUrl: \"$AGENT_URL\""
} >"$VALUES_FILE"
{
  echo "# The upgrade: one pod annotation on every component, so every pod starts again."
  for key in api web gateway otelcolValidator otelcolTesting ottlEvaluator postgres opamp-server; do
    echo "$key:"
    echo "  podAnnotations: {telflo-smoke/upgrade: \"1\"}"
  done
} >"$UPGRADE_VALUES"

step "helm template with the smoke's values renders no kind: Secret"
helm template "$RELEASE" "$CHART" -n "$NS" -f "$VALUES_FILE" >"$STATE/rendered.yaml" 2>"$LOGS/helm-template.err" ||
  fail "helm template failed: $(shown "$LOGS/helm-template.err" 8)"
secrets_rendered=$(grep -cE '^kind:[[:space:]]*"?Secret"?[[:space:]]*$' "$STATE/rendered.yaml" || true)
[ "$secrets_rendered" = 0 ] || fail "helm template rendered $secrets_rendered kind: Secret"
holds_value "$STATE/rendered.yaml" && fail "the rendered manifests hold a secret (not shown)"
pass "$(grep -c '^kind:' "$STATE/rendered.yaml") objects rendered, no Secret, no secret value"

# =====================================================================================================================
step "helm install $RELEASE --wait (Postgres first; the API's migrations wait for it), every pod Ready"
run_watched "helm install" "$LOGS/helm-install.log" \
  helmk -n "$NS" install "$RELEASE" "$CHART" -f "$VALUES_FILE" --wait --timeout "${WAIT_TIMEOUT}s"
wait_every_pod_ready 300
pods_json >"$STATE/pods-installed.json"
pods_summary
api_pod=$(pod_of api) && [ -n "$api_pod" ] || fail "no API pod"
migrate_restarts=$(kns get pod "$api_pod" -o jsonpath='{.status.initContainerStatuses[0].restartCount}' 2>/dev/null) || migrate_restarts=0
# Each platform pod runs the image the run means, in every container (the API's migrate init container too).
for name in $PLATFORM_IMAGES; do
  images=$(jq -r --arg c "$name" '[.items[] | select(.metadata.labels["app.kubernetes.io/component"] == $c)
    | ((.spec.initContainers // []) + .spec.containers)[].image] | unique | join(" ")' "$STATE/pods-installed.json")
  [ "$images" = "$(ref_of "$name")" ] || fail "the $name pod runs '${images:-no pod}', not $(ref_of "$name")"
done
pass "installed; $(jq '.items | length' "$STATE/pods-installed.json") pods Ready (the API's migrate init container started $((migrate_restarts + 1)) times while Postgres came up); the platform's pods run $(ref_of api | sed 's/api:/<name>:/')"

# =====================================================================================================================
step "a second release in $NS is refused"
second_code=0
helmk -n "$NS" install telflo-second "$CHART" -f "$VALUES_FILE" >"$LOGS/second-release.log" 2>&1 || second_code=$?
[ "$second_code" != 0 ] || fail "a second release (telflo-second) was installed in $NS"
if helmk -n "$NS" status telflo-second >/dev/null 2>&1; then
  note "a release record telflo-second was left: uninstalled"
  helmk -n "$NS" uninstall telflo-second >>"$LOGS/second-release.log" 2>&1 || fail "uninstalling the refused telflo-second failed"
fi
# The chart's own guard must refuse it (its fixed message); Helm's ownership check is only the backstop.
if grep -q "already holds another telflo release" "$LOGS/second-release.log"; then
  refused_by="the chart's oneReleaseGuard (its fixed message)"
elif grep -qiE "invalid ownership metadata|cannot be imported|exists and cannot" "$LOGS/second-release.log"; then
  fail "the second release was refused by Helm's ownership check, not the chart's oneReleaseGuard: the guard didn't fire"
else
  fail "the second release failed, but for another reason: $(shown "$LOGS/second-release.log" 5)"
fi
every_pod_ready || fail "the first release's pods aren't all Ready after the refusal"
pass "refused by $refused_by; no telflo-second release left, $RELEASE untouched"

# =====================================================================================================================
pg() { kns exec telflo-postgres-0 -c postgres -- psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d "$1" -c "$2" 2>>"$LOGS/psql.err"; }
# pg_as <role> <password variable> <database>: a TCP sign-in inside the Postgres pod as that role, its password from
# the container's own environment (the variable's NAME on the command line, never its value); its exit code.
pg_as() {
  kns exec telflo-postgres-0 -c postgres -- sh -c \
    "PGPASSWORD=\"\$$2\" psql -X -A -t -h 127.0.0.1 -U $1 -d $3 -c 'select 1'" >"$STATE/pg-as.out" 2>"$STATE/pg-as.err"
}
step "psql in telflo-postgres-0: the bootstraps ran once, each database refuses the other side's roles, telflo_platform_owner no superuser"
kns logs telflo-postgres-0 -c postgres >"$LOGS/postgres-first-start.log" 2>&1 || fail "reading Postgres's log failed"
for script in opamp-initdb.sh telflo-initdb.sh; do
  runs=$(grep -c "running /docker-entrypoint-initdb.d/$script" "$LOGS/postgres-first-start.log" || true)
  [ "$runs" = 1 ] || fail "the first start ran $script $runs times, not once"
done
# telflo_platform_owner: LOGIN and CREATEROLE only; telflo_platform: LOGIN with none of the five.
[ "$(pg postgres "select concat_ws(' ', rolcanlogin::text, rolcreaterole::text, rolsuper::text, rolcreatedb::text, rolbypassrls::text, rolreplication::text) from pg_roles where rolname = 'telflo_platform_owner'")" = "true true false false false false" ] ||
  fail "the role telflo_platform_owner isn't LOGIN CREATEROLE with no SUPERUSER, CREATEDB, BYPASSRLS or REPLICATION"
[ "$(pg telflo_platform "select tableowner from pg_tables where tablename = 'pgmigrations'")" = telflo_platform_owner ] ||
  fail "pgmigrations isn't owned by telflo_platform_owner: the migrations didn't run as the non-superuser owner"
[ "$(pg postgres "select concat_ws(' ', rolcanlogin::text, rolsuper::text, rolbypassrls::text, rolcreatedb::text, rolcreaterole::text, rolreplication::text) from pg_roles where rolname = 'telflo_platform'")" = "true false false false false false" ] ||
  fail "telflo_platform isn't a plain login role (no SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION)"
[ "$(pg postgres "select has_database_privilege('telflo_platform', 'telflo_opamp_server', 'CONNECT')::text")" = false ] ||
  fail "telflo_platform may connect to telflo_opamp_server"
MIGRATIONS_BEFORE=$(pg telflo_platform "select count(*) || ' ' || max(run_on)::text from pgmigrations") || fail "counting the migrations failed"
[[ "$MIGRATIONS_BEFORE" =~ ^[1-9][0-9]*\  ]] || fail "pgmigrations holds no migration"
refusals=""
for case in "telflo_platform_owner TELFLO_OWNER_PASSWORD telflo_opamp_server" "telflo_opamp_server_owner OPAMP_OWNER_PASSWORD telflo_platform" "telflo_opamp_server OPAMP_RUNTIME_PASSWORD telflo_platform"; do
  set -- $case
  if pg_as "$1" "$2" "$3"; then fail "$1 connected to $3"; fi
  grep -q "permission denied for database" "$STATE/pg-as.err" || fail "$1 to $3 failed, but not with 'permission denied for database': $(shown "$STATE/pg-as.err" 3)"
  refusals="$refusals $1→$3"
done
for case in "telflo_platform_owner TELFLO_OWNER_PASSWORD telflo_platform" "telflo_opamp_server_owner OPAMP_OWNER_PASSWORD telflo_opamp_server" "telflo_opamp_server OPAMP_RUNTIME_PASSWORD telflo_opamp_server"; do
  set -- $case
  pg_as "$1" "$2" "$3" || fail "$1 couldn't connect to its own database $3 (the control): $(shown "$STATE/pg-as.err" 3)"
done
pass "each bootstrap ran once; refused:$refusals (each control connects); telflo_platform can't connect to telflo_opamp_server; telflo_platform_owner is no superuser and owns pgmigrations ($(echo "$MIGRATIONS_BEFORE" | cut -d' ' -f1) migrations)"

# =====================================================================================================================
step "helm upgrade (a pod annotation on every component): every pod new and Ready again, the migrate init container migrating nothing"
uids_before=$(jq -r '.items[].metadata.uid' "$STATE/pods-installed.json" | sort)
run_watched "helm upgrade" "$LOGS/helm-upgrade.log" \
  helmk -n "$NS" upgrade "$RELEASE" "$CHART" -f "$VALUES_FILE" -f "$UPGRADE_VALUES" --wait --timeout "${WAIT_TIMEOUT}s"
wait_every_pod_ready 300
pods_json >"$STATE/pods-upgraded.json"
pods_summary
uids_after=$(jq -r '.items[].metadata.uid' "$STATE/pods-upgraded.json" | sort)
[ -z "$(comm -12 <(echo "$uids_before") <(echo "$uids_after"))" ] || fail "some pods weren't restarted by the upgrade"
[ "$(jq '.items | length' "$STATE/pods-upgraded.json")" = "$(jq '.items | length' "$STATE/pods-installed.json")" ] ||
  fail "the upgrade left another number of pods"
MIGRATIONS_AFTER=$(pg telflo_platform "select count(*) || ' ' || max(run_on)::text from pgmigrations") || fail "counting the migrations after the upgrade failed"
[ "$MIGRATIONS_AFTER" = "$MIGRATIONS_BEFORE" ] || fail "the upgrade's init container applied migrations (pgmigrations changed)"
api_pod=$(pod_of api) || fail "finding the API pod failed"
kns logs "$api_pod" -c migrate >"$LOGS/migrate-upgrade.log" 2>&1 || fail "reading the upgrade's migrate log failed"
grep -q "No migrations to run" "$LOGS/migrate-upgrade.log" || fail "the upgrade's migrate log doesn't say 'No migrations to run': $(shown "$LOGS/migrate-upgrade.log" 5)"
grep -q "Provisioned the API's database role." "$LOGS/migrate-upgrade.log" || fail "the upgrade's migrate didn't re-provision telflo_platform"
kns logs telflo-postgres-0 -c postgres >"$LOGS/postgres-upgrade.log" 2>&1 || true
grep -q "Skipping initialization" "$LOGS/postgres-upgrade.log" || fail "Postgres's restart didn't skip its initialisation"
grep -q "running /docker-entrypoint-initdb.d" "$LOGS/postgres-upgrade.log" && fail "Postgres's restart ran a bootstrap again"
pass "every pod restarted and Ready; 'No migrations to run', telflo_platform re-provisioned as the non-superuser owner, pgmigrations unchanged; Postgres skipped its initialisation"

# =====================================================================================================================
step "the static facts: the management Service ClusterIP, the namespace's label, every pod non-root, read-only, no token"
[ "$(kns get svc telflo-opamp-server-management -o jsonpath='{.spec.type}')" = ClusterIP ] || fail "the management Service isn't ClusterIP"
[ "$(kube get namespace "$NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')" = restricted ] || fail "$NS isn't labelled enforce=restricted"
bad=$(jq -r '.items[] | .spec as $s | .metadata.name as $pod
  | (($s.initContainers // []) + $s.containers)[]
  | select(
      ((.securityContext.runAsNonRoot // $s.securityContext.runAsNonRoot // false) != true)
      or ((.securityContext.runAsUser // $s.securityContext.runAsUser // 0) == 0)
      or (.securityContext.readOnlyRootFilesystem != true)
      or ($s.automountServiceAccountToken != false)
      or any(.volumeMounts[]?; .mountPath | startswith("/var/run/secrets/kubernetes.io")))
  | "\($pod)/\(.name)"' "$STATE/pods-upgraded.json")
[ -z "$bad" ] || fail "containers not non-root, read-only and token-free by their spec: $(echo $bad)"
checked=""
for component in api web gateway otelcol-validator otelcol-testing postgres; do
  pod=$(pod_of "$component") || fail "finding the $component pod failed"
  container=$(jq -r --arg p "$pod" '.items[] | select(.metadata.name == $p) | .spec.containers[0].name' "$STATE/pods-upgraded.json")
  # The uid; the root mount's first option (ro or rw, from the kernel's own table: a non-root user can't write / on
  # a writable root either, so a write attempt proves nothing); the service-account mounts.
  facts=$(kns exec "$pod" -c "$container" -- sh -c 'id -u; awk '"'"'$2 == "/" { split($4, o, ","); print o[1]; exit }'"'"' /proc/mounts; grep -c serviceaccount /proc/mounts || true' 2>>"$LOGS/kubectl.err" | tr '\n' ' ') || fail "reading $pod/$container's facts failed"
  set -- $facts
  [ "${1:-0}" != 0 ] && [ "${2:-}" = ro ] && [ "${3:-1}" = 0 ] || fail "$pod/$container answered uid '${1:-?}', root mounted '${2:-?}', token mounts '${3:-?}'"
  checked="$checked $component(uid $1)"
done
pass "management ClusterIP; enforce=restricted; $(jq '[.items[] | (.spec.initContainers // []) + .spec.containers | length] | add' "$STATE/pods-upgraded.json") containers non-root, read-only, no token by spec; inside:$checked"

# =====================================================================================================================
step "the NetworkPolicies under kindnet: the sandbox reaches nothing, a throwaway pod reaches none of the closed ports"
kns create configmap smoke-probes --from-file=tcp-probe.js="$FIXTURES/tcp-probe.js" >"$LOGS/probes.log" 2>&1 || fail "creating the probes' ConfigMap failed"
probes_made=yes
API_IP=$(kns get svc telflo-api -o jsonpath='{.spec.clusterIP}') || fail "reading the API Service's address failed"
GATEWAY_IP=$(kns get svc telflo-gateway -o jsonpath='{.spec.clusterIP}') || fail "reading the gateway Service's address failed"
DNS_IP=$(kube -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}') || fail "reading kube-dns's address failed"
[ -n "$API_IP" ] && [ -n "$GATEWAY_IP" ] && [ -n "$DNS_IP" ] || fail "couldn't read the API's, the gateway's and DNS's Service addresses"
# service_ready <namespace> <service> <port>: the Service exists, serves that port and has a ready endpoint (its
# EndpointSlices): so a closed probe to it is the policy's doing, never a Service with nothing behind it.
service_ready() {
  local ports ready
  ports=$(kube -n "$1" get svc "$2" -o jsonpath='{.spec.ports[*].port}' 2>>"$LOGS/kubectl.err") || fail "the Service $1/$2 doesn't exist"
  case " $ports " in *" $3 "*) ;; *) fail "the Service $1/$2 doesn't serve port $3 (its ports: $ports)" ;; esac
  ready=$(kube -n "$1" get endpointslices -l "kubernetes.io/service-name=$2" -o json 2>>"$LOGS/kubectl.err" |
    jq '[.items[].endpoints[]? | select(.conditions.ready == true)] | length') || fail "reading $1/$2's EndpointSlices failed"
  [ "${ready:-0}" -ge 1 ] || fail "the Service $1/$2 has no ready endpoint: a closed probe to it would prove nothing"
}
# service_of <target>: the namespace, Service and port a probe target names (an address: the API's, the gateway's
# or DNS's Service; a name: that Service in the release's namespace); nothing for the outside address.
service_of() {
  local host=${1%:*} port=${1##*:}
  case "$host" in
    "$OUTSIDE_IP") ;;
    "$API_IP") echo "$NS telflo-api $port" ;;
    "$GATEWAY_IP") echo "$NS telflo-gateway $port" ;;
    "$DNS_IP") echo "kube-system kube-dns $port" ;;
    *) echo "$NS $host $port" ;;
  esac
}
# probe_pod <name> <labels JSON> <targets...>: a throwaway pod of the API's image (restricted, never Ready, so it is
# never a Service's endpoint) running tcp-probe.js; its lines in $STATE/<name>.out.
probe_pod() {
  local name=$1 labels=$2 phase=""
  shift 2
  jq -n --arg name "$name" --argjson labels "$labels" --arg image "$(ref_of api)" --args '{
    apiVersion: "v1", kind: "Pod",
    metadata: {name: $name, labels: $labels},
    spec: {
      restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
      securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: {type: "RuntimeDefault"}},
      containers: [{
        name: "probe", image: $image, imagePullPolicy: "Never",
        command: (["node", "/probe/tcp-probe.js"] + $ARGS.positional),
        readinessProbe: {exec: {command: ["false"]}, periodSeconds: 1},
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true,
          capabilities: {drop: ["ALL"]}, seccompProfile: {type: "RuntimeDefault"}},
        volumeMounts: [{name: "probe", mountPath: "/probe", readOnly: true}]
      }],
      volumes: [{name: "probe", configMap: {name: "smoke-probes"}}]
    }}' "$@" >"$STATE/$name.json"
  kns apply -f "$STATE/$name.json" >>"$LOGS/probes.log" 2>&1 || fail "starting the probe pod $name failed: $(shown "$LOGS/probes.log" 3)"
  for _ in $(seq 1 120); do
    phase=$(kns get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in Succeeded | Failed) break ;; esac
    sleep 1
  done
  kns logs "$name" >"$STATE/$name.out" 2>&1 || true
  kns delete pod "$name" --wait=false >>"$LOGS/probes.log" 2>&1 || true
  [ "$phase" = Succeeded ] || fail "the probe pod $name ended ${phase:-unfinished}: $(shown "$STATE/$name.out" 5)"
}
# expect <file> <target> open|closed [<other closed reason allowed>]: open, or closed by a timeout (a NetworkPolicy
# drops the packets: a refusal or an unknown name would be something else). A closed target's Service must exist,
# serve the port and have a ready endpoint.
expect() {
  local got service
  got=$(awk -v t="$2" '$1 == t { print $2 " " $3 }' "$1")
  if [ "$3" = closed ]; then
    service=$(service_of "$2")
    [ -z "$service" ] || service_ready $service
    case "$got" in "closed timeout" | "closed ${4:-timeout}") return 0 ;; esac
    fail "$(basename "$1" .out): $2 is '${got:-not probed}', not closed by a timeout"
  fi
  [ "$got" = "open " ] || fail "$(basename "$1" .out): $2 is '${got:-not probed}', not open"
}
probe_pod smoke-probe-plain '{"app.kubernetes.io/name": "telflo-smoke-probe"}' \
  telflo-api:8080 telflo-postgres:5432 telflo-opamp-server-management:51235 telflo-web:3000 \
  otelcol-validator:8001 otelcol-testing:8002 ottl-evaluator:8003 \
  telflo-gateway:80 "$GATEWAY_IP:80" telflo-opamp-server-agent:51234 mailpit:8025 "$OUTSIDE_IP:443"
for target in telflo-api:8080 telflo-postgres:5432 telflo-opamp-server-management:51235 telflo-web:3000 otelcol-validator:8001 otelcol-testing:8002 ottl-evaluator:8003; do
  expect "$STATE/smoke-probe-plain.out" "$target" closed
done
# The controls: what a pod with no policy of its own reaches, so the sandbox's refusals below are its policies'.
for target in telflo-gateway:80 "$GATEWAY_IP:80" telflo-opamp-server-agent:51234 mailpit:8025 "$OUTSIDE_IP:443"; do
  expect "$STATE/smoke-probe-plain.out" "$target" open
done
# A pod carrying the evaluator's labels: no DNS either, so a name may also fail as EAI_AGAIN (the lookup's own
# timeout); an address must time out.
probe_pod smoke-probe-evaluator "{\"app.kubernetes.io/name\": \"telflo\", \"app.kubernetes.io/instance\": \"$RELEASE\", \"app.kubernetes.io/component\": \"ottl-evaluator\"}" \
  "$OUTSIDE_IP:443" "$API_IP:8080" telflo-api:8080 "$DNS_IP:53" "$GATEWAY_IP:80" telflo-gateway:80
for target in "$OUTSIDE_IP:443" "$API_IP:8080" "$DNS_IP:53" "$GATEWAY_IP:80"; do
  expect "$STATE/smoke-probe-evaluator.out" "$target" closed
done
for target in telflo-api:8080 telflo-gateway:80; do
  expect "$STATE/smoke-probe-evaluator.out" "$target" closed EAI_AGAIN
done
# The tester and the validator, through their own Python: an address must time out (TimeoutError), a name finds no
# DNS (any refusal); the gateway's address is one the plain pod reached above.
for component in otelcol-testing otelcol-validator; do
  pod=$(pod_of "$component") || fail "finding the $component pod failed"
  kns exec -i "$pod" -c "$component" -- python - "http://$OUTSIDE_IP/" "http://$API_IP:8080/health" "http://$GATEWAY_IP/" "http://telflo-api:8080/health" \
    <"$FIXTURES/sandbox-probe.py" >"$STATE/sandbox-$component.out" 2>>"$LOGS/kubectl.err" || fail "probing from $component failed"
  for url in "http://$OUTSIDE_IP/" "http://$API_IP:8080/health" "http://$GATEWAY_IP/"; do
    [ "$(awk -v u="$url" '$1 == u { print $2 " " $3 }' "$STATE/sandbox-$component.out")" = "refused TimeoutError" ] ||
      fail "$component: $url wasn't refused by a timeout: $(tr '\n' ';' <"$STATE/sandbox-$component.out")"
  done
  [ "$(awk -v u="http://telflo-api:8080/health" '$1 == u { print $2 }' "$STATE/sandbox-$component.out")" = refused ] ||
    fail "$component reached the API by name: $(tr '\n' ';' <"$STATE/sandbox-$component.out")"
done
gateway_pod=$(pod_of gateway) || fail "finding the gateway pod failed"
kns exec "$gateway_pod" -c nginx -- wget -q -T 5 -O /dev/null http://telflo-api:8080/api/public/v1/health >/dev/null 2>>"$LOGS/kubectl.err" ||
  fail "the gateway didn't reach the API"
kns exec "$gateway_pod" -c nginx -- wget -q -T 5 -O /dev/null http://telflo-web:3000/favicon.ico >/dev/null 2>>"$LOGS/kubectl.err" ||
  fail "the gateway didn't reach web"
kns delete configmap smoke-probes >>"$LOGS/probes.log" 2>&1 || fail "deleting the probes' ConfigMap failed"
probes_made=no
pass "a plain pod: the API, Postgres, the management port, web and the sandbox closed by timeouts (each Service ready), the gateway (name and address), the agent port, Mailpit and the outside open; an evaluator-labelled pod: the outside, the API, DNS and the gateway (addresses and names) closed; the tester and validator timed out to the outside, the API and the gateway, and found no DNS; the gateway reaches the API and web"

# =====================================================================================================================
step "the port-forwards on 127.0.0.1 ($GATEWAY_URL, $MAILPIT_URL): /login 200, /api/v1/auth/me 401, the API reference page"
start_forward() { # <service> <local port> <remote port>
  kubectl --kubeconfig "$KC" --context "$CONTEXT" -n "$NS" port-forward --address 127.0.0.1 "svc/$1" "$2:$3" >"$LOGS/port-forward-$1.log" 2>&1 &
  forward_pids="$forward_pids $!"
}
start_forward telflo-gateway "$PORT" 80
start_forward mailpit "$MAILPIT_PORT" 8025
status=000
for _ in $(seq 1 30); do
  status=$(curl -q -s -o "$STATE/login.html" -w '%{http_code}' --max-time 5 "$GATEWAY_URL/login" || true)
  [ "$status" = 200 ] && break
  sleep 1
done
[ "$status" = 200 ] || fail "GET /login through the port-forward answered $status: $(shown "$LOGS/port-forward-telflo-gateway.log" 3)"
mailpit_status=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "$MAILPIT_URL/api/v1/messages" || true)
[ "$mailpit_status" = 200 ] || fail "Mailpit's API through its port-forward answered $mailpit_status"
status=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 10 "$GATEWAY_URL/api/v1/auth/me" || true)
[ "$status" = 401 ] || fail "GET /api/v1/auth/me without a session answered $status, not 401"
status=$(curl -q -s -o /dev/null -D "$STATE/docs-redirect.headers" -w '%{http_code}' --max-time 10 "$GATEWAY_URL/api/public/v1/docs" || true)
[ "$status" = 301 ] && grep -qiE '^location: /api/public/v1/docs/'$'\r''?$' "$STATE/docs-redirect.headers" ||
  fail "GET /api/public/v1/docs answered $status, not a 301 to /api/public/v1/docs/"
DOCS_CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
status=$(curl -q -s -o "$STATE/docs.html" -D "$STATE/docs.headers" -w '%{http_code}' --max-time 10 "$GATEWAY_URL/api/public/v1/docs/" || true)
[ "$status" = 200 ] && grep -qF 'src="/api/public/v1/docs/swagger-ui-bundle.js"' "$STATE/docs.html" ||
  fail "GET /api/public/v1/docs/ answered $status, or not the reference page"
grep -qixF "content-security-policy: $DOCS_CSP"$'\r' "$STATE/docs.headers" || fail "the reference page's CSP isn't the page's own"
grep -qiE '^x-content-type-options: nosniff'$'\r''?$' "$STATE/docs.headers" || fail "the reference page isn't nosniff"
grep -qiE '^referrer-policy: no-referrer'$'\r''?$' "$STATE/docs.headers" || fail "the reference page's Referrer-Policy isn't no-referrer"
pass "/login 200, Mailpit 200, /api/v1/auth/me 401, /api/public/v1/docs 301 → /docs/ 200 with its CSP, nosniff and no-referrer"

# =====================================================================================================================
step "registration refused; the first admin by telflo-admin bootstrap, its printed set-password link, sign in (curl keeps the Secure cookies on http://localhost) landing in its organization; a teammate invited and joined; a configuration created, validated, run in the tester and published"
EMAIL="smoke-$(date +%s)-$$@example.com"
INVITEE_EMAIL="smoke-invitee-$(date +%s)-$$@example.com"
GROUP_NAME="Kind smoke $(date +%s)-$$"
# Under the chart's defaults (registration invite-only) the API refuses a sign-up before it reads the body.
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -X POST "$GATEWAY_URL/api/v1/auth/register" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary '{}' || true)
[ "$status" = 403 ] && [ "$(reply_json '.error.code')" = registration_not_open ] ||
  fail "register answered $status ($(reply_code)), not 403 registration_not_open: the chart's default registration isn't invite-only"
# The first product admin, in the API's own container (its settings and its database role).
# It sends no email: its output is fixed lines and the address, then the set-password link as the last line.
# The link is a secret: stdout goes to a file of the run's secrets (mode 0600 by the umask,
# never searched, removed at the end); the logs get its other lines only.
kns exec deploy/telflo-api -c api -- telflo-admin bootstrap --email "$EMAIL" --organization "$GROUP_NAME" \
  </dev/null >"$SECRETS_DIR/bootstrap.out" 2>"$LOGS/bootstrap.err" || {
  grep -vE 'token=|reset-password' "$SECRETS_DIR/bootstrap.out" >"$LOGS/bootstrap.out" || true
  fail "telflo-admin bootstrap failed: $(shown "$LOGS/bootstrap.err" 5) $(shown "$LOGS/bootstrap.out" 5)"
}
grep -vE 'token=|reset-password' "$SECRETS_DIR/bootstrap.out" >"$LOGS/bootstrap.out" || true
grep -qE 'token=|reset-password' "$LOGS/bootstrap.err" && fail "telflo-admin bootstrap wrote a token or a link to stderr (not shown)"
[ "$(grep -cE 'token=|reset-password' "$SECRETS_DIR/bootstrap.out" || true)" = 1 ] ||
  fail "telflo-admin bootstrap printed no link, or more than one (not shown)"
grep -qxF "Created the account $EMAIL and made it the first product admin." "$LOGS/bootstrap.out" &&
  grep -qxF "Created the organization, with the account as its admin." "$LOGS/bootstrap.out" &&
  [ "$(tail -n 1 "$LOGS/bootstrap.out")" = "Open this link within 60 minutes to set the password (it works once):" ] ||
  fail "telflo-admin bootstrap didn't report the account, its organization and the link's line: $(shown "$LOGS/bootstrap.out" 5)"
# The link: stdout's last line, into a variable only (tail's argument is the file; the link is never on a command
# line, echoed or logged).
link=$(tail -n 1 "$SECRETS_DIR/bootstrap.out")
[[ "$link" == "$GATEWAY_URL/reset-password#token="* ]] ||
  fail "telflo-admin bootstrap's last line isn't a link to the publicUrl's /reset-password (not shown)"
# mail_link <address> <path>: the first link to $GATEWAY_URL<path>#token=… in the newest email to <address>, waited
# for up to 30 s, into $link (never printed).
mail_link() {
  local query message_id=""
  query=$(jq -rn --arg q "to:\"$1\"" '$q | @uri')
  for _ in $(seq 1 30); do
    message_id=$(curl -q -s "$MAILPIT_URL/api/v1/search?query=$query" | jq -r '.messages[0].ID // empty' 2>/dev/null || true)
    [ -n "$message_id" ] && break
    sleep 1
  done
  [ -n "$message_id" ] || fail "no email to $1 reached the in-cluster Mailpit within 30 s"
  link=$(curl -q -s "$MAILPIT_URL/api/v1/message/$message_id" | jq -r '.Text' | grep -oE "https?://[^[:space:]]+$2#token=[A-Za-z0-9_-]+" | head -n1 || true)
  [[ "$link" == "$GATEWAY_URL$2#token="* ]] || fail "the email to $1 holds no link to the publicUrl's $2 ($GATEWAY_URL$2#token=…)"
}
# Never mailed: no email to the address reached the in-cluster Mailpit.
mail_query=$(jq -rn --arg q "to:\"$EMAIL\"" '$q | @uri')
mails=$(curl -q -s --max-time 30 "$MAILPIT_URL/api/v1/search?query=$mail_query" | jq -r '(.messages // []) | length' 2>/dev/null || true)
[ "$mails" = 0 ] || fail "telflo-admin bootstrap sent an email to the address, or Mailpit's search answered nothing (${mails:-no answer})"
openssl rand -hex 16 | tr -d '\n' >"$SECRETS_DIR/password"
add_value_file "$SECRETS_DIR/password" || fail "a secret under 16 characters can't be searched for: refused"
# The link's one-use token: off every command line (printf is a builtin), into the searched values.
printf '%s\n' "${link##*token=}" >"$SECRETS_DIR/set-password-token"
add_value_file "$SECRETS_DIR/set-password-token" || fail "a secret under 16 characters can't be searched for: refused"
printf '%s' "${link##*token=}" | jq -Rs --rawfile p "$SECRETS_DIR/password" '{token: ., password: $p}' >"$SECRETS_DIR/set-password.json"
link=""
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -X POST "$GATEWAY_URL/api/v1/auth/password-resets" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$SECRETS_DIR/set-password.json" || true)
[ "$status" = 204 ] || fail "setting the password from the bootstrap's link answered $status: $(reply_code)"
jq -n --arg e "$EMAIL" --rawfile p "$SECRETS_DIR/password" '{email: $e, password: $p}' >"$SECRETS_DIR/sign-in.json"
status=$(curl -q -s -o "$REPLY_BODY" -D "$SIGN_IN_HEADERS" -w '%{http_code}' --max-time 30 -c "$JAR" -X POST "$GATEWAY_URL/api/v1/auth/sessions" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$SECRETS_DIR/sign-in.json" || true)
[ "$status" = 200 ] || fail "sign-in answered $status: $(reply_code)"
grep -qiE '^set-cookie: telflo_access=[^;]+;.*[Ss]ecure' "$SIGN_IN_HEADERS" || fail "the access cookie isn't set Secure"
# curl's jar (Netscape format): field 4 is the cookie's secure flag; curl keeps a Secure cookie from http://localhost.
[ "$(awk -F '\t' '$6 == "telflo_access" { print $4 }' "$JAR")" = TRUE ] || fail "curl didn't keep the Secure telflo_access cookie from $GATEWAY_URL"
platform GET "$GATEWAY_URL/api/v1/auth/me"
[ "$status" = 200 ] || fail "/api/v1/auth/me with the jar answered $status: curl didn't send the Secure cookie back over http://localhost"
add_jar_values "$JAR" || fail "a secret under 16 characters can't be searched for: refused"
USER_ID=$(reply_json '.user.id')
GROUP_ID=$(reply_json --arg n "$GROUP_NAME" '[.organizations[] | select(.type == "group" and .name == $n and .role == "admin")][0].id // empty')
[[ "$USER_ID" =~ ^[0-9a-f-]{36}$ ]] && [[ "$GROUP_ID" =~ ^[0-9a-f-]{36}$ ]] || fail "/me named no user, or no group organization the account admins"
[ "$(reply_json '.isProductAdmin')" = true ] && [ "$(reply_json '.termsAcceptanceRequired')" = false ] ||
  fail "/me: the bootstrapped account isn't a product admin, or is asked for Terms (the chart's defaults set none)"
# The first sign-in lands in the organization the bootstrap made: no earlier session, so the newest membership.
[ "$(reply_json '.organization.id')" = "$GROUP_ID" ] || fail "/me: the first sign-in didn't land in the bootstrap's organization"
# Invitations act on the session's active organization: the switch to the group organization is a no-op now.
platform PUT "$GATEWAY_URL/api/v1/auth/sessions/current/organization" "$(body switch '{organizationId: $id}' --arg id "$GROUP_ID")"
[ "$status" = 200 ] && [ "$(reply_json '.organization.id')" = "$GROUP_ID" ] || fail "switching to the group organization answered $status: $(reply_code)"
add_jar_values "$JAR" || fail "a secret under 16 characters can't be searched for: refused"
platform POST "$GATEWAY_URL/api/v1/organizations/$GROUP_ID/invitations" "$(body invite '{email: $e, role: "contributor"}' --arg e "$INVITEE_EMAIL")"
[ "$status" = 201 ] || fail "inviting a teammate answered $status: $(reply_code)"
openssl rand -hex 16 | tr -d '\n' >"$SECRETS_DIR/invitee-password"
add_value_file "$SECRETS_DIR/invitee-password" || fail "a secret under 16 characters can't be searched for: refused"
mail_link "$INVITEE_EMAIL" /accept-invitation
printf '%s\n' "${link##*token=}" >"$SECRETS_DIR/invitation-token"
add_value_file "$SECRETS_DIR/invitation-token" || fail "a secret under 16 characters can't be searched for: refused"
# No acceptedTermsVersion: the chart's defaults set no Terms.
printf '%s' "${link##*token=}" | jq -Rs --rawfile p "$SECRETS_DIR/invitee-password" '{token: ., password: $p}' >"$SECRETS_DIR/invitation-registration.json"
link=""
INVITEE_JAR="$SECRETS_DIR/invitee-jar"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -c "$INVITEE_JAR" -X POST "$GATEWAY_URL/api/v1/invitation-registrations" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' --data-binary "@$SECRETS_DIR/invitation-registration.json" || true)
[ "$status" = 201 ] && [ "$(reply_json '.organization.id')" = "$GROUP_ID" ] || fail "registering from the invitation answered $status: $(reply_code)"
add_jar_values "$INVITEE_JAR" || fail "a secret under 16 characters can't be searched for: refused"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -b "$INVITEE_JAR" "$GATEWAY_URL/api/v1/auth/me" || true)
[ "$status" = 200 ] && [ "$(reply_json '.user.email')" = "$INVITEE_EMAIL" ] && [ "$(reply_json '.organization.id')" = "$GROUP_ID" ] &&
  [ "$(reply_json '.organization.role')" = contributor ] && [ "$(reply_json '.isProductAdmin')" = false ] &&
  [ "$(reply_json '.termsAcceptanceRequired')" = false ] ||
  fail "/me as the invitee answered $status, or not a contributor of the group organization without Terms: $(reply_code)"
# The rest of the smoke runs in the group organization, the session's active one.
ORGANIZATION_ID=$GROUP_ID
ORGANIZATION_URL="$GATEWAY_URL/api/v1/organizations/$ORGANIZATION_ID"
CONFIGURATIONS_URL="$ORGANIZATION_URL/configurations"
FLEETS_URL="$ORGANIZATION_URL/fleets"
V1_YAML=$'# The kind smoke\'s configuration, version 1\nreceivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 127.0.0.1:4320\nprocessors:\n  batch: {}\nexporters:\n  debug:\n    verbosity: basic\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [debug]\n'
V2_YAML=$'# The kind smoke\'s configuration, version 2\nreceivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 127.0.0.1:4320\nprocessors:\n  batch: {}\nexporters:\n  debug:\n    verbosity: detailed\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [debug]\n'
INVALID_YAML=$'receivers:\n  otlp:\n    protocols:\n      http: {}\nexporters:\n  debug: {}\n  nosuchexporter: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug, nosuchexporter]\n'
platform POST "$CONFIGURATIONS_URL" "$(body configuration-create '{name: $n, description: "scripts/smoke-kind.sh"}' --arg n "Kind smoke $(date +%s)-$$")"
[ "$status" = 201 ] || fail "creating the configuration answered $status: $(reply_code)"
CONFIGURATION_ID=$(reply_json '.configuration.id')
platform GET "$CONFIGURATIONS_URL/$CONFIGURATION_ID"
V1_ID=$(reply_json '.version.id')
V1_COLLECTOR=$(reply_json '.version.collectorVersion')
[ "$status" = 200 ] && [ -n "$V1_ID" ] || fail "reading the configuration answered $status: $(reply_code)"
platform PATCH "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID" "$(body save-v1 '{yamlContent: $y, nodes: [], edges: [], pipelines: []}' --arg y "$V1_YAML")"
[ "$status" = 200 ] || fail "saving version 1 answered $status: $(reply_code)"
platform POST "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID/validation" "$(body validate-valid '{yaml: $y}' --arg y "$V1_YAML")"
[ "$status" = 200 ] && [ "$(reply_json '.status')" = valid ] || fail "validating version 1's text answered $status: $(reply_json -c '{status, errors}')"
platform POST "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID/validation" "$(body validate-invalid '{yaml: $y}' --arg y "$INVALID_YAML")"
[ "$status" = 200 ] && [ "$(reply_json '.status')" = invalid ] && [ "$(reply_json -c '[.errors[].componentPath]')" = '["exporters::nosuchexporter"]' ] ||
  fail "validating an invalid text answered $status: $(reply_json -c '{status, errors: [.errors[]?.componentPath]}')"
RECORD_BODY="kind smoke record $(date +%s)-$$"
jq -n --arg b "$RECORD_BODY" '{resourceLogs: [{resource: {attributes: [{key: "service.name", value: {stringValue: "kind-smoke"}}]},
  scopeLogs: [{scope: {}, logRecords: [{timeUnixNano: "1700000000000000000", severityText: "INFO", body: {stringValue: $b}}]}]}]}' \
  >"$STATE/smoke-logs.json"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 60 -b "$JAR" -c "$JAR" -X POST "$ORGANIZATION_URL/test-files" -H 'X-Telflo-CSRF: 1' \
  -F 'displayName=Kind smoke logs' -F 'description=' -F "file=@$STATE/smoke-logs.json;type=application/json;filename=smoke-logs.json" || true)
[ "$status" = 201 ] || fail "uploading the test file answered $status: $(reply_code)"
TEST_FILE_ID=$(reply_json '.file.id')
TEST_RUN_YAML=$'receivers:\n  otlp:\n    protocols:\n      http: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n'
TEST_RUNS_URL="$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID/test-runs"
platform POST "$TEST_RUNS_URL" "$(body test-run '{inputFileId: $f, pipeline: "logs", signal: "logs", durationSeconds: 2, yaml: $y, collectorVersion: $v}' \
  --arg f "$TEST_FILE_ID" --arg y "$TEST_RUN_YAML" --arg v "$V1_COLLECTOR")"
[ "$status" = 201 ] || fail "queuing the test run answered $status: $(reply_code)"
TEST_RUN_ID=$(reply_json '.run.id')
run_status=""
for _ in $(seq 1 180); do
  platform GET "$TEST_RUNS_URL/$TEST_RUN_ID"
  run_status=$(reply_json '.run.status')
  [ "$run_status" = succeeded ] || [ "$run_status" = failed ] && break
  sleep 1
done
[ "$run_status" = succeeded ] || fail "the test run ended ${run_status:-unfinished}: $(reply_json -c '.run | {status, errorCode, strategy, collectorVersion}')"
platform GET "$TEST_RUNS_URL/$TEST_RUN_ID/files/output"
[ "$status" = 200 ] && grep -qF "$RECORD_BODY" "$REPLY_BODY" || fail "the test run's output answered $status, or doesn't hold the record"
platform POST "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V1_ID/publish"
[ "$status" = 200 ] || fail "publishing version 1 answered $status: $(reply_code)"
pass "registration refused (403 registration_not_open); telflo-admin bootstrap made the first product admin and its organization, its set-password link printed last (the publicUrl's, never logged) and no email sent; signed in, landing in its organization (the Secure cookie kept and sent by curl $(curl --version | head -n1 | cut -d' ' -f2)); a teammate invited, joined as a contributor without Terms; validated (valid; invalid names exporters::nosuchexporter), the test run succeeded in the tester (its output read back through the file store), version 1 published"

# =====================================================================================================================
step "a fleet and a gateway-role collector (this tree's supervisor-collector chart in $NS_COLLECTORS): it enrolls, applies version 1, then follows version 2"
FLEET_ID=$(uuid4)
platform POST "$FLEETS_URL" "$(body fleet-create '{id: $id, label: $l, type: "kubernetes-supervisor", rotateExpiresAt: null}' --arg id "$FLEET_ID" --arg l "kind-smoke-$$")"
jq -r '.tokens.default.bearer // empty, .tokens.rotate.bearer // empty' "$REPLY_BODY" >"$SECRETS_DIR/fleet-bearers" 2>/dev/null || true
add_value_file "$SECRETS_DIR/fleet-bearers" || fail "a secret under 16 characters can't be searched for: refused"
[ "$status" = 201 ] || fail "creating the fleet answered $status: $(reply_code)"
[ "$(grep -c . "$SECRETS_DIR/fleet-bearers")" = 2 ] || fail "the fleet's create answered no two bearers (not shown)"
ROTATE_TOKEN_ID=$(reply_json '.tokens.rotate.id')
DEFAULT_TOKEN_ID=$(reply_json '.tokens.default.id')
: >"$REPLY_BODY"
FLEET_URL="$FLEETS_URL/$FLEET_ID"
platform POST "$FLEET_URL/groups" "$(body group-create '{name: $n, assignedVersionId: $v, annotations: {telflo: {kubernetes: {role: "gateway", namespace: $ns, replicas: 1, volumes: []}}}}' \
  --arg n "$GATEWAY_GROUP" --arg v "$V1_ID" --arg ns "$NS_COLLECTORS")"
[ "$status" = 201 ] || fail "creating the group $GATEWAY_GROUP answered $status: $(reply_code)"
GROUP_ID=$(reply_json '.group.id')
platform GET "$FLEET_URL/groups/$GROUP_ID/install"
[ "$status" = 200 ] || fail "reading the group's install facts answered $status: $(reply_code)"
grep -qiE '^cache-control:[[:space:]]*no-store' "$REPLY_HEADERS" || fail "the install facts aren't no-store"
cp "$REPLY_BODY" "$STATE/facts.json"
[ "$(jq -r '.endpoint' "$STATE/facts.json")" = "$AGENT_URL" ] || fail "the facts' endpoint isn't the agent URL $AGENT_URL"
[ "$(jq -r '.imageTag' "$STATE/facts.json")" = "$COLLECTOR_IMAGE" ] || fail "the facts' image isn't $COLLECTOR_IMAGE (the one loaded into the node)"
[ "$(jq -r '.allowInsecureConnections' "$STATE/facts.json")" = true ] || fail "the facts don't allow an insecure connection (api.opampAllowInsecureConnections)"
platform POST "$FLEET_URL/tokens/$DEFAULT_TOKEN_ID/reveal"
[ "$status" = 200 ] || fail "revealing the default token answered $status: $(reply_code)"
jq -j '.token.bearer // empty' "$REPLY_BODY" >"$SECRETS_DIR/bearer"
: >"$REPLY_BODY"
add_value_file "$SECRETS_DIR/bearer" || fail "a secret under 16 characters can't be searched for: refused"
[ -s "$SECRETS_DIR/bearer" ] || fail "the reveal answered no bearer"
(cd "$CORE/apps/api" && HOME="$WORK/cli-home" TSX_DISABLE_CACHE=1 node --import tsx --input-type=module -e "$(cat "$FIXTURES/collector-values.mjs")" "$STATE/facts.json" \
  <"$SECRETS_DIR/bearer" >"$SECRETS_DIR/collector-values.yaml" 2>"$LOGS/collector-values.err") ||
  fail "the contracts' builders failed: $(shown "$LOGS/collector-values.err" 5)"
grep -q '^role: "gateway"$' "$SECRETS_DIR/collector-values.yaml" || fail "the values aren't a gateway's"
holds_value "$SECRETS_DIR/collector-values.yaml" || fail "the values file holds no bearer"
helmk -n "$NS_COLLECTORS" upgrade --install "$GATEWAY_GROUP" "$COLLECTOR_CHART" -f "$SECRETS_DIR/collector-values.yaml" --wait --timeout 300s \
  >"$LOGS/collector-install.log" 2>&1 || fail "installing the collector failed: $(shown "$LOGS/collector-install.log" 8)"
collector_pod=$(kube -n "$NS_COLLECTORS" get pods -l "app=$GATEWAY_GROUP" -o jsonpath='{.items[0].metadata.name}' 2>>"$LOGS/kubectl.err" || true)
[ -n "$collector_pod" ] || fail "no pod labelled app=$GATEWAY_GROUP in $NS_COLLECTORS"
# wait_collector <polls> <jq condition>: the platform's collector list holds the pod's collector meeting it.
wait_collector() {
  local condition=$2
  collector=""
  for _ in $(seq 1 "$1"); do
    platform GET "$FLEET_URL/collectors?groupId=$GROUP_ID"
    if [ "$status" = 200 ]; then
      collector=$(jq -c --arg n "$collector_pod" --arg g "$GROUP_ID" --arg r "$ROTATE_TOKEN_ID" \
        "[.collectors[] | select(.name == \$n and .groupId == \$g and .enrollmentTokenId == \$r and ($condition))][0] // empty" "$REPLY_BODY" 2>/dev/null || true)
      [ -n "$collector" ] && return 0
    fi
    sleep 1
  done
  kube -n "$NS_COLLECTORS" logs "$collector_pod" --tail=30 >"$LOGS/collector-tail.log" 2>&1 || true
  fail "the collector $collector_pod didn't reach ($condition) within $1 polls: $(shown "$LOGS/collector-tail.log" 8)"
}
wait_collector 240 ".effective.status == \"applied\" and .served.version.versionId == \"$V1_ID\" and .effective.sha256 == .served.sha256"
V1_SHA=$(echo "$collector" | jq -r '.effective.sha256')
platform POST "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions" "$(body create-v2 '{sourceVersionId: $s, yamlContent: $y, nodes: [], edges: [], pipelines: []}' --arg s "$V1_ID" --arg y "$V2_YAML")"
[ "$status" = 201 ] && [ "$(reply_json '.version.versionNumber')" = 2 ] || fail "creating version 2 answered $status: $(reply_code)"
V2_ID=$(reply_json '.version.id')
platform POST "$CONFIGURATIONS_URL/$CONFIGURATION_ID/versions/$V2_ID/publish"
[ "$status" = 200 ] || fail "publishing version 2 answered $status: $(reply_code)"
platform PATCH "$FLEET_URL/groups/$GROUP_ID" "$(body group-v2 '{assignedVersionId: $v}' --arg v "$V2_ID")"
[ "$status" = 200 ] || fail "assigning version 2 to the group answered $status: $(reply_code)"
wait_collector 240 ".effective.status == \"applied\" and .served.version.versionId == \"$V2_ID\" and .effective.sha256 == .served.sha256 and .drift == \"inSync\""
V2_SHA=$(echo "$collector" | jq -r '.effective.sha256')
[ "$V1_SHA" != "$V2_SHA" ] || fail "version 2 applied the same bytes as version 1"
pass "the collector $collector_pod enrolled through $AGENT_URL on the rotate token, applied version 1, then followed version 2 (in sync)"

# =====================================================================================================================
step "the CLI's anonymous validate over loopback http ($GATEWAY_URL), refused: the chart's defaults turn anonymous validation off"
printf '%s' "$V1_YAML" >"$WORK/cli/valid.yaml"
cli() { # <name> <args...>: the CLI, anonymous: HOME and its config folder the run's (empty), no login variable
  local name=$1
  shift
  cli_code=0
  env -u XDG_CONFIG_HOME -u TELFLO_TOKEN -u TELFLO_ORG -u TELFLO_CONFIG_DIR HOME="$WORK/cli-home" TELFLO_CLI_CONFIG_DIR="$WORK/cli-config" \
    TELFLO_SERVER="$GATEWAY_URL" node "$CLI" "$@" </dev/null >"$WORK/cli/$name.out" 2>"$WORK/cli/$name.err" || cli_code=$?
}
SIGN_IN_TO_VALIDATE="This server doesn't validate without a login: run telflo login (or set TELFLO_TOKEN)."
cli plain validate "$WORK/cli/valid.yaml"
[ "$cli_code" = 3 ] && grep -qxF "error: $SIGN_IN_TO_VALIDATE" "$WORK/cli/plain.err" && [ ! -s "$WORK/cli/plain.out" ] ||
  fail "telflo validate without a login exited $cli_code, not 3 with the sign-in message: $(shown "$WORK/cli/plain.err" 3)"
cli json --json validate "$WORK/cli/valid.yaml"
[ "$cli_code" = 3 ] && [ "$(jq -r '.error.code' "$WORK/cli/json.err" 2>/dev/null)" = login_required ] &&
  [ "$(jq -r '.error.status' "$WORK/cli/json.err" 2>/dev/null)" = 404 ] ||
  fail "telflo --json validate without a login exited $cli_code, not 3 with login_required and 404: $(shown "$WORK/cli/json.err" 3)"
[ -z "$(ls -A "$WORK/cli-config")" ] || fail "the anonymous validate wrote into its config folder"
pass "telflo $(env HOME="$WORK/cli-home" TELFLO_CLI_CONFIG_DIR="$WORK/cli-config" node "$CLI" -V </dev/null 2>/dev/null) validate without a login: exit 3 with the sign-in message (--json: login_required, 404), no login written"

# =====================================================================================================================
step "a sign-in with a forged X-Forwarded-For: 203.0.113.7: its audit row holds 127.0.0.1"
rows_before=$(pg telflo_platform "select count(*) from audit_events where action = 'user.signed_in' and actor_user_id = '$USER_ID'") || fail "counting the sign-in audit rows failed"
status=$(curl -q -s -o "$REPLY_BODY" -w '%{http_code}' --max-time 30 -c "$SECRETS_DIR/forged-jar" -X POST "$GATEWAY_URL/api/v1/auth/sessions" \
  -H 'content-type: application/json' -H 'X-Telflo-CSRF: 1' -H 'X-Forwarded-For: 203.0.113.7' --data-binary "@$SECRETS_DIR/sign-in.json" || true)
[ "$status" = 200 ] || fail "the forged sign-in answered $status: $(reply_code)"
add_jar_values "$SECRETS_DIR/forged-jar" || fail "a secret under 16 characters can't be searched for: refused"
rows_after=$(pg telflo_platform "select count(*) from audit_events where action = 'user.signed_in' and actor_user_id = '$USER_ID'") || fail "counting the sign-in audit rows failed"
[ "$rows_after" = "$((rows_before + 1))" ] || fail "the forged sign-in wrote $((rows_after - rows_before)) audit rows, not 1"
forged_ip=$(pg telflo_platform "select coalesce(host(ip_address), 'none') from audit_events where action = 'user.signed_in' and actor_user_id = '$USER_ID' order by occurred_at desc limit 1") || fail "reading the forged sign-in's audit row failed"
[ "$forged_ip" = 127.0.0.1 ] || fail "the forged sign-in's audit row holds $forged_ip, not 127.0.0.1"
[ "$(pg telflo_platform "select count(*) from audit_events where ip_address = '203.0.113.7'::inet")" = 0 ] || fail "an audit row holds the forged 203.0.113.7"
pass "the audit row holds 127.0.0.1 (one trusted hop: the gateway's peer through the port-forward); no row holds 203.0.113.7"

# =====================================================================================================================
step "GET /__manifest with a double-encoded path and the build's version: the web pod logs no 'The URL path' line and no marker"
MANIFEST_VERSION=$(grep -oE 'manifest-[A-Za-z0-9]+\.js' "$STATE/login.html" | head -n1 | sed -E 's/^manifest-([A-Za-z0-9]+)\.js$/\1/' || true)
[ -n "$MANIFEST_VERSION" ] || fail "the /login page names no manifest-<version>.js"
status=$(curl -q -s -o "$STATE/manifest-control.out" -D "$STATE/manifest-control.headers" -w '%{http_code}' --max-time 10 \
  "$GATEWAY_URL/__manifest?paths=%2Flogin&version=$MANIFEST_VERSION" || true)
[ "$status" = 200 ] && ! grep -qi '^x-remix-reload-document' "$STATE/manifest-control.headers" ||
  fail "the control /__manifest?paths=/login&version=$MANIFEST_VERSION answered $status (a wrong version reloads): the check below wouldn't reach the decode"
MARKER="smk$(openssl rand -hex 6)"
web_pod=$(pod_of web) || fail "finding the web pod failed"
web_lines_before=$(kns logs "$web_pod" -c web 2>/dev/null | grep -c . || true)
status=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 10 \
  "$GATEWAY_URL/__manifest?paths=%2Fa-$MARKER%2F%25E0%25A4%25A&version=$MANIFEST_VERSION" || true)
[ "$status" = 200 ] || fail "the double-encoded /__manifest request answered $status, not 200: it didn't reach React Router's decode"
sleep 2
kns logs "$web_pod" -c web >"$LOGS/web-after-manifest.log" 2>&1 || fail "reading the web pod's log failed"
grep -q "The URL path" "$LOGS/web-after-manifest.log" && fail "the web pod's log holds a 'The URL path' line (the web server's filter for React Router's decode warning isn't installed)"
grep -qF "$MARKER" "$LOGS/web-after-manifest.log" && fail "the web pod's log holds the marker"
web_lines_after=$(grep -c . "$LOGS/web-after-manifest.log" || true)
pass "answered $status; the web pod's log gained $((web_lines_after - web_lines_before)) lines, none 'The URL path', no marker (version $MANIFEST_VERSION)"

# =====================================================================================================================
step "the collector uninstalled, then 60 s with no traffic add no log line in any of the release's pods"
# The collector's own logs first, for the secrets' search (its pod goes with the uninstall).
for container in $(kube -n "$NS_COLLECTORS" get pod "$collector_pod" -o jsonpath='{.spec.initContainers[*].name} {.spec.containers[*].name}' 2>>"$LOGS/kubectl.err"); do
  kube -n "$NS_COLLECTORS" logs "$collector_pod" -c "$container" >"$LOGS/pod-final-$NS_COLLECTORS-$collector_pod-$container.log" 2>&1 ||
    fail "saving the collector's $container log failed"
done
helmk -n "$NS_COLLECTORS" uninstall "$GATEWAY_GROUP" >"$LOGS/collector-uninstall.log" 2>&1 || fail "uninstalling the collector failed"
kube -n "$NS_COLLECTORS" wait --for=delete pod -l "app=$GATEWAY_GROUP" --timeout=120s >>"$LOGS/collector-uninstall.log" 2>&1 || true
sleep 10
pods_json >"$STATE/pods-quiet.json"
# Postgres's timed checkpoints (every checkpoint_timeout, 5 min, after any write; logged by default since
# Postgres 15) come on their own clock, not from traffic: their two lines aren't counted. Anything else is.
QUIET_IGNORED='^[0-9-]+ [0-9:.]+ UTC \[[0-9]+\] LOG:  checkpoint (starting|complete): '
line_counts() {
  local pod container
  for pod in $(jq -r '.items[].metadata.name' "$STATE/pods-quiet.json"); do
    for container in $(jq -r --arg p "$pod" '.items[] | select(.metadata.name == $p) | .spec.containers[].name' "$STATE/pods-quiet.json"); do
      echo "$pod/$container $(kns logs "$pod" -c "$container" 2>/dev/null | grep -cvE "$QUIET_IGNORED")"
    done
  done
}
# Every probe runs at least twice in the window: the longest readiness or liveness period (Kubernetes' default 10)
# is at most 30 s.
longest=$(jq '[.items[].spec.containers[] | (.readinessProbe, .livenessProbe) | select(. != null) | (.periodSeconds // 10)] | max // 0' \
  "$STATE/pods-quiet.json") || fail "reading the probes' periods failed"
[ "$longest" -le 30 ] || fail "a probe's period is $longest s: the 60 s window wouldn't see it run twice"
line_counts | sort >"$STATE/lines-before.txt" || fail "counting the log lines failed"
sleep 60
line_counts | sort >"$STATE/lines-after.txt" || fail "counting the log lines failed"
# A container in only one of the two lists (a restart, a new pod) shows as MISSING and fails too.
grown=$(join -a1 -a2 -e MISSING -o 0,1.2,2.2 "$STATE/lines-before.txt" "$STATE/lines-after.txt" | awk '$3 != $2 { print $1 " " $2 "->" $3 }')
if [ -n "$grown" ]; then
  for entry in $(echo "$grown" | awk '{ print $1 }'); do
    kns logs "${entry%%/*}" -c "${entry##*/}" --tail=5 2>/dev/null | redact | sed "s#^#       $entry | #" >&2 || true
  done
  fail "log lines were added in 60 s without traffic: $(echo $grown)"
fi
pass "$(grep -c . "$STATE/lines-before.txt") containers, no line added in 60 s but Postgres's timed checkpoints (the kubelet's probes ran: the API's /health, web's /favicon.ico, the validator's and tester's health, TCP elsewhere)"

# =====================================================================================================================
step "every pod's log, the rendered manifests and Helm's release record searched for the secrets"
collect_logs final
logs_collected=yes
helmk -n "$NS" get manifest "$RELEASE" >"$STATE/release-manifest.yaml" 2>>"$LOGS/kubectl.err" || fail "helm get manifest failed"
helmk -n "$NS" get values --all "$RELEASE" >"$STATE/release-values.yaml" 2>>"$LOGS/kubectl.err" || fail "helm get values failed"
record=$(kns get secret -l "owner=helm,name=$RELEASE" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>>"$LOGS/kubectl.err" | sort | tail -n1) || fail "listing Helm's release records failed"
[ -n "$record" ] || fail "no Helm release record for $RELEASE"
kns get secret "$record" -o jsonpath='{.data.release}' | base64 -d | base64 -d | gzip -dc >"$STATE/release-record.json" 2>>"$LOGS/kubectl.err" ||
  fail "decoding Helm's release record failed"
[ -s "$STATE/release-record.json" ] || fail "Helm's release record decoded empty"
add_jar_values "$JAR" || fail "a secret under 16 characters can't be searched for: refused"
add_jar_values "$SECRETS_DIR/forged-jar" || fail "a secret under 16 characters can't be searched for: refused"
named=0
searched=0
for file in "$LOGS"/pod-final-*.log "$STATE/release-manifest.yaml" "$STATE/release-values.yaml" "$STATE/release-record.json" "$OUTPUT_LOG"; do
  [ -f "$file" ] || continue
  searched=$((searched + 1))
  if holds_value "$file"; then echo "     $file holds a secret (not shown)" >&2; named=$((named + 1)); fi
done
[ "$named" = 0 ] || fail "$named files hold a secret"
pass "$searched files (every container's log, Helm's manifest, values and release record, the output so far) hold none of the $(secrets_count) secrets (each also in its base64 and base64url forms)"

# =====================================================================================================================
step "helm uninstall: both PVCs kept by policy, then deleted explicitly"
helmk -n "$NS" uninstall "$RELEASE" >"$LOGS/helm-uninstall.log" 2>&1 || fail "helm uninstall failed: $(shown "$LOGS/helm-uninstall.log" 5)"
deadline=$((SECONDS + 300))
until [ -z "$(kns get pods -l "app.kubernetes.io/instance=$RELEASE" -o name 2>>"$LOGS/kubectl.err")" ]; do
  [ "$SECONDS" -lt "$deadline" ] || fail "the release's pods weren't gone within 300 s"
  sleep 3
done
kept=$(kns get pvc -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>>"$LOGS/kubectl.err" | sort | tr '\n' ' ') || fail "listing the PVCs failed"
[ "$kept" = "data-telflo-postgres-0 telflo-api-file-store " ] || fail "after the uninstall the PVCs are '$kept', not Postgres's and the file store's"
kns delete pvc data-telflo-postgres-0 telflo-api-file-store --wait=true --timeout=180s >>"$LOGS/helm-uninstall.log" 2>&1 || fail "deleting the PVCs failed"
[ -z "$(kns get pvc -o name 2>/dev/null)" ] || fail "PVCs are left in $NS"
pass "uninstalled; data-telflo-postgres-0 and telflo-api-file-store were kept, then deleted"

if [ "$KEEP" = yes ]; then
  step "--keep: the chart installed again on fresh volumes, for the walkthrough"
  run_watched "helm install (the walkthrough's)" "$LOGS/helm-install-keep.log" \
    helmk -n "$NS" install "$RELEASE" "$CHART" -f "$VALUES_FILE" --wait --timeout "${WAIT_TIMEOUT}s"
  wait_every_pod_ready 300
  pass "installed again; every pod Ready"
fi
exit 0
