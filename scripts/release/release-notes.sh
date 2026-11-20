#!/usr/bin/env bash
# release-notes.sh: the GitHub Release's notes, Markdown on stdout, the same
# bytes for the same inputs.
#
#   scripts/release/release-notes.sh --oci <dir> --chart <tgz> --version <v>
#
# They name each platform image's reference and image index digest (the
# archives' digest files, <dir>/<name>.digest), the chart's reference, version
# and package sha256 (the .tgz, whose own Chart.yaml must be the chart telflo
# at <v>), the collector versions and the supervisor-collector chart version
# the release was checked against (the catalogue's offered versions and the
# contracts' DEFAULT_HELM_CHART_VERSION), and links to the Quick start,
# docs/kubernetes.md and docs/compose.md at the tag. No date, nothing read
# from the network. Exit 0 written; 1 an input missing or wrong; 2 usage.
# bash 3.2 compatible.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." >/dev/null && pwd)"
# shellcheck source=scripts/release/version.sh
. "$ROOT/scripts/release/version.sh"
CONTRACTS="$ROOT/telflo-core/packages/contracts/src/helm.ts"
IMAGES=(api web otelcol-validator otelcol-testing ottl-evaluator)
DIGEST_RE='^sha256:[0-9a-f]{64}$'
REPOSITORY_URL="https://github.com/telflo/telflo"

usage() { echo "usage: scripts/release/release-notes.sh --oci <dir> --chart <tgz> --version <v>" >&2; }
fail() { echo "release-notes: $1" >&2; exit 1; }
refuse_usage() { echo "release-notes: $1" >&2; usage; exit 2; }

oci_dir=""
chart_file=""
version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --oci) [ $# -ge 2 ] || refuse_usage "--oci needs a folder"; oci_dir="$2"; shift 2 ;;
    --chart) [ $# -ge 2 ] || refuse_usage "--chart needs a package"; chart_file="$2"; shift 2 ;;
    --version) [ $# -ge 2 ] || refuse_usage "--version needs a value"; version="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) refuse_usage "unknown argument: $1" ;;
  esac
done
[ -n "$oci_dir" ] && [ -d "$oci_dir" ] || refuse_usage "--oci <dir> must be an existing directory (got '$oci_dir')"
[ -n "$chart_file" ] && [ -f "$chart_file" ] || refuse_usage "--chart <tgz> must be an existing file (got '$chart_file')"
telflo_version_ok "$version" || refuse_usage "--version must be x.y.z (got '$version')"

digests=()
for image in "${IMAGES[@]}"; do
  f="$oci_dir/$image.digest"
  [ -f "$f" ] && [ "$(grep -c '' "$f")" -eq 1 ] && [[ "$(cat "$f")" =~ $DIGEST_RE ]] \
    || fail "$f is missing or isn't one line sha256:<64 hex>"
  digests+=("$(cat "$f")")
done

members="$(tar -tzf "$chart_file" 2>/dev/null)" || fail "$chart_file isn't a readable .tgz"
[ "$(printf '%s\n' "$members" | sed 's#/.*##' | sort -u)" = telflo ] || fail "$chart_file isn't the chart telflo"
chart_yaml="$(tar -xzOf "$chart_file" telflo/Chart.yaml 2>/dev/null)" || fail "$chart_file has no telflo/Chart.yaml"
for key in version appVersion; do
  value="$(printf '%s\n' "$chart_yaml" | sed -n "s/^$key:[[:space:]]*\"\{0,1\}\([^\"[:space:]]*\)\"\{0,1\}[[:space:]]*\$/\1/p")"
  [ "$value" = "$version" ] || fail "$chart_file's $key is '$value', not $version"
done
if command -v sha256sum >/dev/null 2>&1; then chart_sum="$(sha256sum "$chart_file" | awk '{ print $1 }')"
else chart_sum="$(shasum -a 256 "$chart_file" | awk '{ print $1 }')"; fi

offered="$("${BASH:-bash}" "$ROOT/scripts/build-collector-image.sh" --list-offered)" || fail "the catalogue's offered versions couldn't be read"
supervisor_version="$(sed -n 's/^export const DEFAULT_HELM_CHART_VERSION = "\([^"]*\)";$/\1/p' "$CONTRACTS")"
[ "$(printf '%s' "$supervisor_version" | grep -c '')" -eq 1 ] && telflo_version_ok "$supervisor_version" \
  || fail "the contracts' DEFAULT_HELM_CHART_VERSION isn't one x.y.z line"

tag="v$version"
printf '# Telflo %s\n\n' "$tag"
printf '## Images\n\n'
printf 'Each image is published for linux/amd64 and linux/arm64, with SBOM and provenance attestations, and is the image the release'"'"'s tests ran.\n\n'
printf '| Image | Index digest |\n|---|---|\n'
i=0
for image in "${IMAGES[@]}"; do
  printf '| `ghcr.io/telflo/telflo/%s:%s` | `%s` |\n' "$image" "$version" "${digests[$i]}"
  i=$((i + 1))
done
printf '\n## Helm chart\n\n'
printf '`oci://ghcr.io/telflo/telflo/charts/telflo`, version `%s` (package sha256 `%s`):\n\n' "$version" "$chart_sum"
printf '```sh\nhelm install telflo oci://ghcr.io/telflo/telflo/charts/telflo --version %s\n```\n' "$version"
printf '\n## Collectors\n\n'
printf 'Checked against the collector images `ghcr.io/telflo/telflo/collector` at %s and the chart `oci://ghcr.io/telflo/telflo/charts/supervisor-collector` %s.\n' \
  "$(printf '%s\n' "$offered" | sed 's/.*/`&`/' | paste -sd, - | sed 's/,/, /g')" "$supervisor_version"
printf '\n## Install\n\n'
printf -- '- [Quick start](%s/blob/%s/README.md#quick-start): Docker Compose on one machine, from `telflo-compose-%s.tar.gz` below\n' "$REPOSITORY_URL" "$tag" "$version"
printf -- '- [Kubernetes](%s/blob/%s/docs/kubernetes.md): the Helm chart, with `create-secrets.sh` below\n' "$REPOSITORY_URL" "$tag"
printf -- '- [Docker Compose](%s/blob/%s/docs/compose.md): a real mail relay, upgrades and backups\n' "$REPOSITORY_URL" "$tag"
printf '\n`SHA256SUMS` covers the release'"'"'s files.\n'
