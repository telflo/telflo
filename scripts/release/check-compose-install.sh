#!/usr/bin/env bash
# check-compose-install.sh: the Compose install (deploy/compose) holds its
# rules:
#
#   - the four copied files are byte for byte their sources:
#     gateway/default.conf and gateway/extra-routes.conf (docker/gateway/),
#     opamp-server/bootstrap.sql (vendor/opamp-server/) and
#     postgres/telflo-bootstrap.sql (charts/telflo/files/);
#   - compose.yaml, as text: the top-level `name: telflo`, no build:,
#     Mailpit's port line on 127.0.0.1 literally, and each image line naming
#     a Telflo image exactly as
#     ${TELFLO_IMAGE_REGISTRY:-ghcr.io/telflo/telflo}/<name>:<version>
#     (scripts/release/version.sh's TELFLO_COMPOSE_IMAGE_PREFIX): never
#     ghcr.io/telflo/telflo/ without the variable, TELFLO_IMAGE_REGISTRY
#     with no other default and in no other form, no other variable in any
#     image line, and nothing after <name>:<version>;
#   - compose.yaml, as Compose reads it (`docker compose config`, client side
#     only: no daemon, no registry, an empty temporary DOCKER_CONFIG, no
#     caller's environment) in a temporary copy whose .env and secrets/
#     setup.sh made: every service runs a known image and builds nothing
#     (each Telflo image ghcr.io/telflo/telflo/<name>:<version>, the version
#     check-version.sh's, by tag, with TELFLO_IMAGE_REGISTRY unset and with
#     it empty, and <its value>/<name>:<version> with it set to a mirror's
#     path, every other image the same in all three; Postgres and nginx at
#     the chart's digests, read from charts/telflo/values.yaml; the
#     opamp-server at the PIN's;
#     Mailpit by digest, under the profile mailpit only, and no other
#     profile); only the gateway's and the agent endpoint's ports are
#     published, on TELFLO_BIND_ADDRESS (setup.sh's --bind), and Mailpit's on
#     127.0.0.1 only, at setup.sh's --mailpit-port; no service on the host's network; the three secrets
#     the services read from files (the opamp-server's key, the tester's,
#     the evaluator's) mounted from secrets/ and never in an environment;
#     the tester's and the evaluator's networks internal, each alone on
#     its own, read_only, cap_drop [ALL], no-new-privileges; no service
#     privileged, none mounting the Docker socket. Both mail forms
#     (--mailpit, which starts Mailpit through COMPOSE_PROFILES in .env, and
#     a relay, which doesn't); and without .env, Compose refuses the file,
#     naming a variable it requires;
#   - setup.sh's list of the development secrets' sha256 is exactly the
#     development stack's: every value docker-compose.yml gives a variable
#     named like a secret (SECRET, PASSWORD or KEY, not a *_FILE path), every
#     password in a postgresql:// URL there, and every docker/*/development-*
#     file (one final line ending dropped), as Compose reads
#     docker-compose.yml; and no such value appears in deploy/compose.
#
#   scripts/release/check-compose-install.sh       (no argument; from anywhere)
#
# Offline: it reads the tree's files and runs setup.sh in a temporary copy
# (its generated secrets stay there, removed on exit, never printed: Compose's
# output is read by python3 from a pipe, and its messages are never shown
# but for a missing variable's name). Needs the docker CLI with its compose
# plugin, python3 and openssl; without them it fails closed. Exit 0 every
# rule holds, 1 a rule broken (each problem a line), 2 usage. bash 3.2
# compatible.
set -uo pipefail
set +x
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/release/version.sh
. "$SCRIPT_DIR/version.sh"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/release/check-compose-install.sh (no argument)" >&2
  exit 2
fi

INSTALL="$ROOT/deploy/compose"
COMPOSE="$INSTALL/compose.yaml"
SETUP="$INSTALL/setup.sh"
# Each copy, then its source.
COPIES="gateway/default.conf:docker/gateway/default.conf
gateway/extra-routes.conf:docker/gateway/extra-routes.conf
opamp-server/bootstrap.sql:vendor/opamp-server/bootstrap.sql
postgres/telflo-bootstrap.sql:charts/telflo/files/telflo-bootstrap.sql"
# setup.sh's --bind and ports for the check's copies: an address no machine
# routes (TEST-NET-1), so a port published elsewhere shows.
BIND=192.0.2.10
HTTP_PORT=18080
AGENT_PORT=18081
MAILPIT_PORT=18082
# TELFLO_IMAGE_REGISTRY for the reading with it set: a mirror's path, a port
# and two levels deep.
MIRROR=registry.example.com:5000/mirror/telflo

problems=0
problem() { echo "check-compose-install: $*" >&2; problems=$((problems + 1)); }
fatal() { echo "check-compose-install: FAIL: $*" >&2; exit 1; }

work=""
cleanup() { if [ -n "$work" ] && [ -d "$work" ]; then rm -rf "$work"; fi; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for tool in docker python3 openssl; do
  command -v "$tool" >/dev/null 2>&1 ||
    fatal "$tool isn't on PATH: the check reads compose.yaml as Compose does and runs setup.sh, so it can't pass without it"
done
[ -f "$COMPOSE" ] || fatal "deploy/compose/compose.yaml is missing"
[ -f "$SETUP" ] || fatal "deploy/compose/setup.sh is missing"

work="$(mktemp -d "${TMPDIR:-/tmp}/check-compose-install.XXXXXX")" || fatal "couldn't make a temporary folder"
chmod 700 "$work"

# ---- the copies --------------------------------------------------------------------------
while IFS=: read -r copy source; do
  if [ ! -f "$INSTALL/$copy" ] || [ -L "$INSTALL/$copy" ]; then
    problem "deploy/compose/$copy is missing (or a symbolic link): copy $source there"
  elif [ ! -f "$ROOT/$source" ]; then
    problem "$source is missing"
  elif ! cmp -s "$ROOT/$source" "$INSTALL/$copy"; then
    problem "deploy/compose/$copy differs from $source: copy it again (cp $source deploy/compose/$copy)"
  fi
done <<EOF
$COPIES
EOF

# ---- compose.yaml as text ----------------------------------------------------------------
grep -qx 'name: telflo' "$COMPOSE" ||
  problem "deploy/compose/compose.yaml must name its project with a top-level line 'name: telflo'"
if grep -v '^[[:space:]]*#' "$COMPOSE" | grep -qE '^[[:space:]]+build:'; then
  problem "deploy/compose/compose.yaml has a build: (the install runs only published images)"
fi
profiled="$(awk '
  /^[^ #]/ { in_services = ($0 == "services:"); service = ""; next }
  in_services && /^  [^ #]/ { service = $1; sub(/:$/, "", service); next }
  in_services && /^    profiles:/ && service != "mailpit" { print service }' "$COMPOSE")"
for service in $profiled; do
  problem "deploy/compose/compose.yaml's $service has profiles (only Mailpit has one)"
done
[ -x "$SETUP" ] || problem "deploy/compose/setup.sh isn't executable (chmod 755; the archive keeps the mode)"
mailpit_ports="$(awk '
  /^[^ #]/ { in_services = ($0 == "services:"); inside = 0; next }
  in_services && /^  [^ #]/ { inside = ($0 == "  mailpit:"); next }
  inside && /^      - / { print }' "$COMPOSE")"
case "$mailpit_ports" in
  '      - "127.0.0.1:'*) ;;
  *) problem "mailpit's port line in deploy/compose/compose.yaml must begin with \"127.0.0.1: (its inbox on this machine only)" ;;
esac
# Each image line (comments skipped, one pair of quotes dropped):
# "<line>|<what's wrong>|<value>" for one naming a Telflo image other than
# exactly through the prefix, or reading any other variable.
bad_images="$(awk -v prefix="$TELFLO_COMPOSE_IMAGE_PREFIX" -v literal="$TELFLO_COMPOSE_IMAGE_DEFAULT/" '
  /^[[:space:]]*#/ { next }
  /^[[:space:]]+image:[[:space:]]/ {
    value = $0
    sub(/^[[:space:]]+image:[[:space:]]+/, "", value); sub(/[[:space:]]+#.*$/, "", value); sub(/[[:space:]]+$/, "", value)
    if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value = substr(value, 2, length(value) - 2)
    if (index(value, prefix) == 1) {
      if (substr(value, length(prefix) + 1) !~ /^[a-z0-9][a-z0-9-]*:[A-Za-z0-9_.-]+$/) print NR "|after|" value
    } else if (index(value, "TELFLO_IMAGE_REGISTRY") > 0) {
      print NR "|registry|" value
    } else if (index(value, "$") > 0) {
      print NR "|variable|" value
    } else if (index(value, literal) == 1) {
      print NR "|literal|" value
    }
  }' "$COMPOSE")"
if [ -n "$bad_images" ]; then
  while IFS='|' read -r line_number wrong value; do
    where="deploy/compose/compose.yaml:$line_number's image '$value'"
    case "$wrong" in
      after) problem "$where: a Telflo image is ${TELFLO_COMPOSE_IMAGE_PREFIX}<name>:<version> and nothing more (no digest, no other variable)" ;;
      registry) problem "$where: TELFLO_IMAGE_REGISTRY is read only as ${TELFLO_COMPOSE_IMAGE_PREFIX}<name>:<version> (its default the public registry, $TELFLO_COMPOSE_IMAGE_DEFAULT; set empty, the default too)" ;;
      variable) problem "$where reads a variable other than TELFLO_IMAGE_REGISTRY: only a Telflo image takes one, as ${TELFLO_COMPOSE_IMAGE_PREFIX}<name>:<version>" ;;
      literal) problem "$where names $TELFLO_COMPOSE_IMAGE_DEFAULT/ directly: write ${TELFLO_COMPOSE_IMAGE_PREFIX}<name>:<version>, so TELFLO_IMAGE_REGISTRY picks its registry" ;;
    esac
  done <<<"$bad_images"
fi

# ---- what the images must be -------------------------------------------------------------
version=""
if version="$(telflo_chart_field "$ROOT/charts/telflo/Chart.yaml" version)" && telflo_version_ok "$version"; then
  :
else
  problem "charts/telflo/Chart.yaml holds no release version (scripts/release/check-version.sh says more)"
  version=""
fi
# values_image <component>: "<repository>:<tag>@<digest>" from values.yaml.
values_image() {
  awk -v section="$1:" '
    /^[^ #]/ { inside = ($0 == section); image = 0; next }
    inside && /^  [^ #]/ { image = ($0 == "  image:"); next }
    inside && image && /^    (repository|tag|digest):/ {
      key = $1; sub(/:$/, "", key); value = $0
      sub(/^[^:]*:[[:space:]]*/, "", value); sub(/[[:space:]]+#.*$/, "", value)
      gsub(/["\047[:space:]]/, "", value); found[key] = value
    }
    END {
      if (found["repository"] != "" && found["tag"] != "" && found["digest"] ~ /^sha256:[0-9a-f]+$/)
        print found["repository"] ":" found["tag"] "@" found["digest"]
    }' "$ROOT/charts/telflo/values.yaml"
}
postgres_image="$(values_image postgres)"
[ -n "$postgres_image" ] || problem "charts/telflo/values.yaml's postgres.image (repository, tag, digest) couldn't be read"
nginx_image="$(values_image gateway)"
[ -n "$nginx_image" ] || problem "charts/telflo/values.yaml's gateway.image (repository, tag, digest) couldn't be read"
pin_version="$(sed -n 's/^version=\([0-9][0-9.]*\)$/\1/p' "$ROOT/vendor/opamp-server/PIN" 2>/dev/null)"
pin_digest="$(sed -n 's/^digest=\(sha256:[0-9a-f]\{64\}\)$/\1/p' "$ROOT/vendor/opamp-server/PIN" 2>/dev/null)"
opamp_image=""
if [ -n "$pin_version" ] && [ -n "$pin_digest" ]; then
  opamp_image="ghcr.io/telflo/opamp-server:$pin_version@$pin_digest"
else
  problem "vendor/opamp-server/PIN names no version and digest"
fi

# ---- Compose's own reading -------------------------------------------------------------------
# A Docker config with no auths, no credsStore, no credential helper; it names
# the usual plugins folder, if there is one, so the compose plugin is found.
mkdir -p "$work/docker" || fatal "couldn't make a temporary Docker config"
python3 -I -c 'import json, os, sys
plugins = sys.argv[1]
json.dump({"cliPluginsExtraDirs": [plugins]} if os.path.isdir(plugins) else {}, open(sys.argv[2], "w"))' \
  "${DOCKER_CONFIG:-${HOME:-/nonexistent}/.docker}/cli-plugins" "$work/docker/config.json" ||
  fatal "couldn't make a temporary Docker config"
# compose <dir> [args...]: docker compose config --format json in <dir>, its
# project's own folder, with nothing of the caller's environment but
# $registry_setting, when it isn't empty (TELFLO_IMAGE_REGISTRY=<value>, the
# value empty or not).
registry_setting=""
compose_config() {
  local dir="$1"
  shift
  (cd "$dir" && env -i PATH="$PATH" HOME="${HOME:-/nonexistent}" DOCKER_CONFIG="$work/docker" ${registry_setting:+"$registry_setting"} \
    docker compose --project-directory "$dir" "$@" config --format json)
}
# install_copy <name> <setup args...>: a copy of deploy/compose in
# $work/<name> (its .env and secrets/ left out) with setup.sh run there.
install_copy() {
  local name="$1" dir="$work/$1"
  shift
  mkdir -p "$dir" && (cd "$INSTALL" && tar -cf - --exclude ./.env --exclude ./secrets .) | (cd "$dir" && tar -xf -) ||
    fatal "couldn't copy deploy/compose"
  rm -rf "$dir/.env" "$dir/secrets"
  if [ "$#" -gt 0 ]; then
    env -i PATH="$PATH" HOME="${HOME:-/nonexistent}" bash "$dir/setup.sh" "$@" >"$work/$name.setup.out" 2>&1 ||
      fatal "setup.sh refused the check's options ($name form): $(head -n 1 "$work/$name.setup.out")"
  fi
}

# check_install <form> <mailpit: yes|no> [<TELFLO_IMAGE_REGISTRY>]: the copy
# <form>'s Compose reading, every rule, with TELFLO_IMAGE_REGISTRY unset; or,
# given a value (empty or not), its images only, with TELFLO_IMAGE_REGISTRY
# set to it: the Telflo images under the value (the public registry when it
# is empty), every other image as unset.
check_install() {
  local form="$1" mailpit="$2" json_status=0 found label="$1 form" registry="$TELFLO_COMPOSE_IMAGE_DEFAULT" scope=all
  local registry_setting=""
  if [ "$#" -ge 3 ]; then
    registry_setting="TELFLO_IMAGE_REGISTRY=$3"
    scope=images
    if [ -n "$3" ]; then
      registry="$3"
      label="$form form, TELFLO_IMAGE_REGISTRY=$3"
    else
      label="$form form, TELFLO_IMAGE_REGISTRY empty"
    fi
  fi
  found="$(compose_config "$work/$form" -f "$work/$form/compose.yaml" 2>"$work/$form.err" |
    python3 -I -c '
import json, os, re, sys
(form, mailpit, version, postgres, nginx, opamp, bind, http_port, agent_port, mailpit_port, project, registry, scope) = sys.argv[1:14]
try:
    config = json.load(sys.stdin)
    services = config["services"]
except Exception:
    print("Compose refused it or its output is not the JSON expected")
    sys.exit(0)
out = []
if config.get("name") != "telflo":
    out.append("its project is " + repr(config.get("name")) + ", not telflo")
telflo = {"migrate": "api", "api": "api", "web": "web",
          "otelcol-validator": "otelcol-validator", "otelcol-testing": "otelcol-testing",
          "ottl-evaluator": "ottl-evaluator"}
want = {name: registry + "/" + image + ":" + version for name, image in telflo.items()}
want.update({"db": postgres, "db-bootstrap": postgres, "gateway": nginx,
             "opamp-migrate": opamp, "opamp-server": opamp})
mailpit_re = re.compile(r"^axllent/mailpit:v[0-9][0-9.]*@sha256:[0-9a-f]{64}$")
for name in sorted(set(want) - set(services)):
    out.append(name + " is missing")
for name, service in sorted(services.items()):
    image = service.get("image")
    if name == "mailpit":
        if not isinstance(image, str) or not mailpit_re.match(image):
            out.append("mailpit'"'"'s image is " + repr(image) + ", not axllent/mailpit:<version>@sha256:<digest>")
    elif name not in want:
        out.append("an unknown service " + name + " (image " + repr(image) + ")")
    elif image != want[name]:
        out.append(name + "'"'"'s image is " + repr(image) + ", not " + want[name])
    if scope == "images":
        continue
    if "build" in service:
        out.append(name + " has a build")
    if name == "mailpit" and service.get("profiles") != ["mailpit"]:
        out.append("mailpit'"'"'s profiles are " + repr(service.get("profiles")) + ", not exactly [mailpit]")
    if name != "mailpit" and service.get("profiles"):
        out.append(name + " has profiles " + repr(service.get("profiles")) + " (only Mailpit has one)")
    if isinstance(image, str) and image.startswith("axllent/mailpit") and name != "mailpit":
        out.append(name + " runs Mailpit'"'"'s image")
    if service.get("network_mode"):
        out.append(name + " has network_mode " + repr(service.get("network_mode")))
    ports = service.get("ports") or []
    expected = {"gateway": (bind, http_port, 80), "opamp-server": (bind, agent_port, 51234),
                "mailpit": ("127.0.0.1", mailpit_port, 8025)}.get(name)
    if expected is None:
        if ports:
            out.append(name + " publishes a port (only the gateway, the agent endpoint and Mailpit may)")
        continue
    if len(ports) != 1:
        out.append(name + " publishes " + str(len(ports)) + " ports, not one")
        continue
    port = ports[0]
    host_ip, published, target = expected
    if (port.get("host_ip") or "0.0.0.0") != host_ip:
        where = "TELFLO_BIND_ADDRESS (setup.sh --bind)" if host_ip == bind else "127.0.0.1 only"
        out.append(name + "'"'"'s port is published on " + repr(port.get("host_ip") or "0.0.0.0") + ", not on " + where)
    if port.get("target") != target:
        out.append(name + "'"'"'s published port goes to " + repr(port.get("target")) + ", not " + str(target))
    if published is not None and str(port.get("published")) != published:
        out.append(name + "'"'"'s port is published as " + repr(port.get("published")) + ", not setup.sh'"'"'s port")
if scope == "images":
    for line in out:
        print(line)
    sys.exit(0)
# The lockdown: the three secrets stay files, mounted from the project'"'"'s
# secrets/ folder; the tester and the evaluator alone on their internal
# networks, read-only, without capabilities or privilege gained through
# exec; nothing privileged, nothing with the Docker socket.
for name, secret, file_name, file_var, env_var in (
        ("opamp-server", "opamp_encryption_key", "opamp-encryption-key", "OPAMP_ENCRYPTION_KEY_FILE", "OPAMP_ENCRYPTION_KEY"),
        ("otelcol-testing", "otelcol_testing_secret", "otelcol-testing-secret", "OTELCOL_TESTING_SECRET_FILE", "OTELCOL_TESTING_SECRET"),
        ("ottl-evaluator", "ottl_evaluator_secret", "ottl-evaluator-secret", "OTTL_EVALUATOR_SECRET_FILE", "OTTL_EVALUATOR_SECRET")):
    service = services.get(name) or {}
    sources = [entry.get("source") if isinstance(entry, dict) else entry for entry in service.get("secrets") or []]
    if secret not in sources:
        out.append(name + " does not mount the secret " + secret)
    environment = service.get("environment") or {}
    if environment.get(file_var) != "/run/secrets/" + secret:
        out.append(name + " has " + file_var + " " + repr(environment.get(file_var)) + ", not /run/secrets/" + secret)
    if env_var in environment:
        out.append(name + " has " + env_var + " in its environment (the secret stays a file)")
    declared = (config.get("secrets") or {}).get(secret) or {}
    want_file = os.path.realpath(os.path.join(project, "secrets", file_name))
    if os.path.realpath(declared.get("file") or "") != want_file:
        out.append("the secret " + secret + " has the file " + repr(declared.get("file")) + ", not secrets/" + file_name)
networks = config.get("networks") or {}
for name, network in (("otelcol-testing", "otelcol-testing"), ("ottl-evaluator", "ottl-evaluator")):
    if (networks.get(network) or {}).get("internal") is not True:
        out.append("the network " + network + " is not internal: true")
    service = services.get(name) or {}
    joined = sorted((service.get("networks") or {}).keys())
    if joined != [network]:
        out.append(name + " is on networks " + repr(joined) + ", not only " + network)
    if service.get("read_only") is not True:
        out.append(name + " is not read_only: true")
    if service.get("cap_drop") != ["ALL"]:
        out.append(name + " has cap_drop " + repr(service.get("cap_drop")) + ", not [ALL]")
    if not set(service.get("security_opt") or []) & {"no-new-privileges:true", "no-new-privileges"}:
        out.append(name + " lacks security_opt no-new-privileges:true")
for name, service in sorted(services.items()):
    if service.get("privileged"):
        out.append(name + " is privileged")
    for namespace in ("pid", "ipc"):
        if service.get(namespace) == "host":
            out.append(name + " shares the host" + chr(39) + "s " + namespace + " namespace")
    for volume in service.get("volumes") or []:
        text = (volume.get("source") or "") + " " + (volume.get("target") or "") if isinstance(volume, dict) else str(volume)
        if "docker.sock" in text:
            out.append(name + " mounts the Docker socket")
if not (services.get("ottl-evaluator") or {}).get("mem_limit"):
    out.append("ottl-evaluator has no mem_limit")
if mailpit == "yes" and "mailpit" not in services:
    out.append("mailpit isn'"'"'t started by .env'"'"'s COMPOSE_PROFILES")
if mailpit == "no" and "mailpit" in services:
    out.append("mailpit is started without --mailpit")
for line in out:
    print(line)
' "$form" "$mailpit" "$version" "$postgres_image" "$nginx_image" "$opamp_image" "$BIND" "$HTTP_PORT" "$AGENT_PORT" \
    "$MAILPIT_PORT" "$work/$form" "$registry" "$scope")" ||
    json_status=$?
  if [ "$json_status" != 0 ]; then
    problem "python3 couldn't read docker compose config's JSON ($label)"
    return
  fi
  if [ -n "$found" ]; then
    while IFS= read -r line; do
      problem "as Compose reads deploy/compose/compose.yaml with setup.sh's .env ($label): $line"
    done <<<"$found"
  fi
}

password_file="$work/relay-password"
(umask 077 && openssl rand -hex 16 >"$password_file") || fatal "couldn't make the relay form's password file"
install_copy mailpit --public-url http://localhost:$HTTP_PORT --agent-url http://localhost:$AGENT_PORT \
  --http-port "$HTTP_PORT" --agent-port "$AGENT_PORT" --bind "$BIND" --mailpit --mailpit-port "$MAILPIT_PORT"
check_install mailpit yes
check_install mailpit yes ""
check_install mailpit yes "$MIRROR"
install_copy relay --public-url https://telflo.example.com --agent-url https://opamp.example.com \
  --http-port "$HTTP_PORT" --agent-port "$AGENT_PORT" --bind "$BIND" \
  --smtp-host smtp.example.com --smtp-port 587 --mail-from telflo@example.com \
  --smtp-username telflo --smtp-password-file "$password_file"
check_install relay no

# Without .env: Compose refuses the file, naming a variable it requires.
install_copy bare
if compose_config "$work/bare" -f "$work/bare/compose.yaml" >/dev/null 2>"$work/bare.err"; then
  problem "Compose reads deploy/compose/compose.yaml without .env: a required setting must be \${NAME:?...}"
else
  missing_name="$(sed -n 's/.*required variable \([A-Z_][A-Z0-9_]*\) is missing a value.*/\1/p' "$work/bare.err" | head -n 1)"
  if [ -z "$missing_name" ]; then
    problem "without .env Compose refused deploy/compose/compose.yaml, but not by naming a required variable"
  else
    echo "check-compose-install: without .env, Compose refuses it, naming $missing_name."
  fi
fi

# ---- the development secrets ---------------------------------------------------------------
listed="$(awk '/^DEVELOPMENT_SECRET_SHA256="$/ { inside = 1; next } inside && /^"$/ { exit } inside { print }' "$SETUP")"
if [ -z "$listed" ]; then
  problem "deploy/compose/setup.sh has no DEVELOPMENT_SECRET_SHA256 list"
fi
if ! compose_config "$ROOT" --env-file /dev/null -f "$ROOT/docker-compose.yml" 2>"$work/dev.err" >"$work/dev.json"; then
  problem "docker compose config refused docker-compose.yml: the development secrets couldn't be read"
else
  printf '%s\n' "$listed" >"$work/listed"
  found="$(python3 -I -c '
import glob, hashlib, json, os, re, sys
root, listed_file, json_file, install = sys.argv[1:5]
config = json.load(open(json_file))
values = {}
def add(value, where):
    if value:
        values.setdefault(value, set()).add(where)
def strip_one(data):
    if data.endswith(b"\r\n"):
        return data[:-2]
    if data.endswith(b"\n"):
        return data[:-1]
    return data
for name, service in sorted(config["services"].items()):
    for key, value in sorted((service.get("environment") or {}).items()):
        if not isinstance(value, str):
            continue
        if re.search(r"(SECRET|PASSWORD|KEY)", key) and not key.endswith("_FILE"):
            add(value, "docker-compose.yml'"'"'s " + name + " " + key)
        for match in re.finditer(r"postgres(?:ql)?://[^:/@]+:([^@]+)@", value):
            add(match.group(1), "the password in docker-compose.yml'"'"'s " + name + " " + key)
files = {os.path.realpath(path) for path in glob.glob(os.path.join(root, "docker", "*", "development-*"))}
for secret in (config.get("secrets") or {}).values():
    if secret.get("file"):
        files.add(os.path.realpath(secret["file"]))
for path in sorted(files):
    add(strip_one(open(path, "rb").read()).decode("utf-8", "surrogateescape"), os.path.relpath(path, root))
listed = {line.strip() for line in open(listed_file) if line.strip()}
digests = {}
for value, where in values.items():
    digests[hashlib.sha256(value.encode("utf-8", "surrogateescape")).hexdigest()] = sorted(where)[0]
for digest, where in sorted(digests.items(), key=lambda item: item[1]):
    if digest not in listed:
        print(where + " isn'"'"'t in setup.sh'"'"'s DEVELOPMENT_SECRET_SHA256")
extra = listed - set(digests)
if extra:
    print("setup.sh'"'"'s DEVELOPMENT_SECRET_SHA256 holds " + str(len(extra)) + " sha256 that no development secret has")
for dirpath, _, filenames in os.walk(install):
    for filename in filenames:
        path = os.path.join(dirpath, filename)
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        rel = os.path.relpath(path, install)
        if rel == ".env" or rel.startswith("secrets" + os.sep):
            continue
        text = open(path, "rb").read()
        if any(value.encode("utf-8", "surrogateescape") in text for value in values):
            print("deploy/compose/" + rel + " holds a development secret'"'"'s value")
print("count " + str(len(digests)))
' "$ROOT" "$work/listed" "$work/dev.json" "$INSTALL")" || problem "python3 couldn't read the development secrets"
  rm -f "$work/dev.json"
  dev_count="$(printf '%s\n' "$found" | sed -n 's/^count //p')"
  while IFS= read -r line; do
    case "$line" in "" | "count "*) ;; *) problem "$line" ;; esac
  done <<<"$found"
fi

if [ "$problems" -ne 0 ]; then
  echo "check-compose-install: FAIL ($problems problem(s))" >&2
  exit 1
fi
echo "check-compose-install: OK: the four copies equal their sources; compose.yaml (name telflo, no build, the Telflo images at $version by tag under \${TELFLO_IMAGE_REGISTRY:-$TELFLO_COMPOSE_IMAGE_DEFAULT} (unset, empty and a mirror's), Postgres, nginx and the opamp-server at their pins, Mailpit by digest under its profile, the two ports on TELFLO_BIND_ADDRESS and Mailpit's on 127.0.0.1 at --mailpit-port's) as text and as Compose reads it with setup.sh's .env in both mail forms; setup.sh's list holds the ${dev_count:-?} development secrets' sha256"
