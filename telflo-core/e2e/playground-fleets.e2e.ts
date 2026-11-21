import { expect, type Page } from "@playwright/test";
// The SaaS pair: open registration, the Terms, the playground and the anonymous reads.
import { test } from "./support/saas.js";
import { recordPlaygroundRequests } from "./support/playground.js";
import { waitForHydration } from "./support/session.js";

// The playground's fleet management with NO account: the list, a server
// fleet's page and its tabs, the Kubernetes fleet's page and its tabs, a
// collector's details, a locked action's sign-up prompt from each tab,
// the typed paths (server, k8s) redirecting to the one fleet page, an unknown
// fleet's "Fleet not found", the links inside the reused components landing
// on the playground's pages, and the playground's request allowlist: no `/api/`
// request at all. The fleets' labels and the collectors' names are the
// sample's own words. Each test opens a fresh context, signed out.

/** The sample's fixed ids (lib/playground/sample/fleets.ts, sample/configurations.ts). */
const PROD_ID = "44444444-0000-4000-8000-000000000001";
const K8S_ID = "44444444-0000-4000-8000-000000000004";
const GATEWAY_CONFIGURATION_ID = "11111111-0000-4000-8000-000000000001";

const FLEET_LABELS = ["prod-us-east", "staging-eu", "edge-import-pilot", "k8s-prod-us-west"];

function signupPrompt(page: Page) {
  return page.getByRole("dialog", { name: "This is a sample workspace" });
}

async function openPlayground(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

/** Presses `name`'s button, expects the sign-up prompt with `words`, and closes it. */
async function expectLocked(page: Page, name: string, words: string, scope = page.locator("body")): Promise<void> {
  await scope.getByRole("button", { name, exact: true }).first().click();
  await expect(signupPrompt(page)).toContainText(`To ${words}, create a free account.`);
  // The prompt is the only dialog: the action's own never opened.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await signupPrompt(page).getByRole("button", { name: "Keep exploring" }).click();
  await expect(signupPrompt(page)).toHaveCount(0);
}

async function chooseTab(page: Page, name: string, query: string): Promise<void> {
  await page.getByRole("tab", { name }).click();
  await page.waitForURL((url) => url.search === query);
}

test("the fleet list on the sample: four fleets, no stats strip, New Fleet locked", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPlayground(page, "/playground/fleet-management");

  await expect(page).toHaveTitle("Fleet Management - Playground - Telflo");
  await expect(page.getByText("You're in the playground")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Fleets" })).toBeVisible();
  for (const label of FLEET_LABELS) await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
  await expect(page.getByText("Version drift")).toHaveCount(0);

  await expectLocked(page, "New Fleet", "connect your own collector fleet");
  await expectLocked(page, "Delete prod-us-east", "delete a fleet");

  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toEqual([]);
});

test("a server fleet's page and its tabs, a collector's details, a locked dialog's prompt from each tab", async ({ page, context }) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  await openPlayground(page, "/playground/fleet-management");

  // The row's link keeps its signed-in path, and lands on the playground's page.
  const link = page.getByRole("link", { name: "prod-us-east", exact: true });
  await expect(link).toHaveAttribute("href", `/fleet-management/${PROD_ID}`);
  await link.click();
  await page.waitForURL(`**/playground/fleet-management/${PROD_ID}`);
  await expect(page).toHaveTitle("Fleet - Playground - Telflo");
  await expect(page.getByRole("heading", { level: 1, name: "prod-us-east" })).toBeVisible();
  await expect(page.getByText("Version drift")).toBeVisible();

  // Collectors: the sample's nine; the details open, with the error history; writes locked.
  for (const name of ["loving-tortoise", "brave-falcon", "quiet-meadow", "wandering-comet", "noble-ibex"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expectLocked(page, "Install collector", "install collectors into your own fleet");
  await expectLocked(page, "Edit loving-tortoise", "edit a collector");
  await page.getByRole("button", { name: "brave-falcon", exact: true }).click();
  const details = page.getByRole("dialog", { name: "brave-falcon" });
  await expect(details).toBeVisible();
  await expect(details.getByText('unknown type "tailsampling"', { exact: false }).first()).toBeVisible();
  await details.getByRole("button", { name: "Edit collector" }).click();
  await expect(signupPrompt(page)).toContainText("To edit a collector, create a free account.");
  await signupPrompt(page).getByRole("button", { name: "Keep exploring" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Groups.
  await chooseTab(page, "Groups", "?tab=groups");
  await expect(page.getByRole("button", { name: "More about canary" })).toBeVisible();
  await expectLocked(page, "New group", "create a collector group");
  await page.getByRole("button", { name: "More about canary" }).click();
  await expect(page.getByRole("dialog", { name: "canary" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Tokens, with the install links: View opens, the rest is locked.
  await chooseTab(page, "Tokens", "?tab=tokens");
  await expectLocked(page, "Rotate token", "rotate a fleet's token");
  await expectLocked(page, "Reveal the default token", "reveal a fleet token");
  await page.getByRole("button", { name: /^View / }).first().click();
  await expect(page.getByRole("dialog", { name: "Install link" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A reload keeps the tab; the back link lands on the playground's list.
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByRole("tab", { name: "Tokens" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("link", { name: "Fleets", exact: true }).click();
  await page.waitForURL("**/playground/fleet-management");

  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toEqual([]);
});

test("the Kubernetes fleet's page and its tabs", async ({ page, context }) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  await openPlayground(page, `/playground/fleet-management/${K8S_ID}`);

  await expect(page.getByRole("heading", { level: 1, name: "k8s-prod-us-west" })).toBeVisible();
  for (const name of ["node-agent", "otel-gateway", "payments-agent", "checkout-sidecar", "staging-agent", "logging-agent"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expectLocked(page, "Install with Helm", "install collectors into your own cluster");

  await chooseTab(page, "Groups", "?tab=groups");
  await expect(page.getByRole("button", { name: "More about payments" })).toBeVisible();
  await expectLocked(page, "Add gateway", "add a gateway to your own cluster");
  await page.getByRole("button", { name: "More about payments" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await chooseTab(page, "Tokens", "?tab=tokens");
  await page.getByRole("button", { name: /^View / }).first().click();
  await expect(page.getByRole("dialog", { name: "Install link" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expectLocked(page, "Rotate token", "rotate a fleet's token");

  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toEqual([]);
});

test("the typed paths redirect to the one fleet page; an unknown fleet is the page's own Fleet not found", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPlayground(page, `/playground/fleet-management/server/${PROD_ID}`);
  expect(new URL(page.url()).pathname).toBe(`/playground/fleet-management/${PROD_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "prod-us-east" })).toBeVisible();

  await openPlayground(page, `/playground/fleet-management/k8s/${K8S_ID}`);
  expect(new URL(page.url()).pathname).toBe(`/playground/fleet-management/${K8S_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "k8s-prod-us-west" })).toBeVisible();

  await openPlayground(page, "/playground/fleet-management/0199a000-0000-7000-8000-0000000000ff");
  await expect(page.getByRole("heading", { name: "Fleet not found" })).toBeVisible();
  await page.getByRole("link", { name: "Fleets", exact: true }).click();
  await page.waitForURL("**/playground/fleet-management");

  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toEqual([]);
});

test("a published version's link inside a collector's details lands on the playground editor", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPlayground(page, `/playground/fleet-management/${PROD_ID}`);
  await page.getByRole("button", { name: "loving-tortoise", exact: true }).click();
  const details = page.getByRole("dialog", { name: "loving-tortoise" });
  const version = details.getByRole("link", { name: /K8s Production Gateway/ }).first();
  await expect(version).toHaveAttribute("href", new RegExp(`^/editor/${GATEWAY_CONFIGURATION_ID}/`));
  // The fleet page's requests, before the editor's (whose own are the editor's spec's).
  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toEqual([]);
  await version.click();
  await page.waitForURL(`**/playground/editor/${GATEWAY_CONFIGURATION_ID}`);
});
