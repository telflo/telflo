import multipart from "@fastify/multipart";
import {
  CreateLibraryFileFieldsSchema,
  ErrorResponseSchema,
  LIBRARY_FILE_MAXIMUM_BYTES,
  LIBRARY_FILE_PART_NAMES,
  LibraryFileFileNameSchema,
  LibraryFileLinkResponseSchema,
  LibraryFileResponseSchema,
  LibraryFilesResponseSchema,
  UpdateLibraryFileRequestSchema,
  type LibraryFile as LibraryFileResponseBody,
} from "@telflo/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ServerDependencies } from "../../dependencies.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import {
  createInFlightCap,
  createPublicDownloadErrorHandler,
  PUBLIC_DOWNLOAD_REFERRER_POLICY,
  PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT,
  type InFlightCap,
  type PublicDownloadLogFields,
} from "../../http/public-download.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import {
  createAuthenticate,
  requireAuthentication,
  requireCurrentTerms,
  requireCurrentTermsUnlessProductAdmin,
  requireProductAdmin,
} from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { invalidUpload } from "../test-runs/errors.js";
import { discardUnreadUpload, readUploadParts, uploadPartLimits } from "../test-runs/upload-parts.js";
import { libraryFileTooLarge } from "./errors.js";
import { createLibraryLinks } from "./link.js";
import { createLibraryFileRepository, type LibraryFile } from "./repositories/library-file-repository.js";
import { createLibraryFileService, type LibraryFileWriter, type OpenedLibraryFile, type WithLibraryFilesTransaction } from "./service.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

export interface LibraryFilesRoutesDependencies extends ServerDependencies {
  now: () => Date;
}

/** Every answer here is the library's own content, a person's download or a link: no cache keeps a copy. */
const NO_STORE = "no-store";

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/** Any string: one that isn't a canonical UUID is 404 library_file_not_found, not 400. */
const FileParamsSchema = z.object({ fileId: z.string() });

/** Any string: a link of the wrong shape is the route's own plain 404, never a 400 naming it. */
const LinkParamsSchema = z.object({ link: z.string() });

const FILES_ROUTE = "/api/v1/library-files";

/** The public link's route (decision 45). The request log redacts it (request-log.ts' LIBRARY_LINK_ROUTE). */
export const LIBRARY_LINK_ROUTE_PATH = "/api/v1/library-links/:link";

/** A file's names go only into a response body. */
function toResponseBody(file: LibraryFile): LibraryFileResponseBody {
  return {
    id: file.id,
    name: file.name,
    description: file.description,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

/** The writer, for the audit row: never their organization (a product admin administers the product). */
function writerOf(request: FastifyRequest): LibraryFileWriter {
  const authentication = requireAuthentication(request);
  return {
    userId: authentication.context.userId,
    email: authentication.email,
    ipAddress: clientIpForAudit(request.ip),
    userAgent: auditUserAgent(request),
  };
}

/**
 * Streams a file's bytes (decision 22): never sniffed, a download with no
 * file name (the web names the saved file from the list, curl's `-o` from
 * the command: no person's text in a header), never cached. The public
 * link's reply also sends no Referer onwards.
 */
async function sendBytes(reply: FastifyReply, opened: OpenedLibraryFile, options: { isPublic: boolean }): Promise<FastifyReply> {
  const { stream } = opened;
  // The file stays open until the stream ends: a client that goes away first must not leave it open.
  const destroy = () => {
    if (!stream.destroyed) stream.destroy();
  };
  reply.raw.once("close", destroy);
  try {
    if (options.isPublic) void reply.header("referrer-policy", PUBLIC_DOWNLOAD_REFERRER_POLICY);
    return await reply
      .header("content-type", "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "attachment")
      .header("cache-control", NO_STORE)
      .header("content-length", opened.sizeBytes)
      .send(stream);
  } catch (error) {
    destroy();
    throw error;
  }
}

/**
 * Takes one of the cap's slots and holds it until the reply's socket closes
 * (Preflight ruling 11): the download streams up to 10 MiB after the
 * handler has returned, so InFlightCap.run's own release, on the handler's
 * settling, would free the slot before a byte was sent. Throws the cap's
 * 503 (Retry-After: 1) when every slot is held.
 */
async function holdUntilClosed(cap: InFlightCap, reply: FastifyReply): Promise<void> {
  await new Promise<void>((admitted, refused) => {
    cap
      .run(() => {
        admitted();
        return new Promise<void>((closed) => {
          if (reply.raw.destroyed) closed();
          else reply.raw.once("close", () => closed());
        });
      })
      .catch(refused);
  });
}

/**
 * The library endpoints (D23-2 decisions 5, 11, 20 to 22, 41 to 45, 48):
 *
 *   * `GET /api/v1/library-files`: the files, newest first, at most 1,000,
 *     for a member with the current terms, and for a product admin with or
 *     without them (the admin page's list); `no-store`.
 *   * `POST /api/v1/library-files` (multipart: `name`, `description`,
 *     `file`; 10 MiB), `PATCH` and `DELETE /api/v1/library-files/:fileId`:
 *     a product admin only (403 `product_admin_required`), without the
 *     terms; each audited in no organization, with ids and field names
 *     only; not rate limited (as test templates').
 *   * `GET /api/v1/library-files/:fileId/file`: a member with the current
 *     terms; the bytes; counted per person (`libraryFileDownloadsPerUser`)
 *     before the file is looked up.
 *   * `POST /api/v1/library-files/:fileId/link`: a member with the current
 *     terms; `201 { path }` (`/api/v1/library-links/tll_…`, Q162),
 *     `no-store`; counted per person (`libraryFileLinksPerUser`) before the
 *     file is looked up. Not audited (Q161).
 *   * `GET /api/v1/library-links/:link`: no session, no cookie read, no
 *     CSRF header (a GET); in order: the per-IP limit (`onRequest`, every
 *     request counted), the link checked (link.ts: 404 "Not found.", 410
 *     "This link has expired."), the per-link count keyed by
 *     `${fileId}:${expiry}` (never the link), a slot of 8 held until the
 *     reply's socket closes, the file (deleted: 404), its bytes. Plain-text
 *     refusals (the public download's error handler), `exposeHeadRoute:
 *     false`. Nothing of the link is read after its check: only the file's
 *     id goes on, and only ids reach a log line.
 *
 * The upload is in its own encapsulated plugin, the only one here with
 * @fastify/multipart registered: its parser reads nothing, so the body is
 * read in the handler, after `authenticate` and `requireProductAdmin`.
 *
 * The library is global (ADR 0008): every read and write goes through the
 * API's role with no database context and no row-level security.
 */
export function registerLibraryFilesRoutes(
  server: FastifyInstance,
  deps: LibraryFilesRoutesDependencies,
  rateLimiters: Pick<
    RateLimiters,
    "libraryFileDownloadsPerUser" | "libraryFileLinksPerUser" | "libraryLinksPerIp" | "libraryLinkDownloadsPerLink"
  >,
): void {
  const { db, fileStore, now, settings } = deps;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const productAdmin = [authenticate, requireProductAdmin];
  const memberRead = [authenticate, requireCurrentTerms];
  const withTransaction: WithLibraryFilesTransaction = (work) =>
    db.transaction().execute((transaction) =>
      work({ files: createLibraryFileRepository(transaction), audit: createAuditRepository(transaction) }),
    );
  const service = createLibraryFileService({
    files: createLibraryFileRepository(db),
    withTransaction,
    fileStore,
    links: createLibraryLinks(settings.library.signingKeys),
    now,
    log: server.log,
  });
  const downloads = createInFlightCap(PUBLIC_DOWNLOAD_RENDERS_IN_FLIGHT);
  /** The file a link named once checked, for its refusal's log line: ids only, never the link. */
  const linkedFiles = new WeakMap<FastifyRequest, PublicDownloadLogFields>();
  const typed = server.withTypeProvider<ZodTypeProvider>();

  void server.register(async (scope) => {
    // The upload alone parses multipart/form-data here. The parser only
    // marks the request; the body is read by request.parts() in the handler.
    await scope.register(multipart, {
      limits: { ...uploadPartLimits(LIBRARY_FILE_PART_NAMES), fileSize: LIBRARY_FILE_MAXIMUM_BYTES },
    });
    // A refused upload may leave its body unread: the rest is dropped, so
    // the answer reaches the client and the connection serves its next request.
    scope.addHook("onSend", async (request, reply, payload) => {
      if (reply.statusCode >= 400) discardUnreadUpload(request);
      return payload;
    });

    scope.withTypeProvider<ZodTypeProvider>().post(
      FILES_ROUTE,
      {
        preHandler: productAdmin,
        schema: {
          response: {
            201: LibraryFileResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            413: ErrorResponseSchema,
            415: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const writer = writerOf(request);
        // The id first, then the parts, in order: nothing of the body is read before the checks above.
        const { fileId } = await service.prepareCreate();
        const parts = await readUploadParts(request, LIBRARY_FILE_MAXIMUM_BYTES, LIBRARY_FILE_PART_NAMES, {
          tooLarge: libraryFileTooLarge,
        });
        const fields = CreateLibraryFileFieldsSchema.safeParse(parts.fields);
        const fileName = LibraryFileFileNameSchema.safeParse(parts.file.filename);
        if (!fields.success || !fileName.success) {
          parts.file.file.destroy();
          // No details: they could echo a name.
          throw invalidUpload();
        }
        const created = await service.create(writer, {
          fileId,
          ...fields.data,
          fileName: fileName.data,
          content: parts.file.file,
          maxBytes: LIBRARY_FILE_MAXIMUM_BYTES,
          finish: parts.finish,
        });
        return reply.status(201).header("cache-control", NO_STORE).send({ libraryFile: toResponseBody(created) });
      },
    );
  });

  typed.get(
    FILES_ROUTE,
    {
      preHandler: [authenticate, requireCurrentTermsUnlessProductAdmin],
      schema: { response: { 200: LibraryFilesResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema } },
    },
    async (_request, reply) => {
      const files = await service.list();
      return reply.header("cache-control", NO_STORE).send({ libraryFiles: files.map(toResponseBody) });
    },
  );

  typed.patch(
    `${FILES_ROUTE}/:fileId`,
    {
      preHandler: productAdmin,
      schema: {
        params: FileParamsSchema,
        body: UpdateLibraryFileRequestSchema,
        response: {
          200: LibraryFileResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const file = await service.update(writerOf(request), request.params.fileId, request.body);
      return reply.header("cache-control", NO_STORE).send({ libraryFile: toResponseBody(file) });
    },
  );

  typed.delete(
    `${FILES_ROUTE}/:fileId`,
    {
      preHandler: productAdmin,
      schema: {
        params: FileParamsSchema,
        response: { 204: noContent, 401: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      await service.remove(writerOf(request), request.params.fileId);
      return reply.status(204).send(null);
    },
  );

  // A file's bytes, for a member: counted per person before the lookup, so a 404 is counted too.
  typed.get(
    `${FILES_ROUTE}/:fileId/file`,
    // No response schema: the answer is a stream, and a refusal the envelope.
    { preHandler: memberRead, schema: { params: FileParamsSchema } },
    async (request, reply) => {
      rateLimiters.libraryFileDownloadsPerUser(requireAuthentication(request).context.userId);
      return sendBytes(reply, await service.openFile(request.params.fileId), { isPublic: false });
    },
  );

  // A new link, for a member: counted per person before the lookup; the path only in this 201's body.
  typed.post(
    `${FILES_ROUTE}/:fileId/link`,
    {
      preHandler: memberRead,
      schema: {
        params: FileParamsSchema,
        response: {
          201: LibraryFileLinkResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      rateLimiters.libraryFileLinksPerUser(requireAuthentication(request).context.userId);
      const path = await service.createLink(request.params.fileId);
      return reply.status(201).header("cache-control", NO_STORE).send({ path });
    },
  );

  typed.get(
    LIBRARY_LINK_ROUTE_PATH,
    {
      exposeHeadRoute: false,
      onRequest: rateLimiters.libraryLinksPerIp,
      errorHandler: createPublicDownloadErrorHandler((request) => linkedFiles.get(request)),
      schema: { params: LinkParamsSchema },
    },
    async (request, reply) => {
      // From here on only the file's id and the expiry: nothing else of the link is read.
      const { fileId, expiresAt } = service.checkLink(request.params.link);
      linkedFiles.set(request, { libraryFileId: fileId });
      rateLimiters.libraryLinkDownloadsPerLink.count(`${fileId}:${expiresAt}`);
      await holdUntilClosed(downloads, reply);
      return sendBytes(reply, await service.openLinkedFile(fileId), { isPublic: true });
    },
  );
}
