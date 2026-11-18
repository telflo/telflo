#!/usr/bin/env bash
# Fails if the misspelling "telflow" appears anywhere in the given tree.
# The product is telflo. See docs/conventions/naming.md.
set -uo pipefail
TARGET="${1:-.}"

if git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # Inside a git repository: scan only files that are or will become part
  # of the repository — tracked files, plus untracked files that are not
  # gitignored (so a brand-new unstaged file with the misspelling is still
  # caught). Gitignored scratch (node_modules, dist, build, coverage,
  # .superpowers/, ...) never ships and is never scanned, so it can't fail
  # a clean checkout.
  MATCHES=""
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    path="$TARGET/$file"
    grep -qil "telflow" "$path" 2>/dev/null && MATCHES="${MATCHES}${path}
"
  done < <(git -C "$TARGET" ls-files --cached --others --exclude-standard)
else
  # Not inside a git repository (e.g. the test fixtures below, which run
  # against a bare temp directory): fall back to a plain recursive grep.
  MATCHES=$(grep -ril "telflow" "$TARGET" \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=dist \
    --exclude-dir=build \
    --exclude-dir=coverage \
    2>/dev/null || true)
fi

# Documentation that defines this rule has to quote the misspelling, as does
# this script. Rather than hardcoding filenames — which silently goes stale —
# a file opts out by containing the marker below. Every exemption is then
# greppable and auditable:  grep -rl "$EXEMPTION_MARKER" .
EXEMPTION_MARKER="naming-check: allow-telflow-references"

EXEMPT_FILTERED=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  grep -qF "$EXEMPTION_MARKER" "$file" 2>/dev/null && continue
  EXEMPT_FILTERED="${EXEMPT_FILTERED}${file}
"
done <<< "$MATCHES"
MATCHES=$(printf "%s" "$EXEMPT_FILTERED")

if [ -n "$MATCHES" ]; then
  echo "ERROR: the misspelling 'telflow' appears in:"
  echo "$MATCHES" | sed 's/^/  /'
  echo ""
  echo "The product is spelled 'telflo'. See docs/conventions/naming.md."
  exit 1
fi
exit 0
