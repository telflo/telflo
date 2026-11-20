import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { CanvasActions } from "./CanvasActions.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { getDefaultPipelines } from "~/lib/graph/node-builders.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, groupNamed, openText } from "~/test/builder-store.js";

/*
 * The CanvasActions tests, with self-monitoring's two, and the lock. The
 * Self-monitoring dialog's own tests are in `SelfMonitoringDialog.test.tsx`.
 */

const STARTER = corpusText("starter.yaml");
const SELF_MONITORING = "Collector self-monitoring (service::telemetry)";
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

const components = () => builderStore().graph.nodes.filter((n) => n.type !== "pipelineGroup");

describe("CanvasActions", () => {
  it("renders all four canvas actions", () => {
    openText(STARTER);
    render(<CanvasActions />);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Add pipeline",
      SELF_MONITORING,
      "Tidy up layout",
      "Clear canvas",
    ]);
    expect(screen.getByRole("button", { name: /add pipeline/i })).toHaveAttribute("title", "Add new pipeline");
    expect(screen.getByRole("button", { name: /self-monitoring/i })).toHaveAttribute("title", SELF_MONITORING);
    expect(screen.getByRole("button", { name: /self-monitoring/i }).querySelector("svg.lucide-activity")).not.toBeNull();
    expect(screen.getByRole("button", { name: /tidy up/i })).toHaveAttribute(
      "title",
      "Tidy up layout (auto-arrange every node)",
    );
    expect(screen.getByRole("button", { name: /clear canvas/i })).toHaveAttribute("title", "Clear canvas");
  });

  it("marks self-monitoring as configured only when service telemetry exists", () => {
    openText(STARTER);
    const { unmount } = render(<CanvasActions />);
    const action = () => screen.getByRole("button", { name: /self-monitoring/i });
    expect(action()).not.toHaveAttribute("data-configured", "true");
    expect(action()).toHaveAttribute("data-configured", "false");
    expect(action().querySelector("span.bg-ok")).toBeNull();

    act(() => {
      builderStore().setTelemetryValues([{ path: ["logs", "level"], value: "info" }]);
    });
    expect(action()).toHaveAttribute("data-configured", "true");
    expect(action().querySelector("span.bg-ok")).toHaveAttribute("aria-hidden", "true");
    unmount();

    // Read through aliases and merges; an explicit null isn't configured.
    const cases: Array<[string, "true" | "false"]> = [
      ["x-telemetry: &telemetry\n  logs:\n    level: info\nservice:\n  telemetry: *telemetry\n  pipelines: {}\n", "true"],
      ["x-base: &base\n  telemetry: {}\nservice:\n  <<: *base\n  pipelines: {}\n", "true"],
      ["service:\n  telemetry:\n  pipelines: {}\n", "false"],
      ["service:\n  telemetry: ~\n  pipelines: {}\n", "false"],
      ["service:\n  telemetry: 5\n  pipelines: {}\n", "true"],
    ];
    for (const [yaml, configured] of cases) {
      openText(yaml);
      const view = render(<CanvasActions />);
      expect(action()).toHaveAttribute("data-configured", configured);
      view.unmount();
    }
  });

  it("tidies the layout: overlapping nodes move apart, the change is tracked, the text is untouched", async () => {
    const user = userEvent.setup();
    openText(STARTER);
    const traces = groupNamed("traces");
    // Every component of the traces pipeline piled on one spot, and saved so.
    useEditorStore.setState({
      graph: {
        ...builderStore().graph,
        nodes: builderStore().graph.nodes.map((n) => (n.parentId === traces.id ? { ...n, position: { x: 40, y: 40 } } : n)),
      },
    });
    const { text, version, graph } = builderStore();
    builderStore().markSaved(text, version!, graph);
    expect(selectIsDirty(builderStore())).toBe(false);
    render(<CanvasActions />);

    await user.click(screen.getByRole("button", { name: /tidy up/i }));

    const piled = builderStore().graph.nodes.filter((n) => n.parentId === traces.id);
    expect(new Set(piled.map((n) => `${n.position.x},${n.position.y}`)).size).toBe(piled.length);
    expect(selectIsDirty(builderStore())).toBe(true);
    expect(builderStore().text).toBe(STARTER);
    expect(builderStore().layoutRevision).toBe(1);
    expect(toast.success).toHaveBeenCalledWith("Layout tidied", {
      description: "Undo with Ctrl/Cmd+Z to restore the previous positions.",
    });

    let undone = false;
    act(() => {
      undone = builderStore().undo();
    });
    expect(undone).toBe(true);
    expect(builderStore().graph.nodes.filter((n) => n.parentId === traces.id).map((n) => n.position)).toEqual(
      piled.map(() => ({ x: 40, y: 40 })),
    );
  });

  it("confirms before clearing: the canvas survives an accidental click, and Cancel keeps it", async () => {
    const user = userEvent.setup();
    openText(STARTER);
    const before = components().length;
    render(<CanvasActions />);

    await user.click(screen.getByRole("button", { name: /clear canvas/i }));

    const dialog = await screen.findByRole("alertdialog", { name: "Clear Canvas" });
    expect(dialog).toHaveAccessibleDescription(
      "Are you sure you want to clear the canvas? This will remove all nodes, connections, and YAML content. Your saved configuration will not be deleted, but all current changes will be lost.",
    );
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Clear"]);
    expect(components()).toHaveLength(before);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(components()).toHaveLength(before);
    expect(builderStore().text).toBe(STARTER);
  });

  it("clears the canvas once the confirmation is accepted, keeping service.telemetry, as one undo entry", async () => {
    const user = userEvent.setup();
    const TELEMETRY = corpusText("service-telemetry.yaml");
    openText(TELEMETRY);
    render(<CanvasActions />);

    await user.click(screen.getByRole("button", { name: /clear canvas/i }));
    await user.click(await screen.findByRole("button", { name: "Clear" }));

    expect(components()).toHaveLength(0);
    expect(builderStore().graph.pipelines.map((p) => p.name)).toEqual(getDefaultPipelines().map((p) => p.name));
    const written = parseYaml(builderStore().text) as Record<string, unknown> & { service: Record<string, unknown> };
    expect(written.receivers).toBeUndefined();
    expect(written.exporters).toBeUndefined();
    expect(written.service.telemetry).toEqual((parseYaml(TELEMETRY) as { service: { telemetry: unknown } }).service.telemetry);
    expect(selectIsDirty(builderStore())).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Canvas cleared");

    let undone = false;
    act(() => {
      undone = builderStore().undo();
    });
    expect(undone).toBe(true);
    expect(builderStore().text).toBe(TELEMETRY);
    expect(components().length).toBeGreaterThan(0);
  });

  it("opens the add-pipeline dialog", async () => {
    const user = userEvent.setup();
    openText(STARTER);
    render(<CanvasActions />);

    await user.click(screen.getByRole("button", { name: /add pipeline/i }));

    expect(await screen.findByRole("dialog", { name: "Add New Pipeline" })).toBeInTheDocument();
  });

  it("disables every action in manual edit mode, and while the text can't be shown", () => {
    openText(STARTER);
    builderStore().setText(`${STARTER}# typing\n`);
    const { unmount } = render(<CanvasActions />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: SELF_MONITORING })).toBeDisabled();
    unmount();

    openText("receivers:\n  otlp: {}\n  otlp: {}\n");
    expect(builderStore().graphStatus).not.toBe("ready");
    render(<CanvasActions />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});
