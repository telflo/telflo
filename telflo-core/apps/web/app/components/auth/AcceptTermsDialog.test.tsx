import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse } from "@telflo/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLoaderData } from "react-router";
import { toast } from "sonner";
import { AcceptTermsDialog } from "./AcceptTermsDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";

/** The site's Terms version the layout passes in (D36-1 decision 29): the SaaS's. */
const TERMS_VERSION = "2026-01-01";
/** The site's Terms (D36-1 decision 32): its version and the two documents' URLs. */
const TERMS = { version: TERMS_VERSION, termsUrl: "/home/terms-of-service", privacyUrl: "https://legal.example.com/privacy" };

const CURRENT_USER: CurrentUserResponse = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
  organization: { id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: true,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

/**
 * The dialog on `/app`, open while the route's loader says so, as the layout
 * renders it. `loader` counts revalidations.
 */
function renderDialog(
  loader: () => { required: boolean } = () => ({ required: true }),
  terms: typeof TERMS | null = TERMS,
) {
  const routeLoader = vi.fn(loader);
  function Page() {
    const { required } = useLoaderData<{ required: boolean }>();
    return (
      <>
        <p>the page</p>
        <AcceptTermsDialog open={required} terms={terms} />
      </>
    );
  }
  const Stub = createRoutesStub([
    { path: "/app", Component: Page, loader: routeLoader, HydrateFallback: () => null },
    { path: "/login", Component: () => <p>landed on /login</p> },
  ]);
  render(<Stub initialEntries={["/app"]} />);
  return { routeLoader, user: userEvent.setup() };
}

const dialog = () => screen.findByRole("dialog", { name: "Updated Terms of Service" });

describe("AcceptTermsDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().setCurrent(CURRENT_USER);
  });

  it("shows the title, description, agreement and buttons, with no close button", async () => {
    renderDialog();
    const shown = await dialog();

    expect(within(shown).getByText("Updated Terms of Service")).toBeInTheDocument();
    expect(
      within(shown).getByText(
        "Our Terms of Service have been updated. Please review and accept them to continue using the service.",
      ),
    ).toBeInTheDocument();
    expect(within(shown).getByLabelText("I agree to the Terms of Service and Privacy Policy")).toBeInTheDocument();
    expect(within(shown).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(shown).getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(within(shown).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    // Cancel and Accept alone: Terms and Privacy are links, not buttons.
    expect(within(shown).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Accept"]);
  });

  it("links the site's Terms of Service and Privacy Policy, each in a new tab (Ruling 20; D36-1 decision 32)", async () => {
    renderDialog();
    const shown = await dialog();

    const links = within(shown).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Terms of Service", "/home/terms-of-service"],
      ["Privacy Policy", "https://legal.example.com/privacy"],
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("leaves the box unticked, and Accept disabled, when a document's link is clicked", async () => {
    const { user } = renderDialog();
    const shown = await dialog();
    const checkbox = within(shown).getByRole("checkbox", { name: "I agree to the Terms of Service and Privacy Policy" });

    await user.click(within(shown).getByRole("link", { name: "Terms of Service" }));
    await user.click(within(shown).getByRole("link", { name: "Privacy Policy" }));

    expect(checkbox).not.toBeChecked();
    expect(within(shown).getByRole("button", { name: "Accept" })).toBeDisabled();

    // The agreement's own words still tick it.
    await user.click(within(shown).getByText("I agree to the"));
    expect(checkbox).toBeChecked();
  });

  it("renders nothing when not open", async () => {
    renderDialog(() => ({ required: false }));

    expect(await screen.findByText("the page")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never opens on a site that asks for no Terms, whatever open says (D36-1 decision 32)", async () => {
    renderDialog(() => ({ required: true }), null);

    expect(await screen.findByText("the page")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays open when Escape is pressed", async () => {
    const { user } = renderDialog();
    await dialog();

    await user.keyboard("{Escape}");

    expect(await dialog()).toBeInTheDocument();
  });

  it("stays open on a click outside it", async () => {
    renderDialog();
    const shown = await dialog();
    const overlay = shown.previousElementSibling ?? document.body;

    // user-event refuses to click through the modal's pointer-events: none,
    // so the events Radix listens for are sent directly.
    fireEvent.pointerDown(overlay);
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);

    expect(await dialog()).toBeInTheDocument();
  });

  it("keeps Accept disabled until the box is ticked, then sends the current version, shows Accepting... and revalidates", async () => {
    let finish: () => void = () => {};
    const accept = vi
      .spyOn(apiClient, "acceptTerms")
      .mockImplementation(() => new Promise((resolve) => (finish = () => resolve(undefined))));
    let required = true;
    const { user, routeLoader } = renderDialog(() => ({ required }));
    const shown = await dialog();
    const acceptButton = within(shown).getByRole("button", { name: "Accept" });

    expect(acceptButton).toBeDisabled();
    await user.click(acceptButton);
    expect(accept).not.toHaveBeenCalled();

    await user.click(within(shown).getByLabelText("I agree to the Terms of Service and Privacy Policy"));
    expect(acceptButton).toBeEnabled();
    await user.click(acceptButton);

    expect(await within(shown).findByRole("button", { name: "Accepting..." })).toBeDisabled();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({ version: TERMS_VERSION });
    expect(routeLoader).toHaveBeenCalledTimes(1);

    required = false;
    await act(async () => finish());

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(routeLoader).toHaveBeenCalledTimes(2);
    expect(screen.getByText("the page")).toBeInTheDocument();
  });

  it("shows the ApiError's message when Accept fails, stays open, and lets Accept be tried again", async () => {
    vi.spyOn(apiClient, "acceptTerms").mockRejectedValue(
      new ApiError("terms_version_not_current", "These terms are out of date. Reload the page to see the current terms."),
    );
    const { user, routeLoader } = renderDialog();
    const shown = await dialog();

    await user.click(within(shown).getByLabelText("I agree to the Terms of Service and Privacy Policy"));
    await user.click(within(shown).getByRole("button", { name: "Accept" }));

    expect(await within(shown).findByRole("alert")).toHaveTextContent(
      "These terms are out of date. Reload the page to see the current terms.",
    );
    expect(within(shown).getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(routeLoader).toHaveBeenCalledTimes(1);
    expect(await dialog()).toBeInTheDocument();
  });

  it("Cancel logs out, clears the user and goes to /login", async () => {
    const deleteSession = vi.spyOn(apiClient, "deleteCurrentSession").mockResolvedValue(undefined);
    const accept = vi.spyOn(apiClient, "acceptTerms");
    const success = vi.spyOn(toast, "success");
    const { user } = renderDialog();
    const shown = await dialog();

    await user.click(within(shown).getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("landed on /login")).toBeInTheDocument();
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
    expect(useUserStore.getState().current).toBeNull();
    expect(success).toHaveBeenCalledWith("Logged out successfully");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays, keeps the user and says so when Cancel's logout fails", async () => {
    vi.spyOn(apiClient, "deleteCurrentSession").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    const { user } = renderDialog();
    const shown = await dialog();

    await user.click(within(shown).getByRole("button", { name: "Cancel" }));

    expect(await within(shown).findByRole("alert")).toHaveTextContent("Failed to log out");
    expect(useUserStore.getState().current).not.toBeNull();
    expect(screen.queryByText("landed on /login")).not.toBeInTheDocument();
    expect(await dialog()).toBeInTheDocument();
  });
});
