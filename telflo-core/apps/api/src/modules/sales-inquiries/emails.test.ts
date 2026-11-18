import { describe, expect, it } from "vitest";
import { buildSalesInquiryEmail } from "./emails.js";

const inquiry = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  message: "We run about 400 collectors.\nCan we talk?",
};

describe("buildSalesInquiryEmail", () => {
  it("has its subject", () => {
    expect(buildSalesInquiryEmail(inquiry).subject).toBe("Pricing inquiry from Ada Lovelace");
  });

  it("replaces runs of CR and LF in the name with one space in the subject", () => {
    const email = buildSalesInquiryEmail({ ...inquiry, name: "Ada\r\n\r\nBcc: victim@example.com\nLovelace" });
    expect(email.subject).toBe("Pricing inquiry from Ada Bcc: victim@example.com Lovelace");
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it("carries the name, email and message in the text part", () => {
    expect(buildSalesInquiryEmail(inquiry).text).toBe(
      [
        "Ada Lovelace <ada@example.com>",
        "via the contact form",
        "",
        "We run about 400 collectors.\nCan we talk?",
        "",
        "Reply to this email to answer them directly.",
      ].join("\n"),
    );
  });

  it("lays out the HTML part", () => {
    const { html } = buildSalesInquiryEmail(inquiry);
    expect(html).toContain("<p style=\"margin: 0 0 4px;\"><strong>Ada Lovelace</strong> &lt;ada@example.com&gt;</p>");
    expect(html).toContain("via the contact form");
    expect(html).toContain(
      '<div style="border-left: 3px solid #ddd; padding: 4px 0 4px 12px; white-space: pre-wrap;">We run about 400 collectors.\nCan we talk?</div>',
    );
    expect(html).toContain("Reply to this email to answer them directly.");
  });

  it.each(["name", "email", "message"] as const)("escapes <script> in the %s in the HTML part", (field) => {
    const email = buildSalesInquiryEmail({ ...inquiry, [field]: `<script>alert("x")</script>` });
    expect(email.html).not.toContain("<script");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("escapes ampersands and single quotes too", () => {
    const { html } = buildSalesInquiryEmail({ ...inquiry, message: "Tom & Jerry's fleet" });
    expect(html).toContain("Tom &amp; Jerry&#39;s fleet");
  });

  it("leaves the text part as it was submitted", () => {
    const message = `<script>alert("x")</script> & more`;
    expect(buildSalesInquiryEmail({ ...inquiry, message }).text).toContain(message);
  });
});
