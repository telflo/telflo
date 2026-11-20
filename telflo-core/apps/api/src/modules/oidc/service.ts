import {
  isReservedEmail,
  safeRedirectPath,
  type OidcLinkResultCode,
  type OidcQueryErrorCode,
  type SessionErrorCode,
  type SignInMethodsResponse,
} from "@telflo/contracts";
import { authorizationCodeGrant, buildAuthorizationUrl, type IDToken } from "openid-client";
import { z } from "zod";
import type { AuthContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import type { IMailer } from "../../mail/mailer.js";
import type { AppSettings } from "../../settings.js";
import {
  currentPasswordIncorrect,
  identityAlreadyLinked,
  identityNotLinked,
  unlinkRequiresPassword,
} from "../account/errors.js";
import {
  recordReauthenticationFailure,
  verifyCurrentPassword,
  type ReauthenticationAttempt,
  type ReauthenticationOrigin,
} from "../account/reauthenticate.js";
import { buildIdentityLinkedEmail, buildIdentityUnlinkedEmail } from "../identity/emails.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { WithUserOrganizations } from "../organizations/repositories/organization-repository.js";
import {
  IdentityLinkConflictError,
  type IUserIdentityRepository,
} from "../identity/repositories/user-identity-repository.js";
import { DuplicateEmailError, type IUserRepository, type User } from "../identity/repositories/user-repository.js";
import type { IVerificationTokenRepository } from "../identity/repositories/verification-token-repository.js";
import type { OpampRegistration } from "../organizations/opamp-registration.js";
import { allowsRegistration } from "../identity/registration.js";
import type { IPasswordResetTokenRepository } from "../password-resets/repositories/password-reset-token-repository.js";
import type { ISessionRepository } from "../sessions/repositories/session-repository.js";
import type { IssuedSession, ISessionService, RequestOrigin } from "../sessions/service.js";
import { createFlowCookie, LINK_REDIRECT_PATH, type OidcFlow, type VerifiedOidcFlow } from "./flow-cookie.js";
import { linkIdentityFromSettings, type IdentityLinkFailureReason, type LinkOutcome } from "./link.js";
import type { IOidcProviderRegistry, OidcProvider } from "./providers.js";

/**
 * The repositories a federated sign-in writes through, bound to one
 * transaction: whatever is written through them commits together or not at
 * all.
 *
 * Lock order: the user's row, then token rows, then sessions. `users` offers
 * only what runs in the transaction it is bound to; `createAccount` opens a
 * transaction of its own, so leaving it out of the type makes calling it here
 * a compile error.
 */
export interface OidcTransaction {
  users: Pick<IUserRepository, "lockForUpdate" | "findById" | "takeOverUnverified" | "findPasswordHashForShare">;
  identities: Pick<IUserIdentityRepository, "link" | "findUserBySubject" | "findForUser" | "unlink">;
  passwordResetTokens: Pick<IPasswordResetTokenRepository, "consumeAllForUser">;
  verificationTokens: Pick<IVerificationTokenRepository, "consumeAllForUser">;
  sessions: Pick<ISessionRepository, "revokeAllForUser" | "findLiveForShare">;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction and resolves with its result once
 * the transaction commits. If `work` rejects, the transaction rolls back and
 * the rejection propagates. `work` must write only through the repositories
 * it is handed, and must not do anything that cannot be rolled back.
 */
export type WithOidcTransaction = <Result>(work: (transaction: OidcTransaction) => Promise<Result>) => Promise<Result>;

/** The ID token's claims, validated by openid-client (signature, iss, aud, azp, exp, nonce). */
export type ProviderClaims = IDToken;

/**
 * Exchanges the callback's code for the ID token's claims. Throws on any
 * failure: the provider unreachable, the exchange refused, or a token that
 * fails validation.
 */
export type ExchangeCode = (provider: OidcProvider, callbackUrl: URL, flow: OidcFlow) => Promise<ProviderClaims>;

export interface OidcServiceDependencies {
  providers: IOidcProviderRegistry;
  /** Outside any transaction: the lookups, and a new account (its own transaction). */
  users: Pick<IUserRepository, "findByEmailIncludingDeleted" | "createFederatedAccount" | "findById">;
  identities: Pick<IUserIdentityRepository, "findUserBySubject" | "listForUser" | "findForUser">;
  /** The personal organization, read in the user's database context. */
  withUserOrganizations: WithUserOrganizations;
  audit: IAuditRepository;
  /** The one session start. */
  sessions: Pick<ISessionService, "startSession">;
  withTransaction: WithOidcTransaction;
  /** `site.registration`: whether a sign-in with no matching account may create one. */
  settings: Pick<AppSettings, "publicWebUrl" | "accessTokenSecret" | "site">;
  now: () => Date;
  /** Injectable for unit tests; defaults to openid-client's authorization-code grant. */
  exchange?: ExchangeCode;
  /** Registers a new account's personal organization in the opamp-server after the commit. */
  opampRegistration: OpampRegistration;
  /** The security emails of a link or an unlink from Settings, sent after the commit. */
  mailer: IMailer;
  runAfterResponse: RunAfterResponse;
  /** Injectable so tests can observe the order; defaults to identity's Argon2id verify. */
  verifyPassword?: ((hashValue: string, plaintext: string) => Promise<boolean>) | undefined;
}

export interface BeginSignInInput {
  providerId: string;
  /** As the browser sent it; cleaned here. */
  redirectTo: string | undefined;
}

export type BeginSignInResult =
  | { kind: "unknown_provider" }
  /** Discovery failed. `error` is for the log, and says nothing secret. */
  | { kind: "unavailable"; redirectTo: string; error: unknown }
  | { kind: "redirect"; authorizationUrl: URL; flowCookie: string };

export interface CompleteSignInInput {
  /** From the callback's path: unchecked until it is found in the registry. */
  providerId: string;
  /** The callback's URL: the redirect URI plus the query the provider sent. */
  callbackUrl: URL;
  /** The flow cookie, already verified; `undefined` if absent or invalid. */
  flow: VerifiedOidcFlow | undefined;
  origin: RequestOrigin;
}

export type CompleteSignInResult =
  | { kind: "signed_in"; issued: IssuedSession; redirectTo: string }
  | {
      kind: "refused";
      code: OidcQueryErrorCode;
      redirectTo: string;
      /** Only for an unexpected failure (`internal_error`): for the log, never the audit trail. */
      error?: unknown;
    }
  /**
   * A link started from Settings ended: no session, and the browser goes to
   * `/settings/account?link=<code>`.
   */
  | {
      kind: "link_ended";
      code: OidcLinkResultCode;
      /** Only for an unexpected failure (`internal_error`): for the log, never the audit trail. */
      error?: unknown;
    };

/** The signed-in person asking, and from where: the account's own routes. */
export interface AccountRequest {
  /** The request's session: whose account, and the audit rows' organization. */
  context: AuthContext;
  origin: ReauthenticationOrigin;
}

export interface BeginLinkInput extends AccountRequest {
  /** As the body named it: unchecked until it is found in the registry. */
  providerId: string;
  /** Required when the account has a password, ignored when it has none. */
  currentPassword: string | undefined;
}

export type BeginLinkResult =
  /** Discovery failed. `error` is for the log, and says nothing secret. */
  | { kind: "unavailable"; error: unknown }
  | {
      kind: "redirect";
      authorizationUrl: URL;
      flowCookie: string;
      /** The current password was verified, so the limiter clears the address; false for a password-less account. */
      isReauthenticated: boolean;
    };

export interface UnlinkInput extends AccountRequest {
  /** From the path: looked up among the account's identities, configured or not. */
  providerId: string;
  currentPassword: string;
}

/** `user.oidc_sign_in_failed`'s reasons. */
export type OidcSignInFailureReason =
  | "provider_error"
  | "flow_cookie_invalid"
  | "state_mismatch"
  | "exchange_failed"
  | "email_unverified"
  | "email_not_authoritative"
  /** The verified email is at the service accounts' domain. */
  | "email_reserved"
  | "deleted_user"
  | "identity_conflict"
  | "no_personal_organization"
  | "session_refused"
  | "concurrent_sign_in"
  /** No account has the email, and the site's registration isn't open: nothing was created. */
  | "registration_not_open"
  /** Anything unexpected while finding the user or starting the session; the row names it by a label. */
  | "internal_error";

export interface IOidcService {
  beginSignIn(input: BeginSignInInput): Promise<BeginSignInResult>;
  completeSignIn(input: CompleteSignInInput): Promise<CompleteSignInResult>;
  /** The password state, the linked identities and the configured providers. */
  signInMethods(context: AuthContext): Promise<SignInMethodsResponse>;
  /** A link's start. Throws the account's refusals (404, 409, 400). */
  beginLink(input: BeginLinkInput): Promise<BeginLinkResult>;
  /** Unlinks an identity. Throws the account's refusals (404, 409, 400). */
  unlink(input: UnlinkInput): Promise<void>;
}

/** openid-client's defaults; no `prompt`. */
const SCOPE = "openid email profile";
const DEFAULT_REDIRECT = "/app";

/** As registration reads an address (contracts' emailSchema): trimmed, lowercased, at most 254 characters. */
const providerEmailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Printable ASCII only. Lowercasing folds some other characters onto ASCII
 * letters (U+212A KELVIN SIGN becomes "k"), so "\u212Aate@gmail.com" would
 * otherwise normalize onto kate@gmail.com's account.
 */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/**
 * The ID token's email as it will be stored and matched (trimmed,
 * lowercased), or `undefined` unless `email_verified` is the boolean `true`
 * (some providers have sent the string "true") and the email is printable
 * ASCII and parses.
 */
function verifiedProviderEmail(claims: ProviderClaims): string | undefined {
  if (claims.email_verified !== true) return undefined;
  if (typeof claims.email !== "string" || !PRINTABLE_ASCII.test(claims.email.trim())) return undefined;
  const parsed = providerEmailSchema.safeParse(claims.email);
  return parsed.success ? parsed.data : undefined;
}

/** The session is over: the user was deleted since `authenticate` accepted the token. */
function unauthenticated(): AppError {
  return new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
}

/** The OIDC starts' one refusal of an unknown provider: the sign-in's and the link's. */
export function unknownProvider(): AppError {
  return new AppError("not_found", "No such sign-in provider.", 404);
}

/**
 * How many times the account decision runs when a concurrent sign-in wins a
 * race to a unique index. The second run finds what the winner committed; a
 * third is for a race with a third party, and after it the sign-in gives up.
 */
const MAX_RESOLVE_ATTEMPTS = 3;

/**
 * The redirect URI registered with the provider. Always from
 * TELFLO_PUBLIC_WEB_URL, never from the request: behind the gateway the
 * request's host is the API's own.
 */
export function oidcRedirectUri(settings: Pick<AppSettings, "publicWebUrl">, providerId: string): string {
  return `${settings.publicWebUrl}/api/v1/auth/oidc/${encodeURIComponent(providerId)}/callback`;
}

/** The callback's URL as openid-client needs it: the redirect URI with the request's query copied on. */
export function oidcCallbackUrl(
  settings: Pick<AppSettings, "publicWebUrl">,
  providerId: string,
  requestUrl: string,
): URL {
  const url = new URL(oidcRedirectUri(settings, providerId));
  const queryStart = requestUrl.indexOf("?");
  url.search = queryStart === -1 ? "" : requestUrl.slice(queryStart);
  return url;
}

/** openid-client's defaults do the token checks; the registry turned on the signature check. */
async function exchangeWithProvider(provider: OidcProvider, callbackUrl: URL, flow: OidcFlow): Promise<ProviderClaims> {
  const configuration = await provider.configuration();
  const tokens = await authorizationCodeGrant(configuration, callbackUrl, {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("the token response carried no ID token");
  return claims;
}

/**
 * A label for the audit row: an openid-client error's `code`, which names
 * the check that failed. Never the error itself, whose `cause` can hold the
 * callback's parameters, code included.
 */
function errorLabel(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) return code;
  return error instanceof Error ? error.name.slice(0, 64) : "unknown";
}

/** The provider's `error` parameter, for the audit row, when it is a plain OAuth error code. */
function providerErrorLabel(error: string): string {
  return /^[a-z0-9_]{1,64}$/.test(error) ? error : "unrecognized";
}

/** What the account decision (resolveOnce) came to. */
type Resolution =
  | { kind: "user"; user: User }
  | { kind: "refused"; code: OidcQueryErrorCode; reason: OidcSignInFailureReason; user?: User | undefined }
  /**
   * A concurrent sign-in won a unique index. The work rolled back; the
   * decision runs again from the `sub` lookup and finds what the winner
   * committed.
   */
  | { kind: "raced" };

/** A resolution with its races run out. */
type SettledResolution = Exclude<Resolution, { kind: "raced" }>;

/** What finding the user and starting the session came to, before any refusal is audited. */
type SignInOutcome =
  | Extract<CompleteSignInResult, { kind: "signed_in" }>
  | Extract<Resolution, { kind: "refused" }>;

/** A link flow: whose account, and which session started it. */
type LinkFlow = Extract<VerifiedOidcFlow, { intent: "link" }>;

/** The identity the provider asserted, once its ID token has been validated. */
interface AssertedIdentity {
  provider: OidcProvider;
  subject: string;
  claims: ProviderClaims;
}

export function createOidcService(deps: OidcServiceDependencies): IOidcService {
  const {
    providers,
    users,
    identities,
    withUserOrganizations,
    audit,
    sessions,
    withTransaction,
    settings,
    now,
    opampRegistration,
    mailer,
    runAfterResponse,
  } = deps;
  const exchange = deps.exchange ?? exchangeWithProvider;
  const forgotPasswordUrl = `${settings.publicWebUrl}/forgot-password`;

  function refused(code: OidcQueryErrorCode, reason: OidcSignInFailureReason, user?: User): Resolution {
    return { kind: "refused", code, reason, user };
  }

  /**
   * After an identity link lost to a unique index. Postgres aborted that
   * transaction and it has rolled back, so this reads afresh. `subject_taken`
   * is always a race: another sign-in of this `sub` linked it first. So is
   * `provider_taken` when that sign-in linked this `sub` to this user; only
   * when the `sub` is still unlinked does the user hold a different identity
   * at this provider.
   */
  async function afterLinkConflict(error: unknown, identity: AssertedIdentity, user: User): Promise<Resolution> {
    if (!(error instanceof IdentityLinkConflictError)) throw error;
    if (error.reason === "provider_taken") {
      const linked = await identities.findUserBySubject(identity.provider.id, identity.subject);
      if (!linked) return refused("oauth_failed", "identity_conflict", user);
    }
    return { kind: "raced" };
  }

  /**
   * A sign-in's link (`via: "sign_in"`). It sends no email: only a link
   * from Settings does.
   */
  function identityLinkedEvent(identity: AssertedIdentity, user: User, origin: RequestOrigin) {
    return {
      action: "user.identity_linked",
      actorUserId: user.id,
      actorEmail: user.email,
      subjectType: "user",
      subjectId: user.id,
      metadata: { provider: identity.provider.id, via: "sign_in" },
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    };
  }

  /**
   * A verified account with the provider's email: link, then sign in. The
   * user's row is locked first (the lock order above) and read again under
   * the lock, so a user soft-deleted since the lookup is not linked, and one
   * whose email changed since is not linked by the old address: the
   * decision runs again.
   */
  async function linkVerified(
    identity: AssertedIdentity,
    user: User,
    email: string,
    origin: RequestOrigin,
  ): Promise<Resolution> {
    try {
      const linked = await withTransaction(async (transaction): Promise<User | "raced" | undefined> => {
        await transaction.users.lockForUpdate(user.id);
        const current = await transaction.users.findById(user.id);
        if (!current) return undefined;
        if (current.email !== email) return "raced";
        await transaction.identities.link({
          userId: current.id,
          provider: identity.provider.id,
          subject: identity.subject,
          email,
        });
        await transaction.audit.record(identityLinkedEvent(identity, current, origin));
        return current;
      });
      if (linked === "raced") return { kind: "raced" };
      return linked ? { kind: "user", user: linked } : refused("oauth_failed", "deleted_user", user);
    } catch (error) {
      return afterLinkConflict(error, identity, user);
    }
  }

  /**
   * An unverified account with the provider's email: the provider has proven
   * the mailbox, so whoever registered the address may not be its owner. The
   * email is confirmed, the password deleted, every reset and confirmation
   * link consumed and every session revoked (there can be none), and the
   * identity linked, in one transaction. If the account was verified between
   * the lookup and the lock, this is the plain link instead; if its email
   * changed, or it was deleted, the decision runs again.
   */
  async function takeOver(
    identity: AssertedIdentity,
    user: User,
    email: string,
    origin: RequestOrigin,
    at: Date,
  ): Promise<Resolution> {
    try {
      const takenOver = await withTransaction(async (transaction) => {
        await transaction.users.lockForUpdate(user.id);
        const current = await transaction.users.findById(user.id);
        if (!current || current.email !== email) return "raced" as const;
        const taken = await transaction.users.takeOverUnverified(user.id, at);
        if (!taken) return undefined;
        await transaction.passwordResetTokens.consumeAllForUser(user.id, at);
        await transaction.verificationTokens.consumeAllForUser(user.id, at);
        const revokedSessions = await transaction.sessions.revokeAllForUser(user.id, "account_taken_over");
        await transaction.identities.link({
          userId: user.id,
          provider: identity.provider.id,
          subject: identity.subject,
          email,
        });
        await transaction.audit.record({
          action: "user.unverified_account_taken_over",
          actorUserId: user.id,
          actorEmail: taken.email,
          subjectType: "user",
          subjectId: user.id,
          metadata: {
            provider: identity.provider.id,
            hadPassword: taken.hadPassword,
            hadTerms: taken.hadTerms,
            revokedSessions,
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        await transaction.audit.record(identityLinkedEvent(identity, user, origin));
        return taken;
      });
      if (takenOver === "raced") return { kind: "raced" };
      if (!takenOver) return linkVerified(identity, user, email, origin);
      return { kind: "user", user: { ...user, passwordHash: null, emailVerifiedAt: at, acceptedTermsVersion: null } };
    } catch (error) {
      return afterLinkConflict(error, identity, user);
    }
  }

  /**
   * No user has the email: the account (no password, the email verified by
   * the provider, no terms), its personal organization and membership,
   * the link and the audit trail, in one transaction.
   */
  async function createAccount(
    identity: AssertedIdentity,
    email: string,
    origin: RequestOrigin,
    at: Date,
  ): Promise<Resolution> {
    try {
      const account = await users.createFederatedAccount(
        { email, verifiedAt: at, origin },
        async ({ user, organization, membership }, writes) => {
          await writes.identities.link({
            userId: user.id,
            provider: identity.provider.id,
            subject: identity.subject,
            email,
          });
          // As registration records them, then the link.
          const actor = {
            actorUserId: user.id,
            actorEmail: user.email,
            organizationId: organization.id,
            ipAddress: origin.ipAddress,
            userAgent: origin.userAgent,
          };
          await writes.audit.record({
            ...actor,
            action: "user.registered",
            subjectType: "user",
            subjectId: user.id,
            metadata: { method: "oidc", provider: identity.provider.id },
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
          await writes.audit.record(identityLinkedEvent(identity, user, origin));
        },
      );
      // Committed: the opamp-server registers it after the response.
      opampRegistration.created(account.organization);
      return { kind: "user", user: account.user };
    } catch (error) {
      // A concurrent first sign-in of the same person (or a registration of
      // the address) committed the email first. The account's transaction
      // has rolled back; the next run finds the winner.
      if (error instanceof DuplicateEmailError) return { kind: "raced" };
      if (error instanceof IdentityLinkConflictError) return { kind: "raced" };
      throw error;
    }
  }

  /**
   * The account decision, in its order. The `sub` lookup comes first, so
   * an identity already linked keeps working whatever the provider now says
   * about the email.
   */
  async function resolveOnce(identity: AssertedIdentity, origin: RequestOrigin, at: Date): Promise<Resolution> {
    const { provider, subject, claims } = identity;
    const linked = await identities.findUserBySubject(provider.id, subject);
    if (linked?.isDeleted) return refused("oauth_failed", "deleted_user", linked.user);
    if (linked) return { kind: "user", user: linked.user };

    // The boolean `true`, never the string: some providers have sent "true".
    const email = verifiedProviderEmail(claims);
    if (email === undefined) return refused("oauth_email_unverified", "email_unverified");
    // The reserved domains, before the authority rule and the lookup by email:
    // the service accounts' and the deleted accounts'. No person may hold such
    // an address, so nothing is linked, taken over or created. Google can't be
    // authoritative for either; this is the backstop for another provider.
    if (isReservedEmail(email)) return refused("oauth_email_reserved", "email_reserved");
    // Only an address the provider controls today links, takes over or
    // creates. Judged on the address as it will be matched.
    if (!provider.isEmailAuthoritative({ email, hd: claims.hd })) {
      return refused("oauth_email_unverified", "email_not_authoritative");
    }

    const existing = await users.findByEmailIncludingDeleted(email);
    if (!existing) {
      // Only an open site lets a provider's sign-in make an account;
      // invite-only and closed refuse, creating nothing. Linking and taking
      // over an existing account, below, work in every mode.
      if (!allowsRegistration(settings.site.registration, "self")) {
        return refused("registration_not_open", "registration_not_open");
      }
      return createAccount(identity, email, origin, at);
    }
    // A soft-deleted user's address is not given to anyone.
    if (existing.isDeleted) return refused("oauth_failed", "deleted_user", existing.user);
    if (existing.user.emailVerifiedAt === null) return takeOver(identity, existing.user, email, origin, at);
    return linkVerified(identity, existing.user, email, origin);
  }

  async function resolveUser(identity: AssertedIdentity, origin: RequestOrigin, at: Date): Promise<SettledResolution> {
    for (let attempt = 1; attempt <= MAX_RESOLVE_ATTEMPTS; attempt += 1) {
      const resolution = await resolveOnce(identity, origin, at);
      if (resolution.kind !== "raced") return resolution;
    }
    return { kind: "refused", code: "oauth_failed", reason: "concurrent_sign_in" };
  }

  /**
   * Finds, links or creates the user, then starts the session. Throws only
   * on something unexpected; completeSignIn audits that.
   */
  async function signIn(
    provider: OidcProvider,
    claims: ProviderClaims,
    origin: RequestOrigin,
    at: Date,
    redirectTo: string,
  ): Promise<SignInOutcome> {
    const resolution = await resolveUser({ provider, subject: claims.sub, claims }, origin, at);
    if (resolution.kind === "refused") return resolution;
    const { user } = resolution;

    // As password sign-in: the session lands where the person last was, or
    // in the organization they joined most recently, else the personal one,
    // whose absence is a bug to surface in the audit trail, not to paper
    // over.
    const personal = await withUserOrganizations(user.id, (organizations) => organizations.findPersonalForUser(user.id));
    if (!personal) return { kind: "refused", code: "oauth_failed", reason: "no_personal_organization", user };

    // The user was found, linked or created outside the session's
    // transaction; rereading the row `for share` refuses a user deleted
    // since, and holds the row until the session commits. A federated
    // user has no password: `null` is live, `undefined` is gone.
    const issued = await sessions.startSession({
      user,
      landing: { personalOrganizationId: personal.id },
      origin,
      auditMetadata: { method: "oidc", provider: provider.id },
      check: async (transaction) => (await transaction.users.findPasswordHashForShare(user.id)) !== undefined,
    });
    if (!issued) return { kind: "refused", code: "oauth_failed", reason: "session_refused", user };
    return { kind: "signed_in", issued, redirectTo };
  }

  /**
   * A link's refusal: one `user.identity_link_failed` row,
   * `{ provider, reason, error? }`, instead of the sign-in's
   * `user.oidc_sign_in_failed`. The actor is the flow's user, by the address
   * their live row holds (read here when the link didn't read it), never the
   * provider's; the organization is the flow's session's once it was read,
   * else none.
   */
  async function refuseLink(
    flow: LinkFlow,
    code: OidcLinkResultCode,
    reason: IdentityLinkFailureReason,
    origin: RequestOrigin,
    read: { user: User | undefined; organizationId: string | undefined } | undefined,
    detail: { error?: string } = {},
  ): Promise<CompleteSignInResult> {
    const user = read ? read.user : await users.findById(flow.userId);
    await audit.record({
      action: "user.identity_link_failed",
      actorUserId: flow.userId,
      actorEmail: user?.email,
      organizationId: read?.organizationId,
      subjectType: "user",
      subjectId: flow.userId,
      metadata: { provider: flow.providerId, reason, ...detail },
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
    return { kind: "link_ended", code };
  }

  /**
   * The link's callback, once the flow, the state, a provider error
   * and the exchange have been checked: the link in one transaction
   * (`link.ts`), then, after the commit and only when this callback wrote
   * the row, the email to the account's address. No session is started.
   */
  async function completeLink(
    provider: OidcProvider,
    claims: ProviderClaims,
    flow: LinkFlow,
    origin: RequestOrigin,
  ): Promise<CompleteSignInResult> {
    let outcome: LinkOutcome;
    try {
      outcome = await linkIdentityFromSettings(
        { withTransaction, identities },
        {
          providerId: provider.id,
          subject: claims.sub,
          verifiedEmail: verifiedProviderEmail(claims),
          userId: flow.userId,
          sessionId: flow.sessionId,
          origin,
        },
      );
    } catch (error) {
      await refuseLink(flow, "link_failed", "internal_error", origin, undefined, { error: errorLabel(error) });
      return { kind: "link_ended", code: "link_failed", error };
    }
    if (outcome.status === "refused") {
      return refuseLink(flow, outcome.code, outcome.reason, origin, outcome);
    }
    const { user } = outcome;
    if (outcome.isWritten && user) {
      // After the commit: an email must never announce a link that rolled back.
      runAfterResponse(() =>
        mailer.send({
          to: user.email,
          ...buildIdentityLinkedEmail({
            providerName: provider.name,
            settingsUrl: `${settings.publicWebUrl}${LINK_REDIRECT_PATH}`,
          }),
        }),
      );
    }
    return { kind: "link_ended", code: "linked" };
  }

  return {
    async beginSignIn(input: BeginSignInInput): Promise<BeginSignInResult> {
      const provider = providers.get(input.providerId);
      if (!provider) return { kind: "unknown_provider" };
      const redirectTo = safeRedirectPath(input.redirectTo, DEFAULT_REDIRECT);

      let configuration;
      try {
        configuration = await provider.configuration();
      } catch (error) {
        return { kind: "unavailable", redirectTo, error };
      }
      const flow = await createFlowCookie(
        { providerId: provider.id, redirectTo },
        settings.accessTokenSecret,
        now(),
      );
      const authorizationUrl = buildAuthorizationUrl(configuration, {
        redirect_uri: oidcRedirectUri(settings, provider.id),
        scope: SCOPE,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: flow.codeChallenge,
        code_challenge_method: "S256",
      });
      return { kind: "redirect", authorizationUrl, flowCookie: flow.value };
    },

    /**
     * The flow and the exchange are checked before anything is read or
     * written; the exchange happens before any transaction. Every refusal
     * writes one `user.oidc_sign_in_failed` row, and none records the code,
     * the verifier, the token or the cookie.
     *
     * A flow started from Settings to link is checked the same way up to the
     * exchange, then takes the link branch; its refusals, the earlier
     * checks' included, write `user.identity_link_failed` and end in
     * `link_failed`. A missing or unreadable cookie can't be known as a
     * link, and stays the sign-in's refusal.
     */
    async completeSignIn(input: CompleteSignInInput): Promise<CompleteSignInResult> {
      const { flow, callbackUrl, origin } = input;
      const at = now();
      const provider = providers.get(input.providerId);
      // The flow's `redirectTo` was cleaned when it started, and is kept on
      // failure too.
      const redirectTo = flow?.redirectTo ?? DEFAULT_REDIRECT;

      const refuse = async (
        code: OidcQueryErrorCode,
        reason: OidcSignInFailureReason,
        user?: User,
        detail: Record<string, unknown> = {},
      ): Promise<CompleteSignInResult> => {
        await audit.record({
          action: "user.oidc_sign_in_failed",
          actorUserId: user?.id,
          actorEmail: user?.email,
          ...(user ? { subjectType: "user", subjectId: user.id } : {}),
          metadata: { reason, ...(provider ? { provider: provider.id } : {}), ...detail },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        return { kind: "refused", code, redirectTo };
      };

      /** One of the checks before the exchange's result is used, refused for a sign-in or a link alike. */
      const refuseFlow = (
        reason: OidcSignInFailureReason & IdentityLinkFailureReason,
        detail: { error?: string } = {},
      ): Promise<CompleteSignInResult> =>
        flow?.intent === "link"
          ? refuseLink(flow, "link_failed", reason, origin, undefined, detail)
          : refuse("oauth_failed", reason, undefined, detail);

      if (!flow) return refuse("oauth_failed", "flow_cookie_invalid");
      if (!provider || flow.providerId !== provider.id) return refuseFlow("flow_cookie_invalid");
      // Only this browser's flow cookie proves the callback answers a
      // sign-in it started. openid-client checks it again.
      if (callbackUrl.searchParams.get("state") !== flow.state) return refuseFlow("state_mismatch");
      const providerError = callbackUrl.searchParams.get("error");
      if (providerError !== null) {
        return refuseFlow("provider_error", { error: providerErrorLabel(providerError) });
      }

      let claims: ProviderClaims;
      try {
        claims = await exchange(provider, callbackUrl, flow);
      } catch (error) {
        return refuseFlow("exchange_failed", { error: errorLabel(error) });
      }

      if (flow.intent === "link") return completeLink(provider, claims, flow, origin);

      // Anything unexpected from here on (the database, a bug) is audited
      // and still ends in a redirect to /login with the flow's own
      // `redirectTo`. The row names it by a label, never the error itself.
      // The route's error handler stays as the last resort, for a failure
      // of this audit write.
      let outcome: SignInOutcome;
      try {
        outcome = await signIn(provider, claims, origin, at, redirectTo);
      } catch (error) {
        await refuse("oauth_failed", "internal_error", undefined, { error: errorLabel(error) });
        return { kind: "refused", code: "oauth_failed", redirectTo, error };
      }
      if (outcome.kind === "refused") return refuse(outcome.code, outcome.reason, outcome.user);
      return outcome;
    },

    async signInMethods(context: AuthContext): Promise<SignInMethodsResponse> {
      const user = await users.findById(context.userId);
      if (!user) throw unauthenticated();
      const linked = await identities.listForUser(user.id);
      return {
        hasPassword: user.passwordHash !== null,
        identities: linked.map((identity) => ({
          provider: identity.provider,
          email: identity.email,
          linkedAt: identity.linkedAt.toISOString(),
          relinksByEmail: providers.relinksByEmail(identity.provider),
        })),
        providers: providers.list(),
      };
    },

    /**
     * The link's start, in its order: an unknown provider is the
     * OIDC start's `404 not_found`; an identity the account already has at
     * it is `409 identity_already_linked`; with a password, the current one
     * is verified (a missing one is as wrong, and audited alike); without
     * one, nothing is asked. Then discovery, whose failure the route answers
     * `503 provider_unavailable`, and the flow cookie naming the account and
     * the session, back to `/settings/account`.
     */
    async beginLink(input: BeginLinkInput): Promise<BeginLinkResult> {
      const { context, origin } = input;
      const provider = providers.get(input.providerId);
      if (!provider) throw unknownProvider();
      const user = await users.findById(context.userId);
      if (!user) throw unauthenticated();
      if (await identities.findForUser(user.id, provider.id)) throw identityAlreadyLinked();

      const isReauthenticated = user.passwordHash !== null;
      if (user.passwordHash !== null) {
        const attempt: ReauthenticationAttempt = {
          user: { id: user.id, email: user.email },
          purpose: "identity_link",
          context,
          origin,
        };
        if (input.currentPassword === undefined) {
          await recordReauthenticationFailure(audit, attempt);
          throw currentPasswordIncorrect();
        }
        await verifyCurrentPassword(
          { audit, verifyPassword: deps.verifyPassword },
          { ...attempt, user: { ...attempt.user, passwordHash: user.passwordHash }, currentPassword: input.currentPassword },
        );
      }

      let configuration;
      try {
        configuration = await provider.configuration();
      } catch (error) {
        return { kind: "unavailable", error };
      }
      const flow = await createFlowCookie(
        {
          providerId: provider.id,
          redirectTo: LINK_REDIRECT_PATH,
          link: { userId: user.id, sessionId: context.sessionId },
        },
        settings.accessTokenSecret,
        now(),
      );
      const authorizationUrl = buildAuthorizationUrl(configuration, {
        redirect_uri: oidcRedirectUri(settings, provider.id),
        scope: SCOPE,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: flow.codeChallenge,
        code_challenge_method: "S256",
      });
      return { kind: "redirect", authorizationUrl, flowCookie: flow.value, isReauthenticated };
    },

    /**
     * The unlink, in its order: no identity at the provider is
     * `404 identity_not_linked`; no password is
     * `409 unlink_requires_password` (it would leave no way to sign in); the
     * current password verified outside any transaction; then, in one
     * transaction, the user's row locked first, the hash reread under the
     * lock and refused if it changed since the verify, the identity deleted
     * and `user.identity_unlinked` audited. The email follows the commit.
     * The sessions are kept.
     */
    async unlink(input: UnlinkInput): Promise<void> {
      const { context, origin, providerId } = input;
      const user = await users.findById(context.userId);
      if (!user) throw unauthenticated();
      if (!(await identities.findForUser(user.id, providerId))) throw identityNotLinked();
      if (user.passwordHash === null) throw unlinkRequiresPassword();

      const verifiedHash = user.passwordHash;
      const attempt: ReauthenticationAttempt = {
        user: { id: user.id, email: user.email },
        purpose: "identity_unlink",
        context,
        origin,
      };
      await verifyCurrentPassword(
        { audit, verifyPassword: deps.verifyPassword },
        { ...attempt, user: { ...attempt.user, passwordHash: verifiedHash }, currentPassword: input.currentPassword },
      );

      // It returns rather than throws, so a refusal's audit row is written
      // after the rollback and never with it.
      const outcome = await withTransaction(
        async (transaction): Promise<"unlinked" | "changed_since" | "gone" | "not_linked"> => {
          await transaction.users.lockForUpdate(user.id);
          const currentHash = await transaction.users.findPasswordHashForShare(user.id);
          if (currentHash === undefined) return "gone";
          if (currentHash !== verifiedHash) return "changed_since";
          // A concurrent unlink, queued on the same lock, may have gone first.
          if (!(await transaction.identities.unlink(user.id, providerId))) return "not_linked";
          await transaction.audit.record({
            action: "user.identity_unlinked",
            actorUserId: user.id,
            actorEmail: user.email,
            organizationId: context.organizationId,
            subjectType: "user",
            subjectId: user.id,
            metadata: { provider: providerId },
            ipAddress: origin.ipAddress,
            userAgent: origin.userAgent,
          });
          return "unlinked";
        },
      );
      if (outcome === "gone") throw unauthenticated();
      if (outcome === "not_linked") throw identityNotLinked();
      if (outcome === "changed_since") {
        await recordReauthenticationFailure(audit, attempt);
        throw currentPasswordIncorrect();
      }

      // After the commit. The provider by its configured name, else its id
      // (one no longer configured can still be unlinked). The re-link
      // sentence only when a sign-in with it can link it again.
      const providerName = providers.get(providerId)?.name ?? providerId;
      const relinksByEmail = providers.relinksByEmail(providerId);
      runAfterResponse(() =>
        mailer.send({
          to: user.email,
          ...buildIdentityUnlinkedEmail({ providerName, relinksByEmail, forgotPasswordUrl }),
        }),
      );
    },
  };
}
