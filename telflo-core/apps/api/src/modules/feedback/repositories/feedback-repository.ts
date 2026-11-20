import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@telflo/db";

/*
 * "Contact us"'s two reads and writes.
 *
 * - The insert, in the sender's own request and database context: the API's
 *   role holds INSERT only on user_feedback, so the id comes from the API
 *   (`select uuidv7()`) and the insert never uses RETURNING, which would
 *   need SELECT.
 * - The recipients: every live, verified human who is a product admin, read
 *   in the sender's request, which isn't a product admin's. An exception to
 *   the audited path: a plain query on `users` (a global table, no
 *   row-level security), written here and nowhere else (a test pins the
 *   files naming the flag's column). Their emails go only to the mailer:
 *   never a log line, an error or an audit row.
 */

export interface NewFeedback {
  userId: string;
  /** The organization the person is acting in (the session's): context only. */
  organizationId: string;
  /** Trimmed, 1 to 5,000 characters (the contract and the table's check). Personal data. */
  text: string;
  /** The API's clock. */
  createdAt: Date;
}

export interface FeedbackRecipient {
  userId: string;
  email: string;
}

export interface IFeedbackRepository {
  /** Writes the item and answers its id. */
  insert(feedback: NewFeedback): Promise<string>;
}

export function createFeedbackRepository(transaction: Transaction<Database>): IFeedbackRepository {
  return {
    async insert(feedback) {
      const { rows } = await sql<{ id: string }>`select uuidv7() as id`.execute(transaction);
      const id = rows[0]!.id;
      await transaction
        .insertInto("user_feedback")
        .values({
          id,
          user_id: feedback.userId,
          organization_id: feedback.organizationId,
          text: feedback.text,
          created_at: feedback.createdAt,
        })
        .execute();
      return id;
    },
  };
}

/** Every live, verified human product admin, by id: who is emailed about a new item. */
export async function listFeedbackRecipients(db: Kysely<Database>): Promise<FeedbackRecipient[]> {
  const rows = await db
    .selectFrom("users")
    .select(["id", "email"])
    .where("is_product_admin", "=", true)
    .where("deleted_at", "is", null)
    .where("email_verified_at", "is not", null)
    .where("kind", "=", "human")
    .orderBy("id")
    .execute();
  return rows.map((row) => ({ userId: row.id, email: row.email }));
}
