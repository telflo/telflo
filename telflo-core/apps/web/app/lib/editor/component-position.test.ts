import { describe, expect, it } from "vitest";

import { componentPositions } from "./component-position.js";

/*
 * Where a collector's component path is in the text on screen: walked through
 * the mappings by exact key, the deepest prefix that names one, at least
 * `<section>::<id>`.
 */

const TEXT = [
  "receivers:", //                       1
  "  otlp: {}", //                       2
  "  filelog:", //                       3
  "    include: [/var/log/app.log]", //  4
  "    operators:", //                   5
  "      - type: regex_parser", //       6
  "exporters:", //                       7
  "  otlp: {}", //                       8
  "  otlp/2:", //                        9
  "    endpoint: x", //                  10
  "  otlp_http/my-exp.v2: {}", //        11
  "service:", //                         12
  "  extensions: [health_check]", //     13
  "  pipelines:", //                     14
  "    traces:", //                      15
  "      receivers: [otlp]", //          16
  "    traces/2:", //                    17
  "      receivers: [otlp]", //          18
  "",
].join("\n");

const at = (path: string | null) => componentPositions(TEXT)(path);

describe("componentPositions", () => {
  it("finds a component by its whole id: exporters::otlp/2, never the otlp before it", () => {
    expect(at("exporters::otlp/2")).toEqual({ lineNumber: 9, column: 3 });
    expect(at("exporters::otlp")).toEqual({ lineNumber: 8, column: 3 });
  });

  it("keeps hyphens and dots in an id", () => {
    expect(at("exporters::otlp_http/my-exp.v2")).toEqual({ lineNumber: 11, column: 3 });
  });

  it("finds a pipeline: service::pipelines::traces, and traces/2", () => {
    expect(at("service::pipelines::traces")).toEqual({ lineNumber: 15, column: 5 });
    expect(at("service::pipelines::traces/2")).toEqual({ lineNumber: 17, column: 5 });
  });

  it("finds a service key: service::extensions", () => {
    expect(at("service::extensions")).toEqual({ lineNumber: 13, column: 3 });
  });

  it("jumps to the deepest prefix that names a key: baseconfig is a Go struct, not a key", () => {
    expect(at("receivers::filelog::baseconfig::operators::0::builder")).toEqual({ lineNumber: 3, column: 3 });
    expect(at("receivers::filelog::include")).toEqual({ lineNumber: 4, column: 5 });
    // Mappings only: a list's index stops the walk at the key above it.
    expect(at("receivers::filelog::operators::0::type")).toEqual({ lineNumber: 5, column: 5 });
    expect(at("service::pipelines::traces/3")).toEqual({ lineNumber: 14, column: 3 });
  });

  it("has no position for a path naming nothing, a section alone, or no path", () => {
    expect(at("exporters::otlp/3")).toBeNull();
    expect(at("connectors::forward")).toBeNull();
    expect(at("receivers")).toBeNull();
    expect(at(null)).toBeNull();
    expect(at("")).toBeNull();
  });

  it("matches keys exactly: no prefix, no case folding", () => {
    expect(at("exporters::otlp/")).toBeNull();
    expect(at("Exporters::otlp")).toBeNull();
  });

  it("reads text that doesn't parse as far as it goes, and nothing from an empty text", () => {
    expect(componentPositions("")("exporters::otlp")).toBeNull();
    expect(componentPositions("exporters:\n  otlp: [\n")("exporters::otlp")).toEqual({ lineNumber: 2, column: 3 });
  });
});
