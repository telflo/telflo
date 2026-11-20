import type { Kysely, Transaction } from "kysely";
import type { Database } from "@telflo/db";

/**
 * An audit event. `action` is a dotted, past-tense identifier —
 * `user.registered`, `user.email_verified` — so the log reads as a history.
 */
export interface AuditEvent {
  action: string;
  actorUserId?: string | undefined;
  actorEmail?: string | undefined;
  organizationId?: string | undefined;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface IAuditRepository {
  record(event: AuditEvent): Promise<void>;
}

export function createAuditRepository(db: Kysely<Database> | Transaction<Database>): IAuditRepository {
  return {
    /**
     * Insert only, deliberately: there is no method to modify or remove an
     * event. Append-only-ness holds twice over. A `BEFORE UPDATE OR DELETE`
     * trigger on the table (packages/db/migrations/1700000000001_identity.js)
     * refuses every role, the owner included. And the API connects as its own
     * login role, not a superuser: through telflo_platform_runtime it holds
     * only `select, insert` on audit_events (migration 1700000000009), so an
     * update or delete is refused by grant before the trigger is reached. The
     * API refuses to start as a superuser, which would bypass both the grants
     * and row-level security.
     *
     * actorEmail is a snapshot: it must be passed by the caller rather than
     * joined at read time, so the trail survives deletion of the user.
     */
    async record(event: AuditEvent): Promise<void> {
      await db
        .insertInto("audit_events")
        .values({
          action: event.action,
          actor_user_id: event.actorUserId ?? null,
          actor_email: event.actorEmail ?? null,
          organization_id: event.organizationId ?? null,
          subject_type: event.subjectType ?? null,
          subject_id: event.subjectId ?? null,
          metadata: JSON.stringify(event.metadata ?? {}),
          ip_address: event.ipAddress ?? null,
          user_agent: event.userAgent ?? null,
        })
        .execute();
    },
  };
}
