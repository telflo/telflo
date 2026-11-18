import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationsPage } from "@telflo/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import type * as ReactRouter from "react-router";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { MEMBER_ID, MINE, ORPHANED, THEIRS, signedInMember } from "~/test/configurations.js";
import {
  canDeleteConfiguration,
  configurationRefusalMessage,
  isConfigurationGone,
  isConfigurationRefusal,
  isOrganizationGone,
  isTermsAcceptanceRequired,
  useConfigurationsList,
} from "./configurations.js";

// The hook outside a router: no layout data (so no terms to accept), and a
// revalidate that stays the same function, as the router's does.
const { revalidate } = vi.hoisted(() => ({ revalidate: () => Promise.resolve() }));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useRouteLoaderData: () => undefined,
  useRevalidator: () => ({ revalidate, state: "idle" }),
}));

const FALLBACK = "Failed to create configuration";

describe("configurationRefusalMessage (D7 Preflight ruling 2)", () => {
  it.each([
    ["configuration_not_found", "Configuration not found"],
    ["organization_not_found", "Organization not found"],
    ["terms_acceptance_required", "Accept the current Terms of Service to continue."],
    // D11b's, which join through CONFIGURATION_ERROR_CODES (Preflight ruling 4).
    ["configuration_delete_forbidden", "Only the configuration's author or an organization admin can delete it."],
    ["configuration_version_published", "This version is published and can't be changed."],
    ["publishing_unavailable", "Publishing is unavailable right now. Try again."],
    // D16b's, a delete's (Preflight ruling 6): the in-use 409 through CONFIGURATION_ERROR_CODES, the two others by name.
    [
      "configuration_in_use",
      "A collector group or a collector uses a published version of this configuration. Remove it from them first.",
    ],
    ["fleets_unavailable", "Couldn't check whether a fleet uses this configuration, so nothing was deleted."],
    ["rate_limited", "Too many attempts. Please wait and try again."],
  ])("shows the API's message for the refusal %s", (code, message) => {
    const error = new ApiError(code, message);
    expect(isConfigurationRefusal(error)).toBe(true);
    expect(configurationRefusalMessage(error, FALLBACK)).toBe(message);
  });

  it.each([
    ["internal_error", "Something went wrong. Please try again.", "a server error"],
    ["invalid_request", "The request was not valid.", "an invalid request"],
    ["unexpected_response", "The server returned an unexpected response.", "a drifted response"],
    ["network_error", "Could not reach the server. Check your connection.", "no connection"],
    ["csrf_header_missing", "Missing CSRF header", "any other code"],
  ])("shows the fallback for %s (%s)", (code, message) => {
    const error = new ApiError(code, message);
    expect(isConfigurationRefusal(error)).toBe(false);
    expect(configurationRefusalMessage(error, FALLBACK)).toBe(FALLBACK);
  });

  it("shows the fallback for anything that isn't an ApiError", () => {
    expect(configurationRefusalMessage(new Error("configuration_not_found"), FALLBACK)).toBe(FALLBACK);
    expect(configurationRefusalMessage("configuration_not_found", FALLBACK)).toBe(FALLBACK);
  });
});

describe("the refusals the page acts on", () => {
  it("tells the organization gone, the configuration gone and the terms apart", () => {
    const organization = new ApiError("organization_not_found", "Organization not found");
    const configuration = new ApiError("configuration_not_found", "Configuration not found");
    const terms = new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.");

    expect([organization, configuration, terms].map(isOrganizationGone)).toEqual([true, false, false]);
    expect([organization, configuration, terms].map(isConfigurationGone)).toEqual([false, true, false]);
    expect([organization, configuration, terms].map(isTermsAcceptanceRequired)).toEqual([false, false, true]);
    expect(isOrganizationGone(new Error("organization_not_found"))).toBe(false);
  });
});

describe("canDeleteConfiguration (D11b decision 2)", () => {
  it("lets the author delete, a contributor, their draft or their published configuration", () => {
    expect(canDeleteConfiguration(MINE, MEMBER_ID, "contributor")).toBe(true);
    expect(canDeleteConfiguration({ ...MINE, published: true }, MEMBER_ID, "contributor")).toBe(true);
  });

  it("refuses a contributor another member's configuration, and an authorless one", () => {
    expect(canDeleteConfiguration(THEIRS, MEMBER_ID, "contributor")).toBe(false);
    expect(canDeleteConfiguration(ORPHANED, MEMBER_ID, "contributor")).toBe(false);
  });

  it("lets an admin delete any configuration, an authorless one too", () => {
    for (const configuration of [MINE, THEIRS, ORPHANED]) {
      expect(canDeleteConfiguration(configuration, MEMBER_ID, "admin")).toBe(true);
    }
  });

  it("refuses everything with no signed-in user and no role", () => {
    for (const configuration of [MINE, THEIRS, ORPHANED]) {
      expect(canDeleteConfiguration(configuration, "", undefined)).toBe(false);
    }
  });
});

describe("useConfigurationsList's loadMore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().setCurrent(signedInMember());
  });

  it("sends nothing while the shown list is stale, a new first page under way", async () => {
    let searched!: (page: ConfigurationsPage) => void;
    const getConfigurations = vi.spyOn(apiClient, "getConfigurations").mockImplementation(async (_organizationId, query = {}) =>
      query.q === "" ? { items: [THEIRS], nextCursor: "cursor-1" } : new Promise((resolve) => (searched = resolve)),
    );
    const { result, rerender } = renderHook(({ search }) => useConfigurationsList({ search, filter: "all" }), {
      initialProps: { search: "" },
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    rerender({ search: "prod" });
    await waitFor(() => expect(getConfigurations).toHaveBeenCalledTimes(2));
    expect(result.current.isStale).toBe(true);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isLoadingMore).toBe(false);

    act(() => result.current.loadMore());

    expect(getConfigurations).toHaveBeenCalledTimes(2);
    expect(getConfigurations.mock.calls.some(([, query]) => query?.cursor !== undefined)).toBe(false);
    expect(result.current.isLoadingMore).toBe(false);
    await act(async () => searched({ items: [MINE], nextCursor: null }));
    expect(result.current.items).toEqual([MINE]);
  });
});
