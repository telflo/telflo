import { randomUUID } from "node:crypto";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, RULES_UNAVAILABLE_AT_SAVE_MESSAGE } from "@telflo/contracts";
import {
  deleteTestRegexes,
  findConfigurationVersions,
  findTestRegexIdsByName,
  grantProductAdmin,
  insertTestRegex,
  seedConfiguration,
  seedUser,
  type SeededUser,
} from "./support/database.js";
import { open } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { signInThroughApi, skipEditorTour, waitForHydration } from "./support/session.js";
import { openTestingTab, testRunText } from "./support/test-runs-page.js";
import { type VersionPath } from "./support/test-suites-page.js";
import {
  addFromLibraryButton,
  adminRegexRow,
  listTestRegexesThroughApi,
  openRegexPicker,
  openTestRegexAdmin,
  pickerCheckbox,
  pickerRow,
  regexDialog,
  uniqueRegexName,
} from "./support/test-regex-page.js";
import { ADMIN_NAV_ITEMS, adminNavItems } from "./support/test-templates-page.js";
import {
  createValidationPipelineThroughApi,
  expandValidationCard,
  listRulesThroughApi,
  openValidationSubtab,
  ottlMarker,
  ruleNames,
  toastWith,
  validationCard,
} from "./support/validation-pipelines-page.js";
import { versionPath } from "./support/versions-page.js";

// The regex library (D15b), in the browser: product admin's Test Regex page
// (its nav, create, edit and delete, the API's refusals under the field
// they are about, and its gate for everyone else), and a validation
// pipeline card's "Add from regex library" picker (two entries added as
// rules in the library's order, each row showing its description and regex;
// a pick refused on its own skipped and named, and a refusal every later
// pick would share stopping the run with the rest still ticked).
//
// - The library is global: every parallel test sees what another wrote.
//   Each test names its own entries `e2e-<uuid>…`, asserts only on its own
//   rows and the seeded ones it reads (never a count, the empty state or
//   the list's order), and deletes its own by id as the tables' owner when
//   it ends, however it ends (`testRegexes`, D15b Preflight ruling 17). The
//   seeded 35 are only read.
// - The fake evaluator answers by the regex (Preflight ruling 28 of D15a):
//   `fake-ottl-evaluator: invalid` is refused with its words, `busy` makes
//   the request 503. The API's own check turns either away at create, so the
//   picker's refused entries are written by SQL, as the tables' owner
//   (insertTestRegex), in a category of their own that sorts between the
//   seeded "PII / GDPR" and "Secrets", so they sit between the two seeded
//   picks in the library's order (category, then name).
// Each admin is a fresh user, made one by the README's SQL; each member
// works in an organization of their own.

const PASSWORD = "correct horse battery staple";

/** The picker's refused entries' category: after "PII / GDPR", before "Secrets" (the library's order, Preflight ruling 3). */
const BETWEEN_CATEGORY = "PII / GDPR e2e";

/**
 * The entries a test writes, deleted as the tables' owner when it ends: by
 * id, and by name for one created through the page, whose id the test only
 * learns after the Create (each name `e2e-…`, its own).
 */
interface TestRegexes {
  ids: string[];
  names: string[];
}

/** `testRegexes`: the entries a test writes, deleted when it ends. `secondContext`: a second person's browser. */
const test = base.extend<{ testRegexes: TestRegexes; secondContext: BrowserContext }>({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
  secondContext: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: E2E_WEB_URL, viewport: { width: 1440, height: 1000 } });
    await skipEditorTour(context);
    await use(context);
    await context.close();
  },
  // eslint-disable-next-line no-empty-pattern
  testRegexes: async ({}, use) => {
    const written: TestRegexes = { ids: [], names: [] };
    await use(written);
    const named = await findTestRegexIdsByName(written.names);
    await deleteTestRegexes([...new Set([...written.ids, ...named])]);
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

/** Each page error, as it happens: none is expected anywhere here. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** A product admin of their own, signed in on `page`. */
async function signedInProductAdmin(page: Page): Promise<SeededUser> {
  const admin = await seedUser({ password: PASSWORD });
  await grantProductAdmin(admin.email);
  await signInThroughApi(page, admin);
  return admin;
}

/**
 * A member signed in on `page` with a draft configuration of their own
 * (testRunText's `logs` pipeline) and its validation pipeline, the editor
 * open on the Validation subtab, the card expanded.
 */
async function openMembersValidationCard(page: Page) {
  const member = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: member.organizationId,
    createdByUserId: member.userId,
    name: `Regex library ${randomUUID()}`,
    yamlContent: testRunText(randomUUID()),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, member);
  const path: VersionPath = { organizationId: member.organizationId, configurationId: configuration.id, versionId: version!.id };
  const validationPipeline = await createValidationPipelineThroughApi(page, path, "logs");
  await open(page, versionPath(configuration.id, version!.id));
  await openTestingTab(page);
  await openValidationSubtab(page);
  const card = validationCard(page, "logs");
  await expandValidationCard(card);
  return { path, validationPipeline, card };
}

test("a product admin's nav lists User Feedback, Test Templates, Test Regex, Library, Flows, Users, then Product admins (D29 decision 36); a pattern is created, edited and deleted on Test Regex", async ({
  page,
  testRegexes,
}) => {
  const errors = pageErrors(page);
  await signedInProductAdmin(page);
  await openTestRegexAdmin(page);
  await expect(adminNavItems(page)).toHaveText(ADMIN_NAV_ITEMS);
  const name = uniqueRegexName();
  // Deleted by name when the test ends, even if it fails between the Create and finding the id.
  testRegexes.names.push(name);

  // Create.
  await page.getByRole("button", { name: "New Regex", exact: true }).click();
  const created = regexDialog(page, "New Test Regex");
  await created.getByLabel("Name", { exact: true }).fill(name);
  await created.getByLabel("Category", { exact: true }).fill("e2e");
  await created.getByLabel("Regex", { exact: true }).fill(String.raw`order-\d{6}`);
  await created.getByLabel("Description", { exact: true }).fill("An order number");
  await created.getByRole("button", { name: "Create", exact: true }).click();

  await expect(created).toBeHidden();
  await expect(toastWith(page, "Regex created")).toBeVisible();
  const row = adminRegexRow(page, name);
  await expect(row.getByRole("cell")).toHaveText([name, "e2e", String.raw`order-\d{6}`, "Delete"]);
  const entry = (await listTestRegexesThroughApi(page)).find((listed) => listed.name === name);
  // Deleted when the test ends from the moment it is found, even if a check below fails.
  if (entry !== undefined) testRegexes.ids.push(entry.id);
  expect(entry).toMatchObject({ name, category: "e2e", description: "An order number", regex: String.raw`order-\d{6}` });

  // Edit: its name, regex and description; its category stays.
  const renamed = uniqueRegexName();
  testRegexes.names.push(renamed);
  await row.getByRole("button", { name, exact: true }).click();
  const edit = regexDialog(page, "Edit Test Regex");
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(edit.getByLabel("Regex", { exact: true })).toHaveValue(String.raw`order-\d{6}`);
  await edit.getByLabel("Name", { exact: true }).fill(renamed);
  await edit.getByLabel("Regex", { exact: true }).fill(String.raw`invoice-[A-Z]{2}\d{4}`);
  await edit.getByLabel("Description", { exact: true }).fill("An invoice number");
  await edit.getByRole("button", { name: "Save", exact: true }).click();

  await expect(edit).toBeHidden();
  await expect(toastWith(page, "Regex updated")).toBeVisible();
  await expect(adminRegexRow(page, renamed).getByRole("cell")).toHaveText([renamed, "e2e", String.raw`invoice-[A-Z]{2}\d{4}`, "Delete"]);
  await expect(adminRegexRow(page, name)).toHaveCount(0);
  expect((await listTestRegexesThroughApi(page)).find((listed) => listed.id === entry!.id)).toMatchObject({
    name: renamed,
    category: "e2e",
    description: "An invoice number",
    regex: String.raw`invoice-[A-Z]{2}\d{4}`,
  });

  // Delete, through its confirmation; the focus goes to New Regex (its row gone).
  await adminRegexRow(page, renamed).getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete Test Regex" });
  await expect(confirmation).toContainText(renamed);
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(confirmation).toBeHidden();
  await expect(toastWith(page, "Regex deleted")).toBeVisible();
  await expect(adminRegexRow(page, renamed)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New Regex", exact: true })).toBeFocused();
  expect((await listTestRegexesThroughApi(page)).some((listed) => listed.id === entry!.id)).toBe(false);
  expect(errors).toEqual([]);
});

test("the Test Regex dialog shows a regex the evaluator refuses under Regex, and a name already taken under Name, and creates nothing", async ({
  page,
  testRegexes,
}) => {
  await signedInProductAdmin(page);
  // An entry of this test's, its name the one the dialog tries again.
  const taken = uniqueRegexName();
  testRegexes.ids.push(await insertTestRegex({ name: taken, category: "e2e", description: null, regex: "taken" }));
  await openTestRegexAdmin(page);
  const name = uniqueRegexName();
  testRegexes.names.push(name);

  await page.getByRole("button", { name: "New Regex", exact: true }).click();
  const dialog = regexDialog(page, "New Test Regex");
  const regex = dialog.getByLabel("Regex", { exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Category", { exact: true }).fill("e2e");
  // The fake evaluator refuses this regex, in RE2's words, as the real one refuses a lookahead.
  await regex.fill(ottlMarker("invalid"));
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  const refusal = "Invalid regex: error parsing regexp: missing closing ): `(fake-ottl-evaluator` (fake)";
  await expect(dialog.getByRole("alert")).toHaveText([refusal]);
  await expect(regex).toHaveAttribute("aria-invalid", "true");
  await expect(regex).toHaveAccessibleDescription(refusal);
  await expect(dialog.getByLabel("Name", { exact: true })).not.toHaveAttribute("aria-invalid", "true");

  // Mended, but under a name already taken: the API's words under Name.
  await regex.fill(String.raw`ticket-\d+`);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByLabel("Name", { exact: true }).fill(taken);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(dialog.getByRole("alert")).toHaveText(["A regex with that name already exists."]);
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveAccessibleDescription("A regex with that name already exists.");
  await expect(regex).not.toHaveAttribute("aria-invalid", "true");

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  const listed = await listTestRegexesThroughApi(page);
  expect(listed.some((entry) => entry.name === name)).toBe(false);
  expect(listed.filter((entry) => entry.name === taken).map((entry) => entry.regex)).toEqual(["taken"]);
});

test("someone not a product admin, at the Test Regex page, lands on /app", async ({ secondContext }) => {
  const member = await seedUser({ password: PASSWORD });
  const page = await secondContext.newPage();
  const errors = pageErrors(page);
  await signInThroughApi(page, member);

  // The document request is answered with the redirect.
  const response = await page.request.get("/product-admin/test-regex", { maxRedirects: 0 });
  expect([response.status(), response.headers()["location"]]).toEqual([302, "/app"]);
  await page.goto("/product-admin/test-regex");
  await waitForHydration(page);
  await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
  await expect(page.locator("#createNewConfigurationButton")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Test Regex", exact: true })).toHaveCount(0);
  // Its writes are refused too.
  const write = await page.request.post("/api/v1/test-regexes", {
    data: { name: uniqueRegexName(), category: "e2e", regex: "x" },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(write.status()).toBe(403);
  expect(errors).toEqual([]);
});

test("the picker adds two library entries as rules, in the library's order, each row showing its description and regex", async ({ page }) => {
  const errors = pageErrors(page);
  const { path, validationPipeline, card } = await openMembersValidationCard(page);

  const picker = await openRegexPicker(card);
  const ssn = pickerRow(picker, "US Social Security Number");
  await expect(ssn).toContainText("SSN format: 123-45-6789");
  await expect(ssn.locator("code")).toHaveText(String.raw`\d{3}-\d{2}-\d{4}`);
  await expect(pickerCheckbox(picker, "US Social Security Number")).toHaveAccessibleDescription("SSN format: 123-45-6789");
  const email = pickerRow(picker, "Email Address");
  await expect(email).toContainText("Matches email addresses (e.g., user@example.com)");
  await expect(email.locator("code")).toHaveText("[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}");

  // Ticked in the other order: saved in the library's.
  await pickerCheckbox(picker, "US Social Security Number").click();
  await pickerCheckbox(picker, "Email Address").click();
  await expect(pickerCheckbox(picker, "US Social Security Number")).toBeChecked();
  await expect(pickerCheckbox(picker, "Email Address")).toBeChecked();
  await picker.getByRole("button", { name: "OK", exact: true }).click();

  await expect(picker).toBeHidden();
  await expect(toastWith(page, "Added 2 validation rules")).toBeVisible();
  await expect(addFromLibraryButton(card)).toBeFocused();
  await expect(ruleNames(card)).toHaveText(["Does not contain: Email Address", "Does not contain: US Social Security Number"]);
  expect(
    (await listRulesThroughApi(page, path, validationPipeline.id)).map(({ kind, target, pattern, name, description }) => ({
      kind,
      target,
      pattern,
      name,
      description,
    })),
  ).toEqual([
    {
      kind: "not_contains_regex",
      target: "output",
      pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
      name: "Email Address",
      description: "Matches email addresses (e.g., user@example.com)",
    },
    {
      kind: "not_contains_regex",
      target: "output",
      pattern: String.raw`\d{3}-\d{2}-\d{4}`,
      name: "US Social Security Number",
      description: "SSN format: 123-45-6789",
    },
  ]);
  expect(errors).toEqual([]);
});

test("the picker names a pick refused on its own and goes on, and a refusal every later pick would share stops it, the unsaved picks still ticked", async ({
  page,
  testRegexes,
}) => {
  const errors = pageErrors(page);
  // Two entries the API wouldn't take, by SQL, between the seeded picks in the library's order (their category's, then their names').
  const run = randomUUID();
  const skipped = `e2e-${run}-1-skipped`;
  const stopping = `e2e-${run}-2-stopping`;
  testRegexes.ids.push(
    await insertTestRegex({ name: skipped, category: BETWEEN_CATEGORY, description: "Refused for itself", regex: ottlMarker("invalid") }),
    await insertTestRegex({ name: stopping, category: BETWEEN_CATEGORY, description: null, regex: ottlMarker("busy") }),
  );
  const { path, validationPipeline, card } = await openMembersValidationCard(page);

  const picker = await openRegexPicker(card);
  for (const name of ["AWS Access Key", stopping, skipped, "Email Address"]) await pickerCheckbox(picker, name).click();
  await expect(pickerRow(picker, skipped)).toContainText("Refused for itself");
  await expect(pickerRow(picker, stopping).locator("code")).toHaveText(ottlMarker("busy"));
  await picker.getByRole("button", { name: "OK", exact: true }).click();

  // Email Address saved; the skipped one named; the stopping one stops the run before AWS Access Key.
  await expect(picker.getByRole("alert")).toHaveText([
    `"${skipped}" wasn't added: Invalid regex: error parsing regexp: missing closing ): \`(fake-ottl-evaluator\` (fake)`,
    `Added 1 of 4 rules. The other 2 weren't added: ${RULES_UNAVAILABLE_AT_SAVE_MESSAGE}`,
  ]);
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("button", { name: "OK", exact: true })).toBeFocused();
  await expect(pickerCheckbox(picker, "Email Address")).not.toBeChecked();
  await expect(pickerCheckbox(picker, skipped)).toBeChecked();
  await expect(pickerCheckbox(picker, stopping)).toBeChecked();
  await expect(pickerCheckbox(picker, "AWS Access Key")).toBeChecked();
  await expect(picker.getByText(/^\d+ selected$/)).toHaveText("3 selected");

  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(ruleNames(card)).toHaveText(["Does not contain: Email Address"]);
  expect((await listRulesThroughApi(page, path, validationPipeline.id)).map((rule) => rule.name)).toEqual(["Email Address"]);
  expect(errors).toEqual([]);
});
