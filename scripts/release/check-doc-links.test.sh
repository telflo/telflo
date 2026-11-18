#!/usr/bin/env bash
# check-doc-links.sh's self-test (D36-2 Ruling 393): the real tree passes;
# in throwaway copies (the script beside this test, at scripts/release/, and
# docs written per case) a sound set of docs passes, in a git checkout and
# in a copy that isn't one, and each of these fails, naming the problem:
#   a link to a missing file; a #anchor no heading makes; an anchor on a file
#   that isn't Markdown; a link leading outside the repository; a link to a
#   file git ignores (in a checkout); a broken image, reference definition
#   and HTML src. And these pass: a heading with inline code, a repeated
#   heading's -1, an HTML id, a folder, a new file git doesn't ignore, a
#   link from the root (/…), external links, links inside fenced and inline
#   code (not read); any argument exits 2.
#
# Run: scripts/release/check-doc-links.test.sh
# Offline; prints PASS/FAIL lines only; exit 1 when any case failed. The
# copies live in a temporary directory removed on exit; git runs there with
# no global or system configuration. The repository's own files are only
# read. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-doc-links-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1

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

# fresh [--git]: a new copy in $c: the script, and a sound set of docs.
fresh() {
  n=$((n + 1)); c="$tmp/case$n"
  mkdir -p "$c/scripts/release" "$c/docs/conventions" "$c/charts/telflo" "$c/deploy/compose" "$c/assets" || return 1
  cp "$SCRIPT_DIR/check-doc-links.sh" "$c/scripts/release/" || return 1
  printf 'logo\n' >"$c/assets/logo.svg"
  printf 'notes\n' >"$c/notes.txt"
  cat >"$c/README.md" <<'EOF'
<p align="center"><picture><source srcset="assets/logo.svg"><img alt="" src="assets/logo.svg"></picture></p>

# Telflo

See [the guide](docs/guide.md), [its settings](docs/guide.md#the-telflo_port-setting),
[the second one](docs/guide.md#again-1), [the marked place](docs/guide.md#marked),
the [docs folder](docs/), [this file's start](#telflo) and [the notes](/notes.txt).
External: [the site](https://telflo.example/x#y), [mail](mailto:x@example.com),
[a host](//example.com/z).

Not read: `[code](missing-inline.md)`.

```sh
# Not read: [fenced](missing-fenced.md)
```

[ref]: docs/conventions/testing.md
EOF
  cat >"$c/docs/guide.md" <<'EOF'
# The guide

## The `TELFLO_PORT` setting

## Again

## Again

<a id="marked"></a>

Back to [the README](../README.md) and [testing](conventions/testing.md#the-smokes).
EOF
  printf '# Testing\n\n## The smokes\n\nThe chart: [its README](../../charts/telflo/README.md).\n' >"$c/docs/conventions/testing.md"
  printf '# The chart\n\n[Compose](../../deploy/compose/README.md#compose)\n' >"$c/charts/telflo/README.md"
  printf '# Compose\n\n[Up](../../README.md#telflo)\n' >"$c/deploy/compose/README.md"
  if [ "${1:-}" = --git ]; then
    printf 'ignored.md\n' >"$c/.gitignore"
    git -C "$c" init -q && git -C "$c" add -A && git -C "$c" -c user.name=t -c user.email=t@example.invalid commit -q -m fixture || return 1
  fi
}

# check <want exit> [<text the output must hold>]: runs the copy's script.
check() {
  local want="$1" text="${2:-}" out code
  out="$(bash "$c/scripts/release/check-doc-links.sh" 2>&1)"; code=$?
  [ "$code" -eq "$want" ] || return 1
  [ -z "$text" ] || printf '%s\n' "$out" | grep -qF -- "$text"
}

# quiet <command...>: runs it with no output.
quiet() { "$@" >/dev/null 2>&1; }

# add <file> <line>: appends a line to a doc of the copy.
add() { printf '%s\n' "$2" >>"$c/$1"; }

run_case "the real tree passes" quiet bash "$SCRIPT_DIR/check-doc-links.sh"

fresh --git && run_case "a sound set of docs passes (a git checkout)" check 0 "0 problem(s)"
fresh && run_case "a sound set of docs passes (not a checkout)" check 0 "0 problem(s)"
fresh --git && run_case "it reads the five places" check 0 "in 5 files"

fresh --git && add docs/guide.md "[gone](nowhere.md)" &&
  run_case "a missing file fails, naming it" check 1 "docs/guide.md:12: nowhere.md: no such file or folder in the repository (docs/nowhere.md)"
fresh && add docs/guide.md "[gone](nowhere.md)" &&
  run_case "a missing file fails (not a checkout)" check 1 "no such file or folder in the repository (docs/nowhere.md)"
fresh --git && add README.md "[no such heading](docs/guide.md#the-port)" &&
  run_case "a missing anchor fails, naming it" check 1 "docs/guide.md#the-port: no heading #the-port in docs/guide.md"
fresh --git && add README.md "[third](docs/guide.md#again-2)" &&
  run_case "a repeated heading's -2 that isn't there fails" check 1 "no heading #again-2"
fresh --git && add docs/conventions/testing.md "[here](#nothing-here)" &&
  run_case "a missing anchor in the file itself fails" check 1 "#nothing-here: no heading #nothing-here in docs/conventions/testing.md"
fresh --git && add README.md "[notes](notes.txt#top)" &&
  run_case "an anchor on a file that isn't Markdown fails" check 1 "an anchor on something that isn't a Markdown file"
fresh --git && add README.md "[up](../outside.md)" &&
  run_case "a link outside the repository fails" check 1 "leads outside the repository"
fresh --git && printf '# Ignored\n' >"$c/ignored.md" && add README.md "[ignored](ignored.md)" &&
  run_case "a file git ignores doesn't count (a checkout)" check 1 "no such file or folder in the repository (ignored.md)"
fresh --git && printf '# New\n' >"$c/docs/new.md" && add README.md "[new](docs/new.md#new)" &&
  run_case "a new file git doesn't ignore counts" check 0 "0 problem(s)"
fresh --git && add README.md "![broken](assets/none.svg)" &&
  run_case "a broken image fails" check 1 "assets/none.svg: no such file"
fresh --git && add README.md "[r2]: docs/none.md" &&
  run_case "a broken reference definition fails" check 1 "docs/none.md: no such file"
fresh --git && add README.md '<img alt="" src="assets/none.png">' &&
  run_case "a broken HTML src fails" check 1 "assets/none.png: no such file"
fresh --git && add README.md "[a](a.md) and [b](docs/b.md#x)" &&
  run_case "each problem is counted" check 1 "2 problem(s)"
exits_2() { bash "$c/scripts/release/check-doc-links.sh" x >/dev/null 2>&1; [ $? -eq 2 ]; }
fresh --git && run_case "any argument exits 2" exits_2
echo "check-doc-links.test: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
