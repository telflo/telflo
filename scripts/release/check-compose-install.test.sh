#!/usr/bin/env bash
# check-compose-install.sh's self-test (D36-2 decisions 88-90; Preflight
# ruling 1): the real tree passes, and in a throwaway copy of the files the
# check reads (deploy/compose, the copies' sources, the chart's Chart.yaml
# and values.yaml, the PIN, docker-compose.yml and the development secrets'
# files), each rule broken once fails it, naming the rule:
#   the four copies (each changed, one missing); compose.yaml's name, a
#   build:, a Telflo image at another version or by digest, Postgres and
#   nginx off the chart's digests (and the chart's digest moved), the
#   opamp-server off the PIN, an unknown service, Mailpit without its digest
#   or its profile, another service with a profile, Mailpit's port on the
#   bind address or 0.0.0.0, Mailpit's port not --mailpit-port's (compose.yaml
#   not reading TELFLO_MAILPIT_PORT, setup.sh not writing it), the gateway's port on a literal address, a
#   second opamp-server port, the database's port, the host's network,
#   every setting optional (Compose reads it without .env), setup.sh not
#   executable, COMPOSE_PROFILES
#   not starting Mailpit; setup.sh's development-secret list missing one,
#   holding an extra, or missing a new secret added to docker-compose.yml;
#   the lockdown: a secret not mounted, moved to the environment or its file
#   outside secrets/, the evaluator's network not internal, the tester on
#   the default network, read_only, cap_drop or no-new-privileges dropped,
#   a privileged service, the Docker socket mounted;
#   a development secret's value in deploy/compose. And any argument is a
#   usage error.
#
# Run: scripts/release/check-compose-install.test.sh
# Offline (the docker CLI with its compose plugin, python3 and openssl, as
# the check); prints PASS/FAIL lines only, never a value; exit 1 when any
# case failed. The copies live in a temporary folder removed on exit; the
# repository's own files are only read. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-compose-install-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0
n=0
run_case() { # <name> <command...>
  local name="$1"; shift
  if "$@"; then
    echo "PASS - $name"; passed=$((passed + 1))
  else
    echo "FAIL - $name"; failed=$((failed + 1))
  fi
}

# fresh: a new copy in $c of every file the check reads (deploy/compose's
# tracked files only).
fresh() {
  n=$((n + 1)); c="$tmp/case$n"
  mkdir -p "$c/scripts/release" "$c/charts/telflo/files" "$c/vendor/opamp-server" "$c/docker" || return 1
  cp "$SCRIPT_DIR/check-compose-install.sh" "$SCRIPT_DIR/version.sh" "$c/scripts/release/" &&
    cp "$REPO_DIR/charts/telflo/Chart.yaml" "$REPO_DIR/charts/telflo/values.yaml" "$c/charts/telflo/" &&
    cp "$REPO_DIR/charts/telflo/files/telflo-bootstrap.sql" "$c/charts/telflo/files/" &&
    cp "$REPO_DIR/vendor/opamp-server/PIN" "$REPO_DIR/vendor/opamp-server/bootstrap.sql" "$c/vendor/opamp-server/" &&
    cp "$REPO_DIR/docker-compose.yml" "$c/" &&
    (cd "$REPO_DIR" && git ls-files -z --cached --others --exclude-standard -- docker/gateway 'docker/*/development-*' deploy/compose |
      xargs -0 tar -cf - ) | (cd "$c" && tar -xf -)
}
# check: run the copy's check; its output in $c.out, its exit status in $c.rc.
check() { (cd "$tmp" && bash "$c/scripts/release/check-compose-install.sh" "$@") >"$c.out" 2>&1; echo $? >"$c.rc"; }
rc_is() { [ "$(cat "$c.rc")" = "$1" ]; }
said() { grep -qF -- "$1" "$c.out"; }
# edit <file> <command...>: rewrites a file of the copy through a command.
edit() {
  local file="$c/$1"
  shift
  # Written through, so the file keeps its mode (setup.sh's executable bit).
  "$@" <"$file" >"$file.new" && cat "$file.new" >"$file" && rm -f "$file.new"
}
# broken <expected text> <file> <command...>: the copy with one edit fails,
# saying the expected text.
broken() {
  local expect="$1"
  shift
  fresh && edit "$@" && check && rc_is 1 && said "$expect"
}
# in_service <service> <awk program on its lines>: an awk filter applying
# the program only inside that service of compose.yaml.
in_service() {
  awk -v svc="  $1:" "
    /^[^ #]/ { in_services = (\$0 == \"services:\"); inside = 0 }
    in_services && /^  [^ #]/ { inside = (\$0 == svc) }
    inside { $2 }
    { print }"
}

echo "# the real tree and a faithful copy"
real_tree() { (cd "$tmp" && bash "$REPO_DIR/scripts/release/check-compose-install.sh") >"$tmp/real.out" 2>&1; }
run_case "the repository's own tree passes" real_tree
copy_passes() { fresh && check && rc_is 0 && said "check-compose-install: OK" && said "holds the 14 development secrets"; }
run_case "a faithful copy passes" copy_passes
names_variable() { fresh && check && said "without .env, Compose refuses it, naming TELFLO_"; }
run_case "without .env Compose refuses compose.yaml, naming a variable" names_variable

echo "# the copies"
for copy in gateway/default.conf gateway/extra-routes.conf opamp-server/bootstrap.sql postgres/telflo-bootstrap.sql; do
  changed() { fresh && printf ' ' >>"$c/deploy/compose/$1" && check && rc_is 1 && said "deploy/compose/$1 differs from"; }
  run_case "deploy/compose/$copy changed fails" changed "$copy"
done
copy_missing() { fresh && rm "$c/deploy/compose/postgres/telflo-bootstrap.sql" && check && rc_is 1 && said "deploy/compose/postgres/telflo-bootstrap.sql is missing"; }
run_case "a copy missing fails" copy_missing

echo "# compose.yaml as text and as Compose reads it"
run_case "another project name fails" broken "a top-level line 'name: telflo'" deploy/compose/compose.yaml sed 's/^name: telflo$/name: telflo-other/'
run_case "a build: fails" broken "has a build:" deploy/compose/compose.yaml \
  in_service api 'if ($0 == "  api:") { print; print "    build: ."; next }'
run_case "a Telflo image at another version fails" broken "web's image is 'ghcr.io/telflo/telflo/web:9.9.9'" deploy/compose/compose.yaml \
  sed 's#ghcr.io/telflo/telflo/web:[0-9.]*#ghcr.io/telflo/telflo/web:9.9.9#'
digest="sha256:$(printf '%064d' 0)"
run_case "a Telflo image by digest fails" broken "otelcol-validator's image is" deploy/compose/compose.yaml \
  sed "s#\\(ghcr.io/telflo/telflo/otelcol-validator:[0-9.]*\\)\$#\\1@$digest#"
run_case "Postgres off the chart's digest fails" broken "db's image is 'postgres:18@$digest'" deploy/compose/compose.yaml \
  in_service db "sub(/@sha256:[0-9a-f]+/, \"@$digest\")"
run_case "nginx without its digest fails" broken "gateway's image is 'nginx:1.27-alpine'" deploy/compose/compose.yaml \
  sed 's#^\(    image: nginx:1.27-alpine\)@sha256:[0-9a-f]*$#\1#'
run_case "the chart's Postgres digest moved fails the install's" broken "db-bootstrap's image is" charts/telflo/values.yaml \
  sed "s#^    digest: sha256:9f4fd4aa[0-9a-f]*\$#    digest: $digest#"
run_case "the opamp-server off the PIN fails" broken "opamp-server's image is" deploy/compose/compose.yaml \
  in_service opamp-server 'sub(/:0[.][0-9.]*@/, ":9.9.9@")'
unknown_service() {
  fresh && printf '  telflo-extra:\n    image: alpine:3\n' >"$c/extra.yaml" &&
    edit deploy/compose/compose.yaml awk -v extra="$c/extra.yaml" '$0 == "volumes:" { while ((getline line < extra) > 0) print line; print "" } { print }' &&
    check && rc_is 1 && said "an unknown service telflo-extra"
}
run_case "an unknown service fails" unknown_service
run_case "Mailpit without its digest fails" broken "mailpit's image is 'axllent/mailpit:v1.31.2'" deploy/compose/compose.yaml \
  sed 's#^\(    image: axllent/mailpit:v[0-9.]*\)@sha256:[0-9a-f]*$#\1#'
run_case "Mailpit without its profile fails" broken "mailpit's profiles are None" deploy/compose/compose.yaml \
  sed '/^    profiles: \[mailpit\]$/d'
run_case "another service with a profile fails" broken "deploy/compose/compose.yaml's web has profiles" deploy/compose/compose.yaml \
  in_service web 'if ($0 == "  web:") { print; print "    profiles: [extra]"; next }'
run_case "Mailpit's port on the bind address fails" broken "mailpit's port line" deploy/compose/compose.yaml \
  sed 's#"127.0.0.1:${TELFLO_MAILPIT_PORT:-8025}:8025"#"${TELFLO_BIND_ADDRESS:?x}:${TELFLO_MAILPIT_PORT:-8025}:8025"#'
mailpit_any() {
  fresh && edit deploy/compose/compose.yaml sed 's#"127.0.0.1:${TELFLO_MAILPIT_PORT:-8025}:8025"#"${TELFLO_MAILPIT_PORT:-8025}:8025"#' &&
    check && rc_is 1 && said "mailpit's port line" && said "mailpit's port is published on '0.0.0.0', not on 127.0.0.1 only"
}
run_case "Mailpit's port on every address fails (as text and as Compose reads it)" mailpit_any
# shellcheck disable=SC2016 # the sed expression's $ is literal text
run_case "compose.yaml not reading TELFLO_MAILPIT_PORT fails" broken "mailpit's port is published as '8025', not setup.sh's port" \
  deploy/compose/compose.yaml sed 's#"127.0.0.1:${TELFLO_MAILPIT_PORT:-8025}:8025"#"127.0.0.1:8025:8025"#'
# shellcheck disable=SC2016 # the sed expression's $ is literal text
run_case "setup.sh not writing --mailpit-port fails" broken "mailpit's port is published as '8025', not setup.sh's port" \
  deploy/compose/setup.sh sed 's/^  add_line "TELFLO_MAILPIT_PORT=\$mailpit_port"$/  add_line "TELFLO_MAILPIT_PORT=8025"/'
run_case "the gateway's port on a literal address fails" broken "gateway's port is published on '127.0.0.1', not on TELFLO_BIND_ADDRESS" deploy/compose/compose.yaml \
  sed 's#"${TELFLO_BIND_ADDRESS:?run ./setup.sh first}:${TELFLO_HTTP_PORT#"127.0.0.1:${TELFLO_HTTP_PORT#'
run_case "the management port published too fails" broken "opamp-server publishes 2 ports, not one" deploy/compose/compose.yaml \
  in_service opamp-server 'if ($0 == "    ports:") { print; print "      - \"127.0.0.1:51235:51235\""; next }'
run_case "the database's port published fails" broken "db publishes a port" deploy/compose/compose.yaml \
  in_service db 'if ($0 == "  db:") { print; print "    ports: [\"127.0.0.1:5432:5432\"]"; next }'
# Its networks: block goes too: Compose 2.40 refuses network_mode beside
# networks: before the check could read the file (2.6 allowed it).
run_case "the host's network fails" broken "web has network_mode 'host'" deploy/compose/compose.yaml \
  in_service web 'if ($0 == "  web:") { print; print "    network_mode: host"; next } if ($0 == "    networks:" || $0 ~ /^      default: \{ aliases: /) next'
run_case "every setting optional (Compose reads it without .env) fails" broken "Compose reads deploy/compose/compose.yaml without .env" deploy/compose/compose.yaml \
  sed -e 's/{TELFLO_BIND_ADDRESS:?run \.\/setup\.sh first}/{TELFLO_BIND_ADDRESS:-127.0.0.1}/g' \
    -e 's/{\(TELFLO_[A-Z]*_PORT\):?run \.\/setup\.sh first}/{\1:-1}/g' -e 's/:?run \.\/setup\.sh first}/:-x}/g'
not_executable() { fresh && chmod 644 "$c/deploy/compose/setup.sh" && check && rc_is 1 && said "deploy/compose/setup.sh isn't executable"; }
run_case "setup.sh not executable fails" not_executable
run_case "COMPOSE_PROFILES not starting Mailpit fails" broken "mailpit isn't started by .env's COMPOSE_PROFILES" deploy/compose/setup.sh \
  sed 's/^  add_line "COMPOSE_PROFILES=mailpit"$/  add_line "COMPOSE_PROFILES="/'

echo "# the lockdown"
run_case "the opamp-server without its secret mount fails" broken "opamp-server does not mount the secret opamp_encryption_key" deploy/compose/compose.yaml \
  sed '/^    secrets: \[opamp_encryption_key\]$/d'
run_case "the tester's secret moved to its environment fails" broken "otelcol-testing has OTELCOL_TESTING_SECRET in its environment" deploy/compose/compose.yaml \
  sed -e 's#^      OTELCOL_TESTING_SECRET_FILE: /run/secrets/otelcol_testing_secret$#      OTELCOL_TESTING_SECRET: "${TELFLO_OTELCOL_TESTING_SECRET:?run ./setup.sh first}"#' \
    -e '/^    secrets: \[otelcol_testing_secret\]$/d'
run_case "the evaluator's secret file outside secrets/ fails" broken "the secret ottl_evaluator_secret has the file" deploy/compose/compose.yaml \
  sed 's#^    file: ./secrets/ottl-evaluator-secret$#    file: ./ottl-evaluator-secret#'
run_case "the evaluator's network not internal fails" broken "the network ottl-evaluator is not internal: true" deploy/compose/compose.yaml \
  awk 'skip && $0 == "    internal: true" { skip = 0; next } { skip = ($0 == "  ottl-evaluator:" && networks) } /^networks:$/ { networks = 1 } { print }'
run_case "the tester on the default network too fails" broken "otelcol-testing is on networks ['default', 'otelcol-testing']" deploy/compose/compose.yaml \
  sed 's#^    networks: \[otelcol-testing\]$#    networks: [default, otelcol-testing]#'
run_case "the tester not read-only fails" broken "otelcol-testing is not read_only: true" deploy/compose/compose.yaml \
  in_service otelcol-testing 'if ($0 == "    read_only: true") next'
run_case "the evaluator keeping its capabilities fails" broken "ottl-evaluator has cap_drop None, not [ALL]" deploy/compose/compose.yaml \
  in_service ottl-evaluator 'if ($0 == "    cap_drop: [ALL]") next'
run_case "the tester without no-new-privileges fails" broken "otelcol-testing lacks security_opt no-new-privileges:true" deploy/compose/compose.yaml \
  in_service otelcol-testing 'if ($0 == "    security_opt: [no-new-privileges:true]") next'
run_case "a privileged service fails" broken "web is privileged" deploy/compose/compose.yaml \
  in_service web 'if ($0 == "  web:") { print; print "    privileged: true"; next }'
run_case "the Docker socket mounted fails" broken "api mounts the Docker socket" deploy/compose/compose.yaml \
  in_service api 'if ($0 == "      - file-store:/var/lib/telflo/file-store") { print; print "      - /var/run/docker.sock:/var/run/docker.sock"; next }'

run_case "a service in the host's pid namespace fails" broken "web shares the host's pid namespace" deploy/compose/compose.yaml \
  in_service web 'if ($0 == "  web:") { print; print "    pid: host"; next }'
run_case "a service in the host's ipc namespace fails" broken "api shares the host's ipc namespace" deploy/compose/compose.yaml \
  in_service api 'if ($0 == "  api:") { print; print "    ipc: host"; next }'
run_case "the evaluator without its memory limit fails" broken "ottl-evaluator has no mem_limit" deploy/compose/compose.yaml \
  in_service ottl-evaluator 'if ($0 == "    mem_limit: 3g") next'

echo "# the development secrets"
run_case "setup.sh's list missing one fails" broken "isn't in setup.sh's DEVELOPMENT_SECRET_SHA256" deploy/compose/setup.sh \
  awk '/^DEVELOPMENT_SECRET_SHA256="$/ { print; getline; next } { print }'
run_case "setup.sh's list with an extra sha256 fails" broken "holds 1 sha256 that no development secret has" deploy/compose/setup.sh \
  awk -v extra="$(printf '%064d' 1)" '/^DEVELOPMENT_SECRET_SHA256="$/ { print; print extra; next } { print }'
new_secret() {
  fresh && edit docker-compose.yml awk -v value="$(openssl rand -hex 24)" \
    '/^  TELFLO_LIBRARY_LINK_SIGNING_KEY: / { print; print "  TELFLO_SOMETHING_NEW_SECRET: " value; next } { print }' &&
    grep -q '^  TELFLO_SOMETHING_NEW_SECRET: ' "$c/docker-compose.yml" &&
    check && rc_is 1 && said "docker-compose.yml's api TELFLO_SOMETHING_NEW_SECRET isn't in setup.sh's DEVELOPMENT_SECRET_SHA256"
}
run_case "a new secret in docker-compose.yml, not in the list, fails" new_secret
new_file() {
  fresh && mkdir -p "$c/docker/other" && (umask 022 && openssl rand -hex 24 >"$c/docker/other/development-secret") &&
    check && rc_is 1 && said "docker/other/development-secret isn't in setup.sh's DEVELOPMENT_SECRET_SHA256"
}
run_case "a new docker/*/development-* file, not in the list, fails" new_file
planted() {
  local value
  value="$(sed -n 's/^x-ottl-evaluator-secret: &[a-z-]* //p' "$REPO_DIR/docker-compose.yml")"
  [ -n "$value" ] || return 1
  fresh && printf 'note: %s\n' "$value" >>"$c/deploy/compose/README.md" &&
    check && rc_is 1 && said "deploy/compose/README.md holds a development secret's value" && ! said "$value"
}
run_case "a development secret's value in deploy/compose fails, unprinted" planted

echo "# usage"
an_argument() { fresh && check --tree . && rc_is 2; }
run_case "any argument is a usage error (exit 2)" an_argument

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
