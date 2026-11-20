#!/usr/bin/env bash
# build-compose-archive.sh's self-test. In a throwaway git repository
# holding the script, version.sh, a Chart.yaml and the real deploy/compose
# files (committed):
#   - the archive lists exactly deploy/compose's committed files under
#     telflo-compose-<version>/, nothing else (an untracked .env and
#     secrets/, and an ignored file, left out); setup.sh executable, the
#     rest not; each file's bytes are the committed ones;
#   - --commit takes an older commit's files and version;
#   - refused (exit 1, nothing written): an existing archive (left
#     unchanged), a version that isn't a release version, appVersion other
#     than version, a commit without deploy/compose, an --out that isn't a
#     folder;
#   - usage (exit 2): no --out, an unknown argument.
#
# Run: scripts/release/build-compose-archive.test.sh
# Offline; prints PASS/FAIL lines only; exit 1 when any case failed. The
# throwaway repository lives in a temporary folder removed on exit. bash
# 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/build-compose-archive-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0
run_case() { # <name> <command...>
  local name="$1"; shift
  if "$@"; then
    echo "PASS - $name"; passed=$((passed + 1))
  else
    echo "FAIL - $name"; failed=$((failed + 1))
  fi
}
g() { git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main -c commit.gpgSign=false "$@"; }

# The throwaway repository: two commits, 0.1.0 then 0.2.0 (one file added).
r="$tmp/repo"
chart() { printf 'apiVersion: v2\nname: telflo\nversion: %s\nappVersion: "%s"\n' "$1" "$2" >"$r/charts/telflo/Chart.yaml"; }
mkdir -p "$r/scripts/release" "$r/charts/telflo" &&
  cp "$SCRIPT_DIR/build-compose-archive.sh" "$SCRIPT_DIR/version.sh" "$r/scripts/release/" &&
  (cd "$REPO_DIR" && git ls-files -z --cached --others --exclude-standard -- deploy/compose | xargs -0 tar -cf -) |
  (cd "$r" && tar -xf -) &&
  chart 0.1.0 0.1.0 &&
  printf 'ignored.txt\n' >"$r/.gitignore" &&
  g -C "$r" init -q && g -C "$r" add -A && g -C "$r" commit -q -m one &&
  printf 'two\n' >"$r/deploy/compose/NOTES.txt" && chart 0.2.0 0.2.0 &&
  g -C "$r" add -A && g -C "$r" commit -q -m two || { echo "self-test: couldn't make the repository" >&2; exit 2; }
# Untracked and ignored files in deploy/compose: none may reach the archive.
printf 'TELFLO_X=1\n' >"$r/deploy/compose/.env"
mkdir -p "$r/deploy/compose/secrets" && printf 'x' >"$r/deploy/compose/secrets/opamp-encryption-key"
printf 'x\n' >"$r/deploy/compose/ignored.txt"

# build [args...]: the copy's script; output in $tmp/out, status in $tmp/rc.
build() { (cd "$tmp" && bash "$r/scripts/release/build-compose-archive.sh" "$@") >"$tmp/out" 2>&1; echo $? >"$tmp/rc"; }
rc_is() { [ "$(cat "$tmp/rc")" = "$1" ]; }
said() { grep -qF -- "$1" "$tmp/out"; }
fresh_out() { rm -rf "$tmp/o" && mkdir -p "$tmp/o"; }

listing_exact() {
  fresh_out && build --out "$tmp/o" && rc_is 0 && said "$tmp/o/telflo-compose-0.2.0.tar.gz" &&
    tar -tzf "$tmp/o/telflo-compose-0.2.0.tar.gz" | grep -v '/$' | sort >"$tmp/listed" &&
    g -C "$r" ls-tree -r --name-only HEAD:deploy/compose | sed 's#^#telflo-compose-0.2.0/#' | sort >"$tmp/tracked" &&
    cmp -s "$tmp/listed" "$tmp/tracked" && grep -qx 'telflo-compose-0.2.0/setup.sh' "$tmp/listed" &&
    grep -qx 'telflo-compose-0.2.0/compose.yaml' "$tmp/listed"
}
run_case "the archive lists exactly deploy/compose's committed files under telflo-compose-<version>/" listing_exact
nothing_else() {
  ! grep -qE '/(\.env|secrets/|ignored\.txt)' "$tmp/listed" &&
    [ -z "$(tar -tzf "$tmp/o/telflo-compose-0.2.0.tar.gz" | grep -v '^telflo-compose-0\.2\.0/')" ]
}
run_case "nothing untracked or ignored (.env, secrets/, an ignored file) and nothing outside the top folder" nothing_else
modes_kept() {
  tar -tvzf "$tmp/o/telflo-compose-0.2.0.tar.gz" >"$tmp/verbose" &&
    grep -E ' telflo-compose-0\.2\.0/setup\.sh$' "$tmp/verbose" | grep -q '^-rwxr-xr-x' &&
    grep -E ' telflo-compose-0\.2\.0/compose\.yaml$' "$tmp/verbose" | grep -q '^-rw-r--r--'
}
run_case "modes kept: setup.sh executable, compose.yaml not" modes_kept
bytes_kept() {
  rm -rf "$tmp/x" && mkdir -p "$tmp/x" && tar -xzf "$tmp/o/telflo-compose-0.2.0.tar.gz" -C "$tmp/x" &&
    cmp -s "$tmp/x/telflo-compose-0.2.0/compose.yaml" "$r/deploy/compose/compose.yaml" &&
    cmp -s "$tmp/x/telflo-compose-0.2.0/setup.sh" "$r/deploy/compose/setup.sh"
}
run_case "each file's bytes are the committed ones" bytes_kept
older_commit() {
  fresh_out && build --out "$tmp/o" --commit HEAD~1 && rc_is 0 &&
    tar -tzf "$tmp/o/telflo-compose-0.1.0.tar.gz" >"$tmp/older" &&
    grep -qx 'telflo-compose-0.1.0/compose.yaml' "$tmp/older" && ! grep -q 'NOTES.txt' "$tmp/older"
}
run_case "--commit takes an older commit's files and version" older_commit

echo "# refusals"
exists() {
  fresh_out && printf 'keep' >"$tmp/o/telflo-compose-0.2.0.tar.gz" && build --out "$tmp/o" && rc_is 1 &&
    said "exists already: refused" && [ "$(cat "$tmp/o/telflo-compose-0.2.0.tar.gz")" = keep ] &&
    [ "$(ls -A "$tmp/o")" = telflo-compose-0.2.0.tar.gz ]
}
run_case "an existing archive is refused and left unchanged" exists
bad_version() {
  chart 0.3.0-rc.1 0.3.0-rc.1 && g -C "$r" commit -q -am rc && fresh_out && build --out "$tmp/o" && rc_is 1 &&
    said "isn't a release version" && [ -z "$(ls -A "$tmp/o")" ]
}
run_case "a version that isn't a release version is refused" bad_version
differ() {
  chart 0.3.0 0.3.1 && g -C "$r" commit -q -am differ && fresh_out && build --out "$tmp/o" && rc_is 1 &&
    said "appVersion (0.3.1) differs from its version (0.3.0)" && [ -z "$(ls -A "$tmp/o")" ]
}
run_case "appVersion other than version is refused" differ
no_install() {
  chart 0.3.0 0.3.0 && g -C "$r" rm -r -q deploy/compose && g -C "$r" commit -q -m drop && fresh_out &&
    build --out "$tmp/o" && rc_is 1 && said "has no deploy/compose" && [ -z "$(ls -A "$tmp/o")" ]
}
run_case "a commit without deploy/compose is refused" no_install
not_folder() { build --out "$tmp/none" && rc_is 1 && said "isn't a folder"; }
run_case "an --out that isn't a folder is refused" not_folder

echo "# usage"
no_out() { build && rc_is 2 && said "usage:"; }
run_case "no --out (exit 2)" no_out
unknown() { fresh_out && build --out "$tmp/o" --version 0.1.0 && rc_is 2 && said "unknown argument --version"; }
run_case "an unknown argument (exit 2)" unknown

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
