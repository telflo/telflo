import {
  INVITATION_SIGN_IN_ONLY_MESSAGE,
  type OidcQueryErrorCode,
  type OrganizationType,
  type RegistrationMode,
} from "@telflo/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../errors.js";

/*
 * Who may create an account (D36-1 decision 35; settings' `site.registration`,
 * TELFLO_REGISTRATION):
 * - `open`: anyone, by registering, by an invitation or by a provider's
 *   sign-in (today's behaviour);
 * - `invite-only`: only by an invitation. Registering and a provider's
 *   sign-in with no matching account are refused;
 * - `closed`: nobody. An invitation can still be accepted by an existing
 *   account, signed in; registering from one is refused.
 * Signing in to an existing account, and linking or taking one over with a
 * provider, work in every mode. The first product admin's account is made
 * by `telflo-admin bootstrap` in every mode (decision 37).
 *
 * Under `invite-only`, an invitation from a PERSONAL organization can't make
 * an account (decision 52; Q252): every account admins its own personal
 * organization, so otherwise anyone on the site could bring strangers in
 * from theirs. An existing account still accepts it, signed in. A group
 * organization's invitation registers as before.
 */

/** How an account would be made: by its owner (registering, a provider's sign-in) or from an invitation. */
export type RegistrationKind = "self" | "invitation";

/** The refusals' fixed words, one per mode that refuses (never an address or a name). */
export const REGISTRATION_INVITE_ONLY_MESSAGE = "This site is invitation-only. Ask an organization admin for an invitation.";
export const REGISTRATION_CLOSED_MESSAGE = "This site isn't accepting new accounts.";

/** Whether `mode` lets an account be made this way. */
export function allowsRegistration(mode: RegistrationMode, kind: RegistrationKind): boolean {
  switch (mode) {
    case "open":
      return true;
    case "invite-only":
      return kind === "invitation";
    case "closed":
      return false;
  }
}

/**
 * Whether an invitation from an organization of this type can make a new
 * account in `mode` (decisions 35 and 52): never under `closed`; under
 * `invite-only`, only a group organization's; always under `open`.
 */
export function allowsInvitationRegistration(mode: RegistrationMode, organizationType: OrganizationType): boolean {
  if (!allowsRegistration(mode, "invitation")) return false;
  return !(mode === "invite-only" && organizationType === "personal");
}

/**
 * Decision 52's refusal: `403 registration_not_open`, the code the web
 * already reads for a refused registration, in words of its own (the
 * invite-only words would tell an invitee to ask for an invitation).
 */
export function personalInvitationRegistrationRefused(): AppError {
  return new AppError("registration_not_open" satisfies OidcQueryErrorCode, INVITATION_SIGN_IN_ONLY_MESSAGE, 403);
}

/**
 * `403 registration_not_open`: the code the OIDC callback puts in the login
 * URL for the same refusal (contracts' OIDC_QUERY_ERROR_CODES), so the web
 * reads one code for both.
 */
export function registrationNotOpen(mode: RegistrationMode): AppError {
  return new AppError(
    "registration_not_open" satisfies OidcQueryErrorCode,
    mode === "closed" ? REGISTRATION_CLOSED_MESSAGE : REGISTRATION_INVITE_ONLY_MESSAGE,
    403,
  );
}

/**
 * The gate of a route that makes an account (Preflight ruling 4): an
 * `onRequest` hook, FIRST in the route's array, so a refused request is
 * answered before the per-IP limit counts it and before its body is read,
 * parsed or validated (a malformed or oversized body is refused alike; the
 * global CSRF guard still runs before it). The mode is fixed per process,
 * like every setting. Where `mode` allows the kind, it lets every request
 * through.
 */
export function registrationGate(
  mode: RegistrationMode,
  kind: RegistrationKind,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const allowed = allowsRegistration(mode, kind);
  return async () => {
    if (!allowed) throw registrationNotOpen(mode);
  };
}
