#!/usr/bin/env bash
# Verifies scripts/check-licenses.mjs rejects non-redistributable licenses and passes everything else.
set -uo pipefail
cd "$(dirname "$0")/.."
FAILURES=0

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

# Writes a lockfile whose single production package carries the given license
# field (a JSON value, so '"MIT"' or 'null').
lockfile_with() {
  local license="$1" extra="${2:-}"
  cat > "$fixture/package-lock.json" <<EOF
{
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "root" },
    "apps/web": { "name": "@telflo/web" },
    "node_modules/@telflo/web": { "resolved": "apps/web", "link": true },
    "node_modules/some-dep": { "version": "1.0.0", "license": $license $extra }
  }
}
EOF
}

expect() {
  local outcome="$1" description="$2"
  if ./scripts/check-licenses.mjs "$fixture/package-lock.json" >/dev/null 2>&1; then
    [ "$outcome" = pass ] || { echo "FAIL: $description should be rejected"; FAILURES=$((FAILURES + 1)); }
  else
    [ "$outcome" = fail ] || { echo "FAIL: $description should pass"; FAILURES=$((FAILURES + 1)); }
  fi
}

lockfile_with '"MIT"';                            expect pass "MIT"
lockfile_with '"GPL-3.0-only"';                   expect fail "GPL-3.0-only"
lockfile_with '"AGPL-3.0-or-later"';              expect fail "AGPL-3.0-or-later"
lockfile_with '"SSPL-1.0"';                       expect fail "SSPL-1.0"
lockfile_with '"BUSL-1.1"';                       expect fail "BUSL-1.1"
lockfile_with 'null';                             expect fail "a missing license"
lockfile_with '"SEE LICENSE IN LICENSE.md"';      expect fail "a non-SPDX license reference"
lockfile_with '"UNLICENSED"';                     expect fail "UNLICENSED (proprietary)"
lockfile_with '"(MIT OR GPL-3.0-only)"';          expect pass "a dual license with an allowed choice"
lockfile_with '"(MIT AND GPL-3.0-only)"';         expect fail "a conjunction including GPL"
lockfile_with '"(MIT AND BSD-3-Clause)"';         expect pass "a conjunction of allowed licenses"
lockfile_with '"Apache-2.0 WITH LLVM-exception"'; expect pass "an allowed license with an exception"
lockfile_with '"GPL-3.0-only"' ', "dev": true';    expect pass "a GPL package used only in development"
lockfile_with '"GPL-3.0-only"' ', "devOptional": true'; expect fail "a devOptional GPL package (may ship)"

# A policy exception lets a hand-checked package through.
lockfile_with 'null'
cat > "$fixture/policy.json" <<'EOF'
{ "allowed": ["MIT"], "exceptions": { "some-dep": "Checked by hand: MIT in LICENSE file." } }
EOF
if ! ./scripts/check-licenses.mjs "$fixture/package-lock.json" "$fixture/policy.json" >/dev/null 2>&1; then
  echo "FAIL: a package named in the policy's exceptions should pass"; FAILURES=$((FAILURES + 1))
fi

# An exception for name@version lets that version through, and no other.
lockfile_with 'null'
cat > "$fixture/policy.json" <<'EOF'
{ "allowed": ["MIT"], "exceptions": { "some-dep@1.0.0": "Checked by hand at 1.0.0: MIT in LICENSE file." } }
EOF
if ! ./scripts/check-licenses.mjs "$fixture/package-lock.json" "$fixture/policy.json" >/dev/null 2>&1; then
  echo "FAIL: the version named in a name@version exception should pass"; FAILURES=$((FAILURES + 1))
fi
cat > "$fixture/policy.json" <<'EOF'
{ "allowed": ["MIT"], "exceptions": { "some-dep@0.9.0": "Checked by hand at 0.9.0: MIT in LICENSE file." } }
EOF
if ./scripts/check-licenses.mjs "$fixture/package-lock.json" "$fixture/policy.json" >/dev/null 2>&1; then
  echo "FAIL: a version other than the one in a name@version exception should be rejected"; FAILURES=$((FAILURES + 1))
fi

# Vendored files (the policy's "vendored", paths relative to the policy
# file): the folder must hold exactly the recorded files, each with its
# recorded sha256, under allowed licenses.
lockfile_with '"MIT"'
mkdir -p "$fixture/vendor"
printf 'vendored bytes\n' > "$fixture/vendor/a.js"
vendored_sha=$(shasum -a 256 "$fixture/vendor/a.js" | cut -d' ' -f1)
vendored_policy() {
  cat > "$fixture/policy.json" <<EOF
{ "allowed": ["MIT", "Apache-2.0"], "vendored": { "vendor": { "licenses": [$1], "files": { "a.js": "$2" } } } }
EOF
}
expect_vendored() {
  local outcome="$1" description="$2"
  if ./scripts/check-licenses.mjs "$fixture/package-lock.json" "$fixture/policy.json" >/dev/null 2>&1; then
    [ "$outcome" = pass ] || { echo "FAIL: $description should be rejected"; FAILURES=$((FAILURES + 1)); }
  else
    [ "$outcome" = fail ] || { echo "FAIL: $description should pass"; FAILURES=$((FAILURES + 1)); }
  fi
}
vendored_policy '"MIT"' "$vendored_sha";                          expect_vendored pass "a vendored file as recorded"
vendored_policy '"(Apache-2.0 OR MPL-2.0)"' "$vendored_sha";      expect_vendored pass "a vendored file under a dual license with an allowed choice"
vendored_policy '"MIT", "GPL-3.0-only"' "$vendored_sha";          expect_vendored fail "a vendored folder with a GPL license"
vendored_policy '' "$vendored_sha";                               expect_vendored fail "a vendored folder with no license recorded"
vendored_policy '"MIT"' "0000000000000000000000000000000000000000000000000000000000000000"; expect_vendored fail "a vendored file whose sha256 isn't the recorded one"
vendored_policy '"MIT"' "$vendored_sha"
printf 'more\n' > "$fixture/vendor/b.js";                         expect_vendored fail "a vendored folder holding a file not recorded"
rm "$fixture/vendor/b.js"
mkdir "$fixture/vendor/sub";                                        expect_vendored fail "a vendored folder holding a sub-folder"
rmdir "$fixture/vendor/sub";                                        expect_vendored pass "the vendored folder as recorded again"
rm "$fixture/vendor/a.js";                                          expect_vendored fail "a recorded vendored file that is missing"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES license-check test(s) failed"
  exit 1
fi
echo "All license-check tests passed"
