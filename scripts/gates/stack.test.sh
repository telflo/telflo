#!/usr/bin/env bash
# stack.sh's and smoke-env.sh's self-test, with `--dry-run` only: nothing
# starts, nothing is pulled. Each case runs stack.sh on a throwaway git
# repository holding this tree's real docker-compose.yml and the
# opamp-server's PIN (committed there: stack.sh copies only what is
# committed), into a work folder of its own:
#   - `--images dev-tag:<tag>` writes the copy and the remapped file, every
#     telflo image on the tag, no override; `--images release:<version>`
#     writes the override naming ghcr.io/telflo/telflo/<name>:<version> with
#     `pull_policy: never` on every Telflo service, and the five names;
#   - every published port is 127.0.0.1's, as the file says and as
#     `docker compose config` reads it (client side; SKIP without docker);
#   - the three refused project names (stack.sh's: the projects that are
#     never a throwaway) exit 2 before anything is written; so do bad --images values;
#   - an unknown published port and a fixed container name fail the copy;
#   - smoke-env.sh exports the ports from --port-base and refuses a site
#     other than the stack's;
#   - no credential helper is called.
#
# Run: bash scripts/gates/stack.test.sh   (STACK_SH=<path> tests another copy)
# Offline; bash 3.2 compatible; PASS/FAIL/SKIP lines; exit 1 when any failed.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STACK_SH="${STACK_SH:-$SCRIPT_DIR/stack.sh}"
SMOKE_ENV="$(dirname "$STACK_SH")/smoke-env.sh"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/stack-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
tmp="$(cd "$tmp" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
case "$tmp" in *[!A-Za-z0-9._/-]*) echo "self-test: TMPDIR's path must be letters, digits, '.', '_', '-' and '/' only" >&2; exit 2 ;; esac

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
skip() { echo "SKIP - $1"; }
have_docker=0
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && have_docker=1

# fixture <name> [<extra compose text>]: a committed throwaway repository
# holding docker-compose.yml (plus the extra text appended) and the PIN.
fixture() {
  local f="$tmp/repo-$1"
  mkdir -p "$f/vendor/opamp-server" || return 1
  cp "$REPO_DIR/docker-compose.yml" "$f/docker-compose.yml" || return 1
  cp "$REPO_DIR/vendor/opamp-server/PIN" "$f/vendor/opamp-server/PIN" || return 1
  [ -z "${2:-}" ] || printf '%s\n' "$2" >>"$f/docker-compose.yml"
  git -C "$f" init -q &&
    git -C "$f" add -A &&
    git -C "$f" -c user.name=stack-test -c user.email=stack-test@example.invalid -c commit.gpgsign=false commit -q -m fixture || return 1
  echo "$f"
}
# stack <work-name> <args...>: stack.sh's dry run, its output in $out, its exit status in $rc.
stack() {
  local w="$tmp/$1"; shift
  work=$w
  out="$w.out"
  TMPDIR="$tmp" bash "$STACK_SH" "$@" --work "$w" --dry-run >"$out" 2>&1
  rc=$?
}

repo=$(fixture main) || { echo "self-test: no fixture repository" >&2; exit 2; }
PORT_LINE='^[[:space:]]+- "([0-9.]+:)?[0-9]+:[0-9]+"[[:space:]]*$'

# --- dev-tag ---------------------------------------------------------------
stack dev up --project stack-test-dev --images dev-tag:gates-test --site saas --port-base 40000 --tree "$repo"
dev_work=$work; dev_rc=$rc
f="$dev_work/stack/docker-compose.yml"
run_case "dev-tag: the dry run exits 0" [ "$dev_rc" = 0 ]
run_case "dev-tag: the copy holds the tree's committed files" test -f "$dev_work/stack/vendor/opamp-server/PIN" -a -f "$dev_work/stack/docker-compose.head.yml"
dev_images() {
  grep -Eq '^[[:space:]]+image:[[:space:]]*telflo-api:gates-test[[:space:]]*$' "$f" &&
    ! grep -Eq '^[[:space:]]+image:[[:space:]]*telflo-[a-z-]+:dev' "$f" &&
    [ "$(grep -cE '^[[:space:]]+image:[[:space:]]*telflo-[a-z-]+:' "$f")" = "$(grep -cE '^[[:space:]]+image:[[:space:]]*telflo-[a-z-]+:dev' "$dev_work/stack/docker-compose.head.yml")" ]
}
run_case "dev-tag: every telflo image on the tag, none left on :dev" dev_images
run_case "dev-tag: no release override" test ! -e "$dev_work/stack/docker-compose.release.yml"
ports_loopback() { # <file>: as many port lines as HEAD's, each 127.0.0.1:<port>:<port>
  local n
  n=$(grep -cE "$PORT_LINE" "$1")
  [ "$n" -gt 0 ] && [ "$n" = "$(grep -cE "$PORT_LINE" "$REPO_DIR/docker-compose.yml")" ] &&
    [ "$(grep -E "$PORT_LINE" "$1" | grep -cE '^[[:space:]]+- "127\.0\.0\.1:[0-9]+:[0-9]+"')" = "$n" ]
}
run_case "dev-tag: every published port in the file is 127.0.0.1's" ports_loopback "$f"
gateway_port() { grep -qE '^[[:space:]]+- "127\.0\.0\.1:40009:80"' "$f" && ! grep -q 'localhost:50080' "$f" && grep -q 'TELFLO_PUBLIC_WEB_URL: http://localhost:40009' "$f"; }
run_case "dev-tag: the gateway on --port-base + 9, the public web URL with it" gateway_port
config_loopback() { # <work> <compose files...>: docker compose config's every published port on 127.0.0.1
  local w=$1 args="" cfg published loopback; shift
  for x in "$@"; do args="$args -f $x"; done
  # shellcheck disable=SC2086
  cfg=$(DOCKER_CONFIG="$w/docker-config" COMPOSE_PROFILES=s3 docker compose -p stack-test-config $args config 2>/dev/null) || return 1
  published=$(printf '%s\n' "$cfg" | grep -c '^[[:space:]]*published:')
  loopback=$(printf '%s\n' "$cfg" | grep -c '^[[:space:]]*host_ip: 127\.0\.0\.1$')
  [ "$published" -gt 0 ] && [ "$published" = "$loopback" ] &&
    [ "$(printf '%s\n' "$cfg" | grep -c '^[[:space:]]*host_ip:')" = "$loopback" ]
}
if [ "$have_docker" = 1 ]; then
  run_case "dev-tag: docker compose config reads every published port on 127.0.0.1 (the s3 profile's too)" config_loopback "$dev_work" "$f"
else
  skip "dev-tag: docker compose config (no docker CLI)"
fi
conf_ok() { grep -qx 'PROJECT=stack-test-dev' "$dev_work/stack.conf" && grep -qx 'PORT_BASE=40000' "$dev_work/stack.conf" && grep -qx 'SITE=saas' "$dev_work/stack.conf"; }
run_case "dev-tag: stack.conf records the project, port base and site" conf_ok
run_case "dev-tag: the dry run names up -d --no-build on its project, never --wait" \
  sh -c 'grep -q "^would run: docker compose -p stack-test-dev .* up -d --no-build$" "$1" && ! grep -q -- "--wait" "$1"' sh "$dev_work.out"

# --- release ---------------------------------------------------------------
stack rel up --project stack-test-rel --images release:0.1.0 --site oss --tree "$repo"
rel_work=$work
o="$rel_work/stack/docker-compose.release.yml"
run_case "release: the dry run exits 0" [ "$rc" = 0 ]
release_override() {
  local name services
  [ -f "$o" ] || return 1
  for name in api web otelcol-validator otelcol-testing ottl-evaluator; do
    grep -qE "^    image: ghcr\.io/telflo/telflo/$name:0\.1\.0\$" "$o" || return 1
  done
  services=$(grep -cE '^  [a-z0-9-]+:$' "$o")
  [ "$services" -ge 5 ] &&
    [ "$(grep -c '^    pull_policy: never$' "$o")" = "$services" ] &&
    [ "$(grep -c '^    image: ' "$o")" = "$services" ] &&
    [ "$services" = "$(grep -cE '^[[:space:]]+image:[[:space:]]*telflo-[a-z-]+:dev' "$rel_work/stack/docker-compose.yml")" ] &&
    ! grep -Eq 'ghcr\.io/telflo/platform|telflo/telflo/collector' "$o"
}
run_case "release: the override names ghcr.io/telflo/telflo/<name>:0.1.0 with pull_policy: never on every Telflo service" release_override
run_case "release: every published port in the file is 127.0.0.1's" ports_loopback "$rel_work/stack/docker-compose.yml"
run_case "release: the dry run names both files and --no-build" \
  sh -c 'grep -q "^would run: docker compose -p stack-test-rel -f .*/docker-compose.yml -f .*/docker-compose.release.yml up -d --no-build$" "$1"' sh "$rel_work.out"
release_config() {
  local images
  images=$(DOCKER_CONFIG="$rel_work/docker-config" docker compose -p stack-test-config -f "$rel_work/stack/docker-compose.yml" -f "$o" config --images 2>/dev/null) || return 1
  ! printf '%s\n' "$images" | grep -Eq '^telflo-[a-z-]+:' &&
    [ "$(printf '%s\n' "$images" | grep -E '^ghcr\.io/telflo/telflo/' | sort -u | wc -l | tr -d ' ')" = 5 ]
}
if [ "$have_docker" = 1 ]; then
  run_case "release: docker compose config runs only the five release images of Telflo's" release_config
  run_case "release: docker compose config reads every published port on 127.0.0.1" config_loopback "$rel_work" "$rel_work/stack/docker-compose.yml" "$o"
else
  skip "release: docker compose config (no docker CLI)"
fi

# --- refusals --------------------------------------------------------------
refused() { # <work-name> <args...>: exit 2, nothing written
  stack "$@"
  [ "$rc" = 2 ] && [ ! -e "$work" ]
}
for name in telflo telflo-dev telflo-platform; do
  run_case "the project $name is refused before anything is written" refused "refused-$name" up --project "$name" --images dev-tag:x --site oss --tree "$repo"
  run_case "the project $name is refused by down" refused "refused-down-$name" down --project "$name"
done
for images in release:v0.1.0 release:0.1.0-rc.1 release:01.0.0 dev-tag: latest; do
  run_case "--images $images is refused" refused "refused-images-$(printf '%s' "$images" | tr -c 'A-Za-z0-9' '_')" up --project stack-test-x --images "$images" --site oss --tree "$repo"
done
run_case "--site other is refused" refused refused-site up --project stack-test-x --images dev-tag:x --site other --tree "$repo"
run_case "ready without a stack is refused" refused refused-ready ready --project stack-test-x
reused_differently() {
  stack dev up --project stack-test-dev --images dev-tag:other --site saas --tree "$repo"
  [ "$rc" = 2 ]
}
run_case "a work folder's stack isn't reused with other images" reused_differently

unknown_port_repo=$(fixture unknown-port '  stack-test-extra:
    image: nginx:1.27-alpine
    ports:
      - "12345:80"')
unknown_port() {
  stack unknown-port up --project stack-test-x --images dev-tag:x --site oss --tree "$unknown_port_repo"
  [ "$rc" = 1 ] && grep -q 'an unknown published port 12345' "$out"
}
run_case "an unknown published port fails the copy, named" unknown_port
container_name_repo=$(fixture container-name '  stack-test-extra:
    image: nginx:1.27-alpine
    container_name: fixed-name')
container_name() {
  stack container-name up --project stack-test-x --images dev-tag:x --site oss --tree "$container_name_repo"
  [ "$rc" = 1 ] && grep -q 'keys that reach past the project' "$out"
}
run_case "a fixed container name fails the copy" container_name

# --- smoke-env.sh ----------------------------------------------------------
smoke_env_ports() {
  (
    # shellcheck disable=SC1090
    . "$SMOKE_ENV" saas "$dev_work" >/dev/null || exit 1
    [ "$COMPOSE_PROJECT_NAME" = stack-test-dev ] &&
      [ "$TELFLO_GATEWAY_URL" = http://localhost:40009 ] &&
      [ "$TELFLO_MAILPIT_API_URL" = http://localhost:40003 ] &&
      [ "$TELFLO_OPAMP_AGENT_HOST_URL" = http://127.0.0.1:40005 ] &&
      [ "$TELFLO_OPAMP_REPLICA_HOST_PORT" = 40010 ] &&
      [ "$TELFLO_SMOKE_SITE" = saas ] && [ "$TELFLO_REGISTRATION" = open ] &&
      [ "$TELFLO_SMOKE_FILE_STORE" = local ] && [ -z "${COMPOSE_PROFILES:-}" ] &&
      [ "$TMPDIR" = "$dev_work/smoke-tmp" ] && [ "$COMPOSE_FILE" = "$dev_work/stack/docker-compose.yml" ]
  )
}
run_case "smoke-env.sh saas: the project, the ports from --port-base, the site's values" smoke_env_ports
smoke_env_oss() {
  (
    # shellcheck disable=SC1090
    . "$SMOKE_ENV" oss "$rel_work" >/dev/null || exit 1
    [ "$TELFLO_SMOKE_SITE" = oss ] && [ "$TELFLO_REGISTRATION" = invite-only ] && [ "$TELFLO_PLAYGROUND" = false ] &&
      [ -z "$TELFLO_TERMS_VERSION" ] && [ "$TELFLO_GATEWAY_URL" = http://localhost:33609 ] &&
      [ "$COMPOSE_FILE" = "$rel_work/stack/docker-compose.yml:$rel_work/stack/docker-compose.release.yml" ]
  )
}
run_case "smoke-env.sh oss: the open-source defaults, both compose files" smoke_env_oss
# shellcheck disable=SC1090
smoke_env_wrong_site() { ( . "$SMOKE_ENV" oss "$dev_work" >/dev/null 2>&1 ); [ "$?" = 2 ]; }
run_case "smoke-env.sh refuses a site other than the stack's" smoke_env_wrong_site
# shellcheck disable=SC1090
smoke_env_usage() { ( . "$SMOKE_ENV" local "$dev_work" >/dev/null 2>&1 ); [ "$?" = 2 ]; }
run_case "smoke-env.sh refuses a mode other than oss and saas" smoke_env_usage

no_helper() { [ ! -s "$dev_work/helper.log" ] && [ ! -s "$rel_work/helper.log" ]; }
run_case "no docker credential helper was called" no_helper

echo "stack.test.sh: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
