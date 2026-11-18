import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { fakeOtelcolTestingMarker } from "../apps/api/src/testing/fake-otelcol-testing.js";
import { findConfigurationVersions, seedConfiguration, seedUser } from "./support/database.js";
import { open } from "./support/editor-page.js";
import { signInThroughApi, skipEditorTour } from "./support/session.js";
import { clickRun, expectStatus, openRunDialog, openTestingTab, results, resultsDialog, uploadAndSelect, type PickedFile } from "./support/test-runs-page.js";
import { type VersionPath } from "./support/test-suites-page.js";
import {
  createValidationPipelineThroughApi,
  expandValidationCard,
  listRulesThroughApi,
  openValidationSubtab,
  ruleEditor,
  ruleNames,
  saveRule,
  toastWith,
  validationCard,
} from "./support/validation-pipelines-page.js";
import { versionPath } from "./support/versions-page.js";

// Compare's "Create an OTTL rule" (D15b decisions 3 to 6), in the browser: a
// run whose pipeline added, changed and removed record attributes; the
// footer's chips, in the keys' order (the input's first, Preflight ruling
// 17); a chip opening the rule editor prefilled on its OTTL, whose Save adds
// the rule the Validation subtab then lists; and a chip with no validation
// pipeline for the run's pipeline, its toast, Compare kept open.
//
// - The fake tester answers a text carrying `# fake-otelcol-testing:
//   changes-attributes` with an output whose every record gained `e2e.added`
//   = "yes", had `e2e.changed` set to "after" and lost `e2e.removed`
//   (Preflight ruling 6); its decoded input is the input's own bytes.
// - The fake evaluator passes every rule without a marker of its own.
// Each test works in an organization of its own, so tests and browsers run
// in parallel.

const PASSWORD = "correct horse battery staple";

/** The run's YAML pipeline: a name of its own, so the toasts show it whole. */
const PIPELINE = "logs/compare";

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

/** One `logs/compare` pipeline from an OTLP receiver to the debug exporter, which the fake tester answers by changing attributes. */
function changingText(token: string): string {
  return [
    `# e2e-run: ${token}`,
    fakeOtelcolTestingMarker("changes-attributes"),
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      http: {}",
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    `    ${PIPELINE}:`,
    "      receivers: [otlp]",
    "      exporters: [debug]",
    "",
  ].join("\n");
}

/** OTLP/JSON logs, two records each with `e2e.changed` = "before" and `e2e.removed`, as a person picks it from their disk. */
function attributedLogsFile(): PickedFile {
  const record = (body: string) => ({
    timeUnixNano: "1700000000000000000",
    body: { stringValue: body },
    attributes: [
      { key: "e2e.changed", value: { stringValue: "before" } },
      { key: "e2e.removed", value: { stringValue: "gone" } },
    ],
  });
  const document = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "e2e" } }] },
        scopeLogs: [{ scope: {}, logRecords: [record(`first ${randomUUID()}`), record(`second ${randomUUID()}`)] }],
      },
    ],
  };
  return { name: `attributed-${randomUUID()}.json`, mimeType: "application/json", buffer: Buffer.from(`${JSON.stringify(document, null, 2)}\n`) };
}

/**
 * A user signed in on `page` with a draft configuration of their own
 * (changingText's), its validation pipeline for `logs/compare` when
 * `withValidationPipeline`, a run of attributedLogsFile ended Success, and
 * Compare open on it.
 */
async function openCompareOnAChangingRun(page: Page, { withValidationPipeline }: { withValidationPipeline: boolean }) {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Compare ${randomUUID()}`,
    yamlContent: changingText(randomUUID()),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, user);
  const path: VersionPath = { organizationId: user.organizationId, configurationId: configuration.id, versionId: version!.id };
  const validationPipeline = withValidationPipeline ? await createValidationPipelineThroughApi(page, path, PIPELINE) : null;
  await open(page, versionPath(configuration.id, version!.id));
  await openTestingTab(page);
  await openRunDialog(page);
  await uploadAndSelect(page, attributedLogsFile());
  await clickRun(page);
  await expectStatus(page, "Success");

  await results(page).getByRole("button", { name: "Compare input ↔ output", exact: true }).click();
  const compare = resultsDialog(page, "Compare input ↔ output");
  await expect(compare.locator(".monaco-diff-editor")).toBeVisible();
  return { path, validationPipeline, compare };
}

/** Compare's chips, in their order. */
function chips(compare: ReturnType<typeof resultsDialog>) {
  return compare.getByRole("group", { name: "Detected 3 candidate rules:" }).getByRole("button");
}

test("Compare offers a chip per attribute the run changed, in the keys' order; one opens the editor prefilled, whose Save adds the rule the Validation subtab lists", async ({
  page,
}) => {
  const errors = pageErrors(page);
  const { path, validationPipeline, compare } = await openCompareOnAChangingRun(page, { withValidationPipeline: true });

  await expect(compare.getByRole("status").filter({ hasText: "candidate rule" })).toHaveText("Detected 3 candidate rules:");
  // The input's keys first, as they first appear, then the output's own.
  await expect(chips(compare)).toHaveText([
    "+ attribute changed: e2e.changed",
    "+ attribute removed: e2e.removed",
    "+ attribute added: e2e.added",
  ]);

  await chips(compare).filter({ hasText: "+ attribute added: e2e.added" }).click();

  // Compare closes for the editor, prefilled on OTTL condition for the run's signal's records.
  await expect(compare).toBeHidden();
  const editor = ruleEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("combobox", { name: "Rule type", exact: true })).toHaveText("OTTL condition");
  await expect(editor.getByRole("combobox", { name: "Context", exact: true })).toHaveText("log");
  await expect(editor.getByRole("combobox", { name: "Require", exact: true })).toHaveText("All records match");
  await expect(editor.getByLabel("OTTL condition", { exact: true })).toHaveValue('attributes["e2e.added"] != nil');
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("");
  await saveRule(editor);

  await expect(toastWith(page, `Rule added to ${PIPELINE}`)).toBeVisible();
  // Back to the Compare link, the run still the one shown.
  await expect(results(page).getByRole("button", { name: "Compare input ↔ output", exact: true })).toBeFocused();
  expect(
    (await listRulesThroughApi(page, path, validationPipeline!.id)).map(({ kind, target, pattern, ottl, name }) => ({ kind, target, pattern, ottl, name })),
  ).toEqual([
    {
      kind: "ottl",
      target: "output",
      pattern: null,
      ottl: expect.objectContaining({ context: "log", quantifier: "all", condition: 'attributes["e2e.added"] != nil' }),
      name: "",
    },
  ]);

  await openValidationSubtab(page);
  const card = validationCard(page, PIPELINE);
  await expandValidationCard(card);
  await expect(ruleNames(card)).toHaveText(['OTTL: all log: attributes["e2e.added"] != nil']);
  expect(errors).toEqual([]);
});

test("a chip with no validation pipeline for the run's pipeline toasts that none exists yet and keeps Compare open", async ({ page }) => {
  const errors = pageErrors(page);
  const { compare } = await openCompareOnAChangingRun(page, { withValidationPipeline: false });

  await chips(compare).filter({ hasText: "+ attribute changed: e2e.changed" }).click();

  await expect(toastWith(page, `No validation pipeline exists for "${PIPELINE}" yet. Create one in the Validation tab first.`)).toBeVisible();
  await expect(compare).toBeVisible();
  await expect(ruleEditor(page)).toHaveCount(0);
  // The lookup over, no chip is held.
  for (const chip of await chips(compare).all()) await expect(chip).not.toHaveAttribute("aria-disabled", "true");
  await compare.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(compare).toBeHidden();
  expect(errors).toEqual([]);
});
