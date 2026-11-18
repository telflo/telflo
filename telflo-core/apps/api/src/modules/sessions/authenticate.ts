import type { OrganizationType } from "@telflo/db";
import type { IdentityErrorCode, SessionErrorCode } from "@telflo/contracts";
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { createAuthContext, type AuthContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import { ACCESS_COOKIE_NAME } from "./cookies.js";
import type { ISessionService } from "./service.js";

/**
 * Who a request is acting as, once `authenticate` has accepted it: the
 * frozen `AuthContext` (D5 decision 4), which authorization and the database
 * context read, and beside it the email and the organization's name and
 * type, which only `/me` and the audit rows need, whether the user has
 * accepted the current terms, which `requireCurrentTerms` reads, and whether
 * they are a product admin, which `requireProductAdmin` and `/me` read.
 */
export interface RequestAuthentication {
  context: AuthContext;
  email: string;
  organizationName: string;
  organizationType: OrganizationType;
  /** The active organization's logo's id as the session check read it (D23-2 decision 40), null for none. */
  organizationLogoId: string | null;
  /**
   * The user's Terms are satisfied, as the session service answered (D36-1
   * Preflight ruling 1): the site asks for none, or the user has accepted
   * its version. False for an older version and for none (a federated
   * sign-up), alike, while the site asks for Terms.
   */
  hasAcceptedCurrentTerms: boolean;
  /**
   * The user row's `is_product_admin` as the session check read it on this
   * request (D12 decision 3). Never from the token: an operator's
   * revocation takes effect on the user's next request, with no new session.
   */
  isProductAdmin: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Null unless the route runs the `authenticate` preHandler and it accepted the request. */
    authentication: RequestAuthentication | null;
  }
}

/** Declares the request property's shape once, for every request (Fastify's decorator guidance). */
export function decorateAuthentication(server: FastifyInstance): void {
  server.decorateRequest("authentication", null);
}

/**
 * The preHandler for routes that need a signed-in user. Only an expired but
 * otherwise genuine token, or one whose session has since moved to another
 * organization, gets `access_token_expired`, the one code a client answers by
 * refreshing (D2a decision 5, D5 decision 10). Every other failure is
 * `unauthenticated`.
 *
 * The only place an `AuthContext` is built. Its role is the membership's as
 * the session check read it on this request.
 */
export function createAuthenticate(service: ISessionService): preHandlerAsyncHookHandler {
  return async (request) => {
    const result = await service.authenticate(request.cookies[ACCESS_COOKIE_NAME]);
    if (result.status === "expired") {
      throw new AppError("access_token_expired" satisfies SessionErrorCode, "Your session has expired.", 401);
    }
    if (result.status === "unauthenticated") {
      throw new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
    }
    request.authentication = {
      context: createAuthContext({
        userId: result.userId,
        organizationId: result.organization.id,
        role: result.organization.role,
        sessionId: result.sessionId,
      }),
      email: result.email,
      organizationName: result.organization.name,
      organizationType: result.organization.type,
      organizationLogoId: result.organization.logoId,
      hasAcceptedCurrentTerms: result.hasAcceptedCurrentTerms,
      isProductAdmin: result.isProductAdmin,
    };
  };
}

/**
 * For handlers behind `authenticate`. Throwing here rather than asserting
 * non-null means a route that forgets the preHandler fails closed.
 */
export function requireAuthentication(request: FastifyRequest): RequestAuthentication {
  if (!request.authentication) throw new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
  return request.authentication;
}

/**
 * The preHandler for data endpoints, after `authenticate` (D7 decision 10):
 * refuses a user who hasn't accepted the current terms, so the terms gate
 * the API and not only the web app's dialog. A route that runs it without
 * `authenticate` fails closed with `unauthenticated`, as
 * `requireAuthentication` does.
 *
 * `/me`, the terms acceptance, signing out, switching organization and D5's
 * and D6's organization, member and invitation management never run it: the
 * dialog needs the first four to do its work, and the owner ruled that only
 * data endpoints refuse.
 */
export async function requireCurrentTerms(request: FastifyRequest): Promise<void> {
  const authentication = requireAuthentication(request);
  if (!authentication.hasAcceptedCurrentTerms) {
    throw new AppError(
      "terms_acceptance_required" satisfies IdentityErrorCode,
      "Accept the current Terms of Service to continue.",
      403,
    );
  }
}

/**
 * The preHandler for a list the members read and a product admin's page
 * lists too, after `authenticate`: a member needs the current terms (as
 * `requireCurrentTerms`); a product admin doesn't. D12's flows admin page
 * reads its list (`GET /api/v1/flows`) signed in, without the terms, and the
 * test templates' list (D14b Preflight ruling 11) and the regex library's
 * (D15b Preflight ruling 3) read the same way. The flag is the one the
 * session check read on this request. A route that runs it without
 * `authenticate` fails closed with `unauthenticated`.
 */
export async function requireCurrentTermsUnlessProductAdmin(request: FastifyRequest): Promise<void> {
  if (requireAuthentication(request).isProductAdmin) return;
  await requireCurrentTerms(request);
}

/**
 * The preHandler for product administration's endpoints, after
 * `authenticate` (D12 decision 3): refuses a user without the product-admin
 * flag with 403 `product_admin_required`. The flag is the one the session
 * check read from the user's row on this request, so a revocation refuses
 * the very next request. A route that runs it without `authenticate` fails
 * closed with `unauthenticated`, as `requireAuthentication` does.
 *
 * Independent of the active organization and its role: a product admin
 * administers the product, not an organization.
 */
export async function requireProductAdmin(request: FastifyRequest): Promise<void> {
  const authentication = requireAuthentication(request);
  if (!authentication.isProductAdmin) {
    throw new AppError("product_admin_required" satisfies IdentityErrorCode, "Only a product admin can do that.", 403);
  }
}
