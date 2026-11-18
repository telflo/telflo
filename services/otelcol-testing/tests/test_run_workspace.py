"""A run's workspace. One that already exists is refused, never removed, so
a run sent twice can't delete the live run's workspace (D14a Task 4). The
service's
own workspaces (mkdtemp, made and removed by `app/runner.py`) are wrapped
with ``RunWorkspace.existing``, tested at the end.
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest

from app.run_workspace import RunWorkspace


def test_creates_and_cleans_on_success(tmp_path: Path) -> None:
    run_id = uuid4()
    with RunWorkspace(run_id, base=tmp_path) as ws:
        assert ws.root.is_dir()
        ws.config_path.write_text("x")
        assert ws.config_path.exists()
    assert not (tmp_path / str(run_id)).exists()


def test_cleans_on_failure_by_default(tmp_path: Path) -> None:
    run_id = uuid4()
    with pytest.raises(RuntimeError):
        with RunWorkspace(run_id, base=tmp_path) as ws:
            ws.config_path.write_text("x")
            raise RuntimeError("boom")
    assert not (tmp_path / str(run_id)).exists()


def test_retains_on_failure_when_keep_flag_set(tmp_path: Path) -> None:
    run_id = uuid4()
    with pytest.raises(RuntimeError):
        with RunWorkspace(run_id, base=tmp_path, keep_on_failure=True) as ws:
            ws.config_path.write_text("x")
            raise RuntimeError("boom")
    assert (tmp_path / str(run_id) / "config.yaml").exists()


def test_an_existing_workspace_is_refused_never_removed(tmp_path: Path) -> None:
    """Removing a "stale" directory of the same run id would let a run sent
    twice delete the live run's workspace. It is refused, and left as it
    was."""
    run_id = uuid4()
    live_dir = tmp_path / str(run_id)
    live_dir.mkdir()
    (live_dir / "output.data").write_text("the live run's output")

    with pytest.raises(FileExistsError):
        with RunWorkspace(run_id, base=tmp_path):
            pass

    assert (live_dir / "output.data").read_text() == "the live run's output"


def test_raw_input_path_is_input_log(tmp_path: Path) -> None:
    ws = RunWorkspace(uuid4(), base=tmp_path)
    assert ws.raw_input_path.name == "input.log"
    assert ws.raw_input_path.parent == ws.root


def test_a_new_workspace_is_private(tmp_path: Path) -> None:
    with RunWorkspace(uuid4(), base=tmp_path) as ws:
        assert ws.root.stat().st_mode & 0o777 == 0o700


def test_existing_wraps_the_services_directory_without_making_or_removing_it(tmp_path: Path) -> None:
    ws = RunWorkspace.existing(tmp_path)

    assert ws.root == tmp_path
    assert ws.config_path == tmp_path / "config.yaml"
    assert ws.output_path == tmp_path / "output.data"
    assert ws.staged_input_path == tmp_path / "input.raw"
    assert ws.raw_input_path == tmp_path / "input.log"
    assert ws.container_log_path("u-1").relative_to(tmp_path) == Path(
        "var/log/pods/demo_telflo-test-pod_u-1/app/0.log"
    )
    assert tmp_path.is_dir()
