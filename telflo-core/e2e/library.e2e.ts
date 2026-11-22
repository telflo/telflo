import { randomBytes, randomUUID } from "node:crypto";
import { expect, test as base, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, LIBRARY_LINK_PATH_PATTERN, type LibraryFile } from "@telflo/contracts";
import {
  deleteLibraryFiles,
  E2E_LIBRARY_FILE_NAME_PREFIX,
  findLibraryFileIdsByName,
  grantProductAdmin,
  seedUser,
  type SeededUser,
} from "./support/database.js";
import { downloaded } from "./support/downloads.js";
import { open } from "./support/editor-page.js";
import { E2E_SAAS_WEB_URL } from "./support/environment.js";
import { signInThroughApi } from "./support/session.js";
import { SAAS_ADMIN_NAV_ITEMS, adminNavItems, productAdminSession } from "./support/test-templates-page.js";
import { toastWith } from "./support/test-suites-page.js";

// The library, in the browser: product admin's Library tab (its place in the
// nav, the dialog's checks, add, edit and delete), and the members' /library
// (the sidebar's Learning, the search, Download, and Copy curl, whose link
// downloads the file with no session).
//
// The library is global, as test templates are: every parallel test (and
// every browser) sees what another wrote. Each test names its own files
// `e2e-library-<uuid>`, asserts only on its own rows (never a count or an
// empty state: those are component tests), and deletes them as the tables'
// owner when it ends, however it ends (`libraryFiles`). Each admin is a
// fresh user, made one by the README's SQL.
//
// The library link is a secret: it is never printed. The trace is off (it
// records the link's `201` body). The clipboard is read in a page of its
// own, never the app's (Chromium and Firefox `readText()`, WebKit a paste
// into a textarea), and the command is checked by a boolean against its
// shape. The link is fetched with Node's `fetch` (Playwright's request
// errors quote the URL; Node's don't), its failure rethrown with fixed
// words, and its bytes compared with `Buffer.equals`. No assertion holds the
// command, the link or its body as a value, and none that can fail runs
// while a page that holds or may hold the link is open: after Copy curl,
// every check on the page is taken as a boolean, the reader page is closed
// as soon as it is read, and the page goes to about:blank (in a finally, so
// also when a read throws) before the first assertion. That boolean-first
// rule IS the guard: a failed assertion's error-context.md holds the open
// page's ARIA snapshot, and a failed locator assertion carries a snapshot of
// its own whatever the environment says, so no switch of Playwright's stands
// in for it.

// What the page must never hold, named here, away from the assertions: a
// failed assertion's report quotes the lines around it, and these words
// would read there as a link's traces.
const LINK_PREFIX = "tll_";
const LINK_ROUTE = "library-links";
const COMMAND_START = "curl -fL";
/** The link's path as the API answers it (the contract's pattern, without its anchors). */
const LINK_PATH = LIBRARY_LINK_PATH_PATTERN.source.slice(1, -1);

const PASSWORD = "correct horse battery staple";

/** The names of the files a test writes, deleted (by id, found by name) when it ends. */
interface LibraryFiles {
  names: string[];
}

const test = base.extend<{ libraryFiles: LibraryFiles }>({
  // eslint-disable-next-line no-empty-pattern
  libraryFiles: async ({}, use) => {
    const written: LibraryFiles = { names: [] };
    await use(written);
    await deleteLibraryFiles(await findLibraryFileIdsByName(written.names));
  },
});

// On the SaaS pair: TELFLO_LEARNING is off on the default pair, the open source's default.
test.use({ viewport: { width: 1440, height: 1000 }, trace: "off", baseURL: E2E_SAAS_WEB_URL });

/** A library file name no other test uses, with the clean-up's prefix. */
function uniqueLibraryName(): string {
  return `${E2E_LIBRARY_FILE_NAME_PREFIX}library-${randomUUID()}`;
}

/** A file of bytes no other test has (not valid UTF-8, so nothing decodes them on the way). */
function libraryFileContent(): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: `e2e-library-${randomUUID()}.bin`,
    mimeType: "application/octet-stream",
    buffer: Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), randomBytes(512)]),
  };
}

/** Each page error, as it happens: none is expected anywhere here. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** A product admin of their own, signed in on `page`. */
async function signedInProductAdmin(page: Page): Promise<SeededUser> {
  const admin = await seedUser({ password: PASSWORD });
  await grantProductAdmin(admin.email);
  await signInThroughApi(page, admin);
  return admin;
}

/** Adds a library file as a product admin's API session, as the admin page's dialog does: its parts in the API's only order. */
async function createLibraryFileThroughApi(
  request: APIRequestContext,
  { name, description, file }: { name: string; description: string; file: ReturnType<typeof libraryFileContent> },
): Promise<LibraryFile> {
  const response = await request.post("/api/v1/library-files", {
    multipart: { name, description, file },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { libraryFile: LibraryFile }).libraryFile;
}

/** The files as the session (a page's, or an API session) lists them. */
async function listLibraryFilesThroughApi(request: APIRequestContext): Promise<LibraryFile[]> {
  const response = await request.get("/api/v1/library-files");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { libraryFiles: LibraryFile[] }).libraryFiles;
}

/** Opens product admin from the sidebar's Product Admin item (Flows, its home), then Library from its nav. */
async function openLibraryAdmin(page: Page): Promise<void> {
  await open(page, "/app");
  await page.getByRole("link", { name: "Product Admin" }).click();
  await expect(page).toHaveURL(`${E2E_SAAS_WEB_URL}/product-admin/flows`);
  await adminNavItems(page).filter({ hasText: "Library" }).click();
  await expect(page).toHaveURL(`${E2E_SAAS_WEB_URL}/product-admin/library`);
  await expect(page.getByRole("heading", { level: 1, name: "Library", exact: true })).toBeVisible();
  await expect(page.getByText("Loading library files...")).toHaveCount(0);
}

/** The admin page's row of the file named `name`. */
function adminRow(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
}

/** The members' page's row of the file named `name`. */
function memberRow(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
}

/** Opens /library from the sidebar's Learning, the list read. */
async function openLibraryFromSidebar(page: Page): Promise<void> {
  await open(page, "/app");
  await page.getByRole("link", { name: "Learning" }).click();
  await expect(page).toHaveURL(`${E2E_SAAS_WEB_URL}/library`);
  await expect(page.getByRole("heading", { level: 1, name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading library files" })).toHaveCount(0);
}

/**
 * The clipboard's text, read in a page of its own, never the app's:
 * Chromium and Firefox `readText()`, WebKit (or a refusal) a paste into the
 * reader's textarea. Never printed by the caller.
 */
async function clipboardText(context: BrowserContext, browserName: string): Promise<string> {
  const reader = await context.newPage();
  try {
    await reader.setContent("<textarea id=reader></textarea>");
    if (browserName !== "webkit") {
      try {
        return await reader.evaluate<string>("navigator.clipboard.readText()");
      } catch {
        // Not readable here: the paste below.
      }
    }
    await reader.click("#reader");
    await reader.keyboard.press("ControlOrMeta+V");
    return await reader.inputValue("#reader");
  } finally {
    await reader.close();
  }
}

/** `text` with every regular-expression character escaped. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a product admin's nav lists Library fourth, after User Feedback; a library file is added (after each check's words), edited and deleted", async ({
  page,
  libraryFiles,
}) => {
  const errors = pageErrors(page);
  await signedInProductAdmin(page);
  await openLibraryAdmin(page);
  await expect(adminNavItems(page)).toHaveText(SAAS_ADMIN_NAV_ITEMS);
  const name = uniqueLibraryName();
  libraryFiles.names.push(name);
  const file = libraryFileContent();
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/library-files") uploads.push(request.url());
  });

  // Add: each check's words first, and the browser's own refusal of a file over 10 MiB.
  await page.getByRole("button", { name: "New File", exact: true }).click();
  const created = page.getByRole("dialog", { name: "New Library File" });
  await created.getByRole("button", { name: "Create", exact: true }).click();
  await expect(created.getByRole("alert")).toHaveText(["Please enter a name.", "Please choose a file."]);
  await created.getByLabel("Name", { exact: true }).fill(name);
  await created.getByLabel("Description", { exact: true }).fill("An e2e helper file");
  const fileInput = created.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: "e2e-too-large.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(created.getByRole("alert")).toHaveText(["File must be 10 MB or smaller."]);
  await created.getByRole("button", { name: "Create", exact: true }).click();
  expect(uploads).toEqual([]);
  await fileInput.setInputFiles(file);
  await expect(created.getByText(file.name, { exact: true })).toBeVisible();
  await expect(created.getByRole("alert")).toHaveCount(0);
  await created.getByRole("button", { name: "Create", exact: true }).click();

  await expect(created).toBeHidden();
  await expect(toastWith(page, "Library file created")).toBeVisible();
  const row = adminRow(page, name);
  await expect(row).toContainText("An e2e helper file");
  await expect(row).toContainText(file.name);
  expect(uploads).toHaveLength(1);
  const added = (await listLibraryFilesThroughApi(page.request)).find((listed) => listed.name === name);
  expect(added).toMatchObject({ name, description: "An e2e helper file", fileName: file.name, sizeBytes: file.buffer.length });

  // Edit: its name and description; its file stays.
  const renamed = uniqueLibraryName();
  libraryFiles.names.push(renamed);
  await row.getByRole("button", { name, exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit Library File" });
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(edit.locator('input[type="file"]')).toHaveCount(0);
  await edit.getByLabel("Name", { exact: true }).fill(renamed);
  await edit.getByLabel("Description", { exact: true }).fill("");
  await edit.getByRole("button", { name: "Save", exact: true }).click();

  await expect(edit).toBeHidden();
  await expect(toastWith(page, "Library file updated")).toBeVisible();
  await expect(adminRow(page, renamed)).toContainText(file.name);
  await expect(adminRow(page, name)).toHaveCount(0);
  expect((await listLibraryFilesThroughApi(page.request)).find((listed) => listed.id === added!.id)).toMatchObject({
    name: renamed,
    description: "",
    fileName: file.name,
  });

  // Delete, through its confirmation; the focus goes to New File.
  await adminRow(page, renamed).getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete Library File" });
  await expect(confirmation).toContainText(`Are you sure you want to delete "${renamed}"? This action cannot be undone.`);
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(confirmation).toBeHidden();
  await expect(toastWith(page, "Library file deleted")).toBeVisible();
  await expect(adminRow(page, renamed)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New File", exact: true })).toBeFocused();
  expect((await listLibraryFilesThroughApi(page.request)).some((listed) => listed.id === added!.id)).toBe(false);
  expect(errors).toEqual([]);
});

test("the sidebar's Learning opens /library; a member searches by name and description, and downloads a file, its bytes whole under its own name", async ({
  page,
  playwright,
  libraryFiles,
}) => {
  const errors = pageErrors(page);
  const { request } = await productAdminSession(playwright, PASSWORD, E2E_SAAS_WEB_URL);
  const marker = randomUUID();
  const first = { name: uniqueLibraryName(), description: `Logs sample ${marker}`, file: libraryFileContent() };
  const second = { name: uniqueLibraryName(), description: `Metrics sample ${marker}`, file: libraryFileContent() };
  libraryFiles.names.push(first.name, second.name);
  try {
    await createLibraryFileThroughApi(request, first);
    await createLibraryFileThroughApi(request, second);
  } finally {
    await request.dispose();
  }
  const member = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, member);

  await openLibraryFromSidebar(page);
  await expect(page).toHaveTitle("Library - Telflo");
  await expect(page.getByRole("link", { name: "Learning Telflo" })).toHaveAttribute("href", "https://docs.telflo.com/docs/learning/about");
  await expect(memberRow(page, first.name)).toContainText(first.description);
  await expect(memberRow(page, second.name)).toContainText(second.description);

  // Search: by the shared marker (both), by a description's word and the marker (one), by a name (one), case aside.
  const search = page.getByRole("searchbox");
  await search.fill(marker.toUpperCase());
  await expect(memberRow(page, first.name)).toBeVisible();
  await expect(memberRow(page, second.name)).toBeVisible();
  await search.fill(`metrics sample ${marker}`);
  await expect(memberRow(page, second.name)).toBeVisible();
  await expect(memberRow(page, first.name)).toHaveCount(0);
  await search.fill(first.name);
  await expect(memberRow(page, first.name)).toBeVisible();
  await expect(memberRow(page, second.name)).toHaveCount(0);
  await search.fill(`${marker}-nothing-like-it`);
  await expect(page.getByText("No files match your search.")).toBeVisible();
  await search.fill(first.name);

  // Download: the bytes read with the session, saved under the file's own name.
  const saved = await downloaded(page, () => memberRow(page, first.name).getByRole("button", { name: "Download" }).click());
  expect(saved.name).toBe(first.file.name);
  expect(saved.bytes.equals(first.file.buffer), "the download holds the file's bytes").toBe(true);
  await expect(page.getByText("Failed to download file")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Copy curl puts `curl -fL '<link>' -o '<name>'` on the clipboard under the page's own origin; the link downloads the file with no session, and is nowhere in the page", async ({
  page,
  context,
  playwright,
  browserName,
  libraryFiles,
}) => {
  const errors = pageErrors(page);
  const { request } = await productAdminSession(playwright, PASSWORD, E2E_SAAS_WEB_URL);
  const entry = { name: uniqueLibraryName(), description: "For curl", file: libraryFileContent() };
  libraryFiles.names.push(entry.name);
  try {
    await createLibraryFileThroughApi(request, entry);
  } finally {
    await request.dispose();
  }
  const member = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, member);
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openLibraryFromSidebar(page);
  await page.getByRole("searchbox").fill(entry.name);
  const row = memberRow(page, entry.name);

  await row.getByRole("button", { name: "Curl" }).click();

  // From the click on, the page may hold the link (it must not, but a break could put it there): every
  // check is taken as a boolean while it is open, and nothing that can fail runs until it is gone
  // (a failed assertion's error-context.md would hold the page's ARIA snapshot).
  let copiedShown = false;
  let copyFailed = true;
  let pageHoldsIt = true;
  let storageHoldsIt = true;
  let command = "";
  try {
    copiedShown = await row
      .getByRole("button", { name: "Copied" })
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    copyFailed = (await page.getByText("Failed to copy curl command").count()) > 0;
    const html = await page.content();
    pageHoldsIt = html.includes(LINK_PREFIX) || html.includes(LINK_ROUTE) || html.includes(COMMAND_START);
    const stored = await page.evaluate<string>("JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])");
    storageHoldsIt = stored.includes(LINK_PREFIX);
    // The reader page is closed as soon as the clipboard is read (clipboardText), before any assertion.
    command = await clipboardText(context, browserName).catch(() => "");
  } finally {
    // The page goes before anything can fail, even when a read above threw: nothing of it is left to snapshot.
    await page.goto("about:blank");
  }

  expect(pageHoldsIt, "the page holds no link or command").toBe(false);
  expect(storageHoldsIt, "browser storage holds no link").toBe(false);
  expect(copiedShown, "the row says Copied").toBe(true);
  expect(copyFailed, "no copy failure toasted").toBe(false);
  // The command's shape, checked by a boolean: the page's own origin, single quotes.
  const shape = new RegExp(
    `^${COMMAND_START} '(${escaped(E2E_SAAS_WEB_URL)}${LINK_PATH})' -o '${escaped(entry.file.name)}'$`,
  );
  const matched = shape.exec(command);
  expect(matched !== null, "the clipboard holds the curl command, its link under the page's own origin").toBe(true);
  const url = matched![1]!;

  // The link, fetched as a host's curl would: no cookie, no session, nothing printed if it fails.
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual" });
  } catch {
    throw new Error("Fetching the library link failed.");
  }
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  const body = Buffer.from(await response.arrayBuffer());
  expect(body.equals(entry.file.buffer), "the link downloads the file's bytes").toBe(true);
  expect(errors).toEqual([]);
});
