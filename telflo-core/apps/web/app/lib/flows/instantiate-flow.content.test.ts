import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateConfigurationRequestSchema } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { MINE } from "~/test/configurations.js";
import { createConfigurationFromContent, createRequestFor, type ConfigurationContent } from "./instantiate-flow.js";

/*
 * The create-from-content helper, generalized from "Use this flow": one
 * create with the name, the description, the four content fields and both
 * pin fields; the flow's slug only when given. The playground's handoff
 * sends no slug. "Use this flow" goes through it unchanged
 * (instantiate-flow.test.ts).
 */

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";

const CONTENT: ConfigurationContent = {
  name: "Gateway",
  description: "",
  yamlContent: "receivers:\n  otlp: {}\n",
  graph: { nodes: [], edges: [], pipelines: [] },
  collectorDistribution: "otelcol-contrib",
  collectorVersion: "0.161.0",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRequestFor", () => {
  it("is the create's request: the content's four fields together and both pin fields, no slug when none is given", () => {
    const request = createRequestFor(CONTENT);
    expect(Object.keys(request).sort()).toEqual([
      "collectorDistribution",
      "collectorVersion",
      "description",
      "edges",
      "name",
      "nodes",
      "pipelines",
      "yamlContent",
    ]);
    expect(CreateConfigurationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("carries a flow's slug when given", () => {
    expect(createRequestFor({ ...CONTENT, sourceFlowSlug: "log-volume-cost-control" }).sourceFlowSlug).toBe("log-volume-cost-control");
  });
});

describe("createConfigurationFromContent", () => {
  it("makes one create in the organization and answers the editor's path", async () => {
    const create = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
    const made = await createConfigurationFromContent(ORGANIZATION_ID, CONTENT);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(ORGANIZATION_ID, createRequestFor(CONTENT));
    expect(made).toEqual({ configuration: MINE, editorPath: `/editor/${MINE.id}` });
  });

  it("rejects with the API's refusal", async () => {
    vi.spyOn(apiClient, "createConfiguration").mockRejectedValue(
      new ApiError("collector_version_unknown", "Not offered.", { status: 400 }),
    );
    await expect(createConfigurationFromContent(ORGANIZATION_ID, CONTENT)).rejects.toMatchObject({ code: "collector_version_unknown" });
  });
});
