#!/usr/bin/env bash
# verify-collector-artifacts.sh: the collector images and the
# supervisor-collector chart a release points at exist, in the release's
# `version` job, so a release fails in seconds.
#
#   scripts/release/verify-collector-artifacts.sh [--registry <r>]
#
# For every collector version the catalogue offers
# (scripts/build-collector-image.sh --list-offered: not deprecated, every
# value checked), <registry>/telflo/telflo/collector:<v> must be an image
# index holding a linux/amd64 and a linux/arm64 image; and
# <registry>/telflo/telflo/charts/supervisor-collector must hold the
# contracts' DEFAULT_HELM_CHART_VERSION (telflo-core/packages/contracts/src/
# helm.ts, read by its exact line) as a Helm chart. Each is read with `crane
# manifest`: MANIFEST_UNKNOWN or NAME_UNKNOWN is missing ("run the collector
# workflow for <version>"); any other answer can't tell
# (a private package read without its login answers so). Every artefact is
# asked, then every problem named.
#
# --registry is ghcr.io (the default) or a loopback 127.0.0.1:<port> or
# localhost:<port> (the rehearsal's). Exit 0 all present; 1 any missing or
# can't tell; 2 usage. crane reads the caller's DOCKER_CONFIG once checked,
# else a temporary one holding no login; it never logs in. crane:
# scripts/release/tools.sh's, else PATH. bash 3.2 compatible.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." >/dev/null && pwd)"
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"
CONTRACTS="$ROOT/telflo-core/packages/contracts/src/helm.ts"
CHART_REFERENCE="oci://ghcr.io/telflo/telflo/charts/supervisor-collector"

usage() { echo "usage: scripts/release/verify-collector-artifacts.sh [--registry ghcr.io|127.0.0.1:<port>|localhost:<port>]" >&2; }
fail() { echo "verify-collector-artifacts: $1" >&2; exit 1; }
refuse_usage() { echo "verify-collector-artifacts: $1" >&2; usage; exit 2; }
note() { echo "verify-collector-artifacts: $1" >&2; }

registry="ghcr.io"
while [ $# -gt 0 ]; do
  case "$1" in
    --registry) [ $# -ge 2 ] || refuse_usage "--registry needs a value"; registry="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) refuse_usage "unknown argument: $1" ;;
  esac
done
telflo_registry_ok "$registry" \
  || refuse_usage "--registry must be ghcr.io or a loopback registry, 127.0.0.1:<port> or localhost:<port> (got '$registry')"

# The contracts' chart: its reference must be the release's, its version one line.
one_line() { # <sed expression> <what>
  local found
  found="$(sed -n "$1" "$CONTRACTS")"
  [ "$(printf '%s' "$found" | grep -c '')" -eq 1 ] || fail "$2: expected exactly one line in $CONTRACTS"
  printf '%s\n' "$found"
}
default_reference="$(one_line 's/^export const DEFAULT_HELM_CHART_REFERENCE = "\([^"]*\)";$/\1/p' "the contracts' DEFAULT_HELM_CHART_REFERENCE")"
chart_version="$(one_line 's/^export const DEFAULT_HELM_CHART_VERSION = "\([^"]*\)";$/\1/p' "the contracts' DEFAULT_HELM_CHART_VERSION")"
[ "$default_reference" = "$CHART_REFERENCE" ] \
  || fail "the contracts' DEFAULT_HELM_CHART_REFERENCE is '$default_reference', not $CHART_REFERENCE"
[[ "$chart_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "the contracts' DEFAULT_HELM_CHART_VERSION isn't x.y.z"

offered="$("${BASH:-bash}" "$ROOT/scripts/build-collector-image.sh" --list-offered)" \
  || fail "the catalogue's offered versions couldn't be read"
[ -n "$offered" ] || fail "the catalogue offers no version"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-collector-artifacts.XXXXXX")" || fail "no temporary directory"
[ -n "$tmp" ] && [ -d "$tmp" ] || fail "no temporary directory"
trap 'rm -rf "$tmp"' EXIT
TELFLO_OCI_PREFIX=verify-collector-artifacts
TELFLO_OCI_TMP="$tmp"
telflo_docker_config || exit 1
telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"

# platforms_of <manifest file>: the image index's linux platforms, one a line.
platforms_of() {
  python3 -I - "$1" <<'PY'
import json, sys
index = json.load(open(sys.argv[1], encoding="utf-8"))
if index.get("mediaType") not in ("application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"):
    sys.exit(1)
for entry in index.get("manifests") or []:
    platform = entry.get("platform") or {}
    if platform.get("os") == "linux":
        print(platform.get("architecture"))
PY
}
is_chart() { # <manifest file>
  python3 -I - "$1" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
ok = (manifest.get("config") or {}).get("mediaType") == "application/vnd.cncf.helm.config.v1+json" and any(
    (layer or {}).get("mediaType") == "application/vnd.cncf.helm.chart.content.v1.tar+gzip" for layer in manifest.get("layers") or [])
sys.exit(0 if ok else 1)
PY
}

problems=0
problem() { echo "verify-collector-artifacts: $1" >&2; problems=$((problems + 1)); }
while IFS= read -r v; do
  [ -n "$v" ] || continue
  ref="$registry/telflo/telflo/collector:$v"
  status=0
  telflo_remote_manifest "$ref" "$tmp/manifest.json" || status=$?
  case "$status" in
    0)
      platforms="$(platforms_of "$tmp/manifest.json")" || { problem "$ref isn't an image index: run the collector workflow for $v"; continue; }
      missing=""
      for arch in amd64 arm64; do printf '%s\n' "$platforms" | grep -qx "$arch" || missing="$missing linux/$arch"; done
      if [ -n "$missing" ]; then problem "$ref lacks$missing: run the collector workflow for $v"; else note "$ref: linux/amd64 and linux/arm64"; fi ;;
    3) problem "$ref is missing: run the collector workflow for $v" ;;
    *) problem "can't tell whether $ref exists: $TELFLO_REMOTE_ANSWER" ;;
  esac
done <<<"$offered"

chart_ref="$registry/telflo/telflo/charts/supervisor-collector:$chart_version"
status=0
telflo_remote_manifest "$chart_ref" "$tmp/chart.json" || status=$?
case "$status" in
  0) if is_chart "$tmp/chart.json"; then note "oci://$chart_ref: a Helm chart"; else problem "oci://$chart_ref isn't a Helm chart: run the collector workflow for supervisor-collector $chart_version"; fi ;;
  3) problem "oci://$chart_ref is missing: run the collector workflow for supervisor-collector $chart_version" ;;
  *) problem "can't tell whether oci://$chart_ref exists: $TELFLO_REMOTE_ANSWER" ;;
esac

[ "$problems" -eq 0 ] || fail "$problems collector artefact(s) missing or unreadable"
note "every offered collector version ($(printf '%s' "$offered" | tr '\n' ' ')) and supervisor-collector $chart_version are there"
