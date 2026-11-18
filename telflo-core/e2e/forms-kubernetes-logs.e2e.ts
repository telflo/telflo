import { expect, test as base, type Page } from "@playwright/test";
import { centre, insertAfter, mouseDrag, openYamlTab, replaceLine, tab, unsavedBadge } from "./support/editor-page.js";
import {
  dragAnnouncements,
  dragHandles,
  expectAdjusted,
  expectLines,
  openSeeded,
  retype,
  showComponent,
  undoToOpened,
} from "./support/forms-page.js";
import { skipEditorTour } from "./support/session.js";

// The Kubernetes, host and logs forms (D9c), in the browser: a Kubernetes
// form's checkbox list and a hostmetrics filter write their own lines in
// place, every other line and comment kept (decisions 2, 3 and 5); a filelog
// field; the operator pipeline's Add Operator dialog, its cards reordered by
// pointer and by keyboard (the item's lines moving with their comment) and
// removed (decision 8); Delete file after reading setting Start Position, and
// syslog's TCP → UDP switch renaming its block in place, each with its toast
// and no inline alert (decision 7; D9d decision 7). Each change is undone with the toolbar's Undo. Each test
// works in an organization of its own, so tests and browsers run in
// parallel.
//
// See support/forms-page.ts for how the text is read: each step shows the
// component again and opens the section it works in if it isn't open (the
// Configuration tab keeps its open sections, its cards' expansion and its
// scroll, Ruling 86). Each change is undone before the next: form changes to
// one component within `HISTORY_THROTTLE_MS` are one undo entry.

const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

test.use({ viewport: { width: 1600, height: 1100 } });

// ── The page ───────────────────────────────────────────────────────────────

/** File Log's operators, each card collapsed to its header, so both handles show in the window. */
async function showOperatorsCollapsed(page: Page): Promise<void> {
  await showComponent(page, "receiver", "File Log", "Operators");
  await expect(dragHandles(page)).toHaveCount(2);
  // A collapsed card's button reads "Expand operator": the first "Collapse operator" is then the next card's.
  await page.getByRole("button", { name: "Collapse operator" }).first().click();
  await page.getByRole("button", { name: "Collapse operator" }).first().click();
  await expect(page.getByRole("button", { name: "Expand operator" })).toHaveCount(2);
}

/** File Log's operators, each card expanded (they stay collapsed across a look at the YAML tab, Ruling 86). */
async function showOperatorsExpanded(page: Page): Promise<void> {
  await showComponent(page, "receiver", "File Log", "Operators");
  await expect(dragHandles(page)).toHaveCount(2);
  const expand = page.getByRole("button", { name: "Expand operator" });
  while ((await expand.count()) > 0) await expand.first().click();
  await expect(page.getByRole("button", { name: "Collapse operator" })).toHaveCount(2);
}

/** A text whose pipeline of `signal` has `receiver`, a batch processor and the debug exporter; it ends with a newline. */
function withPipeline(signal: "metrics" | "logs", receiver: string, receiverLines: readonly string[]): string[] {
  return [
    "receivers:",
    ...receiverLines,
    "processors:",
    "  batch: {}",
    "exporters:",
    "  debug:",
    "    verbosity: basic",
    "service:",
    "  pipelines:",
    `    ${signal}:`,
    `      receivers: [${receiver}]`,
    "      processors: [batch]",
    "      exporters: [debug]",
    "",
  ];
}

// ── The texts ──────────────────────────────────────────────────────────────

const READY_ITEM = "      - Ready # the node is up";

const K8S_CLUSTER = withPipeline("metrics", "k8s_cluster", [
  "  k8s_cluster:",
  "    auth_type: serviceAccount",
  "    collection_interval: 10s # the default",
  "    node_conditions_to_report:",
  READY_ITEM,
  "    allocatable_types_to_report: [cpu]",
]);

const DISK = "      disk: # the data disks";

const HOSTMETRICS = withPipeline("metrics", "hostmetrics", [
  "  hostmetrics:",
  "    collection_interval: 30s # every half minute",
  "    scrapers:",
  "      cpu: {}",
  DISK,
  "      memory:",
]);

const START_AT = "    start_at: end # only new lines";
const POLL_INTERVAL = "    poll_interval: 500ms # a busy disk";
/** The JSON parser, with the comment above it. */
const JSON_ITEM = ["      # parse the JSON body", "      - type: json_parser", "        id: parse", "        parse_from: body"];
const REMOVE_ITEM = ["      - type: remove # drop the password", "        field: attributes.password"];

const FILELOG = withPipeline("logs", "filelog", [
  "  filelog:",
  "    include:",
  "      - /var/log/app/*.log # the app",
  START_AT,
  POLL_INTERVAL,
  "    operators:",
  ...JSON_ITEM,
  ...REMOVE_ITEM,
]);

/** FILELOG with its two operators swapped: each item's lines moved whole, the comment above the parser with it. */
const FILELOG_SWAPPED = withPipeline("logs", "filelog", [
  "  filelog:",
  "    include:",
  "      - /var/log/app/*.log # the app",
  START_AT,
  POLL_INTERVAL,
  "    operators:",
  ...REMOVE_ITEM,
  ...JSON_ITEM,
]);

const LISTEN_ADDRESS = "      listen_address: 0.0.0.0:54526 # the syslog port";

const SYSLOG = withPipeline("logs", "syslog", [
  "  syslog:",
  "    tcp: # from the relays",
  LISTEN_ADDRESS,
  "      max_log_size: 1MiB",
  "      add_attributes: true",
  "    protocol: rfc5424",
  "    enable_octet_counting: true",
]);

// ── The tests ──────────────────────────────────────────────────────────────

test("k8s_cluster's node conditions: a box ticked in its form appends its item under the list, the other items and comments kept; Undo takes it back", async ({
  page,
}) => {
  await openSeeded(page, K8S_CLUSTER);
  await showComponent(page, "receiver", "K8s Cluster", "Resources");
  // The list as written: Ready ticked, the others not; opening wrote nothing.
  await expect(page.locator("#condition-0")).toBeChecked();
  await expect(page.locator("#condition-1")).not.toBeChecked();
  await expect(unsavedBadge(page)).toBeHidden();

  await page.getByLabel("MemoryPressure", { exact: true }).click();

  const ticked = insertAfter(K8S_CLUSTER, READY_ITEM, ["      - MemoryPressure"]);
  await expectLines(page, ticked);
  await expect(unsavedBadge(page)).toBeVisible();
  await showComponent(page, "receiver", "K8s Cluster", "Resources");
  await expect(page.locator("#condition-0")).toBeChecked();
  await expect(page.locator("#condition-1")).toBeChecked();

  await undoToOpened(page, K8S_CLUSTER);
  await showComponent(page, "receiver", "K8s Cluster", "Resources");
  await expect(page.locator("#condition-1")).not.toBeChecked();
});

test("a hostmetrics disk filter: Include Only and a device typed write the include block with match_type: strict beside the first item, in place; Undo takes it back", async ({
  page,
}) => {
  await openSeeded(page, HOSTMETRICS);
  await showComponent(page, "receiver", "Host Metrics", "Disk Scraper");

  await page.locator("#disk-devices-mode").click();
  await page.getByRole("option", { name: "Include Only" }).click();
  // The side's first row is held until something is typed in it: nothing written yet.
  const device = page.locator("#disk-devices-include-0");
  await expect(device).toHaveValue("");
  await expect(page.locator("#disk-devices-include-match")).toHaveText(/Strict Match/);
  await expect(unsavedBadge(page)).toBeHidden();

  await retype(device, "sda");

  const filtered = insertAfter(HOSTMETRICS, DISK, [
    "        include:",
    "          devices:",
    "            - sda",
    "          match_type: strict",
  ]);
  await expectLines(page, filtered);
  await showComponent(page, "receiver", "Host Metrics", "Disk Scraper");
  await expect(page.locator("#disk-devices-mode")).toHaveText(/Include Only/);
  await expect(page.locator("#disk-devices-include-0")).toHaveValue("sda");
  await expect(page.locator("#disk-devices-include-match")).toHaveText(/Strict Match/);

  await undoToOpened(page, HOSTMETRICS);
  await showComponent(page, "receiver", "Host Metrics", "Disk Scraper");
  await expect(page.locator("#disk-devices-mode")).toHaveText(/No Filter/);
});

test("filelog's poll interval, edited in its form, changes its own line in place and keeps the comment; Undo puts it back", async ({
  page,
}) => {
  await openSeeded(page, FILELOG);
  await showComponent(page, "receiver", "File Log");
  const pollInterval = page.locator("#poll-interval");
  await expect(pollInterval).toHaveValue("500ms");
  await expect(unsavedBadge(page)).toBeHidden();

  await retype(pollInterval, "2s");

  await expectLines(page, replaceLine(FILELOG, POLL_INTERVAL, "    poll_interval: 2s # a busy disk"));
  await showComponent(page, "receiver", "File Log");
  await expect(page.locator("#poll-interval")).toHaveValue("2s");

  await undoToOpened(page, FILELOG);
  await showComponent(page, "receiver", "File Log");
  await expect(page.locator("#poll-interval")).toHaveValue("500ms");
});

test("filelog's Add Operator dialog: Severity Parser appends its seed as one item after the others; Undo takes it back", async ({
  page,
}) => {
  await openSeeded(page, FILELOG);
  await showComponent(page, "receiver", "File Log", "Operators");
  await expect(page.getByText("2 operators", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add Operator" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Operator" });
  await dialog.getByRole("button", { name: /^Severity Parser/ }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("3 operators", { exact: true })).toBeVisible();
  await expectLines(
    page,
    insertAfter(FILELOG, REMOVE_ITEM[1]!, [
      "      - type: severity_parser",
      "        parse_from: attributes.level",
      "        preset: default",
    ]),
  );

  await undoToOpened(page, FILELOG);
  await showComponent(page, "receiver", "File Log", "Operators");
  await expect(page.getByText("2 operators", { exact: true })).toBeVisible();
});

test("filelog's operators reordered by pointer: the second card's handle dragged onto the first's moves the item's lines, the comment above the other item with it; Undo moves them back", async ({
  page,
}) => {
  await openSeeded(page, FILELOG);
  await showOperatorsCollapsed(page);

  await mouseDrag(page, await centre(dragHandles(page).nth(1)), await centre(dragHandles(page).nth(0)));

  await expect(dragAnnouncements(page)).toHaveText("Draggable item operator-1 was dropped over droppable area operator-0");
  await expectLines(page, FILELOG_SWAPPED);
  // The cards follow their items: the parser is second now.
  await showOperatorsExpanded(page);
  await expect(page.locator("#op-1-id")).toHaveValue("parse");

  await undoToOpened(page, FILELOG);
  await showOperatorsExpanded(page);
  await expect(page.locator("#op-0-id")).toHaveValue("parse");
});

test("filelog's operators reordered by keyboard: the first card's handle, Space, ArrowDown, Space moves the item's lines with the comment above them; Undo moves them back", async ({
  page,
}) => {
  await openSeeded(page, FILELOG);
  await showOperatorsCollapsed(page);

  const first = dragHandles(page).nth(0);
  await first.focus();
  await page.keyboard.press("Space");
  // Picked up: dnd-kit presses its handle while it drags.
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(dragAnnouncements(page)).toHaveText("Draggable item operator-0 was moved over droppable area operator-1.");
  await page.keyboard.press("Space");
  await expect(dragAnnouncements(page)).toHaveText("Draggable item operator-0 was dropped over droppable area operator-1");

  await expectLines(page, FILELOG_SWAPPED);
  // The cards follow their items: the parser is second now.
  await showOperatorsExpanded(page);
  await expect(page.locator("#op-0-id")).toHaveValue("");
  await expect(page.locator("#op-1-id")).toHaveValue("parse");

  await undoToOpened(page, FILELOG);
  await showOperatorsExpanded(page);
  await expect(page.locator("#op-0-id")).toHaveValue("parse");
});

test("filelog's operator removed with its trash button takes its item's lines; Undo brings them back", async ({ page }) => {
  await openSeeded(page, FILELOG);
  await showComponent(page, "receiver", "File Log", "Operators");

  await page.getByRole("button", { name: "Remove operator" }).nth(1).click();

  await expect(page.getByText("1 operator", { exact: true })).toBeVisible();
  await expectLines(page, FILELOG.filter((line) => !REMOVE_ITEM.includes(line)));

  await undoToOpened(page, FILELOG);
  await showComponent(page, "receiver", "File Log", "Operators");
  await expect(page.getByText("2 operators", { exact: true })).toBeVisible();
});

test("ticking Delete file after reading sets Start Position to Beginning in the same change, with its toast; one Undo takes both back", async ({
  page,
}) => {
  await openSeeded(page, FILELOG);
  await showComponent(page, "receiver", "File Log", "Storage & File Handling");
  const startAt = page.locator("#start-at");
  await expect(startAt).toHaveText(/End/);

  await page.locator("#delete-after-read").click();

  await expect(page.locator("#delete-after-read")).toBeChecked();
  await expect(startAt).toHaveText(/Beginning/);
  await expectAdjusted(page, "Start Position set to Beginning: deleting files needs it.");
  // D9d decision 7: the "Deletes source files" alert is the hint under the box, always shown.
  await expect(
    page.getByText("Deletes each file once it's read. Needs the filelog.allowFileDeletion feature gate (on by default).", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Deletes source files")).toHaveCount(0);

  await expectLines(
    page,
    insertAfter(replaceLine(FILELOG, START_AT, "    start_at: beginning # only new lines"), REMOVE_ITEM[1]!, [
      "    delete_after_read: true",
    ]),
  );

  await undoToOpened(page, FILELOG);
  await showComponent(page, "receiver", "File Log", "Storage & File Handling");
  await expect(page.locator("#delete-after-read")).not.toBeChecked();
  await expect(page.locator("#start-at")).toHaveText(/End/);
});

test("syslog's transport switched from TCP to UDP renames the block in place, dropping what UDP can't take, with its toast; one Undo takes it back", async ({
  page,
}) => {
  await openSeeded(page, SYSLOG);
  await showComponent(page, "receiver", "Syslog");
  const tcp = page.locator("#transport-0");
  const udp = page.locator("#transport-1");
  await expect(tcp).toBeChecked();
  await expect(page.locator("#listen_address")).toHaveValue("0.0.0.0:54526");

  await udp.check();

  await expect(udp).toBeChecked();
  await expectAdjusted(page, "Removed settings UDP can't take. Undo to restore them.");
  // The block's keys kept, its comments and order with them; max_log_size and octet counting gone.
  await expectLines(
    page,
    replaceLine(SYSLOG, "    tcp: # from the relays", "    udp: # from the relays").filter(
      (line) => line !== "      max_log_size: 1MiB" && line !== "    enable_octet_counting: true",
    ),
  );
  await showComponent(page, "receiver", "Syslog");
  await expect(page.locator("#transport-1")).toBeChecked();
  await expect(page.locator("#listen_address")).toHaveValue("0.0.0.0:54526");

  await undoToOpened(page, SYSLOG);
  await showComponent(page, "receiver", "Syslog");
  await expect(page.locator("#transport-0")).toBeChecked();
});

/** A scrolling element, as the page sees it (the e2e project has no DOM types). */
type Scrolling = { scrollTop: number; scrollHeight: number };

test("the Configuration tab keeps its open sections, a collapsed operator card and its scroll across a look at the YAML tab (Ruling 86)", async ({
  page,
}) => {
  await openSeeded(page, FILELOG);
  await showComponent(page, "receiver", "File Log", "Operators");
  await page.getByRole("button", { name: "Collapse operator" }).first().click();
  await showComponent(page, "receiver", "File Log", "Storage & File Handling");
  const scroller = page.locator("[data-own-keys] .overflow-y-auto").first();
  const bottom = await scroller.evaluate((element) => {
    const box = element as unknown as Scrolling;
    box.scrollTop = box.scrollHeight;
    return box.scrollTop;
  });
  expect(bottom).toBeGreaterThan(100);

  await openYamlTab(page);
  // Hidden, not displayed; Monaco shows in its place.
  await expect(scroller).toBeHidden();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();

  await tab(page, "Configuration").click();
  await expect(scroller).toBeVisible();
  expect(await scroller.evaluate((element) => (element as unknown as Scrolling).scrollTop)).toBe(bottom);
  await expect(page.getByRole("button", { name: /^Storage & File Handling/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /^Operators/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Expand operator" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Collapse operator" })).toHaveCount(1);
});
