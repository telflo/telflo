import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuplicateNodeDialog } from "./DuplicateNodeDialog.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, groupNamed, openText } from "~/test/builder-store.js";

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

function renderDialog(nodeId: string) {
  const onOpenChange = vi.fn();
  const onDuplicate = vi.fn();
  const onLink = vi.fn();
  render(
    <DuplicateNodeDialog open onOpenChange={onOpenChange} nodeId={nodeId} onDuplicate={onDuplicate} onLink={onLink} />,
  );
  return { onOpenChange, onDuplicate, onLink, user: userEvent.setup() };
}

async function choose(user: ReturnType<typeof userEvent.setup>, combobox: HTMLElement, option: string) {
  await user.click(combobox);
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("DuplicateNodeDialog", () => {
  it("shows its copy: the title with the label in curly quotes, both sections and the divider", () => {
    openText(STARTER);
    renderDialog(componentNamed("processors.batch", "traces").id);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("sm:max-w-[440px]");
    expect(screen.getByRole("heading", { name: "Duplicate “Batch”" })).toBeInTheDocument();
    expect(screen.getByText("Create an independent copy or link to an existing instance.")).toBeInTheDocument();
    expect(screen.getByText("Duplicate (Independent Copy)")).toBeInTheDocument();
    expect(screen.getByText("or")).toBeInTheDocument();
    expect(screen.getByText("Link to Instance")).toBeInTheDocument();
    expect(screen.getByText("One YAML definition shared across multiple pipelines.")).toBeInTheDocument();
    expect(screen.getByText("Instance")).toBeInTheDocument();
    expect(screen.getByText("Select pipeline...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it('falls back to "Node" in the title for a node that is gone', () => {
    openText(STARTER);
    renderDialog("node_999");
    expect(screen.getByRole("heading", { name: "Duplicate “Node”" })).toBeInTheDocument();
  });

  it("copies into the chosen pipeline, from every pipeline, the node's own included", async () => {
    openText(STARTER);
    const { onDuplicate, onOpenChange, user } = renderDialog(componentNamed("processors.batch", "traces").id);
    const [pipelines] = screen.getAllByRole("combobox");

    await user.click(pipelines!);
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["traces", "metrics", "logs"]);
    await user.click(screen.getByRole("option", { name: "logs" }));
    await user.click(screen.getByRole("button", { name: "Duplicate" }));

    expect(onDuplicate).toHaveBeenCalledWith(groupNamed("logs").id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("links to the one instance, auto-resolved, into a pipeline that lacks it", async () => {
    openText(STARTER);
    act(() => void builderStore().addPipeline("traces/extra"));
    const batch = componentNamed("processors.batch", "traces");
    const { onLink, onOpenChange, user } = renderDialog(batch.id);

    // One instance: shown with the pipelines it is in, no picker.
    expect(screen.getByText("batch")).toBeInTheDocument();
    expect(screen.getByText("(traces, metrics, logs)")).toBeInTheDocument();
    expect(screen.getByText("Add to Pipeline")).toBeInTheDocument();
    const link = screen.getByRole("button", { name: "Link" });
    expect(link).toBeDisabled();

    const [, eligible] = screen.getAllByRole("combobox");
    await user.click(eligible!);
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["traces/extra"]);
    await user.click(screen.getByRole("option", { name: "traces/extra" }));
    await user.click(link);

    expect(onLink).toHaveBeenCalledWith(batch.id, groupNamed("traces/extra").id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("picks among several instances, as the text names them, and offers the pipelines each lacks", async () => {
    openText(STARTER);
    const batch = componentNamed("processors.batch", "traces");
    act(() => void builderStore().duplicateNode(batch.id, groupNamed("logs").id));
    const { onLink, user } = renderDialog(batch.id);

    expect(screen.queryByText("Add to Pipeline")).toBeNull();
    const [, instances] = screen.getAllByRole("combobox");
    expect(instances).toHaveTextContent("Select instance...");
    await user.click(instances!);
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "batch(traces, metrics, logs)",
      "batch/2(logs)",
    ]);
    await user.click(screen.getByRole("option", { name: "batch/2 (logs)" }));

    const [, , eligible] = screen.getAllByRole("combobox");
    await choose(user, eligible!, "metrics");
    await user.click(screen.getByRole("button", { name: "Link" }));

    expect(onLink).toHaveBeenCalledWith(componentNamed("processors.batch/2").id, groupNamed("metrics").id);
  });

  it("says so when the instance is already in every pipeline", () => {
    openText(STARTER);
    renderDialog(componentNamed("processors.batch", "traces").id);

    const empty = screen.getByText("This instance already exists in all pipeline groups.");
    expect(empty).toHaveClass("italic");
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
  });

  it("counts a pipeline as having the instance only for the same type: an otlp exporter doesn't hide the otlp receiver's", () => {
    openText(
      "receivers:\n  otlp: {}\nexporters:\n  otlp: {}\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n    metrics:\n      receivers: [otlp]\n      exporters: [otlp]\n    logs:\n      receivers: [otlp]\n      exporters: [debug]\n",
    );
    renderDialog(componentNamed("exporters.otlp").id);

    // The exporter is in metrics only; the receiver named otlp in traces and logs doesn't count.
    expect(screen.queryByText("This instance already exists in all pipeline groups.")).toBeNull();
    expect(screen.getByText("(metrics)")).toBeInTheDocument();
  });

  it("closes on Cancel and forgets the choice", async () => {
    openText(STARTER);
    const batch = componentNamed("processors.batch", "traces");
    const onOpenChange = vi.fn();
    const props = { nodeId: batch.id, onOpenChange, onDuplicate: vi.fn(), onLink: vi.fn() };
    const { rerender } = render(<DuplicateNodeDialog open {...props} />);
    const user = userEvent.setup();
    await choose(user, screen.getAllByRole("combobox")[0]!, "logs");
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<DuplicateNodeDialog open={false} {...props} />);
    rerender(<DuplicateNodeDialog open {...props} />);

    expect(screen.getByRole("button", { name: "Duplicate" })).toBeDisabled();
    expect(props.onDuplicate).not.toHaveBeenCalled();
  });

  it("closes on Escape through onOpenChange, and forgets the choice", async () => {
    openText(STARTER);
    const { onOpenChange, user } = renderDialog(componentNamed("processors.batch", "traces").id);
    await choose(user, screen.getAllByRole("combobox")[0]!, "metrics");

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeDisabled();
  });
});
