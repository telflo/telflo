#!/usr/bin/env bash
# The platform runs the opamp-server's published release (D26 decisions 5
# and 36): vendor/opamp-server/ holds the three contract files the platform
# reads, byte for byte the release's, and PIN names that release. This
# checks that they still agree:
#
#   - the sibling checkout's tag v<version> (under refs/tags/, so a branch of
#     that name doesn't count) is the PIN's commit;
#   - each vendored file equals that commit's blob;
#   - docker-compose.yml's opamp-migrate and opamp-server each
#     run ghcr.io/telflo/opamp-server:<version>@<digest> and build nothing,
#     and nothing else in it names the image outside comments; the same for
#     the Compose install's deploy/compose/compose.yaml (D36-2 decisions 88
#     and 89), whose copy of bootstrap.sql,
#     deploy/compose/opamp-server/bootstrap.sql, is the tag's blob too;
#   - the opamp-server chart vendored unpacked in the platform's chart
#     (charts/telflo/charts/opamp-server, D33-1 decision 21) is the
#     release's: the PIN's chart-tree is the git tree id of that commit's
#     charts/opamp-server, and both HEAD's tree at the vendored path and the
#     working tree's files there (tracked and untracked, ignored ones left
#     out, hashed as git would, nothing written) have that id, and no file
#     git ignores sits there but .DS_Store (Helm would package or render it,
#     and the tree ids can't see it); and the
#     version charts/telflo/Chart.yaml declares for its opamp-server
#     dependency (at oci://ghcr.io/telflo/charts), the vendored Chart.yaml's
#     version and the PIN's are one version (Helm passes a mismatch
#     silently). The tree ids need no network and no registry.
#
# Compose is checked twice: first as text (no Docker; it catches the plain
# cases fast), then as Compose itself reads the file, merge keys, anchors and
# all: `docker compose config --format json` (client side only: no daemon, no
# registry, no credential helper, through an empty temporary DOCKER_CONFIG
# and no .env), whose two services must have the pinned image and no build,
# and whose opamp-bootstrap must mount vendor/opamp-server/bootstrap.sql
# at /opamp/bootstrap.sql and run exactly the committed command
# (BOOTSTRAP_COMMAND below), with no entrypoint.
# It runs twice: on docker-compose.yml named with -f, and with Compose's own
# file discovery in the root (no -f, COMPOSE_FILE unset), which is what a
# plain `docker compose` there reads, an override file included. A third run
# reads the Compose install, deploy/compose/compose.yaml, with
# --project-directory deploy/compose and a placeholder env file made at run
# time (every variable it requires, a placeholder value; never its .env):
# its db-bootstrap must mount deploy/compose/opamp-server/bootstrap.sql
# at /opamp/bootstrap.sql and run exactly its own committed command
# (INSTALL_BOOTSTRAP_COMMAND below: the superuser postgres, the chart's
# telflo-bootstrap.sql first), with no entrypoint. The root's
# compose files are an allowlist besides: docker-compose.yml and
# docker-compose.opamp-server-dev.yml, and no other compose.y*ml,
# docker-compose.y*ml or *compose.override.y*ml. Without the docker CLI and
# its compose plugin the check fails closed.
#
# The digest is checked as text, and against the release when the image is
# in the local Docker store (docker image inspect, never a pull): its
# org.opencontainers.image.revision label must be the PIN's commit. When it
# isn't local, one line says its revision wasn't checked (not a failure: a
# release PR pulls it first, which also proves the digest real).
#
# The boundary: this checks the repository's committed files (and any file
# at the root a plain `docker compose` would read). Local configuration is
# out of scope by design: a gitignored .env and exported COMPOSE_* variables
# are a developer's own; the check never reads .env (Compose runs with
# --env-file /dev/null) and runs with COMPOSE_FILE unset.
#
# Usage:
#   scripts/check-opamp-server-pin.sh            the check (a local gate)
#   scripts/check-opamp-server-pin.sh --refresh  copy the three files from the
#                                                sibling's WORKING TREE, to try
#                                                an unreleased change, then say
#                                                whether the PIN still matches
#   scripts/check-opamp-server-pin.sh --restore  write the PIN commit's three
#                                                files back, then check: the
#                                                way back to the pin
#
# OPAMP_SERVER_SRC names the opamp-server's checkout, default ../opamp-server,
# resolved against the platform's root (not the caller's directory). It must
# be the top of a git checkout holding the PIN's tag; the check fails closed
# when it isn't there. docs/conventions/opamp-server.md is the guide.
#
# PIN is exactly four LF lines, version=<x.y.z>, commit=<40 hex>,
# digest=sha256:<64 hex> and chart-tree=<40 hex>, read with sed and never
# sourced. Bash 3.2 (macOS's) runs this; python3 hashes the working tree.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VENDOR="$ROOT/vendor/opamp-server"
PIN="$VENDOR/PIN"
COMPOSE="$ROOT/docker-compose.yml"
IMAGE_REPO=ghcr.io/telflo/opamp-server
# opamp-bootstrap's command, exactly as docker-compose.yml commits it
# (a JSON list): Compose must run this and nothing else. A change to that
# command in docker-compose.yml must update this line; the test fails while
# they differ.
BOOTSTRAP_COMMAND='["psql", "-h", "db", "-U", "telflo_platform_owner", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/opamp/bootstrap.sql"]'
# The Compose install (D36-2 decisions 88 and 89; Preflight ruling 1): its
# file, its copy of bootstrap.sql, its bootstrap service and that service's
# command, exactly as deploy/compose/compose.yaml commits it (the same rule
# as BOOTSTRAP_COMMAND's).
INSTALL_DIR="$ROOT/deploy/compose"
INSTALL_COMPOSE="$INSTALL_DIR/compose.yaml"
INSTALL_BOOTSTRAP_COPY="$INSTALL_DIR/opamp-server/bootstrap.sql"
INSTALL_BOOTSTRAP_SERVICE=db-bootstrap
INSTALL_BOOTSTRAP_COMMAND='["psql", "-h", "db", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "/telflo/telflo-bootstrap.sql", "-f", "/opamp/bootstrap.sql"]'
# Each vendored file's name, then its path in the opamp-server's repository.
FILES="openapi.yaml:api/openapi.yaml bootstrap.sql:deploy/bootstrap.sql org-token-corpus.json:handlers/testdata/org-token-corpus.json"
# The vendored chart, relative to the platform's root, and the release's own
# path for it; the parent chart that declares it as a dependency, and where.
CHART_PATH=charts/telflo/charts/opamp-server
RELEASE_CHART_PATH=charts/opamp-server
PARENT_CHART="$ROOT/charts/telflo/Chart.yaml"
DEPENDENCY_REPOSITORY=oci://ghcr.io/telflo/charts

# The .tmp files this run writes, removed if it stops part way, and the
# Compose install's placeholder env file.
written_tmp=""
placeholder_file=""
cleanup() {
  local f
  for f in $written_tmp; do
    rm -f "$VENDOR/$f"
  done
  if [ -n "$placeholder_file" ]; then rm -f "$placeholder_file"; fi
}
trap cleanup EXIT

fail() {
  echo "check-opamp-server-pin: FAIL: $*" >&2
  exit 1
}

mode=check
if [ "$#" -gt 1 ]; then
  echo "usage: $0 [--refresh | --restore]" >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --refresh) mode=refresh ;;
  --restore) mode=restore ;;
  *)
    echo "usage: $0 [--refresh | --restore]" >&2
    exit 2
    ;;
esac

# The sibling checkout.
src=${OPAMP_SERVER_SRC:-../opamp-server}
case "$src" in
  /*) ;;
  *) src="$ROOT/$src" ;;
esac
[ -d "$src" ] ||
  fail "the opamp-server checkout $src is missing: clone the opamp-server's repository (github.com/telflo/opamp-server) beside the platform, as ../opamp-server, or set OPAMP_SERVER_SRC to your clone"
top=$(git -C "$src" rev-parse --show-toplevel 2>/dev/null) ||
  fail "$src is not a git checkout: OPAMP_SERVER_SRC must name a clone of the opamp-server's repository"
[ "$(cd "$top" && pwd -P)" = "$(cd "$src" && pwd -P)" ] ||
  fail "$src is not the top of a git checkout: OPAMP_SERVER_SRC must name the clone's top folder"

# Nothing here follows a symbolic link: vendor/, vendor/opamp-server, PIN,
# the three files and their .tmp names must each be a real file or folder (or
# absent), checked before anything is read or written, so neither --refresh
# nor --restore can write outside vendor/opamp-server.
for path in "$ROOT/vendor" "$VENDOR" "$PIN" "$ROOT/charts" "$ROOT/charts/telflo" \
  "$ROOT/charts/telflo/charts" "$ROOT/$CHART_PATH" "$PARENT_CHART" "$ROOT/deploy" "$INSTALL_DIR" \
  "$INSTALL_COMPOSE" "$INSTALL_DIR/opamp-server" "$INSTALL_BOOTSTRAP_COPY"; do
  [ ! -L "$path" ] || fail "${path#"$ROOT"/} is a symbolic link; it must be a real file or folder"
done
for entry in $FILES; do
  name=${entry%%:*}
  for path in "$VENDOR/$name" "$VENDOR/$name.tmp"; do
    [ ! -L "$path" ] || fail "${path#"$ROOT"/} is a symbolic link; it must be a real file or folder"
  done
done

# The PIN: exactly these four lines, in this order, each ending in LF.
[ -f "$PIN" ] || fail "vendor/opamp-server/PIN is missing"
version=$(sed -n 's/^version=\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' "$PIN")
commit=$(sed -n 's/^commit=\([0-9a-f]\{40\}\)$/\1/p' "$PIN")
digest=$(sed -n 's/^digest=\(sha256:[0-9a-f]\{64\}\)$/\1/p' "$PIN")
chart_tree=$(sed -n 's/^chart-tree=\([0-9a-f]\{40\}\)$/\1/p' "$PIN")
# awk counts a last line without its newline too; the last byte must be LF.
if [ "$(awk 'END { print NR }' "$PIN")" != 4 ] ||
  [ "$(tail -c 1 "$PIN" | od -An -tx1 | tr -d ' \n')" != 0a ] ||
  [ "$(sed -n 1p "$PIN")" != "version=$version" ] || [ -z "$version" ] ||
  [ "$(sed -n 2p "$PIN")" != "commit=$commit" ] || [ -z "$commit" ] ||
  [ "$(sed -n 3p "$PIN")" != "digest=$digest" ] || [ -z "$digest" ] ||
  [ "$(sed -n 4p "$PIN")" != "chart-tree=$chart_tree" ] || [ -z "$chart_tree" ]; then
  fail "vendor/opamp-server/PIN must be exactly four lines: version=<x.y.z>, commit=<40 hex>, digest=sha256:<64 hex>, chart-tree=<40 hex>"
fi

# A temporary Docker config folder, printed: no auths, no credsStore, no
# credential helper. It names the usual plugins folder, if there is one, so a
# compose plugin installed there is still found. The caller removes it.
empty_docker_config() {
  local cfg
  cfg=$(mktemp -d "${TMPDIR:-/tmp}/check-opamp-server-pin.XXXXXX") || return 1
  if ! python3 -I -c 'import json, os, sys
plugins = sys.argv[1]
json.dump({"cliPluginsExtraDirs": [plugins]} if os.path.isdir(plugins) else {}, open(sys.argv[2], "w"))' \
    "${DOCKER_CONFIG:-${HOME:-/nonexistent}/.docker}/cli-plugins" "$cfg/config.json"; then
    rm -rf "$cfg"
    return 1
  fi
  printf '%s\n' "$cfg"
}

# Compose's own reading: the two services run $1 and build nothing, and the
# bootstrap service $3 mounts the bootstrap.sql at $4 and runs exactly the
# command $5 (a JSON list). $2 says what is read; the rest are compose's
# arguments (its project directory, env file and files; none: its
# discovery in the root, with no env file).
verify_with_compose() {
  local want=$1 what=$2 bootstrap_service=$3 bootstrap_source=$4 bootstrap_command=$5 cfg json status=0 err problems
  shift 5
  command -v docker >/dev/null 2>&1 ||
    fail "docker isn't on PATH: the check reads docker-compose.yml as Compose does (docker compose config, client side only: no daemon or registry), so it can't pass without the docker CLI and its compose plugin"
  command -v python3 >/dev/null 2>&1 ||
    fail "python3 isn't on PATH: it reads docker compose config's JSON"
  cfg=$(empty_docker_config) || fail "couldn't make a temporary Docker config"
  json=$(cd "$ROOT" && env -u DOCKER_CONTEXT -u COMPOSE_FILE -u COMPOSE_PROFILES DOCKER_CONFIG="$cfg" docker compose \
    -p opamp-pin-check "$@" config --format json \
    2>"$cfg/stderr") || status=$?
  err=$(head -c 600 "$cfg/stderr" 2>/dev/null || true)
  rm -rf "$cfg"
  [ "$status" = 0 ] ||
    fail "docker compose config refused $what (are the docker CLI and its compose plugin installed?): $err"
  problems=$(printf '%s' "$json" | python3 -I -c '
import json, os, sys
want = sys.argv[1]
try:
    services = json.load(sys.stdin)["services"]
except Exception:
    print("its output is not the JSON expected")
    sys.exit(0)
for name in ("opamp-migrate", "opamp-server"):
    service = services.get(name)
    if not isinstance(service, dict):
        print(name + " is missing")
        continue
    if service.get("image") != want:
        print(name + "'"'"'s image is " + repr(service.get("image")) + ", not the PIN'"'"'s " + want)
    if "build" in service:
        print(name + " has a build")
name, root, relative = sys.argv[4], sys.argv[2], sys.argv[5]
vendored = os.path.realpath(os.path.join(root, relative))
bootstrap = services.get(name)
mounts = [v for v in (bootstrap or {}).get("volumes") or [] if isinstance(v, dict) and v.get("target") == "/opamp/bootstrap.sql"]
if len(mounts) != 1:
    print(name + " has " + str(len(mounts)) + " mounts at /opamp/bootstrap.sql, not one")
elif mounts[0].get("type") != "bind" or os.path.realpath(mounts[0].get("source") or "") != vendored:
    print(name + " mounts " + repr(mounts[0].get("source")) + " at /opamp/bootstrap.sql, not " + relative)
expected = json.loads(sys.argv[3])
command = (bootstrap or {}).get("command")
if isinstance(command, str):
    import shlex
    command = shlex.split(command)
if command != expected:
    print(name + "'"'"'s command is " + repr(command) + ", not exactly the committed " + repr(expected))
if (bootstrap or {}).get("entrypoint") is not None:
    print(name + " has an entrypoint (" + repr(bootstrap.get("entrypoint")) + "); it must have none")
' "$want" "$ROOT" "$bootstrap_command" "$bootstrap_service" "$bootstrap_source") || fail "python3 couldn't read docker compose config's JSON"
  [ -z "$problems" ] ||
    fail "as Compose reads $what (docker compose config): $(printf '%s' "$problems" | tr '\n' ';')"
}

# check_compose_text <file> <label> <want> <why no build>: the file's
# opamp-migrate and opamp-server each have one image line, the
# PIN's, no build: and no YAML merge key, and nothing else in it names the
# image outside comments. As text, with no Docker: the plain cases, fast.
check_compose_text() {
  local file=$1 label=$2 want=$3 why=$4 service got count
  for service in opamp-migrate opamp-server; do
    got=$(awk -v svc="  $service:" '
      /^[^ #]/ { in_services = ($0 == "services:"); inside = 0; next }
      in_services && /^  [^ #]/ { inside = ($0 == svc); next }
      inside && /^    image:[ ]/ {
        sub(/^    image:[ ]+/, ""); sub(/[ ]+#.*$/, ""); sub(/[ ]+$/, ""); print; n++
      }
      END { if (n != 1) print "<" n + 0 " image lines>" }' "$file")
    [ "$got" = "$want" ] ||
      fail "$label's $service image is '$got', not the PIN's $want"
    awk -v svc="  $service:" '
      /^[^ #]/ { in_services = ($0 == "services:"); inside = 0; next }
      in_services && /^  [^ #]/ { inside = ($0 == svc); next }
      inside && /^    build:/ { found = 1 }
      END { exit found ? 1 : 0 }' "$file" ||
      fail "$label's $service has a build: ($why)"
    # A YAML merge key could bring a build: (or another image) in unseen.
    awk -v svc="  $service:" '
      /^[^ #]/ { in_services = ($0 == "services:"); inside = 0; next }
      in_services && /^  [^ #]/ { inside = ($0 == svc); next }
      inside && /^[ ]+<<[ ]*:/ { found = 1 }
      END { exit found ? 1 : 0 }' "$file" ||
      fail "$label's $service has a YAML merge key (<<:); its image and build must be written out"
  done
  count=$(grep -v '^[[:space:]]*#' "$file" | grep -cF "$IMAGE_REPO" || true)
  [ "$count" = 2 ] ||
    fail "$label names $IMAGE_REPO $count times outside comments; only the two services' image lines may"
}

# placeholder_env <compose file>: a temporary env file (its path printed)
# setting every variable the file requires (${NAME:?...}) to a placeholder
# (a port 1, an address 127.0.0.1, any other "placeholder"), so Compose can
# read the file without the install's .env. The caller removes it.
placeholder_env() {
  local file=$1 env name
  env=$(mktemp "${TMPDIR:-/tmp}/check-opamp-server-pin-env.XXXXXX") || return 1
  for name in $(grep -oE '[$][{][A-Z_][A-Z0-9_]*:[?]' "$file" | sed 's/^[$][{]//; s/:[?]$//' | sort -u); do
    case "$name" in
      *_PORT) printf '%s=1\n' "$name" ;;
      *_ADDRESS) printf '%s=127.0.0.1\n' "$name" ;;
      *) printf '%s=placeholder\n' "$name" ;;
    esac
  done >"$env" || { rm -f "$env"; return 1; }
  printf '%s\n' "$env"
}

# The pinned image, when it is in the local Docker store: its revision label
# is the PIN's commit. Never a pull (docker image inspect only), through the
# same empty Docker config.
check_local_revision() {
  local want=$1 cfg revision status=0 err
  cfg=$(empty_docker_config) || fail "couldn't make a temporary Docker config"
  revision=$(env -u DOCKER_CONTEXT DOCKER_CONFIG="$cfg" docker image inspect \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$want" 2>"$cfg/stderr") ||
    status=$?
  err=$(head -n 1 "$cfg/stderr" 2>/dev/null || true)
  rm -rf "$cfg"
  if [ "$status" != 0 ]; then
    case "$err" in
      *"No such image"* | *"No such object"*)
        echo "check-opamp-server-pin: $want isn't in the local Docker store, so its revision label wasn't checked (a release PR pulls it first)." ;;
      *)
        echo "check-opamp-server-pin: Docker couldn't be asked about $want, so its revision label wasn't checked: $err" ;;
    esac
    return 0
  fi
  [ "$revision" = "$commit" ] ||
    fail "the local image $want has revision label '$revision', but the PIN says $commit"
  echo "check-opamp-server-pin: the local image's revision label is $commit, the PIN's."
}

# Only these compose files at the root, so a plain `docker compose` there
# reads docker-compose.yml alone. Names are compared case-insensitively
# (macOS's filesystem is: Compose would read Compose.yaml as compose.yaml);
# the two allowed are allowed only exactly as spelled.
check_root_compose_files() {
  local found name lower
  for found in "$ROOT"/*; do
    [ -e "$found" ] || [ -L "$found" ] || continue
    name=${found##*/}
    lower=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      compose.y*ml | docker-compose.y*ml | *compose.override.y*ml) ;;
      *) continue ;;
    esac
    case "$name" in
      docker-compose.yml | docker-compose.opamp-server-dev.yml) ;;
      *) fail "$name at the platform's root isn't one of its compose files (docker-compose.yml, docker-compose.opamp-server-dev.yml): a plain docker compose there would read it" ;;
    esac
  done
}

# The git tree id of the working tree's files under $CHART_PATH, as `git
# write-tree` would make it from them: the tracked and untracked files git
# would add (ignored ones left out), each hashed from the disk, nothing
# written to the repository. Prints the id; fails (prints nothing) when a file
# can't be read or is a symbolic link.
working_tree_id() {
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard -- "$CHART_PATH" |
    python3 -I -c '
import hashlib, os, stat, sys
root, prefix = sys.argv[1], sys.argv[2] + "/"
files = sorted({p for p in sys.stdin.buffer.read().decode("utf-8", "surrogateescape").split("\0") if p})
if not files:
    sys.exit(1)
tree = {}
for path in files:
    if not path.startswith(prefix):
        sys.exit(1)
    node = tree
    parts = path[len(prefix):].split("/")
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = None
def blob(path):
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode):
        sys.exit(1)
    with open(path, "rb") as f:
        data = f.read()
    mode = b"100755" if st.st_mode & 0o100 else b"100644"
    return mode, hashlib.sha1(b"blob %d\0" % len(data) + data).digest()
def tree_id(node, path):
    entries = []
    for name, child in node.items():
        full = os.path.join(path, name)
        if child is None:
            mode, digest = blob(full)
            entries.append((name.encode("utf-8", "surrogateescape"), mode, digest))
        else:
            entries.append((name.encode("utf-8", "surrogateescape") + b"/", b"40000", tree_id(child, full)))
    # git orders a tree by name, a folder named as if it ended in "/".
    entries.sort(key=lambda e: e[0])
    body = b"".join(mode + b" " + name.rstrip(b"/") + b"\0" + digest for name, mode, digest in entries)
    return hashlib.sha1(b"tree %d\0" % len(body) + body).digest()
try:
    print(tree_id(tree, os.path.join(root, prefix)).hex())
except OSError:
    sys.exit(1)
' "$ROOT" "$CHART_PATH"
}

# The version charts/telflo/Chart.yaml declares for its opamp-server
# dependency, then its repository, one a line (read as text: exactly one
# dependency named opamp-server, each key on its own line).
declared_dependency() {
  awk '
    function flush() {
      gsub(/"/, "", name)
      if (name == "opamp-server") { n++; v = ver; r = repo }
      name = ""; ver = ""; repo = ""
    }
    /^[^ #]/ { if (deps) flush(); deps = ($0 == "dependencies:"); next }
    !deps { next }
    /^  - / { flush(); sub(/^  - /, "    ") }
    /^    name:[ ]/ { name = $2 }
    /^    version:[ ]/ { ver = $2 }
    /^    repository:[ ]/ { repo = $2 }
    END {
      if (deps) flush()
      if (n == 1) { gsub(/"/, "", v); gsub(/"/, "", r); print v; print r }
    }' "$PARENT_CHART"
}

# The vendored chart (step 3 of the check).
check_chart() {
  local declared declared_version declared_repository vendored_version release_tree head_tree work_tree
  [ -f "$PARENT_CHART" ] || fail "charts/telflo/Chart.yaml is missing"
  [ -d "$ROOT/$CHART_PATH" ] || fail "$CHART_PATH is missing: the opamp-server chart is vendored there, unpacked (docs/conventions/opamp-server.md)"
  [ -f "$ROOT/$CHART_PATH/Chart.yaml" ] || fail "$CHART_PATH/Chart.yaml is missing"

  # One version: the parent's dependency, the vendored Chart.yaml's, the PIN's.
  declared=$(declared_dependency)
  declared_version=$(printf '%s\n' "$declared" | sed -n 1p)
  declared_repository=$(printf '%s\n' "$declared" | sed -n 2p)
  [ -n "$declared_version" ] ||
    fail "charts/telflo/Chart.yaml must declare exactly one dependency named opamp-server, with its version"
  [ "$declared_version" = "$version" ] ||
    fail "charts/telflo/Chart.yaml declares opamp-server $declared_version, but the PIN says $version"
  [ "$declared_repository" = "$DEPENDENCY_REPOSITORY" ] ||
    fail "charts/telflo/Chart.yaml's opamp-server dependency is at '$declared_repository', not $DEPENDENCY_REPOSITORY"
  vendored_version=$(sed -n 's/^version:[ ]*"\{0,1\}\([^" ]*\)"\{0,1\}[ ]*$/\1/p' "$ROOT/$CHART_PATH/Chart.yaml")
  [ "$vendored_version" = "$version" ] ||
    fail "$CHART_PATH/Chart.yaml's version is '$vendored_version', but the PIN says $version"

  # The tree ids: the release's chart, HEAD's vendored tree, the working tree's.
  release_tree=$(git -C "$src" rev-parse --verify --quiet "$commit:$RELEASE_CHART_PATH") ||
    fail "v$version has no $RELEASE_CHART_PATH"
  [ "$release_tree" = "$chart_tree" ] ||
    fail "v$version's $RELEASE_CHART_PATH is tree $release_tree, but the PIN's chart-tree is $chart_tree"
  head_tree=$(git -C "$ROOT" rev-parse --verify --quiet "HEAD:$CHART_PATH") ||
    fail "HEAD has no $CHART_PATH: commit the vendored chart"
  [ "$head_tree" = "$chart_tree" ] ||
    fail "HEAD's $CHART_PATH is tree $head_tree, but the PIN's chart-tree is $chart_tree: the vendored chart must be v$version's, byte for byte"
  # A file git ignores is left out of the tree ids, but Helm would package
  # or render it (.helmignore drops .DS_Store only).
  local ignored
  ignored=$(git -C "$ROOT" ls-files -z --others --ignored --exclude-standard -- "$CHART_PATH" | tr '\0' '\n' |
    grep -vE '(^|/)[.]DS_Store$' | head -n 1) || true
  [ -z "$ignored" ] ||
    fail "$ignored is a file git ignores in the vendored chart, which Helm would package or render: remove it (only .DS_Store may be there)"
  work_tree=$(working_tree_id) || work_tree=""
  [ "$work_tree" = "$chart_tree" ] ||
    fail "the working tree's $CHART_PATH differs from the PIN's chart-tree $chart_tree (a changed, added or removed file): the vendored chart must be v$version's, byte for byte"
}

# The check itself, run by every mode.
check() {
  # 1. The tag's commit is the PIN's.
  local tag_commit
  tag_commit=$(git -C "$src" rev-parse --verify --quiet "refs/tags/v$version^{commit}") ||
    fail "$src has no tag v$version: git -C $src fetch --tags"
  [ "$tag_commit" = "$commit" ] ||
    fail "the tag v$version in $src is commit $tag_commit, but the PIN says $commit"

  # 2. Each vendored file is the tag's, byte for byte.
  local entry name path
  for entry in $FILES; do
    name=${entry%%:*}
    path=${entry#*:}
    [ -f "$VENDOR/$name" ] || fail "vendor/opamp-server/$name is missing"
    git -C "$src" cat-file -e "$commit:$path" 2>/dev/null || fail "v$version has no $path"
    cmp -s <(git -C "$src" cat-file blob "$commit:$path") "$VENDOR/$name" ||
      fail "vendor/opamp-server/$name differs from v$version's $path (refreshed for development? scripts/check-opamp-server-pin.sh --restore puts the release's back)"
  done

  # 3. The vendored chart: one version everywhere, then the tree ids.
  check_chart

  # 4. Compose's two services run the PIN's image and build nothing; nothing
  # else names the image outside comments.
  [ -f "$COMPOSE" ] || fail "docker-compose.yml is missing"
  check_root_compose_files
  local want
  want="$IMAGE_REPO:$version@$digest"
  check_compose_text "$COMPOSE" docker-compose.yml "$want" \
    "only docker-compose.opamp-server-dev.yml builds the server"
  verify_with_compose "$want" docker-compose.yml opamp-bootstrap vendor/opamp-server/bootstrap.sql \
    "$BOOTSTRAP_COMMAND" --project-directory "$ROOT" --env-file /dev/null -f "$COMPOSE"
  verify_with_compose "$want" "the root's compose files (Compose's own discovery, as a plain docker compose there)" \
    opamp-bootstrap vendor/opamp-server/bootstrap.sql "$BOOTSTRAP_COMMAND" \
    --project-directory "$ROOT" --env-file /dev/null

  # 5. The Compose install: its copy of bootstrap.sql is the tag's, and its
  # two services run the PIN's image and build nothing, as text and as
  # Compose reads it (its own folder as the project's, a placeholder env
  # file, never its .env).
  [ -f "$INSTALL_COMPOSE" ] || fail "deploy/compose/compose.yaml is missing"
  [ -f "$INSTALL_BOOTSTRAP_COPY" ] || fail "deploy/compose/opamp-server/bootstrap.sql is missing"
  cmp -s <(git -C "$src" cat-file blob "$commit:deploy/bootstrap.sql") "$INSTALL_BOOTSTRAP_COPY" ||
    fail "deploy/compose/opamp-server/bootstrap.sql differs from v$version's deploy/bootstrap.sql (copy vendor/opamp-server/bootstrap.sql there)"
  check_compose_text "$INSTALL_COMPOSE" deploy/compose/compose.yaml "$want" \
    "the Compose install runs only published images"
  placeholder_file=$(placeholder_env "$INSTALL_COMPOSE") || fail "couldn't make a placeholder env file"
  verify_with_compose "$want" deploy/compose/compose.yaml "$INSTALL_BOOTSTRAP_SERVICE" \
    deploy/compose/opamp-server/bootstrap.sql "$INSTALL_BOOTSTRAP_COMMAND" \
    --project-directory "$INSTALL_DIR" --env-file "$placeholder_file" -f "$INSTALL_COMPOSE"
  rm -f "$placeholder_file"
  placeholder_file=""
  check_local_revision "$want"

  echo "check-opamp-server-pin: OK: v$version ($commit): the three vendored files, the vendored chart ($CHART_PATH, tree $chart_tree), and the two services and the bootstrap's mount and command of docker-compose.yml and of the Compose install (deploy/compose, its bootstrap.sql copy too; as text and as Compose reads them) match the PIN"
}

case "$mode" in
  refresh)
    for entry in $FILES; do
      name=${entry%%:*}
      path=${entry#*:}
      [ -f "$src/$path" ] || fail "$src/$path is missing"
    done
    for entry in $FILES; do
      name=${entry%%:*}
      path=${entry#*:}
      written_tmp="$written_tmp $name.tmp"
      # A fresh file: a .tmp left there (a hard link among them) is never
      # written into.
      rm -f "$VENDOR/$name.tmp"
      cp "$src/$path" "$VENDOR/$name.tmp" || fail "couldn't copy $src/$path"
      mv "$VENDOR/$name.tmp" "$VENDOR/$name"
    done
    echo "check-opamp-server-pin: copied the three files from $src's working tree into vendor/opamp-server."
    if (check) >/dev/null 2>&1; then
      echo "check-opamp-server-pin: they equal v$version's, so the PIN still matches."
    else
      echo "check-opamp-server-pin: the PIN (v$version) no longer matches: the check fails until a release holding them is pinned, or --restore puts v$version's back (docs/conventions/opamp-server.md)."
    fi
    ;;
  restore)
    # The tag must be the PIN's before anything is written.
    tag_commit=$(git -C "$src" rev-parse --verify --quiet "refs/tags/v$version^{commit}") ||
      fail "$src has no tag v$version: git -C $src fetch --tags"
    [ "$tag_commit" = "$commit" ] ||
      fail "the tag v$version in $src is commit $tag_commit, but the PIN says $commit"
    for entry in $FILES; do
      name=${entry%%:*}
      path=${entry#*:}
      written_tmp="$written_tmp $name.tmp"
      rm -f "$VENDOR/$name.tmp"
      git -C "$src" cat-file blob "$commit:$path" >"$VENDOR/$name.tmp" ||
        fail "couldn't read v$version's $path"
      mv "$VENDOR/$name.tmp" "$VENDOR/$name"
    done
    echo "check-opamp-server-pin: wrote v$version's three files back into vendor/opamp-server."
    check
    ;;
  check)
    check
    ;;
esac
