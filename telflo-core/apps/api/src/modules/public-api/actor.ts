import type { FastifyRequest } from "fastify";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { FlowReader } from "../flows/service.js";
import type { Actor } from "../organizations/service.js";
import { requireApiTokenAuthentication } from "./authenticate-api-token.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

/*
 * The token-aware twins of the browser routes' session-only helpers (D25
 * decision 15, Preflight ruling 5). No public route calls
 * `requireAuthentication`, `actorOf` or `requireCurrentTerms`.
 */

/**
 * The caller of a public route, for the services' checks and the audit
 * trail, as `actorOf` builds a session's: the token's context (its user in
 * its organization, with the membership's role), its user's address
 * (decision 12), and where the request came from. Throws the one 401 when
 * the token check didn't accept the request, so a route that missed it
 * fails closed.
 */
export function apiActorOf(request: FastifyRequest): Actor {
  const authentication = requireApiTokenAuthentication(request);
  return {
    context: authentication.context,
    email: authentication.email,
    ipAddress: clientIpForAudit(request.ip),
    userAgent: auditUserAgent(request),
  };
}

/**
 * The flows' reader for a token (Preflight ruling 5): never a product
 * admin, so the public surface reads the published flows only, whoever
 * holds the token.
 */
export const publicFlowReader: FlowReader = Object.freeze({ isProductAdmin: false });
