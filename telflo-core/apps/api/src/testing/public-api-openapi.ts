import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { PUBLIC_API_PREFIX } from "../modules/public-api/plugin.js";
import { publicApiDocument, type PublicApiDocument } from "../modules/public-api/openapi/document.js";

/*
 * The public surface's OpenAPI document, for tests (D25 decision 49,
 * Preflight ruling 19): every reply a public-route integration test
 * receives is checked against the document with ajv 2020, as
 * opamp-server/schemas-bounds.test.ts checks the opamp-server's (strict,
 * every error, union types; the document's components under one `$id`);
 * and the routes the server registers are mapped onto the document's
 * operations for the coverage test.
 */

const SCHEMAS_ID = "https://api.telflo.invalid/public/v1/openapi.json";

/** HTTP methods an OpenAPI path item may hold. */
const OPERATION_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** One operation of the document. */
export interface DocumentedOperation {
  method: string;
  /** The document's path, `{param}`s, without the server's prefix. */
  path: string;
  /** Its `x-telflo-access`, as written. */
  access: unknown;
}

/** Every operation of a document, as `METHOD path`. */
export function documentedOperations(document: PublicApiDocument = publicApiDocument()): DocumentedOperation[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    OPERATION_METHODS.filter((method) => method in item).map((method) => ({
      method: method.toUpperCase(),
      path,
      access: item[method]!["x-telflo-access"],
    })),
  );
}

/**
 * A Fastify route's URL as the document spells it (Preflight ruling 19):
 * the prefix dropped, `:param` → `{param}`, and the wildcard `*` (route
 * 14's pipeline name, which holds `/`) → `{pipeline}`.
 */
export function documentPathOf(routeUrl: string): string {
  const path = routeUrl.startsWith(PUBLIC_API_PREFIX) ? routeUrl.slice(PUBLIC_API_PREFIX.length) : routeUrl;
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*$/, "{pipeline}");
}

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === "$ref" && typeof value === "string" ? value.replace("#/components/schemas/", `${SCHEMAS_ID}#/$defs/`) : rewriteRefs(value),
    ]),
  );
}

let ajv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

/** One ajv for the served document's schemas, made on first use. */
function ajvOf(document: PublicApiDocument): Ajv2020 {
  if (ajv === undefined) {
    ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    ajv.addFormat("uuid", /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
    ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    ajv.addVocabulary(["example"]);
    ajv.addSchema({ $id: SCHEMAS_ID, $defs: rewriteRefs(document.components.schemas ?? {}) as object });
  }
  return ajv;
}

/** A response object, its `$ref` to `#/components/responses/…` followed. */
function responseOf(document: PublicApiDocument, response: unknown): Record<string, unknown> | undefined {
  if (response === null || typeof response !== "object") return undefined;
  const ref = (response as { $ref?: unknown }).$ref;
  if (typeof ref !== "string") return response as Record<string, unknown>;
  const name = ref.replace("#/components/responses/", "");
  return document.components.responses?.[name] as Record<string, unknown> | undefined;
}

export interface PublicReplyValidation {
  isValid: boolean;
  /**
   * Why not: the operation or status the document lacks, or ajv's errors
   * (each an instance path and ajv's words, never the reply's values, so a
   * failure prints no token or bearer).
   */
  errors: string[];
}

/**
 * Whether a reply of the route `routeUrl` (Fastify's, prefix and
 * `:params`) to `method`, with `statusCode`, is one the document allows:
 * the operation exists, documents the status, and the JSON body matches
 * its schema. `body` is the parsed JSON.
 */
export function validatePublicReply(
  method: string,
  routeUrl: string,
  statusCode: number,
  body: unknown,
): PublicReplyValidation {
  const document = publicApiDocument();
  const path = documentPathOf(routeUrl);
  const operation = document.paths[path]?.[method.toLowerCase()];
  if (operation === undefined) return { isValid: false, errors: [`no operation ${method.toUpperCase()} ${path}`] };
  const responses = (operation.responses ?? {}) as Record<string, unknown>;
  const response = responseOf(document, responses[String(statusCode)] ?? responses.default);
  if (response === undefined) return { isValid: false, errors: [`${method.toUpperCase()} ${path} documents no ${statusCode}`] };
  const schema = (response.content as Record<string, { schema?: unknown }> | undefined)?.["application/json"]?.schema;
  if (schema === undefined) {
    return body === undefined || body === ""
      ? { isValid: true, errors: [] }
      : { isValid: false, errors: [`${method.toUpperCase()} ${path} ${statusCode} documents no JSON body`] };
  }
  const key = `${method.toUpperCase()} ${path} ${statusCode}`;
  let validate = compiled.get(key);
  if (validate === undefined) {
    validate = ajvOf(document).compile(rewriteRefs(schema) as object);
    compiled.set(key, validate);
  }
  const isValid = validate(body);
  return {
    isValid,
    errors: isValid ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is not valid"}`),
  };
}
