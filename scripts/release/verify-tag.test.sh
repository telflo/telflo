#!/bin/bash
# Tests for scripts/release/verify-tag.sh, offline but for the cases against a
# throwaway registry:2 on 127.0.0.1 (tools.lock's image, local by digest;
# test-registry.sh; SKIP lines when docker, crane or that image is missing): a
# throwaway git repository (a bare origin, a clone of it holding the script,
# version.sh, oci.sh and a charts/telflo/Chart.yaml) and a stand-in crane
# first on PATH that answers `crane digest` from a list of refs present (a
# digest), denied (DENIED) or absent (MANIFEST_UNKNOWN). Refusing
# credential-helper stand-ins come first on PATH: none may be called.
# Run:  bash scripts/release/verify-tag.test.sh   (bash 3.2 compatible)
set -u
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI GITHUB_OUTPUT
root="$(cd "$(dirname "$0")/../.." && pwd)"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-tag-test.XXXXXX")" || exit 1
cleanup() { tr_registry_stop; rm -rf "$tmp"; }
trap cleanup EXIT
bin="$tmp/bin"; logs="$tmp/logs"
mkdir -p "$bin" "$logs" "$tmp/stub"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/stub/config.json"
for helper in osxkeychain desktop ecr-login; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$logs" >"$bin/docker-credential-$helper"
  chmod +x "$bin/docker-credential-$helper"
done
# The stand-in crane: `digest <ref>` only.
cat >"$bin/crane" <<'CRANE'
#!/bin/bash
printf '%s\n' "$*" >>"$STANDIN_LOG"
if [ -n "${GH_TOKEN+set}" ] || [ -n "${GITHUB_TOKEN+set}" ]; then echo token-in-env >>"$STANDIN_LOG.env"; fi
[ "$1" = digest ] && [ $# -eq 2 ] || { echo "UNEXPECTED $*" >>"$STANDIN_LOG"; exit 97; }
if [ -f "$STANDIN_DIR/present" ] && grep -qxF -- "$2" "$STANDIN_DIR/present"; then
  echo sha256:1111111111111111111111111111111111111111111111111111111111111111; exit 0
fi
if [ -f "$STANDIN_DIR/denied" ] && grep -qxF -- "$2" "$STANDIN_DIR/denied"; then
  echo "Error: GET https://registry.invalid/token: DENIED: requested access to the resource is denied" >&2; exit 1
fi
echo "Error: GET https://registry.invalid/v2/x/manifests/t: MANIFEST_UNKNOWN: manifest unknown; map[Tag:t]" >&2
exit 1
CRANE
chmod +x "$bin/crane"
export STANDIN_LOG="$logs/crane.log" STANDIN_DIR="$tmp/standin"
mkdir -p "$STANDIN_DIR"
export TELFLO_CRANE="$bin/crane"
PATH="$bin:$PATH"; export PATH

g() { git -c user.name=verify-tag-test -c user.email=verify-tag-test@example.invalid -c tag.gpgSign=false -c commit.gpgSign=false \
  -c init.defaultBranch=main -c core.hooksPath=/dev/null "$@"; }
chart() { # <dir> <version> <appVersion>
  mkdir -p "$1/charts/telflo"
  printf 'apiVersion: v2\nname: telflo\nversion: %s\nappVersion: "%s"\n' "$2" "$3" >"$1/charts/telflo/Chart.yaml"
}

# The origin (main: 0.1.0, then 0.2.0 with appVersion 0.1.0, then 0.3.0),
# and a branch off main holding 0.4.0.
src="$tmp/src"
mkdir -p "$src/scripts/release"
cp "$root/scripts/release/verify-tag.sh" "$root/scripts/release/version.sh" "$root/scripts/release/oci.sh" "$root/scripts/release/github-tag.sh" "$src/scripts/release/"
g init -q "$src"
chart "$src" 0.1.0 0.1.0; g -C "$src" add -A; g -C "$src" commit -qm one
c1="$(g -C "$src" rev-parse HEAD)"
chart "$src" 0.2.0 0.1.0; g -C "$src" commit -qam two
c2="$(g -C "$src" rev-parse HEAD)"
chart "$src" 0.3.0 0.3.0; g -C "$src" commit -qam three
c3="$(g -C "$src" rev-parse HEAD)"
g -C "$src" checkout -q -b side
chart "$src" 0.4.0 0.4.0; g -C "$src" commit -qam four
c4="$(g -C "$src" rev-parse HEAD)"
g -C "$src" checkout -q main
g clone -q --bare "$src" "$tmp/origin.git"
repo="$tmp/repo"
g clone -q "$tmp/origin.git" "$repo"
g -C "$repo" fetch -q origin side
g -C "$repo" tag -a v0.1.0 -m "Telflo 0.1.0" "$c1"
g -C "$repo" tag -a v0.2.0 -m "Telflo 0.2.0" "$c2"
g -C "$repo" tag -a v0.3.0 -m "Telflo 0.3.0" "$c3"
g -C "$repo" tag -a v0.4.0 -m "Telflo 0.4.0" "$c4"
g -C "$repo" tag v0.1.1 "$c1"   # lightweight
g -C "$repo" tag -a v0.9.0 -m "Telflo 0.9.0" "$c1"
# A tag object named v0.3.0 placed under another name.
g -C "$repo" update-ref refs/tags/v0.3.1 "$(g -C "$repo" rev-parse refs/tags/v0.3.0)"
script="$repo/scripts/release/verify-tag.sh"

run() { # <args...>: sets rc, out
  rm -f "$STANDIN_LOG"
  out="$(env DOCKER_CONFIG="$tmp/stub" "$shell" "$script" "$@" 2>&1)"; rc=$?
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
asked() { [ -f "$STANDIN_LOG" ] && [ "$(grep -c '' "$STANDIN_LOG")" -gt 0 ]; }

# --- usage ----------------------------------------------------------------------------------
run
check "no tag: usage (exit 2)" "[ $rc -eq 2 ] && has 'the tag is required'"
run v0.1.0 v0.3.0
check "two tags: usage (exit 2)" "[ $rc -eq 2 ] && has 'one tag only'"
run v0.3.0 --bogus
check "an unknown option: usage (exit 2)" "[ $rc -eq 2 ] && has 'unknown option'"
for bad in docker.io ghcr.io/telflo/platform 10.0.0.1:5000 127.0.0.1:0; do
  run v0.3.0 --registry "$bad"
  check "--registry '$bad' refused (exit 2)" "[ $rc -eq 2 ] && has '--registry must be ghcr.io or a loopback registry'"
done
run v0.3.0 --expect abc
check "--expect that isn't a full sha: usage (exit 2)" "[ $rc -eq 2 ] && has '--expect must be a full 40-hex sha'"

# --- 1. the pattern -------------------------------------------------------------------------
for bad in 0.3.0 v0.3.0-rc.1 v0.3.0+1 v03.0.0 v0.3 vv0.3.0 V0.3.0 "v0.3.0 " "" "v0.3.0
x"; do
  run "$bad"
  check "the tag '$(printf '%s' "$bad" | tr '\n' '|')' isn't v<x.y.z>: refused (exit 1), not printed, no registry asked" \
    "[ $rc -eq 1 ] && has \"the tag isn't v<x.y.z>\" && ! asked"
done
run "v9.9.9-\$(echo EXPANDED)"
check "a tag holding a command substitution: refused by the pattern, nothing expanded" "[ $rc -eq 1 ] && ! has EXPANDED"

# --- 2.-6. the repository -------------------------------------------------------------------
run v0.1.1
check "a lightweight tag: refused with the git tag -a hint (exit 1), no registry asked" \
  "[ $rc -eq 1 ] && has 'v0.1.1 is a lightweight tag' && has 'git tag -a v0.1.1 -m \"telflo 0.1.1\" on main' && ! asked"
run v0.5.0
check "a tag that doesn't exist: refused (exit 1)" "[ $rc -eq 1 ] && has 'there is no tag v0.5.0'"
run v0.3.1
check "a tag object under another name: refused (exit 1)" "[ $rc -eq 1 ] && has \"the tag object under refs/tags/v0.3.1 isn't named v0.3.1\""
run v0.9.0
check "the wrong version (Chart.yaml 0.1.0 at the tag v0.9.0): refused naming both (exit 1), no registry asked" \
  "[ $rc -eq 1 ] && has \"has version '0.1.0' and appVersion '0.1.0': both must be 0.9.0\" && ! asked"
run v0.2.0
check "version 0.2.0 but appVersion 0.1.0: refused (exit 1)" "[ $rc -eq 1 ] && has \"has version '0.2.0' and appVersion '0.1.0': both must be 0.2.0\""
run v0.4.0
check "a commit off main: refused (exit 1), no registry asked" "[ $rc -eq 1 ] && has \"v0.4.0's commit $c4 isn't on main\" && ! asked"
run v0.3.0 --expect "$c1"
check "--expect another sha: refused, the tag was moved (exit 1)" "[ $rc -eq 1 ] && has 'was it moved?'"
shallow="$tmp/shallow"
g clone -q --depth 1 "file://$tmp/origin.git" "$shallow"
g -C "$shallow" tag -a v0.3.0 -m "Telflo 0.3.0" HEAD
mkdir -p "$shallow/scripts/release"
cp "$repo/scripts/release/"*.sh "$shallow/scripts/release/" 2>/dev/null
rm -f "$STANDIN_LOG"
out="$(env DOCKER_CONFIG="$tmp/stub" "$shell" "$shallow/scripts/release/verify-tag.sh" v0.3.0 2>&1)"; rc=$?
check "a shallow clone: refused, the ancestry check needs the full history (exit 1)" "[ $rc -eq 1 ] && has 'shallow clone'"

# --- 7. nothing published -------------------------------------------------------------------
: >"$STANDIN_DIR/present"; : >"$STANDIN_DIR/denied"
out_file="$tmp/github-output"
: >"$out_file"
rm -f "$STANDIN_LOG"
out="$(env DOCKER_CONFIG="$tmp/stub" GITHUB_OUTPUT="$out_file" "$shell" "$script" v0.3.0 --expect "$c3" 2>&1)"; rc=$?
check "a good annotated tag on main, nothing published: exit 0" "[ $rc -eq 0 ] && has 'v0.3.0 passed'"
check "it prints, and writes to GITHUB_OUTPUT, the tag, the version and the commit" \
  "has 'version=0.3.0' && has 'commit=$c3' && [ \"\$(cat '$out_file')\" = \"\$(printf 'tag=v0.3.0\nversion=0.3.0\ncommit=$c3')\" ]"
# shellcheck disable=SC2034 # read by check's eval
expected_asks="$(for ns in telflo telflo-staging; do
  for i in api web otelcol-validator otelcol-testing ottl-evaluator; do echo "digest ghcr.io/telflo/$ns/$i:0.3.0"; done
  echo "digest ghcr.io/telflo/$ns/charts/telflo:0.3.0"
done)"
check "the five images and the chart asked on ghcr.io/telflo/telflo (public), then on ghcr.io/telflo/telflo-staging (a stage), nothing else" "[ \"\$(cat '$STANDIN_LOG')\" = \"\$expected_asks\" ]"
run v0.3.0 --expect "$(g -C "$repo" rev-parse refs/tags/v0.3.0)"
check "--expect the tag object's sha: exit 0" "[ $rc -eq 0 ]"
run v0.3.0 --registry 127.0.0.1:5999
check "--registry 127.0.0.1:<port>: both namespaces asked there, exit 0" \
  "[ $rc -eq 0 ] && grep -qx 'digest 127.0.0.1:5999/telflo/telflo/api:0.3.0' '$STANDIN_LOG' && grep -qx 'digest 127.0.0.1:5999/telflo/telflo-staging/api:0.3.0' '$STANDIN_LOG' && ! grep -q ghcr.io '$STANDIN_LOG'"
run v0.3.0 --namespace telflo-staging
check "no --namespace: both namespaces are always asked (usage, exit 2)" "[ $rc -eq 2 ] && has 'unknown option'"

echo "ghcr.io/telflo/telflo/otelcol-testing:0.3.0" >"$STANDIN_DIR/present"
run v0.3.0
check "one image published already: refused naming it (exit 1)" \
  "[ $rc -eq 1 ] && has 'ghcr.io/telflo/telflo/otelcol-testing:0.3.0 is published already' && has 'nothing builds'"
echo "ghcr.io/telflo/telflo/charts/telflo:0.3.0" >"$STANDIN_DIR/present"
run v0.3.0
check "the chart published already: refused naming it (exit 1)" \
  "[ $rc -eq 1 ] && has 'ghcr.io/telflo/telflo/charts/telflo:0.3.0 is published already'"
echo "ghcr.io/telflo/telflo-staging/api:0.3.0" >"$STANDIN_DIR/present"
run v0.3.0
check "one image staged already (a stage of the version open): refused naming it, abandon-stage named (exit 1)" \
  "[ $rc -eq 1 ] && has 'ghcr.io/telflo/telflo-staging/api:0.3.0 is staged already' && has 'abandon it first (scripts/release/steps.sh abandon-stage --version 0.3.0)' && has 'published or staged' && ! has 'is published already'"
printf '%s\n' ghcr.io/telflo/telflo-staging/charts/telflo:0.3.0 ghcr.io/telflo/telflo/charts/telflo:0.3.0 >"$STANDIN_DIR/present"
run v0.3.0
check "the chart both staged and published: each named (exit 1), every ref still asked" \
  "[ $rc -eq 1 ] && has 'ghcr.io/telflo/telflo-staging/charts/telflo:0.3.0 is staged already' && has 'ghcr.io/telflo/telflo/charts/telflo:0.3.0 is published already' && has '2 of the version' && [ \$(grep -c '^digest ' '$STANDIN_LOG') -eq 12 ]"
: >"$STANDIN_DIR/present"
echo "ghcr.io/telflo/telflo/web:0.3.0" >"$STANDIN_DIR/denied"
run v0.3.0
check "a registry that can't tell (DENIED): refused (exit 1), every ref still asked" \
  "[ $rc -eq 1 ] && has \"can't tell whether ghcr.io/telflo/telflo/web:0.3.0 exists\" && [ \$(grep -c '^digest ' '$STANDIN_LOG') -eq 12 ]"
echo "ghcr.io/telflo/telflo-staging/ottl-evaluator:0.3.0" >"$STANDIN_DIR/denied"
run v0.3.0
check "a stage that can't be told (DENIED: a private package read without its login): refused (exit 1)" \
  "[ $rc -eq 1 ] && has \"can't tell whether ghcr.io/telflo/telflo-staging/ottl-evaluator:0.3.0 exists\""
: >"$STANDIN_DIR/denied"

# --- 3. in a workflow: the tag lightweight in the checkout, asked of GitHub's API -----------
# A clone holding v0.3.0 as a lightweight tag (as actions/checkout may store
# it), tools.sh's checked crane in its .tools/ (oci.sh's rule in a workflow),
# and a stand-in gh first on PATH serving fixture JSON (no network). The token
# is made here, and only its presence is ever checked (boolean canaries).
ci_repo="$tmp/ci-repo"
g clone -q "$tmp/origin.git" "$ci_repo"
g -C "$ci_repo" tag v0.3.0 "$c3"   # lightweight here
cp "$root/scripts/release/tools.sh" "$ci_repo/scripts/release/"
mkdir -p "$ci_repo/.tools/crane/v0.22.1"
cp "$bin/crane" "$ci_repo/.tools/crane/v0.22.1/crane"
chmod 755 "$ci_repo/.tools/crane/v0.22.1/crane"
if command -v sha256sum >/dev/null 2>&1; then sum_of() { sha256sum "$1" | awk '{ print $1 }'; }; else sum_of() { shasum -a 256 "$1" | awk '{ print $1 }'; }; fi
sum_of "$ci_repo/.tools/crane/v0.22.1/crane" >"$ci_repo/.tools/crane/v0.22.1/.checked"
# In a workflow tools.sh takes no TELFLO_TOOLS_* setting: the lock names this
# machine's own platform (tools.sh's rule) and the stand-in's sha256.
case "$(uname -s)" in Darwin) ci_os=darwin ;; Linux) ci_os=linux ;; *) ci_os=unknown ;; esac
case "$(uname -m)" in arm64|aarch64) ci_arch=arm64 ;; x86_64|amd64) ci_arch=amd64 ;; *) ci_arch=unknown ;; esac
printf 'tool crane v0.22.1 %s https://tools.invalid/crane.tar.gz %s checksums.txt crane %s\n' "$ci_os-$ci_arch" \
  "0000000000000000000000000000000000000000000000000000000000000000" "$(sum_of "$ci_repo/.tools/crane/v0.22.1/crane")" \
  >"$ci_repo/scripts/release/tools.lock"
ci_script="$ci_repo/scripts/release/verify-tag.sh"
tag_sha="abcdef0123456789abcdef0123456789abcdef01"
token="ghs_test$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
gh_dir="$tmp/gh-standin"
mkdir -p "$gh_dir"
export GH_LOG="$logs/gh.log" GH_DIR="$gh_dir"
cat >"$bin/gh" <<'GH'
#!/bin/bash
# The stand-in gh: `api --hostname github.com -H <accept> <path>` only. It logs
# its argv, and whether GH_TOKEN was set (never its value).
printf '%s\n' "$*" >>"$GH_LOG"
if [ -n "${GH_TOKEN:-}" ]; then echo token-present >>"$GH_LOG.env"; fi
[ "$1 $2 $3" = "api --hostname github.com" ] || { echo "UNEXPECTED $*" >>"$GH_LOG"; exit 97; }
[ ! -f "$GH_DIR/fail" ] || { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
path="${!#}"
case "$path" in
  repos/*/git/ref/tags/*) cat "$GH_DIR/ref.json" ;;
  repos/*/git/tags/*) cat "$GH_DIR/tag.json" ;;
  *) echo "UNEXPECTED path $path" >>"$GH_LOG"; exit 97 ;;
esac
GH
chmod +x "$bin/gh"
gh_ref() { # <object type>
  printf '{"ref":"refs/tags/v0.3.0","node_id":"x","url":"https://api.github.invalid/x","object":{"sha":"%s","type":"%s","url":"https://api.github.invalid/y"}}\n' \
    "$tag_sha" "$1" >"$gh_dir/ref.json"
}
gh_tag() { # <name> <object type> <object sha>
  printf '{"sha":"%s","tag":"%s","message":"Telflo 0.3.0\\n","object":{"sha":"%s","type":"%s"}}\n' \
    "$tag_sha" "$1" "$3" "$2" >"$gh_dir/tag.json"
}
good_api() { rm -f "$gh_dir/fail"; gh_ref tag; gh_tag v0.3.0 commit "$c3"; }
run_ci() { # [VAR=value ...] -- <args...>: CI=true, the token, telflo/telflo, unless overridden
  local vars=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  shift
  rm -f "$GH_LOG" "$GH_LOG.env" "$STANDIN_LOG" "$STANDIN_LOG.env"
  out="$(env -u TELFLO_CRANE DOCKER_CONFIG="$tmp/stub" CI=true GITHUB_REPOSITORY=telflo/telflo \
    GH_TOKEN="$token" ${vars[@]+"${vars[@]}"} "$shell" "$ci_script" "$@" 2>&1)"; rc=$?
}
gh_calls() { if [ -f "$GH_LOG" ]; then grep -c '' "$GH_LOG"; else echo 0; fi; }

good_api
run_ci -- v0.3.0 --expect "$c3"
check "CI: lightweight in the checkout, annotated on GitHub (the API's tag object tags the commit): exit 0" \
  "[ $rc -eq 0 ] && has 'on GitHub it is the annotated tag $tag_sha of $c3' && has 'commit=$c3' && has 'v0.3.0 passed'"
check "CI: the API asked for the ref, then the tag object, at github.com, with the token in the environment" \
  "[ \"\$(sed -n 1p '$GH_LOG')\" = 'api --hostname github.com -H Accept: application/vnd.github+json repos/telflo/telflo/git/ref/tags/v0.3.0' ] \
   && [ \"\$(sed -n 2p '$GH_LOG')\" = 'api --hostname github.com -H Accept: application/vnd.github+json repos/telflo/telflo/git/tags/$tag_sha' ] \
   && [ \$(gh_calls) -eq 2 ] && [ \"\$(sort -u '$GH_LOG.env')\" = token-present ]"
check "CI: the token is in neither gh's argv nor the output (canary, boolean)" \
  "! grep -qF -- '$token' '$GH_LOG' && ! has '$token'"
check "CI: then the registry asked as on any run (the checked crane of .tools/)" "[ \$(grep -c '^digest ' '$STANDIN_LOG') -eq 12 ]"
check "CI: the token unset before crane ran (no GH_TOKEN or GITHUB_TOKEN in its environment)" "[ ! -e '$STANDIN_LOG.env' ]"
run_ci -- v0.3.0 --expect "$tag_sha"
check "CI: --expect the API's tag object sha: exit 0" "[ $rc -eq 0 ]"

gh_ref commit
run_ci -- v0.3.0
check "CI: the ref on GitHub isn't a tag object (lightweight there too): refused with the git tag -a hint (exit 1)" \
  "[ $rc -eq 1 ] && has 'v0.3.0 is a lightweight tag on GitHub too' && has 'git tag -a v0.3.0 -m \"telflo 0.3.0\" on main' && [ \$(gh_calls) -eq 1 ] && ! asked"
good_api; gh_tag v0.3.0 commit "$c1"
run_ci -- v0.3.0
check "CI: the tag object on GitHub tags another commit: refused (exit 1), no registry asked" \
  "[ $rc -eq 1 ] && has \"v0.3.0 on GitHub tags another commit than this checkout's $c3\" && ! asked"
good_api; gh_tag v0.3.1 commit "$c3"
run_ci -- v0.3.0
check "CI: the tag object on GitHub is named otherwise: refused (exit 1)" "[ $rc -eq 1 ] && has \"on GitHub isn't named v0.3.0\""
good_api; gh_tag v0.3.0 tree "$c3"
run_ci -- v0.3.0
check "CI: the tag object on GitHub tags a tree: refused (exit 1)" "[ $rc -eq 1 ] && has \"v0.3.0 on GitHub doesn't tag a commit\""
good_api; echo '[{"ref":"refs/tags/v0.3.0"}]' >"$gh_dir/ref.json"
run_ci -- v0.3.0
check "CI: an answer of another shape (a list): refused (exit 1)" "[ $rc -eq 1 ] && has 'in an unexpected shape'"
good_api; echo 'not json' >"$gh_dir/tag.json"
run_ci -- v0.3.0
check "CI: a tag object reply that isn't JSON: refused (exit 1)" "[ $rc -eq 1 ] && has \"answered v0.3.0's tag object in an unexpected shape\""
good_api; : >"$gh_dir/fail"
run_ci -- v0.3.0
check "CI: the API fails: refused (exit 1), nothing of gh's error printed" \
  "[ $rc -eq 1 ] && has \"GitHub's API didn't answer for refs/tags/v0.3.0\" && ! has 'Bad Gateway' && ! asked"
good_api
run_ci GH_TOKEN= -- v0.3.0
check "CI: no token: refused (exit 1), the API not asked" "[ $rc -eq 1 ] && has \"GH_TOKEN isn't set\" && [ \$(gh_calls) -eq 0 ]"
for bad in "" telflo telflo/telflo/x ../telflo telflo/.. telflo/. "telflo/te lflo" -telflo/telflo "telflo/\$(echo EXPANDED)" "telflo/telflo
x"; do
  run_ci GITHUB_REPOSITORY="$bad" -- v0.3.0
  check "CI: GITHUB_REPOSITORY '$(printf '%s' "$bad" | tr '\n' '|')': refused (exit 1), the API not asked, nothing expanded" \
    "[ $rc -eq 1 ] && has \"GITHUB_REPOSITORY isn't owner/name\" && [ \$(gh_calls) -eq 0 ] && ! has EXPANDED"
done
for other in telflo/other telflo-platform/telflo Telflo/telflo; do
  run_ci GITHUB_REPOSITORY="$other" -- v0.3.0
  check "CI: GITHUB_REPOSITORY '$other' (owner/name, but not telflo/telflo): refused (exit 1), the API not asked" \
    "[ $rc -eq 1 ] && has \"GITHUB_REPOSITORY isn't telflo/telflo\" && [ \$(gh_calls) -eq 0 ]"
done
run_ci TELFLO_TOOLS_PLATFORM=test-plat -- v0.3.0 --expect "$c3"
check "CI: a TELFLO_TOOLS_PLATFORM setting: tools.sh refuses it, so no checked crane: refused (exit 1)" \
  "[ $rc -eq 1 ] && has 'no crane' && ! asked"
for ci in "" false 0; do
  rm -f "$GH_LOG"
  out="$(env -u TELFLO_CRANE DOCKER_CONFIG="$tmp/stub" CI="$ci" GITHUB_REPOSITORY=telflo/telflo GH_TOKEN="$token" "$shell" "$ci_script" v0.3.0 2>&1)"; rc=$?
  check "outside a workflow (CI='$ci'): a lightweight tag refused as before (exit 1), the API never asked" \
    "[ $rc -eq 1 ] && has 'v0.3.0 is a lightweight tag: a release is an annotated tag' && [ \$(gh_calls) -eq 0 ]"
done
check "CI: no run printed the token (canary, boolean)" "! grep -rqF -- '$token' '$logs'"

# --- 7, against a throwaway registry: the real crane, both namespaces --------------------------
real_docker="$(command -v docker 2>/dev/null || true)"
TR_DOCKER="${real_docker:-docker}"
TR_DOCKER_CONFIG="$tmp/stub"
real_crane="$("$shell" "$root/scripts/release/tools.sh" path crane 2>/dev/null || true)"
reg_ok=false
if [ -n "$real_crane" ] && tr_tools "$root"; then
  if tr_registry_start "$tmp/registry"; then reg_ok=true; else TR_SKIP="the throwaway registry didn't start"; fi
fi
if $reg_ok; then
  REG="$TR_REGISTRY"
  rrun() { # <args...>: the real crane, the registry's login
    out="$(env TELFLO_CRANE="$real_crane" DOCKER_CONFIG="$TR_CONFIG" "$shell" "$script" "$@" 2>&1)"; rc=$?
  }
  rrun v0.3.0 --registry "$REG" --expect "$c3"
  check "a registry holding nothing of the version (real crane): exit 0" "[ $rc -eq 0 ] && has 'nothing of 0.3.0 published or staged on $REG'"
  tr_fixture "$tmp/staged.oci.tar" 0.3.0 "$c3" STAGED >/dev/null
  tr_put "$tmp/staged.oci.tar" "$REG/telflo/telflo-staging/web:0.3.0" "$real_crane" "$TR_CONFIG"
  rrun v0.3.0 --registry "$REG"
  check "a stage of the version in the registry (real crane): refused, staged already (exit 1)" \
    "[ $rc -eq 1 ] && has '$REG/telflo/telflo-staging/web:0.3.0 is staged already' && has 'abandon-stage --version 0.3.0'"
  tr_put "$tmp/staged.oci.tar" "$REG/telflo/telflo/web:0.3.0" "$real_crane" "$TR_CONFIG"
  rrun v0.3.0 --registry "$REG"
  check "the version public too (real crane): refused, spent (exit 1)" \
    "[ $rc -eq 1 ] && has '$REG/telflo/telflo/web:0.3.0 is published already' && has 'version 0.3.0 is spent'"
  if [ "$TR_AUTH" = 1 ]; then
    out="$(env TELFLO_CRANE="$real_crane" DOCKER_CONFIG="$tmp/stub" "$shell" "$script" v0.3.0 --registry "$REG" 2>&1)"; rc=$?
    check "no login (UNAUTHORIZED, as a private stage answers an anonymous read): can't tell, refused (exit 1)" \
      "[ $rc -eq 1 ] && has \"can't tell whether $REG/telflo/telflo-staging/api:0.3.0 exists\" && has 'UNAUTHORIZED'"
  else
    skip "the login case" "no htpasswd: the throwaway registry has no login"
  fi
else
  skip "verify-tag against a throwaway registry" "${TR_SKIP:-no crane (scripts/release/tools.sh fetch crane)}"
fi
tr_registry_stop

check "no credential helper was called" "[ ! -s '$logs/helper.log' ]"

echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
