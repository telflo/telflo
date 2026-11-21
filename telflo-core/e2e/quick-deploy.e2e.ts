import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page, type Request, type Response } from "@playwright/test";
import {
  QUICK_DEPLOY_MASKED_SECRET,
  quickDeployCommands,
  quickDeployPreview,
  type CreateQuickDeployLinkRequestInput,
  type CreateQuickDeployLinkResponse,
  type EnrollmentTokenRevealedResponse,
} from "@telflo/contracts";
import { expectBearersOnlyInNoCapture } from "./support/bearers.js";
import {
  createQuickDeployLinkThroughApi,
  createServerFleetThroughApi,
  extendQuickDeployLinkThroughApi,
  publishedConfiguration,
  quickDeployLinksThroughApi,
  revokeQuickDeployLinkThroughApi,
  revokeThroughApi,
  updateGroupThroughApi,
} from "./support/collectors.js";
import { expireQuickDeployLink, seedUser, type SeededUser } from "./support/database.js";
import { E2E_PUBLIC_API_URL } from "./support/environment.js";
import { expectRefused, fetchedWithoutSession } from "./support/quick-deploy.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";

// Quick-deploy links, in the browser, against the E2E API and its fake
// opamp-server: the install dialog's Quick Deploy (the link made, the masked
// preview, the reveal and its command, the clipboard), the public download
// fetched with no session and read back with the system `tar`, Install Links'
// View, Extend and Revoke, and the download's refusals of a revoked, an
// expired and a token-revoked link. Each test works in an organization of its
// own (a new user's), so tests and browsers run in parallel. Links the test
// isn't about making are made through the API as the page's session
// (support/collectors.ts); a link is expired in the database
// (support/database.ts), never waited for.
//
// The public route, GET {TELFLO_PUBLIC_API_URL}/api/v1/quick-deploy/{secret},
// is the E2E API's own (there is no gateway here: E2E_PUBLIC_API_URL), and
// is fetched by a request context of its own, made fresh with no cookies, as
// a host's curl would: never the page's, which holds the session
// (support/quick-deploy.ts). The E2E API runs the test limits (start-api.ts),
// so its 30 a minute per IP never binds; the tests still keep to six public
// requests in all (one, two and three).
//
// The command holds the default token's bearer and the link's secret, both
// shown only inside `ph-no-capture` (support/bearers.ts) and gone from the
// page once the dialog closes. The clipboard is read back in Chromium only
// (granted its permissions); Firefox and WebKit write a ClipboardItem
// holding a promise: there either toast is taken, and the one seen is
// recorded as an annotation (as install.e2e.ts).
//
// No assertion prints a secret or a bearer when it fails (as
// support/collectors.ts' helper): a string that holds one (a link's url, the
// command, the clipboard, the preview, a refusal's body) is checked by a
// boolean with a fixed message, or by the indexes or names of what matched,
// never by toMatch, toBe, toEqual or toContain on the string itself.

const PASSWORD = "correct horse battery staple";
const FLEET_PATH = "/api/v1/organizations/[^/]+/fleets/[^/]+";
const INSTALL_PATH = new RegExp(`^${FLEET_PATH}/groups/[^/]+/install$`);
const CREATE_LINK_PATH = new RegExp(`^${FLEET_PATH}/groups/[^/]+/quick-deploy-links$`);
const LINKS_PATH = new RegExp(`^${FLEET_PATH}/quick-deploy-links$`);
const EXTEND_PATH = new RegExp(`^${FLEET_PATH}/quick-deploy-links/[^/]+/extend$`);
const REVOKE_LINK_PATH = new RegExp(`^${FLEET_PATH}/quick-deploy-links/[^/]+/revoke$`);
const REVEAL_PATH = new RegExp(`^${FLEET_PATH}/tokens/[^/]+/reveal$`);
const TOKENS_PATH = new RegExp(`^${FLEET_PATH}/tokens$`);
/** A link as the E2E API makes it: its public base, the route, `tqd_` and 43 base64url characters. */
const LINK_URL = new RegExp(`^${E2E_PUBLIC_API_URL.replace(/[.]/g, "\\.")}/api/v1/quick-deploy/tqd_[A-Za-z0-9_-]{43}$`);
const MASKED = "••••••••••••••••";
const COPIED = "Copied install command";
const COPY_FAILED = "Link made, but copying failed: copy it from the box above.";
const SYSTEMD_WORDS =
  "Run this command on the host: it downloads the bundle, unpacks it and installs the collector as telflo-supervisor.service, started now and on every boot.";
const DOWNLOAD_NEEDS_UNTICK = 'The systemd service comes with Quick Deploy. Untick "Install as a systemd service" to download the bundle instead.';
const EXTEND_DESCRIPTION = "Set a new expiry, counted from now.";
const REVOKE_LINK_WORDS =
  'Revoking stops further downloads at once: a host that runs the command afterwards gets "revoked". Collectors already installed keep running. The link stays listed for the record and can\'t be re-enabled: make a new one instead.';
/** The public download's plain-text refusals (the API's quick-deploy/errors.ts), each ending in a line break. */
const REVOKED_TEXT = "This install link is revoked: make a new one.\n";
const EXPIRED_TEXT = "This install link has expired: extend it under Install links on the Tokens tab, or make a new one.\n";
const TOKEN_REVOKED_TEXT = "This link's token was revoked: make a new link.\n";
/**
 * A bearer's shape: a run of 100 or more base64 characters (the opamp-server's bearer is 180). A real bundle's
 * longest run is 64 (a sha256). Each reveal seals the token anew, so no bearer's text can show that a bundle
 * holds none: its shape can (as install.e2e.ts).
 */
const BEARER_SHAPED = /[A-Za-z0-9+/]{100,}/;
/** The placeholder pattern a rendered template must hold none of. */
const PLACEHOLDER = /\$\{[A-Z_][A-Z0-9_]*\}/;
/** The Linux All In One bundle's files. */
const ALL_IN_ONE_FILES = ["README.md", "otelcol-config.yaml", "start_supervisor.sh", "supervisor-config.yaml"];
/** A version reading one variable, SITE_NAME, which the install dialog offers. */
const SITE_NAME_YAML = ["receivers:", "  otlp:", "    protocols:", "      grpc:", "        endpoint: ${env:SITE_NAME}", ""].join("\n");
const DAY_MS = 86_400_000;

/** A suffix no other test uses. */
const unique = () => randomUUID().slice(0, 8);

interface FleetSetup {
  user: SeededUser;
  organizationId: string;
  fleetId: string;
  defaultGroupId: string;
  defaultTokenId: string;
}

/** A new user, signed in, with a server fleet of their organization whose Default group runs a published version of `yaml` (or the default text). */
async function signedInWithPublishedFleet(page: Page, yaml?: string): Promise<FleetSetup> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const { fleet, defaultGroup, tokens } = await createServerFleetThroughApi(page, user.organizationId);
  const version = await publishedConfiguration(page, user.organizationId, user.userId, `qd-otel-${unique()}`, yaml === undefined ? {} : { yaml });
  await updateGroupThroughApi(page, user.organizationId, fleet.id, defaultGroup.id, { assignedVersionId: version.versionId });
  return { user, organizationId: user.organizationId, fleetId: fleet.id, defaultGroupId: defaultGroup.id, defaultTokenId: tokens.default.id };
}

function isGetTo(path: RegExp): (response: Response) => boolean {
  return (response) => response.request().method() === "GET" && path.test(new URL(response.url()).pathname);
}

function isPostTo(path: RegExp): (response: Response) => boolean {
  return (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname);
}

/** A link's request as the dialog sends it for the Default group's All In One, with `changes`. */
function linkRequest(changes: Partial<CreateQuickDeployLinkRequestInput> = {}): CreateQuickDeployLinkRequestInput {
  return { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", env: [], systemd: false, ...changes };
}

/** The link's secret: its URL's last segment. */
function secretOf(created: CreateQuickDeployLinkResponse): string {
  return created.url.slice(created.url.lastIndexOf("/") + 1);
}

/** The install dialog, whatever its title says now: the group's, or the Quick Deploy screen's. */
function installDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /^(Install collectors|Quick Deploy command ready)/ }) });
}

/** The masked preview (inside ph-no-capture: it holds the root path and the display name). */
function preview(dialog: Locator): Locator {
  return dialog.locator(".ph-no-capture pre");
}

/** The command's box (`SecretCopyBox`). */
function secretBox(dialog: Locator): Locator {
  return dialog.locator(".ph-no-capture code");
}

/** Picks `option` in the Select named `name`, within `scope`. */
async function choose(page: Page, scope: Locator, name: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** The copy's toast, and in Chromium the clipboard holding `text`; elsewhere either toast, recorded. */
async function expectCopied(page: Page, browserName: string, text: string): Promise<void> {
  if (browserName === "chromium") {
    await expect(page.getByText(COPIED, { exact: true })).toBeVisible();
    // Never printed on a failure: the clipboard holds the command.
    expect((await page.evaluate<string>("navigator.clipboard.readText()")) === text, "the clipboard holds the command").toBe(true);
    return;
  }
  const toast = page.getByText(new RegExp(`^(${COPIED}|${COPY_FAILED.replace(/[.:]/g, "\\$&")})$`));
  await expect(toast).toBeVisible();
  test.info().annotations.push({ type: "clipboard", description: `${browserName}: ${await toast.textContent()}` });
}

/** None of `texts` is anywhere in the page: its markup, attributes included, and its title. A failure names their indexes only. */
async function expectNowhere(page: Page, texts: string[]): Promise<void> {
  const content = await page.content();
  const title = await page.title();
  const found = texts.flatMap((text, index) => (content.includes(text) || title.includes(text) ? [index] : []));
  expect(found, "the indexes of the texts found on the page").toEqual([]);
}

/** The index of the first line of `actual` that differs from `expected` (-1: none), so a failure prints no line. */
function firstDifferentLine(actual: string, expected: string[]): number {
  const lines = actual.split("\n");
  const length = Math.max(lines.length, expected.length);
  for (let index = 0; index < length; index += 1) if (lines[index] !== expected[index]) return index;
  return -1;
}

/** The fleet's page at its Tokens tab, hydrated, the tab's first reads (the tokens and the install links) answered. */
async function openTokens(page: Page, fleetId: string): Promise<void> {
  const tokens = page.waitForResponse(isGetTo(TOKENS_PATH));
  const links = page.waitForResponse(isGetTo(LINKS_PATH));
  await page.goto(`/fleet-management/${fleetId}?tab=tokens`);
  await waitForHydration(page);
  expect((await tokens).status()).toBe(200);
  expect((await links).status()).toBe(200);
}

/** Install Links' rows, newest first. */
function linkRows(page: Page): Locator {
  return page
    .getByRole("tabpanel")
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Last downloaded" }) })
    .locator("tbody tr");
}

/** A row's cells: 0 Created by, 1 Group, 2 Install, 3 Created, 4 Expires, 5 Status, 6 Downloads, 7 Last downloaded. */
async function cellsOf(row: Locator): Promise<string[]> {
  return (await row.locator("td").allTextContents()).slice(0, 8);
}

/** A row's action buttons' visible words, in order. */
async function actionsOf(row: Locator): Promise<string[]> {
  return (await row.locator("td").nth(8).getByRole("button").allTextContents()).map((each) => each.trim());
}

/**
 * An instant as the screens show it, formatted in the page (the browser's time zone): to the minute as
 * `formatDateTime` writes the cells and the expiry words, or, `toTheSecond`, as `formatDateTimeToTheSecond` writes a
 * link's actions' names.
 */
async function formatted(page: Page, iso: string, { toTheSecond = false } = {}): Promise<string> {
  const options = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...(toTheSecond ? { second: "2-digit" } : {}) };
  return page.evaluate<string>(`new Date(${JSON.stringify(iso)}).toLocaleString("en-US", ${JSON.stringify(options)})`);
}

/**
 * A row's action by its whole accessible name: the verb and the link's creation to the second, never a
 * name, path or email. Looked for inside its row: links made through the API one after another can share a second.
 */
async function linkAction(page: Page, row: Locator, verb: "View" | "Extend" | "Revoke", link: { createdAt: string }): Promise<Locator> {
  const name = `${verb} the install link created ${await formatted(page, link.createdAt, { toTheSecond: true })}`;
  return row.getByRole("button", { name, exact: true });
}

test("Quick Deploy from the dialog: the link made, the masked preview, Reveal & copy's command and its lines, both secrets only inside ph-no-capture and on the clipboard; the public download, with no session, holds the typed value and no bearer", async ({
  page,
  browserName,
  playwright,
}, testInfo) => {
  const setup = await signedInWithPublishedFleet(page, SITE_NAME_YAML);
  await page.goto(`/fleet-management/${setup.fleetId}`);
  await waitForHydration(page);
  const facts = page.waitForResponse(isGetTo(INSTALL_PATH));
  const opener = page.locator("header", { has: page.getByRole("heading", { level: 1 }) }).getByRole("button", { name: "Install collector", exact: true });
  await opener.click();
  expect((await facts).status()).toBe(200);
  const dialog = installDialog(page);
  await expect(dialog.getByRole("heading", { name: "Install collectors: Default" })).toBeVisible();

  // The Linux All In One form: the systemd service ticked, Download disabled with its reason.
  await choose(page, dialog, "Method", /^Linux All In One \(amd64\)/);
  const systemd = dialog.getByRole("checkbox", { name: "Install as a systemd service (starts on boot)" });
  await expect(systemd).toBeChecked();
  const download = dialog.getByRole("button", { name: "Download", exact: true });
  await expect(download).toBeDisabled();
  await expect(download).toHaveAccessibleDescription(DOWNLOAD_NEEDS_UNTICK);
  await dialog.getByRole("textbox", { name: "Root path", exact: true }).fill("/opt/telflo/");
  const name = `vm-${unique()}`;
  await dialog.getByRole("textbox", { name: "Collector display name (optional)" }).fill(name);
  const canary = unique();
  const value = `prod's-${canary}`;
  await dialog.getByRole("checkbox", { name: "Include SITE_NAME", exact: true }).check();
  await dialog.getByRole("textbox", { name: "SITE_NAME", exact: true }).fill(value);

  // "Quick Deploy": the link's create only (no reveal yet), its reply no-store with the link's url.
  const reveals: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && REVEAL_PATH.test(new URL(request.url()).pathname)) reveals.push(request);
  });
  const answered = page.waitForResponse(isPostTo(CREATE_LINK_PATH));
  await dialog.getByRole("button", { name: "Quick Deploy", exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.request().postDataJSON()).toEqual({
    method: "all-in-one",
    arch: "amd64",
    rootPath: "/opt/telflo/",
    env: [{ name: "SITE_NAME", value }],
    systemd: true,
  });
  expect(new URL(response.url()).pathname).toMatch(new RegExp(`/groups/${setup.defaultGroupId}/quick-deploy-links$`));
  const created = (await response.json()) as CreateQuickDeployLinkResponse;
  // Never printed on a failure: the url holds the link's secret.
  expect(LINK_URL.test(created.url), "the link's url has the pattern").toBe(true);
  expect(created.link).toMatchObject({
    groupId: setup.defaultGroupId,
    groupName: "Default",
    defaultTokenId: setup.defaultTokenId,
    choices: { method: "all-in-one", arch: "amd64", rootPath: "/opt/telflo", executablePath: null, systemd: true, envNames: ["SITE_NAME"] },
    status: "active",
    downloadCount: 0,
    revokedAt: null,
  });
  // A new link lasts 24 hours.
  expect(Date.parse(created.link.expiresAt!) - Date.parse(created.link.createdAt)).toBe(DAY_MS);
  const secret = secretOf(created);

  // The screen: its words, the preview with both secrets masked, nothing of the secret on the page, nothing revealed.
  await expect(dialog.getByRole("heading", { name: "Quick Deploy command ready" })).toBeVisible();
  // Its description and its words by themselves, never the dialog's whole text (a broken preview could hold a secret).
  await expect(dialog).toHaveAccessibleDescription(`${SYSTEMD_WORDS} See its log with sudo journalctl -u telflo-supervisor -f.`);
  const expiryWords = `This command is shown only now. It expires ${await formatted(page, created.link.expiresAt!)}; extend or revoke it under Install links on the Tokens tab.`;
  await expect(dialog.getByText(expiryWords, { exact: true })).toBeVisible();
  const masked = quickDeployPreview({ url: created.url, rootPath: "/opt/telflo", displayName: name, systemd: true });
  // Booleans: a broken preview could hold a secret.
  await expect.poll(async () => (await preview(dialog).textContent()) === masked, { message: "the preview is the masked command" }).toBe(true);
  expect(masked.includes(`'${E2E_PUBLIC_API_URL}/api/v1/quick-deploy/${QUICK_DEPLOY_MASKED_SECRET}'`), "the preview masks the secret").toBe(true);
  expect(masked.includes(`export OPAMP_TOKEN='Bearer ${MASKED}' &&`), "the preview masks the bearer").toBe(true);
  await expectNowhere(page, [secret, canary]);
  const reveal = dialog.getByRole("button", { name: "Reveal & copy command" });
  await expect(reveal).toBeFocused();
  expect(reveals).toEqual([]);

  // "Reveal & copy command": the link's default token revealed, the command in its box and on the clipboard.
  if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const revealed = page.waitForResponse(isPostTo(REVEAL_PATH));
  await reveal.click();
  const revealReply = await revealed;
  expect(revealReply.status()).toBe(200);
  expect(revealReply.headers()["cache-control"]).toBe("no-store");
  expect(new URL(revealReply.url()).pathname).toMatch(new RegExp(`/tokens/${created.link.defaultTokenId}/reveal$`));
  const { bearer } = ((await revealReply.json()) as EnrollmentTokenRevealedResponse).token;
  const command = quickDeployCommands({ url: created.url, rootPath: "/opt/telflo", bearer, displayName: name, systemd: true });
  await expect.poll(async () => (await secretBox(dialog).textContent()) === command, { message: "the box holds the command" }).toBe(true);
  // The command's lines, as the host runs them. A failure names the first line that differs, never a line.
  const golden = [
    "(",
    `export OPAMP_TOKEN='Bearer ${bearer}' &&`,
    "sudo mkdir -p '/opt/telflo' &&",
    `printf 'url = "%s"\\n' '${created.url}' | curl -q -g -fsS --retry 3 -K - | sudo tar -xzf - -C '/opt/telflo' &&`,
    `printf "OPAMP_TOKEN='%s'\\n" "$OPAMP_TOKEN" | sudo install -m 600 /dev/stdin '/opt/telflo/opamp.env' &&`,
    "sudo install -m 644 /dev/stdin /etc/systemd/system/telflo-supervisor.service <<'UNIT' &&",
    "[Unit]",
    "Description=Telflo OpAMP Supervisor",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=/opt/telflo",
    `ExecStart=/opt/telflo/start_supervisor.sh "--OPAMP_SERVER_NAME=${name}"`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    "sudo systemctl daemon-reload && sudo systemctl enable telflo-supervisor.service && sudo systemctl restart telflo-supervisor.service )",
  ];
  expect(firstDifferentLine(command, golden), "the first line of the command that differs from the golden (-1: none)").toBe(-1);
  expect(command === golden.join("\n"), "the command is the golden").toBe(true);
  await expect(preview(dialog)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Copy command" })).toBeFocused();
  await expectCopied(page, browserName, command);
  await expectBearersOnlyInNoCapture(page, [bearer, secret]);
  expect(reveals).toHaveLength(1);

  // Done: both secrets leave the page.
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectNowhere(page, [bearer, secret]);

  // The public download, by a context with no session: the bundle, its headers, no cookie set.
  const [bundle] = await fetchedWithoutSession(playwright, [created.url]);
  expect(bundle!.status).toBe(200);
  expect(bundle!.headers).toMatchObject({
    "content-type": "application/gzip",
    "content-disposition": 'attachment; filename="telflo-collector-all-in-one-amd64.tar.gz"',
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  expect(bundle!.headers["set-cookie"]).toBeUndefined();

  // Read back with the system tar: the four files, every placeholder filled, the typed value in the start script
  // only, no bearer's shape anywhere.
  const archive = testInfo.outputPath("telflo-collector-all-in-one-amd64.tar.gz");
  writeFileSync(archive, bundle!.body);
  const extracted = testInfo.outputPath("bundle");
  mkdirSync(extracted, { recursive: true });
  execFileSync("tar", ["-xzpf", archive, "-C", extracted]);
  expect(readdirSync(extracted).sort()).toEqual(ALL_IN_ONE_FILES);
  const texts = ALL_IN_ONE_FILES.map((each) => readFileSync(join(extracted, each), "utf8"));
  expect(ALL_IN_ONE_FILES.filter((_each, index) => PLACEHOLDER.test(texts[index]!))).toEqual([]);
  expect(ALL_IN_ONE_FILES.filter((_each, index) => BEARER_SHAPED.test(texts[index]!))).toEqual([]);
  expect(BEARER_SHAPED.test(bearer)).toBe(true);
  expect(texts[2]).toContain(`export SITE_NAME='prod'\\''s-${canary}'\n`);
  expect(texts[2]).toContain("root_path='/opt/telflo'\n");
  expect(ALL_IN_ONE_FILES.filter((_each, index) => texts[index]!.includes(canary))).toEqual(["start_supervisor.sh"]);
  expect(ALL_IN_ONE_FILES.filter((_each, index) => texts[index]!.includes(secret))).toEqual([]);
  expect(texts[3]).toContain(setup.defaultGroupId);

  // Counted: the list says one download.
  const [listed] = await quickDeployLinksThroughApi(page, setup.organizationId, setup.fleetId);
  expect(listed).toMatchObject({ id: created.link.id, downloadCount: 1, status: "active" });
  expect(typeof listed!.lastDownloadedAt).toBe("string");
});

test("Install Links: the rows and their statuses; View shows the variables' names only; Extend counts from now (an expired link downloads again); Revoke ends a link's downloads and its actions", async ({
  page,
  playwright,
}) => {
  const setup = await signedInWithPublishedFleet(page, SITE_NAME_YAML);
  const canary = unique();
  // An older link, the systemd service with a typed value, extended to never; a newer one, expired.
  const kept = await createQuickDeployLinkThroughApi(
    page,
    setup.organizationId,
    setup.fleetId,
    setup.defaultGroupId,
    linkRequest({ rootPath: "/opt/telflo", env: [{ name: "SITE_NAME", value: `value-${canary}` }], systemd: true }),
  );
  expect((await extendQuickDeployLinkThroughApi(page, setup.organizationId, setup.fleetId, kept.link.id, "never")).expiresAt).toBeNull();
  const lapsed = await createQuickDeployLinkThroughApi(page, setup.organizationId, setup.fleetId, setup.defaultGroupId, linkRequest({ arch: "arm64" }));
  await expireQuickDeployLink({ organizationId: setup.organizationId, linkId: lapsed.link.id });
  const [newest] = await quickDeployLinksThroughApi(page, setup.organizationId, setup.fleetId);
  expect(newest!.id).toBe(lapsed.link.id);
  const lapsedExpiry = newest!.expiresAt!;
  expect(Date.parse(lapsedExpiry)).toBeLessThan(Date.now());
  await openTokens(page, setup.fleetId);

  // Newest first: the expired one, then the one that never expires.
  const rows = linkRows(page);
  await expect(rows).toHaveCount(2);
  const [lapsedRow, keptRow] = [rows.nth(0), rows.nth(1)];
  expect(await cellsOf(lapsedRow)).toEqual([
    setup.user.email,
    "Default",
    "All In One (arm64)",
    await formatted(page, lapsed.link.createdAt),
    await formatted(page, lapsedExpiry),
    "Expired",
    "0",
    "—",
  ]);
  expect(await actionsOf(lapsedRow)).toEqual(["View", "Extend", "Revoke"]);
  expect(await cellsOf(keptRow)).toEqual([
    setup.user.email,
    "Default",
    "All In One (amd64) · systemd",
    await formatted(page, kept.link.createdAt),
    "Never",
    "Active",
    "0",
    "—",
  ]);
  // Neither secret, nor the typed value, anywhere on the page.
  await expectNowhere(page, [secretOf(kept), secretOf(lapsed), canary]);

  // View: what the link installs, the variable by its name and "set", never its value; no request.
  const linkWrites: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/quick-deploy-links\//.test(new URL(request.url()).pathname)) linkWrites.push(request);
  });
  // By its whole name, the creation to the second.
  const view = await linkAction(page, keptRow, "View", kept.link);
  await view.click();
  const viewDialog = page.getByRole("dialog", { name: "Install link", exact: true });
  await expect(viewDialog).toContainText("What this link installs. The values typed for its variables are kept with it and not shown.");
  const details = viewDialog.locator(".ph-no-capture");
  await expect(details).toContainText("GroupDefault");
  await expect(details).toContainText("InstallAll In One (amd64) · systemd");
  await expect(details).toContainText("Root path/opt/telflo");
  await expect(details).toContainText("Systemd service: yes");
  await expect(details.getByRole("listitem")).toHaveText(["SITE_NAMEset"]);
  await expectNowhere(page, [secretOf(kept), canary]);
  await viewDialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(viewDialog).toBeHidden();
  await expect(view).toBeFocused();
  expect(linkWrites).toEqual([]);

  // Extend the expired link by a week: "1 day" chosen at the opening; the new expiry counted from now.
  await (await linkAction(page, lapsedRow, "Extend", lapsed.link)).click();
  const extendDialog = page.getByRole("dialog", { name: "Extend install link", exact: true });
  await expect(extendDialog).toContainText(EXTEND_DESCRIPTION);
  await expect(extendDialog.getByRole("radio", { name: "1 day", exact: true })).toBeChecked();
  await extendDialog.getByRole("radio", { name: "1 week", exact: true }).check();
  const extended = page.waitForResponse(isPostTo(EXTEND_PATH));
  const before = Date.now();
  await extendDialog.getByRole("button", { name: "Extend", exact: true }).click();
  const extendReply = await extended;
  const after = Date.now();
  expect(extendReply.status()).toBe(200);
  expect(new URL(extendReply.url()).pathname).toMatch(new RegExp(`/quick-deploy-links/${lapsed.link.id}/extend$`));
  expect(extendReply.request().postDataJSON()).toEqual({ by: "1w" });
  const { expiresAt } = ((await extendReply.json()) as { link: { expiresAt: string } }).link;
  expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
  expect(Date.parse(expiresAt)).toBeLessThanOrEqual(after + 7 * DAY_MS);
  await expect(page.getByText("Install link extended", { exact: true })).toBeVisible();
  await expect(extendDialog).toBeHidden();
  await expect.poll(() => cellsOf(lapsedRow)).toEqual([
    setup.user.email,
    "Default",
    "All In One (arm64)",
    await formatted(page, lapsed.link.createdAt),
    await formatted(page, expiresAt),
    "Active",
    "0",
    "—",
  ]);

  // Revoke the other: its words; Revoked, only View left; the extended one untouched.
  await (await linkAction(page, keptRow, "Revoke", kept.link)).click();
  const revokeDialog = page.getByRole("alertdialog", { name: "Revoke this install link?", exact: true });
  await expect(revokeDialog).toContainText(REVOKE_LINK_WORDS);
  const revoked = page.waitForResponse(isPostTo(REVOKE_LINK_PATH));
  await revokeDialog.getByRole("button", { name: "Revoke link", exact: true }).click();
  const revokeReply = await revoked;
  expect(revokeReply.status()).toBe(200);
  expect(new URL(revokeReply.url()).pathname).toMatch(new RegExp(`/quick-deploy-links/${kept.link.id}/revoke$`));
  await expect(page.getByText("Install link revoked", { exact: true })).toBeVisible();
  await expect(revokeDialog).toBeHidden();
  await expect.poll(() => cellsOf(keptRow).then((cells) => cells[5])).toBe("Revoked");
  expect(await actionsOf(keptRow)).toEqual(["View"]);
  expect(await actionsOf(lapsedRow)).toEqual(["View", "Extend", "Revoke"]);

  // The public download: the revoked link refused in its words, the extended one served again.
  const [revokedAnswer, extendedAnswer] = await fetchedWithoutSession(playwright, [kept.url, lapsed.url]);
  expectRefused(revokedAnswer!, 410, REVOKED_TEXT);
  expect(extendedAnswer!.status).toBe(200);
  expect(extendedAnswer!.headers["content-disposition"]).toBe('attachment; filename="telflo-collector-all-in-one-arm64.tar.gz"');
  const counts = await quickDeployLinksThroughApi(page, setup.organizationId, setup.fleetId);
  expect(counts.map((link) => [link.id, link.downloadCount, link.status])).toEqual([
    [lapsed.link.id, 1, "active"],
    [kept.link.id, 0, "revoked"],
  ]);
});

test("a revoked, an expired and a token-revoked link each answer the public download 410 with their plain text, counting nothing; Install Links marks each", async ({
  page,
  playwright,
}) => {
  const setup = await signedInWithPublishedFleet(page);
  const make = () => createQuickDeployLinkThroughApi(page, setup.organizationId, setup.fleetId, setup.defaultGroupId, linkRequest());
  const revokedLink = await make();
  await revokeQuickDeployLinkThroughApi(page, setup.organizationId, setup.fleetId, revokedLink.link.id);
  const expiredLink = await make();
  await expireQuickDeployLink({ organizationId: setup.organizationId, linkId: expiredLink.link.id });
  const tokenLink = await make();
  // The fleet's default token, which each link's command carries, revoked: the last link's only reason.
  await revokeThroughApi(page, setup.organizationId, setup.fleetId, setup.defaultTokenId);

  const answers = await fetchedWithoutSession(playwright, [revokedLink.url, expiredLink.url, tokenLink.url]);
  expectRefused(answers[0]!, 410, REVOKED_TEXT);
  expectRefused(answers[1]!, 410, EXPIRED_TEXT);
  expectRefused(answers[2]!, 410, TOKEN_REVOKED_TEXT);
  // No refusal names a secret.
  for (const answer of answers) {
    const named = [revokedLink, expiredLink, tokenLink].flatMap((each, index) => (answer.body.toString("utf8").includes(secretOf(each)) ? [index] : []));
    expect(named, "the indexes of the links whose secret the refusal names").toEqual([]);
  }
  const listed = await quickDeployLinksThroughApi(page, setup.organizationId, setup.fleetId);
  expect(listed.map((link) => [link.id, link.downloadCount, link.status])).toEqual([
    [tokenLink.link.id, 0, "active"],
    [expiredLink.link.id, 0, "expired"],
    [revokedLink.link.id, 0, "revoked"],
  ]);

  // The Tokens tab: Token revoked, and Expired, its token revoked too: no Extend on either (extending can't make
  // them work); Revoked (only View).
  await openTokens(page, setup.fleetId);
  const rows = linkRows(page);
  await expect(rows).toHaveCount(3);
  expect(await Promise.all([0, 1, 2].map((index) => cellsOf(rows.nth(index)).then((cells) => cells[5])))).toEqual([
    "Token revoked",
    "Expired",
    "Revoked",
  ]);
  expect(await Promise.all([0, 1, 2].map((index) => actionsOf(rows.nth(index))))).toEqual([
    ["View", "Revoke"],
    ["View", "Revoke"],
    ["View"],
  ]);
});
