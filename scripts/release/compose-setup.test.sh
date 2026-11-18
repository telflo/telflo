#!/usr/bin/env bash
# deploy/compose/setup.sh's self-test (D36-2 decisions 67, 90-92; Preflight
# ruling 1, the preflight's P1, P10 and P11). Each case runs setup.sh in a
# throwaway copy of deploy/compose and checks, by boolean only (no value is
# ever printed, compared by a tool that prints it, or written outside the
# case's folder):
#   - .env is 0600, secrets/ 0700 with its three files 0644: world-readable
#     on purpose, since Compose mounts a secret's file as it is (it ignores
#     its mode and owner) and on Linux the services' own users (65532,
#     10001) must read it (Docker Desktop on a Mac hides this, so the mode
#     itself is the assertion); nothing else in secrets/;
#   - every generated value meets scripts/create-secrets.sh --init's rule
#     for its key (hex of 32 bytes; the quick-deploy key base64 of exactly 32
#     bytes), all different, the tester's and the evaluator's the same in
#     .env and in secrets/, no line ending in a secret file; two runs in two
#     folders make different values;
#   - an existing .env or secrets/ is refused and left unchanged, nothing
#     else written;
#   - a development secret is refused, nothing written: one planted through
#     a stand-in `openssl` first on PATH (the quick-deploy key, the one
#     development value shaped like a generated one), and one per source
#     file through --smtp-password-file (docker-compose.yml's, and each
#     docker/*/development-* file's), the values read from the sources at
#     run time;
#   - the public URL: http only on localhost, 127.0.0.1 or [::1] (other
#     hosts refused); https makes TELFLO_COOKIE_SECURE true, http false;
#   - the agent URL: an origin, /opamp/api/v1 appended to both
#     OPAMP_SERVER_URL and TELFLO_OPAMP_AGENT_PUBLIC_URL; http turns
#     TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS on, https doesn't;
#   - the site settings are the open source's defaults;
#   - --mailpit writes Mailpit's mail settings and COMPOSE_PROFILES=mailpit;
#     a relay writes its own, no profile, its password from the file;
#   - Mailpit's port: TELFLO_MAILPIT_PORT 8025, or --mailpit-port's, and
#     the closing message names that port; --mailpit-port refused (exit 2,
#     nothing written) without --mailpit, out of range or not a number, and
#     equal to --http-port or --agent-port (the default 8025 too);
#   - usage errors (exit 2, nothing written): --mailpit with a relay option,
#     neither, --smtp-password (unknown), a missing required option, a login
#     half given, --smtp-tls none with a login, a bad port or address, an
#     agent URL with a path; a password file others may read is refused;
#   - no generated value, and not the relay's password, in stdout or stderr;
#   - a write that fails part way (a file size limit, SIGXFSZ ignored, as a
#     full disk would): exit non-zero, no generated value in stdout or
#     stderr (the values a recording stand-in openssl handed out, and any
#     text shaped like one), no .env, no secrets/, no temporary file left;
#     once while .env is written, once while secrets/ is;
#   - a relay's username, password and sender holding $, #, \, a double
#     quote and a space are read back by `docker compose config` (client
#     side, a stub DOCKER_CONFIG) exactly as given (compared by boolean;
#     SKIP without the docker CLI and its compose plugin);
#   - an unknown option is named only up to any = (--smtp-password=<value>
#     never echoed), a stray word not at all.
#
# Run: scripts/release/compose-setup.test.sh
# Offline; needs openssl. Prints PASS/FAIL lines only; exit 1 when any case
# failed. The copies live in a temporary folder removed on exit; the
# repository's own files are only read. bash 3.2 compatible.
set -u
SKIPPED=0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/compose-setup-test.XXXXXX")" || exit 2
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

REAL_OPENSSL="$(command -v openssl)" || { echo "self-test: openssl isn't on PATH" >&2; exit 2; }
MAILPIT=(--public-url http://localhost:8080 --agent-url http://localhost:51234 --mailpit)

# fresh: a new copy of deploy/compose (its tracked and untracked files, not
# git-ignored ones: no .env, no secrets/) in $c.
fresh() {
  n=$((n + 1)); c="$tmp/case$n"
  mkdir -p "$c" &&
    (cd "$REPO_DIR" && git ls-files -z --cached --others --exclude-standard -- deploy/compose |
      xargs -0 tar -cf -) | (cd "$c" && tar -xf -) &&
    c="$c/deploy/compose" && [ -x "$c/setup.sh" ]
}
# setup [args...]: runs the copy's setup.sh with nothing of the caller's
# environment but PATH (and $EXTRA_PATH first); stdout in $c.out, stderr in
# $c.err, the exit status in $c.rc.
EXTRA_PATH=""
setup() {
  (cd "$c" && env -i PATH="${EXTRA_PATH:+$EXTRA_PATH:}$PATH" HOME="$tmp" ./setup.sh "$@") >"$c.out" 2>"$c.err"
  echo $? >"$c.rc"
}
rc_is() { [ "$(cat "$c.rc")" = "$1" ]; }
said() { grep -qF -- "$1" "$c.err" "$c.out"; }
nothing_written() { [ ! -e "$c/.env" ] && [ ! -e "$c/secrets" ]; }
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
# value <KEY> [folder]: .env's value for KEY (one pair of single quotes
# removed) into $v; false when the key isn't there exactly once.
v=""
value() {
  local file="${2:-$c}/.env"
  [ "$(grep -c "^$1=" "$file")" = 1 ] || return 1
  v="$(sed -n "s/^$1=//p" "$file")"
  case "$v" in \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  return 0
}
is() { value "$1" && [ "$v" = "$2" ]; }
HEX_RE='^[0-9a-f]{64}$'
BASE64_KEY_RE='^[A-Za-z0-9+/]{43}=$'
SECRET_KEYS="TELFLO_POSTGRES_PASSWORD TELFLO_OWNER_PASSWORD TELFLO_API_PASSWORD TELFLO_OPAMP_OWNER_PASSWORD TELFLO_OPAMP_RUNTIME_PASSWORD TELFLO_OPAMP_MANAGEMENT_SECRET TELFLO_ACCESS_TOKEN_SECRET TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY TELFLO_LIBRARY_LINK_SIGNING_KEY TELFLO_OTELCOL_VALIDATOR_SECRET TELFLO_OTELCOL_TESTING_SECRET TELFLO_OTTL_EVALUATOR_SECRET"
SECRET_FILES="opamp-encryption-key otelcol-testing-secret ottl-evaluator-secret"
# all_values [folder]: every generated value, one a line, into $c.values
# (a file of the case's folder, mode 0600; never printed).
all_values() {
  local folder="${1:-$c}" key file
  : >"$folder.values" && chmod 600 "$folder.values"
  for key in $SECRET_KEYS; do value "$key" "$folder" && printf '%s\n' "$v" >>"$folder.values" || return 1; done
  for file in $SECRET_FILES; do { cat "$folder/secrets/$file"; echo; } >>"$folder.values" || return 1; done
}

echo "# a Mailpit install: files and modes"
mailpit_ok() { fresh && setup "${MAILPIT[@]}" && rc_is 0; }
run_case "setup.sh --mailpit exits 0" mailpit_ok
modes() {
  [ "$(mode_of "$c/.env")" = 600 ] && [ "$(mode_of "$c/secrets")" = 700 ] &&
    [ "$(ls -A "$c/secrets" | tr '\n' ' ')" = "opamp-encryption-key otelcol-testing-secret ottl-evaluator-secret " ]
}
run_case ".env is 0600, secrets/ 0700 holding exactly the three files" modes
linux_readable() {
  local file mode
  for file in $SECRET_FILES; do
    mode="$(mode_of "$c/secrets/$file")"
    # 0644: its owner writes, and anyone reads, which the services' users
    # (not the file's owner on Linux) need through Compose's bind mount.
    [ "$mode" = 644 ] && [ $((8#$mode & 8#004)) -ne 0 ] && [ $((8#$mode & 8#022)) -eq 0 ] || return 1
  done
}
run_case "each secret file is 0644: others may read it (the services' own uids on Linux), none may write it" linux_readable

echo "# the generated values"
rules() {
  local key
  for key in TELFLO_POSTGRES_PASSWORD TELFLO_OWNER_PASSWORD TELFLO_API_PASSWORD TELFLO_OPAMP_OWNER_PASSWORD \
    TELFLO_OPAMP_RUNTIME_PASSWORD TELFLO_OPAMP_MANAGEMENT_SECRET TELFLO_ACCESS_TOKEN_SECRET \
    TELFLO_LIBRARY_LINK_SIGNING_KEY TELFLO_OTELCOL_VALIDATOR_SECRET TELFLO_OTELCOL_TESTING_SECRET \
    TELFLO_OTTL_EVALUATOR_SECRET; do
    value "$key" && [[ "$v" =~ $HEX_RE ]] || return 1
  done
  value TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY && [[ "$v" =~ $BASE64_KEY_RE ]] &&
    [ "$(printf '%s' "$v" | "$REAL_OPENSSL" base64 -d -A | wc -c | tr -d ' ')" = 32 ] &&
    [[ "$(cat "$c/secrets/opamp-encryption-key")" =~ $HEX_RE ]] &&
    [ "$(wc -c <"$c/secrets/opamp-encryption-key" | tr -d ' ')" = 64 ]
}
run_case "every value meets create-secrets.sh --init's rule (hex of 32 bytes; the quick-deploy key base64 of 32 bytes)" rules
same_in_both() {
  value TELFLO_OTELCOL_TESTING_SECRET && [ "$(cat "$c/secrets/otelcol-testing-secret")" = "$v" ] &&
    value TELFLO_OTTL_EVALUATOR_SECRET && [ "$(cat "$c/secrets/ottl-evaluator-secret")" = "$v" ] &&
    [ "$(wc -c <"$c/secrets/otelcol-testing-secret" | tr -d ' ')" = 64 ] &&
    [ "$(wc -c <"$c/secrets/ottl-evaluator-secret" | tr -d ' ')" = 64 ]
}
run_case "the tester's and the evaluator's secrets are the same in .env and secrets/, without a line ending" same_in_both
opamp_file_only() { ! grep -qF -f "$c/secrets/opamp-encryption-key" "$c/.env"; }
run_case "the opamp-server's encryption key is in secrets/ only, not in .env" opamp_file_only
distinct() { all_values && [ "$(sort -u "$c.values" | wc -l | tr -d ' ')" = 13 ] && [ "$(wc -l <"$c.values" | tr -d ' ')" = 15 ]; }
run_case "the 13 generated values are all different (15 places, 2 shared on purpose)" distinct
quiet() {
  all_values && ! grep -qF -f "$c.values" "$c.out" "$c.err"
}
run_case "no generated value in stdout or stderr" quiet
two_runs() {
  local first
  fresh && setup "${MAILPIT[@]}" && rc_is 0 && all_values && first="$c" &&
    fresh && setup "${MAILPIT[@]}" && rc_is 0 && all_values &&
    ! grep -qxF -f "$first.values" "$c.values"
}
run_case "two runs in two folders share no value" two_runs

echo "# never over an existing install"
env_exists() {
  fresh && printf 'TELFLO_KEEP=1\n' >"$c/.env" && cp "$c/.env" "$c.before" && setup "${MAILPIT[@]}" &&
    rc_is 1 && said ".env exists already: refused" && cmp -s "$c.before" "$c/.env" && [ ! -e "$c/secrets" ]
}
run_case "an existing .env is refused and left unchanged; no secrets/ made" env_exists
secrets_exists() {
  fresh && mkdir "$c/secrets" && printf 'keep' >"$c/secrets/opamp-encryption-key" && setup "${MAILPIT[@]}" &&
    rc_is 1 && said "secrets/ exists already: refused" && [ "$(cat "$c/secrets/opamp-encryption-key")" = keep ] &&
    [ "$(ls -A "$c/secrets")" = opamp-encryption-key ] && [ ! -e "$c/.env" ]
}
run_case "an existing secrets/ is refused and left unchanged; no .env made" secrets_exists
env_link() { fresh && ln -s "$tmp/nowhere" "$c/.env" && setup "${MAILPIT[@]}" && rc_is 1 && [ ! -e "$tmp/nowhere" ] && [ ! -e "$c/secrets" ]; }
run_case "a dangling .env link is refused, nothing written through it" env_link

echo "# the development secrets"
# A stand-in openssl answering `rand -base64 32` with the development
# quick-deploy key (read from docker-compose.yml now), everything else the
# real one's.
stub="$tmp/stub-openssl"
mkdir -p "$stub" && chmod 700 "$stub"
sed -n 's/^  TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: //p' "$REPO_DIR/docker-compose.yml" | tr -d '\n' >"$stub/planted"
chmod 600 "$stub/planted"
cat >"$stub/openssl" <<EOF
#!/bin/sh
if [ "\$1" = rand ] && [ "\$2" = -base64 ]; then cat "$stub/planted"; exit 0; fi
exec "$REAL_OPENSSL" "\$@"
EOF
chmod 700 "$stub/openssl"
planted_shape() { [[ "$(cat "$stub/planted")" =~ $BASE64_KEY_RE ]]; }
run_case "the planted development key is shaped like a generated one (so only the refusal catches it)" planted_shape
via_openssl() {
  fresh && EXTRA_PATH="$stub" setup "${MAILPIT[@]}" && rc_is 1 &&
    said "a generated value is one of the development stack's public secrets: refused, nothing written" &&
    nothing_written && ! grep -qF -f "$stub/planted" "$c.out" "$c.err"
}
run_case "a development secret from openssl (the stand-in) is refused, nothing written" via_openssl
# A .env planted as a link to a folder between the early refusal and the
# link step (a stand-in `ln` plants it, then runs the real one): refused,
# nothing put inside that folder, the planted link left alone.
real_ln="$(command -v ln)"
race_stub="$tmp/stub-ln"
mkdir -p "$race_stub" && chmod 700 "$race_stub"
cat >"$race_stub/ln" <<EOF
#!/bin/bash
mkdir -p "\$PWD/../victim" && "$real_ln" -s "\$PWD/../victim" "\$PWD/.env" 2>/dev/null
exec "$real_ln" "\$@"
EOF
chmod 700 "$race_stub/ln"
env_link_race() {
  fresh && rm -rf "$c/../victim" && EXTRA_PATH="$race_stub" setup "${MAILPIT[@]}" && rc_is 1 &&
    said "appeared meanwhile" && [ -L "$c/.env" ] && [ -d "$c/../victim" ] &&
    [ -z "$(ls -A "$c/../victim")" ] && [ ! -e "$c/secrets" ] && rm -f "$c/.env" && rm -rf "$c/../victim"
}
run_case "a .env planted as a link to a folder meanwhile is refused, nothing put in that folder" env_link_race

# relay_with_password <file>: a relay install whose password is that file's.
relay_with_password() {
  fresh && cp "$1" "$c.password" && chmod 600 "$c.password" &&
    setup --public-url https://telflo.example.com --agent-url https://opamp.example.com \
      --smtp-host smtp.example.com --smtp-port 587 --mail-from telflo@example.com \
      --smtp-username telflo --smtp-password-file "$c.password"
}
planted_password() { # <file holding a development value>
  relay_with_password "$1" && rc_is 1 &&
    said "the password in --smtp-password-file is one of the development stack's public secrets" &&
    nothing_written && ! grep -qF -f "$1" "$c.out" "$c.err"
}
sed -n 's/^  TELFLO_ACCESS_TOKEN_SECRET: //p' "$REPO_DIR/docker-compose.yml" >"$tmp/dev-compose"
sed -n 's/^      POSTGRES_PASSWORD: //p' "$REPO_DIR/docker-compose.yml" >"$tmp/dev-database"
chmod 600 "$tmp/dev-compose" "$tmp/dev-database"
nonempty() { [ -s "$1" ]; }
run_case "docker-compose.yml's development values were read" eval 'nonempty "$tmp/dev-compose" && nonempty "$tmp/dev-database"'
run_case "docker-compose.yml's access-token secret as the relay's password is refused" planted_password "$tmp/dev-compose"
run_case "docker-compose.yml's database password as the relay's password is refused" planted_password "$tmp/dev-database"
for file in docker/opamp-server/development-encryption-key docker/otelcol-testing/development-secret docker/ottl-evaluator/development-secret; do
  run_case "$file as the relay's password is refused" planted_password "$REPO_DIR/$file"
done

echo "# the URLs"
public_http_remote() {
  fresh && setup --public-url http://telflo.example.com --agent-url http://localhost:51234 --mailpit &&
    rc_is 1 && said "--public-url may be http only on localhost" && nothing_written
}
run_case "an http public URL on another host is refused" public_http_remote
public_http_loopback() {
  local host
  for host in localhost 127.0.0.1 "[::1]" LOCALHOST; do
    fresh && setup --public-url "http://$host:8080" --agent-url http://localhost:51234 --mailpit && rc_is 0 &&
      is TELFLO_COOKIE_SECURE false || return 1
  done
}
run_case "an http public URL on localhost, 127.0.0.1 or [::1] is taken, cookies not Secure" public_http_loopback
public_https() {
  fresh && setup --public-url https://telflo.example.com/ --agent-url https://opamp.example.com:443 --mailpit && rc_is 0 &&
    is TELFLO_COOKIE_SECURE true && is TELFLO_PUBLIC_WEB_URL https://telflo.example.com &&
    is TELFLO_PUBLIC_API_URL https://telflo.example.com
}
run_case "an https public URL makes cookies Secure, both public URLs its origin" public_https
agent_http() {
  fresh && setup --public-url http://localhost:8080 --agent-url http://192.168.1.5:51234 --mailpit && rc_is 0 &&
    is TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS true &&
    is OPAMP_SERVER_URL http://192.168.1.5:51234/opamp/api/v1 &&
    is TELFLO_OPAMP_AGENT_PUBLIC_URL http://192.168.1.5:51234/opamp/api/v1
}
run_case "an http agent URL allows insecure connections; /opamp/api/v1 appended to both" agent_http
agent_https() {
  fresh && setup --public-url https://telflo.example.com --agent-url https://opamp.example.com/ --mailpit && rc_is 0 &&
    is TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS false &&
    is OPAMP_SERVER_URL https://opamp.example.com/opamp/api/v1 &&
    is TELFLO_OPAMP_AGENT_PUBLIC_URL https://opamp.example.com/opamp/api/v1
}
run_case "an https agent URL doesn't" agent_https
ports_bind() {
  fresh && setup "${MAILPIT[@]}" --http-port 33760 --agent-port 33761 --bind 0.0.0.0 && rc_is 0 &&
    is TELFLO_HTTP_PORT 33760 && is TELFLO_AGENT_PORT 33761 && is TELFLO_BIND_ADDRESS 0.0.0.0 &&
    fresh && setup "${MAILPIT[@]}" && rc_is 0 &&
    is TELFLO_HTTP_PORT 8080 && is TELFLO_AGENT_PORT 51234 && is TELFLO_BIND_ADDRESS 127.0.0.1
}
run_case "the ports and the bind address: given, or 8080, 51234 and 127.0.0.1" ports_bind

echo "# the site and the mail"
site() {
  fresh && setup "${MAILPIT[@]}" && rc_is 0 &&
    is TELFLO_REGISTRATION invite-only && is TELFLO_PLAYGROUND false && is TELFLO_ANONYMOUS_VALIDATE false &&
    is TELFLO_PUBLIC_FLOWS false && is TELFLO_SALES_INQUIRY false && is TELFLO_EMAIL_NOTIFICATIONS false &&
    is TELFLO_DOCS_URL https://docs.telflo.com/ && is TELFLO_TERMS_VERSION "" && is TELFLO_TERMS_URL "" &&
    is TELFLO_PRIVACY_URL "" && is TELFLO_COOKIE_POLICY_URL "" && is TELFLO_TRUST_PROXY_HOPS 1
}
run_case "the site settings are the open source's defaults" site
mailpit_mail() {
  fresh && setup "${MAILPIT[@]}" && rc_is 0 &&
    is COMPOSE_PROFILES mailpit && is TELFLO_MAIL_TRANSPORT smtp && is TELFLO_SMTP_HOST mailpit &&
    is TELFLO_SMTP_PORT 1025 && is TELFLO_SMTP_TLS none && is TELFLO_SMTP_ALLOW_INSECURE true &&
    value TELFLO_MAIL_FROM && [ -n "$v" ] && is TELFLO_MAILPIT_PORT 8025 &&
    ! value TELFLO_SMTP_USERNAME && ! value TELFLO_SMTP_PASSWORD && said "for trying Telflo only" &&
    said "its inbox is http://127.0.0.1:8025, on this machine only"
}
run_case "--mailpit writes Mailpit's mail settings and COMPOSE_PROFILES=mailpit (its port 8025, named at the end)" mailpit_mail
mailpit_port() {
  fresh && setup "${MAILPIT[@]}" --mailpit-port 33762 && rc_is 0 &&
    is TELFLO_MAILPIT_PORT 33762 && is TELFLO_HTTP_PORT 8080 && is TELFLO_AGENT_PORT 51234 &&
    said "its inbox is http://127.0.0.1:33762, on this machine only" && ! said "8025" &&
    all_values && ! grep -qF -f "$c.values" "$c.out" "$c.err"
}
run_case "--mailpit-port goes into .env's TELFLO_MAILPIT_PORT and the closing message (no value printed)" mailpit_port
relay_mail() {
  openssl rand -hex 20 >"$tmp/relay-password" && chmod 600 "$tmp/relay-password" &&
    relay_with_password "$tmp/relay-password" && rc_is 0 &&
    is COMPOSE_PROFILES "" && is TELFLO_SMTP_HOST smtp.example.com && is TELFLO_SMTP_PORT 587 &&
    is TELFLO_MAIL_FROM telflo@example.com && is TELFLO_SMTP_TLS starttls && is TELFLO_SMTP_ALLOW_INSECURE false &&
    is TELFLO_SMTP_USERNAME telflo && value TELFLO_SMTP_PASSWORD && [ "$v" = "$(cat "$tmp/relay-password")" ] &&
    ! value TELFLO_MAILPIT_PORT && ! grep -qF -f "$tmp/relay-password" "$c.out" "$c.err" && ! said "Mailpit"
}
run_case "a relay writes its settings and its password (from the file), no profile, nothing printed" relay_mail
relay_cleartext() {
  fresh && setup --public-url https://telflo.example.com --agent-url https://opamp.example.com \
    --smtp-host relay.internal --smtp-port 25 --mail-from telflo@example.com --smtp-tls none && rc_is 0 &&
    is TELFLO_SMTP_TLS none && is TELFLO_SMTP_ALLOW_INSECURE true
}
run_case "a relay with --smtp-tls none (no login) is cleartext, as asked" relay_cleartext
password_readable() {
  openssl rand -hex 20 >"$tmp/open-password" && chmod 644 "$tmp/open-password" &&
    fresh && setup --public-url https://telflo.example.com --agent-url https://opamp.example.com \
      --smtp-host smtp.example.com --smtp-port 587 --mail-from telflo@example.com \
      --smtp-username telflo --smtp-password-file "$tmp/open-password" &&
    rc_is 1 && said "readable by others" && nothing_written
}
run_case "a password file others may read is refused" password_readable


echo "# a write that fails part way"
# A stand-in openssl recording every value it hands out (`rand`) into a file
# of the test's, the real one answering.
recorder="$tmp/recording-openssl"
mkdir -p "$recorder" && chmod 700 "$recorder"
cat >"$recorder/openssl" <<EOF
#!/bin/sh
if [ "\$1" = rand ]; then
  out=\$("$REAL_OPENSSL" "\$@") || exit 1
  # Its own subshell, standard output the record: under the size limit a
  # failed write's leftovers go nowhere else.
  (exec >>"$recorder/handed-out" 2>/dev/null && printf '%s\n' "\$out") >/dev/null 2>&1
  printf '%s\n' "\$out"
  exit 0
fi
exec "$REAL_OPENSSL" "\$@"
EOF
chmod 700 "$recorder/openssl"
# limited <blocks>: setup.sh --mailpit under a file size limit of <blocks>
# (SIGXFSZ ignored, so a write fails with EFBIG instead of killing it), its
# stdout and stderr through a pipe (no limit there) into $c.both.
limited() {
  : >"$recorder/handed-out" && chmod 600 "$recorder/handed-out"
  (cd "$c" && env -i PATH="$recorder:$PATH" HOME="$tmp" "$BASH" -c \
    'trap "" XFSZ; ulimit -f "$1" || exit 99; shift; exec ./setup.sh "$@"' limited "$1" "${MAILPIT[@]}" 2>&1) |
    cat >"$c.both"
  echo "${PIPESTATUS[0]}" >"$c.rc"
}
no_trace() {
  local rc
  rc="$(cat "$c.rc")"
  [ "$rc" != 0 ] && [ "$rc" != 99 ] && [ ! -e "$c/.env" ] && [ ! -L "$c/.env" ] && [ ! -e "$c/secrets" ] &&
    [ -z "$(find "$c" -maxdepth 1 -name '.env.setup.*')" ] &&
    ! grep -qE '[0-9a-f]{64}|[A-Za-z0-9+/]{43}=' "$c.both" &&
    { [ ! -s "$recorder/handed-out" ] || ! grep -qF -f "$recorder/handed-out" "$c.both"; }
}
env_write_fails() {
  # 1 KiB: the three secret files fit, .env doesn't.
  fresh && limited 1 && no_trace && grep -qF "couldn't write .env" "$c.both" && [ -s "$recorder/handed-out" ]
}
run_case "a failed write of .env: non-zero, no value printed, nothing left (not even a partial .env)" env_write_fails
secret_write_fails() {
  fresh && limited 0 && no_trace && grep -qF "couldn't write secrets/opamp-encryption-key" "$c.both"
}
run_case "a failed write of a secret file: non-zero, no value printed, nothing left" secret_write_fails
rerun_after_failure() {
  fresh && limited 1 && no_trace && setup "${MAILPIT[@]}" && rc_is 0 && [ -f "$c/.env" ]
}
run_case "after a failed write, a rerun is not refused (nothing was left)" rerun_after_failure

echo "# a relay's free text, as Compose reads it"
odd_relay() {
  local dc="$tmp/docker-config"
  mkdir -p "$dc" &&
    python3 -I -c 'import json, os, sys
plugins = sys.argv[1]
json.dump({"cliPluginsExtraDirs": [plugins]} if os.path.isdir(plugins) else {}, open(sys.argv[2], "w"))' \
      "${DOCKER_CONFIG:-${HOME:-/nonexistent}/.docker}/cli-plugins" "$dc/config.json" || return 1
  fresh || return 1
  # The values, each in a file of the case's (never on a printed line).
  printf '%s' 'u s$e#r\"x' >"$c.username" && printf '%s' 'p a$b#c\d"e f%' >"$c.password" &&
    printf '%s' 'a%b+c@example.com' >"$c.from" && chmod 600 "$c.username" "$c.password" "$c.from" || return 1
  setup --public-url https://telflo.example.com --agent-url https://opamp.example.com \
    --smtp-host smtp.example.com --smtp-port 587 --mail-from "$(cat "$c.from")" \
    --smtp-username "$(cat "$c.username")" --smtp-password-file "$c.password" && rc_is 0 || return 1
  (cd "$c" && env -i PATH="$PATH" HOME="$tmp" DOCKER_CONFIG="$dc" docker compose -p setup-test config --format json 2>/dev/null) |
    python3 -I -c '
import json, sys
env = json.load(sys.stdin)["services"]["api"]["environment"]
# Compose prints a literal $ as $$ (its escape, for reading the output back).
read = lambda key: (env.get(key) or "").replace("$$", "$")
want = {"TELFLO_SMTP_USERNAME": sys.argv[1], "TELFLO_SMTP_PASSWORD": sys.argv[2], "TELFLO_MAIL_FROM": sys.argv[3]}
bad = [key for key, path in want.items() if read(key) != open(path).read()]
print("differs: " + " ".join(bad) if bad else "same")
' "$c.username" "$c.password" "$c.from" >"$c.compared" && [ "$(cat "$c.compared")" = same ]
}
if docker compose version >/dev/null 2>&1; then
  run_case "a relay's username, password and sender with \$ # \\ \" and a space: Compose reads them back exactly" odd_relay
else
  echo "SKIP - a relay's free text as Compose reads it (needs the docker CLI and its compose plugin)"
  SKIPPED=$((SKIPPED + 1))
fi

echo "# unknown options are never echoed whole"
option_with_value() {
  fresh && setup "${URLS[@]}" --mailpit --smtp-password=not-echoed-canary && rc_is 2 &&
    said "unknown option --smtp-password" && ! said "not-echoed-canary" && nothing_written
}
stray_word() {
  fresh && setup "${URLS[@]}" --mailpit not-echoed-canary && rc_is 2 &&
    said "an unexpected argument (not shown)" && ! said "not-echoed-canary" && nothing_written
}

echo "# usage (exit 2, nothing written)"
usage_case() { # <expected text> <args...>
  local expect="$1"; shift
  fresh && setup "$@" && rc_is 2 && said "$expect" && said "usage: ./setup.sh" && nothing_written
}
RELAY=(--smtp-host smtp.example.com --smtp-port 587 --mail-from telflo@example.com)
URLS=(--public-url https://telflo.example.com --agent-url https://opamp.example.com)
run_case "--mailpit with a relay option" usage_case "--mailpit takes no relay option" "${URLS[@]}" --mailpit --smtp-host smtp.example.com
run_case "neither --mailpit nor a relay" usage_case "choose the mail" "${URLS[@]}"
run_case "--smtp-password is unknown (a password never on the command line)" usage_case "unknown option --smtp-password" \
  "${URLS[@]}" "${RELAY[@]}" --smtp-username telflo --smtp-password x
run_case "no --public-url" usage_case "--public-url is required" --agent-url https://opamp.example.com --mailpit
run_case "no --agent-url" usage_case "--agent-url is required" --public-url https://telflo.example.com --mailpit
run_case "a relay without --mail-from" usage_case "--mail-from is required" "${URLS[@]}" --smtp-host smtp.example.com --smtp-port 587
run_case "a username without a password file" usage_case "go together" "${URLS[@]}" "${RELAY[@]}" --smtp-username telflo
run_case "--smtp-tls none with a login" usage_case "takes no --smtp-username" "${URLS[@]}" "${RELAY[@]}" --smtp-tls none \
  --smtp-username telflo --smtp-password-file "$tmp/relay-password"
run_case "an unknown --smtp-tls" usage_case "--smtp-tls must be" "${URLS[@]}" "${RELAY[@]}" --smtp-tls ssl
run_case "a port out of range" usage_case "--http-port must be a port" "${URLS[@]}" --mailpit --http-port 70000
run_case "the same port twice" usage_case "must differ" "${URLS[@]}" --mailpit --http-port 51234
run_case "--mailpit-port without --mailpit" usage_case "--mailpit-port goes with --mailpit only" "${URLS[@]}" "${RELAY[@]}" \
  --mailpit-port 33762
run_case "--mailpit-port out of range" usage_case "--mailpit-port must be a port from 1 to 65535" "${URLS[@]}" --mailpit \
  --mailpit-port 70000
run_case "--mailpit-port not a number" usage_case "--mailpit-port must be a port from 1 to 65535" "${URLS[@]}" --mailpit \
  --mailpit-port 80x
run_case "--mailpit-port 0" usage_case "--mailpit-port must be a port from 1 to 65535" "${URLS[@]}" --mailpit --mailpit-port 0
run_case "--mailpit-port the same as --http-port" usage_case "--mailpit-port (8025 unless given) must differ" "${URLS[@]}" \
  --mailpit --http-port 33762 --mailpit-port 33762
run_case "--mailpit-port the same as --agent-port" usage_case "--mailpit-port (8025 unless given) must differ" "${URLS[@]}" \
  --mailpit --agent-port 33762 --mailpit-port 33762
run_case "Mailpit's default port 8025 as --http-port" usage_case "--mailpit-port (8025 unless given) must differ" "${URLS[@]}" \
  --mailpit --http-port 8025
run_case "a bind address that isn't IPv4" usage_case "--bind must be an IPv4 address" "${URLS[@]}" --mailpit --bind localhost
run_case "an agent URL with a path" usage_case "--agent-url must be an origin" --public-url https://telflo.example.com \
  --agent-url https://opamp.example.com/opamp/api/v1 --mailpit
run_case "a public URL that isn't http(s)" usage_case "--public-url must be an origin" --public-url ftp://telflo.example.com \
  --agent-url https://opamp.example.com --mailpit
run_case "an option given twice" usage_case "--mailpit given twice" "${URLS[@]}" --mailpit --mailpit
run_case "--smtp-password=<value> is named without its value" option_with_value
run_case "a stray word is refused without being echoed" stray_word
help_case() {
  fresh && setup --help && rc_is 0 && said "usage: ./setup.sh --public-url <url> --agent-url <url>" &&
    said "(--mailpit [--mailpit-port <port>] |" && nothing_written
}
run_case "--help prints the usage, exit 0" help_case

echo "# $passed passed, $failed failed, $SKIPPED skipped"
[ "$failed" -eq 0 ]
