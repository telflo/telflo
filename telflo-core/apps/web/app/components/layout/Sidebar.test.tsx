import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_PREFERENCES,
  OPEN_SOURCE_SITE,
  type CurrentUserResponse,
  type OrganizationType,
  type SiteSettings,
} from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import { Sidebar } from "./Sidebar.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useUiStateStore } from "~/lib/stores/ui-state-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { SAAS_SITE, underSite } from "~/test/site.js";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";
const GROUP_ID = "00000000-0000-4000-8000-000000000003";
const initialEditorState = useEditorStore.getState();

function currentUser(
  role: CurrentUserResponse["organization"]["role"] = "admin",
  type: OrganizationType = "personal",
): CurrentUserResponse {
  return {
    user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
    organization: { id: ORGANIZATION_ID, name: type, type, logoId: null, role },
    organizations: [{ id: ORGANIZATION_ID, name: type, type, logoId: null, role }],
    termsAcceptanceRequired: false,
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: DEFAULT_USER_PREFERENCES,
  };
}

/** A user in their personal organization who also belongs to "Group". */
function withGroup(): CurrentUserResponse {
  const user = currentUser();
  return {
    ...user,
    organizations: [...user.organizations, { id: GROUP_ID, name: "Group", type: "group", logoId: null, role: "contributor" }],
  };
}

/** The open source's defaults with the user feedback on: the rail's Contact us. */
const FEEDBACK_ON = { ...OPEN_SOURCE_SITE, userFeedback: true };

/**
 * The Sidebar at `path`, with the open source's defaults (no Contact us, no
 * Learning) unless `site` is given: then under a root that hands it to
 * useSite(), so the rail renders once its loader has run (`findBy…`).
 */
function renderSidebar(path = "/app", site?: SiteSettings) {
  const routes = [
    { path: "/app", Component: Sidebar },
    { path: "/app/flows", Component: Sidebar },
    { path: "/product-admin/flows", Component: Sidebar },
    { path: "/fleet-management", Component: Sidebar },
    { path: "/fleet-management/:fleetId", Component: Sidebar },
    { path: "/variables", Component: Sidebar },
    { path: "/variables/groups", Component: Sidebar },
    { path: "/variables/groups/:variableGroupId", Component: Sidebar },
    { path: "/login", Component: () => <p>landed on /login</p> },
  ];
  const Stub = createRoutesStub(site === undefined ? routes : underSite(site, routes));
  const { container } = render(<Stub initialEntries={[path]} />);
  return container;
}

/** The sidebar's root element, once the stub has rendered it. */
async function sidebarRoot(container: HTMLElement): Promise<HTMLElement> {
  await screen.findByText("Workspace");
  return container.firstElementChild as HTMLElement;
}

async function openAccountMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByTitle("Switch organization"));
  return { user, menu: await screen.findByRole("dialog") };
}

function navLabels(): string[] {
  return within(screen.getByRole("navigation"))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUiStateStore.setState({ sidebarCollapsed: false });
    useUserStore.setState({ isSwitchingOrganization: false });
    useUserStore.getState().setCurrent(currentUser());
    useEditorStore.setState(initialEditorState, true);
  });

  it("renders expanded, showing nav labels", async () => {
    const root = await sidebarRoot(renderSidebar());

    expect(root.className).toContain("w-56");
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Configurations")).toBeInTheDocument();
  });

  it("shows six nav items for a group's admin, in its order, without Product Admin", async () => {
    useUserStore.getState().setCurrent(currentUser("admin", "group"));
    renderSidebar();
    await screen.findByText("Workspace");

    expect(navLabels()).toEqual([
      "Configurations",
      "Flows",
      "Variables",
      "Fleet",
      "Permissions",
      "Settings",
    ]);
    expect(screen.queryByText("Product Admin")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fleet" })).toHaveAttribute("href", "/fleet-management");
    expect(screen.getByRole("link", { name: "Permissions" })).toHaveAttribute("href", "/org-admin");
  });

  it("shows Product Admin to a product admin, in its place, linking to /product-admin", async () => {
    useUserStore.getState().setCurrent({ ...currentUser("admin", "group"), isProductAdmin: true });
    renderSidebar();
    await screen.findByText("Workspace");

    expect(navLabels()).toEqual([
      "Configurations",
      "Flows",
      "Variables",
      "Fleet",
      "Permissions",
      "Product Admin",
      "Settings",
    ]);
    expect(screen.getByRole("link", { name: "Product Admin" })).toHaveAttribute("href", "/product-admin");
  });

  it("shows Product Admin whatever the organization role, since the flag is the user's", async () => {
    useUserStore.getState().setCurrent({ ...currentUser("contributor"), isProductAdmin: true });
    renderSidebar();
    await screen.findByText("Workspace");

    expect(navLabels()).toEqual(["Configurations", "Flows", "Variables", "Fleet", "Product Admin", "Settings"]);
  });

  it("marks Product Admin as the current page on its pages", async () => {
    useUserStore.getState().setCurrent({ ...currentUser(), isProductAdmin: true });
    renderSidebar("/product-admin/flows");
    expect(await screen.findByRole("link", { name: "Product Admin" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Flows" })).not.toHaveAttribute("aria-current");
  });

  it("hides Product Admin again once the flag is cleared and the store re-seeded", async () => {
    useUserStore.getState().setCurrent({ ...currentUser(), isProductAdmin: true });
    renderSidebar();
    expect(await screen.findByRole("link", { name: "Product Admin" })).toBeInTheDocument();

    act(() => useUserStore.getState().setCurrent(currentUser()));

    await waitFor(() => expect(screen.queryByText("Product Admin")).not.toBeInTheDocument());
  });

  it("hides Permissions from a contributor but still shows Fleet", async () => {
    useUserStore.getState().setCurrent(currentUser("contributor"));
    renderSidebar();
    await screen.findByText("Workspace");

    expect(navLabels()).toEqual(["Configurations", "Flows", "Variables", "Fleet", "Settings"]);
  });

  // A personal workspace invites no one unless registration is open, so
  // its admin sees no Permissions then.
  it.each(["invite-only", "closed"] as const)("hides Permissions from a personal workspace's admin under %s registration", async (registration) => {
    const Stub = createRoutesStub(underSite({ ...OPEN_SOURCE_SITE, registration }, [{ path: "/app", Component: Sidebar }]));
    render(<Stub initialEntries={["/app"]} />);
    await screen.findByText("Workspace");

    expect(navLabels()).toEqual(["Configurations", "Flows", "Variables", "Fleet", "Settings"]);
  });

  it("shows Permissions to a personal workspace's admin while registration is open", async () => {
    const Stub = createRoutesStub(underSite(SAAS_SITE, [{ path: "/app", Component: Sidebar }]));
    render(<Stub initialEntries={["/app"]} />);
    await screen.findByText("Workspace");

    expect(screen.getByRole("link", { name: "Permissions" })).toHaveAttribute("href", "/org-admin");
  });

  it("shows Permissions to a group's admin under invite-only registration", async () => {
    useUserStore.getState().setCurrent(currentUser("admin", "group"));
    const Stub = createRoutesStub(underSite({ ...OPEN_SOURCE_SITE, registration: "invite-only" }, [{ path: "/app", Component: Sidebar }]));
    render(<Stub initialEntries={["/app"]} />);
    await screen.findByText("Workspace");

    expect(screen.getByRole("link", { name: "Permissions" })).toHaveAttribute("href", "/org-admin");
  });

  it("shows Learning last, linking to /library, only with TELFLO_LEARNING on", async () => {
    useUserStore.getState().setCurrent(currentUser("admin", "group"));
    renderSidebar("/app", { ...OPEN_SOURCE_SITE, learning: true });
    await screen.findByText("Workspace");

    expect(navLabels()).toEqual(["Configurations", "Flows", "Variables", "Fleet", "Permissions", "Settings", "Learning"]);
    expect(screen.getByRole("link", { name: "Learning" })).toHaveAttribute("href", "/library");
  });

  it("has neither Learning nor Contact us on the open source's defaults (TELFLO_LEARNING and TELFLO_USER_FEEDBACK off)", async () => {
    renderSidebar("/app", OPEN_SOURCE_SITE);
    await screen.findByText("Workspace");

    expect(screen.queryByRole("link", { name: "Learning" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Contact us" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Docs" })).toBeInTheDocument();
  });

  it("marks Configurations as the current page only on an exact /app match", async () => {
    renderSidebar("/app");
    expect(await screen.findByRole("link", { name: "Configurations" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Flows" })).not.toHaveAttribute("aria-current");
  });

  // The list and a fleet's page both mark Fleet.
  it.each(["/fleet-management", "/fleet-management/0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e"])("marks Fleet as the current page on %s", async (path) => {
    useUserStore.getState().setCurrent(currentUser("admin", "group"));
    renderSidebar(path);
    expect(await screen.findByRole("link", { name: "Fleet" })).toHaveAttribute("aria-current", "page");
    for (const other of ["Configurations", "Flows", "Variables", "Permissions"]) {
      expect(screen.getByRole("link", { name: other })).not.toHaveAttribute("aria-current");
    }
  });

  // "Variables", at /variables, with an icon that isn't a lock.
  it.each(["/variables", "/variables/groups", "/variables/groups/7b000000-0000-4000-8000-000000000001"])(
    "names Variables, linking to /variables, and marks it as the current page on %s",
    async (path) => {
      renderSidebar(path);
      const link = await screen.findByRole("link", { name: "Variables" });
      expect(link).toHaveAttribute("href", "/variables");
      expect(link).toHaveAttribute("aria-current", "page");
      expect(link.querySelector("svg")?.getAttribute("class")).not.toMatch(/lucide-lock/);
      expect(screen.queryByText("Vault")).toBeNull();
    },
  );

  it("marks Flows, not Configurations, as the current page on /app/flows", async () => {
    renderSidebar("/app/flows");
    expect(await screen.findByRole("link", { name: "Flows" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Configurations" })).not.toHaveAttribute("aria-current");
  });

  it("keeps the Docs link and puts Contact us after it, a title only when the rail is collapsed, as Docs'", async () => {
    renderSidebar("/app", FEEDBACK_ON);
    const contactUs = await screen.findByRole("button", { name: "Contact us" });
    const docs = screen.getByRole("link", { name: "Docs" });
    expect(docs).toHaveAttribute("href", "https://docs.telflo.com/docs");
    expect(docs.compareDocumentPosition(contactUs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(contactUs).not.toHaveAttribute("title");

    await userEvent.setup().click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByText("Contact us")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contact us" })).toHaveAttribute("title", "Contact us");
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("title", "Docs");
  });

  it("follows the site's docs link, and has none with TELFLO_DOCS_URL empty", async () => {
    const Elsewhere = createRoutesStub(underSite({ ...SAAS_SITE, docsUrl: "https://docs.example.org/telflo/" }, [{ path: "/app", Component: Sidebar }]));
    const first = render(<Elsewhere initialEntries={["/app"]} />);
    expect(await screen.findByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://docs.example.org/telflo/docs");
    first.unmount();

    const NoDocs = createRoutesStub(underSite({ ...SAAS_SITE, docsUrl: "" }, [{ path: "/app", Component: Sidebar }]));
    render(<NoDocs initialEntries={["/app"]} />);
    expect(await screen.findByRole("button", { name: "Contact us" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Docs" })).not.toBeInTheDocument();
  });

  it("opens Contact Us from the rail and sends the message, trimmed: the dialog closes on \"Thanks for your feedback!\"", async () => {
    const createFeedback = vi.spyOn(apiClient, "createFeedback").mockResolvedValue({ id: "00000000-0000-4000-8000-0000000000f1" });
    const success = vi.spyOn(toast, "success");
    renderSidebar("/app", FEEDBACK_ON);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Contact us" }));
    const dialog = await screen.findByRole("dialog", { name: "Contact Us" });
    await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "  Need a Kafka receiver.  ");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Contact Us" }) === null).toBe(true));
    // The person's words: a boolean, never the value printed.
    expect({ calls: createFeedback.mock.calls.length, trimmed: createFeedback.mock.calls[0]?.[0].text === "Need a Kafka receiver." }).toEqual({
      calls: 1,
      trimmed: true,
    });
    expect(success).toHaveBeenCalledWith("Thanks for your feedback!");
  });

  it("gives the focus back to the rail's Contact us as the dialog closes, by Escape or Cancel", async () => {
    renderSidebar("/app", FEEDBACK_ON);
    const user = userEvent.setup();
    const contactUs = await screen.findByRole("button", { name: "Contact us" });

    await user.click(contactUs);
    await screen.findByRole("dialog", { name: "Contact Us" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Contact Us" }) === null).toBe(true));
    await waitFor(() => expect(document.activeElement === contactUs).toBe(true));

    await user.click(contactUs);
    const dialog = await screen.findByRole("dialog", { name: "Contact Us" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Contact Us" }) === null).toBe(true));
    await waitFor(() => expect(document.activeElement === contactUs).toBe(true));
  });

  it("collapses to the icon rail and back with the collapse button", async () => {
    const root = await sidebarRoot(renderSidebar());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(root.className).toContain("w-12");
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Configurations")).not.toBeInTheDocument();
    // The switcher's tooltip names what it does, not the organization; the
    // name stays its accessible text.
    expect(screen.getByRole("button", { name: /personal/ })).toHaveAttribute("title", "Switch organization");
    expect(screen.queryByTitle("personal")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(root.className).toContain("w-56");
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Configurations")).toBeInTheDocument();
  });

  it("puts no organization name or email in any attribute, collapsed, expanded or with the popover open, since replay records attributes", async () => {
    const secretName = "Acme Private Holdings";
    const secretEmail = "private.person@acme.example";
    const user = currentUser();
    // Both with a logo: the <img> names neither.
    const organization = { ...user.organization, name: secretName, logoId: "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b" };
    useUserStore.getState().setCurrent({
      ...user,
      user: { ...user.user, email: secretEmail },
      organization,
      organizations: [
        organization,
        { id: GROUP_ID, name: "Another Private Group", type: "group", logoId: "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c", role: "contributor" },
      ],
    });
    /** Every attribute value in the document, the popover's portal included. */
    const attributeValues = () =>
      [...document.querySelectorAll("*")].flatMap((element) => [...element.attributes].map((attribute) => attribute.value));
    const leaks = () =>
      attributeValues().filter((value) => [secretName, secretEmail, "Another Private Group"].some((secret) => value.includes(secret)));

    await sidebarRoot(renderSidebar());
    expect(document.querySelectorAll("img[src^='/api/v1/organization-logos/']")).toHaveLength(1);
    expect(leaks()).toEqual([]);

    const { user: clicker } = await openAccountMenu();
    expect(document.querySelectorAll("img[src^='/api/v1/organization-logos/']")).toHaveLength(3);
    expect(screen.getByText(secretEmail)).toBeInTheDocument();
    expect(leaks()).toEqual([]);
    await clicker.keyboard("{Escape}");

    await clicker.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: new RegExp(secretName) })).toHaveAttribute("title", "Switch organization");
    expect(leaks()).toEqual([]);
  });

  it("shows the active organization's initial and name in the footer", async () => {
    renderSidebar();
    const footer = await screen.findByTitle("Switch organization");

    expect(footer).toHaveAttribute("data-tour-step", "org-switcher");
    expect(within(footer).getByText("P")).toBeInTheDocument();
    expect(within(footer).getByText("personal")).toBeInTheDocument();
  });

  it("shows the active organization's logo in the footer, by ids, inside ph-no-capture with alt \"\", in place of the initial", async () => {
    const logoId = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
    const user = currentUser();
    const organization = { ...user.organization, logoId };
    useUserStore.getState().setCurrent({ ...user, organization, organizations: [organization] });
    renderSidebar();
    const footer = await screen.findByTitle("Switch organization");

    const image = footer.querySelector("img");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", `/api/v1/organization-logos/${ORGANIZATION_ID}/${logoId}`);
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveClass("ph-no-capture", "h-6", "w-6", "rounded-[5px]", "object-contain", "shrink-0", "bg-white/90", "p-px");
    expect(within(footer).queryByText("P")).not.toBeInTheDocument();
    expect(within(footer).getByText("personal")).toBeInTheDocument();
  });

  it("follows the store: a new logo id re-renders the switcher's image with the new address, and none shows the initial", async () => {
    const logoId = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
    const newLogoId = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c";
    const user = currentUser();
    const organization = { ...user.organization, logoId };
    useUserStore.getState().setCurrent({ ...user, organization, organizations: [organization] });
    renderSidebar();
    const footer = await screen.findByTitle("Switch organization");
    expect(footer.querySelector("img")).toHaveAttribute("src", `/api/v1/organization-logos/${ORGANIZATION_ID}/${logoId}`);

    act(() => useUserStore.getState().updateOrganization(ORGANIZATION_ID, { name: "personal", logoId: newLogoId }));

    expect(footer.querySelector("img")).toHaveAttribute("src", `/api/v1/organization-logos/${ORGANIZATION_ID}/${newLogoId}`);
    expect(within(footer).queryByText("P")).not.toBeInTheDocument();

    act(() => useUserStore.getState().updateOrganization(ORGANIZATION_ID, { name: "personal", logoId: null }));

    expect(footer.querySelector("img")).toBeNull();
    expect(within(footer).getByText("P")).toBeInTheDocument();
  });

  it("falls back to the footer's initial when the logo fails to load", async () => {
    const user = currentUser();
    const organization = { ...user.organization, logoId: "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b" };
    useUserStore.getState().setCurrent({ ...user, organization, organizations: [organization] });
    renderSidebar();
    const footer = await screen.findByTitle("Switch organization");

    fireEvent.error(footer.querySelector("img")!);

    expect(footer.querySelector("img")).toBeNull();
    expect(within(footer).getByText("P")).toBeInTheDocument();
  });

  it("shows each listed organization's logo in the popover, and the initial where there is none or it fails", async () => {
    const logoId = "0193a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
    const user = withGroup();
    const group = { ...user.organizations[1]!, logoId };
    useUserStore.getState().setCurrent({ ...user, organizations: [user.organizations[0]!, group] });
    renderSidebar();
    const { menu } = await openAccountMenu();

    const groupRow = within(menu).getByRole("button", { name: /Group/ });
    const image = groupRow.querySelector("img");
    expect(image).toHaveAttribute("src", `/api/v1/organization-logos/${GROUP_ID}/${logoId}`);
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveClass("ph-no-capture", "h-5", "w-5", "rounded-[4px]", "object-contain", "shrink-0");
    expect(within(groupRow).queryByText("G")).not.toBeInTheDocument();
    const personalRow = within(menu).getByRole("button", { name: /personal/ });
    expect(personalRow.querySelector("img")).toBeNull();
    expect(within(personalRow).getByText("P")).toBeInTheDocument();

    fireEvent.error(image!);

    expect(groupRow.querySelector("img")).toBeNull();
    expect(within(groupRow).getByText("G")).toBeInTheDocument();
  });

  it("shows the email, the organization with a check, and Logout in the popover", async () => {
    renderSidebar();
    const { menu } = await openAccountMenu();

    expect(within(menu).getByText("Account")).toBeInTheDocument();
    expect(within(menu).getByText("person@example.com")).toBeInTheDocument();
    expect(within(menu).getByText("Organizations")).toBeInTheDocument();
    const row = within(menu).getByRole("button", { name: /personal/ });
    expect(row.querySelector(".lucide-check")).not.toBeNull();
    expect(within(menu).getByRole("button", { name: "Logout" })).toBeInTheDocument();
  });

  it("marks only the personal organization \"Personal Org\" in the popover", async () => {
    useUserStore.getState().setCurrent(withGroup());
    renderSidebar();
    const { menu } = await openAccountMenu();

    const personalRow = within(menu).getByRole("button", { name: /personal/ });
    expect(within(personalRow).getByText("Personal Org")).toHaveClass("text-[10px]", "text-muted-foreground");
    const groupRow = within(menu).getByRole("button", { name: /Group/ });
    expect(within(groupRow).queryByText("Personal Org")).not.toBeInTheDocument();
    expect(within(menu).getAllByText("Personal Org")).toHaveLength(1);
  });

  it("closes the popover when the active organization is picked", async () => {
    renderSidebar();
    const { user, menu } = await openAccountMenu();

    await user.click(within(menu).getByRole("button", { name: /personal/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  describe("switching organizations", () => {
    beforeEach(() => {
      useUserStore.getState().setCurrent(withGroup());
    });

    it("switches to another organization, closes the popover, and goes to /app", async () => {
      const switchOrganization = vi
        .spyOn(apiClient, "switchOrganization")
        .mockResolvedValue({ organization: { id: GROUP_ID, name: "Group", type: "group", logoId: null, role: "contributor" } });
      renderSidebar("/app/flows");
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /Group/ }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(switchOrganization).toHaveBeenCalledWith({ organizationId: GROUP_ID });
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Configurations" })).toHaveAttribute("aria-current", "page"),
      );
      expect(useUserStore.getState().isSwitchingOrganization).toBe(false);
    });

    it("switches while already on /app, and stays there", async () => {
      const switchOrganization = vi
        .spyOn(apiClient, "switchOrganization")
        .mockResolvedValue({ organization: { id: GROUP_ID, name: "Group", type: "group", logoId: null, role: "contributor" } });
      renderSidebar("/app");
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /Group/ }));

      await waitFor(() => expect(switchOrganization).toHaveBeenCalledWith({ organizationId: GROUP_ID }));
      await waitFor(() => expect(useUserStore.getState().isSwitchingOrganization).toBe(false));
      expect(screen.getByRole("link", { name: "Configurations" })).toHaveAttribute("aria-current", "page");
    });

    it("only closes the popover when the current organization is picked", async () => {
      const switchOrganization = vi.spyOn(apiClient, "switchOrganization");
      renderSidebar("/app/flows");
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /personal/ }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(switchOrganization).not.toHaveBeenCalled();
      expect(screen.getByRole("link", { name: "Flows" })).toHaveAttribute("aria-current", "page");
      expect(useUserStore.getState().isSwitchingOrganization).toBe(false);
    });

    it("toasts its message and stays when the switch fails", async () => {
      vi.spyOn(apiClient, "switchOrganization").mockRejectedValue(
        new ApiError("network_error", "Could not reach the server. Check your connection."),
      );
      const error = vi.spyOn(toast, "error");
      renderSidebar("/app/flows");
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /Group/ }));

      await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Failed to switch organization"));
      expect(screen.getByRole("link", { name: "Flows" })).toHaveAttribute("aria-current", "page");
      expect(useUserStore.getState().isSwitchingOrganization).toBe(false);
      expect(useUserStore.getState().current?.organization.id).toBe(ORGANIZATION_ID);
    });

    it("toasts the API's refusal when the switch is refused", async () => {
      vi.spyOn(apiClient, "switchOrganization").mockRejectedValue(
        new ApiError("organization_access_denied", "You are not an active member of this organization"),
      );
      const error = vi.spyOn(toast, "error");
      renderSidebar("/app/flows");
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /Group/ }));

      await vi.waitFor(() =>
        expect(error).toHaveBeenCalledWith("You are not an active member of this organization"),
      );
      expect(screen.getByRole("link", { name: "Flows" })).toHaveAttribute("aria-current", "page");
    });

    it("sets the switching flag while the switch is in flight", async () => {
      let finish!: () => void;
      vi.spyOn(apiClient, "switchOrganization").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ organization: { id: GROUP_ID, name: "Group", type: "group", logoId: null, role: "contributor" } });
          }),
      );
      renderSidebar("/app/flows");
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /Group/ }));

      expect(useUserStore.getState().isSwitchingOrganization).toBe(true);
      finish();
      await waitFor(() => expect(useUserStore.getState().isSwitchingOrganization).toBe(false));
    });
  });

  it("logs out: ends the session, clears the user, resets PostHog, confirms, and goes to /login", async () => {
    const deleteSession = vi.spyOn(apiClient, "deleteCurrentSession").mockResolvedValue(undefined);
    const signedOutLocally = vi.spyOn(analytics, "signedOutLocally");
    const success = vi.spyOn(toast, "success");
    renderSidebar();
    const { user, menu } = await openAccountMenu();

    await user.click(within(menu).getByRole("button", { name: "Logout" }));

    expect(await screen.findByText("landed on /login")).toBeInTheDocument();
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(useUserStore.getState().current).toBeNull();
    expect(signedOutLocally).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith("Logged out successfully");
  });

  it("stays put, keeps the user and says so when logout fails", async () => {
    vi.spyOn(apiClient, "deleteCurrentSession").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    const signedOutLocally = vi.spyOn(analytics, "signedOutLocally");
    renderSidebar();
    const { user, menu } = await openAccountMenu();

    await user.click(within(menu).getByRole("button", { name: "Logout" }));

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Failed to log out"));
    expect(success).not.toHaveBeenCalled();
    expect(signedOutLocally).not.toHaveBeenCalled();
    const { termsAcceptanceRequired: _flag, ...stored } = currentUser();
    expect(useUserStore.getState().current).toEqual(stored);
    expect(screen.queryByText("landed on /login")).not.toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  describe("while the editor holds unsaved text", () => {
    const GROUP = { id: GROUP_ID, name: "Group", type: "group", logoId: null, role: "contributor" } as const;

    /** A configuration open in the editor, with its text as last saved, or edited since. */
    function editorWith(text: "saved" | "edited") {
      useEditorStore.setState({
        organizationId: ORGANIZATION_ID,
        text: text === "saved" ? "receivers: {}\n" : "receivers: {}\n# edited\n",
        savedText: "receivers: {}\n",
      });
    }

    async function refusal() {
      return screen.findByRole("dialog", { name: "Unsaved changes" });
    }

    beforeEach(() => {
      useUserStore.getState().setCurrent(withGroup());
    });

    it("refuses switching with the unsaved-changes dialog, and never sends the switch", async () => {
      editorWith("edited");
      const switchOrganization = vi.spyOn(apiClient, "switchOrganization").mockResolvedValue({ organization: GROUP });
      renderSidebar("/app/flows");
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /Group/ }));

      const dialog = await refusal();
      expect(dialog).toHaveAccessibleDescription(
        "You have unsaved changes in the editor. Save them before switching organizations.",
      );
      expect(within(dialog).getByRole("button", { name: "OK" })).toBeInTheDocument();
      // Only OK, and the dialog's own close.
      expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["OK", "Close"]);
      expect(switchOrganization).not.toHaveBeenCalled();
      expect(useUserStore.getState().isSwitchingOrganization).toBe(false);

      await user.click(within(dialog).getByRole("button", { name: "OK" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(switchOrganization).not.toHaveBeenCalled();
      expect(screen.getByRole("link", { name: "Flows" })).toHaveAttribute("aria-current", "page");
      expect(useUserStore.getState().current?.organization.id).toBe(ORGANIZATION_ID);
    });

    it("refuses Logout with its own dialog, and never signs out", async () => {
      editorWith("edited");
      const deleteSession = vi.spyOn(apiClient, "deleteCurrentSession").mockResolvedValue(undefined);
      const signedOutLocally = vi.spyOn(analytics, "signedOutLocally");
      renderSidebar();
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: "Logout" }));

      const dialog = await refusal();
      expect(dialog).toHaveAccessibleDescription(
        "You have unsaved changes in the editor. Save them before signing out.",
      );
      expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["OK", "Close"]);

      await user.click(within(dialog).getByRole("button", { name: "OK" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(deleteSession).not.toHaveBeenCalled();
      expect(signedOutLocally).not.toHaveBeenCalled();
      expect(useUserStore.getState().current).not.toBeNull();
      expect(useEditorStore.getState().text).toBe("receivers: {}\n# edited\n");
      expect(screen.queryByText("landed on /login")).toBeNull();
    });

    it("only closes the popover when the current organization is picked", async () => {
      editorWith("edited");
      const switchOrganization = vi.spyOn(apiClient, "switchOrganization");
      renderSidebar();
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /personal/ }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(switchOrganization).not.toHaveBeenCalled();
    });

    it("switches when the open configuration's text is saved", async () => {
      editorWith("saved");
      const switchOrganization = vi.spyOn(apiClient, "switchOrganization").mockResolvedValue({ organization: GROUP });
      renderSidebar("/app/flows");
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: /Group/ }));

      expect(switchOrganization).toHaveBeenCalledWith({ organizationId: GROUP_ID });
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Configurations" })).toHaveAttribute("aria-current", "page"),
      );
      expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).toBeNull();
    });

    it("logs out when the open configuration's text is saved, and forgets the editor's configuration", async () => {
      editorWith("saved");
      const deleteSession = vi.spyOn(apiClient, "deleteCurrentSession").mockResolvedValue(undefined);
      renderSidebar();
      const { user, menu } = await openAccountMenu();

      await user.click(within(menu).getByRole("button", { name: "Logout" }));

      expect(await screen.findByText("landed on /login")).toBeInTheDocument();
      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(useEditorStore.getState().organizationId).toBeNull();
      expect(useEditorStore.getState().text).toBe("");
    });
  });
});
