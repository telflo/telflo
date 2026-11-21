#!/usr/bin/env bash
# Builds telflo's collector image (docker/collector-image: otelcol-contrib and
# the OpAMP supervisor) for one collector version of the catalog.
#
#   scripts/build-collector-image.sh <version> [--platform linux/amd64|linux/arm64]
#   scripts/build-collector-image.sh <version> --build-oci <dir> --builder <name> [--no-attest]
#   scripts/build-collector-image.sh <version> --push-oci <dir> [--registry <r>]
#   (--dry-run with a local build or --build-oci: check everything, print the
#   docker command, run nothing)
#   scripts/build-collector-image.sh --list-offered
#
# The version must be in catalog/distributions/otelcol-contrib.json's
# versions[] and not deprecated. Its linux_amd64 and linux_arm64
# otelcol-contrib and opampsupervisor download URLs and sha256 become the
# Dockerfile's build arguments, each checked first (the version x.y.z, the
# sha256 64 lowercase hex digits, the URL under upstream's releases on
# GitHub, with no `..` and no percent-escape but `%2F` (upstream's tags
# `cmd/opampsupervisor/v…` are spelt so), its file name this version's and
# this platform's); the Dockerfile
# checks each download against its sha256.
#
# --list-offered prints the versions the catalog offers (not deprecated,
# each entry checked as above), newest first, one a line: the versions the
# collector workflow's `all` builds.
#
# The image carries the OCI labels source (this repository), version (the
# collector's), revision (git HEAD), title and description. No `latest` tag.
#
# A local build (no --build-oci or --push-oci) builds ONE platform (the
# Docker engine's, or --platform) tagged
# ${TELFLO_COLLECTOR_IMAGE_REPOSITORY:-ghcr.io/telflo/telflo/collector}:<version>
# and loads it into the local engine, through the Docker-driver builder
# `desktop-linux` (or BUILDX_BUILDER, or --builder), which must use the
# `docker` driver: a `docker-container` builder would pull moby/buildkit to
# start. It uses the working directory and the caller's Docker configuration
# (~/.docker) as ordinary Docker does: its FROM pull may consult Docker
# Desktop's credential helper.
#
# --build-oci <dir> builds linux/amd64 and linux/arm64 once, with BuildKit's
# SBOM and provenance attestations (--provenance=mode=max, --attest
# type=sbom with the generator pinned in scripts/release/tools.lock;
# --no-attest only for a builder too old to attest), through the
# docker-container builder --builder names (never created here), into
# <dir>/collector-<version>.oci.tar, and writes its image index's digest to
# <dir>/collector-<version>.digest (one line) once the archive is checked:
# index.json's one entry is the build's digest, both platforms there with
# this version's and HEAD's labels (and an attestation for each). An existing
# archive or digest file is refused before anything builds; a failed build
# leaves neither.
#
# --push-oci <dir> copies that archive, unchanged, to
# <registry>/telflo/telflo/collector:<version> with crane, reading only those
# two files (the archive checked as above first; for any registry but a
# loopback one it must carry attestations): the tag absent, the layout
# is unpacked into a temporary folder (every blob's sha256 checked), pushed
# with `crane push <layout> <ref>` (never --index) and the tag's digest read
# again and compared; the tag holding the same digest, skipped with a line (a
# re-run); another digest, or an answer that isn't "absent", refused, nothing
# pushed. --registry is ghcr.io (the default) or a loopback 127.0.0.1:<port>
# or localhost:<port>; the repository is always telflo/telflo/collector.
#
# There is no --push or --replace (they built and pushed in one step, so they
# could never publish tested bytes, and re-pushed a published tag): both are
# refused, naming --build-oci and --push-oci.
#
# Before anything runs, --build-oci and --push-oci (and a --build-oci dry
# run) refuse:
#   - TELFLO_COLLECTOR_IMAGE_REPOSITORY set to anything but
#     ghcr.io/telflo/telflo/collector: they name only that repository
#     (the older registry paths ghcr.io/telflo/collector and
#     ghcr.io/telflo/platform/collector can't be reached);
#   - a catalog other than the repository's (TELFLO_COLLECTOR_CATALOGUE);
#   - a tree that isn't a git checkout of this repository (its git toplevel
#     isn't this repository's root, e.g. a copy inside another repository);
#   - an input flagged assume-unchanged or skip-worktree (git status would
#     not see its changes);
#   - uncommitted changes in the image's inputs (docker/collector-image, the
#     catalog, this script, scripts/release's oci.sh, tools.sh and
#     tools.lock): the revision label must describe the image;
#   - a DOCKER_CONFIG the caller set whose config.json (its content never
#     printed) is missing or can't be read, isn't JSON, has no "auths" object
#     or an empty one (Docker would then consult the keychain's helper: it
#     must name the registry's login), has a "credsStore" or "credHelpers"
#     key in any spelling (Go's encoding/json matches keys
#     case-insensitively), or has a key that folds to "auths" but isn't
#     "auths";
#   - (a --build-oci dry run) a tag the registry already holds, asked by
#     `crane digest`: a digest, it exists (refused); MANIFEST_UNKNOWN or
#     NAME_UNKNOWN, it doesn't; anything else, the dry run says it can't tell
#     and goes on.
# Credentials: whatever DOCKER_CONFIG the caller set, once checked (the
# configuration that holds the caller's login; crane reads its
# config.json); when it is unset, a temporary configuration with no login,
# so no credential helper is ever consulted. This script never logs in.
# --build-oci builds from the commit itself: its build context is HEAD's raw
# blobs under docker/collector-image (`git ls-tree`, `git cat-file blob`),
# written into a temporary directory (no ignored or untracked file of the
# working tree reaches the image; no local attribute, filter or line-ending
# setting alters them; a symlink or submodule is refused), its build arguments
# come from HEAD's catalog blob: the downloads' URLs and sums, the only
# build arguments (never a secret: the provenance attestation records them).
#
# crane is scripts/release/tools.sh's checked one, else `crane` on PATH (a
# runner's pinned install); the script never downloads it.
#
# A build downloads the Debian base (pinned by digest in the Dockerfile),
# apt's curl and ca-certificates from Debian's mirrors, and the two binaries
# from GitHub.
#
# TELFLO_COLLECTOR_CATALOGUE names another catalog file (the script's tests,
# docker/collector-image/build-collector-image_test.sh, use it); its values
# are checked the same way. bash 3.2 compatible (macOS's /bin/bash).
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." >/dev/null && pwd)"

# No inherited GIT_* setting (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*…) may
# change which repository, index or configuration git reads.
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
# Local `git replace` objects never stand in for HEAD's.
export GIT_NO_REPLACE_OBJECTS=1
REPOSITORY_CATALOGUE="$ROOT/catalog/distributions/otelcol-contrib.json"
CATALOGUE="${TELFLO_COLLECTOR_CATALOGUE:-$REPOSITORY_CATALOGUE}"
CONTEXT="$ROOT/docker/collector-image"
REPOSITORY="${TELFLO_COLLECTOR_IMAGE_REPOSITORY:-ghcr.io/telflo/telflo/collector}"
# The one repository --build-oci and --push-oci publish to.
RELEASE_REPOSITORY="ghcr.io/telflo/telflo/collector"
RELEASE_PATH="telflo/telflo/collector"
# An older registry path that isn't this repository's: never pushed to.
OLD_REPOSITORY="ghcr.io/telflo/collector"
SOURCE_URL="https://github.com/telflo/telflo"
# The image's inputs, relative to the repository: --push refuses their changes.
IMAGE_INPUTS=(docker/collector-image catalog/distributions/otelcol-contrib.json scripts/build-collector-image.sh
  scripts/release/oci.sh scripts/release/tools.sh scripts/release/tools.lock)

# The catalog's own formats (telflo-core's catalogue.ts) and the platform's
# TELFLO_COLLECTOR_IMAGE_REPOSITORY rule.
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
SHA256_RE='^[a-f0-9]{64}$'
URL_RE='^https://github\.com/open-telemetry/opentelemetry-collector-releases/releases/download/[A-Za-z0-9._%/+-]+$'
REPOSITORY_RE='^[a-z0-9]+([._:/-][a-z0-9]+)*$'
BUILDER_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
REVISION_RE='^[0-9a-f]{40}([0-9a-f]{24})?$'
DIGEST_RE='^sha256:[0-9a-f]{64}$'

# The release helpers: the registry, crane and the OCI archives.
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"

usage() {
  cat >&2 <<'EOF'
usage: scripts/build-collector-image.sh <version> [--platform linux/amd64|linux/arm64]
       scripts/build-collector-image.sh <version> --build-oci <dir> --builder <name> [--no-attest]
       scripts/build-collector-image.sh <version> --push-oci <dir> [--registry <r>]
       --dry-run with a local build or --build-oci: check everything, print the docker command, run nothing
       scripts/build-collector-image.sh --list-offered
EOF
}

fail() { echo "build-collector-image: $1" >&2; exit 1; }
fail_usage() { echo "build-collector-image: $1" >&2; usage; exit 2; }
note() { echo "build-collector-image: $1" >&2; }

# extract_head_dir <path in the repository> <destination>: HEAD's raw blobs
# under the path, written below the destination at their repository paths
# (`git ls-tree` then `git cat-file blob`): no attribute, filter or
# line-ending conversion of the local git setup applies, as `git archive`'s
# would. A symlink or a submodule is refused, naming its path; the executable
# mode (100755) is kept. Each file written must hash to its tree entry.
extract_head_dir() {
  local entry meta path mode rest sha count=0 tab=$'\t'
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
  done < <(git -C "$ROOT" ls-tree -r -z --full-tree HEAD -- "$1")
  [ "$count" -gt 0 ] || fail "HEAD has no file under $1"
}

# check_caller_credentials <variable> <file>: a credential file the caller
# named is accepted only when it names at least one registry's credentials in
# a non-empty "auths" object and has no key naming a credential store or
# helper in any spelling (Docker and oras read keys case-insensitively, as
# Go's encoding/json does, and auto-detect the keychain's helper when "auths"
# is empty). Its content is never printed.
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

version=""
platform=""
oci_mode=""
oci_dir=""
builder=""
builder_given=false
dry_run=false
no_attest=false
registry=""
list_offered=false
other_arguments=false

while [ $# -gt 0 ]; do
  case "$1" in
    --list-offered) list_offered=true; shift; continue ;;
    -h|--help) usage; exit 0 ;;
  esac
  other_arguments=true
  case "$1" in
    --platform)
      [ $# -ge 2 ] || fail_usage "--platform needs a value"
      platform="$2"; shift 2 ;;
    --platform=*) platform="${1#--platform=}"; shift ;;
    --push | --replace)
      fail_usage "unknown option: $1 (removed: build the archive with --build-oci <dir>, test it, then copy the same bytes with --push-oci <dir>)" ;;
    --build-oci | --push-oci)
      [ -z "$oci_mode" ] || fail_usage "one of --build-oci or --push-oci"
      [ $# -ge 2 ] || fail_usage "$1 needs a folder"
      oci_mode="${1#--}"; oci_dir="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    --no-attest) no_attest=true; shift ;;
    --registry)
      [ $# -ge 2 ] || fail_usage "--registry needs a value"
      registry="$2"; shift 2 ;;
    --builder)
      [ $# -ge 2 ] || fail_usage "--builder needs a value"
      builder="$2"; builder_given=true; shift 2 ;;
    --builder=*) builder="${1#--builder=}"; builder_given=true; shift ;;
    -*) fail_usage "unknown option: $1" ;;
    *)
      [ -z "$version" ] || fail_usage "one version only (got '$version' and '$1')"
      version="$1"; shift ;;
  esac
done

# The catalog's reader: `list` prints the offered versions newest first;
# `entry <version>` refuses an unknown or deprecated version and prints the
# version's eight values, one a line, in a fixed order. Every offered entry
# (in `list`) or the version's entry (in `entry`) is refused when a value
# isn't the catalog's format. -I: nothing from the current directory or
# the environment is imported.
read_catalogue() { # list | entry <version>
  [ -f "$CATALOGUE" ] || fail "the catalogue is missing: $CATALOGUE"
  command -v python3 >/dev/null 2>&1 || fail "python3 is required to read the catalogue"
  python3 -I - "$CATALOGUE" "$@" <<'PY'
import json, re, sys

path, mode = sys.argv[1], sys.argv[2]
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
SHA256 = re.compile(r"[a-f0-9]{64}")
URL = re.compile(r"https://github\.com/open-telemetry/opentelemetry-collector-releases/releases/download/[A-Za-z0-9._%/+-]+")

def refuse(message):
    print("build-collector-image: " + message, file=sys.stderr)
    sys.exit(1)

def values_of(entry, version):
    out = []
    for binary, file_name in (("otelcolContrib", "otelcol-contrib_%s_%s.tar.gz"),
                              ("opampSupervisor", "opampsupervisor_%s_%s")):
        for arch in ("linux_amd64", "linux_arm64"):
            item = (entry.get(binary) or {}).get(arch)
            if not isinstance(item, dict):
                refuse("version %s has no %s %s binary" % (version, binary, arch))
            url, sha = item.get("downloadUrl"), item.get("sha256")
            if not isinstance(url, str) or not URL.fullmatch(url) or ".." in url or "%" in url.replace("%2F", ""):
                refuse("version %s: %s %s downloadUrl is not under upstream's releases on GitHub" % (version, binary, arch))
            if not isinstance(sha, str) or not SHA256.fullmatch(sha):
                refuse("version %s: %s %s sha256 is not 64 lowercase hex digits" % (version, binary, arch))
            expected = file_name % (version, arch)
            if url.rsplit("/", 1)[-1] != expected:
                refuse("the catalogue's URL %s is not %s" % (url, expected))
            out += [url, sha]
    return out

with open(path, encoding="utf-8") as handle:
    catalogue = json.load(handle)
versions = catalogue.get("versions") if isinstance(catalogue, dict) else None
if not isinstance(versions, list):
    refuse("the catalogue has no versions[]")

if mode == "list":
    seen, offered = set(), []
    for entry in versions:
        if not isinstance(entry, dict):
            continue
        version = entry.get("version")
        if isinstance(version, str):
            if version in seen:
                refuse("version %s is in the catalogue more than once" % version)
            seen.add(version)
        if entry.get("deprecated") is not False:
            continue
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            refuse("the catalogue offers a version that isn't x.y.z: %r" % (version,))
        values_of(entry, version)
        offered.append(version)
    if not offered:
        refuse("the catalogue offers no version")
    offered.sort(key=lambda v: tuple(int(part) for part in v.split(".")), reverse=True)
    print("\n".join(offered))
    sys.exit(0)

version = sys.argv[3]
entries = [v for v in versions if isinstance(v, dict) and v.get("version") == version]
if not entries:
    refuse("version %s is not in the catalogue (%s)" % (version, path))
if len(entries) > 1:
    refuse("version %s is in the catalogue more than once" % version)
entry = entries[0]
if entry.get("deprecated") is not False:
    refuse("version %s is deprecated in the catalogue: it is no longer offered" % version)
print("\n".join(values_of(entry, version)))
PY
}

if $list_offered; then
  $other_arguments && fail_usage "--list-offered takes no other argument"
  read_catalogue list || exit 1
  exit 0
fi

[ -n "$version" ] || fail_usage "a version is required (e.g. 0.162.0)"
[[ "$version" =~ $VERSION_RE ]] || fail_usage "the version must be x.y.z (got '$version')"
[[ "$REPOSITORY" =~ $REPOSITORY_RE ]] \
  || fail "TELFLO_COLLECTOR_IMAGE_REPOSITORY must match $REPOSITORY_RE (got '$REPOSITORY')"

case "$oci_mode" in
  build-oci)
    $builder_given || fail_usage "--build-oci needs --builder <name> (a docker-container builder; this script never creates one)"
    case "$platform" in
      "" | "linux/amd64,linux/arm64" | "linux/arm64,linux/amd64") platform="linux/amd64,linux/arm64" ;;
      *) fail_usage "--build-oci builds both platforms, linux/amd64 and linux/arm64 (got --platform '$platform')" ;;
    esac
    if [ -n "$registry" ] && ! $dry_run; then fail_usage "--registry goes with --push-oci, or a --build-oci dry run (its registry read)"; fi
    ;;
  push-oci)
    $builder_given && fail_usage "--push-oci builds nothing: no --builder"
    [ -z "$platform" ] || fail_usage "--push-oci copies the archive's platforms: no --platform"
    $dry_run && fail_usage "--dry-run goes with a local build or --build-oci"
    $no_attest && fail_usage "--no-attest goes with --build-oci only"
    ;;
  *)
    $no_attest && fail_usage "--no-attest goes with --build-oci only"
    [ -z "$registry" ] || fail_usage "--registry goes with --push-oci, or a --build-oci dry run"
    $builder_given || builder="${BUILDX_BUILDER:-desktop-linux}"
    if [ -z "$platform" ]; then
      engine_arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
      case "$engine_arch" in
        amd64|x86_64) platform="linux/amd64" ;;
        arm64|aarch64) platform="linux/arm64" ;;
        *) fail "can't tell the Docker engine's platform (got '$engine_arch'): pass --platform linux/amd64 or linux/arm64" ;;
      esac
    fi
    case "$platform" in
      linux/amd64|linux/arm64) ;;
      *) fail_usage "--platform must be linux/amd64 or linux/arm64 for a local build (one platform is loaded locally; got '$platform')" ;;
    esac
    ;;
esac
if [ "$oci_mode" != push-oci ]; then
  [[ "$builder" =~ $BUILDER_RE ]] || fail_usage "the builder's name must match $BUILDER_RE (got '$builder')"
fi
if [ -n "$oci_mode" ]; then
  registry="${registry:-ghcr.io}"
  telflo_registry_ok "$registry" \
    || fail_usage "--registry must be ghcr.io or a loopback registry, 127.0.0.1:<port> or localhost:<port> (got '$registry')"
  [ -n "$oci_dir" ] && [ -d "$oci_dir" ] || fail_usage "--$oci_mode's folder must be an existing directory (got '$oci_dir')"
  oci_dir="$(CDPATH='' cd -- "$oci_dir" >/dev/null && pwd)"
fi

revision="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
if [ -n "$oci_mode" ]; then
  [ "$REPOSITORY" != "$OLD_REPOSITORY" ] \
    || fail "--$oci_mode refuses $OLD_REPOSITORY: an older registry path that isn't this repository's (the platform's is $RELEASE_REPOSITORY)"
  [ "$REPOSITORY" = "$RELEASE_REPOSITORY" ] \
    || fail "--$oci_mode publishes only to $RELEASE_REPOSITORY (or a loopback registry's $RELEASE_PATH, through --registry): unset TELFLO_COLLECTOR_IMAGE_REPOSITORY (got '$REPOSITORY')"
  [ "$CATALOGUE" = "$REPOSITORY_CATALOGUE" ] \
    || fail "--$oci_mode reads only the repository's catalogue (unset TELFLO_COLLECTOR_CATALOGUE)"
  toplevel="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ "$revision" =~ $REVISION_RE ]] && [ -n "$toplevel" ] \
    && [ "$toplevel" = "$(CDPATH='' cd -- "$ROOT" >/dev/null && pwd -P)" ] \
    || fail "--$oci_mode needs a git checkout of this repository (not a copy inside another): the image's revision label is its HEAD"
  # An input git is told not to check (assume-unchanged: a lowercase tag;
  # skip-worktree: S) would hide its changes from git status.
  flagged="$(git -C "$ROOT" ls-files -v -- "${IMAGE_INPUTS[@]}" | awk '{
      t = substr($0, 1, 1); f = substr($0, 3)
      if (t ~ /^[a-z]$/) print "assume-unchanged: " f
      if (toupper(t) == "S") print "skip-worktree: " f
    }')" || fail "--$oci_mode can't read git's flags for the image's inputs"
  if [ -n "$flagged" ]; then
    echo "build-collector-image: --$oci_mode refuses inputs flagged for git not to check (git update-index --no-assume-unchanged / --no-skip-worktree them first, or git sparse-checkout disable):" >&2
    printf '%s\n' "$flagged" >&2
    exit 1
  fi
  dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all -- "${IMAGE_INPUTS[@]}")" \
    || fail "--$oci_mode can't read git status for the image's inputs"
  if [ -n "$dirty" ]; then
    echo "build-collector-image: --$oci_mode refuses uncommitted changes in the image's inputs (commit them first: the revision label must describe the image):" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
  fi
fi

# --build-oci and --push-oci talk to the registry: with the caller's
# DOCKER_CONFIG once checked, else a temporary one holding no login (Docker
# and crane would otherwise consult the macOS keychain's credential helper, or
# ~/.docker). Everything they publish comes from HEAD: the build context is
# HEAD's docker/collector-image and the build arguments HEAD's catalog, both
# written into the temporary directory.
tmp=""
cleanup() { if [ -n "$tmp" ]; then rm -rf "$tmp"; fi; }
trap cleanup EXIT
if [ -n "$oci_mode" ]; then
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/build-collector-image.XXXXXX")" || fail "no temporary directory"
  if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then fail "no temporary directory"; fi
  TELFLO_OCI_PREFIX=build-collector-image
  TELFLO_OCI_TMP="$tmp"
  if [ -n "${DOCKER_CONFIG:-}" ]; then
    check_caller_credentials DOCKER_CONFIG "$DOCKER_CONFIG/config.json"
  else
    mkdir "$tmp/docker"
    (umask 077 && printf '%s\n' '{"auths":{"telflo-publish.invalid":{}}}' >"$tmp/docker/config.json")
    export DOCKER_CONFIG="$tmp/docker"
    note "DOCKER_CONFIG is unset: a configuration with no login is used (set DOCKER_CONFIG to the one holding the registry's login)"
  fi
  if [ "$oci_mode" = build-oci ]; then
    mkdir "$tmp/source"
    extract_head_dir docker/collector-image "$tmp/source"
    CONTEXT="$tmp/source/docker/collector-image"
    [ -f "$CONTEXT/Dockerfile" ] || fail "HEAD's docker/collector-image has no Dockerfile"
  fi
  git -C "$ROOT" cat-file blob "HEAD:catalog/distributions/otelcol-contrib.json" >"$tmp/catalogue.json" \
    || fail "can't read HEAD's catalog/distributions/otelcol-contrib.json"
  CATALOGUE="$tmp/catalogue.json"
fi

values="$(read_catalogue entry "$version")" || exit 1

lines=()
while IFS= read -r line; do lines+=("$line"); done <<<"$values"
[ "${#lines[@]}" -eq 8 ] || fail "the catalogue's reader gave ${#lines[@]} values, not 8"

# The same checks again where the values are used, and each file name this
# version's and this platform's (the tag names the binaries' version).
check_url() { # <url> <expected file name>
  [[ "$1" =~ $URL_RE ]] && [[ "$1" != *..* ]] && [[ "${1//%2F/}" != *%* ]] \
    || fail "not an upstream release URL: $1"
  [ "${1##*/}" = "$2" ] || fail "the catalogue's URL $1 is not $2"
}
check_sha() { [[ "$1" =~ $SHA256_RE ]] || fail "not a sha256: $1"; }

OTELCOL_URL_AMD64="${lines[0]}"; OTELCOL_SHA256_AMD64="${lines[1]}"
OTELCOL_URL_ARM64="${lines[2]}"; OTELCOL_SHA256_ARM64="${lines[3]}"
SUPERVISOR_URL_AMD64="${lines[4]}"; SUPERVISOR_SHA256_AMD64="${lines[5]}"
SUPERVISOR_URL_ARM64="${lines[6]}"; SUPERVISOR_SHA256_ARM64="${lines[7]}"
check_url "$OTELCOL_URL_AMD64" "otelcol-contrib_${version}_linux_amd64.tar.gz"
check_url "$OTELCOL_URL_ARM64" "otelcol-contrib_${version}_linux_arm64.tar.gz"
check_url "$SUPERVISOR_URL_AMD64" "opampsupervisor_${version}_linux_amd64"
check_url "$SUPERVISOR_URL_ARM64" "opampsupervisor_${version}_linux_arm64"
for sha in "$OTELCOL_SHA256_AMD64" "$OTELCOL_SHA256_ARM64" "$SUPERVISOR_SHA256_AMD64" "$SUPERVISOR_SHA256_ARM64"; do
  check_sha "$sha"
done

tag="$REPOSITORY:$version"
ref="$registry/$RELEASE_PATH:$version"
archive="$oci_dir/collector-$version.oci.tar"
digest_file="$oci_dir/collector-$version.digest"

# --push-oci: the archive only, then the registry; nothing is built.
if [ "$oci_mode" = push-oci ]; then
  telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"
  [ -f "$archive" ] || fail "$archive is missing (--build-oci writes it)"
  [ -f "$digest_file" ] || fail "$digest_file is missing (--build-oci writes it)"
  [ "$(grep -c '' "$digest_file")" -eq 1 ] || fail "$digest_file must be one line"
  want="$(cat "$digest_file")"
  [[ "$want" =~ $DIGEST_RE ]] || fail "$digest_file isn't sha256:<64 hex>"
  # Attestations are required for every registry but a loopback one.
  attest_required=""
  telflo_registry_loopback "$registry" || attest_required=attest
  telflo_oci_inspect "$archive" "$want" "$version" "$revision" "$attest_required" >/dev/null || fail "the archive refused: nothing pushed"
  telflo_oci_copy "$archive" "$want" "$ref" "$version" "$revision" "$attest_required" || exit 1
  printf '%s@%s\n' "$ref" "$want"
  exit 0
fi

build_args=(
  --build-arg "OTELCOL_URL_AMD64=$OTELCOL_URL_AMD64"
  --build-arg "OTELCOL_SHA256_AMD64=$OTELCOL_SHA256_AMD64"
  --build-arg "OTELCOL_URL_ARM64=$OTELCOL_URL_ARM64"
  --build-arg "OTELCOL_SHA256_ARM64=$OTELCOL_SHA256_ARM64"
  --build-arg "SUPERVISOR_URL_AMD64=$SUPERVISOR_URL_AMD64"
  --build-arg "SUPERVISOR_SHA256_AMD64=$SUPERVISOR_SHA256_AMD64"
  --build-arg "SUPERVISOR_URL_ARM64=$SUPERVISOR_URL_ARM64"
  --build-arg "SUPERVISOR_SHA256_ARM64=$SUPERVISOR_SHA256_ARM64"
)
labels=(
  --label "org.opencontainers.image.source=$SOURCE_URL"
  --label "org.opencontainers.image.version=$version"
  --label "org.opencontainers.image.revision=${revision:-unknown}"
  --label "org.opencontainers.image.title=Telflo platform collector"
  --label "org.opencontainers.image.description=otelcol-contrib $version under the OpAMP supervisor, for the Telflo platform"
)


# --build-oci: the archive must not exist; the SBOM generator pinned by
# digest in tools.lock (a bare --sbom=true is refused).
if [ "$oci_mode" = build-oci ]; then
  for f in "$archive" "$digest_file" "$archive.partial"; do
    [ ! -e "$f" ] || fail "$f exists: --build-oci never overwrites an archive (use a new folder)"
  done
  attest_args=(--provenance=false)
  if ! $no_attest; then
    sbom_generator="$("${BASH:-bash}" "$ROOT/scripts/release/tools.sh" ref syft-scanner)" \
      || fail "scripts/release/tools.lock names no syft-scanner image (the SBOM generator)"
    [[ "$sbom_generator" =~ ^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$ ]] \
      || fail "the SBOM generator isn't a reference pinned by digest"
    attest_args=(--provenance=mode=max --attest "type=sbom,generator=$sbom_generator")
  fi
  command_line=(docker buildx --builder "$builder" build
    --platform "$platform" "${build_args[@]}" "${labels[@]}" "${attest_args[@]}"
    --output "type=oci,dest=$archive.partial" --metadata-file "$tmp/metadata.json" "$CONTEXT")

  if $dry_run; then
    # Does the registry hold the tag already?
    telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"
    status=0
    telflo_remote_digest "$ref" || status=$?
    remote="$TELFLO_REMOTE_DIGEST"
    case "$status" in
      0) fail "$ref exists in the registry ($remote): a published tag is never pushed again" ;;
      3) note "$ref is not in the registry yet" ;;
      *) note "can't tell whether $ref exists (a new or private package answers so to a read without its login; --push-oci asks again with the caller's): $TELFLO_REMOTE_ANSWER" ;;
    esac
    note "$(printf 'would build %s for %s through builder %s into %s' "$ref" "$platform" "$builder" "$archive")"
    printf '%q\n' "${command_line[@]}"
    exit 0
  fi

  driver="$(docker buildx --builder "$builder" inspect 2>/dev/null | awk '/^Driver:/ { print $2; exit }' || true)"
  [ -n "$driver" ] || fail "no buildx builder named '$builder' in the Docker configuration in use ($DOCKER_CONFIG): this script never creates one"
  [ "$driver" = docker-container ] \
    || fail "builder '$builder' uses the '$driver' driver: --build-oci needs a 'docker-container' builder"
  if ! $no_attest; then
    buildx_version="$(docker buildx version 2>/dev/null | awk '{ print $2; exit }' || true)"
    buildx_major="$(printf '%s' "$buildx_version" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1/p')"
    buildx_minor="$(printf '%s' "$buildx_version" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\2/p')"
    if [ -z "$buildx_major" ] || { [ "$buildx_major" -eq 0 ] && [ "$buildx_minor" -lt 11 ]; }; then
      fail "the buildx in use ('${buildx_version:-unknown}') can't attest: 0.11 or later (scripts/release/tools.sh docker-config <dir>), or --no-attest for a rehearsal only"
    fi
  fi
  note "building $archive ($platform, collector $version) through builder $builder$($no_attest && echo ', no attestations')"
  printf '%q\n' "${command_line[@]}" >&2
  status=0
  "${command_line[@]}" || status=$?
  if [ "$status" -eq 0 ]; then
    digest="$(python3 -I - "$tmp/metadata.json" 2>/dev/null <<'PY' || true
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
    fail "the build of collector $version failed (exit $status): no archive written"
  fi
  mv "$archive.partial" "$archive" || fail "can't move the archive into place"
  printf '%s\n' "$digest" >"$digest_file.partial" && mv "$digest_file.partial" "$digest_file" || fail "can't write $digest_file"
  printf 'collector-%s %s\n' "$version" "$digest"
  exit 0
fi

# A builder named after a Docker context (desktop-linux) is that context's
# docker-driver builder: buildx 0.8.2 uses it only from that context
# ("use `docker --context=desktop-linux buildx`").
docker_cli=(docker)
if docker context inspect "$builder" >/dev/null 2>&1; then
  docker_cli=(docker --context "$builder")
fi

output="--load"
command_line=("${docker_cli[@]}" buildx --builder "$builder" build
  --platform "$platform" "${build_args[@]}" "${labels[@]}"
  --tag "$tag" "$output" "$CONTEXT")

if $dry_run; then
  # The script's own checks done: say what would run (stdout: the exact
  # command, one shell-quoted argument a line), run nothing.
  note "$(printf 'would build %s for %s through builder %s (%s)' "$tag" "$platform" "$builder" "$output")"
  printf '%q\n' "${command_line[@]}"
  exit 0
fi

# A local build: the builder must exist and use the docker driver (a
# docker-container builder would pull moby/buildkit to start).
driver="$("${docker_cli[@]}" buildx --builder "$builder" inspect 2>/dev/null | awk '/^Driver:/ { print $2; exit }' || true)"
[ -n "$driver" ] || fail "no buildx builder named '$builder' (set BUILDX_BUILDER to a docker-driver builder; this script never creates one)"
[ "$driver" = "docker" ] \
  || fail "builder '$builder' uses the '$driver' driver: a local build needs a 'docker'-driver builder (e.g. desktop-linux, or BUILDX_BUILDER)"

note "building $tag ($platform) through builder $builder"
set +e
"${command_line[@]}"
exit $?
