import { describe, expect, it } from "vitest";
import { buildInvitationEmail } from "./emails.js";

describe("buildInvitationEmail", () => {
  const acceptUrl = "https://app.telflo.local/accept-invitation#token=abc123";

  it("has the invitation's subject and lines, in order, in the text part", () => {
    const email = buildInvitationEmail({ organizationName: "Acme Corp", organizationType: "group", acceptUrl });

    expect(email.subject).toBe("You've been invited to join Acme Corp on Telflo");
    expect(email.text).toBe(
      [
        "You've been invited to join Acme Corp on Telflo, the visual OpenTelemetry pipeline builder.",
        "",
        "Open this link to accept your invitation:",
        acceptUrl,
        "",
        "This link expires in 7 days.",
        "",
        "If you weren't expecting this invitation, you can ignore this email.",
      ].join("\n"),
    );
  });

  it("carries the same lines and the link in the HTML part", () => {
    const { html } = buildInvitationEmail({ organizationName: "Acme Corp", organizationType: "group", acceptUrl });

    expect(html).toContain(
      "<p>You've been invited to join Acme Corp on Telflo, the visual OpenTelemetry pipeline builder.</p>",
    );
    expect(html).toContain("<p>Open this link to accept your invitation:</p>");
    expect(html).toContain(`<a href="${acceptUrl}">`);
    expect(html).toContain("<p>This link expires in 7 days.</p>");
    expect(html).toContain("<p>If you weren't expecting this invitation, you can ignore this email.</p>");
  });

  it("has no account footer, since an invitee may have no account", () => {
    const email = buildInvitationEmail({ organizationName: "Acme Corp", organizationType: "group", acceptUrl });
    expect(email.text).not.toContain("because you have a Telflo account");
    expect(email.html).not.toContain("because you have a Telflo account");
  });

  it("escapes an organization's name in the HTML part and leaves it as it is in the text", () => {
    const organizationName = "<img src=x onerror=alert(1)>";

    const email = buildInvitationEmail({ organizationName, organizationType: "group", acceptUrl });

    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.text).toContain(`join ${organizationName} on Telflo`);
    expect(email.subject).toBe(`You've been invited to join ${organizationName} on Telflo`);
  });

  it("names a personal workspace under its default name, its owner's email, as <email>'s organization in the subject and both parts", () => {
    const email = buildInvitationEmail({ organizationName: "someone@example.com", organizationType: "personal", acceptUrl });

    expect(email.subject).toBe("You've been invited to join someone@example.com's organization on Telflo");
    expect(email.text.split("\n")[0]).toBe(
      "You've been invited to join someone@example.com's organization on Telflo, the visual OpenTelemetry pipeline builder.",
    );
    expect(email.html).toContain(
      "<p>You've been invited to join someone@example.com&#39;s organization on Telflo, the visual OpenTelemetry pipeline builder.</p>",
    );
  });

  it("names a renamed personal workspace, one only like an email, and a group named by an email address by their names alone", () => {
    for (const [organizationName, organizationType] of [
      ["Sam's Lab", "personal"],
      ["sam@example", "personal"],
      ["someone@example.com's workspace", "personal"],
      ["ops@example.com", "group"],
    ] as const) {
      const email = buildInvitationEmail({ organizationName, organizationType, acceptUrl });
      expect(email.subject).toBe(`You've been invited to join ${organizationName} on Telflo`);
      expect(email.text).toContain(`join ${organizationName} on Telflo, the visual`);
    }
  });

  it("escapes the link where it sits in an attribute", () => {
    const email = buildInvitationEmail({
      organizationName: "Acme",
      organizationType: "group",
      acceptUrl: 'https://app.telflo.local/accept-invitation#token=a"onmouseover="alert(1)',
    });
    expect(email.html).not.toContain('="alert(1)');
    expect(email.html).toContain("&quot;");
  });
});
