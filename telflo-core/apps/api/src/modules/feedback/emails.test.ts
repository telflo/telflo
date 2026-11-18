import { describe, expect, it } from "vitest";
import {
  buildFeedbackAdminEmail,
  buildFeedbackReplyEmail,
  FEEDBACK_ADMIN_EMAIL_SUBJECT,
  FEEDBACK_REPLY_EMAIL_SUBJECT,
  feedbackReviewUrl,
} from "./emails.js";

/*
 * User Feedback's emails (D29 decisions 35 and 43): their fixed subjects
 * and words; every inserted value escaped in the HTML part; the admins'
 * email built from the sender's address and the link alone (it is never
 * given the text); the reply's line breaks kept. The values here are made
 * up for the test.
 */

const SENDER = "sender@example.com";
const REVIEW_URL = "http://localhost:56898/product-admin/user-feedback";

describe("buildFeedbackAdminEmail", () => {
  it("has its subject and words: Hi, the request, who asked, the Review Request link", () => {
    const email = buildFeedbackAdminEmail({ senderEmail: SENDER, reviewUrl: REVIEW_URL });
    expect(email.subject).toBe(FEEDBACK_ADMIN_EMAIL_SUBJECT);
    expect(email.subject).toBe("Telflo - New User Feedback Request");
    expect(email.text).toBe(
      [
        "Hi,",
        "",
        "A new User Feedback request has been submitted.",
        "",
        `Requested by: ${SENDER}`,
        "",
        `Review Request: ${REVIEW_URL}`,
      ].join("\n"),
    );
    expect(email.html).toContain("<strong>User Feedback</strong> request has been submitted.");
    expect(email.html).toContain(`<strong>Requested by:</strong> ${SENDER}`);
    expect(email.html).toContain(`<a href="${REVIEW_URL}">Review Request</a>`);
  });

  it("escapes the sender's address and the link in the HTML part", () => {
    const email = buildFeedbackAdminEmail({ senderEmail: `"<b>x</b>"@example.com`, reviewUrl: `${REVIEW_URL}?a=1&b="2"` });
    expect(email.html).toContain("&quot;&lt;b&gt;x&lt;/b&gt;&quot;@example.com");
    expect(email.html).toContain(`href="${REVIEW_URL}?a=1&amp;b=&quot;2&quot;"`);
    expect(email.html.includes("<b>x</b>")).toBe(false);
  });

  it("is built from the address and the link alone: no field can carry the feedback's text", () => {
    const email = buildFeedbackAdminEmail({ senderEmail: SENDER, reviewUrl: REVIEW_URL });
    // Every word of the email is one of these or the two values given.
    const fixed = ["Hi,", "A new User Feedback request has been submitted.", "Requested by:", "Review Request"];
    const rest = fixed.reduce((text, word) => text.replaceAll(word, ""), email.text).replaceAll(SENDER, "").replaceAll(REVIEW_URL, "");
    expect(rest.trim().replace(/[\s:]+/g, "")).toBe("");
  });
});

describe("buildFeedbackReplyEmail", () => {
  it("has its subject: Hi, then the reply, its line breaks kept", () => {
    const email = buildFeedbackReplyEmail({ reply: "Thank you.\nWe added it.\r\n\r\nThe team" });
    expect(email.subject).toBe(FEEDBACK_REPLY_EMAIL_SUBJECT);
    expect(email.subject).toBe("Telflo - Thank You for Your Feedback");
    expect(email.text).toBe("Hi,\n\nThank you.\nWe added it.\n\nThe team");
    expect(email.html).toContain("Thank you.<br>We added it.<br><br>The team");
  });

  it("escapes the reply in the HTML part", () => {
    const email = buildFeedbackReplyEmail({ reply: `<script>alert("x")</script> & 'more'` });
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;more&#39;");
    expect(email.html.includes("<script>")).toBe(false);
  });
});

describe("feedbackReviewUrl", () => {
  it("is the public web URL's User Feedback page, a trailing slash or none", () => {
    expect(feedbackReviewUrl("https://app.telflo.example")).toBe("https://app.telflo.example/product-admin/user-feedback");
    expect(feedbackReviewUrl("https://app.telflo.example/")).toBe("https://app.telflo.example/product-admin/user-feedback");
  });
});
