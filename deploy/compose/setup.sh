#!/usr/bin/env bash
# setup.sh: writes the Compose install's settings and secrets, once, in the
# folder this script is in (the unpacked release):
#
#   ./setup.sh --public-url <url> --agent-url <url> [--http-port <port>]
#              [--agent-port <port>] [--bind <address>]
#              (--mailpit [--mailpit-port <port>] | --smtp-host <host> --smtp-port <port>
#               --mail-from <address> [--smtp-tls starttls|implicit|none]
#               [--smtp-username <name> --smtp-password-file <file>])
#
# It writes .env (mode 0600; every setting compose.yaml reads, and every
# secret the API, the opamp-server, the database and the validator read
# from their environment) and secrets/ (mode 0700; the three secrets the
# services read only from files: the opamp-server's encryption key, the
# tester's and the evaluator's shared secrets, the last two also in .env for
# the API). Each file in secrets/ is 0644: Compose mounts it as it is
# (Compose ignores a secret's mode and owner), and the services run as their
# own users, which must be able to read it; the 0700 folder keeps everyone
# else out.
#
# It refuses when .env or secrets/ exists: it never makes new secrets over
# an existing database. Every secret is new, from `openssl rand`, by
# scripts/create-secrets.sh --init's rules: hex of 32 random bytes (URL-safe,
# so the five Postgres passwords fit in database URLs), the quick-deploy key
# base64 of exactly 32 bytes. It refuses to write any of the development
# stack's public secrets (docker-compose.yml's and docker/*/development-*),
# a generated one or a relay password read from --smtp-password-file: it
# holds their sha256 only (scripts/release/check-compose-install.sh checks
# the list is complete).
#
# --public-url is the gateway's origin as browsers reach it (no path):
# TELFLO_PUBLIC_WEB_URL and TELFLO_PUBLIC_API_URL. https makes the session
# cookies Secure; http is allowed only on localhost, 127.0.0.1 or [::1] (the
# API's own rule). --agent-url is the agent endpoint's origin as collectors
# reach it; /opamp/api/v1 is appended, for the opamp-server's
# OPAMP_SERVER_URL and the API's TELFLO_OPAMP_AGENT_PUBLIC_URL, and an http
# one lets collectors connect without TLS. The ports default to 8080 (the
# gateway) and 51234 (the agent endpoint), published on --bind (an IPv4
# address, 127.0.0.1 by default; 0.0.0.0 only when your TLS proxy is on
# another machine).
#
# Mail: exactly one of --mailpit (Mailpit, for trying Telflo only: the API
# sends to it in cleartext, and its inbox is on 127.0.0.1, port 8025 or
# --mailpit-port's, which must differ from the other two) or a real relay.
# A relay's password is read from a file (its owner's alone, mode 0600),
# never from the command line; --smtp-tls none (cleartext) takes no login.
#
# It never prints a value: its output is fixed lines and the next steps.
# Exit 0 done, 1 refused (nothing written), 2 usage. bash 3.2 compatible
# (macOS's /bin/bash), POSIX tools and openssl only.
set -euo pipefail
# Never traced (`bash -x` would print every value it handles).
set +x
umask 077
export LC_ALL=C

usage() {
  cat <<'EOF'
usage: ./setup.sh --public-url <url> --agent-url <url> [--http-port <port>]
                  [--agent-port <port>] [--bind <address>]
                  (--mailpit [--mailpit-port <port>] | --smtp-host <host> --smtp-port <port>
                   --mail-from <address> [--smtp-tls starttls|implicit|none]
                   [--smtp-username <name> --smtp-password-file <file>])
EOF
}
refuse_usage() { echo "setup: $1" >&2; usage >&2; exit 2; }
refuse() { echo "setup: $1" >&2; exit 1; }

# The sha256 of every development secret (docker-compose.yml's values and
# the docker/*/development-* files), never the values themselves.
DEVELOPMENT_SECRET_SHA256="
95d87a7d99428a9509dbefe9c04029615f7dc17ade744a63e4b389e444932bd3
9a38e032ae93f4ff1ed43cb39bf86e6cb9c799b5a9981ea9194e4d4d64bf8c23
23f946ce9f534b275b5a6eb6c5f7a057f4eb7a123eb3fc8a1a8612f2c9013dd6
542aeadabc17ddc5e136c0fdc38f81d0e244cc8259d5a4299a5be03a62ab9ea3
1818cf4a7965d9979cc6c12836f3190011bd76f462eff5ed3cd7f3d992d40707
9b1bbaa1c813d3af343c8781e1745e65458c99136558adc6e3a7356eb6bfc5d4
d2ee6cbb0cedf520c6e20b2a2490be170768b5bcdc53febe960f5153a37a969e
ff5e6ede9bee4ae2530eba81248954378066d3f972176b5b9270e92634eb28cc
ddec60ade280b3326b7397ab32f6720d2c030c4db6119e3aa96c0a2c5e1edd24
c6b879f8cda0b81563dcdb4f43d29ccf78f39ec527741888ca76b444d690a4b3
11f77e94567ca4c06f746908abf3b31771626f6801cf77f07b194893ce50d77d
49307d802e0e9afb82410dca84db4ffcbec6621941ea0edb70380313a7c4c051
4c5c483999d52a4301034c2d55485af96330c3e54db04b02223b7414a68438be
3c39dd61bb703ea78a72f9a3c260cdbcc50a1ba9cea41c82ee6e94bf851aaee9
"

HEX_RE='^[0-9a-f]{64}$'
BASE64_KEY_RE='^[A-Za-z0-9+/]{43}=$'
PORT_RE='^[1-9][0-9]{0,4}$'
# An origin: http or https, a host name, an IPv4 address or a bracketed IPv6
# one, an optional port, nothing after but one optional /.
ORIGIN_RE='^(https?)://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(:([0-9]{1,5}))?/?$'
IPV4_RE='^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$'
HOST_RE='^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$'
MAIL_FROM_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
# Printable ASCII, spaces inside but not at the ends, no ' (.env quotes it).
USERNAME_RE='^[!-&(-~]([ !-&(-~]*[!-&(-~])?$'

# ---- arguments ---------------------------------------------------------------------------
public_url="" agent_url="" http_port="" agent_port="" bind=""
mailpit="" mailpit_port="" smtp_host="" smtp_port="" mail_from="" smtp_tls="" smtp_username="" smtp_password_file=""
seen=" "
while [ "$#" -gt 0 ]; do
  option="$1"
  case "$option" in
    -h | --help) usage; exit 0 ;;
    --mailpit)
      case "$seen" in *" $option "*) refuse_usage "$option given twice" ;; esac
      seen="$seen$option "
      mailpit=1; shift; continue ;;
    --public-url | --agent-url | --http-port | --agent-port | --mailpit-port | --bind | --smtp-host | \
      --smtp-port | --mail-from | --smtp-tls | --smtp-username | --smtp-password-file) ;;
    # Never echoed whole: a mistyped option may carry a value (a password
    # given as --smtp-password=...), so only the part before any = is shown,
    # and a word that isn't an option not at all.
    -*) refuse_usage "unknown option ${option%%=*}" ;;
    *) refuse_usage "an unexpected argument (not shown): every value follows its option" ;;
  esac
  case "$seen" in *" $option "*) refuse_usage "$option given twice" ;; esac
  seen="$seen$option "
  [ "$#" -ge 2 ] || refuse_usage "$option needs a value"
  value="$2"
  [ -n "$value" ] || refuse_usage "$option needs a value"
  case "$option" in
    --public-url) public_url="$value" ;;
    --agent-url) agent_url="$value" ;;
    --http-port) http_port="$value" ;;
    --agent-port) agent_port="$value" ;;
    --mailpit-port) mailpit_port="$value" ;;
    --bind) bind="$value" ;;
    --smtp-host) smtp_host="$value" ;;
    --smtp-port) smtp_port="$value" ;;
    --mail-from) mail_from="$value" ;;
    --smtp-tls) smtp_tls="$value" ;;
    --smtp-username) smtp_username="$value" ;;
    --smtp-password-file) smtp_password_file="$value" ;;
  esac
  shift 2
done

[ -n "$public_url" ] || refuse_usage "--public-url is required"
[ -n "$agent_url" ] || refuse_usage "--agent-url is required"
http_port="${http_port:-8080}"
agent_port="${agent_port:-51234}"
bind="${bind:-127.0.0.1}"

port_ok() { [[ "$1" =~ $PORT_RE ]] && [ "$1" -le 65535 ]; }
port_ok "$http_port" || refuse_usage "--http-port must be a port from 1 to 65535"
port_ok "$agent_port" || refuse_usage "--agent-port must be a port from 1 to 65535"
[ "$http_port" != "$agent_port" ] || refuse_usage "--http-port and --agent-port must differ"
if [ -n "$mailpit_port" ]; then
  port_ok "$mailpit_port" || refuse_usage "--mailpit-port must be a port from 1 to 65535"
fi
if [[ "$bind" =~ $IPV4_RE ]]; then
  for part in "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; do
    [ "$((10#$part))" -le 255 ] || refuse_usage "--bind must be an IPv4 address such as 127.0.0.1"
  done
else
  refuse_usage "--bind must be an IPv4 address such as 127.0.0.1"
fi

# origin_of <option> <url>: the origin without a final /, its scheme in
# $origin_scheme and its host, lower-cased, in $origin_host.
origin="" origin_scheme="" origin_host=""
origin_of() {
  local option="$1" url="$2"
  [[ "$url" =~ $ORIGIN_RE ]] ||
    refuse_usage "$option must be an origin: http:// or https://, a host, an optional port, no path (for example https://telflo.example.com)"
  origin_scheme="${BASH_REMATCH[1]}"
  origin_host="$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:upper:]' '[:lower:]')"
  if [ -n "${BASH_REMATCH[5]}" ]; then
    port_ok "${BASH_REMATCH[5]}" || refuse_usage "$option's port must be from 1 to 65535"
  fi
  origin="${url%/}"
}
origin_of --public-url "$public_url"
public_origin="$origin"
public_scheme="$origin_scheme"
public_host="$origin_host"
origin_of --agent-url "$agent_url"
agent_origin="$origin"
agent_scheme="$origin_scheme"

# Mail: --mailpit, or a relay's options, never both and never neither.
relay_given=""
for v in "$smtp_host" "$smtp_port" "$mail_from" "$smtp_tls" "$smtp_username" "$smtp_password_file"; do
  [ -z "$v" ] || relay_given=1
done
if [ -n "$mailpit" ]; then
  [ -z "$relay_given" ] || refuse_usage "--mailpit takes no relay option (--smtp-*, --mail-from): choose one"
  mailpit_port="${mailpit_port:-8025}"
  [ "$mailpit_port" != "$http_port" ] && [ "$mailpit_port" != "$agent_port" ] ||
    refuse_usage "--mailpit-port (8025 unless given) must differ from --http-port and --agent-port"
else
  [ -n "$relay_given" ] ||
    refuse_usage "choose the mail: --mailpit (for trying Telflo) or a relay's --smtp-host, --smtp-port and --mail-from"
  [ -z "$mailpit_port" ] || refuse_usage "--mailpit-port goes with --mailpit only"
  [ -n "$smtp_host" ] || refuse_usage "--smtp-host is required with a relay"
  [ -n "$smtp_port" ] || refuse_usage "--smtp-port is required with a relay"
  [ -n "$mail_from" ] || refuse_usage "--mail-from is required with a relay"
  [[ "$smtp_host" =~ $HOST_RE ]] || refuse_usage "--smtp-host must be a host name or an address"
  port_ok "$smtp_port" || refuse_usage "--smtp-port must be a port from 1 to 65535"
  [[ "$mail_from" =~ $MAIL_FROM_RE ]] || refuse_usage "--mail-from must be an email address such as telflo@example.com"
  smtp_tls="${smtp_tls:-starttls}"
  case "$smtp_tls" in
    starttls | implicit | none) ;;
    *) refuse_usage "--smtp-tls must be starttls, implicit or none" ;;
  esac
  if [ -n "$smtp_username" ] || [ -n "$smtp_password_file" ]; then
    [ -n "$smtp_username" ] && [ -n "$smtp_password_file" ] ||
      refuse_usage "--smtp-username and --smtp-password-file go together"
    [[ "$smtp_username" =~ $USERNAME_RE ]] && [ "${#smtp_username}" -le 256 ] ||
      refuse_usage "--smtp-username must be 1 to 256 printable characters, no ' and no space at either end"
    [ "$smtp_tls" != none ] ||
      refuse_usage "--smtp-tls none sends in cleartext: it takes no --smtp-username (the API refuses a login without TLS)"
  fi
fi

# ---- refusals before anything is made ---------------------------------------------------
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/compose.yaml" ] || refuse "run the setup.sh of an unpacked Telflo release: compose.yaml isn't beside it"
if [ -e "$HERE/.env" ] || [ -L "$HERE/.env" ]; then
  refuse ".env exists already: refused (setup.sh never makes new secrets over an existing install; to start over, remove .env, secrets/ and the volumes: docker compose down -v)"
fi
if [ -e "$HERE/secrets" ] || [ -L "$HERE/secrets" ]; then
  refuse "secrets/ exists already: refused (setup.sh never makes new secrets over an existing install; to start over, remove .env, secrets/ and the volumes: docker compose down -v)"
fi
if [ "$public_scheme" = http ]; then
  case "$public_host" in
    localhost | 127.0.0.1 | "[::1]") ;;
    *) refuse "--public-url may be http only on localhost, 127.0.0.1 or [::1]: put TLS in front and give its https origin (docs/compose.md)" ;;
  esac
fi
command -v openssl >/dev/null 2>&1 || refuse "openssl is not on PATH: nothing written"

# is_development_secret <value>: true when its sha256 is one of the list's.
is_development_secret() {
  local digest
  digest="$(printf '%s' "$1" | openssl dgst -sha256 | awk '{ print $NF }')" ||
    refuse "openssl couldn't hash a value: nothing written"
  [[ "$digest" =~ $HEX_RE ]] || refuse "openssl dgst didn't answer a sha256: nothing written"
  case "$DEVELOPMENT_SECRET_SHA256" in
    *"
$digest
"*) return 0 ;;
  esac
  return 1
}

# The relay's password: the whole file, one final line ending dropped.
smtp_password=""
if [ -n "$smtp_password_file" ]; then
  [ -f "$smtp_password_file" ] && [ -r "$smtp_password_file" ] ||
    refuse "--smtp-password-file must name a readable file"
  mode="$(stat -c '%a' "$smtp_password_file" 2>/dev/null || stat -f '%Lp' "$smtp_password_file" 2>/dev/null)" ||
    refuse "--smtp-password-file: its mode couldn't be read"
  [[ "$mode" =~ ^[0-7]+$ ]] && [ $((8#$mode & 8#077)) -eq 0 ] ||
    refuse "--smtp-password-file is readable by others: make it its owner's alone (chmod 600)"
  smtp_password="$(cat -- "$smtp_password_file")" || refuse "--smtp-password-file couldn't be read"
  smtp_password="${smtp_password%$'\r'}"
  [ -n "$smtp_password" ] || refuse "--smtp-password-file is empty"
  case "$smtp_password" in
    *$'\n'* | *$'\r'* | *"'"*) refuse "--smtp-password-file must hold one line without a ' (the file .env can't hold it)" ;;
  esac
  case "$smtp_password" in
    [[:space:]]* | *[[:space:]]) refuse "--smtp-password-file's password has white space at an end" ;;
  esac
  if is_development_secret "$smtp_password"; then
    refuse "the password in --smtp-password-file is one of the development stack's public secrets: refused, nothing written"
  fi
fi

# ---- the secrets, all made before anything is written -------------------------------------
generated=""
random_hex() {
  generated="$(openssl rand -hex 32)" || refuse "openssl rand failed: nothing written"
  [[ "$generated" =~ $HEX_RE ]] || refuse "openssl rand didn't answer 64 hex characters: nothing written"
  ! is_development_secret "$generated" ||
    refuse "a generated value is one of the development stack's public secrets: refused, nothing written"
}
random_base64_key() {
  generated="$(openssl rand -base64 32)" || refuse "openssl rand failed: nothing written"
  [[ "$generated" =~ $BASE64_KEY_RE ]] || refuse "openssl rand didn't answer base64 of 32 bytes: nothing written"
  ! is_development_secret "$generated" ||
    refuse "a generated value is one of the development stack's public secrets: refused, nothing written"
}
random_hex; postgres_password="$generated"
random_hex; owner_password="$generated"
random_hex; api_password="$generated"
random_hex; opamp_owner_password="$generated"
random_hex; opamp_runtime_password="$generated"
random_hex; opamp_management_secret="$generated"
random_hex; opamp_encryption_key="$generated"
random_hex; access_token_secret="$generated"
random_base64_key; quick_deploy_key="$generated"
random_hex; library_link_key="$generated"
random_hex; validator_secret="$generated"
random_hex; testing_secret="$generated"
random_hex; evaluator_secret="$generated"
generated=""

# ---- .env's text, all of it in memory before anything is written -----------------------
cookie_secure=false
[ "$public_scheme" = https ] && cookie_secure=true
agent_insecure=false
[ "$agent_scheme" = http ] && agent_insecure=true
agent_endpoint="$agent_origin/opamp/api/v1"

# add_line <text> appends a line to env_text, a shell variable: nothing is
# written anywhere until the whole text is made, and then by one printf
# (write_exactly below). No here-document: bash keeps those in temporary
# files, which can fail.
env_text=""
add_line() { env_text="$env_text$1"$'\n'; }
add_line "# Telflo's Compose install: its settings and secrets, written by setup.sh."
add_line "# compose.yaml reads every value from here (docs/configuration.md lists"
add_line "# each setting)."
add_line "#"
add_line "# THIS FILE HOLDS SECRETS, as does secrets/ beside it. Keep both mode 0600 /"
add_line "# 0700, out of any repository, and backed up together somewhere safe: a"
add_line "# new install's secrets can't read this one's data (the opamp-server's"
add_line "# encryption key in secrets/ above all: without it the collectors'"
add_line "# enrollment tokens it stores can't be read again)."
add_line ""
add_line "# Where it listens: the gateway (plain http; your TLS goes in front) and the"
add_line "# agent endpoint, both on TELFLO_BIND_ADDRESS."
add_line "TELFLO_BIND_ADDRESS=$bind"
add_line "TELFLO_HTTP_PORT=$http_port"
add_line "TELFLO_AGENT_PORT=$agent_port"
add_line ""
add_line "# The gateway's origin, as browsers reach it (the web app's and the API's"
add_line "# public URL), and whether session cookies are Secure (true for https)."
add_line "TELFLO_PUBLIC_WEB_URL=$public_origin"
add_line "TELFLO_PUBLIC_API_URL=$public_origin"
add_line "TELFLO_COOKIE_SECURE=$cookie_secure"
add_line "# Proxies in front of the API whose X-Forwarded-For it trusts: 1, the"
add_line "# gateway; 2 when your own TLS proxy is in front of it (docs/compose.md)."
add_line "TELFLO_TRUST_PROXY_HOPS=1"
add_line ""
add_line "# The agent endpoint as collectors reach it, handed to every collector (the"
add_line "# opamp-server's OPAMP_SERVER_URL and the API's copy of it), and whether"
add_line "# collectors may connect without TLS (true for an http endpoint)."
add_line "OPAMP_SERVER_URL=$agent_endpoint"
add_line "TELFLO_OPAMP_AGENT_PUBLIC_URL=$agent_endpoint"
add_line "TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS=$agent_insecure"
add_line ""
if [ -n "$mailpit" ]; then
  add_line "# Mail goes to Mailpit, FOR TRYING TELFLO ONLY: it keeps every message in a"
  add_line "# web inbox on this machine (http://127.0.0.1:<TELFLO_MAILPIT_PORT>) instead"
  add_line "# of delivering it. COMPOSE_PROFILES=mailpit starts it with the rest. For a"
  add_line "# real relay, see README.md beside compose.yaml."
  add_line "COMPOSE_PROFILES=mailpit"
  add_line "TELFLO_MAILPIT_PORT=$mailpit_port"
  add_line "TELFLO_MAIL_TRANSPORT=smtp"
  add_line "TELFLO_MAIL_FROM=no-reply@telflo.local"
  add_line "TELFLO_SMTP_HOST=mailpit"
  add_line "TELFLO_SMTP_PORT=1025"
  add_line "TELFLO_SMTP_TLS=none"
  add_line "TELFLO_SMTP_ALLOW_INSECURE=true"
else
  add_line "# Mail goes through your relay. No profile: Mailpit isn't started."
  add_line "COMPOSE_PROFILES="
  add_line "TELFLO_MAIL_TRANSPORT=smtp"
  add_line "TELFLO_MAIL_FROM='$mail_from'"
  add_line "TELFLO_SMTP_HOST=$smtp_host"
  add_line "TELFLO_SMTP_PORT=$smtp_port"
  add_line "# starttls, implicit (TLS from the first byte) or none (cleartext)."
  add_line "TELFLO_SMTP_TLS=$smtp_tls"
  if [ "$smtp_tls" = none ]; then
    add_line "# Cleartext to the relay, as --smtp-tls none asked."
    add_line "TELFLO_SMTP_ALLOW_INSECURE=true"
  else
    add_line "TELFLO_SMTP_ALLOW_INSECURE=false"
  fi
  if [ -n "$smtp_username" ]; then
    add_line "TELFLO_SMTP_USERNAME='$smtp_username'"
    add_line "TELFLO_SMTP_PASSWORD='$smtp_password'"
  fi
fi
add_line ""
add_line "# The site: the open source's defaults (docs/configuration.md)."
add_line "# Who may make an account: invite-only (an invitation; the first admin by"
add_line "# \`telflo-admin bootstrap\`), open (anyone signs up) or closed."
add_line "TELFLO_REGISTRATION=invite-only"
add_line "# The playground (/playground): needs the next two true."
add_line "TELFLO_PLAYGROUND=false"
add_line "# Validating a configuration without signing in."
add_line "TELFLO_ANONYMOUS_VALIDATE=false"
add_line "# The flow showcase and the published flows, read without signing in."
add_line "TELFLO_PUBLIC_FLOWS=false"
add_line "# The sales inquiry form (needs TELFLO_SALES_INQUIRY_TO, its recipient)."
add_line "TELFLO_SALES_INQUIRY=false"
add_line "# Settings > Notifications (email notifications)."
add_line "TELFLO_EMAIL_NOTIFICATIONS=false"
add_line "# Where the docs links go; empty hides them."
add_line "TELFLO_DOCS_URL=https://docs.telflo.com/"
add_line "# The Terms version every user must accept; empty asks for none. A version"
add_line "# needs TELFLO_TERMS_URL and TELFLO_PRIVACY_URL."
add_line "TELFLO_TERMS_VERSION="
add_line "TELFLO_TERMS_URL="
add_line "TELFLO_PRIVACY_URL="
add_line "TELFLO_COOKIE_POLICY_URL="
add_line ""
add_line "# The secrets, each new: hex of 32 random bytes, the quick-deploy key"
add_line "# base64 of 32 bytes. The five passwords are Postgres's: its superuser"
add_line "# (postgres), the platform's owner (telflo_platform_owner, migrations), the API's role"
add_line "# (telflo_platform), and the opamp-server's owner and runtime roles."
add_line "TELFLO_POSTGRES_PASSWORD=$postgres_password"
add_line "TELFLO_OWNER_PASSWORD=$owner_password"
add_line "TELFLO_API_PASSWORD=$api_password"
add_line "TELFLO_OPAMP_OWNER_PASSWORD=$opamp_owner_password"
add_line "TELFLO_OPAMP_RUNTIME_PASSWORD=$opamp_runtime_password"
add_line "# The opamp-server management API's secret, shared by the API."
add_line "TELFLO_OPAMP_MANAGEMENT_SECRET=$opamp_management_secret"
add_line "# The API's access tokens' signing secret, the quick-deploy links' key and"
add_line "# the library links' signing key."
add_line "TELFLO_ACCESS_TOKEN_SECRET=$access_token_secret"
add_line "TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY=$quick_deploy_key"
add_line "TELFLO_LIBRARY_LINK_SIGNING_KEY=$library_link_key"
add_line "# The validator's, the tester's and the evaluator's shared secrets (the last two"
add_line "# also in secrets/, the same values: the services read only those files)."
add_line "TELFLO_OTELCOL_VALIDATOR_SECRET=$validator_secret"
add_line "TELFLO_OTELCOL_TESTING_SECRET=$testing_secret"
add_line "TELFLO_OTTL_EVALUATOR_SECRET=$evaluator_secret"

# ---- writing: secrets/ (made anew, so never an existing one), then .env ------------------
# Every file is written by write_exactly: one printf in a subshell whose
# standard output is the file itself (and nothing else, before or after:
# whatever a failed write leaves in bash's buffers can only go there, never
# to the terminal), then its size checked against the text's. A short or
# failed write is a refusal, and this run's files are removed.
made_secrets=""
env_tmp=""
made_env=""
finished=""
cleanup() {
  if [ -n "$env_tmp" ]; then rm -f "$env_tmp"; fi
  if [ -z "$finished" ]; then
    if [ -n "$made_env" ]; then rm -f "$HERE/.env"; fi
    if [ -n "$made_secrets" ]; then rm -rf "$HERE/secrets"; fi
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# write_exactly <file> <text>: <file> (this run's own, already made or
# made now) holds exactly <text>, or false.
write_exactly() {
  (exec >"$1" 2>/dev/null && printf '%s' "$2") >/dev/null 2>&1 || return 1
  [ "$(wc -c <"$1" | tr -d ' ')" = "${#2}" ]
}

mkdir "$HERE/secrets" 2>/dev/null || refuse "couldn't make secrets/ (it appeared meanwhile, or the folder isn't writable): nothing written"
made_secrets=1
chmod 700 "$HERE/secrets"
# write_secret <name> <value>: a file of this run's secrets/, no line
# ending, 0644.
write_secret() {
  write_exactly "$HERE/secrets/$1" "$2" || refuse "couldn't write secrets/$1 (the disk full, or a file size limit?): nothing kept"
  chmod 644 "$HERE/secrets/$1"
}
write_secret opamp-encryption-key "$opamp_encryption_key"
write_secret otelcol-testing-secret "$testing_secret"
write_secret ottl-evaluator-secret "$evaluator_secret"

# .env: written whole to a new temporary file of this run's (mktemp: 0600),
# then linked to its name, which fails if a .env appeared meanwhile (that
# one is never touched); the temporary name goes on every exit.
env_tmp="$(mktemp "$HERE/.env.setup.XXXXXX" 2>/dev/null)" && [ -n "$env_tmp" ] ||
  refuse "couldn't make a temporary file in this folder: nothing kept"
chmod 600 "$env_tmp"
write_exactly "$env_tmp" "$env_text" || refuse "couldn't write .env (the disk full, or a file size limit?): nothing kept"
# `ln -n` never follows a .env planted meanwhile as a link to a folder
# (without it, ln would put the file inside that folder); and the name must
# now be this run's own file, nothing else.
if ln -n "$env_tmp" "$HERE/.env" 2>/dev/null && [ -f "$HERE/.env" ] && [ ! -L "$HERE/.env" ] && [ "$HERE/.env" -ef "$env_tmp" ]; then
  made_env=1
elif [ ! -e "$HERE/.env" ] && [ ! -L "$HERE/.env" ] && mv -n "$env_tmp" "$HERE/.env" 2>/dev/null && [ ! -e "$env_tmp" ]; then
  # A filesystem without hard links: a rename that never replaces.
  made_env=1
  env_tmp=""
else
  refuse "couldn't write .env (it appeared meanwhile, or the folder isn't writable): nothing kept"
fi
env_text=""
chmod 600 "$HERE/.env"
finished=1

echo "setup: wrote .env (mode 0600) and secrets/ (mode 0700) with new secrets."
echo "setup: back up .env and secrets/ together, somewhere safe: the install's data can't be read without them."
if [ -n "$mailpit" ]; then
  echo "setup: mail goes to Mailpit, for trying Telflo only: its inbox is http://127.0.0.1:$mailpit_port, on this machine only."
fi
echo
echo "Next, in this folder:"
echo "  docker compose up -d"
echo "  docker compose ps        (until every service is healthy; the first start takes a few minutes)"
echo "  docker compose exec -T api telflo-admin bootstrap --email <your email> --organization \"<your organization>\""
echo "The last command prints a link, once: open it to set your password."
