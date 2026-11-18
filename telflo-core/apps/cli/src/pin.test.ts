import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { routedFetch } from "../tests/fake-fetch.js";
import { ApiClient } from "./api.js";
import { ExitError } from "./output.js";
import { describePin, NO_SUCH_VERSION_MESSAGE, resolvePin } from "./pin.js";

/* The pin of a configuration's version, from routes 5 and 8. */

const ID = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";

function version(versionNumber: number, collectorVersion: string, distribution = "otelcol-contrib") {
  return {
    id: "v",
    versionNumber,
    status: "published",
    label: null,
    distribution,
    collectorVersion,
    createdAt: "2026-10-01T00:00:00.000Z",
    publishedAt: null,
  };
}

function client() {
  const fake = routedFetch({
    [`GET /configurations/${ID}`]: { json: { id: ID, versionNumber: 3, collectorVersion: "0.130.0", distribution: "clickstack" } },
    [`GET /configurations/${ID}/versions`]: { json: { items: [version(3, "0.130.0", "clickstack"), version(2, "0.120.0", "clickstack")], nextCursor: null } },
  });
  return { fake, client: new ApiClient({ server: "https://telflo.example", token: `tf_${randomBytes(32).toString("base64url")}`, fetch: fake.fetch }) };
}

describe("resolvePin", () => {
  it("answers the latest version's pin from route 5", async () => {
    const { fake, client: api } = client();
    expect(await resolvePin(api, ID.toUpperCase())).toEqual({ collectorVersion: "0.130.0", distribution: "clickstack", versionNumber: 3 });
    expect(fake.calls.map((call) => call.url.pathname)).toEqual([`/api/public/v1/configurations/${ID}`]);
  });

  it("answers a named version's pin from route 8", async () => {
    const { fake, client: api } = client();
    expect(await resolvePin(api, ID, 2)).toEqual({ collectorVersion: "0.120.0", distribution: "clickstack", versionNumber: 2 });
    expect(fake.calls.map((call) => call.url.pathname)).toEqual([`/api/public/v1/configurations/${ID}/versions`]);
  });

  it("exits 1 for a version that doesn't exist", async () => {
    const { client: api } = client();
    await expect(resolvePin(api, ID, 9)).rejects.toThrow(NO_SUCH_VERSION_MESSAGE(ID, 9));
  });

  it("exits 2 for a malformed id, before any request", async () => {
    const { fake, client: api } = client();
    const error = await resolvePin(api, "../whoami").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).exitCode).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("describePin", () => {
  it("names the distribution and version", () => {
    expect(describePin({ distribution: "otelcol-contrib", collectorVersion: "0.120.0" })).toBe("otelcol-contrib 0.120.0");
  });

  it("strips control characters from the server's strings (Ruling 242)", () => {
    expect(describePin({ distribution: "otel\u001b]0;x\u0007col", collectorVersion: "0.1\u001b[2J20.0" })).toBe("otel]0;xcol 0.1[2J20.0");
  });
});
