import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handOff, parametersOf, sendToListener } from "../tests/listener-request.js";
import { fakeStdin, type FakeStdin } from "../tests/run-cli.js";
import {
  BROWSER_PASTE_PROMPT,
  BROWSER_WORDS,
  browserLoginToken,
  cliHost,
  DENIED_MESSAGE,
  HOST_MAXIMUM_LENGTH,
  TIMED_OUT_MESSAGE,
  TOO_MANY_REFUSALS_MESSAGE,
  UNKNOWN_HOST,
} from "./login-browser.js";
import { LISTENER_TIMEOUT_MS, MAXIMUM_REFUSALS, STATE_PATTERN } from "./login-listener.js";
import { CANCELLED_MESSAGE } from "./prompt.js";
import { EXIT, ExitError, setIo } from "./output.js";

/*
 * `telflo login`'s browser flow: the listener, the page's address printed
 * and handed to the opener (a stand-in: no browser starts), and the
 * hidden prompt racing them through a pty-less stream. Tokens are made at
 * run time and checked with boolean canaries only.
 */

const SERVER = "https://telflo.example";

let stdin: FakeStdin;
let stderr: string;
let opened: string[];
let token: string;

function open(url: string): boolean {
  opened.push(url);
  return true;
}

/** The page's address once the flow has opened it. */
async function openedUrl(): Promise<string> {
  await vi.waitFor(() => expect(opened).toHaveLength(1));
  return opened[0] ?? "";
}

async function refusalOf(promise: Promise<unknown>): Promise<ExitError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExitError) return error;
    throw error;
  }
  throw new Error("nothing was refused");
}

/** Whether a request to the port still finds the listener. */
async function listening(port: number): Promise<boolean> {
  return sendToListener(port, { method: "GET", path: "/" }).then(
    () => true,
    () => false,
  );
}

beforeEach(() => {
  stderr = "";
  opened = [];
  token = `tf_${randomBytes(32).toString("base64url")}`;
  stdin = fakeStdin({ tty: true });
  setIo({ stdin, stderr: (text) => void (stderr += text), stdout: () => undefined });
});

afterEach(() => {
  setIo();
  vi.useRealTimers();
});

describe("cliHost", () => {
  it.each([
    ["ada-laptop.local", "ada-laptop.local"],
    ["Ada's MacBook Pro", "AdasMacBookPro"],
    ["host_name with spaces", "hostnamewithspaces"],
    ["a".repeat(40), "a".repeat(HOST_MAXIMUM_LENGTH)],
    ["日本語のマシン", UNKNOWN_HOST],
    ["", UNKNOWN_HOST],
  ])("names %j as %j", (name, expected) => {
    expect(cliHost(name)).toBe(expected);
  });
});

describe("browserLoginToken", () => {
  it("opens the page with the listener's parameters in the fragment, prints the URL, and takes the handed-over token", async () => {
    const answer = browserLoginToken(SERVER, { open, machineName: () => "Ada's laptop" });
    const url = await openedUrl();
    const { state, port, host } = parametersOf(url);
    expect(url.startsWith(`${SERVER}/cli-auth#state=`)).toBe(true);
    expect(new URL(url).search).toBe("");
    expect(STATE_PATTERN.test(state)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(host).toBe("Adaslaptop");
    expect(url).toBe(`${SERVER}/cli-auth#state=${state}&port=${port}&host=Adaslaptop`);
    expect(stderr).toBe(`${BROWSER_WORDS(url)}\n${BROWSER_PASTE_PROMPT}`);

    expect((await handOff(port, SERVER, { state, token })).status).toBe(204);
    const received = await answer;
    expect(stderr.includes(token)).toBe(false);
    expect(received === token).toBe(true);
    // The prompt closed, the terminal restored; the listener stopped.
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(await listening(port)).toBe(false);
  });

  it("uses this machine's name by default", async () => {
    const answer = browserLoginToken(SERVER, { open });
    const { host } = parametersOf(await openedUrl());
    expect(/^[A-Za-z0-9.-]{1,32}$/.test(host)).toBe(true);
    stdin.write("\u0003");
    await refusalOf(answer);
  });

  it("takes a token pasted at the prompt instead, and stops the listener", async () => {
    const answer = browserLoginToken(SERVER, { open, machineName: () => "box" });
    const { port } = parametersOf(await openedUrl());
    stdin.write(`${token}\r`);
    const received = await answer;
    expect(received === token).toBe(true);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(await listening(port)).toBe(false);
    expect(stderr.includes(token)).toBe(false);
  });

  it("ends with exit 3 when the page's Cancel is the answer", async () => {
    const answer = browserLoginToken(SERVER, { open, machineName: () => "box" });
    const ended = refusalOf(answer);
    const { state, port } = parametersOf(await openedUrl());
    expect((await handOff(port, SERVER, { state, error: "denied" })).status).toBe(204);
    const refusal = await ended;
    expect([refusal.message, refusal.exitCode]).toEqual([DENIED_MESSAGE, EXIT.AUTH]);
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("ends with exit 3 at Ctrl-C, the listener stopped", async () => {
    const answer = browserLoginToken(SERVER, { open, machineName: () => "box" });
    const { port } = parametersOf(await openedUrl());
    stdin.write("tf_part\u0003");
    const refusal = await refusalOf(answer);
    expect([refusal.message, refusal.exitCode]).toEqual([CANCELLED_MESSAGE, EXIT.AUTH]);
    expect(await listening(port)).toBe(false);
  });

  it(`ends with exit 3 after ${MAXIMUM_REFUSALS} refused requests`, async () => {
    const answer = browserLoginToken(SERVER, { open, machineName: () => "box" });
    const ended = refusalOf(answer);
    const { port } = parametersOf(await openedUrl());
    for (let index = 0; index < MAXIMUM_REFUSALS; index += 1) {
      expect((await handOff(port, "https://elsewhere.example", { state: "x", token })).status).toBe(403);
    }
    const refusal = await ended;
    expect([refusal.message, refusal.exitCode]).toEqual([TOO_MANY_REFUSALS_MESSAGE, EXIT.AUTH]);
    expect(stdin.rawModes).toEqual([true, false]);
  });

  it("ends with exit 3 after five minutes without an answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const answer = browserLoginToken(SERVER, { open, machineName: () => "box" });
    await openedUrl();
    vi.advanceTimersByTime(LISTENER_TIMEOUT_MS);
    const refusal = await refusalOf(answer);
    expect([refusal.message, refusal.exitCode]).toEqual([TIMED_OUT_MESSAGE, EXIT.AUTH]);
    expect(stdin.rawModes).toEqual([true, false]);
  });
});
