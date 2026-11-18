#!/usr/bin/env bash
# pull-back.sh: what the registry serves is what was tested (D36-2 decision
# 81; Preflight ruling 6), after --push-oci and --push-package and before the
# GitHub Release.
#
#   scripts/release/pull-back.sh --oci <dir> --version <v> (--chart <tgz> | --no-chart)
#                                [--image <name>]... [--registry <r>] [--no-attest]
#
# For each image (api, web, otelcol-validator, otelcol-testing and
# ottl-evaluator by default, or those --image names; `collector` reads
# <dir>/collector-<v>.digest), with <ref> = <registry>/telflo/telflo/<name>:<v>:
#   - `crane digest <ref>` answers the archive's index digest (its digest file);
#   - `crane manifest <ref>` is an image index holding a linux/amd64 and a
#     linux/arm64 image and, unless --no-attest (a rehearsal's builds only),
#     an attestation manifest naming each;
#   - `docker pull` of the amd64 image by its manifest digest succeeds, and
#     the engine's image id is that manifest's config digest (its manifest
#     digest on an engine using containerd's image store; the pulled
#     reference is untagged afterwards).
# Then the chart: `helm pull oci://<registry>/telflo/telflo/charts/<name>
# --version <v>` (--plain-http for a loopback registry) answers a file whose
# sha256 is the packaged .tgz's (<name> and <v> are the .tgz's own Chart.yaml's,
# its version <v>). --no-chart skips it (the collector workflow's images).
# --registry is ghcr.io (the default) or a loopback 127.0.0.1:<port> or
# localhost:<port>.
#
# Exit 0 everything equal; 1 at the first difference, naming it; 2 usage.
# crane and docker read the caller's DOCKER_CONFIG once checked, helm the
# caller's HELM_REGISTRY_CONFIG once checked, else temporary ones holding no
# login (no credential helper is ever consulted); it never logs in. Helm's
# homes are temporary. bash 3.2 compatible.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." >/dev/null && pwd)"
# shellcheck source=scripts/release/version.sh
. "$ROOT/scripts/release/version.sh"
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"

PLATFORM_IMAGES=(api web otelcol-validator otelcol-testing ottl-evaluator)
DIGEST_RE='^sha256:[0-9a-f]{64}$'

usage() {
  cat >&2 <<'EOF'
usage: scripts/release/pull-back.sh --oci <dir> --version <v> (--chart <tgz> | --no-chart)
                                    [--image <name>]... [--registry <r>] [--no-attest]
images: api web otelcol-validator otelcol-testing ottl-evaluator collector
registry: ghcr.io (the default), 127.0.0.1:<port> or localhost:<port>
EOF
}
fail() { echo "pull-back: $1" >&2; exit 1; }
differs() { echo "pull-back: DIFFERENT: $1" >&2; exit 1; }
refuse_usage() { echo "pull-back: $1" >&2; usage; exit 2; }
note() { echo "pull-back: $1" >&2; }

oci_dir=""
version=""
chart_file=""
no_chart=false
registry="ghcr.io"
attest=true
selected=()
add_image() {
  case "$1" in
    api | web | otelcol-validator | otelcol-testing | ottl-evaluator | collector) ;;
    *) refuse_usage "unknown image '$1'" ;;
  esac
  local seen
  for seen in ${selected[@]+"${selected[@]}"}; do [ "$seen" != "$1" ] || return 0; done
  selected+=("$1")
}
while [ $# -gt 0 ]; do
  case "$1" in
    --oci) [ $# -ge 2 ] || refuse_usage "--oci needs a folder"; oci_dir="$2"; shift 2 ;;
    --version) [ $# -ge 2 ] || refuse_usage "--version needs a value"; version="$2"; shift 2 ;;
    --chart) [ $# -ge 2 ] || refuse_usage "--chart needs a package"; chart_file="$2"; shift 2 ;;
    --no-chart) no_chart=true; shift ;;
    --image) [ $# -ge 2 ] || refuse_usage "--image needs a value"; add_image "$2"; shift 2 ;;
    --registry) [ $# -ge 2 ] || refuse_usage "--registry needs a value"; registry="$2"; shift 2 ;;
    --no-attest) attest=false; shift ;;
    -h | --help) usage; exit 0 ;;
    *) refuse_usage "unknown argument: $1" ;;
  esac
done
[ -n "$oci_dir" ] && [ -d "$oci_dir" ] || refuse_usage "--oci <dir> must be an existing directory (got '$oci_dir')"
telflo_version_ok "$version" || refuse_usage "--version must be x.y.z (got '$version')"
telflo_registry_ok "$registry" \
  || refuse_usage "--registry must be ghcr.io or a loopback registry, 127.0.0.1:<port> or localhost:<port> (got '$registry')"
if $no_chart; then
  [ -z "$chart_file" ] || refuse_usage "--chart or --no-chart, not both"
else
  [ -n "$chart_file" ] && [ -f "$chart_file" ] || refuse_usage "--chart <tgz> (an existing file) or --no-chart is required"
fi
[ "${#selected[@]}" -gt 0 ] || selected=("${PLATFORM_IMAGES[@]}")

base_of() { if [ "$1" = collector ]; then printf 'collector-%s\n' "$version"; else printf '%s\n' "$1"; fi; }
for image in "${selected[@]}"; do
  f="$oci_dir/$(base_of "$image").digest"
  [ -f "$f" ] && [ "$(grep -c '' "$f")" -eq 1 ] && [[ "$(cat "$f")" =~ $DIGEST_RE ]] \
    || fail "$f is missing or isn't one line sha256:<64 hex>"
done

tmp="$(mktemp -d "${TMPDIR:-/tmp}/pull-back.XXXXXX")" || fail "no temporary directory"
[ -n "$tmp" ] && [ -d "$tmp" ] || fail "no temporary directory"
trap 'rm -rf "$tmp"' EXIT
TELFLO_OCI_PREFIX=pull-back
TELFLO_OCI_TMP="$tmp"
telflo_docker_config || exit 1
telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"
command -v docker >/dev/null 2>&1 || fail "docker is not on PATH"
store="$(telflo_engine_store)"

# The index's facts: `<arch> <manifest digest>` per image, `attests <digest>`
# per attestation manifest naming one.
index_facts() { # <manifest file>
  python3 -I - "$1" <<'PY'
import json, sys
index = json.load(open(sys.argv[1], encoding="utf-8"))
if index.get("mediaType") not in ("application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"):
    sys.exit(1)
for entry in index.get("manifests") or []:
    platform = entry.get("platform") or {}
    annotations = entry.get("annotations") or {}
    if annotations.get("vnd.docker.reference.type") == "attestation-manifest":
        print("attests %s" % annotations.get("vnd.docker.reference.digest"))
    elif platform.get("os") == "linux" and platform.get("architecture") in ("amd64", "arm64"):
        print("%s %s" % (platform["architecture"], entry.get("digest")))
PY
}
config_of() { # <manifest file>
  python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["config"]["digest"])' "$1"
}

for image in "${selected[@]}"; do
  want="$(cat "$oci_dir/$(base_of "$image").digest")"
  ref="$registry/telflo/telflo/$image"
  status=0
  telflo_remote_digest "$ref:$version" || status=$?
  remote="$TELFLO_REMOTE_DIGEST"
  [ "$status" -eq 0 ] || differs "$ref:$version can't be read ($TELFLO_REMOTE_ANSWER)"
  [ "$remote" = "$want" ] || differs "$ref:$version is $remote, not the archive's $want"
  status=0
  telflo_remote_manifest "$ref@$want" "$tmp/index.json" || status=$?
  [ "$status" -eq 0 ] || differs "$ref@$want's manifest can't be read ($TELFLO_REMOTE_ANSWER)"
  facts="$(index_facts "$tmp/index.json")" || differs "$ref:$version isn't an image index"
  for arch in amd64 arm64; do
    [ "$(printf '%s\n' "$facts" | awk -v a="$arch" '$1 == a' | grep -c '')" -eq 1 ] \
      || differs "$ref:$version hasn't exactly one linux/$arch image"
    if $attest; then
      digest="$(printf '%s\n' "$facts" | awk -v a="$arch" '$1 == a { print $2 }')"
      printf '%s\n' "$facts" | grep -qxF "attests $digest" \
        || differs "$ref:$version's linux/$arch image has no attestation manifest"
    fi
  done
  amd64="$(printf '%s\n' "$facts" | awk '$1 == "amd64" { print $2 }')"
  status=0
  telflo_remote_manifest "$ref@$amd64" "$tmp/amd64.json" || status=$?
  [ "$status" -eq 0 ] || differs "$ref@$amd64 can't be read ($TELFLO_REMOTE_ANSWER)"
  config="$(config_of "$tmp/amd64.json")" || differs "$ref@$amd64 has no config"
  docker pull -q "$ref@$amd64" >/dev/null || differs "docker pull $ref@$amd64 failed"
  id="$(docker image inspect --format '{{.Id}}' "$ref@$amd64" 2>/dev/null)" || id=""
  docker rmi "$ref@$amd64" >/dev/null 2>&1 || note "couldn't untag $ref@$amd64"
  # The config digest in the classic store, the manifest digest in containerd's.
  expected="$config"
  [ "$store" = containerd ] && expected="$amd64"
  [ "$id" = "$expected" ] || differs "the pulled $ref@$amd64 is image ${id:-none}, not $expected ($store image store)"
  note "$ref:$version is $want (linux/amd64, linux/arm64$($attest && echo ', attested'); the amd64 image pulled)"
done

if ! $no_chart; then
  members="$(tar -tzf "$chart_file" 2>/dev/null)" || fail "$chart_file isn't a readable .tgz"
  chart_name="$(printf '%s\n' "$members" | sed 's#/.*##' | sort -u)"
  [[ "$chart_name" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || fail "$chart_file must hold one top-level folder, its chart"
  chart_version="$(tar -xzOf "$chart_file" "$chart_name/Chart.yaml" 2>/dev/null \
    | sed -n 's/^version:[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}[[:space:]]*$/\1/p')"
  [ "$chart_version" = "$version" ] || fail "$chart_file is version '$chart_version', not $version"
  command -v helm >/dev/null 2>&1 || fail "helm is not on PATH"
  caller_registry_config="${HELM_REGISTRY_CONFIG:-}"
  for v in $(env | sed -n 's/^\(HELM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
  mkdir -p "$tmp/helm/cache" "$tmp/helm/config" "$tmp/helm/data" "$tmp/pulled"
  export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"
  if [ -n "$caller_registry_config" ]; then
    telflo_credentials HELM_REGISTRY_CONFIG "$caller_registry_config" || exit 1
    export HELM_REGISTRY_CONFIG="$caller_registry_config"
  else
    (umask 077 && printf '%s\n' '{"auths":{"telflo-release.invalid":{}}}' >"$tmp/registry.json")
    export HELM_REGISTRY_CONFIG="$tmp/registry.json"
  fi
  flags=()
  if telflo_registry_loopback "$registry"; then flags=(--plain-http); fi
  chart_ref="oci://$registry/telflo/telflo/charts/$chart_name"
  helm pull ${flags[@]+"${flags[@]}"} "$chart_ref" --version "$version" --destination "$tmp/pulled" >/dev/null 2>"$tmp/helm.err" \
    || { tail -n 1 "$tmp/helm.err" >&2; differs "helm pull $chart_ref --version $version failed"; }
  pulled="$tmp/pulled/$chart_name-$version.tgz"
  [ -f "$pulled" ] || differs "helm pull made no $chart_name-$version.tgz"
  sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi; }
  [ "$(sum "$pulled")" = "$(sum "$chart_file")" ] \
    || differs "$chart_ref $version's sha256 is $(sum "$pulled"), not the package's $(sum "$chart_file")"
  note "$chart_ref $version is the package (sha256 $(sum "$chart_file"))"
fi
note "pulled back: everything is what was tested"
