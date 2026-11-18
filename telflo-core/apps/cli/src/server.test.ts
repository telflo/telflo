import { describe, expect, it } from "vitest";
import { ExitError } from "./output.js";
import {
  chooseServer,
  namedServer,
  NO_SERVER_MESSAGE,
  serverOrigin,
  SERVER_NOT_A_URL_MESSAGE,
  SERVER_NOT_AN_ORIGIN_MESSAGE,
  SERVER_NOT_HTTPS_MESSAGE,
} from "./server.js";

/* The server rule (D27 decision 12): an origin only, HTTPS except loopback. */

function refusalOf(input: string): ExitError {
  try {
    serverOrigin(input);
  } catch (error) {
    if (error instanceof ExitError) return error;
    throw error;
  }
  throw new Error("the server was accepted");
}

describe("serverOrigin (decision 12)", () => {
  it.each([
    ["https://telflo.example.com", "https://telflo.example.com"],
    ["https://telflo.example.com/", "https://telflo.example.com"],
    ["  https://Telflo.Example.COM:443  ", "https://telflo.example.com"],
    ["https://telflo.example:8443", "https://telflo.example:8443"],
    ["http://localhost", "http://localhost"],
    ["http://localhost:50080", "http://localhost:50080"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://127.1.2.3", "http://127.1.2.3"],
    ["http://127.1:9", "http://127.0.0.1:9"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["http://[0:0:0:0:0:0:0:1]", "http://[::1]"],
  ])("accepts %s as %s", (input, origin) => {
    expect(serverOrigin(input)).toBe(origin);
  });

  it.each([
    "http://telflo.example.com",
    "http://telflo.example:8080",
    "http://128.0.0.1",
    "http://10.0.0.1",
    "http://[::2]",
    "http://[::ffff:127.0.0.1]",
    "http://localhost.telflo.example",
    "http://127.0.0.1.nip.io",
  ])("refuses plain http to %s, which isn't this machine", (input) => {
    const error = refusalOf(input);
    expect(error.message).toBe(SERVER_NOT_HTTPS_MESSAGE);
    expect(error.exitCode).toBe(2);
  });

  it.each([
    "https://telflo.example.com/api",
    "https://telflo.example.com/api/public/v1",
    "https://telflo.example.com?x=1",
    "https://telflo.example.com/?",
    "https://telflo.example.com#frag",
    "https://telflo.example.com/#",
    "https://user@telflo.example.com",
    "https://user:hunter2@telflo.example.com",
    "https://:pw@telflo.example.com",
  ])("refuses %s: an origin only", (input) => {
    const error = refusalOf(input);
    expect(error.message).toBe(SERVER_NOT_AN_ORIGIN_MESSAGE);
    expect(error.message.includes("hunter2")).toBe(false);
  });

  it.each(["telflo.example.com", "", "ftp://telflo.example.com", "file:///etc/passwd", "javascript:alert(1)", "https://"])(
    "refuses %j: not an http(s) URL",
    (input) => {
      expect(refusalOf(input).message).toBe(SERVER_NOT_A_URL_MESSAGE);
    },
  );
});

describe("chooseServer (decision 12)", () => {
  it("takes the flag, then TELFLO_SERVER, then the stored server", () => {
    const env = { TELFLO_SERVER: "https://env.example" };
    expect(chooseServer("https://flag.example", env, "https://stored.example")).toBe("https://flag.example");
    expect(chooseServer(undefined, env, "https://stored.example")).toBe("https://env.example");
    expect(chooseServer(undefined, {}, "https://stored.example")).toBe("https://stored.example");
    expect(chooseServer(undefined, { TELFLO_SERVER: "" }, "https://stored.example")).toBe("https://stored.example");
  });

  it("has no default server: none named is exit 2, in fixed words naming --server and TELFLO_SERVER", () => {
    for (const env of [{}, { TELFLO_SERVER: "" }]) {
      expect(namedServer(undefined, env, undefined)).toBeUndefined();
      let refusal: unknown;
      try {
        chooseServer(undefined, env, undefined);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ExitError);
      expect((refusal as ExitError).exitCode).toBe(2);
      expect((refusal as ExitError).message).toBe(NO_SERVER_MESSAGE);
    }
    expect(NO_SERVER_MESSAGE.includes("--server <url>") && NO_SERVER_MESSAGE.includes("TELFLO_SERVER")).toBe(true);
  });

  it("applies the rule to whichever it takes", () => {
    expect(() => chooseServer(undefined, { TELFLO_SERVER: "http://telflo.example" }, undefined)).toThrow(SERVER_NOT_HTTPS_MESSAGE);
    expect(() => namedServer(undefined, {}, "http://stored.example")).toThrow(SERVER_NOT_HTTPS_MESSAGE);
  });
});
