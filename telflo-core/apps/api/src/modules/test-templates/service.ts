import { TEST_FILE_HEAD_MAXIMUM_BYTES, TEST_TEMPLATES_LIST_MAXIMUM, testFileContentTypeOf, type TestRunSignal } from "@telflo/contracts";
import type { Readable } from "node:stream";
import { FileTooLargeError, type FileKey, type IFileStore } from "../../file-store/file-store.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { canonicalIdOf } from "../organizations/service.js";
import { invalidUpload, testFileTooLarge, testFileTypeUnsupported } from "../test-runs/errors.js";
import { firstBytes } from "../test-runs/test-file-service.js";
import { testTemplateNotFound } from "./errors.js";
import type { ITestTemplateRepository, TestTemplate, TestTemplateChanges } from "./repositories/test-template-repository.js";

/*
 * The test templates API (D14b decisions 3, 13 and 14; details 19 to 21;
 * Preflight rulings 11, 22 and 24): a product-wide library of sample inputs,
 * global as flows are (ADR 0008).
 *
 * Whether the caller may write is decided before the service is reached
 * (`requireProductAdmin` on the routes); every write is audited in no
 * organization, with ids only (decision 14).
 *
 * Creating one (ruling 11), as D14a's upload saves a test file: its id is
 * chosen first (`prepareCreate`), before any byte is read; then the parts,
 * in order (the routes); then the type, by the file name's extension (415,
 * nothing read); then the bytes stream into the FileStore at
 * global/test-templates/<id>, and only once they are whole, under 10 MiB and
 * followed by nothing (`finish`), one transaction inserts the row and the
 * audit row. Whatever was written is removed on every path but success, so
 * a row always has its bytes.
 *
 * Deleting one: one transaction soft-deletes the live row (`deleted_at`) and
 * writes the audit row; it commits; then the bytes are removed, a failure
 * logged (its code and syscall only) and never thrown. The row goes before
 * the bytes, so a failure never leaves a live template without its bytes.
 * Definitions and runs made from it keep their
 * own copies (decision 13).
 *
 * Names, descriptions, file names and bytes reach no log line and no audit
 * row (ADR 0024).
 */

/** The repositories a write uses, bound to one transaction. Both are global: no database context is needed. */
export interface TestTemplatesTransaction {
  templates: ITestTemplateRepository;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction and resolves with its result once
 * it commits. If `work` rejects, the transaction rolls back and the
 * rejection propagates.
 */
export type WithTestTemplatesTransaction = <Result>(
  work: (transaction: TestTemplatesTransaction) => Promise<Result>,
) => Promise<Result>;

export interface TestTemplateServiceDependencies {
  /** The reads' repository, outside any transaction: each read is one statement. */
  templates: Pick<ITestTemplateRepository, "findLive" | "listLive" | "nextId">;
  withTransaction: WithTestTemplatesTransaction;
  fileStore: IFileStore;
  /** Every template timestamp comes from here, never SQL `now()`. */
  now: () => Date;
  log: { warn(details: Record<string, unknown>, message: string): void };
}

/** Who writes, for the audit row: a product admin, never acting for an organization. */
export interface TestTemplateWriter {
  userId: string;
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** A template to save, as the upload's parts give it. */
export interface TestTemplateToSave {
  /** From prepareCreate. */
  templateId: string;
  /** Trimmed, 1 to 200 characters (the contract's). */
  name: string;
  /** Trimmed, at most 2,000 characters; `''` for none. */
  description: string;
  /** One of TEST_TEMPLATE_RECEIVER_TYPES (the contract's). */
  receiverType: string;
  signal: TestRunSignal;
  /** The upload's own name. Its last extension decides the type. */
  fileName: string;
  /** The bytes, streamed. Consumed, or destroyed when refused before it is read. */
  content: Readable;
  /** Its most bytes: 10 MiB. */
  maxBytes: number;
  /** Called once the content has been written: throws when it was cut at its limit (413) or anything follows it (400). */
  finish: () => Promise<void>;
}

/** A change to a template's metadata, as the contract parses it: a field left out stays as it is. */
export type TestTemplateUpdate = { [Field in keyof TestTemplateChanges]?: TestTemplateChanges[Field] | undefined };

export interface ITestTemplateService {
  /** The live templates, newest first, at most TEST_TEMPLATES_LIST_MAXIMUM. */
  list(): Promise<TestTemplate[]>;
  /** Before any byte is read: the new template's id. */
  prepareCreate(): Promise<{ templateId: string }>;
  /**
   * Saves the template: 415 `test_file_type_unsupported` (nothing read) for
   * a name whose last extension isn't one of the six; 413
   * `test_file_too_large` past `maxBytes`. The type is the extension's
   * (TEST_FILE_CONTENT_TYPES), never the browser's.
   */
  create(writer: TestTemplateWriter, template: TestTemplateToSave): Promise<TestTemplate>;
  /**
   * Changes the metadata fields given that differ from the template's. None
   * given, or none different, writes and audits nothing, and answers the
   * template as it is (as a flow's change does). 404
   * `test_template_not_found` for a deleted, an unknown and a malformed id.
   */
  update(writer: TestTemplateWriter, id: string, changes: TestTemplateUpdate): Promise<TestTemplate>;
  /** Deletes a live template softly, then its bytes. 404 `test_template_not_found` otherwise. */
  remove(writer: TestTemplateWriter, id: string): Promise<void>;
  /** A live template's bytes, open for streaming: 404 `test_template_not_found` otherwise. The caller must consume or destroy the stream. */
  openFile(id: string): Promise<{ sizeBytes: number; stream: Readable }>;
  /** The first TEST_FILE_HEAD_MAXIMUM_BYTES of a live template's bytes, as openFile. */
  openHead(id: string): Promise<{ sizeBytes: number; stream: Readable }>;
}

/** The FileStore's key of a template's bytes (D14b decision 3). */
export function testTemplateKey(templateId: string): FileKey {
  return { kind: "test-template", templateId };
}

/** The metadata fields a change compares and audits, in the contract's order. */
const FIELDS = ["name", "description", "receiverType", "signal"] as const satisfies readonly (keyof TestTemplateChanges)[];

/** An audit row about a template (decision 14): global, so in no organization; ids and field names only. */
function auditEvent(
  writer: TestTemplateWriter,
  templateId: string,
  action: string,
  metadata: Record<string, unknown>,
): AuditEvent {
  return {
    action,
    actorUserId: writer.userId,
    actorEmail: writer.email,
    subjectType: "test_template",
    subjectId: templateId,
    metadata,
    ipAddress: writer.ipAddress,
    userAgent: writer.userAgent,
  };
}

export function createTestTemplateService(deps: TestTemplateServiceDependencies): ITestTemplateService {
  const { templates, withTransaction, fileStore, now, log } = deps;

  /** Removes a template's bytes, logging (never throwing) a failure: without a live row the bytes are unreachable. */
  async function removeQuietly(templateId: string): Promise<void> {
    try {
      await fileStore.remove(testTemplateKey(templateId));
    } catch (error) {
      const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
      log.warn({ code, syscall }, "a test template's bytes could not be removed");
    }
  }

  /** A live template's bytes, or 404 for an id that isn't one, a deleted template and bytes that are gone. */
  async function open(id: string): Promise<{ sizeBytes: number; stream: Readable }> {
    const templateId = canonicalIdOf(id);
    const template = templateId === undefined ? undefined : await templates.findLive(templateId);
    if (!template) throw testTemplateNotFound();
    const opened = await fileStore.read(testTemplateKey(template.id));
    if (!opened.found) throw testTemplateNotFound();
    return { sizeBytes: opened.sizeBytes, stream: opened.stream };
  }

  return {
    async list() {
      return templates.listLive(TEST_TEMPLATES_LIST_MAXIMUM);
    },

    async prepareCreate() {
      return { templateId: await templates.nextId() };
    },

    async create(writer, template) {
      const contentType = testFileContentTypeOf(template.fileName);
      if (contentType === undefined) {
        template.content.destroy();
        throw testFileTypeUnsupported();
      }
      const key = testTemplateKey(template.templateId);
      // Whether a rejected write failed reading the content (the upload broke
      // off) rather than storing it: only the content's own reads set it.
      let isContentBroken = false;
      const content = template.content;
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
          written = await fileStore.write(key, readContent(), { maxBytes: template.maxBytes });
        } catch (error) {
          if (error instanceof FileTooLargeError) throw testFileTooLarge(template.maxBytes);
          if (isContentBroken) {
            // The error's text stays out: it can quote the body's framing.
            log.warn({}, "a test template's upload broke off before its end; nothing was kept");
            throw invalidUpload();
          }
          throw error;
        }
        await template.finish();
        return await withTransaction(async (transaction) => {
          const created = await transaction.templates.create({
            id: template.templateId,
            name: template.name,
            description: template.description,
            receiverType: template.receiverType,
            signal: template.signal,
            fileName: template.fileName,
            contentType,
            sizeBytes: written.sizeBytes,
            sha256: written.sha256,
            createdByUserId: writer.userId,
            at: now(),
          });
          await transaction.audit.record(auditEvent(writer, created.id, "test_template.created", {}));
          return created;
        });
      } catch (error) {
        // Any write rejection included (D14a Ruling 25): the store may have
        // renamed the file into place before a later step failed.
        if (!template.content.destroyed && !template.content.readableEnded) template.content.destroy();
        await removeQuietly(template.templateId);
        throw error;
      }
    },

    async update(writer, id, changes) {
      const templateId = canonicalIdOf(id);
      if (templateId === undefined) throw testTemplateNotFound();
      return withTransaction(async (transaction) => {
        const current = await transaction.templates.lockLive(templateId);
        if (!current) throw testTemplateNotFound();
        // Only the fields that differ from what is there, as a flow's change.
        const to: TestTemplateChanges = {};
        for (const field of FIELDS) {
          const value = changes[field];
          if (value !== undefined && value !== current[field]) Object.assign(to, { [field]: value });
        }
        const changedFields = FIELDS.filter((field) => field in to);
        if (changedFields.length === 0) return current;
        const updated = await transaction.templates.update(current.id, to, now());
        // Locked above, and only a delete in another transaction ends it: this can't miss.
        if (!updated) throw testTemplateNotFound();
        // The fields' names, never their values (ADR 0024).
        await transaction.audit.record(auditEvent(writer, current.id, "test_template.updated", { changedFields }));
        return updated;
      });
    },

    async remove(writer, id) {
      const templateId = canonicalIdOf(id);
      if (templateId === undefined) throw testTemplateNotFound();
      await withTransaction(async (transaction) => {
        if (!(await transaction.templates.softDelete(templateId, now()))) throw testTemplateNotFound();
        await transaction.audit.record(auditEvent(writer, templateId, "test_template.deleted", {}));
      });
      // Committed: the row is deleted, so the bytes are unreachable whatever happens to them now.
      await removeQuietly(templateId);
    },

    async openFile(id) {
      return open(id);
    },

    async openHead(id) {
      const opened = await open(id);
      return {
        sizeBytes: Math.min(opened.sizeBytes, TEST_FILE_HEAD_MAXIMUM_BYTES),
        stream: firstBytes(opened.stream, TEST_FILE_HEAD_MAXIMUM_BYTES),
      };
    },
  };
}
