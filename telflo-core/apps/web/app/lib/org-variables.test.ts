import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type OrganizationVariable } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import {
  ORG_VARIABLE_NAMES_REREAD_AFTER_MS,
  createOrgVariableReference,
  ensureOrgVariableNames,
  forgetOrgVariableNames,
  orgVariableReferences,
  seedOrgVariableNames,
  useOrgVariables,
} from "./org-variables.js";

/*
 * The web's port of the opamp-server's reference scan, held to it by the
 * shared corpus, read by a path relative to this file; and the picker's one
 * shared read of the names per organization.
 */

const CORPUS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../vendor/opamp-server/org-token-corpus.json",
);

const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as {
  render: { name: string; text: string; names: string[] }[];
  extract: { name: string; text: string; expected: string[] }[];
};

describe("orgVariableReferences, against the corpus", () => {
  it("reads the corpus' rows", () => {
    expect(corpus.render.length).toBeGreaterThan(20);
    expect(corpus.extract.length).toBeGreaterThan(5);
  });

  it.each(corpus.render.map((row) => [row.name, row] as const))("names the corpus' render row %s's references", (_name, row) => {
    expect(orgVariableReferences(row.text)).toEqual(row.names);
  });

  it.each(corpus.extract.map((row) => [row.name, row] as const))("agrees with the corpus' extract row %s", (_name, row) => {
    expect(orgVariableReferences(row.text)).toEqual(row.expected);
  });
});

describe("orgVariableReferences", () => {
  it("finds each live ${org:NAME} once, in first-seen order", () => {
    expect(orgVariableReferences("a: ${org:B}\nb: ${org:A}\nc: ${org:B}\nd: x${org:C}y\n")).toEqual(["B", "A", "C"]);
  });

  it("follows confmap's escape rule: an odd run of $ before the reference makes it inert, an even run leaves it live", () => {
    expect(orgVariableReferences("$${org:ESCAPED}")).toEqual([]);
    expect(orgVariableReferences("$$${org:LIVE}")).toEqual(["LIVE"]);
  });

  it("leaves the legacy $orgvar:NAME as plain text, and a default's form too", () => {
    expect(orgVariableReferences("a: $orgvar:LEGACY\nb: ${org:X:-y}\n")).toEqual([]);
  });

  it("ignores a reference whose name isn't a variable name", () => {
    expect(orgVariableReferences("${org:1ABC} ${org:} ${env:X} ${org:A-B}")).toEqual([]);
  });

  it("lists a name over 128 characters, which no variable can have", () => {
    const long = "N".repeat(129);
    expect(orgVariableReferences(`a: \${org:${long}}`)).toEqual([long]);
  });

  it("reads back what the picker inserts", () => {
    expect(orgVariableReferences(createOrgVariableReference("PROD_OTLP"))).toEqual(["PROD_OTLP"]);
  });
});

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000b2";
const VALUE_CANARY = "value-canary-7f3a";

function variable(name: string, overrides: Partial<OrganizationVariable> = {}): OrganizationVariable {
  return {
    id: `00000000-0000-4000-8000-${String(name.length).padStart(12, "0")}`,
    name,
    value: `${VALUE_CANARY}-${name}`,
    description: `About ${name}`,
    changedBy: null,
    changedAt: "2026-10-20T10:00:00.000Z",
    ...overrides,
  };
}

function signInTo(organizationId: string) {
  useUserStore.getState().setCurrent({
    user: { id: "00000000-0000-4000-8000-0000000000c3", email: "member@example.com" },
    organization: { id: organizationId, name: "Acme", type: "group", logoId: null, role: "contributor" },
    organizations: [],
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: DEFAULT_USER_PREFERENCES,
  });
}

describe("useOrgVariables: one shared read per organization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    forgetOrgVariableNames();
    useUserStore.getState().clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads nothing with no organization: empty, not loading", () => {
    const read = vi.spyOn(apiClient, "getOrganizationVariables");
    const { result } = renderHook(() => useOrgVariables());
    expect(result.current).toMatchObject({ names: [], loading: false, failed: false });
    expect(read).not.toHaveBeenCalled();
  });

  it("is loading until the read answers, then lists names and descriptions, never a value", async () => {
    signInTo(ORGANIZATION_ID);
    let answer: (variables: OrganizationVariable[]) => void = () => undefined;
    vi.spyOn(apiClient, "getOrganizationVariables").mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useOrgVariables());
    expect(result.current.loading).toBe(true);

    await act(async () => answer([variable("OTLP_EP"), variable("REGION", { description: null })]));
    expect(result.current.loading).toBe(false);
    expect(result.current.names).toEqual([
      { id: variable("OTLP_EP").id, name: "OTLP_EP", description: "About OTLP_EP" },
      { id: variable("REGION").id, name: "REGION", description: null },
    ]);
    expect(JSON.stringify(result.current.names)).not.toContain(VALUE_CANARY);
  });

  it("ten readers read once, and a reader mounting later reads nothing more", async () => {
    signInTo(ORGANIZATION_ID);
    const read = vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue([variable("A")]);
    const readers = Array.from({ length: 10 }, () => renderHook(() => useOrgVariables()));
    await waitFor(() => expect(readers.every(({ result }) => result.current.names.length === 1)).toBe(true));
    renderHook(() => useOrgVariables());
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ORGANIZATION_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("an organization switch reads the new organization's names, and never shows the old ones for it", async () => {
    signInTo(ORGANIZATION_ID);
    const read = vi
      .spyOn(apiClient, "getOrganizationVariables")
      .mockImplementation(async (organizationId) => [variable(organizationId === ORGANIZATION_ID ? "MINE" : "THEIRS")]);
    // Every render's organization and names: no render under the new organization may hold the old one's.
    const renders: { organizationId: string | null; names: string[] }[] = [];
    const { result } = renderHook(() => {
      const read = useOrgVariables();
      renders.push({
        organizationId: useUserStore.getState().current?.organization.id ?? null,
        names: read.names.map((each) => each.name),
      });
      return read;
    });
    await waitFor(() => expect(result.current.names.map((each) => each.name)).toEqual(["MINE"]));

    act(() => signInTo(OTHER_ORGANIZATION_ID));
    expect(result.current.names).toEqual([]);
    await waitFor(() => expect(result.current.names.map((each) => each.name)).toEqual(["THEIRS"]));
    expect(read).toHaveBeenCalledTimes(2);
    const underTheOther = renders.filter((each) => each.organizationId === OTHER_ORGANIZATION_ID);
    expect(underTheOther.length).toBeGreaterThan(1);
    for (const each of underTheOther) expect(each.names).not.toContain("MINE");
  });

  it("a failed read is `failed`; a picker opening reads again, a mount doesn't", async () => {
    signInTo(ORGANIZATION_ID);
    const read = vi
      .spyOn(apiClient, "getOrganizationVariables")
      .mockRejectedValueOnce(new ApiError("variables_unavailable", "unavailable", { status: 503 }))
      .mockResolvedValue([variable("A")]);
    const { result } = renderHook(() => useOrgVariables());
    await waitFor(() => expect(result.current.failed).toBe(true));
    renderHook(() => useOrgVariables());
    expect(read).toHaveBeenCalledTimes(1);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.names.map((each) => each.name)).toEqual(["A"]));
    expect(result.current.failed).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a picker opening reads again once the names are a minute old, keeping them shown meanwhile", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signInTo(ORGANIZATION_ID);
    const read = vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue([variable("A")]);
    const { result } = renderHook(() => useOrgVariables());
    await waitFor(() => expect(result.current.names).toHaveLength(1));

    act(() => result.current.refresh());
    expect(read).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + ORG_VARIABLE_NAMES_REREAD_AFTER_MS);
    read.mockResolvedValue([variable("A"), variable("BB")]);
    act(() => result.current.refresh());
    expect(result.current.names).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(result.current.names).toHaveLength(2));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("the Variables page's list seeds the names (its values dropped), and drops a read under way", async () => {
    signInTo(ORGANIZATION_ID);
    let late: (variables: OrganizationVariable[]) => void = () => undefined;
    vi.spyOn(apiClient, "getOrganizationVariables").mockReturnValue(new Promise((resolve) => (late = resolve)));
    const { result } = renderHook(() => useOrgVariables());
    act(() => seedOrgVariableNames(ORGANIZATION_ID, [variable("SEEDED")]));
    expect(result.current.names.map((each) => each.name)).toEqual(["SEEDED"]);
    expect(JSON.stringify(result.current.names)).not.toContain(VALUE_CANARY);

    await act(async () => late([variable("STALE")]));
    expect(result.current.names.map((each) => each.name)).toEqual(["SEEDED"]);
  });

  it("the read has its hang guard: one that never answers ends `failed`", async () => {
    vi.useFakeTimers();
    signInTo(ORGANIZATION_ID);
    vi.spyOn(apiClient, "getOrganizationVariables").mockImplementation(
      (_organizationId, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new ApiError(apiClient.REQUEST_ABORTED, "aborted"))),
        ),
    );
    const { result } = renderHook(() => useOrgVariables());
    expect(result.current.loading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.failed).toBe(true);
  });

  it("keeps nothing in browser storage", async () => {
    signInTo(ORGANIZATION_ID);
    vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue([variable("STORED_NOT")]);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    ensureOrgVariableNames(ORGANIZATION_ID);
    const { result } = renderHook(() => useOrgVariables());
    await waitFor(() => expect(result.current.names).toHaveLength(1));
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain("STORED_NOT");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("STORED_NOT");
  });
});
