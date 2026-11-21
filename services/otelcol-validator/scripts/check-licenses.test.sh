#!/usr/bin/env bash
# Verifies scripts/check-licenses.sh refuses a disallowed or unknown license
# and passes an allowed one, from each place a package can state it (PEP 639
# expression, the License field, trove classifiers). Each fixture is a tiny
# wheel made here, with nothing but its metadata, pinned by its sha256 in a
# lock of its own and installed the way the check installs the real lock, so
# this needs no network. Needs what the check needs: python3 (or $PYTHON)
# with the development lock installed.
set -uo pipefail
cd "$(dirname "$0")/.."
FAILURES=0
python=${PYTHON:-python3}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# wheel <name> <metadata lines...>: builds <name>-1.0-py3-none-any.whl in
# $scratch and writes $scratch/<name>.lock pinning it by its sha256.
wheel() {
  local name="$1"
  shift
  "$python" - "$scratch" "$name" "$@" <<'PY'
import base64, hashlib, sys, zipfile
from pathlib import Path

scratch, name, *lines = sys.argv[1:]
module = name.replace("-", "_")
dist_info = f"{module}-1.0.dist-info"
files = {
    f"{module}/__init__.py": b"",
    f"{dist_info}/METADATA": "\n".join(
        ["Metadata-Version: 2.4", f"Name: {name}", "Version: 1.0", *lines, "", ""]
    ).encode(),
    f"{dist_info}/WHEEL": b"Wheel-Version: 1.0\nGenerator: check-licenses.test.sh\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
}
def record_hash(data: bytes) -> str:
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
record = "".join(f"{path},{record_hash(data)},{len(data)}\n" for path, data in files.items())
files[f"{dist_info}/RECORD"] = (record + f"{dist_info}/RECORD,,\n").encode()
path = Path(scratch) / f"{module}-1.0-py3-none-any.whl"
with zipfile.ZipFile(path, "w") as archive:
    for member, data in files.items():
        archive.writestr(member, data)
digest = hashlib.sha256(path.read_bytes()).hexdigest()
(Path(scratch) / f"{name}.lock").write_text(f"{name} @ {path.as_uri()} \\\n    --hash=sha256:{digest}\n")
PY
}

# expect <pass|fail> <description> <lock> [policy]
# A refusal must exit 1 (a license was refused), not 2 (the check couldn't
# run), and must say NOT ALLOWED, so a broken tool can't pass for a refusal.
expect() {
  local outcome="$1" description="$2" lock="$3" policy="${4:-../../scripts/license-policy.json}" output status
  output=$(PYTHON="$python" ./scripts/check-licenses.sh "$policy" "$lock" 2>&1)
  status=$?
  case "$outcome" in
    pass)
      if [ "$status" -ne 0 ]; then
        echo "FAIL: $description should pass (exit $status):"
        echo "$output" | sed 's/^/    /'
        FAILURES=$((FAILURES + 1))
      fi
      ;;
    fail)
      if [ "$status" -ne 1 ] || ! grep -q "NOT ALLOWED" <<<"$output"; then
        echo "FAIL: $description should be refused (exit $status):"
        echo "$output" | sed 's/^/    /'
        FAILURES=$((FAILURES + 1))
      fi
      ;;
  esac
}

wheel fixture-mit "License-Expression: MIT"
expect pass "an MIT expression" "$scratch/fixture-mit.lock"
wheel fixture-psf "License-Expression: PSF-2.0"
expect pass "a PSF-2.0 expression" "$scratch/fixture-psf.lock"
wheel fixture-gpl "License-Expression: GPL-3.0-only"
expect fail "a GPL-3.0-only expression" "$scratch/fixture-gpl.lock"
wheel fixture-or "License-Expression: Apache-2.0 OR GPL-3.0-only"
expect pass "Apache-2.0 OR GPL-3.0-only (telflo may choose Apache-2.0)" "$scratch/fixture-or.lock"
wheel fixture-and "License-Expression: MIT AND GPL-3.0-only"
expect fail "MIT AND GPL-3.0-only" "$scratch/fixture-and.lock"
# The expression decides over a classifier that says otherwise.
wheel fixture-expression-first "License-Expression: AGPL-3.0-only" "Classifier: License :: OSI Approved :: MIT License"
expect fail "an AGPL expression beside an MIT classifier" "$scratch/fixture-expression-first.lock"

wheel fixture-field-spdx "License: BSD-3-Clause"
expect pass "an SPDX License field" "$scratch/fixture-field-spdx.lock"
wheel fixture-field-spelling "License: 3-Clause BSD License"
expect pass "a License field in a known spelling" "$scratch/fixture-field-spelling.lock"
wheel fixture-field-sspl "License: SSPL-1.0"
expect fail "an SSPL-1.0 License field" "$scratch/fixture-field-sspl.lock"

wheel fixture-classifier-mit "Classifier: License :: OSI Approved :: MIT License"
expect pass "an MIT classifier" "$scratch/fixture-classifier-mit.lock"
wheel fixture-classifier-gpl "Classifier: License :: OSI Approved :: GNU General Public License v3 (GPLv3)"
expect fail "a GPLv3 classifier" "$scratch/fixture-classifier-gpl.lock"
wheel fixture-classifier-mpl "Classifier: License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)"
expect fail "an MPL 2.0 classifier" "$scratch/fixture-classifier-mpl.lock"
wheel fixture-classifier-both "Classifier: License :: OSI Approved :: MIT License" \
  "Classifier: License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)"
expect fail "an MIT and an LGPLv3 classifier (both must be allowed)" "$scratch/fixture-classifier-both.lock"
# "BSD License" names no clause count: unknown, never a pass.
wheel fixture-classifier-bsd "Classifier: License :: OSI Approved :: BSD License"
expect fail "a bare BSD License classifier" "$scratch/fixture-classifier-bsd.lock"
# Free text that is neither SPDX nor a known spelling falls through to the
# classifiers; with none, it is unknown.
wheel fixture-field-text "License: Permission is hereby granted, free of charge"
expect fail "a License field of free text and no classifier" "$scratch/fixture-field-text.lock"
wheel fixture-none
expect fail "a package with no license at all" "$scratch/fixture-none.lock"

# The policy path is an argument: a policy that allows GPL-3.0-only lets the
# GPL fixture through, and one that allows only Apache-2.0 refuses MIT.
echo '{ "allowed": ["GPL-3.0-only"] }' > "$scratch/allow-gpl.json"
expect pass "a GPL-3.0-only package under a policy that allows it" "$scratch/fixture-gpl.lock" "$scratch/allow-gpl.json"
echo '{ "allowed": ["Apache-2.0"] }' > "$scratch/apache-only.json"
expect fail "an MIT package under a policy without MIT" "$scratch/fixture-mit.lock" "$scratch/apache-only.json"

# A missing policy or lock is an error, never a pass.
for args in "$scratch/no-such-policy.json $scratch/fixture-mit.lock" "../../scripts/license-policy.json $scratch/no-such.lock"; do
  # shellcheck disable=SC2086 # two paths without spaces, split on purpose
  PYTHON="$python" ./scripts/check-licenses.sh $args >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 2 ]; then
    echo "FAIL: check-licenses.sh $args should exit 2, got $status"; FAILURES=$((FAILURES + 1))
  fi
done

# A report naming a package twice (as normalized) can't be checked: the
# second entry would hide the first. evaluate-licenses.py refuses it with
# exit 2, whatever the licenses say; the same report with the name once passes.
printf 'fixture-dup==1.0 \\\n    --hash=sha256:%064d\n' 0 > "$scratch/dup.lock"
dup_entry() { printf '{"Name": "%s", "Version": "1.0", "License-Expression": "%s", "License-Metadata": "UNKNOWN", "License-Classifier": "UNKNOWN"}' "$1" "$2"; }
echo "[$(dup_entry fixture-dup MIT)]" > "$scratch/once.json"
echo "[$(dup_entry fixture-dup GPL-3.0-only), $(dup_entry Fixture_Dup MIT)]" > "$scratch/twice.json"
"$python" ./scripts/evaluate-licenses.py ../../scripts/license-policy.json "$scratch/once.json" "$scratch/dup.lock" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  echo "FAIL: a report naming fixture-dup once should pass, got exit $status"; FAILURES=$((FAILURES + 1))
fi
output=$("$python" ./scripts/evaluate-licenses.py ../../scripts/license-policy.json "$scratch/twice.json" "$scratch/dup.lock" 2>&1)
status=$?
if [ "$status" -ne 2 ] || ! grep -q "names fixture-dup more than once" <<<"$output"; then
  echo "FAIL: a report naming fixture-dup twice should exit 2, got $status:"
  echo "$output" | sed 's/^/    /'
  FAILURES=$((FAILURES + 1))
fi

# A report entry without a package name (no "Name", or one that isn't a
# string) can't be matched to the lock, so it would go unchecked:
# evaluate-licenses.py refuses the report with exit 2.
for entry in '{"Version": "1.0", "License-Expression": "MIT"}' '{"Name": null, "Version": "1.0", "License-Expression": "MIT"}'; do
  echo "[$(dup_entry fixture-dup MIT), $entry]" > "$scratch/nameless.json"
  output=$("$python" ./scripts/evaluate-licenses.py ../../scripts/license-policy.json "$scratch/nameless.json" "$scratch/dup.lock" 2>&1)
  status=$?
  if [ "$status" -ne 2 ] || ! grep -q "has an entry without a package name" <<<"$output"; then
    echo "FAIL: a report with the entry $entry should exit 2, got $status:"
    echo "$output" | sed 's/^/    /'
    FAILURES=$((FAILURES + 1))
  fi
done

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES license-check test(s) failed"
  exit 1
fi
echo "All license-check tests passed"
