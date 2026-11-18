import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";

// The public quick-deploy download in the browser tests, fetched as a host's
// curl reaches it: by a request context of its own, made fresh with no
// cookies, never the page's (which holds the session). Moved from
// quick-deploy.e2e.ts for D17d-2's Helm values links (Preflight ruling 34):
// quick-deploy.e2e.ts and helm.e2e.ts share them.
//
// No assertion here prints a body: a download holds a bearer (a Helm values
// link's) or a bundle, and a broken refusal could hold the link's secret.

/** One public answer: its status, headers and body, read before its context went. */
export interface PublicAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * GET of each link by a request context made fresh for it, holding no cookie and sending none: the public
 * download as a host's curl reaches it. Its answers, read before the context goes.
 */
export async function fetchedWithoutSession(
  playwright: { request: { newContext: () => Promise<APIRequestContext> } },
  urls: string[],
): Promise<PublicAnswer[]> {
  const context = await playwright.request.newContext();
  try {
    expect((await context.storageState()).cookies).toEqual([]);
    const answers = [];
    for (const url of urls) {
      const response: APIResponse = await context.get(url, { maxRedirects: 0 });
      answers.push({ status: response.status(), headers: response.headers(), body: await response.body() });
    }
    return answers;
  } finally {
    await context.dispose();
  }
}

/** A refusal's answer (D17c-2 decision 26): the status, its plain text, and the public route's headers. */
export function expectRefused(answer: PublicAnswer, status: number, text: string): void {
  expect(answer.status).toBe(status);
  // Never printed on a failure: a broken refusal could hold the secret.
  expect(answer.body.toString("utf8") === text, "the refusal's plain text").toBe(true);
  expect(answer.headers).toMatchObject({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  expect(answer.headers["set-cookie"]).toBeUndefined();
}
