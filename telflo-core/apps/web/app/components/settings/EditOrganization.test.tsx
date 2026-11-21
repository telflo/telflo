import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type ActiveOrganization } from "@telflo/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { EditOrganization } from "./EditOrganization.js";
import * as apiClient from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";

const PERSONAL: ActiveOrganization = { id: "00000000-0000-4000-8000-000000000002", name: "person", type: "personal", logoId: null, role: "admin" };
const BETA: ActiveOrganization = { id: "00000000-0000-4000-8000-000000000003", name: "Beta Team", type: "group", logoId: null, role: "admin" };
const ALPHA: ActiveOrganization = { id: "00000000-0000-4000-8000-000000000004", name: "alpha", type: "group", logoId: null, role: "contributor" };

function seed(active: ActiveOrganization, organizations: ActiveOrganization[] = [BETA, ALPHA, PERSONAL], mayCreateOrganizations = true) {
  useUserStore.getState().setCurrent({
    user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
    organization: active,
    organizations,
    isProductAdmin: false,
    mayCreateOrganizations,
    preferences: DEFAULT_USER_PREFERENCES,
  });
}

function renderPage() {
  const Stub = createRoutesStub([
    { path: "/settings/organization", Component: EditOrganization },
    { path: "/app", Component: () => <p>landed on /app</p> },
  ]);
  render(<Stub initialEntries={["/settings/organization"]} />);
}

/** Each organization's card title, in the order shown. */
function cardTitles(): string[] {
  return screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent ?? "");
}

/** The card whose title is `name`. */
function cardOf(name: string): HTMLElement {
  const card = screen.getByRole("heading", { level: 3, name }).closest<HTMLElement>(".rounded-lg");
  if (!card) throw new Error(`No card for ${name}`);
  return card;
}

describe("Settings → Organization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("has its heading, description and Create Organization button", async () => {
    seed(PERSONAL);
    renderPage();

    expect(await screen.findByRole("heading", { level: 2, name: "Organizations" })).toBeInTheDocument();
    expect(
      screen.getByText("Your personal workspace plus any group organizations you belong to."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Organization" })).toBeInTheDocument();
  });

  it("disables Create Organization, saying why in fixed words, while the site lets only product admins create one", async () => {
    seed(PERSONAL, [BETA, ALPHA, PERSONAL], false);
    renderPage();

    const button = await screen.findByRole("button", { name: "Create Organization" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Only product admins can create organizations on this site.")).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription("Only product admins can create organizations on this site.");
    await userEvent.setup().click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("enables Create Organization, with no such words, while the user may create one", async () => {
    seed(PERSONAL);
    renderPage();

    expect(await screen.findByRole("button", { name: "Create Organization" })).toBeEnabled();
    expect(screen.queryByText("Only product admins can create organizations on this site.")).toBeNull();
  });

  it("lists the personal organization first, then the others alphabetically, each with its initials", async () => {
    seed(PERSONAL);
    renderPage();
    await screen.findByText("Organizations");

    expect(cardTitles()).toEqual(["person", "alpha", "Beta Team"]);
    expect(within(cardOf("Beta Team")).getByText("BT")).toBeInTheDocument();
    expect(within(cardOf("person")).getByText("P")).toBeInTheDocument();
  });

  it("shows each card's logo by ids, inside ph-no-capture with alt \"\", and the initials where there is none", async () => {
    const logoId = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
    const beta = { ...BETA, logoId };
    seed(beta, [beta, ALPHA, PERSONAL]);
    renderPage();
    await screen.findByText("Organizations");

    const image = cardOf("Beta Team").querySelector("img");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", `/api/v1/organization-logos/${BETA.id}/${logoId}`);
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveClass("ph-no-capture");
    expect(within(cardOf("Beta Team")).queryByText("BT")).not.toBeInTheDocument();
    expect(cardOf("alpha").querySelector("img")).toBeNull();
    expect(within(cardOf("alpha")).getByText("A")).toBeInTheDocument();
    // No organization's name in any attribute.
    const attributes = [...document.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes].map((attribute) => attribute.value),
    );
    expect(attributes.some((value) => value.includes("Beta Team"))).toBe(false);
  });

  it("falls back to a card's initials when its logo fails to load", async () => {
    const beta = { ...BETA, logoId: "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b" };
    seed(beta, [beta, ALPHA, PERSONAL]);
    renderPage();
    await screen.findByText("Organizations");

    fireEvent.error(cardOf("Beta Team").querySelector("img")!);

    expect(cardOf("Beta Team").querySelector("img")).toBeNull();
    expect(within(cardOf("Beta Team")).getByText("BT")).toBeInTheDocument();
  });

  it("shows the initials on the card once Save removed the logo", async () => {
    const beta = { ...BETA, logoId: "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b" };
    seed(beta, [beta, ALPHA, PERSONAL]);
    const renameOrganization = vi
      .spyOn(apiClient, "renameOrganization")
      .mockResolvedValue({ organization: { id: BETA.id, name: "Beta Team", type: "group", logoId: null } });
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Organization" });
    await user.click(within(dialog).getByRole("button", { name: "Remove logo" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(renameOrganization).toHaveBeenCalledWith(BETA.id, { name: "Beta Team", removeLogo: true });
    expect(cardOf("Beta Team").querySelector("img")).toBeNull();
    expect(within(cardOf("Beta Team")).getByText("BT")).toBeInTheDocument();
  });

  it("shows a contributor the current organization's logo, with no Edit and so no picker", async () => {
    const alpha = { ...ALPHA, logoId: "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b" };
    seed(alpha, [BETA, alpha, PERSONAL]);
    renderPage();
    await screen.findByText("Organizations");

    expect(cardOf("alpha").querySelector("img")).toHaveAttribute("src", `/api/v1/organization-logos/${ALPHA.id}/${alpha.logoId}`);
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("badges the personal organization Personal and the active one Current", async () => {
    seed(BETA);
    renderPage();
    await screen.findByText("Organizations");

    expect(within(cardOf("person")).getByText("Personal")).toBeInTheDocument();
    expect(within(cardOf("person")).queryByText("Current")).not.toBeInTheDocument();
    expect(within(cardOf("Beta Team")).getByText("Current")).toBeInTheDocument();
    expect(within(cardOf("Beta Team")).queryByText("Personal")).not.toBeInTheDocument();
    expect(within(cardOf("alpha")).queryByText("Current")).not.toBeInTheDocument();
    expect(screen.getAllByText("Personal")).toHaveLength(1);
    expect(screen.getAllByText("Current")).toHaveLength(1);
  });

  it("shows Edit only on the current organization, even where the user administers others", async () => {
    // An admin of both, acting in Beta Team.
    seed(BETA);
    renderPage();
    await screen.findByText("Organizations");

    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    expect(within(cardOf("Beta Team")).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("shows no Edit to a contributor of the current organization, but still Create Organization", async () => {
    seed(ALPHA);
    renderPage();
    await screen.findByText("Organizations");

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Organization" })).toBeInTheDocument();
  });

  it("opens the create dialog from Create Organization", async () => {
    seed(ALPHA);
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Create Organization" }));

    expect(await screen.findByRole("dialog", { name: "Create Organization" })).toBeInTheDocument();
  });

  it("creates, switches to the new organization and goes to /app", async () => {
    seed(PERSONAL, [PERSONAL]);
    const created = { id: "00000000-0000-4000-8000-000000000005", name: "New Team", type: "group", logoId: null } as const;
    const createOrganization = vi.spyOn(apiClient, "createOrganization").mockResolvedValue({ organization: created });
    const switchOrganization = vi
      .spyOn(apiClient, "switchOrganization")
      .mockResolvedValue({ organization: { ...created, role: "admin" } });
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Create Organization" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Organization Name"), "  New Team ");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(createOrganization).toHaveBeenCalledWith({ name: "New Team" });
    expect(switchOrganization).toHaveBeenCalledWith({ organizationId: created.id });
    expect(createOrganization.mock.invocationCallOrder[0]).toBeLessThan(switchOrganization.mock.invocationCallOrder[0]!);
  });

  it("keeps the new organization listed, closes the dialog and toasts when the switch after a create fails", async () => {
    seed(PERSONAL, [PERSONAL]);
    const created = { id: "00000000-0000-4000-8000-000000000005", name: "New Team", type: "group", logoId: null } as const;
    vi.spyOn(apiClient, "createOrganization").mockResolvedValue({ organization: created });
    vi.spyOn(apiClient, "switchOrganization").mockRejectedValue(
      new apiClient.ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    const error = vi.spyOn(toast, "error");
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Create Organization" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Organization Name"), "New Team");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Failed to switch organization"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(cardTitles()).toEqual(["person", "New Team"]);
    // Still acting in the personal organization, so Edit stays on it.
    expect(within(cardOf("person")).getByText("Current")).toBeInTheDocument();
    expect(screen.queryByText("landed on /app")).not.toBeInTheDocument();
  });

  it("renames the current organization with Save, and lists the new name", async () => {
    seed(BETA);
    const renameOrganization = vi
      .spyOn(apiClient, "renameOrganization")
      .mockResolvedValue({ organization: { id: BETA.id, name: "Gamma Team", type: "group", logoId: null } });
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Organization" });
    const input = within(dialog).getByLabelText("Organization Name");
    expect(input).toHaveValue("Beta Team");
    await user.clear(input);
    await user.type(input, "Gamma Team");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(renameOrganization).toHaveBeenCalledWith(BETA.id, { name: "Gamma Team" });
    expect(cardTitles()).toEqual(["person", "alpha", "Gamma Team"]);
    expect(useUserStore.getState().current?.organization.name).toBe("Gamma Team");
  });

  it("offers Delete Organization in a group organization's Edit dialog, which opens the confirmation", async () => {
    seed(BETA);
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Organization" });
    await user.click(within(dialog).getByRole("button", { name: "Delete Organization" }));

    const confirmation = await screen.findByRole("dialog", { name: "Delete Organization" });
    expect(within(confirmation).getByText("Beta Team")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
  });

  it("offers no Delete Organization for a personal organization", async () => {
    seed(PERSONAL);
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Organization" });

    expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete Organization" })).not.toBeInTheDocument();
  });
});
