import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import type { ServerDependencies } from "../../dependencies.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { OpampRegistration } from "../organizations/opamp-registration.js";
import { createAuthenticate, requireAuthentication, requireProductAdmin } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import type { ProductAdminActor } from "./repositories/system-repository.js";

/*
 * What the product-admin routes share: the prefix, the gate
 * (`[authenticate, requireProductAdmin]`: no terms check, as the four
 * pages built; CSRF is global), `cache-control: no-store` on every answer
 * (they carry other people's personal data), the actor of the audit rows,
 * and the path's id schema (any string: one that isn't a canonical UUID is
 * the route's 404, through canonicalIdOf, never a 400).
 */

/** Every product-admin route is under this prefix; the request log drops their queries. */
export const PRODUCT_ADMIN_ROUTE_PREFIX = "/api/v1/product-admin";

/** What buildServer's module dependencies hold that these routes read. */
export interface ProductAdminRoutesDependencies extends ServerDependencies {
  now: () => Date;
  runAfterResponse: RunAfterResponse;
  opampRegistration: OpampRegistration;
}

/** `[authenticate, requireProductAdmin]`, the flag read live on each request. */
export function productAdminGate(deps: ProductAdminRoutesDependencies): preHandlerAsyncHookHandler[] {
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  return [authenticate, requireProductAdmin];
}

/** Every answer, refusals included: no cache keeps another person's data. */
export async function noStore(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  void reply.header("cache-control", "no-store");
  return payload;
}

/** 204 carries no body; Fastify drops the payload for it. */
export const noContent = z.null();

/** A path's user id: any string (canonicalIdOf decides). */
export const UserIdParamsSchema = z.object({ userId: z.string() }).strict();

/** A path's feedback id: any string (canonicalIdOf decides). */
export const FeedbackIdParamsSchema = z.object({ id: z.string() }).strict();

/** The product admin behind the request, for the audit row: their id, their email (actor_email), address and agent. */
export function productAdminActorOf(request: FastifyRequest): ProductAdminActor {
  const authentication = requireAuthentication(request);
  return {
    userId: authentication.context.userId,
    email: authentication.email,
    ipAddress: clientIpForAudit(request.ip),
    userAgent: auditUserAgent(request),
  };
}
