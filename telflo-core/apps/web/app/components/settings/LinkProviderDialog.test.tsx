import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkProviderDialog, isProviderAddress } from "./LinkProviderDialog.js";
import { LINK_START_FAILED_MESSAGE } from "~/lib/account.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { GOOGLE } from "~/test/account.js";
import { expectNoAttributeHolds } from "~/test/fleets.js";

/* The password prompt before a link (D21 decisions 38 and 45). */

const PASSWORD = "canary-prompt-pw-12cd";
const AUTHORIZATION_URL = "https://accounts.example.test/authorize?state=abc";

/** What a browser fires when it shows the page; `persisted` when it comes back from the back/forward cache. */
function pageShow(persisted: boolean) {
  act(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));
  });
}

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <LinkProviderDialog open={open} onOpenChange={setOpen} provider={GOOGLE} />
    </>
  );
}

let assign: ReturnType<typeof vi.fn>;

describe("LinkProviderDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names itself in fixed words with the provider's name, and closing it takes the typed password with it", async () => {
    const start = vi.spyOn(apiClient, "createIdentityLinkRequest");
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    expect(within(dialog).getByText("Enter your current password to continue to Google.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    expectNoAttributeHolds(PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Open" }));
    const again = await screen.findByRole("dialog", { name: "Link Google" });
    expect((within(again).getByLabelText("Current Password") as HTMLInputElement).value).toBe("");
    expect(start).not.toHaveBeenCalled();
  });

  it("stays busy once the browser is sent to the provider, and is usable again when Back restores the page from the back/forward cache", async () => {
    vi.spyOn(apiClient, "createIdentityLinkRequest").mockResolvedValue({ authorizationUrl: AUTHORIZATION_URL });
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZATION_URL));
    expect(within(dialog).getByRole("button", { name: "Continuing..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    // A page shown afresh (not from the cache) changes nothing: Escape is refused.
    pageShow(false);
    expect(within(dialog).getByRole("button", { name: "Continuing..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Link Google" })).toBeInTheDocument();

    // Back from the provider: restored as it left, then usable again (Ruling 89).
    pageShow(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(dialog).getByLabelText("Current Password")).toBeEnabled();
    expect((within(dialog).getByLabelText("Current Password") as HTMLInputElement).value).toBe("");
    expect(within(dialog).getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the dialog restored from the back/forward cache", async () => {
    vi.spyOn(apiClient, "createIdentityLinkRequest").mockResolvedValue({ authorizationUrl: AUTHORIZATION_URL });
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZATION_URL));
    pageShow(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,x"],
    ["plain http off the loopback host", "http://accounts.example.test/authorize?state=abc"],
    ["a loopback-looking host name", "http://127.0.0.1.example.test/authorize"],
    ["no URL at all", "not a url"],
  ])("refuses %s as the provider's address: no navigation, the link's fixed words", async (_name, authorizationUrl) => {
    vi.spyOn(apiClient, "createIdentityLinkRequest").mockResolvedValue({ authorizationUrl });
    const error = vi.spyOn(toast, "error");
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(LINK_START_FAILED_MESSAGE));
    expect(error).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(assign).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(PASSWORD);
  });

  it.each([
    ["https", AUTHORIZATION_URL],
    ["http on 127.0.0.1 (the browser tests' fake provider)", "http://127.0.0.1:28090/authorize?state=abc"],
  ])("goes to %s", async (_name, authorizationUrl) => {
    vi.spyOn(apiClient, "createIdentityLinkRequest").mockResolvedValue({ authorizationUrl });
    const error = vi.spyOn(toast, "error");
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(authorizationUrl));
    expect(error).not.toHaveBeenCalled();
  });

  it("takes https anywhere and http only on localhost, 127.0.0.1 or [::1], as the API's issuer rule", () => {
    expect(isProviderAddress("https://accounts.google.com/o/oauth2/v2/auth?state=abc")).toBe(true);
    expect(isProviderAddress("HTTPS://accounts.google.com/auth")).toBe(true);
    expect(isProviderAddress("http://localhost:28090/authorize")).toBe(true);
    expect(isProviderAddress("http://127.0.0.1:28090/authorize")).toBe(true);
    expect(isProviderAddress("http://[::1]:28090/authorize")).toBe(true);
    expect(isProviderAddress("http://accounts.google.com/auth")).toBe(false);
    expect(isProviderAddress("http://localhost.example.test/auth")).toBe(false);
    expect(isProviderAddress("javascript:alert(1)")).toBe(false);
    expect(isProviderAddress("JavaScript:alert(1)")).toBe(false);
    expect(isProviderAddress("data:text/html,x")).toBe(false);
    expect(isProviderAddress("vbscript:x")).toBe(false);
    expect(isProviderAddress("ftp://accounts.example.test/")).toBe(false);
    expect(isProviderAddress("//accounts.example.test/authorize")).toBe(false);
    expect(isProviderAddress("")).toBe(false);
  });

  it("another refusal toasts its fixed message and closes; the password never reaches a toast", async () => {
    vi.spyOn(apiClient, "createIdentityLinkRequest").mockRejectedValue(
      new ApiError("identity_already_linked", "Your account already has a sign-in with this provider.", { status: 409 }),
    );
    const error = vi.spyOn(toast, "error");
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Your account already has a sign-in with this provider."));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(JSON.stringify(error.mock.calls)).not.toContain(PASSWORD);
    expect(assign).not.toHaveBeenCalled();
  });
});
