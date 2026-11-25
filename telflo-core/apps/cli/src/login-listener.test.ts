import { createHmac, randomBytes } from "node:crypto";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handOff, sendToListener, type ListenerReply } from "../tests/listener-request.js";
import {
  CALLBACK_PATH,
  cliAuthUrl,
  LISTENER_TIMEOUT_MS,
  listenerProof,
  MAXIMUM_BODY_BYTES,
  newState,
  PROOF_CONTEXT,
  startLoginListener,
  STATE_PATTERN,
  type ListenerOutcome,
  type LoginListener,
} from "./login-listener.js";

/*
 * The login listener against real loopback requests: what it accepts,
 * every refusal (403 or 404, no body, the wait kept, however many),
 * `Access-Control-Allow-Origin` on every reply, the preflight, the
 * challenge's proof, the five minutes. Tokens are made at run time and checked with
 * boolean canaries only.
 */

const ORIGIN = "https://telflo.example";
const PENDING = Symbol("pending");

let listener: LoginListener | undefined;
let state: string;
let token: string;

async function start(options: { timeoutMs?: number } = {}): Promise<LoginListener> {
  state = newState();
  token = `tf_${randomBytes(32).toString("base64url")}`;
  listener = await startLoginListener({ origin: ORIGIN, state, ...options });
  return listener;
}

/** The answer if it has settled once pending I/O has run, else PENDING. */
async function settledAnswer(of: LoginListener): Promise<ListenerOutcome | typeof PENDING> {
  return Promise.race([of.answer, new Promise<typeof PENDING>((resolve) => setImmediate(() => resolve(PENDING)))]);
}

function expectRefusal(reply: ListenerReply, status: 403 | 404): void {
  expect(reply.status).toBe(status);
  expect(reply.body).toBe("");
  expect(reply.headers["access-control-allow-origin"]).toBe(ORIGIN);
}

afterEach(() => {
  listener?.close();
  listener = undefined;
  vi.useRealTimers();
});

describe("the state and the page's address", () => {
  it("makes a fresh 43-character base64url state each time", () => {
    const states = new Set(Array.from({ length: 20 }, () => newState()));
    expect(states.size).toBe(20);
    for (const each of states) expect(STATE_PATTERN.test(each)).toBe(true);
  });

  it("puts the parameters in the page address's fragment, never its query", () => {
    const url = cliAuthUrl(ORIGIN, { state: "s".repeat(43), port: 54321, host: "ada-laptop.local" });
    expect(url).toBe(`${ORIGIN}/cli-auth#state=${"s".repeat(43)}&port=54321&host=ada-laptop.local`);
    expect(new URL(url).search).toBe("");
  });
});

describe("the listener accepts the page's answer", () => {
  it("binds 127.0.0.1, takes { state, token } with a 204 naming the server's origin, then stops", async () => {
    const started = await start();
    expect(started.address).toBe("127.0.0.1");
    expect(started.port).toBeGreaterThan(0);
    const reply = await handOff(started.port, ORIGIN, { state, token });
    expect(reply.status).toBe(204);
    expect(reply.body).toBe("");
    expect(reply.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(reply.headers["cache-control"]).toBe("no-store");
    const outcome = await started.answer;
    expect(outcome.kind).toBe("token");
    expect(outcome.kind === "token" && outcome.token === token).toBe(true);
    // Stopped: a second answer finds nobody (refused at connect, or 403 on a held connection).
    const second = await handOff(started.port, ORIGIN, { state, token: `${token}x` }).then(
      (each) => each.status,
      () => "refused",
    );
    expect(second === "refused" || second === 403).toBe(true);
    const after = await started.answer;
    expect(after.kind === "token" && after.token === token).toBe(true);
  });

  it("takes exactly one of two answers whose bodies end together: one 204, the other refused", async () => {
    const started = await start();
    const second = `tf_${randomBytes(32).toString("base64url")}`;
    /** A handoff held open before its body's last byte: `finish()` sends it; `status` is the reply's (or "refused"). */
    const heldOpen = (body: string) => {
      const sent = request({
        host: "127.0.0.1",
        port: started.port,
        method: "POST",
        path: CALLBACK_PATH,
        headers: {
          host: `127.0.0.1:${started.port}`,
          origin: ORIGIN,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        agent: false,
      });
      const status = new Promise<number | "refused">((resolve) => {
        sent.on("response", (reply) => {
          reply.resume();
          resolve(reply.statusCode ?? 0);
        });
        sent.on("error", () => resolve("refused"));
      });
      const written = new Promise<void>((resolve) => sent.write(body.slice(0, -1), () => resolve()));
      return { status, written, finish: () => sent.end(body.slice(-1)) };
    };
    const one = heldOpen(JSON.stringify({ state, token }));
    const other = heldOpen(JSON.stringify({ state, token: second }));
    await Promise.all([one.written, other.written]);
    // A third request answered after both are written: the listener has read both requests' headers and bodies so far.
    expectRefusal(await sendToListener(started.port, { method: "GET", path: "/" }), 404);
    expect(await settledAnswer(started)).toBe(PENDING);
    one.finish();
    other.finish();
    const statuses = await Promise.all([one.status, other.status]);
    expect(statuses.filter((status) => status === 204)).toHaveLength(1);
    expect(statuses.every((status) => status === 204 || status === 403)).toBe(true);
    const outcome = await started.answer;
    // The answer is the token whose handoff got the 204.
    const taken = statuses[0] === 204 ? token : second;
    expect(outcome.kind === "token" && outcome.token === taken).toBe(true);
  });

  it("takes { state, error: \"denied\" } (Cancel on the page)", async () => {
    const started = await start();
    expect((await handOff(started.port, ORIGIN, { state, error: "denied" })).status).toBe(204);
    expect(await started.answer).toEqual({ kind: "denied" });
  });

  it("takes a JSON content type with parameters", async () => {
    const started = await start();
    const reply = await handOff(started.port, ORIGIN, { state, token }, { "content-type": "Application/JSON; charset=utf-8" });
    expect(reply.status).toBe(204);
    expect((await started.answer).kind).toBe("token");
  });
});

describe("the preflight", () => {
  const preflight = (port: number, extra: Record<string, string> = {}) =>
    sendToListener(port, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type", ...extra },
    });

  it("answers POST and content-type for the server's origin, without Allow-Private-Network unless asked, and keeps waiting", async () => {
    const started = await start();
    const reply = await preflight(started.port);
    expect(reply.status).toBe(204);
    expect(reply.body).toBe("");
    expect(reply.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(reply.headers["access-control-allow-methods"]).toBe("POST");
    expect(reply.headers["access-control-allow-headers"]).toBe("content-type");
    expect(reply.headers["access-control-allow-private-network"]).toBeUndefined();
    expect(await settledAnswer(started)).toBe(PENDING);
  });

  it("answers Allow-Private-Network: true when the preflight asks for it", async () => {
    const started = await start();
    const reply = await preflight(started.port, { "access-control-request-private-network": "true" });
    expect(reply.status).toBe(204);
    expect(reply.headers["access-control-allow-private-network"]).toBe("true");
  });

  it.each([
    ["another origin", { origin: "https://elsewhere.example" }],
    ["another method", { "access-control-request-method": "PUT" }],
  ])("refuses a preflight from %s", async (_kind, extra) => {
    const started = await start();
    expectRefusal(await preflight(started.port, extra), 403);
    expect(await settledAnswer(started)).toBe(PENDING);
  });
});

describe("the listener refuses anything else, and keeps waiting", () => {
  type Case = [string, 403 | 404, (port: number) => Promise<ListenerReply>];
  const cases: Case[] = [
    ["another Origin", 403, (port) => handOff(port, "https://elsewhere.example", { state, token })],
    ["the server's origin with another port", 403, (port) => handOff(port, `${ORIGIN}:8443`, { state, token })],
    ["no Origin", 403, (port) => sendToListener(port, { headers: { "content-type": "application/json" }, body: JSON.stringify({ state, token }) })],
    ["Host: localhost", 403, (port) => handOff(port, ORIGIN, { state, token }, { host: `localhost:${port}` })],
    ["Host: another port", 403, (port) => handOff(port, ORIGIN, { state, token }, { host: `127.0.0.1:${port + 1}` })],
    ["another state", 403, (port) => handOff(port, ORIGIN, { state: newState(), token })],
    ["the state with one character changed", 403, (port) => handOff(port, ORIGIN, { state: `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`, token })],
    ["a shorter state", 403, (port) => handOff(port, ORIGIN, { state: state.slice(1), token })],
    ["no state", 403, (port) => handOff(port, ORIGIN, { token })],
    ["a state that isn't text", 403, (port) => handOff(port, ORIGIN, { state: 7, token })],
    ["another key", 403, (port) => handOff(port, ORIGIN, { state, token, extra: true })],
    ["both a token and an error", 403, (port) => handOff(port, ORIGIN, { state, token, error: "denied" })],
    ["another error", 403, (port) => handOff(port, ORIGIN, { state, error: "nope" })],
    ["an empty token", 403, (port) => handOff(port, ORIGIN, { state, token: "" })],
    ["a token that isn't text", 403, (port) => handOff(port, ORIGIN, { state, token: 7 })],
    ["a JSON array", 403, (port) => handOff(port, ORIGIN, [state, token])],
    ["JSON null", 403, (port) => handOff(port, ORIGIN, "null")],
    ["a body that isn't JSON", 403, (port) => handOff(port, ORIGIN, "state=x")],
    ["another content type", 403, (port) => handOff(port, ORIGIN, { state, token }, { "content-type": "text/plain" })],
    ["no content type", 403, (port) => sendToListener(port, { headers: { origin: ORIGIN }, body: JSON.stringify({ state, token }) })],
    [
      "a body over 4 KiB",
      403,
      (port) => handOff(port, ORIGIN, { state, token, pad: "x".repeat(MAXIMUM_BODY_BYTES) }),
    ],
    [
      "a body over 4 KiB sent without a length",
      403,
      (port) =>
        handOff(port, ORIGIN, JSON.stringify({ state, token: `${token}${"x".repeat(MAXIMUM_BODY_BYTES)}` }), { "transfer-encoding": "chunked" }),
    ],
    ["another path", 404, (port) => sendToListener(port, { path: "/callbackx", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ state, token }) })],
    ["a query on the path", 404, (port) => sendToListener(port, { path: `${CALLBACK_PATH}?x=1`, headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ state, token }) })],
    ["the root", 404, (port) => sendToListener(port, { method: "GET", path: "/", headers: { origin: ORIGIN } })],
    ["GET /callback", 404, (port) => sendToListener(port, { method: "GET", headers: { origin: ORIGIN } })],
  ];

  it.each(cases)("refuses %s with %i, Allow-Origin set and no body", async (_kind, status, send) => {
    const started = await start();
    expectRefusal(await send(started.port), status);
    expect(await settledAnswer(started)).toBe(PENDING);
    // Still waiting: the page's real answer is taken after it.
    expect((await handOff(started.port, ORIGIN, { state, token })).status).toBe(204);
    const outcome = await started.answer;
    expect(outcome.kind === "token" && outcome.token === token).toBe(true);
  });

  it("answers a body past 4 KiB with 403 at once and drops the connection, without waiting for the sender to stop", async () => {
    const started = await start();
    const sent = request({
      host: "127.0.0.1",
      port: started.port,
      method: "POST",
      path: CALLBACK_PATH,
      headers: { host: `127.0.0.1:${started.port}`, origin: ORIGIN, "content-type": "application/json", "transfer-encoding": "chunked" },
      agent: false,
    });
    const closed = new Promise<void>((resolve) => sent.on("close", () => resolve()));
    sent.on("error", () => undefined);
    const replied = new Promise<{ status: number; allowOrigin: unknown }>((resolve) =>
      sent.on("response", (reply) => {
        reply.resume();
        resolve({ status: reply.statusCode ?? 0, allowOrigin: reply.headers["access-control-allow-origin"] });
      }),
    );
    // More than 4 KiB, and the request never ended: the sender is still going.
    sent.write(`{"state":"${state}","token":"${"x".repeat(MAXIMUM_BODY_BYTES)}`);
    // Answered while the request is still open (never `end`ed here), then the connection is gone.
    expect(await replied).toEqual({ status: 403, allowOrigin: ORIGIN });
    await closed;
    expect(sent.writableEnded).toBe(false);
    expect(await settledAnswer(started)).toBe(PENDING);
    // Still waiting: the page's real answer is taken after it.
    expect((await handOff(started.port, ORIGIN, { state, token })).status).toBe(204);
  });

  it("refuses PUT /callback with 404", async () => {
    const started = await start();
    expectRefusal(await sendToListener(started.port, { method: "PUT", headers: { origin: ORIGIN } }), 404);
    expect(await settledAnswer(started)).toBe(PENDING);
  });

  it("keeps waiting however many requests it refuses, so none frees its port: a valid answer after 50 is taken", async () => {
    const started = await start();
    for (let index = 0; index < 50; index += 1) {
      expectRefusal(await handOff(started.port, "https://elsewhere.example", { state, token }), 403);
      expectRefusal(await sendToListener(started.port, { method: "GET", path: "/" }), 404);
    }
    expect(await settledAnswer(started)).toBe(PENDING);
    expect((await handOff(started.port, ORIGIN, { state, token })).status).toBe(204);
    expect(await started.answer).toEqual({ kind: "token", token });
  });
});

describe("the listener's end", () => {
  it("stops after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = await start();
    vi.advanceTimersByTime(LISTENER_TIMEOUT_MS - 1);
    expect(await settledAnswer(started)).toBe(PENDING);
    vi.advanceTimersByTime(1);
    expect(await started.answer).toEqual({ kind: "timeout" });
    vi.useRealTimers();
    const after = await handOff(started.port, ORIGIN, { state, token }).then(
      (each) => each.status,
      () => "refused",
    );
    expect(after).toBe("refused");
  });

  it("stops at close(), its answer closed, a later answer never taken", async () => {
    const started = await start();
    started.close();
    expect(await started.answer).toEqual({ kind: "closed" });
    const after = await handOff(started.port, ORIGIN, { state, token }).then(
      (each) => each.status,
      () => "refused",
    );
    expect(after).toBe("refused");
    // A second close changes nothing.
    started.close();
    expect(await started.answer).toEqual({ kind: "closed" });
  });
});

describe("the challenge: the listener proves it knows the state before the page sends anything", () => {
  const challenge = (): string => randomBytes(32).toString("base64url");

  it("answers { challenge } with 200 { proof }, the HMAC-SHA256 of the challenge keyed by the state, and keeps waiting", async () => {
    const started = await start();
    const sent = challenge();
    const reply = await handOff(started.port, ORIGIN, { challenge: sent });
    expect(reply.status).toBe(200);
    expect(reply.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(reply.headers["cache-control"]).toBe("no-store");
    const expected = createHmac("sha256", state).update(PROOF_CONTEXT + sent, "utf8").digest("base64url");
    expect(JSON.parse(reply.body)).toEqual({ proof: expected });
    expect(listenerProof(state, sent)).toBe(expected);
    // The body holds a proof, never the state.
    expect(reply.body.includes(state)).toBe(false);
    expect(await settledAnswer(started)).toBe(PENDING);
    expect((await handOff(started.port, ORIGIN, { state, token })).status).toBe(204);
    expect(await started.answer).toEqual({ kind: "token", token });
  });

  it("proves each challenge anew: two challenges, two proofs", async () => {
    const started = await start();
    const [first, second] = [challenge(), challenge()];
    const proofs = await Promise.all([first, second].map(async (each) => JSON.parse((await handOff(started.port, ORIGIN, { challenge: each })).body).proof));
    expect(proofs).toEqual([listenerProof(state, first), listenerProof(state, second)]);
    expect(proofs[0]).not.toBe(proofs[1]);
  });

  it.each([
    ["another origin", "https://elsewhere.example", { challenge: "c".repeat(43) }],
    ["a challenge too short", ORIGIN, { challenge: "c".repeat(42) }],
    ["a challenge not base64url", ORIGIN, { challenge: `${"c".repeat(42)}=` }],
    ["a challenge that isn't a string", ORIGIN, { challenge: 43 }],
    ["a challenge beside another key", ORIGIN, { challenge: "c".repeat(43), state: "x" }],
  ] as const)("refuses %s (403, no body), and keeps waiting", async (_case, origin, body) => {
    const started = await start();
    expectRefusal(await handOff(started.port, origin, body), 403);
    expect(await settledAnswer(started)).toBe(PENDING);
  });
});

