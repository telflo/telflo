import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  QUICK_DEPLOY_URL_PATTERN,
  type Collector,
  type CollectorGroup,
  type CollectorPinRequest,
  type CreateCollectorGroupRequest,
  type CreateQuickDeployLinkRequestInput,
  type CreateQuickDeployLinkResponse,
  type EnrollmentTokenRevealedResponse,
  type FleetCreatedResponse,
  type FleetDetail,
  type FleetType,
  type QuickDeployLink,
  type QuickDeployLinkExtension,
  type QuickDeployLinkResponse,
  type QuickDeployLinksPage,
  type UpdateCollectorGroupRequest,
} from "@telflo/contracts";
import { findConfigurationVersions, seedConfiguration } from "./database.js";
import { enrollFakeCollector, type FakeCollectorEnrollment } from "./fake-opamp-server.js";
import type { EnrolledCollector } from "../../apps/api/src/testing/fake-opamp-server-fleets.js";

// Seeding a fleet's collectors for the browser tests (a server fleet's or a
// Kubernetes-supervisor fleet's). Fleets, groups, pins and publishing go
// through the E2E API as the page's session (`page.request`, the CSRF header
// set), so the fake opamp-server holds what the platform made; collectors and
// errors through the fake's control port (support/fake-opamp-server.ts),
// before the page reads them.

const CSRF = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

/** A collector configuration a published version can hold (the publishing tests'). */
export const PUBLISHABLE_YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";

/** The fleet's collectors' path under the E2E API. */
export function collectorsApiPath(organizationId: string, fleetId: string): string {
  return `/api/v1/organizations/${organizationId}/fleets/${fleetId}/collectors`;
}

/**
 * A server fleet made through the API, as the page's own create would: its
 * rotate token never expires unless `rotateExpiresAt` (ISO 8601) says when
 * (the Tokens tab's banner).
 */
export async function createServerFleetThroughApi(
  page: Page,
  organizationId: string,
  label = `edge-${randomUUID().slice(0, 8)}`,
  rotateExpiresAt: string | null = null,
): Promise<FleetCreatedResponse> {
  return createFleetThroughApi(page, organizationId, "server", label, rotateExpiresAt);
}

/**
 * A fleet of `type` made through the API, as the page's own create would (a
 * Kubernetes-supervisor fleet's among them): its Default group, its tokens;
 * its rotate token never expires unless `rotateExpiresAt` (ISO 8601) says
 * when.
 */
export async function createFleetThroughApi(
  page: Page,
  organizationId: string,
  type: FleetType,
  label = `edge-${randomUUID().slice(0, 8)}`,
  rotateExpiresAt: string | null = null,
): Promise<FleetCreatedResponse> {
  const response = await page.request.post(`/api/v1/organizations/${organizationId}/fleets`, {
    data: { label, type, rotateExpiresAt },
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as FleetCreatedResponse;
}

/** A token of the fleet revoked through the API, as the page's session (the Tokens tab's tests; the install's after a revoke). */
export async function revokeThroughApi(page: Page, organizationId: string, fleetId: string, tokenId: string): Promise<void> {
  const response = await page.request.post(`/api/v1/organizations/${organizationId}/fleets/${fleetId}/tokens/${tokenId}/revoke`, {
    headers: CSRF,
  });
  expect(response.status()).toBe(200);
}

/** The fleet's new default token issued through the API, once its default token is revoked: its id and bearer. */
export async function issueDefaultTokenThroughApi(
  page: Page,
  organizationId: string,
  fleetId: string,
): Promise<EnrollmentTokenRevealedResponse["token"]> {
  const response = await page.request.post(`/api/v1/organizations/${organizationId}/fleets/${fleetId}/tokens/default`, {
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as EnrollmentTokenRevealedResponse).token;
}

/** The fleet archived through the API's PATCH, as the page's Archive does. */
export async function archiveFleetThroughApi(page: Page, organizationId: string, fleetId: string): Promise<FleetDetail> {
  const response = await page.request.patch(`/api/v1/organizations/${organizationId}/fleets/${fleetId}`, {
    data: { status: "archived" },
    headers: CSRF,
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { fleet: FleetDetail }).fleet;
}

/**
 * A group of the fleet made through the API: nothing assigned and no
 * annotations, unless `fields` says (a Kubernetes group's settings in its
 * annotations' `telflo.kubernetes`, which the API requires on a
 * Kubernetes-supervisor fleet).
 */
export async function createGroupThroughApi(
  page: Page,
  organizationId: string,
  fleetId: string,
  name: string,
  fields: Omit<CreateCollectorGroupRequest, "name"> = {},
): Promise<CollectorGroup> {
  const response = await page.request.post(`/api/v1/organizations/${organizationId}/fleets/${fleetId}/groups`, {
    data: { name, ...fields },
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { group: CollectorGroup }).group;
}

/**
 * A group of the fleet changed through the API's PATCH: its published
 * version (`assignedVersionId`), its annotations (a server group's mounts),
 * its name.
 */
export async function updateGroupThroughApi(
  page: Page,
  organizationId: string,
  fleetId: string,
  groupId: string,
  changes: UpdateCollectorGroupRequest,
): Promise<CollectorGroup> {
  const response = await page.request.patch(`/api/v1/organizations/${organizationId}/fleets/${fleetId}/groups/${groupId}`, {
    data: changes,
    headers: CSRF,
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { group: CollectorGroup }).group;
}

/** A fleet's quick-deploy links' path under the E2E API. */
function quickDeployLinksApiPath(organizationId: string, fleetId: string): string {
  return `/api/v1/organizations/${organizationId}/fleets/${fleetId}/quick-deploy-links`;
}

/**
 * A quick-deploy link of the group made through the API, as the install
 * dialog's "Quick Deploy" makes it: 201, `no-store`; its link and its `url`,
 * the one copy of the link's secret, checked as the web checks it before it
 * builds a command (`QUICK_DEPLOY_URL_PATTERN`).
 */
export async function createQuickDeployLinkThroughApi(
  page: Page,
  organizationId: string,
  fleetId: string,
  groupId: string,
  request: CreateQuickDeployLinkRequestInput,
): Promise<CreateQuickDeployLinkResponse> {
  const response = await page.request.post(`/api/v1/organizations/${organizationId}/fleets/${fleetId}/groups/${groupId}/quick-deploy-links`, {
    data: request,
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const created = (await response.json()) as CreateQuickDeployLinkResponse;
  // Never printed on a failure: the url holds the link's secret.
  expect(QUICK_DEPLOY_URL_PATTERN.test(created.url), "the create's url is one the API makes").toBe(true);
  return created;
}

/** A link extended through the API by a preset, counted from now, as Install Links' Extend does: the link as it now is. */
export async function extendQuickDeployLinkThroughApi(
  page: Page,
  organizationId: string,
  fleetId: string,
  linkId: string,
  by: QuickDeployLinkExtension,
): Promise<QuickDeployLink> {
  const response = await page.request.post(`${quickDeployLinksApiPath(organizationId, fleetId)}/${linkId}/extend`, {
    data: { by },
    headers: CSRF,
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as QuickDeployLinkResponse).link;
}

/** A link revoked through the API, as Install Links' Revoke does: the link as it now is. */
export async function revokeQuickDeployLinkThroughApi(page: Page, organizationId: string, fleetId: string, linkId: string): Promise<QuickDeployLink> {
  const response = await page.request.post(`${quickDeployLinksApiPath(organizationId, fleetId)}/${linkId}/revoke`, { headers: CSRF });
  expect(response.status()).toBe(200);
  return ((await response.json()) as QuickDeployLinkResponse).link;
}

/** The fleet's first page of quick-deploy links (50, newest first), read through the API. */
export async function quickDeployLinksThroughApi(page: Page, organizationId: string, fleetId: string): Promise<QuickDeployLink[]> {
  const response = await page.request.get(quickDeployLinksApiPath(organizationId, fleetId));
  expect(response.status()).toBe(200);
  return ((await response.json()) as QuickDeployLinksPage).links;
}

/** What a published configuration's version 1 holds, when a test needs other than the default. */
export interface PublishedConfigurationOptions {
  /** Its YAML (default PUBLISHABLE_YAML): an install's `${env:NAME}` references, say. */
  yaml?: string;
  /** Its collector version (default the catalogue's default version): the install's image tag follows it. */
  collectorVersion?: string;
}

/**
 * A configuration of the organization with its version 1 published: seeded
 * as a draft, then published through the API (seeded as published, the
 * fake would hold no publication of it, and the platform would refuse a
 * pin to it). Its id and its version's. Its YAML and collector version are
 * `options`', else the defaults.
 */
export async function publishedConfiguration(
  page: Page,
  organizationId: string,
  createdByUserId: string,
  name: string,
  { yaml = PUBLISHABLE_YAML, collectorVersion }: PublishedConfigurationOptions = {},
): Promise<{ configurationId: string; versionId: string }> {
  const configuration = await seedConfiguration({
    organizationId,
    createdByUserId,
    name,
    yamlContent: yaml,
    ...(collectorVersion === undefined ? {} : { collectorVersion }),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  const published = await page.request.post(
    `/api/v1/organizations/${organizationId}/configurations/${configuration.id}/versions/${version!.id}/publish`,
    { headers: CSRF },
  );
  expect(published.status()).toBe(200);
  return { configurationId: configuration.id, versionId: version!.id };
}

/**
 * Enrolls `{prefix}-000` to `{prefix}-{count - 1}` (three digits) in the
 * fleet through the control port, one after another, each with
 * `enrollment`'s other fields.
 */
export async function enrollCollectors(
  organizationId: string,
  fleetId: string,
  prefix: string,
  count: number,
  enrollment: Omit<FakeCollectorEnrollment, "name"> = {},
): Promise<EnrolledCollector[]> {
  const enrolled: EnrolledCollector[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `${prefix}-${String(index).padStart(3, "0")}`;
    enrolled.push(await enrollFakeCollector(organizationId, fleetId, { ...enrollment, name }));
  }
  return enrolled;
}

/**
 * Pins a collector (or unpins it, `null`) through the API's PATCH.
 */
export async function pinThroughApi(
  page: Page,
  organizationId: string,
  fleetId: string,
  collectorId: string,
  pin: CollectorPinRequest,
): Promise<Collector> {
  const response = await page.request.patch(`${collectorsApiPath(organizationId, fleetId)}/${collectorId}`, {
    data: { pin },
    headers: CSRF,
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { collector: Collector }).collector;
}

/** One collector, read through the API. */
export async function collectorThroughApi(page: Page, organizationId: string, fleetId: string, collectorId: string): Promise<Collector> {
  const response = await page.request.get(`${collectorsApiPath(organizationId, fleetId)}/${collectorId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { collector: Collector }).collector;
}

/** The fleet's first page of collectors (50), read through the API. */
export async function collectorsThroughApi(page: Page, organizationId: string, fleetId: string): Promise<Collector[]> {
  const response = await page.request.get(collectorsApiPath(organizationId, fleetId));
  expect(response.status()).toBe(200);
  return ((await response.json()) as { collectors: Collector[] }).collectors;
}

/** A Kubernetes pod's collector as the collector image reports it: its group, node and namespace. */
export interface KubernetesPodEnrollment {
  /** Its name: the pod's (`POD_NAME`), as the supervisor names it at enrolment. */
  name: string;
  /** The group it joins (`COLLECTOR_GROUP_ID`): every collector names one. */
  groupId: string;
  /** Its node (`NODE_NAME`): `k8s.node.name`, the details' Node row. */
  nodeName: string;
  /** Its namespace: `k8s.namespace.name`. */
  namespace: string;
  /** Its pod's IP (`HOST_IP` in the platform's chart, charts/supervisor-collector: the pod's): reported as its IPs and as `host.ip`. */
  ip?: string;
}

/**
 * Enrolls a Kubernetes pod's collector in the fleet through the control port:
 * in its group, seen now, reporting the attributes the collector image sets
 * from the pod's environment (`k8s.node.name`, `k8s.pod.name`,
 * `k8s.namespace.name`, `host.ip` from `HOST_IP`,
 * `telflo.collector_group_id`: docker/collector-image's entrypoint).
 */
export async function enrollKubernetesPod(
  organizationId: string,
  fleetId: string,
  { name, groupId, nodeName, namespace, ip = "10.244.0.10" }: KubernetesPodEnrollment,
): Promise<EnrolledCollector> {
  return enrollFakeCollector(organizationId, fleetId, {
    name,
    groupId,
    reported: {
      ip,
      hostIp: ip,
      attributes: {
        "k8s.node.name": nodeName,
        "k8s.pod.name": name,
        "k8s.namespace.name": namespace,
        "host.ip": ip,
        "telflo.collector_group_id": groupId,
      },
    },
  });
}
