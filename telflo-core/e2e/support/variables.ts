import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type OrganizationVariable,
  type VariableGroup,
  type VariableGroupDetail,
  type VariableGroupOverride,
} from "@telflo/contracts";

// Organization variables and variable groups for the browser tests (D20
// decision 40), made through the E2E API as the page's session
// (`page.request`, the CSRF header set), as support/collectors.ts makes
// fleets: the E2E API writes them to its fake opamp-server, which fills
// them in where a collector's, a run's or a validation's text references
// them. Each test works in an organization of its own, so the names may
// repeat across tests.

const CSRF = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

/** The organization's variables' path under the E2E API. */
export function variablesApiPath(organizationId: string): string {
  return `/api/v1/organizations/${organizationId}/variables`;
}

/** The organization's variable groups' path under the E2E API. */
export function variableGroupsApiPath(organizationId: string): string {
  return `/api/v1/organizations/${organizationId}/variable-groups`;
}

/** A variable made through the API, as the Variables page's Add makes it (the browser's own id): no description unless given. */
export async function createVariableThroughApi(
  page: Page,
  organizationId: string,
  name: string,
  value: string,
  description: string | null = null,
): Promise<OrganizationVariable> {
  const response = await page.request.post(variablesApiPath(organizationId), {
    data: { id: randomUUID(), name, value, description },
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { variable: OrganizationVariable }).variable;
}

/** The organization's variables, read through the API. */
export async function variablesThroughApi(page: Page, organizationId: string): Promise<OrganizationVariable[]> {
  const response = await page.request.get(variablesApiPath(organizationId));
  expect(response.status()).toBe(200);
  return ((await response.json()) as { variables: OrganizationVariable[] }).variables;
}

/** A variable group made through the API, as the Variable groups page's Add makes it: no override yet. */
export async function createVariableGroupThroughApi(
  page: Page,
  organizationId: string,
  name: string,
  description: string | null = null,
): Promise<VariableGroup> {
  const response = await page.request.post(variableGroupsApiPath(organizationId), {
    data: { id: randomUUID(), name, description },
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { variableGroup: VariableGroup }).variableGroup;
}

/** A variable group's override of one variable set through the API (201 new, 200 replaced), as the group's page's Override sets it. */
export async function setOverrideThroughApi(
  page: Page,
  organizationId: string,
  variableGroupId: string,
  variableId: string,
  value: string,
): Promise<VariableGroupOverride> {
  const response = await page.request.put(`${variableGroupsApiPath(organizationId)}/${variableGroupId}/overrides/${variableId}`, {
    data: { value },
    headers: CSRF,
  });
  expect([200, 201]).toContain(response.status());
  return ((await response.json()) as { override: VariableGroupOverride }).override;
}

/** A variable group and its overrides, read through the API. */
export async function variableGroupThroughApi(
  page: Page,
  organizationId: string,
  variableGroupId: string,
): Promise<VariableGroupDetail> {
  const response = await page.request.get(`${variableGroupsApiPath(organizationId)}/${variableGroupId}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as VariableGroupDetail;
}

/** A name no other test's organization needs to avoid, in the names' grammar (upper case): `{prefix}_{8 hex digits}`. */
export function uniqueVariableName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
