#!/bin/bash
# Tests for scripts/publish-platform-images.sh. `docker` is a stand-in first
# on PATH (it records every call, answers `buildx version`, `buildx --builder
# <b> inspect` with the case's driver, and records `buildx --builder <b>
# build`, writing for --build-oci the OCI archive and the metadata file a
# build would, made offline by scripts/release/test-registry.sh's fixture);
# `crane` is a wrapper first on PATH that records every call and answers
# `digest` per case (STANDIN_CRANE) or hands it to the real crane. Refusing
# credential-helper stand-ins come first on PATH too: none may be called. The
# script runs from committed throwaway git repositories holding small
# stand-ins for the images' inputs. --push-oci runs with the real crane
# against a throwaway registry:2 on 127.0.0.1 (tools.lock's image, local by
# digest; a login made at run time when htpasswd is there), or prints SKIP
# lines when crane, docker or that image is missing. Nothing reaches any
# other registry.
# Run:  bash scripts/publish-platform-images.test.sh
# (TELFLO_TEST_REGISTRY_NAME / TELFLO_TEST_REGISTRY_PORT name the registry's
# container and port.) bash 3.2 compatible (macOS's /bin/bash).
set -u
# One spelling of the temporary folder (no trailing slash, no //), and no CI:
# the test sets CI itself where a case needs it.
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI
# Hermetic: a caller's tools folder or git setting never changes what these cases test.
unset TELFLO_TOOLS_DIR TELFLO_TOOLS_LOCK TELFLO_TOOLS_PLATFORM GIT_NO_REPLACE_OBJECTS
root="$(cd "$(dirname "$0")/.." && pwd)"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
check() { # <name> <shell-expr that must succeed>
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/publish-platform-images-test.XXXXXX")" || exit 1
cleanup() { tr_registry_stop; rm -rf "$tmp"; }
trap cleanup EXIT

bin="$tmp/bin"; logs="$tmp/logs"
mkdir -p "$bin" "$logs" "$tmp/docker" "$tmp/t" "$tmp/stub"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/docker/config.json"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/stub/config.json"
TR_DOCKER_CONFIG="$tmp/stub"
for helper in osxkeychain desktop ecr-login; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$logs" >"$bin/docker-credential-$helper"
  chmod +x "$bin/docker-credential-$helper"
done
real_docker="$(command -v docker 2>/dev/null || true)"
TR_DOCKER="${real_docker:-docker}"
real_crane="$("$shell" "$root/scripts/release/tools.sh" path crane 2>/dev/null || command -v crane 2>/dev/null || true)"
printf '#!/bin/bash\nlog="%s"\nroot="%s"\n' "$logs" "$root" >"$bin/docker"
cat >>"$bin/docker" <<'EOF'
# The test's docker stand-in: records every call; never builds, never pushes.
{ printf '%q ' "$@"; echo; } >>"$log/docker-calls.log"
{ printf '%q ' "$@"; echo; } >>"$log/all-docker-calls.log"
printf '%s\n' "${DOCKER_CONFIG:-unset}" >>"$log/docker-config.log"
case "$1 ${2:-}" in
  "buildx version") echo "github.com/docker/buildx ${STANDIN_BUILDX:-v0.38.1} 0000000"; exit 0 ;;
esac
case "$1 ${2:-} ${3:-}" in
  "buildx --builder "*)
    if [ "${4:-}" = inspect ]; then
      [ -n "${STANDIN_NO_BUILDER:-}" ] && { echo "ERROR: no builder \"$3\" found" >&2; exit 1; }
      printf 'Name:   %s\nDriver: %s\n' "$3" "${STANDIN_DRIVER:-docker-container}"
      exit 0
    fi
    if [ "${4:-}" = build ]; then
      prev=""; meta=""; file=""; context=""; output=""; version=""; revision=""
      for a in "$@"; do
        case "$prev" in
          --metadata-file) meta="$a" ;;
          --file) file="$a" ;;
          --output) output="$a" ;;
          --build-arg) case "$a" in VERSION=*) version="${a#VERSION=}" ;; REVISION=*) revision="${a#REVISION=}" ;; esac ;;
        esac
        prev="$a"; context="$a"
      done
      { printf '%q ' "$@"; echo; } >>"$log/builds.log"
      { [ -f "$file" ] && echo "dockerfile ok" || echo "dockerfile missing"; } >>"$log/contexts.log"
      (cd "$context" && find . -type f | LC_ALL=C sort) >>"$log/contexts.log"
      if [ -n "${STANDIN_KEEP_CONTEXT:-}" ]; then
        rm -rf "$log/context-copy"; cp -R "$context" "$log/context-copy"
      fi
      for f in ${STANDIN_FAIL_BUILD:-}; do
        case "$file" in *"/$f/Dockerfile") exit 3 ;; esac
        p=""; for t in "$@"; do [ "$p" = --target ] && [ "$t" = "$f" ] && exit 3; p="$t"; done
      done
      case "$output" in
        type=oci,dest=*)
          dest="${output#type=oci,dest=}"
          . "$root/scripts/release/test-registry.sh"
          attest=""; case " $* " in *" --provenance=false "*) attest=no-attest ;; esac
          digest="$(tr_fixture "$dest" "${STANDIN_LABEL_VERSION:-$version}" "$revision" "${STANDIN_VARIANT:-A}" $attest)" || exit 4
          [ -z "${STANDIN_OTHER_DIGEST:-}" ] || digest="sha256:3333333333333333333333333333333333333333333333333333333333333333"
          [ -n "$meta" ] && printf '{"containerimage.digest":"%s"}\n' "$digest" >"$meta" ;;
      esac
      exit 0
    fi ;;
esac
echo "UNEXPECTED $*" >>"$log/docker-calls.log"
echo "UNEXPECTED $*" >>"$log/all-docker-calls.log"
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

gitc() { git -c user.name=telflo-test -c user.email=test@telflo.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

# The throwaway repository: the script and its release helpers, small
# stand-ins for each image's inputs, the chart's Chart.yaml (appVersion
# 1.2.3) and an unrelated file, committed. A git-ignored file sits in the
# working tree.
make_repo() { # <dir> [no-chart]
  local repo="$1"
  mkdir -p "$repo/scripts/release" "$repo/telflo-core/apps/web" "$repo/catalog/distributions" "$repo/install-templates" \
    "$repo/services/otelcol-validator/scripts" "$repo/services/otelcol-validator/app" "$repo/services/otelcol-testing/app" \
    "$repo/services/ottl-evaluator/cmd" "$repo/charts/telflo" "$repo/docs"
  cp "$root/scripts/publish-platform-images.sh" "$repo/scripts/"
  cp "$root/scripts/release/oci.sh" "$root/scripts/release/tools.sh" "$root/scripts/release/tools.lock" "$repo/scripts/release/"
  printf '*\n!telflo-core/\n' >"$repo/.dockerignore"
  printf 'FROM scratch\n' >"$repo/telflo-core/Dockerfile"
  printf '{}\n' >"$repo/telflo-core/package.json"
  printf 'export {};\n' >"$repo/telflo-core/apps/web/server.mjs"
  printf '{}\n' >"$repo/catalog/distributions/otelcol-contrib.json"
  printf 'a\n' >"$repo/install-templates/docker.sh.tmpl"
  printf 'FROM scratch\n' >"$repo/services/otelcol-validator/Dockerfile"
  printf 'print(1)\n' >"$repo/services/otelcol-validator/scripts/download-binaries.py"
  printf 'x = 1\n' >"$repo/services/otelcol-validator/app/main.py"
  printf 'FROM scratch\n' >"$repo/services/otelcol-testing/Dockerfile"
  printf 'x = 1\n' >"$repo/services/otelcol-testing/app/main.py"
  printf 'FROM scratch\n' >"$repo/services/ottl-evaluator/Dockerfile"
  printf 'bin/\n' >"$repo/services/ottl-evaluator/.dockerignore"
  printf 'package main\n' >"$repo/services/ottl-evaluator/cmd/main.go"
  chmod 755 "$repo/services/otelcol-validator/scripts/download-binaries.py"
  printf 'notes\n' >"$repo/docs/notes.md"
  printf '*.local\n.tools/\n' >"$repo/.gitignore"
  if [ "${2:-}" != no-chart ]; then
    printf 'apiVersion: v2\nname: telflo\nversion: 1.2.3\nappVersion: "1.2.3"\n' >"$repo/charts/telflo/Chart.yaml"
  fi
  gitc -C "$repo" init -q >/dev/null 2>&1
  gitc -C "$repo" add -A >/dev/null 2>&1
  gitc -C "$repo" commit -q -m inputs >/dev/null 2>&1
  printf 'ignored-canary\n' >"$repo/telflo-core/secret.local"
}
make_repo "$tmp/repo"
make_repo "$tmp/nochart" no-chart
rev="$(git -C "$tmp/repo" rev-parse HEAD)"
check "the throwaway repositories are committed and clean (the ignored file aside)" \
  "[ -z \"\$(git -C '$tmp/repo' status --porcelain 2>&1)\" ] && [ -n '$rev' ] && [ -z \"\$(git -C '$tmp/nochart' status --porcelain 2>&1)\" ] && [ -f '$tmp/repo/telflo-core/secret.local' ]"

# Each run starts with these logs present and empty: a check reads "nothing
# called" as an empty file, never as a missing one.
reset_logs() { local f; for f in docker-calls builds contexts docker-config crane-calls crane-config; do : >"$logs/$f.log"; done; }
run_in() { # <repo> <args...>: sets rc, out (stdout and stderr) and stdout_only
  local repo="$1"; shift
  reset_logs
  env -u BUILDX_BUILDER TMPDIR="$tmp/t" DOCKER_CONFIG="${TEST_DOCKER_CONFIG:-$tmp/docker}" \
    "$shell" "$repo/scripts/publish-platform-images.sh" "$@" >"$tmp/stdout" 2>"$tmp/stderr"
  rc=$?
  stdout_only="$(cat "$tmp/stdout")"
  out="$(cat "$tmp/stdout" "$tmp/stderr")"
  cat "$tmp/stdout" "$tmp/stderr" >>"$logs/all-output.log"
}
run() { run_in "$tmp/repo" "$@"; }
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
asked() { awk '$1 == "digest" { print $2 }' "$logs/crane-calls.log" 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
nothing_asked() { [ ! -s "$logs/docker-calls.log" ] && [ ! -s "$logs/crane-calls.log" ]; }
nothing_built() { [ ! -s "$logs/builds.log" ]; }
nothing_pushed() { ! grep -qE '^push( |$)' "$logs/crane-calls.log" 2>/dev/null; }
# The temporary directory's random part, for exact comparisons.
normalise() { sed -E 's#publish-platform-images\.[A-Za-z0-9]{6}#TMPDIR#g'; }
R=ghcr.io/telflo/telflo
S="$tmp/t/TMPDIR/source"
SBOM="$("$shell" "$root/scripts/release/tools.sh" ref syft-scanner)"

# The exact argv of an image's build, one argument a line, as the script
# runs it (mode: build, oci or oci-no-attest; platform; the archive folder).
expected_argv() { # <image> <mode> <platform> [<folder>]
  local image="$1" mode="$2" platform="$3" dir="${4:-}"
  printf '%s\n' docker buildx --builder owner-builder build --platform "$platform"
  case "$image" in
    api | web) printf '%s\n' --file "$S/telflo-core/Dockerfile" --target "$image" ;;
    otelcol-validator | otelcol-testing) printf '%s\n' --file "$S/services/$image/Dockerfile" --target runtime --build-arg OTELCOL_VERSIONS=all ;;
    ottl-evaluator) printf '%s\n' --file "$S/services/ottl-evaluator/Dockerfile" ;;
  esac
  printf '%s\n' --build-arg VERSION=1.2.3 --build-arg "REVISION=$rev"
  case "$mode" in
    oci) printf '%s\n' --provenance=mode=max --attest "type=sbom,generator=$SBOM" ;;
    oci-no-attest) printf '%s\n' --provenance=false ;;
  esac
  if [ "$mode" != build ]; then
    printf '%s\n' --output "type=oci,dest=$dir/$image.oci.tar.partial" --metadata-file "$tmp/t/TMPDIR/metadata-$image.json"
  fi
  case "$image" in
    ottl-evaluator) printf '%s\n' "$S/services/ottl-evaluator" ;;
    *) printf '%s\n' "$S" ;;
  esac
}
# The stand-in's record of the same argv (one line, %q-quoted, the first
# word `docker` dropped as the stand-in sees its arguments only).
expected_record() { # <image> <mode> <platform> [<folder>]
  expected_argv "$@" | sed 1d | while IFS= read -r a; do printf '%q ' "$a"; done; echo
}
expected_printed() { # <image> <mode> <platform> [<folder>]: as the script prints it
  expected_argv "$@" | while IFS= read -r a; do printf '%q\n' "$a"; done
}

# --- 1. refusals, before anything runs --------------------------------------------------
run
check "no mode refused" "[ $rc -eq 2 ] && has 'a mode is required' && nothing_asked"
run --dry-run --build --builder b
check "two modes refused" "[ $rc -eq 2 ] && has 'one mode' && nothing_asked"
run --build-oci "$tmp" --push-oci "$tmp"
check "--build-oci with --push-oci refused" "[ $rc -eq 2 ] && has 'one mode' && nothing_asked"
run --push --builder b
check "--push refused as an unknown argument, naming --build-oci and --push-oci" \
  "[ $rc -eq 2 ] && has 'unknown argument: --push' && has '--build-oci <dir>' && has '--push-oci <dir>' && nothing_asked"
run --dry-run --builder b --bogus
check "an unknown argument refused" "[ $rc -eq 2 ] && has 'unknown argument: --bogus' && nothing_asked"
run --dry-run
check "--dry-run without --builder refused" "[ $rc -eq 2 ] && has '--builder <name> is required' && nothing_asked"
run --build --image api
check "--build without --builder refused" "[ $rc -eq 2 ] && has '--builder <name> is required' && nothing_asked"
run --build-oci "$tmp"
check "--build-oci without --builder refused" "[ $rc -eq 2 ] && has '--builder <name> is required' && nothing_asked"
run --push-oci "$tmp" --builder b
check "--push-oci with --builder refused" "[ $rc -eq 2 ] && has '--push-oci builds nothing' && nothing_asked"
run --build-oci
check "--build-oci without a folder refused" "[ $rc -eq 2 ] && has '--build-oci needs a folder' && nothing_asked"
run --build-oci "$tmp/none" --builder b
check "--build-oci with a folder that doesn't exist refused" "[ $rc -eq 2 ] && has 'must be an existing directory' && nothing_asked"
run --push-oci "$tmp/stdout"
check "--push-oci with a file for a folder refused" "[ $rc -eq 2 ] && has 'must be an existing directory' && nothing_asked"
run --dry-run --builder 'bad name'
check "a malformed builder name refused" "[ $rc -eq 2 ] && has \"the builder's name\" && nothing_asked"
run --dry-run --builder b --image collector
check "an unknown image refused" "[ $rc -eq 2 ] && has \"unknown image 'collector'\" && nothing_asked"
run --build --builder b
check "--build without --image refused" "[ $rc -eq 2 ] && has '--build builds one image' && nothing_asked"
run --build --builder b --image api --image web
check "--build with two images refused" "[ $rc -eq 2 ] && has '--build builds one image' && nothing_asked"
run --build-oci "$tmp" --builder b --platform linux/amd64
check "--platform with --build-oci refused" "[ $rc -eq 2 ] && has '--platform goes with --build only' && nothing_asked"
run --build --builder b --image api --platform linux/s390x
check "an unknown platform refused" "[ $rc -eq 2 ] && has '--platform must be' && nothing_asked"
run --dry-run --builder b --no-attest
check "--no-attest without --build-oci refused" "[ $rc -eq 2 ] && has '--no-attest goes with --build-oci only' && nothing_asked"
run --build-oci "$tmp" --builder b --registry 127.0.0.1:5000
check "--registry with --build-oci refused" "[ $rc -eq 2 ] && has '--registry goes with --dry-run and --push-oci only' && nothing_asked"
for bad in docker.io quay.io:443 ghcr.io/telflo/platform ghcr.io/telflo/collector 10.0.0.1:5000 127.0.0.2:5000 localhost 127.0.0.1:0 127.0.0.1:99999 'ghcr.io:443' 'evil.example/ghcr.io'; do
  run --push-oci "$tmp" --registry "$bad"
  check "--registry '$bad' refused (only ghcr.io or a loopback registry), nothing asked" \
    "[ $rc -eq 2 ] && has '--registry must be ghcr.io or a loopback registry' && nothing_asked"
done
run --dry-run --builder b --registry ghcr.io/telflo/platform
check "--dry-run's --registry checked alike" "[ $rc -eq 2 ] && has '--registry must be' && nothing_asked"
run --dry-run --builder b --version v1.2.3
check "a version not x.y.z refused" "[ $rc -eq 2 ] && has 'must be x.y.z' && nothing_asked"
run --dry-run --builder b --version latest
check "the version 'latest' refused" "[ $rc -eq 2 ] && has 'must be x.y.z' && nothing_asked"
run --dry-run --builder b --version
check "--version without a value refused" "[ $rc -eq 2 ] && has '--version needs a value' && nothing_asked"
check "no option names a repository: the script's only repository path is telflo/telflo" \
  "[ \"\$(grep -cE '^REPOSITORY_PATH=\"telflo/telflo\"\$' '$root/scripts/publish-platform-images.sh')\" -eq 1 ] && ! grep -qE 'telflo/platform|ghcr\.io/telflo/collector' '$root/scripts/publish-platform-images.sh'"

# --- 2. --dry-run: checks, asks the registry, prints the builds --------------------------
STANDIN_CRANE=absent run --dry-run --builder owner-builder
expected=""
for i in api web otelcol-validator otelcol-testing ottl-evaluator; do expected="$expected$(expected_printed "$i" oci linux/amd64,linux/arm64 OCI_DIR)
"; done
check "--dry-run asks the registry (crane digest) for every image's tag, in order, before anything" \
  "[ $rc -eq 0 ] && [ \"\$(asked)\" = '$R/api:1.2.3 $R/web:1.2.3 $R/otelcol-validator:1.2.3 $R/otelcol-testing:1.2.3 $R/ottl-evaluator:1.2.3' ] && has '$R/api:1.2.3 is not in the registry yet'"
check "--dry-run prints each image's exact --build-oci build (both platforms, attestations, the archive under OCI_DIR)" \
  "[ \"\$(printf '%s\n' \"\$stdout_only\" | normalise)\" = \"\$(printf '%s' \"\$expected\")\" ]"
check "--dry-run builds nothing, asks no builder, pushes nothing" \
  "nothing_built && [ -f '$logs/docker-calls.log' ] && ! grep -qE '(^| )(build|inspect)( |$)' '$logs/docker-calls.log' && nothing_pushed && has 'dry run: nothing built or pushed'"
check "the SBOM generator is tools.lock's, pinned by digest (never a bare --sbom=true)" \
  "printf '%s' '$SBOM' | grep -qE '^docker/buildkit-syft-scanner@sha256:[0-9a-f]{64}\$' && ! printf '%s\n' \"\$stdout_only\" | grep -q -- '--sbom'"
STANDIN_CRANE=absent run --dry-run --builder owner-builder --image ottl-evaluator --image api --image ottl-evaluator
check "--image repeated: those images only, in the order named, each once" \
  "[ $rc -eq 0 ] && [ \"\$(asked)\" = '$R/ottl-evaluator:1.2.3 $R/api:1.2.3' ] && nothing_built"
STANDIN_CRANE=name-unknown run --dry-run --builder owner-builder --image=web --version 1.2.3
check "--image=<name>, a --version equal to the appVersion; NAME_UNKNOWN is absent" \
  "[ $rc -eq 0 ] && [ \"\$(asked)\" = '$R/web:1.2.3' ] && has '$R/web:1.2.3 is not in the registry yet'"
STANDIN_CRANE=absent run --dry-run --builder owner-builder --image api --registry 127.0.0.1:5999
check "--dry-run --registry 127.0.0.1:<port>: <registry>/telflo/telflo/<name>" "[ $rc -eq 0 ] && [ \"\$(asked)\" = '127.0.0.1:5999/telflo/telflo/api:1.2.3' ]"
STANDIN_CRANE=absent run --dry-run --builder owner-builder --version 1.2.4
check "a --version other than HEAD's appVersion refused" \
  "[ $rc -eq 1 ] && has 'is not HEAD' && nothing_asked"
STANDIN_CRANE=present run --dry-run --builder owner-builder
check "--dry-run refuses a tag the registry holds" \
  "[ $rc -eq 1 ] && has '$R/api:1.2.3 exists in the registry' && nothing_built && [ -z \"\$stdout_only\" ]"
STANDIN_CRANE=denied run --dry-run --builder owner-builder --image api
check "--dry-run says it can't tell (crane's error line only) and goes on" \
  "[ $rc -eq 0 ] && has \"can't tell whether $R/api:1.2.3 exists\" && has 'DENIED' && ! has 'No matching credentials' && nothing_built"

# --- 3. the version without the chart ---------------------------------------------------
STANDIN_CRANE=absent run_in "$tmp/nochart" --dry-run --builder owner-builder --image api
check "no Chart.yaml at HEAD and no --version: refused" "[ $rc -eq 1 ] && has '--version x.y.z is required' && nothing_asked"
STANDIN_CRANE=absent run_in "$tmp/nochart" --dry-run --builder owner-builder --image api --version 2.0.0
check "no Chart.yaml at HEAD: --version is the tag" "[ $rc -eq 0 ] && [ \"\$(asked)\" = '$R/api:2.0.0' ] && has 'VERSION=2.0.0'"
cp -R "$tmp/repo" "$tmp/two-app-versions"
printf 'appVersion: "1.2.4"\n' >>"$tmp/two-app-versions/charts/telflo/Chart.yaml"
gitc -C "$tmp/two-app-versions" commit -q -am two >/dev/null 2>&1
STANDIN_CRANE=absent run_in "$tmp/two-app-versions" --dry-run --builder owner-builder
check "a Chart.yaml with two appVersion lines refused" "[ $rc -eq 1 ] && has 'expected exactly one line' && nothing_asked"
cp -R "$tmp/repo" "$tmp/bad-app-version"
sed -i.bak 's/^appVersion: .*/appVersion: latest/' "$tmp/bad-app-version/charts/telflo/Chart.yaml" && rm -f "$tmp/bad-app-version/charts/telflo/Chart.yaml.bak"
gitc -C "$tmp/bad-app-version" commit -q -am latest >/dev/null 2>&1
STANDIN_CRANE=absent run_in "$tmp/bad-app-version" --dry-run --builder owner-builder
check "an appVersion that isn't x.y.z refused" "[ $rc -eq 1 ] && has \"appVersion must be x.y.z (got 'latest')\" && nothing_asked"

# --- 4. --build: one image, the named builder, no output ------------------------------------
run --build --builder owner-builder --image api
check "--build runs the exact build: amd64 by default, the api target, no tag and no output" \
  "[ $rc -eq 0 ] && [ \"\$(normalise <'$logs/builds.log')\" = \"\$(expected_record api build linux/amd64)\" ]"
check "--build never pushes, loads or names an output, and asks no registry" \
  "! grep -qE -- '--(push|load|output)|(^| )-o ' '$logs/builds.log' && [ ! -s '$logs/crane-calls.log' ]"
check "--build checks the builder first" "head -n 1 '$logs/docker-calls.log' | grep -qF 'buildx --builder owner-builder inspect'"
check "--build's context is HEAD's files only (the ignored file never reaches it), Dockerfile present" \
  "grep -qx 'dockerfile ok' '$logs/contexts.log' && grep -qx './telflo-core/Dockerfile' '$logs/contexts.log' && grep -qx './install-templates/docker.sh.tmpl' '$logs/contexts.log' && ! grep -q 'secret.local' '$logs/contexts.log' && ! grep -q 'docs/notes.md' '$logs/contexts.log' && ! grep -q '\\.git/' '$logs/contexts.log'"
for i in web otelcol-validator otelcol-testing ottl-evaluator; do
  run --build --builder owner-builder --image "$i" --platform linux/amd64
  check "--build --image $i: its exact build" \
    "[ $rc -eq 0 ] && [ \"\$(normalise <'$logs/builds.log')\" = \"\$(expected_record $i build linux/amd64)\" ]"
done
run --build --builder owner-builder --image otelcol-testing
check "the tester's context holds the validator's downloader" \
  "grep -qx './services/otelcol-validator/scripts/download-binaries.py' '$logs/contexts.log' && grep -qx './services/otelcol-testing/app/main.py' '$logs/contexts.log' && ! grep -q 'services/otelcol-validator/app' '$logs/contexts.log'"
run --build --builder owner-builder --image ottl-evaluator
check "the evaluator's context is its own folder (with its .dockerignore)" \
  "grep -qx './.dockerignore' '$logs/contexts.log' && grep -qx './cmd/main.go' '$logs/contexts.log' && ! grep -q 'telflo-core' '$logs/contexts.log'"
run --build --builder owner-builder --image web --platform linux/arm64
check "--build --platform linux/arm64" "[ $rc -eq 0 ] && [ \"\$(normalise <'$logs/builds.log')\" = \"\$(expected_record web build linux/arm64)\" ]"
run --build --builder owner-builder --image web --platform linux/arm64,linux/amd64
check "--build of both platforms" "[ $rc -eq 0 ] && [ \"\$(normalise <'$logs/builds.log')\" = \"\$(expected_record web build linux/amd64,linux/arm64)\" ]"
STANDIN_DRIVER=docker run --build --builder desktop-linux --image api
check "--build refuses a docker-driver builder" "[ $rc -eq 1 ] && has \"uses the 'docker' driver\" && nothing_built"
STANDIN_NO_BUILDER=1 run --build --builder missing --image api
check "--build refuses a builder that doesn't exist (never creates one)" \
  "[ $rc -eq 1 ] && has \"no buildx builder named 'missing'\" && nothing_built && ! grep -qE '(^| )create( |$)' '$logs/docker-calls.log'"

# --- 5. --build-oci: both platforms, attestations, the archive and its digest -------------------
oci="$tmp/oci"; mkdir -p "$oci"
run --build-oci "$oci" --builder owner-builder
expected=""
for i in api web otelcol-validator otelcol-testing ottl-evaluator; do expected="$expected$(expected_record "$i" oci linux/amd64,linux/arm64 "$oci")
"; done
check "--build-oci runs each image's exact build: both platforms, provenance mode=max, the pinned SBOM generator, an OCI archive" \
  "[ $rc -eq 0 ] && [ \"\$(normalise <'$logs/builds.log')\" = \"\$(printf '%s' \"\$expected\")\" ]"
check "--build-oci never pushes, loads or asks a registry" \
  "! grep -qE -- '--(push|load)( |$)' '$logs/builds.log' && [ ! -s '$logs/crane-calls.log' ]"
all_written=true
for i in api web otelcol-validator otelcol-testing ottl-evaluator; do
  [ -f "$oci/$i.oci.tar" ] && [ -f "$oci/$i.digest" ] && [ ! -e "$oci/$i.oci.tar.partial" ] || all_written=false
  grep -qxE 'sha256:[0-9a-f]{64}' "$oci/$i.digest" 2>/dev/null || all_written=false
  [ "$(grep -c '' "$oci/$i.digest" 2>/dev/null)" = 1 ] || all_written=false
  printf '%s\n' "$stdout_only" | grep -qxF "$i $(cat "$oci/$i.digest" 2>/dev/null)" || all_written=false
done
check "each image: <name>.oci.tar and <name>.digest (one line, the index digest), no .partial left, '<name> <digest>' printed" "$all_written"
check "the archive's index.json names the digest file's digest" \
  "tar -xOf '$oci/api.oci.tar' index.json | grep -qF \"\$(cat '$oci/api.digest')\""
run --build-oci "$oci" --builder owner-builder --image web
check "an existing archive refused before anything builds (never overwritten)" \
  "[ $rc -eq 1 ] && has 'web.oci.tar exists: --build-oci never overwrites' && nothing_built"
oci2="$tmp/oci2"; mkdir -p "$oci2"; printf 'x\n' >"$oci2/ottl-evaluator.digest"
run --build-oci "$oci2" --builder owner-builder
check "an existing digest file refused before any image builds" \
  "[ $rc -eq 1 ] && has 'ottl-evaluator.digest exists' && nothing_built && [ ! -e '$oci2/api.oci.tar' ]"
oci3="$tmp/oci3"; mkdir -p "$oci3"
run --build-oci "$oci3" --builder owner-builder --image ottl-evaluator --no-attest
check "--no-attest: --provenance=false and no --attest" \
  "[ $rc -eq 0 ] && [ \"\$(normalise <'$logs/builds.log')\" = \"\$(expected_record ottl-evaluator oci-no-attest linux/amd64,linux/arm64 '$oci3')\" ] && [ -f '$oci3/ottl-evaluator.oci.tar' ]"
oci4="$tmp/oci4"; mkdir -p "$oci4"
STANDIN_FAIL_BUILD=web run --build-oci "$oci4" --builder owner-builder
check "the first failure stops --build-oci, naming the image and those not tried; no archive of it left" \
  "[ $rc -eq 1 ] && has 'stopped at image web (exit 3); not tried: otelcol-validator otelcol-testing ottl-evaluator' && [ -f '$oci4/api.oci.tar' ] && [ ! -e '$oci4/web.oci.tar' ] && [ ! -e '$oci4/web.oci.tar.partial' ] && [ ! -e '$oci4/web.digest' ] && [ \$(wc -l <'$logs/builds.log') -eq 2 ]"
oci5="$tmp/oci5"; mkdir -p "$oci5"
STANDIN_OTHER_DIGEST=1 run --build-oci "$oci5" --builder owner-builder --image api
check "a build whose metadata digest isn't the archive's index refused: no archive, no digest file" \
  "[ $rc -eq 1 ] && has \"index.json's entry is\" && [ -z \"\$(ls -A '$oci5')\" ]"
STANDIN_LABEL_VERSION=9.9.9 run --build-oci "$oci5" --builder owner-builder --image api
check "an archive whose images aren't labelled with the version refused" \
  "[ $rc -eq 1 ] && has \"version label isn't 1.2.3\" && [ -z \"\$(ls -A '$oci5')\" ]"
STANDIN_BUILDX=v0.8.2 run --build-oci "$oci5" --builder owner-builder --image api
check "a buildx too old to attest refused (0.11 or later)" "[ $rc -eq 1 ] && has \"can't attest\" && nothing_built"
STANDIN_BUILDX=v0.8.2 run --build-oci "$oci5" --builder owner-builder --image api --no-attest
check "--no-attest takes an old buildx" "[ $rc -eq 0 ] && [ -f '$oci5/api.oci.tar' ]"
STANDIN_DRIVER=docker run --build-oci "$oci3" --builder desktop-linux --image api
check "--build-oci refuses a docker-driver builder" "[ $rc -eq 1 ] && has \"uses the 'docker' driver\" && nothing_built"

# --- 6. --push-oci: the archives' bytes copied, compared, never overwritten ----------------------
# Offline first: what pass 1 refuses before any registry call.
offline="$tmp/offline"; mkdir -p "$offline"
for i in api web otelcol-validator otelcol-testing ottl-evaluator; do
  tr_fixture "$offline/$i.oci.tar" 1.2.3 "$rev" "O-$i" >"$offline/$i.digest"
done
tr_fixture "$offline/ottl-evaluator.oci.tar" 1.2.3 "$rev" O-ottl-evaluator no-attest >"$offline/ottl-evaluator.digest"
run --push-oci "$offline"
check "a --no-attest archive refused for ghcr.io, before any registry call" \
  "[ $rc -eq 1 ] && has \"ottl-evaluator.oci.tar: the linux/amd64 image has no attestation manifest\" && has 'nothing pushed' && [ -f '$logs/crane-calls.log' ] && [ ! -s '$logs/crane-calls.log' ]"
tr_fixture "$offline/ottl-evaluator.oci.tar" 1.2.3 "$rev" O-ottl-evaluator >"$offline/ottl-evaluator.digest"
tr_tamper "$offline/ottl-evaluator.oci.tar" flip-layer
run --push-oci "$offline"
check "a corrupt blob in the last archive (one layer byte flipped) refused in pass 1, before any registry call" \
  "[ $rc -eq 1 ] && has \"ottl-evaluator.oci.tar: the archive's blobs/sha256/\" && has \"doesn't hash to its name\" && [ ! -s '$logs/crane-calls.log' ]"
# CI: crane only tools.sh's checked one (oci.sh's rule): the file `tools.sh path crane` gives,
# hashed against tools.lock's binary sha256; never PATH's, never another named one. (The accepted
# case is oci.test.sh's, whose lock names its stand-in's sum.)
run_ci() { reset_logs; out="$(env CI=true "$@" TMPDIR="$tmp/t" DOCKER_CONFIG="$tmp/docker" "$shell" "$tmp/repo/scripts/publish-platform-images.sh" --dry-run --builder owner-builder --image api 2>&1)"; rc=$?; }
run_ci TELFLO_CRANE="$bin/crane"
check "CI=true: a TELFLO_CRANE outside the repository's .tools/ refused (no checked crane there), crane never run" \
  "[ $rc -eq 1 ] && has 'CI: no checked crane in .tools/' && [ ! -s '$logs/crane-calls.log' ]"
crane_version="$(awk '$1 == "tool" && $2 == "crane" { print $3; exit }' "$tmp/repo/scripts/release/tools.lock")"
mkdir -p "$tmp/repo/.tools/crane/$crane_version"
cp "$bin/crane" "$tmp/repo/.tools/crane/$crane_version/crane"
( cd "$tmp/repo/.tools/crane/$crane_version" && { shasum -a 256 crane 2>/dev/null || sha256sum crane; } | awk '{ printf "%s", $1 }' >.checked )
run_ci TELFLO_CRANE="$tmp/repo/.tools/crane/$crane_version/crane"
check "CI=true: a crane in .tools/ with its own .checked record but not tools.lock's binary sha256: refused, crane never run" \
  "[ $rc -eq 1 ] && has 'CI: no checked crane in .tools/' && [ ! -s '$logs/crane-calls.log' ]"
ln -s "$bin/crane" "$tmp/repo/.tools/crane/crane-link"
run_ci TELFLO_CRANE="$tmp/repo/.tools/crane/crane-link"
check "CI=true: a symlink inside .tools/ to a crane outside it refused, crane never run" \
  "[ $rc -eq 1 ] && has 'CI: ' && [ ! -s '$logs/crane-calls.log' ]"
rm -rf "$tmp/repo/.tools"
run_ci
check "CI=true without TELFLO_CRANE: PATH's crane refused (only tools.sh's checked one)" \
  "[ $rc -eq 1 ] && has 'CI: no checked crane in .tools/' && [ ! -s '$logs/crane-calls.log' ]"
check "the repository is clean again (.tools/ is ignored, then removed)" "[ -z \"\$(git -C '$tmp/repo' status --porcelain)\" ]"
push_ok=false
if tr_tools "$root" && [ -n "$real_crane" ]; then
  if tr_registry_start "$tmp/registry"; then push_ok=true; else TR_SKIP="the throwaway registry didn't start"; fi
fi
if $push_ok; then
  REG="$TR_REGISTRY"
  pr() { STANDIN_CRANE='' TEST_DOCKER_CONFIG="$TR_CONFIG" run --push-oci "$@"; }
  remote_of() { DOCKER_CONFIG="$TR_CONFIG" "$real_crane" digest "$REG/telflo/telflo/$1:1.2.3" 2>/dev/null; }
  # The release's archives: fixtures labelled 1.2.3 and HEAD's revision.
  rel="$tmp/release"; mkdir -p "$rel"
  for i in api web otelcol-validator otelcol-testing ottl-evaluator; do
    tr_fixture "$rel/$i.oci.tar" 1.2.3 "$rev" "A-$i" >"$rel/$i.digest"
  done
  pr "$rel" --registry "$REG"
  copied=true
  for i in api web otelcol-validator otelcol-testing ottl-evaluator; do
    [ "$(remote_of "$i")" = "$(cat "$rel/$i.digest")" ] || copied=false
    printf '%s\n' "$stdout_only" | grep -qxF "$REG/telflo/telflo/$i:1.2.3@$(cat "$rel/$i.digest")" || copied=false
  done
  check "--push-oci copies every archive: the remote digest after the copy equals <name>.digest (real crane, $REG)" "[ $rc -eq 0 ] && $copied"
  check "every tag asked before the first push" \
    "[ \"\$(grep -nE '^digest ' '$logs/crane-calls.log' | sed -n 5p | cut -d: -f1)\" -lt \"\$(grep -nE '^push ' '$logs/crane-calls.log' | head -n 1 | cut -d: -f1)\" ]"
  check "each copy is 'crane push <layout folder> <ref>', never --index, the tag's digest read again after it" \
    "[ \$(grep -cE '^push [^ ]+/layout $REG/telflo/telflo/[a-z-]+:1\\.2\\.3 \$' '$logs/crane-calls.log') -eq 5 ] && ! grep -q -- '--index' '$logs/crane-calls.log' && [ \$(grep -cE '^digest ' '$logs/crane-calls.log') -eq 15 ]"
  check "the unpacked layouts are deleted (the temporary directory is empty)" "[ -z \"\$(ls -A '$tmp/t')\" ]"
  pr "$rel" --registry "$REG"
  check "a re-run skips every tag holding the archive's digest, with a line; nothing pushed" \
    "[ $rc -eq 0 ] && has 'holds $(cat "$rel/api.digest") already' && nothing_pushed && [ \"\$(printf '%s\n' \"\$stdout_only\" | grep -c '@sha256:')\" -eq 5 ]"
  # Another archive for one image (variant B): its tag holds A's digest.
  other="$tmp/other"; mkdir -p "$other"
  for i in api web otelcol-validator otelcol-testing; do cp "$rel/$i.oci.tar" "$rel/$i.digest" "$other/"; done
  tr_fixture "$other/ottl-evaluator.oci.tar" 1.2.3 "$rev" B >"$other/ottl-evaluator.digest"
  before="$(remote_of ottl-evaluator)"
  pr "$other" --registry "$REG"
  check "--push-oci refuses a tag present with another digest: exit 1, nothing copied, the tag unchanged" \
    "[ $rc -eq 1 ] && has 'holds $before, not the archive' && has 'nothing pushed' && nothing_pushed && [ \"\$(remote_of ottl-evaluator)\" = '$before' ] && [ '$before' != \"\$(cat '$other/ottl-evaluator.digest')\" ]"
  fresh_dir() { rm -rf "$tmp/case"; mkdir -p "$tmp/case"; for i in api web otelcol-validator otelcol-testing ottl-evaluator; do cp "$rel/$i.oci.tar" "$rel/$i.digest" "$tmp/case/"; done; }
  fresh_dir; tr_fixture "$tmp/case/web.oci.tar" 1.2.3 "$rev" C >/dev/null
  pr "$tmp/case" --registry "$REG" --image web
  check "an archive whose index isn't its digest file's refused, nothing pushed" \
    "[ $rc -eq 1 ] && has \"index.json's entry is\" && nothing_pushed"
  fresh_dir; tr_fixture "$tmp/case/web.oci.tar" 1.2.4 "$rev" A-web >"$tmp/case/web.digest"
  pr "$tmp/case" --registry "$REG" --image web
  check "an archive of another version refused (its labels), nothing pushed" "[ $rc -eq 1 ] && has \"version label isn't 1.2.3\" && nothing_pushed"
  fresh_dir; tr_fixture "$tmp/case/web.oci.tar" 1.2.3 0000000000000000000000000000000000000000 A-web >"$tmp/case/web.digest"
  pr "$tmp/case" --registry "$REG" --image web
  check "an archive built from another commit refused (its revision label), nothing pushed" "[ $rc -eq 1 ] && has \"revision label isn't $rev\" && nothing_pushed"
  fresh_dir; rm -f "$tmp/case/api.oci.tar"
  pr "$tmp/case" --registry "$REG"
  check "a missing archive refused before anything is asked" "[ $rc -eq 1 ] && has 'api.oci.tar is missing' && [ ! -s '$logs/crane-calls.log' ]"
  fresh_dir; printf 'sha256:abc\n' >"$tmp/case/web.digest"
  pr "$tmp/case" --registry "$REG"
  check "a malformed digest file refused before anything is asked" "[ $rc -eq 1 ] && has \"web.digest isn't sha256\" && [ ! -s '$logs/crane-calls.log' ]"
  fresh_dir; mkdir -p "$tmp/evil/x"; ( cd "$tmp/evil" && tar -cf "$tmp/case/web.oci.tar" x ); 
  pr "$tmp/case" --registry "$REG" --image web
  check "an archive that isn't an OCI layout refused, nothing pushed" "[ $rc -eq 1 ] && has \"isn't an OCI layout's\" && nothing_pushed"
  # A --no-attest archive (a rehearsal's) is accepted by a loopback registry.
  na="$tmp/no-attest"; mkdir -p "$na"
  mkdir -p "$tmp/na-repo"; cp -R "$tmp/repo/." "$tmp/na-repo/"
  sed -i.bak 's/^version: .*/version: 1.2.4/; s/^appVersion: .*/appVersion: "1.2.4"/' "$tmp/na-repo/charts/telflo/Chart.yaml" && rm -f "$tmp/na-repo/charts/telflo/Chart.yaml.bak"
  gitc -C "$tmp/na-repo" commit -q -am "1.2.4" >/dev/null 2>&1
  na_rev="$(git -C "$tmp/na-repo" rev-parse HEAD)"
  for i in api web otelcol-validator otelcol-testing ottl-evaluator; do tr_fixture "$na/$i.oci.tar" 1.2.4 "$na_rev" "NA-$i" no-attest >"$na/$i.digest"; done
  STANDIN_CRANE='' TEST_DOCKER_CONFIG="$TR_CONFIG" run_in "$tmp/na-repo" --push-oci "$na" --registry "$REG" --image ottl-evaluator
  check "a --no-attest archive accepted for a loopback registry (the rehearsal's)" \
    "[ $rc -eq 0 ] && [ \"\$(DOCKER_CONFIG='$TR_CONFIG' '$real_crane' digest '$REG/telflo/telflo/ottl-evaluator:1.2.4' 2>/dev/null)\" = \"\$(cat '$na/ottl-evaluator.digest')\" ]"
  if [ "$TR_AUTH" = 1 ]; then
    fresh_dir
    STANDIN_CRANE='' TEST_DOCKER_CONFIG="$tmp/docker" run --push-oci "$tmp/case" --registry "$REG" --image api
    check "a registry that answers UNAUTHORIZED (no login): can't tell, refused, nothing pushed" \
      "[ $rc -eq 1 ] && has \"can't tell whether $REG/telflo/telflo/api:1.2.3 exists\" && has 'UNAUTHORIZED' && nothing_pushed"
    check "crane read only the caller's DOCKER_CONFIG" "[ \"\$(sort -u '$logs/crane-config.log')\" = '$tmp/docker' ]"
    check "no file of the test's work folder or output holds the registry's test credential (boolean)" \
      "! tr_secret_in '$tmp/t' '$tmp/logs' '$tmp/stdout' '$tmp/stderr' '$rel' '$other' '$tmp/case' '$tmp/repo'"
    check "the credential canary works (it finds the login where it is)" "tr_secret_in '$TR_CONFIG'"
  else
    skip "the UNAUTHORIZED and credential cases" "no htpasswd: the throwaway registry has no login"
  fi
  # The real crane's argv for a GHCR copy is the same shape, never run here.
  check "the script names no write but crane push (no crane copy, cp, tag or delete)" \
    "! grep -nE '\"\\\$TELFLO_CRANE\" (copy|cp|tag|delete|mutate|append|index)' '$root/scripts/release/oci.sh' '$root/scripts/publish-platform-images.sh'"
else
  for c in "the copy and its remote digest" "the skip of an equal tag" "the refusal of another digest" "the archive checks" "the UNAUTHORIZED and credential cases"; do
    skip "--push-oci: $c" "${TR_SKIP:-no crane}"
  done
fi
tr_registry_stop

# --- 7. uncommitted inputs, flags and the checkout ---------------------------------------------
fresh() { rm -rf "$tmp/c"; gitc clone -q "$tmp/repo" "$tmp/c" >/dev/null 2>&1; }
fresh; printf '# changed\n' >>"$tmp/c/telflo-core/Dockerfile"
run_in "$tmp/c" --dry-run --builder owner-builder
check "a changed input refused (--dry-run too), named, nothing asked" \
  "[ $rc -eq 1 ] && has 'refuses uncommitted changes' && has 'telflo-core/Dockerfile' && nothing_asked"
fresh; printf 'x\n' >"$tmp/c/services/ottl-evaluator/new.go"
run_in "$tmp/c" --build --builder owner-builder --image ottl-evaluator
check "an untracked file in an input refused (--build too)" \
  "[ $rc -eq 1 ] && has 'services/ottl-evaluator/new.go' && nothing_asked"
fresh; printf 'x\n' >"$tmp/c/services/otelcol-validator/new.py"
run_in "$tmp/c" --build --builder owner-builder --image ottl-evaluator
check "a change outside the image's inputs isn't refused" "[ $rc -eq 0 ] && [ -s '$logs/builds.log' ]"
fresh; printf 'appVersion: "9.9.9"\n' >"$tmp/c/charts/telflo/Chart.yaml"
run_in "$tmp/c" --dry-run --builder owner-builder --image api
check "an uncommitted Chart.yaml refused" "[ $rc -eq 1 ] && has 'charts/telflo/Chart.yaml' && nothing_asked"
fresh; printf '# changed\n' >>"$tmp/c/scripts/publish-platform-images.sh"
run_in "$tmp/c" --dry-run --builder owner-builder --image api
check "an uncommitted change to the script itself refused" "[ $rc -eq 1 ] && has 'scripts/publish-platform-images.sh' && nothing_asked"
fresh; printf 'changed\n' >>"$tmp/c/catalog/distributions/otelcol-contrib.json"; git -C "$tmp/c" update-index --skip-worktree catalog/distributions/otelcol-contrib.json
run_in "$tmp/c" --dry-run --builder owner-builder --image otelcol-validator
check "an input flagged skip-worktree refused" "[ $rc -eq 1 ] && has 'skip-worktree: catalog/distributions/otelcol-contrib.json' && nothing_asked"
fresh; git -C "$tmp/c" update-index --assume-unchanged install-templates/docker.sh.tmpl
run_in "$tmp/c" --dry-run --builder owner-builder --image api
check "an input flagged assume-unchanged refused" "[ $rc -eq 1 ] && has 'assume-unchanged: install-templates/docker.sh.tmpl' && nothing_asked"
fresh; ln -s ../catalog "$tmp/c/install-templates/link"; gitc -C "$tmp/c" add -A >/dev/null 2>&1; gitc -C "$tmp/c" commit -q -m link >/dev/null 2>&1
run_in "$tmp/c" --dry-run --builder owner-builder --image api
check "a symlink in HEAD's inputs refused" "[ $rc -eq 1 ] && has 'install-templates/link is a symlink' && nothing_asked"
mkdir -p "$tmp/plain"; cp -R "$tmp/repo/." "$tmp/plain/"; rm -rf "$tmp/plain/.git"
run_in "$tmp/plain" --dry-run --builder owner-builder
check "a copy that isn't a git checkout refused" "[ $rc -eq 1 ] && has 'need a git checkout' && nothing_asked"
fresh; mkdir -p "$tmp/c/nested"; cp -R "$tmp/repo/scripts" "$tmp/repo/charts" "$tmp/c/nested/"
run_in "$tmp/c/nested" --dry-run --builder owner-builder
check "a copy inside another repository refused" "[ $rc -eq 1 ] && has 'need a git checkout' && nothing_asked"

# --- 7b. the context is HEAD's committed blobs, never the working tree's -------------------------
# A clean filter (configured in the clone, named by a committed
# .gitattributes) lets an input's working-tree bytes differ from its HEAD
# blob while git status calls it unchanged: only a context written from HEAD's
# raw blobs (git cat-file blob, no filter) holds HEAD's bytes.
fresh
printf 'install-templates/*.tmpl filter=t4canary\n' >"$tmp/c/.gitattributes"
gitc -C "$tmp/c" add .gitattributes >/dev/null 2>&1; gitc -C "$tmp/c" commit -q -m attributes >/dev/null 2>&1
git -C "$tmp/c" config filter.t4canary.clean "sed 's/^WORKTREE-ONLY //'"
git -C "$tmp/c" config filter.t4canary.smudge cat
printf 'WORKTREE-ONLY a\n' >"$tmp/c/install-templates/docker.sh.tmpl"
# Staged through the clean filter: the index keeps HEAD's blob, with the new
# file's stat, so git status sees no change.
git -C "$tmp/c" add install-templates/docker.sh.tmpl >/dev/null 2>&1
check "the filter's working tree differs from HEAD while git status calls it clean" \
  "[ -z \"\$(git -C '$tmp/c' status --porcelain 2>&1)\" ] && ! cmp -s '$tmp/c/install-templates/docker.sh.tmpl' <(git -C '$tmp/c' cat-file blob HEAD:install-templates/docker.sh.tmpl)"
STANDIN_KEEP_CONTEXT=1 run_in "$tmp/c" --build --builder owner-builder --image api
head_bytes_everywhere() { # every context file is HEAD's blob, byte for byte, and HEAD's every input file is there
  local f n=0
  while IFS= read -r f; do
    cmp -s "$logs/context-copy/$f" <(git -C "$tmp/c" cat-file blob "HEAD:$f") || return 1
    n=$((n + 1))
  done < <(cd "$logs/context-copy" && find . -type f | sed 's#^\./##')
  [ "$n" -eq "$(git -C "$tmp/c" ls-tree -r --name-only HEAD -- .dockerignore telflo-core catalog install-templates | wc -l)" ]
}
check "the build context holds HEAD's committed bytes, not the working tree's (each file equal to its HEAD blob)" \
  "[ $rc -eq 0 ] && head_bytes_everywhere && ! grep -rq 'WORKTREE-ONLY' '$logs/context-copy'"

# --- 8. credentials ---------------------------------------------------------------------------
cred_case() { # <name> <config.json content> <expected message>: --push-oci and --dry-run both refused
  local name="$1" dir="$tmp/cred-$1" mode want="$3" args
  mkdir -p "$dir" "$tmp/release-cred"
  printf '%s\n' "$2" >"$dir/config.json"
  for mode in --push-oci --dry-run; do
    reset_logs
    if [ "$mode" = --push-oci ]; then args=(--push-oci "$tmp/release-cred"); else args=(--dry-run --builder owner-builder); fi
    out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$dir" STANDIN_CRANE=absent "$shell" "$tmp/repo/scripts/publish-platform-images.sh" "${args[@]}" 2>&1)"; rc=$?
    check "a caller's DOCKER_CONFIG $name refused ($mode), its content never printed, docker and crane never asked" \
      "[ $rc -eq 1 ] && has \"\$want\" && ! has 'c4n4ry' && nothing_asked"
  done
}
cred_case "naming credsStore" '{"auths":{"x.invalid":{}},"credsStore":"c4n4ry"}' 'names a credential store or helper'
cred_case "naming CredHelpers" '{"auths":{"x.invalid":{}},"CredHelpers":{"ghcr.io":"c4n4ry"}}' 'names a credential store or helper'
cred_case "with an empty auths" '{"auths":{},"c4n4ry":1}' 'has an empty "auths" object'
cred_case "spelling Auths" '{"Auths":{"x.invalid":{"c4n4ry":1}}}' "has a key spelled like"
cred_case "that isn't JSON" 'c4n4ry' "isn't JSON"
reset_logs
out="$(env -u DOCKER_CONFIG TMPDIR="$tmp/t" STANDIN_CRANE=absent "$shell" "$tmp/repo/scripts/publish-platform-images.sh" --dry-run --builder owner-builder --image api 2>&1)"; rc=$?
check "DOCKER_CONFIG unset: a temporary configuration with no login is used (crane reads it)" \
  "[ $rc -eq 0 ] && has 'DOCKER_CONFIG is unset' && grep -q 'publish-platform-images\\.[A-Za-z0-9]\\{6\\}/docker\$' '$logs/crane-config.log' && ! grep -qx unset '$logs/crane-config.log'"
check "the temporary directory is removed on exit" "[ -z \"\$(ls -A '$tmp/t')\" ]"

# --- 9. never a login, never a credential helper -----------------------------------------------
check "the script never logs in" "! grep -nE '^[^#]*(docker|helm|crane)( [a-z-]+)* (login|auth)( |$)' '$root/scripts/publish-platform-images.sh' '$root/scripts/release/oci.sh'"
check "no docker or crane call was a login" "[ -s '$logs/all-docker-calls.log' ] && [ -s '$logs/all-crane-calls.log' ] && ! grep -qE '(^| )(login|auth)( |$)' '$logs/all-docker-calls.log' && ! grep -qE '^(auth|login)( |$)' '$logs/all-crane-calls.log'"
check "no docker call created, used or removed a builder" "! grep -qE '^buildx (create|use|rm|prune)( |$)' '$logs/all-docker-calls.log'"
check "no credential helper was called" "[ ! -s '$logs/helper.log' ]"
check "no stand-in call was unexpected" "! grep -q UNEXPECTED '$logs/all-docker-calls.log' && ! grep -q UNEXPECTED '$logs/all-crane-calls.log'"

echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
