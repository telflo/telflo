#!/usr/bin/env bash
# Tests for scripts/check-no-analytics-key.sh (D36-1 decision 47, Preflight
# ruling 30). Each case is a throwaway git checkout in a temporary directory
# removed on exit; no key is ever committed here: the keys are made at run
# time (`openssl rand`), and the checks on them are boolean (grep -q on the
# script's output), never printing one. git runs with no global or system
# configuration.
#
# Run:  bash scripts/check-no-analytics-key.test.sh
# bash 3.2 compatible (macOS's /bin/bash).
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/scripts/check-no-analytics-key.sh"

failures=0
check() { # <name> <shell-expr that must succeed>
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-no-analytics-key-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# A key's shape, made here: 43 letters and digits, as PostHog's project keys have.
key_body() { openssl rand -base64 64 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-43; }
project_key="phc_$(key_body)"
personal_key="phx_$(key_body)"
check "the run-time keys have the shape (prefix and 43 letters and digits)" \
  "printf '%s\n' '$project_key' | grep -qxE 'phc_[A-Za-z0-9]{43}' && printf '%s\n' '$personal_key' | grep -qxE 'phx_[A-Za-z0-9]{43}'"

# checkout <name>: a new git checkout at $tmp/<name> holding the code's lookalikes, tracked.
checkout() {
  local dir="$tmp/$1"
  mkdir -p "$dir/src" && git -C "$dir" init -q || return 1
  {
    echo 'useAnalytics({ key: "phc_test", host: null });'
    echo 'export const E2E_POSTHOG_KEY = "phc_e2e_only_fake_project_key";'
    echo '    key: phc_example'
    echo '<li>ph_phc_*_posthog: 2 years</li>'
    echo 'sessionStorage.setItem("ph_phc_test_window_id", "a-window");'
    echo 'const cookie = new RegExp(`^ph_${key}_posthog$`); // phx_ is a personal key'
    echo "phc_$(printf 'a%.0s' $(seq 1 31))"
  } >"$dir/src/lookalikes.ts"
  git -C "$dir" add -A
}
# run <dir>: the script's exit code in rc, its stdout and stderr in out.
run() { out="$("$script" "$1" 2>&1)"; rc=$?; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }

checkout clean
run "$tmp/clean"
check "the code's lookalikes (phc_test, phc_example, the e2e key, the cookie names, 31 characters) pass (exit 0)" "[ $rc -eq 0 ]"

checkout project
printf 'posthog.init("%s", {});\n' "$project_key" >"$tmp/project/src/analytics.ts"
git -C "$tmp/project" add src/analytics.ts
run "$tmp/project"
check "a tracked project key fails (exit 1), naming its file and count only" \
  "[ $rc -eq 1 ] && has 'src/analytics.ts:1' && ! has 'src/lookalikes.ts'"
check "the project key itself is never printed" "! printf '%s\n' \"\$out\" | grep -qF '$project_key' && ! has 'posthog.init'"

checkout personal
printf 'POSTHOG_PERSONAL_API_KEY=%s\n' "$personal_key" >"$tmp/personal/.env.example"
git -C "$tmp/personal" add .env.example
run "$tmp/personal"
check "a tracked personal API key (phx_) fails, the key not printed" \
  "[ $rc -eq 1 ] && has '.env.example:1' && ! printf '%s\n' \"\$out\" | grep -qF '$personal_key'"

checkout cookie
printf 'document.cookie = "ph_%s_posthog=%%7B%%7D";\n' "$project_key" >"$tmp/cookie/src/cookie.ts"
git -C "$tmp/cookie" add src/cookie.ts
run "$tmp/cookie"
check "a key inside a cookie's name (ph_<key>_posthog) fails, the key not printed" \
  "[ $rc -eq 1 ] && has 'src/cookie.ts:1' && ! printf '%s\n' \"\$out\" | grep -qF '$project_key'"

checkout untracked
printf 'TELFLO_POSTHOG_KEY=%s\n' "$project_key" >"$tmp/untracked/local.env"
run "$tmp/untracked"
check "an untracked file holding a key is ignored (exit 0)" "[ $rc -eq 0 ] && ! printf '%s\n' \"\$out\" | grep -qF '$project_key'"

checkout counted
printf '%s\n%s\n' "$project_key" "$personal_key" >"$tmp/counted/src/two.txt"
git -C "$tmp/counted" add src/two.txt
run "$tmp/counted"
check "two keys in one file count 2" "[ $rc -eq 1 ] && has 'src/two.txt:2'"

mkdir -p "$tmp/plain"
printf '%s\n' "$project_key" >"$tmp/plain/key.txt"
run "$tmp/plain"
check "outside a git checkout: exit 2, a fixed message, nothing read" \
  "[ $rc -eq 2 ] && has \"isn't inside a git checkout\" && ! printf '%s\n' \"\$out\" | grep -qF '$project_key'"

run "$root"
check "this repository's tracked files hold no PostHog key (exit 0)" "[ $rc -eq 0 ]"

if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
