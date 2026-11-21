#!/usr/bin/env bash
# smoke-compose-install.sh's self-test: its refusals only.
# Each case runs the smoke in a throwaway copy (the smoke, quick-start.sh,
# version.sh, setup.sh and the catalog at their places, and a README.md:
# the real one, or one changed per case) and checks it exits 2 with the
# refusal's words, before anything starts: no folder of the run's made (the
# README's commands never ran), and no container, volume or network of the
# case's project. The cases:
#   no argument, an unknown option, an option without its value (usage);
#   --project naming each project that is never a throwaway (refused before
#   any folder is made), a project name with other characters;
#   a port of a developer's own stack, a README default, the same port twice;
#   a relative --work, a --work that isn't empty, one with a space;
#   an archive not named telflo-compose-<x.y.z>.tar.gz, one without
#   compose.yaml, one whose compose.yaml doesn't name a Telflo image at its
#   version, one whose compose.yaml names an image through another variable
#   than ${TELFLO_IMAGE_REGISTRY:-ghcr.io/telflo/telflo}/;
#   README.md without its begin marker, without its end marker, with
#   you@example.com twice in the commands, without its bootstrap command,
#   at another version than the archive's, with a command naming
#   TELFLO_IMAGE_REGISTRY;
#   an image missing from the engine (a release at 9.9.9, whose images no
#   engine holds: the real `docker image inspect`, asked for the default
#   registry's name, ghcr.io/telflo/telflo/<name>:9.9.9, even with the
#   caller's TELFLO_IMAGE_REGISTRY set; SKIP when no Docker engine answers).
#
# Run: scripts/smoke-compose-install.test.sh
# Prints PASS/FAIL/SKIP lines only; exit 1 when any case failed. It starts
# nothing: every docker call (the smoke's own, and this test's look for the
# engine) runs with a DOCKER_CONFIG of the test's holding no login. The
# copies live in a temporary directory removed on exit. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/smoke-compose-install-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
tmp="$(cd "$tmp" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/docker-config"
printf '{"auths":{"telflo-agent.invalid":{}}}\n' >"$tmp/docker-config/config.json"
export DOCKER_CONFIG="$tmp/docker-config"

passed=0
failed=0
skipped=0
n=0
PROJECT="smoke-cit-$$"

# The real tree's release version (its Chart.yaml): the copied README.md and compose.yaml name it.
VERSION="$(awk '$1 == "version:" { print $2; exit }' "$REPO_DIR/charts/telflo/Chart.yaml")"
[ -n "$VERSION" ] || { echo "no version in $REPO_DIR/charts/telflo/Chart.yaml" >&2; exit 1; }
# fresh: a new copy in $c with the real README.md; $c/release holds a sound archive ($VERSION, the real
# compose.yaml) and SHA256SUMS.
fresh() {
  n=$((n + 1)); c="$tmp/case$n"
  mkdir -p "$c/tree/scripts/release" "$c/tree/deploy/compose" "$c/tree/catalog/distributions" "$c/release" || return 1
  cp "$REPO_DIR/scripts/smoke-compose-install.sh" "$c/tree/scripts/" &&
    cp "$REPO_DIR/scripts/release/quick-start.sh" "$REPO_DIR/scripts/release/version.sh" "$c/tree/scripts/release/" &&
    cp "$REPO_DIR/deploy/compose/setup.sh" "$c/tree/deploy/compose/" &&
    cp "$REPO_DIR/catalog/distributions/otelcol-contrib.json" "$c/tree/catalog/distributions/" &&
    cp "$REPO_DIR/README.md" "$c/tree/README.md" || return 1
  make_archive "$VERSION" "$REPO_DIR/deploy/compose/compose.yaml"
}
# make_archive <version> <compose file>: $c/release/telflo-compose-<version>.tar.gz holding that compose.yaml, and
# SHA256SUMS beside it.
make_archive() {
  mkdir -p "$c/archive/telflo-compose-$1" &&
    cp "$2" "$c/archive/telflo-compose-$1/compose.yaml" &&
    tar -czf "$c/release/telflo-compose-$1.tar.gz" -C "$c/archive" "telflo-compose-$1" &&
    (cd "$c/release" && { shasum -a 256 "telflo-compose-$1.tar.gz" 2>/dev/null || sha256sum "telflo-compose-$1.tar.gz"; } >SHA256SUMS)
}

# smoke <args...>: the copy's smoke, its exit code in $code, its output in $c/out.
smoke() {
  code=0
  bash "$c/tree/scripts/smoke-compose-install.sh" "$@" >"$c/out" 2>&1 || code=$?
}
# args [<archive version>]: the usual arguments, a new work folder and the case's project.
args() {
  local version=${1:-$VERSION}
  set -- --archive "$c/release/telflo-compose-$version.tar.gz" --sums "$c/release/SHA256SUMS" --work "$c/work" \
    --project "$PROJECT" --http-port 33960 --agent-port 33961 --mailpit-port 33962
  printf '%s\n' "$@"
}
run_args() {
  local list=() line
  while IFS= read -r line; do list+=("$line"); done <<EOF
$(args "${1:-$VERSION}")
EOF
  shift || true
  smoke "${list[@]}" "$@"
}

# nothing_started: no run folder, no README download, and (when Docker answers) nothing of the project.
docker_answers=no
if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then docker_answers=yes; fi
nothing_started() {
  [ ! -e "$c/work/run" ] && [ ! -e "$c/work/release" ] || return 1
  if [ "$docker_answers" = yes ]; then
    [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ] &&
      [ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ] &&
      [ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ] || return 1
  fi
  return 0
}
# expect_refused <name> <words>: exit 2, the output holding <words>, nothing started.
expect_refused() {
  local name=$1 words=$2
  if [ "$code" = 2 ] && grep -qF -- "$words" "$c/out" && nothing_started; then
    echo "PASS - $name"; passed=$((passed + 1))
  else
    echo "FAIL - $name (exit $code; wanted 2 and \"$words\")"; sed 's/^/    | /' "$c/out" | tail -n 5; failed=$((failed + 1))
  fi
}
skip() { echo "SKIP - $1"; skipped=$((skipped + 1)); }

# ---- Usage.
fresh; smoke; expect_refused "no argument: usage" "--archive is required"
fresh; smoke --archive x --sums y --work /z --bogus=1; expect_refused "an unknown option, named up to its =" "unknown argument --bogus"
fresh; smoke --archive; expect_refused "an option without its value" "--archive needs a value"
fresh; smoke --archive "$c/release/telflo-compose-$VERSION.tar.gz" --sums "$c/release/SHA256SUMS"; expect_refused "no --work" "--work is required"

# ---- The project: the three names refused before any folder is made.
for project in telflo telflo-dev telflo-platform; do
  fresh; run_args "$VERSION" --project "$project"
  if [ ! -e "$c/work" ]; then
    expect_refused "--project $project refused, no work folder made" "never a throwaway project"
  else
    echo "FAIL - --project $project made the work folder"; failed=$((failed + 1))
  fi
done
fresh; run_args "$VERSION" --project 'Bad Name'; expect_refused "a project name with capitals and a space" "--project must be lower-case"

# ---- Ports.
fresh; run_args "$VERSION" --mailpit-port 58025; expect_refused "a developer's own Mailpit port" "port 58025 is"
fresh; run_args "$VERSION" --http-port 8080; expect_refused "the README's gateway port" "port 8080 is"
fresh; run_args "$VERSION" --agent-port 33960; expect_refused "the same port twice" "must differ"

# ---- The work folder.
fresh; run_args "$VERSION" --work relative/work; expect_refused "a relative --work" "--work must be an absolute path"
fresh; mkdir -p "$c/work" && : >"$c/work/kept"; run_args; expect_refused "a --work that isn't empty" "isn't empty"
fresh; run_args "$VERSION" --work "$c/with space"; expect_refused "a --work with a space" "--work must be letters"

# ---- The archive.
fresh; cp "$c/release/telflo-compose-$VERSION.tar.gz" "$c/release/compose.tar.gz"
run_args "$VERSION" --archive "$c/release/compose.tar.gz"; expect_refused "an archive not named telflo-compose-<version>.tar.gz" "--archive must be named"
fresh; rm -rf "$c/archive"; mkdir -p "$c/archive/telflo-compose-$VERSION" && : >"$c/archive/telflo-compose-$VERSION/README.md" &&
  tar -czf "$c/release/telflo-compose-$VERSION.tar.gz" -C "$c/archive" "telflo-compose-$VERSION"
run_args; expect_refused "an archive without compose.yaml" "holds no telflo-compose-$VERSION/compose.yaml"
fresh; rm -rf "$c/archive" "$c/release"/*; mkdir -p "$c/release"
sed "s#ghcr.io/telflo/telflo}/web:$VERSION#ghcr.io/telflo/telflo}/web:9.9.8#" "$REPO_DIR/deploy/compose/compose.yaml" >"$c/compose.yaml"
make_archive "$VERSION" "$c/compose.yaml"
run_args; expect_refused "an archive whose compose.yaml names web at another version" "doesn't name ghcr.io/telflo/telflo/web:$VERSION"
fresh; rm -rf "$c/archive" "$c/release"/*; mkdir -p "$c/release"
sed 's#{TELFLO_IMAGE_REGISTRY:-\(ghcr.io/telflo/telflo}/web:\)#{TELFLO_REGISTRY:-\1#' "$REPO_DIR/deploy/compose/compose.yaml" >"$c/compose.yaml"
make_archive "$VERSION" "$c/compose.yaml"
run_args; expect_refused "an archive whose compose.yaml names web through another variable" "names an image through a variable other than as \${TELFLO_IMAGE_REGISTRY:-ghcr.io/telflo/telflo}/<name>:<version>"

# ---- README.md's Quick start.
fresh; grep -v '^<!-- quick-start:begin -->$' "$REPO_DIR/README.md" >"$c/tree/README.md"
run_args; expect_refused "README.md without its begin marker" "Quick start can't be read"
fresh; grep -v '^<!-- quick-start:end -->$' "$REPO_DIR/README.md" >"$c/tree/README.md"
run_args; expect_refused "README.md without its end marker" "Quick start can't be read"
fresh; sed 's#^docker compose exec -T api telflo-admin bootstrap --email you@example.com#& --email you@example.com#' \
  "$REPO_DIR/README.md" >"$c/tree/README.md"
run_args; expect_refused "you@example.com twice in the commands" "don't hold you@example.com exactly once"
fresh; awk '/telflo-admin bootstrap/ { print "# (removed)"; next } { print }' "$REPO_DIR/README.md" >"$c/tree/README.md"
run_args; expect_refused "no bootstrap command (nor its email and organization)" "exactly once"
# at_9_9_9 <compose file>: the real compose.yaml with every Telflo image at 9.9.9.
# shellcheck disable=SC2016 # Compose's ${...}, matched as text
at_9_9_9() { sed 's#^\(    image: "${TELFLO_IMAGE_REGISTRY:-ghcr\.io/telflo/telflo}/[a-z-]*:\)[0-9][0-9.]*"$#\19.9.9"#' "$REPO_DIR/deploy/compose/compose.yaml" >"$1"; }
fresh; at_9_9_9 "$c/compose.yaml"
make_archive 9.9.9 "$c/compose.yaml"
run_args 9.9.9; expect_refused "README.md (v$VERSION) at another version than the archive's (9.9.9)" "isn't v9.9.9's"
fresh; sed 's#^docker compose up -d$#TELFLO_IMAGE_REGISTRY=registry.example.com/telflo docker compose up -d#' "$REPO_DIR/README.md" >"$c/tree/README.md"
run_args; expect_refused "a Quick start command naming TELFLO_IMAGE_REGISTRY" "the Quick start's commands name TELFLO_IMAGE_REGISTRY"

# ---- An image missing from the engine: a release at 9.9.9 (the README and compose.yaml both), whose images no
# engine holds, so the real docker image inspect answers none.
if [ "$docker_answers" = yes ]; then
  fresh; sed "s#${VERSION//./\\.}#9.9.9#g" "$REPO_DIR/README.md" >"$c/tree/README.md"
  at_9_9_9 "$c/compose.yaml"
  make_archive 9.9.9 "$c/compose.yaml"
  TELFLO_IMAGE_REGISTRY=registry.example.com/telflo run_args 9.9.9
  expect_refused "a release image missing from the engine, never pulled" "isn't in the local engine: this smoke never pulls one"
  grep -q 'ghcr.io/telflo/telflo/[a-z-]*:9.9.9 isn' "$c/out" && { echo "PASS - the refusal names the missing image, by the default registry's name (the caller's TELFLO_IMAGE_REGISTRY not read)"; passed=$((passed + 1)); } ||
    { echo "FAIL - the refusal doesn't name the missing image by the default registry's name"; failed=$((failed + 1)); }
  if [ -s "$c/work/credential-helpers.log" ]; then
    echo "FAIL - a docker credential helper was called"; failed=$((failed + 1))
  else
    echo "PASS - no docker credential helper called"; passed=$((passed + 1))
  fi
else
  skip "a release image missing from the engine (no Docker engine answers)"
fi

echo "smoke-compose-install.test.sh: $passed passed, $failed failed, $skipped skipped"
[ "$failed" = 0 ]
