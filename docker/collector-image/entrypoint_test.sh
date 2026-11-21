#!/bin/bash
# Unit tests for entrypoint.sh. No Docker and no network needed: APP_DIR
# and SUPERVISOR_BIN are overridable, and a stub supervisor records its argv
# instead of running.
# Run:  bash docker/collector-image/entrypoint_test.sh
set -u
cd "$(dirname "$0")"

failures=0
check() { # <name> <shell-expr that must succeed>
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}

# Every case runs with APP_DIR="$tmp", which the entrypoint takes only as a
# plain absolute path: under $TMPDIR when that is one, else /tmp (a TMPDIR
# holding a space, say, would fail every case for the wrong reason).
tmp_base="${TMPDIR:-/tmp}"
tmp_base="${tmp_base%/}"
[[ "$tmp_base/" =~ ^/[A-Za-z0-9._/-]*$ ]] || tmp_base=/tmp
tmp="$(mktemp -d "$tmp_base/entrypoint-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# Stub supervisor: writes its argv and its environment next to itself.
# entrypoint.sh uses exec, so each invocation below runs in a subshell to get
# control back.
cat > "$tmp/supervisor" <<'EOF'
#!/bin/bash
echo "$@" > "$(dirname "$0")/supervisor-args.txt"
env > "$(dirname "$0")/supervisor-env.txt"
EOF
chmod +x "$tmp/supervisor"
# The host's name, as the entrypoint reads it (HOSTNAME_FILE; the image reads
# /proc/sys/kernel/hostname): a plain one unless a case says otherwise.
printf 'test-host\n' > "$tmp/hostname"
export HOSTNAME_FILE="$tmp/hostname"
cfg="$tmp/supervisor-config.yaml"
# Every install names its group (the entrypoint refuses to start without one):
# each case inherits this one unless it sets its own or unsets it.
export COLLECTOR_GROUP_ID=0c0c0c0c-0000-4000-8000-00000000000c

# Reads back a value the entrypoint wrote, as the supervisor does: the first
# `<key>: ` line's YAML double-quoted scalar (only the escapes \\ and \" are
# expected), then its configuration expansion's `$$` -> `$`. Anything else
# (a bare value, another escape, a lone `$` or `"`) is not read back.
decode_scalar() { # <quoted scalar>
  local s="$1" out="" i=0 c n
  case "$s" in \"*\") ;; *) return 1 ;; esac
  s="${s#\"}"; s="${s%\"}"
  while [ "$i" -lt "${#s}" ]; do
    c="${s:$i:1}"; n="${s:$((i + 1)):1}"
    if [ "$c" = '\' ]; then
      case "$n" in '\' | '"') out="$out$n"; i=$((i + 2)) ;; *) return 1 ;; esac
    elif [ "$c" = '$' ]; then
      [ "$n" = '$' ] || return 1
      out="$out\$"; i=$((i + 2))
    elif [ "$c" = '"' ]; then
      return 1
    else
      out="$out$c"; i=$((i + 1))
    fi
  done
  printf '%s' "$out"
}
value_of() { # <key>: its value in $cfg, read back
  local line
  line="$(grep -m 1 -E "^ *$1: " "$cfg")" || return 1
  decode_scalar "${line#*"$1: "}"
}
reads_back() { # <key> <expected value>
  local got
  got="$(value_of "$1")" || return 1
  [ "$got" = "$2" ]
}
render() { # <env assignments...>: renders $cfg afresh with them
  rm -f "$cfg"
  (env APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t "$@" bash ./entrypoint.sh) >/dev/null 2>&1
}
refused() { # <env assignments...>: the entrypoint exits nonzero
  ! (env APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t "$@" bash ./entrypoint.sh) >/dev/null 2>&1
}

# --- 1. missing OPAMP_ENDPOINT: fail fast, name the variable -----------------
out=$( (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_TOKEN=t bash ./entrypoint.sh) 2>&1 )
rc=$?
check "missing endpoint exits nonzero" "[ $rc -ne 0 ]"
check "missing endpoint names OPAMP_ENDPOINT" "printf '%s' \"$out\" | grep -q OPAMP_ENDPOINT"

# --- 2. missing OPAMP_TOKEN: fail fast, name the variable --------------------
out=$( (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x bash ./entrypoint.sh) 2>&1 )
rc=$?
check "missing token exits nonzero" "[ $rc -ne 0 ]"
check "missing token names OPAMP_TOKEN" "printf '%s' \"$out\" | grep -q OPAMP_TOKEN"

# --- 3. happy path: config rendered, supervisor exec'd -----------------------
(APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://opamp.example/opamp/api/v1 \
  OPAMP_TOKEN='abc+base64/blob==' \
  OPAMP_SERVER_NAME=my-collector \
  bash ./entrypoint.sh)
check "config file rendered" "[ -f '$cfg' ]"
check "endpoint written" "grep -qF 'endpoint: \"https://opamp.example/opamp/api/v1\"' '$cfg'"
check "token gets Bearer prefix" "grep -qF 'Authorization: \"Bearer abc+base64/blob==\"' '$cfg'"
check "server name written" "grep -qF 'ServerName: \"my-collector\"' '$cfg'"
check "tls insecure defaults false" "grep -q 'insecure: false' '$cfg'"
check "storage dir points at APP_DIR/opamp" "grep -qF 'directory: \"$tmp/opamp\"' '$cfg'"
check "supervisor exec'd with --config path" "grep -qF -- \"--config $cfg\" '$tmp/supervisor-args.txt'"

# --- 4. capabilities: no reports_remote_config (deprecated in the supervisor
# at 0.161.0, refused from 0.163.0) -------------------------------------------
check "reports_remote_config absent" "! grep -q 'reports_remote_config' '$cfg'"
check "accepts_remote_config kept" "grep -q '^  accepts_remote_config: true$' '$cfg'"
check "reports_effective_config kept" "grep -q '^  reports_effective_config: true$' '$cfg'"
check "reports_health kept" "grep -q '^  reports_health: true$' '$cfg'"
check "accepts_opamp_connection_settings kept" "grep -q '^  accepts_opamp_connection_settings: true$' '$cfg'"

# --- 5. --OPAMP_SERVER_NAME= flag wins over env (start_supervisor.sh parity) -
(APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t OPAMP_SERVER_NAME=env-name \
  bash ./entrypoint.sh --OPAMP_SERVER_NAME=flag-name)
check "flag beats env for server name" "grep -qF 'ServerName: \"flag-name\"' '$cfg'"

# --- 6. insecure toggle accepted, junk rejected -------------------------------
(APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t OPAMP_ALLOW_INSECURE_CONNECTIONS=true \
  bash ./entrypoint.sh)
check "insecure=true written" "grep -q 'insecure: true' '$cfg'"
out=$( (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t OPAMP_ALLOW_INSECURE_CONNECTIONS=yes \
  bash ./entrypoint.sh) 2>&1 )
rc=$?
check "insecure junk value rejected" "[ $rc -ne 0 ]"

# --- 7. line break in a value would inject YAML: rejected ---------------------
out=$( (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN=$'evil\ninjected: true' \
  bash ./entrypoint.sh) 2>&1 )
rc=$?
check "newline in token rejected" "[ $rc -ne 0 ]"
# CR assigned outside the $() capture: MSYS/Git Bash strips a $'\r' escape
# expanded inside command substitution; a variable reference passes it intact.
cr_token=$'evil\rinjected: true'
out=$( (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN="$cr_token" \
  bash ./entrypoint.sh) 2>&1 )
rc=$?
check "carriage return in token rejected" "[ $rc -ne 0 ]"

# --- 8. the group and k8s attributes: emitted when env set --------------------
(APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t \
  COLLECTOR_GROUP_ID=grp-node-1 POD_NAMESPACE=telflo-collectors POD_NAME=telflo-node-abc NODE_NAME=worker-1 \
  bash ./entrypoint.sh)
check "telflo.collector_group_id attr written" "grep -q 'telflo.collector_group_id: \"grp-node-1\"' '$cfg'"
check "k8s.namespace attr written" "grep -q 'k8s.namespace.name: \"telflo-collectors\"' '$cfg'"
check "k8s.pod attr written" "grep -q 'k8s.pod.name: \"telflo-node-abc\"' '$cfg'"
check "k8s.node attr written" "grep -q 'k8s.node.name: \"worker-1\"' '$cfg'"
check "description block present" "grep -q 'non_identifying_attributes:' '$cfg'"

# --- 9. no Kubernetes env: the description still names the group -------------
(APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t OPAMP_SERVER_NAME=srv \
  bash ./entrypoint.sh)
check "the description always names the group" "grep -q '^    non_identifying_attributes:\$' '$cfg' && reads_back telflo.collector_group_id 0c0c0c0c-0000-4000-8000-00000000000c"
check "no Kubernetes attributes when none is set" "! grep -qE 'k8s\\.|host\\.ip' '$cfg'"

# --- 9b. no COLLECTOR_GROUP_ID, or a blank one: refused before anything is
# written ----------------------------------------------------------------------
# The opamp-server refuses a collector naming no group, so the image refuses
# to start without one: a nonzero exit, the message, no configuration, and
# the supervisor never run.
rm -f "$cfg" "$tmp/supervisor-args.txt"
for unset_or_empty in unset empty; do
  case "$unset_or_empty" in
    unset) out=$( (env -u COLLECTOR_GROUP_ID APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t bash ./entrypoint.sh) 2>&1 ); rc=$? ;;
    empty) out=$( (env COLLECTOR_GROUP_ID= APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t bash ./entrypoint.sh) 2>&1 ); rc=$? ;;
  esac
  check "no group ($unset_or_empty): exits nonzero" "[ $rc -ne 0 ]"
  check "no group ($unset_or_empty): the message" '[ "$out" = "telflo-collector: COLLECTOR_GROUP_ID is required: the id of the collector group it joins, from the fleet'"'"'s install command or Helm values." ]'
  check "no group ($unset_or_empty): no configuration written" "[ ! -e '$cfg' ]"
  check "no group ($unset_or_empty): the supervisor never ran" "[ ! -e '$tmp/supervisor-args.txt' ]"
done
# Blank once trimmed as the opamp-server trims (Go's strings.TrimSpace):
# refused alike, with the same words. A padded id is taken as typed (the
# server trims it).
sp3='   '; tab_sp=$'\t \t'; nbsp=$'\xc2\xa0'; ideo=$'\xe3\x80\x80'; mixed=$' \xc2\xa0\xe2\x80\x83\xe2\x80\xaf\t'
for blank in sp3 tab_sp nbsp ideo mixed; do
  rm -f "$cfg" "$tmp/supervisor-args.txt"
  out=$( (env COLLECTOR_GROUP_ID="${!blank}" APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t bash ./entrypoint.sh) 2>&1 ); rc=$?
  check "blank group ($blank): exits nonzero" "[ $rc -ne 0 ]"
  check "blank group ($blank): the message" '[ "$out" = "telflo-collector: COLLECTOR_GROUP_ID is required: the id of the collector group it joins, from the fleet'"'"'s install command or Helm values." ]'
  check "blank group ($blank): no configuration written" "[ ! -e '$cfg' ]"
  check "blank group ($blank): the supervisor never ran" "[ ! -e '$tmp/supervisor-args.txt' ]"
done
want=' 0c0c0c0c-0000-4000-8000-00000000000c '
render COLLECTOR_GROUP_ID="$want"
check "a padded group id is taken as typed" 'reads_back telflo.collector_group_id "$want"'

# --- 9c. each of the 25 runes Go's TrimSpace removes is blank by itself ------
# (the list in entrypoint.sh's comment): refused with the same words, nothing
# written. Its neighbor U+200B (zero width space, not white space to Go) is
# a value, written as typed, and so is a space rune followed by a byte that
# isn't UTF-8 (Go decodes the byte as U+FFFD: not white space). Every case
# runs under the caller's locale and again under LC_ALL=C.UTF-8 (the image
# has it; a check fails when it is missing), where the check must still
# match bytes. Each run is killed if it is still going after a generous 30
# seconds (the hang guard only: a check stepping through characters can loop
# for ever on that byte), which fails its case.
space_runes=($'\t' $'\n' $'\v' $'\f' $'\r' ' ' $'\xc2\x85' $'\xc2\xa0' $'\xe1\x9a\x80'
  $'\xe2\x80\x80' $'\xe2\x80\x81' $'\xe2\x80\x82' $'\xe2\x80\x83' $'\xe2\x80\x84' $'\xe2\x80\x85'
  $'\xe2\x80\x86' $'\xe2\x80\x87' $'\xe2\x80\x88' $'\xe2\x80\x89' $'\xe2\x80\x8a'
  $'\xe2\x80\xa8' $'\xe2\x80\xa9' $'\xe2\x80\xaf' $'\xe2\x81\x9f' $'\xe3\x80\x80')
check "the 25 runes" '[ "${#space_runes[@]}" -eq 25 ]'
guarded() { # <env assignments...>: runs the entrypoint; sets guarded_rc (124 when hung) and guarded_out
  local pid i
  rm -f "$cfg" "$tmp/supervisor-args.txt"
  (env APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t "$@" bash ./entrypoint.sh) \
    > "$tmp/guarded-out.txt" 2>&1 &
  pid=$!
  for i in $(seq 1 1500); do kill -0 "$pid" 2>/dev/null || break; sleep 0.02; done
  if kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    guarded_rc=124
  else
    wait "$pid"; guarded_rc=$?
  fi
  guarded_out="$(cat "$tmp/guarded-out.txt")"
}
written_as_typed() { # <value>: the configuration names the group exactly so (bytes compared)
  LC_ALL=C grep -qxF "      telflo.collector_group_id: \"$1\"" "$cfg"
}
required_words="telflo-collector: COLLECTOR_GROUP_ID is required: the id of the collector group it joins, from the fleet's install command or Helm values."
utf8_locale=""
locale -a 2>/dev/null | grep -qixE 'c\.utf-?8' && utf8_locale=C.UTF-8
check "the locale C.UTF-8 exists (the locale cases need it)" '[ -n "$utf8_locale" ]'
for lc in ENTRYPOINT_TEST_LOCALE=inherited ${utf8_locale:+LC_ALL=$utf8_locale}; do
  n=0
  for r in "${space_runes[@]}"; do
    n=$((n + 1)); hex=$(printf "%s" "$r" | od -An -tx1 | tr -d " \n")
    guarded "$lc" COLLECTOR_GROUP_ID="$r"
    check "rune $n of 25 ($hex) alone is blank ($lc)" '[ "$guarded_rc" -eq 1 ] && [ "$guarded_out" = "$required_words" ] && [ ! -e "$cfg" ] && [ ! -e "$tmp/supervisor-args.txt" ]'
  done
  guarded "$lc" COLLECTOR_GROUP_ID="${space_runes[*]}"
  check "all 25 runes together are blank ($lc)" '[ "$guarded_rc" -eq 1 ] && [ "$guarded_out" = "$required_words" ] && [ ! -e "$cfg" ]'
  zwsp=$'\xe2\x80\x8b'
  guarded "$lc" COLLECTOR_GROUP_ID="$zwsp"
  check "U+200B alone is a value, written as typed ($lc)" '[ "$guarded_rc" -eq 0 ] && written_as_typed "$zwsp"'
  for after in $'\xe2\x80\x80\xc2' $'\xc2\xa0\xa0' $' \xe3\x80\x80\xe2\x80'; do
    v="$after"; hex=$(printf "%s" "$v" | od -An -tx1 | tr -d " \n")
    guarded "$lc" COLLECTOR_GROUP_ID="$v"
    check "a space rune then a byte that isn't UTF-8 ($hex) is a value, written as typed ($lc)" '[ "$guarded_rc" -eq 0 ] && written_as_typed "$v"'
  done
done

# --- 10. partial attrs: only set keys appear -----------------------------------
(APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t COLLECTOR_GROUP_ID=grp-gw-a \
  bash ./entrypoint.sh)
check "partial: group present" "grep -q 'telflo.collector_group_id: \"grp-gw-a\"' '$cfg'"
check "partial: node absent" "! grep -q 'k8s.node.name' '$cfg'"

# --- 11. newline in COLLECTOR_GROUP_ID rejected -------------------------------
out=$( (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" \
  OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t COLLECTOR_GROUP_ID=$'a\nb' \
  bash ./entrypoint.sh) 2>&1 )
check "newline in group id rejected" "[ $? -ne 0 ]"

# --- 12. every value arrives as typed (YAML double-quoted, `$` doubled) -------
for name in 2024 true 1.10 .5 0x1F 1e3 null '- prod' '#prod' 'prod: east' "it's" \
  '${env:OPAMP_TOKEN}' '${OPAMP_TOKEN}' '$$x' 'a"b\c' '\n' "$(printf 'a\tb')" ' padded '; do
  want="$name"
  render OPAMP_SERVER_NAME="$name"
  check "name '$name' arrives as typed" 'reads_back ServerName "$want"'
done
for group in '#g' 'a: b' "it's" '- g' '00000000-0000-0000-0000-000000000001'; do
  want="$group"
  render COLLECTOR_GROUP_ID="$group"
  check "group id '$group' arrives as typed" 'reads_back telflo.collector_group_id "$want"'
done
# The supervisor copies the attributes, decoded and unescaped, into YAML
# double quotes in the collector's merged configuration
# (service.telemetry.resource), where the collector expands `$` again:
# `"`, `\` and `$` are refused there.
for group in 'a"b' 'a\b' '"; injected: "x' '${env:OPAMP_TOKEN}' '$${env:HOME}' 'a$b' '$'; do
  g="$group"
  check "group id '$group' refused" 'refused COLLECTOR_GROUP_ID="$g"'
done
out=$( (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t POD_NAME='p"1' bash ./entrypoint.sh) 2>&1 )
check "a quote in an attribute names the variable" 'printf "%s" "$out" | grep -q "POD_NAME must not contain"'
check "a backslash in host ip refused" 'refused HOST_IP="10.0.0.1\\"'
check "a quote in node name refused" 'refused NODE_NAME="n\"1"'
check "a backslash in pod namespace refused" 'refused POD_NAMESPACE="ns\\1"'
check "a \$ in node name refused" 'refused NODE_NAME="n\$1"'
check "a \$ in pod namespace refused" 'refused POD_NAMESPACE="\${env:X}"'
check "a \$ in pod name refused" 'refused POD_NAME="\$\${env:HOME}"'
check "a \$ in host ip refused" 'refused HOST_IP="\$HOST"'
out=$( (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t COLLECTOR_GROUP_ID='${env:OPAMP_TOKEN}' bash ./entrypoint.sh) 2>&1 )
check "a \$ in an attribute names the variable" 'printf "%s" "$out" | grep -qF "COLLECTOR_GROUP_ID must not contain \", \\ or \$"'
check "a quote in the name accepted (a header, not an attribute)" '! refused OPAMP_SERVER_NAME="a\"b\\c"'
want='Bearer t$ok"\x'
render OPAMP_TOKEN='t$ok"\x'
check "a token with \$, \" and \\ arrives as typed" 'reads_back Authorization "$want"'
want='https://opamp.example/a$b?c="d"'
render OPAMP_ENDPOINT="$want"
check "an endpoint with \$ and \" arrives as typed" 'reads_back endpoint "$want"'
render POD_NAME='p#1' NODE_NAME='n: 1' POD_NAMESPACE='- ns' HOST_IP='10.0.0.1'
check "k8s attributes arrive as typed" 'reads_back k8s.pod.name "p#1" && reads_back k8s.node.name "n: 1" && reads_back k8s.namespace.name "- ns" && reads_back host.ip 10.0.0.1'

# The name's `$` is never expanded: written doubled, read back literal, and
# the value it names (the token) appears nowhere but the Authorization line.
render OPAMP_SERVER_NAME='${env:OPAMP_TOKEN} $HOME' OPAMP_TOKEN=canary-token-91d3
check "the name's \${env:...} is written doubled" "grep -qF 'ServerName: \"\$\${env:OPAMP_TOKEN} \$\$HOME\"' '$cfg'"
check "the name's \${env:...} reads back literal" 'reads_back ServerName "\${env:OPAMP_TOKEN} \$HOME"'
check "the token appears only on the Authorization line" "[ \"\$(grep -c canary-token-91d3 '$cfg')\" = 1 ] && grep -q '^    Authorization: \"Bearer canary-token-91d3\"\$' '$cfg'"

# The agent's paths are quoted too; APP_DIR must be a plain absolute path.
render
check "executable: quoted, reads back" 'reads_back executable "$tmp/otelcol-contrib"'
check "storage directory: quoted, reads back" 'reads_back directory "$tmp/opamp"'
item="$(grep -m 1 -E '^    - ' "$cfg")"
check "config_files' item: quoted, reads back" '[ "$(decode_scalar "${item#    - }")" = "$tmp/otelcol-config.yaml" ]'
for bad in "$tmp/a b" "$tmp/a\$b" "$tmp/a#b" 'relative/app' "$tmp/a\"b"; do
  d="$bad"
  out=$( (APP_DIR="$d" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t bash ./entrypoint.sh) 2>&1 ); rc=$?
  check "APP_DIR '$bad' refused" '[ $rc -ne 0 ] && printf "%s" "$out" | grep -q "APP_DIR must be a plain absolute path"'
done

# --- 13. an empty name: no ServerName header (the server names it) -----------
render OPAMP_SERVER_NAME=
check "empty name: no ServerName line" "[ -f '$cfg' ] && ! grep -q 'ServerName' '$cfg'"
render
check "no name: no ServerName line" "[ -f '$cfg' ] && ! grep -q 'ServerName' '$cfg'"

# --- 14. the configuration (it holds the token) is the owner's only: 0600 ----
rm -f "$cfg"
(umask 022; APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t bash ./entrypoint.sh) >/dev/null 2>&1
check "supervisor-config.yaml is mode 0600" "[ \"\$(ls -ln '$cfg' | cut -c1-10)\" = '-rw-------' ]"

# --- 15. line breaks and control characters refused in every value -----------
nl=$'a\nb'; nel=$'a\xc2\x85b'; ls_=$'a\xe2\x80\xa8b'; ps=$'a\xe2\x80\xa9b'; esc=$'a\x1bb'; del=$'a\x7fb'
c1lo=$'a\xc2\x80b'; c1hi=$'a\xc2\x9fb'; fffe=$'a\xef\xbf\xbeb'; ffff=$'a\xef\xbf\xbfb'
nbsp=$'a\xc2\xa0b'; fffd=$'a\xef\xbf\xbdb'
check "U+0080 (C1) in name refused" 'refused OPAMP_SERVER_NAME="$c1lo"'
check "U+009F (C1) in token refused" 'refused OPAMP_TOKEN="$c1hi"'
check "U+FFFE in name refused" 'refused OPAMP_SERVER_NAME="$fffe"'
check "U+FFFF in group id refused" 'refused COLLECTOR_GROUP_ID="$ffff"'
check "U+00A0 (no-break space) in name accepted" '! refused OPAMP_SERVER_NAME="$nbsp"'
check "U+FFFD in name accepted" '! refused OPAMP_SERVER_NAME="$fffd"'
check "newline in name refused" 'refused OPAMP_SERVER_NAME="$nl"'
check "newline in the --OPAMP_SERVER_NAME= flag refused" '! (APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t bash ./entrypoint.sh "--OPAMP_SERVER_NAME=$nl") >/dev/null 2>&1'
check "U+2028 in name refused" 'refused OPAMP_SERVER_NAME="$ls_"'
check "U+2029 in name refused" 'refused OPAMP_SERVER_NAME="$ps"'
check "U+0085 in group id refused" 'refused COLLECTOR_GROUP_ID="$nel"'
check "U+2028 in endpoint refused" 'refused OPAMP_ENDPOINT="https://x/$ls_"'
check "ESC in token refused" 'refused OPAMP_TOKEN="$esc"'
check "DEL in pod name refused" 'refused POD_NAME="$del"'
check "newline in the insecure flag refused" 'refused OPAMP_ALLOW_INSECURE_CONNECTIONS=$'"'"'true\n'"'"
check "newline in host ip refused" 'refused HOST_IP="$nl"'
check "a tab in the name accepted" '! refused OPAMP_SERVER_NAME="$(printf "a\tb")"'
check "non-ASCII letters in the name accepted" '! refused OPAMP_SERVER_NAME="café"'

# --- 16. the collector never holds the bearer: the OPAMP_* variables and
# COLLECTOR_GROUP_ID are gone from the supervisor's environment ---------------
rm -f "$tmp/supervisor-env.txt"
(APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://endpoint-canary \
  OPAMP_TOKEN=token-canary-91d3 OPAMP_SERVER_NAME=name-canary OPAMP_ALLOW_INSECURE_CONNECTIONS=true \
  COLLECTOR_GROUP_ID=group-canary POD_NAME=pod-1 bash ./entrypoint.sh) >/dev/null 2>&1
env_file="$tmp/supervisor-env.txt"
check "the supervisor ran (its environment recorded)" "[ -s '$env_file' ]"
check "no OPAMP_TOKEN in the supervisor's environment" "! grep -q '^OPAMP_TOKEN=' '$env_file'"
check "the token's value nowhere in the supervisor's environment" "! grep -q 'token-canary-91d3' '$env_file'"
check "no OPAMP_ENDPOINT, OPAMP_SERVER_NAME or OPAMP_ALLOW_INSECURE_CONNECTIONS" "! grep -qE '^OPAMP_(ENDPOINT|SERVER_NAME|ALLOW_INSECURE_CONNECTIONS)=' '$env_file'"
check "no COLLECTOR_GROUP_ID" "! grep -q '^COLLECTOR_GROUP_ID=' '$env_file'"
check "the Kubernetes variables kept" "grep -q '^POD_NAME=pod-1$' '$env_file'"
check "the token still in the supervisor's configuration" "grep -qF 'Authorization: \"Bearer token-canary-91d3\"' '$cfg'"

# --- 17. the host's name: the attributes' rule ---------------------------------
for h in '${env:OPAMP_TOKEN}' 'a"b' 'a\b' 'a$b' "$(printf 'a\033b')" "$(printf 'a\302\205b')"; do
  printf '%s\n' "$h" > "$tmp/hostname-bad"
  check "hostname '$h' refused" '! (HOSTNAME_FILE="$tmp/hostname-bad" APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t bash ./entrypoint.sh) >/dev/null 2>&1'
done
printf '%s\n' '${env:OPAMP_TOKEN}' > "$tmp/hostname-bad"
out=$( (HOSTNAME_FILE="$tmp/hostname-bad" APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=token-canary-91d3 bash ./entrypoint.sh) 2>&1 )
check "the hostname refusal names the hostname" 'printf "%s" "$out" | grep -q "hostname must not contain"'
check "the hostname refusal echoes neither the hostname nor the token" '! printf "%s" "$out" | grep -qE "env:OPAMP_TOKEN|token-canary-91d3"'
printf 'web-1.example\n' > "$tmp/hostname-ok"
check "a plain hostname accepted" '(HOSTNAME_FILE="$tmp/hostname-ok" APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t bash ./entrypoint.sh) >/dev/null 2>&1'

# A HOSTNAME_FILE that isn't a regular file is refused, never read: `cat` on
# a FIFO waits for a writer. The run is killed if it is still going after a
# generous 30 seconds (the hang guard only), which fails the check.
mkfifo "$tmp/hostname-fifo"
(HOSTNAME_FILE="$tmp/hostname-fifo" APP_DIR="$tmp" SUPERVISOR_BIN="$tmp/supervisor" OPAMP_ENDPOINT=https://x OPAMP_TOKEN=t \
  bash ./entrypoint.sh) > "$tmp/fifo-out.txt" 2>&1 &
fifo_pid=$!
for _ in $(seq 1 300); do kill -0 "$fifo_pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$fifo_pid" 2>/dev/null; then
  pkill -P "$fifo_pid" 2>/dev/null; kill "$fifo_pid" 2>/dev/null
  fifo_rc=hung
else
  wait "$fifo_pid"; fifo_rc=$?
fi
check "a FIFO as HOSTNAME_FILE refused without hanging" '[ "$fifo_rc" != hung ] && [ "$fifo_rc" -ne 0 ] && grep -q "HOSTNAME_FILE must be a regular file" "$tmp/fifo-out.txt"'

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILURE(S)"; exit 1; fi
