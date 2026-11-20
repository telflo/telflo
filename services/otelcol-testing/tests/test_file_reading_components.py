"""Processors that read files the text names: every run's collector runs as
the same user in the same container, so a processor that reads a path from
the text could read another run's files or the tester's and pass them on.

- R-106: resourcedetection's ``consul``, ``openshift`` and ``docker``
  detectors are stripped, with their own settings, from either spelling of
  the processor (``resource_detection``, ``resourcedetection``); a
  processor left with no detectors is removed and unwired, as R-101 and
  R-103 do (which now match both spellings too).
- C-005: a ``geoip`` processor is refused (its database is a file; the
  catalogue knows it by that one spelling).

- C-006: any other processor setting whose key ends in ``_file`` or ``_path``
  and holds a value, at any depth, is refused.

The "no path outside the workspace survives the mutations" test walks the
processors too (`tests/test_run_fixes.py`).
"""

from __future__ import annotations

import json
from pathlib import Path
from textwrap import dedent

import pytest
from fastapi.testclient import TestClient
from ruamel.yaml import YAML

from app.compatibility import check_compatibility
from app.main import create_app
from app.settings import DEFAULT_CATALOG_DIR
from app.yaml_mutations import (
    RESOURCE_DETECTION_TYPES,
    MutationAdvisory,
    MutationContext,
    mutate_for_operator_test,
    mutate_for_otlp_replay,
    strip_cloud_detectors,
    strip_in_cluster_detectors,
    strip_service_detectors,
)
from tests.conftest import RUNS_URL, VERSION, auth_headers, make_settings, run_body, write_fake_collector

SPELLINGS = sorted(RESOURCE_DETECTION_TYPES)
DETECTORS = ("consul", "openshift", "docker")

SETTINGS = {
    "consul": "    consul:\n      address: http://127.0.0.1:20001\n      token_file: /run/secrets/otelcol_testing_secret\n",
    "openshift": (
        "    openshift:\n      address: https://127.0.0.1:20002\n"
        "      tls: {ca_file: /tmp/otelcol-run-another/input.raw, cert_file: /x/c, key_file: /x/k}\n"
    ),
    "docker": "    docker:\n      resource_attributes: {host.name: {enabled: true}}\n",
}


def _ctx() -> MutationContext:
    return MutationContext(signal_type="logs", output_path=Path("/tmp/out"))


def _doc(spelling: str, detectors: list[str], *, settings: tuple[str, ...] = ()) -> dict:
    text = (
        "processors:\n"
        f"  {spelling}/r:\n"
        f"    detectors: [{', '.join(detectors)}]\n"
        + "".join(SETTINGS[name] for name in settings)
        + "  batch: {}\n"
        "service:\n  pipelines:\n"
        f"    logs: {{processors: [{spelling}/r, batch]}}\n"
        f"    logs/2: {{processors: [batch, {spelling}/r]}}\n"
    )
    return YAML().load(text)


@pytest.mark.parametrize("spelling", SPELLINGS)
@pytest.mark.parametrize("detector", DETECTORS)
def test_each_service_detector_alone_removes_the_processor_and_unwires_it(spelling: str, detector: str) -> None:
    doc = _doc(spelling, [detector], settings=(detector,))
    advisories: list[MutationAdvisory] = []

    strip_service_detectors(doc, _ctx(), advisories)

    assert f"{spelling}/r" not in doc["processors"]
    assert doc["service"]["pipelines"]["logs"]["processors"] == ["batch"]
    assert doc["service"]["pipelines"]["logs/2"]["processors"] == ["batch"]
    [advisory] = advisories
    assert (advisory.id, advisory.severity) == ("R-106", "warn")
    assert advisory.details == {
        "trimmed": [],
        "removed_processors": [{"processor": f"{spelling}/r", "removed_detectors": [detector]}],
        "removed_settings": [],
    }
    assert advisory.message.startswith(
        f"Removed 1 resourcedetection processor(s) entirely because all their detectors query a service "
        f"outside the collector: {spelling}/r (had: {detector}) "
    )
    assert "could read files" in advisory.message
    assert "no Consul agent, OpenShift API server or Docker daemon" in advisory.message


@pytest.mark.parametrize("spelling", SPELLINGS)
@pytest.mark.parametrize("detector", DETECTORS)
def test_each_service_detector_mixed_with_others_is_trimmed_with_its_settings(spelling: str, detector: str) -> None:
    doc = _doc(spelling, ["env", detector, "system"], settings=(detector,))
    advisories: list[MutationAdvisory] = []

    strip_service_detectors(doc, _ctx(), advisories)

    cfg = doc["processors"][f"{spelling}/r"]
    assert cfg["detectors"] == ["env", "system"]
    assert detector not in cfg
    assert doc["service"]["pipelines"]["logs"]["processors"] == [f"{spelling}/r", "batch"]
    [advisory] = advisories
    assert advisory.details["trimmed"] == [{"processor": f"{spelling}/r", "removed_detectors": [detector]}]
    assert advisory.details["removed_processors"] == []
    assert advisory.message.startswith(
        "Stripped detectors that query a service outside the collector from 1 resourcedetection "
        f"processor(s): {spelling}/r (removed: {detector}) "
    )


@pytest.mark.parametrize("spelling", SPELLINGS)
def test_all_three_with_others_and_settings_leave_only_the_others(spelling: str) -> None:
    doc = _doc(spelling, ["consul", "env", "openshift", "docker"], settings=DETECTORS)
    advisories: list[MutationAdvisory] = []

    strip_service_detectors(doc, _ctx(), advisories)

    assert dict(doc["processors"][f"{spelling}/r"]) == {"detectors": ["env"]}
    [advisory] = advisories
    assert advisory.details["trimmed"] == [
        {"processor": f"{spelling}/r", "removed_detectors": ["consul", "openshift", "docker"]}
    ]


@pytest.mark.parametrize("spelling", SPELLINGS)
def test_settings_of_a_service_detector_that_isnt_listed_are_removed_too(spelling: str) -> None:
    doc = _doc(spelling, ["env"], settings=("consul", "openshift"))
    advisories: list[MutationAdvisory] = []

    strip_service_detectors(doc, _ctx(), advisories)

    assert dict(doc["processors"][f"{spelling}/r"]) == {"detectors": ["env"]}
    [advisory] = advisories
    assert advisory.details["removed_settings"] == [{"processor": f"{spelling}/r", "detectors": ["consul", "openshift"]}]
    assert advisory.message.startswith(
        "Removed the settings of detectors your config doesn't run from 1 resourcedetection processor(s): "
        f"{spelling}/r (consul, openshift) "
    )


def test_no_service_detector_no_advisory_and_nothing_changed() -> None:
    doc = _doc("resource_detection", ["env", "system", "gcp"])
    advisories: list[MutationAdvisory] = []

    strip_service_detectors(doc, _ctx(), advisories)

    assert advisories == []
    assert doc["processors"]["resource_detection/r"]["detectors"] == ["env", "system", "gcp"]


def test_other_processors_with_the_same_settings_names_are_left_alone() -> None:
    doc = YAML().load("processors:\n  attributes/consul: {consul: {token_file: x}, actions: []}\n")
    advisories: list[MutationAdvisory] = []

    strip_service_detectors(doc, _ctx(), advisories)

    assert advisories == []
    assert "consul" in doc["processors"]["attributes/consul"]


@pytest.mark.parametrize("spelling", SPELLINGS)
def test_r101_and_r103_match_both_spellings(spelling: str) -> None:
    doc = _doc(spelling, ["k8snode", "ec2", "env"])
    advisories: list[MutationAdvisory] = []

    strip_in_cluster_detectors(doc, _ctx(), advisories)
    strip_cloud_detectors(doc, _ctx(), advisories)

    assert [a.id for a in advisories] == ["R-101", "R-103"]
    assert doc["processors"][f"{spelling}/r"]["detectors"] == ["env"]


TEXT = dedent(
    """
    receivers:
      otlp: {protocols: {http: {}}}
    processors:
      resource_detection:
        detectors: [env, consul]
        consul: {token_file: /run/secrets/otelcol_testing_secret}
      resourcedetection/2:
        detectors: [openshift, docker]
        openshift: {tls: {ca_file: /home/otelcol-testing/.kwok/clusters/telflo-test/pki/admin.key}}
    exporters:
      debug: {}
    service:
      pipelines:
        logs: {receivers: [otlp], processors: [resource_detection, resourcedetection/2], exporters: [debug]}
    """
)


def test_both_orchestrators_strip_them() -> None:
    otlp, otlp_advisories = mutate_for_otlp_replay(TEXT, "logs", Path("/tmp/out"), 20001)
    filelog_text = TEXT.replace("otlp: {protocols: {http: {}}}", "filelog: {include: [/x]}").replace(
        "receivers: [otlp]", "receivers: [filelog]"
    )
    operator, operator_advisories = mutate_for_operator_test(filelog_text, "logs", Path("/tmp/out"), Path("/tmp/in"), None)

    for mutated, advisories in ((otlp, otlp_advisories), (operator, operator_advisories)):
        doc = YAML(typ="safe").load(mutated)
        assert doc["processors"]["resource_detection"] == {"detectors": ["env"]}
        assert "resourcedetection/2" not in doc["processors"]
        assert doc["service"]["pipelines"]["logs"]["processors"] == ["resource_detection"]
        assert "R-106" in [a.id for a in advisories]
        assert "/run/secrets" not in mutated and ".kwok" not in mutated


# ---------------------------------------------------------------------------
# C-005: geoip refused
# ---------------------------------------------------------------------------

GEOIP = dedent(
    """
    receivers:
      otlp: {protocols: {http: {}}}
    processors:
      NAME:
        context: resource
        providers:
          maxmind:
            database_path: /tmp/otelcol-run-another/input.raw
    exporters:
      debug: {}
    service:
      pipelines:
        logs: {receivers: [otlp], processors: [NAME], exporters: [debug]}
    """
)


@pytest.mark.parametrize("name", ["geoip", "geoip/city"])
def test_a_geoip_processor_is_refused(name: str) -> None:
    text = GEOIP.replace("NAME", name)

    issues = check_compatibility(text, signal_type="logs", target_pipeline="logs")

    [issue] = issues
    assert (issue.id, issue.severity, issue.component) == ("C-005", "refuse", name)
    assert issue.details == {"processor": name, "base": "geoip"}
    assert issue.message == (
        f"{name} looks addresses up in a GeoIP database file, and the sandbox has no such database "
        "(a test can't read files from the sandbox). Test this processor in a real collector deployment."
    )


def test_a_geoip_processor_outside_the_pipeline_under_test_is_refused_too() -> None:
    text = (
        "receivers:\n  otlp: {protocols: {http: {}}}\n"
        "processors:\n  geoip: {}\n  batch: {}\n"
        "exporters:\n  debug: {}\n"
        "service:\n  pipelines:\n"
        "    logs: {receivers: [otlp], processors: [batch], exporters: [debug]}\n"
        "    traces: {receivers: [otlp], processors: [geoip], exporters: [debug]}\n"
    )

    assert [issue.id for issue in check_compatibility(text, signal_type="logs", target_pipeline="logs")] == ["C-005"]


def test_the_catalogue_knows_each_refused_processor_by_one_spelling() -> None:
    """If the catalogue ever renames geoip, schema or remotetap, C-005 must
    learn the new name."""
    catalogue = DEFAULT_CATALOG_DIR / "otelcol-contrib.json"
    renamed = json.loads(catalogue.read_text())["renamedTypes"]
    for refused in ("geoip", "schema", "remotetap"):
        assert not [entry for entry in renamed if refused in (entry["name"], entry["deprecatedName"])], refused
    names = {entry["name"] for entry in renamed if entry["kind"] == "processor"} | {
        entry["deprecatedName"] for entry in renamed if entry["kind"] == "processor"
    }
    assert RESOURCE_DETECTION_TYPES <= names


REFUSED_OUTRIGHT = {
    "schema": (
        "  {name}:\n    prefetch: ['file:///run/secrets/otelcol_testing_secret']\n"
        "    tls: {{key_file: /run/secrets/otelcol_testing_secret}}\n",
        "{name} fetches schema files from URLs (file:// included), which the sandbox can't reach or open "
        "(a test can't read files or reach the network from the sandbox). Test this processor in a real "
        "collector deployment.",
    ),
    "remotetap": (
        "  {name}:\n    endpoint: /tmp/otelcol-run-another/tap.sock\n    tls: {{cert_file: /a/c}}\n",
        "{name} starts its own server (on a port or a unix socket path), which the sandbox doesn't run. "
        "Test this processor in a real collector deployment.",
    ),
}


@pytest.mark.parametrize("name", ["schema", "schema/x", "remotetap", "remotetap/x"])
def test_schema_and_remotetap_are_refused_outright(name: str) -> None:
    """C-005, each with its own message; their file settings are
    left to it (no C-006 beside), and the message holds no value."""
    block, message = REFUSED_OUTRIGHT[name.split("/", 1)[0]]
    text = _processors(block.format(name=name))

    [issue] = check_compatibility(text, signal_type="logs", target_pipeline="logs")

    assert (issue.id, issue.severity, issue.component) == ("C-005", "refuse", name)
    assert issue.details == {"processor": name, "base": name.split("/", 1)[0]}
    assert issue.message == message.format(name=name)
    assert "/run/secrets" not in issue.model_dump_json() and "tap.sock" not in issue.model_dump_json()


def test_a_geoip_run_is_refused_before_any_collector_starts(binary_dir: Path, tmp_path: Path) -> None:
    started = tmp_path / "started"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(started)!r}, 'w').close()\n")
    text = GEOIP.replace("NAME", "geoip")
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = client.post(RUNS_URL, json=run_body(yaml=text), headers=auth_headers()).json()

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert answer["error"]["message"].startswith("sandbox refused to run pipeline: C-005 geoip: ")
    assert [issue["id"] for issue in answer["compatibility"]] == ["C-005"]
    assert not started.exists()
    assert "/tmp/otelcol-run-another" not in str(answer)


# ---------------------------------------------------------------------------
# C-006: any processor setting that names a file
# ---------------------------------------------------------------------------

SECRET_PATH = "/run/secrets/otelcol_testing_secret"


def _processors(block: str) -> str:
    """A text whose `processors:` holds ``block`` (as `p:` lines), on the
    pipeline under test."""
    names = [line.split(":", 1)[0].strip() for line in block.splitlines() if line.startswith("  ") and not line.startswith("   ")]
    return (
        "receivers:\n  otlp: {protocols: {http: {}}}\n"
        "processors:\n" + block
        + "exporters:\n  debug: {}\n"
        "service:\n  pipelines:\n"
        f"    logs: {{receivers: [otlp], processors: [{', '.join(names)}], exporters: [debug]}}\n"
    )


def _c006(text: str) -> list[tuple[str, str]]:
    issues = check_compatibility(text, signal_type="logs", target_pipeline="logs")
    assert all(issue.id == "C-006" and issue.severity == "refuse" for issue in issues), issues
    return [(issue.component, issue.details["key"]) for issue in issues]


NAMED_CASES = {
    "resource_detection's own tls": (
        f"  resource_detection:\n    detectors: [env]\n    tls: {{ca_file: {SECRET_PATH}}}\n",
        [("resource_detection", "tls.ca_file")],
    ),
    "resourcedetection's own tls, every file": (
        f"  resourcedetection/x:\n    detectors: [env]\n"
        f"    tls: {{ca_file: {SECRET_PATH}, cert_file: /a/c, key_file: /a/k}}\n",
        [("resourcedetection/x", "tls.ca_file"), ("resourcedetection/x", "tls.cert_file"), ("resourcedetection/x", "tls.key_file")],
    ),
    # Refused though R-106 would strip them.
    "consul's token_file": (
        f"  resourcedetection:\n    detectors: [env, consul]\n    consul: {{token_file: {SECRET_PATH}}}\n",
        [("resourcedetection", "consul.token_file")],
    ),
    "openshift's tls, listed or not": (
        f"  resource_detection/o:\n    detectors: [system]\n    openshift: {{tls: {{ca_file: {SECRET_PATH}, key_file: /a/k}}}}\n",
        [("resource_detection/o", "openshift.tls.ca_file"), ("resource_detection/o", "openshift.tls.key_file")],
    ),
    "a nested key": (
        f"  transform/deep:\n    a:\n      b:\n        c: {{secret_path: {SECRET_PATH}}}\n",
        [("transform/deep", "a.b.c.secret_path")],
    ),
    "a key inside a list": (
        f"  attributes:\n    actions:\n      - {{key: x, action: insert, value: y}}\n      - {{token_file: {SECRET_PATH}}}\n",
        [("attributes", "actions[1].token_file")],
    ),
}


@pytest.mark.parametrize("case", sorted(NAMED_CASES))
def test_a_processor_setting_that_names_a_file_is_refused(case: str) -> None:
    block, expected = NAMED_CASES[case]

    assert _c006(_processors(block)) == expected


def test_the_message_names_the_processor_and_the_key_never_the_value() -> None:
    block, _ = NAMED_CASES["resource_detection's own tls"]

    [issue] = check_compatibility(_processors(block), signal_type="logs", target_pipeline="logs")

    assert issue.message == (
        "resource_detection sets `tls.ca_file`, which names a file, and the sandbox can't give a test run "
        "access to files. Remove it to test this processor here, or test it in a real collector deployment."
    )
    assert issue.details == {"processor": "resource_detection", "key": "tls.ca_file"}
    assert SECRET_PATH not in issue.model_dump_json()
    assert "otelcol_testing_secret" not in issue.model_dump_json()


@pytest.mark.parametrize("value", ["", '""', "null", "~", "[]", "{}"])
def test_an_unset_or_empty_setting_passes(value: str) -> None:
    text = _processors(f"  resource_detection:\n    detectors: [env]\n    tls: {{ca_file: {value}, insecure: true}}\n")

    assert check_compatibility(text, signal_type="logs", target_pipeline="logs") == []


def test_keys_that_only_contain_file_or_path_pass() -> None:
    text = _processors("  attributes:\n    actions: [{key: log.file.path, from_attribute: file_path_x, action: upsert}]\n    path: /x\n")

    assert check_compatibility(text, signal_type="logs", target_pipeline="logs") == []


def test_r106s_settings_are_refused_and_the_other_refusals_keep_their_own() -> None:
    """Consul's and openshift's file settings are refused (C-006)
    though R-106 would strip them; geoip keeps C-005 alone, kube_config_path
    C-002 alone."""
    text = _processors(
        f"  resource_detection:\n    detectors: [env, consul]\n    consul: {{token_file: {SECRET_PATH}}}\n"
        f"    openshift: {{tls: {{ca_file: {SECRET_PATH}}}}}\n"
        f"  geoip:\n    providers: {{maxmind: {{database_path: {SECRET_PATH}}}}}\n"
        f"  k8sattributes:\n    kube_config_path: {SECRET_PATH}\n"
    )

    issues = check_compatibility(text, signal_type="logs", target_pipeline="logs")

    assert [(issue.id, issue.component, issue.details.get("key")) for issue in issues] == [
        ("C-002", "k8sattributes", None),
        ("C-005", "geoip", None),
        ("C-006", "resource_detection", "consul.token_file"),
        ("C-006", "resource_detection", "openshift.tls.ca_file"),
    ]


def test_a_run_whose_processor_names_the_secrets_file_is_refused_before_any_collector_starts(
    binary_dir: Path, tmp_path: Path
) -> None:
    started = tmp_path / "started"
    write_fake_collector(binary_dir, VERSION, prelude=f"open({str(started)!r}, 'w').close()\n")
    block, _ = NAMED_CASES["resource_detection's own tls"]
    with TestClient(create_app(make_settings(binary_dir))) as client:
        answer = client.post(RUNS_URL, json=run_body(yaml=_processors(block)), headers=auth_headers()).json()

    assert answer["status"] == "failed"
    assert answer["error"]["code"] == "refused"
    assert answer["error"]["message"].startswith("sandbox refused to run pipeline: C-006 resource_detection: ")
    assert [issue["id"] for issue in answer["compatibility"]] == ["C-006"]
    assert answer["mutatedYaml"] is None
    assert not started.exists()
    assert SECRET_PATH not in json.dumps(answer)


# ---------------------------------------------------------------------------
# The final check walks the composed graph, through tags, and
# refuses what it can't read
# ---------------------------------------------------------------------------


def _final(text: str) -> list[tuple[str, str, str]]:
    from app.compatibility import final_file_settings

    return [(issue.id, issue.component, issue.details.get("key", "")) for issue in final_file_settings(text)]


@pytest.mark.parametrize(
    ("block", "expected"),
    [
        ("  p: !foo {tls: {ca_file: /x}}\n", [("p", "tls.ca_file")]),
        ("  p: !!map {tls: !!map {ca_file: !!str /x}}\n", [("p", "tls.ca_file")]),
        ("  p: {tls: {!foo ca_file: /x}}\n", [("p", "tls.ca_file")]),
        ("  p: {tls: {ca_file: !!int abc}}\n", [("p", "tls.ca_file")]),
        ("  p: {actions: !!seq [!bar {token_file: /x}]}\n", [("p", "actions[0].token_file")]),
        ("  p: {actions: [x, !baz [{key_path: /x}]]}\n", [("p", "actions[1][0].key_path")]),
        ("  p:\n    ? {key_file: /x}\n    : v\n", [("p", "?.key_file")]),
        ("  p:\n    ? [a]\n    : {token_file: /x}\n", [("p", "?.token_file")]),
        ("  !foo p: {database_path: /x}\n", [("p", "database_path")]),
    ],
    ids=[
        "a tagged configuration",
        "explicit core tags",
        "a tagged key",
        "an ill-fitting tag on the value",
        "a tagged sequence item",
        "a tagged nested sequence",
        "a mapping as a key",
        "a sequence as a key, its value walked",
        "a tagged processor name",
    ],
)
def test_the_final_check_sees_keys_and_values_under_tags(block: str, expected: list[tuple[str, str]]) -> None:
    assert _final("processors:\n" + block) == [("C-006", name, key) for name, key in expected]


def test_the_final_check_reads_processors_merged_in_and_ignores_empty_values() -> None:
    text = (
        "base: &tls\n  ca_file: /x\n"
        "more: &procs\n  q: {tls: *tls}\n"
        "processors:\n  <<: *procs\n  p: {tls: {ca_file: ~, cert_file: '', key_file: !foo ''}}\n"
    )

    assert _final(text) == [("C-006", "q", "tls.ca_file")]


@pytest.mark.parametrize(
    "text",
    [
        "processors: [unclosed\n",
        "a: 1\n---\nb: 2\n",
        "processors:\n" + "  " * 1 + "x: " + "[" * 150 + "]" * 150 + "\n",
        "a: &a [*a]\n",
    ],
    ids=["a parser error", "two documents", "too deep", "a node inside itself"],
)
def test_the_final_check_refuses_a_text_it_cant_compose(text: str) -> None:
    from app.compatibility import FINAL_UNREADABLE_MESSAGE, final_file_settings

    [issue] = final_file_settings(text)

    assert (issue.id, issue.severity, issue.component, issue.message) == (
        "C-000",
        "refuse",
        "<yaml>",
        FINAL_UNREADABLE_MESSAGE,
    )


# ---------------------------------------------------------------------------
# A tagged empty value: both passes agree that an empty value passes whatever
# its tag, and that a set one is refused
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    ["!foo ''", "!!str ''", '!foo ""', "!foo", "!!str", "!!binary ''", "!!null ''", "!foo []", "!foo {}", "!!seq []", "!!map {}"],
)
def test_an_empty_value_passes_both_checks_whatever_its_tag(value: str) -> None:
    text = _processors(f"  resource_detection:\n    detectors: [env]\n    tls:\n      ca_file: {value}\n      insecure: true\n")

    assert check_compatibility(text, signal_type="logs", target_pipeline="logs") == []
    assert _final(text) == []


@pytest.mark.parametrize("value", ["!foo /x", "!!str /x", "!foo [/x]", "!foo {a: /x}"])
def test_a_set_value_is_refused_by_both_checks_whatever_its_tag(value: str) -> None:
    text = _processors(f"  resource_detection:\n    detectors: [env]\n    tls:\n      ca_file: {value}\n")

    first = [(issue.id, issue.component, issue.details.get("key")) for issue in check_compatibility(text, signal_type="logs", target_pipeline="logs")]

    assert first == [("C-006", "resource_detection", "tls.ca_file")]
    assert _final(text) == [("C-006", "resource_detection", "tls.ca_file")]
