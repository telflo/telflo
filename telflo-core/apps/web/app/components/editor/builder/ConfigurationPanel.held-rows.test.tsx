import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { ConfigurationPanel } from "./ConfigurationPanel.js";
import type * as Registry from "./config-forms/registry.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * Held rows in the Configuration tab (D9c Task 1; Preflight ruling 8): a
 * held row's typing is written when the form goes (another node selected),
 * and an empty one is the form's local state, gone with it; the tab's form
 * is keyed by the load and the node, so a configuration loaded with the
 * same node ids doesn't keep one. The filelog receiver is given a form with
 * a held-row list here (its own lands in D9c Task 8).
 */

vi.mock("./config-forms/registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof Registry>();
  const { MultiValueField } = await import("./config-forms/form-context.js");
  function HeldRowsForm() {
    return (
      <MultiValueField path={["namespaces"]} label="Namespaces" placeholder="e.g. default" addButtonText="Add Namespace" holdEmpty />
    );
  }
  return {
    ...original,
    formFor: (type: Parameters<typeof original.formFor>[0], subType: string) =>
      type === "receiver" && subType === "filelog" ? HeldRowsForm : original.formFor(type, subType),
  };
});

const TEXT = `receivers:
  filelog:
    namespaces:
      - default # the first
  otlp:
    protocols:
      grpc: {}
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [filelog, otlp]
      exporters: [debug]
`;

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function select(nodeId: string) {
  act(() => builderStore().selectNode(nodeId));
}

const rows = () => screen.queryAllByPlaceholderText("e.g. default") as HTMLInputElement[];
const namespaces = () =>
  (parseYaml(builderStore().text) as { receivers: { filelog: { namespaces: string[] } } }).receivers.filelog.namespaces;

describe("held rows in the Configuration tab (Preflight ruling 8)", () => {
  it("typing in a held row, then selecting another node, writes the item", () => {
    openText(TEXT);
    render(<ConfigurationPanel />);
    select(componentNamed("receivers.filelog").id);
    fireEvent.click(screen.getByRole("button", { name: "Add Namespace" }));
    fireEvent.change(rows()[1]!, { target: { value: "kube-system" } });
    expect(builderStore().text).toBe(TEXT);

    select(componentNamed("receivers.otlp").id);
    expect(namespaces()).toEqual(["default", "kube-system"]);
    expect(builderStore().text).toContain("      - default # the first\n      - kube-system\n  otlp:");
  });

  it("an empty held row is gone after selecting another node and coming back, and writes nothing", () => {
    openText(TEXT);
    render(<ConfigurationPanel />);
    const filelog = componentNamed("receivers.filelog").id;
    select(filelog);
    fireEvent.click(screen.getByRole("button", { name: "Add Namespace" }));
    expect(rows()).toHaveLength(2);
    select(componentNamed("receivers.otlp").id);
    select(filelog);
    expect(rows()).toHaveLength(1);
    expect(builderStore().text).toBe(TEXT);
  });

  it("an empty held row is gone after a configuration loads, even into a node with the same id", () => {
    openText(TEXT);
    render(<ConfigurationPanel />);
    const filelog = componentNamed("receivers.filelog").id;
    select(filelog);
    fireEvent.click(screen.getByRole("button", { name: "Add Namespace" }));
    expect(rows()).toHaveLength(2);
    // The load and the selection in one render: the tab's form is keyed by the load, not only the node id.
    act(() => {
      openText(TEXT);
      builderStore().selectNode(filelog);
    });
    expect(componentNamed("receivers.filelog").id).toBe(filelog);
    expect(rows()).toHaveLength(1);
    expect(builderStore().text).toBe(TEXT);
  });
});
