import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test as base, type Page, type Request } from "@playwright/test";
import { findCollectorVersions, findDefaultCollectorDistribution, seedConfiguration, seedUser } from "./support/database.js";
import {
  cursorAtEndOfLine,
  expectShownFromTop,
  goToLine,
  open,
  openYamlTab,
  tab,
  typeLineAtTop,
} from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { signInThroughApi, skipEditorTour } from "./support/session.js";

// The collector's schema in the YAML tab, in the browser: completion offers
// the pin's names and never an old one, hover shows upstream's description, a
// typo is a Warning that gates nothing, a pin picked in the toolbar switches
// the schema at once (syntax only while the new pin's file is on its way,
// never the previous pin's names), a retired pin and a schema that can't be
// had leave syntax markers only, the widgets stay inside replay's blocked
// container, a `yaml-language-server` modeline in the text requests nothing,
// and each pin's file is requested once per tab.
//
// The pins are the catalogue's offered 0.162.0 and 0.161.0, written out:
// `awss3` became `aws_s3` in 0.162.0 (the catalogue's renamedTypes), so the
// two show the schema following the pin. A test fails first, saying so,
// when the catalogue no longer offers either. The retired pin is the
// catalogue's first deprecated row (as validation.e2e.ts reads it).
//
// Monaco here (support/editor-page.ts's notes): completion is asked for
// with Escape then Ctrl+Space (every browser), never left to the
// suggestions Monaco offers while typing, so each read is of one explicit
// request; Monaco draws only what is in view, so what it marks is read from
// its drawn lines (`squiggles`). Each test works in an organization of its
// own, so tests and browsers run in parallel.

const PASSWORD = "correct horse battery staple";

const NEW_PIN = "0.162.0";
const OLD_PIN = "0.161.0";

/** The schema file the editor fetches for `pin`. */
const schemaPath = (pin: string) => `/schemas/otelcol-contrib/v${pin}.json`;

const validText = (version: string) => `config valid · v${version}`;
const retiredText = (version: string) =>
  `not checked · v${version} is retired — pick an offered version to check this config`;

const YAML_ALERT = "YAML Validation Error";
const UNDO_ALL_TITLE = "Undo all changes and exit manual mode";
/** Upstream's description of confignet's `endpoint` (the otlp receiver's `protocols.grpc.endpoint`). */
const ENDPOINT_DESCRIPTION = "Endpoint configures the address for this network connection.";

/**
 * In every browser the editor's tour is marked done (`skipEditorTour`):
 * these tests aren't about it, and it would cover the page on a first visit.
 */
const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

// ── The catalogue ──────────────────────────────────────────────────────────

/** The default distribution's first deprecated version; fails, saying so, when the pins written out above aren't both offered. */
async function readCatalogue(): Promise<{ retiredVersion: string }> {
  const distribution = await findDefaultCollectorDistribution();
  const versions = await findCollectorVersions(distribution.id);
  const offered = versions.filter((version) => !version.deprecated).map((version) => version.version);
  for (const pin of [NEW_PIN, OLD_PIN]) {
    if (!offered.includes(pin)) {
      throw new Error(`the catalogue no longer offers ${pin}: pick two offered versions around a rename for schema.e2e.ts`);
    }
  }
  const retiredVersion = versions.find((version) => version.deprecated)?.version;
  if (retiredVersion === undefined) throw new Error("the catalogue holds no deprecated version of its default distribution");
  return { retiredVersion };
}

// ── The texts ──────────────────────────────────────────────────────────────

/** The line under `receivers:` where completion is asked for: two spaces, with a sibling below it (a lone `o:\n  ` gets no completion). */
const COMPLETION_LINE = 2;

/**
 * A small configuration's lines: an empty, indented line under
 * `receivers:` for completion, and the otlp receiver's grpc endpoint
 * (hovered). `protocols` is the key a typo replaces; `note` is a comment.
 */
function configurationLines({ protocols = "protocols", note = "a note" } = {}): string[] {
  return [
    `receivers:`,
    `  `,
    `  otlp:`,
    `    ${protocols}:`,
    `      grpc:`,
    `        endpoint: 0.0.0.0:4317`,
    `# ${note}`,
    `exporters:`,
    `  debug: {}`,
    `service:`,
    `  pipelines:`,
    `    traces:`,
    `      receivers: [otlp]`,
    `      exporters: [debug]`,
    ``,
  ];
}

// ── The page ───────────────────────────────────────────────────────────────

/** A user signed in with a draft configuration holding `yamlContent`, its version 1 pinned to `collectorVersion`. */
async function seedSignedIn(page: Page, yamlContent: string, collectorVersion: string): Promise<{ configurationId: string }> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Schema ${randomUUID()}`,
    yamlContent,
    collectorVersion,
  });
  await signInThroughApi(page, user);
  return { configurationId: configuration.id };
}

/** Opens the editor at the configuration and its YAML tab, and waits for Monaco to show the text's first line. */
async function openYaml(page: Page, configurationId: string): Promise<void> {
  await open(page, `/editor/${configurationId}`);
  await openYamlTab(page);
  await expectShownFromTop(page, ["receivers:"]);
}

/** Every request the page makes (its workers' included), as they are sent. */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  return requests;
}

/** How many of `requests` asked for `path` on the web app's origin. */
function requestsFor(requests: readonly Request[], path: string): number {
  return requests.filter((request) => request.url() === `${E2E_WEB_URL}${path}`).length;
}

/** What one explicit completion request shows: its rows' labels, or none ("No suggestions."). */
type Offered = { rows: string[] } | { none: true };

/**
 * Rewrites line `lineNumber` as two spaces and `prefix`, asks for
 * completion at its end, and reads what Monaco shows: the rows' labels once
 * they are drawn, or none when it says "No suggestions.". Monaco draws only
 * the rows in view, so a test types a prefix that leaves few. Closes the
 * list after.
 */
async function offered(page: Page, lineNumber: number, prefix: string): Promise<Offered> {
  await rewriteLine(page, lineNumber, `  ${prefix}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Space");
  const shown = await readSuggestions(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".monaco-editor .suggest-widget.visible")).toHaveCount(0);
  return shown;
}

/** Replaces line `lineNumber`'s text with `text`, leaving the cursor at its end. */
async function rewriteLine(page: Page, lineNumber: number, text: string): Promise<void> {
  // Go to Line puts the cursor at the line's start; Shift+End selects it all, and typing replaces it.
  await goToLine(page, lineNumber);
  await page.keyboard.press("Shift+End");
  await page.keyboard.type(text);
}

/** Waits until the suggest widget shows rows or "No suggestions.", and reads it. */
async function readSuggestions(page: Page): Promise<Offered> {
  const read = () =>
    page.evaluate<Offered | null>(`(() => {
      const widget = document.querySelector(".monaco-editor .suggest-widget.visible");
      if (!widget) return null;
      const rows = [...widget.querySelectorAll(".monaco-list-row")].map((row) => row.querySelector(".label-name")?.textContent ?? "");
      if (rows.length > 0) return { rows };
      const message = widget.querySelector(".message");
      return message && message.textContent === "No suggestions." && getComputedStyle(message).display !== "none" ? { none: true } : null;
    })()`);
  await expect.poll(read).not.toBeNull();
  return (await read())!;
}

/** The labels `offered` read, or [] for none. */
function labels(shown: Offered): string[] {
  return "rows" in shown ? shown.rows : [];
}

/**
 * Monaco's squiggles on the drawn lines, top to bottom: each one's kind
 * (`warning` yellow, `error` red, from Monaco's `squiggly-*` classes) and
 * the text of the line it is on. Monaco draws a space as a no-break space.
 */
function squiggles(page: Page): Promise<{ kind: string; line: string }[]> {
  return page.evaluate<{ kind: string; line: string }[]>(`(() => {
    const editor = document.querySelector(".monaco-editor");
    if (!editor) return [];
    const lines = [...editor.querySelectorAll(".view-lines .view-line")];
    return [...editor.querySelectorAll(".view-overlays [class*='squiggly-']")]
      .map((squiggle) => {
        const top = squiggle.parentElement.style.top;
        const line = lines.find((candidate) => candidate.style.top === top);
        const kind = [...squiggle.classList].find((name) => name.startsWith("squiggly-")).slice("squiggly-".length);
        return { top: parseFloat(top), kind, line: line ? line.textContent.replace(/\\u00a0/g, " ") : "" };
      })
      .sort((a, b) => a.top - b.top)
      .map(({ kind, line }) => ({ kind, line }));
  })()`);
}

/** The line holding the otlp receiver's grpc endpoint, hovered by the tests. */
const ENDPOINT_LINE = 6;

/**
 * Opens Monaco's hover on the setting at the start of line `lineNumber`
 * from the keyboard, until it shows `text`. Each try: Go to Line, End then
 * Home (Monaco's Home stops at the line's first non-space character, the
 * setting's name), one step into the name, and Monaco's Show Hover (Ctrl+K
 * Ctrl+I; Cmd on a Mac, which Monaco reads from the user agent, as
 * support/editor-page.ts's `platformKeys` does, not Playwright's
 * `ControlOrMeta`, which follows the machine). A pointer hover never
 * showed on CI's Chromium, and a drawn line looked up once, before any
 * retry, wasn't drawn yet on CI's WebKit.
 */
async function hoverUntil(page: Page, lineNumber: number, text: string): Promise<void> {
  const modifier = (await page.evaluate<string>("navigator.userAgent")).includes("Macintosh") ? "Meta" : "Control";
  const hover = page.locator(".monaco-editor .monaco-hover:not(.hidden)");
  await expect(async () => {
    await goToLine(page, lineNumber);
    // Go to Line clicks the editor: the pointer is parked outside it, so no pointer hover replaces the one asked for.
    await page.mouse.move(1, 1);
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press(`${modifier}+K`);
    await page.keyboard.press(`${modifier}+I`);
    await expect(hover.filter({ hasText: text })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** The toolbar's collector version picker: picks `v<version>`. */
async function pickVersion(page: Page, version: string): Promise<void> {
  await page.getByRole("combobox", { name: /^Collector version / }).click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await list.getByRole("option", { name: `v${version}` }).click();
  await expect(list).toBeHidden();
}

/** Waits until completion under `receivers:` offers `name` (the pin's schema in effect: completion is off without one). */
async function expectOffered(page: Page, prefix: string, name: string): Promise<string[]> {
  let shown: string[] = [];
  await expect
    .poll(async () => {
      shown = labels(await offered(page, COMPLETION_LINE, prefix));
      return shown;
    })
    .toContain(name);
  return shown;
}

/** The status bar's line saying `text`. */
function bar(page: Page, text: string) {
  return page.getByText(text, { exact: true });
}

function applyButton(page: Page) {
  return page.getByRole("button", { name: "Apply", exact: true });
}

/**
 * The attributes, anywhere in the document (shadow roots included) outside
 * the editor's replay-blocked container, whose value holds `text`, case
 * ignored: replay records attributes unmasked.
 */
function attributesOutsideHolding(page: Page, text: string): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    const text = ${JSON.stringify(text.toLowerCase())};
    const container = document.querySelector(".monaco-editor").closest(".ph-no-capture");
    const found = [];
    const walk = (root) => {
      for (const element of root.querySelectorAll("*")) {
        if (container.contains(element)) continue;
        for (const attribute of element.attributes) {
          if (attribute.value.toLowerCase().includes(text)) found.push(element.tagName + "." + element.className + "[" + attribute.name + "]");
        }
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
    return found;
  })()`);
}

/**
 * Monaco's widgets in the page (completion's list and details, hover) and
 * Monaco's own elements outside the replay-blocked areas: each widget with
 * whether it is inside one, and each element outside with its attributes'
 * names and its text. The areas are the editor's container and the app
 * shell's one host for every Monaco's screen-reader live region, both
 * `ph-no-capture`.
 */
function monacoPlacement(page: Page): Promise<{
  widgets: { part: string; blocked: boolean }[];
  outside: { className: string; attributes: string[]; text: string }[];
}> {
  return page.evaluate(`(() => {
    const areas = [document.querySelector(".monaco-editor").closest(".ph-no-capture"), document.querySelector("[data-monaco-aria-host].ph-no-capture")]
      .filter((area) => area !== null);
    const blocked = (element) => areas.some((area) => area.contains(element));
    const parts = ["suggest-widget", "suggest-details-container", "suggest-details", "monaco-hover", "monaco-resizable-hover", "monaco-aria-container", "context-view"];
    const widgets = parts.flatMap((part) =>
      [...document.querySelectorAll("." + part)].map((element) => ({ part, blocked: blocked(element) })));
    // In the body (Monaco's theme is a <style class="monaco-colors"> in the head), styles and scripts aside.
    const outside = [...document.body.querySelectorAll("[class*='monaco'], .context-view, .context-view *, .suggest-widget, .suggest-details, .monaco-hover")]
      .filter((element) => !blocked(element) && !["STYLE", "SCRIPT", "LINK"].includes(element.tagName))
      .map((element) => ({ className: String(element.className), attributes: element.getAttributeNames().sort(), text: element.textContent }));
    return { widgets, outside };
  })()`);
}

// ── The tests ──────────────────────────────────────────────────────────────

for (const [pin, name, oldName] of [
  [NEW_PIN, "aws_s3", "awss3"],
  [OLD_PIN, "awss3", "aws_s3"],
] as const) {
  test(`completion under receivers: on ${pin} offers ${name}, never ${oldName}, and no old spelling`, async ({ page }) => {
    await readCatalogue();
    const { configurationId } = await seedSignedIn(page, configurationLines().join("\n"), pin);
    await openYaml(page, configurationId);

    const s3 = await expectOffered(page, "awss", name);
    expect(s3).not.toContain(oldName);
    // The pin's names: otlp, and file_log, never its old spelling filelog (an
    // alias the collector still reads, accepted through a pattern only).
    expect(labels(await offered(page, COMPLETION_LINE, "otl"))).toContain("otlp");
    const fileLog = labels(await offered(page, COMPLETION_LINE, "filel"));
    expect(fileLog).toContain("file_log");
    expect(fileLog).not.toContain("filelog");
  });
}

test("hover on a described setting shows upstream's description, and no Source link", async ({ page }) => {
  await readCatalogue();
  const { configurationId } = await seedSignedIn(page, configurationLines().join("\n"), NEW_PIN);
  await openYaml(page, configurationId);

  await hoverUntil(page, ENDPOINT_LINE, ENDPOINT_DESCRIPTION);

  const hover = page.locator(".monaco-editor .monaco-hover:not(.hidden)");
  await expect(hover).not.toContainText("Source:");
  await expect(hover).not.toContainText(".json");
});

test("a typo is a yellow Warning: Apply stays enabled, no YAML Validation Error, and the status bar keeps the validator's answer", async ({
  page,
}) => {
  await readCatalogue();
  const lines = configurationLines({ protocols: "protocls" });
  const { configurationId } = await seedSignedIn(page, lines.join("\n"), NEW_PIN);
  await openYaml(page, configurationId);

  await expect.poll(async () => squiggles(page)).toEqual([{ kind: "warning", line: "    protocls:" }]);
  // The validator's answer (the fake's: valid), untouched by the schema's warning.
  await expect(bar(page, validText(NEW_PIN))).toBeVisible();

  // Typing enters manual edit mode, where Apply shows.
  await typeLineAtTop(page, "# typed");

  await expectShownFromTop(page, ["# typed", "receivers:"]);
  await expect(applyButton(page)).toBeVisible();
  await expect(bar(page, validText(NEW_PIN))).toBeVisible();
  await expect(applyButton(page)).toBeEnabled();
  await expect(page.getByText(YAML_ALERT)).toHaveCount(0);
  await expect.poll(async () => squiggles(page)).toEqual([{ kind: "warning", line: "    protocls:" }]);
  await expect(page.locator(".monaco-editor .squiggly-error")).toHaveCount(0);
});

test("picking another offered version in the toolbar switches what completion offers, without a save or a reload", async ({
  page,
}) => {
  await readCatalogue();
  const { configurationId } = await seedSignedIn(page, configurationLines().join("\n"), NEW_PIN);
  await openYaml(page, configurationId);
  const requests = recordRequests(page);
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  expect(await expectOffered(page, "awss", "aws_s3")).not.toContain("awss3");

  await pickVersion(page, OLD_PIN);

  expect(await expectOffered(page, "awss", "awss3")).not.toContain("aws_s3");
  expect(requestsFor(requests, schemaPath(OLD_PIN))).toBe(1);
  // Nothing saved (the only writes are the validator's checks) and nothing reloaded.
  const writes = requests.filter((request) => request.method() !== "GET" && !/\/validation$/.test(new URL(request.url()).pathname));
  expect(writes.map((request) => `${request.method()} ${new URL(request.url()).pathname}`)).toEqual([]);
  expect(navigations).toBe(0);
});

test("a pin picked while its schema file is on its way offers neither pin's names until the file arrives, then the new pin's", async ({
  page,
}) => {
  await readCatalogue();
  const { configurationId } = await seedSignedIn(page, configurationLines().join("\n"), NEW_PIN);
  await openYaml(page, configurationId);
  expect(await expectOffered(page, "awss", "aws_s3")).not.toContain("awss3");

  // The old pin's file held back until the test lets it through.
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  let asked!: () => void;
  const reached = new Promise<void>((done) => (asked = done));
  await page.route(`**${schemaPath(OLD_PIN)}`, async (route) => {
    asked();
    await held;
    await route.continue();
  });
  try {
    await pickVersion(page, OLD_PIN);
    await reached;

    // While it is held: syntax only, so neither aws_s3 (the previous pin's) nor awss3 (not here yet).
    expect(await offered(page, COMPLETION_LINE, "awss")).toEqual({ none: true });
    expect(await offered(page, COMPLETION_LINE, "")).toEqual({ none: true });
  } finally {
    release();
  }

  expect(await expectOffered(page, "awss", "awss3")).not.toContain("aws_s3");
});

test("a version pinned to a retired collector offers no completion, warns about nothing, and still marks a syntax error in red", async ({
  page,
}) => {
  const { retiredVersion } = await readCatalogue();
  const requests = recordRequests(page);
  const lines = configurationLines({ protocols: "protocls" });
  const { configurationId } = await seedSignedIn(page, lines.join("\n"), retiredVersion);
  await openYaml(page, configurationId);
  await expect(bar(page, retiredText(retiredVersion))).toBeVisible();

  expect(await offered(page, COMPLETION_LINE, "")).toEqual({ none: true });

  // A syntax error typed at the top: red, and the alert counts it.
  await typeLineAtTop(page, "x: y: z");

  await expect.poll(async () => squiggles(page)).toContainEqual({ kind: "error", line: "x: y: z" });
  await expect(page.getByText(YAML_ALERT)).toBeVisible();
  // The schema's typo isn't marked: syntax only.
  expect((await squiggles(page)).filter((squiggle) => squiggle.kind !== "error")).toEqual([]);
  expect(requests.filter((request) => new URL(request.url()).pathname.startsWith("/schemas/"))).toEqual([]);
});

test("with completion and hover open, every widget is inside the editor's replay-blocked container, and nothing outside it holds the schema or the text", async ({
  page,
}) => {
  await readCatalogue();
  const note = `quokka${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const { configurationId } = await seedSignedIn(page, configurationLines({ note }).join("\n"), NEW_PIN);
  await openYaml(page, configurationId);
  const typed = "awss";
  // Words the text holds and the editor shows, and the schema's address.
  const forbidden = [
    note,
    typed,
    "0.0.0.0:4317",
    "protocols",
    "endpoint",
    `${E2E_WEB_URL}${schemaPath(NEW_PIN)}`,
    "/schemas/",
    ENDPOINT_DESCRIPTION.slice(0, 30),
  ];

  // Completion with its details pane open (Ctrl+Space again toggles it).
  await expectOffered(page, typed, "aws_s3");
  await cursorAtEndOfLine(page, COMPLETION_LINE);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".monaco-editor .suggest-widget.visible .monaco-list-row").first()).toBeVisible();
  const details = page.locator(".suggest-details-container .suggest-details");
  await expect(async () => {
    if (!(await details.isVisible())) await page.keyboard.press("Control+Space");
    await expect(details).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expectReplayPlacement(page, ["suggest-widget", "suggest-details"], forbidden);
  await page.keyboard.press("Escape");
  // The typed prefix away again: `awss` above `otlp:` reads as a key spanning two lines, a syntax error.
  await rewriteLine(page, COMPLETION_LINE, "  ");
  // A typed space asks for completion (monaco-yaml's trigger character): closed, so hover can show.
  await page.keyboard.press("Escape");
  await expect(page.locator(".monaco-editor .suggest-widget.visible")).toHaveCount(0);
  await expect(page.getByText(YAML_ALERT)).toHaveCount(0);

  // Hover on a described setting.
  await hoverUntil(page, ENDPOINT_LINE, ENDPOINT_DESCRIPTION);
  await expectReplayPlacement(page, ["monaco-hover"], forbidden);
});

/**
 * Every Monaco widget is inside the editor's replay-blocked container (the
 * live region inside the shell's blocked host), the `open` ones among them;
 * the only Monaco element outside them is Monaco's empty `div.context-view`
 * on `<body>` (class, style and aria-hidden only); and no attribute outside
 * the container holds any of `forbidden`.
 */
async function expectReplayPlacement(page: Page, open: string[], forbidden: string[]): Promise<void> {
  const { widgets, outside } = await monacoPlacement(page);
  expect(widgets.map((widget) => widget.part)).toEqual(expect.arrayContaining(open));
  expect(widgets.filter((widget) => !widget.blocked && widget.part !== "context-view")).toEqual([]);
  for (const element of outside) {
    expect(element.className.split(" ").filter(Boolean)).toEqual(["context-view"]);
    expect(element.text).toBe("");
    expect(element.attributes.filter((name) => !["class", "style", "aria-hidden"].includes(name))).toEqual([]);
  }
  for (const text of forbidden) expect(await attributesOutsideHolding(page, text), text).toEqual([]);
}

for (const [where, url] of [
  ["another origin", (port: number) => `http://127.0.0.1:${port}/x.json`],
  ["the app's own origin, absolute", () => "/api/v1/whatever"],
] as const) {
  test(`a yaml-language-server modeline naming ${where} requests nothing`, async ({ page }) => {
    await readCatalogue();
    // A server of the test's own on a free port: a request to it would be heard here, whatever the browser reports.
    const heard: string[] = [];
    const server: Server = createServer((request, response) => {
      heard.push(request.url ?? "");
      response.writeHead(404).end();
    });
    try {
      // A port that can't be had fails the test rather than hanging it.
      await new Promise<void>((listening, failed) => {
        server.once("error", failed);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", failed);
          listening();
        });
      });
      const port = (server.address() as AddressInfo).port;
      const schemaUrl = url(port);
      const requests = recordRequests(page);
      const { configurationId } = await seedSignedIn(page, configurationLines({ protocols: "protocls" }).join("\n"), NEW_PIN);
      await openYaml(page, configurationId);
      // The pin's schema in effect: the typo is marked.
      await expect.poll(async () => squiggles(page)).toEqual([{ kind: "warning", line: "    protocls:" }]);

      await typeLineAtTop(page, `# yaml-language-server: $schema=${schemaUrl}`);

      // The worker read the modeline: the document is now the named schema's,
      // which it marks as one it couldn't load, and the typo goes unmarked.
      await expect
        .poll(async () => {
          const shown = await squiggles(page);
          return shown.some((squiggle) => squiggle.kind === "warning") && !shown.some((squiggle) => squiggle.line === "    protocls:");
        })
        .toBe(true);
      const named = schemaUrl.startsWith("/") ? `${E2E_WEB_URL}${schemaUrl}` : schemaUrl;
      expect(requests.map((request) => request.url()).filter((address) => address === named || address.includes(`:${port}`))).toEqual([]);
      expect(heard).toEqual([]);
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });
}

test("each pin's schema is requested once per tab: switched away and back, and the tab left and reopened, nothing is requested again", async ({
  page,
}) => {
  await readCatalogue();
  const requests = recordRequests(page);
  const { configurationId } = await seedSignedIn(page, configurationLines().join("\n"), NEW_PIN);
  await openYaml(page, configurationId);
  await expectOffered(page, "awss", "aws_s3");

  await pickVersion(page, OLD_PIN);
  await expectOffered(page, "awss", "awss3");
  await pickVersion(page, NEW_PIN);
  await expectOffered(page, "awss", "aws_s3");
  // The YAML tab left and opened again: Monaco mounts afresh. Typing
  // entered manual edit mode, which keeps the YAML tab; Undo All leaves it.
  await page.getByTitle(UNDO_ALL_TITLE).click();
  await tab(page, "Configuration").click();
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await openYamlTab(page);
  await expectOffered(page, "awss", "aws_s3");

  expect(requestsFor(requests, schemaPath(NEW_PIN))).toBe(1);
  expect(requestsFor(requests, schemaPath(OLD_PIN))).toBe(1);
});

test("a schema file that answers 404 leaves syntax markers only, with nothing shown about it", async ({ page }) => {
  await readCatalogue();
  await page.route(`**${schemaPath(NEW_PIN)}`, (route) => route.fulfill({ status: 404, body: "" }));
  const lines = configurationLines({ protocols: "protocls" });
  const { configurationId } = await seedSignedIn(page, lines.join("\n"), NEW_PIN);
  const answered = page.waitForResponse((response) => response.url() === `${E2E_WEB_URL}${schemaPath(NEW_PIN)}`);
  await openYaml(page, configurationId);
  expect((await answered).status()).toBe(404);

  // Nothing said about it: no alert, no message; the editor is up.
  await expect(page.getByText(YAML_ALERT)).toHaveCount(0);
  await expect(page.getByText("The editor couldn't load.")).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  expect(await offered(page, COMPLETION_LINE, "")).toEqual({ none: true });

  // Syntax markers still work; the schema's typo isn't marked.
  await typeLineAtTop(page, "x: y: z");

  await expect.poll(async () => squiggles(page)).toContainEqual({ kind: "error", line: "x: y: z" });
  expect((await squiggles(page)).filter((squiggle) => squiggle.kind !== "error")).toEqual([]);
});
