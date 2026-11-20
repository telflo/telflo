"""The backstop checks what the collector reads, splices land where the
scalar is, and neither run sets a name it shouldn't.

The fail-closed re-check runs whether or not the neutraliser changed
something, on the text the collector reads (after the Datadog insert) and on
the rerun's text (after the file_storage directory splice); splices are
tested after a non-ASCII character, on CRLF text and inside a flow
collection; and the rerun doesn't set every variable a requirement's title
names (a text shapes those names through `${env:NAME}`).

libyaml leaves a leading byte-order mark out of its marks' indexes, so on a
text that starts with one every splice would land one character early (the
backstop would refuse the neutraliser's output; the rerun's directory
splice would reach the collector corrupted). `bounded_yaml.mark_offset`
corrects it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml as pyyaml

from app import bounded_yaml, runner
from app.placeholders import (
    _ADDRESS_PLACEHOLDER,
    _DEFAULT_PLACEHOLDER,
    _PROTECTED_ENV_NAME_RE,
    _build_env_var_placeholders,
    _inject_datadog_hostname_placeholder,
)
from app.providers import _neutralize_str
from app.runner import _Prepared, _meet_requirements, _prepare, _repoint_file_storage

PH = _DEFAULT_PLACEHOLDER
CANARY = "${file:/etc/canary}"
BINARY = Path("/fake/otelcol-contrib")


def _prepared_text(text: str) -> str:
    prepared = _prepare(text)
    assert isinstance(prepared, _Prepared), f"the collector would not run: {prepared}"
    return prepared.yaml_content


def _holds_live_reference(text: str) -> bool:
    found: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(key)
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str):
            found.extend(_neutralize_str(node, "PH")[1])

    walk(bounded_yaml.safe_load(text))
    return bool(found)


def _replace_strings(node: object, old: str, new: str) -> object:
    """`node` with every key or string value equal to `old` replaced by
    `new`: the structure the spliced text must parse to."""
    if isinstance(node, dict):
        return {_replace_strings(k, old, new): _replace_strings(v, old, new) for k, v in node.items()}
    if isinstance(node, list):
        return [_replace_strings(item, old, new) for item in node]
    return new if node == old else node


def _assert_spliced(text: str, splices: list[tuple[str, str, str]]) -> None:
    """`splices` are `(source, decoded, new_value)`: each `source` (the
    scalar exactly as written, once in `text`) decodes to `decoded` and must
    become a double-quoted `new_value`. Everything else in the prepared text
    is byte-identical to `text`, and it parses to `text`'s structure with
    each `decoded` replaced by its `new_value`."""
    expected_text = text
    expected_structure = bounded_yaml.safe_load(text)
    for source, decoded, new_value in splices:
        assert text.count(source) == 1, source
        expected_text = expected_text.replace(source, json.dumps(new_value, ensure_ascii=False))
        expected_structure = _replace_strings(expected_structure, decoded, new_value)
    prepared = _prepared_text(text)
    assert prepared == expected_text
    assert bounded_yaml.safe_load(prepared) == expected_structure
    assert not _holds_live_reference(prepared)


def test_the_service_composes_with_libyaml() -> None:
    """The offsets below are libyaml's (`CSafeLoader`), as the image's
    PyYAML wheel provides it."""
    assert bounded_yaml._BASE_LOADER is pyyaml.CSafeLoader


# ---------------------------------------------------------------------------
# Splices after non-ASCII characters: the marks count characters (code
# points), not UTF-8 bytes.
# ---------------------------------------------------------------------------


def test_a_splice_after_non_ascii_lines_lands_on_the_scalar() -> None:
    text = (
        'description: "Ünïcödé — 日本語 🚀 é\u0301"\n'
        "# ☃ a comment, 🚀🚀\n"
        "exporters:\n"
        "  otlp:\n"
        f'    value: "{CANARY}"\n'
        "    timeout: 1:30\n"
    )
    _assert_spliced(text, [(f'"{CANARY}"', CANARY, PH)])


def test_a_splice_after_non_ascii_on_the_same_line_lands_on_the_scalar() -> None:
    text = (
        "exporters:\n"
        "  otlp:\n"
        f"    \"ключ🚀\": '{CANARY}' # 🚀 after\n"
        "    timeout: on\n"
    )
    _assert_spliced(text, [(f"'{CANARY}'", CANARY, PH)])


def test_a_splice_of_a_scalar_holding_non_ascii_before_its_reference() -> None:
    text = f"v: 'Ünï {CANARY} 🚀'\nw: 2001-12-14\n"
    _assert_spliced(text, [(f"'Ünï {CANARY} 🚀'", f"Ünï {CANARY} 🚀", f"Ünï {PH} 🚀")])


@pytest.mark.parametrize("line_break", ["\n", "\r\n"], ids=["lf", "crlf"])
def test_a_leading_byte_order_mark_does_not_shift_the_splice(line_break: str) -> None:
    """libyaml leaves the leading U+FEFF out of its indexes; uncorrected, the
    splice would land one character early."""
    text = f"\ufeffa: é{line_break}v: \"{CANARY}\"{line_break}w: on{line_break}"
    _assert_spliced(text, [(f'"{CANARY}"', CANARY, PH)])


def test_a_leading_byte_order_mark_does_not_shift_the_reruns_directory_splice(tmp_path: Path) -> None:
    text = "\ufeffextensions:\n  file_storage:\n    directory: /var/lib/otel-nope\n    timeout: 1s\n"
    repointed = _repoint_file_storage(text, str(tmp_path))
    assert repointed is not None
    loaded = bounded_yaml.safe_load(repointed)
    fresh = loaded["extensions"]["file_storage"]["directory"]
    assert Path(fresh).parent == tmp_path and Path(fresh).is_dir()
    assert repointed == text.replace("/var/lib/otel-nope", json.dumps(fresh))
    assert loaded["extensions"]["file_storage"]["timeout"] == "1s"


# ---------------------------------------------------------------------------
# CRLF (and a lone CR) line breaks: a break of two characters counts two.
# ---------------------------------------------------------------------------


def test_splices_on_crlf_text_keep_every_crlf() -> None:
    text = (
        "exporters:\r\n"
        "  otlp:\r\n"
        "    description: é 🚀\r\n"
        f'    value: "{CANARY}"\r\n'
        "    timeout: 1:30\r\n"
        "    b: |\r\n"
        "      ${file:/x}\r\n"
        "    c: 2\r\n"
        f"    d: é {CANARY}\r\n"
        "      more\r\n"
        "    e: 017\r\n"
    )
    _assert_spliced(
        text,
        [
            (f'"{CANARY}"', CANARY, PH),
            # A block scalar's span ends with its own CRLF, which stays.
            ("|\r\n      ${file:/x}", "${file:/x}\n", f"{PH}\n"),
            (f"é {CANARY}\r\n      more", f"é {CANARY} more", f"é {PH} more"),
        ],
    )
    prepared = _prepared_text(text)
    assert "\n" not in prepared.replace("\r\n", "")  # no bare LF introduced


def test_a_splice_on_lone_cr_text() -> None:
    text = f'a: é\rb: "{CANARY}"\rc: 1:30\r'
    _assert_spliced(text, [(f'"{CANARY}"', CANARY, PH)])


# ---------------------------------------------------------------------------
# Inside flow collections: keys and values, mappings and sequences.
# ---------------------------------------------------------------------------


def test_a_reference_in_a_flow_mapping_key_and_value() -> None:
    text = f'exporters: {{otlp: {{"\\x24{{file:/k}}": 1, endpoint: \'{CANARY}\', b: on, ü: 1:30}}}}\n'
    _assert_spliced(
        text,
        [
            ('"\\x24{file:/k}"', "${file:/k}", PH),
            (f"'{CANARY}'", CANARY, _ADDRESS_PLACEHOLDER),
        ],
    )


def test_a_reference_in_a_flow_sequence_item_and_single_pair_key() -> None:
    text = f'a: [x, "\\u0024{{file:/i}}", 2001-12-14, &r \'{CANARY}\', *r, "${{http://h/}}": v, é]\n'
    _assert_spliced(
        text,
        [
            ('"\\u0024{file:/i}"', "${file:/i}", PH),
            (f"'{CANARY}'", CANARY, PH),  # the anchor stays, so the alias follows
            ('"${http://h/}"', "${http://h/}", PH),
        ],
    )


def test_a_multi_line_flow_collection_on_crlf_text() -> None:
    text = f"a: {{\r\n  k: \"{CANARY}\",\r\n  '${{http://h/}}': [1, !!str \"${{file:/y}}\"],\r\n  z: on }}\r\n"
    _assert_spliced(
        text,
        [
            (f'"{CANARY}"', CANARY, PH),
            ("'${http://h/}'", "${http://h/}", PH),
            ('"${file:/y}"', "${file:/y}", PH),  # the tag stays in front
        ],
    )


# ---------------------------------------------------------------------------
# The backstop runs on the exact text each collector run reads.
# ---------------------------------------------------------------------------

_DIRECTORY_STDERR = (
    "Error: extensions::file_storage: directory must exist: stat /var/lib/otel-nope: "
    "no such file or directory. You can enable the create_directory option to automatically create it\n"
)

# No provider reference (so nothing is neutralised), a Datadog
# exporter that gets the hostname insert, and a file_storage directory the
# rerun repoints.
_RERUN_CONFIG = """\
exporters:
  datadog:
    api:
      key: abc
extensions:
  file_storage:
    directory: /var/lib/otel-nope
service:
  extensions: [file_storage]
"""


class _Collector:
    """A stub `run_collector`: records the text each run reads and answers
    with the next of `outcomes`."""

    def __init__(self, *outcomes: runner.RunOutcome) -> None:
        self.outcomes = list(outcomes)
        self.texts: list[str] = []
        self.overlays: list[dict[str, str]] = []

    async def __call__(self, binary_path, yaml_content, env_overlay, *, timeout_seconds, directory=None):
        self.texts.append(yaml_content)
        self.overlays.append(dict(env_overlay))
        assert self.outcomes, f"the collector ran {len(self.texts)} times, more than expected"
        return self.outcomes.pop(0)


def _requirement_only(stderr: str = _DIRECTORY_STDERR) -> runner.RunOutcome:
    return runner.RunOutcome(kind="failed", returncode=1, stderr=stderr)


_PASSED = runner.RunOutcome(kind="passed", returncode=0)


async def test_the_backstop_checks_exactly_what_each_run_reads(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    collector = _Collector(_requirement_only(), _PASSED)
    checked: list[str] = []
    still_references = runner._still_references

    def recording(yaml_content: str) -> bool:
        checked.append(yaml_content)
        return still_references(yaml_content)

    monkeypatch.setattr(runner, "run_collector", collector)
    monkeypatch.setattr(runner, "_still_references", recording)

    result = await runner.check_text(BINARY, _RERUN_CONFIG, timeout_seconds=10, directory=str(tmp_path))

    assert len(collector.texts) == 2  # the first run and the rerun
    assert "hostname: otelcol-validator" in collector.texts[0]  # after the insert
    assert "/var/lib/otel-nope" not in collector.texts[1]  # after the directory splice
    assert checked == collector.texts
    assert result.valid is True


async def test_an_insert_the_backstop_refuses_never_reaches_the_collector(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A text with nothing to neutralise whose last rewrite (the Datadog
    insert, here made to misbehave) leaves a live reference: refused."""
    collector = _Collector()
    monkeypatch.setattr(runner, "run_collector", collector)
    monkeypatch.setattr(
        runner, "_inject_datadog_hostname_placeholder", lambda text: text + f'leak: "{CANARY}"\n'
    )

    result = await runner.check_text(BINARY, "receivers: {}\n", timeout_seconds=10)

    assert collector.texts == []
    assert result.valid is False
    assert result.outcome == "refused"
    assert result.errors == [{"message": runner.REFUSED_PROVIDERS_MESSAGE.format(schemes="file:"), "componentPath": None}]


async def test_a_rerun_text_the_backstop_refuses_never_reaches_the_collector(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The rerun's directory splice (here made to misbehave) leaves a live
    reference: the rerun doesn't happen and the check is refused, as the
    first run's backstop answers."""
    collector = _Collector(_requirement_only(), _PASSED)
    monkeypatch.setattr(runner, "run_collector", collector)
    monkeypatch.setattr(
        runner, "_repoint_file_storage", lambda text, directory: text.replace("/var/lib/otel-nope", CANARY)
    )
    text = _RERUN_CONFIG + 'processors:\n  attributes:\n    actions: [{key: a, value: "${org:HOST}"}]\n'

    result = await runner.check_text(BINARY, text, timeout_seconds=10, directory=str(tmp_path))

    assert len(collector.texts) == 1  # the first run only
    assert result.valid is False
    assert result.outcome == "refused"
    # The organization variable was neutralised on the first pass, and the
    # file reference survived the splice: both named, as today's refusal does.
    assert result.errors == [
        {"message": runner.REFUSED_PROVIDERS_MESSAGE.format(schemes="file:, org:"), "componentPath": None}
    ]
    assert [r["title"] for r in result.requirements] == ["Unresolved organization variable: HOST"]


# ---------------------------------------------------------------------------
# The rerun never sets a name the collector's environment already holds, nor
# one its runtime, loader or network stack reads.
# ---------------------------------------------------------------------------

PROTECTED = [
    "GODEBUG",
    "GOMEMLIMIT",
    "GOMAXPROCS",
    "GOGC",
    "GOTRACEBACK",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
]


def _env_requirement(name: str, category: str = "env_var") -> dict:
    title = (
        f"Set {name} via the Kubernetes downward API"
        if category == "k8s_downward_api"
        else f"Set environment variable {name}"
    )
    return {"category": category, "title": title, "description": "", "componentPath": None}


@pytest.mark.parametrize("name", PROTECTED)
@pytest.mark.parametrize("category", ["env_var", "k8s_downward_api"])
def test_a_protected_name_is_never_set(name: str, category: str) -> None:
    assert _meet_requirements("receivers: {}\n", [_env_requirement(name, category)], None) is None


@pytest.mark.parametrize("name", ["K8S_NODE_NAME", "MY_POD_IP", "HOSTNAME"])
def test_a_name_the_fixed_environment_holds_is_never_set(name: str) -> None:
    assert _meet_requirements("receivers: {}\n", [_env_requirement(name)], None) is None


def test_a_name_the_first_run_already_set_is_never_set_again() -> None:
    requirement = _env_requirement("MY_TOKEN")
    assert _meet_requirements("receivers: {}\n", [requirement], None, {"MY_TOKEN": "x"}) is None
    # Not yet in the environment: met.
    assert _meet_requirements("receivers: {}\n", [requirement], None, {}) == (
        "receivers: {}\n",
        {"MY_TOKEN": PH},
    )


def test_only_the_names_that_may_be_set_are_set() -> None:
    requirements = [_env_requirement("GODEBUG"), _env_requirement("MY_NODE_VAR"), _env_requirement("https_proxy")]
    met = _meet_requirements("receivers: {}\n", requirements, None)
    assert met is not None
    assert met[1] == {"MY_NODE_VAR": PH}


def _node_env_stderr(name: str) -> str:
    return (
        # The collector's own line (tests/fixtures/collector-outputs.json).
        "Error: processors::k8sattributes::filter: "
        f'`node_from_env_var` is configured but envvar "{name}" is not set\n'
    )


async def test_a_protected_name_gets_no_rerun(monkeypatch: pytest.MonkeyPatch) -> None:
    collector = _Collector(_requirement_only(_node_env_stderr("GOMEMLIMIT")), _PASSED)
    monkeypatch.setattr(runner, "run_collector", collector)

    result = await runner.check_text(BINARY, "receivers: {}\n", timeout_seconds=10)

    assert len(collector.texts) == 1
    assert result.valid is True
    assert [r["title"] for r in result.requirements] == ["Set environment variable GOMEMLIMIT"]


async def test_an_ordinary_name_still_gets_its_rerun(monkeypatch: pytest.MonkeyPatch) -> None:
    collector = _Collector(_requirement_only(_node_env_stderr("MY_NODE_VAR")), _PASSED)
    monkeypatch.setattr(runner, "run_collector", collector)

    await runner.check_text(BINARY, "receivers: {}\n", timeout_seconds=10)

    assert len(collector.texts) == 2
    assert collector.overlays[1]["MY_NODE_VAR"] == PH


# ---------------------------------------------------------------------------
# The first run's `${env:NAME}` placeholders skip protected names
# too; the reference is still a requirement.
# ---------------------------------------------------------------------------

FIRST_RUN_PROTECTED = ["GOMEMLIMIT", "GODEBUG", "LD_PRELOAD", "HTTP_PROXY", "PATH"]


def _env_text(name: str) -> str:
    return f"exporters:\n  otlp:\n    endpoint: ${{env:{name}}}\n"


@pytest.mark.parametrize("name", FIRST_RUN_PROTECTED)
def test_a_protected_name_gets_no_placeholder_but_keeps_its_requirement(name: str) -> None:
    env_overlay, requirements = _build_env_var_placeholders(_env_text(name))
    assert name not in env_overlay
    assert [(r["category"], r["title"]) for r in requirements] == [("env_var", f"Set environment variable {name}")]


def test_an_ordinary_name_still_gets_its_placeholder() -> None:
    env_overlay, requirements = _build_env_var_placeholders(_env_text("MY_ENDPOINT"))
    assert env_overlay == {"MY_ENDPOINT": _ADDRESS_PLACEHOLDER}
    assert [r["title"] for r in requirements] == ["Set environment variable MY_ENDPOINT"]


@pytest.mark.parametrize("name", FIRST_RUN_PROTECTED)
async def test_the_collector_never_gets_a_placeholder_for_a_protected_name(
    monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    collector = _Collector(_PASSED)
    monkeypatch.setattr(runner, "run_collector", collector)
    text = _env_text(name) + "  debug:\n    verbosity: ${env:MY_LEVEL}\n"

    result = await runner.check_text(BINARY, text, timeout_seconds=10)

    assert name not in collector.overlays[0]
    assert "MY_LEVEL" in collector.overlays[0]  # the control, in the same text
    assert f"Set environment variable {name}" in [r["title"] for r in result.requirements]


# ---------------------------------------------------------------------------
# Go's runtime names are protected; `GOOGLE_*` are ordinary.
# ---------------------------------------------------------------------------

GO_RUNTIME_NAMES = [
    "GODEBUG",
    "GOGC",
    "GOMAXPROCS",
    "GOMEMLIMIT",
    "GOTRACEBACK",
    "GOROOT",
    "GOFLAGS",
    "GO111MODULE",
    "GOEXPERIMENT",
    "GOTOOLCHAIN",
    "GOAMD64",
]
GOOGLE_NAMES = ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OTLP_ENDPOINT"]


def test_the_go_names_are_exactly_go_then_capitals_and_digits() -> None:
    """Go's runtime variables have no underscore; `GOOGLE_*` are ordinary."""
    assert [n for n in GO_RUNTIME_NAMES if not _PROTECTED_ENV_NAME_RE.fullmatch(n)] == []
    assert [n for n in GOOGLE_NAMES if _PROTECTED_ENV_NAME_RE.fullmatch(n)] == []


@pytest.mark.parametrize("name", GOOGLE_NAMES)
def test_a_google_name_gets_its_placeholder(name: str) -> None:
    env_overlay, requirements = _build_env_var_placeholders(_env_text(name))
    assert env_overlay == {name: _ADDRESS_PLACEHOLDER}
    assert [r["title"] for r in requirements] == [f"Set environment variable {name}"]


def test_a_google_name_is_met_on_the_rerun() -> None:
    met = _meet_requirements("receivers: {}\n", [_env_requirement("GOOGLE_CLOUD_PROJECT")], None)
    assert met == ("receivers: {}\n", {"GOOGLE_CLOUD_PROJECT": PH})


def _recording_backstop(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    checked: list[str] = []
    still_references = runner._still_references

    def recording(yaml_content: str) -> bool:
        checked.append(yaml_content)
        return still_references(yaml_content)

    monkeypatch.setattr(runner, "_still_references", recording)
    return checked


@pytest.mark.parametrize(
    ("text", "checked"),
    [
        ("receivers:\n  otlp: {}\n", False),  # nothing neutralised, nothing inserted
        (f'exporters:\n  otlp:\n    value: "{CANARY}"\n', True),  # a splice
        ("exporters:\n  datadog:\n    api:\n      key: abc\n", True),  # the insert
    ],
    ids=["unchanged", "spliced", "inserted"],
)
def test_the_first_runs_backstop_runs_only_when_the_text_changed(
    monkeypatch: pytest.MonkeyPatch, text: str, checked: bool
) -> None:
    calls = _recording_backstop(monkeypatch)
    prepared = _prepare(text)
    assert isinstance(prepared, _Prepared)
    assert calls == ([prepared.yaml_content] if checked else [])


async def test_the_reruns_backstop_runs_even_when_the_first_text_was_unchanged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    text = "extensions:\n  file_storage:\n    directory: /var/lib/otel-nope\nservice:\n  extensions: [file_storage]\n"
    collector = _Collector(_requirement_only(), _PASSED)
    monkeypatch.setattr(runner, "run_collector", collector)
    calls = _recording_backstop(monkeypatch)

    await runner.check_text(BINARY, text, timeout_seconds=10, directory=str(tmp_path))

    assert collector.texts[0] == text  # unchanged: no second compose before the first run
    assert calls == [collector.texts[1]]  # the rerun's text, checked


async def test_a_refusal_with_no_scheme_to_name_says_it_could_not_check(monkeypatch: pytest.MonkeyPatch) -> None:
    collector = _Collector()
    monkeypatch.setattr(runner, "run_collector", collector)
    # The insert (made to misbehave) leaves a text that no longer reads.
    monkeypatch.setattr(runner, "_inject_datadog_hostname_placeholder", lambda text: text + "a: [\n")

    result = await runner.check_text(BINARY, "receivers: {}\n", timeout_seconds=10)

    assert collector.texts == []
    assert result.outcome == "refused"
    assert result.errors == [
        {
            "message": "Config references configuration provider(s) that could not be checked safely.",
            "componentPath": None,
        }
    ]


async def test_no_placeholder_for_any_name_the_fixed_environment_holds(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed = sorted(runner._ALLOWED_PARENT_ENV | set(runner._build_subprocess_env()))
    collector = _Collector(_PASSED)
    monkeypatch.setattr(runner, "run_collector", collector)
    text = "receivers:\n" + "".join(f"  r{i}: ${{env:{name}}}\n" for i, name in enumerate(fixed))

    await runner.check_text(BINARY, text, timeout_seconds=10)

    assert [name for name in fixed if name in collector.overlays[0]] == []


async def test_a_name_added_to_the_allowlist_gets_no_placeholder_without_a_pattern(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`TZ` matches no protected pattern: only the explicit fixed-environment
    check keeps the first run from overwriting it."""
    assert not _PROTECTED_ENV_NAME_RE.fullmatch("TZ")
    monkeypatch.setattr(runner, "_ALLOWED_PARENT_ENV", runner._ALLOWED_PARENT_ENV | {"TZ"})
    monkeypatch.setenv("TZ", "UTC")
    collector = _Collector(_PASSED)
    monkeypatch.setattr(runner, "run_collector", collector)

    result = await runner.check_text(BINARY, "receivers:\n  r: ${env:TZ}\n", timeout_seconds=10)

    assert "TZ" not in collector.overlays[0]
    assert "Set environment variable TZ" in [r["title"] for r in result.requirements]


async def test_the_rerun_never_sets_an_allowlisted_name_the_service_lacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`TZ` allowlisted but unset in the service: the collector's environment
    doesn't hold it, yet the parent allowlist may pass it at any time, so the
    rerun must not set it either. Only `_fixed_env_names()` covers it: the
    allowlist whether or not the variable is set, where the built environment
    holds only the variables that are."""
    assert not _PROTECTED_ENV_NAME_RE.fullmatch("TZ")
    monkeypatch.setattr(runner, "_ALLOWED_PARENT_ENV", runner._ALLOWED_PARENT_ENV | {"TZ"})
    monkeypatch.delenv("TZ", raising=False)
    assert "TZ" not in runner._build_subprocess_env()

    assert _meet_requirements("receivers: {}\n", [_env_requirement("TZ")], None) is None

    # Through a whole check: the first run ends with TZ's requirement only
    # (k8sattributes' own line), and there is no rerun to set it in.
    collector = _Collector(_requirement_only(_node_env_stderr("TZ")), _PASSED)
    monkeypatch.setattr(runner, "run_collector", collector)

    result = await runner.check_text(BINARY, "receivers: {}\n", timeout_seconds=10)

    assert len(collector.texts) == 1
    assert all("TZ" not in overlay for overlay in collector.overlays)
    assert result.valid is True
    assert [r["title"] for r in result.requirements] == ["Set environment variable TZ"]


@pytest.mark.parametrize("line_break", ["\n", "\r\n"], ids=["lf", "crlf"])
def test_the_datadog_insert_works_after_a_leading_byte_order_mark(line_break: str) -> None:
    text = line_break.join(["\ufeffexporters:", "  datadog:", "    api:", "      key: abc", ""])
    out = _inject_datadog_hostname_placeholder(text)
    assert out.startswith("\ufeffexporters:")
    assert bounded_yaml.safe_load(out)["exporters"]["datadog"]["hostname"] == "otelcol-validator"
    assert out == text.replace(f"  datadog:{line_break}", f"  datadog:{line_break}    hostname: otelcol-validator{line_break}")
