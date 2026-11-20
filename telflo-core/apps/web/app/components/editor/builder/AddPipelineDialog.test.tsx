import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  AddPipelineDialog,
  DUPLICATE_NAME_MESSAGE,
  EMPTY_NAME_MESSAGE,
  INVALID_NAME_MESSAGE,
} from "./AddPipelineDialog.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { CUSTOM_PIPELINE_COLORS } from "~/lib/graph/node-builders.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, groupNamed, openText } from "~/test/builder-store.js";

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  openText(STARTER);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderDialog() {
  const onOpenChange = vi.fn();
  render(<AddPipelineDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange, user: userEvent.setup() };
}

const pipelineNames = (text: string) =>
  Object.keys((parseYaml(text) as { service: { pipelines: Record<string, unknown> } }).service.pipelines);

describe("AddPipelineDialog", () => {
  it("has its copy", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Add New Pipeline" });
    expect(dialog).toHaveAccessibleDescription("Create a new named pipeline for your OpenTelemetry configuration.");
    const input = within(dialog).getByLabelText("Pipeline Name");
    expect(input).toHaveAttribute("placeholder", "traces/production");
    expect(input).toHaveFocus();
    expect(within(dialog).getByText(/^Format:/)).toHaveTextContent("Format: traces, traces/production, metrics/high-priority");
    expect(within(dialog).queryByText("Detected Signal Type")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create Pipeline" })).toBeInTheDocument();
  });

  it.each([
    ["nothing", "", EMPTY_NAME_MESSAGE],
    ["spaces", "   ", EMPTY_NAME_MESSAGE],
    ["another signal", "profiles", INVALID_NAME_MESSAGE],
    ["a bad name", "traces/prod_1", INVALID_NAME_MESSAGE],
    ["an empty name", "traces/", INVALID_NAME_MESSAGE],
    ["a name in use", "traces", DUPLICATE_NAME_MESSAGE],
  ])("refuses %s with its toast, changing nothing", async (_what, typed, message) => {
    const { user, onOpenChange } = renderDialog();
    const input = await screen.findByLabelText("Pipeline Name");
    if (typed) await user.type(input, typed);

    await user.click(screen.getByRole("button", { name: "Create Pipeline" }));

    expect(toast.error).toHaveBeenCalledWith(message);
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(builderStore().text).toBe(STARTER);
    expect(builderStore().history.past).toHaveLength(0);
  });

  it("lowercases what's typed and shows the signal it detects", async () => {
    const { user } = renderDialog();
    const input = await screen.findByLabelText("Pipeline Name");

    await user.type(input, "Metrics/High-Priority");

    expect(input).toHaveValue("metrics/high-priority");
    expect(screen.getByText("Detected Signal Type")).toBeInTheDocument();
    expect(screen.getByText("metrics", { selector: "div" })).toHaveClass("uppercase");
    await user.clear(input);
    await user.type(input, "foo");
    // The badge says traces for any other prefix.
    expect(screen.getByText("traces", { selector: "div" })).toHaveClass("uppercase");
  });

  it("creates the pipeline in the text with the first unused color, toasts, closes, and can be undone", async () => {
    const { user, onOpenChange } = renderDialog();
    const input = await screen.findByLabelText("Pipeline Name");

    await user.type(input, "  Logs/Audit  {Enter}");

    expect(toast.success).toHaveBeenCalledWith('Pipeline "logs/audit" created', { className: "ph-no-capture" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(input).toHaveValue("");
    expect(pipelineNames(builderStore().text)).toEqual(["traces", "metrics", "logs", "logs/audit"]);
    const pipeline = builderStore().graph.pipelines.find((p) => p.name === "logs/audit")!;
    expect(pipeline).toMatchObject({ signalType: "logs" });
    expect(pipeline.id).toMatch(/^pipeline_\d+$/);
    // The starter uses orange, blue and slate: the first unused is violet.
    expect(CUSTOM_PIPELINE_COLORS.slice(0, 3)).toEqual(builderStore().graph.pipelines.slice(0, 3).map((p) => p.color));
    expect(pipeline.color).toBe(CUSTOM_PIPELINE_COLORS[3]);
    expect(groupNamed("logs/audit").data.color).toBe(CUSTOM_PIPELINE_COLORS[3]);
    expect(builderStore().history.past.map((e) => e.description)).toEqual(["Add pipeline logs/audit"]);

    expect(builderStore().undo()).toBe(true);
    expect(builderStore().text).toBe(STARTER);
    expect(builderStore().graph.pipelines.map((p) => p.name)).toEqual(["traces", "metrics", "logs"]);
  });

  it("creates with the button too; Cancel closes and keeps what was typed", async () => {
    const { user, onOpenChange } = renderDialog();
    const input = await screen.findByLabelText("Pipeline Name");
    await user.type(input, "traces/b");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(input).toHaveValue("traces/b");
    expect(builderStore().text).toBe(STARTER);

    await user.click(screen.getByRole("button", { name: "Create Pipeline" }));
    expect(toast.success).toHaveBeenCalledWith('Pipeline "traces/b" created', { className: "ph-no-capture" });
  });

  it("stays open with the name when the store refuses (the canvas locked)", async () => {
    const { user, onOpenChange } = renderDialog();
    const input = await screen.findByLabelText("Pipeline Name");
    await user.type(input, "traces/b");
    builderStore().setText(`${STARTER}# typing\n`);

    await user.click(screen.getByRole("button", { name: "Create Pipeline" }));

    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("traces/b");
  });
});
