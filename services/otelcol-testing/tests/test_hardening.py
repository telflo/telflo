"""The service's process is not dumpable (D14a spec decision 5, Preflight
ruling 4): `prctl(PR_SET_DUMPABLE, 0)` at start, before the secret's file is
read, checked with PR_GET_DUMPABLE. Linux's only: elsewhere it does nothing.
The real call is made in a fresh interpreter (on Linux, the image's test
stage; on macOS it shows the no-op); the call's shape is checked with a
fake libc everywhere."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import hardening
from app import main as main_module
from app.hardening import PR_GET_DUMPABLE, PR_SET_DUMPABLE, HardeningError, is_dumpable, make_not_dumpable
from app.settings import Settings
from tests.conftest import HEALTH_URL, SECRET

SERVICE_ROOT = Path(__file__).resolve().parents[1]


class FakeLibc:
    def __init__(self, set_result: int = 0, dumpable_after: int = 0) -> None:
        self.calls: list[tuple[int, ...]] = []
        self.set_result = set_result
        self.dumpable = 1
        self.dumpable_after = dumpable_after

    def prctl(self, option: int, arg2: int, arg3: int, arg4: int, arg5: int) -> int:
        self.calls.append((option, arg2, arg3, arg4, arg5))
        if option == PR_SET_DUMPABLE:
            if self.set_result == 0:
                self.dumpable = self.dumpable_after
            return self.set_result
        return self.dumpable


def test_the_flag_is_set_and_read_back_on_linux() -> None:
    libc = FakeLibc()

    assert make_not_dumpable(platform="linux", libc=libc) is True
    assert libc.calls == [(PR_SET_DUMPABLE, 0, 0, 0, 0), (PR_GET_DUMPABLE, 0, 0, 0, 0)]
    assert is_dumpable(platform="linux", libc=libc) is False


def test_a_refused_prctl_or_a_flag_that_didnt_take_stops_the_service() -> None:
    with pytest.raises(HardeningError):
        make_not_dumpable(platform="linux", libc=FakeLibc(set_result=-1))
    with pytest.raises(HardeningError):
        make_not_dumpable(platform="linux", libc=FakeLibc(dumpable_after=1))


def test_elsewhere_it_does_nothing() -> None:
    libc = FakeLibc()

    assert make_not_dumpable(platform="darwin", libc=libc) is None
    assert is_dumpable(platform="darwin", libc=libc) is None
    assert libc.calls == []


def test_the_real_call_in_a_fresh_interpreter() -> None:
    """On Linux the process reads back not dumpable; elsewhere the call is a
    no-op and says so."""
    source = (
        "from app.hardening import is_dumpable, make_not_dumpable\n"
        "before = is_dumpable()\n"
        "print(before, make_not_dumpable(), is_dumpable())\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", source], cwd=SERVICE_ROOT, capture_output=True, text=True, check=True
    )

    if sys.platform.startswith("linux"):
        assert result.stdout.split() == ["True", "True", "False"]
    else:
        assert result.stdout.split() == ["None", "None", "None"]


def test_the_service_drops_the_flag_before_it_reads_the_secret(
    monkeypatch: pytest.MonkeyPatch, secret_file: Path
) -> None:
    order: list[str] = []
    real_settings = Settings.from_environment

    def dropping() -> bool:
        order.append("not dumpable")
        return True

    def reading(environ):  # noqa: ANN001
        order.append("secret read")
        return real_settings(environ)

    monkeypatch.setattr(hardening, "make_not_dumpable", dropping)
    monkeypatch.setattr(main_module.Settings, "from_environment", staticmethod(reading))
    monkeypatch.setenv("OTELCOL_TESTING_SECRET_FILE", str(secret_file))
    with TestClient(main_module.create_app()) as client:
        assert client.get(HEALTH_URL).status_code == 200

    assert order == ["not dumpable", "secret read"]


def test_the_service_refuses_to_start_when_the_flag_cant_be_dropped(
    monkeypatch: pytest.MonkeyPatch, secret_file: Path
) -> None:
    def refused() -> bool:
        raise HardeningError(1, "prctl(PR_SET_DUMPABLE, 0) failed")

    monkeypatch.setattr(hardening, "make_not_dumpable", refused)
    monkeypatch.setenv("OTELCOL_TESTING_SECRET_FILE", str(secret_file))
    with pytest.raises(HardeningError):
        with TestClient(main_module.create_app()):
            pass
    assert SECRET  # the secret file was never needed to refuse
