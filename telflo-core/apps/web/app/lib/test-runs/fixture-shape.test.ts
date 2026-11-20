/*
 * The fixture-shape check's cases, and the target pipeline's narrowing. The
 * corpus cases shared with the tester are in fixture-shape.parity.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  SNIFF_BYTES,
  detectFixtureMismatch,
  detectFixtureShape,
  fixtureStrategyMismatchAdvisory,
  pickStrategyKind,
} from "./fixture-shape.js";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// A valid OTLP envelope padded past the sniff cap, then sliced to the head
// the executor would actually pass — a truncated prefix JSON.parse can no
// longer parse. `indent` undefined → minified (single line); a number →
// pretty-printed (multi-line).
function bigEnvelopeHead(indent?: number): Uint8Array {
  const payload = JSON.stringify(
    {
      resourceLogs: [
        {
          resource: {},
          scopeLogs: [{ logRecords: [{ body: { stringValue: "x".repeat(200000) } }] }],
        },
      ],
    },
    null,
    indent,
  );
  const buf = bytes(payload);
  expect(buf.length).toBeGreaterThan(SNIFF_BYTES);
  return buf.slice(0, SNIFF_BYTES);
}

// ---------------------------------------------------------------------------
// detectFixtureShape — mirror of the Python test_fixture_shape.py matrix
// ---------------------------------------------------------------------------

describe("detectFixtureShape", () => {
  it("classifies empty bytes as empty", () => {
    expect(detectFixtureShape(new Uint8Array())).toBe("empty");
  });

  it("classifies whitespace-only as empty", () => {
    expect(detectFixtureShape(bytes("   \n\t\r\n  "))).toBe("empty");
  });

  it("detects OTLP logs envelope", () => {
    expect(
      detectFixtureShape(bytes(JSON.stringify({ resourceLogs: [] }))),
    ).toBe("otlp_envelope");
  });

  it("detects OTLP metrics + traces envelopes", () => {
    expect(
      detectFixtureShape(bytes(JSON.stringify({ resourceMetrics: [] }))),
    ).toBe("otlp_envelope");
    expect(
      detectFixtureShape(bytes(JSON.stringify({ resourceSpans: [] }))),
    ).toBe("otlp_envelope");
  });

  it("handles UTF-8 BOM prefix on OTLP envelope", () => {
    const inner = JSON.stringify({ resourceLogs: [] });
    const buf = new Uint8Array(inner.length + 3);
    buf[0] = 0xef;
    buf[1] = 0xbb;
    buf[2] = 0xbf;
    buf.set(new TextEncoder().encode(inner), 3);
    expect(detectFixtureShape(buf)).toBe("otlp_envelope");
  });

  it("detects pretty-printed OTLP envelopes across lines", () => {
    const pretty =
      "{\n" +
      '  "resourceLogs": [\n' +
      '    { "resource": {}, "scopeLogs": [] }\n' +
      "  ]\n" +
      "}\n";
    expect(detectFixtureShape(bytes(pretty))).toBe("otlp_envelope");
  });

  it("detects an array of OTLP envelopes", () => {
    expect(
      detectFixtureShape(
        bytes(JSON.stringify([{ resourceLogs: [] }, { resourceLogs: [] }])),
      ),
    ).toBe("otlp_array");
  });

  it("does NOT classify an array of plain dicts as otlp_array", () => {
    // A regression here would let bogus JSON arrays sail through the otlp
    // strategy and surprise the user when the receiver rejected every item.
    expect(
      detectFixtureShape(bytes(JSON.stringify([{ foo: 1 }, { bar: 2 }]))),
    ).toBe("single_json");
  });

  it("returns single_json for a single non-OTLP JSON object", () => {
    expect(
      detectFixtureShape(bytes(JSON.stringify({ msg: "hello" }))),
    ).toBe("single_json");
  });

  it("returns ndjson when every line parses", () => {
    const payload =
      '{"msg":"a","level":"info"}\n' +
      '{"msg":"b","level":"warn"}\n' +
      '{"msg":"c","level":"error"}\n';
    expect(detectFixtureShape(bytes(payload))).toBe("ndjson");
  });

  it("returns raw_lines for plain text logs", () => {
    const payload =
      "2026-05-26 10:14:03 INFO order placed\n" +
      "2026-05-26 10:14:05 WARN payment declined\n";
    expect(detectFixtureShape(bytes(payload))).toBe("raw_lines");
  });

  it("demotes mixed json/text lines to raw_lines (strict NDJSON)", () => {
    const payload =
      '{"msg":"json"}\n' + "plain text line\n" + '{"msg":"more json"}\n';
    expect(detectFixtureShape(bytes(payload))).toBe("raw_lines");
  });

  it("returns single_line for one text line with no newline", () => {
    expect(detectFixtureShape(bytes("just one line of text"))).toBe(
      "single_line",
    );
  });

  // Truncated fixtures: a large OTLP envelope outgrows the 64 KB window and
  // must NOT degrade to raw_lines/single_line (bogus F-001 vs an OTLP
  // pipeline). Mirror of the Python truncation tests.

  it("keeps a truncated minified OTLP envelope as otlp_envelope", () => {
    expect(detectFixtureShape(bigEnvelopeHead())).toBe("otlp_envelope");
  });

  it("keeps a truncated pretty OTLP envelope as otlp_envelope", () => {
    expect(detectFixtureShape(bigEnvelopeHead(2))).toBe("otlp_envelope");
  });

  it("keeps a truncated OTLP array as otlp_array", () => {
    const payload = JSON.stringify([
      { resourceLogs: [{ body: { stringValue: "x".repeat(200000) } }] },
    ]);
    const head = bytes(payload).slice(0, SNIFF_BYTES);
    expect(detectFixtureShape(head)).toBe("otlp_array");
  });

  it("keeps truncated NDJSON as ndjson (checked before the truncation guard)", () => {
    const line = JSON.stringify({ msg: "x".repeat(80) }) + "\n";
    const head = bytes(line.repeat(2000)).slice(0, SNIFF_BYTES);
    expect(detectFixtureShape(head)).toBe("ndjson");
  });

  it("labels a truncated non-OTLP JSON blob single_json, not raw_lines", () => {
    const payload = JSON.stringify({ data: "y".repeat(200000) });
    const head = bytes(payload).slice(0, SNIFF_BYTES);
    expect(detectFixtureShape(head)).toBe("single_json");
  });

  it("leaves truncated raw text as raw_lines (guard only fires on { or [)", () => {
    const head = bytes(
      "2026-05-26 10:14:03 INFO order placed\n".repeat(5000),
    ).slice(0, SNIFF_BYTES);
    expect(detectFixtureShape(head)).toBe("raw_lines");
  });
});

// ---------------------------------------------------------------------------
// fixtureStrategyMismatchAdvisory — shape × strategy matrix
// ---------------------------------------------------------------------------

describe("fixtureStrategyMismatchAdvisory", () => {
  it.each(["otlp_envelope", "otlp_array"] as const)(
    "otlp strategy + %s → no advisory",
    (shape) => {
      expect(fixtureStrategyMismatchAdvisory(shape, "otlp")).toBeNull();
    },
  );

  it.each(["raw_lines", "single_line"] as const)(
    "otlp strategy + %s → F-001 warn",
    (shape) => {
      const advisory = fixtureStrategyMismatchAdvisory(shape, "otlp");
      expect(advisory).not.toBeNull();
      expect(advisory!.id).toBe("F-001");
      expect(advisory!.severity).toBe("warn");
      expect(advisory!.details.fixture_shape).toBe(shape);
      expect(advisory!.details.strategy).toBe("otlp");
    },
  );

  it("otlp strategy + ndjson → F-001 nudging toward filelog", () => {
    const advisory = fixtureStrategyMismatchAdvisory("ndjson", "otlp");
    expect(advisory).not.toBeNull();
    expect(advisory!.id).toBe("F-001");
    expect(advisory!.message).toContain("NDJSON");
    expect(advisory!.message).toContain("filelog");
  });

  it.each(["filelog", "syslog"] as const)(
    "%s strategy + otlp_envelope → F-002 warn",
    (kind) => {
      const advisory = fixtureStrategyMismatchAdvisory(
        "otlp_envelope",
        kind,
      );
      expect(advisory).not.toBeNull();
      expect(advisory!.id).toBe("F-002");
      expect(advisory!.message).toContain(kind);
      // Critical phrasing — without this users don't understand why they
      // got 1 record out instead of N.
      expect(advisory!.message.toLowerCase()).toContain("line");
    },
  );

  it.each(["filelog", "syslog"] as const)(
    "%s strategy + otlp_array → F-002 mentions array",
    (kind) => {
      const advisory = fixtureStrategyMismatchAdvisory("otlp_array", kind);
      expect(advisory).not.toBeNull();
      expect(advisory!.id).toBe("F-002");
      expect(advisory!.message.toLowerCase()).toContain("array");
    },
  );

  it.each([
    ["filelog", "raw_lines"],
    ["filelog", "ndjson"],
    ["filelog", "single_line"],
    ["filelog", "single_json"],
    ["syslog", "raw_lines"],
    ["syslog", "ndjson"],
  ] as const)("%s strategy + %s → no advisory", (kind, shape) => {
    expect(fixtureStrategyMismatchAdvisory(shape, kind)).toBeNull();
  });

  it.each(["otlp", "filelog", "syslog"] as const)(
    "empty fixture + %s → no advisory (empty-output path owns this)",
    (kind) => {
      expect(fixtureStrategyMismatchAdvisory("empty", kind)).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// pickStrategyKind — must match the Python pick_strategy signal-scoping
// ---------------------------------------------------------------------------

describe("pickStrategyKind", () => {
  it("picks filelog when a filelog receiver is wired to the target signal", () => {
    const yamlCfg =
      "receivers:\n" +
      "  filelog:\n" +
      "    include: [/var/log/x.log]\n" +
      "service:\n" +
      "  pipelines:\n" +
      "    logs:\n" +
      "      receivers: [filelog]\n" +
      "      exporters: [debug]\n";
    expect(pickStrategyKind(yamlCfg, "logs")).toBe("filelog");
  });

  it("picks syslog when a syslog receiver is wired to the target signal", () => {
    const yamlCfg =
      "receivers:\n" +
      "  syslog:\n" +
      "    tcp:\n" +
      "      listen_address: 0.0.0.0:514\n" +
      "    protocol: rfc5424\n" +
      "service:\n" +
      "  pipelines:\n" +
      "    logs:\n" +
      "      receivers: [syslog]\n" +
      "      exporters: [debug]\n";
    expect(pickStrategyKind(yamlCfg, "logs")).toBe("syslog");
  });

  it("matches receivers with an /instance suffix", () => {
    const yamlCfg =
      "receivers:\n" +
      "  filelog/app1:\n" +
      "    include: [/var/log/x.log]\n" +
      "service:\n" +
      "  pipelines:\n" +
      "    logs:\n" +
      "      receivers: [filelog/app1]\n" +
      "      exporters: [debug]\n";
    expect(pickStrategyKind(yamlCfg, "logs")).toBe("filelog");
  });

  it("ignores filelog if it's not wired to the target signal pipeline", () => {
    // A traces test with both otlp (for traces) and filelog (for logs)
    // declared at top level MUST pick OTLP — exactly the signal-scoped
    // behavior in the Python detect_testable_receiver.
    const yamlCfg =
      "receivers:\n" +
      "  otlp:\n" +
      "    protocols:\n" +
      "      http: {}\n" +
      "  filelog:\n" +
      "    include: [/var/log/x.log]\n" +
      "service:\n" +
      "  pipelines:\n" +
      "    traces:\n" +
      "      receivers: [otlp]\n" +
      "      exporters: [debug]\n" +
      "    logs:\n" +
      "      receivers: [filelog]\n" +
      "      exporters: [debug]\n";
    expect(pickStrategyKind(yamlCfg, "traces")).toBe("otlp");
  });

  it("returns otlp as the safe default for garbage YAML", () => {
    expect(pickStrategyKind("not: [valid: yaml", "logs")).toBe("otlp");
  });

  it("returns otlp when there's no matching pipeline", () => {
    const yamlCfg =
      "receivers:\n" +
      "  filelog: {}\n" +
      "service:\n" +
      "  pipelines:\n" +
      "    logs:\n" +
      "      receivers: [filelog]\n" +
      "      exporters: [debug]\n";
    expect(pickStrategyKind(yamlCfg, "traces")).toBe("otlp");
  });
});

// ---------------------------------------------------------------------------
// detectFixtureMismatch — end-to-end glue
// ---------------------------------------------------------------------------

describe("detectFixtureMismatch", () => {
  it("returns F-002 for filelog pipeline + OTLP envelope (the bug we set out to catch)", () => {
    const yamlCfg =
      "receivers:\n" +
      "  filelog:\n" +
      "    include: [/var/log/x.log]\n" +
      "service:\n" +
      "  pipelines:\n" +
      "    logs:\n" +
      "      receivers: [filelog]\n" +
      "      exporters: [debug]\n";
    const fixture = bytes(JSON.stringify({ resourceLogs: [] }));
    const advisory = detectFixtureMismatch({
      yamlConfig: yamlCfg,
      signalType: "logs",
      fixtureHead: fixture,
    });
    expect(advisory).not.toBeNull();
    expect(advisory!.id).toBe("F-002");
  });

  it("returns null when the fixture matches the strategy", () => {
    const yamlCfg =
      "receivers:\n" +
      "  otlp:\n" +
      "    protocols:\n" +
      "      http: {}\n" +
      "service:\n" +
      "  pipelines:\n" +
      "    logs:\n" +
      "      receivers: [otlp]\n" +
      "      exporters: [debug]\n";
    const fixture = bytes(JSON.stringify({ resourceLogs: [] }));
    const advisory = detectFixtureMismatch({
      yamlConfig: yamlCfg,
      signalType: "logs",
      fixtureHead: fixture,
    });
    expect(advisory).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// The target pipeline: the tester's narrowing
// ---------------------------------------------------------------------------

/** A logs pipeline fed by filelog, and a sibling logs pipeline fed by OTLP. */
const SIBLINGS =
  "receivers:\n" +
  "  otlp: {protocols: {http: {}}}\n" +
  "  filelog: {include: [/a.log]}\n" +
  "service:\n" +
  "  pipelines:\n" +
  "    logs:      {receivers: [filelog], exporters: [debug]}\n" +
  "    logs/otlp: {receivers: [otlp],    exporters: [debug]}\n";

describe("pickStrategyKind with the target pipeline", () => {
  it("narrows to the target's receivers: a sibling filelog pipeline of the same signal doesn't win", () => {
    expect(pickStrategyKind(SIBLINGS, "logs", "logs/otlp")).toBe("otlp");
    // Without the target, every logs pipeline's receivers count, as before.
    expect(pickStrategyKind(SIBLINGS, "logs")).toBe("filelog");
  });

  it("picks the target's own filelog", () => {
    expect(pickStrategyKind(SIBLINGS, "logs", "logs")).toBe("filelog");
  });

  it("falls back to the signal's pipelines when the target names none of the text's (a stale name)", () => {
    expect(pickStrategyKind(SIBLINGS, "logs", "logs/gone")).toBe("filelog");
  });

  it("reads a target with no receivers, or one that isn't a mapping, as OTLP", () => {
    const text =
      "receivers:\n  filelog: {}\nservice:\n  pipelines:\n    logs: {receivers: [filelog]}\n    logs/empty: {}\n    logs/odd: [filelog]\n";
    expect(pickStrategyKind(text, "logs", "logs/empty")).toBe("otlp");
    expect(pickStrategyKind(text, "logs", "logs/odd")).toBe("otlp");
  });

  it("reads receivers that aren't a mapping as none", () => {
    expect(pickStrategyKind("receivers: [filelog]\nservice:\n  pipelines:\n    logs: {receivers: [filelog]}\n", "logs")).toBe("otlp");
  });

  it("honors merge keys, as the editor reads the text", () => {
    const text =
      "receivers:\n  filelog: {include: [/a.log]}\nbase: &base {receivers: [filelog]}\nservice:\n  pipelines:\n    logs:\n      <<: *base\n      exporters: [debug]\n";
    expect(pickStrategyKind(text, "logs", "logs")).toBe("filelog");
  });
});

describe("detectFixtureMismatch with the target pipeline", () => {
  const envelope = bytes(JSON.stringify({ resourceLogs: [] }));
  const lines = bytes("2026-05-26 10:14:03 INFO order placed\n2026-05-26 10:14:05 WARN payment declined\n");

  it("raises no F-002 for an OTLP envelope on the OTLP sibling", () => {
    expect(detectFixtureMismatch({ yamlConfig: SIBLINGS, signalType: "logs", targetPipeline: "logs/otlp", fixtureHead: envelope })).toBeNull();
  });

  it("raises F-001 for raw lines on the OTLP sibling, and nothing on the filelog pipeline", () => {
    expect(
      detectFixtureMismatch({ yamlConfig: SIBLINGS, signalType: "logs", targetPipeline: "logs/otlp", fixtureHead: lines })?.id,
    ).toBe("F-001");
    expect(detectFixtureMismatch({ yamlConfig: SIBLINGS, signalType: "logs", targetPipeline: "logs", fixtureHead: lines })).toBeNull();
  });

  it("reads only the first SNIFF_BYTES of a longer head", () => {
    // Whole, an OTLP envelope (F-002 on the filelog pipeline); its first
    // SNIFF_BYTES, an opening brace and spaces, which warrant nothing.
    const head = bytes("{" + " ".repeat(SNIFF_BYTES) + '"resourceLogs": []}');
    expect(detectFixtureShape(head)).toBe("otlp_envelope");
    expect(detectFixtureMismatch({ yamlConfig: SIBLINGS, signalType: "logs", targetPipeline: "logs", fixtureHead: head })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// file_log, filelog's name from collector 0.149.0
// ---------------------------------------------------------------------------

describe("file_log, filelog's later name", () => {
  const text = (receiver: string) =>
    `receivers:\n  ${receiver}/app:\n    include: [/var/log/x.log]\n    operators: [{type: regex_parser, regex: '^(?P<level>[A-Z]+) (?P<message>.*)$'}]\n` +
    `  otlp: {protocols: {http: {}}}\nservice:\n  pipelines:\n    logs: {receivers: [${receiver}/app], exporters: [debug]}\n    logs/otlp: {receivers: [otlp], exporters: [debug]}\n`;

  it.each([
    ["logs", "logs"],
    ["logs", "logs/otlp"],
    ["logs", null],
    ["traces", null],
  ] as const)("takes the strategy filelog takes, either spelling (signal %s, target %s)", (signal, target) => {
    expect(pickStrategyKind(text("file_log"), signal, target)).toBe(pickStrategyKind(text("filelog"), signal, target));
  });

  it("takes the filelog strategy, and raises F-002 for an OTLP envelope, as filelog does", () => {
    expect(pickStrategyKind(text("file_log"), "logs", "logs")).toBe("filelog");
    const envelope = bytes(JSON.stringify({ resourceLogs: [] }));
    const advisory = detectFixtureMismatch({ yamlConfig: text("file_log"), signalType: "logs", targetPipeline: "logs", fixtureHead: envelope });
    expect(advisory).toEqual(detectFixtureMismatch({ yamlConfig: text("filelog"), signalType: "logs", targetPipeline: "logs", fixtureHead: envelope }));
    expect(advisory?.id).toBe("F-002");
    expect(advisory?.message).toContain("uses a `file_log` (or `filelog`) receiver. `file_log` reads input line by line");
  });

  it("names syslog's receiver as before", () => {
    expect(fixtureStrategyMismatchAdvisory("otlp_envelope", "syslog")?.message).toContain(
      "uses a `syslog` receiver. `syslog` reads input line by line",
    );
  });

  it("matches no receiver by an inherited property's name", () => {
    const yamlConfig = "receivers:\n  constructor: {}\nservice:\n  pipelines:\n    logs: {receivers: [constructor], exporters: [debug]}\n";
    expect(pickStrategyKind(yamlConfig, "logs", "logs")).toBe("otlp");
  });
});
