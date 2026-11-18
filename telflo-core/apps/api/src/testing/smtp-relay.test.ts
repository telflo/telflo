import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestCertificates, startSmtpRelay, type SmtpRelay, type TestCertificates } from "./smtp-relay.js";

// The relay's own guards, spoken to line by line: the mail tests lean on
// them (a login is taken only over TLS, mail only after a login, a `plain`
// relay never offers STARTTLS).

let certificates: TestCertificates;
const login = { username: "relay-user", password: `cnry-password-${randomUUID()}` };
const relays: SmtpRelay[] = [];
const clients: net.Socket[] = [];

beforeAll(() => {
  certificates = createTestCertificates();
});
afterAll(() => {
  certificates.remove();
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

/** A line-by-line client: each call sends a line (or nothing) and resolves with the relay's next whole reply. */
function speaker(socket: net.Socket) {
  clients.push(socket);
  let buffer = "";
  const waiting: ((reply: string) => void)[] = [];
  const replies: string[] = [];
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("latin1");
    let match: RegExpExecArray | null;
    while ((match = /^(?:\d{3}-[^\r\n]*\r\n)*\d{3} [^\r\n]*\r\n/.exec(buffer)) !== null) {
      buffer = buffer.slice(match[0].length);
      const reply = match[0].trimEnd();
      const next = waiting.shift();
      if (next === undefined) replies.push(reply);
      else next(reply);
    }
  };
  socket.on("data", onData);
  return {
    say: (line?: string) =>
      new Promise<string>((resolve) => {
        if (line !== undefined) socket.write(`${line}\r\n`);
        const ready = replies.shift();
        if (ready !== undefined) resolve(ready);
        else waiting.push(resolve);
      }),
    detach: () => socket.off("data", onData),
  };
}

const connect = (port: number) =>
  new Promise<net.Socket>((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
  });
const secure = (socket: net.Socket) =>
  new Promise<tls.TLSSocket>((resolve) => {
    const upgraded = tls.connect({ socket, servername: "localhost", ca: certificates.caPem }, () => resolve(upgraded));
  });
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

async function relayOf(mode: "starttls" | "plain" | "implicit", withLogin = true) {
  const relay = await startSmtpRelay({ mode, key: certificates.key, cert: certificates.cert, login: withLogin ? login : null });
  relays.push(relay);
  return relay;
}

describe("the test SMTP relay", () => {
  it("makes a server certificate the CA verifies for localhost and 127.0.0.1, and keeps no private key on disk", async () => {
    expect(readdirSync(certificates.folder).sort()).toEqual(["ca.crt", "other-ca.crt"]);
    expect(certificates.key.includes("PRIVATE KEY")).toBe(true);
    const relay = await relayOf("implicit", false);
    for (const target of [{ host: "127.0.0.1" }, { host: "127.0.0.1", servername: "localhost" }]) {
      const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const opened = tls.connect({ port: relay.port, ...target, ca: certificates.caPem }, () => resolve(opened));
        opened.on("error", reject);
      });
      clients.push(socket);
      expect(socket.authorized).toBe(true);
    }
  });

  it("makes a second certificate, from the same CA, that verifies only for its other host", async () => {
    const relay = await startSmtpRelay({ mode: "implicit", key: certificates.foreignKey, cert: certificates.foreignCert, login: null });
    relays.push(relay);
    const outcomes: string[] = [];
    for (const servername of ["other.example", "localhost"]) {
      outcomes.push(
        await new Promise<string>((resolve) => {
          const opened = tls.connect({ port: relay.port, host: "127.0.0.1", servername, ca: certificates.caPem }, () => resolve("authorized"));
          clients.push(opened);
          opened.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
        }),
      );
    }
    expect(outcomes).toEqual(["authorized", "ERR_TLS_CERT_ALTNAME_INVALID"]);
  });

  it("offers STARTTLS only before TLS, and AUTH only after it; refuses AUTH and MAIL in cleartext", async () => {
    const relay = await relayOf("starttls");
    const plain = await connect(relay.port);
    const before = speaker(plain);
    expect(await before.say()).toMatch(/^220 /);
    const ehlo = await before.say("EHLO client.test");
    expect([ehlo.includes("STARTTLS"), ehlo.includes("AUTH")]).toEqual([true, false]);
    expect(await before.say(`AUTH PLAIN ${base64(`\0${login.username}\0${login.password}`)}`)).toMatch(/^538 /);
    expect(await before.say("MAIL FROM:<a@example.test>")).toMatch(/^530 /);
    expect(await before.say("STARTTLS")).toMatch(/^220 /);
    before.detach();

    const after = speaker(await secure(plain));
    const ehloAfter = await after.say("EHLO client.test");
    expect([ehloAfter.includes("STARTTLS"), ehloAfter.includes("AUTH PLAIN LOGIN")]).toEqual([false, true]);
    expect(await after.say("STARTTLS")).toMatch(/^502 /);
    expect(await after.say("MAIL FROM:<a@example.test>")).toMatch(/^530 /);
    expect(await after.say("AUTH PLAIN")).toBe("334");
    expect(await after.say(base64(`\0${login.username}\0wrong`))).toMatch(/^535 /);
    expect(await after.say("AUTH LOGIN")).toBe("334 VXNlcm5hbWU6");
    expect(await after.say(base64(login.username))).toBe("334 UGFzc3dvcmQ6");
    expect(await after.say(base64(login.password))).toMatch(/^235 /);
    expect(await after.say("AUTH PLAIN")).toMatch(/^503 /);
    expect([relay.refusedLogins(), relay.authAttempts()]).toEqual([1, 4]);
  });

  it("takes a message after a login, dot-unstuffed, and answers the rest of the protocol", async () => {
    const relay = await relayOf("implicit");
    const socket = await new Promise<tls.TLSSocket>((resolve) => {
      const opened = tls.connect({ port: relay.port, host: "127.0.0.1", ca: certificates.caPem }, () => resolve(opened));
    });
    const client = speaker(socket);
    expect(await client.say()).toMatch(/^220 /);
    await client.say("EHLO client.test");
    expect(await client.say("AUTH CRAM-MD5")).toMatch(/^504 /);
    expect(await client.say(`AUTH PLAIN ${base64(`\0${login.username}\0${login.password}`)}`)).toMatch(/^235 /);
    expect(await client.say("RCPT TO:<b@example.test>")).toMatch(/^503 /);
    expect(await client.say("DATA")).toMatch(/^503 /);
    expect(await client.say("NOOP")).toMatch(/^250 /);
    expect(await client.say("HELP")).toMatch(/^502 /);
    expect(await client.say("MAIL FROM:<a@example.test>")).toMatch(/^250 /);
    expect(await client.say("RSET")).toMatch(/^250 /);
    expect(await client.say("MAIL FROM:<a@example.test>")).toMatch(/^250 /);
    expect(await client.say("RCPT TO:<b@example.test>")).toMatch(/^250 /);
    expect(await client.say("DATA")).toMatch(/^354 /);
    expect(await client.say("Subject: s\r\n\r\n..leading dot\r\n.")).toMatch(/^250 /);
    expect(await client.say("QUIT")).toMatch(/^221 /);

    expect(relay.received).toEqual([
      { from: "a@example.test", to: ["b@example.test"], data: "Subject: s\n\n.leading dot", secure: true, mechanism: "PLAIN" },
    ]);
  });

  it("never offers STARTTLS as a plain relay", async () => {
    const relay = await relayOf("plain", false);
    const client = speaker(await connect(relay.port));
    await client.say();
    expect((await client.say("EHLO client.test")).includes("STARTTLS")).toBe(false);
    expect(await client.say("STARTTLS")).toMatch(/^502 /);
    expect(await client.say("AUTH PLAIN")).toMatch(/^538 /);
    expect(await client.say("MAIL FROM:<a@example.test>")).toMatch(/^250 /);
  });
});
