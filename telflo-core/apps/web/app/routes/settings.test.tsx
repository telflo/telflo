import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, OPEN_SOURCE_SITE, type CurrentUserResponse, type SiteSettings } from "@telflo/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import routes from "../routes.js";
import AppLayoutRoute, { shouldRevalidate, type AppLayoutData } from "./app-layout.js";
import SettingsRoute, { loader, meta } from "./settings.js";
import SettingsAccountRoute from "./settings/account.js";
import SettingsAppearanceRoute from "./settings/appearance.js";
import SettingsEditorRoute from "./settings/editor.js";
import SettingsNotificationsRoute, { loader as notificationsLoader } from "./settings/notifications.js";
import SettingsOrganizationRoute from "./settings/organization.js";
import SettingsServiceAccountRoute from "./settings/service-accounts.$serviceAccountId.js";
import SettingsServiceAccountsRoute from "./settings/service-accounts.js";
import * as apiClient from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { SAAS_SITE, underSite } from "~/test/site.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

const CONTRIBUTOR: CurrentUserResponse = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
  organization: { id: "00000000-0000-4000-8000-000000000003", name: "Group", type: "group", logoId: null, role: "contributor" },
  organizations: [
    { id: "00000000-0000-4000-8000-000000000002", name: "person", type: "personal", logoId: null, role: "admin" },
    { id: "00000000-0000-4000-8000-000000000003", name: "Group", type: "group", logoId: null, role: "contributor" },
  ],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

/** The same member, an admin of the active group organization. */
const ADMIN: CurrentUserResponse = {
  ...CONTRIBUTOR,
  organization: { ...CONTRIBUTOR.organization, role: "admin" },
  organizations: [CONTRIBUTOR.organizations[0]!, { ...CONTRIBUTOR.organizations[1]!, role: "admin" }],
};

const SERVICE_ACCOUNT_ID = "00000000-0000-4000-8000-0000000000c1";

function loaderArgs(url: string): Parameters<typeof loader>[0] {
  return { request: new Request(url), params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
}

/**
 * A Settings page (Organization by default) under the signed-in layout, as the
 * app routes it, for `currentUser`, on `site` (the SaaS's by default:
 * Settings › Notifications shown).
 */
function renderSettings(path = "/settings/organization", currentUser: CurrentUserResponse = CONTRIBUTOR, site: SiteSettings = SAAS_SITE) {
  const Stub = createRoutesStub(underSite(site, [
    {
      id: "routes/app-layout",
      Component: AppLayoutRoute as unknown as React.ComponentType,
      loader: (): AppLayoutData => ({ status: "signed_in", currentUser }),
      shouldRevalidate,
      HydrateFallback: () => null,
      children: [
        {
          path: "/settings",
          Component: SettingsRoute as unknown as React.ComponentType,
          loader,
          children: [
            { path: "appearance", Component: SettingsAppearanceRoute },
            { path: "account", Component: SettingsAccountRoute },
            { path: "editor", Component: SettingsEditorRoute },
            { path: "notifications", Component: SettingsNotificationsRoute },
            { path: "organization", Component: SettingsOrganizationRoute },
            { path: "service-accounts", Component: SettingsServiceAccountsRoute },
            { path: "service-accounts/:serviceAccountId", Component: SettingsServiceAccountRoute },
          ],
        },
        { path: "/app", Component: () => <p>landed on /app</p> },
      ],
    },
  ]));
  render(<Stub initialEntries={[path]} />);
}

describe("the settings routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    vi.spyOn(apiClient, "getOrganizationSettings").mockResolvedValue({ publicInstallLinks: true });
    // Settings › Account's reads.
    vi.spyOn(apiClient, "getSignInMethods").mockResolvedValue({ hasPassword: true, identities: [], providers: [] });
    vi.spyOn(apiClient, "listSessions").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(apiClient, "getPersonalApiTokens").mockResolvedValue({ items: [] });
    // Settings › Service Accounts' reads.
    vi.spyOn(apiClient, "getServiceAccounts").mockResolvedValue({ items: [] });
  });

  it("routes the four Personal pages, Organization, Service Accounts and an account's page", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    const settings = layout?.children?.find((route) => route.path === "settings");
    expect(settings?.file).toBe("routes/settings.tsx");
    expect(settings?.children?.map((route) => [route.path, route.file])).toEqual([
      ["appearance", "routes/settings/appearance.tsx"],
      ["account", "routes/settings/account.tsx"],
      ["editor", "routes/settings/editor.tsx"],
      ["notifications", "routes/settings/notifications.tsx"],
      ["organization", "routes/settings/organization.tsx"],
      ["service-accounts", "routes/settings/service-accounts.tsx"],
      ["service-accounts/:serviceAccountId", "routes/settings/service-accounts.$serviceAccountId.tsx"],
    ]);
  });

  it("sends /settings to /settings/appearance", () => {
    for (const url of ["http://localhost/settings", "http://localhost/settings/"]) {
      let thrown: unknown;
      try {
        loader(loaderArgs(url));
      } catch (caught) {
        thrown = caught;
      }
      if (!(thrown instanceof Response)) throw new Error(`${url} did not redirect`);
      expect(thrown.status).toBe(302);
      expect(thrown.headers.get("location")).toBe("/settings/appearance");
    }
  });

  it("leave the pages alone", () => {
    for (const page of ["appearance", "account", "editor", "notifications", "organization", "service-accounts", `service-accounts/${SERVICE_ACCOUNT_ID}`]) {
      expect(loader(loaderArgs(`http://localhost/settings/${page}`))).toBeNull();
    }
  });

  it("title the pages", () => {
    expect(meta({} as Parameters<typeof meta>[0])).toContainEqual({ title: "Settings - Telflo" });
  });

  it("the Personal group comes first, with its words and order", async () => {
    renderSettings();

    expect(await screen.findByRole("heading", { level: 2, name: "Settings" })).toBeInTheDocument();
    const groups = screen.getAllByRole("heading", { level: 3 }).filter((heading) => heading.classList.contains("tf-label"));
    expect(groups.map((heading) => heading.textContent)).toEqual(["Personal", "Organization"]);
    const nav = groups[0]!.closest("nav")!;
    const items = within(nav).getAllByRole("button");
    expect(items.map((button) => button.textContent)).toEqual(["Appearance", "Account", "Editor", "Notifications", "Organization"]);
    // Each item's icon.
    expect(items.map((button) => button.querySelector("svg")?.getAttribute("class"))).toEqual([
      expect.stringContaining("lucide-palette"),
      expect.stringContaining("lucide-user"),
      expect.stringContaining("lucide-code"),
      expect.stringContaining("lucide-bell"),
      expect.stringContaining("lucide-building2"),
    ]);
    expect(within(groups[0]!.parentElement!).getAllByRole("button")).toEqual(items.slice(0, 4));
    expect(within(nav).getByRole("button", { name: "Organization" })).toHaveClass("bg-accent", "text-foreground");
    for (const other of ["Appearance", "Account", "Editor", "Notifications"]) {
      expect(within(nav).getByRole("button", { name: other })).not.toHaveClass("bg-accent");
    }
    for (const hidden of ["AI", "Service Accounts", "Billing", "Payment"]) {
      expect(within(nav).queryByText(hidden)).not.toBeInTheDocument();
    }
    // A contributor still gets the page, with Create and without Edit.
    expect(screen.getByRole("heading", { level: 2, name: "Organizations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Organization" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    // The signed-in shell is around it.
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });

  // The open source's default leaves Notifications out of the nav.
  it("leaves Notifications out of the Personal group with TELFLO_EMAIL_NOTIFICATIONS off, the open source's default", async () => {
    renderSettings("/settings/appearance", CONTRIBUTOR, OPEN_SOURCE_SITE);
    const groups = (await screen.findAllByRole("heading", { level: 3 })).filter((heading) => heading.classList.contains("tf-label"));
    expect(groups.map((heading) => heading.textContent)).toEqual(["Personal", "Organization"]);
    const personal = within(groups[0]!.parentElement!).getAllByRole("button");
    expect(personal.map((button) => button.textContent)).toEqual(["Appearance", "Account", "Editor"]);
    const nav = groups[0]!.closest("nav")!;
    expect(within(nav).queryByRole("button", { name: "Notifications" })).not.toBeInTheDocument();
    expect(within(nav).queryByText("Notifications")).not.toBeInTheDocument();
  });

  it("each Personal item opens its page, the item current", async () => {
    renderSettings("/settings/appearance");
    const user = userEvent.setup();
    const nav = (await screen.findByRole("heading", { level: 2, name: "Settings" })).closest("div")!.parentElement!;
    expect(await screen.findByRole("heading", { level: 3, name: "Appearance" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Appearance" })).toHaveClass("bg-accent");

    const pages = [
      ["Account", "Account"],
      ["Editor", "Editor Preferences"],
      ["Notifications", "Email Notifications"],
      ["Appearance", "Appearance"],
    ] as const;
    for (const [item, heading] of pages) {
      await user.click(within(nav).getByRole("button", { name: item }));
      expect(await screen.findByRole("heading", { level: 3, name: heading })).toBeInTheDocument();
      expect(within(nav).getByRole("button", { name: item })).toHaveClass("bg-accent");
    }
    // Account's card shows the signed-in address as text.
    await user.click(within(nav).getByRole("button", { name: "Account" }));
    expect(await screen.findByText(CONTRIBUTOR.user.email)).toBeInTheDocument();
  });

  // Service Accounts after Organization, for admins of the active organization only.
  it("an admin sees Service Accounts after Organization, with the Bot icon; a contributor doesn't", async () => {
    renderSettings("/settings/organization", ADMIN);
    const groups = (await screen.findAllByRole("heading", { level: 3 })).filter((heading) => heading.classList.contains("tf-label"));
    expect(groups.map((heading) => heading.textContent)).toEqual(["Personal", "Organization"]);
    const organizationItems = within(groups[1]!.parentElement!).getAllByRole("button");
    expect(organizationItems.map((button) => button.textContent)).toEqual(["Organization", "Service Accounts"]);
    expect(organizationItems[1]!.querySelector("svg")?.getAttribute("class")).toContain("lucide-bot");
    expect(organizationItems[1]).not.toHaveClass("bg-accent");

    const user = userEvent.setup();
    await user.click(organizationItems[1]!);
    expect(await screen.findByRole("heading", { name: "Service Accounts" })).toBeInTheDocument();
    expect(within(groups[1]!.parentElement!).getByRole("button", { name: "Service Accounts" })).toHaveClass("bg-accent");
    expect(within(groups[1]!.parentElement!).getByRole("button", { name: "Organization" })).not.toHaveClass("bg-accent");
  });

  it("the item stays current on an account's page", async () => {
    vi.spyOn(apiClient, "getServiceAccount").mockResolvedValue({
      serviceAccount: {
        id: SERVICE_ACCOUNT_ID,
        name: "ci-pipeline",
        email: "ci-pipeline-a3f9c1e2@service-accounts.telflo.invalid",
        createdAt: "2026-09-01T12:00:00.000Z",
        createdBy: null,
        tokenCount: 0,
      },
    });
    vi.spyOn(apiClient, "getApiTokens").mockResolvedValue({ items: [] });
    renderSettings(`/settings/service-accounts/${SERVICE_ACCOUNT_ID}`, ADMIN);
    expect(await screen.findByRole("heading", { name: "ci-pipeline" })).toBeInTheDocument();
    const nav = screen.getByRole("heading", { level: 2, name: "Settings" }).closest("div")!.parentElement!;
    expect(within(nav).getByRole("button", { name: "Service Accounts" })).toHaveClass("bg-accent", "text-foreground");
    for (const other of ["Appearance", "Account", "Editor", "Notifications", "Organization"]) {
      expect(within(nav).getByRole("button", { name: other })).not.toHaveClass("bg-accent");
    }
  });

  it("a personal organization's owner, its admin, sees Service Accounts too", async () => {
    const personal = { ...CONTRIBUTOR.organizations[0]! };
    renderSettings("/settings/appearance", { ...CONTRIBUTOR, organization: personal });
    expect(await screen.findByRole("button", { name: "Service Accounts" })).toBeInTheDocument();
  });

  // The current organization's switch, below the list; a contributor's disabled.
  it("show the current organization's Public install links card below the list, read for a contributor and disabled", async () => {
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: "Public install links" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(apiClient.getOrganizationSettings).toHaveBeenCalledWith(CONTRIBUTOR.organization.id, expect.anything());
    const list = screen.getByRole("heading", { level: 2, name: "Organizations" });
    expect(list.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("list the user's organizations", async () => {
    renderSettings();

    expect(await screen.findByRole("heading", { level: 3, name: "person" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Group" })).toBeInTheDocument();
  });

  it("create an organization from the page, then switch to it behind the spinner, and land on /app", async () => {
    const created = { id: "00000000-0000-4000-8000-000000000005", name: "Team", type: "group", logoId: null } as const;
    vi.spyOn(apiClient, "createOrganization").mockResolvedValue({ organization: created });
    let finish!: () => void;
    const switchOrganization = vi.spyOn(apiClient, "switchOrganization").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ organization: { ...created, role: "admin" } });
        }),
    );
    renderSettings();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Create Organization" }));
    await user.type(await screen.findByLabelText("Organization Name"), "Team");
    await user.click(screen.getByRole("button", { name: "Create" }));

    // The page, dialog included, gives way to the spinner while switching.
    expect(await screen.findByRole("status", { name: "Switching organization" })).toBeInTheDocument();
    expect(switchOrganization).toHaveBeenCalledWith({ organizationId: created.id });
    finish();

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(useUserStore.getState().isSwitchingOrganization).toBe(false);
  });
});

// Settings › Notifications' page answers from its server loader, read at
// request time; the tests' setup pins the SaaS's values (on), and each case
// here sets its own.
describe("Settings › Notifications' switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** What the loader threw, or "returned" when it didn't. */
  function thrownByNotificationsLoader(): unknown {
    try {
      notificationsLoader();
    } catch (caught) {
      return caught;
    }
    return "returned";
  }

  it("is a 404 with TELFLO_EMAIL_NOTIFICATIONS unset or \"\", the open source's default", () => {
    for (const value of [undefined, ""]) {
      vi.stubEnv("TELFLO_EMAIL_NOTIFICATIONS", value);
      const thrown = thrownByNotificationsLoader();
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(404);
    }
  });

  it('is a 404 with TELFLO_EMAIL_NOTIFICATIONS "false" too', () => {
    vi.stubEnv("TELFLO_EMAIL_NOTIFICATIONS", "false");
    expect((thrownByNotificationsLoader() as Response).status).toBe(404);
  });

  it('renders with TELFLO_EMAIL_NOTIFICATIONS "true"', () => {
    vi.stubEnv("TELFLO_EMAIL_NOTIFICATIONS", "true");
    expect(thrownByNotificationsLoader()).toBe("returned");
    expect(notificationsLoader()).toBeNull();
  });
});
