import { Readable } from "node:stream";
import {
  CONFIGURATION_INVALID_MESSAGE,
  ErrorResponseSchema,
  PUBLIC_TEST_RUN_DISTRIBUTION_MISMATCH_MESSAGE,
  PUBLIC_TEST_RUN_PIPELINE_NOT_IN_CONFIGURATION_MESSAGE,
  PUBLIC_TEST_RUN_SAMPLE_FILE_NAME,
  PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES,
  PUBLIC_TEST_RUN_SAMPLE_TOO_LARGE_MESSAGE,
  PUBLIC_TEST_RUN_TEXT_NOT_RUNNABLE_MESSAGE,
  PublicQueuedTestRunSchema,
  PublicQueueTestRunRequestSchema,
  PublicTestRunSchema,
  TestRunYamlSchema,
  type ConfigurationErrorCode,
  type PublicTestRun,
  type ValidationRuleSnapshot,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError } from "../../../errors.js";
import { testRunRateLimited } from "../../test-runs/errors.js";
import type { AnyTestRun } from "../../test-runs/repositories/test-run-repository.js";
import { createValidationRuleCheck } from "../../validation-pipelines/service.js";
import { apiActorOf } from "../actor.js";
import { requireApiTokenAuthentication } from "../authenticate-api-token.js";
import type { PublicApiArea } from "../area.js";
import { hasPipelineKey } from "../yaml-pipelines.js";
import { checkedInlineRules } from "./inline-rules.js";

/*
 * The public surface's test runs (D25 decision 17's routes 26–28;
 * decisions 39 to 44; Q168), registered into the `/api/public/v1` plugin
 * (routes.ts), so each runs the token check, the per-token limit and its
 * access check first. Each goes through the shared test runs and test files
 * services (decision 15: one instance, so the copy places, the runs'
 * limiter and the uploads' are counted once) as the token's user in its
 * organization (`apiActorOf`). Its OpenAPI fragment is
 * `openapi/test-runs.yaml`.
 *
 * `POST /test-runs`, in this order:
 *   1. the body (strict: exactly one source, the pipeline's signal,
 *      exactly one of rules and useSavedRules; Ruling 178), 400; the
 *      sample's size once decoded, UTF-8, at most 1 MiB, 413
 *      `payload_too_large` (the route's body limit is 8 MiB: JSON's escapes
 *      can grow a 1 MiB sample six times; Preflight ruling 17);
 *   2. a version's run: its id by number (`versionIdOf`, the configurations'
 *      404s), its text and pin (`getVersion`), a `distribution` that isn't
 *      its configuration's 400, a text a run can't take 422;
 *   3. the pipeline a key of the text's `service.pipelines`
 *      (`yaml-pipelines.ts`), 422 `configuration_invalid` in fixed words;
 *   4. the cheap refusals (`precheckQueue`, Rulings 178 and 187), before
 *      anything is stored or spent: `useSavedRules` with no saved rules
 *      422, the pin's 400s, the person's waiting runs full 429
 *      `test_run_queue_full`, the tester or the evaluator known down 503;
 *   5. the run's minute (`testRunsPerUser`, 429 `test_run_rate_limited`;
 *      Ruling 187), admitted here, before a rule check or an upload is
 *      spent, and handed to the queue, which doesn't admit again. Any
 *      refusal before the run's input is copied gives it back: steps 6 and
 *      7's here, the queue's own until its copy begins;
 *   6. inline rules checked (inline-rules.ts: `checkNewRules`), before
 *      anything is stored;
 *   7. the sample stored as the caller's test file `api-sample.json`
 *      (decision 41), counted in `testFileUploadsPerUser` first;
 *   8. the run queued from it (a version's run through `queue`, its rules
 *      the request's, or the database's with `useSavedRules`; a YAML run
 *      through `queueFromYaml`), which checks steps 4's again. Any refusal
 *      there removes the sample it stored, which nothing else references;
 *      once queued, a service account's sample is removed too (nobody can
 *      reach it; the run holds its own copy), a person's stays in their My
 *      Files.
 *
 * The text, the sample and the rules are configuration text (Q168): they
 * reach a reply's body alone, never a log line, an error's message, an
 * audit row or a URL. The routes log nothing; the services log ids.
 */

const NO_STORE = "no-store";

/** The queue's body: a JSON-escaped 1 MiB sample, up to six times larger, beside a text and 20 rules (Preflight ruling 17). */
const QUEUE_BODY_LIMIT = 8 * 1024 * 1024;

const RunParamsSchema = z.object({ runId: z.string() });

/** The reads' refusals: a personal token's organization (400, 403), the token's 401, the 404s and the per-token limit. */
const readErrorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  429: ErrorResponseSchema,
};

/** The queue's: a read token's 403, 413 for the body or the sample, 422 for the text, 503 while testing or the rules can't run. */
const queueErrorResponses = {
  ...readErrorResponses,
  413: ErrorResponseSchema,
  422: ErrorResponseSchema,
  503: ErrorResponseSchema,
};

function sampleTooLarge(): AppError {
  return new AppError("payload_too_large", PUBLIC_TEST_RUN_SAMPLE_TOO_LARGE_MESSAGE, 413);
}

function distributionMismatch(): AppError {
  return new AppError("invalid_request", "The request was not valid.", 400, [
    { path: ["distribution"], message: PUBLIC_TEST_RUN_DISTRIBUTION_MISMATCH_MESSAGE },
  ]);
}

/** 422 `configuration_invalid` with one error, in fixed words: never the text, a name or the names it has. */
function runnableTextInvalid(message: string, componentPath: string | null): AppError {
  return new AppError(
    "configuration_invalid" satisfies ConfigurationErrorCode,
    CONFIGURATION_INVALID_MESSAGE,
    422,
    { errors: [{ message, componentPath }] },
    { "cache-control": NO_STORE },
  );
}

/** Ended: succeeded, failed or validation_failed. */
const isEnded = (status: AnyTestRun["status"]) => status !== "queued" && status !== "running";

/** A run as the public surface answers it (decision 43), from D14a's run, one for one. */
function toPublicRun(run: AnyTestRun): PublicTestRun {
  const totalMs = run.timings?.totalMs;
  return {
    id: run.id,
    status: run.status,
    success: isEnded(run.status) ? run.status === "succeeded" : null,
    signal: run.signal,
    pipeline: run.pipeline,
    durationMs: typeof totalMs === "number" ? totalMs : null,
    collectorVersion: run.collectorVersion,
    distribution: run.collectorDistribution,
    // As the dispatcher stored them, within the contract's bounds; the reply's schema checks them.
    validationResults: run.validationResults as PublicTestRun["validationResults"],
    mutations: run.mutations as PublicTestRun["mutations"],
    compatibility: run.compatibility as PublicTestRun["compatibility"],
    errorMessage: run.errorMessage,
    createdAt: run.queuedAt.toISOString(),
  };
}

export const registerTestRunPublicRoutes: PublicApiArea = (api, { deps, rateLimiters }) => {
  const { files, runs } = deps.services.testRuns;
  const { service: configurations } = deps.services.configurations;
  // The Validation tab's check, on the one limiter every surface counts (decision 42).
  const ruleCheck = createValidationRuleCheck({
    evaluator: deps.testing.ottlEvaluator,
    limiter: rateLimiters.validationRuleChecksPerUser,
    log: api.log,
  });
  const typed = api.withTypeProvider<ZodTypeProvider>();

  // Route 26.
  typed.post(
    "/test-runs",
    {
      config: { access: "write" },
      bodyLimit: QUEUE_BODY_LIMIT,
      schema: {
        body: PublicQueueTestRunRequestSchema,
        response: { 202: PublicQueuedTestRunSchema, ...queueErrorResponses },
      },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { organizationId, userId } = actor.context;
      const body = request.body;
      if (Buffer.byteLength(body.sample, "utf8") > PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES) throw sampleTooLarge();

      // 2. The text: the request's, or the version's.
      let source:
        | { kind: "yaml"; yaml: string }
        | { kind: "version"; configurationId: string; versionId: string; yaml: string; distribution: string; collectorVersion: string };
      if (body.yaml !== undefined) {
        source = { kind: "yaml", yaml: body.yaml };
      } else {
        // The body's schema requires both with no `yaml`.
        const configurationId = body.configurationId!;
        const versionId = await configurations.versionIdOf(actor, organizationId, configurationId, body.versionNumber!);
        const { configuration, version } = await configurations.getVersion(actor, organizationId, configurationId, versionId);
        if (body.distribution !== undefined && body.distribution !== configuration.collectorDistribution) {
          throw distributionMismatch();
        }
        if (!TestRunYamlSchema.safeParse(version.yamlContent).success) {
          throw runnableTextInvalid(PUBLIC_TEST_RUN_TEXT_NOT_RUNNABLE_MESSAGE, null);
        }
        source = {
          kind: "version",
          configurationId: configuration.id,
          versionId,
          yaml: version.yamlContent,
          distribution: configuration.collectorDistribution,
          collectorVersion: body.collectorVersion ?? version.collectorVersion,
        };
      }

      // 3. The pipeline is the text's.
      if (!hasPipelineKey(source.yaml, body.pipeline)) {
        throw runnableTextInvalid(PUBLIC_TEST_RUN_PIPELINE_NOT_IN_CONFIGURATION_MESSAGE, "service.pipelines");
      }

      // 4. The cheap refusals, before a sample is stored or a check spent
      // (Ruling 178), each checked again when the run is queued: saved rules
      // to run, the pin, the tester's and (a run with rules always has some)
      // the evaluator's down states.
      await runs.precheckQueue(actor, organizationId, {
        pin:
          source.kind === "version"
            ? { distribution: source.distribution, collectorVersion: source.collectorVersion }
            : { distribution: body.distribution, collectorVersion: body.collectorVersion },
        ...(body.useSavedRules && source.kind === "version"
          ? {
              savedRulesOf: {
                configurationId: source.configurationId,
                versionId: source.versionId,
                pipeline: body.pipeline,
                signal: body.signal,
              },
            }
          : {}),
        hasRules: true,
      });

      // 5. The run's minute, before a check or an upload is spent (Ruling
      // 187); the queue takes it and admits no other.
      const admission = rateLimiters.testRunsPerUser.admit(userId, organizationId);
      if (!admission.isAdmitted) throw testRunRateLimited(admission.retryAfterSeconds);

      let inlineRules: ValidationRuleSnapshot[] | undefined;
      let sample: Awaited<ReturnType<typeof files.save>>;
      try {
        // 6. Inline rules, checked before anything is stored; useSavedRules the database's.
        const ids = source.kind === "version" ? { organizationId, configurationId: source.configurationId, versionId: source.versionId } : { organizationId };
        // The body's schema requires `rules` without `useSavedRules` (Ruling 178).
        inlineRules = body.rules === undefined ? undefined : await checkedInlineRules(ruleCheck, actor, body.signal, body.rules, ids);

        // 7. The sample, as the caller's test file (decision 41).
        rateLimiters.testFileUploadsPerUser(userId, organizationId);
        const { fileId } = await files.prepareSave(actor, organizationId);
        sample = await files.save(actor, organizationId, {
          fileId,
          displayName: PUBLIC_TEST_RUN_SAMPLE_FILE_NAME,
          description: "",
          fileName: PUBLIC_TEST_RUN_SAMPLE_FILE_NAME,
          content: Readable.from([Buffer.from(body.sample, "utf8")]),
          maxBytes: PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES,
          finish: () => Promise.resolve(),
        });
      } catch (error) {
        // Nothing copied yet: the minute goes back (Ruling 187).
        admission.refund();
        throw error;
      }

      // 8. The run, its input copied from the sample as any input is; the
      // queue owns the minute from here (refunded until its copy begins).
      let runId: string;
      try {
        if (source.kind === "version") {
          const queued = await runs.queue(
            actor,
            organizationId,
            source.configurationId,
            source.versionId,
            {
              inputFileId: sample.id,
              pipeline: body.pipeline,
              signal: body.signal,
              durationSeconds: body.durationSeconds,
              yaml: source.yaml,
              collectorVersion: source.collectorVersion,
            },
            inlineRules === undefined ? { requireSavedRules: true, admission } : { inlineRules, admission },
          );
          runId = queued.run.id;
        } else {
          const queued = await runs.queueFromYaml(actor, organizationId, {
            yaml: source.yaml,
            distribution: body.distribution,
            collectorVersion: body.collectorVersion,
            inputFileId: sample.id,
            pipeline: body.pipeline,
            signal: body.signal,
            durationSeconds: body.durationSeconds,
            // A YAML run can't use saved rules (the body's schema), so it has inline ones.
            inlineRules: inlineRules ?? [],
            admission,
          });
          runId = queued.id;
        }
      } catch (error) {
        // Nothing queued: the sample this request stored goes.
        try {
          await files.remove(actor, organizationId, sample.id);
        } catch {
          request.log.warn({ organizationId }, "a refused test run's sample could not be removed");
        }
        throw error;
      }
      // A service account's sample is reachable by no one once the run holds
      // its own copy (no My Files of its own): it goes. A person's stays in
      // their My Files, theirs to delete (decision 41; Ruling 178).
      if (requireApiTokenAuthentication(request).kind === "service_account") {
        try {
          await files.remove(actor, organizationId, sample.id);
        } catch {
          request.log.warn({ organizationId }, "a queued test run's sample could not be removed");
        }
      }
      return reply.status(202).header("cache-control", NO_STORE).send({ id: runId, status: "queued" });
    },
  );

  // Route 27.
  typed.get(
    "/test-runs/:runId",
    {
      config: { access: "read" },
      schema: { params: RunParamsSchema, response: { 200: PublicTestRunSchema, ...readErrorResponses } },
    },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const run = await runs.find(actor, actor.context.organizationId, request.params.runId);
      return reply.header("cache-control", NO_STORE).send(toPublicRun(run));
    },
  );

  // Route 28: the output as text, never sniffed, never cached.
  typed.get(
    "/test-runs/:runId/output",
    // No response schema: the answer is a stream, and a refusal the envelope.
    { config: { access: "read" }, schema: { params: RunParamsSchema } },
    async (request, reply) => {
      const actor = apiActorOf(request);
      const { sizeBytes, stream } = await runs.openOutput(actor, actor.context.organizationId, request.params.runId);
      // The file stays open until the stream ends: a client that goes away first must not leave it open.
      const destroy = () => {
        if (!stream.destroyed) stream.destroy();
      };
      reply.raw.once("close", destroy);
      try {
        return await reply
          .header("content-type", "text/plain; charset=utf-8")
          .header("x-content-type-options", "nosniff")
          .header("cache-control", NO_STORE)
          .header("content-length", sizeBytes)
          .send(stream);
      } catch (error) {
        destroy();
        throw error;
      }
    },
  );
};
