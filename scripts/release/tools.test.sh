#!/usr/bin/env bash
# tools.sh's self-test, offline: a fixture lock whose downloads are local
# files (file:// URLs), a fixture platform, a `curl` wrapper that records each
# call before handing it to the real curl, and a `docker` stand-in that
# records its argv and DOCKER_CONFIG. Cases:
#   - a download whose sha256 matches the lock is accepted and made
#     executable; a wrong one is refused, exit 1, and the download removed;
#   - from an archive, only the lock's member is taken, and only when its
#     own sha256 is the lock's binary sha256 (a mismatch is refused, exit 1,
#     nothing installed);
#   - a checked file is never overwritten (a second fetch keeps it; a
#     tampered one is refused by `path` and by `fetch`); a binary swapped
#     together with its .checked record is refused by `path` (the lock's
#     binary sha256);
#   - with CI set (not ""/false/0), TELFLO_TOOLS_DIR, TELFLO_TOOLS_LOCK and
#     TELFLO_TOOLS_PLATFORM are each refused (exit 2, nothing read or made);
#   - `path` never downloads (no curl call, no .tools/ made);
#   - `docker-config` writes only into its folder (the stub config and the
#     checked buildx) and refuses a folder that isn't empty, a relative path
#     and ~/.docker;
#   - `pull` refuses an image not in the lock, a reference and a lock entry
#     without a digest (docker never called), and pulls by digest only, with
#     DOCKER_CONFIG .tools/'s stub;
#   - `remove` removes the `remove` images by digest, keeps the `keep` ones,
#     and removes .tools/.
# The deliberate breaks (run with TOOLS_SH=<copy>): the download's sha256
# comparison removed must fail the wrong-sum case and the download-sum-alone
# case (an archive's download wrong, its member the lock's binary: only that
# comparison refuses it); the binary's sha256 check in `path` removed must
# fail the swapped-binary case.
#
# Run: bash scripts/release/tools.test.sh   (TOOLS_SH=<path> tests another copy)
# bash 3.2 compatible; PASS/FAIL lines; exit 1 when any failed.
set -u
# Not a workflow: the cases set CI themselves where they need it.
unset CI
# Hermetic: a caller's tools folder or git setting never changes what these cases test.
unset TELFLO_TOOLS_DIR TELFLO_TOOLS_LOCK TELFLO_TOOLS_PLATFORM GIT_NO_REPLACE_OBJECTS

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOLS_SH="${TOOLS_SH:-$SCRIPT_DIR/tools.sh}"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/tools-test.XXXXXX")" || exit 2
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
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi; }

# --- the fixture releases and lock -----------------------------------------------
src="$tmp/src"
mkdir -p "$src/archive" "$tmp/bin" "$tmp/home"
head -c 4096 /dev/urandom >"$src/tool-a"
head -c 4096 /dev/urandom >"$src/fake-buildx"
printf '#!/bin/sh\necho member\n' >"$src/archive/crane"
printf 'not wanted\n' >"$src/archive/LICENSE"
tar -czf "$src/archive.tar.gz" -C "$src/archive" crane LICENSE
wrong=$(printf '%064d' 0)
digest_a="sha256:$(printf 'a%.0s' $(seq 1 64))"
digest_k="sha256:$(printf 'b%.0s' $(seq 1 64))"
cat >"$tmp/tools.lock" <<EOF
# a fixture lock
tool good v1.0.0 test-plat file://$src/tool-a $(sha "$src/tool-a") tool-a.sha256sum - -
tool wrong v1.0.0 test-plat file://$src/tool-a $wrong checksums.txt - -
tool arch v2.0.0 test-plat file://$src/archive.tar.gz $(sha "$src/archive.tar.gz") checksums.txt crane $(sha "$src/archive/crane")
tool archbin v2.0.0 test-plat file://$src/archive.tar.gz $(sha "$src/archive.tar.gz") checksums.txt crane $wrong
tool archdl v2.0.0 test-plat file://$src/archive.tar.gz $wrong checksums.txt crane $(sha "$src/archive/crane")
tool buildx v0.38.1 test-plat file://$src/fake-buildx $(sha "$src/fake-buildx") checksums-signed.txt - -
tool elsewhere v1.0.0 other-plat file://$src/tool-a $(sha "$src/tool-a") checksums.txt - -
tool short v1.0.0 test-plat file://$src/tool-a $(sha "$src/tool-a") checksums.txt -
image pinned example/pinned 1.0 $digest_a remove
image kept example/kept 2.0 $digest_k keep
image nodigest example/nodigest 3.0 remove
builder test-builder
EOF

# A curl wrapper (records, then runs the real curl) and a docker stand-in
# (records argv and DOCKER_CONFIG; `image inspect <ref>` answers from marker
# files, `pull` makes one, `rmi` removes it; other inspects: absent).
real_curl=$(command -v curl)
cat >"$tmp/bin/curl" <<EOF
#!/bin/sh
echo "curl \$*" >>"$tmp/curl.log"
exec "$real_curl" "\$@"
EOF
cat >"$tmp/bin/docker" <<EOF
#!/bin/sh
echo "docker \$* | DOCKER_CONFIG=\${DOCKER_CONFIG:-}" >>"$tmp/docker.log"
marker() { printf '%s' "\$1" | tr -c 'A-Za-z0-9' _; }
case "\$1 \$2" in
  "image inspect")
    shift 2
    [ "\$1" = --format ] && shift 2
    [ -e "$tmp/images/\$(marker "\$1")" ] || exit 1
    echo "sha256:feedfeed"; exit 0 ;;
  "container inspect"|"volume inspect") exit 1 ;;
esac
case "\$1" in
  pull) mkdir -p "$tmp/images" && : >"$tmp/images/\$(marker "\$2")"; exit 0 ;;
  rmi) rm -f "$tmp/images/\$(marker "\$2")"; exit 0 ;;
esac
exit 1
EOF
chmod 755 "$tmp/bin/curl" "$tmp/bin/docker"

n=0
# fresh: a new case folder ($c) whose .tools/ the commands use.
fresh() { n=$((n + 1)); c="$tmp/case$n"; mkdir -p "$c"; : >"$tmp/curl.log"; : >"$tmp/docker.log"; }
tools() { # <args...>: tools.sh in the case folder; output in $c.out, exit status in $rc
  PATH="$tmp/bin:$PATH" HOME="$tmp/home" TELFLO_TOOLS_DIR="$c/.tools" TELFLO_TOOLS_LOCK="$tmp/tools.lock" \
    TELFLO_TOOLS_PLATFORM=test-plat bash "$TOOLS_SH" "$@" >"$c.out" 2>&1
  rc=$?
}

# --- fetch -------------------------------------------------------------------------
fresh
accepted() {
  tools fetch good
  [ "$rc" = 0 ] && [ -x "$c/.tools/good/v1.0.0/good" ] && cmp -s "$src/tool-a" "$c/.tools/good/v1.0.0/good" &&
    tools path good && [ "$rc" = 0 ] && [ "$(cat "$c.out")" = "$c/.tools/good/v1.0.0/good" ]
}
run_case "a download whose sha256 matches the lock is accepted, executable, and path prints it" accepted
good_case=$c

fresh
refused_wrong_sum() {
  tools fetch wrong
  [ "$rc" = 1 ] && grep -q "sha256 isn't tools.lock's" "$c.out" &&
    [ ! -e "$c/.tools/wrong/v1.0.0" ] && [ -z "$(ls -A "$c/.tools/wrong" 2>/dev/null)" ] &&
    tools path wrong && [ "$rc" = 1 ]
}
run_case "a download with a wrong sha256 is refused (exit 1) and removed" refused_wrong_sum

fresh
archive_member() {
  tools fetch arch
  [ "$rc" = 0 ] && [ -x "$c/.tools/arch/v2.0.0/arch" ] && cmp -s "$src/archive/crane" "$c/.tools/arch/v2.0.0/arch" &&
    [ "$(ls -A "$c/.tools/arch/v2.0.0" | tr '\n' ' ')" = ".checked arch " ] &&
    tools path arch && [ "$rc" = 0 ]
}
run_case "from a checked archive only the lock's member is taken" archive_member
arch_case=$c

fresh
binary_mismatch() {
  tools fetch archbin
  [ "$rc" = 1 ] && grep -q "the binary's sha256 isn't tools.lock's" "$c.out" &&
    [ ! -e "$c/.tools/archbin/v2.0.0" ] && [ -z "$(ls -A "$c/.tools/archbin" 2>/dev/null)" ] &&
    tools path archbin && [ "$rc" = 1 ]
}
run_case "an archive whose member's sha256 isn't the lock's binary sha256: refused (exit 1), nothing installed" binary_mismatch

# The download's own check, alone: the archive's sha256 isn't the lock's while its member
# is exactly the lock's binary (so the binary's check would pass): refused before anything is extracted.
fresh
download_sum_alone() {
  tools fetch archdl
  [ "$rc" = 1 ] && grep -q "the download's sha256 isn't tools.lock's" "$c.out" && ! grep -q "sha256 matches tools.lock" "$c.out" &&
    [ ! -e "$c/.tools/archdl/v2.0.0" ] && [ -z "$(ls -A "$c/.tools/archdl" 2>/dev/null)" ] &&
    tools path archdl && [ "$rc" = 1 ]
}
run_case "an archive whose download sha256 isn't the lock's, its member the lock's binary: refused by the download's check alone (exit 1), nothing extracted or installed" download_sum_alone

c=$arch_case
swapped_binary() {
  # Another binary, with a .checked record of its own sum (what a fetch writes).
  printf '#!/bin/sh\necho other\n' >"$c/.tools/arch/v2.0.0/arch"
  sha "$c/.tools/arch/v2.0.0/arch" >"$c/.tools/arch/v2.0.0/.checked"
  tools path arch
  [ "$rc" = 1 ] && ! grep -q "$c/.tools/arch" "$c.out"
}
run_case "an extracted binary swapped with its .checked record: path refuses it (the lock's binary sha256)" swapped_binary

c=$good_case
never_overwritten() {
  local before after
  before=$(ls -li "$c/.tools/good/v1.0.0/good" | awk '{ print $1 }')
  : >"$tmp/curl.log"
  tools fetch good
  after=$(ls -li "$c/.tools/good/v1.0.0/good" | awk '{ print $1 }')
  [ "$rc" = 0 ] && grep -q 'already fetched' "$c.out" && [ "$before" = "$after" ] && [ ! -s "$tmp/curl.log" ]
}
run_case "a second fetch keeps the checked file (no download)" never_overwritten
tampered() {
  printf 'x' >>"$c/.tools/good/v1.0.0/good"
  tools path good
  [ "$rc" = 1 ] || return 1
  tools fetch good
  [ "$rc" = 1 ] && grep -q 'never overwritten' "$c.out" && ! cmp -s "$src/tool-a" "$c/.tools/good/v1.0.0/good"
}
run_case "a tampered binary is refused by path and never overwritten by fetch" tampered

fresh
path_no_download() {
  tools path good
  [ "$rc" = 1 ] && [ ! -s "$tmp/curl.log" ] && [ ! -e "$c/.tools" ]
}
run_case "path never downloads (no curl call, no .tools/)" path_no_download
other_platform() { tools fetch elsewhere; [ "$rc" = 1 ] && [ ! -s "$tmp/curl.log" ]; }
run_case "a tool the lock pins for another platform only is refused" other_platform
short_line() { tools fetch short; [ "$rc" = 1 ] && grep -qxF "tools.sh: FAIL: tools.lock's line for short (test-plat) hasn't 9 fields" "$c.out" && [ ! -s "$tmp/curl.log" ]; }
run_case "a lock line without 9 fields: refused naming the tool once, and its platform; nothing downloaded" short_line
fetch_all() {
  tools fetch
  # every tool of this platform: the wrong one stops the run with exit 1.
  [ "$rc" = 1 ] && [ -x "$c/.tools/good/v1.0.0/good" ] && grep -q "sha256 isn't tools.lock's" "$c.out"
}
run_case "fetch with no tool fetches in the lock's order and stops at a wrong sum" fetch_all

# --- docker-config -------------------------------------------------------------------
fresh
tools fetch buildx
listing() { (cd "$tmp" && find . | grep -v -e "^\./case$n/dc" -e "^\./case$n\.out\$" | LC_ALL=C sort | cksum); }
docker_config_only_its_folder() {
  local before
  before=$(listing)
  tools docker-config "$c/dc"
  [ "$rc" = 0 ] && [ "$(cat "$c.out")" = "$c/dc" ] &&
    [ "$(cd "$c/dc" && find . | LC_ALL=C sort | tr '\n' ' ')" = ". ./cli-plugins ./cli-plugins/docker-buildx ./config.json " ] &&
    [ "$(cat "$c/dc/config.json")" = '{"auths":{"telflo-agent.invalid":{}}}' ] &&
    cmp -s "$src/fake-buildx" "$c/dc/cli-plugins/docker-buildx" && [ -x "$c/dc/cli-plugins/docker-buildx" ] &&
    [ "$before" = "$(listing)" ]
}
run_case "docker-config writes the stub config and the checked buildx, only into its folder" docker_config_only_its_folder
mkdir -p "$c/full" && : >"$c/full/x"
dc_refused() { tools docker-config "$@"; [ "$rc" = 2 ]; }
run_case "docker-config refuses a folder that isn't empty" dc_refused "$c/full"
run_case "docker-config refuses a relative path" dc_refused relative/dc
run_case "docker-config refuses ~/.docker" dc_refused "$tmp/home/.docker"
run_case "docker-config left ~/.docker alone" test ! -e "$tmp/home/.docker"
fresh
no_buildx() { tools docker-config "$c/dc"; [ "$rc" = 1 ] && [ ! -e "$c/dc" ]; }
run_case "docker-config without a checked buildx fails and writes nothing" no_buildx

# --- pull, ref, remove ----------------------------------------------------------------
fresh
pull_refused() { tools pull "$1"; [ "$rc" = 2 ] && ! grep -q '^docker ' "$tmp/docker.log"; }
run_case "pull refuses an image not in the lock (docker never called)" pull_refused absent
run_case "pull refuses a reference with a tag" pull_refused example/pinned:1.0
run_case "pull refuses a reference with a digest" pull_refused "example/pinned@$digest_a"
run_case "pull refuses a lock entry without a digest" pull_refused nodigest
pull_by_digest() {
  tools pull pinned
  [ "$rc" = 0 ] && grep -qx "docker pull example/pinned@$digest_a | DOCKER_CONFIG=$c/.tools/docker-config" "$tmp/docker.log" &&
    [ "$(grep -c '^docker pull ' "$tmp/docker.log")" = 1 ] &&
    [ "$(cat "$c/.tools/docker-config/config.json")" = '{"auths":{"telflo-agent.invalid":{}}}' ] &&
    grep -q 'image id sha256:feedfeed' "$c.out"
}
run_case "pull pulls by digest only, with .tools/'s stub DOCKER_CONFIG" pull_by_digest
pull_again() { : >"$tmp/docker.log"; tools pull pinned; [ "$rc" = 0 ] && ! grep -q '^docker pull ' "$tmp/docker.log"; }
run_case "pull of a local image pulls nothing" pull_again
ref_prints() { tools ref kept; [ "$rc" = 0 ] && [ "$(cat "$c.out")" = "example/kept@$digest_k" ]; }
run_case "ref prints the pinned reference" ref_prints
mkdir -p "$tmp/images" && : >"$tmp/images/$(printf '%s' "example/kept@$digest_k" | tr -c 'A-Za-z0-9' _)"
removed() {
  : >"$tmp/docker.log"
  tools remove
  # the fixture's entry without a digest is named, and makes the exit 1.
  [ "$rc" = 1 ] && grep -q "nodigest: tools.lock's entry isn't a pinned image" "$c.out" && grep -qx "docker rmi example/pinned@$digest_a | DOCKER_CONFIG=$c/.tools/docker-config" "$tmp/docker.log" &&
    ! grep -q 'rmi example/kept' "$tmp/docker.log" && ! grep -q -- ' -f ' "$tmp/docker.log" &&
    grep -q 'docker container inspect buildx_buildkit_test-builder0' "$tmp/docker.log" && [ ! -e "$c/.tools" ]
}
run_case "remove removes the remove images by digest, keeps the kept, names a bad entry, and removes .tools/" removed

# --- in a workflow ------------------------------------------------------------------------
fresh
ci_refused() { # <CI value> <variable>
  env PATH="$tmp/bin:$PATH" HOME="$tmp/home" CI="$1" "$2=$c/.tools" bash "$TOOLS_SH" path good >"$c.out" 2>&1
  [ "$?" = 2 ] && grep -q "refused: $2 set, and CI is" "$c.out" && [ ! -e "$c/.tools" ] && [ ! -s "$tmp/curl.log" ]
}
for ci in true 1 yes; do
  for v in TELFLO_TOOLS_DIR TELFLO_TOOLS_LOCK TELFLO_TOOLS_PLATFORM; do
    run_case "CI=$ci: $v refused (exit 2), nothing read or made" ci_refused "$ci" "$v"
  done
done
ci_empty_refused() {
  PATH="$tmp/bin:$PATH" HOME="$tmp/home" CI=true TELFLO_TOOLS_PLATFORM= bash "$TOOLS_SH" path good >"$c.out" 2>&1
  [ "$?" = 2 ] && grep -q 'refused: TELFLO_TOOLS_PLATFORM set' "$c.out"
}
run_case "CI=true: TELFLO_TOOLS_PLATFORM set but empty: refused too" ci_empty_refused
not_ci() { # <CI value>: the self-test's settings honored
  : >"$tmp/curl.log"
  PATH="$tmp/bin:$PATH" HOME="$tmp/home" CI="$1" TELFLO_TOOLS_DIR="$c/.tools" TELFLO_TOOLS_LOCK="$tmp/tools.lock" \
    TELFLO_TOOLS_PLATFORM=test-plat bash "$TOOLS_SH" fetch good >"$c.out" 2>&1
  [ "$?" = 0 ] && [ -x "$c/.tools/good/v1.0.0/good" ]
}
run_case "CI='' (not a workflow): the settings honored" not_ci ""
fresh
run_case "CI=false: the settings honored" not_ci false
fresh
run_case "CI=0: the settings honored" not_ci 0

# --- usage -------------------------------------------------------------------------------
fresh
usage_rc() { tools "$@"; [ "$rc" = 2 ]; }
run_case "an unknown command exits 2" usage_rc install kind
run_case "path without a tool exits 2" usage_rc path
not_dot_tools() {
  PATH="$tmp/bin:$PATH" TELFLO_TOOLS_DIR="$c/tools" TELFLO_TOOLS_LOCK="$tmp/tools.lock" TELFLO_TOOLS_PLATFORM=test-plat \
    bash "$TOOLS_SH" remove >/dev/null 2>&1
  [ "$?" = 2 ]
}
run_case "a tools folder not named .tools is refused" not_dot_tools

echo "tools.test.sh: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
