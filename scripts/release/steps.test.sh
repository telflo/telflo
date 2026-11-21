#!/bin/bash
# Tests for scripts/release/steps.sh. Offline but for the cases against a
# throwaway registry:2 on 127.0.0.1 (tools.lock's image, local by digest;
# test-registry.sh), with the real crane; SKIP lines when docker, crane,
# helm or that image is missing. The steps that only run on a GitHub-hosted
# runner (they remove toolchains, pull images, log in, make a Release) are
# tested for their refusals here, and helm-login and github-release with
# stand-ins for helm and gh (their argv and stdin recorded, compared by
# boolean). Refusing credential-helper stand-ins come first on PATH: none may
# be called.
# Run:  bash scripts/release/steps.test.sh   (bash 3.2 compatible)
set -u
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
unset CI GITHUB_ACTIONS RUNNER_ENVIRONMENT RUNNER_OS RUNNER_TEMP GITHUB_OUTPUT GITHUB_REPOSITORY GH_TOKEN GHCR_USER GHCR_TOKEN HELM_REGISTRY_CONFIG TELFLO_CRANE
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/release/steps.sh"
shell="${BASH:-bash}"
# shellcheck source=scripts/release/test-registry.sh
. "$root/scripts/release/test-registry.sh"

failures=0
skips=0
# A failing case also prints up to 12 of the step's lines that say why (static.sh redacts the gate's log).
check() {
  if eval "$2"; then echo "ok   - $1"; else
    echo "FAIL - $1"; failures=$((failures + 1))
    printf '%s\n' "${out:-}" | grep -E 'FAIL|fail|rror|refus|denied|not ' | head -n 12 | sed 's/^/    | /'
  fi
}
skip() { echo "SKIP - $1 ($2)"; skips=$((skips + 1)); }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/steps-test.XXXXXX")" || exit 1
cleanup() { tr_registry_stop; rm -rf "$tmp"; }
trap cleanup EXIT
real_docker="$(command -v docker 2>/dev/null || true)"
TR_DOCKER="${real_docker:-docker}"
bin="$tmp/bin"; logs="$tmp/logs"
mkdir -p "$bin" "$logs" "$tmp/stub" "$tmp/t"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/stub/config.json"
TR_DOCKER_CONFIG="$tmp/stub"
for helper in osxkeychain desktop ecr-login; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$logs" >"$bin/docker-credential-$helper"
  chmod +x "$bin/docker-credential-$helper"
done
PATH="$bin:$PATH"; export PATH
offered="$("$shell" "$root/scripts/build-collector-image.sh" --list-offered)"
default="$(jq -r '[.versions[] | select(.default == true) | .version] | if length == 1 then .[0] else empty end' "$root/catalog/distributions/otelcol-contrib.json")"
sha() { shasum -a 256 "$1" | cut -c1-64; }

run() { # <env assignments...> -- <args...>: sets rc, out
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  # Standard input closed: a stand-in that reads it (helm's) ends at once, never waits on a terminal.
  out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$tmp/stub" ${envs[@]+"${envs[@]}"} "$shell" "$script" "$@" 2>&1 </dev/null)"; rc=$?
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
ACTIONS=(GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted RUNNER_OS=Linux)

# --- usage ---------------------------------------------------------------------------------
run -- ; check "no step: usage (exit 2)" "[ $rc -eq 2 ] && has 'usage: scripts/release/steps.sh free-disk'"
run -- bogus; check "an unknown step: usage (exit 2)" "[ $rc -eq 2 ]"

# --- free-disk -----------------------------------------------------------------------------
for bad in "" 0 10000 x 1.5; do
  run -- free-disk $bad
  check "free-disk '$bad' refused (exit 2)" "[ $rc -eq 2 ]"
done
run -- free-disk 1
check "free-disk 1 off a runner: nothing removed, only checked (exit 0)" "[ $rc -eq 0 ] && has 'nothing removed, only checked' && has 'at least 1 GB free'"
run "${ACTIONS[@]}" -- free-disk 1
if [ "$(uname -s)" != Linux ]; then
  check "free-disk with a runner's variables but not on Linux: still nothing removed" "[ $rc -eq 0 ] && has 'nothing removed, only checked' && ! has removed\ /"
fi
# A need no machine meets (a public repository's runner has well over 99 GB free once the
# toolchains are removed, as the runner-variables case above does on Linux).
run -- free-disk 9999
check "free-disk 9999: under the need, exit 1 with a plain message" "[ $rc -eq 1 ] && has 'this job needs 9999 GB free'"

# --- pull-images, helm-login, github-release: runner only ------------------------------------
run -- pull-images
check "pull-images off a runner: refused (exit 2)" "[ $rc -eq 2 ] && has 'GitHub-hosted Linux runner only'"
if [ "$(uname -s)" != Linux ]; then
  run "${ACTIONS[@]}" -- pull-images --kind
  check "pull-images with a runner's variables but not on Linux: refused (exit 2)" "[ $rc -eq 2 ]"
fi
run -- pull-images --bogus
check "pull-images --bogus: refused (exit 2)" "[ $rc -eq 2 ]"
run -- helm-login
check "helm-login outside Actions: refused (exit 2)" "[ $rc -eq 2 ] && has 'GitHub Actions job only'"
run -- github-release --tag v0.1.0 --oci "$tmp" --release "$tmp"
check "github-release outside Actions: refused (exit 2), a rehearsal never makes a Release" "[ $rc -eq 2 ] && has 'never makes a GitHub Release'"

# --- builder -------------------------------------------------------------------------------
run -- builder
check "builder without DOCKER_CONFIG's buildx: refused or failed" "[ $rc -ne 0 ]"
mkdir -p "$tmp/fake-config/cli-plugins"
printf '%s\n' '{"auths":{"telflo-test.invalid":{}}}' >"$tmp/fake-config/config.json"
printf '#!/bin/sh\nexit 0\n' >"$tmp/fake-config/cli-plugins/docker-buildx"; chmod +x "$tmp/fake-config/cli-plugins/docker-buildx"
out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$tmp/fake-config" "$shell" "$script" builder 2>&1)"; rc=$?
check "builder with a cli-plugins buildx that isn't tools.sh's checked one: exit 1" \
  "[ $rc -eq 1 ] && { has \"isn't tools.sh's checked buildx\" || has \"buildx isn't fetched\"; }"
printf '%s\n' '{"auths":{},"credsStore":"desktop"}' >"$tmp/fake-config/config.json"
out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$tmp/fake-config" "$shell" "$script" builder 2>&1)"; rc=$?
check "builder with a DOCKER_CONFIG naming a credential store: refused (exit 1)" "[ $rc -eq 1 ] && has 'credential store'"
if "$shell" "$root/scripts/release/tools.sh" path buildx >/dev/null 2>&1; then
  "$shell" "$root/scripts/release/tools.sh" docker-config "$tmp/dc" >/dev/null
  # A stand-in docker records what builder asks of it (the real one would start BuildKit: the rehearsal does).
  mkdir -p "$tmp/dbin"
  printf '#!/bin/bash\nprintf "%%s\\n" "$*" >>"%s/docker.log"\nexit 0\n' "$logs" >"$tmp/dbin/docker"; chmod +x "$tmp/dbin/docker"
  out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$tmp/dc" PATH="$tmp/dbin:$PATH" "$shell" "$script" builder 2>&1)"; rc=$?
  buildkit="$("$shell" "$root/scripts/release/tools.sh" ref buildkit)"
  check "builder: no builder yet, so docker buildx create --name telflo-release --driver docker-container, BuildKit by its digest, then bootstrapped (exit 0)" \
    "[ $rc -eq 0 ] && grep -qxF 'buildx create --name telflo-release --driver docker-container --driver-opt image=$buildkit' '$logs/docker.log' && grep -qxF 'buildx --builder telflo-release inspect --bootstrap' '$logs/docker.log' && [ \"\$(printf '%s\n' \"\$out\" | tail -n 1)\" = telflo-release ]"
else
  skip "builder's docker calls" "buildx isn't fetched (scripts/release/tools.sh fetch buildx)"
fi

# --- release-files -------------------------------------------------------------------------
rel="$tmp/rel"; mkdir -p "$rel"
run -- release-files
check "release-files without --out: refused (exit 2)" "[ $rc -eq 2 ]"
run -- release-files --out "$rel"
check "release-files with no Compose archive: exit 1" "[ $rc -eq 1 ] && has 'exactly one telflo-compose-<version>.tar.gz'"
printf 'archive bytes\n' | gzip -n >"$rel/telflo-compose-0.1.0.tar.gz"
run -- release-files --out "$rel"
head_sum="$(git -C "$root" cat-file blob HEAD:scripts/create-secrets.sh | shasum -a 256 | cut -c1-64)"
check "release-files: create-secrets.sh is HEAD's blob, mode 0755 (exit 0)" \
  "[ $rc -eq 0 ] && [ \"\$(sha '$rel/create-secrets.sh')\" = '$head_sum' ] && [ -x '$rel/create-secrets.sh' ] && [ \"\$(ls -l '$rel/create-secrets.sh' | cut -c1-10)\" = '-rwxr-xr-x' ]"
check "release-files: SHA256SUMS lists exactly both, sorted, and checks" \
  "[ \"\$(awk '{ print \$2 }' '$rel/SHA256SUMS' | tr '\n' ' ')\" = 'create-secrets.sh telflo-compose-0.1.0.tar.gz ' ] && (cd '$rel' && shasum -a 256 -c SHA256SUMS >/dev/null)"
before="$(sha "$rel/SHA256SUMS")"
run -- release-files --out "$rel"
check "release-files again: refused, nothing overwritten (exit 1)" "[ $rc -eq 1 ] && has 'never overwritten' && [ \"\$(sha '$rel/SHA256SUMS')\" = '$before' ]"
rel2="$tmp/rel2"; mkdir -p "$rel2"
cp "$rel/telflo-compose-0.1.0.tar.gz" "$rel2/"; cp "$rel/telflo-compose-0.1.0.tar.gz" "$rel2/telflo-compose-0.1.1.tar.gz"
run -- release-files --out "$rel2"
check "release-files with two archives: exit 1" "[ $rc -eq 1 ]"

# --- collector-versions --------------------------------------------------------------------
cat >"$bin/crane-standin" <<'CRANE'
#!/bin/bash
printf '%s\n' "$*" >>"$STANDIN_LOG"
case "$1" in digest | manifest) ;; *) echo "UNEXPECTED $*" >>"$STANDIN_LOG"; exit 97 ;; esac
if [ -f "$STANDIN_DIR/present" ] && grep -qxF -- "$2" "$STANDIN_DIR/present"; then
  echo sha256:1111111111111111111111111111111111111111111111111111111111111111; exit 0
fi
if [ -f "$STANDIN_DIR/denied" ] && grep -qxF -- "$2" "$STANDIN_DIR/denied"; then
  echo "Error: GET https://registry.invalid/token: DENIED: requested access to the resource is denied" >&2; exit 1
fi
echo "Error: GET https://registry.invalid/v2/x/manifests/t: MANIFEST_UNKNOWN: manifest unknown; map[Tag:t]" >&2
exit 1
CRANE
chmod +x "$bin/crane-standin"
export STANDIN_LOG="$logs/crane.log" STANDIN_DIR="$tmp/standin"
mkdir -p "$STANDIN_DIR"; : >"$STANDIN_DIR/present"; : >"$STANDIN_DIR/denied"
SC=(TELFLO_CRANE="$bin/crane-standin")
all_json="[$(printf '%s\n' "$offered" | sed 's/.*/"&"/' | paste -sd, -)]"
: >"$tmp/gh-out"
run GITHUB_OUTPUT="$tmp/gh-out" -- collector-versions all
check "collector-versions all: every offered version, as JSON, versions= and has=true in GITHUB_OUTPUT (exit 0), no registry asked" \
  "[ $rc -eq 0 ] && [ \"\$(printf '%s\n' \"\$out\" | tail -n 1)\" = '$all_json' ] && grep -qxF 'versions=$all_json' '$tmp/gh-out' && grep -qxF 'has=true' '$tmp/gh-out' && [ ! -s '$STANDIN_LOG' ]"
run -- collector-versions "$default"
check "collector-versions $default: that one (exit 0)" "[ $rc -eq 0 ] && [ \"\$(printf '%s\n' \"\$out\" | tail -n 1)\" = '[\"$default\"]' ]"
run -- collector-versions 0.1.0
check "collector-versions 0.1.0 (not offered): exit 1" "[ $rc -eq 1 ] && has \"doesn't offer the collector version 0.1.0\""
for bad in 0.162 v0.162.0 "0.162.0 0.161.0" ALL "\$(echo EXPANDED)"; do
  run -- collector-versions "$bad"
  check "collector-versions '$bad': refused (exit 2)" "[ $rc -eq 2 ] && ! has EXPANDED"
done
run -- collector-versions all --publish maybe
check "collector-versions --publish maybe: refused (exit 2)" "[ $rc -eq 2 ]"
rm -f "$STANDIN_LOG"
run "${SC[@]}" -- collector-versions all --publish true
check "collector-versions all --publish true, none published: exit 0, each tag asked on ghcr.io/telflo/telflo/collector" \
  "[ $rc -eq 0 ] && [ \$(grep -c '^digest ghcr.io/telflo/telflo/collector:' '$STANDIN_LOG') -eq $(printf '%s\n' "$offered" | grep -c '') ]"
echo "ghcr.io/telflo/telflo/collector:$default" >"$STANDIN_DIR/present"
run "${SC[@]}" -- collector-versions "$default" --publish true
check "collector-versions $default --publish true, published already: refused naming it (exit 1)" \
  "[ $rc -eq 1 ] && has 'ghcr.io/telflo/telflo/collector:$default is published already: never pushed again'"
# shellcheck disable=SC2034 # read by check's eval
rest_json="[$(printf '%s\n' "$offered" | grep -vxF "$default" | sed 's/.*/"&"/' | paste -sd, -)]"
: >"$tmp/gh-out"
run "${SC[@]}" GITHUB_OUTPUT="$tmp/gh-out" -- collector-versions all --publish true
check "collector-versions all --publish true, one published already: the others only, that one named as left out, has=true (exit 0)" \
  "[ $rc -eq 0 ] && [ \"\$(printf '%s\n' \"\$out\" | tail -n 1)\" = \"\$rest_json\" ] && grep -qxF \"versions=\$rest_json\" '$tmp/gh-out' && grep -qxF 'has=true' '$tmp/gh-out' \
   && has 'ghcr.io/telflo/telflo/collector:$default is published already' && has 'left out (never pushed again)'"
printf '%s\n' "$offered" | sed 's#^#ghcr.io/telflo/telflo/collector:#' >"$STANDIN_DIR/present"
: >"$tmp/gh-out"
run "${SC[@]}" GITHUB_OUTPUT="$tmp/gh-out" -- collector-versions all --publish true
check "collector-versions all --publish true, every one published: a notice, [] and has=false, nothing to build (exit 0)" \
  "[ $rc -eq 0 ] && [ \"\$(printf '%s\n' \"\$out\" | tail -n 1)\" = '[]' ] && grep -qxF 'versions=[]' '$tmp/gh-out' && grep -qxF 'has=false' '$tmp/gh-out' \
   && has 'notice: every collector version the catalogue offers is published already' && has 'nothing to build or publish'"
: >"$STANDIN_DIR/present"; echo "ghcr.io/telflo/telflo/collector:$default" >"$STANDIN_DIR/denied"
run "${SC[@]}" -- collector-versions all --publish true
check "collector-versions all --publish true, one can't be told (DENIED): refused (exit 1), nothing to build" "[ $rc -eq 1 ] && has \"can't tell whether\" && has 'nothing built'"
: >"$STANDIN_DIR/denied"; echo "ghcr.io/telflo/telflo/collector:$default" >"$STANDIN_DIR/present"
run "${SC[@]}" -- collector-versions all --publish false
check "collector-versions --publish false: no registry read, exit 0" "[ $rc -eq 0 ]"
: >"$STANDIN_DIR/present"; echo "ghcr.io/telflo/telflo/collector:$default" >"$STANDIN_DIR/denied"
run "${SC[@]}" -- collector-versions "$default" --publish true
check "collector-versions --publish true, can't tell (DENIED): refused (exit 1)" "[ $rc -eq 1 ] && has \"can't tell whether\""
: >"$STANDIN_DIR/denied"

# --- chart-if-new (stand-in) ---------------------------------------------------------------
chart_version="$(sed -n 's/^version: *//p' "$root/charts/supervisor-collector/Chart.yaml" | tr -d '"')"
mkdir -p "$tmp/chart-out"
echo "ghcr.io/telflo/telflo/charts/supervisor-collector:$chart_version" >"$STANDIN_DIR/present"
run "${SC[@]}" -- chart-if-new --out "$tmp/chart-out"
check "chart-if-new, the chart's version published: a notice, nothing packaged or pushed (exit 0)" \
  "[ $rc -eq 0 ] && has 'is published already' && has 'never pushed again' && [ -z \"\$(ls -A '$tmp/chart-out')\" ]"
: >"$STANDIN_DIR/present"; echo "ghcr.io/telflo/telflo/charts/supervisor-collector:$chart_version" >"$STANDIN_DIR/denied"
run "${SC[@]}" -- chart-if-new --out "$tmp/chart-out"
check "chart-if-new, can't tell: refused, nothing packaged (exit 1)" "[ $rc -eq 1 ] && [ -z \"\$(ls -A '$tmp/chart-out')\" ]"
: >"$STANDIN_DIR/denied"
run -- chart-if-new --out "$tmp/chart-out" --registry docker.io
check "chart-if-new --registry docker.io: refused (exit 2)" "[ $rc -eq 2 ]"

# --- stack-smoke: refusals -----------------------------------------------------------------
run -- stack-smoke --version 0.1 --work "$tmp/ss"
check "stack-smoke with a bad version: refused (exit 2)" "[ $rc -eq 2 ]"
run -- stack-smoke --version 0.1.0 --work relative/ss
check "stack-smoke with a relative --work: refused (exit 2)" "[ $rc -eq 2 ]"
for p in telflo telflo-dev telflo-platform; do
  run -- stack-smoke --version 0.1.0 --work "$tmp/ss-$p" --project "$p"
  check "stack-smoke --project $p: refused before anything starts (exit 2)" "[ $rc -eq 2 ] && [ ! -e '$tmp/ss-$p' ]"
done
mkdir -p "$tmp/ss-full"; : >"$tmp/ss-full/x"
run -- stack-smoke --version 0.1.0 --work "$tmp/ss-full"
check "stack-smoke on a work folder that isn't empty: refused (exit 2)" "[ $rc -eq 2 ]"

# --- archive-smoke, kind-smoke: a copy of steps.sh beside stand-in smokes ---------------------
# Each stand-in records its argv and, when told, prints a value of this run's (a tf_ token's
# shape and a PASSWORD= setting, made here, never printed by the test) and exits with SMOKE_EXIT.
sr="$tmp/smoke-root"
for f in scripts/release/steps.sh scripts/release/version.sh scripts/release/oci.sh scripts/release/github-tag.sh scripts/gates/redact.sh; do
  mkdir -p "$sr/$(dirname "$f")"; cp "$root/$f" "$sr/$f"
done
(umask 077 && printf 'tf_%s\nPASSWORD=%s\n' "$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')" "$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')" >"$tmp/smoke-secrets")
for s in smoke-compose-install smoke-kind; do
  cat >"$sr/scripts/$s.sh" <<STANDIN
#!/bin/bash
printf '%s\n' "\$*" >>"$logs/$s.argv"
echo "$s: step 1 PASS"
if [ -n "\${SMOKE_SAYS_SECRET:-}" ]; then echo "a diagnostic: \$(head -n 1 '$tmp/smoke-secrets')"; echo "\$(tail -n 1 '$tmp/smoke-secrets')" >&2; fi
exit "\${SMOKE_EXIT:-0}"
STANDIN
  chmod +x "$sr/scripts/$s.sh"
done
srun() { # <env assignments...> -- <args...>: the copy of steps.sh; sets rc, out
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$tmp/stub" ${envs[@]+"${envs[@]}"} "$shell" "$sr/scripts/release/steps.sh" "$@" 2>&1 </dev/null)"; rc=$?
}
secret_in() { grep -qF -f "$tmp/smoke-secrets" "$@" 2>/dev/null; }
sm_rel="$tmp/smoke-release"; mkdir -p "$sm_rel"
: >"$sm_rel/telflo-compose-0.1.0.tar.gz"; : >"$sm_rel/SHA256SUMS"; : >"$sm_rel/telflo-0.1.0.tgz"
mkdir -p "$tmp/sm-full" "$tmp/sm sp"; : >"$tmp/sm-full/x"; cp "$sm_rel"/* "$tmp/sm sp/"; ln -s "$sm_rel" "$tmp/sm-link"
for step in archive-smoke kind-smoke; do
  argv="$logs/smoke-compose-install.argv"; [ "$step" = kind-smoke ] && argv="$logs/smoke-kind.argv"
  rm -f "$argv"
  n=0
  for bad in "--version|0.1" "--version|v0.1.0" "--version|\$(echo EXPANDED)" "--release|relative/rel" "--release|$tmp/no-such-folder" \
    "--release|$sm_rel/../smoke-release" "--release|$tmp/sm sp" "--release|$tmp/sm-link" "--work|relative/w" "--work|$tmp/sm-full" \
    "--work|$tmp/w;x" "--work|$tmp/x/../w" "--work|$tmp/w sp" "--bogus|x"; do
    n=$((n + 1))
    o="${bad%%|*}" v="${bad#*|}"
    case "$o" in
      --version) set -- "$o" "$v" --release "$sm_rel" --work "$tmp/sm-$step-$n" ;;
      --release) set -- --version 0.1.0 "$o" "$v" --work "$tmp/sm-$step-$n" ;;
      --work) set -- --version 0.1.0 --release "$sm_rel" "$o" "$v" ;;
      *) set -- --version 0.1.0 --release "$sm_rel" --work "$tmp/sm-$step-$n" "$o" "$v" ;;
    esac
    srun -- "$step" "$@"
    check "$step $o '${v#"$tmp/"}': refused (exit 2), nothing expanded, no folder made" \
      "[ $rc -eq 2 ] && ! has EXPANDED && [ ! -e '$tmp/sm-$step-$n' ] && [ ! -e '$tmp/w sp' ] && [ ! -e '$tmp/w' ]"
  done
  if [ "$step" = archive-smoke ]; then
    for p in telflo telflo-dev telflo-platform Upper "-x" "a b"; do
      srun -- "$step" --version 0.1.0 --release "$sm_rel" --work "$tmp/sm-$step-p" --project "$p"
      check "$step --project '$p': refused (exit 2)" "[ $rc -eq 2 ] && [ ! -e '$tmp/sm-$step-p' ]"
    done
    port_opts="--http-port --agent-port --mailpit-port"
  else
    for p in kind Upper "-x" "a_b" "x"; do
      srun -- "$step" --version 0.1.0 --release "$sm_rel" --work "$tmp/sm-$step-p" --profile "$p"
      check "$step --profile '$p': refused (exit 2)" "[ $rc -eq 2 ] && [ ! -e '$tmp/sm-$step-p' ]"
    done
    port_opts="--port --mailpit-port --api-port"
  fi
  for o in $port_opts; do
    for p in 80 70000 "5800x" ""; do
      srun -- "$step" --version 0.1.0 --release "$sm_rel" --work "$tmp/sm-$step-port" "$o" "$p"
      check "$step $o '$p': refused (exit 2)" "[ $rc -eq 2 ] && [ ! -e '$tmp/sm-$step-port' ]"
    done
  done
  srun -- "$step" --version 0.2.0 --release "$sm_rel" --work "$tmp/sm-$step-missing"
  check "$step for a version whose files --release doesn't hold: refused (exit 2)" "[ $rc -eq 2 ] && has 'must hold'"
  check "$step: no refusal started the smoke" "[ ! -e '$argv' ]"
done

# The calls, and the output through redact.sh.
srun -- archive-smoke --version 0.1.0 --release "$sm_rel" --work "$tmp/as1" --project telflo-release-archive --http-port 41100 --agent-port 41101 --mailpit-port 41102
check "archive-smoke: smoke-compose-install.sh on the release's archive and sums, its work <work>/smoke, the options passed (exit 0)" \
  "[ $rc -eq 0 ] && [ \"\$(cat '$logs/smoke-compose-install.argv')\" = '--archive $sm_rel/telflo-compose-0.1.0.tar.gz --sums $sm_rel/SHA256SUMS --work $tmp/as1/smoke --project telflo-release-archive --http-port 41100 --agent-port 41101 --mailpit-port 41102' ] \
   && has 'smoke-compose-install: step 1 PASS' && grep -qF 'smoke-compose-install: step 1 PASS' '$tmp/as1/archive-smoke.log' && has \"secret-shaped lines in the archive smoke's output: 0\" && has 'the archive smoke passed'"
# redact.sh failing after a passing smoke fails the step: the log may be missing lines (logged()).
printf '#!/bin/bash\ncat\nexit 1\n' >"$sr/scripts/gates/redact.sh"
srun -- archive-smoke --version 0.1.0 --release "$sm_rel" --work "$tmp/as-redact-fails"
check "archive-smoke: redact.sh failing after the smoke passed fails the step (exit 1), saying the log may be incomplete" \
  "[ $rc -eq 1 ] && has 'redact.sh or tee failed' && ! has 'the archive smoke passed'"
cp "$root/scripts/gates/redact.sh" "$sr/scripts/gates/redact.sh"
srun -- kind-smoke --version 0.1.0 --release "$sm_rel" --work "$tmp/ks1" --port 41110 --mailpit-port 41111 --api-port 41112
check "kind-smoke: smoke-kind.sh --profile telflo-release-kind on the release's images and chart, its work <work>/smoke, the ports passed (exit 0)" \
  "[ $rc -eq 0 ] && [ \"\$(cat '$logs/smoke-kind.argv')\" = '--profile telflo-release-kind --work $tmp/ks1/smoke --images 0.1.0 --chart $sm_rel/telflo-0.1.0.tgz --port 41110 --mailpit-port 41111 --api-port 41112' ] \
   && grep -qF 'smoke-kind: step 1 PASS' '$tmp/ks1/kind-smoke.log' && has \"secret-shaped lines in the kind smoke's output: 0\""
check "the steps' own words hold no redaction marker (a caller counting it counts only real hits)" "! has REDACTED"
for step in archive-smoke kind-smoke; do
  label="${step%-smoke} smoke"
  srun SMOKE_SAYS_SECRET=1 -- "$step" --version 0.1.0 --release "$sm_rel" --work "$tmp/$step-secret"
  printf '%s\n' "$out" >"$tmp/$step-secret.out"
  check "$step: a secret-shaped value the smoke prints (stdout and stderr) is redacted in the output and the log (boolean)" \
    "! secret_in '$tmp/$step-secret.out' && ! secret_in '$tmp/$step-secret/$step.log' && grep -q 'tf_\\[REDACTED\\]' '$tmp/$step-secret/$step.log' && grep -q 'PASSWORD=\\[REDACTED\\]' '$tmp/$step-secret/$step.log'"
  check "$step: the marker counted, worded without it, and the step fails though the smoke passed (exit 1)" \
    "[ $rc -eq 1 ] && has \"secret-shaped lines in the $label's output: 2\" && has \"secret-shaped text reached the $label's output (2 lines)\""
  srun SMOKE_EXIT=3 -- "$step" --version 0.1.0 --release "$sm_rel" --work "$tmp/$step-exit3"
  check "$step: the smoke's exit code kept (3, through the pipe)" "[ $rc -eq 3 ] && has \"the $label failed (exit 3)\""
  srun SMOKE_EXIT=2 SMOKE_SAYS_SECRET=1 -- "$step" --version 0.1.0 --release "$sm_rel" --work "$tmp/$step-exit2"
  check "$step: a smoke failing (exit 2) and printing a secret-shaped value: its code kept, the lines counted" \
    "[ $rc -eq 2 ] && has \"secret-shaped lines in the $label's output: 2\""
done

# --- helm-login (stand-in helm) ------------------------------------------------------------
mkdir -p "$tmp/hbin" "$tmp/runner"
cat >"$tmp/hbin/helm" <<HELM
#!/bin/bash
printf '%s\n' "\$*" >>"$logs/helm-argv.log"
cat >"$logs/helm-stdin"
mkdir -p "\$(dirname "\$HELM_REGISTRY_CONFIG")"
if [ -n "\${HELM_STANDIN_CREDSSTORE:-}" ]; then
  printf '{"auths":{"ghcr.io":{}},"credsStore":"secretservice"}\n' >"\$HELM_REGISTRY_CONFIG"
else
  printf '{"auths":{"ghcr.io":{"auth":"x"}}}\n' >"\$HELM_REGISTRY_CONFIG"
fi
HELM
chmod +x "$tmp/hbin/helm"
token="ghs_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
HL=("${ACTIONS[@]}" PATH="$tmp/hbin:$PATH" RUNNER_TEMP="$tmp/runner" GHCR_USER=telflo-bot)
run "${HL[@]}" -- helm-login
check "helm-login without GHCR_TOKEN: refused (exit 2)" "[ $rc -eq 2 ]"
run "${HL[@]}" GHCR_TOKEN="$token" HELM_REGISTRY_CONFIG="$tmp/elsewhere/config.json" -- helm-login
check "helm-login with HELM_REGISTRY_CONFIG outside RUNNER_TEMP: refused (exit 2)" "[ $rc -eq 2 ] && has 'under RUNNER_TEMP'"
run "${HL[@]}" GHCR_TOKEN="$token" HELM_REGISTRY_CONFIG="$tmp/runner/helm/registry/config.json" -- helm-login
check "helm-login: helm registry login ghcr.io --username telflo-bot --password-stdin (exit 0)" \
  "[ $rc -eq 0 ] && grep -qxF 'registry login ghcr.io --username telflo-bot --password-stdin' '$logs/helm-argv.log'"
check "helm-login: the token went through stdin, never argv or output (boolean)" \
  "[ \"\$(cat '$logs/helm-stdin')\" = '$token' ] && ! grep -qF '$token' '$logs/helm-argv.log' && ! has '$token'"
run "${HL[@]}" HELM_STANDIN_CREDSSTORE=1 GHCR_TOKEN="$token" HELM_REGISTRY_CONFIG="$tmp/runner/helm2/config.json" -- helm-login
check "helm-login, a configuration naming a credential store: exit 1" "[ $rc -eq 1 ]"

# --- github-release (stand-in gh) ----------------------------------------------------------
gh_oci="$tmp/gh-oci"; mkdir -p "$gh_oci"
n=1; for i in api web otelcol-validator otelcol-testing ottl-evaluator; do printf 'sha256:%064d\n' "$n" >"$gh_oci/$i.digest"; n=$((n + 1)); done
mkdir -p "$tmp/chartsrc/telflo"
printf 'apiVersion: v2\nname: telflo\nversion: 0.1.0\nappVersion: "0.1.0"\n' >"$tmp/chartsrc/telflo/Chart.yaml"
(cd "$tmp/chartsrc" && tar -czf "$rel/telflo-0.1.0.tgz" telflo)
mkdir -p "$tmp/gbin"
# The stand-in gh: `api` answers GitHub's git/ref and git/tags replies for v0.1.0 (its tag object
# naming $GH_STANDIN_COMMIT), `release view` (absent unless GH_STANDIN_EXISTS) and `release create`.
gr_commit=0123456789abcdef0123456789abcdef01234567
gr_tag_sha=fedcba9876543210fedcba9876543210fedcba98
cat >"$tmp/gbin/gh" <<GH
#!/bin/bash
printf '%s\n' "\$*" >>"$logs/gh.log"
case "\$1 \$2" in
  "api --hostname")
    case "\${!#}" in
      repos/telflo/telflo/git/ref/tags/v0.1.0) printf '{"ref":"refs/tags/v0.1.0","object":{"sha":"%s","type":"tag"}}\n' "$gr_tag_sha" ;;
      repos/telflo/telflo/git/tags/$gr_tag_sha) printf '{"sha":"%s","tag":"v0.1.0","object":{"sha":"%s","type":"commit"}}\n' "$gr_tag_sha" "\$GH_STANDIN_COMMIT" ;;
      *) echo "UNEXPECTED \$*" >>"$logs/gh.log"; exit 97 ;;
    esac
    exit 0 ;;
  "release view") [ -n "\${GH_STANDIN_EXISTS:-}" ] && exit 0; echo "release not found" >&2; exit 1 ;;
  "release create") exit 0 ;;
esac
exit 97
GH
chmod +x "$tmp/gbin/gh"
GR=("${ACTIONS[@]}" PATH="$tmp/gbin:$PATH" GITHUB_REPOSITORY=telflo/telflo GH_TOKEN="$token" GH_STANDIN_COMMIT="$gr_commit")
run "${GR[@]}" GITHUB_REPOSITORY=telflo/telflo-platform -- github-release --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release for another repository: refused (exit 2)" "[ $rc -eq 2 ]"
run "${GR[@]}" -- github-release --tag 0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release with a tag that isn't v<x.y.z>: refused (exit 2)" "[ $rc -eq 2 ]"
for bad in "" abc "${gr_commit}0" "$(printf '%s' "$gr_commit" | tr a-f A-F)"; do
  run "${GR[@]}" -- github-release --tag v0.1.0 --commit "$bad" --oci "$gh_oci" --release "$rel"
  check "github-release with --commit '$bad' (not 40 hex): refused (exit 2)" "[ $rc -eq 2 ] && has '--commit must be'"
done
rm -f "$logs/gh.log"
run "${GR[@]}" -- github-release --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
# shellcheck disable=SC2034 # read by check's eval
create_line="$(grep '^release create' "$logs/gh.log" 2>/dev/null || true)"
check "github-release: gh release create v0.1.0 --verify-tag, with the archive, create-secrets.sh and SHA256SUMS (exit 0)" \
  "[ $rc -eq 0 ] && printf '%s' \"\$create_line\" | grep -qE '^release create v0\\.1\\.0 --repo telflo/telflo --verify-tag --title Telflo 0\\.1\\.0 --notes-file [^ ]+ $rel/telflo-compose-0\\.1\\.0\\.tar\\.gz $rel/create-secrets\\.sh $rel/SHA256SUMS\$'"
check "github-release: a normal release, never --draft or --prerelease; no token on argv" \
  "! grep -qE -- '--draft|--prerelease' '$logs/gh.log' && ! grep -qF '$token' '$logs/gh.log'"
check "github-release: GitHub's API asked for the tag's ref, then its tag object, before the Release was made" \
  "[ \"\$(grep -n '' '$logs/gh.log' | grep -E 'git/ref/tags/v0\\.1\\.0\$' | cut -d: -f1)\" = 1 ] && [ \"\$(grep -n '' '$logs/gh.log' | grep -E 'git/tags/$gr_tag_sha\$' | cut -d: -f1)\" = 2 ] \
   && [ \"\$(grep -n '^release create' '$logs/gh.log' | cut -d: -f1)\" -gt 2 ]"
rm -f "$logs/gh.log"
run "${GR[@]}" GH_STANDIN_COMMIT=1111111111111111111111111111111111111111 -- github-release --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release when the tag on GitHub now tags another commit than the version job's: refused (exit 1), no Release made" \
  "[ $rc -eq 1 ] && has \"v0.1.0 on GitHub tags another commit than the version job's $gr_commit\" && has 'no Release made' && ! grep -q '^release ' '$logs/gh.log'"
run "${GR[@]}" GH_TOKEN= -- github-release --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release without GH_TOKEN: refused (exit 2)" "[ $rc -eq 2 ]"
run "${GR[@]}" GH_STANDIN_EXISTS=1 -- github-release --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release when the Release exists already: refused, never made twice (exit 1)" "[ $rc -eq 1 ] && has 'never made twice'"
cp "$rel/create-secrets.sh" "$tmp/cs.keep"; printf '# changed\n' >>"$rel/create-secrets.sh"
run "${GR[@]}" -- github-release --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release with a file that doesn't match SHA256SUMS: exit 1, no Release" "[ $rc -eq 1 ] && has \"create-secrets.sh doesn't match SHA256SUMS\""
cp "$tmp/cs.keep" "$rel/create-secrets.sh"

# --- github-release --draft (stand-in gh): the stage's draft, with its record --------------------
record_of() { # <oci dir> <chart digest> <package sha256>: a stage's digests.txt
  printf 'api %s\notelcol-testing %s\notelcol-validator %s\nottl-evaluator %s\nweb %s\ncharts/telflo %s\ncharts/telflo.tgz %s\n' \
    "$(cat "$1/api.digest")" "$(cat "$1/otelcol-testing.digest")" "$(cat "$1/otelcol-validator.digest")" \
    "$(cat "$1/ottl-evaluator.digest")" "$(cat "$1/web.digest")" "$2" "$3"
}
chart_sum="sha256:$(sha "$rel/telflo-0.1.0.tgz")"
SEVENS=sha256:7777777777777777777777777777777777777777777777777777777777777777
: >"$logs/gh.log"
run "${GR[@]}" -- github-release --draft --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release --draft without <release>/digests.txt: refused (exit 1), no Release" \
  "[ $rc -eq 1 ] && has \"digests.txt is missing or isn't a stage's record\" && ! grep -q '^release ' '$logs/gh.log'"
record_of "$gh_oci" "$SEVENS" "$chart_sum" | sed 's/^web .*/web sha256:9999999999999999999999999999999999999999999999999999999999999999/' >"$rel/digests.txt"
run "${GR[@]}" -- github-release --draft --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release --draft with a record whose image digest isn't this run's: refused (exit 1), no Release" \
  "[ $rc -eq 1 ] && has \"digests.txt's web isn't\" && ! grep -q '^release ' '$logs/gh.log'"
record_of "$gh_oci" "$SEVENS" "$SEVENS" >"$rel/digests.txt"
run "${GR[@]}" -- github-release --draft --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
check "github-release --draft with a record whose package isn't this chart's: refused (exit 1), no Release" \
  "[ $rc -eq 1 ] && has \"digests.txt's charts/telflo.tgz isn't\" && ! grep -q '^release ' '$logs/gh.log'"
record_of "$gh_oci" "$SEVENS" "$chart_sum" >"$rel/digests.txt"
: >"$logs/gh.log"
run "${GR[@]}" -- github-release --draft --tag v0.1.0 --commit "$gr_commit" --oci "$gh_oci" --release "$rel"
# shellcheck disable=SC2034 # read by check's eval
create_line="$(grep '^release create' "$logs/gh.log" 2>/dev/null || true)"
check "github-release --draft: gh release create v0.1.0 --verify-tag --draft, with the three files and digests.txt (exit 0)" \
  "[ $rc -eq 0 ] && printf '%s' \"\$create_line\" | grep -qE '^release create v0\\.1\\.0 --repo telflo/telflo --verify-tag --draft --title Telflo 0\\.1\\.0 --notes-file [^ ]+ $rel/telflo-compose-0\\.1\\.0\\.tar\\.gz $rel/create-secrets\\.sh $rel/SHA256SUMS $rel/digests\\.txt\$' && has 'the finalize workflow publishes it'"
check "github-release --draft: never a prerelease, the tag asked of GitHub first, no token on argv" \
  "! grep -q -- '--prerelease' '$logs/gh.log' && [ \"\$(grep -n '' '$logs/gh.log' | grep -E 'git/ref/tags/v0\\.1\\.0\$' | cut -d: -f1)\" = 1 ] && ! grep -qF '$token' '$logs/gh.log'"
rm -f "$rel/digests.txt"

# --- digests: refusals ---------------------------------------------------------------------
run -- digests --oci "$gh_oci" --version 0.1 --chart "$rel/telflo-0.1.0.tgz" --out "$tmp/d.txt"
check "digests with a bad version: refused (exit 2)" "[ $rc -eq 2 ]"
run -- digests --oci "$tmp/no-such" --version 0.1.0 --chart "$rel/telflo-0.1.0.tgz" --out "$tmp/d.txt"
check "digests without the digest files' folder: refused (exit 2)" "[ $rc -eq 2 ]"
run -- digests --oci "$gh_oci" --version 0.1.0 --chart "$rel/telflo-0.1.0.tgz" --out "$tmp/d.txt" --registry docker.io
check "digests --registry docker.io: refused (exit 2)" "[ $rc -eq 2 ]"
: >"$tmp/exists.txt"
run -- digests --oci "$gh_oci" --version 0.1.0 --chart "$rel/telflo-0.1.0.tgz" --out "$tmp/exists.txt"
check "digests onto a file that exists: refused, never overwritten (exit 1)" "[ $rc -eq 1 ] && has 'never overwritten' && [ ! -s '$tmp/exists.txt' ]"

# --- finalize-check, finalize-publish (a throwaway repository, stand-in gh) -----------------------
# The repository: main holds charts/telflo/Chart.yaml at 0.1.0, tagged v0.1.0 (annotated), and a
# branch off main holds 0.2.0, tagged v0.2.0; a clone of it (origin/main) holds steps.sh and its
# helpers. The stand-in gh answers GitHub's API (the tag's ref and object, the latest Release)
# and `gh release view/download/edit` from the files in $FZ (the draft's state and digests.txt).
g() { git -c user.name=steps-test -c user.email=steps-test@example.invalid -c tag.gpgSign=false -c commit.gpgSign=false \
  -c init.defaultBranch=main -c core.hooksPath=/dev/null "$@"; }
fsrc="$tmp/fin-src"
g init -q "$fsrc"
mkdir -p "$fsrc/charts/telflo"
printf 'apiVersion: v2\nname: telflo\nversion: 0.1.0\nappVersion: "0.1.0"\n' >"$fsrc/charts/telflo/Chart.yaml"
g -C "$fsrc" add -A && g -C "$fsrc" commit -qm one
fc1="$(g -C "$fsrc" rev-parse HEAD)"
g -C "$fsrc" tag -a v0.1.0 -m "telflo 0.1.0"
g -C "$fsrc" checkout -q -b side
printf 'apiVersion: v2\nname: telflo\nversion: 0.2.0\nappVersion: "0.2.0"\n' >"$fsrc/charts/telflo/Chart.yaml"
g -C "$fsrc" commit -qam two
fc2="$(g -C "$fsrc" rev-parse HEAD)"
g -C "$fsrc" tag -a v0.2.0 -m "telflo 0.2.0"
g -C "$fsrc" checkout -q main
fin="$tmp/fin"
g clone -q "$fsrc" "$fin"
g -C "$fin" fetch -q --tags origin
mkdir -p "$fin/scripts/release"
for f in steps.sh version.sh oci.sh github-tag.sh; do cp "$root/scripts/release/$f" "$fin/scripts/release/"; done
FZ="$tmp/fz"; mkdir -p "$FZ" "$tmp/fzbin"
ftag_sha=abababababababababababababababababababab
cat >"$tmp/fzbin/gh" <<'GH'
#!/bin/bash
printf '%s\n' "$*" >>"$FZ/gh.log"
case "$1 $2" in
  "api --hostname")
    case "${!#}" in
      repos/telflo/telflo/git/ref/tags/v*) t="${!#}"; t="${t##*/}"
        printf '{"ref":"refs/tags/%s","object":{"sha":"%s","type":"tag"}}\n' "$t" "$FZ_TAG_SHA" ;;
      repos/telflo/telflo/git/tags/*) printf '{"sha":"%s","tag":"%s","object":{"sha":"%s","type":"commit"}}\n' "$FZ_TAG_SHA" "$FZ_TAG" "$FZ_COMMIT" ;;
      repos/telflo/telflo/releases/latest)
        [ -f "$FZ/latest" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
        printf '{"tag_name":"%s"}\n' "$(cat "$FZ/latest")" ;;
      *) echo "UNEXPECTED $*" >>"$FZ/gh.log"; exit 97 ;;
    esac ;;
  "release view")
    [ -f "$FZ/state" ] || { echo "release not found" >&2; exit 1; }
    assets='[]'; [ ! -f "$FZ/digests.txt" ] || assets='[{"name":"telflo-compose-0.1.0.tar.gz"},{"name":"digests.txt"}]'
    printf '{"tagName":"%s","isDraft":%s,"assets":%s}\n' "$3" "$([ "$(cat "$FZ/state")" = draft ] && echo true || echo false)" "$assets" ;;
  "release download")
    dir=""; while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
    mkdir -p "$dir" && cp "$FZ/digests.txt" "$dir/digests.txt" ;;
  "release edit") echo published >"$FZ/state" ;;
  *) echo "UNEXPECTED $*" >>"$FZ/gh.log"; exit 97 ;;
esac
GH
chmod +x "$tmp/fzbin/gh"
export FZ
FIN=("${ACTIONS[@]}" PATH="$tmp/fzbin:$PATH" GITHUB_REPOSITORY=telflo/telflo GH_TOKEN="$token" FZ_TAG_SHA="$ftag_sha" FZ_TAG=v0.1.0 FZ_COMMIT="$fc1")
frun() { # <env assignments...> -- <args...>: the clone's steps.sh; sets rc, out
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  : >"$FZ/gh.log"
  out="$(env TMPDIR="$tmp/t" DOCKER_CONFIG="$tmp/stub" ${envs[@]+"${envs[@]}"} "$shell" "$fin/scripts/release/steps.sh" "$@" 2>&1 </dev/null)"; rc=$?
}
fz_reset() { rm -f "$FZ/latest" "$FZ/digests.txt"; echo draft >"$FZ/state"; record_of "$gh_oci" "$SEVENS" "$chart_sum" >"$FZ/digests.txt"; rm -rf "$tmp/fout"; mkdir -p "$tmp/fout"; }
fz_reset
frun -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check outside Actions: refused (exit 2)" "[ $rc -eq 2 ] && has 'GitHub Actions job only'"
frun "${FIN[@]}" GITHUB_REPOSITORY=telflo/other -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check for another repository: refused (exit 2)" "[ $rc -eq 2 ]"
frun "${FIN[@]}" GH_TOKEN= -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check without GH_TOKEN: refused (exit 2)" "[ $rc -eq 2 ] && has 'GH_TOKEN must be set'"
for bad in 0.1 v0.1.0 "\$(echo EXPANDED)"; do
  frun "${FIN[@]}" -- finalize-check --version "$bad" --out "$tmp/fout"
  check "finalize-check --version '$bad': refused (exit 2), nothing expanded" "[ $rc -eq 2 ] && ! has EXPANDED && [ ! -s '$FZ/gh.log' ]"
done
frun "${FIN[@]}" -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check: the tag on main, annotated on GitHub, the draft's digests.txt downloaded into <out> (exit 0)" \
  "[ $rc -eq 0 ] && cmp -s '$tmp/fout/digests.txt' '$FZ/digests.txt' && has 'v0.1.0 is the annotated tag $ftag_sha of $fc1, on main' && [ \"\$(printf '%s\n' \"\$out\" | tail -n 1)\" = '$tmp/fout/digests.txt' ]"
frun "${FIN[@]}" -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check again: <out>/digests.txt never overwritten (exit 1)" "[ $rc -eq 1 ] && has 'never overwritten'"
fz_reset; rm -f "$FZ/state"
frun "${FIN[@]}" -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check with no draft Release: refused (exit 1), nothing downloaded" "[ $rc -eq 1 ] && has 'there is no draft Release v0.1.0' && [ ! -e '$tmp/fout/digests.txt' ]"
fz_reset; echo published >"$FZ/state"
frun "${FIN[@]}" -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check when the Release is published already: refused (exit 1)" "[ $rc -eq 1 ] && has 'published already: nothing to finalize'"
fz_reset; rm -f "$FZ/digests.txt"
frun "${FIN[@]}" -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check with a draft that holds no digests.txt: refused (exit 1)" "[ $rc -eq 1 ] && has 'holds no digests.txt'"
fz_reset; sed -i.bak '1d' "$FZ/digests.txt"; rm -f "$FZ/digests.txt.bak"
frun "${FIN[@]}" -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check with a draft whose digests.txt isn't a stage's record: refused (exit 1), nothing written" \
  "[ $rc -eq 1 ] && has \"isn't a stage's record\" && [ ! -e '$tmp/fout/digests.txt' ]"
fz_reset
frun "${FIN[@]}" FZ_COMMIT="$fc2" -- finalize-check --version 0.1.0 --out "$tmp/fout"
check "finalize-check when GitHub's tag names another commit than the checkout's: refused (exit 1), the Release not asked" \
  "[ $rc -eq 1 ] && has 'tags another commit' && ! grep -q '^release ' '$FZ/gh.log'"
frun "${FIN[@]}" FZ_TAG=v0.2.0 FZ_COMMIT="$fc2" -- finalize-check --version 0.2.0 --out "$tmp/fout"
check "finalize-check for a tag whose commit isn't on main: refused (exit 1), GitHub not asked" \
  "[ $rc -eq 1 ] && has \"v0.2.0's commit $fc2 isn't on main\" && [ ! -s '$FZ/gh.log' ]"
frun "${FIN[@]}" -- finalize-check --version 0.3.0 --out "$tmp/fout"
check "finalize-check for a version with no tag: refused (exit 1)" "[ $rc -eq 1 ] && has 'the checkout has no tag v0.3.0'"

fz_reset; cp "$FZ/digests.txt" "$tmp/promoted.txt"
frun "${FIN[@]}" -- finalize-publish --version 0.1.0 --digests "$tmp/promoted.txt"
check "finalize-publish, no Release latest yet: gh release edit v0.1.0 --draft=false --latest=true, then published (exit 0)" \
  "[ $rc -eq 0 ] && grep -qx 'release edit v0.1.0 --repo telflo/telflo --draft=false --latest=true' '$FZ/gh.log' && [ \"\$(cat '$FZ/state')\" = published ] && has 'is published (latest: true)'"
fz_reset; echo v0.2.0 >"$FZ/latest"
frun "${FIN[@]}" -- finalize-publish --version 0.1.0 --digests "$tmp/promoted.txt"
check "finalize-publish when the latest Release is a higher version (a patch of an older line): --latest=false (exit 0)" \
  "[ $rc -eq 0 ] && grep -qx 'release edit v0.1.0 --repo telflo/telflo --draft=false --latest=false' '$FZ/gh.log' && has 'a higher version'"
fz_reset; echo v0.0.9 >"$FZ/latest"
frun "${FIN[@]}" -- finalize-publish --version 0.1.0 --digests "$tmp/promoted.txt"
check "finalize-publish when the latest Release is a lower version: --latest=true (exit 0)" \
  "[ $rc -eq 0 ] && grep -qx 'release edit v0.1.0 --repo telflo/telflo --draft=false --latest=true' '$FZ/gh.log'"
fz_reset; sed 's/^web .*/web sha256:9999999999999999999999999999999999999999999999999999999999999999/' "$FZ/digests.txt" >"$tmp/promoted-other.txt"
frun "${FIN[@]}" -- finalize-publish --version 0.1.0 --digests "$tmp/promoted-other.txt"
check "finalize-publish when the draft's digests.txt isn't the promoted record: refused (exit 1), not published" \
  "[ $rc -eq 1 ] && has \"isn't the record that was promoted\" && ! grep -q '^release edit' '$FZ/gh.log' && [ \"\$(cat '$FZ/state')\" = draft ]"
fz_reset; echo published >"$FZ/state"
frun "${FIN[@]}" -- finalize-publish --version 0.1.0 --digests "$tmp/promoted.txt"
check "finalize-publish when the Release is no longer a draft: refused (exit 1), no edit" "[ $rc -eq 1 ] && has 'no longer a draft' && ! grep -q '^release edit' '$FZ/gh.log'"
check "finalize: no token on gh's argv" "! grep -qF '$token' '$FZ/gh.log'"

# --- abandon-stage (stand-in gh: the owner's packages API and Releases) ---------------------------
# Each package's versions are $AB/<package, its / as %2F>.json (absent: 404); the Release v0.1.0
# is $AB/release (draft or published; absent: not found). Every call is logged.
AB="$tmp/ab"; mkdir -p "$AB" "$tmp/abbin"
cat >"$tmp/abbin/gh" <<'GH'
#!/bin/bash
printf '%s\n' "$*" >>"$AB/gh.log"
case "$1" in
  api)
    path="${!#}"
    case " $* " in
      *" -X DELETE "*) [ ! -f "$AB/delete-fails" ] || { echo "gh: Forbidden (HTTP 403)" >&2; exit 1; }; exit 0 ;;
    esac
    [ ! -f "$AB/api-fails" ] || { echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; }
    package="${path#orgs/telflo/packages/container/}"; package="${package%%/versions*}"
    [ -f "$AB/$package.json" ] || { echo "gh: Package not found. (HTTP 404)" >&2; exit 1; }
    cat "$AB/$package.json" ;;
  release)
    case "$2" in
      view) [ -f "$AB/release" ] || { echo "release not found" >&2; exit 1; }
        printf '{"tagName":"%s","isDraft":%s,"assets":[]}\n' "$3" "$([ "$(cat "$AB/release")" = draft ] && echo true || echo false)" ;;
      delete) exit 0 ;;
      *) exit 97 ;;
    esac ;;
  *) exit 97 ;;
esac
GH
chmod +x "$tmp/abbin/gh"
export AB
AR=(PATH="$tmp/abbin:$PATH")
hex() { printf '%064d' "$1"; }
# versions <file> <id:tag[,tag]...>...: a page of package versions (two pages when a fifth is given).
versions() {
  local file="$1" item id tags first=true
  shift
  {
    printf '['
    for item in "$@"; do
      id="${item%%:*}"; tags="${item#*:}"
      $first || printf ','; first=false
      printf '{"id":%s,"name":"sha256:%s","metadata":{"package_type":"container","container":{"tags":[%s]}}}' \
        "$id" "$(hex "$id")" "$(printf '%s' "$tags" | sed 's/[^,][^,]*/"&"/g')"
    done
    printf ']\n'
  } >"$file"
}
ab_reset() {
  rm -f "$AB"/*.json "$AB/release" "$AB/gh.log" "$AB/api-fails" "$AB/delete-fails"
  local name n=10
  for name in api otelcol-testing otelcol-validator ottl-evaluator web; do
    versions "$AB/telflo%2F$name.json" "$n:0.0.9"
    versions "$AB/telflo-staging%2F$name.json" "$((n + 1)):0.1.0" "$((n + 2)):0.0.8"
    n=$((n + 10))
  done
  versions "$AB/telflo%2Fcharts%2Ftelflo.json" "90:0.0.9"
  # The staged chart; and beside the staged api, a referrers fallback tag naming its digest.
  versions "$AB/telflo-staging%2Fcharts%2Ftelflo.json" "91:0.1.0"
  versions "$AB/telflo-staging%2Fapi.json" "11:0.1.0" "12:0.0.8" "13:sha256-$(hex 11)"
  echo draft >"$AB/release"
}
deletes() { grep -c -- '-X DELETE' "$AB/gh.log" 2>/dev/null || true; }
ab_reset
run "${ACTIONS[@]}" "${AR[@]}" -- abandon-stage --version 0.1.0
check "abandon-stage in a GitHub Actions job: refused (exit 2), nothing asked" "[ $rc -eq 2 ] && has 'a workflow never abandons a stage' && [ ! -s '$AB/gh.log' ]"
for bad in 0.1 v0.1.0 "\$(echo EXPANDED)"; do
  run "${AR[@]}" -- abandon-stage --version "$bad"
  check "abandon-stage --version '$bad': refused (exit 2), nothing asked" "[ $rc -eq 2 ] && ! has EXPANDED && [ ! -s '$AB/gh.log' ]"
done
run "${AR[@]}" -- abandon-stage --version 0.1.0 --dry-run
check "abandon-stage --dry-run: what it would delete listed (the six staged versions, the fallback tag's, the draft), nothing deleted (exit 0)" \
  "[ $rc -eq 0 ] && [ \$(deletes) -eq 0 ] && [ \$(printf '%s\n' \"\$out\" | grep -c 'to delete: ghcr.io/telflo/telflo-staging/') -eq 7 ] && has 'to delete: the draft Release v0.1.0' && has 'dry run: nothing deleted' && ! grep -q '^release delete' '$AB/gh.log'"
run "${AR[@]}" -- abandon-stage --version 0.1.0
# shellcheck disable=SC2034 # read by check's eval
want_deletes="$(for p in api:11 api:13 otelcol-testing:21 otelcol-validator:31 ottl-evaluator:41 web:51 charts%2Ftelflo:91; do
  echo "api --hostname github.com -H Accept: application/vnd.github+json -X DELETE orgs/telflo/packages/container/telflo-staging%2F${p%%:*}/versions/${p#*:}"; done)"
check "abandon-stage: each staged version tagged 0.1.0 deleted (and the fallback tag's beside api), never another version or a public one (exit 0)" \
  "[ $rc -eq 0 ] && [ \"\$(grep -- '-X DELETE' '$AB/gh.log')\" = \"\$want_deletes\" ]"
check "abandon-stage: the draft Release deleted, never its tag; the owner told to delete the tag" \
  "grep -qx 'release delete v0.1.0 --repo telflo/telflo --yes' '$AB/gh.log' && ! grep -q -- '--cleanup-tag' '$AB/gh.log' && has 'git push origin :refs/tags/v0.1.0'"
check "abandon-stage: every public package asked before anything was deleted" \
  "[ \"\$(grep -n 'container/telflo%2F' '$AB/gh.log' | tail -n 1 | cut -d: -f1)\" -lt \"\$(grep -n -- '-X DELETE' '$AB/gh.log' | head -n 1 | cut -d: -f1)\" ]"
ab_reset; versions "$AB/telflo%2Fweb.json" "50:0.0.9" "52:0.1.0"
run "${AR[@]}" -- abandon-stage --version 0.1.0
check "abandon-stage when a public image holds the version: refused (exit 1), spent, nothing deleted" \
  "[ $rc -eq 1 ] && has 'ghcr.io/telflo/telflo/web:0.1.0 is public' && has 'nothing deleted' && [ \$(deletes) -eq 0 ] && ! grep -q '^release delete' '$AB/gh.log'"
ab_reset; echo published >"$AB/release"
run "${AR[@]}" -- abandon-stage --version 0.1.0
check "abandon-stage when the Release is published: refused (exit 1), nothing deleted" \
  "[ $rc -eq 1 ] && has 'the Release v0.1.0 is published' && [ \$(deletes) -eq 0 ]"
ab_reset; versions "$AB/telflo-staging%2Fweb.json" "51:0.1.0,keep" "52:0.0.8"
run "${AR[@]}" -- abandon-stage --version 0.1.0
check "abandon-stage when a staged version holds another tag too: refused (exit 1), nothing deleted" \
  "[ $rc -eq 1 ] && has 'also holds the tag(s) keep' && [ \$(deletes) -eq 0 ]"
ab_reset; rm -f "$AB/telflo-staging%2Fottl-evaluator.json"; printf '[]\n' >"$AB/telflo-staging%2Fweb.json"
run "${AR[@]}" -- abandon-stage --version 0.1.0
check "abandon-stage with a staged package missing (404) or holding no 0.1.0: the rest deleted (exit 0)" \
  "[ $rc -eq 0 ] && has 'there is no package telflo-staging/ottl-evaluator' && has 'telflo-staging/web holds no version tagged 0.1.0' && [ \$(deletes) -eq 5 ]"
ab_reset; printf '[{"id":1,"name":"sha256:%s","metadata":{"container":{"tags":["0.1.0"]}}}][{"id":2,"name":"sha256:%s","metadata":{"container":{"tags":["0.0.1"]}}}]\n' "$(hex 1)" "$(hex 2)" >"$AB/telflo-staging%2Fweb.json"
run "${AR[@]}" -- abandon-stage --version 0.1.0 --dry-run
check "abandon-stage reads every page gh --paginate gives (two JSON arrays)" "[ $rc -eq 0 ] && has 'telflo-staging/web version 1 '"
ab_reset; printf '{"message":"x"}\n' >"$AB/telflo-staging%2Fweb.json"
run "${AR[@]}" -- abandon-stage --version 0.1.0
check "abandon-stage with an answer that isn't a list of versions: refused (exit 1), nothing deleted" "[ $rc -eq 1 ] && has \"isn't a list of versions\" && [ \$(deletes) -eq 0 ]"
ab_reset; : >"$AB/api-fails"
run "${AR[@]}" -- abandon-stage --version 0.1.0
check "abandon-stage when GitHub's API fails (not a 404): refused (exit 1), nothing deleted" "[ $rc -eq 1 ] && has \"didn't answer for the package\" && [ \$(deletes) -eq 0 ]"
ab_reset; for f in "$AB"/telflo-staging*.json; do printf '[]\n' >"$f"; done; rm -f "$AB/release"
run "${AR[@]}" -- abandon-stage --version 0.1.0
check "abandon-stage with nothing staged and no draft: nothing to abandon (exit 0)" "[ $rc -eq 0 ] && has 'nothing to abandon' && [ \$(deletes) -eq 0 ]"

# --- against a throwaway registry: collector-archive, chart-if-new --------------------------
reg_ok=false
real_crane="$("$shell" "$root/scripts/release/tools.sh" path crane 2>/dev/null || command -v crane 2>/dev/null || true)"
if tr_tools "$root" && [ -n "$real_crane" ] && command -v helm >/dev/null 2>&1; then
  if tr_registry_start "$tmp/registry"; then reg_ok=true; else TR_SKIP="the throwaway registry didn't start"; fi
fi
if $reg_ok; then
  REG="$TR_REGISTRY"
  RC=(TELFLO_CRANE="$real_crane" DOCKER_CONFIG="$TR_CONFIG")
  mkdir -p "$tmp/ca"
  run "${RC[@]}" -- collector-archive --out "$tmp/ca" --registry "$REG"
  check "collector-archive, the default collector absent: exit 1, 'run the collector workflow'" \
    "[ $rc -eq 1 ] && has 'run the collector workflow for $default' && [ -z \"\$(ls -A '$tmp/ca')\" ]"
  want="$(tr_fixture "$tmp/c.oci.tar" "$default" 0123456789abcdef0123456789abcdef01234567 C)"
  tr_put "$tmp/c.oci.tar" "$REG/telflo/telflo/collector:$default" "$real_crane" "$TR_CONFIG"
  : >"$tmp/gh-out"
  run "${RC[@]}" GITHUB_OUTPUT="$tmp/gh-out" -- collector-archive --out "$tmp/ca" --registry "$REG"
  check "collector-archive: collector-<v>.oci.tar and .digest written, the registry's index digest, collector_version= in GITHUB_OUTPUT (exit 0)" \
    "[ $rc -eq 0 ] && [ \"\$(cat '$tmp/ca/collector-$default.digest')\" = '$want' ] && grep -qxF 'collector_version=$default' '$tmp/gh-out'"
  check "collector-archive: its archive passes oci.sh's checks against that digest and version" \
    "TELFLO_OCI_PREFIX=t TELFLO_OCI_TMP='$tmp/t' '$shell' -c '. \"\$1\"; telflo_oci_inspect \"\$2\" \"\$3\" \"\$4\" \"\"' _ '$root/scripts/release/oci.sh' '$tmp/ca/collector-$default.oci.tar' '$want' '$default' >/dev/null 2>&1"
  run "${RC[@]}" -- collector-archive --out "$tmp/ca" --registry "$REG"
  check "collector-archive again: refused, never overwritten (exit 1)" "[ $rc -eq 1 ] && has 'never overwritten'"
  mkdir -p "$tmp/cn"
  run "${RC[@]}" HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" -- chart-if-new --out "$tmp/cn" --registry "$REG"
  check "chart-if-new, absent: packaged and pushed (exit 0)" "[ $rc -eq 0 ] && [ -f '$tmp/cn/supervisor-collector-$chart_version.tgz' ]"
  pushed="$(DOCKER_CONFIG="$TR_CONFIG" "$real_crane" digest "$REG/telflo/telflo/charts/supervisor-collector:$chart_version" 2>/dev/null || true)"
  check "chart-if-new: the registry holds the chart's version" "[ -n '$pushed' ]"
  mkdir -p "$tmp/cn2"
  run "${RC[@]}" HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" -- chart-if-new --out "$tmp/cn2" --registry "$REG"
  check "chart-if-new again: a notice, nothing packaged (exit 0)" "[ $rc -eq 0 ] && has 'is published already' && [ -z \"\$(ls -A '$tmp/cn2')\" ]"
  # digests: the stage's record, the chart's digest read from the stage.
  dg="$tmp/dg"; mkdir -p "$dg/chart/telflo/templates"
  printf 'apiVersion: v2\nname: telflo\nversion: 0.1.0\nappVersion: "0.1.0"\n' >"$dg/chart/telflo/Chart.yaml"
  printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n' >"$dg/chart/telflo/templates/cm.yaml"
  (cd "$dg/chart" && helm package telflo --destination "$dg" >/dev/null)
  run "${RC[@]}" -- digests --oci "$gh_oci" --version 0.1.0 --chart "$dg/telflo-0.1.0.tgz" --out "$dg/digests.txt" --registry "$REG"
  check "digests, the chart not staged: exit 1, nothing written" "[ $rc -eq 1 ] && has \"the chart isn't staged\" && [ ! -e '$dg/digests.txt' ]"
  HELM_REGISTRY_CONFIG="$TR_CONFIG/config.json" helm push --plain-http "$dg/telflo-0.1.0.tgz" "oci://$REG/telflo/telflo-staging/charts" >/dev/null 2>&1
  staged_chart="$(DOCKER_CONFIG="$TR_CONFIG" "$real_crane" digest "$REG/telflo/telflo-staging/charts/telflo:0.1.0" 2>/dev/null)"
  run "${RC[@]}" -- digests --oci "$gh_oci" --version 0.1.0 --chart "$dg/telflo-0.1.0.tgz" --out "$dg/digests.txt" --registry "$REG"
  check "digests: a stage's record written: the images' digest files, the staged chart's OCI digest, its package's sha256 (exit 0)" \
    "[ $rc -eq 0 ] && [ \"\$(cat '$dg/digests.txt')\" = \"\$(record_of '$gh_oci' '$staged_chart' 'sha256:$(sha "$dg/telflo-0.1.0.tgz")')\" ] && has '$REG/telflo/telflo-staging/charts/telflo:0.1.0 $staged_chart'"
  "$shell" "$root/scripts/release/release-notes.sh" --oci "$gh_oci" --chart "$dg/telflo-0.1.0.tgz" --version 0.1.0 >"$dg/notes.md" 2>/dev/null
  notes_match=true
  for i in api otelcol-testing otelcol-validator ottl-evaluator web; do
    grep -qF "| \`ghcr.io/telflo/telflo/$i:0.1.0\` | \`$(awk -v n="$i" '$1 == n { print $2 }' "$dg/digests.txt")\` |" "$dg/notes.md" || notes_match=false
  done
  grep -qF "(package sha256 \`$(awk '$1 == "charts/telflo.tgz" { print $2 }' "$dg/digests.txt" | sed 's/^sha256://')\`)" "$dg/notes.md" || notes_match=false
  check "digests.txt reads back exactly what release-notes.sh names: each image's index digest, the chart's package sha256" "$notes_match"
  mkdir -p "$dg/other"; cp -R "$dg/chart" "$dg/other/"; printf '# other\n' >>"$dg/other/chart/telflo/templates/cm.yaml"
  (cd "$dg/other/chart" && helm package telflo --destination "$dg/other" >/dev/null)
  run "${RC[@]}" -- digests --oci "$gh_oci" --version 0.1.0 --chart "$dg/other/telflo-0.1.0.tgz" --out "$dg/other.txt" --registry "$REG"
  check "digests with another package of the version than the staged one: refused (exit 1), nothing written" \
    "[ $rc -eq 1 ] && has \"chart layer is\" && [ ! -e '$dg/other.txt' ]"
  check "no file of the test's folders or output holds the registry's login (boolean)" "! tr_secret_in '$tmp/ca' '$tmp/cn' '$tmp/t' '$logs' && ! { printf '%s' \"\$out\" >'$tmp/out.txt'; tr_secret_in '$tmp/out.txt'; }"
else
  for c in "collector-archive" "chart-if-new against a registry"; do skip "$c" "${TR_SKIP:-no crane or helm}"; done
fi
tr_registry_stop

# --- collector-test: with a stand-in docker that answers as the image's two binaries do ------
# (the real supervisor has no version flag: `--version` exits 2; -help prints its usage, exit 0).
if command -v helm >/dev/null 2>&1; then
  mkdir -p "$tmp/ctbin"
  cat >"$tmp/ctbin/docker" <<STANDIN
#!/bin/bash
printf '%s\n' "\$*" >>"$logs/ct-docker.log"
case "\$*" in
  "image inspect "*) exit 0 ;;
  *"--entrypoint /app/otelcol-contrib "*" --version") echo "otelcol-contrib version \${CT_VERSION:-0.0.0}"; exit 0 ;;
  *"--entrypoint /app/supervisor "*" -help") printf 'Usage of /app/supervisor:\n  -config string\n    \tPath to a supervisor configuration file\n'; exit 0 ;;
  *"--entrypoint /app/supervisor "*) echo "flag provided but not defined: \${*: -1}" >&2; exit 2 ;;
  *) echo "UNEXPECTED \$*" >&2; exit 97 ;;
esac
STANDIN
  chmod +x "$tmp/ctbin/docker"
  run PATH="$tmp/ctbin:$PATH" CT_VERSION="$default" -- collector-test --version "$default"
  check "collector-test: both binaries asked as they answer (otelcol-contrib --version, the supervisor -help), the chart linted (exit 0)" \
    "[ $rc -eq 0 ] && has 'the chart lints and renders it' && grep -q -- '--network none --entrypoint /app/supervisor ghcr.io/telflo/telflo/collector:$default -help\$' '$logs/ct-docker.log' && ! grep -q -- '/app/supervisor .* --version' '$logs/ct-docker.log'"
  check "collector-test: the loaded image run as it is, the engine's own platform (no --platform)" \
    "[ \$(grep -c '^run ' '$logs/ct-docker.log') -eq 2 ] && ! grep -q -- '--platform' '$logs/ct-docker.log'"
  : >"$logs/ct-docker.log"
  run PATH="$tmp/ctbin:$PATH" CT_VERSION=9.9.9 -- collector-test --version "$default"
  check "collector-test: otelcol-contrib naming another version fails (exit 1)" "[ $rc -eq 1 ] && has \"doesn't name $default\""
  run -- collector-test --version v1
  check "collector-test --version v1: refused (exit 2)" "[ $rc -eq 2 ]"
else
  skip "collector-test" "helm isn't on PATH"
fi

check "no credential helper was called" "[ ! -s '$logs/helper.log' ]"
echo
if [ "$failures" -eq 0 ]; then if [ "$skips" -gt 0 ]; then echo "ALL PASS ($skips skipped)"; else echo "ALL PASS"; fi; else echo "$failures FAILURE(S)"; exit 1; fi
