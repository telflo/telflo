import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../settings.js";
import { createTestCertificates, startSmtpRelay, type SmtpRelay, type SmtpRelayMode, type TestCertificates } from "../testing/smtp-relay.js";
import { createMailer } from "./create-mailer.js";
import { createSmtpMailer, SmtpSendError, type SmtpMailerSettings } from "./smtp-mailer.js";

// Real connections, through the real nodemailer, to an in-process relay
// (../testing/smtp-relay.ts) with a CA and a server certificate made at test
// time. The client dials 127.0.0.1 (the certificate's IP SAN): "localhost"
// would send nodemailer to DNS first. Short waits, so a broken case fails fast
// rather than at production's bounds.

const TIMEOUTS = { connection: 3_000, greeting: 3_000, socket: 3_000 };
const message = { to: "recipient@example.test", subject: `relay test ${randomUUID()}`, text: "Hello", html: "<p>Hello</p>" };

let certificates: TestCertificates;
const login = { username: `cnry-user-${randomUUID()}`, password: `cnry-password-${randomUUID()}` };
const relays: SmtpRelay[] = [];

beforeAll(() => {
  certificates = createTestCertificates();
});
afterAll(() => {
  certificates.remove();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

/** A relay with the certificate for 127.0.0.1 and localhost, or (`foreign`) the same CA's certificate for another host. */
async function relayOf(mode: SmtpRelayMode, withLogin = true, certificate: "own" | "foreign" = "own"): Promise<SmtpRelay> {
  const [key, cert] = certificate === "own" ? [certificates.key, certificates.cert] : [certificates.foreignKey, certificates.foreignCert];
  const relay = await startSmtpRelay({ mode, key, cert, login: withLogin ? login : null });
  relays.push(relay);
  return relay;
}

function mailerFor(relay: SmtpRelay, settings: Partial<SmtpMailerSettings> & Pick<SmtpMailerSettings, "tls">) {
  return createSmtpMailer({ host: "127.0.0.1", port: relay.port, from: "no-reply@telflo.local", timeouts: TIMEOUTS, ...settings });
}

/** The send's failure, or undefined when it delivered. */
async function failureOf(send: Promise<void>): Promise<SmtpSendError | undefined> {
  try {
    await send;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SmtpSendError);
    return error as SmtpSendError;
  }
}

/** Whether any text of the error (its message, stack, JSON, every property) holds the login. */
function holdsLogin(error: unknown): boolean {
  const text = [String(error), (error as Error | undefined)?.stack ?? "", JSON.stringify(error), inspect(error, { depth: 5, showHidden: true })].join("\n");
  return text.includes(login.username) || text.includes(login.password);
}

describe("SMTP through a real relay", () => {
  it("delivers over STARTTLS with a login, trusting a private CA", async () => {
    const relay = await relayOf("starttls");
    await mailerFor(relay, { tls: "starttls", login, ca: certificates.caPem }).send(message);

    expect(relay.received).toHaveLength(1);
    const [received] = relay.received;
    expect([received?.secure, received?.mechanism !== null, received?.to, received?.data.includes(message.subject)]).toEqual([
      true,
      true,
      [message.to],
      true,
    ]);
  });

  it("delivers over implicit TLS with a login, trusting a private CA", async () => {
    const relay = await relayOf("implicit");
    await mailerFor(relay, { tls: "implicit", login, ca: certificates.caPem }).send(message);

    expect(relay.received.map(({ secure, mechanism }) => [secure, mechanism !== null])).toEqual([[true, true]]);
  });

  it("delivers over TLS with no login to a relay that needs none", async () => {
    const relay = await relayOf("starttls", false);
    await mailerFor(relay, { tls: "starttls", ca: certificates.caPem }).send(message);

    expect(relay.received.map(({ secure, mechanism }) => [secure, mechanism])).toEqual([[true, null]]);
  });

  it("delivers through configuration: TELFLO_SMTP_TLS, the login and TELFLO_SMTP_CA_FILE read by settings, the mailer built by createMailer", async () => {
    const relay = await relayOf("starttls");
    const settings = loadSettings({
      ...process.env,
      TELFLO_MAIL_TRANSPORT: "smtp",
      TELFLO_SMTP_HOST: "127.0.0.1",
      TELFLO_SMTP_PORT: String(relay.port),
      TELFLO_SMTP_ALLOW_INSECURE: "",
      TELFLO_SMTP_TLS: "starttls",
      TELFLO_SMTP_USERNAME: login.username,
      TELFLO_SMTP_PASSWORD: login.password,
      TELFLO_SMTP_CA_FILE: certificates.caFile,
    });
    await createMailer(settings.mail).send(message);

    expect(relay.received.map(({ secure, mechanism }) => [secure, mechanism !== null])).toEqual([[true, true]]);
  });

  it("refuses a relay that doesn't offer STARTTLS under starttls, before any login or message", async () => {
    const relay = await relayOf("plain");
    const error = await failureOf(mailerFor(relay, { tls: "starttls", login, ca: certificates.caPem }).send(message));

    expect(error?.code).toBe("ETLS");
    expect([relay.received.length, relay.authAttempts()]).toEqual([0, 0]);
  });

  for (const mode of ["starttls", "implicit"] as const) {
    it(`refuses a certificate from another CA, and with no CA one the system doesn't trust (${mode}), before any login`, async () => {
      const relay = await relayOf(mode);
      for (const ca of [certificates.otherCaPem, null]) {
        const error = await failureOf(mailerFor(relay, { tls: mode, login, ca }).send(message));
        expect(error === undefined ? "delivered" : ["ETLS", "ESOCKET", "ECONNECTION"].includes(error.code)).toBe(true);
        expect(holdsLogin(error)).toBe(false);
      }
      expect([relay.received.length, relay.authAttempts()]).toEqual([0, 0]);
    });

    it(`refuses a certificate the trusted CA issued for another host (${mode}): the host-name check, before any login`, async () => {
      const relay = await relayOf(mode, true, "foreign");
      const error = await failureOf(mailerFor(relay, { tls: mode, login, ca: certificates.caPem }).send(message));

      expect(error === undefined ? "delivered" : ["ESOCKET", "ETLS"].includes(error.code)).toBe(true);
      expect(holdsLogin(error)).toBe(false);
      expect([relay.received.length, relay.authAttempts()]).toEqual([0, 0]);
    });
  }

  it("throws a wrong login's refusal without the login in any of its text, and prints nothing", async () => {
    const printed: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
        printed.push(String(chunk));
        return true;
      });
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map((arg) => inspect(arg)).join(" "));
      });
    }
    const relay = await relayOf("starttls");
    const wrong = { username: login.username, password: `${login.password}-wrong` };
    const error = await failureOf(mailerFor(relay, { tls: "starttls", login: wrong, ca: certificates.caPem }).send(message));
    await mailerFor(relay, { tls: "starttls", login, ca: certificates.caPem }).send(message);
    vi.restoreAllMocks();

    expect([error?.code, error?.responseCode, relay.refusedLogins(), relay.received.length]).toEqual(["EAUTH", 535, 1, 1]);
    expect(holdsLogin(error)).toBe(false);
    expect(printed.some((text) => text.includes(login.username) || text.includes(login.password))).toBe(false);
  });

  it("delivers in cleartext (tls: none) to a loopback relay, as Mailpit takes it in development", async () => {
    const relay = await relayOf("plain", false);
    await mailerFor(relay, { tls: "none" }).send(message);

    expect(relay.received.map(({ secure }) => secure)).toEqual([false]);
  });
});
