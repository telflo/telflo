import {
  CollectorErrorsPageSchema,
  CollectorGroupResponseSchema,
  CollectorGroupsResponseSchema,
  CollectorResponseSchema,
  CollectorsPageSchema,
  ConfigurationFleetUsageResponseSchema,
  CreateCollectorGroupRequestSchema,
  CreateFleetRequestSchema,
  CreateQuickDeployLinkRequestSchema,
  CreateQuickDeployLinkResponseSchema,
  EnrollmentTokenEventsPageSchema,
  ExtendQuickDeployLinkRequestSchema,
  EnrollmentTokenResponseSchema,
  EnrollmentTokenRevealedResponseSchema,
  EnrollmentTokenRotatedResponseSchema,
  EnrollmentTokensResponseSchema,
  ErrorResponseSchema,
  FleetCreatedResponseSchema,
  FleetDetailResponseSchema,
  FleetResponseSchema,
  FleetsPageQuerySchema,
  FleetsPageSchema,
  HelmInstallFactsSchema,
  InstallBundleRequestSchema,
  InstallFactsSchema,
  ListCollectorsQuerySchema,
  ListFleetsQuerySchema,
  ListQuickDeployLinksQuerySchema,
  PinCollectorsRequestSchema,
  PinCollectorsResponseSchema,
  QuickDeployLinkResponseSchema,
  QuickDeployLinksPageSchema,
  RotateEnrollmentTokenRequestSchema,
  UpdateCollectorGroupRequestSchema,
  UpdateCollectorRequestSchema,
  UpdateFleetRequestSchema,
} from "@telflo/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createInstallTemplateLoader } from "../../install/templates.js";
import { createCollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import { createConfigurationRepository } from "../configurations/repositories/configuration-repository.js";
import { createPublishedVersionRepository } from "../configurations/repositories/published-version-repository.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import type { OpampRegistration } from "../organizations/opamp-registration.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { actorOf } from "../organizations/routes.js";
import { createAuthenticate, requireCurrentTerms } from "../sessions/authenticate.js";
import { createQuickDeployLinkRepository } from "../quick-deploy/repositories/quick-deploy-link-repository.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { createFleetsService, type WithFleetsTransaction } from "./service.js";

/** What the fleets service is built from, once, in buildServer (D25 decision 15, Preflight ruling 4). */
export interface FleetServicesDependencies extends ServerDependencies {
  now: () => Date;
  /** buildServer's: a create that finds its organization deleted runs its delete hook again (Preflight ruling 13). */
  opampRegistration: Pick<OpampRegistration, "deleted">;
}

/** The fleets service, one instance shared by the browser routes here and the public routes (D25 decision 15). */
export interface FleetServices {
  service: ReturnType<typeof createFleetsService>;
}

export interface FleetRoutesDependencies extends FleetServicesDependencies {
  /** buildServer's shared instances (createFleetServices). */
  services: { fleets: FleetServices };
}

/**
 * Every route under an organization's fleets. Their queries are never
 * logged (Preflight ruling 16): `http/request-log.ts` names this prefix too.
 */
const FLEETS_ROUTE = "/api/v1/organizations/:organizationId/fleets";

/** A configuration's fleet usage (Task 4): beside the configurations, not under the fleets. */
const FLEET_USAGE_ROUTE = "/api/v1/organizations/:organizationId/configurations/:configurationId/fleet-usage";

/**
 * The replies that carry a bearer (a create's, a reveal's, a rotation's, a
 * new default token's) tell every cache to keep no copy (decision 1), set by the platform: the
 * opamp-server's own header isn't forwarded. A create's retry (200) too.
 * A collector's reads and update's answer too: they carry its
 * reported attributes and error text (D17b-1 decision 30).
 */
const NO_STORE = "no-store";

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/**
 * Every fleet route's refusals: the contract's 400, the session's 401, the
 * terms' 403, the 404s, the person's limit (429) and the one 503
 * (Preflight ruling 8).
 */
const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  429: ErrorResponseSchema,
  503: ErrorResponseSchema,
};

/** A write's: a refusal of the person's to fix besides (409). */
const writeErrorResponses = { ...errorResponses, 409: ErrorResponseSchema };

/** An assignment's or a pin's: a version that isn't published besides (422 `configuration_version_not_published`). */
const versionWriteErrorResponses = { ...writeErrorResponses, 422: ErrorResponseSchema };

/**
 * Any string for each id: a path naming anything but the active
 * organization is the same 404 (D5 decision 7), and a malformed fleet or
 * token id its own 404 with no call (Preflight ruling 9), never a 400.
 */
const OrganizationParamsSchema = z.object({ organizationId: z.string() });
const FleetParamsSchema = z.object({ organizationId: z.string(), fleetId: z.string() });
const TokenParamsSchema = z.object({ organizationId: z.string(), fleetId: z.string(), tokenId: z.string() });
const GroupParamsSchema = z.object({ organizationId: z.string(), fleetId: z.string(), groupId: z.string() });
const LinkParamsSchema = z.object({ organizationId: z.string(), fleetId: z.string(), linkId: z.string() });
const CollectorParamsSchema = z.object({ organizationId: z.string(), fleetId: z.string(), collectorId: z.string() });
const ConfigurationParamsSchema = z.object({ organizationId: z.string(), configurationId: z.string() });

/**
 * The fleets service (D25 Preflight ruling 4), moved verbatim from the
 * routes: built once in buildServer and shared by the browser and the
 * public routes, so its limiter is counted once per person.
 */
export function createFleetServices(
  deps: FleetServicesDependencies,
  rateLimiters: Pick<RateLimiters, "fleetsPerUser">,
  log: FastifyBaseLogger,
): FleetServices {
  const { db, now, opampServer, opampRegistration, settings } = deps;
  const withTransaction: WithFleetsTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) =>
      work({
        organization: createActiveOrganizationRepository(transaction, { organizationId: context.organizationId }),
        audit: createAuditRepository(transaction),
        configurations: createConfigurationRepository(transaction, context),
        publishedVersions: createPublishedVersionRepository(transaction, context),
        catalogue: createCollectorCatalogueRepository(transaction),
        quickDeployLinks: createQuickDeployLinkRepository(transaction, { organizationId: context.organizationId }),
      }),
    );
  const service = createFleetsService({
    withTransaction,
    opampServer,
    limiter: rateLimiters.fleetsPerUser,
    opampRegistration,
    now,
    log,
    install: settings.install,
    installTemplates: deps.installTemplates ?? createInstallTemplateLoader(settings.install.templatesDirectory),
    quickDeploy: settings.quickDeploy,
  });
  return { service };
}

/**
 * D16b decision 13's routes: fleets and their tokens (Task 3), collector
 * groups, collectors and a configuration's fleet usage (Task 4).
 * Each needs a session and the current terms (403
 * `terms_acceptance_required` first), then the path's organization the
 * session's active one; every member of it may use them (decision 6). The
 * service does the rest: service.ts.
 */
export function registerFleetRoutes(
  server: FastifyInstance,
  deps: FleetRoutesDependencies,
): void {
  const { service } = deps.services.fleets;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const preHandler = [authenticate, requireCurrentTerms];
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.get(
    FLEETS_ROUTE,
    {
      preHandler,
      schema: {
        params: OrganizationParamsSchema,
        querystring: ListFleetsQuerySchema,
        response: { 200: FleetsPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { status, limit, cursor } = request.query;
      const page = await service.list(actorOf(request), request.params.organizationId, {
        limit,
        ...(status === undefined ? {} : { status }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      return reply.send(page);
    },
  );

  // Decision 15: 201 with the fleet, its Default group and both bearers,
  // once; a retry with the same id, label and type 200 with the fleet alone.
  typed.post(
    FLEETS_ROUTE,
    {
      preHandler,
      schema: {
        params: OrganizationParamsSchema,
        body: CreateFleetRequestSchema,
        response: { 201: FleetCreatedResponseSchema, 200: FleetResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const outcome = await service.create(actorOf(request), request.params.organizationId, request.body);
      void reply.header("cache-control", NO_STORE);
      if (outcome.kind === "created") return reply.status(201).send(outcome.reply);
      return reply.status(200).send({ fleet: outcome.fleet });
    },
  );

  typed.get(
    `${FLEETS_ROUTE}/:fleetId`,
    {
      preHandler,
      schema: { params: FleetParamsSchema, response: { 200: FleetDetailResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      return reply.send({ fleet: await service.get(actorOf(request), organizationId, fleetId) });
    },
  );

  typed.patch(
    `${FLEETS_ROUTE}/:fleetId`,
    {
      preHandler,
      schema: {
        params: FleetParamsSchema,
        body: UpdateFleetRequestSchema,
        response: { 200: FleetResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      return reply.send({ fleet: await service.update(actorOf(request), organizationId, fleetId, request.body) });
    },
  );

  // With everything it holds: its groups, tokens and collectors.
  typed.delete(
    `${FLEETS_ROUTE}/:fleetId`,
    {
      preHandler,
      schema: { params: FleetParamsSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      await service.remove(actorOf(request), organizationId, fleetId);
      return reply.status(204).send(null);
    },
  );

  // Without their bearers.
  typed.get(
    `${FLEETS_ROUTE}/:fleetId/tokens`,
    {
      preHandler,
      schema: { params: FleetParamsSchema, response: { 200: EnrollmentTokensResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      return reply.send({ tokens: await service.listTokens(actorOf(request), organizationId, fleetId) });
    },
  );

  // Not no-store: ids, times and members' emails, as the tokens list's creators (decision 20).
  typed.get(
    `${FLEETS_ROUTE}/:fleetId/tokens/events`,
    {
      preHandler,
      schema: {
        params: FleetParamsSchema,
        querystring: FleetsPageQuerySchema,
        response: { 200: EnrollmentTokenEventsPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      const { limit, cursor } = request.query;
      return reply.send(
        await service.listTokenEvents(actorOf(request), organizationId, fleetId, { limit, ...(cursor === undefined ? {} : { cursor }) }),
      );
    },
  );

  typed.post(
    `${FLEETS_ROUTE}/:fleetId/tokens/rotate`,
    {
      preHandler,
      schema: {
        params: FleetParamsSchema,
        body: RotateEnrollmentTokenRequestSchema,
        response: { 201: EnrollmentTokenRotatedResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      const token = await service.rotateToken(actorOf(request), organizationId, fleetId, request.body);
      return reply.status(201).header("cache-control", NO_STORE).send({ token });
    },
  );

  // D17c-1 decisions 29 and 45: a new default token once the fleet's are
  // all revoked, the reveal's shape. No body: the actor is the session's.
  typed.post(
    `${FLEETS_ROUTE}/:fleetId/tokens/default`,
    {
      preHandler,
      schema: { params: FleetParamsSchema, response: { 201: EnrollmentTokenRevealedResponseSchema, ...writeErrorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      const token = await service.issueDefaultToken(actorOf(request), organizationId, fleetId);
      return reply.status(201).header("cache-control", NO_STORE).send({ token });
    },
  );

  // No body: the actor is the session's.
  typed.post(
    `${FLEETS_ROUTE}/:fleetId/tokens/:tokenId/reveal`,
    {
      preHandler,
      schema: { params: TokenParamsSchema, response: { 200: EnrollmentTokenRevealedResponseSchema, ...writeErrorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId, tokenId } = request.params;
      const token = await service.revealToken(actorOf(request), organizationId, fleetId, tokenId);
      return reply.header("cache-control", NO_STORE).send({ token });
    },
  );

  // Idempotent: an already revoked token answers as it is (and is audited again).
  typed.post(
    `${FLEETS_ROUTE}/:fleetId/tokens/:tokenId/revoke`,
    {
      preHandler,
      schema: { params: TokenParamsSchema, response: { 200: EnrollmentTokenResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId, tokenId } = request.params;
      return reply.send({ token: await service.revokeToken(actorOf(request), organizationId, fleetId, tokenId) });
    },
  );

  // -------------------------------------------------------------------------
  // Collector groups (Task 4): each with its assignment's configuration and version beside it.

  typed.get(
    `${FLEETS_ROUTE}/:fleetId/groups`,
    {
      preHandler,
      schema: { params: FleetParamsSchema, response: { 200: CollectorGroupsResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      return reply.send({ groups: await service.listGroups(actorOf(request), organizationId, fleetId) });
    },
  );

  // Checked against the fleet's type once it is read (D17d-1 decisions 17
  // and 18): a server fleet's group takes no telflo.kubernetes; a
  // Kubernetes fleet's is the Cluster or a gateway pool, carrying its
  // telflo.kubernetes and no telflo.dockerMounts (400 at each field's path).
  typed.post(
    `${FLEETS_ROUTE}/:fleetId/groups`,
    {
      preHandler,
      schema: {
        params: FleetParamsSchema,
        body: CreateCollectorGroupRequestSchema,
        response: { 201: CollectorGroupResponseSchema, ...versionWriteErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      const group = await service.createGroup(actorOf(request), organizationId, fleetId, request.body);
      return reply.status(201).send({ group });
    },
  );

  typed.get(
    `${FLEETS_ROUTE}/:fleetId/groups/:groupId`,
    {
      preHandler,
      schema: { params: GroupParamsSchema, response: { 200: CollectorGroupResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId, groupId } = request.params;
      return reply.send({ group: await service.getGroup(actorOf(request), organizationId, fleetId, groupId) });
    },
  );

  // As the create's checks; a Kubernetes fleet's group is never renamed
  // (409 collector_group_name_fixed: its Helm release is named after it).
  typed.patch(
    `${FLEETS_ROUTE}/:fleetId/groups/:groupId`,
    {
      preHandler,
      schema: {
        params: GroupParamsSchema,
        body: UpdateCollectorGroupRequestSchema,
        response: { 200: CollectorGroupResponseSchema, ...versionWriteErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId, groupId } = request.params;
      return reply.send({ group: await service.updateGroup(actorOf(request), organizationId, fleetId, groupId, request.body) });
    },
  );

  // Its collectors (and their error history) are deleted with it (D17d-1
  // decision 3), a long delete the platform waits up to 25 s for, as a
  // fleet's (Ruling 47); the Default group itself can't be deleted (409).
  // Unaudited, as every group write (D16b decision 18).
  typed.delete(
    `${FLEETS_ROUTE}/:fleetId/groups/:groupId`,
    {
      preHandler,
      schema: { params: GroupParamsSchema, response: { 204: noContent, ...writeErrorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId, groupId } = request.params;
      await service.removeGroup(actorOf(request), organizationId, fleetId, groupId);
      return reply.status(204).send(null);
    },
  );

  // -------------------------------------------------------------------------
  // Installing (D17c-1 decisions 38 and 39, Preflight ruling 14): no bearer
  // in either. The facts are sent `no-store` (the configuration's
  // variables' names): a server group's, or a Kubernetes group's Helm facts
  // (D17d-2 decision 15, Preflight ruling 1). The bundle's body (paths,
  // values) is never logged: the request log keeps a fleet route's path,
  // never its query or body.

  typed.get(
    `${FLEETS_ROUTE}/:fleetId/groups/:groupId/install`,
    {
      preHandler,
      schema: { params: GroupParamsSchema, response: { 200: z.union([InstallFactsSchema, HelmInstallFactsSchema]), ...writeErrorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId, groupId } = request.params;
      const facts = await service.installFacts(actorOf(request), organizationId, fleetId, groupId);
      return reply.header("cache-control", NO_STORE).send(facts);
    },
  );

  // A download (as a test run's file): never sniffed, never cached, named by
  // the method and arch only (installBundleFileName, the web's too).
  typed.post(
    `${FLEETS_ROUTE}/:fleetId/groups/:groupId/install-bundle`,
    // No 200 schema: the answer is bytes, and a refusal the envelope.
    { preHandler, schema: { params: GroupParamsSchema, body: InstallBundleRequestSchema } },
    async (request, reply) => {
      const { organizationId, fleetId, groupId } = request.params;
      const { fileName, archive } = await service.installBundle(actorOf(request), organizationId, fleetId, groupId, request.body);
      return reply
        .header("content-type", "application/gzip")
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", `attachment; filename="${fileName}"`)
        .header("cache-control", NO_STORE)
        .send(archive);
    },
  );

  // -------------------------------------------------------------------------
  // Quick-deploy links (D17c-2 decisions 4, 5, 22 and 25; Preflight rulings
  // 13, 15, 20 and 25), for every member: the create a write (CSRF), its
  // reply the only one with the link's `url` (its secret), `no-store`; the
  // list a read (ids, times, emails, paths, names: not no-store, as the
  // token history); extend and revoke writes. No reply holds a secret's
  // hash or a typed value; the request log keeps their paths' ids only.

  typed.post(
    `${FLEETS_ROUTE}/:fleetId/groups/:groupId/quick-deploy-links`,
    {
      preHandler,
      schema: {
        params: GroupParamsSchema,
        // By kind (D17d-2 Preflight ruling 11): a Linux link's body (D17c-2's, `kind` absent or "linux") or a Helm values link's.
        body: CreateQuickDeployLinkRequestSchema,
        response: { 201: CreateQuickDeployLinkResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId, groupId } = request.params;
      const created = await service.createQuickDeployLink(actorOf(request), organizationId, fleetId, groupId, request.body);
      return reply.status(201).header("cache-control", NO_STORE).send(created);
    },
  );

  typed.get(
    `${FLEETS_ROUTE}/:fleetId/quick-deploy-links`,
    {
      preHandler,
      schema: {
        params: FleetParamsSchema,
        querystring: ListQuickDeployLinksQuerySchema,
        response: { 200: QuickDeployLinksPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      const { limit, cursor } = request.query;
      return reply.send(
        await service.listQuickDeployLinks(actorOf(request), organizationId, fleetId, { limit, ...(cursor === undefined ? {} : { cursor }) }),
      );
    },
  );

  typed.post(
    `${FLEETS_ROUTE}/:fleetId/quick-deploy-links/:linkId/extend`,
    {
      preHandler,
      schema: {
        params: LinkParamsSchema,
        body: ExtendQuickDeployLinkRequestSchema,
        response: { 200: QuickDeployLinkResponseSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId, linkId } = request.params;
      return reply.send({ link: await service.extendQuickDeployLink(actorOf(request), organizationId, fleetId, linkId, request.body.by) });
    },
  );

  // Idempotent: a revoked link answers as it is (and is audited again).
  typed.post(
    `${FLEETS_ROUTE}/:fleetId/quick-deploy-links/:linkId/revoke`,
    {
      preHandler,
      schema: { params: LinkParamsSchema, response: { 200: QuickDeployLinkResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId, linkId } = request.params;
      return reply.send({ link: await service.revokeQuickDeployLink(actorOf(request), organizationId, fleetId, linkId) });
    },
  );

  // -------------------------------------------------------------------------
  // Collectors (Task 4). The list's `q` and a name-sorted cursor hold a
  // collector's name or address: never logged (request-log.ts's prefix).

  typed.get(
    `${FLEETS_ROUTE}/:fleetId/collectors`,
    {
      preHandler,
      schema: {
        params: FleetParamsSchema,
        querystring: ListCollectorsQuerySchema,
        response: { 200: CollectorsPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      const { q, groupId, sort, order, limit, cursor } = request.query;
      const page = await service.listCollectors(actorOf(request), organizationId, fleetId, {
        limit,
        ...(q === undefined ? {} : { q }),
        ...(groupId === undefined ? {} : { groupId }),
        ...(sort === undefined ? {} : { sort }),
        ...(order === undefined ? {} : { order }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      return reply.header("cache-control", NO_STORE).send(page);
    },
  );

  // Registered before `/:collectorId`'s routes; Fastify prefers the static segment anyway.
  typed.post(
    `${FLEETS_ROUTE}/:fleetId/collectors/pin`,
    {
      preHandler,
      schema: {
        params: FleetParamsSchema,
        body: PinCollectorsRequestSchema,
        response: { 200: PinCollectorsResponseSchema, ...versionWriteErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId } = request.params;
      return reply.send(await service.pinCollectors(actorOf(request), organizationId, fleetId, request.body));
    },
  );

  typed.get(
    `${FLEETS_ROUTE}/:fleetId/collectors/:collectorId`,
    {
      preHandler,
      schema: { params: CollectorParamsSchema, response: { 200: CollectorResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId, collectorId } = request.params;
      const collector = await service.getCollector(actorOf(request), organizationId, fleetId, collectorId);
      return reply.header("cache-control", NO_STORE).send({ collector });
    },
  );

  typed.patch(
    `${FLEETS_ROUTE}/:fleetId/collectors/:collectorId`,
    {
      preHandler,
      schema: {
        params: CollectorParamsSchema,
        body: UpdateCollectorRequestSchema,
        response: { 200: CollectorResponseSchema, ...versionWriteErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId, collectorId } = request.params;
      const collector = await service.updateCollector(actorOf(request), organizationId, fleetId, collectorId, request.body);
      return reply.header("cache-control", NO_STORE).send({ collector });
    },
  );

  typed.delete(
    `${FLEETS_ROUTE}/:fleetId/collectors/:collectorId`,
    {
      preHandler,
      schema: { params: CollectorParamsSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, fleetId, collectorId } = request.params;
      await service.removeCollector(actorOf(request), organizationId, fleetId, collectorId);
      return reply.status(204).send(null);
    },
  );

  typed.get(
    `${FLEETS_ROUTE}/:fleetId/collectors/:collectorId/errors`,
    {
      preHandler,
      schema: {
        params: CollectorParamsSchema,
        querystring: FleetsPageQuerySchema,
        response: { 200: CollectorErrorsPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, fleetId, collectorId } = request.params;
      const { limit, cursor } = request.query;
      const page = await service.listCollectorErrors(actorOf(request), organizationId, fleetId, collectorId, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return reply.header("cache-control", NO_STORE).send(page);
    },
  );

  // -------------------------------------------------------------------------
  // A configuration's fleet usage (Task 4): only a configuration the person can see.

  typed.get(
    FLEET_USAGE_ROUTE,
    {
      preHandler,
      schema: { params: ConfigurationParamsSchema, response: { 200: ConfigurationFleetUsageResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const { organizationId, configurationId } = request.params;
      return reply.send({ usage: await service.fleetUsage(actorOf(request), organizationId, configurationId) });
    },
  );
}
