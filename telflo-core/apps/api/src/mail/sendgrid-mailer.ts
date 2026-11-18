import type { EmailMessage, IMailer } from "./mailer.js";

export interface SendgridMailerSettings {
  apiKey: string;
  from: string;
}

const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 500;

/**
 * Sends through SendGrid's v3 HTTP API rather than its SMTP relay, so the
 * SaaS needs no SMTP egress and gets a real status code and error body back.
 *
 * `fetch` is injectable so tests can assert on the exact request without
 * reaching SendGrid.
 */
export function createSendgridMailer(
  settings: SendgridMailerSettings,
  options: { fetch?: typeof fetch } = {},
): IMailer {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async send(message: EmailMessage): Promise<void> {
      const response = await fetchImpl(SENDGRID_SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: settings.from },
          ...(message.replyTo === undefined ? {} : { reply_to: { email: message.replyTo } }),
          subject: message.subject,
          // SendGrid requires text/plain to come before text/html.
          content: [
            { type: "text/plain", value: message.text },
            { type: "text/html", value: message.html },
          ],
          // Click tracking is on by default and rewrites every link through
          // SendGrid's redirect domain. For a verification or sign-in link
          // that would hand the token to a third party and break the link
          // if the tracking domain is ever unreachable, so it is always off.
          tracking_settings: {
            click_tracking: { enable: false, enable_text: false },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        // The API key is in the request, never the response, so the body is
        // safe to surface. It is truncated because it lands in logs.
        const body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
        throw new Error(`SendGrid rejected the message with HTTP ${response.status}: ${body}`);
      }
    },
  };
}
