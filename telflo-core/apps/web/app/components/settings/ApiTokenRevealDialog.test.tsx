import { useState } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_TOKEN_REVEAL_WORDS } from "~/lib/service-accounts.js";
import { anyStateHolds } from "~/test/fleets.js";
import {
  buildApiToken,
  expectTokenOnlyInsideNoCapture,
  quietQueries,
  renderInRouter,
  waitUntilGone,
} from "~/test/service-accounts.js";
import { ApiTokenRevealDialog } from "./ApiTokenRevealDialog.js";

/*
 * "Copy your token": the token shown once inside ph-no-capture, copied by
 * its button, gone from the DOM and from every component's state however the
 * dialog closes. The token is built at run time and never printed: booleans
 * with fixed labels only, never an element handed to a matcher.
 */

function renderReveal(token: string) {
  const onClose = vi.fn();
  function Page() {
    // The page's state, as ServiceAccountDetailSection holds it.
    const [shown, setShown] = useState<string | null>(token);
    return (
      <ApiTokenRevealDialog
        token={shown}
        onClose={() => {
          onClose();
          setShown(null);
        }}
      />
    );
  }
  const user = renderInRouter(Page);
  return { user, onClose };
}

describe("ApiTokenRevealDialog", () => {
  let unquiet: () => void;
  beforeEach(() => {
    vi.restoreAllMocks();
    unquiet = quietQueries();
  });
  afterEach(() => unquiet());

  it("shows the token once, inside ph-no-capture, with its words, Copy token and Done", async () => {
    const token = buildApiToken();
    renderReveal(token);
    const dialog = await screen.findByRole("dialog", { name: "Copy your token" });
    expectTokenOnlyInsideNoCapture(token);
    const code = [...dialog.querySelectorAll("code")];
    expect(code.length).toBe(1);
    expect(code[0]!.textContent === token, "the token as the code's text").toBe(true);
    expect(dialog.querySelector("input, textarea") === null, "no field in the reveal").toBe(true);
    expect(dialog.textContent?.includes(API_TOKEN_REVEAL_WORDS), "the reveal's words").toBe(true);
    expect(API_TOKEN_REVEAL_WORDS).toBe("This is the only time you'll see it. If you lose it, revoke this token and create a new one.");
    const copy = within(dialog).getByRole("button", { name: "Copy token" });
    expect(code[0]!.closest(".ph-no-capture")?.contains(copy) === true, "Copy token inside the copy box").toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Done" }) !== null, "the reveal's Done").toBe(true);
  });

  it("Copy token puts the token on the clipboard and reads Copied", async () => {
    const token = buildApiToken();
    const { user } = renderReveal(token);
    const dialog = await screen.findByRole("dialog", { name: "Copy your token" });
    await user.click(within(dialog).getByRole("button", { name: "Copy token" }));
    expect((await navigator.clipboard.readText()) === token, "the clipboard holds the token").toBe(true);
    expect(within(dialog).getByRole("button", { name: "Copy token" }).textContent === "Copied", "Copy token reads Copied").toBe(true);
  });

  const closings: Array<[string, (user: ReturnType<typeof renderReveal>["user"], dialog: HTMLElement) => Promise<void>]> = [
    ["Done", (user, dialog) => user.click(within(dialog).getByRole("button", { name: "Done" }))],
    ["Escape", (user) => user.keyboard("{Escape}")],
    ["an outside click", async () => void fireEvent.pointerDown(document.body)],
    ["the X", (user, dialog) => user.click(within(dialog).getByRole("button", { name: "Close" }))],
  ];

  for (const [how, close] of closings) {
    it(`closed by ${how}, the token is gone from the DOM and from every state`, async () => {
      const token = buildApiToken();
      const { user, onClose } = renderReveal(token);
      const dialog = await screen.findByRole("dialog", { name: "Copy your token" });
      expect(anyStateHolds(token), "the page's state holds the token while shown").toBe(true);

      await close(user, dialog);
      await waitUntilGone(() => screen.queryByRole("dialog"), "the reveal closed");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.body.innerHTML.includes(token), "the token in the DOM").toBe(false);
      expect(anyStateHolds(token), "the token in a component's state").toBe(false);
    });
  }
});
