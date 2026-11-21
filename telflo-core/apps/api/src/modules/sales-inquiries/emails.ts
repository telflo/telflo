import { escapeHtml } from "../identity/emails.js";

/**
 * A contact form inquiry, sent to the team's inbox.
 * An HTML part and a text part. Every value is the submitter's free text,
 * so each is escaped in the HTML part. The subject replaces runs of CR and
 * LF in the name with a space, so the name can't break the header onto
 * another line.
 */
export function buildSalesInquiryEmail(input: { name: string; email: string; message: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeName = escapeHtml(input.name);
  const safeEmail = escapeHtml(input.email);
  const safeMessage = escapeHtml(input.message);
  return {
    subject: `Pricing inquiry from ${input.name.replace(/[\r\n]+/g, " ")}`,
    text: [
      `${input.name} <${input.email}>`,
      "via the contact form",
      "",
      input.message,
      "",
      "Reply to this email to answer them directly.",
    ].join("\n"),
    html: [
      '<div style="font-family: sans-serif; max-width: 600px;">',
      `  <p style="margin: 0 0 4px;"><strong>${safeName}</strong> &lt;${safeEmail}&gt;</p>`,
      '  <p style="margin: 0 0 16px; color: #666;">via the contact form</p>',
      `  <div style="border-left: 3px solid #ddd; padding: 4px 0 4px 12px; white-space: pre-wrap;">${safeMessage}</div>`,
      '  <p style="margin: 16px 0 0; color: #666;">Reply to this email to answer them directly.</p>',
      "</div>",
    ].join("\n"),
  };
}
