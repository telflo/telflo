import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeleteConfirmDialog, describeDelete } from "./DeleteConfirmDialog.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import type { OTelNode } from "~/lib/graph/types.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, groupNamed, openText } from "~/test/builder-store.js";

/*
 * The one delete confirmation: the questions as titles, in the Clear dialog's
 * style; Delete deletes as one undo entry, Cancel and Escape delete nothing.
 */

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  openText(STARTER);
  vi.spyOn(toast, "success").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function node(key: string, pipeline: string): OTelNode {
  const group = groupNamed(pipeline);
  const found = builderStore().graph.nodes.find((n) => n.parentId === group.id && componentKey(n.data) === key);
  if (!found) throw new Error(`no ${key} in ${pipeline}`);
  return found;
}

function renderDialog() {
  render(<DeleteConfirmDialog />);
  return userEvent.setup();
}

describe("DeleteConfirmDialog", () => {
  it("is closed while nothing is pending", () => {
    renderDialog();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it('asks "Delete "<label>"?" for one component, with Cancel and a destructive Delete', async () => {
    renderDialog();
    const batch = node("processors.batch", "traces");
    act(() => builderStore().requestDelete({ kind: "nodes", nodeIds: [batch.id] }));

    const dialog = await screen.findByRole("alertdialog", { name: 'Delete "Batch"?' });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Delete"]);
    expect(within(dialog).getByRole("button", { name: "Delete" })).toHaveClass("bg-destructive");
    expect(dialog).not.toHaveAttribute("aria-describedby");
  });

  it('asks "Delete N selected nodes?" for the selection', async () => {
    renderDialog();
    const ids = [node("receivers.otlp", "traces").id, node("processors.batch", "traces").id];
    act(() => builderStore().setSelection(ids));
    act(() => builderStore().requestDelete());

    expect(await screen.findByRole("alertdialog", { name: "Delete 2 selected nodes?" })).toBeInTheDocument();
  });

  it('asks "Delete pipeline "<name>"?" for a pipeline, saying its components go too', async () => {
    renderDialog();
    act(() => builderStore().selectNode(groupNamed("metrics").id));
    act(() => builderStore().requestDelete());

    const dialog = await screen.findByRole("alertdialog", { name: 'Delete pipeline "metrics"?' });
    expect(dialog).toHaveAccessibleDescription("Its components and connections will be removed.");
  });

  it("Cancel deletes nothing", async () => {
    const user = renderDialog();
    const batch = node("processors.batch", "traces");
    act(() => builderStore().requestDelete({ kind: "nodes", nodeIds: [batch.id] }));

    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(builderStore().pendingDelete).toBeNull();
    expect(builderStore().graph.nodes.some((n) => n.id === batch.id)).toBe(true);
    expect(builderStore().text).toBe(STARTER);
    expect(builderStore().history.past).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("Escape deletes nothing", async () => {
    const user = renderDialog();
    act(() => builderStore().requestDelete({ kind: "pipeline", pipelineId: groupNamed("logs").data.pipelineId! }));
    await screen.findByRole("alertdialog");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(builderStore().pendingDelete).toBeNull();
    expect(builderStore().graph.pipelines).toHaveLength(3);
  });

  it("Delete deletes, as one undo entry, with its toast", async () => {
    const user = renderDialog();
    const batch = node("processors.batch", "traces");
    act(() => builderStore().requestDelete({ kind: "nodes", nodeIds: [batch.id] }));

    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(builderStore().graph.nodes.some((n) => n.id === batch.id)).toBe(false);
    expect(builderStore().text).not.toBe(STARTER);
    expect(toast.success).toHaveBeenCalledWith("Deleted 1 node");
    expect(builderStore().history.past.map((e) => e.description)).toEqual(["Delete Batch"]);

    act(() => void builderStore().undo());
    expect(builderStore().text).toBe(STARTER);
  });

  it("closes, deleting nothing, when what it asked about is gone", async () => {
    renderDialog();
    act(() => builderStore().requestDelete({ kind: "nodes", nodeIds: ["node_999"] }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(builderStore().pendingDelete).toBeNull();
  });
});

describe("describeDelete", () => {
  it("asks about a group among the nodes as its pipeline, and falls back to the subtype for a component without a label", () => {
    const { graph } = builderStore();
    const traces = groupNamed("traces");
    expect(describeDelete({ kind: "nodes", nodeIds: [traces.id] }, graph)).toEqual({
      title: 'Delete pipeline "traces"?',
      description: "Its components and connections will be removed.",
    });
    const batch = node("processors.batch", "traces");
    const unlabelled = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === batch.id ? { ...n, data: { ...n.data, label: "" } } : n)),
    };
    expect(describeDelete({ kind: "nodes", nodeIds: [batch.id] }, unlabelled)).toEqual({ title: 'Delete "batch"?' });
    expect(describeDelete({ kind: "pipeline", pipelineId: "pipeline_99" }, graph)).toBeNull();
  });
});
