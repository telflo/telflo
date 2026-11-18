import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPerUserLimiter, RATE_LIMITS } from "../../http/rate-limits.js";
import type { LintTextsRequest, LintTextsResult, OttlEvaluatorClient } from "../../ottl-evaluator/client.js";
import type { Actor } from "../organizations/service.js";
import { createOttlLintService, OTTL_LINTS_IN_FLIGHT_PER_USER } from "./service.js";

/*
 * The lint service on its own (D25 decision 33; Ruling 168), with a fake
 * actor and an in-process evaluator: the person's limits are kept per
 * organization (one person in two organizations), their in-flight places,
 * and a YAML's over-long expression answered here, the rest sent with
 * their indexes kept.
 */

const silent = { info: () => undefined, warn: () => undefined };

/** One user acting in `organizationId`, as a token's actor is. */
const actorIn = (userId: string, organizationId: string): Actor => ({
  context: { userId, organizationId, role: "contributor" },
  email: "service-account@service-accounts.telflo.invalid",
});

/** Every text valid, in the evaluator's order; each request recorded. */
function validEverything(): { client: OttlEvaluatorClient; requests: LintTextsRequest[] } {
  const requests: LintTextsRequest[] = [];
  const lint = async (request: LintTextsRequest): Promise<LintTextsResult> => {
    requests.push(request);
    const items = [
      ...(request.conditions ?? []).map((_, index) => ({ kind: "condition" as const, index, valid: true, error: null })),
      ...(request.statements ?? []).map((_, index) => ({ kind: "statement" as const, index, valid: true, error: null })),
      ...(request.valueExpressions ?? []).map((_, index) => ({ kind: "valueExpression" as const, index, valid: true, error: null })),
    ];
    return { kind: "linted", ottlVersion: "v0.162.0", items };
  };
  const unused = () => Promise.reject(new Error("not this test's"));
  return { requests, client: { lint, evaluate: unused, validate: unused, health: unused } };
}

const one = { context: "log" as const, conditions: ["true"] };

describe("the person's lints are kept per organization (Ruling 168)", () => {
  it("one user in two organizations has a budget in each: the second organization's first lint passes after the first's are spent", async () => {
    const evaluator = validEverything();
    const service = createOttlLintService({ evaluator: evaluator.client, limiter: createPerUserLimiter({ max: 1, windowMs: 60_000 }), log: silent });
    const userId = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];

    expect((await service.lintExpressions(actorIn(userId, first), first, one)).valid).toBe(true);
    await expect(service.lintExpressions(actorIn(userId, first), first, one)).rejects.toMatchObject({ statusCode: 429, code: "rate_limited" });
    expect((await service.lintExpressions(actorIn(userId, second), second, one)).valid).toBe(true);
    await expect(service.lintExpressions(actorIn(userId, second), second, one)).rejects.toMatchObject({ statusCode: 429 });
    expect(evaluator.requests).toHaveLength(2);
    expect(RATE_LIMITS.ottlLintsPerUser).toEqual({ max: 30, windowMs: 60_000 });
  });
});

describe("the person's lints in flight (Ruling 168)", () => {
  it("lets two of a person's lints in an organization wait on the evaluator; a third is 429 rate_limited with Retry-After 1, counting nothing", async () => {
    let releaseAll!: () => void;
    const held = new Promise<void>((resolve) => (releaseAll = resolve));
    let reached = 0;
    const base = validEverything();
    const client: OttlEvaluatorClient = {
      ...base.client,
      lint: async (request) => {
        reached += 1;
        await held;
        return base.client.lint(request);
      },
    };
    const limiter = createPerUserLimiter({ max: 3, windowMs: 60_000 });
    const service = createOttlLintService({ evaluator: client, limiter, log: silent });
    const userId = randomUUID();
    const [organization, other] = [randomUUID(), randomUUID()];
    const actor = actorIn(userId, organization);

    expect(OTTL_LINTS_IN_FLIGHT_PER_USER).toBe(2);
    const waiting = [service.lintExpressions(actor, organization, one), service.lintConfiguration(actor, organization, "processors:\n  filter:\n    logs:\n      log_record: [\"body == 1\"]\n")];
    expect(reached).toBe(2);
    const refusal = await service.lintExpressions(actor, organization, one).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ statusCode: 429, code: "rate_limited", headers: { "retry-after": 1 } });
    // Another organization's places are apart, and another person's.
    const elsewhere = service.lintExpressions(actorIn(userId, other), other, one);
    const someoneElse = service.lintExpressions(actorIn(randomUUID(), organization), organization, one);
    expect(reached).toBe(4);

    releaseAll();
    await Promise.all([...waiting, elsewhere, someoneElse]);
    // The places are back, and the refusal counted nothing: the minute's third lint still passes.
    expect((await service.lintExpressions(actor, organization, one)).valid).toBe(true);
    await expect(service.lintExpressions(actor, organization, one)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("gives the place back when the evaluator fails, an expressions lint's and a YAML's (Ruling 170)", async () => {
    const base = validEverything();
    let isDown = true;
    const flaky: OttlEvaluatorClient = {
      ...base.client,
      lint: async (request) => (isDown ? { kind: "unavailable", reason: "server_error", status: 500 } : base.client.lint(request)),
    };
    const service = createOttlLintService({ evaluator: flaky, limiter: createPerUserLimiter({ max: 100, windowMs: 60_000 }), log: silent });
    const organization = randomUUID();
    const actor = actorIn(randomUUID(), organization);
    const yaml = 'processors:\n  filter:\n    logs:\n      log_record: ["body == 1"]\n';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.lintExpressions(actor, organization, one)).rejects.toMatchObject({ statusCode: 503, code: "ottl_lint_unavailable" });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.lintConfiguration(actor, organization, yaml)).rejects.toMatchObject({ statusCode: 503, code: "ottl_lint_unavailable" });
    }
    // Both places are free again: two lints run, neither refused in flight.
    isDown = false;
    expect((await service.lintConfiguration(actor, organization, yaml)).valid).toBe(true);
    expect((await service.lintExpressions(actor, organization, one)).valid).toBe(true);
  });
});

describe("a YAML's expression over 8,192 characters (Ruling 168)", () => {
  const configuration = (long: string) => `
processors:
  filter:
    logs:
      log_record:
        - severity_number >= 17
        - '${long}'
        - body == "after"
  transform:
    log_statements:
      - context: log
        statements:
          - set(attributes["a"], "b")
`;

  it("is answered here in the evaluator's words; only the rest is sent, each verdict at its own place", async () => {
    const evaluator = validEverything();
    const service = createOttlLintService({ evaluator: evaluator.client, limiter: createPerUserLimiter({ max: 1, windowMs: 60_000 }), log: silent });
    const organization = randomUUID();
    const long = `body == "${"x".repeat(9_000)}"`;

    const reply = await service.lintConfiguration(actorIn(randomUUID(), organization), organization, configuration(long));

    expect(evaluator.requests).toEqual([{ context: "log", conditions: ["severity_number >= 17", 'body == "after"'], statements: ['set(attributes["a"], "b")'] }]);
    expect(reply.checked).toBe(4);
    expect(reply.valid).toBe(false);
    expect(reply.items.map(({ index, location, valid, error }) => ({ index, location, valid, error }))).toEqual([
      { index: 0, location: "processors.filter.logs.log_record[0]", valid: true, error: null },
      { index: 1, location: "processors.filter.logs.log_record[1]", valid: false, error: "The condition is longer than 8,192 bytes." },
      { index: 2, location: "processors.filter.logs.log_record[2]", valid: true, error: null },
      { index: 3, location: "processors.transform.log_statements[0].statements[0]", valid: true, error: null },
    ]);
    expect(reply.items[1]!.input === long).toBe(true);
  });

  it("asks the evaluator nothing and spends no lint when every expression is over-long; 8,192 characters exactly is sent", async () => {
    const evaluator = validEverything();
    const service = createOttlLintService({ evaluator: evaluator.client, limiter: createPerUserLimiter({ max: 1, windowMs: 60_000 }), log: silent });
    const organization = randomUUID();
    const actor = actorIn(randomUUID(), organization);
    const statementOnly = (text: string) => `processors:\n  transform:\n    trace_statements:\n      - '${text}'\n`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await service.lintConfiguration(actor, organization, statementOnly(`set(name, "${"y".repeat(9_000)}")`));
      expect(reply).toMatchObject({ valid: false, ottlVersion: null, checked: 1 });
      expect(reply.items[0]!.error).toBe("The statement is longer than 8,192 bytes.");
    }
    expect(evaluator.requests).toEqual([]);
    const exact = `set(name, "${"z".repeat(8_192 - 'set(name, "")'.length)}")`;
    expect([...exact]).toHaveLength(8_192);
    expect((await service.lintConfiguration(actor, organization, statementOnly(exact))).valid).toBe(true);
    expect(evaluator.requests).toHaveLength(1);
  });
});
