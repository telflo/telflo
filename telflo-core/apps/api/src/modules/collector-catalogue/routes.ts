import { CollectorDistributionsResponseSchema, ErrorResponseSchema } from "@telflo/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthenticate } from "../sessions/authenticate.js";
import { createDatabaseSessionService, type SessionRoutesDependencies } from "../sessions/routes.js";
import { createCollectorCatalogueRepository } from "./repositories/collector-catalogue-repository.js";

/**
 * `GET /api/v1/collector-distributions` (D13a decision 11, Ruling 26): the
 * catalogue the create dialog's and the toolbar's pickers read. Every
 * distribution, in the catalogue's order, with the versions it offers,
 * newest first; deprecated versions are left out (decision 4), as are each
 * version's binaries and image, which only the images that bake them read
 * (decision 2). Each distribution carries the collector's renames (D13b
 * decision 6), which the web doesn't read: it takes its own copy from the
 * catalogue when it is built (D13b Preflight ruling 15).
 *
 * Signed in, and not under an organization: the catalogue is global (ADR
 * 0008), the same for every organization, as `/api/v1/organizations` is no
 * one organization's. Like that path and `/me`, it doesn't run
 * `requireCurrentTerms`: the terms gate data endpoints, and the catalogue
 * holds no one's data. It reads through the API's role, which may only
 * read the catalogue's tables (migration 1700000000023); with no row-level
 * security on them, no database context is needed.
 */
export function registerCollectorCatalogueRoutes(server: FastifyInstance, deps: SessionRoutesDependencies): void {
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const catalogue = createCollectorCatalogueRepository(deps.db);
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/v1/collector-distributions",
    {
      preHandler: authenticate,
      schema: { response: { 200: CollectorDistributionsResponseSchema, 401: ErrorResponseSchema } },
    },
    async (_request, reply) => {
      const distributions = await catalogue.listOffered();
      return reply.send({ distributions });
    },
  );
}
