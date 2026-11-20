import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Code, Settings } from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { EditorLayout, type EditorPanelTab } from "./EditorLayout.js";
import { useHeldEdit } from "~/lib/editor/held-edits.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

const FIRST: EditorPanelTab = { id: "first", label: "First", icon: Settings, content: <p>First content</p> };
const SECOND: EditorPanelTab = { id: "second", label: "Second", icon: Code, content: <p>Second content</p> };

const initialState = useEditorStore.getState();

function renderLayout(panelTabs: readonly EditorPanelTab[] = [FIRST, SECOND]) {
  const view = render(
    <EditorLayout
      toolbar={<div>The toolbar</div>}
      toolbox={<div data-testid="toolbox">The toolbox</div>}
      main={<div>The centre</div>}
      panelTabs={panelTabs}
      dialogs={<div role="dialog">A dialog</div>}
    />,
  );
  return { ...view, user: userEvent.setup() };
}

/** The panel: the element carrying the width, holding the tabs or the rail. */
function panel(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-tour-step="editor-right-panel"]')!;
}

beforeEach(() => {
  useEditorStore.setState(initialState, true);
});

describe("EditorLayout", () => {
  it("renders the toolbar above the columns (toolbox | centre | panel), and the dialogs", () => {
    renderLayout();

    const toolbar = screen.getByText("The toolbar");
    const centre = screen.getByText("The centre");
    const centreColumn = centre.closest('[data-tour-step="canvas"]');
    expect(centreColumn).not.toBeNull();
    expect(centreColumn).toHaveClass("flex-1", "min-w-0");
    expect(centreColumn!.nextElementSibling).toBe(panel());
    expect(centreColumn!.previousElementSibling).toBe(screen.getByTestId("toolbox"));
    expect(centreColumn).not.toContainElement(screen.getByTestId("toolbox"));
    expect(panel()).not.toContainElement(centre);

    const root = toolbar.parentElement!;
    expect(root).toHaveClass("flex", "flex-col", "h-screen");
    expect(root.firstElementChild).toBe(toolbar);
    expect(root.children[1]).toContainElement(centre);
    expect(root.lastElementChild).toBe(screen.getByRole("dialog"));
  });

  it("builds the tab list from panelTabs in order and switches between them", async () => {
    const { user } = renderLayout();

    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["First", "Second"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("First content")).toBeInTheDocument();
    expect(screen.queryByText("Second content")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Second" }));

    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Second content")).toBeInTheDocument();
    expect(screen.queryByText("First content")).not.toBeInTheDocument();
    expect(useEditorStore.getState().activeTab).toBe("second");

    await user.click(screen.getByRole("tab", { name: "First" }));

    expect(screen.getByText("First content")).toBeInTheDocument();
    expect(useEditorStore.getState().activeTab).toBe("first");
  });

  it("opens on the store's active tab", () => {
    useEditorStore.setState({ activeTab: "second" });
    renderLayout();

    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Second content")).toBeInTheDocument();
  });

  it("shows the first tab when the store's active tab names none of panelTabs", () => {
    useEditorStore.setState({ activeTab: "testing" });
    renderLayout();

    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("First content")).toBeInTheDocument();
    expect(screen.queryByText("Second content")).not.toBeInTheDocument();
  });

  it("a disabled tab can't be selected, from the tab list or the rail", async () => {
    const { user } = renderLayout([FIRST, { ...SECOND, disabled: true }]);

    const second = screen.getByRole("tab", { name: "Second" });
    expect(second).toBeDisabled();
    await user.click(second);

    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Second content")).not.toBeInTheDocument();
    expect(useEditorStore.getState().activeTab).toBeNull();

    await user.click(screen.getByRole("button", { name: "Collapse panel" }));
    const railButton = screen.getByRole("button", { name: "Second" });
    expect(railButton).toBeDisabled();
    await user.click(railButton);

    expect(useEditorStore.getState().panelCollapsed).toBe(true);
    expect(useEditorStore.getState().activeTab).toBeNull();
  });

  it("never shows a disabled tab: the store's disabled tab gives way to the first enabled one, which the store then names", () => {
    useEditorStore.setState({ activeTab: "first" });
    const { rerender } = renderLayout([{ ...FIRST, disabled: true }, SECOND]);

    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Second content")).toBeInTheDocument();
    expect(screen.queryByText("First content")).not.toBeInTheDocument();
    expect(useEditorStore.getState().activeTab).toBe("second");

    // Enabled again: the panel stays where it is.
    rerender(<EditorLayout toolbar={null} main={null} panelTabs={[FIRST, SECOND]} />);
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
  });

  it("with no tab in the store and the first disabled, shows the first enabled one", () => {
    renderLayout([{ ...FIRST, disabled: true }, SECOND]);

    expect(screen.getByText("Second content")).toBeInTheDocument();
    expect(useEditorStore.getState().activeTab).toBe("second");
  });

  it("collapse shows the 44 px rail: Expand panel, then one button per tab, labelled with its label", async () => {
    const { user } = renderLayout();

    const collapse = screen.getByRole("button", { name: "Collapse panel" });
    expect(collapse).toHaveAttribute("title", "Collapse panel");
    await user.click(collapse);

    expect(useEditorStore.getState().panelCollapsed).toBe(true);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByText("First content")).not.toBeInTheDocument();
    expect(panel()).toHaveClass("w-11");
    expect(panel().style.width).toBe("");

    const buttons = within(panel()).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Expand panel", "First", "Second"]);
    expect(buttons.map((button) => button.getAttribute("title"))).toEqual(["Expand panel", "First", "Second"]);
    // The current tab's icon is highlighted.
    expect(buttons[1]).toHaveClass("bg-accent", "text-foreground");
    expect(buttons[2]).toHaveClass("text-muted-foreground");
  });

  it("a rail button expands the panel on its tab", async () => {
    const { user } = renderLayout();
    await user.click(screen.getByRole("button", { name: "Collapse panel" }));

    await user.click(screen.getByRole("button", { name: "Second" }));

    expect(useEditorStore.getState().panelCollapsed).toBe(false);
    expect(useEditorStore.getState().activeTab).toBe("second");
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Second content")).toBeInTheDocument();
  });

  it("Expand panel expands the panel on the current tab", async () => {
    useEditorStore.setState({ activeTab: "second" });
    const { user } = renderLayout();
    await user.click(screen.getByRole("button", { name: "Collapse panel" }));

    await user.click(screen.getByRole("button", { name: "Expand panel" }));

    expect(useEditorStore.getState().panelCollapsed).toBe(false);
    expect(useEditorStore.getState().activeTab).toBe("second");
    expect(screen.getByText("Second content")).toBeInTheDocument();
    expect(panel().style.width).toBe("400px");
  });

  it("opens collapsed when the store says so", () => {
    useEditorStore.setState({ panelCollapsed: true });
    renderLayout();

    expect(screen.getByRole("button", { name: "Expand panel" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("takes the panel's width from the store, 400 px by default", () => {
    renderLayout();
    expect(panel().style.width).toBe("400px");

    act(() => useEditorStore.setState({ panelWidth: 500 }));
    expect(panel().style.width).toBe("500px");
  });

  describe("a tab kept mounted", () => {
    /** A tab's own state: a count its button raises, lost if the tab unmounts. */
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount(count + 1)}>
          Clicked {count}
        </button>
      );
    }

    const KEPT: EditorPanelTab = { ...FIRST, content: <Counter />, keepMounted: true };

    it("stays mounted, hidden, while another tab shows, keeping its state; a tab not kept still unmounts", async () => {
      const { user } = renderLayout([KEPT, SECOND]);
      await user.click(screen.getByRole("button", { name: "Clicked 0" }));
      const counter = screen.getByRole("button", { name: "Clicked 1" });
      const keptPanel = counter.closest<HTMLElement>('[role="tabpanel"]')!;
      expect(keptPanel).not.toHaveAttribute("hidden");

      await user.click(screen.getByRole("tab", { name: "Second" }));

      expect(screen.getByText("Second content")).toBeInTheDocument();
      // Still in the document, the same element, hidden: not displayed and out of the accessibility tree.
      expect(counter).toBeInTheDocument();
      expect(keptPanel).toHaveAttribute("hidden");
      expect(keptPanel).toHaveClass("flex-1", "m-0", "flex", "flex-col", "overflow-hidden");
      expect(screen.queryByRole("button", { name: "Clicked 1" })).toBeNull();
      expect(screen.getAllByRole("tabpanel")).toHaveLength(1);

      await user.click(screen.getByRole("tab", { name: "First" }));

      expect(screen.getByRole("button", { name: "Clicked 1" })).toBe(counter);
      expect(keptPanel).not.toHaveAttribute("hidden");
      // The tab not kept unmounted.
      expect(screen.queryByText("Second content")).not.toBeInTheDocument();
    });

    it("opened on another tab, is mounted hidden from the start", () => {
      useEditorStore.setState({ activeTab: "second" });
      renderLayout([KEPT, SECOND]);
      expect(screen.getByText("Clicked 0").closest('[role="tabpanel"]')).toHaveAttribute("hidden");
      expect(screen.queryByRole("button", { name: "Clicked 0" })).toBeNull();
    });

    it("a disabled tab kept mounted is hidden while the panel falls back to the first enabled one", () => {
      renderLayout([{ ...KEPT, disabled: true }, SECOND]);
      expect(screen.getByText("Second content")).toBeInTheDocument();
      expect(screen.getByText("Clicked 0").closest('[role="tabpanel"]')).toHaveAttribute("hidden");
    });

    /** A field holding an edit: its flush records the tab and the collapse it ran under. */
    const flushes: { activeTab: string | null; collapsed: boolean }[] = [];
    function HoldingField() {
      useHeldEdit(true, () => {
        const { activeTab, panelCollapsed } = useEditorStore.getState();
        flushes.push({ activeTab, collapsed: panelCollapsed });
      });
      return <p>Holding</p>;
    }
    const HOLDING: EditorPanelTab = { ...FIRST, content: <HoldingField />, keepMounted: true };

    beforeEach(() => {
      flushes.length = 0;
    });

    it("writes every held edit before the tab changes, so the next tab sees it", async () => {
      useEditorStore.setState({ activeTab: "first" });
      const { user } = renderLayout([HOLDING, SECOND]);

      await user.click(screen.getByRole("tab", { name: "Second" }));

      expect(flushes).toEqual([{ activeTab: "first", collapsed: false }]);
      expect(useEditorStore.getState().activeTab).toBe("second");
      // Kept mounted: the field didn't go, so it wrote nothing more by going.
      expect(screen.getByText("Holding")).toBeInTheDocument();
    });

    it("writes every held edit before the panel collapses, and before the rail expands it (a field outside the panel holds one: the toolbar's name)", async () => {
      useEditorStore.setState({ activeTab: "first" });
      render(<EditorLayout toolbar={<HoldingField />} main={null} panelTabs={[FIRST, SECOND]} />);
      const user = userEvent.setup();

      await user.click(screen.getByRole("button", { name: "Collapse panel" }));
      expect(flushes).toEqual([{ activeTab: "first", collapsed: false }]);
      expect(useEditorStore.getState().panelCollapsed).toBe(true);

      await user.click(screen.getByRole("button", { name: "Second" }));
      expect(flushes).toEqual([
        { activeTab: "first", collapsed: false },
        { activeTab: "first", collapsed: true },
      ]);
      expect(useEditorStore.getState().panelCollapsed).toBe(false);
      expect(useEditorStore.getState().activeTab).toBe("second");

      await user.click(screen.getByRole("button", { name: "Collapse panel" }));
      await user.click(screen.getByRole("button", { name: "Expand panel" }));
      expect(flushes).toHaveLength(4);
      expect(flushes[3]).toEqual({ activeTab: "second", collapsed: true });
    });
  });

  it("dragging the handle writes the new width to the store", () => {
    renderLayout();
    const handle = panel().querySelector<HTMLElement>(".cursor-col-resize")!;

    fireEvent.mouseDown(handle);
    fireEvent.mouseMove(document, { clientX: window.innerWidth - 480 });
    fireEvent.mouseUp(document);

    expect(useEditorStore.getState().panelWidth).toBe(480);
    expect(panel().style.width).toBe("480px");
  });
});
