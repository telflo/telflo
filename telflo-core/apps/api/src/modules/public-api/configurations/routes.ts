import {
  ErrorResponseSchema,
  PublicConfigurationDetailSchema,
  PublicConfigurationsPageSchema,
  PublicConfigurationVersionSchema,
  PublicConfigurationVersionsSchema,
  PublicCreateConfigurationRequestSchema,
  PublicCreateConfigurationVersionRequestSchema,
  PublicListConfigurationsQuerySchema,
  PublicUpdateConfigurationRequestSchema,
  PublicUpdateConfigurationVersionQuerySchema,
  PublicUpdateConfigurationVersionRequestSchema,
  PublicVersionNumberSchema,
  type ConfigurationErrorCode,
  type PublicConfiguration,
  type PublicConfigurationDetail,
  type PublicConfigurationVersion,
  type PublicConfigurationVersionSummary,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError } from "../../../errors.js";
import { decodeCursor } from "../../configurations/cursor.js";
import { configurationVersionPublished } from "../../configurations/errors.js";
import { invalidCursor } from "../../fleets/errors.js";
import type {
  ConfigurationVersion,
  ConfigurationVersionSummary,
} from "../../configurations/repositories/configuration-version-repository.js";
import type { ConfigurationDetail, ConfigurationWithFacts } from "../../configurations/service.js";
import { apiActorOf } from "../actor.js";
import type { PublicApiArea } from "../area.js";
import { collectorVersionRetired, configurationInvalid } from "../shared-errors.js";

/*
 * The public surface's configurations, their versions and publishing,
 * registered into the `/api/public/v1` plugin (routes.ts), so each runs the
 * token check, the per-token limit and its access check before anything
 * else. Each goes through the configurations' shared services as the
 * token's user in its organization (`apiActorOf`), so it sees what that
 * user may see: published configurations and the user's own drafts, never
 * another member's. Versions are addressed by number (`versionIdOf`). Ids
 * are plain strings, put through `canonicalIdOf` by the service, so a
 * malformed one is the resource's 404; a version number that isn't a plain
 * positive integer is 400. Its OpenAPI fragment is
 * `openapi/configurations.yaml`.
 *
 * The YAML and a label go only into a reply's body, never a log line, an
 * error's message or an audit row; a name and a description likewise, but
 * for the services' own audit rows, which record them by design
 * (`configuration.created` the name, `configuration.updated` the changed
 * fields' `{ from, to }`). Every reply is `no-store`: it holds the
 * organization's configuration text.
 */

const NO_STORE = "no-store";

/**
 * The configuration and version writes' body limit: the gateway's on the
 * same paths. 262,144 characters of YAML are at most 1.5 MiB once JSON
 * escapes them; the public surface carries no graph.
 */
const CONTENT_BODY_LIMIT = 2 * 1024 * 1024;

/** Any string: the service answers one that isn't a canonical UUID with 404 configuration_not_found. */
const ConfigurationParamsSchema = z.object({ configurationId: z.string() });

/** And a version's number, a plain positive integer, else 400. */
const VersionParamsSchema = z.object({ configurationId: z.string(), versionNumber: PublicVersionNumberSchema });

/** Every route's refusals: the token's 401, a personal token's organization (400, 403), the 404s and the per-token limit. */
const readErrorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  429: ErrorResponseSchema,
};

/** The list's: no resource to miss, so no 404. */
const listErrorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  429: ErrorResponseSchema,
};

/** A write's: a read token's 403 among them, and a body over the limit. */
const writeErrorResponses = { ...readErrorResponses, 413: ErrorResponseSchema };

/** A version's write: a published one is 409. */
const versionWriteErrorResponses = { ...writeErrorResponses, 409: ErrorResponseSchema };

/** The PATCH with `?validate=true`: 422 for an invalid text, 503 when it couldn't be checked. */
const versionPatchErrorResponses = { ...versionWriteErrorResponses, 422: ErrorResponseSchema, 503: ErrorResponseSchema };

/** A publish: 409 for an empty or changed version, 413 for a body over the limit (the document's), 503 when the opamp-server can't take it. */
const publishErrorResponses = { ...readErrorResponses, 409: ErrorResponseSchema, 413: ErrorResponseSchema, 503: ErrorResponseSchema };

/**
 * A `cursor` the list couldn't have made: the public surface's one bad
 * cursor, the fleets lists' 400 with its details
 * `[{ path: ["cursor"], message }]`. The browser's list keeps its own.
 */
function assertListCursor(cursor: string | undefined): void {
  if (cursor === undefined) return;
  try {
    decodeCursor(cursor);
  } catch (error) {
    if (error instanceof AppError) throw invalidCursor();
    throw error;
  }
}

function toPublicConfiguration({ configuration, facts }: ConfigurationWithFacts, organizationId: string): PublicConfiguration {
  return {
    id: configuration.id,
    name: configuration.name,
    description: configuration.description,
    organizationId,
    isPublished: configuration.published,
    distribution: configuration.collectorDistribution,
    collectorVersion: facts.collectorVersion,
    versionNumber: facts.latestVersionNumber,
    publishedVersionNumber: facts.publishedVersionNumber,
    updatedAt: configuration.updatedAt.toISOString(),
  };
}

function toPublicConfigurationDetail(detail: ConfigurationDetail, organizationId: string): PublicConfigurationDetail {
  return { ...toPublicConfiguration(detail, organizationId), yaml: detail.yamlContent };
}

function toPublicVersionSummary(version: ConfigurationVersionSummary): PublicConfigurationVersionSummary {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.publishedAt === null ? "draft" : "published",
    label: version.label,
    distribution: version.collectorDistribution,
    collectorVersion: version.collectorVersion,
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt === null ? null : version.publishedAt.toISOString(),
  };
}

function toPublicVersion(version: ConfigurationVersion): PublicConfigurationVersion {
  return { ...toPublicVersionSummary(version), configurationId: version.configurationId, yaml: version.yamlContent };
}

export const registerConfigurationPublicRoutes: PublicApiArea = (api, { deps }) => {
  const { service, publishing, validation } = deps.services.configurations;
  const typed = api.withTypeProvider<ZodTypeProvider>();

  // A page of what the token's user can see, most recently updated first (the
  // browser list's cursor), each with its latest version's number and pin and
  // its highest published number, read by one statement.
  typed.get(
    "/configurations",
    {
      config: { access: "read" },
      schema: {
        querystring: PublicListConfigurationsQuerySchema,
        response: { 200: PublicConfigurationsPageSchema, ...listErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      assertListCursor(request.query.cursor);
      const page = await service.listWithFacts(actor, organizationId, request.query);
      return reply.header("cache-control", NO_STORE).send({
        items: page.items.map((item) => toPublicConfiguration(item, organizationId)),
        nextCursor: page.nextCursor,
      });
    },
  );

  // The configuration and its version 1 in one transaction (the service's
  // create), holding the text as given with an empty graph, at the
  // distribution named or the catalogue's default.
  typed.post(
    "/configurations",
    {
      config: { access: "write" },
      bodyLimit: CONTENT_BODY_LIMIT,
      schema: {
        body: PublicCreateConfigurationRequestSchema,
        response: { 201: PublicConfigurationDetailSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { name, yaml, distribution } = request.body;
      const created = await service.create(actor, organizationId, {
        name,
        description: "",
        ...(distribution !== undefined && { collectorDistribution: distribution }),
        content: { yamlContent: yaml, nodes: [], edges: [], pipelines: [] },
      });
      const detail = await service.getDetail(actor, organizationId, created.id);
      return reply.status(201).header("cache-control", NO_STORE).send(toPublicConfigurationDetail(detail, organizationId));
    },
  );

  // One configuration, with its latest version's text.
  typed.get(
    "/configurations/:configurationId",
    {
      config: { access: "read" },
      schema: {
        params: ConfigurationParamsSchema,
        response: { 200: PublicConfigurationDetailSchema, ...readErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const detail = await service.getDetail(actor, organizationId, request.params.configurationId);
      return reply.header("cache-control", NO_STORE).send(toPublicConfigurationDetail(detail, organizationId));
    },
  );

  // The name, the description (null clears it), both or neither.
  typed.patch(
    "/configurations/:configurationId",
    {
      config: { access: "write" },
      schema: {
        params: ConfigurationParamsSchema,
        body: PublicUpdateConfigurationRequestSchema,
        response: { 200: PublicConfigurationDetailSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { name, description } = request.body;
      const updated = await service.update(actor, organizationId, request.params.configurationId, {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
      });
      const detail = await service.getDetail(actor, organizationId, updated.id);
      return reply.header("cache-control", NO_STORE).send(toPublicConfigurationDetail(detail, organizationId));
    },
  );

  // Every version, highest first; small and bounded, so one page.
  typed.get(
    "/configurations/:configurationId/versions",
    {
      config: { access: "read" },
      schema: {
        params: ConfigurationParamsSchema,
        response: { 200: PublicConfigurationVersionsSchema, ...readErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const versions = await service.listVersions(actor, actor.context.organizationId, request.params.configurationId, "all");
      return reply.header("cache-control", NO_STORE).send({ items: versions.map(toPublicVersionSummary), nextCursor: null });
    },
  );

  // The next version, from the latest (its pin, suites and validation
  // pipelines), holding the text as given.
  typed.post(
    "/configurations/:configurationId/versions",
    {
      config: { access: "write" },
      bodyLimit: CONTENT_BODY_LIMIT,
      schema: {
        params: ConfigurationParamsSchema,
        body: PublicCreateConfigurationVersionRequestSchema,
        response: { 201: PublicConfigurationVersionSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { yaml, label } = request.body;
      const version = await service.appendVersion(actor, actor.context.organizationId, request.params.configurationId, {
        yamlContent: yaml,
        label: label ?? undefined,
      });
      return reply.status(201).header("cache-control", NO_STORE).send(toPublicVersion(version));
    },
  );

  // One version by its number, with its text.
  typed.get(
    "/configurations/:configurationId/versions/:versionNumber",
    {
      config: { access: "read" },
      schema: {
        params: VersionParamsSchema,
        response: { 200: PublicConfigurationVersionSchema, ...readErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { configurationId, versionNumber } = request.params;
      const versionId = await service.versionIdOf(actor, organizationId, configurationId, versionNumber);
      const { version } = await service.getVersion(actor, organizationId, configurationId, versionId);
      return reply.header("cache-control", NO_STORE).send(toPublicVersion(version));
    },
  );

  // A draft's text and pin merged over it, the stored graph kept, in one
  // transaction under the configuration's lock (`patchVersion`), so no
  // check-then-update race can arise.
  // With `?validate=true` the merged text is validated first through the
  // validation service and its limit (`validateVersion`, as the editor's
  // check): invalid is 422 `configuration_invalid`, a retired pin 400
  // `collector_version_retired`, and nothing is saved; a save landing
  // between the validation and the write is 409
  // `configuration_version_changed`.
  typed.patch(
    "/configurations/:configurationId/versions/:versionNumber",
    {
      config: { access: "write" },
      bodyLimit: CONTENT_BODY_LIMIT,
      schema: {
        params: VersionParamsSchema,
        querystring: PublicUpdateConfigurationVersionQuerySchema,
        body: PublicUpdateConfigurationVersionRequestSchema,
        response: { 200: PublicConfigurationVersionSchema, ...versionPatchErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { configurationId, versionNumber } = request.params;
      const { yaml, collectorVersion } = request.body;
      const versionId = await service.versionIdOf(actor, organizationId, configurationId, versionNumber);
      // The save the validation read: the PATCH writes only over it, so the
      // text validated is the text saved.
      let validatedAt: Date | undefined;
      if (request.query.validate) {
        const { version } = await service.getVersion(actor, organizationId, configurationId, versionId);
        // A published version is 409 before anything is checked.
        if (version.publishedAt !== null) throw configurationVersionPublished();
        const answer = await validation.validateVersion(actor, organizationId, configurationId, versionId, {
          yaml: yaml ?? version.yamlContent,
          collectorVersion,
        });
        if (answer.status === "retired") throw collectorVersionRetired();
        if (answer.status === "invalid") throw configurationInvalid(answer.errors);
        validatedAt = version.updatedAt;
      }
      // A save landing between the validation and this write is 409
      // `configuration_version_changed`, and nothing is saved.
      const saved = await service.patchVersion(actor, organizationId, configurationId, versionId, {
        yamlContent: yaml,
        collectorVersion,
        ...(validatedAt !== undefined && { expectedUpdatedAt: validatedAt }),
      });
      return reply.header("cache-control", NO_STORE).send(toPublicVersion(saved));
    },
  );

  // The publishing service's publish, with no `expectedUpdatedAt` (the caller
  // has no tab: what is saved is published). It reads first: a published
  // version answers 200 with the configuration unchanged, its published time
  // never restamped; a concurrent publish's 409 is caught and the
  // configuration re-read. An empty text keeps 409
  // `configuration_version_empty`. The answer is the configuration.
  typed.post(
    "/configurations/:configurationId/versions/:versionNumber/publish",
    {
      config: { access: "write" },
      schema: {
        params: VersionParamsSchema,
        response: { 200: PublicConfigurationDetailSchema, ...publishErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId } = actor.context;
      const { configurationId, versionNumber } = request.params;
      const versionId = await service.versionIdOf(actor, organizationId, configurationId, versionNumber);
      const { version } = await service.getVersion(actor, organizationId, configurationId, versionId);
      if (version.publishedAt === null) {
        try {
          await publishing.publishVersion(actor, organizationId, configurationId, versionId);
        } catch (error) {
          // Another publish of it recorded first: published all the same.
          if (!(error instanceof AppError && error.code === ("configuration_version_published" satisfies ConfigurationErrorCode))) {
            throw error;
          }
        }
      }
      const detail = await service.getDetail(actor, organizationId, configurationId);
      return reply.header("cache-control", NO_STORE).send(toPublicConfigurationDetail(detail, organizationId));
    },
  );
};
