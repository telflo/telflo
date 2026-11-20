import { z } from "zod";
import { hasUnstorableCharacter } from "./configurations.js";
import { shellQuote } from "./install.js";
import { trimmedDescriptionSchema, trimmedNameSchema } from "./test-suites.js";

/*
 * The library: a global set of helper files the Learning Telflo tutorials
 * use.
 *
 * - Members, signed in with the current terms (a product admin's list with
 *   or without them): `GET /api/v1/library-files` (the files, newest first,
 *   at most LIBRARY_FILES_LIST_MAXIMUM); `GET …/:fileId/file` (the bytes,
 *   application/octet-stream, `attachment` with no name: the web names the
 *   saved file from the list, curl's `-o` from the command); `POST
 *   …/:fileId/link` (`201 { path }`: the library link's path, valid
 *   LIBRARY_LINK_LIFETIME_HOURS; the web puts its own origin in front).
 * - Product admins only (`product_admin_required` otherwise): `POST
 *   /api/v1/library-files`, multipart/form-data with the parts
 *   LIBRARY_FILE_PART_NAMES in that order (the file at most
 *   LIBRARY_FILE_MAXIMUM_BYTES, any type); `PATCH …/:fileId` (the name and
 *   description); `DELETE …/:fileId` (hard).
 * - Anyone holding a link: `GET /api/v1/library-links/tll_…`, no session.
 *
 * A file's name, description and file name are Telflo's own content: never
 * in an attribute, a toast, a log line or an audit row. A library link is a
 * secret: never in a log line, an error, an audit row, a toast, an
 * attribute, browser storage, an analytics property or a test's printed
 * output. Their bounds are migration 037's checks.
 */

/** A library file's name, after trimming: 1 to 200 characters (ck_library_files_name). */
export const LIBRARY_FILE_NAME_MAXIMUM_LENGTH = 200;

/** A library file's description, after trimming: at most 2,000 characters; `''` is none. */
export const LIBRARY_FILE_DESCRIPTION_MAXIMUM_LENGTH = 2_000;

/** The uploaded file's own name: 1 to 255 characters (ck_library_files_file_name). */
export const LIBRARY_FILE_FILE_NAME_MAXIMUM_LENGTH = 255;

/** A library file's most bytes: 10 MiB (ck_library_files_size_bytes). */
export const LIBRARY_FILE_MAXIMUM_BYTES = 10_485_760;

/** The most files `GET /api/v1/library-files` lists, newest first. */
export const LIBRARY_FILES_LIST_MAXIMUM = 1_000;

/** How long a library link lasts. */
export const LIBRARY_LINK_LIFETIME_HOURS = 24;

/** The multipart parts of a file's upload, in the only order accepted. */
export const LIBRARY_FILE_PART_NAMES = ["name", "description", "file"] as const;

/**
 * The library's own refusals: `library_file_not_found` (404) for an id that
 * is no file, `library_file_too_large` (413) for an upload over
 * LIBRARY_FILE_MAXIMUM_BYTES.
 */
export const LIBRARY_ERROR_CODES = ["library_file_not_found", "library_file_too_large"] as const;

export type LibraryErrorCode = (typeof LIBRARY_ERROR_CODES)[number];

/**
 * A library link: `tll_` and base64url, no padding, of 53 bytes (a version
 * byte, the file's id, the expiry, an HMAC-SHA256 tag): 71 characters. A
 * secret: checked, never printed.
 */
export const LIBRARY_LINK_PATTERN = /^tll_[A-Za-z0-9_-]{71}$/;

/** The link's route, as `POST …/:fileId/link` answers its `path` (the web prefixes its own origin). */
export const LIBRARY_LINK_PATH_PATTERN = /^\/api\/v1\/library-links\/tll_[A-Za-z0-9_-]{71}$/;

export const LibraryFileNameSchema = trimmedNameSchema(LIBRARY_FILE_NAME_MAXIMUM_LENGTH);

export const LibraryFileDescriptionSchema = trimmedDescriptionSchema(LIBRARY_FILE_DESCRIPTION_MAXIMUM_LENGTH);

/**
 * Any control character (C0, DEL and C1), a bidirectional control (U+061C,
 * U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) or an invisible one (U+200B,
 * U+2060, U+FEFF): each would make the name shown, or the `-o '<name>'` a
 * member pastes, read other than it is. Not every format character (`\p{Cf}`):
 * the zero-width non-joiner and joiner (Persian, Indic scripts, emoji
 * sequences) and the soft hyphen are in names people use.
 */
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;

/**
 * Why an uploaded file's own name can't be a library file's, or undefined
 * when it can. A member's pasted curl writes `-o '<name>'` in their working
 * directory: a name with `/` or `\` would write elsewhere, `-` (or any
 * leading `-`) is read by curl as stdout or an option, and `.` or `..` is a
 * directory. So: 1 to 255 characters, no control or formatting character,
 * no `/` or `\`, not `.` or `..`, not starting with `-`, nothing Postgres
 * can't store. Not trimmed: the name is the file's own.
 */
export function libraryFileFileNameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > LIBRARY_FILE_FILE_NAME_MAXIMUM_LENGTH) return "length";
  if (CONTROL_OR_FORMAT_CHARACTER.test(name)) return "control or formatting character";
  if (name.includes("/") || name.includes("\\")) return "slash";
  if (name === "." || name === "..") return "dot";
  if (name.startsWith("-")) return "leading dash";
  if (hasUnstorableCharacter(name)) return "unstorable";
  return undefined;
}

/** The uploaded file's own name, as libraryFileFileNameProblem allows it. */
export const LibraryFileFileNameSchema = z
  .string()
  .refine((name) => libraryFileFileNameProblem(name) === undefined, "The file's name can't be used.");

/**
 * The text parts of `POST /api/v1/library-files`, as the API reads them from
 * the multipart body (the file is the last part, and is not here). Strict.
 */
export const CreateLibraryFileFieldsSchema = z
  .object({
    name: LibraryFileNameSchema,
    description: LibraryFileDescriptionSchema,
  })
  .strict();

export type CreateLibraryFileFields = z.infer<typeof CreateLibraryFileFieldsSchema>;

/**
 * `PATCH /api/v1/library-files/:fileId`, product admins only: the name, the
 * description or both, at least one. The file never changes. Strict.
 */
export const UpdateLibraryFileRequestSchema = z
  .object({
    name: LibraryFileNameSchema.optional(),
    description: LibraryFileDescriptionSchema.optional(),
  })
  .strict()
  .refine((changes) => changes.name !== undefined || changes.description !== undefined, "Change the name or the description.");

export type UpdateLibraryFileRequest = z.infer<typeof UpdateLibraryFileRequestSchema>;

/** A library file, as the list shows it. The timestamps are ISO 8601, from the API's clock. */
export const LibraryFileSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(LIBRARY_FILE_NAME_MAXIMUM_LENGTH),
    description: z.string().max(LIBRARY_FILE_DESCRIPTION_MAXIMUM_LENGTH),
    fileName: z.string().max(LIBRARY_FILE_FILE_NAME_MAXIMUM_LENGTH),
    sizeBytes: z.number().int().min(0).max(LIBRARY_FILE_MAXIMUM_BYTES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type LibraryFile = z.infer<typeof LibraryFileSchema>;

/** `GET /api/v1/library-files`: the files, newest first, at most LIBRARY_FILES_LIST_MAXIMUM. */
export const LibraryFilesResponseSchema = z.object({ libraryFiles: z.array(LibraryFileSchema) }).strict();

export type LibraryFilesResponse = z.infer<typeof LibraryFilesResponseSchema>;

/** `POST /api/v1/library-files` (201) and `PATCH …/:fileId` (200): the file. */
export const LibraryFileResponseSchema = z.object({ libraryFile: LibraryFileSchema }).strict();

export type LibraryFileResponse = z.infer<typeof LibraryFileResponseSchema>;

/** `POST /api/v1/library-files/:fileId/link` (201, no-store): the link's path, a secret. */
export const LibraryFileLinkResponseSchema = z.object({ path: z.string().regex(LIBRARY_LINK_PATH_PATTERN) }).strict();

export type LibraryFileLinkResponse = z.infer<typeof LibraryFileLinkResponseSchema>;

/**
 * The members' Copy curl command: both values single-quoted (`shellQuote`),
 * so nothing in either is expanded when pasted into a POSIX shell:
 * `curl -fL '<url>' -o '<fileName>'`. The url is the browser's own origin
 * and the link's path. The command holds the link, a secret: the clipboard
 * only, never the DOM, a state, storage, a toast or a log.
 */
export function libraryFileCurlCommand(url: string, fileName: string): string {
  return `curl -fL ${shellQuote(url)} -o ${shellQuote(fileName)}`;
}
