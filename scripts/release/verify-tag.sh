#!/usr/bin/env bash
# verify-tag.sh: a release tag is checked before anything builds, in the
# release workflow's `version` job and in scripts/release/rehearse.sh.
#
#   scripts/release/verify-tag.sh <tag> [--registry <r>] [--expect <sha>]
#
# In this order, the first failure stopping it (exit 1):
#   1. the tag is v<version>, the version x.y.z (scripts/release/version.sh:
#      digits only, no leading zeros, nothing after). Nothing else reads the
#      tag before this check, and a tag that fails it is never printed;
#   2. the repository holds its full history (not a shallow clone: the
#      ancestry check below needs it);
#   3. refs/tags/<tag> is an annotated tag: a tag object (a lightweight tag
#      is refused, with the `git tag -a` hint), whose own name is <tag> and
#      which tags a commit. In a workflow only (CI set, not ""/false/0:
#      oci.sh's rule), when the checkout holds the tag as a lightweight one
#      (actions/checkout may store an annotated tag so), GitHub's API is
#      asked instead, with the job's token (GH_TOKEN, which `gh` reads
#      from the environment: never on argv, in a file or in the output):
#      GET repos/<GITHUB_REPOSITORY>/git/ref/tags/<tag> must answer that ref
#      with an object of type `tag`, and GET repos/<repository>/git/tags/
#      <that sha> a tag object named <tag> whose object is the commit the
#      checkout's tag names (the one the checks below read;
#      scripts/release/github-tag.sh). The repository must be owner/name
#      (GitHub's characters), and then telflo/telflo, before it goes into a
#      path; no GH_TOKEN, no gh, an API error, an unexpected answer or
#      another commit refuses the tag. Outside a workflow a lightweight tag
#      is refused as above, the API never asked. GH_TOKEN is unset once this
#      step is done: no later command (git, crane) gets it;
#   4. with --expect <sha> (the workflow's github.sha): that sha is the tag
#      object's or its commit's (the tag wasn't moved after the push);
#   5. charts/telflo/Chart.yaml at the tag's commit holds the version as
#      both `version` and `appVersion`;
#   6. the tag's commit is on main: `git merge-base --is-ancestor <commit>
#      refs/remotes/origin/main` (only admins tag; a release is a commit on
#      main);
#   7. nothing of the version is published or staged: none of the five
#      images <registry>/<namespace>/<api|web|otelcol-validator|
#      otelcol-testing|ottl-evaluator>:<version> nor the chart
#      <registry>/<namespace>/charts/telflo:<version> exists, in either of
#      oci.sh's two namespaces (telflo_namespace_path): telflo/telflo, the
#      public one, and telflo/telflo-staging, a release's stage. Each is
#      asked with `crane digest`: a digest in the public one means published
#      (refused: that version is spent, a fix is the next patch); a digest
#      in the stage means a stage of the version is open (refused: it is
#      finalized, or abandoned first with `scripts/release/steps.sh
#      abandon-stage`, so a stale stage is never promoted by mistake); the
#      registry's MANIFEST_UNKNOWN or NAME_UNKNOWN means absent; any other
#      answer can't tell (refused too). Every one is asked, then every
#      problem named.
# Then it prints `tag=<tag>`, `version=<version>` and `commit=<sha>`, one a
# line, and appends the same lines to $GITHUB_OUTPUT when that is set (the
# job's outputs).
#
# --registry is ghcr.io (the default) or a loopback 127.0.0.1:<port> or
# localhost:<port> (the rehearsal's). The repository is the one this script
# is in. crane reads the caller's DOCKER_CONFIG once checked (the job's
# login, for private packages), else a temporary one holding no login; it
# never logs in. crane: scripts/release/tools.sh's (in a workflow only that
# one, oci.sh's rule). Exit 0 passed; 1 refused; 2 usage. bash 3.2
# compatible.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." >/dev/null && pwd)"
# No inherited GIT_* setting may change which repository or objects git reads.
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
export GIT_NO_REPLACE_OBJECTS=1
# shellcheck source=scripts/release/version.sh
. "$ROOT/scripts/release/version.sh"
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"
# shellcheck source=scripts/release/github-tag.sh
. "$ROOT/scripts/release/github-tag.sh"

IMAGES="api web otelcol-validator otelcol-testing ottl-evaluator"
CHART_YAML="charts/telflo/Chart.yaml"
MAIN_REF="refs/remotes/origin/main"

usage() { echo "usage: scripts/release/verify-tag.sh <tag> [--registry ghcr.io|127.0.0.1:<port>|localhost:<port>] [--expect <sha>]" >&2; }
refuse_usage() { echo "verify-tag: $1" >&2; usage; exit 2; }
fail() { echo "verify-tag: refused: $1" >&2; exit 1; }
note() { echo "verify-tag: $1" >&2; }

tag="" tag_given=false registry="ghcr.io" expect=""
while [ $# -gt 0 ]; do
  case "$1" in
    --registry) [ $# -ge 2 ] || refuse_usage "--registry needs a value"; registry="$2"; shift 2 ;;
    --expect) [ $# -ge 2 ] || refuse_usage "--expect needs a value"; expect="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) refuse_usage "unknown option (the tag is the one argument)" ;;
    *)
      $tag_given && refuse_usage "one tag only"
      tag="$1"; tag_given=true; shift ;;
  esac
done
$tag_given || refuse_usage "the tag is required"
telflo_registry_ok "$registry" \
  || refuse_usage "--registry must be ghcr.io or a loopback registry, 127.0.0.1:<port> or localhost:<port>"
if [ -n "$expect" ]; then
  [[ "$expect" =~ ^[0-9a-f]{40}$ ]] || refuse_usage "--expect must be a full 40-hex sha"
fi

# 1. The pattern, before anything reads the tag (and it is never printed
# when it fails).
case "$tag" in v*) version="${tag#v}" ;; *) version="" ;; esac
if [ -z "$version" ] || ! telflo_version_ok "$version"; then
  fail "the tag isn't v<x.y.z> (digits only, no leading zeros, nothing after: a release tag is vMAJOR.MINOR.PATCH)"
fi

git_() { git -C "$ROOT" "$@"; }
git_ rev-parse --git-dir >/dev/null 2>&1 || fail "$ROOT isn't a git repository"

# 2. The full history.
[ "$(git_ rev-parse --is-shallow-repository 2>/dev/null)" = false ] \
  || fail "the repository is a shallow clone: the main-ancestry check needs the full history (fetch-depth: 0)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-tag.XXXXXX")" || fail "no temporary directory"
[ -n "$tmp" ] && [ -d "$tmp" ] || fail "no temporary directory"
trap 'rm -rf "$tmp"' EXIT

LIGHTWEIGHT_HINT="$(telflo_lightweight_hint "$tag")"

# github_tag_object <commit>: in a workflow, the tag as GitHub holds it
# (scripts/release/github-tag.sh, shared with steps.sh github-release). Sets
# tag_object, or refuses.
github_tag_object() {
  local want="$1"
  telflo_github_tag_object "${GITHUB_REPOSITORY:-}" "$tag" "$want" "this checkout's" "$tmp" \
    || fail "$TELFLO_GITHUB_PROBLEM (and $tag is lightweight in this checkout)"
  tag_object="$TELFLO_GITHUB_TAG_OBJECT"
  note "$tag is lightweight in this checkout; on GitHub it is the annotated tag $tag_object of $want (asked with the job's token)"
}

# 3. An annotated tag, named so, tagging a commit.
ref="refs/tags/$tag"
git_ rev-parse -q --verify "$ref" >/dev/null || fail "there is no tag $tag (refs/tags/$tag)"
type="$(git_ cat-file -t "$ref")"
if [ "$type" = tag ]; then
  tag_object="$(git_ rev-parse "$ref")"
  header="$(git_ cat-file tag "$tag_object" | sed '/^$/q')"
  [ "$(printf '%s\n' "$header" | sed -n 's/^tag //p')" = "$tag" ] || fail "the tag object under $ref isn't named $tag"
  [ "$(printf '%s\n' "$header" | sed -n 's/^type //p')" = commit ] || fail "$tag doesn't tag a commit"
  commit="$(printf '%s\n' "$header" | sed -n 's/^object //p')"
elif [ "$type" = commit ] && telflo_in_ci; then
  commit="$(git_ rev-parse "$ref")"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "$tag's commit isn't in the repository"
  github_tag_object "$commit"
else
  fail "$tag is a lightweight tag: $LIGHTWEIGHT_HINT"
fi
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] && [ "$(git_ cat-file -t "$commit" 2>/dev/null)" = commit ] || fail "$tag's commit isn't in the repository"
# The token's last use was the API's: nothing after this (git, crane) gets it.
unset GH_TOKEN GITHUB_TOKEN

# 4. The tag the workflow was started for.
if [ -n "$expect" ] && [ "$expect" != "$commit" ] && [ "$expect" != "$tag_object" ]; then
  fail "$tag is now $tag_object (commit $commit), not the $expect the run was started for: was it moved?"
fi

# 5. The chart's version at the tag's commit.
TELFLO_OCI_PREFIX=verify-tag
TELFLO_OCI_TMP="$tmp"
git_ show "$commit:$CHART_YAML" >"$tmp/Chart.yaml" 2>/dev/null || fail "$tag's commit has no $CHART_YAML"
chart_version="$(telflo_chart_field "$tmp/Chart.yaml" version)" || chart_version=""
app_version="$(telflo_chart_field "$tmp/Chart.yaml" appVersion)" || app_version=""
if [ "$chart_version" != "$version" ] || [ "$app_version" != "$version" ]; then
  fail "$CHART_YAML at $tag has version '$chart_version' and appVersion '$app_version': both must be $version (the tag's)"
fi

# 6. On main.
git_ rev-parse -q --verify "$MAIN_REF" >/dev/null || fail "there is no $MAIN_REF (the main branch, fetched with the full history)"
git_ merge-base --is-ancestor "$commit" "$MAIN_REF" || fail "$tag's commit $commit isn't on main: a release is tagged on main only"

# 7. Nothing of the version published.
telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane"
telflo_docker_config || exit 1
problems=0
ask() { # public|staged <ref>
  local status=0
  telflo_remote_digest "$2" || status=$?
  case "$1:$status" in
    public:3) note "$2: not published" ;;
    staged:3) note "$2: not staged" ;;
    public:0) echo "verify-tag: $2 is published already ($TELFLO_REMOTE_DIGEST): version $version is spent, a fix is the next patch version" >&2
       problems=$((problems + 1)) ;;
    staged:0) echo "verify-tag: $2 is staged already ($TELFLO_REMOTE_DIGEST): finalize that stage, or abandon it first (scripts/release/steps.sh abandon-stage --version $version)" >&2
       problems=$((problems + 1)) ;;
    *) echo "verify-tag: can't tell whether $2 exists: $TELFLO_REMOTE_ANSWER" >&2
       problems=$((problems + 1)) ;;
  esac
}
public="$registry/$(telflo_namespace_path telflo)"
staged="$registry/$(telflo_namespace_path telflo-staging)"
for image in $IMAGES; do ask public "$public/$image:$version"; done
ask public "$public/charts/telflo:$version"
for image in $IMAGES; do ask staged "$staged/$image:$version"; done
ask staged "$staged/charts/telflo:$version"
[ "$problems" -eq 0 ] || fail "$problems of the version's images and chart are published or staged, or can't be told: nothing builds"

out="$(printf 'tag=%s\nversion=%s\ncommit=%s\n' "$tag" "$version" "$commit")"
printf '%s\n' "$out"
if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s\n' "$out" >>"$GITHUB_OUTPUT"; fi
note "$tag passed: annotated, $CHART_YAML's version, on main, nothing of $version published or staged on $registry"
