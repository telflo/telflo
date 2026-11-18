import {
  API_TOKENS_LIVE_MAXIMUM,
  SERVICE_ACCOUNTS_MAXIMUM,
  serviceAccountEmail,
  type ApiTokenAccess,
} from "@telflo/contracts";
import type { ActorContext } from "../../database/context.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IMemberRepository } from "../organizations/repositories/member-repository.js";
import {
  assertActiveOrganization,
  assertAdminRole,
  canonicalIdOf,
  lockAsAdmin,
  type Actor,
  type LockingRepositories,
} from "../organizations/service.js";
import {
  apiTokenLimitReached,
  apiTokenNameTaken,
  apiTokenNotFound,
  serviceAccountLimitReached,
  serviceAccountNameTaken,
  serviceAccountNotFound,
} from "./errors.js";
import { ApiTokenNameTakenError, type ApiToken, type IApiTokenRepository } from "./repositories/api-token-repository.js";
import {
  ServiceAccountAddressTakenError,
  ServiceAccountNameTakenError,
  type IServiceAccountRepository,
  type ServiceAccount,
} from "./repositories/service-account-repository.js";
import { mintApiToken, type MintedApiToken } from "./tokens.js";

/*
 * Service accounts (D22 decisions 4 to 6 and 26 to 30): the active
 * organization's admins list, create, read, rename and delete them, reads
 * included (Q132). Every write takes the organization lock first
 * (`lockAsAdmin`, the organizations module's), so the limit's count is exact
 * and a demoted admin is refused under it; creating and deleting are one
 * transaction each, as the membership invariant needs (ADR 0025).
 *
 * An account's API tokens (decisions 7 to 9 and 31) are its admins' too:
 * listed by their prefix, created once (the token crosses the API only in
 * the create's reply), limited to 20 live, and revoked, never deleted.
 *
 * The name and the address are organization content (ADR 0024, decision
 * 49), and a token is a secret like a bearer (decision 48): nothing here
 * logs any of them or a token's name or prefix, the errors are fixed words,
 * and the audit rows hold ids and fixed values only (decision 32).
 */

/** The repositories one unit of work writes through, bound to one transaction in the request's context. */
export interface ServiceAccountTransaction {
  /** The active organization's and its members', for the lock, the membership and the account's lock. */
  active: LockingRepositories & { members: Pick<IMemberRepository, "find" | "add" | "lockAccounts" | "remove"> };
  serviceAccounts: IServiceAccountRepository;
  apiTokens: Pick<IApiTokenRepository, "list" | "countLive" | "isNameTaken" | "create" | "revoke" | "revokeAllOf">;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction in `context`'s database context
 * (the active organization, so the membership's insert passes row-level
 * security as it is), and resolves with its result once it commits. A
 * rejection rolls it back.
 */
export type WithServiceAccountTransaction = <Result>(
  context: ActorContext,
  work: (transaction: ServiceAccountTransaction) => Promise<Result>,
) => Promise<Result>;

export interface ServiceAccountServiceDependencies {
  withTransaction: WithServiceAccountTransaction;
  now: () => Date;
  /** Eight lowercase hex digits for a new address (decision 5): `randomBytes(4)` in production, injected in tests. */
  randomHex: () => string;
  /** A new token, its hash and its prefix (decision 7); `mintApiToken` unless a test injects one. */
  mintToken?: () => MintedApiToken;
}

/** A token as its account's page lists it: `isExpired` by the API's clock (decision 31). */
export interface ListedApiToken extends ApiToken {
  isExpired: boolean;
}

/** What an admin asks for (decision 31): the name, the access and the days to expiry, or null for never. */
export interface CreateApiTokenRequest {
  name: string;
  access: ApiTokenAccess;
  expiresInDays: number | null;
}

/** The create's answer: the token, the only time it is handed out, beside the row as listed. */
export interface CreatedApiToken {
  apiToken: ListedApiToken;
  token: string;
}

/**
 * Whether a token has expired at `at`, the API's clock: its last moment is
 * just before `expiresAt`, as the token check's lookup has it (`expires_at
 * > p_at` is live).
 */
export function isApiTokenExpired(token: Pick<ApiToken, "expiresAt">, at: Date): boolean {
  return token.expiresAt !== null && token.expiresAt.getTime() <= at.getTime();
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface IServiceAccountService {
  /** The active organization's live accounts, newest first. Admin only. */
  list(actor: Actor, organizationId: string): Promise<ServiceAccount[]>;
  /** One live account. Admin only; unknown, deleted and another organization's are 404 alike. */
  find(actor: Actor, organizationId: string, serviceAccountId: string): Promise<ServiceAccount>;
  /** Decision 27: the account, its user and its contributor membership, in one transaction. */
  create(actor: Actor, organizationId: string, name: string): Promise<ServiceAccount>;
  /** Decision 29: the address is kept; the same name is a no-op. */
  rename(actor: Actor, organizationId: string, serviceAccountId: string, name: string): Promise<ServiceAccount>;
  /** Decision 28: every token revoked, the membership and the account soft-deleted, in one transaction. */
  delete(actor: Actor, organizationId: string, serviceAccountId: string): Promise<void>;
  /** The live account's tokens not revoked, expired ones included, newest first. Admin only. */
  listTokens(actor: Actor, organizationId: string, serviceAccountId: string): Promise<ListedApiToken[]>;
  /** Decision 31: a new token on the live account, handed out this once. */
  createToken(
    actor: Actor,
    organizationId: string,
    serviceAccountId: string,
    request: CreateApiTokenRequest,
  ): Promise<CreatedApiToken>;
  /** Decision 31: one conditional update; an unknown, another account's or a revoked token is 404 alike. */
  revokeToken(actor: Actor, organizationId: string, serviceAccountId: string, tokenId: string): Promise<void>;
}

/**
 * How many times a create is tried in all when its address collides on
 * `uq_users_lower_email` (decision 27): each try rolls back and draws new
 * digits; after the last, the request is a server failure.
 */
export const SERVICE_ACCOUNT_ADDRESS_ATTEMPTS = 3;

export function createServiceAccountService(deps: ServiceAccountServiceDependencies): IServiceAccountService {
  const { withTransaction, now, randomHex, mintToken = mintApiToken } = deps;

  /** An audit row by the acting admin, in the organization: ids and fixed values only (decision 32). */
  function auditOf(
    actor: Actor,
    subject: { type: "service_account" | "api_token"; id: string },
    action: string,
    metadata?: Record<string, unknown>,
  ): AuditEvent {
    return {
      actorUserId: actor.context.userId,
      actorEmail: actor.email,
      organizationId: actor.context.organizationId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      action,
      subjectType: subject.type,
      subjectId: subject.id,
      metadata,
    };
  }

  /** An audit row about an account. */
  const auditEvent = (actor: Actor, serviceAccountId: string, action: string, metadata?: Record<string, unknown>) =>
    auditOf(actor, { type: "service_account", id: serviceAccountId }, action, metadata);

  const listedAt = (token: ApiToken, at: Date): ListedApiToken => ({ ...token, isExpired: isApiTokenExpired(token, at) });

  /** The checks every route makes first: the active organization (its 404 first), then the request's role. */
  function assertMayManage(actor: Actor, organizationId: string): void {
    assertActiveOrganization(actor, organizationId);
    assertAdminRole(actor);
  }

  /**
   * The live account a route names, or 404: unknown, deleted, another
   * organization's and a non-canonical id alike. A write reads it under the
   * organization lock, which every change to an account takes first, so it
   * holds until the commit.
   */
  async function liveAccount(
    transaction: ServiceAccountTransaction,
    serviceAccountId: string | undefined,
  ): Promise<ServiceAccount> {
    const account = serviceAccountId === undefined ? undefined : await transaction.serviceAccounts.find(serviceAccountId);
    if (!account) throw serviceAccountNotFound();
    return account;
  }

  /** One try of decision 27, in its order, in one transaction. */
  const createOnce = (actor: Actor, name: string): Promise<ServiceAccount> =>
    withTransaction(actor.context, async (transaction) => {
      await lockAsAdmin(transaction, actor);
      if ((await transaction.serviceAccounts.countLive()) >= SERVICE_ACCOUNTS_MAXIMUM) {
        throw serviceAccountLimitReached();
      }
      if (await transaction.serviceAccounts.isNameTaken(name)) throw serviceAccountNameTaken();
      const account = await transaction.serviceAccounts.create({
        name,
        email: serviceAccountEmail(name, randomHex()),
        createdByUserId: actor.context.userId,
        at: now(),
      });
      // Through the scoped members repository: the context already names
      // the organization, so row-level security admits it as it is.
      await transaction.active.members.add({ userId: account.id, role: "contributor" });
      await transaction.audit.record(auditEvent(actor, account.id, "service_account.created"));
      return account;
    });

  return {
    /** Read-only, so no lock: the request's role is the check. */
    async list(actor, organizationId) {
      assertMayManage(actor, organizationId);
      return withTransaction(actor.context, (transaction) => transaction.serviceAccounts.list());
    },

    /** Read-only, as the list. */
    async find(actor, organizationId, serviceAccountId) {
      assertMayManage(actor, organizationId);
      const id = canonicalIdOf(serviceAccountId);
      return withTransaction(actor.context, (transaction) => liveAccount(transaction, id));
    },

    /**
     * Decision 27: the lock and the admin's re-check, the limit's count, the
     * name read under the lock (its unique index behind it, the same 409),
     * the user and its row, the contributor membership and the audit row,
     * committed together: the deferred invariant sees the membership. No
     * personal organization, configuration, settings row, verification
     * token or email. An address that collides rolls everything back and
     * is tried again with new digits.
     */
    async create(actor, organizationId, name) {
      assertMayManage(actor, organizationId);
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await createOnce(actor, name);
        } catch (error) {
          if (error instanceof ServiceAccountNameTakenError) throw serviceAccountNameTaken();
          if (!(error instanceof ServiceAccountAddressTakenError) || attempt >= SERVICE_ACCOUNT_ADDRESS_ATTEMPTS) {
            throw error;
          }
        }
      }
    },

    /**
     * Decision 29, under the lock: the account live, the same name a no-op
     * with no audit row (as a group's rename), a live duplicate the 409,
     * then the name and its audit row. The address is kept (decision 5).
     */
    async rename(actor, organizationId, serviceAccountId, name) {
      assertMayManage(actor, organizationId);
      const id = canonicalIdOf(serviceAccountId);
      return withTransaction(actor.context, async (transaction) => {
        await lockAsAdmin(transaction, actor);
        const current = await liveAccount(transaction, id);
        if (current.name === name) return current;
        if (await transaction.serviceAccounts.isNameTaken(name, current.id)) throw serviceAccountNameTaken();
        let renamed: boolean;
        try {
          renamed = await transaction.serviceAccounts.rename(current.id, name, now());
        } catch (error) {
          if (error instanceof ServiceAccountNameTakenError) throw serviceAccountNameTaken();
          throw error;
        }
        // Live under the lock just taken: this can't miss.
        if (!renamed) throw serviceAccountNotFound();
        await transaction.audit.record(auditEvent(actor, current.id, "service_account.renamed"));
        return liveAccount(transaction, current.id);
      });
    },

    /**
     * Decision 28, in its lock order: the organization, the account's user
     * (`lockAccounts`, before anything it guards), its tokens (every one
     * not yet revoked, by this admin), its membership, then its row's and
     * its user's deleted_at, and the audit row with the count. A deleted
     * user is never stranded, so the invariant passes at commit. No session
     * is touched: a service account has none.
     */
    async delete(actor, organizationId, serviceAccountId) {
      assertMayManage(actor, organizationId);
      const id = canonicalIdOf(serviceAccountId);
      await withTransaction(actor.context, async (transaction) => {
        await lockAsAdmin(transaction, actor);
        const account = await liveAccount(transaction, id);
        await transaction.active.members.lockAccounts(account.id);
        const at = now();
        const revokedTokens = await transaction.apiTokens.revokeAllOf(account.id, actor.context.userId, at);
        // Live under the lock just taken, with its one live membership (the
        // member routes never change it): neither can miss.
        if (!(await transaction.active.members.remove(account.id, at))) throw serviceAccountNotFound();
        if (!(await transaction.serviceAccounts.markDeleted(account.id, at))) throw serviceAccountNotFound();
        await transaction.audit.record(auditEvent(actor, account.id, "service_account.deleted", { revokedTokens }));
      });
    },

    /** Read-only, so no lock: the request's role is the check, then the account live. */
    async listTokens(actor, organizationId, serviceAccountId) {
      assertMayManage(actor, organizationId);
      const id = canonicalIdOf(serviceAccountId);
      const tokens = await withTransaction(actor.context, async (transaction) => {
        const account = await liveAccount(transaction, id);
        return transaction.apiTokens.list(account.id);
      });
      const at = now();
      return tokens.map((token) => listedAt(token, at));
    },

    /**
     * Decision 31, under the organization lock (every write to the
     * organization's accounts and tokens takes it first, so the count is
     * exact): the account live, else 404 (a deleted account gets no token);
     * 20 live tokens already, the owner's 409; a name taken by a token not
     * yet revoked, expired included, the 409 (its unique index behind it);
     * then the mint, the row and the audit row, which holds the account's
     * id, the access and the expiry only. `expiresAt` is the creation plus
     * that many days of 24 hours.
     */
    async createToken(actor, organizationId, serviceAccountId, request) {
      assertMayManage(actor, organizationId);
      const id = canonicalIdOf(serviceAccountId);
      return withTransaction(actor.context, async (transaction) => {
        await lockAsAdmin(transaction, actor);
        const account = await liveAccount(transaction, id);
        const at = now();
        if ((await transaction.apiTokens.countLive(account.id, at)) >= API_TOKENS_LIVE_MAXIMUM) {
          throw apiTokenLimitReached();
        }
        if (await transaction.apiTokens.isNameTaken(account.id, request.name)) throw apiTokenNameTaken();
        const { token, tokenHash, tokenPrefix } = mintToken();
        const expiresAt =
          request.expiresInDays === null ? null : new Date(at.getTime() + request.expiresInDays * DAY_MILLISECONDS);
        let created: ApiToken;
        try {
          created = await transaction.apiTokens.create({
            serviceAccountId: account.id,
            name: request.name,
            tokenHash,
            tokenPrefix,
            access: request.access,
            expiresAt,
            createdByUserId: actor.context.userId,
            at,
          });
        } catch (error) {
          if (error instanceof ApiTokenNameTakenError) throw apiTokenNameTaken();
          throw error;
        }
        await transaction.audit.record(
          auditOf(actor, { type: "api_token", id: created.id }, "api_token.created", {
            serviceAccountId: account.id,
            access: request.access,
            expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
          }),
        );
        return { apiToken: listedAt(created, at), token };
      });
    },

    /**
     * Decision 31, under the organization lock: one update of the account's
     * token not yet revoked (an expired one too), by this admin at the
     * clock's time. Nothing updated, or an id that isn't a canonical uuid,
     * is the one 404.
     */
    async revokeToken(actor, organizationId, serviceAccountId, tokenId) {
      assertMayManage(actor, organizationId);
      const accountId = canonicalIdOf(serviceAccountId);
      const id = canonicalIdOf(tokenId);
      await withTransaction(actor.context, async (transaction) => {
        await lockAsAdmin(transaction, actor);
        if (accountId === undefined || id === undefined) throw apiTokenNotFound();
        if (!(await transaction.apiTokens.revoke(accountId, id, actor.context.userId, now()))) throw apiTokenNotFound();
        await transaction.audit.record(
          auditOf(actor, { type: "api_token", id }, "api_token.revoked", { serviceAccountId: accountId }),
        );
      });
    },
  };
}
