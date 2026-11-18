import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page, type Request, type Response } from "@playwright/test";
import {
  COLLECTOR_GROUP_UNASSIGNED_MESSAGE,
  type EnrollmentTokenRevealedResponse,
  type InstallFacts,
} from "@telflo/contracts";
import { expectBearersOnlyInNoCapture } from "./support/bearers.js";
import {
  archiveFleetThroughApi,
  createGroupThroughApi,
  createServerFleetThroughApi,
  issueDefaultTokenThroughApi,
  publishedConfiguration,
  revokeThroughApi,
  updateGroupThroughApi,
} from "./support/collectors.js";
import { seedUser, type SeededUser } from "./support/database.js";
import { downloaded } from "./support/downloads.js";
import { E2E_OPAMP_AGENT_PUBLIC_URL } from "./support/environment.js";
import { enrollFakeCollector, fakeSnapshots, setFakeCollectorState } from "./support/fake-opamp-server.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";

// Installing collectors into a server fleet (D17c-1 decision 52; Preflight
// rulings 17, 33 and 34), in the browser, against the E2E API and its fake
// opamp-server. Each test works in an organization of its own (a new
// user's), so tests and browsers run in parallel. Fleets, groups, published
// versions, revokes and archives are made through the API as the page's
// session (support/collectors.ts); collectors and what they were served
// through the fake's control port, before the page reads them.
//
// The E2E API names the agent endpoint E2E_OPAMP_AGENT_PUBLIC_URL (nothing
// connects to it), the default image repository, insecure connections
// refused, and the repository's own install templates. A bearer, taken from
// the reveal the page was sent, is shown only inside `ph-no-capture`
// (support/bearers.ts: one bearer box at a time) and is gone from the page
// once the dialog closes. The clipboard is read back in Chromium only
// (granted its permissions); Firefox and WebKit write a ClipboardItem
// holding a promise, which the final gates watch: there either toast is
// taken, and the one seen is recorded as an annotation.

const PASSWORD = "correct horse battery staple";
const FLEET_PATH = "/api/v1/organizations/[^/]+/fleets/[^/]+";
const INSTALL_PATH = new RegExp(`^${FLEET_PATH}/groups/[^/]+/install$`);
const BUNDLE_PATH = new RegExp(`^${FLEET_PATH}/groups/[^/]+/install-bundle$`);
const REVEAL_PATH = new RegExp(`^${FLEET_PATH}/tokens/[^/]+/reveal$`);
const GROUPS_PATH = new RegExp(`^${FLEET_PATH}/groups$`);
const MASKED = "••••••••••••••••";
const COPIED = "Copied run command";
const COPY_FAILED = "Command revealed, but copying failed: copy it from the box above.";
const NO_DEFAULT_TOKEN = "The fleet's default token is revoked. Issue a new one on the Tokens tab, then install.";
const ARCHIVED_WORDS = "This fleet is archived: unarchive it to install collectors.";
const NEEDS_VERSION = "Assign a published version first.";
/**
 * A bearer's shape: a run of 100 or more base64 characters (the opamp-server's bearer is 180). A real bundle's
 * longest run is 64 (a sha256). Each reveal seals the token anew, so no bearer's text can show that a bundle
 * holds none: its shape can.
 */
const BEARER_SHAPED = /[A-Za-z0-9+/]{100,}/;
/** The placeholder pattern a rendered template must hold none of (Preflight ruling 11). */
const PLACEHOLDER = /\$\{[A-Z_][A-Z0-9_]*\}/;
/** The Linux All In One bundle's files (decision 35). */
const ALL_IN_ONE_FILES = ["README.md", "otelcol-config.yaml", "start_supervisor.sh", "supervisor-config.yaml"];

/** A suffix no other test uses. */
const unique = () => randomUUID().slice(0, 8);

interface FleetSetup {
  user: SeededUser;
  organizationId: string;
  fleetId: string;
  defaultGroupId: string;
  defaultTokenId: string;
}

/** A new user, signed in, with a server fleet of their organization. */
async function signedInWithFleet(page: Page): Promise<FleetSetup> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const { fleet, defaultGroup, tokens } = await createServerFleetThroughApi(page, user.organizationId);
  return { user, organizationId: user.organizationId, fleetId: fleet.id, defaultGroupId: defaultGroup.id, defaultTokenId: tokens.default.id };
}

/** A fleet whose Default group runs a published version of a configuration named `name`; its ids. */
async function withPublishedDefault(
  page: Page,
  setup: FleetSetup,
  name = `nginx-otel-${unique()}`,
  yaml?: string,
): Promise<{ name: string; configurationId: string; versionId: string }> {
  const version = await publishedConfiguration(page, setup.organizationId, setup.user.userId, name, yaml === undefined ? {} : { yaml });
  await updateGroupThroughApi(page, setup.organizationId, setup.fleetId, setup.defaultGroupId, { assignedVersionId: version.versionId });
  return { name, ...version };
}

/** The fleet's page (at `tab`), hydrated. */
async function openFleet(page: Page, fleetId: string, tab?: "groups" | "tokens"): Promise<void> {
  await page.goto(`/fleet-management/${fleetId}${tab === undefined ? "" : `?tab=${tab}`}`);
  await waitForHydration(page);
}

function isGetTo(path: RegExp): (response: Response) => boolean {
  return (response) => response.request().method() === "GET" && path.test(new URL(response.url()).pathname);
}

function isPostTo(path: RegExp): (response: Response) => boolean {
  return (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname);
}

/** The fleet's header: its "Install collector" (outline) and "Setup guide". */
function header(page: Page): Locator {
  return page.locator("header", { has: page.getByRole("heading", { level: 1 }) });
}

/** The setup checklist (decision 44). */
function checklist(page: Page): Locator {
  return page.getByRole("region", { name: "Fleet setup" });
}

/** The install dialog (whatever its title says now: the group's, or the token screen's). */
function installDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /^(Install collectors|Set the token, then run)/ }) });
}

/**
 * Opens the install dialog with `opener`, the facts' read (200, no-store,
 * no bearer) answered: the facts.
 */
async function openInstall(page: Page, opener: Locator): Promise<InstallFacts> {
  const read = page.waitForResponse(isGetTo(INSTALL_PATH));
  await opener.click();
  const response = await read;
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const facts = (await response.json()) as InstallFacts;
  expect(Object.keys(facts).sort()).toEqual(["allowInsecureConnections", "collector", "endpoint", "envVarNames", "groupId", "imageTag", "mounts", "mountsReadable"]);
  // The facts the E2E API was started with (environment.ts), the image tag the version's collector's.
  expect(facts).toMatchObject({
    endpoint: E2E_OPAMP_AGENT_PUBLIC_URL,
    allowInsecureConnections: false,
    imageTag: `ghcr.io/telflo/telflo/collector:${facts.collector.version}`,
    // Every group here has mounts Telflo wrote, or none (Ruling 62).
    mountsReadable: true,
  });
  await expect(installDialog(page).getByRole("button", { name: "Reveal & copy command" })).toBeVisible();
  return facts;
}

/** The command's lines as the dialog shows them: one flag a line, continued with ` \`. */
function commandOf(lines: string[]): string {
  return lines.map((line, index) => (index === 0 ? line : `  ${line}`)).join(" \\\n");
}

/** The container command's lines (decision 40) for `facts` with the token `token`, `extra` before the token's line. */
function containerLines(facts: InstallFacts, token: string, { mounts = [], name, env = [] }: { mounts?: string[]; name?: string; env?: string[] } = {}) {
  return commandOf([
    "docker run -d --restart unless-stopped --name telflo-collector",
    "-v telflo-opamp:/app/opamp",
    ...mounts,
    `-e COLLECTOR_GROUP_ID='${facts.groupId}'`,
    `-e OPAMP_ENDPOINT='${E2E_OPAMP_AGENT_PUBLIC_URL}'`,
    "-e OPAMP_ALLOW_INSECURE_CONNECTIONS='false'",
    ...(name === undefined ? [] : [`-e OPAMP_SERVER_NAME='${name}'`]),
    `-e OPAMP_TOKEN='${token}'`,
    ...env,
    `'${facts.imageTag}'`,
  ]);
}

/** The dialog's footer "Close" (its corner ✕, after it in the document, is named Close too). */
function footerClose(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: "Close", exact: true }).first();
}

/** The masked preview's text (outside any box: it holds no bearer). */
function preview(dialog: Locator): Locator {
  return dialog.locator(".ph-no-capture pre");
}

/** The revealed text's box (`SecretCopyBox`). */
function secretBox(dialog: Locator): Locator {
  return dialog.locator(".ph-no-capture code");
}

/**
 * "Reveal & copy command": the reveal answered (200, no-store), the bearer
 * it carried; in Chromium the clipboard granted first.
 */
async function revealAndCopy(page: Page, browserName: string): Promise<string> {
  if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const revealed = page.waitForResponse(isPostTo(REVEAL_PATH));
  await installDialog(page).getByRole("button", { name: "Reveal & copy command" }).click();
  const response = await revealed;
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  return ((await response.json()) as EnrollmentTokenRevealedResponse).token.bearer;
}

/** The copy's toast, and in Chromium the clipboard holding `text`; elsewhere either toast, recorded (Preflight ruling 34). */
async function expectCopied(page: Page, browserName: string, text: string): Promise<void> {
  if (browserName === "chromium") {
    await expect(page.getByText(COPIED, { exact: true })).toBeVisible();
    expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe(text);
    return;
  }
  const toast = page.getByText(new RegExp(`^(${COPIED}|${COPY_FAILED.replace(/[.:]/g, "\\$&")})$`));
  await expect(toast).toBeVisible();
  test.info().annotations.push({ type: "clipboard", description: `${browserName}: ${await toast.textContent()}` });
}

/** The bearer is nowhere in the page any more: its text, attributes and title. */
async function expectBearerGone(page: Page, bearer: string): Promise<void> {
  expect(await page.content()).not.toContain(bearer);
  expect(await page.title()).not.toContain(bearer);
}

/**
 * Where each of `texts` is on the page: as text inside `ph-no-capture`,
 * outside it, and which elements' attributes hold it (tag, attribute, and
 * whether inside `ph-no-capture`). Evaluated as a string: the E2E code has
 * no DOM types.
 */
async function placesOf(page: Page, texts: string[]): Promise<Array<{ inside: number; outside: number; attributes: string[] }>> {
  return page.evaluate(`(() => {
    const texts = ${JSON.stringify(texts)};
    return texts.map((text) => {
      let inside = 0;
      let outside = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!node.textContent.includes(text)) continue;
        if (node.parentElement && node.parentElement.closest(".ph-no-capture")) inside += 1;
        else outside += 1;
      }
      const attributes = [];
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (attribute.value.includes(text)) attributes.push(element.tagName + " " + attribute.name + " " + (element.closest(".ph-no-capture") !== null));
        }
      }
      return { inside, outside, attributes };
    });
  })()`);
}

/** Picks `option` in the Select named `name`, within `scope`. */
async function choose(page: Page, scope: Locator, name: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

test("the container install from the header: the facts, the masked preview, the reveal and its command, the bearer only inside ph-no-capture and on the clipboard, gone after Close", async ({
  page,
  browserName,
}) => {
  const setup = await signedInWithFleet(page);
  const version = await withPublishedDefault(page, setup);
  await openFleet(page, setup.fleetId);
  const opener = header(page).getByRole("button", { name: "Install collector", exact: true });

  const facts = await openInstall(page, opener);
  expect(facts).toMatchObject({ groupId: setup.defaultGroupId, envVarNames: [], mounts: [] });
  const dialog = installDialog(page);
  await expect(dialog.getByRole("heading", { name: "Install collectors: Default" })).toBeVisible();
  await expect(dialog).toContainText(`Collectors installed here join Default and run its published version, ${version.name} @v1.`);
  await expect(dialog.getByRole("combobox", { name: "Method", exact: true })).toHaveText("Container image — pull and run");

  // The preview: the command with the token masked, inside ph-no-capture.
  await expect.poll(() => preview(dialog).textContent()).toBe(containerLines(facts, MASKED));
  // A display name joins it on its own line.
  const name = `edge-east-${unique()}`;
  await dialog.getByRole("textbox", { name: "Collector display name (optional)" }).fill(`  ${name} `);
  await expect.poll(() => preview(dialog).textContent()).toBe(containerLines(facts, MASKED, { name }));

  // Reveal & copy: the default token's bearer in the command, in its box, on the clipboard.
  const bearer = await revealAndCopy(page, browserName);
  const command = containerLines(facts, bearer, { name });
  await expect.poll(() => secretBox(dialog).textContent()).toBe(command);
  await expect(preview(dialog)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Reveal & copy command" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Copy command" })).toBeFocused();
  await expectCopied(page, browserName, command);
  await expectBearersOnlyInNoCapture(page, [bearer]);

  // Close: the bearer leaves the page; the focus goes back to the header's button; the empty tab waits.
  await footerClose(dialog).click();
  await expect(dialog).toBeHidden();
  await expectBearerGone(page, bearer);
  await expect(opener).toBeFocused();
  await expect(page.getByRole("tabpanel").getByText("Waiting for your first collector to connect")).toBeVisible();
});

test("a Linux All In One download from the empty Collectors tab: the archive's files and modes, no placeholder or bearer left; the token screen's Reveal and its lines", async ({
  page,
}, testInfo) => {
  const setup = await signedInWithFleet(page);
  await withPublishedDefault(page, setup);
  await openFleet(page, setup.fleetId);
  const facts = await openInstall(page, page.getByRole("tabpanel").getByRole("button", { name: "Install collector", exact: true }));
  const dialog = installDialog(page);

  await choose(page, dialog, "Method", /^Linux All In One \(amd64\)/);
  const rootPath = dialog.getByRole("textbox", { name: "Root path", exact: true });
  await expect(rootPath).toHaveValue("/etc/otelcol");
  // "Install as a systemd service" is ticked at each opening, and Download disabled while it is (D17c-2 decision 30):
  // the bundle's own download is unticked.
  const systemd = dialog.getByRole("checkbox", { name: "Install as a systemd service (starts on boot)" });
  await expect(systemd).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
  await systemd.click();
  await expect(systemd).not.toBeChecked();
  // A path refused under its field, nothing sent.
  const bundles: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && BUNDLE_PATH.test(new URL(request.url()).pathname)) bundles.push(request);
  });
  await rootPath.fill("opt/telflo");
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  await expect(rootPath).toHaveAttribute("aria-invalid", "true");
  expect(bundles).toEqual([]);
  await rootPath.fill("/opt/telflo/");
  const name = `vm-${unique()}`;
  await dialog.getByRole("textbox", { name: "Collector display name (optional)" }).fill(name);

  // Download: the bundle saved under the contracts' file name.
  const answered = page.waitForResponse(isPostTo(BUNDLE_PATH));
  const file = await downloaded(page, () => dialog.getByRole("button", { name: "Download", exact: true }).click());
  const response = await answered;
  expect(response.status()).toBe(200);
  expect(response.headers()).toMatchObject({
    "content-type": "application/gzip",
    "cache-control": "no-store",
    "content-disposition": 'attachment; filename="telflo-collector-all-in-one-amd64.tar.gz"',
  });
  expect(bundles.map((request) => request.postDataJSON() as unknown)).toEqual([
    { method: "all-in-one", arch: "amd64", rootPath: "/opt/telflo/", env: [] },
  ]);
  expect(file.name).toBe("telflo-collector-all-in-one-amd64.tar.gz");
  await expect(page.getByText("Download started", { exact: true })).toBeVisible();

  // The archive, extracted by the system tar keeping its modes: its four files, the script 0700, the others 0644.
  const archive = testInfo.outputPath(file.name);
  writeFileSync(archive, file.bytes);
  const extracted = testInfo.outputPath("bundle");
  mkdirSync(extracted, { recursive: true });
  execFileSync("tar", ["-xzpf", archive, "-C", extracted]);
  expect(readdirSync(extracted).sort()).toEqual(ALL_IN_ONE_FILES);
  const modes = Object.fromEntries(ALL_IN_ONE_FILES.map((each) => [each, statSync(join(extracted, each)).mode & 0o777]));
  expect(modes).toEqual({ "README.md": 0o644, "otelcol-config.yaml": 0o644, "start_supervisor.sh": 0o700, "supervisor-config.yaml": 0o644 });
  const texts = ALL_IN_ONE_FILES.map((each) => readFileSync(join(extracted, each), "utf8"));
  // Every placeholder filled (the scripts' own ${OPAMP_TOKEN:-} and the YAML's ${env:…} aren't placeholders).
  expect(texts.filter((text) => PLACEHOLDER.test(text))).toEqual([]);
  // Rendered from the fields and the facts: the root path without its trailing /, the group, the endpoint.
  expect(texts[2]).toContain("root_path='/opt/telflo'\n");
  expect(texts[3]).toContain(facts.groupId);
  expect(texts[3]).toContain(E2E_OPAMP_AGENT_PUBLIC_URL);

  // The token screen: the four lines masked, then Reveal puts the bearer in, in its box.
  await expect(dialog.getByRole("heading", { name: "Set the token, then run" })).toBeVisible();
  const lines = (token: string) =>
    [
      `export OPAMP_TOKEN='Bearer ${token}'`,
      "sudo mkdir -p '/opt/telflo'",
      "sudo tar -xzf telflo-collector-all-in-one-amd64.tar.gz -C '/opt/telflo'",
      `cd '/opt/telflo' && sudo --preserve-env=OPAMP_TOKEN ./start_supervisor.sh --OPAMP_SERVER_NAME='${name}'`,
    ].join("\n");
  await expect.poll(() => preview(dialog).textContent()).toBe(lines(MASKED));
  await expect(dialog).toContainText(
    "The supervisor keeps the token in /opt/telflo/opamp.env (only root can read it), so later runs need no export.",
  );
  const revealed = page.waitForResponse(isPostTo(REVEAL_PATH));
  await dialog.getByRole("button", { name: "Reveal", exact: true }).click();
  const reveal = await revealed;
  expect(reveal.status()).toBe(200);
  const { bearer } = ((await reveal.json()) as EnrollmentTokenRevealedResponse).token;
  await expect.poll(() => secretBox(dialog).textContent()).toBe(lines(bearer));
  await expect(dialog.getByRole("button", { name: "Copy commands" })).toBeFocused();
  await expectBearersOnlyInNoCapture(page, [bearer]);
  // The bundle holds no bearer: no file holds a run of a bearer's shape.
  expect(BEARER_SHAPED.test(bearer)).toBe(true);
  expect(ALL_IN_ONE_FILES.filter((_each, index) => BEARER_SHAPED.test(texts[index]!))).toEqual([]);

  await footerClose(dialog).click();
  await expect(dialog).toBeHidden();
  await expectBearerGone(page, bearer);
});

test("environment variables: the version's ${env:…} names offered, a ticked one with no value refused before the reveal, its value in the command's -e line, an unticked one left out", async ({
  page,
  browserName,
}) => {
  const setup = await signedInWithFleet(page);
  const yaml = [
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      grpc:",
    "        endpoint: ${env:NGINX_ENV}",
    "      http:",
    "        endpoint: ${env:SITE_NAME}",
    "processors:",
    "  attributes:",
    "    actions:",
    "      - key: literal",
    // The collector's escape: a literal, never offered (Preflight ruling 14).
    "        value: $${env:ESCAPED_NAME}",
    "        action: insert",
    "",
  ].join("\n");
  await withPublishedDefault(page, setup, undefined, yaml);
  await openFleet(page, setup.fleetId);
  const facts = await openInstall(page, header(page).getByRole("button", { name: "Install collector", exact: true }));
  expect(facts.envVarNames).toEqual(["NGINX_ENV", "SITE_NAME"]);
  const dialog = installDialog(page);
  await expect(dialog).toContainText("Configuration environment variables (optional)");
  const nginx = dialog.getByRole("checkbox", { name: "Include NGINX_ENV", exact: true });
  const site = dialog.getByRole("checkbox", { name: "Include SITE_NAME", exact: true });
  await expect(nginx).not.toBeChecked();
  await expect(site).not.toBeChecked();
  await expect(dialog.getByText("set on the host")).toHaveCount(2);
  await expect(dialog).not.toContainText("ESCAPED_NAME");

  // Ticked with no value: its message, and nothing revealed.
  const reveals: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && REVEAL_PATH.test(new URL(request.url()).pathname)) reveals.push(request);
  });
  await nginx.check();
  const value = dialog.getByRole("textbox", { name: "NGINX_ENV", exact: true });
  await expect(value).toBeVisible();
  await dialog.getByRole("button", { name: "Reveal & copy command" }).click();
  await expect(dialog.getByText("Type a value or untick it.")).toBeVisible();
  await expect(value).toHaveAttribute("aria-invalid", "true");
  expect(reveals).toEqual([]);

  // A value with a quote: single-quoted once in its own line, after the token's; SITE_NAME left out.
  const canary = unique();
  await value.fill(`prod's-${canary}`);
  await expect(dialog.getByText("Type a value or untick it.")).toHaveCount(0);
  const envLine = `-e NGINX_ENV='prod'\\''s-${canary}'`;
  await expect.poll(() => preview(dialog).textContent()).toBe(containerLines(facts, MASKED, { env: [envLine] }));
  const bearer = await revealAndCopy(page, browserName);
  const command = containerLines(facts, bearer, { env: [envLine] });
  await expect.poll(() => secretBox(dialog).textContent()).toBe(command);
  expect(command).not.toContain("SITE_NAME");
  await expectCopied(page, browserName, command);
  await expectBearersOnlyInNoCapture(page, [bearer]);
  // The value is configuration text: inside ph-no-capture, in no attribute but its input's own value.
  expect(await placesOf(page, [canary])).toEqual([{ inside: 1, outside: 0, attributes: ["INPUT value true"] }]);
  expect(reveals).toHaveLength(1);
});

test("a mount added in a group's dialog reaches the container command's -v line, from the row's Install", async ({ page, browserName }) => {
  const setup = await signedInWithFleet(page);
  const groupName = `web-hosts-${unique()}`;
  const version = await publishedConfiguration(page, setup.organizationId, setup.user.userId, `web-otel-${unique()}`);
  const group = await createGroupThroughApi(page, setup.organizationId, setup.fleetId, groupName);
  await updateGroupThroughApi(page, setup.organizationId, setup.fleetId, group.id, { assignedVersionId: version.versionId });
  const groupsRead = page.waitForResponse(isGetTo(GROUPS_PATH));
  await openFleet(page, setup.fleetId, "groups");
  expect((await groupsRead).status()).toBe(200);

  // The group's dialog: one mount, read-only (the default).
  await page.getByRole("button", { name: `Edit ${groupName}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${groupName}` });
  await edit.getByRole("button", { name: "Mounts (for the container install)", exact: true }).click();
  await edit.getByRole("button", { name: "Add mount", exact: true }).click();
  await edit.getByRole("textbox", { name: "Host path", exact: true }).fill("/var/log/nginx");
  await edit.getByRole("textbox", { name: "Container path", exact: true }).fill("/var/log/nginx");
  await expect(edit.getByRole("checkbox", { name: "Read-only", exact: true })).toBeChecked();
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Group updated")).toBeVisible();
  await expect(edit).toBeHidden();

  // The row's Install (named for its group): the dialog for that group, its mount listed and in the command.
  const rowInstall = page.getByRole("button", { name: `Install into ${groupName}`, exact: true });
  // The save's toast slides in over the row's Install (bottom right): a click then lands on the toast.
  await expect(page.getByText("Group updated")).toBeHidden();
  const facts = await openInstall(page, rowInstall);
  expect(facts).toMatchObject({ groupId: group.id, mounts: [{ hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true }] });
  const dialog = installDialog(page);
  await expect(dialog.getByRole("heading", { name: `Install collectors: ${groupName}` })).toBeVisible();
  await expect(dialog).toContainText("From the group's mounts:");
  await expect(dialog).toContainText("/var/log/nginx → /var/log/nginx (read-only)");
  await expect(dialog).toContainText("Edit the group's mounts on the Groups tab.");
  const mountLine = "-v '/var/log/nginx:/var/log/nginx:ro'";
  await expect.poll(() => preview(dialog).textContent()).toBe(containerLines(facts, MASKED, { mounts: [mountLine] }));
  const bearer = await revealAndCopy(page, browserName);
  await expect.poll(() => secretBox(dialog).textContent()).toBe(containerLines(facts, bearer, { mounts: [mountLine] }));
  await expectBearersOnlyInNoCapture(page, [bearer]);

  await footerClose(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(rowInstall).toBeFocused();
  await expectBearerGone(page, bearer);
});

test("the setup checklist: Assign from it, Install from it, the first collector connects and it goes; Setup guide reopens it", async ({
  page,
  browserName,
}) => {
  const setup = await signedInWithFleet(page);
  const configurationName = `first-otel-${unique()}`;
  await publishedConfiguration(page, setup.organizationId, setup.user.userId, configurationName);
  await openFleet(page, setup.fleetId);
  const guide = checklist(page);
  await expect(guide.getByRole("heading", { name: "Set up this fleet" })).toBeVisible();
  await expect(guide).toContainText("Disappears once your first collector connects");
  const steps = guide.getByRole("listitem");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText("Assign a published version");
  await expect(steps.nth(1)).toContainText("Install a collector");
  await expect(steps.nth(1)).toContainText("Generate a copy-paste install command and run it on a host.");
  await expect(steps.nth(2)).toContainText("First collector connects");
  await expect(guide.getByText("Done:")).toHaveCount(0);
  // No collectors: no "Setup guide" toggle.
  await expect(header(page).getByRole("button", { name: "Setup guide" })).toHaveCount(0);

  // Step 1: Assign, the Default group's dialog.
  await steps.nth(0).getByRole("button", { name: "Assign", exact: true }).click();
  const assign = page.getByRole("dialog", { name: "Assign a published version to Default" });
  await choose(page, assign, "Configuration", configurationName);
  await expect(assign.getByRole("combobox", { name: "Version", exact: true })).toHaveText(/@v1/);
  await assign.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("Group updated")).toBeVisible();
  await expect(assign).toBeHidden();
  await expect(steps.nth(0)).toContainText("Done:");
  await expect(steps.nth(0).getByRole("button")).toHaveCount(0);
  // The toast gone first: it slides in at the bottom right, where a step's button may be.
  await expect(page.getByText("Group updated")).toBeHidden();

  // Step 2: Install, the reveal; closed, the step is done and the third waits.
  await openInstall(page, steps.nth(1).getByRole("button", { name: "Install", exact: true }));
  const dialog = installDialog(page);
  await expect(dialog.getByRole("heading", { name: "Install collectors: Default" })).toBeVisible();
  const bearer = await revealAndCopy(page, browserName);
  await expectBearersOnlyInNoCapture(page, [bearer]);
  await footerClose(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(steps.nth(1)).toContainText("Done:");
  await expect(steps.nth(2)).toContainText("Listening for the first check-in…");
  await expect(steps.nth(2)).toContainText("Waiting for the collector to connect. This page checks automatically every 15 seconds.");
  // The step's Install is gone: the focus falls back to the header's.
  await expect(header(page).getByRole("button", { name: "Install collector", exact: true })).toBeFocused();
  await expectBearerGone(page, bearer);

  // The first collector connects: on the next visit the checklist is gone, and "Setup guide" reopens it.
  await enrollFakeCollector(setup.organizationId, setup.fleetId, { name: `first-${unique()}` });
  await openFleet(page, setup.fleetId);
  await expect(page.getByRole("tabpanel").getByRole("table")).toBeVisible();
  await expect(checklist(page)).toHaveCount(0);
  const toggle = header(page).getByRole("button", { name: "Setup guide", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(checklist(page).getByText("Done:")).toHaveCount(3);
  await checklist(page).getByRole("button", { name: "Hide setup guide" }).click();
  await expect(checklist(page)).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("a group's Install is disabled without a published version, its reason on focus; an unassigned Default's Assign from the install dialog reads the facts again", async ({
  page,
}) => {
  const setup = await signedInWithFleet(page);
  const configurationName = `assign-otel-${unique()}`;
  await publishedConfiguration(page, setup.organizationId, setup.user.userId, configurationName);
  const groupName = `staging-${unique()}`;
  await createGroupThroughApi(page, setup.organizationId, setup.fleetId, groupName);
  await openFleet(page, setup.fleetId, "groups");

  // Nothing assigned: the row's Install a focusable wrapper, disabled, its reason as its description and tooltip.
  const disabled = page.getByRole("button", { name: `Install into ${groupName}`, exact: true });
  await expect(disabled).toHaveAttribute("aria-disabled", "true");
  await expect(disabled).toHaveAccessibleDescription(`(${NEEDS_VERSION})`);
  await disabled.focus();
  await expect(page.getByRole("tooltip")).toHaveText(NEEDS_VERSION);
  const facts: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && INSTALL_PATH.test(new URL(request.url()).pathname)) facts.push(request);
  });
  await disabled.click({ force: true });
  await expect(installDialog(page)).toHaveCount(0);
  expect(facts).toEqual([]);
  await expect(page.getByRole("button", { name: "Install into Default", exact: true })).toHaveAttribute("aria-disabled", "true");

  // The header's Install: Default has no published version, so its words and Assign.
  const read = page.waitForResponse(isGetTo(INSTALL_PATH));
  await header(page).getByRole("button", { name: "Install collector", exact: true }).click();
  const refused = await read;
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("collector_group_unassigned");
  // The disabled row's click read no facts: a read it made would come before this one, which is the only one.
  expect(facts.map((request) => new URL(request.url()).pathname)).toEqual([new URL(refused.url()).pathname]);
  expect(new URL(refused.url()).pathname).toMatch(new RegExp(`/groups/${setup.defaultGroupId}/install$`));
  const dialog = installDialog(page);
  await expect(dialog.getByRole("alert")).toHaveText(COLLECTOR_GROUP_UNASSIGNED_MESSAGE);
  await expect(dialog.getByRole("button", { name: "Reveal & copy command" })).toHaveCount(0);

  // Assign: the group dialog over it; its save reads the facts again, and the form shows.
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  const assign = page.getByRole("dialog", { name: "Assign a published version to Default" });
  await choose(page, assign, "Configuration", configurationName);
  await expect(assign.getByRole("combobox", { name: "Version", exact: true })).toHaveText(/@v1/);
  const reread = page.waitForResponse(isGetTo(INSTALL_PATH));
  await assign.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(assign).toBeHidden();
  expect((await reread).status()).toBe(200);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog).toContainText(`Collectors installed here join Default and run its published version, ${configurationName} @v1.`);
  await expect(dialog.getByRole("button", { name: "Reveal & copy command" })).toBeVisible();
  // "Assign" is gone: the focus on the Method select.
  await expect(dialog.getByRole("combobox", { name: "Method", exact: true })).toBeFocused();

  // Closed: the Groups tab followed, Default's Install enabled now.
  await footerClose(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Install into Default", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Install into Default", exact: true })).not.toHaveAttribute("aria-disabled", "true");
});

test("with the default token revoked the dialog says so and links to the Tokens tab; after a new default token its reveal is the new one's", async ({
  page,
  browserName,
}) => {
  const setup = await signedInWithFleet(page);
  await withPublishedDefault(page, setup);
  await revokeThroughApi(page, setup.organizationId, setup.fleetId, setup.defaultTokenId);
  await openFleet(page, setup.fleetId);
  const opener = header(page).getByRole("button", { name: "Install collector", exact: true });

  const read = page.waitForResponse(isGetTo(INSTALL_PATH));
  await opener.click();
  expect((await read).status()).toBe(200);
  const dialog = installDialog(page);
  await expect(dialog.getByRole("alert")).toHaveText(NO_DEFAULT_TOKEN);
  await expect(dialog.getByRole("button", { name: "Reveal & copy command" })).toHaveCount(0);
  await dialog.getByRole("link", { name: "Tokens tab", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(`/fleet-management/${setup.fleetId}?tab=tokens`);
  await expect(page.getByRole("tab", { name: "Tokens" })).toHaveAttribute("aria-selected", "true");

  // A new default token (issued as the Tokens tab's button does: tokens.e2e.ts), and the reveal is its.
  const issued = await issueDefaultTokenThroughApi(page, setup.organizationId, setup.fleetId);
  const facts = await openInstall(page, opener);
  const revealed = page.waitForResponse(isPostTo(REVEAL_PATH));
  const bearer = await revealAndCopy(page, browserName);
  expect(new URL((await revealed).url()).pathname).toMatch(new RegExp(`/tokens/${issued.id}/reveal$`));
  await expect.poll(() => secretBox(dialog).textContent()).toBe(containerLines(facts, bearer));
  await expectBearersOnlyInNoCapture(page, [bearer]);
});

test("the Version column: the version served as \"{name} @v1\" linked to the editor, a long name cut at 16rem with its full text in the tooltip", async ({
  page,
}) => {
  const setup = await signedInWithFleet(page);
  const longName = `a-configuration-whose-name-runs-long-${"abcdefghij".repeat(10)}-${unique()}`;
  const { configurationId, versionId } = await publishedConfiguration(page, setup.organizationId, setup.user.userId, longName);
  const collector = await enrollFakeCollector(setup.organizationId, setup.fleetId, { name: `served-${unique()}` });
  const [snapshot] = await fakeSnapshots(setup.organizationId, configurationId);
  await setFakeCollectorState(setup.organizationId, collector.id, { served: { kind: "publication", id: snapshot!.publicationId } });
  await openFleet(page, setup.fleetId);

  const link = page.getByRole("tabpanel").getByRole("link", { name: `${longName} @v1`, exact: true });
  await expect(link).toHaveText(`${longName} @v1`);
  const href = `/editor/${configurationId}/${versionId}`;
  await expect(link).toHaveAttribute("href", href);
  // The name's span is cut at 16rem (256 px), its text wider; `@v1` stays whole after it.
  const span = await page.evaluate<{ width: number; scrollWidth: number; clientWidth: number; after: string }>(`(() => {
    const link = document.querySelector('a[href="${href}"]');
    const span = link.querySelector(":scope > span");
    return {
      width: span.getBoundingClientRect().width,
      scrollWidth: span.scrollWidth,
      clientWidth: span.clientWidth,
      after: link.textContent.slice(span.textContent.length),
    };
  })()`);
  expect(span.width).toBeLessThanOrEqual(256);
  expect(span.scrollWidth).toBeGreaterThan(span.clientWidth);
  expect(span.after).toBe(" @v1");
  // The tooltip: the full text, then the cell's meaning.
  await link.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText(`${longName} @v1`);
  await expect(tooltip).toContainText("Running: the last published version it was sent.");
  // The name is text only: in no attribute.
  expect((await placesOf(page, [longName]))[0]!.attributes).toEqual([]);
});

test("an archived fleet: no Install collector, checklist or Setup guide; the empty Collectors tab's archived words; no row Install; the facts refused", async ({
  page,
}) => {
  const setup = await signedInWithFleet(page);
  await withPublishedDefault(page, setup);
  await archiveFleetThroughApi(page, setup.organizationId, setup.fleetId);
  await openFleet(page, setup.fleetId);
  await expect(header(page).getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install collector" })).toHaveCount(0);
  await expect(checklist(page)).toHaveCount(0);
  await expect(page.getByRole("tabpanel").getByText(ARCHIVED_WORDS)).toBeVisible();
  await page.getByRole("tab", { name: "Groups" }).click();
  await expect(page.getByRole("button", { name: "More about Default", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Install into / })).toHaveCount(0);
  const facts = await page.request.get(`/api/v1/organizations/${setup.organizationId}/fleets/${setup.fleetId}/groups/${setup.defaultGroupId}/install`);
  expect(facts.status()).toBe(409);
  expect(((await facts.json()) as { error: { code: string } }).error.code).toBe("fleet_archived");

  // A fleet with collectors, archived: no "Setup guide" either.
  const other = await createServerFleetThroughApi(page, setup.organizationId);
  await enrollFakeCollector(setup.organizationId, other.fleet.id, { name: `archived-${unique()}` });
  await archiveFleetThroughApi(page, setup.organizationId, other.fleet.id);
  await openFleet(page, other.fleet.id);
  await expect(page.getByRole("tabpanel").getByRole("table")).toBeVisible();
  await expect(header(page).getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Setup guide" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Install collector" })).toHaveCount(0);
  await expect(checklist(page)).toHaveCount(0);
});
