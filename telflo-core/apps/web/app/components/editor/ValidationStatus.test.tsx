/**
 * The collector validator's status bar under the YAML editor: three basic
 * tests first, then every state's text, the rows that jump and the plain
 * ones, the requirements row, and that no attribute holds a message, a path
 * or the configuration's text.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ValidationStatus } from "./ValidationStatus.js";
import type { EditorPosition } from "~/lib/editor/component-position.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";
import { answerValidation, attributeValues, REFUSAL } from "~/test/validation.js";

const TEXT = [
  "receivers:",
  "  otlp: {}",
  "  filelog:",
  "    include: [/var/log/app.log]",
  "exporters:",
  "  otlp/2:",
  "    endpoint: marker-text-77f0:4317",
  "service:",
  "  pipelines:",
  "    traces/2:",
  "      receivers: [otlp]",
  "      exporters: [otlp/2]",
  "",
].join("\n");

const UNAVAILABLE_MESSAGE = "Validation is unavailable. Your YAML was not checked — retry shortly.";

const initialState = useEditorStore.getState();

function renderBar() {
  const onJump = vi.fn<(position: EditorPosition) => void>();
  const view = render(<ValidationStatus onJump={onJump} />);
  return { ...view, onJump, user: userEvent.setup() };
}

const requirement = (title: string, componentPath: string | null = null) => ({
  category: "env_var" as const,
  title,
  description: `Set ${title} before the collector starts.`,
  componentPath,
});

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  useEditorStore.getState().load({
    organizationId: GROUP_ID,
    configuration: MINE,
    version: versionFixture({ yamlContent: TEXT, collectorVersion: "0.162.0" }),
  });
});

describe("ValidationStatus (basics)", () => {
  it("renders nothing while idle", () => {
    answerValidation({ status: "idle" });
    const { container } = renderBar();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows 'validation unavailable' with the reason, and no error count", () => {
    answerValidation({ status: "unavailable", message: UNAVAILABLE_MESSAGE });
    renderBar();
    expect(screen.getByText("validation unavailable · config not checked")).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/\berrors?\b/)).toBeNull();
  });

  it("still shows the red error row for a real rejection", () => {
    answerValidation({
      status: "invalid",
      collectorVersion: "0.162.0",
      errors: [{ message: "unknown receiver", componentPath: "receivers::x" }],
      requirements: [],
    });
    renderBar();
    expect(screen.getByText("1 error · v0.162.0")).toBeInTheDocument();
    expect(screen.queryByText(/validation unavailable/i)).toBeNull();
  });
});

describe("ValidationStatus's states", () => {
  it("nothing for empty text, whatever was answered before", () => {
    answerValidation({ status: "valid", collectorVersion: "0.162.0", requirements: [] });
    act(() => useEditorStore.getState().setText(""));
    const { container } = renderBar();
    expect(container).toBeEmptyDOMElement();
  });

  it("validating config… with a spinner, while the text on screen is due to be checked", () => {
    const { container } = renderBar();
    expect(screen.getByText("validating config…")).toBeInTheDocument();
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("config valid · v0.162.0, with the version the API checked against", () => {
    answerValidation({ status: "valid", collectorVersion: "0.161.0", requirements: [] });
    renderBar();
    expect(screen.getByText("config valid · v0.161.0")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("1 error / {n} errors · v0.162.0, with a chevron, the list collapsed until clicked", async () => {
    answerValidation({
      status: "invalid",
      collectorVersion: "0.162.0",
      errors: [REFUSAL, { message: "second", componentPath: null }],
      requirements: [],
    });
    const { user, container } = renderBar();

    const toggle = screen.getByRole("button", { name: "2 errors · v0.162.0" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(container).not.toHaveTextContent("second");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container).toHaveTextContent(`${REFUSAL.componentPath}: ${REFUSAL.message}`);
    expect(screen.getByText("second")).toBeInTheDocument();

    await user.click(toggle);
    expect(container).not.toHaveTextContent("second");
  });

  it("amber validation unavailable · config not checked, the reason beneath", () => {
    answerValidation({ status: "unavailable", message: "Couldn't reach the validation service. Your YAML was not checked." });
    renderBar();
    const row = screen.getByText("validation unavailable · config not checked");
    expect(row).toHaveClass("text-warn");
    const reason = screen.getByText("Couldn't reach the validation service. Your YAML was not checked.");
    expect(row.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("amber not checked · v0.155.0 is retired — pick an offered version to check this config", () => {
    answerValidation({ status: "retired", collectorVersion: "0.155.0" });
    renderBar();
    const row = screen.getByText("not checked · v0.155.0 is retired — pick an offered version to check this config");
    expect(row).toHaveClass("text-warn");
    expect(screen.queryByText(/deployment requirement/)).toBeNull();
  });

  it("shows an answer only for exactly the text and pin on screen: another text, or another pin, is validating", () => {
    answerValidation({ status: "valid", collectorVersion: "0.162.0", requirements: [] });
    act(() => useEditorStore.getState().setText(`${TEXT}# typed\n`));
    const { rerender, onJump } = renderBar();
    expect(screen.getByText("validating config…")).toBeInTheDocument();

    act(() => useEditorStore.getState().setText(TEXT));
    rerender(<ValidationStatus onJump={onJump} />);
    expect(screen.getByText("config valid · v0.162.0")).toBeInTheDocument();

    act(() => useEditorStore.getState().setCollectorVersion("0.161.0"));
    expect(screen.getByText("validating config…")).toBeInTheDocument();
  });
});

describe("the error rows", () => {
  async function expanded(errors: { message: string; componentPath: string | null }[]) {
    answerValidation({ status: "invalid", collectorVersion: "0.162.0", errors, requirements: [] });
    const view = renderBar();
    await view.user.click(screen.getByRole("button", { name: /errors? · v0\.162\.0/ }));
    return view;
  }

  it("a row whose path names a component is a button that jumps to its key: exporters::otlp/2", async () => {
    const { user, onJump } = await expanded([{ message: "bad endpoint", componentPath: "exporters::otlp/2" }]);
    await user.click(screen.getByRole("button", { name: "exporters::otlp/2: bad endpoint" }));
    expect(onJump).toHaveBeenCalledWith({ lineNumber: 6, column: 3 });
  });

  it("and to a pipeline: service::pipelines::traces/2", async () => {
    const { user, onJump } = await expanded([{ message: "no processors", componentPath: "service::pipelines::traces/2" }]);
    await user.click(screen.getByRole("button", { name: "service::pipelines::traces/2: no processors" }));
    expect(onJump).toHaveBeenCalledWith({ lineNumber: 10, column: 5 });
  });

  it("a deeper path jumps to the deepest prefix that names a key: baseconfig isn't one", async () => {
    const path = "receivers::filelog::baseconfig::operators::0::builder";
    const { user, onJump } = await expanded([{ message: "bad operator", componentPath: path }]);
    await user.click(screen.getByRole("button", { name: `${path}: bad operator` }));
    expect(onJump).toHaveBeenCalledWith({ lineNumber: 3, column: 3 });
  });

  it("a path that names nothing in the text, a section alone, or no path, is plain text", async () => {
    await expanded([
      { message: "unknown exporter", componentPath: "exporters::otlp/3" },
      { message: "section", componentPath: "connectors" },
      { message: "pipeline not found", componentPath: null },
    ]);
    // Only the toggle is a button.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("exporters::otlp/3:")).toBeInTheDocument();
    expect(screen.getByText("pipeline not found")).toBeInTheDocument();
  });
});

describe("the requirements row", () => {
  it("1 deployment requirement, collapsible, each with its title, description and component path", async () => {
    answerValidation({
      status: "valid",
      collectorVersion: "0.162.0",
      requirements: [requirement("Set environment variable TOKEN", "exporters::otlp/2")],
    });
    const { user, container } = renderBar();

    const toggle = screen.getByRole("button", { name: "1 deployment requirement" });
    expect(container).not.toHaveTextContent("Set environment variable TOKEN");
    await user.click(toggle);
    expect(screen.getByText("Set environment variable TOKEN")).toBeInTheDocument();
    expect(screen.getByText("Set Set environment variable TOKEN before the collector starts.")).toBeInTheDocument();
    expect(screen.getByText("exporters::otlp/2")).toBeInTheDocument();
    await user.click(toggle);
    expect(container).not.toHaveTextContent("Set environment variable TOKEN");
  });

  it("{n} deployment requirements, shown with errors too: requirements are never errors", () => {
    answerValidation({
      status: "invalid",
      collectorVersion: "0.162.0",
      errors: [REFUSAL],
      requirements: [requirement("A"), requirement("B")],
    });
    renderBar();
    expect(screen.getByText("1 error · v0.162.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 deployment requirements" })).toBeInTheDocument();
  });

  it("none, no row", () => {
    answerValidation({ status: "valid", collectorVersion: "0.162.0", requirements: [] });
    renderBar();
    expect(screen.queryByText(/deployment requirement/)).toBeNull();
  });
});

describe("no attribute holds a message, a path or the text", () => {
  it("in any state, everything expanded", async () => {
    const marker = /marker-(message|path|text|title|description)/;
    const outcomes = [
      { status: "unavailable" as const, message: "marker-message-unavailable" },
      { status: "retired" as const, collectorVersion: "0.155.0" },
      {
        status: "invalid" as const,
        collectorVersion: "0.162.0",
        errors: [REFUSAL, { message: "marker-message-2", componentPath: "exporters::otlp/2" }],
        requirements: [
          { category: "env_var" as const, title: "marker-title", description: "marker-description", componentPath: "marker-path-r" },
        ],
      },
    ];
    for (const outcome of outcomes) {
      answerValidation(outcome);
      const { container, user, unmount } = renderBar();
      for (const toggle of screen.queryAllByRole("button", { expanded: false })) await user.click(toggle);
      // The markers are on the page, as text, where there are any.
      if (outcome.status !== "retired") expect(container.textContent).toMatch(marker);
      const attributes = attributeValues(container);
      expect(attributes.length).toBeGreaterThan(0);
      expect(attributes.filter((value) => marker.test(value) || value.includes("otlp/2"))).toEqual([]);
      // Every button is named by its text.
      for (const button of screen.queryAllByRole("button")) {
        expect(button).not.toHaveAttribute("aria-label");
        expect(button).not.toHaveAttribute("title");
      }
      unmount();
    }
  });
});
