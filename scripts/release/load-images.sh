#!/usr/bin/env bash
# load-images.sh: each OCI archive's image for one platform into the Docker
# engine, under its release name, for the smokes (D36-2 decisions 71 and 77;
# Preflight ruling 6; Ruling 400).
#
#   scripts/release/load-images.sh --oci <dir> --version <v> [--image <name>]... [--platform linux/amd64|linux/arm64]
#
# The platform: --platform's, else the engine's own (`docker info`'s
# Architecture: x86_64 or amd64 is linux/amd64, aarch64 or arm64 is
# linux/arm64; any other is refused, exit 2), so the smokes run natively: the
# workflows name linux/amd64 (the runner's), a rehearsal on an Apple-silicon
# Mac loads linux/arm64.
#
# The images: api, web, otelcol-validator, otelcol-testing and ottl-evaluator
# by default (their archives <dir>/<name>.oci.tar and <dir>/<name>.digest,
# publish-platform-images.sh --build-oci's), or those --image names (each
# once); `collector` names <dir>/collector-<v>.oci.tar (build-collector-
# image.sh --build-oci's). Each becomes ghcr.io/telflo/telflo/<name>:<v>.
#
# Engine 20.10 can't `docker load` an OCI archive, so, one image at a time:
# the archive is checked (index.json's one entry is its digest file's,
# linux/amd64 and linux/arm64 there, their version label <v>), its layout
# unpacked into a temporary folder (every blob's sha256 checked), pushed with
# crane to a throwaway registry:2 on 127.0.0.1 (the image tools.lock pins,
# never pulled here: scripts/release/tools.sh pull registry), its digest
# there compared, the platform's image pulled by its manifest digest, tagged
# ghcr.io/telflo/telflo/<name>:<v>, and the engine's image id compared with
# the archive's config digest for that platform (its manifest digest on an
# engine using containerd's image store; a difference fails the run); the
# pulled reference is untagged and the layout deleted. The registry
# container (TELFLO_LOAD_IMAGES_NAME, else telflo-load-images-<pid>-<random>)
# publishes a fixed free port of 127.0.0.1 (TELFLO_LOAD_IMAGES_PORT, else one
# the system hands out: Docker Desktop's engine can't reach an ephemeral
# published port) and is removed at the end, whatever happened.
#
# Exit 0 every image loaded; 1 a check or step failed (named); 2 usage.
# Docker and crane run with the caller's DOCKER_CONFIG once checked, else a
# temporary one holding no login (no credential helper is ever consulted);
# it never logs in. crane: scripts/release/tools.sh's, else PATH.
# bash 3.2 compatible.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." >/dev/null && pwd)"
# shellcheck source=scripts/release/version.sh
. "$ROOT/scripts/release/version.sh"
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"

PLATFORM_IMAGES=(api web otelcol-validator otelcol-testing ottl-evaluator)
RELEASE_BASE="ghcr.io/telflo/telflo"
DIGEST_RE='^sha256:[0-9a-f]{64}$'

usage() {
  sed -n 's/^#   scripts\/release\/load-images\.sh /usage: scripts\/release\/load-images.sh /p' "$0" >&2
  echo "images: ${PLATFORM_IMAGES[*]} collector" >&2
}
fail() { echo "load-images: $1" >&2; exit 1; }
refuse_usage() { echo "load-images: $1" >&2; usage; exit 2; }
note() { echo "load-images: $1" >&2; }

oci_dir=""
version=""
platform=""
platform_given=false
selected=()
add_image() {
  case "$1" in
    api | web | otelcol-validator | otelcol-testing | ottl-evaluator | collector) ;;
    *) refuse_usage "unknown image '$1' (the images: ${PLATFORM_IMAGES[*]} collector)" ;;
  esac
  local seen
  for seen in ${selected[@]+"${selected[@]}"}; do [ "$seen" != "$1" ] || return 0; done
  selected+=("$1")
}
while [ $# -gt 0 ]; do
  case "$1" in
    --oci) [ $# -ge 2 ] || refuse_usage "--oci needs a folder"; oci_dir="$2"; shift 2 ;;
    --version) [ $# -ge 2 ] || refuse_usage "--version needs a value"; version="$2"; shift 2 ;;
    --image) [ $# -ge 2 ] || refuse_usage "--image needs a value"; add_image "$2"; shift 2 ;;
    --platform) [ $# -ge 2 ] || refuse_usage "--platform needs a value"; platform="$2"; platform_given=true; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) refuse_usage "unknown argument: $1" ;;
  esac
done
[ -n "$oci_dir" ] && [ -d "$oci_dir" ] || refuse_usage "--oci <dir> must be an existing directory (got '$oci_dir')"
telflo_version_ok "$version" || refuse_usage "--version must be x.y.z (got '$version')"
case "$platform_given:$platform" in
  false: | true:linux/amd64 | true:linux/arm64) ;;
  *) refuse_usage "--platform must be linux/amd64 or linux/arm64" ;;
esac
[ "${#selected[@]}" -gt 0 ] || selected=("${PLATFORM_IMAGES[@]}")
oci_dir="$(CDPATH='' cd -- "$oci_dir" >/dev/null && pwd)"

base_of() { if [ "$1" = collector ]; then printf 'collector-%s\n' "$version"; else printf '%s\n' "$1"; fi; }

# Every archive and digest file there before anything starts.
for image in "${selected[@]}"; do
  base="$(base_of "$image")"
  [ -f "$oci_dir/$base.oci.tar" ] || fail "$oci_dir/$base.oci.tar is missing"
  [ -f "$oci_dir/$base.digest" ] || fail "$oci_dir/$base.digest is missing"
  [ "$(grep -c '' "$oci_dir/$base.digest")" -eq 1 ] && [[ "$(cat "$oci_dir/$base.digest")" =~ $DIGEST_RE ]] \
    || fail "$oci_dir/$base.digest isn't one line sha256:<64 hex>"
done

command -v docker >/dev/null 2>&1 || fail "docker is not on PATH"
if [ -z "$platform" ]; then
  engine_arch="$(docker info --format '{{.Architecture}}' 2>/dev/null)" || fail "the engine's architecture couldn't be read (docker info): is Docker running?"
  case "$engine_arch" in
    x86_64 | amd64) platform=linux/amd64 ;;
    aarch64 | arm64) platform=linux/arm64 ;;
    *) echo "load-images: refused: the engine's architecture '$(printf '%s' "$engine_arch" | tr -cd 'A-Za-z0-9_.-' | cut -c1-32)' is neither amd64 nor arm64: name --platform" >&2
       exit 2 ;;
  esac
  note "the engine's own platform: $platform"
fi
arch="${platform#linux/}"
telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"
registry_image="$("${BASH:-bash}" "$ROOT/scripts/release/tools.sh" ref registry)" || fail "scripts/release/tools.lock names no registry image"

container="${TELFLO_LOAD_IMAGES_NAME:-telflo-load-images-$$-$(od -An -N4 -tx4 /dev/urandom | tr -d ' \n')}"
[[ "$container" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || fail "TELFLO_LOAD_IMAGES_NAME must be a plain container name"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/load-images.XXXXXX")" || fail "no temporary directory"
[ -n "$tmp" ] && [ -d "$tmp" ] || fail "no temporary directory"
TELFLO_OCI_PREFIX=load-images
TELFLO_OCI_TMP="$tmp"
started=false
cleanup() {
  if $started; then docker rm -f -v "$container" >/dev/null 2>&1 || echo "load-images: couldn't remove the container $container" >&2; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
telflo_docker_config || exit 1

# Every archive checked before the registry starts; the platform's manifest
# and config digests kept.
manifests=()
configs=()
for image in "${selected[@]}"; do
  base="$(base_of "$image")"
  facts="$(telflo_oci_inspect "$oci_dir/$base.oci.tar" "$(cat "$oci_dir/$base.digest")" "$version" "")" || fail "$image's archive refused"
  manifests+=("$(printf '%s\n' "$facts" | awk -v a="$arch" '$1 == a { print $2 }')")
  configs+=("$(printf '%s\n' "$facts" | awk -v a="$arch" '$1 == a { print $3 }')")
  [[ "${manifests[${#manifests[@]} - 1]}" =~ $DIGEST_RE ]] && [[ "${configs[${#configs[@]} - 1]}" =~ $DIGEST_RE ]] \
    || fail "$image's archive has no $platform image"
done

docker image inspect "$registry_image" >/dev/null 2>&1 \
  || fail "the registry image $registry_image isn't local (scripts/release/tools.sh pull registry): never pulled here"
note "starting the throwaway registry $container on 127.0.0.1"
port="${TELFLO_LOAD_IMAGES_PORT:-}"
if [ -z "$port" ]; then
  port="$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')" \
    || fail "no free port on 127.0.0.1"
fi
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$port" -le 65535 ] || fail "TELFLO_LOAD_IMAGES_PORT must be a port number"
docker run -d --name "$container" --pull never -p "127.0.0.1:$port:5000" "$registry_image" >/dev/null \
  || fail "the throwaway registry didn't start"
started=true
address="127.0.0.1:$port"
ready=false
for _ in $(seq 1 100); do
  if curl -fsS -o /dev/null "http://$address/v2/" 2>/dev/null; then ready=true; break; fi
  sleep 0.2
done
$ready || fail "the throwaway registry at $address didn't answer"
store="$(telflo_engine_store)"

i=0
for image in "${selected[@]}"; do
  base="$(base_of "$image")"
  archive="$oci_dir/$base.oci.tar"
  want="$(cat "$oci_dir/$base.digest")"
  manifest="${manifests[$i]}"
  config="${configs[$i]}"
  i=$((i + 1))
  local_ref="$address/telflo/telflo/$image"
  telflo_oci_unpack "$archive" "$tmp/layout" "$want" || fail "$image's archive couldn't be unpacked"
  "$TELFLO_CRANE" push "$tmp/layout" "$local_ref:$version" >/dev/null 2>"$tmp/crane-push.err" || {
    cat "$tmp/crane-push.err" >&2
    fail "$image: crane push to the throwaway registry failed"
  }
  rm -rf "$tmp/layout"
  status=0
  telflo_remote_digest "$local_ref:$version" || status=$?
  there="$TELFLO_REMOTE_DIGEST"
  [ "$status" -eq 0 ] && [ "$there" = "$want" ] \
    || fail "$image: the throwaway registry holds '${there:-nothing}', not the archive's $want"
  docker pull -q "$local_ref@$manifest" >/dev/null || fail "$image: docker pull of the $arch image ($manifest) failed"
  docker tag "$local_ref@$manifest" "$RELEASE_BASE/$image:$version" || fail "$image: docker tag failed"
  docker rmi "$local_ref@$manifest" >/dev/null 2>&1 || note "$image: couldn't untag $local_ref@$manifest"
  id="$(docker image inspect --format '{{.Id}}' "$RELEASE_BASE/$image:$version" 2>/dev/null)" || id=""
  # The engine's id: the platform's config digest in the classic store, its
  # manifest digest in containerd's.
  expected="$config"; what="$arch config"
  if [ "$store" = containerd ]; then expected="$manifest"; what="$arch manifest (containerd's image store)"; fi
  [ "$id" = "$expected" ] \
    || fail "$image: the engine's image id for $RELEASE_BASE/$image:$version is '${id:-none}', not the archive's $what $expected"
  printf '%s %s\n' "$RELEASE_BASE/$image:$version" "$id"
done
note "done: ${selected[*]} ($version, $platform)"
