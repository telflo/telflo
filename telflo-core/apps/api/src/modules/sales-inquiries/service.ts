import type { SalesInquiryErrorCode } from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import { AppError } from "../../errors.js";
import type { IMailer } from "../../mail/mailer.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import { buildSalesInquiryEmail } from "./emails.js";

/**
 * What the submitter is told when the send fails: fixed words naming no address.
 */
export const SALES_INQUIRY_FAILED_MESSAGE = "Your message couldn't be sent. Please try again later.";

export interface SalesInquiryServiceDependencies {
  audit: IAuditRepository;
  mailer: IMailer;
  /** TELFLO_SALES_INQUIRY_TO: the inbox every inquiry goes to. */
  recipient: string;
  log: Pick<FastifyBaseLogger, "error">;
}

export interface SalesInquiryInput {
  name: string;
  email: string;
  message: string;
  /** Where the request came from, for the audit trail. */
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface ISalesInquiryService {
  submit(input: SalesInquiryInput): Promise<void>;
}

function salesInquiryFailed(): AppError {
  return new AppError("sales_inquiry_failed" satisfies SalesInquiryErrorCode, SALES_INQUIRY_FAILED_MESSAGE, 502);
}

export function createSalesInquiryService(deps: SalesInquiryServiceDependencies): ISalesInquiryService {
  const { audit, mailer, recipient, log } = deps;

  return {
    /**
     * Sends one email to the team's inbox, with Reply-To the submitter, and
     * audits it either way. The audit row has the address and the outcome,
     * never the message, and no actor or organization: the submitter has no
     * account as far as this endpoint knows. The mailer's error is logged
     * on its own; the response carries none of it.
     *
     * The answer follows the send, not the audit row: a sent inquiry whose
     * row couldn't be written is still accepted, since the email has gone
     * and a retry would send it again; a failed send is still 502. A failed
     * audit write is logged.
     */
    async submit(input: SalesInquiryInput): Promise<void> {
      const origin = { ipAddress: input.ipAddress, userAgent: input.userAgent };
      const auditOutcome = async (outcome: "sent" | "send_failed") => {
        try {
          await audit.record({ action: "sales_inquiry.received", metadata: { email: input.email, outcome }, ...origin });
        } catch (error) {
          log.error({ err: error }, "a sales inquiry's audit row couldn't be written");
        }
      };
      try {
        await mailer.send({ to: recipient, replyTo: input.email, ...buildSalesInquiryEmail(input) });
      } catch (error) {
        log.error({ err: error }, "a sales inquiry couldn't be sent");
        await auditOutcome("send_failed");
        throw salesInquiryFailed();
      }
      await auditOutcome("sent");
    },
  };
}
