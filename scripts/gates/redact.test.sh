#!/usr/bin/env bash
# redact.sh's self-test: every pattern the gates redact is redacted, with
# values made at run time (base64's + / = among them) and kept in files of a
# private temporary folder (never on an argv), and checked by boolean only:
# the output holds no value, and the line holds a REDACTED marker. Prints
# PASS/FAIL lines and REDACTED counts, never a value.
#
# Run: bash scripts/gates/redact.test.sh   (REDACT_SH=<path> tests another copy)
# Offline; bash 3.2 compatible; exit 1 when any case failed.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REDACT_SH="${REDACT_SH:-$SCRIPT_DIR/redact.sh}"

umask 077
tmp="$(mktemp -d "${TMPDIR:-/tmp}/redact-test.XXXXXX")" || exit 2
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

# A fresh value with base64's + / and = in it: 33 random bytes, base64, then
# the three characters appended so every class is exercised.
n=0
new_value() { # -> $v: the file holding a new value
  n=$((n + 1)); v="$tmp/value$n"
  { head -c 33 /dev/urandom | base64 | tr -d '\n'; printf '+/=\n'; } >"$v"
}

# redacted <prefix> <suffix>: the line "<prefix><value><suffix>" through
# redact.sh hides the value and shows a REDACTED marker.
redacted() {
  local out="$tmp/out$n"
  { printf '%s' "$1"; tr -d '\n' <"$v"; printf '%s\n' "$2"; } | bash "$REDACT_SH" >"$out" 2>"$tmp/err$n" || return 1
  ! grep -qF -f "$v" "$out" && grep -q REDACTED "$out"
}

for prefix in "token tf_" "/assets/tqd_" "link /api/v1/library-links/tll_"; do
  new_value
  run_case "$(printf '%s' "$prefix" | sed 's/.* //; s#.*/##')… is redacted" redacted "$prefix" " trailing"
done
for setting in AWS_SECRET_ACCESS_KEY TELFLO_TEST_S3_SECRET_ACCESS_KEY TELFLO_LIBRARY_LINK_SIGNING_KEY TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS \
  TELFLO_SMTP_PASSWORD PASSWORD TELFLO_OTELCOL_VALIDATOR_SECRET SECRET TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY KEY; do
  new_value
  run_case "$setting=… is redacted" redacted "export $setting=" " next=word"
done

# The development object store's secret, bare (a stack's logs may print it).
printf 'telflo-development-only-object-store-secret-not-for-production\n' >"$tmp/dev-secret"
dev_secret() {
  { printf 's3 secret '; cat "$tmp/dev-secret"; } | bash "$REDACT_SH" >"$tmp/out-dev" || return 1
  ! grep -qF -f "$tmp/dev-secret" "$tmp/out-dev" && grep -q REDACTED "$tmp/out-dev"
}
run_case "the development object store's secret is redacted bare" dev_secret

# --literals: a run's own values, bare, among them one full of the regular
# expressions' special characters; a near miss stays as it was.
new_value; lit1=$v
printf 'a.b*c[d]e$f^g#h\\i/j&k\n' >"$tmp/special"
cat "$lit1" "$tmp/special" >"$tmp/literals"
literal_case() { # <value file>
  local out="$tmp/lit-out"
  { printf 'bare '; tr -d '\n' <"$1"; printf ' end\n'; } | bash "$REDACT_SH" --literals "$tmp/literals" >"$out" || return 1
  ! grep -qF -f "$1" "$out" && grep -q 'REDACTED-literal' "$out"
}
run_case "--literals: a generated value is redacted bare" literal_case "$lit1"
run_case "--literals: a value with sed's special characters is redacted as a fixed string" literal_case "$tmp/special"
near_miss() {
  [ "$(printf 'aXb*c[d]e$f^g#h\\i/j&k\n' | bash "$REDACT_SH" --literals "$tmp/literals")" = 'aXb*c[d]e$f^g#h\i/j&k' ]
}
run_case "--literals: a near miss (. is not a wildcard) is left as it was" near_miss

# Lines with nothing to hide pass unchanged; usage errors exit 2.
plain() {
  [ "$(printf 'ok: GET /login 200 KEY_ID absent; tf-not-a-token\n' | bash "$REDACT_SH")" = 'ok: GET /login 200 KEY_ID absent; tf-not-a-token' ]
}
run_case "a line with nothing to hide is unchanged" plain
usage_rc() { local rc; bash "$REDACT_SH" "$@" </dev/null >/dev/null 2>&1; rc=$?; [ "$rc" = 2 ]; }
run_case "an unknown argument exits 2" usage_rc --nope
run_case "--literals without a file exits 2" usage_rc --literals
run_case "--literals naming no file exits 2" usage_rc --literals "$tmp/absent"

total_redacted=$(cat "$tmp"/out* "$tmp/lit-out" 2>/dev/null | grep -c REDACTED)
echo "REDACTED lines in the cases' outputs: $total_redacted"
echo "redact.test.sh: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
