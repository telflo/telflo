import { expect, test as base, type Locator, type Page } from "@playwright/test";
import {
  STARTER_CONFIGURATION_NAME,
  STARTER_CONFIGURATION_YAML,
} from "../apps/api/src/modules/configurations/starter-configuration.js";
import {
  findConfigurations,
  findMemberships,
  findUsersByEmail,
  seedConfiguration,
  seedUser,
  uniqueEmail,
} from "./support/database.js";
import { clickGoogle, signInAtProvider } from "./support/oidc.js";
import {
  centre,
  cursorAtEndOfLine,
  editorText,
  insertAfter,
  linesOf,
  mouseDrag,
  nthIndex,
  open,
  openYamlTab,
  platformKeys,
  replaceLine,
  saveButton,
  storedVersion,
  tab,
  typeLineAtTop,
  unsavedBadge,
  versionAddress,
  viewport,
  waitForCanvas,
} from "./support/editor-page.js";
import { signInThroughApi, skipEditorTour, waitForHydration } from "./support/session.js";
import { E2E_SAAS_WEB_URL } from "./support/environment.js";

// The visual builder, in the browser: the canvas, the toolbox, the
// Configuration tab, undo, manual edit mode and the tour, against the text
// that stays the content. Each test works in an organization of its own,
// so tests and browsers run in parallel.
//
// React Flow in Playwright:
// - A palette chip is dragged onto the canvas with `locator.dragTo` (HTML5
//   drag and drop); handles and resizers with mouse steps.
// - Every drag stays inside the window: Firefox mis-sizes a drag that leaves
//   it. The window is 1600 × 1100, so the starter, fitted on open, sits well
//   inside it.
// - Where a point on the canvas is wanted, it is named in flow coordinates
//   and turned into the window's through the viewport's transform
//   (`flowToScreen`), so no test depends on the zoom the fit chose.
// - A node's flow position is read from its `transform` (React Flow draws a
//   node at its absolute position), and its flow size from its layout box.
// - The text is read by the YAML tab's Download: the whole text, exactly as
//   the editor holds it (Monaco draws only the lines in view).
// - The page's shortcuts follow `navigator.platform` (Cmd on a Mac, where
//   Playwright reports one for every browser), Monaco's follow the user
//   agent (Cmd only in WebKit's), so each is chosen from its own source.

const PASSWORD = "correct horse battery staple";
const STARTER_LINES = STARTER_CONFIGURATION_YAML.split("\n");
const MANUAL_EDIT_OVERLAY = "In Manual Edit Mode. Exit Manual Edit mode to resume canvas updates.";
const UNREADABLE_OVERLAY = "The canvas can't show this YAML until it reads as a configuration.";

/**
 * `tour`: whether the editor's tour may start. Off unless a test turns it on
 * (`skipEditorTour`): it would cover the page on a first visit.
 */
const test = base.extend<{ tour: boolean }>({
  tour: [false, { option: true }],
  context: async ({ context, tour }, use) => {
    if (!tour) await skipEditorTour(context);
    await use(context);
  },
});

test.use({ viewport: { width: 1600, height: 1100 } });

// ── The page ───────────────────────────────────────────────────────────────

/** The canvas's React Flow element. */
function flow(page: Page): Locator {
  return page.locator('[data-tour-step="canvas"] .react-flow');
}

function node(page: Page, id: string): Locator {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

/** The pipeline group whose badge reads `badge` ("Traces", "traces/extra"). */
function group(page: Page, badge: string): Locator {
  return page.locator(".react-flow__node-pipelineGroup").filter({ has: page.getByText(badge, { exact: true }) });
}

function componentNodes(page: Page): Locator {
  return page.locator(".react-flow__node:not(.react-flow__node-pipelineGroup)");
}

/** A point on the canvas, in flow coordinates, as a point in the window. */
async function flowToScreen(page: Page, point: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = await flow(page).boundingBox();
  if (box === null) throw new Error("the canvas isn't shown");
  const { x, y, zoom } = await viewport(page);
  return { x: box.x + x + point.x * zoom, y: box.y + y + point.y * zoom };
}

interface ShownNode {
  id: string;
  /** React Flow's node type: receiver, processor, …, pipelineGroup. */
  type: string;
  text: string;
  /** The absolute flow position and the flow size. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every node on the canvas, as drawn. */
function shownNodes(page: Page): Promise<ShownNode[]> {
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  return page.evaluate<ShownNode[]>(`[...document.querySelectorAll(".react-flow__node")].map((element) => {
    const match = /translate\\(([-\\d.e]+)px(?:, ([-\\d.e]+)px)?\\)/.exec(element.style.transform);
    return {
      id: element.getAttribute("data-id"),
      type: [...element.classList].find((name) => name.startsWith("react-flow__node-")).slice("react-flow__node-".length),
      text: element.textContent,
      x: Number(match[1]),
      y: Number(match[2] ?? 0),
      width: element.offsetWidth,
      height: element.offsetHeight,
    };
  })`);
}

async function shownNode(page: Page, id: string): Promise<ShownNode> {
  const found = (await shownNodes(page)).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no node ${id} on the canvas`);
  return found;
}

/** The arrangement, independent of ids: each node's type, text, position and size, sorted. */
function arrangement(nodes: readonly ShownNode[]): string[] {
  return nodes.map((n) => `${n.type} ${n.text} ${Math.round(n.x)},${Math.round(n.y)} ${n.width}x${n.height}`).sort();
}

/** The chip for `label` in the toolbox's `section` ("Receivers", …). */
function paletteChip(page: Page, section: string, label: string): Locator {
  return page
    .locator('[data-tour-step="toolbox"] .mb-5')
    .filter({ has: page.getByRole("heading", { name: section, exact: true }) })
    .locator('[draggable="true"]')
    .filter({ has: page.getByText(label, { exact: true }) });
}

/** Drags a toolbox chip onto the canvas at `at` (flow coordinates); returns the new node's id. */
async function dropFromToolbox(page: Page, chip: Locator, at: { x: number; y: number }): Promise<string> {
  const before = new Set((await shownNodes(page)).map((n) => n.id));
  const box = await flow(page).boundingBox();
  if (box === null) throw new Error("the canvas isn't shown");
  const point = await flowToScreen(page, at);
  await chip.dragTo(flow(page), {
    targetPosition: { x: point.x - box.x, y: point.y - box.y },
  });
  let added: string | undefined;
  await expect
    .poll(async () => {
      added = (await shownNodes(page)).find((n) => !before.has(n.id))?.id;
      return added;
    })
    .toBeDefined();
  return added!;
}

/** Draws a connection from `source`'s outgoing port to `target`'s incoming one. */
async function connect(page: Page, source: string, target: string): Promise<void> {
  await mouseDrag(
    page,
    await centre(node(page, source).locator(".react-flow__handle.source")),
    await centre(node(page, target).locator(".react-flow__handle.target")),
  );
}

/** The page's shortcut modifier: Cmd where `navigator.platform` is a Mac's (the page's rule). */
async function pageModifier(page: Page): Promise<"Meta" | "Control"> {
  const platform = await page.evaluate<string>("navigator.platform");
  return platform.toUpperCase().includes("MAC") ? "Meta" : "Control";
}

/** Waits for Monaco to be drawn and focuses it. */
async function focusMonaco(page: Page): Promise<void> {
  await page.locator(".monaco-editor .view-lines").click();
}

/**
 * A user with a configuration holding `yamlContent` (default the starter),
 * its version pinned to `collectorVersion` (default the database's), signed
 * in; the editor open on it.
 */
async function openSeeded(page: Page, yamlContent = STARTER_CONFIGURATION_YAML, collectorVersion?: string): Promise<string> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: STARTER_CONFIGURATION_NAME,
    yamlContent,
    ...(collectorVersion === undefined ? {} : { collectorVersion }),
  });
  await signInThroughApi(page, user);
  await open(page, `/editor/${configuration.id}`);
  return configuration.id;
}

/** `#rrggbb` as the browser reports a computed color. */
function rgb(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

/**
 * Selects a pipeline by clicking its group's badge, and shows it in the
 * Configuration tab (a selection switches to it; clicking the group that is
 * already selected changes no selection, so the tab is clicked too).
 */
async function selectPipeline(page: Page, badge: string): Promise<void> {
  await group(page, badge).getByText(badge, { exact: true }).click();
  await expect(group(page, badge)).toHaveClass(/\bselected\b/);
  await tab(page, "Configuration").click();
  await expect(
    page.getByRole("heading", {
      level: 3,
      name: badge.toLowerCase(),
      exact: true,
    }),
  ).toBeVisible();
}

/** The group's dashed box, whose border is the pipeline's color. */
function groupBox(page: Page, badge: string): Locator {
  return group(page, badge).locator(".border-dashed");
}

/** The traces pipeline's lines in the starter, as the text edits leave them unless told otherwise. */
const TRACES_RECEIVERS = "      receivers: [otlp]";
const TRACES_PROCESSORS = "      processors: [batch]";

/** The OTLP receiver's declaration as a drop writes it: the palette's defaults. */
const OTLP_2_DECLARATION = [
  "  otlp/2:",
  "    protocols:",
  "      grpc:",
  "        endpoint: localhost:4317",
  "      http:",
  "        endpoint: localhost:4318",
];

// ── The tests ──────────────────────────────────────────────────────────────

// The SaaS pair: a Google sign-up behind the Terms dialog.
test.describe("on the SaaS pair", () => {
  test.use({ baseURL: E2E_SAAS_WEB_URL });

  test("opening the Initial Configuration shows its three pipelines and their components, and nothing rewrites the starter", async ({
    page,
  }) => {
    // Only createAccount makes the starter: a Google sign-up through the fake provider.
    const email = uniqueEmail("gmail.com");
    await open(page, "/register");
    await clickGoogle(page);
    await signInAtProvider(page, { email });
    await page.waitForURL("/app");
    await waitForHydration(page);
    const terms = page.getByRole("dialog", { name: "Updated Terms of Service" });
    await terms.getByLabel("I agree to the Terms of Service and Privacy Policy").check();
    await terms.getByRole("button", { name: "Accept" }).click();
    await expect(terms).toBeHidden();
    await page.getByRole("heading", { name: STARTER_CONFIGURATION_NAME, exact: true }).click();
    const [user] = await findUsersByEmail(email);
    const [membership] = await findMemberships(user?.id ?? "");
    const [configuration] = await findConfigurations(membership?.organization_id ?? "");
    await expect(page).toHaveURL(await versionAddress(configuration?.id ?? ""));
    await waitForCanvas(page);

    await expect(page.locator(".react-flow__node-pipelineGroup")).toHaveCount(3);
    for (const badge of ["Traces", "Metrics", "Logs"]) {
      const lane = await shownNode(page, (await group(page, badge).getAttribute("data-id")) ?? "");
      // The pipeline's components sit inside its group: OTLP, Batch, OTLP, left to right.
      const inside = (await shownNodes(page))
        .filter((n) => n.type !== "pipelineGroup")
        .filter(
          (n) => n.x >= lane.x && n.y >= lane.y && n.x + n.width <= lane.x + lane.width && n.y + n.height <= lane.y + lane.height,
        )
        .sort((a, b) => a.x - b.x);
      expect(inside.map((n) => n.type)).toEqual(["receiver", "processor", "exporter"]);
      expect(inside.map((n) => n.text)).toEqual(["OTLPotlp3 pipelines", "Batchbatch3 pipelines", "OTLPotlp3 pipelines"]);
    }
    await expect(page.locator(".react-flow__node-extension")).toHaveText([
      "Health Checkhealth_check",
      "pprofpprof",
      "zPageszpages",
    ]);
    await expect(componentNodes(page)).toHaveCount(12);
    await expect(page.locator(".react-flow__edge")).toHaveCount(6);

    // Opening wrote nothing: the editor holds the starter, clean, and so does the database.
    expect(await editorText(page)).toBe(STARTER_CONFIGURATION_YAML);
    await expect(unsavedBadge(page)).toBeHidden();
    await expect(saveButton(page)).toBeDisabled();
    expect((await storedVersion(configuration?.id ?? "")).yaml_content).toBe(STARTER_CONFIGURATION_YAML);
  });
});

test("an OTLP receiver dragged into the traces pipeline writes otlp/2 in place; connections draw edges, and one to a processor changes the pipeline's processors", async ({
  page,
}) => {
  await openSeeded(page);
  await waitForCanvas(page);
  const traces = await shownNode(page, (await group(page, "Traces").getAttribute("data-id")) ?? "");

  // Below the pipeline's row, inside its group.
  const receiver = await dropFromToolbox(page, paletteChip(page, "Receivers", "OTLP"), {
    x: traces.x + 60,
    y: traces.y + traces.height - 20,
  });

  await expect(node(page, receiver)).toContainText("OTLP (2)");
  // Declared at the end of receivers, and a receiver of the pipeline it was
  // dropped in (its group's); every other line as it was.
  const dropped = replaceLine(
    insertAfter(STARTER_LINES, "        endpoint: '0.0.0.0:4318'", OTLP_2_DECLARATION),
    TRACES_RECEIVERS,
    "      receivers: [otlp, otlp/2]",
  );
  expect(linesOf(await editorText(page))).toEqual(dropped);
  await expect(unsavedBadge(page)).toBeVisible();

  // Connected to Batch: an edge; the receivers were already the group's.
  await connect(page, receiver, "node_1");

  await expect(page.locator(".react-flow__edge")).toHaveCount(7);
  expect(linesOf(await editorText(page))).toEqual(dropped);

  // A processor dropped beside it is declared, and joins the pipeline's
  // processors only once a connection draws it into the chain.
  const processor = await dropFromToolbox(page, paletteChip(page, "Processors", "Memory Limiter"), {
    x: traces.x + 320,
    y: traces.y + traces.height - 20,
  });
  const declared = insertAfter(dropped, "    send_batch_size: 1024", [
    "  memory_limiter:",
    "    check_interval: 1s",
    "    limit_mib: 512",
  ]);
  expect(linesOf(await editorText(page))).toEqual(declared);

  await connect(page, receiver, processor);

  await expect(page.locator(".react-flow__edge")).toHaveCount(8);
  expect(linesOf(await editorText(page))).toEqual(
    replaceLine(declared, TRACES_PROCESSORS, "      processors: [batch, memory_limiter]"),
  );
});

test("a node can't be dragged out of its pipeline; moving it, resizing a group and tidying up make the editor dirty; saved, the arrangement survives a reload", async ({
  page,
}) => {
  const configurationId = await openSeeded(page);
  await waitForCanvas(page);
  const traces = await shownNode(page, (await group(page, "Traces").getAttribute("data-id")) ?? "");
  const debug = await dropFromToolbox(page, paletteChip(page, "Exporters", "Debug"), {
    x: traces.x + traces.width - 260,
    y: traces.y + traces.height - 20,
  });
  expect(await editorText(page)).toContain("      exporters: [otlp, debug]\n    metrics:");

  // Towards the metrics pipeline: it stays inside traces, so the text
  // doesn't change.
  const textBefore = await editorText(page);
  const metrics = await shownNode(page, (await group(page, "Metrics").getAttribute("data-id")) ?? "");
  const from = await centre(node(page, debug));
  const to = await flowToScreen(page, {
    x: metrics.x + metrics.width - 160,
    y: metrics.y + metrics.height - 10,
  });
  await mouseDrag(page, from, to);

  const after = await shownNode(page, debug);
  expect(after.x).toBeGreaterThanOrEqual(traces.x);
  expect(after.y).toBeGreaterThanOrEqual(traces.y);
  expect(after.x + after.width).toBeLessThanOrEqual(traces.x + traces.width + 1);
  expect(after.y + after.height).toBeLessThanOrEqual(traces.y + traces.height + 1);
  expect(await editorText(page)).toBe(textBefore);

  // The logs group, selected, grows from its bottom-right handle.
  const logsId = (await group(page, "Logs").getAttribute("data-id")) ?? "";
  const logsBefore = await shownNode(page, logsId);
  await group(page, "Logs").getByText("Logs", { exact: true }).click();
  const handle = node(page, logsId).locator(".react-flow__resize-control.handle.bottom.right");
  await expect(handle).toBeVisible();
  const corner = await centre(handle);
  await mouseDrag(page, corner, { x: corner.x + 80, y: corner.y + 40 });

  await expect.poll(async () => (await shownNode(page, logsId)).width).toBeGreaterThan(logsBefore.width);
  expect((await shownNode(page, logsId)).height).toBeGreaterThan(logsBefore.height);

  await page.getByRole("button", { name: "Tidy up layout" }).click();

  await expect(unsavedBadge(page)).toBeVisible();
  const beforeSave = arrangement(await shownNodes(page));
  await saveButton(page).click();
  await expect(page.getByText("Saved configuration")).toBeVisible();
  await expect(unsavedBadge(page)).toBeHidden();

  // The database's nodes put each node where the canvas showed it (a
  // child's position is relative to its group).
  const stored = (await storedVersion(configurationId)).nodes as {
    type: string;
    position: { x: number; y: number };
    parentId?: string;
    id: string;
  }[];
  const byId = new Map(stored.map((n) => [n.id, n]));
  const storedPlaces = stored
    .map((n) => {
      const parent = n.parentId === undefined ? undefined : byId.get(n.parentId);
      return `${n.type} ${Math.round(n.position.x + (parent?.position.x ?? 0))},${Math.round(n.position.y + (parent?.position.y ?? 0))}`;
    })
    .sort();
  const shownPlaces = (await shownNodes(page)).map((n) => `${n.type} ${Math.round(n.x)},${Math.round(n.y)}`).sort();
  expect(storedPlaces).toEqual(shownPlaces);

  await page.reload();
  await waitForHydration(page);
  await waitForCanvas(page);

  await expect.poll(async () => arrangement(await shownNodes(page))).toEqual(beforeSave);
  await expect(unsavedBadge(page)).toBeHidden();
});

test("an OTLP exporter dropped on a version pinned to 0.162.0 is written otlp_grpc/2, and saved, keeps its place after a reload", async ({
  page,
}) => {
  await openSeeded(page, STARTER_CONFIGURATION_YAML, "0.162.0");
  await waitForCanvas(page);
  const traces = await shownNode(page, (await group(page, "Traces").getAttribute("data-id")) ?? "");
  // The starter's exporters already hold otlp: the drop is numbered after it, in the spelling 0.162.0 knows.
  const exporter = await dropFromToolbox(page, paletteChip(page, "Exporters", "OTLP"), {
    x: traces.x + traces.width - 260,
    y: traces.y + traces.height - 20,
  });
  await expect(node(page, exporter)).toContainText("OTLP (2)");
  expect(await editorText(page)).toContain("\n  otlp_grpc/2:\n");
  expect(await editorText(page)).toContain("      exporters: [otlp, otlp_grpc/2]\n    metrics:");
  const dropped = await shownNode(page, exporter);
  const beforeSave = arrangement(await shownNodes(page));

  await saveButton(page).click();
  await expect(page.getByText("Saved configuration")).toBeVisible();
  await expect(unsavedBadge(page)).toBeHidden();
  await page.reload();
  await waitForHydration(page);
  await waitForCanvas(page);

  await expect.poll(async () => arrangement(await shownNodes(page))).toEqual(beforeSave);
  const reloaded = (await shownNodes(page)).find((n) => n.text.includes("OTLP (2)"));
  expect(reloaded === undefined ? undefined : [Math.round(reloaded.x), Math.round(reloaded.y)]).toEqual([
    Math.round(dropped.x),
    Math.round(dropped.y),
  ]);
  await expect(unsavedBadge(page)).toBeHidden();
});

test("Backspace on a selected node asks first: Cancel keeps it, Delete removes it, and Cmd/Ctrl+Z brings back the text and the node; Backspace never navigates", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: STARTER_CONFIGURATION_NAME,
    yamlContent: STARTER_CONFIGURATION_YAML,
  });
  await signInThroughApi(page, user);
  // A page to go back to, as WebKit did on Backspace without preventDefault.
  await open(page, "/app");
  // At the version's address: `/editor/{id}` would replace itself, a navigation the recorder would see.
  const address = await versionAddress(configuration.id);
  await open(page, address);
  await waitForCanvas(page);
  const dialog = page.getByRole("alertdialog", { name: 'Delete "Batch"?' });
  const batch = node(page, "node_1");

  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  // Nothing selected: Backspace does nothing, and the page stays.
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Backspace");

  await expect(batch).toBeVisible();
  await batch.click();
  await expect(page.getByRole("heading", { level: 3, name: "Batch", exact: true })).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toBeHidden();
  await expect(batch).toBeVisible();
  await expect(componentNodes(page)).toHaveCount(12);
  await expect(unsavedBadge(page)).toBeHidden();

  await batch.click();
  await page.keyboard.press("Backspace");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(batch).toHaveCount(0);
  await expect(componentNodes(page)).toHaveCount(11);
  // The traces pipeline's chain closes over the deleted processor: its receiver now feeds its exporter.
  await expect(page.locator(".react-flow__edge")).toHaveCount(5);
  // Batch stays declared (the other pipelines use it); only the traces pipeline loses it.
  expect(linesOf(await editorText(page))).toEqual(replaceLine(STARTER_LINES, TRACES_PROCESSORS, "      processors: []"));
  await expect(unsavedBadge(page)).toBeVisible();

  // Undo, from the page (not Monaco): the text and the canvas together.
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press(`${await pageModifier(page)}+Z`);

  await expect(batch).toBeVisible();
  await expect(componentNodes(page)).toHaveCount(12);
  await expect(page.locator(".react-flow__edge")).toHaveCount(6);
  expect(await editorText(page)).toBe(STARTER_CONFIGURATION_YAML);
  await expect(unsavedBadge(page)).toBeHidden();
  await expect(page).toHaveURL(address);
  expect(navigations).toEqual([]);
});

test("a pipeline added, recolored and deleted comes back step by step with Undo", async ({ page }) => {
  await openSeeded(page);
  await waitForCanvas(page);
  const undo = page.getByRole("button", { name: "Undo (Ctrl+Z)" });

  await page.getByRole("button", { name: "Add pipeline" }).click();
  const dialog = page.getByRole("dialog", { name: "Add New Pipeline" });
  await dialog.getByLabel("Pipeline Name").fill("traces/extra");
  await dialog.getByRole("button", { name: "Create Pipeline" }).click();

  await expect(dialog).toBeHidden();
  await expect(group(page, "traces/extra")).toHaveCount(1);
  // At the end of service.pipelines, with no lists yet.
  const added = `${STARTER_CONFIGURATION_YAML}    traces/extra:\n`;
  expect(await editorText(page)).toBe(added);
  // The new group is below the others: bring everything into view.
  await page.locator(".react-flow__controls-fitview").click();
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  const original = await page.evaluate<string>(
    `getComputedStyle(document.querySelector('.react-flow__node[data-id="${await group(page, "traces/extra").getAttribute("data-id")}"] .border-dashed')).borderTopColor`,
  );

  await selectPipeline(page, "traces/extra");
  const swatch = page.locator('button[aria-pressed="false"][title^="#"]').first();
  const colour = (await swatch.getAttribute("title")) ?? "";
  await swatch.click();

  await expect(groupBox(page, "traces/extra")).toHaveCSS("border-top-color", rgb(colour));
  expect(await editorText(page)).toBe(added);

  await selectPipeline(page, "traces/extra");
  await page.getByRole("button", { name: "Delete pipeline" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: 'Delete pipeline "traces/extra"?',
  });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(group(page, "traces/extra")).toHaveCount(0);
  expect(await editorText(page)).toBe(STARTER_CONFIGURATION_YAML);

  await undo.click();
  await expect(group(page, "traces/extra")).toHaveCount(1);
  await expect(groupBox(page, "traces/extra")).toHaveCSS("border-top-color", rgb(colour));
  expect(await editorText(page)).toBe(added);

  await undo.click();
  await expect(groupBox(page, "traces/extra")).toHaveCSS("border-top-color", original);
  expect(await editorText(page)).toBe(added);

  await undo.click();
  await expect(group(page, "traces/extra")).toHaveCount(0);
  expect(await editorText(page)).toBe(STARTER_CONFIGURATION_YAML);
  await expect(unsavedBadge(page)).toBeHidden();
});

test("editing a component in the Configuration tab's YAML box changes its line in the text and keeps its comment", async ({
  page,
}) => {
  const commented = replaceLine(STARTER_LINES, "  batch:", "  batch:\n    # Flush at least every ten seconds.").join("\n");
  await openSeeded(page, commented);
  await waitForCanvas(page);

  await node(page, "node_1").click();
  // Batch has a form: its box is in the collapsed "Advanced: Instance & YAML".
  await page.getByRole("button", { name: "Advanced: Instance & YAML" }).click();
  const box = page.getByLabel("Raw YAML");
  await expect(box).toHaveValue(/# Flush at least every ten seconds\.\n/);
  const value = await box.inputValue();
  await box.fill(value.replace("send_batch_size: 1024", "send_batch_size: 2048"));
  // Leaving the box writes at once (otherwise 300 ms after the last keystroke).
  await box.blur();

  await expect
    .poll(async () => linesOf(await editorText(page)))
    .toEqual(replaceLine(linesOf(commented), "    send_batch_size: 1024", "    send_batch_size: 2048"));
  await expect(unsavedBadge(page)).toBeVisible();
  await expect(node(page, "node_1")).toBeVisible();
});

test("Cmd/Ctrl+S inside the instance name and inside the YAML box saves what they hold, and the editor is clean after", async ({
  page,
}) => {
  const configurationId = await openSeeded(page);
  await waitForCanvas(page);
  const save = `${await pageModifier(page)}+s`;

  // The YAML box, well within its 300 ms pause. Batch has a form: the box and
  // the instance name are in its collapsed "Advanced: Instance & YAML".
  await node(page, "node_1").click();
  await page.getByRole("button", { name: "Advanced: Instance & YAML" }).click();
  const box = page.getByLabel("Raw YAML");
  await box.fill((await box.inputValue()).replace("send_batch_size: 1024", "send_batch_size: 2048"));
  await box.press(save);

  await expect(page.getByText("Saved configuration")).toBeVisible();
  await expect(unsavedBadge(page)).toBeHidden();
  expect((await storedVersion(configurationId)).yaml_content).toContain("    send_batch_size: 2048\n");

  // The instance name, typed and not yet committed.
  const name = page.getByRole("textbox", { name: "Instance Name" });
  await name.fill("tuned");
  await name.press(save);

  await expect.poll(async () => (await storedVersion(configurationId)).yaml_content).toContain("  batch/tuned:\n");
  await expect(unsavedBadge(page)).toBeHidden();
  // Leaving the field changes nothing more.
  await name.blur();
  await expect(unsavedBadge(page)).toBeHidden();
  await expect(saveButton(page)).toBeDisabled();
});

test("a sidebar link clicked right after typing an instance name opens Unsaved Changes", async ({ page }) => {
  const configurationId = await openSeeded(page);
  await waitForCanvas(page);
  // The editor's own replace to the version's address resets the router's
  // blockers when it lands, closing a dialog opened before it: wait for it
  // first (a pre-existing race in the product).
  await expect(page).toHaveURL(await versionAddress(configurationId));
  await node(page, "node_1").click();
  await page.getByRole("button", { name: "Advanced: Instance & YAML" }).click();
  await page.getByRole("textbox", { name: "Instance Name" }).fill("tuned");

  await page.getByRole("link", { name: "Configurations", exact: true }).click();

  const dialog = page.getByRole("alertdialog", { name: "Unsaved Changes" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(await versionAddress(configurationId));
  await expect(unsavedBadge(page)).toBeVisible();
  expect((await storedVersion(configurationId)).yaml_content).toBe(STARTER_CONFIGURATION_YAML);
});

test("typing in the YAML tab enters manual edit mode: Undo All restores the text, and Apply puts a typed component on the canvas", async ({
  page,
}) => {
  await openSeeded(page);
  await waitForCanvas(page);
  await openYamlTab(page);

  await typeLineAtTop(page, "# typed");

  await expect(page.getByText("Entered manual edit mode")).toBeVisible();
  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeVisible();
  await expect(tab(page, "Configuration")).toBeDisabled();
  await expect(paletteChip(page, "Receivers", "OTLP")).toHaveCount(0);
  // Polled, not read once: on a slow runner Monaco's model can trail the
  // keyboard by a frame.
  await expect.poll(async () => editorText(page)).toBe(`# typed\n${STARTER_CONFIGURATION_YAML}`);

  await page.getByRole("button", { name: "Undo All" }).click();

  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeHidden();
  await expect(tab(page, "Configuration")).toBeEnabled();
  await expect.poll(async () => editorText(page)).toBe(STARTER_CONFIGURATION_YAML);
  await expect(unsavedBadge(page)).toBeHidden();

  // A receiver declared and added to the traces pipeline, typed, reaching
  // each line by Go to Line (cursorAtEndOfLine).
  const declared = insertAfter(STARTER_LINES, "receivers:", ["  otlp/typed: {}"]);
  await cursorAtEndOfLine(page, nthIndex(STARTER_LINES, "receivers:", 1) + 1);
  await page.keyboard.press("Enter");
  await page.keyboard.type("otlp/typed: {}");
  await cursorAtEndOfLine(page, nthIndex(declared, TRACES_RECEIVERS, 1) + 1);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(", otlp/typed");
  const typed = replaceLine(declared, TRACES_RECEIVERS, "      receivers: [otlp, otlp/typed]");
  await expect.poll(async () => linesOf(await editorText(page))).toEqual(typed);
  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeVisible();
  await expect(componentNodes(page)).toHaveCount(12);
  // Apply waits for the collector validator's answer for the typed text, 2 s
  // after the typing (the fake answers valid), and the overlay's chip says
  // so.
  await expect(page.getByRole("button", { name: "Apply" })).toBeEnabled();
  await expect(page.getByText("Yaml is Valid")).toBeVisible();

  await page.getByRole("button", { name: "Apply" }).click();

  await expect(page.getByText("Changes applied")).toBeVisible();
  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeHidden();
  await expect(componentNodes(page)).toHaveCount(13);
  await expect(group(page, "Traces")).toBeVisible();
  await expect(page.locator(".react-flow__node-receiver").filter({ hasText: "typed" })).toHaveCount(1);
  // Apply reads the text; it never writes it.
  await expect.poll(async () => linesOf(await editorText(page))).toEqual(typed);
  await expect(tab(page, "Configuration")).toBeEnabled();
});

test("a canvas change reaches Monaco without entering manual edit mode, and Monaco's own undo of it does enter it", async ({
  page,
}) => {
  await openSeeded(page);
  await waitForCanvas(page);
  await openYamlTab(page);
  await focusMonaco(page);

  await page.getByRole("button", { name: "Add pipeline" }).click();
  const dialog = page.getByRole("dialog", { name: "Add New Pipeline" });
  await dialog.getByLabel("Pipeline Name").fill("logs/extra");
  await dialog.getByRole("button", { name: "Create Pipeline" }).click();

  await expect(group(page, "logs/extra")).toHaveCount(1);
  const added = await editorText(page);
  expect(added).toContain("logs/extra");
  await expect(page.locator(".monaco-editor .view-line").filter({ hasText: "logs/extra" })).toHaveCount(1);
  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeHidden();
  await expect(page.getByText("Entered manual edit mode")).toHaveCount(0);
  await expect(tab(page, "Configuration")).toBeEnabled();

  // Monaco's undo takes back the canvas change's text: that is typing.
  await focusMonaco(page);
  await page.keyboard.press((await platformKeys(page)).undo);

  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeVisible();
  await expect(page.getByText("Entered manual edit mode")).toBeVisible();
  expect(await editorText(page)).toBe(STARTER_CONFIGURATION_YAML);
  // The canvas still shows the pipeline until Apply or Undo All.
  await expect(group(page, "logs/extra")).toHaveCount(1);

  await page.getByRole("button", { name: "Undo All" }).click();

  await expect(page.getByText(MANUAL_EDIT_OVERLAY)).toBeHidden();
  expect(await editorText(page)).toBe(added);
});

test("text that doesn't read as a configuration: Apply is refused with the reason, Save still saves it, and the canvas shows why under its overlay", async ({
  page,
}) => {
  const configurationId = await openSeeded(page);
  await waitForCanvas(page);
  await openYamlTab(page);

  // A second `receivers` key: the collector refuses duplicates too.
  await typeLineAtTop(page, "receivers: {}");
  const broken = `receivers: {}\n${STARTER_CONFIGURATION_YAML}`;
  expect(await editorText(page)).toBe(broken);
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "YAML Validation Error" })).toBeVisible();

  await saveButton(page).click();

  await expect(page.getByText("Saved configuration")).toBeVisible();
  expect((await storedVersion(configurationId)).yaml_content).toBe(broken);

  await page.reload();
  await waitForHydration(page);

  await expect(page.getByText(UNREADABLE_OVERLAY)).toBeVisible();
  // The reason follows, as text.
  await expect(page.getByText(UNREADABLE_OVERLAY).locator("xpath=following-sibling::p")).toHaveText(/\S/);
  await expect(tab(page, "YAML")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Configuration")).toBeDisabled();
  await expect(paletteChip(page, "Receivers", "OTLP")).toHaveCount(0);
  await expect(unsavedBadge(page)).toBeHidden();
});

test.describe("on a first visit", () => {
  test.use({ tour: true });

  test("the editor's tour runs once, and not on the next visit", async ({ page }) => {
    const configurationId = await openSeeded(page);
    const popover = page.locator(".driver-popover");
    const title = popover.locator(".driver-popover-title");
    const steps = [
      "Component Toolbox",
      "Pipeline Canvas",
      "Select a Component",
      "Configure Components",
      "YAML View",
      "Add Pipeline",
      "Toolbar Actions",
      "Version History",
    ];

    for (const [index, step] of steps.entries()) {
      await expect(title).toHaveText(step);
      await popover
        .getByRole("button", {
          name: index === steps.length - 1 ? "Get Started" : "Next",
        })
        .click();
    }

    await expect(popover).toHaveCount(0);
    expect(await page.evaluate<string | null>(`localStorage.getItem("telflo-tour-completed")`)).toBe("true");

    await open(page, `/editor/${configurationId}`);
    await waitForCanvas(page);
    // The tour would start 300 ms after the configuration loads: give it
    // three times that to appear.
    await page.waitForTimeout(1_000);
    await expect(popover).toHaveCount(0);
  });
});
