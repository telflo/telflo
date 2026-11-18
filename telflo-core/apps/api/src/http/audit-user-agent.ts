import type { FastifyRequest } from "fastify";
import { mayHoldCredential, REDACTED_FIELD } from "./request-log.js";

/*
 * The User-Agent as the platform stores it (D25 Ruling 186): in an audit
 * row's user_agent, a session's, an inquiry's. A client may put anything
 * there, a `tf_` token included (a CI runner's own name holding it), and an
 * audit row keeps it for good. So every site that keeps a User-Agent reads
 * it through here: REDACTED_FIELD when it may hold a `tf_`, `tll_` or
 * `tqd_` credential in any spelling the request log recognizes, otherwise
 * the header as sent (absent stays absent).
 */
export function auditUserAgent(request: FastifyRequest): string | undefined {
  const userAgent = request.headers["user-agent"];
  if (userAgent === undefined) return undefined;
  return mayHoldCredential(userAgent) ? REDACTED_FIELD : userAgent;
}
