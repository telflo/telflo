import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../tests/run-cli.js";
import { registerConfigRulesCommand } from "./commands/config-rules.js";
import { registerConfigCommands } from "./commands/config.js";
import { COMMAND_NEEDED_MESSAGE, createProgram, jsonRequested, main } from "./program.js";
import { VERSION } from "./version.js";

/* The root command: its options, its exits, every area registered (D27 decisions 11 and 18, Preflight ruling 22). */

// Task 4a's and 4c's areas, as spies: the config command program.ts hands them.
vi.mock("./commands/config.js", () => ({ registerConfigCommands: vi.fn() }));
vi.mock("./commands/config-rules.js", () => ({ registerConfigRulesCommand: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("the root command", () => {
  it("prints the version for -V and --cli-version (exit 0)", async () => {
    for (const flag of ["-V", "--cli-version"]) {
      const result = await runCli([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${VERSION}\n`);
    }
  });

  it("prints help to stdout (exit 0)", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout.includes("Usage: telflo")).toBe(true);
    for (const command of ["login", "whoami", "logout", "org", "config"]) expect(result.stdout.includes(`  ${command}`)).toBe(true);
  });

  it("exits 2 for a usage error, and with no command", async () => {
    expect((await runCli(["login", "--frobnicate"])).code).toBe(2);
    expect((await runCli(["whoami", "extra"])).code).toBe(2);
    expect((await runCli([])).code).toBe(2);
  });

  it("never echoes a token typed on argv in commander's own messages", async () => {
    const token = `tf_${randomBytes(32).toString("base64url")}`;
    for (const args of [[token], ["login", "--token", token], ["login", token], ["org", "use"]]) {
      const result = await runCli(args);
      expect(result.code).toBe(2);
      expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
    }
  });

  it("writes --json errors as one JSON document on stderr", async () => {
    const result = await runCli(["--json", "whoami"]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "auth_error", message: "Not logged in: run telflo login (or set TELFLO_TOKEN).", status: null },
    });
    expect(result.stdout).toBe("");
  });

  it("with --json, commander's own usage errors are the one JSON error on stderr, exit 2 (Ruling 254)", async () => {
    const token = `tf_${randomBytes(32).toString("base64url")}`;
    for (const [args, message] of [
      [["--json", "whoami", "extra"], "too many arguments for 'whoami'. Expected 0 arguments but got 1."],
      [["--json", "login", "--frobnicate"], "unknown option '--frobnicate'"],
      [["login", "--json", "--frobnicate"], "unknown option '--frobnicate'"],
      [["--json", token], "unknown command 'tf_…'"],
      [["--json"], COMMAND_NEEDED_MESSAGE],
      [["--json", "org"], COMMAND_NEEDED_MESSAGE],
      [["--json", "org", "use"], "missing required argument 'id'"],
    ] as const) {
      const result = await runCli(args);
      expect(result.stdout.includes(token) || result.stderr.includes(token)).toBe(false);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({ error: { code: "usage_error", message, status: null } });
    }
    // Without --json (or with it only after --), commander's own words, plain.
    const plain = await runCli(["login", "--frobnicate"]);
    expect(plain.code).toBe(2);
    expect(plain.stderr).toBe("error: unknown option '--frobnicate'\n");
    expect((await runCli(["whoami", "--", "--json"])).stderr.startsWith("error: ")).toBe(true);
    // --help and the version are unchanged with --json.
    const help = await runCli(["--json", "--help"]);
    expect(help.code === 0 && help.stdout.includes("Usage: telflo") && help.stderr === "").toBe(true);
    expect((await runCli(["--json", "-V"])).stdout).toBe(`${VERSION}\n`);
  });

  it("jsonRequested: --json anywhere before --", () => {
    expect(jsonRequested(["node", "telflo", "deploy", "--json"])).toBe(true);
    expect(jsonRequested(["node", "telflo", "--", "--json"])).toBe(false);
    expect(jsonRequested(["node", "--json"])).toBe(false);
  });

  it("resets --json between runs", async () => {
    await runCli(["--json", "whoami"]);
    expect((await runCli(["whoami"])).stderr.startsWith("error: ")).toBe(true);
  });

  it("creates the config command and hands it to Task 4a's and 4c's areas", () => {
    vi.mocked(registerConfigCommands).mockClear();
    vi.mocked(registerConfigRulesCommand).mockClear();
    const program = createProgram();
    const config = program.commands.find((command) => command.name() === "config");
    expect(config).toBeDefined();
    expect(vi.mocked(registerConfigCommands).mock.calls).toEqual([[config]]);
    expect(vi.mocked(registerConfigRulesCommand).mock.calls).toEqual([[config]]);
    const names = program.commands.map((command) => command.name());
    for (const name of ["login", "whoami", "logout", "org", "config"]) expect(names).toContain(name);
  });
});

describe("main (the bin's entry)", () => {
  it("sets the process's exit code from the run", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await main(["node", "telflo", "-V"]);
    expect(process.exitCode).toBe(0);
    expect(write).toHaveBeenCalledWith(`${VERSION}\n`);
    const writeError = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await main(["node", "telflo", "--frobnicate"]);
    expect(process.exitCode).toBe(2);
    expect(writeError).toHaveBeenCalled();
  });
});
