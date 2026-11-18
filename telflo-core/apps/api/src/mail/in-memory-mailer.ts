import type { EmailMessage, IMailer } from "./mailer.js";

/** Test double. Service tests assert on `sent` without needing an SMTP server. */
export function createInMemoryMailer(): IMailer & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message: EmailMessage): Promise<void> {
      sent.push(message);
    },
  };
}
