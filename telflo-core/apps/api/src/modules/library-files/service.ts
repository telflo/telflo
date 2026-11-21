import { LIBRARY_FILES_LIST_MAXIMUM } from "@telflo/contracts";
import type { Readable } from "node:stream";
import { FileTooLargeError, type FileKey, type IFileStore } from "../../file-store/file-store.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { canonicalIdOf } from "../organizations/service.js";
import { invalidUpload } from "../test-runs/errors.js";
import { libraryFileNotFound, libraryFileTooLarge, libraryLinkExpired, libraryLinkNotFound } from "./errors.js";
import { libraryLinkPath, type LibraryLinks } from "./link.js";
import type { ILibraryFileRepository, LibraryFile, LibraryFileChanges } from "./repositories/library-file-repository.js";

/*
 * The library API: Telflo's own helper files, global as test templates are.
 *
 * Whether the caller may write is decided before the service is reached
 * (`requireProductAdmin` on the routes); the product admin's create, change
 * and delete are audited in no organization, with ids and field names only
 * (links and downloads are not audited).
 *
 * Creating one: its id is chosen first (`prepareCreate`), before any byte
 * is read; then the parts, in order (the routes); then the bytes stream
 * into the file store at global/library-files/<id> (any type: no type
 * check), and only once they are whole, at most 10 MiB and followed by
 * nothing (`finish`), one transaction inserts the row and its audit row.
 * Whatever was written is removed on every path but success, so a row
 * always has its bytes.
 *
 * Deleting one: one transaction deletes the row and writes the audit row;
 * it commits; then the bytes are removed, a failure logged (its code and
 * syscall only) and never thrown. The row goes before the bytes, so a
 * failure never leaves a row without its bytes.
 *
 * The link: made for a member for a file that exists (its `path`, the
 * link a secret); checked by link.ts; only the file's id goes on from a
 * checked link.
 *
 * Names, descriptions, file names, bytes and links reach no log line and no
 * audit row.
 */

/** The repositories a write uses, bound to one transaction. Both are global: no database context is needed. */
export interface LibraryFilesTransaction {
  files: ILibraryFileRepository;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction and resolves with its result once
 * it commits. If `work` rejects, the transaction rolls back and the
 * rejection propagates.
 */
export type WithLibraryFilesTransaction = <Result>(work: (transaction: LibraryFilesTransaction) => Promise<Result>) => Promise<Result>;

export interface LibraryFileServiceDependencies {
  /** The reads' repository, outside any transaction: each read is one statement. */
  files: Pick<ILibraryFileRepository, "find" | "list" | "nextId">;
  withTransaction: WithLibraryFilesTransaction;
  fileStore: IFileStore;
  links: LibraryLinks;
  /** Every file timestamp, and every link's expiry, comes from here, never SQL `now()`. */
  now: () => Date;
  log: { warn(details: Record<string, unknown>, message: string): void };
}

/** Who writes, for the audit row: a product admin, never acting for an organization. */
export interface LibraryFileWriter {
  userId: string;
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** A file to save, as the upload's parts give it. */
export interface LibraryFileToSave {
  /** From prepareCreate. */
  fileId: string;
  /** Trimmed, 1 to 200 characters (the contract's). */
  name: string;
  /** Trimmed, at most 2,000 characters; `''` for none. */
  description: string;
  /** The upload's own name, as the contract allows it. */
  fileName: string;
  /** The bytes, streamed. Consumed, or destroyed when refused before it is read. */
  content: Readable;
  /** Its most bytes: 10 MiB. */
  maxBytes: number;
  /** Called once the content has been written: throws when it was cut at its limit (413) or anything follows it (400). */
  finish: () => Promise<void>;
}

/** A change to a file's name or description, as the contract parses it: a field left out stays as it is. */
export type LibraryFileUpdate = { [Field in keyof LibraryFileChanges]?: LibraryFileChanges[Field] | undefined };

/** A file's bytes, open for streaming. The caller must consume or destroy the stream. */
export interface OpenedLibraryFile {
  sizeBytes: number;
  stream: Readable;
}

export interface ILibraryFileService {
  /** The files, newest first, at most LIBRARY_FILES_LIST_MAXIMUM. */
  list(): Promise<LibraryFile[]>;
  /** Before any byte is read: the new file's id. */
  prepareCreate(): Promise<{ fileId: string }>;
  /** Saves the file: 413 `library_file_too_large` past `maxBytes`; 400 when the upload breaks off. */
  create(writer: LibraryFileWriter, file: LibraryFileToSave): Promise<LibraryFile>;
  /**
   * Changes the fields given that differ from the file's. None different
   * writes and audits nothing, and answers the file as it is. 404
   * `library_file_not_found` for an unknown or a malformed id.
   */
  update(writer: LibraryFileWriter, id: string, changes: LibraryFileUpdate): Promise<LibraryFile>;
  /** Deletes a file's row, then its bytes. 404 `library_file_not_found` otherwise. */
  remove(writer: LibraryFileWriter, id: string): Promise<void>;
  /** A file's bytes: 404 `library_file_not_found` for an unknown or malformed id and for bytes that are gone. */
  openFile(id: string): Promise<OpenedLibraryFile>;
  /** A new link's path (`/api/v1/library-links/tll_…`) to a file that exists: 404 `library_file_not_found` otherwise. */
  createLink(id: string): Promise<string>;
  /**
   * A link's file id and expiry (seconds), once link.ts has checked it:
   * the plain 404 `library_link_not_found` for anything it refuses, the 410
   * `library_link_expired` for a good link whose expiry has come.
   */
  checkLink(link: string): { fileId: string; expiresAt: number };
  /** A checked link's file's bytes: the plain 404 `library_link_not_found` for a deleted file or bytes that are gone. */
  openLinkedFile(fileId: string): Promise<OpenedLibraryFile>;
}

/** The file store's key of a library file's bytes. */
export function libraryFileKey(fileId: string): FileKey {
  return { kind: "library-file", fileId };
}

/** The fields a change compares and audits, in the contract's order. */
const FIELDS = ["name", "description"] as const satisfies readonly (keyof LibraryFileChanges)[];

/** An audit row about a file: global, so in no organization; ids and field names only. */
function auditEvent(writer: LibraryFileWriter, fileId: string, action: string, metadata: Record<string, unknown>): AuditEvent {
  return {
    action,
    actorUserId: writer.userId,
    actorEmail: writer.email,
    subjectType: "library_file",
    subjectId: fileId,
    metadata,
    ipAddress: writer.ipAddress,
    userAgent: writer.userAgent,
  };
}

export function createLibraryFileService(deps: LibraryFileServiceDependencies): ILibraryFileService {
  const { files, withTransaction, fileStore, links, now, log } = deps;

  /** Removes a file's bytes, logging (never throwing) a failure: without a row the bytes are unreachable. */
  async function removeQuietly(fileId: string): Promise<void> {
    try {
      await fileStore.remove(libraryFileKey(fileId));
    } catch (error) {
      const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
      log.warn({ code, syscall }, "a library file's bytes could not be removed");
    }
  }

  /** A file's bytes, or `notFound()` for an id that isn't one and bytes that are gone. */
  async function open(id: string, notFound: () => Error): Promise<OpenedLibraryFile> {
    const fileId = canonicalIdOf(id);
    const file = fileId === undefined ? undefined : await files.find(fileId);
    if (!file) throw notFound();
    const opened = await fileStore.read(libraryFileKey(file.id));
    if (!opened.found) throw notFound();
    return { sizeBytes: opened.sizeBytes, stream: opened.stream };
  }

  return {
    async list() {
      return files.list(LIBRARY_FILES_LIST_MAXIMUM);
    },

    async prepareCreate() {
      return { fileId: await files.nextId() };
    },

    async create(writer, file) {
      const key = libraryFileKey(file.fileId);
      // Whether a rejected write failed reading the content (the upload broke
      // off) rather than storing it: only the content's own reads set it.
      let isContentBroken = false;
      const content = file.content;
      async function* readContent(): AsyncGenerator<Uint8Array> {
        try {
          for await (const chunk of content) yield chunk as Uint8Array;
        } catch (error) {
          isContentBroken = true;
          throw error;
        }
      }
      try {
        let written: { sizeBytes: number; sha256: string };
        try {
          written = await fileStore.write(key, readContent(), { maxBytes: file.maxBytes });
        } catch (error) {
          if (error instanceof FileTooLargeError) throw libraryFileTooLarge();
          if (isContentBroken) {
            // The error's text stays out: it can quote the body's framing.
            log.warn({}, "a library file's upload broke off before its end; nothing was kept");
            throw invalidUpload();
          }
          throw error;
        }
        await file.finish();
        return await withTransaction(async (transaction) => {
          const created = await transaction.files.create({
            id: file.fileId,
            name: file.name,
            description: file.description,
            fileName: file.fileName,
            sizeBytes: written.sizeBytes,
            sha256: written.sha256,
            createdByUserId: writer.userId,
            at: now(),
          });
          await transaction.audit.record(auditEvent(writer, created.id, "library_file.created", {}));
          return created;
        });
      } catch (error) {
        // Any rejection after the write began: the store may have put the
        // file in place before a later step failed.
        if (!file.content.destroyed && !file.content.readableEnded) file.content.destroy();
        await removeQuietly(file.fileId);
        throw error;
      }
    },

    async update(writer, id, changes) {
      const fileId = canonicalIdOf(id);
      if (fileId === undefined) throw libraryFileNotFound();
      return withTransaction(async (transaction) => {
        const current = await transaction.files.lock(fileId);
        if (!current) throw libraryFileNotFound();
        // Only the fields that differ from what is there.
        const to: LibraryFileChanges = {};
        for (const field of FIELDS) {
          const value = changes[field];
          if (value !== undefined && value !== current[field]) to[field] = value;
        }
        const changedFields = FIELDS.filter((field) => field in to);
        if (changedFields.length === 0) return current;
        const updated = await transaction.files.update(current.id, to, now());
        // Locked above, and only a delete in another transaction ends it: this can't miss.
        if (!updated) throw libraryFileNotFound();
        // The fields' names, never their values.
        await transaction.audit.record(auditEvent(writer, current.id, "library_file.updated", { changedFields }));
        return updated;
      });
    },

    async remove(writer, id) {
      const fileId = canonicalIdOf(id);
      if (fileId === undefined) throw libraryFileNotFound();
      await withTransaction(async (transaction) => {
        if (!(await transaction.files.remove(fileId))) throw libraryFileNotFound();
        await transaction.audit.record(auditEvent(writer, fileId, "library_file.deleted", {}));
      });
      // Committed: the row is gone, so the bytes are unreachable whatever happens to them now.
      await removeQuietly(fileId);
    },

    async openFile(id) {
      return open(id, libraryFileNotFound);
    },

    async createLink(id) {
      const fileId = canonicalIdOf(id);
      const file = fileId === undefined ? undefined : await files.find(fileId);
      if (!file) throw libraryFileNotFound();
      return libraryLinkPath(links.sign(file.id, now()));
    },

    checkLink(link) {
      const checked = links.check(link, now());
      if (checked.kind === "invalid") throw libraryLinkNotFound();
      if (checked.kind === "expired") throw libraryLinkExpired();
      return { fileId: checked.fileId, expiresAt: checked.expiresAt };
    },

    async openLinkedFile(fileId) {
      return open(fileId, libraryLinkNotFound);
    },
  };
}
