import { PERSONAL_API_TOKENS_LIVE_MAXIMUM, type ApiTokenAccess, type SessionErrorCode } from "@telflo/contracts";
import type { ActorContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IUserRepository } from "../identity/repositories/user-repository.js";
import { canonicalIdOf } from "../organizations/service.js";
import { isApiTokenExpired } from "../service-accounts/service.js";
import { mintApiToken, type MintedApiToken } from "../service-accounts/tokens.js";
import {
  currentPasswordIncorrect,
  personalApiTokenLimitReached,
  personalApiTokenNameTaken,
  personalApiTokenNotFound,
} from "./errors.js";
import { recordReauthenticationFailure, verifyCurrentPassword, type ReauthenticationAttempt } from "./reauthenticate.js";
import {
  PersonalApiTokenNameTakenError,
  type IPersonalApiTokenRepository,
  type PersonalApiToken,
} from "./repositories/personal-api-token-repository.js";

/*
 * A person's own API tokens, on their Account page: listed, created once (the
 * token crosses the API only in the create's reply) and revoked, never
 * deleted. Only the person sees or revokes them: organization admins can't. A
 * personal token acts as its person in any organization they belong to, named
 * per request by X-Telflo-Org (the public surface's token check).
 *
 * - **The limit:** 20 live tokens, neither revoked nor expired, as a
 *   service account's, counted under a lock on the user's row, so two
 *   creates can't both pass the count. No create limiter: the cap bounds
 *   it.
 * - **The name** is unique, case aside, among the person's tokens not yet
 *   revoked (expired ones included), under the same lock, the index behind
 *   it.
 * - **Audit rows** (`personal_api_token.created`, `.revoked`) hold ids and
 *   fixed values only (the access, the expiry), never the token, its prefix
 *   or its name, under the session's active organization as the account's
 *   other audits are. No emails.
 * - **The current password**, when the account has one, before anything is
 *   made, as a link's start asks it: a session alone mints no token, so a
 *   session stolen or left open isn't turned into a credential that
 *   outlives it (its sign-out, a reset). A missing one is as wrong, and
 *   both are `user.reauthentication_failed` (purpose
 *   `personal_api_token_create`) and `400 current_password_incorrect`; an
 *   account without one (OIDC only) is asked nothing. The verify is outside
 *   any transaction; the hash is read again under the user's lock and a
 *   change since (a reset, a change, a password set) is refused alike.
 *
 * A token is a secret like a bearer and its name is the person's content:
 * nothing here logs either, and the errors are fixed words.
 */

/** The repositories one unit of work writes through, bound to one transaction in the person's database context. */
export interface PersonalApiTokenTransaction {
  users: Pick<IUserRepository, "lockForUpdate" | "findPasswordHashForShare">;
  tokens: IPersonalApiTokenRepository;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one transaction whose database context names the person
 * (and the session's active organization, which these rows ignore), and
 * resolves with its result once it commits.
 */
export type WithPersonalApiTokenTransaction = <Result>(
  context: ActorContext,
  work: (transaction: PersonalApiTokenTransaction) => Promise<Result>,
) => Promise<Result>;

/** Who acts, from the session: its context and where the request came from (for the audit rows). */
export interface PersonalApiTokenActor {
  context: ActorContext;
  /** The person's address, the audit row's snapshot (personal data: only in its column). */
  email: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** A token as the person's list shows it: `isExpired` by the API's clock. */
export interface ListedPersonalApiToken extends PersonalApiToken {
  isExpired: boolean;
}

/**
 * What the person asks for: the name, the access and the days to expiry, or
 * null for never; and their current password (required when the account
 * has one).
 */
export interface CreatePersonalApiTokenRequest {
  name: string;
  access: ApiTokenAccess;
  expiresInDays: number | null;
  currentPassword?: string | undefined;
}

/** The create's answer: the token, the only time it is handed out, beside the row as listed. */
export interface CreatedPersonalApiToken {
  apiToken: ListedPersonalApiToken;
  token: string;
  /** Whether a current password was verified (not for an account without one): the route's sign-in budget clears on it. */
  isReauthenticated: boolean;
}

export interface IPersonalApiTokenService {
  /** The person's tokens not revoked, expired ones included, newest first. */
  list(actor: PersonalApiTokenActor): Promise<ListedPersonalApiToken[]>;
  /** A new token, handed out this once. */
  create(actor: PersonalApiTokenActor, request: CreatePersonalApiTokenRequest): Promise<CreatedPersonalApiToken>;
  /** One conditional update; an unknown, another person's or a revoked token is the one 404. */
  revoke(actor: PersonalApiTokenActor, tokenId: string): Promise<void>;
}

export interface PersonalApiTokenServiceDependencies {
  withTransaction: WithPersonalApiTokenTransaction;
  now: () => Date;
  /** Outside any transaction: the account's password hash, for the current password's verify. */
  users: Pick<IUserRepository, "findById">;
  /** Outside any transaction: a refused current password's row stands whatever follows. */
  audit: IAuditRepository;
  /** Injectable so tests can hold or observe it; defaults to identity's Argon2id verify. */
  verifyPassword?: ((hashValue: string, plaintext: string) => Promise<boolean>) | undefined;
  /** A new token, its hash and its prefix; `mintApiToken` unless a test injects one. */
  mintToken?: () => MintedApiToken;
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/** The session's person is gone (deleted since `authenticate` accepted it): the session is over. */
function unauthenticated(): AppError {
  return new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
}

export function createPersonalApiTokenService(deps: PersonalApiTokenServiceDependencies): IPersonalApiTokenService {
  const { withTransaction, now, mintToken = mintApiToken } = deps;

  /**
   * The current password, when the account has one: verified outside any
   * transaction (a missing one audited and refused as a wrong one). Answers
   * the hash it was verified against, null for an account without one, for
   * the recheck under the lock.
   */
  const reauthenticate = async (
    actor: PersonalApiTokenActor,
    currentPassword: string | undefined,
  ): Promise<{ verifiedHash: string | null; attempt: ReauthenticationAttempt }> => {
    const user = await deps.users.findById(actor.context.userId);
    if (!user) throw unauthenticated();
    const attempt: ReauthenticationAttempt = {
      user: { id: user.id, email: user.email },
      purpose: "personal_api_token_create",
      context: actor.context,
      origin: { ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    };
    if (user.passwordHash === null) return { verifiedHash: null, attempt };
    if (currentPassword === undefined) {
      await recordReauthenticationFailure(deps.audit, attempt);
      throw currentPasswordIncorrect();
    }
    await verifyCurrentPassword(
      { audit: deps.audit, verifyPassword: deps.verifyPassword },
      { ...attempt, user: { ...attempt.user, passwordHash: user.passwordHash }, currentPassword },
    );
    return { verifiedHash: user.passwordHash, attempt };
  };

  const listedAt = (token: PersonalApiToken, at: Date): ListedPersonalApiToken => ({
    ...token,
    isExpired: isApiTokenExpired(token, at),
  });

  /** An audit row by the person about their token: ids and fixed values only. */
  const audit = (
    transaction: PersonalApiTokenTransaction,
    actor: PersonalApiTokenActor,
    action: string,
    tokenId: string,
    metadata?: Record<string, unknown>,
  ) =>
    transaction.audit.record({
      action,
      actorUserId: actor.context.userId,
      actorEmail: actor.email,
      organizationId: actor.context.organizationId,
      subjectType: "personal_api_token",
      subjectId: tokenId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

  return {
    /** Read-only, so no lock. */
    async list(actor) {
      const { userId } = actor.context;
      const tokens = await withTransaction(actor.context, (transaction) => transaction.tokens.list(userId));
      const at = now();
      return tokens.map((token) => listedAt(token, at));
    },

    /**
     * The current password first (`reauthenticate`), then under the lock on
     * the user's row (every account transaction locks the user first): the
     * hash read again, and one not the verified one (changed, reset or set
     * since) refused as a wrong password; 20 live tokens already (neither
     * revoked nor expired), the 409; a name taken by a token not yet revoked, expired included, the 409
     * (its unique index behind it); then the mint, the row and the audit row
     * (the access and the expiry only). `expiresAt` is the creation plus that
     * many days of 24 hours.
     */
    async create(actor, request) {
      const { userId } = actor.context;
      const { verifiedHash, attempt } = await reauthenticate(actor, request.currentPassword);
      const outcome = await withTransaction(actor.context, async (transaction) => {
        await transaction.users.lockForUpdate(userId);
        const currentHash = await transaction.users.findPasswordHashForShare(userId);
        if (currentHash === undefined) return { status: "gone" as const };
        if (currentHash !== verifiedHash) return { status: "changed_since" as const };
        const at = now();
        if ((await transaction.tokens.countLive(userId, at)) >= PERSONAL_API_TOKENS_LIVE_MAXIMUM) {
          throw personalApiTokenLimitReached();
        }
        if (await transaction.tokens.isNameTaken(userId, request.name)) throw personalApiTokenNameTaken();
        const { token, tokenHash, tokenPrefix } = mintToken();
        const expiresAt =
          request.expiresInDays === null ? null : new Date(at.getTime() + request.expiresInDays * DAY_MILLISECONDS);
        let created: PersonalApiToken;
        try {
          created = await transaction.tokens.create({
            userId,
            name: request.name,
            tokenHash,
            tokenPrefix,
            access: request.access,
            expiresAt,
            at,
          });
        } catch (error) {
          if (error instanceof PersonalApiTokenNameTakenError) throw personalApiTokenNameTaken();
          throw error;
        }
        await audit(transaction, actor, "personal_api_token.created", created.id, {
          access: request.access,
          expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
        });
        return { status: "created" as const, created: { apiToken: listedAt(created, at), token } };
      });
      if (outcome.status === "gone") throw unauthenticated();
      if (outcome.status === "changed_since") {
        await recordReauthenticationFailure(deps.audit, attempt);
        throw currentPasswordIncorrect();
      }
      return { ...outcome.created, isReauthenticated: verifiedHash !== null };
    },

    /**
     * Under the lock on the user's row: one update of the person's token not
     * yet revoked (an expired one too). Nothing updated (unknown, another
     * person's, already revoked), or an id that isn't a canonical uuid, is
     * the one 404.
     */
    async revoke(actor, tokenId) {
      const { userId } = actor.context;
      const id = canonicalIdOf(tokenId);
      if (id === undefined) throw personalApiTokenNotFound();
      await withTransaction(actor.context, async (transaction) => {
        await transaction.users.lockForUpdate(userId);
        if (!(await transaction.tokens.revoke(userId, id, now()))) throw personalApiTokenNotFound();
        await audit(transaction, actor, "personal_api_token.revoked", id);
      });
    },
  };
}
