"""Health and kwok's start (D14a Preflight ruling 5, Ruling 26): the service
listens first and starts kwok in the background. Meanwhile health answers
503 `starting` and a run 503 `tester_starting`, before its body is read;
once kwok is up, 200 `ok`/`ready`. A failed start is retried, three
attempts in all with a backoff before each retry; after the last, health
answers 503 `unavailable`/`failed`, a run 503 `tester_unavailable` (never
served without kwok), and the service exits with a non-zero status. The
cluster is stopped at shutdown, its endpoint reaches the run's child, and
its kubeconfig is scrubbed from answers. Once up, the cluster's liveness is
re-checked on health and before each run (Ruling 29): a cluster that stopped
answering is `failed`, with the same consequences. (The service's app passes
kwok's real starter, `app/kwok_cluster.py`; here the starters are fakes.)"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import httpx2

from app import runner
from app.kwok import KwokState, KwokSupervisor, no_cluster
from app.main import create_app
from tests import guard
from tests.conftest import (
    HEALTH_URL,
    RUNS_URL,
    VERSION,
    auth_headers,
    call_asgi,
    make_settings,
    run_body,
    write_collector,
    write_fake_collector,
)


class FakeCluster:
    def __init__(self, kubeconfig: Path) -> None:
        self.kubeconfig = kubeconfig
        self.stopped = False
        self.apiserver_url: str | None = None
        self.seed_pod_uid: str | None = None
        self.pki_dir: Path | None = None

    async def stop(self) -> None:
        self.stopped = True


async def test_starting_then_ready(binary_dir: Path, tmp_path: Path) -> None:
    write_collector(binary_dir, VERSION, "exec sleep 600\n")
    may_start = asyncio.Event()
    cluster = FakeCluster(tmp_path / "kwok" / "kubeconfig.yaml")

    async def starter() -> FakeCluster:
        await may_start.wait()
        return cluster

    app = create_app(make_settings(binary_dir), kwok_starter=starter)
    async with app.router.lifespan_context(app):
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
            starting = await http.get(HEALTH_URL)
            assert (starting.status_code, starting.json()) == (503, {"status": "starting", "kwok": "starting"})
            refused = await call_asgi_without_lifespan(app, json.dumps(run_body()).encode())
            assert refused == (503, {"error": {"code": "tester_starting", "message": "The tester is starting. Retry shortly."}})

            may_start.set()
            for _ in range(1000):
                if app.state.kwok.state is KwokState.READY:
                    break
                await asyncio.sleep(0.001)
            ready = await http.get(HEALTH_URL)
            assert (ready.status_code, ready.json()) == (200, {"status": "ok", "kwok": "ready"})
            assert app.state.kwok.kubeconfig == str(cluster.kubeconfig)
    assert cluster.stopped


async def call_asgi_without_lifespan(app, body: bytes) -> tuple[int, object]:  # noqa: ANN001
    """POST a run straight to the app (its lifespan already running), failing
    if the body is read."""
    sent: dict = {}

    async def receive() -> dict:
        raise AssertionError("the body was read")

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            sent["status"] = message["status"]
        elif message["type"] == "http.response.body":
            sent["body"] = sent.get("body", b"") + message.get("body", b"")

    headers = [(b"authorization", f"Bearer {auth_headers()['Authorization'].split(' ', 1)[1]}".encode())]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": RUNS_URL,
        "raw_path": RUNS_URL.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers + [(b"content-length", str(len(body)).encode())],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
        "app": app,
    }
    await app(scope, receive, send)
    return sent["status"], json.loads(sent["body"])


async def test_a_start_that_fails_every_attempt_refuses_runs_and_reports_unavailable(binary_dir: Path) -> None:
    """Three attempts, all failing: health says `unavailable`/`failed`, and a
    run is refused before its body is read (Ruling 26: never served without
    kwok, even one that needs no cluster)."""
    write_collector(binary_dir, VERSION, "exec sleep 600\n")
    attempts = []

    async def starter() -> None:
        attempts.append(1)
        raise RuntimeError("kwokctl: /home/otelcol-testing/.kwok exploded")

    app = create_app(make_settings(binary_dir, kwok_retry_backoff_seconds=(0.0,)), kwok_starter=starter)
    async with app.router.lifespan_context(app):
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
            for _ in range(1000):
                if app.state.kwok.state is not KwokState.STARTING:
                    break
                await asyncio.sleep(0.001)
            health = await http.get(HEALTH_URL)
            assert (health.status_code, health.json()) == (503, {"status": "unavailable", "kwok": "failed"})
            refused = await call_asgi_without_lifespan(app, json.dumps(run_body()).encode())
            assert refused == (
                503,
                {
                    "error": {
                        "code": "tester_unavailable",
                        "message": "The tester is unavailable: its fake Kubernetes cluster isn't running.",
                    }
                },
            )
    assert len(attempts) == 3
    assert app.state.kwok.kubeconfig is None


async def test_a_failed_start_is_retried_after_its_backoff_and_can_still_come_up() -> None:
    """Two failures, then a cluster: still `starting` between attempts, the
    backoffs are the ruling's (2 s, then 4 s; the sleep is recorded, not
    waited), and the third attempt makes it ready."""
    cluster = FakeCluster(Path("/nowhere/kubeconfig.yaml"))
    outcomes = [RuntimeError("first"), RuntimeError("second"), cluster]
    states: list[KwokState] = []
    slept: list[float] = []
    supervisor = KwokSupervisor()

    async def starter() -> FakeCluster:
        states.append(supervisor.state)
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def recorded(seconds: float) -> None:
        slept.append(seconds)

    supervisor = KwokSupervisor(starter, sleep=recorded)
    supervisor.start()
    for _ in range(1000):
        if supervisor.state is not KwokState.STARTING:
            break
        await asyncio.sleep(0.001)

    assert states == [KwokState.STARTING] * 3
    assert slept == [2.0, 4.0]
    assert supervisor.state is KwokState.READY
    assert supervisor.failures == 2
    assert supervisor.kubeconfig == str(cluster.kubeconfig)
    await supervisor.stop()


async def test_giving_up_calls_its_hook_once_and_the_service_exits_non_zero_from_it() -> None:
    gave_up: list[int] = []

    async def starter() -> None:
        raise OSError("no kwok here")

    supervisor = KwokSupervisor(starter, attempts=3, backoff_seconds=(0.0,), on_gave_up=lambda: gave_up.append(1))
    supervisor.start()
    for _ in range(1000):
        if supervisor.state is not KwokState.STARTING:
            break
        await asyncio.sleep(0.001)

    assert supervisor.state is KwokState.FAILED
    assert gave_up == [1]


SERVE_WITH_A_FAILING_KWOK = """
import asyncio, sys
from pathlib import Path
import uvicorn
from app.main import create_app
from tests.conftest import make_settings

async def starter():
    raise RuntimeError("kwok can't start here")

app = create_app(
    make_settings(Path(sys.argv[1]), kwok_retry_backoff_seconds=(0.0,)),
    kwok_starter=starter,
    exit_on_kwok_failure=True,
)
uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")).run()
print("uvicorn returned", flush=True)
"""


def test_the_service_exits_with_a_non_zero_status_once_kwok_has_failed_every_attempt(binary_dir: Path) -> None:
    """The real path, in a real server: three failed starts end the process
    with status 1, after uvicorn's graceful shutdown (so compose's restart
    policy starts the tester afresh)."""
    process = subprocess.run(
        [sys.executable, "-c", SERVE_WITH_A_FAILING_KWOK, str(binary_dir)],
        cwd=guard.SERVICE_ROOT,
        capture_output=True,
        text=True,
        timeout=guard.GUARD_SECONDS,  # a hang guard
    )

    assert process.returncode == 1, process.stderr
    assert "uvicorn returned" not in process.stdout
    assert "kwok failed to start 3 times" in process.stderr


async def test_the_clusters_endpoint_reaches_the_runs_child(binary_dir: Path, tmp_path: Path) -> None:
    """The kubeconfig, the apiserver's URL, the seed pod's live uid and the
    certificates' directory travel to the run's child (the informer wait and
    the filelog staging path use them)."""
    seen = tmp_path / "request.json"
    write_collector(binary_dir, VERSION, "exit 0\n")
    cluster = FakeCluster(tmp_path / "kwok" / "kubeconfig.yaml")
    cluster.apiserver_url = "https://127.0.0.1:32766"
    cluster.seed_pod_uid = "0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d"
    cluster.pki_dir = tmp_path / "kwok" / "pki"

    async def starter() -> FakeCluster:
        return cluster

    recording_child = (
        f"# {guard.CHILD_MARK} recording\n"
        "import json, sys\n"
        "document = json.loads(sys.stdin.buffer.read())\n"
        f"open({str(seen)!r}, 'w').write(json.dumps(document))\n"
        "sys.stdout.write(json.dumps({'failure': 'Recorded'}))\n"
    )
    original = runner.RUN_COMMAND
    runner.RUN_COMMAND = (sys.executable, "-c", recording_child)
    try:
        app = create_app(make_settings(binary_dir), kwok_starter=starter)
        await call_asgi(app, "POST", RUNS_URL, auth_headers(), [json.dumps(run_body()).encode()])
    finally:
        runner.RUN_COMMAND = original

    request = json.loads(seen.read_text())
    assert request["kubeconfig"] == str(cluster.kubeconfig)
    assert request["apiserverUrl"] == "https://127.0.0.1:32766"
    assert request["seedPodUid"] == "0072e35f-9f5e-48ce-9fa2-a9a3fd7a5e7d"
    assert request["kwokPki"] == str(cluster.pki_dir)


async def test_the_default_starter_has_no_cluster_and_is_ready_at_once() -> None:
    supervisor = KwokSupervisor(no_cluster)
    supervisor.start()
    await asyncio.sleep(0)

    assert supervisor.state is KwokState.READY
    assert supervisor.kubeconfig is None
    await supervisor.stop()


async def test_a_start_still_running_at_shutdown_is_cancelled() -> None:
    started = asyncio.Event()

    async def forever() -> None:
        started.set()
        await asyncio.Event().wait()

    supervisor = KwokSupervisor(forever)
    supervisor.start()
    await started.wait()
    await supervisor.stop()

    assert supervisor.state is KwokState.STARTING
    assert supervisor.cluster is None


async def test_the_kubeconfig_is_scrubbed_from_answers(binary_dir: Path, tmp_path: Path) -> None:
    kubeconfig = tmp_path / "kwok-home" / "clusters" / "telflo-test" / "kubeconfig.yaml"
    write_fake_collector(binary_dir, VERSION, prelude=f"sys.stderr.write('using {kubeconfig}\\n')\n")

    async def starter() -> FakeCluster:
        return FakeCluster(kubeconfig)

    app = create_app(make_settings(binary_dir), kwok_starter=starter)
    result = await call_asgi(app, "POST", RUNS_URL, auth_headers(), [json.dumps(run_body()).encode()])

    assert result.status == 200
    assert str(kubeconfig) not in result.body.decode()
    assert "using <kubeconfig>" in result.json()["logs"]


# ---------------------------------------------------------------------------
# Ruling 29: a ready cluster's liveness, re-checked on health and before each
# run
# ---------------------------------------------------------------------------


class ProbedCluster(FakeCluster):
    """A cluster with a liveness probe the test controls: ``alive`` is what
    it answers, ``gate`` (when set) holds each probe until it is opened."""

    def __init__(self, kubeconfig: Path) -> None:
        super().__init__(kubeconfig)
        self.alive = True
        self.probes = 0
        self.gate: asyncio.Event | None = None

    async def is_alive(self) -> bool:
        self.probes += 1
        if self.gate is not None:
            await self.gate.wait()
        return self.alive


async def _ready(app) -> None:  # noqa: ANN001
    for _ in range(1000):
        if app.state.kwok.state is not KwokState.STARTING:
            break
        await asyncio.sleep(0.001)
    assert app.state.kwok.state is KwokState.READY


async def test_a_cluster_that_stops_answering_refuses_runs_and_fails_health(binary_dir: Path, tmp_path: Path) -> None:
    write_collector(binary_dir, VERSION, "exec sleep 600\n")
    cluster = ProbedCluster(tmp_path / "kwok" / "kubeconfig.yaml")

    async def starter() -> ProbedCluster:
        return cluster

    app = create_app(make_settings(binary_dir), kwok_starter=starter)
    async with app.router.lifespan_context(app):
        await _ready(app)
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
            ready = await http.get(HEALTH_URL)
            assert (ready.status_code, ready.json()) == (200, {"status": "ok", "kwok": "ready"})
            assert cluster.probes == 1

            cluster.alive = False
            # One stall isn't a dead cluster (Ruling 33): still ready.
            stalled = await http.get(HEALTH_URL)
            assert (stalled.status_code, stalled.json()) == (200, {"status": "ok", "kwok": "ready"})
            assert (cluster.probes, app.state.kwok.liveness_failures) == (2, 1)
            # The run re-checks first, before its body is read: the second
            # failure in a row.
            refused = await call_asgi_without_lifespan(app, json.dumps(run_body()).encode())
            assert refused == (
                503,
                {
                    "error": {
                        "code": "tester_unavailable",
                        "message": "The tester is unavailable: its fake Kubernetes cluster isn't running.",
                    }
                },
            )
            assert cluster.probes == 3
            assert app.state.kwok.state is KwokState.FAILED
            failed = await http.get(HEALTH_URL)
            assert (failed.status_code, failed.json()) == (503, {"status": "unavailable", "kwok": "failed"})
            assert cluster.probes == 3  # failed for good: no more probes
            assert app.state.kwok.endpoint is None


async def test_health_alone_finds_a_dead_cluster(binary_dir: Path, tmp_path: Path) -> None:
    write_collector(binary_dir, VERSION, "exec sleep 600\n")
    cluster = ProbedCluster(tmp_path / "kwok" / "kubeconfig.yaml")
    cluster.alive = False

    async def starter() -> ProbedCluster:
        return cluster

    app = create_app(make_settings(binary_dir), kwok_starter=starter)
    async with app.router.lifespan_context(app):
        await _ready(app)
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:
            first = await http.get(HEALTH_URL)
            second = await http.get(HEALTH_URL)
        assert (first.status_code, first.json()) == (200, {"status": "ok", "kwok": "ready"})
        assert (second.status_code, second.json()) == (503, {"status": "unavailable", "kwok": "failed"})
    assert cluster.stopped


async def test_overlapping_checks_share_one_probe_and_give_up_once() -> None:
    cluster = ProbedCluster(Path("/nowhere/kubeconfig.yaml"))
    cluster.gate = asyncio.Event()
    cluster.alive = False
    gave_up: list[int] = []

    async def starter() -> ProbedCluster:
        return cluster

    supervisor = KwokSupervisor(starter, on_gave_up=lambda: gave_up.append(1))
    supervisor.start()
    await asyncio.sleep(0)
    assert supervisor.state is KwokState.READY

    checks = [asyncio.ensure_future(supervisor.check_alive()) for _ in range(3)]
    for _ in range(1000):
        if cluster.probes:
            break
        await asyncio.sleep(0.001)
    cluster.gate.set()
    states = await asyncio.gather(*checks)

    # One probe for the three, one failure: still ready (Ruling 33).
    assert states == [KwokState.READY] * 3
    assert (cluster.probes, supervisor.liveness_failures, gave_up) == (1, 1, [])
    states = await asyncio.gather(*[supervisor.check_alive() for _ in range(3)])
    assert states == [KwokState.FAILED] * 3
    assert (cluster.probes, gave_up) == (2, [1])
    assert await supervisor.check_alive() is KwokState.FAILED
    assert (cluster.probes, gave_up) == (2, [1])
    await supervisor.stop()


async def test_a_live_cluster_stays_ready_and_a_probe_that_raises_counts_as_dead() -> None:
    cluster = ProbedCluster(Path("/nowhere/kubeconfig.yaml"))

    async def starter() -> ProbedCluster:
        return cluster

    supervisor = KwokSupervisor(starter)
    supervisor.start()
    await asyncio.sleep(0)
    assert await supervisor.check_alive() is KwokState.READY
    assert await supervisor.check_alive() is KwokState.READY
    assert cluster.probes == 2

    async def explodes() -> bool:
        raise OSError("/home/otelcol-testing/.kwok: gone")

    cluster.is_alive = explodes  # type: ignore[method-assign]
    assert await supervisor.check_alive() is KwokState.READY  # one failure
    assert await supervisor.check_alive() is KwokState.FAILED
    await supervisor.stop()


async def test_a_cancelled_check_leaves_its_probe_to_finish() -> None:
    cluster = ProbedCluster(Path("/nowhere/kubeconfig.yaml"))
    cluster.gate = asyncio.Event()
    cluster.alive = False

    async def starter() -> ProbedCluster:
        return cluster

    supervisor = KwokSupervisor(starter)
    supervisor.start()
    await asyncio.sleep(0)
    check = asyncio.ensure_future(supervisor.check_alive())
    for _ in range(1000):
        if cluster.probes:
            break
        await asyncio.sleep(0.001)
    check.cancel()
    cluster.gate.set()
    for _ in range(1000):
        if supervisor.liveness_failures:
            break
        await asyncio.sleep(0.001)

    assert check.cancelled()
    assert (supervisor.liveness_failures, supervisor.state) == (1, KwokState.READY)
    assert await supervisor.check_alive() is KwokState.FAILED
    await supervisor.stop()


async def test_one_stall_is_tolerated_and_two_failures_in_a_row_fail_kwok() -> None:
    """Ruling 33 (a single ~3 s stall restarted the tester): a probe that
    fails once, between answers, leaves kwok ready and the count is reset by
    the next answer; only two failures in a row fail it, and give up once."""
    answers = [False, True, False, True, True, False, False]
    probes: list[bool] = []
    gave_up: list[int] = []

    class Stalling(FakeCluster):
        async def is_alive(self) -> bool:
            probes.append(answers[len(probes)])
            return probes[-1]

    cluster = Stalling(Path("/nowhere/kubeconfig.yaml"))

    async def starter() -> Stalling:
        return cluster

    supervisor = KwokSupervisor(starter, on_gave_up=lambda: gave_up.append(1))
    supervisor.start()
    await asyncio.sleep(0)

    states = [await supervisor.check_alive() for _ in answers]

    assert states == [KwokState.READY] * 6 + [KwokState.FAILED]
    assert gave_up == [1]
    assert supervisor.liveness_failures == 2
    await supervisor.stop()


SERVE_WITH_A_DYING_KWOK = """
import sys
from pathlib import Path
import uvicorn
from app.main import create_app
from tests.conftest import make_settings

class Dead:
    kubeconfig = "/nowhere/kubeconfig.yaml"
    async def is_alive(self):
        return False
    async def stop(self):
        pass

async def starter():
    return Dead()

app = create_app(make_settings(Path(sys.argv[1])), kwok_starter=starter, exit_on_kwok_failure=True)
uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=int(sys.argv[2]), log_level="warning")).run()
print("uvicorn returned", flush=True)
"""


def test_the_service_exits_with_a_non_zero_status_once_its_cluster_stops_answering(binary_dir: Path) -> None:
    """The real path, in a real server: kwok came up, then its cluster stopped
    answering; the second health request in a row that finds it (Ruling 33)
    fails kwok, and the process ends with status 1 after uvicorn's graceful
    shutdown (Ruling 26's exit)."""
    import socket
    import time

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    process = subprocess.Popen(
        [sys.executable, "-c", SERVE_WITH_A_DYING_KWOK, str(binary_dir), str(port)],
        cwd=guard.SERVICE_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        answers: list = []
        deadline = time.monotonic() + guard.GUARD_SECONDS  # a hang guard
        while (not answers or answers[-1].status_code == 200) and process.poll() is None and time.monotonic() < deadline:
            try:
                answers.append(httpx2.get(f"http://127.0.0.1:{port}/testing/v1/health", timeout=5.0, trust_env=False))
            except httpx2.TransportError:
                time.sleep(0.05)
        answered = answers[-1] if answers else None
        stdout, stderr = process.communicate(timeout=guard.GUARD_SECONDS)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()

    assert answered is not None
    assert [a.status_code for a in answers] == [200, 503]
    assert (answered.status_code, answered.json()) == (503, {"status": "unavailable", "kwok": "failed"})
    assert process.returncode == 1, stderr
    assert "uvicorn returned" not in stdout
    assert "kwok's cluster stopped answering" in stderr
