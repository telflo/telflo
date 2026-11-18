#!/bin/bash
# Refusal-only self-test for scripts/smoke-test-stack.sh (D36-2 decisions 96,
# 97 and 109; Ruling 407): the site and the project are checked before
# anything runs, and each refusal exits 2 having started nothing. No stack is
# started: stand-in docker, curl, node, psql and jq come first on PATH, each
# logging any call and failing (exit 97), and every case asserts the log is
# empty. The script runs with a clean environment (env -i: only PATH, HOME,
# TMPDIR and the case's own settings), its URLs pointed at a closed port, so
# no inherited setting can name a real stack. The project names are the
# cases' own values, passed in here.
# Cases: TELFLO_SMOKE_SITE unset, empty and unknown; oss with no project, an
# empty one, and each project that is never a throwaway. Each runs
# under a watchdog (a broken refusal must fail the case, not hang the test).
# A control (saas on a throwaway project's name) shows a run past the
# refusals reaches a stand-in, so an empty log means nothing started.
# Run:  bash scripts/smoke-test-stack.test.sh   (bash 3.2 compatible)
# SMOKE_TEST_STACK_SH=<copy> tests another copy (the deliberate breaks).
set -u
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
root="$(cd "$(dirname "$0")/.." && pwd)"
script="${SMOKE_TEST_STACK_SH:-$root/scripts/smoke-test-stack.sh}"
shell="${BASH:-bash}"

failures=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }

tmp="$(mktemp -d "$TMPDIR/smoke-test-stack-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"; log="$tmp/calls.log"
mkdir -p "$bin" "$tmp/home" "$tmp/t"
for tool in docker curl node psql jq; do
  printf '#!/bin/sh\nprintf "%%s %%s\\n" "%s" "$*" >>"%s"\nexit 97\n' "$tool" "$log" >"$bin/$tool"
  chmod +x "$bin/$tool"
done
closed=http://127.0.0.1:9

run() { # <variable assignments...>: the script in a clean environment; sets rc, out
  : >"$log"
  env -i PATH="$bin:/usr/bin:/bin" HOME="$tmp/home" TMPDIR="$tmp/t" \
    TELFLO_GATEWAY_URL="$closed" TELFLO_MAILPIT_API_URL="$closed" TELFLO_OPAMP_MANAGEMENT_HOST_URL="$closed" \
    TELFLO_OTELCOL_VALIDATOR_HOST_URL="$closed" TELFLO_OTELCOL_TESTING_HOST_URL="$closed" \
    TELFLO_OTTL_EVALUATOR_HOST_URL="$closed" TELFLO_OPAMP_AGENT_HOST_URL="$closed" \
    COMPOSE_FILE="$tmp/no-such-compose.yml" "$@" \
    "$shell" "$script" >"$tmp/out" 2>&1 </dev/null &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 200 ]; do sleep 0.1; waited=$((waited + 1)); done
  if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; echo "(watchdog: stopped after 20 s)" >>"$tmp/out"; fi
  wait "$pid"; rc=$?
  out="$(cat "$tmp/out")"
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
nothing_started() { [ ! -s "$log" ]; }

run
check "TELFLO_SMOKE_SITE unset: usage (exit 2), nothing started" \
  "[ $rc -eq 2 ] && has 'TELFLO_SMOKE_SITE is required' && nothing_started"
run TELFLO_SMOKE_SITE=
check "TELFLO_SMOKE_SITE empty: usage (exit 2), nothing started" \
  "[ $rc -eq 2 ] && has 'TELFLO_SMOKE_SITE is required' && nothing_started"
for site in bogus OSS "oss saas"; do
  run TELFLO_SMOKE_SITE="$site" COMPOSE_PROJECT_NAME=smoke-test-stack-test
  check "TELFLO_SMOKE_SITE='$site' (unknown): usage (exit 2), nothing started" \
    "[ $rc -eq 2 ] && has 'TELFLO_SMOKE_SITE is required' && nothing_started"
done
run TELFLO_SMOKE_SITE=oss
check "oss with no COMPOSE_PROJECT_NAME: refused (exit 2), nothing started" \
  "[ $rc -eq 2 ] && has 'runs on a throwaway stack only' && has 'COMPOSE_PROJECT_NAME is unset' && nothing_started"
run TELFLO_SMOKE_SITE=oss COMPOSE_PROJECT_NAME=
check "oss with an empty COMPOSE_PROJECT_NAME: refused (exit 2), nothing started" \
  "[ $rc -eq 2 ] && has 'runs on a throwaway stack only' && nothing_started"
for project in telflo telflo-dev telflo-platform; do
  run TELFLO_SMOKE_SITE=oss COMPOSE_PROJECT_NAME="$project"
  check "oss with COMPOSE_PROJECT_NAME=$project (never a throwaway stack): refused (exit 2), nothing started" \
    "[ $rc -eq 2 ] && has 'runs on a throwaway stack only' && has 'COMPOSE_PROJECT_NAME is $project' && nothing_started"
done
# The control: a run past the refusals (saas, a throwaway project's name) reaches the stand-ins, so
# an empty log above means nothing was started (the stand-ins fail it at its first call).
run TELFLO_SMOKE_SITE=saas COMPOSE_PROJECT_NAME=smoke-test-stack-test
check "the control: past the refusals the run reaches a stand-in (logged), fails, and the watchdog wasn't needed" \
  "[ $rc -ne 0 ] && [ $rc -ne 2 ] && [ -s '$log' ] && ! has 'watchdog'"

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILURE(S)"; exit 1; fi
