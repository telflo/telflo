# shellcheck shell=bash
# version.sh: the release version's one pattern, a reader of Chart.yaml,
# and the form the Compose install names its Telflo images in. Sourced,
# never run:
#
#   . scripts/release/version.sh
#   telflo_version_ok <text>            exit 0 when <text> is a release version
#   telflo_chart_field <Chart.yaml> <key>
#                                       print the top-level <key>'s value (version,
#                                       appVersion), its quotes removed; exit 1 when
#                                       the file is missing or holds the key other
#                                       than exactly once
#
# A release version is MAJOR.MINOR.PATCH: digits only, no leading zeros,
# nothing before or after (no "v", no pre-release, no build metadata). The
# first release is 0.1.0. Everything that checks a version's shape reads
# TELFLO_VERSION_RE, or calls telflo_version_ok, from here.
#
# deploy/compose/compose.yaml names each Telflo image as
# TELFLO_COMPOSE_IMAGE_PREFIX<name>:<version>, that is
# ${TELFLO_IMAGE_REGISTRY:-ghcr.io/telflo/telflo}/<name>:<version>: Compose
# reads TELFLO_IMAGE_REGISTRY from the install's .env or its environment,
# and takes TELFLO_COMPOSE_IMAGE_DEFAULT, the public registry, when it is
# unset or empty. Everything that reads those image lines reads the form
# from here.
# bash 3.2 compatible; it sets no shell option.

TELFLO_VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
# shellcheck disable=SC2034 # read by the scripts that source this
TELFLO_COMPOSE_IMAGE_DEFAULT='ghcr.io/telflo/telflo'
# shellcheck disable=SC2016,SC2034 # Compose's ${...}, kept as text
TELFLO_COMPOSE_IMAGE_PREFIX='${TELFLO_IMAGE_REGISTRY:-ghcr.io/telflo/telflo}/'

telflo_version_ok() {
  # The C locale: a range like [0-9] means the ten ASCII digits only.
  local LC_ALL=C
  [[ "$1" =~ $TELFLO_VERSION_RE ]]
}

telflo_chart_field() {
  local file="$1" key="$2" value
  [ -f "$file" ] || return 1
  [ "$(grep -c "^$key:" "$file")" = 1 ] || return 1
  value="$(sed -n "s/^$key:[[:space:]]*//p" "$file")"
  # Trailing blanks dropped; one pair of matching quotes removed.
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s\n' "$value"
}
