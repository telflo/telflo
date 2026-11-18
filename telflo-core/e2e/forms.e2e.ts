import { expect, test as base, type Locator, type Page } from "@playwright/test";
import {
  STARTER_CONFIGURATION_NAME,
  STARTER_CONFIGURATION_YAML,
} from "../apps/api/src/modules/configurations/starter-configuration.js";
import { seedConfiguration, seedUser } from "./support/database.js";
import {
  centre,
  editorText,
  insertAfter,
  linesOf,
  mouseDrag,
  open,
  replaceLine,
  saveButton,
  storedVersion,
  tab,
  undoButton,
  unsavedBadge,
  waitForCanvas,
} from "./support/editor-page.js";
import { signInThroughApi, skipEditorTour, waitForHydration } from "./support/session.js";

// The component forms and Self-monitoring (D9b), in the browser: a form's
// field writes its own key's line in place, every other line and comment
// kept (decision 2); a sortable list reorders by pointer and by keyboard,
// moving an item's own lines (decision 9); the `$` picker (decision 5); the
// Self-monitoring dialog's Apply and Remove Section (decision 7); and the
// YAML box under "Advanced: Instance & YAML" (decision 6). Each test works
// in an organization of its own, so tests and browsers run in parallel.
//
// The text is read by the YAML tab's Download (as builder.e2e.ts does), and
// always polled: a form's typing is written 300 ms after the last
// keystroke or on blur, and Monaco's model can trail it (D9a Ruling 42).
// Reading it opens the YAML tab, so each step goes back to the
// Configuration tab first (`showComponent`).

const PASSWORD = "correct horse battery staple";
const STARTER_LINES = linesOf(STARTER_CONFIGURATION_YAML);

const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

test.use({ viewport: { width: 1600, height: 1100 } });

// ── The page ───────────────────────────────────────────────────────────────

/** A user with a configuration holding `yamlContent`, signed in; the editor open on it, its canvas drawn. */
async function openSeeded(page: Page, yamlContent: string): Promise<string> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: STARTER_CONFIGURATION_NAME,
    yamlContent,
  });
  await signInThroughApi(page, user);
  await open(page, `/editor/${configuration.id}`);
  await waitForCanvas(page);
  return configuration.id;
}

/**
 * The canvas node of `type` ("receiver", …) whose card reads `label`: the
 * first, where a component used in several pipelines is drawn in each.
 */
function componentNode(page: Page, type: string, label: string): Locator {
  return page.locator(`.react-flow__node-${type}`).filter({ hasText: label }).first();
}

/**
 * Selects a component and shows its form in the Configuration tab (a new
 * selection switches to the tab; clicking the node already selected
 * doesn't, so the tab is clicked too).
 */
async function showComponent(page: Page, type: string, label: string): Promise<void> {
  await componentNode(page, type, label).click();
  await tab(page, "Configuration").click();
  await expect(tab(page, "Configuration")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 3, name: label, exact: true })).toBeVisible();
}

/** Waits until the editor's text reads `lines`, line by line. */
async function expectLines(page: Page, lines: readonly string[]): Promise<void> {
  await expect.poll(async () => linesOf(await editorText(page))).toEqual(lines);
}

/** Replaces a field's text and leaves it, which writes at once. */
async function retype(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.blur();
}

/** The sortable list's live region: dnd-kit announces each step of a drag there, by the items' ids. */
function dragAnnouncements(page: Page): Locator {
  return page.locator('[id^="DndLiveRegion"]');
}

// ── The texts ──────────────────────────────────────────────────────────────

const GRPC_ENDPOINT = "        endpoint: '0.0.0.0:4317'";

/** The starter, with a comment on the receiver's gRPC endpoint. */
const COMMENTED_STARTER = replaceLine(STARTER_LINES, GRPC_ENDPOINT, `${GRPC_ENDPOINT} # gRPC listener`);

/** The resource processor's first attribute, with its comment. */
const ENVIRONMENT_ITEM = [
  "      # Where the collector runs.",
  "      - key: deployment.environment",
  "        value: production",
  "        action: upsert",
];

/** The starter with a resource processor in the traces pipeline. */
const WITH_RESOURCE = replaceLine(
  insertAfter(STARTER_LINES, "    send_batch_size: 1024", ["  resource:", "    attributes:", ...ENVIRONMENT_ITEM]),
  "      processors: [batch]",
  "      processors: [batch, resource]",
);

const GATEWAY_ENDPOINT = "    endpoint: https://gateway.example.com:4318";

/** The starter with an OTLP/HTTP exporter in the traces pipeline. */
const WITH_OTLP_HTTP = replaceLine(
  insertAfter(STARTER_LINES, "      insecure: true", [
    "  otlphttp:",
    "    # The team's own gateway.",
    GATEWAY_ENDPOINT,
    "    timeout: 15s",
  ]),
  "      exporters: [otlp]",
  "      exporters: [otlp, otlphttp]",
);

// ── The tests ──────────────────────────────────────────────────────────────

test("the OTLP receiver's gRPC endpoint, edited in its form, changes its own line in place and keeps the comment; Undo puts it back", async ({
  page,
}) => {
  await openSeeded(page, COMMENTED_STARTER.join("\n"));
  await showComponent(page, "receiver", "OTLP");
  const endpoint = page.locator("#grpc-endpoint");
  // The form shows the value as the text holds it; opening wrote nothing.
  await expect(endpoint).toHaveValue("0.0.0.0:4317");
  await expect(unsavedBadge(page)).toBeHidden();

  await retype(endpoint, "0.0.0.0:14317");

  // Its quoting and its comment kept; every other line as it was.
  await expectLines(
    page,
    replaceLine(COMMENTED_STARTER, `${GRPC_ENDPOINT} # gRPC listener`, "        endpoint: '0.0.0.0:14317' # gRPC listener"),
  );
  await expect(unsavedBadge(page)).toBeVisible();

  await undoButton(page).click();

  await expectLines(page, COMMENTED_STARTER);
  await expect(unsavedBadge(page)).toBeHidden();
  await showComponent(page, "receiver", "OTLP");
  await expect(page.locator("#grpc-endpoint")).toHaveValue("0.0.0.0:4317");
});

test("batch's timeout takes 1m30s, written in place", async ({ page }) => {
  await openSeeded(page, STARTER_CONFIGURATION_YAML);
  await showComponent(page, "processor", "Batch");
  const timeout = page.locator("#timeout");
  await expect(timeout).toHaveValue("10s");

  await retype(timeout, "1m30s");

  await expectLines(page, replaceLine(STARTER_LINES, "    timeout: '10s'", "    timeout: '1m30s'"));
  await showComponent(page, "processor", "Batch");
  await expect(page.locator("#timeout")).toHaveValue("1m30s");
  // A duration the collector reads: no error under the field.
  await expect(page.getByText(/Invalid duration/)).toHaveCount(0);
});

test("a resource attribute added in the form, then reordered by pointer and by keyboard: the item's lines move with their comment, and each move is undone", async ({
  page,
}) => {
  await openSeeded(page, WITH_RESOURCE.join("\n"));
  await showComponent(page, "processor", "Resource");

  await page.getByRole("button", { name: "Add Attribute" }).click();
  await retype(page.locator("#attr-1-key"), "service.namespace");
  await retype(page.getByRole("textbox", { name: "Value", exact: true }).nth(1), "shop");

  const namespaceItem = ['      - key: "service.namespace"', '        value: "shop"', "        action: insert"];
  const added = insertAfter(WITH_RESOURCE, "        action: upsert", namespaceItem);
  await expectLines(page, added);
  // Moved: the new item first, then the first item with its comment.
  const moved = insertAfter(
    WITH_RESOURCE.filter((line) => !ENVIRONMENT_ITEM.includes(line)),
    "    attributes:",
    [...namespaceItem, ...ENVIRONMENT_ITEM],
  );

  // By pointer: the second card's handle dragged onto the first card's.
  await showComponent(page, "processor", "Resource");
  const handles = page.getByRole("button", { name: "Drag to reorder" });
  await expect(handles).toHaveCount(2);
  await mouseDrag(page, await centre(handles.nth(1)), await centre(handles.nth(0)));

  await expect(dragAnnouncements(page)).toHaveText("Draggable item attr-1 was dropped over droppable area attr-0");
  await expectLines(page, moved);

  await undoButton(page).click();
  await expectLines(page, added);

  // By keyboard: the first card's handle, Space, ArrowDown, Space.
  await showComponent(page, "processor", "Resource");
  await expect(page.locator("#attr-0-key")).toHaveValue("deployment.environment");
  await handles.nth(0).focus();
  await page.keyboard.press("Space");
  // Picked up: dnd-kit presses its handle while it drags.
  await expect(handles.nth(0)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(dragAnnouncements(page)).toHaveText("Draggable item attr-0 was moved over droppable area attr-1.");
  await page.keyboard.press("Space");
  await expect(dragAnnouncements(page)).toHaveText("Draggable item attr-0 was dropped over droppable area attr-1");

  await expectLines(page, moved);
  await showComponent(page, "processor", "Resource");
  await expect(page.locator("#attr-0-key")).toHaveValue("service.namespace");
  await expect(page.locator("#attr-1-key")).toHaveValue("deployment.environment");

  await undoButton(page).click();
  await expectLines(page, added);
});

test("the OTLP/HTTP exporter's Grafana Cloud quick setup writes its endpoint and header in place; Undo takes both back", async ({
  page,
}) => {
  await openSeeded(page, WITH_OTLP_HTTP.join("\n"));
  await showComponent(page, "exporter", "OTLP/HTTP");

  await page.locator("#otlphttp-quick-setup").click();
  await page.getByRole("option", { name: "Grafana Cloud" }).click();

  await expectLines(
    page,
    insertAfter(
      replaceLine(WITH_OTLP_HTTP, GATEWAY_ENDPOINT, "    endpoint: https://otlp-gateway-prod-us-central-0.grafana.net/otlp"),
      "    timeout: 15s",
      ["    headers:", "      Authorization: Basic <YOUR_BASE64_CREDENTIALS>"],
    ),
  );
  await showComponent(page, "exporter", "OTLP/HTTP");
  await expect(page.locator("#otlphttp-quick-setup")).toHaveText(/Grafana Cloud/);
  await expect(page.locator("#otlphttp-endpoint")).toHaveValue("https://otlp-gateway-prod-us-central-0.grafana.net/otlp");

  await undoButton(page).click();

  await expectLines(page, WITH_OTLP_HTTP);
  await expect(unsavedBadge(page)).toBeHidden();
});

test("typing $ in a field opens the picker, and Environment variable inserts ${env:}; undone, the text is as it was", async ({
  page,
}) => {
  await openSeeded(page, WITH_OTLP_HTTP.join("\n"));
  await showComponent(page, "exporter", "OTLP/HTTP");
  const endpoint = page.locator("#otlphttp-endpoint");

  await endpoint.selectText();
  await page.keyboard.type("$");
  // No organization variables until D20: the empty list and the env row.
  await expect(page.getByText("No matching variables")).toBeVisible();
  await page.getByRole("button", { name: /Environment variable/ }).click();

  await expect(endpoint).toHaveValue("${env:}");
  await expect(endpoint).toBeFocused();
  // The cursor is inside the braces: the variable's name is typed there.
  await page.keyboard.type("OTLP_ENDPOINT");
  await expect(endpoint).toHaveValue("${env:OTLP_ENDPOINT}");
  await endpoint.blur();

  await expectLines(page, replaceLine(WITH_OTLP_HTTP, GATEWAY_ENDPOINT, "    endpoint: ${env:OTLP_ENDPOINT}"));

  // The typing may be one undo entry or several (800 ms apart): undone to the start.
  while (await undoButton(page).isEnabled()) await undoButton(page).click();
  await expectLines(page, WITH_OTLP_HTTP);
  await expect(unsavedBadge(page)).toBeHidden();
});

test("Self-monitoring: the Prometheus reader applied writes service.telemetry, and Undo takes it out; Remove Section removes it, and Undo brings it back", async ({
  page,
}) => {
  await openSeeded(page, STARTER_CONFIGURATION_YAML);
  const action = page.getByRole("button", { name: "Collector self-monitoring (service::telemetry)" });
  const dialog = page.getByRole("dialog", { name: "Collector Self-Monitoring" });
  const applied = [
    ...STARTER_LINES.slice(0, -1),
    "  telemetry:",
    "    metrics:",
    "      readers:",
    "        - pull:",
    "            exporter:",
    "              prometheus:",
    "                host: 0.0.0.0",
    "                port: 8888",
    "",
  ];
  await expect(action).toHaveAttribute("data-configured", "false");

  const applyPrometheusReader = async () => {
    await action.click();
    await expect(dialog.getByRole("button", { name: "Remove Section" })).toBeDisabled();
    await dialog.getByLabel("Expose Prometheus Endpoint (pull)").check();
    await expect(dialog.locator("#sm-prom-port")).toHaveValue("8888");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(dialog).toBeHidden();
  };

  await applyPrometheusReader();

  await expect(page.getByText("Self-monitoring updated")).toBeVisible();
  await expect(action).toHaveAttribute("data-configured", "true");
  await expectLines(page, applied);

  await undoButton(page).click();

  await expect(action).toHaveAttribute("data-configured", "false");
  await expectLines(page, STARTER_LINES);
  await expect(unsavedBadge(page)).toBeHidden();

  // Applied again, then removed from the dialog.
  await applyPrometheusReader();
  await expectLines(page, applied);
  await action.click();
  await dialog.getByRole("button", { name: "Remove Section" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Self-monitoring removed")).toBeVisible();
  await expect(action).toHaveAttribute("data-configured", "false");
  await expectLines(page, STARTER_LINES);

  await undoButton(page).click();

  await expect(action).toHaveAttribute("data-configured", "true");
  await expectLines(page, applied);
});

test("the YAML box under Advanced: Instance & YAML, edited, changes the text and the form follows; saved, the text survives a reload", async ({
  page,
}) => {
  const configurationId = await openSeeded(page, STARTER_CONFIGURATION_YAML);
  await showComponent(page, "processor", "Batch");
  await expect(page.locator("#send-batch-size")).toHaveValue("1024");

  await page.getByRole("button", { name: "Advanced: Instance & YAML" }).click();
  const box = page.getByLabel("Raw YAML");
  await expect(box).toHaveValue(/send_batch_size: 1024/);
  await box.fill((await box.inputValue()).replace("send_batch_size: 1024", "send_batch_size: 2048"));

  // The form follows the box (300 ms after the typing stops), before the box is left.
  await expect(page.locator("#send-batch-size")).toHaveValue("2048");
  await box.blur();
  const edited = replaceLine(STARTER_LINES, "    send_batch_size: 1024", "    send_batch_size: 2048");
  await expectLines(page, edited);

  await saveButton(page).click();
  await expect(page.getByText("Saved configuration")).toBeVisible();
  await expect(unsavedBadge(page)).toBeHidden();
  expect((await storedVersion(configurationId)).yaml_content).toBe(edited.join("\n"));

  await page.reload();
  await waitForHydration(page);
  await waitForCanvas(page);

  await expectLines(page, edited);
  await expect(unsavedBadge(page)).toBeHidden();
  await showComponent(page, "processor", "Batch");
  await expect(page.locator("#send-batch-size")).toHaveValue("2048");
});
