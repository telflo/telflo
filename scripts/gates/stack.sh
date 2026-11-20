#!/usr/bin/env bash
# stack.sh: the throwaway Compose stack the stack smoke runs on, never a
# developer's own running stack, the development stack or a user's install:
# it refuses the projects `telflo` (the Compose install's), `telflo-dev`
# (docker-compose.yml's) and `telflo-platform` (a developer's own running
# stack's).
#
#   stack.sh up    --project <name> --work <dir> --images dev-tag:<tag>|release:<version>
#                  --site oss|saas [--file-store local|s3] [--port-base <n>] [--tree <dir>] [--dry-run]
#   stack.sh ready --project <name> --work <dir> [--file-store local|s3] [--dry-run]
#   stack.sh down  --project <name> --work <dir> [--dry-run]
#
# up: the first time, a git-archive copy of the tree's HEAD into
# <work>/stack (only committed files: never another change in the working
# tree), its docker-compose.yml rewritten:
#   - every published host port on 127.0.0.1, remapped from --port-base
#     (default 33600) as smoke-env.sh reads them:
#       +1 db (55432)            +2 Mailpit SMTP (51025)   +3 Mailpit HTTP (58025)
#       +4 opamp management (51235)   +5 opamp agent (51234)
#       +6 validator (51236)     +7 tester's forwarder (51237)
#       +8 evaluator's forwarder (51238)   +9 gateway (50080)
#       +10 the smoke's replica (none here)   +11 object store (51240)
#     and localhost:50080 / host.docker.internal:50080 follow the gateway;
#     an unknown published port, a long-syntax port, a container_name, an
#     `external:` or a named volume or network stops it (each would reach
#     past the project);
#   - the images: `dev-tag:<tag>` re-tags every `telflo-<name>:dev` to
#     `:<tag>`; `release:<version>` keeps the file and writes
#     docker-compose.release.yml beside it, naming
#     ghcr.io/telflo/telflo/<name>:<version> with `pull_policy: never` on
#     every Telflo service.
# <work>/stack.conf records the project, port base, site, images, file
# store and compose files (smoke-env.sh reads it); a later `up` on the same
# work folder reuses the copy (the same project, images, site and port base;
# --file-store may change, which recreates the API on that store). Then, with
# smoke-env.sh's settings exported (the site's values among them): every
# image the project would run must be local (none is pulled or built: `up`
# runs with --no-build), the pinned opamp-server's revision label must be
# the PIN's commit, `docker compose up -d` (never --wait: Compose 2.6.0
# hangs), then `ready`.
# ready: polls the gateway until /login answers 200 and /api/v1/auth/me 401
# (STACK_READY_ATTEMPTS, default 120, five seconds apart), then checks the
# API's file store and the site's values in the API and web (compared, never
# printed).
# down: `down -v` with every profile's services, then nothing of the project
# left (containers, volumes, networks). The work folder stays.
# --dry-run: writes the copy, the rewritten file, the override and
# stack.conf, reads them back with `docker compose config` (client side
# only), prints the commands it would run and starts nothing.
#
# Every docker call runs with DOCKER_CONFIG a folder of <work> holding no
# login, and refusing docker-credential-* stand-ins first on PATH; a call to
# one fails the run. Exit 0 done, 1 failed, 2 usage or refused.
# bash 3.2 compatible.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_TREE="$(cd "$SCRIPT_DIR/../.." && pwd)"
RELEASE_REGISTRY=ghcr.io/telflo/telflo
RELEASE_NAMES="api web otelcol-validator otelcol-testing ottl-evaluator"
SITE_VARIABLES="TELFLO_REGISTRATION TELFLO_PLAYGROUND TELFLO_ANONYMOUS_VALIDATE TELFLO_PUBLIC_FLOWS TELFLO_TERMS_VERSION TELFLO_TERMS_URL TELFLO_PRIVACY_URL TELFLO_SALES_INQUIRY TELFLO_SALES_INQUIRY_TO TELFLO_EMAIL_NOTIFICATIONS"

usage() {
  sed -n 's/^#   stack\.sh /stack.sh /p' "$0" >&2
  exit 2
}
refuse() { echo "stack.sh: refused: $*" >&2; exit 2; }
fail() { echo "stack.sh: FAIL: $*" >&2; exit 1; }
say() { echo "stack.sh: $*"; }

action=${1:-}
case "$action" in up|ready|down) shift ;; *) usage ;; esac

project="" work="" images="" site="" file_store="" port_base="" tree="" dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--work|--images|--site|--file-store|--port-base|--tree)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --project) project=$2 ;;
        --work) work=$2 ;;
        --images) images=$2 ;;
        --site) site=$2 ;;
        --file-store) file_store=$2 ;;
        --port-base) port_base=$2 ;;
        --tree) tree=$2 ;;
      esac
      shift 2
      ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "stack.sh: unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$project" ] || usage
[ -n "$work" ] || usage
case "$project" in
  telflo|telflo-dev|telflo-platform)
    refuse "the project $project is never a throwaway stack (the Compose install's, the development stack's or the owner's)" ;;
esac
printf '%s' "$project" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' || refuse "--project must be lower-case letters, digits, '_' and '-'"
# The smoke's install steps mount folders under the work folder: its path is
# letters, digits, '.', '_', '-' and '/' only.
case "$work" in /*) ;; *) refuse "--work must be an absolute path" ;; esac
printf '%s' "$work" | grep -Eq '^[A-Za-z0-9._/-]+$' || refuse "--work must be letters, digits, '.', '_', '-' and '/' only"
case "$images" in
  "") ;;
  dev-tag:*) printf '%s' "${images#dev-tag:}" | grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$' || refuse "--images dev-tag:<tag>: not a tag" ;;
  release:*) printf '%s' "${images#release:}" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || refuse "--images release:<version>: the version is x.y.z" ;;
  *) refuse "--images is dev-tag:<tag> or release:<version>" ;;
esac
case "$site" in ""|oss|saas) ;; *) refuse "--site is oss or saas" ;; esac
case "$file_store" in ""|local|s3) ;; *) refuse "--file-store is local or s3" ;; esac
if [ -n "$port_base" ]; then
  printf '%s' "$port_base" | grep -Eq '^[1-9][0-9]{3,4}$' && [ "$port_base" -ge 1024 ] && [ "$port_base" -le 65400 ] ||
    refuse "--port-base is a number from 1024 to 65400"
fi

conf="$work/stack.conf"
stack="$work/stack"
conf_get() { sed -n "s/^$1=//p" "$conf" 2>/dev/null | head -n 1; }

# --- the copy -----------------------------------------------------------------

# port_offset <host port>: the published port's place after --port-base.
remap_ports() { # <base> <in> <out>: exit 1 on a port it doesn't know
  awk -v base="$1" '
    function offset(h) {
      if (h == "55432") return 1; if (h == "51025") return 2; if (h == "58025") return 3
      if (h == "51235") return 4; if (h == "51234") return 5; if (h == "51236") return 6
      if (h == "51237") return 7; if (h == "51238") return 8; if (h == "50080") return 9
      if (h == "51240") return 11
      return -1
    }
    /^[[:space:]]+- "([0-9.]+:)?[0-9]+:[0-9]+(\/(tcp|udp))?"[[:space:]]*$/ {
      q = index($0, "\""); rest = substr($0, q + 1); spec = substr(rest, 1, index(rest, "\"") - 1)
      k = split(spec, part, ":")
      if (k == 3) { host = part[2]; ctr = part[3] } else { host = part[1]; ctr = part[2] }
      o = offset(host)
      if (o < 0) { print "stack.sh: an unknown published port " host " (map it in stack.sh and smoke-env.sh)" > "/dev/stderr"; bad = 1; print; next }
      print substr($0, 1, q - 1) "\"127.0.0.1:" (base + o) ":" ctr "\""
      next
    }
    {
      gsub(/localhost:50080/, "localhost:" (base + 9))
      gsub(/host\.docker\.internal:50080/, "host.docker.internal:" (base + 9))
      print
    }
    END { exit bad }
  ' "$2" >"$3"
}

# release_services <compose file>: "<service> <image>" for every service whose
# image is a telflo-<name>:dev build.
release_services() {
  awk '
    /^services:[[:space:]]*$/ { in_services = 1; next }
    /^[^[:space:]#]/ { in_services = 0 }
    in_services && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { service = $1; sub(/:$/, "", service) }
    in_services && /^[[:space:]]+image:[[:space:]]*telflo-[a-z-]+:dev[[:space:]]*$/ { print service, $2 }
  ' "$1"
}

generate() {
  local commit head new status=0 port_lines_head port_lines_new bad name want got
  if [ -e "$stack" ]; then
    [ -f "$conf" ] || refuse "$stack exists without its stack.conf: use a new --work"
    [ "$(conf_get PROJECT)" = "$project" ] || refuse "$work holds the project $(conf_get PROJECT), not $project"
    [ -z "$images" ] || [ "$(conf_get IMAGES)" = "$images" ] || refuse "$work's stack runs --images $(conf_get IMAGES), not $images: use a new --work"
    [ -z "$site" ] || [ "$(conf_get SITE)" = "$site" ] || refuse "$work's stack runs --site $(conf_get SITE), not $site: use a new --work"
    [ -z "$port_base" ] || [ "$(conf_get PORT_BASE)" = "$port_base" ] || refuse "$work's stack uses --port-base $(conf_get PORT_BASE), not $port_base"
    say "reusing $stack (commit $(conf_get COMMIT))"
    return 0
  fi
  [ -n "$images" ] || usage
  [ -n "$site" ] || usage
  : "${port_base:=33600}"
  : "${file_store:=local}"
  : "${tree:=$DEFAULT_TREE}"
  commit=$(git -C "$tree" rev-parse --verify HEAD 2>/dev/null) || refuse "--tree $tree is not a git checkout with a commit"
  mkdir -p "$work" && chmod 700 "$work" && mkdir "$stack" || fail "cannot make $stack"
  git -C "$tree" archive "$commit" | tar -x -C "$stack" || fail "git archive of $commit into $stack failed"
  [ -f "$stack/docker-compose.yml" ] || fail "the tree's HEAD has no docker-compose.yml"
  head="$stack/docker-compose.head.yml"
  new="$stack/docker-compose.yml"
  mv "$new" "$head" || fail "cannot move docker-compose.yml aside"
  remap_ports "$port_base" "$head" "$new.ports" || status=1

  case "$images" in
    dev-tag:*)
      sed -E "s#^([[:space:]]+image:[[:space:]]*telflo-[a-z-]+):dev[[:space:]]*\$#\\1:${images#dev-tag:}#" "$new.ports" >"$new" || status=1
      if grep -Eq '^[[:space:]]+image:[[:space:]]*telflo-[a-z-]+:dev' "$new"; then
        echo "stack.sh: a telflo image keeps :dev" >&2; status=1
      fi
      ;;
    release:*)
      mv "$new.ports" "$new" || status=1
      write_release_override "${images#release:}" || status=1
      ;;
  esac
  rm -f "$new.ports"

  # Every published port on 127.0.0.1, as many as HEAD's, none twice.
  local port_line='^[[:space:]]+- "([0-9.]+:)?[0-9]+:[0-9]+(/(tcp|udp))?"[[:space:]]*$'
  port_lines_head=$(grep -cE "$port_line" "$head")
  port_lines_new=$(grep -cE "$port_line" "$new")
  [ "$port_lines_head" = "$port_lines_new" ] || { echo "stack.sh: HEAD has $port_lines_head port lines, the stack $port_lines_new" >&2; status=1; }
  bad=$(grep -E "$port_line" "$new" | grep -vE '^[[:space:]]+- "127\.0\.0\.1:[0-9]+:[0-9]+"[[:space:]]*$' || true)
  [ -z "$bad" ] || { echo "stack.sh: port lines not on 127.0.0.1:" >&2; echo "$bad" >&2; status=1; }
  bad=$(grep -E "$port_line" "$new" | sed -E 's#.*"127\.0\.0\.1:([0-9]+):.*#\1#' | sort | uniq -d)
  [ -z "$bad" ] || { echo "stack.sh: host ports used twice: $bad" >&2; status=1; }
  # Anything that would reach past the project: a long-syntax port (not
  # remapped), a fixed container name, an external or named volume or network.
  bad=$(grep -nE '^[[:space:]]+(published|host_ip|container_name|external):|^[[:space:]]+name:' "$new" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
  [ -z "$bad" ] || { echo "stack.sh: keys that reach past the project:" >&2; echo "$bad" >&2; status=1; }
  # The site's values reach both services that read them (the sales address
  # the API's only), so smoke-env.sh's values reach the stack.
  for name in $SITE_VARIABLES; do
    want=2
    [ "$name" = TELFLO_SALES_INQUIRY_TO ] && want=1
    got=$(grep -cE "^[[:space:]]+$name: \\\$\\{$name:-" "$new")
    [ "$got" = "$want" ] || { echo "stack.sh: $name is interpolated $got times, not $want" >&2; status=1; }
  done

  local files="$new"
  [ ! -f "$stack/docker-compose.release.yml" ] || files="$new:$stack/docker-compose.release.yml"
  {
    echo "PROJECT=$project"
    echo "PORT_BASE=$port_base"
    echo "SITE=$site"
    echo "IMAGES=$images"
    echo "FILE_STORE=$file_store"
    echo "COMPOSE_FILE=$files"
    echo "COMMIT=$commit"
  } >"$conf" || status=1

  say "the copy: $stack from $commit"
  say "published ports:"
  grep -nE "$port_line" "$new" | sed 's/^/  /'
  say "images:"
  grep -nE '^[[:space:]]+image:' "$new" | sed 's/^/  /'
  [ ! -f "$stack/docker-compose.release.yml" ] || { say "the release override:"; sed 's/^/  /' "$stack/docker-compose.release.yml"; }
  [ "$status" = 0 ] || fail "the copy's compose file failed its checks (above)"
}

write_release_override() { # <version>
  local version=$1 out="$stack/docker-compose.release.yml" pairs service image name seen=" "
  pairs=$(release_services "$stack/docker-compose.head.yml")
  [ -n "$pairs" ] || { echo "stack.sh: no telflo-<name>:dev service in docker-compose.yml" >&2; return 1; }
  {
    echo "# Written by scripts/gates/stack.sh: the release's images, never pulled or built."
    echo "services:"
  } >"$out"
  while read -r service image; do
    name=${image#telflo-}
    name=${name%:dev}
    case " $RELEASE_NAMES " in *" $name "*) ;; *) echo "stack.sh: $service runs $image, not one of the release's images" >&2; return 1 ;; esac
    printf '  %s:\n    image: %s/%s:%s\n    pull_policy: never\n' "$service" "$RELEASE_REGISTRY" "$name" "$version" >>"$out"
    seen="$seen$name "
  done <<EOF
$pairs
EOF
  for name in $RELEASE_NAMES; do
    case "$seen" in *" $name "*) ;; *) echo "stack.sh: no service runs telflo-$name:dev" >&2; return 1 ;; esac
  done
}

# --- running compose ----------------------------------------------------------

# The smoke's settings (the site's values, the project, the files, the file
# store), the credential guards, and dc(): docker compose on this project only.
compose_env() {
  local standins="$work/bin" helper
  mkdir -p "$work/docker-config" "$standins" || fail "cannot make $work's docker folders"
  printf '{"auths":{"telflo-gates.invalid":{}}}\n' >"$work/docker-config/config.json"
  export DOCKER_CONFIG="$work/docker-config"
  : >>"$work/helper.log"
  for helper in osxkeychain desktop ecr-login; do
    printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/helper.log"\nexit 1\n' "$work" >"$standins/docker-credential-$helper"
    chmod 755 "$standins/docker-credential-$helper"
  done
  export PATH="$standins:$PATH"
  # shellcheck disable=SC1090,SC1091
  . "$SCRIPT_DIR/smoke-env.sh" "$(conf_get SITE)" "$work" >/dev/null || fail "smoke-env.sh refused"
  [ "$COMPOSE_PROJECT_NAME" = "$project" ] || fail "smoke-env.sh named the project $COMPOSE_PROJECT_NAME"
}
compose_files_args() {
  local IFS=:
  for f in $(conf_get COMPOSE_FILE); do printf -- '-f\n%s\n' "$f"; done
}
dc() {
  local args=() line
  while IFS= read -r line; do args+=("$line"); done <<EOF
$(compose_files_args)
EOF
  if [ "$dry_run" = 1 ]; then
    echo "would run: docker compose -p $project ${args[*]} $*"
    return 0
  fi
  docker compose -p "$project" "${args[@]}" "$@"
}
helpers_check() {
  if [ -s "$work/helper.log" ]; then
    fail "a docker credential helper was called ($(wc -l <"$work/helper.log" | tr -d ' ') calls, first arguments in $work/helper.log)"
  fi
}

check_images() {
  local listed image missing=""
  listed=$(dc config --images) || fail "docker compose config --images failed"
  for image in $listed; do
    docker image inspect "$image" >/dev/null 2>&1 || missing="$missing $image"
  done
  [ -z "$missing" ] || fail "not local (stack.sh never pulls or builds; build or re-tag them first):$missing"
  say "every image the project runs is local ($(printf '%s\n' $listed | wc -l | tr -d ' ') images)"
  local pin="$stack/vendor/opamp-server/PIN" version digest commit ref revision
  version=$(sed -n 's/^version=//p' "$pin"); digest=$(sed -n 's/^digest=//p' "$pin"); commit=$(sed -n 's/^commit=//p' "$pin")
  ref="ghcr.io/telflo/opamp-server:$version@$digest"
  revision=$(docker image inspect "$ref" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)
  [ -n "$commit" ] && [ "$revision" = "$commit" ] || fail "the pinned opamp-server ($version) isn't local with the PIN's revision label"
}

do_ready() {
  local attempts=${STACK_READY_ATTEMPTS:-120} i=0 login="" me="" store want got bad="" status=0
  if [ "$dry_run" = 1 ]; then
    echo "would poll: $TELFLO_GATEWAY_URL/login (200) and /api/v1/auth/me (401), $attempts attempts; then the API's TELFLO_FILE_STORE and the site's values in api and web"
    return 0
  fi
  while [ "$i" -lt "$attempts" ]; do
    i=$((i + 1))
    login=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$TELFLO_GATEWAY_URL/login" || true)
    me=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$TELFLO_GATEWAY_URL/api/v1/auth/me" || true)
    [ "$login" = 200 ] && [ "$me" = 401 ] && break
    sleep 5
  done
  say "/login $login, /api/v1/auth/me $me (attempt $i of $attempts)"
  [ "$login" = 200 ] && [ "$me" = 401 ] || status=1
  store=$(dc exec -T api printenv TELFLO_FILE_STORE 2>/dev/null | tr -d '\r')
  say "the API's file store: ${store:-?} (expected $TELFLO_SMOKE_FILE_STORE)"
  [ "$store" = "$TELFLO_SMOKE_FILE_STORE" ] || status=1
  for name in $SITE_VARIABLES; do
    eval "want=\${$name-}"
    got=$(dc exec -T api printenv "$name" 2>/dev/null | tr -d '\r')
    [ "$got" = "$want" ] || bad="$bad api:$name"
    [ "$name" = TELFLO_SALES_INQUIRY_TO ] && continue
    got=$(dc exec -T web printenv "$name" 2>/dev/null | tr -d '\r')
    [ "$got" = "$want" ] || bad="$bad web:$name"
  done
  if [ -z "$bad" ]; then
    say "the site's values ($TELFLO_SMOKE_SITE) in the API and web: all equal smoke-env.sh's"
  else
    say "the site's values ($TELFLO_SMOKE_SITE) differ from smoke-env.sh's:$bad"
    status=1
  fi
  helpers_check
  [ "$status" = 0 ] || fail "the stack $project isn't ready"
  say "ready: $project"
}

case "$action" in
  up)
    generate
    if [ -n "$file_store" ] && [ "$(conf_get FILE_STORE)" != "$file_store" ]; then
      sed "s/^FILE_STORE=.*/FILE_STORE=$file_store/" "$conf" >"$conf.new" && mv "$conf.new" "$conf" || fail "cannot update $conf"
    fi
    compose_env
    if [ "$dry_run" = 1 ]; then
      if command -v docker >/dev/null 2>&1; then
        dry_run=0
        dc config -q || fail "docker compose config refused the copy"
        dry_run=1
        say "docker compose config reads the copy (client side)"
      else
        say "no docker CLI: the copy wasn't read back with docker compose config"
      fi
      echo "would check: every image of 'docker compose config --images' is local; the pinned opamp-server's revision label"
      dc up -d --no-build
      do_ready
      helpers_check
      say "dry run: nothing started"
      exit 0
    fi
    check_images
    dc up -d --no-build || fail "docker compose up -d failed"
    do_ready
    ;;
  ready)
    [ -f "$conf" ] || refuse "no $conf: run stack.sh up first"
    [ "$(conf_get PROJECT)" = "$project" ] || refuse "$work holds the project $(conf_get PROJECT), not $project"
    [ -z "$file_store" ] || [ "$(conf_get FILE_STORE)" = "$file_store" ] || refuse "the stack was started on $(conf_get FILE_STORE), not $file_store"
    compose_env
    do_ready
    ;;
  down)
    [ -f "$conf" ] || refuse "no $conf: nothing of stack.sh's here"
    [ "$(conf_get PROJECT)" = "$project" ] || refuse "$work holds the project $(conf_get PROJECT), not $project"
    compose_env
    # Every profile's services (the object store's volume among them).
    export COMPOSE_PROFILES=s3
    dc down -v --remove-orphans || fail "docker compose down -v failed"
    [ "$dry_run" = 0 ] || { say "dry run: nothing removed"; exit 0; }
    left="$(docker ps -aq --filter "label=com.docker.compose.project=$project" | wc -l | tr -d ' ') containers, $(docker volume ls -q --filter "label=com.docker.compose.project=$project" | wc -l | tr -d ' ') volumes, $(docker network ls -q --filter "label=com.docker.compose.project=$project" | wc -l | tr -d ' ') networks"
    say "left of $project: $left"
    helpers_check
    [ "$left" = "0 containers, 0 volumes, 0 networks" ] || fail "something of $project is left"
    ;;
esac
exit 0
