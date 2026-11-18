import { z } from "zod";

// The collector tester's answers, as zod schemas, one for each schema in
// services/otelcol-testing/openapi.yaml the platform reads (D14a decision 1,
// Preflight ruling 1). Unknown fields are stripped rather than refused,
// unlike the file's `additionalProperties: false`, as the validator's are
// (otelcol-validator/schemas.ts): a field the tester adds later must not
// break a platform that hasn't learned it. The fake
// (testing/fake-otelcol-testing.ts) checks the tester's side of the contract
// strictly, against the file itself.
//
// An answer these refuse is a malformed answer, which the client reports as
// unavailable, never as the run's own result.

/** openapi.yaml's request `signal`. */
export const TEST_RUN_SIGNALS = ["traces", "metrics", "logs"] as const;
export type TestRunSignal = (typeof TEST_RUN_SIGNALS)[number];

/** openapi.yaml's request `distribution`: the only one the tester runs. */
export const OTELCOL_TESTING_DISTRIBUTION = "otelcol-contrib";

/** The most bytes a file in an answer (the output, the decoded input) holds: 10 MiB. */
export const MAX_TESTER_FILE_BYTES = 10 * 1024 * 1024;

/** openapi.yaml's `maxLength` of every base64 field: 10 MiB, encoded. */
const MAX_BASE64_CHARACTERS = 13_981_016;

/** How many code points `text` holds, as JSON Schema's `maxLength` counts (zod's `max` counts UTF-16 units). */
function codePointLength(text: string): number {
  let surrogatePairs = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        surrogatePairs += 1;
        index += 1;
      }
    }
  }
  return text.length - surrogatePairs;
}

/** A string of at most `maximum` code points. */
const boundedText = (maximum: number) =>
  z.string().refine((text) => codePointLength(text) <= maximum, { message: `at most ${maximum} characters` });

/**
 * A base64 field (`contentEncoding: base64`), decoded. Only standard,
 * padded base64 is accepted: Node's decoder skips anything else silently,
 * so the bytes are encoded again and must give back the same text.
 */
const base64Bytes = z
  .string()
  .max(MAX_BASE64_CHARACTERS)
  .transform((text, context) => {
    const bytes = Buffer.from(text, "base64");
    if (bytes.toString("base64") !== text) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "isn't standard base64" });
      return z.NEVER;
    }
    if (bytes.byteLength > MAX_TESTER_FILE_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "is larger than 10 MiB decoded" });
      return z.NEVER;
    }
    return bytes;
  });

const nonNegativeInteger = z.number().int().min(0);

/** openapi.yaml's RunAnswer `error.code`. */
export const TEST_RUN_ERROR_CODES = ["refused", "collector_failed", "replay_rejected", "timed_out", "unreadable"] as const;
export type TestRunErrorCode = (typeof TEST_RUN_ERROR_CODES)[number];

/** openapi.yaml's Mutation: a sandbox mutation (R-*) or a fixture-shape advisory (F-*). */
export const mutationSchema = z.object({
  id: z.string().regex(/^[RF]-[0-9]{3}$/),
  severity: z.enum(["info", "caution", "warn"]),
  message: z.string(),
  details: z.record(z.unknown()),
});

/** openapi.yaml's CompatibilityIssue. */
export const compatibilityIssueSchema = z.object({
  id: z.string().regex(/^C-[0-9]{3}$/),
  severity: z.enum(["refuse", "advisory"]),
  component: z.string(),
  message: z.string(),
  details: z.record(z.unknown()),
});

/**
 * openapi.yaml's RunAnswer, its files decoded: `error` is there exactly when
 * `status` is `failed` (the file's if/then/else).
 */
export const runAnswerSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]),
    error: z.object({ code: z.enum(TEST_RUN_ERROR_CODES), message: z.string() }).optional(),
    strategy: z.enum(["otlp", "filelog", "syslog"]).nullable(),
    kwokEnabled: z.boolean(),
    collectorVersion: z.string(),
    logs: boundedText(262_144),
    mutatedYaml: boundedText(1_048_576).nullable(),
    mutations: z.array(mutationSchema),
    compatibility: z.array(compatibilityIssueSchema),
    output: z.object({ base64: base64Bytes, bytesOnDisk: nonNegativeInteger, truncated: z.boolean() }).nullable(),
    decodedInput: z.object({ base64: base64Bytes, truncated: z.boolean() }).nullable(),
    timings: z.object({
      totalMs: nonNegativeInteger,
      readyMs: nonNegativeInteger.nullable(),
      informerMs: nonNegativeInteger.nullable(),
      replayMs: nonNegativeInteger.nullable(),
      holdMs: nonNegativeInteger.nullable(),
      stopMs: nonNegativeInteger.nullable(),
    }),
  })
  .refine((answer) => (answer.status === "failed") === (answer.error !== undefined), {
    message: "error must be there exactly when status is failed",
    path: ["error"],
  });

/** openapi.yaml's error codes. */
export const OTELCOL_TESTING_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "not_found",
  "version_unknown",
  "version_retired",
  "version_unavailable",
  "tester_busy",
  "tester_starting",
  "tester_unavailable",
  "payload_too_large",
  "input_too_large",
  "internal_error",
] as const;
export type OtelcolTestingErrorCode = (typeof OTELCOL_TESTING_ERROR_CODES)[number];

/** openapi.yaml's Error: the envelope every error answers. */
export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.enum(OTELCOL_TESTING_ERROR_CODES), message: z.string() }),
});

/** openapi.yaml's HealthReady (200). */
export const healthReadySchema = z.object({ status: z.literal("ok"), kwok: z.literal("ready") });

/** openapi.yaml's HealthNotReady (503): kwok starting, or failed. */
export const healthNotReadySchema = z.object({
  status: z.enum(["starting", "unavailable"]),
  kwok: z.enum(["starting", "failed"]),
});

export type TesterMutation = z.infer<typeof mutationSchema>;
export type TesterCompatibilityIssue = z.infer<typeof compatibilityIssueSchema>;
export type RunAnswer = z.infer<typeof runAnswerSchema>;
