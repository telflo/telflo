/**
 * The emails the identity module sends. Content only: how a message is
 * delivered is the mail module's concern (src/mail/), so nothing here knows
 * or cares whether it leaves by SMTP or a provider's API.
 */

/**
 * Minimal HTML escaping for values interpolated into markup or attributes.
 * The organization module's invitation email uses it too.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * "24 hours", "1 hour" — never a bare, unitless number, and never "1 hours".
 * TELFLO_VERIFICATION_TOKEN_TTL_HOURS is a positive integer (see settings.ts),
 * so the only irregular case is exactly 1.
 */
function describeTtlHours(ttlHours: number): string {
  return ttlHours === 1 ? "1 hour" : `${ttlHours} hours`;
}

export function buildVerificationEmail(input: { verificationUrl: string; ttlHours: number }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHtml(input.verificationUrl);
  const ttlDescription = describeTtlHours(input.ttlHours);
  return {
    subject: "Confirm your Telflo email address",
    text: [
      "Welcome to Telflo.",
      "",
      "Confirm your email address to finish creating your account:",
      input.verificationUrl,
      "",
      `This link expires in ${ttlDescription}.`,
      "",
      "If you did not create a Telflo account, you can ignore this message.",
    ].join("\n"),
    html: [
      "<p>Welcome to Telflo.</p>",
      "<p>Confirm your email address to finish creating your account:</p>",
      `<p><a href="${safeUrl}">Confirm my email address</a></p>`,
      `<p>This link expires in ${ttlDescription}.</p>`,
      "<p>If you did not create a Telflo account, you can ignore this message.</p>",
    ].join("\n"),
  };
}

/**
 * Sent when someone registers with an email that already has an account.
 *
 * This message is why registration can stay enumeration-safe: the API returns
 * an identical response either way, and the real owner — not the person who
 * submitted the form — is the one who learns an account exists. It carries no
 * token, because none is issued.
 */
export function buildDuplicateRegistrationEmail(input: {
  signInUrl: string;
  forgotPasswordUrl: string;
  /** False for an account created with Google, which has no password. */
  hasPassword: boolean;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const safeSignInUrl = escapeHtml(input.signInUrl);
  const safeForgotPasswordUrl = escapeHtml(input.forgotPasswordUrl);
  const opening = [
    "Someone submitted the Telflo sign-up form using this email address.",
    "",
  ];
  const closing = ["", "If it was not you, no action is needed. Your account is unaffected."];

  // An account with no password can't "sign in instead" with the password
  // just typed: it was never set. Only Google creates such accounts today;
  // a second provider would need this sentence to name it. Saying so is
  // safe: this email reaches only the address's owner.
  if (!input.hasPassword) {
    return {
      subject: "Someone tried to create a Telflo account with your email",
      text: [
        ...opening,
        "An account already exists, so no new account was created and nothing",
        "has changed. The existing account was created with Google, so if this",
        "was you, sign in with Google:",
        input.signInUrl,
        "",
        'To sign in with a password as well, choose "Forgot password?" on the',
        "sign-in page to set one:",
        input.forgotPasswordUrl,
        ...closing,
      ].join("\n"),
      html: [
        "<p>Someone submitted the Telflo sign-up form using this email address.</p>",
        "<p>An account already exists, so no new account was created and nothing has changed.",
        `The existing account was created with Google, so if this was you, <a href="${safeSignInUrl}">sign in with Google</a>.</p>`,
        `<p>To sign in with a password as well, <a href="${safeForgotPasswordUrl}">set one with "Forgot password?"</a>.</p>`,
        "<p>If it was not you, no action is needed. Your account is unaffected.</p>",
      ].join("\n"),
    };
  }

  return {
    subject: "Someone tried to create a Telflo account with your email",
    text: [
      ...opening,
      "An account already exists, so no new account was created and nothing",
      "has changed. If this was you, sign in instead:",
      input.signInUrl,
      ...closing,
    ].join("\n"),
    html: [
      "<p>Someone submitted the Telflo sign-up form using this email address.</p>",
      "<p>An account already exists, so no new account was created and nothing has changed.",
      `If this was you, <a href="${safeSignInUrl}">sign in instead</a>.</p>`,
      "<p>If it was not you, no action is needed. Your account is unaffected.</p>",
    ].join("\n"),
  };
}

/**
 * A password reset link. Plain, like the verification email, with a fixed
 * subject and wording. The lifetime is a constant
 * (PASSWORD_RESET_TOKEN_TTL_MINUTES), so the sentence is too. The caller puts
 * the token in the link's fragment, `/reset-password#token=…`, so it never
 * reaches a server or its logs.
 */
export function buildPasswordResetEmail(input: { resetUrl: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHtml(input.resetUrl);
  return {
    subject: "Reset your Telflo password",
    text: [
      "We received a request to reset your Telflo password. Open this link to choose a new password:",
      input.resetUrl,
      "",
      "This link expires in 1 hour.",
      "",
      "If you didn't request this, you can safely ignore this email. Your password will remain unchanged.",
    ].join("\n"),
    html: [
      "<p>We received a request to reset your Telflo password. Open this link to choose a new password:</p>",
      `<p><a href="${safeUrl}">Reset my password</a></p>`,
      `<p>If the link doesn't work, copy and paste this address into your browser:<br>${safeUrl}</p>`,
      "<p>This link expires in 1 hour.</p>",
      "<p>If you didn't request this, you can safely ignore this email. Your password will remain unchanged.</p>",
    ].join("\n"),
  };
}

/*
 * The account's security emails: sent to the account's address after a
 * change made from Settings commits, through the after-response runner,
 * which logs a failed send; nothing is rolled back or retried. Each names no
 * provider's address, no IP and no device. The provider is named by its
 * configured name ("Google"), never its email.
 */

/** Settings' section mark, written as an escape so this file stays ASCII. */
const SECTION_SEPARATOR = "\u203a";

/** The lines the password-changed and removed emails end with: the way back if it wasn't them. */
function securityClosing(forgotPasswordUrl: string): { text: string[]; html: string[] } {
  const safeUrl = escapeHtml(forgotPasswordUrl);
  return {
    text: [`If this wasn't you, reset your password: ${forgotPasswordUrl}`, "A reset signs out every browser."],
    html: [
      `<p>If this wasn't you, reset your password: <a href="${safeUrl}">${safeUrl}</a></p>`,
      "<p>A reset signs out every browser.</p>",
    ],
  };
}

/** "Your Telflo password was changed": every session stays signed in. */
export function buildPasswordChangedEmail(input: { forgotPasswordUrl: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const opening = "The password for your Telflo account was changed from Settings. Your signed-in browsers stay signed in.";
  const closing = securityClosing(input.forgotPasswordUrl);
  return {
    subject: "Your Telflo password was changed",
    text: [opening, "", ...closing.text].join("\n"),
    html: [`<p>${opening}</p>`, ...closing.html].join("\n"),
  };
}

/**
 * "Google sign-in was linked to your Telflo account". Its one way back is the
 * ordered recovery, in place of the shared reset lines: a reset alone leaves
 * the identity linked and its sessions signed in, so removing it and signing
 * out everywhere come before the new password.
 */
export function buildIdentityLinkedEmail(input: { providerName: string; settingsUrl: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeProviderName = escapeHtml(input.providerName);
  const safeSettingsUrl = escapeHtml(input.settingsUrl);
  const opening = (name: string) =>
    `A ${name} account was linked to your Telflo account from Settings, and can now be used to sign in.`;
  const recovery = `If this wasn't you, remove it in Settings ${SECTION_SEPARATOR} Account, then choose Sign out everywhere, and change your password:`;
  return {
    subject: `${input.providerName} sign-in was linked to your Telflo account`,
    text: [opening(input.providerName), "", `${recovery} ${input.settingsUrl}`].join("\n"),
    html: [
      `<p>${opening(safeProviderName)}</p>`,
      `<p>${recovery} <a href="${safeSettingsUrl}">${safeSettingsUrl}</a></p>`,
    ].join("\n"),
  };
}

/**
 * "Google sign-in was removed from your Telflo account". When the provider
 * re-links by email (`relinksByEmail`: configured, with an email-authority
 * rule), it says what unlinking doesn't stop: a sign-in with the provider
 * account whose address is the account's own links it again.
 */
export function buildIdentityUnlinkedEmail(input: {
  providerName: string;
  relinksByEmail: boolean;
  forgotPasswordUrl: string;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const safeProviderName = escapeHtml(input.providerName);
  const opening = (name: string) =>
    `${name} sign-in was removed from your Telflo account from Settings. You can still sign in with your password.` +
    (input.relinksByEmail
      ? ` If your Telflo address is this ${name} account's address, signing in with ${name} links it again.`
      : "");
  const closing = securityClosing(input.forgotPasswordUrl);
  return {
    subject: `${input.providerName} sign-in was removed from your Telflo account`,
    text: [opening(input.providerName), "", ...closing.text].join("\n"),
    html: [`<p>${opening(safeProviderName)}</p>`, ...closing.html].join("\n"),
  };
}
