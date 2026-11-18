import { describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_USAGE,
  BOOTSTRAP_USAGE_PROBLEMS,
  describeFailure,
  parseBootstrapArguments,
  parseResetLinkArguments,
  RESET_LINK_USAGE,
  RESET_LINK_USAGE_PROBLEMS,
  REFUSING_MAILER,
  runAdminCommand,
  type AdminCommandResources,
} from "./bootstrap.js";

/*
 * `telflo-admin bootstrap`'s usage (D36-1 decision 37): exit 2 with fixed
 * lines, before anything is opened. Its paths against the database and
 * Mailpit are bootstrap.integration.test.ts's.
 */

const EMAIL = "first-admin@example.com";

describe("parseBootstrapArguments", () => {
  it("reads --email (trimmed and lowercased, as registration reads it) and --organization (trimmed), in either spelling", () => {
    expect(parseBootstrapArguments(["--email", " First-Admin@Example.com ", "--organization", "  Acme  "])).toEqual({
      kind: "bootstrap",
      input: { email: EMAIL, organization: "Acme" },
    });
    expect(parseBootstrapArguments([`--organization=Acme`, `--email=${EMAIL}`])).toEqual({
      kind: "bootstrap",
      input: { email: EMAIL, organization: "Acme" },
    });
  });

  it.each([
    ["nothing", []],
    ["no --organization", ["--email", EMAIL]],
    ["no --email", ["--organization", "Acme"]],
    ["an unknown option", ["--email", EMAIL, "--organization", "Acme", "--password", "x"]],
    ["a positional argument", ["--email", EMAIL, "--organization", "Acme", "extra"]],
    ["--email twice", ["--email", EMAIL, "--email", "other@example.com", "--organization", "Acme"]],
    ["--organization twice", ["--email", EMAIL, "--organization", "Acme", "--organization=Beta"]],
    ["--email without a value", ["--organization", "Acme", "--email"]],
    // Q266: the link is always printed; the flag that asked for it is gone, refused as any unknown option.
    ["--print-link", ["--email", EMAIL, "--organization", "Acme", "--print-link"]],
    ["--print-link first", ["--print-link", "--email", EMAIL, "--organization", "Acme"]],
    ["--print-link with a value", ["--email", EMAIL, "--organization", "Acme", "--print-link=yes"]],
  ])("refuses %s as a usage error", (_label, args) => {
    expect(parseBootstrapArguments(args)).toEqual({ kind: "usage", problem: BOOTSTRAP_USAGE_PROBLEMS.arguments });
  });

  it("refuses an address that isn't one, and one at a reserved domain, naming the rule and never the value", () => {
    for (const email of ["not-an-email", "", `${"a".repeat(250)}@example.com`]) {
      expect(parseBootstrapArguments(["--email", email, "--organization", "Acme"])).toEqual({
        kind: "usage",
        problem: BOOTSTRAP_USAGE_PROBLEMS.email,
      });
    }
    for (const email of ["robot@service-accounts.telflo.invalid", "Gone@Deleted-Accounts.Telflo.Invalid"]) {
      expect(parseBootstrapArguments(["--email", email, "--organization", "Acme"])).toEqual({
        kind: "usage",
        problem: BOOTSTRAP_USAGE_PROBLEMS.reservedEmail,
      });
    }
  });

  it("refuses an empty organization name and one over 100 characters", () => {
    for (const organization of ["", "   ", "x".repeat(101)]) {
      expect(parseBootstrapArguments(["--email", EMAIL, "--organization", organization])).toEqual({
        kind: "usage",
        problem: BOOTSTRAP_USAGE_PROBLEMS.organization,
      });
    }
    expect(parseBootstrapArguments(["--email", EMAIL, "--organization", "x".repeat(100)])).toMatchObject({ kind: "bootstrap" });
  });
});

describe("parseResetLinkArguments (Q258)", () => {
  it("reads --email, trimmed and lowercased, in either spelling", () => {
    for (const args of [["--email", " First-Admin@Example.com "], [`--email=${EMAIL}`]]) {
      expect(parseResetLinkArguments(args)).toEqual({ kind: "reset-link", input: { email: EMAIL } });
    }
  });

  it.each([
    ["nothing", []],
    ["--email twice", ["--email", EMAIL, "--email", "other@example.com"]],
    ["--email without a value", ["--email"]],
    ["--organization", ["--email", EMAIL, "--organization", "Acme"]],
    ["--print-link", ["--email", EMAIL, "--print-link"]],
    ["an unknown option", ["--email", EMAIL, "--password", "x"]],
    ["a positional argument", ["--email", EMAIL, "extra"]],
  ])("refuses %s as a usage error", (_label, args) => {
    expect(parseResetLinkArguments(args)).toEqual({ kind: "usage", problem: RESET_LINK_USAGE_PROBLEMS.arguments });
  });

  it("refuses an address that isn't one, never naming the value; a reserved domain's goes on to the lookup (refused there like an unknown one)", () => {
    expect(parseResetLinkArguments(["--email", "not-an-email"])).toEqual({ kind: "usage", problem: RESET_LINK_USAGE_PROBLEMS.email });
    expect(parseResetLinkArguments(["--email", "robot@service-accounts.telflo.invalid"])).toMatchObject({ kind: "reset-link" });
  });
});

describe("runAdminCommand", () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const open = vi.fn(async (): Promise<AdminCommandResources> => {
      throw new Error("opened");
    });
    const code = await runAdminCommand(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, open);
    return { code, out, err, opened: open.mock.calls.length > 0 };
  };

  it("names --email and --organization, and no other option, in the usage line (Q266)", () => {
    expect(BOOTSTRAP_USAGE).toBe("Usage: telflo-admin bootstrap --email <email> --organization <name>");
    expect(BOOTSTRAP_USAGE_PROBLEMS.arguments).toBe("telflo-admin bootstrap takes --email and --organization, each once, and nothing else.");
  });

  it("answers 2 with the usage line, opening nothing, for no command or another command", async () => {
    for (const argv of [[], ["grant", "--email", EMAIL], ["--email", EMAIL, "--organization", "Acme"]]) {
      expect(await run(argv)).toEqual({ code: 2, out: [], err: [BOOTSTRAP_USAGE, RESET_LINK_USAGE], opened: false });
    }
  });

  it("answers 2 for reset-link's usage errors with its problem and usage line, opening nothing", async () => {
    expect(RESET_LINK_USAGE).toBe("Usage: telflo-admin reset-link --email <email>");
    for (const [argv, problem] of [
      [["reset-link"], RESET_LINK_USAGE_PROBLEMS.arguments],
      [["reset-link", "--email", EMAIL, "--verbose"], RESET_LINK_USAGE_PROBLEMS.arguments],
      [["reset-link", "--email", "typed-value-not-an-email"], RESET_LINK_USAGE_PROBLEMS.email],
    ] as const) {
      const result = await run([...argv]);
      expect(result).toEqual({ code: 2, out: [], err: [problem, RESET_LINK_USAGE], opened: false });
      expect(result.err.some((line) => line.includes("typed-value"))).toBe(false);
    }
  });

  it("answers 2 for --print-link, gone with Q266, and for any other unknown flag, opening nothing", async () => {
    for (const flag of ["--print-link", "--verbose"]) {
      expect(await run(["bootstrap", "--email", EMAIL, "--organization", "Acme", flag])).toEqual({
        code: 2,
        out: [],
        err: [BOOTSTRAP_USAGE_PROBLEMS.arguments, BOOTSTRAP_USAGE],
        opened: false,
      });
    }
  });

  it("answers 2 with the problem and the usage line, opening nothing, for bootstrap's usage errors; the value typed is never printed", async () => {
    const result = await run(["bootstrap", "--email", "typed-value-not-an-email", "--organization", "Acme"]);
    expect(result).toEqual({ code: 2, out: [], err: [BOOTSTRAP_USAGE_PROBLEMS.email, BOOTSTRAP_USAGE], opened: false });
    expect(result.err.some((line) => line.includes("typed-value"))).toBe(false);
  });

  it("opens the API's resources only for a well-formed bootstrap, and closes them whatever happens", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async (): Promise<AdminCommandResources> => ({
      // A pool whose first query fails: the command throws, and still closes.
      deps: {
        db: {
          transaction: () => ({
            execute: async () => {
              throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
            },
          }),
        } as never,
        settings: { publicWebUrl: "http://localhost:56898" },
        opampServer: {} as never,
        now: () => new Date(),
        out: () => {},
        err: () => {},
      },
      close,
    }));
    await expect(
      runAdminCommand(["bootstrap", "--email", EMAIL, "--organization", "Acme"], { out: () => {}, err: () => {} }, open),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("REFUSING_MAILER (decision 54, Q266)", () => {
  it("sends nothing: every send is refused", async () => {
    await expect(REFUSING_MAILER.send({ to: EMAIL, subject: "s", text: "t", html: "h" })).rejects.toThrow();
  });
});

describe("describeFailure", () => {
  it("names an error by its name and code only, never its message", () => {
    const line = describeFailure(Object.assign(new Error("password authentication failed for secret-canary@db.internal"), { code: "28P01" }));
    expect(line).toBe("The command failed (Error 28P01). Nothing after the failure was done.");
    expect(line.includes("secret-canary")).toBe(false);
  });

  it("lets the settings' missing variable through by name, and no other settings refusal", () => {
    expect(describeFailure(new Error("Missing required environment variable: TELFLO_DATABASE_URL"))).toBe(
      "The command failed (Error). Missing required environment variable: TELFLO_DATABASE_URL. Nothing after the failure was done.",
    );
    const quoting = describeFailure(new Error("Environment variable TELFLO_API_PORT must be a positive integer, received: secret-canary"));
    expect(quoting.includes("secret-canary")).toBe(false);
    expect(describeFailure(new Error("Missing required environment variable: X received: secret-canary")).includes("secret-canary")).toBe(false);
  });

  it("drops a name or code that isn't a plain token", () => {
    expect(describeFailure({ name: "has spaces secret-canary", code: "x".repeat(65) })).toBe(
      "The command failed (unknown). Nothing after the failure was done.",
    );
    expect(describeFailure(undefined)).toBe("The command failed (unknown). Nothing after the failure was done.");
  });
});
