# shellcheck shell=bash
# shellcheck disable=SC2034 # TR_* are the callers' to read.
# test-registry.sh: shared pieces of the release scripts' self-tests. Sourced
# by *.test.sh only, never by a release script.
#
#   tr_fixture <tar> <version> <revision> <variant> [no-attest]
#       writes an OCI archive made offline (Python, no build): an image index
#       of a linux/amd64 and a linux/arm64 image (tiny layers; the version and
#       revision labels given) and, unless no-attest, an attestation manifest
#       for each; prints its index digest. The same arguments make the same
#       bytes; another <variant>, another digest.
#   tr_tamper <tar> flip-layer|two-entries|manifest-list|other-entry <digest>
#       rewrites an archive in place: one byte of its largest layer flipped
#       (the name kept); index.json with a second entry; index.json's entry
#       typed as a Docker manifest list; or index.json's entry naming
#       <digest> (an archive swapped for another's index)
#   tr_put <tar> <ref> <crane> <DOCKER_CONFIG>
#       pushes the archive's layout as the release does (oci.sh's checked
#       unpack, then `crane push <layout> <ref>`), for a test's setup
#   tr_tools <root>
#       sets TR_CRANE (tools.sh's checked crane, else PATH) and
#       TR_REGISTRY_IMAGE (tools.lock's registry, which must be local by its
#       digest: never pulled here); returns 1 with TR_SKIP set when docker,
#       crane or the image is missing (the caller prints SKIP lines).
#   tr_registry_start <work dir>
#       starts a throwaway registry:2 on 127.0.0.1 (the container
#       ${TELFLO_TEST_REGISTRY_NAME:-telflo-test-registry-<pid>}, the port
#       ${TELFLO_TEST_REGISTRY_PORT:-a free one the system hands out}, fixed:
#       Docker Desktop's engine can't reach an ephemeral published port); with
#       `htpasswd` on PATH
#       it requires a login whose password is made at run time (0600, never
#       on argv or printed): TR_AUTH=1, TR_CONFIG a DOCKER_CONFIG folder
#       holding that login (also a HELM_REGISTRY_CONFIG file), TR_PATTERNS a
#       file of its secret forms for tr_secret_in. Sets TR_REGISTRY
#       (127.0.0.1:<port>).
#   tr_registry_stop    removes the container (and its volume)
#   tr_secret_in <path>...
#       exit 0 when any file under the paths holds the registry's password or
#       its base64 login (a boolean: nothing printed)
#
# Every docker call here is TR_DOCKER's (the real docker, when a test puts a
# stand-in first on PATH), with TR_DOCKER_CONFIG (a stub of the work folder,
# no login). bash 3.2 compatible.

tr_fixture() { # <tar> <version> <revision> <variant> [no-attest]
  python3 -I - "$@" <<'PY'
import gzip, hashlib, io, json, sys, tarfile
path, version, revision, variant = sys.argv[1:5]
attest = not (len(sys.argv) > 5 and sys.argv[5] == "no-attest")
blobs = {}
def blob(data):
    digest = "sha256:" + hashlib.sha256(data).hexdigest()
    blobs[digest] = data
    return digest, len(data)
def js(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
entries = []
for arch in ("amd64", "arm64"):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as layer:
        body = ("fixture %s %s %s %s\n" % (version, revision, variant, arch)).encode()
        info = tarfile.TarInfo("fixture.txt"); info.size = len(body); info.mtime = 0; info.mode = 0o644
        layer.addfile(info, io.BytesIO(body))
    raw = raw.getvalue()
    packed = io.BytesIO()
    with gzip.GzipFile(fileobj=packed, mode="wb", mtime=0) as handle:
        handle.write(raw)
    layer_digest, layer_size = blob(packed.getvalue())
    config = {"architecture": arch, "os": "linux", "created": "1970-01-01T00:00:00Z",
              "config": {"Labels": {"org.opencontainers.image.version": version,
                                    "org.opencontainers.image.revision": revision}},
              "rootfs": {"type": "layers", "diff_ids": ["sha256:" + hashlib.sha256(raw).hexdigest()]},
              "history": [{"created": "1970-01-01T00:00:00Z", "created_by": "telflo test fixture"}]}
    config_digest, config_size = blob(js(config))
    manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_digest, "size": config_size},
                "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": layer_digest, "size": layer_size}]}
    digest, size = blob(js(manifest))
    entries.append({"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": digest, "size": size,
                    "platform": {"architecture": arch, "os": "linux"}})
if attest:
    for image in list(entries):
        statement = js({"_type": "https://in-toto.io/Statement/v0.1", "predicateType": "https://slsa.dev/provenance/v0.2",
                        "subject": [{"name": "fixture", "digest": {"sha256": image["digest"][7:]}}],
                        "predicate": {"variant": variant}})
        statement_digest, statement_size = blob(statement)
        config_digest, config_size = blob(js({"architecture": "unknown", "os": "unknown", "config": {},
                                              "rootfs": {"type": "layers", "diff_ids": [statement_digest]}}))
        manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_digest, "size": config_size},
                    "layers": [{"mediaType": "application/vnd.in-toto+json", "digest": statement_digest, "size": statement_size,
                                "annotations": {"in-toto.io/predicate-type": "https://slsa.dev/provenance/v0.2"}}]}
        digest, size = blob(js(manifest))
        entries.append({"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": digest, "size": size,
                        "platform": {"architecture": "unknown", "os": "unknown"},
                        "annotations": {"vnd.docker.reference.digest": image["digest"],
                                        "vnd.docker.reference.type": "attestation-manifest"}})
index_digest, index_size = blob(js({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": entries}))
files = [("oci-layout", b'{"imageLayoutVersion":"1.0.0"}'),
         ("index.json", js({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
                            "manifests": [{"mediaType": "application/vnd.oci.image.index.v1+json",
                                           "digest": index_digest, "size": index_size}]}))]
files += [("blobs/sha256/" + d[7:], data) for d, data in sorted(blobs.items())]
with tarfile.open(path, mode="w", format=tarfile.PAX_FORMAT) as archive:
    for folder in ("blobs", "blobs/sha256"):
        info = tarfile.TarInfo(folder); info.type = tarfile.DIRTYPE; info.mode = 0o755; info.mtime = 0
        archive.addfile(info)
    for name, data in files:
        info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644; info.mtime = 0
        archive.addfile(info, io.BytesIO(data))
print(index_digest)
PY
}

tr_tamper() { # <tar> <how> [<digest>]
  python3 -I - "$@" <<'PY'
import io, json, sys, tarfile
path, how = sys.argv[1], sys.argv[2]
with tarfile.open(path, mode="r:") as archive:
    members = [(m, archive.extractfile(m).read() if m.isreg() else None) for m in archive.getmembers()]
out = []
if how == "flip-layer":
    # A layer: the largest gzip blob (manifests and configs are JSON).
    largest = max((i for i, (m, d) in enumerate(members) if d is not None and m.name.startswith("blobs/") and d[:2] == b"\x1f\x8b"), key=lambda i: len(members[i][1]))
for i, (member, data) in enumerate(members):
    if data is not None and how == "flip-layer" and i == largest:
        data = bytes([data[0] ^ 1]) + data[1:]
    if data is not None and member.name == "index.json" and how != "flip-layer":
        layout = json.loads(data)
        entry = layout["manifests"][0]
        if how == "two-entries":
            layout["manifests"].append(dict(entry))
        elif how == "manifest-list":
            entry["mediaType"] = "application/vnd.docker.distribution.manifest.list.v2+json"
        elif how == "other-entry":
            entry["digest"] = sys.argv[3]
        data = json.dumps(layout).encode()
    out.append((member, data))
with tarfile.open(path, mode="w", format=tarfile.PAX_FORMAT) as archive:
    for member, data in out:
        if data is None:
            archive.addfile(member)
        else:
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
PY
}

tr_put() { # <tar> <ref> <crane> <DOCKER_CONFIG>
  local want layout
  want="$(tar -xOf "$1" index.json | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["manifests"][0]["digest"])')" || return 1
  layout="$(mktemp -d "${TMPDIR:-/tmp}/tr-put.XXXXXX")" && rmdir "$layout" || return 1
  TELFLO_OCI_PREFIX=tr_put TELFLO_OCI_TMP="$(dirname "$layout")" "${BASH:-bash}" -c '. "$1"; telflo_oci_unpack "$2" "$3" "$4"' _ \
    "$TR_ROOT/scripts/release/oci.sh" "$1" "$layout" "$want" || { rm -rf "$layout"; return 1; }
  DOCKER_CONFIG="$4" "$3" push "$layout" "$2" >/dev/null 2>&1
  local status=$?
  rm -rf "$layout"
  return "$status"
}

tr_tools() { # <root>
  TR_SKIP=""
  TR_ROOT="$1"
  TR_CRANE="$("${BASH:-bash}" "$1/scripts/release/tools.sh" path crane 2>/dev/null)" || TR_CRANE=""
  [ -n "$TR_CRANE" ] || TR_CRANE="$(command -v crane 2>/dev/null)" || TR_CRANE=""
  [ -n "$TR_CRANE" ] || { TR_SKIP="no crane (scripts/release/tools.sh fetch crane)"; return 1; }
  command -v "${TR_DOCKER:-docker}" >/dev/null 2>&1 || { TR_SKIP="no docker"; return 1; }
  TR_REGISTRY_IMAGE="$("${BASH:-bash}" "$1/scripts/release/tools.sh" ref registry 2>/dev/null)" || TR_REGISTRY_IMAGE=""
  [ -n "$TR_REGISTRY_IMAGE" ] || { TR_SKIP="tools.lock names no registry image"; return 1; }
  DOCKER_CONFIG="$TR_DOCKER_CONFIG" "${TR_DOCKER:-docker}" image inspect "$TR_REGISTRY_IMAGE" >/dev/null 2>&1 \
    || { TR_SKIP="the registry image isn't local (scripts/release/tools.sh pull registry)"; return 1; }
}

tr_registry_start() { # <work dir>
  local work="$1" name port publish answer i
  name="${TELFLO_TEST_REGISTRY_NAME:-telflo-test-registry-$$}"
  port="${TELFLO_TEST_REGISTRY_PORT:-}"
  [ -n "$port" ] || port="$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')" || return 1
  publish="127.0.0.1:$port:5000"
  TR_CONTAINER="$name"
  TR_AUTH=0
  (umask 077 && mkdir -p "$work/cred/docker" "$work/cred/auth") || return 1
  if command -v htpasswd >/dev/null 2>&1; then
    (umask 077 && head -c 24 /dev/urandom | base64 | tr -d '/+=\n' >"$work/cred/password") || return 1
    htpasswd -niB telflo-test <"$work/cred/password" >"$work/cred/auth/htpasswd" 2>/dev/null || return 1
    chmod 644 "$work/cred/auth/htpasswd"; chmod 755 "$work/cred/auth"
    TR_AUTH=1
    DOCKER_CONFIG="$TR_DOCKER_CONFIG" "${TR_DOCKER:-docker}" create --name "$name" --pull never -p "$publish" \
      -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=telflo-test \
      -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd "$TR_REGISTRY_IMAGE" >/dev/null || return 1
    DOCKER_CONFIG="$TR_DOCKER_CONFIG" "${TR_DOCKER:-docker}" cp "$work/cred/auth" "$name:/auth" >/dev/null || return 1
  else
    DOCKER_CONFIG="$TR_DOCKER_CONFIG" "${TR_DOCKER:-docker}" create --name "$name" --pull never -p "$publish" "$TR_REGISTRY_IMAGE" >/dev/null || return 1
  fi
  DOCKER_CONFIG="$TR_DOCKER_CONFIG" "${TR_DOCKER:-docker}" start "$name" >/dev/null || return 1
  TR_REGISTRY="$(DOCKER_CONFIG="$TR_DOCKER_CONFIG" "${TR_DOCKER:-docker}" port "$name" 5000/tcp | grep -E '^127\.0\.0\.1:[0-9]+$' | head -n 1)"
  [ -n "$TR_REGISTRY" ] || return 1
  # The login, written by Python from the password file: never on argv.
  python3 -I - "$work/cred/password" "$TR_REGISTRY" "$work/cred/docker/config.json" "$work/cred/patterns" "$TR_AUTH" <<'PY' || return 1
import base64, json, os, sys
password_file, registry, config, patterns, auth = sys.argv[1:6]
entry = {}
lines = []
if auth == "1":
    password = open(password_file).read().strip()
    login = base64.b64encode(("telflo-test:" + password).encode()).decode()
    entry = {"auth": login}
    lines = [password, login]
for path, text in ((config, json.dumps({"auths": {registry: entry}})), (patterns, "\n".join(lines) + "\n")):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(text)
PY
  TR_CONFIG="$work/cred/docker"
  TR_PATTERNS="$work/cred/patterns"
  for i in $(seq 1 100); do
    answer="$(curl -s -o /dev/null -w '%{http_code}' "http://$TR_REGISTRY/v2/" 2>/dev/null)" || answer=""
    case "$answer" in 200 | 401) return 0 ;; esac
    [ "$i" -lt 100 ] && sleep 0.1
  done
  return 1
}

tr_registry_stop() {
  [ -n "${TR_CONTAINER:-}" ] || return 0
  DOCKER_CONFIG="$TR_DOCKER_CONFIG" "${TR_DOCKER:-docker}" rm -f -v "$TR_CONTAINER" >/dev/null 2>&1
  TR_CONTAINER=""
}

tr_secret_in() { # <path>...
  [ "${TR_AUTH:-0}" = 1 ] || return 1
  grep -rqF -f "$TR_PATTERNS" -- "$@" 2>/dev/null
}

# tr_crane_wrapper <bin dir> <log dir> <real crane>: a `crane` first on PATH
# that records every call (crane-calls.log, all-crane-calls.log, and the
# DOCKER_CONFIG it got in crane-config.log) and hands it to the real crane,
# or, with STANDIN_CRANE set, answers `digest` and `manifest` itself:
# absent (MANIFEST_UNKNOWN), name-unknown (NAME_UNKNOWN), denied (DENIED,
# with a second line), present (STANDIN_DIGEST, or a fixed digest; a chart
# manifest whose layer is STANDIN_DIGEST); anything else it refuses (97).
tr_crane_wrapper() {
  printf '#!/bin/bash\nlog="%s"\nreal="%s"\n' "$2" "$3" >"$1/crane"
  cat >>"$1/crane" <<'WRAPPER'
{ printf '%q ' "$@"; echo; } >>"$log/crane-calls.log"
{ printf '%q ' "$@"; echo; } >>"$log/all-crane-calls.log"
printf '%s\n' "${DOCKER_CONFIG:-unset}" >>"$log/crane-config.log"
[ -n "${STANDIN_CRANE:-}" ] || exec "$real" "$@"
case "$1:$STANDIN_CRANE" in
  digest:absent | manifest:absent)
    echo "Error: GET https://registry.invalid/v2/x/manifests/t: MANIFEST_UNKNOWN: manifest unknown; map[Tag:t]" >&2; exit 1 ;;
  digest:name-unknown | manifest:name-unknown)
    echo "Error: GET https://registry.invalid/v2/x/manifests/t: NAME_UNKNOWN: repository name not known to registry" >&2; exit 1 ;;
  digest:denied | manifest:denied)
    echo "2026/01/01 00:00:00 No matching credentials were found" >&2
    echo "Error: GET https://registry.invalid/token?scope=x: DENIED: requested access to the resource is denied" >&2; exit 1 ;;
  digest:present) echo "${STANDIN_DIGEST:-sha256:1111111111111111111111111111111111111111111111111111111111111111}"; exit 0 ;;
  manifest:present)
    printf '{"schemaVersion":2,"config":{"mediaType":"application/vnd.cncf.helm.config.v1+json","digest":"sha256:%s","size":1},"layers":[{"mediaType":"application/vnd.cncf.helm.chart.content.v1.tar+gzip","digest":"%s","size":1}]}\n' \
      2222222222222222222222222222222222222222222222222222222222222222 "${STANDIN_DIGEST:-sha256:1111111111111111111111111111111111111111111111111111111111111111}"
    exit 0 ;;
esac
echo "UNEXPECTED crane $*" >>"$log/crane-calls.log"
echo "UNEXPECTED crane $*" >>"$log/all-crane-calls.log"
exit 97
WRAPPER
  chmod +x "$1/crane"
}
