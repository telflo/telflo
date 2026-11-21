import { USER_FEEDBACK_PAGE_SIZE, type UserFeedbackPage } from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { RunAfterResponse } from "../../http/after-response.js";
import type { IMailer } from "../../mail/mailer.js";
import { buildFeedbackReplyEmail } from "../feedback/emails.js";
import { canonicalIdOf } from "../organizations/service.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { feedbackAuthorDeleted, feedbackNotFound, productAdminRequired } from "./errors.js";
import type { FeedbackHandling, ISystemRepository, ProductAdminActor } from "./repositories/system-repository.js";

/*
 * User Feedback for product admins, on the SystemRepository (every read and
 * write audited there but the pending count, a number with no personal
 * data).
 *
 * - The list: the pending items, newest first, 25 a page, by an opaque
 *   cursor (a bad one 400 `invalid_request`).
 * - Acknowledge marks the item handled, then, after the response, emails
 *   the reply to the sender (mark, then email). The reply is never stored,
 *   logged or audited; a failed send is logged with the item's id and
 *   fixed words only, never the error (an SMTP or SendGrid error can quote
 *   the recipient), and the item stays handled.
 * - Dismiss marks it handled; no email.
 * - Either: a path id that isn't a canonical UUID, or an item missing or
 *   handled already, is 404 `feedback_not_found`; a caller who lost the
 *   flag meanwhile 403 `product_admin_required`; an acknowledge whose
 *   sender's account is deleted 409 `feedback_author_deleted` (the item
 *   stays pending: Dismiss still works).
 */

export interface FeedbackAdminServiceDependencies {
  system: ISystemRepository;
  mailer: IMailer;
  runAfterResponse: RunAfterResponse;
  log: Pick<FastifyBaseLogger, "error">;
  now: () => Date;
  /** Counts one write for the product admin, or throws the 429 (`productAdminWritesPerUser`, shared with grant and remove). */
  countWrite: (userId: string) => void;
}

export interface IFeedbackAdminService {
  list(actor: ProductAdminActor, cursor: string | undefined): Promise<UserFeedbackPage>;
  pendingCount(actor: ProductAdminActor): Promise<number>;
  acknowledge(actor: ProductAdminActor, feedbackId: string, reply: string): Promise<void>;
  dismiss(actor: ProductAdminActor, feedbackId: string): Promise<void>;
}

export function createFeedbackAdminService(deps: FeedbackAdminServiceDependencies): IFeedbackAdminService {
  const { system, mailer, runAfterResponse, log, now, countWrite } = deps;

  /** Marks the item; answers the sender's address for an acknowledge, or throws the route's refusal. */
  async function handle(actor: ProductAdminActor, feedbackId: string, handling: FeedbackHandling): Promise<string> {
    const id = canonicalIdOf(feedbackId);
    if (id === undefined) throw feedbackNotFound();
    countWrite(actor.userId);
    const result = await system.handleFeedback(actor, id, handling, now());
    switch (result.outcome) {
      case "handled":
        return result.sender.email;
      case "not_found":
        throw feedbackNotFound();
      case "forbidden":
        throw productAdminRequired();
      case "author_deleted":
        throw feedbackAuthorDeleted();
    }
  }

  return {
    async list(actor, cursor) {
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      // The repository reads one more than a page (whether another follows) and audits the rows returned.
      const { rows: page, hasMore } = await system.listFeedback(actor, { after, pageSize: USER_FEEDBACK_PAGE_SIZE });
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          email: row.email,
          text: row.text,
          createdAt: row.createdAt.toISOString(),
          authorDeleted: row.authorDeleted,
        })),
        nextCursor:
          hasMore && last !== undefined ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
      };
    },

    pendingCount(actor) {
      return system.countPendingFeedback(actor);
    },

    async acknowledge(actor, feedbackId, reply) {
      const recipient = await handle(actor, feedbackId, "acknowledged");
      const id = feedbackId.toLowerCase();
      runAfterResponse(async () => {
        try {
          await mailer.send({ to: recipient, ...buildFeedbackReplyEmail({ reply }) });
        } catch {
          log.error({ feedbackId: id }, "an acknowledged feedback item's reply couldn't be sent");
        }
      });
    },

    async dismiss(actor, feedbackId) {
      await handle(actor, feedbackId, "dismissed");
    },
  };
}
