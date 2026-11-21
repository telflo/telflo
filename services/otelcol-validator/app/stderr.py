"""Reading what `otelcol-contrib validate` prints on stderr.

The collector fails in one of four stages, printed the same way on 0.147.0
and 0.162.0 (tests/fixtures/collector-outputs.json holds the recorded outputs
this parser is tested on):

- **resolve** — `Error: failed to get config: cannot resolve the
  configuration: <cause>`: one error, no component path.
- **unmarshal** — `Error: failed to get config: cannot unmarshal the
  configuration: decoding failed due to the following error(s):` and a block
  in which each component is a header, `'<section>' error reading
  configuration for "<id>": …`, followed by its cause: one error per
  component, path `<section>::<id>`, message its cause's lines. An unknown
  type, `'<section>' unknown type: "<t>" for id: "<id>" (valid values:
  […])`, loses the list of valid values.
- **validate** — one error per line, `Error: ` stripped from the first; the
  path as the collector prints it (`receivers::filelog::baseconfig::…`).
- **build** — `Error: failed to build pipelines: …`, the collector's first
  failure only: `failed to create "<id>" <kind>` gives `<kind>s::<id>`,
  `connector "<id>" used as …` gives `connectors::<id>`; anything else
  (`pipeline not found`, `Error registering consumer`) has no path.

A component path keeps the whole id: `otlp/2`, `otlp/my-recv.v2` (never cut
to `otlp`, nor stopped at a hyphen).

**Causes.** Each error is classified by its causes, as the parser reads them
(never split back out of a joined message):
- resolve: the message (after the not-valid-YAML preamble), one cause;
- unmarshal: each line of a component's block, its header's own text
  included, one cause each; an unknown type, an id line or a top-level line
  is one cause;
- validate: a line's message after `<path>: ` (the whole line when it names
  no path), one cause;
- build: the first line's text after the component's prefix, `failed to
  create "<id>" <kind>[, in pipeline "<p>" | for data type "<t>"]: ` (the
  whole line when it has no such prefix), and each later line, one cause
  each;
- a log line before the `Error: ` line: the line, one cause.

**Deployment requirements**: an error is a requirement only when every one of
its causes matches one of `TEMPLATES` whole, each a requirement the collector
really printed (see the templates' section); any other error stays an error,
so an error that also says something else is never filed as a requirement
(never the whole line). Two guards stay on top: the span rule and the
submitted text's own words.

What is bounded, and how: the output is capped at 256 KB by the
runner. Reading it into stages and lines is linear: each line regex is
anchored or starts with a literal, and its repetitions are separated by
characters they can't match (the validate line's path is one lazy group, no
longer a nested repetition, which backtracked exponentially). A cause longer
than `MAX_CLASSIFIED_CHARACTERS` (4,096) is an error without any template
tried; a shorter one is tried against each template once, anchored at both
ends, and every template is literal text and single character classes, each
class followed by a character it excludes, so an attempt is linear in the
cause. The span rule is one pass over the cause, and whether the submitted
text holds a cause is one substring search over its words per distinct
cause. None of it has a time bound of its own: it runs in the check's child
process, under its deadline, never on the service's event loop.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app import bounded_yaml
from app.placeholders import _PLACEHOLDER_MARKER

SECTIONS = ("receivers", "processors", "exporters", "connectors", "extensions")

# A component path as the collector prints it: a section, then `::`-separated
# parts, each anything but whitespace and colons, so `/name`, hyphens and dots
# survive (`exporters::otlp_http/my-exp.v2`).
COMPONENT_PATH_RE = re.compile(
    r"((?:receivers|processors|exporters|extensions|connectors|service)(?:::[^\s:]+)+)"
)

_TIMESTAMP_RE = re.compile(r"^\d{4}[/-]\d{2}[/-]\d{2}[T\s]+\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*")
TRUNCATION_MARKER_TEXT = "[stderr truncated by validator]"

_RESOLVE_PREFIX = "failed to get config: cannot resolve the configuration: "
_UNMARSHAL_PREFIX = "failed to get config: cannot unmarshal the configuration: "
_BUILD_PREFIX = "failed to build pipelines: "
_DECODING_FAILED = "decoding failed due to the following error(s):"
_NOT_VALID_YAML = "assuming string type since contents are not valid YAML: "

_COMPONENT_HEADER_RE = re.compile(
    r"^'(?P<section>receivers|processors|exporters|connectors|extensions)' "
    r'error reading configuration for "(?P<id>[^"]+)": ?(?P<rest>.*)$'
)
_UNKNOWN_TYPE_RE = re.compile(
    r"^'(?P<section>receivers|processors|exporters|connectors|extensions)' "
    r'(?P<message>unknown type: "[^"]*" for id: "(?P<id>[^"]+)")(?: \(valid values: \[.*\]\))?$'
)
_ID_LINE_RE = re.compile(r"""^'(?P<where>[^']*)' (?:'' )?in "(?P<id>[^"]+)" id: (?P<message>.*)$""")
_QUOTED_LEAD_RE = re.compile(r"^'(?P<where>[^']*)' (?P<message>.*)$")
_NESTED_HEADER_RE = re.compile(r"^'[^']*' " + re.escape(_DECODING_FAILED) + "$")
_PIPELINE_WHERE_RE = re.compile(r"^service\.pipelines\[(?P<id>[^\]]+)\]")
# One optional `::…` group, not `(?:::\S+?)*`: the same paths (several
# `::x` groups are one `::x::y`), without the nested repetition that
# backtracked exponentially on a long `a::a::a…` with no `: `.
_VALIDATE_LINE_RE = re.compile(
    r"^(?P<path>(?:receivers|processors|exporters|extensions|connectors|service)(?:::\S+?)?): (?P<message>.*)$"
)
_BUILD_CREATE_RE = re.compile(
    r'^failed to create "(?P<id>[^"]+)" (?P<kind>receiver|processor|exporter|connector|extension)\b'
)
# A build failure's own prefix, as the collector prints it; what follows is
# the cause.
_BUILD_CAUSE_PREFIX_RE = re.compile(
    r'^failed to create "[^"]+" (?:receiver|processor|exporter|connector|extension)'
    r'(?:, in pipeline "[^"]*"| for data type "[^"]*")?: '
)
_BUILD_CONNECTOR_RE = re.compile(r'^connector "(?P<id>[^"]+)" used as\b')
_PANIC_RE = re.compile(r"^(?:panic: |fatal error: )")

# ---------------------------------------------------------------------------
# Deployment requirements: templates
#
# Some components check the host at validate time (a directory, an
# environment variable, the service account's files). In the sandbox those
# checks fail, but they aren't configuration bugs: they are things to provide
# where the collector runs, so they go to `requirements[]`, not `errors[]`.
#
# A cause is a requirement only when it matches one of these templates whole,
# from its first character to its last (`re.fullmatch`). Each template is
# taken from a real output the collector printed (`source`, a case in
# tests/fixtures/collector-outputs.json, or in collector-outputs-linux.json
# for what only Linux prints, recorded in the image); its variable parts are narrow
# classes: an environment variable's name, or an absolute path without
# whitespace, quotes, brackets, `$`, `:`, `;`, `,` or a backslash, so a
# variable part can't hold text the collector echoes in quotes, a joined
# cause, or a confmap reference. Anything else is an error: phrase
# patterns matched anywhere in a line would let the configuration's own
# text pass for a requirement and hide its error. Requirement patterns with
# no recorded output don't fire from the output (README, "Requirements"): of
# the image's recorded Linux outputs, only hostmetrics' root_path printed
# one.
#
# Two guards stay on top: a cause whose quotes the collector left open, or
# that holds an invalid-keys list, is an error; and so is a cause the
# submitted text itself holds (in a key or a scalar value as decoded, or in
# the raw text).
# ---------------------------------------------------------------------------

_PATH_CHARACTERS = r"[^\s\"'`\\\[\](){}<>$:;,]*"
_PATH = "/" + _PATH_CHARACTERS
_ENV_NAME = r"[A-Za-z_][A-Za-z0-9_]*"


@dataclass(frozen=True)
class Template:
    """One requirement the collector states, as it states it."""

    source: str  # the recorded case it is taken from
    pattern: re.Pattern[str]  # matched against a whole cause
    category: str
    title: str  # formatted with the pattern's named groups
    description: str

    def requirement(self, match: re.Match[str], component_path: str | None) -> dict:
        values = match.groupdict()
        return {
            "category": self.category,
            "title": self.title.format(**values),
            "description": self.description.format(**values),
            "componentPath": component_path,
        }


TEMPLATES: tuple[Template, ...] = (
    Template(
        # file_storage (validate stage): `extensions::file_storage: <cause>`.
        source="req-file-storage-directory",
        pattern=re.compile(
            rf"directory must exist: stat (?P<path>{_PATH}): no such file or directory\. "
            r"You can enable the create_directory option to automatically create it"
        ),
        category="directory",
        title="Ensure {path} exists at runtime",
        description=(
            "This configuration writes to {path}. "
            "Ensure the directory exists and is writable by the collector process "
            "in your deployment, or enable the component's `create_directory` option "
            "if available."
        ),
    ),
    Template(
        # hostmetrics (validate stage, Linux only: darwin refuses root_path):
        # `receivers::hostmetrics: <cause>`, recorded in the image, which
        # holds /hostfs, so only another root_path reaches it.
        source="req-hostmetrics-root-path",
        pattern=re.compile(rf"invalid root_path: stat (?P<path>{_PATH}): no such file or directory"),
        category="host_filesystem",
        title="Mount the host filesystem at {path}",
        description=(
            "The hostmetrics receiver scrapes from {path}. "
            "Mount the host's root filesystem as a hostPath volume at {path} "
            "in your pod spec so the collector can read host-level metrics."
        ),
    ),
    Template(
        # k8sattributes (validate stage): `processors::k8sattributes::filter:
        # <cause>`, the downward API's usual variable (recorded without the
        # service's environment, which sets it).
        source="k8sattr-node",
        pattern=re.compile(r'`node_from_env_var` is configured but envvar "(?P<name>K8S_NODE_NAME)" is not set'),
        category="k8s_downward_api",
        title="Set {name} via the Kubernetes downward API",
        description=(
            "This configuration reads the node name from the {name} environment variable. "
            "Set it in your pod spec via the downward API: "
            "env: [{{ name: {name}, valueFrom: {{ fieldRef: {{ fieldPath: spec.nodeName }} }} }}]"
        ),
    ),
    Template(
        # The same, any other variable.
        source="req-k8sattr-node-env-custom",
        pattern=re.compile(rf'`node_from_env_var` is configured but envvar "(?P<name>{_ENV_NAME})" is not set'),
        category="env_var",
        title="Set environment variable {name}",
        description=(
            "This configuration reads the {name} environment variable. "
            "Set it in your deployment environment before starting the collector."
        ),
    ),
    Template(
        # resourcedetection's k8snode detector (build stage): `failed to
        # create "resourcedetection" processor, in pipeline "<p>": <cause>`.
        source="req-rd-k8snode-service-account",
        pattern=re.compile(
            r'failed creating detector type "k8snode": failed creating k8snode detector: '
            rf"failed to create K8s API client: open (?P<path>/var/run/secrets/{_PATH_CHARACTERS}): "
            r"no such file or directory"
        ),
        category="k8s_in_cluster",
        title="Mount a Kubernetes service account",
        description=(
            "This configuration reads a Kubernetes service-account token at {path}. "
            "Run the collector as a pod with `automountServiceAccountToken: true` "
            "(the default) so this file is provided automatically."
        ),
    ),
)

# Longer causes are errors without any template tried: every recorded
# requirement is under 200 characters.
MAX_CLASSIFIED_CHARACTERS = 4096

_INVALID_KEYS = "has invalid keys: "
# A single quote opens mapstructure's '…' only after these (so the apostrophe
# in "can't" is prose), and closes it only before these (or at the end).
_SINGLE_OPENS_AFTER = frozenset(" \t([{,:;=")
_SINGLE_CLOSE_RE = re.compile(r"'(?=[ \t)\]},:;.]|\Z)")
# What can open an echo, or start an invalid-keys list.
_ECHO_START_RE = re.compile(r"[\"`']|" + re.escape(_INVALID_KEYS))
_DOUBLE_END_RE = re.compile(r'[^"\\]*(?:\\.[^"\\]*)*"', re.DOTALL)


def _echoes_closed(text: str) -> bool:
    """The span rule, for a whole cause: True when every quote
    the collector opened in it (Go's "…", a backtick, mapstructure's '…') is
    closed within it and it holds no invalid-keys list. One left-to-right
    pass: each opening delimiter is found by a search from the last span's
    end, and each span's end by one search from its opening, so the searches
    add up to one pass over the text."""
    n = len(text)
    # The next closing single quote at or after a position; None once there
    # is none left. Searched forward only.
    next_close: int | None = -1
    position = 0
    while position < n:
        found = _ECHO_START_RE.search(text, position)
        if found is None:
            return True
        i = found.start()
        char = text[i]
        if char == '"':
            closing = _DOUBLE_END_RE.match(text, i + 1)
            if closing is None:
                return False  # left open: the collector cut the value
            position = closing.end()
        elif char == "`":
            j = text.find("`", i + 1)
            if j == -1:
                return False
            position = j + 1
        elif char == "'":
            if i > 0 and text[i - 1] not in _SINGLE_OPENS_AFTER:
                position = i + 1  # an apostrophe, not a span
                continue
            if next_close is not None and next_close <= i:
                close = _SINGLE_CLOSE_RE.search(text, i + 1)
                next_close = close.start() if close else None
            if next_close is None:
                position = i + 1  # no closing quote anywhere after: an apostrophe
                continue
            position = next_close + 1
        else:  # an invalid-keys list
            return False
    return True


class Submitted:
    """The submitted text's own words: every key and every scalar value as
    decoded, and the raw text. A cause the text holds is an echo of the text,
    wherever the collector printed it. A cause never holds a line break, so
    the words are joined by line breaks and one substring search answers for
    all of them."""

    def __init__(self, text: str) -> None:
        words = [text]
        try:
            document = bounded_yaml.safe_load(text)
        except Exception:  # unparseable (or past a bound): the raw text alone
            document = None
        words.extend(_decoded_words(document))
        self._haystack = "\n".join(words)
        self._seen: dict[str, bool] = {}

    def holds(self, phrase: str) -> bool:
        known = self._seen.get(phrase)
        if known is None:
            known = self._seen[phrase] = phrase in self._haystack
        return known


def _decoded_words(document: object) -> list[str]:
    """Every key and scalar of a decoded document, each container visited
    once however often it is aliased; iterative, so depth costs no stack."""
    words: list[str] = []
    seen: set[int] = set()
    stack: list[object] = [document]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if id(node) in seen:
                continue
            seen.add(id(node))
            for key, value in node.items():
                stack.append(key)
                stack.append(value)
        elif isinstance(node, (list, tuple, set)):
            if id(node) in seen:
                continue
            seen.add(id(node))
            stack.extend(node)
        elif isinstance(node, str):
            words.append(node)
        elif node is not None:
            words.append(str(node))
    return words


def classify_cause(
    cause: str, component_path: str | None, submitted: Submitted | None = None, private: tuple[str, ...] = ()
) -> dict | None:
    """The requirement one cause states, or None when it is an error: it
    must match a template whole, leave no quote open, hold no invalid-keys
    list, and not be a phrase of the submitted text."""
    if not cause or len(cause) > MAX_CLASSIFIED_CHARACTERS:
        return None
    for template in TEMPLATES:
        match = template.pattern.fullmatch(cause)
        if match is None:
            continue
        if not _echoes_closed(cause):
            return None
        if submitted is not None and submitted.holds(cause):
            return None  # the submitted text's own words: an error
        if any(_from_a_placeholder(value, private) for value in match.groupdict().values()):
            return None  # a variable the validator's own placeholder filled
        return template.requirement(match, component_path)
    return None


def _from_a_placeholder(value: str | None, private: tuple[str, ...] = ()) -> bool:
    """True when a template's captured variable holds the validator's
    placeholder marker, a line break, or one of the `private` paths (the
    check's own directory): a requirement whose title would name the
    validator's own substitute or directory, or carry an injected break, is
    not emitted. The path and name character classes already exclude a line
    break; this is a second guard."""
    return value is not None and (
        _PLACEHOLDER_MARKER in value or "\n" in value or "\r" in value or any(path in value for path in private)
    )


def classify_error(
    causes: list[str], component_path: str | None, submitted: Submitted | None = None, private: tuple[str, ...] = ()
) -> dict | None:
    """The requirement an error stands for, or None when it is an error.

    An error is a requirement only when it has a cause and every one of its
    causes is a requirement (an error that also says something else is never
    filed as a requirement); its first cause's requirement is the error's.
    The causes are the parser's, never split out of a joined message (the
    module's docstring says what a cause is in each stage). `submitted` is
    the text that was checked; `private` the paths a requirement never names.
    """
    first: dict | None = None
    for cause in causes:
        requirement = classify_cause(cause, component_path, submitted, private)
        if requirement is None:
            return None
        first = first or requirement
    return first


@dataclass(frozen=True)
class ParsedOutput:
    errors: list[dict]
    requirements: list[dict]
    # True when the output reads as a crash (a Go panic or fatal error)
    # rather than a configuration error.
    crashed: bool = False


@dataclass
class _Found:
    """One error as read, with the causes it is classified by."""

    message: str
    path: str | None
    causes: list[str]

    def error(self) -> dict:
        return {"message": self.message, "componentPath": self.path}


def _found(message: str, path: str | None, causes: list[str] | None = None) -> _Found:
    return _Found(message, path, [message] if causes is None else causes)


def _clean_lines(stderr: str) -> list[str]:
    lines: list[str] = []
    for raw_line in stderr.splitlines():
        line = _TIMESTAMP_RE.sub("", raw_line.strip()).strip()
        if line == TRUNCATION_MARKER_TEXT:
            continue
        lines.append(line)
    return lines


def parse_stderr(stderr: str, submitted_text: str | None = None, private: tuple[str, ...] = ()) -> ParsedOutput:
    """Parse the collector's stderr after a non-zero exit into errors and
    requirements.

    Only the block that starts at the collector's `Error: ` line is read as
    errors; lines before it (log lines) can only add requirements. With no
    `Error: ` line at all, the output names no error: requirement lines still
    count, and the caller reports the exit when there are none.

    `submitted_text` is the text that was checked, as sent: a cause it holds
    is never a requirement, nor is one that names a `private` path (the
    check's own directory). Linear in the output (the module's docstring says
    how).
    """
    submitted = Submitted(submitted_text) if submitted_text is not None else None
    lines = _clean_lines(stderr)
    if any(_PANIC_RE.match(line) for line in lines):
        return ParsedOutput(errors=[], requirements=[], crashed=True)

    start = next((i for i, line in enumerate(lines) if line.startswith("Error: ")), None)
    preamble = lines if start is None else lines[:start]
    found: list[_Found] = []
    if start is not None:
        block = lines[start:]
        block[0] = block[0][len("Error: ") :]
        found = _parse_error_block(block)

    errors: list[dict] = []
    requirements: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add_requirement(requirement: dict) -> None:
        key = (requirement["category"], requirement["title"])
        if key not in seen:
            seen.add(key)
            requirements.append(requirement)

    for line in preamble:
        if not line or line.startswith("Everything is ready"):
            continue
        requirement = classify_error([line], _path_in(line), submitted, private)
        if requirement is not None:
            add_requirement(requirement)

    for one in found:
        requirement = classify_error(one.causes, one.path, submitted, private)
        if requirement is not None:
            add_requirement(requirement)
        else:
            errors.append(one.error())
    return ParsedOutput(errors=errors, requirements=requirements)


def _path_in(line: str) -> str | None:
    match = COMPONENT_PATH_RE.search(line)
    return match.group(1) if match else None


def _parse_error_block(block: list[str]) -> list[_Found]:
    first = block[0]
    if first.startswith(_RESOLVE_PREFIX):
        return _parse_resolve(first[len(_RESOLVE_PREFIX) :])
    if first.startswith(_UNMARSHAL_PREFIX):
        return _parse_unmarshal(first[len(_UNMARSHAL_PREFIX) :], block[1:])
    if first.startswith(_BUILD_PREFIX):
        return _parse_build(first[len(_BUILD_PREFIX) :], block[1:])
    return _parse_validate(block)


def _parse_resolve(cause: str) -> list[_Found]:
    # A text that isn't YAML: the collector says so at length; the YAML
    # parser's own message is the useful part.
    if _NOT_VALID_YAML in cause:
        cause = cause.split(_NOT_VALID_YAML, 1)[1]
    return [_found(cause.strip(), None)]


def _parse_unmarshal(first_rest: str, lines: list[str]) -> list[_Found]:
    found: list[_Found] = []
    current: _Found | None = None  # a component's error, its causes still being read

    def flush() -> None:
        nonlocal current
        if current is not None:
            current.message = "; ".join(current.causes) or "decoding failed"
            found.append(current)
            current = None

    body = list(lines)
    if first_rest.strip() and first_rest.strip() != _DECODING_FAILED:
        body.insert(0, first_rest.strip())

    for line in body:
        if not line or line == _DECODING_FAILED:
            continue
        header = _COMPONENT_HEADER_RE.match(line)
        if header:
            flush()
            current = _Found("", f"{header['section']}::{header['id']}", [])
            rest = header["rest"].strip()
            if rest and rest != _DECODING_FAILED:
                current.causes.append(_strip_empty_quote(rest))
            continue
        unknown = _UNKNOWN_TYPE_RE.match(line)
        if unknown:
            flush()
            found.append(_found(unknown["message"], f"{unknown['section']}::{unknown['id']}"))
            continue
        id_line = _ID_LINE_RE.match(line)
        if id_line:
            flush()
            found.append(_found(id_line["message"], _path_for_id_line(id_line["where"], id_line["id"])))
            continue
        if _NESTED_HEADER_RE.match(line):
            continue  # `'<field>' decoding failed …`: its causes follow
        if current is not None:
            current.causes.append(line)
            continue
        # A top-level problem outside any component: `'service' has invalid
        # keys: …`, `'otelcol.configSettings' has invalid keys: …`.
        quoted = _QUOTED_LEAD_RE.match(line)
        found.append(_found(line, _path_for_where(quoted["where"]) if quoted else None))
    flush()
    return found


def _strip_empty_quote(text: str) -> str:
    return text[3:] if text.startswith("'' ") else text


def _path_for_where(where: str) -> str | None:
    """A component path for a mapstructure location, where it names one."""
    if where in SECTIONS or where == "service":
        return where
    pipeline = _PIPELINE_WHERE_RE.match(where)
    if pipeline:
        return f"service::pipelines::{pipeline['id']}"
    if where.startswith("service."):
        return "service::" + where[len("service.") :].split(".", 1)[0].split("[", 1)[0]
    return None


def _path_for_id_line(where: str, component_id: str) -> str | None:
    if where in SECTIONS:
        return f"{where}::{component_id}"
    return _path_for_where(where)


def _parse_validate(block: list[str]) -> list[_Found]:
    found: list[_Found] = []
    for line in block:
        if not line:
            continue
        match = _VALIDATE_LINE_RE.match(line)
        if match:
            found.append(_found(match["message"], match["path"]))
        else:
            found.append(_found(line, None))
    return found


def _parse_build(cause: str, continuation: list[str]) -> list[_Found]:
    first = cause.strip()
    rest = [line for line in continuation if line]
    message = "; ".join(part for part in (first, *rest) if part)
    path: str | None = None
    created = _BUILD_CREATE_RE.match(first)
    if created:
        path = f"{created['kind']}s::{created['id']}"
    else:
        connector = _BUILD_CONNECTOR_RE.match(first)
        if connector:
            path = f"connectors::{connector['id']}"
    prefix = _BUILD_CAUSE_PREFIX_RE.match(first)
    cause = first[prefix.end() :] if prefix else first
    return [_found(message, path, [cause, *rest])]


def _merge_requirements(primary: list[dict], secondary: list[dict]) -> list[dict]:
    """Concatenate two requirement lists, de-duped by (category, title).

    Primary entries win on conflicts — used to keep the pre-scan's structured
    env_var requirements over any stderr-classified version of the same var.
    """
    merged: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for entry in (*primary, *secondary):
        key = (entry["category"], entry["title"])
        if key in seen:
            continue
        seen.add(key)
        merged.append(entry)
    return merged
