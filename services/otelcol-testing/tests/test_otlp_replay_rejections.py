"""The replay's client is ``httpx2``, imported as ``httpx``. More tests
follow at the end: the replay's total budget, the port's lease while runs
overlap, and the informer wait with the cluster's certificates.

OTLP-replay rejections are surfaced in the run's stderr instead of being
swallowed: logged only to the service logger, a misconfigured fixture (logs
JSON sent to a metrics pipeline, etc.) would produce an empty output with no
diagnostic visible to the user.

Two layers of test:

1. ``_prepend_replay_summary`` is pure and easy to assert directly — verifies
   the formatting contract (truncation, "N of M", missing-block on no
   rejections).
2. ``_replay_file`` is exercised against ``httpx.MockTransport`` so we get
   real httpx semantics without spinning up a network server (and without
   pulling in an aiohttp dev dep — only ``httpx`` is in requirements.txt).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx2 as httpx
import pytest

from app.executors import otlp_replay as module
from app.executors._shared import _hold_free_port, _wait_for_pod_listable
from app.executors.otlp_replay import (
    _decode_fixture,
    _iter_payloads,
    _prepend_replay_summary,
    _replay_file,
    _ReplayRejection,
    _ReplaySummary,
)


# ---------------------------------------------------------------------------
# _prepend_replay_summary: pure formatting contract
# ---------------------------------------------------------------------------


def test_prepend_summary_no_op_when_no_rejections() -> None:
    summary = _ReplaySummary(total_lines=5, rejections=[])
    assert _prepend_replay_summary("collector log\n", summary) == "collector log\n"


def test_prepend_summary_no_op_on_empty_stderr_with_no_rejections() -> None:
    """Empty stderr stays empty when nothing was rejected."""
    summary = _ReplaySummary(total_lines=0, rejections=[])
    assert _prepend_replay_summary("", summary) == ""


def test_prepend_summary_includes_rejection_count_and_line_numbers() -> None:
    summary = _ReplaySummary(
        total_lines=3,
        rejections=[
            _ReplayRejection(lineno=1, status=400, body_excerpt="bad shape"),
            _ReplayRejection(lineno=3, status=400, body_excerpt="bad shape"),
        ],
    )
    out = _prepend_replay_summary("collector log\n", summary)
    assert out.startswith("[replay] 2 of 3 fixture line(s) rejected")
    assert "line 1 (400): bad shape" in out
    assert "line 3 (400): bad shape" in out
    # Original stderr is preserved after the block.
    assert "collector log" in out


def test_prepend_summary_truncates_to_first_five() -> None:
    rejections = [
        _ReplayRejection(lineno=i, status=400, body_excerpt="x")
        for i in range(1, 11)
    ]
    summary = _ReplaySummary(total_lines=10, rejections=rejections)
    out = _prepend_replay_summary("", summary)
    # Only first 5 line numbers appear individually; the rest are summarized.
    for i in range(1, 6):
        assert f"line {i} " in out
    for i in range(6, 11):
        assert f"line {i} " not in out
    assert "+5 more" in out


def test_prepend_summary_renders_transport_errors() -> None:
    """status=None means the request never reached the collector."""
    summary = _ReplaySummary(
        total_lines=1,
        rejections=[
            _ReplayRejection(
                lineno=1, status=None, body_excerpt="transport error: ..."
            )
        ],
    )
    out = _prepend_replay_summary("", summary)
    assert "(transport):" in out


# ---------------------------------------------------------------------------
# _replay_file: httpx with MockTransport so we control responses per request.
# ---------------------------------------------------------------------------


def _patch_httpx_with_handler(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """Wrap ``httpx.AsyncClient`` so any client constructed inside
    ``_replay_file`` uses a MockTransport bound to ``handler``. Production
    code stays untouched — it just constructs a normal client; the patch
    redirects that to an in-process transport."""
    transport = httpx.MockTransport(handler)
    real_cls = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.setdefault("transport", transport)
        return real_cls(*args, **kwargs)

    monkeypatch.setattr(module.httpx, "AsyncClient", factory)


def _write_fixture(tmp_path: Path, lines: int) -> Path:
    """N non-blank JSON-ish lines plus a trailing blank that should be
    skipped by the replayer."""
    p = tmp_path / "fixture.json"
    p.write_text(
        "\n".join(f'{{"line": {i}}}' for i in range(1, lines + 1)) + "\n\n"
    )
    return p


async def test_replay_file_collects_every_rejection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every line returns 400 — every line should be in the rejection list,
    blanks excluded, and total_lines reflects the non-blank count."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="invalid metric type")

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=3)

    summary = await _replay_file("http://collector/v1/metrics", fixture)

    assert summary.total_lines == 3
    assert len(summary.rejections) == 3
    assert {r.lineno for r in summary.rejections} == {1, 2, 3}
    for r in summary.rejections:
        assert r.status == 400
        assert "invalid metric type" in r.body_excerpt


async def test_replay_file_includes_only_rejected_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Alternating server: odd line numbers rejected, even accepted. Only
    the rejections should appear in the summary."""
    counter = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        counter["n"] += 1
        if counter["n"] % 2 == 1:
            return httpx.Response(400, text="odd line rejected")
        return httpx.Response(200, text="ok")

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=4)

    summary = await _replay_file("http://collector/v1/metrics", fixture)

    assert summary.total_lines == 4
    assert {r.lineno for r in summary.rejections} == {1, 3}


async def test_replay_file_no_rejections_for_2xx(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: every line 200s, rejection list is empty, and the
    summary formatter is a no-op against this shape."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200)

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=2)

    summary = await _replay_file("http://collector/v1/metrics", fixture)

    assert summary.total_lines == 2
    assert summary.rejections == []
    # And the prepend is a no-op on this shape.
    assert _prepend_replay_summary("c log", summary) == "c log"


async def test_replay_file_records_transport_errors_with_status_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A handler that raises makes httpx surface a RequestError; the rejection
    is recorded with status=None so the summary formatter renders 'transport'."""

    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=1)

    summary = await _replay_file("http://collector/v1/metrics", fixture)

    assert summary.total_lines == 1
    assert len(summary.rejections) == 1
    assert summary.rejections[0].status is None
    assert "transport error" in summary.rejections[0].body_excerpt


# ---------------------------------------------------------------------------
# _decode_fixture / _iter_payloads: tolerate the encodings & shapes users
# actually upload (the UTF-16 pretty-printed-document footgun).
# ---------------------------------------------------------------------------

_OTLP_DOC = {"resourceLogs": [{"resource": {"attributes": []}}]}


def test_decode_fixture_plain_utf8() -> None:
    assert _decode_fixture(b'{"a": 1}') == '{"a": 1}'


def test_decode_fixture_strips_utf8_bom() -> None:
    assert _decode_fixture(b"\xef\xbb\xbf" + b'{"a": 1}') == '{"a": 1}'


def test_decode_fixture_utf16_le_with_bom() -> None:
    """PowerShell `>` / Out-File default. Round-trips to clean UTF-8 text."""
    raw = '{"a": "é"}'.encode("utf-16")  # includes BOM
    assert _decode_fixture(raw) == '{"a": "é"}'


def test_decode_fixture_utf16_without_bom_falls_back() -> None:
    raw = '{"a": 1}'.encode("utf-16-le")  # no BOM
    assert _decode_fixture(raw) == '{"a": 1}'


def test_iter_payloads_single_pretty_document_is_one_payload() -> None:
    """The exact bug: a pretty-printed single OTLP doc must be ONE request,
    not one-per-line."""
    import json as _json

    pretty = _json.dumps(_OTLP_DOC, indent=2)
    assert "\n" in pretty  # sanity: it really is multi-line
    payloads = _iter_payloads(pretty)
    assert len(payloads) == 1
    assert _json.loads(payloads[0][1]) == _OTLP_DOC


def test_iter_payloads_json_array_is_one_payload_per_element() -> None:
    import json as _json

    payloads = _iter_payloads(_json.dumps([_OTLP_DOC, _OTLP_DOC]))
    assert len(payloads) == 2
    assert [lbl for lbl, _ in payloads] == [1, 2]


def test_iter_payloads_ndjson_preserved_with_line_numbers() -> None:
    text = '{"line": 1}\n\n{"line": 2}\n'
    payloads = _iter_payloads(text)
    # Blank line skipped; original line numbers retained for the summary.
    assert payloads == [(1, '{"line": 1}'), (3, '{"line": 2}')]


async def test_replay_utf16_pretty_document_now_succeeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end of the reported bug: a UTF-16, pretty-printed single OTLP
    document used to be rejected on every line. It must now be a single
    accepted request with zero rejections."""
    import json as _json

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.content.decode("utf-8"))
        return httpx.Response(200)

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = tmp_path / "fixture.json"
    fixture.write_bytes(_json.dumps(_OTLP_DOC, indent=2).encode("utf-16"))

    summary = await _replay_file("http://collector/v1/logs", fixture)

    assert summary.total_lines == 1
    assert summary.rejections == []
    assert summary.fully_rejected is False
    assert len(seen) == 1
    assert _json.loads(seen[0]) == _OTLP_DOC


def test_summary_fully_rejected_property() -> None:
    every = _ReplaySummary(
        total_lines=2,
        rejections=[
            _ReplayRejection(lineno=1, status=400, body_excerpt="x"),
            _ReplayRejection(lineno=2, status=400, body_excerpt="x"),
        ],
    )
    assert every.fully_rejected is True
    partial = _ReplaySummary(
        total_lines=2,
        rejections=[_ReplayRejection(lineno=1, status=400, body_excerpt="x")],
    )
    assert partial.fully_rejected is False
    assert _ReplaySummary(total_lines=0, rejections=[]).fully_rejected is False


# ---------------------------------------------------------------------------
# _hold_free_port (tightens the TOCTOU window between picker and
# subprocess bind by holding the picker socket open until immediately
# before spawn).
# ---------------------------------------------------------------------------


import socket


def test_hold_free_port_yields_an_ephemeral_port() -> None:
    with _hold_free_port() as port:
        assert isinstance(port, int)
        # Linux default ip_local_port_range is 32768-60999; macOS / Windows
        # ephemeral ranges overlap. Bound the assertion loosely so we don't
        # tie the test to a specific OS config.
        assert 1024 < port < 65536


def test_hold_free_port_actually_reserves_the_port_while_open() -> None:
    """While the context is open another process binding to the same port
    must fail. This is the whole point — pre-fix the picker closed the
    socket before returning, so the window between pick and collector
    bind was wide enough for racy collisions on parallel runs."""
    with _hold_free_port() as port:
        contender = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(OSError):
                contender.bind(("127.0.0.1", port))
        finally:
            contender.close()


def test_hold_free_port_releases_on_exit() -> None:
    """Once the context closes the port becomes bindable again — verify so
    the executor's "release-then-spawn" pattern still works."""
    with _hold_free_port() as port:
        pass
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
    finally:
        s.close()


# ---------------------------------------------------------------------------
# _wait_for_pod_listable (a poll against the kwok apiserver, in place of a
# static informer-sync sleep).
# ---------------------------------------------------------------------------


async def test_wait_for_pod_listable_returns_true_on_first_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: apiserver responds 200 right away, helper returns True
    without doing the full poll cycle."""

    def handler(request: httpx.Request) -> httpx.Response:
        # Confirm the URL shape the helper builds — namespace + pod path.
        assert "/api/v1/namespaces/demo/pods/test-pod" in str(request.url)
        return httpx.Response(200, json={"kind": "Pod"})

    _patch_httpx_with_handler(monkeypatch, handler)

    ok = await _wait_for_pod_listable(
        "http://kwok:8080",
        "demo",
        "test-pod",
        timeout_seconds=2.0,
    )
    assert ok is True


async def test_wait_for_pod_listable_polls_until_pod_appears(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Simulate a slow apiserver: first two requests get 404 (pod not yet
    seeded), third returns 200. Helper must keep polling and return True."""
    state = {"calls": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        if state["calls"] < 3:
            return httpx.Response(404, json={"reason": "NotFound"})
        return httpx.Response(200, json={"kind": "Pod"})

    _patch_httpx_with_handler(monkeypatch, handler)

    ok = await _wait_for_pod_listable(
        "http://kwok:8080",
        "demo",
        "test-pod",
        timeout_seconds=2.0,
        poll_interval_seconds=0.01,
    )
    assert ok is True
    assert state["calls"] >= 3


async def test_wait_for_pod_listable_returns_false_on_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Apiserver never returns 200 → helper times out and returns False
    rather than raising. The caller proceeds either way and surfaces any
    real downstream failure via stderr — see the docstring rationale."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    _patch_httpx_with_handler(monkeypatch, handler)

    ok = await _wait_for_pod_listable(
        "http://kwok:8080",
        "demo",
        "test-pod",
        timeout_seconds=0.2,
        poll_interval_seconds=0.05,
    )
    assert ok is False


async def test_wait_for_pod_listable_survives_transport_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """During cluster bring-up the apiserver socket may not yet accept
    connections. ConnectError/RequestError shouldn't abort the poll — the
    helper should keep retrying until the deadline. We flip from raising
    to returning 200 partway through to confirm the loop recovers."""
    state = {"calls": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        state["calls"] += 1
        if state["calls"] < 3:
            raise httpx.ConnectError("connection refused")
        return httpx.Response(200, json={"kind": "Pod"})

    _patch_httpx_with_handler(monkeypatch, handler)

    ok = await _wait_for_pod_listable(
        "http://kwok:8080",
        "demo",
        "test-pod",
        timeout_seconds=2.0,
        poll_interval_seconds=0.01,
    )
    assert ok is True
    assert state["calls"] >= 3


# ---------------------------------------------------------------------------
# The replay's total budget
# ---------------------------------------------------------------------------

from app import settings as settings_module  # noqa: E402
from app.executors import _shared  # noqa: E402


class _Clock:
    """A clock the test moves: ``advance_after`` POSTs, it jumps past the
    budget."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def test_replay_stops_when_its_budget_runs_out_and_says_how_many_were_not_sent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = _Clock()
    posted: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(request.content)
        if len(posted) == 2:
            clock.now += 31  # the budget (30 s) is spent once the second is answered
        return httpx.Response(200)

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=5)

    summary = await _replay_file("http://collector/v1/logs", fixture, budget_seconds=30, clock=clock)

    assert len(posted) == 2
    assert (summary.total_lines, summary.sent, summary.not_sent) == (5, 2, 3)
    assert summary.rejections == [] and summary.fully_rejected is False
    out = _prepend_replay_summary("collector log\n", summary)
    assert out == "[replay] 3 of 5 payloads not sent: the replay's 30 s budget ran out\n\ncollector log\n"


async def test_a_payload_in_flight_when_the_budget_runs_out_counts_as_not_sent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The last of the budget is shorter than a POST's 5 s: the POST in
    flight is abandoned when it runs out, and counts as not sent."""
    clock = _Clock()
    never = asyncio.Event()

    calls: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            clock.now += 29.99  # what is left of the budget: 0.01 s
            return httpx.Response(200)
        await never.wait()  # the second is still in flight when the budget runs out
        return httpx.Response(200)

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=3)

    summary = await asyncio.wait_for(  # a hang guard
        _replay_file("http://collector/v1/logs", fixture, budget_seconds=30, clock=clock), 30
    )

    assert len(calls) == 2
    assert (summary.sent, summary.not_sent) == (1, 2)
    assert summary.rejections == []


async def test_only_the_payloads_sent_count_toward_fully_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = _Clock()

    def handler(_request: httpx.Request) -> httpx.Response:
        clock.now += 20
        return httpx.Response(400, text="bad")

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=4)

    summary = await _replay_file("http://collector/v1/logs", fixture, budget_seconds=30, clock=clock)

    assert (summary.sent, len(summary.rejections)) == (2, 2)
    assert summary.fully_rejected is True
    out = _prepend_replay_summary("", summary)
    assert out.startswith("[replay] 2 of 4 fixture line(s) rejected by the collector:\n")
    assert out.endswith("[replay] 2 of 4 payloads not sent: the replay's 30 s budget ran out\n")


async def test_a_receiver_that_never_answers_is_bounded_by_the_posts_own_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A POST is awaited under ``wait_for(min(what is left, 5 s))``,
    so a receiver that never answers (httpx's per-read timeouts would let one
    that answers a byte at a time run on; the mock transport has none at all)
    holds it for the POST's limit only: a rejection, and the replay goes on.
    The limit is lowered here; the clock never moves, so the budget isn't
    what stops it."""
    clock = _Clock()
    never = asyncio.Event()
    calls: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            await never.wait()  # the slow receiver
        return httpx.Response(200)

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=3)

    summary = await asyncio.wait_for(  # a hang guard
        _replay_file("http://collector/v1/logs", fixture, post_timeout_seconds=0.05, clock=clock), 30
    )

    assert len(calls) == 3
    assert summary.sent is None and summary.not_sent == 0
    [rejection] = summary.rejections
    assert (rejection.lineno, rejection.status) == (1, None)
    assert rejection.body_excerpt == "transport error: no answer within 0.05 s"
    assert _prepend_replay_summary("", summary).startswith(
        "[replay] 1 of 3 fixture line(s) rejected by the collector:\n  line 1 (transport): transport error: no answer within 0.05 s\n"
    )


async def test_the_total_budget_holds_when_every_post_is_slow(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every receiver call hangs, each one costing 10 s of the budget on the
    test's clock: three are cut at the POST's limit, then the budget (30 s)
    is spent and the last two aren't sent."""
    clock = _Clock()
    never = asyncio.Event()
    calls: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        clock.now += 10
        await never.wait()
        return httpx.Response(200)

    _patch_httpx_with_handler(monkeypatch, handler)
    fixture = _write_fixture(tmp_path, lines=5)

    summary = await asyncio.wait_for(  # a hang guard
        _replay_file("http://collector/v1/logs", fixture, budget_seconds=30, post_timeout_seconds=0.05, clock=clock),
        30,
    )

    assert len(calls) == 3
    assert (summary.sent, summary.not_sent, len(summary.rejections)) == (3, 2, 3)
    assert summary.fully_rejected is True


async def test_the_replay_has_ruling_2s_limits_and_ignores_proxy_variables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    built: list[dict] = []
    real_cls = httpx.AsyncClient

    def factory(*args, **kwargs):
        built.append(dict(kwargs))
        kwargs.setdefault("transport", httpx.MockTransport(lambda request: httpx.Response(200)))
        return real_cls(*args, **kwargs)

    monkeypatch.setattr(module.httpx, "AsyncClient", factory)
    summary = await _replay_file("http://collector/v1/logs", _write_fixture(tmp_path, lines=1))

    assert (settings_module.REPLAY_TOTAL_SECONDS, settings_module.REPLAY_POST_SECONDS) == (30.0, 5.0)
    assert summary.budget_seconds == 30.0
    assert built == [{"timeout": 5.0, "trust_env": False}]


# ---------------------------------------------------------------------------
# The port's lease, while runs overlap
# ---------------------------------------------------------------------------

import random  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402


class _SameEveryTime(random.Random):
    """A random source that offers the same ports in the same order to every
    lease, as two runs' children could draw them."""

    def __init__(self, ports: list[int]) -> None:
        super().__init__()
        self._ports = ports
        self._next = 0

    def randrange(self, start, stop=None, step=1):  # noqa: ANN001
        port = self._ports[self._next % len(self._ports)]
        self._next += 1
        return port


def _free_ports(count: int) -> list[int]:
    ports: list[int] = []
    for port in range(*_shared.PORT_RANGE):
        probe = socket.socket()
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            continue
        finally:
            probe.close()
        ports.append(port)
        if len(ports) == count:
            return ports
    raise AssertionError("no free ports in the range")


def test_two_overlapping_leases_never_share_a_port_even_once_the_first_lets_go_of_its_socket(tmp_path: Path) -> None:
    """The collector binds after the probe socket is released: until the run
    ends, its port stays leased, so an overlapping run drawing the same port
    is given the next one."""
    first_port, second_port = _free_ports(2)
    first = _hold_free_port(lock_dir=tmp_path, rng=_SameEveryTime([first_port, second_port]))
    assert first.__enter__() == first_port
    try:
        first.release_socket()  # the first run's collector is about to bind
        with _hold_free_port(lock_dir=tmp_path, rng=_SameEveryTime([first_port, second_port])) as second:
            assert second == second_port
    finally:
        first.__exit__(None, None, None)
    with _hold_free_port(lock_dir=tmp_path, rng=_SameEveryTime([first_port])) as again:
        assert again == first_port  # both let go: the port is free to lease


def test_a_lease_skips_a_port_another_runs_child_holds(tmp_path: Path) -> None:
    held, other = _free_ports(2)
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import fcntl, os, sys\n"
            f"fd = os.open({str(tmp_path / f'{held}.lock')!r}, os.O_RDWR | os.O_CREAT, 0o600)\n"
            "fcntl.flock(fd, fcntl.LOCK_EX)\n"
            "print('held', flush=True)\n"
            "sys.stdin.read()\n",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    with holder:
        try:
            assert holder.stdout.readline().strip() == "held"
            with _hold_free_port(lock_dir=tmp_path, rng=_SameEveryTime([held, other])) as port:
                assert port == other
        finally:
            holder.stdin.close()
            holder.wait(timeout=30)  # a hang guard


def test_releasing_the_probe_lets_the_collector_bind_while_the_lease_holds(tmp_path: Path) -> None:
    lease = _hold_free_port(lock_dir=tmp_path)
    port = lease.__enter__()
    try:
        lease.release_socket()
        collector = socket.socket()
        try:
            collector.bind(("127.0.0.1", port))  # the collector can bind it now
        finally:
            collector.close()
        assert _shared._take_lock(tmp_path / f"{port}.lock") is None  # still leased
    finally:
        lease.__exit__(None, None, None)
    taken = _shared._take_lock(tmp_path / f"{port}.lock")
    assert taken is not None
    os.close(taken)


def test_the_range_is_below_the_kernels_ephemeral_ranges() -> None:
    low, high = _shared.PORT_RANGE
    assert 1024 < low < high <= 32768  # Linux's ephemeral range starts at 32768, macOS's at 49152


# ---------------------------------------------------------------------------
# The informer wait verifies the cluster
# ---------------------------------------------------------------------------

import os  # noqa: E402
import ssl  # noqa: E402


async def test_wait_for_pod_listable_uses_the_clusters_ca_and_admin_certificate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded: list[tuple[str, ...]] = []

    class _Context:
        def load_cert_chain(self, certfile: str, keyfile: str) -> None:
            loaded.append(("chain", certfile, keyfile))

    context = _Context()

    def create_default_context(*, cafile: str) -> _Context:
        loaded.append(("ca", cafile))
        return context

    monkeypatch.setattr(_shared.ssl, "create_default_context", create_default_context)
    built: list[dict] = []
    real_cls = httpx.AsyncClient

    def factory(*args, **kwargs):
        built.append(dict(kwargs))
        kwargs.pop("verify", None)
        kwargs.setdefault("transport", httpx.MockTransport(lambda request: httpx.Response(200)))
        return real_cls(*args, **kwargs)

    monkeypatch.setattr(module.httpx, "AsyncClient", factory)
    pki = tmp_path / "pki"

    ok = await _wait_for_pod_listable("https://127.0.0.1:6443", "demo", "telflo-test-pod", timeout_seconds=2.0, pki_dir=pki)

    assert ok is True
    assert loaded == [("ca", str(pki / "ca.crt")), ("chain", str(pki / "admin.crt"), str(pki / "admin.key"))]
    assert built[0]["verify"] is context
    assert built[0]["trust_env"] is False


async def test_unreadable_certificates_poll_without_them(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    built: list[dict] = []
    real_cls = httpx.AsyncClient

    def factory(*args, **kwargs):
        built.append(dict(kwargs))
        kwargs.setdefault("transport", httpx.MockTransport(lambda request: httpx.Response(200)))
        return real_cls(*args, **kwargs)

    monkeypatch.setattr(module.httpx, "AsyncClient", factory)

    ok = await _wait_for_pod_listable("https://127.0.0.1:6443", "demo", "p", timeout_seconds=2.0, pki_dir=tmp_path / "missing")

    assert ok is True
    assert "verify" not in built[0]
    assert isinstance(ssl.SSLError("x"), OSError)  # what the wait catches
