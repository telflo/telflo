import { isIP } from "node:net";

/**
 * `request.ip` comes from X-Forwarded-For once proxy hops are trusted, so a
 * client can put any text there. audit_events.ip_address is `inet`, and a
 * malformed value would fail the insert with a Postgres type error (Ruling
 * 39). Only a well-formed IPv4 or IPv6 address is recorded; anything else is
 * recorded as absent.
 */
export function clientIpForAudit(ip: string): string | undefined {
  return isIP(ip) === 0 ? undefined : ip;
}
