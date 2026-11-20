"""The organization's values filled in before every check: the port of the
opamp-server's fill-in against the shared corpus, the fill-in FIRST in
`_prepare_text`, the requirement rows, the 1 MiB refusal, and the request's
`organizationVariables`."""

from __future__ import annotations

import json
import tracemalloc
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import org_variables, runner
from app.main import MAX_BODY_BYTES, MAX_YAML_CHARACTERS, create_app
from app.requirements import NAME_OVER_LIMIT_DESCRIPTION
from tests.conftest import PASSING_COLLECTOR, VALIDATE_URL, auth_headers, make_settings, write_collector
from tests.test_openapi import check_request

CORPUS_PATH = Path(__file__).resolve().parents[3] / "vendor" / "opamp-server" / "org-token-corpus.json"
CORPUS = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
BINARY = Path("/fake/otelcol-contrib")


# ---------------------------------------------------------------------------
# The port, against the corpus
# ---------------------------------------------------------------------------


def test_the_corpus_is_where_the_ports_read_it() -> None:
    assert len(CORPUS["render"]) >= 26
    assert len(CORPUS["extract"]) >= 11


@pytest.mark.parametrize("row", CORPUS["render"], ids=[row["name"] for row in CORPUS["render"]])
def test_render_matches_the_corpus(row: dict) -> None:
    rendered, names = org_variables.render(row["text"], row["vars"])

    assert rendered == row["expected"]
    assert names == row["names"]
    assert org_variables.references(row["text"]) == row["names"]


@pytest.mark.parametrize("row", CORPUS["render"], ids=[row["name"] for row in CORPUS["render"]])
def test_the_rendered_length_is_the_filled_in_texts_utf8_length(row: dict) -> None:
    assert org_variables.rendered_length(row["text"], row["vars"]) == (
        len(row["expected"].encode("utf-8")),
        row["names"],
    )


@pytest.mark.parametrize("row", CORPUS["extract"], ids=[row["name"] for row in CORPUS["extract"]])
def test_references_match_the_corpus(row: dict) -> None:
    assert org_variables.references(row["text"]) == row["expected"]


def test_a_text_with_nothing_filled_in_comes_back_as_it_is() -> None:
    text = "a: ${org:MISSING}\nb: $${org:P}\n"
    rendered, _ = org_variables.render(text, {"P": "x"})
    assert rendered is text


@pytest.mark.parametrize(
    ("value", "written"),
    [("a$b", "a$$b"), ("$$", "$$$$"), ("${env:HOME}", "$${env:HOME}"), ("${org:P}", "$${org:P}"), ("$", "$$")],
)
def test_a_values_dollars_are_doubled(value: str, written: str) -> None:
    """Every `$` of a value written `$$`, so confmap's pass, which collapses
    `$$` to `$`, reads the value exactly."""
    rendered, _ = org_variables.render("a: ${org:P}\n", {"P": value})

    assert rendered == f"a: {written}\n"
    assert rendered.replace("$$", "$") == f"a: {value}\n"


# ---------------------------------------------------------------------------
# The fill-in comes first: every check reads the filled-in text
# ---------------------------------------------------------------------------


def _prepared(text: str, values: dict[str, str]) -> runner._Prepared:
    prepared = runner._prepare(text, None, values)
    assert isinstance(prepared, runner._Prepared), prepared
    return prepared


def _titles(requirements: list[dict]) -> list[str]:
    return [item["title"] for item in requirements]


def test_the_collector_reads_the_filled_in_text() -> None:
    prepared = _prepared('exporters:\n  otlp:\n    endpoint: "${org:EP}:4317"\n', {"EP": "a$b.example"})

    assert prepared.yaml_content == 'exporters:\n  otlp:\n    endpoint: "a$$b.example:4317"\n'


def test_a_value_whose_yaml_escape_spells_a_provider_is_neutralised() -> None:
    """A value holds no live `$` (each is doubled), but a double-quoted
    scalar decodes `\\x24` to `$`: filled in after the neutraliser, the
    collector would read a live `${file:}`. Filled in first, the neutraliser
    sees it like any other decoded reference."""
    text = 'exporters:\n  otlp:\n    endpoint: "${org:EP}"\n'

    prepared = _prepared(text, {"EP": "\\x24{file:/etc/canary}"})

    assert not runner._still_references(prepared.yaml_content)
    assert "/etc/canary" not in prepared.yaml_content
    assert "Non-env configuration providers were substituted" in _titles(prepared.before)


def test_a_value_that_adds_yaml_structure_is_checked_as_the_rest_of_the_text() -> None:
    """A value `x, tls: {…}` in a flow mapping adds a key. The checks read
    the filled-in text, so its TLS file is found."""
    text = "exporters: {otlp: {endpoint: ${org:EP}}}\n"

    prepared = _prepared(text, {"EP": "x, tls: {cert_file: /etc/otel/value.crt}"})

    assert "Provide /etc/otel/value.crt on the host" in _titles(prepared.scanned_requirements)


def test_a_value_that_breaks_the_yaml_is_unreadable_and_never_run() -> None:
    result = runner._prepare("exporters:\n  otlp:\n    endpoint: ${org:EP}\n", None, {"EP": "x: y"})

    assert isinstance(result, runner.ValidationResult)
    assert result.outcome == "unreadable"
    assert result.valid is False


async def test_the_check_runs_the_collector_on_the_filled_in_text(monkeypatch: pytest.MonkeyPatch) -> None:
    texts: list[str] = []

    async def collector(binary_path, yaml_content, env_overlay, *, timeout_seconds, directory=None):  # noqa: ANN001
        texts.append(yaml_content)
        return runner.RunOutcome(kind="passed", returncode=0)

    monkeypatch.setattr(runner, "run_collector", collector)

    result = await runner.check_text(
        BINARY,
        "exporters:\n  otlp:\n    endpoint: ${org:EP}\n",
        timeout_seconds=10,
        organization_variables={"EP": "filled.example:4317"},
    )

    assert texts == ["exporters:\n  otlp:\n    endpoint: filled.example:4317\n"]
    assert result.valid is True


_FILE_STORAGE_TEXT = """\
extensions:
  file_storage:
    directory: /var/lib/otel-nope
processors:
  attributes:
    actions: [{key: a, value: "${org:EP}", action: insert}]
service:
  extensions: [file_storage]
"""
_DIRECTORY_STDERR = (
    "Error: extensions::file_storage: directory must exist: stat /var/lib/otel-nope: "
    "no such file or directory. You can enable the create_directory option to automatically create it\n"
)


async def test_the_rerun_reads_the_filled_in_text_too(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A first run that reports only a requirement the sandbox meets
    (file_storage's directory) is run again on a repointed text, built from
    the filled-in one: the value, its `$` doubled, and no `${org:` left for
    the backstop to refuse."""
    texts: list[str] = []
    outcomes = [
        runner.RunOutcome(kind="failed", returncode=1, stderr=_DIRECTORY_STDERR),
        runner.RunOutcome(kind="passed", returncode=0),
    ]

    async def collector(binary_path, yaml_content, env_overlay, *, timeout_seconds, directory=None):  # noqa: ANN001
        texts.append(yaml_content)
        return outcomes.pop(0)

    monkeypatch.setattr(runner, "run_collector", collector)

    result = await runner.check_text(
        BINARY, _FILE_STORAGE_TEXT, timeout_seconds=10, directory=str(tmp_path), organization_variables={"EP": "a$b"}
    )

    assert len(texts) == 2  # the first run and the rerun
    for text in texts:
        assert 'value: "a$$b"' in text
        assert "${org:" not in text
    assert "/var/lib/otel-nope" not in texts[1]  # repointed
    assert result.outcome != "refused"
    assert result.valid is True


# ---------------------------------------------------------------------------
# The requirement rows
# ---------------------------------------------------------------------------


def test_the_defined_names_have_one_filled_in_row_and_the_undefined_stay_unresolved() -> None:
    text = "a: ${org:B}\nb: ${org:MISSING}\nc: ${org:A}\nd: ${org:B}\n"

    prepared = _prepared(text, {"A": "1", "B": "2", "UNUSED": "3"})

    organization = [item for item in prepared.before if item["category"] == "organization_variable"]
    assert organization == [
        {
            "category": "organization_variable",
            "title": "Organization variables filled in",
            "description": "Validation filled in your organization's values of these variables before its checks: B, A.",
            "componentPath": None,
        },
        {
            "category": "organization_variable",
            "title": "Unresolved organization variable: MISSING",
            "description": (
                "This configuration references the organization variable 'MISSING', which has no value here. "
                "Validation replaced the reference with a placeholder."
            ),
            "componentPath": None,
        },
    ]


def test_without_values_every_reference_stays_unresolved_and_no_row_says_filled_in() -> None:
    prepared = _prepared("a: ${org:A}\n", {})

    assert _titles(prepared.before) == ["Unresolved organization variable: A"]


def test_the_legacy_form_is_unsupported_and_stays_literal() -> None:
    """`$orgvar:NAME` is filled in by nothing; the editor says
    how to write it. A value's `$orgvar:` (its `$` doubled) is no legacy
    reference, nor is one in a comment."""
    text = "# $orgvar:IN_COMMENT\na: $orgvar:HOST\nb: ${org:V}\nc: $$orgvar:ESCAPED\n"

    prepared = _prepared(text, {"HOST": "x", "V": "$orgvar:FROM_VALUE"})

    assert "a: $orgvar:HOST\n" in prepared.yaml_content
    legacy = [item for item in prepared.before if item["title"].startswith("Unsupported: ")]
    assert legacy == [
        {
            "category": "organization_variable",
            "title": "Unsupported: write ${org:HOST}",
            "description": (
                "This configuration uses the legacy form '$orgvar:HOST', which is no longer filled in: "
                "it stays literal text. Write '${org:HOST}' instead."
            ),
            "componentPath": None,
        }
    ]


async def test_three_hundred_defined_names_answer_one_filled_in_row(monkeypatch: pytest.MonkeyPatch) -> None:
    """One row in all, so the defined names never use up the answer's 200
    requirements."""

    async def collector(binary_path, yaml_content, env_overlay, *, timeout_seconds, directory=None):  # noqa: ANN001
        return runner.RunOutcome(kind="passed", returncode=0)

    monkeypatch.setattr(runner, "run_collector", collector)
    names = [f"V{index}" for index in range(300)]
    text = "processors:\n  attributes:\n    actions:\n" + "".join(
        f"      - {{key: k{index}, value: '${{org:{name}}}', action: insert}}\n" for index, name in enumerate(names)
    )

    result = await runner.check_text(
        BINARY, text, timeout_seconds=10, organization_variables={name: "v" for name in names}
    )

    assert [(item["category"], item["title"]) for item in result.requirements] == [
        ("organization_variable", "Organization variables filled in")
    ]
    assert result.requirements[0]["description"].endswith(", V299.")


def _name(length: int) -> str:
    return "N" + "A" * (length - 1)


def test_a_reference_to_a_name_over_128_characters_has_its_own_row() -> None:
    """No variable can have the name, and Publish refuses it; the
    reference also stays unresolved, since no value fills it."""
    long_name, other = _name(129), _name(130)

    prepared = _prepared(f"a: ${{org:{long_name}}}\nb: ${{org:{other}}}\n", {})

    titles = _titles(prepared.before)
    assert titles[0] == f"Organization variable name over 128 characters: {long_name}"  # the first such name only
    assert sorted(titles[1:]) == [
        f"Unresolved organization variable: {long_name}",
        f"Unresolved organization variable: {other}",
    ]
    assert prepared.before[0]["description"] == (
        "This organization variable name is over 128 characters: no variable can have it, and Publish refuses it."
    )
    assert prepared.before[0]["description"] == NAME_OVER_LIMIT_DESCRIPTION


def test_a_reference_to_a_name_of_128_characters_has_no_such_row() -> None:
    name = _name(128)

    assert _titles(_prepared(f"a: ${{org:{name}}}\n", {}).before) == [f"Unresolved organization variable: {name}"]
    assert _titles(_prepared(f"a: ${{org:{name}}}\n", {name: "v"}).before) == ["Organization variables filled in"]


# ---------------------------------------------------------------------------
# Over 1 MiB once filled in: refused, never built
# ---------------------------------------------------------------------------


def test_a_filled_in_text_over_1_mib_is_refused_without_being_built(monkeypatch: pytest.MonkeyPatch) -> None:
    """32,768 references to a value of 1,024 `$` (the longest a value can be)
    fill in to about 67 MB: refused with the opamp-server's message, the text
    never built, and the pre-processing never more than a few MiB in
    memory."""
    text = "${org:P}" * (MAX_YAML_CHARACTERS // len("${org:P}"))
    values = {"P": "$" * 1024}
    assert org_variables.rendered_length(text, values)[0] == 32_768 * 2048

    def never(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("the over-long text was built")

    monkeypatch.setattr(org_variables, "render", never)
    tracemalloc.start()
    try:
        result = runner._prepare(text, None, values)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert isinstance(result, runner.ValidationResult)
    assert result.valid is False
    assert result.outcome == "filled_in_too_long"
    assert result.errors == [
        {"message": "The configuration with its organization variables filled in is over 1 MiB.", "componentPath": None}
    ]
    assert runner.FILLED_IN_TOO_LONG_MESSAGE == "The configuration with its organization variables filled in is over 1 MiB."
    assert peak < 8 * 1024 * 1024


@pytest.mark.parametrize(("extra", "refused"), [(0, False), (1, True)])
def test_the_bound_is_1_mib_of_utf8_exactly(extra: int, refused: bool) -> None:
    """A value of four-byte characters: the bound counts bytes, not
    characters."""
    prefix = "a: "
    value = "\U0001f600" * 1024  # 4,096 bytes
    references = 255
    filler = (1 << 20) - len(prefix) - len("\n") - references * 4096 + extra
    text = prefix + "${org:P}" * references + "b" * filler + "\n"
    assert org_variables.rendered_length(text, {"P": value})[0] == (1 << 20) + extra

    result = runner._prepare(text, None, {"P": value})

    if refused:
        assert isinstance(result, runner.ValidationResult)
        assert result.outcome == "filled_in_too_long"
    else:
        assert isinstance(result, runner._Prepared)
        assert len(result.yaml_content.encode("utf-8")) == 1 << 20


# ---------------------------------------------------------------------------
# The request's `organizationVariables`
# ---------------------------------------------------------------------------


def _recording_collector(binary_dir: Path, record: Path) -> None:
    """A collector that copies the text it was given (its `--config=` file)."""
    write_collector(binary_dir, "0.162.0", f'cp "${{2#--config=}}" {record}\nexit 0\n')


def test_the_values_reach_the_check_and_are_filled_in(binary_dir: Path, tmp_path: Path) -> None:
    record = tmp_path / "seen.yaml"
    _recording_collector(binary_dir, record)
    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(
            VALIDATE_URL,
            json={"yaml": "exporters:\n  otlp:\n    endpoint: ${org:EP}\n", "organizationVariables": {"EP": "a$b"}},
            headers=auth_headers(),
        )

    assert resp.status_code == 200
    assert resp.json()["requirements"][0]["title"] == "Organization variables filled in"
    assert record.read_text() == "exporters:\n  otlp:\n    endpoint: a$$b\n"


def test_the_longest_body_the_platform_sends_is_accepted_under_the_cap(binary_dir: Path) -> None:
    """A text of 262,144 characters, four-byte ones but its first line, and
    150 names of 128 characters, each a value of 1,024 four-byte characters
    (the longest), sent unescaped as the platform sends them: about 1.61 MiB,
    under 2 MiB."""
    write_collector(binary_dir, "0.162.0", PASSING_COLLECTOR)
    head = "receivers: {}\n# "
    text = head + "\U0001f600" * (MAX_YAML_CHARACTERS - len(head) - 1) + "\n"
    assert len(text) == MAX_YAML_CHARACTERS
    values = {f"V{index:03d}" + "_" * 124: "\U0001f600" * 1024 for index in range(150)}
    body = json.dumps({"yaml": text, "organizationVariables": values}, ensure_ascii=False).encode()
    assert 1_680_000 < len(body) <= MAX_BODY_BYTES

    with TestClient(create_app(make_settings(binary_dir))) as client:
        resp = client.post(VALIDATE_URL, content=body, headers={**auth_headers(), "Content-Type": "application/json"})

    assert resp.status_code == 200
    assert resp.json()["valid"] is True


OUTSIDE_THE_BOUNDS: list[object] = [
    [],
    "A",
    None,
    {f"V{index}": "v" for index in range(151)},
    {"A" * 129: "v"},
    {"": "v"},
    {"9A": "v"},
    {"A-B": "v"},
    {"É": "v"},
    {"A": 1},
    {"A": None},
    {"A": "x" * 1025},
    {"A": "\U0001f600" * 1025},
    {"A": "line\nbreak"},
    {"A": "tab\there"},
    {"A": "nul\x00"},
    {"A": "del\x7f"},
    {"A": "c1\x85"},
    {"A": "ls\u2028"},
    {"A": "ps\u2029"},
]


def _ids(variables: object) -> str:
    return str(len(variables)) if isinstance(variables, dict) and len(variables) > 1 else repr(variables)[:40]


@pytest.mark.parametrize("variables", OUTSIDE_THE_BOUNDS, ids=_ids)
def test_organization_variables_outside_the_servers_bounds_are_400(client: TestClient, variables: object) -> None:
    resp = client.post(VALIDATE_URL, json={"yaml": "a: 1\n", "organizationVariables": variables}, headers=auth_headers())

    assert resp.status_code == 400
    assert resp.json() == {
        "error": {
            "code": "invalid_request",
            "message": (
                "`organizationVariables` must map at most 150 variable names to values of at most 1,024 "
                "characters on one line."
            ),
        }
    }


def test_a_value_holding_a_lone_surrogate_is_400(client: TestClient) -> None:
    resp = client.post(
        VALIDATE_URL,
        content=b'{"yaml": "a: 1\\n", "organizationVariables": {"A": "\\ud800"}}',
        headers={**auth_headers(), "Content-Type": "application/json"},
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_request"


def test_the_bounds_themselves_are_accepted(client: TestClient) -> None:
    values = {f"V{index}": "" for index in range(149)}
    values["A" * 128] = "\U0001f600" * 1024
    resp = client.post(VALIDATE_URL, json={"yaml": "a: 1\n", "organizationVariables": values}, headers=auth_headers())

    assert resp.status_code == 200


def test_a_400_never_quotes_a_name_or_a_value(client: TestClient) -> None:
    resp = client.post(
        VALIDATE_URL,
        json={"yaml": "a: 1\n", "organizationVariables": {"CANARY_NAME": "canary-value\n"}},
        headers=auth_headers(),
    )

    assert resp.status_code == 400
    assert "CANARY" not in resp.text and "canary" not in resp.text


@pytest.mark.parametrize("variables", OUTSIDE_THE_BOUNDS, ids=_ids)
def test_the_contract_refuses_what_the_service_refuses(variables: object) -> None:
    with pytest.raises(AssertionError):
        check_request({"yaml": "a: 1\n", "organizationVariables": variables})


def test_the_contract_takes_the_bounds_themselves() -> None:
    values = {f"V{index}": "" for index in range(149)}
    values["A" * 128] = "\u00e9$\U0001f600" * 341 + "a"
    check_request({"yaml": "a: 1\n", "organizationVariables": values})
    check_request({"yaml": "a: 1\n"})
