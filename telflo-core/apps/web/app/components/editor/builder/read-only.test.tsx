import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasActions } from "./CanvasActions.js";
import { ComponentPalette } from "./ComponentPalette.js";
import { ConfigurationPanel } from "./ConfigurationPanel.js";
import { PipelineGroupConfigPanel } from "./PipelineGroupConfigPanel.js";
import { SelfMonitoringDialog } from "./SelfMonitoringDialog.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentPalette } from "~/lib/graph/palette.js";
import { summaryOf, useEditorStore } from "~/lib/stores/editor-store.js";
import { builderStore, componentNamed, groupNamed, openText } from "~/test/builder-store.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, versionFixture } from "~/test/configurations.js";

/*
 * The builder's controls over a published version: the toolbox doesn't
 * drag, the canvas actions are disabled, and the Configuration tab shows a
 * node with its forms disabled, so it can be inspected, never changed. Each
 * is checked enabled on a draft first, so the disabling is the read-only
 * mode's.
 */

const STARTER = corpusText("starter.yaml");
const TELEMETRY = `${STARTER}  telemetry:\n    logs:\n      level: info\n`;
const initialState = useEditorStore.getState();

/** Opens `yaml` as a published version. */
function openPublished(yaml = STARTER) {
  builderStore().load({
    organizationId: GROUP_ID,
    configuration: MINE,
    version: versionFixture({ yamlContent: yaml, ...PUBLISHED_FIELDS }),
  });
}

/** The open draft becomes published under the mounted controls, as a publish's answer makes it. */
function publishOpenVersion() {
  act(() => builderStore().replaceVersionSummary({ ...summaryOf(builderStore().version!), ...PUBLISHED_FIELDS }));
}

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the toolbox", () => {
  it("doesn't drag on a published version; the help still opens", () => {
    openText(STARTER);
    const { container } = render(<ComponentPalette />);
    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(componentPalette.length);

    publishOpenVersion();

    expect(container.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /^About / })).toHaveLength(componentPalette.length);
  });
});

describe("the canvas actions", () => {
  it("are all disabled on a published version", () => {
    openText(STARTER);
    render(<CanvasActions />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) expect(button).toBeEnabled();

    publishOpenVersion();

    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("the Configuration tab", () => {
  it("shows a selected component with its form, instance name and box disabled, their values kept", async () => {
    openText(STARTER);
    render(<ConfigurationPanel />);
    act(() => builderStore().selectNode(componentNamed("processors.batch", "traces").id));
    const timeout = () => screen.getByRole("textbox", { name: "Timeout" });
    expect(timeout()).toBeEnabled();

    publishOpenVersion();

    expect(timeout()).toBeDisabled();
    expect(timeout()).toHaveValue("10s");
    await userEvent.setup().click(screen.getByRole("button", { name: "Advanced: Instance & YAML" }));
    expect(screen.getByRole("textbox", { name: "Instance Name" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Raw YAML" })).toBeDisabled();
    expect(builderStore().text).toBe(STARTER);
  });

  it("opens on a published version and selects there: the component's form shows, disabled", () => {
    openPublished();
    render(<ConfigurationPanel />);
    act(() => builderStore().selectNode(componentNamed("exporters.otlp", "logs").id));
    expect(screen.getByRole("textbox", { name: "Endpoint" })).toBeDisabled();
  });

  it("shows a selected pipeline group read-only", () => {
    openText(STARTER);
    render(<PipelineGroupConfigPanel />);
    act(() => builderStore().selectNode(groupNamed("logs").id));
    expect(screen.getAllByRole("button").some((button) => !(button as HTMLButtonElement).disabled)).toBe(true);

    publishOpenVersion();

    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("the Self-monitoring dialog's draft", () => {
  it("is read-only on a published version: Apply and Remove Section disabled", async () => {
    openPublished(TELEMETRY);
    render(<SelfMonitoringDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Collector Self-Monitoring" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Section" })).toBeDisabled();
  });

  it("is writable on a draft (what the test above refuses)", async () => {
    openText(TELEMETRY);
    render(<SelfMonitoringDialog open onOpenChange={() => {}} />);
    await screen.findByRole("dialog", { name: "Collector Self-Monitoring" });
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Section" })).toBeEnabled();
  });
});
