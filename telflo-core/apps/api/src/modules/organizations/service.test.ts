import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationCreation, RegistrationMode } from "@telflo/contracts";
import type { OrganizationRole } from "@telflo/db";
import type { ActorContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import type { FileKey, IFileStore } from "../../file-store/file-store.js";
import type { EmailMessage, IMailer } from "../../mail/mailer.js";
import type { AuditEvent, IAuditRepository } from "../identity/repositories/audit-repository.js";
import { hashToken } from "../identity/tokens.js";
import {
  InvitationAlreadyPendingError,
  type CreateInvitationInput,
  type IInvitationRepository,
  type LockedInvitation,
} from "./repositories/invitation-repository.js";
import type { IMemberRepository, Member } from "./repositories/member-repository.js";
import {
  OrganizationNameTakenError,
  type CreateGroupOptions,
  type IActiveOrganizationRepository,
  type Organization,
  type OrganizationLogo,
} from "./repositories/organization-repository.js";
import {
  createOrganizationService,
  type Actor,
  type CreatingActor,
  type NewLogo,
  type WithOrganizationTransaction,
} from "./service.js";

const origin = { ipAddress: "203.0.113.7", userAgent: "vitest" };
const NOW = new Date("2030-01-01T00:00:00.000Z");

/**
 * Hand-built fakes typed against the repository interfaces (`satisfies`, so
 * an interface change the fakes don't follow fails to compile). Every call
 * is logged in order, so a test can see that the lock came first. There is
 * no real transaction: routes.integration.test.ts proves atomicity and the
 * locks against Postgres.
 */
/** `registration`: the site's mode the service is built with (the tests' setup pins `open`). */
function buildHarness({ registration = "open" }: { registration?: RegistrationMode } = {}) {
  const calls: string[] = [];
  const auditEvents: AuditEvent[] = [];
  const contexts: ActorContext[] = [];
  const entered: string[] = [];

  const organization: Organization = {
    id: randomUUID(),
    name: "Acme",
    type: "group",
    ownerUserId: null,
    createdAt: new Date("2029-01-01T00:00:00.000Z"),
    logoId: null,
    logoContentType: null,
  };
  /** The memberships `members.find` reads, the caller's (as the lock's re-check reads it) among them. */
  const people = new Map<string, Member>();
  const state = { isLive: true };

  const activeOrganization = {
    findActive: vi.fn(async () => (state.isLive ? { ...organization } : undefined)),
    lockActive: vi.fn(async () => {
      calls.push("lockActive");
      return state.isLive ? { ...organization } : undefined;
    }),
    findActiveForShare: vi.fn(async () => {
      throw new Error("not used by the organization service");
    }),
    findSettings: vi.fn(async () => (state.isLive ? { publicInstallLinks: true } : undefined)),
    findSettingsForShare: vi.fn(async () => {
      throw new Error("not used by the organization service");
    }),
    setPublicInstallLinks: vi.fn(async (enabled: boolean) => {
      calls.push(`setPublicInstallLinks:${String(enabled)}`);
      return state.isLive;
    }),
    rename: vi.fn(async (name: string) => {
      calls.push(`rename:${name}`);
      organization.name = name;
      return { ...organization };
    }),
    setLogo: vi.fn(async (logo: OrganizationLogo | null) => {
      calls.push(`setLogo:${logo?.logoId ?? "none"}`);
      organization.logoId = logo?.logoId ?? null;
      organization.logoContentType = logo?.contentType ?? null;
      return { ...organization };
    }),
    findLogo: vi.fn(async () => {
      throw new Error("not used by the organization service");
    }),
    markDeleted: vi.fn(async (at: Date) => {
      calls.push(`markDeleted:${at.toISOString()}`);
      state.isLive = false;
      return true;
    }),
    deleteAccountsOnlyInOrganization: vi.fn(async () => {
      calls.push("deleteAccountsOnlyInOrganization");
      return 1;
    }),
    reassignSessionsLeavingOrganization: vi.fn(async (userId?: string) => {
      calls.push(["reassignSessionsLeavingOrganization", userId].filter(Boolean).join(":"));
      return 3;
    }),
  } satisfies IActiveOrganizationRepository;

  const members = {
    list: vi.fn(async (): Promise<Member[]> => [...people.values()]),
    find: vi.fn(async (userId: string) => {
      calls.push("members.find");
      const member = people.get(userId);
      return member ? { ...member } : undefined;
    }),
    findByEmail: vi.fn(async (email: string) => {
      calls.push("members.findByEmail");
      const member = [...people.values()].find((person) => person.email === email);
      return member ? { ...member } : undefined;
    }),
    findForShare: vi.fn(async () => {
      throw new Error("not used by the organization service");
    }),
    add: vi.fn(async (input: { userId: string; role: OrganizationRole }) => {
      calls.push(`members.add:${input.role}`);
      return { id: randomUUID(), organizationId: entered.at(-1)!, createdAt: NOW, ...input };
    }),
    changeRole: vi.fn(async (userId: string, role: OrganizationRole) => {
      calls.push(`members.changeRole:${role}`);
      const member = people.get(userId);
      return member !== undefined && member.deletedAt === null && member.role !== role;
    }),
    remove: vi.fn(async (userId: string, at: Date) => {
      calls.push(`members.remove:${at.toISOString()}`);
      return people.get(userId)?.deletedAt === null;
    }),
    restore: vi.fn(async (userId: string) => {
      calls.push("members.restore");
      const member = people.get(userId);
      return member !== undefined && member.deletedAt !== null;
    }),
    lockAccounts: vi.fn(async (userId?: string) => {
      calls.push(["members.lockAccounts", userId].filter(Boolean).join(":"));
    }),
    lockJoiningAccountForShare: vi.fn(async () => {
      calls.push("members.lockJoiningAccountForShare");
      return true;
    }),
    lockRestoredAccount: vi.fn(async (userId: string) => {
      calls.push(`members.lockRestoredAccount:${userId}`);
      return true;
    }),
  } satisfies IMemberRepository;

  const createGroup = vi.fn(async (name: string, options: CreateGroupOptions = {}): Promise<Organization> => {
    calls.push(`createGroup:${name}`);
    return {
      id: options.id ?? randomUUID(),
      name,
      type: "group",
      ownerUserId: null,
      createdAt: NOW,
      logoId: options.logo?.logoId ?? null,
      logoContentType: options.logo?.contentType ?? null,
    };
  });

  /** The organization's invitations, in any state, by id, with their current token's hash. */
  const invitationRows = new Map<string, LockedInvitation>();
  const isPending = (row: LockedInvitation) => row.acceptedAt === null && row.revokedAt === null;
  const withoutHash = ({ tokenHash: _hash, ...invitation }: LockedInvitation) => invitation;
  /** Sets `values` on a pending invitation; whether it was one. */
  const updatePending = (id: string, values: Partial<LockedInvitation>) => {
    const row = invitationRows.get(id);
    if (!row || !isPending(row)) return false;
    invitationRows.set(id, { ...row, ...values });
    return true;
  };

  const invitations = {
    create: vi.fn(async (input: CreateInvitationInput) => {
      calls.push(`invitations.create:${input.role}`);
      const row: LockedInvitation = {
        id: randomUUID(),
        organizationId: organization.id,
        email: input.email,
        role: input.role,
        invitedByUserId: input.invitedByUserId,
        expiresAt: input.expiresAt,
        createdAt: NOW,
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
        tokenHash: input.tokenHash,
      };
      invitationRows.set(row.id, row);
      return withoutHash(row);
    }),
    listPending: vi.fn(async () => {
      calls.push("invitations.listPending");
      return [...invitationRows.values()].filter(isPending).map(withoutHash);
    }),
    findPending: vi.fn(async (id: string) => {
      const row = invitationRows.get(id);
      return row && isPending(row) ? withoutHash(row) : undefined;
    }),
    findPendingByEmail: vi.fn(async (email: string) => {
      calls.push("invitations.findPendingByEmail");
      const row = [...invitationRows.values()].find((candidate) => isPending(candidate) && candidate.email === email);
      return row ? withoutHash(row) : undefined;
    }),
    lockForUpdate: vi.fn(async (id: string) => {
      calls.push(`invitations.lockForUpdate:${id}`);
      const row = invitationRows.get(id);
      return row ? { ...row } : undefined;
    }),
    reissue: vi.fn(async (id: string, tokenHash: string, expiresAt: Date, _at: Date) => {
      calls.push("invitations.reissue");
      return updatePending(id, { tokenHash, expiresAt });
    }),
    revoke: vi.fn(async (id: string, at: Date) => {
      calls.push(`invitations.revoke:${at.toISOString()}`);
      return updatePending(id, { revokedAt: at });
    }),
    markAccepted: vi.fn(async () => {
      throw new Error("not used by inviting, listing, resending or cancelling");
    }),
    revokePendingInvitedBy: vi.fn(async (userId: string, at: Date) => {
      calls.push(`invitations.revokePendingInvitedBy:${userId}`);
      const revoked = [...invitationRows.values()].filter(
        (row) => isPending(row) && row.invitedByUserId === userId,
      );
      for (const row of revoked) updatePending(row.id, { revokedAt: at });
      return revoked.map(withoutHash);
    }),
  } satisfies IInvitationRepository;

  /** An invitation of the organization, pending unless `overrides` say otherwise. */
  function invitation(overrides: Partial<LockedInvitation> = {}): LockedInvitation {
    const row: LockedInvitation = {
      id: randomUUID(),
      organizationId: organization.id,
      email: `invitee-${randomUUID()}@example.com`,
      role: "contributor",
      invitedByUserId: null,
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      createdAt: NOW,
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
      tokenHash: "a".repeat(64),
      ...overrides,
    };
    invitationRows.set(row.id, row);
    return row;
  }

  const audit = {
    record: vi.fn(async (event: AuditEvent) => {
      auditEvents.push(event);
    }),
  } satisfies IAuditRepository;

  /** How many transactions are open: an email sent with one open would go out before its commit. */
  const transactions = { open: 0 };

  /** Every message sent, with how many transactions were open as it went. */
  const sent: Array<{ message: EmailMessage; openTransactions: number }> = [];
  const mailerState = { isFailing: false };
  const sendFailure = new Error("the relay refused the message");
  const mailer = {
    send: vi.fn(async (message: EmailMessage) => {
      if (mailerState.isFailing) throw sendFailure;
      sent.push({ message, openTransactions: transactions.open });
    }),
  } satisfies IMailer;

  const consumeInvitationEmail = vi.fn((_userId: string) => {
    calls.push("consumeInvitationEmail");
  });
  const log = { error: vi.fn(), warn: vi.fn() };

  /**
   * The logos' store (D23-2): every write and removal, with the logo id it
   * named and how many transactions were open as it ran. Writes and
   * removals fail on demand.
   */
  const storeEvents: Array<{ operation: "write" | "remove"; logoId: string; openTransactions: number }> = [];
  const storeState = { isWriteFailing: false, isRemoveFailing: false };
  const logoIdOf = (key: FileKey) => (key.kind === "organization-logo" ? key.logoId : `unexpected:${key.kind}`);
  const fileStore = {
    write: vi.fn(async (key: FileKey) => {
      storeEvents.push({ operation: "write", logoId: logoIdOf(key), openTransactions: transactions.open });
      if (storeState.isWriteFailing) throw new Error("the disk is full");
      return { sizeBytes: 8, sha256: "0".repeat(64) };
    }),
    read: vi.fn(async () => {
      throw new Error("not used by the organization service");
    }),
    copy: vi.fn(async () => {
      throw new Error("not used by the organization service");
    }),
    remove: vi.fn(async (key: FileKey) => {
      storeEvents.push({ operation: "remove", logoId: logoIdOf(key), openTransactions: transactions.open });
      if (storeState.isRemoveFailing) throw Object.assign(new Error("read-only"), { code: "EROFS", syscall: "unlink" });
    }),
  } satisfies IFileStore;
  const nextId = vi.fn(async () => randomUUID());

  /** Every transaction opened is logged in `contexts`, with the context it carried. */
  const withTransaction: WithOrganizationTransaction = async (context, work) => {
    contexts.push(context);
    transactions.open += 1;
    try {
      return await work({
        organizations: { createGroup },
        audit,
        active: { organization: activeOrganization, members, invitations },
        enterOrganization: async (organizationId) => {
          calls.push(`enterOrganization:${organizationId}`);
          entered.push(organizationId);
          return { organization: activeOrganization, members, invitations };
        },
      });
    } finally {
      transactions.open -= 1;
    }
  };

  const opampRegistration = { created: vi.fn(), renamed: vi.fn(), deleted: vi.fn() };
  /** The product admins' switch as the service reads it (D36-1 decision 51): off unless a test turns it on. */
  const creationState: { value: OrganizationCreation } = { value: "everyone" };
  const service = createOrganizationService({
    withTransaction,
    now: () => NOW,
    mailer,
    publicWebUrl: "https://app.telflo.test",
    consumeInvitationEmail,
    log,
    opampRegistration,
    fileStore,
    nextId,
    organizationCreation: async () => creationState.value,
    registration,
  });

  /** A caller acting in the organization, as `authenticate` read their role, and as the lock re-reads it. Not a product admin. */
  function actor(role: OrganizationRole = "admin", lockedRole: OrganizationRole | "removed" = role): CreatingActor {
    const userId = randomUUID();
    people.set(userId, {
      userId,
      email: "admin@example.com",
      role: lockedRole === "removed" ? role : lockedRole,
      isOrganizationOwner: false,
      createdAt: NOW,
      deletedAt: lockedRole === "removed" ? NOW : null,
      isServiceAccount: false,
    });
    return {
      context: { userId, organizationId: organization.id, role },
      email: "admin@example.com",
      ...origin,
      isProductAdmin: false,
    };
  }

  /** Another member of the organization, whom the caller acts on. */
  function member(role: OrganizationRole = "contributor", overrides: Partial<Member> = {}): Member {
    const added: Member = {
      userId: randomUUID(),
      email: "member@example.com",
      role,
      isOrganizationOwner: false,
      createdAt: NOW,
      deletedAt: null,
      isServiceAccount: false,
      ...overrides,
    };
    people.set(added.userId, added);
    return added;
  }

  return {
    service,
    calls,
    auditEvents,
    contexts,
    entered,
    organization,
    state,
    activeOrganization,
    members,
    createGroup,
    actor,
    member,
    invitations,
    invitationRows,
    invitation,
    sent,
    mailer,
    mailerState,
    sendFailure,
    consumeInvitationEmail,
    log,
    fileStore,
    storeEvents,
    storeState,
    nextId,
    opampRegistration,
    creationState,
  };
}

let harness: ReturnType<typeof buildHarness>;

beforeEach(() => {
  harness = buildHarness();
});

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("create", () => {
  it("creates the group organization, enters it, adds the caller as admin and audits both, in that order", async () => {
    const actor = harness.actor("contributor");

    const created = await harness.service.create(actor, "Beta");

    expect(created).toMatchObject({ name: "Beta", type: "group", ownerUserId: null });
    expect(harness.contexts).toEqual([actor.context]);
    expect(harness.calls).toEqual(["createGroup:Beta", `enterOrganization:${created.id}`, "members.add:admin"]);
    expect(harness.members.add).toHaveBeenCalledWith({ userId: actor.context.userId, role: "admin" });
    const shared = { actorUserId: actor.context.userId, actorEmail: actor.email, organizationId: created.id, ...origin };
    expect(harness.auditEvents).toEqual([
      {
        action: "organization.created",
        subjectType: "organization",
        subjectId: created.id,
        metadata: { type: "group", name: "Beta" },
        ...shared,
      },
      {
        action: "organization_member.added",
        subjectType: "user",
        subjectId: actor.context.userId,
        metadata: { role: "admin" },
        ...shared,
      },
    ]);
  });

  describe("the product admins' switch (D36-1 decision 51)", () => {
    it("refuses a person who isn't a product admin with 403 organization_creation_restricted while it is on, before any id, logo byte or transaction", async () => {
      harness.creationState.value = "product-admins";
      const actor = harness.actor();

      const prepared = await refusal(harness.service.prepareCreate(actor));
      const created = await refusal(
        harness.service.create(actor, "Beta", { organizationId: randomUUID(), logo: newLogo() }),
      );

      for (const error of [prepared, created]) {
        expect(error).toMatchObject({
          code: "organization_creation_restricted",
          statusCode: 403,
          message: "Only product admins can create organizations on this site.",
        });
      }
      expect(harness.nextId).not.toHaveBeenCalled();
      expect(harness.storeEvents).toEqual([]);
      expect(harness.contexts).toEqual([]);
      expect(harness.auditEvents).toEqual([]);
      expect(harness.opampRegistration.created).not.toHaveBeenCalled();
    });

    it("lets a product admin create one while it is on", async () => {
      harness.creationState.value = "product-admins";
      const actor = { ...harness.actor(), isProductAdmin: true };

      const ids = await harness.service.prepareCreate(actor);
      const created = await harness.service.create(actor, "Beta", { organizationId: ids.organizationId, logo: newLogo() });

      expect(created).toMatchObject({ name: "Beta", type: "group" });
      expect(harness.storeEvents.map((event) => event.operation)).toEqual(["write"]);
    });

    it("lets anyone create one while it is off", async () => {
      await expect(harness.service.create(harness.actor("contributor"), "Beta")).resolves.toMatchObject({ name: "Beta" });
    });
  });

  it("answers a name clash with 409 organization_name_taken, and adds and audits nothing", async () => {
    harness.createGroup.mockRejectedValueOnce(new OrganizationNameTakenError());

    const error = await refusal(harness.service.create(harness.actor(), "Acme"));

    expect(error).toMatchObject({
      code: "organization_name_taken",
      statusCode: 409,
      message: "That name is invalid or already exists",
    });
    expect(harness.members.add).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([]);
  });

  it("lets any other failure through as it is", async () => {
    const failure = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "organizations_pkey" });
    harness.createGroup.mockRejectedValueOnce(failure);
    await expect(harness.service.create(harness.actor(), "Acme")).rejects.toBe(failure);
  });
});

describe.each([
  ["change", (actor: Actor, organizationId: string) => harness.service.change(actor, organizationId, { name: "Renamed" })],
  ["delete", (actor: Actor, organizationId: string) => harness.service.delete(actor, organizationId)],
] as const)("%s", (_name, act) => {
  it("answers any organization but the active one with 404 organization_not_found, before the role check", async () => {
    const error = await refusal(act(harness.actor("contributor"), randomUUID()));
    expect(error).toMatchObject({ code: "organization_not_found", statusCode: 404, message: "Organization not found" });
    expect(harness.contexts).toEqual([]);
  });

  it("refuses a contributor with 403 organization_admin_required without opening a transaction", async () => {
    const error = await refusal(act(harness.actor("contributor"), harness.organization.id));
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.contexts).toEqual([]);
  });

  it.each([
    ["demoted", "contributor"],
    ["removed", "removed"],
  ] as const)("re-checks under the lock: an admin %s meanwhile gets 403 and changes nothing", async (_label, locked) => {
    const error = await refusal(act(harness.actor("admin", locked), harness.organization.id));
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.calls).toEqual(["lockActive", "members.find"]);
    expect(harness.auditEvents).toEqual([]);
  });

  it("answers an organization deleted before the lock with 404", async () => {
    harness.state.isLive = false;
    const error = await refusal(act(harness.actor(), harness.organization.id));
    expect(error).toMatchObject({ code: "organization_not_found", statusCode: 404 });
    expect(harness.calls).toEqual(["lockActive"]);
  });
});

describe("change: the name", () => {
  it("renames under the lock and audits from and to", async () => {
    const actor = harness.actor();
    const renamed = await harness.service.change(actor, harness.organization.id, { name: "Renamed" });

    expect(renamed).toMatchObject({ id: harness.organization.id, name: "Renamed" });
    expect(harness.calls).toEqual(["lockActive", "members.find", "rename:Renamed"]);
    expect(harness.auditEvents).toEqual([
      {
        action: "organization.renamed",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "organization",
        subjectId: harness.organization.id,
        metadata: { from: "Acme", to: "Renamed" },
        ...origin,
      },
    ]);
  });

  it("changes and audits nothing for the current name", async () => {
    const renamed = await harness.service.change(harness.actor(), harness.organization.id, { name: "Acme" });
    expect(renamed).toMatchObject({ name: "Acme" });
    expect(harness.activeOrganization.rename).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([]);
  });

  it("answers a name clash with 409 organization_name_taken", async () => {
    harness.activeOrganization.rename.mockRejectedValueOnce(new OrganizationNameTakenError());
    const error = await refusal(harness.service.change(harness.actor(), harness.organization.id, { name: "Taken" }));
    expect(error).toMatchObject({ code: "organization_name_taken", statusCode: 409 });
    expect(harness.auditEvents).toEqual([]);
  });
});

describe("delete", () => {
  it("marks it deleted, deletes the accounts only in it, reassigns every session, then audits the counts", async () => {
    const actor = harness.actor();

    await harness.service.delete(actor, harness.organization.id);

    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      "members.lockAccounts",
      `markDeleted:${NOW.toISOString()}`,
      "deleteAccountsOnlyInOrganization",
      "reassignSessionsLeavingOrganization",
    ]);
    expect(harness.activeOrganization.reassignSessionsLeavingOrganization).toHaveBeenCalledWith();
    expect(harness.auditEvents).toEqual([
      {
        action: "organization.deleted",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "organization",
        subjectId: harness.organization.id,
        metadata: { deletedAccounts: 1, reassignedSessions: 3 },
        ...origin,
      },
    ]);
  });

  it("refuses a personal organization with 409 personal_organization_protected, after the admin re-check", async () => {
    harness.organization.type = "personal";
    const error = await refusal(harness.service.delete(harness.actor(), harness.organization.id));
    expect(error).toMatchObject({ code: "personal_organization_protected", statusCode: 409 });
    expect(harness.calls).toEqual(["lockActive", "members.find"]);
    expect(harness.auditEvents).toEqual([]);
  });
});

/** A logo as the route hands it on: read whole and typed already (D23-2 decisions 32 to 34). */
function newLogo(): NewLogo {
  return { logoId: randomUUID(), contentType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
}

/** The organization's logo audit rows' keys: ids only (D23-2 decision 37). */
const logoAudits = () =>
  harness.auditEvents
    .filter((event) => event.action.startsWith("organization.logo_"))
    .map((event) => ({ action: event.action, metadataKeys: Object.keys(event.metadata ?? {}).sort() }));

describe("logos (D23-2 decisions 15, 35 to 38)", () => {
  describe("create", () => {
    it("picks both ids before anything, then writes the bytes outside any transaction, then the one transaction with the logo and its audit", async () => {
      const ids = await harness.service.prepareCreate(harness.actor("contributor"));
      expect(harness.nextId).toHaveBeenCalledTimes(2);
      expect(ids.organizationId).not.toBe(ids.logoId);
      const logo = { ...newLogo(), logoId: ids.logoId };
      const actor = harness.actor("contributor");

      const created = await harness.service.create(actor, "Beta", { organizationId: ids.organizationId, logo });

      expect(created).toMatchObject({ id: ids.organizationId, logoId: ids.logoId, logoContentType: "image/png" });
      expect(harness.createGroup).toHaveBeenCalledWith("Beta", {
        id: ids.organizationId,
        logo: { logoId: ids.logoId, contentType: "image/png" },
      });
      expect(harness.storeEvents).toEqual([{ operation: "write", logoId: ids.logoId, openTransactions: 0 }]);
      expect(harness.fileStore.write.mock.calls[0]![0]).toEqual({
        kind: "organization-logo",
        organizationId: ids.organizationId,
        logoId: ids.logoId,
      });
      expect(harness.auditEvents.map((event) => event.action)).toEqual([
        "organization.created",
        "organization_member.added",
        "organization.logo_changed",
      ]);
      expect(harness.auditEvents[2]).toMatchObject({
        subjectType: "organization",
        subjectId: ids.organizationId,
        metadata: { logoId: ids.logoId },
      });
      expect(logoAudits()).toEqual([{ action: "organization.logo_changed", metadataKeys: ["logoId"] }]);
      expect(harness.opampRegistration.created).toHaveBeenCalledTimes(1);
    });

    it("without a logo never calls the store", async () => {
      await harness.service.create(harness.actor(), "Beta");
      expect(harness.storeEvents).toEqual([]);
      expect(harness.createGroup).toHaveBeenCalledWith("Beta", {});
    });

    it.each([
      ["a name clash", () => harness.createGroup.mockRejectedValueOnce(new OrganizationNameTakenError())],
      ["the transaction's failure", () => harness.members.add.mockRejectedValueOnce(new Error("connection lost"))],
    ])("removes the written bytes after %s, quietly, and registers nothing", async (_label, fail) => {
      fail();
      const organizationId = randomUUID();
      const logo = newLogo();

      await expect(harness.service.create(harness.actor(), "Beta", { organizationId, logo })).rejects.toBeDefined();

      expect(harness.storeEvents).toEqual([
        { operation: "write", logoId: logo.logoId, openTransactions: 0 },
        { operation: "remove", logoId: logo.logoId, openTransactions: 0 },
      ]);
      expect(harness.opampRegistration.created).not.toHaveBeenCalled();
    });

    it("removes after a rejected write too (a store may leave a file behind one), and opens no transaction", async () => {
      harness.storeState.isWriteFailing = true;
      const logo = newLogo();

      await expect(
        harness.service.create(harness.actor(), "Beta", { organizationId: randomUUID(), logo }),
      ).rejects.toThrow("the disk is full");

      expect(harness.storeEvents.map((event) => event.operation)).toEqual(["write", "remove"]);
      expect(harness.contexts).toEqual([]);
    });

    it("answers with the transaction's own error when the removal fails too, and logs its codes only", async () => {
      harness.createGroup.mockRejectedValueOnce(new OrganizationNameTakenError());
      harness.storeState.isRemoveFailing = true;

      const error = await refusal(harness.service.create(harness.actor(), "Beta", { organizationId: randomUUID(), logo: newLogo() }));

      expect(error.code).toBe("organization_name_taken");
      expect(harness.log.warn).toHaveBeenCalledTimes(1);
      const [fields] = harness.log.warn.mock.calls[0]! as [Record<string, unknown>];
      expect(Object.keys(fields).sort()).toEqual(["code", "organizationId", "syscall"]);
    });
  });

  describe("change", () => {
    it("checks the active organization and the role before picking the new logo's id", async () => {
      await expect(harness.service.prepareChange(harness.actor(), randomUUID())).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        harness.service.prepareChange(harness.actor("contributor"), harness.organization.id),
      ).rejects.toMatchObject({ code: "organization_admin_required", statusCode: 403 });
      expect(harness.nextId).not.toHaveBeenCalled();
      const { logoId } = await harness.service.prepareChange(harness.actor(), harness.organization.id);
      expect(logoId).toEqual(expect.any(String));
    });

    it("writes the new bytes before the transaction, sets the logo under the lock, audits, and removes the old bytes after the commit", async () => {
      const old = randomUUID();
      harness.organization.logoId = old;
      harness.organization.logoContentType = "image/jpeg";
      const logo = newLogo();

      const changed = await harness.service.change(harness.actor(), harness.organization.id, { name: "Acme", logo });

      expect(changed).toMatchObject({ name: "Acme", logoId: logo.logoId, logoContentType: "image/png" });
      expect(harness.calls).toEqual(["lockActive", "members.find", `setLogo:${logo.logoId}`]);
      expect(harness.storeEvents).toEqual([
        { operation: "write", logoId: logo.logoId, openTransactions: 0 },
        { operation: "remove", logoId: old, openTransactions: 0 },
      ]);
      // The removal came after the transaction's audit row: after the commit.
      expect(harness.fileStore.remove.mock.invocationCallOrder[0]!).toBeGreaterThan(
        harness.activeOrganization.setLogo.mock.invocationCallOrder[0]!,
      );
      expect(logoAudits()).toEqual([{ action: "organization.logo_changed", metadataKeys: ["logoId"] }]);
      expect(harness.auditEvents[0]).toMatchObject({ metadata: { logoId: logo.logoId }, subjectId: harness.organization.id });
      // The name kept: nothing for the opamp-server.
      expect(harness.opampRegistration.renamed).not.toHaveBeenCalled();
    });

    it("renames and sets the logo in one transaction, audits both, and tells the opamp-server of the rename", async () => {
      const logo = newLogo();

      await harness.service.change(harness.actor(), harness.organization.id, { name: "Renamed", logo });

      expect(harness.calls).toEqual(["lockActive", "members.find", "rename:Renamed", `setLogo:${logo.logoId}`]);
      expect(harness.auditEvents.map((event) => event.action)).toEqual(["organization.renamed", "organization.logo_changed"]);
      // No old logo: nothing removed.
      expect(harness.storeEvents.map((event) => event.operation)).toEqual(["write"]);
      expect(harness.opampRegistration.renamed).toHaveBeenCalledTimes(1);
    });

    it("removes the logo: clears the columns, audits organization.logo_removed with {}, removes the old bytes after the commit", async () => {
      const old = randomUUID();
      harness.organization.logoId = old;
      harness.organization.logoContentType = "image/webp";

      const changed = await harness.service.change(harness.actor(), harness.organization.id, { name: "Acme", removeLogo: true });

      expect(changed).toMatchObject({ logoId: null, logoContentType: null });
      expect(harness.calls).toEqual(["lockActive", "members.find", "setLogo:none"]);
      expect(harness.auditEvents).toHaveLength(1);
      expect(harness.auditEvents[0]).toMatchObject({ action: "organization.logo_removed", metadata: {} });
      expect(harness.storeEvents).toEqual([{ operation: "remove", logoId: old, openTransactions: 0 }]);
    });

    it("removing when there is none, with the current name, changes, audits and removes nothing", async () => {
      const changed = await harness.service.change(harness.actor(), harness.organization.id, { name: "Acme", removeLogo: true });

      expect(changed).toMatchObject({ name: "Acme", logoId: null });
      expect(harness.calls).toEqual(["lockActive", "members.find"]);
      expect(harness.auditEvents).toEqual([]);
      expect(harness.storeEvents).toEqual([]);
      expect(harness.opampRegistration.renamed).not.toHaveBeenCalled();
    });

    it("the current name and no logo change is a no-op: nothing written, audited or sent", async () => {
      harness.organization.logoId = randomUUID();
      harness.organization.logoContentType = "image/png";
      await harness.service.change(harness.actor(), harness.organization.id, { name: "Acme" });
      expect(harness.calls).toEqual(["lockActive", "members.find"]);
      expect(harness.auditEvents).toEqual([]);
      expect(harness.storeEvents).toEqual([]);
      expect(harness.opampRegistration.renamed).not.toHaveBeenCalled();
    });

    it.each([
      ["a name clash", () => harness.activeOrganization.rename.mockRejectedValueOnce(new OrganizationNameTakenError())],
      ["the lock's re-check (demoted meanwhile)", () => undefined],
      ["the logo's columns failing", () => harness.activeOrganization.setLogo.mockRejectedValueOnce(new Error("connection lost"))],
    ])("after %s, removes the new bytes, keeps the old ones and the name, and audits nothing", async (label, fail) => {
      fail();
      const old = randomUUID();
      harness.organization.logoId = old;
      harness.organization.logoContentType = "image/png";
      const actor = label.startsWith("the lock") ? harness.actor("admin", "contributor") : harness.actor();
      const logo = newLogo();

      await expect(harness.service.change(actor, harness.organization.id, { name: "Renamed", logo })).rejects.toBeDefined();

      expect(harness.storeEvents).toEqual([
        { operation: "write", logoId: logo.logoId, openTransactions: 0 },
        { operation: "remove", logoId: logo.logoId, openTransactions: 0 },
      ]);
      expect(harness.auditEvents).toEqual([]);
      expect(harness.opampRegistration.renamed).not.toHaveBeenCalled();
    });

    it("a contributor is refused before any write", async () => {
      const error = await refusal(
        harness.service.change(harness.actor("contributor"), harness.organization.id, { name: "Acme", logo: newLogo() }),
      );
      expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
      expect(harness.storeEvents).toEqual([]);
    });

    it("a failed removal of the old bytes after the commit is logged with codes only, and the change stands", async () => {
      harness.organization.logoId = randomUUID();
      harness.organization.logoContentType = "image/png";
      harness.storeState.isRemoveFailing = true;
      const logo = newLogo();

      const changed = await harness.service.change(harness.actor(), harness.organization.id, { name: "Acme", logo });

      expect(changed.logoId).toBe(logo.logoId);
      expect(harness.log.warn).toHaveBeenCalledTimes(1);
      const [fields, message] = harness.log.warn.mock.calls[0]! as [Record<string, unknown>, string];
      expect(fields).toEqual({ organizationId: harness.organization.id, code: "EROFS", syscall: "unlink" });
      expect(message).toBe("an organization's logo's bytes could not be removed");
    });
  });

  describe("delete", () => {
    it("removes the logo's bytes after the commit, its id read from the locked row", async () => {
      const logoId = randomUUID();
      harness.organization.logoId = logoId;
      harness.organization.logoContentType = "image/png";

      await harness.service.delete(harness.actor(), harness.organization.id);

      expect(harness.storeEvents).toEqual([{ operation: "remove", logoId, openTransactions: 0 }]);
      expect(harness.fileStore.remove.mock.invocationCallOrder[0]!).toBeGreaterThan(
        harness.activeOrganization.reassignSessionsLeavingOrganization.mock.invocationCallOrder[0]!,
      );
    });

    it("an organization with no logo never calls the store", async () => {
      await harness.service.delete(harness.actor(), harness.organization.id);
      expect(harness.storeEvents).toEqual([]);
    });

    it("a refused delete removes nothing", async () => {
      harness.organization.logoId = randomUUID();
      harness.organization.logoContentType = "image/png";
      harness.organization.type = "personal";
      await expect(harness.service.delete(harness.actor(), harness.organization.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(harness.storeEvents).toEqual([]);
    });
  });
});

describe("listMembers", () => {
  it("lists every member for an admin", async () => {
    const actor = harness.actor();
    const member = harness.member("contributor", { deletedAt: NOW });

    const members = await harness.service.listMembers(actor, harness.organization.id);

    expect(members.map((listed) => listed.userId)).toEqual([actor.context.userId, member.userId]);
    expect(harness.contexts).toEqual([actor.context]);
  });

  it("answers any organization but the active one with 404, before the role check", async () => {
    const error = await refusal(harness.service.listMembers(harness.actor("contributor"), randomUUID()));
    expect(error).toMatchObject({ code: "organization_not_found", statusCode: 404 });
    expect(harness.contexts).toEqual([]);
  });

  it("refuses a contributor with 403 organization_admin_required", async () => {
    const error = await refusal(harness.service.listMembers(harness.actor("contributor"), harness.organization.id));
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.members.list).not.toHaveBeenCalled();
  });
});

type MemberChange = (actor: Actor, organizationId: string, userId: string) => Promise<void>;

const changeRoleToContributor: MemberChange = (actor, organizationId, userId) =>
  harness.service.changeMemberRole(actor, organizationId, userId, "contributor");
const removeMember: MemberChange = (actor, organizationId, userId) =>
  harness.service.removeMember(actor, organizationId, userId);
const restoreMember: MemberChange = (actor, organizationId, userId) =>
  harness.service.restoreMember(actor, organizationId, userId);

describe.each([
  ["changeMemberRole", changeRoleToContributor],
  ["removeMember", removeMember],
  ["restoreMember", restoreMember],
] as const)("%s", (_name, act) => {
  it("answers any organization but the active one with 404 organization_not_found, before the role check", async () => {
    const member = harness.member();
    const error = await refusal(act(harness.actor("contributor"), randomUUID(), member.userId));
    expect(error).toMatchObject({ code: "organization_not_found", statusCode: 404 });
    expect(harness.contexts).toEqual([]);
  });

  it("refuses a contributor with 403 organization_admin_required without opening a transaction", async () => {
    const member = harness.member();
    const error = await refusal(act(harness.actor("contributor"), harness.organization.id, member.userId));
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.contexts).toEqual([]);
  });

  it.each([
    ["demoted", "contributor"],
    ["removed", "removed"],
  ] as const)("re-checks under the lock: an admin %s meanwhile gets 403 and changes nothing", async (_label, locked) => {
    const member = harness.member("contributor", { deletedAt: NOW });
    const error = await refusal(act(harness.actor("admin", locked), harness.organization.id, member.userId));
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.calls).toEqual(["lockActive", "members.find"]);
    expect(harness.auditEvents).toEqual([]);
  });

  it("answers an organization deleted before the lock with 404", async () => {
    harness.state.isLive = false;
    const member = harness.member();
    const error = await refusal(act(harness.actor(), harness.organization.id, member.userId));
    expect(error).toMatchObject({ code: "organization_not_found", statusCode: 404 });
    expect(harness.calls).toEqual(["lockActive"]);
  });

  it.each([
    ["an unknown member", () => randomUUID()],
    ["an id that isn't a UUID", () => "not-a-member"],
    ["a UUID spelled without hyphens", () => randomUUID().replaceAll("-", "")],
  ])("answers %s with 404 member_not_found", async (_label, userId) => {
    const error = await refusal(act(harness.actor(), harness.organization.id, userId()));
    expect(error).toMatchObject({ code: "member_not_found", statusCode: 404, message: "Member not found" });
    expect(harness.auditEvents).toEqual([]);
  });
});

describe.each([
  ["changeMemberRole", changeRoleToContributor, "You cannot change your own role"],
  ["removeMember", removeMember, "You cannot remove yourself from the organization"],
] as const)("%s's refusals", (_name, act, ownMessage) => {
  it("refuses the caller's own membership with 409 cannot_change_own_membership, after the lock", async () => {
    const actor = harness.actor();
    const error = await refusal(act(actor, harness.organization.id, actor.context.userId));
    expect(error).toMatchObject({ code: "cannot_change_own_membership", statusCode: 409, message: ownMessage });
    expect(harness.calls).toEqual(["lockActive", "members.find"]);
  });

  it("refuses the caller's own id in capitals too, which Postgres would match to their row", async () => {
    const actor = harness.actor();
    const error = await refusal(act(actor, harness.organization.id, actor.context.userId.toUpperCase()));
    expect(error).toMatchObject({ code: "cannot_change_own_membership", statusCode: 409 });
    expect(harness.members.changeRole).not.toHaveBeenCalled();
    expect(harness.members.remove).not.toHaveBeenCalled();
  });

  it("refuses the personal organization's owner with 409 personal_organization_protected", async () => {
    const owner = harness.member("admin", { isOrganizationOwner: true });
    harness.organization.type = "personal";
    harness.organization.ownerUserId = owner.userId;
    const error = await refusal(act(harness.actor(), harness.organization.id, owner.userId));
    expect(error).toMatchObject({
      code: "personal_organization_protected",
      statusCode: 409,
      message: "The owner of a personal organization can't be removed or have their role changed",
    });
    expect(harness.calls).toEqual(["lockActive", "members.find"]);
    expect(harness.auditEvents).toEqual([]);
  });
});

describe("changeMemberRole", () => {
  it("changes the role under the lock and audits from and to", async () => {
    const actor = harness.actor();
    const member = harness.member("contributor");

    await harness.service.changeMemberRole(actor, harness.organization.id, member.userId, "admin");

    expect(harness.calls).toEqual(["lockActive", "members.find", "members.find", "members.changeRole:admin"]);
    expect(harness.members.changeRole).toHaveBeenCalledWith(member.userId, "admin");
    expect(harness.auditEvents).toEqual([
      {
        action: "organization_member.role_changed",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "user",
        subjectId: member.userId,
        metadata: { from: "contributor", to: "admin" },
        ...origin,
      },
    ]);
  });

  it(
    "demoting an admin to contributor cancels the invitations they sent, before the membership's update, and counts them (D6 Ruling 17)",
    async () => {
      const role = "contributor";
      const actor = harness.actor();
      const member = harness.member("admin");
      const theirs = harness.invitation({ invitedByUserId: member.userId });
      const others = harness.invitation({ invitedByUserId: actor.context.userId });

      await harness.service.changeMemberRole(actor, harness.organization.id, member.userId, role);

      expect(harness.calls).toEqual([
        "lockActive",
        "members.find",
        "members.find",
        `invitations.revokePendingInvitedBy:${member.userId}`,
        `members.changeRole:${role}`,
      ]);
      expect(harness.invitationRows.get(theirs.id)!.revokedAt).toEqual(NOW);
      expect(harness.invitationRows.get(others.id)!.revokedAt).toBeNull();
      expect(harness.auditEvents).toEqual([
        expect.objectContaining({
          action: "organization_invitation.revoked",
          subjectType: "organization_invitation",
          subjectId: theirs.id,
          metadata: { via: "organization_member.role_changed" },
        }),
        expect.objectContaining({
          action: "organization_member.role_changed",
          subjectId: member.userId,
          metadata: { from: "admin", to: role, revokedInvitations: 1 },
        }),
      ]);
    },
  );

  it("promoting a contributor cancels nothing", async () => {
    const actor = harness.actor();
    const member = harness.member("contributor");
    const theirs = harness.invitation({ invitedByUserId: member.userId });

    await harness.service.changeMemberRole(actor, harness.organization.id, member.userId, "admin");

    expect(harness.invitations.revokePendingInvitedBy).not.toHaveBeenCalled();
    expect(harness.invitationRows.get(theirs.id)!.revokedAt).toBeNull();
    expect(harness.auditEvents).toEqual([
      expect.objectContaining({
        action: "organization_member.role_changed",
        metadata: { from: "contributor", to: "admin" },
      }),
    ]);
  });

  it("changes and audits nothing for the role the member already has", async () => {
    const member = harness.member("contributor");
    await harness.service.changeMemberRole(harness.actor(), harness.organization.id, member.userId, "contributor");
    expect(harness.members.changeRole).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([]);
  });

  it("refuses a removed member with 409 member_not_active", async () => {
    const member = harness.member("contributor", { deletedAt: NOW });
    const error = await refusal(
      harness.service.changeMemberRole(harness.actor(), harness.organization.id, member.userId, "admin"),
    );
    expect(error).toMatchObject({
      code: "member_not_active",
      statusCode: 409,
      message: "Only active members can have their role changed",
    });
    expect(harness.members.changeRole).not.toHaveBeenCalled();
  });
});

describe("removeMember", () => {
  it("removes the member, reassigns their sessions acting here, then audits the count", async () => {
    const actor = harness.actor();
    const member = harness.member("contributor");
    // Not an admin's: only an admin's invitations go with them (D6 Ruling 17).
    harness.invitation({ invitedByUserId: member.userId });

    await harness.service.removeMember(actor, harness.organization.id, member.userId.toUpperCase());

    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      "members.find",
      `members.lockAccounts:${member.userId}`,
      `members.remove:${NOW.toISOString()}`,
      `reassignSessionsLeavingOrganization:${member.userId}`,
    ]);
    expect(harness.auditEvents).toEqual([
      {
        action: "organization_member.removed",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "user",
        subjectId: member.userId,
        metadata: { reassignedSessions: 3 },
        ...origin,
      },
    ]);
  });

  it("removing an admin cancels their pending invitations first, audits each, and counts them (D6 Ruling 17)", async () => {
    const actor = harness.actor();
    const member = harness.member("admin");
    const theirs = [
      harness.invitation({ invitedByUserId: member.userId }),
      harness.invitation({ invitedByUserId: member.userId, expiresAt: new Date(NOW.getTime() - 1) }),
    ];
    const others = harness.invitation({ invitedByUserId: actor.context.userId });
    const accepted = harness.invitation({ invitedByUserId: member.userId, acceptedAt: NOW });

    await harness.service.removeMember(actor, harness.organization.id, member.userId);

    // After the organization's lock and before the account's: decision 10's order.
    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      "members.find",
      `invitations.revokePendingInvitedBy:${member.userId}`,
      `members.lockAccounts:${member.userId}`,
      `members.remove:${NOW.toISOString()}`,
      `reassignSessionsLeavingOrganization:${member.userId}`,
    ]);
    for (const { id } of theirs) expect(harness.invitationRows.get(id)!.revokedAt).toEqual(NOW);
    expect(harness.invitationRows.get(others.id)!.revokedAt).toBeNull();
    expect(harness.invitationRows.get(accepted.id)!.revokedAt).toBeNull();
    expect(harness.auditEvents).toEqual([
      ...theirs.map(({ id }) => ({
        action: "organization_invitation.revoked",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "organization_invitation",
        subjectId: id,
        metadata: { via: "organization_member.removed" },
        ...origin,
      })),
      expect.objectContaining({
        action: "organization_member.removed",
        subjectId: member.userId,
        metadata: { reassignedSessions: 3, revokedInvitations: 2 },
      }),
    ]);
  });

  it("refuses a removed member with 409 member_not_active", async () => {
    const member = harness.member("contributor", { deletedAt: NOW });
    const error = await refusal(harness.service.removeMember(harness.actor(), harness.organization.id, member.userId));
    expect(error).toMatchObject({
      code: "member_not_active",
      statusCode: 409,
      message: "Only active members can be removed",
    });
    expect(harness.members.remove).not.toHaveBeenCalled();
    expect(harness.activeOrganization.reassignSessionsLeavingOrganization).not.toHaveBeenCalled();
  });
});

describe("restoreMember", () => {
  it("restores a removed member under the lock and audits it", async () => {
    const actor = harness.actor();
    const member = harness.member("contributor", { deletedAt: NOW });

    await harness.service.restoreMember(actor, harness.organization.id, member.userId);

    // The member's account locked after the organization, before the restore (D29 Ruling 272).
    expect(harness.calls).toEqual(["lockActive", "members.find", "members.find", `members.lockRestoredAccount:${member.userId}`, "members.restore"]);
    expect(harness.auditEvents).toEqual([
      {
        action: "organization_member.restored",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "user",
        subjectId: member.userId,
        ...origin,
      },
    ]);
  });

  it.each([
    ["an active member", () => harness.member("contributor").userId],
    ["the caller, who is an active admin", (actor: Actor) => actor.context.userId],
  ])("refuses %s with 409 member_not_removed", async (_label, userIdOf) => {
    const actor = harness.actor();
    const error = await refusal(harness.service.restoreMember(actor, harness.organization.id, userIdOf(actor)));
    expect(error).toMatchObject({
      code: "member_not_removed",
      statusCode: 409,
      message: "Only deleted members can be restored",
    });
    expect(harness.members.restore).not.toHaveBeenCalled();
  });

  it("refuses with 404 member_not_found when the account is deleted under its lock, and restores nothing (D29 Ruling 272)", async () => {
    const actor = harness.actor();
    const member = harness.member("contributor", { deletedAt: NOW });
    harness.members.lockRestoredAccount.mockResolvedValueOnce(false);
    const error = await refusal(harness.service.restoreMember(actor, harness.organization.id, member.userId));
    expect(error).toMatchObject({ code: "member_not_found", statusCode: 404 });
    expect(harness.members.restore).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([]);
  });
});

describe("a service account named by a member change (D22 decision 30)", () => {
  it.each([
    ["a role change", (actor: Actor, userId: string) => harness.service.changeMemberRole(actor, harness.organization.id, userId, "admin"), false],
    ["a removal", (actor: Actor, userId: string) => harness.service.removeMember(actor, harness.organization.id, userId), false],
    ["a restoration", (actor: Actor, userId: string) => harness.service.restoreMember(actor, harness.organization.id, userId), true],
  ])(
    "refuses %s with 409 member_is_service_account right after reading it under the lock, before anything is written",
    async (_label, change, isRemoved) => {
      const actor = harness.actor();
      const serviceAccount = harness.member("contributor", {
        isServiceAccount: true,
        email: "ci-1a2b3c4d@service-accounts.telflo.invalid",
        deletedAt: isRemoved ? NOW : null,
      });

      const error = await refusal(change(actor, serviceAccount.userId));

      expect(error).toMatchObject({
        code: "member_is_service_account",
        statusCode: 409,
        message: "Service accounts are managed in Settings › Service Accounts.",
      });
      // The lock, the caller's re-check, the member: nothing after.
      expect(harness.calls).toEqual(["lockActive", "members.find", "members.find"]);
      expect(harness.auditEvents).toEqual([]);
    },
  );
});

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** The token in an invitation email's link, which is in its fragment. */
function tokenOf(message: EmailMessage): string {
  const match = /https:\/\/app\.telflo\.test\/accept-invitation#token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (!match?.[1]) throw new Error("the email carries no invitation link");
  return match[1];
}

describe("invite", () => {
  it("checks, then creates under the lock, audits, and emails the link only after the commit", async () => {
    const actor = harness.actor();

    const invitation = await harness.service.invite(actor, harness.organization.id, {
      email: "New.Person@Example.com",
      role: "contributor",
    });

    expect(harness.calls).toEqual([
      "consumeInvitationEmail",
      "lockActive",
      "members.find",
      "members.findByEmail",
      "invitations.findPendingByEmail",
      "invitations.create:contributor",
    ]);
    expect(harness.consumeInvitationEmail).toHaveBeenCalledWith(actor.context.userId);
    expect(harness.members.findByEmail).toHaveBeenCalledWith("new.person@example.com");
    expect(invitation).toMatchObject({
      email: "new.person@example.com",
      role: "contributor",
      invitedByUserId: actor.context.userId,
      expiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS),
      isExpired: false,
    });
    expect(invitation).not.toHaveProperty("tokenHash");
    expect(harness.auditEvents).toEqual([
      {
        action: "organization_invitation.created",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "organization_invitation",
        subjectId: invitation.id,
        metadata: { email: "new.person@example.com", role: "contributor" },
        ...origin,
      },
    ]);
    expect(harness.sent).toHaveLength(1);
    const [{ message, openTransactions }] = harness.sent as [(typeof harness.sent)[number]];
    expect(openTransactions).toBe(0);
    expect(message).toMatchObject({
      to: "new.person@example.com",
      subject: "You've been invited to join Acme on Telflo",
    });
    expect(hashToken(tokenOf(message))).toBe(harness.invitationRows.get(invitation.id)!.tokenHash);
  });

  it("answers any organization but the active one with 404, before the role check and the mail limit", async () => {
    const error = await refusal(
      harness.service.invite(harness.actor("contributor"), randomUUID(), { email: "a@example.com", role: "contributor" }),
    );
    expect(error).toMatchObject({ code: "organization_not_found", statusCode: 404 });
    expect(harness.consumeInvitationEmail).not.toHaveBeenCalled();
    expect(harness.contexts).toEqual([]);
  });

  it("refuses a contributor with 403 before the mail limit, without opening a transaction", async () => {
    const error = await refusal(
      harness.service.invite(harness.actor("contributor"), harness.organization.id, {
        email: "a@example.com",
        role: "contributor",
      }),
    );
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.consumeInvitationEmail).not.toHaveBeenCalled();
    expect(harness.contexts).toEqual([]);
  });

  it("refuses an address at the reserved domain with 422 after the role and before the mail limit, opening no transaction (D22 Preflight ruling 13)", async () => {
    const error = await refusal(
      harness.service.invite(harness.actor(), harness.organization.id, {
        email: "CI-1a2b3c4d@Service-Accounts.Telflo.Invalid",
        role: "contributor",
      }),
    );
    expect(error).toMatchObject({ code: "email_reserved", statusCode: 422, message: "This address can't be used" });
    expect(harness.consumeInvitationEmail).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
    expect(harness.contexts).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("checks the role before the reserved domain: a contributor is 403", async () => {
    const error = await refusal(
      harness.service.invite(harness.actor("contributor"), harness.organization.id, {
        email: "ci-1a2b3c4d@service-accounts.telflo.invalid",
        role: "contributor",
      }),
    );
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
  });

  it("lets the mail limit's 429 through before any transaction", async () => {
    const limited = new AppError("rate_limited", "Too many attempts. Please wait and try again.", 429);
    harness.consumeInvitationEmail.mockImplementationOnce(() => {
      throw limited;
    });
    await expect(
      harness.service.invite(harness.actor(), harness.organization.id, { email: "a@example.com", role: "contributor" }),
    ).rejects.toBe(limited);
    expect(harness.contexts).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it.each([
    [
      "an active member's address",
      () => harness.member("contributor", { email: "taken@example.com" }),
      "member_already_active",
      "User is already a member of this organization",
    ],
    [
      "a removed member's address",
      () => harness.member("contributor", { email: "taken@example.com", deletedAt: NOW }),
      "member_removed",
      "taken@example.com was previously removed from this organization. Restore them from the Deleted view instead of re-inviting.",
    ],
    [
      "an address with a pending invitation, expired or not",
      () => harness.invitation({ email: "taken@example.com", expiresAt: new Date(NOW.getTime() - 1) }),
      "invitation_already_pending",
      "User has already been invited to this organization",
    ],
  ])("refuses %s with 409, counting the request but writing and sending nothing", async (_label, arrange, code, message) => {
    arrange();

    const error = await refusal(
      harness.service.invite(harness.actor(), harness.organization.id, { email: "taken@example.com", role: "admin" }),
    );

    expect(error).toMatchObject({ code, statusCode: 409, message });
    expect(harness.consumeInvitationEmail).toHaveBeenCalledTimes(1);
    expect(harness.invitations.create).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("refuses the caller's own address as already a member", async () => {
    const actor = harness.actor();
    const error = await refusal(
      harness.service.invite(actor, harness.organization.id, { email: actor.email, role: "admin" }),
    );
    expect(error).toMatchObject({ code: "member_already_active", statusCode: 409 });
  });

  it("answers a clash on the one-pending index with the same 409, and lets any other failure through", async () => {
    harness.invitations.create.mockRejectedValueOnce(new InvitationAlreadyPendingError());
    const error = await refusal(
      harness.service.invite(harness.actor(), harness.organization.id, { email: "a@example.com", role: "contributor" }),
    );
    expect(error).toMatchObject({ code: "invitation_already_pending", statusCode: 409 });

    const failure = Object.assign(new Error("duplicate key"), { code: "23505" });
    harness.invitations.create.mockRejectedValueOnce(failure);
    await expect(
      harness.service.invite(harness.actor(), harness.organization.id, { email: "b@example.com", role: "contributor" }),
    ).rejects.toBe(failure);
    expect(harness.sent).toEqual([]);
  });

  it("answers a failed send with a bare 502, logs the mailer's error, and audits the failure after the commit", async () => {
    const actor = harness.actor();
    harness.mailerState.isFailing = true;

    const error = await refusal(
      harness.service.invite(actor, harness.organization.id, { email: "a@example.com", role: "contributor" }),
    );

    expect(error).toMatchObject({
      code: "invitation_email_failed",
      statusCode: 502,
      message: "The invitation was created, but its email couldn't be sent. Use Resend to try again.",
    });
    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(harness.log.error).toHaveBeenCalledWith({ err: harness.sendFailure }, expect.any(String));
    const [created] = [...harness.invitationRows.values()];
    expect(harness.auditEvents.map((event) => event.action)).toEqual([
      "organization_invitation.created",
      "organization_invitation.email_failed",
    ]);
    expect(harness.auditEvents[1]).toMatchObject({
      subjectType: "organization_invitation",
      subjectId: created!.id,
      organizationId: harness.organization.id,
    });
    // The invitation's transaction, then the failure's own.
    expect(harness.contexts).toEqual([actor.context, actor.context]);
  });
});

describe("listInvitations", () => {
  it("lists pending invitations without a lock, marking those whose expiry has come by the injected clock", async () => {
    const actor = harness.actor();
    const future = harness.invitation({ expiresAt: new Date(NOW.getTime() + 1) });
    const now = harness.invitation({ expiresAt: NOW });
    harness.invitation({ revokedAt: NOW });

    const listed = await harness.service.listInvitations(actor, harness.organization.id);

    expect(listed.map(({ id, isExpired }) => ({ id, isExpired }))).toEqual([
      { id: future.id, isExpired: false },
      { id: now.id, isExpired: true },
    ]);
    expect(harness.calls).toEqual(["invitations.listPending"]);
    expect(harness.consumeInvitationEmail).not.toHaveBeenCalled();
  });

  it("answers another organization with 404 and a contributor with 403", async () => {
    expect(await refusal(harness.service.listInvitations(harness.actor("contributor"), randomUUID()))).toMatchObject({
      code: "organization_not_found",
    });
    expect(
      await refusal(harness.service.listInvitations(harness.actor("contributor"), harness.organization.id)),
    ).toMatchObject({ code: "organization_admin_required" });
    expect(harness.invitations.listPending).not.toHaveBeenCalled();
  });
});

describe("resendInvitation", () => {
  it("reissues under both locks with a new token and expiry, audits, and emails the new link after the commit", async () => {
    const actor = harness.actor();
    const expired = harness.invitation({ expiresAt: new Date(NOW.getTime() - SEVEN_DAYS_MS) });

    const resent = await harness.service.resendInvitation(actor, harness.organization.id, expired.id.toUpperCase());

    expect(harness.calls).toEqual([
      "consumeInvitationEmail",
      "lockActive",
      "members.find",
      `invitations.lockForUpdate:${expired.id}`,
      "invitations.reissue",
    ]);
    expect(resent).toMatchObject({ id: expired.id, expiresAt: new Date(NOW.getTime() + SEVEN_DAYS_MS), isExpired: false });
    expect(resent).not.toHaveProperty("tokenHash");
    const row = harness.invitationRows.get(expired.id)!;
    expect(row.tokenHash).not.toBe(expired.tokenHash);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]!.openTransactions).toBe(0);
    expect(hashToken(tokenOf(harness.sent[0]!.message))).toBe(row.tokenHash);
    expect(harness.auditEvents).toEqual([
      {
        action: "organization_invitation.resent",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "organization_invitation",
        subjectId: expired.id,
        ...origin,
      },
    ]);
  });

  it.each([
    ["an accepted invitation", () => harness.invitation({ acceptedAt: NOW }).id],
    ["a cancelled invitation", () => harness.invitation({ revokedAt: NOW }).id],
    ["an unknown id", () => randomUUID()],
    ["an id that isn't a canonical UUID", () => harness.invitation().id.replaceAll("-", "")],
  ])("answers %s with 404 invitation_not_found after the lock, sending nothing", async (_label, idOf) => {
    const id = idOf();
    const error = await refusal(harness.service.resendInvitation(harness.actor(), harness.organization.id, id));
    expect(error).toMatchObject({
      code: "invitation_not_found",
      statusCode: 404,
      message: "No pending invitation found for this user",
    });
    expect(harness.calls.slice(0, 3)).toEqual(["consumeInvitationEmail", "lockActive", "members.find"]);
    expect(harness.invitations.reissue).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.auditEvents).toEqual([]);
  });

  it("answers another organization with 404 and a contributor with 403, before the mail limit", async () => {
    const pending = harness.invitation();
    expect(
      await refusal(harness.service.resendInvitation(harness.actor("contributor"), randomUUID(), pending.id)),
    ).toMatchObject({ code: "organization_not_found" });
    expect(
      await refusal(harness.service.resendInvitation(harness.actor("contributor"), harness.organization.id, pending.id)),
    ).toMatchObject({ code: "organization_admin_required" });
    expect(harness.consumeInvitationEmail).not.toHaveBeenCalled();
  });

  it("answers a failed send with its own bare 502, saying the link was renewed, and audits the failure", async () => {
    const actor = harness.actor();
    const pending = harness.invitation();
    harness.mailerState.isFailing = true;

    const error = await refusal(harness.service.resendInvitation(actor, harness.organization.id, pending.id));

    expect(error).toMatchObject({
      code: "invitation_email_failed",
      statusCode: 502,
      message: "The invitation's link was renewed, but its email couldn't be sent. Use Resend to try again.",
    });
    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(harness.log.error).toHaveBeenCalledWith({ err: harness.sendFailure }, expect.any(String));
    expect(harness.auditEvents.map((event) => event.action)).toEqual([
      "organization_invitation.resent",
      "organization_invitation.email_failed",
    ]);
  });

  it("re-checks the admin under the lock", async () => {
    const pending = harness.invitation();
    const error = await refusal(
      harness.service.resendInvitation(harness.actor("admin", "contributor"), harness.organization.id, pending.id),
    );
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.invitations.lockForUpdate).not.toHaveBeenCalled();
  });
});

// D36-1 decision 57 (Q268): while registration isn't open, a personal
// organization sends no invitation; a group organization still does, and
// revoking and listing stay open so leftover invitations can be cleared.
describe("invitations from a personal organization, by the site's registration mode", () => {
  const PERSONAL_REFUSAL = {
    code: "personal_organization_invitations_disabled",
    statusCode: 403,
    message: "Invitations can't be sent from a personal workspace on this site.",
  };

  function personalHarness(registration: RegistrationMode) {
    const built = buildHarness({ registration });
    built.organization.type = "personal";
    return built;
  }

  it.each(["invite-only", "closed"] as const)(
    "%s: refuses an invite 403 personal_organization_invitations_disabled under the lock, after the mail limit, writing, auditing and mailing nothing",
    async (registration) => {
      const local = personalHarness(registration);
      const error = await refusal(
        local.service.invite(local.actor(), local.organization.id, { email: "someone@example.com", role: "contributor" }),
      );
      expect(error).toMatchObject(PERSONAL_REFUSAL);
      expect(local.calls).toEqual(["consumeInvitationEmail", "lockActive", "members.find"]);
      expect(local.invitations.create).not.toHaveBeenCalled();
      expect(local.invitationRows.size).toBe(0);
      expect(local.auditEvents).toEqual([]);
      expect(local.mailer.send).not.toHaveBeenCalled();
    },
  );

  it("invite-only: refuses a resend the same way, before the invitation's lock, leaving its token as it was", async () => {
    const local = personalHarness("invite-only");
    const pending = local.invitation();

    const error = await refusal(local.service.resendInvitation(local.actor(), local.organization.id, pending.id));

    expect(error).toMatchObject(PERSONAL_REFUSAL);
    expect(local.calls).toEqual(["consumeInvitationEmail", "lockActive", "members.find"]);
    expect(local.invitations.reissue).not.toHaveBeenCalled();
    expect(local.invitationRows.get(pending.id)!.tokenHash).toBe(pending.tokenHash);
    expect(local.auditEvents).toEqual([]);
    expect(local.mailer.send).not.toHaveBeenCalled();
  });

  it("invite-only: still lists and revokes a personal organization's leftover invitations", async () => {
    const local = personalHarness("invite-only");
    const actor = local.actor();
    const pending = local.invitation();

    expect((await local.service.listInvitations(actor, local.organization.id)).map(({ id }) => id)).toEqual([pending.id]);
    await local.service.cancelInvitation(actor, local.organization.id, pending.id);

    expect(local.invitationRows.get(pending.id)!.revokedAt).toEqual(NOW);
    expect(local.auditEvents.map((event) => event.action)).toEqual(["organization_invitation.revoked"]);
  });

  it("open: a personal organization invites and resends as before", async () => {
    const local = personalHarness("open");
    const actor = local.actor();

    const created = await local.service.invite(actor, local.organization.id, { email: "someone@example.com", role: "contributor" });
    await local.service.resendInvitation(actor, local.organization.id, created.id);

    expect(local.auditEvents.map((event) => event.action)).toEqual([
      "organization_invitation.created",
      "organization_invitation.resent",
    ]);
    expect(local.sent).toHaveLength(2);
  });

  it.each(["invite-only", "closed"] as const)("%s: a group organization invites and resends as before", async (registration) => {
    const local = buildHarness({ registration });
    const actor = local.actor();

    const created = await local.service.invite(actor, local.organization.id, { email: "someone@example.com", role: "contributor" });
    await local.service.resendInvitation(actor, local.organization.id, created.id);

    expect(local.auditEvents.map((event) => event.action)).toEqual([
      "organization_invitation.created",
      "organization_invitation.resent",
    ]);
    expect(local.sent).toHaveLength(2);
  });
});

describe("cancelInvitation", () => {
  it("revokes under both locks at the injected time and audits it, without the mail limit or an email", async () => {
    const actor = harness.actor();
    const pending = harness.invitation();

    await harness.service.cancelInvitation(actor, harness.organization.id, pending.id);

    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      `invitations.lockForUpdate:${pending.id}`,
      `invitations.revoke:${NOW.toISOString()}`,
    ]);
    expect(harness.consumeInvitationEmail).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.auditEvents).toEqual([
      {
        action: "organization_invitation.revoked",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "organization_invitation",
        subjectId: pending.id,
        ...origin,
      },
    ]);
  });

  it.each([
    ["an accepted invitation", () => harness.invitation({ acceptedAt: NOW }).id],
    ["a cancelled invitation", () => harness.invitation({ revokedAt: NOW }).id],
    ["an id that isn't a UUID", () => "not-a-uuid"],
  ])("answers %s with 404 invitation_not_found", async (_label, idOf) => {
    const error = await refusal(harness.service.cancelInvitation(harness.actor(), harness.organization.id, idOf()));
    expect(error).toMatchObject({ code: "invitation_not_found", statusCode: 404 });
    expect(harness.invitations.revoke).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([]);
  });
});
