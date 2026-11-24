import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AGENT_ENDPOINT_PATTERN,
  COLLECTOR_IMAGE_REPOSITORY_PATTERN,
  DEFAULT_HELM_CHART_REFERENCE,
  DEFAULT_HELM_CHART_VERSION,
  HELM_CHART_ENV_NAME_MESSAGE,
  HELM_CHART_ENV_NAMES,
  HELM_CHART_REFERENCE_PATTERN,
  HELM_CHART_VERSION_PATTERN,
  HELM_VALUES_DOWNLOAD_NAME,
  HELM_VALUES_FRAGMENT_PATTERN,
  HelmBuildError,
  helmDownloadFragment,
  helmFullnameOverride,
  HelmInstallFactsSchema,
  helmInstallCommand,
  helmQuickDeployCommand,
  helmReleaseName,
  helmUninstallCommand,
  helmValuesCurlCommand,
  helmValuesFileName,
  helmValuesInputOf,
  helmValuesYaml,
  isHelmValuesFileName,
  type HelmEnvValue,
  type HelmInstallFacts,
  type HelmInstallParts,
  type HelmValuesInput,
} from "./helm.js";

// A Kubernetes group's install facts, the values file and the Helm commands.
// Every shell probe is harmless (`$(echo EXPANDED)`, never a command with an
// effect).

const GROUP_ID = "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f";
/** Standard base64, as the opamp-server seals a bearer: `+`, `/` and padding. */
const BEARER = "QmVhcmVyIGNhbmFyeQ+/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==";
const SECRET = `tqd_${"Ab9_-".repeat(8)}xyz`;
const HTTPS_URL = `https://telflo.example.com/api/v1/quick-deploy/${SECRET}`;
const HTTP_URL = `http://host.docker.internal:50080/telflo/api/v1/quick-deploy/${SECRET}`;
const GATEWAY_52 = "traces-sampling-pool-in-the-eu-west-region-number-01";
const NAMESPACE_63 = "observability-collectors-for-the-production-cluster-in-eu-west1";
const MIRROR = "oci://registry.example:5000/mirror/charts/telflo-supervisor-collector";
/** The two example fleets' ids, as the goldens use them. */
const FLEET_ID = "3f9a1c2e-5b7d-4e8f-9a01-23456789abcd";
const OTHER_FLEET_ID = "7b20d4aa-0c1e-4f2a-8b3c-4d5e6f708192";

const AGENT: HelmValuesInput = {
  role: "node",
  group: "node",
  fullnameOverride: "3f9a1c2e-default",
  collectorGroupId: GROUP_ID,
  image: { repository: "ghcr.io/telflo/telflo/collector", tag: "0.162.0" },
  allowInsecure: false,
  replicas: null,
  endpoint: "https://opamp.telflo.example/opamp/api/v1",
  token: BEARER,
  volumes: [
    { hostPath: "/var/log/app", hostPathType: "Directory", mountPath: "/mnt/app-logs", readOnly: true },
    { hostPath: "/data/buf", hostPathType: "DirectoryOrCreate", mountPath: "/var/lib/buf", readOnly: false },
  ],
  collectorEnv: [
    { name: "LOKI_TENANT", value: "acme" },
    { name: "_A1", value: "plain" },
  ],
};

const CLUSTER: HelmValuesInput = {
  ...AGENT,
  role: "cluster",
  group: "cluster",
  fullnameOverride: "7b20d4aa-cluster",
  allowInsecure: true,
  endpoint: "http://host.minikube.internal:4320/opamp/api/v1",
  volumes: [],
  collectorEnv: [],
};

const GATEWAY: HelmValuesInput = {
  ...AGENT,
  role: "gateway",
  group: "traces-sampling",
  fullnameOverride: null,
  replicas: 3,
  image: { repository: "registry.internal:5000/mirror/telflo-collector", tag: "0.160.0" },
  volumes: [{ hostPath: "/run/spool", hostPathType: "Socket", mountPath: "/var/run/spool.sock", readOnly: true }],
  collectorEnv: [],
};

/** The three goldens, written out by hand: no template shared with the builder. */
const AGENT_GOLDEN = `# This file holds the fleet's default token: delete it once the release is installed.
role: "node"
group: "node"
fullnameOverride: "3f9a1c2e-default"
collectorGroupId: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f"
image:
  repository: "ghcr.io/telflo/telflo/collector"
  tag: "0.162.0"
allowInsecure: false
endpoint: "https://opamp.telflo.example/opamp/api/v1"
token: "QmVhcmVyIGNhbmFyeQ+/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789=="
volumes:
  - type: "hostPath"
    hostPath: "/var/log/app"
    hostPathType: "Directory"
    mountPath: "/mnt/app-logs"
    readOnly: true
  - type: "hostPath"
    hostPath: "/data/buf"
    hostPathType: "DirectoryOrCreate"
    mountPath: "/var/lib/buf"
    readOnly: false
collectorEnv:
  "LOKI_TENANT": "acme"
  "_A1": "plain"
`;

const CLUSTER_GOLDEN = `# This file holds the fleet's default token: delete it once the release is installed.
role: "cluster"
group: "cluster"
fullnameOverride: "7b20d4aa-cluster"
collectorGroupId: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f"
image:
  repository: "ghcr.io/telflo/telflo/collector"
  tag: "0.162.0"
allowInsecure: true
endpoint: "http://host.minikube.internal:4320/opamp/api/v1"
token: "QmVhcmVyIGNhbmFyeQ+/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789=="
volumes: []
`;

const GATEWAY_GOLDEN = `# This file holds the fleet's default token: delete it once the release is installed.
role: "gateway"
group: "traces-sampling"
collectorGroupId: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f"
image:
  repository: "registry.internal:5000/mirror/telflo-collector"
  tag: "0.160.0"
allowInsecure: false
replicas: 3
endpoint: "https://opamp.telflo.example/opamp/api/v1"
token: "QmVhcmVyIGNhbmFyeQ+/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789=="
volumes:
  - type: "hostPath"
    hostPath: "/run/spool"
    hostPathType: "Socket"
    mountPath: "/var/run/spool.sock"
    readOnly: true
`;

/** What the file says, as a YAML parser reads it: the inputs (no fullnameOverride for a gateway), each volume `type: hostPath`, collectorEnv a map (none when empty). */
function documentOf(input: HelmValuesInput): Record<string, unknown> {
  return {
    role: input.role,
    group: input.group,
    ...(input.fullnameOverride === null ? {} : { fullnameOverride: input.fullnameOverride }),
    collectorGroupId: input.collectorGroupId,
    image: input.image,
    allowInsecure: input.allowInsecure,
    ...(input.role === "gateway" ? { replicas: input.replicas } : {}),
    endpoint: input.endpoint,
    token: input.token,
    volumes: input.volumes.map((volume) => ({ type: "hostPath", ...volume })),
    ...(input.collectorEnv.length === 0 ? {} : { collectorEnv: Object.fromEntries(input.collectorEnv.map(({ name, value }) => [name, value])) }),
  };
}

/** The file parsed as YAML 1.2 (the repo's default) and as YAML 1.1 (Helm's). */
function parsedBoth(yaml: string): unknown[] {
  return [parse(yaml), parse(yaml, { version: "1.1" })];
}

describe("the chart settings' rules", () => {
  // The platform's own chart.
  it("takes the defaults, the platform's own chart, and a mirror's reference with a port", () => {
    expect(DEFAULT_HELM_CHART_REFERENCE).toBe("oci://ghcr.io/telflo/telflo/charts/supervisor-collector");
    expect(DEFAULT_HELM_CHART_VERSION).toBe("0.2.0");
    for (const reference of [DEFAULT_HELM_CHART_REFERENCE, "oci://registry.example:5000/mirror/charts/x", MIRROR]) {
      expect({ reference, ok: HELM_CHART_REFERENCE_PATTERN.test(reference) }).toEqual({ reference, ok: true });
    }
    for (const version of [DEFAULT_HELM_CHART_VERSION, "0.0.0", "10.20.30"]) {
      expect({ version, ok: HELM_CHART_VERSION_PATTERN.test(version) }).toEqual({ version, ok: true });
    }
  });

  it.each([
    "https://ghcr.io/telflo/charts/telflo-supervisor-collector",
    "ghcr.io/telflo/charts/telflo-supervisor-collector",
    "oci://ghcr.io/Telflo/charts/telflo-supervisor-collector",
    "oci://ghcr.io/telflo/charts/telflo supervisor",
    "oci://ghcr.io/telflo/charts/it's",
    'oci://ghcr.io/telflo/"charts"',
    "oci://ghcr.io/telflo/$(echo EXPANDED)",
    "oci://ghcr.io/telflo/charts/",
    "oci://",
  ])("refuses the chart reference %s", (reference) => {
    expect(HELM_CHART_REFERENCE_PATTERN.test(reference)).toBe(false);
  });

  it.each(["0.3", "v0.3.5", "01.2.3", "0.3.5-rc1", "0.3.5 ", "0.3.x", ""])("refuses the chart version %j", (version) => {
    expect(HELM_CHART_VERSION_PATTERN.test(version)).toBe(false);
  });

  it("keeps the image repository's rule and the agent endpoint's", () => {
    expect(COLLECTOR_IMAGE_REPOSITORY_PATTERN.test("ghcr.io/telflo/collector")).toBe(true);
    expect(COLLECTOR_IMAGE_REPOSITORY_PATTERN.test("ghcr.io/telflo/telflo/collector")).toBe(true);
    expect(COLLECTOR_IMAGE_REPOSITORY_PATTERN.test("registry.internal:5000/mirror/telflo-collector")).toBe(true);
    for (const repository of ["Ghcr.io/telflo/collector", "ghcr.io/telflo/collector:0.162.0 ", "ghcr.io/$(echo EXPANDED)", "ghcr.io//x"]) {
      expect({ repository, ok: COLLECTOR_IMAGE_REPOSITORY_PATTERN.test(repository) }).toEqual({ repository, ok: false });
    }
    for (const endpoint of ["https://opamp.telflo.example/opamp/api/v1", "ws://[::1]:4320/v1/opamp", "http://host.minikube.internal:4320"]) {
      expect({ endpoint, ok: AGENT_ENDPOINT_PATTERN.test(endpoint) }).toEqual({ endpoint, ok: true });
    }
    for (const endpoint of ["https://user@x/v1", "https://x/v1?q=1", "https://x/v1#f", 'https://x/"v1"', "https://x/$(echo EXPANDED)", "ftp://x"]) {
      expect({ endpoint, ok: AGENT_ENDPOINT_PATTERN.test(endpoint) }).toEqual({ endpoint, ok: false });
    }
  });
});

describe("the variables a Helm install can carry", () => {
  it("names the four the chart sets itself", () => {
    expect(HELM_CHART_ENV_NAMES).toEqual(["POD_NAMESPACE", "POD_NAME", "NODE_NAME", "HOST_IP"]);
  });

  it("says why the chart's own can't be set, with no name in its words", () => {
    expect(HELM_CHART_ENV_NAME_MESSAGE).toBe("The chart sets this variable itself: it can't be set here.");
  });
});

// The fleet id's first 8 characters and the group's name's slug, never a
// trailing hyphen.
describe("helmFullnameOverride", () => {
  const slug = (name: string) => helmFullnameOverride(FLEET_ID, "node", name)!.slice("3f9a1c2e-".length);

  it("is the fleet id's first 8 characters, -, and the group's name's slug: the Default group and the Cluster (goldens)", () => {
    expect(helmFullnameOverride(FLEET_ID, "node", "Default")).toBe("3f9a1c2e-default");
    expect(helmFullnameOverride(OTHER_FLEET_ID, "cluster", "cluster")).toBe("7b20d4aa-cluster");
    expect(helmFullnameOverride(FLEET_ID, "cluster", "cluster")).toBe("3f9a1c2e-cluster");
    // A fleet id with digits and letters.
    expect(helmFullnameOverride("a3f9c1de-1111-2222-3333-444444444444", "node", "Default")).toBe("a3f9c1de-default");
  });

  it("is null for a gateway: its name names its objects", () => {
    expect(helmFullnameOverride(FLEET_ID, "gateway", "traces-sampling")).toBeNull();
    expect(helmFullnameOverride(FLEET_ID, "gateway", "Default")).toBeNull();
  });

  it("tells two fleets' groups of one name apart", () => {
    expect(helmFullnameOverride(FLEET_ID, "node", "Default")).not.toBe(helmFullnameOverride(OTHER_FLEET_ID, "node", "Default"));
    expect(helmFullnameOverride(FLEET_ID, "cluster", "cluster")).not.toBe(helmFullnameOverride(OTHER_FLEET_ID, "cluster", "cluster"));
  });

  it("lowercases an uppercase fleet id", () => {
    expect(helmFullnameOverride(FLEET_ID.toUpperCase(), "node", "Default")).toBe("3f9a1c2e-default");
    expect(helmFullnameOverride("7B20D4AA-0C1E-4F2A-8B3C-4D5E6F708192", "cluster", "cluster")).toBe("7b20d4aa-cluster");
  });

  it.each([
    ["Edge Gateway 1", "edge-gateway-1"],
    ["prod.us_east", "prod-us-east"],
    [" -Default- ", "default"],
    ["UPPER case", "upper-case"],
    ["a!!!b???c", "a-b-c"],
    ["--x--", "x"],
    [".", "group"],
    ["   ", "group"],
    ["...", "group"],
    ["", "group"],
    ["é", "group"],
  ])("slugs the group's name %j as %s", (name, expected) => {
    expect(slug(name)).toBe(expected);
  });

  it("cuts the slug to 40 characters, never leaving a trailing hyphen", () => {
    expect(slug(`${"a".repeat(39)} bbbbbbbbbb`)).toBe("a".repeat(39));
    expect(slug(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
    expect(slug("a".repeat(60))).toBe("a".repeat(40));
    expect(slug(`${"a".repeat(39)}!!!!bbb`)).toBe("a".repeat(39));
    expect(slug(`${"a".repeat(38)}!!!!bbb`)).toBe(`${"a".repeat(38)}-b`);
    const longest = helmFullnameOverride(FLEET_ID, "node", `${"x".repeat(39)}-${"y".repeat(20)}`)!;
    expect(longest).toBe(`3f9a1c2e-${"x".repeat(39)}`);
    for (const name of [`${"a".repeat(39)} b`, "z".repeat(63), `Edge ${"Gateway ".repeat(8)}`]) {
      const override = helmFullnameOverride(FLEET_ID, "node", name)!;
      expect({ name, override, label: /^[0-9a-f]{8}-[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(override) && override.length <= 49 }).toEqual({ name, override, label: true });
    }
  });

  it.each(["", "3f9a1c2e", "not-a-uuid-at-all", `${FLEET_ID}x`, "3f9a1c2e-5b7d-4e8f-9a01-23456789abc", "$(echo EXPANDED)", 7 as unknown as string])(
    "refuses the fleet id %j, naming the field only, for every role",
    (fleetId) => {
      for (const role of ["node", "cluster", "gateway"] as const) {
        expect(() => helmFullnameOverride(fleetId, role, "Default")).toThrow(new HelmBuildError("fleetId"));
      }
      try {
        helmFullnameOverride(fleetId, "node", "Default");
      } catch (error) {
        expect((error as HelmBuildError).source).toBe("operator");
        expect((error as Error).message).not.toContain("EXPANDED");
      }
    },
  );
});

describe("helmReleaseName", () => {
  it("is telflo-node for the Agent, telflo-cluster for the Cluster, a gateway's name for a gateway", () => {
    expect(helmReleaseName("node", "Default")).toBe("telflo-node");
    expect(helmReleaseName("cluster", "cluster")).toBe("telflo-cluster");
    expect(helmReleaseName("gateway", "traces-sampling")).toBe("traces-sampling");
  });
});

// One file per release, so a group's install never reads another group's (or an older) values.
describe("helmValuesFileName", () => {
  it("is <release>-values.yaml for each role, and the public download's name stays values.yaml", () => {
    expect(helmValuesFileName(helmReleaseName("node", "node"))).toBe("telflo-node-values.yaml");
    expect(helmValuesFileName(helmReleaseName("cluster", "cluster"))).toBe("telflo-cluster-values.yaml");
    expect(helmValuesFileName(helmReleaseName("gateway", "traces-sampling"))).toBe("traces-sampling-values.yaml");
    expect(helmValuesFileName(GATEWAY_52)).toBe(`${GATEWAY_52}-values.yaml`);
    expect(HELM_VALUES_DOWNLOAD_NAME).toBe("values.yaml");
  });

  it.each(["node", "cluster", "Traces", "it's-CANARY-7f3a", "$(echo EXPANDED)", `${GATEWAY_52}x`, "a/b", "", 7 as unknown as string])(
    "refuses the release %j as the install does, naming the field only",
    (release) => {
      expect(() => helmValuesFileName(release)).toThrow(new HelmBuildError("release"));
    },
  );
});

// The printed command reads exactly the file THIS browser download saved.
describe("a browser download's values file name", () => {
  it("is <release>-values-<fragment>.yaml with a fragment, and two downloads' fragments are two names", () => {
    expect(helmValuesFileName("telflo-node", "0a1b2c3d")).toBe("telflo-node-values-0a1b2c3d.yaml");
    expect(helmValuesFileName("telflo-cluster", "ffffffff")).toBe("telflo-cluster-values-ffffffff.yaml");
    expect(helmValuesFileName(GATEWAY_52, "00000000")).toBe(`${GATEWAY_52}-values-00000000.yaml`);
    const first = helmValuesFileName("telflo-node", helmDownloadFragment(new Uint8Array([0x01, 0x02, 0x03, 0x04])));
    const second = helmValuesFileName("telflo-node", helmDownloadFragment(new Uint8Array([0x01, 0x02, 0x03, 0x05])));
    expect([first, second]).toEqual(["telflo-node-values-01020304.yaml", "telflo-node-values-01020305.yaml"]);
    // Without a fragment, the curl / Quick Deploy path's name is unchanged.
    expect(helmValuesFileName("telflo-node")).toBe("telflo-node-values.yaml");
  });

  it.each(["0A1B2C3D", "0a1b2c3", "0a1b2c3d4", "", "g1234567", "../0a1b2", "0a1b 2c3", "$(echo EXPANDED)", 12345678 as unknown as string])(
    "refuses the fragment %j, naming the field only",
    (unique) => {
      expect(() => helmValuesFileName("telflo-node", unique)).toThrow(new HelmBuildError("unique"));
      try {
        helmValuesFileName("telflo-node", unique);
      } catch (error) {
        expect((error as Error).message).not.toContain("EXPANDED");
      }
    },
  );

  it("checks the release before the fragment", () => {
    expect(() => helmValuesFileName("node", "0a1b2c3d")).toThrow(new HelmBuildError("release"));
  });

  it("makes the fragment from 4 bytes: 8 lowercase hex digits, each byte padded", () => {
    expect(helmDownloadFragment(new Uint8Array([0x00, 0x01, 0xab, 0xff]))).toBe("0001abff");
    expect(helmDownloadFragment(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("deadbeef");
    expect(helmDownloadFragment(new Uint8Array(4))).toBe("00000000");
    const random = helmDownloadFragment(crypto.getRandomValues(new Uint8Array(4)));
    expect(HELM_VALUES_FRAGMENT_PATTERN.test(random)).toBe(true);
    expect(helmValuesFileName("telflo-node", random)).toBe(`telflo-node-values-${random}.yaml`);
  });

  it.each<[string, unknown]>([
    ["3 bytes", new Uint8Array(3)],
    ["5 bytes", new Uint8Array(5)],
    ["no bytes", new Uint8Array(0)],
    ["an array of numbers", [1, 2, 3, 4]],
    ["a Uint16Array", new Uint16Array(4)],
    ["a string", "deadbeef"],
  ])("refuses %s as the random bytes", (_label, random) => {
    expect(() => helmDownloadFragment(random as Uint8Array)).toThrow(new HelmBuildError("random"));
  });

  it("knows a release's own names, and no other release's", () => {
    expect(isHelmValuesFileName("telflo-node", "telflo-node-values.yaml")).toBe(true);
    expect(isHelmValuesFileName("telflo-node", "telflo-node-values-0a1b2c3d.yaml")).toBe(true);
    expect(isHelmValuesFileName(GATEWAY_52, `${GATEWAY_52}-values-0a1b2c3d.yaml`)).toBe(true);
    for (const [release, name] of [
      ["telflo-node", "telflo-cluster-values.yaml"],
      ["telflo-cluster", "telflo-node-values-0a1b2c3d.yaml"],
      ["traces", "traces-values-values.yaml"],
      ["traces-values", "traces-values.yaml"],
      ["traces", "traces-values-0a1b2c3d-values.yaml"],
      ["telflo-node", "telflo-node-values (1).yaml"],
      ["telflo-node", "telflo-node-values-0A1B2C3D.yaml"],
      ["telflo-node", "telflo-node-values-0a1b2c3.yaml"],
      ["telflo-node", "telflo-node-values-.yaml"],
      // Five characters where `.yaml` goes (the length and the middle alone pass them).
      ["telflo-node", "telflo-node-values.json"],
      ["telflo-node", "telflo-node-values-0a1b2c3d.json"],
      ["telflo-node", "telflo-node-valuesXXXXX"],
      ["telflo-node", "telflo-node-values.yml"],
      ["telflo-node", "telflo-node-values-0a1b2c3d.yml"],
      ["telflo-node", "telflo-node-values.yaml.bak"],
      ["telflo-node", "telflo-node-values"],
      ["telflo-node", "telflo-node-values-0a1b2c3d"],
      ["telflo-node", "values.yaml"],
      ["telflo-node", "./telflo-node-values.yaml"],
      ["telflo-node", "telflo-node-values.yaml.yaml"],
      // Another release's own names of THIS release's length: only the prefix tells them apart.
      ["telflo-node", "telflo-edge-values.yaml"],
      ["telflo-node", "gw-abcdefgh-values-0a1b2c3d.yaml"],
      ["telflo-cluster", "gw-abcdefghijk-values.yaml"],
      ["telflo-cluster", "gw-abcdefghijk-values-0a1b2c3d.yaml"],
      ["traces-sampling", "traces-samplers-values.yaml"],
      ["node", "node-values.yaml"],
      ["Traces", "Traces-values.yaml"],
    ]) {
      expect({ release, name, own: isHelmValuesFileName(release!, name!) }).toEqual({ release, name, own: false });
    }
  });
});

const FACTS: HelmInstallFacts = {
  imageTag: "ghcr.io/telflo/telflo/collector:0.162.0",
  endpoint: "https://opamp.telflo.example/opamp/api/v1",
  allowInsecureConnections: false,
  collector: { distribution: "otelcol-contrib", version: "0.162.0" },
  envVarNames: ["LOKI_TENANT", "_A1"],
  groupId: GROUP_ID,
  helm: {
    chartReference: DEFAULT_HELM_CHART_REFERENCE,
    chartVersion: DEFAULT_HELM_CHART_VERSION,
    imageRepository: "ghcr.io/telflo/telflo/collector",
    release: "traces-sampling",
    fullnameOverride: null,
    role: "gateway",
    namespace: "observability",
    replicas: 3,
    volumes: [{ hostPath: "/run/spool", hostPathType: "Socket", mountPath: "/var/run/spool.sock", readOnly: true }],
  },
};

describe("HelmInstallFactsSchema", () => {
  const AGENT_HELM = { ...FACTS.helm, release: "telflo-node", fullnameOverride: "3f9a1c2e-default", role: "node", replicas: null, volumes: [] };
  const CLUSTER_HELM = { ...FACTS.helm, release: "telflo-cluster", fullnameOverride: "7b20d4aa-cluster", role: "cluster", replicas: null, volumes: [] };

  it("takes each role's facts: a gateway's replicas, none for the Agent or the Cluster; the Agent's and the Cluster's fullnameOverride, none for a gateway", () => {
    const agent = { ...FACTS, helm: AGENT_HELM };
    const cluster = { ...FACTS, helm: CLUSTER_HELM };
    for (const facts of [FACTS, agent, cluster]) expect(HelmInstallFactsSchema.parse(facts)).toEqual(facts);
  });

  // The override's shape per role (the facts carry no fleet id: the API's tests check it against the fleet).
  it("takes the Agent's override of up to 49 characters, any slug, and helmFullnameOverride's own", () => {
    for (const fullnameOverride of [
      `3f9a1c2e-${"a".repeat(40)}`,
      "00000000-group",
      "3f9a1c2e-0",
      "3f9a1c2e-edge-gateway-1",
      helmFullnameOverride(FLEET_ID, "node", `${"a".repeat(39)} b`),
    ]) {
      const facts = { ...FACTS, helm: { ...AGENT_HELM, fullnameOverride } };
      expect({ fullnameOverride, ok: HelmInstallFactsSchema.safeParse(facts).success }).toEqual({ fullnameOverride, ok: true });
    }
  });

  it.each<[string, string | null | undefined]>([
    ["none", null],
    ["missing", undefined],
    ["empty", ""],
    ["50 characters", `3f9a1c2e-${"a".repeat(41)}`],
    ["a trailing hyphen", "3f9a1c2e-default-"],
    ["no slug", "3f9a1c2e-"],
    ["a capital", "3f9a1c2e-Default"],
    ["an uppercase prefix", "3F9A1C2E-default"],
    ["a 7-character prefix", "3f9a1c2-default"],
    ["a prefix that isn't hex", "3f9a1c2g-default"],
    ["no prefix", "default"],
    ["the release", "telflo-node"],
    ["an underscore", "3f9a1c2e-de_fault"],
    ["a dot", "3f9a1c2e-de.fault"],
    ["$(echo EXPANDED)", "$(echo EXPANDED)"],
  ])("refuses the Agent's facts with an override of %s", (_label, fullnameOverride) => {
    const helm = fullnameOverride === undefined ? (({ fullnameOverride: _omitted, ...rest }) => rest)(AGENT_HELM) : { ...AGENT_HELM, fullnameOverride };
    expect(HelmInstallFactsSchema.safeParse({ ...FACTS, helm }).success).toBe(false);
  });

  it.each<[string, string | null]>([
    ["none", null],
    ["the Agent's", "7b20d4aa-default"],
    ["another slug", "7b20d4aa-clusters"],
    ["no prefix", "cluster"],
    ["an uppercase prefix", "7B20D4AA-cluster"],
    ["the release", "telflo-cluster"],
  ])("refuses the Cluster's facts with an override of %s", (_label, fullnameOverride) => {
    expect(HelmInstallFactsSchema.safeParse({ ...FACTS, helm: { ...CLUSTER_HELM, fullnameOverride } }).success).toBe(false);
  });

  it.each(["7b20d4aa-cluster", "3f9a1c2e-default", "traces-sampling", ""])("refuses a gateway's facts with an override (%j)", (fullnameOverride) => {
    const result = HelmInstallFactsSchema.safeParse({ ...FACTS, helm: { ...FACTS.helm, fullnameOverride } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["helm.fullnameOverride"]);
  });

  it("refuses a gateway's facts with no fullnameOverride key at all", () => {
    expect(HelmInstallFactsSchema.safeParse({ ...FACTS, helm: (({ fullnameOverride: _omitted, ...rest }) => rest)(FACTS.helm) }).success).toBe(false);
  });

  it.each([
    ["a mounts field", { ...FACTS, mounts: [] }],
    ["mountsReadable", { ...FACTS, mountsReadable: true }],
    ["settingsReadable", { ...FACTS, helm: { ...FACTS.helm, settingsReadable: true } }],
    ["a bearer", { ...FACTS, token: BEARER }],
    ["no helm", (({ helm: _helm, ...rest }) => rest)(FACTS)],
    ["the Agent with replicas", { ...FACTS, helm: { ...FACTS.helm, release: "telflo-node", role: "node", replicas: 1 } }],
    ["the Cluster with replicas", { ...FACTS, helm: { ...FACTS.helm, release: "telflo-cluster", role: "cluster", replicas: 1 } }],
    ["a gateway without replicas", { ...FACTS, helm: { ...FACTS.helm, replicas: null } }],
    ["the Agent under another release", { ...FACTS, helm: { ...FACTS.helm, release: "traces-sampling", role: "node", replicas: null } }],
    ["a gateway under a reserved release", { ...FACTS, helm: { ...FACTS.helm, release: "telflo-node" } }],
    ["a namespace with a capital", { ...FACTS, helm: { ...FACTS.helm, namespace: "Observability" } }],
    ["another chart reference", { ...FACTS, helm: { ...FACTS.helm, chartReference: "https://x/y" } }],
    ["a ranged chart version", { ...FACTS, helm: { ...FACTS.helm, chartVersion: "^0.3.5" } }],
    ["an image repository with a space", { ...FACTS, helm: { ...FACTS.helm, imageRepository: "ghcr.io/telflo collector" } }],
    ["a variable the chart sets", { ...FACTS, envVarNames: ["POD_NAME"] }],
    ["a reserved variable", { ...FACTS, envVarNames: ["OPAMP_TOKEN"] }],
    ["a variable twice", { ...FACTS, envVarNames: ["A", "A"] }],
    ["a volume at a relative path", { ...FACTS, helm: { ...FACTS.helm, volumes: [{ ...FACTS.helm.volumes[0]!, hostPath: "run" }] } }],
  ])("refuses facts with %s", (_label, facts) => {
    expect(HelmInstallFactsSchema.safeParse(facts).success).toBe(false);
  });

  // The platform's chart quotes collectorEnv's keys.
  it("offers a YAML word's name like any other", () => {
    expect(HelmInstallFactsSchema.parse({ ...FACTS, envVarNames: ["ON", "Null", "yes"] }).envVarNames).toEqual(["ON", "Null", "yes"]);
  });
});

describe("helmValuesInputOf", () => {
  it("takes the values from the facts, the reveal's bearer and the typed variables", () => {
    expect(helmValuesInputOf(FACTS, BEARER, [{ name: "_A1", value: "plain" }])).toEqual({
      role: "gateway",
      group: "traces-sampling",
      fullnameOverride: null,
      collectorGroupId: GROUP_ID,
      image: { repository: "ghcr.io/telflo/telflo/collector", tag: "0.162.0" },
      allowInsecure: false,
      replicas: 3,
      endpoint: "https://opamp.telflo.example/opamp/api/v1",
      token: BEARER,
      volumes: FACTS.helm.volumes,
      collectorEnv: [{ name: "_A1", value: "plain" }],
    });
    const agent = { ...FACTS, helm: { ...FACTS.helm, release: "telflo-node", fullnameOverride: "3f9a1c2e-default", role: "node" as const, replicas: null } };
    expect(helmValuesInputOf(agent, BEARER, [])).toMatchObject({ role: "node", group: "node", fullnameOverride: "3f9a1c2e-default", replicas: null, collectorEnv: [] });
    const cluster = { ...FACTS, helm: { ...FACTS.helm, release: "telflo-cluster", fullnameOverride: "7b20d4aa-cluster", role: "cluster" as const, replicas: null } };
    expect(helmValuesInputOf(cluster, BEARER, [])).toMatchObject({ role: "cluster", group: "cluster", fullnameOverride: "7b20d4aa-cluster" });
  });

  it("refuses a variable the facts don't offer, naming its index only", () => {
    expect(() => helmValuesInputOf(FACTS, BEARER, [{ name: "_A1", value: "x" }, { name: "SECRET_NAME", value: "x" }])).toThrow(
      new HelmBuildError("collectorEnv.1.name"),
    );
  });

  // A broken entry is the backstop's refusal at its index, never a TypeError.
  it.each<[string, unknown, string]>([
    ["a null entry", [{ name: "_A1", value: "x" }, null], "collectorEnv.1"],
    ["a string entry", ["CANARY-7f3a"], "collectorEnv.0"],
    ["an array entry", [["_A1", "x"]], "collectorEnv.0"],
    ["variables that aren't a list", { _A1: "x" }, "collectorEnv"],
  ])("refuses %s with HelmBuildError, naming the field", (_label, env, field) => {
    expect(() => helmValuesInputOf(FACTS, BEARER, env as HelmEnvValue[])).toThrow(new HelmBuildError(field));
  });
});

// The public download logs a typed variable's refusal at warn, every other field's at error.
describe("HelmBuildError's source", () => {
  const refusal = (build: () => unknown): HelmBuildError => {
    try {
      build();
    } catch (error) {
      if (error instanceof HelmBuildError) return error;
      throw error;
    }
    throw new Error("the builder didn't refuse");
  };
  const input = () => helmValuesInputOf(FACTS, BEARER, [{ name: "_A1", value: "plain" }]);

  it.each<[string, () => unknown, string]>([
    ["variables that aren't a list", () => helmValuesInputOf(FACTS, BEARER, { _A1: "x" } as unknown as HelmEnvValue[]), "collectorEnv"],
    ["a null entry", () => helmValuesInputOf(FACTS, BEARER, [null as unknown as HelmEnvValue]), "collectorEnv.0"],
    ["a variable the facts don't offer", () => helmValuesInputOf(FACTS, BEARER, [{ name: "SECRET_NAME", value: "x" }]), "collectorEnv.0.name"],
    ["a value with a control character", () => helmValuesYaml({ ...input(), collectorEnv: [{ name: "_A1", value: "tab\there" }] }), "collectorEnv.0.value"],
  ])("is the choices' for %s", (_label, build, field) => {
    expect({ field: refusal(build).field, source: refusal(build).source }).toEqual({ field, source: "choices" });
  });

  it.each<[string, () => unknown, string]>([
    ["an endpoint with a space", () => helmValuesYaml({ ...input(), endpoint: "https://opamp.example/a b" }), "endpoint"],
    ["an image repository with a capital", () => helmValuesYaml({ ...input(), image: { repository: "Ghcr.io/x", tag: "0.162.0" } }), "image.repository"],
    ["a group id that isn't a UUID", () => helmValuesYaml({ ...input(), collectorGroupId: "not-a-uuid" }), "collectorGroupId"],
    ["a token with Bearer before it", () => helmValuesYaml({ ...input(), token: `Bearer ${BEARER}` }), "token"],
    ["a gateway with no replicas", () => helmValuesYaml({ ...input(), replicas: null }), "replicas"],
    ["a gateway with a fullnameOverride", () => helmValuesYaml({ ...input(), fullnameOverride: "3f9a1c2e-default" }), "fullnameOverride"],
    ["a fleet id that isn't a UUID", () => helmFullnameOverride("not-a-uuid", "node", "Default"), "fleetId"],
  ])("is the operator's for %s", (_label, build, field) => {
    expect({ field: refusal(build).field, source: refusal(build).source }).toEqual({ field, source: "operator" });
  });

  it("reads `collectorEnv` and its entries only, not a field that merely starts with the word", () => {
    expect(new HelmBuildError("collectorEnvironment").source).toBe("operator");
  });
});

describe("helmValuesYaml", () => {
  it("renders the Agent's values: two volumes and collectorEnv (golden)", () => {
    expect(helmValuesYaml(AGENT)).toBe(AGENT_GOLDEN);
    for (const document of parsedBoth(AGENT_GOLDEN)) expect(document).toEqual(documentOf(AGENT));
  });

  it("renders the Cluster's values: no replicas, no volumes (golden)", () => {
    expect(helmValuesYaml(CLUSTER)).toBe(CLUSTER_GOLDEN);
    for (const document of parsedBoth(CLUSTER_GOLDEN)) expect(document).toEqual(documentOf(CLUSTER));
  });

  it("renders a gateway's values with its replicas (golden)", () => {
    expect(helmValuesYaml(GATEWAY)).toBe(GATEWAY_GOLDEN);
    for (const document of parsedBoth(GATEWAY_GOLDEN)) expect(document).toEqual(documentOf(GATEWAY));
  });

  // A-7's name listed U+0085 among the values read back: a typed value can't hold it (a C1 control character,
  // installEnvValueProblem's rule: refused below and by the backstops); no other field holds a non-ASCII character.
  it("writes every string as a double-quoted ASCII scalar, and the repo's YAML parser reads back the inputs: quotes, backslashes, $(echo EXPANDED), U+2028, U+2029, U+FFFF, an astral character (U+0085 refused as a control character)", () => {
    const tricky = `it's "q" \\ back $(echo EXPANDED) \u2028 ls \u2029 ps \uffff max \u{1f600} emoji \ufeff bom \u00e9 end`;
    const input: HelmValuesInput = { ...AGENT, collectorEnv: [{ name: "LOKI_TENANT", value: tricky }, { name: "Q", value: '"\\' }] };
    const yaml = helmValuesYaml(input);
    expect(yaml).toMatch(/^[\n\x20-\x7e]*$/);
    expect(yaml.split("\n")).toContain(
      String.raw`  "LOKI_TENANT": "it's \"q\" \\ back $(echo EXPANDED) \u2028 ls \u2029 ps \uffff max \U0001f600 emoji \ufeff bom \u00e9 end"`,
    );
    expect(() => helmValuesYaml({ ...input, collectorEnv: [{ name: "A", value: "nel \u0085" }] })).toThrow(new HelmBuildError("collectorEnv.0.value"));
    expect(yaml.split("\n")).toContain(String.raw`  "Q": "\"\\"`);
    for (const document of parsedBoth(yaml)) expect(document).toEqual(documentOf(input));
    // Every value line's string is one double-quoted scalar.
    for (const line of yaml.split("\n").filter((text) => /^\s*("[^"]+"|[a-zA-Z]+): "/.test(text))) {
      expect(line).toMatch(/: "(?:[^"\\]|\\.)*"$/);
    }
  });

  // A YAML 1.1 word is a variable like any other; its key quoted, read back as itself under YAML 1.1.
  it("writes a YAML 1.1 word's variable like any other, a quoted key Helm's parser reads as the name (golden)", () => {
    const input: HelmValuesInput = {
      ...CLUSTER,
      collectorEnv: [
        { name: "ON", value: "acme" },
        { name: "Null", value: "true" },
        { name: "yes", value: "no" },
        { name: "y", value: "~" },
      ],
    };
    const yaml = helmValuesYaml(input);
    expect(yaml).toBe(`${CLUSTER_GOLDEN}collectorEnv:\n  "ON": "acme"\n  "Null": "true"\n  "yes": "no"\n  "y": "~"\n`);
    for (const document of parsedBoth(yaml)) {
      expect(Object.entries((document as { collectorEnv: Record<string, unknown> }).collectorEnv)).toEqual([
        ["ON", "acme"],
        ["Null", "true"],
        ["yes", "no"],
        ["y", "~"],
      ]);
    }
  });

  it("writes collectorEnv's names as quoted keys, in order", () => {
    const input: HelmValuesInput = {
      ...CLUSTER,
      collectorEnv: [
        { name: "ZED", value: "1" },
        { name: "ALPHA", value: "2" },
        { name: "_m", value: "3" },
        { name: "on_call", value: "true" },
      ],
    };
    const yaml = helmValuesYaml(input);
    expect(yaml.slice(yaml.indexOf("collectorEnv:"))).toBe('collectorEnv:\n  "ZED": "1"\n  "ALPHA": "2"\n  "_m": "3"\n  "on_call": "true"\n');
    for (const document of parsedBoth(yaml)) {
      expect(Object.entries((document as { collectorEnv: Record<string, unknown> }).collectorEnv)).toEqual([
        ["ZED", "1"],
        ["ALPHA", "2"],
        ["_m", "3"],
        ["on_call", "true"],
      ]);
    }
  });

  const CANARY = "CANARY-7f3a";
  const variables = (collectorEnv: HelmValuesInput["collectorEnv"]): HelmValuesInput => ({ ...AGENT, collectorEnv });
  const volume = AGENT.volumes[0]!;
  const BACKSTOPS: [string, HelmValuesInput, string][] = [
    ["a bearer of another shape", { ...AGENT, token: `${CANARY} tok'en` }, "token"],
    ["a bearer with Bearer before it", { ...AGENT, token: `Bearer ${BEARER}` }, "token"],
    ["a group id that isn't a UUID", { ...AGENT, collectorGroupId: CANARY }, "collectorGroupId"],
    ["an image repository with a quote", { ...AGENT, image: { ...AGENT.image, repository: `ghcr.io/${CANARY}"x` } }, "image.repository"],
    ["an image tag that isn't a version", { ...AGENT, image: { ...AGENT.image, tag: `v0.162.0-${CANARY}` } }, "image.tag"],
    ["an endpoint with a query", { ...AGENT, endpoint: `https://opamp.example/v1?${CANARY}` }, "endpoint"],
    ["allowInsecure as a string", { ...AGENT, allowInsecure: "true" as unknown as boolean }, "allowInsecure"],
    ["an unknown role", { ...AGENT, role: CANARY as HelmValuesInput["role"] }, "role"],
    ["the Agent with replicas", { ...AGENT, replicas: 2 }, "replicas"],
    ["a gateway without replicas", { ...GATEWAY, replicas: null }, "replicas"],
    ["a gateway with 1,001 replicas", { ...GATEWAY, replicas: 1001 }, "replicas"],
    ["the Agent's group not node", { ...AGENT, group: CANARY }, "group"],
    ["a gateway's group with a capital", { ...GATEWAY, group: `Gw-${CANARY}` }, "group"],
    ["a gateway's group reserved", { ...GATEWAY, group: "telflo-node" }, "group"],
    // The public download renders without the facts' schema, so the backstop checks the override.
    ["a gateway with a fullnameOverride", { ...GATEWAY, fullnameOverride: `${CANARY.toLowerCase()}-x` }, "fullnameOverride"],
    ["a gateway with the Agent's fullnameOverride", { ...GATEWAY, fullnameOverride: "3f9a1c2e-default" }, "fullnameOverride"],
    ["the Agent without a fullnameOverride", { ...AGENT, fullnameOverride: null }, "fullnameOverride"],
    ["the Agent's fullnameOverride with a capital", { ...AGENT, fullnameOverride: `3f9a1c2e-${CANARY}` }, "fullnameOverride"],
    ["the Agent's fullnameOverride of 50 characters", { ...AGENT, fullnameOverride: `3f9a1c2e-${"a".repeat(41)}` }, "fullnameOverride"],
    ["the Agent's fullnameOverride with a quote", { ...AGENT, fullnameOverride: `3f9a1c2e-it"s` }, "fullnameOverride"],
    ["the Agent's fullnameOverride not a string", { ...AGENT, fullnameOverride: 7 as unknown as string }, "fullnameOverride"],
    ["the Cluster without a fullnameOverride", { ...CLUSTER, fullnameOverride: null }, "fullnameOverride"],
    ["the Cluster with the Agent's fullnameOverride", { ...CLUSTER, fullnameOverride: "7b20d4aa-default" }, "fullnameOverride"],
    ["a volume with a .. segment", { ...AGENT, volumes: [{ ...volume, hostPath: `/${CANARY}/../etc` }] }, "volumes"],
    ["a volume with a space", { ...AGENT, volumes: [{ ...volume, mountPath: `/mnt/${CANARY} x` }] }, "volumes"],
    ["the Agent's volume at /var/log/pods", { ...AGENT, volumes: [{ ...volume, mountPath: "/var/log/pods" }] }, "volumes"],
    ["a volume with a type key", { ...AGENT, volumes: [{ ...volume, type: "hostPath" } as typeof volume] }, "volumes"],
    ["a variable's name not a shell name", variables([{ name: `${CANARY}`, value: "x" }]), "collectorEnv.0.name"],
    ["a reserved variable", variables([{ name: "OPAMP_TOKEN", value: "x" }]), "collectorEnv.0.name"],
    ["a variable the chart sets", variables([{ name: "_A1", value: "x" }, { name: "POD_NAME", value: "x" }]), "collectorEnv.1.name"],
    ["a variable twice", variables([{ name: "A", value: "x" }, { name: "A", value: "y" }]), "collectorEnv.1.name"],
    ["a 257-character name", variables([{ name: `A${"B".repeat(256)}`, value: "x" }]), "collectorEnv.0.name"],
    ["51 variables", variables(Array.from({ length: 51 }, (_, index) => ({ name: `V${index}`, value: "x" }))), "collectorEnv"],
    ["a value with a line break", variables([{ name: "A", value: `${CANARY}\nx` }]), "collectorEnv.0.value"],
    ["a value with U+0085", variables([{ name: "A", value: `${CANARY}\u0085` }]), "collectorEnv.0.value"],
    ["an empty value", variables([{ name: "A", value: "" }]), "collectorEnv.0.value"],
    ["a value with a lone surrogate", variables([{ name: "A", value: `${CANARY}\ud800` }]), "collectorEnv.0.value"],
    ["a value with a lone low surrogate", variables([{ name: "A", value: `${CANARY}\udc00 x` }]), "collectorEnv.0.value"],
    ["a null variable", variables([{ name: "A", value: "x" }, null as unknown as HelmEnvValue]), "collectorEnv.1"],
    ["a variable that's a string", variables([CANARY as unknown as HelmEnvValue]), "collectorEnv.0"],
    ["a value of 4,097 characters", variables([{ name: "A", value: `${CANARY}${"x".repeat(4097)}` }]), "collectorEnv.0.value"],
  ];

  it("throws on each backstop, and no message holds the value", () => {
    for (const [label, input, field] of BACKSTOPS) {
      let thrown: unknown;
      try {
        helmValuesYaml(input);
      } catch (error) {
        thrown = error;
      }
      expect({ label, thrown: thrown instanceof HelmBuildError }).toEqual({ label, thrown: true });
      const error = thrown as HelmBuildError;
      expect({ label, field: error.field, message: error.message }).toEqual({ label, field, message: `The Helm install's ${field} fails its rule.` });
      expect({ label, quoted: `${error.message} ${error.stack ?? ""}`.includes(CANARY) }).toEqual({ label, quoted: false });
      expect({ label, quoted: /OPAMP_TOKEN|POD_NAME|Bearer|telflo-node|canary|3f9a1c2e|7b20d4aa/.test(error.message) }).toEqual({ label, quoted: false });
    }
  });
});

describe("the Helm commands", () => {
  const AGENT_INSTALL: HelmInstallParts = {
    release: "telflo-node",
    chartReference: DEFAULT_HELM_CHART_REFERENCE,
    chartVersion: DEFAULT_HELM_CHART_VERSION,
    namespace: "observability",
  };
  const LIMITS: HelmInstallParts = { release: GATEWAY_52, chartReference: MIRROR, chartVersion: "10.20.30", namespace: NAMESPACE_63 };

  it("quotes every value once, one flag a line (golden), with a 52-character gateway, a 63-character namespace and a mirror's reference with a port", () => {
    expect(GATEWAY_52).toHaveLength(52);
    expect(NAMESPACE_63).toHaveLength(63);
    expect(helmInstallCommand(AGENT_INSTALL)).toBe(String.raw`helm upgrade --install 'telflo-node' 'oci://ghcr.io/telflo/telflo/charts/supervisor-collector' \
  --version '0.2.0' \
  -n 'observability' --create-namespace \
  -f 'telflo-node-values.yaml' \
  --wait --timeout=120s`);
    expect(helmInstallCommand(LIMITS)).toBe(String.raw`helm upgrade --install 'traces-sampling-pool-in-the-eu-west-region-number-01' 'oci://registry.example:5000/mirror/charts/telflo-supervisor-collector' \
  --version '10.20.30' \
  -n 'observability-collectors-for-the-production-cluster-in-eu-west1' --create-namespace \
  -f 'traces-sampling-pool-in-the-eu-west-region-number-01-values.yaml' \
  --wait --timeout=120s`);
    expect(helmInstallCommand({ ...AGENT_INSTALL, release: "telflo-cluster" })).toBe(String.raw`helm upgrade --install 'telflo-cluster' 'oci://ghcr.io/telflo/telflo/charts/supervisor-collector' \
  --version '0.2.0' \
  -n 'observability' --create-namespace \
  -f 'telflo-cluster-values.yaml' \
  --wait --timeout=120s`);
  });

  it("names the file the browser's download saved, quoted once (golden)", () => {
    expect(helmInstallCommand({ ...AGENT_INSTALL, valuesFile: helmValuesFileName("telflo-node", "0a1b2c3d") })).toBe(String.raw`helm upgrade --install 'telflo-node' 'oci://ghcr.io/telflo/telflo/charts/supervisor-collector' \
  --version '0.2.0' \
  -n 'observability' --create-namespace \
  -f 'telflo-node-values-0a1b2c3d.yaml' \
  --wait --timeout=120s`);
    expect(helmInstallCommand({ ...AGENT_INSTALL, valuesFile: "telflo-node-values.yaml" })).toBe(helmInstallCommand(AGENT_INSTALL));
    const first = helmInstallCommand({ ...AGENT_INSTALL, valuesFile: helmValuesFileName("telflo-node", "01020304") });
    const second = helmInstallCommand({ ...AGENT_INSTALL, valuesFile: helmValuesFileName("telflo-node", "01020305") });
    expect(first).not.toBe(second);
  });

  it("downloads and installs the fragment-less name on the Quick Deploy path, whatever valuesFile says", () => {
    expect(helmQuickDeployCommand(HTTPS_URL, { ...AGENT_INSTALL, valuesFile: "telflo-node-values-0a1b2c3d.yaml" })).toBe(
      helmQuickDeployCommand(HTTPS_URL, AGENT_INSTALL),
    );
    expect(helmQuickDeployCommand(HTTPS_URL, AGENT_INSTALL).match(/'telflo-node-values\.yaml'/g)).toHaveLength(2);
  });

  it("keeps the link off curl's command line, adds --proto only for https, and installs only after the download (golden)", () => {
    expect(helmValuesCurlCommand(HTTPS_URL, "telflo-node")).toBe(
      String.raw`( umask 077 && printf 'url = "%s"\n' 'https://telflo.example.com/api/v1/quick-deploy/tqd_Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-xyz' | curl -q -g -fsS --retry 3 --proto '=https' -K - -o 'telflo-node-values.yaml' )`,
    );
    expect(helmValuesCurlCommand(HTTP_URL, "telflo-cluster")).toBe(
      String.raw`( umask 077 && printf 'url = "%s"\n' 'http://host.docker.internal:50080/telflo/api/v1/quick-deploy/tqd_Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-xyz' | curl -q -g -fsS --retry 3 -K - -o 'telflo-cluster-values.yaml' )`,
    );
    expect(helmQuickDeployCommand(HTTPS_URL, { ...AGENT_INSTALL, release: "traces-sampling" })).toBe(String.raw`( umask 077 && printf 'url = "%s"\n' 'https://telflo.example.com/api/v1/quick-deploy/tqd_Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-Ab9_-xyz' | curl -q -g -fsS --retry 3 --proto '=https' -K - -o 'traces-sampling-values.yaml' ) && \
helm upgrade --install 'traces-sampling' 'oci://ghcr.io/telflo/telflo/charts/supervisor-collector' \
  --version '0.2.0' \
  -n 'observability' --create-namespace \
  -f 'traces-sampling-values.yaml' \
  --wait --timeout=120s`);
  });

  it("quotes the uninstall's release and namespace (golden)", () => {
    expect(helmUninstallCommand({ release: "telflo-node", namespace: "observability" })).toBe("helm uninstall 'telflo-node' -n 'observability'");
    expect(helmUninstallCommand({ release: GATEWAY_52, namespace: NAMESPACE_63 })).toBe(
      "helm uninstall 'traces-sampling-pool-in-the-eu-west-region-number-01' -n 'observability-collectors-for-the-production-cluster-in-eu-west1'",
    );
  });

  const CANARY = "CANARY-7f3a";
  it.each<[string, () => string, string]>([
    ["a release with a quote", () => helmInstallCommand({ ...AGENT_INSTALL, release: `it's-${CANARY}` }), "release"],
    ["a release of 53 characters", () => helmInstallCommand({ ...AGENT_INSTALL, release: `${GATEWAY_52}x` }), "release"],
    ["a reserved name", () => helmInstallCommand({ ...AGENT_INSTALL, release: "node" }), "release"],
    ["a release with $(echo EXPANDED)", () => helmUninstallCommand({ release: "$(echo EXPANDED)", namespace: "observability" }), "release"],
    ["a namespace of 64 characters", () => helmInstallCommand({ ...AGENT_INSTALL, namespace: `${NAMESPACE_63}x` }), "namespace"],
    ["a namespace with a space", () => helmUninstallCommand({ release: "telflo-node", namespace: `${CANARY} ns` }), "namespace"],
    ["a chart reference over https", () => helmInstallCommand({ ...AGENT_INSTALL, chartReference: `https://${CANARY}` }), "chartReference"],
    ["a chart version with a v", () => helmInstallCommand({ ...AGENT_INSTALL, chartVersion: `v0.3.5-${CANARY}` }), "chartVersion"],
    ["a link the API doesn't make", () => helmValuesCurlCommand(`https://telflo.example.com/${CANARY}`, "telflo-node"), "url"],
    ["a download's release with a quote", () => helmValuesCurlCommand(HTTPS_URL, `it's-${CANARY}`), "release"],
    ["a Quick Deploy's release with $(echo EXPANDED)", () => helmQuickDeployCommand(HTTPS_URL, { ...AGENT_INSTALL, release: "$(echo EXPANDED)" }), "release"],
    ["a link with a quote", () => helmQuickDeployCommand(`${HTTPS_URL}'`, AGENT_INSTALL), "url"],
    ["another release's values file", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: "telflo-cluster-values.yaml" }), "valuesFile"],
    [
      "another release's downloaded values file",
      () => helmInstallCommand({ ...AGENT_INSTALL, release: "telflo-cluster", valuesFile: "telflo-node-values-0a1b2c3d.yaml" }),
      "valuesFile",
    ],
    ["a gateway's file for the Agent", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: "traces-values.yaml" }), "valuesFile"],
    ["a wrong fragment", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: "telflo-node-values-0A1B2C3D.yaml" }), "valuesFile"],
    ["a short fragment", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: "telflo-node-values-0a1b.yaml" }), "valuesFile"],
    ["a browser's renamed copy", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: "telflo-node-values (1).yaml" }), "valuesFile"],
    ["the public download's name", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: HELM_VALUES_DOWNLOAD_NAME }), "valuesFile"],
    ["a values file with a quote", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: `it's-${CANARY}.yaml` }), "valuesFile"],
    ["a values file with $(echo EXPANDED)", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: "$(echo EXPANDED)-values.yaml" }), "valuesFile"],
    ["a values file that isn't a string", () => helmInstallCommand({ ...AGENT_INSTALL, valuesFile: 7 as unknown as string }), "valuesFile"],
  ])("refuses %s, naming the field only", (_label, build, field) => {
    expect(build).toThrow(new HelmBuildError(field));
    try {
      build();
    } catch (error) {
      expect((error as Error).message).not.toContain(CANARY);
      expect((error as Error).message).not.toContain("EXPANDED");
    }
  });
});

/*
 * The commands in REAL shells (bash, sh, dash and zsh, those present),
 * whose PATH is a directory of fakes alone: `helm` and `curl`, each
 * recording its argv (each word ended by U+001E, each record by U+001F)
 * and what it read on its standard input. The fake `curl` writes the file
 * its `-o` names with the shell's umask (or nothing, and exit 22, when
 * CURL_FAILS is set: a refused link). The command runs in a directory of
 * its own; after it, the PARENT shell records its umask.
 */
const SHELLS = ["bash", "sh", "dash", "zsh"]
  .map((name) => [`/bin/${name}`, `/usr/bin/${name}`].find((path) => existsSync(path)))
  .filter((path): path is string => path !== undefined);

const RECORD = `rec() { line=""; for a in "$@"; do line="$line$a"$'\\036'; done; printf '%s\\037\\n' "$line" >> "$PROBE_LOG"; }`;
const FAKES: Record<string, string> = {
  helm: `#!/bin/bash
${RECORD}
rec helm "$@"
`,
  curl: `#!/bin/bash
${RECORD}
rec curl "$@"
input=$(/bin/cat; printf .); input=\${input%.}
rec "stdin:$input"
if [ -n "$CURL_FAILS" ]; then exit 22; fi
out=""; while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out=$2; fi; shift; done
printf 'role: "node"\\n' > "$out"
`,
};

let fakes: string;
let log: string;
let work: string;
beforeAll(() => {
  fakes = mkdtempSync(join(tmpdir(), "helm-fakes-"));
  for (const [name, text] of Object.entries(FAKES)) {
    writeFileSync(join(fakes, name), text);
    chmodSync(join(fakes, name), 0o755);
  }
  log = join(fakes, "log");
  work = join(fakes, "work");
});
afterAll(() => rmSync(fakes, { recursive: true, force: true }));

function run(command: string, shell: string, environment: Record<string, string> = {}): { calls: string[][]; status: number } {
  writeFileSync(log, "");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  const flags = shell.endsWith("zsh") ? ["-f", "-c"] : shell.endsWith("bash") ? ["--noprofile", "--norc", "-c"] : ["-c"];
  const prelude = `[ "$(command -v helm)" = "${fakes}/helm" ] || exit 99\numask 022`;
  const after = `pasted=$?; printf 'after:%s\\036\\037\\n' "$(umask)" >> "$PROBE_LOG"; exit "$pasted"`;
  let status = 0;
  try {
    execFileSync(shell, [...flags, `${prelude}\n${command}\n${after}`], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: fakes, HOME: "/nonexistent", PROBE_LOG: log, ...environment },
    });
  } catch (error) {
    status = (error as { status: number }).status;
  }
  const calls = readFileSync(log, "utf8")
    .split("\u001f\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\u001e").slice(0, -1));
  return { calls, status };
}

describe.each(SHELLS)("the Helm commands in %s", (shell) => {
  const install: HelmInstallParts = { release: GATEWAY_52, chartReference: MIRROR, chartVersion: "10.20.30", namespace: NAMESPACE_63 };
  const file = `${GATEWAY_52}-values.yaml`;
  const helmArgv = ["helm", "upgrade", "--install", GATEWAY_52, MIRROR, "--version", "10.20.30", "-n", NAMESPACE_63, "--create-namespace", "-f", file, "--wait", "--timeout=120s"];

  it("hands helm each value as one word, and the uninstall its two", () => {
    const { calls, status } = run(helmInstallCommand(install), shell);
    expect({ calls: calls.map(normalized), status }).toEqual({ calls: [helmArgv, ["after:022"]], status: 0 });
    expect(run(helmUninstallCommand(install), shell).calls[0]).toEqual(["helm", "uninstall", GATEWAY_52, "-n", NAMESPACE_63]);
  });

  it("hands helm a browser download's file name as one word", () => {
    const downloaded = helmValuesFileName(GATEWAY_52, "0a1b2c3d");
    const { calls, status } = run(helmInstallCommand({ ...install, valuesFile: downloaded }), shell);
    expect({ calls: calls.map(normalized), status }).toEqual({ calls: [helmArgv.map((word) => (word === file ? downloaded : word)), ["after:022"]], status: 0 });
  });

  it("downloads the release's values file 0600 with the link on curl's standard input only, then installs reading it; the person's umask unchanged", () => {
    const { calls, status } = run(helmQuickDeployCommand(HTTPS_URL, install), shell);
    expect(status).toBe(0);
    expect(calls.map(normalized)).toEqual(
      [["curl", "-q", "-g", "-fsS", "--retry", "3", "--proto", "=https", "-K", "-", "-o", file], [`stdin:url = "${HTTPS_URL}"\n`], helmArgv, ["after:022"]].map(
        normalized,
      ),
    );
    expect(calls.filter((call) => !call[0]!.startsWith("stdin:")).flat().join(" ")).not.toContain(SECRET);
    expect(statSync(join(work, file)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(work, "values.yaml"))).toBe(false);
  });

  it("runs no helm when the download is refused, and fails", () => {
    const { calls, status } = run(helmQuickDeployCommand(HTTP_URL, install), shell, { CURL_FAILS: "1" });
    expect(status).not.toBe(0);
    expect(calls.map(normalized).map((call) => call[0])).toEqual(["curl", `stdin:url = "${HTTP_URL}"\n`, "after:022"]);
    expect(existsSync(join(work, file))).toBe(false);
  });
});

/** zsh prints the umask as `022`, bash and sh as `0022`: one spelling. */
function normalized(call: string[]): string[] {
  return call[0]?.startsWith("after:") ? [`after:${parseInt(call[0].slice(6), 8).toString(8).padStart(3, "0")}`] : call;
}
