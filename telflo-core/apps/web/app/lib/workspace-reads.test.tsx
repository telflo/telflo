import { useEffect, useState, type ReactNode } from "react";
import { createRoutesStub } from "react-router";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationsPageSchema, ConfigurationVersionsResponseSchema, ConfigurationWithVersionResponseSchema } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { PlaygroundProvider } from "~/lib/playground/provider.js";
import { SAMPLE_READS } from "~/lib/playground/sample-reads.js";
import { SAMPLE_CONFIGURATION_IDS, SAMPLE_VISITOR_USER_ID } from "~/lib/playground/sample/index.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { SAMPLE_ORGANIZATION_ID, WORKSPACE_READ_NAMES, readsFor } from "./workspace-reads.js";

/*
 * The seam (D31-1 decision 23, Preflight ruling 8): the playground's reads
 * answer from the sample and never call the API client; every other
 * organization's are the API client's own functions, so signed-in pages
 * read exactly as before. `useCurrentUser()` answers the sample's visitor
 * first inside the playground. The mechanism is shown end to end with a
 * test-only reader, written as a reused screen's reader is: the id from
 * `useCurrentUser()`, the read from `readsFor(id)`.
 */

/** A reused screen's reader, as Tasks 2 and 3 switch theirs: the fleets of the current user's organization. */
function useFleetCount(): number | null {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (organizationId === null) return;
    void readsFor(organizationId)
      .getFleets(organizationId)
      .then((page) => setCount(page.fleets.length));
  }, [organizationId]);
  return count;
}

let seen: { count: number | null; organizationId: string | null } = { count: null, organizationId: null };
function Reader() {
  const count = useFleetCount();
  const organizationId = useCurrentUser()?.organization.id ?? null;
  seen = { count, organizationId };
  return null;
}

function renderAt(element: ReactNode) {
  const Stub = createRoutesStub([{ path: "/", Component: () => <>{element}</> }]);
  return render(<Stub initialEntries={["/"]} />);
}

beforeEach(() => {
  vi.restoreAllMocks();
  seen = { count: null, organizationId: null };
  useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
});
afterEach(() => {
  useUserStore.getState().clear();
});

describe("readsFor", () => {
  it("is the API client's namespace for any organization but the sample's", () => {
    expect(readsFor("0199a000-0000-7000-8000-000000000001")).toBe(apiClient);
    expect(readsFor(null)).toBe(apiClient);
    expect(readsFor(undefined)).toBe(apiClient);
    expect(readsFor(SAMPLE_ORGANIZATION_ID)).not.toBe(apiClient);
  });

  it("names only reads the API client has, and the sample answers every one of them", () => {
    for (const name of WORKSPACE_READ_NAMES) {
      expect(typeof (apiClient as Record<string, unknown>)[name], name).toBe("function");
      expect(typeof SAMPLE_READS[name], name).toBe("function");
      expect(typeof readsFor(SAMPLE_ORGANIZATION_ID)[name], name).toBe("function");
    }
  });
});

describe("the sample's reads", () => {
  it("answer the configurations in the API's shapes, never calling the API client", async () => {
    const spies = spyOnTheClient();
    expect(spies.length).toBeGreaterThan(100);
    const reads = readsFor(SAMPLE_ORGANIZATION_ID);

    const page = ConfigurationsPageSchema.parse(await reads.getConfigurations(SAMPLE_ORGANIZATION_ID));
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
    const updated = page.items.map((item) => item.updatedAt);
    expect(updated).toEqual([...updated].sort().reverse());

    const mine = await reads.getConfigurations(SAMPLE_ORGANIZATION_ID, { filter: "mine" });
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((item) => item.createdBy?.userId === SAMPLE_VISITOR_USER_ID)).toBe(true);
    const published = await reads.getConfigurations(SAMPLE_ORGANIZATION_ID, { filter: "published" });
    expect(published.items.every((item) => item.published)).toBe(true);
    const searched = await reads.getConfigurations(SAMPLE_ORGANIZATION_ID, { q: "  ottl " });
    expect(searched.items.map((item) => item.id)).toEqual([SAMPLE_CONFIGURATION_IDS.cost]);

    const opened = ConfigurationWithVersionResponseSchema.parse(await reads.getConfiguration(SAMPLE_ORGANIZATION_ID, SAMPLE_CONFIGURATION_IDS.gateway));
    expect(opened.version.publishedAt).toBeNull();
    const older = opened.versions.find((version) => version.publishedAt !== null)!;
    const atOlder = ConfigurationWithVersionResponseSchema.parse(
      await reads.getConfigurationVersion(SAMPLE_ORGANIZATION_ID, SAMPLE_CONFIGURATION_IDS.gateway, older.id),
    );
    expect(atOlder.version.id).toBe(older.id);
    expect(atOlder.version.publishedAt).not.toBeNull();
    const listed = ConfigurationVersionsResponseSchema.parse(
      await reads.getConfigurationVersions(SAMPLE_ORGANIZATION_ID, SAMPLE_CONFIGURATION_IDS.gateway, { filter: "published" }),
    );
    expect(listed.versions.map((version) => version.id)).toEqual([older.id]);

    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  });

  it("answer an id the sample doesn't hold with the API's own not-found", async () => {
    const reads = readsFor(SAMPLE_ORGANIZATION_ID);
    const unknown = "0199a000-0000-7000-8000-0000000000ff";
    await expect(reads.getConfiguration(SAMPLE_ORGANIZATION_ID, unknown)).rejects.toMatchObject({
      code: "configuration_not_found",
      status: 404,
    });
    await expect(
      reads.getConfigurationVersion(SAMPLE_ORGANIZATION_ID, SAMPLE_CONFIGURATION_IDS.gateway, unknown),
    ).rejects.toMatchObject({ code: "configuration_version_not_found", status: 404 });
    await expect(reads.getFleet(SAMPLE_ORGANIZATION_ID, unknown)).rejects.toBeInstanceOf(ApiError);
    await expect(reads.getFleet(SAMPLE_ORGANIZATION_ID, unknown)).rejects.toMatchObject({ code: "fleet_not_found", status: 404 });
  });
});

describe("a reused reader through the seam", () => {
  it("inside the playground reads the sample with the sample's visitor, a signed-in visitor's organization never reaching it", async () => {
    const spies = spyOnTheClient();
    renderAt(
      <PlaygroundProvider>
        <Reader />
      </PlaygroundProvider>,
    );
    await waitFor(() => expect(seen.count).not.toBeNull());
    expect(seen.organizationId).toBe(SAMPLE_ORGANIZATION_ID);
    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  });

  it("outside the playground reads the API as before, for the signed-in user's organization", async () => {
    const getFleets = vi.spyOn(apiClient, "getFleets").mockResolvedValue({ fleets: [], nextCursor: null });
    renderAt(<Reader />);
    await waitFor(() => expect(getFleets).toHaveBeenCalledWith(PERSONAL_ID));
    expect(seen.organizationId).toBe(PERSONAL_ID);
  });
});
