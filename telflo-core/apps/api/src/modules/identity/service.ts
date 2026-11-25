import type {
  IdentityErrorCode,
  RegisterRequest,
  RegisterResponse,
  VerificationEmailRequest,
  VerifyEmailRequest,
  VerifyEmailResponse,
} from "@telflo/contracts";
import type { AppSettings } from "../../settings.js";
import { AppError } from "../../errors.js";
import type { OpampRegistration } from "../organizations/opamp-registration.js";
import { hashPassword } from "./password.js";
import { assertAddressNotReserved } from "./reserved-domain.js";
import { assertCurrentTermsVersion, siteAsksForTerms } from "./terms.js";
import { generateVerificationToken, hashToken } from "./tokens.js";
import type { IMailer } from "../../mail/mailer.js";
import { buildDuplicateRegistrationEmail, buildVerificationEmail } from "./emails.js";
import type { IAuditRepository } from "./repositories/audit-repository.js";
import { createRegistrationTiming } from "./registration-timing.js";
import { DuplicateEmailError, type IUserRepository } from "./repositories/user-repository.js";
import type { IVerificationTokenRepository } from "./repositories/verification-token-repository.js";

export interface IdentityDependencies {
  users: IUserRepository;
  verificationTokens: IVerificationTokenRepository;
  audit: IAuditRepository;
  mailer: IMailer;
  settings: AppSettings;
  /** The clock for token issue and expiry, and for when the terms were accepted. */
  now: () => Date;
  /** Registers the new personal organization in the opamp-server after the commit. */
  opampRegistration: OpampRegistration;
}

export type RegisterUserInput = RegisterRequest & {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export type VerifyEmailInput = VerifyEmailRequest & {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export type ResendVerificationInput = VerificationEmailRequest & {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

const HOUR_IN_MILLISECONDS = 60 * 60 * 1000;

/**
 * Roughly the new-account path's post-hash cost measured locally (see
 * registerUser). Used only until this process has served its first real
 * registration; after that the duplicate path waits a real, recent
 * observation instead.
 *
 * Re-measured on 2026-09-28 with the starter configuration, which adds a
 * configuration, its version 1 and an audit row to the account's
 * transaction: the post-hash cost itself, 50 registrations through this
 * service with an in-memory mailer against the compose database, three
 * repetitions. Median 14.1-15.0 ms with the starter, 10.2-10.9 ms with it
 * taken out.
 */
const REGISTRATION_WAIT_FALLBACK_MILLISECONDS = 15;
const REGISTRATION_TIMING_CAPACITY = 64;

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createIdentityService(deps: IdentityDependencies) {
  const { users, verificationTokens, audit, mailer, settings, now, opampRegistration } = deps;
  const registrationTiming = createRegistrationTiming({
    capacity: REGISTRATION_TIMING_CAPACITY,
    fallbackMilliseconds: REGISTRATION_WAIT_FALLBACK_MILLISECONDS,
  });

  function expiryFromNow(): Date {
    return new Date(now().getTime() + settings.verificationTokenTtlHours * HOUR_IN_MILLISECONDS);
  }

  /** The verification email, carrying `token`'s link. */
  async function sendVerificationEmail(email: string, token: string): Promise<void> {
    await mailer.send({
      to: email,
      ...buildVerificationEmail({
        // In the fragment, as the reset's and the invitation's: it never reaches a server, its logs or a Referer.
        verificationUrl: `${settings.publicWebUrl}/verify-email#token=${token}`,
        ttlHours: settings.verificationTokenTtlHours,
      }),
    });
  }

  /**
   * The "an account already exists" response, shared by the two ways
   * registerUser discovers that: finding the row up front, and losing a
   * concurrent insert race to it (see the DuplicateEmailError handling
   * below). Both must produce the identical response and audit trail, or
   * the race-losing path becomes a second, subtler enumeration signal.
   */
  async function sendDuplicateNotice(
    existing: { id: string; email: string; passwordHash: string | null },
    input: RegisterUserInput,
  ): Promise<RegisterResponse> {
    await mailer.send({
      to: existing.email,
      ...buildDuplicateRegistrationEmail({
        signInUrl: `${settings.publicWebUrl}/login`,
        forgotPasswordUrl: `${settings.publicWebUrl}/forgot-password`,
        hasPassword: existing.passwordHash !== null,
      }),
    });
    await audit.record({
      action: "user.registration_attempted_existing_email",
      actorUserId: existing.id,
      actorEmail: existing.email,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    return { status: "verification_sent" };
  }

  return {
    /**
     * Enumeration-safe: both branches return an identical response, and the
     * duplicate-email branch also pays the same dominant Argon2id cost as a
     * real registration (see the discarded hash below) — closing the one
     * difference an attacker could otherwise measure by timing, since
     * Argon2id is tuned to be slow on purpose. This is not a claim of exact
     * constant time: database lookup latency still varies, and the two
     * branches send different emails. What is guaranteed is that the
     * dominant, deliberately-slow cost is paid on both paths, and that the
     * duplicate branch then waits out the new-account path's database work
     * (below), so the remaining gap is small relative to ordinary
     * request-latency variance. Whether an account exists is disclosed only
     * to the address itself, by email — never to whoever submitted the form.
     *
     * As first measured, creating an account ran a transaction of three
     * inserts, then three audit inserts and the token insert, each
     * committing on its own. (All seven now run in one transaction;
     * re-measured at the end.) Measured locally on 2026-09-24 against the
     * compose database, 50 interleaved runs each through this service with
     * an in-memory mailer, three repetitions, the duplicate path unpadded:
     * new-account 19.7-21.3 ms, duplicate 11.5-12.2 ms, a gap of 8.2-9.1 ms.
     * Over the 5 ms threshold, and larger than the duplicate path's own
     * spread (10.8-14.5 ms), so a handful of timed requests would tell the
     * paths apart.
     * Decision: the duplicate branch waits, writing nothing. Options weighed:
     *   - insert and roll back: load on the database for no data.
     *   - read-only queries in place of the writes: pays the round trips but
     *     not the cost of committing writes, so it under-pays by an amount
     *     that depends on the database's storage.
     *   - a constant delay: right only for the machine it was measured on; a
     *     database across a network in production makes every write slower
     *     and the constant stale.
     *   - chosen: wait a duration sampled from this process's recent
     *     new-account registrations (registration-timing.ts), measured from
     *     after the hash to the end. It tracks the deployment's real database
     *     and load, reproduces the real path's spread rather than a single
     *     value, and costs a timer, not a query. Until the first real
     *     registration it waits REGISTRATION_WAIT_FALLBACK_MILLISECONDS.
     *     Samples are per process. Both duplicate branches pad: the
     *     `existing` branch and the concurrent-insert loser below, which
     *     otherwise pays only a failed first insert and a refetch. Neither
     *     records a sample; only a completed registration does.
     * With the wait (same method): new-account median 21.0-22.6 ms,
     * duplicate 21.2-21.8 ms, a gap of -0.2 to +0.8 ms.
     * Re-measured with all seven inserts in one transaction (same method):
     * new-account 20.1-20.6 ms, existing-email duplicate 20.6-20.9 ms, gap
     * -0.5 to -0.4 ms.
     * Accepted residue: double submission. Two simultaneous registrations
     * for one address let the sender compare the two responses. For a new
     * address the loser is consistently later than its winner (median
     * 23.4-23.6 ms against 20.0-20.4 ms in 50 simultaneous pairs, same
     * method), because its insert waits for the winner's to commit; padding
     * cannot remove that, since it can only add time. For an existing
     * address both requests take the padded `existing` branch. Accepted
     * because: in production the existing-address pair also differs by the
     * spread of two independent samples, so the signal is statistical, not
     * one-shot; every probe emails the address owner, and a new-address probe
     * creates their account; and registration is rate limited per IP.
     * Rejected fix: a per-address advisory lock held through the padding,
     * which would hold a pooled connection for the whole registration (about
     * 20 ms locally, Argon2 included) instead of just its transaction, and
     * needs care to avoid exhausting the pool. Accepted as a risk.
     */
    async registerUser(input: RegisterUserInput): Promise<RegisterResponse> {
      // Before the email lookup, so an old version is refused the same way
      // for a new and an existing address. What it accepts is the site's
      // version, which the account records. A site that asks for no Terms
      // checks nothing here, whatever the request carries, and the account
      // records none.
      const siteTermsVersion = settings.site.terms.version;
      const asksForTerms = siteAsksForTerms(siteTermsVersion);
      if (asksForTerms) assertCurrentTermsVersion(input.acceptedTermsVersion, siteTermsVersion);
      // After the terms, before the lookup and the hash: the domain is
      // refused, whether or not a service account holds the address, so the
      // answer says nothing about which addresses exist.
      assertAddressNotReserved(input.email);
      const existing = await users.findByEmail(input.email);

      if (existing) {
        // Closes the timing side-channel: pays the same Argon2id cost the
        // new-account path pays below, then discards it. The result must
        // never be stored, logged, or returned — it exists purely so this
        // branch takes comparable wall-clock time. Do not "optimize" this
        // away; it is the point.
        await hashPassword(input.password);
        // Then waits out the new-account path's database work, which this
        // branch does not do (the wait described above). Same rule: not
        // dead code, do not remove it.
        const afterHash = performance.now();
        const response = await sendDuplicateNotice(existing, input);
        await wait(registrationTiming.sample() - (performance.now() - afterHash));
        return response;
      }

      const passwordHash = await hashPassword(input.password);
      const afterHash = performance.now();

      const { token, tokenHash } = generateVerificationToken();

      // One reading of the clock: the terms are accepted when the account,
      // and its starter configuration, are created.
      const createdAt = now();
      let user;
      let organization;
      try {
        ({ user, organization } = await users.createAccount(
          {
            email: input.email,
            passwordHash,
            terms: asksForTerms ? { version: siteTermsVersion, acceptedAt: createdAt } : null,
            emailVerifiedAt: null,
            createdAt,
            origin: { ipAddress: input.ipAddress, userAgent: input.userAgent },
          },
          // Inside the account's transaction: the audit trail and the
          // verification token commit with the account or not at all, so
          // there is never an account without its history or its token.
          // Only the email waits for the commit, below.
          async ({ user: created, organization, membership }, writes) => {
            // In this order: the account, then its organization, then the
            // membership that ties them together.
            const actor = {
              actorUserId: created.id,
              actorEmail: created.email,
              organizationId: organization.id,
              ipAddress: input.ipAddress,
              userAgent: input.userAgent,
            };
            await writes.audit.record({
              ...actor,
              action: "user.registered",
              subjectType: "user",
              subjectId: created.id,
              // The accepted version, and no key at all when none was.
              metadata: asksForTerms ? { acceptedTermsVersion: siteTermsVersion } : {},
            });
            await writes.audit.record({
              ...actor,
              action: "organization.created",
              subjectType: "organization",
              subjectId: organization.id,
              metadata: { type: organization.type },
            });
            await writes.audit.record({
              ...actor,
              action: "organization_member.added",
              subjectType: "organization_member",
              subjectId: membership.id,
              metadata: { role: membership.role },
            });
            await writes.verificationTokens.create({
              userId: created.id,
              tokenHash,
              expiresAt: expiryFromNow(),
            });
          },
        ));
      } catch (error) {
        if (error instanceof DuplicateEmailError) {
          // findByEmail above and createAccount() here are not one
          // transaction, so two concurrent registrations of the same
          // brand-new address can both pass the check above and both reach
          // this insert; exactly one wins (uq_users_lower_email) and the
          // loser lands here, its transaction already rolled back at the
          // first insert, so it leaves nothing behind. The Argon2id cost was
          // already paid a few lines up, so — unlike the `existing` branch
          // above — no further hash is needed; hashing again would only
          // double the cost of the branch that is already the more
          // expensive one.
          const winner = await users.findByEmail(input.email);
          // No winner is found when a soft-deleted account holds the email:
          // uq_users_lower_email covers soft-deleted rows but findByEmail
          // skips them, so re-registering that email raises
          // DuplicateEmailError, the refetch finds nothing, and this rethrow
          // returns a 500.
          if (!winner) throw error;
          const response = await sendDuplicateNotice(winner, input);
          // Pads like the `existing` branch: a quick failed insert must not
          // make this path measurably faster than a real registration. Not
          // dead code.
          await wait(registrationTiming.sample() - (performance.now() - afterHash));
          return response;
        }
        throw error;
      }

      // Committed: the opamp-server registers it after the response. Only a
      // scheduled job, so the timing below barely moves.
      opampRegistration.created(organization);
      await sendVerificationEmail(user.email, token);

      registrationTiming.record(performance.now() - afterHash);
      return { status: "verification_sent" };
    },

    /**
     * findByHash is unfiltered on purpose: a consumed or expired row must be
     * distinguishable from a hash that was never issued at all. Clicking the
     * same valid link twice — back button, bookmark, mail-client prefetch —
     * is common and must report `already_verified`, not a false failure; only
     * a hash with no row, or an unconsumed-but-expired one, is a genuine
     * error. `consumedAt` is checked before `expiresAt`, so a token that is
     * both consumed and (since) expired still reports `already_verified`
     * rather than the misleading "invalid or expired" — once verified, a
     * link's later expiry is no longer the interesting fact about it.
     * Consume() still runs before markEmailVerified(): it is the atomic
     * gate, so of two truly concurrent clicks on an unconsumed token, exactly
     * one wins and the other also lands on `already_verified`.
     */
    async verifyEmail(input: VerifyEmailInput): Promise<VerifyEmailResponse> {
      const record = await verificationTokens.findByHash(hashToken(input.token));

      if (!record) {
        await audit.record({
          action: "user.email_verification_failed",
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        throw new AppError(
          "invalid_verification_token" satisfies IdentityErrorCode,
          "That confirmation link is invalid or has expired. Request a new one.",
          400,
        );
      }

      if (record.consumedAt) {
        await audit.record({
          action: "user.email_verification_repeated",
          actorUserId: record.userId,
          subjectType: "user",
          subjectId: record.userId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        return { status: "already_verified" };
      }

      if (record.expiresAt <= now()) {
        // Distinct from user.email_verification_failed: this is an
        // ordinary stale link, not a hash that was never issued (a scan or
        // a mangled URL). Conflating the two would make abuse harder to
        // tell apart from routine expiry later.
        await audit.record({
          action: "user.email_verification_expired",
          actorUserId: record.userId,
          subjectType: "user",
          subjectId: record.userId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        throw new AppError(
          "invalid_verification_token" satisfies IdentityErrorCode,
          "That confirmation link is invalid or has expired. Request a new one.",
          400,
        );
      }

      const consumed = await verificationTokens.consume(record.id);
      if (!consumed) {
        // Lost the race against a concurrent click; the winner verified.
        await audit.record({
          action: "user.email_verification_repeated",
          actorUserId: record.userId,
          subjectType: "user",
          subjectId: record.userId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        return { status: "already_verified" };
      }

      await users.markEmailVerified(record.userId);
      await audit.record({
        action: "user.email_verified",
        actorUserId: record.userId,
        subjectType: "user",
        subjectId: record.userId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });

      return { status: "verified" };
    },

    /**
     * Runs after the response, so nothing here can change what the
     * requester sees, and the response time is the same whether or not an
     * account exists. `findByEmail` skips soft-deleted users, so a
     * soft-deleted account gets nothing, like no account at all.
     *
     * Only an unverified account gets mail. Its earlier tokens are left
     * valid until they expire: they all confirm the same address.
     */
    async resendVerification(input: ResendVerificationInput): Promise<void> {
      const user = await users.findByEmail(input.email);
      if (!user) {
        await audit.record({
          action: "user.verification_email_resent",
          metadata: { outcome: "no_account" },
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        return;
      }

      const actor = {
        actorUserId: user.id,
        actorEmail: user.email,
        subjectType: "user",
        subjectId: user.id,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      };
      if (user.emailVerifiedAt) {
        await audit.record({
          ...actor,
          action: "user.verification_email_resent",
          metadata: { outcome: "already_verified" },
        });
        return;
      }

      const { token, tokenHash } = generateVerificationToken();
      await verificationTokens.create({ userId: user.id, tokenHash, expiresAt: expiryFromNow() });
      // After the write: an email must never carry a token that wasn't stored.
      // A failed send is audited, then rethrown for the runner to log: the
      // requester was already told to check their email.
      try {
        await sendVerificationEmail(user.email, token);
      } catch (error) {
        await audit.record({
          ...actor,
          action: "user.verification_email_resent",
          metadata: { outcome: "send_failed" },
        });
        throw error;
      }
      await audit.record({
        ...actor,
        action: "user.verification_email_resent",
        metadata: { outcome: "sent" },
      });
    },
  };
}
