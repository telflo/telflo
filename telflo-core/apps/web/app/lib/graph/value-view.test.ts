import { describe, expect, it } from "vitest";

import { read } from "../../test/text-edit-checks.js";
import { corpusText } from "./corpus/corpus.js";
import { writeValues } from "./text-edits.js";
import { nodeAt, readValue } from "./value-view.js";

/*
 * What a form shows is read from the text's document: a plain non-string
 * scalar as written, a string as its value, an explicit null as unset, aliases
 * and merged keys resolved.
 */

const text = [
  "x-defaults: &defaults",
  "  timeout: 5s",
  "  compression: gzip",
  "receivers:",
  "  otlp: &receiver",
  "    protocols:",
  "      grpc:",
  "        endpoint: 0.0.0.0:4317 # the port",
  "        max_recv_msg_size_mib: 0750",
  "        read_buffer_size: 1e3",
  "        write_buffer_size: 0x1F",
  "        auth: ${env:AUTH}",
  "        quoted: \"0750\"",
  "        single: '1e3'",
  "        folded: this plain scalar",
  "          runs on",
  "        literal: |",
  "          one",
  "        enabled: true",
  "        infinite: .inf",
  "        empty:",
  "        tilde: ~",
  "        spelled: null",
  "        tagged: !!str 0750",
  "      http:",
  "  otlp/second: *receiver",
  "exporters:",
  "  otlp:",
  "    <<: *defaults",
  "    timeout: 10s",
  "    headers: [{name: a, value: 0750}, {name: b}]",
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp, otlp/second]",
  "      exporters: [otlp]",
  "",
].join("\n");

describe("readValue", () => {
  const { document } = read(text);
  const grpc = (key: string) => readValue(document, ["receivers", "otlp"], ["protocols", "grpc", key]);

  it("shows a plain scalar that isn't a string as written: 0750, 1e3, 0x1F, true, .inf", () => {
    expect(grpc("max_recv_msg_size_mib")).toEqual({ kind: "scalar", value: 750, source: "0750" });
    expect(grpc("read_buffer_size")).toEqual({ kind: "scalar", value: 1000, source: "1e3" });
    expect(grpc("write_buffer_size")).toEqual({ kind: "scalar", value: 31, source: "0x1F" });
    expect(grpc("enabled")).toEqual({ kind: "scalar", value: true, source: "true" });
    expect(grpc("infinite")).toEqual({ kind: "scalar", value: Infinity, source: ".inf" });
  });

  it("shows a string as its value: a reference, quoted numbers, a tagged one, a multi-line plain string, a literal block", () => {
    expect(grpc("endpoint")).toEqual({ kind: "scalar", value: "0.0.0.0:4317" });
    expect(grpc("auth")).toEqual({ kind: "scalar", value: "${env:AUTH}" });
    expect(grpc("quoted")).toEqual({ kind: "scalar", value: "0750" });
    expect(grpc("single")).toEqual({ kind: "scalar", value: "1e3" });
    expect(grpc("tagged")).toEqual({ kind: "scalar", value: "0750" });
    expect(grpc("folded")).toEqual({ kind: "scalar", value: "this plain scalar runs on" });
    expect(grpc("literal")).toEqual({ kind: "scalar", value: "one\n" });
  });

  it("reads `key:`, `~`, `null` and a missing key as absent", () => {
    for (const key of ["empty", "tilde", "spelled", "missing"]) expect(grpc(key)).toEqual({ kind: "absent", value: undefined });
    expect(readValue(document, ["receivers", "otlp"], ["protocols", "http"]).kind).toBe("absent");
    expect(readValue(document, ["receivers", "otlp"], ["protocols", "grpc", "endpoint", "deeper"]).kind).toBe("absent");
    expect(readValue(document, ["receivers", "otlp"], ["protocols", 0]).kind).toBe("absent");
    expect(readValue(document, ["exporters", "otlp"], ["headers", "name"]).kind).toBe("absent");
    expect(readValue(document, ["exporters", "otlp"], ["headers", 2]).kind).toBe("absent");
  });

  it("resolves an alias and a merged key, and reads list items and mappings", () => {
    expect(readValue(document, ["receivers", "otlp/second"], ["protocols", "grpc", "max_recv_msg_size_mib"])).toEqual({
      kind: "scalar",
      value: 750,
      source: "0750",
    });
    expect(readValue(document, ["exporters", "otlp"], ["compression"])).toEqual({ kind: "scalar", value: "gzip" });
    expect(readValue(document, ["exporters", "otlp"], ["timeout"])).toEqual({ kind: "scalar", value: "10s" });
    expect(readValue(document, ["exporters", "otlp"], ["headers", 0, "value"])).toEqual({ kind: "scalar", value: 750, source: "0750" });
    // Written on one line in flow, the list carries its characters too.
    expect(readValue(document, ["exporters", "otlp"], ["headers"])).toEqual({
      kind: "list",
      value: [{ name: "a", value: 750 }, { name: "b" }],
      source: "[{name: a, value: 0750}, {name: b}]",
    });
    expect(readValue(document, ["exporters", "otlp"], [])).toEqual({
      kind: "map",
      value: { timeout: "10s", compression: "gzip", headers: [{ name: "a", value: 750 }, { name: "b" }] },
    });
    expect(readValue(document, ["receivers", "otlp/second"], ["protocols", "http"]).kind).toBe("absent");
  });

  it("merges in order: a mapping's own keys, then each merge's, nested merges too", () => {
    const merges = read(
      [
        "a: &a {x: 1, y: 1}",
        "b: &b {<<: *a, y: 2, z: 2}",
        "receivers:",
        "  otlp:",
        "    <<: [*b, *a]",
        "    z: 3",
        "service:",
        "  pipelines:",
        "    traces: {receivers: [otlp], exporters: [otlp]}",
        "exporters: {otlp: {}}",
        "",
      ].join("\n"),
    ).document;
    const at = (key: string) => readValue(merges, ["receivers", "otlp"], [key]).value;
    expect([at("x"), at("y"), at("z")]).toEqual([1, 2, 3]);
  });

  it("reads the document it's given, not the text: in manual edit mode the two differ", () => {
    const typed = text.replace("max_recv_msg_size_mib: 0750", "max_recv_msg_size_mib: 0644");
    expect(typed).not.toBe(text);
    // The store keeps the last document that read while the typed text doesn't yet.
    expect(grpc("max_recv_msg_size_mib")).toEqual({ kind: "scalar", value: 750, source: "0750" });
    expect(readValue(read(typed).document, ["receivers", "otlp"], ["protocols", "grpc", "max_recv_msg_size_mib"])).toEqual({
      kind: "scalar",
      value: 644,
      source: "0644",
    });
  });

  it("reads an empty text as absent everywhere, and follows what writeValues wrote", () => {
    const empty = read("").document;
    expect(readValue(empty, ["service", "telemetry"], ["metrics", "level"]).kind).toBe("absent");
    expect(nodeAt(empty, [])).toBeNull();
    const written = writeValues("", ["service", "telemetry"], [{ path: ["metrics", "level"], plain: "1e3" }]);
    expect(readValue(written.document, ["service", "telemetry"], ["metrics", "level"])).toEqual({
      kind: "scalar",
      value: 1000,
      source: "1e3",
    });
  });

  it("reads a field of the last of 6,000 components quickly, each mapping indexed once", () => {
    const lines = ["receivers:"];
    for (let i = 0; i < 6000; i++) lines.push(`  otlp/r${i}:`, "    protocols:", "      grpc:", `        endpoint: 0.0.0.0:${4000 + (i % 1000)}`, "        size: 0750");
    lines.push("service:", "  pipelines:", "    traces:", "      receivers: [otlp/r0]", "      exporters: [otlp/r0]", "");
    const { document: large } = read(lines.join("\n"));
    const field = (key: string) => readValue(large, ["receivers", "otlp/r5999"], ["protocols", "grpc", key]);
    expect(field("size")).toEqual({ kind: "scalar", value: 750, source: "0750" });
    const started = performance.now();
    for (let render = 0; render < 100; render++) {
      for (let i = 0; i < 30; i++) field(i % 2 === 0 ? "endpoint" : "size");
    }
    // Loose: measured at about 0.03 ms a render; a scan of the section's keys took about 2.5 ms.
    expect((performance.now() - started) / 100).toBeLessThan(1);
  });

  it("reads the corpus's components as the model does", () => {
    for (const name of ["anchors-merges.yaml", "anchors-owned.yaml", "item-lists.yaml", "comments.yaml", "flow-style.yaml"]) {
      const { document, model } = read(corpusText(name));
      for (const [key, value] of model.components) {
        const [section, component] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
        const view = readValue(document, [section, component], []);
        if (value === null) expect(view.kind).toBe("absent");
        else expect(view.value).toEqual(value);
      }
    }
  });
});
