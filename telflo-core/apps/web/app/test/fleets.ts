import { act, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { DEFAULT_HELM_CHART_REFERENCE, DEFAULT_HELM_CHART_VERSION } from "@telflo/contracts";
import type {
  Collector,
  CollectorError,
  CollectorGroup,
  CollectorsPage,
  ConfigurationVersionListItem,
  DockerMount,
  EnrollmentTokenEvent,
  EnrollmentTokenEventsPage,
  EnrollmentTokenListed,
  Fleet,
  FleetCreatedResponse,
  FleetDetail,
  FleetSummary,
  FleetsPage,
  CreateQuickDeployLinkResponse,
  HelmInstallFacts,
  InstallFacts,
  KubernetesAnnotations,
  PublishedVersion,
  QuickDeployLink,
  QuickDeployLinksPage,
} from "@telflo/contracts";

import * as apiClient from "~/lib/api-client.js";
import { answerFor, THEIRS, versionFixture } from "~/test/configurations.js";

/** The fleet screens' fixtures: ids, a fleet as each reply carries it, and pages of them. */

export const FLEET_ID = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";
export const DEFAULT_TOKEN_ID = "1b2c3d4e-5f60-4172-8839-4a5b6c7d8e9f";
export const ROTATE_TOKEN_ID = "2c3d4e5f-6071-4283-994a-5b6c7d8e9fa0";
export const DEFAULT_GROUP_ID = "3d4e5f60-7182-4394-aa5b-6c7d8e9fa0b1";
export const CREATOR = { userId: "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a", email: "member@example.com" };

/** A fleet with no collectors and a rotate token that never expires. */
export const EMPTY_SUMMARY: FleetSummary = {
  collectors: 0,
  online: 0,
  warning: 0,
  unknown: 0,
  offline: 0,
  inSync: 0,
  pending: 0,
  failed: 0,
  drifted: 0,
  unassigned: 0,
  lastSeenAt: null,
  rotateToken: { expiresAt: null, graceEndsAt: null, validCount: 1 },
};

const DAY_MS = 86_400_000;

/**
 * A fleet with collectors in every liveness and drift state, seen 5 seconds
 * before `now`, rotating (a replaced token in its grace) towards a token
 * expiring in 20 days: every cell of its row has its tooltip trigger.
 */
export function populatedSummary(now: number): FleetSummary {
  return {
    collectors: 10,
    online: 4,
    warning: 3,
    unknown: 2,
    offline: 1,
    inSync: 4,
    pending: 3,
    failed: 1,
    drifted: 1,
    unassigned: 1,
    lastSeenAt: new Date(now - 5_000).toISOString(),
    rotateToken: {
      expiresAt: new Date(now + 20 * DAY_MS).toISOString(),
      graceEndsAt: new Date(now + 2 * DAY_MS).toISOString(),
      validCount: 2,
    },
  };
}

/** Fails, naming the element and attribute, if any attribute of any element under `root` holds `text`. */
export function expectNoAttributeHolds(text: string, root: Element = document.documentElement): void {
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of element.attributes) {
      expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toContain(text);
    }
  }
}

/**
 * Each attribute under `root` holding `text`, as "TAG name": for a check that
 * allows only one exception (an open Name input's `value`, which React writes
 * for a controlled input).
 */
export function attributesHolding(text: string, root: Element = document.documentElement): string[] {
  const holders: string[] = [];
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of element.attributes) {
      if (attribute.value.includes(text)) holders.push(`${element.tagName} ${attribute.name}`);
    }
  }
  return holders;
}

/**
 * Whether a string is anywhere in a value: its own text, any property's, or
 * any key's or value's of a Map or a Set (a dialog's typed env values are a
 * Map), however deep (DOM nodes and functions skipped).
 */
function holds(value: unknown, text: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes(text);
  if (value === null || typeof value !== "object" || value instanceof Node || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) return [...value].some(([key, each]) => holds(key, text, seen) || holds(each, text, seen));
  if (value instanceof Set) return [...value].some((each) => holds(each, text, seen));
  return Object.values(value).some((each) => holds(each, text, seen));
}

/**
 * Whether any component's state in the rendered trees under `root` holds
 * `text`: every hook's state of every function component (its objects',
 * arrays', Maps' and Sets' contents, however deep), read from React's
 * current fiber tree of each root rendered there (a closed dialog renders
 * no DOM, so its state is seen only here).
 */
export function anyStateHolds(text: string, root: Element = document.body): boolean {
  type Fiber = { child: Fiber | null; sibling: Fiber | null; memoizedState: unknown; stateNode: { current?: Fiber } | null };
  const containers = [root, ...root.querySelectorAll("*")].filter((element) => Object.keys(element).some((key) => key.startsWith("__reactContainer$")));
  expect(containers.length, "a React root under the element searched").toBeGreaterThan(0);
  for (const container of containers) {
    const rootKey = Object.keys(container).find((key) => key.startsWith("__reactContainer$"))!;
    // The root fiber the container was made with, whose root holds the current tree.
    const first = (container as unknown as Record<string, Fiber>)[rootKey]!;
    const stack: Fiber[] = [first.stateNode!.current!];
    while (stack.length > 0) {
      const fiber = stack.pop()!;
      let hook = fiber.memoizedState as { memoizedState: unknown; next: unknown } | null;
      while (hook !== null && typeof hook === "object" && "next" in hook) {
        if (holds(hook.memoizedState, text)) return true;
        hook = hook.next as typeof hook;
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
  }
  return false;
}

/**
 * Fails, naming where, unless `text` is shown only inside `ph-no-capture`:
 * a bearer shown only in `SecretCopyBox`, which session replay records
 * nothing of. The DOM twin of the browser tests'
 * `expectBearersOnlyInNoCapture` (`e2e/fleets.e2e.ts`). It fails when
 * - a text node under `root` (the whole page, dialogs' portals included,
 *   by default) holds `text` outside a `ph-no-capture` element;
 * - `root`'s text with every `ph-no-capture` subtree taken out holds it: the
 *   text split across text nodes outside, which no single node holds, while a
 *   whole copy sits inside (nothing is outside when `root` sits inside
 *   `ph-no-capture`, its own or an ancestor's);
 * - any attribute of `root` or an element under it holds `text`: a bearer
 *   has no attribute exception (unlike an open Name input's `value`), so
 *   an `aria-label`, a `title`, a `data-*` or an input's `value` holding
 *   it fails;
 * - `document.title` holds it;
 * - no text node inside `ph-no-capture` holds it: the text is absent, or
 *   split across text nodes, so the check would prove nothing.
 * Returns how many text nodes hold it (at least 1).
 */
export function expectTextOnlyInsideNoCapture(text: string, root: Element = document.body): number {
  let holding = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node.textContent ?? "").includes(text)) continue;
    holding += 1;
    expect(node.parentElement?.closest(".ph-no-capture") ?? null, `a text node holding ${text}`).not.toBeNull();
  }
  // The text outside, joined: a clone with every ph-no-capture subtree removed; none when root is
  // itself inside one (its own class, or an ancestor's).
  const outside = root.cloneNode(true) as Element;
  for (const each of outside.querySelectorAll(".ph-no-capture")) each.remove();
  const outsideText = root.closest(".ph-no-capture") !== null ? "" : (outside.textContent ?? "");
  expect(outsideText.includes(text), `${text} in the text outside ph-no-capture, split across nodes`).toBe(false);
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of element.attributes) {
      expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toContain(text);
    }
  }
  expect(document.title, "document.title").not.toContain(text);
  expect(holding, `text nodes inside ph-no-capture holding ${text}`).toBeGreaterThan(0);
  return holding;
}

/**
 * Radix's tooltip triggers: focusable elements it marks with `data-state`
 * and no role of their own. A Radix checkbox (`role="checkbox"`) or a
 * Select's trigger (`role="combobox"`) carries `data-state` too, and
 * opens no tooltip.
 */
export const TOOLTIP_TRIGGERS = "[data-state]:not([role])";

/**
 * Opens each tooltip under `root` in turn (`TOOLTIP_TRIGGERS`), by focus as
 * a keyboard would, and while it is open scans the whole document, its
 * content's portal included, for `text` in an attribute. Returns how many it
 * opened.
 */
export async function expectNoAttributeHoldsInOpenTooltips(text: string, root: Element): Promise<number> {
  const triggers = [...root.querySelectorAll<HTMLElement>(TOOLTIP_TRIGGERS)].filter((element) => element.tabIndex >= 0);
  for (const trigger of triggers) {
    act(() => trigger.focus());
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    expectNoAttributeHolds(text);
    act(() => trigger.blur());
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  }
  return triggers.length;
}

/** A fleet as a create and an update answer it, without its summary. */
export function fleet(overrides: Partial<Fleet> = {}): Fleet {
  return {
    id: FLEET_ID,
    label: "edge-prod",
    type: "server",
    status: "active",
    createdBy: CREATOR,
    createdAt: "2026-10-13T09:00:00.000Z",
    updatedAt: "2026-10-13T09:00:00.000Z",
    ...overrides,
  };
}

/** A fleet as the reads answer it, with its summary. */
export function fleetDetail(overrides: Partial<FleetDetail> = {}): FleetDetail {
  return { ...fleet(), summary: EMPTY_SUMMARY, ...overrides };
}

/**
 * `count` fleets, newest first, numbered from `from`: ids that sort as the
 * API's order does, labels "fleet-{n}".
 */
export function manyFleets(count: number, from = 1): FleetDetail[] {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index;
    const hex = n.toString(16).padStart(12, "0");
    return fleetDetail({ id: `00000000-0000-4000-8000-${hex}`, label: `fleet-${n}` });
  });
}

export function fleetsPage(fleets: FleetDetail[], nextCursor: string | null = null): FleetsPage {
  return { fleets, nextCursor };
}

/** A create's 201: the fleet, its Default group and both bearers. */
export function fleetCreated(overrides: Partial<Fleet> = {}): FleetCreatedResponse {
  const made = fleet(overrides);
  return {
    fleet: made,
    defaultGroup: {
      id: DEFAULT_GROUP_ID,
      fleetId: made.id,
      name: "Default",
      isDefault: true,
      annotations: null,
      assignedPublishedVersionId: null,
      assignedVersion: null,
      variableGroupId: null,
      createdAt: made.createdAt,
      updatedAt: made.createdAt,
    },
    tokens: {
      default: { id: DEFAULT_TOKEN_ID, bearer: "tfd_default-bearer-canary" },
      rotate: { id: ROTATE_TOKEN_ID, bearer: "tfr_rotate-bearer-canary", expiresAt: null },
    },
  };
}

/** A token as the fleet's token list carries it. */
export function listedToken(overrides: Partial<EnrollmentTokenListed> = {}): EnrollmentTokenListed {
  return {
    id: ROTATE_TOKEN_ID,
    fleetId: FLEET_ID,
    kind: "rotate",
    expiresAt: null,
    revokedAt: null,
    doRefresh: false,
    createdBy: CREATOR,
    createdAt: "2026-10-13T09:00:00.000Z",
    activeCollectors: 0,
    ...overrides,
  };
}

/* The tokens' fixtures: the fleet's tokens in every state, and its token history's events. */

export const REPLACED_TOKEN_ID = "c6d7e8f9-0a1b-4c2d-83e4-f5a6b7c8d9e0";
export const EXPIRED_TOKEN_ID = "d7e8f90a-1b2c-4d3e-94f5-a6b7c8d9e0f1";
export const REVOKED_TOKEN_ID = "e8f90a1b-2c3d-4e4f-a5a6-b7c8d9e0f1a2";
export const TOKEN_EVENT_ID = "f90a1b2c-3d4e-4f50-b6b7-c8d9e0f1a2b3";

/**
 * The fleet's tokens at `now`, one in each state the Tokens table shows,
 * each `activeCollectors` its own:
 * - `defaultToken`: the default token, valid (it never expires);
 * - `revokedDefaultToken`: the same token revoked a day ago;
 * - `current`: the current rotate token, made a day ago, expiring in a year;
 * - `beingReplaced`: the rotate token it replaced, in its grace (`doRefresh`),
 *   expiring in 20 days;
 * - `expired`: an older replaced rotate token, expired a day ago;
 * - `revoked`: the fleet's first rotate token, revoked two days ago.
 */
export function tokensInEveryState(now: number) {
  const at = (days: number) => new Date(now + days * DAY_MS).toISOString();
  return {
    defaultToken: listedToken({ id: DEFAULT_TOKEN_ID, kind: "default", createdAt: at(-90), activeCollectors: 1 }),
    revokedDefaultToken: listedToken({ id: DEFAULT_TOKEN_ID, kind: "default", revokedAt: at(-1), createdAt: at(-90) }),
    current: listedToken({ id: ROTATE_TOKEN_ID, expiresAt: at(365), createdAt: at(-1), activeCollectors: 3 }),
    beingReplaced: listedToken({ id: REPLACED_TOKEN_ID, expiresAt: at(20), doRefresh: true, createdAt: at(-40), activeCollectors: 2 }),
    expired: listedToken({ id: EXPIRED_TOKEN_ID, expiresAt: at(-1), doRefresh: true, createdAt: at(-60) }),
    revoked: listedToken({ id: REVOKED_TOKEN_ID, revokedAt: at(-2), createdAt: at(-80) }),
  };
}

/** The fleet's tokens list at `now` as the API answers it, newest first: every state but the revoked default token. */
export function fleetTokens(now: number): EnrollmentTokenListed[] {
  const { current, beingReplaced, expired, revoked, defaultToken } = tokensInEveryState(now);
  return [current, beingReplaced, expired, revoked, defaultToken];
}

/** An event of the fleet's token history: its rotate token issued by the fleet's creator. */
export function tokenEvent(overrides: Partial<EnrollmentTokenEvent> = {}): EnrollmentTokenEvent {
  return {
    id: TOKEN_EVENT_ID,
    tokenId: ROTATE_TOKEN_ID,
    event: "issued",
    actor: CREATOR,
    occurredAt: "2026-10-13T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * `count` events numbered from `from`, newest first: ids that differ by the
 * number, each a second before the one numbered before it, "viewed" by the
 * fleet's creator.
 */
export function manyTokenEvents(count: number, from = 1): EnrollmentTokenEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index;
    const hex = n.toString(16).padStart(12, "0");
    return tokenEvent({
      id: `00000000-0000-4000-a000-${hex}`,
      event: "viewed",
      occurredAt: new Date(Date.parse("2026-10-15T09:00:00.000Z") - n * 1000).toISOString(),
    });
  });
}

/** A page of the token history. */
export function tokenEventsPage(events: EnrollmentTokenEvent[], nextCursor: string | null = null): EnrollmentTokenEventsPage {
  return { events, nextCursor };
}

/* The collectors' fixtures: a collector, a group, an error and a configuration's version. */

export const COLLECTOR_ID = "4e5f6071-8293-44a5-bb6c-7d8e9fa0b1c2";
export const INSTANCE_UID = "5f607182-93a4-45b6-8c7d-8e9fa0b1c2d3";
export const GATEWAYS_GROUP_ID = "60718293-a4b5-46c7-9d8e-9fa0b1c2d3e4";
export const COLLECTOR_ERROR_ID = "8293a4b5-c6d7-48e9-bfa0-b1c2d3e4f5a6";
export const CONFIGURATION_ID = "93a4b5c6-d7e8-49fa-80b1-c2d3e4f5a6b7";
export const VERSION_ID = "a4b5c6d7-e8f9-4a0b-91c2-d3e4f5a6b7c8";
export const PUBLISHED_VERSION_ID = "b5c6d7e8-f90a-4b1c-a2d3-e4f5a6b7c8d9";

/** A hash of 64 hex digits: `digit` repeated. */
export function sha256Of(digit = "a"): string {
  return digit.repeat(64);
}

/** A published version with the platform's names beside it: "checkout-otel @v4", built for otelcol-contrib 0.159.0. */
export function publishedVersion(overrides: Partial<PublishedVersion> = {}): PublishedVersion {
  return {
    configurationId: CONFIGURATION_ID,
    configurationName: "checkout-otel",
    versionId: VERSION_ID,
    versionNumber: 4,
    versionLabel: null,
    collectorDistribution: "otelcol-contrib",
    collectorVersion: "0.159.0",
    ...overrides,
  };
}

/**
 * A collector of the fleet as the list and the read answer it: `web-01` in
 * the Default group, online and in sync, following its group's published
 * version (served and applied), with what it reported of itself.
 */
export function collector(overrides: Partial<Collector> = {}): Collector {
  return {
    id: COLLECTOR_ID,
    instanceUid: INSTANCE_UID,
    name: "web-01",
    fleetId: FLEET_ID,
    groupId: DEFAULT_GROUP_ID,
    pin: null,
    pinnedVariableGroupId: null,
    resolution: { from: "groupVersion", publishedVersionId: PUBLISHED_VERSION_ID, sha256: sha256Of("a"), version: publishedVersion() },
    served: {
      kind: "version",
      publishedVersionId: PUBLISHED_VERSION_ID,
      sha256: sha256Of("a"),
      at: "2026-10-14T09:00:00.000Z",
      version: publishedVersion(),
    },
    effective: { sha256: sha256Of("a"), status: "applied", error: null, at: "2026-10-14T09:00:05.000Z" },
    reported: {
      collectorVersion: "0.162.0",
      ip: "10.0.4.17",
      hostIp: "192.168.1.17",
      attributes: { "host.name": "web-01", "os.type": "linux" },
    },
    enrollmentTokenId: ROTATE_TOKEN_ID,
    lastSeenAt: "2026-10-14T09:59:55.000Z",
    liveness: "online",
    drift: "inSync",
    createdAt: "2026-10-13T09:00:00.000Z",
    updatedAt: "2026-10-14T09:00:05.000Z",
    ...overrides,
  };
}

/**
 * `count` collectors numbered from `from`: ids that differ by the number,
 * names "collector-{n}" (three digits).
 */
export function manyCollectors(count: number, from = 1): Collector[] {
  return Array.from({ length: count }, (_, index) => {
    const n = from + index;
    const hex = n.toString(16).padStart(12, "0");
    return collector({ id: `00000000-0000-4000-9000-${hex}`, name: `collector-${String(n).padStart(3, "0")}` });
  });
}

export function collectorsPage(collectors: Collector[], nextCursor: string | null = null): CollectorsPage {
  return { collectors, nextCursor };
}

/** A collector group as the groups list answers it: the fleet's Default group, nothing assigned. */
export function collectorGroup(overrides: Partial<CollectorGroup> = {}): CollectorGroup {
  return {
    id: DEFAULT_GROUP_ID,
    fleetId: FLEET_ID,
    name: "Default",
    isDefault: true,
    annotations: null,
    assignedPublishedVersionId: null,
    assignedVersion: null,
    variableGroupId: null,
    createdAt: "2026-10-13T09:00:00.000Z",
    updatedAt: "2026-10-13T09:00:00.000Z",
    ...overrides,
  };
}

/** The group "gateways", assigned "checkout-otel @v4". */
export function gatewaysGroup(overrides: Partial<CollectorGroup> = {}): CollectorGroup {
  return collectorGroup({
    id: GATEWAYS_GROUP_ID,
    name: "gateways",
    isDefault: false,
    assignedPublishedVersionId: PUBLISHED_VERSION_ID,
    assignedVersion: publishedVersion(),
    ...overrides,
  });
}

/* A Kubernetes-supervisor fleet's groups: its Default group is the Agent, `cluster` the Cluster, any other a gateway. */

export const CLUSTER_GROUP_ID = "7182a3b4-c5d6-47e8-9f0a-1b2c3d4e5f60";
export const SECOND_GATEWAY_GROUP_ID = "8293b4c5-d6e7-48f9-a01b-2c3d4e5f6071";

/** The Cluster's group ("cluster"), nothing assigned. */
export function clusterGroup(overrides: Partial<CollectorGroup> = {}): CollectorGroup {
  return collectorGroup({ id: CLUSTER_GROUP_ID, name: "cluster", isDefault: false, ...overrides });
}

/**
 * A Kubernetes fleet's groups in the API's order (Default first, then by
 * name): the Agent, the gateway "alpha" (sorted before "cluster"), the
 * Cluster, the gateway "gateways".
 */
export function kubernetesGroups(): CollectorGroup[] {
  return [collectorGroup(), gatewaysGroup({ id: SECOND_GATEWAY_GROUP_ID, name: "alpha" }), clusterGroup(), gatewaysGroup()];
}

/** A Kubernetes group's settings: a gateway's in telflo-collectors, one replica, no volumes. */
export function kubernetesSettings(overrides: Partial<KubernetesAnnotations> = {}): KubernetesAnnotations {
  return { role: "gateway", namespace: "telflo-collectors", replicas: 1, volumes: [], ...overrides };
}

/**
 * A group's annotations holding Kubernetes `settings` under the platform's
 * key, beside another client's key (kept by every write), as the
 * opamp-server answers them.
 */
export function kubernetesAnnotations(settings: Partial<KubernetesAnnotations> = {}): Record<string, unknown> {
  return { other: { kept: true }, telflo: { kubernetes: kubernetesSettings(settings) } };
}

/* The install's fixtures: a server group's mounts and its install facts. */

/** A read-only mount: nginx's logs, at the same path in the container. */
export const NGINX_MOUNT: DockerMount = { hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true };

/** A writable mount at another path in the container. */
export const DATA_MOUNT: DockerMount = { hostPath: "/srv/data", containerPath: "/var/lib/otelcol", readOnly: false };

/**
 * A group's annotations holding `mounts` under the platform's key, beside
 * another client's key (kept by every write). The opamp-server answers
 * them with their keys sorted.
 */
export function mountsAnnotations(mounts: DockerMount[] = [NGINX_MOUNT]): Record<string, unknown> {
  return { other: { kept: true }, telflo: { dockerMounts: mounts } };
}

/**
 * The install's facts as the facts route answers them: the gateways group's,
 * its published version built for otelcol-contrib 0.159.0, one variable its
 * YAML reads and the nginx mount; no bearer.
 */
export function installFacts(overrides: Partial<InstallFacts> = {}): InstallFacts {
  return {
    imageTag: "ghcr.io/telflo/telflo/collector:0.159.0",
    endpoint: "wss://opamp.example.com/v1/opamp",
    allowInsecureConnections: false,
    collector: { distribution: "otelcol-contrib", version: "0.159.0" },
    envVarNames: ["NGINX_ENV"],
    mounts: [NGINX_MOUNT],
    mountsReadable: true,
    groupId: GATEWAYS_GROUP_ID,
    ...overrides,
  };
}

/**
 * A Kubernetes group's install facts as the facts route answers them: the
 * gateways group's by default (its release its name, no fullnameOverride,
 * telflo-collectors, one replica, no volumes), built for otelcol-contrib
 * 0.159.0, one variable its YAML reads, the platform's chart and image at
 * their defaults (the contracts' DEFAULT_HELM_CHART_REFERENCE and
 * DEFAULT_HELM_CHART_VERSION, ghcr.io/telflo/telflo/collector); no bearer.
 * `helm` overrides the Helm install's fields.
 */
export function helmInstallFacts(
  overrides: Partial<Omit<HelmInstallFacts, "helm">> = {},
  helm: Partial<HelmInstallFacts["helm"]> = {},
): HelmInstallFacts {
  return {
    imageTag: "ghcr.io/telflo/telflo/collector:0.159.0",
    endpoint: "wss://opamp.example.com/v1/opamp",
    allowInsecureConnections: false,
    collector: { distribution: "otelcol-contrib", version: "0.159.0" },
    envVarNames: ["NGINX_ENV"],
    groupId: GATEWAYS_GROUP_ID,
    ...overrides,
    helm: {
      chartReference: DEFAULT_HELM_CHART_REFERENCE,
      chartVersion: DEFAULT_HELM_CHART_VERSION,
      imageRepository: "ghcr.io/telflo/telflo/collector",
      release: "gateways",
      fullnameOverride: null,
      role: "gateway",
      namespace: "telflo-collectors",
      replicas: 1,
      volumes: [],
      ...helm,
    },
  };
}

/** The Agent's Helm facts (the Default group's): release telflo-node, FLEET_ID's fullnameOverride, no replicas. */
export function agentHelmFacts(helm: Partial<HelmInstallFacts["helm"]> = {}): HelmInstallFacts {
  return helmInstallFacts({ groupId: DEFAULT_GROUP_ID }, { release: "telflo-node", fullnameOverride: "0a1b2c3d-default", role: "node", replicas: null, ...helm });
}

/** One error from a collector's history. */
export function collectorError(overrides: Partial<CollectorError> = {}): CollectorError {
  return {
    id: COLLECTOR_ERROR_ID,
    reportedAt: "2026-10-14T09:30:00.000Z",
    configSha256: sha256Of("a"),
    message: "failed to start the otlp receiver",
    ...overrides,
  };
}

/** A configuration's version as the versions route lists it: "@v4", published. */
export function configurationVersionListItem(
  overrides: Partial<ConfigurationVersionListItem> = {},
): ConfigurationVersionListItem {
  return {
    id: VERSION_ID,
    versionNumber: 4,
    label: null,
    publishedAt: "2026-10-12T09:00:00.000Z",
    ...overrides,
  };
}

/* The quick-deploy links' fixtures: a link, a page of them and the create's reply. */

export const QUICK_DEPLOY_LINK_ID = "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e70";

/** A link's secret (`tqd_` and 43 base64url characters): a canary, so a test can look for it anywhere. */
export const QUICK_DEPLOY_SECRET = `tqd_${"Qd9_-".repeat(8)}cny`;

/** The create's `url` for `QUICK_DEPLOY_SECRET`, as `QUICK_DEPLOY_URL_PATTERN` takes it. */
export const QUICK_DEPLOY_URL = `https://telflo.example.com/api/v1/quick-deploy/${QUICK_DEPLOY_SECRET}`;

/**
 * A link as the list, an extend and a revoke answer it: the gateways
 * group's All In One for amd64 at /etc/otelcol as a systemd service, one
 * variable's value sealed with it, made by the fleet's creator, active for
 * a day, never downloaded. No secret, hash or value.
 */
export function quickDeployLink(overrides: Partial<QuickDeployLink> = {}): QuickDeployLink {
  return {
    id: QUICK_DEPLOY_LINK_ID,
    groupId: GATEWAYS_GROUP_ID,
    groupName: "gateways",
    defaultTokenId: DEFAULT_TOKEN_ID,
    createdBy: CREATOR,
    choices: {
      method: "all-in-one",
      arch: "amd64",
      rootPath: "/etc/otelcol",
      executablePath: null,
      systemd: true,
      envNames: ["NGINX_ENV"],
    },
    createdAt: "2026-10-17T09:00:00.000Z",
    expiresAt: "2026-10-18T09:00:00.000Z",
    revokedAt: null,
    downloadCount: 0,
    lastDownloadedAt: null,
    status: "active",
    ...overrides,
  };
}

/**
 * A Helm values link as the list answers it: the gateways group's, its
 * release and namespace at the link's making, one variable's value sealed
 * with it; otherwise as `quickDeployLink`.
 */
export function helmQuickDeployLink(overrides: Partial<QuickDeployLink> = {}): QuickDeployLink {
  return quickDeployLink({
    choices: { kind: "helm", role: "gateway", release: "gateways", namespace: "telflo-collectors", envNames: ["NGINX_ENV"] },
    ...overrides,
  });
}

/** A page of the fleet's links. */
export function quickDeployLinksPage(links: QuickDeployLink[], nextCursor: string | null = null): QuickDeployLinksPage {
  return { links, nextCursor };
}

/** The create's reply (201, `no-store`): the link and its `url`, the one copy of the secret. */
export function quickDeployLinkCreated(
  overrides: Partial<QuickDeployLink> = {},
  url: string = QUICK_DEPLOY_URL,
): CreateQuickDeployLinkResponse {
  return { link: quickDeployLink(overrides), url };
}

/**
 * The variable reads a fleet dialog makes at its opening, answered with
 * none: the organization's variable groups (the Variable group choice), the
 * chosen version's text ("Variables used": `yamlContent`, none by default)
 * and the organization's variables (the shared names). A test of those
 * parts serves its own instead.
 */
export function serveNoVariables(yamlContent = "") {
  return {
    getVariableGroups: vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([]),
    getConfigurationVersion: vi
      .spyOn(apiClient, "getConfigurationVersion")
      .mockImplementation(async (_organizationId, configurationId, versionId) =>
        answerFor({ ...THEIRS, id: configurationId }, versionFixture({ id: versionId, configurationId, yamlContent })),
      ),
    getOrganizationVariables: vi.spyOn(apiClient, "getOrganizationVariables").mockResolvedValue([]),
  };
}
