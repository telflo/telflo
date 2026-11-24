import { expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  API_TOKEN_PATTERN,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type ApiTokenAccess,
  type CreatedApiTokenResponse,
  type ServiceAccount,
  type ServiceAccountResponse,
} from "@telflo/contracts";
import { E2E_API_URL } from "./environment.js";

// Service accounts and their `tf_` tokens in the browser tests. Accounts and
// tokens a test isn't about are made through the E2E API as the page's session
// (`page.request`, the CSRF header set); `/whoami` is called as a CLI or a CI
// job calls it, by a request context made fresh with no cookies, at the API's
// own E2E port.
//
// A token is a secret: built by the API at run time, never a literal here,
// and never printed. Nothing here asserts on a body or a string that could
// hold one; callers check a reply with booleans before comparing it.

const CSRF = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

/** The organization's service accounts' path under the E2E API. */
export function serviceAccountsApiPath(organizationId: string): string {
  return `/api/v1/organizations/${organizationId}/service-accounts`;
}

/** One account's tokens' path under the E2E API. */
export function apiTokensApiPath(organizationId: string, serviceAccountId: string): string {
  return `${serviceAccountsApiPath(organizationId)}/${serviceAccountId}/api-tokens`;
}

/**
 * A service account made through the API, as the page's own create would,
 * in the session's active organization `organizationId` (an admin's).
 */
export async function createServiceAccountThroughApi(page: Page, organizationId: string, name: string): Promise<ServiceAccount> {
  const response = await page.request.post(serviceAccountsApiPath(organizationId), { data: { name }, headers: CSRF });
  expect(response.status()).toBe(201);
  return ((await response.json()) as ServiceAccountResponse).serviceAccount;
}

/** Deletes a service account through the API (204): its membership removed, its tokens revoked. */
export async function deleteServiceAccountThroughApi(page: Page, organizationId: string, serviceAccountId: string): Promise<void> {
  const response = await page.request.delete(`${serviceAccountsApiPath(organizationId)}/${serviceAccountId}`, { headers: CSRF });
  expect(response.status()).toBe(204);
}

/**
 * A token made through the API on the account: its id and the token from
 * the create's reply (the only one that carries it). The token's shape is
 * checked as a boolean, so a failure prints nothing of it.
 */
export async function createApiTokenThroughApi(
  page: Page,
  organizationId: string,
  serviceAccountId: string,
  request: { name: string; access: ApiTokenAccess; expiresInDays: number | null },
): Promise<{ tokenId: string; token: string }> {
  const response = await page.request.post(apiTokensApiPath(organizationId, serviceAccountId), { data: request, headers: CSRF });
  expect(response.status()).toBe(201);
  const created = (await response.json()) as CreatedApiTokenResponse;
  expect(API_TOKEN_PATTERN.test(created.token), "the reply carries a tf_ token").toBe(true);
  return { tokenId: created.apiToken.id, token: created.token };
}

/** `/whoami`'s answer: its status, its `WWW-Authenticate` and `Cache-Control` headers, and its body as JSON (or undefined). */
export interface WhoAmIAnswer {
  status: number;
  wwwAuthenticate: string | undefined;
  cacheControl: string | undefined;
  /** The body's text, for a caller's boolean canary checks before any comparison. */
  text: string;
  body: unknown;
}

/** A person's own tokens' path under the E2E API. */
export const PERSONAL_API_TOKENS_API_PATH = "/api/v1/auth/me/api-tokens";

/**
 * One of the signed-in person's own tokens made through the API, as the
 * Account page's create would (with the person's current password): its id
 * and the token from the create's reply. The token's shape is checked as a boolean, so a failure prints
 * nothing of it.
 */
export async function createPersonalApiTokenThroughApi(
  page: Page,
  request: { name: string; access: ApiTokenAccess; expiresInDays: number | null; currentPassword: string },
): Promise<{ tokenId: string; token: string }> {
  const response = await page.request.post(PERSONAL_API_TOKENS_API_PATH, { data: request, headers: CSRF });
  expect(response.status()).toBe(201);
  const created = (await response.json()) as CreatedApiTokenResponse;
  expect(API_TOKEN_PATTERN.test(created.token), "the reply carries a tf_ token").toBe(true);
  return { tokenId: created.apiToken.id, token: created.token };
}

/**
 * `GET /api/public/v1/whoami` with `Authorization: Bearer <token>` (and,
 * for a personal token, `X-Telflo-Org` when `organizationId` is given),
 * from a request context made fresh for it at the API's E2E port, holding
 * no cookie and sending none: the public surface as a CLI reaches it.
 * Never asserts on the answer; the caller checks it.
 */
export async function whoami(
  playwright: { request: { newContext: (options?: { baseURL?: string }) => Promise<APIRequestContext> } },
  token: string,
  options: { organizationId?: string } = {},
): Promise<WhoAmIAnswer> {
  const context = await playwright.request.newContext({ baseURL: E2E_API_URL });
  try {
    expect((await context.storageState()).cookies.length).toBe(0);
    const sent: Record<string, string> = { authorization: `Bearer ${token}` };
    if (options.organizationId !== undefined) sent["x-telflo-org"] = options.organizationId;
    const response = await context.get("/api/public/v1/whoami", { headers: sent, maxRedirects: 0 });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const headers = response.headers();
    return { status: response.status(), wwwAuthenticate: headers["www-authenticate"], cacheControl: headers["cache-control"], text, body };
  } finally {
    await context.dispose();
  }
}
