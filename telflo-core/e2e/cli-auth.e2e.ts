import { createHash, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page, type Response } from "@playwright/test";
import { API_TOKEN_PATTERN, type ApiTokensResponse, type CreatedApiTokenResponse } from "@telflo/contracts";
import { cliAuthPath, startListener, type StartedListener } from "./support/cli-auth.js";
import { seedUser } from "./support/database.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { recordRequestUrls, urlsHolding } from "./support/privacy.js";
import { createPersonalApiTokenThroughApi, PERSONAL_API_TOKENS_API_PATH, whoami } from "./support/service-accounts.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";

// `/cli-auth`, `telflo login`'s browser side (D27 decisions 20-22 and 35;
// Preflight rulings 11, 13, 15-17): the CLI's own listener, started here on
// 127.0.0.1, receives the token the page mints on Approve; the machine's
// earlier CLI token is revoked; with the listener down the page shows the
// token to paste; a signed-out visitor signs in with a password and comes
// back with the fragment.
//
// A token is a secret (D22 decision 48, D27 decision 30): built by the API
// at run time, read from the create's reply or the listener's answer, never
// written here and never printed. No page that holds or shows one is open
// when an assertion can fail (D23-2 Ruling 144): the tests COLLECT
// booleans, go to about:blank, then assert. No token goes into a
// page.evaluate's source or argument, and none comes back from one (a
// trace would keep both, and traces are off here too): the page is searched for a token's
// SHA-256 (whole, and its 43 characters after tf_) and answers counts and
// booleans (Task 3's review, Nit 3; Ruling 244).
// Chromium gets the clipboard and local network access granted together
// (D17c-1 Ruling 68).

const PASSWORD = "correct horse battery staple";
const DONE_WORDS = "Done. Return to your terminal.";
const FALLBACK_WORDS = "Paste it into the terminal.";
const CANCELLED_WORDS = "Cancelled.";

/** A host no other test uses, as the CLI cuts one. */
function uniqueHost(): string {
  return `e2e-${randomUUID().slice(0, 8)}.local`;
}

function isTokenCreate(response: Response): boolean {
  return response.request().method() === "POST" && new URL(response.url()).pathname === PERSONAL_API_TOKENS_API_PATH;
}

async function grant(context: BrowserContext, browserName: string): Promise<void> {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write", "local-network-access"]);
}

/** Whether `text` becomes visible within `timeout`: a boolean, never a failing assertion on a page that may hold a token. */
async function shows(page: Page, text: string, timeout = 15_000): Promise<boolean> {
  return page
    .getByText(text, { exact: true })
    .waitFor({ state: "visible", timeout })
    .then(
      () => true,
      () => false,
    );
}

/** The person's own tokens' names, through the API with the page's session. */
async function tokenNames(page: Page): Promise<string[]> {
  const response = await page.request.get(PERSONAL_API_TOKENS_API_PATH);
  expect(response.status()).toBe(200);
  return ((await response.json()) as ApiTokensResponse).items.map((each) => each.name);
}

/** A token's SHA-256, hex: what the page is searched for, never the token. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** What the page is searched for: a text's SHA-256 and its length. */
interface Sought {
  hash: string;
  length: number;
}

/** The token whole, and its 43 characters after `tf_` (a page holding only those still holds the token). */
function soughtFor(token: string): { whole: Sought; tail: Sought } {
  return { whole: { hash: sha256(token), length: token.length }, tail: { hash: sha256(token.slice(3)), length: token.length - 3 } };
}

/** Where the page holds the text sought: counts only. */
interface TokenPlaces {
  inside: number;
  outside: number;
  splitOutside: number;
  inAttributes: number;
  inTitle: number;
  inHtml: number;
}

/**
 * In the page: `digest(text)`, a text's SHA-256 in hex, and `count(text)`,
 * how many of its `length`-character windows (inside each run of base64url
 * characters, at every offset) have the SHA-256 sought.
 */
function inPageDigest({ hash, length }: Sought): string {
  return `const hash = ${JSON.stringify(hash)};
    const length = ${JSON.stringify(length)};
    const digest = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const count = async (text) => {
      let found = 0;
      for (const run of (text ?? "").matchAll(/[A-Za-z0-9_-]+/g)) {
        const word = run[0];
        for (let at = 0; at + length <= word.length; at += 1) if ((await digest(word.slice(at, at + length))) === hash) found += 1;
      }
      return found;
    };`;
}

/** Where the page holds the text sought, counted in the page; null when the page couldn't answer. */
async function tokenPlaces(page: Page, sought: Sought): Promise<TokenPlaces | null> {
  return page
    .evaluate<TokenPlaces>(`(async () => {
    ${inPageDigest(sought)}
    let inside = 0;
    let outside = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const found = await count(node.textContent);
      if (found === 0) continue;
      if (node.parentElement && node.parentElement.closest(".ph-no-capture")) inside += found;
      else outside += found;
    }
    const outsideBody = document.body.cloneNode(true);
    for (const each of outsideBody.querySelectorAll(".ph-no-capture")) each.remove();
    let inAttributes = 0;
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) inAttributes += await count(attribute.value);
    }
    return {
      inside,
      outside,
      splitOutside: await count(outsideBody.textContent),
      inAttributes,
      inTitle: await count(document.title),
      inHtml: await count(document.documentElement.outerHTML),
    };
  })()`)
    .catch(() => null);
}

/** Whether the clipboard holds exactly the text sought, checked in the page. */
async function clipboardHolds(page: Page, sought: Sought): Promise<boolean> {
  return page
    .evaluate<boolean>(`(async () => {
    ${inPageDigest(sought)}
    return (await digest(await navigator.clipboard.readText())) === hash;
  })()`)
    .catch(() => false);
}

// A failed run keeps no trace, screenshot or video: each would hold the
// page's DOM or the create's reply, and so the token (Ruling 244).
test.use({ trace: "off", screenshot: "off", video: "off" });

let listener: StartedListener | undefined;

test.afterEach(() => {
  listener?.close();
  listener = undefined;
});

test("Approve hands a new personal token to the CLI's listener, revokes the machine's earlier CLI token, and keeps the fragment out of every address", async ({
  page,
  context,
  browserName,
  playwright,
}) => {
  const person = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, person);
  await grant(context, browserName);
  const host = uniqueHost();
  const earlier = await createPersonalApiTokenThroughApi(page, { name: `CLI — ${host} · 2026-01-02 03:04:05`, access: "write", expiresInDays: 30 });
  const other = await createPersonalApiTokenThroughApi(page, { name: `CLI — ${host}x · 2026-01-02 03:04:05`, access: "read", expiresInDays: 30 });
  listener = await startListener(E2E_WEB_URL);
  const urls = recordRequestUrls(context);

  await page.goto(cliAuthPath(listener.state, listener.port, host));
  await waitForHydration(page);
  await expect(page.getByRole("heading", { name: `Sign in the Telflo CLI on ${host}` })).toBeVisible();
  // The fragment is out of the address bar once the page has read it.
  expect(new URL(page.url()).hash).toBe("");
  expect(new URL(page.url()).pathname).toBe("/cli-auth");
  expect(await page.title()).toBe("CLI sign-in - Telflo");
  const created = page.waitForResponse(isTokenCreate);
  await page.getByRole("button", { name: "Approve" }).click();
  const createStatus = (await created).status();

  // --- The page may hold the token until Done: collect booleans only. ---
  const done = await shows(page, DONE_WORDS);
  const answer = await listener.answer;
  const received = answer.kind === "token" ? answer.token : "";
  const sought = received === "" ? null : soughtFor(received);
  const wholeAfterDone = sought === null ? null : await tokenPlaces(page, sought.whole);
  const tailAfterDone = sought === null ? null : await tokenPlaces(page, sought.tail);
  const goneAfterDone = wholeAfterDone?.inHtml === 0 && tailAfterDone?.inHtml === 0;
  await page.goto("about:blank");
  // --- No page holds the token now. ---
  expect(createStatus).toBe(201);
  expect(done, "the page said Done").toBe(true);
  expect(answer.kind).toBe("token");
  expect(API_TOKEN_PATTERN.test(received), "the listener received a tf_ token").toBe(true);
  expect(goneAfterDone, "the token gone from the page after Done").toBe(true);

  const fresh = await whoami(playwright, received);
  expect(fresh.text.includes(received.slice(3)), "the answer holds the token").toBe(false);
  expect(fresh.status).toBe(200);
  const freshName = (fresh.body as { tokenName?: string } | undefined)?.tokenName ?? "";
  expect(/^CLI — e2e-[0-9a-f]{8}\.local · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(freshName)).toBe(true);
  expect(freshName.startsWith(`CLI — ${host} · `)).toBe(true);
  expect((fresh.body as { access?: string } | undefined)?.access).toBe("write");
  // The machine's earlier CLI token is revoked; another host's is not.
  expect((await whoami(playwright, earlier.token)).status).toBe(401);
  expect((await whoami(playwright, other.token)).status).toBe(200);
  expect((await tokenNames(page)).sort()).toEqual([freshName, `CLI — ${host}x · 2026-01-02 03:04:05`].sort());
  // No address the browser requested holds the state or the host (the fragment never leaves the browser).
  expect(urlsHolding(urls, [listener.state, host])).toEqual([]);
});

test("with the listener down, the page shows the token once inside ph-no-capture, copied by its button", async ({ page, context, browserName, playwright }) => {
  const person = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, person);
  await grant(context, browserName);
  const host = uniqueHost();
  listener = await startListener(E2E_WEB_URL);
  const { state, port } = listener;
  listener.close();
  expect(await listener.answer).toEqual({ kind: "closed" });

  await page.goto(cliAuthPath(state, port, host));
  await waitForHydration(page);
  await expect(page.getByRole("heading", { name: `Sign in the Telflo CLI on ${host}` })).toBeVisible();
  const answered = page.waitForResponse(isTokenCreate);
  await page.getByRole("button", { name: "Approve" }).click();
  const response = await answered;

  // --- The fallback shows the token: collect booleans only. ---
  const status = response.status();
  const { token } = (await response.json()) as CreatedApiTokenResponse;
  const fallback = await shows(page, FALLBACK_WORDS);
  const sought = soughtFor(token);
  const placed = await tokenPlaces(page, sought.whole);
  const tailPlaced = await tokenPlaces(page, sought.tail);
  const copyButton = page.getByRole("button", { name: "Copy token" });
  await copyButton.click().catch(() => undefined);
  const copied = await copyButton
    .getByText("Copied", { exact: true })
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  const clipboardHoldsToken = browserName === "chromium" ? await clipboardHolds(page, sought.whole) : true;
  await page.goto("about:blank");
  // --- No page holds the token now. ---
  expect(status).toBe(201);
  expect(API_TOKEN_PATTERN.test(token), "the reply carries a tf_ token").toBe(true);
  expect(fallback, "the page showed the token to paste").toBe(true);
  expect(placed).toEqual({ inside: 1, outside: 0, splitOutside: 0, inAttributes: 0, inTitle: 0, inHtml: 1 });
  // Its 43 characters after tf_ only where the token is.
  expect(tailPlaced).toEqual({ inside: 1, outside: 0, splitOutside: 0, inAttributes: 0, inTitle: 0, inHtml: 1 });
  expect(copied, "the copy button said Copied").toBe(true);
  expect(clipboardHoldsToken, "the clipboard holds the token").toBe(true);
  const answer = await whoami(playwright, token);
  expect(answer.text.includes(token.slice(3)), "the answer holds the token").toBe(false);
  expect(answer.status).toBe(200);
});

test("a second telflo login's address opened in the same tab is read: a new session for the new listener (Ruling 250)", async ({
  page,
  context,
  browserName,
  playwright,
}) => {
  const person = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, person);
  await grant(context, browserName);
  const firstHost = uniqueHost();
  const secondHost = uniqueHost();
  listener = await startListener(E2E_WEB_URL);
  const first = listener;

  await page.goto(cliAuthPath(first.state, first.port, firstHost));
  await waitForHydration(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(CANCELLED_WORDS, { exact: true })).toBeVisible();
  expect(await first.answer).toEqual({ kind: "denied" });

  // The second address differs from this tab's only by its fragment: a same-document navigation.
  const second = await startListener(E2E_WEB_URL);
  listener = second;
  await page.evaluate("window.__e2eSameDocument = true");
  await page.goto(cliAuthPath(second.state, second.port, secondHost));
  await expect(page.getByRole("heading", { name: `Sign in the Telflo CLI on ${secondHost}` })).toBeVisible();
  expect(await page.evaluate<boolean>("window.__e2eSameDocument === true"), "the same document, not a new load").toBe(true);
  expect(new URL(page.url()).hash).toBe("");
  await page.getByRole("button", { name: "Approve" }).click();

  // --- Collect booleans only until the page is left. ---
  const done = await shows(page, DONE_WORDS);
  const answer = await second.answer;
  const received = answer.kind === "token" ? answer.token : "";
  await page.goto("about:blank");
  expect(done, "the page said Done").toBe(true);
  expect(API_TOKEN_PATTERN.test(received), "the second listener received a tf_ token").toBe(true);
  const fresh = await whoami(playwright, received);
  expect(fresh.text.includes(received.slice(3)), "the answer holds the token").toBe(false);
  expect(fresh.status).toBe(200);
  expect(((fresh.body as { tokenName?: string } | undefined)?.tokenName ?? "").startsWith(`CLI — ${secondHost} · `)).toBe(true);
});

test("Cancel tells the CLI's listener, and makes no token", async ({ page, context, browserName }) => {
  const person = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, person);
  await grant(context, browserName);
  listener = await startListener(E2E_WEB_URL);

  await page.goto(cliAuthPath(listener.state, listener.port, uniqueHost()));
  await waitForHydration(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(CANCELLED_WORDS, { exact: true })).toBeVisible();
  expect(await listener.answer).toEqual({ kind: "denied" });
  expect(await tokenNames(page)).toEqual([]);
});

test("signed out: the sign-in keeps the fragment, a password sign-in comes back to the page, and Approve hands the token over", async ({
  page,
  context,
  browserName,
  playwright,
}) => {
  const person = await seedUser({ password: PASSWORD });
  await grant(context, browserName);
  const host = uniqueHost();
  listener = await startListener(E2E_WEB_URL);

  await page.goto(cliAuthPath(listener.state, listener.port, host));
  await page.waitForURL((url) => url.pathname === "/login");
  const onLogin = new URL(page.url());
  expect(onLogin.searchParams.get("redirectTo")).toBe("/cli-auth");
  // The layout's 302 kept the fragment (a boolean: it holds the state).
  expect(onLogin.hash.includes(`state=${listener.state}`)).toBe(true);
  await waitForHydration(page);
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("heading", { name: `Sign in the Telflo CLI on ${host}` })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/cli-auth");
  expect(new URL(page.url()).hash).toBe("");
  await page.getByRole("button", { name: "Approve" }).click();

  // --- Collect booleans only until the page is left. ---
  const done = await shows(page, DONE_WORDS);
  const answer = await listener.answer;
  const received = answer.kind === "token" ? answer.token : "";
  await page.goto("about:blank");
  expect(done, "the page said Done").toBe(true);
  expect(API_TOKEN_PATTERN.test(received), "the listener received a tf_ token").toBe(true);
  const fresh = await whoami(playwright, received);
  expect(fresh.text.includes(received.slice(3)), "the answer holds the token").toBe(false);
  expect(fresh.status).toBe(200);
});
