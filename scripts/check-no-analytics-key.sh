#!/usr/bin/env bash
# Fails if a PostHog key is committed (D36-1 decision 47, Preflight ruling
# 30; the owner's Q250: PostHog stays in the app, off unless configured, and
# no key is ever in this repository).
#
#   scripts/check-no-analytics-key.sh [root]     (root: default the current directory)
#
# A PostHog project key is `phc_` and its key characters, a personal API key
# `phx_` and its; both are at least 32 letters and digits after the prefix
# (`ph[cx]_[A-Za-z0-9]{32,}`), so the code's own mentions (`phc_test`,
# `phc_example`, `phc_e2e_only_fake_project_key`, the cookie names'
# `ph_phc_*_posthog`) don't match, and a key inside a cookie's name
# (`ph_phc_<key>_posthog`) does.
#
# It reads the files git tracks under <root> (the index's, as they are in the
# working tree), never an untracked or ignored one, with `git grep -I`
# (binary files skipped). A hit prints only `<file>:<count>`, never the line
# or the key. Exit 0: no key; 1: a key (the files listed); 2: not a git
# checkout, or git grep failed (a fixed message).
set -uo pipefail
export LC_ALL=C

ROOT="${1:-.}"
PATTERN='ph[cx]_[A-Za-z0-9]{32,}'

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "check-no-analytics-key: $ROOT isn't inside a git checkout" >&2
  exit 2
fi

hits="$(git -C "$ROOT" grep -I -c -E -e "$PATTERN" 2>/dev/null)"
status=$?
case "$status" in
  0)
    echo "check-no-analytics-key: a PostHog key (phc_ or phx_ and 32 or more letters and digits) is in these tracked files (file:count):" >&2
    printf '%s\n' "$hits" >&2
    echo "Remove it (and rotate it at PostHog): a key belongs in a deployment's own values, never in this repository." >&2
    exit 1
    ;;
  1)
    echo "check-no-analytics-key: no PostHog key in the tracked files"
    exit 0
    ;;
  *)
    echo "check-no-analytics-key: git grep failed (exit $status)" >&2
    exit 2
    ;;
esac
