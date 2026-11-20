#!/usr/bin/env bash
# Verifies scripts/check-licenses.sh rejects a disallowed or unknown license,
# passes an allowed one, and admits an MPL-2.0 module only when the policy's
# "goModules" names it at the version the build uses. The fixtures in
# scripts/testdata are tiny modules, each with its own LICENSE; mpl-module
# depends on an MPL-2.0 module, example.com/mpl-fixture v1.9.0, vendored
# inside it, so its version is known with no network. This needs no network
# once go-licenses is built. (Go leaves testdata out of ./..., so they are
# never part of the service's build.) The check scans linux/amd64 and
# linux/arm64 whatever machine runs it: a module only one of them imports
# is checked too.
set -uo pipefail
cd "$(dirname "$0")/.."
FAILURES=0

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# expect <pass|fail> <description> <module-dir> [policy]
# A failing case must exit 1 (a license was refused), not 2 (the check
# couldn't run), and must name the fixture's license, so a broken tool can't
# pass for a refusal.
expect() {
  local outcome="$1" description="$2" module_dir="$3" policy="${4:-}" output status
  output=$(./scripts/check-licenses.sh "$policy" "$module_dir" 2>&1)
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

# expect_error <description> <module-dir> <policy>: the check can't run (2).
expect_error() {
  local description="$1" module_dir="$2" policy="$3" status
  ./scripts/check-licenses.sh "$policy" "$module_dir" >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 2 ]; then
    echo "FAIL: $description should exit 2, got $status"; FAILURES=$((FAILURES + 1))
  fi
}

expect fail "a GPL-3.0 module" scripts/testdata/gpl-module
expect pass "an MIT module" scripts/testdata/mit-module

# No LICENSE at all: go-licenses reports "Unknown", which must be refused.
# Built here rather than committed, so no LICENSE in a parent directory can
# be found for it.
mkdir "$scratch/unlicensed"
cp scripts/testdata/mit-module/go.mod scripts/testdata/mit-module/fixture.go "$scratch/unlicensed/"
expect fail "a module with no license" "$scratch/unlicensed"

# The policy path is an argument: a policy that allows GPL-3.0 lets the GPL
# fixture through, and one that allows only Apache-2.0 refuses the MIT one.
echo '{ "allowed": ["GPL-3.0"] }' > "$scratch/allow-gpl.json"
expect pass "a GPL-3.0 module under a policy that allows it" scripts/testdata/gpl-module "$scratch/allow-gpl.json"
echo '{ "allowed": ["Apache-2.0"] }' > "$scratch/apache-only.json"
expect fail "an MIT module under a policy without MIT" scripts/testdata/mit-module "$scratch/apache-only.json"

# goModules: the MPL-2.0 module passes only when it is named at the
# version the build uses.
cat > "$scratch/named.json" <<'EOF'
{ "allowed": ["MIT"],
  "goModules": { "$comment": "the fixture", "example.com/mpl-fixture@v1.9.0": "the self-test's fixture" } }
EOF
cat > "$scratch/named-other-version.json" <<'EOF'
{ "allowed": ["MIT"], "goModules": { "example.com/mpl-fixture@v1.9.1": "another version" } }
EOF
cat > "$scratch/named-other-module.json" <<'EOF'
{ "allowed": ["MIT"], "goModules": { "example.com/mpl-fixture-two@v1.9.0": "another module" } }
EOF
echo '{ "allowed": ["MIT"] }' > "$scratch/unnamed.json"
expect pass "an MPL-2.0 module named at its version" scripts/testdata/mpl-module "$scratch/named.json"
expect fail "an MPL-2.0 module named at another version" scripts/testdata/mpl-module "$scratch/named-other-version.json"
expect fail "an MPL-2.0 module whose name is only a prefix of a named one" scripts/testdata/mpl-module "$scratch/named-other-module.json"
expect fail "an unnamed MPL-2.0 module" scripts/testdata/mpl-module "$scratch/unnamed.json"

# A module only one platform's build imports: the fixture's import of the
# MPL-2.0 module moved into a file built for one architecture alone. Unnamed,
# it is refused whichever architecture it is and whichever machine runs the
# check; named, it passes.
for arch in amd64 arm64; do
  cp -R scripts/testdata/mpl-module "$scratch/only-$arch"
  printf '// Package fixture: the import is in fixture_%s.go.\npackage fixture\n' "$arch" > "$scratch/only-$arch/fixture.go"
  printf '//go:build %s\n\npackage fixture\n\nimport _ "example.com/mpl-fixture"\n' "$arch" > "$scratch/only-$arch/fixture_$arch.go"
  expect fail "an unnamed MPL-2.0 module imported on linux/$arch only" "$scratch/only-$arch" "$scratch/unnamed.json"
  expect pass "a named MPL-2.0 module imported on linux/$arch only" "$scratch/only-$arch" "$scratch/named.json"
done

# The same module, built at another version (v1.9.1), under the policy that
# names v1.9.0.
cp -R scripts/testdata/mpl-module "$scratch/other-version"
sed -i.bak 's/v1\.9\.0/v1.9.1/' "$scratch/other-version/go.mod" "$scratch/other-version/vendor/modules.txt"
expect fail "the named MPL-2.0 module at another version" "$scratch/other-version" "$scratch/named.json"

# goModules admits MPL-2.0 only: the named module and version, carrying
# GPL-3.0, is refused.
cp -R scripts/testdata/mpl-module "$scratch/named-gpl"
cp scripts/testdata/gpl-module/LICENSE "$scratch/named-gpl/vendor/example.com/mpl-fixture/LICENSE"
expect fail "a named module carrying GPL-3.0" "$scratch/named-gpl" "$scratch/named.json"

# The named module and version, replaced by a local directory: its code
# isn't the reviewed release, so the name doesn't admit it.
mkdir -p "$scratch/replaced/local"
cp scripts/testdata/mpl-module/LICENSE scripts/testdata/mpl-module/go.mod scripts/testdata/mpl-module/fixture.go "$scratch/replaced/"
cp scripts/testdata/mpl-module/vendor/example.com/mpl-fixture/* "$scratch/replaced/local/"
printf 'module example.com/mpl-fixture\n\ngo 1.26.9\n' > "$scratch/replaced/local/go.mod"
printf '\nreplace example.com/mpl-fixture v1.9.0 => ./local\n' >> "$scratch/replaced/go.mod"
expect fail "the named module replaced by a local directory" "$scratch/replaced" "$scratch/named.json"

# A missing policy, or a goModules that isn't "module@version" -> reason, is
# an error, never a pass.
expect_error "a missing policy file" scripts/testdata/mit-module "$scratch/no-such-policy.json"
echo '{ "allowed": ["MIT"], "goModules": ["example.com/mpl-fixture@v1.9.0"] }' > "$scratch/list.json"
expect_error "goModules as a list" scripts/testdata/mpl-module "$scratch/list.json"
echo '{ "allowed": ["MIT"], "goModules": { "example.com/mpl-fixture": "no version" } }' > "$scratch/no-version.json"
expect_error "a goModules entry without a version" scripts/testdata/mpl-module "$scratch/no-version.json"
echo '{ "allowed": ["MIT"], "goModules": { "example.com/mpl-fixture@v1.9.0": "" } }' > "$scratch/no-reason.json"
expect_error "a goModules entry without a reason" scripts/testdata/mpl-module "$scratch/no-reason.json"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES license-check test(s) failed"
  exit 1
fi
echo "All license-check tests passed"
