import { describe, expect, it } from "vitest";
import type { ActorContext } from "../../database/context.js";
import { AppError } from "../../errors.js";
import type { AuditEvent } from "../identity/repositories/audit-repository.js";
import type { User } from "../identity/repositories/user-repository.js";
import { createPersonalApiTokenService, type PersonalApiTokenActor } from "./personal-api-tokens.js";
import type { PersonalApiToken } from "./repositories/personal-api-token-repository.js";

/*
 * The create's current password where the database can't easily stage it:
 * a hash changed, set or gone between the verify (outside any transaction)
 * and the user's lock, and whether a password was verified (the route's
 * sign-in budget). The database's own paths are in
 * personal-api-tokens.integration.test.ts.
 */

const RIGHT = "the-right-password";
const VERIFIED_HASH = "hash-at-verify";
const AT = new Date("2026-11-24T12:00:00.000Z");

const context: ActorContext = {
  userId: "0192a6b0-0000-7000-8000-00000000000a",
  organizationId: "0192a6b0-0000-7000-8000-00000000000b",
  role: "admin",
};

const actor: PersonalApiTokenActor = { context, email: "ana@example.com", ipAddress: "192.0.2.1", userAgent: "unit" };

/**
 * The service over fakes: the account's hash as `findById` reads it
 * (`atVerify`) and as the lock's reread finds it (`atLock`: undefined is a
 * deleted account).
 */
function serviceWith(atVerify: string | null, atLock: string | null | undefined) {
  const audits: AuditEvent[] = [];
  const made: string[] = [];
  const user: User = {
    id: context.userId,
    email: actor.email,
    passwordHash: atVerify,
    emailVerifiedAt: AT,
    acceptedTermsVersion: null,
    createdAt: AT,
  };
  const audit = { record: async (event: AuditEvent) => void audits.push(event) };
  const service = createPersonalApiTokenService({
    now: () => AT,
    users: { findById: async () => user },
    audit,
    verifyPassword: async (hash, plaintext) => hash === VERIFIED_HASH && plaintext === RIGHT,
    mintToken: () => ({ token: "tf_unit", tokenHash: "h", tokenPrefix: "tf_unit" }),
    withTransaction: async (_context, work) =>
      work({
        users: { lockForUpdate: async () => undefined, findPasswordHashForShare: async () => atLock },
        tokens: {
          list: async () => [],
          countLive: async () => 0,
          isNameTaken: async () => false,
          create: async (input): Promise<PersonalApiToken> => {
            made.push(input.name);
            return { id: "t1", name: input.name, prefix: input.tokenPrefix, access: input.access, expiresAt: null, lastUsedAt: null, createdAt: AT };
          },
          revoke: async () => false,
          touchLastUsed: async () => false,
          findName: async () => undefined,
        },
        audit,
      }),
  });
  return { service, audits, made };
}

const request = (currentPassword?: string) => ({ name: "CI", access: "read" as const, expiresInDays: null, currentPassword });

async function refusal(promise: Promise<unknown>): Promise<{ code: string; statusCode: number }> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AppError);
  const { code, statusCode } = failure as AppError;
  return { code, statusCode };
}

describe("a personal token's create: the current password", () => {
  it("verified, and the hash unchanged under the lock: made, isReauthenticated", async () => {
    const { service, audits, made } = serviceWith(VERIFIED_HASH, VERIFIED_HASH);
    const created = await service.create(actor, request(RIGHT));
    expect(created.isReauthenticated).toBe(true);
    expect(made).toEqual(["CI"]);
    expect(audits.map((each) => each.action)).toEqual(["personal_api_token.created"]);
  });

  it("an account without a password, still without one under the lock: made, not reauthenticated", async () => {
    const { service, made } = serviceWith(null, null);
    expect((await service.create(actor, request())).isReauthenticated).toBe(false);
    expect(made).toEqual(["CI"]);
  });

  for (const [what, atVerify, atLock] of [
    ["changed (a reset or a change) between the verify and the lock", VERIFIED_HASH, "hash-after-reset"],
    ["set on an account that had none, between the read and the lock", null, "hash-just-set"],
    ["removed between the verify and the lock", VERIFIED_HASH, null],
  ] as const) {
    it(`a password ${what}: 400 current_password_incorrect, audited, nothing made`, async () => {
      const { service, audits, made } = serviceWith(atVerify, atLock);
      expect(await refusal(service.create(actor, request(RIGHT)))).toEqual({ code: "current_password_incorrect", statusCode: 400 });
      expect(made).toEqual([]);
      expect(audits).toEqual([
        expect.objectContaining({
          action: "user.reauthentication_failed",
          actorUserId: context.userId,
          organizationId: context.organizationId,
          metadata: { purpose: "personal_api_token_create" },
          ipAddress: "192.0.2.1",
          userAgent: "unit",
        }),
      ]);
    });
  }

  it("the account deleted between the verify and the lock: 401, nothing made, nothing audited", async () => {
    const { service, audits, made } = serviceWith(VERIFIED_HASH, undefined);
    expect(await refusal(service.create(actor, request(RIGHT)))).toEqual({ code: "unauthenticated", statusCode: 401 });
    expect(made).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("a missing or a wrong password never opens a transaction", async () => {
    for (const currentPassword of [undefined, "wrong"]) {
      const { service, made, audits } = serviceWith(VERIFIED_HASH, VERIFIED_HASH);
      expect(await refusal(service.create(actor, request(currentPassword)))).toEqual({ code: "current_password_incorrect", statusCode: 400 });
      expect(made).toEqual([]);
      expect(audits.map((each) => each.action)).toEqual(["user.reauthentication_failed"]);
    }
  });
});
