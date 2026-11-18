import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ContactUsDialog } from "./ContactUsDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { attributesHolding } from "~/test/fleets.js";
import { holdsText, quietQueries, waitUntilGone } from "~/test/service-accounts.js";

/*
 * "Contact us"'s dialog (D29 decisions 32, 40 and 41; Preflight rulings 16
 * and 21): its texts; Send disabled while blank; "Sending..."; the
 * fixed toasts; an uncontrolled textarea inside `ph-no-capture` holding the
 * person's words in no attribute, React prop or toast; a fresh box each
 * opening; a failure keeps the dialog and the text. The message is the
 * person's own words: checked as booleans with fixed labels only.
 */

const MESSAGE = "canary-feedback-7d2e: please add a Kafka receiver";

/** Whether browser storage (localStorage, sessionStorage, the page's cookies) holds `text`: a boolean, nothing printed. */
function storageHolds(text: string): boolean {
  const stores = [window.localStorage, window.sessionStorage];
  const inStore = stores.some((store) =>
    Array.from({ length: store.length }, (_, index) => store.key(index) ?? "").some(
      (key) => key.includes(text) || (store.getItem(key) ?? "").includes(text),
    ),
  );
  return inStore || document.cookie.includes(text);
}

function Harness() {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button" onClick={() => setOpen(true)}>
        open contact us
      </button>
      <ContactUsDialog open={open} onOpenChange={setOpen} returnFocusTo={opener} />
    </>
  );
}

async function openDialog() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "open contact us" }));
  const dialog = await screen.findByRole("dialog", { name: "Contact Us" });
  return { user, dialog, box: within(dialog).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement };
}

/** Whether a dialog named Contact Us is showing. */
const contactUsShowing = () => screen.queryByRole("dialog", { name: "Contact Us" }) !== null;

describe("ContactUsDialog", () => {
  let unquiet: () => void;

  beforeEach(() => {
    vi.restoreAllMocks();
    unquiet = quietQueries();
  });

  afterEach(() => {
    unquiet();
  });

  it("shows the title, sentence and placeholder; Send disabled until the box holds more than blanks; at most 5,000 characters", async () => {
    const { user, dialog, box } = await openDialog();
    expect(
      within(dialog).getByText(
        "Want us to know something? Need new connectors? Or maybe you just want to say ‘hello’. We want to hear it all, so send us your thoughts.",
      ),
    ).toBeInTheDocument();
    expect(box).toHaveAttribute("placeholder", "Type your message here...");
    expect(box).toHaveAttribute("maxlength", "5000");
    const send = within(dialog).getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await user.type(box, "   ");
    expect(send).toBeDisabled();
    await user.type(box, "x");
    expect(send).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("keeps the words in an uncontrolled box inside ph-no-capture: no attribute, React prop or toast holds them", async () => {
    let finish: (value: { id: string }) => void = () => undefined;
    vi.spyOn(apiClient, "createFeedback").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const success = vi.spyOn(toast, "success");
    const { user, dialog, box } = await openDialog();
    await user.type(box, MESSAGE);

    expect({
      insideNoCapture: box.closest(".ph-no-capture") !== null,
      attributes: attributesHolding(MESSAGE).length,
      valueAttribute: box.hasAttribute("value"),
      storage: storageHolds(MESSAGE),
    }).toEqual({ insideNoCapture: true, attributes: 0, valueAttribute: false, storage: false });

    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    // While it sends: "Sending...", nothing can close it, the box read-only.
    expect(within(dialog).getByRole("button", { name: "Sending..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(box).toHaveAttribute("readonly");
    await user.keyboard("{Escape}");
    expect(contactUsShowing()).toBe(true);
    expect(attributesHolding(MESSAGE).length).toBe(0);

    finish({ id: "00000000-0000-4000-8000-0000000000f1" });
    await waitUntilGone(() => screen.queryByRole("dialog", { name: "Contact Us" }), "the dialog closed");
    expect(storageHolds(MESSAGE), "browser storage holding the words").toBe(false);
    // The focus back on the button that opened it (Ruling 271).
    expect(document.activeElement === screen.getByRole("button", { name: "open contact us" })).toBe(true);
    expect({
      toasts: success.mock.calls.length,
      fixed: success.mock.calls[0]?.[0] === "Thanks for your feedback!",
      holds: holdsText(success.mock.calls, MESSAGE),
    }).toEqual({
      toasts: 1,
      fixed: true,
      holds: false,
    });
  });

  it("sends the trimmed words once, closes, and opens afresh with an empty box and Send disabled", async () => {
    const createFeedback = vi.spyOn(apiClient, "createFeedback").mockResolvedValue({ id: "00000000-0000-4000-8000-0000000000f1" });
    const { user, dialog, box } = await openDialog();
    await user.type(box, `  ${MESSAGE}\n`);
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitUntilGone(() => screen.queryByRole("dialog", { name: "Contact Us" }), "the dialog closed");
    expect({ calls: createFeedback.mock.calls.length, trimmed: createFeedback.mock.calls[0]?.[0].text === MESSAGE }).toEqual({
      calls: 1,
      trimmed: true,
    });

    await user.click(screen.getByRole("button", { name: "open contact us" }));
    const reopened = await screen.findByRole("dialog", { name: "Contact Us" });
    expect((within(reopened).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");
    expect(within(reopened).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it('keeps the dialog and the words on a failure, toasting "Failed to submit feedback" (fixed words, whatever the API said)', async () => {
    vi.spyOn(apiClient, "createFeedback").mockRejectedValue(
      new ApiError("rate_limited", "Too many requests. Try again later.", { status: 429 }),
    );
    const failed = vi.spyOn(toast, "error");
    const { user, dialog, box } = await openDialog();
    await user.type(box, MESSAGE);
    await user.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(failed.mock.calls[0]?.[0]).toBe("Failed to submit feedback");
    expect({
      open: contactUsShowing(),
      kept: box.value === MESSAGE,
      sendEnabled: !within(dialog).getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    }).toEqual({
      open: true,
      kept: true,
      sendEnabled: true,
    });
  });

  it("says nothing when the session has ended (the session-ended handler has the page)", async () => {
    vi.spyOn(apiClient, "createFeedback").mockRejectedValue(new ApiError("unauthenticated", "You need to sign in.", { status: 401 }));
    const failed = vi.spyOn(toast, "error");
    const { user, dialog, box } = await openDialog();
    await user.type(box, "Hello.");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Send" })).toBeEnabled());
    expect(failed).not.toHaveBeenCalled();
  });

  it("closes on Cancel without sending, and the next opening is empty", async () => {
    const createFeedback = vi.spyOn(apiClient, "createFeedback");
    const { user, dialog, box } = await openDialog();
    await user.type(box, MESSAGE);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitUntilGone(() => screen.queryByRole("dialog", { name: "Contact Us" }), "the dialog closed");
    expect(createFeedback).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "open contact us" }));
    const reopened = await screen.findByRole("dialog", { name: "Contact Us" });
    expect((within(reopened).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value === "").toBe(true);
  });
});
