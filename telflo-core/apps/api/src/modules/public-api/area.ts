import type { FastifyInstance } from "fastify";
import type { ServerDependencies } from "../../dependencies.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import type { ModuleServices } from "../services.js";

/*
 * What each area of the public surface (`public-api/<area>/routes.ts`)
 * registers its routes with: the plugin's instance, so every route runs
 * the token check, the per-token limit and the access check, and the shared
 * services, never a second instance.
 */

export interface PublicApiRoutesDependencies extends ServerDependencies {
  now: () => Date;
  /** buildServer's shared instances (modules/services.ts). */
  services: ModuleServices;
}

export interface PublicApiAreaContext {
  deps: PublicApiRoutesDependencies;
  rateLimiters: RateLimiters;
}

/** An area's routes, registered into the public plugin. Every route declares `config.access` (access.ts). */
export type PublicApiArea = (api: FastifyInstance, context: PublicApiAreaContext) => void;
