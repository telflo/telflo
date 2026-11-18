import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import type { FastifyBaseLogger } from "fastify";
import { withAuthContext, type AuthContext } from "../../database/context.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import type { IMailer } from "../../mail/mailer.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { buildFeedbackAdminEmail, feedbackReviewUrl } from "./emails.js";
import { createFeedbackRepository, listFeedbackRecipients, type FeedbackRecipient } from "./repositories/feedback-repository.js";

/*
 * "Contact us" (D29 decisions 6, 15, 32 and 35): a signed-in person's
 * message to Telflo, in the organization they act in.
 *
 * The item and its `feedback.created` audit row (the person's organization,
 * the item's id, no text) are written in one transaction in the person's
 * own context. After the response, every product admin is emailed,
 * separately: the sender's email and a link to the page, never the text.
 *
 * A failed send is logged with the item's and the recipient's ids and fixed
 * words only, never the error (Preflight ruling 11: an SMTP or SendGrid
 * error can quote the recipient's address); one admin's failure doesn't
 * stop the others. The recipients' read is caught the same way, so nothing
 * reaches the after-response runner's catch-all, which logs `err`.
 */

/** The sender: their session's context, their email (the admins' email names it), and where the request came from. */
export interface FeedbackSender {
  context: AuthContext;
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface FeedbackServiceDependencies {
  db: Kysely<Database>;
  mailer: IMailer;
  runAfterResponse: RunAfterResponse;
  log: Pick<FastifyBaseLogger, "error">;
  now: () => Date;
  /** TELFLO_PUBLIC_WEB_URL: the admins' link to the page. */
  publicWebUrl: string;
  /** Counts one message for the person, or throws the 429 (`feedbackPerUser`, 10 an hour). */
  countFeedback: (userId: string) => void;
  /** The recipients' read; the repository's by default. */
  listRecipients?: (db: Kysely<Database>) => Promise<FeedbackRecipient[]>;
}

export interface IFeedbackService {
  /** Writes the item (`text` trimmed and checked by the contract) and answers its id; the admins' emails follow the response. */
  create(sender: FeedbackSender, text: string): Promise<string>;
}

export function createFeedbackService(deps: FeedbackServiceDependencies): IFeedbackService {
  const { db, mailer, runAfterResponse, log, now, publicWebUrl, countFeedback } = deps;
  const listRecipients = deps.listRecipients ?? listFeedbackRecipients;
  const reviewUrl = feedbackReviewUrl(publicWebUrl);

  /** Emails each product admin about the item: the sender's email, never the text. Logs ids and fixed words only. */
  async function notifyProductAdmins(feedbackId: string, senderEmail: string): Promise<void> {
    let recipients: FeedbackRecipient[];
    try {
      recipients = await listRecipients(db);
    } catch {
      log.error({ feedbackId }, "a feedback item's product admins couldn't be read, so none was emailed");
      return;
    }
    const message = buildFeedbackAdminEmail({ senderEmail, reviewUrl });
    for (const recipient of recipients) {
      try {
        await mailer.send({ to: recipient.email, ...message });
      } catch {
        log.error({ feedbackId, recipientUserId: recipient.userId }, "a feedback item's email to a product admin couldn't be sent");
      }
    }
  }

  return {
    async create(sender, text) {
      const { context } = sender;
      countFeedback(context.userId);
      const feedbackId = await withAuthContext(db, context, async (transaction) => {
        const id = await createFeedbackRepository(transaction).insert({
          userId: context.userId,
          organizationId: context.organizationId,
          text,
          createdAt: now(),
        });
        await createAuditRepository(transaction).record({
          action: "feedback.created",
          actorUserId: context.userId,
          actorEmail: sender.email,
          organizationId: context.organizationId,
          subjectType: "feedback",
          subjectId: id,
          metadata: {},
          ipAddress: sender.ipAddress,
          userAgent: sender.userAgent,
        });
        return id;
      });
      runAfterResponse(() => notifyProductAdmins(feedbackId, sender.email));
      return feedbackId;
    },
  };
}
