#!/usr/bin/env bash
# steps.sh: the release workflows' steps that are more than one call of
# another script, so every `run:` of .github/workflows/release.yml,
# finalize.yml and collector.yml stays one call of a committed script;
# scripts/release/rehearse.sh runs the same steps locally, and abandon-stage
# is the owner's, on their own machine.
#
#   steps.sh free-disk <GB>
#       on a GitHub-hosted Linux runner, removes the runner's unused
#       toolchains (a fixed list: .NET, Android, GHC, CodeQL, Boost, Swift);
#       anywhere, then checks that the root's, the runner's temporary folder's
#       and Docker's file systems each have <GB> GB free, else exit 1 with a
#       plain message (the jobs' needs: build 14, smokes 13, kind 18)
#   steps.sh pull-images [--kind]
#       a GitHub-hosted Linux runner only: the third-party images the gates
#       and smokes need, each pulled by its pinned digest and tagged as the
#       repository's files name them: nginx (charts/telflo/values.yaml's
#       gateway digest) as nginx:1.30-alpine, the opamp-server
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
#       the catalog's default collector version's image index, as the
#       registry holds it (`crane pull --format oci` by its digest, every
#       platform and attestation), into <dir>/collector-<v>.oci.tar and
#       <dir>/collector-<v>.digest, the archive checked (oci.sh: both
#       platforms, the version label); prints the version, and appends
#       collector_version=<v> to $GITHUB_OUTPUT when that is set
#   steps.sh collector-versions <x.y.z|all> [--publish true|false] [--registry <r>]
#       the collector workflow's versions: <x.y.z> (offered by the catalog)
#       or every offered one. With --publish true each tag is asked of the
#       registry (a published version is never pushed again): an explicit
#       <x.y.z> already published is refused; `all` keeps the
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
#       the archive smoke on <release>'s telflo-compose-<v>.tar.gz
#       and SHA256SUMS: scripts/smoke-compose-install.sh --work <work>/smoke
#       (and the options given), its output through scripts/gates/redact.sh
#       into <work>/archive-smoke.log (and stdout)
#   steps.sh kind-smoke --version <v> --release <dir> --work <dir> [--profile <name>]
#                       [--port <p>] [--mailpit-port <p>] [--api-port <p>]
#       the kind smoke on the release's images (local, never pulled) and
#       <release>'s telflo-<v>.tgz: scripts/smoke-kind.sh --profile <name>
#       (default telflo-release-kind) --work <work>/smoke --images <v>
#       --chart <that file> (and the ports given), its output through
#       scripts/gates/redact.sh into <work>/kind-smoke.log (and stdout)
#     Both: every argument is checked against a strict pattern first (a
#     version x.y.z; folders absolute, of letters, digits, '.', '_', '-' and
#     '/', no `..`; <work> new or empty; a project or profile name, never a
#     developer's own stack's; ports 1000-65535), else refused (exit 2)
#     before the smoke starts. The exit code is the smoke's; a
#     REDACTED line in the log fails the step (exit 1 if the smoke passed).
#   steps.sh helm-login
#       a GitHub Actions runner only: helm registry login ghcr.io, the user
#       GHCR_USER, the token GHCR_TOKEN through standard input (never argv),
#       into HELM_REGISTRY_CONFIG (set, and under RUNNER_TEMP), then that
#       file checked (an "auths" object, no credential store or helper)
#   steps.sh digests --oci <dir> --version <v> --chart <tgz> --out <file> [--registry <r>]
#       the stage's record, digests.txt, after the stage's pushes: each
#       image's index digest (<dir>/<name>.digest), then the chart's OCI
#       manifest digest as <registry>/telflo/telflo-staging/charts/telflo:<v>
#       answers it (`crane digest`; that manifest's one chart layer must be
#       the package's sha256) and the package's sha256, one
#       `<name> sha256:<hex>` line each, in oci.sh's fixed order (the five
#       images sorted, then charts/telflo and charts/telflo.tgz); <file> must
#       not exist (never overwritten). The finalize workflow copies exactly
#       these digests to the public namespace (promote.sh)
#   steps.sh github-release [--draft] --tag <tag> --commit <sha> --oci <dir> --release <dir>
#       a GitHub Actions runner only (GITHUB_REPOSITORY telflo/telflo): the
#       release notes (release-notes.sh, naming the public references the
#       Release will have); then GitHub's API asked again
#       (scripts/release/github-tag.sh, verify-tag.sh's) that refs/tags/<tag>
#       is an annotated tag whose object is <sha>, the version job's commit
#       (the tag wasn't moved during the run); then `gh release create <tag>
#       --verify-tag`, never a prerelease, with <release>'s
#       telflo-compose-<v>.tar.gz, create-secrets.sh and SHA256SUMS, each
#       checked against SHA256SUMS first. With --draft (the release
#       workflow's: a stage, which the finalize workflow publishes) it is a
#       draft, and holds <release>/digests.txt too, which must be a stage's
#       record whose lines are <oci>'s digest files and the chart package's
#       sha256; without, a published release. A Release that exists already
#       is refused. gh reads GH_TOKEN.
#   steps.sh finalize-check --version <v> --out <dir>
#       a GitHub Actions runner only (GITHUB_REPOSITORY telflo/telflo), from
#       a full-history checkout: refs/tags/v<v> is there, its commit on main
#       (refs/remotes/origin/main) with charts/telflo/Chart.yaml's version and
#       appVersion <v>; GitHub's API answers it as the annotated tag of that
#       commit (github-tag.sh); the GitHub Release v<v> is a draft holding
#       digests.txt, which is downloaded into <dir>/digests.txt (never
#       overwritten) and must be a stage's record. Prints its path. gh reads
#       GH_TOKEN
#   steps.sh finalize-publish --version <v> --digests <file>
#       a GitHub Actions runner only, after the promote: the tag checked as
#       finalize-check checks it; the GitHub Release v<v> still a draft whose
#       digests.txt is <file>'s bytes (the record that was promoted); then
#       `gh release edit v<v> --draft=false --latest=<true|false>`: true
#       unless the Release marked latest names a higher version (a patch of
#       an older line keeps the newest line latest); then it must answer as
#       published. gh reads GH_TOKEN
#   steps.sh abandon-stage --version <v> [--dry-run]
#       the owner's, on their own machine with their gh login (never in a
#       GitHub Actions job): a stage that won't be finalized, removed so the
#       version can be tagged again. Refused (exit 1), nothing deleted, when
#       anything of <v> is public: a version of ghcr.io/telflo/telflo/<name>
#       or charts/telflo tagged <v>, or a published GitHub Release v<v>. Then
#       it deletes, in the organization's packages, each
#       telflo-staging/<name> and telflo-staging/charts/telflo version tagged
#       <v> (refused if that version holds another tag), with any version
#       tagged sha256-<its digest's hex> (crane's referrers fallback beside
#       it), and the draft Release v<v> (never its tag: deleting the tag is
#       the owner's next step, docs/releasing.md). --dry-run lists them and
#       deletes nothing. gh's token needs read:packages and delete:packages
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
  [ $# -eq 1 ] && [[ "$1" =~ ^[1-9][0-9]{0,3}$ ]] || refuse "free-disk takes the GB a job needs (1-9999)"
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
  [ -z "$low" ] || fail "this job needs $1 GB free, and has less on:$low (a larger runner is the maintainers' choice)"
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
  pull_tag nginx "$nginx_digest" nginx:1.30-alpine
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
    # A published version is never pushed again: an explicit one is refused; `all` keeps the absent ones. Can't tell: refused.
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
  local tag="" commit="" oci="" release="" draft=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --draft) draft=true; shift ;;
      --tag) [ $# -ge 2 ] || refuse "--tag needs a value"; tag="$2"; shift 2 ;;
      --commit) [ $# -ge 2 ] || refuse "--commit needs a value"; commit="$2"; shift 2 ;;
      --oci) [ $# -ge 2 ] || refuse "--oci needs a folder"; oci="$2"; shift 2 ;;
      --release) [ $# -ge 2 ] || refuse "--release needs a folder"; release="$2"; shift 2 ;;
      *) refuse "github-release takes [--draft] --tag <tag> --commit <sha> --oci <dir> --release <dir>" ;;
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
  local flags=() files=("$release/$archive" "$release/create-secrets.sh" "$release/SHA256SUMS") image
  if $draft; then
    # The stage's record: the digests the finalize workflow promotes, the ones this run tested.
    telflo_digests_ok "$release/digests.txt" || fail "$release/digests.txt is missing or isn't a stage's record (steps.sh digests writes it)"
    for image in $(record_images); do
      [ "$(telflo_digests_get "$release/digests.txt" "$image")" = "$(cat "$oci/$image.digest" 2>/dev/null)" ] \
        || fail "digests.txt's $image isn't $oci/$image.digest: it isn't this run's stage"
    done
    [ "$(telflo_digests_get "$release/digests.txt" charts/telflo.tgz)" = "sha256:$(sha256_of "$chart")" ] \
      || fail "digests.txt's charts/telflo.tgz isn't $chart's sha256: it isn't this run's stage"
    flags=(--draft)
    files+=("$release/digests.txt")
  fi
  "${BASH:-bash}" "$ROOT/scripts/release/release-notes.sh" --oci "$oci" --chart "$chart" --version "$version" >"$tmp/notes.md" \
    || fail "release-notes.sh failed"
  # The tag, asked of GitHub again: still the annotated tag of the commit the run checked and built.
  telflo_github_tag_object "$GITHUB_REPOSITORY" "$tag" "$commit" "the version job's" "$tmp" \
    || fail "$TELFLO_GITHUB_PROBLEM: no Release made"
  note "$tag on GitHub is still the annotated tag $TELFLO_GITHUB_TAG_OBJECT of $commit"
  if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    fail "the GitHub Release $tag exists already (a draft left by a failed upload?): it is never made twice; delete it, then re-run"
  fi
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag ${flags[@]+"${flags[@]}"} --title "Telflo $version" --notes-file "$tmp/notes.md" \
    "${files[@]}" >/dev/null \
    || fail "gh release create $tag failed"
  if $draft; then
    note "the draft GitHub Release $tag: $archive, create-secrets.sh, SHA256SUMS, digests.txt (the finalize workflow publishes it)"
  else
    note "the GitHub Release $tag: $archive, create-secrets.sh, SHA256SUMS"
  fi
}

# ---- digests -------------------------------------------------------------------------------
CHART_LAYER_TYPE="application/vnd.cncf.helm.chart.content.v1.tar+gzip"
CHART_CONFIG_TYPE="application/vnd.cncf.helm.config.v1+json"
# chart_layer_of <manifest file>: a Helm chart's one content layer digest, or nothing.
chart_layer_of() {
  python3 -I - "$1" "$CHART_CONFIG_TYPE" "$CHART_LAYER_TYPE" 2>/dev/null <<'PY' || true
import json, re, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
if (manifest.get("config") or {}).get("mediaType") != sys.argv[2]:
    sys.exit(0)
layers = [l for l in manifest.get("layers") or [] if isinstance(l, dict) and l.get("mediaType") == sys.argv[3]]
if len(layers) == 1 and re.fullmatch(r"sha256:[0-9a-f]{64}", str(layers[0].get("digest"))):
    print(layers[0]["digest"])
PY
}
# The five images of a stage's record (its names but the chart's two).
record_images() { tr ' ' '\n' <<<"$TELFLO_DIGESTS_NAMES" | grep -v '^charts/'; }
digests() {
  local oci="" version="" chart="" file="" registry=ghcr.io
  while [ $# -gt 0 ]; do
    case "$1" in
      --oci) [ $# -ge 2 ] || refuse "--oci needs a folder"; oci="$2"; shift 2 ;;
      --version) [ $# -ge 2 ] || refuse "--version needs a value"; version="$2"; shift 2 ;;
      --chart) [ $# -ge 2 ] || refuse "--chart needs a package"; chart="$2"; shift 2 ;;
      --out) [ $# -ge 2 ] || refuse "--out needs a file"; file="$2"; shift 2 ;;
      --registry) [ $# -ge 2 ] || refuse "--registry needs a value"; registry_arg "$2"; shift 2 ;;
      *) refuse "digests takes --oci <dir> --version <v> --chart <tgz> --out <file> [--registry <r>]" ;;
    esac
  done
  [ -n "$oci" ] && [ -d "$oci" ] || refuse "--oci must be an existing folder (the images' digest files)"
  telflo_version_ok "$version" || refuse "digests needs --version <x.y.z>"
  [ -n "$chart" ] && [ -f "$chart" ] || refuse "--chart must be the chart's package (telflo-<v>.tgz)"
  [ -n "$file" ] && [ -d "$(dirname -- "$file")" ] || refuse "--out must be a file in an existing folder"
  [ ! -e "$file" ] || fail "$file exists already: never overwritten"
  local name f lines="" ref status want layer package
  for name in $(record_images); do
    f="$oci/$name.digest"
    [ -f "$f" ] && [ "$(grep -c '' "$f")" -eq 1 ] && [[ "$(cat "$f")" =~ $TELFLO_OCI_DIGEST_RE ]] \
      || fail "$f is missing or isn't one line sha256:<64 hex>"
    lines="$lines$name $(cat "$f")"$'\n'
  done
  package="sha256:$(sha256_of "$chart")"
  telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane"
  telflo_docker_config || exit 1
  ref="$registry/$(telflo_namespace_path telflo-staging)/charts/telflo"
  status=0
  telflo_remote_digest "$ref:$version" || status=$?
  case "$status" in
    0) want="$TELFLO_REMOTE_DIGEST" ;;
    3) fail "$ref:$version is missing: the chart isn't staged" ;;
    *) fail "can't tell whether $ref:$version is staged: $TELFLO_REMOTE_ANSWER" ;;
  esac
  status=0
  telflo_remote_manifest "$ref@$want" "$tmp/chart.json" || status=$?
  [ "$status" -eq 0 ] || fail "$ref@$want can't be read: $TELFLO_REMOTE_ANSWER"
  layer="$(chart_layer_of "$tmp/chart.json")"
  [ "$layer" = "$package" ] || fail "$ref:$version's chart layer is ${layer:-none}, not $chart's sha256 $package"
  lines="${lines}charts/telflo $want"$'\n'"charts/telflo.tgz $package"$'\n'
  printf '%s' "$lines" >"$tmp/digests.txt"
  telflo_digests_ok "$tmp/digests.txt" || fail "the record came out malformed"
  cp "$tmp/digests.txt" "$file.partial" && mv "$file.partial" "$file" || fail "can't write $file"
  note "the stage's record: $file (the five images, then $ref:$version $want and its package $package)"
  printf '%s\n' "$file"
}

# ---- finalize-check, finalize-publish -------------------------------------------------------
finalize_env() { # <step>
  on_actions || refuse "$1 runs in a GitHub Actions job only (the finalize workflow)"
  [ "${GITHUB_REPOSITORY:-}" = telflo/telflo ] || refuse "$1 finalizes telflo/telflo's Releases only"
  [ -n "${GH_TOKEN:-}" ] || refuse "GH_TOKEN must be set (the job's GITHUB_TOKEN)"
  command -v gh >/dev/null 2>&1 || fail "gh is not on PATH"
}
# finalize_tag <tag> <version>: sets commit to the checkout's tag's commit, once it is on main,
# its charts/telflo/Chart.yaml is the version's, and GitHub holds the tag as the annotated tag of
# that commit.
finalize_tag() {
  [ "$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null)" = false ] \
    || fail "the checkout is shallow: finalize needs the full history (fetch-depth: 0)"
  commit="$(git -C "$ROOT" rev-parse -q --verify "refs/tags/$1^{commit}" 2>/dev/null)" \
    || fail "the checkout has no tag $1: a stage is finalized from its release tag"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "$1's commit isn't in the checkout"
  git -C "$ROOT" rev-parse -q --verify refs/remotes/origin/main >/dev/null || fail "the checkout has no refs/remotes/origin/main"
  git -C "$ROOT" merge-base --is-ancestor "$commit" refs/remotes/origin/main || fail "$1's commit $commit isn't on main"
  git -C "$ROOT" show "$commit:charts/telflo/Chart.yaml" >"$tmp/Chart.yaml" 2>/dev/null || fail "$1's commit has no charts/telflo/Chart.yaml"
  [ "$(telflo_chart_field "$tmp/Chart.yaml" version || true)" = "$2" ] && [ "$(telflo_chart_field "$tmp/Chart.yaml" appVersion || true)" = "$2" ] \
    || fail "charts/telflo/Chart.yaml at $1 isn't version $2"
  telflo_github_tag_object "$GITHUB_REPOSITORY" "$1" "$commit" "the checkout's" "$tmp" \
    || fail "$TELFLO_GITHUB_PROBLEM: nothing finalized"
  note "$1 is the annotated tag $TELFLO_GITHUB_TAG_OBJECT of $commit, on main"
}
# release_state <repository> <tag>: prints absent, draft or published (then ` digests` when the
# Release holds digests.txt), or error or shape.
release_state() {
  if ! env -u GH_HOST -u GH_REPO gh release view "$2" --repo "$1" --json tagName,isDraft,assets >"$tmp/release.json" 2>"$tmp/release.err" </dev/null; then
    if grep -q 'release not found' "$tmp/release.err"; then echo absent; else echo error; fi
    return 0
  fi
  python3 -I - "$tmp/release.json" "$2" 2>/dev/null <<'PY' || echo shape
import json, sys
try:
    reply = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print("shape"); sys.exit(0)
if not isinstance(reply, dict) or reply.get("tagName") != sys.argv[2] or not isinstance(reply.get("isDraft"), bool):
    print("shape"); sys.exit(0)
names = [a.get("name") for a in reply.get("assets") or [] if isinstance(a, dict)]
print(("draft" if reply["isDraft"] else "published") + (" digests" if "digests.txt" in names else ""))
PY
}
# draft_digests <tag> <dir>: the draft's digests.txt downloaded into <dir> (new), and checked.
draft_digests() {
  env -u GH_HOST -u GH_REPO gh release download "$1" --repo "$GITHUB_REPOSITORY" --pattern digests.txt --dir "$2" >/dev/null 2>"$tmp/download.err" </dev/null \
    || fail "the draft Release $1's digests.txt couldn't be downloaded"
  [ -f "$2/digests.txt" ] && [ ! -L "$2/digests.txt" ] || fail "the draft Release $1 gave no digests.txt"
  telflo_digests_ok "$2/digests.txt" || fail "the draft Release $1's digests.txt isn't a stage's record: nothing finalized"
}
finalize_check() {
  local version="" out=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || refuse "--version needs a value"; version="$2"; shift 2 ;;
      --out) [ $# -ge 2 ] || refuse "--out needs a folder"; out_dir_arg "$2"; shift 2 ;;
      *) refuse "finalize-check takes --version <x.y.z> --out <dir>" ;;
    esac
  done
  telflo_version_ok "$version" || refuse "finalize-check needs --version <x.y.z>"
  [ -n "$out" ] || refuse "finalize-check needs --out <dir>"
  finalize_env finalize-check
  local tag="v$version" commit state
  [ ! -e "$out/digests.txt" ] || fail "$out/digests.txt exists already: never overwritten"
  finalize_tag "$tag" "$version"
  state="$(release_state "$GITHUB_REPOSITORY" "$tag")"
  case "$state" in
    "draft digests") ;;
    draft) fail "the draft Release $tag holds no digests.txt: it isn't a stage (abandon it, then tag again)" ;;
    published*) fail "the Release $tag is published already: nothing to finalize" ;;
    absent) fail "there is no draft Release $tag: no stage of $version to finalize (the release workflow makes it)" ;;
    *) fail "GitHub didn't answer for the Release $tag ($state): nothing finalized" ;;
  esac
  draft_digests "$tag" "$tmp/download"
  cp "$tmp/download/digests.txt" "$out/digests.txt.partial" && mv "$out/digests.txt.partial" "$out/digests.txt" \
    || fail "can't write $out/digests.txt"
  note "the draft Release $tag and its stage's record: $out/digests.txt"
  printf '%s\n' "$out/digests.txt"
}
# version_newer <a> <b>: exit 0 when <a> is a higher x.y.z version than <b>.
version_newer() {
  local a b i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    if [ "${a[$i]}" -gt "${b[$i]}" ]; then return 0; fi
    if [ "${a[$i]}" -lt "${b[$i]}" ]; then return 1; fi
  done
  return 1
}
finalize_publish() {
  local version="" digests=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || refuse "--version needs a value"; version="$2"; shift 2 ;;
      --digests) [ $# -ge 2 ] || refuse "--digests needs a file"; digests="$2"; shift 2 ;;
      *) refuse "finalize-publish takes --version <x.y.z> --digests <file>" ;;
    esac
  done
  telflo_version_ok "$version" || refuse "finalize-publish needs --version <x.y.z>"
  [ -n "$digests" ] && [ -f "$digests" ] || refuse "--digests must be the promoted digests.txt"
  finalize_env finalize-publish
  local tag="v$version" commit state latest=true latest_tag
  finalize_tag "$tag" "$version"
  state="$(release_state "$GITHUB_REPOSITORY" "$tag")"
  [ "$state" = "draft digests" ] || fail "the Release $tag is no longer a draft holding digests.txt ($state): nothing published"
  draft_digests "$tag" "$tmp/again"
  cmp -s "$tmp/again/digests.txt" "$digests" || fail "the draft Release $tag's digests.txt isn't the record that was promoted: nothing published"
  # Latest, unless the Release marked latest names a higher version (a patch of an older line).
  if telflo_github_get "$tmp" "repos/$GITHUB_REPOSITORY/releases/latest" "$tmp/latest.json"; then
    latest_tag="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("tag_name", ""))' "$tmp/latest.json" 2>/dev/null || true)"
    if [[ "$latest_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] && version_newer "${latest_tag#v}" "$version"; then
      latest=false
      note "the latest Release is $latest_tag, a higher version: $tag is published with --latest=false"
    fi
  elif grep -q 'HTTP 404' "$tmp/gh.err" 2>/dev/null; then
    note "no Release is marked latest yet"
  else
    fail "GitHub's API didn't answer for the latest Release: nothing published"
  fi
  env -u GH_HOST -u GH_REPO gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false --latest="$latest" >/dev/null </dev/null \
    || fail "gh release edit $tag --draft=false failed"
  state="$(release_state "$GITHUB_REPOSITORY" "$tag")"
  [ "$state" = "published digests" ] || fail "after the edit, the Release $tag answers '$state', not published"
  note "the GitHub Release $tag is published (latest: $latest)"
}

# ---- abandon-stage -------------------------------------------------------------------------
# The owner's gh, with their own login (gh's own configuration), at github.com.
owner_api() { env -u GH_HOST -u GH_REPO -u GH_DEBUG gh api --hostname github.com -H "Accept: application/vnd.github+json" "$@" </dev/null; }
# package_of <namespace> <name>: the organization telflo's container package that holds
# <name> in that namespace (telflo/telflo-staging/api is telflo's telflo-staging/api).
package_of() { local path; path="$(telflo_namespace_path "$1")" || return 1; printf '%s/%s\n' "${path#telflo/}" "$2"; }
# package_versions <package> <out>: the organization's container package's versions (every
# page) into <out>; returns 0, 3 when there is no such package (404), 1 otherwise.
package_versions() {
  local encoded="${1//\//%2F}"
  if owner_api --paginate "orgs/telflo/packages/container/$encoded/versions?per_page=100" >"$2" 2>"$tmp/owner-api.err"; then return 0; fi
  if grep -q 'HTTP 404' "$tmp/owner-api.err"; then return 3; fi
  return 1
}
# tagged_versions <file> <version>: `version <id> <digest> <its other tags, or ->` for each
# version tagged <version>, then `fallback <id> <digest> <its tags>` for each version tagged
# sha256-<that digest's hex>; `shape` when the reply isn't a list of versions.
tagged_versions() {
  python3 -I - "$1" "$2" 2>/dev/null <<'PY' || echo shape
import json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
version = sys.argv[2]
decoder, at, items = json.JSONDecoder(), 0, []
try:
    while True:
        while at < len(text) and text[at].isspace():
            at += 1
        if at >= len(text):
            break
        value, at = decoder.raw_decode(text, at)
        if not isinstance(value, list):
            raise ValueError
        items.extend(value)
except ValueError:
    print("shape"); sys.exit(0)
rows = []
for item in items:
    tags = (((item.get("metadata") or {}).get("container") or {}).get("tags")) if isinstance(item, dict) else None
    if not isinstance(item, dict) or type(item.get("id")) is not int or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(item.get("name"))) \
            or not isinstance(tags, list) or not all(isinstance(t, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", t) for t in tags):
        print("shape"); sys.exit(0)
    rows.append((item["id"], item["name"], tags))
for vid, digest, tags in rows:
    if version not in tags:
        continue
    print("version %d %s %s" % (vid, digest, ",".join(t for t in tags if t != version) or "-"))
    fallback = "sha256-" + digest[7:]
    for other, other_digest, other_tags in rows:
        if fallback in other_tags:
            print("fallback %d %s %s" % (other, other_digest, ",".join(t for t in other_tags if t != fallback) or "-"))
PY
}
abandon_stage() {
  local version="" dry_run=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || refuse "--version needs a value"; version="$2"; shift 2 ;;
      --dry-run) dry_run=true; shift ;;
      *) refuse "abandon-stage takes --version <x.y.z> [--dry-run]" ;;
    esac
  done
  ! on_actions || refuse "abandon-stage is the owner's, run on their own machine with gh: a workflow never abandons a stage"
  telflo_version_ok "$version" || refuse "abandon-stage needs --version <x.y.z>"
  command -v gh >/dev/null 2>&1 || fail "gh is not on PATH (the owner's GitHub CLI, its token with read:packages and delete:packages)"
  local tag="v$version" names name status rows kind id digest extra problems=0 state deletes="" encoded
  names="$(tr ' ' '\n' <<<"$TELFLO_DIGESTS_NAMES" | grep -vxF charts/telflo.tgz)"
  # 1. Nothing of the version public: no public package version tagged <v>, no published Release.
  for name in $names; do
    status=0
    package_versions "$(package_of telflo "$name")" "$tmp/public.json" || status=$?
    case "$status" in
      0) rows="$(tagged_versions "$tmp/public.json" "$version")"
         [ "$rows" != shape ] || fail "GitHub's answer for the package telflo/$name isn't a list of versions: nothing deleted"
         if printf '%s\n' "$rows" | grep -q '^version '; then
           echo "$PROGRAM: ghcr.io/telflo/telflo/$name:$version is public: version $version is spent, never abandoned (a fix is the next patch version)" >&2
           problems=$((problems + 1))
         fi ;;
      3) ;;
      *) fail "GitHub's API didn't answer for the package telflo/$name (gh's token needs read:packages): nothing deleted" ;;
    esac
  done
  state="$(release_state telflo/telflo "$tag")"
  case "$state" in
    absent) note "there is no Release $tag" ;;
    draft*) note "the Release $tag is a draft: it goes with the stage" ;;
    published*) echo "$PROGRAM: the Release $tag is published: version $version is spent, never abandoned" >&2
       problems=$((problems + 1)) ;;
    *) fail "GitHub didn't answer for the Release $tag ($state): nothing deleted" ;;
  esac
  [ "$problems" -eq 0 ] || fail "$problems public part(s) of $version: nothing deleted"
  # 2. The stage: each staged package's version tagged <v>, and its fallback tags' versions.
  for name in $names; do
    status=0
    package_versions "$(package_of telflo-staging "$name")" "$tmp/staged.json" || status=$?
    case "$status" in
      0) ;;
      3) note "there is no package telflo-staging/$name"; continue ;;
      *) fail "GitHub's API didn't answer for the package telflo-staging/$name (gh's token needs read:packages): nothing deleted" ;;
    esac
    rows="$(tagged_versions "$tmp/staged.json" "$version")"
    [ "$rows" != shape ] || fail "GitHub's answer for the package telflo-staging/$name isn't a list of versions: nothing deleted"
    [ -n "$rows" ] || { note "telflo-staging/$name holds no version tagged $version"; continue; }
    while read -r kind id digest extra; do
      [ "$extra" = - ] \
        || fail "telflo-staging/$name's version $id ($digest) also holds the tag(s) $extra: deleting it would remove them; nothing deleted"
      deletes="$deletes$name $id $digest $kind"$'\n'
    done <<<"$rows"
  done
  if [ -z "$deletes" ] && [ "${state%% *}" != draft ]; then
    note "nothing of $version is staged, and there is no draft Release $tag: nothing to abandon"
    return 0
  fi
  while read -r name id digest kind; do
    [ -n "$name" ] || continue
    if [ "$kind" = version ]; then extra="tagged $version"; else extra="the referrers' fallback tag beside it"; fi
    echo "$PROGRAM: to delete: ghcr.io/$(telflo_namespace_path telflo-staging)/$name version $id ($digest, $extra)" >&2
  done <<<"$deletes"
  [ "${state%% *}" != draft ] || echo "$PROGRAM: to delete: the draft Release $tag (its tag stays: deleting it is yours, docs/releasing.md)" >&2
  if $dry_run; then
    note "dry run: nothing deleted"
    return 0
  fi
  while read -r name id digest kind; do
    [ -n "$name" ] || continue
    encoded="$(package_of telflo-staging "$name")"
    encoded="${encoded//\//%2F}"
    owner_api -X DELETE "orgs/telflo/packages/container/$encoded/versions/$id" >/dev/null 2>"$tmp/owner-api.err" \
      || fail "deleting telflo-staging/$name version $id failed (gh's token needs delete:packages)"
    note "deleted ghcr.io/$(telflo_namespace_path telflo-staging)/$name version $id ($digest)"
  done <<<"$deletes"
  if [ "${state%% *}" = draft ]; then
    env -u GH_HOST -u GH_REPO gh release delete "$tag" --repo telflo/telflo --yes >/dev/null 2>"$tmp/release.err" </dev/null \
      || fail "deleting the draft Release $tag failed"
    note "deleted the draft Release $tag"
  fi
  note "the stage of $version is abandoned; now delete the tag (git push origin :refs/tags/$tag, then git tag -d $tag), and tag again once the fix is on main"
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
  digests) digests "$@" ;;
  finalize-check) finalize_check "$@" ;;
  finalize-publish) finalize_publish "$@" ;;
  abandon-stage) abandon_stage "$@" ;;
  -h | --help) usage ;;
  *) usage ;;
esac
