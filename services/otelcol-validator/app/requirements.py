"""Requirements read from the text itself, and the one error the validator
adds on its own.

- Organization variables (`${org:X}`), read from the text with the
  organization's values already filled in: one row names the names filled in;
  a live reference left, a name the organization doesn't define, reports
  `Unresolved organization variable: X`; a name over 128 characters, which no
  variable can have, has its own row; the legacy `$orgvar:X` form, which
  nothing fills in, reports `Unsupported: write ${org:X}`.
- The non-`env` confmap providers the validator neutralized.
- What `validate` passes but the collector refuses at start: the text names
  TLS files, the file exporter's directory, or components that need the
  cluster's API. The validator reads the text only; it never opens a path.
- A tail_sampling `ottl_condition` policy with no conditions, which
  `validate` accepts and the collector refuses at start, is an error on the
  processor.
"""

from __future__ import annotations

import posixpath
import re
from collections.abc import Sequence

from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

from app import bounded_yaml
from app.providers import _matching_braces, _preceding_dollar_run_even

# ---------------------------------------------------------------------------
# Organization variables
# ---------------------------------------------------------------------------

_ORGANIZATION_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def live_organization_references(text: str) -> list[str]:
    """Bodies of live ``${org:...}`` references, in first-seen order, deduped.

    Returns the text between ``${org:`` and its matching ``}`` — normally a
    bare variable name, but ``HOST:-fallback`` when the author reached for
    confmap's ``:-`` default syntax, which organization variables do not
    support.

    Case-sensitive on the ``${org:`` prefix: ``${ORG:X}`` is not an
    organization variable, even though the neutralizer still classifies it as
    a foreign scheme via ``scheme.lower()`` — that is a separate, correct
    concern (nothing not `env:` reaches the collector).

    Deliberately separate from ``_neutralize_str``: that function is
    security-critical and total, and this only reads.

    Brace matching is linear: each reference's closing brace is looked up in
    `_matching_braces`, found in one pass, instead of scanned for, which cost
    the square of the text's length on unbalanced `${org:` (225 KB: 568 s).
    Same answers (the differential test in tests/test_linear_scans.py).
    """
    found: dict[str, None] = {}
    braces: dict[int, int] | None = None  # found once, at the first reference
    i = 0
    n = len(text)
    prefix = "${org:"
    while i < n:
        if text.startswith(prefix, i) and _preceding_dollar_run_even(text, i):
            if braces is None:
                braces = _matching_braces(text)
            end = braces.get(i + 1, -1)
            if end != -1:
                found.setdefault(text[i + len(prefix) : end])
                i = end + 1
                continue
        i += 1
    return list(found)


def _decoded_strings(root: Node | None) -> list[str]:
    """Every decoded key and scalar value under a composed document, each
    container visited once however often it is aliased. Iterative, so depth
    costs no stack; the strings are what the collector's confmap layer reads,
    so a reference hidden behind a YAML escape is visible here."""
    strings: list[str] = []
    seen: set[int] = set()
    stack: list[Node] = [root] if root is not None else []
    while stack:
        node = stack.pop()
        if isinstance(node, ScalarNode):
            if isinstance(node.value, str):
                strings.append(node.value)
        elif isinstance(node, (MappingNode, SequenceNode)):
            if id(node) in seen:
                continue
            seen.add(id(node))
            if isinstance(node, MappingNode):
                for key_node, value_node in node.value:
                    stack.append(key_node)
                    stack.append(value_node)
            else:
                stack.extend(node.value)
    return strings


_LEGACY_RE = re.compile(r"\$orgvar:([A-Za-z_][A-Za-z0-9_]*)")


def _legacy_names(text: str) -> list[str]:
    """The NAMEs of the legacy `$orgvar:NAME` form in `text`, in first-seen
    order, deduped, each opened by a `$` an even run of `$` precedes (the
    parity rule of every reference: a value's `$`, doubled when it was filled
    in, never reads as one)."""
    found: dict[str, None] = {}
    for match in _LEGACY_RE.finditer(text):
        if _preceding_dollar_run_even(text, match.start()):
            found.setdefault(match.group(1))
    return list(found)


def _decoded_organization_references(yaml_content: str) -> tuple[list[str], list[str]]:
    """Live ``${org:...}`` bodies, and legacy ``$orgvar:`` names, across the
    DECODED keys and values, each in first-seen order, deduped: a reference a
    YAML escape hid from the raw text is found here, as the collector would
    find it, and one in a comment isn't."""
    try:
        root = bounded_yaml.single_node(yaml_content)
    except (bounded_yaml.YAMLError, bounded_yaml.TooDeep, bounded_yaml.TooManyAliases):
        return [], []
    found: dict[str, None] = {}
    legacy: dict[str, None] = {}
    for decoded in _decoded_strings(root):
        for body in live_organization_references(decoded):
            found.setdefault(body)
        if "$orgvar:" in decoded:
            for name in _legacy_names(decoded):
                legacy.setdefault(name)
    return list(found), list(legacy)


# The opamp-server's bound on a variable's name (`store/orgvariables`'
# MaxNameLength): a longer reference is live but never defined, and Publish
# refuses it.
NAME_OVER_LIMIT_DESCRIPTION = (
    "This organization variable name is over 128 characters: no variable can have it, and Publish refuses it."
)


def filled_in_requirement(names: Sequence[str]) -> dict:
    """The one row naming every organization variable whose value was filled
    in: one row in all, so the names never use up the answer's
    requirements."""
    return {
        "category": "organization_variable",
        "title": "Organization variables filled in",
        "description": (
            "Validation filled in your organization's values of these variables before its checks: "
            + ", ".join(names)
            + "."
        ),
        "componentPath": None,
    }


def name_over_limit_requirement(name: str) -> dict:
    """The row for a live reference to a name over 128 characters (Ruling
    55), naming the first such name."""
    return {
        "category": "organization_variable",
        "title": f"Organization variable name over 128 characters: {name}",
        "description": NAME_OVER_LIMIT_DESCRIPTION,
        "componentPath": None,
    }


def organization_variable_requirements(
    yaml_content: str, filled_in: Sequence[str] = (), name_over_limit: str | None = None
) -> list[dict]:
    """Requirement dicts for the organization variables. `yaml_content` is
    the text with the organization's values already filled in; `filled_in`
    names the variables whose values were (the defined names, from the text
    as written), and `name_over_limit` the first live reference to a name
    over 128 characters.

    The "filled in" row and the name over 128 characters come first, one row
    each, so a text's many references never cut them. Then, found on the
    decoded keys and values: each live ``${org:...}`` still left, a bare-name
    body an "unresolved organization variable" (no value filled it in) and a
    ``NAME:-fallback`` body (confmap's ``:-`` default syntax, which
    organization variables don't support) a distinct "unsupported syntax"
    requirement; and each legacy ``$orgvar:NAME``, which stays literal text,
    "Unsupported: write ${org:NAME}".
    """
    requirements: list[dict] = []
    if filled_in:
        requirements.append(filled_in_requirement(filled_in))
    if name_over_limit is not None:
        requirements.append(name_over_limit_requirement(name_over_limit))
    bodies, legacy = _decoded_organization_references(yaml_content)
    for body in bodies:
        if _ORGANIZATION_NAME_RE.fullmatch(body):
            requirements.append(
                {
                    "category": "organization_variable",
                    "title": f"Unresolved organization variable: {body}",
                    "description": (
                        f"This configuration references the organization variable "
                        f"'{body}', which has no value here. Validation replaced the "
                        f"reference with a placeholder."
                    ),
                    "componentPath": None,
                }
            )
        else:
            requirements.append(
                {
                    "category": "organization_variable",
                    "title": f"Unsupported organization variable syntax: ${{org:{body}}}",
                    "description": (
                        "Organization variables do not support confmap's ':-' default "
                        "syntax. Use '${org:NAME}' with a bare variable name; "
                        "set the fallback as the variable's value instead."
                    ),
                    "componentPath": None,
                }
            )
    for name in legacy:
        requirements.append(
            {
                "category": "organization_variable",
                "title": f"Unsupported: write ${{org:{name}}}",
                "description": (
                    f"This configuration uses the legacy form '$orgvar:{name}', which is no longer "
                    f"filled in: it stays literal text. Write '${{org:{name}}}' instead."
                ),
                "componentPath": None,
            }
        )
    return requirements


def confmap_provider_requirement(schemes: list[str]) -> dict:
    listed = ", ".join(f"{s}:" for s in schemes)
    return {
        "category": "confmap_provider",
        "title": "Non-env configuration providers were substituted",
        "description": (
            f"This configuration uses the {listed} configuration "
            f"provider(s). Validation replaced each reference with a "
            f"placeholder value — only '${{env:VAR}}' substitution is "
            f"evaluated. The referenced files/URLs are read in your "
            f"real deployment, not here, so validate their values "
            f"there."
        ),
        "componentPath": None,
    }


# ---------------------------------------------------------------------------
# What the collector needs at start
# ---------------------------------------------------------------------------

SECTIONS = ("receivers", "processors", "exporters", "connectors", "extensions")
TLS_FILE_KEYS = ("cert_file", "key_file", "ca_file", "client_ca_file")
_TLS_FILE_NAMES = {
    "cert_file": "certificate",
    "key_file": "private key",
    "ca_file": "CA certificate",
    "client_ca_file": "client CA certificate",
}

# Component types that call the Kubernetes API when the collector starts
# (both spellings of each renamed one).
_IN_CLUSTER_TYPES = frozenset(
    {
        "k8s_cluster",
        "k8s_events",
        "k8sobjects",
        "k8s_objects",
        "kubeletstats",
        "kubelet_stats",
        "k8sattributes",
        "k8s_attributes",
        "k8s_observer",
    }
)
_RESOURCE_DETECTION_TYPES = frozenset({"resourcedetection", "resource_detection"})
_FILE_EXPORTER_TYPE = "file"
_TAIL_SAMPLING_TYPE = "tail_sampling"


def _component_type(component_id: object) -> str | None:
    if not isinstance(component_id, str):
        return None
    return component_id.split("/", 1)[0]


def _components(document: dict) -> list[tuple[str, str, str, object]]:
    """(section, id, type, settings) for every component the text defines."""
    found: list[tuple[str, str, str, object]] = []
    for section in SECTIONS:
        block = document.get(section)
        if not isinstance(block, dict):
            continue
        for component_id, settings in block.items():
            component_type = _component_type(component_id)
            if component_type is None:
                continue
            found.append((section, component_id, component_type, settings))
    return found


def _parse(yaml_content: str) -> dict | None:
    try:
        document = bounded_yaml.safe_load(yaml_content)
    except bounded_yaml.YAMLError:
        return None
    return document if isinstance(document, dict) else None


def _tls_files(node: object, inside_tls: bool, found: list[tuple[str, str]]) -> None:
    """(key, path) for every TLS file key under a `tls` mapping, at any depth."""
    if isinstance(node, dict):
        for key, value in node.items():
            if inside_tls and key in TLS_FILE_KEYS and isinstance(value, str) and value.strip():
                found.append((key, value.strip()))
            elif isinstance(value, (dict, list)):
                _tls_files(value, inside_tls or key == "tls", found)
    elif isinstance(node, list):
        for item in node:
            _tls_files(item, inside_tls, found)


def _directory_requirement(component_id: str, component_path: str, file_path: object) -> dict | None:
    """The file exporter's directory. An absolute one is named as written; a
    relative one is relative to the collector's working directory and is
    shown in quotes, as is any directory with whitespace at either end:
    `path: 'stat /y'` names the directory `"stat "` (never
    `Directory stat  must exist`). A bare file name (or `./x`) needs
    nothing."""
    if not isinstance(file_path, str) or not file_path.strip():
        return None
    written = file_path.strip()
    directory = posixpath.dirname(written)
    if not directory or posixpath.normpath(directory) == ".":
        return None
    relative = not posixpath.isabs(directory)
    shown = f'"{directory}"' if relative or directory != directory.strip() else directory
    where = " in the collector's working directory" if relative else ""
    return {
        "category": "directory",
        "title": f"Directory {shown} must exist",
        "description": (
            f"{component_id} writes to {written} and the collector refuses to start if {shown} "
            f"doesn't exist{where}. Create it where the collector runs, writable by the "
            f"collector's user."
        ),
        "componentPath": component_path,
    }


def text_requirements(yaml_content: str) -> list[dict]:
    """The requirements the text itself shows: TLS files, the file exporter's
    directory, and the cluster's API. Nothing is opened or resolved; a path
    is reported as written."""
    document = _parse(yaml_content)
    if document is None:
        return []
    requirements: list[dict] = []
    in_cluster: list[tuple[str, str]] = []

    for section, component_id, component_type, settings in _components(document):
        path = f"{section}::{component_id}"
        found: list[tuple[str, str]] = []
        _tls_files(settings, False, found)
        for key, file_path in found:
            requirements.append(
                {
                    "category": "tls_files",
                    "title": f"Provide {file_path} on the host",
                    "description": (
                        f"{component_id} reads its TLS {_TLS_FILE_NAMES[key]} ({key}) from "
                        f"{file_path} when the collector starts. Validation doesn't open it; "
                        f"the file must exist at this path wherever the collector runs."
                    ),
                    "componentPath": path,
                }
            )
        if section == "exporters" and component_type == _FILE_EXPORTER_TYPE and isinstance(settings, dict):
            requirement = _directory_requirement(component_id, path, settings.get("path"))
            if requirement is not None:
                requirements.append(requirement)
        if component_type in _IN_CLUSTER_TYPES:
            in_cluster.append((path, component_id))
        elif component_type in _RESOURCE_DETECTION_TYPES and isinstance(settings, dict):
            detectors = settings.get("detectors")
            if isinstance(detectors, list) and "k8snode" in detectors:
                in_cluster.append((path, f"{component_id} (k8snode detector)"))

    if in_cluster:
        names = ", ".join(name for _, name in in_cluster)
        requirements.append(
            {
                "category": "k8s_in_cluster",
                "title": "Runs inside a Kubernetes cluster",
                "description": (
                    f"{names} call the Kubernetes API when the collector starts. Run the "
                    f"collector as a pod in the cluster it observes, with a service account "
                    f"allowed to read what they watch."
                    if len(in_cluster) > 1
                    else f"{names} calls the Kubernetes API when the collector starts. Run the "
                    f"collector as a pod in the cluster it observes, with a service account "
                    f"allowed to read what it watches."
                ),
                "componentPath": in_cluster[0][0],
            }
        )
    return requirements


def _ottl_policies_without_conditions(policies: object) -> list[str]:
    """Names of `ottl_condition` policies with no span or span event
    condition, including the sub-policies of `and` and `composite`."""
    found: list[str] = []
    if not isinstance(policies, list):
        return found
    for policy in policies:
        if not isinstance(policy, dict):
            continue
        if policy.get("type") == "ottl_condition":
            settings = policy.get("ottl_condition")
            settings = settings if isinstance(settings, dict) else {}
            span = settings.get("span")
            spanevent = settings.get("spanevent")
            if not (isinstance(span, list) and span) and not (isinstance(spanevent, list) and spanevent):
                found.append(str(policy.get("name", "")))
        for holder, key in (("and", "and_sub_policy"), ("composite", "composite_sub_policy")):
            nested = policy.get(holder)
            if isinstance(nested, dict):
                found.extend(_ottl_policies_without_conditions(nested.get(key)))
    return found


def text_errors(yaml_content: str) -> list[dict]:
    """Errors the collector reports only at start, found in the text: a
    tail_sampling `ottl_condition` policy with no conditions."""
    document = _parse(yaml_content)
    if document is None:
        return []
    errors: list[dict] = []
    for section, component_id, component_type, settings in _components(document):
        if section != "processors" or component_type != _TAIL_SAMPLING_TYPE or not isinstance(settings, dict):
            continue
        for name in _ottl_policies_without_conditions(settings.get("policies")):
            errors.append(
                {
                    "message": f'policy "{name}": expected at least one OTTL condition to filter on',
                    "componentPath": f"processors::{component_id}",
                }
            )
    return errors
