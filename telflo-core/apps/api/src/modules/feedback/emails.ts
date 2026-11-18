import { escapeHtml } from "../identity/emails.js";

/*
 * User Feedback's two emails (D29 decision 35), plain text and HTML, every
 * inserted value escaped in the HTML part.
 *
 * - To each product admin, separately, about a new item: the sender's email
 *   and a link to the page. NEVER the feedback's text (decision 6): the
 *   builder isn't given it.
 * - To the sender, when a product admin acknowledges their item: the
 *   admin's reply, its line breaks kept. The reply is never stored and goes
 *   to this one recipient only.
 */

export interface FeedbackEmail {
  subject: string;
  text: string;
  html: string;
}

/** The subjects (decision 35). */
export const FEEDBACK_ADMIN_EMAIL_SUBJECT = "Telflo - New User Feedback Request";
export const FEEDBACK_REPLY_EMAIL_SUBJECT = "Telflo - Thank You for Your Feedback";

/** Where the link goes: the product admins' User Feedback page. */
export function feedbackReviewUrl(publicWebUrl: string): string {
  return `${publicWebUrl.replace(/\/+$/, "")}/product-admin/user-feedback`;
}

/** A new item, to one product admin: who sent it, and where to review it. Takes no text, so it can hold none. */
export function buildFeedbackAdminEmail(input: { senderEmail: string; reviewUrl: string }): FeedbackEmail {
  const safeSender = escapeHtml(input.senderEmail);
  const safeUrl = escapeHtml(input.reviewUrl);
  return {
    subject: FEEDBACK_ADMIN_EMAIL_SUBJECT,
    text: [
      "Hi,",
      "",
      "A new User Feedback request has been submitted.",
      "",
      `Requested by: ${input.senderEmail}`,
      "",
      `Review Request: ${input.reviewUrl}`,
    ].join("\n"),
    html: [
      '<div style="font-family: sans-serif; max-width: 600px;">',
      '  <p style="margin: 0 0 8px;">Hi,</p>',
      '  <p style="margin: 0 0 8px;">A new <strong>User Feedback</strong> request has been submitted.</p>',
      `  <p style="margin: 0 0 24px;"><strong>Requested by:</strong> ${safeSender}</p>`,
      `  <p style="margin: 0;"><a href="${safeUrl}">Review Request</a></p>`,
      "</div>",
    ].join("\n"),
  };
}

/** An acknowledgement, to the sender: "Hi," then the admin's reply, its line breaks kept. */
export function buildFeedbackReplyEmail(input: { reply: string }): FeedbackEmail {
  const lines = input.reply.split(/\r\n|\r|\n/);
  return {
    subject: FEEDBACK_REPLY_EMAIL_SUBJECT,
    text: ["Hi,", "", ...lines].join("\n"),
    html: [
      '<div style="font-family: sans-serif; max-width: 600px;">',
      '  <p style="margin: 0 0 16px;">Hi,</p>',
      `  <p style="margin: 0 0 8px;">${lines.map(escapeHtml).join("<br>")}</p>`,
      "</div>",
    ].join("\n"),
  };
}
