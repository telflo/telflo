import { expect, type Page } from "@playwright/test";
// The SaaS pair (D36-1 Preflight ruling 16): open registration, the Terms, the playground and the anonymous reads.
import { test } from "./support/saas.js";
import { openYamlTab, platformKeys, typeLineAtTop } from "./support/editor-page.js";
import { recordPlaygroundRequests, sampled } from "./support/playground.js";
import { waitForHydration } from "./support/session.js";

// The playground editor with NO account (D31-1 decisions 2, 3, 12, 16, 22,
// 28-31 and 44; Preflight rulings 5, 9 and 18): a sample opens, its YAML
// edits, D27's anonymous validate marks an error and clears it, a 429 shows
// "Checking paused" counting down (the 429 stubbed: Preflight ruling 5,
// never asserting that none came), the Testing tab shows the sample's runs
// and a run's details, its Run, a rule and a suite are locked, Save stages
// the edit and opens "Sign in to save", and the phone page stands in for
// the editor. Each test records its requests: none falls outside decision
// 22's invariant. The words are the spec's, written out here: the browser
// tests don't import the web app's modules. Every text asserted is the
// sample's own or the test's own marker.

const GATEWAY_ID = "11111111-0000-4000-8000-000000000001";
const GATEWAY_NAME = "K8s Production Gateway";
/** The gateway sample's draft pin. */
const GATEWAY_PIN = "0.162.0";

const validText = (version: string) => `config valid · v${version}`;
const errorsText = (count: number, version: string) => `${count} ${count === 1 ? "error" : "errors"} · v${version}`;

function signupPrompt(page: Page) {
  return page.getByRole("dialog", { name: "This is a sample workspace" });
}

/** The prompt shows `words`; Keep exploring closes it. */
async function expectLocked(page: Page, words: string): Promise<void> {
  await expect(signupPrompt(page)).toContainText(`To ${words}, create a free account.`);
  await signupPrompt(page).getByRole("button", { name: "Keep exploring" }).click();
  await expect(signupPrompt(page)).toHaveCount(0);
}

async function openSample(page: Page): Promise<void> {
  await page.goto(`/playground/editor/${GATEWAY_ID}`);
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: GATEWAY_NAME })).toBeVisible();
}

// Text goes into Monaco as the signed-in specs type it, one line at the top
// (support/editor-page.ts's typeLineAtTop): Playwright's insertText of text
// holding a newline lands twice in Firefox, in every editor, signed in too,
// while typing and a real paste land once (Ruling 306).

test.describe.configure({ mode: "serial" });

test("a sample opens; the anonymous validate marks an error typed in the YAML and clears it", async ({ page, context }) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  await openSample(page);
  await expect(page).toHaveTitle("Playground Editor - Telflo");
  await expect(page.getByText("Edit freely — Save to keep your changes.")).toBeVisible();
  await openYamlTab(page);
  // An opened text is checked after the pause, as a change is (decision 3).
  await expect(page.getByText(validText(GATEWAY_PIN), { exact: true })).toBeVisible();

  await typeLineAtTop(page, "connectors: {unknown_zqplayground: {}}");
  await expect(page.getByRole("button", { name: errorsText(1, GATEWAY_PIN), exact: true })).toBeVisible();

  // The line out again: the text the validate last called valid.
  await page.keyboard.press((await platformKeys(page)).top);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Backspace");
  await expect(page.getByText(validText(GATEWAY_PIN), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: errorsText(1, GATEWAY_PIN), exact: true })).toHaveCount(0);

  expect(recorder.outside()).toEqual([]);
  expect(new Set(recorder.apiRequests())).toEqual(new Set(["POST /api/public/v1/validate/anonymous"]));
});

test("a 429 shows 'Checking paused' counting down, then checks again", async ({ page, context }) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  let refused = 0;
  await page.route("**/api/public/v1/validate/anonymous", async (route) => {
    if (refused > 0) return route.fallback();
    refused += 1;
    return route.fulfill({
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "4" },
      body: JSON.stringify({ error: { code: "rate_limited", message: "Too many requests. Try again shortly." } }),
    });
  });
  await openSample(page);
  await openYamlTab(page);
  await expect(page.getByText(/^Checking paused — try again in [1-4] s$/)).toBeVisible();
  // It counts down, then asks again (the real route this time) and shows the answer.
  await expect(page.getByText(validText(GATEWAY_PIN), { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(refused).toBe(1);
  expect(recorder.outside()).toEqual([]);
});

test("the Testing tab: the sample's runs and a run's details; a locked Run, a locked rule, a locked suite", async ({ page, context }) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  await openSample(page);
  await page.getByRole("tab", { name: "Testing", exact: true }).click();

  // The sample's four runs; the newest's details.
  const rows = page.getByRole("button", { name: /(Success|Validation Failed|Error)$/ });
  await expect(rows).toHaveCount(4);
  await rows.first().click();
  const results = page.getByRole("region", { name: "Test results" });
  await expect(results.getByRole("button", { name: "k8s-pod-logs.json", exact: true })).toBeVisible();

  // The run dialog opens on the sample's templates; its Run is locked.
  await page.getByRole("button", { name: "Configure and run" }).click();
  const dialog = page.getByRole("dialog", { name: "Select Test File" });
  await dialog.getByRole("button", { name: "Templates" }).click();
  await dialog.getByText("Kubernetes pod logs", { exact: true }).click();
  await dialog.getByRole("button", { name: "OK" }).click();
  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expectLocked(page, "run a test against your config");

  // A rule: its pipeline's rules read from the sample; Edit is locked.
  await page.getByRole("tab", { name: "Validation", exact: true }).click();
  await page.getByRole("button", { name: /^logs/ }).click();
  await page.getByRole("button", { name: "Edit rule 1: service.name present on every record" }).click();
  await expectLocked(page, "edit a validation rule");

  // A suite: listed from the sample; Edit suite is locked.
  await page.getByRole("tab", { name: "Suites", exact: true }).click();
  await expect(page.getByText("Nightly regression", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit suite" }).click();
  await expectLocked(page, "edit a test suite");

  expect(recorder.outside()).toEqual([]);
});

test("Save stages the edit in this browser and opens 'Sign in to save'", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openSample(page);
  const stagedKey = `window.localStorage.getItem("telflo-playground-staged-edit") !== null`;
  expect(await page.evaluate<boolean>(stagedKey)).toBe(false);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const signIn = page.getByRole("alertdialog", { name: "Sign in to save" });
  await expect(signIn).toBeVisible();
  await expect(signIn.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?redirectTo=%2Fapp");
  expect(await page.evaluate<boolean>(stagedKey)).toBe(true);
  // Publish is shown and locked.
  await signIn.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(signupPrompt(page)).toBeVisible();
  expect(recorder.outside()).toEqual([]);
});

test("a phone gets the phone page: no editor, nothing checked", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/playground/editor/${GATEWAY_ID}`);
  await waitForHydration(page);
  await expect(page.getByText("The editor is best viewed on larger screens such as laptop or computer browsers.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to playground" })).toHaveAttribute("href", "/playground");
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  // Nothing checked, past the 1.5 s pause after which an opened text would be (Ruling 304).
  const checked = await sampled(() => recorder.apiRequests().length > 0, 20);
  expect(checked.some(Boolean)).toBe(false);
  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toEqual([]);
});
