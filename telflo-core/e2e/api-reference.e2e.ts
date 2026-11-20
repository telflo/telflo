import { randomUUID } from "node:crypto";
import { expect, test, type Request } from "@playwright/test";
import { seedUser } from "./support/database.js";
import { E2E_POSTHOG_STUB_PORT, E2E_WEB_URL } from "./support/environment.js";
import { within } from "./support/privacy.js";
import { createApiTokenThroughApi, createServiceAccountThroughApi } from "./support/service-accounts.js";
import { signInThroughApi } from "./support/session.js";

// The API reference page: Swagger UI, served by the API at
// /api/public/v1/docs/ and reached here through the web's origin (the dev
// server proxies /api, as the gateway does), Authorized with a REAL
// service account's token minted at run time through the API, then try-it
// on GET /whoami. The one page where a token is typed: Authorize keeps it
// in memory only, every input is autocomplete=off (Firefox's form history
// kept it otherwise), the curl block names $TELFLO_TOKEN, the try-it
// request sends no cookie (a session is signed in on this origin), nothing
// reaches a URL, browser storage or another host (PostHog's stub among
// them), and a reload holds no token.
//
// A token is a secret: built by the API, never written here and never
// printed. While the page holds it the test only COLLECTS booleans (every
// wait caught), goes to about:blank, and asserts there (Playwright writes the
// page's ARIA snapshot to error-context.md). Run in Chromium, Firefox and
// WebKit: the page is a runtime of its own.

// No trace for this spec: a failed run's trace would keep the token put into Authorize's field, where the
// other token specs' traces keep only replies (personal-tokens.e2e.ts' recorded residue). Every action and
// navigation is bounded, and the whole time the page holds the token is bounded too (collectMs: what is left
// of the test's timeout less AFTER_COLLECT_MS), so the test always reaches about:blank before anything can
// fail (a hang there would write the page, the token in it, to error-context.md).
test.use({ trace: "off", actionTimeout: 10_000, navigationTimeout: 15_000 });

/**
 * The part of the test's timeout (90 s, test.slow) kept after the collection: about:blank (a navigation,
 * bounded at 15 s) and the assertions, with room for the fixtures' setup before the test's body (not timed).
 */
const AFTER_COLLECT_MS = 20_000;
/** The collection's bound when the test has no timeout (`--timeout 0`). */
const UNTIMED_COLLECT_MS = 45_000;

const PASSWORD = "correct horse battery staple";
const PAGE = "/api/public/v1/docs/";
/** The operation's element: Swagger UI's `operations-<tag>-<operationId>`. */
const WHOAMI_OPERATION = "#operations-organizations-getWhoAmI";

test("the API reference: Authorize with a real token, try GET /whoami, and the token stays in memory only", async ({ page, context }) => {
  test.slow();
  const started = Date.now();
  const admin = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, admin);
  const account = await createServiceAccountThroughApi(page, admin.organizationId, `Reference ${randomUUID().slice(0, 8)}`);
  const { token } = await createApiTokenThroughApi(page, admin.organizationId, account.id, {
    name: `Reference token ${randomUUID().slice(0, 8)}`,
    access: "read",
    expiresInDays: 1,
  });
  const webOrigin = new URL(E2E_WEB_URL).origin;
  const holds = (text: string | null | undefined) => typeof text === "string" && (text.includes(token) || text.includes(token.slice(3)));

  // Every request the page makes, as booleans and origins only.
  const requests: Array<{ sameOrigin: boolean; toPostHog: boolean; urlHoldsToken: boolean }> = [];
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    requests.push({
      sameOrigin: url.origin === webOrigin,
      toPostHog: url.port === String(E2E_POSTHOG_STUB_PORT),
      urlHoldsToken: holds(request.url()),
    });
  };
  page.on("request", onRequest);

  // Before any token is typed, a failure here prints nothing of one.
  const opened = await page.goto(PAGE);
  expect(opened?.status()).toBe(200);
  expect(opened?.headers()["content-security-policy"]).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  const authorize = page.getByRole("button", { name: /Authorize/ }).first();
  await expect(authorize).toBeVisible();
  // (Strings, not functions: the browser tests' TypeScript has no DOM library.)
  const historyAtLoad = await page.evaluate<number>("history.length");
  await authorize.click();
  const dialog = page.locator(".modal-ux");
  await expect(dialog).toBeVisible();
  const bearer = dialog.locator(".auth-container").filter({ hasText: /bearer/i }).first();
  await expect(bearer.locator("input")).toBeVisible();

  // --- From here the page holds the token: collect booleans only, every step bounded, the whole bounded. ---
  const collected = {
    valueSet: false,
    autocompleteOff: false,
    dialogClosed: false,
    resolved: false,
    whoamiStatus: 0,
    sentBearer: false,
    sentCookie: true,
    shown: false,
    curlNamesVariable: false,
    curlHoldsToken: true,
    domHoldsToken: true,
    browserState: null as null | Record<string, unknown>,
    stateHoldsToken: true,
    reloaded: false,
    lockedAfterReload: -1,
    reloadHoldsToken: true,
  };
  let stopped = false;
  const going = () => {
    if (stopped) throw new Error("stopped");
  };
  const collect = async () => {
    // The token set as the field's value with an input event (React reads it), not fill: a fill's step title
    // names its value.
    collected.valueSet = await within(
      bearer
        .locator("input")
        .first()
        .evaluate((element, value) => {
          const scope = globalThis as unknown as {
            HTMLInputElement: { prototype: object };
            Event: new (type: string, init: { bubbles: boolean }) => unknown;
          };
          Object.getOwnPropertyDescriptor(scope.HTMLInputElement.prototype, "value")?.set?.call(element, value);
          (element as unknown as { dispatchEvent: (event: unknown) => boolean }).dispatchEvent(new scope.Event("input", { bubbles: true }));
          return true;
        }, token),
      10_000,
      false,
    );
    going();
    collected.autocompleteOff = await within(
      page.evaluate<boolean>(
        `(() => { const inputs = [...document.querySelectorAll(".modal-ux input")]; return inputs.length > 0 && inputs.every((input) => input.getAttribute("autocomplete") === "off"); })()`,
      ),
      5_000,
      false,
    );
    going();
    await bearer.locator("button[type=submit]").click().catch(() => undefined);
    going();
    await dialog.locator("button.btn-done").first().click().catch(() => undefined);
    collected.dialogClosed = await dialog.waitFor({ state: "hidden", timeout: 5_000 }).then(() => true, () => false);
    going();

    // Try it: Swagger UI resolves an expanded operation's subtree asynchronously; until then its body is a
    // spinner beside Execute, and an Execute sends nothing (WebKit's OperationNotFoundError).
    const operation = page.locator(WHOAMI_OPERATION);
    await operation.locator(".opblock-summary").click().catch(() => undefined);
    collected.resolved = await operation
      .locator(".responses-wrapper")
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => operation.locator("button.execute").waitFor({ state: "visible", timeout: 5_000 }))
      .then(() => true, () => false);
    going();
    const answered = page
      .waitForResponse((response) => new URL(response.url()).pathname === "/api/public/v1/whoami", { timeout: 10_000 })
      .catch(() => null);
    await operation.locator("button.execute").click().catch(() => undefined);
    const response = await answered;
    going();
    collected.whoamiStatus = response?.status() ?? 0;
    const sent = response === null ? null : await within(response.request().allHeaders(), 5_000, null);
    collected.sentBearer = sent !== null && sent["authorization"] === `Bearer ${token}`;
    collected.sentCookie = sent === null || sent["cookie"] !== undefined;
    collected.shown = await operation
      .locator(".live-responses-table")
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true, () => false);
    going();
    const curl = await operation.locator(".curl-command").first().textContent({ timeout: 5_000 }).catch(() => null);
    collected.curlNamesVariable = curl !== null && curl.includes("Authorization: Bearer $TELFLO_TOKEN");
    collected.curlHoldsToken = curl === null || holds(curl);
    collected.domHoldsToken = holds(await within(page.content(), 5_000, null));
    going();
    // The browser's own state, read back whole and searched here: the token never goes into the page's source.
    const raw = await within(
      page.evaluate<{ storage: string[]; databases: number; caches: number; path: string; href: string; cookie: string; history: number; fields: string[] }>(
        `(async () => {
          const values = (storage) => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)) || "");
          return {
            storage: [...values(localStorage), ...values(sessionStorage)],
            databases: typeof indexedDB.databases === "function" ? (await indexedDB.databases()).length : 0,
            caches: (await caches.keys()).length,
            path: location.pathname + location.search + location.hash,
            href: location.href,
            cookie: document.cookie,
            history: history.length,
            fields: [...document.querySelectorAll("input, textarea")].map((field) => field.value || ""),
          };
        })()`,
      ),
      5_000,
      null,
    );
    collected.browserState =
      raw === null
        ? null
        : {
            storageHoldsToken: raw.storage.some(holds),
            databases: raw.databases,
            caches: raw.caches,
            hrefUnchanged: raw.path === PAGE,
            hrefHoldsToken: holds(raw.href),
            cookieHoldsToken: holds(raw.cookie),
            history: raw.history,
            inputHoldsToken: raw.fields.some(holds),
          };
    collected.stateHoldsToken = holds(JSON.stringify(await within(context.storageState(), 5_000, null)));
    going();
    // A reload: Authorize remembers nothing (persistAuthorization false).
    await within(page.goto(PAGE), 15_000, null);
    going();
    collected.reloaded = await page
      .getByRole("button", { name: /Authorize/ })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true, () => false);
    collected.lockedAfterReload = await within(page.locator("button.authorize.locked").count(), 5_000, -1);
    collected.reloadHoldsToken = holds(await within(page.content(), 5_000, null));
  };
  // How long the page may hold the token, in all: what is left of the test's timeout, less AFTER_COLLECT_MS.
  const timeout = test.info().timeout;
  const collectMs = timeout === 0 ? UNTIMED_COLLECT_MS : Math.max(0, timeout - (Date.now() - started) - AFTER_COLLECT_MS);
  await within(collect(), collectMs, undefined);
  stopped = true;
  await page.goto("about:blank");
  page.off("request", onRequest);
  const {
    valueSet,
    autocompleteOff,
    dialogClosed,
    resolved,
    whoamiStatus,
    sentBearer,
    sentCookie,
    shown,
    curlNamesVariable,
    curlHoldsToken,
    domHoldsToken,
    browserState,
    stateHoldsToken,
    reloaded,
    lockedAfterReload,
    reloadHoldsToken,
  } = collected;

  // --- No page holds the token now: assert what was collected. ---
  expect(valueSet, "the token set in Authorize's field").toBe(true);
  expect(autocompleteOff, "every input of Authorize is autocomplete=off").toBe(true);
  expect(dialogClosed, "Authorize closed").toBe(true);
  expect(resolved, "the operation expanded, its Execute shown").toBe(true);
  expect(whoamiStatus, "try-it's GET /whoami answered").toBe(200);
  expect(sentBearer, "try-it sent the token in Authorization").toBe(true);
  expect(sentCookie, "try-it sent a cookie").toBe(false);
  expect(shown, "the response shown").toBe(true);
  expect(curlNamesVariable, "the curl block names $TELFLO_TOKEN").toBe(true);
  expect(curlHoldsToken, "the curl block holds the token").toBe(false);
  expect(domHoldsToken, "the page's HTML holds the token").toBe(false);
  expect(browserState).toEqual({
    storageHoldsToken: false,
    databases: 0,
    caches: 0,
    hrefUnchanged: true,
    hrefHoldsToken: false,
    cookieHoldsToken: false,
    history: historyAtLoad,
    inputHoldsToken: false,
  });
  expect(stateHoldsToken, "the context's storage state holds the token").toBe(false);
  expect([reloaded, lockedAfterReload, reloadHoldsToken], "a reload is authorized with nothing").toEqual([true, 0, false]);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((request) => !request.sameOrigin), "requests to another origin").toEqual([]);
  expect(requests.some((request) => request.toPostHog), "a request to PostHog's stub").toBe(false);
  expect(requests.some((request) => request.urlHoldsToken), "a URL holding the token").toBe(false);
});
