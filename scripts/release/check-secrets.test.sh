#!/usr/bin/env bash
# Tests for scripts/release/check-secrets.sh. Each case is a throwaway git
# checkout in a temporary directory removed on exit, scanned with --root. No
# fake secret is ever committed here: each is made at run time (a Stripe-shaped
# key, gitleaks' stripe-access-token rule), and the checks on the output are
# boolean (grep -q), never printing one. git runs with no global or system
# configuration. Needs the checked gitleaks (tools.sh fetch gitleaks).
#
# Run:  bash scripts/release/check-secrets.test.sh
# bash 3.2 compatible (macOS's /bin/bash).
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
script="$SCRIPT_DIR/check-secrets.sh"

failures=0
check() { # <name> <shell-expr that must succeed>
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-secrets-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# A fake key, made here, so this file never holds one.
prefix="sk_"
fake="${prefix}live_$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-24)"
check "the run-time key has the shape" "printf '%s\n' '$fake' | grep -qxE 'sk_live_[A-Za-z0-9]{24}'"

# checkout <name>: a new git checkout at $tmp/<name> with one harmless tracked file.
checkout() {
  local dir="$tmp/$1"
  mkdir -p "$dir/src" && git -C "$dir" init -q || return 1
  echo 'export const answer = 42;' >"$dir/src/plain.ts"
  git -C "$dir" add -A
}
# with_key <dir> <path>: <path> holds the fake key on its line 2.
with_key() { mkdir -p "$(dirname "$1/$2")" && printf '// a fixture\nconst key = "%s";\n' "$fake" >"$1/$2"; }
run() { out="$(bash "$script" "$@" 2>&1)"; rc=$?; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
no_key() { ! printf '%s\n' "$out" | grep -qF -- "$fake"; }
FP="src/fixture.test.ts:stripe-access-token:2"

checkout clean
run --root "$tmp/clean"
check "a checkout with no finding passes (exit 0)" "[ $rc -eq 0 ] && has '0 finding(s)'"

checkout tracked
with_key "$tmp/tracked" src/fixture.test.ts
git -C "$tmp/tracked" add -A
run --root "$tmp/tracked"
check "a tracked key fails (exit 1), naming its fingerprint" "[ $rc -eq 1 ] && has '$FP'"
check "the key itself is never printed" "no_key"

checkout untracked
with_key "$tmp/untracked" src/fixture.test.ts
run --root "$tmp/untracked"
check "an untracked, not ignored file is scanned too (exit 1)" "[ $rc -eq 1 ] && has '$FP' && no_key"

checkout ignored
with_key "$tmp/ignored" local/secrets.env
echo 'local/' >"$tmp/ignored/.gitignore"
git -C "$tmp/ignored" add .gitignore
run --root "$tmp/ignored"
check "a git-ignored file is never scanned (exit 0)" "[ $rc -eq 0 ] && no_key"

checkout listed
with_key "$tmp/listed" src/fixture.test.ts
printf '# reviewed: a made-up key\n\n  %s  \n' "$FP" >"$tmp/listed/.gitleaksignore"
git -C "$tmp/listed" add -A
run --root "$tmp/listed"
check "a finding listed in .gitleaksignore passes, comments and blanks ignored (exit 0)" "[ $rc -eq 0 ] && has '1 finding(s)' && no_key"

checkout moved
printf '\n' >"$tmp/moved/src/fixture.test.ts"
printf '// a fixture\nconst key = "%s";\n' "$fake" >>"$tmp/moved/src/fixture.test.ts"
printf '%s\n' "$FP" >"$tmp/moved/.gitleaksignore"
git -C "$tmp/moved" add -A
run --root "$tmp/moved"
check "a listed finding that moved fails twice: its new line, and the stale entry (exit 1)" \
  "[ $rc -eq 1 ] && has 'src/fixture.test.ts:stripe-access-token:3' && has 'lists $FP, which gitleaks no longer finds' && no_key"

checkout stale
printf '%s\n' "$FP" >"$tmp/stale/.gitleaksignore"
git -C "$tmp/stale" add -A
run --root "$tmp/stale"
check "an entry gitleaks no longer finds fails (exit 1)" "[ $rc -eq 1 ] && has 'which gitleaks no longer finds'"

checkout config
with_key "$tmp/config" src/fixture.test.ts
printf '[extend]\nuseDefault = true\n[allowlist]\npaths = ["""src/"""]\n' >"$tmp/config/.gitleaks.toml"
cp "$tmp/config/.gitleaks.toml" "$tmp/allow-all.toml"
git -C "$tmp/config" add -A
run --root "$tmp/config"
check "a .gitleaks.toml in the tree is never read (exit 1)" "[ $rc -eq 1 ] && has '$FP' && no_key"
out="$(GITLEAKS_CONFIG="$tmp/allow-all.toml" bash "$script" --root "$tmp/config" 2>&1)"; rc=$?
check "GITLEAKS_CONFIG is never read (exit 1)" "[ $rc -eq 1 ] && has '$FP' && no_key"

mkdir -p "$tmp/not-git"
run --root "$tmp/not-git"
check "a --root that isn't a git checkout's root is refused (exit 2)" "[ $rc -eq 2 ]"
run --root "$tmp/clean/src"
check "a --root inside a checkout, not its root, is refused (exit 2)" "[ $rc -eq 2 ]"
run --nope
check "an unknown argument is refused (exit 2)" "[ $rc -eq 2 ]"

if [ "$failures" -gt 0 ]; then
  echo "check-secrets.test: $failures failure(s)"
  exit 1
fi
echo "check-secrets.test: all passed"
