#!/usr/bin/env bash
# Packages and publishes one of the platform's Helm charts to its OCI
# registry: charts/supervisor-collector (the default) or charts/telflo, the
# package made once and that same file pushed.
#
#   scripts/publish-chart.sh --dry-run [--registry <r>] [--namespace <n>]
#                                                          check everything, print the push, push nothing
#   scripts/publish-chart.sh --package <dir>               every check but the registry's, then the package into <dir>
#   scripts/publish-chart.sh --push-package <tgz> [--registry <r>] [--namespace <n>]
#                                                          push that package (a maintainer's, or the release's publish job)
#   each with --chart <name>: supervisor-collector (the default) or telflo
#
# --package writes <dir>/<name>-<version>.tgz (refused if it exists) and
# prints its path and sha256 (`<path> sha256:<hex>`). --push-package reads
# the file's chart name and version from its own Chart.yaml (one top-level
# folder, named after the chart), which must be --chart's and HEAD's
# Chart.yaml's (and, for telflo, its appVersion the version); asks the
# registry for <registry>/<namespace's path>/charts/<name>:<version> (`crane
# manifest`): absent, `helm push <tgz>
# oci://<registry>/<namespace's path>/charts` (`--plain-http` for a loopback
# registry), then the registry asked again, its chart layer's digest equal
# to the file's sha256; present with that
# digest, skipped with a line (a re-run); present with another, or an answer
# that isn't "absent", refused, nothing pushed (`helm push` overwrites a
# version silently: this check is the only guard). It prints
# `oci://<registry>/<namespace's path>/charts/<name>:<version> sha256:<hex>`.
# --registry is ghcr.io (the default) or a loopback 127.0.0.1:<port> or
# localhost:<port>. --namespace is telflo (the default: telflo/telflo, the
# public one) or, for --chart telflo only, telflo-staging
# (telflo/telflo-staging, a release's stage, which the finalize workflow
# copies to the public one by digest); the supervisor-collector chart is
# published to the public namespace alone. scripts/release/oci.sh's
# telflo_namespace_path maps the name, so the repository is always
# telflo/telflo/charts or telflo/telflo-staging/charts. There is no --push (it
# packaged and pushed in one step): it is refused, naming --package and
# --push-package.
#
# Without --chart, the checks are supervisor-collector's.
#
# Refused before anything runs (exit 2): no mode or more than one; --push; an
# unknown argument or chart, or --chart given twice; --registry or
# --namespace with --package, a registry that isn't ghcr.io or a loopback
# one, a namespace that isn't telflo or telflo-staging, or telflo-staging for
# the supervisor-collector chart; a --package
# folder that isn't a directory, or a --push-package file that isn't one;
# Chart.yaml's name not matching [a-z0-9-] or its version not x.y.z. For supervisor-collector: Chart.yaml's
# name not the last segment of the contracts' DEFAULT_HELM_CHART_REFERENCE,
# or its version not DEFAULT_HELM_CHART_VERSION
# (telflo-core/packages/contracts/src/helm.ts, each read by its exact line: a
# chart change bumps both together); the reference is the contracts'
# default. For telflo: its appVersion not its version; the reference is
# fixed, oci://ghcr.io/telflo/telflo/charts/telflo (no contracts constant).
# Either chart: a reference that isn't `oci://` lowercase letters, digits and
# `._:/-`, whose last segment isn't the chart's name, or that is under
# the older registry path oci://ghcr.io/telflo/charts/. With --registry,
# --namespace or --push-package, the reference is
# oci://<registry>/<namespace's path>/charts/<name>.
# TELFLO_HELM_CHART_REFERENCE (the platform's own setting) is refused in every
# mode: nothing here reads or writes a reference the caller names.
#
# Refused next (exit 1, --dry-run too: what is published is exactly
# what is committed): a tree that isn't a git checkout, or uncommitted changes
# in the chart's inputs (supervisor-collector: charts/supervisor-collector,
# the contracts' helm.ts, this script; telflo: charts/telflo,
# vendor/opamp-server/PIN, scripts/check-opamp-server-pin.sh, this script); an
# input flagged assume-unchanged or skip-worktree (git status would not see
# its changes); a checkout that is a copy inside another repository (its git
# toplevel isn't this repository's root).
#
# The chart is then taken from the commit itself: HEAD's raw blobs under
# charts/<name> (`git ls-tree`, `git cat-file blob`), written into a fresh
# temporary directory (no ignored or untracked file of the working tree is
# packaged; no local attribute, filter or line-ending setting alters them; a
# symlink or submodule is refused).
# For telflo, before anything lints it (exit 1), on HEAD's extraction and
# with no sibling opamp-server checkout:
# `git rev-parse HEAD:charts/telflo/charts/opamp-server`
# and the tree id of the extracted vendored chart must both be HEAD's
# vendor/opamp-server/PIN's chart-tree; Chart.yaml must declare exactly one
# opamp-server dependency, at oci://ghcr.io/telflo/charts, whose version, the
# vendored Chart.yaml's version and the PIN's version are one version (Helm
# passes a mismatch silently). The files the render tests read beside the
# chart (each "$REPO_DIR/<path>" HEAD's tests/ names: the Dockerfile, the
# gateway's configuration…) are HEAD's too, extracted beside it (a path
# outside [A-Za-z0-9._/-], or with a .. segment, is refused).
# From there, in order: the chart's render tests (tests/render-tests.sh) and
# `helm lint --strict` (supervisor-collector: with each role's values;
# telflo: once per tests/profiles/*.yaml, without
# --with-subcharts); `helm package` (the chart's .helmignore drops tests/);
# --package stops there. A dry run then asks the registry whether the version
# exists (`crane manifest <reference without oci://>:<version>`):
#   - a manifest: published already: refused (a published version is never
#     overwritten; a fix is a new version);
#   - MANIFEST_UNKNOWN or NAME_UNKNOWN: absent, go on;
#   - anything else (a new or private package answers an anonymous read so):
#     the dry run says it can't tell, printing crane's error line, and goes on.
# It prints the exact push, `helm push '<package>' '<reference minus its last
# segment>'` (with --plain-http first for a loopback registry).
#
# It never logs in to a registry. The registry is read (crane: DOCKER_CONFIG's
# config.json) and written (helm: HELM_REGISTRY_CONFIG) with the
# caller's HELM_REGISTRY_CONFIG and DOCKER_CONFIG once checked (the configuration
# holding the caller's login); when either is unset, a temporary one holding
# no login is used, so no credential helper is ever consulted. A file the
# caller named (HELM_REGISTRY_CONFIG; DOCKER_CONFIG/config.json) is refused
# (exit 1, its content never printed) when it is missing or can't be read,
# isn't JSON, has no "auths" object or an empty one (Docker would then
# consult the keychain's helper: it must name the registry's login), has
# a "credsStore" or "credHelpers" key in any spelling (Go's encoding/json
# matches keys case-insensitively), or has a key that folds to "auths" but
# isn't "auths". Every other
# HELM_* setting is unset; Helm's cache, config and data homes are in the
# temporary directory, removed on exit. crane is scripts/release/tools.sh's
# checked one, else `crane` on PATH; the script never downloads it. bash 3.2
# compatible (macOS's /bin/bash).
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." >/dev/null && pwd)"

# No inherited GIT_* setting (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*…) may
# change which repository, index or configuration git reads.
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
# Local `git replace` objects never stand in for HEAD's.
export GIT_NO_REPLACE_OBJECTS=1
CONTRACTS="$ROOT/telflo-core/packages/contracts/src/helm.ts"
# The contracts' HELM_CHART_REFERENCE_PATTERN.
REFERENCE_RE='^oci://[a-z0-9]+([._:/-][a-z0-9]+)*$'
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
NAME_RE='^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
# An older registry path that isn't this repository's: never pushed to.
OLD_CHARTS="oci://ghcr.io/telflo/charts/"
NO_LOGIN='{"auths":{"telflo-publish.invalid":{}}}'
# telflo's row: its fixed reference; the PIN and the vendored opamp-server
# chart, with the repository its dependency is declared at.
PLATFORM_REFERENCE="oci://ghcr.io/telflo/telflo/charts/telflo"
PIN_PATH=vendor/opamp-server/PIN
SUBCHART_PATH=charts/telflo/charts/opamp-server
SUBCHART_REPOSITORY=oci://ghcr.io/telflo/charts
# Where --registry, --namespace and --push-package publish:
# <registry>/<the namespace's path>/charts (CHARTS_PATH, set once the
# namespace is read).
CHART_LAYER_TYPE="application/vnd.cncf.helm.chart.content.v1.tar+gzip"

# The release helpers: the registry and crane.
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"

usage() {
  cat >&2 <<'EOF'
usage: scripts/publish-chart.sh --dry-run [--registry <r>] [--namespace <n>]          check everything, print the push, push nothing
       scripts/publish-chart.sh --package <dir>                                      every check but the registry's, then the package into <dir>
       scripts/publish-chart.sh --push-package <tgz> [--registry <r>] [--namespace <n>]  push that package
       each with --chart <name>: supervisor-collector (the default) or telflo
       registry: ghcr.io (the default), 127.0.0.1:<port> or localhost:<port>
       namespace: telflo (the default, the public one) or, for --chart telflo, telflo-staging (a release's stage)
EOF
}
fail() { echo "publish-chart: $1" >&2; exit 1; }
refuse() { echo "publish-chart: $1" >&2; exit 2; }
refuse_usage() { echo "publish-chart: $1" >&2; usage; exit 2; }
note() { echo "publish-chart: $1" >&2; }

# extract_head_dir <path in the repository> <destination>: HEAD's raw blobs
# under the path, written below the destination at their repository paths
# (`git ls-tree` then `git cat-file blob`): no attribute, filter or
# line-ending conversion of the local git setup applies, as `git archive`'s
# would. A symlink or a submodule is refused, naming its path; the executable
# mode (100755) is kept. Each file written must hash to its tree entry. The
# listing is written to a file first and git's status checked: a git error
# midway (an unreadable or corrupt tree object) is refused, never a truncated
# chart extracted.
extract_head_dir() {
  local entry meta path mode rest sha count=0 tab=$'\t'
  git -C "$ROOT" ls-tree -r -z --full-tree HEAD -- "$1" >"$tmp/ls-tree.list" \
    || fail "can't list HEAD's $1 (git ls-tree failed): refused, nothing packaged or pushed"
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
  done <"$tmp/ls-tree.list"
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

# tree_id <directory>: the git tree id of the directory's files, as git
# would hash them (a regular file's bytes and its executable bit), nothing
# written; fails on anything but a regular file or a folder. For the
# extraction, so that what is packaged is itself the tree the PIN names (a
# tampered tree object can't stand in).
tree_id() {
  python3 -I - "$1" <<'PY_TREE'
import hashlib, os, stat, sys
def tree_id(path):
    entries = []
    for name in os.listdir(path):
        full = os.path.join(path, name)
        st = os.lstat(full)
        raw = os.fsencode(name)
        if stat.S_ISDIR(st.st_mode):
            entries.append((raw + b"/", b"40000", raw, tree_id(full)))
        elif stat.S_ISREG(st.st_mode):
            with open(full, "rb") as f:
                data = f.read()
            mode = b"100755" if st.st_mode & 0o100 else b"100644"
            entries.append((raw, mode, raw, hashlib.sha1(b"blob %d\0" % len(data) + data).digest()))
        else:
            sys.exit(1)
    # git orders a tree by name, a folder named as if it ended in "/".
    entries.sort(key=lambda e: e[0])
    body = b"".join(mode + b" " + raw + b"\0" + digest for _, mode, raw, digest in entries)
    return hashlib.sha1(b"tree %d\0" % len(body) + body).digest()
print(tree_id(sys.argv[1]).hex())
PY_TREE
}

# check_vendored_chart: telflo's vendored opamp-server chart, on HEAD's
# extraction, before anything lints it. Offline: no sibling opamp-server
# checkout, no registry.
check_vendored_chart() {
  local pin pin_version pin_tree head_tree extracted_tree declared declared_version declared_repository vendored_version
  command -v python3 >/dev/null 2>&1 || fail "python3 is required to hash the vendored opamp-server chart"
  extract_head_dir "$PIN_PATH" "$tmp/source"
  pin="$tmp/source/$PIN_PATH"
  pin_version="$(pin_value "$pin" version '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*')" || exit $?
  pin_tree="$(pin_value "$pin" chart-tree '[0-9a-f]\{40\}')" || exit $?
  # The vendored tree: HEAD's, and the extraction's own, are the PIN's.
  head_tree="$(git -C "$ROOT" rev-parse --verify --quiet "HEAD:$SUBCHART_PATH")" \
    || fail "HEAD has no $SUBCHART_PATH: the opamp-server chart is vendored there, unpacked"
  [ "$head_tree" = "$pin_tree" ] \
    || fail "HEAD's $SUBCHART_PATH is tree $head_tree, but $PIN_PATH's chart-tree is $pin_tree: the vendored chart must be the PIN's release, byte for byte (nothing packaged or pushed)"
  extracted_tree="$(tree_id "$tmp/source/$SUBCHART_PATH")" || extracted_tree=""
  [ "$extracted_tree" = "$pin_tree" ] \
    || fail "the extracted $SUBCHART_PATH doesn't hash to $PIN_PATH's chart-tree $pin_tree: refused (a local substitution of git objects)"
  # One version: the parent's dependency, the vendored Chart.yaml's, the PIN's.
  declared="$(declared_dependency "$CHART_DIR/Chart.yaml")"
  declared_version="$(printf '%s\n' "$declared" | sed -n 1p)"
  declared_repository="$(printf '%s\n' "$declared" | sed -n 2p)"
  [ -n "$declared_version" ] \
    || fail "HEAD's $CHART_PATH/Chart.yaml must declare exactly one dependency named opamp-server, with its version"
  [ "$declared_version" = "$pin_version" ] \
    || fail "HEAD's $CHART_PATH/Chart.yaml declares opamp-server $declared_version, but $PIN_PATH says $pin_version"
  [ "$declared_repository" = "$SUBCHART_REPOSITORY" ] \
    || fail "HEAD's $CHART_PATH/Chart.yaml's opamp-server dependency is at '$declared_repository', not $SUBCHART_REPOSITORY"
  vendored_version="$(sed -n 's/^version:[ ]*"\{0,1\}\([^" ]*\)"\{0,1\}[ ]*$/\1/p' "$tmp/source/$SUBCHART_PATH/Chart.yaml")"
  [ "$vendored_version" = "$pin_version" ] \
    || fail "HEAD's $SUBCHART_PATH/Chart.yaml's version is '$vendored_version', but $PIN_PATH says $pin_version"
  note "the vendored opamp-server chart is $PIN_PATH's: tree $pin_tree, version $pin_version"
}
# pin_value <PIN> <key> <sed pattern>: the key's one value in the PIN.
pin_value() {
  local found count
  found="$(sed -n "s/^$2=\\($3\\)\$/\\1/p" "$1")"
  count="$(printf '%s' "$found" | grep -c '' || true)"
  [ "$count" -eq 1 ] || fail "HEAD's $PIN_PATH must have exactly one valid $2= line, found $count"
  printf '%s\n' "$found"
}
# declared_dependency <Chart.yaml>: the version the chart declares for its
# opamp-server dependency, then its repository, one a line (read as text:
# exactly one dependency named opamp-server, each key on its own line; as
# scripts/check-opamp-server-pin.sh reads it).
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
    }' "$1"
}

mode=""
package_dir=""
package_file=""
registry=""
chart=""
namespace=telflo
namespace_given=false
set_mode() { # <--mode>
  [ -z "$mode" ] || refuse_usage "one mode: --dry-run, --package or --push-package (got --$mode and $1)"
  mode="${1#--}"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) set_mode "$1"; shift ;;
    --package)
      set_mode "$1"
      [ $# -ge 2 ] || refuse_usage "--package needs a folder"
      package_dir="$2"; shift 2 ;;
    --push-package)
      set_mode "$1"
      [ $# -ge 2 ] || refuse_usage "--push-package needs a package (.tgz)"
      package_file="$2"; shift 2 ;;
    --push)
      refuse_usage "unknown argument: --push (removed: make the package with --package <dir>, test it, then push that same file with --push-package <tgz>)" ;;
    --registry)
      [ $# -ge 2 ] || refuse_usage "--registry needs a value"
      registry="$2"; shift 2 ;;
    --namespace)
      [ $# -ge 2 ] || refuse_usage "--namespace needs a value"
      namespace="$2"; namespace_given=true; shift 2 ;;
    --chart)
      [ -z "$chart" ] || refuse_usage "--chart given more than once"
      [ $# -ge 2 ] || refuse_usage "--chart needs a chart's name"
      case "$2" in
        supervisor-collector | telflo) chart="$2"; shift 2 ;;
        *) refuse_usage "unknown chart: '$2' (supervisor-collector or telflo)" ;;
      esac ;;
    -h|--help) usage; exit 0 ;;
    *) refuse_usage "unknown argument: $1" ;;
  esac
done
[ -n "$mode" ] || refuse_usage "--dry-run, --package or --push-package is required"
chart="${chart:-supervisor-collector}"
namespace_path="$(telflo_namespace_path "$namespace")" \
  || refuse_usage "--namespace must be telflo (the public one) or telflo-staging (a release's stage) (got '$namespace')"
if $namespace_given; then
  [ "$mode" != package ] || refuse_usage "--namespace goes with --dry-run and --push-package only (--package reads no registry)"
  [ "$chart" = telflo ] || [ "$namespace" = telflo ] \
    || refuse_usage "--namespace $namespace goes with --chart telflo only: the supervisor-collector chart is published to the public namespace alone"
fi
CHARTS_PATH="$namespace_path/charts"
[ -z "${TELFLO_HELM_CHART_REFERENCE:-}" ] \
  || refuse "TELFLO_HELM_CHART_REFERENCE is refused: the charts' references are fixed (oci://ghcr.io/telflo/telflo/charts/<name>, or a loopback registry's through --registry); unset it"
registry_given=false
if [ -n "$registry" ]; then
  registry_given=true
  [ "$mode" != package ] || refuse_usage "--registry goes with --dry-run and --push-package only (--package reads no registry)"
fi
registry="${registry:-ghcr.io}"
telflo_registry_ok "$registry" \
  || refuse_usage "--registry must be ghcr.io or a loopback registry, 127.0.0.1:<port> or localhost:<port> (got '$registry')"
if [ "$mode" = package ]; then
  [ -n "$package_dir" ] && [ -d "$package_dir" ] || refuse_usage "--package's folder must be an existing directory (got '$package_dir')"
  package_dir="$(CDPATH='' cd -- "$package_dir" >/dev/null && pwd)"
fi
if [ "$mode" = push-package ]; then
  [ -n "$package_file" ] && [ -f "$package_file" ] && [ ! -L "$package_file" ] \
    || refuse_usage "--push-package's package must be an existing file (got '$package_file')"
  package_file="$(CDPATH='' cd -- "$(dirname -- "$package_file")" >/dev/null && pwd)/$(basename -- "$package_file")"
fi

# The chart's row: where it is, and its inputs, relative to the repository
# (uncommitted changes in them refused).
case "$chart" in
  supervisor-collector)
    CHART_PATH=charts/supervisor-collector
    CHART_INPUTS=(charts/supervisor-collector telflo-core/packages/contracts/src/helm.ts scripts/publish-chart.sh)
    ;;
  telflo)
    CHART_PATH=charts/telflo
    CHART_INPUTS=(charts/telflo "$PIN_PATH" scripts/check-opamp-server-pin.sh scripts/publish-chart.sh)
    ;;
esac
CHART_DIR="$ROOT/$CHART_PATH"

# exactly_one <sed expression> <file> <what>: the one value the expression
# prints from the file; refused unless exactly one line matches.
exactly_one() {
  local found count
  [ -f "$2" ] || refuse "$3: $2 is missing"
  found="$(sed -n "$1" "$2")"
  count="$(printf '%s' "$found" | grep -c '' || true)"
  [ "$count" -eq 1 ] || refuse "$3: expected exactly one line in $2, found $count"
  printf '%s\n' "$found"
}
# Chart.yaml's name and version are read from the working tree (the dirty and
# flag checks below make it HEAD's); HEAD's package cross-checks them: it is
# packaged from HEAD's extraction and must be named <name>-<version>.tgz.
if [ "$chart" = supervisor-collector ]; then
  default_reference="$(exactly_one 's/^export const DEFAULT_HELM_CHART_REFERENCE = "\([^"]*\)";$/\1/p' "$CONTRACTS" \
    "the contracts' DEFAULT_HELM_CHART_REFERENCE")" || exit $?
  default_version="$(exactly_one 's/^export const DEFAULT_HELM_CHART_VERSION = "\([^"]*\)";$/\1/p' "$CONTRACTS" \
    "the contracts' DEFAULT_HELM_CHART_VERSION")" || exit $?
fi
chart_name="$(exactly_one 's/^name: \(.*\)$/\1/p' "$CHART_DIR/Chart.yaml" "Chart.yaml's name")" || exit $?
chart_version="$(exactly_one 's/^version: \(.*\)$/\1/p' "$CHART_DIR/Chart.yaml" "Chart.yaml's version")" || exit $?

[[ "$chart_name" =~ $NAME_RE ]] || refuse "Chart.yaml's name must match $NAME_RE (got '$chart_name')"
[[ "$chart_version" =~ $VERSION_RE ]] || refuse "Chart.yaml's version must be x.y.z (got '$chart_version')"
if [ "$chart" = supervisor-collector ]; then
  [[ "$default_reference" =~ $REFERENCE_RE ]] \
    || refuse "the contracts' DEFAULT_HELM_CHART_REFERENCE must match $REFERENCE_RE (got '$default_reference')"
  [ "${default_reference##*/}" = "$chart_name" ] \
    || refuse "Chart.yaml's name '$chart_name' is not the last segment of the contracts' DEFAULT_HELM_CHART_REFERENCE ('$default_reference')"
  [ "$chart_version" = "$default_version" ] \
    || refuse "Chart.yaml's version '$chart_version' is not the contracts' DEFAULT_HELM_CHART_VERSION ('$default_version'): bump both together"
  reference="$default_reference"
  bump_hint="bump Chart.yaml's version and DEFAULT_HELM_CHART_VERSION together"
else
  # The platform's release is one version: the chart's, its appVersion and
  # every platform image's tag.
  app_version="$(exactly_one 's/^appVersion: "\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$CHART_DIR/Chart.yaml" \
    "Chart.yaml's appVersion")" || exit $?
  [ "$app_version" = "$chart_version" ] \
    || refuse "Chart.yaml's appVersion '$app_version' is not its version '$chart_version': the platform's release is one version (bump both together)"
  reference="$PLATFORM_REFERENCE"
  bump_hint="bump Chart.yaml's version and appVersion together"
fi

# --registry, --namespace and --push-package: the reference is fixed under
# the registry and the namespace.
if $registry_given || $namespace_given || [ "$mode" = push-package ]; then
  reference="oci://$registry/$CHARTS_PATH/$chart_name"
fi
[[ "$reference" =~ $REFERENCE_RE ]] \
  || refuse "the chart reference must match $REFERENCE_RE (got '$reference')"
[[ "${reference#oci://}" == */* ]] || refuse "the chart reference must name a registry and a repository (got '$reference')"
[ "${reference##*/}" = "$chart_name" ] \
  || refuse "the chart reference's last segment must be the chart's name '$chart_name' (got '$reference')"
case "$reference" in
  "$OLD_CHARTS"*) refuse "$reference is under $OLD_CHARTS, an older registry path that isn't this repository's (the platform's charts are under oci://ghcr.io/telflo/telflo/charts/)" ;;
esac
destination="${reference%/*}"

# What is published is exactly what is committed.
# The checkout must be this repository's own (not a copy inside another).
toplevel="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$toplevel" ] && [ "$toplevel" = "$(CDPATH= cd -- "$ROOT" >/dev/null && pwd -P)" ] \
  || fail "publishing needs a git checkout: what is published is exactly what is committed"
# An input git is told not to check (assume-unchanged: a lowercase tag;
# skip-worktree: S) would hide its changes from git status.
flagged="$(git -C "$ROOT" ls-files -v -- "${CHART_INPUTS[@]}" | awk '{
    t = substr($0, 1, 1); f = substr($0, 3)
    if (t ~ /^[a-z]$/) print "assume-unchanged: " f
    if (toupper(t) == "S") print "skip-worktree: " f
  }')" || fail "can't read git's flags for the chart's inputs"
if [ -n "$flagged" ]; then
  echo "publish-chart: refuses inputs flagged for git not to check (git update-index --no-assume-unchanged / --no-skip-worktree them first, or git sparse-checkout disable):" >&2
  printf '%s\n' "$flagged" >&2
  exit 1
fi
dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all -- "${CHART_INPUTS[@]}")" \
  || fail "can't read git status for the chart's inputs"
if [ -n "$dirty" ]; then
  echo "publish-chart: refuses uncommitted changes in the chart's inputs (commit them first: what is published is exactly what is committed):" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

command -v helm >/dev/null 2>&1 || fail "helm is not on PATH"

# Helm's environment: the caller's registry configuration only; everything
# else of Helm's in the temporary directory.
caller_registry_config="${HELM_REGISTRY_CONFIG:-}"
caller_docker_config="${DOCKER_CONFIG:-}"
for v in $(env | sed -n 's/^\(HELM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
tmp="$(mktemp -d "${TMPDIR:-/tmp}/publish-chart.XXXXXX")" || fail "no temporary directory"
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then fail "no temporary directory"; fi
trap 'rm -rf "$tmp"' EXIT
[[ "$tmp" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "the temporary directory's path ($tmp) holds characters the printed command doesn't quote"
mkdir -p "$tmp/helm/cache" "$tmp/helm/config" "$tmp/helm/data" "$tmp/package" "$tmp/kube" "$tmp/values"
export HELM_CACHE_HOME="$tmp/helm/cache" HELM_CONFIG_HOME="$tmp/helm/config" HELM_DATA_HOME="$tmp/helm/data"
export KUBECONFIG="$tmp/kube/config"
if [ -n "$caller_registry_config" ]; then
  export HELM_REGISTRY_CONFIG="$caller_registry_config"
else
  (umask 077 && printf '%s\n' "$NO_LOGIN" >"$tmp/registry.json")
  export HELM_REGISTRY_CONFIG="$tmp/registry.json"
fi
if [ -z "$caller_docker_config" ]; then
  mkdir -p "$tmp/docker"
  (umask 077 && printf '%s\n' "$NO_LOGIN" >"$tmp/docker/config.json")
  export DOCKER_CONFIG="$tmp/docker"
fi
# The caller's credential files, before Helm runs at all.
if [ -n "$caller_registry_config" ]; then check_caller_credentials HELM_REGISTRY_CONFIG "$caller_registry_config"; fi
if [ -n "$caller_docker_config" ]; then check_caller_credentials DOCKER_CONFIG "$caller_docker_config/config.json"; fi

TELFLO_OCI_PREFIX=publish-chart
TELFLO_OCI_TMP="$tmp"

# chart_layer_of <manifest file>: the chart content layer's digest (Helm
# pushes the .tgz as that one layer, so it is the file's sha256).
chart_layer_of() {
  python3 -I - "$1" "$CHART_LAYER_TYPE" 2>/dev/null <<'PY'
import json, re, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
layers = [l for l in manifest.get("layers") or [] if isinstance(l, dict) and l.get("mediaType") == sys.argv[2]]
if len(layers) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(layers[0].get("digest"))):
    sys.exit(1)
print(layers[0]["digest"])
PY
}
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi; }
push_flags=()
if telflo_registry_loopback "$registry"; then push_flags=(--plain-http); fi

# --push-package: that file, checked against HEAD's Chart.yaml, then the
# registry; nothing is rendered, linted or packaged again.
if [ "$mode" = push-package ]; then
  telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"
  members="$(tar -tzf "$package_file" 2>/dev/null)" || fail "$package_file isn't a readable .tgz"
  tops="$(printf '%s\n' "$members" | sed 's#/.*##' | sort -u)"
  [ "$tops" = "$chart_name" ] || fail "$package_file must hold one top-level folder, $chart_name (--chart $chart)"
  tar -xzOf "$package_file" "$chart_name/Chart.yaml" >"$tmp/package-Chart.yaml" 2>/dev/null \
    || fail "$package_file has no $chart_name/Chart.yaml"
  package_name="$(sed -n 's/^name:[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}[[:space:]]*$/\1/p' "$tmp/package-Chart.yaml")"
  package_version="$(sed -n 's/^version:[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}[[:space:]]*$/\1/p' "$tmp/package-Chart.yaml")"
  [ "$package_name" = "$chart_name" ] || fail "$package_file's Chart.yaml names '$package_name', not $chart_name"
  [ "$package_version" = "$chart_version" ] \
    || fail "$package_file's Chart.yaml is version '$package_version', but HEAD's $CHART_PATH/Chart.yaml is $chart_version: a package is pushed only from its own commit"
  if [ "$chart" = telflo ]; then
    package_app="$(sed -n 's/^appVersion:[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}[[:space:]]*$/\1/p' "$tmp/package-Chart.yaml")"
    [ "$package_app" = "$chart_version" ] || fail "$package_file's Chart.yaml's appVersion is '$package_app', not $chart_version"
  fi
  want="sha256:$(sha256_of "$package_file")"
  remote_ref="$registry/$CHARTS_PATH/$chart_name:$chart_version"
  status=0
  telflo_remote_manifest "$remote_ref" "$tmp/remote-manifest.json" || status=$?
  case "$status" in
    0)
      remote="$(chart_layer_of "$tmp/remote-manifest.json")" || remote=""
      if [ "$remote" = "$want" ]; then
        note "oci://$remote_ref holds this package already ($want): skipped (the same bytes)"
        printf 'oci://%s %s\n' "$remote_ref" "$want"
        exit 0
      fi
      fail "oci://$remote_ref is published already with ${remote:-another content} (not this package's $want): refused, nothing pushed (a published version is never overwritten: $bump_hint)" ;;
    3) note "oci://$remote_ref is not in the registry yet" ;;
    *) fail "can't tell whether oci://$remote_ref is published: $TELFLO_REMOTE_ANSWER (nothing pushed)" ;;
  esac
  note "pushing $package_file to $destination"
  helm push ${push_flags[@]+"${push_flags[@]}"} "$package_file" "$destination" >&2 || fail "helm push failed"
  status=0
  telflo_remote_manifest "$remote_ref" "$tmp/remote-manifest.json" || status=$?
  remote=""
  if [ "$status" -eq 0 ]; then remote="$(chart_layer_of "$tmp/remote-manifest.json")" || remote=""; fi
  [ "$remote" = "$want" ] \
    || fail "after the push, oci://$remote_ref's chart layer is '${remote:-unreadable}', not this package's $want"
  printf 'oci://%s %s\n' "$remote_ref" "$want"
  exit 0
fi
if [ "$mode" = package ]; then
  [ ! -e "$package_dir/$chart_name-$chart_version.tgz" ] \
    || fail "$package_dir/$chart_name-$chart_version.tgz exists: --package never overwrites a package (use a new folder)"
fi

# The chart as committed: HEAD's raw blobs only, never the working tree's.
mkdir -p "$tmp/source"
extract_head_dir "$CHART_PATH" "$tmp/source"
CHART_DIR="$tmp/source/$CHART_PATH"
[ -f "$CHART_DIR/Chart.yaml" ] || fail "HEAD's $CHART_PATH has no Chart.yaml"
if [ "$chart" = telflo ]; then
  check_vendored_chart
  # What the render tests read beside the chart (their REPO_DIR, the
  # extraction's root): each "$REPO_DIR/<path>" HEAD's tests/ names, HEAD's too.
  render_reads="$(grep -rhoE '"\$REPO_DIR/[^"$]+"' "$CHART_DIR/tests" | tr -d '"' | sed 's#^\$REPO_DIR/##' | sort -u)" || render_reads=""
  while IFS= read -r read_path; do
    [ -n "$read_path" ] || continue
    [[ "$read_path" =~ ^[A-Za-z0-9_][A-Za-z0-9._/-]*$ ]] && [[ "/$read_path/" != */../* ]] \
      || fail "the render tests read '$read_path' beside the chart: refused (only plain repository paths)"
    [ -e "$tmp/source/$read_path" ] || extract_head_dir "$read_path" "$tmp/source"
  done <<<"$render_reads"
fi

note "the chart's render tests"
"${BASH:-bash}" "$CHART_DIR/tests/render-tests.sh" >&2 || fail "the chart's render tests failed: nothing packaged or pushed"

if [ "$chart" = supervisor-collector ]; then
  # helm lint --strict with each role's values (placeholders: no real token).
  lint_values() { # <role> <group> [fullnameOverride]
    printf 'role: %s\ngroup: %s\ntoken: publish-lint-placeholder\nendpoint: https://publish.invalid/opamp/v1\ncollectorGroupId: 00000000-0000-4000-8000-000000000000\n' "$1" "$2"
    if [ -n "${3:-}" ]; then printf 'fullnameOverride: %s\n' "$3"; fi
  }
  lint_values node node 00000000-default >"$tmp/values/node.yaml"
  lint_values cluster cluster 00000000-cluster >"$tmp/values/cluster.yaml"
  lint_values gateway gw-lint >"$tmp/values/gateway.yaml"
  for role in node cluster gateway; do
    note "helm lint --strict ($role)"
    if ! helm lint --strict "$CHART_DIR" -f "$tmp/values/$role.yaml" >"$tmp/lint.log" 2>&1; then
      cat "$tmp/lint.log" >&2
      fail "helm lint --strict failed for the $role values: nothing packaged or pushed"
    fi
  done
else
  # helm lint --strict once per render-test profile (HEAD's), the parent
  # chart only (not --with-subcharts).
  profiles=("$CHART_DIR"/tests/profiles/*.yaml)
  [ -f "${profiles[0]}" ] || fail "HEAD's $CHART_PATH/tests/profiles has no profile"
  for profile in "${profiles[@]}"; do
    profile_name="$(basename -- "$profile" .yaml)"
    note "helm lint --strict ($profile_name)"
    if ! helm lint --strict "$CHART_DIR" -f "$profile" >"$tmp/lint.log" 2>&1; then
      cat "$tmp/lint.log" >&2
      fail "helm lint --strict failed for the $profile_name profile: nothing packaged or pushed"
    fi
  done
fi

note "helm package"
helm package "$CHART_DIR" --destination "$tmp/package" >/dev/null || fail "helm package failed"
package="$tmp/package/$chart_name-$chart_version.tgz"
[ -f "$package" ] || fail "helm package made no $chart_name-$chart_version.tgz"
[ "$(ls "$tmp/package" | grep -c '')" -eq 1 ] || fail "helm package made more than one file"

if [ "$mode" = package ]; then
  cp "$package" "$package_dir/$chart_name-$chart_version.tgz.partial" \
    && mv "$package_dir/$chart_name-$chart_version.tgz.partial" "$package_dir/$chart_name-$chart_version.tgz" \
    || fail "can't write $package_dir/$chart_name-$chart_version.tgz"
  printf '%s sha256:%s\n' "$package_dir/$chart_name-$chart_version.tgz" "$(sha256_of "$package_dir/$chart_name-$chart_version.tgz")"
  note "packaged: nothing asked of a registry, nothing pushed (--push-package pushes that file)"
  exit 0
fi

# A dry run: does the registry hold the version already?
telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"
status=0
telflo_remote_manifest "${reference#oci://}:$chart_version" "$tmp/remote-manifest.json" || status=$?
case "$status" in
  0) fail "$reference $chart_version is published already: a published version is never overwritten (a change is a new version: $bump_hint)" ;;
  3) note "$reference $chart_version is not in the registry yet" ;;
  *) note "can't tell whether $reference $chart_version is published (a new or private package answers so to an anonymous read; --push-package asks again with the caller's login): $TELFLO_REMOTE_ANSWER" ;;
esac

if [ "${#push_flags[@]}" -gt 0 ]; then
  printf "helm push --plain-http '%s' '%s'\n" "$package" "$destination"
else
  printf "helm push '%s' '%s'\n" "$package" "$destination"
fi
note "dry run: nothing pushed (--package makes the package, --push-package pushes that file)"
exit 0
