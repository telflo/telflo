import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request, type Response } from "@playwright/test";
import {
  BEARER_PATTERN,
  COLLECTOR_GROUP_CLUSTER_NAME,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  DEFAULT_HELM_CHART_REFERENCE,
  DEFAULT_HELM_CHART_VERSION,
  HELM_AGENT_RELEASE,
  HELM_CLUSTER_RELEASE,
  HelmInstallFactsSchema,
  PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE,
  helmInstallCommand,
  helmQuickDeployCommand,
  helmUninstallCommand,
  helmValuesInputOf,
  helmValuesYaml,
  type CreateQuickDeployLinkResponse,
  type EnrollmentTokenEventsPage,
  type EnrollmentTokenRevealedResponse,
  type HelmInstallFacts,
  type KubernetesAnnotations,
} from "@telflo/contracts";
import { expectBearersOnlyInNoCapture } from "./support/bearers.js";
import {
  createFleetThroughApi,
  createGroupThroughApi,
  createQuickDeployLinkThroughApi,
  createServerFleetThroughApi,
  enrollKubernetesPod,
  publishedConfiguration,
  quickDeployLinksThroughApi,
  updateGroupThroughApi,
} from "./support/collectors.js";
import { addMember, seedUser, type SeededUser } from "./support/database.js";
import { downloaded } from "./support/downloads.js";
import { E2E_PUBLIC_API_URL } from "./support/environment.js";
import { attributeHoldersOf, placesOf } from "./support/privacy.js";
import { expectRefused, fetchedWithoutSession } from "./support/quick-deploy.js";
import { signInThroughApi, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";

// A Kubernetes-supervisor fleet's Helm install (D17d-2 decision 30's browser
// part; Preflight ruling 34), in the browser, against the E2E API and its
// fake opamp-server: "Install with Helm"'s Download values.yaml (the file the
// browser saves, compared with the contracts' render) and its command;
// Quick Deploy's Helm values link, its public download with no session,
// Install Links' Helm row, View and Revoke; the organization's "Public
// install links" switch, for an admin and for a member; the Kubernetes setup
// checklist, a row's Install and the `helm uninstall` lines; the platform's
// chart's per-fleet `fullnameOverride` (D18 decision 21) and a variable named
// by a YAML word (D18 decision 33); and no name, namespace, path, variable,
// bearer or link secret in any attribute. Each
// test works in an organization of its own (a new user's), so tests and
// browsers run in parallel. Fleets, groups, published versions and the links
// a test isn't about making go through the API as the page's session
// (support/collectors.ts); collectors through the fake's control port.
//
// The expected values file is the contracts' own render (`helmValuesYaml`)
// of the facts the dialog read last and the bearer the reveal answered
// (captured from the page's responses): the E2E code has no YAML parser, and
// the dialog builds the file with that render, so equal bytes are the check.
// The public download's bearer is revealed by the API at the download (a
// fresh one: the fake mints a bearer per reveal), so its token line is
// checked by its shape only and the rest of the file compared.
//
// The public route, GET {TELFLO_PUBLIC_API_URL}/api/v1/quick-deploy/{secret},
// is fetched by a request context with no session (support/quick-deploy.ts);
// the E2E API's test limits never bind (six public requests in all).
//
// No assertion prints a bearer or a link's secret when it fails (as
// quick-deploy.e2e.ts): a string holding one (the values file, a link's url,
// a Quick Deploy command, a public reply) is checked by a boolean with a
// fixed message, or by the indexes of what matched, never by toMatch, toBe,
// toEqual or toContain on the string itself.

const PASSWORD = "correct horse battery staple";
const FLEET_PATH = "/api/v1/organizations/[^/]+/fleets/[^/]+";
const INSTALL_PATH = new RegExp(`^${FLEET_PATH}/groups/[^/]+/install$`);
const CREATE_LINK_PATH = new RegExp(`^${FLEET_PATH}/groups/[^/]+/quick-deploy-links$`);
const LINKS_PATH = new RegExp(`^${FLEET_PATH}/quick-deploy-links$`);
const REVOKE_LINK_PATH = new RegExp(`^${FLEET_PATH}/quick-deploy-links/[^/]+/revoke$`);
const REVEAL_PATH = new RegExp(`^${FLEET_PATH}/tokens/[^/]+/reveal$`);
const TOKENS_PATH = new RegExp(`^${FLEET_PATH}/tokens$`);
const SETTINGS_PATH = /^\/api\/v1\/organizations\/[^/]+\/settings$/;
const GROUPS_PATH = new RegExp(`^${FLEET_PATH}/groups$`);
const COLLECTORS_PATH = new RegExp(`^${FLEET_PATH}/collectors$`);
/** A link as the E2E API makes it: its public base, the route, `tqd_` and 43 base64url characters. */
const LINK_URL = new RegExp(`^${E2E_PUBLIC_API_URL.replace(/[.]/g, "\\.")}/api/v1/quick-deploy/tqd_[A-Za-z0-9_-]{43}$`);
/** A browser download's values file (D17d-2 Ruling 37): the release's, with 8 lowercase hex of its own. */
const AGENT_DOWNLOAD_NAME = /^telflo-node-values-[0-9a-f]{8}\.yaml$/;
/** A bearer's shape: a run of 100 or more base64 characters (the opamp-server's, and the fake's, is 180). */
const BEARER_SHAPED = /^[A-Za-z0-9+/]{100,}={0,2}$/;
/** The values file's token line (`helmValuesYaml`: a double-quoted ASCII scalar). */
const TOKEN_LINE = /^token: "([^"]*)"$/m;
/** A bearer of the right shape, standing in for the public download's (checked by shape only) in the expected file. */
const STAND_IN_BEARER = "A".repeat(180);
const DAY_MS = 86_400_000;

/* The dialogs' words (apps/web's constants, copied as the other browser tests copy theirs). */
const HELM_INSTALL_TITLE = "Install with Helm";
const HELM_INSTALL_DESCRIPTION =
  "Choose a group, then download its values.yaml and run helm upgrade --install against your cluster, or make a Quick Deploy command.";
const HELM_INSTALL_DESCRIPTION_LINKS_OFF = "Choose a group, then download its values.yaml and run helm upgrade --install against your cluster.";
const helmCommandIntro = (file: string) => `${file} is saved. Run this in a shell with access to your cluster:`;
const HELM_RENAMED_FILE_WORDS = "If your browser saved it under another name (for example with a number added), use that name after -f.";
const helmValuesWarning = (file: string) =>
  `${file} holds the fleet's default token: delete it once the release is installed, and don't commit or share it.`;
const HELM_QUICK_DEPLOY_WORDS =
  "Run this command in a shell with access to your cluster: it downloads the group's values file with the link, then installs the group's Helm release.";
const HELM_QUICK_DEPLOY_WARNING =
  "The command contains a link that downloads the fleet's default token, with the values you typed, without signing in; the values file it saves holds that token: delete it once the release is installed. Run it in a secure shell; don't paste it into shared logs or chat. If it leaks, revoke the link, and revoke the default token and issue a new one.";
const LINKS_OFF_WORDS = "Public install links are turned off for this organization.";
const NEEDS_VERSION = "Assign a published version first.";
const SWITCH_NAME = "Public install links";
const SWITCH_DESCRIPTION =
  "Quick Deploy links let anyone holding the link download an installer for a fleet without signing in; a Helm values link also carries the fleet's default token. Turn them off to allow only signed-in downloads.";
const ONLY_AN_ADMIN = "Only an admin can change this.";
const KUBERNETES_INSTALL_LINKS_HELP =
  "Helm values links made when installing groups. Revoke a link to stop further downloads; a values.yaml already downloaded keeps the fleet's default token: issue a new default token to take it back.";
const REVOKE_LINK_WORDS =
  'Revoking stops further downloads at once: a host that runs the command afterwards gets "revoked". Collectors already installed keep running. The link stays listed for the record and can\'t be re-enabled: make a new one instead.';
const REVOKE_HELM_LINK_WORDS = "A values.yaml already downloaded still holds the fleet's default token.";
const COLLECTOR_UNINSTALL_WORDS = "To stop it, uninstall its group's Helm release: this removes all of the group's pods, not just this one.";
const BULK_UNINSTALL_WORDS = "To stop them, uninstall their groups' Helm releases: this removes all of each group's pods.";
const CHECKLIST = {
  title: "Set up this fleet",
  assign: "Assign published versions to your groups",
  assignDetail: "Give the Agent, the Cluster or a gateway pool a published version on the Groups tab.",
  install: "Install a group with Helm",
  installDetail: "Download a group's values.yaml and run its helm upgrade --install against your cluster.",
  connect: "First collector connects",
  connectDetail: "Once the Helm release is installed, each pod's supervisor authenticates with the fleet token and appears in the Collectors tab.",
  waiting: "Waiting for the first pod to check in. This page checks automatically every 15 seconds.",
};
/** The public download's plain-text refusals (the API's quick-deploy/errors.ts), each ending in a line break. */
const REVOKED_TEXT = "This install link is revoked: make a new one.\n";
const LINKS_OFF_TEXT = `${PUBLIC_INSTALL_LINKS_DOWNLOAD_REFUSED_MESSAGE}\n`;
/** The collector image's repository the E2E API offers: the platform's default (apps/api's DEFAULT_COLLECTOR_IMAGE_REPOSITORY). */
const COLLECTOR_IMAGE_REPOSITORY = "ghcr.io/telflo/telflo/collector";
/** The only attribute a dialog's field may hold its text in: its input's value, inside ph-no-capture (D17d-1 Preflight ruling 37). */
const INPUT_VALUE = "INPUT value true";
const CSRF = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

/** A suffix no other test uses: lowercase hex, so a gateway's name and a namespace stay DNS labels. */
const unique = () => randomUUID().slice(0, 8);

/** A version reading one variable, `name` (the install offers it, D17c-1 decision 43). */
function readingVariable(name: string): string {
  return ["receivers:", "  otlp:", "    protocols:", "      grpc:", `        endpoint: \${env:${name}}`, ""].join("\n");
}

/** A Kubernetes group's settings in its annotations, as the page writes them (D17d-1 Preflight ruling 13). */
function kubernetesAnnotations(settings: KubernetesAnnotations): Record<string, unknown> {
  return { telflo: { kubernetes: settings } };
}

interface FleetSetup {
  user: SeededUser;
  organizationId: string;
  fleetId: string;
  defaultGroupId: string;
  defaultTokenId: string;
}

/** A new user, signed in, with a Kubernetes-supervisor fleet of their organization. */
async function signedInWithKubernetesFleet(page: Page): Promise<FleetSetup> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const { fleet, defaultGroup, tokens } = await createFleetThroughApi(page, user.organizationId, "kubernetes-supervisor");
  return { user, organizationId: user.organizationId, fleetId: fleet.id, defaultGroupId: defaultGroup.id, defaultTokenId: tokens.default.id };
}

/** A configuration reading `variable`, version 1 published: its version's id. */
async function versionReading(page: Page, setup: FleetSetup, variable: string): Promise<string> {
  return (await publishedConfiguration(page, setup.organizationId, setup.user.userId, `helm-otel-${unique()}`, { yaml: readingVariable(variable) }))
    .versionId;
}

function isGetTo(path: RegExp): (response: Response) => boolean {
  return (response) => response.request().method() === "GET" && path.test(new URL(response.url()).pathname);
}

function isPostTo(path: RegExp): (response: Response) => boolean {
  return (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname);
}

/** Every response `matches` takes from now on, in order. */
function recordResponses(page: Page, matches: (response: Response) => boolean): Response[] {
  const seen: Response[] = [];
  page.on("response", (response) => {
    if (matches(response)) seen.push(response);
  });
  return seen;
}

/** Every request to `path` with `method` from now on. */
function recordRequests(page: Page, method: string, path: RegExp): Request[] {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === method && path.test(new URL(request.url()).pathname)) seen.push(request);
  });
  return seen;
}

/** The fleet's page (at `tab`), hydrated. */
async function openFleet(page: Page, fleetId: string, tab?: "groups" | "tokens"): Promise<void> {
  const read = tab === "groups" ? page.waitForResponse(isGetTo(GROUPS_PATH)) : tab === undefined ? page.waitForResponse(isGetTo(COLLECTORS_PATH)) : null;
  const tokens = tab === "tokens" ? page.waitForResponse(isGetTo(TOKENS_PATH)) : null;
  const links = tab === "tokens" ? page.waitForResponse(isGetTo(LINKS_PATH)) : null;
  await page.goto(`/fleet-management/${fleetId}${tab === undefined ? "" : `?tab=${tab}`}`);
  await waitForHydration(page);
  for (const answer of [read, tokens, links]) if (answer !== null) expect((await answer).status()).toBe(200);
}

/** The header's install button ("Install with Helm" on a Kubernetes fleet, "Install collector" on a server one). */
function headerButton(page: Page, name: string): Locator {
  return page.locator("header", { has: page.getByRole("heading", { level: 1 }) }).getByRole("button", { name, exact: true });
}

/** The Helm install dialog, whatever its title says now: its own, or the Quick Deploy screen's. */
function helmDialog(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /^(Install with Helm|Quick Deploy command ready)$/ }) });
}

/** Opens the Helm dialog from `opener`, its groups, settings, tokens and the chosen group's facts answered: those facts. */
async function openHelm(page: Page, opener: Locator): Promise<HelmInstallFacts> {
  const facts = page.waitForResponse(isGetTo(INSTALL_PATH));
  await opener.click();
  const answer = await facts;
  expect(answer.status()).toBe(200);
  expect(answer.headers()["cache-control"]).toBe("no-store");
  await expect(helmDialog(page).getByRole("button", { name: "Download values.yaml", exact: true })).toBeEnabled();
  return HelmInstallFactsSchema.parse(await answer.json());
}

/** The `SecretCopyBox` whose copy button is named `label`: its box (`ph-no-capture`) and the text it holds. */
function copyBox(scope: Locator, label: string): { box: Locator; text: Locator } {
  const box = scope.getByRole("button", { name: label, exact: true }).locator("xpath=..");
  return { box, text: box.locator("code") };
}

/** The box named by `label` is inside `ph-no-capture` and holds exactly `text` (no secret in it: printed on a failure). */
async function expectBox(scope: Locator, label: string, text: string): Promise<void> {
  const { box, text: shown } = copyBox(scope, label);
  await expect(box).toHaveClass(/(^|\s)ph-no-capture(\s|$)/);
  // Its text exactly, line breaks kept (toHaveText would fold the whitespace).
  await expect.poll(() => shown.textContent()).toBe(text);
}

/** Picks `option` in the Select named `name`, within `scope`. */
async function choose(page: Page, scope: Locator, name: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** Ticks `variable` in the dialog's variables and types `value`. */
async function typeVariable(dialog: Locator, variable: string, value: string): Promise<void> {
  await dialog.getByRole("checkbox", { name: `Include ${variable}`, exact: true }).check();
  await dialog.getByRole("textbox", { name: variable, exact: true }).fill(value);
}

/** None of `texts` is anywhere in the page: its markup, attributes included, and its title. A failure names their indexes only. */
async function expectNowhere(page: Page, texts: string[]): Promise<void> {
  const content = await page.content();
  const title = await page.title();
  const found = texts.flatMap((text, index) => (content.includes(text) || title.includes(text) ? [index] : []));
  expect(found, "the indexes of the texts found on the page").toEqual([]);
}

/** The index of the first line of `actual` that differs from `expected` (-1: none), so a failure prints no line. */
function firstDifferentLine(actual: string, expected: string): number {
  const [lines, wanted] = [actual.split("\n"), expected.split("\n")];
  for (let index = 0; index < Math.max(lines.length, wanted.length); index += 1) if (lines[index] !== wanted[index]) return index;
  return -1;
}

/** `helm upgrade --install`'s lines (decision 18; Preflight ruling 8; Ruling 37): every value quoted once. */
function installLines(release: string, namespace: string, valuesFile: string): string[] {
  return [
    `helm upgrade --install '${release}' '${DEFAULT_HELM_CHART_REFERENCE}' \\`,
    `  --version '${DEFAULT_HELM_CHART_VERSION}' \\`,
    `  -n '${namespace}' --create-namespace \\`,
    `  -f '${valuesFile}' \\`,
    "  --wait --timeout=120s",
  ];
}

/** The link's secret: its URL's last segment. */
function secretOf(created: CreateQuickDeployLinkResponse): string {
  return created.url.slice(created.url.lastIndexOf("/") + 1);
}

/** An instant as the screens show it, formatted in the page (the browser's time zone), as `formatDateTime` writes it. */
async function formatted(page: Page, iso: string, { toTheSecond = false } = {}): Promise<string> {
  const options = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", ...(toTheSecond ? { second: "2-digit" } : {}) };
  return page.evaluate<string>(`new Date(${JSON.stringify(iso)}).toLocaleString("en-US", ${JSON.stringify(options)})`);
}

/** Install Links' rows, newest first. */
function linkRows(page: Page): Locator {
  return page.getByRole("tabpanel").getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Last downloaded" }) }).locator("tbody tr");
}

/** A row's cells: 0 Created by, 1 Group, 2 Install, 3 Created, 4 Expires, 5 Status, 6 Downloads. */
async function cellsOf(row: Locator): Promise<string[]> {
  return (await row.locator("td").allTextContents()).slice(0, 7);
}

/** A row's action by its whole accessible name: the verb and the link's creation to the second (D17c-2 Ruling 39). */
async function linkAction(page: Page, row: Locator, verb: "View" | "Revoke", link: { createdAt: string }): Promise<Locator> {
  return row.getByRole("button", { name: `${verb} the install link created ${await formatted(page, link.createdAt, { toTheSecond: true })}`, exact: true });
}

/** The values file a download answered, its token line replaced by a fixed one, and whether that token had a bearer's shape. */
function withoutToken(file: string): { rest: string; bearerShaped: boolean } {
  const token = TOKEN_LINE.exec(file)?.[1] ?? "";
  return { rest: file.replace(TOKEN_LINE, 'token: "-"'), bearerShaped: BEARER_SHAPED.test(token) && BEARER_PATTERN.test(token) };
}

/** Settings → Organization, hydrated, the switch's read answered. */
async function openOrganizationSettings(page: Page): Promise<Locator> {
  const read = page.waitForResponse(isGetTo(SETTINGS_PATH));
  await page.goto("/settings/organization");
  await waitForHydration(page);
  expect((await read).status()).toBe(200);
  return page.getByRole("switch", { name: SWITCH_NAME, exact: true });
}

/** The switch pressed by an admin: one PATCH of the new value, answered 200, the toast, the switch showing it. */
async function turnLinks(page: Page, links: Locator, on: boolean): Promise<void> {
  const changed = page.waitForResponse((response) => response.request().method() === "PATCH" && SETTINGS_PATH.test(new URL(response.url()).pathname));
  await links.click();
  const answer = await changed;
  expect(answer.status()).toBe(200);
  expect(answer.request().postDataJSON()).toEqual({ publicInstallLinks: on });
  await expect(page.getByText(on ? "Public install links turned on" : "Public install links turned off", { exact: true })).toBeVisible();
  await expect(links).toHaveAttribute("aria-checked", String(on));
}

test("Install with Helm from the header: Download values.yaml saves the file equal to the contracts' render with the reveal's bearer; the command screen's quoted helm upgrade --install; the bearer nowhere on the page; gone after Done", async ({
  page,
}) => {
  const setup = await signedInWithKubernetesFleet(page);
  const canary = unique();
  const variable = `TENANT_${canary.toUpperCase()}`;
  // The typed value's own canary: the namespace's shows in the dialog, the value's must not.
  const typed = `v${unique()}`;
  const value = `prod's "${typed}" $(echo EXPANDED)`;
  const namespace = `ns-${canary}`;
  const volume = { hostPath: `/var/log/host-${canary}`, hostPathType: "Directory" as const, mountPath: `/mnt/host-${canary}`, readOnly: true };
  await updateGroupThroughApi(page, setup.organizationId, setup.fleetId, setup.defaultGroupId, {
    assignedVersionId: await versionReading(page, setup, variable),
    annotations: kubernetesAnnotations({ role: "node", namespace, volumes: [volume] }),
  });
  await openFleet(page, setup.fleetId);
  const opener = headerButton(page, HELM_INSTALL_TITLE);
  const factsReads = recordResponses(page, isGetTo(INSTALL_PATH));
  const opened = await openHelm(page, opener);
  const dialog = helmDialog(page);
  await expect(dialog).toHaveAccessibleName(HELM_INSTALL_TITLE);
  await expect(dialog).toHaveAccessibleDescription(HELM_INSTALL_DESCRIPTION);

  // Opened on the Agent (the first group with a Helm install): its release and namespace as text inside ph-no-capture.
  await expect(dialog.getByRole("combobox", { name: "Group", exact: true })).toHaveText("Agent");
  expect(opened.helm).toEqual({
    chartReference: DEFAULT_HELM_CHART_REFERENCE,
    chartVersion: DEFAULT_HELM_CHART_VERSION,
    // The platform's image (D18 decision 29; the E2E API leaves TELFLO_COLLECTOR_IMAGE_REPOSITORY empty).
    imageRepository: COLLECTOR_IMAGE_REPOSITORY,
    release: HELM_AGENT_RELEASE,
    // D18 decision 21: the Agent's objects named by this fleet's id.
    fullnameOverride: `${setup.fleetId.slice(0, 8)}-default`,
    role: "node",
    namespace,
    replicas: null,
    volumes: [volume],
  });
  expect(opened.envVarNames).toEqual([variable]);
  await expect(dialog.locator("dl.ph-no-capture")).toHaveText(`Release${HELM_AGENT_RELEASE}Namespace${namespace}`);
  expect(await placesOf(page, [namespace])).toEqual([{ inside: 1, outside: 0, inAttributes: 0 }]);
  await typeVariable(dialog, variable, value);

  // Download: the tokens and the facts read again, the default token revealed once, the file saved under a name of its own.
  const reveals = recordRequests(page, "POST", REVEAL_PATH);
  const revealed = page.waitForResponse(isPostTo(REVEAL_PATH));
  const file = await downloaded(page, () => dialog.getByRole("button", { name: "Download values.yaml", exact: true }).click());
  const revealReply = await revealed;
  expect(revealReply.status()).toBe(200);
  expect(revealReply.headers()["cache-control"]).toBe("no-store");
  expect(new URL(revealReply.url()).pathname).toMatch(new RegExp(`/tokens/${setup.defaultTokenId}/reveal$`));
  const { bearer } = ((await revealReply.json()) as EnrollmentTokenRevealedResponse).token;
  // Never printed: the bearer, by its shape.
  expect(BEARER_SHAPED.test(bearer), "the reveal answered a bearer").toBe(true);
  expect(file.name).toMatch(AGENT_DOWNLOAD_NAME);
  // The file the contracts render from the facts the download read (the second read) and the reveal's bearer.
  expect(factsReads).toHaveLength(2);
  const facts = HelmInstallFactsSchema.parse(await factsReads[1]!.json());
  const expected = helmValuesYaml(helmValuesInputOf(facts, bearer, [{ name: variable, value }]));
  const saved = file.bytes.toString("utf8");
  expect(firstDifferentLine(saved, expected), "the first line of the file that differs from the render (-1: none)").toBe(-1);
  expect(saved === expected, "values.yaml is the contracts' render with the reveal's bearer").toBe(true);
  // What the render holds, by the field (never the file printed): the Agent's fullnameOverride right after its group (D18
  // decision 21), the typed value in collectorEnv, the volume, the group's id.
  expect(saved.includes(`\ngroup: "node"\nfullnameOverride: "${setup.fleetId.slice(0, 8)}-default"\n`), "the Agent's fullnameOverride follows group").toBe(true);
  expect(saved.includes(`  "${variable}": "prod's \\"${typed}\\" $(echo EXPANDED)"\n`), "collectorEnv holds the typed value").toBe(true);
  expect(saved.includes(`collectorGroupId: "${setup.defaultGroupId}"\n`), "the values name the Agent's group").toBe(true);
  expect(saved.includes(`    hostPath: "${volume.hostPath}"\n`), "the values hold the volume").toBe(true);
  expect(reveals).toHaveLength(1);
  await expect(page.getByText("Download started", { exact: true })).toBeVisible();

  // The command screen: the file's name, the quoted install reading it (no secret in it), the warnings.
  await expect(dialog).toHaveAccessibleName(HELM_INSTALL_TITLE);
  await expect(dialog).toHaveAccessibleDescription(helmCommandIntro(file.name));
  const command = helmInstallCommand({
    release: facts.helm.release,
    chartReference: facts.helm.chartReference,
    chartVersion: facts.helm.chartVersion,
    namespace: facts.helm.namespace,
    valuesFile: file.name,
  });
  expect(command).toBe(installLines(HELM_AGENT_RELEASE, namespace, file.name).join("\n"));
  await expectBox(dialog, "Copy install command", command);
  await expect(dialog.getByRole("button", { name: "Copy install command", exact: true })).toBeFocused();
  await expect(dialog.getByText(HELM_RENAMED_FILE_WORDS, { exact: true })).toBeVisible();
  await expect(dialog.getByText(helmValuesWarning(file.name), { exact: true })).toBeVisible();
  // The file's name (the release's) only inside ph-no-capture: the intro, the command and the warning (Ruling 40).
  expect(await placesOf(page, [file.name])).toEqual([{ inside: 3, outside: 0, inAttributes: 0 }]);
  // The bearer and the typed value nowhere on the page: they went into the file only.
  await expectNowhere(page, [bearer, typed]);

  // Done: the dialog gone, the focus back on the header's button.
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expectNowhere(page, [bearer, typed]);
});

test("Quick Deploy: the link's command shown once inside ph-no-capture; the public download with no session answers values.yaml (no-store, nosniff, no-referrer), its token bearer-shaped, a viewed event recorded; Install Links' Helm values row; revoke → 410", async ({
  page,
  playwright,
}) => {
  const setup = await signedInWithKubernetesFleet(page);
  const canary = unique();
  const variable = `TENANT_${canary.toUpperCase()}`;
  const typed = `v${unique()}`;
  const value = `value-${typed}`;
  // The Agent before its first save: the defaults (telflo-collectors, no volumes).
  await updateGroupThroughApi(page, setup.organizationId, setup.fleetId, setup.defaultGroupId, {
    assignedVersionId: await versionReading(page, setup, variable),
  });
  await openFleet(page, setup.fleetId);
  const facts = await openHelm(page, headerButton(page, HELM_INSTALL_TITLE));
  expect(facts.helm).toMatchObject({
    release: HELM_AGENT_RELEASE,
    fullnameOverride: `${setup.fleetId.slice(0, 8)}-default`,
    role: "node",
    namespace: "telflo-collectors",
    volumes: [],
  });
  const dialog = helmDialog(page);
  await typeVariable(dialog, variable, value);

  // One click: the link's create (no reveal), its reply no-store with the link's url.
  const reveals = recordRequests(page, "POST", REVEAL_PATH);
  const answered = page.waitForResponse(isPostTo(CREATE_LINK_PATH));
  await dialog.getByRole("button", { name: "Quick Deploy", exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.request().postDataJSON()).toEqual({ kind: "helm", env: [{ name: variable, value }] });
  expect(new URL(response.url()).pathname).toMatch(new RegExp(`/groups/${setup.defaultGroupId}/quick-deploy-links$`));
  const created = (await response.json()) as CreateQuickDeployLinkResponse;
  // Never printed on a failure: the url holds the link's secret.
  expect(LINK_URL.test(created.url), "the link's url has the pattern").toBe(true);
  expect(created.link).toMatchObject({
    groupId: setup.defaultGroupId,
    defaultTokenId: setup.defaultTokenId,
    choices: { kind: "helm", role: "node", release: HELM_AGENT_RELEASE, namespace: "telflo-collectors", envNames: [variable] },
    status: "active",
    downloadCount: 0,
    revokedAt: null,
  });
  expect(Date.parse(created.link.expiresAt!) - Date.parse(created.link.createdAt)).toBe(DAY_MS);
  const secret = secretOf(created);

  // The screen: its words, the command (the curl line, then the install) in the box at once, the link's secret only there.
  await expect(dialog).toHaveAccessibleName("Quick Deploy command ready");
  await expect(dialog).toHaveAccessibleDescription(HELM_QUICK_DEPLOY_WORDS);
  const expiry = `This command is shown only now. It expires ${await formatted(page, created.link.expiresAt!)}; extend or revoke it under Install links on the Tokens tab.`;
  await expect(dialog.getByText(expiry, { exact: true })).toBeVisible();
  await expect(dialog.getByText(HELM_QUICK_DEPLOY_WARNING, { exact: true })).toBeVisible();
  const command = helmQuickDeployCommand(created.url, {
    release: facts.helm.release,
    namespace: facts.helm.namespace,
    chartReference: facts.helm.chartReference,
    chartVersion: facts.helm.chartVersion,
  });
  const golden = [
    `( umask 077 && printf 'url = "%s"\\n' '${created.url}' | curl -q -g -fsS --retry 3 -K - -o 'telflo-node-values.yaml' ) && \\`,
    ...installLines(HELM_AGENT_RELEASE, "telflo-collectors", "telflo-node-values.yaml"),
  ].join("\n");
  expect(firstDifferentLine(command, golden), "the first line of the command that differs from the golden (-1: none)").toBe(-1);
  const box = copyBox(dialog, "Copy command");
  await expect(box.box).toHaveClass(/(^|\s)ph-no-capture(\s|$)/);
  await expect.poll(async () => (await box.text.textContent()) === command, { message: "the box holds the command" }).toBe(true);
  await expect(dialog.getByRole("button", { name: "Copy command", exact: true })).toBeFocused();
  await expectBearersOnlyInNoCapture(page, [secret]);
  await expectNowhere(page, [typed]);
  expect(reveals).toEqual([]);

  // Done: the secret leaves the page.
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectNowhere(page, [secret]);

  // The public download, by a context with no session: values.yaml, its headers, no cookie set.
  const [values] = await fetchedWithoutSession(playwright, [created.url]);
  expect(values!.status).toBe(200);
  expect(values!.headers).toMatchObject({
    "content-type": "text/yaml; charset=utf-8",
    "content-disposition": 'attachment; filename="values.yaml"',
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  expect(values!.headers["set-cookie"]).toBeUndefined();
  // The group's current state and the sealed typed value, rendered as the browser's download is; the token by its shape.
  const answered200 = withoutToken(values!.body.toString("utf8"));
  expect(answered200.bearerShaped, "the public download's token has a bearer's shape").toBe(true);
  const expected = withoutToken(helmValuesYaml(helmValuesInputOf(facts, STAND_IN_BEARER, [{ name: variable, value }]))).rest;
  expect(firstDifferentLine(answered200.rest, expected), "the first line that differs from the render (-1: none)").toBe(-1);
  expect(answered200.rest === expected, "the public values.yaml is the render, its token aside").toBe(true);
  expect(values!.body.toString("utf8").includes(secret), "the values hold no link secret").toBe(false);

  // The bearer revealed at the download: the default token's viewed event, by no person.
  const history = await page.request.get(`/api/v1/organizations/${setup.organizationId}/fleets/${setup.fleetId}/tokens/events`);
  expect(history.status()).toBe(200);
  const views = ((await history.json()) as EnrollmentTokenEventsPage).events.filter((event) => event.event === "viewed");
  expect(views.map((event) => [event.tokenId, event.actor])).toEqual([[setup.defaultTokenId, null]]);

  // Install Links on the Kubernetes fleet: the Helm values row, the Agent by its role, one download.
  await openFleet(page, setup.fleetId, "tokens");
  await expect(page.getByText(KUBERNETES_INSTALL_LINKS_HELP, { exact: true })).toBeVisible();
  const row = linkRows(page);
  await expect(row).toHaveCount(1);
  expect(await cellsOf(row)).toEqual([
    setup.user.email,
    "Agent",
    "Helm values",
    await formatted(page, created.link.createdAt),
    await formatted(page, created.link.expiresAt!),
    "Active",
    "1",
  ]);

  // View: the group, the install, the release and namespace, the variable by its name only.
  const view = await linkAction(page, row, "View", created.link);
  await view.click();
  const viewDialog = page.getByRole("dialog", { name: "Install link", exact: true });
  const details = viewDialog.locator(".ph-no-capture");
  await expect(details.locator("dl")).toHaveText(`GroupAgentInstallHelm valuesRelease${HELM_AGENT_RELEASE}Namespacetelflo-collectors`);
  await expect(details.getByRole("listitem")).toHaveText([`${variable}set`]);
  await expect(details).not.toContainText("Systemd service");
  await expectNowhere(page, [secret, typed]);
  await viewDialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(viewDialog).toBeHidden();
  await expect(view).toBeFocused();

  // Revoke: its words with the Helm sentence; Revoked; the public download then 410.
  await (await linkAction(page, row, "Revoke", created.link)).click();
  const revokeDialog = page.getByRole("alertdialog", { name: "Revoke this install link?", exact: true });
  await expect(revokeDialog).toHaveAccessibleDescription(`${REVOKE_LINK_WORDS} ${REVOKE_HELM_LINK_WORDS}`);
  const revoked = page.waitForResponse(isPostTo(REVOKE_LINK_PATH));
  await revokeDialog.getByRole("button", { name: "Revoke link", exact: true }).click();
  expect((await revoked).status()).toBe(200);
  await expect(page.getByText("Install link revoked", { exact: true })).toBeVisible();
  await expect.poll(() => cellsOf(row).then((cells) => cells[5])).toBe("Revoked");
  const [refused] = await fetchedWithoutSession(playwright, [created.url]);
  expectRefused(refused!, 410, REVOKED_TEXT);
  const [listed] = await quickDeployLinksThroughApi(page, setup.organizationId, setup.fleetId);
  expect([listed!.id, listed!.downloadCount, listed!.status]).toEqual([created.link.id, 1, "revoked"]);
});

// D18 decisions 5, 23 and 33: a variable named by a YAML 1.1 word (`ON`), which the platform refused while the chart
// wrote collectorEnv's keys unquoted, is offered like any other. The canary is its typed value ("ON" itself is inside
// "JSON"): in the downloaded values.yaml under the quoted key, in a Helm values link's public download, and on the page
// only as its input's value, inside ph-no-capture.
test("a YAML-word variable (ON): Include ON enabled; its typed value in the downloaded values.yaml under a quoted key and in a Helm values link's public download; the value in no other attribute and never outside ph-no-capture", async ({
  page,
  playwright,
}) => {
  const setup = await signedInWithKubernetesFleet(page);
  const variable = "ON";
  const value = `on-${unique()}`;
  const valueLine = `\ncollectorEnv:\n  "${variable}": "${value}"\n`;
  await updateGroupThroughApi(page, setup.organizationId, setup.fleetId, setup.defaultGroupId, {
    assignedVersionId: await versionReading(page, setup, variable),
  });
  await openFleet(page, setup.fleetId);
  const opener = headerButton(page, HELM_INSTALL_TITLE);
  const factsReads = recordResponses(page, isGetTo(INSTALL_PATH));
  const opened = await openHelm(page, opener);
  expect(opened.envVarNames).toEqual([variable]);
  const dialog = helmDialog(page);
  // Offered: its row enabled, no refusal beside it.
  await expect(dialog.getByRole("checkbox", { name: `Include ${variable}`, exact: true })).toBeEnabled();
  await typeVariable(dialog, variable, value);
  await expect(dialog.getByRole("button", { name: "Download values.yaml", exact: true })).toBeEnabled();
  // The value only as its input's value, inside ph-no-capture: in no other attribute, in no text.
  expect(await attributeHoldersOf(page, [value])).toEqual([[INPUT_VALUE]]);
  expect(await placesOf(page, [value])).toEqual([{ inside: 0, outside: 0, inAttributes: 1 }]);

  // Download: the contracts' render of the facts the download read, the value under the quoted key.
  const revealed = page.waitForResponse(isPostTo(REVEAL_PATH));
  const file = await downloaded(page, () => dialog.getByRole("button", { name: "Download values.yaml", exact: true }).click());
  const revealReply = await revealed;
  expect(revealReply.status()).toBe(200);
  const { bearer } = ((await revealReply.json()) as EnrollmentTokenRevealedResponse).token;
  expect(file.name).toMatch(AGENT_DOWNLOAD_NAME);
  expect(factsReads).toHaveLength(2);
  const facts = HelmInstallFactsSchema.parse(await factsReads[1]!.json());
  const saved = file.bytes.toString("utf8");
  const expected = helmValuesYaml(helmValuesInputOf(facts, bearer, [{ name: variable, value }]));
  expect(firstDifferentLine(saved, expected), "the first line of the file that differs from the render (-1: none)").toBe(-1);
  expect(saved === expected, "values.yaml is the contracts' render with the reveal's bearer").toBe(true);
  expect(saved.endsWith(valueLine), "collectorEnv holds the quoted key and the typed value").toBe(true);
  await expect(dialog.getByRole("button", { name: "Copy install command", exact: true })).toBeFocused();
  expect(await attributeHoldersOf(page, [value])).toEqual([[]]);
  await expectNowhere(page, [bearer, value]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Quick Deploy: the link's create carries the variable; its screen holds no value.
  const linkFacts = await openHelm(page, opener);
  await typeVariable(dialog, variable, value);
  expect(await attributeHoldersOf(page, [value])).toEqual([[INPUT_VALUE]]);
  expect(await placesOf(page, [value])).toEqual([{ inside: 0, outside: 0, inAttributes: 1 }]);
  const answered = page.waitForResponse(isPostTo(CREATE_LINK_PATH));
  await dialog.getByRole("button", { name: "Quick Deploy", exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ kind: "helm", env: [{ name: variable, value }] });
  const created = (await response.json()) as CreateQuickDeployLinkResponse;
  expect(created.link.choices).toMatchObject({ kind: "helm", role: "node", release: HELM_AGENT_RELEASE, envNames: [variable] });
  await expect(dialog.getByRole("button", { name: "Copy command", exact: true })).toBeFocused();
  const secret = secretOf(created);
  await expectBearersOnlyInNoCapture(page, [secret]);
  expect(await attributeHoldersOf(page, [value])).toEqual([[]]);
  await expectNowhere(page, [value]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectNowhere(page, [secret, value]);

  // The link's public download, with no session: the render with the typed value, its token by its shape.
  const [values] = await fetchedWithoutSession(playwright, [created.url]);
  expect(values!.status).toBe(200);
  expect(values!.headers["content-type"]).toBe("text/yaml; charset=utf-8");
  const answered200 = withoutToken(values!.body.toString("utf8"));
  expect(answered200.bearerShaped, "the public download's token has a bearer's shape").toBe(true);
  const expectedPublic = withoutToken(helmValuesYaml(helmValuesInputOf(linkFacts, STAND_IN_BEARER, [{ name: variable, value }]))).rest;
  expect(firstDifferentLine(answered200.rest, expectedPublic), "the first line that differs from the render (-1: none)").toBe(-1);
  expect(answered200.rest === expectedPublic, "the public values.yaml is the render, its token aside").toBe(true);
  expect(answered200.rest.endsWith(valueLine), "the public values hold the quoted key and the typed value").toBe(true);
});

test("the Public install links switch: an admin turns it off; both install dialogs hide Quick Deploy with the words; an existing link answers 403 plain text; Download values.yaml still works; on again, the link downloads", async ({
  page,
  playwright,
}) => {
  const setup = await signedInWithKubernetesFleet(page);
  const { organizationId } = setup;
  await updateGroupThroughApi(page, organizationId, setup.fleetId, setup.defaultGroupId, {
    assignedVersionId: await versionReading(page, setup, "SITE_NAME"),
  });
  // A server fleet of the same organization, its Default group published: the Linux dialog and a Linux link.
  const server = await createServerFleetThroughApi(page, organizationId);
  const serverVersion = await publishedConfiguration(page, organizationId, setup.user.userId, `linux-otel-${unique()}`);
  await updateGroupThroughApi(page, organizationId, server.fleet.id, server.defaultGroup.id, { assignedVersionId: serverVersion.versionId });
  const helmLink = await createQuickDeployLinkThroughApi(page, organizationId, setup.fleetId, setup.defaultGroupId, { kind: "helm", env: [] });
  const linuxLink = await createQuickDeployLinkThroughApi(page, organizationId, server.fleet.id, server.defaultGroup.id, {
    method: "all-in-one",
    arch: "amd64",
    rootPath: "/etc/otelcol",
    env: [],
    systemd: false,
  });

  // Settings → Organization: the switch on, its words; the admin turns it off.
  const links = await openOrganizationSettings(page);
  await expect(links).toHaveAttribute("aria-checked", "true");
  await expect(links).toBeEnabled();
  await expect(links).toHaveAccessibleDescription(SWITCH_DESCRIPTION);
  await expect(page.getByText(ONLY_AN_ADMIN, { exact: true })).toHaveCount(0);
  await turnLinks(page, links, false);

  // Every existing link's download refused in plain text; nothing counted.
  const off = await fetchedWithoutSession(playwright, [helmLink.url, linuxLink.url]);
  expectRefused(off[0]!, 403, LINKS_OFF_TEXT);
  expectRefused(off[1]!, 403, LINKS_OFF_TEXT);
  // A new link refused at its create.
  const refusedCreate = await page.request.post(
    `/api/v1/organizations/${organizationId}/fleets/${setup.fleetId}/groups/${setup.defaultGroupId}/quick-deploy-links`,
    { data: { kind: "helm", env: [] }, headers: CSRF },
  );
  expect(refusedCreate.status()).toBe(409);
  expect(((await refusedCreate.json()) as { error: { code: string } }).error.code).toBe("public_install_links_disabled");

  // The Helm dialog: no Quick Deploy, the words; Download values.yaml still saves the file.
  await openFleet(page, setup.fleetId);
  await openHelm(page, headerButton(page, HELM_INSTALL_TITLE));
  const dialog = helmDialog(page);
  await expect(dialog.getByRole("button", { name: "Quick Deploy", exact: true })).toHaveCount(0);
  await expect(dialog.getByText(LINKS_OFF_WORDS, { exact: true })).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(HELM_INSTALL_DESCRIPTION_LINKS_OFF);
  const file = await downloaded(page, () => dialog.getByRole("button", { name: "Download values.yaml", exact: true }).click());
  expect(file.name).toMatch(AGENT_DOWNLOAD_NAME);
  expect(withoutToken(file.bytes.toString("utf8")).bearerShaped, "the saved file holds a bearer").toBe(true);
  await expect(dialog.getByRole("button", { name: "Copy install command", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();

  // The Linux dialog: no Quick Deploy and no systemd box, the words; Download enabled.
  await openFleet(page, server.fleet.id);
  const linuxFacts = page.waitForResponse(isGetTo(INSTALL_PATH));
  await headerButton(page, "Install collector").click();
  expect((await linuxFacts).status()).toBe(200);
  const linux = page.getByRole("dialog", { name: "Install collectors: Default" });
  await choose(page, linux, "Method", /^Linux All In One \(amd64\)/);
  await expect(linux.getByText(LINKS_OFF_WORDS, { exact: true })).toBeVisible();
  await expect(linux.getByRole("button", { name: "Quick Deploy", exact: true })).toHaveCount(0);
  await expect(linux.getByRole("checkbox", { name: "Install as a systemd service (starts on boot)" })).toHaveCount(0);
  await expect(linux.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(linux).toBeHidden();

  // On again: the links download; nothing was counted while off.
  await turnLinks(page, await openOrganizationSettings(page), true);
  const on = await fetchedWithoutSession(playwright, [helmLink.url, linuxLink.url]);
  expect(on.map((answer) => [answer.status, answer.headers["content-type"]])).toEqual([
    [200, "text/yaml; charset=utf-8"],
    [200, "application/gzip"],
  ]);
  expect(withoutToken(on[0]!.body.toString("utf8")).bearerShaped, "the Helm link's values hold a bearer").toBe(true);
  expect((await quickDeployLinksThroughApi(page, organizationId, setup.fleetId)).map((link) => link.downloadCount)).toEqual([1]);
  expect((await quickDeployLinksThroughApi(page, organizationId, server.fleet.id)).map((link) => link.downloadCount)).toEqual([1]);
});

test("a member sees the switch disabled with its words", async ({ page }) => {
  const admin = await seedUser({ password: PASSWORD });
  const member = await seedUser({ password: PASSWORD });
  await addMember({ userId: member.userId, organizationId: admin.organizationId, role: "contributor" });
  await signInThroughApi(page, member);
  await switchOrganizationThroughApi(page, admin.organizationId);
  const writes = recordRequests(page, "PATCH", SETTINGS_PATH);

  const links = await openOrganizationSettings(page);
  await expect(links).toHaveAttribute("aria-checked", "true");
  await expect(links).toBeDisabled();
  await expect(links).toHaveAccessibleDescription(`${SWITCH_DESCRIPTION} ${ONLY_AN_ADMIN}`);
  await expect(page.getByText(ONLY_AN_ADMIN, { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  // The API refuses the member's change too, and the switch stays on.
  const refused = await page.request.patch(`/api/v1/organizations/${admin.organizationId}/settings`, { data: { publicInstallLinks: false }, headers: CSRF });
  expect(refused.status()).toBe(403);
  const settings = await page.request.get(`/api/v1/organizations/${admin.organizationId}/settings`);
  expect(await settings.json()).toEqual({ publicInstallLinks: true });
});

test("the Kubernetes checklist, a row's Install, and the uninstall lines quoted", async ({ page }) => {
  const setup = await signedInWithKubernetesFleet(page);
  const { organizationId, fleetId } = setup;
  const canary = unique();
  const gateway = `gw-${canary}`;
  const namespace = `ns-${canary}`;
  await openFleet(page, fleetId);

  // The checklist while the fleet has no collectors: nothing assigned yet; Assign opens the Groups tab.
  const checklist = page.getByRole("region", { name: "Fleet setup" });
  await expect(checklist.getByRole("heading", { name: CHECKLIST.title })).toBeVisible();
  await expect(checklist.getByRole("listitem")).toHaveText([
    `1${CHECKLIST.assign}${CHECKLIST.assignDetail}Assign`,
    `2${CHECKLIST.install}${CHECKLIST.installDetail}Install`,
    `3${CHECKLIST.connect}${CHECKLIST.connectDetail}`,
  ]);
  await checklist.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");

  // A gateway with a published version; the Agent's too.
  const versionId = await versionReading(page, setup, "SITE_NAME");
  const gatewayGroup = await createGroupThroughApi(page, organizationId, fleetId, gateway, {
    assignedVersionId: versionId,
    annotations: kubernetesAnnotations({ role: "gateway", namespace, replicas: 2, volumes: [] }),
  });
  await updateGroupThroughApi(page, organizationId, fleetId, setup.defaultGroupId, { assignedVersionId: versionId });
  await openFleet(page, fleetId, "groups");
  await expect(checklist.getByRole("listitem").first()).toHaveText(`Done:${CHECKLIST.assign}`);

  // The rows' Install: the Cluster's disabled with its reason (no group yet); the gateway's opens the dialog on it.
  const panel = page.getByRole("tabpanel");
  const clusterInstall = panel.getByRole("button", { name: "Install Cluster", exact: true });
  await expect(clusterInstall).toHaveAttribute("aria-disabled", "true");
  // Its reason in its tooltip and, in brackets, its hidden description (GroupsTable's RowInstallButton).
  await expect(clusterInstall).toHaveAccessibleDescription(`(${NEEDS_VERSION})`);
  const rowInstall = panel.getByRole("button", { name: `Install ${gateway}`, exact: true });
  const gatewayFacts = await openHelm(page, rowInstall);
  // A gateway's objects are named by its own name: no fullnameOverride (D18 decision 21).
  expect(gatewayFacts.helm).toMatchObject({ release: gateway, fullnameOverride: null, role: "gateway", namespace, replicas: 2 });
  const dialog = helmDialog(page);
  await expect(dialog.getByRole("combobox", { name: "Group", exact: true })).toHaveText(gateway);
  // Its address as text inside ph-no-capture; the Select's options in the fleet's order, the Cluster disabled with its reason.
  await expect(dialog.locator("dl.ph-no-capture")).toContainText(`http://${gateway}.${namespace}.svc.cluster.local:4318`);
  await dialog.getByRole("combobox", { name: "Group", exact: true }).click();
  await expect(page.getByRole("option")).toHaveText(["Agent", `Cluster${NEEDS_VERSION}`, gateway]);
  await expect(page.getByRole("option", { name: "Cluster", exact: true })).toHaveAttribute("aria-disabled", "true");
  expect(await attributeHoldersOf(page, [gateway, namespace])).toEqual([[], []]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(rowInstall).toBeFocused();

  // The Cluster with a published version (D18 Ruling 30): its Install enabled, its objects named by this fleet's id.
  await createGroupThroughApi(page, organizationId, fleetId, COLLECTOR_GROUP_CLUSTER_NAME, {
    assignedVersionId: versionId,
    annotations: kubernetesAnnotations({ role: "cluster", namespace, volumes: [] }),
  });
  await openFleet(page, fleetId, "groups");
  await expect(clusterInstall).not.toHaveAttribute("aria-disabled", "true");
  const clusterFacts = await openHelm(page, clusterInstall);
  expect(clusterFacts.helm).toMatchObject({
    release: HELM_CLUSTER_RELEASE,
    fullnameOverride: `${fleetId.slice(0, 8)}-cluster`,
    role: "cluster",
    namespace,
    replicas: null,
  });
  await expect(dialog.getByRole("combobox", { name: "Group", exact: true })).toHaveText("Cluster");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The checklist's Install: the dialog on the Agent; a download marks the step done and the last one waiting.
  await checklist.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Group", exact: true })).toHaveText("Agent");
  const file = await downloaded(page, () => dialog.getByRole("button", { name: "Download values.yaml", exact: true }).click());
  expect(file.name).toMatch(AGENT_DOWNLOAD_NAME);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(checklist.getByRole("listitem")).toHaveText([
    `Done:${CHECKLIST.assign}`,
    `Done:${CHECKLIST.install}`,
    `3${CHECKLIST.connect}${CHECKLIST.waiting}Listening for the first check-in…`,
  ]);

  // Pods connect: the checklist hides, the header's Setup guide reopens it.
  const node = `node-${canary}`;
  const agentPod = `telflo-node-${canary}`;
  const gatewayPod = `${gateway}-0`;
  await enrollKubernetesPod(organizationId, fleetId, { name: agentPod, groupId: setup.defaultGroupId, nodeName: node, namespace: "telflo-collectors" });
  await enrollKubernetesPod(organizationId, fleetId, { name: gatewayPod, groupId: gatewayGroup.id, nodeName: node, namespace });
  await openFleet(page, fleetId);
  await expect(checklist).toHaveCount(0);
  await page.getByRole("button", { name: "Setup guide", exact: true }).click();
  await expect(checklist.getByRole("listitem").last()).toHaveText(`Done:${CHECKLIST.connect}`);
  await page.getByRole("button", { name: "Hide setup guide", exact: true }).click();
  await expect(checklist).toHaveCount(0);

  const gatewayUninstall = helmUninstallCommand({ release: gateway, namespace });
  const agentUninstall = helmUninstallCommand({ release: HELM_AGENT_RELEASE, namespace: "telflo-collectors" });
  expect([gatewayUninstall, agentUninstall]).toEqual([`helm uninstall '${gateway}' -n '${namespace}'`, "helm uninstall 'telflo-node' -n 'telflo-collectors'"]);

  // A collector's delete: its group's uninstall, quoted, in a copy box inside ph-no-capture.
  await page.getByRole("button", { name: `Delete ${gatewayPod}`, exact: true }).click();
  const deleteOne = page.getByRole("alertdialog", { name: "Delete collector record" });
  await expect(deleteOne.getByText(COLLECTOR_UNINSTALL_WORDS, { exact: true })).toBeVisible();
  await expectBox(deleteOne, "Copy uninstall command", gatewayUninstall);
  expect(await attributeHoldersOf(page, [gateway, namespace])).toEqual([[], []]);
  await deleteOne.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteOne).toBeHidden();

  // The bulk delete: one line per group, in the fleet's order, in one box.
  await page.getByRole("checkbox", { name: `Select ${gatewayPod}` }).click();
  await page.getByRole("checkbox", { name: `Select ${agentPod}` }).click();
  await page.getByRole("button", { name: "Delete selected collectors" }).click();
  const deleteMany = page.getByRole("alertdialog", { name: "Delete collectors" });
  await expect(deleteMany.getByText(BULK_UNINSTALL_WORDS, { exact: true })).toBeVisible();
  await expectBox(deleteMany, "Copy uninstall commands", `${agentUninstall}\n${gatewayUninstall}`);
  expect(await attributeHoldersOf(page, [gateway, namespace])).toEqual([[], []]);
  await deleteMany.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteMany).toBeHidden();

  // The group's delete: the Helm line, then its command.
  await openFleet(page, fleetId, "groups");
  await panel.getByRole("button", { name: `Delete ${gateway}`, exact: true }).click();
  const deleteGroup = page.getByRole("alertdialog", { name: `Delete ${gateway}` });
  await expect(deleteGroup).toContainText("Uninstall the group's Helm release in your cluster.");
  await expectBox(deleteGroup, "Copy uninstall command", gatewayUninstall);
  expect(await attributeHoldersOf(page, [namespace])).toEqual([[]]);
  await deleteGroup.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteGroup).toBeHidden();

  // The namespace warning: the release's uninstall from the namespace saved, only while the change is unsaved.
  await panel.getByRole("button", { name: `Edit ${gateway}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${gateway}` });
  const namespaceField = edit.getByLabel("Namespace", { exact: true });
  await expect(edit.getByRole("button", { name: "Copy uninstall command", exact: true })).toHaveCount(0);
  const moved = `ns2-${canary}`;
  await namespaceField.fill(moved);
  await expect(edit.getByText(/^A Helm release already installed keeps running in /)).toBeVisible();
  await expectBox(edit, "Copy uninstall command", gatewayUninstall);
  expect(await attributeHoldersOf(page, [moved])).toEqual([[INPUT_VALUE]]);
  await namespaceField.fill(namespace);
  await expect(edit.getByRole("button", { name: "Copy uninstall command", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();
});

test("no gateway name, namespace, variable name or value, path, bearer or link secret in any attribute: the Helm install, Quick Deploy, Install Links' View and Revoke, Edit's namespace warning, and the group, collector and bulk deletes", async ({
  page,
}) => {
  const setup = await signedInWithKubernetesFleet(page);
  const { organizationId, fleetId } = setup;
  const canary = unique();
  const gateway = `gw-${canary}`;
  const namespace = `ns-${canary}`;
  const variable = `TENANT_${canary.toUpperCase()}`;
  const value = `value-${unique()}`;
  const hostPath = `/var/log/host-${canary}`;
  const mountPath = `/mnt/host-${canary}`;
  const gatewayGroup = await createGroupThroughApi(page, organizationId, fleetId, gateway, {
    assignedVersionId: await versionReading(page, setup, variable),
    annotations: kubernetesAnnotations({
      role: "gateway",
      namespace,
      replicas: 3,
      volumes: [{ hostPath, hostPathType: "Directory", mountPath, readOnly: true }],
    }),
  });
  const named = [gateway, namespace, variable, value, hostPath, mountPath];
  /** Where each canary is in an attribute: only `allowed`'s (by index) may be there, as their inputs' values. */
  const expectAttributes = async (allowed: ReadonlyMap<number, string[]> = new Map()) =>
    expect(await attributeHoldersOf(page, named)).toEqual(named.map((_each, index) => allowed.get(index) ?? []));

  // The gateway row's Install: the dialog on the gateway, its release, namespace and address as text; the Select open.
  await openFleet(page, fleetId, "groups");
  await expectAttributes();
  await openHelm(page, page.getByRole("tabpanel").getByRole("button", { name: `Install ${gateway}`, exact: true }));
  const dialog = helmDialog(page);
  await expectAttributes();
  await dialog.getByRole("combobox", { name: "Group", exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(3);
  await expectAttributes();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await typeVariable(dialog, variable, value);
  // The typed value only in its own input's value, inside ph-no-capture.
  await expectAttributes(new Map([[3, [INPUT_VALUE]]]));
  expect((await placesOf(page, [variable]))[0]).toEqual({ inside: 1, outside: 0, inAttributes: 0 });

  // Download: the command screen holds no secret; the bearer and the value nowhere.
  const revealed = page.waitForResponse(isPostTo(REVEAL_PATH));
  const gatewayFile = await downloaded(page, () => dialog.getByRole("button", { name: "Download values.yaml", exact: true }).click());
  const { bearer } = ((await (await revealed).json()) as EnrollmentTokenRevealedResponse).token;
  // A gateway's values name it by its group only: no fullnameOverride line (D18 decision 21).
  const gatewayValues = gatewayFile.bytes.toString("utf8");
  expect(gatewayValues.includes(`\ngroup: "${gateway}"\ncollectorGroupId: "${gatewayGroup.id}"\n`), "the gateway's group, then its id").toBe(true);
  expect(gatewayValues.includes("fullnameOverride"), "the gateway's values hold no fullnameOverride").toBe(false);
  await expect(dialog.getByRole("button", { name: "Copy install command", exact: true })).toBeFocused();
  await expectAttributes();
  // The file's name (the gateway's release) only inside ph-no-capture: the intro, the command and the warning (Ruling 40).
  expect(await placesOf(page, [`${gateway}-values-`])).toEqual([{ inside: 3, outside: 0, inAttributes: 0 }]);
  await expectNowhere(page, [bearer, value]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Quick Deploy: the link's secret only inside ph-no-capture, in no attribute.
  await openHelm(page, page.getByRole("tabpanel").getByRole("button", { name: `Install ${gateway}`, exact: true }));
  await typeVariable(dialog, variable, value);
  const answered = page.waitForResponse(isPostTo(CREATE_LINK_PATH));
  await dialog.getByRole("button", { name: "Quick Deploy", exact: true }).click();
  const created = (await (await answered).json()) as CreateQuickDeployLinkResponse;
  await expect(dialog.getByRole("button", { name: "Copy command", exact: true })).toBeFocused();
  const secret = secretOf(created);
  await expectBearersOnlyInNoCapture(page, [secret]);
  await expectAttributes();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Install Links: the row, View (release, namespace, the variable's name) and Revoke, each open.
  await openFleet(page, fleetId, "tokens");
  const row = linkRows(page);
  await expect(row).toHaveCount(1);
  expect((await cellsOf(row))[1]).toBe(gateway);
  await expectAttributes();
  await (await linkAction(page, row, "View", created.link)).click();
  const viewDialog = page.getByRole("dialog", { name: "Install link", exact: true });
  await expect(viewDialog.locator(".ph-no-capture dl")).toContainText(`Release${gateway}Namespace${namespace}`);
  await expectAttributes();
  await expectNowhere(page, [secret, value]);
  await viewDialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(viewDialog).toBeHidden();
  await (await linkAction(page, row, "Revoke", created.link)).click();
  const revokeDialog = page.getByRole("alertdialog", { name: "Revoke this install link?", exact: true });
  await expect(revokeDialog).toBeVisible();
  await expectAttributes();
  await revokeDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(revokeDialog).toBeHidden();

  // Edit with its namespace changed: the fields' values (inside ph-no-capture) the only holders; the warning's uninstall.
  await openFleet(page, fleetId, "groups");
  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: `Edit ${gateway}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${gateway}` });
  await edit.getByLabel("Namespace", { exact: true }).fill(`${namespace}-moved`);
  await expectBox(edit, "Copy uninstall command", helmUninstallCommand({ release: gateway, namespace }));
  await expectAttributes(new Map([1, 4, 5].map((index) => [index, [INPUT_VALUE]])));
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();

  // The group's delete, its name typed: the input is uncontrolled, so no attribute holds it.
  await panel.getByRole("button", { name: `Delete ${gateway}`, exact: true }).click();
  const deleteGroup = page.getByRole("alertdialog", { name: `Delete ${gateway}` });
  await deleteGroup.getByLabel(`Type ${gateway} to confirm`, { exact: true }).fill(gateway);
  await expect(deleteGroup.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
  await expectAttributes();
  await deleteGroup.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteGroup).toBeHidden();

  // A pod of the gateway's: its delete and the bulk delete, each with the group's uninstall.
  const pod = `${gateway}-0`;
  await enrollKubernetesPod(organizationId, fleetId, { name: pod, groupId: gatewayGroup.id, nodeName: `node-${canary}`, namespace });
  await openFleet(page, fleetId);
  await page.getByRole("button", { name: `Delete ${pod}`, exact: true }).click();
  const deleteOne = page.getByRole("alertdialog", { name: "Delete collector record" });
  await expect(deleteOne.getByText(COLLECTOR_UNINSTALL_WORDS, { exact: true })).toBeVisible();
  await expectAttributes();
  await deleteOne.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteOne).toBeHidden();
  await page.getByRole("checkbox", { name: `Select ${pod}` }).click();
  await page.getByRole("button", { name: "Delete selected collectors" }).click();
  const deleteMany = page.getByRole("alertdialog", { name: "Delete collectors" });
  await expect(deleteMany.getByText(BULK_UNINSTALL_WORDS, { exact: true })).toBeVisible();
  await expectAttributes();
  await deleteMany.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteMany).toBeHidden();
  await expectNowhere(page, [bearer, secret, value]);
});
