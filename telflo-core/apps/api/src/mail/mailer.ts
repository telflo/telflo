/**
 * A message as the product composes it. Deliberately transport-neutral: no
 * sender (a deployment setting — see MailSettings), no provider-specific
 * fields. Every transport must be able to deliver exactly this.
 */
export interface EmailMessage {
  to: string;
  /**
   * Where a reply goes, when not to the sender: a sales inquiry's submitter.
   * SMTP and SendGrid both carry it.
   */
  replyTo?: string | undefined;
  subject: string;
  text: string;
  html: string;
}

/**
 * Outbound email. Mailpit in development, a provider in the SaaS, the
 * customer's own relay on-prem, and nothing at all in tests — so callers
 * depend on this interface and never on a transport. Which implementation
 * runs is decided once, from configuration, by createMailer.
 */
export interface IMailer {
  send(message: EmailMessage): Promise<void>;
}
