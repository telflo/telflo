#!/usr/bin/env bash
# check-secrets.sh: the secret scan, gitleaks (tools.lock's version,
# sha256-checked: `bash scripts/release/tools.sh fetch gitleaks` once), offline,
# from the repository's root with no argument. static.sh runs it with every
# scripts/release/check-*.sh, and the release workflow's first job runs it
# before anything builds.
#
#   bash scripts/release/check-secrets.sh [--root <dir>]
#
# It scans every file git would commit (tracked, and untracked but not
# ignored: never node_modules, .tools or a local .env), copied into a
# temporary folder, with gitleaks' own default rules (a .gitleaks.toml in the
# tree, GITLEAKS_CONFIG and GITLEAKS_CONFIG_TOML are never read) and
# --redact: a value gitleaks finds is never printed.
#
# .gitleaksignore at the root lists the findings reviewed as not secret (test
# fixtures, development-only values), one gitleaks fingerprint per line,
# <path>:<rule>:<line>, with # comments and blank lines; `gitleaks dir` reads
# the same file. The check fails on a finding the file doesn't list, and on a
# listed fingerprint gitleaks no longer finds (a line that moved or went
# away), so the list holds exactly today's reviewed findings. A fake added to
# a test is listed in the same commit, after review.
#
# --root: check-secrets.test.sh's fixtures (a git checkout). Exit 0 every
# finding is listed and every listed one found; 1 a finding not listed, a
# stale entry, or gitleaks failed; 2 usage, or no checked gitleaks.
# bash 3.2 compatible.
set -uo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
usage() {
  sed -n 's/^#   bash scripts\/release\/check-secrets\.sh /check-secrets.sh /p' "$0" >&2
  exit 2
}

root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || usage; root=$2; shift 2 ;;
    *) echo "check-secrets: unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$root" ] || root="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -d "$root" ] && root="$(cd "$root" && pwd)" || { echo "check-secrets: --root $root isn't a folder" >&2; exit 2; }
[ "$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$root" && pwd -P)" ] ||
  { echo "check-secrets: $root isn't a git checkout's root" >&2; exit 2; }

gitleaks=$(bash "$SCRIPT_DIR/tools.sh" path gitleaks 2>/dev/null) ||
  { echo "check-secrets: no checked gitleaks: run bash scripts/release/tools.sh fetch gitleaks" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/check-secrets.XXXXXX") || { echo "check-secrets: FAIL: no temporary folder" >&2; exit 1; }
trap 'rm -rf "$work"' EXIT
mkdir "$work/tree"

# The files git would commit that are there (a deleted tracked file isn't), plain files only.
(
  cd "$root" || exit 1
  git ls-files -z -co --exclude-standard |
    while IFS= read -r -d '' f; do
      [ -f "$f" ] && [ ! -L "$f" ] && printf '%s\0' "$f"
    done
) >"$work/files" || { echo "check-secrets: FAIL: cannot list the files" >&2; exit 1; }
files=$(tr -cd '\0' <"$work/files" | wc -c | tr -d ' ')
if [ "$files" -gt 0 ]; then
  (cd "$root" && tar -cf - --null -T "$work/files") | tar -xf - -C "$work/tree" ||
    { echo "check-secrets: FAIL: cannot copy the files" >&2; exit 1; }
fi
# gitleaks' own rules, and every finding: the tree's settings for it aren't read.
rm -f "$work/tree/.gitleaks.toml" "$work/tree/.gitleaksignore"

printf '{{range .}}{{.Fingerprint}}\n{{end}}' >"$work/fingerprint.tmpl"
if ! (cd "$work/tree" && env -u GITLEAKS_CONFIG -u GITLEAKS_CONFIG_TOML "$gitleaks" dir . \
  --redact --no-banner --no-color --log-level error --exit-code 0 \
  --report-format template --report-template "$work/fingerprint.tmpl" --report-path "$work/found") >"$work/log" 2>&1; then
  echo "check-secrets: FAIL: gitleaks failed:" >&2
  sed 's/^/  /' "$work/log" >&2
  exit 1
fi

sort -u "$work/found" | sed '/^$/d' >"$work/found.sorted"
if [ -f "$root/.gitleaksignore" ]; then
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$root/.gitleaksignore" | sed -e '/^#/d' -e '/^$/d' | sort -u >"$work/listed"
else
  : >"$work/listed"
fi
comm -23 "$work/found.sorted" "$work/listed" >"$work/new"
comm -13 "$work/found.sorted" "$work/listed" >"$work/stale"

found=$(wc -l <"$work/found.sorted" | tr -d ' ')
status=0
while IFS= read -r fp; do
  [ -n "$fp" ] || continue
  echo "check-secrets: FAIL: gitleaks finds a secret: $fp (<path>:<rule>:<line>). Remove it; if it is a fake (a test fixture, a development-only value), list this fingerprint in .gitleaksignore after review."
  status=1
done <"$work/new"
while IFS= read -r fp; do
  [ -n "$fp" ] || continue
  echo "check-secrets: FAIL: .gitleaksignore lists $fp, which gitleaks no longer finds: remove the line (a moved finding is listed above under its new line)."
  status=1
done <"$work/stale"
if [ "$status" = 0 ]; then
  echo "check-secrets: $files files, $found finding(s), each listed in .gitleaksignore"
fi
exit "$status"
