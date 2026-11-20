#!/usr/bin/env bash
# Builds the platform's images into OCI archives and copies those same bytes
# to ghcr.io/telflo/telflo/<name>: api, web, otelcol-validator,
# otelcol-testing and ottl-evaluator, from HEAD's committed files.
#
#   scripts/publish-platform-images.sh --dry-run --builder <name> [--image <name>]... [--version x.y.z] [--registry <r>]
#   scripts/publish-platform-images.sh --build --image <name> --builder <name> [--platform <p>] [--version x.y.z]
#   scripts/publish-platform-images.sh --build-oci <dir> --builder <name> [--image <name>]... [--no-attest] [--version x.y.z]
#   scripts/publish-platform-images.sh --push-oci <dir> [--image <name>]... [--version x.y.z] [--registry <r>]
#
# Exactly one mode:
#   --dry-run    checks everything --build-oci checks, asks the registry
#                whether each tag exists, and prints each image's --build-oci
#                build (its archive under the placeholder OCI_DIR), one
#                shell-quoted argument a line; builds nothing.
#   --build      builds ONE image (--image) for --platform (linux/amd64 by
#                default; linux/arm64, or both as linux/amd64,linux/arm64)
#                through the builder, with no output: no --load, no --push,
#                the result stays in the builder's cache.
#   --build-oci  builds each image for linux/amd64 and linux/arm64 once,
#                with BuildKit's SBOM and provenance attestations
#                (--provenance=mode=max, --attest type=sbom with the SBOM
#                generator pinned in scripts/release/tools.lock; --no-attest
#                only for a builder too old to attest), into <dir>/<name>.oci.tar,
#                and writes its image index's digest to <dir>/<name>.digest
#                (one line, sha256:<64 hex>). The archive is checked before
#                the digest is written: index.json's one entry is the build's
#                digest, both platforms are there with HEAD's version and
#                revision labels (and, with attestations, one for each). An
#                image whose archive or digest file exists already is refused
#                before anything builds; a failed build leaves neither.
#                Prints `<name> <digest>` per image.
#   --push-oci   copies each image's archive, unchanged, to
#                <registry>/telflo/telflo/<name>:<version> with crane: it
#                reads <dir>/<name>.oci.tar and <dir>/<name>.digest only.
#                Every archive is checked (as above, against its digest
#                file and HEAD's version and revision) and every tag is asked
#                before anything is pushed: a tag holding the archive's digest
#                is skipped with a line (a re-run); a tag holding another
#                digest, or one the registry can't answer for, refuses the run,
#                nothing pushed. For any registry but a loopback one, the
#                archives must carry attestations (a --no-attest archive is
#                for a rehearsal only). Then each absent tag: the archive
#                checked again, the layout unpacked into
#                a temporary folder (every blob's sha256 checked), `crane push
#                <layout> <ref>` (never --index: the archive's own index is
#                what is pushed), the tag's digest read again and compared,
#                the layout deleted. Prints `<ref>@<digest>` per image.
# --image (repeatable, each once) picks the images; every mode but --build
# takes all five by default, in the order above. The first failure stops
# --build-oci and --push-oci, naming the image and the images not tried.
# There is no --push (it built and pushed in one step, so it could never
# publish tested bytes): it is refused, naming --build-oci and --push-oci.
#
# The version (each image's tag, and its version label) is HEAD's
# charts/telflo/Chart.yaml's appVersion, x.y.z (one version per platform
# release, the chart's appVersion). Without that file at HEAD, --version
# gives it; with it, a --version that differs is refused. There is no
# `latest` tag, and a published version is never pushed again: a fix is a
# new version.
#
# --registry is ghcr.io (the default) or a loopback registry, 127.0.0.1:<port>
# or localhost:<port> (the rehearsal's); the repository is always
# <registry>/telflo/telflo/<name>: nothing else can be named.
#
# --builder names the buildx builder (a docker-container builder: two
# platforms need one; this script never creates one). --build and
# --build-oci check it exists and uses that driver; it must be in the Docker
# configuration in use (DOCKER_CONFIG's buildx/instances), whose buildx must
# be 0.11 or later for --build-oci with attestations (the release's pinned
# buildx: scripts/release/tools.sh docker-config). --push-oci builds
# nothing and takes no --builder.
#
# Refused before anything runs (exit 2): no mode or more than one; --push;
# an unknown argument; no --builder for --dry-run, --build or --build-oci,
# a --builder with --push-oci, or a malformed name; an unknown image;
# --build with no --image or more than one; --platform without --build, or
# not linux/amd64, linux/arm64 or both; --no-attest without --build-oci;
# --registry with --build or --build-oci, or a registry that isn't ghcr.io or
# a loopback one; a --version that isn't x.y.z; a --build-oci or --push-oci
# folder that isn't an existing directory.
#
# Refused next (exit 1), --dry-run too:
#   - a tree that isn't a git checkout's top (a copy, or a folder inside
#     another repository): the images' revision label is its HEAD;
#   - an input flagged assume-unchanged or skip-worktree (git status would
#     not see its changes);
#   - uncommitted changes, staged or not, and untracked files, in the
#     images' inputs (their build contexts' paths, the chart's Chart.yaml,
#     this script and scripts/release's oci.sh, tools.sh and tools.lock):
#     the revision label must describe the image;
#   - a DOCKER_CONFIG the caller set whose config.json (its content never
#     printed) is missing or can't be read, isn't JSON, has no "auths"
#     object or an empty one (Docker would then consult the keychain's
#     helper: it must name the registry's login), has a "credsStore" or
#     "credHelpers" key in any spelling (Go's encoding/json matches keys
#     case-insensitively), or has a key that folds to "auths" but isn't
#     "auths";
#   - (--dry-run) a tag the registry already holds, asked by `crane digest`:
#     a digest, it exists (refused); MANIFEST_UNKNOWN or NAME_UNKNOWN, it
#     doesn't; anything else (a new or private package answers an anonymous
#     read so) the dry run says it can't tell, printing crane's error line,
#     and goes on.
#
# The build contexts are the commit itself: HEAD's raw blobs (`git ls-tree`,
# `git cat-file blob`) under the images' paths, written into a fresh temporary
# directory, each checked against its tree entry
# (`git hash-object --no-filters`), so no ignored or untracked file of the
# working tree reaches an image and no local attribute, filter or line-ending
# setting alters one. A symlink or a submodule is refused. As compose builds
# them: api and web from the repository's root (the root .dockerignore, an
# allowlist) with telflo-core/Dockerfile's `api` or `web` target; the validator
# and the tester from the root with their Dockerfiles' `runtime` target and
# OTELCOL_VERSIONS=all (every version the catalogue offers); the evaluator from
# its own folder. Each Dockerfile's VERSION and REVISION arguments (its version
# and revision labels) are the version and HEAD: the only build arguments that
# vary, and never a secret (the provenance attestation records every build
# argument).
#
# It never logs in to a registry: the registry is read and written with the
# caller's DOCKER_CONFIG once checked (the configuration holding the
# caller's login; crane reads its config.json); when it is unset, a
# temporary one holding no login is used, so no credential helper is ever
# consulted. crane is scripts/release/tools.sh's checked one, else `crane`
# on PATH (a runner's pinned install); the script never downloads it.
# bash 3.2 compatible (macOS's /bin/bash).
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." >/dev/null && pwd)"

# No inherited GIT_* setting (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*…) may
# change which repository, index or configuration git reads.
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
# Local `git replace` objects never stand in for HEAD's.
export GIT_NO_REPLACE_OBJECTS=1

# The release helpers: the registry, crane and the OCI archives.
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"

REPOSITORY_PATH="telflo/telflo"
IMAGES=(api web otelcol-validator otelcol-testing ottl-evaluator)
CHART_YAML="charts/telflo/Chart.yaml"
SCRIPT_PATH="scripts/publish-platform-images.sh"
# The release helpers this script runs: inputs like the rest.
RELEASE_INPUTS=(scripts/release/oci.sh scripts/release/tools.sh scripts/release/tools.lock)
BOTH_PLATFORMS="linux/amd64,linux/arm64"
NO_LOGIN='{"auths":{"telflo-publish.invalid":{}}}'
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
BUILDER_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
REVISION_RE='^[0-9a-f]{40}([0-9a-f]{24})?$'
DIGEST_RE='^sha256:[0-9a-f]{64}$'
# The placeholder a dry run prints for --build-oci's folder.
DRY_RUN_DIR="OCI_DIR"

usage() {
  cat >&2 <<'EOF'
usage: scripts/publish-platform-images.sh --dry-run --builder <name> [--image <name>]... [--version x.y.z] [--registry <r>]
       scripts/publish-platform-images.sh --build --image <name> --builder <name> [--platform <p>] [--version x.y.z]
       scripts/publish-platform-images.sh --build-oci <dir> --builder <name> [--image <name>]... [--no-attest] [--version x.y.z]
       scripts/publish-platform-images.sh --push-oci <dir> [--image <name>]... [--version x.y.z] [--registry <r>]
images: api web otelcol-validator otelcol-testing ottl-evaluator
platforms (--build): linux/amd64 (the default), linux/arm64, linux/amd64,linux/arm64
registry: ghcr.io (the default), 127.0.0.1:<port> or localhost:<port>
EOF
}
fail() { echo "publish-platform-images: $1" >&2; exit 1; }
refuse_usage() { echo "publish-platform-images: $1" >&2; usage; exit 2; }
note() { echo "publish-platform-images: $1" >&2; }

# The repository paths each image's build context is made of (HEAD's files
# under them are extracted), as compose's build reads them.
inputs_of() { # <image>
  case "$1" in
    api | web) echo ".dockerignore telflo-core catalog install-templates" ;;
    otelcol-validator) echo ".dockerignore services/otelcol-validator catalog" ;;
    otelcol-testing) echo ".dockerignore services/otelcol-testing services/otelcol-validator/scripts/download-binaries.py catalog" ;;
    ottl-evaluator) echo "services/ottl-evaluator" ;;
    *) return 1 ;;
  esac
}

# The build's arguments for an image, after the context root (its file,
# target and build arguments), one a line.
build_arguments_of() { # <image> <context root>
  case "$1" in
    api | web)
      printf '%s\n' --file "$2/telflo-core/Dockerfile" --target "$1" ;;
    otelcol-validator | otelcol-testing)
      printf '%s\n' --file "$2/services/$1/Dockerfile" --target runtime --build-arg OTELCOL_VERSIONS=all ;;
    ottl-evaluator)
      printf '%s\n' --file "$2/services/ottl-evaluator/Dockerfile" ;;
  esac
}

# The build context's folder for an image.
context_of() { # <image> <context root>
  case "$1" in
    ottl-evaluator) printf '%s\n' "$2/services/ottl-evaluator" ;;
    *) printf '%s\n' "$2" ;;
  esac
}

# extract_head_dir <path in the repository> <destination>: HEAD's raw blobs
# under the path, written below the destination at their repository paths
# (`git ls-tree` then `git cat-file blob`): no attribute, filter or
# line-ending conversion of the local git setup applies, as `git archive`'s
# would. A symlink or a submodule is refused, naming its path; the executable
# mode (100755) is kept. Each file written must hash to its tree entry.
# Copied from scripts/build-collector-image.sh, with the listing written to a
# file first as the opamp-server repository's publish-image.sh does, so a
# failing `git ls-tree` is noticed, not taken for a shorter tree.
# scripts/build-collector-image.sh's own copy stays unchanged.
extract_head_dir() {
  local entry meta path mode rest sha count=0 tab=$'\t' listing
  listing="$2.ls-tree.$(printf '%s' "$1" | tr '/.' '__')"
  git -C "$ROOT" ls-tree -r -z --full-tree HEAD -- "$1" >"$listing" || fail "can't list HEAD's files under $1"
  while IFS= read -r -d '' entry; do
    meta="${entry%%"$tab"*}"; path="${entry#*"$tab"}"
    mode="${meta%% *}"; rest="${meta#* }"; sha="${rest#* }"
    case "$mode" in
      100644 | 100755) ;;
      120000) fail "HEAD's $path is a symlink: refused (only regular files are published)" ;;
      160000) fail "HEAD's $path is a submodule: refused (only regular files are published)" ;;
      *) fail "HEAD's $path has the mode $mode: refused (only regular files are published)" ;;
    esac
    mkdir -p "$2/$(dirname -- "$path")"
    git -C "$ROOT" cat-file blob "$sha" >"$2/$path" || fail "can't read HEAD's $path"
    # What was written must hash to HEAD's tree entry: any local
    # substitution (a replace ref, a tampered object store) is refused.
    [ "$(git -C "$ROOT" hash-object --no-filters -t blob -- "$2/$path")" = "$sha" ] \
      || fail "HEAD's $path doesn't hash to its tree entry: refused (a local substitution of git objects)"
    if [ "$mode" = 100755 ]; then chmod 755 "$2/$path"; else chmod 644 "$2/$path"; fi
    count=$((count + 1))
  done <"$listing"
  rm -f "$listing"
  [ "$count" -gt 0 ] || fail "HEAD has no file under $1"
}

# check_caller_credentials <variable> <file>: a credential file the caller
# named is accepted only when it names at least one registry's credentials in
# a non-empty "auths" object and has no key naming a credential store or
# helper in any spelling (Docker reads keys case-insensitively, as Go's
# encoding/json does, and auto-detects the keychain's helper when "auths" is
# empty). Its content is never printed.
# Copied unchanged from scripts/build-collector-image.sh, as the opamp-server
# repository's publish-image.sh carries it.
check_caller_credentials() {
  command -v python3 >/dev/null 2>&1 || fail "python3 is required to check $1's file"
  [ -f "$2" ] || fail "$1: its file ($2) is missing"
  local status=0
  python3 -I - "$2" 2>/dev/null <<'PY' || status=$?
import json, sys
try:
    handle = open(sys.argv[1], encoding="utf-8")
except OSError:
    sys.exit(6)
try:
    with handle:
        data = json.load(handle)
except Exception:
    sys.exit(3)
if not isinstance(data, dict):
    sys.exit(4)
for key in data:
    # Belt and braces: the exact spellings, then any other (below).
    if key in ("credsStore", "credHelpers"):
        sys.exit(5)
    # Any other spelling: Go's encoding/json matches keys case-insensitively.
    folded = key.casefold()
    if folded in ("credsstore", "credhelpers"):
        sys.exit(5)
    if folded == "auths" and key != "auths":
        sys.exit(7)
auths = data.get("auths")
if not isinstance(auths, dict):
    sys.exit(4)
if not auths:
    sys.exit(8)
PY
  case "$status" in
    0) ;;
    3) fail "$1: its file ($2) isn't JSON" ;;
    4) fail "$1: its file ($2) has no \"auths\" object" ;;
    5) fail "$1: its file ($2) names a credential store or helper (credsStore or credHelpers, in any spelling): refused, no credential helper is ever consulted" ;;
    6) fail "$1: its file ($2) can't be read" ;;
    7) fail "$1: its file ($2) has a key spelled like \"auths\" that isn't \"auths\"" ;;
    8) fail "$1: its file ($2) has an empty \"auths\" object (Docker would consult a credential helper): it must name the registry's login" ;;
    *) fail "$1: its file ($2) can't be checked" ;;
  esac
}

# exactly_one <sed expression> <file> <what>: the one value the expression
# prints from the file; refused unless exactly one line matches.
exactly_one() {
  local found count
  found="$(sed -n "$1" "$2")"
  count="$(printf '%s' "$found" | grep -c '' || true)"
  [ "$count" -eq 1 ] || fail "$3: expected exactly one line in HEAD's $CHART_YAML, found $count"
  printf '%s\n' "$found"
}

mode=""
builder=""
builder_given=false
platform=""
version_given=""
oci_dir=""
no_attest=false
registry=""
selected=()

set_mode() { # <--mode>
  [ -z "$mode" ] || refuse_usage "one mode: --dry-run, --build, --build-oci or --push-oci (got --$mode and $1)"
  mode="${1#--}"
}
add_image() {
  inputs_of "$1" >/dev/null || refuse_usage "unknown image '$1' (the images: ${IMAGES[*]})"
  local seen
  for seen in ${selected[@]+"${selected[@]}"}; do
    [ "$seen" != "$1" ] || return 0
  done
  selected+=("$1")
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | --build) set_mode "$1"; shift ;;
    --build-oci | --push-oci)
      set_mode "$1"
      [ $# -ge 2 ] || refuse_usage "$1 needs a folder"
      oci_dir="$2"; shift 2 ;;
    --build-oci=* | --push-oci=*) set_mode "${1%%=*}"; oci_dir="${1#*=}"; shift ;;
    --push | --push=*)
      refuse_usage "unknown argument: $1 (removed: build the archives with --build-oci <dir>, test them, then copy the same bytes with --push-oci <dir>)" ;;
    --builder)
      [ $# -ge 2 ] || refuse_usage "--builder needs a value"
      builder="$2"; builder_given=true; shift 2 ;;
    --builder=*) builder="${1#--builder=}"; builder_given=true; shift ;;
    --image)
      [ $# -ge 2 ] || refuse_usage "--image needs a value"
      add_image "$2"; shift 2 ;;
    --image=*) add_image "${1#--image=}"; shift ;;
    --platform)
      [ $# -ge 2 ] || refuse_usage "--platform needs a value"
      platform="$2"; shift 2 ;;
    --platform=*) platform="${1#--platform=}"; shift ;;
    --version)
      [ $# -ge 2 ] || refuse_usage "--version needs a value"
      version_given="$2"; shift 2 ;;
    --version=*) version_given="${1#--version=}"; shift ;;
    --no-attest) no_attest=true; shift ;;
    --registry)
      [ $# -ge 2 ] || refuse_usage "--registry needs a value"
      registry="$2"; shift 2 ;;
    --registry=*) registry="${1#--registry=}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) refuse_usage "unknown argument: $1" ;;
  esac
done

[ -n "$mode" ] || refuse_usage "a mode is required: --dry-run, --build, --build-oci or --push-oci"
if [ "$mode" = push-oci ]; then
  $builder_given && refuse_usage "--push-oci builds nothing: no --builder"
else
  $builder_given || refuse_usage "--builder <name> is required (a docker-container builder; never created here)"
  [[ "$builder" =~ $BUILDER_RE ]] || refuse_usage "the builder's name must match $BUILDER_RE (got '$builder')"
fi
if [ -n "$version_given" ]; then
  [[ "$version_given" =~ $VERSION_RE ]] || refuse_usage "the version must be x.y.z (got '$version_given')"
fi
if $no_attest && [ "$mode" != build-oci ]; then refuse_usage "--no-attest goes with --build-oci only"; fi
case "$mode" in
  dry-run | push-oci)
    registry="${registry:-ghcr.io}"
    telflo_registry_ok "$registry" \
      || refuse_usage "--registry must be ghcr.io or a loopback registry, 127.0.0.1:<port> or localhost:<port> (got '$registry')" ;;
  *) [ -z "$registry" ] || refuse_usage "--registry goes with --dry-run and --push-oci only" ;;
esac
if [ "$mode" = build ]; then
  [ "${#selected[@]}" -eq 1 ] || refuse_usage "--build builds one image: name it with --image (got ${#selected[@]})"
  case "$platform" in
    "") platform="linux/amd64" ;;
    linux/amd64 | linux/arm64) ;;
    "linux/amd64,linux/arm64" | "linux/arm64,linux/amd64") platform="$BOTH_PLATFORMS" ;;
    *) refuse_usage "--platform must be linux/amd64, linux/arm64 or linux/amd64,linux/arm64 (got '$platform')" ;;
  esac
else
  [ -z "$platform" ] || refuse_usage "--platform goes with --build only (--$mode builds $BOTH_PLATFORMS)"
  platform="$BOTH_PLATFORMS"
  [ "${#selected[@]}" -gt 0 ] || selected=("${IMAGES[@]}")
fi
if [ "$mode" = build-oci ] || [ "$mode" = push-oci ]; then
  [ -n "$oci_dir" ] && [ -d "$oci_dir" ] || refuse_usage "--$mode's folder must be an existing directory (got '$oci_dir')"
  oci_dir="$(CDPATH='' cd -- "$oci_dir" >/dev/null && pwd)"
fi

# What is built is exactly what is committed. The checkout must be this
# repository's own (not a copy inside another).
toplevel="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
revision="$(git -C "$ROOT" rev-parse --verify --quiet HEAD 2>/dev/null || true)"
[[ "$revision" =~ $REVISION_RE ]] && [ -n "$toplevel" ] \
  && [ "$toplevel" = "$(CDPATH= cd -- "$ROOT" >/dev/null && pwd -P)" ] \
  || fail "the images need a git checkout of this repository with a commit (not a copy inside another): their revision label is its HEAD"

# The inputs: every selected image's paths, the chart's Chart.yaml (its
# appVersion is the version), this script and the release helpers, each once.
inputs=("$CHART_YAML" "$SCRIPT_PATH" "${RELEASE_INPUTS[@]}")
for image in "${selected[@]}"; do
  for path in $(inputs_of "$image"); do
    known=false
    for p in "${inputs[@]}"; do [ "$p" != "$path" ] || known=true; done
    $known || inputs+=("$path")
  done
done

# An input git is told not to check (assume-unchanged: a lowercase tag;
# skip-worktree: S) would hide its changes from git status.
flagged="$(git -C "$ROOT" ls-files -v -- "${inputs[@]}" | awk '{
    t = substr($0, 1, 1); f = substr($0, 3)
    if (t ~ /^[a-z]$/) print "assume-unchanged: " f
    if (toupper(t) == "S") print "skip-worktree: " f
  }')" || fail "can't read git's flags for the images' inputs"
if [ -n "$flagged" ]; then
  echo "publish-platform-images: refuses inputs flagged for git not to check (git update-index --no-assume-unchanged / --no-skip-worktree them first, or git sparse-checkout disable):" >&2
  printf '%s\n' "$flagged" >&2
  exit 1
fi
dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all -- "${inputs[@]}")" \
  || fail "can't read git status for the images' inputs"
if [ -n "$dirty" ]; then
  echo "publish-platform-images: refuses uncommitted changes in the images' inputs (commit them first: the revision label must describe the image):" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

# The version: HEAD's Chart.yaml's appVersion, else --version.
if git -C "$ROOT" cat-file -e "HEAD:$CHART_YAML" 2>/dev/null; then
  tmp_chart="$(mktemp "${TMPDIR:-/tmp}/publish-platform-images-chart.XXXXXX")" || fail "no temporary file"
  if ! git -C "$ROOT" cat-file blob "HEAD:$CHART_YAML" >"$tmp_chart"; then
    rm -f "$tmp_chart"; fail "can't read HEAD's $CHART_YAML"
  fi
  app_version="$(exactly_one 's/^appVersion:[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}[[:space:]]*$/\1/p' \
    "$tmp_chart" "the chart's appVersion")" || { rm -f "$tmp_chart"; exit 1; }
  rm -f "$tmp_chart"
  [[ "$app_version" =~ $VERSION_RE ]] || fail "$CHART_YAML's appVersion must be x.y.z (got '$app_version')"
  if [ -n "$version_given" ] && [ "$version_given" != "$app_version" ]; then
    fail "--version $version_given is not HEAD's $CHART_YAML appVersion ($app_version): the images' version is the chart's appVersion"
  fi
  version="$app_version"
else
  [ -n "$version_given" ] || fail "HEAD has no $CHART_YAML: --version x.y.z is required (the chart's appVersion to be)"
  version="$version_given"
fi

# The registry and the builder are reached with the caller's DOCKER_CONFIG
# once checked, else a temporary one holding no login (Docker and crane would
# otherwise consult the macOS keychain's credential helper, or ~/.docker).
tmp="$(mktemp -d "${TMPDIR:-/tmp}/publish-platform-images.XXXXXX")" || fail "no temporary directory"
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then fail "no temporary directory"; fi
trap 'rm -rf "$tmp"' EXIT
TELFLO_OCI_PREFIX=publish-platform-images
TELFLO_OCI_TMP="$tmp"
if [ -n "${DOCKER_CONFIG:-}" ]; then
  check_caller_credentials DOCKER_CONFIG "$DOCKER_CONFIG/config.json"
else
  mkdir "$tmp/docker"
  (umask 077 && printf '%s\n' "$NO_LOGIN" >"$tmp/docker/config.json")
  export DOCKER_CONFIG="$tmp/docker"
  note "DOCKER_CONFIG is unset: a configuration with no login is used (set DOCKER_CONFIG to the one holding the registry's login, and the builder)"
fi

# The archives' names in the folder.
archive_of() { printf '%s/%s.oci.tar\n' "$oci_dir" "$1"; }
digest_file_of() { printf '%s/%s.digest\n' "$oci_dir" "$1"; }

# --push-oci: the archives only, then the registry; nothing is extracted or built.
if [ "$mode" = push-oci ]; then
  telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"
  wants=()
  for image in "${selected[@]}"; do
    [ -f "$(archive_of "$image")" ] || fail "$(archive_of "$image") is missing (--build-oci writes it)"
    [ -f "$(digest_file_of "$image")" ] || fail "$(digest_file_of "$image") is missing (--build-oci writes it)"
    [ "$(grep -c '' "$(digest_file_of "$image")")" -eq 1 ] || fail "$(digest_file_of "$image") must be one line"
    want="$(cat "$(digest_file_of "$image")")"
    [[ "$want" =~ $DIGEST_RE ]] || fail "$(digest_file_of "$image") isn't sha256:<64 hex>"
    wants+=("$want")
  done
  # Attestations are required for every registry but a loopback one (a
  # rehearsal's --no-attest builds).
  attest_required=""
  telflo_registry_loopback "$registry" || attest_required=attest
  # Every archive checked (every blob hashed), then every tag asked, before
  # anything is pushed.
  i=0
  for image in "${selected[@]}"; do
    telflo_oci_inspect "$(archive_of "$image")" "${wants[$i]}" "$version" "$revision" "$attest_required" >/dev/null \
      || fail "$image's archive refused: nothing pushed"
    i=$((i + 1))
  done
  i=0
  for image in "${selected[@]}"; do
    ref="$registry/$REPOSITORY_PATH/$image:$version"
    status=0
    telflo_remote_digest "$ref" || status=$?
    remote="$TELFLO_REMOTE_DIGEST"
    case "$(telflo_digest_decision "$status" "$remote" "${wants[$i]}")" in
      push) note "$ref is not in the registry yet" ;;
      skip) note "$ref holds ${wants[$i]} already (the same bytes)" ;;
      *)
        if [ "$status" -eq 0 ]; then
          fail "$ref holds $remote, not the archive's ${wants[$i]}: refused, nothing pushed (a published tag is never overwritten; a fix is a new version)"
        fi
        fail "can't tell whether $ref exists: $TELFLO_REMOTE_ANSWER (nothing pushed)" ;;
    esac
    i=$((i + 1))
  done
  i=0
  for image in "${selected[@]}"; do
    ref="$registry/$REPOSITORY_PATH/$image:$version"
    if ! telflo_oci_copy "$(archive_of "$image")" "${wants[$i]}" "$ref" "$version" "$revision" "$attest_required"; then
      rest=""; seen=false
      for other in "${selected[@]}"; do
        if $seen; then rest="$rest $other"; fi
        if [ "$other" = "$image" ]; then seen=true; fi
      done
      echo "publish-platform-images: stopped at image $image${rest:+; not tried:$rest}" >&2
      exit 1
    fi
    printf '%s@%s\n' "$ref" "${wants[$i]}"
    i=$((i + 1))
  done
  note "done: ${selected[*]} ($version, $registry)"
  exit 0
fi

# --build-oci: no image's archive or digest may exist already.
if [ "$mode" = build-oci ]; then
  for image in "${selected[@]}"; do
    for f in "$(archive_of "$image")" "$(digest_file_of "$image")" "$(archive_of "$image").partial"; do
      [ ! -e "$f" ] || fail "$f exists: --build-oci never overwrites an archive (use a new folder)"
    done
  done
fi

# The build contexts: HEAD's raw blobs only, never the working tree's.
mkdir "$tmp/source"
for path in "${inputs[@]}"; do
  case "$path" in "$CHART_YAML" | "$SCRIPT_PATH" | scripts/release/*) continue ;; esac
  extract_head_dir "$path" "$tmp/source"
done
for image in "${selected[@]}"; do
  case "$image" in
    api | web) dockerfile="telflo-core/Dockerfile" ;;
    *) dockerfile="services/$image/Dockerfile" ;;
  esac
  [ -f "$tmp/source/$dockerfile" ] || fail "HEAD has no $dockerfile"
done

# The SBOM generator, pinned by digest in tools.lock (a bare --sbom=true is
# refused).
if [ "$mode" = dry-run ] || { [ "$mode" = build-oci ] && ! $no_attest; }; then
  sbom_generator="$("${BASH:-bash}" "$ROOT/scripts/release/tools.sh" ref syft-scanner)" \
    || fail "scripts/release/tools.lock names no syft-scanner image (the SBOM generator)"
  [[ "$sbom_generator" =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] \
    || fail "the SBOM generator isn't a reference pinned by digest"
fi

# command_of <image> <archive folder>: the image's build, one argument a line.
command_of() {
  local arguments=() line
  while IFS= read -r line; do arguments+=("$line"); done < <(build_arguments_of "$1" "$tmp/source")
  printf '%s\n' docker buildx --builder "$builder" build --platform "$platform" "${arguments[@]}" \
    --build-arg "VERSION=$version" --build-arg "REVISION=$revision"
  if [ "$mode" != build ]; then
    if $no_attest; then
      printf '%s\n' --provenance=false
    else
      printf '%s\n' --provenance=mode=max --attest "type=sbom,generator=$sbom_generator"
    fi
    printf '%s\n' --output "type=oci,dest=$2/$1.oci.tar.partial" --metadata-file "$tmp/metadata-$1.json"
  fi
  context_of "$1" "$tmp/source"
}

if [ "$mode" = dry-run ]; then
  # Does the registry hold a tag already? Every image is asked.
  telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"
  for image in "${selected[@]}"; do
    ref="$registry/$REPOSITORY_PATH/$image:$version"
    status=0
    telflo_remote_digest "$ref" || status=$?
    remote="$TELFLO_REMOTE_DIGEST"
    case "$status" in
      0) fail "$ref exists in the registry ($remote): a published version is never pushed again (a fix is a new version)" ;;
      3) note "$ref is not in the registry yet" ;;
      *) note "can't tell whether $ref exists (a new or private package answers so to a read without its login; --push-oci asks again with the caller's): $TELFLO_REMOTE_ANSWER" ;;
    esac
  done
  for image in "${selected[@]}"; do
    note "$(printf 'the build: %s for %s through builder %s, revision %s, into %s' "$image" "$platform" "$builder" "$revision" "$DRY_RUN_DIR/$image.oci.tar")"
    while IFS= read -r line; do printf '%q\n' "$line"; done < <(command_of "$image" "$DRY_RUN_DIR")
  done
  note "dry run: nothing built or pushed (--build-oci extracts HEAD afresh and runs the commands above)"
  exit 0
fi

# --build and --build-oci: the builder must exist and use the
# docker-container driver (two platforms need one; the docker driver would
# load a one-platform result into the engine).
driver="$(docker buildx --builder "$builder" inspect 2>/dev/null | awk '/^Driver:/ { print $2; exit }' || true)"
[ -n "$driver" ] || fail "no buildx builder named '$builder' in the Docker configuration in use ($DOCKER_CONFIG): this script never creates one"
[ "$driver" = docker-container ] \
  || fail "builder '$builder' uses the '$driver' driver: the images need a 'docker-container' builder"

if [ "$mode" = build ]; then
  image="${selected[0]}"
  command_line=()
  while IFS= read -r line; do command_line+=("$line"); done < <(command_of "$image" "")
  note "$(printf 'building %s (version %s) for %s through builder %s, with no output (the result stays in the builder'"'"'s cache)' "$image" "$version" "$platform" "$builder")"
  printf '%q\n' "${command_line[@]}"
  set +e
  "${command_line[@]}"
  exit $?
fi

# --build-oci: buildx 0.11 or later attests (the pinned one is 0.38.1).
if ! $no_attest; then
  buildx_version="$(docker buildx version 2>/dev/null | awk '{ print $2; exit }' || true)"
  buildx_major="$(printf '%s' "$buildx_version" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1/p')"
  buildx_minor="$(printf '%s' "$buildx_version" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\2/p')"
  if [ -z "$buildx_major" ] || { [ "$buildx_major" -eq 0 ] && [ "$buildx_minor" -lt 11 ]; }; then
    fail "the buildx in use ('${buildx_version:-unknown}') can't attest: 0.11 or later (scripts/release/tools.sh docker-config <dir>), or --no-attest for a rehearsal only"
  fi
fi

# --build-oci: each image in turn; the first failure stops it.
for image in "${selected[@]}"; do
  archive="$(archive_of "$image")"
  command_line=()
  while IFS= read -r line; do command_line+=("$line"); done < <(command_of "$image" "$oci_dir")
  note "== $image: building $archive ($platform, version $version) through builder $builder$($no_attest && echo ', no attestations')"
  printf '%q\n' "${command_line[@]}" >&2
  status=0
  "${command_line[@]}" || status=$?
  digest=""
  if [ "$status" -eq 0 ]; then
    digest="$(python3 -I - "$tmp/metadata-$image.json" 2>/dev/null <<'PY' || true
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8")).get("containerimage.digest")
print(value if isinstance(value, str) else "")
PY
)"
    if ! [[ "$digest" =~ $DIGEST_RE ]]; then
      note "the build's index digest couldn't be read from its metadata"
      status=98
    elif ! telflo_oci_inspect "$archive.partial" "$digest" "$version" "$revision" "$($no_attest || echo attest)" >/dev/null; then
      status=99
    fi
  fi
  if [ "$status" -ne 0 ]; then
    rm -f "$archive.partial"
    rest=""; seen=false
    for other in "${selected[@]}"; do
      if $seen; then rest="$rest $other"; fi
      if [ "$other" = "$image" ]; then seen=true; fi
    done
    echo "publish-platform-images: stopped at image $image (exit $status)${rest:+; not tried:$rest}" >&2
    exit 1
  fi
  mv "$archive.partial" "$archive" || fail "can't move the archive into place"
  printf '%s\n' "$digest" >"$(digest_file_of "$image").partial" && mv "$(digest_file_of "$image").partial" "$(digest_file_of "$image")" \
    || fail "can't write $(digest_file_of "$image")"
  printf '%s %s\n' "$image" "$digest"
done
note "done: ${selected[*]} ($version) in $oci_dir"
