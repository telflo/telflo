# shellcheck shell=bash
# oci.sh: the release scripts' shared steps for OCI archives and registries.
# Sourced, never run. The caller sets TELFLO_OCI_PREFIX (its messages' prefix)
# and TELFLO_OCI_TMP (a temporary directory of its own) first.
#
#   telflo_registry_ok <registry>        exit 0 for ghcr.io or a loopback
#                                        127.0.0.1:<port> / localhost:<port>
#   telflo_registry_loopback <registry>  exit 0 for a loopback one
#   telflo_namespace_path <namespace>    prints a namespace's repository path
#                                        under the registry: telflo is
#                                        telflo/telflo (the public one, what
#                                        users install), telflo-staging is
#                                        telflo/telflo-staging (a release's
#                                        stage, before it is finalized); exit 1,
#                                        nothing printed, for any other value.
#                                        The release scripts name a repository
#                                        only through it
#   telflo_digests_ok <file>             exit 0 when <file> is a stage's
#                                        digests.txt: exactly one line
#                                        `<name> sha256:<64 hex>` for each name
#                                        of TELFLO_DIGESTS_NAMES, in that order
#                                        (the five images sorted, then the
#                                        chart's OCI manifest digest,
#                                        charts/telflo, and its package's
#                                        sha256, charts/telflo.tgz), each line
#                                        ending in a newline, nothing else
#   telflo_digests_get <file> <name>     prints <name>'s digest from such a file
#   telflo_crane_find <repository root>  sets TELFLO_CRANE: the caller's
#                                        TELFLO_CRANE when set (an executable),
#                                        else tools.sh's checked crane, else
#                                        `crane` on PATH; exit 1 if none. In a
#                                        workflow (CI set, not false/0): only
#                                        tools.sh's crane, checked against
#                                        tools.lock (`tools.sh path`), from the
#                                        repository's own .tools/ (not a link,
#                                        no TELFLO_TOOLS_DIR); a TELFLO_CRANE
#                                        must be that very file
#   telflo_engine_store                  prints `containerd` when the engine keeps
#                                        images in containerd's store (an image's
#                                        id is then its manifest digest), else
#                                        `classic` (the id is the config digest)
#   telflo_remote_digest <ref>           `crane digest`: sets TELFLO_REMOTE_DIGEST
#                                        and returns 0 (present), 3 (absent: the
#                                        registry answered MANIFEST_UNKNOWN or
#                                        NAME_UNKNOWN) or 4 (can't tell; the
#                                        answer's last line in TELFLO_REMOTE_ANSWER).
#                                        Call it as a command, never inside $(…).
#   telflo_remote_manifest <ref> <file>  `crane manifest` into <file>; 0, 3 or 4 alike
#   telflo_oci_inspect <tar> [<digest> [<version> <revision> [attest]]]
#                                        checks an OCI archive (below) and prints
#                                        `index <d>`, `amd64 <manifest> <config>`,
#                                        `arm64 <manifest> <config>`, `attestations <n>`
#   telflo_oci_unpack <tar> <dir> <want> extracts the archive's layout into <dir>
#                                        (new), every blob's sha256 checked, its
#                                        index.json's one entry <want>
#   telflo_credentials <variable> <file>
#                                        a credential file the caller named: refused
#                                        (exit 1, its content never printed) unless
#                                        a JSON object with a non-empty "auths" and
#                                        no credential store or helper in any
#                                        spelling (the publish scripts' rule)
#   telflo_docker_config                 DOCKER_CONFIG: the caller's, checked, or a
#                                        new one with no login in TELFLO_OCI_TMP
#   telflo_digest_decision <status> <remote> <want>
#                                        prints push (absent), skip (the same
#                                        digest) or refuse (another digest, or
#                                        can't tell)
#   telflo_oci_copy <tar> <want> <ref> <version> <revision> [attest]
#                                        the copy: the archive inspected again (as
#                                        it is now, not as it was), the remote
#                                        digest read; absent: the layout unpacked,
#                                        `crane push <layout>
#                                        <ref>` (never --index), the remote digest
#                                        read again and compared, the layout
#                                        deleted; the same digest: skipped with a
#                                        line; another, or can't tell: refused,
#                                        nothing pushed
#
# An archive is accepted only when: its members are `oci-layout`,
# `index.json`, `blobs/`, `blobs/sha256/`, `blobs/sha256/<64 hex>` (regular
# files and folders only; BuildKit's `manifest.json` is allowed and left
# out); index.json has exactly one entry, an OCI image index, whose digest is
# the one given; every blob read (the index, each manifest, each platform's
# config) hashes to its name and has its descriptor's size; the index holds
# exactly one linux/amd64 and one linux/arm64 image (OCI manifests) and, for
# the rest, attestation manifests (unknown/unknown) each naming one of them;
# each image's config carries the version and revision labels given; with
# `attest`, each image has an attestation manifest; and every blob, the
# layers too, hashes to its name (a full read). Messages hold fixed
# words, names and digests only. bash 3.2 compatible.

TELFLO_OCI_DIGEST_RE='^sha256:[0-9a-f]{64}$'

telflo_oci_say() { echo "${TELFLO_OCI_PREFIX:-oci}: $1" >&2; }

telflo_registry_ok() {
  local port
  case "$1" in
    ghcr.io) return 0 ;;
    127.0.0.1:* | localhost:*)
      port="${1#*:}"
      [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$port" -le 65535 ] ;;
    *) return 1 ;;
  esac
}

telflo_registry_loopback() {
  case "$1" in 127.0.0.1:* | localhost:*) telflo_registry_ok "$1" ;; *) return 1 ;; esac
}

# The two namespaces, and nothing else: the public one and a release's stage.
TELFLO_NAMESPACES="telflo telflo-staging"
telflo_namespace_path() {
  case "$1" in
    telflo) echo telflo/telflo ;;
    telflo-staging) echo telflo/telflo-staging ;;
    *) return 1 ;;
  esac
}

# A stage's record: each name once, in this order.
TELFLO_DIGESTS_NAMES="api otelcol-testing otelcol-validator ottl-evaluator web charts/telflo charts/telflo.tgz"
telflo_digests_ok() {
  local file="$1" line n=0 want
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  [ "$(wc -l <"$file" | tr -d ' ')" -eq 7 ] && [ "$(grep -c '' "$file")" -eq 7 ] || return 1
  # shellcheck disable=SC2086 # the names, one argument each
  set -- $TELFLO_DIGESTS_NAMES
  while IFS= read -r line; do
    n=$((n + 1))
    want="$1"
    shift
    [ "${line%% *}" = "$want" ] && [[ "${line#* }" =~ $TELFLO_OCI_DIGEST_RE ]] || return 1
  done <"$file"
  [ "$n" -eq 7 ]
}
telflo_digests_get() { # <file> <name>
  awk -v n="$2" '$1 == n { print $2; exit }' "$1"
}

telflo_resolved() { # <path>: its real path (symlinks resolved)
  python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

telflo_in_ci() { # true in a workflow: CI set to anything but "", false or 0
  case "${CI:-}" in ""|false|0) return 1 ;; *) return 0 ;; esac
}

telflo_crane_find() {
  local found resolved
  if telflo_in_ci; then
    # In a workflow: only the crane tools.sh fetched and checked against
    # tools.lock (`tools.sh path` hashes it again), from the repository's own
    # .tools/ (never TELFLO_TOOLS_DIR, never a .tools that is a link); a
    # TELFLO_CRANE must be that very file.
    if [ -L "$1/.tools" ]; then
      telflo_oci_say "CI: the repository's .tools is a link: refused"
      return 1
    fi
    found="$(env -u TELFLO_TOOLS_DIR "${BASH:-bash}" "$1/scripts/release/tools.sh" path crane 2>/dev/null)" || found=""
    [ -n "$found" ] && [ -x "$found" ] || { telflo_oci_say "CI: no checked crane in .tools/ (scripts/release/tools.sh fetch crane)"; return 1; }
    if [ -n "${TELFLO_CRANE:-}" ]; then
      resolved="$(telflo_resolved "$TELFLO_CRANE")" && [ "$resolved" = "$(telflo_resolved "$found")" ] || {
        telflo_oci_say "CI: TELFLO_CRANE must be tools.sh's checked crane (scripts/release/tools.sh path crane)"
        return 1
      }
    fi
    TELFLO_CRANE="$found"
    return 0
  fi
  if [ -n "${TELFLO_CRANE:-}" ]; then
    [ -x "$TELFLO_CRANE" ] && [ ! -d "$TELFLO_CRANE" ] || return 1
    return 0
  fi
  found="$("${BASH:-bash}" "$1/scripts/release/tools.sh" path crane 2>/dev/null)" || found=""
  if [ -z "$found" ] || [ ! -x "$found" ]; then
    found="$(command -v crane 2>/dev/null)" || found=""
  fi
  [ -n "$found" ] || return 1
  TELFLO_CRANE="$found"
}

# telflo_remote_answer <stderr file> <status>: the classification of a failed
# crane read. The registry's own error codes only: MANIFEST_UNKNOWN or
# NAME_UNKNOWN on crane's final "Error: " line means absent; anything else
# (DENIED, UNAUTHORIZED, a connection refused…) can't tell.
telflo_remote_answer() {
  TELFLO_REMOTE_ANSWER="$(grep -E '^Error: ' "$1" | tail -n 1 | cut -c1-400)"
  [ -n "$TELFLO_REMOTE_ANSWER" ] || TELFLO_REMOTE_ANSWER="$(tail -n 1 "$1" | cut -c1-400)"
  [ -n "$TELFLO_REMOTE_ANSWER" ] || TELFLO_REMOTE_ANSWER="crane exited $2 with no message"
  if printf '%s\n' "$TELFLO_REMOTE_ANSWER" | grep -qE '^Error: .*: (MANIFEST_UNKNOWN|NAME_UNKNOWN): '; then
    return 3
  fi
  return 4
}

telflo_remote_digest() {
  local out status=0
  TELFLO_REMOTE_ANSWER=""
  TELFLO_REMOTE_DIGEST=""
  out="$("$TELFLO_CRANE" digest "$1" 2>"$TELFLO_OCI_TMP/crane-digest.err")" || status=$?
  if [ "$status" -eq 0 ]; then
    if [[ "$out" =~ $TELFLO_OCI_DIGEST_RE ]]; then
      TELFLO_REMOTE_DIGEST="$out"
      return 0
    fi
    TELFLO_REMOTE_ANSWER="crane digest answered something that isn't a digest"
    return 4
  fi
  telflo_remote_answer "$TELFLO_OCI_TMP/crane-digest.err" "$status"
}

telflo_remote_manifest() {
  local status=0
  TELFLO_REMOTE_ANSWER=""
  "$TELFLO_CRANE" manifest "$1" >"$2" 2>"$TELFLO_OCI_TMP/crane-manifest.err" || status=$?
  [ "$status" -ne 0 ] || return 0
  telflo_remote_answer "$TELFLO_OCI_TMP/crane-manifest.err" "$status"
}

telflo_credentials() {
  command -v python3 >/dev/null 2>&1 || { telflo_oci_say "python3 is required to check $1's file"; return 1; }
  [ -f "$2" ] || { telflo_oci_say "$1: its file ($2) is missing"; return 1; }
  local status=0
  python3 -I - "$2" 2>/dev/null <<'PY' || status=$?
import json, sys
try:
    handle = open(sys.argv[1], encoding="utf-8")
except OSError:
    sys.exit(6)
try:
    with handle:
        data = json.load(handle)
except Exception:
    sys.exit(3)
if not isinstance(data, dict):
    sys.exit(4)
for key in data:
    if key in ("credsStore", "credHelpers"):
        sys.exit(5)
    folded = key.casefold()
    if folded in ("credsstore", "credhelpers"):
        sys.exit(5)
    if folded == "auths" and key != "auths":
        sys.exit(7)
auths = data.get("auths")
if not isinstance(auths, dict):
    sys.exit(4)
if not auths:
    sys.exit(8)
PY
  case "$status" in
    0) return 0 ;;
    3) telflo_oci_say "$1: its file ($2) isn't JSON" ;;
    4) telflo_oci_say "$1: its file ($2) has no \"auths\" object" ;;
    5) telflo_oci_say "$1: its file ($2) names a credential store or helper (credsStore or credHelpers, in any spelling): refused, no credential helper is ever consulted" ;;
    6) telflo_oci_say "$1: its file ($2) can't be read" ;;
    7) telflo_oci_say "$1: its file ($2) has a key spelled like \"auths\" that isn't \"auths\"" ;;
    8) telflo_oci_say "$1: its file ($2) has an empty \"auths\" object (Docker would consult a credential helper): it must name the registry's login" ;;
    *) telflo_oci_say "$1: its file ($2) can't be checked" ;;
  esac
  return 1
}

telflo_docker_config() {
  if [ -n "${DOCKER_CONFIG:-}" ]; then
    telflo_credentials DOCKER_CONFIG "$DOCKER_CONFIG/config.json"
    return
  fi
  mkdir "$TELFLO_OCI_TMP/docker" || return 1
  (umask 077 && printf '%s\n' '{"auths":{"telflo-release.invalid":{}}}' >"$TELFLO_OCI_TMP/docker/config.json") || return 1
  export DOCKER_CONFIG="$TELFLO_OCI_TMP/docker"
  telflo_oci_say "DOCKER_CONFIG is unset: a configuration with no login is used"
}

telflo_engine_store() {
  local status
  status="$(docker info --format '{{json .DriverStatus}}' 2>/dev/null)" || status=""
  case "$status" in
    *io.containerd.snapshotter*) echo containerd ;;
    *) echo classic ;;
  esac
}

# The archive's reader (inspect) and extractor (unpack), one Python program.
telflo_oci_python() { # inspect <tar> <want> <version> <revision> <attest> | unpack <tar> <dir>
  python3 -I - "$@" <<'PY'
import hashlib, json, os, re, sys, tarfile

HEX = re.compile(r"[0-9a-f]{64}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
INDEX = "application/vnd.oci.image.index.v1+json"
MANIFEST = "application/vnd.oci.image.manifest.v1+json"
REFERENCE_TYPE = "vnd.docker.reference.type"
REFERENCE_DIGEST = "vnd.docker.reference.digest"
SMALL = 8 * 1024 * 1024

def die(message):
    print(message, file=sys.stderr)
    sys.exit(1)

def name_of(member):
    name = member.name
    while name.startswith("./"):
        name = name[2:]
    return name.rstrip("/")

def members_of(archive):
    found = {}
    for member in archive.getmembers():
        name = name_of(member)
        if name in ("", "blobs", "blobs/sha256"):
            if name and not member.isdir():
                die("the archive's %s isn't a folder" % name)
            continue
        if name in ("oci-layout", "index.json", "manifest.json"):
            pass
        elif name.startswith("blobs/sha256/") and HEX.fullmatch(name[len("blobs/sha256/"):]):
            pass
        else:
            die("the archive holds a member that isn't an OCI layout's (%r)" % name[:120])
        if not member.isreg():
            die("the archive's %s isn't a regular file" % name)
        if name in found:
            die("the archive holds %s twice" % name)
        found[name] = member
    for name in ("oci-layout", "index.json"):
        if name not in found:
            die("the archive has no %s" % name)
    return found

def read(archive, found, name, limit=SMALL):
    member = found.get(name)
    if member is None:
        die("the archive has no %s" % name)
    if member.size > limit:
        die("the archive's %s is larger than expected" % name)
    return archive.extractfile(member).read()

def blob(archive, found, descriptor, what):
    digest = descriptor.get("digest") if isinstance(descriptor, dict) else None
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        die("%s's descriptor has no sha256 digest" % what)
    data = read(archive, found, "blobs/sha256/" + digest[7:])
    if "sha256:" + hashlib.sha256(data).hexdigest() != digest:
        die("%s's blob doesn't hash to %s" % (what, digest))
    if descriptor.get("size") != len(data):
        die("%s's blob isn't its descriptor's size" % what)
    return data

def as_json(data, what):
    try:
        value = json.loads(data)
    except Exception:
        die("%s isn't JSON" % what)
    if not isinstance(value, dict):
        die("%s isn't a JSON object" % what)
    return value

def top_entry(archive, found, want):
    layout = as_json(read(archive, found, "index.json", 1024 * 1024), "index.json")
    entries = layout.get("manifests")
    if layout.get("schemaVersion") != 2 or not isinstance(entries, list) or len(entries) != 1:
        die("index.json must have exactly one entry (found %s)" % (len(entries) if isinstance(entries, list) else "none"))
    top = entries[0]
    if not isinstance(top, dict) or top.get("mediaType") != INDEX:
        die("index.json's entry isn't an OCI image index")
    if want and top.get("digest") != want:
        die("index.json's entry is %s, not %s" % (top.get("digest"), want))
    return top

def hash_all(archive, found):
    # Every blob, the layers too: a corrupt archive is refused before anything is pushed.
    for name, member in sorted(found.items()):
        if not name.startswith("blobs/"):
            continue
        digest = hashlib.sha256()
        source = archive.extractfile(member)
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        if digest.hexdigest() != name.rsplit("/", 1)[1]:
            die("the archive's %s doesn't hash to its name" % name)

def inspect(path, want, version, revision, attest):
    with tarfile.open(path, mode="r:") as archive:
        found = members_of(archive)
        top = top_entry(archive, found, want)
        index = as_json(blob(archive, found, top, "the image index"), "the image index")
        if index.get("mediaType", INDEX) != INDEX or not isinstance(index.get("manifests"), list):
            die("the image index isn't an OCI image index")
        images, references = {}, []
        for entry in index["manifests"]:
            if not isinstance(entry, dict) or entry.get("mediaType") != MANIFEST:
                die("the image index holds an entry that isn't an OCI image manifest")
            platform = entry.get("platform") or {}
            annotations = entry.get("annotations") or {}
            arch, osname = platform.get("architecture"), platform.get("os")
            if annotations.get(REFERENCE_TYPE) == "attestation-manifest":
                if (osname, arch) != ("unknown", "unknown"):
                    die("an attestation manifest has a platform")
                references.append(annotations.get(REFERENCE_DIGEST))
                blob(archive, found, entry, "an attestation manifest")
                continue
            if osname != "linux" or arch not in ("amd64", "arm64") or platform.get("variant") not in (None, "v8") or arch in images:
                die("the image index holds an image other than one linux/amd64 and one linux/arm64 (%s/%s)" % (osname, arch))
            manifest = as_json(blob(archive, found, entry, "the %s manifest" % arch), "the %s manifest" % arch)
            config = as_json(blob(archive, found, manifest.get("config") or {}, "the %s config" % arch), "the %s config" % arch)
            if config.get("architecture") != arch or config.get("os") != "linux":
                die("the %s config names another platform" % arch)
            labels = (config.get("config") or {}).get("Labels") or {}
            if version and labels.get("org.opencontainers.image.version") != version:
                die("the %s image's version label isn't %s" % (arch, version))
            if revision and labels.get("org.opencontainers.image.revision") != revision:
                die("the %s image's revision label isn't %s" % (arch, revision))
            images[arch] = (entry["digest"], manifest["config"]["digest"])
        for arch in ("amd64", "arm64"):
            if arch not in images:
                die("the image index has no linux/%s image" % arch)
        digests = set(d for d, _ in images.values())
        for reference in references:
            if reference not in digests:
                die("an attestation manifest names no image of the index")
        if attest:
            for arch in ("amd64", "arm64"):
                if images[arch][0] not in references:
                    die("the linux/%s image has no attestation manifest" % arch)
        hash_all(archive, found)
        print("index %s" % top["digest"])
        for arch in ("amd64", "arm64"):
            print("%s %s %s" % (arch, images[arch][0], images[arch][1]))
        print("attestations %d" % len(references))

def unpack(path, destination, want):
    if not DIGEST.fullmatch(want):
        die("unpack needs the digest the archive must hold")
    os.mkdir(destination, 0o700)
    os.mkdir(os.path.join(destination, "blobs"), 0o700)
    os.mkdir(os.path.join(destination, "blobs", "sha256"), 0o700)
    with tarfile.open(path, mode="r:") as archive:
        found = members_of(archive)
        # What crane pushes is index.json's one entry: it must be the digest asked for.
        top_entry(archive, found, want)
        for name, member in sorted(found.items()):
            if name == "manifest.json":
                continue
            source = archive.extractfile(member)
            digest = hashlib.sha256()
            target = os.path.join(destination, *name.split("/"))
            with open(target, "xb") as handle:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    handle.write(chunk)
            if name.startswith("blobs/") and digest.hexdigest() != name.rsplit("/", 1)[1]:
                die("the archive's %s doesn't hash to its name" % name)

try:
    if sys.argv[1] == "inspect":
        inspect(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6] == "attest")
    else:
        unpack(sys.argv[2], sys.argv[3], sys.argv[4])
except tarfile.TarError:
    die("the archive isn't a readable tar")
except OSError as error:
    die("the archive can't be read or written (%s)" % error.__class__.__name__)
PY
}

# telflo_oci_run <tar> <python arguments…>: the program, its messages named
# after the archive.
telflo_oci_run() {
  local tar="$1" status=0 line
  shift
  telflo_oci_python "$@" 2>"$TELFLO_OCI_TMP/oci.err" || status=$?
  if [ "$status" -ne 0 ]; then
    while IFS= read -r line; do telflo_oci_say "$(basename -- "$tar"): $line"; done <"$TELFLO_OCI_TMP/oci.err"
  fi
  return "$status"
}

telflo_oci_inspect() { # <tar> [<digest> [<version> <revision> [attest]]]
  [ -f "$1" ] || { telflo_oci_say "$1 is missing"; return 1; }
  telflo_oci_run "$1" inspect "$1" "${2:-}" "${3:-}" "${4:-}" "${5:-}"
}

telflo_oci_unpack() { # <tar> <dir> <want>
  telflo_oci_run "$1" unpack "$1" "$2" "$3"
}

# The one comparison every copy makes: a tag already holding the archive's
# digest is skipped, a tag holding another is never touched.
telflo_digest_decision() { # <telflo_remote_digest status> <remote digest> <want>
  case "$1" in
    3) echo push ;;
    0) if [ "$2" = "$3" ]; then echo skip; else echo refuse; fi ;;
    *) echo refuse ;;
  esac
}

telflo_oci_copy() { # <tar> <want> <ref> <version> <revision> [attest]
  local tar="$1" want="$2" ref="$3" remote status=0 decision layout after after_status=0
  telflo_oci_inspect "$tar" "$want" "$4" "$5" "${6:-}" >/dev/null || { telflo_oci_say "$ref: the archive refused at the copy: nothing pushed"; return 1; }
  telflo_remote_digest "$ref" || status=$?
  remote="$TELFLO_REMOTE_DIGEST"
  decision="$(telflo_digest_decision "$status" "$remote" "$want")"
  case "$decision" in
    skip)
      telflo_oci_say "$ref holds $want already: skipped (the same bytes)"
      return 0 ;;
    refuse)
      if [ "$status" -eq 0 ]; then
        telflo_oci_say "$ref holds $remote, not the archive's $want: refused, nothing pushed (a published tag is never overwritten)"
      else
        telflo_oci_say "can't tell whether $ref exists: $TELFLO_REMOTE_ANSWER"
      fi
      return 1 ;;
  esac
  layout="$TELFLO_OCI_TMP/layout"
  rm -rf "$layout"
  telflo_oci_unpack "$tar" "$layout" "$want" || { rm -rf "$layout"; return 1; }
  telflo_oci_say "pushing $ref ($want)"
  if ! "$TELFLO_CRANE" push "$layout" "$ref" >&2; then
    rm -rf "$layout"
    telflo_oci_say "crane push to $ref failed"
    return 1
  fi
  rm -rf "$layout"
  telflo_remote_digest "$ref" || after_status=$?
  after="$TELFLO_REMOTE_DIGEST"
  if [ "$after_status" -ne 0 ] || [ "$after" != "$want" ]; then
    telflo_oci_say "after the push, $ref answers ${after:-nothing} (${TELFLO_REMOTE_ANSWER:-status $after_status}), not $want"
    return 1
  fi
  telflo_oci_say "$ref is $want"
}
