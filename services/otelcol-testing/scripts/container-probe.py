"""Run INSIDE the running tester's container (scripts/check-container.sh pipes
it to `python -`): checks that the container is locked down, from where a
run's collector sits.

- It runs as uid 10001, not root.
- No Linux capabilities (compose's `cap_drop: [ALL]`: the bounding set is
  empty, not only the effective one) and no privilege gained through exec
  (`no-new-privileges`), for this process, PID 1 (tini) and the service's
  process alike.
- The root filesystem is read-only (mounted `ro`; writing to /, /app and
  /opt fails with EROFS), while /tmp and the home directory are writable
  tmpfs mounted `noexec`, and the collectors and kwok under /opt
  are root's and unwritable.
- No route out: external names don't resolve, and external addresses don't
  answer (each connection attempt fails or times out).
- The secret is in no environment: not in this process's, and not in any
  process's whose environment it can read; the service's own process can't
  be read at all (`PR_SET_DUMPABLE` 0: its /proc environ is refused).

It prints one line per check, `ok <check>` or `FAIL <check>: <why>`, never
the secret, and exits 1 if any check failed. Only the standard library.
"""

from __future__ import annotations

import errno
import os
import socket
import sys
from pathlib import Path

SECRET_FILE = os.environ.get("OTELCOL_TESTING_SECRET_FILE", "")
# Addresses that answer from any network with a route out (Cloudflare's
# and Google's resolvers, GitHub), and names that resolve from any.
EXTERNAL_ADDRESSES = (("1.1.1.1", 443), ("8.8.8.8", 53), ("140.82.112.3", 443))
EXTERNAL_NAMES = ("example.com", "github.com", "dl.k8s.io")
CONNECT_SECONDS = 3.0

failures: list[str] = []


def check(name: str, passed: bool, why: str = "") -> None:
    print(f"ok {name}" if passed else f"FAIL {name}: {why}", flush=True)
    if not passed:
        failures.append(name)


def write_refused(directory: str) -> tuple[bool, str]:
    path = os.path.join(directory, f".probe-{os.getpid()}")
    try:
        with open(path, "x"):
            pass
    except OSError as error:
        return error.errno == errno.EROFS, f"{errno.errorcode.get(error.errno, error.errno)}"
    os.unlink(path)
    return False, "the write succeeded"


def write_allowed(directory: str) -> tuple[bool, str]:
    path = os.path.join(directory, f".probe-{os.getpid()}")
    try:
        with open(path, "x"):
            pass
        os.unlink(path)
    except OSError as error:
        return False, f"{errno.errorcode.get(error.errno, error.errno)}"
    return True, ""


def mount_fields(mountpoint: str) -> list[str]:
    """The mount at ``mountpoint`` that is in effect: the LAST matching line
    of /proc/self/mounts (a later mount over the same point hides the
    earlier ones)."""
    found: list[str] = []
    for line in Path("/proc/self/mounts").read_text().splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[1] == mountpoint:
            found = fields
    return found


def mount_options(mountpoint: str) -> list[str]:
    fields = mount_fields(mountpoint)
    return fields[3].split(",") if fields else []


def mount_type(mountpoint: str) -> str:
    fields = mount_fields(mountpoint)
    return fields[2] if fields else ""


# --- the user -----------------------------------------------------------------
check("runs as uid 10001", os.getuid() == 10001 and os.geteuid() == 10001, f"uid {os.getuid()}")

# --- capabilities and no-new-privileges ----------------------------
CAPABILITY_SETS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")


def status_fields(pid: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        name, _, value = line.partition(":")
        fields[name] = value.strip()
    return fields


def locked_down(pid: str) -> tuple[bool, str]:
    try:
        fields = status_fields(pid)
    except OSError as error:
        return False, type(error).__name__
    held = [f"{name} {fields.get(name)}" for name in CAPABILITY_SETS if int(fields.get(name, "1"), 16) != 0]
    if fields.get("NoNewPrivs") != "1":
        held.append(f"NoNewPrivs {fields.get('NoNewPrivs')}")
    return not held, ", ".join(held)


for label, pid in (("this process", "self"), ("PID 1 (tini)", "1")):
    passed, why = locked_down(pid)
    check(f"{label} holds no capability and has no-new-privileges", passed, why)

# --- the filesystem -----------------------------------------------------------
check("the root filesystem is mounted read-only", "ro" in mount_options("/"), ",".join(mount_options("/")))
for directory in ("/", "/app", "/app/services/otelcol-testing", "/opt/otelcol", "/opt/kwok", "/etc"):
    refused, why = write_refused(directory)
    check(f"writing to {directory} is refused (read-only)", refused, why)
home = os.path.expanduser("~")
for directory in ("/tmp", home):
    allowed, why = write_allowed(directory)
    options = mount_options(directory)
    check(f"{directory} is a writable tmpfs", allowed and bool(options), why or "not a mount point")
    # Nothing a run writes there can be executed.
    check(
        f"{directory} is a tmpfs mounted noexec",
        mount_type(directory) == "tmpfs" and "noexec" in options,
        f"{mount_type(directory) or 'no mount'} {','.join(options)}",
    )
binaries = [*Path("/opt/otelcol").glob("v*/otelcol-contrib"), *Path("/opt/kwok").glob("v*/*")]
check("the image holds collectors and kwok under /opt", len(binaries) >= 6, f"{len(binaries)} binaries")
writable = [str(path) for path in binaries if path.stat().st_uid != 0 or os.access(path, os.W_OK)]
check("every binary under /opt is root's and read-only to the service", writable == [], ", ".join(writable))

# --- the network --------------------------------------------------------------
for name in EXTERNAL_NAMES:
    try:
        resolved = socket.getaddrinfo(name, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        check(f"{name} doesn't resolve", True)
        continue
    check(f"{name} doesn't resolve", False, f"resolved to {sorted({entry[4][0] for entry in resolved})}")
for host, port in EXTERNAL_ADDRESSES:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(CONNECT_SECONDS)
    try:
        probe.connect((host, port))
    except OSError:  # a timeout, or the network unreachable
        check(f"{host}:{port} doesn't answer", True)
    else:
        check(f"{host}:{port} doesn't answer", False, "connected")
    finally:
        probe.close()
# (An internal network still gives the container a default route, through its
# bridge's address; Docker drops what would leave by it. The connections above
# are the proof, not the route table.)

# --- the secret ---------------------------------------------------------------
try:
    secret = Path(SECRET_FILE).read_text(encoding="utf-8").strip()
except OSError as error:
    secret = ""
    check("the secret's file is readable", False, f"{SECRET_FILE or 'OTELCOL_TESTING_SECRET_FILE unset'}: {type(error).__name__}")
else:
    check("the secret's file is readable", len(secret.encode()) >= 32, "shorter than 32 bytes")
if secret:
    check("the secret is in no variable of this process", not any(secret in value for value in os.environ.values()), "found")
    unreadable: list[int] = []
    leaked: list[int] = []
    service: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
        except OSError:
            continue
        # The service (tini, PID 1, carries the same words in its own
        # command line, and is dumpable: it never reads the secret).
        if "uvicorn app.main:app" in command and not command.startswith("/usr/local/bin/tini"):
            service.append(int(entry.name))
        try:
            environ = (entry / "environ").read_bytes()
        except PermissionError:
            unreadable.append(int(entry.name))
            continue
        except OSError:
            continue
        if secret.encode() in environ:
            leaked.append(int(entry.name))
    check("the secret is in no readable process environment", leaked == [], f"in the environment of {leaked}")
    check("the service's process is running", len(service) == 1, f"{len(service)} found")
    for pid in service:
        passed, why = locked_down(str(pid))
        check("the service's process holds no capability and has no-new-privileges", passed, why)
    check(
        "the service's process is not dumpable (its environ is refused)",
        bool(service) and all(pid in unreadable for pid in service),
        "its /proc/<pid>/environ was readable",
    )

print(f"{len(failures)} check(s) failed" if failures else "every check passed", flush=True)
sys.exit(1 if failures else 0)
