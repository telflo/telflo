"""The provider neutralizer's steps in a run, all in the run's child
process, before any collector starts:

1. `bounded_yaml.single_node` reads the text as one YAML document before any
   ruamel parse. A text it can't read, nesting too deeply or expanding too
   many aliases is refused as C-000 and never runs.
2. `providers.neutralize_providers` replaces every live non-`env` confmap
   reference found on the DECODED keys and values (escapes, tagged scalars,
   keys and aliases included) by splicing its node's source span. R-105's
   advisory names the schemes it returns.
3. C-000 to C-006, the strategy pick and the mutations (R-105 is step 2's,
   not a mutation's walk).
4. `backstop` on the exact text each collector reads: a text that no longer
   reads as one document, or still holds a live non-`env` reference, is
   refused and never runs.
   Beside it (`app/run.py`), C-006's file-settings check runs on the same
   text, on the node graph composed by the backstop's own reader
   (`bounded_yaml.single_node`, never constructed, so no tag hides a
   setting), and refuses a text it can't compose
   (`compatibility.final_file_settings`).

`providers.py`, `bounded_yaml.py` and `placeholders.py` are the validator's,
byte for byte (tests/test_neutraliser_identity.py). The backstop is
reimplemented here, as the validator's `runner._backstop`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app import bounded_yaml
from app.bounded_yaml import ALIASES_MESSAGE, DEPTH_MESSAGE, TooDeep, TooManyAliases
from app.providers import live_nonenv_schemes, neutralize_providers

# C-000: the text can't be read. "could not parse YAML: …", with only
# PyYAML's own problem and line (the validator's rule), never the text.
UNREADABLE_PREFIX = "could not parse YAML: "
# The backstop's refusals: the validator's words.
REFUSED_PROVIDERS_MESSAGE = (
    "Config references configuration provider(s) that could not be safely "
    "neutralized: {schemes}. Only '${{env:VAR}}' substitution is supported."
)
UNCHECKED_MESSAGE = "Config references configuration provider(s) that could not be checked safely."


@dataclass(frozen=True)
class Refusal:
    """The run is refused before any collector starts. `code` is the answer's
    error code (`unreadable` for C-000, `refused` for the backstop)."""

    code: str
    message: str
    compatibility: list[dict] = field(default_factory=list)


@dataclass(frozen=True)
class Neutralised:
    """The text with every live non-`env` reference spliced out, the schemes
    it held, and R-105's advisory when there were any."""

    text: str
    schemes: list[str]
    mutations: list[dict]


def _unreadable(message: str, error_type: str) -> Refusal:
    return Refusal(
        code="unreadable",
        message=message,
        compatibility=[
            {
                "id": "C-000",
                "severity": "refuse",
                "component": "<yaml>",
                "message": message,
                "details": {"error_type": error_type},
            }
        ],
    )


def _problem(error: bounded_yaml.YAMLError) -> str:
    """PyYAML's own problem and line, never any of the text."""
    problem = getattr(error, "problem", None)
    mark = getattr(error, "problem_mark", None)
    if problem is None:  # the bounded loader's own message (a non-Unicode character)
        return str(error) or "the document is not valid YAML"
    if mark is not None:
        return f"{problem} (line {mark.line + 1})"
    return str(problem)


def r105(schemes: list[str]) -> dict:
    """R-105's advisory."""
    return {
        "id": "R-105",
        "severity": "warn",
        "message": (
            "Configuration provider references ("
            + ", ".join(f"${{{scheme}:...}}" for scheme in schemes)
            + ") were replaced with a placeholder. Only ${env:VAR} "
            "substitution runs in the sandbox; providers that read "
            "files or the network are neutralized so a test can't read "
            "host files or secrets."
        ),
        "details": {"schemes": list(schemes)},
    }


def neutralise(text: str) -> Neutralised | Refusal:
    """Steps 1 and 2: the bounded read, then the splices."""
    try:
        root = bounded_yaml.single_node(text)
    except bounded_yaml.YAMLError as error:
        return _unreadable(UNREADABLE_PREFIX + _problem(error), type(error).__name__)
    except TooDeep:
        return _unreadable(DEPTH_MESSAGE, "TooDeep")
    except TooManyAliases:
        return _unreadable(ALIASES_MESSAGE, "TooManyAliases")
    spliced, schemes = neutralize_providers(text, root)
    return Neutralised(text=spliced, schemes=schemes, mutations=[r105(schemes)] if schemes else [])


def backstop(text: str, neutralised_schemes: list[str]) -> Refusal | None:
    """Step 4, on the exact text a collector is about to read: None when it
    may run; otherwise the refusal, naming the schemes neutralized and any
    that survived. Both refusals should be impossible: every splice is total
    and adds no structure."""
    try:
        root = bounded_yaml.single_node(text)
    except (bounded_yaml.YAMLError, TooDeep, TooManyAliases):
        live: list[str] = []  # unreadable: refused all the same
    else:
        live = live_nonenv_schemes(text, root)
        if not live:
            return None
    schemes = sorted(set(neutralised_schemes) | set(live))
    if not schemes:
        return Refusal(code="refused", message=UNCHECKED_MESSAGE)
    named = ", ".join(f"{scheme}:" for scheme in schemes)
    return Refusal(code="refused", message=REFUSED_PROVIDERS_MESSAGE.format(schemes=named))
