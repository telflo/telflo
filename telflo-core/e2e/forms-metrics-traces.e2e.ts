import { expect, test as base, type Page } from "@playwright/test";
import { centre, insertAfter, mouseDrag, replaceLine, unsavedBadge } from "./support/editor-page.js";
import {
  afterHistoryRun,
  choose,
  dragAnnouncements,
  dragHandles,
  expectLines,
  openSeeded,
  retype,
  showComponent,
  toastWith,
  undoTo,
  undoToOpened,
} from "./support/forms-page.js";
import { skipEditorTour } from "./support/session.js";

// The metrics, traces and OTTL forms (D9d), in the browser: tail sampling's
// Add Policy, its type switch (one change: the old block out, the new
// type's seed in), and its cards reordered by pointer and by keyboard, each
// policy's lines moving with its comment; a transform template added as a
// group of its own before the flat statements, with its toast
// (decision 10); a prometheus scrape job's field and its TLS box; and one
// field each on statsd, spanmetrics and redaction, written in place with
// the line's comment kept (decision 2). Each change is undone with the
// toolbar's Undo. Each test works in an organization of its own, so tests
// and browsers run in parallel. See support/forms-page.ts for how the text
// is read.

const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

test.use({ viewport: { width: 1600, height: 1100 } });

/** The OTLP receiver, `componentLines` under `section`, and the debug exporter: a text's first part, before its service. */
function tracesThrough(section: "processors" | "connectors", componentLines: readonly string[]): string[] {
  return [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc: {}",
    `${section}:`,
    ...componentLines,
    "exporters:",
    "  debug:",
    "    verbosity: basic",
  ];
}

// ── The texts ──────────────────────────────────────────────────────────────

/** The errors policy, with its comment. */
const ERRORS_POLICY = [
  "      - name: errors # keep every failure",
  "        type: status_code",
  "        status_code:",
  "          status_codes: [ERROR]",
];
const SLOW_POLICY = ["      - name: slow", "        type: latency", "        latency:", "          threshold_ms: 500"];

function tailSampling(policies: readonly string[]): string[] {
  return [
    ...tracesThrough("processors", ["  tail_sampling:", "    decision_wait: 10s # the slow traces", "    policies:", ...policies]),
    "service:",
    "  pipelines:",
    "    traces:",
    "      receivers: [otlp]",
    "      processors: [tail_sampling]",
    "      exporters: [debug]",
    "",
  ];
}

const TAIL_SAMPLING = tailSampling([...ERRORS_POLICY, ...SLOW_POLICY]);

/** Add Policy's item: a probabilistic policy, named the first unused policy-N. */
const ADDED_POLICY = [
  "      - name: policy-3",
  "        type: probabilistic",
  "        probabilistic:",
  "          sampling_percentage: 10",
];

const FLAT_STATEMENT = '      - set(span.attributes["env"], "prod") # tag every span';

const TRANSFORM = [
  ...tracesThrough("processors", ["  transform:", "    error_mode: ignore", "    trace_statements:", FLAT_STATEMENT]),
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      processors: [transform]",
  "      exporters: [debug]",
  "",
];

const SCRAPE_INTERVAL = "          scrape_interval: 30s # twice a minute";
const TARGETS = "            - targets: [localhost:9100]";

const PROMETHEUS = [
  "receivers:",
  "  prometheus:",
  "    config:",
  "      scrape_configs:",
  "        - job_name: node # the hosts",
  SCRAPE_INTERVAL,
  "          static_configs:",
  TARGETS,
  "exporters:",
  "  debug:",
  "    verbosity: basic",
  "service:",
  "  pipelines:",
  "    metrics:",
  "      receivers: [prometheus]",
  "      exporters: [debug]",
  "",
];

const AGGREGATION_INTERVAL = "    aggregation_interval: 60s # once a minute";

const STATSD = [
  "receivers:",
  "  statsd:",
  "    endpoint: localhost:8125",
  AGGREGATION_INTERVAL,
  "exporters:",
  "  debug:",
  "    verbosity: basic",
  "service:",
  "  pipelines:",
  "    metrics:",
  "      receivers: [statsd]",
  "      exporters: [debug]",
  "",
];

const BUCKETS = "        buckets: [2ms, 8ms, 50ms] # the fast calls";

const SPANMETRICS = [
  ...tracesThrough("connectors", ["  spanmetrics:", "    histogram:", "      explicit:", BUCKETS]),
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [spanmetrics]",
  "    metrics:",
  "      receivers: [spanmetrics]",
  "      exporters: [debug]",
  "",
];

const HASH_FUNCTION = "    hash_function: md5 # the old hash";

const REDACTION = [
  ...tracesThrough("processors", [
    "  redaction:",
    "    allow_all_keys: true",
    "    blocked_values:",
    '      - "4[0-9]{12}(?:[0-9]{3})?" # Visa',
    HASH_FUNCTION,
  ]),
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      processors: [redaction]",
  "      exporters: [debug]",
  "",
];

// ── Tail sampling ──────────────────────────────────────────────────────────

/** The policy cards' expand buttons, in order: each holds its policy's name and summary. */
function policyToggles(page: Page) {
  return page.getByRole("button", { name: /^(Expand|Collapse) policy$/ });
}

/** Tail Sampling's form, Policies open (it starts open). */
async function showTailSampling(page: Page): Promise<void> {
  await showComponent(page, "processor", "Tail Sampling", "Policies");
}

/** Tail Sampling's policies, each card collapsed to its header, so every handle shows in the window. */
async function showPoliciesCollapsed(page: Page, count: number): Promise<void> {
  await showTailSampling(page);
  await expect(dragHandles(page)).toHaveCount(count);
  const collapse = page.getByRole("button", { name: "Collapse policy" });
  while ((await collapse.count()) > 0) await collapse.first().click();
  await expect(page.getByRole("button", { name: "Expand policy" })).toHaveCount(count);
}

test("tail sampling's Add Policy appends a policy, and its type switched to OTTL Condition replaces its block with the seed in one change; Undo takes each back", async ({
  page,
}) => {
  await openSeeded(page, TAIL_SAMPLING);
  await showTailSampling(page);
  await expect(unsavedBadge(page)).toBeHidden();

  await page.getByRole("button", { name: "Add Policy" }).click();

  const added = tailSampling([...ERRORS_POLICY, ...SLOW_POLICY, ...ADDED_POLICY]);
  await expectLines(page, added);
  await showTailSampling(page);
  // The added card is expanded, its fields by its index.
  await expect(page.locator("#policy-2-name")).toHaveValue("policy-3");
  await expect(page.locator("#policy-2-type")).toHaveValue("probabilistic");
  await afterHistoryRun(page);

  await page.locator("#policy-2-type").selectOption({ label: "OTTL Condition" });

  const switched = tailSampling([
    ...ERRORS_POLICY,
    ...SLOW_POLICY,
    "      - name: policy-3",
    "        type: ottl_condition",
    "        ottl_condition:",
    "          error_mode: ignore",
    "          span:",
    '            - span.attributes["http.status_code"] >= 400',
  ]);
  await expectLines(page, switched);
  await showTailSampling(page);
  await expect(page.locator("#policy-2-type")).toHaveValue("ottl_condition");
  await expect(page.getByText("OTTL: 1 conditions", { exact: true })).toBeVisible();

  await undoTo(page, added);
  await showTailSampling(page);
  await expect(page.locator("#policy-2-type")).toHaveValue("probabilistic");
  await undoToOpened(page, TAIL_SAMPLING);
  await showTailSampling(page);
  await expect(page.locator("#policy-2-name")).toHaveCount(0);
});

test("tail sampling's added policy dragged by its handle onto the first card's moves its lines to the top; Undo takes the move, then the add, back", async ({
  page,
}) => {
  await openSeeded(page, TAIL_SAMPLING);
  await showTailSampling(page);
  await page.getByRole("button", { name: "Add Policy" }).click();
  const added = tailSampling([...ERRORS_POLICY, ...SLOW_POLICY, ...ADDED_POLICY]);
  await expectLines(page, added);
  await afterHistoryRun(page);
  await showPoliciesCollapsed(page, 3);

  await mouseDrag(page, await centre(dragHandles(page).nth(2)), await centre(dragHandles(page).nth(0)));

  await expect(dragAnnouncements(page)).toHaveText("Draggable item policy-2 was dropped over droppable area policy-0");
  await expectLines(page, tailSampling([...ADDED_POLICY, ...ERRORS_POLICY, ...SLOW_POLICY]));
  await showTailSampling(page);
  await expect(page.getByRole("button", { name: "Expand policy" }).first()).toContainText("policy-3");

  await undoTo(page, added);
  await undoToOpened(page, TAIL_SAMPLING);
  await showTailSampling(page);
  await expect(dragHandles(page)).toHaveCount(2);
});

test("tail sampling's first policy moved by keyboard (its handle, Space, ArrowDown, Space) moves its lines and comment below the next; Undo moves them back", async ({
  page,
}) => {
  await openSeeded(page, TAIL_SAMPLING);
  await showPoliciesCollapsed(page, 2);

  const first = dragHandles(page).nth(0);
  await first.focus();
  await page.keyboard.press("Space");
  // Picked up: dnd-kit presses its handle while it drags.
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(dragAnnouncements(page)).toHaveText("Draggable item policy-0 was moved over droppable area policy-1.");
  await page.keyboard.press("Space");
  await expect(dragAnnouncements(page)).toHaveText("Draggable item policy-0 was dropped over droppable area policy-1");

  await expectLines(page, tailSampling([...SLOW_POLICY, ...ERRORS_POLICY]));
  await showTailSampling(page);
  await expect(policyToggles(page).nth(0)).toContainText("slow");
  await expect(policyToggles(page).nth(1)).toContainText("errors");

  await undoToOpened(page, TAIL_SAMPLING);
  await showTailSampling(page);
  await expect(policyToggles(page).nth(0)).toContainText("errors");
});

// ── Transform ──────────────────────────────────────────────────────────────

test("a transform template's Add writes its statements as a group before the flat statement, with a toast naming where it went; Undo takes it back", async ({
  page,
}) => {
  await openSeeded(page, TRANSFORM);
  await showComponent(page, "processor", "Transform", "Examples & Reference");
  const template = page.locator("div.border.rounded-lg").filter({ has: page.getByText("Redact Sensitive Headers", { exact: true }) });

  await template.getByRole("button", { name: "Add", exact: true }).click();

  await expect(toastWith(page, "Added to Trace statements")).toHaveCount(1);
  await expect(toastWith(page, "Added to Trace statements")).toContainText("Redact Sensitive Headers");
  await expectLines(
    page,
    insertAfter(TRANSFORM, "    trace_statements:", [
      "      - statements:",
      '          - delete_key(span.attributes, "http.request.header.authorization")',
      '          - delete_key(span.attributes, "http.request.header.cookie")',
      '          - delete_key(span.attributes, "http.request.header.x-api-key")',
    ]),
  );
  // The group shows first, the flat statement after it.
  await showComponent(page, "processor", "Transform", "Trace Statements");
  const group = page.getByText("Statement Group 1", { exact: true });
  const flat = page.locator("#transform-trace-statement-1");
  await expect(group).toBeVisible();
  await expect(flat).toHaveValue('set(span.attributes["env"], "prod")');
  expect((await centre(group)).y).toBeLessThan((await centre(flat)).y);

  await undoToOpened(page, TRANSFORM);
  await showComponent(page, "processor", "Transform", "Trace Statements");
  await expect(page.getByText("Statement Group 1", { exact: true })).toHaveCount(0);
  await expect(page.locator("#transform-trace-statement-0")).toHaveValue('set(span.attributes["env"], "prod")');
});

// ── Prometheus ─────────────────────────────────────────────────────────────

test("a prometheus scrape job's interval edited in place keeps its comment, and its TLS box writes the job's tls_config seed; Undo takes each back", async ({
  page,
}) => {
  await openSeeded(page, PROMETHEUS);
  await showComponent(page, "receiver", "Prometheus");
  const interval = page.locator("#scrape-interval-0");
  await expect(interval).toHaveValue("30s");
  await expect(unsavedBadge(page)).toBeHidden();

  await retype(interval, "15s");

  const edited = replaceLine(PROMETHEUS, SCRAPE_INTERVAL, "          scrape_interval: 15s # twice a minute");
  await expectLines(page, edited);
  await afterHistoryRun(page);
  await showComponent(page, "receiver", "Prometheus", "Security");
  const tls = page.locator("#prometheus-job-0-tls-enable");
  await expect(tls).not.toBeChecked();

  await tls.click();

  await expectLines(
    page,
    insertAfter(edited, TARGETS, ["          tls_config:", "            min_version: TLS12", "            max_version: TLS13"]),
  );
  await showComponent(page, "receiver", "Prometheus", "Security");
  await expect(page.locator("#prometheus-job-0-tls-enable")).toBeChecked();

  await undoTo(page, edited);
  await showComponent(page, "receiver", "Prometheus", "Security");
  await expect(page.locator("#prometheus-job-0-tls-enable")).not.toBeChecked();
  await undoToOpened(page, PROMETHEUS);
  await showComponent(page, "receiver", "Prometheus");
  await expect(page.locator("#scrape-interval-0")).toHaveValue("30s");
});

// ── One field each ─────────────────────────────────────────────────────────

test("statsd's aggregation interval, edited in its form, changes its own line in place and keeps the comment; Undo puts it back", async ({
  page,
}) => {
  await openSeeded(page, STATSD);
  await showComponent(page, "receiver", "StatsD", "Aggregation");
  const interval = page.locator("#aggregation_interval");
  await expect(interval).toHaveValue("60s");

  await retype(interval, "30s");

  await expectLines(page, replaceLine(STATSD, AGGREGATION_INTERVAL, "    aggregation_interval: 30s # once a minute"));
  await showComponent(page, "receiver", "StatsD", "Aggregation");
  await expect(page.locator("#aggregation_interval")).toHaveValue("30s");

  await undoToOpened(page, STATSD);
  await showComponent(page, "receiver", "StatsD", "Aggregation");
  await expect(page.locator("#aggregation_interval")).toHaveValue("60s");
});

test("spanmetrics' histogram buckets, a bucket added in its form, rewrite the list's own line and keep the comment; Undo puts it back", async ({
  page,
}) => {
  await openSeeded(page, SPANMETRICS);
  await showComponent(page, "connector", "Spanmetrics");
  const buckets = page.locator("#histogram-buckets");
  await expect(buckets).toHaveValue("2ms, 8ms, 50ms");

  await retype(buckets, "2ms, 8ms, 50ms, 1s");

  await expectLines(page, replaceLine(SPANMETRICS, BUCKETS, "        buckets: [2ms, 8ms, 50ms, 1s] # the fast calls"));
  await showComponent(page, "connector", "Spanmetrics");
  await expect(page.locator("#histogram-buckets")).toHaveValue("2ms, 8ms, 50ms, 1s");

  await undoToOpened(page, SPANMETRICS);
  await showComponent(page, "connector", "Spanmetrics");
  await expect(page.locator("#histogram-buckets")).toHaveValue("2ms, 8ms, 50ms");
});

test("redaction's hash function, picked in its form, changes its own line in place and keeps the comment; Undo puts it back", async ({
  page,
}) => {
  await openSeeded(page, REDACTION);
  await showComponent(page, "processor", "Redaction", "Value Masking");
  const hash = page.locator("#hash-function");
  await expect(hash).toHaveText("MD5");

  await choose(page, hash, "SHA-3");

  await expectLines(page, replaceLine(REDACTION, HASH_FUNCTION, "    hash_function: sha3 # the old hash"));
  await showComponent(page, "processor", "Redaction", "Value Masking");
  await expect(page.locator("#hash-function")).toHaveText("SHA-3");

  await undoToOpened(page, REDACTION);
  await showComponent(page, "processor", "Redaction", "Value Masking");
  await expect(page.locator("#hash-function")).toHaveText("MD5");
});
