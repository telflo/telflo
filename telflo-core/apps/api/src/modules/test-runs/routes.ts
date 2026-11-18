import multipart from "@fastify/multipart";
import {
  ErrorResponseSchema,
  QueueTestRunRequestSchema,
  TEST_FILE_MAXIMUM_BYTES,
  TEST_FILE_PART_NAMES,
  TEST_RUN_FILES,
  TEST_SAMPLE_FORMAT_BY_PART_TYPE,
  TEST_SAMPLE_MAXIMUM_BYTES,
  TestFileDescriptionSchema,
  TestFileDisplayNameSchema,
  TestFileNameSchema,
  TestFileResponseSchema,
  TestFilesResponseSchema,
  testFileContentTypeOf,
  TestRunResponseSchema,
  TestRunsResponseSchema,
  testSampleFileName,
  type TestFile as TestFileResponseBody,
  type TestRunDetail,
  type TestRunFile,
  type TestRunSummary as TestRunSummaryResponseBody,
} from "@telflo/contracts";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { readOtelcolTestingDownSince } from "../../otelcol-testing/health-monitor.js";
import { isOttlEvaluatorKnownDown } from "../../ottl-evaluator/health-monitor.js";
import { createCollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import { createConfigurationRepository } from "../configurations/repositories/configuration-repository.js";
import { createConfigurationVersionRepository } from "../configurations/repositories/configuration-version-repository.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createMemberRepository } from "../organizations/repositories/member-repository.js";
import { createActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import { actorOf } from "../organizations/routes.js";
import { assertActiveOrganization } from "../organizations/service.js";
import { createAuthenticate, requireCurrentTerms } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { createTestDefinitionRepository } from "../test-suites/repositories/test-definition-repository.js";
import { createTestTemplateRepository } from "../test-templates/repositories/test-template-repository.js";
import { createCopyPlaces } from "./copy-places.js";
import { invalidUpload, testRunFileNotFound } from "./errors.js";
import { createTestInputFileRepository, type TestInputFile } from "./repositories/test-input-file-repository.js";
import { createTestRunRepository, type TestRun, type TestRunSummary } from "./repositories/test-run-repository.js";
import { createTestFileService } from "./test-file-service.js";
import { createTestRunService, type TestRunWithPlace } from "./test-run-service.js";
import type { WithTestRunsTransaction } from "./transaction.js";
import { discardUnreadUpload, readUploadParts, uploadPartLimits } from "./upload-parts.js";

/** What the test files and runs services are built from, once, in buildServer (D25 decision 15, Preflight ruling 4). */
export interface TestRunsServicesDependencies extends ServerDependencies {
  now: () => Date;
}

/** The test files and runs services, one instance each, shared by the browser routes here and the public routes (D25 decision 15). */
export interface TestRunsServices {
  files: ReturnType<typeof createTestFileService>;
  runs: ReturnType<typeof createTestRunService>;
}

export interface TestRunsRoutesDependencies extends TestRunsServicesDependencies {
  /** buildServer's shared instances (createTestRunsServices). */
  services: { testRuns: TestRunsServices };
}

/**
 * A queue request's body (decision 28): the text, 262,144 characters, up to
 * 1.5 MiB once JSON escapes them, as a validation's, with nothing else of
 * size. The gateway allows the same on its path.
 */
const QUEUE_BODY_LIMIT = 2 * 1024 * 1024;

// The queue checks the session in `onRequest`, before Fastify reads the
// body (D36-1 decision 42, Preflight ruling 9): a request without a valid
// session is 401 whatever its body, never 413 (only the server-wide CSRF
// guard runs before it). The Terms check stays in `preHandler`.

/**
 * Every answer here carries private text (a file's names, a run's text, its
 * logs, its input), so no cache keeps a copy (docs/conventions/security.md).
 */
const NO_STORE = "no-store";

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

/** An upload's refusals: a read's, 413 past the size, 415 for the type, 429 for the person's uploads. */
const uploadErrorResponses = { ...errorResponses, 413: ErrorResponseSchema, 415: ErrorResponseSchema, 429: ErrorResponseSchema };

/** A queue's refusals: a read's, 429 for the person's limits, 503 while the tester (or, for a run with rules, the OTTL evaluator) is down. */
const queueErrorResponses = { ...errorResponses, 429: ErrorResponseSchema, 503: ErrorResponseSchema };

/** Any string for every id: one naming nothing the caller can see is the same 404, never a 400 (D5 decision 7). */
const OrganizationParamsSchema = z.object({ organizationId: z.string() });
const TestFileParamsSchema = z.object({ organizationId: z.string(), fileId: z.string() });
const VersionParamsSchema = z.object({ organizationId: z.string(), configurationId: z.string(), versionId: z.string() });
const RunParamsSchema = VersionParamsSchema.extend({ runId: z.string() });
const RunFileParamsSchema = RunParamsSchema.extend({ file: z.string() });

const TEST_FILES_ROUTE = "/api/v1/organizations/:organizationId/test-files";
const TEST_RUNS_ROUTE = "/api/v1/organizations/:organizationId/configurations/:configurationId/versions/:versionId/test-runs";

/** A file's names and description go only into a response body (ADR 0024). */
function toTestFileResponseBody(file: TestInputFile): TestFileResponseBody {
  return {
    id: file.id,
    displayName: file.displayName,
    fileName: file.fileName,
    description: file.description,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    createdAt: file.createdAt.toISOString(),
  };
}

/** A run as the list shows it (Preflight ruling 15). */
function toSummaryResponseBody({ run, ahead }: TestRunWithPlace<TestRunSummary>): TestRunSummaryResponseBody {
  return {
    id: run.id,
    status: run.status,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt === null ? null : run.startedAt.toISOString(),
    finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
    ahead: run.status === "queued" ? ahead : null,
    pipeline: run.pipeline,
    signal: run.signal,
    durationSeconds: run.durationSeconds,
    collectorVersion: run.collectorVersion,
    queuedByUserId: run.queuedByUserId,
    inputName: run.inputName,
    errorCode: run.errorCode,
    // The breadcrumb (D14b Preflight ruling 20): configuration text, in the body only.
    suiteId: run.suiteId,
    suiteName: run.suiteName,
    definitionId: run.definitionId,
    definitionName: run.definitionName,
  };
}

/**
 * A run in full. The results are copied as the dispatcher stored them,
 * within the contract's bounds (Task 8 cuts them to it); the response's
 * schema checks them on the way out.
 */
function toDetailResponseBody(placed: TestRunWithPlace<TestRun>): TestRunDetail {
  const { run } = placed;
  return {
    ...toSummaryResponseBody(placed),
    configurationId: run.configurationId,
    versionId: run.versionId,
    sourceRunId: run.sourceRunId,
    yaml: run.yaml,
    collectorDistribution: run.collectorDistribution,
    inputSizeBytes: run.inputSizeBytes,
    // From the input's name, as the file's type was (Preflight ruling 10).
    inputContentType: testFileContentTypeOf(run.inputName) ?? "application/octet-stream",
    strategy: run.strategy as TestRunDetail["strategy"],
    kwokEnabled: run.kwokEnabled,
    mutatedYaml: run.mutatedYaml,
    mutations: run.mutations as TestRunDetail["mutations"],
    compatibility: run.compatibility as TestRunDetail["compatibility"],
    logs: run.logs,
    timings: run.timings as TestRunDetail["timings"],
    errorMessage: run.errorMessage,
    outputSizeBytes: run.outputSizeBytes,
    outputTruncated: run.outputTruncated,
    decodedInputSizeBytes: run.decodedInputSizeBytes,
    decodedInputTruncated: run.decodedInputTruncated,
    // The rules' snapshot and results (D15a Preflight ruling 25), as the
    // queue and the dispatcher stored them; the response's schema checks
    // them on the way out. Configuration text, in the body only.
    validationRules: run.validationRules as TestRunDetail["validationRules"],
    validationResults: run.validationResults as TestRunDetail["validationResults"],
  };
}

/**
 * The test files and runs services (D25 Preflight ruling 4), moved verbatim
 * from the routes: built once in buildServer and shared by the browser and
 * the public routes, so the copy places (resolved once here) and the run
 * limiter are never doubled.
 */
export function createTestRunsServices(
  deps: TestRunsServicesDependencies,
  rateLimiters: Pick<RateLimiters, "testRunsPerUser">,
  log: FastifyBaseLogger,
): TestRunsServices {
  const { db, fileStore, testing } = deps;
  const withTransaction: WithTestRunsTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) => {
      const scope = { organizationId: context.organizationId };
      // The viewer is the database context's user, so the repositories'
      // filters and row-level security see the same rows.
      const viewer = { organizationId: context.organizationId, userId: context.userId };
      return work({
        organization: createActiveOrganizationRepository(transaction, scope),
        members: createMemberRepository(transaction, scope),
        configurations: createConfigurationRepository(transaction, viewer),
        versions: createConfigurationVersionRepository(transaction, viewer),
        catalogue: createCollectorCatalogueRepository(transaction),
        files: createTestInputFileRepository(transaction, viewer),
        runs: createTestRunRepository(transaction, viewer),
        definitions: createTestDefinitionRepository(transaction, viewer),
        templates: createTestTemplateRepository(transaction),
        audit: createAuditRepository(transaction),
      });
    });
  const files = createTestFileService({ withTransaction, fileStore, log });
  const runs = createTestRunService({
    withTransaction,
    fileStore,
    limiter: rateLimiters.testRunsPerUser,
    copyPlaces: testing.copyPlaces ?? createCopyPlaces(),
    readDownSince: () => readOtelcolTestingDownSince(db),
    isRulesEvaluatorDown: () => isOttlEvaluatorKnownDown(db),
    organizationVariables: testing.organizationVariables,
    queued: testing.queued,
    log,
  });
  return { files, runs };
}

/**
 * The test files and runs endpoints (D14a decision 28; Preflight rulings
 * 10, 13 and 15). Each needs a session and the current terms; each
 * re-reads the caller's membership under the organization's lock, as the
 * configurations' writes do; each answers 404 for anything the caller
 * can't see: another organization, another person's file, another
 * member's draft's runs, a deleted configuration's runs. Each transaction
 * carries the request's `AuthContext`, so row-level security on
 * test_input_files and test_runs admits the same rows the repositories do.
 *
 * Uploads and samples (multipart) are in their own encapsulated plugin,
 * the only one with @fastify/multipart registered: its parser reads
 * nothing, so the body is read in the handler, after `authenticate`.
 *
 * File names and the text travel only in the JSON bodies: never in a URL,
 * a log line or an audit row.
 */
export function registerTestRunsRoutes(
  server: FastifyInstance,
  deps: TestRunsRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "testFileUploadsPerUser">,
): void {
  const { files, runs } = deps.services.testRuns;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const preHandler = [authenticate, requireCurrentTerms];

  /**
   * An upload's or a sample's save: the organization, the person's uploads
   * and their membership are checked before any byte is read; then the
   * parts, in order; then the bytes, then the row.
   */
  async function saveUpload(request: FastifyRequest, reply: FastifyReply, organizationId: string, kind: "upload" | "sample") {
    const actor = actorOf(request);
    assertActiveOrganization(actor, organizationId);
    rateLimiters.testFileUploadsPerUser(actor.context.userId, actor.context.organizationId);
    const { fileId } = await files.prepareSave(actor, organizationId);
    const maxBytes = kind === "upload" ? TEST_FILE_MAXIMUM_BYTES : TEST_SAMPLE_MAXIMUM_BYTES;
    const parts = await readUploadParts(request, maxBytes, TEST_FILE_PART_NAMES);
    // The fields, checked with the contract before a byte of the file is read.
    const displayName = TestFileDisplayNameSchema.safeParse(parts.fields.displayName);
    const description = TestFileDescriptionSchema.safeParse(parts.fields.description);
    if (!displayName.success || !description.success) {
      parts.file.file.destroy();
      throw invalidUpload();
    }
    let fileName: string;
    if (kind === "upload") {
      const parsed = TestFileNameSchema.safeParse(parts.file.filename);
      if (!parsed.success) {
        parts.file.file.destroy();
        throw invalidUpload();
      }
      fileName = parsed.data;
    } else {
      // The sample's format is its file part's type; only the default
      // extension depends on it.
      const format = Object.hasOwn(TEST_SAMPLE_FORMAT_BY_PART_TYPE, parts.file.mimetype)
        ? TEST_SAMPLE_FORMAT_BY_PART_TYPE[parts.file.mimetype as keyof typeof TEST_SAMPLE_FORMAT_BY_PART_TYPE]
        : undefined;
      const named =
        format === undefined ? undefined : TestFileNameSchema.safeParse(testSampleFileName(displayName.data, format));
      if (named === undefined || !named.success) {
        parts.file.file.destroy();
        throw invalidUpload();
      }
      fileName = named.data;
    }
    const saved = await files.save(actor, organizationId, {
      fileId,
      displayName: displayName.data,
      description: description.data,
      fileName,
      content: parts.file.file,
      maxBytes,
      finish: parts.finish,
    });
    return reply.status(201).header("cache-control", NO_STORE).send({ file: toTestFileResponseBody(saved) });
  }

  void server.register(async (scope) => {
    // These routes alone parse multipart/form-data. The parser only marks
    // the request; the body is read by request.parts() in the handler.
    await scope.register(multipart, {
      limits: { ...uploadPartLimits(TEST_FILE_PART_NAMES), fileSize: TEST_FILE_MAXIMUM_BYTES },
    });
    // A refused upload may leave its body unread (a part destroyed, the
    // parser stopped at a limit or a refusal): the rest is dropped, so the
    // answer reaches the client and the connection serves its next request.
    scope.addHook("onSend", async (request, reply, payload) => {
      if (reply.statusCode >= 400) discardUnreadUpload(request);
      return payload;
    });
    const typed = scope.withTypeProvider<ZodTypeProvider>();

    typed.get(
      TEST_FILES_ROUTE,
      {
        preHandler,
        schema: { params: OrganizationParamsSchema, response: { 200: TestFilesResponseSchema, ...errorResponses } },
      },
      async (request, reply) => {
        const found = await files.list(actorOf(request), request.params.organizationId);
        return reply.header("cache-control", NO_STORE).send({ files: found.map(toTestFileResponseBody) });
      },
    );

    typed.post(
      TEST_FILES_ROUTE,
      {
        preHandler,
        schema: { params: OrganizationParamsSchema, response: { 201: TestFileResponseSchema, ...uploadErrorResponses } },
      },
      (request, reply) => saveUpload(request, reply, request.params.organizationId, "upload"),
    );

    typed.post(
      `${TEST_FILES_ROUTE}/samples`,
      {
        preHandler,
        schema: { params: OrganizationParamsSchema, response: { 201: TestFileResponseSchema, ...uploadErrorResponses } },
      },
      (request, reply) => saveUpload(request, reply, request.params.organizationId, "sample"),
    );

    // The first 64 KiB of the caller's own file (Ruling 43), for a preview:
    // bytes, never sniffed, under no file name, never cached. Counted with
    // the uploads, the person's one budget for test files in the
    // organization (D14b Preflight ruling 22).
    typed.get(
      `${TEST_FILES_ROUTE}/:fileId/head`,
      // No response schema: the answer is a stream, and a refusal the envelope.
      { preHandler, schema: { params: TestFileParamsSchema } },
      async (request, reply) => {
        const actor = actorOf(request);
        const { organizationId, fileId } = request.params;
        assertActiveOrganization(actor, organizationId);
        rateLimiters.testFileUploadsPerUser(actor.context.userId, actor.context.organizationId);
        const { sizeBytes, stream } = await files.openHead(actor, organizationId, fileId);
        const destroy = () => {
          if (!stream.destroyed) stream.destroy();
        };
        reply.raw.once("close", destroy);
        try {
          return await reply
            .header("content-type", "application/octet-stream")
            .header("x-content-type-options", "nosniff")
            .header("content-disposition", "attachment")
            .header("cache-control", NO_STORE)
            .header("content-length", sizeBytes)
            .send(stream);
        } catch (error) {
          destroy();
          throw error;
        }
      },
    );

    typed.delete(
      `${TEST_FILES_ROUTE}/:fileId`,
      { preHandler, schema: { params: TestFileParamsSchema, response: { 204: noContent, ...errorResponses } } },
      async (request, reply) => {
        await files.remove(actorOf(request), request.params.organizationId, request.params.fileId);
        return reply.status(204).send(null);
      },
    );
  });

  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.post(
    TEST_RUNS_ROUTE,
    {
      onRequest: authenticate,
      preHandler: requireCurrentTerms,
      bodyLimit: QUEUE_BODY_LIMIT,
      schema: {
        params: VersionParamsSchema,
        body: QueueTestRunRequestSchema,
        response: { 201: TestRunResponseSchema, ...queueErrorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, configurationId, versionId } = request.params;
      const queued = await runs.queue(actorOf(request), organizationId, configurationId, versionId, request.body);
      return reply.status(201).header("cache-control", NO_STORE).send({ run: toDetailResponseBody(queued) });
    },
  );

  typed.get(
    TEST_RUNS_ROUTE,
    { preHandler, schema: { params: VersionParamsSchema, response: { 200: TestRunsResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      const { organizationId, configurationId, versionId } = request.params;
      const listed = await runs.list(actorOf(request), organizationId, configurationId, versionId);
      return reply.header("cache-control", NO_STORE).send({ runs: listed.map(toSummaryResponseBody) });
    },
  );

  typed.get(
    `${TEST_RUNS_ROUTE}/:runId`,
    { preHandler, schema: { params: RunParamsSchema, response: { 200: TestRunResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      const { organizationId, configurationId, versionId, runId } = request.params;
      const found = await runs.get(actorOf(request), organizationId, configurationId, versionId, runId);
      return reply.header("cache-control", NO_STORE).send({ run: toDetailResponseBody(found) });
    },
  );

  // A run's file, streamed as bytes (Preflight ruling 10): never sniffed,
  // always a download under a generic name (the input's own name is
  // private text, and travels only in the run's JSON), never cached.
  typed.get(
    `${TEST_RUNS_ROUTE}/:runId/files/:file`,
    // No response schema: the answer is a stream, and a refusal the envelope.
    { preHandler, schema: { params: RunFileParamsSchema } },
    async (request, reply) => {
      const { organizationId, configurationId, versionId, runId, file } = request.params;
      if (!(TEST_RUN_FILES as readonly string[]).includes(file)) throw testRunFileNotFound();
      const opened = await runs.openFile(
        actorOf(request),
        organizationId,
        configurationId,
        versionId,
        runId,
        file as TestRunFile,
      );
      const { stream } = opened;
      // The file stays open until the stream ends: a client that goes away
      // first must not leave it open.
      const destroy = () => {
        if (!stream.destroyed) stream.destroy();
      };
      reply.raw.once("close", destroy);
      try {
        return await reply
          .header("content-type", "application/octet-stream")
          .header("x-content-type-options", "nosniff")
          .header("content-disposition", `attachment; filename="${file}"`)
          .header("cache-control", NO_STORE)
          .header("content-length", opened.sizeBytes)
          .send(stream);
      } catch (error) {
        destroy();
        throw error;
      }
    },
  );

  // The first 64 KiB of a run's input (D14a Ruling 46), for the fixture-shape
  // check before a re-run, as a test file's head is (Ruling 43): bytes, never
  // sniffed, under no file name, never cached, counted with the uploads.
  typed.get(
    `${TEST_RUNS_ROUTE}/:runId/files/input/head`,
    // No response schema: the answer is a stream, and a refusal the envelope.
    { preHandler, schema: { params: RunParamsSchema } },
    async (request, reply) => {
      const actor = actorOf(request);
      const { organizationId, configurationId, versionId, runId } = request.params;
      assertActiveOrganization(actor, organizationId);
      rateLimiters.testFileUploadsPerUser(actor.context.userId, actor.context.organizationId);
      const { sizeBytes, stream } = await runs.openInputHead(actor, organizationId, configurationId, versionId, runId);
      const destroy = () => {
        if (!stream.destroyed) stream.destroy();
      };
      reply.raw.once("close", destroy);
      try {
        return await reply
          .header("content-type", "application/octet-stream")
          .header("x-content-type-options", "nosniff")
          .header("content-disposition", "attachment")
          .header("cache-control", NO_STORE)
          .header("content-length", sizeBytes)
          .send(stream);
      } catch (error) {
        destroy();
        throw error;
      }
    },
  );
}
