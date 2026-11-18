/** The transports a deployment can choose with TELFLO_MAIL_TRANSPORT. */
export const MAIL_TRANSPORTS = ["smtp", "sendgrid"] as const;

/**
 * TELFLO_SMTP_TLS's values (D36-1 decision 30): `starttls` (the default)
 * upgrades a plain connection and refuses a relay that can't, `implicit`
 * opens TLS from the start (port 465's), `none` sends in cleartext
 * (development relays only; smtp-mailer.ts's interlocks).
 */
export const SMTP_TLS_MODES = ["starttls", "implicit", "none"] as const;
export type SmtpTlsMode = (typeof SMTP_TLS_MODES)[number];

/** The relay's login (TELFLO_SMTP_USERNAME and TELFLO_SMTP_PASSWORD, set together). Never log either. */
export interface SmtpLogin {
  username: string;
  password: string;
}

export type MailTransportSettings =
  | {
      kind: "smtp";
      host: string;
      port: number;
      /** Opt-in to cleartext SMTP to a non-loopback host. See smtp-mailer.ts. */
      allowInsecureTransport: boolean;
      /** TELFLO_SMTP_TLS (default starttls). */
      tls: SmtpTlsMode;
      /** The login, or null for none. */
      login: SmtpLogin | null;
      /**
       * TELFLO_SMTP_CA_FILE's certificates (PEM), read once at boot: with
       * one, this connection trusts these certificates in place of the
       * system's (`tls.ca`, smtp-mailer.ts); null for the system's.
       */
      ca: string | null;
    }
  | { kind: "sendgrid"; apiKey: string };

export interface MailSettings {
  /** The sender address. A property of the deployment, not of the transport. */
  from: string;
  transport: MailTransportSettings;
}
