import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Insertable, type Kysely } from "kysely";
import type { Pool, PoolClient } from "pg";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  DEFAULT_USER_PREFERENCES,
  INVITATION_TTL_DAYS,
} from "@telflo/contracts";
import {
  createDb,
  createPool,
  type Database,
  type OrganizationInvitationsTable,
  type OrganizationRole,
} from "@telflo/db";
import {
  addInvitation,
  addMembership,
  addServiceAccount,
  catalogueDefaults,
  createUserWithOrganization,
  removeMembership,
  truncateAll,
  withFailingInsert,
} from "@telflo/db/testing";
import type { EmailMessage, IMailer } from "../../mail/mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { RATE_LIMITED_MESSAGE, RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import {
  STARTER_CONFIGURATION_DESCRIPTION,
  STARTER_CONFIGURATION_NAME,
  STARTER_CONFIGURATION_YAML,
} from "../configurations/starter-configuration.js";
import { hashPassword, verifyPassword } from "../identity/password.js";
import { hashToken } from "../identity/tokens.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

/*
 * D6 decisions 6 to 11: inviting, listing, resending and cancelling, and the
 * invitee's previewing, accepting and creating an account, against the real
 * database, as the application role.
 */

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const DAY_MS = 24 * 60 * 60 * 1000;
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * DAY_MS;

const MESSAGES = {
  alreadyMember: "User is already a member of this organization",
  removed: (email: string) =>
    `${email} was previously removed from this organization. Restore them from the Deleted view instead of re-inviting.`,
  alreadyInvited: "User has already been invited to this organization",
  notFound: "No pending invitation found for this user",
  emailFailed: "The invitation was created, but its email couldn't be sent. Use Resend to try again.",
  resentEmailFailed: "The invitation's link was renewed, but its email couldn't be sent. Use Resend to try again.",
  invalidLink: "Invalid or expired invite link. Please ask your admin to resend the invitation.",
  expired: "This invitation link has expired. Please ask your admin to resend the invitation.",
  alreadyAccepted: "This invitation has already been accepted.",
  mismatch: (email: string) => `This invitation was sent to ${email}. Sign in with that address to accept it.`,
  removedInvitee: "You were removed from this organization. Ask an admin to restore you.",
  accountExists: "An account already exists for this email address. Sign in to accept the invitation.",
};

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

/** An in-memory mailer that can be told to fail, as a relay that refuses the message would. */
function createSwitchableMailer(): IMailer & { sent: EmailMessage[]; isFailing: boolean } {
  const mailer = {
    sent: [] as EmailMessage[],
    isFailing: false,
    async send(message: EmailMessage): Promise<void> {
      if (mailer.isFailing) throw new Error("the relay refused the message");
      mailer.sent.push(message);
    },
  };
  return mailer;
}

/** The token in an invitation email's link: after `#token=`, in the fragment. */
function tokenFrom(message: EmailMessage): string {
  const match = /\/accept-invitation#token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (!match?.[1]) throw new Error("the email carries no invitation link");
  return match[1];
}

/** Builds a server at `level`, restoring LOG_LEVEL whatever happens. */
function withLogLevel<Result>(level: string, build: () => Result): Result {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  try {
    return build();
  } finally {
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
}

describe("organization invitations", () => {
  let settings: AppSettings;
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation, test-only triggers and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let mailer: ReturnType<typeof createSwitchableMailer>;
  let passwordHash: string;
  let clock: Date;
  /** The server's error lines since the test began. */
  let logLines: string[] = [];

  /** A server on the same database and clock, with its own mailer, limits and log. */
  const serverWith = (
    options: { rateLimits?: RateLimits; level?: string; lines?: string[]; site?: Partial<AppSettings["site"]> } = {},
  ) =>
    withLogLevel(options.level ?? "error", () =>
      buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: options.site === undefined ? settings : { ...settings, site: { ...settings.site, ...options.site } },
        db,
        mailer,
        now: () => clock,
        rateLimits: options.rateLimits ?? TEST_RATE_LIMITS,
        logStream: { write: (line) => void (options.lines ?? logLines).push(line) },
      }),
    );

  beforeAll(async () => {
    settings = loadSettings(process.env);
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(settings.databaseUrl));
    mailer = createSwitchableMailer();
    server = serverWith();
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    clock = new Date();
    logLines = [];
    mailer.sent.length = 0;
    mailer.isFailing = false;
  });

  const verifiedUser = () =>
    createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });

  /** Signs in, which lands in the personal organization; returns the access cookie's value. */
  const signedIn = async (email: string, on: FastifyInstance = server) => {
    const response = await on.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  const switchTo = async (access: string, organizationId: string, on: FastifyInstance = server) => {
    const response = await on.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { organizationId },
    });
    expect(response.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return response.headers["set-cookie"] === undefined ? access : cookieValue(response, "telflo_access");
  };

  /**
   * A signed-in user who is a `role` of a group organization (a new one
   * unless given) and has switched into it, so it is their active one.
   */
  const memberActiveInGroup = async (
    role: OrganizationRole = "admin",
    organizationId?: string,
    on: FastifyInstance = server,
  ) => {
    const account = await verifiedUser();
    const { organization: group } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(await signedIn(account.user.email, on), group.id, on);
    return { account, group, access };
  };

  const invitationsUrl = (organizationId: string, invitationId?: string) =>
    `/api/v1/organizations/${organizationId}/invitations${invitationId === undefined ? "" : `/${invitationId}`}`;

  const invite = (access: string, organizationId: string, payload: unknown, on: FastifyInstance = server) =>
    on.inject({
      method: "POST",
      url: invitationsUrl(organizationId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: payload as Record<string, unknown>,
    });

  const list = (access: string, organizationId: string, on: FastifyInstance = server) =>
    on.inject({ method: "GET", url: invitationsUrl(organizationId), cookies: { telflo_access: access } });

  const resend = (access: string, organizationId: string, invitationId: string, on: FastifyInstance = server) =>
    on.inject({
      method: "POST",
      url: `${invitationsUrl(organizationId, invitationId)}/deliveries`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
    });

  const cancel = (access: string, organizationId: string, invitationId: string, on: FastifyInstance = server) =>
    on.inject({
      method: "DELETE",
      url: invitationsUrl(organizationId, invitationId),
      headers: csrfHeaders,
      cookies: { telflo_access: access },
    });

  const invitationRows = (organizationId: string) =>
    ownerDb
      .selectFrom("organization_invitations")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at")
      .execute();

  const invitationRow = (id: string) =>
    ownerDb.selectFrom("organization_invitations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  const auditRows = (action: string) =>
    ownerDb.selectFrom("audit_events").selectAll().where("action", "=", action).orderBy("id").execute();

  const invitationAudits = async () =>
    (
      await ownerDb
        .selectFrom("audit_events")
        .select("action")
        .where("action", "like", "organization_invitation.%")
        .orderBy("id")
        .execute()
    ).map((row) => row.action);

  /** Asserts a refusal's status, code and exact message, and that the envelope carries nothing else. */
  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string, message?: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({
      error: message === undefined ? expect.objectContaining({ code }) : { code, message },
    });
  };

  /** An admin active in a group organization, who has invited `email` and been sent its link. */
  const invited = async (email = `invitee-${randomUUID()}@example.com`, role: OrganizationRole = "contributor") => {
    const admin = await memberActiveInGroup("admin");
    const response = await invite(admin.access, admin.group.id, { email, role });
    expect(response.statusCode).toBe(201);
    const { invitation } = response.json<{ invitation: { id: string; email: string; expiresAt: string } }>();
    const message = mailer.sent.at(-1)!;
    return { admin, group: admin.group, invitation, token: tokenFrom(message) };
  };

  /**
   * A pending invitation to a new group organization, made by fixture, with
   * a token the test knows: its hash is the row's. `overrides` set the row
   * (an address, a role, an expiry, an outcome).
   */
  const pendingInvitation = async (
    overrides: Partial<Omit<Insertable<OrganizationInvitationsTable>, "organization_id" | "token_hash">> = {},
  ) => {
    const admin = await verifiedUser();
    const { organization: group } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const token = randomBytes(32).toString("base64url");
    const invitation = await addInvitation(ownerDb, {
      organizationId: group.id,
      token_hash: hashToken(token),
      expires_at: new Date(clock.getTime() + INVITATION_TTL_MS),
      ...overrides,
    });
    return { group, invitation, token };
  };

  /** A verified account with its own session, and a pending invitation to its address. */
  const invitedAccount = async (role: OrganizationRole = "contributor") => {
    const account = await verifiedUser();
    const access = await signedIn(account.user.email);
    const pending = await pendingInvitation({ email: account.user.email, role });
    return { account, access, ...pending };
  };

  const preview = (token: string, on: FastifyInstance = server) =>
    on.inject({ method: "POST", url: "/api/v1/invitation-previews", headers: csrfHeaders, payload: { token } });

  const accept = (access: string | undefined, token: string, on: FastifyInstance = server) =>
    on.inject({
      method: "POST",
      url: "/api/v1/invitation-acceptances",
      headers: csrfHeaders,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: { token },
    });

  const register = (token: string, overrides: Record<string, unknown> = {}, on: FastifyInstance = server) =>
    on.inject({
      method: "POST",
      url: "/api/v1/invitation-registrations",
      headers: csrfHeaders,
      payload: { token, password: PASSWORD, acceptedTermsVersion: TEST_TERMS_VERSION, ...overrides },
    });

  const me = (access: string) =>
    server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });

  const membership = (userId: string, organizationId: string) =>
    ownerDb
      .selectFrom("organization_members")
      .selectAll()
      .where("user_id", "=", userId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

  /** The user's one session: each account in these tests signs in once. */
  const sessionOf = (userId: string) =>
    ownerDb.selectFrom("sessions").selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();

  const usersWithEmail = (email: string) =>
    ownerDb.selectFrom("users").selectAll().where("email", "=", email).execute();

  /** The configurations of one organization, read as the owner. */
  const configurationsIn = (organizationId: string) =>
    ownerDb.selectFrom("configurations").selectAll().where("organization_id", "=", organizationId).execute();

  const versionsIn = (organizationId: string) =>
    ownerDb.selectFrom("configuration_versions").selectAll().where("organization_id", "=", organizationId).execute();

  /** The audit rows in one organization, in order, as `action` and subject type. */
  const auditTrail = async (organizationId: string) =>
    (
      await ownerDb
        .selectFrom("audit_events")
        .select(["action", "subject_type"])
        .where("organization_id", "=", organizationId)
        .orderBy("id")
        .execute()
    ).map((row) => `${row.action}:${row.subject_type}`);

  describe("POST /api/v1/organizations/:organizationId/invitations", () => {
    it("stores the invitation, audits it, and emails a link whose fragment holds the token", async () => {
      const { account, group, access } = await memberActiveInGroup("admin");

      const response = await invite(access, group.id, { email: "  New.Person@Example.COM ", role: "contributor" });

      expect(response.statusCode).toBe(201);
      const { invitation } = response.json<{ invitation: { id: string } }>();
      expect(invitation).toEqual({
        id: expect.any(String),
        email: "new.person@example.com",
        role: "contributor",
        invitedAt: expect.any(String),
        expiresAt: new Date(clock.getTime() + INVITATION_TTL_MS).toISOString(),
        isExpired: false,
      });

      const row = await invitationRow(invitation.id);
      expect(row).toMatchObject({
        organization_id: group.id,
        email: "new.person@example.com",
        role: "contributor",
        invited_by_user_id: account.user.id,
        expires_at: new Date(clock.getTime() + INVITATION_TTL_MS),
        accepted_at: null,
        accepted_by_user_id: null,
        revoked_at: null,
      });

      expect(mailer.sent).toHaveLength(1);
      const message = mailer.sent[0]!;
      expect(message.to).toBe("new.person@example.com");
      expect(message.subject).toBe(`You've been invited to join ${group.name} on Telflo`);
      const token = tokenFrom(message);
      expect(message.text).toContain(`${settings.publicWebUrl}/accept-invitation#token=${token}`);
      expect(hashToken(token)).toBe(row.token_hash);

      expect(await auditRows("organization_invitation.created")).toEqual([
        expect.objectContaining({
          actor_user_id: account.user.id,
          actor_email: account.user.email,
          organization_id: group.id,
          subject_type: "organization_invitation",
          subject_id: invitation.id,
          metadata: { email: "new.person@example.com", role: "contributor" },
        }),
      ]);
    });

    it("invites into a personal organization (decision 4) while registration is open, as the tests' setup has it (D36-1 decision 57)", async () => {
      const account = await verifiedUser();
      const access = await signedIn(account.user.email);

      const response = await invite(access, account.organization.id, { email: "friend@example.com", role: "admin" });

      expect(response.statusCode).toBe(201);
      expect(await invitationRows(account.organization.id)).toEqual([
        expect.objectContaining({ email: "friend@example.com", role: "admin" }),
      ]);
      expect(mailer.sent.map((message) => message.to)).toEqual(["friend@example.com"]);
      // Named by its owner's email (Q263), it is "<email>'s organization" in the subject (D36-1 Q264).
      expect(account.organization.name).toBe(account.user.email.toLowerCase());
      expect(mailer.sent[0]!.subject).toBe(`You've been invited to join ${account.organization.name}'s organization on Telflo`);
      expect(mailer.sent[0]!.text).toContain(`join ${account.organization.name}'s organization on Telflo, the visual`);
    });

    it("allows another invitation once the address's earlier one was cancelled or accepted", async () => {
      const { group, access } = await memberActiveInGroup("admin");
      await addInvitation(ownerDb, { organizationId: group.id, email: "again@example.com", revoked_at: new Date() });
      await addInvitation(ownerDb, { organizationId: group.id, email: "again@example.com", accepted_at: new Date() });

      expect((await invite(access, group.id, { email: "again@example.com", role: "contributor" })).statusCode).toBe(
        201,
      );
    });

    describe("decision 8's refusals, each writing and sending nothing", () => {
      /** Runs `request`, asserts the refusal, and that no invitation, audit row or email came of it. */
      const expectNothingDone = async (
        organizationId: string,
        request: () => Promise<LightMyRequestResponse>,
        statusCode: number,
        code: string,
        message: string,
      ) => {
        const before = await invitationRows(organizationId);
        expectRefusal(await request(), statusCode, code, message);
        expect(await invitationRows(organizationId)).toEqual(before);
        expect(await invitationAudits()).toEqual([]);
        expect(mailer.sent).toEqual([]);
      };

      it("refuses an active member's address with 409 member_already_active", async () => {
        const admin = await memberActiveInGroup("admin");
        const member = await memberActiveInGroup("contributor", admin.group.id);

        await expectNothingDone(
          admin.group.id,
          () => invite(admin.access, admin.group.id, { email: member.account.user.email.toUpperCase(), role: "admin" }),
          409,
          "member_already_active",
          MESSAGES.alreadyMember,
        );
      });

      it("refuses the caller's own address as already a member", async () => {
        const admin = await memberActiveInGroup("admin");

        await expectNothingDone(
          admin.group.id,
          () => invite(admin.access, admin.group.id, { email: admin.account.user.email, role: "contributor" }),
          409,
          "member_already_active",
          MESSAGES.alreadyMember,
        );
      });

      it("refuses a removed member's address with 409 member_removed, naming the address", async () => {
        const admin = await memberActiveInGroup("admin");
        const removed = await verifiedUser();
        await addMembership(ownerDb, { userId: removed.user.id, organizationId: admin.group.id });
        await removeMembership(ownerDb, { userId: removed.user.id, organizationId: admin.group.id });

        await expectNothingDone(
          admin.group.id,
          () => invite(admin.access, admin.group.id, { email: removed.user.email, role: "contributor" }),
          409,
          "member_removed",
          MESSAGES.removed(removed.user.email),
        );
      });

      it.each([
        ["pending", DAY_MS],
        ["pending and expired", -DAY_MS],
      ])("refuses an address with a %s invitation with 409 invitation_already_pending", async (_label, offset) => {
        const admin = await memberActiveInGroup("admin");
        await addInvitation(ownerDb, {
          organizationId: admin.group.id,
          email: "waiting@example.com",
          expires_at: new Date(clock.getTime() + offset),
        });

        await expectNothingDone(
          admin.group.id,
          () => invite(admin.access, admin.group.id, { email: "Waiting@Example.com", role: "contributor" }),
          409,
          "invitation_already_pending",
          MESSAGES.alreadyInvited,
        );
      });

      /**
       * D22 decision 23, Preflight ruling 13: after the organization and
       * role checks, before the mail limit and the organization lock. The
       * service account is a member of the group, so without the refusal
       * its address would be 409 member_already_active; an address nobody
       * holds would be invited.
       */
      it("refuses the reserved domain with 422 email_reserved before the lock, and writes no invitation", async () => {
        const admin = await memberActiveInGroup("admin");
        const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: admin.group.id });

        for (const email of [
          serviceAccount.email,
          serviceAccount.email.toUpperCase(),
          `nobody-${randomUUID().slice(0, 8)}@service-accounts.telflo.invalid`,
        ]) {
          await expectNothingDone(
            admin.group.id,
            () => invite(admin.access, admin.group.id, { email, role: "contributor" }),
            422,
            "email_reserved",
            "This address can't be used",
          );
        }
      });

      it("refuses the deleted accounts' domain with 422 email_reserved, and writes no invitation (D29 decision 10, Preflight ruling 6)", async () => {
        const admin = await memberActiveInGroup("admin");

        for (const email of [
          `deleted-${"0b".repeat(12)}@deleted-accounts.telflo.invalid`,
          `NOBODY-${randomUUID().slice(0, 8)}@Deleted-Accounts.Telflo.Invalid`,
        ]) {
          await expectNothingDone(
            admin.group.id,
            () => invite(admin.access, admin.group.id, { email, role: "contributor" }),
            422,
            "email_reserved",
            "This address can't be used",
          );
        }
      });

      it("an existing member's address is still 409 member_already_active, beside it", async () => {
        const admin = await memberActiveInGroup("admin");
        const member = await memberActiveInGroup("contributor", admin.group.id);

        await expectNothingDone(
          admin.group.id,
          () => invite(admin.access, admin.group.id, { email: member.account.user.email, role: "contributor" }),
          409,
          "member_already_active",
          MESSAGES.alreadyMember,
        );
      });

      it("checks the organization and the role before the reserved domain: 404 and 403 come first", async () => {
        const contributor = await memberActiveInGroup("contributor");
        const reserved = `nobody-${randomUUID().slice(0, 8)}@service-accounts.telflo.invalid`;

        await expectNothingDone(
          contributor.group.id,
          () => invite(contributor.access, contributor.group.id, { email: reserved, role: "contributor" }),
          403,
          "organization_admin_required",
          "Only an admin of this organization can do that",
        );
        const { account, group } = await memberActiveInGroup("admin");
        // Signed in again, then in their personal organization (a new sign-in starts where they last were, D36-1 decision 56).
        const personalAccess = await switchTo(await signedIn(account.user.email), account.organization.id);
        await expectNothingDone(
          group.id,
          () => invite(personalAccess, group.id, { email: reserved, role: "contributor" }),
          404,
          "organization_not_found",
          "Organization not found",
        );
      });

      it("refuses a contributor with 403 organization_admin_required", async () => {
        const { group, access } = await memberActiveInGroup("contributor");

        await expectNothingDone(
          group.id,
          () => invite(access, group.id, { email: "someone@example.com", role: "contributor" }),
          403,
          "organization_admin_required",
          "Only an admin of this organization can do that",
        );
      });

      it("answers another organization's id with 404 organization_not_found, even for its admin", async () => {
        const { account, group } = await memberActiveInGroup("admin");
        // The same admin, signed in again and switched to their personal organization (a new sign-in
        // starts where they last were, D36-1 decision 56).
        const access = await switchTo(await signedIn(account.user.email), account.organization.id);

        await expectNothingDone(
          group.id,
          () => invite(access, group.id, { email: "someone@example.com", role: "contributor" }),
          404,
          "organization_not_found",
          "Organization not found",
        );
      });
    });

    it("refuses viewer, which is retired, with 400 invalid_request, storing, auditing and sending nothing (D7 decision 2)", async () => {
      const { group, access } = await memberActiveInGroup("admin");

      const response = await invite(access, group.id, { email: "someone@example.com", role: "viewer" });

      expectRefusal(response, 400, "invalid_request");
      expect(await invitationRows(group.id)).toEqual([]);
      expect(await auditRows("organization_invitation.created")).toEqual([]);
      expect(mailer.sent).toEqual([]);
    });

    it("refuses a malformed address, an unknown role and extra keys with 400", async () => {
      const { group, access } = await memberActiveInGroup("admin");

      for (const payload of [
        { email: "not-an-address", role: "contributor" },
        { email: "someone@example.com", role: "owner" },
        { email: "someone@example.com", role: "contributor", organizationId: group.id },
      ]) {
        expect((await invite(access, group.id, payload)).statusCode).toBe(400);
      }
      expect(await invitationRows(group.id)).toEqual([]);
    });

    it("is 401 unauthenticated without a session", async () => {
      const { group } = await memberActiveInGroup("admin");
      const response = await server.inject({
        method: "POST",
        url: invitationsUrl(group.id),
        headers: csrfHeaders,
        payload: { email: "someone@example.com", role: "contributor" },
      });
      expect(response.statusCode).toBe(401);
    });

    it("answers a failed send with 502 invitation_email_failed, keeps the invitation listed, and audits the failure", async () => {
      const { account, group, access } = await memberActiveInGroup("admin");
      mailer.isFailing = true;

      const response = await invite(access, group.id, { email: "unlucky@example.com", role: "contributor" });

      expectRefusal(response, 502, "invitation_email_failed", MESSAGES.emailFailed);
      const [row] = await invitationRows(group.id);
      expect(row).toMatchObject({ email: "unlucky@example.com", revoked_at: null, accepted_at: null });
      const listed = await list(access, group.id);
      expect(listed.json()).toEqual({
        items: [expect.objectContaining({ id: row!.id, email: "unlucky@example.com" })],
      });
      expect(await invitationAudits()).toEqual([
        "organization_invitation.created",
        "organization_invitation.email_failed",
      ]);
      expect(await auditRows("organization_invitation.email_failed")).toEqual([
        expect.objectContaining({
          actor_user_id: account.user.id,
          organization_id: group.id,
          subject_type: "organization_invitation",
          subject_id: row!.id,
        }),
      ]);
      // The mailer's error is logged on its own; the response carries none of it.
      expect(logLines.some((line) => line.includes("the relay refused the message"))).toBe(true);
      expect(response.body).not.toContain("relay");
    });

    it("rolls back and sends nothing when the transaction fails at its last write", async () => {
      // The audit row is the transaction's last write. If the email went out
      // before the commit, this invitation would be mailed and never exist.
      const { group, access } = await memberActiveInGroup("admin");

      await withFailingInsert(ownerDb, "audit_events", "raise exception 'audit insert refused'", async () => {
        const response = await invite(access, group.id, { email: "doomed@example.com", role: "contributor" });
        expect(response.statusCode).toBe(500);
      });

      expect(await invitationRows(group.id)).toEqual([]);
      expect(mailer.sent).toEqual([]);
    });
  });

  describe("GET /api/v1/organizations/:organizationId/invitations", () => {
    it("lists pending invitations only, newest first, expired ones marked", async () => {
      const { group, access } = await memberActiveInGroup("admin");
      const at = (offset: number) => new Date(clock.getTime() + offset);
      /** A pending invitation invited `invitedAgo` ago; created_at can't be written by the typed builder. */
      const invitedAt = async (email: string, invitedAgo: number, expiresAt: Date, role: OrganizationRole) => {
        const { id } = await addInvitation(ownerDb, { organizationId: group.id, email, role, expires_at: expiresAt });
        await sql`update organization_invitations set created_at = ${at(-invitedAgo)} where id = ${id}`.execute(
          ownerDb,
        );
        return invitationRow(id);
      };
      const oldest = await invitedAt("oldest@example.com", 3 * DAY_MS, at(-DAY_MS), "contributor");
      const expiringNow = await invitedAt("expiring@example.com", 2 * DAY_MS, at(0), "admin");
      const newest = await invitedAt("newest@example.com", DAY_MS, at(DAY_MS), "contributor");
      await addInvitation(ownerDb, { organizationId: group.id, email: "accepted@example.com", accepted_at: at(0) });
      await addInvitation(ownerDb, { organizationId: group.id, email: "revoked@example.com", revoked_at: at(0) });
      const elsewhere = (await memberActiveInGroup("admin")).group;
      await addInvitation(ownerDb, { organizationId: elsewhere.id, email: "elsewhere@example.com" });

      const response = await list(access, group.id);

      expect(response.statusCode).toBe(200);
      const view = (row: typeof oldest, isExpired: boolean) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        invitedAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        isExpired,
      });
      expect(response.json()).toEqual({
        items: [view(newest, false), view(expiringNow, true), view(oldest, true)],
      });
    });

    it("refuses a contributor with 403, and another organization's id with 404", async () => {
      const contributor = await memberActiveInGroup("contributor");
      expectRefusal(await list(contributor.access, contributor.group.id), 403, "organization_admin_required");
      const admin = await memberActiveInGroup("admin");
      expectRefusal(await list(admin.access, contributor.group.id), 404, "organization_not_found");
    });
  });

  describe("POST /api/v1/organizations/:organizationId/invitations/:invitationId/deliveries", () => {
    it("issues a new token and expiry, audits the resend, and emails the new link", async () => {
      const { admin, group, invitation, token } = await invited("resend-me@example.com");
      const before = await invitationRow(invitation.id);
      // A minute on: well inside the access token's lifetime.
      clock = new Date(clock.getTime() + 60_000);
      mailer.sent.length = 0;

      const response = await resend(admin.access, group.id, invitation.id);

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        invitation: {
          id: invitation.id,
          email: "resend-me@example.com",
          role: "contributor",
          invitedAt: before.created_at.toISOString(),
          expiresAt: new Date(clock.getTime() + INVITATION_TTL_MS).toISOString(),
          isExpired: false,
        },
      });
      const after = await invitationRow(invitation.id);
      expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime());
      expect(mailer.sent).toHaveLength(1);
      const newToken = tokenFrom(mailer.sent[0]!);
      expect(newToken).not.toBe(token);
      expect(after.token_hash).toBe(hashToken(newToken));
      const oldHash = hashToken(token);
      const withOldHash = await ownerDb
        .selectFrom("organization_invitations")
        .select("id")
        .where("token_hash", "=", oldHash)
        .execute();
      expect(withOldHash).toEqual([]);
      expect(await auditRows("organization_invitation.resent")).toEqual([
        expect.objectContaining({
          actor_user_id: admin.account.user.id,
          organization_id: group.id,
          subject_type: "organization_invitation",
          subject_id: invitation.id,
        }),
      ]);
    });

    it("revives an expired invitation", async () => {
      const { group, access } = await memberActiveInGroup("admin");
      const expired = await addInvitation(ownerDb, {
        organizationId: group.id,
        expires_at: new Date(clock.getTime() - DAY_MS),
      });

      const response = await resend(access, group.id, expired.id);

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ invitation: { id: expired.id, isExpired: false } });
      const listed = await list(access, group.id);
      expect(listed.json()).toEqual({ items: [expect.objectContaining({ id: expired.id, isExpired: false })] });
    });

    it.each([
      ["a cancelled", { revoked_at: new Date() }],
      ["an accepted", { accepted_at: new Date() }],
    ])("answers %s invitation with 404 invitation_not_found, sending nothing", async (_label, state) => {
      const { group, access } = await memberActiveInGroup("admin");
      const done = await addInvitation(ownerDb, { organizationId: group.id, ...state });

      expectRefusal(await resend(access, group.id, done.id), 404, "invitation_not_found", MESSAGES.notFound);
      expect(await invitationRow(done.id)).toEqual(done);
      expect(mailer.sent).toEqual([]);
      expect(await invitationAudits()).toEqual([]);
    });

    it("answers an unknown id, a malformed one and another organization's invitation with 404", async () => {
      const { group, access } = await memberActiveInGroup("admin");
      const elsewhere = (await memberActiveInGroup("admin")).group;
      const theirs = await addInvitation(ownerDb, { organizationId: elsewhere.id });

      for (const id of [randomUUID(), "not-a-uuid", theirs.id.replaceAll("-", ""), theirs.id]) {
        expectRefusal(await resend(access, group.id, id), 404, "invitation_not_found", MESSAGES.notFound);
      }
      expect(mailer.sent).toEqual([]);
    });

    it("refuses a contributor with 403", async () => {
      const admin = await memberActiveInGroup("admin");
      const contributor = await memberActiveInGroup("contributor", admin.group.id);
      const pending = await addInvitation(ownerDb, { organizationId: admin.group.id });

      expectRefusal(await resend(contributor.access, admin.group.id, pending.id), 403, "organization_admin_required");
      expect(mailer.sent).toEqual([]);
    });

    it("answers a failed send with 502 and audits it; the new token stands", async () => {
      const { admin, group, invitation } = await invited();
      mailer.isFailing = true;

      expectRefusal(
        await resend(admin.access, group.id, invitation.id),
        502,
        "invitation_email_failed",
        MESSAGES.resentEmailFailed,
      );
      expect(await invitationAudits()).toEqual([
        "organization_invitation.created",
        "organization_invitation.resent",
        "organization_invitation.email_failed",
      ]);
    });
  });

  describe("DELETE /api/v1/organizations/:organizationId/invitations/:invitationId", () => {
    it("cancels a pending invitation, audits it, and takes it off the list; a second cancel is 404", async () => {
      const { admin, group, invitation } = await invited();

      const response = await cancel(admin.access, group.id, invitation.id);

      expect(response.statusCode).toBe(204);
      expect(await invitationRow(invitation.id)).toMatchObject({ revoked_at: clock, accepted_at: null });
      expect(await auditRows("organization_invitation.revoked")).toEqual([
        expect.objectContaining({
          actor_user_id: admin.account.user.id,
          organization_id: group.id,
          subject_type: "organization_invitation",
          subject_id: invitation.id,
        }),
      ]);
      expect((await list(admin.access, group.id)).json()).toEqual({ items: [] });
      expectRefusal(
        await cancel(admin.access, group.id, invitation.id),
        404,
        "invitation_not_found",
        MESSAGES.notFound,
      );
    });

    it("answers an accepted invitation, an unknown id and a contributor as resend does", async () => {
      const admin = await memberActiveInGroup("admin");
      const contributor = await memberActiveInGroup("contributor", admin.group.id);
      const accepted = await addInvitation(ownerDb, { organizationId: admin.group.id, accepted_at: new Date() });
      const pending = await addInvitation(ownerDb, { organizationId: admin.group.id });

      expectRefusal(await cancel(admin.access, admin.group.id, accepted.id), 404, "invitation_not_found");
      expectRefusal(await cancel(admin.access, admin.group.id, "not-a-uuid"), 404, "invitation_not_found");
      expectRefusal(await cancel(contributor.access, admin.group.id, pending.id), 403, "organization_admin_required");
      expect(await invitationRow(pending.id)).toEqual(pending);
      expect(await invitationRow(accepted.id)).toEqual(accepted);
    });

    it("answers another organization's invitation with 404, leaving it pending", async () => {
      const { group, access } = await memberActiveInGroup("admin");
      const elsewhere = (await memberActiveInGroup("admin")).group;
      const theirs = await addInvitation(ownerDb, { organizationId: elsewhere.id });

      expectRefusal(await cancel(access, group.id, theirs.id), 404, "invitation_not_found", MESSAGES.notFound);
      expect(await invitationRow(theirs.id)).toEqual(theirs);
      expect(await invitationAudits()).toEqual([]);
    });
  });

  describe("POST /api/v1/invitation-previews", () => {
    it.each([
      ["pending", {}],
      ["expired", { expires_at: new Date(Date.now() - DAY_MS) }],
      ["accepted", { accepted_at: new Date() }],
    ] as const)("shows a %s invitation, without a session, auditing nothing", async (status, state) => {
      const { group, invitation, token } = await pendingInvitation({ role: "contributor", ...state });

      const response = await preview(token);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        invitation: {
          organizationName: group.name,
          organizationType: "group",
          email: invitation.email,
          role: "contributor",
          status,
          hasAccount: false,
          mayRegister: true,
        },
      });
      expect(await auditTrail(group.id)).toEqual([]);
    });

    it("marks an invitation expired from the API's clock, at its last moment", async () => {
      const { token } = await pendingInvitation({ expires_at: clock });
      expect((await preview(token)).json()).toMatchObject({ invitation: { status: "expired" } });
    });

    it("says whether an account holds the address: a live one, a soft-deleted one, or none", async () => {
      const live = await verifiedUser();
      const deleted = await verifiedUser();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", deleted.user.id).execute();

      for (const [email, hasAccount] of [
        [live.user.email, true],
        [deleted.user.email, true],
        [`nobody-${randomUUID()}@example.com`, false],
      ] as const) {
        const { token } = await pendingInvitation({ email });
        expect((await preview(token)).json()).toMatchObject({ invitation: { email, hasAccount } });
      }
    });

    /**
     * D22 decision 22: the preview's lookup matches people only. An
     * invitation written by the owner, as one from before D22 could be
     * (inviting now refuses the domain), to a service account's address
     * reads as no account.
     */
    it("carries the organization's type: personal for a person's own organization, group for a group (D36-1 Q264)", async () => {
      const { organization: personal } = await verifiedUser();
      const token = randomBytes(32).toString("base64url");
      await addInvitation(ownerDb, {
        organizationId: personal.id,
        token_hash: hashToken(token),
        expires_at: new Date(clock.getTime() + INVITATION_TTL_MS),
      });
      expect((await preview(token)).json()).toMatchObject({
        invitation: { organizationName: personal.name, organizationType: "personal" },
      });

      const { group, token: groupToken } = await pendingInvitation();
      expect((await preview(groupToken)).json()).toMatchObject({
        invitation: { organizationName: group.name, organizationType: "group" },
      });
    });

    it("hasAccount is false for an invitation to a service account's address", async () => {
      const { organization } = await verifiedUser();
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: organization.id });
      const { token } = await pendingInvitation({ email: serviceAccount.email });

      expect((await preview(token)).json()).toMatchObject({
        invitation: { email: serviceAccount.email, hasAccount: false },
      });
    });

    it("hasAccount is true for an invitation to a human's address, beside it", async () => {
      const human = await verifiedUser();
      const { token } = await pendingInvitation({ email: human.user.email });

      expect((await preview(token)).json()).toMatchObject({ invitation: { email: human.user.email, hasAccount: true } });
    });

    it("answers an unknown, a cancelled and a superseded token, and a deleted organization, with 404", async () => {
      const revoked = await pendingInvitation({ revoked_at: new Date() });
      const inDeleted = await pendingInvitation();
      await ownerDb
        .updateTable("organizations")
        .set({ deleted_at: new Date() })
        .where("id", "=", inDeleted.group.id)
        .execute();
      const { admin, group, invitation, token: superseded } = await invited();
      expect((await resend(admin.access, group.id, invitation.id)).statusCode).toBe(201);
      const current = tokenFrom(mailer.sent.at(-1)!);

      for (const token of [randomBytes(32).toString("base64url"), revoked.token, superseded, inDeleted.token]) {
        expectRefusal(await preview(token), 404, "invitation_not_found", MESSAGES.invalidLink);
      }
      // The resend's own token still works.
      expect((await preview(current)).statusCode).toBe(200);
    });

    it("refuses a missing, an empty and an overlong token, and extra keys, with 400", async () => {
      for (const payload of [{}, { token: "" }, { token: "t".repeat(513) }, { token: "t", email: "a@example.com" }]) {
        const response = await server.inject({
          method: "POST",
          url: "/api/v1/invitation-previews",
          headers: csrfHeaders,
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe("POST /api/v1/invitation-acceptances", () => {
    it("answers with the organization's logo id, accepting and registering alike (D23-2 decision 40)", async () => {
      const logoId = "0199e000-0000-7000-8000-00000000b001";
      const { access, group, token } = await invitedAccount("contributor");
      await ownerDb
        .updateTable("organizations")
        .set({ logo_id: logoId, logo_content_type: "image/png" })
        .where("id", "=", group.id)
        .execute();

      const accepted = await accept(access, token);
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json<{ organization: { logoId: unknown } }>().organization.logoId).toBe(logoId);

      const email = `newcomer-${randomUUID()}@example.com`;
      const pending = await pendingInvitation({ email, role: "contributor" });
      await ownerDb
        .updateTable("organizations")
        .set({ logo_id: logoId, logo_content_type: "image/png" })
        .where("id", "=", pending.group.id)
        .execute();
      const registered = await register(pending.token);
      expect(registered.statusCode).toBe(201);
      expect(registered.json<{ organization: { logoId: unknown } }>().organization.logoId).toBe(logoId);
    });

    it("joins in the invitation's role, marks it accepted, audits, and switches the session", async () => {
      const { account, access, group, invitation, token } = await invitedAccount("contributor");

      const response = await accept(access, token);

      expect(response.statusCode).toBe(200);
      const organization = { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" };
      expect(response.json()).toEqual({ organization });
      expect(await membership(account.user.id, group.id)).toMatchObject({ role: "contributor", deleted_at: null });
      expect(await invitationRow(invitation.id)).toMatchObject({
        accepted_at: clock,
        accepted_by_user_id: account.user.id,
        revoked_at: null,
      });
      expect(await auditTrail(group.id)).toEqual([
        "organization_invitation.accepted:organization_invitation",
        "organization_member.added:user",
        "session.organization_switched:session",
      ]);
      expect(await auditRows("organization_member.added")).toEqual([
        expect.objectContaining({
          actor_user_id: account.user.id,
          actor_email: account.user.email,
          organization_id: group.id,
          subject_id: account.user.id,
          metadata: { role: "contributor", invitationId: invitation.id },
        }),
      ]);
      expect(await auditRows("organization_invitation.accepted")).toEqual([
        expect.objectContaining({ actor_user_id: account.user.id, subject_id: invitation.id, metadata: {} }),
      ]);

      // A new access token for the organization; the session row names it.
      const switched = cookieValue(response, "telflo_access");
      expect(switched).not.toBe(access);
      expect((await me(switched)).json()).toMatchObject({ organization });
      expect(await sessionOf(account.user.id)).toMatchObject({ active_organization_id: group.id });
      expect(mailer.sent).toEqual([]);
      // An existing account joins with no starter configuration, here or in
      // its personal organization (D8 decision 10).
      expect(await ownerDb.selectFrom("configurations").selectAll().execute()).toEqual([]);
      expect(await ownerDb.selectFrom("configuration_versions").selectAll().execute()).toEqual([]);
    });

    describe("decision 9's refusals, each changing nothing", () => {
      /** Asserts the refusal, and that no membership, audit row or session move came of it. */
      const expectNothingJoined = async (
        setup: Awaited<ReturnType<typeof invitedAccount>>,
        token: string,
        statusCode: number,
        code: string,
        message: string,
      ) => {
        const before = await invitationRow(setup.invitation.id);
        const response = await accept(setup.access, token);
        expectRefusal(response, statusCode, code, message);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(await membership(setup.account.user.id, setup.group.id)).toBeUndefined();
        expect(await invitationRow(setup.invitation.id)).toEqual(before);
        expect(await auditTrail(setup.group.id)).toEqual([]);
        expect(await sessionOf(setup.account.user.id)).toMatchObject({
          active_organization_id: setup.account.organization.id,
        });
      };

      it("answers an unknown token with 404", async () => {
        const setup = await invitedAccount();
        const unknown = randomBytes(32).toString("base64url");
        await expectNothingJoined(setup, unknown, 404, "invitation_not_found", MESSAGES.invalidLink);
      });

      it("answers a cancelled invitation with 404", async () => {
        const setup = await invitedAccount();
        await ownerDb
          .updateTable("organization_invitations")
          .set({ revoked_at: new Date() })
          .where("id", "=", setup.invitation.id)
          .execute();
        await expectNothingJoined(setup, setup.token, 404, "invitation_not_found", MESSAGES.invalidLink);
      });

      it("answers a superseded token (the invitation resent since) with 404", async () => {
        const setup = await invitedAccount();
        await ownerDb
          .updateTable("organization_invitations")
          .set({ token_hash: hashToken(randomBytes(32).toString("base64url")) })
          .where("id", "=", setup.invitation.id)
          .execute();
        await expectNothingJoined(setup, setup.token, 404, "invitation_not_found", MESSAGES.invalidLink);
      });

      it("answers an invitation to a deleted organization with 404", async () => {
        const setup = await invitedAccount();
        await ownerDb
          .updateTable("organizations")
          .set({ deleted_at: new Date() })
          .where("id", "=", setup.group.id)
          .execute();
        await expectNothingJoined(setup, setup.token, 404, "invitation_not_found", MESSAGES.invalidLink);
      });

      it("answers an expired invitation with 410, from its last moment on", async () => {
        const setup = await invitedAccount();
        await ownerDb
          .updateTable("organization_invitations")
          .set({ expires_at: clock })
          .where("id", "=", setup.invitation.id)
          .execute();
        await expectNothingJoined(setup, setup.token, 410, "invitation_expired", MESSAGES.expired);
      });

      it("answers an accepted invitation with 409", async () => {
        const setup = await invitedAccount();
        await ownerDb
          .updateTable("organization_invitations")
          .set({ accepted_at: new Date() })
          .where("id", "=", setup.invitation.id)
          .execute();
        await expectNothingJoined(
          setup,
          setup.token,
          409,
          "invitation_already_accepted",
          MESSAGES.alreadyAccepted,
        );
      });

      it("answers another address with 403, naming the invited one (decision 3)", async () => {
        const setup = await invitedAccount();
        const other = await pendingInvitation();
        // The account's session, but another address's invitation, in another organization.
        const mismatched = { ...setup, group: other.group, invitation: other.invitation };
        await expectNothingJoined(
          mismatched,
          other.token,
          403,
          "invitation_email_mismatch",
          MESSAGES.mismatch(other.invitation.email),
        );
      });
    });

    it("compares the addresses ignoring case", async () => {
      const { account, access, group, token } = await invitedAccount();
      await ownerDb
        .updateTable("users")
        .set({ email: account.user.email.toUpperCase() })
        .where("id", "=", account.user.id)
        .execute();

      expect((await accept(access, token)).statusCode).toBe(200);
      expect(await membership(account.user.id, group.id)).toBeDefined();
    });

    it("only marks the invitation accepted for an active member, whose role stays theirs", async () => {
      const { account, access, group, invitation, token } = await invitedAccount("admin");
      await addMembership(ownerDb, { userId: account.user.id, organizationId: group.id, role: "contributor" });

      const response = await accept(access, token);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ organization: { id: group.id, role: "contributor" } });
      expect(await membership(account.user.id, group.id)).toMatchObject({ role: "contributor", deleted_at: null });
      expect(await invitationRow(invitation.id)).toMatchObject({ accepted_by_user_id: account.user.id });
      expect(await auditTrail(group.id)).toEqual([
        "organization_invitation.accepted:organization_invitation",
        "session.organization_switched:session",
      ]);
    });

    it("refuses a removed member with 409 member_removed, leaving the invitation pending", async () => {
      const { account, access, group, invitation, token } = await invitedAccount();
      await addMembership(ownerDb, { userId: account.user.id, organizationId: group.id });
      await removeMembership(ownerDb, { userId: account.user.id, organizationId: group.id });

      expectRefusal(await accept(access, token), 409, "member_removed", MESSAGES.removedInvitee);
      expect(await membership(account.user.id, group.id)).toMatchObject({ deleted_at: expect.any(Date) });
      expect(await invitationRow(invitation.id)).toEqual(invitation);
      expect(await auditTrail(group.id)).toEqual([]);
    });

    it("is 401 unauthenticated when signed out", async () => {
      const { invitation, token } = await pendingInvitation();
      expectRefusal(await accept(undefined, token), 401, "unauthenticated");
      expect(await invitationRow(invitation.id)).toEqual(invitation);
    });

    it("lets an account with no password (a Google sign-up) accept like any other", async () => {
      const { account, access, group, token } = await invitedAccount();
      await ownerDb
        .updateTable("users")
        .set({ password_hash: null, accepted_terms_version: null, terms_accepted_at: null })
        .where("id", "=", account.user.id)
        .execute();

      expect((await accept(access, token)).statusCode).toBe(200);
      expect(await membership(account.user.id, group.id)).toMatchObject({ role: "contributor" });
    });
  });

  describe("POST /api/v1/invitation-registrations", () => {
    it("the invitation registration sets dark: telflo_theme with the session cookies, no settings row read or made (D21 decision 23)", async () => {
      const email = `newcomer-${randomUUID()}@example.com`;
      const { token } = await pendingInvitation({ email, role: "contributor" });

      const response = await register(token);

      expect(response.statusCode).toBe(201);
      const header = response.headers["set-cookie"];
      const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
      expect(lines.map((line) => line.slice(0, line.indexOf("=")))).toEqual(["telflo_access", "telflo_refresh", "telflo_theme"]);
      expect(lines[2]).toBe(
        `telflo_theme=dark; Max-Age=31536000; Path=/; HttpOnly; ${settings.isCookieSecure ? "Secure; " : ""}SameSite=Lax`,
      );
      expect(await ownerDb.selectFrom("user_settings").selectAll().execute()).toEqual([]);
    });

    it("creates a verified account, joins it, accepts the invitation, audits, and signs it in there", async () => {
      const email = `newcomer-${randomUUID()}@example.com`;
      const { group, invitation, token } = await pendingInvitation({ email, role: "contributor" });

      const response = await register(token);

      expect(response.statusCode).toBe(201);
      const organization = { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" };
      expect(response.json()).toEqual({ organization });

      const [user] = await usersWithEmail(email);
      expect(user).toMatchObject({
        email_verified_at: clock,
        accepted_terms_version: TEST_TERMS_VERSION,
        terms_accepted_at: clock,
        deleted_at: null,
      });
      expect(await verifyPassword(user!.password_hash!, PASSWORD)).toBe(true);
      const personal = await ownerDb
        .selectFrom("organizations")
        .selectAll()
        .where("owner_user_id", "=", user!.id)
        .executeTakeFirstOrThrow();
      expect(personal).toMatchObject({ type: "personal", name: email });
      expect(await membership(user!.id, personal.id)).toMatchObject({ role: "admin", deleted_at: null });
      expect(await membership(user!.id, group.id)).toMatchObject({ role: "contributor", deleted_at: null });
      expect(await invitationRow(invitation.id)).toMatchObject({ accepted_at: clock, accepted_by_user_id: user!.id });

      expect(await auditTrail(personal.id)).toEqual([
        "user.registered:user",
        "organization.created:organization",
        "organization_member.added:organization_member",
        "configuration.created:configuration",
      ]);
      expect(await auditTrail(group.id)).toEqual([
        "organization_invitation.accepted:organization_invitation",
        "organization_member.added:user",
        "user.signed_in:session",
      ]);
      expect(await auditRows("user.registered")).toEqual([
        expect.objectContaining({
          actor_user_id: user!.id,
          metadata: { via: "invitation", acceptedTermsVersion: TEST_TERMS_VERSION },
        }),
      ]);
      expect(
        (await auditRows("organization_member.added")).filter((row) => row.organization_id === group.id),
      ).toEqual([
        expect.objectContaining({
          actor_user_id: user!.id,
          subject_id: user!.id,
          metadata: { role: "contributor", invitationId: invitation.id },
        }),
      ]);

      // The starter configuration (D8 decision 10): in the invitee's own
      // personal organization, and none in the inviting one,
      // at the catalogue's default distribution and version (D13a decision 9).
      const pin = await catalogueDefaults(ownerDb);
      const configurations = await configurationsIn(personal.id);
      expect(configurations).toEqual([
        expect.objectContaining({
          name: STARTER_CONFIGURATION_NAME,
          description: STARTER_CONFIGURATION_DESCRIPTION,
          created_by_user_id: user!.id,
          created_at: clock,
          updated_at: clock,
          deleted_at: null,
          collector_distribution: pin.distribution,
        }),
      ]);
      expect(await versionsIn(personal.id)).toEqual([
        expect.objectContaining({
          configuration_id: configurations[0]!.id,
          version_number: 1,
          yaml_content: STARTER_CONFIGURATION_YAML,
          created_by_user_id: user!.id,
          created_at: clock,
          updated_at: clock,
          collector_distribution: pin.distribution,
          collector_version: pin.version,
        }),
      ]);
      expect(await configurationsIn(group.id)).toEqual([]);
      expect(await versionsIn(group.id)).toEqual([]);
      expect(await auditRows("configuration.created")).toEqual([
        expect.objectContaining({
          actor_user_id: user!.id,
          actor_email: email,
          organization_id: personal.id,
          subject_id: configurations[0]!.id,
          metadata: { name: STARTER_CONFIGURATION_NAME },
          ip_address: expect.any(String),
          user_agent: expect.any(String),
        }),
      ]);

      // Signed in, in the inviting organization, with both organizations listed.
      cookieValue(response, "telflo_refresh");
      const access = cookieValue(response, "telflo_access");
      expect((await me(access)).json()).toEqual({
        user: { id: user!.id, email },
        organization,
        organizations: [
          { id: personal.id, name: personal.name, type: "personal", logoId: null, role: "admin" },
          organization,
        ],
        termsAcceptanceRequired: false,
        isProductAdmin: false,
        mayCreateOrganizations: true,
        preferences: DEFAULT_USER_PREFERENCES,
      });
      expect(await sessionOf(user!.id)).toMatchObject({ active_organization_id: group.id });
      // The token proved the mailbox: no confirmation email.
      expect(mailer.sent).toEqual([]);
    });

    describe("refusals, each leaving no account behind", () => {
      /** Asserts the refusal, and that the address still has only the accounts it had. */
      const expectNoAccount = async (
        email: string,
        response: LightMyRequestResponse,
        statusCode: number,
        code: string,
        message?: string,
      ) => {
        const before = await usersWithEmail(email);
        expectRefusal(response, statusCode, code, message);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(await usersWithEmail(email)).toEqual(before);
        expect(mailer.sent).toEqual([]);
      };

      it("answers an unknown token and a cancelled invitation with 404", async () => {
        const { invitation, token } = await pendingInvitation({ revoked_at: new Date() });
        await expectNoAccount(
          invitation.email,
          await register(token),
          404,
          "invitation_not_found",
          MESSAGES.invalidLink,
        );
        const unknown = await register(randomBytes(32).toString("base64url"));
        expectRefusal(unknown, 404, "invitation_not_found", MESSAGES.invalidLink);
      });

      it("answers an expired invitation with 410", async () => {
        const { invitation, token } = await pendingInvitation({ expires_at: clock });
        await expectNoAccount(invitation.email, await register(token), 410, "invitation_expired", MESSAGES.expired);
      });

      it("answers an accepted invitation with 409", async () => {
        const { invitation, token } = await pendingInvitation({ accepted_at: new Date() });
        await expectNoAccount(
          invitation.email,
          await register(token),
          409,
          "invitation_already_accepted",
          MESSAGES.alreadyAccepted,
        );
      });

      it.each(["live", "soft-deleted"])("answers an address a %s account holds with 409 account_exists", async (state) => {
        const existing = await verifiedUser();
        if (state === "soft-deleted") {
          await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", existing.user.id).execute();
        }
        const { invitation, token } = await pendingInvitation({ email: existing.user.email });

        await expectNoAccount(
          existing.user.email,
          await register(token),
          409,
          "account_exists",
          MESSAGES.accountExists,
        );
        expect(await invitationRow(invitation.id)).toEqual(invitation);
      });

      /**
       * D22 decision 23, Preflight ruling 13: after the token's lookup,
       * before the invitation's other refusals and the lookup by email.
       * Invitations written by the owner, as ones from before D22 could
       * be: one to a service account's address (without the refusal, the
       * human-only lookup finds no account and the insert is refused by
       * the database), one nobody holds, an expired one, which is still
       * 422, not 410, and an accepted one, still 422, not 409.
       */
      it("refuses an invitation to the reserved domain with 422 email_reserved", async () => {
        const { organization } = await verifiedUser();
        const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: organization.id });

        for (const overrides of [
          { email: serviceAccount.email },
          { email: `nobody-${randomUUID().slice(0, 8)}@service-accounts.telflo.invalid` },
          { email: `expired-${randomUUID().slice(0, 8)}@service-accounts.telflo.invalid`, expires_at: clock },
          { email: `accepted-${randomUUID().slice(0, 8)}@service-accounts.telflo.invalid`, accepted_at: new Date() },
        ]) {
          const { invitation, token } = await pendingInvitation(overrides);
          await expectNoAccount(invitation.email, await register(token), 422, "email_reserved", "This address can't be used");
          expect(await invitationRow(invitation.id)).toEqual(invitation);
        }
        const atTheDomain = await ownerDb
          .selectFrom("users")
          .selectAll()
          .where("email", "like", "%@service-accounts.telflo.invalid")
          .execute();
        expect(atTheDomain).toEqual([serviceAccount]);
        expect(await ownerDb.selectFrom("sessions").selectAll().where("user_id", "=", serviceAccount.id).execute()).toEqual(
          [],
        );
        expect(await auditRows("user.registered")).toEqual([]);
      });

      it("refuses an invitation to the deleted accounts' domain with 422 email_reserved, and creates no account (D29 decision 10, Preflight ruling 6)", async () => {
        for (const overrides of [
          { email: `deleted-${"0c".repeat(12)}@deleted-accounts.telflo.invalid` },
          { email: `expired-${randomUUID().slice(0, 8)}@deleted-accounts.telflo.invalid`, expires_at: clock },
        ]) {
          const { invitation, token } = await pendingInvitation(overrides);
          await expectNoAccount(invitation.email, await register(token), 422, "email_reserved", "This address can't be used");
          expect(await invitationRow(invitation.id)).toEqual(invitation);
        }
        const atTheDomain = await ownerDb.selectFrom("users").select("id").where("email", "like", "%@deleted-accounts.telflo.invalid").execute();
        expect(atTheDomain).toEqual([]);
        expect(await auditRows("user.registered")).toEqual([]);
      });

      it("a human's existing address is still 409 account_exists, beside it", async () => {
        const existing = await verifiedUser();
        const { invitation, token } = await pendingInvitation({ email: existing.user.email });

        await expectNoAccount(existing.user.email, await register(token), 409, "account_exists", MESSAGES.accountExists);
        expect(await invitationRow(invitation.id)).toEqual(invitation);
      });

      it("refuses an old terms version and a short password with 400", async () => {
        const { invitation, token } = await pendingInvitation();
        await expectNoAccount(
          invitation.email,
          await register(token, { acceptedTermsVersion: "2020-01-01" }),
          400,
          "terms_version_not_current",
        );
        await expectNoAccount(invitation.email, await register(token, { password: "short" }), 400, "invalid_request");
        expect(await invitationRow(invitation.id)).toEqual(invitation);
      });

      it("refuses an address in the body with 400: the address is the invitation's", async () => {
        const { invitation, token } = await pendingInvitation();
        await expectNoAccount(
          invitation.email,
          await register(token, { email: `someone-${randomUUID()}@example.com` }),
          400,
          "invalid_request",
        );
      });
    });
  });

  describe("the site's registration mode (D36-1 decision 35, Preflight ruling 4)", () => {
    const servers: FastifyInstance[] = [];
    const modeServer = async (registration: AppSettings["site"]["registration"]) => {
      const built = serverWith({ site: { registration } });
      servers.push(built);
      await built.ready();
      return built;
    };
    afterAll(async () => {
      await Promise.all(servers.map((each) => each.close()));
    });

    /** What a refused registration must leave as it was. */
    const everything = async () => ({
      users: await ownerDb.selectFrom("users").selectAll().orderBy("id").execute(),
      invitations: await ownerDb.selectFrom("organization_invitations").selectAll().orderBy("id").execute(),
      members: await ownerDb.selectFrom("organization_members").selectAll().orderBy("id").execute(),
      audits: await ownerDb.selectFrom("audit_events").selectAll().orderBy("id").execute(),
      sessions: await ownerDb.selectFrom("sessions").selectAll().orderBy("id").execute(),
    });

    for (const registration of ["open", "invite-only"] as const) {
      it(`${registration}: registering from an invitation makes the account and joins it`, async () => {
        const on = await modeServer(registration);
        const email = `newcomer-${randomUUID()}@example.com`;
        const { group, token } = await pendingInvitation({ email, role: "contributor" });

        const response = await register(token, {}, on);

        expect(response.statusCode).toBe(201);
        const [user] = await usersWithEmail(email);
        expect(await membership(user!.id, group.id)).toMatchObject({ role: "contributor", deleted_at: null });
      });
    }

    it("closed: registering from an invitation is refused 403 registration_not_open in fixed words, before the body is read, leaving everything as it was", async () => {
      const on = await modeServer("closed");
      const email = `newcomer-${randomUUID()}@example.com`;
      const { token } = await pendingInvitation({ email, role: "contributor" });
      const before = await everything();
      const refusal = { error: { code: "registration_not_open", message: "This site isn't accepting new accounts." } };

      const valid = await register(token, {}, on);
      expect(valid.statusCode).toBe(403);
      expect(valid.json()).toEqual(refusal);
      // A body validation would refuse with 400 is refused the same way: the gate runs before it.
      for (const payload of [{}, { token, password: "short" }, "not json"]) {
        const response = await on.inject({
          method: "POST",
          url: "/api/v1/invitation-registrations",
          headers: { ...csrfHeaders, "content-type": "application/json" },
          payload: typeof payload === "string" ? payload : JSON.stringify(payload),
        });
        expect({ status: response.statusCode, body: response.json() }).toEqual({ status: 403, body: refusal });
      }
      // The global CSRF guard still runs first.
      const noCsrf = await on.inject({ method: "POST", url: "/api/v1/invitation-registrations", payload: { token, password: PASSWORD } });
      expect(noCsrf.statusCode).toBe(403);
      expect(noCsrf.json()).toMatchObject({ error: { code: "csrf_header_missing" } });
      expect(await everything()).toEqual(before);
      expect(mailer.sent).toEqual([]);
    });

    // D36-1 decision 52 (Q252): under invite-only, a personal organization's
    // invitation makes no account; an existing account still accepts it.

    /** A pending invitation from a person's own personal organization, with a token the test knows. */
    const personalInvitation = async (email = `newcomer-${randomUUID()}@example.com`) => {
      const inviter = await verifiedUser();
      const token = randomBytes(32).toString("base64url");
      const invitation = await addInvitation(ownerDb, {
        organizationId: inviter.organization.id,
        email,
        token_hash: hashToken(token),
        expires_at: new Date(clock.getTime() + INVITATION_TTL_MS),
      });
      return { inviter, personal: inviter.organization, invitation, token };
    };

    const personalRefusal = {
      error: {
        code: "registration_not_open",
        message: "This invitation can't create a new account. Sign in with an existing account to accept it.",
      },
    };

    it("invite-only: a leftover invitation from a personal organization (sent while the site was open) can't make an account: 403 registration_not_open in fixed words, leaving everything as it was", async () => {
      const on = await modeServer("invite-only");
      const email = `stranger-${randomUUID()}@example.com`;
      const { token } = await personalInvitation(email);
      const before = await everything();

      const response = await register(token, {}, on);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(personalRefusal);
      expect(await everything()).toEqual(before);
      expect(await usersWithEmail(email)).toEqual([]);
    });

    // D36-1 decision 57 (Q268): while registration isn't open, a personal
    // organization sends no invitation at all; a group organization's admins
    // still invite, and leftover invitations can still be listed and revoked.

    const personalInvitationsRefusal = {
      error: {
        code: "personal_organization_invitations_disabled",
        message: "Invitations can't be sent from a personal workspace on this site.",
      },
    };

    for (const registration of ["invite-only", "closed"] as const) {
      it(`${registration}: an invite from a personal organization is refused 403 personal_organization_invitations_disabled in fixed words: no row, no audit, no mail`, async () => {
        const on = await modeServer(registration);
        const account = await verifiedUser();
        const access = await signedIn(account.user.email, on);
        const before = await everything();

        const response = await invite(access, account.organization.id, { email: `stranger-${randomUUID()}@example.com`, role: "contributor" }, on);

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual(personalInvitationsRefusal);
        expect(await invitationRows(account.organization.id)).toEqual([]);
        expect(await everything()).toEqual(before);
        expect(mailer.sent).toEqual([]);
      });
    }

    it("invite-only: a leftover personal invitation's resend is refused the same way, its token unchanged; it can still be listed and revoked", async () => {
      const on = await modeServer("invite-only");
      const account = await verifiedUser();
      const access = await signedIn(account.user.email, on);
      const token = randomBytes(32).toString("base64url");
      const leftover = await addInvitation(ownerDb, {
        organizationId: account.organization.id,
        token_hash: hashToken(token),
        expires_at: new Date(clock.getTime() + INVITATION_TTL_MS),
      });
      const before = await everything();

      const resent = await resend(access, account.organization.id, leftover.id, on);
      expect(resent.statusCode).toBe(403);
      expect(resent.json()).toEqual(personalInvitationsRefusal);
      expect(await everything()).toEqual(before);
      expect(mailer.sent).toEqual([]);

      const listed = await list(access, account.organization.id, on);
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ items: Array<{ id: string }> }>().items.map(({ id }) => id)).toEqual([leftover.id]);
      expect((await cancel(access, account.organization.id, leftover.id, on)).statusCode).toBe(204);
      expect((await invitationRow(leftover.id)).revoked_at).not.toBeNull();
      expect(await invitationAudits()).toEqual(["organization_invitation.revoked"]);
    });

    for (const registration of ["invite-only", "closed"] as const) {
      it(`${registration}: a group organization's admin still invites, 201`, async () => {
        const on = await modeServer(registration);
        const admin = await memberActiveInGroup("admin", undefined, on);
        const email = `newcomer-${randomUUID()}@example.com`;

        const response = await invite(admin.access, admin.group.id, { email, role: "contributor" }, on);

        expect(response.statusCode).toBe(201);
        expect(mailer.sent.map((message) => message.to)).toEqual([email]);
      });
    }

    it("open: an invite from a personal organization is sent, 201", async () => {
      const on = await modeServer("open");
      const account = await verifiedUser();
      const access = await signedIn(account.user.email, on);
      const email = `friend-${randomUUID()}@example.com`;

      const response = await invite(access, account.organization.id, { email, role: "contributor" }, on);

      expect(response.statusCode).toBe(201);
      expect(mailer.sent.map((message) => message.to)).toEqual([email]);
    });

    it("invite-only: the preview says a personal organization's invitation can't register and a group organization's can; open says both can, closed neither", async () => {
      const personal = await personalInvitation();
      const group = await pendingInvitation();
      const mayRegister = async (on: FastifyInstance, token: string) =>
        (await preview(token, on)).json<{ invitation: { mayRegister: boolean } }>().invitation.mayRegister;
      const inviteOnly = await modeServer("invite-only");
      expect({ personal: await mayRegister(inviteOnly, personal.token), group: await mayRegister(inviteOnly, group.token) }).toEqual({
        personal: false,
        group: true,
      });
      const open = await modeServer("open");
      expect({ personal: await mayRegister(open, personal.token), group: await mayRegister(open, group.token) }).toEqual({
        personal: true,
        group: true,
      });
      const closed = await modeServer("closed");
      expect({ personal: await mayRegister(closed, personal.token), group: await mayRegister(closed, group.token) }).toEqual({
        personal: false,
        group: false,
      });
    });

    it("invite-only: a bad, an expired or an accepted personal organization's invitation answers exactly as before, not with the new refusal", async () => {
      const on = await modeServer("invite-only");
      expectRefusal(await register(randomBytes(32).toString("base64url"), {}, on), 404, "invitation_not_found");
      const expired = await personalInvitation();
      await ownerDb.updateTable("organization_invitations").set({ expires_at: new Date(clock.getTime() - 1) }).where("id", "=", expired.invitation.id).execute();
      expectRefusal(await register(expired.token, {}, on), 410, "invitation_expired");
      const accepted = await personalInvitation();
      await ownerDb.updateTable("organization_invitations").set({ accepted_at: clock }).where("id", "=", accepted.invitation.id).execute();
      expectRefusal(await register(accepted.token, {}, on), 409, "invitation_already_accepted");
    });

    it("invite-only: an existing account accepts a personal organization's invitation, signed in", async () => {
      const on = await modeServer("invite-only");
      const account = await verifiedUser();
      const access = await signedIn(account.user.email, on);
      const { personal, token } = await personalInvitation(account.user.email);

      const response = await accept(access, token, on);

      expect(response.statusCode).toBe(200);
      expect(await membership(account.user.id, personal.id)).toMatchObject({ role: "contributor", deleted_at: null });
    });

    it("invite-only: a group organization's invitation still makes the account; open: a personal organization's does too", async () => {
      const inviteOnly = await modeServer("invite-only");
      const group = await pendingInvitation({ email: `newcomer-${randomUUID()}@example.com` });
      expect((await register(group.token, {}, inviteOnly)).statusCode).toBe(201);

      const open = await modeServer("open");
      const email = `newcomer-${randomUUID()}@example.com`;
      const { personal, token } = await personalInvitation(email);
      expect((await register(token, {}, open)).statusCode).toBe(201);
      const [user] = await usersWithEmail(email);
      expect(await membership(user!.id, personal.id)).toMatchObject({ role: "contributor", deleted_at: null });
    });

    it("closed: an existing account still accepts an invitation, signed in", async () => {
      const on = await modeServer("closed");
      const account = await verifiedUser();
      const access = await signedIn(account.user.email, on);
      const { group, token } = await pendingInvitation({ email: account.user.email, role: "contributor" });

      const response = await accept(access, token, on);

      expect(response.statusCode).toBe(200);
      expect(await membership(account.user.id, group.id)).toMatchObject({ role: "contributor", deleted_at: null });
    });
  });

  describe("a site that asks for no Terms (D36-1 decision 32, Preflight ruling 1)", () => {
    let noTerms: FastifyInstance;
    beforeAll(async () => {
      noTerms = serverWith({ site: { terms: { version: "", termsUrl: "", privacyUrl: "", cookiePolicyUrl: "" } } });
      await noTerms.ready();
    });
    afterAll(async () => {
      await noTerms.close();
    });

    it("registers from an invitation with no Terms version, recording none, and audits user.registered without the key", async () => {
      for (const terms of [{ acceptedTermsVersion: undefined }, { acceptedTermsVersion: "2020-01-01" }]) {
        const email = `newcomer-${randomUUID()}@example.com`;
        const { token } = await pendingInvitation({ email, role: "contributor" });

        const response = await register(token, terms, noTerms);

        expect(response.statusCode).toBe(201);
        const [user] = await usersWithEmail(email);
        expect(user).toMatchObject({ accepted_terms_version: null, terms_accepted_at: null });
        const [registered] = (await auditRows("user.registered")).filter((row) => row.actor_user_id === user!.id);
        expect(registered!.metadata).toEqual({ via: "invitation" });
      }
    });

    it("signs the new account in with no Terms to accept: /me answers termsAcceptanceRequired false", async () => {
      const email = `newcomer-${randomUUID()}@example.com`;
      const { token } = await pendingInvitation({ email, role: "contributor" });
      const response = await register(token, { acceptedTermsVersion: undefined }, noTerms);
      const access = cookieValue(response, "telflo_access");

      const me = await noTerms.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });

      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ termsAcceptanceRequired: false });
    });
  });

  describe("a removed or demoted admin's invitations (Ruling 17)", () => {
    const memberUrl = (organizationId: string, userId: string) =>
      `/api/v1/organizations/${organizationId}/members/${userId}`;

    const changeRole = (access: string, organizationId: string, userId: string, role: OrganizationRole) =>
      server.inject({
        method: "PATCH",
        url: memberUrl(organizationId, userId),
        headers: csrfHeaders,
        cookies: { telflo_access: access },
        payload: { role },
      });

    const removeMember = (access: string, organizationId: string, userId: string) =>
      server.inject({
        method: "DELETE",
        url: memberUrl(organizationId, userId),
        headers: csrfHeaders,
        cookies: { telflo_access: access },
      });

    /**
     * Two admins of one group. The second has invited two addresses (one of
     * them since expired), and has an accepted and a cancelled invitation;
     * the first has invited one address of their own.
     */
    const twoAdminsInviting = async () => {
      const first = await memberActiveInGroup("admin");
      const second = await memberActiveInGroup("admin", first.group.id);
      const group = first.group;
      const sendAs = async (access: string) => {
        const response = await invite(access, group.id, {
          email: `invitee-${randomUUID()}@example.com`,
          role: "contributor",
        });
        expect(response.statusCode).toBe(201);
        return { id: response.json<{ invitation: { id: string } }>().invitation.id, token: tokenFrom(mailer.sent.at(-1)!) };
      };
      const theirs = [await sendAs(second.access), await sendAs(second.access)];
      await ownerDb
        .updateTable("organization_invitations")
        .set({ expires_at: new Date(clock.getTime() - DAY_MS) })
        .where("id", "=", theirs[1]!.id)
        .execute();
      const firstAdmins = await sendAs(first.access);
      const acceptor = await verifiedUser();
      const settled = [
        await addInvitation(ownerDb, {
          organizationId: group.id,
          invited_by_user_id: second.account.user.id,
          accepted_at: clock,
          accepted_by_user_id: acceptor.user.id,
        }),
        await addInvitation(ownerDb, {
          organizationId: group.id,
          invited_by_user_id: second.account.user.id,
          revoked_at: new Date(clock.getTime() - DAY_MS),
        }),
      ];
      const settledBefore = await Promise.all(settled.map(({ id }) => invitationRow(id)));
      return { first, second, group, theirs, firstAdmins, settled, settledBefore };
    };

    /** The second admin's pending invitations are revoked at the clock, their links 404, and nothing else changed. */
    const expectOnlyTheirsRevoked = async (setup: Awaited<ReturnType<typeof twoAdminsInviting>>, via: string) => {
      const { group, theirs, firstAdmins, settled, settledBefore } = setup;
      for (const { id, token } of theirs) {
        expect(await invitationRow(id)).toMatchObject({ revoked_at: clock, accepted_at: null });
        expectRefusal(await preview(token), 404, "invitation_not_found", MESSAGES.invalidLink);
      }
      expect(await invitationRow(firstAdmins.id)).toMatchObject({ revoked_at: null });
      expect((await preview(firstAdmins.token)).statusCode).toBe(200);
      expect(await Promise.all(settled.map(({ id }) => invitationRow(id)))).toEqual(settledBefore);
      expect(await auditRows("organization_invitation.revoked")).toEqual(
        theirs.map(({ id }) =>
          expect.objectContaining({
            actor_user_id: setup.first.account.user.id,
            organization_id: group.id,
            subject_type: "organization_invitation",
            subject_id: id,
            metadata: { via },
          }),
        ),
      );
      const listed = (await list(setup.first.access, group.id)).json<{ items: Array<{ id: string }> }>().items;
      expect(listed.map(({ id }) => id)).toEqual([firstAdmins.id]);
    };

    it("removing an admin revokes the invitations they sent, and counts them on the removal's audit row", async () => {
      const setup = await twoAdminsInviting();

      const response = await removeMember(setup.first.access, setup.group.id, setup.second.account.user.id);

      expect(response.statusCode).toBe(204);
      await expectOnlyTheirsRevoked(setup, "organization_member.removed");
      expect(await auditRows("organization_member.removed")).toEqual([
        expect.objectContaining({
          subject_id: setup.second.account.user.id,
          metadata: { reassignedSessions: 1, revokedInvitations: 2 },
        }),
      ]);
    });

    it("demoting an admin to contributor revokes the invitations they sent, and counts them on the role change's row", async () => {
      const setup = await twoAdminsInviting();

      const response = await changeRole(setup.first.access, setup.group.id, setup.second.account.user.id, "contributor");

      expect(response.statusCode).toBe(204);
      await expectOnlyTheirsRevoked(setup, "organization_member.role_changed");
      expect(await auditRows("organization_member.role_changed")).toEqual([
        expect.objectContaining({
          subject_id: setup.second.account.user.id,
          metadata: { from: "admin", to: "contributor", revokedInvitations: 2 },
        }),
      ]);
    });

    it.each([
      ["promoting a contributor to admin", "contributor", "admin"],
      ["removing a contributor", "contributor", undefined],
    ] as const)("%s revokes nothing, even an invitation they sent", async (_label, from, to) => {
      // A contributor can't invite; this one's invitation is from their time as an admin.
      const admin = await memberActiveInGroup("admin");
      const member = await memberActiveInGroup(from, admin.group.id);
      const pending = await addInvitation(ownerDb, {
        organizationId: admin.group.id,
        invited_by_user_id: member.account.user.id,
      });
      const before = await invitationRow(pending.id);

      const response =
        to === undefined
          ? await removeMember(admin.access, admin.group.id, member.account.user.id)
          : await changeRole(admin.access, admin.group.id, member.account.user.id, to);

      expect(response.statusCode).toBe(204);
      expect(await invitationRow(pending.id)).toEqual(before);
      expect(await auditRows("organization_invitation.revoked")).toEqual([]);
    });
  });

  describe("the mail limit (decision 6)", () => {
    it("refuses the 51st invitation email of one user in an hour, resends included; another admin is unaffected", async () => {
      const limited = serverWith({
        rateLimits: { ...TEST_RATE_LIMITS, invitationEmailsPerUser: RATE_LIMITS.invitationEmailsPerUser },
      });
      try {
        await limited.ready();
        expect(RATE_LIMITS.invitationEmailsPerUser).toEqual({ max: 50, windowMs: 60 * 60 * 1000 });
        const admin = await memberActiveInGroup("admin", undefined, limited);
        const created = await invite(
          admin.access,
          admin.group.id,
          { email: "often@example.com", role: "contributor" },
          limited,
        );
        expect(created.statusCode).toBe(201);
        const { invitation } = created.json<{ invitation: { id: string } }>();
        for (let send = 2; send <= 50; send += 1) {
          expect((await resend(admin.access, admin.group.id, invitation.id, limited)).statusCode).toBe(201);
        }
        expect(mailer.sent).toHaveLength(50);
        const before = await invitationRow(invitation.id);

        const refusedResend = await resend(admin.access, admin.group.id, invitation.id, limited);
        const refusedInvite = await invite(
          admin.access,
          admin.group.id,
          { email: "one-more@example.com", role: "contributor" },
          limited,
        );

        for (const refused of [refusedResend, refusedInvite]) {
          expectRefusal(refused, 429, "rate_limited", RATE_LIMITED_MESSAGE);
          const retryAfter = Number(refused.headers["retry-after"]);
          expect(retryAfter).toBeGreaterThan(0);
          expect(retryAfter).toBeLessThanOrEqual(60 * 60);
        }
        expect(await invitationRow(invitation.id)).toEqual(before);
        expect(await invitationRows(admin.group.id)).toHaveLength(1);
        expect(mailer.sent).toHaveLength(50);

        const otherAdmin = await memberActiveInGroup("admin", admin.group.id, limited);
        const response = await invite(
          otherAdmin.access,
          admin.group.id,
          { email: "one-more@example.com", role: "contributor" },
          limited,
        );
        expect(response.statusCode).toBe(201);
      } finally {
        await limited.close();
      }
    }, 30_000);

    it("an invite to the reserved domain spends none of the limit (D22 Preflight ruling 13)", async () => {
      const limited = serverWith({
        rateLimits: { ...TEST_RATE_LIMITS, invitationEmailsPerUser: { max: 1, windowMs: 60 * 60 * 1000 } },
      });
      try {
        await limited.ready();
        const admin = await memberActiveInGroup("admin", undefined, limited);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const refused = await invite(
            admin.access,
            admin.group.id,
            { email: `nobody-${attempt}@service-accounts.telflo.invalid`, role: "contributor" },
            limited,
          );
          expectRefusal(refused, 422, "email_reserved", "This address can't be used");
        }

        const created = await invite(admin.access, admin.group.id, { email: "first@example.com", role: "contributor" }, limited);
        expect(created.statusCode).toBe(201);
        const limitedNow = await invite(
          admin.access,
          admin.group.id,
          { email: "second@example.com", role: "contributor" },
          limited,
        );
        expectRefusal(limitedNow, 429, "rate_limited", RATE_LIMITED_MESSAGE);
        expect(mailer.sent.map((message) => message.to)).toEqual(["first@example.com"]);
      } finally {
        await limited.close();
      }
    });
  });

  describe("under concurrency (decision 10)", () => {
    /**
     * Resolves once `count` backends other than this test's own wait on a
     * lock (D2a Ruling 6), or once `isSettled()` holds. Throws after five
     * seconds.
     */
    const waitForLockWaits = async (count: number, isSettled: () => boolean = () => false): Promise<void> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        if (isSettled()) return;
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::int as waiting
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
        `.execute(ownerDb);
        if ((rows[0]?.waiting ?? 0) >= count) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} backends to wait on a lock`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    const started = (request: Promise<LightMyRequestResponse>) => {
      const tracked = { isSettled: false, response: request };
      const settle = () => {
        tracked.isSettled = true;
      };
      request.then(settle, settle);
      return tracked;
    };

    /** Runs `work` while a separate connection holds a transaction open; always ends it. */
    const withLocker = async (work: (locker: PoolClient, release: () => Promise<void>) => Promise<void>) => {
      const locker = await pool.connect();
      let isInTransaction = false;
      try {
        await locker.query("begin");
        isInTransaction = true;
        await work(locker, async () => {
          await locker.query("rollback");
          isInTransaction = false;
        });
      } finally {
        if (isInTransaction) await locker.query("rollback");
        locker.release();
      }
    };

    it("an invite to the reserved domain is refused while another transaction holds the organization: before the lock (D22 decision 23)", async () => {
      const admin = await memberActiveInGroup("admin");

      await withLocker(async (locker) => {
        await locker.query("select id from organizations where id = $1 for update", [admin.group.id]);
        const request = started(
          invite(admin.access, admin.group.id, {
            email: "nobody-1a2b3c4d@service-accounts.telflo.invalid",
            role: "contributor",
          }),
        );
        await waitForLockWaits(1, () => request.isSettled);
        // Settled without ever waiting on the held organization.
        expect(request.isSettled).toBe(true);
        expectRefusal(await request.response, 422, "email_reserved", "This address can't be used");
      });
      expect(await invitationRows(admin.group.id)).toEqual([]);
    });

    it("two admins inviting one address at once: one 201, one 409, one invitation and one email", async () => {
      // A separate connection holds the organization, which every writer
      // locks first (Preflight ruling 8). Both requests queue on it; once it
      // is released, the first commits its invitation before the second,
      // under the same lock, looks for a pending one.
      const a = await memberActiveInGroup("admin");
      const b = await memberActiveInGroup("admin", a.group.id);
      const payload = { email: "wanted@example.com", role: "contributor" };

      await withLocker(async (locker, release) => {
        await locker.query("select id from organizations where id = $1 for update", [a.group.id]);

        const first = started(invite(a.access, a.group.id, payload));
        await waitForLockWaits(1, () => first.isSettled);
        const second = started(invite(b.access, a.group.id, payload));
        await waitForLockWaits(2, () => second.isSettled);

        await release();

        const responses = [await first.response, await second.response];
        expect(responses.map((response) => response.statusCode)).toEqual([201, 409]);
        expectRefusal(responses[1]!, 409, "invitation_already_pending", MESSAGES.alreadyInvited);
      });

      expect(await invitationRows(a.group.id)).toEqual([expect.objectContaining({ email: "wanted@example.com" })]);
      expect(mailer.sent.map((message) => message.to)).toEqual(["wanted@example.com"]);
      expect(await auditRows("organization_invitation.created")).toHaveLength(1);
    });

    /**
     * Holds the organization's row from a side connection, starts `first`
     * and waits until it is blocked, then `second` and waits again, then
     * releases: the two go on in that order under the organization's lock,
     * which every writer takes first (Preflight ruling 8).
     */
    const inOrder = async (
      organizationId: string,
      first: () => Promise<LightMyRequestResponse>,
      second: () => Promise<LightMyRequestResponse>,
    ): Promise<[LightMyRequestResponse, LightMyRequestResponse]> => {
      let responses: [LightMyRequestResponse, LightMyRequestResponse] | undefined;
      await withLocker(async (locker, release) => {
        await locker.query("select id from organizations where id = $1 for update", [organizationId]);
        const a = started(first());
        await waitForLockWaits(1, () => a.isSettled);
        const b = started(second());
        await waitForLockWaits(2, () => b.isSettled);
        await release();
        responses = [await a.response, await b.response];
      });
      return responses!;
    };

    /** A signed-in account, and an invitation to its address from an admin who can cancel or resend it. */
    const invitedBySomeone = async () => {
      const account = await verifiedUser();
      const access = await signedIn(account.user.email);
      const { admin, group, invitation, token } = await invited(account.user.email);
      return { account, access, admin, group, invitation, token };
    };

    it("an accept, then a concurrent cancel: the member joins, and the cancel is 404", async () => {
      const { account, access, admin, group, invitation, token } = await invitedBySomeone();

      const [accepted, cancelled] = await inOrder(
        group.id,
        () => accept(access, token),
        () => cancel(admin.access, group.id, invitation.id),
      );

      expect(accepted.statusCode).toBe(200);
      expectRefusal(cancelled, 404, "invitation_not_found", MESSAGES.notFound);
      expect(await invitationRow(invitation.id)).toMatchObject({
        accepted_by_user_id: account.user.id,
        revoked_at: null,
      });
      expect(await membership(account.user.id, group.id)).toMatchObject({ deleted_at: null });
    });

    it("a cancel, then a concurrent accept: the invitation is revoked, and the accept is 404", async () => {
      const { account, access, admin, group, invitation, token } = await invitedBySomeone();

      const [cancelled, accepted] = await inOrder(
        group.id,
        () => cancel(admin.access, group.id, invitation.id),
        () => accept(access, token),
      );

      expect(cancelled.statusCode).toBe(204);
      expectRefusal(accepted, 404, "invitation_not_found", MESSAGES.invalidLink);
      expect(await invitationRow(invitation.id)).toMatchObject({ accepted_at: null, revoked_at: clock });
      expect(await membership(account.user.id, group.id)).toBeUndefined();
    });

    it("two accepts of one invitation at once: one joins, the other is 409 already accepted", async () => {
      const { account, access, group, invitation, token } = await invitedBySomeone();

      const [first, second] = await inOrder(
        group.id,
        () => accept(access, token),
        () => accept(access, token),
      );

      expect(first.statusCode).toBe(200);
      expectRefusal(second, 409, "invitation_already_accepted", MESSAGES.alreadyAccepted);
      expect(await invitationRow(invitation.id)).toMatchObject({ accepted_by_user_id: account.user.id });
      expect(await auditRows("organization_invitation.accepted")).toHaveLength(1);
    });

    it("a resend that commits between an accept's lookup and its lock supersedes the token: 404 (Preflight ruling 1)", async () => {
      // The resend queues first; the accept has looked the old token up
      // (unlocked, still current) before it queues behind it.
      const { account, access, admin, group, invitation, token } = await invitedBySomeone();

      const [resent, accepted] = await inOrder(
        group.id,
        () => resend(admin.access, group.id, invitation.id),
        () => accept(access, token),
      );

      expect(resent.statusCode).toBe(201);
      expectRefusal(accepted, 404, "invitation_not_found", MESSAGES.invalidLink);
      const row = await invitationRow(invitation.id);
      expect(row).toMatchObject({ accepted_at: null, revoked_at: null });
      expect(row.token_hash).toBe(hashToken(tokenFrom(mailer.sent.at(-1)!)));
      expect(await membership(account.user.id, group.id)).toBeUndefined();
    });

    it("an invitation that expires while an accept waits for its lock is refused with 410", async () => {
      // The clock moves past the expiry while the accept is blocked: only a
      // comparison made under the lock sees it.
      const { account, access, group, invitation, token } = await invitedAccount();
      await ownerDb
        .updateTable("organization_invitations")
        .set({ expires_at: new Date(clock.getTime() + 60_000) })
        .where("id", "=", invitation.id)
        .execute();

      await withLocker(async (locker, release) => {
        await locker.query("select id from organizations where id = $1 for update", [group.id]);
        const accepting = started(accept(access, token));
        await waitForLockWaits(1, () => accepting.isSettled);
        clock = new Date(clock.getTime() + 120_000);
        await release();
        expectRefusal(await accepting.response, 410, "invitation_expired", MESSAGES.expired);
      });

      expect(await membership(account.user.id, group.id)).toBeUndefined();
      expect(await invitationRow(invitation.id)).toMatchObject({ accepted_at: null });
    });

    it("an invitation that expires while a registration waits for its lock is refused with 410, and no account made", async () => {
      const { invitation, token, group } = await pendingInvitation({ expires_at: new Date(clock.getTime() + 60_000) });

      await withLocker(async (locker, release) => {
        await locker.query("select id from organizations where id = $1 for update", [group.id]);
        const registering = started(register(token));
        await waitForLockWaits(1, () => registering.isSettled);
        clock = new Date(clock.getTime() + 120_000);
        await release();
        expectRefusal(await registering.response, 410, "invitation_expired", MESSAGES.expired);
      });

      expect(await usersWithEmail(invitation.email)).toEqual([]);
      expect(await invitationRow(invitation.id)).toEqual(invitation);
    });

    it("a cancel, then a concurrent registration: no account is created, and the registration is 404", async () => {
      const email = `racer-${randomUUID()}@example.com`;
      const { admin, group, invitation, token } = await invited(email);

      const [cancelled, registered] = await inOrder(
        group.id,
        () => cancel(admin.access, group.id, invitation.id),
        () => register(token),
      );

      expect(cancelled.statusCode).toBe(204);
      expectRefusal(registered, 404, "invitation_not_found", MESSAGES.invalidLink);
      expect(await usersWithEmail(email)).toEqual([]);
      expect(await invitationRow(invitation.id)).toMatchObject({ accepted_at: null, revoked_at: clock });
    });

    it("a registration, then a concurrent cancel: the account joins, and the cancel is 404", async () => {
      const email = `racer-${randomUUID()}@example.com`;
      const { admin, group, invitation, token } = await invited(email);

      const [registered, cancelled] = await inOrder(
        group.id,
        () => register(token),
        () => cancel(admin.access, group.id, invitation.id),
      );

      expect(registered.statusCode).toBe(201);
      expectRefusal(cancelled, 404, "invitation_not_found", MESSAGES.notFound);
      const [user] = await usersWithEmail(email);
      expect(await membership(user!.id, group.id)).toMatchObject({ deleted_at: null });
      expect(await invitationRow(invitation.id)).toMatchObject({ accepted_by_user_id: user!.id, revoked_at: null });
    });

    it("a deletion of the organization, then a concurrent accept: the accept is 404, and nobody joins", async () => {
      // The accept has looked its token up (unlocked, the organization still
      // live) before it queues behind the deletion; under the lock the
      // organization is gone.
      const { account, access, admin, group, invitation, token } = await invitedBySomeone();

      const [deleted, accepted] = await inOrder(
        group.id,
        () =>
          server.inject({
            method: "DELETE",
            url: `/api/v1/organizations/${group.id}`,
            headers: csrfHeaders,
            cookies: { telflo_access: admin.access },
          }),
        () => accept(access, token),
      );

      expect(deleted.statusCode).toBe(204);
      expectRefusal(accepted, 404, "invitation_not_found", MESSAGES.invalidLink);
      expect(await membership(account.user.id, group.id)).toBeUndefined();
      expect(await invitationRow(invitation.id)).toMatchObject({ accepted_at: null, accepted_by_user_id: null });
      expect(await auditRows("organization_invitation.accepted")).toEqual([]);
      // The session stays where it was.
      expect((await me(access)).json()).toMatchObject({ organization: { id: account.organization.id } });
    });

    it("the inviting admin's removal, then a concurrent accept: the invitation is revoked with them, and the accept is 404 (Ruling 17)", async () => {
      // The removal takes the invitations under the organization's lock,
      // before the account's, as a cancel does: the accept, queued behind it
      // on the same lock, finds the invitation revoked.
      const { account, access, admin, group, invitation, token } = await invitedBySomeone();
      const remover = await memberActiveInGroup("admin", group.id);

      const [removed, accepted] = await inOrder(
        group.id,
        () =>
          server.inject({
            method: "DELETE",
            url: `/api/v1/organizations/${group.id}/members/${admin.account.user.id}`,
            headers: csrfHeaders,
            cookies: { telflo_access: remover.access },
          }),
        () => accept(access, token),
      );

      expect(removed.statusCode).toBe(204);
      expectRefusal(accepted, 404, "invitation_not_found", MESSAGES.invalidLink);
      expect(await invitationRow(invitation.id)).toMatchObject({ revoked_at: clock, accepted_at: null });
      expect(await membership(account.user.id, group.id)).toBeUndefined();
    });

    it("a cancel, then a concurrent resend: the invitation is revoked, the resend is 404, and no email goes", async () => {
      const { admin, group, invitation, token } = await invited();
      const sentBefore = mailer.sent.length;

      const [cancelled, resent] = await inOrder(
        group.id,
        () => cancel(admin.access, group.id, invitation.id),
        () => resend(admin.access, group.id, invitation.id),
      );

      expect(cancelled.statusCode).toBe(204);
      expectRefusal(resent, 404, "invitation_not_found", MESSAGES.notFound);
      expect(mailer.sent).toHaveLength(sentBefore);
      expect(await invitationRow(invitation.id)).toMatchObject({ revoked_at: clock, token_hash: hashToken(token) });
      expect(await invitationAudits()).toEqual(["organization_invitation.created", "organization_invitation.revoked"]);
    });

    it("a resend, then a concurrent cancel: the new link is sent, then revoked with the invitation", async () => {
      const { admin, group, invitation, token } = await invited();

      const [resent, cancelled] = await inOrder(
        group.id,
        () => resend(admin.access, group.id, invitation.id),
        () => cancel(admin.access, group.id, invitation.id),
      );

      expect(resent.statusCode).toBe(201);
      expect(cancelled.statusCode).toBe(204);
      const renewed = tokenFrom(mailer.sent.at(-1)!);
      expect(renewed).not.toBe(token);
      expect(await invitationRow(invitation.id)).toMatchObject({ revoked_at: clock, token_hash: hashToken(renewed) });
      for (const link of [token, renewed]) {
        expectRefusal(await preview(link), 404, "invitation_not_found", MESSAGES.invalidLink);
      }
      expect(await invitationAudits()).toEqual([
        "organization_invitation.created",
        "organization_invitation.resent",
        "organization_invitation.revoked",
      ]);
    });

    it("an accept whose switch fails after the join committed answers 200 without a cookie (Preflight ruling 5)", async () => {
      // A side connection holds the session row, which the join doesn't
      // touch and the switch after it locks. Once the switch waits on it,
      // the session is revoked and the lock released: the switch refuses,
      // and the join has already committed.
      const lines: string[] = [];
      const warned = serverWith({ level: "warn", lines });
      await warned.ready();
      const locker = await pool.connect();
      try {
        const { account, access, group, invitation, token } = await invitedAccount("contributor");
        const session = await sessionOf(account.user.id);
        await locker.query("begin");
        await locker.query("select id from sessions where id = $1 for update", [session.id]);

        const accepting = started(accept(access, token, warned));
        await waitForLockWaits(1, () => accepting.isSettled);
        await locker.query("update sessions set revoked_at = now(), revoked_reason = 'logout' where id = $1", [
          session.id,
        ]);
        await locker.query("commit");
        const response = await accepting.response;

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          organization: { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" },
        });
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(await membership(account.user.id, group.id)).toMatchObject({ role: "contributor", deleted_at: null });
        expect(await invitationRow(invitation.id)).toMatchObject({ accepted_by_user_id: account.user.id });
        expect(await auditRows("session.organization_switched")).toEqual([]);
        const warnings = lines.map((line) => JSON.parse(line) as { level: number; msg: string });
        expect(warnings).toContainEqual(
          expect.objectContaining({ level: 40, msg: "joined an organization, but the session couldn't switch to it" }),
        );
      } finally {
        await locker.query("rollback").catch(() => undefined);
        locker.release();
        await warned.close();
      }
    });

    it("an acceptance by an account a product admin's delete takes while it waits: the account's row read under its lock, 401 unauthenticated, no membership, the invitation still pending (D29 Ruling 271)", async () => {
      const { account, access, group, invitation, token } = await invitedAccount();

      await withLocker(async (locker) => {
        // The delete's lock on the person (migration 1700000000042: their organizations, then their row for update) and its write.
        await locker.query("select id from users where id = $1 for update", [account.user.id]);
        await locker.query("update users set deleted_at = now(), updated_at = now() where id = $1", [account.user.id]);
        const request = started(accept(access, token));
        // It waits on the person's row, after the invitation's organization and the invitation.
        await waitForLockWaits(1, () => request.isSettled);
        expect(request.isSettled).toBe(false);
        await locker.query("commit");
        const response = await request.response;
        expect({ status: response.statusCode, body: response.json() }).toEqual({
          status: 401,
          body: { error: { code: "unauthenticated", message: "You need to sign in." } },
        });
      });
      const memberships = await ownerDb
        .selectFrom("organization_members")
        .select("user_id")
        .where("organization_id", "=", group.id)
        .where("user_id", "=", account.user.id)
        .execute();
      expect(memberships).toEqual([]);
      const row = await ownerDb.selectFrom("organization_invitations").select(["accepted_at", "accepted_by_user_id"]).where("id", "=", invitation.id).executeTakeFirstOrThrow();
      expect(row).toEqual({ accepted_at: null, accepted_by_user_id: null });
    });
  });

  describe("the logs (Preflight ruling 4)", () => {
    /** A server logging everything, request lines included, into `lines`. */
    const tracing = async (lines: string[]) => {
      const traced = serverWith({ level: "trace", lines });
      await traced.ready();
      return traced;
    };

    it("never carry the token or its hash, through a whole invite, list, resend and cancel", async () => {
      const lines: string[] = [];
      const traced = await tracing(lines);
      try {
        const admin = await memberActiveInGroup("admin", undefined, traced);
        const created = await invite(
          admin.access,
          admin.group.id,
          { email: "logged@example.com", role: "contributor" },
          traced,
        );
        const { invitation } = created.json<{ invitation: { id: string } }>();
        const firstToken = tokenFrom(mailer.sent.at(-1)!);
        await list(admin.access, admin.group.id, traced);
        expect((await resend(admin.access, admin.group.id, invitation.id, traced)).statusCode).toBe(201);
        const secondToken = tokenFrom(mailer.sent.at(-1)!);
        expect((await cancel(admin.access, admin.group.id, invitation.id, traced)).statusCode).toBe(204);

        // The request lines were captured, so their absence below means something.
        const log = lines.join("");
        expect(log).toContain(`/invitations/${invitation.id}/deliveries`);
        for (const secret of [firstToken, secondToken, hashToken(firstToken), hashToken(secondToken)]) {
          expect(log).not.toContain(secret);
        }
      } finally {
        await traced.close();
      }
    });

    it("never carry the token or its hash, through a preview, an accept and a registration", async () => {
      const lines: string[] = [];
      const traced = await tracing(lines);
      try {
        const invitee = await verifiedUser();
        const access = await signedIn(invitee.user.email, traced);
        const toAccept = await pendingInvitation({ email: invitee.user.email });
        const toRegister = await pendingInvitation();

        expect((await preview(toAccept.token, traced)).statusCode).toBe(200);
        const accepted = await accept(access, toAccept.token, traced);
        expect(accepted.statusCode).toBe(200);
        expect((await preview(toRegister.token, traced)).statusCode).toBe(200);
        expect((await register(toRegister.token, {}, traced)).statusCode).toBe(201);
        // A refusal too: its error is the one line most likely to carry what it refused.
        const switched = cookieValue(accepted, "telflo_access");
        expect((await accept(switched, toAccept.token, traced)).statusCode).toBe(409);

        const log = lines.join("");
        for (const path of ["/invitation-previews", "/invitation-acceptances", "/invitation-registrations"]) {
          expect(log).toContain(path);
        }
        for (const token of [toAccept.token, toRegister.token]) {
          expect(log).not.toContain(token);
          expect(log).not.toContain(hashToken(token));
        }
      } finally {
        await traced.close();
      }
    });

    /*
     * A constraint violation's DETAIL names the row's values, the token's
     * hash among them ("Failing row contains (…)", "Key (token_hash)=(…)").
     * A test-only trigger makes the invite's insert violate each kind, with a
     * hash the test knows; the logged error keeps its code and carries no
     * detail. For this table Postgres itself leaves the detail out, since its
     * row-level security applies to the API's role; the logger's redaction,
     * for every table, is shown by logged-errors.integration.test.ts.
     */
    it.each([
      [
        "a check violation",
        "23514",
        (hash: string) => `new.email := upper(new.email); new.token_hash := '${hash}'; return new`,
      ],
      ["a unique violation", "23505", (hash: string) => `new.token_hash := '${hash}'; return new`],
    ])("drop a database error's detail: %s", async (_label, code, triggerBody) => {
      const lines: string[] = [];
      const traced = await tracing(lines);
      try {
        const admin = await memberActiveInGroup("admin", undefined, traced);
        const knownHash = randomBytes(32).toString("hex");
        // The unique violation needs the hash taken already.
        await addInvitation(ownerDb, { organizationId: admin.group.id, token_hash: knownHash });
        lines.length = 0;

        await withFailingInsert(ownerDb, "organization_invitations", triggerBody(knownHash), async () => {
          const response = await invite(
            admin.access,
            admin.group.id,
            { email: "clash@example.com", role: "contributor" },
            traced,
          );
          expect(response.statusCode).toBe(500);
        });

        const errors = lines
          .map((line) => JSON.parse(line) as { err?: { code?: string } })
          .filter((entry) => entry.err);
        expect(errors.map((entry) => entry.err?.code)).toContain(code);
        const log = lines.join("");
        expect(log).not.toContain(knownHash);
        expect(log).not.toContain("Failing row contains");
        expect(log).not.toContain("already exists");
      } finally {
        await traced.close();
      }
    });
  });
});
