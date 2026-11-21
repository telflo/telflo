import type {
  OrganizationVariable,
  VariableGroup,
  VariableGroupDetail,
  VariableGroupInUseDetails,
  VariableGroupOverride,
  VariableInUseDetails,
} from "@telflo/contracts";

/** The Variables pages' fixtures: variables, variable groups and their overrides, and the in-use details. */

export const VARIABLE_ID = "7a000000-0000-4000-8000-000000000001";
export const OTHER_VARIABLE_ID = "7a000000-0000-4000-8000-000000000002";
export const VARIABLE_GROUP_ID = "7b000000-0000-4000-8000-000000000001";
export const CHANGED_AT = "2026-10-20T10:00:00.000Z";
export const CHANGER = { userId: "7c000000-0000-4000-8000-000000000001", email: "ana@example.com" };

export function organizationVariable(overrides: Partial<OrganizationVariable> = {}): OrganizationVariable {
  return {
    id: VARIABLE_ID,
    name: "OTLP_EP",
    value: "https://otlp.example:4318",
    description: "The gateway's endpoint",
    changedBy: CHANGER,
    changedAt: CHANGED_AT,
    ...overrides,
  };
}

export function variableGroup(overrides: Partial<VariableGroup> = {}): VariableGroup {
  return {
    id: VARIABLE_GROUP_ID,
    name: "EU production",
    description: "Europe's collectors",
    overrideCount: 1,
    usage: { collectorGroups: 2, pinnedCollectors: 1 },
    changedBy: CHANGER,
    changedAt: CHANGED_AT,
    ...overrides,
  };
}

export function variableGroupOverride(overrides: Partial<VariableGroupOverride> = {}): VariableGroupOverride {
  return { variableId: VARIABLE_ID, value: "https://eu.otlp.example:4318", changedBy: CHANGER, changedAt: CHANGED_AT, ...overrides };
}

export function variableGroupDetail(
  group: Partial<VariableGroup> = {},
  overrides: VariableGroupOverride[] = [variableGroupOverride()],
): VariableGroupDetail {
  return { variableGroup: variableGroup(group), overrides };
}

/** A `variable_in_use` details: `count` published versions, ids `7d…01` on. */
export function variableInUse(usedBy: VariableInUseDetails["usedBy"], totals: Partial<VariableInUseDetails> = {}): VariableInUseDetails {
  return {
    usedBy,
    totalPublications: usedBy.length,
    totalGroups: usedBy.reduce((sum, use) => sum + use.groups.length, 0),
    totalPinnedCollectors: usedBy.reduce((sum, use) => sum + use.pinnedCollectors, 0),
    ...totals,
  };
}

export function versionUse(
  index: number,
  overrides: Partial<VariableInUseDetails["usedBy"][number]> = {},
): VariableInUseDetails["usedBy"][number] {
  const suffix = String(index).padStart(12, "0");
  return {
    publishedVersionId: `7d000000-0000-4000-8000-${suffix}`,
    configurationId: `7e000000-0000-4000-8000-${suffix}`,
    configurationName: "edge-config",
    versionId: `7f000000-0000-4000-8000-${suffix}`,
    versionNumber: index,
    groups: [],
    pinnedCollectors: 0,
    ...overrides,
  };
}

export function groupUse(index: number, overrides: Partial<VariableGroupInUseDetails["collectorGroups"][number]> = {}) {
  const suffix = String(index).padStart(12, "0");
  return {
    fleetId: `70000000-0000-4000-8000-${suffix}`,
    fleetLabel: "edge-prod",
    groupId: `71000000-0000-4000-8000-${suffix}`,
    groupName: "gateways",
    ...overrides,
  };
}
