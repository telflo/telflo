#!/bin/bash
# Tests for scripts/release/check-workflows.sh: the real .github/workflows
# pass; each fixture of scripts/release/testdata/workflows/ breaks one rule in
# a copy of the real files and the check must fail naming that rule (and that
# file). A fixture is
#   file: <the workflow it changes>    rule: <the rule it breaks>
#   <<< (text found exactly once) === (its replacement) >>>, one or more
#   extra: <a file added to the folder>
# so the fixtures follow the real files: one whose text is no longer there
# fails here. Needs node and telflo-core's node_modules (the `yaml` package).
# Run:  bash scripts/release/check-workflows.test.sh   (bash 3.2 compatible)
set -u
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
root="$(cd "$(dirname "$0")/../.." && pwd)"
check_sh="$root/scripts/release/check-workflows.sh"
fixtures="$root/scripts/release/testdata/workflows"
shell="${BASH:-bash}"

failures=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-workflows-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT

run() { out="$("$shell" "$check_sh" "$@" 2>&1)"; rc=$?; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }

run
check "the real release.yml, collector.yml and ci.yml pass (exit 0)" "[ $rc -eq 0 ] && has 'check-workflows: OK'"
run --bogus
check "an unknown argument: usage (exit 2)" "[ $rc -eq 2 ]"
mkdir -p "$tmp/no-yaml"
run --root "$tmp/no-yaml"
check "no telflo-core node_modules (no yaml package): exit 2" "[ $rc -eq 2 ] && has \"package isn't installed\""

count=0
for fixture in "$fixtures"/*.fixture; do
  count=$((count + 1))
  name="$(basename "$fixture" .fixture)"
  copy="$tmp/$name"
  mkdir -p "$copy"
  cp "$root/.github/workflows/"* "$copy/"
  # Apply it: each find text must be there exactly once.
  meta="$(python3 -I - "$fixture" "$copy" <<'PY'
import os, re, sys
fixture, copy = sys.argv[1:3]
text = open(fixture, encoding="utf-8").read()
file = re.search(r"^file: (\S+)$", text, re.M).group(1)
rule = re.search(r"^rule: (\S+)$", text, re.M).group(1)
extra = re.search(r"^extra: (\S+)$", text, re.M)
if extra:
    with open(os.path.join(copy, extra.group(1)), "w") as handle:
        handle.write("name: extra\non: push\njobs: {}\n")
else:
    path = os.path.join(copy, file)
    body = open(path, encoding="utf-8").read()
    pairs = re.findall(r"^<<<\n(.*?)\n===\n(.*?)\n>>>$", text, re.M | re.S)
    if not pairs:
        print("BAD no find/replace block")
        sys.exit(0)
    for find, replace in pairs:
        if body.count(find) != 1:
            print("BAD the find text is there %d times" % body.count(find))
            sys.exit(0)
        body = body.replace(find, replace)
    open(path, "w", encoding="utf-8").write(body)
print(file, rule)
PY
)"
  case "$meta" in
    BAD*) check "$name: the fixture applies to the real files (${meta#BAD })" false; continue ;;
  esac
  file="${meta% *}"; rule="${meta#* }"
  run --dir "$copy" --root "$root"
  check "$name: the check fails (exit 1) naming the rule $rule in $file" "[ $rc -eq 1 ] && has 'check-workflows: $file: $rule: '"
done
check "the fixtures are there (at least one per rule)" "[ $count -ge 139 ]"
# Every rule check-workflows.mjs lists in its header has a fixture that breaks it.
rules="$(sed -n 's#^//   \([a-z][a-z-]*\)  .*#\1#p' "$root/scripts/release/check-workflows.mjs" | sort -u)"
covered="$(sed -n 's/^rule: //p' "$fixtures"/*.fixture | sort -u)"
uncovered="$(printf '%s\n' "$rules" | grep -vxF -f <(printf '%s\n' "$covered") || true)"
check "every rule in check-workflows.mjs's header has a fixture (uncovered: ${uncovered:-none})" "[ -z \"\$uncovered\" ] && [ \$(printf '%s\n' \"\$rules\" | grep -c '') -ge 65 ]"

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILURE(S)"; exit 1; fi
