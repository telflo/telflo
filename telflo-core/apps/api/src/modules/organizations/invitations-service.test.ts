import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import type { AuditEvent } from "../identity/repositories/audit-repository.js";
import type {
  Account,
  AccountCreatedCallback,
  AccountWrites,
  CreateUserInput,
  IUserRepository,
} from "../identity/repositories/user-repository.js";
import { hashToken } from "../identity/tokens.js";
import type { ISessionService, IssuedSession, StartSessionInput } from "../sessions/service.js";
import { createInviteeService } from "./invitations-service.js";
import type {
  IInvitationRepository,
  InvitationByToken,
  LockedInvitation,
} from "./repositories/invitation-repository.js";
import type { IMemberRepository } from "./repositories/member-repository.js";
import type { IActiveOrganizationRepository, Organization } from "./repositories/organization-repository.js";
import type { OrganizationRepositories, OrganizationTransaction, WithOrganizationTransaction } from "./service.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

/*
 * The branches of acceptance and registration that follow the commit, which
 * the database can't be made to reach on demand.
 * invitations.integration.test.ts proves the rest against Postgres: the
 * refusals, the locks, the races, and a switch refused after the join.
 */

const NOW = new Date("2030-01-01T00:00:00.000Z");
const TOKEN = "the-token";

const notUsed = () =>
  vi.fn(async (): Promise<never> => {
    throw new Error("not used by the invitee service");
  });

function buildHarness() {
  const group: Organization = {
    id: randomUUID(),
    name: "Acme",
    type: "group",
    ownerUserId: null,
    createdAt: NOW,
    logoId: null,
    logoContentType: null,
  };
  const invitation: LockedInvitation = {
    id: randomUUID(),
    organizationId: group.id,
    email: "invitee@example.com",
    role: "contributor",
    invitedByUserId: null,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    createdAt: NOW,
    acceptedAt: null,
    acceptedByUserId: null,
    revokedAt: null,
    tokenHash: hashToken(TOKEN),
  };
  const found: InvitationByToken = {
    id: invitation.id,
    organizationId: group.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    acceptedAt: null,
    revokedAt: null,
    organizationName: group.name,
    organizationType: group.type,
    organizationIsLive: true,
  };
  const audit: AuditEvent[] = [];

  const organizationRepositories = (): OrganizationRepositories => ({
    organization: {
      findActive: notUsed(),
      lockActive: vi.fn(async () => ({ ...group })),
      findActiveForShare: notUsed(),
      findSettings: notUsed(),
      findSettingsForShare: notUsed(),
      setPublicInstallLinks: notUsed(),
      rename: notUsed(),
      setLogo: notUsed(),
      findLogo: notUsed(),
      markDeleted: notUsed(),
      deleteAccountsOnlyInOrganization: notUsed(),
      reassignSessionsLeavingOrganization: notUsed(),
    } satisfies IActiveOrganizationRepository,
    members: {
      list: notUsed(),
      find: vi.fn(async () => undefined),
      findByEmail: notUsed(),
      findForShare: notUsed(),
      add: vi.fn(async (input) => ({ id: randomUUID(), organizationId: group.id, createdAt: NOW, ...input })),
      changeRole: notUsed(),
      remove: notUsed(),
      restore: notUsed(),
      lockAccounts: notUsed(),
      lockJoiningAccountForShare: vi.fn(async () => true),
      lockRestoredAccount: notUsed(),
    } satisfies IMemberRepository,
    invitations: {
      create: notUsed(),
      listPending: notUsed(),
      findPending: notUsed(),
      findPendingByEmail: notUsed(),
      lockForUpdate: vi.fn(async () => ({ ...invitation })),
      reissue: notUsed(),
      revoke: notUsed(),
      markAccepted: vi.fn(async () => true),
      revokePendingInvitedBy: notUsed(),
    } satisfies IInvitationRepository,
  });

  const withTransaction: WithOrganizationTransaction = (_context, work) => {
    const transaction: OrganizationTransaction = {
      organizations: { createGroup: notUsed() },
      audit: { record: async (event) => void audit.push(event) },
      active: organizationRepositories(),
      enterOrganization: async () => organizationRepositories(),
    };
    return work(transaction);
  };

  const personal: Organization = {
    id: randomUUID(),
    name: "invitee@example.com",
    type: "personal",
    ownerUserId: null,
    createdAt: NOW,
    logoId: null,
    logoContentType: null,
  };
  const createAccount = vi.fn(async (input: CreateUserInput, onCreated?: AccountCreatedCallback) => {
    const account: Account = {
      user: {
        id: randomUUID(),
        email: input.email,
        passwordHash: input.passwordHash,
        emailVerifiedAt: input.emailVerifiedAt,
        acceptedTermsVersion: input.terms?.version ?? null,
        createdAt: NOW,
      },
      organization: { ...personal, ownerUserId: null },
      membership: { id: randomUUID(), organizationId: personal.id, userId: "", role: "admin", createdAt: NOW },
    };
    const writes: AccountWrites = {
      audit: { record: async (event) => void audit.push(event) },
      verificationTokens: {
        create: notUsed(),
        findByHash: notUsed(),
        consume: notUsed(),
        consumeAllForUser: notUsed(),
      },
      identities: {
        findUserBySubject: notUsed(),
        link: notUsed(),
        listForUser: notUsed(),
        findForUser: notUsed(),
        unlink: notUsed(),
      },
      enterOrganization: async () => organizationRepositories(),
    };
    await onCreated?.(account, writes);
    return account;
  });
  const users = {
    findByEmailIncludingDeleted: vi.fn(async () => undefined),
    createAccount,
  } satisfies Pick<IUserRepository, "findByEmailIncludingDeleted" | "createAccount">;

  const issued = (organizationId: string): IssuedSession => ({
    user: { id: organizationId, email: invitation.email },
    accessToken: `access-${organizationId}`,
    accessTokenExpiresAt: NOW,
    refreshToken: `refresh-${organizationId}`,
    refreshTokenExpiresAt: NOW,
  });
  const sessions = {
    switchOrganization: vi.fn<ISessionService["switchOrganization"]>(),
    // An invitation's session always names its organization: never a sign-in's landing.
    startSession: vi.fn(async (input: StartSessionInput): Promise<IssuedSession | undefined> => {
      if (input.organizationId === undefined) throw new Error("an invitation's session names its organization");
      return issued(input.organizationId);
    }),
  } satisfies Pick<ISessionService, "switchOrganization" | "startSession">;

  const log = { warn: vi.fn() };
  const service = createInviteeService({
    findInvitationByTokenHash: async (tokenHash) => (tokenHash === invitation.tokenHash ? found : undefined),
    withTransaction,
    users,
    sessions,
    now: () => NOW,
    log,
    opampRegistration: { created: vi.fn(), renamed: vi.fn(), deleted: vi.fn() },
    termsVersion: TEST_TERMS_VERSION,
    registration: "invite-only",
  });

  const context: AuthContext = {
    userId: randomUUID(),
    organizationId: randomUUID(),
    role: "admin",
    sessionId: randomUUID(),
  };
  const actor = { context, email: invitation.email, ipAddress: "203.0.113.7", userAgent: "vitest" };

  return { service, sessions, log, actor, group, personal, invitation, audit, issued };
}

describe("accepting an invitation, after the join has committed", () => {
  it("answers with the organization and the switch's access token when the switch succeeds", async () => {
    const { service, sessions, actor, group } = buildHarness();
    const organization = { id: group.id, name: group.name, type: group.type, logoId: null, role: "contributor" as const };
    sessions.switchOrganization.mockResolvedValue({ organization, access: { token: "new", expiresAt: NOW } });

    await expect(service.accept(actor, TOKEN)).resolves.toEqual({
      organization,
      access: { token: "new", expiresAt: NOW },
    });
    expect(sessions.switchOrganization).toHaveBeenCalledWith({
      context: actor.context,
      email: actor.email,
      organizationId: group.id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  });

  it("answers with the organization from the lock and the invitation's role, and no token, when the switch refuses", async () => {
    const { service, sessions, log, actor, group, audit } = buildHarness();
    const refusal = new AppError("organization_access_denied", "You are not an active member of this organization", 403);
    sessions.switchOrganization.mockRejectedValue(refusal);

    await expect(service.accept(actor, TOKEN)).resolves.toEqual({
      organization: { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" },
    });
    expect(log.warn).toHaveBeenCalledWith(
      { err: refusal, organizationId: group.id },
      "joined an organization, but the session couldn't switch to it",
    );
    expect(audit.map((event) => event.action)).toEqual([
      "organization_invitation.accepted",
      "organization_member.added",
    ]);
  });

  it("lets any other failure of the switch propagate", async () => {
    const { service, sessions, log, actor } = buildHarness();
    sessions.switchOrganization.mockRejectedValue(new Error("the database went away"));

    await expect(service.accept(actor, TOKEN)).rejects.toThrow("the database went away");
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("creating an account from an invitation, after the account has committed", () => {
  const input = { token: TOKEN, password: "a-sufficiently-long-password", acceptedTermsVersion: TEST_TERMS_VERSION };

  it("starts the session in the inviting organization when its check holds", async () => {
    const { service, sessions, group, issued } = buildHarness();

    await expect(service.register(input)).resolves.toEqual({
      organization: { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" },
      issued: issued(group.id),
    });
    expect(sessions.startSession).toHaveBeenCalledTimes(1);
    expect(sessions.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: group.id, auditMetadata: { via: "invitation" } }),
    );
  });

  it("falls back to the new personal organization when the inviting one's check refuses", async () => {
    const { service, sessions, log, group, personal, issued } = buildHarness();
    sessions.startSession.mockResolvedValueOnce(undefined);

    await expect(service.register(input)).resolves.toEqual({
      organization: { id: personal.id, name: personal.name, type: "personal", logoId: null, role: "admin" },
      issued: issued(personal.id),
    });
    expect(sessions.startSession.mock.calls.map(([call]) => call.organizationId)).toEqual([group.id, personal.id]);
    expect(log.warn).toHaveBeenCalledWith(
      { organizationId: group.id },
      "joined an organization, but the new account's session couldn't start in it",
    );
  });

  it("fails when the account is gone before either session could start", async () => {
    const { service, sessions } = buildHarness();
    sessions.startSession.mockResolvedValue(undefined);

    await expect(service.register(input)).rejects.toThrow(
      "the account created from an invitation was deleted before its session started",
    );
  });
});
