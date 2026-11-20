/**
 * Monaco's screen-reader live region: one host, replay-blocked, put in the
 * page by the app shell and never removed, shared by every Monaco. Monaco
 * keeps one live region for the whole page and moves it into the
 * `ariaContainerElement` of each editor it creates, so a host that went
 * with its viewer left every editor announcing into a detached node.
 *
 * The editors here are stand-ins that do what Monaco's StandaloneCodeEditor
 * does with `ariaContainerElement` when it is created: Monaco's own aria
 * module's setARIAContainer. The announcements are that module's own.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { alert as announce, setARIAContainer } from "monaco-editor/esm/vs/base/browser/ui/aria/aria.js";
import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "~/components/ui/dialog.js";
import { attachMonacoAriaHost, monacoAriaHost, useAriaContainer } from "./use-aria-container.js";

/** A Monaco stand-in: on mount, its live region goes where Monaco would put it. */
function StandInEditor({ label }: { label: string }) {
  const { ariaHost } = useAriaContainer();
  useEffect(() => {
    if (ariaHost !== null) setARIAContainer(ariaHost);
  }, [ariaHost]);
  return <div className="ph-no-capture">{label}</div>;
}

/** The app shell's slot (root.tsx), the YAML editor, and a viewer dialog the test opens and closes. */
function Page() {
  const [isViewerOpen, setViewerOpen] = useState(false);
  return (
    <>
      <StandInEditor label="yaml editor" />
      <button type="button" onClick={() => setViewerOpen(true)}>
        View
      </button>
      <Dialog open={isViewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Viewer</DialogTitle>
          <StandInEditor label="viewer editor" />
        </DialogContent>
      </Dialog>
      <div className="ph-no-capture" data-testid="shell-slot" ref={attachMonacoAriaHost} />
    </>
  );
}

/** The live region element now holding `text`. */
function announced(text: string): Element | undefined {
  const host = monacoAriaHost()!;
  return [...host.querySelectorAll(".monaco-alert")].find((element) => element.textContent === text);
}

describe("the Monaco live region's host", () => {
  it("is one element, replay-blocked, the same for every caller", () => {
    const host = monacoAriaHost();
    expect(host).toBeInstanceOf(HTMLDivElement);
    expect(host).toHaveClass("ph-no-capture");
    expect(monacoAriaHost()).toBe(host);
  });

  it("is put in the shell's slot, and stays when an editor using it unmounts", () => {
    const { rerender } = render(
      <>
        <StandInEditor label="one" />
        <div className="ph-no-capture" data-testid="shell-slot" ref={attachMonacoAriaHost} />
      </>,
    );
    const slot = screen.getByTestId("shell-slot");
    expect(slot.contains(monacoAriaHost())).toBe(true);

    rerender(<div className="ph-no-capture" data-testid="shell-slot" ref={attachMonacoAriaHost} />);

    expect(screen.getByTestId("shell-slot").contains(monacoAriaHost())).toBe(true);
    expect(monacoAriaHost()!.isConnected).toBe(true);
  });

  it("keeps the YAML editor's announcements in an attached, replay-blocked node after a viewer closes", async () => {
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText("viewer editor")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("viewer editor")).toBeNull();

    // What the YAML editor's Find would read out, after the viewer has gone.
    act(() => announce("zq-line-the-yaml-editor-announces"));

    const region = announced("zq-line-the-yaml-editor-announces");
    expect(region).toBeDefined();
    expect(region!.isConnected).toBe(true);
    expect(document.body.contains(region!)).toBe(true);
    expect(region!.closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByTestId("shell-slot").contains(region!)).toBe(true);
  });

  it("keeps only the newest of Monaco's regions: one per editor would pile up", async () => {
    const host = monacoAriaHost()!;
    for (let index = 0; index < 3; index += 1) act(() => setARIAContainer(host));
    // The observer runs after the mutations.
    await act(async () => undefined);

    expect(host.querySelectorAll(".monaco-aria-container")).toHaveLength(1);
    act(() => announce("zq-after-three-editors"));
    expect(announced("zq-after-three-editors")).toBeDefined();
  });
});
