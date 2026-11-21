import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configDir,
  credentialsPath,
  deleteCredentials,
  FILE_SHARED_MESSAGE,
  FOLDER_SHARED_MESSAGE,
  NOT_A_FILE_MESSAGE,
  loadCredentials,
  saveCredentials,
  storedServer,
  type Credentials,
} from "./credentials.js";
import { ExitError } from "./output.js";

/*
 * The credentials file: its folder, its modes, its refusals. Every file is in
 * a temporary folder; the token is made at run time and checked with boolean
 * canaries only.
 */

const posix = process.platform !== "win32";

let root: string;
let dir: string;
let env: NodeJS.ProcessEnv;

function credentials(overrides: Partial<Credentials> = {}): Credentials {
  return {
    version: 1,
    server: "https://telflo.example",
    token: `tf_${randomBytes(32).toString("base64url")}`,
    kind: "person",
    tokenName: "laptop",
    organizationId: "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b",
    ...overrides,
  };
}

function refusalOf(action: () => unknown): ExitError {
  try {
    action();
  } catch (error) {
    if (error instanceof ExitError) return error;
    throw error;
  }
  throw new Error("nothing was refused");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "telflo-credentials-"));
  dir = join(root, "config");
  env = { TELFLO_CLI_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the folder", () => {
  it("is TELFLO_CLI_CONFIG_DIR, else XDG_CONFIG_HOME/telflo, else ~/.config/telflo", () => {
    expect(configDir({ TELFLO_CLI_CONFIG_DIR: "/a", XDG_CONFIG_HOME: "/b" })).toBe("/a");
    expect(configDir({ TELFLO_CLI_CONFIG_DIR: "", XDG_CONFIG_HOME: "/b" })).toBe(join("/b", "telflo"));
    expect(configDir({ XDG_CONFIG_HOME: "" })).toBe(join(homedir(), ".config", "telflo"));
    expect(credentialsPath({ TELFLO_CLI_CONFIG_DIR: "/a" })).toBe(join("/a", "credentials.json"));
  });

  it("never reads TELFLO_CONFIG_DIR", () => {
    expect(configDir({ TELFLO_CONFIG_DIR: "/older-cli" })).toBe(join(homedir(), ".config", "telflo"));
    expect(configDir({ TELFLO_CONFIG_DIR: "/older-cli", XDG_CONFIG_HOME: "/b" })).toBe(join("/b", "telflo"));
  });

  it("defaults to the process's environment (the test setup's temporary folder)", () => {
    expect(configDir()).toBe(process.env.TELFLO_CLI_CONFIG_DIR);
  });
});

describe("saving", () => {
  it("round-trips the file", () => {
    const stored = credentials();
    saveCredentials(stored, env);
    const loaded = loadCredentials(env);
    expect(loaded === null ? false : loaded.token === stored.token).toBe(true);
    expect({ ...loaded, token: "hidden" }).toEqual({ ...stored, token: "hidden" });
    expect(storedServer(env)).toBe("https://telflo.example");
  });

  it.runIf(posix)("creates the folder 0700 and the file 0600", () => {
    saveCredentials(credentials(), env);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
  });

  it("replaces the old file atomically and leaves no temporary file", () => {
    saveCredentials(credentials({ tokenName: "first" }), env);
    saveCredentials(credentials({ tokenName: "second" }), env);
    expect(loadCredentials(env)?.tokenName).toBe("second");
    expect(readdirSync(dir)).toEqual(["credentials.json"]);
  });

  it("removes its temporary file when the rename fails", () => {
    mkdirSync(join(dir, "credentials.json"), { recursive: true });
    writeFileSync(join(dir, "credentials.json", "occupied"), "x");
    expect(() => saveCredentials(credentials(), env)).toThrow();
    expect(readdirSync(dir)).toEqual(["credentials.json"]);
  });

  it("refuses to store an incomplete login", () => {
    expect(() => saveCredentials({ ...credentials(), token: "tf_short" }, env)).toThrow(ExitError);
    expect(existsSync(dir)).toBe(false);
  });

  it.runIf(posix)("refuses a folder others can write, writing nothing", () => {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o777);
    expect(refusalOf(() => saveCredentials(credentials(), env)).message).toBe(FOLDER_SHARED_MESSAGE(dir));
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("loading", () => {
  it("answers null when there is no file", () => {
    expect(loadCredentials(env)).toBeNull();
    expect(storedServer(env)).toBeUndefined();
  });

  it.runIf(posix)("refuses a file others can read, with the chmod to run, before reading it", () => {
    saveCredentials(credentials(), env);
    const path = join(dir, "credentials.json");
    // Not JSON at all: were it read, the refusal would be the shape's, not the mode's.
    writeFileSync(path, "not json");
    chmodSync(path, 0o640);
    const error = refusalOf(() => loadCredentials(env));
    expect(error.message).toBe(FILE_SHARED_MESSAGE(path, 0o640));
    expect(error.message.includes("can be read by other users")).toBe(true);
    expect(error.message.includes(`chmod 600 ${path}`)).toBe(true);
    expect(error.exitCode).toBe(3);
    expect(storedServer(env)).toBeUndefined();
  });

  it.runIf(posix)("refuses a file others can write", () => {
    saveCredentials(credentials(), env);
    const path = join(dir, "credentials.json");
    chmodSync(path, 0o602);
    expect(refusalOf(() => loadCredentials(env)).message).toBe(`The credentials file ${path} can be written by other users: run chmod 600 ${path}, or telflo login.`);
    chmodSync(path, 0o666);
    expect(refusalOf(() => loadCredentials(env)).message.includes("can be read and written by other users")).toBe(true);
    chmodSync(path, 0o611);
    expect(refusalOf(() => loadCredentials(env)).message.includes("can be used by other users")).toBe(true);
  });

  it.runIf(posix)("refuses a folder others can write", () => {
    saveCredentials(credentials(), env);
    chmodSync(dir, 0o770);
    expect(refusalOf(() => loadCredentials(env)).message).toBe(FOLDER_SHARED_MESSAGE(dir));
    chmodSync(dir, 0o700);
  });

  it.runIf(posix)("refuses a symbolic link in the file's place", () => {
    saveCredentials(credentials(), env);
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, readFileSync(join(dir, "credentials.json")), { mode: 0o600 });
    rmSync(join(dir, "credentials.json"));
    symlinkSync(elsewhere, join(dir, "credentials.json"));
    expect(refusalOf(() => loadCredentials(env)).message.includes("run telflo login")).toBe(true);
  });

  // A FIFO would block an open without O_NONBLOCK: the load runs in a child
  // process with a timeout, so a regression fails here instead of hanging.
  it.runIf(posix)(
    "refuses a FIFO in the file's place without waiting on it",
    () => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      execFileSync("mkfifo", ["-m", "600", join(dir, "credentials.json")]);
      const script = join(root, "load-fifo.mts");
      writeFileSync(
        script,
        [
          `import { loadCredentials } from ${JSON.stringify(fileURLToPath(new URL("./credentials.ts", import.meta.url)))};`,
          "try {",
          "  loadCredentials({ TELFLO_CLI_CONFIG_DIR: process.argv[2] });",
          '  process.stdout.write("loaded");',
          "} catch (error) {",
          '  process.stdout.write(error instanceof Error && error.message.includes("run telflo login") ? "refused" : "other");',
          "}",
        ].join("\n"),
      );
      const child = spawnSync(process.execPath, ["--import", "tsx", script, dir], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
        timeout: 8000,
      });
      expect(child.signal).toBeNull();
      expect(child.stdout).toBe("refused");
    },
    20_000,
  );

  it("refuses a folder in the file's place", () => {
    mkdirSync(join(dir, "credentials.json"), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    expect(refusalOf(() => loadCredentials(env)).message.includes("run telflo login")).toBe(true);
  });

  it.each([
    ["an unknown version", { version: 2 }],
    ["another credentials format", { api_url: "https://telflo.example" }],
    ["a server that isn't an origin", { server: "https://telflo.example/api" }],
    ["a plain-http server", { server: "http://telflo.example" }],
    ["a malformed token", { token: "tf_short" }],
    ["an unknown kind", { kind: "user" }],
    ["an uppercased organization id", { organizationId: "0B7E8A9C-1D2E-4F30-8A4B-5C6D7E8F9A0B" }],
    ["a token name that isn't text", { tokenName: 7 }],
    ["a missing organization", { organizationId: undefined }],
  ])("refuses %s (run telflo login), never guessing", (_label, change) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: Record<string, unknown> = { ...credentials(), ...change };
    for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(record), { mode: 0o600 });
    const error = refusalOf(() => loadCredentials(env));
    expect(error.message).toBe(`The credentials file ${join(dir, "credentials.json")} isn't one this CLI can read: run telflo login.`);
    expect(error.exitCode).toBe(3);
  });

  it.each([["not JSON"], ["[1,2]"], ["null"]])("refuses the text %s", (text) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "credentials.json"), text, { mode: 0o600 });
    expect(refusalOf(() => loadCredentials(env)).message.includes("run telflo login")).toBe(true);
  });
});

describe("deleting", () => {
  it("removes the file and says whether there was one", () => {
    saveCredentials(credentials(), env);
    expect(deleteCredentials(env)).toBe(true);
    expect(deleteCredentials(env)).toBe(false);
    expect(loadCredentials(env)).toBeNull();
  });

  it.runIf(posix)("refuses a folder or a dangling symbolic link in the file's place (exit 3), leaving it", () => {
    mkdirSync(join(dir, "credentials.json"), { recursive: true });
    const folder = refusalOf(() => deleteCredentials(env));
    expect(folder.exitCode).toBe(3);
    expect(folder.message).toBe(NOT_A_FILE_MESSAGE(join(dir, "credentials.json")));
    expect(folder.message).toBe(`The credentials file ${join(dir, "credentials.json")} isn't a file this CLI wrote: remove it yourself.`);
    expect(statSync(join(dir, "credentials.json")).isDirectory()).toBe(true);
    rmSync(join(dir, "credentials.json"), { recursive: true });
    symlinkSync(join(root, "nowhere.json"), join(dir, "credentials.json"));
    expect(refusalOf(() => deleteCredentials(env)).exitCode).toBe(3);
    expect(lstatSync(join(dir, "credentials.json")).isSymbolicLink()).toBe(true);
  });

  it.runIf(posix)("removes a file others can read too", () => {
    saveCredentials(credentials(), env);
    chmodSync(join(dir, "credentials.json"), 0o644);
    expect(deleteCredentials(env)).toBe(true);
  });
});
