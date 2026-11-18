#!/usr/bin/env bash
# Creates or updates the platform chart's Secrets from one git-ignored file
# (D33-1 spec decisions 7, 8, 20 and 33; Preflight rulings 4 and 17). The
# chart takes Secret NAMES only (`existingSecret`); this script is how their
# values reach the cluster, before the first install and whenever one changes.
#
#   scripts/create-secrets.sh --context <context> [--namespace <namespace>] [--kubeconfig <file>] <file>
#   scripts/create-secrets.sh --init <file>
#
# --init <file> writes a NEW file (refused if anything exists at that path;
# its name must end in `.secrets.env`, which .gitignore ignores; mode 0600)
# with fresh random values for every key the platform generates: the five
# Postgres passwords and the other secrets as hex of 32 random bytes
# (`openssl rand -hex 32`; hex is URL-safe), the quick-deploy key as base64 of
# exactly 32 bytes (`openssl rand -base64 32`, what the API requires). The
# optional Secrets and keys are written as commented placeholders. It prints a
# fixed note to back the opamp-server's encryption-key up outside the cluster.
#
# The file: one [section] per Secret, then that Secret's `key=value` lines.
# The value is everything after the first `=` (no quotes, no inline comment:
# a `#` inside a value is part of it); a line whose first non-blank character
# is `#` is a comment; blank lines are ignored. The sections and keys are
# exactly the spec's decision 20 (the chart's default Secret names):
#
#   [telflo-postgres]           postgres-password, owner-password, api-password
#   [telflo-opamp-server]       owner-password, runtime-password, management-secret,
#                               encryption-key; optional management-secrets-previous,
#                               encryption-keys-previous
#   [telflo-api]                access-token-secret, quick-deploy-encryption-key,
#                               library-link-signing-key; optional
#                               quick-deploy-previous-encryption-keys,
#                               library-link-signing-keys-previous
#   [telflo-internal-services]  otelcol-validator-secret, otelcol-testing-secret,
#                               ottl-evaluator-secret
#   [telflo-oidc-google]        (optional) client-id, client-secret
#   [telflo-mail]               (optional) sendgrid-api-key, smtp-username,
#                               smtp-password (each optional; at least one key,
#                               and the SMTP login's two together)
#   [ghcr-pull]                 (optional) username, token-file
#
# The first four sections are required, and every key of a section given is
# required but the optional ones (an optional key left empty counts as
# absent). The values are checked before kubectl runs at all: the five
# Postgres passwords (telflo-postgres's three, telflo-opamp-server's
# owner-password and runtime-password) must be URL-safe (only A-Z a-z 0-9 . _
# ~ -: the chart composes database URLs from them, and a URL that doesn't
# parse is an error quoting it); the management secret, the encryption key,
# the access-token, library-link and internal services' secrets at least 32
# bytes; the quick-deploy key base64 of exactly 32 bytes; each previous key
# (comma-separated, no space around a comma: the Secret gets exactly what was
# checked) under its current key's rule; no value with white space
# at either end. [ghcr-pull] is a `kubernetes.io/dockerconfigjson` Secret for
# ghcr.io built from a TOKEN FILE (never a token typed into this file): the
# token alone in a file of mode 0600 (a relative path is read from the
# secrets file's folder); the script writes the `.dockerconfigjson` (username
# and the base64 `auth`) in its temporary folder.
#
# Each Secret is written key by key into a 0700 temporary folder (umask 077,
# values with no line ending), then:
#   kubectl --context <ctx> [-n <ns>] create secret generic <name> [--type=…] \
#     --from-file=<key>=<folder>/<key>… --dry-run=client -o yaml |
#   kubectl --context <ctx> [-n <ns>] apply --server-side \
#     --field-manager=telflo-create-secrets --force-conflicts -f -
# A server-side apply stores no `last-applied-configuration` annotation (a
# client-side one would hold every value, Ruling 17); a re-run updates each
# Secret in place, and a key removed from the file (a previous key after a
# rotation) is removed from its Secret.
#
# --context is required and refused if empty: the script never uses the
# current context, and never runs kubectl without --context. A value never
# goes on a command's argv (kubectl reads files; the base64 of the registry
# login is piped), into stdout or stderr, a log line or an error: the
# messages name a section, a key or a line number, never a value or a line's
# text. kubectl's stderr from both commands goes to the temporary folder and
# is never printed (a failing apply can echo its patch); a failure prints a
# fixed message naming the Secret, with a fixed hint when its cause is
# recognised. The secrets file and the token file are refused when their
# mode lets anyone but their owner read them. The temporary folder is
# removed on every exit.
#
# Exit codes: 0 done; 2 a usage refusal (nothing read, kubectl never run); 1
# anything else (the file's content refused before kubectl runs, or a
# Secret's create or apply failed). Needs kubectl (openssl for --init).
# bash 3.2 compatible (macOS's /bin/bash).
set -euo pipefail
# Never traced (`bash -x` would print every value it handles).
set +x
umask 077
# Byte-wise lengths and patterns.
export LC_ALL=C

FIELD_MANAGER="telflo-create-secrets"
REGISTRY="ghcr.io"
SECTIONS="telflo-postgres telflo-opamp-server telflo-api telflo-internal-services telflo-oidc-google telflo-mail ghcr-pull"
REQUIRED_SECTIONS="telflo-postgres telflo-opamp-server telflo-api telflo-internal-services"
SECTION_LINE_RE='^\[([a-z0-9.-]+)\]$'
KEY_LINE_RE='^([a-z0-9.-]+)='
URL_SAFE_RE='^[A-Za-z0-9._~-]+$'
# The API's quick-deploy key: standard base64 of exactly 32 bytes.
BASE64_KEY_RE='^[A-Za-z0-9+/]{43}=$'
HEX_RE='^[0-9a-f]{64}$'
EDGE_SPACE_RE='^[[:space:]]|[[:space:]]$'
NAMESPACE_RE='^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'
USERNAME_RE='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$'
TOKEN_RE='^[A-Za-z0-9_.=+/-]{20,}$'
SAFE_PATH_RE='^/[A-Za-z0-9._/-]+$'

usage() {
  cat >&2 <<'EOF'
usage: scripts/create-secrets.sh --context <context> [--namespace <namespace>] [--kubeconfig <file>] <file>
       scripts/create-secrets.sh --init <file>       write a new <name>.secrets.env with fresh values
EOF
}
fail() { echo "create-secrets: $1" >&2; exit 1; }
refuse_usage() { echo "create-secrets: $1" >&2; usage; exit 2; }
note() { echo "create-secrets: $1" >&2; }

work=""
cleanup() { if [ -n "$work" ] && [ -d "$work" ]; then rm -rf "$work"; fi; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# keys_of <section>: the section's keys, in the table's order.
keys_of() {
  case "$1" in
    telflo-postgres) echo "postgres-password owner-password api-password" ;;
    telflo-opamp-server) echo "owner-password runtime-password management-secret encryption-key management-secrets-previous encryption-keys-previous" ;;
    telflo-api) echo "access-token-secret quick-deploy-encryption-key library-link-signing-key quick-deploy-previous-encryption-keys library-link-signing-keys-previous" ;;
    telflo-internal-services) echo "otelcol-validator-secret otelcol-testing-secret ottl-evaluator-secret" ;;
    telflo-oidc-google) echo "client-id client-secret" ;;
    telflo-mail) echo "sendgrid-api-key smtp-username smtp-password" ;;
    ghcr-pull) echo "username token-file" ;;
    *) return 1 ;;
  esac
}
# kind_of <section> <key>: "<rule> required|optional", or false for no such key.
kind_of() {
  case "$1/$2" in
    telflo-postgres/postgres-password | telflo-postgres/owner-password | telflo-postgres/api-password) echo "url-safe required" ;;
    telflo-opamp-server/owner-password | telflo-opamp-server/runtime-password) echo "url-safe required" ;;
    telflo-opamp-server/management-secret | telflo-opamp-server/encryption-key) echo "bytes32 required" ;;
    telflo-opamp-server/management-secrets-previous | telflo-opamp-server/encryption-keys-previous) echo "bytes32-list optional" ;;
    telflo-api/access-token-secret | telflo-api/library-link-signing-key) echo "bytes32 required" ;;
    telflo-api/quick-deploy-encryption-key) echo "base64-key required" ;;
    telflo-api/quick-deploy-previous-encryption-keys) echo "base64-key-list optional" ;;
    telflo-api/library-link-signing-keys-previous) echo "bytes32-list optional" ;;
    telflo-internal-services/otelcol-validator-secret | telflo-internal-services/otelcol-testing-secret | telflo-internal-services/ottl-evaluator-secret) echo "bytes32 required" ;;
    telflo-oidc-google/client-id | telflo-oidc-google/client-secret) echo "text required" ;;
    telflo-mail/sendgrid-api-key | telflo-mail/smtp-username | telflo-mail/smtp-password) echo "text optional" ;;
    ghcr-pull/username) echo "username required" ;;
    ghcr-pull/token-file) echo "path required" ;;
    *) return 1 ;;
  esac
}
is_section() { keys_of "$1" >/dev/null; }

# mode_of <file>: its permission bits in octal (GNU stat, else BSD stat).
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
# private <file>: true when neither its group nor others may read, write or run it.
private() {
  local mode
  mode="$(mode_of "$1")" || return 1
  [[ "$mode" =~ ^[0-7]+$ ]] || return 1
  [ $((8#$mode & 8#077)) -eq 0 ]
}

# ---- --init: a new file with fresh values -------------------------------------------------
# random_hex: 32 random bytes as 64 hex characters (URL-safe), into $generated (no argv).
random_hex() {
  generated="$(openssl rand -hex 32)" || fail "--init: openssl rand failed: nothing written"
  [[ "$generated" =~ $HEX_RE ]] || fail "--init: openssl rand didn't answer 64 hex characters: nothing written"
}
random_base64_key() {
  generated="$(openssl rand -base64 32)" || fail "--init: openssl rand failed: nothing written"
  [[ "$generated" =~ $BASE64_KEY_RE ]] || fail "--init: openssl rand didn't answer base64 of 32 bytes: nothing written"
}

init_file() {
  local file="$1" folder generated=""
  local pg_postgres pg_owner pg_api op_owner op_runtime op_management op_encryption
  local api_access api_quick api_library svc_validator svc_testing svc_evaluator
  case "$file" in
    *?.secrets.env) ;;
    *) refuse_usage "--init: name the file <name>.secrets.env (git ignores *.secrets.env)" ;;
  esac
  if [ -e "$file" ] || [ -L "$file" ]; then
    fail "--init: $file exists already: refused (it never overwrites a file: move it away or name another)"
  fi
  folder="$(dirname -- "$file")"
  [ -d "$folder" ] || fail "--init: the folder $folder doesn't exist"
  command -v openssl >/dev/null 2>&1 || fail "--init: openssl is not on PATH"

  # Every value made before the file is opened: a failure writes nothing.
  random_hex; pg_postgres="$generated"
  random_hex; pg_owner="$generated"
  random_hex; pg_api="$generated"
  random_hex; op_owner="$generated"
  random_hex; op_runtime="$generated"
  random_hex; op_management="$generated"
  random_hex; op_encryption="$generated"
  random_hex; api_access="$generated"
  random_base64_key; api_quick="$generated"
  random_hex; api_library="$generated"
  random_hex; svc_validator="$generated"
  random_hex; svc_testing="$generated"
  random_hex; svc_evaluator="$generated"
  generated=""

  # noclobber: the file is created anew (O_EXCL), never opened if it appeared meanwhile.
  if ! (
    set -C
    {
      cat <<'EOF'
# The telflo chart's Secrets, read by scripts/create-secrets.sh (its
# header documents this format). Made by `create-secrets.sh --init`.
#
# EVERY VALUE HERE IS A SECRET. Keep this file out of git (*.secrets.env is
# ignored), mode 0600, and backed up somewhere safe outside the cluster.
#
# One [section] per Secret, then its key=value lines. The value is everything
# after the first = (no quotes, no inline comment). A line starting with # is
# a comment.

[telflo-postgres]
# The Postgres superuser's, the platform's owner's (telflo_platform_owner) and the API's
# (telflo_platform) passwords. URL-safe only (A-Z a-z 0-9 . _ ~ -): the chart
# composes database URLs from them.
EOF
      printf 'postgres-password=%s\n' "$pg_postgres"
      printf 'owner-password=%s\n' "$pg_owner"
      printf 'api-password=%s\n' "$pg_api"
      cat <<'EOF'

[telflo-opamp-server]
# The opamp-server's schema owner's and runtime role's passwords (URL-safe),
# its management secret and its encryption key (each at least 32 bytes).
# BACK UP encryption-key OUTSIDE THE CLUSTER: it encrypts the enrollment
# tokens the opamp-server stores, and without it they can't be read again.
EOF
      printf 'owner-password=%s\n' "$op_owner"
      printf 'runtime-password=%s\n' "$op_runtime"
      printf 'management-secret=%s\n' "$op_management"
      printf 'encryption-key=%s\n' "$op_encryption"
      cat <<'EOF'
# During a rotation, the previous ones (comma-separated, no spaces, each at least 32 bytes):
# management-secrets-previous=
# encryption-keys-previous=

[telflo-api]
# The access tokens' signing secret (at least 32 bytes), the quick-deploy
# encryption key (base64 of exactly 32 bytes) and the library links' signing
# key (at least 32 bytes).
EOF
      printf 'access-token-secret=%s\n' "$api_access"
      printf 'quick-deploy-encryption-key=%s\n' "$api_quick"
      printf 'library-link-signing-key=%s\n' "$api_library"
      cat <<'EOF'
# During a rotation, the previous ones (comma-separated, no spaces, each under the current one's rule):
# quick-deploy-previous-encryption-keys=
# library-link-signing-keys-previous=

[telflo-internal-services]
# The validator's, the tester's and the evaluator's shared secrets (each at
# least 32 bytes).
EOF
      printf 'otelcol-validator-secret=%s\n' "$svc_validator"
      printf 'otelcol-testing-secret=%s\n' "$svc_testing"
      printf 'ottl-evaluator-secret=%s\n' "$svc_evaluator"
      cat <<'EOF'

# Optional: Google sign-in (the chart's oidcGoogle.enabled).
# [telflo-oidc-google]
# client-id=
# client-secret=

# Optional: mail through SendGrid (the chart's mail.transport: sendgrid), or
# the SMTP relay's login (the chart's mail.smtp.auth: true; both keys).
# [telflo-mail]
# sendgrid-api-key=
# smtp-username=
# smtp-password=

# Optional: the pull secret for private ghcr.io images (the chart's
# imagePullSecrets), built from a token FILE, never a token typed here: a
# token that can only read packages, alone in a file of mode 0600. A relative
# token-file is read from this file's folder.
# [ghcr-pull]
# username=
# token-file=
EOF
    } >"$file"
  ) 2>/dev/null; then
    fail "--init: couldn't create $file (it appeared meanwhile, or the folder isn't writable): nothing overwritten"
  fi
  chmod 600 "$file"
  note "wrote $file (mode 0600) with fresh values for every generated key"
  note "back up the opamp-server's encryption-key (in [telflo-opamp-server]) outside the cluster: it encrypts the enrollment tokens the opamp-server stores, and without it they can't be read again"
  note "the file holds every secret: keep it out of git (*.secrets.env is ignored) and mode 0600"
}

# ---- reading and checking the file --------------------------------------------------------
# read_file <file> <store>: each value into <store>/<section>/<key> (no line ending).
read_file() {
  local file="$1" store="$2" line trimmed n=0 section="" key value
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in
      *$'\r') fail "line $n ends in a carriage return: save the file with Unix line endings" ;;
    esac
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in '' | '#'*) continue ;; esac
    if [[ "$line" =~ $SECTION_LINE_RE ]]; then
      section="${BASH_REMATCH[1]}"
      is_section "$section" || fail "line $n: an unknown section (the sections are: $SECTIONS)"
      [ ! -e "$store/$section" ] || fail "line $n: the section [$section] appears twice"
      mkdir "$store/$section"
      continue
    fi
    if [[ "$line" =~ $KEY_LINE_RE ]]; then
      key="${BASH_REMATCH[1]}"
      [ -n "$section" ] || fail "line $n: a key=value line before any [section]"
      # An unknown key isn't named: the line could be a misplaced value.
      kind_of "$section" "$key" >/dev/null || fail "line $n: not a key of [$section] (its keys are: $(keys_of "$section"))"
      [ ! -e "$store/$section/$key" ] || fail "line $n: [$section]'s $key appears twice"
      value="${line#*=}"
      printf '%s' "$value" >"$store/$section/$key"
      continue
    fi
    fail "line $n isn't a [section], a key=value line or a # comment (the line isn't shown: it could hold a value)"
  done <"$file"
  value=""
}

# check_list <section> <key> <rule> <value>: each comma-separated entry under the rule. No white space at
# all (around a comma or in a key): the Secret receives the value as written, so exactly what is checked here.
check_list() {
  local rest="$4" entry count=0
  case "$rest" in
    *[[:space:]]*) fail "[$1]'s $2 holds white space: write its keys comma-separated, with no space around a comma" ;;
  esac
  while :; do
    case "$rest" in
      *,*) entry="${rest%%,*}"; rest="${rest#*,}" ;;
      *) entry="$rest"; rest="" ;;
    esac
    if [ -n "$entry" ]; then
      count=$((count + 1))
      case "$3" in
        bytes32) [ "${#entry}" -ge 32 ] || fail "[$1]'s $2: each key must be at least 32 bytes" ;;
        base64-key) [[ "$entry" =~ $BASE64_KEY_RE ]] || fail "[$1]'s $2: each key must be base64 of exactly 32 bytes (44 characters, e.g. from: openssl rand -base64 32)" ;;
      esac
    elif [ "$3" = base64-key ]; then
      fail "[$1]'s $2 has an empty entry between its commas"
    fi
    [ -n "$rest" ] || break
  done
  [ "$count" -gt 0 ] || fail "[$1]'s $2 holds no key"
}

# check_section <store> <section>: every key present as its rule says, each value checked.
check_section() {
  local store="$1" section="$2" key kind rule need value f
  for key in $(keys_of "$section"); do
    kind="$(kind_of "$section" "$key")"; rule="${kind% *}"; need="${kind#* }"
    f="$store/$section/$key"
    if [ ! -e "$f" ] || [ ! -s "$f" ]; then
      if [ "$need" = optional ]; then rm -f "$f"; continue; fi
      fail "[$section]'s $key is missing or empty"
    fi
    value=""
    IFS= read -r value <"$f" || true
    [[ ! "$value" =~ $EDGE_SPACE_RE ]] || fail "[$section]'s $key has white space at its start or end"
    case "$rule" in
      url-safe)
        [[ "$value" =~ $URL_SAFE_RE ]] ||
          fail "[$section]'s $key isn't URL-safe: a Postgres password may hold only A-Z a-z 0-9 . _ ~ - (the chart composes database URLs from it; --init makes hex ones)" ;;
      bytes32) [ "${#value}" -ge 32 ] || fail "[$section]'s $key must be at least 32 bytes" ;;
      base64-key)
        [[ "$value" =~ $BASE64_KEY_RE ]] ||
          fail "[$section]'s $key must be base64 of exactly 32 bytes (44 characters, e.g. from: openssl rand -base64 32)" ;;
      bytes32-list) check_list "$section" "$key" bytes32 "$value" ;;
      base64-key-list) check_list "$section" "$key" base64-key "$value" ;;
      username) [[ "$value" =~ $USERNAME_RE ]] || fail "[$section]'s $key isn't a GitHub user name" ;;
      text | path) ;;
    esac
  done
  value=""
}

# check_mail <store>: [telflo-mail], once given, holds a key, and the SMTP login's two keys together (their
# values are checked as text by check_section; the messages name keys only).
check_mail() {
  local store="$1/telflo-mail"
  if [ ! -f "$store/sendgrid-api-key" ] && [ ! -f "$store/smtp-username" ] && [ ! -f "$store/smtp-password" ]; then
    fail "[telflo-mail] holds no key: give sendgrid-api-key, or smtp-username and smtp-password"
  fi
  local username=false password=false
  if [ -f "$store/smtp-username" ]; then username=true; fi
  if [ -f "$store/smtp-password" ]; then password=true; fi
  [ "$username" = "$password" ] ||
    fail "[telflo-mail]'s smtp-username and smtp-password go together: give both, or neither"
}

# build_registry <store> <secrets file> <folder>: [ghcr-pull]'s .dockerconfigjson in the folder.
build_registry() {
  local store="$1" secrets_file="$2" folder="$3" username token_file token auth
  IFS= read -r username <"$store/ghcr-pull/username" || true
  IFS= read -r token_file <"$store/ghcr-pull/token-file" || true
  case "$token_file" in
    /*) ;;
    *) token_file="$(CDPATH= cd -- "$(dirname -- "$secrets_file")" >/dev/null && pwd)/$token_file" ;;
  esac
  [ -f "$token_file" ] || fail "[ghcr-pull]'s token-file isn't a file"
  [ -r "$token_file" ] || fail "[ghcr-pull]'s token-file can't be read"
  private "$token_file" || fail "[ghcr-pull]'s token-file can be read by others than its owner: chmod 600 it"
  token="$(<"$token_file")"
  case "$token" in *$'\n'*) fail "[ghcr-pull]'s token-file holds more than one line (only the token)" ;; esac
  [[ "$token" =~ $TOKEN_RE ]] || fail "[ghcr-pull]'s token-file doesn't hold a token (one line of at least 20 letters, digits or _ . = + / -)"
  # The login's base64 through a pipe (printf is a builtin: no argv).
  auth="$(printf '%s:%s' "$username" "$token" | base64 | tr -d '\n')"
  token=""
  mkdir "$folder"
  printf '{"auths":{"%s":{"username":"%s","auth":"%s"}}}' "$REGISTRY" "$username" "$auth" >"$folder/.dockerconfigjson"
  auth=""
}

# ---- applying ------------------------------------------------------------------------------
# apply_secret <name> <type or ""> <folder> <key>...: create | server-side apply, kubectl's stderr kept in $work.
apply_secret() {
  local name="$1" type="$2" folder="$3" key hint="" codes create_code apply_code
  shift 3
  local args=(create secret generic "$name")
  if [ -n "$type" ]; then args+=("--type=$type"); fi
  for key in "$@"; do args+=("--from-file=$key=$folder/$key"); done
  args+=(--dry-run=client -o yaml)
  set +e
  "${kubectl_base[@]}" "${args[@]}" 2>"$work/kubectl-create.err" |
    "${kubectl_base[@]}" apply --server-side "--field-manager=$FIELD_MANAGER" --force-conflicts -f - \
      >"$work/kubectl-apply.out" 2>"$work/kubectl-apply.err"
  codes=("${PIPESTATUS[@]}")
  create_code="${codes[0]}"; apply_code="${codes[1]}"
  set -e
  if [ "$create_code" -eq 0 ] && [ "$apply_code" -eq 0 ]; then
    note "$name: applied ($# key(s))"
    return 0
  fi
  # kubectl's messages are never shown (a failing apply can echo its patch): a fixed hint by what they hold.
  cat "$work/kubectl-create.err" "$work/kubectl-apply.err" >"$work/kubectl.err" 2>/dev/null || true
  if grep -qiE 'context .*(was not found|does not exist)|no context exists' "$work/kubectl.err"; then
    hint="the context $context isn't in the kubeconfig"
  elif grep -qiE 'namespaces? "[^"]*" not found' "$work/kubectl.err"; then
    hint="the namespace doesn't exist (create it first)"
  elif grep -qiE 'forbidden' "$work/kubectl.err"; then
    hint="the context's user may not create or update Secrets there"
  elif grep -qiE 'unauthorized|must be logged in|provide credentials' "$work/kubectl.err"; then
    hint="the cluster refused the context's credentials"
  elif grep -qiE 'connection refused|no such host|i/o timeout|unable to connect|dial tcp' "$work/kubectl.err"; then
    hint="the cluster can't be reached"
  else
    hint="kubectl failed"
  fi
  if [ "$applied" -eq 0 ]; then
    fail "the Secret $name wasn't created or updated: $hint (kubectl's own messages aren't shown: they can quote a value). No Secret was applied; fix the cause and run it again"
  fi
  fail "the Secret $name wasn't created or updated: $hint (kubectl's own messages aren't shown: they can quote a value). The $applied Secret(s) before it (in the order of the header's table) were applied; fix the cause and run it again"
}

# ---- arguments ------------------------------------------------------------------------------
context=""; context_given=false
namespace=""; namespace_given=false
kubeconfig=""; kubeconfig_given=false
init=""; init_given=false
file=""
# option_value <option> <value>: the value, refused when it starts with -- (a missing value, the next option taken).
option_value() {
  case "$2" in --*) refuse_usage "$1's value starts with --: give $1 its value" ;; esac
}
while [ $# -gt 0 ]; do
  case "$1" in
    --context) [ $# -ge 2 ] || refuse_usage "--context needs a value"; option_value --context "$2"; context="$2"; context_given=true; shift 2 ;;
    --context=*) context="${1#*=}"; option_value --context "$context"; context_given=true; shift ;;
    --namespace | -n) [ $# -ge 2 ] || refuse_usage "--namespace needs a value"; option_value --namespace "$2"; namespace="$2"; namespace_given=true; shift 2 ;;
    --namespace=*) namespace="${1#*=}"; option_value --namespace "$namespace"; namespace_given=true; shift ;;
    --kubeconfig) [ $# -ge 2 ] || refuse_usage "--kubeconfig needs a value"; option_value --kubeconfig "$2"; kubeconfig="$2"; kubeconfig_given=true; shift 2 ;;
    --kubeconfig=*) kubeconfig="${1#*=}"; option_value --kubeconfig "$kubeconfig"; kubeconfig_given=true; shift ;;
    --init) [ $# -ge 2 ] || refuse_usage "--init needs a file"; init="$2"; init_given=true; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) refuse_usage "unknown argument: $1" ;;
    *) [ -z "$file" ] || refuse_usage "one file only"; file="$1"; shift ;;
  esac
done

if $init_given; then
  if $context_given || $namespace_given || $kubeconfig_given || [ -n "$file" ]; then
    refuse_usage "--init takes only its file"
  fi
  [ -n "$init" ] || refuse_usage "--init needs a file"
  init_file "$init"
  exit 0
fi

$context_given || refuse_usage "--context is required (it never uses the current context)"
[ -n "$context" ] || refuse_usage "--context is empty (it never uses the current context)"
if $namespace_given; then
  [ "${#namespace}" -le 63 ] && [[ "$namespace" =~ $NAMESPACE_RE ]] ||
    refuse_usage "--namespace must be a Kubernetes namespace's name (lower-case letters, digits and -)"
fi
if $kubeconfig_given; then
  [ -n "$kubeconfig" ] || refuse_usage "--kubeconfig is empty"
  [ -f "$kubeconfig" ] || refuse_usage "--kubeconfig: $kubeconfig isn't a file"
fi
[ -n "$file" ] || refuse_usage "the secrets file is required"
[ -f "$file" ] || fail "$file isn't a file"
[ -r "$file" ] || fail "$file can't be read"
private "$file" || fail "$file can be read by others than its owner: chmod 600 it"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is not on PATH"

kubectl_base=(kubectl --context "$context")
if $kubeconfig_given; then kubectl_base+=(--kubeconfig "$kubeconfig"); fi
if $namespace_given; then kubectl_base+=(-n "$namespace"); fi

work="$(mktemp -d "${TMPDIR:-/tmp}/create-secrets.XXXXXX")" || fail "no temporary folder"
[ -n "$work" ] && [ -d "$work" ] || fail "no temporary folder"
chmod 700 "$work"
# The folder's path goes into --from-file (a comma-separated list to kubectl): plain characters only.
[[ "$work" =~ $SAFE_PATH_RE ]] || fail "the temporary folder's path ($work) holds characters kubectl's --from-file would split: set TMPDIR to a plain path"
mkdir "$work/store"

# Every value read and checked before kubectl runs at all.
read_file "$file" "$work/store"
for section in $REQUIRED_SECTIONS; do
  [ -d "$work/store/$section" ] || fail "the section [$section] is missing (the required ones are: $REQUIRED_SECTIONS)"
done
for section in $SECTIONS; do
  if [ -d "$work/store/$section" ]; then check_section "$work/store" "$section"; fi
done
if [ -d "$work/store/telflo-mail" ]; then check_mail "$work/store"; fi
if [ -d "$work/store/ghcr-pull" ]; then build_registry "$work/store" "$file" "$work/registry"; fi

applied=0
for section in $SECTIONS; do
  [ -d "$work/store/$section" ] || continue
  if [ "$section" = ghcr-pull ]; then
    apply_secret ghcr-pull kubernetes.io/dockerconfigjson "$work/registry" .dockerconfigjson
    rm -rf "${work:?}/registry"
  else
    keys=()
    for key in $(keys_of "$section"); do
      if [ -f "$work/store/$section/$key" ]; then keys+=("$key"); fi
    done
    apply_secret "$section" "" "$work/store/$section" "${keys[@]}"
  fi
  # Each Secret's files go as soon as it is applied.
  rm -rf "${work:?}/store/$section"
  applied=$((applied + 1))
done
note "done: $applied Secret(s) applied with the context $context${namespace:+ in the namespace $namespace}"
