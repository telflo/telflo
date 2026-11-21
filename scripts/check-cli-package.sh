#!/usr/bin/env bash
# The CLI's package check: the `npm pack` tarball of telflo-core/apps/cli
# installs and runs ALONE, with no workspace beside it, and ships only
# what it should.
#
#   bash scripts/check-cli-package.sh [--keep <dir>] [--cache <dir>]
#
# 1. `npm pack -w @telflo/cli` (its prepack builds dist/) into a temporary
#    folder, with a temporary HOME, npm config and TELFLO_CLI_CONFIG_DIR:
#    nothing reads or writes the user's own.
# 2. The tarball holds only package.json, README.md, LICENSE, dist/** and
#    skills/**; its manifest keeps "private": true and "Apache-2.0"; no
#    dist/**/*.js imports anything from `@telflo/` (a workspace package isn't
#    installed beside a tarball).
# 3. The CLI's two runtime dependencies are put in the temporary npm cache
#    (`npm cache add`, at the versions its package.json pins: a read of the
#    public registry, unless --cache names a cache that already holds them),
#    then the tarball is installed `-g --offline` into a temporary prefix:
#    any other dependency would fail the install. Its node_modules holds
#    those two only.
# 4. The installed `telflo -V` prints the package's version and `--help`
#    exits 0, with an empty environment but PATH.
#
# --keep <dir>: install into <dir> (an empty or new folder) and keep it; the
#   stack smoke's TELFLO_SMOKE_CLI is then <dir>/lib/node_modules/@telflo/cli/dist/index.js.
# --cache <dir>: the npm cache to use and keep (default: a temporary one).
#
# Nothing is published: this script never runs npm publish, login or
# any registry write.
set -euo pipefail

usage() {
  echo "usage: bash scripts/check-cli-package.sh [--keep <dir>] [--cache <dir>]" >&2
  exit 2
}

keep=""
cache=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) [ "$#" -ge 2 ] || usage; keep=$2; shift 2 ;;
    --cache) [ "$#" -ge 2 ] || usage; cache=$2; shift 2 ;;
    *) usage ;;
  esac
done

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
core="$repo_dir/telflo-core"
cli="$core/apps/cli"

work=$(mktemp -d "${TMPDIR:-/tmp}/telflo-cli-package.XXXXXX")
cleanup() {
  cd /
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "check-cli-package: FAIL: $*" >&2
  exit 1
}

mkdir -p "$work/home" "$work/pack" "$work/unpacked"
mkdir -m 700 "$work/config"
: >"$work/npmrc"
: >"$work/npmrc-global"
[ -n "$cache" ] || cache="$work/npm-cache"
mkdir -p "$cache"

if [ -n "$keep" ]; then
  if [ -e "$keep" ] && [ -n "$(ls -A "$keep")" ]; then fail "--keep's folder isn't empty: $keep"; fi
  mkdir -p "$keep"
  prefix=$(cd "$keep" && pwd)
else
  prefix="$work/prefix"
  mkdir -p "$prefix"
fi

# npm and the CLI see only this run's folders.
export HOME="$work/home"
export npm_config_userconfig="$work/npmrc"
export npm_config_globalconfig="$work/npmrc-global"
export npm_config_cache="$cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false
export TELFLO_CLI_CONFIG_DIR="$work/config"
unset XDG_CONFIG_HOME TELFLO_TOKEN TELFLO_SERVER TELFLO_ORG TELFLO_CONFIG_DIR

echo "check-cli-package: packing @telflo/cli"
(cd "$core" && npm pack -w @telflo/cli --pack-destination "$work/pack" --json >"$work/pack.json" 2>"$work/pack.log") ||
  { cat "$work/pack.log" >&2; fail "npm pack failed"; }

tarball=$(node -e '
  const [entry] = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(entry.filename.replace(/^@/, "").replace(/\//, "-"));
' "$work/pack.json")
tarball="$work/pack/$tarball"
[ -f "$tarball" ] || fail "npm pack wrote no tarball"

echo "check-cli-package: the tarball's files"
node -e '
  const [entry] = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const paths = entry.files.map((file) => file.path);
  const allowed = (path) => path === "package.json" || path === "README.md" || path === "LICENSE" || /^dist\/.+/.test(path) || /^skills\/.+/.test(path);
  const others = paths.filter((path) => !allowed(path));
  if (others.length > 0) { console.error("files the tarball may not hold: " + others.join(", ")); process.exit(1); }
  for (const needed of ["package.json", "LICENSE", "dist/index.js"]) {
    if (!paths.includes(needed)) { console.error("the tarball lacks " + needed); process.exit(1); }
  }
  if (paths.some((path) => /\.(d\.ts|map|tsbuildinfo)$/.test(path) || /\.test\.js$/.test(path))) {
    console.error("the tarball holds declarations, maps, build info or tests"); process.exit(1);
  }
  console.log("  " + paths.length + " files: package.json, README.md, LICENSE, dist/** and skills/** only");
' "$work/pack.json" || fail "the tarball holds the wrong files"

tar -xzf "$tarball" -C "$work/unpacked"
manifest="$work/unpacked/package/package.json"
node -e '
  const manifest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const problems = [];
  if (manifest.private !== true) problems.push("\"private\" is not true");
  if (manifest.license !== "Apache-2.0") problems.push("the license is not Apache-2.0");
  if (manifest.bin?.telflo !== "dist/index.js") problems.push("bin.telflo is not dist/index.js");
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith("@telflo/")) problems.push("a workspace runtime dependency: " + name);
  }
  if (problems.length > 0) { console.error(problems.join("; ")); process.exit(1); }
' "$manifest" || fail "the packed manifest"
echo "check-cli-package: the manifest keeps \"private\": true and Apache-2.0"

if grep -rlE --include='*.js' "(from|import)[[:space:]]*\(?[[:space:]]*[\"']@telflo/|require\([[:space:]]*[\"']@telflo/" "$work/unpacked/package/dist" >"$work/imports.txt"; then
  cat "$work/imports.txt" >&2
  fail "dist/ imports from @telflo/"
fi
echo "check-cli-package: dist/ imports nothing from @telflo/"

dependencies=$(node -e '
  const manifest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  console.log(Object.entries(manifest.dependencies ?? {}).map(([name, version]) => name + "@" + version).join(" "));
' "$manifest")
echo "check-cli-package: caching $dependencies"
# shellcheck disable=SC2086 # one word per dependency
(cd "$work" && npm cache add $dependencies) >"$work/cache.log" 2>&1 || { cat "$work/cache.log" >&2; fail "npm cache add failed"; }

echo "check-cli-package: installing the tarball alone, offline"
npm install -g --prefix "$prefix" --offline --no-audit --no-fund "$tarball" >"$work/install.log" 2>&1 ||
  { cat "$work/install.log" >&2; fail "the tarball didn't install alone"; }

installed="$prefix/lib/node_modules/@telflo/cli"
[ -f "$installed/dist/index.js" ] || fail "the install has no dist/index.js"
[ ! -L "$installed" ] || fail "the install is a link, not a copy"
expected_modules=$(node -e '
  const manifest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  console.log(Object.keys(manifest.dependencies ?? {}).sort().join(" "));
' "$manifest")
installed_modules=$(cd "$installed/node_modules" && ls -A | grep -v '^\.' | sort | tr '\n' ' ' | sed 's/ $//')
[ "$installed_modules" = "$expected_modules" ] || fail "the install's node_modules holds [$installed_modules], not [$expected_modules]"

node_dir=$(dirname "$(command -v node)")
version=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$manifest")
printed=$(env -i PATH="$prefix/bin:$node_dir:/usr/bin:/bin" HOME="$work/home" TELFLO_CLI_CONFIG_DIR="$work/config" telflo -V) ||
  fail "telflo -V failed"
[ "$printed" = "$version" ] || fail "telflo -V printed $printed, not $version"
env -i PATH="$prefix/bin:$node_dir:/usr/bin:/bin" HOME="$work/home" TELFLO_CLI_CONFIG_DIR="$work/config" telflo --help >"$work/help.txt" ||
  fail "telflo --help failed"
grep -q "Usage: telflo" "$work/help.txt" || fail "telflo --help printed no usage"
echo "check-cli-package: the installed telflo -V prints $version and --help exits 0"

if [ -n "$keep" ]; then
  echo "check-cli-package: kept the install: $installed/dist/index.js"
fi
echo "check-cli-package: OK"
