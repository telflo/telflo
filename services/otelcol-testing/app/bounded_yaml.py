"""The one YAML loader the validator uses: PyYAML's safe loader (libyaml's
`CSafeLoader` when PyYAML has it, as its wheels do), with two bounds every
parse goes through.

**Nesting**. The composer recurses once or twice per level (libyaml's in C,
without Python's recursion check), and so do the validator's walks over the
result, `copy.deepcopy` and `safe_dump`. Before a document is composed, its
parse events are read (the parser keeps its own stack, it doesn't recurse)
and a text whose mappings and sequences nest more than `MAX_DEPTH` deep
raises `TooDeep`. The events don't see what aliases nest: a chain of
anchors, each a deep list around an alias of the one before, is a few levels
deep in the text and thousands deep once expanded (forty 95-deep links: a
RecursionError in the walks). So the composed document's expanded depth is
counted too, in the same pass as its aliases (below), and past `MAX_DEPTH`
raises `TooDeep` before anything is constructed. The walks then stay under
about 3 × `MAX_DEPTH` frames, far below Python's limit of 1,000.

**Aliases**. An alias is cheap to write and expensive to walk:
`a1: &a1 [*a0, *a0, …]` nested seven deep is 462 bytes and expands to ten
million nodes, and the validator's walks (requirements, placeholders,
provider neutralisation) visit every expanded node. Each document is
composed first and its expanded size counted from the node graph (each
distinct node once, so counting is linear in the text); a document whose
aliases add more than `MAX_ALIAS_NODES` nodes raises `TooManyAliases` before
anything is constructed or walked.

Neither is a `yaml.YAMLError`: the call sites treat a YAMLError as
"unparseable, let the collector say why" and fall back, and these must not
be waved through that way. The check answers them with `DEPTH_MESSAGE` and
`ALIASES_MESSAGE`, without running the collector.

**Scalars**. A plain scalar that PyYAML would resolve to a timestamp, to `=`
(its "value" tag) or to `yaml`'s own tag, or to an int or float whose
construction fails (`0b_`, `2001-13-45`), is a string: the collector's Go
YAML reads these as strings, and PyYAML raised ValueError for some (an
answer of 500) and a ConstructorError for others (unparseable, so the
submitted text's words went unread). Any other failure to construct a value
(an explicit `!!int x`) is a `YAMLError`: unparseable, never a crash.

Nothing here bounds time: the whole check runs in a child process under one
deadline (`app/runner.py`). Within one check the same text is parsed by
several steps, so the last few texts' documents are kept and each caller
gets its own deep copy (a copy keeps aliased parts shared, so it is no
bigger than the document).

The module also re-exports `safe_dump` and `YAMLError`, so a module can bind
it as `yaml` (providers.py does).
"""

from __future__ import annotations

import copy
import functools

import yaml
from yaml.constructor import SafeConstructor
from yaml.events import CollectionEndEvent, CollectionStartEvent
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

YAMLError = yaml.YAMLError
safe_dump = yaml.safe_dump

# libyaml's loader parses about seven times faster than the pure-Python one
# (a 262,144-character configuration: 45 ms against 336 ms); both build the
# same documents.
_BASE_LOADER: type = getattr(yaml, "CSafeLoader", None) or yaml.SafeLoader

# The bound on the nodes aliases add (the expanded tree's size minus the
# distinct nodes the text itself holds). Real configurations alias a few
# blocks (a TLS block, a processor list shared by pipelines): hundreds to a
# few thousand added nodes. 100,000 is far above that, and it is about the
# node count of the largest text the 1 MiB body limit admits without any
# alias (~10 bytes a node), so aliases can at most double the walks' work.
MAX_ALIAS_NODES = 100_000

# The bound on nesting: mappings and sequences inside one another. A real
# collector configuration nests about 6 to 12 deep (receivers > filelog >
# operators > [0] > timestamp > …; tail_sampling's composite and `and`
# policies are the deepest, about 12). 100 is eight times that, and keeps
# the deepest walk (about 3 frames a level) at a third of Python's limit.
MAX_DEPTH = 100

ALIASES_MESSAGE = "The configuration expands too many YAML aliases."
DEPTH_MESSAGE = "The configuration nests too deeply."


class TooManyAliases(Exception):
    """The text's aliases expand past `MAX_ALIAS_NODES` (or refer to
    themselves, which expands without end)."""


class TooDeep(Exception):
    """The text's mappings and sequences nest deeper than `MAX_DEPTH`."""


def check_depth(text: str) -> None:
    """Raise `TooDeep` when the text nests deeper than `MAX_DEPTH`, reading
    its parse events only (no node is built, nothing recurses); `YAMLError`
    when it stops parsing before that. Linear in the text."""
    loader = _BASE_LOADER(text)
    try:
        depth = 0
        while loader.check_event():
            event = loader.get_event()
            if isinstance(event, CollectionStartEvent):
                depth += 1
                if depth > MAX_DEPTH:
                    raise TooDeep()
            elif isinstance(event, CollectionEndEvent):
                depth -= 1
    finally:
        loader.dispose()


def alias_expansion(root: Node) -> int:
    """How many nodes aliases add to the document under `root`: its size
    with every alias expanded, less its distinct nodes. Iterative, each
    distinct node counted once; a node that contains itself raises
    `TooManyAliases`. Stops counting once past the bound. The same pass
    counts how deep mappings and sequences nest once aliases are expanded,
    and raises `TooDeep` past `MAX_DEPTH`."""
    expanded: dict[int, int] = {}  # id(node) -> expanded size, once finished
    depth: dict[int, int] = {}  # id(node) -> expanded nesting, once finished
    visiting: set[int] = set()
    stack: list[tuple[Node, bool]] = [(root, False)]
    while stack:
        node, children_done = stack.pop()
        key = id(node)
        if children_done:
            visiting.discard(key)
            children = _children(node)
            size = 1 + sum(expanded[id(child)] for child in children)
            expanded[key] = size
            if size - len(expanded) > MAX_ALIAS_NODES:
                raise TooManyAliases()
            if not isinstance(node, ScalarNode):
                nested = 1 + max((depth[id(child)] for child in children), default=0)
                if nested > MAX_DEPTH:
                    raise TooDeep()
                depth[key] = nested
            else:
                depth[key] = 0
            continue
        if key in expanded:
            continue
        if key in visiting:
            raise TooManyAliases()  # a node inside itself: endless expansion
        visiting.add(key)
        stack.append((node, True))
        for child in _children(node):
            child_key = id(child)
            if child_key in visiting:
                raise TooManyAliases()
            if child_key not in expanded:
                stack.append((child, False))
    return expanded[id(root)] - len(expanded)


def _children(node: Node) -> list[Node]:
    if isinstance(node, SequenceNode):
        return list(node.value)
    if isinstance(node, MappingNode):
        return [part for pair in node.value for part in pair]
    return []


_STR_TAG = "tag:yaml.org,2002:str"
# Implicit tags read as strings whatever the scalar.
_STRING_TAGS = frozenset({"tag:yaml.org,2002:timestamp", "tag:yaml.org,2002:value", "tag:yaml.org,2002:yaml"})
# Implicit tags kept only for a scalar their constructor takes.
_CHECKED_TAGS = {
    "tag:yaml.org,2002:int": SafeConstructor.construct_yaml_int,
    "tag:yaml.org,2002:float": SafeConstructor.construct_yaml_float,
}


class _BoundedSafeLoader(_BASE_LOADER):  # type: ignore[misc, valid-type]
    def get_single_node(self) -> Node | None:
        # Both loaders construct from this node (libyaml's composer can't be
        # overridden below it), so the aliases are counted here.
        node = super().get_single_node()
        if node is not None and alias_expansion(node) > MAX_ALIAS_NODES:
            raise TooManyAliases()
        return node

    def resolve(self, kind: type, value: str, implicit: tuple[bool, bool]) -> str:
        # Called for every untagged scalar (libyaml's composer calls it too).
        tag = super().resolve(kind, value, implicit)
        if kind is not ScalarNode or not implicit[0]:
            return tag
        if tag in _STRING_TAGS:
            return _STR_TAG
        construct = _CHECKED_TAGS.get(tag)
        if construct is not None:
            try:
                construct(self, ScalarNode(tag, value))
            except ValueError:
                return _STR_TAG
        return tag


@functools.lru_cache(maxsize=4)
def _load(text: str) -> object:
    try:
        check_depth(text)
        return yaml.load(text, Loader=_BoundedSafeLoader)  # noqa: S506 - a SafeLoader subclass
    except UnicodeEncodeError:
        # libyaml takes UTF-8, which a lone surrogate can't be; the
        # pure-Python reader refuses the same text with a ReaderError.
        raise YAMLError("the text holds a character that isn't Unicode") from None
    except (YAMLError, TooDeep, TooManyAliases):
        raise
    except Exception as error:
        # A value its explicit tag can't construct (`!!int x`: ValueError,
        # and so on): unparseable, as the call sites expect, never a crash.
        raise YAMLError(f"a value can't be constructed ({type(error).__name__})") from None


def safe_load(text: str) -> object:
    """`yaml.safe_load` with nesting and alias expansion bounded: raises
    `YAMLError` for a text that isn't YAML (one document) or holds a value
    that can't be constructed, `TooDeep` for one nested past `MAX_DEPTH`
    (aliases expanded) and `TooManyAliases` for one whose aliases expand
    past `MAX_ALIAS_NODES`; a scalar of an implicit type that can't be
    constructed is a string. The caller owns what it gets (a deep copy: what
    one caller changes in place, no other caller sees)."""
    return copy.deepcopy(_load(text))


def mark_offset(text: str) -> int:
    """What to add to a composed node's `start_mark.index` / `end_mark.index`
    to get its character offset into `text`: 1 when libyaml composed a text
    that starts with a byte-order mark, else 0.

    Marks count characters (code points; CRLF is two), but libyaml takes a
    leading U+FEFF as the encoding's signature and leaves it out of every
    index (a later one, at the start of a line, is counted), while the
    pure-Python reader counts it. Uncorrected, a splice by that index would
    cut one character early."""
    return 1 if text.startswith("\ufeff") and _BASE_LOADER is not yaml.SafeLoader else 0


def single_node(text: str) -> Node | None:
    """Compose the text's one document into a node graph, with every node's
    source marks (`start_mark.index` … `end_mark.index`, character offsets
    into `text` once `mark_offset(text)` is added), bounded as `safe_load` is.

    Composing stops short of construction, so no implicit type is resolved
    and no value is built: a node's `.value` is the scalar's decoded string
    (escapes resolved, `${file:…}` hidden behind a YAML escape made
    visible), exactly what the collector's confmap layer reads. Used by the
    provider neutralisation, which detects and splices references by node
    position without ever re-dumping the document.

    Raises `YAMLError` for a text PyYAML can't read as one document (a scanner
    or parser error, or more than one document), `TooDeep` / `TooManyAliases`
    at the bounds, and returns `None` for empty text."""
    check_depth(text)
    loader = _BoundedSafeLoader(text)
    try:
        return loader.get_single_node()
    except UnicodeEncodeError:
        raise YAMLError("the text holds a character that isn't Unicode") from None
    finally:
        loader.dispose()
