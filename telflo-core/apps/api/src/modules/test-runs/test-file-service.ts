import { TEST_FILE_HEAD_MAXIMUM_BYTES, TEST_FILES_LIST_MAXIMUM, testFileContentTypeOf } from "@telflo/contracts";
import { Readable } from "node:stream";
import { FileTooLargeError, type FileKey, type IFileStore } from "../../file-store/file-store.js";
import { lockAsMember } from "../configurations/service.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import { invalidUpload, testFileNotFound, testFileTooLarge, testFileTypeUnsupported } from "./errors.js";
import type { TestInputFile } from "./repositories/test-input-file-repository.js";
import type { WithTestRunsTransaction } from "./transaction.js";

/*
 * A person's test files, "My Files" (D14a decisions 3, 7 and 16, Preflight
 * rulings 10 and 11): uploads and pasted samples, each the person's own in
 * one organization, listed only for them.
 *
 * Saving one: the session, the terms and the organization are checked, and
 * the membership re-read under the organization's lock, before any byte is
 * read (`prepareSave`, which also chooses the file's id). Then the bytes
 * stream into the FileStore at
 * organizations/<org>/users/<user>/test-inputs/<id>, and only once they are
 * whole, under their limit and followed by nothing, the row is inserted,
 * the membership re-read again under the lock. Whatever was written is
 * removed on every path but success, so a row always has its bytes, and a
 * crash leaves only an unreachable file.
 *
 * Deleting one: the row first, committed, then the bytes (a run keeps its
 * own copy of its input).
 *
 * An upload whose body breaks off inside the file (the client aborts
 * mid-upload: busboy's "Premature close", "Unexpected end of form") is the
 * client's: 400 `invalid_request`, whatever was written removed, and one
 * warning without the error's text (D14a Ruling 39), never a 500.
 *
 * Nothing here logs a name, a description or a byte (ADR 0024): the lines
 * it logs, a failed removal and a broken-off upload, carry the store
 * error's code and syscall at most.
 */

export interface TestFileServiceDependencies {
  withTransaction: WithTestRunsTransaction;
  fileStore: IFileStore;
  log: { warn(details: Record<string, unknown>, message: string): void };
}

/** A file to save, as the upload's or the sample's parts give it. */
export interface TestFileToSave {
  /** From prepareSave. */
  fileId: string;
  /** Trimmed, 1 to 200 characters (the contract's). */
  displayName: string;
  /** Trimmed, at most 2,000 characters; `''` for none. */
  description: string;
  /** The upload's own name, or the sample's (testSampleFileName). Its last extension decides the type. */
  fileName: string;
  /** The bytes, streamed. Consumed, or destroyed when refused before it is read. */
  content: Readable;
  /** Its most bytes: 10 MiB for an upload, 1 MiB for a sample. */
  maxBytes: number;
  /**
   * Called once the content has been written: throws when the content was
   * cut at its limit (413) or anything follows it (400). The bytes are
   * removed then.
   */
  finish: () => Promise<void>;
}

export interface ITestFileService {
  /**
   * Before any byte is read: the organization is the caller's active one,
   * live, and they are still its member (404 `organization_not_found`
   * otherwise). Answers the new file's id.
   */
  prepareSave(actor: Actor, organizationId: string): Promise<{ fileId: string }>;
  /**
   * Saves the file: 415 `test_file_type_unsupported` (nothing read) for a
   * name whose last extension isn't one of the six; 413
   * `test_file_too_large` past `maxBytes`. The type is the extension's
   * (TEST_FILE_CONTENT_TYPES), never the browser's.
   */
  save(actor: Actor, organizationId: string, file: TestFileToSave): Promise<TestInputFile>;
  /** The caller's files in this organization, newest first, at most TEST_FILES_LIST_MAXIMUM. */
  list(actor: Actor, organizationId: string): Promise<TestInputFile[]>;
  /** Deletes the caller's own file: the row, committed, then the bytes. 404 `test_file_not_found` otherwise. */
  remove(actor: Actor, organizationId: string, fileId: string): Promise<void>;
  /**
   * The first TEST_FILE_HEAD_MAXIMUM_BYTES of the caller's own file in this
   * organization (Ruling 43), open for streaming: 404 `test_file_not_found`
   * for anyone else's file, an id that isn't one, or bytes that are gone.
   * The caller must consume or destroy the stream.
   */
  openHead(actor: Actor, organizationId: string, fileId: string): Promise<{ sizeBytes: number; stream: Readable }>;
}

/**
 * At most `maximum` bytes of `source`, which is destroyed once they are read,
 * or when the reader stops: a test file's head (Ruling 43), and a run's
 * input's (Ruling 46).
 */
export function firstBytes(source: Readable, maximum: number): Readable {
  async function* take(): AsyncGenerator<Buffer> {
    let left = maximum;
    try {
      for await (const chunk of source) {
        const bytes = chunk as Buffer;
        const piece = bytes.byteLength > left ? bytes.subarray(0, left) : bytes;
        left -= piece.byteLength;
        if (piece.byteLength > 0) yield piece;
        if (left <= 0) return;
      }
    } finally {
      source.destroy();
    }
  }
  return Readable.from(take(), { objectMode: false });
}

/** The FileStore's key of `actor`'s file in their active organization. */
export function testInputKey(actor: Actor, fileId: string): FileKey {
  return {
    kind: "test-input",
    organizationId: actor.context.organizationId,
    userId: actor.context.userId,
    fileId,
  };
}

export function createTestFileService(deps: TestFileServiceDependencies): ITestFileService {
  const { withTransaction, fileStore, log } = deps;

  /** Removes the key's file, logging (never throwing) a failure: a left-over file is unreachable without its row. */
  async function removeQuietly(key: FileKey): Promise<void> {
    try {
      await fileStore.remove(key);
    } catch (error) {
      const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
      log.warn({ code, syscall }, "a test file's bytes could not be removed");
    }
  }

  return {
    async prepareSave(actor, organizationId) {
      assertActiveOrganization(actor, organizationId);
      return withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        return { fileId: await transaction.files.nextId() };
      });
    },

    async save(actor, organizationId, file) {
      assertActiveOrganization(actor, organizationId);
      const contentType = testFileContentTypeOf(file.fileName);
      if (contentType === undefined) {
        file.content.destroy();
        throw testFileTypeUnsupported();
      }
      const key = testInputKey(actor, file.fileId);
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
          if (error instanceof FileTooLargeError) throw testFileTooLarge(file.maxBytes);
          if (isContentBroken) {
            // The error's text stays out: it can quote the body's framing.
            log.warn({}, "an upload broke off before its end; nothing was kept");
            throw invalidUpload();
          }
          throw error;
        }
        await file.finish();
        return await withTransaction(actor.context, async (transaction) => {
          await lockAsMember(transaction, actor);
          return transaction.files.create({
            id: file.fileId,
            displayName: file.displayName,
            fileName: file.fileName,
            description: file.description,
            contentType,
            sizeBytes: written.sizeBytes,
            sha256: written.sha256,
          });
        });
      } catch (error) {
        // Any write rejection included (Ruling 25): the store may have
        // renamed the file into place before a later step failed.
        if (!file.content.destroyed && !file.content.readableEnded) file.content.destroy();
        await removeQuietly(key);
        throw error;
      }
    },

    async list(actor, organizationId) {
      assertActiveOrganization(actor, organizationId);
      return withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        return transaction.files.listOwn(TEST_FILES_LIST_MAXIMUM);
      });
    },

    async openHead(actor, organizationId, fileId) {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(fileId);
      if (id === undefined) throw testFileNotFound();
      await withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        if (!(await transaction.files.findOwn(id))) throw testFileNotFound();
      });
      const opened = await fileStore.read(testInputKey(actor, id));
      if (!opened.found) throw testFileNotFound();
      return {
        sizeBytes: Math.min(opened.sizeBytes, TEST_FILE_HEAD_MAXIMUM_BYTES),
        stream: firstBytes(opened.stream, TEST_FILE_HEAD_MAXIMUM_BYTES),
      };
    },

    async remove(actor, organizationId, fileId) {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(fileId);
      if (id === undefined) throw testFileNotFound();
      await withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        if (!(await transaction.files.removeOwn(id))) throw testFileNotFound();
      });
      // Committed: the row is gone, so the bytes are unreachable whatever
      // happens to them now.
      await removeQuietly(testInputKey(actor, id));
    },
  };
}
