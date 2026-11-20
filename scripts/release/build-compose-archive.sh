#!/usr/bin/env bash
# build-compose-archive.sh: the Compose install's release archive: exactly
# deploy/compose at a commit, under one top folder telflo-compose-<version>/,
# modes kept (setup.sh 0755, the rest 0644: tar.umask 022), gzipped:
#
#   git archive --prefix=telflo-compose-<version>/ <commit>:deploy/compose | gzip -n
#
#   scripts/release/build-compose-archive.sh --out <dir> [--commit <rev>]
#
# The version is that commit's charts/telflo/Chart.yaml's (version and
# appVersion equal, a release version: scripts/release/version.sh). Only
# committed files go in: nothing untracked or ignored (a .env or secrets/
# made by trying setup.sh in the checkout stays out). It writes
# <dir>/telflo-compose-<version>.tar.gz (refused if it exists; written to a
# temporary name first) and prints its path. Exit 0 written, 1 refused, 2
# usage. bash 3.2 compatible; needs git and gzip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/release/version.sh
. "$SCRIPT_DIR/version.sh"

usage() { echo "usage: scripts/release/build-compose-archive.sh --out <dir> [--commit <rev>]" >&2; }
refuse_usage() { echo "build-compose-archive: $1" >&2; usage; exit 2; }
fail() { echo "build-compose-archive: $1" >&2; exit 1; }

out="" rev=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out | --commit)
      [ "$#" -ge 2 ] && [ -n "$2" ] || refuse_usage "$1 needs a value"
      if [ "$1" = --out ]; then
        [ -z "$out" ] || refuse_usage "--out given twice"
        out="$2"
      else
        [ -z "$rev" ] || refuse_usage "--commit given twice"
        rev="$2"
      fi
      shift 2 ;;
    *) refuse_usage "unknown argument $1" ;;
  esac
done
[ -n "$out" ] || refuse_usage "--out is required"
rev="${rev:-HEAD}"
[ -d "$out" ] || fail "--out $out isn't a folder"

commit="$(git -C "$ROOT" rev-parse --verify --quiet "$rev^{commit}")" || fail "$rev isn't a commit of this repository"
git -C "$ROOT" cat-file -e "$commit:deploy/compose" 2>/dev/null || fail "$commit has no deploy/compose"

# The commit's Chart.yaml, read through a temporary file.
work="$(mktemp -d "${TMPDIR:-/tmp}/build-compose-archive.XXXXXX")" || fail "couldn't make a temporary folder"
trap 'rm -rf "$work"' EXIT
git -C "$ROOT" show "$commit:charts/telflo/Chart.yaml" >"$work/Chart.yaml" 2>/dev/null ||
  fail "$commit has no charts/telflo/Chart.yaml"
version="$(telflo_chart_field "$work/Chart.yaml" version)" || fail "$commit's charts/telflo/Chart.yaml has no single version line"
app_version="$(telflo_chart_field "$work/Chart.yaml" appVersion)" || fail "$commit's charts/telflo/Chart.yaml has no single appVersion line"
telflo_version_ok "$version" || fail "$commit's charts/telflo/Chart.yaml version '$version' isn't a release version (MAJOR.MINOR.PATCH)"
[ "$app_version" = "$version" ] || fail "$commit's charts/telflo/Chart.yaml appVersion ($app_version) differs from its version ($version)"

name="telflo-compose-$version"
file="$out/$name.tar.gz"
if [ -e "$file" ] || [ -L "$file" ]; then
  fail "$file exists already: refused (it never overwrites an archive)"
fi
partial="$out/.$name.tar.gz.partial.$$"
trap 'rm -rf "$work"; rm -f "$partial"' EXIT
git -C "$ROOT" -c tar.umask=022 archive --format=tar --prefix="$name/" "$commit:deploy/compose" | gzip -n -9 >"$partial" ||
  fail "git archive or gzip failed: nothing written"
# A new name only: mv -n never replaces a file that appeared meanwhile.
mv -n "$partial" "$file"
[ ! -e "$partial" ] || fail "$file appeared meanwhile: refused, nothing overwritten"
echo "$file"
