import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { open } from "./editor-page.js";
import { developerEnv } from "./environment.js";

// User Feedback in the browser (D29 decisions 6, 32 to 35, 37, 40 and 45;
// Preflight ruling 18): "Contact us" in the sidebar, product admin's User
// Feedback page, and the two emails in Mailpit.
//
// Feedback is global: every product admin sees every worker's items, and
// every product admin is emailed about each. So a test sends its own marked
// text (`uniqueFeedbackText`), finds its own row by that text ("Load more"
// until it shows), handles only its own rows, reads the pending count as an
// integer (never an exact one), and reads the admins' email at its own
// admin's address, about its own sender.

export const FEEDBACK_ADMIN_EMAIL_SUBJECT = "Telflo - New User Feedback Request";
export const FEEDBACK_REPLY_EMAIL_SUBJECT = "Telflo - Thank You for Your Feedback";

/** A message no other test sends: a made-up marker, never anyone's words. */
export function uniqueFeedbackText(): string {
  return `e2e-feedback-${randomUUID()}`;
}

/** Sends `text` as "Contact us" does, as the page's session (in its active organization). */
export async function sendFeedbackThroughApi(page: Page, text: string): Promise<string> {
  const response = await page.request.post("/api/v1/feedback", { data: { text }, headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** The sidebar's "Contact us" dialog. */
export function contactUsDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Contact Us" });
}

/** Opens the User Feedback page directly and waits for its first read. */
export async function openUserFeedbackAdmin(page: Page): Promise<void> {
  await open(page, "/product-admin/user-feedback");
  await expect(page.getByRole("heading", { level: 1, name: "Pending User Feedback", exact: true })).toBeVisible();
  await expect(page.getByText("Loading feedback...")).toHaveCount(0);
}

/** The table row holding `text` (a test's own marker). */
export function feedbackRow(page: Page, text: string): Locator {
  return page.getByRole("row").filter({ hasText: text });
}

/** The row holding `text`, reading "Load more" until it shows (other workers' newer items may push it down). */
export async function findFeedbackRow(page: Page, text: string): Promise<Locator> {
  const row = feedbackRow(page, text);
  const loadMore = page.getByRole("button", { name: "Load more", exact: true });
  for (let pages = 0; pages < 40 && (await row.count()) === 0; pages += 1) {
    if ((await loadMore.count()) === 0) break;
    // The next page's answer, before looking again (never a check against the rows of the page before).
    const answered = page.waitForResponse(
      (response) => response.request().method() === "GET" && /\/api\/v1\/product-admin\/feedback\?cursor=/.test(response.url()),
    );
    await loadMore.click();
    await answered;
    await expect(page.getByRole("button", { name: "Loading…", exact: true })).toHaveCount(0);
  }
  await expect(row).toHaveCount(1);
  return row;
}

/** The nav's pending count, as the User Feedback item's text reads it ("User Feedback 3" → 3); null when it shows none. */
export async function pendingFeedbackCount(page: Page): Promise<number | null> {
  const item = page
    .getByRole("navigation")
    .filter({ has: page.getByRole("button", { name: "Test Templates", exact: true }) })
    .getByRole("button")
    .first();
  const text = ((await item.textContent()) ?? "").trim();
  const match = /^User Feedback\s*(\d+)$/.exec(text);
  return match === null ? null : Number(match[1]);
}

interface MailpitSearchResult {
  messages: { ID: string }[];
}

async function mailpitJson<T>(path: string): Promise<T> {
  const base = developerEnv().TELFLO_MAILPIT_API_URL || "http://localhost:58025";
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`Mailpit answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The texts of the admins' emails to `admin` that name `sender` (each new
 * item's email names its sender: decision 35), polled for up to ten seconds
 * until at least one has come. Another worker's items email every admin
 * too, so the sender narrows them to this test's. The error names neither
 * address.
 */
export async function adminEmailsAbout(admin: string, sender: string): Promise<string[]> {
  const query = encodeURIComponent(`to:"${admin}" subject:"${FEEDBACK_ADMIN_EMAIL_SUBJECT}" "${sender}"`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { messages } = await mailpitJson<MailpitSearchResult>(`/api/v1/search?query=${query}`);
    if (messages.length > 0) {
      return Promise.all(messages.map(async (message) => (await mailpitJson<{ Text: string }>(`/api/v1/message/${message.ID}`)).Text));
    }
    if (Date.now() >= deadline) throw new Error("no new-feedback email reached the test's admin within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
