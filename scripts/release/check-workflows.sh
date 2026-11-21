#!/usr/bin/env bash
# check-workflows.sh: the workflows' static check, offline, from the
# repository's root with no argument (static.sh runs every
# scripts/release/check-*.sh): node runs check-workflows.mjs,
# which reads .github/workflows/release.yml, collector.yml and ci.yml with
# telflo-core's `yaml` package (npm ci in telflo-core first). Its rules are
# listed at the top of check-workflows.mjs. Arguments pass through (--dir,
# --root: check-workflows.test.sh's fixtures). Exit 0 every rule holds; 1 a
# rule fails; 2 usage, or no node or `yaml`. bash 3.2 compatible.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { echo "check-workflows: node is not on PATH" >&2; exit 2; }
exec node "$here/check-workflows.mjs" "$@"
