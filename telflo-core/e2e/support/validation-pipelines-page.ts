import { expect, type Locator, type Page } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type CreateValidationRuleRequest,
  type ValidationPipeline,
  type ValidationRule,
} from "@telflo/contracts";
import { fakeOttlEvaluatorMarker, type FakeOttlEvaluatorMarker } from "../../apps/api/src/testing/fake-ottl-evaluator.js";
import { subtab, versionApiPath, type VersionPath } from "./test-suites-page.js";

// The Testing tab's Validation subtab (D15a Tasks 8 and 9) in the browser:
// its validation pipelines' cards, their rules, "New validation pipeline",
// the rule editor's four modes, the delete confirmations; and the validation
// pipelines' API, for tests about something after creating. Shared by
// validation-rules.e2e.ts and the privacy review's scratch specs.
//
// The E2E API's evaluator is the OpenAPI-checked fake (start-fake-ottl-evaluator.ts):
// a rule passes unless its pattern or an OTTL string literal carries a
// marker (`ottlMarker`), so tests running in parallel each get the answer
// their own rules ask for.

const CSRF = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

/** The text that steers the fake evaluator: `fake-ottl-evaluator: <marker>`. */
export function ottlMarker(marker: FakeOttlEvaluatorMarker): string {
  return fakeOttlEvaluatorMarker(marker);
}

/** Opens the Validation subtab (the Testing tab already open) and waits for its validation pipelines to be read. */
export async function openValidationSubtab(page: Page): Promise<void> {
  await subtab(page, "Validation").click();
  await expect(subtab(page, "Validation")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Add validation pipeline", exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading validation pipelines" })).toHaveCount(0);
}

/** The validation pipeline card whose header shows the YAML pipeline `pipeline`. */
export function validationCard(page: Page, pipeline: string): Locator {
  return page.locator("li").filter({ has: page.locator("button[aria-expanded]").filter({ has: page.getByText(pipeline, { exact: true }) }) });
}

/** Expands the card (if it isn't) and waits for its rules to be read. */
export async function expandValidationCard(card: Locator): Promise<void> {
  const header = card.locator("button[aria-expanded]");
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByRole("status", { name: "Loading validation rules" })).toHaveCount(0);
  await expect(addRuleButton(card)).toBeVisible();
}

/** The card's "Add Validation Rule". */
export function addRuleButton(card: Locator): Locator {
  return card.getByRole("button", { name: "Add Validation Rule", exact: true });
}

/** The rules' rows in an expanded card, in its order: each holds the rule's display name and its Edit and Delete. */
export function ruleRows(card: Locator): Locator {
  return card.locator("li").filter({ has: card.page().getByRole("button", { name: /^Edit rule \d+: / }) });
}

/** The rules' display names ("Does not contain: SSN guard") in an expanded card, in its order. */
export function ruleNames(card: Locator): Locator {
  return ruleRows(card).locator("span[title]");
}

/** The rule editor, adding or editing. */
export function ruleEditor(page: Page, editing = false): Locator {
  return page.getByRole("dialog", { name: editing ? "Edit validation rule" : "Add validation rule" });
}

/** In a dialog: the select labelled `label` set to the option named `option`. */
export async function choose(dialog: Locator, label: string, option: string): Promise<void> {
  const trigger = dialog.getByLabel(label, { exact: true });
  await trigger.click();
  const page = dialog.page();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(trigger).toContainText(option);
}

/** "+ Pipeline", the YAML pipeline `pipeline` chosen, OK: the card shows. */
export async function createValidationPipelineInSubtab(page: Page, pipeline: string): Promise<void> {
  await page.getByRole("button", { name: "Add validation pipeline", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New validation pipeline" });
  await choose(dialog, "Pipeline", pipeline);
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(validationCard(page, pipeline)).toBeVisible();
}

/** The editor's Add rule (or Save, editing), and the dialog closes. */
export async function saveRule(dialog: Locator, editing = false): Promise<void> {
  await dialog.getByRole("button", { name: editing ? "Save" : "Add rule", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** A toast by its text. */
export function toastWith(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

// ── The API, as the page's session ────────────────────────────────────────

/** Creates the version's validation pipeline for the YAML pipeline `pipeline`, as "New validation pipeline" does. */
export async function createValidationPipelineThroughApi(page: Page, path: VersionPath, pipeline: string): Promise<ValidationPipeline> {
  const response = await page.request.post(`${versionApiPath(path)}/validation-pipelines`, { data: { pipeline }, headers: CSRF });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { validationPipeline: ValidationPipeline }).validationPipeline;
}

/** Creates a rule in the validation pipeline, as the rule editor saves it. */
export async function createRuleThroughApi(
  page: Page,
  path: VersionPath,
  validationPipelineId: string,
  rule: CreateValidationRuleRequest,
): Promise<ValidationRule> {
  const response = await page.request.post(`${versionApiPath(path)}/validation-pipelines/${validationPipelineId}/rules`, {
    data: rule,
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { rule: ValidationRule }).rule;
}

/** The version's validation pipelines as the page's session sees them; null when the API answers 404 (a draft not theirs). */
export async function listValidationPipelinesThroughApi(page: Page, path: VersionPath): Promise<ValidationPipeline[] | null> {
  const response = await page.request.get(`${versionApiPath(path)}/validation-pipelines`);
  if (response.status() === 404) return null;
  expect(response.status()).toBe(200);
  return ((await response.json()) as { validationPipelines: ValidationPipeline[] }).validationPipelines;
}

/** The validation pipeline's rules as the page's session sees them, in position order. */
export async function listRulesThroughApi(page: Page, path: VersionPath, validationPipelineId: string): Promise<ValidationRule[]> {
  const response = await page.request.get(`${versionApiPath(path)}/validation-pipelines/${validationPipelineId}/rules`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { rules: ValidationRule[] }).rules;
}

/** What a rule checks, and its name and description: what a version copy keeps. */
export function ruleContent(rule: ValidationRule) {
  return { kind: rule.kind, target: rule.target, pattern: rule.pattern, ottl: rule.ottl, name: rule.name, description: rule.description };
}
