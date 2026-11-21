import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

/**
 * An in-process SMTP relay for the mail tests: node:net and node:tls only, no
 * SMTP package. It offers STARTTLS (`starttls`), opens TLS from the start
 * (`implicit`), or never offers STARTTLS (`plain`, the relay a `starttls`
 * client must refuse). With a login, AUTH PLAIN and LOGIN are offered and
 * accepted only after TLS, and MAIL before a login answers 530.
 *
 * It records what it received with booleans and the envelope, never the
 * login's values.
 */

export type SmtpRelayMode = "starttls" | "implicit" | "plain";

export interface SmtpRelayOptions {
  mode: SmtpRelayMode;
  /** The server's key and certificate (PEM), from createTestCertificates. */
  key: string;
  cert: string;
  /** The login the relay demands, or null to take mail without one. */
  login: { username: string; password: string } | null;
}

export interface ReceivedMessage {
  from: string;
  to: string[];
  /** The message as sent (headers and body), dot-unstuffed. */
  data: string;
  /** Whether the session was TLS when the message was sent. */
  secure: boolean;
  /** The mechanism the client logged in with, or null for none. */
  mechanism: "PLAIN" | "LOGIN" | null;
}

export interface SmtpRelay {
  port: number;
  received: ReceivedMessage[];
  /** How many logins the relay refused. */
  refusedLogins: () => number;
  /** How many AUTH commands reached the relay, before TLS or after. */
  authAttempts: () => number;
  close(): Promise<void>;
}

interface Session {
  secure: boolean;
  mechanism: "PLAIN" | "LOGIN" | null;
  awaiting: "plain" | "login-username" | "login-password" | "data" | null;
  pendingUsername: string;
  from: string | null;
  to: string[];
  data: string[];
}

function freshSession(secure: boolean): Session {
  return { secure, mechanism: null, awaiting: null, pendingUsername: "", from: null, to: [], data: [] };
}

const decode = (text: string) => Buffer.from(text, "base64").toString("utf8");

export async function startSmtpRelay(options: SmtpRelayOptions): Promise<SmtpRelay> {
  const received: ReceivedMessage[] = [];
  const sockets = new Set<net.Socket>();
  let refused = 0;
  let authAttempts = 0;

  const loginMatches = (username: string, password: string) =>
    options.login !== null && username === options.login.username && password === options.login.password;

  /** Serves one connection, plain or TLS; STARTTLS hands the socket to a fresh call. */
  const serve = (socket: net.Socket, secure: boolean, greet: boolean) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    const session = freshSession(secure);
    let buffer = "";
    const reply = (...lines: string[]) => {
      socket.write(lines.map((line, index) => `${line.slice(0, 3)}${index < lines.length - 1 ? "-" : " "}${line.slice(4)}\r\n`).join(""));
    };
    const loggedIn = (mechanism: "PLAIN" | "LOGIN", ok: boolean) => {
      if (ok) {
        session.mechanism = mechanism;
        reply("235 2.7.0 Authentication succeeded");
      } else {
        refused += 1;
        reply("535 5.7.8 Authentication credentials invalid");
      }
    };

    const onLine = (line: string): "upgrade" | void => {
      if (session.awaiting === "data") {
        if (line === ".") {
          received.push({ from: session.from ?? "", to: session.to, data: session.data.join("\n"), secure: session.secure, mechanism: session.mechanism });
          session.awaiting = null;
          session.from = null;
          session.to = [];
          session.data = [];
          reply("250 2.0.0 Queued");
        } else {
          session.data.push(line.startsWith("..") ? line.slice(1) : line);
        }
        return;
      }
      if (session.awaiting === "plain") {
        session.awaiting = null;
        const [, username = "", password = ""] = decode(line).split("\0");
        loggedIn("PLAIN", loginMatches(username, password));
        return;
      }
      if (session.awaiting === "login-username") {
        session.awaiting = "login-password";
        session.pendingUsername = decode(line);
        reply("334 UGFzc3dvcmQ6");
        return;
      }
      if (session.awaiting === "login-password") {
        session.awaiting = null;
        loggedIn("LOGIN", loginMatches(session.pendingUsername, decode(line)));
        session.pendingUsername = "";
        return;
      }

      const [verb = "", ...rest] = line.split(" ");
      switch (verb.toUpperCase()) {
        case "EHLO": {
          const offers = ["250 relay.test"];
          if (!session.secure && options.mode === "starttls") offers.push("250 STARTTLS");
          if (session.secure && options.login !== null) offers.push("250 AUTH PLAIN LOGIN");
          offers.push("250 OK");
          reply(...offers);
          return;
        }
        case "STARTTLS":
          if (session.secure || options.mode !== "starttls") {
            reply("502 5.5.1 STARTTLS not offered");
            return;
          }
          reply("220 2.0.0 Ready to start TLS");
          return "upgrade";
        case "AUTH": {
          authAttempts += 1;
          if (!session.secure) return reply("538 5.7.11 Encryption required for requested authentication mechanism");
          if (options.login === null || session.mechanism !== null) return reply("503 5.5.1 AUTH not available");
          const [mechanism = "", initial] = rest;
          if (mechanism.toUpperCase() === "PLAIN") {
            if (initial === undefined) {
              session.awaiting = "plain";
              return reply("334 ");
            }
            const [, username = "", password = ""] = decode(initial).split("\0");
            return loggedIn("PLAIN", loginMatches(username, password));
          }
          if (mechanism.toUpperCase() === "LOGIN") {
            session.awaiting = "login-username";
            return reply("334 VXNlcm5hbWU6");
          }
          return reply("504 5.5.4 Unrecognized authentication type");
        }
        case "MAIL":
          if (options.login !== null && session.mechanism === null) return reply("530 5.7.0 Authentication required");
          session.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          session.to = [];
          return reply("250 2.1.0 OK");
        case "RCPT":
          if (session.from === null) return reply("503 5.5.1 MAIL first");
          session.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          return reply("250 2.1.5 OK");
        case "DATA":
          if (session.to.length === 0) return reply("503 5.5.1 RCPT first");
          session.awaiting = "data";
          return reply("354 End data with <CR><LF>.<CR><LF>");
        case "RSET":
          session.from = null;
          session.to = [];
          return reply("250 2.0.0 OK");
        case "NOOP":
          return reply("250 2.0.0 OK");
        case "QUIT":
          reply("221 2.0.0 Bye");
          socket.end();
          return;
        default:
          return reply("502 5.5.2 Command not recognized");
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (onLine(line) === "upgrade") {
          // RFC 3207: the session starts over on the TLS connection, with
          // no greeting and nothing the client said before kept.
          socket.off("data", onData);
          const upgraded = new tls.TLSSocket(socket, { isServer: true, key: options.key, cert: options.cert });
          serve(upgraded, true, false);
          return;
        }
      }
    };
    socket.on("data", onData);
    if (greet) reply("220 relay.test ESMTP");
  };

  const server =
    options.mode === "implicit"
      ? tls.createServer({ key: options.key, cert: options.cert }, (socket) => serve(socket, true, true))
      : net.createServer((socket) => serve(socket, false, true));
  // A client that refuses the certificate ends the handshake: not the relay's failure.
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The test SMTP relay has no port");

  return {
    port: address.port,
    received,
    refusedLogins: () => refused,
    authAttempts: () => authAttempts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface TestCertificates {
  /** The folder holding the two CA certificates (no key); remove() deletes it. */
  folder: string;
  /** The CA that signed the server's certificate, and its file. */
  caPem: string;
  caFile: string;
  /** A CA that signed nothing here, and its file. */
  otherCaPem: string;
  otherCaFile: string;
  /** The server's key and certificate (SAN DNS:localhost, IP:127.0.0.1). */
  key: string;
  cert: string;
  /**
   * A second server key and certificate from the same CA, for another host
   * (SAN DNS:other.example, IP:10.9.9.9): trusted, but not for 127.0.0.1 or
   * localhost, so only the client's host-name check refuses it.
   */
  foreignKey: string;
  foreignCert: string;
  remove(): void;
}

/**
 * Makes two CAs and two server certificates (one for localhost and
 * 127.0.0.1, one for another host) with the `openssl` CLI, at test
 * time, in a folder of the run's own (no key is ever committed): RSA 2048,
 * SHA-256 always (macOS's LibreSSL signs SHA-1 by default, which Node
 * refuses), extensions from a config written here (not the system's). Every
 * private key is read into memory and deleted at once; only the two CA
 * certificates stay on disk, until remove().
 */
export function createTestCertificates(): TestCertificates {
  const folder = mkdtempSync(join(tmpdir(), "telflo-smtp-relay-"));
  const at = (name: string) => join(folder, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: folder, stdio: "ignore" });
  try {
    writeFileSync(
      at("openssl.cnf"),
      [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "[dn]",
        "CN = telflo-test",
        "[ca]",
        "basicConstraints = critical,CA:TRUE",
        "keyUsage = critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier = hash",
        "[server]",
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage = serverAuth",
        "subjectAltName = DNS:localhost,IP:127.0.0.1",
        "[foreign]",
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage = serverAuth",
        "subjectAltName = DNS:other.example,IP:10.9.9.9",
        "",
      ].join("\n"),
    );
    for (const name of ["ca", "other-ca"]) {
      openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-config", at("openssl.cnf"),
        "-extensions", "ca", "-subj", `/CN=telflo-test-smtp-${name}`, "-keyout", at(`${name}.key`), "-out", at(`${name}.crt`));
    }
    for (const [name, commonName, serial] of [["server", "localhost", "1"], ["foreign", "other.example", "2"]] as const) {
      openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", at("openssl.cnf"), "-subj", `/CN=${commonName}`,
        "-keyout", at(`${name}.key`), "-out", at(`${name}.csr`));
      openssl("x509", "-req", "-sha256", "-days", "1", "-in", at(`${name}.csr`), "-CA", at("ca.crt"), "-CAkey", at("ca.key"),
        "-set_serial", serial, "-extfile", at("openssl.cnf"), "-extensions", name, "-out", at(`${name}.crt`));
    }
    const certificates = {
      folder,
      caPem: readFileSync(at("ca.crt"), "utf8"),
      caFile: at("ca.crt"),
      otherCaPem: readFileSync(at("other-ca.crt"), "utf8"),
      otherCaFile: at("other-ca.crt"),
      key: readFileSync(at("server.key"), "utf8"),
      cert: readFileSync(at("server.crt"), "utf8"),
      foreignKey: readFileSync(at("foreign.key"), "utf8"),
      foreignCert: readFileSync(at("foreign.crt"), "utf8"),
      remove: () => rmSync(folder, { recursive: true, force: true }),
    };
    for (const name of ["ca.key", "other-ca.key", "server.key", "server.csr", "server.crt", "foreign.key", "foreign.csr", "foreign.crt", "openssl.cnf"]) {
      rmSync(at(name), { force: true });
    }
    return certificates;
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}
