import type { LibraryErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The library's own refusals (D23-2 decisions 42, 43 and 45). No message
 * names a file, its name, its description or a link: the names are Telflo's
 * own content and a link is a secret.
 */

/** An id that is no library file: unknown, deleted, or not a canonical UUID, all alike (decision 42). */
export function libraryFileNotFound(): AppError {
  return new AppError("library_file_not_found" satisfies LibraryErrorCode, "Library file not found", 404);
}

/** A file over LIBRARY_FILE_MAXIMUM_BYTES (decision 43), through readUploadParts' `tooLarge`. */
export function libraryFileTooLarge(): AppError {
  return new AppError("library_file_too_large" satisfies LibraryErrorCode, "The file must be 10 MB or smaller.", 413);
}

/*
 * The library link's refusals (decision 45), answered in plain text by the
 * public download's error handler: their codes name them for the tests and
 * the log, never in a reply.
 */

/** A link of the wrong shape, length or version, one no key signed, or one whose file is gone: alike. */
export function libraryLinkNotFound(): AppError {
  return new AppError("library_link_not_found", "Not found.", 404);
}

/** A link a key signed whose expiry has come (the injected clock). */
export function libraryLinkExpired(): AppError {
  return new AppError("library_link_expired", "This link has expired.", 410);
}
