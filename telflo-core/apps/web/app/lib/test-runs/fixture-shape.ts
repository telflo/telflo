import { parse } from "yaml";

/*
 * The fixture-shape check before a run is queued. It mirrors the tester's
 * `services/otelcol-testing/app/fixture_shape.py` and its strategy picker
 * (`app/executors/__init__.py`'s `pick_strategy`, with
 * `app/testable_receivers.py`'s `detect_testable_receiver`), so the browser
 * can offer "Run Anyway" or Cancel before anything is queued. The tester
 * re-detects on its own and attaches the same F-001/F-002/F-003 advisory to
 * the run's mutations either way.
 *
 * The one copy of the parity corpus,
 * `services/otelcol-testing/tests/fixtures/fixture-shape-corpus.json`, is
 * read by both suites (the tester's `tests/test_fixture_shape_parity.py` and
 * this module's `fixture-shape.parity.test.ts`): a change to the shapes, the
 * messages or the strategy picking goes into both modules and the corpus.
 *
 * - the strategy narrows to the target pipeline when it names one of the
 *   text's pipelines, as the tester's does, so a sibling filelog pipeline of
 *   the same signal can't pick the wrong strategy;
 * - the text is read with `yaml` (the editor's parser, with its options:
 *   merge keys, unique keys) instead of js-yaml; a text that doesn't read is
 *   OTLP, as before;
 * - a receivers, service or pipelines value that isn't a mapping is read as
 *   none, as the tester reads it;
 * - `file_log`, filelog's name from collector 0.149.0, takes the filelog
 *   strategy too, and the advisories name the receiver `file_log` (or
 *   `filelog`).
 */

export type FixtureShape = "empty" | "otlp_envelope" | "otlp_array" | "ndjson" | "single_json" | "raw_lines" | "single_line";

export type StrategyKind = "otlp" | "filelog" | "syslog";

/** How much of a fixture the check reads: its first 64 KiB, as the tester's. */
export const SNIFF_BYTES = 64 * 1024;

const OTLP_ENVELOPE_KEYS = ["resourceLogs", "resourceMetrics", "resourceSpans"] as const;

// Which OTLP envelope key carries which signal, for F-003. The OTLP/HTTP
// receiver decodes a payload as the signal of the endpoint it was POSTed to,
// so a `resourceLogs` body sent to /v1/traces yields zero spans.
const ENVELOPE_KEY_TO_SIGNAL: Record<string, string> = {
  resourceSpans: "traces",
  resourceMetrics: "metrics",
  resourceLogs: "logs",
};
const SIGNAL_TO_ENVELOPE_KEY: Record<string, string> = {
  traces: "resourceSpans",
  metrics: "resourceMetrics",
  logs: "resourceLogs",
};

const NDJSON_SAMPLE_LINES = 50;

// The receivers the tester feeds by pull (filelog) or push (syslog), by every
// name they go by: the catalogue renamed `filelog` to `file_log` from
// collector 0.149.0 (its `renamedTypes`; the old name still works), and both
// take the filelog strategy, as in the tester's testable_receivers.py.
// `syslog` has no rename. A key may carry an `/instance` suffix
// (`filelog/app1`), stripped before matching. A Map, so a key such as
// `constructor` matches nothing.
const TESTABLE_RECEIVERS: ReadonlyMap<string, StrategyKind> = new Map([
  ["filelog", "filelog"],
  ["file_log", "filelog"],
  ["syslog", "syslog"],
]);

// How the advisories name a strategy's receiver: the name, and its first
// mention. The filelog strategy's receiver is `file_log` on every collector
// the platform offers, so its words give both spellings, as the tester's
// fixture_shape.py does.
const RECEIVER_WORDS: Record<"filelog" | "syslog", { name: string; firstMention: string }> = {
  filelog: { name: "file_log", firstMention: "`file_log` (or `filelog`)" },
  syslog: { name: "syslog", firstMention: "`syslog`" },
};

/** The editor's parser options (lib/graph/parse.ts' PARSE_OPTIONS), without the source tokens. */
const YAML_OPTIONS = { merge: true, uniqueKeys: true, prettyErrors: false, maxAliasCount: 100 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeOtlpEnvelope(value: unknown): boolean {
  return isRecord(value) && OTLP_ENVELOPE_KEYS.some((key) => key in value);
}

function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

// A sniff that filled the window and opens like JSON but didn't parse whole:
// its closing tail is past the window. Envelope keys in the visible prefix
// keep F-002 firing against filelog/syslog without a bogus F-001 against an
// OTLP pipeline; no key is single_json (warns for neither), the false
// negative accepted over the false positive.
function classifyTruncatedJson(stripped: string): FixtureShape {
  const hasEnvelopeKey = OTLP_ENVELOPE_KEYS.some((key) => stripped.includes(key));
  if (stripped[0] === "[") return hasEnvelopeKey ? "otlp_array" : "single_json";
  return hasEnvelopeKey ? "otlp_envelope" : "single_json";
}

// UTF-8, with a BOM stripped so a BOM-prefixed envelope still reads as one.
function decodeSniff(data: Uint8Array): string {
  const body = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data;
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

/** The shape of a fixture's head (its first SNIFF_BYTES). */
export function detectFixtureShape(data: Uint8Array): FixtureShape {
  if (data.length === 0) return "empty";
  const text = decodeSniff(data);
  const stripped = text.trim();
  if (!stripped) return "empty";

  // The whole sniff as one JSON document first: envelopes and arrays small
  // enough to fit in the window.
  let document: unknown = null;
  try {
    document = JSON.parse(stripped);
  } catch {
    document = null;
  }
  if (document !== null) {
    if (looksLikeOtlpEnvelope(document)) return "otlp_envelope";
    if (Array.isArray(document) && document.length > 0 && document.every((item) => looksLikeOtlpEnvelope(item))) {
      return "otlp_array";
    }
    return "single_json";
  }

  const nonblank = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (nonblank.length === 0) return "empty";

  // NDJSON before the truncated-JSON guard: a large NDJSON file opens with
  // `{` too. Strict: every sampled line must parse (a mixed file is
  // raw_lines).
  const sample = nonblank.slice(0, NDJSON_SAMPLE_LINES);
  if (nonblank.length > 1 && sample.every(isJsonLine)) return "ndjson";

  // The head of a large structural document whose closing braces fell
  // outside the window.
  if (data.length >= SNIFF_BYTES && (stripped[0] === "{" || stripped[0] === "[")) {
    return classifyTruncatedJson(stripped);
  }

  if (nonblank.length === 1) return "single_line";
  return "raw_lines";
}

export interface MismatchAdvisory {
  id: "F-001" | "F-002" | "F-003";
  severity: "warn";
  message: string;
  details: {
    fixture_shape: FixtureShape;
    strategy: StrategyKind;
    /** Set on F-003 only. */
    fixture_signal?: string;
    target_signal?: string;
  };
}

/**
 * The OTLP signal (`traces`, `metrics`, `logs`) a fixture's head carries, or
 * null when it isn't one determinable single-signal envelope or array.
 */
export function detectOtlpSignal(data: Uint8Array): string | null {
  if (data.length === 0) return null;
  const text = decodeSniff(data);
  const stripped = text.trim();
  if (!stripped) return null;

  let document: unknown = null;
  try {
    document = JSON.parse(stripped);
  } catch {
    document = null;
  }
  if (document !== null) {
    if (Array.isArray(document)) return document.length > 0 ? signalOfEnvelope(document[0]) : null;
    return signalOfEnvelope(document);
  }

  // A truncated envelope: exactly one envelope key in the visible prefix, so
  // a stray attribute name can't flip the verdict.
  if (data.length >= SNIFF_BYTES && (stripped[0] === "{" || stripped[0] === "[")) {
    const present = OTLP_ENVELOPE_KEYS.filter((key) => stripped.includes(key));
    if (present.length === 1) return ENVELOPE_KEY_TO_SIGNAL[present[0]!] ?? null;
  }
  return null;
}

function signalOfEnvelope(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const present = OTLP_ENVELOPE_KEYS.filter((key) => key in value);
  return present.length === 1 ? (ENVELOPE_KEY_TO_SIGNAL[present[0]!] ?? null) : null;
}

/** F-003's message, byte for byte the tester's (the corpus checks both). */
function signalMismatchMessage(fixtureSignal: string, signalType: string): string {
  const key = SIGNAL_TO_ENVELOPE_KEY[signalType];
  return (
    `Your fixture contains OTLP ${fixtureSignal} data, but the target ` +
    `pipeline handles ${signalType}. The sandbox POSTs the fixture to the ` +
    `OTLP/HTTP ${signalType} endpoint, which decodes ${fixtureSignal} data ` +
    `as zero ${signalType} records — so the run is likely to produce no ` +
    `output. Select a ${signalType} fixture (an OTLP envelope with ` +
    `\`${key}\`), or run this fixture against a ${fixtureSignal} pipeline.`
  );
}

/** The advisory a fixture of `shape` warrants for a pipeline fed by `strategyKind`, or null. */
export function fixtureStrategyMismatchAdvisory(
  shape: FixtureShape,
  strategyKind: StrategyKind,
  signalType?: string | null,
  fixtureSignal?: string | null,
): MismatchAdvisory | null {
  if (strategyKind === "otlp") {
    if (shape === "raw_lines" || shape === "single_line") {
      return {
        id: "F-001",
        severity: "warn",
        message:
          "Your fixture looks like raw text log lines, but the target pipeline uses an OTLP receiver. The sandbox OTLP/HTTP endpoint will reject each line as invalid JSON, so the run is likely to produce no output. Convert the fixture to OTLP-JSON to test this pipeline, or test a `file_log` (or `filelog`) receiver pipeline against this fixture as-is.",
        details: { fixture_shape: shape, strategy: strategyKind },
      };
    }
    if (shape === "ndjson") {
      return {
        id: "F-001",
        severity: "warn",
        message:
          "Your fixture is NDJSON, but the target pipeline uses an OTLP receiver. Each line is POSTed to the sandbox OTLP/HTTP endpoint and will be rejected unless every line is itself a valid OTLP document (a JSON object containing `resourceLogs`, `resourceMetrics`, or `resourceSpans`). If these are app log records, run the test on a `file_log` (or `filelog`) pipeline with a `json_parser` operator instead.",
        details: { fixture_shape: shape, strategy: strategyKind },
      };
    }
    if (shape === "otlp_envelope" || shape === "otlp_array") {
      // The right shape, perhaps the wrong signal: only when both signals are
      // known and differ.
      if (
        signalType != null &&
        signalType in SIGNAL_TO_ENVELOPE_KEY &&
        fixtureSignal != null &&
        fixtureSignal !== signalType
      ) {
        return {
          id: "F-003",
          severity: "warn",
          message: signalMismatchMessage(fixtureSignal, signalType),
          details: { fixture_shape: shape, strategy: strategyKind, fixture_signal: fixtureSignal, target_signal: signalType },
        };
      }
    }
    return null;
  }

  if (shape === "otlp_envelope" || shape === "otlp_array") {
    const shapeLabel = shape === "otlp_envelope" ? "an OTLP-JSON envelope" : "a JSON array of OTLP envelopes";
    const receiver = RECEIVER_WORDS[strategyKind];
    return {
      id: "F-002",
      severity: "warn",
      message: `Your fixture looks like ${shapeLabel}, but the target pipeline uses a ${receiver.firstMention} receiver. \`${receiver.name}\` reads input line by line, so the whole envelope arrives as a single record with the raw JSON string in \`body\` — your operator chain runs against that one line, not the records nested inside. To test the records as OTLP, run on an otlp-receiver pipeline. To test \`${receiver.name}\` operators, supply a fixture with one log per line.`,
      details: { fixture_shape: shape, strategy: strategyKind },
    };
  }
  return null;
}

/** A pipeline's receivers list, its string entries only (the tester's `_names`). */
function receiverNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

/**
 * The strategy the tester will feed the run with: filelog or syslog when such
 * a receiver feeds the pipeline, else OTLP replay. With `targetPipeline`
 * naming one of the text's pipelines, only its receivers count (what the
 * tester's R-005 leaves running); otherwise the receivers of every pipeline of
 * `signalType`. The first match in the text's receivers order wins. A text
 * that doesn't read as a mapping is OTLP.
 */
export function pickStrategyKind(yamlConfig: string, signalType: string, targetPipeline?: string | null): StrategyKind {
  let document: unknown;
  try {
    document = parse(yamlConfig, YAML_OPTIONS);
  } catch {
    return "otlp";
  }
  if (!isRecord(document)) return "otlp";

  const receivers = document.receivers ?? {};
  if (!isRecord(receivers)) return "otlp";
  const service = document.service ?? {};
  const listed = isRecord(service) ? (service.pipelines ?? {}) : {};
  const pipelines = isRecord(listed) ? listed : {};

  const candidates = new Set<string>();
  if (targetPipeline != null && Object.hasOwn(pipelines, targetPipeline)) {
    const target = pipelines[targetPipeline] ?? {};
    if (isRecord(target)) for (const name of receiverNames(target.receivers)) candidates.add(name);
  } else {
    for (const [name, pipeline] of Object.entries(pipelines)) {
      if (name.split("/", 1)[0] !== signalType || !isRecord(pipeline)) continue;
      for (const receiver of receiverNames(pipeline.receivers)) candidates.add(receiver);
    }
  }

  for (const name of Object.keys(receivers)) {
    if (!candidates.has(name)) continue;
    const kind = TESTABLE_RECEIVERS.get(name.split("/", 1)[0]!);
    if (kind !== undefined) return kind;
  }
  return "otlp";
}

/**
 * The advisory the run would warrant (its text, its target pipeline and
 * signal, and its input's head), or null when it can go ahead silently.
 */
export function detectFixtureMismatch(args: {
  yamlConfig: string;
  signalType: string;
  targetPipeline?: string | null;
  fixtureHead: Uint8Array;
}): MismatchAdvisory | null {
  const head = args.fixtureHead.subarray(0, SNIFF_BYTES);
  const kind = pickStrategyKind(args.yamlConfig, args.signalType, args.targetPipeline);
  return fixtureStrategyMismatchAdvisory(detectFixtureShape(head), kind, args.signalType, detectOtlpSignal(head));
}
