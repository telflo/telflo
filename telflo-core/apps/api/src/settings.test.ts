import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { keyIdOf } from "./modules/quick-deploy/sealed-values.js";
import { OPEN_SOURCE_SITE } from "@telflo/contracts";
import { loadSettings } from "./settings.js";

const complete = {
  TELFLO_DATABASE_URL: "postgresql://telflo_platform:pw@localhost:5432/telflo_platform",
  TELFLO_API_PORT: "8080",
  TELFLO_PUBLIC_WEB_URL: "http://localhost:3000",
  TELFLO_MAIL_TRANSPORT: "smtp",
  TELFLO_MAIL_FROM: "no-reply@telflo.local",
  TELFLO_SMTP_HOST: "localhost",
  TELFLO_SMTP_PORT: "1025",
  TELFLO_VERIFICATION_TOKEN_TTL_HOURS: "24",
  TELFLO_ACCESS_TOKEN_SECRET: "development-only-access-token-secret-0123456789",
  TELFLO_OPAMP_MANAGEMENT_URL: "http://opamp-server:51235",
  TELFLO_OPAMP_MANAGEMENT_SECRET: "opamp-management-secret-do-not-log-0123456789",
  TELFLO_OTELCOL_VALIDATOR_URL: "http://otelcol-validator:8001",
  TELFLO_OTELCOL_VALIDATOR_SECRET: "otelcol-validator-secret-do-not-log-0123456789",
  TELFLO_FILE_STORE_ROOT: "/var/lib/telflo/file-store",
  TELFLO_OTELCOL_TESTING_URL: "http://otelcol-testing:8002",
  TELFLO_OTELCOL_TESTING_SECRET: "otelcol-testing-secret-do-not-log-0123456789",
  TELFLO_OTTL_EVALUATOR_URL: "http://ottl-evaluator:8003",
  TELFLO_OTTL_EVALUATOR_SECRET: "ottl-evaluator-secret-do-not-log-0123456789",
  TELFLO_OPAMP_AGENT_PUBLIC_URL: "https://opamp.telflo.example/v1/opamp",
  TELFLO_PUBLIC_API_URL: "https://telflo.example",
  TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: "c2V0dGluZ3MtdGVzdC1xdWljay1kZXBsb3kta2V5ISE=",
  TELFLO_LIBRARY_LINK_SIGNING_KEY: "settings-test-only-library-link-signing-key",
};

/** loadSettings' refusal, or "" when it loads. */
function refusalOf(env: NodeJS.ProcessEnv): string {
  try {
    loadSettings(env);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("loadSettings", () => {
  it("reads a complete environment", () => {
    const settings = loadSettings(complete);
    expect(settings.apiPort).toBe(8080);
    expect(settings.mail).toEqual({
      from: "no-reply@telflo.local",
      transport: { kind: "smtp", host: "localhost", port: 1025, allowInsecureTransport: false, tls: "starttls", login: null, ca: null },
    });
    expect(settings.verificationTokenTtlHours).toBe(24);
    expect(settings.site).toEqual(OPEN_SOURCE_SITE);
    expect(settings.salesInquiryTo).toBe("");
  });

  it("never reads the migration URL: the owner's credentials stay out of the API's settings", () => {
    const settings = loadSettings({
      ...complete,
      TELFLO_MIGRATION_DATABASE_URL: "postgresql://owner:owner-secret@localhost:5432/telflo_platform",
    });
    expect(settings.databaseUrl).toBe(complete.TELFLO_DATABASE_URL);
    expect(JSON.stringify(settings)).not.toContain("owner-secret");
  });

  it("throws naming the variable that is missing", () => {
    const { TELFLO_DATABASE_URL: _omitted, ...rest } = complete;
    expect(() => loadSettings(rest)).toThrow(/TELFLO_DATABASE_URL/);
  });

  it("throws on a non-numeric port rather than coercing it to NaN", () => {
    expect(() => loadSettings({ ...complete, TELFLO_API_PORT: "http" })).toThrow(/TELFLO_API_PORT/);
  });

  it("rejects a port of zero, which is not a valid TCP port to bind", () => {
    expect(() => loadSettings({ ...complete, TELFLO_API_PORT: "0" })).toThrow(/TELFLO_API_PORT/);
  });

  it("rejects a negative port", () => {
    expect(() => loadSettings({ ...complete, TELFLO_API_PORT: "-1" })).toThrow(/TELFLO_API_PORT/);
  });

  it("rejects an empty port, treating it as missing rather than coercing to 0", () => {
    expect(() => loadSettings({ ...complete, TELFLO_API_PORT: "" })).toThrow(/TELFLO_API_PORT/);
  });

  it("strips a trailing slash from the public web url", () => {
    // Links are built by concatenation; a trailing slash yields '//verify-email'.
    const settings = loadSettings({ ...complete, TELFLO_PUBLIC_WEB_URL: "https://app.telflo.io/" });
    expect(settings.publicWebUrl).toBe("https://app.telflo.io");
  });

  it("defaults webOrigin to publicWebUrl when TELFLO_WEB_ORIGIN is not set", () => {
    const settings = loadSettings(complete);
    expect(settings.webOrigin).toBe(settings.publicWebUrl);
  });

  it("uses TELFLO_WEB_ORIGIN when set, independently of publicWebUrl", () => {
    const settings = loadSettings({ ...complete, TELFLO_WEB_ORIGIN: "https://app.telflo.example" });
    expect(settings.webOrigin).toBe("https://app.telflo.example");
    expect(settings.publicWebUrl).toBe("http://localhost:3000");
  });

  it("strips a trailing slash from TELFLO_WEB_ORIGIN", () => {
    const settings = loadSettings({ ...complete, TELFLO_WEB_ORIGIN: "https://app.telflo.example/" });
    expect(settings.webOrigin).toBe("https://app.telflo.example");
  });

  it("rejects a token lifetime of zero, which would expire every link instantly", () => {
    expect(() =>
      loadSettings({ ...complete, TELFLO_VERIFICATION_TOKEN_TTL_HOURS: "0" }),
    ).toThrow(/TELFLO_VERIFICATION_TOKEN_TTL_HOURS/);
  });

  describe("mail transport", () => {
    const { TELFLO_SMTP_HOST: _host, TELFLO_SMTP_PORT: _port, ...withoutSmtp } = complete;
    const sendgrid = {
      ...withoutSmtp,
      TELFLO_MAIL_TRANSPORT: "sendgrid",
      TELFLO_SENDGRID_API_KEY: "SG.test-key",
    };

    it("selects sendgrid without requiring any SMTP variable", () => {
      expect(loadSettings(sendgrid).mail).toEqual({
        from: "no-reply@telflo.local",
        transport: { kind: "sendgrid", apiKey: "SG.test-key" },
      });
    });

    it("requires the sendgrid api key when sendgrid is selected", () => {
      const { TELFLO_SENDGRID_API_KEY: _key, ...rest } = sendgrid;
      expect(() => loadSettings(rest)).toThrow(/TELFLO_SENDGRID_API_KEY/);
    });

    it("requires the SMTP host when smtp is selected", () => {
      const { TELFLO_SMTP_HOST: _omitted, ...rest } = complete;
      expect(() => loadSettings(rest)).toThrow(/TELFLO_SMTP_HOST/);
    });

    it("requires a transport to be chosen rather than silently defaulting to one", () => {
      const { TELFLO_MAIL_TRANSPORT: _omitted, ...rest } = complete;
      expect(() => loadSettings(rest)).toThrow(/TELFLO_MAIL_TRANSPORT/);
    });

    it("rejects an unknown transport and names the valid ones", () => {
      expect(() => loadSettings({ ...complete, TELFLO_MAIL_TRANSPORT: "mailgun" })).toThrow(
        /TELFLO_MAIL_TRANSPORT must be one of smtp, sendgrid, received: mailgun/,
      );
    });

    it("enables cleartext SMTP to a non-loopback host only for the exact value true", () => {
      const settings = loadSettings({
        ...complete,
        TELFLO_SMTP_HOST: "mailpit",
        TELFLO_SMTP_ALLOW_INSECURE: "true",
      });
      expect(settings.mail.transport).toMatchObject({ kind: "smtp", allowInsecureTransport: true });
    });

    it("rejects an ambiguous value for the cleartext SMTP override rather than guessing", () => {
      expect(() => loadSettings({ ...complete, TELFLO_SMTP_ALLOW_INSECURE: "yes" })).toThrow(
        /TELFLO_SMTP_ALLOW_INSECURE must be "true" or "false", received: yes/,
      );
    });

    it("reads TELFLO_SMTP_TLS: starttls when unset or empty, each mode, and refuses another naming the modes (D36-1 decision 30)", () => {
      const tlsOf = (value: string | undefined) => {
        const { transport } = loadSettings(value === undefined ? complete : { ...complete, TELFLO_SMTP_TLS: value }).mail;
        return transport.kind === "smtp" ? transport.tls : undefined;
      };
      expect(tlsOf(undefined)).toBe("starttls");
      expect(tlsOf("")).toBe("starttls");
      for (const mode of ["starttls", "implicit", "none"]) expect(tlsOf(mode)).toBe(mode);
      for (const value of ["tls", "STARTTLS", "ssl", "true"]) {
        expect(refusalOf({ ...complete, TELFLO_SMTP_TLS: value })).toBe(
          "Environment variable TELFLO_SMTP_TLS must be one of starttls, implicit, none",
        );
      }
    });

    it("reads a login only when both TELFLO_SMTP_USERNAME and TELFLO_SMTP_PASSWORD are set, refusing one alone without a value", () => {
      const password = `cnry-smtp-password-${randomUUID()}`;
      const login = loadSettings({ ...complete, TELFLO_SMTP_USERNAME: "relay-user", TELFLO_SMTP_PASSWORD: password }).mail.transport;
      expect(login.kind === "smtp" && login.login?.username === "relay-user" && login.login.password === password).toBe(true);
      for (const env of [{}, { TELFLO_SMTP_USERNAME: "", TELFLO_SMTP_PASSWORD: "" }]) {
        const { transport } = loadSettings({ ...complete, ...env }).mail;
        expect(transport.kind === "smtp" && transport.login === null).toBe(true);
      }
      const message = "Environment variables TELFLO_SMTP_USERNAME and TELFLO_SMTP_PASSWORD must be set together, or neither";
      expect(refusalOf({ ...complete, TELFLO_SMTP_USERNAME: "relay-user" })).toBe(message);
      const alone = refusalOf({ ...complete, TELFLO_SMTP_PASSWORD: password });
      expect(alone === message && !alone.includes(password)).toBe(true);
    });

    it("never reads the SMTP settings with sendgrid", () => {
      expect(loadSettings({ ...sendgrid, TELFLO_SMTP_TLS: "bogus", TELFLO_SMTP_USERNAME: "alone", TELFLO_SMTP_CA_FILE: "relative" }).mail.transport).toEqual({
        kind: "sendgrid",
        apiKey: "SG.test-key",
      });
    });

    describe("the CA file (TELFLO_SMTP_CA_FILE)", () => {
      let folder: string;
      let caPem: string;
      let keyPem: string;
      beforeAll(() => {
        // A CA made here, at test time, in a folder of the test's own (no private key is committed).
        folder = mkdtempSync(join(tmpdir(), "telflo-settings-ca-"));
        for (const name of ["first", "second"]) {
          execFileSync(
            "openssl",
            ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", `/CN=telflo-settings-test-${name}`,
              "-keyout", join(folder, `${name}.key`), "-out", join(folder, `${name}.crt`)],
            { stdio: "ignore" },
          );
        }
        caPem = readFileSync(join(folder, "first.crt"), "utf8");
        keyPem = readFileSync(join(folder, "first.key"), "utf8");
      });
      afterAll(() => {
        rmSync(folder, { recursive: true, force: true });
      });
      const caOf = (path: string | undefined) => {
        const { transport } = loadSettings(path === undefined ? complete : { ...complete, TELFLO_SMTP_CA_FILE: path }).mail;
        return transport.kind === "smtp" ? transport.ca : undefined;
      };
      const write = (name: string, text: string) => {
        const path = join(folder, name);
        writeFileSync(path, text);
        return path;
      };
      const NOT_CERTIFICATES = "Environment variable TELFLO_SMTP_CA_FILE must name a file of PEM certificates only";

      it("is none when unset or empty", () => {
        expect(caOf(undefined)).toBeNull();
        expect(caOf("")).toBeNull();
      });

      it("reads one certificate, or several, as their PEM text", () => {
        expect(caOf(join(folder, "first.crt"))).toBe(caPem.trim() + "\n");
        const second = readFileSync(join(folder, "second.crt"), "utf8");
        const both = caOf(write("both.crt", `${caPem}\n${second}`));
        expect(both?.split("-----BEGIN CERTIFICATE-----").length).toBe(3);
        expect(both?.includes(second.trim())).toBe(true);
      });

      it("refuses a relative path, and a file that can't be read, naming the variable", () => {
        expect(refusalOf({ ...complete, TELFLO_SMTP_CA_FILE: "ca.crt" })).toBe("Environment variable TELFLO_SMTP_CA_FILE must be an absolute path");
        expect(refusalOf({ ...complete, TELFLO_SMTP_CA_FILE: join(folder, "missing.crt") })).toBe(
          "Environment variable TELFLO_SMTP_CA_FILE names a file that can't be read",
        );
      });

      it("refuses anything but PEM certificates (a private key beside one, an empty file, text, a broken certificate), quoting nothing of it", () => {
        const broken = caPem.replace(/^(-----BEGIN CERTIFICATE-----\n)[A-Za-z0-9+/]{8}/, "$1AAAAAAAA");
        for (const [name, text] of [
          ["with-key.crt", `${caPem}${keyPem}`],
          ["key-only.crt", keyPem],
          ["empty.crt", ""],
          ["text.crt", "cnry not a certificate\n"],
          ["stray.crt", `${caPem}cnry trailing text\n`],
          ["broken.crt", broken],
        ] as const) {
          const message = refusalOf({ ...complete, TELFLO_SMTP_CA_FILE: write(name, text) });
          expect(message === NOT_CERTIFICATES).toBe(true);
          expect(message.includes("cnry") || message.includes("PRIVATE")).toBe(false);
        }
      });
    });

    it("requires a sender address whichever transport is chosen", () => {
      const { TELFLO_MAIL_FROM: _omitted, ...rest } = sendgrid;
      expect(() => loadSettings(rest)).toThrow(/TELFLO_MAIL_FROM/);
    });
  });

  describe("access token secret", () => {
    it("rejects a missing access token secret", () => {
      const { TELFLO_ACCESS_TOKEN_SECRET: _omitted, ...rest } = complete;
      expect(() => loadSettings(rest)).toThrow(/TELFLO_ACCESS_TOKEN_SECRET/);
    });

    it("rejects a secret of 31 bytes", () => {
      expect(() => loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_SECRET: "a".repeat(31) })).toThrow(
        /TELFLO_ACCESS_TOKEN_SECRET must be at least 32 bytes/,
      );
    });

    it("accepts a secret of exactly 32 bytes", () => {
      const secret = "b".repeat(32);
      expect(loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_SECRET: secret }).accessTokenSecret).toBe(secret);
    });

    it("counts UTF-8 bytes rather than characters", () => {
      // 16 characters, 32 bytes: each "é" is two bytes in UTF-8.
      const secret = "é".repeat(16);
      expect(loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_SECRET: secret }).accessTokenSecret).toBe(secret);
      expect(() => loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_SECRET: "é".repeat(15) })).toThrow(
        /TELFLO_ACCESS_TOKEN_SECRET/,
      );
    });

    it("does not put a short secret into the error message", () => {
      const secret = "short-secret-value-do-not-log";
      let message = "";
      try {
        loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_SECRET: secret });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/TELFLO_ACCESS_TOKEN_SECRET/);
      expect(message).not.toContain(secret);
    });
  });

  describe("session lifetimes", () => {
    it("defaults the access token lifetime to 15 minutes", () => {
      expect(loadSettings(complete).accessTokenTtlMinutes).toBe(15);
    });

    it("accepts an access token lifetime from 1 to 15 minutes", () => {
      expect(loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_TTL_MINUTES: "1" }).accessTokenTtlMinutes).toBe(1);
      expect(loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_TTL_MINUTES: "15" }).accessTokenTtlMinutes).toBe(15);
    });

    it("rejects an access token lifetime of 0", () => {
      expect(() => loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_TTL_MINUTES: "0" })).toThrow(
        /TELFLO_ACCESS_TOKEN_TTL_MINUTES/,
      );
    });

    it("rejects an access token lifetime of 16", () => {
      expect(() => loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_TTL_MINUTES: "16" })).toThrow(
        /TELFLO_ACCESS_TOKEN_TTL_MINUTES/,
      );
    });

    it("rejects a non-integer access token lifetime rather than truncating it", () => {
      expect(() => loadSettings({ ...complete, TELFLO_ACCESS_TOKEN_TTL_MINUTES: "5m" })).toThrow(
        /TELFLO_ACCESS_TOKEN_TTL_MINUTES/,
      );
    });

    it("defaults the refresh token lifetime to 30 days", () => {
      expect(loadSettings(complete).refreshTokenTtlDays).toBe(30);
    });

    it("reads a refresh token lifetime", () => {
      expect(loadSettings({ ...complete, TELFLO_REFRESH_TOKEN_TTL_DAYS: "7" }).refreshTokenTtlDays).toBe(7);
    });

    it("rejects a refresh token lifetime of 0", () => {
      expect(() => loadSettings({ ...complete, TELFLO_REFRESH_TOKEN_TTL_DAYS: "0" })).toThrow(
        /TELFLO_REFRESH_TOKEN_TTL_DAYS/,
      );
    });
  });

  describe("cookie security", () => {
    it("defaults cookie security to true", () => {
      expect(loadSettings(complete).isCookieSecure).toBe(true);
    });

    it.each(["http://localhost:53000", "http://127.0.0.1:53000", "http://[::1]:53000"])(
      "accepts false for the loopback http public URL %s",
      (publicWebUrl) => {
        const settings = loadSettings({
          ...complete,
          TELFLO_PUBLIC_WEB_URL: publicWebUrl,
          TELFLO_COOKIE_SECURE: "false",
        });
        expect(settings.isCookieSecure).toBe(false);
      },
    );

    it("rejects false for an https public URL", () => {
      expect(() =>
        loadSettings({ ...complete, TELFLO_PUBLIC_WEB_URL: "https://telflo.example", TELFLO_COOKIE_SECURE: "false" }),
      ).toThrow(/TELFLO_COOKIE_SECURE/);
    });

    it("rejects false for an http public URL that is not loopback", () => {
      expect(() =>
        loadSettings({ ...complete, TELFLO_PUBLIC_WEB_URL: "http://telflo.example", TELFLO_COOKIE_SECURE: "false" }),
      ).toThrow(/TELFLO_COOKIE_SECURE/);
    });

    it("rejects false for a host that only starts with localhost", () => {
      expect(() =>
        loadSettings({
          ...complete,
          TELFLO_PUBLIC_WEB_URL: "http://localhost.telflo.example",
          TELFLO_COOKIE_SECURE: "false",
        }),
      ).toThrow(/TELFLO_COOKIE_SECURE/);
    });

    it("accepts true for any public URL", () => {
      const settings = loadSettings({
        ...complete,
        TELFLO_PUBLIC_WEB_URL: "https://telflo.example",
        TELFLO_COOKIE_SECURE: "true",
      });
      expect(settings.isCookieSecure).toBe(true);
    });

    it("rejects an ambiguous value rather than guessing", () => {
      expect(() => loadSettings({ ...complete, TELFLO_COOKIE_SECURE: "0" })).toThrow(
        /TELFLO_COOKIE_SECURE must be "true" or "false", received: 0/,
      );
    });
  });

  describe("proxy trust", () => {
    it("defaults proxy hops to 0", () => {
      expect(loadSettings(complete).trustProxyHops).toBe(0);
    });

    it("reads a hop count", () => {
      expect(loadSettings({ ...complete, TELFLO_TRUST_PROXY_HOPS: "1" }).trustProxyHops).toBe(1);
    });

    it("rejects -1", () => {
      expect(() => loadSettings({ ...complete, TELFLO_TRUST_PROXY_HOPS: "-1" })).toThrow(/TELFLO_TRUST_PROXY_HOPS/);
    });

    it("rejects true, which would trust every hop", () => {
      expect(() => loadSettings({ ...complete, TELFLO_TRUST_PROXY_HOPS: "true" })).toThrow(/TELFLO_TRUST_PROXY_HOPS/);
    });
  });
  describe("OIDC providers", () => {
    const google = {
      ...complete,
      TELFLO_OIDC_GOOGLE_CLIENT_ID: "google-client-id",
      TELFLO_OIDC_GOOGLE_CLIENT_SECRET: "google-client-secret-do-not-log",
    };

    it("configures no provider when neither the Google client ID nor secret is set", () => {
      expect(loadSettings(complete).oidcProviders).toEqual([]);
    });

    it("reads empty Google settings as unset", () => {
      const settings = loadSettings({
        ...complete,
        TELFLO_OIDC_GOOGLE_CLIENT_ID: "",
        TELFLO_OIDC_GOOGLE_CLIENT_SECRET: "",
        TELFLO_OIDC_GOOGLE_ISSUER: "",
      });
      expect(settings.oidcProviders).toEqual([]);
    });

    it("configures Google with its default issuer when the client ID and secret are set", () => {
      expect(loadSettings(google).oidcProviders).toEqual([
        {
          id: "google",
          name: "Google",
          issuer: "https://accounts.google.com",
          clientId: "google-client-id",
          clientSecret: "google-client-secret-do-not-log",
        },
      ]);
    });

    it("uses TELFLO_OIDC_GOOGLE_ISSUER when set", () => {
      const settings = loadSettings({ ...google, TELFLO_OIDC_GOOGLE_ISSUER: "https://issuer.telflo.example" });
      expect(settings.oidcProviders[0]?.issuer).toBe("https://issuer.telflo.example");
    });

    it("refuses a client ID without a secret", () => {
      const { TELFLO_OIDC_GOOGLE_CLIENT_SECRET: _omitted, ...rest } = google;
      expect(() => loadSettings(rest)).toThrow(
        /TELFLO_OIDC_GOOGLE_CLIENT_ID and TELFLO_OIDC_GOOGLE_CLIENT_SECRET must be set together/,
      );
    });

    it("refuses a secret without a client ID, and doesn't put the secret in the error", () => {
      const { TELFLO_OIDC_GOOGLE_CLIENT_ID: _omitted, ...rest } = google;
      let message = "";
      try {
        loadSettings(rest);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/TELFLO_OIDC_GOOGLE_CLIENT_ID and TELFLO_OIDC_GOOGLE_CLIENT_SECRET/);
      expect(message).not.toContain("google-client-secret-do-not-log");
    });

    it("refuses an http issuer that isn't loopback", () => {
      expect(() => loadSettings({ ...google, TELFLO_OIDC_GOOGLE_ISSUER: "http://example.com" })).toThrow(
        /TELFLO_OIDC_GOOGLE_ISSUER must be an https URL/,
      );
    });

    it("refuses an http issuer on a host that only starts with localhost", () => {
      expect(() =>
        loadSettings({ ...google, TELFLO_OIDC_GOOGLE_ISSUER: "http://localhost.telflo.example" }),
      ).toThrow(/TELFLO_OIDC_GOOGLE_ISSUER/);
    });

    it.each(["not a url", "ftp://issuer.telflo.example"])("refuses the issuer %s", (issuer) => {
      expect(() => loadSettings({ ...google, TELFLO_OIDC_GOOGLE_ISSUER: issuer })).toThrow(
        /TELFLO_OIDC_GOOGLE_ISSUER/,
      );
    });

    it.each(["http://127.0.0.1:28090", "http://localhost:28090", "http://[::1]:28090"])(
      "allows the loopback http issuer %s",
      (issuer) => {
        expect(loadSettings({ ...google, TELFLO_OIDC_GOOGLE_ISSUER: issuer }).oidcProviders[0]?.issuer).toBe(issuer);
      },
    );
  });

  describe("sales inquiries (D4 decision 4, D36-1 decision 25)", () => {
    it("have no address by default, and none is needed while they are off", () => {
      expect(loadSettings(complete).salesInquiryTo).toBe("");
      expect(loadSettings({ ...complete, TELFLO_SALES_INQUIRY_TO: "" }).salesInquiryTo).toBe("");
      expect(loadSettings({ ...complete, TELFLO_SALES_INQUIRY: "false" }).site.salesInquiry).toBe(false);
    });

    it("refuses TELFLO_SALES_INQUIRY true without an address, naming both variables", () => {
      for (const to of [undefined, ""]) {
        expect(refusalOf({ ...complete, TELFLO_SALES_INQUIRY: "true", ...(to === undefined ? {} : { TELFLO_SALES_INQUIRY_TO: to }) })).toBe(
          'Environment variable TELFLO_SALES_INQUIRY_TO is required while TELFLO_SALES_INQUIRY is "true" (where the inquiries go)',
        );
      }
      const settings = loadSettings({ ...complete, TELFLO_SALES_INQUIRY: "true", TELFLO_SALES_INQUIRY_TO: "sales@telflo.example" });
      expect(settings.site.salesInquiry).toBe(true);
      expect(settings.salesInquiryTo).toBe("sales@telflo.example");
    });

    it("reads an address, trimmed and lowercased as the contracts' email is", () => {
      expect(loadSettings({ ...complete, TELFLO_SALES_INQUIRY_TO: " Sales@Telflo.Example " }).salesInquiryTo).toBe(
        "sales@telflo.example",
      );
    });

    it.each([
      ["a malformed address", "not-an-address"],
      ["a list", "a@example.com, b@example.com"],
      ["an address over 254 characters", `${"a".repeat(250)}@example.com`],
    ])(
      "refuses %s, quoting nothing of it",
      (_label, value) => {
        const message = refusalOf({ ...complete, TELFLO_SALES_INQUIRY_TO: value });
        expect(message).toBe("Environment variable TELFLO_SALES_INQUIRY_TO must be an email address");
      },
    );
  });

  describe("the site (D36-1 decision 27; the contracts' parseSiteSettings)", () => {
    const SAAS = {
      TELFLO_REGISTRATION: "open",
      TELFLO_PLAYGROUND: "true",
      TELFLO_ANONYMOUS_VALIDATE: "true",
      TELFLO_PUBLIC_FLOWS: "true",
      TELFLO_EMAIL_NOTIFICATIONS: "true",
      TELFLO_TERMS_VERSION: "2026-01-01",
      TELFLO_TERMS_URL: "/home/terms-of-service",
      TELFLO_PRIVACY_URL: "/home/privacy-policy",
    };

    it("is the open source's defaults with none of its variables set", () => {
      expect(loadSettings(complete).site).toEqual({
        registration: "invite-only",
        playground: false,
        anonymousValidate: false,
        publicFlows: false,
        salesInquiry: false,
        emailNotifications: false,
        docsUrl: "https://docs.telflo.com/",
        terms: { version: "", termsUrl: "", privacyUrl: "", cookiePolicyUrl: "" },
      });
    });

    it("reads the SaaS's values", () => {
      expect(loadSettings({ ...complete, ...SAAS }).site).toMatchObject({
        registration: "open",
        playground: true,
        anonymousValidate: true,
        publicFlows: true,
        emailNotifications: true,
        terms: { version: "2026-01-01", termsUrl: "/home/terms-of-service", privacyUrl: "/home/privacy-policy", cookiePolicyUrl: "" },
      });
    });

    it.each([
      ["an unknown registration mode", { TELFLO_REGISTRATION: "public" }, "Environment variable TELFLO_REGISTRATION must be one of open, invite-only, closed"],
      ["a switch that isn't true or false", { TELFLO_PUBLIC_FLOWS: "yes" }, 'Environment variable TELFLO_PUBLIC_FLOWS must be "true" or "false"'],
      [
        "Settings › Notifications' switch that isn't true or false",
        { TELFLO_EMAIL_NOTIFICATIONS: "on" },
        'Environment variable TELFLO_EMAIL_NOTIFICATIONS must be "true" or "false"',
      ],
      [
        "the playground without the anonymous reads",
        { TELFLO_PLAYGROUND: "true" },
        'Environment variable TELFLO_PLAYGROUND may be "true" only with TELFLO_ANONYMOUS_VALIDATE and TELFLO_PUBLIC_FLOWS "true" too (the playground needs both)',
      ],
      [
        "a Terms version without its URLs",
        { TELFLO_TERMS_VERSION: "2026-01-01" },
        "Environment variable TELFLO_TERMS_VERSION needs TELFLO_TERMS_URL and TELFLO_PRIVACY_URL set too (what is accepted must be readable)",
      ],
      [
        "a URL with a user and password",
        { TELFLO_DOCS_URL: "https://cnryuser:cnrypw@docs.example.com/" },
        "Environment variable TELFLO_DOCS_URL must be an https URL (a host, an optional port and path, no user name or password) or a path starting with a single /, of URL characters only",
      ],
    ])("refuses %s at boot, naming the variable and the rule, never a value", (_label, env, expected) => {
      const message = refusalOf({ ...complete, ...env });
      expect(message === expected).toBe(true);
      expect(message.includes("cnry")).toBe(false);
    });

    // Preflight ruling 19 (Q251): the development stack runs the open source's defaults unless the
    // environment compose reads sets a value; the web gets the same variables as the API.
    it("compose's API and web environments take every site variable by interpolation, with the open source's defaults", () => {
      const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const compose = parseYaml(readFileSync(resolve(repositoryRoot, "docker-compose.yml"), "utf8")) as {
        services: Record<string, { environment?: Record<string, string> }>;
      };
      const expected: Record<string, string> = {
        TELFLO_REGISTRATION: "${TELFLO_REGISTRATION:-invite-only}",
        TELFLO_PLAYGROUND: "${TELFLO_PLAYGROUND:-false}",
        TELFLO_ANONYMOUS_VALIDATE: "${TELFLO_ANONYMOUS_VALIDATE:-false}",
        TELFLO_PUBLIC_FLOWS: "${TELFLO_PUBLIC_FLOWS:-false}",
        TELFLO_SALES_INQUIRY: "${TELFLO_SALES_INQUIRY:-false}",
        TELFLO_EMAIL_NOTIFICATIONS: "${TELFLO_EMAIL_NOTIFICATIONS:-false}",
        // Without the colon: an empty value hides the docs links, and only an unset one is the default.
        TELFLO_DOCS_URL: "${TELFLO_DOCS_URL-https://docs.telflo.com/}",
        TELFLO_TERMS_VERSION: "${TELFLO_TERMS_VERSION:-}",
        TELFLO_TERMS_URL: "${TELFLO_TERMS_URL:-}",
        TELFLO_PRIVACY_URL: "${TELFLO_PRIVACY_URL:-}",
        TELFLO_COOKIE_POLICY_URL: "${TELFLO_COOKIE_POLICY_URL:-}",
      };
      for (const service of ["api", "web"]) {
        const environment = compose.services[service]!.environment!;
        for (const [name, value] of Object.entries(expected)) expect([service, name, environment[name]]).toEqual([service, name, value]);
      }
      const api = compose.services["api"]!.environment!;
      expect(api.TELFLO_SALES_INQUIRY_TO).toBe("${TELFLO_SALES_INQUIRY_TO:-}");
      // Mailpit takes plain SMTP (decision 30: development sets none).
      expect(api.TELFLO_SMTP_TLS).toBe("none");
      // The defaults, as compose fills them in with nothing set, load.
      const filled = Object.fromEntries(
        Object.entries(expected).map(([name, value]) => [name, /^\$\{[A-Z_]+:?-(.*)\}$/.exec(value)![1]!]),
      );
      expect(loadSettings({ ...complete, ...filled }).site).toEqual(OPEN_SOURCE_SITE);
    });
  });

  describe("the opamp-server's management API", () => {
    const secret = complete.TELFLO_OPAMP_MANAGEMENT_SECRET;
    const opamp = complete;
    const BOTH_REQUIRED =
      "Environment variables TELFLO_OPAMP_MANAGEMENT_URL and TELFLO_OPAMP_MANAGEMENT_SECRET are both required (the opamp-server's management API)";

    function messageOf(env: NodeJS.ProcessEnv): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    it("is set when both the URL and the secret are", () => {
      expect(loadSettings(opamp).opampServer).toEqual({ url: "http://opamp-server:51235", secret });
    });

    it("refuses to start with neither, naming both variables (D11b decision 8)", () => {
      const { TELFLO_OPAMP_MANAGEMENT_URL: _url, TELFLO_OPAMP_MANAGEMENT_SECRET: _secret, ...rest } = opamp;
      expect(messageOf(rest)).toBe(
        `${BOTH_REQUIRED}; missing: TELFLO_OPAMP_MANAGEMENT_URL, TELFLO_OPAMP_MANAGEMENT_SECRET`,
      );
    });

    it("reads empty settings as missing, and refuses them", () => {
      const message = messageOf({ ...opamp, TELFLO_OPAMP_MANAGEMENT_URL: "", TELFLO_OPAMP_MANAGEMENT_SECRET: "" });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OPAMP_MANAGEMENT_URL, TELFLO_OPAMP_MANAGEMENT_SECRET`);
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses the URL alone (the secret %s), naming both variables and never a value", (_label, value) => {
      const { TELFLO_OPAMP_MANAGEMENT_SECRET: _omitted, ...rest } = opamp;
      const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_OPAMP_MANAGEMENT_SECRET: value });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OPAMP_MANAGEMENT_SECRET`);
      expect(message).not.toContain("opamp-server:51235");
      expect(message).not.toContain("51235");
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses the secret alone (the URL %s), naming both variables and never the secret", (_label, value) => {
      const { TELFLO_OPAMP_MANAGEMENT_URL: _omitted, ...rest } = opamp;
      const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_OPAMP_MANAGEMENT_URL: value });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OPAMP_MANAGEMENT_URL`);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("do-not-log");
    });

    it("refuses a secret of 31 bytes, without quoting it", () => {
      const short = "s".repeat(31);
      const message = messageOf({ ...opamp, TELFLO_OPAMP_MANAGEMENT_SECRET: short });
      expect(message).toBe("Environment variable TELFLO_OPAMP_MANAGEMENT_SECRET must be at least 32 bytes, received 31");
      expect(message).not.toContain(short);
    });

    it("accepts a secret of exactly 32 bytes, counted in UTF-8", () => {
      expect(loadSettings({ ...opamp, TELFLO_OPAMP_MANAGEMENT_SECRET: "s".repeat(32) }).opampServer.secret).toBe(
        "s".repeat(32),
      );
      // 16 characters, 32 bytes.
      expect(loadSettings({ ...opamp, TELFLO_OPAMP_MANAGEMENT_SECRET: "é".repeat(16) }).opampServer.secret).toBe(
        "é".repeat(16),
      );
    });

    it.each(["ftp://opamp-server:51235", "opamp-server:51235", "not a url"])(
      "refuses the URL %s without quoting it",
      (url) => {
        const message = messageOf({ ...opamp, TELFLO_OPAMP_MANAGEMENT_URL: url });
        expect(message).toBe("Environment variable TELFLO_OPAMP_MANAGEMENT_URL must be an http or https URL");
      },
    );

    it("never quotes a URL it refuses, which could carry credentials", () => {
      const message = messageOf({ ...opamp, TELFLO_OPAMP_MANAGEMENT_URL: "ftp://user:url-password@host" });
      expect(message).not.toContain("url-password");
    });

    it.each(["http://user:url-password@opamp-server:51235", "https://url-user@opamp.internal.example", "http://:url-password@host"])(
      "refuses a URL carrying a user name or password, without quoting it (Ruling 55)",
      (url) => {
        const message = messageOf({ ...opamp, TELFLO_OPAMP_MANAGEMENT_URL: url });
        expect(message).toBe("Environment variable TELFLO_OPAMP_MANAGEMENT_URL must not carry a user name or password");
        expect(message).not.toContain("url-password");
        expect(message).not.toContain("url-user");
      },
    );

    it("accepts https, and strips a trailing slash", () => {
      const settings = loadSettings({ ...opamp, TELFLO_OPAMP_MANAGEMENT_URL: "https://opamp.internal.example/" });
      expect(settings.opampServer.url).toBe("https://opamp.internal.example");
    });
  });
  describe("the collector validator (D13b decision 12)", () => {
    const secret = complete.TELFLO_OTELCOL_VALIDATOR_SECRET;
    const BOTH_REQUIRED =
      "Environment variables TELFLO_OTELCOL_VALIDATOR_URL and TELFLO_OTELCOL_VALIDATOR_SECRET are both required (the collector validator)";

    function messageOf(env: NodeJS.ProcessEnv): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    it("is set when both the URL and the secret are", () => {
      expect(loadSettings(complete).otelcolValidator).toEqual({ url: "http://otelcol-validator:8001", secret });
    });

    it("refuses to start with neither, naming both variables", () => {
      const { TELFLO_OTELCOL_VALIDATOR_URL: _url, TELFLO_OTELCOL_VALIDATOR_SECRET: _secret, ...rest } = complete;
      expect(messageOf(rest)).toBe(
        `${BOTH_REQUIRED}; missing: TELFLO_OTELCOL_VALIDATOR_URL, TELFLO_OTELCOL_VALIDATOR_SECRET`,
      );
    });

    it("reads empty settings as missing, and refuses them", () => {
      const message = messageOf({ ...complete, TELFLO_OTELCOL_VALIDATOR_URL: "", TELFLO_OTELCOL_VALIDATOR_SECRET: "" });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTELCOL_VALIDATOR_URL, TELFLO_OTELCOL_VALIDATOR_SECRET`);
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses the URL alone (the secret %s), naming both variables and never a value", (_label, value) => {
      const { TELFLO_OTELCOL_VALIDATOR_SECRET: _omitted, ...rest } = complete;
      const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_OTELCOL_VALIDATOR_SECRET: value });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTELCOL_VALIDATOR_SECRET`);
      expect(message).not.toContain("otelcol-validator:8001");
      expect(message).not.toContain("8001");
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses the secret alone (the URL %s), naming both variables and never the secret", (_label, value) => {
      const { TELFLO_OTELCOL_VALIDATOR_URL: _omitted, ...rest } = complete;
      const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_OTELCOL_VALIDATOR_URL: value });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTELCOL_VALIDATOR_URL`);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("do-not-log");
    });

    it("refuses a secret of 31 bytes, without quoting it", () => {
      const short = "v".repeat(31);
      const message = messageOf({ ...complete, TELFLO_OTELCOL_VALIDATOR_SECRET: short });
      expect(message).toBe("Environment variable TELFLO_OTELCOL_VALIDATOR_SECRET must be at least 32 bytes, received 31");
      expect(message).not.toContain(short);
    });

    it("accepts a secret of exactly 32 bytes, counted in UTF-8", () => {
      expect(loadSettings({ ...complete, TELFLO_OTELCOL_VALIDATOR_SECRET: "v".repeat(32) }).otelcolValidator.secret).toBe(
        "v".repeat(32),
      );
      // 16 characters, 32 bytes.
      expect(loadSettings({ ...complete, TELFLO_OTELCOL_VALIDATOR_SECRET: "é".repeat(16) }).otelcolValidator.secret).toBe(
        "é".repeat(16),
      );
    });

    it.each(["ftp://otelcol-validator:8001", "otelcol-validator:8001", "not a url"])(
      "refuses the URL %s without quoting it",
      (url) => {
        const message = messageOf({ ...complete, TELFLO_OTELCOL_VALIDATOR_URL: url });
        expect(message).toBe("Environment variable TELFLO_OTELCOL_VALIDATOR_URL must be an http or https URL");
      },
    );

    it("never quotes a URL it refuses, which could carry credentials", () => {
      const message = messageOf({ ...complete, TELFLO_OTELCOL_VALIDATOR_URL: "ftp://user:url-password@host" });
      expect(message).not.toContain("url-password");
    });

    it.each(["http://user:url-password@otelcol-validator:8001", "https://url-user@validator.internal.example", "http://:url-password@host"])(
      "refuses a URL carrying a user name or password, without quoting it (Ruling 55)",
      (url) => {
        const message = messageOf({ ...complete, TELFLO_OTELCOL_VALIDATOR_URL: url });
        expect(message).toBe("Environment variable TELFLO_OTELCOL_VALIDATOR_URL must not carry a user name or password");
        expect(message).not.toContain("url-password");
        expect(message).not.toContain("url-user");
      },
    );

    it("accepts https, and strips a trailing slash", () => {
      const settings = loadSettings({ ...complete, TELFLO_OTELCOL_VALIDATOR_URL: "https://validator.internal.example//" });
      expect(settings.otelcolValidator.url).toBe("https://validator.internal.example");
    });
  });
  describe("the collector tester (D14a decision 30)", () => {
    const secret = complete.TELFLO_OTELCOL_TESTING_SECRET;
    const BOTH_REQUIRED =
      "Environment variables TELFLO_OTELCOL_TESTING_URL and TELFLO_OTELCOL_TESTING_SECRET are both required (the collector tester)";

    function messageOf(env: NodeJS.ProcessEnv): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    it("is set when both the URL and the secret are", () => {
      expect(loadSettings(complete).otelcolTesting).toEqual({ url: "http://otelcol-testing:8002", secret });
    });

    it("refuses to start with neither, naming both variables", () => {
      const { TELFLO_OTELCOL_TESTING_URL: _url, TELFLO_OTELCOL_TESTING_SECRET: _secret, ...rest } = complete;
      expect(messageOf(rest)).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTELCOL_TESTING_URL, TELFLO_OTELCOL_TESTING_SECRET`);
    });

    it("reads empty settings as missing, and refuses them", () => {
      const message = messageOf({ ...complete, TELFLO_OTELCOL_TESTING_URL: "", TELFLO_OTELCOL_TESTING_SECRET: "" });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTELCOL_TESTING_URL, TELFLO_OTELCOL_TESTING_SECRET`);
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses the URL alone (the secret %s), naming both variables and never a value", (_label, value) => {
      const { TELFLO_OTELCOL_TESTING_SECRET: _omitted, ...rest } = complete;
      const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_OTELCOL_TESTING_SECRET: value });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTELCOL_TESTING_SECRET`);
      expect(message).not.toContain("otelcol-testing:8002");
      expect(message).not.toContain("8002");
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses the secret alone (the URL %s), naming both variables and never the secret", (_label, value) => {
      const { TELFLO_OTELCOL_TESTING_URL: _omitted, ...rest } = complete;
      const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_OTELCOL_TESTING_URL: value });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTELCOL_TESTING_URL`);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("do-not-log");
    });

    it("refuses a secret of 31 bytes, without quoting it", () => {
      const short = "t".repeat(31);
      const message = messageOf({ ...complete, TELFLO_OTELCOL_TESTING_SECRET: short });
      expect(message).toBe("Environment variable TELFLO_OTELCOL_TESTING_SECRET must be at least 32 bytes, received 31");
      expect(message).not.toContain(short);
    });

    it("accepts a secret of exactly 32 bytes, counted in UTF-8", () => {
      expect(loadSettings({ ...complete, TELFLO_OTELCOL_TESTING_SECRET: "t".repeat(32) }).otelcolTesting.secret).toBe(
        "t".repeat(32),
      );
      // 16 characters, 32 bytes.
      expect(loadSettings({ ...complete, TELFLO_OTELCOL_TESTING_SECRET: "é".repeat(16) }).otelcolTesting.secret).toBe(
        "é".repeat(16),
      );
    });

    it.each(["ftp://otelcol-testing:8002", "otelcol-testing:8002", "not a url"])(
      "refuses the URL %s without quoting it",
      (url) => {
        const message = messageOf({ ...complete, TELFLO_OTELCOL_TESTING_URL: url });
        expect(message).toBe("Environment variable TELFLO_OTELCOL_TESTING_URL must be an http or https URL");
      },
    );

    it.each(["http://user:url-password@otelcol-testing:8002", "https://url-user@tester.internal.example", "http://:url-password@host"])(
      "refuses a URL carrying a user name or password, without quoting it",
      (url) => {
        const message = messageOf({ ...complete, TELFLO_OTELCOL_TESTING_URL: url });
        expect(message).toBe("Environment variable TELFLO_OTELCOL_TESTING_URL must not carry a user name or password");
        expect(message).not.toContain("url-password");
        expect(message).not.toContain("url-user");
      },
    );

    it("accepts https, and strips trailing slashes", () => {
      const settings = loadSettings({ ...complete, TELFLO_OTELCOL_TESTING_URL: "https://tester.internal.example//" });
      expect(settings.otelcolTesting.url).toBe("https://tester.internal.example");
    });

    it("accepts the native development URL, through the forwarder (Preflight ruling 4)", () => {
      expect(loadSettings({ ...complete, TELFLO_OTELCOL_TESTING_URL: "http://127.0.0.1:51237" }).otelcolTesting.url).toBe(
        "http://127.0.0.1:51237",
      );
    });
  });
  describe("the OTTL evaluator (D15a detail 26)", () => {
    const secret = complete.TELFLO_OTTL_EVALUATOR_SECRET;
    const BOTH_REQUIRED =
      "Environment variables TELFLO_OTTL_EVALUATOR_URL and TELFLO_OTTL_EVALUATOR_SECRET are both required (the OTTL evaluator)";

    function messageOf(env: NodeJS.ProcessEnv): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    it("is set when both the URL and the secret are", () => {
      expect(loadSettings(complete).ottlEvaluator).toEqual({ url: "http://ottl-evaluator:8003", secret });
    });

    it("refuses to start with neither, naming both variables", () => {
      const { TELFLO_OTTL_EVALUATOR_URL: _url, TELFLO_OTTL_EVALUATOR_SECRET: _secret, ...rest } = complete;
      expect(messageOf(rest)).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTTL_EVALUATOR_URL, TELFLO_OTTL_EVALUATOR_SECRET`);
    });

    it("reads empty settings as missing, and refuses them", () => {
      const message = messageOf({ ...complete, TELFLO_OTTL_EVALUATOR_URL: "", TELFLO_OTTL_EVALUATOR_SECRET: "" });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTTL_EVALUATOR_URL, TELFLO_OTTL_EVALUATOR_SECRET`);
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses the URL alone (the secret %s), naming both variables and never a value", (_label, value) => {
      const { TELFLO_OTTL_EVALUATOR_SECRET: _omitted, ...rest } = complete;
      const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_OTTL_EVALUATOR_SECRET: value });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTTL_EVALUATOR_SECRET`);
      expect(message).not.toContain("ottl-evaluator:8003");
      expect(message).not.toContain("8003");
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses the secret alone (the URL %s), naming both variables and never the secret", (_label, value) => {
      const { TELFLO_OTTL_EVALUATOR_URL: _omitted, ...rest } = complete;
      const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_OTTL_EVALUATOR_URL: value });
      expect(message).toBe(`${BOTH_REQUIRED}; missing: TELFLO_OTTL_EVALUATOR_URL`);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("do-not-log");
    });

    it("refuses a secret of 31 bytes (the evaluator's own minimum is 32), without quoting it", () => {
      const short = "e".repeat(31);
      const message = messageOf({ ...complete, TELFLO_OTTL_EVALUATOR_SECRET: short });
      expect(message).toBe("Environment variable TELFLO_OTTL_EVALUATOR_SECRET must be at least 32 bytes, received 31");
      expect(message).not.toContain(short);
    });

    it("accepts a secret of exactly 32 bytes, counted in UTF-8", () => {
      expect(loadSettings({ ...complete, TELFLO_OTTL_EVALUATOR_SECRET: "e".repeat(32) }).ottlEvaluator.secret).toBe("e".repeat(32));
      // 16 characters, 32 bytes.
      expect(loadSettings({ ...complete, TELFLO_OTTL_EVALUATOR_SECRET: "é".repeat(16) }).ottlEvaluator.secret).toBe("é".repeat(16));
    });

    it.each(["ftp://ottl-evaluator:8003", "ottl-evaluator:8003", "not a url"])(
      "refuses the URL %s without quoting it",
      (url) => {
        const message = messageOf({ ...complete, TELFLO_OTTL_EVALUATOR_URL: url });
        expect(message).toBe("Environment variable TELFLO_OTTL_EVALUATOR_URL must be an http or https URL");
      },
    );

    it.each(["http://user:url-password@ottl-evaluator:8003", "https://url-user@evaluator.internal.example", "http://:url-password@host"])(
      "refuses a URL carrying a user name or password, without quoting it",
      (url) => {
        const message = messageOf({ ...complete, TELFLO_OTTL_EVALUATOR_URL: url });
        expect(message).toBe("Environment variable TELFLO_OTTL_EVALUATOR_URL must not carry a user name or password");
        expect(message).not.toContain("url-password");
        expect(message).not.toContain("url-user");
      },
    );

    it("accepts https, and strips trailing slashes", () => {
      const settings = loadSettings({ ...complete, TELFLO_OTTL_EVALUATOR_URL: "https://evaluator.internal.example//" });
      expect(settings.ottlEvaluator.url).toBe("https://evaluator.internal.example");
    });

    it("accepts the native development URL, through its forwarder (Preflight ruling 13)", () => {
      expect(loadSettings({ ...complete, TELFLO_OTTL_EVALUATOR_URL: "http://127.0.0.1:51238" }).ottlEvaluator.url).toBe(
        "http://127.0.0.1:51238",
      );
    });
  });
  describe("the test runs' dispatcher (D14a decisions 1, 12 and 30)", () => {
    function messageOf(env: NodeJS.ProcessEnv): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    it("defaults to 4 runs at once and failing waiting runs after 600 s down", () => {
      expect(loadSettings(complete).testRuns).toEqual({ runsPerTester: 4, downFailAfterSeconds: 600 });
      expect(
        loadSettings({ ...complete, TELFLO_TEST_RUNS_PER_TESTER: "", TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS: "" }).testRuns,
      ).toEqual({ runsPerTester: 4, downFailAfterSeconds: 600 });
    });

    it("reads both when set (the browser tests' 16, Preflight ruling 20)", () => {
      expect(
        loadSettings({ ...complete, TELFLO_TEST_RUNS_PER_TESTER: "16", TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS: "1" }).testRuns,
      ).toEqual({ runsPerTester: 16, downFailAfterSeconds: 1 });
      expect(loadSettings({ ...complete, TELFLO_TEST_RUNS_PER_TESTER: "1" }).testRuns.runsPerTester).toBe(1);
    });

    it("takes at most 64 runs per tester (Ruling 38)", () => {
      expect(loadSettings({ ...complete, TELFLO_TEST_RUNS_PER_TESTER: "64" }).testRuns.runsPerTester).toBe(64);
    });

    it.each(["0", "-1", "1.5", "four", "4 ", "0x4", "65", "400"])("refuses %j runs per tester: 1 to 64", (value) => {
      expect(messageOf({ ...complete, TELFLO_TEST_RUNS_PER_TESTER: value })).toBe(
        `Environment variable TELFLO_TEST_RUNS_PER_TESTER must be an integer from 1 to 64, received: ${value}`,
      );
    });

    it("takes at most a day for the down rule (Ruling 41)", () => {
      expect(loadSettings({ ...complete, TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS: "86400" }).testRuns.downFailAfterSeconds).toBe(86_400);
    });

    it.each(["0", "-600", "600.5", "10m", "true", "86401", "9999999999999"])("refuses %j seconds for the down rule: 1 to 86,400", (value) => {
      expect(messageOf({ ...complete, TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS: value })).toBe(
        `Environment variable TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS must be an integer from 1 to 86400, received: ${value}`,
      );
    });
  });
  describe("the file store (D14a decision 2; D23-1 decisions 15 and 36)", () => {
    function messageOf(env: NodeJS.ProcessEnv): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    // compose's values (Preflight ruling 17), beside the complete environment's root.
    const s3: Record<string, string> = {
      ...complete,
      TELFLO_FILE_STORE: "s3",
      TELFLO_FILE_STORE_BUCKET: "telflo-files",
      TELFLO_FILE_STORE_S3_REGION: "us-east-1",
      TELFLO_FILE_STORE_S3_ENDPOINT: "http://object-store:8333",
      TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE: "true",
    };
    const without = (env: Record<string, string>, ...names: string[]): Record<string, string> =>
      Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));

    describe("the local disk", () => {
      it("reads an absolute path, as given", () => {
        expect(loadSettings(complete).fileStore).toEqual({ kind: "local", root: "/var/lib/telflo/file-store" });
      });

      it.each([
        ["absent", undefined],
        ["empty", ""],
        ["local", "local"],
      ])("is the kind when TELFLO_FILE_STORE is %s", (_case, kind) => {
        const env = kind === undefined ? complete : { ...complete, TELFLO_FILE_STORE: kind };
        expect(loadSettings(env).fileStore).toEqual({ kind: "local", root: "/var/lib/telflo/file-store" });
      });

      it.each([
        ["missing", undefined],
        ["empty", ""],
      ])("refuses to start when the root is %s, naming the variable", (_case, value) => {
        const rest = without(complete, "TELFLO_FILE_STORE_ROOT");
        const message = messageOf(value === undefined ? rest : { ...rest, TELFLO_FILE_STORE_ROOT: value });
        expect(message).toBe("Missing required environment variable: TELFLO_FILE_STORE_ROOT");
      });

      it.each(["file-store", "./file-store", "../file-store", "~/file-store"])(
        "refuses a relative path (%s): the root must not depend on where the API started",
        (root) => {
          expect(messageOf({ ...complete, TELFLO_FILE_STORE_ROOT: root })).toBe(
            `Environment variable TELFLO_FILE_STORE_ROOT must be an absolute path, received: ${root}`,
          );
        },
      );

      it("touches no file: a root that doesn't exist is the start's to refuse (createFileStore)", () => {
        const root = "/nonexistent/telflo-settings-test/file-store";
        expect(loadSettings({ ...complete, TELFLO_FILE_STORE_ROOT: root }).fileStore).toEqual({ kind: "local", root });
      });

      it("ignores every S3 value, even invalid ones: compose sets them for every install (Preflight ruling 17)", () => {
        const env = {
          ...complete,
          TELFLO_FILE_STORE: "local",
          TELFLO_FILE_STORE_BUCKET: "Not A Bucket",
          TELFLO_FILE_STORE_PREFIX: "/../x",
          TELFLO_FILE_STORE_S3_REGION: "US EAST",
          TELFLO_FILE_STORE_S3_ENDPOINT: "ftp://example.com/path?q#f",
          TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE: "yes",
        };
        expect(loadSettings(env).fileStore).toEqual({ kind: "local", root: "/var/lib/telflo/file-store" });
      });
    });

    describe("an S3-protocol bucket", () => {
      it("reads the bucket, the region, the endpoint and the path style, with no prefix", () => {
        expect(loadSettings(s3).fileStore).toEqual({
          kind: "s3",
          bucket: "telflo-files",
          prefix: "",
          region: "us-east-1",
          endpoint: "http://object-store:8333",
          forcePathStyle: true,
        });
      });

      it("defaults to AWS's own endpoint for the region and virtual-hosted style, when absent or empty", () => {
        const expected = {
          kind: "s3",
          bucket: "telflo-files",
          prefix: "",
          region: "us-east-1",
          endpoint: undefined,
          forcePathStyle: false,
        };
        const absent = without(s3, "TELFLO_FILE_STORE_S3_ENDPOINT", "TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE");
        expect(loadSettings(absent).fileStore).toEqual(expected);
        const empty = { ...s3, TELFLO_FILE_STORE_S3_ENDPOINT: "", TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE: "" };
        expect(loadSettings(empty).fileStore).toEqual(expected);
      });

      it.each([
        ["missing", undefined],
        ["empty", ""],
        ["relative", "file-store"],
      ])("ignores the root when it is %s", (_case, root) => {
        const rest = without(s3, "TELFLO_FILE_STORE_ROOT");
        const fileStore = loadSettings(root === undefined ? rest : { ...rest, TELFLO_FILE_STORE_ROOT: root }).fileStore;
        expect(fileStore.kind).toBe("s3");
        expect(fileStore).not.toHaveProperty("root");
      });

      it.each([
        ["acme", "acme/"],
        ["acme/", "acme/"],
        ["acme/prod", "acme/prod/"],
        ["acme/prod/", "acme/prod/"],
        ["a.b_c-d/0", "a.b_c-d/0/"],
        ["", ""],
      ])("stores the prefix %j as %j: one trailing /, or none", (prefix, stored) => {
        expect(loadSettings({ ...s3, TELFLO_FILE_STORE_PREFIX: prefix }).fileStore).toMatchObject({ prefix: stored });
      });

      it("takes a prefix of 256 characters with its trailing /, given with it or without", () => {
        const prefix = `${"a".repeat(127)}/${"b".repeat(127)}/`;
        expect(prefix).toHaveLength(256);
        expect(loadSettings({ ...s3, TELFLO_FILE_STORE_PREFIX: prefix }).fileStore).toMatchObject({ prefix });
        expect(loadSettings({ ...s3, TELFLO_FILE_STORE_PREFIX: prefix.slice(0, -1) }).fileStore).toMatchObject({ prefix });
      });

      it.each(["abc", "a".repeat(63), "telflo.files-1", "0telflo9"])("takes the bucket %s", (bucket) => {
        expect(loadSettings({ ...s3, TELFLO_FILE_STORE_BUCKET: bucket }).fileStore).toMatchObject({ bucket });
      });

      it.each(["us-east-1", "eu-central-2", "a", "a".repeat(32)])("takes the region %s", (region) => {
        expect(loadSettings({ ...s3, TELFLO_FILE_STORE_S3_REGION: region }).fileStore).toMatchObject({ region });
      });

      it.each([
        ["http://127.0.0.1:51240", "http://127.0.0.1:51240"],
        ["http://127.0.0.1:51240/", "http://127.0.0.1:51240"],
        ["https://s3.example.com", "https://s3.example.com"],
        ["https://S3.Example.com:443/", "https://s3.example.com"],
        ["http://[::1]:8333", "http://[::1]:8333"],
        ["http://[::1]:51240/", "http://[::1]:51240"],
        ["http://localhost:51240", "http://localhost:51240"],
        ["https://xn--bcher-kva.example", "https://xn--bcher-kva.example"],
        ["https://s3.example.com:65535", "https://s3.example.com:65535"],
        ["http://objects.example.test:1", "http://objects.example.test:1"],
      ])("takes the endpoint %s, stored as its origin %s", (endpoint, stored) => {
        expect(loadSettings({ ...s3, TELFLO_FILE_STORE_S3_ENDPOINT: endpoint }).fileStore).toMatchObject({ endpoint: stored });
      });

      it("takes false for the path style", () => {
        expect(loadSettings({ ...s3, TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE: "false" }).fileStore).toMatchObject({
          forcePathStyle: false,
        });
      });

      it.each([
        ["missing", undefined],
        ["empty", ""],
      ])("refuses to start when the bucket is %s, naming the variable", (_case, bucket) => {
        const rest = without(s3, "TELFLO_FILE_STORE_BUCKET");
        expect(messageOf(bucket === undefined ? rest : { ...rest, TELFLO_FILE_STORE_BUCKET: bucket })).toBe(
          "Missing required environment variable: TELFLO_FILE_STORE_BUCKET",
        );
      });

      it.each([
        ["too short", "ab"],
        ["too long", "a".repeat(64)],
        ["upper-case", "Telflo-files"],
        ["a leading dot", ".telflo-files"],
        ["a trailing dot", "telflo-files."],
        ["a leading hyphen", "-telflo-files"],
        ["a trailing hyphen", "telflo-files-"],
        ["..", "telflo..files"],
        ["an underscore", "telflo_files"],
        ["a slash", "telflo/files"],
        ["a space", "telflo files"],
      ])("refuses a bucket with %s, showing it", (_case, bucket) => {
        expect(messageOf({ ...s3, TELFLO_FILE_STORE_BUCKET: bucket })).toBe(
          `Environment variable TELFLO_FILE_STORE_BUCKET must be an S3 bucket name: 3 to 63 lower-case letters, digits, dots and hyphens, beginning and ending with a letter or digit, with no "..", received: ${bucket}`,
        );
      });

      it.each([
        ["a leading /", "/acme"],
        ["only /", "/"],
        ["a .. segment", "acme/../other"],
        ["a . segment", "acme/./prod"],
        ["a leading .. segment", "../acme"],
        ["only .", "."],
        ["an empty segment", "acme//prod"],
        ["two trailing slashes", "acme//"],
        ["a segment beginning with a dot", "acme/.hidden"],
        ["a segment beginning with a hyphen", "-acme"],
        ["upper-case", "Acme"],
        ["a space", "acme prod"],
        ["a backslash", "acme\\prod"],
        ["a colon", "acme:prod"],
        ["a percent sign", "acme%2Fprod"],
      ])("refuses a prefix with %s, showing it", (_case, prefix) => {
        expect(messageOf({ ...s3, TELFLO_FILE_STORE_PREFIX: prefix })).toBe(
          `Environment variable TELFLO_FILE_STORE_PREFIX must be segments of lower-case letters, digits, dots, underscores and hyphens, each beginning with a letter or digit, separated by / (no leading /, no . or .. segment), received: ${prefix}`,
        );
      });

      it.each([
        ["257 characters with its trailing /", `${"a".repeat(128)}/${"b".repeat(127)}/`],
        ["256 characters without it", `${"a".repeat(128)}/${"b".repeat(127)}`],
      ])("refuses a prefix of %s", (_case, prefix) => {
        expect(messageOf({ ...s3, TELFLO_FILE_STORE_PREFIX: prefix })).toBe(
          `Environment variable TELFLO_FILE_STORE_PREFIX must be at most 256 characters with its trailing /, received 257: ${prefix}`,
        );
      });

      it.each([
        ["missing", undefined],
        ["empty", ""],
      ])("refuses to start when the region is %s, naming the variable", (_case, region) => {
        const rest = without(s3, "TELFLO_FILE_STORE_S3_REGION");
        expect(messageOf(region === undefined ? rest : { ...rest, TELFLO_FILE_STORE_S3_REGION: region })).toBe(
          "Missing required environment variable: TELFLO_FILE_STORE_S3_REGION",
        );
      });

      it.each(["US-EAST-1", "us_east_1", "us east 1", "a".repeat(33), "us-east-1/"])("refuses the region %j, showing it", (region) => {
        expect(messageOf({ ...s3, TELFLO_FILE_STORE_S3_REGION: region })).toBe(
          `Environment variable TELFLO_FILE_STORE_S3_REGION must be a region's name of 1 to 32 lower-case letters, digits and hyphens, received: ${region}`,
        );
      });

      // Ruling 121: no refusal shows the value, which a mistyped or pasted endpoint may fill with a user name
      // and password (encoded or not) or a presigned URL's signature. Every check on the value is a boolean.
      it.each([
        ["a user name", "http://canaryuser@objects.example.test:9000"],
        ["a user name and password", "http://canaryuser:canarypw@objects.example.test:9000"],
        ["a password only", "http://:canarypw@objects.example.test:9000"],
        ["a password and a scheme refused too", "ftp://canaryuser:canarypw@objects.example.test"],
        ["a password and no scheme", "canaryuser:canarypw@objects.example.test"],
        ["an encoded @ (%40)", "http://canaryuser:canarypw%40objects.example.test"],
        ["a full-width @", "http://canaryuser:canarypw\uFF20objects.example.test"],
        ["a user and password with no host (unparseable)", "http://canaryuser:canarypw"],
        ["a presigned URL's query", "https://objects.example.test/telflo-files/x?X-Amz-Credential=canarykeyid&X-Amz-Signature=canarysig"],
        ["a signature in a query", "https://objects.example.test/?X-Amz-Signature=canarysig"],
        ["a signature in a query with no path", "https://objects.example.test?X-Amz-Signature=canarysig"],
        ["an empty query", "http://objects.example.test:9000?"],
        ["a fragment", "https://objects.example.test#canaryfragment"],
        ["an empty fragment", "http://objects.example.test:9000/#"],
        ["a space", "http://objects.example.test canary"],
        ["a leading space", " http://objects.example.test"],
        ["a tab", "http://objects.example.test\t"],
        ["a newline", "http://objects.example.test\n"],
        ["a backslash for the slashes", "http:\\\\objects.example.test"],
        ["a backslash before a path", "http://objects.example.test\\canarypath"],
        ["a colon with no port", "http://objects.example.test:"],
        ["port 0", "http://objects.example.test:0"],
        ["port 65536", "http://objects.example.test:65536"],
        ["port 70000", "http://objects.example.test:70000"],
        ["a six-digit port", "http://objects.example.test:123456"],
        ["an upper-case scheme", "HTTP://objects.example.test:9000"],
        ["a path", "http://objects.example.test:9000/canarypath"],
        ["a path of //", "http://objects.example.test:9000//"],
        ["an encoded character in the host", "http://objects%2Eexample.test"],
        ["an internationalized host, not in its xn-- form", "http://b\u00FCcher.example"],
        ["brackets holding no IPv6 address", "http://[1.2.3.4]:9000"],
        ["an unclosed bracket", "http://[::1:9000"],
        ["a scheme other than http or https", "ftp://objects.example.test:9000"],
        ["s3://", "s3://objects.example.test"],
        ["no scheme", "objects.example.test:9000"],
        ["a relative path", "/canarypath"],
        ["a scheme without //", "http:objects.example.test"],
        ["no host", "https://"],
        ["a label ending in a hyphen", "http://objects-.example.test"],
      ])("refuses an endpoint with %s, naming the variable and the rule, never the value", (_case, endpoint) => {
        const message = messageOf({ ...s3, TELFLO_FILE_STORE_S3_ENDPOINT: endpoint });
        expect(message).toBe(
          "Environment variable TELFLO_FILE_STORE_S3_ENDPOINT must be an http or https origin such as http://127.0.0.1:51240 (a host and an optional port from 1 to 65535), with no user name, password, path, query or fragment",
        );
        const parts = ["canary", "objects", "X-Amz", "b\u00FCcher", "1.2.3.4", endpoint.trim()];
        expect(parts.some((part) => message.includes(part))).toBe(false);
      });

      it.each(["yes", "1", "TRUE", "on"])("refuses %j for the path style", (value) => {
        expect(messageOf({ ...s3, TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE: value })).toBe(
          `Environment variable TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE must be "true" or "false", received: ${value}`,
        );
      });
    });

    it.each(["S3", "LOCAL", "disk", "aws", "minio", " s3"])("refuses the kind %j, naming the variable and the kinds", (kind) => {
      expect(messageOf({ ...complete, TELFLO_FILE_STORE: kind })).toBe(
        `Environment variable TELFLO_FILE_STORE must be one of local, s3, received: ${kind}`,
      );
    });

    // D23-1 decisions 15 and 34: the S3 client's keys are the AWS SDK's
    // default chain's, so loadSettings never reads an AWS_* variable, and no
    // key can reach a setting or an error. The canaries are made here and
    // never printed: every assertion on them is a boolean (D22 lesson 3).
    describe("never reads an AWS_* variable", () => {
      const canaries = {
        AWS_ACCESS_KEY_ID: `canary-key-id-${randomUUID()}`,
        AWS_SECRET_ACCESS_KEY: `canary-secret-${randomUUID()}`,
        AWS_SESSION_TOKEN: `canary-session-${randomUUID()}`,
      };
      const holdsACanary = (text: string): boolean => Object.values(canaries).some((canary) => text.includes(canary));

      const loading: Array<[string, Record<string, string>]> = [
        ["the local disk", complete],
        ["an S3 bucket", { ...s3, TELFLO_FILE_STORE_PREFIX: "acme" }],
        ["an S3 bucket on AWS's own endpoint", without(s3, "TELFLO_FILE_STORE_S3_ENDPOINT")],
      ];
      const refused: Array<[string, Record<string, string>]> = [
        ["an unknown kind", { ...s3, TELFLO_FILE_STORE: "aws" }],
        ["a missing root", without(complete, "TELFLO_FILE_STORE_ROOT")],
        ["a relative root", { ...complete, TELFLO_FILE_STORE_ROOT: "file-store" }],
        ["a missing bucket", without(s3, "TELFLO_FILE_STORE_BUCKET")],
        ["a bad bucket", { ...s3, TELFLO_FILE_STORE_BUCKET: "Bad" }],
        ["a bad prefix", { ...s3, TELFLO_FILE_STORE_PREFIX: "/acme" }],
        ["a long prefix", { ...s3, TELFLO_FILE_STORE_PREFIX: "a".repeat(300) }],
        ["a missing region", without(s3, "TELFLO_FILE_STORE_S3_REGION")],
        ["a bad region", { ...s3, TELFLO_FILE_STORE_S3_REGION: "Bad" }],
        ["an endpoint with a user part", { ...s3, TELFLO_FILE_STORE_S3_ENDPOINT: "http://u:p@127.0.0.1" }],
        ["an endpoint with a bad scheme", { ...s3, TELFLO_FILE_STORE_S3_ENDPOINT: "ftp://127.0.0.1" }],
        ["an endpoint with a path", { ...s3, TELFLO_FILE_STORE_S3_ENDPOINT: "http://127.0.0.1/x" }],
        ["a bad path style", { ...s3, TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE: "yes" }],
      ];

      /** The environment with the canaries, behind a proxy noting every AWS_* name asked for (names only, never values). */
      function watched(env: Record<string, string>): { env: NodeJS.ProcessEnv; asked: string[] } {
        const asked: string[] = [];
        const note = (property: string | symbol) => {
          if (typeof property === "string" && property.startsWith("AWS_")) asked.push(property);
        };
        const proxy = new Proxy<Record<string, string>>(
          { ...env, ...canaries },
          {
            get(target, property, receiver) {
              note(property);
              return Reflect.get(target, property, receiver);
            },
            has(target, property) {
              note(property);
              return Reflect.has(target, property);
            },
            getOwnPropertyDescriptor(target, property) {
              note(property);
              return Reflect.getOwnPropertyDescriptor(target, property);
            },
          },
        );
        return { env: proxy, asked };
      }

      it.each(loading)("with %s: no setting holds a key, and no AWS_* name is asked for", (_case, env) => {
        const { env: proxy, asked } = watched(env);
        const settings = loadSettings(proxy);
        expect(holdsACanary(JSON.stringify(settings))).toBe(false);
        expect(asked).toEqual([]);
      });

      it.each(refused)("refusing %s: the error holds no key, and no AWS_* name is asked for", (_case, env) => {
        const { env: proxy, asked } = watched(env);
        let message: string | undefined;
        try {
          loadSettings(proxy);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message === undefined).toBe(false);
        expect(holdsACanary(message ?? "")).toBe(false);
        expect(asked).toEqual([]);
      });
    });

    // Preflight ruling 17: compose sets the S3 values for every install, and they load as its bucket under s3.
    // Ruling 114: .env.example's test-server keys are compose's development-only anchors (compared, never shown).
    it("compose's S3 values load under s3, and .env.example's test server is compose's object store", () => {
      const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const read = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");
      const compose = parseYaml(read("docker-compose.yml")) as {
        services: Record<string, { environment?: Record<string, string>; ports?: string[] }>;
      };
      const api = compose.services["api"]!.environment!;
      const objectStore = compose.services["object-store"]!;
      const example = parseEnv(read("telflo-core/.env.example"));
      expect(api.TELFLO_FILE_STORE).toBe("${TELFLO_FILE_STORE:-local}");
      const fromCompose = Object.fromEntries(Object.entries(api).filter(([name]) => name.startsWith("TELFLO_FILE_STORE_")));
      expect(loadSettings({ ...complete, ...fromCompose, TELFLO_FILE_STORE: "s3" }).fileStore).toEqual({
        kind: "s3",
        bucket: "telflo-files",
        prefix: "",
        region: "us-east-1",
        endpoint: "http://object-store:8333",
        forcePathStyle: true,
      });
      expect(loadSettings({ ...complete, ...fromCompose, TELFLO_FILE_STORE: "local" }).fileStore).toEqual({
        kind: "local",
        root: "/var/lib/telflo/file-store",
      });
      // .env.example leaves the kind at its default, the local disk.
      expect(example.TELFLO_FILE_STORE).toBeUndefined();
      expect(example.TELFLO_TEST_S3_ENDPOINT).toBe("http://127.0.0.1:51240");
      expect(objectStore.ports).toEqual(["127.0.0.1:51240:8333"]);
      const keyId = example.TELFLO_TEST_S3_ACCESS_KEY_ID ?? "";
      const secret = example.TELFLO_TEST_S3_SECRET_ACCESS_KEY ?? "";
      expect(keyId !== "" && secret !== "").toBe(true);
      expect(keyId === api.AWS_ACCESS_KEY_ID && keyId === objectStore.environment?.AWS_ACCESS_KEY_ID).toBe(true);
      expect(secret === api.AWS_SECRET_ACCESS_KEY && secret === objectStore.environment?.AWS_SECRET_ACCESS_KEY).toBe(true);
    });
  });

  describe("installing collectors (D17c-1 decision 34, Preflight ruling 9)", () => {
    function messageOf(env: Record<string, string>): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    it("reads the agent endpoint, and the defaults: the image's repository and templates, insecure connections refused", () => {
      expect(loadSettings(complete).install).toEqual({
        agentPublicUrl: "https://opamp.telflo.example/v1/opamp",
        collectorImageRepository: "ghcr.io/telflo/telflo/collector",
        allowInsecureConnections: false,
        helmChartReference: "oci://ghcr.io/telflo/telflo/charts/supervisor-collector",
        helmChartVersion: "0.1.0",
        templatesDirectory: "/etc/telflo/install-templates",
      });
    });

    it("reads each setting as given", () => {
      const install = loadSettings({
        ...complete,
        TELFLO_OPAMP_AGENT_PUBLIC_URL: "http://host.docker.internal:51234/opamp/api/v1",
        TELFLO_COLLECTOR_IMAGE_REPOSITORY: "registry.internal:5000/mirror/telflo-collector",
        TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS: "true",
        TELFLO_INSTALL_TEMPLATES_DIR: "/srv/telflo/templates",
      }).install;
      expect(install).toEqual({
        agentPublicUrl: "http://host.docker.internal:51234/opamp/api/v1",
        collectorImageRepository: "registry.internal:5000/mirror/telflo-collector",
        allowInsecureConnections: true,
        helmChartReference: "oci://ghcr.io/telflo/telflo/charts/supervisor-collector",
        helmChartVersion: "0.1.0",
        templatesDirectory: "/srv/telflo/templates",
      });
    });

    it.each(["wss://opamp.telflo.io/v1/opamp", "ws://127.0.0.1:4320", "https://[::1]:4320/v1/opamp", "https://opamp.example"])(
      "takes the agent endpoint %s",
      (url) => {
        expect(loadSettings({ ...complete, TELFLO_OPAMP_AGENT_PUBLIC_URL: url }).install.agentPublicUrl).toBe(url);
      },
    );

    it.each([
      ["missing", undefined],
      ["empty", ""],
    ])("refuses to start when the agent endpoint is %s, naming the variable", (_case, value) => {
      const { TELFLO_OPAMP_AGENT_PUBLIC_URL: _omitted, ...rest } = complete;
      expect(messageOf(value === undefined ? rest : { ...rest, TELFLO_OPAMP_AGENT_PUBLIC_URL: value })).toBe(
        "Missing required environment variable: TELFLO_OPAMP_AGENT_PUBLIC_URL",
      );
    });

    it.each([
      "ftp://opamp.example/v1",
      "opamp.example/v1",
      "https://opamp.example/a b",
      "https://opamp.example/it's",
      'https://opamp.example/"x"',
      "https://opamp.example/a\\b",
      "https://opamp.example/$(echo EXPANDED)",
      "https://opamp.example/${ROOT_PATH}",
      "https://opamp.example/`echo EXPANDED`",
      "https://user:pw@opamp.example/v1",
      "https://opamp.example/v1?q=1",
      "https://opamp.example/v1#x",
      "https://opamp.example/v1;echo",
    ])("refuses the agent endpoint %s, naming the variable", (url) => {
      expect(messageOf({ ...complete, TELFLO_OPAMP_AGENT_PUBLIC_URL: url })).toMatch(/^Environment variable TELFLO_OPAMP_AGENT_PUBLIC_URL must be/);
    });

    // D18 decision 9: the platform's own image, when unset or empty.
    it("defaults the image repository to the platform's own, ghcr.io/telflo/telflo/collector, when unset or empty", () => {
      for (const env of [complete, { ...complete, TELFLO_COLLECTOR_IMAGE_REPOSITORY: "" }]) {
        expect(loadSettings(env).install.collectorImageRepository).toBe("ghcr.io/telflo/telflo/collector");
      }
    });

    it.each(["ghcr.io/x; echo EXPANDED", "GHCR.io/telflo/telflo/collector", "ghcr.io/telflo/telflo/collector:"])(
      "refuses the image repository %s, naming the variable and the value",
      (repository) => {
        expect(messageOf({ ...complete, TELFLO_COLLECTOR_IMAGE_REPOSITORY: repository })).toBe(
          `Environment variable TELFLO_COLLECTOR_IMAGE_REPOSITORY must be an image repository such as ghcr.io/telflo/telflo/collector, received: ${repository}`,
        );
      },
    );

    it.each(["yes", "1", "TRUE"])("refuses the insecure flag %s: only true or false", (flag) => {
      expect(messageOf({ ...complete, TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS: flag })).toBe(
        `Environment variable TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS must be "true" or "false", received: ${flag}`,
      );
    });

    it.each(["install-templates", "./install-templates", "~/install-templates"])("refuses a relative templates directory (%s)", (directory) => {
      expect(messageOf({ ...complete, TELFLO_INSTALL_TEMPLATES_DIR: directory })).toBe(
        `Environment variable TELFLO_INSTALL_TEMPLATES_DIR must be an absolute path, received: ${directory}`,
      );
    });

    // D17d-2 decision 16, Preflight ruling 6; D18 decisions 9 and 10: the Helm chart's reference and version.
    it("defaults the Helm chart to the platform's own, oci://ghcr.io/telflo/telflo/charts/supervisor-collector 0.1.0, when unset or empty", () => {
      for (const env of [complete, { ...complete, TELFLO_HELM_CHART_REFERENCE: "", TELFLO_HELM_CHART_VERSION: "" }]) {
        const install = loadSettings(env).install;
        expect([install.helmChartReference, install.helmChartVersion]).toEqual(["oci://ghcr.io/telflo/telflo/charts/supervisor-collector", "0.1.0"]);
      }
    });

    it("takes a mirror's chart and another exact version", () => {
      const install = loadSettings({
        ...complete,
        TELFLO_HELM_CHART_REFERENCE: "oci://registry.example:5000/mirror/charts/x",
        TELFLO_HELM_CHART_VERSION: "10.0.21",
      }).install;
      expect([install.helmChartReference, install.helmChartVersion]).toEqual(["oci://registry.example:5000/mirror/charts/x", "10.0.21"]);
    });

    it.each([
      "https://ghcr.io/telflo/charts/telflo-supervisor-collector",
      "oci://GHCR.io/telflo/charts/telflo-supervisor-collector",
      "oci://ghcr.io/telflo/charts/telflo supervisor",
      "oci://ghcr.io/telflo/charts/it's",
      'oci://ghcr.io/telflo/charts/"x"',
      "ghcr.io/telflo/charts/telflo-supervisor-collector",
    ])("refuses the Helm chart reference %s, naming the variable and the value", (reference) => {
      expect(messageOf({ ...complete, TELFLO_HELM_CHART_REFERENCE: reference })).toBe(
        `Environment variable TELFLO_HELM_CHART_REFERENCE must be an oci:// chart reference of lowercase letters, digits and ._:/- such as oci://ghcr.io/telflo/telflo/charts/supervisor-collector, received: ${reference}`,
      );
    });

    it.each(["0.3", "v0.3.5", "01.2.3", "0.3.5-rc.1", "0.3.5 ", "latest"])("refuses the Helm chart version %j, naming the variable and the value", (version) => {
      expect(messageOf({ ...complete, TELFLO_HELM_CHART_VERSION: version })).toBe(
        `Environment variable TELFLO_HELM_CHART_VERSION must be an exact chart version x.y.z such as 0.1.0 (no v, no leading zero), received: ${version}`,
      );
    });

    it("touches no file: a templates directory that doesn't exist is the start's to refuse (checkInstallTemplates)", () => {
      const directory = "/nonexistent/telflo-settings-test/install-templates";
      expect(loadSettings({ ...complete, TELFLO_INSTALL_TEMPLATES_DIR: directory }).install.templatesDirectory).toBe(directory);
    });
  });

  describe("quick-deploy links (D17c-2 decision 24, Preflight rulings 6 to 8)", () => {
    function messageOf(env: Record<string, string>): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    it("reads the public API URL, and the key ring with no previous key", () => {
      const key = Buffer.from(complete.TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY, "base64");
      expect(loadSettings(complete).quickDeploy).toEqual({
        publicApiUrl: "https://telflo.example",
        keyRing: { current: { id: keyIdOf(key), key }, previous: [] },
      });
    });

    it("removes the URL's trailing slashes, and keeps a port and a path", () => {
      for (const [url, expected] of [
        ["https://telflo.example/", "https://telflo.example"],
        ["http://host.docker.internal:50080//", "http://host.docker.internal:50080"],
        ["https://telflo.example/base/api-gateway/", "https://telflo.example/base/api-gateway"],
        ["http://[::1]:8080", "http://[::1]:8080"],
        ["https://[fe80::1]/telflo/", "https://[fe80::1]/telflo"],
        ["http://[::ffff:192.0.2.1]:50080", "http://[::ffff:192.0.2.1]:50080"],
      ] as const) {
        expect(loadSettings({ ...complete, TELFLO_PUBLIC_API_URL: url }).quickDeploy.publicApiUrl).toBe(expected);
      }
    });

    it("reads previous keys, in their order", () => {
      const previous = ["cHJldmlvdXMta2V5LW9uZS1zZXR0aW5ncy10ZXN0ISE=", "cHJldmlvdXMta2V5LXR3by1zZXR0aW5ncy10ZXN0ISE="];
      const ring = loadSettings({ ...complete, TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: previous.join(",") }).quickDeploy.keyRing;
      expect(ring.previous.map(({ key }) => key.toString("base64"))).toEqual(previous);
    });

    it.each([
      ["TELFLO_PUBLIC_API_URL", undefined],
      ["TELFLO_PUBLIC_API_URL", ""],
      ["TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY", undefined],
      ["TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY", ""],
    ] as const)("refuses to start when %s is %s, naming the variable", (name, value) => {
      const { [name]: _omitted, ...rest } = complete;
      expect(messageOf(value === undefined ? rest : { ...rest, [name]: value })).toBe(`Missing required environment variable: ${name}`);
    });

    it.each([
      "ftp://telflo.example",
      "telflo.example",
      "https://user:pw@telflo.example",
      "https://telflo.example?q=1",
      "https://telflo.example#x",
      "https://telflo.example/a%2Fb",
      "https://telflo.example/a b",
      "https://telflo.example/it's",
      'https://telflo.example/"x"',
      "https://telflo.example/$(echo EXPANDED)",
      "https://telflo.example:65536",
      "https://telflo.example:99999",
      "https://",
    ])("refuses the public API URL %s, showing it", (url) => {
      expect(messageOf({ ...complete, TELFLO_PUBLIC_API_URL: url })).toBe(
        `Environment variable TELFLO_PUBLIC_API_URL must be an http or https URL with a host, an optional port and a path of letters, digits and ._~+- (no user name, query, fragment or %), received: ${url}`,
      );
    });

    it.each(["http://[abc]:1", "http://[1.2.3.4]", "https://[:::]/telflo", "http://[1::2::3]:8080", "http://[12345::1]", "http://[.]"])(
      "refuses the public API URL %s, whose brackets hold no IPv6 address, showing it",
      (url) => {
        expect(messageOf({ ...complete, TELFLO_PUBLIC_API_URL: url })).toBe(
          `Environment variable TELFLO_PUBLIC_API_URL must have an IPv6 address inside its host's brackets, received: ${url}`,
        );
      },
    );

    it.each([
      ["a short key", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: "c2hvcnQ=" }],
      ["a passphrase", { TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: "development-only-quick-deploy-key-not-for-production" }],
      ["a bad previous key", { TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: "not-a-key" }],
      ["the current key as a previous one", { TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: complete.TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY }],
    ])("refuses %s, naming the variable and never the value", (_label, env) => {
      const message = messageOf({ ...complete, ...env });
      expect(message).toMatch(/^Environment variable TELFLO_QUICK_DEPLOY_(PREVIOUS_)?ENCRYPTION_KEYS? /);
      for (const value of Object.values(env)) expect(message).not.toContain(value);
    });

    // Preflight ruling 7: no production mode refuses the development key; compose and .env.example carry one
    // fixed value, public and development-only, as every development secret of theirs.
    it("compose's API environment and .env.example carry the same development-only key, which loads, and their URLs", () => {
      const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const read = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");
      const compose = parseYaml(read("docker-compose.yml")) as { services: Record<string, { environment?: Record<string, string> }> };
      const api = compose.services["api"]!.environment!;
      const example = parseEnv(read("telflo-core/.env.example"));
      expect(api.TELFLO_PUBLIC_API_URL).toBe("${TELFLO_PUBLIC_API_URL:-http://host.docker.internal:50080}");
      expect(example.TELFLO_PUBLIC_API_URL).toBe("http://host.docker.internal:8080");
      expect(api.TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY).toBe(example.TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY);
      const fromExample = loadSettings({
        ...complete,
        TELFLO_PUBLIC_API_URL: example.TELFLO_PUBLIC_API_URL!,
        TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: example.TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY!,
      }).quickDeploy;
      expect(fromExample.publicApiUrl).toBe("http://host.docker.internal:8080");
      expect(fromExample.keyRing.current.key).toHaveLength(32);
    });
  });

  // The library link's keys are secrets (D23-2 decisions 46 and 59): every
  // check on a message or a key below is a boolean, so a failing test prints
  // no key.
  describe("the library link's keys (D23-2 decision 46, Preflight ruling 12)", () => {
    const CURRENT = "TELFLO_LIBRARY_LINK_SIGNING_KEY";
    const PREVIOUS = "TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS";
    const previousOne = "settings-test-only-previous-library-key-one";
    const previousTwo = "settings-test-only-previous-library-key-two";

    function messageOf(env: Record<string, string>): string {
      try {
        loadSettings(env);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("loadSettings did not throw");
    }

    function sameBytes(key: Buffer, text: string): boolean {
      return key.equals(Buffer.from(text, "utf8"));
    }

    it("reads the current key as its UTF-8 bytes, with no previous key", () => {
      const { signingKeys } = loadSettings(complete).library;
      expect(sameBytes(signingKeys.current, complete.TELFLO_LIBRARY_LINK_SIGNING_KEY)).toBe(true);
      expect(signingKeys.previous.length).toBe(0);
    });

    it("trims the current key, and takes 32 bytes of UTF-8 (é is two)", () => {
      const key = "k".repeat(32);
      expect(sameBytes(loadSettings({ ...complete, [CURRENT]: ` ${key}\n` }).library.signingKeys.current, key)).toBe(true);
      const accented = "é".repeat(16);
      expect(sameBytes(loadSettings({ ...complete, [CURRENT]: accented }).library.signingKeys.current, accented)).toBe(true);
    });

    it("reads previous keys in their order, trimmed, dropping empty entries", () => {
      const env = { ...complete, [PREVIOUS]: ` ,${previousOne} ,, ${previousTwo}\n,` };
      const { previous } = loadSettings(env).library.signingKeys;
      expect(previous.length).toBe(2);
      expect(sameBytes(previous[0]!, previousOne)).toBe(true);
      expect(sameBytes(previous[1]!, previousTwo)).toBe(true);
    });

    it("takes eight previous keys, and an empty or blank previous setting as none", () => {
      const eight = Array.from({ length: 8 }, (_, index) => `settings-test-only-previous-library-key-${index}`);
      expect(loadSettings({ ...complete, [PREVIOUS]: eight.join(",") }).library.signingKeys.previous.length).toBe(8);
      expect(loadSettings({ ...complete, [PREVIOUS]: "" }).library.signingKeys.previous.length).toBe(0);
      expect(loadSettings({ ...complete, [PREVIOUS]: " , ," }).library.signingKeys.previous.length).toBe(0);
    });

    it.each([undefined, "", "   \n"])("refuses to start when the current key is %j, naming the variable", (value) => {
      const { [CURRENT]: _omitted, ...rest } = complete;
      expect(messageOf(value === undefined ? rest : { ...rest, [CURRENT]: value })).toBe(`Missing required environment variable: ${CURRENT}`);
    });

    const nine = Array.from({ length: 9 }, (_, index) => `settings-test-only-previous-library-key-${index}`);
    it.each([
      ["a current key of 31 bytes", { [CURRENT]: "s".repeat(31) }, `Environment variable ${CURRENT} must be at least 32 bytes`],
      ["a current key of 31 bytes after trimming", { [CURRENT]: ` ${"s".repeat(31)} ` }, `Environment variable ${CURRENT} must be at least 32 bytes`],
      ["a current key of 15 two-byte characters", { [CURRENT]: "é".repeat(15) }, `Environment variable ${CURRENT} must be at least 32 bytes`],
      ["nine previous keys", { [PREVIOUS]: nine.join(",") }, `Environment variable ${PREVIOUS} holds at most 8 keys`],
      [
        "a short previous key",
        { [PREVIOUS]: `${previousOne},short-previous-library-key` },
        `Environment variable ${PREVIOUS} must hold keys of at least 32 bytes each`,
      ],
      ["a repeated previous key", { [PREVIOUS]: `${previousOne},${previousTwo}, ${previousOne}` }, `Environment variable ${PREVIOUS} repeats a key`],
      [
        "the current key as a previous one",
        { [PREVIOUS]: `${previousOne},${complete.TELFLO_LIBRARY_LINK_SIGNING_KEY}` },
        `Environment variable ${PREVIOUS} holds the current key (${CURRENT})`,
      ],
      [
        "the current key, padded, as a previous one",
        { [CURRENT]: ` ${previousTwo}`, [PREVIOUS]: `${previousTwo} ` },
        `Environment variable ${PREVIOUS} holds the current key (${CURRENT})`,
      ],
    ])("refuses %s, naming the variable and the rule, never a value", (_label, env, expected) => {
      const message = messageOf({ ...complete, ...env });
      expect(message === expected).toBe(true);
      for (const value of Object.values(env)) {
        for (const part of value.split(",").map((text) => text.trim()).filter((text) => text !== "")) {
          expect(message.includes(part)).toBe(false);
        }
      }
    });

    // Preflight ruling 12: compose and .env.example carry one fixed key, public and development-only, as
    // quick-deploy's; compared as a boolean, never shown.
    it("compose's API environment and .env.example carry the same development-only key, which loads", () => {
      const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const read = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");
      const compose = parseYaml(read("docker-compose.yml")) as { services: Record<string, { environment?: Record<string, string> }> };
      const api = compose.services["api"]!.environment!;
      const example = parseEnv(read("telflo-core/.env.example"));
      const composeKey = api[CURRENT];
      const exampleKey = example[CURRENT];
      expect(typeof composeKey === "string" && composeKey === exampleKey).toBe(true);
      expect(composeKey!.includes("development-only")).toBe(true);
      expect(PREVIOUS in api || PREVIOUS in example).toBe(false);
      const { signingKeys } = loadSettings({ ...complete, [CURRENT]: exampleKey! }).library;
      expect(signingKeys.current.length >= 32 && signingKeys.previous.length === 0).toBe(true);
    });
  });
});
