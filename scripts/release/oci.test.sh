#!/bin/bash
# Tests for scripts/release/oci.sh, offline: archives made by
# test-registry.sh's fixture (and tampered with), a crane wrapper that
# records every call and refuses to push, and docker stand-ins for the image
# store's question. No registry, no network.
# Run:  bash scripts/release/oci.test.sh
# bash 3.2 compatible.
set -u
# One spelling of the temporary folder (no trailing slash, no //), and no CI:
# the test sets CI itself where a case needs it.
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI TELFLO_CRANE
root="$(cd "$(dirname "$0")/../.." && pwd)"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }

tmp="$(mktemp -d "$TMPDIR/oci-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"; logs="$tmp/logs"
mkdir -p "$bin" "$logs" "$tmp/work"
tr_crane_wrapper "$bin" "$logs" /nonexistent/crane

# lib <function and arguments…>: one call of the library in a fresh shell;
# sets rc and out (stdout and stderr).
lib() {
  : >"$logs/crane-calls.log"
  out="$(env TELFLO_OCI_PREFIX=t TELFLO_OCI_TMP="$tmp/work" "$shell" -c '. "$1"; shift; "$@"' _ "$root/scripts/release/oci.sh" "$@" 2>&1)"; rc=$?
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
no_crane() { [ -f "$logs/crane-calls.log" ] && [ ! -s "$logs/crane-calls.log" ]; }

R=0123456789abcdef0123456789abcdef01234567
good="$tmp/good.oci.tar"; A="$(tr_fixture "$good" 1.0.0 "$R" A)"
other="$tmp/other.oci.tar"; B="$(tr_fixture "$other" 1.0.0 "$R" B)"
fresh() { cp "$good" "$tmp/case.oci.tar"; }

# --- 1. inspect --------------------------------------------------------------------------
lib telflo_oci_inspect "$good" "$A" 1.0.0 "$R" attest
check "a good archive passes (index, both platforms, attestations)" \
  "[ $rc -eq 0 ] && has 'index $A' && has 'attestations 2'"
fresh; tr_tamper "$tmp/case.oci.tar" flip-layer
lib telflo_oci_inspect "$tmp/case.oci.tar" "$A" 1.0.0 "$R"
check "inspect hashes every blob: one layer byte flipped is refused" "[ $rc -eq 1 ] && has \"doesn't hash to its name\""
fresh; tr_tamper "$tmp/case.oci.tar" two-entries
lib telflo_oci_inspect "$tmp/case.oci.tar" "$A"
check "an index.json with two entries refused" "[ $rc -eq 1 ] && has 'index.json must have exactly one entry (found 2)'"
fresh; tr_tamper "$tmp/case.oci.tar" manifest-list
lib telflo_oci_inspect "$tmp/case.oci.tar" "$A"
check "an index.json entry typed as a manifest list refused" "[ $rc -eq 1 ] && has \"index.json's entry isn't an OCI image index\""
lib telflo_oci_inspect "$other" "$A"
check "another archive's index refused" "[ $rc -eq 1 ] && has \"index.json's entry is $B, not $A\""
tr_fixture "$tmp/na.oci.tar" 1.0.0 "$R" A no-attest >/dev/null
lib telflo_oci_inspect "$tmp/na.oci.tar" "" 1.0.0 "$R" attest
check "attest: an archive without attestation manifests refused" "[ $rc -eq 1 ] && has 'has no attestation manifest'"

# --- 2. unpack -----------------------------------------------------------------------------
lib telflo_oci_unpack "$good" "$tmp/u1" "$A"
check "unpack writes the layout (oci-layout, index.json, every blob)" \
  "[ $rc -eq 0 ] && [ -f '$tmp/u1/oci-layout' ] && [ -f '$tmp/u1/index.json' ] && [ \$(ls '$tmp/u1/blobs/sha256' | grep -c '') -eq \$(tar -tf '$good' | grep -c '^blobs/sha256/.') ]"
fresh; tr_tamper "$tmp/case.oci.tar" flip-layer
lib telflo_oci_unpack "$tmp/case.oci.tar" "$tmp/u2" "$A"
check "unpack refuses a corrupt blob (its sha256 checked as it is written)" "[ $rc -eq 1 ] && has \"doesn't hash to its name\""
lib telflo_oci_unpack "$good" "$tmp/u3" "$B"
check "unpack refuses an index.json whose one entry isn't the digest asked for" "[ $rc -eq 1 ] && has \"index.json's entry is $A, not $B\" && [ ! -e '$tmp/u3/index.json' ]"
fresh; tr_tamper "$tmp/case.oci.tar" two-entries
lib telflo_oci_unpack "$tmp/case.oci.tar" "$tmp/u4" "$A"
check "unpack refuses a two-entry index.json" "[ $rc -eq 1 ] && has 'exactly one entry'"
lib telflo_oci_unpack "$good" "$tmp/u1" "$A"
check "unpack never writes into an existing folder" "[ $rc -eq 1 ]"

# --- 3. the copy re-checks the archive as it is now ---------------------------------------------
copy() { # <tar> <want> [<STANDIN_CRANE> [<STANDIN_DIGEST>]]: telflo_oci_copy with the wrapper (by default
  # the tag absent; a push always refused)
  : >"$logs/crane-calls.log"
  out="$(env STANDIN_CRANE="${3:-absent}" STANDIN_DIGEST="${4:-}" TELFLO_CRANE="$bin/crane" TELFLO_OCI_PREFIX=t TELFLO_OCI_TMP="$tmp/work" \
    "$shell" -c '. "$1"; TELFLO_CRANE="$TELFLO_CRANE"; telflo_oci_copy "$2" "$3" 127.0.0.1:5999/telflo/telflo/x:1.0.0 1.0.0 "$4" ""' \
    _ "$root/scripts/release/oci.sh" "$1" "$2" "$R" 2>&1)"; rc=$?
}
fresh; tr_tamper "$tmp/case.oci.tar" two-entries
copy "$tmp/case.oci.tar" "$A"
check "the copy refuses an archive grown a second index.json entry since pass 1: no crane call" \
  "[ $rc -eq 1 ] && has 'exactly one entry' && has 'refused at the copy' && no_crane"
fresh; tr_tamper "$tmp/case.oci.tar" manifest-list
copy "$tmp/case.oci.tar" "$A"
check "the copy refuses an index.json entry that became a manifest list: no crane call" \
  "[ $rc -eq 1 ] && has \"isn't an OCI image index\" && no_crane"
copy "$other" "$A"
check "the copy refuses an archive swapped for another (its index isn't the digest file's): no crane call" \
  "[ $rc -eq 1 ] && has \"index.json's entry is $B, not $A\" && no_crane"
fresh; tr_tamper "$tmp/case.oci.tar" flip-layer
copy "$tmp/case.oci.tar" "$A"
check "the copy refuses a blob corrupted since pass 1: no crane call" "[ $rc -eq 1 ] && has \"doesn't hash to its name\" && no_crane"
copy "$good" "$A"
check "a good archive gets past every check to 'crane push <layout> <ref>' (the wrapper refuses it), the layout removed" \
  "[ $rc -eq 1 ] && has 'crane push to 127.0.0.1:5999/telflo/telflo/x:1.0.0 failed' && grep -qE '^push [^ ]+/work/layout 127\.0\.0\.1:5999/telflo/telflo/x:1\.0\.0 \$' '$logs/crane-calls.log' && [ ! -e '$tmp/work/layout' ]"

# A tag already there: the same digest is skipped; another digest is refused, never overwritten.
# shellcheck disable=SC2016 # expanded by the inner shell
decide() { "$shell" -c '. "$1"; shift; telflo_digest_decision "$@"' _ "$root/scripts/release/oci.sh" "$@"; }
check "telflo_digest_decision: absent (3) push; the same digest skip; another digest refuse; can't tell refuse" \
  "[ \"\$(decide 3 '' '$A')\" = push ] && [ \"\$(decide 0 '$A' '$A')\" = skip ] && [ \"\$(decide 0 '$B' '$A')\" = refuse ] && [ \"\$(decide 1 '' '$A')\" = refuse ]"
copy "$good" "$A" present "$A"
check "the copy, the tag holding the archive's own digest: skipped (exit 0), nothing pushed" \
  "[ $rc -eq 0 ] && has 'skipped (the same bytes)' && ! grep -q '^push ' '$logs/crane-calls.log' && [ ! -e '$tmp/work/layout' ]"
copy "$good" "$A" present "$B"
check "the copy, the same tag holding another digest: refused (exit 1), nothing unpacked or pushed (a published tag is never overwritten)" \
  "[ $rc -eq 1 ] && has \"holds $B, not the archive's $A: refused, nothing pushed\" && ! grep -q '^push ' '$logs/crane-calls.log' && [ ! -e '$tmp/work/layout' ]"

# --- 4. which crane: CI=true takes only the repository's .tools/ ----------------------------------
fake="$tmp/fake"; mkdir -p "$fake/scripts/release" "$fake/.tools/crane" "$tmp/outside"
cp "$root/scripts/release/tools.sh" "$root/scripts/release/tools.lock" "$fake/scripts/release/"
printf '#!/bin/sh\nexit 0\n' >"$fake/.tools/crane/crane"; chmod +x "$fake/.tools/crane/crane"
# The copy's lock names that stand-in's sha256 as crane's binary (tools.sh path checks it).
fake_sum="$({ shasum -a 256 "$fake/.tools/crane/crane" 2>/dev/null || sha256sum "$fake/.tools/crane/crane"; } | awk '{ print $1 }')"
awk -v s="$fake_sum" '$1 == "tool" && $2 == "crane" { $9 = s } { print }' "$root/scripts/release/tools.lock" >"$fake/scripts/release/tools.lock"
cp "$fake/.tools/crane/crane" "$tmp/outside/crane"
ln -s "$tmp/outside/crane" "$fake/.tools/crane/link"
find_crane() { # <env assignments…>
  out="$(env "$@" PATH="$tmp/outside:$PATH" TELFLO_OCI_PREFIX=t TELFLO_OCI_TMP="$tmp/work" \
    "$shell" -c '. "$1"; telflo_crane_find "$2" && echo "crane: $TELFLO_CRANE"' _ "$root/scripts/release/oci.sh" "$fake" 2>&1)"; rc=$?
}
find_crane CI=true
check "CI=true: no checked crane in .tools/: PATH's refused" "[ $rc -ne 0 ] && has 'CI: no checked crane in .tools/'"
# A crane tools.sh checks: placed where tools.lock's version says, with the
# .checked sum tools.sh compares (crane is a member of its tarball).
crane_version="$(awk '$1 == "tool" && $2 == "crane" { print $3; exit }' "$fake/scripts/release/tools.lock")"
if [ -n "$crane_version" ]; then
  mkdir -p "$fake/.tools/crane/$crane_version"
  cp "$fake/.tools/crane/crane" "$fake/.tools/crane/$crane_version/crane"
  ( cd "$fake/.tools/crane/$crane_version" && { shasum -a 256 crane 2>/dev/null || sha256sum crane; } | awk '{ printf "%s", $1 }' >.checked )
  checked="$fake/.tools/crane/$crane_version/crane"
  find_crane CI=true
  check "CI=true: tools.sh's checked crane is the one used" "[ $rc -eq 0 ] && has 'crane: $checked'"
  find_crane CI=true TELFLO_CRANE="$checked"
  check "CI=true: a TELFLO_CRANE that is tools.sh's checked crane accepted" "[ $rc -eq 0 ] && has 'crane: $checked'"
  find_crane CI=true TELFLO_CRANE="$tmp/outside/crane"
  check "CI=true: a TELFLO_CRANE outside .tools/ refused" "[ $rc -ne 0 ] && has \"must be tools.sh's checked crane\""
  find_crane CI=true TELFLO_CRANE="$fake/.tools/crane/crane"
  check "CI=true: an unchecked TELFLO_CRANE inside .tools/ refused" "[ $rc -ne 0 ] && has \"must be tools.sh's checked crane\""
  find_crane CI=true TELFLO_CRANE="$fake/.tools/crane/link"
  check "CI=true: a symlink in .tools/ to a crane outside it refused" "[ $rc -ne 0 ] && has \"must be tools.sh's checked crane\""
  find_crane CI=1
  check "CI=1 counts as a workflow (the checked crane only)" "[ $rc -eq 0 ] && has 'crane: $checked'"
  find_crane CI=true TELFLO_TOOLS_DIR="$tmp/outside"
  check "CI=true: TELFLO_TOOLS_DIR ignored (the repository's own .tools/)" "[ $rc -eq 0 ] && has 'crane: $checked'"
  mv "$fake/.tools" "$tmp/real-tools" && ln -s "$tmp/real-tools" "$fake/.tools"
  find_crane CI=true
  check "CI=true: a .tools that is itself a link refused" "[ $rc -ne 0 ] && has 'is a link'"
  rm "$fake/.tools" && mv "$tmp/real-tools" "$fake/.tools"
  rm -rf "$fake/.tools/crane/$crane_version"   # the cases below expect no checked crane
else
  check "tools.lock names crane's version" "false"
fi
find_crane CI=false
check "outside CI: PATH's crane is used" "[ $rc -eq 0 ] && has 'crane: $tmp/outside/crane'"
find_crane TELFLO_CRANE="$tmp/outside/crane"
check "outside CI: a TELFLO_CRANE anywhere is used (the tests' wrappers)" "[ $rc -eq 0 ] && has 'crane: $tmp/outside/crane'"

# --- 5. the engine's image store, and the registries --------------------------------------------
mkdir -p "$tmp/store"
printf '#!/bin/sh\n[ "$1" = info ] && { echo "$STORE_ANSWER"; exit 0; }\nexit 97\n' >"$tmp/store/docker"; chmod +x "$tmp/store/docker"
store() { out="$(env PATH="$tmp/store:$PATH" STORE_ANSWER="$1" "$shell" -c '. "$1"; telflo_engine_store' _ "$root/scripts/release/oci.sh")"; }
store '[["driver-type","io.containerd.snapshotter.v1"]]'
check "containerd's image store detected from docker info's driver status" "[ \"\$out\" = containerd ]"
store '[["Backing Filesystem","extfs"],["Supports d_type","true"]]'
check "the classic store otherwise" "[ \"\$out\" = classic ]"
ok_list="ghcr.io 127.0.0.1:5000 localhost:65535"
bad_list="docker.io ghcr.io:443 ghcr.io/telflo/platform 127.0.0.2:5000 127.0.0.1:0 127.0.0.1:65536 localhost 10.0.0.1:5000"
reg_ok=true
for r in $ok_list; do "$shell" -c '. "$1"; telflo_registry_ok "$2"' _ "$root/scripts/release/oci.sh" "$r" || reg_ok=false; done
for r in $bad_list; do ! "$shell" -c '. "$1"; telflo_registry_ok "$2"' _ "$root/scripts/release/oci.sh" "$r" || reg_ok=false; done
check "registries: ghcr.io and loopback 127.0.0.1/localhost ports only" "$reg_ok"
check "loopback: not ghcr.io" "! \"\$shell\" -c '. \"\$1\"; telflo_registry_loopback ghcr.io' _ '$root/scripts/release/oci.sh' && \"\$shell\" -c '. \"\$1\"; telflo_registry_loopback 127.0.0.1:5000' _ '$root/scripts/release/oci.sh'"

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILURE(S)"; exit 1; fi
