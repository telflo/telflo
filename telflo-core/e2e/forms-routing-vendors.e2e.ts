import { expect, test as base, type Page } from "@playwright/test";
import { insertAfter, replaceLine, unsavedBadge } from "./support/editor-page.js";
import {
  afterHistoryRun,
  choose,
  expectAdjusted,
  expectLines,
  openSeeded,
  retype,
  rightPanel,
  showComponent,
  undoTo,
  undoToOpened,
} from "./support/forms-page.js";
import { skipEditorTour } from "./support/session.js";

// The routing and vendor forms (D9d), in the browser: a routing connector's
// target chosen writes the route's entry and the connector into the target
// pipeline's receivers in one change, with its toast, and one Undo takes
// both back (decision 8); Datadog's Only Metadata cascade, with its toast
// (decision 7); an S3 receiver's ingest mode switched to SQS and back to a
// time range, each with its toast, the time range held until a time is
// typed (decisions 3, 7). Each test works in an organization of its own, so
// tests and browsers run in parallel. See support/forms-page.ts for how the
// text is read.

const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

test.use({ viewport: { width: 1600, height: 1100 } });

// ── The texts ──────────────────────────────────────────────────────────────

const ROUTE_TARGETS = "        pipelines: [traces/primary]";
const AUDIT_RECEIVERS = "      receivers: [otlp] # the audit feed";

/** A routing connector between `traces` and two pipelines: traces/primary its route's target, traces/audit not yet. */
const ROUTING = [
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      grpc:",
  "        endpoint: 0.0.0.0:4317 # the apps",
  "exporters:",
  "  debug:",
  "    verbosity: basic",
  "connectors:",
  "  routing:",
  "    default_pipelines: [traces/primary]",
  "    table:",
  "      - context: span # the payment spans",
  '        condition: attributes["service.name"] == "payments"',
  ROUTE_TARGETS,
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [routing]",
  "    traces/primary:",
  "      receivers: [routing]",
  "      exporters: [debug]",
  "    traces/audit:",
  AUDIT_RECEIVERS,
  "      exporters: [debug]",
  "",
];

const HOST_ENABLED = "      enabled: false # off for now";
const HOSTNAME_SOURCE = "      hostname_source: config_or_system";
const DATADOG_TIMEOUT = "    timeout: 20s # a slow proxy";

/** A Datadog exporter with host metadata off, and a hostname source Only Metadata can't run with. */
const DATADOG = [
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      grpc: {}",
  "exporters:",
  "  datadog:",
  "    api:",
  "      key: ${env:DD_API_KEY} # from the vault",
  DATADOG_TIMEOUT,
  "    host_metadata:",
  HOST_ENABLED,
  HOSTNAME_SOURCE,
  "service:",
  "  pipelines:",
  "    metrics:",
  "      receivers: [otlp]",
  "      exporters: [datadog]",
  "",
];

const START_TIME = '    starttime: "2024-01-01 00:00" # the incident';
const END_TIME = '    endtime: "2024-01-02 00:00"';

/** An S3 receiver replaying a time range. */
const S3 = [
  "receivers:",
  "  awss3:",
  "    s3downloader:",
  "      region: eu-west-1",
  "      s3_bucket: telemetry-archive # the archive",
  START_TIME,
  END_TIME,
  "exporters:",
  "  debug:",
  "    verbosity: basic",
  "service:",
  "  pipelines:",
  "    logs:",
  "      receivers: [awss3]",
  "      exporters: [debug]",
  "",
];

/** S3 switched to SQS: the palette's queue seed in the downloader's region, the times removed. */
const S3_SQS = insertAfter(
  S3.filter((line) => line !== START_TIME && line !== END_TIME),
  "      s3_bucket: telemetry-archive # the archive",
  ["    sqs:", "      queue_url: ${env:AWS_SQS_QUEUE_URL}", "      region: eu-west-1"],
);

/**
 * S3_SQS back on a time range: the sqs block removed, the start time typed
 * (quoted: written plain, the collector's yaml.v3 would read it as a time,
 * D9c Ruling 69); the end time is still to type.
 */
const S3_TIMED = insertAfter(
  S3.filter((line) => line !== START_TIME && line !== END_TIME),
  "      s3_bucket: telemetry-archive # the archive",
  ['    starttime: "2024-03-01"'],
);

// ── The tests ──────────────────────────────────────────────────────────────

test("a routing target chosen writes the route's pipeline and the connector into that pipeline's receivers, in place, with its toast; one Undo takes both back", async ({
  page,
}) => {
  await openSeeded(page, ROUTING);
  await showComponent(page, "connector", "Routing");
  // Route 1 starts expanded: its one target shown, nothing written by opening.
  await expect(page.locator("#route-0-targets-0")).toHaveText("traces/primary");
  await expect(unsavedBadge(page)).toBeHidden();

  // Route 1's Add Pipeline: the default pipelines' is in Fallback & Errors, closed.
  const addPipeline = rightPanel(page).getByRole("button", { name: "Add Pipeline" });
  await expect(addPipeline).toHaveCount(1);
  await addPipeline.click();
  // The held row: nothing written until a pipeline is chosen (decision 3).
  await expect(page.locator("#route-0-targets-1")).toHaveText("Select pipeline");
  await expect(unsavedBadge(page)).toBeHidden();
  await choose(page, page.locator("#route-0-targets-1"), "traces/audit");

  await expectAdjusted(page, "Added routing to the receivers of traces/audit.");
  await expectLines(
    page,
    replaceLine(
      replaceLine(ROUTING, ROUTE_TARGETS, "        pipelines: [traces/primary, traces/audit]"),
      AUDIT_RECEIVERS,
      "      receivers: [otlp, routing] # the audit feed",
    ),
  );
  await showComponent(page, "connector", "Routing");
  await expect(page.locator("#route-0-targets-1")).toHaveText("traces/audit");

  // One change: one Undo takes the route's pipeline and the receiver back.
  await undoToOpened(page, ROUTING);
  await showComponent(page, "connector", "Routing");
  await expect(page.locator("#route-0-targets-1")).toHaveCount(0);
});

test("Datadog's Only Metadata ticked sets the hostname source and turns host metadata on in the same change, with its toast; one Undo takes it back", async ({
  page,
}) => {
  await openSeeded(page, DATADOG);
  await showComponent(page, "exporter", "Datadog", "Connection");
  const onlyMetadata = page.locator("#datadog-only-metadata");
  await expect(onlyMetadata).not.toBeChecked();
  await expect(unsavedBadge(page)).toBeHidden();

  await onlyMetadata.click();

  await expect(onlyMetadata).toBeChecked();
  const sentences = ["Hostname source set to first_resource: Only Metadata needs it.", "Turned Send Host Metadata on: Only Metadata needs it."];
  await expectAdjusted(page, sentences.join(" "));
  // Nor either sentence alone in an inline alert (D9d decision 7; final ruling F9).
  for (const sentence of sentences) await expect(rightPanel(page).getByText(sentence)).toHaveCount(0);
  await expectLines(
    page,
    // The new key goes at the block's end; the two it adjusts change in place.
    insertAfter(
      replaceLine(
        replaceLine(DATADOG, HOST_ENABLED, "      enabled: true # off for now"),
        HOSTNAME_SOURCE,
        "      hostname_source: first_resource",
      ),
      "      hostname_source: first_resource",
      ["    only_metadata: true"],
    ),
  );
  await showComponent(page, "exporter", "Datadog", "Host Metadata");
  await expect(page.locator("#datadog-hm-enabled")).toBeChecked();

  await undoToOpened(page, DATADOG);
  await showComponent(page, "exporter", "Datadog", "Connection");
  await expect(page.locator("#datadog-only-metadata")).not.toBeChecked();
  await showComponent(page, "exporter", "Datadog", "Host Metadata");
  await expect(page.locator("#datadog-hm-enabled")).not.toBeChecked();
});

/** The S3 receiver's form, its mode as shown. */
async function showS3(page: Page): Promise<void> {
  await showComponent(page, "receiver", "AWS S3");
}

test("an S3 receiver switched to SQS writes the queue and removes the times, with its toast; back to Time range, a start time typed removes sqs, with its toast; Undo takes each back", async ({
  page,
}) => {
  await openSeeded(page, S3);
  await showS3(page);
  const mode = page.locator("#awss3r-mode");
  await expect(mode).toHaveText("Time range (one-shot replay)");
  await expect(page.locator("#awss3r-starttime")).toHaveValue("2024-01-01 00:00");

  await choose(page, mode, "SQS notifications (continuous)");

  await expectAdjusted(page, "Removed starttime and endtime: they can't be used with SQS.");
  await expectLines(page, S3_SQS);
  await showS3(page);
  await expect(page.locator("#awss3r-mode")).toHaveText("SQS notifications (continuous)");
  await expect(page.locator("#awss3r-queue-url")).toHaveValue("${env:AWS_SQS_QUEUE_URL}");
  await afterHistoryRun(page);

  // Time range is held, writing nothing, until a time is typed (decision 3).
  await choose(page, page.locator("#awss3r-mode"), "Time range (one-shot replay)");
  await expect(page.locator("#awss3r-starttime")).toHaveValue("");
  await expectLines(page, S3_SQS);
  await showS3(page);
  await expect(page.locator("#awss3r-mode")).toHaveText("Time range (one-shot replay)");
  await retype(page.locator("#awss3r-starttime"), "2024-03-01");

  await expectAdjusted(page, "Removed the sqs block: it can't be used with a time range.");
  await expectLines(page, S3_TIMED);

  await undoTo(page, S3_SQS);
  await showS3(page);
  await expect(page.locator("#awss3r-mode")).toHaveText("SQS notifications (continuous)");
  await undoToOpened(page, S3);
  await showS3(page);
  await expect(page.locator("#awss3r-mode")).toHaveText("Time range (one-shot replay)");
  await expect(page.locator("#awss3r-starttime")).toHaveValue("2024-01-01 00:00");
});
