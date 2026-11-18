import type {
  Collector,
  CollectorError,
  CollectorGroup,
  EnrollmentTokenEvent,
  EnrollmentTokenListed,
  FleetDetail,
  FleetSummary,
  FleetType,
  PublishedVersion,
  QuickDeployLink,
  QuickDeployLinkChoices,
} from "@telflo/contracts";
import type { FleetReads } from "~/lib/workspace-reads.js";
import { SAMPLE_CONFIGURATION_IDS, sampleConfigurations, type SampleConfigurationKey } from "./configurations.js";
import { clockAt, DAY, HOUR, MINUTE, SAMPLE_SRE, SAMPLE_VISITOR, sampleNotFound, type SampleClock } from "./types.js";

/*
 * The sample's fleet management (D31-1 decisions 10 and 35): 3 server
 * fleets and 1 Kubernetes fleet, their 14 and 6 collectors, in the
 * platform's shapes, WITH collector groups of both kinds, tokens and their
 * history, install links, and the error history
 * a collector's details read. Every object parses with its contracts
 * schema (fleets.test.ts) and nothing is shaped like a secret (Preflight
 * ruling 6): the platform's token and link shapes have no bearer, prefix or
 * secret field, and no link carries a `…?token=`.
 *
 * - Ids are fixed, lowercase, v4-shaped literals, so a link survives the
 *   rebuild; times are relative to now (`toISOString`), and every read
 *   rebuilds, so the hooks' 15 s polls keep "last seen" fresh (parity).
 * - Liveness is reckoned from each collector's last seen as the server's
 *   windows do (online under a minute, warning under 2, unknown under 5,
 *   offline after), and each fleet's summary is counted from its
 *   collectors and tokens, so the list, the strip and the tabs agree.
 * - Every pin, group assignment, resolution and served version names one
 *   of the sample configurations' published versions (`sample/
 *   configurations.ts`), so their links open the playground editor. No
 *   variable groups (`VariableGroupLink` would read the organization's).
 * - Addresses are in RFC 5737's ranges, emails on `acme.example`, digests
 *   64 hex digits.
 */

// ---------------------------------------------------------------------------
// Fixed ids.

/** The four fleets' ids. */
export const SAMPLE_FLEET_IDS = {
  prod: "44444444-0000-4000-8000-000000000001",
  staging: "44444444-0000-4000-8000-000000000002",
  edgeImport: "44444444-0000-4000-8000-000000000003",
  kubernetes: "44444444-0000-4000-8000-000000000004",
} as const;

/** The groups' ids. */
export const SAMPLE_GROUP_IDS = {
  prodDefault: "55555555-0000-4000-8000-000000000001",
  prodCanary: "55555555-0000-4000-8000-000000000002",
  stagingDefault: "55555555-0000-4000-8000-000000000011",
  importDefault: "55555555-0000-4000-8000-000000000021",
  kubernetesAgent: "55555555-0000-4000-8000-000000000031",
  kubernetesCluster: "55555555-0000-4000-8000-000000000032",
  kubernetesGateway: "55555555-0000-4000-8000-000000000033",
  kubernetesPayments: "55555555-0000-4000-8000-000000000034",
} as const;

/** A collector's id and instance uid from its number (the sample's row numbers). */
function collectorId(number: number): string {
  return `66666666-0000-4000-8000-${String(number).padStart(12, "0")}`;
}
function instanceUid(number: number): string {
  return `77777777-0000-4000-8000-${String(number).padStart(12, "0")}`;
}
function tokenId(number: number): string {
  return `88888888-0000-4000-8000-${String(number).padStart(12, "0")}`;
}
function eventId(number: number): string {
  return `99999999-0000-4000-8000-${String(number).padStart(12, "0")}`;
}
function linkId(number: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(number).padStart(12, "0")}`;
}
function errorId(number: number): string {
  return `bbbbbbbb-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

/** Collectors named by tests and tours: the failing one, and a Kubernetes one. */
export const SAMPLE_COLLECTOR_IDS = {
  braveFalcon: collectorId(2),
  nodeAgent: collectorId(301),
} as const;

const TOKENS = {
  prodDefault: tokenId(1),
  prodRotateOld: tokenId(2),
  prodRotate: tokenId(3),
  stagingDefault: tokenId(11),
  stagingRotateOld: tokenId(12),
  stagingRotate: tokenId(13),
  importDefault: tokenId(21),
  importRotate: tokenId(22),
  kubernetesDefault: tokenId(31),
  kubernetesRotate: tokenId(32),
} as const;

// ---------------------------------------------------------------------------
// The published versions the fleets run: the sample configurations' own.

/**
 * Each published sample configuration's publication (the opamp-server's id)
 * and its content's digest.
 */
const PUBLICATIONS = {
  gateway: { id: "22222222-0000-4000-8000-000000000003", sha256: "13f72ffd371ce98735a9cefc313f01fd95ae54e2ecba9646cc9492b143ad0fa4" },
  hostMetrics: { id: "22222222-0000-4000-8000-000000000015", sha256: "92b83bac4ecd213926a49dcfbe29cc5e595492b46a7dda59ca4729c607f17a2e" },
  rum: { id: "22222222-0000-4000-8000-000000000031", sha256: "d62a795ab5f638b6b14a940394f87557c121cf2ff923fbd2c42229182b83daf9" },
  spanMetrics: { id: "22222222-0000-4000-8000-000000000042", sha256: "4d092e3a44e22d5aebd8660bded866ac00d627d4e3a6b7151fe2555bd9e7dbcf" },
  k8sNode: { id: "22222222-0000-4000-8000-000000000052", sha256: "a3b6eb4360138171fb18d0f0939e5bbd5f4b304dedcaf8358ed1382a4f4acfe6" },
  pii: { id: "22222222-0000-4000-8000-000000000061", sha256: "ce93f41ec707eba8299bdf1b418831a28df729519772fd01004979285eb06eab" },
  cost: { id: "22222222-0000-4000-8000-000000000071", sha256: "e46e092b45feac5bdd83eca702a7c6beaf76e13d782f3dd77b3a4489e51c727a" },
  import: { id: "22222222-0000-4000-8000-000000000091", sha256: "502721141a2499ad54fd2580f36c75c60e542241ad854936f595fee567dbab67" },
} as const satisfies Partial<Record<SampleConfigurationKey, { id: string; sha256: string }>>;

type PublishedKey = keyof typeof PUBLICATIONS;

/** A published version as the platform names it, with its publication's id and digest. */
interface Published {
  publishedVersionId: string;
  sha256: string;
  version: PublishedVersion;
}

/** The published versions of the sample configurations built at `now`: each one's older published version (they open on a draft). */
function publishedVersions(now: number): Record<PublishedKey, Published> {
  const samples = sampleConfigurations(now);
  const entries = (Object.keys(PUBLICATIONS) as PublishedKey[]).map((key) => {
    const sample = samples.find((each) => each.configuration.id === SAMPLE_CONFIGURATION_IDS[key]);
    const summary = sample?.versions.find((version) => version.publishedAt !== null);
    if (sample === undefined || summary === undefined) throw new Error(`The sample configuration ${key} has no published version.`);
    const version: PublishedVersion = {
      configurationId: sample.configuration.id,
      configurationName: sample.configuration.name,
      versionId: summary.id,
      versionNumber: summary.versionNumber,
      versionLabel: summary.label,
      collectorDistribution: sample.configuration.collectorDistribution,
      collectorVersion: summary.collectorVersion,
    };
    return [key, { publishedVersionId: PUBLICATIONS[key].id, sha256: PUBLICATIONS[key].sha256, version }] as const;
  });
  return Object.fromEntries(entries) as Record<PublishedKey, Published>;
}

// ---------------------------------------------------------------------------
// What each fleet holds.

type Actor = NonNullable<FleetDetail["createdBy"]>;
const YOU: Actor = { userId: SAMPLE_VISITOR.userId, email: SAMPLE_VISITOR.email };
const SRE: Actor = { userId: SAMPLE_SRE.userId, email: SAMPLE_SRE.email };

/** One collector: where it is, what resolves for it, what it runs and what it reported. */
interface CollectorSpec {
  number: number;
  name: string;
  groupId: string;
  /** Its own pin, else its group's assignment resolves. */
  pin?: PublishedKey;
  /** What it was last served; none for a collector not yet delivered one. */
  served: PublishedKey | null;
  /** Its last apply: none, applied, or failed with the collector's own words. */
  effective: "applied" | { failed: string; ago: number } | null;
  drift: Collector["drift"];
  createdAgo: number;
  lastSeenAgo: number;
  collectorVersion: string | null;
  ip: string | null;
  hostIp: string | null;
  attributes: Record<string, string>;
  token: string;
  /** When it was last served (or applied). */
  servedAgo: number;
}

interface GroupSpec {
  id: string;
  name: string;
  isDefault: boolean;
  assigned: PublishedKey | null;
  annotations: Record<string, unknown> | null;
  createdAgo: number;
  updatedAgo: number;
}

interface TokenSpec {
  id: string;
  kind: EnrollmentTokenListed["kind"];
  createdAgo: number;
  /** Ahead of now (positive) or behind it (negative); null for never. */
  expiresIn: number | null;
  revokedAgo: number | null;
  doRefresh: boolean;
  createdBy: Actor;
}

interface EventSpec {
  number: number;
  token: string;
  event: EnrollmentTokenEvent["event"];
  actor: Actor | null;
  ago: number;
}

interface LinkSpec {
  number: number;
  groupId: string;
  groupName: string;
  defaultTokenId: string;
  createdBy: Actor;
  choices: QuickDeployLinkChoices;
  createdAgo: number;
  expiresIn: number | null;
  revokedAgo: number | null;
  downloadCount: number;
  lastDownloadedAgo: number | null;
}

interface ErrorSpec {
  number: number;
  ago: number;
  configuration: PublishedKey | null;
  message: string;
}

interface FleetSpec {
  id: string;
  label: string;
  type: FleetType;
  createdBy: Actor;
  createdAgo: number;
  updatedAgo: number;
  groups: GroupSpec[];
  collectors: CollectorSpec[];
  tokens: TokenSpec[];
  events: EventSpec[];
  links: LinkSpec[];
  errors: Record<number, ErrorSpec[]>;
}

const SECOND = 1000;

/** A server collector's host attributes. */
function host(name: string): Record<string, string> {
  return { "host.name": name, "os.type": "linux" };
}

/** A Kubernetes collector's attributes: its node (configuration text, shown inside `ph-no-capture`), namespace and pod. */
function pod(node: string, namespace: string, podName: string): Record<string, string> {
  return { "k8s.node.name": node, "k8s.namespace.name": namespace, "k8s.pod.name": podName };
}

/** A Kubernetes group's settings under the platform's annotations key. */
function kubernetes(settings: Record<string, unknown>): Record<string, unknown> {
  return { telflo: { kubernetes: settings } };
}

/** brave-falcon's failure: the collector's own text (configuration text). */
const TAILSAMPLING_ERROR =
  'error decoding \'processors\': unknown type "tailsampling" for id "tailsampling" (valid values: [batch memory_limiter attributes resource transform filter ...])';
const EXPORTER_ERROR =
  'cannot start pipelines: failed to start "otlphttp" exporter: Post "https://otlp-gateway.acme.example/otlp/v1/logs": context deadline exceeded';

/** The prod fleet's healthy cohort (collectors 5 to 9): in sync on the gateway, seen within the minute. */
const PROD_COHORT = [
  { number: 5, name: "keen-otter", host: "gw-east-05", seen: 18, group: SAMPLE_GROUP_IDS.prodDefault, runs: "gateway" },
  { number: 6, name: "swift-heron", host: "gw-east-06", seen: 31, group: SAMPLE_GROUP_IDS.prodDefault, runs: "gateway" },
  { number: 7, name: "calm-cedar", host: "gw-east-07", seen: 24, group: SAMPLE_GROUP_IDS.prodDefault, runs: "gateway" },
  { number: 8, name: "bright-finch", host: "gw-east-08", seen: 45, group: SAMPLE_GROUP_IDS.prodCanary, runs: "cost" },
  { number: 9, name: "noble-ibex", host: "gw-east-09", seen: 12, group: SAMPLE_GROUP_IDS.prodCanary, runs: "cost" },
] as const;

const FLEETS: readonly FleetSpec[] = [
  {
    id: SAMPLE_FLEET_IDS.prod,
    label: "prod-us-east",
    type: "server",
    createdBy: YOU,
    createdAgo: 45 * DAY,
    updatedAgo: 2 * HOUR,
    groups: [
      {
        id: SAMPLE_GROUP_IDS.prodDefault,
        name: "Default",
        isDefault: true,
        assigned: "gateway",
        annotations: null,
        createdAgo: 45 * DAY,
        updatedAgo: 3 * DAY,
      },
      {
        id: SAMPLE_GROUP_IDS.prodCanary,
        name: "canary",
        isDefault: false,
        assigned: "cost",
        annotations: { telflo: { dockerMounts: [{ hostPath: "/var/log/acme", containerPath: "/var/log/acme", readOnly: true }] } },
        createdAgo: 12 * DAY,
        updatedAgo: 2 * DAY,
      },
    ],
    collectors: [
      {
        // Healthy: in sync, fresh heartbeat.
        number: 1,
        name: "loving-tortoise",
        groupId: SAMPLE_GROUP_IDS.prodDefault,
        served: "gateway",
        effective: "applied",
        drift: "inSync",
        createdAgo: 40 * DAY,
        lastSeenAgo: 25 * SECOND,
        collectorVersion: "0.161.0",
        ip: "198.51.100.23",
        hostIp: "192.0.2.23",
        attributes: host("gw-east-01"),
        token: TOKENS.prodRotate,
        servedAgo: 3 * DAY,
      },
      {
        // The apply failed (the details' error history), on an older collector binary.
        number: 2,
        name: "brave-falcon",
        groupId: SAMPLE_GROUP_IDS.prodDefault,
        served: "gateway",
        effective: { failed: TAILSAMPLING_ERROR, ago: 59 * MINUTE },
        drift: "failed",
        createdAgo: 30 * DAY,
        lastSeenAgo: 90 * SECOND,
        collectorVersion: "0.159.0",
        ip: "198.51.100.77",
        hostIp: "192.0.2.77",
        attributes: host("gw-east-02"),
        token: TOKENS.prodRotate,
        servedAgo: HOUR,
      },
      {
        // Just connected: not yet running its group's published version.
        number: 3,
        name: "quiet-meadow",
        groupId: SAMPLE_GROUP_IDS.prodDefault,
        served: null,
        effective: null,
        drift: "pending",
        createdAgo: 20 * MINUTE,
        lastSeenAgo: 40 * SECOND,
        collectorVersion: "0.161.0",
        ip: "198.51.100.14",
        hostIp: "192.0.2.14",
        attributes: host("gw-east-03"),
        token: TOKENS.prodDefault,
        servedAgo: 20 * MINUTE,
      },
      {
        // Pinned to the canary's filters, then gone quiet: its token was revoked.
        number: 4,
        name: "wandering-comet",
        groupId: SAMPLE_GROUP_IDS.prodDefault,
        pin: "cost",
        served: "cost",
        effective: "applied",
        drift: "inSync",
        createdAgo: 15 * DAY,
        lastSeenAgo: 3 * HOUR,
        collectorVersion: "0.161.0",
        ip: "198.51.100.4",
        hostIp: "192.0.2.4",
        attributes: host("gw-east-04"),
        token: TOKENS.prodRotateOld,
        servedAgo: 2 * DAY,
      },
      ...PROD_COHORT.map(
        (row): CollectorSpec => ({
          number: row.number,
          name: row.name,
          groupId: row.group,
          served: row.runs,
          effective: "applied",
          drift: "inSync",
          createdAgo: 38 * DAY,
          lastSeenAgo: row.seen * SECOND,
          collectorVersion: "0.161.0",
          ip: `198.51.100.${row.number * 10}`,
          hostIp: `192.0.2.${row.number * 10}`,
          attributes: host(row.host),
          token: TOKENS.prodRotate,
          servedAgo: row.runs === "cost" ? 2 * DAY : 3 * DAY,
        }),
      ),
    ],
    tokens: [
      { id: TOKENS.prodRotate, kind: "rotate", createdAgo: 20 * DAY, expiresIn: 70 * DAY, revokedAgo: null, doRefresh: false, createdBy: YOU },
      {
        id: TOKENS.prodRotateOld,
        kind: "rotate",
        createdAgo: 45 * DAY,
        expiresIn: 45 * DAY,
        revokedAgo: 170 * MINUTE,
        doRefresh: true,
        createdBy: YOU,
      },
      { id: TOKENS.prodDefault, kind: "default", createdAgo: 45 * DAY, expiresIn: null, revokedAgo: null, doRefresh: false, createdBy: YOU },
    ],
    events: [
      { number: 7, token: TOKENS.prodRotateOld, event: "revoked", actor: SRE, ago: 170 * MINUTE },
      { number: 6, token: TOKENS.prodDefault, event: "viewed", actor: YOU, ago: 10 * DAY },
      { number: 5, token: TOKENS.prodRotate, event: "issued", actor: YOU, ago: 20 * DAY },
      { number: 4, token: TOKENS.prodRotateOld, event: "rotated", actor: YOU, ago: 20 * DAY },
      { number: 3, token: TOKENS.prodDefault, event: "viewed", actor: YOU, ago: 40 * DAY },
      { number: 2, token: TOKENS.prodRotateOld, event: "issued", actor: YOU, ago: 45 * DAY },
      { number: 1, token: TOKENS.prodDefault, event: "issued", actor: YOU, ago: 45 * DAY },
    ],
    links: [
      {
        number: 2,
        groupId: SAMPLE_GROUP_IDS.prodDefault,
        groupName: "Default",
        defaultTokenId: TOKENS.prodDefault,
        createdBy: YOU,
        choices: { method: "all-in-one", arch: "amd64", rootPath: "/opt/telflo", executablePath: null, systemd: true, envNames: [] },
        createdAgo: 10 * DAY,
        expiresIn: 20 * DAY,
        revokedAgo: null,
        downloadCount: 3,
        lastDownloadedAgo: 8 * DAY,
      },
      {
        number: 1,
        groupId: SAMPLE_GROUP_IDS.prodCanary,
        groupName: "canary",
        defaultTokenId: TOKENS.prodDefault,
        createdBy: SRE,
        choices: {
          method: "own-binary",
          arch: "arm64",
          rootPath: "/opt/telflo",
          executablePath: "/usr/local/bin/otelcol-contrib",
          systemd: true,
          envNames: [],
        },
        createdAgo: 12 * DAY,
        expiresIn: -2 * DAY,
        revokedAgo: null,
        downloadCount: 1,
        lastDownloadedAgo: 12 * DAY,
      },
    ],
    errors: {
      2: [
        { number: 2, ago: 59 * MINUTE, configuration: "gateway", message: TAILSAMPLING_ERROR },
        { number: 1, ago: 26 * HOUR, configuration: "gateway", message: EXPORTER_ERROR },
      ],
    },
  },
  {
    id: SAMPLE_FLEET_IDS.staging,
    label: "staging-eu",
    type: "server",
    createdBy: SRE,
    createdAgo: 10 * DAY,
    updatedAgo: HOUR,
    groups: [
      {
        id: SAMPLE_GROUP_IDS.stagingDefault,
        name: "Default",
        isDefault: true,
        assigned: "hostMetrics",
        // A Docker install: the host's logs mounted read-only.
        annotations: { telflo: { dockerMounts: [{ hostPath: "/var/log", containerPath: "/var/log/host", readOnly: true }] } },
        createdAgo: 10 * DAY,
        updatedAgo: 9 * DAY,
      },
    ],
    collectors: [
      {
        number: 101,
        name: "gentle-harbor",
        groupId: SAMPLE_GROUP_IDS.stagingDefault,
        served: "hostMetrics",
        effective: "applied",
        drift: "inSync",
        createdAgo: 10 * DAY,
        lastSeenAgo: 35 * SECOND,
        collectorVersion: "0.160.0",
        ip: "203.0.113.101",
        hostIp: "192.0.2.101",
        attributes: host("stg-eu-01"),
        token: TOKENS.stagingRotate,
        servedAgo: 9 * DAY,
      },
      {
        // Still on the token being replaced: it moves to the new one before the grace ends.
        number: 102,
        name: "amber-summit",
        groupId: SAMPLE_GROUP_IDS.stagingDefault,
        served: "hostMetrics",
        effective: "applied",
        drift: "inSync",
        createdAgo: 8 * DAY,
        lastSeenAgo: 45 * SECOND,
        collectorVersion: "0.160.0",
        ip: "203.0.113.102",
        hostIp: "192.0.2.102",
        attributes: host("stg-eu-02"),
        token: TOKENS.stagingRotateOld,
        servedAgo: 8 * DAY,
      },
    ],
    tokens: [
      { id: TOKENS.stagingRotate, kind: "rotate", createdAgo: 2 * DAY, expiresIn: 20 * DAY, revokedAgo: null, doRefresh: false, createdBy: SRE },
      { id: TOKENS.stagingRotateOld, kind: "rotate", createdAgo: 10 * DAY, expiresIn: 2 * DAY, revokedAgo: null, doRefresh: true, createdBy: SRE },
      { id: TOKENS.stagingDefault, kind: "default", createdAgo: 10 * DAY, expiresIn: null, revokedAgo: null, doRefresh: false, createdBy: SRE },
    ],
    events: [
      { number: 14, token: TOKENS.stagingRotate, event: "issued", actor: SRE, ago: 2 * DAY },
      { number: 13, token: TOKENS.stagingRotateOld, event: "rotated", actor: SRE, ago: 2 * DAY },
      { number: 12, token: TOKENS.stagingDefault, event: "viewed", actor: SRE, ago: 10 * DAY - HOUR },
      { number: 11, token: TOKENS.stagingRotateOld, event: "issued", actor: SRE, ago: 10 * DAY },
      { number: 10, token: TOKENS.stagingDefault, event: "issued", actor: SRE, ago: 10 * DAY },
    ],
    links: [],
    errors: {},
  },
  {
    // "Import existing configuration", two hours on: the first collector's running text became
    // "edge-import-pilot (imported)", which all three edge boxes now run.
    id: SAMPLE_FLEET_IDS.edgeImport,
    label: "edge-import-pilot",
    type: "server",
    createdBy: YOU,
    createdAgo: 2 * HOUR,
    updatedAgo: 20 * SECOND,
    groups: [
      {
        id: SAMPLE_GROUP_IDS.importDefault,
        name: "Default",
        isDefault: true,
        assigned: "import",
        annotations: null,
        createdAgo: 2 * HOUR,
        updatedAgo: 2 * HOUR - 5 * MINUTE,
      },
    ],
    collectors: (
      [
        { number: 201, name: "rustic-pond", host: "edge-lon-01", seen: 22 },
        { number: 202, name: "mellow-drift", host: "edge-fra-02", seen: 37 },
        { number: 203, name: "harbor-glint", host: "edge-nyc-03", seen: 51 },
      ] as const
    ).map(
      (row): CollectorSpec => ({
        number: row.number,
        name: row.name,
        groupId: SAMPLE_GROUP_IDS.importDefault,
        served: "import",
        effective: "applied",
        drift: "inSync",
        createdAgo: 2 * HOUR - (row.number - 201) * MINUTE,
        lastSeenAgo: row.seen * SECOND,
        collectorVersion: "0.162.0",
        ip: `203.0.113.${row.number - 150}`,
        hostIp: null,
        attributes: host(row.host),
        token: TOKENS.importRotate,
        servedAgo: 2 * HOUR - 3 * MINUTE,
      }),
    ),
    tokens: [
      { id: TOKENS.importRotate, kind: "rotate", createdAgo: 2 * HOUR, expiresIn: 60 * DAY, revokedAgo: null, doRefresh: false, createdBy: YOU },
      { id: TOKENS.importDefault, kind: "default", createdAgo: 2 * HOUR, expiresIn: null, revokedAgo: null, doRefresh: false, createdBy: YOU },
    ],
    events: [
      { number: 22, token: TOKENS.importDefault, event: "viewed", actor: YOU, ago: 2 * HOUR - 2 * MINUTE },
      { number: 21, token: TOKENS.importRotate, event: "issued", actor: YOU, ago: 2 * HOUR },
      { number: 20, token: TOKENS.importDefault, event: "issued", actor: YOU, ago: 2 * HOUR },
    ],
    links: [],
    errors: {},
  },
  {
    // The Kubernetes fleet: the Agent on every node, the Cluster, and two gateway pools.
    id: SAMPLE_FLEET_IDS.kubernetes,
    label: "k8s-prod-us-west",
    type: "kubernetes-supervisor",
    createdBy: YOU,
    createdAgo: 21 * DAY,
    updatedAgo: 20 * SECOND,
    groups: [
      {
        id: SAMPLE_GROUP_IDS.kubernetesAgent,
        name: "Default",
        isDefault: true,
        assigned: "k8sNode",
        annotations: kubernetes({
          role: "node",
          namespace: "observability",
          volumes: [{ hostPath: "/var/lib/otelcol", hostPathType: "DirectoryOrCreate", mountPath: "/var/lib/otelcol", readOnly: false }],
        }),
        createdAgo: 21 * DAY,
        updatedAgo: 8 * DAY,
      },
      {
        id: SAMPLE_GROUP_IDS.kubernetesCluster,
        name: "cluster",
        isDefault: false,
        assigned: null,
        annotations: kubernetes({ role: "cluster", namespace: "observability", volumes: [] }),
        createdAgo: 21 * DAY,
        updatedAgo: 21 * DAY,
      },
      {
        id: SAMPLE_GROUP_IDS.kubernetesGateway,
        name: "otel-gateway",
        isDefault: false,
        assigned: "gateway",
        annotations: kubernetes({ role: "gateway", namespace: "observability", replicas: 2, volumes: [] }),
        createdAgo: 20 * DAY,
        updatedAgo: 3 * DAY,
      },
      {
        id: SAMPLE_GROUP_IDS.kubernetesPayments,
        name: "payments",
        isDefault: false,
        assigned: "pii",
        annotations: kubernetes({ role: "gateway", namespace: "payments", replicas: 1, volumes: [] }),
        createdAgo: 15 * DAY,
        updatedAgo: 7 * DAY,
      },
    ],
    collectors: [
      {
        // The node agent on the Agent's published version, in sync.
        number: 301,
        name: "node-agent",
        groupId: SAMPLE_GROUP_IDS.kubernetesAgent,
        served: "k8sNode",
        effective: "applied",
        drift: "inSync",
        createdAgo: 21 * DAY,
        lastSeenAgo: 25 * SECOND,
        collectorVersion: "0.161.0",
        ip: "203.0.113.12",
        hostIp: null,
        attributes: pod("node-usw2-a", "observability", "node-agent-7f9c2"),
        token: TOKENS.kubernetesRotate,
        servedAgo: 8 * DAY,
      },
      {
        // The gateway pool's collector: its binary lags the version its configuration is built for.
        number: 302,
        name: "otel-gateway",
        groupId: SAMPLE_GROUP_IDS.kubernetesGateway,
        served: "gateway",
        effective: "applied",
        drift: "inSync",
        createdAgo: 20 * DAY,
        lastSeenAgo: 18 * SECOND,
        collectorVersion: "0.160.0",
        ip: "203.0.113.20",
        hostIp: null,
        attributes: pod("node-usw2-b", "observability", "otel-gateway-0"),
        token: TOKENS.kubernetesRotate,
        servedAgo: 3 * DAY,
      },
      {
        // The payments pool masks PII before anything leaves it.
        number: 303,
        name: "payments-agent",
        groupId: SAMPLE_GROUP_IDS.kubernetesPayments,
        served: "pii",
        effective: "applied",
        drift: "inSync",
        createdAgo: 15 * DAY,
        lastSeenAgo: 40 * SECOND,
        collectorVersion: "0.160.0",
        ip: "203.0.113.31",
        hostIp: null,
        attributes: pod("node-usw2-c", "payments", "payments-0"),
        token: TOKENS.kubernetesRotate,
        servedAgo: 7 * DAY,
      },
      {
        // On the Cluster, pinned to the PII configuration so checkout traffic is scrubbed.
        number: 304,
        name: "checkout-sidecar",
        groupId: SAMPLE_GROUP_IDS.kubernetesCluster,
        pin: "pii",
        served: "pii",
        effective: "applied",
        drift: "inSync",
        createdAgo: 9 * DAY,
        lastSeenAgo: 30 * SECOND,
        collectorVersion: "0.160.0",
        ip: "203.0.113.34",
        hostIp: null,
        attributes: pod("node-usw2-d", "observability", "telflo-cluster-0"),
        token: TOKENS.kubernetesRotate,
        servedAgo: 2 * DAY,
      },
      {
        // Seen minutes ago, not yet running the Agent's published version.
        number: 305,
        name: "staging-agent",
        groupId: SAMPLE_GROUP_IDS.kubernetesAgent,
        served: null,
        effective: null,
        drift: "pending",
        createdAgo: 6 * MINUTE,
        lastSeenAgo: 3 * MINUTE,
        collectorVersion: null,
        ip: "203.0.113.45",
        hostIp: null,
        attributes: pod("node-usw2-e", "observability", "node-agent-q2m8d"),
        token: TOKENS.kubernetesDefault,
        servedAgo: 6 * MINUTE,
      },
      {
        // In sync, but last heard from over a minute ago (a pod restarting).
        number: 306,
        name: "logging-agent",
        groupId: SAMPLE_GROUP_IDS.kubernetesAgent,
        served: "k8sNode",
        effective: "applied",
        drift: "inSync",
        createdAgo: 21 * DAY,
        lastSeenAgo: 75 * SECOND,
        collectorVersion: "0.161.0",
        ip: "203.0.113.41",
        hostIp: null,
        attributes: pod("node-usw2-f", "logging", "node-agent-x7ktq"),
        token: TOKENS.kubernetesRotate,
        servedAgo: 8 * DAY,
      },
    ],
    tokens: [
      { id: TOKENS.kubernetesRotate, kind: "rotate", createdAgo: 21 * DAY, expiresIn: null, revokedAgo: null, doRefresh: false, createdBy: YOU },
      { id: TOKENS.kubernetesDefault, kind: "default", createdAgo: 21 * DAY, expiresIn: null, revokedAgo: null, doRefresh: false, createdBy: YOU },
    ],
    events: [
      { number: 33, token: TOKENS.kubernetesDefault, event: "viewed", actor: YOU, ago: 10 * DAY },
      { number: 32, token: TOKENS.kubernetesDefault, event: "viewed", actor: SRE, ago: 21 * DAY - 10 * MINUTE },
      { number: 31, token: TOKENS.kubernetesRotate, event: "issued", actor: YOU, ago: 21 * DAY },
      { number: 30, token: TOKENS.kubernetesDefault, event: "issued", actor: YOU, ago: 21 * DAY },
    ],
    links: [
      {
        number: 32,
        groupId: SAMPLE_GROUP_IDS.kubernetesAgent,
        groupName: "Default",
        defaultTokenId: TOKENS.kubernetesDefault,
        createdBy: YOU,
        choices: { kind: "helm", role: "node", release: "telflo-node", namespace: "observability", envNames: [] },
        createdAgo: 10 * DAY,
        expiresIn: 50 * DAY,
        revokedAgo: null,
        downloadCount: 3,
        lastDownloadedAgo: 8 * DAY,
      },
      {
        number: 31,
        groupId: SAMPLE_GROUP_IDS.kubernetesPayments,
        groupName: "payments",
        defaultTokenId: TOKENS.kubernetesDefault,
        createdBy: SRE,
        choices: { kind: "helm", role: "gateway", release: "payments", namespace: "payments", envNames: [] },
        createdAgo: 15 * DAY,
        expiresIn: 15 * DAY,
        revokedAgo: 12 * DAY,
        downloadCount: 1,
        lastDownloadedAgo: 15 * DAY - HOUR,
      },
    ],
    errors: {},
  },
];

// ---------------------------------------------------------------------------
// Building the API's shapes at `now`.

/** The server's liveness windows (`LIVENESS_MEANINGS`): online within a minute, warning within 2, unknown within 5, else offline. */
function livenessOf(lastSeenAgo: number): Collector["liveness"] {
  if (lastSeenAgo < MINUTE) return "online";
  if (lastSeenAgo < 2 * MINUTE) return "warning";
  if (lastSeenAgo < 5 * MINUTE) return "unknown";
  return "offline";
}

function buildCollector(spec: CollectorSpec, fleet: FleetSpec, published: Record<PublishedKey, Published>, clock: SampleClock): Collector {
  const group = fleet.groups.find((each) => each.id === spec.groupId);
  const pinned = spec.pin === undefined ? null : published[spec.pin];
  const assigned = group?.assigned === null || group === undefined ? null : published[group.assigned];
  const resolved = pinned ?? assigned;
  const served = spec.served === null ? null : published[spec.served];
  const effective =
    spec.effective === null || served === null
      ? null
      : spec.effective === "applied"
        ? { sha256: served.sha256, status: "applied" as const, error: null, at: clock.ago(spec.servedAgo - MINUTE) }
        : { sha256: served.sha256, status: "failed" as const, error: spec.effective.failed, at: clock.ago(spec.effective.ago) };
  return {
    id: collectorId(spec.number),
    instanceUid: instanceUid(spec.number),
    name: spec.name,
    fleetId: fleet.id,
    groupId: spec.groupId,
    pin: pinned === null ? null : { kind: "version", versionId: pinned.version.versionId, publishedVersionId: pinned.publishedVersionId, version: pinned.version },
    pinnedVariableGroupId: null,
    resolution:
      resolved === null
        ? null
        : {
            from: pinned !== null ? "pinnedVersion" : "groupVersion",
            publishedVersionId: resolved.publishedVersionId,
            sha256: resolved.sha256,
            version: resolved.version,
          },
    served:
      served === null
        ? null
        : { kind: "version", publishedVersionId: served.publishedVersionId, sha256: served.sha256, at: clock.ago(spec.servedAgo), version: served.version },
    effective,
    reported: { collectorVersion: spec.collectorVersion, ip: spec.ip, hostIp: spec.hostIp, attributes: spec.attributes },
    enrollmentTokenId: spec.token,
    lastSeenAt: clock.ago(spec.lastSeenAgo),
    liveness: livenessOf(spec.lastSeenAgo),
    drift: spec.drift,
    createdAt: clock.ago(spec.createdAgo),
    updatedAt: clock.ago(Math.min(spec.createdAgo, spec.servedAgo)),
  };
}

function buildGroup(spec: GroupSpec, fleet: FleetSpec, published: Record<PublishedKey, Published>, clock: SampleClock): CollectorGroup {
  const assigned = spec.assigned === null ? null : published[spec.assigned];
  return {
    id: spec.id,
    fleetId: fleet.id,
    name: spec.name,
    isDefault: spec.isDefault,
    annotations: spec.annotations,
    assignedPublishedVersionId: assigned?.publishedVersionId ?? null,
    assignedVersion: assigned?.version ?? null,
    variableGroupId: null,
    createdAt: clock.ago(spec.createdAgo),
    updatedAt: clock.ago(spec.updatedAgo),
  };
}

/** When `spec` expires, at `now`; null for never. */
function expiry(expiresIn: number | null, clock: SampleClock): string | null {
  if (expiresIn === null) return null;
  return expiresIn >= 0 ? clock.ahead(expiresIn) : clock.ago(-expiresIn);
}

/** A token is valid while it is neither revoked nor past its expiry. */
function validToken(spec: TokenSpec): boolean {
  return spec.revokedAgo === null && (spec.expiresIn === null || spec.expiresIn > 0);
}

/** The collectors seen on each token in the last 5 minutes, as `activeCollectors` counts them. */
function activeOn(fleet: FleetSpec, token: string): number {
  return fleet.collectors.filter((collector) => collector.token === token && collector.lastSeenAgo < 5 * MINUTE).length;
}

function buildToken(spec: TokenSpec, fleet: FleetSpec, clock: SampleClock): EnrollmentTokenListed {
  return {
    id: spec.id,
    fleetId: fleet.id,
    kind: spec.kind,
    expiresAt: expiry(spec.expiresIn, clock),
    revokedAt: spec.revokedAgo === null ? null : clock.ago(spec.revokedAgo),
    doRefresh: spec.doRefresh,
    createdBy: spec.createdBy,
    createdAt: clock.ago(spec.createdAgo),
    activeCollectors: activeOn(fleet, spec.id),
  };
}

function buildLink(spec: LinkSpec, clock: SampleClock): QuickDeployLink {
  const status: QuickDeployLink["status"] =
    spec.revokedAgo !== null ? "revoked" : spec.expiresIn !== null && spec.expiresIn <= 0 ? "expired" : "active";
  return {
    id: linkId(spec.number),
    groupId: spec.groupId,
    groupName: spec.groupName,
    defaultTokenId: spec.defaultTokenId,
    createdBy: spec.createdBy,
    choices: spec.choices,
    createdAt: clock.ago(spec.createdAgo),
    expiresAt: expiry(spec.expiresIn, clock),
    revokedAt: spec.revokedAgo === null ? null : clock.ago(spec.revokedAgo),
    downloadCount: spec.downloadCount,
    lastDownloadedAt: spec.lastDownloadedAgo === null ? null : clock.ago(spec.lastDownloadedAgo),
    status,
  };
}

/** The fleet's summary, counted from its collectors and tokens as the server counts it. */
function summaryOf(fleet: FleetSpec, collectors: readonly Collector[], clock: SampleClock): FleetSummary {
  const count = (test: (collector: Collector) => boolean) => collectors.filter(test).length;
  const rotate = fleet.tokens.filter((token) => token.kind === "rotate" && validToken(token));
  const current = rotate.find((token) => !token.doRefresh) ?? null;
  const inGrace = rotate.filter((token) => token !== current);
  const graceEnds = inGrace.map((token) => token.expiresIn).filter((value): value is number => value !== null);
  const lastSeenAgo = Math.min(...fleet.collectors.map((collector) => collector.lastSeenAgo));
  return {
    collectors: collectors.length,
    online: count((collector) => collector.liveness === "online"),
    warning: count((collector) => collector.liveness === "warning"),
    unknown: count((collector) => collector.liveness === "unknown"),
    offline: count((collector) => collector.liveness === "offline"),
    inSync: count((collector) => collector.drift === "inSync"),
    pending: count((collector) => collector.drift === "pending"),
    failed: count((collector) => collector.drift === "failed"),
    drifted: count((collector) => collector.drift === "drifted"),
    unassigned: count((collector) => collector.drift === "unassigned"),
    lastSeenAt: collectors.length === 0 ? null : clock.ago(lastSeenAgo),
    rotateToken:
      rotate.length === 0
        ? null
        : {
            expiresAt: current === null ? null : expiry(current.expiresIn, clock),
            graceEndsAt: graceEnds.length === 0 ? null : expiry(Math.max(...graceEnds), clock),
            validCount: rotate.length,
          },
  };
}

/** One sample fleet with everything its page reads. */
export interface SampleFleet {
  fleet: FleetDetail;
  /** The Default group first, then by name, as the API orders them. */
  groups: CollectorGroup[];
  /** Newest first, as the API's default order. */
  collectors: Collector[];
  /** Each collector's error history, newest first, by the collector's id. */
  errors: Record<string, CollectorError[]>;
  /** Newest first. */
  tokens: EnrollmentTokenListed[];
  /** Newest first. */
  events: EnrollmentTokenEvent[];
  /** Newest first. */
  links: QuickDeployLink[];
}

/** The fleets sample's data, for sample.test.ts' checks over the whole sample and fleets.test.ts' shapes. */
export interface SampleFleets {
  /** Newest first, as the list orders them. */
  fleets: SampleFleet[];
}

const newestFirst = <Item extends { createdAt: string }>(items: Item[]) => items.sort((one, other) => other.createdAt.localeCompare(one.createdAt));

function buildFleet(spec: FleetSpec, published: Record<PublishedKey, Published>, clock: SampleClock): SampleFleet {
  const collectors = newestFirst(spec.collectors.map((each) => buildCollector(each, spec, published, clock)));
  const groups = spec.groups
    .map((each) => buildGroup(each, spec, published, clock))
    .sort((one, other) => Number(other.isDefault) - Number(one.isDefault) || one.name.localeCompare(other.name));
  const errors = Object.fromEntries(
    Object.entries(spec.errors).map(([number, list]) => [
      collectorId(Number(number)),
      list.map(
        (each): CollectorError => ({
          id: errorId(each.number),
          reportedAt: clock.ago(each.ago),
          configSha256: each.configuration === null ? null : published[each.configuration].sha256,
          message: each.message,
        }),
      ),
    ]),
  );
  return {
    fleet: {
      id: spec.id,
      label: spec.label,
      type: spec.type,
      status: "active",
      createdBy: spec.createdBy,
      createdAt: clock.ago(spec.createdAgo),
      updatedAt: clock.ago(spec.updatedAgo),
      summary: summaryOf(spec, collectors, clock),
    },
    groups,
    collectors,
    errors,
    tokens: newestFirst(spec.tokens.map((each) => buildToken(each, spec, clock))),
    events: spec.events.map((each) => ({
      id: eventId(each.number),
      tokenId: each.token,
      event: each.event,
      actor: each.actor,
      occurredAt: clock.ago(each.ago),
    })),
    links: newestFirst(spec.links.map((each) => buildLink(each, clock))),
  };
}

/** The fleets sample, with times relative to `now`. */
export function sampleFleets(now: number = Date.now()): SampleFleets {
  const clock = clockAt(now);
  const published = publishedVersions(now);
  const fleets = FLEETS.map((spec) => buildFleet(spec, published, clock));
  return { fleets: fleets.sort((one, other) => other.fleet.createdAt.localeCompare(one.fleet.createdAt)) };
}

// ---------------------------------------------------------------------------
// The reads.

const fleetNotFound = () => sampleNotFound("fleet_not_found", "Fleet not found");
const collectorNotFound = () => sampleNotFound("collector_not_found", "Collector not found");

/** The sample fleet `fleetId` names (as the API reads ids, in either case), rebuilt now; the API's 404 otherwise. */
function fleetAt(fleetId: string): SampleFleet {
  const found = sampleFleets().fleets.find((each) => each.fleet.id === fleetId.toLowerCase());
  if (found === undefined) throw fleetNotFound();
  return found;
}

/** A page of `items` at `cursor` (an offset of the sample's own: one page holds every sample list). */
function pageOf<Item>(items: readonly Item[], limit = 50, cursor?: string): { items: Item[]; nextCursor: string | null } {
  const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  const from = Number.isFinite(start) && start > 0 ? start : 0;
  const end = from + limit;
  return { items: items.slice(from, end), nextCursor: end < items.length ? String(end) : null };
}

/** The collector list's search, as the API's `q`: a name or an address it contains, ignoring case. */
function matches(collector: Collector, q: string | undefined): boolean {
  const query = (q ?? "").trim().toLowerCase();
  if (query === "") return true;
  return [collector.name, collector.reported.ip ?? "", collector.reported.hostIp ?? ""].some((text) => text.toLowerCase().includes(query));
}

/** The collector list's sort: newest first by default; else by name, last seen or creation, in the order asked. */
function sorted(collectors: Collector[], sort: "created" | "lastSeen" | "name" | undefined, order: "asc" | "desc" | undefined): Collector[] {
  const key = sort ?? "created";
  const direction = (order ?? (sort === undefined ? "desc" : "asc")) === "asc" ? 1 : -1;
  const valueOf = (collector: Collector) => (key === "name" ? collector.name : key === "lastSeen" ? collector.lastSeenAt : collector.createdAt);
  return [...collectors].sort((one, other) => direction * valueOf(one).localeCompare(valueOf(other)) || one.id.localeCompare(other.id));
}

/**
 * Fleet management's reads under the sample (`readsFor(SAMPLE_ORGANIZATION_ID)`),
 * each rebuilding the sample at the moment it is asked, so a poll finds
 * "last seen" as fresh as the collectors' heartbeats would keep it. Search,
 * the group filter, the sort and the status filter apply in the browser, as
 * the API applies them; an id the sample doesn't hold answers the API's own
 * 404, so the page shows its own "not found".
 */
export const SAMPLE_FLEET_READS: FleetReads = {
  getFleets: async (_organizationId, query = {}) => {
    const fleets = sampleFleets()
      .fleets.map((each) => each.fleet)
      .filter((fleet) => query.status === undefined || fleet.status === query.status);
    const { items, nextCursor } = pageOf(fleets, query.limit, query.cursor);
    return { fleets: items, nextCursor };
  },
  getFleet: async (_organizationId, fleetId) => fleetAt(fleetId).fleet,
  getCollectors: async (_organizationId, fleetId, query = {}) => {
    const { collectors } = fleetAt(fleetId);
    const listed = sorted(
      collectors.filter((collector) => matches(collector, query.q) && (query.groupId === undefined || collector.groupId === query.groupId.toLowerCase())),
      query.sort,
      query.order,
    );
    const { items, nextCursor } = pageOf(listed, query.limit, query.cursor);
    return { collectors: items, nextCursor };
  },
  getCollector: async (_organizationId, fleetId, collectorIdAsked) => {
    const found = fleetAt(fleetId).collectors.find((collector) => collector.id === collectorIdAsked.toLowerCase());
    if (found === undefined) throw collectorNotFound();
    return found;
  },
  getCollectorErrors: async (_organizationId, fleetId, collectorIdAsked, query = {}) => {
    const fleet = fleetAt(fleetId);
    const id = collectorIdAsked.toLowerCase();
    if (!fleet.collectors.some((collector) => collector.id === id)) throw collectorNotFound();
    const { items, nextCursor } = pageOf(fleet.errors[id] ?? [], query.limit, query.cursor);
    return { errors: items, nextCursor };
  },
  getCollectorGroups: async (_organizationId, fleetId) => ({ groups: fleetAt(fleetId).groups }),
  getEnrollmentTokens: async (_organizationId, fleetId) => ({ tokens: fleetAt(fleetId).tokens }),
  getEnrollmentTokenEvents: async (_organizationId, fleetId, query = {}) => {
    const { items, nextCursor } = pageOf(fleetAt(fleetId).events, query.limit, query.cursor);
    return { events: items, nextCursor };
  },
  getQuickDeployLinks: async (_organizationId, fleetId, query = {}) => {
    const { items, nextCursor } = pageOf(fleetAt(fleetId).links, query.limit, query.cursor);
    return { links: items, nextCursor };
  },
};
