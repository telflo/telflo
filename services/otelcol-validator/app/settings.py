"""The validator's settings, read from the environment once, at startup.

The shared secret follows the opamp-server's `Secrets`: the current secret
and every previous one are kept only as SHA-256 digests, each at least
32 bytes, and a presented token is compared with all of them in constant
time. Without a current secret the service refuses to start; there is no
opt-out.
"""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

SECRET_VARIABLE = "OTELCOL_VALIDATOR_SECRET"
PREVIOUS_SECRETS_VARIABLE = "OTELCOL_VALIDATOR_SECRETS_PREVIOUS"
MAX_CONCURRENCY_VARIABLE = "OTELCOL_VALIDATOR_MAX_CONCURRENCY"
TIMEOUT_VARIABLE = "OTELCOL_VALIDATE_TIMEOUT"
BINARY_DIR_VARIABLE = "OTELCOL_BINARY_DIR"
CATALOG_DIR_VARIABLE = "OTELCOL_CATALOG_DIR"

MIN_SECRET_BYTES = 32

# At most this many collectors run at once. Each holds roughly 80 MB for up to
# the timeout, so raising it raises the container's memory need with it.
DEFAULT_MAX_CONCURRENCY = 8
# Seconds one `validate` may run before it is killed.
DEFAULT_VALIDATE_TIMEOUT = 10
# A whole check (its child process: the pre-processing, the collector, the
# stderr parse) may run the collector's limit plus this before its process
# group is killed (`app/runner.py` says why 2 s).
DEADLINE_MARGIN_SECONDS = 2
# Seconds a request waits for a free slot before it answers 503 (the wait
# is bounded). Not an environment setting.
DEFAULT_SLOT_WAIT_SECONDS = 5.0
DEFAULT_BINARY_DIR = Path("/opt/otelcol")
# Run from the checkout, the catalog is the repository's own
# (services/otelcol-validator/app/settings.py -> <repo>/catalog/distributions).
# The image sets OTELCOL_CATALOG_DIR to the copy it carries.
DEFAULT_CATALOG_DIR = Path(__file__).resolve().parents[3] / "catalog" / "distributions"


class SettingsError(ValueError):
    """A setting is missing or malformed. The message names the variable,
    never a secret's value."""


class Secrets:
    """The accepted shared secrets: the current one and the previous ones,
    still accepted during a rotation.

    Only each secret's SHA-256 digest is kept, so the text never sits in a
    field a log line or an error could reach, and every comparison is between
    two 32-byte digests, so its time doesn't depend on the secret's length.
    `accepts` is the only place a presented token meets a secret.
    """

    __slots__ = ("_digests",)

    def __init__(self, current: str | None, previous: list[str]) -> None:
        current = (current or "").strip()
        if not current:
            raise SettingsError(f"{SECRET_VARIABLE} is not set")
        if len(current.encode("utf-8")) < MIN_SECRET_BYTES:
            raise SettingsError(f"{SECRET_VARIABLE} must be at least {MIN_SECRET_BYTES} bytes")
        digests = [_digest(current)]
        for index, secret in enumerate(previous):
            secret = secret.strip()
            if len(secret.encode("utf-8")) < MIN_SECRET_BYTES:
                raise SettingsError(
                    f"{PREVIOUS_SECRETS_VARIABLE}: entry {index + 1} of {len(previous)} "
                    f"must be at least {MIN_SECRET_BYTES} bytes"
                )
            digests.append(_digest(secret))
        self._digests: tuple[bytes, ...] = tuple(digests)

    def accepts(self, token: str) -> bool:
        """Whether `token` is one of the secrets. It compares the token with
        every secret, never stopping at a match, so the time it takes doesn't
        say which one matched or whether one did."""
        presented = _digest(token)
        matched = False
        for digest in self._digests:
            matched |= hmac.compare_digest(presented, digest)
        return matched

    def __len__(self) -> int:
        return len(self._digests)

    def __repr__(self) -> str:  # never the digests, let alone the text
        return f"Secrets(count={len(self._digests)})"


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


def split_previous(value: str | None) -> list[str]:
    """OTELCOL_VALIDATOR_SECRETS_PREVIOUS, split on commas. Empty entries (a
    trailing comma, an unset variable) are dropped rather than refused as
    short secrets; a non-empty entry that is too short is refused."""
    if not value:
        return []
    return [entry for entry in value.split(",") if entry.strip()]


@dataclass(frozen=True)
class Settings:
    secrets: Secrets = field(repr=False)
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY
    validate_timeout: int = DEFAULT_VALIDATE_TIMEOUT
    slot_wait_seconds: float = DEFAULT_SLOT_WAIT_SECONDS
    binary_dir: Path = DEFAULT_BINARY_DIR
    catalog_dir: Path = DEFAULT_CATALOG_DIR

    @property
    def check_deadline_seconds(self) -> int:
        """The whole check's deadline: 12 s with the default limit."""
        return self.validate_timeout + DEADLINE_MARGIN_SECONDS

    @classmethod
    def from_environment(cls, environ: Mapping[str, str]) -> Settings:
        secrets = Secrets(environ.get(SECRET_VARIABLE), split_previous(environ.get(PREVIOUS_SECRETS_VARIABLE)))
        return cls(
            secrets=secrets,
            max_concurrency=_positive_int(environ, MAX_CONCURRENCY_VARIABLE, DEFAULT_MAX_CONCURRENCY),
            validate_timeout=_positive_int(environ, TIMEOUT_VARIABLE, DEFAULT_VALIDATE_TIMEOUT),
            binary_dir=Path(environ.get(BINARY_DIR_VARIABLE) or DEFAULT_BINARY_DIR),
            catalog_dir=Path(environ.get(CATALOG_DIR_VARIABLE) or DEFAULT_CATALOG_DIR),
        )


def _positive_int(environ: Mapping[str, str], name: str, default: int) -> int:
    raw = environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        raise SettingsError(f"{name} must be a whole number") from None
    if value < 1:
        raise SettingsError(f"{name} must be at least 1")
    return value
