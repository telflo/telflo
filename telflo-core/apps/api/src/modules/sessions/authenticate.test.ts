import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../errors.js";
import {
  createAuthenticate,
  requireCurrentTerms,
  requireCurrentTermsUnlessProductAdmin,
  requireProductAdmin,
} from "./authenticate.js";
import type { AuthenticationResult, ISessionService } from "./service.js";

const authenticated: Extract<AuthenticationResult, { status: "authenticated" }> = {
  status: "authenticated",
  userId: "0190a5b0-0000-7000-8000-000000000001",
  email: "person@example.com",
  hasAcceptedCurrentTerms: true,
  isProductAdmin: false,
  sessionId: "0190a5b0-0000-7000-8000-000000000002",
  organization: {
    id: "0190a5b0-0000-7000-8000-000000000003",
    name: "Acme",
    type: "group",
    logoId: null,
    role: "contributor",
  },
};

/** Runs the preHandler on a bare request carrying `accessToken`, with the service answering `result`. */
async function run(result: AuthenticationResult): Promise<FastifyRequest> {
  const service = { authenticate: vi.fn(async () => result) } as unknown as ISessionService;
  const request = { cookies: { telflo_access: "token" }, authentication: null } as unknown as FastifyRequest;
  await createAuthenticate(service).call({} as FastifyInstance, request, {} as FastifyReply);
  return request;
}

describe("authenticate", () => {
  it("places a frozen AuthContext with the member's role on the request, beside the email, the organization's name and type, and the flags", async () => {
    const request = await run(authenticated);
    expect(request.authentication).toEqual({
      context: {
        userId: authenticated.userId,
        organizationId: "0190a5b0-0000-7000-8000-000000000003",
        role: "contributor",
        sessionId: authenticated.sessionId,
      },
      email: "person@example.com",
      organizationName: "Acme",
      organizationType: "group",
      organizationLogoId: null,
      hasAcceptedCurrentTerms: true,
      isProductAdmin: false,
    });
    expect(Object.isFrozen(request.authentication!.context)).toBe(true);
  });

  it("answers expired with access_token_expired, and anything else refused with unauthenticated", async () => {
    await expect(run({ status: "expired", sessionId: authenticated.sessionId })).rejects.toMatchObject({
      code: "access_token_expired",
      statusCode: 401,
    });
    const refused = run({ status: "unauthenticated" });
    await expect(refused).rejects.toBeInstanceOf(AppError);
    await expect(refused).rejects.toMatchObject({ code: "unauthenticated", statusCode: 401 });
  });
});

// Whether the Terms are satisfied is the session service's answer, from the
// site's Terms version (D36-1 Preflight ruling 1; service.test.ts covers the
// comparison): authenticate only carries it onto the request.
describe("hasAcceptedCurrentTerms", () => {
  it("is the session service's answer, carried as it is", async () => {
    expect((await run({ ...authenticated, hasAcceptedCurrentTerms: false })).authentication?.hasAcceptedCurrentTerms).toBe(false);
    expect((await run({ ...authenticated, hasAcceptedCurrentTerms: true })).authentication?.hasAcceptedCurrentTerms).toBe(true);
  });
});

describe("requireCurrentTerms", () => {
  /** Runs the preHandler on a request `authenticate` accepted, the Terms satisfied or not. */
  async function check(hasAcceptedCurrentTerms: boolean): Promise<void> {
    const request = await run({ ...authenticated, hasAcceptedCurrentTerms });
    await requireCurrentTerms(request);
  }

  const TERMS_REFUSAL = {
    code: "terms_acceptance_required",
    message: "Accept the current Terms of Service to continue.",
    statusCode: 403,
  };

  it("passes a user whose Terms are satisfied", async () => {
    await expect(check(true)).resolves.toBeUndefined();
  });

  it("refuses a user whose Terms aren't (an older version, or none) with 403 terms_acceptance_required", async () => {
    const refused = check(false);
    await expect(refused).rejects.toBeInstanceOf(AppError);
    await expect(refused).rejects.toMatchObject(TERMS_REFUSAL);
  });

  it("fails closed with 401 unauthenticated on a route without authenticate", async () => {
    const request = { authentication: null } as unknown as FastifyRequest;
    await expect(requireCurrentTerms(request)).rejects.toMatchObject({ code: "unauthenticated", statusCode: 401 });
  });
});

describe("requireCurrentTermsUnlessProductAdmin", () => {
  const TERMS_REFUSAL = { code: "terms_acceptance_required", statusCode: 403 };

  it("passes a member with the current terms, and a product admin with or without them", async () => {
    await expect(requireCurrentTermsUnlessProductAdmin(await run(authenticated))).resolves.toBeUndefined();
    for (const hasAcceptedCurrentTerms of [true, false]) {
      const admin = await run({ ...authenticated, hasAcceptedCurrentTerms, isProductAdmin: true });
      await expect(requireCurrentTermsUnlessProductAdmin(admin)).resolves.toBeUndefined();
    }
  });

  it("refuses a member without the current terms with 403 terms_acceptance_required", async () => {
    const member = await run({ ...authenticated, hasAcceptedCurrentTerms: false });
    await expect(requireCurrentTermsUnlessProductAdmin(member)).rejects.toMatchObject(TERMS_REFUSAL);
  });

  it("fails closed with 401 unauthenticated on a route without authenticate", async () => {
    const request = { authentication: null } as unknown as FastifyRequest;
    await expect(requireCurrentTermsUnlessProductAdmin(request)).rejects.toMatchObject({
      code: "unauthenticated",
      statusCode: 401,
    });
  });
});

describe("isProductAdmin", () => {
  it("is the session check's answer, true or false", async () => {
    expect((await run({ ...authenticated, isProductAdmin: true })).authentication?.isProductAdmin).toBe(true);
    expect((await run({ ...authenticated, isProductAdmin: false })).authentication?.isProductAdmin).toBe(false);
  });
});

describe("requireProductAdmin", () => {
  const PRODUCT_ADMIN_REFUSAL = {
    code: "product_admin_required",
    message: "Only a product admin can do that.",
    statusCode: 403,
  };

  it("passes a product admin", async () => {
    const request = await run({ ...authenticated, isProductAdmin: true });
    await expect(requireProductAdmin(request)).resolves.toBeUndefined();
  });

  it("refuses a user without the flag with 403 product_admin_required, whatever their organization role", async () => {
    const contributor = requireProductAdmin(await run(authenticated));
    await expect(contributor).rejects.toBeInstanceOf(AppError);
    await expect(contributor).rejects.toMatchObject(PRODUCT_ADMIN_REFUSAL);
    const organizationAdmin = await run({
      ...authenticated,
      organization: { ...authenticated.organization, role: "admin" },
    });
    await expect(requireProductAdmin(organizationAdmin)).rejects.toMatchObject(PRODUCT_ADMIN_REFUSAL);
  });

  it("fails closed with 401 unauthenticated on a route without authenticate", async () => {
    const request = { authentication: null } as unknown as FastifyRequest;
    await expect(requireProductAdmin(request)).rejects.toMatchObject({ code: "unauthenticated", statusCode: 401 });
  });
});
