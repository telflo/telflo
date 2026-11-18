import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationRole } from "@telflo/db";
import { AppError } from "../../errors.js";
import type { AuditEvent } from "../identity/repositories/audit-repository.js";
import type { Member } from "../organizations/repositories/member-repository.js";
import type { Organization } from "../organizations/repositories/organization-repository.js";
import type { Actor } from "../organizations/service.js";
import {
  ApiTokenNameTakenError,
  type ApiToken,
  type CreateApiTokenInput,
} from "./repositories/api-token-repository.js";
import {
  ServiceAccountAddressTakenError,
  ServiceAccountNameTakenError,
  type CreateServiceAccountInput,
  type ServiceAccount,
} from "./repositories/service-account-repository.js";
import { createServiceAccountService, type ServiceAccountTransaction } from "./service.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
/** A token built at run time (D22 Preflight ruling 32), never printed: compared as a boolean. */
const MINTED_TOKEN = `tf_${"A".repeat(43)}`;

/** Whether `value`, serialized, holds the minted token's body or its prefix: a boolean canary (Ruling 99). */
const holdsMintedToken = (value: unknown) => {
  const serialized = JSON.stringify(value);
  return serialized.includes(MINTED_TOKEN.slice(3)) || serialized.includes(MINTED_TOKEN.slice(0, 11));
};

/** A token row as the repository hands it back. */
function apiToken(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    serviceAccountId: randomUUID(),
    name: "Deploy",
    prefix: "tf_AAAAAAAA",
    access: "read",
    expiresAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}
const origin = { ipAddress: "203.0.113.7", userAgent: "vitest" };

/**
 * Hand-built fakes typed against the repository interfaces, every call
 * logged in order, so a test sees decision 27's and 28's orders. There is
 * no real transaction: routes.integration.test.ts proves atomicity, the
 * locks and the limit against Postgres.
 */
function buildHarness() {
  const calls: string[] = [];
  const auditEvents: AuditEvent[] = [];
  let transactions = 0;
  let minted = 0;
  const organization: Organization = {
    id: randomUUID(),
    name: "Acme",
    type: "group",
    ownerUserId: null,
    createdAt: new Date("2029-01-01T00:00:00.000Z"),
    logoId: null,
    logoContentType: null,
  };
  const people = new Map<string, Member>();
  const accounts = new Map<string, ServiceAccount>();
  const createFailures: Error[] = [];
  const state = {
    liveCount: 0,
    nameTaken: false,
    renameFailure: undefined as Error | undefined,
    liveTokens: 0,
    tokenNameTaken: false,
    tokenCreateFailure: undefined as Error | undefined,
    revocable: new Set<string>(),
  };
  const hex = { next: 0 };

  const transaction = {
    active: {
      organization: {
        lockActive: vi.fn(async () => {
          calls.push("lockActive");
          return { ...organization };
        }),
      },
      members: {
        find: vi.fn(async (userId: string) => {
          calls.push("members.find");
          const member = people.get(userId);
          return member ? { ...member } : undefined;
        }),
        add: vi.fn(async (input: { userId: string; role: OrganizationRole }) => {
          calls.push(`members.add:${input.role}`);
          return { id: randomUUID(), organizationId: organization.id, createdAt: NOW, ...input };
        }),
        lockAccounts: vi.fn(async (userId?: string) => {
          calls.push(`members.lockAccounts:${userId}`);
        }),
        remove: vi.fn(async (userId: string, at: Date) => {
          calls.push(`members.remove:${at.toISOString()}`);
          return accounts.has(userId);
        }),
      },
    },
    serviceAccounts: {
      list: vi.fn(async () => {
        calls.push("serviceAccounts.list");
        return [...accounts.values()];
      }),
      find: vi.fn(async (id: string) => {
        calls.push(`serviceAccounts.find:${id}`);
        const account = accounts.get(id);
        return account ? { ...account } : undefined;
      }),
      countLive: vi.fn(async () => {
        calls.push("serviceAccounts.countLive");
        return state.liveCount;
      }),
      isNameTaken: vi.fn(async (_name: string, exceptId?: string) => {
        calls.push(`serviceAccounts.isNameTaken${exceptId === undefined ? "" : `:${exceptId}`}`);
        return state.nameTaken;
      }),
      create: vi.fn(async (input: CreateServiceAccountInput) => {
        calls.push(`serviceAccounts.create:${input.email}`);
        const failure = createFailures.shift();
        if (failure) throw failure;
        const account: ServiceAccount = {
          id: randomUUID(),
          organizationId: organization.id,
          name: input.name,
          email: input.email,
          createdBy: { userId: input.createdByUserId, email: "admin@example.com" },
          createdAt: input.at,
          updatedAt: input.at,
          tokenCount: 0,
        };
        accounts.set(account.id, account);
        return account;
      }),
      rename: vi.fn(async (id: string, name: string, at: Date) => {
        calls.push(`serviceAccounts.rename:${at.toISOString()}`);
        if (state.renameFailure) throw state.renameFailure;
        const account = accounts.get(id);
        if (!account) return false;
        accounts.set(id, { ...account, name, updatedAt: at });
        return true;
      }),
      markDeleted: vi.fn(async (id: string, at: Date) => {
        calls.push(`serviceAccounts.markDeleted:${at.toISOString()}`);
        return accounts.delete(id);
      }),
    },
    apiTokens: {
      list: vi.fn(async (serviceAccountId: string): Promise<ApiToken[]> => {
        calls.push(`apiTokens.list:${serviceAccountId}`);
        return [
          apiToken({ serviceAccountId, expiresAt: new Date(NOW.getTime() + 1) }),
          apiToken({ serviceAccountId, expiresAt: NOW }),
          apiToken({ serviceAccountId, expiresAt: null }),
        ];
      }),
      countLive: vi.fn(async (serviceAccountId: string, at: Date) => {
        calls.push(`apiTokens.countLive:${serviceAccountId}:${at.toISOString()}`);
        return state.liveTokens;
      }),
      isNameTaken: vi.fn(async (serviceAccountId: string) => {
        calls.push(`apiTokens.isNameTaken:${serviceAccountId}`);
        return state.tokenNameTaken;
      }),
      create: vi.fn(async (input: CreateApiTokenInput) => {
        calls.push(`apiTokens.create:${input.serviceAccountId}`);
        if (state.tokenCreateFailure) throw state.tokenCreateFailure;
        return apiToken({
          serviceAccountId: input.serviceAccountId,
          name: input.name,
          prefix: input.tokenPrefix,
          access: input.access,
          expiresAt: input.expiresAt,
          createdAt: input.at,
        });
      }),
      revoke: vi.fn(async (serviceAccountId: string, id: string, userId: string, at: Date) => {
        calls.push(`apiTokens.revoke:${serviceAccountId}:${id}:${userId}:${at.toISOString()}`);
        return state.revocable.delete(`${serviceAccountId}/${id}`);
      }),
      revokeAllOf: vi.fn(async (serviceAccountId: string, userId: string, at: Date) => {
        calls.push(`apiTokens.revokeAllOf:${serviceAccountId}:${userId}:${at.toISOString()}`);
        return 2;
      }),
    },
    audit: {
      record: vi.fn(async (event: AuditEvent) => {
        calls.push(`audit:${event.action}`);
        auditEvents.push(event);
      }),
    },
  } satisfies ServiceAccountTransaction;

  const service = createServiceAccountService({
    withTransaction: async (_context, work) => {
      transactions += 1;
      return work(transaction);
    },
    now: () => NOW,
    randomHex: () => (hex.next++).toString(16).padStart(8, "0"),
    mintToken: () => {
      minted += 1;
      return { token: MINTED_TOKEN, tokenHash: "f".repeat(64), tokenPrefix: MINTED_TOKEN.slice(0, 11) };
    },
  });

  /** A caller acting in the organization, as `authenticate` read their role, and as the lock re-reads it. */
  function actor(role: OrganizationRole = "admin"): Actor {
    const userId = randomUUID();
    people.set(userId, {
      userId,
      email: "admin@example.com",
      role,
      isOrganizationOwner: false,
      createdAt: NOW,
      deletedAt: null,
      isServiceAccount: false,
    });
    return {
      context: { userId, organizationId: organization.id, role },
      email: "admin@example.com",
      ...origin,
    };
  }

  /** A live account of the organization. */
  function account(name = "CI"): ServiceAccount {
    const added: ServiceAccount = {
      id: randomUUID(),
      organizationId: organization.id,
      name,
      email: `ci-1a2b3c4d@service-accounts.telflo.invalid`,
      createdBy: null,
      createdAt: NOW,
      updatedAt: NOW,
      tokenCount: 0,
    };
    accounts.set(added.id, added);
    return added;
  }

  return {
    service,
    calls,
    auditEvents,
    organization,
    people,
    state,
    createFailures,
    actor,
    account,
    transaction,
    transactions: () => transactions,
    minted: () => minted,
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

describe("the checks every route makes first", () => {
  const routes = [
    ["the list", (actor: Actor, organizationId: string) => harness.service.list(actor, organizationId)],
    ["the read", (actor: Actor, organizationId: string) => harness.service.find(actor, organizationId, randomUUID())],
    ["a create", (actor: Actor, organizationId: string) => harness.service.create(actor, organizationId, "CI")],
    ["a rename", (actor: Actor, organizationId: string) => harness.service.rename(actor, organizationId, randomUUID(), "CI")],
    ["a delete", (actor: Actor, organizationId: string) => harness.service.delete(actor, organizationId, randomUUID())],
  ] as const;

  it.each(routes)("%s: any organization but the active one is 404, before the role check", async (_label, route) => {
    const error = await refusal(route(harness.actor("contributor"), randomUUID()));
    expect(error).toMatchObject({ code: "organization_not_found", statusCode: 404 });
    expect(harness.transactions()).toBe(0);
  });

  it.each(routes)("%s: a contributor is 403 before any transaction", async (_label, route) => {
    const error = await refusal(route(harness.actor("contributor"), harness.organization.id));
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.transactions()).toBe(0);
  });

  it.each([
    ["the read", (actor: Actor, id: string) => harness.service.find(actor, harness.organization.id, id)],
    ["a rename", (actor: Actor, id: string) => harness.service.rename(actor, harness.organization.id, id, "New")],
    ["a delete", (actor: Actor, id: string) => harness.service.delete(actor, harness.organization.id, id)],
  ])("%s: an id that isn't a canonical uuid reads nothing and is 404 service_account_not_found", async (_label, route) => {
    const live = harness.account();
    for (const id of [live.id.replace(/-/g, ""), `{${live.id}}`, "not-a-uuid"]) {
      const error = await refusal(route(harness.actor(), id));
      expect(error).toMatchObject({ code: "service_account_not_found", statusCode: 404, message: "Service account not found." });
    }
    expect(harness.calls.filter((call) => call.startsWith("serviceAccounts.find"))).toEqual([]);
  });
});

describe("create", () => {
  it("in decision 27's order: the lock and the re-check, the count, the name, the user and its row, the contributor membership, the audit row", async () => {
    const actor = harness.actor();

    const account = await harness.service.create(actor, harness.organization.id, "CI Deploy");

    expect(account.email).toBe("ci-deploy-00000000@service-accounts.telflo.invalid");
    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      "serviceAccounts.countLive",
      "serviceAccounts.isNameTaken",
      "serviceAccounts.create:ci-deploy-00000000@service-accounts.telflo.invalid",
      "members.add:contributor",
      "audit:service_account.created",
    ]);
    expect(harness.transaction.serviceAccounts.create).toHaveBeenCalledWith({
      name: "CI Deploy",
      email: "ci-deploy-00000000@service-accounts.telflo.invalid",
      createdByUserId: actor.context.userId,
      at: NOW,
    });
    expect(harness.transaction.active.members.add).toHaveBeenCalledWith({ userId: account.id, role: "contributor" });
    expect(harness.auditEvents).toEqual([
      {
        action: "service_account.created",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "service_account",
        subjectId: account.id,
        metadata: undefined,
        ...origin,
      },
    ]);
  });

  it("refuses at 100 live accounts with 409 service_account_limit_reached, before the name and any write", async () => {
    harness.state.liveCount = 100;
    const error = await refusal(harness.service.create(harness.actor(), harness.organization.id, "CI"));
    expect(error).toMatchObject({
      code: "service_account_limit_reached",
      statusCode: 409,
      message: "This organization has 100 service accounts. Delete one first.",
    });
    expect(harness.calls).toEqual(["lockActive", "members.find", "serviceAccounts.countLive"]);
  });

  it("refuses a live duplicate read under the lock, and the unique index's clash, with the same 409", async () => {
    harness.state.nameTaken = true;
    const read = await refusal(harness.service.create(harness.actor(), harness.organization.id, "CI"));
    expect(read).toMatchObject({ code: "service_account_name_taken", statusCode: 409 });
    expect(harness.transaction.serviceAccounts.create).not.toHaveBeenCalled();

    harness.state.nameTaken = false;
    harness.createFailures.push(new ServiceAccountNameTakenError());
    const raced = await refusal(harness.service.create(harness.actor(), harness.organization.id, "CI"));
    expect(raced).toMatchObject({
      code: "service_account_name_taken",
      statusCode: 409,
      message: "A service account with this name already exists.",
    });
  });

  it("retries an address collision in a new transaction with new digits, at most three tries in all", async () => {
    harness.createFailures.push(new ServiceAccountAddressTakenError(), new ServiceAccountAddressTakenError());
    const account = await harness.service.create(harness.actor(), harness.organization.id, "CI");
    expect(account.email).toBe("ci-00000002@service-accounts.telflo.invalid");
    expect(harness.transactions()).toBe(3);

    harness.createFailures.push(
      new ServiceAccountAddressTakenError(),
      new ServiceAccountAddressTakenError(),
      new ServiceAccountAddressTakenError(),
    );
    await expect(harness.service.create(harness.actor(), harness.organization.id, "CI")).rejects.toBeInstanceOf(
      ServiceAccountAddressTakenError,
    );
    expect(harness.transactions()).toBe(6);
  });

  it("refuses an admin demoted before the lock's re-check with 403, writing nothing", async () => {
    const actor = harness.actor();
    harness.people.set(actor.context.userId, { ...harness.people.get(actor.context.userId)!, role: "contributor" });
    const error = await refusal(harness.service.create(actor, harness.organization.id, "CI"));
    expect(error).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.calls).toEqual(["lockActive", "members.find"]);
  });
});

describe("rename", () => {
  it("under the lock: the account, the duplicate check without itself, the rename, the audit row; the address kept", async () => {
    const actor = harness.actor();
    const live = harness.account("Old");

    const renamed = await harness.service.rename(actor, harness.organization.id, live.id.toUpperCase(), "New");

    expect(renamed).toMatchObject({ id: live.id, name: "New", email: live.email });
    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      `serviceAccounts.find:${live.id}`,
      `serviceAccounts.isNameTaken:${live.id}`,
      `serviceAccounts.rename:${NOW.toISOString()}`,
      "audit:service_account.renamed",
      `serviceAccounts.find:${live.id}`,
    ]);
    expect(harness.auditEvents).toEqual([
      expect.objectContaining({ action: "service_account.renamed", subjectType: "service_account", subjectId: live.id, metadata: undefined }),
    ]);
  });

  it("the same name, exactly, changes and audits nothing", async () => {
    const live = harness.account("Same");
    expect(await harness.service.rename(harness.actor(), harness.organization.id, live.id, "Same")).toEqual(live);
    expect(harness.transaction.serviceAccounts.rename).not.toHaveBeenCalled();
    expect(harness.auditEvents).toEqual([]);
  });

  it("a duplicate, read or raced, is 409; an unknown account 404", async () => {
    const live = harness.account("Mine");
    harness.state.nameTaken = true;
    expect(await refusal(harness.service.rename(harness.actor(), harness.organization.id, live.id, "Taken"))).toMatchObject({
      code: "service_account_name_taken",
    });
    harness.state.nameTaken = false;
    harness.state.renameFailure = new ServiceAccountNameTakenError();
    expect(await refusal(harness.service.rename(harness.actor(), harness.organization.id, live.id, "Taken"))).toMatchObject({
      code: "service_account_name_taken",
    });
    expect(await refusal(harness.service.rename(harness.actor(), harness.organization.id, randomUUID(), "X"))).toMatchObject({
      code: "service_account_not_found",
    });
    expect(harness.auditEvents).toEqual([]);
  });
});

describe("delete", () => {
  it("in decision 28's order: the lock, the account, its user's lock, its tokens, its membership, its deletion, the audit row with the count", async () => {
    const actor = harness.actor();
    const live = harness.account();

    await harness.service.delete(actor, harness.organization.id, live.id);

    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      `serviceAccounts.find:${live.id}`,
      `members.lockAccounts:${live.id}`,
      `apiTokens.revokeAllOf:${live.id}:${actor.context.userId}:${NOW.toISOString()}`,
      `members.remove:${NOW.toISOString()}`,
      `serviceAccounts.markDeleted:${NOW.toISOString()}`,
      "audit:service_account.deleted",
    ]);
    expect(harness.auditEvents).toEqual([
      {
        action: "service_account.deleted",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "service_account",
        subjectId: live.id,
        metadata: { revokedTokens: 2 },
        ...origin,
      },
    ]);
  });

  it("an unknown account is 404, locking and writing nothing past the organization", async () => {
    const error = await refusal(harness.service.delete(harness.actor(), harness.organization.id, randomUUID()));
    expect(error).toMatchObject({ code: "service_account_not_found", statusCode: 404 });
    expect(harness.transaction.active.members.lockAccounts).not.toHaveBeenCalled();
    expect(harness.transaction.apiTokens.revokeAllOf).not.toHaveBeenCalled();
  });
});

describe("tokens (decision 31)", () => {
  const token = { name: "Deploy", access: "write" as const, expiresInDays: 30 };

  it("a create, in its order: the lock and the re-check, the account, the live count at the clock, the name, the mint, the row, the audit row with ids, access and expiry only", async () => {
    const actor = harness.actor();
    const live = harness.account();

    const created = await harness.service.createToken(actor, harness.organization.id, live.id.toUpperCase(), token);

    expect(created.token === MINTED_TOKEN).toBe(true);
    expect(harness.minted()).toBe(1);
    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      `serviceAccounts.find:${live.id}`,
      `apiTokens.countLive:${live.id}:${NOW.toISOString()}`,
      `apiTokens.isNameTaken:${live.id}`,
      `apiTokens.create:${live.id}`,
      "audit:api_token.created",
    ]);
    const expiresAt = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    // The row's input: its hash and prefix as booleans, then the rest, once
    // a canary shows it holds neither the token nor its prefix (Ruling 99).
    expect(harness.transaction.apiTokens.create).toHaveBeenCalledTimes(1);
    const { tokenHash, tokenPrefix, ...createInput } = harness.transaction.apiTokens.create.mock.calls[0]![0];
    expect(tokenHash === "f".repeat(64)).toBe(true);
    expect(tokenPrefix === MINTED_TOKEN.slice(0, 11)).toBe(true);
    expect(holdsMintedToken(createInput)).toBe(false);
    expect(Object.keys(createInput).sort()).toEqual(["access", "at", "createdByUserId", "expiresAt", "name", "serviceAccountId"]);
    expect(createInput).toEqual({
      serviceAccountId: live.id,
      name: "Deploy",
      access: "write",
      expiresAt,
      createdByUserId: actor.context.userId,
      at: NOW,
    });
    expect(created.apiToken).toMatchObject({ expiresAt, isExpired: false, access: "write" });
    // The audit events: the canary, then the keys, then the values.
    expect(holdsMintedToken(harness.auditEvents)).toBe(false);
    expect(harness.auditEvents.map((event) => Object.keys(event).sort())).toEqual([
      [
        "action",
        "actorEmail",
        "actorUserId",
        "ipAddress",
        "metadata",
        "organizationId",
        "subjectId",
        "subjectType",
        "userAgent",
      ],
    ]);
    expect(Object.keys(harness.auditEvents[0]!.metadata ?? {}).sort()).toEqual(["access", "expiresAt", "serviceAccountId"]);
    expect(harness.auditEvents).toEqual([
      {
        action: "api_token.created",
        actorUserId: actor.context.userId,
        actorEmail: actor.email,
        organizationId: harness.organization.id,
        subjectType: "api_token",
        subjectId: created.apiToken.id,
        metadata: { serviceAccountId: live.id, access: "write", expiresAt: expiresAt.toISOString() },
        ...origin,
      },
    ]);
  });

  it("null expiresInDays never expires, and is audited as null", async () => {
    const live = harness.account();
    const created = await harness.service.createToken(harness.actor(), harness.organization.id, live.id, {
      ...token,
      expiresInDays: null,
    });
    expect(created.apiToken.expiresAt).toBeNull();
    // The canary, then the keys, then the values (Ruling 99).
    expect(holdsMintedToken(harness.auditEvents)).toBe(false);
    expect(harness.auditEvents).toHaveLength(1);
    expect(Object.keys(harness.auditEvents[0]!.metadata ?? {}).sort()).toEqual(["access", "expiresAt", "serviceAccountId"]);
    expect(harness.auditEvents[0]?.metadata).toEqual({ serviceAccountId: live.id, access: "write", expiresAt: null });
  });

  it("refuses at 20 live tokens with the owner's 409 before the name and the mint", async () => {
    const live = harness.account();
    harness.state.liveTokens = 20;
    const error = await refusal(harness.service.createToken(harness.actor(), harness.organization.id, live.id, token));
    expect(error).toMatchObject({
      code: "api_token_limit_reached",
      statusCode: 409,
      message: "This service account has 20 tokens. Revoke one first.",
    });
    expect(harness.transaction.apiTokens.isNameTaken).not.toHaveBeenCalled();
    expect(harness.minted()).toBe(0);
  });

  it("refuses a name taken, read under the lock or raced on the index, with the same 409", async () => {
    const live = harness.account();
    harness.state.tokenNameTaken = true;
    const read = await refusal(harness.service.createToken(harness.actor(), harness.organization.id, live.id, token));
    expect(read).toMatchObject({ code: "api_token_name_taken", statusCode: 409 });
    expect(harness.minted()).toBe(0);

    harness.state.tokenNameTaken = false;
    harness.state.tokenCreateFailure = new ApiTokenNameTakenError();
    const raced = await refusal(harness.service.createToken(harness.actor(), harness.organization.id, live.id, token));
    expect(raced).toMatchObject({
      code: "api_token_name_taken",
      statusCode: 409,
      message: "This service account already has a token with this name.",
    });
    expect(harness.auditEvents).toEqual([]);
  });

  it("an unknown account gets no token: 404 service_account_not_found, nothing counted or minted", async () => {
    const error = await refusal(harness.service.createToken(harness.actor(), harness.organization.id, randomUUID(), token));
    expect(error).toMatchObject({ code: "service_account_not_found", statusCode: 404 });
    expect(harness.transaction.apiTokens.countLive).not.toHaveBeenCalled();
    expect(harness.minted()).toBe(0);
  });

  it("lists the account's tokens with isExpired by the API's clock: expired at its expiresAt exactly", async () => {
    const live = harness.account();
    const listed = await harness.service.listTokens(harness.actor(), harness.organization.id, live.id);
    expect(listed.map((item) => item.isExpired)).toEqual([false, true, false]);
    expect(harness.calls).toEqual([`serviceAccounts.find:${live.id}`, `apiTokens.list:${live.id}`]);
  });

  it("a revoke: the lock and the re-check, one conditional update by this admin, the audit row with the account's id", async () => {
    const actor = harness.actor();
    const accountId = randomUUID();
    const tokenId = randomUUID();
    harness.state.revocable.add(`${accountId}/${tokenId}`);

    await harness.service.revokeToken(actor, harness.organization.id, accountId.toUpperCase(), tokenId.toUpperCase());

    expect(harness.calls).toEqual([
      "lockActive",
      "members.find",
      `apiTokens.revoke:${accountId}:${tokenId}:${actor.context.userId}:${NOW.toISOString()}`,
      "audit:api_token.revoked",
    ]);
    expect(harness.auditEvents).toEqual([
      expect.objectContaining({
        action: "api_token.revoked",
        subjectType: "api_token",
        subjectId: tokenId,
        metadata: { serviceAccountId: accountId },
      }),
    ]);
  });

  it("a revoke that updates nothing, or names an id that isn't a canonical uuid, is 404 api_token_not_found", async () => {
    for (const [accountId, tokenId] of [
      [randomUUID(), randomUUID()],
      ["not-a-uuid", randomUUID()],
      [randomUUID(), "not-a-uuid"],
    ] as const) {
      const error = await refusal(harness.service.revokeToken(harness.actor(), harness.organization.id, accountId, tokenId));
      expect(error).toMatchObject({ code: "api_token_not_found", statusCode: 404, message: "Token not found" });
    }
    expect(harness.transaction.apiTokens.revoke).toHaveBeenCalledTimes(1);
    expect(harness.auditEvents).toEqual([]);
  });

  it.each([
    ["the list", () => harness.service.listTokens(harness.actor("contributor"), harness.organization.id, randomUUID())],
    ["a create", () => harness.service.createToken(harness.actor("contributor"), harness.organization.id, randomUUID(), token)],
    ["a revoke", () => harness.service.revokeToken(harness.actor("contributor"), harness.organization.id, randomUUID(), randomUUID())],
  ])("%s by a contributor is 403 before any transaction", async (_label, route) => {
    expect(await refusal(route())).toMatchObject({ code: "organization_admin_required", statusCode: 403 });
    expect(harness.transactions()).toBe(0);
  });
});
