import { z } from "zod";
import {
  TEST_FILE_CONTENT_TYPE_MAXIMUM_LENGTH,
  TEST_FILE_MAXIMUM_BYTES,
  TEST_FILE_NAME_MAXIMUM_LENGTH,
  TEST_RUN_SIGNALS,
} from "./test-runs.js";
import { trimmedDescriptionSchema, trimmedNameSchema } from "./test-suites.js";

/*
 * The test templates endpoints: a product-wide library of sample inputs,
 * global as flows are.
 *
 * - Members, signed in with the current terms: `GET /api/v1/test-templates`
 *   (the live templates, newest first, at most TEST_TEMPLATES_LIST_MAXIMUM),
 *   `GET /api/v1/test-templates/:templateId/file` and `…/file/head` (the
 *   first TEST_FILE_HEAD_MAXIMUM_BYTES), both as application/octet-stream,
 *   as the test files' reads.
 * - Product admins only (`product_admin_required` otherwise):
 *   `POST /api/v1/test-templates`, multipart/form-data with the parts
 *   TEST_TEMPLATE_PART_NAMES in that order (the file at most
 *   TEST_FILE_MAXIMUM_BYTES, one of TEST_FILE_CONTENT_TYPES' extensions);
 *   `PATCH /api/v1/test-templates/:templateId` (metadata only);
 *   `DELETE …/:templateId` (soft; the bytes
 *   removed, since definitions and runs keep their own copies).
 *
 * A template's name, description and file name are configuration text: JSON
 * bodies only, never a URL, a log line or an audit row. Their bounds are
 * migration 029's checks.
 */

/** A template's name, after trimming: 1 to 200 characters (ck_test_templates_name_length). */
export const TEST_TEMPLATE_NAME_MAXIMUM_LENGTH = 200;

/** A template's description, after trimming: at most 2,000 characters; `''` is none. */
export const TEST_TEMPLATE_DESCRIPTION_MAXIMUM_LENGTH = 2_000;

/** The most templates `GET /api/v1/test-templates` lists, newest first. */
export const TEST_TEMPLATES_LIST_MAXIMUM = 1_000;

/**
 * The receiver types a template may name: the palette's 18 receivers
 * (apps/web/app/lib/graph/palette.ts), their `subType`s in its order. The
 * web shows each by its palette label, the raw value as a fallback; a web
 * test checks the two lists agree.
 */
export const TEST_TEMPLATE_RECEIVER_TYPES = [
  "otlp",
  "prometheus",
  "filelog",
  "fluentforward",
  "docker_stats",
  "hostmetrics",
  "jaeger",
  "zipkin",
  "datadog",
  "k8s_cluster",
  "k8s_events",
  "k8sobjects",
  "kubeletstats",
  "netflow",
  "journald",
  "syslog",
  "statsd",
  "awss3",
] as const;

export type TestTemplateReceiverType = (typeof TEST_TEMPLATE_RECEIVER_TYPES)[number];

/** The multipart parts of a template's upload, in the only order accepted. */
export const TEST_TEMPLATE_PART_NAMES = ["name", "description", "receiverType", "signal", "file"] as const;

export const TestTemplateNameSchema = trimmedNameSchema(TEST_TEMPLATE_NAME_MAXIMUM_LENGTH);

export const TestTemplateDescriptionSchema = trimmedDescriptionSchema(TEST_TEMPLATE_DESCRIPTION_MAXIMUM_LENGTH);

/** One of TEST_TEMPLATE_RECEIVER_TYPES, exactly. */
export const TestTemplateReceiverTypeSchema = z.enum(TEST_TEMPLATE_RECEIVER_TYPES);

/**
 * The text parts of `POST /api/v1/test-templates`, as the API reads them
 * from the multipart body (the file is the last part, and is not here).
 * Strict.
 */
export const CreateTestTemplateFieldsSchema = z
  .object({
    name: TestTemplateNameSchema,
    description: TestTemplateDescriptionSchema,
    receiverType: TestTemplateReceiverTypeSchema,
    signal: z.enum(TEST_RUN_SIGNALS),
  })
  .strict();

export type CreateTestTemplateFields = z.infer<typeof CreateTestTemplateFieldsSchema>;

/**
 * `PATCH /api/v1/test-templates/:templateId`, product admins only: the
 * metadata (the template dialog in edit mode); a field left out
 * stays as it is. The file never changes. Strict.
 */
export const UpdateTestTemplateRequestSchema = z
  .object({
    name: TestTemplateNameSchema.optional(),
    description: TestTemplateDescriptionSchema.optional(),
    receiverType: TestTemplateReceiverTypeSchema.optional(),
    signal: z.enum(TEST_RUN_SIGNALS).optional(),
  })
  .strict();

export type UpdateTestTemplateRequest = z.infer<typeof UpdateTestTemplateRequestSchema>;

/**
 * A live template. `receiverType` is checked as the table checks it, not
 * against the list: a stored row always serializes. `fileName` is the
 * upload's own name, with its extension (downloads are named by it).
 * The timestamps are ISO 8601, from the API's clock.
 */
export const TestTemplateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(TEST_TEMPLATE_NAME_MAXIMUM_LENGTH),
    description: z.string().max(TEST_TEMPLATE_DESCRIPTION_MAXIMUM_LENGTH),
    receiverType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    signal: z.enum(TEST_RUN_SIGNALS),
    fileName: z.string().max(TEST_FILE_NAME_MAXIMUM_LENGTH),
    contentType: z.string().max(TEST_FILE_CONTENT_TYPE_MAXIMUM_LENGTH),
    sizeBytes: z.number().int().min(0).max(TEST_FILE_MAXIMUM_BYTES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type TestTemplate = z.infer<typeof TestTemplateSchema>;

/** `GET /api/v1/test-templates`: the live templates, newest first, at most TEST_TEMPLATES_LIST_MAXIMUM. */
export const TestTemplatesResponseSchema = z.object({ templates: z.array(TestTemplateSchema) }).strict();

export type TestTemplatesResponse = z.infer<typeof TestTemplatesResponseSchema>;

/** `POST /api/v1/test-templates` (201) and `PATCH …/:templateId`: the template. */
export const TestTemplateResponseSchema = z.object({ template: TestTemplateSchema }).strict();

export type TestTemplateResponse = z.infer<typeof TestTemplateResponseSchema>;
