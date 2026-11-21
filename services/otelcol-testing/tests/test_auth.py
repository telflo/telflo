"""The shared secret: a Bearer token compared in constant time with the
secret in OTELCOL_TESTING_SECRET_FILE and each in
OTELCOL_TESTING_SECRETS_PREVIOUS_FILE, checked before the body is read; no
readable secret of 32 bytes, no start."""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import settings as settings_module
from app.main import create_app
from app.scrub import Scrub
from app.settings import Redactions, Secrets, Settings, SettingsError
from tests.conftest import (
    CATALOG_DIR,
    HEALTH_URL,
    PREVIOUS_SECRET,
    RUNS_URL,
    SECRET,
    VERSION,
    auth_headers,
    call_asgi,
    make_settings,
    run_body,
    write_fake_collector,
)


def test_a_request_without_the_header_is_401(client: TestClient) -> None:
    resp = client.post(RUNS_URL, json=run_body())

    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"
    assert resp.json() == {"error": {"code": "unauthorized", "message": "Missing or invalid credentials."}}


def test_a_wrong_secret_is_401(client: TestClient) -> None:
    resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers("x" * 40))

    assert resp.status_code == 401


def test_the_secret_in_another_scheme_is_401(client: TestClient) -> None:
    for header in (f"Basic {SECRET}", SECRET, f"Bearer{SECRET}", "Bearer "):
        resp = client.post(RUNS_URL, json=run_body(), headers={"Authorization": header})
        assert resp.status_code == 401, header


def test_a_prefix_or_extension_of_the_secret_is_401(client: TestClient) -> None:
    for token in (SECRET[:-1], SECRET + "x", SECRET.upper()):
        resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers(token))
        assert resp.status_code == 401, token


def test_two_authorization_headers_are_401(client: TestClient) -> None:
    resp = client.post(
        RUNS_URL,
        json=run_body(),
        headers=[("Authorization", f"Bearer {SECRET}"), ("Authorization", f"Bearer {SECRET}")],  # type: ignore[arg-type]
    )

    assert resp.status_code == 401


def test_the_current_secret_is_accepted(client: TestClient) -> None:
    resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers(SECRET))

    assert resp.status_code == 200
    assert resp.json()["status"] == "succeeded"


def test_a_previous_secret_is_accepted(client: TestClient) -> None:
    resp = client.post(RUNS_URL, json=run_body(), headers=auth_headers(PREVIOUS_SECRET))

    assert resp.status_code == 200


def test_the_scheme_is_case_insensitive(client: TestClient) -> None:
    resp = client.post(RUNS_URL, json=run_body(), headers={"Authorization": f"bearer {SECRET}"})

    assert resp.status_code == 200


def test_every_path_but_health_answers_the_same_401(client: TestClient) -> None:
    """Unauthenticated, an unknown path, a wrong method and the route all
    answer the same 401, so the routes can't be probed."""
    answers = [
        client.post(RUNS_URL, json=run_body()),
        client.get(RUNS_URL),
        client.get("/nothing-here"),
        client.delete(RUNS_URL),
    ]
    assert {resp.status_code for resp in answers} == {401}
    assert len({resp.text for resp in answers}) == 1


def test_health_needs_no_secret(client: TestClient) -> None:
    resp = client.get(HEALTH_URL)

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "kwok": "ready"}


async def test_an_unauthenticated_request_is_refused_before_its_body_is_read(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(app, "POST", RUNS_URL, {}, [b'{"yaml": "x"}'], forbid_body=True)

    assert result.status == 401


async def test_a_wrong_secret_is_refused_before_its_body_is_read(binary_dir: Path) -> None:
    app = create_app(make_settings(binary_dir))

    result = await call_asgi(app, "POST", RUNS_URL, auth_headers("y" * 40), [b"{}"], forbid_body=True)

    assert result.status == 401


# ---------------------------------------------------------------------------
# Settings: the secret from a file, no start without it
# ---------------------------------------------------------------------------


def _environment(secret_file: Path, **more: str) -> dict[str, str]:
    return {"OTELCOL_TESTING_SECRET_FILE": str(secret_file), **more}


def test_settings_read_the_secret_from_its_file(secret_file: Path) -> None:
    settings = Settings.from_environment(_environment(secret_file))

    assert settings.secrets.accepts(SECRET)  # the trailing line break is not part of it
    assert not settings.secrets.accepts(SECRET + "\n")
    assert len(settings.secrets) == 1


def test_settings_refuse_no_secret_file() -> None:
    with pytest.raises(SettingsError, match="OTELCOL_TESTING_SECRET_FILE is not set"):
        Settings.from_environment({})


def test_settings_refuse_an_unreadable_secret_file(tmp_path: Path) -> None:
    missing = tmp_path / "no-such-secret"
    with pytest.raises(SettingsError, match="OTELCOL_TESTING_SECRET_FILE: the file can't be read"):
        Settings.from_environment(_environment(missing))
    unreadable = tmp_path / "unreadable-secret"
    unreadable.write_text(SECRET)
    unreadable.chmod(0)
    try:
        with pytest.raises(SettingsError, match="can't be read") as raised:
            Settings.from_environment(_environment(unreadable))
        assert SECRET not in str(raised.value)
    finally:
        unreadable.chmod(0o600)


def test_settings_refuse_a_secret_under_32_bytes(tmp_path: Path) -> None:
    short = "s" * 31
    path = tmp_path / "short"
    path.write_text(short + "\n")
    with pytest.raises(SettingsError) as raised:
        Settings.from_environment(_environment(path))
    assert "at least 32 bytes" in str(raised.value)
    assert short not in str(raised.value)


def test_settings_refuse_an_empty_secret_file_and_one_that_isnt_text(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.write_text("\n  \n")
    with pytest.raises(SettingsError, match="holds no secret"):
        Settings.from_environment(_environment(empty))
    binary = tmp_path / "binary"
    binary.write_bytes(b"\xff" * 40)
    with pytest.raises(SettingsError, match="isn't UTF-8"):
        Settings.from_environment(_environment(binary))


def test_settings_accept_a_secret_of_exactly_32_bytes(tmp_path: Path) -> None:
    path = tmp_path / "exact"
    path.write_text("s" * 32)

    settings = Settings.from_environment(_environment(path))

    assert settings.secrets.accepts("s" * 32)


def test_settings_read_the_previous_secrets_one_per_line(secret_file: Path, tmp_path: Path) -> None:
    previous = tmp_path / "previous"
    previous.write_text(f"\n{PREVIOUS_SECRET}\n\n{'p' * 32}\n")

    settings = Settings.from_environment(
        _environment(secret_file, OTELCOL_TESTING_SECRETS_PREVIOUS_FILE=str(previous))
    )

    assert len(settings.secrets) == 3
    assert settings.secrets.accepts(PREVIOUS_SECRET)
    assert settings.secrets.accepts("p" * 32)
    assert set(settings.redactions.values()) == {SECRET, PREVIOUS_SECRET, "p" * 32}


def test_settings_refuse_a_short_previous_secret(secret_file: Path, tmp_path: Path) -> None:
    previous = tmp_path / "previous"
    previous.write_text(f"{PREVIOUS_SECRET}\nshort\n")
    with pytest.raises(SettingsError, match="secret 2 of 2") as raised:
        Settings.from_environment(_environment(secret_file, OTELCOL_TESTING_SECRETS_PREVIOUS_FILE=str(previous)))
    assert "short" not in str(raised.value).split(":", 1)[0]


def test_settings_refuse_an_unreadable_previous_secrets_file(secret_file: Path, tmp_path: Path) -> None:
    with pytest.raises(SettingsError, match="OTELCOL_TESTING_SECRETS_PREVIOUS_FILE: the file can't be read"):
        Settings.from_environment(
            _environment(secret_file, OTELCOL_TESTING_SECRETS_PREVIOUS_FILE=str(tmp_path / "missing"))
        )


def test_settings_refuse_the_secret_in_the_environment(secret_file: Path) -> None:
    """The secret must be in no environment, since exec makes a
    collector dumpable again. The value variable is refused outright, and so
    is the secret's text in any variable."""
    with pytest.raises(SettingsError, match="OTELCOL_TESTING_SECRET is set") as raised:
        Settings.from_environment(_environment(secret_file, OTELCOL_TESTING_SECRET=SECRET))
    assert SECRET not in str(raised.value)
    with pytest.raises(SettingsError, match="also in the environment") as raised:
        Settings.from_environment(_environment(secret_file, SOMETHING=f"x{SECRET}y"))
    assert SECRET not in str(raised.value)


def test_settings_read_the_other_variables(secret_file: Path) -> None:
    settings = Settings.from_environment(
        _environment(
            secret_file,
            OTELCOL_TESTING_MAX_CONCURRENCY="3",
            OTELCOL_BINARY_DIR="/somewhere/otelcol",
            OTELCOL_CATALOG_DIR="/somewhere/catalog",
        )
    )

    assert settings.max_concurrency == 3
    assert settings.binary_dir == Path("/somewhere/otelcol")
    assert settings.catalog_dir == Path("/somewhere/catalog")
    assert settings.slot_wait_seconds == 5.0


def test_settings_default_to_the_images_layout_and_ruling_2s_budgets(secret_file: Path) -> None:
    settings = Settings.from_environment(_environment(secret_file))

    assert settings.max_concurrency == 4
    assert settings.binary_dir == Path("/opt/otelcol")
    assert settings.slot_wait_seconds == 5.0
    # d = 1 and d = 60: the deadline 57 + d, the request's budget 64 + d.
    assert (settings.run_deadline_seconds(1), settings.request_budget_seconds(1)) == (58, 65)
    assert (settings.run_deadline_seconds(60), settings.request_budget_seconds(60)) == (117, 124)


def test_settings_refuse_a_malformed_cap(secret_file: Path) -> None:
    for value in ("0", "-1", "four"):
        with pytest.raises(SettingsError, match="OTELCOL_TESTING_MAX_CONCURRENCY"):
            Settings.from_environment(_environment(secret_file, OTELCOL_TESTING_MAX_CONCURRENCY=value))


def test_the_service_refuses_to_start_without_a_secret_file(monkeypatch: pytest.MonkeyPatch) -> None:
    """The app reads its settings at startup: without a secret the lifespan
    fails, so uvicorn exits instead of serving."""
    monkeypatch.delenv("OTELCOL_TESTING_SECRET_FILE", raising=False)
    with pytest.raises(SettingsError):
        with TestClient(create_app()):
            pass


def test_the_service_refuses_to_start_with_a_short_secret(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "short"
    path.write_text("too-short")
    monkeypatch.setenv("OTELCOL_TESTING_SECRET_FILE", str(path))
    with pytest.raises(SettingsError, match="at least 32 bytes"):
        with TestClient(create_app()):
            pass


def test_the_service_refuses_to_start_with_an_unreadable_secret(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("OTELCOL_TESTING_SECRET_FILE", str(tmp_path / "missing"))
    with pytest.raises(SettingsError, match="can't be read"):
        with TestClient(create_app()):
            pass


def test_the_service_starts_from_the_environment(
    monkeypatch: pytest.MonkeyPatch, binary_dir: Path, secret_file: Path
) -> None:
    monkeypatch.setenv("OTELCOL_TESTING_SECRET_FILE", str(secret_file))
    monkeypatch.setenv("OTELCOL_BINARY_DIR", str(binary_dir))
    monkeypatch.setenv("OTELCOL_CATALOG_DIR", str(CATALOG_DIR))
    write_fake_collector(binary_dir, VERSION)
    with TestClient(create_app()) as client:
        assert client.get(HEALTH_URL).status_code == 200
        assert client.post(RUNS_URL, json=run_body(), headers=auth_headers()).status_code == 200
        assert client.post(RUNS_URL, json=run_body(), headers=auth_headers("w" * 40)).status_code == 401


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
    for operator in ("==", "!=", " is ", "startswith", ".find(", ".index(", "break", "return True", "any(", "all("):
        assert operator not in body, operator
    assert body.count("if ") == 0


def test_the_secret_text_is_never_in_a_repr() -> None:
    settings = Settings(secrets=Secrets(SECRET, [PREVIOUS_SECRET]), redactions=Redactions([SECRET, PREVIOUS_SECRET]))

    held = repr(settings) + repr(settings.secrets) + repr(settings.redactions)
    held += repr([getattr(settings.secrets, slot) for slot in Secrets.__slots__])
    # The answer's scrub holds the secrets' values.
    held += repr(Scrub.for_run(workspace="/tmp/otelcol-run-x", secrets=settings.redactions.values()))
    assert SECRET not in held
    assert PREVIOUS_SECRET not in held
    assert "otelcol-run-x" not in held
