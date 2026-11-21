import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, registerErrorHandling } from "../errors.js";
import { currentPasswordIncorrect, passwordNotSet } from "../modules/account/errors.js";
import { decorateAuthentication, type RequestAuthentication } from "../modules/sessions/authenticate.js";
import {
  ANONYMOUS_VALIDATIONS_IN_FLIGHT,
  ANONYMOUS_VALIDATIONS_IN_FLIGHT_PER_IP,
  createAnonymousValidationLimiter,
  createApiTokenFailureLimiter,
  createFleetLimiter,
  createPerKeyLimiter,
  createPerUserLimiter,
  FLEET_REQUESTS_IN_FLIGHT_PER_USER,
  createValidationLimiter,
  RATE_LIMITS,
  registerRateLimits,
  TEST_RATE_LIMITS,
  VALIDATIONS_IN_FLIGHT_PER_USER,
} from "./rate-limits.js";

const MINUTE_MS = 60_000;

describe("RATE_LIMITS", () => {
  it("are the production numbers", () => {
    // Written out, not derived, so changing a limit takes a deliberate edit here too.
    expect(RATE_LIMITS).toEqual({
      identityPerIp: { max: 30, windowMs: 5 * MINUTE_MS },
      signInPerEmail: { max: 10, windowMs: 15 * MINUTE_MS },
      refreshPerIp: { max: 150, windowMs: 5 * MINUTE_MS },
      emailPerAddress: { max: 5, windowMs: 60 * MINUTE_MS },
      invitationEmailsPerUser: { max: 50, windowMs: 60 * MINUTE_MS },
      salesInquiriesPerIp: { max: 3, windowMs: 10 * MINUTE_MS },
      validationsPerUser: { max: 60, windowMs: MINUTE_MS },
      flowLintsPerUser: { max: 20, windowMs: MINUTE_MS },
      testFileUploadsPerUser: { max: 30, windowMs: MINUTE_MS },
      testRunsPerUser: { max: 20, windowMs: MINUTE_MS },
      validationRuleChecksPerUser: { max: 30, windowMs: MINUTE_MS },
      fleetReadsPerUser: { max: 240, windowMs: MINUTE_MS },
      fleetWritesPerUser: { max: 240, windowMs: MINUTE_MS },
      fleetBearerRepliesPerUser: { max: 10, windowMs: MINUTE_MS },
      quickDeployPerIp: { max: 30, windowMs: MINUTE_MS },
      quickDeployPerLink: { max: 60, windowMs: MINUTE_MS },
      organizationLogosPerIp: { max: 600, windowMs: MINUTE_MS },
      libraryFileDownloadsPerUser: { max: 60, windowMs: MINUTE_MS },
      libraryFileLinksPerUser: { max: 30, windowMs: MINUTE_MS },
      libraryLinksPerIp: { max: 30, windowMs: MINUTE_MS },
      libraryLinkDownloadsPerLink: { max: 60, windowMs: MINUTE_MS },
      apiTokenFailuresPerIp: { max: 30, windowMs: 5 * MINUTE_MS },
      publicApiPerToken: { max: 60, windowMs: MINUTE_MS },
      ottlLintsPerUser: { max: 30, windowMs: MINUTE_MS },
      anonymousValidationsPerIp: { max: 10, windowMs: MINUTE_MS },
      anonymousValidations: { max: 120, windowMs: MINUTE_MS },
      productAdminWritesPerUser: { max: 30, windowMs: MINUTE_MS },
      productAdminDeletesPerUser: { max: 10, windowMs: MINUTE_MS },
      feedbackPerUser: { max: 10, windowMs: 60 * MINUTE_MS },
      publishedFlowReadsPerIp: { max: 60, windowMs: MINUTE_MS },
    });
    // One at a time per address, four across every anonymous caller.
    expect(ANONYMOUS_VALIDATIONS_IN_FLIGHT_PER_IP).toBe(1);
    expect(ANONYMOUS_VALIDATIONS_IN_FLIGHT).toBe(4);
    // A fleet page's four reads, three tabs' 12, a write in each 15, within
    // the 16.
    expect(FLEET_REQUESTS_IN_FLIGHT_PER_USER).toBe(16);
  });

  it("each has a test override, so no test server meets a production limit by accident", () => {
    expect(Object.keys(TEST_RATE_LIMITS).sort()).toEqual(Object.keys(RATE_LIMITS).sort());
    // The browser tests run the public download from one address (hop count 0): theirs are out of reach.
    expect(TEST_RATE_LIMITS.quickDeployPerIp).toEqual({ max: 1_000_000, windowMs: MINUTE_MS });
    expect(TEST_RATE_LIMITS.quickDeployPerLink).toEqual({ max: 1_000_000, windowMs: MINUTE_MS });
    // Every signed-in page of every browser test shows logos, from one address too.
    expect(TEST_RATE_LIMITS.organizationLogosPerIp).toEqual({ max: 1_000_000, windowMs: MINUTE_MS });
    // The library's browser test downloads by link and by session from one address and one person.
    for (const key of ["libraryFileDownloadsPerUser", "libraryFileLinksPerUser", "libraryLinksPerIp", "libraryLinkDownloadsPerLink"] as const) {
      expect(TEST_RATE_LIMITS[key]).toEqual({ max: 1_000_000, windowMs: MINUTE_MS });
    }
    // The playground's browser tests read the open flow list and slugs from one address.
    expect(TEST_RATE_LIMITS.publishedFlowReadsPerIp).toEqual({ max: 1_000_000, windowMs: MINUTE_MS });
  });
});

describe("createAnonymousValidationLimiter", () => {
  const limits = (perIp: number, overall: number) => ({
    anonymousValidationsPerIp: { max: perIp, windowMs: MINUTE_MS },
    anonymousValidations: { max: overall, windowMs: MINUTE_MS },
  });
  /** The refusal's status, code and Retry-After, or "admitted" (its slots released at once unless kept). */
  const attempt = (limiter: ReturnType<typeof createAnonymousValidationLimiter>, ip: string, keep: Array<() => void> = []) => {
    try {
      const admission = limiter.admit(ip);
      keep.push(() => admission.release());
      return "admitted";
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return `${error.statusCode} ${error.code} ${String(error.headers?.["retry-after"])}`;
    }
  };

  it("admits an address's max a minute, then 429 rate_limited with the window's remaining seconds; another address has its own", () => {
    let now = 0;
    const limiter = createAnonymousValidationLimiter(limits(2, 100), { now: () => now });
    const kept: Array<() => void> = [];
    expect(attempt(limiter, "192.0.2.1", kept)).toBe("admitted");
    kept.pop()!();
    expect(attempt(limiter, "192.0.2.1", kept)).toBe("admitted");
    kept.pop()!();
    now = 15_000;
    expect(attempt(limiter, "192.0.2.1")).toBe("429 rate_limited 45");
    expect(attempt(limiter, "192.0.2.2", kept)).toBe("admitted");
    kept.pop()!();
    now = MINUTE_MS;
    expect(attempt(limiter, "192.0.2.1", kept)).toBe("admitted");
  });

  it("holds one in flight per address and four overall, each refusal Retry-After 1; a release frees both, once", () => {
    const limiter = createAnonymousValidationLimiter(limits(100, 100), { now: () => 0 });
    const kept: Array<() => void> = [];
    expect(attempt(limiter, "192.0.2.1", kept)).toBe("admitted");
    expect(attempt(limiter, "192.0.2.1")).toBe("429 rate_limited 1");
    for (const ip of ["192.0.2.2", "192.0.2.3", "192.0.2.4"]) expect(attempt(limiter, ip, kept)).toBe("admitted");
    expect(attempt(limiter, "192.0.2.5")).toBe("429 rate_limited 1");
    const first = kept[0]!;
    first();
    first();
    // Released twice, it freed one slot of each level: 192.0.2.1's own and one overall.
    expect(attempt(limiter, "192.0.2.5", kept)).toBe("admitted");
    expect(attempt(limiter, "192.0.2.1")).toBe("429 rate_limited 1");
    kept[1]!();
    expect(attempt(limiter, "192.0.2.1", kept)).toBe("admitted");
  });

  it("checks both levels before recording either: an overall refusal spends nothing of the address's minute, nor an address's refusal of the overall's", () => {
    let now = 0;
    const limiter = createAnonymousValidationLimiter(limits(2, 3), { now: () => now });
    const done: Array<() => void> = [];
    // The overall minute: three addresses spend it.
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) expect(attempt(limiter, ip, done)).toBe("admitted");
    done.splice(0).forEach((release) => release());
    // 192.0.2.4 is refused overall, many times: nothing of its own minute is spent.
    for (let tries = 0; tries < 5; tries += 1) expect(attempt(limiter, "192.0.2.4")).toBe("429 rate_limited 60");
    now = MINUTE_MS;
    expect(attempt(limiter, "192.0.2.4", done)).toBe("admitted");
    expect(attempt(limiter, "192.0.2.4", done.slice(0, 0))).toBe("429 rate_limited 1");
    done.splice(0).forEach((release) => release());
    expect(attempt(limiter, "192.0.2.4", done)).toBe("admitted");
    done.splice(0).forEach((release) => release());
    // Its own minute spent (two), its refusals spend nothing of the overall's: one is left for another address.
    for (let tries = 0; tries < 5; tries += 1) expect(attempt(limiter, "192.0.2.4")).toBe("429 rate_limited 60");
    expect(attempt(limiter, "192.0.2.5", done)).toBe("admitted");
    expect(attempt(limiter, "192.0.2.6")).toBe("429 rate_limited 60");
  });
});

describe("createPerUserLimiter", () => {
  const ACME = "0199e000-0000-7000-8000-00000000ac01";
  const GLOBEX = "0199e000-0000-7000-8000-00000000610b";

  it("counts a person's admissions in each organization apart: their minute in one never spends another's", () => {
    const limiter = createPerUserLimiter({ max: 2, windowMs: MINUTE_MS }, { now: () => 0 });
    expect(limiter.admit("a", GLOBEX)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", GLOBEX)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", GLOBEX)).toMatchObject({ isAdmitted: false });

    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    const refunded = limiter.admit("a", ACME);
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: false });
    // A refund gives back to its own organization's count only.
    if (refunded.isAdmitted) refunded.refund();
    expect(limiter.admit("a", GLOBEX)).toMatchObject({ isAdmitted: false });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
  });

  it("counts the person alone (null, a route with no organization) apart from each of their organizations", () => {
    const limiter = createPerUserLimiter({ max: 2, windowMs: MINUTE_MS }, { now: () => 0 });
    expect(limiter.admit("a", null)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", null)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", null)).toMatchObject({ isAdmitted: false });
    // Their organizations' counts are untouched, and spend nothing of it.
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: false });
    expect(limiter.admit("a", GLOBEX)).toMatchObject({ isAdmitted: true });
    // Another person alone has their own.
    expect(limiter.admit("b", null)).toMatchObject({ isAdmitted: true });
  });

  it("gives back an admission the caller refused for another reason, once", () => {
    let now = 0;
    const limiter = createPerUserLimiter({ max: 2, windowMs: MINUTE_MS }, { now: () => now });
    const first = limiter.admit("a", ACME);
    if (!first.isAdmitted) throw new Error("admitted expected");
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: false });

    first.refund();
    first.refund();
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: false });

    // A refund after its window has ended gives nothing to the next window.
    const late = limiter.admit("b", ACME);
    now = MINUTE_MS;
    expect(limiter.admit("b", ACME)).toMatchObject({ isAdmitted: true });
    if (late.isAdmitted) late.refund();
    expect(limiter.admit("b", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("b", ACME)).toMatchObject({ isAdmitted: false });
  });

  it("gives back only to the window the admission counted in, even when the clock ticks past its end during the admission", () => {
    // The clock, read by the limiter only: while `isTicking`, every reading
    // moves it on by 1 ms, as a real clock can between two readings.
    let now = 0;
    let isTicking = false;
    const clock = () => {
      const at = now;
      if (isTicking) now += 1;
      return at;
    };
    const limiter = createPerUserLimiter({ max: 2, windowMs: MINUTE_MS }, { now: clock });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });

    // Counted in the window opened at 0, in its last millisecond…
    now = MINUTE_MS - 2;
    isTicking = true;
    const late = limiter.admit("a", ACME);
    isTicking = false;
    if (!late.isAdmitted) throw new Error("admitted expected");
    // …then a new window opens at MINUTE_MS with another admission.
    now = MINUTE_MS;
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });

    // The late refund's window has ended: the new window keeps its count.
    late.refund();
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: false });
  });

  it("admits and counts up to the limit per person, then says when the window ends", () => {
    let now = 0;
    const limiter = createPerUserLimiter({ max: 2, windowMs: MINUTE_MS }, { now: () => now });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME)).toEqual({ isAdmitted: false, retryAfterSeconds: 60 });
    // Another person's are their own.
    expect(limiter.admit("b", ACME)).toMatchObject({ isAdmitted: true });
    now = 45_000;
    expect(limiter.admit("a", ACME)).toEqual({ isAdmitted: false, retryAfterSeconds: 15 });
    now = MINUTE_MS;
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
  });

  it("counts nothing for a refusal", () => {
    let now = 0;
    const limiter = createPerUserLimiter({ max: 1, windowMs: MINUTE_MS }, { now: () => now });
    limiter.admit("a", ACME);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: false });
    now = MINUTE_MS;
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME)).toMatchObject({ isAdmitted: false });
  });
});

describe("createValidationLimiter", () => {
  const calls = { callsValidator: true };
  const retired = { callsValidator: false };

  function admitted(result: ReturnType<ReturnType<typeof createValidationLimiter>["admit"]>): () => void {
    if (!result.isAdmitted) throw new Error(`refused: ${result.reason}`);
    return result.release;
  }

  it("lets two of a person's checks wait on the validator at once, and refuses a third for a second", () => {
    expect(VALIDATIONS_IN_FLIGHT_PER_USER).toBe(2);
    const limiter = createValidationLimiter({ max: 60, windowMs: MINUTE_MS });
    admitted(limiter.admit("a", calls));
    admitted(limiter.admit("a", calls));

    expect(limiter.admit("a", calls)).toEqual({ isAdmitted: false, reason: "in_flight", retryAfterSeconds: 1 });
    // Another person's are their own.
    admitted(limiter.admit("b", calls));
  });

  it("frees a slot when a check ends, once however often it is released", () => {
    const limiter = createValidationLimiter({ max: 60, windowMs: MINUTE_MS });
    const first = admitted(limiter.admit("a", calls));
    admitted(limiter.admit("a", calls));
    first();
    first();

    admitted(limiter.admit("a", calls));
    expect(limiter.admit("a", calls)).toMatchObject({ isAdmitted: false, reason: "in_flight" });
  });

  it("takes no slot for a retired answer, which still counts toward the minute", () => {
    let now = 0;
    const limiter = createValidationLimiter({ max: 3, windowMs: MINUTE_MS }, { now: () => now });
    admitted(limiter.admit("a", calls));
    admitted(limiter.admit("a", calls));
    admitted(limiter.admit("a", retired));

    expect(limiter.admit("a", retired)).toEqual({ isAdmitted: false, reason: "per_minute", retryAfterSeconds: 60 });
    now = 30_000;
    expect(limiter.admit("a", retired)).toEqual({ isAdmitted: false, reason: "per_minute", retryAfterSeconds: 30 });
    now = MINUTE_MS;
    admitted(limiter.admit("a", retired));
  });

  it("counts nothing for a check it refuses for being in flight", () => {
    const limiter = createValidationLimiter({ max: 3, windowMs: MINUTE_MS }, { now: () => 0 });
    const first = admitted(limiter.admit("a", calls));
    admitted(limiter.admit("a", calls));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.admit("a", calls)).toMatchObject({ isAdmitted: false, reason: "in_flight" });
    }
    first();

    // The third of the minute, not the eighth.
    admitted(limiter.admit("a", calls));
    expect(limiter.admit("a", retired)).toMatchObject({ isAdmitted: false, reason: "per_minute" });
  });
});

describe("createFleetLimiter", () => {
  const ACME = "0199e000-0000-7000-8000-00000000ac01";
  const GLOBEX = "0199e000-0000-7000-8000-00000000610b";
  const limits = {
    fleetReadsPerUser: { max: 3, windowMs: MINUTE_MS },
    fleetWritesPerUser: { max: 2, windowMs: MINUTE_MS },
    fleetBearerRepliesPerUser: { max: 1, windowMs: MINUTE_MS },
  };

  it("counts reads, writes and bearer replies apart, each spending only its own, per person per organization", () => {
    let now = 0;
    const limiter = createFleetLimiter(limits, { now: () => now });
    const admitted = (kind: "read" | "write" | "bearer", organizationId = ACME, userId = "a") => {
      const admission = limiter.admit(userId, organizationId, kind);
      if (admission.isAdmitted) admission.release();
      return admission.isAdmitted;
    };
    expect([admitted("bearer"), admitted("bearer")]).toEqual([true, false]);
    expect([admitted("write"), admitted("write"), admitted("write")]).toEqual([true, true, false]);
    expect([admitted("read"), admitted("read"), admitted("read"), admitted("read")]).toEqual([true, true, true, false]);
    // Another organization's, and another person's, are their own.
    expect([admitted("bearer", GLOBEX), admitted("bearer", ACME, "b")]).toEqual([true, true]);

    now += 30_000;
    const refused = limiter.admit("a", ACME, "bearer");
    expect(refused).toEqual({ isAdmitted: false, reason: "per_minute", retryAfterSeconds: 30 });
    now = MINUTE_MS;
    expect(admitted("bearer")).toBe(true);
  });

  it("holds at most 16 requests of a person's in an organization in flight, whatever their kinds; Retry-After 1", () => {
    const limiter = createFleetLimiter(
      {
        fleetReadsPerUser: { max: 1_000, windowMs: MINUTE_MS },
        fleetWritesPerUser: { max: 1_000, windowMs: MINUTE_MS },
        fleetBearerRepliesPerUser: { max: 1_000, windowMs: MINUTE_MS },
      },
      { now: () => 0 },
    );
    const held = Array.from({ length: FLEET_REQUESTS_IN_FLIGHT_PER_USER }, (_, n) =>
      limiter.admit("a", ACME, (["read", "write", "bearer"] as const)[n % 3] ?? "read"),
    );
    expect(held.every((admission) => admission.isAdmitted)).toBe(true);
    expect(limiter.admit("a", ACME, "read")).toEqual({ isAdmitted: false, reason: "in_flight", retryAfterSeconds: 1 });
    // Another organization's slots are its own.
    expect(limiter.admit("a", GLOBEX, "read")).toMatchObject({ isAdmitted: true });

    const first = held[0];
    if (!first?.isAdmitted) throw new Error("admitted expected");
    first.release();
    first.release();
    expect(limiter.admit("a", ACME, "write")).toMatchObject({ isAdmitted: true });
    expect(limiter.admit("a", ACME, "write")).toMatchObject({ isAdmitted: false, reason: "in_flight" });
  });

  it("counts nothing for a refusal", () => {
    const limiter = createFleetLimiter(limits, { now: () => 0 });
    const holds = Array.from({ length: FLEET_REQUESTS_IN_FLIGHT_PER_USER }, () => limiter.admit("a", ACME, "read"));
    // Three admitted reads, then refusals that take no slot and no count.
    expect(holds.filter((admission) => admission.isAdmitted)).toHaveLength(3);
    expect(limiter.admit("a", ACME, "write")).toMatchObject({ isAdmitted: true });
  });
});

describe("createPerKeyLimiter", () => {
  /** The 429 a refused count throws, or undefined when it was counted. */
  const refusal = (count: () => void): AppError | undefined => {
    try {
      count();
      return undefined;
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
  };

  it("counts every attempt per key up to the limit, then throws the 429 rate_limited with the window's Retry-After", () => {
    let now = 0;
    const limiter = createPerKeyLimiter({ max: 2, windowMs: MINUTE_MS }, { now: () => now });
    expect(refusal(() => limiter.count("link-1"))).toBeUndefined();
    expect(refusal(() => limiter.count("link-1"))).toBeUndefined();
    now = 15_000;
    const refused = refusal(() => limiter.count("link-1"));
    expect(refused).toMatchObject({ code: "rate_limited", statusCode: 429, headers: { "retry-after": 45 } });
    // Another key's count is its own.
    expect(refusal(() => limiter.count("link-2"))).toBeUndefined();
    // Once the window ends, the key starts again.
    now = MINUTE_MS;
    expect(refusal(() => limiter.count("link-1"))).toBeUndefined();
  });

  it("counts nothing for a refusal", () => {
    let now = 0;
    const limiter = createPerKeyLimiter({ max: 1, windowMs: MINUTE_MS }, { now: () => now });
    limiter.count("link-1");
    for (let attempt = 0; attempt < 5; attempt += 1) expect(refusal(() => limiter.count("link-1"))).toBeDefined();
    now = MINUTE_MS;
    expect(refusal(() => limiter.count("link-1"))).toBeUndefined();
    expect(refusal(() => limiter.count("link-1"))).toBeDefined();
  });

  it("holds at most maxKeys keys, dropping the oldest window first", () => {
    let now = 0;
    const limiter = createPerKeyLimiter({ max: 1, windowMs: MINUTE_MS }, { maxKeys: 3, now: () => now });
    for (const key of ["a", "b", "c", "d", "e"]) {
      limiter.count(key);
      now += 1;
      expect(limiter.size).toBeLessThanOrEqual(3);
    }
    expect(limiter.size).toBe(3);
    // "a" and "b" were dropped (they start again); "e" is still counted.
    expect(refusal(() => limiter.count("a"))).toBeUndefined();
    expect(refusal(() => limiter.count("e"))).toBeDefined();
  });

  it("is bounded by default at the failure limiter's 10,000 keys", () => {
    const limiter = createPerKeyLimiter({ max: 1, windowMs: MINUTE_MS }, { now: () => 0 });
    for (let key = 0; key < 10_050; key += 1) limiter.count(`link-${key}`);
    expect(limiter.size).toBe(10_000);
  });
});

describe("createApiTokenFailureLimiter's attempts", () => {
  /** The 429's Retry-After when the address is blocked, or undefined when it isn't. */
  const retryAfter = (check: () => void): string | number | undefined => {
    try {
      check();
      return undefined;
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("rate_limited");
      return (error as AppError).headers?.["retry-after"];
    }
  };

  it("begin → refund → refund: a second refund never lowers another request's attempt in flight", () => {
    const limiter = createApiTokenFailureLimiter({ max: 2, windowMs: MINUTE_MS });
    const first = limiter.begin("203.0.113.7");
    limiter.begin("203.0.113.7");
    expect(retryAfter(() => limiter.assertNotBlocked("203.0.113.7"))).toBe(1);
    first.refund();
    expect(retryAfter(() => limiter.assertNotBlocked("203.0.113.7"))).toBeUndefined();
    first.refund();
    // The second's attempt is still in flight: one more fills the limit again.
    limiter.begin("203.0.113.7");
    expect(retryAfter(() => limiter.assertNotBlocked("203.0.113.7"))).toBe(1);
  });

  it("begin → fail → refund: a refusal's finally-refund never lowers another request's attempt in flight", () => {
    // The token check's refusal path: fail() settles the attempt, then the
    // finally's refund() must do nothing.
    const limiter = createApiTokenFailureLimiter({ max: 2, windowMs: MINUTE_MS });
    const refused = limiter.begin("203.0.113.7");
    limiter.begin("203.0.113.7");
    refused.fail();
    refused.refund();
    // One settled failure and one attempt still in flight fill the limit.
    expect(retryAfter(() => limiter.assertNotBlocked("203.0.113.7"))).toBe(1);
  });
});

/*
 * Sign-in's per-email limiter's session-keyed form, on a bare server with
 * no database: a stand-in for `authenticate` sets the session's email from
 * a header, so a test can send a body naming another address. Real routes
 * and Postgres are rate-limits.integration.test.ts's.
 */
describe("signInPerEmail's session-keyed form", () => {
  const MAX = 3;
  const servers: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  type Outcome = "verified" | "incorrect" | "not_set" | "crashed";

  async function serverWith(): Promise<FastifyInstance> {
    const server = Fastify();
    servers.push(server);
    registerErrorHandling(server);
    decorateAuthentication(server);
    const limiters = registerRateLimits(server, {
      ...TEST_RATE_LIMITS,
      signInPerEmail: { max: MAX, windowMs: 15 * MINUTE_MS },
    });
    const sessionStandIn = async (request: { headers: Record<string, unknown>; authentication: unknown }) => {
      const email = request.headers["x-session-email"];
      if (typeof email === "string") request.authentication = { email } as RequestAuthentication;
    };
    // The route's settle, as the password change's: exactly once, in a finally.
    server.post<{ Body: { outcome: Outcome; email?: string } }>(
      "/reauthenticate",
      { preHandler: [sessionStandIn, limiters.signInPerEmail.reauthenticationPreHandler] },
      async (request, reply) => {
        const email = (request.authentication as RequestAuthentication).email;
        let isVerified = false;
        let failure: unknown;
        try {
          // A turn of the event loop, as a verify takes, so concurrent requests overlap.
          await new Promise((resolve) => setImmediate(resolve));
          if (request.body.outcome === "incorrect") throw currentPasswordIncorrect();
          if (request.body.outcome === "not_set") throw passwordNotSet();
          if (request.body.outcome === "crashed") throw new Error("the database went away");
          isVerified = true;
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          if (isVerified) limiters.signInPerEmail.reauthenticated(email);
          else limiters.signInPerEmail.reauthenticationSettled(email, failure);
        }
        return reply.status(204).send();
      },
    );
    // Sign-in's own form, settled as the sign-in route settles it.
    server.post<{ Body: { email: string } }>(
      "/sign-in",
      { preHandler: limiters.signInPerEmail.preHandler },
      async (request) => {
        const error = new AppError("invalid_credentials", "Invalid login credentials", 401);
        limiters.signInPerEmail.failed(request.body.email, error);
        throw error;
      },
    );
    await server.ready();
    return server;
  }

  const reauthenticate = (server: FastifyInstance, sessionEmail: string | undefined, outcome: Outcome, bodyEmail?: string) =>
    server.inject({
      method: "POST",
      url: "/reauthenticate",
      headers: sessionEmail === undefined ? {} : { "x-session-email": sessionEmail },
      payload: { outcome, ...(bodyEmail === undefined ? {} : { email: bodyEmail }) },
    });

  const signIn = (server: FastifyInstance, email: string) =>
    server.inject({ method: "POST", url: "/sign-in", payload: { email } });

  function expectLimited(response: { statusCode: number; headers: Record<string, unknown>; json: () => unknown }): void {
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  }

  it("keeps the count for current_password_incorrect, and refuses the attempt after max with 429 and Retry-After", async () => {
    const server = await serverWith();
    for (let attempt = 0; attempt < MAX; attempt += 1) {
      expect((await reauthenticate(server, "a@example.com", "incorrect")).statusCode).toBe(400);
    }
    expectLimited(await reauthenticate(server, "a@example.com", "verified"));
  });

  it("refunds anything else: a 409, a server failure", async () => {
    const server = await serverWith();
    for (let attempt = 0; attempt < MAX + 1; attempt += 1) {
      expect((await reauthenticate(server, "a@example.com", "not_set")).statusCode).toBe(409);
      expect((await reauthenticate(server, "a@example.com", "crashed")).statusCode).toBe(500);
    }
    expect((await reauthenticate(server, "a@example.com", "incorrect")).statusCode).toBe(400);
  });

  it("resets the address on a verified password", async () => {
    const server = await serverWith();
    for (let attempt = 0; attempt < MAX - 1; attempt += 1) await reauthenticate(server, "a@example.com", "incorrect");
    expect((await reauthenticate(server, "a@example.com", "verified")).statusCode).toBe(204);
    for (let attempt = 0; attempt < MAX; attempt += 1) {
      expect((await reauthenticate(server, "a@example.com", "incorrect")).statusCode).toBe(400);
    }
    expectLimited(await reauthenticate(server, "a@example.com", "verified"));
  });

  it("keys on the session's address, never on an address in the body", async () => {
    const server = await serverWith();
    for (let attempt = 0; attempt < MAX; attempt += 1) {
      await reauthenticate(server, "session@example.com", "incorrect", "body@example.com");
    }
    expectLimited(await reauthenticate(server, "session@example.com", "verified", "body@example.com"));
    expect((await reauthenticate(server, "body@example.com", "verified", "session@example.com")).statusCode).toBe(204);
  });

  it("shares sign-in's budget for the address, however it is capitalized", async () => {
    const server = await serverWith();
    expect((await signIn(server, "shared@example.com")).statusCode).toBe(401);
    expect((await reauthenticate(server, "Shared@Example.com", "incorrect")).statusCode).toBe(400);
    expect((await signIn(server, "shared@example.com")).statusCode).toBe(401);

    expectLimited(await signIn(server, "shared@example.com"));
    expectLimited(await reauthenticate(server, "shared@example.com", "verified"));
  });

  it("counts up front, so at most max concurrent wrong passwords for one address are tried", async () => {
    const server = await serverWith();
    const responses = await Promise.all(
      Array.from({ length: MAX + 2 }, () => reauthenticate(server, "a@example.com", "incorrect")),
    );
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((status) => status === 400)).toHaveLength(MAX);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
  });

  it("fails closed without a session: 401, and counts nothing", async () => {
    const server = await serverWith();
    for (let attempt = 0; attempt < MAX + 1; attempt += 1) {
      const response = await reauthenticate(server, undefined, "incorrect");
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    }
  });
});
