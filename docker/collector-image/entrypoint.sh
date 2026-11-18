#!/bin/bash
set -euo pipefail

# telflo's collector image: the container's entrypoint. The supervisor's
# configuration has no `reports_remote_config` (deprecated in the supervisor
# at 0.161.0 and refused from 0.163.0: D16a Preflight ruling 18).
#
# The image is generic: it ships NO fleet credentials. Identity arrives in
# environment variables at run time, and this script renders
# /app/supervisor-config.yaml from them on EVERY container start (so a
# changed variable applies on restart, with no rebuild). Contract:
#
#   OPAMP_ENDPOINT                     required  the OpAMP server's URL
#   OPAMP_TOKEN                        required  the fleet's bearer token
#                                                (this script adds "Bearer ")
#   OPAMP_SERVER_NAME                  optional  the collector's display name
#                                                in the fleet; a
#                                                --OPAMP_SERVER_NAME= flag wins
#   OPAMP_ALLOW_INSECURE_CONNECTIONS   optional  "true" for development
#                                                servers (default "false")
#   COLLECTOR_GROUP_ID                 required  the group the collector joins
#                                                (reported as
#                                                telflo.collector_group_id):
#                                                the opamp-server refuses a
#                                                collector naming no group
#                                                (D17d-1), so this script
#                                                refuses to start without
#                                                one, or with one that is
#                                                blank once trimmed
#
# POD_NAMESPACE, POD_NAME, NODE_NAME and HOST_IP (optional) are reported as
# Kubernetes attributes when set.
#
# The supervisor reads the token from the configuration this script writes;
# the collector it runs never has the bearer (or the other OPAMP_* variables,
# or COLLECTOR_GROUP_ID) in its environment: they are unset before the
# supervisor starts, so no `${env:OPAMP_TOKEN}` in a configuration the
# collector expands can ever yield it.
#
# APP_DIR, SUPERVISOR_BIN and HOSTNAME_FILE are overridable so
# entrypoint_test.sh can exercise this script without Docker; the image
# always uses the defaults.

APP_DIR="${APP_DIR:-/app}"
SUPERVISOR_BIN="${SUPERVISOR_BIN:-$APP_DIR/supervisor}"
SUPERVISOR_CONFIG="$APP_DIR/supervisor-config.yaml"
HOSTNAME_FILE="${HOSTNAME_FILE:-/proc/sys/kernel/hostname}"

fail() { echo "telflo-collector: $1" >&2; exit 1; }

PLAIN_PATH='^/[A-Za-z0-9._/-]*$'
[[ "$APP_DIR" =~ $PLAIN_PATH ]] || fail "APP_DIR must be a plain absolute path (letters, digits, '.', '_', '-' and '/')"

# The --OPAMP_SERVER_NAME= flag, as the Linux bundle's start_supervisor.sh
# takes it (the flag wins).
server_name="${OPAMP_SERVER_NAME:-}"
for arg in "$@"; do
  case "$arg" in
    --OPAMP_SERVER_NAME=*) server_name="${arg#--OPAMP_SERVER_NAME=}" ;;
  esac
done

[ -n "${OPAMP_ENDPOINT:-}" ] || fail "OPAMP_ENDPOINT is required (-e OPAMP_ENDPOINT=https://…)"
[ -n "${OPAMP_TOKEN:-}" ] || fail "OPAMP_TOKEN is required (-e OPAMP_TOKEN=<fleet token>)"
# The group, as the opamp-server reads it: trimmed of white space (Go's
# strings.TrimSpace), and refused when nothing is left. So a value is blank
# when it is nothing but the 25 runes TrimSpace removes, as UTF-8 bytes
# matched under LC_ALL=C: ASCII white space ([[:space:]]: space, tab, \n,
# \v, \f, \r) and the Unicode spaces unicode.IsSpace adds: U+0085, U+00A0,
# U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F and U+3000.
# One regular expression matches the whole value, in time linear in its
# length: bash's pattern expansions (`${v#...}`, `${v%%...}`) take time
# quadratic in it, minutes on a long run of spaces. LC_ALL=C makes the
# expression's bytes match bytes; under a UTF-8 locale they aren't
# characters (macOS's regular expressions refuse the expression, glibc's miss
# runes). (In a subshell, as has_bad_character below.)
blank_after_trim() (
  LC_ALL=C
  space=$'[[:space:]]|\xc2\x85|\xc2\xa0|\xe1\x9a\x80|\xe2\x80[\x80-\x8a]|\xe2\x80\xa8|\xe2\x80\xa9|\xe2\x80\xaf|\xe2\x81\x9f|\xe3\x80\x80'
  blank="^(${space})*\$"
  [[ $1 =~ $blank ]]
)
if blank_after_trim "${COLLECTOR_GROUP_ID:-}"; then
  fail "COLLECTOR_GROUP_ID is required: the id of the collector group it joins, from the fleet's install command or Helm values."
fi

# A value containing a line break could inject extra YAML keys into the
# configuration: yaml.v3 breaks a line at \n, \r, U+0085 (NEL), U+2028 (LS)
# and U+2029 (PS). The characters yaml.v3 refuses outright would stop the
# supervisor on every start. So a value is refused when it holds, as UTF-8
# bytes matched under LC_ALL=C:
#   - a C0 control or DEL (0x00-0x1f, 0x7f; [[:cntrl:]] in the C locale),
#     except a tab;
#   - a C1 control, U+0080-U+009F (0xc2 0x80-0x9f; NEL among them);
#   - U+2028 or U+2029 (0xe2 0x80 0xa8, 0xe2 0x80 0xa9);
#   - U+FFFE or U+FFFF (0xef 0xbf 0xbe, 0xef 0xbf 0xbf).
# (Bytes that aren't UTF-8 at all aren't checked: yaml.v3 refuses them too.)
# The check runs in a subshell, so setting LC_ALL there never has to restore
# a locale the image lacks (bash would warn).
has_bad_character() (
  LC_ALL=C
  v="${1//$'\t'/}"
  case "$v" in
    *[[:cntrl:]]* | *$'\xc2'[$'\x80'-$'\x9f']* | *$'\xe2\x80\xa8'* | *$'\xe2\x80\xa9'* | \
      *$'\xef\xbf\xbe'* | *$'\xef\xbf\xbf'*) exit 0 ;;
  esac
  exit 1
)
for value in "$OPAMP_ENDPOINT" "$OPAMP_TOKEN" "$server_name" "${OPAMP_ALLOW_INSECURE_CONNECTIONS:-}" \
  "${COLLECTOR_GROUP_ID:-}" "${POD_NAMESPACE:-}" "${POD_NAME:-}" "${NODE_NAME:-}" "${HOST_IP:-}" "$APP_DIR"; do
  if has_bad_character "$value"; then
    fail "env values must not contain line breaks or control characters"
  fi
done

# The supervisor (0.162.0) copies the agent's attributes, decoded, into the
# collector's merged configuration (service.telemetry.resource), inside YAML
# double quotes without escaping them: a `"` or a `\` there stops it from
# starting (or changes the value), and the collector expands a `$` there
# again (`${env:OPAMP_TOKEN}` would put the bearer in its every log line).
# The attributes are ids and Kubernetes names, which never hold any of the
# three. (The name is a header, never copied there: it keeps them.)
for name in COLLECTOR_GROUP_ID POD_NAMESPACE POD_NAME NODE_NAME HOST_IP; do
  case "${!name:-}" in
    *'"'* | *'\'* | *'$'*) fail "$name must not contain \", \\ or \$" ;;
  esac
done

# The supervisor adds the host's name (os.Hostname(), which reads
# /proc/sys/kernel/hostname) to the same attributes, so it gets the same rule:
# `docker run --hostname '${env:...}'` or a `"` there would be expanded by the
# collector or stop the supervisor. The name itself is never echoed. Only a
# regular file is read (procfs' hostname is one): `cat` on a FIFO would wait
# for a writer for ever.
host_name=""
if [ -e "$HOSTNAME_FILE" ] && [ ! -f "$HOSTNAME_FILE" ]; then
  fail "HOSTNAME_FILE must be a regular file"
elif [ -r "$HOSTNAME_FILE" ]; then
  host_name="$(cat "$HOSTNAME_FILE")"
elif command -v hostname >/dev/null 2>&1; then
  host_name="$(hostname)"
fi
if has_bad_character "$host_name"; then
  fail "the container's hostname must not contain line breaks or control characters (set another with --hostname)"
fi
case "$host_name" in
  *'"'* | *'\'* | *'$'*) fail "the container's hostname must not contain \", \\ or \$ (set another with --hostname)" ;;
esac

insecure="${OPAMP_ALLOW_INSECURE_CONNECTIONS:-false}"
case "$insecure" in
  true|false) ;;
  *) fail "OPAMP_ALLOW_INSECURE_CONNECTIONS must be 'true' or 'false' (got '$insecure')" ;;
esac

# Every value written into the YAML is a double-quoted scalar: `\` and `"`
# escaped, and `$` doubled, so the supervisor's configuration expansion
# (`${env:NAME}`, `${NAME}`) leaves it literal (`$$` reads as `$`). A name
# such as `2024`, `true`, `- prod`, `#prod` or `${env:OPAMP_TOKEN}` then
# arrives as typed.
yaml_quote() {
  local v="${1//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//\$/\$\$}"
  printf '"%s"' "$v"
}

# The ServerName header only when a name is given: without it, the OpAMP
# server names the collector.
name_header=""
if [ -n "$server_name" ]; then
  name_header="    ServerName: $(yaml_quote "$server_name")"$'\n'
fi

# The agent's attributes: the group always (refused above when blank), then
# each Kubernetes attribute that is set.
attrs="      telflo.collector_group_id: $(yaml_quote "$COLLECTOR_GROUP_ID")"$'\n'
[ -n "${POD_NAMESPACE:-}" ] && attrs="${attrs}      k8s.namespace.name: $(yaml_quote "$POD_NAMESPACE")"$'\n'
[ -n "${POD_NAME:-}" ]      && attrs="${attrs}      k8s.pod.name: $(yaml_quote "$POD_NAME")"$'\n'
[ -n "${NODE_NAME:-}" ]     && attrs="${attrs}      k8s.node.name: $(yaml_quote "$NODE_NAME")"$'\n'
[ -n "${HOST_IP:-}" ]      && attrs="${attrs}      host.ip: $(yaml_quote "$HOST_IP")"$'\n'
description_block="  description:"$'\n'"    non_identifying_attributes:"$'\n'"$attrs"

umask 077
cat > "$SUPERVISOR_CONFIG" <<EOF
server:
  endpoint: $(yaml_quote "$OPAMP_ENDPOINT")
  headers:
    Authorization: $(yaml_quote "Bearer $OPAMP_TOKEN")
${name_header}  tls:
    insecure_skip_verify: $insecure
    insecure: $insecure
capabilities:
  reports_effective_config: true
  reports_own_metrics: true
  reports_own_logs: true
  reports_health: true
  accepts_remote_config: true
  accepts_opamp_connection_settings: true
agent:
  executable: $(yaml_quote "$APP_DIR/otelcol-contrib")
  config_files:
    - $(yaml_quote "$APP_DIR/otelcol-config.yaml")
${description_block}storage:
  directory: $(yaml_quote "$APP_DIR/opamp")
EOF

# Nothing the collector needs, and the bearer above all: see the header.
unset OPAMP_TOKEN OPAMP_ENDPOINT OPAMP_SERVER_NAME OPAMP_ALLOW_INSECURE_CONNECTIONS COLLECTOR_GROUP_ID
exec "$SUPERVISOR_BIN" --config "$SUPERVISOR_CONFIG"
