import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateConfigurationRequestSchema } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { ACME, CATALOGUE, CONTRIB, RETIRED_VERSION } from "~/test/collector-distributions.js";
import { MINE } from "~/test/configurations.js";
import { TAIL_SAMPLING_YAML, makeFlow } from "~/test/flows.js";
import {
  FlowNotLoadableError,
  createConfigurationFromFlow,
  flowCopyPin,
  pinMovedSentence,
} from "./instantiate-flow.js";

/*
 * Making a configuration from a flow (D12 Preflight ruling 12): the graph
 * persisted (here through `toStored`), the slug recorded, the flow's
 * distribution, its version, the declared distribution, a parse failure
 * refused before any call, the editor path. Its three override cases and its
 * blank-pin and blank-distribution cases aren't ported: nothing picks an
 * override, and the flows table rules a blank pin out. Ruling 16 adds the
 * deprecated pin's.
 */

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000003";

function created() {
  return vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
}

/** The one create's request. */
function sent(createConfiguration: ReturnType<typeof created>) {
  expect(createConfiguration).toHaveBeenCalledTimes(1);
  const [organizationId, request] = createConfiguration.mock.calls[0]!;
  expect(organizationId).toBe(ORGANIZATION_ID);
  return request;
}

function instantiate(flow = makeFlow(), distributions: Parameters<typeof flowCopyPin>[1] = CATALOGUE) {
  return createConfigurationFromFlow({
    flow,
    organizationId: ORGANIZATION_ID,
    name: "My config",
    description: "Mine now.",
    distributions,
  });
}

describe("createConfigurationFromFlow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the parsed graph rather than an empty canvas, with the flow's text byte for byte", async () => {
    const createConfiguration = created();
    await instantiate();

    const request = sent(createConfiguration);
    expect(request.nodes!.length).toBeGreaterThan(0);
    expect(request.edges!.length).toBeGreaterThan(0);
    expect(request.pipelines!.map((pipeline) => pipeline.name)).toEqual([
      "traces",
      "traces/sampled",
      "metrics/spanmetrics",
    ]);
    expect(request.yamlContent).toBe(TAIL_SAMPLING_YAML);
    expect(request).toMatchObject({ name: "My config", description: "Mine now." });
    // What the create API accepts (D12 decision 12): the four content fields together, the save's schemas.
    expect(CreateConfigurationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("records which flow the configuration came from", async () => {
    const createConfiguration = created();
    await instantiate();

    expect(sent(createConfiguration).sourceFlowSlug).toBe("tail-sampling-keep-errors");
  });

  it("locks the created configuration to the flow's distribution", async () => {
    const createConfiguration = created();
    await instantiate();

    expect(sent(createConfiguration).collectorDistribution).toBe(CONTRIB.id);
  });

  it("pins the version the flow was validated against, not the catalogue's default", async () => {
    // 0.161.0 is offered, and isn't the default (0.162.0).
    const createConfiguration = created();
    await instantiate(makeFlow({ collectorVersion: "0.161.0" }));

    expect(sent(createConfiguration).collectorVersion).toBe("0.161.0");
  });

  it("pins the distribution the flow declares, not the default", async () => {
    const createConfiguration = created();
    await instantiate(makeFlow({ collectorDistribution: ACME.id, collectorVersion: "2.36.0" }), [CONTRIB, ACME]);

    expect(sent(createConfiguration)).toMatchObject({ collectorDistribution: ACME.id, collectorVersion: "2.36.0" });
  });

  it("refuses before writing anything when the YAML will not parse, saying the flow could not be loaded", async () => {
    const createConfiguration = created();

    const refusal = await instantiate(makeFlow({ yaml: "receivers:\n  - [unclosed" })).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(FlowNotLoadableError);
    expect((refusal as Error).message).toMatch(/^This flow could not be loaded: \S/);
    // The failure has to land before the create: a created-but-empty
    // configuration is worse than a refused create.
    expect(createConfiguration).not.toHaveBeenCalled();
  });

  it("returns the editor path for the created configuration", async () => {
    created();
    const result = await instantiate();

    expect(result.editorPath).toBe(`/editor/${MINE.id}`);
    expect(result.configuration).toBe(MINE);
  });

  describe("a pin the catalogue no longer offers (D12 decision 16)", () => {
    it("moves the copy to the distribution's default version, and leaves the flow as it was", async () => {
      const createConfiguration = created();
      const flow = makeFlow({ collectorVersion: RETIRED_VERSION });
      const before = structuredClone(flow);

      await instantiate(flow);

      expect(sent(createConfiguration)).toMatchObject({ collectorDistribution: CONTRIB.id, collectorVersion: "0.162.0" });
      expect(flow).toEqual(before);
    });

    it("sends the flow's own pin while the catalogue is unread, for the API to judge", async () => {
      const createConfiguration = created();
      await instantiate(makeFlow({ collectorVersion: RETIRED_VERSION }), null);

      expect(sent(createConfiguration).collectorVersion).toBe(RETIRED_VERSION);
    });

    it("rejects with the API's refusal when it doesn't offer the pin", async () => {
      const refusal = new ApiError("collector_version_unknown", "That collector version isn't available.");
      vi.spyOn(apiClient, "createConfiguration").mockRejectedValue(refusal);

      await expect(instantiate(makeFlow({ collectorVersion: RETIRED_VERSION }), null)).rejects.toBe(refusal);
    });
  });
});

describe("flowCopyPin and pinMovedSentence (D12 Preflight ruling 16)", () => {
  it("keeps an offered pin, and says nothing", () => {
    const pin = flowCopyPin(makeFlow({ collectorVersion: "0.160.0" }), CATALOGUE);
    expect(pin).toEqual({ distribution: CONTRIB.id, version: "0.160.0", movedFrom: null });
    expect(pinMovedSentence(pin)).toBeNull();
  });

  it("moves a pin the catalogue doesn't offer to the default, and says so", () => {
    const pin = flowCopyPin(makeFlow({ collectorVersion: RETIRED_VERSION }), CATALOGUE);
    expect(pin).toEqual({ distribution: CONTRIB.id, version: "0.162.0", movedFrom: RETIRED_VERSION });
    expect(pinMovedSentence(pin)).toBe("This flow was built for collector v0.155.0, which is no longer offered; your copy will use v0.162.0.");
  });

  it("falls back to the distribution's first version when none is marked the default", () => {
    const noDefault = { ...CONTRIB, versions: CONTRIB.versions.map((offer) => ({ ...offer, isDefault: false })) };
    expect(flowCopyPin(makeFlow({ collectorVersion: RETIRED_VERSION }), [noDefault]).version).toBe("0.162.0");
  });

  it("keeps the pin when the catalogue can't say: unread, a distribution it doesn't list, or one offering nothing", () => {
    const flow = makeFlow({ collectorVersion: RETIRED_VERSION });
    const kept = { distribution: CONTRIB.id, version: RETIRED_VERSION, movedFrom: null };
    expect(flowCopyPin(flow, null)).toEqual(kept);
    expect(flowCopyPin(flow, [ACME])).toEqual(kept);
    expect(flowCopyPin(flow, [{ ...CONTRIB, versions: [] }])).toEqual(kept);
  });
});
