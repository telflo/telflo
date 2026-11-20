#!/usr/bin/env bash
# static.sh's self-test, on fixture trees only (the real gates never run
# here):
#   - `--list` names every scripts/**/*.test.sh and scripts/release/check-*.sh
#     of a fixture tree, the fixed list first, and nothing else it finds;
#   - a failing gate makes the run exit 1 and names it, and the gates after
#     it still run, one at a time;
#   - a call to a docker-credential-* stand-in fails the run;
#   - the gates run with DOCKER_CONFIG the work folder's stub and their
#     output redacted (a run-time value, checked by boolean);
#   - a work folder that isn't empty, and no --work, exit 2.
#
# Run: bash scripts/gates/static.test.sh   (STATIC_SH=<path> tests another copy)
# Offline; bash 3.2 compatible; PASS/FAIL lines; exit 1 when any failed.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATIC_SH="${STATIC_SH:-$SCRIPT_DIR/static.sh}"
export STATIC_CAFFEINATED=1

umask 077
tmp="$(mktemp -d "${TMPDIR:-/tmp}/static-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
tmp="$(cd "$tmp" && pwd -P)"
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

# fixture <name>: a tree whose scripts/ holds gates (each script given as
# "<relative path>" "<body>" pairs after the name).
fixture() {
  local t="$tmp/$1"; shift
  mkdir -p "$t/scripts" || return 1
  while [ "$#" -ge 2 ]; do
    mkdir -p "$(dirname "$t/$1")" && printf '#!/usr/bin/env bash\n%s\n' "$2" >"$t/$1" || return 1
    shift 2
  done
  echo "$t"
}

# --- --list ------------------------------------------------------------------
list_tree=$(fixture list \
  scripts/a.test.sh 'exit 0' \
  scripts/sub/deeper/b.test.sh 'exit 0' \
  scripts/release/check-one.sh 'exit 0' \
  scripts/release/check-two.test.sh 'exit 0' \
  scripts/release/verify-three.sh 'exit 0' \
  scripts/release/nested/check-four.sh 'exit 0' \
  scripts/helper.sh 'exit 0' \
  scripts/node_modules/x/c.test.sh 'exit 0')
bash "$STATIC_SH" --tree "$list_tree" --list >"$tmp/list.out" 2>&1
list_rc=$?
listed() { grep -qE "^$1[[:space:]]+\\(cd \\. && bash $2\\)\$" "$tmp/list.out"; }
run_case "--list exits 0" [ "$list_rc" = 0 ]
run_case "--list names scripts/a.test.sh" listed a.test scripts/a.test.sh
run_case "--list names a test.sh folders down" listed sub-deeper-b.test scripts/sub/deeper/b.test.sh
run_case "--list names scripts/release/check-one.sh" listed release-check-one scripts/release/check-one.sh
run_case "--list names scripts/release/check-two.test.sh once" \
  sh -c '[ "$(grep -c "scripts/release/check-two.test.sh" "$1")" = 1 ]' sh "$tmp/list.out"
run_case "--list leaves out verify-*.sh, other scripts, node_modules and nested release checks" \
  sh -c '! grep -Eq "verify-three|helper\.sh|node_modules|check-four" "$1"' sh "$tmp/list.out"
fixed_first() {
  local expected="naming licenses collector-entrypoint collector-build-script supervisor-chart-render opamp-server-pin typecheck typecheck-web lint web-build cli-build cli-package gateway-logs platform-chart-render chart-cloud-neutral analytics-key"
  [ "$(head -n 16 "$tmp/list.out" | awk '{ print $1 }' | tr '\n' ' ')" = "$expected " ]
}
run_case "--list puts the fixed list first, in testing.md's order" fixed_first
sorted() {
  [ "$(tail -n +17 "$tmp/list.out" | awk '{ print $1 }' | tr '\n' ' ')" = "a.test release-check-two.test sub-deeper-b.test release-check-one " ]
}
run_case "--list then the test.sh files sorted, then the release checks" sorted
discovered_only() {
  bash "$STATIC_SH" --tree "$list_tree" --list --discovered-only >"$tmp/list2.out" 2>&1 &&
    ! grep -q '^naming ' "$tmp/list2.out" && [ "$(wc -l <"$tmp/list2.out" | tr -d ' ')" = 4 ]
}
run_case "--list --discovered-only names the four found only" discovered_only

# --- a run -------------------------------------------------------------------
# A value made at run time, kept in a file, printed by one gate as a tf_ token.
head -c 24 /dev/urandom | base64 | tr -d '\n=+/' >"$tmp/value"
cp "$tmp/value" "$tmp/run-value"
run_tree=$(fixture run \
  scripts/a-first.test.sh 'echo first >>"$STATIC_TEST_ORDER"' \
  scripts/b-fails.test.sh 'echo second >>"$STATIC_TEST_ORDER"; echo "FAIL - b'"'"'s case"; echo "b'"'"'s last line"; exit 3' \
  scripts/c-prints.test.sh "echo third >>\"\$STATIC_TEST_ORDER\"; printf 'token tf_%s\n' \"\$(cat \"$tmp/run-value\")\"" \
  scripts/d-config.test.sh 'echo fourth >>"$STATIC_TEST_ORDER"; case "$DOCKER_CONFIG" in "$HOME"/.docker*|"") exit 1 ;; esac; grep -q "telflo-gates.invalid" "$DOCKER_CONFIG/config.json" && [ "$(command -v docker-credential-osxkeychain)" = "$(dirname "$DOCKER_CONFIG")/bin/docker-credential-osxkeychain" ]' \
  scripts/release/check-e.sh 'echo fifth >>"$STATIC_TEST_ORDER"')
STATIC_TEST_ORDER="$tmp/order" bash "$STATIC_SH" --tree "$run_tree" --work "$tmp/work1" --discovered-only >"$tmp/run1.out" 2>&1
run1_rc=$?
run_case "a failing gate makes the run exit 1" [ "$run1_rc" = 1 ]
run_case "the run names the failing gate" grep -q '^static.sh: FAILED: b-fails.test ' "$tmp/run1.out"
run_case "static.codes holds each gate's exit code" \
  sh -c 'grep -qx "b-fails.test 3" "$1" && grep -qx "a-first.test 0" "$1" && grep -qx "release-check-e 0" "$1" && grep -qx "credential-helpers 0" "$1"' sh "$tmp/work1/static.codes"
run_case "the gates after a failure still run, one at a time, in order" \
  sh -c '[ "$(tr "\n" " " <"$1")" = "first second third fourth fifth " ]' sh "$tmp/order"
run_case "the gates run with DOCKER_CONFIG the work folder's stub and the stand-ins first on PATH" grep -qx 'd-config.test 0' "$tmp/work1/static.codes"
redacted() {
  ! grep -rqF -f "$tmp/value" "$tmp/work1" "$tmp/run1.out" &&
    grep -q 'tf_\[REDACTED\]' "$tmp/work1/logs/c-prints.test.log" &&
    grep -Eq '^c-prints\.test +0 +[0-9]+ +1$' "$tmp/work1/summary.txt"
}
run_case "a gate's output is redacted in its log, the summary counts it" redacted
run_case "the summary table follows the gates" grep -Eq '^gate +exit +seconds +redacted$' "$tmp/run1.out"
failed_output() {
  grep -q "^--- b-fails.test: its FAIL lines" "$tmp/run1.out" &&
    grep -qxF "  | FAIL - b's case" "$tmp/run1.out" && grep -qxF "  | b's last line" "$tmp/run1.out" &&
    ! grep -q '^--- c-prints.test' "$tmp/run1.out" &&
    [ "$(tail -n 1 "$tmp/run1.out" | cut -c1-19)" = "static.sh: FAILED: " ]
}
run_case "a failing gate's FAIL lines and last lines follow the table, the passing ones' don't; FAILED ends the run" failed_output

all_pass_tree=$(fixture pass scripts/a.test.sh 'exit 0' scripts/release/check-b.sh 'exit 0')
all_pass() {
  bash "$STATIC_SH" --tree "$all_pass_tree" --work "$tmp/work2" --discovered-only >"$tmp/run2.out" 2>&1 &&
    grep -q '^static.sh: every gate passed$' "$tmp/run2.out"
}
run_case "every gate passing exits 0" all_pass

helper_tree=$(fixture helper \
  scripts/a.test.sh 'echo get | docker-credential-desktop get >/dev/null 2>&1; exit 0' \
  scripts/b.test.sh 'exit 0')
helper_called() {
  bash "$STATIC_SH" --tree "$helper_tree" --work "$tmp/work3" --discovered-only >"$tmp/run3.out" 2>&1
  [ "$?" = 1 ] && grep -qx 'credential-helpers 1' "$tmp/work3/static.codes" &&
    grep -q '^static.sh: FAILED: credential-helpers ' "$tmp/run3.out" && grep -qx 'get' "$tmp/work3/helper.log"
}
run_case "a credential helper's stand-in called fails the run" helper_called

# --- usage ---------------------------------------------------------------------
mkdir -p "$tmp/not-empty" && : >"$tmp/not-empty/x"
usage_rc() { local rc; bash "$STATIC_SH" "$@" >/dev/null 2>&1; rc=$?; [ "$rc" = 2 ]; }
run_case "a work folder that isn't empty exits 2" usage_rc --tree "$all_pass_tree" --work "$tmp/not-empty" --discovered-only
run_case "no --work exits 2" usage_rc --tree "$all_pass_tree" --discovered-only
run_case "a relative --work exits 2" usage_rc --tree "$all_pass_tree" --work relative/work --discovered-only
run_case "an unknown argument exits 2" usage_rc --tree "$all_pass_tree" --nope

echo "static.test.sh: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
