import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
// The SaaS pair: open registration, the Terms, the playground and the anonymous reads.
import { test } from "./support/saas.js";
import { loadSeededFlows } from "@telflo/db/testing";
import {
  deleteTestFlows,
  E2E_FLOW_SLUG_PREFIX,
  findCollectorVersions,
  findDefaultCollectorDistribution,
  insertTestFlow,
} from "./support/database.js";
import { recordPlaygroundRequests } from "./support/playground.js";
import { waitForHydration } from "./support/session.js";

// The playground's flows with NO account: the gallery lists the flows table's
// published flows through the open flow read, a flow's page shows its YAML
// read-only from the open slug read, "Use this flow" opens the sign-up prompt,
// and a slug the read doesn't answer (unknown or hidden) is "Flow not found.".
// Every request stays within the playground's request allowlist, the open
// reads read from the browser.
//
// The seeded flows are global setup's (migrations 1700000000026's and
// 1700000000045's rows), read here from the migrations' constants and never
// written; a flow's YAML is Telflo's published catalog, fine to compare. The
// one hidden flow is this spec's own `e2e-` flow, deleted when its test ends
// (the flows table is global: other specs' flows may be listed too, so
// nothing counts cards).

const SLUG = "log-volume-cost-control";

async function seededFlows() {
  return loadSeededFlows();
}

async function openPlayground(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

/** A card in the gallery: a `div role="button"` with the flow's name. */
function flowCard(page: Page, name: string): Locator {
  return page.getByRole("button").filter({ has: page.getByRole("heading", { level: 3, name, exact: true }) });
}

function signupPrompt(page: Page): Locator {
  return page.getByRole("dialog", { name: "This is a sample workspace" });
}

test("the gallery lists every published seeded flow from the open read, with no account, and filters them in the browser", async ({
  page,
  context,
}) => {
  const recorder = recordPlaygroundRequests(context);
  const seeded = await seededFlows();
  expect(seeded.every((flow) => flow.published)).toBe(true);

  await openPlayground(page, "/playground/flows");
  await expect(page).toHaveTitle("Flows - Playground - Telflo");
  await expect(page.getByRole("heading", { level: 1, name: "Flows" })).toBeVisible();
  for (const flow of seeded) {
    await expect(flowCard(page, flow.name), flow.slug).toHaveCount(1);
  }

  // The search, in the browser: the address never changes.
  const target = seeded.find((flow) => flow.slug === SLUG)!;
  await page.getByRole("searchbox").fill(target.name);
  await expect(flowCard(page, target.name)).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(1);
  expect(new URL(page.url()).search).toBe("");

  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toContain("GET /api/v1/published-flows");
  expect(new Set(recorder.apiRequests())).toEqual(new Set(["GET /api/v1/published-flows"]));
});

test("a card opens the flow's page, which shows its YAML read-only and its pin; Use this flow opens the sign-up prompt", async ({
  page,
  context,
}) => {
  const recorder = recordPlaygroundRequests(context);
  const flow = (await seededFlows()).find((candidate) => candidate.slug === SLUG)!;

  await openPlayground(page, "/playground/flows");
  await flowCard(page, flow.name).click();
  await page.waitForURL(`**/playground/flows/${SLUG}`);
  await expect(page).toHaveTitle("Flow - Playground - Telflo");
  await expect(page.getByRole("heading", { level: 1, name: flow.name })).toBeVisible();
  await expect(page.getByText(flow.summary)).toBeVisible();
  await expect(page.getByText(`collector v${flow.collector_version}`)).toBeVisible();

  // The configuration: the flow's text byte for byte, inside ph-no-capture, nothing to edit it with.
  const code = page.locator(".ph-no-capture pre code");
  await expect(code).toHaveCount(1);
  expect((await code.textContent()) === flow.yaml_content).toBe(true);
  await expect(page.getByRole("textbox")).toHaveCount(0);

  await page.getByRole("button", { name: "Use this flow" }).click();
  await expect(signupPrompt(page)).toContainText("To start from this flow, create a free account.");
  await expect(signupPrompt(page).getByRole("link", { name: "Create free account" })).toHaveAttribute("href", "/register");
  await signupPrompt(page).getByRole("button", { name: "Keep exploring" }).click();
  await expect(signupPrompt(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/playground/flows/${SLUG}$`));

  // A full load of the page reads it again in the browser.
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: flow.name })).toBeVisible();

  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toContain("GET /api/v1/published-flows/:slug");
  expect(new Set(recorder.apiRequests())).toEqual(new Set(["GET /api/v1/published-flows", "GET /api/v1/published-flows/:slug"]));
});

test("an unknown slug and a hidden flow's both say Flow not found, and the hidden one is in no gallery", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  const distribution = await findDefaultCollectorDistribution();
  const defaultVersion = (await findCollectorVersions(distribution.id)).find((version) => version.is_default)!.version;
  const hiddenSlug = `${E2E_FLOW_SLUG_PREFIX}playground-hidden-${randomUUID()}`;
  const hiddenName = `E2E hidden playground flow ${randomUUID()}`;
  await insertTestFlow({
    slug: hiddenSlug,
    name: hiddenName,
    yaml: "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n",
    signals: ["traces"],
    collectorDistribution: distribution.id,
    collectorVersion: defaultVersion,
    published: false,
  });
  try {
    await openPlayground(page, `/playground/flows/${E2E_FLOW_SLUG_PREFIX}unknown-${randomUUID()}`);
    await expect(page.getByText("Flow not found.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to flows" })).toHaveAttribute("href", "/playground/flows");

    await openPlayground(page, `/playground/flows/${hiddenSlug}`);
    await expect(page.getByText("Flow not found.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Use this flow" })).toHaveCount(0);
    expect((await page.content()).includes(hiddenName)).toBe(false);

    await page.getByRole("link", { name: "Back to flows" }).click();
    await page.waitForURL("**/playground/flows");
    const first = (await seededFlows())[0]!;
    await expect(flowCard(page, first.name)).toHaveCount(1);
    expect((await page.content()).includes(hiddenName)).toBe(false);

    expect(recorder.outside()).toEqual([]);
  } finally {
    await deleteTestFlows([hiddenSlug]);
  }
});
