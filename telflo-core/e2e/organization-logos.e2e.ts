import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, CurrentUserResponseSchema } from "@telflo/contracts";
import { addMember, seedUser } from "./support/database.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { signInThroughApi, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";

// Organization logos (D23-2 decisions 2, 3, 8, 9, 51, 52 and 57), in the
// browser: set in Create organization, shown in the sidebar's switcher and on
// the Settings card, replaced and removed in Edit, seen by a contributor (no
// Edit), and an SVG refused. The logos are REAL decodable PNGs, built below
// (a file with the PNG signature alone passes the type check but fails to
// decode, and the <img> would fall back to the initials: Preflight ruling 22).

const PASSWORD = "correct horse battery staple";

/**
 * `secondContext`: a second browser, for a second person, with its own
 * cookie jar. Closed when the test ends.
 */
const test = base.extend<{ secondContext: BrowserContext }>({
  secondContext: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: E2E_WEB_URL });
    await use(context);
    await context.close();
  },
});

// --- A real PNG -------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** A `size`×`size` PNG of one colour (8-bit RGB, no interlace): one any browser decodes. */
function solidPng(size: number, [red, green, blue]: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + size * 3); // filter byte 0, then the pixels
  for (let x = 0; x < size; x += 1) row.set([red, green, blue], 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const BLUE_LOGO = { name: "blue-logo.png", mimeType: "image/png", buffer: solidPng(16, [30, 90, 200]) };
const ORANGE_LOGO = { name: "orange-logo.png", mimeType: "image/png", buffer: solidPng(24, [240, 130, 20]) };
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');

// --- The page ---------------------------------------------------------------

/** A full page load of `path`, hydrated, and the logo-address invariant checked over the whole document. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
  await expectLogoAddressOnlyInCapturedImages(page);
}

function switcher(page: Page): Locator {
  return page.getByTitle("Switch organization");
}

/** The Settings › Organization card titled `name`. */
function card(page: Page, name: string): Locator {
  return page.locator(".rounded-lg").filter({ has: page.getByRole("heading", { level: 3, name, exact: true }) });
}

/** An `<img>`'s load state (e2e/ compiles without the DOM's types). */
interface Decoding {
  complete: boolean;
  naturalWidth: number;
}

/** The little of the DOM the invariant reads (e2e/ compiles without the DOM's types). */
interface InvariantElement {
  tagName: string;
  classList: { contains(name: string): boolean };
  attributes: ArrayLike<{ name: string; value: string }>;
}
interface InvariantDocument {
  querySelectorAll(selector: string): ArrayLike<InvariantElement>;
  createTreeWalker(root: unknown, whatToShow: number): { nextNode(): { nodeValue: string | null } | null };
}

/**
 * A logo's address appears ONLY as the src of an `<img>` inside
 * `ph-no-capture` (Rulings 137, 140 and 152), over the WHOLE document,
 * `<head>` and `<body>`: every attribute of every element (an href, a
 * `<link>` preload's imagesrcset, a data-* attribute, an inline style's
 * url(…), any other) and every text node (`<style>` and `<script>` text
 * included) is read, and `organization-logos`, in any case, may appear only
 * in the src or srcset of an `img.ph-no-capture`. Replay records any of the
 * others. Checked as booleans: a failure prints no address.
 */
async function expectLogoAddressOnlyInCapturedImages(page: Page): Promise<void> {
  const { everyAttributeIsACapturedImageSource, noTextNamesALogo } = await page.evaluate(() => {
    const root = (globalThis as unknown as { document: InvariantDocument }).document;
    const namesALogo = (text: string | null) => text !== null && text.toLowerCase().includes("organization-logos");
    const elements = Array.from(root.querySelectorAll("*"));
    const attributesClean = elements.every((element) =>
      Array.from(element.attributes).every(
        (attribute) =>
          (!namesALogo(attribute.name) && !namesALogo(attribute.value)) ||
          ((attribute.name === "src" || attribute.name === "srcset") &&
            element.tagName === "IMG" &&
            element.classList.contains("ph-no-capture")),
      ),
    );
    // NodeFilter.SHOW_TEXT: every text node, a <style>'s and a <script>'s among them.
    const walker = root.createTreeWalker(root, 4);
    let textClean = true;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (namesALogo(node.nodeValue)) textClean = false;
    }
    return { everyAttributeIsACapturedImageSource: attributesClean, noTextNamesALogo: textClean };
  });
  expect(everyAttributeIsACapturedImageSource).toBe(true);
  expect(noTextNamesALogo).toBe(true);
}

/**
 * A logo shown as decision 57 says (an `<img alt="">` blocked from replay, by
 * ids) and decoded by the browser: `naturalWidth` is 0 for an image that
 * failed, so the boolean says the bytes really are an image.
 */
async function expectLogoShown(image: Locator): Promise<string> {
  await expect(image).toBeVisible();
  await expectLogoAddressOnlyInCapturedImages(image.page());
  await expect(image).toHaveAttribute("alt", "");
  await expect(image).toHaveClass(/(^|\s)ph-no-capture(\s|$)/);
  // Whether the image loaded and decoded: a failed image is complete with
  // `naturalWidth` 0. (Runs in the page: nothing from this file is in scope.)
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const decoding = element as unknown as Decoding;
        return decoding.complete && decoding.naturalWidth > 0;
      }),
    )
    .toBe(true);
  const src = await image.getAttribute("src");
  expect(src).toMatch(/^\/api\/v1\/organization-logos\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  return src!;
}

/** Picks `file` in the dialog's hidden input, past its accept list (the dialog's own check is what counts). */
async function pickLogo(dialog: Locator, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await dialog.locator('input[type="file"]').setInputFiles(file);
}

/** The dialog's preview image (an object URL while a file is picked). */
function preview(dialog: Locator): Locator {
  return dialog.locator("img");
}

async function editDialog(page: Page, name: string): Promise<Locator> {
  await card(page, name).getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Organization" });
  await expect(dialog).toBeVisible();
  return dialog;
}

// --- The tests --------------------------------------------------------------

test("an admin sets a logo in Create organization, sees it in the switcher and on the card, replaces it, then removes it", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const suffix = randomUUID();
  const name = `Logo ${suffix}`;
  const initials = `L${suffix.charAt(0).toUpperCase()}`;
  await signInThroughApi(page, user);
  await open(page, "/settings/organization");

  // Create, with the logo in the same request.
  await page.getByRole("button", { name: "Create Organization" }).click();
  const create = page.getByRole("dialog", { name: "Create Organization" });
  await create.getByLabel("Organization Name").fill(name);
  await pickLogo(create, BLUE_LOGO);
  await expect(preview(create)).toHaveAttribute("src", /^blob:/);
  await expect(create.getByText(BLUE_LOGO.name)).toBeVisible();
  await expect(create.getByRole("button", { name: "Change Image" })).toBeVisible();
  await create.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page).toHaveURL("/app");
  await expect(switcher(page)).toContainText(name);
  const firstSrc = await expectLogoShown(switcher(page).locator("img"));

  // Full loads, server-rendered with the logo: its address only in the <img>
  // (open checks the invariant over the whole document).
  await open(page, "/app");
  expect(await expectLogoShown(switcher(page).locator("img"))).toBe(firstSrc);
  await open(page, "/settings/organization");
  expect(await expectLogoShown(card(page, name).locator("img"))).toBe(firstSrc);

  // Replace: a new logo id; the old address answers 404 once the change is committed.
  const replace = await editDialog(page, name);
  await expect(preview(replace)).toHaveAttribute("src", firstSrc);
  await pickLogo(replace, ORANGE_LOGO);
  await expect(preview(replace)).toHaveAttribute("src", /^blob:/);
  await replace.getByRole("button", { name: "Save" }).click();
  await expect(replace).toBeHidden();

  const secondSrc = await expectLogoShown(card(page, name).locator("img"));
  expect(secondSrc).not.toBe(firstSrc);
  expect(await expectLogoShown(switcher(page).locator("img"))).toBe(secondSrc);
  expect((await page.request.get(firstSrc)).status()).toBe(404);
  const served = await page.request.get(secondSrc);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/png");
  expect(Buffer.compare(await served.body(), ORANGE_LOGO.buffer)).toBe(0);

  // Remove: the initials everywhere, and the bytes gone.
  const remove = await editDialog(page, name);
  await remove.getByRole("button", { name: "Remove logo" }).click();
  await expect(preview(remove)).toHaveCount(0);
  await remove.getByRole("button", { name: "Save" }).click();
  await expect(remove).toBeHidden();

  await expect(card(page, name).locator("img")).toHaveCount(0);
  await expect(card(page, name).getByText(initials, { exact: true })).toBeVisible();
  await expect(switcher(page).locator("img")).toHaveCount(0);
  expect((await page.request.get(secondSrc)).status()).toBe(404);

  // A fresh load (the layout's /me) agrees.
  await open(page, "/settings/organization");
  await expect(card(page, name).locator("img")).toHaveCount(0);
  await expect(switcher(page).locator("img")).toHaveCount(0);
});

test("a contributor sees the organization's logo in the switcher and on the card, with no Edit", async ({ page, secondContext }) => {
  const admin = await seedUser({ password: PASSWORD });
  const member = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  await addMember({ userId: member.userId, organizationId: group.organizationId, role: "contributor" });
  await signInThroughApi(page, admin);
  await switchOrganizationThroughApi(page, group.organizationId);
  await open(page, "/settings/organization");

  const dialog = await editDialog(page, group.organizationName);
  await pickLogo(dialog, BLUE_LOGO);
  await expect(preview(dialog)).toHaveAttribute("src", /^blob:/);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const src = await expectLogoShown(card(page, group.organizationName).locator("img"));

  const memberPage = await secondContext.newPage();
  await signInThroughApi(memberPage, member);
  await switchOrganizationThroughApi(memberPage, group.organizationId);
  await open(memberPage, "/settings/organization");

  expect(await expectLogoShown(card(memberPage, group.organizationName).locator("img"))).toBe(src);
  expect(await expectLogoShown(switcher(memberPage).locator("img"))).toBe(src);
  await expect(memberPage.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(memberPage.locator('input[type="file"]')).toHaveCount(0);
});

test("an SVG is refused: by the dialog before sending, and by the API when sent anyway (typed from its bytes), creating nothing", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const name = `Svg ${randomUUID()}`;
  await signInThroughApi(page, user);
  await open(page, "/settings/organization");

  await page.getByRole("button", { name: "Create Organization" }).click();
  const create = page.getByRole("dialog", { name: "Create Organization" });
  await create.getByLabel("Organization Name").fill(name);
  let sent = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/organizations") sent += 1;
  });

  await pickLogo(create, { name: "logo.svg", mimeType: "image/svg+xml", buffer: SVG });
  await expect(create.getByRole("alert")).toHaveText("Logo must be a PNG, JPG or WebP image.");
  await expect(preview(create)).toHaveCount(0);
  // Named .png and typed image/png by the browser: still SVG by its bytes.
  await pickLogo(create, { name: "logo.png", mimeType: "image/png", buffer: SVG });
  await expect(create.getByRole("alert")).toHaveText("Logo must be a PNG, JPG or WebP image.");
  await expect(preview(create)).toHaveCount(0);
  expect(sent).toBe(0);

  // Past the browser's check, the API refuses the same bytes, before any write.
  const refused = await page.request.post("/api/v1/organizations", {
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    multipart: { name, file: { name: "logo.png", mimeType: "image/png", buffer: SVG } },
  });
  expect(refused.status()).toBe(415);
  expect((await refused.json()) as unknown).toMatchObject({ error: { code: "organization_logo_type_unsupported" } });

  const me = CurrentUserResponseSchema.parse(await (await page.request.get("/api/v1/auth/me")).json());
  expect(me.organizations.map((organization) => organization.name)).not.toContain(name);
});
