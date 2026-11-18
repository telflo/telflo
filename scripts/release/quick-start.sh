# shellcheck shell=bash
# quick-start.sh: the README's Quick start, read as the archive smoke runs it
# (D36-2 decisions 94 and 98). Sourced, never run:
#
#   . scripts/release/quick-start.sh
#   telflo_quick_start_region <README>
#       print the lines between the two marker lines, in order; exit 1 (and
#       print nothing) unless each marker is a line of its own exactly once,
#       the begin marker first
#   telflo_quick_start_commands <README>
#       print the commands of the region's ```sh blocks, one per line, in
#       order: blank lines and comment lines (first non-blank character #)
#       dropped, a line ending in a backslash joined with the next by one
#       space (the next line's leading blanks dropped); exit 1 when the
#       region can't be read, a block isn't closed, or a block ends inside
#       a joined command
#   telflo_quick_start_parse <README>
#       the same commands as "<line>|<commented>|<command>": the README's
#       line number of the command's first line, and 1 when the line right
#       above it (in the same block) is a comment line, else 0
#
# The markers are QUICK_START_BEGIN and QUICK_START_END below. A block is a
# fence line "```sh" (blanks after it allowed) up to the next "```" line;
# other fences (```yaml, ```text) are skipped. Nothing here runs a command.
# bash 3.2 compatible; it sets no shell option; POSIX awk.

QUICK_START_BEGIN='<!-- quick-start:begin -->'
QUICK_START_END='<!-- quick-start:end -->'

telflo_quick_start_region() {
  local readme="$1"
  [ -f "$readme" ] || return 1
  awk -v begin="$QUICK_START_BEGIN" -v end="$QUICK_START_END" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    { t = trim($0) }
    t == begin { b++; if (b == 1) { bl = NR }; next }
    t == end { e++; if (e == 1) { el = NR }; next }
    { line[NR] = $0 }
    END {
      if (b != 1 || e != 1 || bl >= el) exit 1
      for (i = bl + 1; i < el; i++) print line[i]
    }' "$readme"
}

telflo_quick_start_parse() {
  local readme="$1"
  [ -f "$readme" ] || return 1
  # The region is read again here, with line numbers kept.
  awk -v begin="$QUICK_START_BEGIN" -v end="$QUICK_START_END" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    { t = trim($0); text[NR] = $0 }
    t == begin { b++; if (b == 1) bl = NR }
    t == end { e++; if (e == 1) el = NR }
    END {
      if (b != 1 || e != 1 || bl >= el) exit 1
      inblock = 0; pending = ""; first = 0; above = ""; bad = 0
      for (i = bl + 1; i < el; i++) {
        raw = text[i]; t = trim(raw)
        if (!inblock) {
          if (t ~ /^```sh$/) { inblock = 1; above = "" }
          else if (t ~ /^```/) { inblock = 2 }
          continue
        }
        if (t == "```") {
          if (inblock == 1 && pending != "") bad = 1
          inblock = 0; pending = ""; continue
        }
        if (inblock == 2) continue
        if (pending == "") {
          if (t == "") { above = "blank"; continue }
          if (substr(t, 1, 1) == "#") { above = "comment"; continue }
          first = i; commented = (above == "comment") ? 1 : 0
          piece = raw; sub(/^[[:space:]]+/, "", piece)
        } else {
          piece = raw; sub(/^[[:space:]]+/, "", piece)
        }
        sub(/[[:space:]]+$/, "", piece)
        if (piece ~ /\\$/) {
          sub(/[[:space:]]*\\$/, "", piece)
          pending = (pending == "") ? piece : pending " " piece
          continue
        }
        command = (pending == "") ? piece : pending " " piece
        print first "|" commented "|" command
        pending = ""; above = "command"
      }
      if (inblock != 0) bad = 1
      if (bad) exit 1
    }' "$readme"
}

telflo_quick_start_commands() {
  local parsed
  parsed="$(telflo_quick_start_parse "$1")" || return 1
  [ -n "$parsed" ] || return 0
  printf '%s\n' "$parsed" | sed 's/^[0-9]*|[01]|//'
}
