import { describe, expect, it } from "vitest";
import {
  buildDuplicateRegistrationEmail,
  buildIdentityLinkedEmail,
  buildIdentityUnlinkedEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildVerificationEmail,
} from "./emails.js";

describe("buildVerificationEmail", () => {
  const url = "https://app.telflo.local/verify-email?token=abc123";
  const ttlHours = 24;

  it("puts the verification url in both the text and html bodies", () => {
    const email = buildVerificationEmail({ verificationUrl: url, ttlHours });
    expect(email.text).toContain(url);
    expect(email.html).toContain(url);
  });

  it("has a subject naming the product", () => {
    expect(buildVerificationEmail({ verificationUrl: url, ttlHours }).subject).toContain("Telflo");
  });

  /**
   * Finding 8 of the D1 final review: this used to assert the literal
   * string "24 hours", which locked in a copy of the expiry that was
   * hardcoded rather than read from TELFLO_VERIFICATION_TOKEN_TTL_HOURS —
   * so the email would keep saying "24 hours" even if that setting were
   * changed. Asserting against the same `ttlHours` value passed in is what
   * actually pins the email to the setting.
   */
  it("states the configured expiry, not a hardcoded one, so the recipient is not surprised by a dead link", () => {
    const email = buildVerificationEmail({ verificationUrl: url, ttlHours });
    expect(email.text.toLowerCase()).toContain(`${ttlHours} hours`);
    expect(email.html.toLowerCase()).toContain(`${ttlHours} hours`);
  });

  it("renders a different ttlHours value, proving the copy is not hardcoded", () => {
    const email = buildVerificationEmail({ verificationUrl: url, ttlHours: 1 });
    expect(email.text).toContain("1 hour");
    expect(email.text).not.toContain("24 hours");
  });

  it("escapes html-significant characters in the url attribute", () => {
    // A url is placed inside an href; unescaped quotes would break out of it.
    const email = buildVerificationEmail({
      verificationUrl: 'https://app.telflo.local/verify-email?token=a"onmouseover="alert(1)',
      ttlHours,
    });
    expect(email.html).not.toContain('="alert(1)');
    expect(email.html).toContain("&quot;");
  });
});

describe("buildDuplicateRegistrationEmail", () => {
  const signInUrl = "https://app.telflo.local/login";
  const forgotPasswordUrl = "https://app.telflo.local/forgot-password";

  it("tells the recipient an account already exists", () => {
    const email = buildDuplicateRegistrationEmail({ signInUrl, forgotPasswordUrl, hasPassword: true });
    expect(email.text.toLowerCase()).toContain("already");
  });

  it("links to sign-in rather than to verification", () => {
    const email = buildDuplicateRegistrationEmail({ signInUrl, forgotPasswordUrl, hasPassword: true });
    expect(email.text).toContain(signInUrl);
    expect(email.text).not.toContain("verify-email");
  });

  it("contains no token, because none is issued for an existing account", () => {
    const email = buildDuplicateRegistrationEmail({ signInUrl, forgotPasswordUrl, hasPassword: true });
    expect(email.text).not.toContain("token=");
    expect(email.html).not.toContain("token=");
  });

  it("escapes html-significant characters in the sign-in url attribute", () => {
    // The sign-in url is placed inside an href; unescaped quotes would break out of it.
    const email = buildDuplicateRegistrationEmail({
      signInUrl: 'https://app.telflo.local/login?redirect=a"onmouseover="alert(1)',
      forgotPasswordUrl,
      hasPassword: true,
    });
    expect(email.html).not.toContain('="alert(1)');
    expect(email.html).toContain("&quot;");
  });
});

describe("buildDuplicateRegistrationEmail for an account with no password (D2c Ruling 19)", () => {
  const signInUrl = "https://app.telflo.local/login";
  const forgotPasswordUrl = "https://app.telflo.local/forgot-password";
  const email = buildDuplicateRegistrationEmail({ signInUrl, forgotPasswordUrl, hasPassword: false });

  it("says the account was created with Google, and links to sign-in", () => {
    expect(email.text).toContain("The existing account was created with Google");
    expect(email.text).toContain(signInUrl);
    expect(email.html).toContain(`href="${signInUrl}"`);
  });

  it("points to Forgot password to set a password, in text and html", () => {
    expect(email.text).toContain("Forgot password?");
    expect(email.text).toContain(forgotPasswordUrl);
    expect(email.html).toContain(`href="${forgotPasswordUrl}"`);
  });

  it("keeps the subject, and still contains no token", () => {
    expect(email.subject).toBe("Someone tried to create a Telflo account with your email");
    expect(email.text).not.toContain("token=");
  });

  it("escapes html-significant characters in the forgot-password url", () => {
    const escaped = buildDuplicateRegistrationEmail({
      signInUrl,
      forgotPasswordUrl: 'https://app.telflo.local/forgot-password?a"onmouseover="alert(1)',
      hasPassword: false,
    });
    expect(escaped.html).not.toContain('="alert(1)');
  });
});

describe("buildDuplicateRegistrationEmail for an account with a password", () => {
  it("says only sign in instead, and says nothing about Google or setting a password", () => {
    const email = buildDuplicateRegistrationEmail({
      signInUrl: "https://app.telflo.local/login",
      forgotPasswordUrl: "https://app.telflo.local/forgot-password",
      hasPassword: true,
    });
    expect(email.text).toContain("sign in instead");
    expect(email.text).not.toContain("Google");
    expect(email.text).not.toContain("forgot-password");
  });
});

describe("buildPasswordResetEmail", () => {
  const resetUrl = "https://app.telflo.local/reset-password#token=abc123";

  it("uses its fixed subject and wording (D3 decision 8)", () => {
    const email = buildPasswordResetEmail({ resetUrl });
    expect(email.subject).toBe("Reset your Telflo password");
    for (const body of [email.text, email.html]) {
      expect(body).toContain("We received a request to reset your Telflo password");
      expect(body).toContain(
        "If you didn't request this, you can safely ignore this email. Your password will remain unchanged.",
      );
    }
  });

  it("puts the reset link in both the text and html bodies", () => {
    const email = buildPasswordResetEmail({ resetUrl });
    expect(email.text).toContain(resetUrl);
    expect(email.html).toContain(`href="${resetUrl}"`);
  });

  it("says the link expires in 1 hour", () => {
    const email = buildPasswordResetEmail({ resetUrl });
    expect(email.text).toContain("This link expires in 1 hour.");
    expect(email.html).toContain("This link expires in 1 hour.");
  });

  it("escapes html-significant characters in the reset url", () => {
    const email = buildPasswordResetEmail({
      resetUrl: 'https://app.telflo.local/reset-password#token=a"onmouseover="alert(1)<b>',
    });
    expect(email.html).not.toContain('="alert(1)');
    expect(email.html).not.toContain("<b>");
    expect(email.html).toContain("&quot;");
  });
});

/*
 * The account's security emails (D21 decision 43): decision 43's words
 * exactly, and every interpolated value escaped in the HTML part.
 */
describe("the account's security emails (D21 decision 43)", () => {
  const forgotPasswordUrl = "https://app.telflo.local/forgot-password";
  const settingsUrl = "https://app.telflo.local/settings/account";
  const shared = [
    "If this wasn't you, reset your password: https://app.telflo.local/forgot-password",
    "A reset signs out every browser.",
  ];
  /** A value that breaks out of an attribute or opens a tag unless escaped. */
  const hostile = '"><script>alert(1)</script>';
  const escapedHostile = "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;";

  /** No Google address, no IP, no device: nothing in any part looks like an address but the links. */
  function expectNoPersonalData(email: { subject: string; text: string; html: string }): void {
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toMatch(/@/);
      expect(part).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    }
  }

  describe("buildPasswordChangedEmail", () => {
    it("the subject and the text are decision 43's words", () => {
      const email = buildPasswordChangedEmail({ forgotPasswordUrl });
      expect(email.subject).toBe("Your Telflo password was changed");
      expect(email.text).toBe(
        [
          "The password for your Telflo account was changed from Settings. Your signed-in browsers stay signed in.",
          "",
          ...shared,
        ].join("\n"),
      );
      expect(email.html).toBe(
        [
          "<p>The password for your Telflo account was changed from Settings. Your signed-in browsers stay signed in.</p>",
          '<p>If this wasn\'t you, reset your password: <a href="https://app.telflo.local/forgot-password">https://app.telflo.local/forgot-password</a></p>',
          "<p>A reset signs out every browser.</p>",
        ].join("\n"),
      );
      expectNoPersonalData(email);
    });

    it("an interpolated value is escaped in the HTML part", () => {
      const email = buildPasswordChangedEmail({ forgotPasswordUrl: `https://app.telflo.local/forgot-password?${hostile}` });
      expect(email.html).not.toContain(hostile);
      expect(email.html).not.toContain("<script>");
      expect(email.html).toContain(escapedHostile);
    });
  });

  describe("buildIdentityLinkedEmail", () => {
    it("the subject and the text are decision 43's words, with Q127's ordered recovery as the only way back", () => {
      const email = buildIdentityLinkedEmail({ providerName: "Google", settingsUrl });
      expect(email.subject).toBe("Google sign-in was linked to your Telflo account");
      expect(email.text).toBe(
        [
          "A Google account was linked to your Telflo account from Settings, and can now be used to sign in.",
          "",
          "If this wasn't you, remove it in Settings \u203a Account, then choose Sign out everywhere, and change your password: https://app.telflo.local/settings/account",
        ].join("\n"),
      );
      expect(email.html).toBe(
        [
          "<p>A Google account was linked to your Telflo account from Settings, and can now be used to sign in.</p>",
          '<p>If this wasn\'t you, remove it in Settings \u203a Account, then choose Sign out everywhere, and change your password: <a href="https://app.telflo.local/settings/account">https://app.telflo.local/settings/account</a></p>',
        ].join("\n"),
      );
      // The ordered recovery is its only way back: no reset link (a reset alone leaves the link in place).
      expect(email.text).not.toContain("forgot-password");
      expect(email.html).not.toContain("forgot-password");
      expectNoPersonalData(email);
    });

    it("names the provider by its configured name", () => {
      const email = buildIdentityLinkedEmail({ providerName: "Acme SSO", settingsUrl });
      expect(email.subject).toBe("Acme SSO sign-in was linked to your Telflo account");
      expect(email.text).toContain("A Acme SSO account was linked");
    });

    it("an interpolated value is escaped in the HTML part", () => {
      const email = buildIdentityLinkedEmail({
        providerName: hostile,
        settingsUrl: `https://app.telflo.local/settings/account?${hostile}`,
      });
      expect(email.html).not.toContain(hostile);
      expect(email.html).not.toContain("<script>");
      // The provider's name and the settings link (twice).
      expect(email.html.split(escapedHostile)).toHaveLength(4);
    });
  });

  describe("buildIdentityUnlinkedEmail", () => {
    it("the subject and the text are decision 43's words, with what unlinking doesn't stop (Q126)", () => {
      const email = buildIdentityUnlinkedEmail({ providerName: "Google", relinksByEmail: true, forgotPasswordUrl });
      expect(email.subject).toBe("Google sign-in was removed from your Telflo account");
      expect(email.text).toBe(
        [
          "Google sign-in was removed from your Telflo account from Settings. You can still sign in with your password. If your Telflo address is this Google account's address, signing in with Google links it again.",
          "",
          ...shared,
        ].join("\n"),
      );
      expect(email.html).toBe(
        [
          "<p>Google sign-in was removed from your Telflo account from Settings. You can still sign in with your password. If your Telflo address is this Google account's address, signing in with Google links it again.</p>",
          '<p>If this wasn\'t you, reset your password: <a href="https://app.telflo.local/forgot-password">https://app.telflo.local/forgot-password</a></p>',
          "<p>A reset signs out every browser.</p>",
        ].join("\n"),
      );
      expectNoPersonalData(email);
    });

    it("names the provider by its configured name in every place", () => {
      const email = buildIdentityUnlinkedEmail({ providerName: "Acme SSO", relinksByEmail: true, forgotPasswordUrl });
      expect(email.subject).toBe("Acme SSO sign-in was removed from your Telflo account");
      expect(email.text).toContain(
        "If your Telflo address is this Acme SSO account's address, signing in with Acme SSO links it again.",
      );
      expect(email.text).not.toContain("Google");
    });

    it("leaves the re-link sentence out when the provider doesn't re-link by email (Ruling 92)", () => {
      const email = buildIdentityUnlinkedEmail({ providerName: "okta", relinksByEmail: false, forgotPasswordUrl });
      expect(email.subject).toBe("okta sign-in was removed from your Telflo account");
      expect(email.text).toBe(
        [
          "okta sign-in was removed from your Telflo account from Settings. You can still sign in with your password.",
          "",
          ...shared,
        ].join("\n"),
      );
      expect(email.html).toBe(
        [
          "<p>okta sign-in was removed from your Telflo account from Settings. You can still sign in with your password.</p>",
          '<p>If this wasn\'t you, reset your password: <a href="https://app.telflo.local/forgot-password">https://app.telflo.local/forgot-password</a></p>',
          "<p>A reset signs out every browser.</p>",
        ].join("\n"),
      );
      expect(`${email.text}${email.html}`).not.toContain("links it again");
      expectNoPersonalData(email);
    });

    it("an interpolated value is escaped in the HTML part", () => {
      const email = buildIdentityUnlinkedEmail({
        providerName: hostile,
        relinksByEmail: true,
        forgotPasswordUrl: `https://app.telflo.local/forgot-password?${hostile}`,
      });
      expect(email.html).not.toContain(hostile);
      expect(email.html).not.toContain("<script>");
      // The provider's name (three times) and the reset link (twice).
      expect(email.html.split(escapedHostile)).toHaveLength(6);
    });
  });
});
