import {
  ErrorResponseSchema,
  PUBLIC_FLEET_TOKEN_EXPIRY_DAYS,
  PublicCollectorGroupSchema,
  PublicCollectorGroupsSchema,
  PublicCreateCollectorGroupRequestSchema,
  PublicCreateFleetRequestSchema,
  PublicFleetCreatedSchema,
  PublicFleetsPageSchema,
  PublicInstallReplySchema,
  PublicInstallRequestSchema,
  PublicListFleetsQuerySchema,
  PublicUpdateCollectorGroupRequestSchema,
  type UpdateCollectorGroupRequest,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiActorOf } from "../actor.js";
import type { PublicApiArea } from "../area.js";
import {
  fieldRefused,
  kubernetesAnnotationsForCreate,
  kubernetesAnnotationsMerged,
  refuseKubernetesFields,
  toPublicGroup,
} from "./groups.js";

/*
 * The public surface's fleets, their collector groups and install (D25
 * decision 17's routes 17–23; decisions 15, 19, 35–38; Preflight rulings
 * 10 and 11; Rulings 160 and 161), registered into the `/api/public/v1`
 * plugin (routes.ts), so each runs the token check, the per-token limit and
 * its access check first. Each goes through D16b's fleets service, the one
 * instance the browser's routes share (decision 15), as the token's user in
 * its organization (`apiActorOf`), with its limits: a fleet's create and
 * install spend the person's bearer budget. Ids are plain strings, put
 * through `canonicalIdOf` by the service, so a malformed one is the
 * resource's 404. Its OpenAPI fragment is `openapi/fleets.yaml`.
 *
 * Fleet types are the platform's (`server`, `kubernetes-supervisor`);
 * a fleet's collectors are in collector groups (`/groups`), and a group's
 * assignment is named by its configuration and version number (2a's
 * `versionIdOf`, which only a configuration the token's user can see
 * answers).
 *
 * Secrets: a fleet's create answers no bearer (decision 15). Install's
 * reply is a bearer reply (decision 38): its `command` holds the bearer, a
 * quick-deploy link's secret or a Helm values link's, so it is `no-store`,
 * never logged (the request log keeps no public query and no body), never
 * audited (the reveal's row holds ids, `via` and `platform`) and never in
 * an error. A fleet's label and a group's name reach replies only.
 */

const NO_STORE = "no-store";
const DAY_MS = 86_400_000;

/** Any string for each id: the service answers one that isn't a canonical UUID with its 404. */
const FleetParamsSchema = z.object({ fleetId: z.string() });
const GroupParamsSchema = z.object({ fleetId: z.string(), groupId: z.string() });

/** Every route's refusals: the token's 401, a personal token's organization (400, 403), the 404s, the limits and the opamp-server's 503. */
const readErrorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  429: ErrorResponseSchema,
  503: ErrorResponseSchema,
};

/** A write's: a read token's 403 among them, a body over the limit, a conflict (409) and a refusal of the request's (422). */
const writeErrorResponses = { ...readErrorResponses, 409: ErrorResponseSchema, 413: ErrorResponseSchema, 422: ErrorResponseSchema };

export const registerFleetPublicRoutes: PublicApiArea = (api, { deps }) => {
  const { service } = deps.services.fleets;
  const configurations = deps.services.configurations.service;
  const typed = api.withTypeProvider<ZodTypeProvider>();

  // Route 18: a page of the organization's fleets, newest first (decision 19, Preflight ruling 11).
  typed.get(
    "/fleets",
    {
      config: { access: "read" },
      schema: { querystring: PublicListFleetsQuerySchema, response: { 200: PublicFleetsPageSchema, ...readErrorResponses } },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { limit, cursor } = request.query;
      const page = await service.list(actor, actor.context.organizationId, { limit, ...(cursor === undefined ? {} : { cursor }) });
      return reply.send({
        items: page.fleets.map(({ id, label, type, status, createdAt }) => ({ id, label, type, status, createdAt })),
        nextCursor: page.nextCursor,
      });
    },
  );

  // Route 17: the fleet, its Default group and its two tokens (D16b's
  // create, spending the bearer budget as the browser's does), answered
  // with the rotate token's id and expiry and NO bearer (decision 15).
  typed.post(
    "/fleets",
    {
      config: { access: "write" },
      schema: { body: PublicCreateFleetRequestSchema, response: { 201: PublicFleetCreatedSchema, ...writeErrorResponses } },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { label, type, expiresIn } = request.body;
      const days = PUBLIC_FLEET_TOKEN_EXPIRY_DAYS[expiresIn ?? "never"];
      const rotateExpiresAt = days === null ? null : new Date(deps.now().getTime() + days * DAY_MS).toISOString();
      const outcome = await service.create(actor, actor.context.organizationId, { label, type, rotateExpiresAt });
      // No id is sent, so the platform makes one: a retry's "unchanged" can't answer.
      if (outcome.kind !== "created") throw new Error("a fleet's create without an id answered as a retry");
      const { fleet, tokens } = outcome.reply;
      return reply.status(201).header("cache-control", NO_STORE).send({
        id: fleet.id,
        label: fleet.label,
        type: fleet.type,
        tokenId: tokens.rotate.id,
        tokenExpiresAt: tokens.rotate.expiresAt,
      });
    },
  );

  // Route 19: a ready install command (decisions 37 and 38): the service builds it with the shared builders.
  typed.post(
    "/fleets/:fleetId/install",
    {
      config: { access: "write" },
      schema: {
        params: FleetParamsSchema,
        body: PublicInstallRequestSchema,
        response: { 200: PublicInstallReplySchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const answer = await service.installCommand(actor, actor.context.organizationId, request.params.fleetId, request.body);
      return reply.header("cache-control", NO_STORE).send(answer);
    },
  );

  // Route 20: every group of the fleet, the Default group first, in one page (decision 19).
  typed.get(
    "/fleets/:fleetId/groups",
    {
      config: { access: "read" },
      schema: { params: FleetParamsSchema, response: { 200: PublicCollectorGroupsSchema, ...readErrorResponses } },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      // The fleet's type gives each group's role (it never changes).
      const fleet = await service.get(actor, organizationId, request.params.fleetId);
      const groups = await service.listGroups(actor, organizationId, fleet.id);
      return reply.send({ items: groups.map((group) => toPublicGroup(group, fleet.type)), nextCursor: null });
    },
  );

  // Route 21: a group assigned a published version of a configuration the
  // token's user can see (decision 35): its id by number (versionIdOf),
  // then D16b's create, which refuses a draft (422
  // `configuration_version_not_published`) and a taken name (409
  // `collector_group_name_taken`), and checks a Kubernetes group's name.
  typed.post(
    "/fleets/:fleetId/groups",
    {
      config: { access: "write" },
      schema: {
        params: FleetParamsSchema,
        body: PublicCreateCollectorGroupRequestSchema,
        response: { 201: PublicCollectorGroupSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { name, configurationId, versionNumber, role, namespace, replicas } = request.body;
      const fleet = await service.get(actor, organizationId, request.params.fleetId);
      let annotations: Record<string, unknown> | null | undefined;
      if (fleet.type === "kubernetes-supervisor") annotations = kubernetesAnnotationsForCreate(name, { role, namespace, replicas });
      else refuseKubernetesFields({ role, namespace, replicas });
      const assignedVersionId = await configurations.versionIdOf(actor, organizationId, configurationId, versionNumber);
      const group = await service.createGroup(actor, organizationId, fleet.id, {
        name,
        assignedVersionId,
        ...(annotations === undefined ? {} : { annotations }),
      });
      return reply.status(201).send(toPublicGroup(group, fleet.type));
    },
  );

  // Route 22: one group.
  typed.get(
    "/fleets/:fleetId/groups/:groupId",
    {
      config: { access: "read" },
      schema: { params: GroupParamsSchema, response: { 200: PublicCollectorGroupSchema, ...readErrorResponses } },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const fleet = await service.get(actor, organizationId, request.params.fleetId);
      const group = await service.getGroup(actor, organizationId, fleet.id, request.params.groupId);
      return reply.send(toPublicGroup(group, fleet.type));
    },
  );

  // Route 23: a merge (decision 35, Preflight ruling 11): a configuration
  // and a number reassign; a number alone moves to another version of the
  // configuration assigned; `configurationId: null` clears; a Kubernetes
  // group's namespace and a gateway's replicas merged into its settings.
  // The contract refuses a configuration without a number (400).
  typed.patch(
    "/fleets/:fleetId/groups/:groupId",
    {
      config: { access: "write" },
      schema: {
        params: GroupParamsSchema,
        body: PublicUpdateCollectorGroupRequestSchema,
        response: { 200: PublicCollectorGroupSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { name, configurationId, versionNumber, namespace, replicas } = request.body;
      const fleet = await service.get(actor, organizationId, request.params.fleetId);
      const settingsChange = namespace !== undefined || replicas !== undefined;
      if (settingsChange && fleet.type !== "kubernetes-supervisor") refuseKubernetesFields({ namespace, replicas });
      // The group as it is: a number alone keeps its configuration, and settings merge into its own.
      const current =
        settingsChange || (configurationId === undefined && versionNumber !== undefined)
          ? await service.getGroup(actor, organizationId, fleet.id, request.params.groupId)
          : undefined;
      const changes: UpdateCollectorGroupRequest = {};
      if (name !== undefined) changes.name = name;
      if (configurationId === null) changes.assignedVersionId = null;
      else if (configurationId !== undefined) {
        changes.assignedVersionId = await configurations.versionIdOf(actor, organizationId, configurationId, versionNumber as number);
      } else if (versionNumber !== undefined) {
        const assigned = current?.assignedVersion?.configurationId;
        if (assigned === undefined) throw fieldRefused("configurationId", "The group has no configuration assigned: give configurationId with versionNumber.");
        changes.assignedVersionId = await configurations.versionIdOf(actor, organizationId, assigned, versionNumber);
      }
      if (settingsChange && current !== undefined) changes.annotations = kubernetesAnnotationsMerged(current, { namespace, replicas });
      const group = await service.updateGroup(actor, organizationId, fleet.id, current?.id ?? request.params.groupId, changes);
      return reply.send(toPublicGroup(group, fleet.type));
    },
  );
};
