import multipart from "@fastify/multipart";
import {
  ChangeMemberRoleRequestSchema,
  ChangeOrganizationRequestSchema,
  CreateInvitationRequestSchema,
  CreateOrganizationRequestSchema,
  DEFAULT_USER_PREFERENCES,
  ErrorResponseSchema,
  imageTypeOf,
  InvitationPreviewResponseSchema,
  InvitationRegistrationRequestSchema,
  InvitationResponseSchema,
  InvitationsResponseSchema,
  InvitationTokenRequestSchema,
  JoinedOrganizationResponseSchema,
  MembersResponseSchema,
  ORGANIZATION_LOGO_MAXIMUM_BYTES,
  ORGANIZATION_PART_NAMES,
  OrganizationNameSchema,
  OrganizationResponseSchema,
  OrganizationSettingsSchema,
  type Invitation as InvitationResponseBody,
  type Member as MemberResponseBody,
  type Organization as OrganizationResponseBody,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Transaction } from "kysely";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import type { Database, OrganizationLogoContentType } from "@telflo/db";
import { setOrganizationContext, withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { setThemeCookie } from "../account/theme-cookie.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createUserRepository } from "../identity/repositories/user-repository.js";
import { registrationGate } from "../identity/registration.js";
import { createAuthenticate, requireAuthentication } from "../sessions/authenticate.js";
import { ACCESS_COOKIE_NAME, accessCookieOptions, setSessionCookies } from "../sessions/cookies.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { readOrganizationCreation } from "../site-settings/organization-creation.js";
import { invalidUpload } from "../test-runs/errors.js";
import { discardUnreadUpload, readUploadParts, uploadPartLimits } from "../test-runs/upload-parts.js";
import { organizationLogoTooLarge, organizationLogoTypeUnsupported } from "./errors.js";
import { createInviteeService } from "./invitations-service.js";
import type { OpampRegistration } from "./opamp-registration.js";
import { createInvitationRepository, findInvitationByTokenHash } from "./repositories/invitation-repository.js";
import { createMemberRepository, type Member } from "./repositories/member-repository.js";
import {
  createActiveOrganizationRepository,
  createOrganizationRepository,
  type Organization,
} from "./repositories/organization-repository.js";
import {
  createOrganizationService,
  type OrganizationRepositories,
  type PendingInvitation,
  type SessionActor,
  type WithOrganizationTransaction,
} from "./service.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

/** What the organizations' services are built from, once, in buildServer. */
export interface OrganizationServicesDependencies extends ServerDependencies {
  now: () => Date;
  opampRegistration: OpampRegistration;
}

/**
 * The organizations' services, one instance each, shared by the browser
 * routes here and the public routes: the organization service and the
 * invitee's.
 */
export interface OrganizationServices {
  service: ReturnType<typeof createOrganizationService>;
  invitee: ReturnType<typeof createInviteeService>;
}

export interface OrganizationRoutesDependencies extends OrganizationServicesDependencies {
  /** buildServer's shared instances (createOrganizationServices). */
  services: { organizations: OrganizationServices };
}

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/**
 * A create's and a change's own refusals of a logo: 413
 * `organization_logo_too_large` and 415 `organization_logo_type_unsupported`,
 * and Fastify's 415 for a body of a type nothing parses.
 */
const logoErrorResponses = { 413: ErrorResponseSchema, 415: ErrorResponseSchema };

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
};

/** The invitee's endpoints: the per-IP limit, and an expired invitation's 410. */
const inviteeErrorResponses = {
  ...errorResponses,
  410: ErrorResponseSchema,
  429: ErrorResponseSchema,
};

/** The invitation endpoints that send mail can also be refused by its limit, or fail to send. */
const mailingErrorResponses = {
  ...errorResponses,
  429: ErrorResponseSchema,
  502: ErrorResponseSchema,
};

/**
 * Inviting and registering from an invitation also refuse an address at
 * the service accounts' domain: `422 email_reserved`.
 */
const reservedAddressErrorResponse = { 422: ErrorResponseSchema };

/**
 * Any string: a path naming anything but the active organization, a
 * malformed id included, is the same 404, not a 400.
 */
const OrganizationParamsSchema = z.object({ organizationId: z.string() });

/**
 * Any string for the member too: one that isn't a UUID names no member, and
 * gets the service's 404 member_not_found, as an unknown one does.
 */
const MemberParamsSchema = z.object({ organizationId: z.string(), userId: z.string() });

/** Any string, as for a member: the service answers one that isn't a UUID with 404 invitation_not_found. */
const InvitationParamsSchema = z.object({ organizationId: z.string(), invitationId: z.string() });

/**
 * The caller, and where the request came from, for the checks and the audit
 * trail. The configuration routes use it too. A session's: a session-only
 * helper, so its actor is a `SessionActor`.
 */
export function actorOf(request: FastifyRequest): SessionActor {
  const authentication = requireAuthentication(request);
  return {
    context: authentication.context,
    email: authentication.email,
    ipAddress: clientIpForAudit(request.ip),
    userAgent: auditUserAgent(request),
  };
}

function toResponseBody(organization: Organization): OrganizationResponseBody {
  return { id: organization.id, name: organization.name, type: organization.type, logoId: organization.logoId };
}

/** What a multipart create or change holds: the name, and the logo read whole and typed. */
interface OrganizationUpload {
  name: string;
  contentType: OrganizationLogoContentType;
  bytes: Buffer;
}

/**
 * The file part's bytes, whole (at most ORGANIZATION_LOGO_MAXIMUM_BYTES:
 * busboy cuts it there). A body that breaks off is 400.
 */
async function readWhole(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk as Buffer);
  } catch {
    // The error's text stays out: it can quote the body's framing.
    throw invalidUpload();
  }
  return Buffer.concat(chunks);
}

/**
 * A create's or a change's multipart body: the parts in
 * ORGANIZATION_PART_NAMES' order, the name checked by the contract (400
 * with no details: they could echo it), the file read whole, then `finish`
 * (413 past 2 MiB, 400 for anything after the file), then typed from its
 * first bytes, never its name or its declared type (415 for an empty file,
 * SVG, GIF or anything but a PNG, a JPEG or a WebP). Every refusal comes
 * before a byte is written.
 */
async function readOrganizationUpload(request: FastifyRequest): Promise<OrganizationUpload> {
  const parts = await readUploadParts(request, ORGANIZATION_LOGO_MAXIMUM_BYTES, ORGANIZATION_PART_NAMES, {
    tooLarge: organizationLogoTooLarge,
  });
  const name = OrganizationNameSchema.safeParse(parts.fields.name);
  if (!name.success) {
    parts.file.file.destroy();
    throw invalidUpload();
  }
  const bytes = await readWhole(parts.file.file);
  await parts.finish();
  const contentType = imageTypeOf(bytes);
  if (contentType === undefined) throw organizationLogoTypeUnsupported();
  return { name: name.data, contentType, bytes };
}

function toMemberResponseBody(member: Member): MemberResponseBody {
  return {
    userId: member.userId,
    email: member.email,
    role: member.role,
    isOrganizationOwner: member.isOrganizationOwner,
    createdAt: member.createdAt.toISOString(),
    deletedAt: member.deletedAt === null ? null : member.deletedAt.toISOString(),
  };
}

/** No token and no hash: the response has nothing to carry either in. */
function toInvitationResponseBody(invitation: PendingInvitation): InvitationResponseBody {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invitedAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    isExpired: invitation.isExpired,
  };
}

function organizationRepositories(transaction: Transaction<Database>, organizationId: string): OrganizationRepositories {
  return {
    organization: createActiveOrganizationRepository(transaction, { organizationId }),
    members: createMemberRepository(transaction, { organizationId }),
    invitations: createInvitationRepository(transaction, { organizationId }),
  };
}

/**
 * The organizations' services: built once in buildServer and shared by the
 * browser and the public routes, so the invitation mail limit is counted once
 * per person.
 */
export function createOrganizationServices(
  deps: OrganizationServicesDependencies,
  rateLimiters: Pick<RateLimiters, "invitationEmailsPerUser">,
  log: FastifyBaseLogger,
): OrganizationServices {
  const { db, now, mailer, settings, opampRegistration } = deps;
  const sessions = createDatabaseSessionService(deps).service;
  const withTransaction: WithOrganizationTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) =>
      work({
        organizations: createOrganizationRepository(transaction),
        audit: createAuditRepository(transaction),
        active: organizationRepositories(transaction, context.organizationId),
        enterOrganization: async (organizationId) => {
          await setOrganizationContext(transaction, organizationId);
          return organizationRepositories(transaction, organizationId);
        },
      }),
    );
  const service = createOrganizationService({
    withTransaction,
    now,
    mailer,
    publicWebUrl: settings.publicWebUrl,
    consumeInvitationEmail: rateLimiters.invitationEmailsPerUser,
    log,
    opampRegistration,
    fileStore: deps.fileStore,
    nextId: () => createOrganizationRepository(db).nextId(),
    organizationCreation: () => readOrganizationCreation(db),
    registration: settings.site.registration,
  });
  const invitee = createInviteeService({
    findInvitationByTokenHash: (tokenHash) => findInvitationByTokenHash(db, tokenHash),
    withTransaction,
    users: createUserRepository(db),
    sessions,
    now,
    log,
    opampRegistration,
    termsVersion: settings.site.terms.version,
    registration: settings.site.registration,
  });
  return { service, invitee };
}

/**
 * The organization, member and invitation endpoints. The management
 * endpoints need a session and aren't rate limited, except that inviting and
 * resending count against the inviter's mail limit, which the service
 * checks. Each of their transactions carries the request's `AuthContext` as
 * its database context. The invitee's three, at the end, share the per-IP
 * identity bucket; only acceptance needs a session.
 *
 * The validator/serializer compilers are server-wide and set once in
 * buildServer, not here.
 */
export function registerOrganizationRoutes(
  server: FastifyInstance,
  deps: OrganizationRoutesDependencies,
  rateLimiters: RateLimiters,
): void {
  const { settings } = deps;
  const { service, invitee } = deps.services.organizations;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const typed = server.withTypeProvider<ZodTypeProvider>();

  // The create and the change, in their own encapsulated plugin, the only one
  // here with @fastify/multipart registered: its parser reads nothing, so a
  // logo's body is read in the handler, after `authenticate` (and, for a
  // change, the active organization's and the role's checks). JSON stays for
  // a body without a file. Fastify checks the body schema before the handler
  // and a multipart body reaches it as null, so both are `.nullish()` and the
  // handler decides by content: multipart, the parts; no body, 400; JSON, the
  // contract's. The DELETE and everything else stay outside.
  void server.register(async (scope) => {
    await scope.register(multipart, {
      limits: { ...uploadPartLimits(ORGANIZATION_PART_NAMES), fileSize: ORGANIZATION_LOGO_MAXIMUM_BYTES },
    });
    // A refused upload may leave its body unread: the rest is dropped, so
    // the answer reaches the client and the connection serves its next request.
    scope.addHook("onSend", async (request, reply, payload) => {
      if (reply.statusCode >= 400) discardUnreadUpload(request);
      return payload;
    });
    const scoped = scope.withTypeProvider<ZodTypeProvider>();

    scoped.post(
      "/api/v1/organizations",
      {
        preHandler: authenticate,
        schema: {
          body: CreateOrganizationRequestSchema.nullish(),
          response: { 201: OrganizationResponseSchema, ...errorResponses, ...logoErrorResponses },
        },
      },
      async (request, reply) => {
        // The flag as this request's session check read it: the product admins' switch.
        const actor = { ...actorOf(request), isProductAdmin: requireAuthentication(request).isProductAdmin };
        let organization: Organization;
        if (request.isMultipart()) {
          // The switch and the ids first, then the parts: nothing of the body is read before them.
          const { organizationId, logoId } = await service.prepareCreate(actor);
          const upload = await readOrganizationUpload(request);
          organization = await service.create(actor, upload.name, {
            organizationId,
            logo: { logoId, contentType: upload.contentType, bytes: upload.bytes },
          });
        } else {
          if (request.body == null) throw invalidUpload();
          organization = await service.create(actor, request.body.name);
        }
        return reply.status(201).send({ organization: toResponseBody(organization) });
      },
    );

    scoped.patch(
      "/api/v1/organizations/:organizationId",
      {
        preHandler: authenticate,
        schema: {
          params: OrganizationParamsSchema,
          body: ChangeOrganizationRequestSchema.nullish(),
          response: { 200: OrganizationResponseSchema, ...errorResponses, ...logoErrorResponses },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const { organizationId } = request.params;
        let organization: Organization;
        if (request.isMultipart()) {
          // The checks and the new logo's id first, then the parts.
          const { logoId } = await service.prepareChange(actor, organizationId);
          const upload = await readOrganizationUpload(request);
          organization = await service.change(actor, organizationId, {
            name: upload.name,
            logo: { logoId, contentType: upload.contentType, bytes: upload.bytes },
          });
        } else {
          if (request.body == null) throw invalidUpload();
          organization = await service.change(actor, organizationId, {
            name: request.body.name,
            removeLogo: request.body.removeLogo === true,
          });
        }
        return reply.send({ organization: toResponseBody(organization) });
      },
    );
  });

  typed.delete(
    "/api/v1/organizations/:organizationId",
    {
      preHandler: authenticate,
      schema: { params: OrganizationParamsSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      await service.delete(actorOf(request), request.params.organizationId);
      return reply.status(204).send(null);
    },
  );

  // The organization's settings: any member reads them; only an admin changes
  // them (CSRF, as every PATCH).
  typed.get(
    "/api/v1/organizations/:organizationId/settings",
    {
      preHandler: authenticate,
      schema: { params: OrganizationParamsSchema, response: { 200: OrganizationSettingsSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const current = await service.findSettings(actorOf(request), request.params.organizationId);
      return reply.send({ publicInstallLinks: current.publicInstallLinks });
    },
  );

  typed.patch(
    "/api/v1/organizations/:organizationId/settings",
    {
      preHandler: authenticate,
      schema: {
        params: OrganizationParamsSchema,
        body: OrganizationSettingsSchema,
        response: { 200: OrganizationSettingsSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const changed = await service.changeSettings(actorOf(request), request.params.organizationId, request.body);
      return reply.send({ publicInstallLinks: changed.publicInstallLinks });
    },
  );

  typed.get(
    "/api/v1/organizations/:organizationId/members",
    {
      preHandler: authenticate,
      schema: { params: OrganizationParamsSchema, response: { 200: MembersResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const members = await service.listMembers(actorOf(request), request.params.organizationId);
      return reply.send({ items: members.map(toMemberResponseBody) });
    },
  );

  typed.patch(
    "/api/v1/organizations/:organizationId/members/:userId",
    {
      preHandler: authenticate,
      schema: {
        params: MemberParamsSchema,
        body: ChangeMemberRoleRequestSchema,
        response: { 204: noContent, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { organizationId, userId } = request.params;
      await service.changeMemberRole(actorOf(request), organizationId, userId, request.body.role);
      return reply.status(204).send(null);
    },
  );

  typed.delete(
    "/api/v1/organizations/:organizationId/members/:userId",
    {
      preHandler: authenticate,
      schema: { params: MemberParamsSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      await service.removeMember(actorOf(request), request.params.organizationId, request.params.userId);
      return reply.status(204).send(null);
    },
  );

  typed.put(
    "/api/v1/organizations/:organizationId/members/:userId/restoration",
    {
      preHandler: authenticate,
      schema: { params: MemberParamsSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      await service.restoreMember(actorOf(request), request.params.organizationId, request.params.userId);
      return reply.status(204).send(null);
    },
  );

  typed.post(
    "/api/v1/organizations/:organizationId/invitations",
    {
      preHandler: authenticate,
      schema: {
        params: OrganizationParamsSchema,
        body: CreateInvitationRequestSchema,
        response: { 201: InvitationResponseSchema, ...mailingErrorResponses, ...reservedAddressErrorResponse },
      },
    },
    async (request, reply) => {
      const invitation = await service.invite(actorOf(request), request.params.organizationId, request.body);
      return reply.status(201).send({ invitation: toInvitationResponseBody(invitation) });
    },
  );

  typed.get(
    "/api/v1/organizations/:organizationId/invitations",
    {
      preHandler: authenticate,
      schema: { params: OrganizationParamsSchema, response: { 200: InvitationsResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const invitations = await service.listInvitations(actorOf(request), request.params.organizationId);
      return reply.send({ items: invitations.map(toInvitationResponseBody) });
    },
  );

  // A delivery of the invitation: a new token and expiry, and the email
  // again. A resource created, so POST and 201 (the path names a resource,
  // never a verb).
  typed.post(
    "/api/v1/organizations/:organizationId/invitations/:invitationId/deliveries",
    {
      preHandler: authenticate,
      schema: { params: InvitationParamsSchema, response: { 201: InvitationResponseSchema, ...mailingErrorResponses } },
    },
    async (request, reply) => {
      const { organizationId, invitationId } = request.params;
      const invitation = await service.resendInvitation(actorOf(request), organizationId, invitationId);
      return reply.status(201).send({ invitation: toInvitationResponseBody(invitation) });
    },
  );

  typed.delete(
    "/api/v1/organizations/:organizationId/invitations/:invitationId",
    {
      preHandler: authenticate,
      schema: { params: InvitationParamsSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      await service.cancelInvitation(actorOf(request), request.params.organizationId, request.params.invitationId);
      return reply.status(204).send(null);
    },
  );

  // The invitee's three endpoints share the per-IP identity bucket, as sign-in
  // and registration do. The token travels in the body only, never the path or
  // query, so it stays out of access logs.

  typed.post(
    "/api/v1/invitation-previews",
    {
      onRequest: rateLimiters.identityPerIp,
      schema: {
        body: InvitationTokenRequestSchema,
        response: { 200: InvitationPreviewResponseSchema, ...inviteeErrorResponses },
      },
    },
    async (request, reply) => {
      const invitation = await invitee.preview(request.body.token);
      return reply.send({ invitation });
    },
  );

  /**
   * Joins, then switches the session into the organization. Only the access
   * cookie is set, as the switch route sets it; none when the session didn't
   * move.
   */
  typed.post(
    "/api/v1/invitation-acceptances",
    {
      onRequest: rateLimiters.identityPerIp,
      preHandler: authenticate,
      schema: {
        body: InvitationTokenRequestSchema,
        response: { 200: JoinedOrganizationResponseSchema, ...inviteeErrorResponses },
      },
    },
    async (request, reply) => {
      const accepted = await invitee.accept(actorOf(request), request.body.token);
      if (accepted.access) {
        void reply.setCookie(ACCESS_COOKIE_NAME, accepted.access.token, accessCookieOptions(settings));
      }
      return reply.send({ organization: accepted.organization });
    },
  );

  /** Creates the account and joins, signed in: both cookies, as a sign-in sets them. */
  typed.post(
    "/api/v1/invitation-registrations",
    {
      // The registration mode's gate first: closed answers 403
      // registration_not_open before anything else reads the request; an
      // existing account still accepts, above.
      onRequest: [registrationGate(settings.site.registration, "invitation"), rateLimiters.identityPerIp],
      schema: {
        body: InvitationRegistrationRequestSchema,
        response: { 201: JoinedOrganizationResponseSchema, ...inviteeErrorResponses, ...reservedAddressErrorResponse },
      },
    },
    async (request, reply) => {
      const registered = await invitee.register({
        ...request.body,
        ipAddress: clientIpForAudit(request.ip),
        userAgent: auditUserAgent(request),
      });
      setSessionCookies(reply, settings, registered.issued);
      // Always a new account, so no stored theme to read: the default.
      setThemeCookie(reply, settings, DEFAULT_USER_PREFERENCES.theme);
      return reply.status(201).send({ organization: registered.organization });
    },
  );
}
