import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { truncateAll } from "@telflo/db/testing";
import { fakeOttlEvaluatorMarker } from "../../api/src/testing/fake-ottl-evaluator.js";
import { UNCALLED_TESTING } from "../../api/src/testing/otelcol-testing.js";
import { useFakeOttlEvaluator } from "../../api/src/testing/ottl-evaluator.js";
import { deleteCredentials } from "../src/credentials.js";
import { LINT_FAILED_MESSAGE, YAML_INVALID_MESSAGE } from "../src/commands/ottl.js";
import { runCli, serviceAccountWithToken, useApiServer, type CliRun } from "./harness.js";

/*
 * telflo ottl lint against the real API in process, the OTTL evaluator the
 * api's OpenAPI-checked fake: a configuration's every expression,
 * expressions against a context (each kind), an invalid one (exit 4), a
 * YAML that doesn't parse (422: its errors, exit 4) and the not-logged-in
 * exit 3. Tokens are checked with boolean canaries only; no log line holds
 * an expression.
 */

const evaluator = useFakeOttlEvaluator();
const api = useApiServer(() => ({ testing: { ...UNCALLED_TESTING, ottlEvaluator: evaluator.client } }));

const MARKER = "cli-ottl-marker-3a9f";
const CONFIG = `processors:
  filter:
    logs:
      log_record:
        - IsMatch(body, "${MARKER}")
  transform:
    log_statements:
      - context: log
        statements:
          - set(attributes["env"], "prod")
`;

let tokens: string[];

function holdsAnyToken(...texts: string[]): boolean {
  return texts.some((text) => tokens.some((token) => text.includes(token)));
}

async function cli(args: string[], input?: string): Promise<CliRun> {
  const result = await runCli(args, input === undefined ? {} : { input });
  expect(holdsAnyToken(result.stdout, result.stderr)).toBe(false);
  return result;
}

beforeEach(async () => {
  await truncateAll(api.ownerDb);
  deleteCredentials();
  tokens = [];
  api.logLines.length = 0;
  const account = await serviceAccountWithToken(api.ownerDb, "read");
  tokens.push(account.token);
  vi.stubEnv("TELFLO_TOKEN", account.token);
  vi.stubEnv("TELFLO_SERVER", api.origin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  expect(holdsAnyToken(...api.logLines)).toBe(false);
  expect(api.logLines.some((line) => line.includes(MARKER))).toBe(false);
  expect(evaluator.fake.takeViolations()).toEqual([]);
});

describe("telflo ottl lint", () => {
  it("lints every expression of a configuration with a read token", async () => {
    const result = await cli(["--json", "ottl", "lint", "-"], CONFIG);
    expect(result.code).toBe(0);
    const reply = JSON.parse(result.stdout) as { valid: boolean; checked: number; items: Array<{ kind: string; location: string | null }> };
    expect(reply.valid).toBe(true);
    expect(reply.checked).toBe(2);
    expect(reply.items.map((item) => item.kind).sort()).toEqual(["condition", "statement"]);
    const human = await cli(["ottl", "lint", "-"], CONFIG);
    expect(human.stdout.trimEnd().split("\n").at(-1)?.startsWith("All 2 expressions parse")).toBe(true);
  });

  it("lints expressions against a context, each kind, and an invalid one is exit 4", async () => {
    for (const [kind, expected] of [
      ["condition", "condition"],
      ["statement", "statement"],
      ["value", "valueExpression"],
    ] as const) {
      const result = await cli(["--json", "ottl", "lint", "--context", "log", "--kind", kind, "--expr", "body"]);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.stdout) as { items: Array<{ kind: string }> }).items.map((item) => item.kind)).toEqual([expected]);
    }
    const invalid = await cli(["ottl", "lint", "--context", "log", "--expr", `body == "${fakeOttlEvaluatorMarker("invalid")}"`]);
    expect(invalid.code).toBe(4);
    expect(invalid.stdout.startsWith("FAIL condition[0]")).toBe(true);
    expect(invalid.stderr).toBe(`error: ${LINT_FAILED_MESSAGE}\n`);
  });

  it("prints the errors of a YAML that doesn't parse (exit 4), and exits 3 without a login", async () => {
    const invalid = await cli(["ottl", "lint", "-"], "processors: [\n");
    expect(invalid.code).toBe(4);
    expect(invalid.stdout.startsWith("Invalid YAML:\n  - ")).toBe(true);
    expect(invalid.stderr).toBe(`error: ${YAML_INVALID_MESSAGE}\n`);
    vi.stubEnv("TELFLO_TOKEN", "");
    expect((await cli(["ottl", "lint", "-"], CONFIG)).code).toBe(3);
  });
});
