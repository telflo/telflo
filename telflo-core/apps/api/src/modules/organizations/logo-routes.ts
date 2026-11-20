import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withOrganizationContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import { publicDownloadErrorHandler } from "../../http/public-download.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { organizationLogoNotFound } from "./errors.js";
import { createActiveOrganizationRepository } from "./repositories/organization-repository.js";
import { canonicalIdOf, organizationLogoKey } from "./service.js";

/*
 * The public logo read:
 * GET /api/v1/organization-logos/{organizationId}/{logoId}, for anyone, with
 * no session, no cookie read and no CSRF header (a GET). The sidebar's
 * switcher and the Settings cards show it as an `<img>`; a later email or
 * page elsewhere may too. Registered outside the organization routes'
 * hooks: no `authenticate`, no terms.
 *
 * In order: the per-IP limit (the `onRequest` hook, every request counted);
 * both ids canonical (`canonicalIdOf`), before anything reaches the
 * database, which casts them to uuid; the organization live and its
 * logo_id the path's, read in its context with no person (the organization
 * has no row-level security, so the scope's filter is the guard); the
 * bytes from the store; then the bytes streamed with the type stored at
 * upload, cached for good (a new upload is a new id, so a URL's bytes
 * never change), `nosniff` and `Content-Security-Policy: sandbox` whatever
 * the type, `Cross-Origin-Resource-Policy: cross-origin`, no
 * Content-Disposition. Anything else (a malformed id, an organization
 * deleted or never there, an old or removed logo's id, bytes that are
 * gone) is the same plain-text 404 "Not found.". A HEAD isn't routed
 * (`exposeHeadRoute: false`), as the public download's.
 *
 * The URL holds ids only, so the request log needs no rule for it.
 */

/** A logo's URL never changes its bytes: a new upload is a new logo id. */
const LOGO_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Any strings: a malformed id is the route's own 404, in plain text, never a 400. */
const LogoParamsSchema = z.object({ organizationId: z.string(), logoId: z.string() });

export const ORGANIZATION_LOGO_ROUTE = "/api/v1/organization-logos/:organizationId/:logoId";

export function registerOrganizationLogoRoutes(
  server: FastifyInstance,
  deps: ServerDependencies,
  rateLimiters: Pick<RateLimiters, "organizationLogosPerIp">,
): void {
  const { db, fileStore } = deps;

  server.withTypeProvider<ZodTypeProvider>().get(
    ORGANIZATION_LOGO_ROUTE,
    {
      exposeHeadRoute: false,
      onRequest: rateLimiters.organizationLogosPerIp,
      errorHandler: publicDownloadErrorHandler,
      schema: { params: LogoParamsSchema },
    },
    async (request, reply) => {
      const organizationId = canonicalIdOf(request.params.organizationId);
      const logoId = canonicalIdOf(request.params.logoId);
      if (organizationId === undefined || logoId === undefined) throw organizationLogoNotFound();
      const logo = await withOrganizationContext(db, organizationId, (transaction) =>
        createActiveOrganizationRepository(transaction, { organizationId }).findLogo(),
      );
      if (logo === undefined || logo.logoId !== logoId) throw organizationLogoNotFound();
      const opened = await fileStore.read(organizationLogoKey(organizationId, logo.logoId));
      if (!opened.found) throw organizationLogoNotFound();
      const { stream } = opened;
      // The file stays open until the stream ends: a client that goes away first must not leave it open.
      const destroy = () => {
        if (!stream.destroyed) stream.destroy();
      };
      reply.raw.once("close", destroy);
      try {
        return await reply
          .header("content-type", logo.contentType)
          .header("content-length", opened.sizeBytes)
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "sandbox")
          .header("cache-control", LOGO_CACHE_CONTROL)
          .header("cross-origin-resource-policy", "cross-origin")
          .send(stream);
      } catch (error) {
        destroy();
        throw error;
      }
    },
  );
}
