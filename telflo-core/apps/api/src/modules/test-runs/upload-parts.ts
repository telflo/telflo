import type { MultipartFile, MultipartValue, Multipart } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import { AppError } from "../../errors.js";
import { invalidUpload, testFileTooLarge } from "./errors.js";

/*
 * A multipart upload's body: a test file's upload and a pasted sample's
 * (D14a Preflight ruling 10), and a test template's (D14b Preflight ruling
 * 11). It is read only after the route's checks (the parser registered for
 * these routes reads nothing itself): through `request.parts()`, never
 * `file()`, which would silently drop a late field or a second file. The
 * parts come in one fixed order, the route's (its contract's part names:
 * the text fields, then the file, last), and nothing may follow the file.
 * busboy's limits (uploadPartLimits, derived from the names) bound every
 * part: a file past its size is cut, not refused, so `finish` checks
 * `truncated` once the file has been read, and asks for one more part,
 * which must be the end.
 *
 * The fields come back as sent; the route checks them with its contract,
 * and destroys the file part, unread, when they fail.
 *
 * A refusal answers 400 `invalid_request` with no details (they could echo
 * a name), or 413: `test_file_too_large` by default, or the route's own
 * (`tooLarge`, D23-2 decision 33: an organization's logo). A part's text
 * reaches no log line.
 */

/** An upload's part names, in their order: the text fields, then the file part, last. */
export type UploadPartNames = readonly [...string[], string];

/**
 * busboy's limits for an upload whose parts are `partNames` (D14b Preflight
 * ruling 11): one file, a field for each name before it, one part each, 8
 * KiB per field (a 2,000-character description is at most 8,000 bytes of
 * UTF-8), and 50 header pairs a part. The file's own limit is the route's
 * (`fileSize`).
 */
export function uploadPartLimits(partNames: UploadPartNames) {
  return {
    files: 1,
    fields: partNames.length - 1,
    parts: partNames.length,
    fieldSize: 8 * 1024,
    fieldNameSize: 100,
    headerPairs: 50,
  } as const;
}

/**
 * The most bytes of a refused upload's unread body that are read and
 * dropped, so the connection can serve its next request: the gateway's
 * 11 MiB (docker/gateway/default.conf). Past it the connection is closed.
 *
 * In a deployment this drain, and the 413 path (busboy reads an oversized
 * file part to its end, dropping what passes `fileSize`, before `finish`
 * sees `truncated`), are bounded by the gateway: its 11m body limit and its
 * timeouts end a body that is too long or too slow (D14a Ruling 39). A
 * native API reached directly has no such bound: Fastify's requestTimeout
 * is 0, so a slow or endless body holds the connection until the client
 * goes.
 */
export const REFUSED_UPLOAD_DISCARD_BYTES = 11 * 1024 * 1024;

/** The requests whose body the parts' reader has started on (piped into busboy). */
const parsing = new WeakSet<FastifyRequest>();

/**
 * After a refused upload whose body the reader started on: the parser is
 * unpiped and the rest of the body read and dropped (up to
 * REFUSED_UPLOAD_DISCARD_BYTES, then the connection is closed), so the
 * answer reaches the client and the connection isn't left holding an
 * unread body. A body never started on (a 401 before the handler) is
 * Node's to drain, as for any route.
 */
export function discardUnreadUpload(request: FastifyRequest): void {
  const raw = request.raw;
  if (!parsing.has(request) || raw.readableEnded || raw.destroyed) return;
  raw.unpipe();
  let discarded = 0;
  raw.on("data", (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > REFUSED_UPLOAD_DISCARD_BYTES) raw.destroy();
  });
  raw.resume();
}

/** What the parts say, the file part still unread. */
export interface UploadParts {
  /** Each text field's value, by its part name, as sent: the route checks them with its contract. */
  fields: Record<string, string>;
  /** The file part: its stream, its own name (busboy keeps no directory), its declared type. */
  file: MultipartFile;
  /**
   * Once the file's stream has been read to its end: throws 413 when it
   * was cut at `maxBytes`, and 400 when anything follows it.
   */
  finish: () => Promise<void>;
}

/** How a route reads its upload (D23-2 decision 33). */
export interface ReadUploadPartsOptions {
  /**
   * The route's refusal of a file over its `maxBytes` (a 413). Left out,
   * a test file's: `test_file_too_large` (testFileTooLarge).
   */
  tooLarge?: () => AppError;
}

/** A multipart failure as the API answers it: the file's limit is the route's 413, anything else 400. */
function refusalOf(error: unknown, tooLarge: () => AppError): AppError {
  if (error instanceof AppError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "FST_REQ_FILE_TOO_LARGE") return tooLarge();
  return invalidUpload();
}

/** A field part named `name`, whole: anything else (a file, another name, a value over its size) is refused. */
function fieldValue(part: Multipart | undefined, name: string): string {
  if (part === undefined || part.type !== "field" || part.fieldname !== name) throw invalidUpload();
  const field = part as MultipartValue<unknown>;
  if (field.fieldnameTruncated || field.valueTruncated || typeof field.value !== "string") throw invalidUpload();
  return field.value;
}

/**
 * Reads the parts up to the file's header, in `partNames`' order (the text
 * fields, then the file, last). A body that isn't multipart and parts out of
 * order, missing or over their size are 400; a file part already open is
 * destroyed first, so nothing of it is read. A file over `maxBytes` is
 * `tooLarge`'s refusal (by default 413 `test_file_too_large`).
 */
export async function readUploadParts(
  request: FastifyRequest,
  maxBytes: number,
  partNames: UploadPartNames,
  { tooLarge = () => testFileTooLarge(maxBytes) }: ReadUploadPartsOptions = {},
): Promise<UploadParts> {
  if (!request.isMultipart()) throw invalidUpload();
  parsing.add(request);
  const parts = request.parts({ limits: { ...uploadPartLimits(partNames), fileSize: maxBytes } });
  let current: Multipart | undefined;
  const next = async (): Promise<Multipart | undefined> => {
    try {
      const step = await parts.next();
      current = step.done ? undefined : step.value;
      return current;
    } catch (error) {
      throw refusalOf(error, tooLarge);
    }
  };

  try {
    const fieldNames = partNames.slice(0, -1);
    const filePart = partNames[partNames.length - 1];
    const fields: Record<string, string> = {};
    for (const name of fieldNames) fields[name] = fieldValue(await next(), name);
    const file = await next();
    if (file === undefined || file.type !== "file" || file.fieldname !== filePart) throw invalidUpload();
    return {
      fields,
      file,
      finish: async () => {
        if (file.file.truncated) throw tooLarge();
        const after = await next();
        if (after !== undefined) {
          if (after.type === "file") after.file.destroy();
          throw invalidUpload();
        }
      },
    };
  } catch (error) {
    // A part opened and left unread would hold the parser: drop it.
    if (current?.type === "file" && !current.file.destroyed) current.file.destroy();
    throw refusalOf(error, tooLarge);
  }
}
