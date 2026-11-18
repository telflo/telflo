import { act, render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { FormProvider, UNSHOWABLE_VALUE_MESSAGE, useComponentForm } from "../form-context.js";
import { NOT_FOUND_OPTION, PipelineListField, type PipelineListFieldProps } from "./PipelineListField.js";
import { readTextModel } from "~/lib/graph/model.js";
import { connectorPipelineOptions } from "~/lib/graph/routing-connector.js";
import { componentValueText } from "~/lib/graph/text-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, openText } from "~/test/builder-store.js";

/*
 * PipelineListField (D9d Task 3; decision 8; Preflight ruling 12):
 * a pipeline multi-select over a list path. Rows show the text's
 * names (an ineligible one as written, one not on the canvas "(not found)"),
 * choosing writes the item (and the store wires the receiver), Add holds a
 * row until a pipeline is chosen, and no pipeline name reaches an attribute.
 */

const TEXT = `receivers:
  otlp:
exporters:
  debug:
connectors:
  routing:
    default_pipelines: [traces/out, logs/other, traces/gone] # defaults
    table:
      - condition: 'true'
        pipelines: [traces/a]
      - condition: 'false'
        pipelines: [{name: traces/a}]
service:
  pipelines:
    traces/in:
      receivers: [otlp]
      exporters: [routing]
    traces/out:
      receivers: [routing]
      exporters: [debug]
    traces/a:
      receivers: [routing]
      exporters: [debug]
    traces/b:
      receivers: [otlp]
      exporters: [debug]
    logs/other:
      receivers: [otlp]
      exporters: [debug]
`;

const NAMES = ["traces/in", "traces/out", "traces/a", "traces/b", "logs/other", "traces/gone"];

const initialState = useEditorStore.getState();

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The field with the routing connector's options, read from the store as a form would. */
function Field(props: Omit<PipelineListFieldProps, "options" | "id" | "label"> & { label?: string; options?: PipelineListFieldProps["options"] }) {
  const document = useEditorStore((state) => state.document);
  const pipelines = useEditorStore((state) => state.graph.pipelines);
  const options = props.options ?? (document === null ? [] : connectorPipelineOptions(readTextModel(document), pipelines, "routing"));
  const label = props.label ?? "Default Pipelines";
  return <PipelineListField id={label === "Default Pipelines" ? "routing-defaults" : "routing-targets"} label={label} {...props} options={options} />;
}

function ComponentForm({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const form = useComponentForm(nodeId);
  return <FormProvider form={form}>{children}</FormProvider>;
}

function renderField(children: ReactNode, text = TEXT) {
  openText(text);
  return render(<ComponentForm nodeId={componentNamed("connectors.routing").id}>{children}</ComponentForm>);
}

const text = () => builderStore().text;
const routing = () => (parseYaml(text()) as { connectors: { routing: Record<string, unknown> } }).connectors.routing;
const receiversOf = (name: string) =>
  (parseYaml(text()) as { service: { pipelines: Record<string, { receivers: string[] }> } }).service.pipelines[name]!.receivers;
const rows = () => screen.getAllByRole("combobox", { name: "Default Pipelines" });
const addButton = () => screen.getByRole("button", { name: "Add Pipeline" });

async function optionsOf(user: UserEvent, row: HTMLElement): Promise<string[]> {
  await user.click(row);
  const shown = screen.getAllByRole("option").map((option) => option.textContent ?? "");
  await user.keyboard("{Escape}");
  return shown;
}

async function choose(user: UserEvent, row: HTMLElement, name: string) {
  await user.click(row);
  await user.click(screen.getByRole("option", { name }));
}

/** No attribute anywhere on the page holds a pipeline name (decision 13). */
function expectNoNameInAttributes() {
  for (const element of document.body.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      for (const name of NAMES) expect(attribute.value.includes(name), `${attribute.name}="${attribute.value}"`).toBe(false);
    }
  }
}

describe("PipelineListField (D9d Task 3)", () => {
  it("shows each row as written: an ineligible pipeline as it is, one not on the canvas as (not found)", async () => {
    const user = userEvent.setup();
    renderField(<Field path={["default_pipelines"]} />);

    expect(rows().map((row) => row.textContent)).toEqual(["traces/out", "logs/other", "traces/gone (not found)"]);
    expect(rows()[2]).toHaveClass("text-fail");
    expect(rows()[1]).not.toHaveClass("text-fail");
    expect(rows().map((row) => row.id)).toEqual(["routing-defaults-0", "routing-defaults-1", "routing-defaults-2"]);

    // A row offers its own value and the eligible pipelines the other rows don't hold (not the source, not logs).
    expect(await optionsOf(user, rows()[0]!)).toEqual(["traces/out", "traces/a", "traces/b"]);
    expect(await optionsOf(user, rows()[1]!)).toEqual(["logs/other", "traces/a", "traces/b"]);
    expect(await optionsOf(user, rows()[2]!)).toEqual(["traces/gone (not found)", "traces/a", "traces/b"]);
    expect(screen.getByText("Default Pipelines")).toBeInTheDocument();
  });

  it("puts no pipeline name in any attribute or option value, for an ineligible and a stale value too (Preflight ruling 12)", async () => {
    const user = userEvent.setup();
    renderField(<Field path={["default_pipelines"]} />);
    expectNoNameInAttributes();

    // Each row open, its items shown: the eligible, the ineligible own value, the stale one.
    for (const row of [0, 1, 2]) {
      await user.click(rows()[row]!);
      expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
      expectNoNameInAttributes();
      await user.keyboard("{Escape}");
    }
    // A held row, open.
    await user.click(addButton());
    await user.click(rows()[3]!);
    expectNoNameInAttributes();
  });

  it("its items' values are index tokens over the canvas's pipelines, the same in every row, or not-found", () => {
    // Radix keeps item values out of the page; inside a <form> (never in the
    // app) it renders a native select whose options show them.
    openText(TEXT);
    const { container } = render(
      <form>
        <ComponentForm nodeId={componentNamed("connectors.routing").id}>
          <Field path={["default_pipelines"]} />
        </ComponentForm>
      </form>,
    );
    const canvas = builderStore().graph.pipelines.map((p) => p.name);
    const tokenOf = (name: string) => `pipeline-${canvas.indexOf(name)}`;
    const natives = [...container.querySelectorAll("select")];
    expect(natives.map((select) => select.value)).toEqual([tokenOf("traces/out"), tokenOf("logs/other"), NOT_FOUND_OPTION]);
    expect(natives.map((select) => [...select.options].map((option) => option.value).filter((value) => value !== ""))).toEqual([
      [tokenOf("traces/out"), tokenOf("traces/a"), tokenOf("traces/b")],
      [tokenOf("logs/other"), tokenOf("traces/a"), tokenOf("traces/b")],
      [NOT_FOUND_OPTION, tokenOf("traces/a"), tokenOf("traces/b")],
    ]);
    expectNoNameInAttributes();
  });

  it("choosing a pipeline writes the item, and the store wires its receiver, in one entry", async () => {
    const user = userEvent.setup();
    renderField(<Field path={["default_pipelines"]} />);
    const before = builderStore().history.past.length;

    await choose(user, rows()[2]!, "traces/b");

    expect(routing().default_pipelines).toEqual(["traces/out", "logs/other", "traces/b"]);
    expect(text()).toContain("    default_pipelines: [traces/out, logs/other, traces/b] # defaults\n");
    expect(receiversOf("traces/b")).toEqual(["otlp", "routing"]);
    expect(builderStore().history.past).toHaveLength(before + 1);
    // Inside ph-no-capture: it names a pipeline (Ruling 301).
    expect(toast.info).toHaveBeenCalledWith("Added routing to the receivers of traces/b.", { className: "ph-no-capture" });
    expect(rows().map((row) => row.textContent)).toEqual(["traces/out", "logs/other", "traces/b"]);
  });

  it("Add holds a row until a pipeline is chosen; its Remove writes nothing; Add is disabled while it is held", async () => {
    const user = userEvent.setup();
    renderField(<Field path={["default_pipelines"]} />);

    await user.click(addButton());
    expect(text()).toBe(TEXT);
    expect(rows()).toHaveLength(4);
    expect(rows()[3]).toHaveTextContent("Select pipeline");
    expect(addButton()).toBeDisabled();
    expect(await optionsOf(user, rows()[3]!)).toEqual(["traces/a", "traces/b"]);

    await user.click(screen.getAllByRole("button", { name: "Remove pipeline" })[3]!);
    expect(rows()).toHaveLength(3);
    expect(text()).toBe(TEXT);
    expect(addButton()).toBeEnabled();

    await user.click(addButton());
    await choose(user, rows()[3]!, "traces/a");
    expect(routing().default_pipelines).toEqual(["traces/out", "logs/other", "traces/gone", "traces/a"]);
    // traces/a already lists routing: nothing to wire, no toast.
    expect(receiversOf("traces/a")).toEqual(["routing"]);
    expect(toast.info).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(4);
    expect(rows()[3]).toHaveTextContent("traces/a");
  });

  /*
   * D9d Ruling 33a: the held row belongs to its list's length. This test
   * replaces 7be9be6's "a held row stays through a write elsewhere in the
   * form, and goes when its own list changes, its length kept", whose last
   * case (another row chosen anew) now keeps it.
   */
  it("a held row stays through another row chosen anew, a write elsewhere and their undo; it goes when its list's length changes (a Remove, an undo, the YAML box)", async () => {
    const user = userEvent.setup();
    renderField(
      <>
        <Field path={["default_pipelines"]} />
        <Field path={["table", 0, "pipelines"]} label="Target Pipelines" addButtonText="Add Target" />
      </>,
    );
    await user.click(addButton());
    expect(rows()).toHaveLength(4);

    // Another list of the same form: the held row stays.
    await choose(user, screen.getByRole("combobox", { name: "Target Pipelines" }), "traces/b");
    expect((routing().table as Array<{ pipelines: string[] }>)[0]!.pipelines).toEqual(["traces/b"]);
    expect(rows()).toHaveLength(4);
    expect(rows()[3]).toHaveTextContent("Select pipeline");

    // Another row of its own list chosen anew, and that undone (the same length): it stays.
    await choose(user, rows()[0]!, "traces/b");
    expect(routing().default_pipelines).toEqual(["traces/b", "logs/other", "traces/gone"]);
    expect(rows()).toHaveLength(4);
    expect(rows()[3]).toHaveTextContent("Select pipeline");
    act(() => builderStore().undo());
    expect(routing().default_pipelines).toEqual(["traces/out", "logs/other", "traces/gone"]);
    expect(rows()).toHaveLength(4);
    expect(addButton()).toBeDisabled();

    // Another row removed: it goes.
    await user.click(screen.getAllByRole("button", { name: "Remove pipeline" })[1]!);
    expect(routing().default_pipelines).toEqual(["traces/out", "traces/gone"]);
    expect(rows()).toHaveLength(2);
    expect(addButton()).toBeEnabled();

    // Held again, and that removal undone: it goes.
    await user.click(addButton());
    expect(rows()).toHaveLength(3);
    act(() => builderStore().undo());
    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => row.textContent)).toEqual(["traces/out", "logs/other", "traces/gone (not found)"]);

    // Held again, and the YAML box adding an item: it goes.
    await user.click(addButton());
    const nodeId = componentNamed("connectors.routing").id;
    act(() => {
      builderStore().setComponentValue(
        nodeId,
        componentValueText(text(), "connectors.routing").replace("[traces/out, logs/other, traces/gone]", "[traces/out, logs/other, traces/gone, traces/a]"),
      );
    });
    expect(routing().default_pipelines).toEqual(["traces/out", "logs/other", "traces/gone", "traces/a"]);
    expect(rows()).toHaveLength(4);
    expect(rows()[3]).toHaveTextContent("traces/a");
    expect(addButton()).toBeEnabled();
  });

  it("a held row in a list the text doesn't have yet writes the list", async () => {
    const user = userEvent.setup();
    renderField(<Field path={["missing"]} label="Default Pipelines" />);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    await user.click(addButton());
    await choose(user, rows()[0]!, "traces/b");
    expect(routing().missing).toEqual(["traces/b"]);
  });

  it("Remove removes the item by its lines, rows keyed by item; with emptyRemovesKey the last one takes the key", async () => {
    const user = userEvent.setup();
    renderField(
      <>
        <Field path={["default_pipelines"]} />
        <Field path={["table", 0, "pipelines"]} label="Target Pipelines" emptyRemovesKey />
      </>,
    );
    const first = rows()[1]!;
    await user.click(screen.getAllByRole("button", { name: "Remove pipeline" })[0]!);
    expect(routing().default_pipelines).toEqual(["logs/other", "traces/gone"]);
    expect(text()).toContain("    default_pipelines: [logs/other, traces/gone] # defaults\n");
    // The removed item's row went: the next row's element is the same one.
    expect(rows()[0]).toBe(first);
    // traces/out's only receiver is routing: kept.
    expect(receiversOf("traces/out")).toEqual(["routing"]);

    const targets = screen.getAllByRole("combobox", { name: "Target Pipelines" });
    expect(targets).toHaveLength(1);
    await user.click(screen.getAllByRole("button", { name: "Remove pipeline" })[2]!);
    expect((routing().table as Record<string, unknown>[])[0]).toEqual({ condition: "true" });
  });

  it("offers nothing excluded but keeps a row's own; Add is disabled with nothing left; the no-options hint", async () => {
    const user = userEvent.setup();
    renderField(
      <>
        <Field path={["table", 0, "pipelines"]} label="Target Pipelines" exclude={["traces/a", "traces/b"]} />
        <Field path={["default_pipelines"]} options={[]} />
      </>,
    );
    const target = screen.getByRole("combobox", { name: "Target Pipelines" });
    expect(await optionsOf(user, target)).toEqual(["traces/a", "traces/out"]);
    const [targetAdd, defaultsAdd] = screen.getAllByRole("button", { name: "Add Pipeline" });
    expect(targetAdd).toBeEnabled();
    expect(defaultsAdd).toBeDisabled();
    expect(
      screen.getByText("No eligible pipelines yet — add a pipeline of the connector's signal type to the canvas first."),
    ).toBeInTheDocument();
  });

  it("a list it can't show is read-only with D9b's hint", () => {
    renderField(<Field path={["table", 1, "pipelines"]} label="Target Pipelines" />);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.getByText(UNSHOWABLE_VALUE_MESSAGE)).toBeInTheDocument();
    expect(within(document.body).queryByRole("button", { name: "Add Pipeline" })).toBeNull();
  });
});
