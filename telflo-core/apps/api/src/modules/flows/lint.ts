import type { FlowLintCode, FlowLintFinding, FlowLintResponse, FlowLintSeverity } from "@telflo/contracts";
import { isScalar, parseDocument, visit } from "yaml";

/*
 * The flows' security lint: 11 rules and 3 malformed-input codes, each
 * with a fixed code, severity, message, path (a secret's and a TLS
 * setting's start with `.`) and destination string. Advisory: the admin
 * dialog's "Run security check" lists the findings, and nothing is gated
 * on them.
 *
 * What the lint can and cannot do: it
 * catches the accidental case (a real endpoint left in, an API key in a
 * header) and the lazy attacker; it does not make an arbitrary configuration
 * safe. Data can leave through a routing connector, an OTTL statement or a
 * load-balancing resolver, and no static check enumerates those. The
 * destinations make the data path visible.
 *
 * The text is read as the collector reads it: the `yaml` package's
 * YAML 1.2 core schema with the platform's options, not PyYAML's 1.1. The
 * accepted differences from a YAML 1.1 reading, each tested: `yes` and `on` are
 * strings, not booleans; `0o755` and `1e3` are numbers; `2024-01-01`,
 * `1_000` and `1:20` are strings; a duplicate key, more than 100 aliases, an
 * alias inside the node it names, and nesting deeper than the parser goes are
 * `invalid-yaml`; a key the core schema reads as null, a boolean or a number
 * (`~:`, `true:`, `1:`) is named in a path as written, not as Python's
 * `None`, `True` or `1`; a custom tag (`!foo`) and a complex key (`? [a, b]`)
 * proceed, where PyYAML refused them; and `invalid-yaml`'s message is the
 * `yaml` package's, not PyYAML's. Like PyYAML (and the collector), a
 * character YAML doesn't allow in a stream, such as U+0007 or a lone
 * surrogate, is `invalid-yaml`; the `yaml` package alone would accept it.
 * Unlike them, so is a line break only YAML 1.1 has (a lone CR, U+0085,
 * U+2028 or U+2029), which the `yaml` package would read past.
 *
 * Python's string and regex semantics are kept where they decide an answer:
 * `$` also matches before a final newline; case-insensitive matching follows
 * Python's (Unicode case folding, which also matches `ı` and `İ` with `i`);
 * `\d` is any Unicode decimal digit; `\s` and `strip()` use Python's
 * whitespace (U+001C–U+001F and U+0085 are whitespace, U+FEFF is not); `\b`
 * counts any Unicode letter or number as a word character.
 *
 * The findings' messages and paths and the destinations are configuration
 * text: they quote keys, values and the parser's messages, so neither they nor
 * the text ever reach a log line.
 */

// ---------------------------------------------------------------------------
// Python's regular expressions and strip()
// ---------------------------------------------------------------------------

/** Python's whitespace (`str.isspace()`, `\s` in a `str` pattern), as a character class body. */
const PYTHON_WHITESPACE_CLASS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const PYTHON_WHITESPACE = new RegExp(`^[${PYTHON_WHITESPACE_CLASS}]$`, "u");

/** Python's `$` without MULTILINE: the end, or just before a newline that ends the text. */
const PYTHON_END = "(?=\\n?$)";

/** Python's `\b` after a word character: the next one isn't a word character (a Unicode letter or number, or `_`). */
const PYTHON_WORD_END = "(?![\\p{L}\\p{N}_])";

/**
 * What a case-insensitive Python pattern's `i` matches: `i`, `I`, and the
 * dotted and dotless `İ` and `ı`, which Python's case folding adds and
 * JavaScript's `iu` doesn't. Every other ASCII letter matches the same set
 * under both.
 */
const PYTHON_CASELESS_I = "i\\u0130\\u0131";

/**
 * Compiles one of the lint's patterns, written in Python's syntax, with
 * Python's semantics for the constructs those patterns use: `(?P<name>`,
 * `$` (PYTHON_END), `\d` (`\p{Nd}`), `\s` (Python's whitespace), `\b`
 * (PYTHON_WORD_END: the patterns' one `\b` follows a word), and with
 * `ignoreCase` Python's case folding for `i` and a class's `a-z`. Nothing
 * else in those patterns differs between the two engines.
 */
export function pythonRegExp(pattern: string, flags: { ignoreCase?: boolean; global?: boolean } = {}): RegExp {
  let source = "";
  let isInClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
      const escaped = pattern[index];
      if (escaped === "d") source += "\\p{Nd}";
      else if (escaped === "s") source += isInClass ? PYTHON_WHITESPACE_CLASS : `[${PYTHON_WHITESPACE_CLASS}]`;
      else if (escaped === "b" && !isInClass) source += PYTHON_WORD_END;
      else source += `\\${escaped}`;
      continue;
    }
    if (isInClass) {
      if (character === "]") {
        isInClass = false;
        source += character;
      } else if (flags.ignoreCase && pattern.startsWith("a-z", index)) {
        source += `a-z${PYTHON_CASELESS_I}`;
        index += 2;
      } else if (flags.ignoreCase && character === "i") {
        source += PYTHON_CASELESS_I;
      } else {
        source += character;
      }
      continue;
    }
    if (character === "[") {
      isInClass = true;
      source += character;
    } else if (pattern.startsWith("(?P<", index)) {
      source += "(?<";
      index += 3;
    } else if (character === "$") {
      source += PYTHON_END;
    } else if (flags.ignoreCase && character === "i") {
      source += `[${PYTHON_CASELESS_I}]`;
    } else {
      source += character;
    }
  }
  return new RegExp(source, `u${flags.ignoreCase ? "i" : ""}${flags.global ? "g" : ""}`);
}

const isPythonWhitespace = (character: string) => PYTHON_WHITESPACE.test(character);

/**
 * Python's `str.strip()`: whitespace (Python's) or, given `isStripped`, the
 * characters it names, off both ends. A loop, not a regular expression,
 * so a long run inside the text costs nothing.
 */
export function pythonStrip(text: string, isStripped: (character: string) => boolean = isPythonWhitespace): string {
  let start = 0;
  let end = text.length;
  while (start < end && isStripped(text[start] as string)) start += 1;
  while (end > start && isStripped(text[end - 1] as string)) end -= 1;
  return text.slice(start, end);
}

const isQuote = (character: string) => character === '"' || character === "'";

// ---------------------------------------------------------------------------
// Confmap providers
// ---------------------------------------------------------------------------

/*
 * The collector expands `${scheme:uri}` in every configuration string at
 * load time. Only `env:` is legitimate in a shared template. `${file:...}`
 * reads the importer's filesystem (on Kubernetes, the service account's
 * token), and the value lands wherever it was interpolated, typically an
 * exporter header; `${http(s):...}` reaches the importer's network, cloud
 * metadata endpoints included.
 *
 * Escape parity is security-critical: confmap collapses `$$` to a literal
 * `$` in one left-to-right pass, so a run of N dollars before `{` is a live
 * expansion iff N is odd. `${x}` and `$$${x}` expand; `$${x}` and `$$$${x}`
 * don't. A naive "not preceded by a $" check misses the triple-dollar form.
 *
 * The pattern `(?P<dollars>\$+)\{…` would find the same expansions as
 * this one, which starts a match only at the first dollar of a run: from
 * any dollar in a run, `\$+` takes the rest of the run and meets the same
 * `{scheme:` or not, so the run's first dollar, tried first, matches or none
 * does, and a match never ends inside a run. Starting there keeps a long run
 * of dollars linear; Python scanned the run again from every dollar.
 */
const PROVIDER_RE = pythonRegExp(String.raw`(?<!\$)(?P<dollars>\$+)\{(?P<scheme>[a-zA-Z][a-zA-Z0-9+.-]*):`, {
  global: true,
});

/** `${env:VAR}` and `${env:VAR:-default}`. */
const ENV_REF_RE = pythonRegExp(String.raw`\$\{env:(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?P<default>[^}]*))?\}`, {
  global: true,
});

/*
 * Telflo-scoped tokens: they resolve against the publishing organization, so
 * a flow carrying one is broken for every other organization that imports
 * it. The `${org:NAME}` form shares confmap's `$$` parity (checked through
 * liveProviderSchemes). The legacy `$orgvar:NAME` form is plain text:
 * nothing fills it in, so it is no token.
 */
const ORG_TOKEN_RE = pythonRegExp(String.raw`\$\{org:[A-Za-z_][A-Za-z0-9_]*\}`, { global: true });

/** Telflo's own schemes, not confmap providers: reported by checkOrgTokens, accurately. */
const TELFLO_SCHEMES: ReadonlySet<string> = new Set(["org"]);

/** The schemes in `text` the collector would actually expand. */
function liveProviderSchemes(text: string): Set<string> {
  const schemes = new Set<string>();
  for (const match of text.matchAll(PROVIDER_RE)) {
    const { dollars, scheme } = match.groups as { dollars: string; scheme: string };
    if (dollars.length % 2 === 1) schemes.add(scheme);
  }
  return schemes;
}

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

/*
 * Deliberately not a bare `key`: the resource and attributes processors use
 * `key:` to name an attribute (`key: cost.center`), so a bare `key` counts
 * only under a credential-ish parent (SECRET_PARENTS).
 */
const SECRET_KEY_RE = pythonRegExp(
  String.raw`(^|_)(api_?key|token|secret|password|passwd|credential|access_key|` +
    String.raw`secret_key|private_key|client_secret|sas_token)$`,
  { ignoreCase: true },
);

/** Parents under which a bare `key` is a credential (datadog's `api.key`), not an attribute's name. */
const SECRET_PARENTS: ReadonlySet<string> = new Set(["api", "auth", "authentication", "credentials", "basicauth"]);

/** Angle-bracket fill-me-in markers: they leak nothing, but an importer can't fill them in. */
const ANGLE_PLACEHOLDER_RE = pythonRegExp(String.raw`<[A-Z0-9_ -]{3,}>`);

const SECRET_HEADER_RE = pythonRegExp(
  String.raw`^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|` +
    String.raw`dd-api-key|sf-token|x-sf-token|x-honeycomb-team|x-observe-token)$`,
  { ignoreCase: true },
);

/* `region` is deliberately absent: `region: us-east-1` names a cloud region, not a destination. */
const ADDRESS_FIELD_RE = pythonRegExp(
  String.raw`(^|_)(endpoint|url|address|addr|host|uri|dsn|site|broker|brokers|nameserver|resolver)$`,
  { ignoreCase: true },
);

/* Addresses inside the importer's own environment: a sidecar or in-cluster gateway is legitimate, so these warn. */
const LOCAL_HOST_RE = pythonRegExp(
  String.raw`^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|` +
    String.raw`10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|` +
    String.raw`[a-z0-9.-]+\.(svc|svc\.cluster\.local|local|internal))(:\d+)?$`,
  { ignoreCase: true },
);

/** Paths whose contents are credentials or host state: a receiver reading them is an exfiltration path. */
const SENSITIVE_PATHS: readonly string[] = [
  "/var/run/secrets",
  "/run/secrets",
  "/etc/shadow",
  "/etc/passwd",
  "/etc/kubernetes",
  "/root/",
  "/proc/",
  "/sys/",
  "/.ssh",
  "/.aws",
  "/.kube",
  "/.docker",
  "/.config/gcloud",
];

/** Components that need host mounts or cluster-wide RBAC: not unsafe, but the importer grants real privilege. */
const PRIVILEGED_COMPONENTS: ReadonlyMap<string, string> = new Map([
  ["hostmetrics", "reads host CPU, memory, disk and network"],
  ["journald", "reads systemd journal (host mount)"],
  ["k8s_cluster", "cluster-wide read RBAC"],
  ["k8sclusterreceiver", "cluster-wide read RBAC"],
  ["k8s_events", "cluster-wide event read RBAC"],
  ["k8sobjects", "reads arbitrary Kubernetes objects"],
  ["filelog", "reads files from the host filesystem"],
  ["kubeletstats", "kubelet API access"],
]);

/** Extensions that move data or credentials off the host outside the pipelines: destinations too. */
const FORWARDING_EXTENSIONS: ReadonlySet<string> = new Set(["http_forwarder", "oauth2client", "oauth2clientauth"]);

/* `Authorization: "Bearer ${env:TOKEN}"` is the idiomatic form: the scheme word is literal, the secret isn't. */
const AUTH_SCHEME_RE = pythonRegExp(String.raw`^(bearer|basic|token|apikey|api-key|splunk|digest)\b\s*`, {
  ignoreCase: true,
});

interface EnvReference {
  /** `undefined` without `:-`; `''` for `${env:VAR:-}`. */
  fallback: string | undefined;
}

/**
 * Splits a value where its env references end: every one ends with `}`, so
 * none starts after the last `}`. The split changes no answer, only the
 * time: from each `${env:X:-` after the last `}`, ENV_REF_RE's `[^}]*` runs
 * to the end of the value and fails, so a long tail of them is quadratic
 * (as it was in Python); before the last `}`, each one matches what it
 * scans.
 */
function splitAtLastBrace(value: string): { head: string; tail: string } {
  const end = value.lastIndexOf("}") + 1;
  return { head: value.slice(0, end), tail: value.slice(end) };
}

function envReferences(value: string): EnvReference[] {
  const { head } = splitAtLastBrace(value);
  return [...head.matchAll(ENV_REF_RE)].map((match) => ({ fallback: match.groups?.default }));
}

/** Python's `_ENV_REF_RE.sub("", value)`. */
function withoutEnvReferences(value: string): string {
  const { head, tail } = splitAtLastBrace(value);
  return head.replace(ENV_REF_RE, "") + tail;
}

/** True when the value is nothing but `${env:VAR}` references (and `:` or `/`), none with a literal default. */
function isPlaceholderOnly(value: string): boolean {
  const stripped = pythonStrip(withoutEnvReferences(value));
  if (stripped !== "" && stripped !== ":" && stripped !== "/") return false;
  return envReferences(value).every(({ fallback }) => fallback === undefined || fallback === "");
}

/** What is left of a credential once its env references and auth scheme word are gone: empty means nothing is hardcoded. */
function credentialResidue(value: string): string {
  let residue = pythonStrip(withoutEnvReferences(value));
  residue = pythonStrip(residue.replace(AUTH_SCHEME_RE, ""));
  return pythonStrip(pythonStrip(residue, isQuote));
}

/**
 * The literal fallbacks inside `${env:VAR:-default}`: the quiet hole in a
 * "must use ${env:}" rule, since the default applies whenever the importer
 * hasn't set the variable, which is always for someone who just imported it.
 */
function literalDefaults(value: string): string[] {
  return envReferences(value).flatMap(({ fallback }) => (fallback ? [fallback] : []));
}

// ---------------------------------------------------------------------------
// The parsed configuration
// ---------------------------------------------------------------------------

/**
 * The collector's reading, the platform's (apps/web/app/lib/graph/parse.ts's
 * PARSE_OPTIONS without `keepSourceTokens`, which only the graph needs): the
 * API can't import the web, so this is its own copy. `logLevel: "error"`
 * keeps the parser from passing a warning, which can quote the text, to
 * `process.emitWarning`.
 */
const LINT_PARSE_OPTIONS = {
  merge: true,
  prettyErrors: false,
  uniqueKeys: true,
  logLevel: "error",
} as const;

/** How many aliases one text may resolve before it is refused as an alias bomb (`yaml`'s default, the web's too). */
const MAXIMUM_ALIAS_COUNT = 100;

/**
 * The characters PyYAML's reader accepts, as does the collector's parser
 * (YAML's printable set): anything else is `invalid-yaml`, with PyYAML's
 * message. With `u`, a lone surrogate is a code point outside the set.
 */
const NON_PRINTABLE_RE = /[^\t\n\r\x20-\x7e\x85\xa0-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;

/**
 * Line breaks to PyYAML and to the collector's parser (libyaml's, YAML 1.1's
 * breaks) that the `yaml` package doesn't break a line at: a CR not before
 * an LF, U+0085, U+2028 and U+2029. After a comment, one hides the rest of
 * its line from the `yaml` package (`# x<U+2028>exporters: …`) while the
 * collector reads it, so a text with one is `invalid-yaml` rather than
 * linted short. The refusal only ever blocks more.
 */
const UNSUPPORTED_LINE_BREAK_RE = /\r(?!\n)|[\u0085\u2028\u2029]/u;

/** A character's code point as PyYAML's messages write it (`#x0007`). */
const codePointName = (character: string) => `#x${(character.codePointAt(0) as number).toString(16).padStart(4, "0")}`;

/**
 * A key the core schema reads as null, a boolean or a number, kept as
 * written for a path (`~:` is `~`, not Python's `None`). Each is
 * its own object, so `1:` and `'1':` stay two keys.
 */
class KeyAsWritten {
  constructor(
    readonly text: string,
    readonly value: unknown,
  ) {}
}

/** A value as the rules see it: an alias to a key kept as written is that key's value. */
function valueOf(value: unknown): unknown {
  return value instanceof KeyAsWritten ? value.value : value;
}

/**
 * A key, or a section's name, as Python's `str()` gave it for a path, but as
 * written: a string as it is, a key kept as written by its text, a complex
 * key (which PyYAML refused) in flow style.
 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof KeyAsWritten) return value.text;
  if (Array.isArray(value)) return `[${value.map(textOf).join(", ")}]`;
  if (value instanceof Set) return `{${[...value].map(textOf).join(", ")}}`;
  if (value instanceof Map) return `{${[...value].map(([key, item]) => `${textOf(key)}: ${textOf(item)}`).join(", ")}}`;
  return String(value);
}

/** The containers a value holds: a mapping's keys and values, a sequence's or a set's items. */
function* childrenOf(value: unknown): Generator<unknown> {
  if (value instanceof Map) {
    for (const [key, item] of value) {
      yield key;
      yield item;
    }
  } else if (Array.isArray(value) || value instanceof Set) {
    yield* value;
  }
}

/**
 * Whether an alias sits inside the node it names (`a: &a [*a]`), which the
 * `yaml` package resolves into a cycle (a recursive walk would never end);
 * the collector refuses it. Iterative, so depth costs no stack.
 */
function containsCycle(root: unknown): boolean {
  const onPath = new Set<unknown>();
  const stack: { value: unknown; children: Iterator<unknown> }[] = [];
  const enter = (value: unknown): boolean => {
    if (!(value instanceof Map || value instanceof Set || Array.isArray(value))) return false;
    if (onPath.has(value)) return true;
    onPath.add(value);
    stack.push({ value, children: childrenOf(value) });
    return false;
  };
  if (enter(root)) return true;
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as (typeof stack)[number];
    const next = top.children.next();
    if (next.done) {
      onPath.delete(top.value);
      stack.pop();
    } else if (enter(next.value)) {
      return true;
    }
  }
  return false;
}

type ParsedConfig = { ok: true; config: unknown } | { ok: false; message: string };

/**
 * The text as the `yaml` package reads it, its mappings as Maps (so their
 * order is the text's, as a Python dict's was, and a key keeps its type), or
 * the reason it can't be read.
 */
function parseConfig(text: string): ParsedConfig {
  const unprintable = NON_PRINTABLE_RE.exec(text);
  if (unprintable) {
    // PyYAML's position counts code points, as a Python string does.
    const position = [...text.slice(0, unprintable.index)].length;
    return {
      ok: false,
      message:
        `unacceptable character ${codePointName(unprintable[0])}: special characters are not allowed\n` +
        `  in "<unicode string>", position ${position}`,
    };
  }
  const lineBreak = UNSUPPORTED_LINE_BREAK_RE.exec(text);
  if (lineBreak) {
    return {
      ok: false,
      message: `unsupported line break ${codePointName(lineBreak[0])}: the collector reads it as a new line; use \\n`,
    };
  }
  try {
    const document = parseDocument(text, LINT_PARSE_OPTIONS);
    const [error] = document.errors;
    if (error) return { ok: false, message: error.message };
    // Before toJS, so a key read as null, a boolean or a number keeps its
    // text for a path, and two keys with the same text stay two.
    visit(document, {
      Pair(_, pair) {
        if (!isScalar(pair.key)) return;
        const { value } = pair.key;
        if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
          pair.key.value = new KeyAsWritten(pair.key.source ?? String(value), value);
        }
      },
    });
    const config: unknown = document.toJS({ mapAsMap: true, maxAliasCount: MAXIMUM_ALIAS_COUNT });
    if (containsCycle(config)) return { ok: false, message: "An alias refers to a node that contains it." };
    return { ok: true, config };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

type Visit = (key: string, value: unknown, path: string) => void;

/**
 * Calls `visit` with each mapping entry's key, value
 * and the path to its mapping, depth first in the text's order; a
 * sequence's items are walked (`path[index]`) but not visited. Iterative,
 * so depth costs no stack.
 */
function walk(root: unknown, rootPath: string, visit: Visit): void {
  const entriesOf = function* (
    value: unknown,
    path: string,
  ): Generator<{ key?: string; value: unknown; path: string }> {
    if (value instanceof Map) {
      for (const [key, item] of value) {
        const text = textOf(key);
        yield { key: text, value: valueOf(item), path: `${path}.${text}` };
      }
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) yield { value: valueOf(item), path: `${path}[${index}]` };
    }
  };
  const stack = [{ path: rootPath, entries: entriesOf(valueOf(root), rootPath) }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as (typeof stack)[number];
    const next = top.entries.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const entry = next.value;
    if (entry.key !== undefined) visit(entry.key, entry.value, top.path);
    stack.push({ path: entry.path, entries: entriesOf(entry.value, entry.path) });
  }
}

/** Python's `x or {}`, iterated: a mapping's keys, a sequence's or a set's items, a string's characters; else nothing. */
function namesOf(section: unknown): string[] {
  const value = valueOf(section);
  if (value instanceof Map) return [...value.keys()].map(textOf);
  if (value instanceof Set) return [...value].map(textOf);
  if (Array.isArray(value)) return value.map((item) => textOf(valueOf(item)));
  if (typeof value === "string") return [...value];
  return [];
}

/** A top-level section, as Python's `config.get(name) or {}` (a falsy one walks to nothing either way). */
function sectionOf(config: Map<unknown, unknown>, name: string): unknown {
  return valueOf(config.get(name));
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

type Add = (severity: FlowLintSeverity, code: FlowLintCode, message: string, path: string) => void;

function checkProviders(text: string, add: Add): void {
  // Schemes are ASCII, so the default sort is Python's sorted().
  for (const scheme of [...liveProviderSchemes(text)].sort()) {
    if (scheme === "env" || TELFLO_SCHEMES.has(scheme)) continue;
    add(
      "block",
      "provider-not-allowed",
      `Uses the \${${scheme}:...} config provider. Only \${env:...} is allowed in a shared flow — other ` +
        `providers read the importer's files or network at config-load time.`,
      "config",
    );
  }
}

function checkOrgTokens(text: string, add: Add): void {
  // "org" counts only if some `${org:` has an odd run of dollars before it.
  // Tokens are ASCII, so the default sort is Python's sorted().
  if (!liveProviderSchemes(text).has("org")) return;
  for (const token of [...new Set(text.match(ORG_TOKEN_RE) ?? [])].sort()) {
    add(
      "block",
      "org-scoped-reference",
      `Uses the Telflo-scoped token '${token}', which only resolves inside your organization. Inline the value ` +
        `before publishing.`,
      "config",
    );
  }
}

/** Python's `str.rsplit(".", 1)[-1].split("[")[0]`: the last segment of a path, without an index. */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).split("[")[0] as string;
}

function checkSecrets(section: unknown, sectionName: string, add: Add): void {
  walk(section, sectionName, (key, value, path) => {
    if (typeof value !== "string" || value === "") return;
    const full = path ? `${path}.${key}` : key;
    const parent = path ? lastSegment(path).toLowerCase() : "";
    const looksSecret =
      SECRET_KEY_RE.test(key) ||
      SECRET_HEADER_RE.test(key) ||
      (key.toLowerCase() === "key" && SECRET_PARENTS.has(parent));
    if (!looksSecret) return;

    // Fully parameterised, the `Bearer ${env:TOKEN}` form included.
    const residue = credentialResidue(value);
    if (!residue) return;

    // A <FILL_ME_IN> marker is no leak but an unusable configuration: say so.
    if (ANGLE_PLACEHOLDER_RE.test(residue)) {
      add(
        "block",
        "placeholder-credential",
        `'${key}' uses the placeholder '${value}'. Importers can't fill that in — use \${env:...} so it resolves ` +
          `at runtime.`,
        full,
      );
      return;
    }
    add(
      "block",
      "hardcoded-credential",
      `'${key}' contains a literal value. Publishing this would share your own credential — replace it with ` +
        `\${env:...}.`,
      full,
    );
  });
}

function checkDestinations(section: unknown, sectionName: string, add: Add, destinations: string[]): void {
  walk(section, sectionName, (key, value, path) => {
    if (typeof value !== "string" || value === "") return;
    if (!ADDRESS_FIELD_RE.test(key)) return;
    const full = path ? `${path}.${key}` : key;

    for (const fallback of literalDefaults(value)) {
      add(
        "block",
        "literal-endpoint-default",
        `'${key}' falls back to the literal '${fallback}'. An importer who does not set the variable would send ` +
          `data there — remove the default.`,
        full,
      );
    }

    if (isPlaceholderOnly(value)) return;

    destinations.push(`${full} → ${value}`);
    if (LOCAL_HOST_RE.test(pythonStrip(value))) {
      add(
        "warn",
        "local-endpoint",
        `'${key}' points at '${value}', which assumes a specific local topology. Importers may need to change it.`,
        full,
      );
    } else {
      add(
        "block",
        "literal-endpoint",
        `'${key}' is the hardcoded destination '${value}'. Shared flows must use \${env:...} so importers send ` +
          `data to their own backend, not one chosen by the publisher.`,
        full,
      );
    }
  });
}

function checkPaths(receivers: unknown, add: Add): void {
  walk(receivers, "receivers", (key, value, path) => {
    const values = Array.isArray(value) ? value.map(valueOf) : [value];
    for (const item of values) {
      if (typeof item !== "string") continue;
      const lowered = item.toLowerCase();
      if (SENSITIVE_PATHS.some((sensitive) => lowered.includes(sensitive))) {
        add(
          "block",
          "sensitive-path",
          `Reads '${item}', which holds credentials or host state. A flow that reads secrets and exports ` +
            `telemetry is an exfiltration path.`,
          `${path}.${key}`,
        );
      }
    }
  });
}

function checkPrivileges(config: Map<unknown, unknown>, add: Add, destinations: string[]): void {
  for (const section of ["receivers", "extensions"]) {
    for (const name of namesOf(sectionOf(config, section))) {
      const base = name.split("/")[0] as string;
      const privilege = PRIVILEGED_COMPONENTS.get(base);
      if (privilege !== undefined) {
        add("warn", "privileged-component", `'${base}' requires elevated access: ${privilege}.`, `${section}.${name}`);
      }
      if (FORWARDING_EXTENSIONS.has(base)) destinations.push(`${section}.${name} (forwards traffic)`);
    }
  }
}

function checkTlsAndLimits(config: Map<unknown, unknown>, add: Add): void {
  walk(config, "", (key, value, path) => {
    if ((key === "insecure" || key === "insecure_skip_verify") && value === true) {
      add("warn", "tls-verification-disabled", `'${key}: true' disables certificate verification.`, `${path}.${key}`);
    }
  });

  const processors = namesOf(sectionOf(config, "processors"));
  if (!processors.some((name) => name.split("/")[0] === "memory_limiter")) {
    add(
      "warn",
      "no-memory-limiter",
      "No memory_limiter processor. Under load the collector can be OOM-killed instead of applying backpressure.",
      "processors",
    );
  }
}

/**
 * Lints a configuration about to be published as a flow. `blocked` is
 * whether any finding blocks; the findings and destinations are in the
 * rules' order.
 */
export function lintFlowConfig(yaml: string): FlowLintResponse {
  const findings: FlowLintFinding[] = [];
  const destinations: string[] = [];
  const add: Add = (severity, code, message, path) => void findings.push({ severity, code, message, path });
  const report = (): FlowLintResponse => ({
    blocked: findings.some((finding) => finding.severity === "block"),
    findings,
    destinations,
  });

  if (!yaml || !pythonStrip(yaml)) {
    add("block", "empty-config", "The configuration is empty.", "config");
    return report();
  }

  // The raw-text rules run first: a provider reference is dangerous whether
  // or not the YAML is valid.
  checkProviders(yaml, add);
  checkOrgTokens(yaml, add);

  const parsed = parseConfig(yaml);
  if (!parsed.ok) {
    add("block", "invalid-yaml", `Configuration is not valid YAML: ${parsed.message}`, "config");
    return report();
  }
  const { config } = parsed;
  if (!(config instanceof Map)) {
    add("block", "invalid-config", "Configuration must be a YAML mapping.", "config");
    return report();
  }

  // Credentials are checked everywhere; destinations only where data leaves:
  // a receiver's `endpoint` is a bind address, not a destination.
  checkSecrets(config, "", add);
  checkDestinations(sectionOf(config, "exporters"), "exporters", add, destinations);
  checkDestinations(sectionOf(config, "extensions"), "extensions", add, destinations);
  checkPaths(sectionOf(config, "receivers"), add);
  checkPrivileges(config, add, destinations);
  checkTlsAndLimits(config, add);

  return report();
}
