import { describe, expect, it } from "vitest";
import { ApiClient } from "../api.js";
import { fakeFetch } from "../../tests/fake-fetch.js";
import { getFlowYaml } from "./flows.js";

/* A flow's YAML. */

describe("getFlowYaml", () => {
  it("ends the YAML in a newline once, with the pin", async () => {
    for (const [yaml, expected] of [
      ["receivers: {}", "receivers: {}\n"],
      ["receivers: {}\n", "receivers: {}\n"],
    ] as const) {
      const fake = fakeFetch(() => ({ json: { slug: "s", distribution: "d", collectorVersion: "v", yaml } }));
      const client = new ApiClient({ server: "https://telflo.example", fetch: fake.fetch });
      expect(await getFlowYaml(client, "s")).toEqual({ slug: "s", distribution: "d", collectorVersion: "v", yaml: expected });
    }
  });
});
