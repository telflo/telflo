import { vi } from "vitest";
import * as apiClient from "~/lib/api-client.js";

/*
 * The playground's seam tests (D31-1 decision 23): every API client
 * function that sends a request, spied on and calling through, so a test
 * can show none was called while a page or a store read the sample.
 */

/** The client's exports that send no request: the session-ended handler's switches and pure helpers. */
const NOT_REQUESTS = new Set([
  "isSessionEnded",
  "retryAfterSecondsOf",
  "setSessionEndedHandler",
  "suspendSessionEndedHandler",
  "whenRequestsInFlightSettle",
  "organizationLogoPath",
]);

/** Every function the API client exports that sends a request, spied on and calling through: none may be called under the sample. */
export function spyOnTheClient() {
  return Object.entries(apiClient)
    .filter(([name, value]) => typeof value === "function" && !/^[A-Z]/.test(name) && !NOT_REQUESTS.has(name))
    .map(([name]) => vi.spyOn(apiClient as unknown as Record<string, (...args: unknown[]) => unknown>, name));
}
