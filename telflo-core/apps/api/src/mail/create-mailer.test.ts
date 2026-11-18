import { describe, expect, it } from "vitest";
import { createMailer } from "./create-mailer.js";

describe("createMailer", () => {
  it("builds an SMTP mailer for the smtp transport", () => {
    const mailer = createMailer({
      from: "no-reply@telflo.local",
      transport: { kind: "smtp", host: "localhost", port: 1025, allowInsecureTransport: false, tls: "none", login: null, ca: null },
    });
    expect(typeof mailer.send).toBe("function");
  });

  it("builds a SendGrid mailer for the sendgrid transport", () => {
    const mailer = createMailer({
      from: "no-reply@telflo.io",
      transport: { kind: "sendgrid", apiKey: "SG.test-key" },
    });
    expect(typeof mailer.send).toBe("function");
  });

  it("keeps the SMTP adapter's cleartext interlock in force when chosen through configuration", () => {
    expect(() =>
      createMailer({
        from: "no-reply@telflo.local",
        transport: { kind: "smtp", host: "smtp.example.com", port: 587, allowInsecureTransport: false, tls: "none", login: null, ca: null },
      }),
    ).toThrow(/unencrypted connection/);
  });

  it("passes the configured cleartext override through to the SMTP adapter", () => {
    expect(() =>
      createMailer({
        from: "no-reply@telflo.local",
        transport: { kind: "smtp", host: "mailpit", port: 1025, allowInsecureTransport: true, tls: "none", login: null, ca: null },
      }),
    ).not.toThrow();
  });

  it("passes the TLS mode and the login through: TLS needs no override, a login in cleartext is refused (D36-1 decision 38)", () => {
    const smtp = { kind: "smtp", host: "smtp.example.com", port: 587, allowInsecureTransport: false, login: null, ca: null } as const;
    for (const tls of ["starttls", "implicit"] as const) {
      expect(() => createMailer({ from: "no-reply@telflo.local", transport: { ...smtp, tls } })).not.toThrow();
    }
    expect(() =>
      createMailer({
        from: "no-reply@telflo.local",
        transport: { ...smtp, allowInsecureTransport: true, tls: "none", login: { username: "relay-user", password: "relay-password" } },
      }),
    ).toThrow(/Refusing to send the SMTP login to smtp\.example\.com/);
  });
});
