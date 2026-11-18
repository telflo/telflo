#!/usr/bin/env bash
# Tests for scripts/check-no-dev-dependencies.mjs (D36-1 decisions 43 and 46,
# Preflight ruling 25). Each case is a throwaway tree (a lockfile and the
# node_modules folders it names, empty package.json files only) in a
# temporary directory removed on exit; the last cases read the repository's
# own lockfile (read only).
#
# Run:  bash scripts/check-no-dev-dependencies.test.sh
# bash 3.2 compatible (macOS's /bin/bash).
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/scripts/check-no-dev-dependencies.mjs"

failures=0
check() { # <name> <shell-expr that must succeed>
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-no-dev-dependencies-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT

# The fixture's lock: production packages, development-only ones (at the
# root, scoped, nested under a workspace and under another package), a
# devOptional one, an optional one and a development-only workspace link.
cat >"$tmp/package-lock.json" <<'LOCK'
{
  "name": "fixture",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "fixture", "workspaces": ["apps/*"] },
    "apps/api": { "name": "@fixture/api" },
    "node_modules/@fixture/api": { "resolved": "apps/api", "link": true },
    "node_modules/@fixture/tools": { "resolved": "packages/tools", "link": true, "dev": true },
    "node_modules/fastify": { "version": "5.0.0", "license": "MIT" },
    "node_modules/@scope/runtime": { "version": "1.0.0", "license": "MIT" },
    "node_modules/argon2-binary": { "version": "1.0.0", "license": "MIT", "optional": true },
    "node_modules/@types/pg": { "version": "8.0.0", "license": "MIT", "devOptional": true },
    "node_modules/tsx": { "version": "4.0.0", "license": "MIT", "dev": true },
    "node_modules/@vitest/runner": { "version": "2.0.0", "license": "MIT", "dev": true },
    "apps/web/node_modules/vite": { "version": "6.0.0", "license": "MIT", "dev": true },
    "node_modules/fastify/node_modules/devonly": { "version": "1.0.0", "license": "MIT", "dev": true }
  }
}
LOCK

# tree <name> <lock path>...: a root at $tmp/<name> holding each path (a folder with a package.json).
tree() {
  local dir="$tmp/$1" path
  shift
  mkdir -p "$dir/node_modules" || return 1
  for path in "$@"; do
    mkdir -p "$dir/$path" && printf '{}\n' >"$dir/$path/package.json" || return 1
  done
}
# run <lock> <root>: the script's exit code in rc, its output in out.
run() { out="$(node "$script" "$@" 2>&1)"; rc=$?; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }

PRODUCTION="node_modules/fastify node_modules/@scope/runtime node_modules/argon2-binary"

tree clean $PRODUCTION
run "$tmp/package-lock.json" "$tmp/clean"
check "production and optional packages only: passes (exit 0)" "[ $rc -eq 0 ] && has 'OK, no development-only package present'"
check "it says how many lock entries it checked (10 under node_modules)" "has '10 installable lock entries checked'"

tree devopt $PRODUCTION node_modules/@types/pg
run "$tmp/package-lock.json" "$tmp/devopt"
check "a devOptional package present passes, listed as allowed" "[ $rc -eq 0 ] && has 'devOptional present (allowed): node_modules/@types/pg'"

tree rootdev $PRODUCTION node_modules/tsx
run "$tmp/package-lock.json" "$tmp/rootdev"
check "a development-only package at the root's node_modules fails (exit 1), named" \
  "[ $rc -eq 1 ] && has 'FAIL, 1 development-only packages present' && has '  node_modules/tsx'"

tree scoped $PRODUCTION node_modules/@vitest/runner
run "$tmp/package-lock.json" "$tmp/scoped"
check "a scoped development-only package fails, named" "[ $rc -eq 1 ] && has '  node_modules/@vitest/runner'"

tree workspace $PRODUCTION apps/web/node_modules/vite
run "$tmp/package-lock.json" "$tmp/workspace"
check "a development-only package under a workspace's node_modules fails, named" "[ $rc -eq 1 ] && has '  apps/web/node_modules/vite'"

tree nested $PRODUCTION node_modules/fastify/node_modules/devonly
run "$tmp/package-lock.json" "$tmp/nested"
check "a development-only package nested under a production one fails, named" \
  "[ $rc -eq 1 ] && has '  node_modules/fastify/node_modules/devonly'"

tree all $PRODUCTION node_modules/tsx node_modules/@vitest/runner apps/web/node_modules/vite
run "$tmp/package-lock.json" "$tmp/all"
check "three present: all three counted and named" \
  "[ $rc -eq 1 ] && has 'FAIL, 3 development-only packages present' && has 'node_modules/tsx' && has 'node_modules/@vitest/runner' && has 'apps/web/node_modules/vite'"

tree link $PRODUCTION node_modules/@fixture/tools
run "$tmp/package-lock.json" "$tmp/link"
check "a development-only workspace link's package present fails, named" "[ $rc -eq 1 ] && has '  node_modules/@fixture/tools'"

run "$tmp/no-such-lock.json" "$tmp/clean"
check "a missing lockfile: exit 2" "[ $rc -eq 2 ] && has \"can't read\""
printf 'not json\n' >"$tmp/broken.json"
run "$tmp/broken.json" "$tmp/clean"
check "a lockfile that isn't JSON: exit 2" "[ $rc -eq 2 ]"
printf '{"lockfileVersion": 1, "dependencies": {}}\n' >"$tmp/v1.json"
run "$tmp/v1.json" "$tmp/clean"
check "a lockfile without packages (version 1): exit 2" "[ $rc -eq 2 ] && has 'has no \"packages\"'"
mkdir -p "$tmp/empty-root"
run "$tmp/package-lock.json" "$tmp/empty-root"
check "a root with no node_modules (nothing to check) fails closed: exit 2" "[ $rc -eq 2 ] && has 'has no node_modules folder'"
run "$tmp/package-lock.json"
check "a missing argument: exit 2, usage" "[ $rc -eq 2 ] && has 'usage:'"
run "$tmp/package-lock.json" "$tmp/clean" extra
check "an extra argument: exit 2, usage" "[ $rc -eq 2 ] && has 'usage:'"

# The repository's own lockfile (read only): node-pg-migrate is the migrations'
# runtime (Preflight ruling 24), so it and what it brings are production.
lock="$root/telflo-core/package-lock.json"
check "the repository's lock: node-pg-migrate is production (no dev flag), a @telflo/db dependency" \
  "node -e 'const p = require(process.argv[1]).packages; process.exit(!p[\"node_modules/node-pg-migrate\"].dev && !p[\"node_modules/node-pg-migrate\"].devOptional && p[\"packages/db\"].dependencies[\"node-pg-migrate\"] && !(p[\"packages/db\"].devDependencies || {})[\"node-pg-migrate\"] ? 0 : 1)' '$lock'"
check "the repository's lock: tsx, vite and vitest are development-only (what the images must leave out)" \
  "node -e 'const p = require(process.argv[1]).packages; process.exit([\"tsx\", \"vite\", \"vitest\"].every((n) => p[\"node_modules/\" + n].dev === true) ? 0 : 1)' '$lock'"

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILED"; fi
[ "$failures" -eq 0 ]
