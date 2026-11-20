import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { DELETE_TITLE, DUPLICATE_TITLE, EditorToolbar, REDO_TITLE, UNDO_TITLE } from "./EditorToolbar.js";
import { DeleteConfirmDialog } from "~/components/editor/builder/DeleteConfirmDialog.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import { selectUndoDescription, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, componentsIn, groupNamed, openText } from "~/test/builder-store.js";

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The toolbar over `text`, with the one delete dialog the canvas actions mount beside it on the page. */
async function renderToolbar(text = STARTER) {
  openText(text);
  const Stub = createRoutesStub([
    {
      path: "/editor",
      Component: () => (
        <>
          <EditorToolbar onSave={() => {}} />
          <DeleteConfirmDialog />
        </>
      ),
      HydrateFallback: () => null,
    },
  ]);
  render(<Stub initialEntries={["/editor"]} />);
  await screen.findByRole("button", { name: "Save" });
  return userEvent.setup();
}

const button = (name: string) => screen.getByRole("button", { name });

function select(nodeId: string | null) {
  act(() => builderStore().selectNode(nodeId));
}

function enterManualEditMode() {
  act(() => builderStore().setText(`${builderStore().text}# typed\n`));
}

const pipelineList = (text: string, pipeline: string, list: "receivers" | "processors" | "exporters") =>
  (parseYaml(text) as { service: { pipelines: Record<string, Record<string, string[]>> } }).service.pipelines[pipeline]![
    list
  ];

describe("EditorToolbar's builder buttons", () => {
  it("puts Undo, Redo, Duplicate and Delete before Save, in one group, with fixed titles as their aria-labels; Publish follows Save", async () => {
    await renderToolbar();

    const actions = document.querySelector('[data-tour-step="toolbar-actions"]')!;
    const names = within(actions as HTMLElement)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual([UNDO_TITLE, REDO_TITLE, DUPLICATE_TITLE, DELETE_TITLE, "Save", "Publish"]);
    expect([UNDO_TITLE, REDO_TITLE, DUPLICATE_TITLE, DELETE_TITLE]).toEqual([
      "Undo (Ctrl+Z)",
      "Redo (Ctrl+Shift+Z)",
      "Duplicate (Ctrl+D)",
      "Delete",
    ]);
    for (const title of [UNDO_TITLE, REDO_TITLE, DUPLICATE_TITLE, DELETE_TITLE]) {
      const icon = button(title);
      expect(icon).toHaveAttribute("title", title);
      expect(icon).toHaveClass("h-8", "w-8", "p-0");
      expect(icon.textContent).toBe("");
    }
    // A divider between the four and Save.
    expect(button("Save").previousElementSibling).toHaveClass("w-px", "h-5", "bg-border");
  });

  describe("Undo and Redo", () => {
    it("are disabled with nothing to undo or redo, and undo and redo a change, text and canvas together", async () => {
      const user = await renderToolbar();
      expect(button(UNDO_TITLE)).toBeDisabled();
      expect(button(REDO_TITLE)).toBeDisabled();

      act(() => void builderStore().duplicateNode(componentNamed("processors.batch", "traces").id));
      const changed = builderStore().text;
      expect(button(UNDO_TITLE)).toBeEnabled();

      await user.click(button(UNDO_TITLE));
      expect(builderStore().text).toBe(STARTER);
      expect(toast.info).toHaveBeenCalledWith("Undo: Duplicate Batch", { className: "ph-no-capture" });
      expect(button(UNDO_TITLE)).toBeDisabled();
      expect(button(REDO_TITLE)).toBeEnabled();

      await user.click(button(REDO_TITLE));
      expect(builderStore().text).toBe(changed);
      expect(toast.info).toHaveBeenCalledWith("Redo: Duplicate Batch", { className: "ph-no-capture" });
      expect(button(REDO_TITLE)).toBeDisabled();
    });

    it("are disabled in manual edit mode", async () => {
      await renderToolbar();
      const batch = componentNamed("processors.batch", "traces");
      act(() => void builderStore().duplicateNode(batch.id));
      act(() => void builderStore().duplicateNode(batch.id));
      act(() => void builderStore().undo());
      expect(button(UNDO_TITLE)).toBeEnabled();
      expect(button(REDO_TITLE)).toBeEnabled();

      enterManualEditMode();

      expect(button(UNDO_TITLE)).toBeDisabled();
      expect(button(REDO_TITLE)).toBeDisabled();
    });

    it("follow the store, not the canvas's lock: Redo is enabled over text the canvas can't show", async () => {
      const unreadable = "receivers: [\n";
      const user = await renderToolbar(unreadable);
      expect(builderStore().graphStatus).not.toBe("ready");
      // Typed into readable text and applied: undo brings the unreadable text back.
      act(() => builderStore().setText(STARTER));
      act(() => void builderStore().apply());
      act(() => void builderStore().undo());
      expect(builderStore().text).toBe(unreadable);
      expect(builderStore().graphStatus).not.toBe("ready");
      expect(builderStore().isYamlEditing).toBe(false);

      expect(button(REDO_TITLE)).toBeEnabled();
      expect(button(UNDO_TITLE)).toBeDisabled();

      await user.click(button(REDO_TITLE));
      expect(builderStore().text).toBe(STARTER);
      expect(builderStore().graphStatus).toBe("ready");
      expect(button(UNDO_TITLE)).toBeEnabled();
    });

    it("bring their shortcuts: Ctrl+Z undoes outside a field", async () => {
      await renderToolbar();
      act(() => void builderStore().duplicateNode(componentNamed("processors.batch", "traces").id));

      fireEvent.keyDown(window, { key: "z", ctrlKey: true, metaKey: true });

      expect(builderStore().text).toBe(STARTER);
    });
  });

  describe("Duplicate", () => {
    it("is disabled with nothing selected, with a pipeline group selected, and while locked", async () => {
      await renderToolbar();
      expect(button(DUPLICATE_TITLE)).toBeDisabled();

      select(groupNamed("traces").id);
      expect(button(DUPLICATE_TITLE)).toBeDisabled();

      select(componentNamed("processors.batch", "traces").id);
      expect(button(DUPLICATE_TITLE)).toBeEnabled();

      enterManualEditMode();
      expect(button(DUPLICATE_TITLE)).toBeDisabled();
    });

    it("duplicates an extension or a connector in place, with its toast", async () => {
      const user = await renderToolbar();
      select(componentNamed("extensions.health_check").id);

      await user.click(button(DUPLICATE_TITLE));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(builderStore().text).toContain("  health_check/2:\n");
      expect(toast.success).toHaveBeenCalledWith('Duplicated "Health Check"', { className: "ph-no-capture" });
    });

    it("duplicates a multi-selection in place", async () => {
      const user = await renderToolbar();
      act(() =>
        builderStore().setSelection([
          componentNamed("processors.batch", "traces").id,
          componentNamed("exporters.otlp", "traces").id,
        ]),
      );

      await user.click(button(DUPLICATE_TITLE));

      expect(componentsIn(groupNamed("traces"))).toEqual([
        "exporters.otlp",
        "exporters.otlp/2",
        "processors.batch",
        "processors.batch/2",
        "receivers.otlp",
      ]);
      expect(toast.success).toHaveBeenCalledWith("Duplicated 2 nodes");
      expect(selectUndoDescription(builderStore())).toBe("Duplicate 2 nodes");
    });

    it("opens the dialog for a processor, and copies it into the chosen pipeline, selecting the copy", async () => {
      const user = await renderToolbar();
      select(componentNamed("processors.batch", "traces").id);

      await user.click(button(DUPLICATE_TITLE));
      expect(screen.getByRole("heading", { name: "Duplicate “Batch”" })).toBeInTheDocument();
      await user.click(screen.getAllByRole("combobox")[0]!);
      await user.click(await screen.findByRole("option", { name: "logs" }));
      await user.click(screen.getByRole("button", { name: "Duplicate" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(componentsIn(groupNamed("logs"))).toContain("processors.batch/2");
      // Declared; the pipeline lists it once it's connected.
      expect(builderStore().text).toContain("  batch/2:\n    timeout: 10s\n    send_batch_size: 1024\n");
      expect(toast.success).toHaveBeenCalledWith('Duplicated "Batch"', { className: "ph-no-capture" });
      const selected = builderStore().selectedNode!;
      expect(componentKey(selected.data)).toBe("processors.batch/2");
      expect(selected.parentId).toBe(groupNamed("logs").id);
    });

    it("links a receiver into another pipeline as the same component, selecting the new node", async () => {
      const user = await renderToolbar();
      act(() => void builderStore().addPipeline("traces/extra"));
      select(componentNamed("receivers.otlp", "traces").id);

      await user.click(button(DUPLICATE_TITLE));
      await user.click(screen.getAllByRole("combobox")[1]!);
      await user.click(await screen.findByRole("option", { name: "traces/extra" }));
      await user.click(screen.getByRole("button", { name: "Link" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(pipelineList(builderStore().text, "traces/extra", "receivers")).toEqual(["otlp"]);
      // Still one entry in the text.
      expect(builderStore().text.match(/^ {2}otlp:$/gm)).toHaveLength(2); // the receiver and the exporter
      expect(toast.success).toHaveBeenCalledWith("Linked to pipeline");
      expect(builderStore().selectedNode?.parentId).toBe(groupNamed("traces/extra").id);
    });
  });

  describe("Delete", () => {
    it("is disabled with no component selected (a group alone included) and while locked", async () => {
      await renderToolbar();
      expect(button(DELETE_TITLE)).toBeDisabled();

      select(groupNamed("traces").id);
      expect(button(DELETE_TITLE)).toBeDisabled();

      select(componentNamed("processors.batch", "traces").id);
      expect(button(DELETE_TITLE)).toBeEnabled();

      enterManualEditMode();
      expect(button(DELETE_TITLE)).toBeDisabled();
    });

    it("asks through the one delete dialog; Cancel deletes nothing, Delete deletes with its toast", async () => {
      const user = await renderToolbar();
      const batch = componentNamed("processors.batch", "traces");
      select(batch.id);

      await user.click(button(DELETE_TITLE));
      expect(screen.getByRole("alertdialog")).toHaveTextContent('Delete "Batch"?');
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(builderStore().graph.nodes.some((n) => n.id === batch.id)).toBe(true);

      await user.click(button(DELETE_TITLE));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));

      expect(builderStore().graph.nodes.some((n) => n.id === batch.id)).toBe(false);
      expect(pipelineList(builderStore().text, "traces", "processors")).toEqual([]);
      expect(toast.success).toHaveBeenCalledWith("Deleted 1 node");
    });

    it("asks about the whole multi-selection", async () => {
      const user = await renderToolbar();
      act(() =>
        builderStore().setSelection([
          componentNamed("processors.batch", "traces").id,
          componentNamed("exporters.otlp", "traces").id,
        ]),
      );

      await user.click(button(DELETE_TITLE));

      expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete 2 selected nodes?");
    });
  });

  it("puts no label or undo description in any attribute", async () => {
    const LABEL = "zq-label-marker";
    const user = await renderToolbar();
    // A label a person could give, so the undo description names it too.
    const batch = componentNamed("processors.batch", "traces");
    useEditorStore.setState({
      graph: {
        ...builderStore().graph,
        nodes: builderStore().graph.nodes.map((n) => (n.id === batch.id ? { ...n, data: { ...n.data, label: LABEL } } : n)),
      },
    });
    act(() => void builderStore().duplicateNode(batch.id));
    act(() => void builderStore().duplicateNode(batch.id));
    act(() => void builderStore().undo());
    select(batch.id);
    // Both an undo and a redo are waiting, each naming the label.
    expect(selectUndoDescription(builderStore())).toBe(`Duplicate ${LABEL}`);
    expect(builderStore().history.future.at(-1)?.description).toBe(`Duplicate ${LABEL}`);
    expect(button(UNDO_TITLE)).toBeEnabled();
    expect(button(REDO_TITLE)).toBeEnabled();
    expect(button(DELETE_TITLE)).toBeEnabled();

    // The dialog open for the node too.
    await user.click(button(DUPLICATE_TITLE));
    expect(screen.getByRole("heading", { name: `Duplicate “${LABEL}”` })).toBeInTheDocument();

    const leaks: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (attribute.value.includes(LABEL)) leaks.push(`${element.tagName}[${attribute.name}]`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
