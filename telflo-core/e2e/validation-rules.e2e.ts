import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
  RULES_UNAVAILABLE_RUN_MESSAGE,
} from "@telflo/contracts";
import { addMember, findConfigurationVersions, seedConfiguration, seedUser, type SeededUser } from "./support/database.js";
import { open } from "./support/editor-page.js";
import { signInThroughApi, skipEditorTour, switchOrganizationThroughApi } from "./support/session.js";
import {
  clickRun,
  openRunDialog,
  openTestingTab,
  otlpLogs,
  results,
  runRows,
  testingTab,
  testRunText,
  uploadAndSelect,
  type PickedFile,
} from "./support/test-runs-page.js";
import { listRunsThroughApi, readRunThroughApi, subtab, versionApiPath, type VersionPath } from "./support/test-suites-page.js";
import {
  addRuleButton,
  choose,
  createRuleThroughApi,
  createValidationPipelineInSubtab,
  createValidationPipelineThroughApi,
  expandValidationCard,
  listRulesThroughApi,
  listValidationPipelinesThroughApi,
  openValidationSubtab,
  ottlMarker,
  ruleContent,
  ruleEditor,
  ruleNames,
  ruleRows,
  saveRule,
  toastWith,
  validationCard,
} from "./support/validation-pipelines-page.js";
import { createVersionFromPicker, versionPath } from "./support/versions-page.js";

// Validation rules, in the browser: the Testing tab's Validation subtab, its
// validation pipelines and the rule editor's four modes, the evaluator's
// refusal of a broken rule at Save and its absence there, a run ending
// "Validation Failed" (the runs' list, the results' header, the grid, the
// count line and "Show test details"), a run whose rules pass, a run whose
// rules the evaluator can't check, a version copy, and a teammate's view of
// a draft's validation pipelines and of a published one's, against the E2E
// API's dispatcher, the OpenAPI-checked fake tester
// (start-fake-otelcol-testing.ts) and the OpenAPI-checked fake evaluator
// (start-fake-ottl-evaluator.ts).
//
// - The fake evaluator answers by the rules: a rule passes unless its
//   pattern or an OTTL string literal carries a marker,
//   `fake-ottl-evaluator: <invalid|fail|error|busy|unavailable>`
//   (support/validation-pipelines-page.ts's ottlMarker). `invalid` is
//   refused at Save with the evaluator's words; `unavailable` makes the
//   evaluator unanswerable for that request only, so the browsers' other
//   workers never see it down. A plain text rule is never checked at Save,
//   which is how a run carries an `unavailable` rule here.
// - The fake tester answers every run's text with a success whose output is
//   the input's own bytes.
// - Rules a test isn't about creating are created through the API, as the
//   page's session; the ones it is, through the subtab.
// Each test works in organizations of its own, so tests and browsers run in
// parallel. A second person is a second browser context.

const PASSWORD = "correct horse battery staple";

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeEach(async ({ context }) => {
  await skipEditorTour(context);
});

/** Each page error, as it happens: none is expected anywhere here. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** An OTLP logs file with a unique body, as a person picks it from their disk. */
function logsFile(): PickedFile {
  return { name: `app-logs-${randomUUID()}.json`, mimeType: "application/json", buffer: Buffer.from(otlpLogs(`hello ${randomUUID()}`)) };
}

interface Workspace extends VersionPath {
  user: SeededUser;
}

/**
 * A user signed in on `page` with a draft configuration in their personal
 * organization, its text testRunText's (one `logs` pipeline). The editor
 * isn't opened.
 */
async function seedWorkspace(page: Page): Promise<Workspace> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Validation ${randomUUID()}`,
    yamlContent: testRunText(randomUUID()),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, user);
  return { user, organizationId: user.organizationId, configurationId: configuration.id, versionId: version!.id };
}

/** The editor at the version, on its Testing tab's Validation subtab. */
async function openValidation(page: Page, path: VersionPath): Promise<void> {
  await open(page, versionPath(path.configurationId, path.versionId));
  await openTestingTab(page);
  await openValidationSubtab(page);
}

/** The rule Ana adds first: "Does not contain", Regex, an SSN pattern. */
const SSN_PATTERN = String.raw`\b\d{3}-\d{2}-\d{4}\b`;

/**
 * Waits until the selected run's results show the status `label` in its
 * header: the words beside "Status" (a failed run's "Error" section has the
 * same word as its label).
 */
async function expectHeader(page: Page, label: "Success" | "Error" | "Validation Failed"): Promise<void> {
  await expect(results(page).getByText("Status", { exact: true }).locator("xpath=following-sibling::span[1]")).toHaveText(label);
}

/** From the Tests subtab: the run dialog, a fresh logs file uploaded and selected, Run. */
async function runAFile(page: Page): Promise<void> {
  await subtab(page, "Tests").click();
  await expect(subtab(page, "Tests")).toHaveAttribute("aria-selected", "true");
  await openRunDialog(page);
  await uploadAndSelect(page, logsFile());
  await clickRun(page);
}

/** The Validation grid's row of the rule shown as `name` ("Does not contain: SSN guard"). */
function resultRow(page: Page, name: string) {
  return results(page).locator("li").filter({ has: page.getByText(name, { exact: true }) });
}

test("Ana's validation pipeline: + Pipeline for the YAML's pipeline, then a rule in each of the editor's four modes, each listed and stored as it was built", async ({
  page,
}) => {
  // Five trips through the dialogs, eleven of their selects: 14.6-19.9 s in
  // the new file's first runs (five workers), up to 66% of the 30 s per-test
  // limit (12.6-14.8 s in the whole suite's runs in the three browsers).
  // Slow triples the limit, a hang guard; every wait inside keeps its own
  // bound.
  test.slow();
  const errors = pageErrors(page);
  const path = await seedWorkspace(page);
  await openValidation(page, path);
  await expect(page.getByText("No validation pipelines yet. Click + Pipeline to create one.")).toBeVisible();

  await createValidationPipelineInSubtab(page, "logs");
  const card = validationCard(page, "logs");
  await expandValidationCard(card);
  await expect(card.getByText("No validation rules yet.")).toBeVisible();
  // The YAML has the pipeline: no warning.
  await expect(card.getByText("pipeline not found in current YAML")).toHaveCount(0);

  // Match output text: "Does Not Contain", Regex, an SSN pattern.
  await addRuleButton(card).click();
  const editor = ruleEditor(page);
  await expect(editor.getByLabel("Rule type", { exact: true })).toContainText("Match output text");
  await editor.getByLabel("Name", { exact: true }).fill("SSN guard");
  await choose(editor, "Match", "Does Not Contain");
  await choose(editor, "Type", "Regex");
  await editor.getByLabel("Regex pattern", { exact: true }).fill(SSN_PATTERN);
  await saveRule(editor);
  await expect(ruleNames(card)).toHaveText(["Does not contain: SSN guard"]);

  // Record count: at least 1 record.
  await addRuleButton(card).click();
  await choose(editor, "Rule type", "Record count");
  await editor.getByLabel("Name", { exact: true }).fill("Some records");
  await choose(editor, "Operator", "At least");
  await editor.getByLabel("Value", { exact: true }).fill("1");
  await saveRule(editor);

  // Record attribute: all records, env equals prod; no name, so its summary shows.
  await addRuleButton(card).click();
  await choose(editor, "Rule type", "Record attribute");
  await choose(editor, "Require", "All records match");
  await choose(editor, "Scope", "Record");
  await editor.getByLabel("Attribute key", { exact: true }).fill("env");
  await choose(editor, "Operator", "Equals");
  await editor.getByLabel("Value", { exact: true }).fill("prod");
  await saveRule(editor);

  // OTTL condition, in the logs signal's record context.
  await addRuleButton(card).click();
  await choose(editor, "Rule type", "OTTL condition");
  await expect(editor.getByLabel("Context", { exact: true })).toContainText("log");
  await editor.getByLabel("Name", { exact: true }).fill("Errors are tagged");
  await editor.getByLabel("OTTL condition", { exact: true }).fill('severity_number < 17 or attributes["error.type"] != nil');
  await saveRule(editor);

  await expect(ruleNames(card)).toHaveText([
    "Does not contain: SSN guard",
    "OTTL: Some records",
    'OTTL: all log: attributes["env"] == "prod"',
    "OTTL: Errors are tagged",
  ]);

  // Stored as each mode builds it: the builders' canonical OTTL included.
  const [validationPipeline] = (await listValidationPipelinesThroughApi(page, path))!;
  expect(validationPipeline).toMatchObject({ pipeline: "logs", signal: "logs", createdByUserId: path.user.userId });
  expect((await listRulesThroughApi(page, path, validationPipeline!.id)).map(ruleContent)).toEqual([
    { kind: "not_contains_regex", target: "output", pattern: SSN_PATTERN, ottl: null, name: "SSN guard", description: "" },
    {
      kind: "ottl",
      target: "output",
      pattern: null,
      ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "gte", value: 1 } },
      name: "Some records",
      description: "",
    },
    {
      kind: "ottl",
      target: "output",
      pattern: null,
      ottl: { context: "log", quantifier: "all", condition: 'attributes["env"] == "prod"' },
      name: "",
      description: "",
    },
    {
      kind: "ottl",
      target: "output",
      pattern: null,
      ottl: { context: "log", quantifier: "all", condition: 'severity_number < 17 or attributes["error.type"] != nil' },
      name: "Errors are tagged",
      description: "",
    },
  ]);

  // The Record attribute rule reopens in its builder.
  await ruleRows(card).nth(2).getByRole("button", { name: /^Edit rule 3: / }).click();
  const editing = ruleEditor(page, true);
  await expect(editing.getByLabel("Rule type", { exact: true })).toContainText("Record attribute");
  await expect(editing.getByLabel("Attribute key", { exact: true })).toHaveValue("env");
  await expect(editing.getByLabel("Value", { exact: true })).toHaveValue("prod");
  await editing.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editing).toBeHidden();
  expect(errors).toEqual([]);
});

test("a broken OTTL condition and a broken regex are refused at Save with the evaluator's words under their fields, the editor keeping what was typed", async ({
  page,
}) => {
  const errors = pageErrors(page);
  const path = await seedWorkspace(page);
  const validationPipeline = await createValidationPipelineThroughApi(page, path, "logs");
  await openValidation(page, path);
  const card = validationCard(page, "logs");
  await expandValidationCard(card);

  // Ben's condition, its string left open.
  const broken = `attributes["env"] == "prod ${ottlMarker("invalid")}`;
  await addRuleButton(card).click();
  const editor = ruleEditor(page);
  await choose(editor, "Rule type", "OTTL condition");
  const condition = editor.getByLabel("OTTL condition", { exact: true });
  await condition.fill(broken);
  await editor.getByRole("button", { name: "Add rule", exact: true }).click();

  const refusal = editor.getByRole("alert").filter({ hasText: "OTTL syntax error: " });
  await expect(refusal).toHaveText('OTTL syntax error: 1:1: unexpected token "fake-ottl-evaluator" (fake)');
  await expect(condition).toHaveAttribute("aria-invalid", "true");
  await expect(condition).toHaveAccessibleDescription(/OTTL syntax error: /);
  await expect(editor).toBeVisible();
  await expect(condition).toHaveValue(broken);
  expect(await listRulesThroughApi(page, path, validationPipeline.id)).toEqual([]);

  // A change of the condition clears the refusal; fixed, it saves.
  await condition.fill('attributes["env"] == "prod"');
  await expect(refusal).toHaveCount(0);
  await saveRule(editor);
  await expect(ruleNames(card)).toHaveText(['OTTL: all log: attributes["env"] == "prod"']);

  // A regex RE2 won't compile, under the pattern.
  await addRuleButton(card).click();
  await choose(editor, "Type", "Regex");
  const pattern = editor.getByLabel("Regex pattern", { exact: true });
  await pattern.fill(`(${ottlMarker("invalid")}`);
  await editor.getByRole("button", { name: "Add rule", exact: true }).click();
  const regexRefusal = editor.getByRole("alert").filter({ hasText: "Invalid regex: " });
  await expect(regexRefusal).toContainText("Invalid regex: error parsing regexp: missing closing )");
  await expect(pattern).toHaveAttribute("aria-invalid", "true");
  await expect(pattern).toHaveValue(`(${ottlMarker("invalid")}`);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toBeHidden();

  expect((await listRulesThroughApi(page, path, validationPipeline.id)).map((rule) => rule.ottl?.condition ?? rule.pattern)).toEqual([
    'attributes["env"] == "prod"',
  ]);
  expect(errors).toEqual([]);
});

test("with the evaluator unanswerable, Save is refused in its words and the editor keeps the rule; a plain text rule needs no check and saves", async ({
  page,
}) => {
  const path = await seedWorkspace(page);
  const validationPipeline = await createValidationPipelineThroughApi(page, path, "logs");
  await openValidation(page, path);
  const card = validationCard(page, "logs");
  await expandValidationCard(card);

  await addRuleButton(card).click();
  const editor = ruleEditor(page);
  await choose(editor, "Rule type", "OTTL condition");
  const unanswered = `body == "${ottlMarker("unavailable")}"`;
  const condition = editor.getByLabel("OTTL condition", { exact: true });
  await condition.fill(unanswered);
  await editor.getByRole("button", { name: "Add rule", exact: true }).click();

  await expect(toastWith(page, RULES_UNAVAILABLE_AT_SAVE_MESSAGE)).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(condition).toHaveValue(unanswered);
  await expect(editor.getByRole("button", { name: "Add rule", exact: true })).toBeEnabled();
  expect(await listRulesThroughApi(page, path, validationPipeline.id)).toEqual([]);

  // Text is matched as it is: nothing to check, so nothing to wait for.
  await choose(editor, "Rule type", "Match output text");
  await choose(editor, "Match", "Contains");
  await choose(editor, "Type", "Text");
  await editor.getByLabel("Text", { exact: true }).fill(ottlMarker("unavailable"));
  await saveRule(editor);
  await expect(ruleNames(card)).toHaveText([`Contains: ${ottlMarker("unavailable")}`]);
  expect((await listRulesThroughApi(page, path, validationPipeline.id)).map((rule) => [rule.kind, rule.pattern])).toEqual([
    ["contains_text", ottlMarker("unavailable")],
  ]);
});

test("a run whose rule fails ends Validation Failed: the runs' list, the results' header, the grid and its count line, and each rule's details", async ({
  page,
}) => {
  const errors = pageErrors(page);
  const path = await seedWorkspace(page);
  const validationPipeline = await createValidationPipelineThroughApi(page, path, "logs");
  const rules = [
    await createRuleThroughApi(page, path, validationPipeline.id, {
      kind: "not_contains_regex",
      target: "output",
      pattern: SSN_PATTERN,
      name: "SSN guard",
    }),
    await createRuleThroughApi(page, path, validationPipeline.id, {
      kind: "ottl",
      target: "output",
      ottl: { context: "log", quantifier: "all", condition: `attributes["env"] == "${ottlMarker("fail")}"` },
      name: "Production only",
      description: "Every record is tagged env: prod",
    }),
    await createRuleThroughApi(page, path, validationPipeline.id, {
      kind: "contains_text",
      target: "stderr",
      pattern: `Everything is ready ${ottlMarker("error")}`,
      name: "Collector ready",
    }),
  ];
  await open(page, versionPath(path.configurationId, path.versionId));
  await openTestingTab(page);

  await runAFile(page);

  await expectHeader(page, "Validation Failed");
  await expect(runRows(page)).toHaveCount(1);
  await expect(runRows(page).first()).toContainText("Validation Failed");
  const shown = results(page);
  await expect(shown.getByText("1 of 3 rules passed", { exact: true })).toBeVisible();
  await expect(resultRow(page, "Does not contain: SSN guard").getByRole("img", { name: "Passed" })).toBeVisible();
  await expect(resultRow(page, "OTTL: Production only").getByRole("img", { name: "Failed" })).toBeVisible();
  await expect(resultRow(page, "Contains: Collector ready").getByRole("img", { name: "Failed" })).toBeVisible();
  // Its output is kept and shown, as a passing run's.
  await expect(shown.getByRole("button", { name: "test-output.json", exact: true })).toBeVisible();

  // The failing OTTL rule's details: the rule as the run copied it, and why it failed.
  const details = page.getByRole("dialog", { name: "Validation test details" });
  const showFailed = shown.getByRole("button", { name: "Show test details for rule 2: Production only", exact: true });
  await showFailed.click();
  await expect(details).toContainText("Every record is tagged env: prod");
  await expect(details).toContainText(`attributes["env"] == "${ottlMarker("fail")}"`);
  await expect(details).toContainText("Failure details");
  await expect(details).toContainText("0 of 1 element matched; 1 did not.");
  await expect(details).toContainText("log #0");
  await expect(details).toContainText("condition evaluated to false");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(showFailed).toBeFocused();

  // The rule the evaluator couldn't check shows its own error.
  await shown.getByRole("button", { name: "Show test details for rule 3: Collector ready", exact: true }).click();
  await expect(details).toContainText("Not checked: the rules took longer than 20 s to check.");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // The passing rule's details: no failure.
  await shown.getByRole("button", { name: "Show test details for rule 1: SSN guard", exact: true }).click();
  await expect(details).toContainText(SSN_PATTERN);
  await expect(details.getByText("Failure details")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // What the API holds: the snapshot, in position order, and a result per rule.
  const [listed] = await listRunsThroughApi(page, path);
  expect(listed!.status).toBe("validation_failed");
  const run = await readRunThroughApi(page, path, listed!.id);
  expect(run.validationRules.map((rule) => rule.id)).toEqual(rules.map((rule) => rule.id));
  expect(run.validationResults!.map((result) => [result.id, result.passed])).toEqual([
    [rules[0]!.id, true],
    [rules[1]!.id, false],
    [rules[2]!.id, false],
  ]);
  expect(run.validationResults![1]!.detail).toMatchObject({ kind: "record_mismatch", totalCount: 1, matchedCount: 0, missCount: 1 });
  expect(errors).toEqual([]);
});

test("a run whose rules all pass ends Success, with its grid and count line", async ({ page }) => {
  const errors = pageErrors(page);
  const path = await seedWorkspace(page);
  const validationPipeline = await createValidationPipelineThroughApi(page, path, "logs");
  await createRuleThroughApi(page, path, validationPipeline.id, {
    kind: "not_contains_regex",
    target: "output",
    pattern: SSN_PATTERN,
    name: "SSN guard",
  });
  await createRuleThroughApi(page, path, validationPipeline.id, {
    kind: "ottl",
    target: "output",
    ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "gte", value: 1 } },
    name: "Some records",
  });
  await open(page, versionPath(path.configurationId, path.versionId));
  await openTestingTab(page);

  await runAFile(page);

  await expectHeader(page, "Success");
  await expect(runRows(page).first()).toContainText("Success");
  const shown = results(page);
  await expect(shown.getByText("2 of 2 rules passed", { exact: true })).toBeVisible();
  await expect(resultRow(page, "Does not contain: SSN guard").getByRole("img", { name: "Passed" })).toBeVisible();
  await expect(resultRow(page, "OTTL: Some records").getByRole("img", { name: "Passed" })).toBeVisible();
  await expect(shown.getByRole("img", { name: "Failed" })).toHaveCount(0);
  const [listed] = await listRunsThroughApi(page, path);
  const run = await readRunThroughApi(page, path, listed!.id);
  expect(run.status).toBe("succeeded");
  expect(run.validationResults!.map((result) => result.passed)).toEqual([true, true]);
  expect(errors).toEqual([]);
});

test("a run whose rules the evaluator can't check ends Error in its words, its output kept, and no grid", async ({ page }) => {
  const errors = pageErrors(page);
  const path = await seedWorkspace(page);
  const validationPipeline = await createValidationPipelineThroughApi(page, path, "logs");
  // A plain text rule isn't checked at Save, so it can carry the marker that leaves the evaluator unanswered.
  await createRuleThroughApi(page, path, validationPipeline.id, {
    kind: "contains_text",
    target: "output",
    pattern: ottlMarker("unavailable"),
    name: "Unanswered",
  });
  await open(page, versionPath(path.configurationId, path.versionId));
  await openTestingTab(page);

  await runAFile(page);

  await expectHeader(page, "Error");
  await expect(runRows(page).first()).toContainText("Error");
  const shown = results(page);
  await expect(shown.getByText(RULES_UNAVAILABLE_RUN_MESSAGE, { exact: true })).toBeVisible();
  await expect(shown.getByRole("button", { name: "test-output.json", exact: true })).toBeVisible();
  await expect(shown.getByText(/rules? passed$/)).toHaveCount(0);
  const [listed] = await listRunsThroughApi(page, path);
  const run = await readRunThroughApi(page, path, listed!.id);
  expect(run).toMatchObject({ status: "failed", errorCode: "rules_unavailable", validationResults: null });
  expect(run.outputSizeBytes).not.toBeNull();
  expect(errors).toEqual([]);
});

test("a version created from one with a validation pipeline carries it and its rules, in order, as copies of its own", async ({ page }) => {
  const path = await seedWorkspace(page);
  const validationPipeline = await createValidationPipelineThroughApi(page, path, "logs");
  const rules = [
    await createRuleThroughApi(page, path, validationPipeline.id, {
      kind: "not_contains_regex",
      target: "output",
      pattern: SSN_PATTERN,
      name: "SSN guard",
    }),
    await createRuleThroughApi(page, path, validationPipeline.id, {
      kind: "ottl",
      target: "output",
      ottl: { context: "log", quantifier: "all", condition: 'attributes["env"] == "prod"' },
      description: "Every record is tagged env: prod",
    }),
  ];
  await open(page, versionPath(path.configurationId, path.versionId));

  await createVersionFromPicker(page);

  await expect.poll(async () => (await findConfigurationVersions(path.configurationId)).length).toBe(2);
  const [, second] = await findConfigurationVersions(path.configurationId);
  await expect(page).toHaveURL(versionPath(path.configurationId, second!.id));
  const copy: VersionPath = { ...path, versionId: second!.id };
  const [copied] = (await listValidationPipelinesThroughApi(page, copy))!;
  expect(copied).toMatchObject({ pipeline: "logs", signal: "logs", versionId: second!.id, createdByUserId: path.user.userId });
  expect(copied!.id).not.toBe(validationPipeline.id);
  const copiedRules = await listRulesThroughApi(page, copy, copied!.id);
  expect(copiedRules.map(ruleContent)).toEqual(rules.map(ruleContent));
  expect(copiedRules.map((rule) => rule.id).some((id) => rules.some((rule) => rule.id === id))).toBe(false);

  // The new version's subtab shows them.
  await openTestingTab(page);
  await openValidationSubtab(page);
  const card = validationCard(page, "logs");
  await expandValidationCard(card);
  await expect(ruleNames(card)).toHaveText(["Does not contain: SSN guard", 'OTTL: all log: attributes["env"] == "prod"']);

  // The first version keeps its own.
  expect((await listValidationPipelinesThroughApi(page, path))!.map((listed) => listed.id)).toEqual([validationPipeline.id]);
  expect((await listRulesThroughApi(page, path, validationPipeline.id)).map((rule) => rule.id)).toEqual(rules.map((rule) => rule.id));
});

test("a teammate sees nothing of a draft's validation pipelines, and once it is published edits, adds and deletes its rules through the subtab", async ({
  page,
  browser,
}) => {
  const author = await seedUser({ password: PASSWORD });
  const teammate = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: author.userId, role: "admin" });
  await addMember({ userId: teammate.userId, organizationId: group.organizationId, role: "contributor" });
  const configuration = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    name: `Shared validation ${randomUUID()}`,
    yamlContent: testRunText(randomUUID()),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  const path: VersionPath = { organizationId: group.organizationId, configurationId: configuration.id, versionId: version!.id };

  // The author's validation pipeline and rule, on the draft.
  await signInThroughApi(page, author);
  await switchOrganizationThroughApi(page, group.organizationId);
  const validationPipeline = await createValidationPipelineThroughApi(page, path, "logs");
  const rule = await createRuleThroughApi(page, path, validationPipeline.id, {
    kind: "not_contains_text",
    target: "output",
    pattern: "password",
    name: "No passwords",
  });

  const teammateContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await skipEditorTour(teammateContext);
    const other = await teammateContext.newPage();
    const errors = pageErrors(other);
    await signInThroughApi(other, teammate);
    await switchOrganizationThroughApi(other, group.organizationId);

    // A draft: nothing of it, its validation pipelines included.
    expect(await listValidationPipelinesThroughApi(other, path)).toBeNull();
    expect((await other.request.get(`${versionApiPath(path)}/validation-pipelines/${validationPipeline.id}/rules`)).status()).toBe(404);
    await open(other, versionPath(configuration.id, version!.id));
    await expect(other.getByText("Configuration not found")).toBeVisible();
    await expect(testingTab(other)).toHaveCount(0);

    // Published: the teammate edits the author's rule, adds one and deletes the author's.
    const published = await page.request.post(`${versionApiPath(path)}/publish`, { headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } });
    expect(published.status()).toBe(200);
    await openValidation(other, path);
    const card = validationCard(other, "logs");
    await expandValidationCard(card);
    await expect(ruleNames(card)).toHaveText(["Does not contain: No passwords"]);

    await card.getByRole("button", { name: "Edit rule 1: No passwords", exact: true }).click();
    const editing = ruleEditor(other, true);
    await expect(editing.getByLabel("Text", { exact: true })).toHaveValue("password");
    await editing.getByLabel("Name", { exact: true }).fill("No secrets");
    await editing.getByLabel("Text", { exact: true }).fill("secret");
    await saveRule(editing, true);
    await expect(ruleNames(card)).toHaveText(["Does not contain: No secrets"]);
    expect((await listRulesThroughApi(page, path, validationPipeline.id)).map((each) => [each.id, each.name, each.pattern])).toEqual([
      [rule.id, "No secrets", "secret"],
    ]);

    await addRuleButton(card).click();
    const adding = ruleEditor(other);
    await adding.getByLabel("Name", { exact: true }).fill("The teammate's");
    await adding.getByLabel("Text", { exact: true }).fill("token");
    await saveRule(adding);
    await expect(ruleNames(card)).toHaveText(["Does not contain: No secrets", "Does not contain: The teammate's"]);

    await card.getByRole("button", { name: "Delete rule 1: No secrets", exact: true }).click();
    const confirmation = other.getByRole("alertdialog", { name: "Delete validation rule?" });
    await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(ruleNames(card)).toHaveText(["Does not contain: The teammate's"]);

    const stored = await listRulesThroughApi(page, path, validationPipeline.id);
    expect(stored.map((each) => [each.name, each.pattern, each.createdByUserId])).toEqual([["The teammate's", "token", teammate.userId]]);
    expect(errors).toEqual([]);
  } finally {
    await teammateContext.close();
  }
});

test("deleting a rule and a validation pipeline asks first; a pipeline the editor's text no longer has is flagged", async ({ page }) => {
  const path = await seedWorkspace(page);
  const logs = await createValidationPipelineThroughApi(page, path, "logs");
  // The API can't check a name against the editor's text: the text has no traces pipeline.
  const traces = await createValidationPipelineThroughApi(page, path, "traces");
  await createRuleThroughApi(page, path, logs.id, { kind: "contains_text", target: "output", pattern: "hello", name: "First" });
  await createRuleThroughApi(page, path, logs.id, { kind: "not_contains_text", target: "stderr", pattern: "panic", name: "Second" });
  await openValidation(page, path);

  await expect(validationCard(page, "traces").getByText("pipeline not found in current YAML")).toBeVisible();
  await expect(validationCard(page, "logs").getByText("pipeline not found in current YAML")).toHaveCount(0);

  // A rule: Cancel keeps it, the focus back on its Delete; Delete removes it.
  const card = validationCard(page, "logs");
  await expandValidationCard(card);
  const deleteFirst = card.getByRole("button", { name: "Delete rule 1: First", exact: true });
  const ruleConfirmation = page.getByRole("alertdialog", { name: "Delete validation rule?" });
  await deleteFirst.click();
  await expect(ruleConfirmation).toContainText("Delete the validation rule Contains: First?");
  await ruleConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(ruleConfirmation).toBeHidden();
  await expect(deleteFirst).toBeFocused();
  await expect(ruleNames(card)).toHaveText(["Contains: First", "Does not contain: Second"]);
  await deleteFirst.click();
  await ruleConfirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(ruleConfirmation).toBeHidden();
  await expect(ruleNames(card)).toHaveText(["Does not contain: Second"]);
  expect((await listRulesThroughApi(page, path, logs.id)).map((rule) => rule.name)).toEqual(["Second"]);

  // A validation pipeline, by its own confirmation.
  const pipelineConfirmation = page.getByRole("alertdialog", { name: "Delete validation pipeline?" });
  await validationCard(page, "traces").getByRole("button", { name: "Delete validation pipeline", exact: true }).click();
  await expect(pipelineConfirmation).toContainText("Really delete the validation pipeline traces and all its validation rules?");
  await pipelineConfirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(pipelineConfirmation).toBeHidden();
  await expect(validationCard(page, "traces")).toHaveCount(0);
  expect((await listValidationPipelinesThroughApi(page, path))!.map((listed) => listed.id)).toEqual([logs.id]);
  expect((await page.request.get(`${versionApiPath(path)}/validation-pipelines/${traces.id}/rules`)).status()).toBe(404);
});
