import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { ACCOUNT_ERROR_CODES } from "./account.js";
import { CONFIGURATION_ERROR_CODES } from "./configurations.js";
import { FLEET_ERROR_CODES } from "./fleets.js";
import { FLOW_ERROR_CODES } from "./flows.js";
import { IDENTITY_ERROR_CODES } from "./identity.js";
import { ORGANIZATION_ERROR_CODES } from "./organizations.js";
import { QUICK_DEPLOY_LINK_ERROR_CODES } from "./quick-deploy.js";
import { SALES_INQUIRY_ERROR_CODES } from "./sales-inquiries.js";
import * as serviceAccounts from "./service-accounts.js";
import {
  API_TOKEN_ACCESS,
  API_TOKEN_EXPIRY_DAYS_MAXIMUM,
  API_TOKEN_EXPIRY_DAYS_MESSAGE,
  API_TOKEN_NAME_MAXIMUM_LENGTH,
  API_TOKEN_PATTERN,
  API_TOKEN_PREFIX_PATTERN,
  API_TOKENS_LIVE_MAXIMUM,
  ApiTokenNameSchema,
  ApiTokenSchema,
  ApiTokensResponseSchema,
  CreateApiTokenRequestSchema,
  CreatedApiTokenResponseSchema,
  CreateServiceAccountRequestSchema,
  DELETED_ACCOUNT_EMAIL_DOMAIN,
  isReservedEmail,
  isServiceAccountEmail,
  RenameServiceAccountRequestSchema,
  SERVICE_ACCOUNT_EMAIL_DOMAIN,
  SERVICE_ACCOUNT_ERROR_CODES,
  SERVICE_ACCOUNT_ERROR_MESSAGES,
  SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH,
  SERVICE_ACCOUNTS_MAXIMUM,
  serviceAccountEmail,
  ServiceAccountNameSchema,
  ServiceAccountResponseSchema,
  ServiceAccountSchema,
  ServiceAccountsResponseSchema,
  WhoAmIResponseSchema,
  type ServiceAccountErrorCode,
} from "./service-accounts.js";
import { OIDC_LINK_RESULT_CODES, OIDC_QUERY_ERROR_CODES, SESSION_ERROR_CODES } from "./sessions.js";
import { emailSchema } from "./shared.js";
import { TEST_REGEX_ERROR_CODES } from "./test-regexes.js";
import { TESTING_ERROR_CODES } from "./test-runs.js";
import { VALIDATION_RULES_ERROR_CODES } from "./validation-rules.js";
import { VARIABLE_ERROR_CODES } from "./variables.js";

const HEX = "0a1b2c3d";
const DOMAIN = "@service-accounts.telflo.invalid";

// A token's shape, built at run time: never a literal token in a
// committed file. Assertions below compare booleans only, so a failure
// never prints it.
const TOKEN = `tf_${"aZ09_-".repeat(7)}x`;
const PREFIX = TOKEN.slice(0, 11);

const creator = { userId: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e63", email: "sam@acme.example" };
const account = {
  id: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e60",
  name: "CI pipeline",
  email: `ci-pipeline-${HEX}${DOMAIN}`,
  createdAt: "2026-10-23T10:00:00.000Z",
  createdBy: creator,
  tokenCount: 2,
};
const apiToken = {
  id: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e61",
  name: "GitHub Actions",
  prefix: PREFIX,
  access: "read",
  expiresAt: "2027-01-21T10:00:00.000Z",
  lastUsedAt: null,
  createdAt: "2026-10-23T10:00:00.000Z",
  isExpired: false,
};
const createToken = { name: "GitHub Actions", access: "write", expiresInDays: 90 };
const whoAmI = {
  organizationId: "0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e62",
  tokenName: "GitHub Actions",
  access: "write",
  kind: "service_account",
};

describe("serviceAccountEmail", () => {
  it.each([
    ["CI Pipeline", `ci-pipeline-${HEX}${DOMAIN}`],
    ["!!!", `${HEX}${DOMAIN}`],
    ["x".repeat(200), `${"x".repeat(32)}-${HEX}${DOMAIN}`],
    ["  build   &&   deploy  ", `build-deploy-${HEX}${DOMAIN}`],
    // Names of 0, 1, 32, 33 and 64 characters.
    ["", `${HEX}${DOMAIN}`],
    ["a", `a-${HEX}${DOMAIN}`],
    ["a".repeat(32), `${"a".repeat(32)}-${HEX}${DOMAIN}`],
    ["a".repeat(33), `${"a".repeat(32)}-${HEX}${DOMAIN}`],
    ["a".repeat(64), `${"a".repeat(32)}-${HEX}${DOMAIN}`],
    // No trailing - after the cut.
    [`${"a".repeat(31)} b`, `${"a".repeat(31)}-${HEX}${DOMAIN}`],
    [`${"a".repeat(31)}!!!b`, `${"a".repeat(31)}-${HEX}${DOMAIN}`],
    [`${"a".repeat(30)}--bc`, `${"a".repeat(30)}-b-${HEX}${DOMAIN}`],
    // Lowercased; runs outside [a-z0-9] become one -; trimmed of -.
    ["PROD", `prod-${HEX}${DOMAIN}`],
    ["CI_Deploy.v2", `ci-deploy-v2-${HEX}${DOMAIN}`],
    ["--ci--", `ci-${HEX}${DOMAIN}`],
    ["123", `123-${HEX}${DOMAIN}`],
    // Non-ASCII is outside [a-z0-9].
    ["Café Ünïcode", `caf-n-code-${HEX}${DOMAIN}`],
    ["日本語", `${HEX}${DOMAIN}`],
    ["🚀 deploy", `deploy-${HEX}${DOMAIN}`],
    // Non-ASCII whose lowercase is ASCII: the Kelvin sign (U+212A) lowercases
    // to k; the dotted capital I (U+0130) to i and a combining dot (U+0307),
    // which becomes a -.
    ["\u212A", `k-${HEX}${DOMAIN}`],
    ["\u212Aube", `kube-${HEX}${DOMAIN}`],
    ["\u0130", `i-${HEX}${DOMAIN}`],
    ["\u0130stanbul", `i-stanbul-${HEX}${DOMAIN}`],
    // All punctuation.
    ["!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", `${HEX}${DOMAIN}`],
  ])("the slug rule: lowercased, runs outside [a-z0-9] become -, trimmed of -, at most 32 characters, no trailing - after the cut, and no slug gives <hex>@ (%j)", (name, address) => {
    expect(serviceAccountEmail(name, HEX)).toBe(address);
  });

  it("every address is a valid email at the reserved domain, its slug at most 32 characters", () => {
    for (const name of ["CI Pipeline", "", "x".repeat(64), "日本語", `${"a".repeat(31)} b`]) {
      const address = serviceAccountEmail(name, HEX);
      expect(emailSchema.safeParse(address).success, address).toBe(true);
      expect(isServiceAccountEmail(address), address).toBe(true);
      const localPart = address.slice(0, address.indexOf("@"));
      expect(localPart.length).toBeLessThanOrEqual(32 + 1 + 8);
      expect(localPart.endsWith(HEX)).toBe(true);
    }
  });

  it.each(["", "0a1b2c3", "0a1b2c3d4", "0A1B2C3D", "0a1b2c3g", "0a1b-c3d"])(
    "refuses a random part that isn't eight lowercase hex digits (%j)",
    (randomHex) => {
      expect(() => serviceAccountEmail("ci", randomHex)).toThrow("eight lowercase hex digits");
    },
  );
});

describe("isServiceAccountEmail", () => {
  it("isServiceAccountEmail matches the domain case aside and trimmed, and no subdomain or lookalike", () => {
    expect(SERVICE_ACCOUNT_EMAIL_DOMAIN).toBe("service-accounts.telflo.invalid");

    for (const email of [
      `ci-${HEX}@service-accounts.telflo.invalid`,
      `${HEX}@service-accounts.telflo.invalid`,
      "X@Service-Accounts.Telflo.Invalid",
      "x@SERVICE-ACCOUNTS.TELFLO.INVALID",
      "  x@service-accounts.telflo.invalid  ",
      "x@service-accounts.telflo.invalid\n",
      "real.person@service-accounts.telflo.invalid",
    ]) {
      expect(isServiceAccountEmail(email), email).toBe(true);
    }

    for (const email of [
      "x@service-accounts.telflo.invalid.example",
      "x@xservice-accounts.telflo.invalid",
      "x@sub.service-accounts.telflo.invalid",
      "x@service-accounts.telflo.invalid.",
      "x@service_accounts.telflo.invalid",
      "x@telflo.invalid",
      `sa-ci-${HEX}@telflo.invalid`,
      "service-accounts.telflo.invalid",
      "x@example.com",
      "",
    ]) {
      expect(isServiceAccountEmail(email), email).toBe(false);
    }
  });
});

describe("isReservedEmail", () => {
  it("matches both reserved domains, case aside and trimmed, and no subdomain or lookalike; isServiceAccountEmail keeps its meaning", () => {
    expect(DELETED_ACCOUNT_EMAIL_DOMAIN).toBe("deleted-accounts.telflo.invalid");
    const deleted = `deleted-${"ab".repeat(12)}@deleted-accounts.telflo.invalid`;

    for (const email of [
      `ci-${HEX}@service-accounts.telflo.invalid`,
      "X@Service-Accounts.Telflo.Invalid",
      deleted,
      "X@Deleted-Accounts.Telflo.Invalid",
      "  x@deleted-accounts.telflo.invalid  ",
      "x@DELETED-ACCOUNTS.TELFLO.INVALID\n",
      "real.person@deleted-accounts.telflo.invalid",
    ]) {
      expect(isReservedEmail(email), email).toBe(true);
    }

    for (const email of [
      "x@deleted-accounts.telflo.invalid.example",
      "x@xdeleted-accounts.telflo.invalid",
      "x@sub.deleted-accounts.telflo.invalid",
      "x@deleted_accounts.telflo.invalid",
      "x@sub.service-accounts.telflo.invalid",
      "x@telflo.invalid",
      "deleted-accounts.telflo.invalid",
      "x@example.com",
      "",
    ]) {
      expect(isReservedEmail(email), email).toBe(false);
    }

    expect(isServiceAccountEmail(deleted)).toBe(false);
  });
});

describe("the names", () => {
  it.each([
    ["ServiceAccountNameSchema", ServiceAccountNameSchema, "Service account name is required"],
    ["ApiTokenNameSchema", ApiTokenNameSchema, "Token name is required"],
  ] as const)("names are trimmed and 1 to 64 characters, U+0000 and lone surrogates refused (%s)", (_label, schema, emptyMessage) => {
    expect(SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH).toBe(64);
    expect(API_TOKEN_NAME_MAXIMUM_LENGTH).toBe(64);

    expect(schema.parse("  CI pipeline  ")).toBe("CI pipeline");
    expect(schema.parse("a")).toBe("a");
    expect(schema.parse("a".repeat(64))).toBe("a".repeat(64));
    expect(schema.parse(` ${"a".repeat(64)} `)).toBe("a".repeat(64));
    expect(schema.parse("Déploiement 🚀")).toBe("Déploiement 🚀");

    for (const empty of ["", "   ", "\t\n"]) {
      const result = schema.safeParse(empty);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([emptyMessage]);
    }
    expect(schema.safeParse("a".repeat(65)).success).toBe(false);

    for (const unstorable of ["a\u0000b", "a\uD800b", "\uDC00"]) {
      const result = schema.safeParse(unstorable);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([
        "The name can't contain U+0000 or a lone surrogate.",
      ]);
    }
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it("the create and rename requests take a name by the rule, and nothing else", () => {
    for (const request of [CreateServiceAccountRequestSchema, RenameServiceAccountRequestSchema]) {
      expect(request.parse({ name: "  ci  " })).toEqual({ name: "ci" });
      expect(request.safeParse({ name: "" }).success).toBe(false);
      expect(request.safeParse({}).success).toBe(false);
      expect(request.safeParse({ name: "ci", role: "admin" }).success).toBe(false);
      expect(request.safeParse({ name: "ci", email: `ci-${HEX}${DOMAIN}` }).success).toBe(false);
    }
  });
});

describe("CreateApiTokenRequestSchema", () => {
  it("expiresInDays is a whole number from 1 to 3650 or null", () => {
    expect(API_TOKEN_EXPIRY_DAYS_MAXIMUM).toBe(3650);
    expect(API_TOKEN_EXPIRY_DAYS_MESSAGE).toBe("Enter a whole number of days from 1 to 3650.");

    for (const expiresInDays of [1, 90, 3650, null]) {
      expect(CreateApiTokenRequestSchema.safeParse({ ...createToken, expiresInDays }).success, String(expiresInDays)).toBe(
        true,
      );
    }
    for (const expiresInDays of [0, -1, 3651, 1.5, "7", "", Number.NaN, Number.POSITIVE_INFINITY, true]) {
      const result = CreateApiTokenRequestSchema.safeParse({ ...createToken, expiresInDays });
      expect(result.success, String(expiresInDays)).toBe(false);
      // Infinity fails both the whole-number and the maximum checks: one message either way.
      expect([...new Set(result.error?.issues.map((issue) => issue.message))], String(expiresInDays)).toEqual([
        API_TOKEN_EXPIRY_DAYS_MESSAGE,
      ]);
    }
    // Required: null is never, a missing field is no answer.
    const { expiresInDays: _omitted, ...withoutExpiry } = createToken;
    expect(CreateApiTokenRequestSchema.safeParse(withoutExpiry).success).toBe(false);
  });

  it("takes a name by the rule and access read or write, required", () => {
    expect(API_TOKEN_ACCESS).toEqual(["read", "write"]);
    expect(CreateApiTokenRequestSchema.parse({ ...createToken, name: "  deploy  ", access: "read" })).toEqual({
      ...createToken,
      name: "deploy",
      access: "read",
    });
    expect(CreateApiTokenRequestSchema.safeParse({ ...createToken, name: "" }).success).toBe(false);
    for (const access of ["admin", "READ", "read_write", "", null]) {
      expect(CreateApiTokenRequestSchema.safeParse({ ...createToken, access }).success, String(access)).toBe(false);
    }
    const { access: _omitted, ...withoutAccess } = createToken;
    expect(CreateApiTokenRequestSchema.safeParse(withoutAccess).success).toBe(false);
  });
});

describe("the token", () => {
  it("the create reply's token is tf_ and 43 base64url characters, and the list item holds only the prefix", () => {
    expect(TOKEN.length).toBe(46);
    expect(API_TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(CreatedApiTokenResponseSchema.safeParse({ apiToken, token: TOKEN }).success).toBe(true);

    const malformed = [
      ["42 characters", TOKEN.slice(0, -1)],
      ["44 characters", `${TOKEN}A`],
      ["another prefix", `tqd_${TOKEN.slice(3, -1)}`],
      ["an upper-case prefix", `TF_${TOKEN.slice(3)}`],
      ["no prefix", TOKEN.slice(3)],
      ["standard base64's +", `${TOKEN.slice(0, -1)}+`],
      ["standard base64's /", `${TOKEN.slice(0, -1)}/`],
      ["padding", `${TOKEN.slice(0, -1)}=`],
      ["a line break after it", `${TOKEN}\n`],
      ["the prefix alone", PREFIX],
    ] as const;
    for (const [label, token] of malformed) {
      expect(API_TOKEN_PATTERN.test(token), label).toBe(false);
      expect(CreatedApiTokenResponseSchema.safeParse({ apiToken, token }).success, label).toBe(false);
    }
    expect(CreatedApiTokenResponseSchema.safeParse({ apiToken }).success).toBe(false);

    // The list item: the prefix (tf_ and eight), never the token.
    expect(PREFIX.length).toBe(11);
    expect(API_TOKEN_PREFIX_PATTERN.test(PREFIX)).toBe(true);
    expect(ApiTokenSchema.safeParse(apiToken).success).toBe(true);
    expect(ApiTokenSchema.safeParse({ ...apiToken, prefix: TOKEN }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...apiToken, prefix: PREFIX.slice(0, -1) }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...apiToken, prefix: `tqd_${PREFIX.slice(3, -1)}` }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...apiToken, token: TOKEN }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...apiToken, tokenHash: "a".repeat(64) }).success).toBe(false);
    expect(ApiTokensResponseSchema.safeParse({ items: [apiToken, { ...apiToken, token: TOKEN }] }).success).toBe(false);
  });

  it("a listed token has its access, an expiry and a last use or null, and the API's isExpired", () => {
    expect(ApiTokensResponseSchema.safeParse({ items: [] }).success).toBe(true);
    expect(
      ApiTokensResponseSchema.safeParse({
        items: [apiToken, { ...apiToken, access: "write", expiresAt: null, lastUsedAt: "2026-10-23T11:00:00.000Z", isExpired: true }],
      }).success,
    ).toBe(true);
    expect(ApiTokenSchema.safeParse({ ...apiToken, access: "admin" }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...apiToken, expiresAt: "never" }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...apiToken, isExpired: "false" }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...apiToken, id: "token-1" }).success).toBe(false);
    const { isExpired: _omitted, ...withoutIsExpired } = apiToken;
    expect(ApiTokenSchema.safeParse(withoutIsExpired).success).toBe(false);
  });
});

describe("the replies", () => {
  it("a service account has its id, name, address, creation, creator or null, and token count", () => {
    expect(ServiceAccountSchema.safeParse(account).success).toBe(true);
    expect(ServiceAccountSchema.safeParse({ ...account, createdBy: null }).success).toBe(true);
    expect(ServiceAccountSchema.safeParse({ ...account, tokenCount: 0 }).success).toBe(true);
    expect(ServiceAccountSchema.safeParse({ ...account, tokenCount: -1 }).success).toBe(false);
    expect(ServiceAccountSchema.safeParse({ ...account, tokenCount: 1.5 }).success).toBe(false);
    expect(ServiceAccountSchema.safeParse({ ...account, id: "ci" }).success).toBe(false);
    expect(ServiceAccountSchema.safeParse({ ...account, createdAt: "today" }).success).toBe(false);
    expect(ServiceAccountSchema.safeParse({ ...account, createdBy: { userId: "x", email: "sam@acme.example" } }).success).toBe(
      false,
    );
    const { createdBy: _omitted, ...withoutCreator } = account;
    expect(ServiceAccountSchema.safeParse(withoutCreator).success).toBe(false);
    expect(ServiceAccountResponseSchema.safeParse({ serviceAccount: account }).success).toBe(true);
  });

  it("the list holds at most 100 accounts", () => {
    expect(SERVICE_ACCOUNTS_MAXIMUM).toBe(100);
    expect(API_TOKENS_LIVE_MAXIMUM).toBe(20);
    const items = (count: number) => Array.from({ length: count }, () => account);
    expect(ServiceAccountsResponseSchema.safeParse({ items: [] }).success).toBe(true);
    expect(ServiceAccountsResponseSchema.safeParse({ items: items(100) }).success).toBe(true);
    expect(ServiceAccountsResponseSchema.safeParse({ items: items(101) }).success).toBe(false);
  });

  it("/whoami answers the organization, the token's name, its access and service_account", () => {
    expect(WhoAmIResponseSchema.parse(whoAmI)).toEqual(whoAmI);
    expect(WhoAmIResponseSchema.safeParse({ ...whoAmI, access: "read" }).success).toBe(true);
    for (const kind of ["user", "human", "service", ""]) {
      expect(WhoAmIResponseSchema.safeParse({ ...whoAmI, kind }).success, kind).toBe(false);
    }
    expect(WhoAmIResponseSchema.safeParse({ ...whoAmI, access: "admin" }).success).toBe(false);
    expect(WhoAmIResponseSchema.safeParse({ ...whoAmI, organizationId: "acme" }).success).toBe(false);
    // snake_case fields aren't taken.
    expect(WhoAmIResponseSchema.safeParse({ ...whoAmI, claims: { access: "write" } }).success).toBe(false);
    expect(WhoAmIResponseSchema.safeParse({ ...whoAmI, granted: ["read"] }).success).toBe(false);
    // A service account's always names its organization.
    expect(WhoAmIResponseSchema.safeParse({ ...whoAmI, organizationId: null }).success).toBe(false);
  });

  it("/whoami for a personal token: kind person, the organization X-Telflo-Org named or null", () => {
    const person = { ...whoAmI, kind: "person" as const };
    expect(WhoAmIResponseSchema.parse(person)).toEqual(person);
    expect(WhoAmIResponseSchema.parse({ ...person, organizationId: null })).toEqual({ ...person, organizationId: null });
    expect(WhoAmIResponseSchema.safeParse({ ...person, organizationId: "acme" }).success).toBe(false);
    expect(WhoAmIResponseSchema.safeParse({ ...person, access: "admin" }).success).toBe(false);
    const { organizationId: _organizationId, ...withoutOrganization } = person;
    expect(WhoAmIResponseSchema.safeParse(withoutOrganization).success).toBe(false);
    expect(WhoAmIResponseSchema.safeParse({ ...person, extra: true }).success).toBe(false);
  });
});

describe("strictness", () => {
  it("every object is strict", () => {
    const objects: [string, z.AnyZodObject][] = [];
    for (const [name, value] of Object.entries(serviceAccounts) as [string, unknown][]) {
      if (value instanceof z.ZodObject) objects.push([name, value]);
    }
    expect(objects.map(([name]) => name).sort()).toEqual([
      "ApiTokenSchema",
      "ApiTokensResponseSchema",
      "CreateApiTokenRequestSchema",
      "CreateServiceAccountRequestSchema",
      "CreatedApiTokenResponseSchema",
      "RenameServiceAccountRequestSchema",
      "ServiceAccountCreatorSchema",
      "ServiceAccountResponseSchema",
      "ServiceAccountSchema",
      "ServiceAccountsResponseSchema",
    ]);
    for (const [name, schema] of objects) expect(schema._def.unknownKeys, name).toBe("strict");
    // /whoami's is a union on kind: each of its objects strict.
    expect(WhoAmIResponseSchema.options.map((option) => option._def.unknownKeys)).toEqual(["strict", "strict"]);

    // And an extra key is refused, at every level.
    const extra = { extra: true };
    expect(ServiceAccountSchema.safeParse({ ...account, ...extra }).success).toBe(false);
    expect(ServiceAccountSchema.safeParse({ ...account, createdBy: { ...creator, ...extra } }).success).toBe(false);
    expect(ServiceAccountsResponseSchema.safeParse({ items: [], ...extra }).success).toBe(false);
    expect(ServiceAccountResponseSchema.safeParse({ serviceAccount: account, ...extra }).success).toBe(false);
    expect(CreateServiceAccountRequestSchema.safeParse({ name: "ci", ...extra }).success).toBe(false);
    expect(RenameServiceAccountRequestSchema.safeParse({ name: "ci", ...extra }).success).toBe(false);
    expect(ApiTokenSchema.safeParse({ ...apiToken, ...extra }).success).toBe(false);
    expect(ApiTokensResponseSchema.safeParse({ items: [], ...extra }).success).toBe(false);
    expect(CreateApiTokenRequestSchema.safeParse({ ...createToken, ...extra }).success).toBe(false);
    expect(CreatedApiTokenResponseSchema.safeParse({ apiToken, token: TOKEN, ...extra }).success).toBe(false);
    expect(CreatedApiTokenResponseSchema.safeParse({ apiToken: { ...apiToken, ...extra }, token: TOKEN }).success).toBe(false);
    expect(WhoAmIResponseSchema.safeParse({ ...whoAmI, ...extra }).success).toBe(false);
  });
});

describe("SERVICE_ACCOUNT_ERROR_CODES", () => {
  it("the error codes and messages are fixed, word for word", () => {
    expect(SERVICE_ACCOUNT_ERROR_CODES).toEqual([
      "service_account_not_found",
      "service_account_name_taken",
      "service_account_limit_reached",
      "api_token_not_found",
      "api_token_name_taken",
      "api_token_limit_reached",
      "invalid_api_token",
    ]);
    expect(SERVICE_ACCOUNT_ERROR_MESSAGES).toEqual({
      service_account_not_found: "Service account not found.",
      service_account_name_taken: "A service account with this name already exists.",
      service_account_limit_reached: "This organization has 100 service accounts. Delete one first.",
      api_token_not_found: "Token not found",
      api_token_name_taken: "This service account already has a token with this name.",
      api_token_limit_reached: "This service account has 20 tokens. Revoke one first.",
      invalid_api_token: "Missing or invalid API token",
    });
    expect(serviceAccounts.SERVICE_ACCOUNT_NOT_FOUND_MESSAGE).toBe(SERVICE_ACCOUNT_ERROR_MESSAGES.service_account_not_found);
    expect(serviceAccounts.SERVICE_ACCOUNT_NAME_TAKEN_MESSAGE).toBe(SERVICE_ACCOUNT_ERROR_MESSAGES.service_account_name_taken);
    expect(serviceAccounts.SERVICE_ACCOUNT_LIMIT_REACHED_MESSAGE).toBe(
      SERVICE_ACCOUNT_ERROR_MESSAGES.service_account_limit_reached,
    );
    expect(serviceAccounts.API_TOKEN_NOT_FOUND_MESSAGE).toBe(SERVICE_ACCOUNT_ERROR_MESSAGES.api_token_not_found);
    expect(serviceAccounts.API_TOKEN_NAME_TAKEN_MESSAGE).toBe(SERVICE_ACCOUNT_ERROR_MESSAGES.api_token_name_taken);
    expect(serviceAccounts.API_TOKEN_LIMIT_REACHED_MESSAGE).toBe(SERVICE_ACCOUNT_ERROR_MESSAGES.api_token_limit_reached);
    expect(serviceAccounts.INVALID_API_TOKEN_MESSAGE).toBe(SERVICE_ACCOUNT_ERROR_MESSAGES.invalid_api_token);

    expectTypeOf<"api_token_not_found">().toMatchTypeOf<ServiceAccountErrorCode>();
    expectTypeOf<"api_token_not_fund">().not.toMatchTypeOf<ServiceAccountErrorCode>();
  });

  it("the codes clash with no other module's codes", () => {
    const others = new Set<string>([
      ...ACCOUNT_ERROR_CODES,
      ...CONFIGURATION_ERROR_CODES,
      ...FLEET_ERROR_CODES,
      ...TESTING_ERROR_CODES,
      ...IDENTITY_ERROR_CODES,
      ...ORGANIZATION_ERROR_CODES,
      ...FLOW_ERROR_CODES,
      ...VALIDATION_RULES_ERROR_CODES,
      ...TEST_REGEX_ERROR_CODES,
      ...SESSION_ERROR_CODES,
      ...OIDC_QUERY_ERROR_CODES,
      ...OIDC_LINK_RESULT_CODES,
      ...SALES_INQUIRY_ERROR_CODES,
      ...QUICK_DEPLOY_LINK_ERROR_CODES,
      ...VARIABLE_ERROR_CODES,
    ]);
    for (const code of SERVICE_ACCOUNT_ERROR_CODES) expect(others.has(code), code).toBe(false);
    // Reused, not redeclared: a contributor's 403, another organization's
    // 404, a blocked address's 429, and the reserved domain's 422.
    expect(ORGANIZATION_ERROR_CODES).toContain("organization_admin_required");
    expect(ORGANIZATION_ERROR_CODES).toContain("organization_not_found");
    expect(SESSION_ERROR_CODES).toContain("rate_limited");
    expect(IDENTITY_ERROR_CODES).toContain("email_reserved");
  });
});
