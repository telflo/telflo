import { TEST_RUN_SIGNALS, TEST_TEMPLATE_RECEIVER_TYPES } from "@telflo/contracts";
import { describe, expect, it } from "vitest";
import { receiverTypeLabel, signalLabel } from "./labels.js";

/* How a template's receiver type and signal show. */

describe("a test template's labels", () => {
  it("show each signal by its word: Traces, Logs, Metrics", () => {
    expect(TEST_RUN_SIGNALS.map(signalLabel)).toEqual(["Traces", "Metrics", "Logs"]);
  });

  it("show a signal they don't know as it is, never a prototype's member", () => {
    expect(signalLabel("profiles")).toBe("profiles");
    expect(signalLabel("constructor")).toBe("constructor");
    expect(signalLabel("Traces")).toBe("Traces");
  });

  it("show every receiver type a template may name by its palette label, and an unknown one as it is", () => {
    for (const receiverType of TEST_TEMPLATE_RECEIVER_TYPES) {
      expect(receiverTypeLabel(receiverType)).not.toBe(receiverType);
    }
    expect(receiverTypeLabel("filelog")).toBe("File Log");
    expect(receiverTypeLabel("kubelet_zz")).toBe("kubelet_zz");
  });
});
