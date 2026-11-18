#!/bin/bash
set -euo pipefail

# Telflo's OpAMP supervisor, for a host that already has otelcol-contrib:
# launcher. Run it as root (sudo): it installs a binary root runs.
#
# The bundle's files, unpacked into the root path chosen in Telflo's install
# dialog:
#   start_supervisor.sh      this file (mode 0700: it holds the values typed
#                            for the configuration's variables)
#   supervisor-config.yaml   the supervisor's configuration
#   otelcol-config.yaml      the collector's starting configuration (no-op)
#   README.md
#
# Reads the host's collector's version (its --version), downloads the
# matching OpAMP supervisor, checks its sha256, installs it root-owned beside
# this script and execs it; Telflo then manages the collector's
# configuration over OpAMP. A collector whose version can't be read, or that
# Telflo doesn't offer, gets the supervisor of the version the group's
# published version is built for.
#
# Telflo wrote the values below when it made the bundle, each one shell word
# in single quotes. A template edited by an operator keeps that form: every
# Telflo value stands alone on an assignment line, never inside a quote or a
# heredoc. Templates are the operator's own code, run as root.
executable_path=${EXECUTABLE_PATH}
default_supervisor_version=${OTELCOL_VERSION}
default_supervisor_url=${OPAMPSUPERVISOR_DOWNLOAD_URL}
default_supervisor_sha256=${OPAMPSUPERVISOR_SHA256}
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# This script's own variables can't be changed by a configuration variable
# of the same name (an export below then fails, naming it).
readonly executable_path default_supervisor_version default_supervisor_url default_supervisor_sha256 script_dir
readonly supervisor_config="$script_dir/supervisor-config.yaml"
readonly token_file="$script_dir/opamp.env"

# ----------------------------------------------------------------------
# The configuration's environment variables: the values typed in Telflo's
# install dialog, as export lines. They are set only just before the
# supervisor starts (after the downloads), so they reach the supervisor,
# which passes them to the collector, and nothing before it. Tried first in
# a subshell, so a name that is one of this script's own stops it here,
# before anything runs. A variable not listed is left to the host: export it
# before running this script.
# ----------------------------------------------------------------------
collector_env() {
${COLLECTOR_ENV_EXPORTS}
    :
}
( collector_env )

# Everything written from here on is root's alone.
umask 077

# ----------------------------------------------------------------------
# has_bad_character (the collector image's entrypoint's guard): a value
# holding, as UTF-8 bytes matched under LC_ALL=C (in a subshell, so no
# locale is restored), a C0 control or DEL but a tab, a C1 control
# (U+0080-U+009F, NEL among them), U+2028 or U+2029 (yaml.v3 breaks a line
# at each), or U+FFFE or U+FFFF (yaml.v3 refuses them).
#
# yaml_quoted: a YAML double-quoted scalar, `\` and `"` escaped and `$`
# doubled, so the supervisor's configuration expansion (`${env:NAME}`)
# leaves it literal (`$$` reads as `$`). sed rather than bash's own
# substitution, whose backslashes differ between bash versions.
#
# sed_replacement: the text for a sed replacement, `\`, `&` and the `|`
# delimiter escaped.
#
# own_and_private: the path is this user's own (root's) and writable by no
# other user or group. A symlink is judged by its target (find -H), and the
# link's own directory must be so too, or another user could point it
# elsewhere. A refused path is left in failed_path, and failed_owner is 1
# when it isn't this user's (0: another user or group may write it).
# ----------------------------------------------------------------------
has_bad_character() (
    LC_ALL=C
    v="${1//$'\t'/}"
    case "$v" in
        *[[:cntrl:]]* | *$'\xc2'[$'\x80'-$'\x9f']* | *$'\xe2\x80\xa8'* | *$'\xe2\x80\xa9'* | \
            *$'\xef\xbf\xbe'* | *$'\xef\xbf\xbf'*) exit 0 ;;
    esac
    exit 1
)

yaml_quoted() {
    printf '"%s"' "$(printf '%s' "$1" | sed -e 's/[\\"]/\\&/g' -e 's/\$/$$/g')"
}

sed_replacement() {
    printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

own_and_private() {
    if [ -z "$(find -H "$1" -maxdepth 0 -user "$(id -u)" ! -perm -0020 ! -perm -0002 2>/dev/null)" ]; then
        failed_path=$1
        failed_owner=0
        [ -n "$(find -H "$1" -maxdepth 0 -user "$(id -u)" 2>/dev/null)" ] || failed_owner=1
        return 1
    fi
    if [ -L "$1" ]; then
        own_and_private "$(dirname "$1")"
    fi
}

# This script's directory holds what root runs and reads (the supervisor,
# opamp.env).
if ! own_and_private "$script_dir"; then
    if [ "$failed_owner" = 1 ]; then
        echo "ERROR: $failed_path must be owned by $(id -un)." >&2
    else
        echo "ERROR: $failed_path must be owned by $(id -un) and writable by no other user or group." >&2
        printf 'If it was unpacked under a umask such as 0002, which lets the group write, run: sudo chmod go-w %q\n' "$failed_path" >&2
    fi
    exit 1
fi

# supervisor-config.yaml will hold the fleet's token: only root may read it,
# and every rewrite below keeps it so (sed -i and the token's own rewrite
# keep the file's mode).
chmod 600 "$supervisor_config"

# ----------------------------------------------------------------------
# The host's name: the supervisor reports it (host.name) and writes it into
# the collector's configuration, where the collector expands `${env:…}`
# again, so a name holding `"`, `\`, `$` or a control character is refused.
# ----------------------------------------------------------------------
host_name="$(hostname)"
case "$host_name" in
    *'"'* | *'\'* | *'$'*)
        echo "ERROR: the host's name holds \", \\ or \$: rename the host before installing." >&2
        exit 1
        ;;
esac
if has_bad_character "$host_name"; then
    echo "ERROR: the host's name holds a line break or another control character: rename the host before installing." >&2
    exit 1
fi

# ----------------------------------------------------------------------
# --OPAMP_SERVER_NAME: the collector's display name in Telflo.
#
#   ./start_supervisor.sh --OPAMP_SERVER_NAME='prod-collector-east-1'
#   ./start_supervisor.sh --OPAMP_SERVER_NAME="$MY_HOST_LABEL"
#
# Without it, the host's name. The ServerName line is written on every run,
# as typed: any text but a line break or another control character.
# ----------------------------------------------------------------------
server_name=""
for arg in "$@"; do
    case "$arg" in
        --OPAMP_SERVER_NAME=*)
            server_name="${arg#--OPAMP_SERVER_NAME=}"
            ;;
    esac
done

if [ -z "$server_name" ]; then
    server_name="$host_name"
fi

if has_bad_character "$server_name"; then
    echo "ERROR: --OPAMP_SERVER_NAME must not contain a line break or another control character." >&2
    exit 1
fi

name_line="$(sed_replacement "$(yaml_quoted "$server_name")")"
sed -i.bak -E "s|^( *ServerName:) *.*\$|\\1 ${name_line}|" "$supervisor_config"
rm -f "$supervisor_config.bak"

# ----------------------------------------------------------------------
# host.ip: the host's primary private address, written on every run (it is
# known only here). `ip route get` asks the kernel which source address it
# would use for outbound traffic, sending nothing. Reported to Telflo as a
# non-identifying attribute, so hosts behind one NAT address can be told
# apart. The supervisor copies attributes unescaped into its own telemetry's
# configuration, so only an address's characters are written; anything
# else (or no `ip` at all) leaves it empty.
# ----------------------------------------------------------------------
host_ip="$(ip -4 route get 1.1.1.1 2>/dev/null \
  | awk '{for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit }}' || true)"
if [ -z "$host_ip" ]; then
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
case "$host_ip" in
    *[!0-9A-Fa-f:.]*) host_ip="" ;;
esac
sed -i.bak -E "s|^( *host\\.ip:) *.*\$|\\1 \"${host_ip}\"|" "$supervisor_config"
rm -f "$supervisor_config.bak"

# ----------------------------------------------------------------------
# OPAMP_TOKEN: the fleet's token, never in the bundle.
#
# In order:
#   1. OPAMP_TOKEN set: used, and kept in opamp.env (root only, mode 600),
#      so restarts need no export. A new value replaces it (after the
#      fleet's default token is revoked and a new one issued, say).
#   2. OPAMP_TOKEN unset, opamp.env present (root's own): read from it.
#   3. Neither: stop, saying how.
#
# It is written into supervisor-config.yaml's Authorization header (a
# double-quoted scalar, `$` doubled), which only root can read, and taken
# out of the environment at once: nothing this script runs after (curl,
# tar, the host's collector's --version, the supervisor, which passes its
# environment to the collector, whose configuration expands `${env:…}`)
# ever holds it. It is never put on a command line (printf is bash's own)
# or echoed.
# ----------------------------------------------------------------------
if [ -n "${OPAMP_TOKEN:-}" ]; then
    # Checked before it is kept: a broken token never reaches opamp.env.
    if has_bad_character "$OPAMP_TOKEN"; then
        echo "ERROR: OPAMP_TOKEN holds a line break or another control character: copy it again from Telflo's install dialog." >&2
        exit 1
    fi
    escaped_token=$(printf '%s' "$OPAMP_TOKEN" | sed "s/'/'\\\\''/g")
    printf "OPAMP_TOKEN='%s'\n" "$escaped_token" > "$token_file"
    chmod 600 "$token_file"
    unset escaped_token
elif [ -f "$token_file" ]; then
    if ! own_and_private "$token_file"; then
        echo "ERROR: $failed_path must be owned by $(id -un) and writable by no other user or group." >&2
        exit 1
    fi
    # shellcheck disable=SC1090
    . "$token_file"
fi

if [ -z "${OPAMP_TOKEN:-}" ]; then
    echo "ERROR: OPAMP_TOKEN is not set and $token_file does not exist." >&2
    echo "Set the fleet's token first (Telflo's install dialog shows it) and pass it through sudo, e.g.:" >&2
    echo "  export OPAMP_TOKEN='Bearer <token>'" >&2
    echo "  sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh" >&2
    exit 1
fi
if has_bad_character "$OPAMP_TOKEN"; then
    echo "ERROR: OPAMP_TOKEN holds a line break or another control character: copy it again from Telflo's install dialog." >&2
    exit 1
fi

authorization="$(yaml_quoted "$OPAMP_TOKEN")"
unset OPAMP_TOKEN
config_with_token="$supervisor_config.new"
: > "$config_with_token"
chmod 600 "$config_with_token"
while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([\ ]*)Authorization: ]]; then
        printf '%sAuthorization: %s\n' "${BASH_REMATCH[1]}" "$authorization"
    else
        printf '%s\n' "$line"
    fi
done < "$supervisor_config" > "$config_with_token"
mv -f "$config_with_token" "$supervisor_config"
unset authorization line

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# ----------------------------------------------------------------------
# The supervisor matching the host's collector.
#
# The collector's version from its --version picks a supervisor from the
# table Telflo wrote below, one arm per collector version it offers. The two
# are separate binaries with a stable contract, so they need not match
# exactly, but matching them avoids skew in what writes the effective
# configuration and runs the OpAMP handshake. The last arm is the group's
# version's supervisor.
# ----------------------------------------------------------------------
detected_collector_version="$("$executable_path" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"

case "$detected_collector_version" in
${SUPERVISOR_VERSION_CASES}
  *)
    sup_ver="$default_supervisor_version"
    sup_url="$default_supervisor_url"
    sup_sha="$default_supervisor_sha256"
    ;;
esac

# Downloaded only when none is here yet: once a supervisor is installed it is
# left alone (the supervisor and the collector are loosely coupled). Delete
# the supervisor binary to match it again after upgrading the collector.
# Only https; installed owned by root, mode 0755.
if [ ! -f "$script_dir/supervisor" ]; then
    if [ -z "$detected_collector_version" ]; then
        echo "Could not read the collector's version from $executable_path: using the supervisor v$sup_ver."
    elif [ "$detected_collector_version" != "$sup_ver" ]; then
        echo "Telflo offers no supervisor for collector v$detected_collector_version: using the supervisor v$sup_ver."
    else
        echo "Collector v$detected_collector_version found: downloading the matching supervisor v$sup_ver."
    fi

    curl --proto '=https' -fsSL -o "$tmpdir/supervisor" "$sup_url"
    echo "$sup_sha  $tmpdir/supervisor" | sha256sum -c -
    install -o 0 -g 0 -m 0755 "$tmpdir/supervisor" "$script_dir/supervisor"
fi

rm -rf "$tmpdir"
trap - EXIT

collector_env
exec "$script_dir/supervisor" --config "$supervisor_config"
