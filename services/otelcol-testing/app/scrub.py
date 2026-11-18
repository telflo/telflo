"""What a run's answer must never hold, replaced in every field of it (D14a
spec decision 5; Preflight ruling 3): raw stderr and absolute workspace
paths never reach the person.

- **The run's workspace**: each file the run writes there (`<sandbox/config>`,
  `<sandbox/input>`, `<sandbox/output>`), then the directory itself
  (`<sandbox>`), as given and as resolved (macOS's /var is /private/var).
- **kwok's kubeconfig** (`<kubeconfig>`), which a Kubernetes processor's
  errors name.
- **The service's own directories** (`<tester>`): its code, the collectors'
  directory, the catalogue, and its home (where kwok keeps its cluster).
  A directory of fewer than two path segments (`/`, `/root`) is left alone:
  replacing it would mangle the person's own data.
- **The shared secret's exact value**, current and previous (`<redacted>`),
  as it is and as a JSON string spells it, in case a run's collector read
  the secret's file. Only the service knows it (the run's child never
  holds the secret), so only the service's scrub replaces it.

The replacement is targeted (only paths the tester itself passes to a run
can appear), rather than a broad sweep that could redact a
person's own `/tmp/…` strings. Secrets go first, then the longest paths, so
a replacement never leaves a recognisable part of a longer one behind.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

SANDBOX = "<sandbox>"
KUBECONFIG = "<kubeconfig>"
TESTER = "<tester>"
REDACTED = "<redacted>"

# The files a run writes in its workspace, and what each becomes.
WORKSPACE_FILES: tuple[tuple[str, str], ...] = (
    ("config.yaml", "<sandbox/config>"),
    ("input.raw", "<sandbox/input>"),
    ("input.data", "<sandbox/input>"),
    ("input.log", "<sandbox/input>"),
    ("output.data", "<sandbox/output>"),
)

_MIN_SERVICE_DIR_SEGMENTS = 2


def _spellings(path: str) -> list[str]:
    """A path as given and as resolved, without a trailing slash."""
    given = path.rstrip("/") or path
    found = {given}
    try:
        found.add(os.path.realpath(given))
    except OSError:  # pragma: no cover - realpath doesn't raise on a missing path
        pass
    return sorted(found, key=len, reverse=True)


def _segments(path: str) -> int:
    return len([part for part in path.split("/") if part])


@dataclass(frozen=True)
class Scrub:
    """The replacements for one run's answer, in the order they apply."""

    # Never in a repr: the pairs hold the secrets' exact values (Ruling 27).
    pairs: tuple[tuple[str, str], ...] = field(default=(), repr=False)

    @classmethod
    def for_run(
        cls,
        *,
        workspace: str | None = None,
        kubeconfig: str | None = None,
        service_dirs: Iterable[str] = (),
        secrets: Iterable[str] = (),
    ) -> Scrub:
        pairs: list[tuple[str, str]] = []
        secret_spellings: set[str] = set()
        for secret in secrets:
            if secret:
                secret_spellings.add(secret)
                secret_spellings.add(json.dumps(secret, ensure_ascii=False)[1:-1])
                secret_spellings.add(json.dumps(secret)[1:-1])
        pairs += [(value, REDACTED) for value in sorted(secret_spellings, key=len, reverse=True)]
        if workspace:
            roots = _spellings(workspace)
            pairs += [(f"{root}/{name}", placeholder) for root in roots for name, placeholder in WORKSPACE_FILES]
            pairs += [(root, SANDBOX) for root in roots]
        if kubeconfig:
            pairs += [(path, KUBECONFIG) for path in _spellings(kubeconfig)]
        directories = {
            spelling
            for directory in service_dirs
            if directory
            for spelling in _spellings(directory)
            if _segments(spelling) >= _MIN_SERVICE_DIR_SEGMENTS
        }
        pairs += [(directory, TESTER) for directory in sorted(directories, key=len, reverse=True)]
        return cls(pairs=tuple(pairs))

    def text(self, value: str) -> str:
        for needle, replacement in self.pairs:
            if needle in value:
                value = value.replace(needle, replacement)
        return value

    def data(self, value: bytes) -> bytes:
        for needle, replacement in self.pairs:
            encoded = needle.encode("utf-8", "surrogatepass")
            if encoded in value:
                value = value.replace(encoded, replacement.encode("utf-8"))
        return value

    def value(self, value: object) -> object:
        """Every string in a JSON-like value (keys too), scrubbed."""
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.value(item) for item in value]
        if isinstance(value, dict):
            return {self.text(key) if isinstance(key, str) else key: self.value(item) for key, item in value.items()}
        return value


def scrub_stderr(
    stderr: str,
    *,
    workspace_root: Path | None = None,
    kubeconfig_path: Path | None = None,
) -> str:
    """The name the security tests use (S6): ``stderr`` with
    the run's workspace (its files first) and kwok's kubeconfig replaced, by
    this module's ``Scrub``. Passing ``None`` for either skips that group."""
    if not stderr:
        return stderr
    return Scrub.for_run(
        workspace=str(workspace_root) if workspace_root is not None else None,
        kubeconfig=str(kubeconfig_path) if kubeconfig_path is not None else None,
    ).text(stderr)
