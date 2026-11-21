import multipart from "@fastify/multipart";
import {
  CreateTestTemplateFieldsSchema,
  ErrorResponseSchema,
  TEST_FILE_MAXIMUM_BYTES,
  TEST_TEMPLATE_PART_NAMES,
  TestFileNameSchema,
  TestTemplateResponseSchema,
  TestTemplatesResponseSchema,
  UpdateTestTemplateRequestSchema,
  type TestTemplate as TestTemplateResponseBody,
} from "@telflo/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { ServerDependencies } from "../../dependencies.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import {
  createAuthenticate,
  requireAuthentication,
  requireCurrentTerms,
  requireCurrentTermsUnlessProductAdmin,
  requireProductAdmin,
} from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { invalidUpload } from "../test-runs/errors.js";
import { discardUnreadUpload, readUploadParts, uploadPartLimits } from "../test-runs/upload-parts.js";
import { createTestTemplateRepository, type TestTemplate } from "./repositories/test-template-repository.js";
import { createTestTemplateService, type TestTemplateWriter, type WithTestTemplatesTransaction } from "./service.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

export interface TestTemplatesRoutesDependencies extends ServerDependencies {
  now: () => Date;
}

/**
 * Every answer here carries configuration text (a template's names, its
 * bytes), so no cache keeps a copy (docs/conventions/security.md).
 */
const NO_STORE = "no-store";

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/** Any string: one that isn't a canonical UUID is 404 test_template_not_found, not 400. */
const TemplateParamsSchema = z.object({ templateId: z.string() });

const TEMPLATES_ROUTE = "/api/v1/test-templates";

/** A template's names go only into a response body. */
function toResponseBody(template: TestTemplate): TestTemplateResponseBody {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    receiverType: template.receiverType,
    signal: template.signal,
    fileName: template.fileName,
    contentType: template.contentType,
    sizeBytes: template.sizeBytes,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

/** The writer, for the audit row: never their organization (a product admin administers the product). */
function writerOf(request: FastifyRequest): TestTemplateWriter {
  const authentication = requireAuthentication(request);
  return {
    userId: authentication.context.userId,
    email: authentication.email,
    ipAddress: clientIpForAudit(request.ip),
    userAgent: auditUserAgent(request),
  };
}

/**
 * Streams a template's bytes as a test file's reads do: bytes, never
 * sniffed, a download under a generic name (the template's own is
 * configuration text), never cached.
 */
async function sendBytes(
  reply: FastifyReply,
  opened: { sizeBytes: number; stream: Readable },
  disposition: string,
): Promise<FastifyReply> {
  const { stream } = opened;
  // The file stays open until the stream ends: a client that goes away first must not leave it open.
  const destroy = () => {
    if (!stream.destroyed) stream.destroy();
  };
  reply.raw.once("close", destroy);
  try {
    return await reply
      .header("content-type", "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", disposition)
      .header("cache-control", NO_STORE)
      .header("content-length", opened.sizeBytes)
      .send(stream);
  } catch (error) {
    destroy();
    throw error;
  }
}

/**
 * The test templates endpoints:
 *
 *   * `GET /api/v1/test-templates`: the live templates, newest first, at
 *     most 1,000, for a member with the current terms, and for a product
 *     admin with or without them (the admin page's list, as flows').
 *   * `GET /api/v1/test-templates/:templateId/file` and `…/file/head` (the
 *     first 64 KiB): a live template's bytes, for a member with the current
 *     terms, as a test file's reads. Both are counted, the whole file too (a
 *     template is global, readable by every member; only its writes go
 *     uncounted), on the uploads' limiter (testFileUploadsPerUser, 30 a
 *     minute) in a per-person budget of their own (`user:<id>`): a global
 *     route has no organization, so a person's uploads in an organization
 *     neither spend it nor are spent by it. A read is counted before the
 *     template is looked up, so a 404 is counted too.
 *   * `POST /api/v1/test-templates` (multipart), `PATCH` and `DELETE
 *     /api/v1/test-templates/:templateId`: a product admin only (403
 *     `product_admin_required`), without the terms, as flows' writes; each
 *     audited in no organization, with ids only; not rate limited.
 *
 * The upload is in its own encapsulated plugin, the only one here with
 * @fastify/multipart registered: its parser reads nothing, so the body is
 * read in the handler, after `authenticate` and `requireProductAdmin`.
 *
 * Templates are global: every read and write goes through the API's role with
 * no database context and no row-level security.
 */
export function registerTestTemplatesRoutes(
  server: FastifyInstance,
  deps: TestTemplatesRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "testFileUploadsPerUser">,
): void {
  const { db, fileStore, now } = deps;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const productAdmin = [authenticate, requireProductAdmin];
  const memberRead = [authenticate, requireCurrentTerms];
  const withTransaction: WithTestTemplatesTransaction = (work) =>
    db.transaction().execute((transaction) =>
      work({ templates: createTestTemplateRepository(transaction), audit: createAuditRepository(transaction) }),
    );
  const service = createTestTemplateService({
    templates: createTestTemplateRepository(db),
    withTransaction,
    fileStore,
    now,
    log: server.log,
  });
  const typed = server.withTypeProvider<ZodTypeProvider>();

  void server.register(async (scope) => {
    // The upload alone parses multipart/form-data here. The parser only
    // marks the request; the body is read by request.parts() in the handler.
    await scope.register(multipart, {
      limits: { ...uploadPartLimits(TEST_TEMPLATE_PART_NAMES), fileSize: TEST_FILE_MAXIMUM_BYTES },
    });
    // A refused upload may leave its body unread (a part destroyed, the
    // parser stopped at a limit or a refusal): the rest is dropped, so the
    // answer reaches the client and the connection serves its next request.
    scope.addHook("onSend", async (request, reply, payload) => {
      if (reply.statusCode >= 400) discardUnreadUpload(request);
      return payload;
    });

    scope.withTypeProvider<ZodTypeProvider>().post(
      TEMPLATES_ROUTE,
      {
        preHandler: productAdmin,
        schema: {
          response: {
            201: TestTemplateResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            413: ErrorResponseSchema,
            415: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const writer = writerOf(request);
        // The id first, then the parts, in order: nothing of the body is read before the checks above.
        const { templateId } = await service.prepareCreate();
        const parts = await readUploadParts(request, TEST_FILE_MAXIMUM_BYTES, TEST_TEMPLATE_PART_NAMES);
        const fields = CreateTestTemplateFieldsSchema.safeParse(parts.fields);
        const fileName = TestFileNameSchema.safeParse(parts.file.filename);
        if (!fields.success || !fileName.success) {
          parts.file.file.destroy();
          throw invalidUpload();
        }
        const created = await service.create(writer, {
          templateId,
          ...fields.data,
          fileName: fileName.data,
          content: parts.file.file,
          maxBytes: TEST_FILE_MAXIMUM_BYTES,
          finish: parts.finish,
        });
        return reply.status(201).header("cache-control", NO_STORE).send({ template: toResponseBody(created) });
      },
    );
  });

  typed.get(
    TEMPLATES_ROUTE,
    {
      preHandler: [authenticate, requireCurrentTermsUnlessProductAdmin],
      schema: { response: { 200: TestTemplatesResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema } },
    },
    async (_request, reply) => {
      const templates = await service.list();
      return reply.header("cache-control", NO_STORE).send({ templates: templates.map(toResponseBody) });
    },
  );

  typed.patch(
    `${TEMPLATES_ROUTE}/:templateId`,
    {
      preHandler: productAdmin,
      schema: {
        params: TemplateParamsSchema,
        body: UpdateTestTemplateRequestSchema,
        response: {
          200: TestTemplateResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const template = await service.update(writerOf(request), request.params.templateId, request.body);
      return reply.header("cache-control", NO_STORE).send({ template: toResponseBody(template) });
    },
  );

  typed.delete(
    `${TEMPLATES_ROUTE}/:templateId`,
    {
      preHandler: productAdmin,
      schema: {
        params: TemplateParamsSchema,
        response: { 204: noContent, 401: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      await service.remove(writerOf(request), request.params.templateId);
      return reply.status(204).send(null);
    },
  );

  // A template's bytes, whole: counted as the head is, on the uploads'
  // limiter, in the person's own budget for templates.
  typed.get(
    `${TEMPLATES_ROUTE}/:templateId/file`,
    // No response schema: the answer is a stream, and a refusal the envelope.
    { preHandler: memberRead, schema: { params: TemplateParamsSchema } },
    async (request, reply) => {
      rateLimiters.testFileUploadsPerUser(requireAuthentication(request).context.userId, null);
      return sendBytes(reply, await service.openFile(request.params.templateId), 'attachment; filename="template"');
    },
  );

  // The first 64 KiB (the run dialog's fixture-shape check), as a test
  // file's head: counted on the uploads' limiter in a per-person budget of
  // its own, since a global route has no organization.
  typed.get(
    `${TEMPLATES_ROUTE}/:templateId/file/head`,
    // No response schema: the answer is a stream, and a refusal the envelope.
    { preHandler: memberRead, schema: { params: TemplateParamsSchema } },
    async (request, reply) => {
      rateLimiters.testFileUploadsPerUser(requireAuthentication(request).context.userId, null);
      return sendBytes(reply, await service.openHead(request.params.templateId), "attachment");
    },
  );
}
