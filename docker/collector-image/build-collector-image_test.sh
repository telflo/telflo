#!/bin/bash
# Tests for scripts/build-collector-image.sh's checks. No build: `docker` is
# a stand-in first on PATH (it records every call and answers `version`,
# `buildx version`, `buildx … inspect` and `buildx … build` itself, writing
# for --build-oci the OCI archive and metadata file a build would, made
# offline by scripts/release/test-registry.sh's fixture; `context inspect`
# goes to the real docker, which only reads the test's own DOCKER_CONFIG).
# `crane` is a wrapper first on PATH that records every call and answers
# `digest` per case, or hands it to the real crane. Refusing credential-helper
# stand-ins come first on PATH too: none may be called. --build-oci and
# --push-oci cases run against a committed copy of the image's inputs in a
# throwaway git repository (its HEAD is the revision label; the dirty check is
# tried on it). --build-oci builds from HEAD's docker/collector-image
# extracted into the script's temporary directory: the tests check the
# context path and that ignored files never reach it. --push-oci runs with
# the real crane against a throwaway registry:2 on 127.0.0.1 (tools.lock's
# image, local by digest), or prints SKIP lines when crane, docker or that
# image is missing. Nothing reaches any other registry.
# Run:  bash docker/collector-image/build-collector-image_test.sh
# bash 3.2 compatible (macOS's /bin/bash).
set -u
# One spelling of the temporary folder (no trailing slash, no //), and no CI:
# the test sets CI itself where a case needs it.
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI
# Hermetic: a caller's tools folder or git setting never changes what these cases test.
unset TELFLO_TOOLS_DIR TELFLO_TOOLS_LOCK TELFLO_TOOLS_PLATFORM GIT_NO_REPLACE_OBJECTS
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
script="$root/scripts/build-collector-image.sh"
catalogue="$root/catalog/distributions/otelcol-contrib.json"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }
check() { # <name> <shell-expr that must succeed>
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/build-collector-image-test.XXXXXX")" || exit 1
cleanup() { tr_registry_stop; rm -rf "$tmp"; }
trap cleanup EXIT

# --- the stand-ins and the test's own Docker configuration --------------------
real_docker="$(command -v docker 2>/dev/null || true)"
real_crane="$("$shell" "$root/scripts/release/tools.sh" path crane 2>/dev/null || command -v crane 2>/dev/null || true)"
bin="$tmp/bin"; logs="$tmp/logs"
mkdir -p "$bin" "$logs" "$tmp/docker" "$tmp/scratch" "$tmp/stub"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/docker/config.json"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/stub/config.json"
TR_DOCKER_CONFIG="$tmp/stub"
TR_DOCKER="${real_docker:-docker}"
for helper in osxkeychain desktop ecr-login; do
  # Logs its first argument only, never reads stdin, refuses.
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$logs" >"$bin/docker-credential-$helper"
  chmod +x "$bin/docker-credential-$helper"
done
cat >"$bin/docker" <<EOF
#!/bin/bash
# The test's docker stand-in: records every call; never builds, never pushes.
log="$logs"
real="$real_docker"
root="$root"
EOF
cat >>"$bin/docker" <<'EOF'
{ printf '%q ' "$@"; echo; } >>"$log/docker-calls.log"
{ printf '%q ' "$@"; echo; } >>"$log/all-docker-calls.log"
args=("$@")
i=0
if [ "${1:-}" = "--context" ]; then i=2; fi
case "${args[$i]:-}" in
  context)
    # Local files only (the caller's DOCKER_CONFIG): the real answer.
    if [ -n "$real" ]; then exec "$real" "$@"; fi
    exit 1 ;;
  version) echo "${STANDIN_ARCH:-arm64}"; exit 0 ;;
  buildx)
    if [ "${args[$((i + 1))]:-}" = version ]; then echo "github.com/docker/buildx ${STANDIN_BUILDX:-v0.38.1} 0000000"; exit 0; fi
    if [ "${args[$((i + 1))]:-}" = imagetools ] && [ "${args[$((i + 2))]:-}" = inspect ]; then
      ref="${args[$((i + 3))]:-}"
      printf '%s\n' "$ref" >>"$log/imagetools.log"
      { printf 'DOCKER_CONFIG=%s\n' "${DOCKER_CONFIG:-}"; cat "${DOCKER_CONFIG:-/nonexistent}/config.json" 2>/dev/null; } >"$log/imagetools-env"
      for t in ${STANDIN_EXISTING:-}; do
        if [ "$ref" = "${ref%:*}:$t" ]; then echo "Name: $ref"; exit 0; fi
      done
      case "${STANDIN_IMAGETOOLS:-absent}" in
        exists) echo "Name: $ref"; exit 0 ;;
        absent) echo "error: $ref: not found" >&2; exit 1 ;;
        absent-exit-2) echo "error: $ref: not found" >&2; exit 2 ;;
        other-ref) echo "error: $ref-other: not found" >&2; exit 1 ;;
        *) echo "error: failed to authorize: failed to fetch anonymous token: unexpected status: 403 Forbidden" >&2
           echo "a second line" >&2; exit 1 ;;
      esac
    fi
    if [ "${args[$((i + 1))]:-}" = --builder ]; then
      case "${args[$((i + 3))]:-}" in
        inspect)
          # desktop-linux is a docker-driver builder; any other, docker-container.
          driver=docker-container; [ "${args[$((i + 2))]}" = desktop-linux ] && driver=docker
          printf 'Name:   %s\nDriver: %s\n' "${args[$((i + 2))]}" "${STANDIN_DRIVER:-$driver}"; exit 0 ;;
        build)
          { echo docker; printf '%q\n' "$@"; } >"$log/build-argv"
          # The build context's files (its last argument), as the build saw them.
          ( cd "${@: -1}" 2>/dev/null && find . -type f | sed 's#^\./##' | sort ) >"$log/build-context-files"
          rm -rf "$log/build-context"; cp -Rp "${@: -1}" "$log/build-context" 2>/dev/null
          { printf 'DOCKER_CONFIG=%s\n' "${DOCKER_CONFIG:-}"; cat "${DOCKER_CONFIG:-/nonexistent}/config.json" 2>/dev/null; } >"$log/build-env"
          prev=""; output=""; meta=""; version=""; revision=""
          for a in "$@"; do
            if [ "$prev" = --tag ]; then printf '%s\n' "$a" >>"$log/builds.log"; fi
            case "$prev" in
              --output) output="$a"; printf 'oci %s\n' "$a" >>"$log/builds.log" ;;
              --metadata-file) meta="$a" ;;
              --label) case "$a" in org.opencontainers.image.version=*) version="${a#*=}" ;; org.opencontainers.image.revision=*) revision="${a#*=}" ;; esac ;;
            esac
            prev="$a"
          done
          [ "${STANDIN_BUILD_EXIT:-0}" -eq 0 ] || exit "$STANDIN_BUILD_EXIT"
          case "$output" in
            type=oci,dest=*)
              . "$root/scripts/release/test-registry.sh"
              attest=""; case " $* " in *" --provenance=false "*) attest=no-attest ;; esac
              digest="$(tr_fixture "${output#type=oci,dest=}" "$version" "$revision" "${STANDIN_VARIANT:-A}" $attest)" || exit 4
              printf '{"containerimage.digest":"%s"}\n' "$digest" >"$meta" ;;
          esac
          exit 0 ;;
      esac
    fi ;;
esac
echo "UNEXPECTED $*" >>"$log/docker-calls.log"
exit 97
EOF
chmod +x "$bin/docker"
tr_crane_wrapper "$bin" "$logs" "${real_crane:-/nonexistent/crane}"
PATH="$bin:$PATH"; export PATH
# The crane wrapper answers "absent" unless a case asks for the real crane
# (STANDIN_CRANE empty): no case reads a registry but the throwaway one.
export STANDIN_CRANE=absent
# Never go on unless `docker` and `crane` are the test's: builds and pushes run below.
if [ "$(command -v docker)" != "$bin/docker" ] || [ "$(command -v crane)" != "$bin/crane" ]; then
  echo "FAIL - the docker stand-in and the crane wrapper are not first on PATH"; exit 1
fi

clear_logs() { rm -f "$logs/docker-calls.log" "$logs/imagetools.log" "$logs/imagetools-env" "$logs/build-argv" "$logs/build-env" "$logs/builds.log" "$logs/crane-calls.log" "$logs/crane-config.log"; }
no_crane() { [ ! -s "$logs/crane-calls.log" ]; }
nothing_pushed() { ! grep -qE '^push( |$)' "$logs/crane-calls.log" 2>/dev/null; }
called() { grep -qF -- "$1" "$logs/docker-calls.log" 2>/dev/null; }
no_build() { ! grep -qE '(^| )build( |$)' "$logs/docker-calls.log" 2>/dev/null; }
no_imagetools() { [ ! -s "$logs/imagetools.log" ]; }

# run <args...>: runs the checkout's script; sets rc, out (stdout and stderr)
# and argv_out (stdout alone: a dry run's command).
run_in() { # <script> <args...>
  local s="$1"; shift
  clear_logs
  out="$(env -u TELFLO_COLLECTOR_IMAGE_REPOSITORY -u BUILDX_BUILDER -u TELFLO_COLLECTOR_CATALOGUE \
    DOCKER_CONFIG="${TEST_DOCKER_CONFIG:-$tmp/docker}" TMPDIR="$tmp/scratch" "$shell" "$s" "$@" 2>"$tmp/stderr")"
  rc=$?
  argv_out="$out"
  out="$(printf '%s\n' "$argv_out"; cat "$tmp/stderr")"
}
run() { run_in "$script" "$@"; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }

# --- 1. arguments --------------------------------------------------------------
run
check "no version refused" "[ $rc -eq 2 ] && has 'a version is required'"
run 0.162.0 --bogus
check "an unknown flag refused" "[ $rc -eq 2 ] && has 'unknown option: --bogus'"
run v0.162.0 --platform linux/arm64 --dry-run
check "a version not x.y.z refused" "[ $rc -eq 2 ] && has 'must be x.y.z'"
run 0.162.0 0.161.0 --dry-run
check "two versions refused" "[ $rc -eq 2 ] && has 'one version only'"
run 0.162.0 --platform
check "--platform without a value refused" "[ $rc -eq 2 ] && has '--platform needs a value'"
run 0.162.0 --platform windows/amd64 --dry-run
check "a platform other than linux amd64/arm64 refused" "[ $rc -eq 2 ] && has '--platform must be'"
run 0.162.0 --platform linux/amd64,linux/arm64 --dry-run
check "two platforms for a local build refused" "[ $rc -eq 2 ] && has '--platform must be'"
run 0.162.0 --push --builder owner-builder --dry-run
check "--push refused as an unknown option, naming --build-oci and --push-oci" \
  "[ $rc -eq 2 ] && has 'unknown option: --push' && has '--build-oci <dir>' && has '--push-oci <dir>'"
run 0.162.0 --build-oci "$tmp" --dry-run
check "--build-oci without --builder refused" "[ $rc -eq 2 ] && has '--build-oci needs --builder'"
run 0.162.0 --build-oci "$tmp" --builder owner-builder --platform linux/amd64 --dry-run
check "--build-oci with one platform refused" "[ $rc -eq 2 ] && has '--build-oci builds both platforms'"
run 0.162.0 --build-oci "$tmp" --push-oci "$tmp"
check "--build-oci with --push-oci refused" "[ $rc -eq 2 ] && has 'one of --build-oci or --push-oci'"
run 0.162.0 --push-oci "$tmp" --builder owner-builder
check "--push-oci with --builder refused" "[ $rc -eq 2 ] && has '--push-oci builds nothing'"
run 0.162.0 --push-oci "$tmp" --dry-run
check "--push-oci with --dry-run refused" "[ $rc -eq 2 ] && has '--dry-run goes with a local build or --build-oci'"
run 0.162.0 --push-oci
check "--push-oci without a folder refused" "[ $rc -eq 2 ] && has '--push-oci needs a folder'"
run 0.162.0 --build-oci "$tmp/none" --builder owner-builder --dry-run
check "a --build-oci folder that doesn't exist refused" "[ $rc -eq 2 ] && has 'must be an existing directory'"
run 0.162.0 --platform linux/arm64 --no-attest --dry-run
check "--no-attest without --build-oci refused" "[ $rc -eq 2 ] && has '--no-attest goes with --build-oci only'"
run 0.162.0 --platform linux/arm64 --registry 127.0.0.1:5000 --dry-run
check "--registry with a local build refused" "[ $rc -eq 2 ] && has '--registry goes with --push-oci'"
for bad in docker.io ghcr.io/telflo/platform ghcr.io/telflo/collector 10.0.0.1:5000 localhost 127.0.0.1:0; do
  run 0.162.0 --push-oci "$tmp" --registry "$bad"
  check "--registry '$bad' refused (only ghcr.io or a loopback registry)" "[ $rc -eq 2 ] && has '--registry must be ghcr.io or a loopback registry'"
done
run 0.162.0 --platform linux/arm64 --builder 'bad name' --dry-run
check "a malformed builder name refused" "[ $rc -eq 2 ] && has 'the builder'"
clear_logs
out="$(env DOCKER_CONFIG="$tmp/docker" TELFLO_COLLECTOR_IMAGE_REPOSITORY='GHCR.io/Bad' "$shell" "$script" 0.162.0 --platform linux/arm64 --dry-run 2>&1)"; rc=$?
check "a malformed repository refused" "[ $rc -ne 0 ] && has 'TELFLO_COLLECTOR_IMAGE_REPOSITORY must match'"
run 0.162.0 --platform linux/arm64 --replace --dry-run
check "--replace refused as an unknown option" "[ $rc -eq 2 ] && has 'unknown option: --replace' && has '--push-oci <dir>'"
check "no docker or crane call for a refused argument" "[ ! -s '$logs/docker-calls.log' ] && no_crane"

# --- 2. the catalog's versions -----------------------------------------------
run 9.9.9 --platform linux/arm64 --dry-run
check "an unknown version refused" "[ $rc -eq 1 ] && has 'version 9.9.9 is not in the catalogue'"
run 0.158.0 --platform linux/arm64 --dry-run
check "a deprecated version refused" "[ $rc -eq 1 ] && has 'version 0.158.0 is deprecated'"
check "nothing built for a refused version" "! has 'would build'"

# --- 3. the catalog's values are the build's arguments ------------------------
expected="$(python3 -I - "$catalogue" 0.162.0 <<'PY'
import json, sys
entry = next(v for v in json.load(open(sys.argv[1]))["versions"] if v["version"] == sys.argv[2])
for name, binary in (("OTELCOL", "otelcolContrib"), ("SUPERVISOR", "opampSupervisor")):
    for arch in ("amd64", "arm64"):
        item = entry[binary]["linux_" + arch]
        print("%s_URL_%s=%s" % (name, arch.upper(), item["downloadUrl"]))
        print("%s_SHA256_%s=%s" % (name, arch.upper(), item["sha256"]))
PY
)"
run 0.162.0 --platform linux/arm64 --dry-run
check "a local build: one platform, the tag, desktop-linux, --load" \
  "[ $rc -eq 0 ] && has 'would build ghcr.io/telflo/telflo/collector:0.162.0 for linux/arm64 through builder desktop-linux (--load)'"
check "the catalog's eight URLs and sha256 passed as build args" \
  "[ \"\$(printf '%s\n' \"\$out\" | grep -E '^(OTELCOL|SUPERVISOR)_' | sort)\" = \"\$(printf '%s\n' \"\$expected\" | sort)\" ] && [ \$(printf '%s\n' \"\$expected\" | wc -l) -eq 8 ]"
clear_logs
out="$(env DOCKER_CONFIG="$tmp/docker" BUILDX_BUILDER=other-builder TELFLO_COLLECTOR_IMAGE_REPOSITORY=registry.example:5000/mirror/collector \
  "$shell" "$script" 0.161.0 --platform linux/amd64 --dry-run 2>&1)"; rc=$?
check "BUILDX_BUILDER and the repository setting honored" \
  "[ $rc -eq 0 ] && has 'would build registry.example:5000/mirror/collector:0.161.0 for linux/amd64 through builder other-builder (--load)'"

# --- 4. a catalog whose values aren't the catalog's formats --------------------
bad_catalogue() { # <python expression mutating entry `e`> -> path of a scratch copy
  python3 -I - "$catalogue" "$tmp/catalogue.json" "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
e = next(v for v in data["versions"] if v["version"] == "0.162.0")
exec(sys.argv[3])
json.dump(data, open(sys.argv[2], "w"))
PY
}
run_bad() { # <python mutation>
  bad_catalogue "$1"
  out="$(DOCKER_CONFIG="$tmp/docker" TELFLO_COLLECTOR_CATALOGUE="$tmp/catalogue.json" "$shell" "$script" 0.162.0 --platform linux/arm64 --dry-run 2>&1)"; rc=$?
}
run_bad 'e["otelcolContrib"]["linux_arm64"]["sha256"] = "F" * 64'
check "an uppercase sha256 refused" "[ $rc -eq 1 ] && has 'sha256 is not 64 lowercase hex digits'"
run_bad 'e["opampSupervisor"]["linux_amd64"]["sha256"] = "a" * 63'
check "a short sha256 refused" "[ $rc -eq 1 ] && has 'sha256 is not 64 lowercase hex digits'"
run_bad 'e["otelcolContrib"]["linux_amd64"]["downloadUrl"] = "https://example.com/otelcol-contrib_0.162.0_linux_amd64.tar.gz"'
check "a URL off upstream's releases refused" "[ $rc -eq 1 ] && has 'not under upstream'"
run_bad 'e["opampSupervisor"]["linux_arm64"]["downloadUrl"] = "http://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/x/opampsupervisor_0.162.0_linux_arm64"'
check "a plain-http URL refused" "[ $rc -eq 1 ] && has 'not under upstream'"
run_bad 'e["opampSupervisor"]["linux_arm64"]["downloadUrl"] = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/../../../evil/opampsupervisor_0.162.0_linux_arm64"'
check "a URL climbing out with .. refused" "[ $rc -eq 1 ] && has 'not under upstream'"
run_bad 'e["opampSupervisor"]["linux_arm64"]["downloadUrl"] = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/%2e%2e/%2e%2e/%2e%2e/evil/opampsupervisor_0.162.0_linux_arm64"'
check "a URL climbing out with %2e%2e refused" "[ $rc -eq 1 ] && has 'not under upstream'"
run_bad 'e["opampSupervisor"]["linux_arm64"]["downloadUrl"] = e["opampSupervisor"]["linux_arm64"]["downloadUrl"].replace("%2F", "%2f")'
check "a percent-escape other than %2F refused" "[ $rc -eq 1 ] && has 'not under upstream'"
run_bad 'e["otelcolContrib"]["linux_arm64"]["downloadUrl"] = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.162.0/otelcol-contrib_0.162.0_linux_arm64.tar.gz\n--build-arg X=1"'
check "a URL with a line break refused" "[ $rc -eq 1 ] && has 'not under upstream'"
run_bad 'e["otelcolContrib"]["linux_amd64"]["downloadUrl"] = e["otelcolContrib"]["linux_amd64"]["downloadUrl"].replace("0.162.0", "0.161.0")'
check "another version's binary refused" "[ $rc -eq 1 ] && has 'is not otelcol-contrib_0.162.0_linux_amd64.tar.gz'"
run_bad 'e["opampSupervisor"]["linux_arm64"]["downloadUrl"] = e["opampSupervisor"]["linux_amd64"]["downloadUrl"]'
check "another platform's binary refused" "[ $rc -eq 1 ] && has 'is not opampsupervisor_0.162.0_linux_arm64'"
run_bad 'del e["opampSupervisor"]["linux_amd64"]'
check "a missing binary refused" "[ $rc -eq 1 ] && has 'no opampSupervisor linux_amd64 binary'"
run_bad 'e["deprecated"] = None'
check "a deprecated flag that isn't false refused" "[ $rc -eq 1 ] && has 'is deprecated'"
run_bad 'data["versions"].append(dict(e))'
check "a version listed twice refused" "[ $rc -eq 1 ] && has 'more than once'"

# --- 5. the bash checks on their own (the Python reader checks first, so
# these are taken from the script and run without it) ------------------------
{
  grep -E '^(URL_RE|SHA256_RE)=' "$script"
  echo 'fail() { echo "$1" >&2; exit 1; }'
  sed -n '/^check_url() {/,/^}/p' "$script"
  sed -n '/^check_sha() {/p' "$script"
} > "$tmp/checks.sh"
bash_check() { # <url> <file name>: runs the script's own check_url
  out="$("$shell" -c '. "$1"; check_url "$2" "$3"' _ "$tmp/checks.sh" "$1" "$2" 2>&1)"; rc=$?
}
base='https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download'
check "bash checks extracted" "grep -q '^check_url()' '$tmp/checks.sh' && grep -q '^URL_RE=' '$tmp/checks.sh'"
bash_check "$base/cmd%2Fopampsupervisor%2Fv0.162.0/opampsupervisor_0.162.0_linux_arm64" opampsupervisor_0.162.0_linux_arm64
check "bash check_url: upstream's %2F passes" "[ $rc -eq 0 ]"
bash_check "$base/%2e%2e/%2e%2e/evil/opampsupervisor_0.162.0_linux_arm64" opampsupervisor_0.162.0_linux_arm64
check "bash check_url: %2e%2e refused" "[ $rc -ne 0 ] && has 'not an upstream release URL'"
bash_check "$base/cmd%2fopampsupervisor%2fv0.162.0/opampsupervisor_0.162.0_linux_arm64" opampsupervisor_0.162.0_linux_arm64
check "bash check_url: a lowercase %2f refused" "[ $rc -ne 0 ] && has 'not an upstream release URL'"
bash_check "$base/../evil/opampsupervisor_0.162.0_linux_arm64" opampsupervisor_0.162.0_linux_arm64
check "bash check_url: .. refused" "[ $rc -ne 0 ] && has 'not an upstream release URL'"
bash_check "https://example.com/opampsupervisor_0.162.0_linux_arm64" opampsupervisor_0.162.0_linux_arm64
check "bash check_url: another host refused" "[ $rc -ne 0 ] && has 'not an upstream release URL'"
bash_check "$base/v0.161.0/otelcol-contrib_0.161.0_linux_arm64.tar.gz" otelcol-contrib_0.162.0_linux_arm64.tar.gz
check "bash check_url: another version's file refused" "[ $rc -ne 0 ] && has 'is not otelcol-contrib_0.162.0_linux_arm64.tar.gz'"

# --- 6. the exact docker command ----------------------------------------------
# expected_argv <root> <revision> <platform> <builder> <tag> <--load|--push> [<context>]:
# the command, one shell-quoted argument a line.
expected_argv() {
  local r="$1" rev="$2" platform="$3" builder="$4" tag="$5" output="$6" ctx="${7:-}"
  local version="${tag##*:}"
  local -a a
  a=(docker)
  if [ -n "$ctx" ]; then a=("${a[@]}" --context "$ctx"); fi
  a=("${a[@]}" buildx --builder "$builder" build --platform "$platform")
  while IFS= read -r line; do a=("${a[@]}" --build-arg "$line"); done <<<"$(python3 -I - "$catalogue" "$version" <<'PY'
import json, sys
entry = next(v for v in json.load(open(sys.argv[1]))["versions"] if v["version"] == sys.argv[2])
for name, binary in (("OTELCOL", "otelcolContrib"), ("SUPERVISOR", "opampSupervisor")):
    for arch in ("amd64", "arm64"):
        item = entry[binary]["linux_" + arch]
        print("%s_URL_%s=%s" % (name, arch.upper(), item["downloadUrl"]))
        print("%s_SHA256_%s=%s" % (name, arch.upper(), item["sha256"]))
PY
)"
  a=("${a[@]}"
    --label "org.opencontainers.image.source=https://github.com/telflo/telflo"
    --label "org.opencontainers.image.version=$version"
    --label "org.opencontainers.image.revision=$rev"
    --label "org.opencontainers.image.title=Telflo platform collector"
    --label "org.opencontainers.image.description=otelcol-contrib $version under the OpAMP supervisor, for the Telflo platform"
    --tag "$tag" "$output" "$r/docker/collector-image")
  printf '%q\n' "${a[@]}"
}
head_revision="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"

run 0.162.0 --platform linux/arm64 --dry-run
want="$(expected_argv "$root" "$head_revision" linux/arm64 desktop-linux ghcr.io/telflo/telflo/collector:0.162.0 --load)"
check "a local dry run prints the exact command (labels, platform, tag, --load), one quoted argument a line" \
  "[ $rc -eq 0 ] && [ \"\$argv_out\" = \"\$want\" ]"
check "the new default repository ghcr.io/telflo/telflo/collector" \
  "printf '%s\n' \"\$argv_out\" | grep -qx 'ghcr.io/telflo/telflo/collector:0.162.0'"
check "the labels: source this repository, the collector's version, git HEAD" \
  "printf '%s\n' \"\$argv_out\" | grep -qx 'org.opencontainers.image.source=https://github.com/telflo/telflo' && printf '%s\n' \"\$argv_out\" | grep -qx 'org.opencontainers.image.version=0.162.0' && printf '%s\n' \"\$argv_out\" | grep -qx \"org.opencontainers.image.revision=\$head_revision\""
check "no latest tag" "! printf '%s\n' \"\$argv_out\" | grep -q ':latest'"
eval "decoded=( $(printf '%s\n' "$argv_out" | tr '\n' ' ') )"
check "the printed lines are shell-quoted: read back by the shell they are the arguments" \
  "[ \"\${decoded[23]}\" = '--label' ] && [ \"\${decoded[32]}\" = 'org.opencontainers.image.description=otelcol-contrib 0.162.0 under the OpAMP supervisor, for the Telflo platform' ] && [ \${#decoded[@]} -eq 37 ]"
check "a dry run runs no build (docker asked only for its contexts)" \
  "no_build && no_imagetools && ! grep -vq '^context inspect' '$logs/docker-calls.log'"
dry_local="$argv_out"
run 0.162.0 --platform linux/arm64
check "a local build runs exactly the printed command" \
  "[ $rc -eq 0 ] && [ \"\$(cat '$logs/build-argv')\" = \"\$dry_local\" ] && called 'buildx --builder desktop-linux inspect'"
STANDIN_DRIVER=docker-container run 0.162.0 --platform linux/arm64
check "a local build through a docker-container builder refused, nothing built" \
  "[ $rc -eq 1 ] && has \"uses the 'docker-container' driver\" && no_build"

# The context branch: a builder named after a Docker context runs through it.
ctx_config="$tmp/ctx-docker"
ctx_hash="$(printf '%s' ctx-builder | shasum -a 256 | cut -d' ' -f1)"
mkdir -p "$ctx_config/contexts/meta/$ctx_hash"
cp "$tmp/docker/config.json" "$ctx_config/config.json"
printf '{"Name":"ctx-builder","Metadata":{},"Endpoints":{"docker":{"Host":"unix:///nonexistent-telflo-test.sock","SkipTLSVerify":false}}}' \
  >"$ctx_config/contexts/meta/$ctx_hash/meta.json"
if [ -n "$real_docker" ]; then
  TEST_DOCKER_CONFIG="$ctx_config" run 0.162.0 --platform linux/amd64 --builder ctx-builder --dry-run
  want="$(expected_argv "$root" "$head_revision" linux/amd64 ctx-builder ghcr.io/telflo/telflo/collector:0.162.0 --load ctx-builder)"
  check "a builder named after a Docker context: docker --context <it> (local dry run)" \
    "[ $rc -eq 0 ] && [ \"\$argv_out\" = \"\$want\" ]"
else
  echo "skip - the context branch (no real docker to read a context)"
fi

# The real docker parses the printed command: with the builder replaced by
# one that doesn't exist (in an empty DOCKER_CONFIG) and the build context by
# a path that doesn't exist, buildx gets as far as looking the builder up,
# past every flag and the argument count (a stand-in alone is never
# trusted with an argv). Nothing is built, nothing leaves the machine.
if [ -n "$real_docker" ]; then
  parse_config="$tmp/parse-docker"; mkdir -p "$parse_config"
  cp "$tmp/docker/config.json" "$parse_config/config.json"
  eval "parsed=( $(printf '%s\n' "$dry_local" | tr '\n' ' ') )"
  parsed[3]=telflo-test-absent-builder
  parsed[$((${#parsed[@]} - 1))]="$tmp/absent-build-context"
  real_out="$(DOCKER_CONFIG="$parse_config" "$real_docker" "${parsed[@]:1}" 2>&1)"; real_rc=$?
  # The absent builder's error, in either buildx's words: an older buildx
  # (v0.8) opens <DOCKER_CONFIG>/buildx/instances/<name> and fails on it, a
  # newer one (v0.38, the runner's) says `no builder "<name>" found`.
  absent_builder_re='buildx/instances/telflo-test-absent-builder|no builder "telflo-test-absent-builder" found'
  failures_before=$failures
  check "the real docker accepts the printed command's flags and arguments (it stops at the absent builder)" \
    "[ $real_rc -ne 0 ] && printf '%s\n' \"\$real_out\" | grep -qE \"\$absent_builder_re\" && ! printf '%s\n' \"\$real_out\" | grep -qiE 'unknown (flag|shorthand)|requires exactly|usage:'"
  [ "$failures" -eq "$failures_before" ] \
    || printf '       docker said (exit %s): %s\n' "$real_rc" "$(printf '%s\n' "$real_out" | head -n 5)"
else
  echo "skip - the real docker's parse (no docker on PATH)"
fi

# --- 7. --build-oci and --push-oci: a committed copy of the image's inputs ---------
repo="$tmp/repo"
mkdir -p "$repo/scripts/release" "$repo/catalog/distributions" "$repo/docker"
cp "$script" "$repo/scripts/build-collector-image.sh"
cp "$root/scripts/release/oci.sh" "$root/scripts/release/tools.sh" "$root/scripts/release/tools.lock" "$repo/scripts/release/"
cp "$catalogue" "$repo/catalog/distributions/otelcol-contrib.json"
cp -R "$here" "$repo/docker/collector-image"
echo "outside the image's inputs" >"$repo/NOTES.txt"
cp "$root/.gitignore" "$repo/.gitignore"
git_q() { git -C "$repo" -c user.name=telflo-test -c user.email=test@telflo.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@" >/dev/null 2>&1; }
git_q init -q && git_q add -A && git_q commit -q -m inputs
repo_script="$repo/scripts/build-collector-image.sh"
repo_revision="$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo none)"
check "the throwaway repository is committed and clean" \
  "[ \${#repo_revision} -eq 40 ] && [ -z \"\$(git -C '$repo' status --porcelain)\" ]"
prun() { run_in "$repo_script" "$@"; }
oci="$tmp/oci"; mkdir -p "$oci"
SBOM="$("$shell" "$root/scripts/release/tools.sh" ref syft-scanner)"
# --build-oci builds from HEAD's docker/collector-image extracted into the
# script's temporary directory (the command's last argument), its metadata
# file there too.
oci_context_re="^$tmp/scratch/build-collector-image\.[A-Za-z0-9]+/source/docker/collector-image\$"
normalise_tmp() { sed -E "s#$tmp/scratch/build-collector-image\.[A-Za-z0-9]+#TMP_DIR#g"; }
fresh_oci() { mktemp -d "$tmp/oci-n.XXXXXX"; }
same_oci() { # <argv lines> <argv lines>: equal but for the temporary directory, the context the extraction
  [ "$(printf '%s\n' "$1" | normalise_tmp)" = "$(printf '%s\n' "$2" | normalise_tmp)" ] \
    && printf '%s\n' "$1" | tail -n 1 | grep -qE "$oci_context_re" \
    && printf '%s\n' "$2" | tail -n 1 | grep -qE "$oci_context_re"
}
expected_oci_argv() { # <revision> <folder> [no-attest]
  local rev="$1" dir="$2"
  local -a a
  a=(docker buildx --builder owner-builder build --platform linux/amd64,linux/arm64)
  while IFS= read -r line; do a=("${a[@]}" --build-arg "$line"); done <<<"$(python3 -I - "$catalogue" 0.162.0 <<'PY'
import json, sys
entry = next(v for v in json.load(open(sys.argv[1]))["versions"] if v["version"] == sys.argv[2])
for name, binary in (("OTELCOL", "otelcolContrib"), ("SUPERVISOR", "opampSupervisor")):
    for arch in ("amd64", "arm64"):
        item = entry[binary]["linux_" + arch]
        print("%s_URL_%s=%s" % (name, arch.upper(), item["downloadUrl"]))
        print("%s_SHA256_%s=%s" % (name, arch.upper(), item["sha256"]))
PY
)"
  a=("${a[@]}"
    --label "org.opencontainers.image.source=https://github.com/telflo/telflo"
    --label "org.opencontainers.image.version=0.162.0"
    --label "org.opencontainers.image.revision=$rev"
    --label "org.opencontainers.image.title=Telflo platform collector"
    --label "org.opencontainers.image.description=otelcol-contrib 0.162.0 under the OpAMP supervisor, for the Telflo platform")
  if [ "${3:-}" = no-attest ]; then a=("${a[@]}" --provenance=false)
  else a=("${a[@]}" --provenance=mode=max --attest "type=sbom,generator=$SBOM"); fi
  a=("${a[@]}" --output "type=oci,dest=$dir/collector-0.162.0.oci.tar.partial" --metadata-file "TMP_DIR/metadata.json" "TMP_DIR/source/docker/collector-image")
  printf '%q\n' "${a[@]}"
}

prun 0.162.0 --build-oci "$oci" --builder owner-builder --dry-run
check "--build-oci: both platforms through the named builder, into <dir>/collector-<v>.oci.tar" \
  "[ $rc -eq 0 ] && has 'would build ghcr.io/telflo/telflo/collector:0.162.0 for linux/amd64,linux/arm64 through builder owner-builder into $oci/collector-0.162.0.oci.tar'"
check "a --build-oci dry run prints the exact command (both platforms, labels, attestations with the pinned SBOM generator, the OCI archive, HEAD's extracted context)" \
  "[ \"\$(printf '%s\n' \"\$argv_out\" | normalise_tmp)\" = \"\$(expected_oci_argv '$repo_revision' '$oci')\" ] && printf '%s\n' \"\$argv_out\" | tail -n 1 | grep -qE \"\$oci_context_re\""
check "a --build-oci dry run asks the registry (crane digest) for the tag, builds nothing" \
  "grep -qx 'digest ghcr.io/telflo/telflo/collector:0.162.0 ' '$logs/crane-calls.log' && has 'is not in the registry yet' && no_build && ! printf '%s\n' \"\$argv_out\" | grep -qE -- '^--(tag|load|push)\$'"
check "the caller's DOCKER_CONFIG used as given (crane read it)" "grep -qx '$tmp/docker' '$logs/crane-config.log'"
dry_oci="$argv_out"
prun 0.162.0 --build-oci "$oci" --builder owner-builder
check "--build-oci runs exactly the printed command" \
  "[ $rc -eq 0 ] && same_oci \"\$(cat '$logs/build-argv')\" \"\$dry_oci\""
check "--build-oci writes collector-<v>.oci.tar and collector-<v>.digest (one line, the archive's index digest), no .partial" \
  "[ -f '$oci/collector-0.162.0.oci.tar' ] && [ ! -e '$oci/collector-0.162.0.oci.tar.partial' ] && grep -qxE 'sha256:[0-9a-f]{64}' '$oci/collector-0.162.0.digest' && tar -xOf '$oci/collector-0.162.0.oci.tar' index.json | grep -qF \"\$(cat '$oci/collector-0.162.0.digest')\" && has \"collector-0.162.0 \$(cat '$oci/collector-0.162.0.digest')\""
check "the extracted context is removed afterwards" "[ -z \"\$(ls -A '$tmp/scratch')\" ]"
prun 0.162.0 --build-oci "$oci" --builder owner-builder
check "an existing archive refused before anything builds (never overwritten)" \
  "[ $rc -eq 1 ] && has 'collector-0.162.0.oci.tar exists: --build-oci never overwrites' && no_build"
oci_b="$tmp/oci-b"; mkdir -p "$oci_b"
prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
dry_oci_b="$argv_out"
prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --no-attest --dry-run
check "--no-attest: --provenance=false and no --attest" \
  "[ $rc -eq 0 ] && [ \"\$(printf '%s\n' \"\$argv_out\" | normalise_tmp)\" = \"\$(expected_oci_argv '$repo_revision' '$oci_b' no-attest)\" ]"
STANDIN_BUILD_EXIT=3 prun 0.162.0 --build-oci "$oci_b" --builder owner-builder
check "a failed build leaves no archive and no digest file" "[ $rc -eq 1 ] && has 'no archive written' && [ -z \"\$(ls -A '$oci_b')\" ]"
STANDIN_BUILDX=v0.8.2 prun 0.162.0 --build-oci "$oci_b" --builder owner-builder
check "a buildx too old to attest refused" "[ $rc -eq 1 ] && has \"can't attest\" && no_build"
STANDIN_DRIVER=docker prun 0.162.0 --build-oci "$oci_b" --builder desktop-linux
check "--build-oci refuses a docker-driver builder" "[ $rc -eq 1 ] && has \"uses the 'docker' driver\" && no_build"

# --build-oci builds from the commit itself: files the repository ignores
# never reach the build context.
mkdir -p "$repo/docker/collector-image/build"
echo "IGNORED=c4n4ry" >"$repo/docker/collector-image/.env"
echo ignored >"$repo/docker/collector-image/.DS_Store"
echo ignored >"$repo/docker/collector-image/build/x"
head_files="$(git -C "$repo" ls-tree -r --name-only HEAD docker/collector-image | sed 's#^docker/collector-image/##' | sort)"
oci_c="$tmp/oci-c"; mkdir -p "$oci_c"
prun 0.162.0 --build-oci "$oci_c" --builder owner-builder
check "--build-oci's build context is HEAD's docker/collector-image: ignored .env, .DS_Store, build/x left out" \
  "[ $rc -eq 0 ] && [ -z \"\$(git -C '$repo' status --porcelain)\" ] && [ -n \"\$head_files\" ] && [ \"\$(cat '$logs/build-context-files')\" = \"\$head_files\" ] && ! grep -qE '^(\.env|\.DS_Store|build/x)\$' '$logs/build-context-files'"
rm -rf "$repo/docker/collector-image/build" "$repo/docker/collector-image/.env" "$repo/docker/collector-image/.DS_Store"

clear_logs
mkdir -p "$tmp/oci-d"
out="$(env -u DOCKER_CONFIG -u TELFLO_COLLECTOR_IMAGE_REPOSITORY -u TELFLO_COLLECTOR_CATALOGUE TMPDIR="$tmp/scratch" "$shell" "$repo_script" 0.162.0 --build-oci "$tmp/oci-d" --builder owner-builder 2>&1)"; rc=$?
check "DOCKER_CONFIG unset: --build-oci builds with a temporary one holding no login, removed afterwards" \
  "[ $rc -eq 0 ] && has 'DOCKER_CONFIG is unset' && [ \"\$(sed -n 2p '$logs/build-env')\" = '{\"auths\":{\"telflo-publish.invalid\":{}}}' ] && [ -z \"\$(ls -A '$tmp/scratch')\" ]"

# The registry's answers (crane digest).
STANDIN_CRANE=present prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "a tag the registry holds refused (dry run)" "[ $rc -eq 1 ] && has 'exists in the registry' && [ -z \"\$argv_out\" ]"
STANDIN_CRANE=denied prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "any other answer: the dry run says it can't tell (crane's error line), prints the command" \
  "[ $rc -eq 0 ] && has \"can't tell whether ghcr.io/telflo/telflo/collector:0.162.0 exists\" && has 'DENIED' && ! has 'No matching credentials' && [ -n \"\$argv_out\" ]"
STANDIN_CRANE=name-unknown prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run --registry 127.0.0.1:5999
check "NAME_UNKNOWN is absent; --registry names <registry>/telflo/telflo/collector" \
  "[ $rc -eq 0 ] && grep -qx 'digest 127.0.0.1:5999/telflo/telflo/collector:0.162.0 ' '$logs/crane-calls.log' && has 'is not in the registry yet'"

# Only ghcr.io/telflo/telflo/collector.
repo_case() { # <name> <repository> <mode args...>
  local name="$1" repository="$2"; shift 2
  clear_logs
  out="$(env DOCKER_CONFIG="$tmp/docker" TMPDIR="$tmp/scratch" TELFLO_COLLECTOR_IMAGE_REPOSITORY="$repository" "$shell" "$repo_script" 0.162.0 "$@" 2>&1)"; rc=$?
  check "$name" "[ $rc -eq 1 ] && [ ! -s '$logs/docker-calls.log' ] && no_crane"
}
repo_case "the older ghcr.io/telflo/collector refused with --build-oci, before docker or crane is asked anything" ghcr.io/telflo/collector --build-oci "$oci_b" --builder owner-builder --dry-run
check "  (named as an older registry path)" "has \"an older registry path that isn't this repository's\""
repo_case "the older ghcr.io/telflo/collector refused with --push-oci" ghcr.io/telflo/collector --push-oci "$oci"
repo_case "the old ghcr.io/telflo/platform/collector refused with --push-oci" ghcr.io/telflo/platform/collector --push-oci "$oci"
check "  (only ghcr.io/telflo/telflo/collector)" "has 'publishes only to ghcr.io/telflo/telflo/collector'"
repo_case "any other repository refused with --build-oci" registry.example:5000/mirror/collector --build-oci "$oci_b" --builder owner-builder
clear_logs
out="$(env DOCKER_CONFIG="$tmp/docker" TELFLO_COLLECTOR_IMAGE_REPOSITORY=ghcr.io/telflo/collector "$shell" "$repo_script" 0.162.0 --platform linux/arm64 --dry-run 2>&1)"; rc=$?
check "the older ghcr.io/telflo/collector still allowed for a local build" "[ $rc -eq 0 ] && has 'would build ghcr.io/telflo/collector:0.162.0'"
clear_logs
out="$(env DOCKER_CONFIG="$tmp/docker" TELFLO_COLLECTOR_CATALOGUE="$catalogue" "$shell" "$repo_script" 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run 2>&1)"; rc=$?
check "--build-oci refuses a catalog other than the repository's" \
  "[ $rc -eq 1 ] && has \"reads only the repository's catalogue\" && [ ! -s '$logs/docker-calls.log' ]"

# --push-oci refuses a --no-attest archive for ghcr.io, offline:
# before any registry call.
oci_na="$tmp/oci-na"; mkdir -p "$oci_na"
tr_fixture "$oci_na/collector-0.162.0.oci.tar" 0.162.0 "$repo_revision" NA no-attest >"$oci_na/collector-0.162.0.digest"
prun 0.162.0 --push-oci "$oci_na"
check "a --no-attest archive refused for ghcr.io, before any registry call" \
  "[ $rc -eq 1 ] && has 'has no attestation manifest' && has 'nothing pushed' && no_crane"

# --push-oci: the archive --build-oci wrote, copied with the real crane.
push_ok=false
if tr_tools "$root" && [ -n "$real_crane" ]; then
  if tr_registry_start "$tmp/registry"; then push_ok=true; else TR_SKIP="the throwaway registry didn't start"; fi
fi
if $push_ok; then
  REG="$TR_REGISTRY"
  ppush() { STANDIN_CRANE='' TEST_DOCKER_CONFIG="$TR_CONFIG" prun 0.162.0 --push-oci "$@"; }
  remote() { DOCKER_CONFIG="$TR_CONFIG" "$real_crane" digest "$REG/telflo/telflo/collector:0.162.0" 2>/dev/null; }
  want="$(cat "$oci/collector-0.162.0.digest")"
  ppush "$oci" --registry "$REG"
  check "--push-oci copies the archive: the remote digest after the copy equals the digest file (real crane, $REG)" \
    "[ $rc -eq 0 ] && [ \"\$(remote)\" = '$want' ] && printf '%s\n' \"\$argv_out\" | grep -qx '$REG/telflo/telflo/collector:0.162.0@$want' && grep -qE '^push [^ ]+/layout $REG/telflo/telflo/collector:0\.162\.0 \$' '$logs/crane-calls.log' && ! grep -q -- '--index' '$logs/crane-calls.log'"
  ppush "$oci" --registry "$REG"
  check "a re-run skips the tag holding the archive's digest, nothing pushed" "[ $rc -eq 0 ] && has 'already: skipped' && nothing_pushed"
  oci_na2="$tmp/oci-na2"; mkdir -p "$oci_na2"
  tr_fixture "$oci_na2/collector-0.161.0.oci.tar" 0.161.0 "$repo_revision" NA no-attest >"$oci_na2/collector-0.161.0.digest"
  STANDIN_CRANE='' TEST_DOCKER_CONFIG="$TR_CONFIG" prun 0.161.0 --push-oci "$oci_na2" --registry "$REG"
  check "a --no-attest archive accepted for a loopback registry (the rehearsal's)" \
    "[ $rc -eq 0 ] && [ \"\$(DOCKER_CONFIG='$TR_CONFIG' '$real_crane' digest '$REG/telflo/telflo/collector:0.161.0' 2>/dev/null)\" = \"\$(cat '$oci_na2/collector-0.161.0.digest')\" ]"
  oci_e="$tmp/oci-e"; mkdir -p "$oci_e"
  tr_fixture "$oci_e/collector-0.162.0.oci.tar" 0.162.0 "$repo_revision" B >"$oci_e/collector-0.162.0.digest"
  ppush "$oci_e" --registry "$REG"
  check "--push-oci refuses a tag present with another digest: nothing copied, the tag unchanged" \
    "[ $rc -eq 1 ] && has 'not the archive' && has 'nothing pushed' && nothing_pushed && [ \"\$(remote)\" = '$want' ]"
  oci_f="$tmp/oci-f"; mkdir -p "$oci_f"
  tr_fixture "$oci_f/collector-0.162.0.oci.tar" 0.161.0 "$repo_revision" A >"$oci_f/collector-0.162.0.digest"
  ppush "$oci_f" --registry "$REG"
  check "an archive of another collector version refused (its labels), nothing pushed" "[ $rc -eq 1 ] && has \"version label isn't 0.162.0\" && nothing_pushed"
  ppush "$tmp/oci-b" --registry "$REG"
  check "a missing archive refused" "[ $rc -eq 1 ] && has 'collector-0.162.0.oci.tar is missing' && no_crane"
  if [ "$TR_AUTH" = 1 ]; then
    check "no file of the test's work folder or output holds the registry's test credential (boolean)" \
      "! tr_secret_in '$tmp/scratch' '$tmp/logs' '$tmp/stderr' '$oci' '$oci_e' '$repo'"
  else
    skip "the credential search" "no htpasswd: the throwaway registry has no login"
  fi
else
  for c in "the copy and its remote digest" "the skip of an equal tag" "the refusal of another digest" "the archive checks"; do
    skip "--push-oci: $c" "${TR_SKIP:-no crane}"
  done
fi
tr_registry_stop

# A git checkout of this repository itself.
plain="$tmp/plain"
mkdir -p "$plain/scripts/release" "$plain/catalog/distributions" "$plain/docker"
cp "$script" "$plain/scripts/build-collector-image.sh"
cp "$root/scripts/release/oci.sh" "$root/scripts/release/tools.sh" "$root/scripts/release/tools.lock" "$plain/scripts/release/"
cp "$catalogue" "$plain/catalog/distributions/otelcol-contrib.json"
cp -R "$here" "$plain/docker/collector-image"
run_in "$plain/scripts/build-collector-image.sh" 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci refuses a tree that isn't a git checkout" \
  "[ $rc -eq 1 ] && has '--build-oci needs a git checkout' && has \"the image's revision label is its HEAD\" && [ ! -s '$logs/docker-calls.log' ] && no_crane"
parent="$tmp/parent"
mkdir -p "$parent"
printf 'nested/\n' >"$parent/.gitignore"
git -C "$parent" -c user.name=telflo-test -c user.email=test@telflo.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null init -q >/dev/null 2>&1
git -C "$parent" add -A >/dev/null 2>&1
git -C "$parent" -c user.name=telflo-test -c user.email=test@telflo.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m parent >/dev/null 2>&1
cp -R "$plain" "$parent/nested"
run_in "$parent/nested/scripts/build-collector-image.sh" 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci refuses a copy nested in another repository that ignores it" \
  "[ -z \"\$(git -C '$parent' status --porcelain)\" ] && [ $rc -eq 1 ] && has '--build-oci needs a git checkout of this repository' && [ ! -s '$logs/docker-calls.log' ] && no_crane"

# A DOCKER_CONFIG the caller set: checked before docker is asked anything,
# its content never printed. The valid shape names a registry in a
# non-empty "auths"; Docker reads keys case-insensitively.
config_case() { # <name> <config.json content, "-" for none, "-unreadable" for mode 000> <expected words>
  local dir="$tmp/caller-config-$RANDOM$RANDOM"
  mkdir -p "$dir"
  case "$2" in
    -) ;;
    -unreadable) printf '%s\n' '{"auths":{"x.invalid":{}}}' >"$dir/config.json"; chmod 000 "$dir/config.json" ;;
    *) printf '%s\n' "$2" >"$dir/config.json" ;;
  esac
  TEST_DOCKER_CONFIG="$dir" prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
  check "$1" "[ $rc -eq 1 ] && has 'DOCKER_CONFIG: its file' && has \"$3\" && ! has 'c4n4ry' && [ ! -s '$logs/docker-calls.log' ] && no_crane"
  chmod 600 "$dir/config.json" 2>/dev/null
}
config_case "a caller's DOCKER_CONFIG without config.json refused" - "is missing"
config_case "a caller's config.json that can't be read refused" -unreadable "can't be read"
config_case "a caller's config.json that isn't JSON refused" 'c4n4ry {' "isn't JSON"
config_case "a caller's config.json without an auths object refused" '{"c4n4ry":{}}' 'has no \"auths\" object'
config_case "a caller's config.json that isn't an object refused" '[1]' 'has no \"auths\" object'
config_case "a caller's config.json with an empty auths refused" '{"auths":{}}' 'has an empty \"auths\" object'
config_case "a caller's config.json with credsStore refused" '{"auths":{"x.invalid":{}},"credsStore":"c4n4ry"}' "names a credential store or helper"
config_case "a caller's config.json with credHelpers refused" '{"auths":{"x.invalid":{}},"credHelpers":{"ghcr.io":"c4n4ry"}}' "names a credential store or helper"
config_case "a caller's config.json with CredsStore refused (any spelling)" '{"auths":{"x.invalid":{}},"CredsStore":"c4n4ry"}' "names a credential store or helper"
config_case "a caller's config.json with credsstore refused (any spelling)" '{"auths":{"x.invalid":{}},"credsstore":"c4n4ry"}' "names a credential store or helper"
config_case "a caller's config.json with CredHelpers refused (any spelling)" '{"auths":{"x.invalid":{}},"CredHelpers":{"ghcr.io":"c4n4ry"}}' "names a credential store or helper"
config_case "a caller's config.json with an AUTHS key refused" '{"auths":{"x.invalid":{}},"AUTHS":{"c4n4ry.invalid":{}}}' 'spelled like \"auths\"'

# --build-oci builds from HEAD's raw blobs, whatever the local git setup (Ruling
# 36): a copy of the throwaway repository with a local smudge filter on every
# file and core.autocrlf=true, which change what `git archive` writes.
frepo="$tmp/frepo"
cp -R "$repo" "$frepo"
printf '* filter=telflotest\n' >"$frepo/.git/info/attributes"
git -C "$frepo" config filter.telflotest.smudge 'cat; echo "# SMUDGED"'
git -C "$frepo" config core.autocrlf true
blob_of() { git -C "$frepo" cat-file blob "HEAD:$1"; }
check "the local setup changes git archive's output (this test's premise)" \
  "! git -C '$frepo' archive HEAD docker/collector-image/entrypoint.sh | tar -xOf - | cmp -s - <(blob_of docker/collector-image/entrypoint.sh)"
run_in "$frepo/scripts/build-collector-image.sh" 0.162.0 --build-oci "$(fresh_oci)" --builder owner-builder
context_equals_head() {
  local f n=0
  while IFS= read -r f; do
    cmp -s "$logs/build-context/${f#docker/collector-image/}" <(blob_of "$f") || return 1
    n=$((n + 1))
  done <<<"$(git -C "$frepo" ls-tree -r --name-only HEAD docker/collector-image)"
  [ "$n" -gt 3 ]
}
check "--build-oci's build context holds HEAD's raw blobs, byte for byte (no smudge, no CRLF)" \
  "[ -z \"\$(git -C '$frepo' status --porcelain)\" ] && [ $rc -eq 0 ] && context_equals_head"
check "the executable mode kept (entrypoint.sh)" "[ -x '$logs/build-context/entrypoint.sh' ] && [ ! -x '$logs/build-context/Dockerfile' ]"
GIT_DIR="$tmp/nonexistent" GIT_INDEX_FILE="$tmp/nonexistent-index" prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "inherited GIT_* settings are ignored" "[ $rc -eq 0 ] && same_oci \"\$argv_out\" \"\$dry_oci_b\""
srepo="$tmp/srepo"
cp -R "$repo" "$srepo"
ln -s Dockerfile "$srepo/docker/collector-image/Dockerfile-link"
git -C "$srepo" add -A >/dev/null 2>&1
git -C "$srepo" -c user.name=telflo-test -c user.email=test@telflo.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m link >/dev/null 2>&1
run_in "$srepo/scripts/build-collector-image.sh" 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci refuses a symlink in HEAD's docker/collector-image, naming it" \
  "[ -z \"\$(git -C '$srepo' status --porcelain)\" ] && [ $rc -eq 1 ] && has \"HEAD's docker/collector-image/Dockerfile-link is a symlink\" && no_build && no_imagetools"

# Local `git replace` objects: the published bytes are HEAD's real blobs,
# every file checked against its tree entry.
rrepo="$tmp/rrepo"
cp -R "$repo" "$rrepo"
real_blob="$(git -C "$rrepo" rev-parse HEAD:docker/collector-image/entrypoint.sh)"
fake_blob="$(printf '#!/bin/sh\necho replaced\n' | git -C "$rrepo" hash-object -w --stdin)"
git -C "$rrepo" replace "$real_blob" "$fake_blob"
check "a replace ref changes what git cat-file gives (this test's premise)" \
  "git -C '$rrepo' cat-file blob HEAD:docker/collector-image/entrypoint.sh | grep -q '^echo replaced'"
run_in "$rrepo/scripts/build-collector-image.sh" 0.162.0 --build-oci "$(fresh_oci)" --builder owner-builder
check "--build-oci's context holds HEAD's real entrypoint.sh, not the replacement" \
  "[ -z \"\$(git -C '$rrepo' status --porcelain)\" ] && [ $rc -eq 0 ] && cmp -s '$logs/build-context/entrypoint.sh' <(GIT_NO_REPLACE_OBJECTS=1 git -C '$rrepo' cat-file blob '$real_blob') && ! grep -q replaced '$logs/build-context/entrypoint.sh'"

# A tampered object store: entrypoint.sh's loose object overwritten with the
# Dockerfile's. git cat-file hands over the other blob's bytes and git status
# stays clean; only the hash check sees it.
trepo="$tmp/trepo"
cp -R "$repo" "$trepo"
loose_object() { # <repo> <sha>
  printf '%s/.git/objects/%s/%s' "$1" "$(printf '%s' "$2" | cut -c1-2)" "$(printf '%s' "$2" | cut -c3-)"
}
victim="$(loose_object "$trepo" "$(git -C "$trepo" rev-parse HEAD:docker/collector-image/entrypoint.sh)")"
donor="$(loose_object "$trepo" "$(git -C "$trepo" rev-parse HEAD:docker/collector-image/Dockerfile)")"
[ -f "$victim" ] && [ -f "$donor" ] && chmod u+w "$victim" && cp "$donor" "$victim"
check "an overwritten loose object changes what git cat-file gives, status clean (this test's premise)" \
  "[ -z \"\$(git -C '$trepo' status --porcelain)\" ] && git -C '$trepo' cat-file blob HEAD:docker/collector-image/entrypoint.sh | cmp -s - '$trepo/docker/collector-image/Dockerfile'"
run_in "$trepo/scripts/build-collector-image.sh" 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci refuses a tampered loose blob by the hash check, naming it, docker never asked" \
  "[ $rc -eq 1 ] && has \"HEAD's docker/collector-image/entrypoint.sh doesn't hash to its tree entry\" && [ ! -s '$logs/docker-calls.log' ] && no_crane"

# An untracked input hidden by status.showUntrackedFiles=no.
urepo="$tmp/urepo"
cp -R "$repo" "$urepo"
git -C "$urepo" config status.showUntrackedFiles no
echo new >"$urepo/docker/collector-image/hidden.txt"
run_in "$urepo/scripts/build-collector-image.sh" 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci refuses an untracked input even with status.showUntrackedFiles=no" \
  "[ -z \"\$(git -C '$urepo' status --porcelain)\" ] && [ $rc -eq 1 ] && has 'refuses uncommitted changes' && has 'docker/collector-image/hidden.txt' && [ ! -s '$logs/docker-calls.log' ] && no_crane"

# A committed submodule (a gitlink) in the image's inputs.
grepo="$tmp/grepo"
cp -R "$repo" "$grepo"
mkdir -p "$grepo/docker/collector-image/sub"
git -C "$grepo" update-index --add --cacheinfo "160000,$(git -C "$grepo" rev-parse HEAD),docker/collector-image/sub"
git -C "$grepo" -c user.name=telflo-test -c user.email=test@telflo.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m gitlink >/dev/null 2>&1
run_in "$grepo/scripts/build-collector-image.sh" 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci refuses a submodule in HEAD's docker/collector-image, naming it, docker never asked" \
  "[ -z \"\$(git -C '$grepo' status --porcelain)\" ] && [ $rc -eq 1 ] && has \"HEAD's docker/collector-image/sub is a submodule\" && [ ! -s '$logs/docker-calls.log' ] && no_crane"

# Inputs flagged for git not to check: refused, the flag named.
cp "$repo/docker/collector-image/Dockerfile" "$tmp/saved-dockerfile"
git -C "$repo" update-index --assume-unchanged docker/collector-image/Dockerfile
echo "# a hidden change" >>"$repo/docker/collector-image/Dockerfile"
prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci refuses an input flagged assume-unchanged, naming the flag" \
  "[ $rc -eq 1 ] && has 'assume-unchanged: docker/collector-image/Dockerfile' && [ ! -s '$logs/docker-calls.log' ] && no_crane"
cp "$tmp/saved-dockerfile" "$repo/docker/collector-image/Dockerfile"
git -C "$repo" update-index --no-assume-unchanged docker/collector-image/Dockerfile
git -C "$repo" update-index --skip-worktree catalog/distributions/otelcol-contrib.json
prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci refuses an input flagged skip-worktree, naming the flag" \
  "[ $rc -eq 1 ] && has 'skip-worktree: catalog/distributions/otelcol-contrib.json' && [ ! -s '$logs/docker-calls.log' ] && no_crane"
git -C "$repo" update-index --no-skip-worktree catalog/distributions/otelcol-contrib.json
check "the throwaway repository is clean again (no flag)" "[ -z \"\$(git -C '$repo' status --porcelain)\" ] && ! git -C '$repo' ls-files -v | grep -q '^[a-zS]'"

# --build-oci takes its build arguments from HEAD's catalog. A
# working-tree catalog that differs from HEAD's while git status sees it
# clean (the same size, mtime and inode; ctime ignored) must not be read.
cat_path="$repo/catalog/distributions/otelcol-contrib.json"
cp "$cat_path" "$tmp/saved-catalogue"
head_sha="$(python3 -I -c 'import json,sys; e=next(v for v in json.load(open(sys.argv[1]))["versions"] if v["version"]=="0.162.0"); print(e["otelcolContrib"]["linux_amd64"]["sha256"])' "$cat_path")"
other_sha="$(printf '%s' "$head_sha" | tr '0-9a-f' '1-9a-f0')"
touch -t 202001010000 "$cat_path"
git -C "$repo" config core.trustctime false
git -C "$repo" update-index --refresh >/dev/null 2>&1
same_size_rewrite() { # <file> <from> <to>: in place, the same size and inode, the old mtime
  python3 -I -c '
import sys
path, old, new = sys.argv[1:4]
with open(path, "r+", encoding="utf-8") as handle:
    text = handle.read()
    assert len(old) == len(new) and old in text
    handle.seek(0); handle.write(text.replace(old, new)); handle.truncate()
' "$@"
  touch -t 202001010000 "$1"
}
same_size_rewrite "$cat_path" "$head_sha" "$other_sha"
prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "--build-oci's build arguments come from HEAD's catalog, not the working tree's" \
  "[ -z \"\$(git -C '$repo' status --porcelain)\" ] && grep -qF '$other_sha' '$cat_path' && [ $rc -eq 0 ] && printf '%s\n' \"\$argv_out\" | grep -qx 'OTELCOL_SHA256_AMD64=$head_sha' && ! printf '%s\n' \"\$argv_out\" | grep -qF '$other_sha'"
same_size_rewrite "$cat_path" "$other_sha" "$head_sha"
git -C "$repo" config --unset core.trustctime
check "the catalog is HEAD's again" "cmp -s '$cat_path' '$tmp/saved-catalogue' && [ -z \"\$(git -C '$repo' status --porcelain)\" ]"

# The image's inputs must be committed.
dirty_case() { # <name> <path relative to the repo> <append|new>
  local name="$1" path="$2" how="$3"
  if [ "$how" = append ]; then cp "$repo/$path" "$tmp/saved"; echo "# a change" >>"$repo/$path"; else echo new >"$repo/$path"; fi
  prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
  check "$name" "[ $rc -eq 1 ] && has 'refuses uncommitted changes' && has '$path' && [ ! -s '$logs/docker-calls.log' ] && no_crane"
  if [ "$how" = append ]; then cp "$tmp/saved" "$repo/$path"; else rm -f "$repo/$path"; fi
}
dirty_case "--build-oci refuses a changed Dockerfile" docker/collector-image/Dockerfile append
dirty_case "--build-oci refuses a new file in docker/collector-image" docker/collector-image/extra.txt new
dirty_case "--build-oci refuses a changed catalog" catalog/distributions/otelcol-contrib.json append
dirty_case "--build-oci refuses a changed build script" scripts/build-collector-image.sh append
echo "# a change" >>"$repo/NOTES.txt"
prun 0.162.0 --build-oci "$oci_b" --builder owner-builder --dry-run
check "a change outside the image's inputs doesn't stop --build-oci" "[ $rc -eq 0 ] && same_oci \"\$argv_out\" \"\$dry_oci_b\""
echo "# a change" >>"$repo/docker/collector-image/Dockerfile"
prun 0.162.0 --platform linux/arm64 --dry-run
check "a local build with uncommitted inputs is allowed" "[ $rc -eq 0 ] && has 'would build'"

# --- 8. --list-offered ------------------------------------------------------------
run --list-offered
check "--list-offered: the catalog's offered versions, newest first" \
  "[ $rc -eq 0 ] && [ \"\$argv_out\" = \"\$(printf '0.162.0\n0.161.0\n0.160.0\n0.159.0')\" ]"
run --list-offered --dry-run
check "--list-offered with another argument refused" "[ $rc -eq 2 ] && has '--list-offered takes no other argument'"
run 0.162.0 --list-offered
check "--list-offered with a version refused" "[ $rc -eq 2 ]"
list_with() { # <python mutation of `data`>
  python3 -I - "$catalogue" "$tmp/list.json" "$1" <<'PY'
import json, random, sys
data = json.load(open(sys.argv[1]))
exec(sys.argv[3])
json.dump(data, open(sys.argv[2], "w"))
PY
  out="$(DOCKER_CONFIG="$tmp/docker" TELFLO_COLLECTOR_CATALOGUE="$tmp/list.json" "$shell" "$script" --list-offered 2>"$tmp/stderr")"; rc=$?
  argv_out="$out"; out="$(printf '%s\n' "$argv_out"; cat "$tmp/stderr")"
}
synthetic='
e = json.loads(json.dumps(next(v for v in data["versions"] if v["version"] == "0.159.0")))
e = json.loads(json.dumps(e).replace("0.159.0", "0.99.0"))
data["versions"].append(e)
random.Random(7).shuffle(data["versions"])
'
list_with "$synthetic"
check "--list-offered sorts by number (0.162.0 before 0.99.0), deprecated ones skipped" \
  "[ $rc -eq 0 ] && [ \"\$argv_out\" = \"\$(printf '0.162.0\n0.161.0\n0.160.0\n0.159.0\n0.99.0')\" ]"
list_with 'next(v for v in data["versions"] if v["version"] == "0.161.0")["version"] = "0.163"'
check "--list-offered refuses an offered version that isn't x.y.z" "[ $rc -eq 1 ] && has \"isn't x.y.z\" && [ -z \"\$argv_out\" ]"
list_with 'next(v for v in data["versions"] if v["version"] == "0.160.0")["opampSupervisor"]["linux_arm64"]["sha256"] = "x"'
check "--list-offered refuses an offered version with a malformed value" "[ $rc -eq 1 ] && has 'version 0.160.0' && [ -z \"\$argv_out\" ]"
list_with 'data["versions"].append(dict(next(v for v in data["versions"] if v["version"] == "0.158.0")))'
check "--list-offered refuses a version listed twice" "[ $rc -eq 1 ] && has 'more than once'"
list_with 'next(v for v in data["versions"] if v["version"] == "0.161.0")["opampSupervisor"]["linux_arm64"]["sha256"] = "x"; next(v for v in data["versions"] if v["version"] == "0.161.0")["deprecated"] = True'
check "--list-offered ignores a deprecated version's values" "[ $rc -eq 0 ] && [ \"\$argv_out\" = \"\$(printf '0.162.0\n0.160.0\n0.159.0')\" ]"

# --- 9. never a login, never a credential helper ------------------------------------
check "the script never logs in" "! grep -nE '^[^#]*(docker|helm)( [a-z-]+)* login' '$script'"
check "no docker call was a login" "[ -s '$logs/all-docker-calls.log' ] && ! grep -qE '(^| )login( |$)' '$logs/all-docker-calls.log'"
check "no credential helper was called" "[ ! -s '$logs/helper.log' ]"

echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
