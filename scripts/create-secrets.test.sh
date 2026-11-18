#!/bin/bash
# Tests for scripts/create-secrets.sh (D33-1 spec decision 33, Preflight
# rulings 4 and 17). No cluster: `kubectl` is a fake first on PATH that
# records each call's argv (one line per call) and the apply's standard input,
# answers `create secret … --dry-run=client -o yaml` with the Secret's YAML
# built from the --from-file files (recording the folder's and files' modes
# while they exist), and can be told to fail (FAKE_KUBECTL_FAIL=create or
# apply: it then writes the values it was handed to its stderr, as a failing
# apply can echo its patch; namespace: kubectl's namespace-not-found line;
# FAKE_KUBECTL_FAIL_AT=<name>: only that Secret's apply fails), or told to be
# slow (FAKE_KUBECTL_SLOW=1: the create waits for a release file, so a signal
# can reach the script mid-run).
# Every other command the script runs (base64, openssl, stat, mktemp, chmod,
# mkdir, rm, tr, dirname, cat, grep) is a wrapper first on PATH recording its
# argv before running the real one, so the canaries see every argv.
#
# The canaries are boolean: every value the run handles (the generated ones,
# the optional ones, the registry token and the login's base64), raw and in
# base64, is put in a pattern file and searched for with `grep -qF -f` in the
# recorded argvs and in the script's stdout and stderr. Nothing prints a value.
# Run:  bash scripts/create-secrets.test.sh
# bash 3.2 compatible (macOS's /bin/bash).
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
script="$root/scripts/create-secrets.sh"
shell="${BASH:-bash}"

failures=0
check() { # <name> <shell-expr that must succeed>
  if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi
}

tmp="$(mktemp -d "${TMPDIR:-/tmp}/create-secrets-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"; logs="$tmp/logs"; scratch="$tmp/scratch"; files="$tmp/files"
mkdir -p "$bin" "$logs" "$scratch" "$files"
chmod 700 "$files"

# The wrappers: argv recorded, then the real command.
for cmd in base64 openssl stat mktemp chmod mkdir rm tr dirname cat grep; do
  real="$(command -v "$cmd")" || { echo "FAIL - $cmd is not on PATH"; exit 1; }
  printf '#!/bin/bash\nline="$(printf "%%s " %s; printf "%%q " "$@")"\nprintf "%%s\\n" "$line" >>"%s/argv.log"\nexec "%s" "$@"\n' \
    "$cmd" "$logs" "$real" >"$bin/$cmd"
  chmod +x "$bin/$cmd"
done
real_base64="$(command -v base64)"; real_stat="$(command -v stat)"
printf '#!/bin/bash\nlog="%s"\nreal_base64="%s"\nreal_stat="%s"\n' "$logs" "$real_base64" "$real_stat" >"$bin/kubectl"
cat >>"$bin/kubectl" <<'EOF'
# The test's fake kubectl: argv recorded (one line per call), the create
# answered with the Secret's YAML, the apply's stdin recorded.
# One write per line: the two kubectl of a pipe run at once.
line="$(printf '%q ' "$@")"
printf 'kubectl %s\n' "$line" >>"$log/argv.log"
printf '%s\n' "$line" >>"$log/kubectl.log"
mode() { "$real_stat" -c '%a' "$1" 2>/dev/null || "$real_stat" -f '%Lp' "$1" 2>/dev/null; }
sub=""; skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in --context | --kubeconfig | -n) skip=1 ;; *) sub="$a"; break ;; esac
done
case "$sub" in
  create)
    name=""; type="Opaque"; data=""; prev=""
    for a in "$@"; do
      case "$a" in
        --type=*) type="${a#--type=}" ;;
        --from-file=*)
          spec="${a#--from-file=}"; key="${spec%%=*}"; path="${spec#*=}"
          printf '%s %s %s %s\n' "$key" "$(mode "$(dirname "$path")")" "$(mode "$path")" "$path" >>"$log/modes.log"
          if [ "${FAKE_KUBECTL_FAIL:-}" = create ]; then
            printf 'error: echoing %s: ' "$key" >&2; cat "$path" >&2; echo >&2
          fi
          data="$data  $key: $("$real_base64" <"$path" | tr -d '\n')"$'\n' ;;
      esac
      [ "$prev" = generic ] && name="$a"
      prev="$a"
    done
    if [ "${FAKE_KUBECTL_FAIL:-}" = create ]; then exit 1; fi
    if [ -n "${FAKE_KUBECTL_SLOW:-}" ]; then
      : >"$log/started"
      i=0; while [ ! -e "$log/release" ] && [ "$i" -lt 1200 ]; do sleep 0.1; i=$((i + 1)); done
    fi
    printf 'apiVersion: v1\ndata:\n%skind: Secret\nmetadata:\n  name: %s\ntype: %s\n' "$data" "$name" "$type"
    ;;
  apply)
    n=$(($(ls "$log" | grep -c '^stdin\.') + 1))
    cat >"$log/stdin.$n"
    if [ -n "${FAKE_KUBECTL_FAIL_AT:-}" ] && grep -qx "  name: $FAKE_KUBECTL_FAIL_AT" "$log/stdin.$n"; then
      echo "error: the apply failed" >&2; exit 1
    fi
    case "${FAKE_KUBECTL_FAIL:-}" in
      apply)
        echo "error: the patch was:" >&2; cat "$log/stdin.$n" >&2
        sed -n 's/^  [^:]*: //p' "$log/stdin.$n" | while IFS= read -r b; do printf '%s' "$b" | "$real_base64" -d >&2; echo >&2; done
        exit 1 ;;
      namespace) echo 'Error from server (NotFound): namespaces "telflo" not found' >&2; exit 1 ;;
    esac
    echo "secret/$(sed -n 's/^  name: //p' "$log/stdin.$n") serverside-applied"
    ;;
  *) echo "UNEXPECTED kubectl $*" >>"$log/unexpected.log"; exit 97 ;;
esac
EOF
chmod +x "$bin/kubectl"
# The script (only) runs with the fake and the wrappers first on PATH; the test's own commands aren't recorded.
script_path="$bin:$PATH"
if [ "$(PATH="$script_path" command -v kubectl)" != "$bin/kubectl" ]; then echo "FAIL - the fake kubectl is not first on PATH"; exit 1; fi

clear_logs() { rm -f "$logs"/*; }
# run <args...>: sets rc, out (stdout and stderr), printed (stdout alone); TMPDIR is $scratch.
run() {
  clear_logs
  printed="$(env PATH="$script_path" TMPDIR="$scratch" "$shell" "$script" "$@" 2>"$tmp/stderr")"
  rc=$?
  out="$(printf '%s\n' "$printed"; cat "$tmp/stderr")"
  printf '%s\n' "$out" >"$tmp/out"
}
has() { printf '%s\n' "$out" | grep -qF -- "$1"; }
no_kubectl() { [ ! -s "$logs/kubectl.log" ]; }
kubectl_calls() { if [ -f "$logs/kubectl.log" ]; then grep -c '' "$logs/kubectl.log"; else echo 0; fi; }
scratch_empty() { [ -z "$(ls -A "$scratch")" ]; }

# The canaries: every value of a secrets file (and extra values given), raw and in base64, one per line.
canaries="$tmp/canaries"
add_canary() { # <value>: never on argv here either (printf is a builtin; base64 reads a pipe)
  printf '%s\n' "$1" >>"$canaries"
  printf '%s' "$1" | base64 | tr -d '\n' >>"$canaries"; echo >>"$canaries"
}
add_file_canaries() { # <secrets file>: each key=value line's value, but the ghcr-pull username and token-file path
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '#'* | '['*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"; value="${line#*=}"
    case "$key" in username | token-file) continue ;; esac
    [ -n "$value" ] && add_canary "$value"
  done <"$1"
}
# leaked <file>: true when the file holds any canary (a missing file holds none).
leaked() { [ -f "$1" ] && grep -qF -f "$canaries" "$1"; }
no_leak() { ! leaked "$logs/argv.log" && ! leaked "$tmp/out"; }

# value_to <secrets file> <section> <key> <out file>: the value, into a file (no printing).
value_to() {
  local line section="" value=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "[$2]") section="$2"; continue ;; '['*) section=""; continue ;; esac
    if [ "$section" = "$2" ]; then case "$line" in "$3="*) value="${line#*=}" ;; esac; fi
  done <"$1"
  printf '%s' "$value" >"$4"
}
# data_to <stdin file> <key> <out file>: the YAML's decoded data value, into a file.
data_to() { sed -n "s/^  $2: //p" "$1" | head -n 1 | base64 -d >"$3" 2>/dev/null; }
stdin_of() { grep -l "^  name: $1\$" "$logs"/stdin.* 2>/dev/null | head -n 1; }
# same_value <secrets file> <section> <key>: the Secret applied holds exactly the file's value.
same_value() {
  local s; s="$(stdin_of "$2")"; [ -n "$s" ] || return 1
  value_to "$1" "$2" "$3" "$tmp/want" && data_to "$s" "$3" "$tmp/got" && [ -s "$tmp/want" ] && cmp -s "$tmp/want" "$tmp/got"
}
rm_value_files() { rm -f "$tmp/want" "$tmp/got"; }

# --- 1. usage refusals (exit 2, kubectl never run) ------------------------------------------------
: >"$canaries"
run "$files/none.secrets.env"
check "a missing --context refused (exit 2), kubectl never run" "[ $rc -eq 2 ] && has '--context is required' && no_kubectl"
run --context "" "$files/none.secrets.env"
check "an empty --context refused (exit 2), kubectl never run" "[ $rc -eq 2 ] && has '--context is empty' && no_kubectl"
run --context= "$files/none.secrets.env"
check "an empty --context= refused (exit 2), kubectl never run" "[ $rc -eq 2 ] && has '--context is empty' && no_kubectl"
run --context
check "--context with no value refused (exit 2)" "[ $rc -eq 2 ] && has '--context needs a value' && no_kubectl"
run --context dev-ctx --namespace 'Bad_NS' "$files/none.secrets.env"
check "a namespace that isn't a namespace's name refused (exit 2)" "[ $rc -eq 2 ] && has '--namespace must be' && no_kubectl"
run --context dev-ctx --kubeconfig "" "$files/none.secrets.env"
check "an empty --kubeconfig refused (exit 2)" "[ $rc -eq 2 ] && has '--kubeconfig is empty' && no_kubectl"
run --context dev-ctx
check "no file refused (exit 2)" "[ $rc -eq 2 ] && has 'the secrets file is required' && no_kubectl"
run --context dev-ctx --bogus x
check "an unknown argument refused (exit 2)" "[ $rc -eq 2 ] && has 'unknown argument: --bogus' && no_kubectl"
run --context --namespace telflo "$files/none.secrets.env"
check "--context taking the next option as its value refused (exit 2)" "[ $rc -eq 2 ] && has \"--context's value starts with --\" && no_kubectl"
run --context=--namespace "$files/none.secrets.env"
check "--context=--… refused (exit 2)" "[ $rc -eq 2 ] && has \"--context's value starts with --\" && no_kubectl"
run --context dev-ctx --namespace --kubeconfig x "$files/none.secrets.env"
check "--namespace taking the next option as its value refused (exit 2)" "[ $rc -eq 2 ] && has \"--namespace's value starts with --\" && no_kubectl"
run --context dev-ctx --kubeconfig --namespace telflo "$files/none.secrets.env"
check "--kubeconfig taking the next option as its value refused (exit 2)" "[ $rc -eq 2 ] && has \"--kubeconfig's value starts with --\" && no_kubectl"
run --context dev-ctx --namespace "a$(printf '%063d' 0)" "$files/none.secrets.env"
check "a 64-character namespace refused (exit 2)" "[ $rc -eq 2 ] && has '--namespace must be' && no_kubectl"
run --context dev-ctx -n -telflo "$files/none.secrets.env"
check "a namespace starting with - refused (exit 2)" "[ $rc -eq 2 ] && has '--namespace must be' && no_kubectl"
run --init "$files/x.secrets.env" --context dev-ctx
check "--init with --context refused (exit 2), no file written" "[ $rc -eq 2 ] && has '--init takes only its file' && [ ! -e '$files/x.secrets.env' ]"
run --init "$files/dev.env"
check "--init refuses a name not ending in .secrets.env (exit 2), no file written" \
  "[ $rc -eq 2 ] && has 'name the file <name>.secrets.env' && [ ! -e '$files/dev.env' ]"

# --- 2. --init ---------------------------------------------------------------------------------------
secrets="$files/dev.secrets.env"
run --init "$secrets"
add_file_canaries "$secrets"
check "--init writes the file (exit 0), mode 0600" \
  "[ $rc -eq 0 ] && [ -f '$secrets' ] && [ \"\$(stat -c '%a' '$secrets' 2>/dev/null || stat -f '%Lp' '$secrets')\" = 600 ]"
check "--init prints the note to back the encryption key up outside the cluster" \
  "has \"back up the opamp-server's encryption-key\" && has 'outside the cluster'"
check "--init never runs kubectl" "no_kubectl"
check "--init: no value in any argv, stdout or stderr (canaries)" "[ -s '$canaries' ] && no_leak"
# each generated key, its shape (read here into a file, never printed)
gen_shape() { # <section> <key> <regex>
  value_to "$secrets" "$1" "$2" "$tmp/want"
  [ "$(grep -c '' "$tmp/want")" -le 1 ] && grep -qE "$3" "$tmp/want"
}
hex='^[0-9a-f]{64}$'
for k in postgres-password owner-password api-password; do
  check "--init: [telflo-postgres] $k is hex of 32 bytes" "gen_shape telflo-postgres $k '$hex'"
done
for k in owner-password runtime-password management-secret encryption-key; do
  check "--init: [telflo-opamp-server] $k is hex of 32 bytes" "gen_shape telflo-opamp-server $k '$hex'"
done
for k in access-token-secret library-link-signing-key; do
  check "--init: [telflo-api] $k is hex of 32 bytes" "gen_shape telflo-api $k '$hex'"
done
for k in otelcol-validator-secret otelcol-testing-secret ottl-evaluator-secret; do
  check "--init: [telflo-internal-services] $k is hex of 32 bytes" "gen_shape telflo-internal-services $k '$hex'"
done
check "--init: [telflo-api] quick-deploy-encryption-key is base64 of exactly 32 bytes" \
  "gen_shape telflo-api quick-deploy-encryption-key '^[A-Za-z0-9+/]{43}=\$' && [ \"\$(base64 -d <'$tmp/want' | wc -c | tr -d ' ')\" = 32 ]"
rm_value_files
check "--init: exactly the 13 generated keys, no other key line" \
  "[ \$(grep -cE '^[a-z0-9.-]+=.+' '$secrets') -eq 13 ]"
check "--init: the four required sections, uncommented" \
  "grep -qx '\[telflo-postgres\]' '$secrets' && grep -qx '\[telflo-opamp-server\]' '$secrets' && grep -qx '\[telflo-api\]' '$secrets' && grep -qx '\[telflo-internal-services\]' '$secrets'"
check "--init: the optional Secrets and keys as commented placeholders" \
  "grep -qx '# \[telflo-oidc-google\]' '$secrets' && grep -qx '# client-id=' '$secrets' && grep -qx '# client-secret=' '$secrets' && grep -qx '# \[telflo-mail\]' '$secrets' && grep -qx '# sendgrid-api-key=' '$secrets' && grep -qx '# smtp-username=' '$secrets' && grep -qx '# smtp-password=' '$secrets' && grep -qx '# \[ghcr-pull\]' '$secrets' && grep -qx '# username=' '$secrets' && grep -qx '# token-file=' '$secrets' && grep -qx '# management-secrets-previous=' '$secrets' && grep -qx '# encryption-keys-previous=' '$secrets' && grep -qx '# quick-deploy-previous-encryption-keys=' '$secrets' && grep -qx '# library-link-signing-keys-previous=' '$secrets'"
check "--init: every generated value distinct" \
  "[ \$(sed -n 's/^[a-z0-9.-]*=\(..*\)\$/\1/p' '$secrets' | sort -u | grep -c '') -eq 13 ]"
cp "$secrets" "$tmp/secrets.before"
run --init "$secrets"
check "--init refuses to overwrite (exit 1), the file unchanged" \
  "[ $rc -eq 1 ] && has 'exists already' && cmp -s '$secrets' '$tmp/secrets.before'"
ln -s "$files/nowhere.secrets.env" "$files/link.secrets.env"
run --init "$files/link.secrets.env"
check "--init refuses a dangling symlink at the path (exit 1), nothing written through it" \
  "[ $rc -eq 1 ] && has 'exists already' && [ ! -e '$files/nowhere.secrets.env' ]"
run --init "$files/second.secrets.env"
add_file_canaries "$files/second.secrets.env"
check "a second --init makes other values (no value repeated across the two files)" \
  "[ $rc -eq 0 ] && ! grep -qxF -f <(sed -n 's/^[a-z0-9.-]*=\(..*\)\$/\1/p' '$secrets') <(sed -n 's/^[a-z0-9.-]*=\(..*\)\$/\1/p' '$files/second.secrets.env')"

# --- 3. a run: every Secret, the exact server-side apply ----------------------------------------------
# The optional Secrets and keys filled in: values made here, at run time.
token="ghp_$(openssl rand -hex 18)"
printf '%s\n' "$token" >"$files/ghcr-token"; chmod 600 "$files/ghcr-token"
add_canary "$token"
add_canary "$(printf '%s:%s' telflo-test "$token" | base64 | tr -d '\n')"
full="$files/full.secrets.env"
{
  sed -e 's/^# encryption-keys-previous=$/encryption-keys-previous='"$(openssl rand -hex 32)"'/' "$secrets"
  printf '\n[telflo-oidc-google]\nclient-id=%s\nclient-secret=%s\n' "$(openssl rand -hex 12)" "$(openssl rand -hex 24)"
  printf '\n[telflo-mail]\nsendgrid-api-key=SG.%s\nsmtp-username=relay-%s\nsmtp-password=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 6)" "$(openssl rand -hex 24)"
  printf '\n[ghcr-pull]\nusername=telflo-test\ntoken-file=ghcr-token\n'
} >"$full"
chmod 600 "$full"
add_file_canaries "$full"
canary_count=$(grep -c '' "$canaries")

run --context dev-ctx --namespace telflo "$full"
cp "$logs/kubectl.log" "$tmp/first-run.log" 2>/dev/null || true
check "a run applies the seven Secrets (exit 0), two kubectl calls each" "[ $rc -eq 0 ] && [ \$(kubectl_calls) -eq 14 ] && has 'done: 7 Secret(s) applied'"
check "every kubectl call carries --context dev-ctx -n telflo first" \
  "[ \$(grep -c '^--context dev-ctx -n telflo ' '$logs/kubectl.log') -eq 14 ]"
check "the apply's arguments are exactly: apply --server-side --field-manager=telflo-create-secrets --force-conflicts -f -" \
  "[ \$(grep -cxF -- '--context dev-ctx -n telflo apply --server-side --field-manager=telflo-create-secrets --force-conflicts -f - ' '$logs/kubectl.log') -eq 7 ]"
w='/[A-Za-z0-9._/-]+/create-secrets\.[A-Za-z0-9]+'
check "telflo-postgres: create secret generic, --from-file per key from the temporary folder, --dry-run=client -o yaml" \
  "grep -qxE -- '--context dev-ctx -n telflo create secret generic telflo-postgres --from-file=postgres-password=$w/store/telflo-postgres/postgres-password --from-file=owner-password=$w/store/telflo-postgres/owner-password --from-file=api-password=$w/store/telflo-postgres/api-password --dry-run=client -o yaml ' '$logs/kubectl.log'"
check "telflo-opamp-server: its four keys and the previous key given, not the one left commented" \
  "grep -qxE -- '--context dev-ctx -n telflo create secret generic telflo-opamp-server --from-file=owner-password=$w/store/telflo-opamp-server/owner-password --from-file=runtime-password=$w/store/telflo-opamp-server/runtime-password --from-file=management-secret=$w/store/telflo-opamp-server/management-secret --from-file=encryption-key=$w/store/telflo-opamp-server/encryption-key --from-file=encryption-keys-previous=$w/store/telflo-opamp-server/encryption-keys-previous --dry-run=client -o yaml ' '$logs/kubectl.log'"
check "telflo-api, telflo-internal-services, telflo-oidc-google, telflo-mail: their keys" \
  "grep -qxE -- '--context dev-ctx -n telflo create secret generic telflo-api --from-file=access-token-secret=[^ ]+ --from-file=quick-deploy-encryption-key=[^ ]+ --from-file=library-link-signing-key=[^ ]+ --dry-run=client -o yaml ' '$logs/kubectl.log' && grep -qxE -- '--context dev-ctx -n telflo create secret generic telflo-internal-services --from-file=otelcol-validator-secret=[^ ]+ --from-file=otelcol-testing-secret=[^ ]+ --from-file=ottl-evaluator-secret=[^ ]+ --dry-run=client -o yaml ' '$logs/kubectl.log' && grep -qxE -- '--context dev-ctx -n telflo create secret generic telflo-oidc-google --from-file=client-id=[^ ]+ --from-file=client-secret=[^ ]+ --dry-run=client -o yaml ' '$logs/kubectl.log' && grep -qxE -- '--context dev-ctx -n telflo create secret generic telflo-mail --from-file=sendgrid-api-key=[^ ]+ --from-file=smtp-username=[^ ]+ --from-file=smtp-password=[^ ]+ --dry-run=client -o yaml ' '$logs/kubectl.log'"
check "ghcr-pull: --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson=<the folder's file>" \
  "grep -qxE -- '--context dev-ctx -n telflo create secret generic ghcr-pull --type=kubernetes\.io/dockerconfigjson --from-file=\.dockerconfigjson=$w/registry/\.dockerconfigjson --dry-run=client -o yaml ' '$logs/kubectl.log'"
check "seven creates and seven applies, nothing else (the two of a pipe log in either order)" \
  "[ \$(awk '\$5 == \"create\"' '$logs/kubectl.log' | grep -c '') -eq 7 ] && [ \$(awk '\$5 == \"apply\"' '$logs/kubectl.log' | grep -c '') -eq 7 ]"
check "the values applied are exactly the file's (each key of each Secret, compared as files)" \
  "same_value '$full' telflo-postgres postgres-password && same_value '$full' telflo-postgres owner-password && same_value '$full' telflo-postgres api-password && same_value '$full' telflo-opamp-server owner-password && same_value '$full' telflo-opamp-server runtime-password && same_value '$full' telflo-opamp-server management-secret && same_value '$full' telflo-opamp-server encryption-key && same_value '$full' telflo-opamp-server encryption-keys-previous && same_value '$full' telflo-api access-token-secret && same_value '$full' telflo-api quick-deploy-encryption-key && same_value '$full' telflo-api library-link-signing-key && same_value '$full' telflo-internal-services otelcol-validator-secret && same_value '$full' telflo-internal-services otelcol-testing-secret && same_value '$full' telflo-internal-services ottl-evaluator-secret && same_value '$full' telflo-oidc-google client-id && same_value '$full' telflo-oidc-google client-secret && same_value '$full' telflo-mail sendgrid-api-key && same_value '$full' telflo-mail smtp-username && same_value '$full' telflo-mail smtp-password"
rm_value_files
ghcr_stdin="$(stdin_of ghcr-pull)"
check "ghcr-pull's YAML: type kubernetes.io/dockerconfigjson, the one key .dockerconfigjson" \
  "[ -n '$ghcr_stdin' ] && grep -qx 'type: kubernetes.io/dockerconfigjson' '$ghcr_stdin' && [ \$(grep -c '^  [^ ]*: ' '$ghcr_stdin') -eq 2 ] && grep -q '^  \.dockerconfigjson: ' '$ghcr_stdin'"
data_to "$ghcr_stdin" .dockerconfigjson "$tmp/dockerconfig.json"
check "ghcr-pull's .dockerconfigjson: auths ghcr.io only, the username, auth = base64(username:token from the file), no password key" \
  "python3 -I - '$tmp/dockerconfig.json' '$files/ghcr-token' >/dev/null 2>&1 <<'PY'
import base64, json, sys
config = json.load(open(sys.argv[1]))
token = open(sys.argv[2]).read().rstrip('\n')
entry = config['auths']['ghcr.io']
assert list(config) == ['auths'] and list(config['auths']) == ['ghcr.io']
assert sorted(entry) == ['auth', 'username'] and entry['username'] == 'telflo-test'
assert base64.b64decode(entry['auth']).decode() == 'telflo-test:' + token
PY"
rm -f "$tmp/dockerconfig.json"
check "each key's file was in a 0700 folder, mode 0600, while kubectl read it" \
  "[ -s '$logs/modes.log' ] && [ \$(grep -c '' '$logs/modes.log') -eq 20 ] && ! awk '\$2 != \"700\" || \$3 != \"600\"' '$logs/modes.log' | grep -q ."
check "the temporary folder is removed afterwards (TMPDIR empty, no key file left)" \
  "scratch_empty && ! awk '{ print \$4 }' '$logs/modes.log' | while read -r p; do [ -e \"\$p\" ] && echo left; done | grep -q left"
check "the canaries were armed (every value, raw and base64)" "[ $canary_count -ge 40 ]"
check "no value (raw or base64) in any recorded argv (kubectl and every wrapped command)" "[ -s '$logs/argv.log' ] && ! leaked '$logs/argv.log'"
check "no value (raw or base64) in the script's stdout or stderr" "! leaked '$tmp/out'"
check "stdout is empty (notes go to stderr), and kubectl's output isn't relayed" "[ -z \"\$printed\" ] && ! has 'serverside-applied'"

clear_logs
out="$(env PATH="$script_path" TMPDIR="$scratch" "$shell" -x "$script" --context dev-ctx -n telflo "$full" 2>&1)"; rc=$?
printf '%s\n' "$out" >"$tmp/out"
check "run under bash -x: applied, and no value traced (the script turns tracing off)" "[ $rc -eq 0 ] && no_leak && scratch_empty"

# --- 4. a re-run just applies again --------------------------------------------------------------------
run --context dev-ctx --namespace telflo "$full"
check "a re-run applies the same Secrets again (exit 0, the same 14 calls but the folder's name)" \
  "[ $rc -eq 0 ] && [ \"\$(sed -E 's#create-secrets\.[A-Za-z0-9]+#X#g' '$logs/kubectl.log' | sort)\" = \"\$(sed -E 's#create-secrets\.[A-Za-z0-9]+#X#g' '$tmp/first-run.log' | sort)\" ] && no_leak && scratch_empty"

# --- 5. without a namespace; with a kubeconfig ---------------------------------------------------------
run --context dev-ctx "$full"
check "no --namespace: no -n, the context's own namespace" \
  "[ $rc -eq 0 ] && [ \$(grep -c '^--context dev-ctx create secret generic ' '$logs/kubectl.log') -eq 7 ] && [ \$(grep -cxF -- '--context dev-ctx apply --server-side --field-manager=telflo-create-secrets --force-conflicts -f - ' '$logs/kubectl.log') -eq 7 ] && no_leak"
: >"$files/kubeconfig"
run --context=dev-ctx --kubeconfig "$files/kubeconfig" -n telflo "$full"
check "--kubeconfig handed to both commands of every Secret, after --context" \
  "[ $rc -eq 0 ] && [ \$(grep -c '^--context dev-ctx --kubeconfig $files/kubeconfig -n telflo ' '$logs/kubectl.log') -eq 14 ] && no_leak"
run --context dev-ctx --kubeconfig "$files/missing-kubeconfig" "$full"
check "a --kubeconfig that isn't a file refused (exit 2)" "[ $rc -eq 2 ] && has \"isn't a file\" && no_kubectl"

# --- 6. a failing kubectl: a fixed message, no value -----------------------------------------------------
FAKE_KUBECTL_FAIL=apply run --context dev-ctx -n telflo "$full"
check "a failing apply: exit 1, a fixed message naming the Secret, nothing applied after it" \
  "[ $rc -eq 1 ] && has \"the Secret telflo-postgres wasn't created or updated: kubectl failed\" && [ \$(kubectl_calls) -eq 2 ]"
check "the first Secret failing: the message says no Secret was applied (no count of Secrets before it)" \
  "has 'No Secret was applied; fix the cause' && ! has 'before it'"
check "a failing apply (which echoed the values): none in stdout or stderr, nor any argv" "no_leak"
check "a failing apply: the temporary folder removed" "scratch_empty"
FAKE_KUBECTL_FAIL=create run --context dev-ctx -n telflo "$full"
check "a failing create (which echoed the values): exit 1, the fixed message, no value printed, the folder removed" \
  "[ $rc -eq 1 ] && has \"the Secret telflo-postgres wasn't created or updated\" && no_leak && scratch_empty"
FAKE_KUBECTL_FAIL=namespace run --context dev-ctx -n telflo "$full"
check "a missing namespace: the fixed hint" "[ $rc -eq 1 ] && has \"the namespace doesn't exist (create it first)\" && no_leak"
FAKE_KUBECTL_FAIL_AT=telflo-api run --context dev-ctx -n telflo "$full"
check "the third Secret failing: the message names it and says the 2 Secrets before it were applied" \
  "[ $rc -eq 1 ] && has \"the Secret telflo-api wasn't created or updated\" && has 'The 2 Secret(s) before it' && [ \$(kubectl_calls) -eq 6 ] && no_leak && scratch_empty"

# A signal mid-run (the fake's create waiting): bash runs the trap once kubectl's pipe ends, then exits by
# the signal's code; the EXIT trap removes the folder. No later Secret is applied.
signal_case() { # <signal> <exit code>
  clear_logs
  env PATH="$script_path" TMPDIR="$scratch" FAKE_KUBECTL_SLOW=1 "$shell" "$script" --context dev-ctx -n telflo "$full" \
    >"$tmp/out" 2>"$tmp/stderr" &
  pid=$!
  i=0; while [ ! -e "$logs/started" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
  mid_run_folder=false
  if [ -e "$logs/started" ] && [ -n "$(ls -A "$scratch")" ]; then mid_run_folder=true; fi
  kill -"$1" "$pid" 2>/dev/null
  : >"$logs/release"
  wait "$pid"; rc=$?
  cat "$tmp/stderr" >>"$tmp/out"
  check "$1 mid-run: exit $2, the temporary folder (there mid-run) removed, nothing applied after, no value printed" \
    "\$mid_run_folder && [ $rc -eq $2 ] && scratch_empty && [ \$(kubectl_calls) -eq 2 ] && ! grep -q 'done:' '$tmp/out' && no_leak"
}
signal_case TERM 143
signal_case HUP 129

# --- 7. the file's content refused before kubectl runs ----------------------------------------------------
# variant <name> <sed expression>: a copy of the full file, changed, mode 0600 -> $variant
variant() {
  variant="$files/$1.secrets.env"
  sed -e "$2" "$full" >"$variant"; chmod 600 "$variant"
}
bad='p@ss/w:rd#?%-'"$(openssl rand -hex 8)"
add_canary "$bad"
for pair in telflo-postgres:postgres-password telflo-postgres:owner-password telflo-postgres:api-password \
  telflo-opamp-server:owner-password telflo-opamp-server:runtime-password; do
  section="${pair%%:*}"; key="${pair#*:}"
  variant "unsafe-$section-$key" "/^\[$section\]\$/,/^\[/ s|^$key=.*|$key=$bad|"
  run --context dev-ctx "$variant"
  check "a non-URL-safe [$section] $key refused (exit 1, named, its value not shown), kubectl never run" \
    "[ $rc -eq 1 ] && has \"[$section]'s $key isn't URL-safe\" && no_kubectl && no_leak && scratch_empty"
done
variant safe-elsewhere "s|^access-token-secret=.*|access-token-secret=$bad$bad$bad|"
run --context dev-ctx "$variant"
check "the same characters in a non-Postgres secret are accepted (the rule is the five passwords')" "[ $rc -eq 0 ] && no_leak"

variant no-section '/^\[telflo-internal-services\]$/,/^$/d'
run --context dev-ctx "$variant"
check "a missing required section refused, kubectl never run" "[ $rc -eq 1 ] && has 'the section [telflo-internal-services] is missing' && no_kubectl"
variant no-key '/^api-password=/d'
run --context dev-ctx "$variant"
check "a missing required key refused, named" "[ $rc -eq 1 ] && has \"[telflo-postgres]'s api-password is missing or empty\" && no_kubectl"
variant empty-key 's/^api-password=.*/api-password=/'
run --context dev-ctx "$variant"
check "an empty required key refused, named" "[ $rc -eq 1 ] && has \"[telflo-postgres]'s api-password is missing or empty\" && no_kubectl"
variant empty-optional 's/^encryption-keys-previous=.*/encryption-keys-previous=/'
run --context dev-ctx "$variant"
check "an empty optional key counts as absent (not handed to kubectl)" \
  "[ $rc -eq 0 ] && ! grep -q 'encryption-keys-previous' '$logs/kubectl.log'"
loose="$(openssl rand -hex 20)"
add_canary "$loose"
variant stray-line "s|^\[telflo-mail\]\$|$loose\\
[telflo-mail]|"
run --context dev-ctx "$variant"
check "a line that isn't a section, key=value or comment refused by its number, its text not shown" \
  "[ $rc -eq 1 ] && has \"isn't a [section], a key=value line or a # comment\" && no_kubectl && no_leak"
variant unknown-key "s|^\[telflo-mail\]\$|[telflo-mail]\\
$loose=x|"
run --context dev-ctx "$variant"
check "an unknown key refused by its line number, the key not shown" \
  "[ $rc -eq 1 ] && has 'not a key of [telflo-mail]' && no_kubectl && no_leak"
variant unknown-section 's|^\[telflo-mail\]$|[telflo-other]|'
run --context dev-ctx "$variant"
check "an unknown section refused" "[ $rc -eq 1 ] && has 'an unknown section' && no_kubectl"
variant twice '/^api-password=/p'
run --context dev-ctx "$variant"
check "a key given twice refused" "[ $rc -eq 1 ] && has \"[telflo-postgres]'s api-password appears twice\" && no_kubectl && no_leak"
variant dup-section 's/^$/&/'
printf '\n[telflo-postgres]\n' >>"$variant"
run --context dev-ctx "$variant"
check "a section given twice refused" "[ $rc -eq 1 ] && has 'the section [telflo-postgres] appears twice' && no_kubectl && no_leak"
variant empty-optional-section '/^sendgrid-api-key=/d; /^smtp-username=/d; /^smtp-password=/d'
run --context dev-ctx "$variant"
check "[telflo-mail] holding no key refused, naming its keys (D36-1 decision 39)" \
  "[ $rc -eq 1 ] && has \"[telflo-mail] holds no key: give sendgrid-api-key, or smtp-username and smtp-password\" && no_kubectl && no_leak"
variant mail-username-alone '/^sendgrid-api-key=/d; /^smtp-password=/d'
run --context dev-ctx "$variant"
check "[telflo-mail]'s smtp-username without smtp-password refused, no value shown, kubectl never run" \
  "[ $rc -eq 1 ] && has \"[telflo-mail]'s smtp-username and smtp-password go together: give both, or neither\" && no_kubectl && no_leak"
variant mail-password-alone '/^smtp-username=/d'
run --context dev-ctx "$variant"
check "[telflo-mail]'s smtp-password without smtp-username refused (beside a SendGrid key too), no value shown" \
  "[ $rc -eq 1 ] && has \"[telflo-mail]'s smtp-username and smtp-password go together: give both, or neither\" && no_kubectl && no_leak"
variant mail-login-only '/^sendgrid-api-key=/d'
run --context dev-ctx "$variant"
check "[telflo-mail] with the SMTP login alone (no SendGrid key): applied with exactly its two keys" \
  "[ $rc -eq 0 ] && grep -qxE -- '--context dev-ctx create secret generic telflo-mail --from-file=smtp-username=[^ ]+ --from-file=smtp-password=[^ ]+ --dry-run=client -o yaml ' '$logs/kubectl.log' && same_value '$variant' telflo-mail smtp-username && same_value '$variant' telflo-mail smtp-password && no_leak"
rm_value_files
variant mail-sendgrid-only '/^smtp-username=/d; /^smtp-password=/d'
run --context dev-ctx "$variant"
check "[telflo-mail] with the SendGrid key alone: applied with exactly that key" \
  "[ $rc -eq 0 ] && grep -qxE -- '--context dev-ctx create secret generic telflo-mail --from-file=sendgrid-api-key=[^ ]+ --dry-run=client -o yaml ' '$logs/kubectl.log' && no_leak"

# The previous keys' lists: the Secret gets the value as written, so it is checked as written.
k1="$(openssl rand -hex 32)"; k2="$(openssl rand -hex 32)"
q1="$(openssl rand -base64 32)"; q2="$(openssl rand -base64 32)"
for v in "$k1" "$k2" "$q1" "$q2"; do add_canary "$v"; done
variant lists-ok "s|^encryption-keys-previous=.*|encryption-keys-previous=$k1,$k2|; s|^# quick-deploy-previous-encryption-keys=\$|quick-deploy-previous-encryption-keys=$q1,$q2|"
run --context dev-ctx "$variant"
check "previous keys, comma-separated with no spaces: accepted, each Secret given exactly the list" \
  "[ $rc -eq 0 ] && same_value '$variant' telflo-opamp-server encryption-keys-previous && same_value '$variant' telflo-api quick-deploy-previous-encryption-keys && no_leak"
rm_value_files
variant list-space-after "s|^encryption-keys-previous=.*|encryption-keys-previous=$k1, $k2|"
run --context dev-ctx "$variant"
check "a space after a list's comma refused, the key named" \
  "[ $rc -eq 1 ] && has \"[telflo-opamp-server]'s encryption-keys-previous holds white space\" && no_kubectl && no_leak"
variant list-space-before "s|^# quick-deploy-previous-encryption-keys=\$|quick-deploy-previous-encryption-keys=$q1 ,$q2|"
run --context dev-ctx "$variant"
check "a space before a list's comma refused, the key named" \
  "[ $rc -eq 1 ] && has \"[telflo-api]'s quick-deploy-previous-encryption-keys holds white space\" && no_kubectl && no_leak"
variant list-edge-space "s|^encryption-keys-previous=.*|encryption-keys-previous= $k1,$k2|"
run --context dev-ctx "$variant"
check "a list with white space at its start refused" \
  "[ $rc -eq 1 ] && has \"[telflo-opamp-server]'s encryption-keys-previous has white space at its start or end\" && no_kubectl && no_leak"
variant list-short "s|^encryption-keys-previous=.*|encryption-keys-previous=$k1,$(printf '%031d' 0)|"
run --context dev-ctx "$variant"
check "a previous key of 31 bytes refused (each entry at least 32 bytes)" \
  "[ $rc -eq 1 ] && has \"[telflo-opamp-server]'s encryption-keys-previous: each key must be at least 32 bytes\" && no_kubectl && no_leak"
variant list-commas "s|^encryption-keys-previous=.*|encryption-keys-previous=,,|"
run --context dev-ctx "$variant"
check "a list of commas only refused (it holds no key)" \
  "[ $rc -eq 1 ] && has \"[telflo-opamp-server]'s encryption-keys-previous holds no key\" && no_kubectl"
variant list-bad-base64 "s|^# quick-deploy-previous-encryption-keys=\$|quick-deploy-previous-encryption-keys=$q1,$k2|"
run --context dev-ctx "$variant"
check "a quick-deploy previous key that isn't base64 of 32 bytes refused" \
  "[ $rc -eq 1 ] && has \"[telflo-api]'s quick-deploy-previous-encryption-keys: each key must be base64 of exactly 32 bytes\" && no_kubectl && no_leak"
variant list-empty-entry "s|^# quick-deploy-previous-encryption-keys=\$|quick-deploy-previous-encryption-keys=$q1,,$q2|"
run --context dev-ctx "$variant"
check "an empty entry in the quick-deploy previous keys refused" \
  "[ $rc -eq 1 ] && has \"[telflo-api]'s quick-deploy-previous-encryption-keys has an empty entry between its commas\" && no_kubectl && no_leak"
variant short 's/^management-secret=\(.\{31\}\).*/management-secret=\1/'
run --context dev-ctx "$variant"
check "a 31-byte management secret refused (at least 32 bytes)" \
  "[ $rc -eq 1 ] && has \"[telflo-opamp-server]'s management-secret must be at least 32 bytes\" && no_kubectl && no_leak"
variant quick 's/^quick-deploy-encryption-key=.*/quick-deploy-encryption-key='"$(openssl rand -hex 32)"'/'
run --context dev-ctx "$variant"
check "a quick-deploy key that isn't base64 of 32 bytes refused" \
  "[ $rc -eq 1 ] && has \"[telflo-api]'s quick-deploy-encryption-key must be base64 of exactly 32 bytes\" && no_kubectl"
variant spaced 's/^ottl-evaluator-secret=\(.*\)/ottl-evaluator-secret=\1 /'
run --context dev-ctx "$variant"
check "a value with white space at an end refused" "[ $rc -eq 1 ] && has \"[telflo-internal-services]'s ottl-evaluator-secret has white space\" && no_kubectl"
cr=$'\r'
variant crlf "s/^api-password=\(.*\)\$/api-password=\1$cr/"
run --context dev-ctx "$variant"
check "a carriage return refused by its line number" "[ $rc -eq 1 ] && has 'ends in a carriage return' && no_kubectl && no_leak"
cp "$full" "$files/open.secrets.env"; chmod 644 "$files/open.secrets.env"
run --context dev-ctx "$files/open.secrets.env"
check "a secrets file others may read refused (chmod 600 it)" "[ $rc -eq 1 ] && has 'can be read by others than its owner' && no_kubectl"

# --- 8. ghcr-pull's token file -----------------------------------------------------------------------------
chmod 644 "$files/ghcr-token"
run --context dev-ctx "$full"
check "a token file others may read refused, kubectl never run" "[ $rc -eq 1 ] && has \"[ghcr-pull]'s token-file can be read by others\" && no_kubectl && no_leak"
chmod 600 "$files/ghcr-token"
printf '%s\nsecond\n' "$token" >"$files/two-line-token"; chmod 600 "$files/two-line-token"
variant two-lines "s|^token-file=.*|token-file=$files/two-line-token|"
run --context dev-ctx "$variant"
check "a token file of two lines refused (an absolute token-file read as given)" \
  "[ $rc -eq 1 ] && has \"[ghcr-pull]'s token-file holds more than one line\" && no_kubectl && no_leak"
variant no-token-file "s|^token-file=.*|token-file=$files/absent-token|"
run --context dev-ctx "$variant"
check "a missing token file refused" "[ $rc -eq 1 ] && has \"[ghcr-pull]'s token-file isn't a file\" && no_kubectl"
variant absolute "s|^token-file=.*|token-file=$files/ghcr-token|"
run --context dev-ctx "$variant"
check "an absolute token-file path: ghcr-pull applied" "[ $rc -eq 0 ] && grep -q 'create secret generic ghcr-pull --type=kubernetes.io/dockerconfigjson' '$logs/kubectl.log' && no_leak"

# --- 9. the script itself --------------------------------------------------------------------------------
check "the script runs kubectl only through its --context array (kubectl_base)" \
  "grep -qE '^kubectl_base=\\(kubectl --context \"\\\$context\"\\)\$' '$script' && ! grep -E '^[^#]*(^|[|;&(]|then|do)[[:space:]]*kubectl[[:space:]]' '$script' | grep -vxF 'kubectl_base=(kubectl --context \"\$context\")' | grep -q ."
check "the script never uses --from-literal (values only through files)" "! grep -qE '^[^#]*--from-literal' '$script'"
check "no unexpected kubectl subcommand was ever run" "[ ! -s '$logs/unexpected.log' ]"

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILURE(S)"; exit 1; fi
