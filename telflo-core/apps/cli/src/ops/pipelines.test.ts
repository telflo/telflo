import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PublicReplaceValidationRulesRequestSchema } from "@telflo/contracts";
import { routedFetch } from "../../tests/fake-fetch.js";
import { ApiClient } from "../api.js";
import { EXIT } from "../output.js";
import { latestVersionNumber, listValidationPipelines, replaceApiOwnedRules } from "./pipelines.js";

/* A version's validation pipelines: route 13's list, route 14's replace (D27 decision 27). */

const SERVER = "https://telflo.example";
const CONFIGURATION = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const PIPELINES = `/configurations/${CONFIGURATION}/versions/3/validation-pipelines`;

function clientOf(fake: ReturnType<typeof routedFetch>): ApiClient {
  return new ApiClient({ server: SERVER, token: `tf_${randomBytes(32).toString("base64url")}`, fetch: fake.fetch });
}

const RULE = { kind: "ottl" as const, target: "output" as const, ottl: { context: "log" as const, quantifier: "any" as const, condition: "body != nil" } };

describe("validation pipelines", () => {
  it("reads the latest version's number (route 5) and the version's pipelines (route 13)", async () => {
    const fake = routedFetch({
      [`GET /configurations/${CONFIGURATION}`]: { json: { id: CONFIGURATION, versionNumber: 3 } },
      [`GET ${PIPELINES}`]: { json: { items: [{ id: "p", pipeline: "logs/in", rules: [] }], nextCursor: null } },
    });
    const client = clientOf(fake);
    expect(await latestVersionNumber(client, CONFIGURATION)).toBe(3);
    expect(await listValidationPipelines(client, CONFIGURATION, 3)).toEqual([{ id: "p", pipeline: "logs/in", rules: [] }]);
  });

  it("PUTs { signal, rules } on the pipeline's path with its / kept, and no pipeline name", async () => {
    const fake = routedFetch({ [`PUT ${PIPELINES}/logs/in%20app`]: { json: { id: "p", created: true } } });
    const body = { signal: "logs" as const, rules: [RULE] };
    expect(await replaceApiOwnedRules(clientOf(fake), CONFIGURATION, 3, "logs/in app", body)).toEqual({ id: "p", created: true });
    const sent = JSON.parse(fake.calls[0]!.body!) as Record<string, unknown>;
    expect(sent).toEqual({ signal: "logs", rules: [RULE] });
    // The strict body the API takes: no `name`.
    expect(PublicReplaceValidationRulesRequestSchema.safeParse(sent).success).toBe(true);
    expect(PublicReplaceValidationRulesRequestSchema.safeParse({ ...sent, name: "mine" }).success).toBe(false);
  });

  it("refuses a pipeline name with a . or .. part before any request", async () => {
    const fake = routedFetch({});
    await expect(replaceApiOwnedRules(clientOf(fake), CONFIGURATION, 3, "logs/..", { signal: "logs", rules: [RULE] })).rejects.toMatchObject({
      exitCode: EXIT.USAGE,
    });
    expect(fake.calls).toHaveLength(0);
  });
});
