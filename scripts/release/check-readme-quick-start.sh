#!/usr/bin/env bash
# check-readme-quick-start.sh: the README's Quick start is one the archive
# smoke can run as written (D36-2 decisions 94 and 98).
#
#   scripts/release/check-readme-quick-start.sh       (no argument; from anywhere)
#
# It reads README.md at the repository's root with
# scripts/release/quick-start.sh, as the smoke does, and checks:
#   - the markers: <!-- quick-start:begin --> and <!-- quick-start:end -->,
#     each a line of its own exactly once, the begin marker first;
#   - the ```sh blocks between them: at least one command, every block
#     closed, no joined command (a line ending in \) left open at a block's
#     end, no here-document (the smoke runs one command at a time), and
#     every command's first line right under a # comment line saying what
#     it does;
#   - the version: the release's download address is
#     https://github.com/telflo/telflo/releases/download/v<version>, where
#     <version> is charts/telflo/Chart.yaml's version, and every archive
#     name (telflo-compose-<x>) in the Quick start names that version;
#   - the texts the smoke replaces, each written exactly once in the Quick
#     start (prose and commands alike): the download address, the email
#     you@example.com, the organization "My team" (with its quotes), and
#     the ports 8080, 51234 and 8025; all but 8025 (Mailpit's inbox, which
#     the reader opens in a browser) inside a command.
#
# Offline and quick: it only reads the tree's files. Each problem is a line
# naming it. Exit 0 the Quick start is sound, 1 a problem, 2 usage. bash 3.2
# compatible.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/release/version.sh
. "$SCRIPT_DIR/version.sh"
# shellcheck source=scripts/release/quick-start.sh
. "$SCRIPT_DIR/quick-start.sh"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/release/check-readme-quick-start.sh (no argument)" >&2
  exit 2
fi

README="$REPO_DIR/README.md"
CHART_YAML="$REPO_DIR/charts/telflo/Chart.yaml"
RELEASES="https://github.com/telflo/telflo/releases/download/"
problems=0
problem() { echo "check-readme-quick-start: $*" >&2; problems=$((problems + 1)); }
done_checking() {
  if [ "$problems" -ne 0 ]; then
    echo "check-readme-quick-start: FAIL ($problems problem(s))" >&2
    exit 1
  fi
  echo "check-readme-quick-start: README.md's Quick start is sound ($1)"
  exit 0
}

# count <text> <haystack>: how many times <text> occurs in <haystack>.
count() {
  local text="$1" rest="$2" n=0
  while :; do
    case "$rest" in
      *"$text"*) n=$((n + 1)); rest="${rest#*"$text"}" ;;
      *) break ;;
    esac
  done
  echo "$n"
}

[ -f "$README" ] || { problem "README.md: missing"; done_checking ""; }

# ---- the markers
begins="$(grep -c -x '[[:space:]]*<!-- quick-start:begin -->[[:space:]]*' "$README")"
ends="$(grep -c -x '[[:space:]]*<!-- quick-start:end -->[[:space:]]*' "$README")"
[ "$begins" = 1 ] || problem "the marker $QUICK_START_BEGIN is there $begins time(s), not once"
[ "$ends" = 1 ] || problem "the marker $QUICK_START_END is there $ends time(s), not once"
if ! region="$(telflo_quick_start_region "$README")"; then
  [ "$problems" -ne 0 ] || problem "the marker $QUICK_START_END comes before $QUICK_START_BEGIN"
  done_checking ""
fi

# ---- the commands
if ! parsed="$(telflo_quick_start_parse "$README")"; then
  problem "a \`\`\`sh block between the markers isn't closed, or ends inside a command joined with \\"
  parsed=""
fi
[ -n "$parsed" ] || problem "no command in a \`\`\`sh block between the markers"
commands=""
n=0
while IFS='|' read -r line commented command; do
  [ -n "$line" ] || continue
  n=$((n + 1))
  [ "$commented" = 1 ] ||
    problem "README.md:$line: the command isn't right under a # comment line saying what it does"
  case "$command" in
    *"<<"*) problem "README.md:$line: a here-document; the smoke runs one command at a time" ;;
  esac
  commands="$commands$command
"
done <<<"$parsed"

# ---- the version
if version="$(telflo_chart_field "$CHART_YAML" version)" && telflo_version_ok "$version"; then
  address="${RELEASES}v$version"
  [ "$(count "$RELEASES" "$region")" = 1 ] ||
    problem "the Quick start names $RELEASES $(count "$RELEASES" "$region") time(s), not once"
  # The archive's names: every telflo-compose-<x> in the Quick start, <x>
  # its letters, digits and . + _ - (so up to a blank, a quote, a slash or
  # a $), less the dots that end a sentence and a final .tar.gz.
  archives="$(printf '%s\n' "$region" | grep -o 'telflo-compose-[0-9A-Za-z.+_-]*' | sed 's/\.*$//; s/\.tar\.gz$//')"
  [ -n "$archives" ] || problem "the Quick start names no archive (telflo-compose-<version>)"
  while IFS= read -r archive; do
    [ -n "$archive" ] || continue
    [ "$archive" = "telflo-compose-$version" ] ||
      problem "the Quick start names $archive, not telflo-compose-$version (Chart.yaml's version)"
  done <<<"$archives"
else
  problem "charts/telflo/Chart.yaml's version can't be read, or isn't a release version"
  address=""
fi

# ---- the texts the smoke replaces
check_once() { # <text> <in a command too: yes|no>
  local text="$1" in_command="$2" seen
  seen="$(count "$text" "$region")"
  [ "$seen" = 1 ] || problem "the Quick start writes $text $seen time(s), not once"
  if [ "$in_command" = yes ]; then
    seen="$(count "$text" "$commands")"
    [ "$seen" = 1 ] || problem "the Quick start's commands write $text $seen time(s), not once"
  fi
}
[ -z "$address" ] || check_once "$address" yes
check_once "you@example.com" yes
check_once '"My team"' yes
check_once 8080 yes
check_once 51234 yes
check_once 8025 no

done_checking "$n commands, version ${version:-?}"
