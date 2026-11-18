/**
 * The shell's slot for Monaco's live region under a modal dialog (D14a
 * Ruling 52): Radix's Dialog hides every other part of the page from
 * assistive technology (aria-hidden's `hideOthers`) but keeps an element
 * carrying `aria-live`, without looking inside it. The slot carries
 * `aria-live="off"`, so the region Monaco puts in it stays audible whether
 * the dialog's own editor is the page's first Monaco or not.
 *
 * Its own file: Monaco's aria module and the shared host are module
 * globals, and the first case needs a page with no Monaco region yet. The
 * editors are stand-ins that do what Monaco's StandaloneCodeEditor does with
 * `ariaContainerElement` when created (the aria module's setARIAContainer);
 * the Dialog is the app's own.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { alert as announce, setARIAContainer } from "monaco-editor/esm/vs/base/browser/ui/aria/aria.js";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog.js";
import { MonacoAriaHostSlot } from "./monaco-aria-host-slot.js";
import { monacoAriaHost, useAriaContainer } from "./use-aria-container.js";

function StandInEditor() {
  const { ariaHost } = useAriaContainer();
  useEffect(() => {
    if (ariaHost !== null) setARIAContainer(ariaHost);
  }, [ariaHost]);
  return <div className="ph-no-capture">editor</div>;
}

/** The page: the shell's slot, some content, and a dialog the test opens, holding an editor or not. */
function Page({ withEditor }: { withEditor: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MonacoAriaHostSlot />
      <main>page content</main>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Sample</DialogTitle>
          {withEditor && <StandInEditor />}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Whether `element` or any ancestor carries aria-hidden="true". */
function isHidden(element: Element): boolean {
  return element.closest('[aria-hidden="true"]') !== null;
}

/** Monaco's live nodes in the shared host: its alerts and its status nodes. */
function liveNodes(): Element[] {
  return [...monacoAriaHost()!.querySelectorAll(".monaco-alert, .monaco-status")];
}

describe("the shell's slot for Monaco's live region (Ruling 52)", () => {
  it("is replay-blocked and carries aria-live=\"off\", the host inside it", () => {
    const { container } = render(<MonacoAriaHostSlot />);
    const slot = container.querySelector("[data-monaco-aria-host-slot]")!;

    expect(slot).toHaveClass("ph-no-capture");
    expect(slot).toHaveAttribute("aria-live", "off");
    expect(slot.contains(monacoAriaHost())).toBe(true);
  });

  it("keeps the region audible when a dialog's editor is the page's first Monaco", async () => {
    const user = userEvent.setup();
    render(<Page withEditor />);
    expect(liveNodes()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText("editor");
    act(() => announce("zq-first-editor-announces"));

    // The dialog did hide the rest of the page…
    expect(isHidden(screen.getByText("page content"))).toBe(true);
    // …but not the region, its nodes, or the announcement, all still replay-blocked.
    const nodes = liveNodes();
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(isHidden(node)).toBe(false);
      expect(node.isConnected).toBe(true);
      expect(node.closest(".ph-no-capture")).not.toBeNull();
    }
    expect(nodes.some((node) => node.textContent === "zq-first-editor-announces")).toBe(true);
  });

  it("leaves an existing region's alert nodes audible under a dialog with no editor of its own", async () => {
    const user = userEvent.setup();
    render(<Page withEditor={false} />);
    act(() => setARIAContainer(monacoAriaHost()!));

    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog", { name: "Sample" });
    act(() => announce("zq-the-yaml-editor-announces"));

    expect(isHidden(screen.getByText("page content"))).toBe(true);
    const alerts = [...monacoAriaHost()!.querySelectorAll(".monaco-alert")];
    expect(alerts.length).toBeGreaterThan(0);
    for (const node of alerts) expect(isHidden(node)).toBe(false);
    expect(alerts.some((node) => node.textContent === "zq-the-yaml-editor-announces")).toBe(true);
  });
});
