#!/usr/bin/env bash
# promote.sh: a release's stage made public, by digest: the five images and
# the chart telflo copied from the staging namespace to the public one under
# the version, the same bytes, each copy checked by digest. The finalize
# workflow's step (.github/workflows/finalize.yml); scripts/release/rehearse.sh
# runs it against its throwaway registry.
#
#   scripts/release/promote.sh --version <v> --digests <file> [--registry <r>]
#
# <file> is the stage's digests.txt (steps.sh digests writes it, the draft
# GitHub Release holds it): one `<name> sha256:<hex>` line for each image
# (api, otelcol-testing, otelcol-validator, ottl-evaluator, web: its index
# digest), then `charts/telflo` (the chart's OCI manifest digest) and
# `charts/telflo.tgz` (its package's sha256), exactly in that order
# (scripts/release/oci.sh, telflo_digests_ok). With <staged> =
# <registry>/telflo/telflo-staging and <public> = <registry>/telflo/telflo:
#   1. the stage, every artifact asked before anything is copied: each
#      image's <staged>/<name>:<v> and <staged>/<name>@<digest> answer the
#      line's digest (`crane digest`); the chart's
#      <staged>/charts/telflo:<v> and @<digest> answer its line, and its
#      manifest is a Helm chart whose one content layer is the package
#      line's sha256;
#   2. the public tags, every one asked before anything is copied:
#      <public>/<name>:<v> and <public>/charts/telflo:<v> absent (MANIFEST_
#      UNKNOWN or NAME_UNKNOWN) are copied; one holding the line's digest is
#      skipped with a line (a re-run finishing a promote that stopped part
#      way); one holding another digest, or one the registry can't answer
#      for, refuses the run, nothing copied (a public tag is never
#      overwritten);
#   3. each absent one: `crane copy <staged>/<name>@<digest> <public>/<name>:<v>`
#      (by digest: the index with its platforms and attestation manifests,
#      byte for byte; nothing is rebuilt, repackaged or re-tagged but the
#      version's own tag), then `crane digest` of the public tag must answer
#      the line's digest.
# It prints `<public ref>@<digest>` per artifact. Exit 0 promoted; 1 refused
# or failed (the first failure stops it, naming what wasn't tried); 2 usage.
#
# --registry is ghcr.io (the default) or a loopback 127.0.0.1:<port> or
# localhost:<port> (the rehearsal's and the self-test's). The two namespaces
# are oci.sh's (telflo_namespace_path): no argument names a repository. crane
# reads the caller's DOCKER_CONFIG once checked (the job's login), else a
# temporary one holding no login; it never logs in. crane: tools.sh's (in a
# workflow only that one, oci.sh's rule). bash 3.2 compatible.
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." >/dev/null && pwd)"
# shellcheck source=scripts/release/version.sh
. "$ROOT/scripts/release/version.sh"
# shellcheck source=scripts/release/oci.sh
. "$ROOT/scripts/release/oci.sh"

CHART_LAYER_TYPE="application/vnd.cncf.helm.chart.content.v1.tar+gzip"
CHART_CONFIG_TYPE="application/vnd.cncf.helm.config.v1+json"

usage() { echo "usage: scripts/release/promote.sh --version <v> --digests <file> [--registry ghcr.io|127.0.0.1:<port>|localhost:<port>]" >&2; }
refuse_usage() { echo "promote: $1" >&2; usage; exit 2; }
fail() { echo "promote: $1" >&2; exit 1; }
note() { echo "promote: $1" >&2; }

version="" digests="" registry="ghcr.io"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || refuse_usage "--version needs a value"; version="$2"; shift 2 ;;
    --digests) [ $# -ge 2 ] || refuse_usage "--digests needs a file"; digests="$2"; shift 2 ;;
    --registry) [ $# -ge 2 ] || refuse_usage "--registry needs a value"; registry="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) refuse_usage "unknown argument: ${1%%=*}" ;;
  esac
done
telflo_version_ok "$version" || refuse_usage "--version must be x.y.z (got '$version')"
telflo_registry_ok "$registry" \
  || refuse_usage "--registry must be ghcr.io or a loopback registry, 127.0.0.1:<port> or localhost:<port> (got '$registry')"
[ -n "$digests" ] && [ -f "$digests" ] || refuse_usage "--digests <file> must be an existing file (the stage's digests.txt)"
telflo_digests_ok "$digests" \
  || fail "$digests isn't a stage's digests.txt (one '<name> sha256:<hex>' line each: $TELFLO_DIGESTS_NAMES, in that order): nothing copied"
staged="$registry/$(telflo_namespace_path telflo-staging)"
public="$registry/$(telflo_namespace_path telflo)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/promote.XXXXXX")" || fail "no temporary directory"
[ -n "$tmp" ] && [ -d "$tmp" ] || fail "no temporary directory"
trap 'rm -rf "$tmp"' EXIT
TELFLO_OCI_PREFIX=promote
TELFLO_OCI_TMP="$tmp"
telflo_docker_config || exit 1
telflo_crane_find "$ROOT" || fail "no crane: scripts/release/tools.sh fetch crane (or the runner's pinned install on PATH)"

# chart_layer_of <manifest file>: the Helm chart's one content layer digest,
# or nothing (not a Helm chart's manifest).
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

# The artifacts: a name of the file's (an image, or charts/telflo), each with
# its line's digest.
names="$(printf '%s\n' $TELFLO_DIGESTS_NAMES | grep -vxF charts/telflo.tgz)"
package="$(telflo_digests_get "$digests" charts/telflo.tgz)"

# 1. The stage: the version's tag and the line's digest, for every artifact.
problems=0
problem() { echo "promote: $1" >&2; problems=$((problems + 1)); }
for name in $names; do
  want="$(telflo_digests_get "$digests" "$name")"
  status=0
  telflo_remote_digest "$staged/$name:$version" || status=$?
  case "$status" in
    0) [ "$TELFLO_REMOTE_DIGEST" = "$want" ] \
         || problem "$staged/$name:$version is $TELFLO_REMOTE_DIGEST, not the stage's record $want (digests.txt isn't this stage's)" ;;
    3) problem "$staged/$name:$version is missing: nothing of it is staged" ;;
    *) problem "can't tell whether $staged/$name:$version is staged: $TELFLO_REMOTE_ANSWER" ;;
  esac
  status=0
  telflo_remote_digest "$staged/$name@$want" || status=$?
  case "$status" in
    0) [ "$TELFLO_REMOTE_DIGEST" = "$want" ] || problem "$staged/$name@$want answers $TELFLO_REMOTE_DIGEST" ;;
    3) problem "$staged/$name@$want is missing" ;;
    *) problem "can't tell whether $staged/$name@$want exists: $TELFLO_REMOTE_ANSWER" ;;
  esac
  if [ "$name" = charts/telflo ]; then
    status=0
    telflo_remote_manifest "$staged/$name@$want" "$tmp/chart.json" || status=$?
    if [ "$status" -eq 0 ]; then
      layer="$(chart_layer_of "$tmp/chart.json")"
      [ -n "$layer" ] || layer="none (not a Helm chart)"
      [ "$layer" = "$package" ] \
        || problem "$staged/$name@$want's chart layer is $layer, not the stage's package $package"
    fi
  fi
done
[ "$problems" -eq 0 ] || fail "$problems problem(s) with the stage of $version: nothing copied"
note "the stage of $version is digests.txt's ($staged)"

# 2. The public tags: absent, the same digest, or refused.
copies=""
for name in $names; do
  want="$(telflo_digests_get "$digests" "$name")"
  ref="$public/$name:$version"
  status=0
  telflo_remote_digest "$ref" || status=$?
  case "$(telflo_digest_decision "$status" "$TELFLO_REMOTE_DIGEST" "$want")" in
    push) note "$ref is not public yet"; copies="$copies $name" ;;
    skip) note "$ref holds $want already: skipped (the same bytes)" ;;
    *)
      if [ "$status" -eq 0 ]; then
        problem "$ref holds $TELFLO_REMOTE_DIGEST, not the stage's $want: refused (a public tag is never overwritten; a fix is the next patch version)"
      else
        problem "can't tell whether $ref exists: $TELFLO_REMOTE_ANSWER"
      fi ;;
  esac
done
[ "$problems" -eq 0 ] || fail "$problems public tag(s) refused or unreadable: nothing copied"

# 3. The copies, each by digest, each checked by digest.
for name in $names; do
  want="$(telflo_digests_get "$digests" "$name")"
  ref="$public/$name:$version"
  case " $copies " in
    *" $name "*)
      note "copying $staged/$name@$want to $ref"
      if ! "$TELFLO_CRANE" copy "$staged/$name@$want" "$ref" >&2; then
        rest="${copies#*" $name"}"
        fail "crane copy to $ref failed${rest:+; not tried:$rest}"
      fi
      status=0
      telflo_remote_digest "$ref" || status=$?
      if [ "$status" -ne 0 ] || [ "$TELFLO_REMOTE_DIGEST" != "$want" ]; then
        rest="${copies#*" $name"}"
        fail "after the copy, $ref answers ${TELFLO_REMOTE_DIGEST:-nothing} (${TELFLO_REMOTE_ANSWER:-status $status}), not $want${rest:+; not tried:$rest}"
      fi
      note "$ref is $want" ;;
  esac
  printf '%s@%s\n' "$ref" "$want"
done
note "promoted: $version from $staged to $public, every digest the stage's"
