import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { cloneModel, lineDiff, plainModel, read, touchableLines, untouchedLinesLost } from "../../test/text-edit-checks.js";
import { corpusText } from "./corpus/corpus.js";
import { deriveModel, readTextModel } from "./model.js";
import type { Model, PipelineLists } from "./model.js";
import { PARSE_OPTIONS } from "./parse.js";
import type { ParsedText } from "./parse.js";
import type { OTelNode } from "./types.js";
import {
  boxTextReads,
  componentValueText,
  editText,
  listSteps,
  modelsEqual,
  plainNumber,
  plainValue,
  TextEditError,
  valuesEqual,
  writeComponentValue,
  writeValues,
} from "./text-edits.js";
import type { ComponentRename, ListDiffStats, Step, ValueChange, ValuePath } from "./text-edits.js";
import { readValue } from "./value-view.js";

/*
 * D9a Task 4: canvas changes are targeted edits of the text (decision 4;
 * Preflight rulings 1, 5, 8, 10). Each test states the lines a change
 * removes and adds; every other line is kept byte for byte. `edit` also
 * checks that the result reads back as the change's model, and that the
 * graph read from it derives that model again (the round-trip invariant).
 */

type Value = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function edit(text: string, change: (model: Model) => void, renames?: ComponentRename[]) {
  const before = read(text).model;
  const after = cloneModel(before);
  change(after);
  const result = editText(text, before, after, renames ? { renames } : {}).text;
  const back = read(result);
  expect(plainModel(back.model)).toEqual(plainModel(after));
  if (back.model.pipelines.size > 0) {
    expect(plainModel(deriveModel(back.graph, back.model))).toEqual(plainModel(back.model));
  }
  expect(untouchedLinesLost(text, result, touchableLines(text, before, after))).toEqual([]);
  return { text: result, diff: lineDiff(text, result), model: back.model };
}

const value = (model: Model, key: string) => model.components.get(key) as Value;
const lists = (model: Model, name: string) => model.pipelines.get(name)!;
const emptyLists = (): PipelineLists => ({ receivers: [], processors: [], exporters: [] });

function renameIn(model: Model, from: string, to: string, sides: Array<keyof PipelineLists>) {
  const [, oldName] = from.split(/\.(.*)/);
  const [, newName] = to.split(/\.(.*)/);
  model.components.set(to, model.components.get(from));
  model.components.delete(from);
  for (const pipeline of model.pipelines.values()) {
    for (const side of sides) pipeline[side] = pipeline[side].map((name) => (name === oldName ? newName! : name));
  }
  model.extensions = model.extensions.map((name) => (name === oldName ? newName! : name));
}

function clear(model: Model) {
  model.components.clear();
  model.pipelines = new Map(["traces", "metrics", "logs"].map((name) => [name, emptyLists()]));
  model.extensions = [];
}

const starter = corpusText("starter.yaml");
const comments = corpusText("comments.yaml");

describe("each kind of change, on the starter", () => {
  it("adds a component at the end of its section and joins it to a pipeline", () => {
    const { diff } = edit(starter, (model) => {
      model.components.set("receivers.otlp/2", { protocols: { http: { endpoint: "0.0.0.0:4319" } } });
      lists(model, "traces").receivers.push("otlp/2");
    });
    expect(diff).toEqual({
      removed: ["      receivers: [otlp]"],
      added: [
        "  otlp/2:",
        "    protocols:",
        "      http:",
        "        endpoint: 0.0.0.0:4319",
        "      receivers: [otlp, otlp/2]",
      ],
    });
  });

  it("adds a missing section in the sections' order, before the next section", () => {
    const { text, diff } = edit(starter, (model) => {
      model.components.set("connectors.forward", null);
      lists(model, "traces").exporters.push("forward");
      lists(model, "metrics").receivers.push("forward");
    });
    expect(diff).toEqual({
      removed: ["      exporters: [otlp]", "      receivers: [otlp]"],
      added: ["connectors:", "  forward:", "      exporters: [otlp, forward]", "      receivers: [otlp, forward]"],
    });
    expect(text).toContain("      insecure: true\nconnectors:\n  forward:\nextensions:\n");
  });

  it("removes a component's own lines", () => {
    const { diff } = edit(starter, (model) => {
      model.components.delete("extensions.pprof");
      model.extensions = ["health_check", "zpages"];
    });
    expect(diff).toEqual({
      removed: ["  pprof:", "    endpoint: '0.0.0.0:1777'", "  extensions: [health_check, pprof, zpages]"],
      added: ["  extensions: [health_check, zpages]"],
    });
  });

  it("removes a section when its last component goes", () => {
    const { diff } = edit(starter, (model) => {
      model.components.delete("processors.batch");
      for (const pipeline of model.pipelines.values()) pipeline.processors = [];
    });
    expect(diff).toEqual({
      removed: [
        "processors:",
        "  batch:",
        "    timeout: '10s'",
        "    send_batch_size: 1024",
        "      processors: [batch]",
        "      processors: [batch]",
        "      processors: [batch]",
      ],
      added: ["      processors: []", "      processors: []", "      processors: []"],
    });
  });

  it("renames a component in place, and every pipeline list naming it", () => {
    const { diff } = edit(
      starter,
      (model) => renameIn(model, "exporters.otlp", "exporters.otlp/backend", ["exporters"]),
      [{ from: "exporters.otlp", to: "exporters.otlp/backend" }],
    );
    expect(diff).toEqual({
      removed: ["  otlp:", "      exporters: [otlp]", "      exporters: [otlp]", "      exporters: [otlp]"],
      added: [
        "  otlp/backend:",
        "      exporters: [otlp/backend]",
        "      exporters: [otlp/backend]",
        "      exporters: [otlp/backend]",
      ],
    });
  });

  it("renames an extension in service.extensions too", () => {
    const { diff } = edit(
      starter,
      (model) => renameIn(model, "extensions.zpages", "extensions.zpages/debug", []),
      [{ from: "extensions.zpages", to: "extensions.zpages/debug" }],
    );
    expect(diff).toEqual({
      removed: ["  zpages:", "  extensions: [health_check, pprof, zpages]"],
      added: ["  zpages/debug:", "  extensions: [health_check, pprof, zpages/debug]"],
    });
  });

  it("changes a value leaf by leaf, keeping its quoting", () => {
    const { diff } = edit(starter, (model) => {
      value(model, "exporters.otlp").endpoint = "collector:4317";
      value(model, "exporters.otlp").tls.ca_file = "/etc/ca.pem";
      delete value(model, "processors.batch").send_batch_size;
    });
    expect(diff).toEqual({
      removed: ["    send_batch_size: 1024", "    endpoint: 'otelcol:4317'"],
      added: ["    endpoint: 'collector:4317'", "      ca_file: /etc/ca.pem"],
    });
  });

  it("adds a pipeline at the end, with flow lists", () => {
    const { diff } = edit(starter, (model) => {
      model.pipelines.set("traces/audit", { receivers: ["otlp"], processors: [], exporters: ["otlp"] });
    });
    expect(diff).toEqual({
      removed: [],
      added: ["    traces/audit:", "      receivers: [otlp]", "      exporters: [otlp]"],
    });
  });

  it("removes a pipeline's own lines", () => {
    const { diff } = edit(starter, (model) => {
      model.pipelines.delete("metrics");
    });
    expect(diff).toEqual({
      removed: ["    metrics:", "      receivers: [otlp]", "      processors: [batch]", "      exporters: [otlp]"],
      added: [],
    });
  });

  it("changes a pipeline's list in place", () => {
    const { diff } = edit(starter, (model) => {
      lists(model, "logs").receivers = [];
    });
    expect(diff).toEqual({ removed: ["      receivers: [otlp]"], added: ["      receivers: []"] });
  });

  it("disables and enables an extension in service.extensions", () => {
    const disabled = edit(starter, (model) => {
      model.extensions = ["health_check", "zpages"];
    });
    expect(disabled.diff).toEqual({
      removed: ["  extensions: [health_check, pprof, zpages]"],
      added: ["  extensions: [health_check, zpages]"],
    });
    const enabled = edit(disabled.text, (model) => {
      model.extensions = ["health_check", "zpages", "pprof"];
    });
    expect(enabled.diff).toEqual({
      removed: ["  extensions: [health_check, zpages]"],
      added: ["  extensions: [health_check, zpages, pprof]"],
    });
  });
});

describe("each kind of change, on a commented text", () => {
  it("adds a component, keeping the list's comment", () => {
    const { diff } = edit(comments, (model) => {
      model.components.set("receivers.zipkin", {});
      lists(model, "traces").receivers.push("zipkin");
    });
    expect(diff).toEqual({
      removed: ["      receivers: [otlp] # in"],
      added: ["  zipkin: {}", "      receivers: [otlp, zipkin] # in"],
    });
  });

  it("removes a section with the comments indented inside it, keeping the others", () => {
    const { text, diff } = edit(comments, (model) => {
      model.components.delete("processors.batch");
      lists(model, "traces").processors = [];
    });
    expect(diff).toEqual({
      removed: [
        "processors:",
        "  batch: # batches",
        "    timeout: 5s",
        "  # commented-out component:",
        "  # memory_limiter:",
        "  #   limit_mib: 512",
        "      processors:",
        "        - batch # the only one",
      ],
      added: ["      processors: []"],
    });
    expect(text).toContain("# a trailing comment");
  });

  it("renames a component, keeping each reference's comment", () => {
    const { diff } = edit(
      comments,
      (model) => renameIn(model, "receivers.otlp", "receivers.otlp/main", ["receivers"]),
      [{ from: "receivers.otlp", to: "receivers.otlp/main" }],
    );
    expect(diff).toEqual({
      removed: ["  otlp:", "      receivers: [otlp] # in"],
      added: ["  otlp/main:", "      receivers: [otlp/main] # in"],
    });
  });

  it("keeps the comment on a changed line and on its neighbours", () => {
    const { text, diff } = edit(comments, (model) => {
      value(model, "receivers.otlp").protocols.grpc.endpoint = "0.0.0.0:14317";
    });
    expect(diff).toEqual({
      removed: ["        endpoint: 0.0.0.0:4317 # gRPC"],
      added: ["        endpoint: 0.0.0.0:14317 # gRPC"],
    });
    expect(text).toContain("  # the OTLP receiver\n  otlp:\n");
    expect(text).toContain("      http: # HTTP\n");
  });

  it("adds a pipeline before a column-0 comment that follows the last one", () => {
    const { diff } = edit(comments, (model) => {
      model.pipelines.set("logs", { receivers: ["otlp"], processors: ["batch"], exporters: ["debug"] });
    });
    expect(diff).toEqual({
      removed: [],
      added: ["    logs:", "      receivers: [otlp]", "      processors: [batch]", "      exporters: [debug]"],
    });
    expect(lineDiff(comments, edit(comments, (m) => m.pipelines.set("x/y", emptyLists())).text).added).toEqual([
      "    x/y:",
    ]);
  });

  it("removes the last pipeline, leaving an empty mapping", () => {
    const before = read(comments).model;
    const after = cloneModel(before);
    after.pipelines.clear();
    const result = editText(comments, before, after).text;
    expect(lineDiff(comments, result)).toEqual({
      removed: ["  pipelines:", "    traces:", "      receivers: [otlp] # in", "      processors:", "        - batch # the only one", "      exporters: [debug]"],
      added: ["  pipelines: {}"],
    });
    expect(readTextModel(read(result).document).pipelines.size).toBe(0);
  });

  it("changes a block list item by item, keeping the items that stay", () => {
    const { diff } = edit(comments, (model) => {
      lists(model, "traces").processors = ["memory_limiter", "batch"];
    });
    expect(diff).toEqual({ removed: [], added: ["        - memory_limiter"] });
  });

  it("creates service.extensions before the pipelines and their comment", () => {
    const { text, diff } = edit(comments, (model) => {
      model.components.set("extensions.zpages", {});
      model.extensions = ["zpages"];
    });
    expect(diff).toEqual({ removed: [], added: ["extensions:", "  zpages: {}", "  extensions: [zpages]"] });
    expect(text).toContain("service:\n  extensions: [zpages]\n  # the pipelines\n  pipelines:\n");
  });
});

describe("layout outside the edit (Preflight ruling 1)", () => {
  const layout = corpusText("layout-preserved.yaml");

  it("keeps folded and literal blocks, plain multi-line scalars, 0750, a 20-digit integer and 1e3", () => {
    const { text, diff } = edit(layout, (model) => {
      value(model, "extensions.file_storage").directory = "/var/lib/telflo";
      value(model, "processors.transform").error_mode = "propagate";
    });
    expect(diff).toEqual({
      removed: ["    error_mode: ignore", "    directory: /var/lib/otelcol"],
      added: ["    error_mode: propagate", "    directory: /var/lib/telflo"],
    });
    expect(text).toContain('      - >-\n        set(attributes["folded"],\n        "one line")\n');
    expect(text).toContain("    plain_multi: this plain scalar\n      runs on\n");
    expect(text).toContain('    directory_permissions: "0750"\n    big: 12345678901234567890\n    exponent: 1e3\n    leading_zero: 0750\n');
  });

  it("keeps a key-line comment and a spaced comment on a changed line", () => {
    const { diff } = edit(layout, (model) => {
      value(model, "receivers.otlp").protocols.grpc.endpoint = "0.0.0.0:9999";
    });
    expect(diff).toEqual({
      removed: ["        endpoint: 0.0.0.0:4317   # spaced comment"],
      added: ["        endpoint: 0.0.0.0:9999   # spaced comment"],
    });
  });

  it("adds after the last entry, before an indented comment and a column-0 comment", () => {
    const { text } = edit(layout, (model) => {
      model.components.set("processors.filter", { error_mode: "ignore" });
    });
    expect(text).toContain(
      "  batch:\n    timeout: 5s\n  filter:\n    error_mode: ignore\n  # an indented comment\n# a column-0 comment after an indented one\n",
    );
  });

  it("removes a section with its indented comment, keeping the column-0 comment after it", () => {
    const { text, diff } = edit(layout, (model) => {
      model.components.delete("processors.transform");
      model.components.delete("processors.batch");
      lists(model, "traces").processors = [];
    });
    expect(diff.removed).toContain("  # an indented comment");
    expect(diff.removed).not.toContain("# a column-0 comment after an indented one");
    expect(text).toContain("# Layout every edit keeps outside itself (Preflight ruling 1).\nreceivers:\n");
    expect(text).toContain("        endpoint: 0.0.0.0:4317   # spaced comment\n# a column-0 comment after an indented one\nexporters:\n");
  });

  it("keeps a removed first key's preceding comment", () => {
    const text = "receivers:\n  # the first\n  otlp: {}\n  zipkin: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [zipkin]\n      exporters: [debug]\n";
    const result = edit(text, (model) => {
      model.components.delete("receivers.otlp");
    });
    expect(result.diff).toEqual({ removed: ["  otlp: {}"], added: [] });
    expect(result.text).toContain("receivers:\n  # the first\n  zipkin: {}\n");
  });

  it("writes CRLF text with CRLF, every kind of change", () => {
    const crlf = corpusText("crlf.yaml");
    const changes: Array<[string, (model: Model) => void, ComponentRename[]?]> = [
      ["add", (m) => { m.components.set("receivers.zipkin", { endpoint: "0.0.0.0:9411" }); lists(m, "traces").receivers.push("zipkin"); }],
      ["remove", (m) => { m.components.delete("extensions.pprof"); m.extensions = ["health_check", "zpages"]; }],
      ["rename", (m) => renameIn(m, "exporters.otlp", "exporters.otlp/b", ["exporters"]), [{ from: "exporters.otlp", to: "exporters.otlp/b" }]],
      ["value", (m) => { value(m, "exporters.otlp").tls = { insecure: false, ca_file: "/ca.pem" }; value(m, "processors.batch").note = "multi\nline"; }],
      ["pipelines", (m) => { m.pipelines.delete("logs"); m.pipelines.set("logs/b", { receivers: ["otlp"], processors: [], exporters: ["otlp"] }); lists(m, "metrics").processors = []; }],
      ["clear", clear],
    ];
    for (const [, change, renames] of changes) {
      const { text, diff } = edit(crlf, change, renames);
      expect(text.replace(/\r\n/g, "")).not.toContain("\n");
      for (const line of diff.added) expect(line.endsWith("\r") || line === "").toBe(true);
    }
  });

  it("indents new fragments like their siblings: four spaces, sequences indented", () => {
    const four = corpusText("indent-four.yaml");
    const { text, diff } = edit(four, (model) => {
      model.components.set("receivers.filelog/2", { include: ["/a.log", "/b.log"], operators: [{ type: "json" }] });
      lists(model, "logs").receivers.push("filelog/2");
      value(model, "exporters.debug").sampling = { initial: 5 };
    });
    expect(diff.removed).toEqual([]);
    expect(text).toContain(
      "        start_at: end\n    filelog/2:\n        include:\n            - /a.log\n            - /b.log\n        operators:\n            - type: json\n",
    );
    expect(text).toContain("                - otlp # the OTLP one\n                - filelog/2\n");
    expect(text).toContain("        verbosity: basic\n        sampling:\n            initial: 5\n");
  });

  it("indents new fragments like their siblings: sequences at their key's column", () => {
    const unindented = corpusText("sequences-unindented.yaml");
    const { text, diff } = edit(unindented, (model) => {
      model.components.set("receivers.filelog/2", { include: ["/c.log"] });
      model.components.set("extensions.pprof", {});
      model.extensions.push("pprof");
      lists(model, "logs").receivers.push("filelog/2");
      value(model, "receivers.filelog").include.push("/var/log/c.log");
    });
    expect(diff.removed).toEqual([]);
    expect(text).toContain("    - /var/log/b.log\n    - /var/log/c.log\n    exclude: []\n  filelog/2:\n    include:\n    - /c.log\n");
    expect(text).toContain("  extensions:\n  - health_check\n  - pprof\n");
    expect(text).toContain("      receivers:\n      - filelog\n      - filelog/2\n");
  });
});

describe("aliases and merge keys (Preflight ruling 8)", () => {
  const anchors = corpusText("anchors-merges.yaml");
  const owned = corpusText("anchors-owned.yaml");

  it("copies a merged key's whole value onto the component before a nested change", () => {
    const { text, model } = edit(owned, (m) => {
      value(m, "exporters.otlp/gamma").tls.insecure = true;
    });
    expect(value(model, "exporters.otlp/gamma").tls).toEqual({ insecure: true, ca_file: "/etc/ca.pem" });
    expect(text).toContain("x-tls: &tls-defaults\n  tls:\n    insecure: false\n    ca_file: /etc/ca.pem\n");
    expect(text).toContain("  otlp/gamma:\n    <<: *tls-defaults\n    endpoint: c:4317\n    tls:\n      insecure: true\n      ca_file: /etc/ca.pem\n");
  });

  it("overrides a merged key set directly, keeping the merge", () => {
    const { text } = edit(anchors, (m) => {
      value(m, "exporters.otlp_grpc/primary").timeout = "1s";
    });
    expect(text).toContain("    <<: *defaults\n    endpoint: primary:4317\n    tls: *tls\n    timeout: 1s\n");
  });

  it("expands a merge without a key the merge gave, when that key is removed", () => {
    const { text } = edit(anchors, (m) => {
      delete value(m, "exporters.otlp_grpc/backup").compression;
    });
    expect(text).toContain("  otlp_grpc/backup:\n    endpoint: backup:4317\n    timeout: 10s\n");
    expect(text).toContain("x-defaults: &defaults\n  timeout: 5s\n  compression: gzip\n");
  });

  it("expands a merge when a key the map overrides is removed, so the merged value doesn't come back", () => {
    const { text, model } = edit(anchors, (m) => {
      delete value(m, "exporters.otlp_grpc/backup").timeout;
    });
    expect(value(model, "exporters.otlp_grpc/backup")).toEqual({ compression: "gzip", endpoint: "backup:4317" });
    expect(text).toContain("  otlp_grpc/backup:\n    compression: gzip\n    endpoint: backup:4317\n");
  });

  it("replaces an alias on the path by a copy, leaving the anchor alone", () => {
    const { text } = edit(anchors, (m) => {
      value(m, "exporters.otlp_grpc/primary").tls.insecure = false;
    });
    expect(text).toContain("    tls:\n      insecure: false\n");
    expect(text).toContain("x-tls: &tls\n  insecure: true\n");
  });

  it("copies a whole-value alias before a change, leaving the anchor's owner unchanged", () => {
    const { text } = edit(anchors, (m) => {
      value(m, "receivers.otlp/second").protocols.grpc.endpoint = "0.0.0.0:5317";
    });
    expect(text).toContain(
      "  otlp: &otlp-receiver\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n  otlp/second:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:5317\n",
    );
  });

  it("gives an anchor's users copies before its owner changes (a value, a merge and a sequence item)", () => {
    const { text, model } = edit(owned, (m) => {
      value(m, "exporters.otlp/alpha").headers["x-team"] = "core";
      value(m, "exporters.otlp/alpha").retry_on_failure.enabled = false;
    });
    expect(value(model, "exporters.otlp/beta").headers).toEqual({ "x-team": "platform" });
    expect(value(model, "exporters.otlp/beta").retry_on_failure).toEqual({ enabled: true, max_elapsed_time: "60s" });
    expect(value(model, "exporters.otlp/echo").items).toEqual([{ "x-team": "platform" }, "plain"]);
    expect(text).toContain("    headers:\n      x-team: platform\n    retry_on_failure:\n      enabled: true\n      max_elapsed_time: 60s\n");
    expect(text).toContain("    items:\n      - x-team: platform\n      - plain\n");
  });

  it("gives an anchor's users copies before its owner is removed", () => {
    const { model } = edit(owned, (m) => {
      m.components.delete("exporters.otlp/alpha");
      lists(m, "traces").exporters = lists(m, "traces").exporters.filter((name) => name !== "otlp/alpha");
    });
    expect(value(model, "exporters.otlp/beta").headers).toEqual({ "x-team": "platform" });
    expect(value(model, "exporters.otlp/echo").items[0]).toEqual({ "x-team": "platform" });
  });

  it("expands a merge of an anchor whose owner is removed", () => {
    const { text } = edit(anchors, (m) => {
      m.components.delete("processors.batch");
      lists(m, "traces").processors = [];
    });
    expect(text).toContain("processors:\n  batch/large:\n    timeout: 10s\n    send_batch_size: 8192\n");
  });

  it("copies a flow alias as flow", () => {
    const { text } = edit(owned, (m) => {
      value(m, "exporters.otlp/delta").hosts = ["h1", "h2", "h3"];
    });
    expect(text).toContain("    hosts: &hosts [h1, h2, h3]\n");
    expect(text).toContain("    endpoint: e:4317\n    hosts: [h1, h2]\n");
  });

  it("turns a value with nothing in it into a mapping before setting in it", () => {
    const nulls = corpusText("null-values.yaml");
    const { diff } = edit(nulls, (m) => {
      m.components.set("exporters.debug", { verbosity: "detailed" });
      m.components.set("processors.batch", { timeout: "5s" });
    });
    expect(diff).toEqual({
      removed: ["  batch: ~"],
      added: ["  batch:", "    timeout: 5s", "    verbosity: detailed"],
    });
  });

  it("fails loudly when a block value would have to go inside a flow collection", () => {
    const text = "receivers:\n  otlp: &block\n    protocols:\n      grpc: {}\nexporters:\n  debug:\n    samples: [*block]\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
    const before = read(text).model;
    const after = cloneModel(before);
    value(after, "receivers.otlp").protocols.grpc = { endpoint: "x:1" };
    expect(() => editText(text, before, after).text).toThrow(TextEditError);
  });
});

describe("renames, shared components and the text's own model (Preflight ruling 5)", () => {
  it("renames a connector in every receivers and exporters list", () => {
    const forward = corpusText("forward-connector.yaml");
    const before = read(forward).model;
    const connector = [...before.components.keys()].find((key) => key.startsWith("connectors."))!;
    const name = connector.slice("connectors.".length);
    const { text, model } = edit(
      forward,
      (m) => renameIn(m, connector, `${connector}-renamed`, ["receivers", "exporters"]),
      [{ from: connector, to: `${connector}-renamed` }],
    );
    const uses = (m: Model, n: string) =>
      [...m.pipelines.values()].filter((l) => l.receivers.includes(n) || l.exporters.includes(n)).length;
    expect(uses(model, `${name}-renamed`)).toBe(uses(before, name));
    expect(uses(model, name)).toBe(0);
    expect(lineDiff(forward, text).removed.length).toBe(lineDiff(forward, text).added.length);
  });

  it("removes a component shared by pipelines from a list only when its node there goes", () => {
    const { graph, model: textModel } = read(starter);
    const isOtlpReceiver = (node: OTelNode) => node.data.key === "receivers.otlp";
    const withoutNodes = (drop: (node: OTelNode) => boolean) => {
      const dropped = new Set(graph.nodes.filter(drop).map((node) => node.id));
      return {
        ...graph,
        nodes: graph.nodes.filter((node) => !dropped.has(node.id)),
        edges: graph.edges.filter((e) => !dropped.has(e.source) && !dropped.has(e.target)),
      };
    };

    const one = deriveModel(withoutNodes((node) => isOtlpReceiver(node) && node.data.pipeline === "traces"), textModel);
    const oneText = editText(starter, textModel, one).text;
    expect(lineDiff(starter, oneText)).toEqual({ removed: ["      receivers: [otlp]"], added: ["      receivers: []"] });
    expect(read(oneText).model.components.has("receivers.otlp")).toBe(true);

    const all = deriveModel(withoutNodes(isOtlpReceiver), textModel);
    const allText = editText(starter, textModel, all).text;
    expect(read(allText).model.components.has("receivers.otlp")).toBe(false);
    expect(allText).not.toContain("receivers: [otlp]");
    expect(allText.startsWith("# OpenTelemetry Collector Configuration\n# Generated by Telflo\n\nprocessors:\n")).toBe(true);
  });

  it("writes all three default pipelines on an empty text's first change", () => {
    const empty = read("");
    const after = deriveModel(empty.graph, empty.model);
    after.components.set("receivers.otlp", { protocols: { grpc: null } });
    lists(after, "traces").receivers.push("otlp");
    const result = editText("", empty.model, after).text;
    expect(result).toBe(
      "receivers:\n  otlp:\n    protocols:\n      grpc:\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n    metrics:\n    logs:\n",
    );
    expect([...read(result).model.pipelines.keys()]).toEqual(["traces", "metrics", "logs"]);
  });

  it("writes the three default pipelines into a text without pipelines", () => {
    const text = corpusText("no-pipelines.yaml");
    const { graph, model } = read(text);
    const after = deriveModel(graph, model);
    lists(after, "metrics").receivers.push("otlp");
    const result = editText(text, model, after).text;
    expect(lineDiff(text, result)).toEqual({
      removed: [],
      added: ["  pipelines:", "    traces:", "    metrics:", "      receivers: [otlp]", "    logs:"],
    });
  });

  it("never declares a component a pipeline names but nobody declares", () => {
    const text = corpusText("undeclared-references.yaml");
    const { text: result, model } = edit(text, (m) => {
      lists(m, "traces").processors = ["memory_limiter"];
      lists(m, "metrics").exporters.push("debug");
    });
    expect(model.components.has("processors.memory_limiter")).toBe(false);
    expect(model.components.has("exporters.debug")).toBe(false);
    expect(result).not.toMatch(/^ {2}(memory_limiter|debug):/m);
  });

  it("leaves the text alone when nothing differs", () => {
    for (const name of ["starter.yaml", "comments.yaml", "anchors-merges.yaml", "empty.yaml"]) {
      const text = corpusText(name);
      const { model } = read(text);
      expect(editText(text, model, cloneModel(model)).text).toBe(text);
    }
  });
});

describe("service.telemetry, unknown keys and Clear (decisions 4 and 15)", () => {
  const telemetryBlock = (text: string) => {
    const lines = text.split("\n");
    const start = lines.indexOf("  telemetry:");
    let end = start + 1;
    while (end < lines.length && (lines[end]!.startsWith("   ") || lines[end]!.trim() === "")) end++;
    return lines.slice(start, end).join("\n");
  };
  const kinds: Array<[string, (model: Model) => void, ComponentRename[]?]> = [
    ["a component added", (m) => { m.components.set("processors.batch", {}); lists(m, "logs").processors.push("batch"); }],
    ["a component removed", (m) => { m.components.delete("exporters.otlp"); lists(m, "logs").exporters = []; }],
    ["a component renamed", (m) => renameIn(m, "receivers.filelog", "receivers.filelog/app", ["receivers"]), [{ from: "receivers.filelog", to: "receivers.filelog/app" }]],
    ["a value changed", (m) => { value(m, "exporters.otlp").endpoint = "other:4317"; }],
    ["a pipeline added", (m) => { m.pipelines.set("logs/b", { receivers: ["filelog"], processors: [], exporters: ["otlp"] }); }],
    ["a pipeline removed", (m) => { m.pipelines.delete("logs"); }],
    ["a list changed", (m) => { lists(m, "logs").exporters = []; }],
    ["an extension enabled", (m) => { m.components.set("extensions.zpages", {}); m.extensions.push("zpages"); }],
    ["Clear", clear],
  ];

  for (const file of ["service-telemetry.yaml", "service-telemetry-unmodelled.yaml"]) {
    it.each(kinds)(`${file}: service.telemetry is kept byte for byte after %s`, (_kind, change, renames) => {
      const text = corpusText(file);
      const block = telemetryBlock(text);
      expect(block.split("\n").length).toBeGreaterThan(3);
      expect(edit(text, change, renames).text).toContain(block);
    });
  }

  it("Clear keeps the header comment, unknown keys and a trailing comment, and leaves three empty defaults", () => {
    const unknown = corpusText("unknown-keys.yaml");
    const { text, model } = edit(unknown, clear);
    expect(text).toBe(
      [
        "# Unknown components, sections and keys stay in the text.",
        "x-notes:",
        "  owner: platform-team",
        "service:",
        "  flags:",
        "    feature: on",
        "  pipelines:",
        "    logs:",
        "      receivers: []",
        "      processors: []",
        "      exporters: []",
        "      x-comment: unknown pipeline key",
        "    traces:",
        "    metrics:",
        "",
      ].join("\n"),
    );
    expect([...model.pipelines.keys()]).toEqual(["logs", "traces", "metrics"]);

    const cleared = edit(comments, clear).text;
    expect(cleared.startsWith("# Header comment\n# on two lines\n")).toBe(true);
    expect(cleared.endsWith("# a trailing comment\n")).toBe(true);
    expect(cleared).toContain("  # the pipelines\n");

    expect(edit(starter, clear).text).toBe(
      "# OpenTelemetry Collector Configuration\n# Generated by Telflo\n\nservice:\n  extensions: []\n  pipelines:\n    traces:\n      receivers: []\n      processors: []\n      exporters: []\n    metrics:\n      receivers: []\n      processors: []\n      exporters: []\n    logs:\n      receivers: []\n      processors: []\n      exporters: []\n",
    );
  });
});

describe("the YAML box (decision 4)", () => {
  it("shows a component's own text with its comments, and writes an edit back in place", () => {
    const shown = componentValueText(comments, "receivers.otlp");
    expect(shown).toBe("protocols:\n  grpc:\n    endpoint: 0.0.0.0:4317 # gRPC\n  http: # HTTP\n    endpoint: 0.0.0.0:4318");
    const written = writeComponentValue(comments, "receivers.otlp", shown.replace("4318", "4319"));
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(lineDiff(comments, written.text)).toEqual({
      removed: ["        endpoint: 0.0.0.0:4318"],
      added: ["        endpoint: 0.0.0.0:4319"],
    });
  });

  it("reads the box as a mapping or empty, and nothing else", () => {
    expect(boxTextReads("timeout: 5s # shorter\n")).toBe(true);
    expect(boxTextReads("{verbosity: basic}")).toBe(true);
    expect(boxTextReads("")).toBe(true);
    expect(boxTextReads("# only a comment\n")).toBe(true);
    expect(boxTextReads("protocols: [grpc")).toBe(false);
    expect(boxTextReads("- a list")).toBe(false);
    expect(boxTextReads("just text")).toBe(false);
    expect(boxTextReads("a: 1\na: 2")).toBe(false);
    expect(boxTextReads("a: *nowhere")).toBe(false);
  });

  it("shows a component's text from a document the caller already has", () => {
    const document = parseDocument(comments, PARSE_OPTIONS);
    expect(componentValueText(comments, "receivers.otlp", document as ParsedText)).toBe(
      componentValueText(comments, "receivers.otlp"),
    );
  });

  it("adds the box's comments, laid out under the key", () => {
    const written = writeComponentValue(starter, "processors.batch", "# tuned\ntimeout: 5s # shorter\n");
    expect(written).toMatchObject({
      ok: true,
      text: starter.replace("  batch:\n    timeout: '10s'\n    send_batch_size: 1024\n", "  batch:\n    # tuned\n    timeout: 5s # shorter\n"),
    });
  });

  it("writes an inline value back inline, with its comment", () => {
    expect(componentValueText(comments, "exporters.debug")).toBe("{} # prints");
    const written = writeComponentValue(comments, "exporters.debug", "{verbosity: basic} # prints");
    expect(written.ok && lineDiff(comments, written.text)).toEqual({
      removed: ["  debug: {} # prints"],
      added: ["  debug: {verbosity: basic} # prints"],
    });
  });

  it("leaves no value for an empty box, and writes nothing for a box that doesn't read as a mapping", () => {
    const empty = writeComponentValue(starter, "processors.batch", "");
    expect(empty.ok && read(empty.text).model.components.get("processors.batch")).toBe(null);
    expect(empty.ok && empty.text).toContain("processors:\n  batch:\nexporters:\n");
    expect(writeComponentValue(starter, "processors.batch", "timeout: [")).toEqual({ ok: false, reason: "unreadable" });
    expect(writeComponentValue(starter, "processors.batch", "- a\n- b")).toEqual({ ok: false, reason: "unreadable" });
    expect(writeComponentValue(starter, "processors.batch", "a: *nowhere")).toEqual({ ok: false, reason: "unreadable" });
  });

  it("gives the users of an anchor in the old value copies, and refuses an anchor the text uses elsewhere", () => {
    const owned = corpusText("anchors-owned.yaml");
    const written = writeComponentValue(owned, "exporters.otlp/alpha", "endpoint: a:4317\n");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(value(read(written.text).model, "exporters.otlp/beta").headers).toEqual({ "x-team": "platform" });
    expect(writeComponentValue(owned, "exporters.otlp/beta", "a: &hosts 1")).toEqual({ ok: false, reason: "anchor-clash" });
  });

  it("CRLF text keeps CRLF", () => {
    const crlf = corpusText("crlf.yaml");
    const written = writeComponentValue(crlf, "processors.batch", "timeout: 1s\nsend_batch_size: 10\n");
    expect(written.ok && written.text.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("copies taken from the source text (Preflight ruling 8)", () => {
  const defaults = [
    "x-defaults: &defaults",
    "  script: |",
    "    line one",
    "    line two",
    "  note: this plain",
    "    runs on",
    "  mode: !!str 0750",
    "  nested: &nested",
    "    inner: &inner-anchor 1",
    "    other: &other-anchor",
    "      deep: true",
    "  level: basic",
    "processors:",
    "  transform:",
    "    <<: *defaults",
    "    error_mode: ignore",
    "exporters:",
    "  debug: {}",
    "  file:",
    "    inner: *inner-anchor",
    "service:",
    "  pipelines:",
    "    traces:",
    "      processors: [transform]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  it("expands a merge into copies as written: a block scalar, a plain multi-line scalar, a tag, nested anchors dropped", () => {
    const { text, model } = edit(defaults, (m) => {
      delete value(m, "processors.transform").level;
    });
    expect(text).toContain(
      [
        "  transform:",
        "    script: |",
        "      line one",
        "      line two",
        "    note: this plain",
        "      runs on",
        "    mode: !!str 0750",
        "    nested:",
        "      inner: 1",
        "      other:",
        "        deep: true",
        "    error_mode: ignore",
      ].join("\n"),
    );
    expect(value(model, "processors.transform").mode).toBe("0750");
    expect(text).toContain("x-defaults: &defaults\n  script: |\n");
  });

  it("expands a merge in a flow mapping, joining a multi-line flow value", () => {
    const text = "x-d: &d {hosts: [h1,\n    h2], level: basic}\nexporters:\n  debug: {<<: *d, verbosity: basic}\nservice:\n  pipelines:\n    traces:\n      exporters: [debug]\n";
    const { diff } = edit(text, (m) => {
      delete value(m, "exporters.debug").level;
    });
    expect(diff).toEqual({
      removed: ["  debug: {<<: *d, verbosity: basic}"],
      added: ["  debug: {hosts: [h1, h2], verbosity: basic}"],
    });
    const blank = text.replace("[h1,\n    h2]", "\"h1\n\n    h2\"");
    const before = read(blank).model;
    const after = cloneModel(before);
    delete value(after, "exporters.debug").level;
    expect(() => editText(blank, before, after).text).toThrow(TextEditError);
  });

  it("leaves an empty mapping when a merge's only key is removed", () => {
    const text = "x-d: &d\n  level: basic\nexporters:\n  debug:\n    <<: *d\nservice:\n  pipelines:\n    traces:\n      exporters: [debug]\n";
    const { diff } = edit(text, (m) => {
      delete value(m, "exporters.debug").level;
    });
    expect(diff).toEqual({ removed: ["  debug:", "    <<: *d"], added: ["  debug: {}"] });
  });

  it("copies a block scalar alias into a sequence item", () => {
    const text = "receivers:\n  otlp:\n    script: &script |\n      echo one\n    list:\n      - *script\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
    const { text: result } = edit(text, (m) => {
      value(m, "receivers.otlp").script = "echo two\n";
    });
    expect(result).toContain("    list:\n      - |\n        echo one\n");
  });
});

describe("edges of the splices", () => {
  it("replaces a block scalar with a mapping, and a new multi-line string that needs quoting", () => {
    const layout = corpusText("layout-preserved.yaml");
    const { text } = edit(layout, (m) => {
      value(m, "processors.transform").note = { lines: 2 };
      value(m, "processors.transform").lead = "  leading\nspace";
    });
    expect(text).toContain("    note:\n      lines: 2\n");
    expect(text).toContain('    lead: "  leading\\nspace"\n');
  });

  it("appends to a text holding only a comment and no final line break", () => {
    const before = read("# only a comment").model;
    const after = cloneModel(before);
    after.components.set("receivers.otlp", {});
    expect(editText("# only a comment", before, after).text).toBe("# only a comment\nreceivers:\n  otlp: {}");
  });

  it("creates service for service.extensions when a text has no pipelines", () => {
    const text = "extensions:\n  zpages: {}\n";
    const before = read(text).model;
    const after = cloneModel(before);
    after.extensions = ["zpages"];
    expect(editText(text, before, after).text).toBe("extensions:\n  zpages: {}\nservice:\n  extensions: [zpages]\n");
  });

  it("doesn't rename a receivers list entry that names a connector of the same name", () => {
    const text = "receivers:\n  forward: {}\nexporters:\n  debug: {}\nconnectors:\n  forward: {}\nservice:\n  pipelines:\n    traces:\n      exporters: [forward]\n    metrics:\n      receivers: [forward]\n      exporters: [debug]\n";
    const { diff } = edit(
      text,
      (m) => {
        m.components.set("receivers.forward/r", m.components.get("receivers.forward"));
        m.components.delete("receivers.forward");
      },
      [{ from: "receivers.forward", to: "receivers.forward/r" }],
    );
    expect(diff).toEqual({ removed: ["  forward: {}"], added: ["  forward/r: {}"] });
  });

  it("writes the YAML box into a flow section on one line, and refuses a block box there", () => {
    const text = "exporters: {debug: {verbosity: basic}}\nservice:\n  pipelines:\n    traces:\n      exporters: [debug]\n";
    expect(writeComponentValue(text, "exporters.debug", "{verbosity: detailed}")).toMatchObject({
      ok: true,
      text: text.replace("{verbosity: basic}", "{verbosity: detailed}"),
    });
    expect(() => writeComponentValue(text, "exporters.debug", "verbosity: detailed\nsampling: 1")).toThrow(TextEditError);
  });

  it("takes the caller's document, and fails loudly when the text model doesn't match the text", () => {
    const { document, model } = read(starter);
    const after = cloneModel(model);
    value(after, "processors.batch").timeout = "1s";
    expect(editText(starter, model, after, { document }).text).toBe(editText(starter, model, after).text);

    const wrong = cloneModel(model);
    wrong.components.delete("exporters.otlp");
    expect(() => editText(starter, wrong, cloneModel(wrong)).text).toThrow(TextEditError);
    expect(editText(starter, wrong, cloneModel(wrong), { verify: false }).text).toBe(starter);
  });
});

describe("long lists: a one-item change costs linear time (controller ruling)", () => {
  const names = (count: number) => Array.from({ length: count }, (_, i) => `otlp/r${i}`);
  const stats = (): ListDiffStats => ({ cells: 0, fallbackItems: 0 });
  /** The list `steps` build from `a`, checking each old item is kept or deleted once, in order. */
  const rebuild = (a: readonly unknown[], steps: readonly Step[]) => {
    const out: unknown[] = [];
    let next = 0;
    for (const step of steps) {
      if (step.kind === "insert") {
        out.push(step.value);
        continue;
      }
      expect(step.index).toBe(next++);
      if (step.kind === "keep") out.push(a[step.index]);
    }
    expect(next).toBe(a.length);
    return out;
  };
  const kept = (steps: readonly Step[]) => steps.filter((step) => step.kind === "keep").length;
  const moved = (list: string[], from: number, to: number) => {
    const copy = [...list];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item!);
    return copy;
  };

  it("keeps the common prefix and suffix without a table", () => {
    const list = names(6000);
    const cases: Array<[string, string[]]> = [
      ["append", [...list, "otlp/new"]],
      ["remove the first", list.slice(1)],
      ["change one in the middle", list.map((name, i) => (i === 2500 ? "otlp/other" : name))],
    ];
    for (const [, after] of cases) {
      const work = stats();
      const steps = listSteps(list, after, work);
      expect(rebuild(list, steps)).toEqual(after);
      expect(work.fallbackItems).toBe(0);
      expect(work.cells).toBeLessThanOrEqual(4);
      expect(kept(steps)).toBe(after.length === list.length ? list.length - 1 : Math.min(list.length, after.length));
    }
    const small = stats();
    listSteps(names(1500), names(1500).map((name, i) => (i === 700 ? "x" : name)), small);
    expect(small).toEqual({ cells: 4, fallbackItems: 0 });
  });

  it("moves one item in a 6,000-item list with every other item kept", () => {
    const list = names(6000);
    for (const [from, to] of [[3000, 10], [10, 3000]] as const) {
      const after = moved(list, from, to);
      const work = stats();
      const steps = listSteps(list, after, work);
      expect(rebuild(list, steps)).toEqual(after);
      expect(kept(steps)).toBe(5999);
      expect(work.cells).toBe(0);
    }
  });

  it("diffs a large interior permutation without a table: exactly for unique items, correctly with duplicates", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const list = names(6000);
    const middle = list.slice(1000, 5000);
    for (let i = middle.length - 1; i > 0; i--) {
      if (random() < 0.3) {
        const j = Math.floor(random() * (i + 1));
        [middle[i], middle[j]] = [middle[j]!, middle[i]!];
      }
    }
    const after = [...list.slice(0, 1000), ...middle, "otlp/new", ...list.slice(5000)];
    const work = stats();
    const steps = listSteps(list, after, work);
    expect(rebuild(list, steps)).toEqual(after);
    expect(work.cells).toBe(0);
    expect(work.fallbackItems).toBeGreaterThan(0);
    // Exact: as many kept as the longest common subsequence (one rolling row).
    const row = new Int32Array(after.length + 1);
    for (let i = list.length - 1; i >= 0; i--) {
      let diagonal = 0;
      for (let j = after.length - 1; j >= 0; j--) {
        const below = row[j]!;
        row[j] = list[i] === after[j] ? diagonal + 1 : Math.max(below, row[j + 1]!);
        diagonal = below;
      }
    }
    expect(kept(steps)).toBe(row[0]);

    const repeated = list.map((_name, i) => `v${i % 50}`);
    const shuffled = [...repeated.slice(0, 500), ...[...repeated.slice(500, 5500)].reverse(), ...repeated.slice(5500)];
    const duplicates = stats();
    expect(rebuild(repeated, listSteps(repeated, shuffled, duplicates))).toEqual(shuffled);
    expect(duplicates.fallbackItems).toBeGreaterThan(0);
  });

  it("edits a 6,000-name pipeline list in place, quickly, keeping every other item's text", () => {
    const list = names(6000);
    const block = (items: string[]) => items.map((name) => `        - ${name} # ${name.slice(6)}`);
    const text = (items: string[]) =>
      ["exporters:", "  debug: {}", "service:", "  pipelines:", "    traces:", "      receivers:", ...items, "      exporters: [debug]", ""].join("\n");
    const before = text(block(list));
    const textModel = readTextModel(parseDocument(before, PARSE_OPTIONS));
    // Timed twice, the faster kept: the first run also warms the editor's code up.
    const change = (receivers: string[]) => {
      const after = cloneModel(textModel);
      lists(after, "traces").receivers = receivers;
      let result = "";
      let elapsed = Infinity;
      for (let i = 0; i < 2; i++) {
        const started = performance.now();
        result = editText(before, textModel, after).text;
        elapsed = Math.min(elapsed, performance.now() - started);
      }
      return { result, elapsed };
    };
    // The bound is in parses of this text on this machine, not in milliseconds (as D9b's Ruling 86):
    // CI's runner is slower than a laptop (PR #14's first run took 1.79 s against a bound of 1.5 s).
    // The editor's re-parse is this call; the first is a warm-up.
    const parse = () => parseDocument(before, { ...PARSE_OPTIONS, uniqueKeys: false });
    parse();
    let parseTime = Infinity;
    for (let i = 0; i < 2; i++) {
      const at = performance.now();
      parse();
      parseTime = Math.min(parseTime, performance.now() - at);
    }

    const appended = change([...list, "otlp/new"]);
    expect(appended.result).toBe(text([...block(list), "        - otlp/new"]));
    expect(change(list.slice(1)).result).toBe(text(block(list).slice(1)));
    const movedLines = block(list);
    movedLines.splice(3000, 1);
    movedLines.splice(10, 0, "        - otlp/r3000");
    const move = change(moved(list, 3000, 10));
    expect(move.result).toBe(text(movedLines));
    // Each costs about two and a half parses (a laptop: 75 ms against a 30 ms parse). Filtering the list's
    // source items again for each item cost about 8 (PR #14's first run), a table diff of the 3,000 items
    // between the move's ends about 8, and a table diff of the whole list about 25.
    expect(appended.elapsed).toBeLessThan(parseTime * 6);
    expect(move.elapsed).toBeLessThan(parseTime * 6);

    const flow = ["exporters:", "  debug: {}", "service:", "  pipelines:", "    traces:", `      receivers: ['${list[0]}', ${list.slice(1).join(", ")}] # fan-in`, "      exporters: [debug]", ""].join("\n");
    const flowModel = readTextModel(parseDocument(flow, PARSE_OPTIONS));
    const flowAfter = cloneModel(flowModel);
    lists(flowAfter, "traces").receivers = [...list.slice(0, 5999), "otlp/new"];
    expect(editText(flow, flowModel, flowAfter).text).toBe(
      flow.replace(`, ${list[5999]}] # fan-in`, ", otlp/new] # fan-in"),
    );
  });

  it("refuses to leave a duplicate key, and tells keys of different types apart", () => {
    const text = "exporters:\n  debug:\n    1: a\n    '1': b\nservice:\n  pipelines:\n    traces:\n      exporters: [debug]\n";
    const { text: result } = edit(text, (m) => {
      value(m, "exporters.debug").extra = true;
    });
    expect(result).toContain("    1: a\n    '1': b\n    extra: true\n");

    // A text model that misses a component the text has: adding it would declare it twice.
    const { model } = read(starter);
    const wrong = cloneModel(model);
    wrong.components.delete("processors.batch");
    expect(() => editText(starter, wrong, model).text).toThrow("An edit left a duplicate key.");
  });
});

describe("helpers", () => {
  it("compares values and models as the text reads them", () => {
    expect(valuesEqual({ a: [1, { b: NaN }] }, { a: [1, { b: NaN }] })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valuesEqual([1], { 0: 1 })).toBe(false);
    const { model } = read(starter);
    const other = cloneModel(model);
    expect(modelsEqual(model, other)).toBe(true);
    other.extensions.reverse();
    expect(modelsEqual(model, other)).toBe(false);
  });
});

/*
 * D9b Task 1: a form's changes written by key path (D9b decision 2;
 * Preflight rulings 1-3, 10, 11, 13, 14). Each test states the lines a
 * write removes and adds (so every other line is kept, byte for byte), or
 * the exact text around it. `write` also checks that the result is a text
 * the canvas reads, and that no other component, pipeline or extension
 * reads differently.
 */
function write(text: string, base: ValuePath, changes: ValueChange[]) {
  const result = writeValues(text, base, changes);
  const back = read(result.text);
  expect(plainModel(back.model)).toEqual(plainModel(result.model));
  if (text.trim() !== "") {
    const before = read(text).model;
    const key = base.slice(0, 2).join(".");
    const elsewhere = (model: Model) => {
      const copy = cloneModel(model);
      copy.components.delete(key);
      return plainModel(copy);
    };
    if (base[0] !== "service") expect(elsewhere(back.model)).toEqual(elsewhere(before));
  }
  return { text: result.text, diff: lineDiff(text, result.text), model: back.model };
}

describe("values written by key path: each kind of change keeps every other line (D9b decision 2)", () => {
  const items = corpusText("item-lists.yaml");
  const attributes = ["processors", "attributes"];
  const resource = ["processors", "resource"];
  const filter = ["processors", "filter"];
  const transform = ["processors", "transform"];

  it("sets a scalar in place, keeping its quoting and its comment", () => {
    const layout = corpusText("layout-preserved.yaml");
    expect(write(layout, ["receivers", "otlp"], [{ path: ["protocols", "grpc", "endpoint"], value: "0.0.0.0:9999" }]).diff).toEqual({
      removed: ["        endpoint: 0.0.0.0:4317   # spaced comment"],
      added: ["        endpoint: 0.0.0.0:9999   # spaced comment"],
    });
    const crlf = corpusText("crlf.yaml");
    expect(write(crlf, ["processors", "batch"], [{ path: ["timeout"], value: "5s" }]).diff).toEqual({
      removed: ["    timeout: '10s'\r"],
      added: ["    timeout: '5s'\r"],
    });
  });

  it("adds a key at the end of a block mapping, in a flow mapping, and under a component with no value", () => {
    const { text, diff } = write(comments, ["processors", "batch"], [{ path: ["send_batch_size"], value: 100 }]);
    expect(diff).toEqual({ removed: [], added: ["    send_batch_size: 100"] });
    expect(text).toContain("  batch: # batches\n    timeout: 5s\n    send_batch_size: 100\n  # commented-out component:\n");

    const flow = corpusText("flow-style.yaml");
    expect(write(flow, ["processors", "batch"], [{ path: ["x"], value: 1 }]).diff).toEqual({
      removed: ["  batch: {timeout: 5s, send_batch_size: 100}"],
      added: ["  batch: {timeout: 5s, send_batch_size: 100, x: 1}"],
    });

    const nulls = corpusText("null-values.yaml");
    const nested = write(nulls, ["receivers", "otlp"], [{ path: ["protocols", "grpc", "endpoint"], value: "0.0.0.0:4317" }]);
    expect(nested.diff.removed).toEqual([]);
    expect(nested.text).toContain("receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\nprocessors:\n");
  });

  it("removes a key's own lines, keeping the comments around it", () => {
    expect(write(comments, ["receivers", "otlp"], [{ path: ["protocols", "http"], remove: true }]).diff).toEqual({
      removed: ["      http: # HTTP", "        endpoint: 0.0.0.0:4318"],
      added: [],
    });
    // Removing what isn't there changes nothing.
    expect(write(comments, ["receivers", "otlp"], [{ path: ["protocols", "zipkin"], remove: true }]).text).toBe(comments);
    expect(write(items, attributes, [{ path: ["actions", 9], remove: true }]).text).toBe(items);
  });

  it("sets an item's field where it stands, keeping the item's comments", () => {
    const { diff } = write(items, attributes, [
      { path: ["actions", 0, "key"], value: "env" },
      { path: ["actions", 1, "value"], plain: "0640" },
    ]);
    expect(diff).toEqual({
      removed: ["      - key: environment # keep me", "        value: 0750 # octal to the collector"],
      added: ["      - key: env # keep me", "        value: 0640 # octal to the collector"],
    });
  });

  const itemCases = [
    {
      list: "a block",
      base: attributes,
      key: "actions",
      only: 3,
      added: ["        pattern: ^x"],
      addedAt: "        action: upsert\n        pattern: ^x\n      - key: c\n",
      firstRemoved: ["      - key: environment # keep me", "        value: production"],
      firstAdded: ["      - value: production"],
      firstAt: "      # about the first\n      - value: production\n        action: insert\n      - key: mode\n",
      onlyRemoved: ["      - only: one"],
      onlyAdded: ["      - {}"],
    },
    {
      list: "an indentless",
      base: resource,
      key: "attributes",
      only: 2,
      added: ["      pattern: ^x"],
      addedAt: "      action: insert\n      pattern: ^x\n    - only: one\n",
      firstRemoved: ["    - key: service.name # the name", "      value: checkout"],
      firstAdded: ["    - value: checkout"],
      firstAt: "    # indentless, about the first\n    - value: checkout\n      action: upsert\n    - key: mode\n",
      onlyRemoved: ["    - only: one"],
      onlyAdded: ["    - {}"],
    },
  ];

  it.each(itemCases)("in $list list: adds a key to an item, removes its first key, and its only key", (item) => {
    const added = write(items, item.base, [{ path: [item.key, 1, "pattern"], value: "^x" }]);
    expect(added.diff).toEqual({ removed: [], added: item.added });
    expect(added.text).toContain(item.addedAt);

    const first = write(items, item.base, [{ path: [item.key, 0, "key"], remove: true }]);
    expect(first.diff).toEqual({ removed: item.firstRemoved, added: item.firstAdded });
    expect(first.text).toContain(item.firstAt);

    expect(write(items, item.base, [{ path: [item.key, item.only, "only"], remove: true }]).diff).toEqual({
      removed: item.onlyRemoved,
      added: item.onlyAdded,
    });
  });

  it("sets a scalar item in place, and a block-scalar item and a multi-line string by the item's text", () => {
    const span = (index: number, value: unknown) => write(items, filter, [{ path: ["traces", "span", index], value }]).diff;
    expect(span(3, "other")).toEqual({ removed: ["        - plain"], added: ["        - other"] });
    expect(span(0, "x == y")).toEqual({
      removed: ["        - 'attributes[\"a\"] == \"b\"' # quoted"],
      added: ["        - 'x == y' # quoted"],
    });
    expect(span(2, "one line")).toEqual({ removed: ["        - |", "          literal line"], added: ["        - one line"] });
    expect(span(1, "a\nb")).toEqual({
      removed: ["        - >-", "          attributes[\"folded\"] ==", "          \"one line\""],
      added: ["        - |-", "          a", "          b"],
    });
    expect(span(3, "line one\nline two\n")).toEqual({
      removed: ["        - plain"],
      added: ["        - |", "          line one", "          line two"],
    });
    expect(span(3, { a: 1, b: [2] })).toEqual({
      removed: ["        - plain"],
      added: ["        - a: 1", "          b:", "            - 2"],
    });
  });

  it("appends and removes items by their own lines, in block and flow lists; the last leaves []", () => {
    const appended = write(items, attributes, [{ path: ["actions", 4], value: { key: "new", action: "delete" } }]);
    expect(appended.diff).toEqual({ removed: [], added: ["      - key: new", "        action: delete"] });
    expect(appended.text).toContain("      - only: one\n      - key: new\n        action: delete\n  resource:\n");
    expect(write(items, resource, [{ path: ["attributes", 3], value: "x" }]).text).toContain("    - only: one\n    - x\n  filter:\n");
    expect(write(items, attributes, [{ path: ["actions", 1], remove: true }]).diff).toEqual({
      removed: ["      - key: mode", "        value: 0750 # octal to the collector", "        action: upsert"],
      added: [],
    });

    const statements = (changes: ValueChange[]) =>
      write(items, transform, changes).text.split("\n").find((line) => line.startsWith("    trace_statements:"));
    expect(statements([{ path: ["trace_statements", 3], value: "set(c)" }])).toBe(
      "    trace_statements: [set(a), 'set(b)', 0750, set(c)] # flow",
    );
    expect(statements([{ path: ["trace_statements", 1], remove: true }])).toBe("    trace_statements: [set(a), 0750] # flow");
    expect(statements([{ path: ["trace_statements", 2], remove: true }])).toBe("    trace_statements: [set(a), 'set(b)'] # flow");
    const emptied: ValueChange[] = [0, 1, 2].map(() => ({ path: ["trace_statements", 0], remove: true }));
    expect(statements(emptied)).toBe("    trace_statements: [] # flow");
    // Ruling 85: an emptied list's first item comes back in block style, its comment on the key's line.
    expect(write(items, transform, [...emptied, { path: ["trace_statements", 0], value: "x" }]).text).toContain(
      "    trace_statements: # flow\n      - x\n    conditions:",
    );

    const block = write(items, resource, [0, 1, 2].map(() => ({ path: ["attributes", 0], remove: true })));
    expect(block.text).toContain("  resource:\n    attributes: []\n  filter:\n");
  });

  it("sets a whole list through the list edit, keeping the items that stay", () => {
    const { text, diff } = write(items, attributes, [
      { path: ["actions"], value: [{ key: "environment", value: "production", action: "insert" }, { key: "z" }] },
    ]);
    expect(diff).toEqual({
      removed: [
        "      - key: mode",
        "        value: 0750 # octal to the collector",
        "        action: upsert",
        "      - key: c",
        "        value: \"x\"",
        "        action: insert",
        "      - only: one",
      ],
      added: ["      - key: z"],
    });
    expect(text).toContain("    actions:\n      # about the first\n      - key: environment # keep me\n");
  });

  it("keeps CRLF, four-space indentation and sequences at their key's column", () => {
    const crlf = corpusText("crlf.yaml");
    const { text, diff } = write(crlf, ["exporters", "otlp"], [
      { path: ["tls", "ca_file"], value: "/ca.pem" },
      { path: ["endpoint"], value: "b:4317" },
      { path: ["headers"], value: { a: "b" } },
      { path: ["tls", "insecure"], remove: true },
    ]);
    expect(diff).toEqual({
      removed: ["    endpoint: 'otelcol:4317'\r", "      insecure: true\r"],
      added: ["    endpoint: 'b:4317'\r", "      ca_file: /ca.pem\r", "    headers:\r", "      a: b\r"],
    });
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");

    const four = write(corpusText("indent-four.yaml"), ["receivers", "filelog"], [
      { path: ["include", 2], value: "/c.log" },
      { path: ["operators", 0, "type"], value: "json" },
      { path: ["include", 0], moveTo: 1 },
    ]);
    expect(four.text).toContain(
      "    filelog:\n        include:\n            - /var/log/sys/*.log\n            - /var/log/app/*.log\n            - /c.log\n        start_at: end\n        operators:\n            - type: json\nprocessors:\n",
    );

    const unindented = write(corpusText("sequences-unindented.yaml"), ["receivers", "filelog"], [
      { path: ["include", 2], value: "/c.log" },
      { path: ["include", 0], moveTo: 2 },
      { path: ["exclude", 0], value: "/x" },
      { path: ["operators", 0, "type"], value: "json" },
    ]);
    expect(unindented.text).toContain(
      "  filelog:\n    include:\n    - /var/log/b.log\n    - /c.log\n    - /var/log/a.log\n    exclude:\n    - /x\n    operators:\n    - type: json\nexporters:\n",
    );
  });

  it("keeps folded and literal blocks, a plain multi-line scalar, 0750, a 20-digit integer and 1e3", () => {
    const layout = corpusText("layout-preserved.yaml");
    const transformed = write(layout, ["processors", "transform"], [
      { path: ["trace_statements", 1], value: "set(x)" },
      { path: ["error_mode"], value: "propagate" },
    ]);
    expect(transformed.diff).toEqual({
      removed: ["    error_mode: ignore"],
      added: ["    error_mode: propagate", "      - set(x)"],
    });
    expect(transformed.text).toContain(
      '      - >-\n        set(attributes["folded"],\n        "one line")\n      - set(x)\n    note: |\n      literal line one\n      literal line two\n    plain_multi: this plain scalar\n      runs on\n',
    );
    const storage = write(layout, ["extensions", "file_storage"], [
      { path: ["directory"], value: "/var/lib/telflo" },
      { path: ["timeout"], value: "1s" },
    ]);
    expect(storage.text).toContain(
      '    directory: /var/lib/telflo\n    directory_permissions: "0750"\n    big: 12345678901234567890\n    exponent: 1e3\n    leading_zero: 0750\n    timeout: 1s\nservice:\n',
    );
  });
});

describe("moving list items by their own lines (Preflight ruling 2)", () => {
  const items = corpusText("item-lists.yaml");
  const blockItems = [
    "      # about the first\n      - key: environment # keep me\n        value: production\n        action: insert\n",
    "      - key: mode\n        value: 0750 # octal to the collector\n        action: upsert\n",
    "      - key: c\n        value: \"x\"\n        action: insert\n",
    "      - only: one\n",
  ];
  const indentlessItems = [
    "    # indentless, about the first\n    - key: service.name # the name\n      value: checkout\n      action: upsert\n",
    "    - key: mode\n      value: 0750 # octal\n      action: insert\n",
    "    - only: one\n",
  ];
  const cases = [
    { list: "a block", base: ["processors", "attributes"], key: "actions", texts: blockItems },
    { list: "an indentless", base: ["processors", "resource"], key: "attributes", texts: indentlessItems },
  ];

  it.each(cases)("moves $list list's item with its comments and 0750, byte for byte", ({ base, key, texts }) => {
    expect(items).toContain(texts.join(""));
    for (const [from, to] of [[1, texts.length - 1], [0, 2], [texts.length - 1, 0], [1, 0]] as const) {
      const moved = [...texts];
      moved.splice(to, 0, ...moved.splice(from, 1));
      expect(write(items, base, [{ path: [key, from], moveTo: to }]).text).toBe(items.replace(texts.join(""), moved.join("")));
    }
  });

  it("moves a flow list's item source, byte for byte", () => {
    const moved = write(items, ["processors", "transform"], [
      { path: ["trace_statements", 2], moveTo: 0 },
      { path: ["conditions", 0], moveTo: 1 },
    ]);
    expect(moved.diff).toEqual({
      removed: ["    trace_statements: [set(a), 'set(b)', 0750] # flow", "    conditions: [{key: a, value: 0750}, {key: b}]"],
      added: ["    trace_statements: [0750, set(a), 'set(b)'] # flow", "    conditions: [{key: b}, {key: a, value: 0750}]"],
    });
  });

  it("refuses a move that puts an alias above its anchor, and copies an alias before its anchor moves below it", () => {
    const text = "receivers:\n  otlp:\n    list:\n      - &first one\n      - *first\n";
    expect(() => writeValues(text, ["receivers", "otlp"], [{ path: ["list", 1], moveTo: 0 }])).toThrow(
      "An edit left an alias before its anchor.",
    );
    expect(writeValues(text, ["receivers", "otlp"], [{ path: ["list", 0], moveTo: 1 }]).text).toBe(
      "receivers:\n  otlp:\n    list:\n      - one\n      - &first one\n",
    );
  });

  it("leaves an alias its anchor's move keeps after it as it is, and copies only one the anchor moves past (ruling 32)", () => {
    const base = ["receivers", "otlp"];
    const anchored = "      - &x\n        k: 1\n";
    const same = `receivers:\n  otlp:\n    list:\n${anchored}      - other: 2\n      - alias: *x\n`;
    expect(write(same, base, [{ path: ["list", 0], moveTo: 1 }]).text).toBe(
      `receivers:\n  otlp:\n    list:\n      - other: 2\n${anchored}      - alias: *x\n`,
    );
    const outside = `receivers:\n  otlp:\n    list:\n${anchored}      - other: 2\n  otlp/2:\n    alias: *x\n`;
    expect(write(outside, base, [{ path: ["list", 0], moveTo: 1 }]).text).toBe(
      `receivers:\n  otlp:\n    list:\n      - other: 2\n${anchored}  otlp/2:\n    alias: *x\n`,
    );
    const later = "receivers:\n  otlp:\n    list:\n      - a\n      - &x {k: 1}\n    alias: *x\n";
    expect(write(later, base, [{ path: ["list", 1], moveTo: 0 }]).text).toBe(
      "receivers:\n  otlp:\n    list:\n      - &x {k: 1}\n      - a\n    alias: *x\n",
    );

    // Moved past one alias of it, not another: that one alone gets a copy.
    const passed = "receivers:\n  otlp:\n    list:\n      - &x one\n      - *x\n      - two\n      - tail: *x\n";
    expect(write(passed, base, [{ path: ["list", 0], moveTo: 2 }]).text).toBe(
      "receivers:\n  otlp:\n    list:\n      - one\n      - two\n      - &x one\n      - tail: *x\n",
    );

    // A flow list's item moves with its anchor and tag; a copy keeps the tag.
    const flow = "receivers:\n  otlp:\n    list: [&x !!str a, b, *x]\n";
    expect(write(flow, base, [{ path: ["list", 0], moveTo: 1 }]).text).toBe(
      "receivers:\n  otlp:\n    list: [b, &x !!str a, *x]\n",
    );
    expect(write(flow, base, [{ path: ["list", 0], moveTo: 2 }]).text).toBe(
      "receivers:\n  otlp:\n    list: [b, !!str a, &x !!str a]\n",
    );

    // The list's own anchor: its order changes, so its alias keeps the old order as a copy.
    const list = "receivers:\n  otlp:\n    list: &l\n      - a\n      - b\n    copy: *l\n";
    expect(write(list, base, [{ path: ["list", 0], moveTo: 1 }]).text).toBe(
      "receivers:\n  otlp:\n    list: &l\n      - b\n      - a\n    copy:\n      - a\n      - b\n",
    );
  });

  it("removes an anchored item with its anchor and tag, in block and flow lists, its aliases copied first (ruling 38)", () => {
    const base = ["receivers", "otlp"];
    const block = "receivers:\n  otlp:\n    list:\n      - &x !!str a\n      - b\n      - *x\n";
    expect(write(block, base, [{ path: ["list", 0], remove: true }]).text).toBe(
      "receivers:\n  otlp:\n    list:\n      - b\n      - !!str a\n",
    );

    const flow = "receivers:\n  otlp:\n    list: [&x a, b, *x]\n";
    expect(write(flow, base, [{ path: ["list", 0], remove: true }]).text).toBe("receivers:\n  otlp:\n    list: [b, a]\n");
    const tagged = "receivers:\n  otlp:\n    list: [&x !!str a, b, *x]\n";
    expect(write(tagged, base, [{ path: ["list", 0], remove: true }]).text).toBe(
      "receivers:\n  otlp:\n    list: [b, !!str a]\n",
    );
    // The item after it keeps its own anchor; the last and the only item go with theirs.
    const next = "receivers:\n  otlp:\n    list: [a, &y b, *y]\n";
    expect(write(next, base, [{ path: ["list", 0], remove: true }]).text).toBe("receivers:\n  otlp:\n    list: [&y b, *y]\n");
    const last = "receivers:\n  otlp:\n    list: [a, &y !!str b]\n";
    expect(write(last, base, [{ path: ["list", 1], remove: true }]).text).toBe("receivers:\n  otlp:\n    list: [a]\n");
    const only = "receivers:\n  otlp:\n    list: [&y !!str b]\n";
    expect(write(only, base, [{ path: ["list", 0], remove: true }]).text).toBe("receivers:\n  otlp:\n    list: []\n");
  });

  it("the line oracle excuses an alias whose anchor's value changes, not one a move keeps (ruling 32)", () => {
    const text = "receivers:\n  otlp:\n    list:\n      - &x\n        k: 1\n      - other: 2\n  otlp/2:\n    alias: *x\n";
    const before = read(text).model;
    const moved = write(text, ["receivers", "otlp"], [{ path: ["list", 0], moveTo: 1 }]);
    const touchable = touchableLines(text, before, moved.model, ["receivers.otlp"]);
    expect(untouchedLinesLost(text, moved.text, touchable)).toEqual([]);
    // What the move wrote before ruling 32: the alias expanded, which the oracle doesn't excuse.
    const expanded = moved.text.replace("    alias: *x\n", "    alias:\n      k: 1\n");
    expect(untouchedLinesLost(text, expanded, touchable)).toEqual(["8:     alias: *x"]);

    const changed = write(text, ["receivers", "otlp"], [{ path: ["list", 0, "k"], value: 2 }]);
    expect(changed.text).toContain("  otlp/2:\n    alias:\n      k: 1\n");
    expect(untouchedLinesLost(text, changed.text, touchableLines(text, before, changed.model, ["receivers.otlp"]))).toEqual([]);
  });
});

describe("renaming a key in place (Preflight ruling 13)", () => {
  const headers = [
    "exporters:",
    "  otlphttp:",
    "    headers:",
    "      # the tenant",
    "      X-Tenant: acme # who",
    '      "x-quoted": 1',
    "      Authorization: Bearer x",
    "",
  ].join("\n");

  it("keeps the key's place, its comments, its quoting and its value", () => {
    const { diff } = write(headers, ["exporters", "otlphttp"], [
      { path: ["headers", "X-Tenant"], renameTo: "X-Org" },
      { path: ["headers", "x-quoted"], renameTo: "x-other" },
    ]);
    expect(diff).toEqual({
      removed: ["      X-Tenant: acme # who", '      "x-quoted": 1'],
      added: ["      X-Org: acme # who", '      "x-other": 1'],
    });
    expect(write(corpusText("item-lists.yaml"), ["processors", "attributes"], [{ path: ["actions", 0, "key"], renameTo: "name" }]).diff).toEqual({
      removed: ["      - key: environment # keep me"],
      added: ["      - name: environment # keep me"],
    });
    expect(write(corpusText("flow-style.yaml"), ["processors", "batch"], [{ path: ["timeout"], renameTo: "true" }]).diff).toEqual({
      removed: ["  batch: {timeout: 5s, send_batch_size: 100}"],
      added: ['  batch: {"true": 5s, send_batch_size: 100}'],
    });
  });

  it("renames a key the mapping gets from a merge by copying it first, the anchor left alone", () => {
    const anchors = corpusText("anchors-merges.yaml");
    const { text, model } = write(anchors, ["exporters", "otlp_grpc/primary"], [{ path: ["compression"], renameTo: "algorithm" }]);
    expect(text).toContain("  otlp_grpc/primary:\n    timeout: 5s\n    endpoint: primary:4317\n    tls: *tls\n    algorithm: gzip\n");
    expect(text).toContain("x-defaults: &defaults\n  timeout: 5s\n  compression: gzip\n");
    expect(value(model, "exporters.otlp_grpc/primary")).toEqual({
      timeout: "5s",
      endpoint: "primary:4317",
      tls: { insecure: true },
      algorithm: "gzip",
    });
  });

  it("refuses a name the mapping already has, its own or merged, and a key that isn't there", () => {
    expect(() => writeValues(headers, ["exporters", "otlphttp"], [{ path: ["headers", "X-Tenant"], renameTo: "Authorization" }])).toThrow(
      "A key with that name is already there.",
    );
    const anchors = corpusText("anchors-merges.yaml");
    expect(() => writeValues(anchors, ["exporters", "otlp_grpc/primary"], [{ path: ["endpoint"], renameTo: "timeout" }])).toThrow(
      TextEditError,
    );
    expect(() => writeValues(headers, ["exporters", "otlphttp"], [{ path: ["headers", "Missing"], renameTo: "Other" }])).toThrow(
      TextEditError,
    );
  });
});

describe("numbers written as typed (Preflight ruling 14)", () => {
  it("writes { plain: '1e3' } as typed: in place, as a new key, and in a flow mapping", () => {
    const flow = corpusText("flow-style.yaml");
    expect(
      write(flow, ["processors", "batch"], [
        { path: ["send_batch_size"], plain: "1e3" },
        { path: ["y"], plain: "0x1F" },
      ]).diff,
    ).toEqual({
      removed: ["  batch: {timeout: 5s, send_batch_size: 100}"],
      added: ["  batch: {timeout: 5s, send_batch_size: 1e3, y: 0x1F}"],
    });
    const { diff, model } = write(corpusText("layout-preserved.yaml"), ["extensions", "file_storage"], [
      { path: ["leading_zero"], plain: "0700" },
      { path: ["exponent"], plain: "2e3" },
      { path: ["fsync_after"], plain: "1e2" },
    ]);
    expect(diff).toEqual({
      removed: ["    exponent: 1e3", "    leading_zero: 0750"],
      added: ["    exponent: 2e3", "    leading_zero: 0700", "    fsync_after: 1e2"],
    });
    expect(value(model, "extensions.file_storage")).toMatchObject({ leading_zero: 700, exponent: 2000, fsync_after: 100 });
  });

  it("refuses { plain: 'abc' }, and characters that aren't one number, boolean or one-line flow collection", () => {
    for (const plain of ["abc", "1 # c", "${env:X}", "", " 1", "1\n2", "[1] # c", "[1\n]", "null", "'1'"]) {
      expect(() => writeValues(starter, ["processors", "batch"], [{ path: ["send_batch_size"], plain }])).toThrow(
        "A value written as typed doesn't read as a number, a boolean or a flow collection.",
      );
    }
  });

  it("writes a mapping { plain: '5' } set as a value as a mapping, not as the number 5 (ruling 26)", () => {
    const { diff, model } = write(starter, ["processors", "batch"], [{ path: ["labels"], value: { plain: "5" } }]);
    expect(diff).toEqual({ removed: [], added: ["    labels:", '      plain: "5"'] });
    expect(value(model, "processors.batch")).toMatchObject({ labels: { plain: "5" } });
  });
});

describe("a missing key added under the deepest key that exists (Preflight ruling 3)", () => {
  const level: ValueChange[] = [{ path: ["metrics", "level"], value: "detailed" }];
  const telemetry = ["service", "telemetry"];
  const added = "  telemetry:\n    metrics:\n      level: detailed\n";

  it("under `otlp:` and `service:` with no value, with no `service`, with pipelines, and in an empty text", () => {
    expect(write("receivers:\n  otlp:\nservice:\n", telemetry, level).text).toBe(`receivers:\n  otlp:\nservice:\n${added}`);
    expect(write("receivers:\n  otlp:\n", telemetry, level).text).toBe(`receivers:\n  otlp:\nservice:\n${added}`);
    expect(write("", telemetry, level).text).toBe(`service:\n${added}`);
    expect(write(starter, telemetry, level).text).toBe(`${starter}${added}`);
    const nulls = corpusText("null-values.yaml");
    expect(write(nulls, ["processors", "batch"], [{ path: ["timeout"], value: "5s" }]).diff).toEqual({
      removed: ["  batch: ~"],
      added: ["  batch:", "    timeout: 5s"],
    });
  });

  it("makes lists where the path has numbers, and refuses an item past the end", () => {
    const readers: ValueChange[] = [{ path: ["metrics", "readers", 0, "pull", "exporter"], value: { prometheus: { host: "localhost" } } }];
    expect(write("", telemetry, readers).text).toBe(
      "service:\n  telemetry:\n    metrics:\n      readers:\n        - pull:\n            exporter:\n              prometheus:\n                host: localhost\n",
    );
    expect(write("service:\n  telemetry:\n    metrics:\n      readers:\n", telemetry, [{ path: ["metrics", "readers", 0], value: "a" }]).text).toBe(
      "service:\n  telemetry:\n    metrics:\n      readers:\n        - a\n",
    );
    expect(() => writeValues("", telemetry, [{ path: ["metrics", "readers", 1], value: "a" }])).toThrow(TextEditError);
    const items = corpusText("item-lists.yaml");
    expect(() => writeValues(items, ["processors", "attributes"], [{ path: ["actions", 5], value: "a" }])).toThrow(
      "This edit can't be written as a splice: an item past the end of a list.",
    );
  });

  it("leaves `service: {}` when the telemetry it removes was the service's only key", () => {
    const text = "receivers:\n  otlp:\nservice:\n  telemetry:\n    logs:\n      level: info\n";
    expect(write(text, ["service"], [{ path: ["telemetry"], remove: true }]).text).toBe("receivers:\n  otlp:\nservice: {}\n");
  });
});

describe("aliases and merge keys under a form (D9a Preflight ruling 8)", () => {
  const owned = corpusText("anchors-owned.yaml");
  const anchors = corpusText("anchors-merges.yaml");

  it("copies an alias item before a change inside it, and a merge inside an item before a key it gives changes", () => {
    const aliased = write(owned, ["exporters", "otlp/echo"], [{ path: ["items", 0, "x-team"], value: "core" }]);
    expect(aliased.diff).toEqual({ removed: ["      - *shared-headers"], added: ["      - x-team: core"] });
    expect(value(aliased.model, "exporters.otlp/alpha").headers).toEqual({ "x-team": "platform" });

    const merged = [
      "x-defaults: &d",
      "  timeout: 5s",
      "  compression: gzip",
      "exporters:",
      "  otlp:",
      "    list:",
      "      - <<: *d",
      "        name: a # the name",
      "      - name: b",
      "",
    ].join("\n");
    expect(write(merged, ["exporters", "otlp"], [{ path: ["list", 0, "timeout"], value: "1s" }]).text).toBe(
      merged.replace("        name: a # the name\n", "        name: a # the name\n        timeout: 1s\n"),
    );
    expect(write(merged, ["exporters", "otlp"], [{ path: ["list", 0, "compression"], remove: true }]).text).toBe(
      merged.replace("      - <<: *d\n", "      - timeout: 5s\n"),
    );
    expect(write(merged, ["exporters", "otlp"], [{ path: ["list", 1, "name"], remove: true }]).text).toBe(
      merged.replace("      - name: b\n", "      - {}\n"),
    );
  });

  it("copies before a change under an alias or a merge key; the anchor's other users keep their values", () => {
    expect(write(anchors, ["receivers", "otlp/second"], [{ path: ["protocols", "grpc", "endpoint"], value: "0.0.0.0:5317" }]).diff).toEqual({
      removed: ["  otlp/second: *otlp-receiver"],
      added: ["  otlp/second:", "    protocols:", "      grpc:", "        endpoint: 0.0.0.0:5317"],
    });
    expect(write(anchors, ["exporters", "otlp_grpc/primary"], [{ path: ["compression"], value: "zstd" }]).text).toContain(
      "    <<: *defaults\n    endpoint: primary:4317\n    tls: *tls\n    compression: zstd\n",
    );
    expect(write(anchors, ["exporters", "otlp_grpc/primary"], [{ path: ["tls", "insecure"], value: false }]).diff).toEqual({
      removed: ["    tls: *tls"],
      added: ["    tls:", "      insecure: false"],
    });
    const { text, model } = write(owned, ["exporters", "otlp/alpha"], [{ path: ["headers", "x-team"], value: "core" }]);
    expect(value(model, "exporters.otlp/beta").headers).toEqual({ "x-team": "platform" });
    expect(value(model, "exporters.otlp/echo").items).toEqual([{ "x-team": "platform" }, "plain"]);
    expect(text).toContain("    headers: &shared-headers\n      x-team: core\n");
  });
});

describe("what a write by key path refuses", () => {
  it("a change outside base can't happen: a path escaping base is refused", () => {
    const refused: ValueChange[] = [
      { path: [], remove: true },
      { path: [], renameTo: "otlp/2" },
      { path: [], moveTo: 0 },
      { path: ["protocols"], moveTo: 0 },
      { path: [-1], value: 1 },
      { path: [0.5], value: 1 },
      { path: [Number.NaN], value: 1 },
      { path: ["protocols", 0], renameTo: "x" },
      { path: ["protocols"] } as unknown as ValueChange,
    ];
    for (const change of refused) {
      expect(() => writeValues(starter, ["receivers", "otlp"], [change])).toThrow("A change's path leaves the value it edits.");
    }
    expect(() => writeValues(starter, [], [{ path: ["receivers"], value: null }])).toThrow(TextEditError);

    // A key anchored inside the component and named outside it: renaming it would change the outside.
    const anchoredKey = "receivers:\n  otlp:\n    &name endpoint: a\nx-key: *name\n";
    expect(() => writeValues(anchoredKey, ["receivers", "otlp"], [{ path: ["endpoint"], renameTo: "url" }])).toThrow(
      "A change reached a value outside the one it edits.",
    );
  });

  it("a value set on base itself is refused, never written by reprinting the whole value (ruling 30)", () => {
    const text = "receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317 # keep me\n    mode: 0750\n";
    const whole = { protocols: { grpc: { endpoint: "0.0.0.0:4317" } }, mode: 750 };
    const refused: Array<[string, ValueChange]> = [
      [text, { path: [], value: whole }],
      [text, { path: [], plain: "0750" }],
      ["receivers:\n  otlp: old\n", { path: [], value: "new" }],
      ["receivers:\n  otlp: old\n", { path: [], plain: "1e3" }],
      ["receivers:\n  otlp:\n", { path: [], value: { protocols: {} } }],
    ];
    for (const [before, change] of refused) {
      expect(() => writeValues(before, ["receivers", "otlp"], [change]), JSON.stringify(change)).toThrow(
        "A change's path leaves the value it edits.",
      );
      // Nor after a change that could be written: nothing of the list is.
      expect(() =>
        writeValues(before, ["receivers", "otlp"], [{ path: ["x"], remove: true }, change]),
      ).toThrow("A change's path leaves the value it edits.");
    }
  });

  it("a change that can't be spliced throws TextEditError, and neither the text nor its document changes", () => {
    const cases: Array<[string, ValuePath, ValueChange]> = [
      ["receivers:\n  otlp: 5\n", ["receivers", "otlp"], { path: ["protocols"], value: {} }],
      ["receivers:\n  otlp:\n    list: [a]\n", ["receivers", "otlp"], { path: ["list", "key"], value: 1 }],
      ["receivers:\n  otlp:\n    list:\n      key: a\n", ["receivers", "otlp"], { path: ["list", 0], value: 1 }],
      ["x: &b\n  k:\n    - 1\nreceivers:\n  otlp: {a: *b}\n", ["receivers", "otlp"], { path: ["a", "k", 0], value: 2 }],
      ["receivers:\n  otlp:\n    list:\n      - - a\n        - b\n", ["receivers", "otlp"], { path: ["list", 0, 0], remove: true }],
    ];
    for (const [text, base, change] of cases) {
      const document = parseDocument(text, PARSE_OPTIONS) as ParsedText;
      const before = document.toJS();
      expect(() => writeValues(text, base, [change], document), JSON.stringify(change)).toThrow(TextEditError);
      expect(document.toJS()).toEqual(before);
    }
  });
});

describe("edges of writes by key path", () => {
  const items = corpusText("item-lists.yaml");

  it("adds a row by setting its first field, fills an empty item, and sets a flow item to a mapping", () => {
    expect(write(items, ["processors", "attributes"], [{ path: ["actions", 4, "key"], value: "k" }]).text).toContain(
      "      - only: one\n      - key: k\n  resource:\n",
    );
    const empty = "receivers:\n  otlp:\n    list:\n      -\n      - b # kept\n";
    expect(write(empty, ["receivers", "otlp"], [{ path: ["list", 0], value: { a: 1, b: 2 } }]).text).toBe(
      "receivers:\n  otlp:\n    list:\n      - a: 1\n        b: 2\n      - b # kept\n",
    );
    expect(write(empty, ["receivers", "otlp"], [{ path: ["list", 0, "a"], value: 1 }]).text).toBe(
      "receivers:\n  otlp:\n    list:\n      - a: 1\n      - b # kept\n",
    );
    expect(write(items, ["processors", "transform"], [{ path: ["trace_statements", 1], value: { a: [1] } }]).diff.added).toEqual([
      "    trace_statements: [set(a), {a: [1]}, 0750] # flow",
    ]);
    expect(write(items, ["processors", "transform"], [{ path: ["conditions", 0], value: null }]).diff.added).toEqual([
      "    conditions: [null, {key: b}]",
    ]);
  });

  it("turns a value with nothing in it inside a flow mapping into a mapping", () => {
    const flow = "receivers: {otlp: ~}\nexporters: {debug: {}}\nservice: {pipelines: {traces: {receivers: [otlp], exporters: [debug]}}}\n";
    expect(write(flow, ["receivers", "otlp"], [{ path: ["protocols", "grpc"], value: {} }]).text).toBe(
      flow.replace("{otlp: ~}", "{otlp: {protocols: {grpc: {}}}}"),
    );
  });

  it("sets a key inside an empty flow mapping in block style, and in flow style inside a flow collection (Ruling 85)", () => {
    const base = ["receivers", "otlp"];
    expect(write("receivers:\n  otlp:\n    sub: {}\n    other: 1\n", base, [{ path: ["sub", "deep"], value: 1 }]).text).toBe(
      "receivers:\n  otlp:\n    sub:\n      deep: 1\n    other: 1\n",
    );
    expect(write("receivers:\n  otlp: {sub: {}, other: 1}\n", base, [{ path: ["sub", "deep"], value: 1 }]).text).toBe(
      "receivers:\n  otlp: {sub: {deep: 1}, other: 1}\n",
    );
    expect(write("receivers:\n  otlp: {} # kept\n", base, [{ path: ["sub"], value: 1 }]).text).toBe(
      "receivers:\n  otlp: # kept\n    sub: 1\n",
    );
    expect(write("receivers:\n  otlp: {}\n", base, [{ path: ["sub", "a", "b"], value: 1 }]).text).toBe(
      "receivers:\n  otlp:\n    sub:\n      a:\n        b: 1\n",
    );

    // A value with nothing in it still becomes a mapping in its parent's style.
    expect(write("receivers:\n  otlp:\n", base, [{ path: ["sub"], value: 1 }]).text).toBe("receivers:\n  otlp:\n    sub: 1\n");
    expect(write("receivers:\n  otlp:\n    sub:\n    other: 1\n", base, [{ path: ["sub", "deep"], value: 1 }]).text).toBe(
      "receivers:\n  otlp:\n    sub:\n      deep: 1\n    other: 1\n",
    );
  });

  it("gives an emptied list or map its first entry in block style, keeping its comment (Ruling 85)", () => {
    // The owner's reproducer: the only attribute removed, then Add Attribute.
    const resource = ["processors", "resource"];
    const one = "processors:\n  resource:\n    attributes:\n      - key: environment\n        value: production\n        action: insert\n";
    const emptied = write(one, resource, [{ path: ["attributes", 0], remove: true }]).text;
    expect(emptied).toBe("processors:\n  resource:\n    attributes: []\n");
    const added = write(emptied, resource, [{ path: ["attributes", 0], value: { key: "test_key_1", value: "test_1", action: "insert" } }]);
    expect(added.text).toBe(
      "processors:\n  resource:\n    attributes:\n      - key: test_key_1\n        value: test_1\n        action: insert\n",
    );

    const otlp = ["exporters", "otlp"];
    expect(write("exporters:\n  otlp:\n    endpoint: e:4317\n    headers: {}\n", otlp, [{ path: ["headers", "x-key"], value: "k" }]).text).toBe(
      "exporters:\n  otlp:\n    endpoint: e:4317\n    headers:\n      x-key: k\n",
    );
    expect(write("exporters:\n  otlp: {}\n", otlp, [{ path: ["endpoint"], value: "e:4317" }]).text).toBe(
      "exporters:\n  otlp:\n    endpoint: e:4317\n",
    );
    expect(write("processors:\n  resource:\n    attributes: [] # note\n", resource, [{ path: ["attributes", 0], value: { key: "k" } }]).text).toBe(
      "processors:\n  resource:\n    attributes: # note\n      - key: k\n",
    );
    // A whole list set on an empty one (the canvas's and a form's list edit) is block too.
    expect(write("processors:\n  resource:\n    attributes: []\n", resource, [{ path: ["attributes"], value: ["a", "b"] }]).text).toBe(
      "processors:\n  resource:\n    attributes:\n      - a\n      - b\n",
    );
    // The canvas's edits too; a pipeline's list stays flow, as the text writes them.
    const canvas = "receivers:\n  otlp: {}\nprocessors:\n  batch: {}\nexporters:\n  debug:\n    list: []\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: []\n      exporters: [debug]\n";
    expect(edit(canvas, (m) => {
      value(m, "receivers.otlp").endpoint = "e";
      value(m, "exporters.debug").list = ["a"];
      lists(m, "traces").processors = ["batch"];
    }).diff).toEqual({
      removed: ["  otlp: {}", "    list: []", "      processors: []"],
      added: ["  otlp:", "    endpoint: e", "    list:", "      - a", "      processors: [batch]"],
    });
    // An empty list or map that is a list item.
    expect(write("receivers:\n  otlp:\n    list:\n      - []\n      - {}\n", ["receivers", "otlp"], [
      { path: ["list", 0, 0], value: "a" },
      { path: ["list", 1, "k"], value: 1 },
    ]).text).toBe("receivers:\n  otlp:\n    list:\n      - - a\n      - k: 1\n");

    // CRLF, four-space and indentless texts: the text's own line ending and layout.
    const crlf = "receivers:\r\n  otlp:\r\n    headers: {}\r\n    list: [] # c\r\n";
    expect(write(crlf, ["receivers", "otlp"], [
      { path: ["headers", "a"], value: 1 },
      { path: ["list", 0], value: "x" },
    ]).text).toBe("receivers:\r\n  otlp:\r\n    headers:\r\n      a: 1\r\n    list: # c\r\n      - x\r\n");
    const four = "receivers:\n    otlp:\n        protocols: {}\n        include: []\n";
    expect(write(four, ["receivers", "otlp"], [
      { path: ["protocols", "grpc", "endpoint"], value: "x" },
      { path: ["include", 0], value: "a" },
    ]).text).toBe("receivers:\n    otlp:\n        protocols:\n            grpc:\n                endpoint: x\n        include:\n            - a\n");
    const unindented = corpusText("sequences-unindented.yaml");
    expect(write(unindented, ["receivers", "filelog"], [{ path: ["exclude", 0], value: "/tmp/x.log" }]).diff).toEqual({
      removed: ["    exclude: []"],
      added: ["    exclude:", "    - /tmp/x.log"],
    });
    expect(write(unindented, ["exporters", "debug"], [{ path: ["verbosity"], value: "basic" }]).diff).toEqual({
      removed: ["  debug: {}"],
      added: ["  debug:", "    verbosity: basic"],
    });
  });

  it("keeps flow style for an empty list or map inside a flow collection, and for one with items (Ruling 85)", () => {
    const base = ["receivers", "otlp"];
    expect(write("receivers:\n  otlp: {list: [], other: 1}\n", base, [{ path: ["list", 0], value: "a" }]).text).toBe(
      "receivers:\n  otlp: {list: [a], other: 1}\n",
    );
    expect(write("receivers:\n  otlp:\n    list: [[], {}]\n", base, [
      { path: ["list", 0, 0], value: "a" },
      { path: ["list", 1, "k"], value: 1 },
    ]).text).toBe("receivers:\n  otlp:\n    list: [[a], {k: 1}]\n");
    expect(write("receivers:\n  otlp:\n    list: [a] # c\n    map: {a: 1} # d\n", base, [
      { path: ["list", 1], value: "b" },
      { path: ["map", "b"], value: 2 },
    ]).text).toBe("receivers:\n  otlp:\n    list: [a, b] # c\n    map: {a: 1, b: 2} # d\n");
  });

  it("copies an anchored component's users before an item in it changes", () => {
    const text = "receivers:\n  otlp: &r\n    list:\n      - a\n  otlp/2: *r\n";
    expect(writeValues(text, ["receivers", "otlp"], [{ path: ["list", 0], value: "b" }]).text).toBe(
      "receivers:\n  otlp: &r\n    list:\n      - b\n  otlp/2:\n    list:\n      - a\n",
    );
  });

  it("does nothing for a rename to the same name or a removal under a path that isn't there", () => {
    expect(write(items, ["processors", "attributes"], [{ path: ["actions", 0, "key"], renameTo: "key" }]).text).toBe(items);
    expect(write(items, ["processors", "attributes"], [{ path: ["nothing", "deeper"], remove: true }]).text).toBe(items);
    expect(write(items, ["processors", "attributes"], [{ path: ["actions", 0, "nothing", "deeper"], remove: true }]).text).toBe(items);
  });

  it("refuses a move past the end of a list, or of something that isn't a list", () => {
    for (const change of [
      { path: ["actions", 1], moveTo: 4 },
      { path: ["actions", 4], moveTo: 0 },
      { path: ["actions", 0, "key", 0], moveTo: 0 },
      { path: ["actions", 0], moveTo: -1 },
    ]) {
      expect(() => writeValues(items, ["processors", "attributes"], [change])).toThrow("A change's path leaves the value it edits.");
    }
    expect(write(items, ["processors", "attributes"], [{ path: ["actions", 2], moveTo: 2 }]).text).toBe(items);
  });
});

describe("a write by key path on a large text (Preflight ruling 11)", () => {
  it("writes ten changes to one of 6,000 components in a few parses at most, the scalars in one parse", () => {
    const keys = ["endpoint", "a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const component = (i: number, values: string[]) => [
      `  otlp/r${i}:`,
      "    protocols:",
      "      grpc:",
      ...values.map((value, index) => `        ${keys[index]!}: ${value} # ${keys[index]!}`),
    ];
    // The preflight's shape (about 600k characters); only the last component has ten keys.
    const lines = ["receivers:"];
    for (let i = 0; i < 5999; i++) lines.push(...component(i, ["0.0.0.0:4317", "0750"]));
    const tail = ["service:", "  pipelines:", "    traces:", "      receivers: [otlp/r0]", ""];
    const text = [...lines, ...component(5999, keys.map(() => "0750")), ...tail].join("\n");
    const { document } = read(text);
    const changes: ValueChange[] = keys.map((key, index) => ({ path: ["protocols", "grpc", key], value: `v${index}` }));
    // The bound is in parses of this text on this machine, not in milliseconds: CI's runner
    // is slower than a laptop (PR #13's first run took 1.25 s where a laptop took 0.3 s).
    // The editor's re-parse is this call (`reparse`); the first is a warm-up.
    const parse = () => parseDocument(text, { ...PARSE_OPTIONS, uniqueKeys: false });
    parse();
    let parseTime = Infinity;
    for (let i = 0; i < 2; i++) {
      const at = performance.now();
      parse();
      parseTime = Math.min(parseTime, performance.now() - at);
    }
    const started = performance.now();
    const result = writeValues(text, ["receivers", "otlp/r5999"], changes, document);
    const elapsed = performance.now() - started;
    expect(result.text).toBe([...lines, ...component(5999, keys.map((_key, index) => `v${index}`)), ...tail].join("\n"));
    // One parse and the checks cost about one to two parses; a parse per change costs ten.
    expect(elapsed).toBeLessThan(parseTime * 4);
  });
});

/*
 * D9c Task 1: strings with line breaks (D9c Preflight ruling 1) and values
 * written as typed (ruling 2). A string a literal block can't carry cleanly
 * is written double-quoted, set in place, added, or inside a new item, in
 * block and flow, before a blank line or a comment, on CRLF text; a `plain`
 * change writes a number, a boolean or a one-line flow collection as typed,
 * and `readValue` shows a one-line flow collection as written.
 */
describe("strings with line breaks, written double-quoted where a block can't carry them (D9c Preflight ruling 1)", () => {
  const RECOMBINE = [
    "receivers:",
    "  filelog:",
    "    include: [/var/log/*.log]",
    "    operators:",
    "      - type: recombine # joins lines",
    "        combine_with: ' ' # joiner",
    "",
    "      # the next operator",
    "      - type: noop",
    "",
    "    # after the operators",
    "    start_at: end",
    "  filelog/flow:",
    "    operators: [{type: recombine, combine_with: ' '}] # flow",
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [filelog, filelog/flow]",
    "      exporters: [debug]",
    "",
  ].join("\n");
  const block = ["receivers", "filelog"];
  const flow = ["receivers", "filelog/flow"];
  const operators = (model: Model, key: string) => value(model, key).operators as Value[];

  it.each(["\n", "\n\n", " \n", "\t"])("%j: set in place before a blank line, keeping its comment", (typed) => {
    const { diff, model } = write(RECOMBINE, block, [{ path: ["operators", 0, "combine_with"], value: typed }]);
    expect(diff).toEqual({
      removed: ["        combine_with: ' ' # joiner"],
      added: [`        combine_with: ${JSON.stringify(typed)} # joiner`],
    });
    expect(operators(model, "receivers.filelog")[0]!.combine_with).toBe(typed);
  });

  it.each(["\n", "\n\n", " \n", "\t"])("%j: added to an item before a blank line and a comment", (typed) => {
    const { text, diff, model } = write(RECOMBINE, block, [{ path: ["operators", 1, "combine_with"], value: typed }]);
    expect(diff).toEqual({ removed: [], added: [`        combine_with: ${JSON.stringify(typed)}`] });
    expect(text).toContain(`      - type: noop\n        combine_with: ${JSON.stringify(typed)}\n\n    # after the operators\n`);
    expect(operators(model, "receivers.filelog")[1]!.combine_with).toBe(typed);
  });

  it.each(["\n", "\n\n", " \n", "\t"])("%j: appended inside a new item", (typed) => {
    const seed = { type: "recombine", combine_field: "body", combine_with: typed };
    const { text, model } = write(RECOMBINE, block, [{ path: ["operators", 2], value: seed }]);
    expect(text).toContain(
      `      - type: noop\n      - type: recombine\n        combine_field: body\n        combine_with: ${JSON.stringify(typed)}\n\n    # after`,
    );
    expect(operators(model, "receivers.filelog")[2]).toEqual(seed);
  });

  it.each(["\n", "\n\n", " \n", "\t"])("%j: set in place and added in a flow item", (typed) => {
    const quoted = JSON.stringify(typed);
    const { diff, model } = write(RECOMBINE, flow, [
      { path: ["operators", 0, "combine_with"], value: typed },
      { path: ["operators", 0, "separator"], value: typed },
    ]);
    expect(diff).toEqual({
      removed: ["    operators: [{type: recombine, combine_with: ' '}] # flow"],
      added: [`    operators: [{type: recombine, combine_with: ${quoted}, separator: ${quoted}}] # flow`],
    });
    expect(operators(model, "receivers.filelog/flow")[0]).toEqual({ type: "recombine", combine_with: typed, separator: typed });
  });

  it("keeps CRLF: set in place, added, and inside a new item", () => {
    const crlf = RECOMBINE.replace(/\n/g, "\r\n");
    const { text, model } = write(crlf, block, [
      { path: ["operators", 0, "combine_with"], value: "\n" },
      { path: ["operators", 1, "combine_with"], value: "\n\n" },
      { path: ["operators", 2], value: { type: "recombine", combine_with: " \n" } },
    ]);
    expect(text).toContain(
      '        combine_with: "\\n" # joiner\r\n\r\n      # the next operator\r\n      - type: noop\r\n        combine_with: "\\n\\n"\r\n      - type: recombine\r\n        combine_with: " \\n"\r\n\r\n',
    );
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(operators(model, "receivers.filelog").map((item) => item.combine_with)).toEqual(["\n", "\n\n", " \n"]);
  });

  it("still writes a literal block where it carries the string, and falls back to double quotes where its block wouldn't read back", () => {
    const lines = write(RECOMBINE, block, [{ path: ["operators", 0, "combine_with"], value: "one\ntwo\n" }]);
    expect(lines.diff).toEqual({
      removed: ["        combine_with: ' ' # joiner"],
      added: ["        combine_with: | # joiner", "          one", "          two"],
    });
    // A comment line indented deeper than the key would sit inside the block: written double-quoted instead.
    const deeper = RECOMBINE.replace("combine_with: ' ' # joiner\n", "combine_with: ' ' # joiner\n            # deeper\n");
    const quoted = write(deeper, block, [{ path: ["operators", 0, "combine_with"], value: "one\ntwo" }]);
    expect(quoted.diff).toEqual({
      removed: ["        combine_with: ' ' # joiner"],
      added: ['        combine_with: "one\\ntwo" # joiner'],
    });
    expect(operators(quoted.model, "receivers.filelog")[0]!.combine_with).toBe("one\ntwo");
    // A first line with leading spaces, or trailing spaces on a line, is double-quoted.
    expect(write(RECOMBINE, block, [{ path: ["operators", 0, "combine_with"], value: "  one\ntwo" }]).diff.added).toEqual([
      '        combine_with: "  one\\ntwo" # joiner',
    ]);
    expect(write(RECOMBINE, block, [{ path: ["operators", 0, "combine_with"], value: "one \ntwo" }]).diff.added).toEqual([
      '        combine_with: "one \\ntwo" # joiner',
    ]);
  });
});

describe("values written as typed: numbers, booleans and one-line flow collections (D9c Preflight ruling 2)", () => {
  const ADD = [
    "receivers:",
    "  filelog:",
    "    operators:",
    "      - type: add # the add",
    "        field: attributes.x",
    '        value: "" # typed',
    "",
    "      - type: noop",
    "  filelog/flow:",
    "    operators: [{type: add, field: body.y, value: ''}] # flow",
    "exporters:",
    "  debug:",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [filelog, filelog/flow]",
    "      exporters: [debug]",
    "",
  ].join("\n");
  const block = ["receivers", "filelog"];
  const flow = ["receivers", "filelog/flow"];
  const TYPED: ReadonlyArray<readonly [string, unknown]> = [
    ["1.0", 1],
    ["True", true],
    ['{"k":"v"}', { k: "v" }],
    ['[1, "a"]', [1, "a"]],
    ["0750", 750],
    ["FALSE", false],
    ["{}", {}],
  ];
  const shown = (text: string, base: string[], path: ValuePath) => {
    const view = readValue(read(text).document, base, path);
    return "source" in view ? view.source : view.value;
  };

  it.each(TYPED)("%s: written as typed in a block item, in place and as a new key, and shown as typed", (typed, expected) => {
    const { text, diff, model } = write(ADD, block, [
      { path: ["operators", 0, "value"], plain: typed },
      { path: ["operators", 1, "value"], plain: typed },
    ]);
    expect(diff).toEqual({
      removed: ['        value: "" # typed'],
      added: [`        value: ${typed} # typed`, `        value: ${typed}`],
    });
    const items = value(model, "receivers.filelog").operators as Value[];
    expect(items[0]!.value).toEqual(expected);
    expect(items[1]!.value).toEqual(expected);
    expect(shown(text, block, ["operators", 0, "value"])).toBe(typed);
    expect(plainValue(typed)).toEqual({ value: expected });
  });

  it.each(TYPED)("%s: written as typed in a flow item, and shown as typed", (typed, expected) => {
    const { text, diff, model } = write(ADD, flow, [
      { path: ["operators", 0, "value"], plain: typed },
      { path: ["operators", 0, "extra"], plain: typed },
    ]);
    expect(diff).toEqual({
      removed: ["    operators: [{type: add, field: body.y, value: ''}] # flow"],
      added: [`    operators: [{type: add, field: body.y, value: ${typed}, extra: ${typed}}] # flow`],
    });
    expect((value(model, "receivers.filelog/flow").operators as Value[])[0]).toEqual({
      type: "add",
      field: "body.y",
      value: expected,
      extra: expected,
    });
    expect(shown(text, flow, ["operators", 0, "value"])).toBe(typed);
  });

  it("EXPR(…), a quoted \"true\" and null aren't written as typed: they are strings, written and shown as strings", () => {
    for (const typed of ["EXPR(body.x)", '"true"', "null", "~", "abc", "{a: *x}", "&a [1]", "[!!str 1]", "{} # c", "{a: 1,\tb: 2}"]) {
      expect(plainValue(typed)).toBeUndefined();
    }
    const { text, model } = write(ADD, block, [
      { path: ["operators", 0, "value"], value: "EXPR(body.x)" },
      { path: ["operators", 1, "value"], value: "true" },
      { path: ["operators", 1, "other"], value: "null" },
    ]);
    expect(text).toContain('        value: "EXPR(body.x)" # typed\n');
    expect(text).toContain('      - type: noop\n        value: "true"\n        other: "null"\n');
    const items = value(model, "receivers.filelog").operators as Value[];
    expect([items[0]!.value, items[1]!.value, items[1]!.other]).toEqual(["EXPR(body.x)", "true", "null"]);
    expect(shown(text, block, ["operators", 1, "value"])).toBe("true");
  });

  it("a number field still asks for a number only: a boolean or a collection isn't one", () => {
    expect(plainNumber("1.0")).toBe(1);
    for (const typed of ["True", "true", '{"k":"v"}', "[1]"]) expect(plainNumber(typed)).toBeUndefined();
  });

  it("readValue gives a one-line flow collection's characters, and none for a block one or one with an anchor, an alias or a tag", () => {
    const text = [
      "x: &x 1",
      "receivers:",
      "  filelog:",
      "    flow_map: {a: 1, b: [x, y]} # comment after",
      "    flow_list: [1, 'a']",
      "    block_map:",
      "      a: 1",
      "    anchored: &a {a: 1}",
      "    aliased: [*x]",
      "    tagged: !!map {a: 1}",
      "    two_lines: {a: 1,",
      "      b: 2}",
      "",
    ].join("\n");
    const view = (key: string) => readValue(read(text).document, ["receivers", "filelog"], [key]);
    expect(view("flow_map")).toEqual({ kind: "map", value: { a: 1, b: ["x", "y"] }, source: "{a: 1, b: [x, y]}" });
    expect(view("flow_list")).toEqual({ kind: "list", value: [1, "a"], source: "[1, 'a']" });
    for (const key of ["block_map", "anchored", "aliased", "tagged", "two_lines"]) expect(view(key)).not.toHaveProperty("source");
  });
});

/*
 * D9c Task 1's review: a carriage return and the other control characters
 * are written escaped in double quotes, never raw (yaml.v3, the collector's
 * reader, refuses DEL and the C1 controls); a double-quoted string stays
 * double-quoted when set to one with a line break; and a flow mapping is
 * written as typed only when its keys are strings, each once.
 */
describe("the review's fixes to the text edits (D9c Task 1)", () => {
  const BASE = ["receivers", "r"];
  const text = (value: string) => `receivers:\n  r:\n    a: ${value}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [r]\n      exporters: [debug]\n`;

  it("a carriage return is escaped in double quotes, not a block that loses it", () => {
    const { diff, model } = write(text("x # c"), BASE, [{ path: ["a"], value: "\r\nx" }]);
    expect(diff).toEqual({ removed: ["    a: x # c"], added: ['    a: "\\r\\nx" # c'] });
    expect(value(model, "receivers.r").a).toBe("\r\nx");
  });

  it("DEL and the C1 controls are escaped wherever a string is double-quoted: in place, new, in flow, as a key", () => {
    for (const before of ["'x'", '"x"', "x"]) {
      const { diff, model } = write(text(before), BASE, [{ path: ["a"], value: "a\u007fb\u0085c\u009f" }]);
      expect(diff.added).toEqual(['    a: "a\\x7fb\\x85c\\x9f"']);
      expect(value(model, "receivers.r").a).toBe("a\u007fb\u0085c\u009f");
    }
    const added = write(text("x"), BASE, [
      { path: ["n"], value: "\u0080" },
      { path: ["k\u007f"], value: "v" },
      { path: ["f"], value: { g: "\u0090" } },
    ]);
    expect(added.diff.added).toEqual(['    n: "\\x80"', '    "k\\x7f": v', "    f:", '      g: "\\x90"']);
    const flow = write("receivers:\n  r: {a: x}\n", BASE, [{ path: ["a"], value: "\u007f" }, { path: ["b"], value: "\u0099" }]);
    expect(flow.text).toBe('receivers:\n  r: {a: "\\x7f", b: "\\x99"}\n');
    for (const result of [added.text, flow.text]) expect(result).not.toMatch(/[\u007f-\u009f]/);
  });

  it("a double-quoted string set to one with a line break stays double-quoted, keeping its comment", () => {
    const { diff, model } = write(text('"x" # c'), BASE, [{ path: ["a"], value: "x\ny" }]);
    expect(diff).toEqual({ removed: ['    a: "x" # c'], added: ['    a: "x\\ny" # c'] });
    expect(value(model, "receivers.r").a).toBe("x\ny");
    // A plain one still takes the block that carries it.
    expect(write(text("x # c"), BASE, [{ path: ["a"], value: "x\ny" }]).diff.added).toEqual(["    a: |- # c", "      x", "      y"]);
  });

  it("a flow mapping whose keys aren't strings, or collapse into one, isn't written as typed, nor shown as typed", () => {
    for (const typed of ['{1: a, "1": b}', '{true: 1, "true": 2}', "{[1]: 2}", "[?]", "{~: 1}", "{<<: {a: 1}}", "{a: {1: b}}", "[{2: x}]"]) {
      expect(plainValue(typed), typed).toBeUndefined();
      const shown = readValue(read(text(typed)).document, BASE, ["a"]);
      expect(shown, typed).not.toHaveProperty("source");
    }
    for (const typed of ["[a: 1]", "{a}", "{? a : 1}", '{"k": "v", k2: [1]}']) expect(plainValue(typed), typed).toBeDefined();
  });
});

/*
 * D9c Ruling 56: a comment at a block list's dash column after its last
 * item (a commented-out item) is kept by the parser as an item of its own,
 * with no dash and no value; list changes read it as none of the list's
 * items. Its lines stay where they are when an item is removed or moved,
 * and an item appended goes before them (Ruling 64, replacing Ruling 56's
 * "after"), as a mapping's appended key does.
 */
describe("a list's trailing comment lines (D9c Ruling 56)", () => {
  const BASE_PATH: ValuePath = ["receivers", "filelog"];
  const around = (ops: string) => `receivers:\n  filelog:\n${ops}    start_at: end\nexporters:\n  debug: {}\n`;
  const lists = [
    { list: "a block", dash: "      ", key: "    " },
    { list: "an indentless", dash: "    ", key: "    " },
  ];
  const shapes = lists.flatMap((l) => [
    { ...l, ending: "LF", crlf: false },
    { ...l, ending: "CRLF", crlf: true },
  ]);
  const at = (d: string) => ({
    first: `${d}# about the first\n${d}- type: noop\n`,
    second: `${d}# between\n${d}- type: add # b\n${d}  field: body\n`,
    trailing: `${d}# - type: regex_parser\n${d}#   regex: x\n`,
  });

  it.each(shapes)("$list list, $ending: append, remove and move work, and the trailing comment lines stay", ({ dash, key, crlf }) => {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, "\r\n") : s);
    const { first, second, trailing } = at(dash);
    const text = eol(around(`${key}operators:\n${first}${second}${trailing}`));
    const expectOps = (ops: string) => eol(around(`${key}operators:\n${ops}`));

    expect(write(text, BASE_PATH, [{ path: ["operators", 2], value: { type: "noop" } }]).text).toBe(
      expectOps(`${first}${second}${dash}- type: noop\n${trailing}`),
    );
    // A removed item's own comment above it stays, as D9a removes an entry (Preflight ruling 24).
    expect(write(text, BASE_PATH, [{ path: ["operators", 1], remove: true }]).text).toBe(expectOps(`${first}${dash}# between\n${trailing}`));
    expect(write(text, BASE_PATH, [{ path: ["operators", 0], remove: true }]).text).toBe(
      expectOps(`${dash}# about the first\n${second}${trailing}`),
    );
    expect(write(text, BASE_PATH, [{ path: ["operators", 1], moveTo: 0 }]).text).toBe(expectOps(`${second}${first}${trailing}`));
    expect(write(text, BASE_PATH, [{ path: ["operators", 0], moveTo: 1 }]).text).toBe(expectOps(`${second}${first}${trailing}`));
  });

  it("a comment deeper than the dash is the last item's: it goes and moves with it, and an item is appended after it", () => {
    const deeper = "      - type: add\n        # later\n";
    const text = around(`    operators:\n      - type: noop\n${deeper}`);
    expect(write(text, BASE_PATH, [{ path: ["operators", 2], value: { type: "noop" } }]).text).toBe(
      around(`    operators:\n      - type: noop\n${deeper}      - type: noop\n`),
    );
    expect(write(text, BASE_PATH, [{ path: ["operators", 1], remove: true }]).text).toBe(around("    operators:\n      - type: noop\n"));
    expect(write(text, BASE_PATH, [{ path: ["operators", 1], moveTo: 0 }]).text).toBe(around(`    operators:\n${deeper}      - type: noop\n`));
  });

  it("a comment at the key's column after the list is the next key's", () => {
    const text = around("    operators:\n      - type: noop\n    # the start\n");
    expect(write(text, BASE_PATH, [{ path: ["operators", 1], value: { type: "add" } }]).text).toBe(
      around("    operators:\n      - type: noop\n      - type: add\n    # the start\n"),
    );
  });
});

/*
 * D9c Ruling 64: an item appended to a block list goes after the last
 * item's own lines and before the comment-only lines that follow it, as a
 * mapping's appended key does: those comments may introduce what comes
 * after the list (a banner, the next key's comment, an outer list's
 * comment). Each result reads back (`write`).
 */
describe("an appended item goes before the comment lines after a list (D9c Ruling 64)", () => {
  const BASE_PATH: ValuePath = ["receivers", "filelog"];
  const append = (text: string, path: (string | number)[] = ["operators", 1]) => write(text, BASE_PATH, [{ path, value: { type: "b" } }]).text;

  it("a mapping's appended key does so already", () => {
    expect(write("receivers:\n  filelog:\n    a: 1\n    # b: 2\nexporters: {}\n", BASE_PATH, [{ path: ["c"], value: 3 }]).text).toBe(
      "receivers:\n  filelog:\n    a: 1\n    c: 3\n    # b: 2\nexporters: {}\n",
    );
  });

  it.each([
    [
      "a commented-out item, a blank line, and the next key's comment",
      "receivers:\n  filelog:\n    operators:\n      - type: a\n      # - type: old\n\n    # where to start\n    start_at: end\n",
      "receivers:\n  filelog:\n    operators:\n      - type: a\n      - type: b\n      # - type: old\n\n    # where to start\n    start_at: end\n",
    ],
    [
      "a commented-out item, then a top-level banner",
      "receivers:\n  filelog:\n    operators:\n      - type: a\n      # - type: old\n# ---- exporters ----\nexporters: {}\n",
      "receivers:\n  filelog:\n    operators:\n      - type: a\n      - type: b\n      # - type: old\n# ---- exporters ----\nexporters: {}\n",
    ],
    [
      "an indentless list, the next key's comment at the dash's column",
      "receivers:\n  filelog:\n    operators:\n    - type: a\n    # where to start reading\n    start_at: end\n",
      "receivers:\n  filelog:\n    operators:\n    - type: a\n    - type: b\n    # where to start reading\n    start_at: end\n",
    ],
    [
      "a bare dash last, then a comment",
      "receivers:\n  filelog:\n    operators:\n      - type: a\n      -\n      # t\n    start_at: end\n",
      "receivers:\n  filelog:\n    operators:\n      - type: a\n      -\n      - type: b\n      # t\n    start_at: end\n",
    ],
    [
      "the last item's own deeper comment, then a commented-out item",
      "receivers:\n  filelog:\n    operators:\n      - type: a\n        # inner\n      # - type: old\n    start_at: end\n",
      "receivers:\n  filelog:\n    operators:\n      - type: a\n        # inner\n      - type: b\n      # - type: old\n    start_at: end\n",
    ],
  ])("%s", (_name, text, appended) => {
    const path = text.includes("      -\n") ? ["operators", 2] : ["operators", 1];
    expect(append(text, path)).toBe(appended);
    expect(append(text.replace(/\n/g, "\r\n"), path)).toBe(appended.replace(/\n/g, "\r\n"));
  });

  it("a nested list: the inner item goes before the inner comment, never past the outer list's", () => {
    const text = "receivers:\n  filelog:\n    operators:\n      - type: a\n        list:\n          - x\n          # inner t\n      # outer t\n    start_at: end\n";
    expect(write(text, BASE_PATH, [{ path: ["operators", 0, "list", 1], value: "y" }]).text).toBe(
      text.replace("          - x\n", "          - x\n          - y\n"),
    );
    expect(append(text)).toBe(text.replace("          # inner t\n", "          # inner t\n      - type: b\n"));
  });
});

/*
 * D9c Ruling 69: a string the collector's yaml.v3 (go.yaml.in/yaml/v3
 * v3.0.5, resolve.go) would read as another type is never written plain:
 * `1_000` and `0b101` are integers to it, `-0x1F` too, `2024-01-01` and
 * `2001-12-14t21:59:43.10-05:00` times. Set in place, added, appended as an
 * item and inside a new item, in block and flow, each is double-quoted and
 * reads back as the string; `plainValue` refuses them, alone or inside a
 * flow collection. A number typed as `0750` stays plain, octal to the
 * collector (D9b decision 3).
 */
describe("strings the collector would read as another type are quoted (Ruling 69)", () => {
  const BASE = ["receivers", "r"];
  const TEXT = [
    "receivers:",
    "  r:",
    "    a: x # c",
    "    list:",
    "      - x # item",
    "  r/flow: {a: x, list: [x]} # flow",
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [r, r/flow]",
    "      exporters: [debug]",
    "",
  ].join("\n");
  const OTHER = ["1_000", "0b101", "-0x1F", "0o17", "+1", "2024-01-01", "2001-12-14t21:59:43.10-05:00", "2001-12-14 21:59:43.10", ".5"];

  it.each(OTHER)("%s: set in place, added, as an item and inside a new item, in a block mapping", (typed) => {
    const quoted = JSON.stringify(typed);
    const { diff, model } = write(TEXT, BASE, [
      { path: ["a"], value: typed },
      { path: ["b"], value: typed },
      { path: ["list", 0], value: typed },
      { path: ["list", 1], value: typed },
      { path: ["list", 2], value: { k: typed } },
    ]);
    expect(diff).toEqual({
      removed: ["    a: x # c", "      - x # item"],
      added: [`    a: ${quoted} # c`, `      - ${quoted} # item`, `      - ${quoted}`, `      - k: ${quoted}`, `    b: ${quoted}`],
    });
    expect(value(model, "receivers.r")).toEqual({ a: typed, b: typed, list: [typed, typed, { k: typed }] });
  });

  it.each(OTHER)("%s: set in place, added and appended in a flow mapping", (typed) => {
    const quoted = JSON.stringify(typed);
    const { diff, model } = write(TEXT, ["receivers", "r/flow"], [
      { path: ["a"], value: typed },
      { path: ["b"], value: typed },
      { path: ["list", 1], value: typed },
    ]);
    expect(diff).toEqual({
      removed: ["  r/flow: {a: x, list: [x]} # flow"],
      added: [`  r/flow: {a: ${quoted}, list: [x, ${quoted}], b: ${quoted}} # flow`],
    });
    expect(value(model, "receivers.r/flow")).toEqual({ a: typed, list: ["x", typed], b: typed });
  });

  it("a key the collector would read as another type is quoted too; strings it reads as strings stay plain", () => {
    expect(write(TEXT, BASE, [{ path: ["2024-01-01"], value: "v" }]).diff.added).toEqual(['    "2024-01-01": v']);
    for (const plain of ["yes", "on", "12:30:00", "0.0.0.0:4317", "10s", "127.0.0.1", "EXPR(body.x)"]) {
      expect(write(TEXT, BASE, [{ path: ["a"], value: plain }]).diff.added).toEqual([`    a: ${plain} # c`]);
    }
  });

  it("plainValue refuses them alone, and quotes them inside a flow collection (Ruling 78); a number typed as 0750 stays plain", () => {
    for (const typed of ["1_000", "0b101", "-0x1F", "2024-01-01"]) expect(plainValue(typed), typed).toBeUndefined();
    expect(plainValue("{a: 2024-01-01}")).toEqual({ value: { a: "2024-01-01" }, source: '{a: "2024-01-01"}' });
    expect(plainValue("[1_000, x]")).toEqual({ value: ["1_000", "x"], source: '["1_000", x]' });
    expect(plainValue("{2024-01-01: [{a: 0b1}]}")).toEqual({
      value: { "2024-01-01": [{ a: "0b1" }] },
      source: '{"2024-01-01": [{a: "0b1"}]}',
    });
    expect(plainValue("[0750, 0o17, True]")).toEqual({ value: [750, 15, true] });
    expect(write(TEXT, BASE, [{ path: ["a"], plain: "0750" }]).diff.added).toEqual(["    a: 0750 # c"]);
    // Shown as typed only when it could be written back as typed.
    expect(readValue(read(TEXT.replace("{a: x, list: [x]}", "{a: 2024-01-01}")).document, ["receivers", "r/flow"], [])).not.toHaveProperty("source");
  });
});

/*
 * D9c Ruling 78: a flow collection typed as a value (add's Value) holding a
 * plain string the collector would read as another type is written as
 * typed with that string double-quoted, not as a whole string; readValue
 * then shows it as written, so the field stays editable.
 */
describe("a flow collection written as typed, its misread strings quoted (Ruling 78)", () => {
  const TEXT = [
    "receivers:",
    "  r:",
    '    value: "" # typed',
    "  r/flow: {value: x}",
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [r, r/flow]",
    "      exporters: [debug]",
    "",
  ].join("\n");

  it.each([
    ["[2024-01-01]", '["2024-01-01"]', ["2024-01-01"]],
    ["{a: 1_000}", '{a: "1_000"}', { a: "1_000" }],
    ["{2024-01-01: [0b1, 2]}", '{"2024-01-01": ["0b1", 2]}', { "2024-01-01": ["0b1", 2] }],
  ] as const)("%s is written %s, in a block and a flow mapping, and shown as written", (typed, written, read) => {
    const block = write(TEXT, ["receivers", "r"], [{ path: ["value"], plain: typed }]);
    expect(block.diff).toEqual({ removed: ['    value: "" # typed'], added: [`    value: ${written} # typed`] });
    expect(value(block.model, "receivers.r").value).toEqual(read);
    expect(readValue(read_(block.text), ["receivers", "r"], ["value"])).toMatchObject({ source: written });
    const flow = write(TEXT, ["receivers", "r/flow"], [{ path: ["value"], plain: typed }]);
    expect(flow.diff.added).toEqual([`  r/flow: {value: ${written}}`]);
  });
});

function read_(text: string) {
  return read(text).document;
}

/*
 * D9d Ruling 34: a flow sequence spread over lines is changed item by item,
 * not rebuilt on one line (which joined its lines and lost its comments):
 * an item appended goes `, x` after the last item's content, its comment
 * and the closing bracket's line staying; an item removed goes with its
 * separator; an item set is changed where it stands. A reorder can't be
 * written that way and is refused. One-line flow lists and block lists
 * are written as before.
 */
describe("a flow list spread over lines keeps its lines and comments (D9d Ruling 34)", () => {
  const SPREAD = ["      receivers: [", "        otlp, # c1", "        otlp/2, # c2", "        otlp/3 # c3", "      ]"];
  const pipelineText = (lines: readonly string[], eol = "\n") =>
    [
      "receivers:",
      "  otlp: {}",
      "  otlp/2: {}",
      "  otlp/3: {}",
      "  otlp/4: {}",
      "  otlp/5: {}",
      "exporters:",
      "  debug: {}",
      "service:",
      "  pipelines:",
      "    traces:",
      ...lines,
      "      exporters: [debug] # out",
      "",
    ].join(eol);
  const receiversOf = (text: string, eol = "\n") => {
    const lines = text.split(eol);
    const first = lines.findIndex((line) => line.startsWith("      receivers:"));
    const last = lines.findIndex((line) => line.startsWith("      exporters:"));
    return lines.slice(first, last);
  };
  const setReceivers = (names: string[]) => (model: Model) => {
    lists(model, "traces").receivers = names;
  };

  it("appends `, x` after the last item's content, its comment and the closing bracket's line kept (canvas and form)", () => {
    const canvas = edit(pipelineText(SPREAD), setReceivers(["otlp", "otlp/2", "otlp/3", "otlp/4"]));
    expect(receiversOf(canvas.text)).toEqual([...SPREAD.slice(0, 3), "        otlp/3, otlp/4 # c3", "      ]"]);
    const form = write(pipelineText(SPREAD), ["service", "pipelines"], [{ path: ["traces", "receivers", 3], value: "otlp/4" }]);
    expect(form.text).toBe(canvas.text);
  });

  it("removes the first, a middle and the last item with its separator, the other items' comments kept", () => {
    expect(receiversOf(edit(pipelineText(SPREAD), setReceivers(["otlp/2", "otlp/3"])).text)).toEqual([
      "      receivers: [",
      "        otlp/2, # c2",
      "        otlp/3 # c3",
      "      ]",
    ]);
    expect(receiversOf(edit(pipelineText(SPREAD), setReceivers(["otlp", "otlp/3"])).text)).toEqual([
      "      receivers: [",
      "        otlp, # c1",
      "        otlp/3 # c3",
      "      ]",
    ]);
    // The last: the comma before it goes, the comment of the item before it stays on its line.
    const last = edit(pipelineText(SPREAD), setReceivers(["otlp", "otlp/2"]));
    expect(receiversOf(last.text)).toEqual(["      receivers: [", "        otlp, # c1", "        otlp/2 # c2", "      ]"]);
    expect(receiversOf(edit(pipelineText(SPREAD), setReceivers(["otlp"])).text)).toEqual(["      receivers: [", "        otlp # c1", "      ]"]);
    // A form's removal by index writes the same.
    const form = write(pipelineText(SPREAD), ["service", "pipelines"], [{ path: ["traces", "receivers", 2], remove: true }]);
    expect(form.text).toBe(last.text);
    // An item appended and then removed gives the text back.
    const appended = edit(pipelineText(SPREAD), setReceivers(["otlp", "otlp/2", "otlp/3", "otlp/4"])).text;
    expect(edit(appended, setReceivers(["otlp", "otlp/2", "otlp/3"])).text).toBe(pipelineText(SPREAD));
  });

  it("removes a last item that shares the closing bracket's line, leaving the bracket", () => {
    const text = pipelineText(["      receivers: [", "        otlp, # c1", "        otlp/2]"]);
    expect(receiversOf(edit(text, setReceivers(["otlp"])).text)).toEqual(["      receivers: [", "        otlp # c1", "        ]"]);
  });

  it("sets an item in place, its quoting and its comment kept", () => {
    const quoted = ["      receivers: [", "        'otlp', # c1", '        "otlp/2" # c2', "      ]"];
    expect(receiversOf(edit(pipelineText(quoted), setReceivers(["otlp", "otlp/4"])).text)).toEqual([
      "      receivers: [",
      "        'otlp', # c1",
      '        "otlp/4" # c2',
      "      ]",
    ]);
    // The last set and one appended: the new item follows the set one's content.
    expect(receiversOf(edit(pipelineText(SPREAD), setReceivers(["otlp", "otlp/2", "otlp/4", "otlp/5"])).text)).toEqual([
      ...SPREAD.slice(0, 3),
      "        otlp/4, otlp/5 # c3",
      "      ]",
    ]);
    // An item added between two goes before the next one, on its line.
    expect(receiversOf(edit(pipelineText(SPREAD), setReceivers(["otlp", "otlp/2", "otlp/4", "otlp/3"])).text)).toEqual([
      ...SPREAD.slice(0, 3),
      "        otlp/4, otlp/3 # c3",
      "      ]",
    ]);
  });

  it("keeps CRLF line endings", () => {
    const text = pipelineText(SPREAD, "\r\n");
    const appended = edit(text, setReceivers(["otlp", "otlp/2", "otlp/3", "otlp/4"])).text;
    expect(receiversOf(appended, "\r\n")).toEqual([...SPREAD.slice(0, 3), "        otlp/3, otlp/4 # c3", "      ]"]);
    const removed = edit(text, setReceivers(["otlp"])).text;
    expect(receiversOf(removed, "\r\n")).toEqual(["      receivers: [", "        otlp # c1", "      ]"]);
    for (const result of [appended, removed]) expect(result.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("refuses a reorder with the not-expressible error, rather than joining the lines", () => {
    const text = pipelineText(SPREAD);
    const before = read(text).model;
    const after = cloneModel(before);
    setReceivers(["otlp/3", "otlp", "otlp/2"])(after);
    expect(() => editText(text, before, after)).toThrow(TextEditError);
    expect(() => editText(text, before, after)).toThrow("This edit can't be written as a splice: a reorder of a flow sequence spread over lines.");
  });

  it("writes a one-line flow list and a block list as before", () => {
    const oneLine = pipelineText(["      receivers: [otlp, otlp/2, otlp/3] # c"]);
    expect(receiversOf(edit(oneLine, setReceivers(["otlp/3", "otlp", "otlp/4"])).text)).toEqual(["      receivers: [otlp/3, otlp, otlp/4] # c"]);
    const block = pipelineText(["      receivers:", "        - otlp # c1", "        - otlp/2 # c2"]);
    expect(receiversOf(edit(block, setReceivers(["otlp/2", "otlp/4"])).text)).toEqual([
      "      receivers:",
      "        - otlp/2 # c2",
      "        - otlp/4",
    ]);
  });
});

/*
 * D9d Ruling 38: the multi-line flow splice, polished. The only item of a
 * list with a trailing comma can be removed; a removed item takes its own
 * comment lines (the ones directly above it) and the next item keeps its;
 * no removal leaves a line of white space or trailing white space.
 */
describe("removing from a flow list spread over lines, polished (D9d Ruling 38)", () => {
  const component = (list: readonly string[], eol = "\n") =>
    ["processors:", "  attributes:", "    other: 1 # keep", ...list, "    after: 2 # keep", "exporters:", "  debug: {}", ""].join(eol);
  const listOf = (text: string, eol = "\n") => {
    const lines = text.split(eol);
    return lines.slice(lines.findIndex((line) => line.startsWith("    list:")), lines.findIndex((line) => line.startsWith("    after:")));
  };
  const removing = (list: readonly string[], index: number, eol = "\n") =>
    write(component(list, eol), ["processors", "attributes"], [{ path: ["list", index], remove: true }]);
  const valueOf = (text: string) => (parseDocument(text).toJS() as { processors: { attributes: { list: unknown } } }).processors.attributes.list;
  const noBlankOrTrailing = (text: string) => {
    for (const line of text.split(/\r?\n/).slice(0, -1)) {
      expect(line.trim()).not.toBe("");
      expect(line).not.toMatch(/[ \t]$/);
    }
  };

  it("removes the only item of a list with a trailing comma: `[]`, or the bracket lines without it", () => {
    const spread = removing(["    list: [", "      otlp,", "    ]"], 0);
    expect(listOf(spread.text)).toEqual(["    list: []"]);
    expect(valueOf(spread.text)).toEqual([]);
    expect(listOf(removing(["    list: [a,]"], 0).text)).toEqual(["    list: []"]);
    expect(listOf(removing(["    list: [ a, ] # c"], 0).text)).toEqual(["    list: [] # c"]);
    expect(listOf(removing(["    list: [", "      otlp,]"], 0).text)).toEqual(["    list: []"]);
    // A comment of the list's own keeps its bracket lines.
    const open = removing(["    list: [ # open", "      otlp, # c1", "    ]"], 0);
    expect(listOf(open.text)).toEqual(["    list: [ # open", "    ]"]);
    expect(valueOf(open.text)).toEqual([]);
    // CRLF too.
    const crlf = removing(["    list: [", "      otlp,", "    ]"], 0, "\r\n");
    expect(listOf(crlf.text, "\r\n")).toEqual(["    list: []"]);
    expect(crlf.text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("a removed item takes the comment lines directly above it; the next item keeps its own", () => {
    const list = ["    list: [", "      # about a", "      a, # ca", "      # about b", "      b, # cb", "      # about c", "      c # cc", "    ]"];
    expect(listOf(removing(list, 0).text)).toEqual(["    list: [", "      # about b", "      b, # cb", "      # about c", "      c # cc", "    ]"]);
    expect(listOf(removing(list, 1).text)).toEqual(["    list: [", "      # about a", "      a, # ca", "      # about c", "      c # cc", "    ]"]);
    // The last: its comment lines go with it, none left orphaned; the comma before it goes.
    expect(listOf(removing(list, 2).text)).toEqual(["    list: [", "      # about a", "      a, # ca", "      # about b", "      b # cb", "    ]"]);
    // The canvas's way, several at once.
    const twoGone = write(component(list), ["processors", "attributes"], [{ path: ["list"], value: ["b"] }]);
    expect(listOf(twoGone.text)).toEqual(["    list: [", "      # about b", "      b # cb", "    ]"]);
    expect(listOf(write(component(list), ["processors", "attributes"], [{ path: ["list"], value: ["a", "c"] }]).text)).toEqual([
      "    list: [",
      "      # about a",
      "      a, # ca",
      "      # about c",
      "      c # cc",
      "    ]",
    ]);
  });

  it("leaves no line of white space and no trailing white space", () => {
    const cases: Array<[string[], number, string[], unknown[]]> = [
      // A comma on its own line, the item after it removed.
      [["    list: [", "      a", "      , b", "    ]"], 1, ["    list: [", "      a", "    ]"], ["a"]],
      [["    list: [", "      a", "      , b", "    ]"], 0, ["    list: [", "      b", "    ]"], ["b"]],
      // Items sharing a line.
      [["    list: [", "      a, b,", "      c", "    ]"], 1, ["    list: [", "      a,", "      c", "    ]"], ["a", "c"]],
      [["    list: [", "      a, b,", "      c", "    ]"], 0, ["    list: [", "      b,", "      c", "    ]"], ["b", "c"]],
      [["    list: [a, ", "      b", "    ]"], 0, ["    list: [", "      b", "    ]"], ["b"]],
      [["    list: [", "      a, b # cb", "    ]"], 1, ["    list: [", "      a # cb", "    ]"], ["a"]],
      // A trailing comma, the last item removed.
      [["    list: [", "      a,", "      b,", "    ]"], 1, ["    list: [", "      a,", "    ]"], ["a"]],
    ];
    for (const [list, index, expected, value] of cases) {
      const result = removing(list, index);
      expect(listOf(result.text)).toEqual(expected);
      expect(valueOf(result.text)).toEqual(value);
      noBlankOrTrailing(result.text);
    }
  });
});

/*
 * D9d Ruling 39: (a) an item's own comment lines are looked for only below
 * the previous item's comma (or the `[`), so a quoted item's line starting
 * with `#` isn't one; (b) the first items of an emptied list that kept its
 * comment go on a line of their own, the comment kept (after the `[` line
 * since Ruling 40); (c) an item
 * moved in a flow list spread over lines takes its comment lines and the
 * comment after it, or the move is refused. One-line flow lists and block
 * lists move as before.
 */
describe("a flow list spread over lines keeps its comments through moves and appends (D9d Ruling 39)", () => {
  const component = (list: readonly string[], eol = "\n") =>
    ["processors:", "  attributes:", "    other: 1 # keep", ...list, "    after: 2 # keep", "exporters:", "  debug: {}", ""].join(eol);
  const listOf = (text: string, eol = "\n") => {
    const lines = text.split(eol);
    return lines.slice(lines.findIndex((line) => line.startsWith("    list:")), lines.findIndex((line) => line.startsWith("    after:")));
  };
  const writing = (list: readonly string[], changes: ValueChange[], eol = "\n") => {
    const result = write(component(list, eol), ["processors", "attributes"], changes);
    if (eol === "\r\n") expect(result.text.replace(/\r\n/g, "")).not.toContain("\n");
    return { lines: listOf(result.text, eol), value: valueOf(result.text) };
  };
  const valueOf = (text: string) => (parseDocument(text).toJS() as { processors: { attributes: { list: unknown } } }).processors.attributes.list;
  const NOT_EXPRESSIBLE = "This edit can't be written as a splice: a move of a commented item in a flow sequence spread over lines.";

  it("(a) removes the item after a quoted item whose line starts with `#`, the quoted item kept whole", () => {
    for (const eol of ["\n", "\r\n"]) {
      const quoted = ["    list: [", '      "first', '      # still in string",', "      x", "    ]"];
      const kept = ["    list: [", '      "first', '      # still in string"', "    ]"];
      expect(writing(quoted, [{ path: ["list", 1], remove: true }], eol)).toEqual({ lines: kept, value: ["first # still in string"] });
      // The canvas's way, the whole list set.
      expect(writing(quoted, [{ path: ["list"], value: ["first # still in string"] }], eol).lines).toEqual(kept);
      const single = ["    list: [", "      'a", "      #b',", "      x,", "      y", "    ]"];
      expect(writing(single, [{ path: ["list", 1], remove: true }], eol)).toEqual({
        lines: ["    list: [", "      'a", "      #b',", "      y", "    ]"],
        value: ["a #b", "y"],
      });
    }
    // A comment line of its own above the item still goes with it.
    const commented = ["    list: [", '      "first', '      # still in string",', "      # about x", "      x", "    ]"];
    expect(writing(commented, [{ path: ["list", 1], remove: true }]).lines).toEqual(["    list: [", '      "first', '      # still in string"', "    ]"]);
  });

  it("(b) appends to an emptied list that kept its comment on a line of its own, the comment kept (after the `[` line, Ruling 40)", () => {
    for (const eol of ["\n", "\r\n"]) {
      // A form's append, a whole-list set, and the form's removal of the last item then an append.
      const open = ["    list: [ # open", "    ]"];
      expect(writing(open, [{ path: ["list", 0], value: "z" }], eol)).toEqual({ lines: ["    list: [ # open", "      z", "    ]"], value: ["z"] });
      expect(writing(open, [{ path: ["list"], value: ["z", "y"] }], eol)).toEqual({
        lines: ["    list: [ # open", "      z, y", "    ]"],
        value: ["z", "y"],
      });
      const tail = ["    list: [", "      # tail", "    ]"];
      expect(writing(tail, [{ path: ["list", 0], value: { k: "v" } }], eol)).toEqual({
        lines: ["    list: [", "      {k: v}", "      # tail", "    ]"],
        value: [{ k: "v" }],
      });
      const one = ["    list: [ # open", "      a # ca", "    ]"];
      expect(
        writing(
          one,
          [
            { path: ["list", 0], remove: true },
            { path: ["list", 0], value: "z" },
          ],
          eol,
        ),
      ).toEqual({ lines: ["    list: [ # open", "      z", "    ]"], value: ["z"] });
    }
    // An emptied list with nothing between its brackets is `[]`, and becomes a block list as before (Ruling 85).
    expect(writing(["    list: []"], [{ path: ["list", 0], value: "z" }]).lines).toEqual(["    list:", "      - z"]);
  });

  it("(b) the canvas adds a pipeline's first item to an emptied list that kept its comment", () => {
    const pipeline = (receivers: readonly string[], eol = "\n") =>
      ["receivers:", "  otlp: {}", "exporters:", "  debug: {}", "service:", "  pipelines:", "    traces:", ...receivers, "      exporters: [debug]", ""].join(eol);
    for (const eol of ["\n", "\r\n"]) {
      const text = pipeline(["      receivers: [", "        # keep me", "      ]"], eol);
      const result = edit(text, (model) => {
        lists(model, "traces").receivers = ["otlp"];
      }).text;
      expect(result).toBe(pipeline(["      receivers: [", "        otlp", "        # keep me", "      ]"], eol));
    }
  });

  describe("(c) moves", () => {
    const LIST = ["    list: [", "      a, # ca", "      # above b", "      b,", "      c # cc", "    ]"];
    const moving = (list: readonly string[], from: number, to: number, eol = "\n") => writing(list, [{ path: ["list", from], moveTo: to }], eol);

    it("moves an item with its comment lines and the comment after it, down and up, LF and CRLF", () => {
      for (const eol of ["\n", "\r\n"]) {
        expect(moving(LIST, 0, 2, eol)).toEqual({
          lines: ["    list: [", "      # above b", "      b,", "      c, # cc", "      a # ca", "    ]"],
          value: ["b", "c", "a"],
        });
        expect(moving(LIST, 2, 0, eol)).toEqual({
          lines: ["    list: [", "      c, # cc", "      a, # ca", "      # above b", "      b", "    ]"],
          value: ["c", "a", "b"],
        });
        expect(moving(LIST, 1, 2, eol)).toEqual({
          lines: ["    list: [", "      a, # ca", "      c, # cc", "      # above b", "      b", "    ]"],
          value: ["a", "c", "b"],
        });
        expect(moving(LIST, 1, 0, eol)).toEqual({
          lines: ["    list: [", "      # above b", "      b,", "      a, # ca", "      c # cc", "    ]"],
          value: ["b", "a", "c"],
        });
      }
    });

    it("moves mappings (filter conditions, routes) with their comments; a trailing comma stays last", () => {
      const maps = ["    list: [", "      {key: env, value: prod}, # env", "      # never", "      {key: secret, action: delete}", "    ]"];
      expect(moving(maps, 1, 0)).toEqual({
        lines: ["    list: [", "      # never", "      {key: secret, action: delete},", "      {key: env, value: prod} # env", "    ]"],
        value: [
          { key: "secret", action: "delete" },
          { key: "env", value: "prod" },
        ],
      });
      const trailing = ["    list: [", "      a, # ca", "      b, # cb", "    ]"];
      expect(moving(trailing, 0, 1).lines).toEqual(["    list: [", "      b, # cb", "      a, # ca", "    ]"]);
      expect(moving(trailing, 1, 0).lines).toEqual(["    list: [", "      b, # cb", "      a, # ca", "    ]"]);
    });

    it("inserts at an index (an append, then a move) on a line of its own, the other items' comments kept", () => {
      for (const eol of ["\n", "\r\n"]) {
        const inserting = (index: number) =>
          writing(
            LIST,
            [
              { path: ["list", 3], value: "z" },
              { path: ["list", 3], moveTo: index },
            ],
            eol,
          );
        expect(inserting(0)).toEqual({
          lines: ["    list: [", "      z,", "      a, # ca", "      # above b", "      b,", "      c # cc", "    ]"],
          value: ["z", "a", "b", "c"],
        });
        expect(inserting(1)).toEqual({
          lines: ["    list: [", "      a, # ca", "      z,", "      # above b", "      b,", "      c # cc", "    ]"],
          value: ["a", "z", "b", "c"],
        });
        expect(inserting(2).lines).toEqual(["    list: [", "      a, # ca", "      # above b", "      b,", "      z,", "      c # cc", "    ]"]);
      }
    });

    it("moves the items on the brackets' lines, the `[` and `]` kept", () => {
      const brackets = ["    list: [a, # ca", "      b, # cb", "      c]"];
      expect(moving(brackets, 1, 0)).toEqual({ lines: ["    list: [b, # cb", "      a, # ca", "      c]"], value: ["b", "a", "c"] });
      expect(moving(brackets, 2, 0).lines).toEqual(["    list: [c,", "      a, # ca", "      b # cb", "      ]"]);
      expect(moving(brackets, 0, 2)).toEqual({ lines: ["    list: [", "      b, # cb", "      c,", "      a # ca", "    ]"], value: ["b", "c", "a"] });
    });

    it("refuses a move whose item's comment can't go with it; moves items sharing lines without comments in place", () => {
      // `# ab` is a's (the first item ending on its line), which shares its line with b.
      const shared = component(["    list: [", "      a, b, # ab", "      c", "    ]"]);
      expect(() => writeValues(shared, ["processors", "attributes"], [{ path: ["list", 0], moveTo: 2 }])).toThrow(NOT_EXPRESSIBLE);
      // c, moved between them, leaves it a's.
      expect(listOf(write(shared, ["processors", "attributes"], [{ path: ["list", 2], moveTo: 1 }]).text)).toEqual([
        "    list: [",
        "      a, c, b # ab",
        "    ]",
      ]);
      // A comment before the comma (commas first) can't go with its item either.
      const commaFirst = component(["    list: [", "      a # ca", "      , b", "    ]"]);
      expect(() => writeValues(commaFirst, ["processors", "attributes"], [{ path: ["list", 0], moveTo: 1 }])).toThrow(NOT_EXPRESSIBLE);
      // Without comments, items sharing lines move as before.
      expect(moving(["    list: [a, b,", "      c, d]"], 3, 1)).toEqual({ lines: ["    list: [a, d, b,", "      c]"], value: ["a", "d", "b", "c"] });
    });

    it("moves one-line flow lists and block lists as before", () => {
      expect(moving(["    list: [a, b, c] # c"], 0, 2).lines).toEqual(["    list: [b, c, a] # c"]);
      expect(moving(["    list:", "      - a # ca", "      # above b", "      - b"], 1, 0).lines).toEqual([
        "    list:",
        "      # above b",
        "      - b",
        "      - a # ca",
      ]);
    });
  });
});

describe("a move in a long commented flow list spread over lines (D9d final ruling F10)", () => {
  it("moves an item of 6,000 with its comments in a few parses of the text, not a scan per comment", () => {
    const N = 6000;
    const names = Array.from({ length: N }, (_name, i) => `otlp/r${i}`);
    // Every third item has a comment line of its own above it; every item a comment after it.
    const itemLines = (order: readonly number[]) =>
      order.flatMap((i) => [...(i % 3 === 0 ? [`        # lead ${i}`] : []), `        ${names[i]}, # c${i}`]);
    const text = (order: readonly number[]) =>
      ["processors:", "  filter:", "    traces:", "      span: [", ...itemLines(order), "      ]", "exporters:", "  debug: {}", ""].join("\n");
    const indexes = names.map((_name, i) => i);
    const before = text(indexes);
    // The bound is in parses of this text on this machine, not in milliseconds (D9b Ruling 86, D9c Ruling 92).
    const parse = () => parseDocument(before, { ...PARSE_OPTIONS, uniqueKeys: false });
    parse();
    let parseTime = Infinity;
    for (let i = 0; i < 2; i++) {
      const at = performance.now();
      parse();
      parseTime = Math.min(parseTime, performance.now() - at);
    }
    // Timed twice, the faster kept: the first run also warms the editor's code up.
    const moving = (from: number, to: number) => {
      let result = "";
      let elapsed = Infinity;
      for (let i = 0; i < 2; i++) {
        const document = parse() as unknown as ParsedText;
        const started = performance.now();
        result = writeValues(before, ["processors", "filter"], [{ path: ["traces", "span", from], moveTo: to }], document).text;
        elapsed = Math.min(elapsed, performance.now() - started);
      }
      return { result, elapsed };
    };
    const up = moving(3000, 10);
    const order = [...indexes];
    order.splice(10, 0, ...order.splice(3000, 1));
    expect(up.result).toBe(text(order));
    // About two and a half parses (a laptop: 216 ms against an 87 ms parse); a scan of the items per
    // comment (`nodes.find`) cost about 48 by the review's probe, and over 300 under this runner.
    expect(up.elapsed).toBeLessThan(parseTime * 8);
  });
});

/*
 * D9d Ruling 40: (a) the first items of an emptied flow list spread over
 * lines go right after the `[` line, before the comment lines it kept, so
 * those stay no item's and removing the items gives back the text as it
 * was, by a form (an append, a removal) and by the canvas (the whole list
 * set); (d) at the larger of the comment lines' indentation and a unit past
 * the `]`'s; (b) a move's comment check counts each comment with its item,
 * so two comments with the same text don't refuse a right move; (c) a
 * write's read-back takes in the whole component apart from what it edits,
 * so a move that re-binds an alias elsewhere in the component is refused.
 */
describe("emptied flow lists keep their comments; writes can't change other values in the component (D9d Ruling 40)", () => {
  const BASE = ["processors", "attributes"];
  const component = (list: readonly string[], eol = "\n", rest: readonly string[] = []) =>
    ["processors:", "  attributes:", "    other: 1 # keep", ...list, ...rest, "    after: 2 # keep", "exporters:", "  debug: {}", ""].join(eol);
  const listOf = (text: string, eol = "\n") => {
    const lines = text.split(eol);
    return lines.slice(lines.findIndex((line) => line.startsWith("    list:")), lines.findIndex((line) => line.startsWith("    after:")));
  };
  const valueOf = (text: string) => (parseDocument(text).toJS() as { processors: { attributes: Value } }).processors.attributes;
  const EMPTIED = [
    ["    list: [ # a", "      # b", "    ]"],
    ["    list: [", "      # tail", "    ]"],
    ["    list: [", "      # a", "      # b", "      # c", "    ]"],
  ];

  it("(a) a form's append then removal gives back the text, the comment lines after the new item", () => {
    for (const eol of ["\n", "\r\n"]) {
      for (const list of EMPTIED) {
        const text = component(list, eol);
        const appended = write(text, BASE, [{ path: ["list", 0], value: "z" }]).text;
        expect(listOf(appended, eol)).toEqual([list[0], "      z", ...list.slice(1)]);
        expect(valueOf(appended).list).toEqual(["z"]);
        const second = write(appended, BASE, [{ path: ["list", 1], value: "y" }]).text;
        expect(write(second, BASE, [{ path: ["list", 1], remove: true }]).text).toBe(appended);
        expect(write(appended, BASE, [{ path: ["list", 0], remove: true }]).text).toBe(text);
      }
    }
  });

  it("(a) the canvas's way, the whole list set then emptied, gives back the text", () => {
    for (const eol of ["\n", "\r\n"]) {
      for (const list of EMPTIED) {
        const text = component(list, eol);
        const set = write(text, BASE, [{ path: ["list"], value: ["z", "y"] }]).text;
        expect(listOf(set, eol)).toEqual([list[0], "      z, y", ...list.slice(1)]);
        expect(write(set, BASE, [{ path: ["list"], value: [] }]).text).toBe(text);
      }
    }
    // A pipeline's list, changed on the canvas.
    const pipeline = (receivers: readonly string[]) =>
      ["receivers:", "  otlp: {}", "  r2: {}", "exporters:", "  debug: {}", "service:", "  pipelines:", "    traces:", ...receivers, "      exporters: [debug]", ""].join("\n");
    for (const receivers of [
      ["      receivers: [ # a", "        # b", "      ]"],
      ["      receivers: [", "        # tail", "      ]"],
      ["      receivers: [", "        # a", "        # b", "        # c", "      ]"],
    ]) {
      const text = pipeline(receivers);
      const added = edit(text, (model) => {
        lists(model, "traces").receivers = ["otlp", "r2"];
      }).text;
      expect(added).toBe(pipeline([receivers[0]!, "        otlp, r2", ...receivers.slice(1)]));
      expect(
        edit(added, (model) => {
          lists(model, "traces").receivers = [];
        }).text,
      ).toBe(text);
    }
  });

  it("(d) a new item stands at the larger of the comment lines' indentation and a unit past the `]`'s", () => {
    const shallow = ["    list: [ # a", "  # b", "    ]"];
    expect(listOf(write(component(shallow), BASE, [{ path: ["list", 0], value: "z" }]).text)).toEqual(["    list: [ # a", "      z", "  # b", "    ]"]);
    const deep = ["    list: [ # a", "          # b", "    ]"];
    expect(listOf(write(component(deep), BASE, [{ path: ["list", 0], value: "z" }]).text)).toEqual([
      "    list: [ # a",
      "          z",
      "          # b",
      "    ]",
    ]);
  });

  it("(b) moves an item when two comments have the same text, each staying with its item", () => {
    const todo = ["    list: [", "      a, # TODO", "      b, # TODO", "      c", "    ]"];
    const moved = write(component(todo), BASE, [{ path: ["list", 1], moveTo: 0 }]).text;
    expect(listOf(moved)).toEqual(["    list: [", "      b, # TODO", "      a, # TODO", "      c", "    ]"]);
    expect(valueOf(moved).list).toEqual(["b", "a", "c"]);
    const lead = ["    list: [", "      # x", "      a,", "      # x", "      b,", "      c", "    ]"];
    expect(listOf(write(component(lead), BASE, [{ path: ["list", 1], moveTo: 0 }]).text)).toEqual([
      "    list: [",
      "      # x",
      "      b,",
      "      # x",
      "      a,",
      "      c",
      "    ]",
    ]);
  });

  it("(c) refuses a move that re-binds an alias elsewhere in the component; other moves in the list are written", () => {
    const ref = ["    ref: *x"];
    const OUTSIDE = "A change reached a value outside the one it edits.";
    for (const list of [["    list: [&x a, b, &x c]"], ["    list: [", "      &x a, # ca", "      b,", "      &x c # cc", "    ]"]]) {
      const text = component(list, "\n", ref);
      expect(valueOf(text).ref).toBe("c");
      // `&x c` above `&x a` would leave `ref` reading a.
      expect(() => writeValues(text, BASE, [{ path: ["list", 2], moveTo: 0 }])).toThrow(OUTSIDE);
      const moved = write(text, BASE, [{ path: ["list", 1], moveTo: 0 }]).text;
      expect(valueOf(moved)).toEqual({ other: 1, list: ["b", "a", "c"], ref: "c", after: 2 });
    }
    // The same in a sequence of changes: each change's own paths are left out, the rest compared.
    const text = component(["    list: [&x a, b, &x c]"], "\n", ref);
    expect(() =>
      writeValues(text, BASE, [
        { path: ["other"], value: 3 },
        { path: ["list", 2], moveTo: 0 },
      ]),
    ).toThrow(OUTSIDE);
    expect(valueOf(write(text, BASE, [{ path: ["other"], value: 3 }, { path: ["list", 0], remove: true }, { path: ["list", 2], value: "d" }]).text)).toEqual({
      other: 3,
      list: ["b", "c", "d"],
      ref: "c",
      after: 2,
    });
  });
});

/*
 * D9d Ruling 42: (a) a remove, move or rename compares the component
 * before and after that change alone, its own paths taken out, so a later
 * change re-binding an alias inside a path an earlier one edited is
 * refused (the check of the whole write takes those paths out); (b)
 * `valuesEqual` compares what YAML's own tags read as (a Date by its time,
 * bytes, a Map's or a Set's entries), so a component or a document holding
 * them isn't refused on every write; (c) an emptied flow list's first item
 * stands at a column, in spaces, a tab before the `]` or a comment expanded
 * and never copied.
 */
describe("writes compare each change; YAML's own types compare; tabs aren't copied (D9d Ruling 42)", () => {
  const BASE = ["processors", "attributes"];
  const OUTSIDE = "A change reached a value outside the one it edits.";
  const component = (lines: readonly string[]) => ["processors:", "  attributes:", ...lines, "exporters:", "  debug: {}", ""].join("\n");
  const valueOf = (text: string) => (parseDocument(text).toJS() as { processors: { attributes: Value } }).processors.attributes;

  it("(a) refuses a move that re-binds an alias inside a path an earlier rename or removal edited", () => {
    // Renamed, `ref.r2` is an edited path: the move leaves it reading a.
    const renamed = component(["    list: [&x a, b, &x c]", "    ref: {r: *x}"]);
    expect(() =>
      writeValues(renamed, BASE, [
        { path: ["ref", "r"], renameTo: "r2" },
        { path: ["list", 2], moveTo: 0 },
      ]),
    ).toThrow(OUTSIDE);
    // An item removed from `l2` makes `l2` an edited path: the move leaves its `*x` reading a.
    const removed = component(["    list: [&x a, b, &x c]", "    l2: [*x, q]"]);
    expect(() =>
      writeValues(removed, BASE, [
        { path: ["l2", 1], remove: true },
        { path: ["list", 2], moveTo: 0 },
      ]),
    ).toThrow(OUTSIDE);
    // And in the other order.
    expect(() =>
      writeValues(removed, BASE, [
        { path: ["list", 2], moveTo: 0 },
        { path: ["l2", 1], remove: true },
      ]),
    ).toThrow(OUTSIDE);
  });

  it("(a) writes the same changes where no alias is re-bound, and single changes as before", () => {
    const plain = component(["    list: [a, b, c]", "    ref: {r: c}"]);
    expect(valueOf(write(plain, BASE, [{ path: ["ref", "r"], renameTo: "r2" }, { path: ["list", 2], moveTo: 0 }]).text)).toEqual({
      list: ["c", "a", "b"],
      ref: { r2: "c" },
    });
    // Aliases the changes don't re-bind: renamed, removed and moved around them.
    const bound = component(["    list: [&x a, b, c]", "    ref: {r: *x}", "    l2: [*x, q]"]);
    expect(
      valueOf(
        write(bound, BASE, [
          { path: ["ref", "r"], renameTo: "r2" },
          { path: ["l2", 1], remove: true },
          { path: ["list", 2], moveTo: 1 },
        ]).text,
      ),
    ).toEqual({ list: ["a", "c", "b"], ref: { r2: "a" }, l2: ["a"] });
    const redefined = component(["    list: [&x a, b, &x c]", "    ref: *x"]);
    expect(valueOf(write(redefined, BASE, [{ path: ["list", 1], moveTo: 0 }]).text)).toEqual({ list: ["b", "a", "c"], ref: "c" });
    expect(() => writeValues(redefined, BASE, [{ path: ["list", 2], moveTo: 0 }])).toThrow(OUTSIDE);
  });

  it("(b) valuesEqual compares Dates by time, bytes, and Maps and Sets by their entries in order", () => {
    expect(valuesEqual(new Date("2001-12-14T00:00:00Z"), new Date(Date.UTC(2001, 11, 14)))).toBe(true);
    expect(valuesEqual(new Date("2001-12-14T00:00:00Z"), new Date("2001-12-15T00:00:00Z"))).toBe(false);
    expect(valuesEqual(new Date(Number.NaN), new Date(Number.NaN))).toBe(true);
    expect(valuesEqual(new Date(0), 0)).toBe(false);
    expect(valuesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(valuesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(valuesEqual(new Uint8Array([1]), [1])).toBe(false);
    expect(valuesEqual(new Map([["a", { k: 1 }]]), new Map([["a", { k: 1 }]]))).toBe(true);
    expect(valuesEqual(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(valuesEqual(new Map([["a", 1], ["b", 2]]), new Map([["b", 2], ["a", 1]]))).toBe(false);
    expect(valuesEqual(new Map([["a", 1]]), { a: 1 })).toBe(false);
    expect(valuesEqual(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(true);
    expect(valuesEqual(new Set(["a", "b"]), new Set(["a", "c"]))).toBe(false);
    expect(valuesEqual(new Set(["a"]), new Map([["a", "a"]]))).toBe(false);
    expect(valuesEqual(new Set(["a"]), ["a"])).toBe(false);
  });

  it("(b) writes a component, or a document, holding !!binary, !!set, !!omap or !!timestamp values", () => {
    for (const tagged of ["!!binary aGVsbG8=", "!!set {a, b}", "!!omap [{a: 1}, {b: 2}]", "!!timestamp 2001-12-14", "2001-12-14T21:59:43.10-05:00"]) {
      const inside = component(["    other: 1", `    x: ${tagged}`]);
      expect(write(inside, BASE, [{ path: ["other"], value: 2 }]).text).toBe(inside.replace("other: 1", "other: 2"));
      const outside = component(["    other: 1"]).replace("  debug: {}", `  debug:\n    x: ${tagged}`);
      expect(write(outside, BASE, [{ path: ["other"], value: 2 }]).text).toBe(outside.replace("other: 1", "other: 2"));
      // Removed, renamed and moved past.
      const listed = component(["    list: [a, b]", "    other: 1", `    x: ${tagged}`]);
      expect(valueOf(write(listed, BASE, [{ path: ["list", 1], moveTo: 0 }, { path: ["other"], renameTo: "o" }, { path: ["list", 0], remove: true }]).text).list).toEqual(["a"]);
    }
    // A change to the value itself still reads back.
    expect(valueOf(write(component(["    x: !!set {a, b}"]), BASE, [{ path: ["x"], value: "plain" }]).text)).toEqual({ x: "plain" });
  });

  it("(c) an emptied list's first item stands at a column in spaces, a tab before the `]` or a comment expanded", () => {
    const appended = (lines: readonly string[]) => {
      const text = component([...lines, "    after: 2"]);
      const result = write(text, BASE, [{ path: ["list", 0], value: "z" }]).text;
      expect(valueOf(result).list).toEqual(["z"]);
      expect(write(result, BASE, [{ path: ["list", 0], remove: true }]).text).toBe(text);
      return result.split("\n").slice(2, 2 + lines.length + 1);
    };
    // Five spaces and a tab reach column 8: the item stands a unit past, at 10, in spaces.
    expect(appended(["    list: [ # a", "      # b", "     \t]"])).toEqual(["    list: [ # a", " ".repeat(10) + "z", "      # b", "     \t]"]);
    // A comment line indented by a tab reaches column 8.
    expect(appended(["    list: [", "\t# tabbed", "    ]"])).toEqual(["    list: [", " ".repeat(8) + "z", "\t# tabbed", "    ]"]);
    expect(appended(["    list: [", "  \t# tabbed", "    ]"])).toEqual(["    list: [", " ".repeat(8) + "z", "  \t# tabbed", "    ]"]);
  });
});
