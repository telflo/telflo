import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { grantProductAdmin, revokeProductAdmin, seedUser, type SeededUser } from "./support/database.js";
import { open } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import {
  adminEmailsAbout,
  contactUsDialog,
  FEEDBACK_REPLY_EMAIL_SUBJECT,
  feedbackRow,
  findFeedbackRow,
  openUserFeedbackAdmin,
  pendingFeedbackCount,
  sendFeedbackThroughApi,
  uniqueFeedbackText,
} from "./support/feedback-admin-page.js";
import { emailSubjectsTo, waitForEmail } from "./support/mail.js";
import { maskedPlacesOf, within } from "./support/privacy.js";
import { signInThroughApi } from "./support/session.js";
import { toastWith } from "./support/validation-pipelines-page.js";

// User Feedback (D29 decisions 6, 32 to 35, 37, 40, 41 and 45; Preflight
// ruling 18), in the browser: a member sends feedback from "Contact us"; a
// product admin of the test's own finds it (by its marked text, "Load more"
// until it shows), sees the nav's pending count as an integer ≥ 1, and
// acknowledges it with an edited reply (the reply's email reaches the
// member through Mailpit) or dismisses it (no email). The admins' email is
// read at the test's own admin's address, about the test's own sender: it
// names the sender and never holds the text (a boolean).
//
// - Feedback and its admins' emails are global: parallel workers' items
//   share the list and the count, and every admin is emailed about each.
//   Each test handles only its own rows, asserts the count as ≥ 1, never an
//   exact count or the empty state.
// - The member's email and the feedback's text are another person's data on
//   the admin's page (decision 41): privacy checks collect, go to
//   about:blank, then assert (counts only). Synthetic `e2e-<uuid>` addresses
//   and markers in a failed run's messages are Preflight ruling 18's
//   accepted residue.
// - Each test revokes the product admins it made, however it ends.

const PASSWORD = "correct horse battery staple";

/** `admins`: the emails of the product admins a test made, revoked when it ends. `adminContext`: the admin's own browser. */
const test = base.extend<{ admins: string[]; adminContext: BrowserContext }>({
  // eslint-disable-next-line no-empty-pattern
  admins: async ({}, use) => {
    const made: string[] = [];
    await use(made);
    for (const email of made) await revokeProductAdmin(email);
  },
  adminContext: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: E2E_WEB_URL, viewport: { width: 1440, height: 1000 } });
    await use(context);
    await context.close();
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

/** A product admin of the test's own, signed in on `page`, revoked when the test ends. */
async function signedInProductAdmin(page: Page, admins: string[]): Promise<SeededUser> {
  const admin = await seedUser({ password: PASSWORD });
  await grantProductAdmin(admin.email);
  admins.push(admin.email);
  await signInThroughApi(page, admin);
  return admin;
}

/** A member signed in on `page`, in their personal organization. */
async function signedInMember(page: Page): Promise<SeededUser> {
  const member = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, member);
  return member;
}

test("a member sends feedback from Contact us; a product admin finds it, the count ≥ 1, the admins' email naming the sender without the text, and acknowledges it with an edited reply that reaches the member", async ({
  page,
  adminContext,
  admins,
}) => {
  const adminPage = await adminContext.newPage();
  const admin = await signedInProductAdmin(adminPage, admins);
  const member = await signedInMember(page);
  const text = uniqueFeedbackText();

  // The member: Contact us, the message, Send.
  await open(page, "/app");
  await page.getByRole("button", { name: "Contact us", exact: true }).click();
  const dialog = contactUsDialog(page);
  await expect(dialog).toBeVisible();
  const send = dialog.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Message" }).fill(`  ${text}\nA second line.  `);
  // The typed words: in no attribute (the box is uncontrolled), inside ph-no-capture only.
  const typed = await within(maskedPlacesOf(page, [text]), 5_000, [{ masked: -1, unmasked: -1, inAttributes: -1 }]);
  await send.click();
  await expect(toastWith(page, "Thanks for your feedback!")).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(typed[0]!.inAttributes).toBe(0);

  // The admin: the count, the row, the full text.
  await openUserFeedbackAdmin(adminPage);
  expect(await pendingFeedbackCount(adminPage)).toBeGreaterThanOrEqual(1);
  const row = await findFeedbackRow(adminPage, text);
  await row.getByRole("button", { name: new RegExp(`^${text}`) }).click();
  const full = adminPage.getByRole("dialog", { name: "Feedback" });
  await expect(full).toBeVisible();
  const shown = await within(maskedPlacesOf(adminPage, [member.email, text, "A second line."]), 5_000, []);
  await adminPage.keyboard.press("Escape");
  await expect(full).toBeHidden();

  // Acknowledge, with an edited reply.
  const replyMarker = uniqueFeedbackText().replace("e2e-feedback-", "e2e-reply-");
  await row.getByRole("button", { name: /^Acknowledge / }).click();
  const acknowledge = adminPage.getByRole("dialog", { name: "Acknowledge Feedback" });
  await expect(acknowledge.getByText("Edit the response below. This will be emailed to the user.")).toBeVisible();
  await acknowledge.getByRole("textbox", { name: "Response" }).fill(`Thanks for writing.\n${replyMarker}`);
  await acknowledge.getByRole("button", { name: "Ok", exact: true }).click();
  await expect(toastWith(adminPage, "Feedback acknowledged")).toBeVisible();
  await expect(acknowledge).toBeHidden();
  await expect(feedbackRow(adminPage, text)).toHaveCount(0);
  await adminPage.goto("about:blank");

  // Every place the member's email and text showed on the admin's page: masked text, no attribute.
  expect(shown.length).toBe(3);
  for (const places of shown)
    expect({ unmasked: places.unmasked, inAttributes: places.inAttributes, shown: places.masked > 0 }).toEqual({
      unmasked: 0,
      inAttributes: 0,
      shown: true,
    });

  // The admins' email, at the test's admin's address, about this member: never the text.
  const adminEmails = await adminEmailsAbout(admin.email, member.email);
  expect(adminEmails.some((body) => body.includes(text) || body.includes("A second line."))).toBe(false);
  expect(adminEmails.every((body) => body.includes(`Requested by: ${member.email}`) && body.includes("/product-admin/user-feedback"))).toBe(
    true,
  );

  // The reply's email, to the member: the edited reply, its line break kept.
  const reply = await waitForEmail({ to: member.email, subject: FEEDBACK_REPLY_EMAIL_SUBJECT });
  // SMTP carries the line break as CRLF.
  expect(reply.includes(`Thanks for writing.\r\n${replyMarker}`) || reply.includes(`Thanks for writing.\n${replyMarker}`)).toBe(true);
});

test("a product admin dismisses a member's feedback: \"Feedback dismissed\", the row gone, the focus on a row's action or the heading, no email to the member", async ({
  page,
  adminContext,
  admins,
}) => {
  const adminPage = await adminContext.newPage();
  await signedInProductAdmin(adminPage, admins);
  const member = await signedInMember(page);
  const text = uniqueFeedbackText();
  await sendFeedbackThroughApi(page, text);

  await openUserFeedbackAdmin(adminPage);
  const row = await findFeedbackRow(adminPage, text);
  // From the keyboard (Ruling 273): WebKit, as Safari, doesn't focus a button on a mouse click, so only a
  // keyboard press makes the row hold the focus in every browser; it pins the keyboard path too.
  const dismiss = row.getByRole("button", { name: /^Dismiss / });
  await dismiss.focus();
  await adminPage.keyboard.press("Enter");
  await expect(toastWith(adminPage, "Feedback dismissed")).toBeVisible();
  await expect(feedbackRow(adminPage, text)).toHaveCount(0);
  // Where the focus went with the row (Ruling 272): another row's Acknowledge or Dismiss, or the heading, never the body.
  // Collected as a boolean (the rows may be other workers' people), asserted on about:blank below.
  const focusFollowed = await adminPage.evaluate(`(() => {
    const active = document.activeElement;
    if (active === null) return false;
    if (active.tagName === "H1") return active.textContent === "Pending User Feedback";
    return active.tagName === "BUTTON" && /-(acknowledge|dismiss)$/.test(active.id) && active.closest("tbody") !== null;
  })()`);
  // Read again from the API: still gone.
  await openUserFeedbackAdmin(adminPage);
  const stillListed = await adminPage.getByRole("row").filter({ hasText: text }).count();
  await adminPage.goto("about:blank");
  expect(stillListed).toBe(0);
  expect(focusFollowed, "the focus on a row's action or the heading after the Dismiss").toBe(true);
  expect((await emailSubjectsTo(member.email)).includes(FEEDBACK_REPLY_EMAIL_SUBJECT)).toBe(false);
});

test("Contact us is in every signed-in person's rail, after Docs; a member who isn't a product admin can't open User Feedback", async ({
  page,
}) => {
  await signedInMember(page);
  await open(page, "/app");
  const contactUs = page.getByRole("button", { name: "Contact us", exact: true });
  await expect(contactUs).toBeVisible();
  await contactUs.click();
  await expect(contactUsDialog(page)).toBeVisible();
  await contactUsDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(contactUsDialog(page)).toBeHidden();

  await page.goto("/product-admin/user-feedback");
  await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
});
