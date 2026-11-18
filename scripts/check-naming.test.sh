#!/usr/bin/env bash
# Verifies scripts/check-naming.sh catches the misspelling and stays quiet otherwise.
set -uo pipefail
cd "$(dirname "$0")/.."
FAILURES=0

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

# Case 1: a clean tree passes.
mkdir -p "$fixture/clean"
echo "telflo is spelled correctly here" > "$fixture/clean/ok.ts"
if ! ./scripts/check-naming.sh "$fixture/clean" >/dev/null 2>&1; then
  echo "FAIL: clean tree should pass"; FAILURES=$((FAILURES + 1))
fi

# Case 2: lowercase misspelling fails.
mkdir -p "$fixture/dirty"
echo "import x from 'telflow-frontend'" > "$fixture/dirty/bad.ts"
if ./scripts/check-naming.sh "$fixture/dirty" >/dev/null 2>&1; then
  echo "FAIL: 'telflow' should be rejected"; FAILURES=$((FAILURES + 1))
fi

# Case 3: the check is case-insensitive.
mkdir -p "$fixture/mixed"
echo "const name = 'Telflow'" > "$fixture/mixed/bad.ts"
if ./scripts/check-naming.sh "$fixture/mixed" >/dev/null 2>&1; then
  echo "FAIL: 'Telflow' should be rejected"; FAILURES=$((FAILURES + 1))
fi

# Case 4: a file carrying the exemption marker is skipped.
mkdir -p "$fixture/exempt"
{
  echo "# naming-check: allow-telflow-references"
  echo "This document explains why 'telflow' is banned."
} > "$fixture/exempt/naming.md"
if ! ./scripts/check-naming.sh "$fixture/exempt" >/dev/null 2>&1; then
  echo "FAIL: a file with the exemption marker should pass"; FAILURES=$((FAILURES + 1))
fi

# Case 5: the marker exempts only the file that carries it.
mkdir -p "$fixture/partial"
cp "$fixture/exempt/naming.md" "$fixture/partial/naming.md"
echo "const x = 'telflow'" > "$fixture/partial/code.ts"
if ./scripts/check-naming.sh "$fixture/partial" >/dev/null 2>&1; then
  echo "FAIL: the marker must not exempt neighbouring files"; FAILURES=$((FAILURES + 1))
fi

# Cases 6-9: inside a git repository, the guard scans repo files only —
# tracked and untracked-but-not-ignored, never gitignored scratch. This is
# the production path; every real invocation of the guard runs it.
gitfix="$fixture/gitrepo"
mkdir -p "$gitfix"
( cd "$gitfix" && git -c user.name=t -c user.email=t@example.com init -q )
printf 'ignored/\n' > "$gitfix/.gitignore"
mkdir -p "$gitfix/ignored"

# Case 6: a violation only in a gitignored file passes. This is the
# regression that motivated giving the guard a git-aware branch at all.
echo "const x = 'telflow'" > "$gitfix/ignored/scratch.md"
if ! ./scripts/check-naming.sh "$gitfix" >/dev/null 2>&1; then
  echo "FAIL: a violation confined to a gitignored file should pass"; FAILURES=$((FAILURES + 1))
fi

# Case 7: a violation in a tracked file fails.
echo "const x = 'telflow'" > "$gitfix/tracked.md"
( cd "$gitfix" && git add tracked.md )
if ./scripts/check-naming.sh "$gitfix" >/dev/null 2>&1; then
  echo "FAIL: a violation in a tracked file should be rejected"; FAILURES=$((FAILURES + 1))
fi

# Case 8: a violation in an untracked-but-not-ignored file fails. Proves
# --others --exclude-standard is doing its job: a brand-new unstaged file
# is still caught, not just what's already in the index.
( cd "$gitfix" && git rm -q -f tracked.md )
echo "const x = 'telflow'" > "$gitfix/brandnew.md"
if ./scripts/check-naming.sh "$gitfix" >/dev/null 2>&1; then
  echo "FAIL: a violation in an untracked, non-ignored file should be rejected"; FAILURES=$((FAILURES + 1))
fi

# Case 9: the same file, now carrying the exemption marker, passes. Proves
# marker filtering still applies on the git-aware path, not just the
# fallback. The marker text is built by concatenation, split mid-word, so
# this script's own source doesn't spell out the banned word contiguously.
marker_head="naming-check: allow-telfl"
marker_tail="ow-references"
marker="${marker_head}${marker_tail}"
{
  echo "# ${marker}"
  echo "const x = 'telflow'"
} > "$gitfix/brandnew.md"
if ! ./scripts/check-naming.sh "$gitfix" >/dev/null 2>&1; then
  echo "FAIL: a file with the exemption marker should pass on the git-aware path"; FAILURES=$((FAILURES + 1))
fi

if [ "$FAILURES" -eq 0 ]; then echo "check-naming: all cases passed"; exit 0; fi
echo "check-naming: $FAILURES case(s) failed"; exit 1
