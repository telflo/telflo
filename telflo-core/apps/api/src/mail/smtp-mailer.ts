import { createTransport } from "nodemailer";
import type { SmtpLogin, SmtpTlsMode } from "./mail-settings.js";
import type { EmailMessage, IMailer } from "./mailer.js";

export interface SmtpMailerSettings {
  host: string;
  port: number;
  from: string;
  /** Opt-in to cleartext SMTP (`tls: none`) to a non-loopback host. */
  allowInsecureTransport?: boolean;
  /** TELFLO_SMTP_TLS (settings.ts reads unset as starttls). */
  tls: SmtpTlsMode;
  /** The relay's login, or none. Never logged, never in an error. */
  login?: SmtpLogin | null;
  /** The CA certificates (PEM) this connection alone trusts, or none (the system's). */
  ca?: string | null;
  /**
   * How long to wait, in milliseconds. Production keeps SMTP_TIMEOUTS; the
   * relay tests shorten them so a broken case fails fast.
   */
  timeouts?: SmtpTimeouts;
}

export interface SmtpTimeouts {
  /** Until the TCP connection is open. */
  connection: number;
  /** Until the relay's 220 greeting arrives. */
  greeting: number;
  /** Of silence on an open connection. */
  socket: number;
}

/**
 * The production bounds (D36-1 Preflight ruling 29). nodemailer's own
 * defaults are 2 minutes, 30 seconds and 10 minutes, and a STARTTLS client
 * pointed at an implicit-TLS port waits out the greeting timeout.
 */
export const SMTP_TIMEOUTS: SmtpTimeouts = { connection: 10_000, greeting: 10_000, socket: 60_000 };

/** The hosts a relay may be reached in cleartext without the override. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * nodemailer's error codes, the only part of a failure this transport passes
 * on. Anything else (an unexpected code, none) becomes EUNKNOWN.
 */
const NODEMAILER_ERROR_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "EDNS",
  "ESOCKET",
  "ETLS",
  "EAUTH",
  "EENVELOPE",
  "EMESSAGE",
  "ESTREAM",
  "EPROTOCOL",
]);

/**
 * A failed delivery, in fixed words: nodemailer's code (EAUTH, ETLS, …) and
 * the relay's numeric reply code, if any. Never nodemailer's message, the
 * relay's reply text, the command, the recipient or a `cause`: a relay's
 * reply may quote the login's username or the recipient's address, and the
 * callers' runners log what a send throws.
 */
export class SmtpSendError extends Error {
  override readonly name = "SmtpSendError";
  readonly code: string;
  readonly responseCode: number | undefined;

  constructor(code: string, responseCode: number | undefined) {
    super(`The SMTP relay didn't accept the message (${code}${responseCode === undefined ? "" : ` ${responseCode}`})`);
    this.code = code;
    this.responseCode = responseCode;
  }
}

function sendErrorOf(error: unknown): SmtpSendError {
  const { code, responseCode } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    responseCode?: unknown;
  };
  return new SmtpSendError(
    typeof code === "string" && NODEMAILER_ERROR_CODES.has(code) ? code : "EUNKNOWN",
    typeof responseCode === "number" && Number.isInteger(responseCode) && responseCode >= 200 && responseCode <= 599
      ? responseCode
      : undefined,
  );
}

/** D36-1 decision 38: how each TELFLO_SMTP_TLS mode opens the connection. */
function tlsOptionsOf(mode: SmtpTlsMode): { secure: boolean; requireTLS?: true; ignoreTLS?: true } {
  switch (mode) {
    case "starttls":
      // A relay that doesn't offer STARTTLS, or fails it, is refused: the
      // message is never sent in cleartext.
      return { secure: false, requireTLS: true };
    case "implicit":
      return { secure: true };
    case "none":
      return { secure: false, ignoreTLS: true };
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled SMTP TLS mode: ${String(unhandled)}`);
    }
  }
}

/**
 * Mail through an SMTP relay: Mailpit in development (`tls: none`), the
 * customer's or provider's relay elsewhere (D36-1 decisions 38–40).
 *
 * - `starttls` (the default) upgrades a plain connection and refuses a relay
 *   that can't; `implicit` opens TLS from the start; `none` sends in
 *   cleartext.
 * - The relay's certificate is always verified (`rejectUnauthorized` is never
 *   false), against the system's CAs or, with a CA file, against that file's
 *   certificates only, on this connection only (`tls.ca`; never
 *   NODE_EXTRA_CA_CERTS, which would widen every connection the API makes).
 * - A login (PLAIN or LOGIN, nodemailer's choice) is sent only when set.
 *
 * Security interlocks, thrown at construction (createMailer runs at boot):
 * - cleartext (`none`) to a host other than loopback needs
 *   allowInsecureTransport, so verification and reset links never cross a
 *   network in cleartext silently;
 * - a login with `none` is refused unless the host is loopback, override or
 *   not (D36 Ruling 346): it would put the relay's credentials on the wire.
 *
 * nodemailer logs nothing (no logger, no debug), and a failed send throws an
 * SmtpSendError (fixed words), never nodemailer's error.
 */
export function createSmtpMailer(settings: SmtpMailerSettings): IMailer {
  const mode = settings.tls;
  const login = settings.login ?? null;
  const isLoopback = LOOPBACK_HOSTS.has(settings.host);

  if (mode === "none" && !isLoopback && login !== null) {
    throw new Error(
      `Refusing to send the SMTP login to ${settings.host} over an unencrypted connection. ` +
        "Set TELFLO_SMTP_TLS to starttls or implicit, or remove TELFLO_SMTP_USERNAME and TELFLO_SMTP_PASSWORD.",
    );
  }
  if (mode === "none" && !isLoopback && !settings.allowInsecureTransport) {
    throw new Error(
      `Refusing to send mail to ${settings.host} over an unencrypted connection (TELFLO_SMTP_TLS is none). ` +
        "Set TELFLO_SMTP_TLS to starttls or implicit, or set TELFLO_SMTP_ALLOW_INSECURE=true to override (development relays only).",
    );
  }

  const timeouts = settings.timeouts ?? SMTP_TIMEOUTS;
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    ...tlsOptionsOf(mode),
    tls: {
      rejectUnauthorized: true,
      ...(settings.ca === undefined || settings.ca === null ? {} : { ca: settings.ca }),
    },
    ...(login === null ? {} : { auth: { user: login.username, pass: login.password } }),
    connectionTimeout: timeouts.connection,
    greetingTimeout: timeouts.greeting,
    socketTimeout: timeouts.socket,
    logger: false,
    debug: false,
  });

  return {
    async send(message: EmailMessage): Promise<void> {
      try {
        await transport.sendMail({
          from: settings.from,
          to: message.to,
          ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        throw sendErrorOf(error);
      }
    },
  };
}
