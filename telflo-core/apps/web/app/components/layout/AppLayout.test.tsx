import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "@telflo/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { AppLayout } from "./AppLayout.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";

const PERSONAL = { id: "00000000-0000-4000-8000-000000000002", name: "personal", type: "personal", logoId: null, role: "admin" } as const;
const GROUP = { id: "00000000-0000-4000-8000-000000000003", name: "Group", type: "group", logoId: null, role: "admin" } as const;

function renderLayout() {
  const Stub = createRoutesStub([
    {
      path: "/app",
      Component: () => (
        <AppLayout>
          <p>page content</p>
        </AppLayout>
      ),
    },
  ]);
  return render(<Stub initialEntries={["/app"]} />);
}

describe("AppLayout", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("adds the app-layout and tf-app body classes while mounted and removes them after", async () => {
    const { unmount } = renderLayout();

    const content = await screen.findByText("page content");
    expect(content.closest("main")).toHaveClass("flex-1", "overflow-auto");
    expect(document.body).toHaveClass("app-layout", "tf-app");

    // The Toaster is the root route's (D2a Ruling 12); a second one here
    // would vanish with the layout and strand a logout toast.
    expect(screen.queryByRole("region", { name: /Notifications/ })).not.toBeInTheDocument();

    unmount();
    expect(document.body).not.toHaveClass("app-layout");
    expect(document.body).not.toHaveClass("tf-app");
  });

  it("has session replay mask all the app's text: ph-mask on its root and, while mounted, on <body> for portals (D4 Ruling 14)", async () => {
    const { container, unmount } = renderLayout();
    await screen.findByText("page content");

    expect(container.firstElementChild).toHaveClass("ph-mask");
    expect(document.body).toHaveClass("ph-mask");

    unmount();
    expect(document.body).not.toHaveClass("ph-mask");
  });

  it("masks autocapture's text and attributes while mounted, which ph-mask doesn't reach (D4 Ruling 16)", async () => {
    const release = vi.fn();
    const masked = vi.spyOn(analytics, "setAnalyticsMasked").mockReturnValue(release);
    const { unmount } = renderLayout();
    await screen.findByText("page content");

    expect(masked).toHaveBeenCalledWith(true);
    expect(release).not.toHaveBeenCalled();

    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner in place of the page, and keeps the sidebar, while switching organizations", async () => {
    useUserStore.getState().setCurrent({
      user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
      organization: PERSONAL,
      organizations: [PERSONAL, GROUP],
      isProductAdmin: false,
      mayCreateOrganizations: true,
      preferences: DEFAULT_USER_PREFERENCES,
    });
    let finish!: () => void;
    vi.spyOn(apiClient, "switchOrganization").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ organization: GROUP });
        }),
    );
    renderLayout();
    const user = userEvent.setup();
    await user.click(await screen.findByTitle("Switch organization"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Group/ }));

    const spinner = await screen.findByRole("status", { name: "Switching organization" });
    expect(spinner).toHaveClass("animate-spin", "rounded-full", "h-5", "w-5");
    expect(spinner.closest("main")).not.toBeNull();
    expect(screen.queryByText("page content")).not.toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();

    finish();
    expect(await screen.findByText("page content")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});
