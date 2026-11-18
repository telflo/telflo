import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSmtpMailer, SMTP_TIMEOUTS, SmtpSendError, type SmtpMailerSettings } from "./smtp-mailer.js";

// nodemailer's transport, replaced so the tests can read what createTransport
// and sendMail are handed without an SMTP server. Constructing one connects
// to nothing, so the interlock tests below are unaffected. The real
// connections (STARTTLS, implicit TLS, a login, a private CA) are
// smtp-mailer.relay.test.ts's.
const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn(async (_options: Record<string, unknown>) => ({}));
  return { sendMail, createTransport: vi.fn((_options: Record<string, unknown>) => ({ sendMail })) };
});
vi.mock("nodemailer", () => ({ createTransport }));

const base: SmtpMailerSettings = { host: "localhost", port: 1025, from: "x@y.z", tls: "none" };
/** createTransport's options for the last mailer built. */
const transportOptions = () => createTransport.mock.calls.at(-1)?.[0] as Record<string, unknown> & { tls: Record<string, unknown> };
const refusalOf = (settings: SmtpMailerSettings): string => {
  try {
    createSmtpMailer(settings);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
};

describe("createSmtpMailer", () => {
  beforeEach(() => {
    createTransport.mockClear();
    sendMail.mockClear();
  });

  describe("the cleartext interlock (tls: none)", () => {
    it("throws when host is not a loopback and allowInsecureTransport is not set", () => {
      expect(() => createSmtpMailer({ ...base, host: "smtp.example.com", port: 587 })).toThrow(
        "Refusing to send mail to smtp.example.com over an unencrypted connection",
      );
      expect(createTransport).not.toHaveBeenCalled();
    });

    it("succeeds when host is not a loopback but allowInsecureTransport is explicitly true", () => {
      expect(() => createSmtpMailer({ ...base, host: "smtp.example.com", port: 587, allowInsecureTransport: true })).not.toThrow();
    });

    it("succeeds with localhost, 127.0.0.1 and ::1 without allowInsecureTransport", () => {
      for (const host of ["localhost", "127.0.0.1", "::1"]) {
        expect(() => createSmtpMailer({ ...base, host })).not.toThrow();
      }
    });

    it("doesn't apply to starttls or implicit: TLS is the protection (D36-1 decision 38)", () => {
      for (const tls of ["starttls", "implicit"] as const) {
        expect(() => createSmtpMailer({ ...base, host: "smtp.example.com", port: 587, tls })).not.toThrow();
      }
    });
  });

  describe("a login with tls: none (D36 Ruling 346)", () => {
    const login = { username: `cnry-user-${randomUUID()}`, password: `cnry-password-${randomUUID()}` };

    it("is refused to a host other than loopback, even with allowInsecureTransport, naming neither value", () => {
      for (const allowInsecureTransport of [false, true]) {
        const message = refusalOf({ ...base, host: "mailpit", allowInsecureTransport, login });
        expect(message).toBe(
          "Refusing to send the SMTP login to mailpit over an unencrypted connection. " +
            "Set TELFLO_SMTP_TLS to starttls or implicit, or remove TELFLO_SMTP_USERNAME and TELFLO_SMTP_PASSWORD.",
        );
        expect(message.includes(login.username) || message.includes(login.password)).toBe(false);
      }
      expect(createTransport).not.toHaveBeenCalled();
    });

    it("is allowed to a loopback relay, and with starttls or implicit anywhere", () => {
      for (const host of ["localhost", "127.0.0.1", "::1"]) {
        expect(refusalOf({ ...base, host, login })).toBe("");
      }
      for (const tls of ["starttls", "implicit"] as const) {
        expect(refusalOf({ ...base, host: "smtp.example.com", tls, login })).toBe("");
      }
    });
  });

  describe("the transport (D36-1 decision 38)", () => {
    it("maps each TLS mode to nodemailer's options", () => {
      const expected = {
        starttls: { secure: false, requireTLS: true },
        implicit: { secure: true },
        none: { secure: false, ignoreTLS: true },
      } as const;
      for (const [tls, options] of Object.entries(expected)) {
        createSmtpMailer({ ...base, tls: tls as keyof typeof expected });
        const actual = transportOptions();
        expect({ tls, secure: actual.secure, requireTLS: actual.requireTLS, ignoreTLS: actual.ignoreTLS }).toEqual({
          tls,
          requireTLS: undefined,
          ignoreTLS: undefined,
          ...options,
        });
      }
    });

    it("always verifies the relay's certificate, with or without a CA, in every mode", () => {
      for (const tls of ["starttls", "implicit", "none"] as const) {
        for (const settings of [{ ...base, tls }, { ...base, tls, ca: null }, { ...base, tls, ca: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" }]) {
          createSmtpMailer(settings);
          expect(transportOptions().tls.rejectUnauthorized).toBe(true);
        }
      }
    });

    it("trusts a CA on this connection only (tls.ca), never through NODE_EXTRA_CA_CERTS", () => {
      const before = process.env.NODE_EXTRA_CA_CERTS;
      const ca = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
      createSmtpMailer({ ...base, tls: "starttls", ca });
      expect(transportOptions().tls).toEqual({ rejectUnauthorized: true, ca });
      expect(process.env.NODE_EXTRA_CA_CERTS).toBe(before);
      createSmtpMailer({ ...base, tls: "starttls", ca: null });
      expect(transportOptions().tls).toEqual({ rejectUnauthorized: true });
    });

    it("sends a login only when one is set", () => {
      const login = { username: "relay-user", password: `cnry-password-${randomUUID()}` };
      createSmtpMailer({ ...base, tls: "starttls", login });
      const auth = transportOptions().auth as { user?: unknown; pass?: unknown } | undefined;
      expect(auth?.user === login.username && auth.pass === login.password).toBe(true);
      for (const settings of [{ ...base, tls: "starttls" as const }, { ...base, tls: "starttls" as const, login: null }]) {
        createSmtpMailer(settings);
        expect(transportOptions()).not.toHaveProperty("auth");
      }
    });

    it("bounds its waits (10 s to connect, 10 s for the greeting, 60 s of silence) and logs nothing", () => {
      expect(SMTP_TIMEOUTS).toEqual({ connection: 10_000, greeting: 10_000, socket: 60_000 });
      createSmtpMailer({ ...base, tls: "starttls" });
      expect(transportOptions()).toMatchObject({
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 60_000,
        logger: false,
        debug: false,
      });
      createSmtpMailer({ ...base, tls: "starttls", timeouts: { connection: 1, greeting: 2, socket: 3 } });
      expect(transportOptions()).toMatchObject({ connectionTimeout: 1, greetingTimeout: 2, socketTimeout: 3 });
    });
  });

  describe("send", () => {
    const message = {
      to: "support@telflo.com",
      subject: "Pricing inquiry from Ada Lovelace",
      text: "Hello",
      html: "<p>Hello</p>",
    };
    const settings: SmtpMailerSettings = { host: "localhost", port: 1025, from: "no-reply@telflo.local", tls: "none" };

    it("hands nodemailer the sender, the recipient, the subject and both bodies", async () => {
      await createSmtpMailer(settings).send(message);

      expect(sendMail).toHaveBeenCalledWith({
        from: "no-reply@telflo.local",
        to: "support@telflo.com",
        subject: message.subject,
        text: "Hello",
        html: "<p>Hello</p>",
      });
    });

    it("passes replyTo through as nodemailer's replyTo option", async () => {
      await createSmtpMailer(settings).send({ ...message, replyTo: "ada@example.com" });

      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ replyTo: "ada@example.com" });
    });

    it("sets no replyTo when the message has none", async () => {
      await createSmtpMailer(settings).send(message);

      expect(sendMail.mock.calls[0]?.[0]).not.toHaveProperty("replyTo");
    });

    it("throws a failure in fixed words (nodemailer's code, the reply code), never nodemailer's text, the reply, the command or the recipient", async () => {
      const username = `cnry-user-${randomUUID()}`;
      const password = `cnry-password-${randomUUID()}`;
      const failure = Object.assign(new Error(`Invalid login: 535 no such user ${username} ${password}`), {
        code: "EAUTH",
        responseCode: 535,
        response: `535 5.7.8 ${username} ${password}`,
        command: `AUTH PLAIN ${Buffer.from(`\0${username}\0${password}`).toString("base64")}`,
        recipient: message.to,
      });
      sendMail.mockRejectedValueOnce(failure);
      const thrown = await createSmtpMailer({ ...settings, tls: "starttls", login: { username, password } })
        .send(message)
        .then(() => undefined, (error: unknown) => error);

      expect(thrown).toBeInstanceOf(SmtpSendError);
      const error = thrown as SmtpSendError;
      expect([error.code, error.responseCode, error.message]).toEqual([
        "EAUTH",
        535,
        "The SMTP relay didn't accept the message (EAUTH 535)",
      ]);
      expect(error).not.toHaveProperty("cause");
      const everything = [String(error), error.stack ?? "", JSON.stringify(error), inspect(error, { depth: 5, showHidden: true })].join("\n");
      expect(
        everything.includes(username) ||
          everything.includes(password) ||
          everything.includes(Buffer.from(`\0${username}\0${password}`).toString("base64")) ||
          everything.includes(message.to),
      ).toBe(false);
    });

    it("keeps only a known code and a reply code in range", async () => {
      for (const [failure, code, responseCode] of [
        [Object.assign(new Error("x"), { code: "ETLS" }), "ETLS", undefined],
        [Object.assign(new Error("x"), { code: "cnry-not-a-code", responseCode: 9999 }), "EUNKNOWN", undefined],
        [Object.assign(new Error("x"), { code: "EENVELOPE", responseCode: "550" }), "EENVELOPE", undefined],
        ["a thrown string", "EUNKNOWN", undefined],
        [null, "EUNKNOWN", undefined],
      ] as const) {
        sendMail.mockRejectedValueOnce(failure);
        const error = (await createSmtpMailer(settings).send(message).catch((caught: unknown) => caught)) as SmtpSendError;
        expect([error.code, error.responseCode, error.message.includes("cnry")]).toEqual([code, responseCode, false]);
      }
    });
  });
});
