import { randomUUID } from "node:crypto";
import { expect, test as base, type Locator, type Page, type Request, type Route } from "@playwright/test";
import { VARIABLES_UNAVAILABLE_MESSAGE } from "@telflo/contracts";
import {
  findCollectorVersions,
  findConfigurationVersions,
  findDefaultCollectorDistribution,
  seedConfiguration,
  seedUser,
} from "./support/database.js";
import {
  cursorAtEndOfLine,
  editorText,
  expectShownFromTop,
  linesOf,
  open,
  openYamlTab,
  platformKeys,
  shownLines,
  typeLineAtTop,
} from "./support/editor-page.js";
import { fakeSnapshots } from "./support/fake-opamp-server.js";
import { canaryVariableValue } from "./support/privacy.js";
import { signInThroughApi, skipEditorTour } from "./support/session.js";
import { createVariableThroughApi, uniqueVariableName } from "./support/variables.js";

// The collector validator's feedback (D13b decisions 1–4, 7, 13–15), in the
// browser: the status bar under the YAML editor, its rows that jump, the
// requirements row, Apply's gate and its tooltips, manual edit mode's chip
// on the canvas, a retired pin, and publishing a text the collector refuses.
//
// The E2E API's validator is the OpenAPI-checked fake on 127.0.0.1:28086
// (support/fake-otelcol-validator.ts), shared by every test and browser, so
// each test's own text asks for its answer (Preflight ruling 20): valid by
// default; an error per component whose type starts with `unknown_`; an
// env_var requirement per `${env:NAME}`; 503 (validation unavailable) when
// the text holds `# fake-otelcol-validator: unavailable`. A retired pin
// never reaches the validator: the API answers it from the catalogue
// (decision 12). The catalogue is read, never written (Ruling 51): the
// retired pin is the first deprecated row the query returns and the checked
// version the distribution's default, never a hard-coded release.
//
// Each test works in an organization of its own, so tests and browsers run
// in parallel. The words are the spec's, written out here: the browser
// tests don't import the web app's modules.

const PASSWORD = "correct horse battery staple";

const VALIDATING_TEXT = "validating config…";
const UNAVAILABLE_TEXT = "validation unavailable · config not checked";
const UNAVAILABLE_REASON = "Validation is unavailable. Your YAML was not checked — retry shortly.";
const validText = (version: string) => `config valid · v${version}`;
const errorsText = (count: number, version: string) => `${count} ${count === 1 ? "error" : "errors"} · v${version}`;
const retiredText = (version: string) =>
  `not checked · v${version} is retired — pick an offered version to check this config`;
const requirementsText = (count: number) => `${count} deployment ${count === 1 ? "requirement" : "requirements"}`;

const APPLY_TOOLTIP = "Apply Changes and Exit Manual Mode";
const APPLY_VALIDATING_TOOLTIP = "Validating...";
const APPLY_ERRORS_TOOLTIP = "Validation Errors Exist";
const APPLY_UNCHECKED_TOOLTIP = "Validation unavailable — applying unchecked YAML";

const CHIP_VALIDATING = "Validating...";
const CHIP_VALID = "Yaml is Valid";
const CHIP_UNCHECKED = "Validation unavailable — YAML not checked.";
const CHIP_ERRORS = "Errors must be corrected.";

const MANUAL_EDIT_OVERLAY = "In Manual Edit Mode. Exit Manual Edit mode to resume canvas updates.";
const UNAVAILABLE_MARKER = "# fake-otelcol-validator: unavailable";
const PUBLISHED_MESSAGE = "Configuration published successfully";

/**
 * In every browser the editor's tour is marked done (`skipEditorTour`):
 * these tests aren't about it, and it would cover the page on a first visit
 * (D9a decision 14).
 */
const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

// ── The catalogue ──────────────────────────────────────────────────────────

/** The default distribution's default version, and its first deprecated one, as the sync wrote them. */
async function readCatalogue(): Promise<{ defaultVersion: string; retiredVersion: string }> {
  const distribution = await findDefaultCollectorDistribution();
  const versions = await findCollectorVersions(distribution.id);
  const defaultVersion = versions.find((version) => version.is_default)?.version;
  const retiredVersion = versions.find((version) => version.deprecated)?.version;
  if (defaultVersion === undefined || retiredVersion === undefined) {
    throw new Error("the catalogue holds no default or no deprecated version of its default distribution");
  }
  return { defaultVersion, retiredVersion };
}

// ── The texts ──────────────────────────────────────────────────────────────

/** Comment lines enough that the end of a text is out of Monaco's view while its top is shown. */
const FILLER = Array.from({ length: 80 }, (_, index) => `# filler ${index + 1}`);

/** A small configuration's lines: `filler` between its receivers and its exporters, and `exporters` after `debug`. */
function configurationLines({ filler = [] as string[], exporters = [] as string[] } = {}): string[] {
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc: {}",
    ...filler,
    "exporters:",
    "  debug: {}",
    ...exporters,
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      exporters: [debug]",
    "",
  ];
}

// ── The validation requests ──────────────────────────────────────────────

/** The page's validation requests: `POST …/versions/{versionId}/validation`. */
const VALIDATION_URL = "**/versions/*/validation";

function isValidation(request: Request): boolean {
  return request.method() === "POST" && /\/versions\/[^/]+\/validation$/.test(new URL(request.url()).pathname);
}

/** The collector version a validation request asks about (the editor always sends the pin on screen). */
function askedVersion(request: Request): string | undefined {
  return (request.postDataJSON() as { collectorVersion?: string } | null)?.collectorVersion;
}

/**
 * Holds every validation request the page sends until `release()` (Ruling
 * 69): while one is held, the editor can only be checking, so the test
 * reads "Validating..." without racing the answer. `held()` counts the
 * requests caught; `release()` lets them through and stops holding.
 */
async function holdValidation(page: Page): Promise<{ held: () => number; release: () => Promise<void> }> {
  let held = 0;
  let open!: () => void;
  const gate = new Promise<void>((settle) => {
    open = settle;
  });
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    held += 1;
    await gate;
    // A check the editor aborted meanwhile (a newer one superseded it) is
    // gone: there is nothing left to continue.
    await route.continue().catch(() => undefined);
  };
  await page.route(VALIDATION_URL, handler);
  return {
    held: () => held,
    release: async () => {
      open();
      await page.unroute(VALIDATION_URL, handler);
    },
  };
}

// ── The page ───────────────────────────────────────────────────────────────

function applyButton(page: Page): Locator {
  return page.getByRole("button", { name: "Apply", exact: true });
}

/**
 * Apply's tooltip, read by hovering the element that wraps the button (a
 * disabled button takes no pointer events), then the pointer moved away in
 * steps: Radix keeps a tooltip open while the pointer is in the area between
 * its trigger and its content, and decides only on a later move.
 */
async function expectApplyTooltip(page: Page, text: string): Promise<void> {
  await applyButton(page).locator("xpath=..").hover();
  await expect(page.getByRole("tooltip")).toHaveText(text);
  await page.mouse.move(0, 0, { steps: 10 });
  await page.mouse.move(1, 1);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

/** The status bar's line saying `text`. */
function bar(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true });
}

/** Manual edit mode's chip on the canvas, saying `text`. */
function chip(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true });
}

function toastWith(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

/**
 * Where Monaco's cursor is, as it draws it: the text of the line it
 * highlights as the cursor's, and the cursor's column on it (1-based), from
 * where the cursor is drawn among that line's characters. Read without
 * touching the editor, so nothing moves the cursor; null until both are
 * drawn. Monaco draws a space as a no-break space.
 */
function drawnCursor(page: Page): Promise<{ line: string; column: number } | null> {
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  return page.evaluate<{ line: string; column: number } | null>(`(() => {
    const editor = document.querySelector(".monaco-editor");
    const highlight = editor && editor.querySelector(".view-overlays .current-line");
    const cursor = editor && editor.querySelector(".cursors-layer .cursor");
    if (!highlight || !cursor) return null;
    const top = highlight.parentElement.style.top;
    const line = [...editor.querySelectorAll(".view-lines .view-line")].find((candidate) => candidate.style.top === top);
    if (!line) return null;
    const cursorLeft = cursor.getBoundingClientRect().left;
    let before = 0;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let index = 0; index < node.length; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        if (range.getBoundingClientRect().left < cursorLeft - 1) before += 1;
      }
    }
    return { line: line.textContent.replace(/\\u00a0/g, " "), column: before + 1 };
  })()`);
}

/**
 * The attributes, anywhere in the document (shadow roots included), whose
 * value holds `text`: replay records attributes unmasked (ADR 0024).
 */
function attributesHolding(page: Page, text: string): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    const text = ${JSON.stringify(text)};
    const found = [];
    const walk = (root) => {
      for (const element of root.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (attribute.value.includes(text)) found.push(element.tagName + "[" + attribute.name + "]");
        }
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
    return found;
  })()`);
}

/** Waits until `locator` is inside replay's blocked container (`ph-no-capture`). */
async function expectReplayBlocked(page: Page, locator: Locator): Promise<void> {
  await expect(page.locator(".ph-no-capture").filter({ has: locator })).toHaveCount(1);
}

/** A user signed in with a draft configuration holding `yamlContent`, its version 1 pinned to `collectorVersion` (default: the catalogue's). */
async function seedSignedIn(
  page: Page,
  yamlContent: string,
  collectorVersion?: string,
): Promise<{ organizationId: string; configurationId: string }> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Validated ${randomUUID()}`,
    yamlContent,
    ...(collectorVersion === undefined ? {} : { collectorVersion }),
  });
  await signInThroughApi(page, user);
  return { organizationId: user.organizationId, configurationId: configuration.id };
}

/** Opens the editor at the configuration and its YAML tab, and waits for Monaco to show the text's first line. */
async function openYaml(page: Page, configurationId: string, firstLine: string): Promise<void> {
  await open(page, `/editor/${configurationId}`);
  await openYamlTab(page);
  await expectShownFromTop(page, [firstLine]);
}

// ── The tests ──────────────────────────────────────────────────────────────

test("an unknown component typed in the YAML tab: 1 error, its row jumps to its key, Apply is held until it is fixed, and the chip follows", async ({
  page,
}) => {
  const { defaultVersion } = await readCatalogue();
  const word = `zq${randomUUID().replace(/-/g, "")}`;
  const lines = configurationLines({ filler: FILLER });
  const { configurationId } = await seedSignedIn(page, lines.join("\n"));
  await openYaml(page, configurationId, "receivers:");
  const keys = await platformKeys(page);

  // Opening checks at once; the fake answers valid.
  await expect(bar(page, validText(defaultVersion))).toBeVisible();

  // An exporter whose type the collector doesn't know, typed after `debug`,
  // near the end of the text; then back to the top, out of its sight.
  const debugLine = lines.indexOf("  debug: {}") + 1;
  await cursorAtEndOfLine(page, debugLine);
  await page.keyboard.press("Enter");
  await page.keyboard.type(`unknown_${word}: {}`);
  const typed = [...lines.slice(0, debugLine), `  unknown_${word}: {}`, ...lines.slice(debugLine)];
  await expect.poll(async () => linesOf(await editorText(page))).toEqual(typed);
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press(keys.top);
  await expectShownFromTop(page, ["receivers:"]);
  await expect.poll(async () => drawnCursor(page)).toEqual({ line: "receivers:", column: 1 });
  expect(await shownLines(page)).not.toContain(`  unknown_${word}: {}`);

  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeVisible();
  const errors = page.getByRole("button", { name: errorsText(1, defaultVersion), exact: true });
  await expect(errors).toBeVisible();
  await expect(errors).toHaveAttribute("aria-expanded", "false");
  await expect(chip(page, CHIP_ERRORS)).toBeVisible();
  await expect(applyButton(page)).toBeDisabled();
  await expectApplyTooltip(page, APPLY_ERRORS_TOOLTIP);

  // Expanded: the row names the component and says why, and jumps to its key.
  await errors.click();
  await expect(errors).toHaveAttribute("aria-expanded", "true");
  const row = page.getByRole("button", {
    name: `exporters::unknown_${word}: unknown type: "unknown_${word}" for id: "unknown_${word}"`,
    exact: true,
  });
  await expect(row).toBeVisible();
  await expectReplayBlocked(page, row);
  // ADR 0024: no attribute holds the message or the path (the id is in both).
  expect(await attributesHolding(page, word)).toEqual([]);
  expect(await attributesHolding(page, "unknown type")).toEqual([]);

  await row.click();

  await expect.poll(async () => shownLines(page)).toContain(`  unknown_${word}: {}`);
  await expect(page.locator(".monaco-editor.focused")).toHaveCount(1);
  await expect.poll(async () => drawnCursor(page)).toEqual({ line: `  unknown_${word}: {}`, column: 3 });

  // Fixed: `unknown_` deleted from the key, where the jump left the cursor.
  // Until the answer for the new text, the bar, Apply's tooltip and the chip
  // say it is being checked; the check is held (registered before the
  // first key), so its answer can't come before they are read (Ruling 69).
  const hold = await holdValidation(page);
  for (let deleted = 0; deleted < "unknown_".length; deleted += 1) await page.keyboard.press("Delete");
  await expect(bar(page, VALIDATING_TEXT)).toBeVisible();
  await expect(chip(page, CHIP_VALIDATING)).toBeVisible();
  await expect(applyButton(page)).toBeDisabled();
  await expectApplyTooltip(page, APPLY_VALIDATING_TOOLTIP);
  await expect.poll(async () => linesOf(await editorText(page))).toContain(`  ${word}: {}`);
  // Sent after the debounce, and held: still checking.
  await expect.poll(() => hold.held()).toBeGreaterThan(0);
  await expect(bar(page, VALIDATING_TEXT)).toBeVisible();
  await expect(chip(page, CHIP_VALIDATING)).toBeVisible();
  await expect(applyButton(page)).toBeDisabled();
  await hold.release();

  await expect(bar(page, validText(defaultVersion))).toBeVisible();
  await expect(chip(page, CHIP_VALID)).toBeVisible();
  await expect(errors).toBeHidden();
  await expect(applyButton(page)).toBeEnabled();
  await expectApplyTooltip(page, APPLY_TOOLTIP);
  expect(await attributesHolding(page, word)).toEqual([]);
});

test("a ${env:NAME} gives the requirements row: one deployment requirement, its title and description when expanded, beside a valid answer", async ({
  page,
}) => {
  const { defaultVersion } = await readCatalogue();
  const name = `E2E_ENDPOINT_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const yaml = configurationLines({ exporters: ["  otlp_http:", `    endpoint: \${env:${name}}`] }).join("\n");
  const { configurationId } = await seedSignedIn(page, yaml);
  await openYaml(page, configurationId, "receivers:");

  await expect(bar(page, validText(defaultVersion))).toBeVisible();
  const requirements = page.getByRole("button", { name: requirementsText(1), exact: true });
  await expect(requirements).toBeVisible();
  await expect(requirements).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(`Set environment variable ${name}`, { exact: true })).toBeHidden();

  await requirements.click();

  await expect(page.getByText(`Set environment variable ${name}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`This configuration references ${name} via \${env:${name}}.`)).toBeVisible();
  await expectReplayBlocked(page, requirements);
  expect(await attributesHolding(page, name)).toEqual([]);
});

test("the validator unavailable: amber 'validation unavailable' with the reason, the chip says so, and Apply applies the unchecked text", async ({
  page,
}) => {
  const yaml = [UNAVAILABLE_MARKER, ...configurationLines()].join("\n");
  const { configurationId } = await seedSignedIn(page, yaml);
  await openYaml(page, configurationId, UNAVAILABLE_MARKER);

  await expect(bar(page, UNAVAILABLE_TEXT)).toBeVisible();
  await expect(page.getByText(UNAVAILABLE_REASON, { exact: true })).toBeVisible();

  await typeLineAtTop(page, "# typed");

  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeVisible();
  await expect.poll(async () => editorText(page)).toBe(`# typed\n${yaml}`);
  await expect(chip(page, CHIP_UNCHECKED)).toBeVisible();
  await expect(bar(page, UNAVAILABLE_TEXT)).toBeVisible();
  await expect(applyButton(page)).toBeEnabled();
  await expectApplyTooltip(page, APPLY_UNCHECKED_TOOLTIP);

  await applyButton(page).click();

  await expect(page.getByText("Changes applied")).toBeVisible();
  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeHidden();
});

test("a version pinned to a retired collector is not checked, Apply stays allowed, and picking an offered version checks it", async ({
  page,
}) => {
  const { defaultVersion, retiredVersion } = await readCatalogue();
  const yaml = configurationLines().join("\n");
  const { configurationId } = await seedSignedIn(page, yaml, retiredVersion);
  await openYaml(page, configurationId, "receivers:");

  await expect(bar(page, retiredText(retiredVersion))).toBeVisible();

  await typeLineAtTop(page, "# typed");

  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeVisible();
  await expect.poll(async () => editorText(page)).toBe(`# typed\n${yaml}`);
  await expect(chip(page, CHIP_UNCHECKED)).toBeVisible();
  await expect(bar(page, retiredText(retiredVersion))).toBeVisible();
  await expect(applyButton(page)).toBeEnabled();
  await expectApplyTooltip(page, APPLY_UNCHECKED_TOOLTIP);

  // The toolbar's collector version picker: an offered version is checked
  // (decision 4) by exactly one request about that version. That a pick is
  // checked at once, not after the debounce, is proven by the hook's unit
  // test ("checks a pin change at once, without the debounce").
  const askedAbout: string[] = [];
  page.on("request", (request) => {
    if (isValidation(request)) askedAbout.push(askedVersion(request) ?? "");
  });
  await page.getByRole("combobox", { name: /^Collector version / }).click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  const picked = page.waitForRequest((request) => isValidation(request) && askedVersion(request) === defaultVersion);
  await list.getByRole("option", { name: `v${defaultVersion}` }).click();
  await picked;
  await expect(list).toBeHidden();

  await expect(bar(page, validText(defaultVersion))).toBeVisible();
  await expect(chip(page, CHIP_VALID)).toBeVisible();
  await expect(bar(page, retiredText(retiredVersion))).toBeHidden();
  expect(askedAbout).toEqual([defaultVersion]);
});

test("a version whose text the collector refuses is published all the same (decision 1), and the bar still shows its error", async ({
  page,
}) => {
  // The API's side of decision 1 is proven where the browser can't see it:
  // apps/api/src/modules/configurations/publishing.integration.test.ts builds
  // its server with UNCALLED_OTELCOL_VALIDATOR, whose every check rejects,
  // so a publish that called the validator would fail there with a 500.
  const { defaultVersion } = await readCatalogue();
  const yaml = configurationLines({ exporters: ["  unknown_exporter: {}"] }).join("\n");
  const { organizationId, configurationId } = await seedSignedIn(page, yaml);
  await openYaml(page, configurationId, "receivers:");
  await expect(bar(page, errorsText(1, defaultVersion))).toBeVisible();

  await page.getByRole("button", { name: "Publish", exact: true }).and(page.locator("[title]")).click();
  const dialog = page.getByRole("dialog", { name: "Publish Configuration" });
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(toastWith(page, PUBLISHED_MESSAGE)).toBeVisible();
  const [version] = await findConfigurationVersions(configurationId);
  expect(version!.published_at).toBeInstanceOf(Date);
  expect((await fakeSnapshots(organizationId, configurationId)).map((snapshot) => snapshot.yaml)).toEqual([yaml]);
  // A published version is checked too.
  await expect(bar(page, errorsText(1, defaultVersion))).toBeVisible();
});

// ── Organization variables (D20 default 27; decision 13; Preflight ruling 30) ──

test("a ${org:NAME} the organization defines: one 'Organization variables filled in' requirement naming it, beside a valid answer; the browser sends no value", async ({
  page,
}) => {
  const { defaultVersion } = await readCatalogue();
  const name = uniqueVariableName("E2E_ENDPOINT");
  const value = canaryVariableValue(randomUUID().slice(0, 8));
  const yaml = configurationLines({ exporters: ["  otlp_http:", `    endpoint: \${org:${name}}`] }).join("\n");
  const { organizationId, configurationId } = await seedSignedIn(page, yaml);
  await createVariableThroughApi(page, organizationId, name, value);
  const sent: Request[] = [];
  page.on("request", (request) => {
    if (isValidation(request)) sent.push(request);
  });
  await openYaml(page, configurationId, "receivers:");

  // The API filled in the value before the validator's checks: the text checks valid, and one row names what it filled in.
  await expect(bar(page, validText(defaultVersion))).toBeVisible();
  const requirements = page.getByRole("button", { name: requirementsText(1), exact: true });
  await expect(requirements).toBeVisible();
  await requirements.click();
  await expect(page.getByText("Organization variables filled in", { exact: true })).toBeVisible();
  await expect(
    page.getByText(`Validation filled in your organization's values of these variables before its checks: ${name}.`, { exact: true }),
  ).toBeVisible();
  await expectReplayBlocked(page, page.getByText("Organization variables filled in", { exact: true }));
  expect(await attributesHolding(page, name)).toEqual([]);

  // The browser sent the text as written, never a value: the API reads the values from the opamp-server.
  expect(sent.length).toBeGreaterThan(0);
  for (const request of sent) {
    expect(request.postData()).not.toContain(value);
    expect((request.postDataJSON() as { yaml: string }).yaml).toContain(`\${org:${name}}`);
  }
  // The value is nowhere in the page: its markup, attributes included.
  expect(await page.content()).not.toContain(value);
});

test("Validate with the organization's variables unreadable: amber 'validation unavailable' with the 503's words", async ({ page }) => {
  const name = uniqueVariableName("E2E_ENDPOINT");
  const yaml = configurationLines({ exporters: ["  otlp_http:", `    endpoint: \${org:${name}}`] }).join("\n");
  const { configurationId } = await seedSignedIn(page, yaml);
  // The API's answer when the opamp-server can't give the values (D20 platform choice P2), from the route: the
  // browser tests' opamp-server is shared, and can't be made unreachable for one test.
  await page.route(VALIDATION_URL, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "variables_unavailable", message: VARIABLES_UNAVAILABLE_MESSAGE } }),
    });
  });
  await openYaml(page, configurationId, "receivers:");

  await expect(bar(page, UNAVAILABLE_TEXT)).toBeVisible();
  await expect(page.getByText(VARIABLES_UNAVAILABLE_MESSAGE, { exact: true })).toBeVisible();
});
