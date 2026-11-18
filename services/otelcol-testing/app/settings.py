"""The tester's settings, read once, at startup (D14a spec decisions 5 and 30;
Preflight rulings 2 and 4).

The shared secret follows the validator's pattern (ADR 0026, ADR 0027): the
current secret and every previous one are kept for the comparison only as
SHA-256 digests, each secret at least 32 bytes, and a presented token is
compared with all of them in constant time. Unlike the validator's, the
secrets are read from FILES (`OTELCOL_TESTING_SECRET_FILE`, and
`OTELCOL_TESTING_SECRETS_PREVIOUS_FILE` during a rotation), never from the
environment: the collectors and kwok a run starts are execs, which reset the
process's non-dumpable flag (ruling 4), so the secret must be in no
process's environment. Without a readable current secret of 32 bytes or
more the service refuses to start; it refuses as well when the secret is
also in its environment.

The secrets' exact values are also kept, in a `Redactions` object of their
own, for one use: removing them from every answer (ruling 3). Neither
object's repr shows a value or a digest.

The budgets (ruling 2), with d the run's duration (1 to 60 s):

    phase                                   limit
    slot wait                                5 s
    preparation                              2 s
    collector ready                         10 s
    kwok informer                          5.2 s
    replay in total (5 s per POST)          30 s
    hold                                     d
    stop (SIGTERM, 5 s, kill, reap)          6 s
    finish                                   3 s

so a run's process group is killed at its deadline, 57 + d s after its child
started, and a request has 64 + d s in all. The platform's client waits
74 + d s and its lease is 174 + d s (the API's dispatcher; since D15a, which
adds the OTTL evaluator's check, ADR 0028 amended).
"""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

SECRET_FILE_VARIABLE = "OTELCOL_TESTING_SECRET_FILE"
PREVIOUS_SECRETS_FILE_VARIABLE = "OTELCOL_TESTING_SECRETS_PREVIOUS_FILE"
# The secret's value in the environment is refused, never read.
SECRET_VALUE_VARIABLE = "OTELCOL_TESTING_SECRET"
MAX_CONCURRENCY_VARIABLE = "OTELCOL_TESTING_MAX_CONCURRENCY"
BINARY_DIR_VARIABLE = "OTELCOL_BINARY_DIR"
CATALOG_DIR_VARIABLE = "OTELCOL_CATALOG_DIR"

MIN_SECRET_BYTES = 32

# At most this many runs at once (ruling 4): the platform's
# TELFLO_TEST_RUNS_PER_TESTER defaults to the same 4. Each run's collector
# holds about 180 MiB.
DEFAULT_MAX_CONCURRENCY = 4
# A request waits at most this long for a free slot, then answers 503
# tester_busy (ruling 2). Not an environment setting.
DEFAULT_SLOT_WAIT_SECONDS = 5.0
DEFAULT_BINARY_DIR = Path("/opt/otelcol")
# Run from the checkout, the catalogue is the repository's own
# (services/otelcol-testing/app/settings.py -> <repo>/catalog/distributions).
# The image sets OTELCOL_CATALOG_DIR to the copy it carries.
DEFAULT_CATALOG_DIR = Path(__file__).resolve().parents[3] / "catalog" / "distributions"

# The phase limits of ruling 2, in seconds.
PREPARATION_SECONDS = 2.0
COLLECTOR_READY_SECONDS = 10.0
KWOK_INFORMER_SECONDS = 5.2
REPLAY_TOTAL_SECONDS = 30.0
REPLAY_POST_SECONDS = 5.0
STOP_GRACE_SECONDS = 5.0  # SIGTERM, then this long, then SIGKILL
STOP_SECONDS = 6.0
FINISH_SECONDS = 3.0
# kwok's start (Ruling 26): attempts, and the backoff before each retry.
KWOK_START_ATTEMPTS = 3
KWOK_RETRY_BACKOFF_SECONDS: tuple[float, ...] = (2.0, 4.0)
# A run's process group is killed RUN_DEADLINE_BASE_SECONDS + d after its
# child started; a request has REQUEST_BUDGET_BASE_SECONDS + d in all.
RUN_DEADLINE_BASE_SECONDS = 57.0
REQUEST_BUDGET_BASE_SECONDS = 64.0


class SettingsError(ValueError):
    """A setting is missing or malformed. The message names the variable (or
    the file's variable), never a secret's value."""


class Secrets:
    """The accepted shared secrets: the current one and the previous ones,
    still accepted during a rotation.

    Only each secret's SHA-256 digest is kept, so every comparison is between
    two 32-byte digests and its time doesn't depend on the secret's length.
    `accepts` is the only place a presented token meets a secret."""

    __slots__ = ("_digests",)

    def __init__(self, current: str, previous: list[str]) -> None:
        self._digests: tuple[bytes, ...] = tuple(_digest(secret) for secret in [current, *previous])

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


class Redactions:
    """The secrets' exact values, for one use only: `app/scrub.py` replaces
    each with `<redacted>` in every field of an answer (ruling 3), in case a
    run's collector read the secret's file. Never shown by repr."""

    __slots__ = ("_values",)

    def __init__(self, values: list[str]) -> None:
        self._values: tuple[str, ...] = tuple(values)

    def values(self) -> tuple[str, ...]:
        return self._values

    def __repr__(self) -> str:
        return f"Redactions(count={len(self._values)})"


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


def _read_secret_file(variable: str, path: str) -> str:
    """The file's text, as UTF-8. Never the text in an error."""
    try:
        raw = Path(path).read_bytes()
    except OSError as error:
        raise SettingsError(f"{variable}: the file can't be read ({type(error).__name__})") from None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise SettingsError(f"{variable}: the file isn't UTF-8 text") from None


def read_current_secret(environ: Mapping[str, str]) -> str:
    """The current secret: the file's text without its surrounding
    whitespace (a trailing line break). At least 32 bytes."""
    path = (environ.get(SECRET_FILE_VARIABLE) or "").strip()
    if not path:
        raise SettingsError(f"{SECRET_FILE_VARIABLE} is not set")
    secret = _read_secret_file(SECRET_FILE_VARIABLE, path).strip()
    if not secret:
        raise SettingsError(f"{SECRET_FILE_VARIABLE}: the file holds no secret")
    if len(secret.encode("utf-8")) < MIN_SECRET_BYTES:
        raise SettingsError(f"{SECRET_FILE_VARIABLE}: the secret must be at least {MIN_SECRET_BYTES} bytes")
    return secret


def read_previous_secrets(environ: Mapping[str, str]) -> list[str]:
    """The previous secrets, one per line of their file; blank lines are
    skipped. Each is at least 32 bytes. No file named: none."""
    path = (environ.get(PREVIOUS_SECRETS_FILE_VARIABLE) or "").strip()
    if not path:
        return []
    lines = [line.strip() for line in _read_secret_file(PREVIOUS_SECRETS_FILE_VARIABLE, path).splitlines()]
    secrets = [line for line in lines if line]
    for index, secret in enumerate(secrets):
        if len(secret.encode("utf-8")) < MIN_SECRET_BYTES:
            raise SettingsError(
                f"{PREVIOUS_SECRETS_FILE_VARIABLE}: secret {index + 1} of {len(secrets)} "
                f"must be at least {MIN_SECRET_BYTES} bytes"
            )
    return secrets


@dataclass(frozen=True)
class Settings:
    secrets: Secrets = field(repr=False)
    redactions: Redactions = field(repr=False)
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY
    slot_wait_seconds: float = DEFAULT_SLOT_WAIT_SECONDS
    binary_dir: Path = DEFAULT_BINARY_DIR
    catalog_dir: Path = DEFAULT_CATALOG_DIR
    # Ruling 2's arithmetic; only the tests lower them.
    run_deadline_base_seconds: float = RUN_DEADLINE_BASE_SECONDS
    request_budget_base_seconds: float = REQUEST_BUDGET_BASE_SECONDS
    # Ruling 26: kwok's start, three attempts with a backoff before each
    # retry. Not environment settings; only the tests lower them.
    kwok_start_attempts: int = KWOK_START_ATTEMPTS
    kwok_retry_backoff_seconds: tuple[float, ...] = KWOK_RETRY_BACKOFF_SECONDS

    def run_deadline_seconds(self, duration_seconds: int) -> float:
        """When a run's process group is killed: 57 + d s after its child started."""
        return self.run_deadline_base_seconds + duration_seconds

    def request_budget_seconds(self, duration_seconds: int) -> float:
        """A request's whole budget: 64 + d s, the slot wait included."""
        return self.request_budget_base_seconds + duration_seconds

    @classmethod
    def from_environment(cls, environ: Mapping[str, str]) -> Settings:
        if environ.get(SECRET_VALUE_VARIABLE):
            raise SettingsError(
                f"{SECRET_VALUE_VARIABLE} is set: the secret must be in no environment; "
                f"put it in a file named by {SECRET_FILE_VARIABLE}"
            )
        current = read_current_secret(environ)
        previous = read_previous_secrets(environ)
        for secret in (current, *previous):
            if any(secret in value for value in environ.values()):
                raise SettingsError(
                    "a secret is also in the environment: it must be in no environment (D14a Preflight ruling 4)"
                )
        return cls(
            secrets=Secrets(current, previous),
            redactions=Redactions([current, *previous]),
            max_concurrency=_positive_int(environ, MAX_CONCURRENCY_VARIABLE, DEFAULT_MAX_CONCURRENCY),
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
