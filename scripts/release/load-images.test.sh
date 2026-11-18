#!/bin/bash
# Tests for scripts/release/load-images.sh. Its refusals run offline. Its
# loads run with the real docker and crane, an OCI archive made offline
# (test-registry.sh's fixture: two tiny images) and the throwaway registry the
# script starts itself (tools.lock's registry image, local by digest), or
# print SKIP lines when docker, crane or that image is missing. Both
# platforms are loaded (--platform linux/amd64 and linux/arm64; the default,
# the engine's own, from a stand-in `docker info`), so the images it loads,
# tagged ghcr.io/telflo/telflo/<name>:9.9.97, are removed here at the end by
# name and then by id (the platform a later case replaced is untagged, not
# gone). Refusing credential-helper stand-ins come first on PATH: none may be
# called.
# Run:  bash scripts/release/load-images.test.sh
# (TELFLO_LOAD_IMAGES_NAME names the script's registry container.) bash 3.2
# compatible.
set -u
# One spelling of the temporary folder (no trailing slash, no //), and no CI:
# the test sets CI itself where a case needs it.
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/release/load-images.sh"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }

V=9.9.97
tmp="$(mktemp -d "${TMPDIR:-/tmp}/load-images-test.XXXXXX")" || exit 1
real_docker="$(command -v docker 2>/dev/null || true)"
TR_DOCKER="${real_docker:-docker}"
loaded=""
loaded_ids=""
cleanup() {
  local ref
  for ref in $loaded $loaded_ids; do DOCKER_CONFIG="$tmp/stub" "$TR_DOCKER" rmi "$ref" >/dev/null 2>&1; done
  rm -rf "$tmp"
}
trap cleanup EXIT
bin="$tmp/bin"; logs="$tmp/logs"
mkdir -p "$bin" "$logs" "$tmp/stub" "$tmp/t"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/stub/config.json"
TR_DOCKER_CONFIG="$tmp/stub"
for helper in osxkeychain desktop ecr-login; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$logs" >"$bin/docker-credential-$helper"
  chmod +x "$bin/docker-credential-$helper"
done
# A docker wrapper: every call recorded and handed to the real docker, but
# with STANDIN_WRONG_ID set, `image inspect --format {{.Id}} ghcr.io/…` answers
# another id (the engine's id differing from the archive's), STANDIN_ID answers
# that id, STANDIN_STORE=containerd answers `docker info`'s driver status as
# containerd's image store, and STANDIN_ARCH answers `docker info`'s
# Architecture (the engine's own platform, load-images.sh's default).
printf '#!/bin/bash\nlog="%s"\nreal="%s"\n' "$logs" "${real_docker:-/nonexistent/docker}" >"$bin/docker"
cat >>"$bin/docker" <<'EOF'
{ printf '%q ' "$@"; echo; } >>"$log/docker-calls.log"
if [ "${1:-}" = info ]; then
  case "$*" in
    *Architecture*) if [ -n "${STANDIN_ARCH:-}" ]; then echo "$STANDIN_ARCH"; exit 0; fi ;;
    *DriverStatus*) if [ -n "${STANDIN_STORE:-}" ]; then
        [ "$STANDIN_STORE" = containerd ] && echo '[["driver-type","io.containerd.snapshotter.v1"]]' || echo '[["Backing Filesystem","extfs"]]'
        exit 0
      fi ;;
  esac
fi
if [ -n "${STANDIN_ID:-}" ] && [ "$1 ${2:-} ${3:-} ${4:-}" = "image inspect --format {{.Id}}" ]; then
  case "${5:-}" in ghcr.io/telflo/telflo/*) echo "$STANDIN_ID"; exit 0 ;; esac
fi
if [ -n "${STANDIN_WRONG_ID:-}" ] && [ "$1 ${2:-} ${3:-} ${4:-}" = "image inspect --format {{.Id}}" ]; then
  case "${5:-}" in ghcr.io/telflo/telflo/*) echo "sha256:4444444444444444444444444444444444444444444444444444444444444444"; exit 0 ;; esac
fi
exec "$real" "$@"
EOF
chmod +x "$bin/docker"
real_crane="$("$shell" "$root/scripts/release/tools.sh" path crane 2>/dev/null || command -v crane 2>/dev/null || true)"
tr_crane_wrapper "$bin" "$logs" "${real_crane:-/nonexistent/crane}"
PATH="$bin:$PATH"; export PATH
# The script runs from the checkout, whose fetched crane it would prefer: the
# wrapper is named explicitly.
export TELFLO_CRANE="$bin/crane"

run() { # <args...>: sets rc, out, printed
  : >"$logs/docker-calls.log"; : >"$logs/crane-calls.log"
  printed="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$tmp/stub" "$shell" "$script" "$@" 2>"$tmp/stderr")"; rc=$?
  out="$(printf '%s\n' "$printed"; cat "$tmp/stderr")"
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
no_docker() { [ ! -s "$logs/docker-calls.log" ]; }

# --- 1. usage and refusals before anything runs -------------------------------------
oci="$tmp/oci"; mkdir -p "$oci"
run --version "$V"
check "no --oci refused (exit 2)" "[ $rc -eq 2 ] && has '--oci <dir> must be an existing directory' && no_docker"
run --oci "$tmp/none" --version "$V"
check "an --oci folder that doesn't exist refused (exit 2)" "[ $rc -eq 2 ] && no_docker"
for bad in v9.9.97 9.9 09.9.97 9.9.97-rc.1 ''; do
  run --oci "$oci" --version "$bad"
  check "the version '$bad' refused (exit 2)" "[ $rc -eq 2 ] && has '--version must be x.y.z' && no_docker"
done
run --oci "$oci" --version "$V" --image postgres
check "an image that isn't the release's refused (exit 2)" "[ $rc -eq 2 ] && has \"unknown image 'postgres'\" && no_docker"
run --oci "$oci" --version "$V" --bogus
check "an unknown argument refused (exit 2)" "[ $rc -eq 2 ] && has 'unknown argument: --bogus' && no_docker"
for bad in linux/386 amd64 linux/arm64/v8 windows/amd64 ''; do
  run --oci "$oci" --version "$V" --platform "$bad"
  check "--platform '$bad' refused (exit 2)" "[ $rc -eq 2 ] && has '--platform must be linux/amd64 or linux/arm64' && no_docker"
done
run --oci "$oci" --version "$V"
check "a missing archive refused before docker is asked (exit 1)" "[ $rc -eq 1 ] && has 'api.oci.tar is missing' && no_docker"
printf 'not a digest\n' >"$oci/ottl-evaluator.digest"; : >"$oci/ottl-evaluator.oci.tar"
run --oci "$oci" --version "$V" --image ottl-evaluator
check "a malformed digest file refused before docker is asked (exit 1)" "[ $rc -eq 1 ] && has \"ottl-evaluator.digest isn't one line\" && no_docker"
rm -f "$oci/ottl-evaluator.digest" "$oci/ottl-evaluator.oci.tar"

# --- 2. the loads, with the real docker and crane --------------------------------------
if tr_tools "$root" && [ -n "$real_docker" ] && [ -n "$real_crane" ]; then
  revision=0123456789abcdef0123456789abcdef01234567
  tr_fixture "$oci/ottl-evaluator.oci.tar" "$V" "$revision" L1 >"$oci/ottl-evaluator.digest"
  tr_fixture "$oci/collector-$V.oci.tar" "$V" "$revision" L2 >"$oci/collector-$V.digest"
  config_of() { # <tar> <amd64|arm64>
    TELFLO_OCI_PREFIX=t TELFLO_OCI_TMP="$tmp" "$shell" -c '. "$1"; telflo_oci_inspect "$2"' _ "$root/scripts/release/oci.sh" "$1" | awk -v a="$2" '$1 == a { print $3 }'
  }
  manifest_of() { # <tar> <amd64|arm64>
    TELFLO_OCI_PREFIX=t TELFLO_OCI_TMP="$tmp" "$shell" -c '. "$1"; telflo_oci_inspect "$2"' _ "$root/scripts/release/oci.sh" "$1" | awk -v a="$2" '$1 == a { print $2 }'
  }
  want_eval="$(config_of "$oci/ottl-evaluator.oci.tar" amd64)"
  want_coll="$(config_of "$oci/collector-$V.oci.tar" amd64)"
  want_eval_arm="$(config_of "$oci/ottl-evaluator.oci.tar" arm64)"
  want_coll_arm="$(config_of "$oci/collector-$V.oci.tar" arm64)"
  loaded="ghcr.io/telflo/telflo/ottl-evaluator:$V ghcr.io/telflo/telflo/collector:$V"
  loaded_ids="$want_eval $want_coll $want_eval_arm $want_coll_arm"
  id_of() { DOCKER_CONFIG="$tmp/stub" "$real_docker" image inspect --format '{{.Id}}' "$1" 2>/dev/null; }
  # The two platforms, named.
  run --oci "$oci" --version "$V" --image ottl-evaluator --image collector --platform linux/amd64
  check "--platform linux/amd64: each archive's linux/amd64 image is in the engine as ghcr.io/telflo/telflo/<name>:<v>, its id the archive's amd64 config digest" \
    "[ $rc -eq 0 ] && [ -n '$want_eval' ] && [ \"\$(id_of ghcr.io/telflo/telflo/ottl-evaluator:$V)\" = '$want_eval' ] && [ \"\$(id_of ghcr.io/telflo/telflo/collector:$V)\" = '$want_coll' ]"
  check "it prints '<release name> <image id>' per image, and names the platform" \
    "[ \"\$printed\" = \"ghcr.io/telflo/telflo/ottl-evaluator:$V $want_eval
ghcr.io/telflo/telflo/collector:$V $want_coll\" ] && has 'done: ottl-evaluator collector ($V, linux/amd64)' && ! grep -q 'Architecture' '$logs/docker-calls.log'"
  check "the amd64 images were pulled by their manifest digest from a registry on 127.0.0.1, never loaded from a tarball" \
    "[ \$(grep -cE '^pull -q 127\\.0\\.0\\.1:[0-9]+/telflo/telflo/(ottl-evaluator|collector)@sha256:[0-9a-f]{64} \$' '$logs/docker-calls.log') -eq 2 ] && grep -qF '@$(manifest_of "$oci/ottl-evaluator.oci.tar" amd64) ' '$logs/docker-calls.log' && ! grep -qE '^load( |\$)' '$logs/docker-calls.log'"
  check "the layouts were pushed with crane push <layout> (never --index), checked by crane digest" \
    "[ \$(grep -cE '^push [^ ]+/layout 127\\.0\\.0\\.1:[0-9]+/telflo/telflo/' '$logs/crane-calls.log') -eq 2 ] && ! grep -q -- '--index' '$logs/crane-calls.log' && [ \$(grep -c '^digest ' '$logs/crane-calls.log') -eq 2 ]"
  check "the throwaway registry container is gone, the loopback references untagged, the temporary folder empty" \
    "! DOCKER_CONFIG='$tmp/stub' '$real_docker' ps -a --format '{{.Names}}' | grep -qx \"\${TELFLO_LOAD_IMAGES_NAME:-telflo-load-images-.*}\" && ! DOCKER_CONFIG='$tmp/stub' '$real_docker' image ls --format '{{.Repository}}' | grep -qE '^127\\.0\\.0\\.1:' && [ -z \"\$(ls -A '$tmp/t')\" ]"
  run --oci "$oci" --version "$V" --image ottl-evaluator --image collector --platform linux/arm64
  check "--platform linux/arm64: each archive's linux/arm64 image loaded, its id the archive's arm64 config digest, pulled by the arm64 manifest digest" \
    "[ $rc -eq 0 ] && [ -n '$want_eval_arm' ] && [ '$want_eval_arm' != '$want_eval' ] && [ \"\$(id_of ghcr.io/telflo/telflo/ottl-evaluator:$V)\" = '$want_eval_arm' ] \
     && [ \"\$(id_of ghcr.io/telflo/telflo/collector:$V)\" = '$want_coll_arm' ] && grep -qF '@$(manifest_of "$oci/ottl-evaluator.oci.tar" arm64) ' '$logs/docker-calls.log' && has '($V, linux/arm64)'"
  # The default: the engine's own architecture (docker info), stand-in answers.
  STANDIN_ARCH=x86_64 run --oci "$oci" --version "$V" --image ottl-evaluator
  check "no --platform, an x86_64 engine: linux/amd64 loaded (said), its id the amd64 config digest" \
    "[ $rc -eq 0 ] && has \"the engine's own platform: linux/amd64\" && [ \"\$(id_of ghcr.io/telflo/telflo/ottl-evaluator:$V)\" = '$want_eval' ]"
  STANDIN_ARCH=aarch64 run --oci "$oci" --version "$V" --image ottl-evaluator
  check "no --platform, an aarch64 engine: linux/arm64 loaded (said), its id the arm64 config digest" \
    "[ $rc -eq 0 ] && has \"the engine's own platform: linux/arm64\" && [ \"\$(id_of ghcr.io/telflo/telflo/ottl-evaluator:$V)\" = '$want_eval_arm' ]"
  STANDIN_ARCH=amd64 run --oci "$oci" --version "$V" --image ottl-evaluator
  check "no --platform, an engine answering amd64: linux/amd64" "[ $rc -eq 0 ] && has \"the engine's own platform: linux/amd64\""
  STANDIN_ARCH=arm64 run --oci "$oci" --version "$V" --image ottl-evaluator
  check "no --platform, an engine answering arm64: linux/arm64" "[ $rc -eq 0 ] && has \"the engine's own platform: linux/arm64\""
  for bad in s390x armv7l ppc64le i386; do
    STANDIN_ARCH="$bad" run --oci "$oci" --version "$V" --image ottl-evaluator
    check "no --platform, a $bad engine: refused (exit 2) before any registry starts" \
      "[ $rc -eq 2 ] && has \"the engine's architecture '$bad' is neither amd64 nor arm64\" && ! grep -qE '^(run|create|pull) ' '$logs/docker-calls.log'"
  done
  STANDIN_WRONG_ID=1 run --oci "$oci" --version "$V" --image ottl-evaluator --platform linux/amd64
  check "load-images fails when the engine's image id differs from the archive's amd64 config digest" \
    "[ $rc -eq 1 ] && has \"the engine's image id for ghcr.io/telflo/telflo/ottl-evaluator:$V is 'sha256:4444\" && has \"not the archive's amd64 config $want_eval\""
  want_manifest="$(manifest_of "$oci/ottl-evaluator.oci.tar" amd64)"
  want_manifest_arm="$(manifest_of "$oci/ottl-evaluator.oci.tar" arm64)"
  STANDIN_STORE=containerd STANDIN_ID="$want_manifest" run --oci "$oci" --version "$V" --image ottl-evaluator --platform linux/amd64
  check "containerd's image store: the engine's id is the amd64 manifest digest, accepted" "[ $rc -eq 0 ] && [ -n '$want_manifest' ]"
  STANDIN_STORE=containerd STANDIN_ID="$want_eval" run --oci "$oci" --version "$V" --image ottl-evaluator --platform linux/amd64
  check "containerd's image store: the config digest as the id is refused" \
    "[ $rc -eq 1 ] && has \"not the archive's amd64 manifest (containerd's image store) $want_manifest\""
  STANDIN_STORE=containerd STANDIN_ID="$want_manifest_arm" run --oci "$oci" --version "$V" --image ottl-evaluator --platform linux/arm64
  check "containerd's image store, linux/arm64: the arm64 manifest digest accepted" "[ $rc -eq 0 ] && [ -n '$want_manifest_arm' ]"
  STANDIN_STORE=containerd STANDIN_ID="$want_manifest" run --oci "$oci" --version "$V" --image ottl-evaluator --platform linux/arm64
  check "containerd's image store, linux/arm64: the amd64 manifest digest as the id refused" \
    "[ $rc -eq 1 ] && has \"not the archive's arm64 manifest (containerd's image store) $want_manifest_arm\""
  STANDIN_STORE=classic STANDIN_ID="$want_manifest" run --oci "$oci" --version "$V" --image ottl-evaluator --platform linux/amd64
  check "the classic store: the manifest digest as the id is refused (the config digest expected)" \
    "[ $rc -eq 1 ] && has \"not the archive's amd64 config $want_eval\""
  STANDIN_STORE=classic STANDIN_ID="$want_eval" run --oci "$oci" --version "$V" --image ottl-evaluator --platform linux/arm64
  check "the classic store, linux/arm64: the amd64 config digest as the id is refused (the wrong platform's image)" \
    "[ $rc -eq 1 ] && has \"not the archive's arm64 config $want_eval_arm\""
  cp "$oci/collector-$V.digest" "$tmp/saved-digest"
  tr_fixture "$tmp/other.oci.tar" "$V" "$revision" L3 >"$oci/collector-$V.digest"
  run --oci "$oci" --version "$V" --image collector
  check "an archive whose index isn't its digest file's refused before the registry starts" \
    "[ $rc -eq 1 ] && has \"index.json's entry is\" && [ -f '$logs/docker-calls.log' ] && ! grep -qE '^(run|create) ' '$logs/docker-calls.log'"
  cp "$tmp/saved-digest" "$oci/collector-$V.digest"
  run --oci "$oci" --version 9.9.98 --image ottl-evaluator
  check "an archive of another version refused (its labels)" "[ $rc -eq 1 ] && has \"version label isn't 9.9.98\""
  check "no docker or crane call was a login" "! grep -qE '(^| )login( |\$)' '$logs/docker-calls.log' && ! grep -qE '^(auth|login) ' '$logs/all-crane-calls.log'"
else
  for c in "the loads and the image ids" "the id-differs failure" "the archive checks"; do skip "load-images: $c" "${TR_SKIP:-no docker or crane}"; done
fi
check "no credential helper was called" "[ ! -s '$logs/helper.log' ]"

echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
