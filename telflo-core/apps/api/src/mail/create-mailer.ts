import type { MailSettings } from "./mail-settings.js";
import type { IMailer } from "./mailer.js";
import { createSendgridMailer } from "./sendgrid-mailer.js";
import { createSmtpMailer } from "./smtp-mailer.js";

/**
 * The only place that turns configuration into a transport. Adding one means
 * a new adapter, a MailTransportSettings variant (mail-settings.ts), parsing
 * its variables (settings.ts) and a case here. No caller of IMailer changes.
 */
export function createMailer(settings: MailSettings): IMailer {
  const { from, transport } = settings;
  switch (transport.kind) {
    case "smtp":
      return createSmtpMailer({
        host: transport.host,
        port: transport.port,
        from,
        allowInsecureTransport: transport.allowInsecureTransport,
        tls: transport.tls,
        login: transport.login,
        ca: transport.ca,
      });
    case "sendgrid":
      return createSendgridMailer({ apiKey: transport.apiKey, from });
    default: {
      // A new variant without a case here is a compile error, not a runtime surprise.
      const unhandled: never = transport;
      throw new Error(`Unhandled mail transport: ${JSON.stringify(unhandled)}`);
    }
  }
}
