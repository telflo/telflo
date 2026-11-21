import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { PublicVersionNumberSchema } from "@telflo/contracts";
import { ApiClient } from "../api.js";
import { ExitError } from "../output.js";
import { fakeFetch } from "../../tests/fake-fetch.js";
import { parseVersionNumber, pullConfiguration, pushConfiguration } from "./configurations.js";

/*
 * The configurations' calls beyond what the command tests reach: the version
 * number's parser against the contract (a drift test) and a push with no
 * versions at all.
 */

const SERVER = "https://telflo.example";
const ID = "1c8f9bad-2e3f-4a41-9b5c-6d7e8f9a0b1c";

describe("parseVersionNumber", () => {
  const samples = ["1", "9", "10", "999999999", "0", "07", "-1", "+1", "1e2", "1.0", " 1", "1000000000", "", "two"];

  it("takes exactly what the routes' PublicVersionNumberSchema takes (drift)", () => {
    for (const sample of samples) {
      const contract = PublicVersionNumberSchema.safeParse(sample);
      let parsed: number | undefined;
      try {
        parsed = parseVersionNumber(sample);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidArgumentError);
      }
      expect(parsed).toBe(contract.success ? contract.data : undefined);
    }
  });
});

describe("pushConfiguration", () => {
  it("validates on the catalog's defaults when the configuration has no version", async () => {
    const fake = fakeFetch((call, index) => {
      if (index === 0) return { json: { items: [], nextCursor: null } };
      if (index === 1) return { json: { valid: true, collectorVersion: "0.147.0", errors: [] } };
      return { status: 201, json: { versionNumber: 1, yaml: call.body === undefined ? "" : "x" } };
    });
    const client = new ApiClient({ server: SERVER, fetch: fake.fetch });
    const result = await pushConfiguration(client, ID, "a: 1\n");
    expect(result).toEqual({ status: "saved", action: "appended", versionNumber: 1, published: false });
    expect(JSON.parse(fake.calls[1]!.body!)).toEqual({ yaml: "a: 1\n" });
  });

  it("reads a 422's errors defensively", async () => {
    const fake = fakeFetch((_call, index) =>
      index === 0
        ? { json: { items: [{ versionNumber: 1, status: "draft" }], nextCursor: null } }
        : { status: 422, json: { error: { code: "configuration_invalid", message: "Invalid." } } },
    );
    const client = new ApiClient({ server: SERVER, fetch: fake.fetch });
    expect(await pushConfiguration(client, ID, "a: 1\n")).toEqual({ status: "invalid", errors: [] });
  });
});

describe("pushConfiguration --publish", () => {
  it("says the version was saved when the publish can't reach the server", async () => {
    const fake = fakeFetch((call, index) => {
      if (index === 0) return { json: { items: [{ versionNumber: 2, status: "draft" }], nextCursor: null } };
      if (index === 1) return { json: { versionNumber: 2, yaml: "a: 1\n" } };
      throw new TypeError(`fetch failed for ${call.url.href}`);
    });
    const client = new ApiClient({ server: SERVER, fetch: fake.fetch });
    const failure = await pushConfiguration(client, ID, "a: 1\n", { publish: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExitError);
    expect((failure as ExitError).message).toBe(`Saved v2, but couldn't publish it: Couldn't reach ${SERVER}.`);
    expect((failure as ExitError).exitCode).toBe(1);
    expect((failure as ExitError).code).toBe("unreachable");
  });
});

describe("pullConfiguration", () => {
  it("answers the id canonicalized", async () => {
    const fake = fakeFetch(() => ({ json: { versionNumber: 2, yaml: "", distribution: "d", collectorVersion: "v" } }));
    const client = new ApiClient({ server: SERVER, fetch: fake.fetch });
    expect((await pullConfiguration(client, ID.toUpperCase(), 2)).id).toBe(ID);
  });
});
