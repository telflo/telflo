import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogueDefaults, truncateAll } from "@telflo/db/testing";
import { deleteCredentials } from "../src/credentials.js";
import { runCli, serviceAccountWithToken, useApiServer, type CliRun } from "./harness.js";

/*
 * telflo flows list|get|pull against the real API in process (D27
 * decisions 26 and 33): the published flows with D25's names, a hidden
 * flow's 404 in the envelope's words (exit 1). Tokens are checked with
 * boolean canaries only.
 */

const api = useApiServer();

let tokens: string[];

function holdsAnyToken(...texts: string[]): boolean {
  return texts.some((text) => tokens.some((token) => text.includes(token)));
}

async function cli(args: string[]): Promise<CliRun> {
  const result = await runCli(args);
  expect(holdsAnyToken(result.stdout, result.stderr)).toBe(false);
  return result;
}

async function addFlow(overrides: { published?: boolean; author_name?: string } = {}): Promise<{ slug: string; yaml: string }> {
  const pin = await catalogueDefaults(api.ownerDb);
  const slug = `cli-flow-${randomUUID().slice(0, 8)}`;
  const yaml = `receivers:\n  otlp: {}\n# ${slug}`;
  await api.ownerDb
    .insertInto("flows")
    .values({
      slug,
      name: `Flow ${slug}`,
      summary: "A summary.",
      description: "## Long\n\nMarkdown.",
      source: "telflo",
      signals: ["traces"],
      tags: ["test"],
      yaml_content: yaml,
      collector_distribution: pin.distribution,
      collector_version: pin.version,
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    })
    .execute();
  return { slug, yaml };
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
});

describe("telflo flows", () => {
  it("lists the published flows, shows one and pulls its YAML", async () => {
    const pin = await catalogueDefaults(api.ownerDb);
    const flow = await addFlow({ author_name: "Ada" });
    const hidden = await addFlow({ published: false });

    const list = JSON.parse((await cli(["--json", "flows", "list"])).stdout) as Array<{ slug: string; authorName: string | null }>;
    expect(list.map((item) => item.slug)).toContain(flow.slug);
    expect(list.map((item) => item.slug)).not.toContain(hidden.slug);
    expect(list.find((item) => item.slug === flow.slug)?.authorName).toBe("Ada");

    const get = await cli(["flows", "get", flow.slug]);
    expect(get.code).toBe(0);
    expect(get.stdout.split("\n").slice(0, 4)).toEqual([
      `Flow ${flow.slug} (${flow.slug})`,
      "A summary.",
      "signals: traces   tags: test",
      `collector: ${pin.distribution} ${pin.version}   by: Ada`,
    ]);

    const pull = await cli(["flows", "pull", flow.slug]);
    expect(pull.stdout).toBe(`${flow.yaml}\n`);
    const out = join(process.env.HOME!, `${flow.slug}.yaml`);
    expect((await cli(["flows", "pull", flow.slug, "-o", out])).code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`${flow.yaml}\n`);
  });

  it("answers a hidden or unknown flow's 404 in its words (exit 1)", async () => {
    const hidden = await addFlow({ published: false });
    for (const slug of [hidden.slug, "no-such-flow"]) {
      const result = await cli(["--json", "flows", "get", slug]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "flow_not_found", status: 404 } });
    }
  });
});
