#!/usr/bin/env bash
# steps.sh: the release workflows' steps that are more than one call of
# another script (D36-2 decisions 77, 82, 84, 85, 87 and 103), so every `run:`
# of .github/workflows/release.yml and collector.yml stays one call of a
# committed script; scripts/release/rehearse.sh runs the same steps locally.
#
#   steps.sh free-disk <GB>
#       on a GitHub-hosted Linux runner, removes the runner's unused
#       toolchains (a fixed list: .NET, Android, GHC, CodeQL, Boost, Swift);
#       anywhere, then checks that the root's, the runner's temporary folder's
#       and Docker's file systems each have <GB> GB free, else exit 1 with a
#       plain message (Preflight ruling 7: build 14, smokes 13, kind 18)
#   steps.sh pull-images [--kind]
#       a GitHub-hosted Linux runner only: the third-party images the gates
#       and smokes need, each pulled by its pinned digest and tagged as the
#       repository's files name them: nginx (charts/telflo/values.yaml's
#       gateway digest) as nginx:1.27-alpine, the opamp-server
#       (vendor/opamp-server/PIN) as ghcr.io/telflo/opamp-server:<version>,
#       tools.lock's postgres as postgres:18 and mailpit as
#       axllent/mailpit:v1.31, and tools.lock's registry (load-images.sh's);
#       --kind adds tools.lock's kind node
#   steps.sh builder
#       creates the docker-container builder tools.lock names (telflo-release),
#       BuildKit at tools.lock's buildkit digest, in DOCKER_CONFIG, which must
#       hold tools.sh's checked buildx (scripts/release/tools.sh docker-config);
#       an existing builder of that name and driver is reused
#   steps.sh release-files --out <dir>
#       next to the Compose archive in <dir> (telflo-compose-<version>.tar.gz,
#       build-compose-archive.sh's): create-secrets.sh (HEAD's blob, 0755)
#       and SHA256SUMS (`<sha256>  <name>` for both, sorted); refuses either
#       existing
#   steps.sh collector-archive --out <dir> [--registry <r>]
#       the catalogue's default collector version's image index, as the
#       registry holds it (`crane pull --format oci` by its digest, every
#       platform and attestation), into <dir>/collector-<v>.oci.tar and
#       <dir>/collector-<v>.digest, the archive checked (oci.sh: both
#       platforms, the version label); prints the version, and appends
#       collector_version=<v> to $GITHUB_OUTPUT when that is set
#   steps.sh collector-versions <x.y.z|all> [--publish true|false] [--registry <r>]
#       the collector workflow's versions: <x.y.z> (offered by the catalogue)
#       or every offered one. With --publish true each tag is asked of the
#       registry (a published version is never pushed again; Ruling 399): an
#       explicit <x.y.z> already published is refused; `all` keeps the
#       offered versions not yet published (each published one named), and
#       when every one is published it prints a notice: nothing to build or
#       publish (exit 0); a registry that can't tell is refused. Prints the
#       JSON list (maybe []), and appends versions=<it> and has=true|false
#       (whether the list holds a version) to $GITHUB_OUTPUT when that is set
#   steps.sh collector-test --version <v>
#       the local ghcr.io/telflo/telflo/collector:<v> (load-images.sh's: the
#       engine's own platform, linux/amd64 on a runner) runs otelcol-contrib
#       --version (naming <v>) and the supervisor's -help (it has no version
#       flag: its usage must list -config); the supervisor-collector chart
#       renders that image and passes helm lint --strict with each role's
#       values and that tag
#   steps.sh chart-if-new --out <dir> [--registry <r>]
#       the supervisor-collector chart at HEAD's version: published already,
#       a notice and nothing pushed (a published version is never pushed
#       again); absent, publish-chart.sh --package <dir>, then --push-package
#       of that file; can't tell, refused
#   steps.sh stack-smoke --version <v> --work <dir> [--project <name>] [--port-base <n>]
#       the stack smoke in open-source mode on the release's images (local,
#       never pulled): scripts/gates/stack.sh up (--images release:<v> --site
#       oss), scripts/smoke-test-stack.sh with smoke-env.sh's settings, its
#       output through scripts/gates/redact.sh into <work>/stack-smoke.log
#       (and stdout), then stack.sh down whatever happened; a REDACTED line
#       fails it. The project is --project's (default telflo-release-smoke)
#   steps.sh archive-smoke --version <v> --release <dir> --work <dir> [--project <name>]
#                          [--http-port <p>] [--agent-port <p>] [--mailpit-port <p>]
#       the archive smoke (decision 98) on <release>'s telflo-compose-<v>.tar.gz
#       and SHA256SUMS: scripts/smoke-compose-install.sh --work <work>/smoke
#       (and the options given), its output through scripts/gates/redact.sh
#       into <work>/archive-smoke.log (and stdout)
#   steps.sh kind-smoke --version <v> --release <dir> --work <dir> [--profile <name>]
#                       [--port <p>] [--mailpit-port <p>] [--api-port <p>]
#       the kind smoke (decision 99) on the release's images (local, never
#       pulled) and <release>'s telflo-<v>.tgz: scripts/smoke-kind.sh --profile
#       <name> (default telflo-release-kind) --work <work>/smoke --images <v>
#       --chart <that file> (and the ports given), its output through
#       scripts/gates/redact.sh into <work>/kind-smoke.log (and stdout)
#     Both (decision 84, Ruling 408): every argument is checked against a
#     strict pattern first (a version x.y.z; folders absolute, of letters,
#     digits, '.', '_', '-' and '/', no `..`; <work> new or empty; a project
#     or profile name, never the owner's; ports 1000-65535), else refused
#     (exit 2) before the smoke starts. The exit code is the smoke's; a
#     REDACTED line in the log fails the step (exit 1 if the smoke passed).
#   steps.sh helm-login
#       a GitHub Actions runner only: helm registry login ghcr.io, the user
#       GHCR_USER, the token GHCR_TOKEN through standard input (never argv),
#       into HELM_REGISTRY_CONFIG (set, and under RUNNER_TEMP), then that
#       file checked (an "auths" object, no credential store or helper)
#   steps.sh github-release --tag <tag> --commit <sha> --oci <dir> --release <dir>
#       a GitHub Actions runner only (GITHUB_REPOSITORY telflo/telflo): the
#       release notes (release-notes.sh); then GitHub's API asked again
#       (scripts/release/github-tag.sh, verify-tag.sh's) that refs/tags/<tag>
#       is an annotated tag whose object is <sha>, the version job's commit
#       (Ruling 399: the tag wasn't moved during the run); then `gh release
#       create <tag> --verify-tag`, a normal release (never a draft, never a
#       prerelease), with <release>'s telflo-compose-<v>.tar.gz,
#       create-secrets.sh and SHA256SUMS, each checked against SHA256SUMS
#       first; a Release that exists already is refused. gh reads GH_TOKEN.
#
# Exit 0 done; 1 failed; 2 usage or refused. Registries: ghcr.io (the
# default) or a loopback 127.0.0.1:<port> or localhost:<port>. crane is
# tools.sh's (in a workflow only that one: oci.sh's rule); Docker and crane
# read the caller's DOCKER_CONFIG once checked, else a temporary one holding
# no login; nothing here logs in but helm-login. bash 3.2 compatible.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." >/dev/null && pwd)"
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
export GIT_NO_REPLACE_OBJECTS=1
# shellcheck source=scripts/release/version.sh
. "$ROOT/scripts/release/version.sh"
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"
# shellcheck source=scripts/release/github-tag.sh
. "$ROOT/scripts/release/github-tag.sh"

PROGRAM=steps
TOOLS="$ROOT/scripts/release/tools.sh"
CATALOGUE="$ROOT/catalog/distributions/otelcol-contrib.json"
COLLECTOR_REPOSITORY_PATH="telflo/telflo/collector"
SUPERVISOR_CHART="charts/supervisor-collector"
# The toolchains a GitHub-hosted Ubuntu runner carries that no step uses.
UNUSED_TOOLCHAINS="/usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL /usr/local/share/boost /usr/share/swift"

usage() {
  sed -n 's/^#   steps\.sh /usage: scripts\/release\/steps.sh /p' "$0" >&2
  exit 2
}
refuse() { echo "$PROGRAM: refused: $1" >&2; exit 2; }
fail() { echo "$PROGRAM: $1" >&2; exit 1; }
note() { echo "$PROGRAM: $1" >&2; }

on_actions() { [ "${GITHUB_ACTIONS:-}" = true ]; }
on_hosted_runner() {
  on_actions && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && [ "${RUNNER_OS:-}" = Linux ] && [ "$(uname -s)" = Linux ]
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/release-steps.XXXXXX")" || fail "no temporary directory"
[ -n "$tmp" ] && [ -d "$tmp" ] || fail "no temporary directory"
cleanup_steps() { rm -rf "$tmp"; }
trap cleanup_steps EXIT
TELFLO_OCI_PREFIX=$PROGRAM
TELFLO_OCI_TMP="$tmp"

registry_arg() { # <value>: sets registry
  telflo_registry_ok "$1" \
    || refuse "--registry must be ghcr.io or a loopback registry, 127.0.0.1:<port> or localhost:<port>"
  registry="$1"
}
out_dir_arg() { # <value>: sets out (an existing directory, absolute)
  [ -n "$1" ] && [ -d "$1" ] || refuse "--out must be an existing directory"
  out="$(CDPATH='' cd -- "$1" >/dev/null && pwd)"
}
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi; }
default_collector() {
  jq -r '[.versions[] | select(.default == true) | .version] | if length == 1 then .[0] else empty end' "$CATALOGUE" 2>/dev/null
}
offered_collectors() { "${BASH:-bash}" "$ROOT/scripts/build-collector-image.sh" --list-offered; }
github_output() { # <line>
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s\n' "$1" >>"$GITHUB_OUTPUT"; fi
}

# ---- free-disk -----------------------------------------------------------------------------
free_disk() {
  [ $# -eq 1 ] && [[ "$1" =~ ^[1-9][0-9]?$ ]] || refuse "free-disk takes the GB a job needs (1-99)"
  local need_kb=$(($1 * 1024 * 1024)) path free low=""
  if on_hosted_runner; then
    for path in $UNUSED_TOOLCHAINS; do
      [ -e "$path" ] || continue
      sudo rm -rf -- "$path" && note "removed $path" || note "couldn't remove $path"
    done
  else
    note "not a GitHub-hosted Linux runner: nothing removed, only checked"
  fi
  local paths="/ ${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  local docker_root
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || docker_root=""
  [ -z "$docker_root" ] || [ ! -d "$docker_root" ] || paths="$paths $docker_root"
  for path in $paths; do
    free="$(df -Pk "$path" 2>/dev/null | awk 'NR == 2 { print $4 }')"
    [[ "$free" =~ ^[0-9]+$ ]] || fail "couldn't read the free disk of $path"
    note "$path: $((free / 1024 / 1024)) GB free"
    [ "$free" -ge "$need_kb" ] || low="$low $path ($((free / 1024 / 1024)) GB)"
  done
  [ -z "$low" ] || fail "this job needs $1 GB free, and has less on:$low (a larger runner is the owner's choice)"
  note "at least $1 GB free"
}

# ---- pull-images ---------------------------------------------------------------------------
docker_stub() { # a DOCKER_CONFIG holding no login, for anonymous pulls
  mkdir -p "$tmp/docker"
  (umask 077 && printf '%s\n' '{"auths":{"telflo-release-steps.invalid":{}}}' >"$tmp/docker/config.json")
}
pull_tag() { # <repository> <digest> <tag ref>
  local by_digest="$1@$2"
  [[ "$2" =~ $TELFLO_OCI_DIGEST_RE ]] || fail "$1: no sha256 digest to pull by"
  DOCKER_CONFIG="$tmp/docker" docker pull -q "$by_digest" >/dev/null || fail "pulling $by_digest failed"
  DOCKER_CONFIG="$tmp/docker" docker tag "$by_digest" "$3" || fail "tagging $by_digest as $3 failed"
  note "$3 = $by_digest"
}
pull_images() {
  local kind=false
  case "${1:-}" in "") ;; --kind) kind=true; shift ;; *) refuse "pull-images takes --kind or nothing" ;; esac
  [ $# -eq 0 ] || refuse "pull-images takes --kind or nothing"
  on_hosted_runner || refuse "pull-images runs on a GitHub-hosted Linux runner only (it pulls images)"
  docker_stub
  local key nginx_digest opamp_version opamp_digest
  for key in registry postgres mailpit; do "${BASH:-bash}" "$TOOLS" pull "$key" >&2 || fail "tools.sh pull $key failed"; done
  if $kind; then "${BASH:-bash}" "$TOOLS" pull kind-node >&2 || fail "tools.sh pull kind-node failed"; fi
  DOCKER_CONFIG="$tmp/docker" docker tag "$("${BASH:-bash}" "$TOOLS" ref postgres)" postgres:18 || fail "tagging postgres failed"
  DOCKER_CONFIG="$tmp/docker" docker tag "$("${BASH:-bash}" "$TOOLS" ref mailpit)" axllent/mailpit:v1.31 || fail "tagging mailpit failed"
  nginx_digest="$(awk '/^gateway:/{g=1} g && /digest:/{print $2; exit}' "$ROOT/charts/telflo/values.yaml")"
  pull_tag nginx "$nginx_digest" nginx:1.27-alpine
  opamp_version="$(sed -n 's/^version=//p' "$ROOT/vendor/opamp-server/PIN")"
  opamp_digest="$(sed -n 's/^digest=//p' "$ROOT/vendor/opamp-server/PIN")"
  telflo_version_ok "$opamp_version" || fail "vendor/opamp-server/PIN's version isn't x.y.z"
  pull_tag ghcr.io/telflo/opamp-server "$opamp_digest" "ghcr.io/telflo/opamp-server:$opamp_version"
}

# ---- builder -------------------------------------------------------------------------------
builder() {
  [ $# -eq 0 ] || refuse "builder takes no argument"
  [ -n "${DOCKER_CONFIG:-}" ] || refuse "DOCKER_CONFIG must be set (scripts/release/tools.sh docker-config <dir>)"
  telflo_credentials DOCKER_CONFIG "$DOCKER_CONFIG/config.json" || exit 1
  local checked plugin name image driver
  checked="$("${BASH:-bash}" "$TOOLS" path buildx)" || fail "buildx isn't fetched and checked (scripts/release/tools.sh fetch buildx)"
  plugin="$DOCKER_CONFIG/cli-plugins/docker-buildx"
  [ -f "$plugin" ] && [ ! -L "$plugin" ] && [ "$(sha256_of "$plugin")" = "$(sha256_of "$checked")" ] \
    || fail "DOCKER_CONFIG's cli-plugins/docker-buildx isn't tools.sh's checked buildx (scripts/release/tools.sh docker-config <dir>)"
  name="$(awk '$1 == "builder" { print $2; exit }' "$ROOT/scripts/release/tools.lock")"
  [[ "$name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "tools.lock names no plain builder"
  image="$("${BASH:-bash}" "$TOOLS" ref buildkit)" || fail "tools.lock names no buildkit image"
  driver="$(docker buildx --builder "$name" inspect 2>/dev/null | awk '/^Driver:/ { print $2; exit }' || true)"
  if [ -n "$driver" ]; then
    [ "$driver" = docker-container ] || fail "a builder $name exists with the $driver driver, not docker-container"
    note "the builder $name exists (docker-container): reused"
  else
    docker buildx create --name "$name" --driver docker-container --driver-opt "image=$image" >/dev/null \
      || fail "docker buildx create $name failed"
    note "created the builder $name (BuildKit $image)"
  fi
  docker buildx --builder "$name" inspect --bootstrap >/dev/null || fail "the builder $name didn't start"
  echo "$name"
}

# ---- release-files -------------------------------------------------------------------------
release_files() {
  local out=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) [ $# -ge 2 ] || refuse "--out needs a folder"; out_dir_arg "$2"; shift 2 ;;
      *) refuse "release-files takes --out <dir>" ;;
    esac
  done
  [ -n "$out" ] || refuse "release-files needs --out <dir>"
  local archives archive name
  archives="$(cd "$out" && ls telflo-compose-*.tar.gz 2>/dev/null || true)"
  [ "$(printf '%s' "$archives" | grep -c '')" -eq 1 ] || fail "$out must hold exactly one telflo-compose-<version>.tar.gz (build-compose-archive.sh's)"
  name="$archives"
  [[ "$name" =~ ^telflo-compose-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.tar\.gz$ ]] || fail "$name isn't telflo-compose-<x.y.z>.tar.gz"
  archive="$out/$name"
  [ ! -e "$out/create-secrets.sh" ] && [ ! -e "$out/SHA256SUMS" ] || fail "$out holds create-secrets.sh or SHA256SUMS already: never overwritten"
  git -C "$ROOT" cat-file blob HEAD:scripts/create-secrets.sh >"$tmp/create-secrets.sh" || fail "HEAD has no scripts/create-secrets.sh"
  chmod 0755 "$tmp/create-secrets.sh"
  mv "$tmp/create-secrets.sh" "$out/create-secrets.sh"
  {
    printf '%s  %s\n' "$(sha256_of "$out/create-secrets.sh")" create-secrets.sh
    printf '%s  %s\n' "$(sha256_of "$archive")" "$name"
  } | LC_ALL=C sort -k 2 >"$tmp/SHA256SUMS"
  chmod 0644 "$tmp/SHA256SUMS"
  mv "$tmp/SHA256SUMS" "$out/SHA256SUMS"
  printf '%s\n' "$out/create-secrets.sh" "$out/SHA256SUMS"
}

# ---- collector-archive ---------------------------------------------------------------------
collector_archive() {
  local out="" registry=ghcr.io
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) [ $# -ge 2 ] || refuse "--out needs a folder"; out_dir_arg "$2"; shift 2 ;;
      --registry) [ $# -ge 2 ] || refuse "--registry needs a value"; registry_arg "$2"; shift 2 ;;
      *) refuse "collector-archive takes --out <dir> [--registry <r>]" ;;
    esac
  done
  [ -n "$out" ] || refuse "collector-archive needs --out <dir>"
  local version ref status=0 want base
  version="$(default_collector)"
  telflo_version_ok "$version" || fail "the catalogue names no one default collector version"
  offered_collectors | grep -qxF "$version" || fail "the catalogue's default collector $version isn't offered"
  base="$out/collector-$version"
  [ ! -e "$base.oci.tar" ] && [ ! -e "$base.digest" ] || fail "$base.oci.tar or .digest exists already: never overwritten"
  telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane"
  telflo_docker_config || exit 1
  ref="$registry/$COLLECTOR_REPOSITORY_PATH:$version"
  telflo_remote_digest "$ref" || status=$?
  case "$status" in
    0) want="$TELFLO_REMOTE_DIGEST" ;;
    3) fail "$ref is missing: run the collector workflow for $version" ;;
    *) fail "can't tell whether $ref exists: $TELFLO_REMOTE_ANSWER" ;;
  esac
  "$TELFLO_CRANE" pull --format oci "$registry/$COLLECTOR_REPOSITORY_PATH@$want" "$tmp/layout" >/dev/null 2>"$tmp/crane-pull.err" \
    || { tail -n 3 "$tmp/crane-pull.err" >&2; fail "crane pull of $ref@$want failed"; }
  [ -f "$tmp/layout/index.json" ] && [ -f "$tmp/layout/oci-layout" ] && [ -d "$tmp/layout/blobs/sha256" ] \
    || fail "crane pull wrote no OCI layout"
  (cd "$tmp/layout" && find . -mindepth 1 \( -type f -o -type d \) -print | sed 's#^\./##' | LC_ALL=C sort >"$tmp/members") \
    || fail "couldn't list the layout"
  (cd "$tmp/layout" && COPYFILE_DISABLE=1 tar --no-recursion -cf "$tmp/archive.oci.tar" -T "$tmp/members") || fail "couldn't write the archive"
  telflo_oci_inspect "$tmp/archive.oci.tar" "$want" "$version" "" >/dev/null || fail "$ref@$want: the archive refused"
  printf '%s\n' "$want" >"$tmp/archive.digest"
  mv "$tmp/archive.oci.tar" "$base.oci.tar"
  mv "$tmp/archive.digest" "$base.digest"
  note "$ref@$want into $base.oci.tar"
  printf '%s\n' "$version"
  github_output "collector_version=$version"
}

# ---- collector-versions --------------------------------------------------------------------
collector_versions() {
  local wanted="" publish=false registry=ghcr.io
  [ $# -ge 1 ] || refuse "collector-versions takes <x.y.z|all>"
  wanted="$1"; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --publish) [ $# -ge 2 ] || refuse "--publish needs true or false"
        case "$2" in true | false) publish="$2" ;; *) refuse "--publish takes true or false" ;; esac; shift 2 ;;
      --registry) [ $# -ge 2 ] || refuse "--registry needs a value"; registry_arg "$2"; shift 2 ;;
      *) refuse "collector-versions takes <x.y.z|all> [--publish true|false] [--registry <r>]" ;;
    esac
  done
  local offered versions version status problems=0 json absent="" published=0 has
  offered="$(offered_collectors)" || fail "the catalogue's offered versions couldn't be read"
  if [ "$wanted" = all ]; then
    versions="$offered"
  else
    telflo_version_ok "$wanted" || refuse "the collector version must be x.y.z or all"
    printf '%s\n' "$offered" | grep -qxF "$wanted" || fail "the catalogue doesn't offer the collector version $wanted"
    versions="$wanted"
  fi
  [ -n "$versions" ] || fail "no collector version to build"
  if [ "$publish" = true ]; then
    # A published version is never pushed again (Ruling 399): an explicit one
    # is refused; `all` keeps the absent ones. Can't tell: refused.
    telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane"
    telflo_docker_config || exit 1
    for version in $versions; do
      status=0
      telflo_remote_digest "$registry/$COLLECTOR_REPOSITORY_PATH:$version" || status=$?
      case "$status" in
        3) note "$registry/$COLLECTOR_REPOSITORY_PATH:$version: not published"
           absent="$absent$version"$'\n' ;;
        0) published=$((published + 1))
           if [ "$wanted" = all ]; then
             note "$registry/$COLLECTOR_REPOSITORY_PATH:$version is published already ($TELFLO_REMOTE_DIGEST): left out (never pushed again)"
           else
             echo "$PROGRAM: $registry/$COLLECTOR_REPOSITORY_PATH:$version is published already: never pushed again" >&2
             problems=$((problems + 1))
           fi ;;
        *) echo "$PROGRAM: can't tell whether $registry/$COLLECTOR_REPOSITORY_PATH:$version is published: $TELFLO_REMOTE_ANSWER" >&2
           problems=$((problems + 1)) ;;
      esac
    done
    [ "$problems" -eq 0 ] || fail "$problems collector version(s) published already or can't be told: nothing built"
    versions="$(printf '%s' "$absent" | sed '/^$/d')"
    if [ -z "$versions" ]; then
      note "notice: every collector version the catalogue offers is published already ($published): nothing to build or publish"
    fi
  fi
  if [ -n "$versions" ]; then
    json="[$(printf '%s\n' "$versions" | sed 's/.*/"&"/' | paste -sd, -)]"
    has=true
  else
    json="[]"
    has=false
  fi
  printf '%s\n' "$json"
  github_output "versions=$json"
  github_output "has=$has"
}

# ---- collector-test ------------------------------------------------------------------------
collector_test() {
  local version=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || refuse "--version needs a value"; version="$2"; shift 2 ;;
      *) refuse "collector-test takes --version <x.y.z>" ;;
    esac
  done
  telflo_version_ok "$version" || refuse "collector-test needs --version <x.y.z>"
  local image="ghcr.io/$COLLECTOR_REPOSITORY_PATH:$version" said role
  docker image inspect "$image" >/dev/null 2>&1 || fail "$image isn't in the local engine (scripts/release/load-images.sh --image collector)"
  # The loaded image is the engine's own platform (load-images.sh's default; linux/amd64 on a runner).
  said="$(docker run --rm --pull never --network none --entrypoint /app/otelcol-contrib "$image" --version 2>&1)" \
    || fail "$image: otelcol-contrib --version failed"
  printf '%s\n' "$said" | grep -qF "$version" || fail "$image: otelcol-contrib --version doesn't name $version"
  note "otelcol-contrib --version: $(printf '%s\n' "$said" | head -n 1)"
  # The OpAMP supervisor has no version flag (`--version` exits 2: "flag provided but not
  # defined"); its sha256 is checked at the build. Here: it starts and prints its usage.
  said="$(docker run --rm --pull never --network none --entrypoint /app/supervisor "$image" -help 2>&1)" \
    || fail "$image: the supervisor's -help failed"
  printf '%s\n' "$said" | grep -qE '^[[:space:]]*-config( |$)' || fail "$image: the supervisor's -help doesn't list -config"
  note "supervisor -help: it starts and lists -config"
  command -v helm >/dev/null 2>&1 || fail "helm is not on PATH"
  mkdir -p "$tmp/helm" "$tmp/values"
  for v in $(env | sed -n 's/^\(HELM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
  export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"
  for role in node cluster gateway; do
    {
      printf 'role: %s\ngroup: %s\ntoken: release-test-placeholder\n' "$role" "$([ "$role" = gateway ] && echo gw-test || echo "$role")"
      printf 'endpoint: https://release-test.invalid/opamp/v1\ncollectorGroupId: 00000000-0000-4000-8000-000000000000\n'
      printf 'image:\n  tag: "%s"\n' "$version"
    } >"$tmp/values/$role.yaml"
    helm lint --strict "$ROOT/$SUPERVISOR_CHART" -f "$tmp/values/$role.yaml" >"$tmp/lint.log" 2>&1 \
      || { tail -n 20 "$tmp/lint.log" >&2; fail "helm lint --strict ($role, image tag $version) failed"; }
    helm template release-test "$ROOT/$SUPERVISOR_CHART" -f "$tmp/values/$role.yaml" >"$tmp/render.yaml" 2>"$tmp/render.err" \
      || { tail -n 20 "$tmp/render.err" >&2; fail "helm template ($role) failed"; }
    grep -qE "image: \"?$image\"?$" "$tmp/render.yaml" || fail "the chart's $role render doesn't run $image"
  done
  note "$image: both binaries answer; the chart lints and renders it for node, cluster and gateway"
}

# ---- chart-if-new --------------------------------------------------------------------------
chart_if_new() {
  local out="" registry=ghcr.io
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) [ $# -ge 2 ] || refuse "--out needs a folder"; out_dir_arg "$2"; shift 2 ;;
      --registry) [ $# -ge 2 ] || refuse "--registry needs a value"; registry_arg "$2"; shift 2 ;;
      *) refuse "chart-if-new takes --out <dir> [--registry <r>]" ;;
    esac
  done
  [ -n "$out" ] || refuse "chart-if-new needs --out <dir>"
  local version ref status=0 package
  git -C "$ROOT" cat-file blob "HEAD:$SUPERVISOR_CHART/Chart.yaml" >"$tmp/Chart.yaml" || fail "HEAD has no $SUPERVISOR_CHART/Chart.yaml"
  version="$(telflo_chart_field "$tmp/Chart.yaml" version)" || version=""
  telflo_version_ok "$version" || fail "$SUPERVISOR_CHART/Chart.yaml's version isn't x.y.z"
  telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane"
  telflo_docker_config || exit 1
  ref="$registry/telflo/telflo/charts/supervisor-collector:$version"
  telflo_remote_digest "$ref" || status=$?
  case "$status" in
    0) note "notice: $ref is published already ($TELFLO_REMOTE_DIGEST): a published chart version is never pushed again"
       return 0 ;;
    3) ;;
    *) fail "can't tell whether $ref is published: $TELFLO_REMOTE_ANSWER" ;;
  esac
  package="$("${BASH:-bash}" "$ROOT/scripts/publish-chart.sh" --chart supervisor-collector --package "$out" | awk 'NF { p = $1 } END { print p }')" \
    || fail "publish-chart.sh --package failed"
  [ -f "$package" ] || fail "publish-chart.sh --package wrote no package"
  "${BASH:-bash}" "$ROOT/scripts/publish-chart.sh" --chart supervisor-collector --push-package "$package" --registry "$registry" \
    || fail "publish-chart.sh --push-package failed"
}

# ---- stack-smoke ---------------------------------------------------------------------------
logged() { # <log> <command...>: its output through redact.sh into <log> and stdout; its status
  # (the command's; 1 if it passed but redact.sh or tee failed: the log may be missing lines)
  local log="$1" codes
  shift
  set +e
  "$@" 2>&1 | "${BASH:-bash}" "$ROOT/scripts/gates/redact.sh" | tee "$log"
  codes=("${PIPESTATUS[@]}")
  set -e
  [ "${codes[0]}" -eq 0 ] || return "${codes[0]}"
  [ "${codes[1]}" -eq 0 ] && [ "${codes[2]}" -eq 0 ] || { note "redact.sh or tee failed: the log $log may be incomplete"; return 1; }
}
stack_smoke() {
  local version="" work="" project=telflo-release-smoke port_base=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || refuse "--version needs a value"; version="$2"; shift 2 ;;
      --work) [ $# -ge 2 ] || refuse "--work needs a folder"; work="$2"; shift 2 ;;
      --project) [ $# -ge 2 ] || refuse "--project needs a name"; project="$2"; shift 2 ;;
      --port-base) [ $# -ge 2 ] || refuse "--port-base needs a number"; port_base="$2"; shift 2 ;;
      *) refuse "stack-smoke takes --version <v> --work <dir> [--project <name>] [--port-base <n>]" ;;
    esac
  done
  telflo_version_ok "$version" || refuse "stack-smoke needs --version <x.y.z>"
  case "$work" in /*) ;; *) refuse "--work must be an absolute path" ;; esac
  [ ! -e "$work" ] || [ -z "$(ls -A "$work" 2>/dev/null)" ] || refuse "--work $work isn't empty: use a new folder"
  case "$project" in telflo | telflo-dev | telflo-platform) refuse "the project $project is never a smoke's" ;; esac
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || refuse "--project must be a plain Compose project name"
  [ -z "$port_base" ] || [[ "$port_base" =~ ^[1-9][0-9]{3,4}$ ]] || refuse "--port-base must be a port number"
  mkdir -p "$work"
  local stack=(--project "$project" --work "$work/stack")
  local up_args=("${stack[@]}" --images "release:$version" --site oss)
  [ -z "$port_base" ] || up_args+=(--port-base "$port_base")
  local status=0 down=0 redacted
  if logged "$work/stack-up.log" "${BASH:-bash}" "$ROOT/scripts/gates/stack.sh" up "${up_args[@]}"; then
    # shellcheck disable=SC2016 # expanded by the inner shell
    logged "$work/stack-smoke.log" "${BASH:-bash}" -c '. "$1/scripts/gates/smoke-env.sh" oss "$2" && exec "${BASH:-bash}" "$1/scripts/smoke-test-stack.sh"' \
      _ "$ROOT" "$work/stack" || status=1
  else
    status=1
    note "stack.sh up failed: the smoke didn't run"
  fi
  logged "$work/stack-down.log" "${BASH:-bash}" "$ROOT/scripts/gates/stack.sh" down "${stack[@]}" || down=1
  redacted="$(cat "$work"/stack-*.log 2>/dev/null | grep -c REDACTED || true)"
  # Worded without redact.sh's marker, so a caller counting the marker in this output counts only real hits.
  note "secret-shaped lines in the logs: $redacted"
  [ "$redacted" -eq 0 ] || fail "secret-shaped text reached the smoke's output ($redacted lines): look at what printed it"
  [ "$down" -eq 0 ] || fail "stack.sh down failed: something of $project may be left"
  [ "$status" -eq 0 ] || fail "the stack smoke (oss) failed"
  note "the stack smoke (oss) passed on the release's images $version"
}

# ---- archive-smoke, kind-smoke -------------------------------------------------------------
SMOKE_PATH_RE='^/[A-Za-z0-9._/-]+$'
smoke_folder_ok() { # <value>: absolute, plain characters, no `..` component
  [[ "$1" =~ $SMOKE_PATH_RE ]] && ! [[ "/$1/" =~ /\.\./ ]]
}
smoke_port_arg() { # <option> <value>
  [[ "$2" =~ ^[1-9][0-9]{3,4}$ ]] && [ "$2" -le 65535 ] || refuse "$1 must be a port number from 1000 to 65535"
}
smoke_common_args() { # <step> <version> <release> <work>: refuses a bad one
  telflo_version_ok "$2" || refuse "$1 needs --version <x.y.z>"
  smoke_folder_ok "$3" || refuse "--release must be an absolute path of letters, digits, '.', '_', '-' and '/' (no ..)"
  [ -d "$3" ] && [ ! -L "$3" ] || refuse "--release must be an existing folder (the package job's files)"
  smoke_folder_ok "$4" || refuse "--work must be an absolute path of letters, digits, '.', '_', '-' and '/' (no ..)"
  [ ! -L "$4" ] || refuse "--work must not be a link"
  [ ! -e "$4" ] || { [ -d "$4" ] && [ -z "$(ls -A "$4" 2>/dev/null)" ]; } || refuse "--work $4 isn't a new or empty folder"
}
# smoke_redacted <label> <log> <command...>: the smoke's output through redact.sh into <log> (and stdout);
# its exit code kept; a REDACTED line in <log> fails the step (exit 1 when the smoke itself passed).
smoke_redacted() {
  local label="$1" log="$2" status=0 redacted
  shift 2
  logged "$log" "$@" || status=$?
  redacted="$(grep -c REDACTED "$log" 2>/dev/null || true)"
  [ -n "$redacted" ] || redacted=0
  # Worded without redact.sh's marker, so a caller counting the marker in this output counts only real hits.
  note "secret-shaped lines in the $label's output: $redacted"
  if [ "$redacted" -ne 0 ]; then
    echo "$PROGRAM: secret-shaped text reached the $label's output ($redacted lines): look at what printed it" >&2
    [ "$status" -ne 0 ] || status=1
  fi
  [ "$status" -eq 0 ] || { note "the $label failed (exit $status)"; return "$status"; }
  note "the $label passed"
}
archive_smoke() {
  local version="" release="" work="" opts=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || refuse "--version needs a value"; version="$2"; shift 2 ;;
      --release) [ $# -ge 2 ] || refuse "--release needs a folder"; release="$2"; shift 2 ;;
      --work) [ $# -ge 2 ] || refuse "--work needs a folder"; work="$2"; shift 2 ;;
      --project) [ $# -ge 2 ] || refuse "--project needs a name"
        case "$2" in telflo | telflo-dev | telflo-platform) refuse "the project $2 is never a smoke's" ;; esac
        [[ "$2" =~ ^[a-z0-9][a-z0-9_-]{0,40}$ ]] || refuse "--project must be a plain Compose project name"
        opts+=(--project "$2"); shift 2 ;;
      --http-port | --agent-port | --mailpit-port) [ $# -ge 2 ] || refuse "$1 needs a port"
        smoke_port_arg "$1" "$2"; opts+=("$1" "$2"); shift 2 ;;
      *) refuse "archive-smoke takes --version <v> --release <dir> --work <dir> [--project <name>] [--http-port <p>] [--agent-port <p>] [--mailpit-port <p>]" ;;
    esac
  done
  smoke_common_args archive-smoke "$version" "$release" "$work"
  local archive="$release/telflo-compose-$version.tar.gz" sums="$release/SHA256SUMS"
  [ -f "$archive" ] && [ -f "$sums" ] || refuse "--release must hold telflo-compose-$version.tar.gz and SHA256SUMS"
  (umask 077 && mkdir -p "$work")
  smoke_redacted "archive smoke" "$work/archive-smoke.log" \
    "${BASH:-bash}" "$ROOT/scripts/smoke-compose-install.sh" --archive "$archive" --sums "$sums" --work "$work/smoke" ${opts[@]+"${opts[@]}"}
}
kind_smoke() {
  local version="" release="" work="" profile=telflo-release-kind opts=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || refuse "--version needs a value"; version="$2"; shift 2 ;;
      --release) [ $# -ge 2 ] || refuse "--release needs a folder"; release="$2"; shift 2 ;;
      --work) [ $# -ge 2 ] || refuse "--work needs a folder"; work="$2"; shift 2 ;;
      --profile) [ $# -ge 2 ] || refuse "--profile needs a name"; profile="$2"; shift 2 ;;
      --port | --mailpit-port | --api-port) [ $# -ge 2 ] || refuse "$1 needs a port"
        smoke_port_arg "$1" "$2"; opts+=("$1" "$2"); shift 2 ;;
      *) refuse "kind-smoke takes --version <v> --release <dir> --work <dir> [--profile <name>] [--port <p>] [--mailpit-port <p>] [--api-port <p>]" ;;
    esac
  done
  [[ "$profile" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]] && [ "$profile" != kind ] \
    || refuse "--profile must be a throwaway kind cluster's name (never kind's own default, kind)"
  smoke_common_args kind-smoke "$version" "$release" "$work"
  local chart="$release/telflo-$version.tgz"
  [ -f "$chart" ] || refuse "--release must hold telflo-$version.tgz"
  (umask 077 && mkdir -p "$work")
  smoke_redacted "kind smoke" "$work/kind-smoke.log" \
    "${BASH:-bash}" "$ROOT/scripts/smoke-kind.sh" --profile "$profile" --work "$work/smoke" --images "$version" --chart "$chart" ${opts[@]+"${opts[@]}"}
}

# ---- helm-login ----------------------------------------------------------------------------
helm_login() {
  [ $# -eq 0 ] || refuse "helm-login takes no argument"
  on_actions || refuse "helm-login runs in a GitHub Actions job only"
  [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ] || refuse "GHCR_USER and GHCR_TOKEN must be set (the job's github.actor and GITHUB_TOKEN)"
  local user_re='^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$'
  [[ "$GHCR_USER" =~ $user_re ]] || refuse "GHCR_USER isn't a GitHub user name"
  local config="${HELM_REGISTRY_CONFIG:-}" under="${RUNNER_TEMP:-}"
  [ -n "$config" ] && [ -n "$under" ] || refuse "HELM_REGISTRY_CONFIG and RUNNER_TEMP must be set"
  case "$config" in "$under"/*) ;; *) refuse "HELM_REGISTRY_CONFIG must be under RUNNER_TEMP (never the runner's home)" ;; esac
  command -v helm >/dev/null 2>&1 || fail "helm is not on PATH"
  mkdir -p "$(dirname "$config")"
  printf '%s' "$GHCR_TOKEN" | helm registry login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null 2>"$tmp/helm-login.err" \
    || { sed -n '1,3p' "$tmp/helm-login.err" | cut -c1-200 >&2; fail "helm registry login ghcr.io failed"; }
  telflo_credentials HELM_REGISTRY_CONFIG "$config" || fail "helm registry login wrote a configuration the publish scripts refuse"
  note "helm: logged in to ghcr.io in HELM_REGISTRY_CONFIG"
}

# ---- github-release ------------------------------------------------------------------------
github_release() {
  local tag="" commit="" oci="" release=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag) [ $# -ge 2 ] || refuse "--tag needs a value"; tag="$2"; shift 2 ;;
      --commit) [ $# -ge 2 ] || refuse "--commit needs a value"; commit="$2"; shift 2 ;;
      --oci) [ $# -ge 2 ] || refuse "--oci needs a folder"; oci="$2"; shift 2 ;;
      --release) [ $# -ge 2 ] || refuse "--release needs a folder"; release="$2"; shift 2 ;;
      *) refuse "github-release takes --tag <tag> --commit <sha> --oci <dir> --release <dir>" ;;
    esac
  done
  on_actions || refuse "github-release runs in a GitHub Actions job only (a rehearsal never makes a GitHub Release)"
  [ "${GITHUB_REPOSITORY:-}" = telflo/telflo ] || refuse "github-release makes telflo/telflo's Releases only"
  local version="${tag#v}"
  case "$tag" in v*) ;; *) version="" ;; esac
  telflo_version_ok "$version" || refuse "--tag must be v<x.y.z>"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || refuse "--commit must be the version job's commit, 40 hex"
  [ -d "$oci" ] && [ -d "$release" ] || refuse "--oci and --release must be existing folders"
  [ -n "${GH_TOKEN:-}" ] || refuse "GH_TOKEN must be set (the job's GITHUB_TOKEN)"
  command -v gh >/dev/null 2>&1 || fail "gh is not on PATH"
  local chart="$release/telflo-$version.tgz" archive="telflo-compose-$version.tar.gz" name want
  [ -f "$chart" ] || fail "$chart is missing"
  for name in "$archive" create-secrets.sh SHA256SUMS; do [ -f "$release/$name" ] || fail "$release/$name is missing"; done
  [ "$(grep -c '' "$release/SHA256SUMS")" -eq 2 ] || fail "SHA256SUMS must list exactly the archive and create-secrets.sh"
  for name in "$archive" create-secrets.sh; do
    want="$(awk -v n="$name" '$2 == n { print $1 }' "$release/SHA256SUMS")"
    [ -n "$want" ] && [ "$want" = "$(sha256_of "$release/$name")" ] || fail "$name doesn't match SHA256SUMS"
  done
  "${BASH:-bash}" "$ROOT/scripts/release/release-notes.sh" --oci "$oci" --chart "$chart" --version "$version" >"$tmp/notes.md" \
    || fail "release-notes.sh failed"
  # The tag, asked of GitHub again: still the annotated tag of the commit the run checked and built.
  telflo_github_tag_object "$GITHUB_REPOSITORY" "$tag" "$commit" "the version job's" "$tmp" \
    || fail "$TELFLO_GITHUB_PROBLEM: no Release made"
  note "$tag on GitHub is still the annotated tag $TELFLO_GITHUB_TAG_OBJECT of $commit"
  if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    fail "the GitHub Release $tag exists already (a draft left by a failed upload?): it is never made twice; delete it, then re-run"
  fi
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "Telflo $version" --notes-file "$tmp/notes.md" \
    "$release/$archive" "$release/create-secrets.sh" "$release/SHA256SUMS" >/dev/null \
    || fail "gh release create $tag failed"
  note "the GitHub Release $tag: $archive, create-secrets.sh, SHA256SUMS"
}

action="${1:-}"
[ -n "$action" ] || usage
shift
case "$action" in
  free-disk) free_disk "$@" ;;
  pull-images) pull_images "$@" ;;
  builder) builder "$@" ;;
  release-files) release_files "$@" ;;
  collector-archive) collector_archive "$@" ;;
  collector-versions) collector_versions "$@" ;;
  collector-test) collector_test "$@" ;;
  chart-if-new) chart_if_new "$@" ;;
  stack-smoke) stack_smoke "$@" ;;
  archive-smoke) archive_smoke "$@" ;;
  kind-smoke) kind_smoke "$@" ;;
  helm-login) helm_login "$@" ;;
  github-release) github_release "$@" ;;
  -h | --help) usage ;;
  *) usage ;;
esac
