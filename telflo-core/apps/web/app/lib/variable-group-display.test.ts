import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { organizationVariable, variableGroup, variableGroupOverride } from "~/test/variables.js";
import {
  effectiveVariableGroupId,
  followGroupWords,
  forgetVariableGroupNames,
  moreNamesText,
  noteVariableGroupName,
  resolvedVariables,
  seedVariableGroupNames,
  undefinedNames,
  useVariableGroupNames,
  variableGroupNamesNow,
  variablesUndefinedOf,
} from "./variable-group-display.js";

/* A collector's variable group and its variables' values, at the group and organization levels. */

const PIN = "7b000000-0000-4000-8000-0000000000a1";
const BOUND = "7b000000-0000-4000-8000-0000000000b1";

describe("effectiveVariableGroupId", () => {
  it("takes the pin over the group's, the group's over none, and is unknown without the group or a pin", () => {
    expect(effectiveVariableGroupId({ pinnedVariableGroupId: PIN }, { variableGroupId: BOUND })).toBe(PIN);
    expect(effectiveVariableGroupId({ pinnedVariableGroupId: PIN }, undefined)).toBe(PIN);
    expect(effectiveVariableGroupId({ pinnedVariableGroupId: null }, { variableGroupId: BOUND })).toBe(BOUND);
    expect(effectiveVariableGroupId({ pinnedVariableGroupId: null }, { variableGroupId: null })).toBeNull();
    expect(effectiveVariableGroupId({ pinnedVariableGroupId: null }, null)).toBeNull();
    expect(effectiveVariableGroupId({ pinnedVariableGroupId: null }, undefined)).toBeUndefined();
  });
});

describe("followGroupWords", () => {
  it('says "Follow group (eu-edge)", "(Organization values)" for none, and no group when unknown', () => {
    expect(followGroupWords("eu-edge")).toBe("Follow group (eu-edge)");
    expect(followGroupWords(null)).toBe("Follow group (Organization values)");
    expect(followGroupWords(undefined)).toBe("Follow group");
  });
});

describe("resolvedVariables (per variable)", () => {
  const a = organizationVariable({ id: "7a000000-0000-4000-8000-0000000000a1", name: "A", value: "org-a" });
  const b = organizationVariable({ id: "7a000000-0000-4000-8000-0000000000b1", name: "B", value: "org-b" });
  const c = organizationVariable({ id: "7a000000-0000-4000-8000-0000000000c1", name: "C", value: "org-c" });

  it("takes each variable from the first level overriding it, else the organization's value, in the list's order", () => {
    const rows = resolvedVariables(
      [a, b, c],
      [
        { source: "pin", overrides: [variableGroupOverride({ variableId: a.id, value: "pin-a" })] },
        { source: "group", overrides: [variableGroupOverride({ variableId: a.id, value: "group-a" }), variableGroupOverride({ variableId: b.id, value: "" })] },
      ],
    );
    expect(rows.map((row) => [row.variable.name, row.value, row.source])).toEqual([
      ["A", "pin-a", "pin"],
      // An empty override overrides.
      ["B", "", "group"],
      ["C", "org-c", "Organization value"],
    ]);
  });
});

describe("the undefined names", () => {
  it("lists the references no variable has, as written (case-sensitive), in the order referenced", () => {
    expect(undefinedNames(["B", "a", "A"], [{ name: "A" }])).toEqual(["B", "a"]);
    expect(moreNamesText(3)).toBe("… and 3 more");
  });

  it("reads a 422 variables_undefined's details, and nothing of any other failure", () => {
    const details = { names: ["A"], totalNames: 1 };
    expect(variablesUndefinedOf(new ApiError("variables_undefined", "x", { status: 422, details }))).toEqual(details);
    expect(variablesUndefinedOf(new ApiError("variables_undefined", "x", { status: 422, details: { names: "A" } }))).toBeNull();
    expect(variablesUndefinedOf(new ApiError("variable_group_not_found", "x", { status: 404, details }))).toBeNull();
    expect(variablesUndefinedOf(new Error("x"))).toBeNull();
  });
});

describe("useVariableGroupNames (one shared read per organization)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  });

  afterEach(() => {
    useUserStore.getState().clear();
    forgetVariableGroupNames();
    vi.useRealTimers();
  });

  it("reads nothing for rows naming none, and once for many rows naming some", async () => {
    const read = vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([variableGroup({ id: BOUND, name: "eu-edge" })]);
    renderHook(() => useVariableGroupNames([null, undefined]));
    expect(read).not.toHaveBeenCalled();
    const hooks = [renderHook(() => useVariableGroupNames([BOUND])), renderHook(() => useVariableGroupNames([BOUND, null]))];
    await waitFor(() => expect(hooks[0]!.result.current.get(BOUND)).toBe("eu-edge"));
    expect(hooks[1]!.result.current.get(BOUND)).toBe("eu-edge");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("is seeded by a dialog's read, and never shows another organization's names, in any render", async () => {
    const read = vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([]);
    seedVariableGroupNames(GROUP_ID, [variableGroup({ id: PIN, name: "canary-pin" })]);
    // Each render's organization and what it named: the first render after a switch included.
    const renders: Array<[string | null, string | undefined]> = [];
    const { result } = renderHook(() => {
      const organizationId = useUserStore((state) => state.current?.organization.id ?? null);
      const names = useVariableGroupNames([PIN]);
      renders.push([organizationId, names.get(PIN)]);
      return names;
    });
    expect(result.current.get(PIN)).toBe("canary-pin");
    expect(read).not.toHaveBeenCalled();
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    expect(result.current.get(PIN)).toBeUndefined();
    await waitFor(() => expect(read).toHaveBeenCalledWith(PERSONAL_ID, expect.anything()));
    expect(renders.filter(([organizationId]) => organizationId === PERSONAL_ID).length).toBeGreaterThan(0);
    expect(renders.filter(([organizationId, name]) => organizationId === PERSONAL_ID && name !== undefined)).toEqual([]);
  });

  it("follows a dialog's save at once: a rename, a delete, never another organization's names; a read under way starts again", async () => {
    const answers: Array<(groups: ReturnType<typeof variableGroup>[]) => void> = [];
    const read = vi
      .spyOn(apiClient, "getVariableGroups")
      .mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    seedVariableGroupNames(GROUP_ID, [variableGroup({ id: BOUND, name: "eu-edge" })]);
    const { result, rerender } = renderHook(({ ids }) => useVariableGroupNames(ids), { initialProps: { ids: [BOUND] } });
    expect(result.current.get(BOUND)).toBe("eu-edge");

    act(() => noteVariableGroupName(GROUP_ID, BOUND, "eu-edge-renamed"));
    expect(result.current.get(BOUND)).toBe("eu-edge-renamed");
    act(() => noteVariableGroupName(GROUP_ID, PIN, "canary-pin"));
    expect(variableGroupNamesNow().names.get(PIN)).toBe("canary-pin");
    act(() => noteVariableGroupName(GROUP_ID, PIN, null));
    expect(variableGroupNamesNow().names.has(PIN)).toBe(false);
    // Another organization's save never lands in these names.
    act(() => noteVariableGroupName(PERSONAL_ID, BOUND, "elsewhere"));
    expect(result.current.get(BOUND)).toBe("eu-edge-renamed");
    expect(read).not.toHaveBeenCalled();

    // A read started before the save may answer the old name: it is dropped, and the names read again.
    act(() => forgetVariableGroupNames());
    rerender({ ids: [BOUND, PIN] });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => noteVariableGroupName(GROUP_ID, BOUND, "eu-edge-renamed"));
    expect(result.current.get(BOUND)).toBe("eu-edge-renamed");
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => answers[0]!([variableGroup({ id: BOUND, name: "eu-edge" })]));
    expect(result.current.get(BOUND)).toBe("eu-edge-renamed");
    await act(async () => answers[1]!([variableGroup({ id: BOUND, name: "eu-edge-renamed" })]));
    expect(variableGroupNamesNow().status).toBe("ready");
    expect(result.current.get(BOUND)).toBe("eu-edge-renamed");
  });

  it("reads again for a name it doesn't hold only once the last read is a minute old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const read = vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([variableGroup({ id: BOUND, name: "eu-edge" })]);
    const { rerender } = renderHook(({ ids }) => useVariableGroupNames(ids), { initialProps: { ids: [BOUND] as (string | null)[] } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => {});
    rerender({ ids: [BOUND, PIN] });
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 60_000);
    rerender({ ids: [PIN] });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });
});
