import { useState } from "react";
import { createRoutesStub, Link, useLocation } from "react-router";
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_SOURCE_SITE, type SiteSettings } from "@telflo/contracts";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { PlaygroundProvider } from "~/lib/playground/provider.js";
import { usePlaygroundSurface } from "~/lib/playground/surface.js";
import { PlaygroundLinkScope, playgroundPathFor } from "./PlaygroundLinkScope.js";
import { PlaygroundShell } from "./PlaygroundShell.js";
import { SIGNUP_PROMPT_TITLE, signupPromptText } from "./SignupPromptDialog.js";
import { SAAS_SITE, underSite } from "~/test/site.js";

/*
 * The shell, the sidebar, the banner and the lock.
 */

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/**
 * The shell in its provider at `path`, as the playground's layout renders it.
 * With `site`, root's site data (the page renders once its loader has run);
 * without, the open source's defaults.
 */
function renderShell(path = "/playground", page = <Where />, site?: SiteSettings) {
  const Shell = () => (
    <PlaygroundProvider>
      <PlaygroundShell>{page}</PlaygroundShell>
    </PlaygroundProvider>
  );
  const pages = [
    { path: "/playground", Component: Shell },
    { path: "/playground/*", Component: Shell },
    { path: "/register", Component: Where },
    { path: "/login", Component: Where },
  ];
  const Stub = createRoutesStub(site === undefined ? pages : underSite(site, pages));
  return render(<Stub initialEntries={[path]} />);
}

afterEach(() => {
  document.body.className = "";
  vi.restoreAllMocks();
});

describe("the banner", () => {
  it.each([
    ["open, the SaaS's", SAAS_SITE, true],
    ["invitation-only, the open source's default", { ...SAAS_SITE, registration: OPEN_SOURCE_SITE.registration }, false],
  ] as const)("says its words with Sign in; registration %s: Create free account only while open", async (_registration, site, offersSignUp) => {
    renderShell("/playground", <Where />, site);
    expect(
      await screen.findByText(
        "explore and edit freely, nothing here saves. Create a free account to build, test, and deploy for real.",
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("You're in the playground")).toBeInTheDocument();
    const banner = screen.getByText("You're in the playground").closest("div")!.parentElement!;
    if (offersSignUp) expect(within(banner).getByRole("link", { name: "Create free account" })).toHaveAttribute("href", "/register");
    else expect(within(banner).queryByRole("link", { name: "Create free account" })).toBeNull();
    expect(within(banner).getAllByRole("link", { name: "Sign in" })).toHaveLength(1);
    expect(within(banner).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(within(banner).queryByRole("button", { name: "Take the tour" })).toBeNull();
  });
});

describe("the sidebar", () => {
  it("has the signed-in sidebar's items in its order, Configurations, Flows and Fleet live", () => {
    renderShell("/playground/flows");
    const nav = screen.getByRole("navigation", { name: "Playground" });
    expect(within(nav).getByRole("link", { name: "Configurations" })).toHaveAttribute("href", "/playground");
    expect(within(nav).getByRole("link", { name: "Flows" })).toHaveAttribute("href", "/playground/flows");
    expect(within(nav).getByRole("link", { name: "Flows" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Fleet" })).toHaveAttribute("href", "/playground/fleet-management");
    const order = Array.from(nav.querySelectorAll("a, button"), (item) => item.textContent);
    expect(order).toEqual(["Configurations", "Flows", "Variables", "Fleet", "Permissions", "Settings", "Learning"]);
  });

  it.each([
    ["Variables", "manage your organization's variables"],
    ["Permissions", "manage your team's permissions"],
    ["Settings", "change app settings"],
    ["Learning", "read the learning library"],
  ])("%s is locked: the sign-up prompt, with its words", async (label, words) => {
    const user = userEvent.setup();
    renderShell("/playground", <Where />, SAAS_SITE);
    await user.click(within(await screen.findByRole("navigation", { name: "Playground" })).getByRole("button", { name: label }));
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(within(prompt).getByText(signupPromptText(words))).toBeInTheDocument();
    expect(within(prompt).getByRole("link", { name: "Create free account" })).toHaveAttribute("href", "/register");
    expect(within(prompt).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    await user.click(within(prompt).getByRole("button", { name: "Keep exploring" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a locked action's prompt, where registration isn't open: its one way on is Sign in, no Create free account", async () => {
    const user = userEvent.setup();
    renderShell("/playground", <Where />, { ...SAAS_SITE, registration: "invite-only" });
    await user.click(within(await screen.findByRole("navigation", { name: "Playground" })).getByRole("button", { name: "Settings" }));
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(within(prompt).queryByRole("link", { name: "Create free account" })).toBeNull();
    expect(within(prompt).queryByText(/Already have an account/)).toBeNull();
    expect(within(prompt).getAllByRole("link")).toHaveLength(1);
    expect(within(prompt).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it.each([
    ["the default docs", SAAS_SITE, "https://docs.telflo.com/docs"],
    ["another site's", { ...SAAS_SITE, docsUrl: "https://docs.example.org/" }, "https://docs.example.org/docs"],
  ] as const)("its Docs link follows the site's TELFLO_DOCS_URL: %s", async (_case, site, href) => {
    renderShell("/playground", <Where />, site);
    expect(await screen.findByRole("navigation", { name: "Playground" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("href", href);
  });

  it("has no Docs link with TELFLO_DOCS_URL empty", async () => {
    renderShell("/playground", <Where />, { ...SAAS_SITE, docsUrl: "" });
    expect(await screen.findByRole("navigation", { name: "Playground" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Docs" })).toBeNull();
  });

  it("ends with the sample workspace, and has no organization switcher, user menu or Contact us", () => {
    renderShell();
    expect(screen.getByText("Acme Observability")).toBeInTheDocument();
    expect(screen.getByText("Sample workspace")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch organization" })).toBeNull();
    expect(screen.queryByText("Contact us")).toBeNull();
    expect(screen.queryByText("Logout")).toBeNull();
  });
});

describe("the strip below md", () => {
  it("links the live pages, the current one marked", () => {
    renderShell("/playground/fleet-management/abc");
    const strip = screen.getByRole("navigation", { name: "Playground pages" });
    expect(strip).toHaveClass("md:hidden");
    expect(within(strip).getByRole("link", { name: "Fleet" })).toHaveAttribute("aria-current", "page");
    expect(within(strip).getByRole("link", { name: "Configurations" })).not.toHaveAttribute("aria-current");
  });
});

describe("the lock", () => {
  it("is null outside the playground, so the action runs as always", () => {
    const { result } = renderHook(() => useLockedAction());
    expect(result.current).toBeNull();
  });

  it("inside opens the one prompt with the action's words, and nothing else", async () => {
    const user = userEvent.setup();
    function Locked() {
      const locked = useLockedAction();
      return (
        <button type="button" onClick={() => locked?.("delete a fleet")}>
          Delete
        </button>
      );
    }
    renderShell("/playground", <Locked />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(signupPromptText("delete a fleet"))).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("gives the focus back to the locked control when the prompt closes", async () => {
    const user = userEvent.setup();
    function Locked() {
      const locked = useLockedAction();
      return (
        <button type="button" onClick={() => locked?.("delete a fleet")}>
          Delete
        </button>
      );
    }
    renderShell("/playground", <Locked />);
    const control = screen.getByRole("button", { name: "Delete" });
    control.focus();
    await user.keyboard("{Enter}");
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(prompt).toContainElement(document.activeElement as HTMLElement);
    await user.click(within(prompt).getByRole("button", { name: "Keep exploring" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(control).toHaveFocus();
  });

  it("gives the focus back to the opener passed, when a mouse press focused nothing (Safari, Firefox on macOS)", async () => {
    const user = userEvent.setup();
    function Locked() {
      const locked = useLockedAction();
      return (
        <button type="button" onClick={(event) => locked?.("delete a fleet", event.currentTarget)}>
          Delete
        </button>
      );
    }
    renderShell("/playground", <Locked />);
    const control = screen.getByRole("button", { name: "Delete" });
    // A click as those browsers make it: the button never takes the focus.
    fireEvent.click(control);
    expect(control).not.toHaveFocus();
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    await user.click(within(prompt).getByRole("button", { name: "Keep exploring" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(control).toHaveFocus();
  });

  it("leaves the focus alone when the opener is gone by the prompt's close", async () => {
    const user = userEvent.setup();
    function Locked() {
      const locked = useLockedAction();
      const [shown, setShown] = useState(true);
      return shown ? (
        <button
          type="button"
          onClick={(event) => {
            locked?.("delete a fleet", event.currentTarget);
            setShown(false);
          }}
        >
          Delete
        </button>
      ) : null;
    }
    renderShell("/playground", <Locked />);
    const control = screen.getByRole("button", { name: "Delete" });
    await user.click(control);
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    await user.click(within(prompt).getByRole("button", { name: "Keep exploring" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(control.isConnected).toBe(false);
    expect(document.activeElement === control).toBe(false);
  });
});

describe("the provider's backstop", () => {
  it("suspends the session-ended handler while mounted, and releases it after", () => {
    const release = vi.fn();
    const suspend = vi.spyOn(apiClient, "suspendSessionEndedHandler").mockReturnValue(release);
    const view = renderShell();
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    view.unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("the surface", () => {
  it("masks the shell's root and <body> like the signed-in shell, and autocapture, releasing all on unmount", () => {
    const release = vi.fn();
    const masked = vi.spyOn(analytics, "setAnalyticsMasked").mockReturnValue(release);
    const view = renderShell();
    expect(document.body).toHaveClass("tf-app", "ph-mask");
    expect(screen.getByTestId("where").closest(".ph-mask")).toHaveClass("tf-app");
    expect(masked).toHaveBeenCalledWith(true);
    view.unmount();
    expect(document.body).not.toHaveClass("ph-mask");
    expect(document.body).not.toHaveClass("tf-app");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is counted: one surface leaving keeps the classes while another is mounted", () => {
    const first = renderHook(() => usePlaygroundSurface());
    const second = renderHook(() => usePlaygroundSurface());
    first.unmount();
    expect(document.body).toHaveClass("tf-app", "ph-mask");
    second.unmount();
    expect(document.body).not.toHaveClass("ph-mask");
  });
});

describe("the link scope", () => {
  it.each([
    ["/fleet-management", "/playground/fleet-management"],
    ["/fleet-management/0199a000-0000-7000-8000-000000000001?tab=tokens", "/playground/fleet-management/0199a000-0000-7000-8000-000000000001?tab=tokens"],
    ["/editor/11111111-0000-4000-8000-000000000001/33333333-0000-4000-8000-000000000003", "/playground/editor/11111111-0000-4000-8000-000000000001"],
    ["/app/flows/log-volume-cost-control", "/playground/flows/log-volume-cost-control"],
    // The signed-in configurations list: the playground's.
    ["/app", "/playground"],
    ["/app/", "/playground"],
  ])("maps %s to %s", (href, mapped) => {
    expect(playgroundPathFor(href)).toBe(mapped);
  });

  it.each(["/appx", "/app/settings", "/register", "https://docs.telflo.com/docs", "/fleet-managementx", "#top"])("leaves %s as it is", (href) => {
    expect(playgroundPathFor(href)).toBeNull();
  });

  it("sends a click on a signed-in link to the playground's page", async () => {
    const user = userEvent.setup();
    const Stub = createRoutesStub([
      {
        path: "/playground",
        Component: () => (
          <PlaygroundLinkScope>
            <Link to="/fleet-management/0199a000-0000-7000-8000-000000000001">A fleet</Link>
          </PlaygroundLinkScope>
        ),
      },
      { path: "/playground/fleet-management/:fleetId", Component: Where },
      { path: "/fleet-management/:fleetId", Component: () => <p>signed in</p> },
    ]);
    render(<Stub initialEntries={["/playground"]} />);
    await user.click(screen.getByRole("link", { name: "A fleet" }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/playground/fleet-management/0199a000-0000-7000-8000-000000000001");
  });
});
