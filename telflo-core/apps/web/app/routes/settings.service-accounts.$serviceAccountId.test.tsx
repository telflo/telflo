import { screen } from "@testing-library/react";
import { toast } from "sonner";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";
import { ACCOUNT_ID, apiToken, renderServiceAccountPages, serviceAccount, viewer, where } from "~/test/service-accounts.js";
import SettingsServiceAccountRoute from "./settings/service-accounts.$serviceAccountId.js";

/*
 * A service account's page's route (D22 decision 41; Preflight ruling 20):
 * by id only, for admins; a contributor is sent to /settings, replacing the
 * entry; management lost while open leaves the page.
 */

describe("a service account's route (/settings/service-accounts/:serviceAccountId)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("a contributor opening it is sent to /settings, replacing the entry, with no read", async () => {
    const getAccount = vi.spyOn(apiClient, "getServiceAccount");
    const getTokens = vi.spyOn(apiClient, "getApiTokens");
    renderServiceAccountPages(`/settings/service-accounts/${ACCOUNT_ID}`, "contributor");
    expect(await screen.findByText("landed on /settings")).toBeInTheDocument();
    expect(where()).toBe("/settings REPLACE");
    expect(getAccount).not.toHaveBeenCalled();
    expect(getTokens).not.toHaveBeenCalled();
  });

  it("renders nothing for a contributor on the server, without React Router's <Navigate> warning", async () => {
    const warn = vi.spyOn(console, "warn");
    const contributor = viewer("contributor");
    const handler = createStaticHandler([
      {
        id: "routes/app-layout",
        path: "/",
        loader: (): AppLayoutData => ({ status: "signed_in", currentUser: contributor }),
        children: [{ path: "settings/service-accounts/:serviceAccountId", Component: SettingsServiceAccountRoute }],
      },
    ]);
    const context = await handler.query(new Request(`http://localhost/settings/service-accounts/${ACCOUNT_ID}`));
    if (context instanceof Response) throw new Error("expected a render, not a response");
    const router = createStaticRouter(handler.dataRoutes, context);
    const html = renderToString(<StaticRouterProvider router={router} context={context} />);
    expect(html).not.toContain("Service account");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a 403 while open leaves the page for /app with the API's message", async () => {
    const refusal = new ApiError("organization_admin_required", "Only an organization admin can do this", { status: 403 });
    vi.spyOn(apiClient, "getServiceAccount").mockRejectedValue(refusal);
    vi.spyOn(apiClient, "getApiTokens").mockRejectedValue(refusal);
    const error = vi.spyOn(toast, "error");
    renderServiceAccountPages(`/settings/service-accounts/${ACCOUNT_ID}`);
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an organization admin can do this");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("an admin sees the account's page", async () => {
    vi.spyOn(apiClient, "getServiceAccount").mockResolvedValue({ serviceAccount: serviceAccount() });
    vi.spyOn(apiClient, "getApiTokens").mockResolvedValue({ items: [apiToken()] });
    renderServiceAccountPages(`/settings/service-accounts/${ACCOUNT_ID}`);
    expect(await screen.findByRole("heading", { name: "ci-pipeline" })).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
  });
});
