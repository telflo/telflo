import {
  CurrentUserResponseSchema,
  ErrorResponseSchema,
  FlowResponseSchema,
  FlowsResponseSchema,
  OidcProvidersResponseSchema,
  PendingFeedbackCountSchema,
  type CurrentUserResponse,
  type Flow,
  type OidcProvider,
  type SessionErrorCode,
} from "@telflo/contracts";
import { ApiError } from "./api-client.js";

const DEFAULT_API_INTERNAL_URL = "http://localhost:8080";

/**
 * Server loaders have no origin for a relative `/api` URL to resolve against
 * (the browser's same-origin calls rely on one, ADR 0017), so they reach the
 * API directly at TELFLO_API_INTERNAL_URL (D2a decision 11). Read at call
 * time, not at import, so the process environment is always the one in force.
 */
function apiInternalUrl(): string {
  return process.env.TELFLO_API_INTERNAL_URL ?? DEFAULT_API_INTERNAL_URL;
}

/**
 * What the API said about the incoming request's session (D2b decision 6).
 *
 * - `signed_in`: the access token is valid.
 * - `refresh_needed`: 401 `access_token_expired`. A server loader can't
 *   refresh (the refresh cookie never reaches a page request), so the browser
 *   does it during hydration (D2b decision 4).
 * - `signed_out`: any other 401, including one whose body isn't the error
 *   envelope. Only an expired token is worth a refresh (D2b decision 1).
 */
export type CurrentUserLookup =
  | { status: "signed_in"; currentUser: CurrentUserResponse }
  | { status: "refresh_needed" }
  | { status: "signed_out" };

const ACCESS_TOKEN_EXPIRED: SessionErrorCode = "access_token_expired";

/**
 * Looks up the signed-in user for the incoming request. Never refreshes
 * (D2b decision 6): it uses `fetch`, not the browser client's interceptor.
 *
 * Only the `Cookie` header is forwarded. Nothing else from the browser's
 * request — its authorization, forwarding or host headers — is relayed to the
 * API.
 *
 * Anything other than 200 or 401, including an unreachable API, throws an
 * ApiError for the route's error boundary. An outage must not look like
 * "signed out".
 */
export async function fetchCurrentUser(request: Request): Promise<CurrentUserLookup> {
  const cookie = request.headers.get("cookie");
  const headers: Record<string, string> = cookie === null ? {} : { cookie };

  let response: Response;
  try {
    response = await fetch(`${apiInternalUrl()}/api/v1/auth/me`, { method: "GET", headers });
  } catch {
    throw new ApiError("network_error", "Could not reach the API.");
  }

  if (response.status === 401) return lookupFor401(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("unexpected_response", "The API returned an unreadable response.");
  }

  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(payload);
    if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message);
    throw new ApiError("unexpected_response", "The API returned an unexpected error.");
  }

  const parsed = CurrentUserResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError("unexpected_response", "The API returned an unexpected response.");
  }
  return { status: "signed_in", currentUser: parsed.data };
}

/**
 * A 401 is `refresh_needed` only when its body is the error envelope with
 * code `access_token_expired`. Anything else, readable or not, is
 * `signed_out`: a 401 never reaches the error boundary.
 */
async function lookupFor401(response: Response): Promise<CurrentUserLookup> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "signed_out" };
  }
  const parsed = ErrorResponseSchema.safeParse(payload);
  return parsed.success && parsed.data.error.code === ACCESS_TOKEN_EXPIRED
    ? { status: "refresh_needed" }
    : { status: "signed_out" };
}

/**
 * The configured federated providers, for the sign-in and register buttons
 * (D2c). The list is public, so nothing from the browser's request is
 * forwarded; the request only lends its abort signal, so a visitor who
 * leaves doesn't keep the call running.
 *
 * Any failure (unreachable, not 200, or not the schema) throws an ApiError.
 * The loaders catch it and render no buttons: the list is optional, and an
 * outage mustn't take the sign-in page down with it.
 */
export async function fetchOidcProviders(request: Request): Promise<OidcProvider[]> {
  let response: Response;
  try {
    response = await fetch(`${apiInternalUrl()}/api/v1/auth/oidc-providers`, {
      method: "GET",
      signal: request.signal,
    });
  } catch {
    throw new ApiError("network_error", "Could not reach the API.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("unexpected_response", "The API returned an unreadable response.");
  }

  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(payload);
    if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message);
    throw new ApiError("unexpected_response", "The API returned an unexpected error.");
  }

  const parsed = OidcProvidersResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError("unexpected_response", "The API returned an unexpected response.");
  }
  return parsed.data.providers;
}

/**
 * What a signed-in read from a server loader came back with (D12 Preflight
 * rulings 5 and 18), in `fetchCurrentUser`'s terms: `loaded` with the
 * answer; `refresh_needed` on a 401 `access_token_expired`, which only the
 * browser can refresh, so the route's client loader reads again through the
 * browser client; `signed_out` on any other 401.
 */
export type SignedInRead<Data> =
  | { status: "loaded"; data: Data }
  | { status: "refresh_needed" }
  | { status: "signed_out" };

/** What a schema's `safeParse` answers, as far as `readSignedIn` reads it. */
interface ResponseSchema<Data> {
  safeParse(value: unknown): { success: true; data: Data } | { success: false };
}

/**
 * A signed-in GET from a server loader, as `fetchCurrentUser`: only the
 * incoming request's `Cookie` header is forwarded, nothing else from the
 * browser; it never refreshes. A 401 is `refresh_needed` or `signed_out`;
 * any other failure (unreachable, an error status, an answer that isn't the
 * schema) throws an ApiError, carrying the API's code when it sent the error
 * envelope (`flow_not_found`, say), for the loader to turn into a 404 or the
 * error boundary.
 */
async function readSignedIn<Data>(request: Request, path: string, schema: ResponseSchema<Data>): Promise<SignedInRead<Data>> {
  const cookie = request.headers.get("cookie");
  const headers: Record<string, string> = cookie === null ? {} : { cookie };

  let response: Response;
  try {
    response = await fetch(`${apiInternalUrl()}${path}`, { method: "GET", headers });
  } catch {
    throw new ApiError("network_error", "Could not reach the API.");
  }

  if (response.status === 401) {
    const lookup = await lookupFor401(response);
    return lookup.status === "refresh_needed" ? { status: "refresh_needed" } : { status: "signed_out" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("unexpected_response", "The API returned an unreadable response.");
  }

  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(payload);
    if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message);
    throw new ApiError("unexpected_response", "The API returned an unexpected error.");
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError("unexpected_response", "The API returned an unexpected response.");
  }
  return { status: "loaded", data: parsed.data };
}

/**
 * The signed-in gallery's flows (`GET /api/v1/flows`, D12 decision 10), with
 * the visitor's cookie: the published ones, and the hidden ones too for a
 * product admin (the API decides), for `/app/flows`'s server loader.
 */
export async function fetchFlows(request: Request): Promise<SignedInRead<Flow[]>> {
  const read = await readSignedIn(request, "/api/v1/flows", FlowsResponseSchema);
  return read.status === "loaded" ? { status: "loaded", data: read.data.flows } : read;
}

/**
 * One flow in full (`GET /api/v1/flows/:slug`), with the visitor's cookie,
 * for `/app/flows/:slug`'s server loader. A flow the visitor may not see (no
 * such slug, or a hidden one for anyone but a product admin) throws an
 * ApiError `flow_not_found`.
 */
export async function fetchFlow(request: Request, slug: string): Promise<SignedInRead<Flow>> {
  const read = await readSignedIn(request, `/api/v1/flows/${encodeURIComponent(slug)}`, FlowResponseSchema);
  return read.status === "loaded" ? { status: "loaded", data: read.data.flow } : read;
}

/**
 * How many feedback items are pending (`GET
 * /api/v1/product-admin/feedback/pending-count`, D29 decision 37, Preflight
 * ruling 14), with the visitor's cookie, for the product-admin layout's
 * server loader after its gate: the nav's badge. A number, no personal
 * data. The loader turns every failure into no badge.
 */
export async function fetchPendingFeedbackCount(request: Request): Promise<SignedInRead<number>> {
  const read = await readSignedIn(request, "/api/v1/product-admin/feedback/pending-count", PendingFeedbackCountSchema);
  return read.status === "loaded" ? { status: "loaded", data: read.data.count } : read;
}
