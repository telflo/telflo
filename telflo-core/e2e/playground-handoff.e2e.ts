import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
// The SaaS pair: open registration, the Terms, the playground and the anonymous reads.
import { test } from "./support/saas.js";
import { findConfigurations, findConfigurationVersions, findMemberships, findUsersByEmail, seedUser } from "./support/database.js";
import { openYamlTab, typeLineAtTop } from "./support/editor-page.js";
import { linkFrom, waitForEmail } from "./support/mail.js";
import { recordPlaygroundRequests, sampled } from "./support/playground.js";
import { placesOf } from "./support/privacy.js";
import { signInThroughForm, skipEditorTour, waitForHydration } from "./support/session.js";

// The playground's handoff: Save in the playground editor or the blank
// public editor stages the edit in this browser; after registering (the
// /register form and its email link) or signing in, `/app` asks "Save your
// playground configuration?", and Save creates it in the person's
// organization and opens the editor on it; Discard asks once and removes
// it; a staged edit older than 7 days is ignored and removed; a visitor
// already signed in goes from Save straight to `/app`. Accounts are made-up
// `@example.test` addresses each test creates. The visitor's text is the
// test's own canary, a YAML comment; the created configuration's text is
// checked for it with booleans only, and it is never printed.

const PASSWORD = "correct horse battery staple";
const CONFIRMATION_SUBJECT = "Confirm your Telflo email address";
const GATEWAY_ID = "11111111-0000-4000-8000-000000000001";
const GATEWAY_NAME = "K8s Production Gateway";
const STAGED_KEY = "telflo-playground-staged-edit";
const SAVE_TITLE = "Save your playground configuration?";
const DISCARD_TITLE = "Discard your playground configuration?";
const EDITOR_PATH = /\/editor\/[0-9a-f-]{36}(\/[0-9a-f-]{36})?$/;

function anEmail(): string {
  return `handoff-${randomUUID()}@example.test`;
}

function aCanary(): string {
  return `handoff-canary-${randomUUID()}`;
}

function staged(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`window.localStorage.getItem(${JSON.stringify(STAGED_KEY)}) !== null`);
}

function saveDialog(page: Page) {
  return page.getByRole("dialog", { name: SAVE_TITLE });
}

/** Puts `line` (a YAML comment) before Monaco's first line, as typed. */
async function insertLineAtTop(page: Page, line: string): Promise<void> {
  await openYamlTab(page);
  // Typed once Monaco has the focus (the shared helper's), as the signed-in specs do (an insertText holding a
  // newline lands twice in Firefox), and seen on screen before anything reads it (a Save pressed before the insert
  // landed staged the text without it, under --repeat-each).
  await typeLineAtTop(page, line);
  const shown = `(document.querySelector(".monaco-editor .view-lines")?.textContent ?? "").replace(/\\u00a0/g, " ").includes(${JSON.stringify(line)})`;
  await expect.poll(() => page.evaluate<boolean>(shown)).toBe(true);
}

/** Opens a sample in the playground editor and types `canary` into its YAML. */
async function editSample(page: Page, canary: string): Promise<void> {
  await page.goto(`/playground/editor/${GATEWAY_ID}`);
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: GATEWAY_NAME })).toBeVisible();
  await insertLineAtTop(page, `# ${canary}`);
}

/** Opens the blank public editor on its template example and types `canary` into its YAML. */
async function editPublicExample(page: Page, canary: string): Promise<void> {
  await page.goto("/public-editor");
  await waitForHydration(page);
  const welcome = page.getByRole("dialog", { name: "Welcome to Telflo" });
  await welcome.getByRole("checkbox", { name: "Skip tour" }).check();
  await welcome.getByRole("button", { name: "Use a Template" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Example Pipeline" })).toBeVisible();
  await insertLineAtTop(page, `# ${canary}`);
}

/** Save, signed out: the edit staged, "Sign in to save" open. */
async function saveSignedOut(page: Page) {
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const signIn = page.getByRole("alertdialog", { name: "Sign in to save" });
  await expect(signIn).toBeVisible();
  expect(await staged(page)).toBe(true);
  return signIn;
}

/** Registers through the form and its emailed link, then signs in: the person lands on /app. */
async function registerThroughForm(page: Page, email: string): Promise<void> {
  await expect(page).toHaveURL("/register");
  await waitForHydration(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox", { name: /I agree to the/ }).check();
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL("/check-your-email");
  const link = linkFrom(await waitForEmail({ to: email, subject: CONFIRMATION_SUBJECT }), "/verify-email");
  await page.goto(link);
  await waitForHydration(page);
  await expect(page.getByText("Your email address is confirmed")).toBeVisible();
  await signInThroughForm(page, { email, password: PASSWORD });
}

/** The personal organization of the account registered as `email`. */
async function organizationOf(email: string): Promise<string> {
  const [user] = await findUsersByEmail(email);
  const memberships = await findMemberships(user!.id);
  expect(memberships).toHaveLength(1);
  return memberships[0]!.organization_id;
}

/** The configuration the dialog's Save made in `organizationId`: what it holds besides those it held before. */
interface Created {
  organizationId: string;
  before: string[];
  configurationId: string;
}

/** On /app, the dialog's Save: the editor opens on the new configuration. */
async function saveInDialog(page: Page, organizationId: string): Promise<Created> {
  // A new account's organization may hold configurations of its own already.
  const before = (await findConfigurations(organizationId)).map((configuration) => configuration.id);
  await saveDialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(EDITOR_PATH);
  const [, configurationId] = new URL(page.url()).pathname.split("/").slice(1);
  return { organizationId, before, configurationId: configurationId! };
}

/** The dialog made exactly one configuration, `name`, whose only version holds `canary` on Contrib 0.162.0. */
async function expectCreatedWith({ organizationId, before, configurationId }: Created, canary: string, name: string): Promise<void> {
  const configurations = (await findConfigurations(organizationId)).filter((configuration) => !before.includes(configuration.id));
  expect(configurations.map((configuration) => configuration.id)).toEqual([configurationId]);
  expect(configurations[0]!.name === name, "the configuration has the name the dialog sent").toBe(true);
  const versions = await findConfigurationVersions(configurationId);
  expect(versions.map((version) => version.version_number)).toEqual([1]);
  expect(versions[0]!.yaml_content.includes(canary), "version 1 holds the visitor's text").toBe(true);
  expect(versions[0]!.collector_version).toBe("0.162.0");
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context }) => {
  // The signed-in editor's own tour would cover the page the handoff opens, and
  // the playground's welcome dialog a first desktop visit: both seen.
  await skipEditorTour(context);
  await context.addInitScript({ content: `try { window.localStorage.setItem("telflo-playground-tour-completed", "true"); } catch {}` });
});

test("from the playground editor: Save → register → the dialog → Save → the editor on the new configuration, with the visitor's text", async ({
  page,
  context,
}) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  const canary = aCanary();
  const email = anEmail();
  await editSample(page, canary);
  const signIn = await saveSignedOut(page);
  // Nothing left the browser while in the playground but the anonymous validate.
  expect(recorder.outside()).toEqual([]);
  // Off the playground on purpose: the recorder judges nothing from here.
  recorder.leave();
  await signIn.getByRole("link", { name: "Create free account" }).click();

  await registerThroughForm(page, email);
  const dialog = saveDialog(page);
  await expect(dialog).toBeVisible();
  const nameField = dialog.getByLabel("Configuration name");
  await expect(nameField).toHaveValue(GATEWAY_NAME);
  await expect(dialog.getByText("pinned to collector v0.162.0")).toBeVisible();
  // The staged edit is configuration text: its name only as the field's value, inside ph-no-capture; its text nowhere.
  await expect(page.locator(".ph-no-capture").getByLabel("Configuration name")).toHaveCount(1);
  expect(await placesOf(page, [canary])).toEqual([{ inside: 0, outside: 0, inAttributes: 0 }]);
  expect(page.url().includes(canary)).toBe(false);

  await expectCreatedWith(await saveInDialog(page, await organizationOf(email)), canary, GATEWAY_NAME);
  expect(await staged(page)).toBe(false);
  await expect(page.getByRole("heading", { level: 1, name: GATEWAY_NAME })).toBeVisible();

  // Back on /app, nothing is asked again.
  await page.goto("/app");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "Configurations" })).toBeVisible();
  await expect(saveDialog(page)).toHaveCount(0);
});

test("from the blank public editor: Save → sign in → the dialog, the name changed → Save → the editor on the new configuration", async ({
  page,
  context,
}) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  const user = await seedUser({ password: PASSWORD, email: anEmail() });
  const canary = aCanary();
  const name = `Public example ${randomUUID().slice(0, 8)}`;
  await editPublicExample(page, canary);
  const signIn = await saveSignedOut(page);
  expect(recorder.outside()).toEqual([]);
  recorder.leave();
  await signIn.getByRole("link", { name: "Sign in" }).click();

  await page.waitForURL(/\/login/);
  await waitForHydration(page);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/app");

  const dialog = saveDialog(page);
  const nameField = dialog.getByLabel("Configuration name");
  await expect(nameField).toHaveValue("Example Pipeline");
  await nameField.fill(name);
  // The typed name: only the field's value (inside ph-no-capture), in no text, never the title.
  expect(await placesOf(page, [name])).toEqual([{ inside: 0, outside: 0, inAttributes: 1 }]);
  expect((await page.title()).includes(name)).toBe(false);
  await expectCreatedWith(await saveInDialog(page, user.organizationId), canary, name);
  expect(await staged(page)).toBe(false);
});

test("Discard asks once, removes the staged edit, and creates nothing", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD, email: anEmail() });
  const before = (await findConfigurations(user.organizationId)).length;
  await editSample(page, aCanary());
  await saveSignedOut(page);
  await signInThroughForm(page, user);

  const dialog = saveDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: DISCARD_TITLE });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  expect(await staged(page)).toBe(false);

  await page.reload();
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "Configurations" })).toBeVisible();
  await expect(saveDialog(page)).toHaveCount(0);
  expect((await findConfigurations(user.organizationId)).length).toBe(before);
});

// Signing out removes the staged edit. The dialog is modal, so the person closes it as one would (Escape
// keeps the edit, to be asked again), then signs out from the sidebar's menu; signed in again, nothing is
// asked and nothing is staged.
test("signing out without answering the dialog removes the staged edit: signed in again, nothing is asked", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD, email: anEmail() });
  const before = (await findConfigurations(user.organizationId)).length;
  await editSample(page, aCanary());
  await saveSignedOut(page);
  await signInThroughForm(page, user);

  const dialog = saveDialog(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await staged(page)).toBe(true);

  await page.getByTitle("Switch organization").click();
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL("/login");
  await expect.poll(() => staged(page)).toBe(false);

  await signInThroughForm(page, user);
  await expect(page.getByRole("heading", { level: 1, name: "Configurations" })).toBeVisible();
  // Not asked, for about two seconds after the page shows (the dialog opens in an effect once the terms are read).
  const asked = await sampled(async () => (await saveDialog(page).count()) > 0, 20);
  expect(asked.some(Boolean)).toBe(false);
  expect(await staged(page)).toBe(false);
  expect((await findConfigurations(user.organizationId)).length).toBe(before);
});

test("a staged edit older than 7 days is ignored and removed", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD, email: anEmail() });
  const before = (await findConfigurations(user.organizationId)).length;
  await editSample(page, aCanary());
  await saveSignedOut(page);
  // Its date moved 8 days back, the rest untouched (nothing read out of the page).
  const aged = await page.evaluate<boolean>(`(() => {
    const key = ${JSON.stringify(STAGED_KEY)};
    const edit = JSON.parse(window.localStorage.getItem(key));
    edit.savedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    window.localStorage.setItem(key, JSON.stringify(edit));
    return true;
  })()`);
  expect(aged).toBe(true);

  await signInThroughForm(page, user);
  await expect(page.getByRole("heading", { level: 1, name: "Configurations" })).toBeVisible();
  await expect.poll(() => staged(page)).toBe(false);
  await expect(saveDialog(page)).toHaveCount(0);
  expect((await findConfigurations(user.organizationId)).length).toBe(before);
});

test("a visitor already signed in: Save goes straight to /app, where the dialog asks", async ({ page, context }) => {
  const user = await seedUser({ password: PASSWORD, email: anEmail() });
  const canary = aCanary();
  await signInThroughForm(page, user);
  await expect(page.getByRole("heading", { level: 1, name: "Configurations" })).toBeVisible();

  // Into the playground in this tab (its user store holds them), as a link would.
  const recorder = recordPlaygroundRequests(context);
  await page.evaluate(`window.__reactRouterDataRouter.navigate(${JSON.stringify(`/playground/editor/${GATEWAY_ID}`)})`);
  await expect(page.getByRole("heading", { level: 1, name: GATEWAY_NAME })).toBeVisible();
  await insertLineAtTop(page, `# ${canary}`);
  expect(recorder.outside()).toEqual([]);

  // Save sends a signed-in visitor to /app: off the playground on purpose.
  recorder.leave();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL("/app");
  await expect(page.getByRole("alertdialog", { name: "Sign in to save" })).toHaveCount(0);
  await expect(saveDialog(page)).toBeVisible();
  await expectCreatedWith(await saveInDialog(page, user.organizationId), canary, GATEWAY_NAME);
});
