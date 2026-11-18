"""The shared secret (D13b spec decision 11, ADR 0026's pattern): a bearer
token compared in constant time with OTELCOL_VALIDATOR_SECRET and each of
OTELCOL_VALIDATOR_SECRETS_PREVIOUS; no secret, no start."""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import settings as settings_module
from app.main import create_app
from app.settings import Secrets, Settings, SettingsError, split_previous
from tests.conftest import PREVIOUS_SECRET, SECRET, VALIDATE_URL, auth_headers, call_asgi, make_settings

BODY = {"yaml": "receivers:\n  otlp:\n"}


def test_a_request_without_the_header_is_401(client: TestClient) -> None:
    resp = client.post(VALIDATE_URL, json=BODY)

    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"
    assert resp.json() == {"error": {"code": "unauthorized", "message": "Missing or invalid credentials."}}


def test_a_wrong_secret_is_401(client: TestClient) -> None:
    resp = client.post(VALIDATE_URL, json=BODY, headers=auth_headers("x" * 40))

    assert resp.status_code == 401


def test_the_secret_in_another_scheme_is_401(client: TestClient) -> None:
    for header in (f"Basic {SECRET}", SECRET, f"Bearer{SECRET}", "Bearer "):
        resp = client.post(VALIDATE_URL, json=BODY, headers={"Authorization": header})
        assert resp.status_code == 401, header


def test_a_prefix_or_extension_of_the_secret_is_401(client: TestClient) -> None:
    for token in (SECRET[:-1], SECRET + "x", SECRET.upper()):
        resp = client.post(VALIDATE_URL, json=BODY, headers=auth_headers(token))
        assert resp.status_code == 401, token


def test_the_current_secret_is_accepted(client: TestClient) -> None:
    resp = client.post(VALIDATE_URL, json=BODY, headers=auth_headers(SECRET))

    assert resp.status_code == 200


def test_a_previous_secret_is_accepted(client: TestClient) -> None:
    resp = client.post(VALIDATE_URL, json=BODY, headers=auth_headers(PREVIOUS_SECRET))

    assert resp.status_code == 200


def test_the_scheme_is_case_insensitive(client: TestClient) -> None:
    resp = client.post(VALIDATE_URL, json=BODY, headers={"Authorization": f"bearer {SECRET}"})

    assert resp.status_code == 200


def test_every_path_but_health_answers_the_same_401(client: TestClient) -> None:
    """Unauthenticated, an unknown path, a wrong method and the route all
    answer the same 401, so the routes can't be probed."""
    answers = [
        client.post(VALIDATE_URL, json=BODY),
        client.get("/validator/v1/distributions"),
        client.get("/nothing-here"),
        client.delete(VALIDATE_URL),
    ]
    assert {resp.status_code for resp in answers} == {401}
    assert len({resp.text for resp in answers}) == 1


def test_health_needs_no_secret(client: TestClient) -> None:
    resp = client.get("/health")

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


async def test_an_unauthenticated_request_is_refused_before_its_body_is_read(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(app, "POST", VALIDATE_URL, {}, [b'{"yaml": "x"}'], forbid_body=True)

    assert result.status == 401


# ---------------------------------------------------------------------------
# Settings: no secret, no start
# ---------------------------------------------------------------------------


def test_settings_refuse_a_missing_secret() -> None:
    with pytest.raises(SettingsError, match="OTELCOL_VALIDATOR_SECRET is not set"):
        Settings.from_environment({})


def test_settings_refuse_a_secret_under_32_bytes() -> None:
    short = "s" * 31
    with pytest.raises(SettingsError) as raised:
        Settings.from_environment({"OTELCOL_VALIDATOR_SECRET": short})
    assert "at least 32 bytes" in str(raised.value)
    assert short not in str(raised.value)


def test_settings_accept_a_secret_of_exactly_32_bytes() -> None:
    settings = Settings.from_environment({"OTELCOL_VALIDATOR_SECRET": "s" * 32})

    assert settings.secrets.accepts("s" * 32)


def test_settings_refuse_a_short_previous_secret() -> None:
    with pytest.raises(SettingsError, match="entry 2 of 2"):
        Settings.from_environment(
            {
                "OTELCOL_VALIDATOR_SECRET": SECRET,
                "OTELCOL_VALIDATOR_SECRETS_PREVIOUS": f"{PREVIOUS_SECRET},short",
            }
        )


def test_previous_secrets_split_on_commas_dropping_empty_entries() -> None:
    assert split_previous(None) == []
    assert split_previous("") == []
    assert split_previous(f"{PREVIOUS_SECRET},, ") == [PREVIOUS_SECRET]


def test_settings_read_the_other_variables() -> None:
    settings = Settings.from_environment(
        {
            "OTELCOL_VALIDATOR_SECRET": SECRET,
            "OTELCOL_VALIDATOR_MAX_CONCURRENCY": "3",
            "OTELCOL_VALIDATE_TIMEOUT": "7",
            "OTELCOL_BINARY_DIR": "/somewhere/otelcol",
            "OTELCOL_CATALOG_DIR": "/somewhere/catalog",
        }
    )

    assert (settings.max_concurrency, settings.validate_timeout) == (3, 7)
    assert settings.binary_dir == Path("/somewhere/otelcol")
    assert settings.catalog_dir == Path("/somewhere/catalog")
    assert settings.slot_wait_seconds == 5.0


def test_settings_default_to_the_images_layout() -> None:
    settings = Settings.from_environment({"OTELCOL_VALIDATOR_SECRET": SECRET})

    assert settings.max_concurrency == 8
    assert settings.validate_timeout == 10
    assert settings.binary_dir == Path("/opt/otelcol")


def test_settings_refuse_a_malformed_number() -> None:
    with pytest.raises(SettingsError, match="OTELCOL_VALIDATOR_MAX_CONCURRENCY"):
        Settings.from_environment({"OTELCOL_VALIDATOR_SECRET": SECRET, "OTELCOL_VALIDATOR_MAX_CONCURRENCY": "0"})


def test_the_service_refuses_to_start_without_a_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """The app reads its settings at startup: without a secret the lifespan
    fails, so uvicorn exits instead of serving."""
    monkeypatch.delenv("OTELCOL_VALIDATOR_SECRET", raising=False)
    with pytest.raises(SettingsError):
        with TestClient(create_app()):
            pass


def test_the_service_refuses_to_start_with_a_short_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTELCOL_VALIDATOR_SECRET", "too-short")
    with pytest.raises(SettingsError):
        with TestClient(create_app()):
            pass


def test_the_service_starts_from_the_environment(monkeypatch: pytest.MonkeyPatch, binary_dir: Path) -> None:
    monkeypatch.setenv("OTELCOL_VALIDATOR_SECRET", SECRET)
    monkeypatch.setenv("OTELCOL_BINARY_DIR", str(binary_dir))
    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 200
        # The default catalogue is the repository's; nothing is held here.
        resp = client.post(VALIDATE_URL, json=BODY, headers=auth_headers())
        assert resp.status_code == 503


# ---------------------------------------------------------------------------
# The comparison: constant time by construction
# ---------------------------------------------------------------------------


def test_accepts_compares_with_every_secret_and_never_stops_at_a_match(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, int]] = []
    real = settings_module.hmac.compare_digest

    def counting(a, b):  # noqa: ANN001 - test double
        calls.append((len(a), len(b)))
        return real(a, b)

    secrets = Secrets(SECRET, [PREVIOUS_SECRET])
    monkeypatch.setattr(settings_module.hmac, "compare_digest", counting)

    for token in (SECRET, PREVIOUS_SECRET, "wrong", "x" * 500):
        calls.clear()
        secrets.accepts(token)
        # Two secrets, two comparisons, each of two 32-byte digests: the
        # time says nothing about the token's length or which one matched.
        assert calls == [(32, 32), (32, 32)], token


def test_accepts_uses_no_other_comparison() -> None:
    """`accepts` is the only place a token meets a secret, and its only
    comparison is hmac.compare_digest (read from its source)."""
    source = inspect.getsource(Secrets.accepts)
    body = source.split('"""')[-1]
    assert "compare_digest" in body
    # No other comparison, and no early exit from the loop.
    for operator in ("==", "!=", " is ", "startswith", ".find(", ".index(", "break", "return True", "any(", "all("):
        assert operator not in body, operator
    assert body.count("if ") == 0


def test_the_secret_text_is_never_kept() -> None:
    secrets = Secrets(SECRET, [PREVIOUS_SECRET])
    settings = Settings(secrets=secrets)

    held = repr(settings) + repr(secrets) + repr([getattr(secrets, slot) for slot in Secrets.__slots__])
    assert SECRET not in held
    assert PREVIOUS_SECRET not in held
