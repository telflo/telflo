#!/usr/bin/env bash
# check-readme-quick-start.sh's self-test, and quick-start.sh's (D36-2
# decisions 94 and 98): the real README passes; in a throwaway copy (the
# three scripts beside this test, a Chart.yaml at 0.1.0 and a README.md
# written per case, shaped like the real Quick start) a sound Quick start
# passes and quick-start.sh lists its commands in order (comments, blank
# lines and other fences dropped, a continued line joined), and each of
# these fails, naming the problem:
#   a marker missing or twice, the end marker first; a command with a blank
#   line between it and its comment, two commands under one comment, a
#   command first in its block; a block left open, a joined command left
#   open at a block's end, a here-document; the download address at
#   another version than Chart.yaml's, an archive name at another version,
#   a Chart.yaml whose version can't be read; each text the smoke replaces
#   written twice (the address, you@example.com, "My team", 8080, 51234,
#   8025) or written only outside a command (all but 8025), and missing;
#   any argument (exit 2).
#
# Run: scripts/release/check-readme-quick-start.test.sh
# Offline; prints PASS/FAIL lines only; exit 1 when any case failed. The
# copies live in a temporary directory removed on exit; the repository's
# own files are only read. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-readme-quick-start-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
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

ADDRESS='https://github.com/telflo/telflo/releases/download/v0.1.0'
# The real tree's own release version (its Chart.yaml), for the cases on the
# repository's README: the fixtures above stay at 0.1.0 whatever it is.
REAL_VERSION="$(awk '$1 == "version:" { print $2; exit }' "$REPO_DIR/charts/telflo/Chart.yaml")"
REAL_ADDRESS="https://github.com/telflo/telflo/releases/download/v$REAL_VERSION"

# fresh: a new copy in $c: the three scripts, Chart.yaml at 0.1.0, and a
# sound README.md (line numbers matter to the cases below: the address's
# command is on line 8, the curl on line 11, the setup on line 22).
fresh() {
  n=$((n + 1)); c="$tmp/case$n"
  mkdir -p "$c/scripts/release" "$c/charts/telflo" || return 1
  cp "$SCRIPT_DIR/check-readme-quick-start.sh" "$SCRIPT_DIR/quick-start.sh" "$SCRIPT_DIR/version.sh" "$c/scripts/release/" || return 1
  printf 'apiVersion: v2\nname: telflo\nversion: 0.1.0\nappVersion: "0.1.0"\n' >"$c/charts/telflo/Chart.yaml"
  cat >"$c/README.md" <<'EOF'
# Telflo

Before the steps: 8080, you@example.com and "My team" may be written here.

<!-- quick-start:begin -->
```sh
# Save the download address.
release=https://github.com/telflo/telflo/releases/download/v0.1.0

# Download the archive and the checksums.
curl -fsSL -O "$release/telflo-compose-0.1.0.tar.gz" \
  -O "$release/SHA256SUMS"
```

```yaml
# Not a command: a YAML block.
receivers: {}
```

```sh
# Write the settings.
./setup.sh --public-url http://localhost:8080 --agent-url http://localhost:51234 --mailpit
# Make the first admin.
docker compose exec -T api telflo-admin bootstrap --email you@example.com --organization "My team"
```

Open Mailpit's inbox, `http://127.0.0.1:8025`, and unpack telflo-compose-0.1.0.

<!-- quick-start:end -->

After the steps: 8025, 51234 and the address may be written again.
EOF
}
# edit <sed expression>: change the copy's README.md in place.
edit() { sed -i.bak "$1" "$c/README.md" && rm -f "$c/README.md.bak"; }
# check: run the copy's check; its output in $c.out, its exit status in $c.rc.
check() { (cd "$tmp" && bash "$c/scripts/release/check-readme-quick-start.sh" "$@") >"$c.out" 2>&1; echo $? >"$c.rc"; }
rc_is() { [ "$(cat "$c.rc")" = "$1" ]; }
said() { grep -qF -- "$1" "$c.out"; }
fails_saying() { check && rc_is 1 && said "$1"; }

echo "# the real tree"
real_tree() { (cd "$tmp" && bash "$REPO_DIR/scripts/release/check-readme-quick-start.sh") >"$tmp/real.out" 2>&1; }
run_case "the repository's own README passes" real_tree
real_listing() {
  local listed
  listed="$(bash -c '. "$1/scripts/release/quick-start.sh" && telflo_quick_start_commands "$1/README.md"' _ "$REPO_DIR")" &&
    [ -n "$REAL_VERSION" ] && [ -n "$listed" ] && printf '%s\n' "$listed" | grep -qF -- "$REAL_ADDRESS" &&
    printf '%s\n' "$listed" | grep -q '^docker compose down -v$'
}
run_case "quick-start.sh lists the real README's commands (the download address first, the clean-up's down -v)" real_listing

echo "# a sound Quick start"
sound() { fresh && check && rc_is 0 && said "README.md's Quick start is sound (4 commands, version 0.1.0)"; }
run_case "a sound Quick start passes, texts outside the markers ignored" sound
listing() {
  fresh || return 1
  local want got
  want="release=$ADDRESS
curl -fsSL -O \"\$release/telflo-compose-0.1.0.tar.gz\" -O \"\$release/SHA256SUMS\"
./setup.sh --public-url http://localhost:8080 --agent-url http://localhost:51234 --mailpit
docker compose exec -T api telflo-admin bootstrap --email you@example.com --organization \"My team\""
  got="$(bash -c '. "$1/scripts/release/quick-start.sh" && telflo_quick_start_commands "$1/README.md"' _ "$c")" &&
    [ "$got" = "$want" ]
}
run_case "quick-start.sh lists the commands in order: comments and the yaml block dropped, the continued curl joined" listing
parse_lines() {
  fresh || return 1
  local got
  got="$(bash -c '. "$1/scripts/release/quick-start.sh" && telflo_quick_start_parse "$1/README.md"' _ "$c" | cut -d'|' -f1,2 | tr '\n' ' ')" &&
    [ "$got" = "8|1 11|1 22|1 24|1 " ]
}
run_case "quick-start.sh's parse gives each command's first line and whether a comment is right above it" parse_lines

echo "# the markers"
no_begin() { fresh && edit '/quick-start:begin/d' && fails_saying "the marker <!-- quick-start:begin --> is there 0 time(s), not once"; }
run_case "no begin marker fails" no_begin
no_end() { fresh && edit '/quick-start:end/d' && fails_saying "the marker <!-- quick-start:end --> is there 0 time(s), not once"; }
run_case "no end marker fails" no_end
begin_twice() { fresh && printf '<!-- quick-start:begin -->\n' >>"$c/README.md" && fails_saying "the marker <!-- quick-start:begin --> is there 2 time(s), not once"; }
run_case "a begin marker twice fails" begin_twice
end_first() {
  fresh && edit 's/quick-start:begin/quick-start:TEMP/; s/quick-start:end/quick-start:begin/; s/quick-start:TEMP/quick-start:end/' &&
    fails_saying "the marker <!-- quick-start:end --> comes before <!-- quick-start:begin -->"
}
run_case "the end marker before the begin marker fails" end_first

echo "# the commands"
blank_between() { fresh && edit '/^# Save the download address\.$/{G;}' && fails_saying "README.md:9: the command isn't right under a # comment line"; }
run_case "a blank line between a comment and its command fails, naming the line" blank_between
two_under_one() { fresh && edit '/^# Make the first admin\.$/d' && fails_saying "README.md:23: the command isn't right under a # comment line"; }
run_case "two commands under one comment fail, naming the second" two_under_one
first_in_block() { fresh && edit '/^# Write the settings\.$/d' && fails_saying "README.md:21: the command isn't right under a # comment line"; }
run_case "a command first in its block, with no comment, fails" first_in_block
heredoc() {
  fresh && edit 's/^\.\/setup\.sh \(.*\)$/.\/setup.sh \1 <<EOF/' && fails_saying "README.md:22: a here-document"
}
run_case "a here-document fails" heredoc
open_block() { fresh && edit '25d' && fails_saying "a \`\`\`sh block between the markers isn't closed"; }
run_case "a block left open fails" open_block
open_join() { fresh && edit 's/--mailpit$/--mailpit \\/' && edit '23,24d' && fails_saying "ends inside a command joined with"; }
run_case "a joined command left open at its block's end fails" open_join
no_commands() {
  fresh && edit '/^```sh$/,/^```$/d' && fails_saying "no command in a \`\`\`sh block between the markers"
}
run_case "a Quick start without a sh block fails" no_commands

echo "# the version"
address_other() {
  fresh && edit 's|releases/download/v0\.1\.0|releases/download/v0.1.1|' &&
    fails_saying "the Quick start writes $ADDRESS 0 time(s), not once"
}
run_case "the download address at another version than Chart.yaml's fails" address_other
archive_other() {
  fresh && edit 's/telflo-compose-0\.1\.0\.tar\.gz/telflo-compose-0.1.1.tar.gz/' &&
    fails_saying "the Quick start names telflo-compose-0.1.1, not telflo-compose-0.1.0 (Chart.yaml's version)"
}
run_case "an archive name at another version fails" archive_other
archive_prose_other() {
  fresh && edit 's/unpack telflo-compose-0\.1\.0\./unpack telflo-compose-0.0.9./' &&
    fails_saying "the Quick start names telflo-compose-0.0.9, not telflo-compose-0.1.0"
}
run_case "an archive name in the prose at another version fails too" archive_prose_other
bad_chart() {
  fresh && printf 'apiVersion: v2\nversion: 0.1.0-rc.1\nappVersion: "0.1.0"\n' >"$c/charts/telflo/Chart.yaml" &&
    fails_saying "charts/telflo/Chart.yaml's version can't be read, or isn't a release version"
}
run_case "a Chart.yaml whose version isn't a release version fails" bad_chart

echo "# the texts the smoke replaces"
twice() { # <text> <sed expression adding it once more inside the markers>
  fresh && edit "$2" && fails_saying "the Quick start writes $1 2 time(s), not once"
}
run_case "the download address twice fails" twice "$ADDRESS" 's|^Open Mailpit|See https://github.com/telflo/telflo/releases/download/v0.1.0. Open Mailpit|'
run_case "you@example.com twice fails" twice "you@example.com" 's/^Open Mailpit/Mail you@example.com. Open Mailpit/'
run_case "\"My team\" twice fails" twice '"My team"' 's/^Open Mailpit/See "My team". Open Mailpit/'
run_case "8080 twice fails" twice 8080 's/^Open Mailpit/Port 8080. Open Mailpit/'
run_case "51234 twice fails" twice 51234 's/^Open Mailpit/Port 51234. Open Mailpit/'
run_case "8025 twice fails" twice 8025 's/^Open Mailpit/Port 8025. Open Mailpit/'
prose_only() { # <text> <sed expression moving it out of its command>
  fresh && edit "$2" && fails_saying "the Quick start's commands write $1 0 time(s), not once"
}
run_case "you@example.com in the prose only fails" prose_only "you@example.com" 's/--email you@example\.com/--email someone@example.org/; s/^Open Mailpit/Mail you@example.com. Open Mailpit/'
run_case "8080 in the prose only fails" prose_only 8080 's|localhost:8080|localhost:9090|; s/^Open Mailpit/Port 8080. Open Mailpit/'
missing_text() { fresh && edit 's/http:\/\/127\.0\.0\.1:8025/Mailpit/' && fails_saying "the Quick start writes 8025 0 time(s), not once"; }
run_case "8025 nowhere in the Quick start fails" missing_text

echo "# usage"
an_argument() { fresh && check README.md && rc_is 2; }
run_case "any argument is a usage error (exit 2)" an_argument

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
