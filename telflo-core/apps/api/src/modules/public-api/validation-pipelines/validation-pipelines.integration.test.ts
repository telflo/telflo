import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database } from "@telflo/db";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addServiceAccount,
  addValidationPipeline,
  addValidationRule,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { TEST_RATE_LIMITS, type RateLimits } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import type { OttlEvaluatorClient } from "../../../ottl-evaluator/client.js";
import { buildServer } from "../../../server.js";
import { loadSettings, type AppSettings } from "../../../settings.js";
import { fakeOttlEvaluatorMarker } from "../../../testing/fake-ottl-evaluator.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../../testing/otelcol-validator.js";
import { useFakeOttlEvaluator } from "../../../testing/ottl-evaluator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";
import { hashPassword } from "../../identity/password.js";
import { apiTokenHash } from "../../service-accounts/tokens.js";

/*
 * The public surface's validation pipelines, through the real server as the
 * API's own role, with the OTTL evaluator's OpenAPI-checked fake checking
 * the rules. Each route: success through a real service account's token, a
 * read token on the PUT 403, another organization's ids 404, another
 * person's draft version 404 (a version's pipelines follow its
 * configuration's visibility), and every reply checked against the OpenAPI
 * document. Then the PUT's own: a person's rules kept and only the API's
 * replaced (twice in a row), a missing pipeline created, the 200 cap, a `/`
 * in the name raw and percent-encoded, a name the text lacks 422, a signal
 * mismatch 400, the checks counted in validationRuleChecksPerUser, a
 * published version allowed, and a version's copy keeping the API's mark.
 *
 * Tokens are built at run time by addApiToken and never printed: `call`
 * runs its canary (a boolean) on every reply before any comparison of it.
 */

const opamp = useFakeOpampServer();
const evaluator = useFakeOttlEvaluator();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

const P = "/api/public/v1";
const ROUTE = {
  list: `${P}/configurations/:configurationId/versions/:versionNumber/validation-pipelines`,
  put: `${P}/configurations/:configurationId/versions/:versionNumber/validation-pipelines/*`,
  versions: `${P}/configurations/:configurationId/versions`,
} as const;

type Route = (typeof ROUTE)[keyof typeof ROUTE];

/** A configuration's text with three pipelines, one holding two `/`. */
const YAML = [
  "receivers:",
  "  otlp:",
  "exporters:",
  "  debug:",
  "service:",
  "  pipelines:",
  "    logs:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "    traces/otlp:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "    metrics/a/b:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

/** Markers no log line may hold: a rule's name, description, pattern and condition. */
const NAME_MARKER = "public-rule-name-marker-41c2";
const DESCRIPTION_MARKER = "public-rule-description-marker-9d0e";
const PATTERN_MARKER = "public-rule-pattern-marker-6b3a";
const CONDITION_MARKER = "public-rule-condition-marker-0f7c";

const TEXT_RULE = { kind: "contains_text", target: "stderr", pattern: "error" };
const REGEX_RULE = { kind: "not_contains_regex", target: "output", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b" };
const LOG_RULE = { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "all", condition: 'attributes["env"] == "prod"' } };
const SPAN_RULE = { kind: "ottl", target: "output", ottl: { context: "span", quantifier: "any", condition: "true" } };

interface RuleBody {
  id: string;
  validationPipelineId: string;
  position: number;
  kind: string;
  target: string;
  pattern: string | null;
  ottl: unknown;
  name: string;
  description: string;
  createdByUserId: string | null;
  isApiOwned: boolean;
}

interface PipelineBody {
  id: string;
  configurationId: string;
  versionId: string;
  versionNumber: number;
  pipeline: string;
  signal: string;
  createdByUserId: string | null;
  rules: RuleBody[];
}

interface ReplacedBody extends PipelineBody {
  created: boolean;
  rulesReplaced: number;
  rulesKept: number;
}

interface CallOptions {
  configurationId?: string;
  versionNumber?: string | number;
  /** The path after `/validation-pipelines/`, as sent (raw: a test chooses its encoding). */
  pipelinePath?: string;
  payload?: unknown;
}

describe("the public validation pipelines routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  const servers: FastifyInstance[] = [];
  let logLines: string[] = [];
  let passwordHash: string;

  async function serverWith(
    rateLimits: RateLimits = TEST_RATE_LIMITS,
    ottlEvaluator: OttlEvaluatorClient = evaluator.client,
  ): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: { ...UNCALLED_TESTING, ottlEvaluator },
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    servers.push(built);
    await built.ready();
    return built;
  }

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = await serverWith();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
    evaluator.fake.takeRequests();
  });

  afterEach(() => {
    // The platform sent the fake nothing the evaluator's contract refuses.
    expect(evaluator.fake.takeViolations()).toEqual([]);
  });

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** An admin person of a new group organization, and its service account with a read and a write token. */
  const organization = async () => {
    const at = new Date(Date.now() - 60_000);
    const admin = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { organization: group } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const { user: account } = await addServiceAccount(ownerDb, { organizationId: group.id, createdAt: at });
    const tokenOf = async (access: "read" | "write") =>
      (await addApiToken(ownerDb, { organizationId: group.id, serviceAccountUserId: account.id, created_at: at, access })).token;
    return {
      id: group.id,
      adminId: admin.user.id,
      adminEmail: admin.user.email,
      accountUserId: account.id,
      read: await tokenOf("read"),
      write: await tokenOf("write"),
    };
  };

  /** The value of a cookie the response set. */
  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  /** The organization's admin signed in to the web app, active in the organization: their session's access cookie. */
  const signedInAdmin = async (org: { id: string; adminEmail: string }) => {
    const signedIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: org.adminEmail, password: PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: cookieValue(signedIn, "telflo_access") },
      payload: { organizationId: org.id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
    return switched.headers["set-cookie"] === undefined ? cookieValue(signedIn, "telflo_access") : cookieValue(switched, "telflo_access");
  };

  /** A request of the web app's Validation tab, as the signed-in person. */
  const browser = (access: string, method: "POST" | "PATCH", url: string, payload: unknown) =>
    server.inject({ method, url, headers: csrfHeaders, cookies: { telflo_access: access }, payload: payload as Record<string, unknown> });

  /** A configuration made by `createdBy` with one version (number 1) holding `yaml`, published or a draft. */
  const configurationOf = async (organizationId: string, createdBy: string, options: { published?: boolean; yaml?: string } = {}) => {
    const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: createdBy });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      version_number: 1,
      yaml_content: options.yaml ?? YAML,
      created_by_user_id: createdBy,
      ...(options.published === true && { publishedAt: new Date(), publishedByUserId: createdBy }),
    });
    return { organizationId, configurationId: configuration.id, versionId: version.id };
  };

  type Target = Awaited<ReturnType<typeof configurationOf>>;

  /** A pipeline on the target's version 1, made by `createdBy`, with `count` of a person's text rules (positions 1 up). */
  const personsPipeline = async (target: Target, createdBy: string, pipeline: string, count: number) => {
    const ids = {
      organizationId: target.organizationId,
      configurationId: target.configurationId,
      configurationVersionId: target.versionId,
    };
    const row = await addValidationPipeline(ownerDb, {
      ...ids,
      pipeline_name: pipeline,
      signal: pipeline.split("/")[0] as "logs",
      created_by_user_id: createdBy,
    });
    if (count > 0) {
      const at = new Date();
      await ownerDb
        .insertInto("validation_rules")
        .values(
          Array.from({ length: count }, (_, index) => ({
            organization_id: ids.organizationId,
            configuration_id: ids.configurationId,
            configuration_version_id: ids.configurationVersionId,
            validation_pipeline_id: row.id,
            position: index + 1,
            kind: "contains_text" as const,
            target: "output" as const,
            pattern: `person-${index + 1}`,
            created_by_user_id: createdBy,
            created_at: at,
            updated_at: at,
          })),
        )
        .execute();
    }
    return row;
  };

  /**
   * A request to `route` with `token`; the reply's canary first, then the
   * reply checked against the OpenAPI document (its errors name no value).
   */
  const call = async (method: string, route: Route, token: string, options: CallOptions = {}) => {
    const url = route
      .replace(":configurationId", encodeURIComponent(options.configurationId ?? ""))
      .replace(":versionNumber", String(options.versionNumber ?? 1))
      .replace("*", options.pipelinePath ?? "");
    const response = await server.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    });
    expect(holdsToken(response.body, token)).toBe(false);
    const body: unknown = response.body === "" ? undefined : response.json();
    expect(validatePublicReply(method, route, response.statusCode, body).errors).toEqual([]);
    return response;
  };

  /** A PUT of `rules` on the target's version 1's `pipelinePath`, with the path's signal unless given. */
  const put = (token: string, target: Target, pipelinePath: string, rules: unknown[], signal?: string) =>
    call("PUT", ROUTE.put, token, {
      configurationId: target.configurationId,
      pipelinePath,
      payload: { signal: signal ?? decodeURIComponent(pipelinePath).split("/")[0], rules },
    });

  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
  };

  /** The rules on the target's version, as the owner reads them: pipeline name, position, owner, pattern or condition. */
  const storedRules = async (target: Target) =>
    (
      await ownerDb
        .selectFrom("validation_rules")
        .innerJoin("validation_pipelines", "validation_pipelines.id", "validation_rules.validation_pipeline_id")
        .select([
          "validation_pipelines.pipeline_name as pipeline",
          "validation_rules.position",
          "validation_rules.is_api_owned as isApiOwned",
          "validation_rules.pattern",
        ])
        .where("validation_rules.configuration_version_id", "=", target.versionId)
        .orderBy("validation_pipelines.pipeline_name")
        .orderBy("validation_rules.position")
        .execute()
    ).map((row) => ({ ...row }));

  const validateRequests = () => evaluator.fake.takeRequests().filter((request) => request.operation === "validate");

  describe("GET …/validation-pipelines", () => {
    it("lists the version's pipelines with their rules in the platform's shape and isApiOwned; one page", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const empty = await call("GET", ROUTE.list, org.read, { configurationId: target.configurationId });
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ items: [], nextCursor: null });

      const logs = await personsPipeline(target, org.accountUserId, "logs", 2);
      const traces = await personsPipeline(target, org.accountUserId, "traces/otlp", 0);
      const owned = await addValidationRule(ownerDb, {
        organizationId: org.id,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        validationPipelineId: traces.id,
        kind: "ottl",
        pattern: null,
        ottl_context: "span",
        ottl_quantifier: "any",
        ottl_condition: "true",
        name: "named",
        created_by_user_id: org.accountUserId,
        is_api_owned: true,
      });

      const response = await call("GET", ROUTE.list, org.read, { configurationId: target.configurationId });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const page = response.json<{ items: PipelineBody[]; nextCursor: null }>();
      expect(page.nextCursor).toBeNull();
      expect(page.items.map((item) => [item.pipeline, item.signal, item.versionNumber, item.rules.length])).toEqual([
        ["logs", "logs", 1, 2],
        ["traces/otlp", "traces", 1, 1],
      ]);
      expect(page.items[0]).toMatchObject({
        id: logs.id,
        configurationId: target.configurationId,
        versionId: target.versionId,
        createdByUserId: org.accountUserId,
      });
      expect(page.items[0]!.rules.map((rule) => [rule.position, rule.pattern, rule.isApiOwned])).toEqual([
        [1, "person-1", false],
        [2, "person-2", false],
      ]);
      expect(page.items[1]!.rules).toEqual([
        expect.objectContaining({
          id: owned.id,
          validationPipelineId: traces.id,
          position: 1,
          kind: "ottl",
          target: "output",
          pattern: null,
          ottl: { context: "span", quantifier: "any", condition: "true" },
          name: "named",
          description: "",
          isApiOwned: true,
        }),
      ]);
    });

    it("answers another organization's version, another person's draft, a malformed id and an unknown number 404; a bad number 400", async () => {
      const org = await organization();
      const other = await organization();
      const elsewhere = await configurationOf(other.id, other.accountUserId, { published: true });
      await personsPipeline(elsewhere, other.accountUserId, "logs", 1);
      const othersDraft = await configurationOf(org.id, org.adminId);
      await personsPipeline(othersDraft, org.adminId, "logs", 1);
      for (const configurationId of [elsewhere.configurationId, othersDraft.configurationId, "not-a-uuid", randomUUID()]) {
        expectRefusal(await call("GET", ROUTE.list, org.read, { configurationId }), 404, "configuration_not_found");
      }
      const own = await configurationOf(org.id, org.accountUserId);
      expectRefusal(await call("GET", ROUTE.list, org.read, { configurationId: own.configurationId, versionNumber: 2 }), 404, "configuration_version_not_found");
      expectRefusal(await call("GET", ROUTE.list, org.read, { configurationId: own.configurationId, versionNumber: "01" }), 400, "invalid_request");
    });

    it("shows a published version's pipelines to the organization's token, whoever made them", async () => {
      const org = await organization();
      const published = await configurationOf(org.id, org.adminId, { published: true });
      await personsPipeline(published, org.adminId, "logs", 1);
      const response = await call("GET", ROUTE.list, org.read, { configurationId: published.configurationId });
      expect(response.json<{ items: PipelineBody[] }>().items.map((item) => item.pipeline)).toEqual(["logs"]);
    });
  });

  describe("PUT …/validation-pipelines/{pipeline}", () => {
    it("creates a missing pipeline with the API's rules, checking each regex and OTTL rule; a read token is 403 and writes nothing", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const rules = [
        { ...TEXT_RULE, name: ` ${NAME_MARKER} `, description: DESCRIPTION_MARKER },
        { ...REGEX_RULE, pattern: `${PATTERN_MARKER}\\d+` },
        { ...LOG_RULE, ottl: { ...LOG_RULE.ottl, condition: `body == "${CONDITION_MARKER}"` } },
      ];
      expectRefusal(await put(org.read, target, "logs", rules), 403, "insufficient_access");
      expect(await storedRules(target)).toEqual([]);
      expect(validateRequests()).toEqual([]);

      const response = await put(org.write, target, "logs", rules);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const replaced = response.json<ReplacedBody>();
      expect(replaced).toMatchObject({
        configurationId: target.configurationId,
        versionId: target.versionId,
        versionNumber: 1,
        pipeline: "logs",
        signal: "logs",
        createdByUserId: org.accountUserId,
        created: true,
        rulesReplaced: 0,
        rulesKept: 0,
      });
      expect(replaced.rules.map((rule) => [rule.position, rule.kind, rule.isApiOwned, rule.createdByUserId])).toEqual([
        [1, "contains_text", true, org.accountUserId],
        [2, "not_contains_regex", true, org.accountUserId],
        [3, "ottl", true, org.accountUserId],
      ]);
      expect(replaced.rules[0]).toMatchObject({ name: NAME_MARKER, description: DESCRIPTION_MARKER, target: "stderr" });
      // The text rule needs no check; the regex and the OTTL rule one each.
      expect(validateRequests()).toHaveLength(2);
      // Rules' text is configuration text: in no log line.
      const logged = logLines.join("\n");
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, PATTERN_MARKER, CONDITION_MARKER]) {
        expect(logged.includes(marker)).toBe(false);
      }
      // The audit rows hold ids and counts only.
      const audits = await ownerDb
        .selectFrom("audit_events")
        .select(["action", "subject_type", "subject_id", "metadata"])
        .where("organization_id", "=", org.id)
        .orderBy("id")
        .execute();
      expect(audits.map((row) => row.action)).toEqual(["validation_pipeline.created", "validation_pipeline.rules_replaced"]);
      expect(audits[1]).toEqual({
        action: "validation_pipeline.rules_replaced",
        subject_type: "validation_pipeline",
        subject_id: replaced.id,
        metadata: {
          configurationId: target.configurationId,
          versionId: target.versionId,
          rulesReplaced: 0,
          rulesAdded: 3,
          rulesKept: 0,
          deletedRuleIds: [],
          addedRuleIds: replaced.rules.map((rule) => rule.id),
        },
      });
      // A second PUT names the rules it deleted and the ones it added: ids only.
      const again = (await put(org.write, target, "logs", [TEXT_RULE])).json<ReplacedBody>();
      const second = await ownerDb
        .selectFrom("audit_events")
        .select(["metadata"])
        .where("organization_id", "=", org.id)
        .where("action", "=", "validation_pipeline.rules_replaced")
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow();
      expect(second.metadata).toMatchObject({
        rulesReplaced: 3,
        rulesAdded: 1,
        deletedRuleIds: replaced.rules.map((rule) => rule.id),
        addedRuleIds: [again.rules[0]!.id],
      });
    });

    it("keeps a person's rules and replaces only the API's, twice in a row, appending after the kept ones", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.adminId, { published: true });
      const pipeline = await personsPipeline(target, org.adminId, "logs", 2);

      const first = await put(org.write, target, "logs", [TEXT_RULE, REGEX_RULE]);
      expect(first.statusCode).toBe(200);
      expect(first.json<ReplacedBody>()).toMatchObject({ id: pipeline.id, created: false, rulesReplaced: 0, rulesKept: 2 });
      // A person adds one after the API's.
      await addValidationRule(ownerDb, {
        organizationId: org.id,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        validationPipelineId: pipeline.id,
        position: 5,
        pattern: "person-5",
        created_by_user_id: org.adminId,
      });

      const second = await put(org.write, target, "logs", [{ ...TEXT_RULE, pattern: "second-a" }, { ...TEXT_RULE, pattern: "second-b" }, { ...TEXT_RULE, pattern: "second-c" }]);
      expect(second.statusCode).toBe(200);
      const body = second.json<ReplacedBody>();
      expect(body).toMatchObject({ id: pipeline.id, created: false, rulesReplaced: 2, rulesKept: 3 });
      expect(body.rules.map((rule) => [rule.position, rule.pattern, rule.isApiOwned])).toEqual([
        [1, "person-1", false],
        [2, "person-2", false],
        [5, "person-5", false],
        [6, "second-a", true],
        [7, "second-b", true],
        [8, "second-c", true],
      ]);

      const third = await put(org.write, target, "logs", [{ ...TEXT_RULE, pattern: "third" }]);
      expect(third.json<ReplacedBody>()).toMatchObject({ rulesReplaced: 3, rulesKept: 3 });
      expect(await storedRules(target)).toEqual([
        { pipeline: "logs", position: 1, isApiOwned: false, pattern: "person-1" },
        { pipeline: "logs", position: 2, isApiOwned: false, pattern: "person-2" },
        { pipeline: "logs", position: 5, isApiOwned: false, pattern: "person-5" },
        { pipeline: "logs", position: 6, isApiOwned: true, pattern: "third" },
      ]);
    });

    it("keeps a rule a person saved in the web app's Validation tab through two PUTs, isApiOwned false", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.adminId, { published: true });
      const access = await signedInAdmin(org);
      const pipelinesUrl = `/api/v1/organizations/${org.id}/configurations/${target.configurationId}/versions/${target.versionId}/validation-pipelines`;
      const createdPipeline = await browser(access, "POST", pipelinesUrl, { pipeline: "logs" });
      expect(createdPipeline.statusCode).toBe(201);
      const pipelineId = createdPipeline.json<{ validationPipeline: { id: string } }>().validationPipeline.id;
      const createdRule = await browser(access, "POST", `${pipelinesUrl}/${pipelineId}/rules`, { ...REGEX_RULE, name: "the person's" });
      expect(createdRule.statusCode).toBe(201);
      const personsRuleId = createdRule.json<{ rule: { id: string } }>().rule.id;

      for (const [rules, replacedCount] of [[[TEXT_RULE, LOG_RULE], 0], [[TEXT_RULE], 2]] as const) {
        const response = await put(org.write, target, "logs", [...rules]);
        expect(response.statusCode).toBe(200);
        const body = response.json<ReplacedBody>();
        expect(body).toMatchObject({ id: pipelineId, created: false, rulesReplaced: replacedCount, rulesKept: 1 });
        expect(body.rules[0]).toMatchObject({ id: personsRuleId, position: 1, name: "the person's", isApiOwned: false, createdByUserId: org.adminId });
      }
      const listed = await call("GET", ROUTE.list, org.read, { configurationId: target.configurationId });
      expect(listed.json<{ items: PipelineBody[] }>().items[0]!.rules.map((rule) => [rule.id === personsRuleId, rule.isApiOwned])).toEqual([
        [true, false],
        [false, true],
      ]);
    });

    it("takes a / in the name raw or percent-encoded, decoded once: both are the same pipeline; %252F stays a literal %2F", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const raw = await put(org.write, target, "traces/otlp", [SPAN_RULE]);
      expect(raw.statusCode).toBe(200);
      expect(raw.json<ReplacedBody>()).toMatchObject({ pipeline: "traces/otlp", signal: "traces", created: true });
      const encoded = await put(org.write, target, "traces%2Fotlp", [SPAN_RULE, SPAN_RULE]);
      expect(encoded.statusCode).toBe(200);
      expect(encoded.json<ReplacedBody>()).toMatchObject({ id: raw.json<ReplacedBody>().id, created: false, rulesReplaced: 1 });
      const deeper = await put(org.write, target, "metrics%2Fa/b", [{ ...TEXT_RULE }]);
      expect(deeper.json<ReplacedBody>()).toMatchObject({ pipeline: "metrics/a/b", created: true });
      // Decoded once: `traces%2Fotlp` is one part, not a signal (400); `traces/otlp%2Fx` is no key (422).
      expectRefusal(await put(org.write, target, "traces%252Fotlp", [SPAN_RULE], "traces"), 400, "invalid_request");
      expectRefusal(await put(org.write, target, "traces/otlp%252Fx", [SPAN_RULE]), 422, "configuration_invalid");
      expect((await storedRules(target)).map((rule) => rule.pipeline)).toEqual(["metrics/a/b", "traces/otlp", "traces/otlp"]);
    });

    it("answers a name that isn't a key of service.pipelines 422 in fixed words, a version whose text doesn't parse alike, and writes nothing", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const secretName = `logs/${NAME_MARKER}`;
      for (const name of ["logs/missing", "traces", encodeURIComponent(secretName)]) {
        const refused = await put(org.write, target, name, [TEXT_RULE]);
        expectRefusal(refused, 422, "configuration_invalid");
        expect(refused.json()).toEqual({
          error: {
            code: "configuration_invalid",
            message: "The configuration is not valid.",
            details: { errors: [{ message: "The version's configuration has no pipeline of this name.", componentPath: "service.pipelines" }] },
          },
        });
      }
      const broken = await configurationOf(org.id, org.accountUserId, { yaml: "service: [unclosed\n" });
      expectRefusal(await put(org.write, broken, "logs", [TEXT_RULE]), 422, "configuration_invalid");
      expect(await storedRules(target)).toEqual([]);
      expect(validateRequests()).toEqual([]);
    });

    it("answers a signal that isn't the name's first part 400, before anything is read or checked", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const refused = await put(org.write, target, "traces/otlp", [REGEX_RULE], "logs");
      expectRefusal(refused, 400, "invalid_request");
      expect(refused.json<{ error: { details: unknown } }>().error.details).toEqual([
        { path: ["signal"], message: "The signal must be the pipeline name's first part." },
      ]);
      // Even on a version the token can't see: the request contradicts itself.
      expectRefusal(await put(org.write, { ...target, configurationId: randomUUID() }, "logs", [TEXT_RULE], "traces"), 400, "invalid_request");
      expect(await storedRules(target)).toEqual([]);
      expect(validateRequests()).toEqual([]);
    });

    it("answers an empty name or one over 200 characters 400, and a body that isn't one 400", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      expectRefusal(await put(org.write, target, "", [TEXT_RULE], "logs"), 400, "invalid_request");
      expectRefusal(await put(org.write, target, `logs/${"a".repeat(196)}`, [TEXT_RULE]), 400, "invalid_request");
      expectRefusal(await call("PUT", ROUTE.put, org.write, { configurationId: target.configurationId, pipelinePath: "logs", payload: { signal: "logs", rules: [] } }), 400, "invalid_request");
      expectRefusal(
        await call("PUT", ROUTE.put, org.write, { configurationId: target.configurationId, pipelinePath: "logs", payload: { signal: "logs", rules: Array.from({ length: 21 }, () => TEXT_RULE) } }),
        400,
        "invalid_request",
      );
      expectRefusal(
        await call("PUT", ROUTE.put, org.write, { configurationId: target.configurationId, pipelinePath: "logs", payload: { signal: "logs", rules: [TEXT_RULE], name: "dropped" } }),
        400,
        "invalid_request",
      );
      expectRefusal(await put(org.write, target, "logs", [{ kind: "ottl", target: "stderr", ottl: LOG_RULE.ottl }]), 400, "invalid_request");
      expectRefusal(
        await call("PUT", ROUTE.put, org.write, { configurationId: target.configurationId, pipelinePath: "logs", payload: { signal: "logs", rules: [{ ...TEXT_RULE, pattern: "x".repeat(1024 * 1024) }] } }),
        413,
        "payload_too_large",
      );
      // 200 characters is the bound: a 200-character name the text lacks is the 422, not the 400.
      expectRefusal(await put(org.write, target, `logs/${"a".repeat(195)}`, [TEXT_RULE]), 422, "configuration_invalid");
      expect(await storedRules(target)).toEqual([]);
    });

    it("answers another organization's version, another person's draft version and a malformed id 404, writing nothing", async () => {
      const org = await organization();
      const other = await organization();
      const elsewhere = await configurationOf(other.id, other.accountUserId, { published: true });
      const othersDraft = await configurationOf(org.id, org.adminId);
      for (const target of [elsewhere, othersDraft, { ...othersDraft, configurationId: "not-a-uuid" }]) {
        expectRefusal(await put(org.write, target, "logs", [REGEX_RULE]), 404, "configuration_not_found");
        expect(await storedRules(target)).toEqual([]);
      }
      const own = await configurationOf(org.id, org.accountUserId);
      expectRefusal(
        await call("PUT", ROUTE.put, org.write, { configurationId: own.configurationId, versionNumber: 2, pipelinePath: "logs", payload: { signal: "logs", rules: [TEXT_RULE] } }),
        404,
        "configuration_version_not_found",
      );
      expect(validateRequests()).toEqual([]);
    });

    it("is allowed on a published version", async () => {
      const org = await organization();
      const published = await configurationOf(org.id, org.accountUserId, { published: true });
      const response = await put(org.write, published, "logs", [LOG_RULE]);
      expect(response.statusCode).toBe(200);
      expect(response.json<ReplacedBody>()).toMatchObject({ created: true, rulesKept: 0 });
    });

    it("keeps a pipeline within 200 rules, kept and new together: 409 before any check, and nothing changes", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.adminId, { published: true });
      const pipeline = await personsPipeline(target, org.adminId, "logs", 190);
      // Ten of them the API's, from an earlier PUT: 180 kept.
      await ownerDb
        .updateTable("validation_rules")
        .set({ is_api_owned: true })
        .where("validation_pipeline_id", "=", pipeline.id)
        .where("position", ">", 180)
        .execute();

      // 180 kept + 20 new is 200, the cap: it fits.
      const atCap = await put(org.write, target, "logs", Array.from({ length: 20 }, (_, index) => ({ ...TEXT_RULE, pattern: `api-${index}` })));
      expect(atCap.statusCode).toBe(200);
      expect(atCap.json<ReplacedBody>()).toMatchObject({ rulesReplaced: 10, rulesKept: 180 });
      expect(atCap.json<ReplacedBody>().rules).toHaveLength(200);

      // One of the API's made a person's: 181 kept + 20 new is 201, refused before any check, nothing changed.
      await ownerDb
        .updateTable("validation_rules")
        .set({ is_api_owned: false })
        .where("validation_pipeline_id", "=", pipeline.id)
        .where("pattern", "=", "api-0")
        .execute();
      const full = await storedRules(target);
      const refused = await put(org.write, target, "logs", Array.from({ length: 20 }, () => REGEX_RULE));
      expectRefusal(refused, 409, "validation_rule_limit_reached");
      expect(validateRequests()).toEqual([]);
      expect(await storedRules(target)).toEqual(full);
      // 19 new fit.
      const fits = await put(org.write, target, "logs", Array.from({ length: 19 }, () => TEXT_RULE));
      expect(fits.json<ReplacedBody>()).toMatchObject({ rulesReplaced: 19, rulesKept: 181 });
    });

    it("refuses an OTTL context the signal doesn't have 400, naming the rule's place, before any check", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const refused = await put(org.write, target, "logs", [REGEX_RULE, SPAN_RULE]);
      expectRefusal(refused, 400, "invalid_request");
      expect(refused.json<{ error: { details: unknown } }>().error.details).toEqual([
        { path: ["rules", 1, "ottl", "context"], message: "The pipeline's signal doesn't have this OTTL context." },
      ]);
      expect(validateRequests()).toEqual([]);
      expect(await storedRules(target)).toEqual([]);
    });

    it("refuses a condition that can't fail (true with all) 400 validation_rule_invalid, naming the rule's place, before any check", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const alwaysTrue = { ...LOG_RULE, ottl: { context: "log", quantifier: "all", condition: "true" } };
      const refused = await put(org.write, target, "logs", [REGEX_RULE, alwaysTrue]);
      expectRefusal(refused, 400, "validation_rule_invalid");
      const error = refused.json<{ error: { message: string; details: { ruleIndex: number; problems: Array<{ field: string; message: string }> } } }>().error;
      expect(error.message).toBe("A rule is not valid: see the problems in details.");
      expect(error.details.ruleIndex).toBe(1);
      expect(error.details.problems.map((problem) => problem.field)).toEqual(["ottl.condition"]);
      expect(validateRequests()).toEqual([]);
      expect(await storedRules(target)).toEqual([]);
      // `true` with `count` is the total-count control: allowed.
      const control = { ...LOG_RULE, ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "gte", value: 1 } } };
      expect((await put(org.write, target, "logs", [control])).statusCode).toBe(200);
    });

    it("refuses a rule the evaluator finds broken 400 in fixed words, its place and the problems in details; nothing is written", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const broken = { ...LOG_RULE, ottl: { ...LOG_RULE.ottl, condition: `body == "${fakeOttlEvaluatorMarker("invalid")}"` } };
      const refused = await put(org.write, target, "logs", [REGEX_RULE, broken]);
      expectRefusal(refused, 400, "validation_rule_invalid");
      const error = refused.json<{ error: { message: string; details: { ruleIndex: number; problems: Array<{ field: string; message: string }> } } }>().error;
      expect(error.message).toBe("A rule is not valid: see the problems in details.");
      expect(error.details.ruleIndex).toBe(1);
      expect(error.details.problems.length > 0).toBe(true);
      expect(await storedRules(target)).toEqual([]);
    });

    it("answers 503 rules_unavailable when the evaluator can't check, writing nothing", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      evaluator.fake.nextFault("error_500");
      expectRefusal(await put(org.write, target, "logs", [REGEX_RULE]), 503, "rules_unavailable");
      expect(await storedRules(target)).toEqual([]);
    });

    it("counts each evaluator call in the person's validationRuleChecksPerUser: past it 429, nothing written", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, validationRuleChecksPerUser: { max: 3, windowMs: 60_000 } });
      const previous = server;
      server = limited;
      try {
        const org = await organization();
        const target = await configurationOf(org.id, org.accountUserId);
        // A text rule spends nothing; the regex and the OTTL rule one each: 2 of 3.
        expect((await put(org.write, target, "logs", [TEXT_RULE, REGEX_RULE, LOG_RULE])).statusCode).toBe(200);
        expect(validateRequests()).toHaveLength(2);
        // Two checks with one left: all reserved at once or none, so the evaluator isn't asked and nothing is spent.
        const refused = await put(org.write, target, "logs", [REGEX_RULE, LOG_RULE]);
        expectRefusal(refused, 429, "validation_rule_rate_limited");
        expect(Number(refused.headers["retry-after"]) > 0).toBe(true);
        expect(validateRequests()).toEqual([]);
        // The first PUT's rules are still there: the refused one wrote nothing.
        expect((await storedRules(target)).map((rule) => rule.isApiOwned)).toEqual([true, true, true]);
        // The one left is still there: a PUT with one check passes, and then none is left.
        expect((await put(org.write, target, "logs", [REGEX_RULE])).statusCode).toBe(200);
        expect(validateRequests()).toHaveLength(1);
        expectRefusal(await put(org.write, target, "logs", [LOG_RULE]), 429, "validation_rule_rate_limited");
        // Text rules alone still pass.
        expect((await put(org.write, target, "logs", [TEXT_RULE])).statusCode).toBe(200);
      } finally {
        server = previous;
      }
    });

    it("gives back the checks of the rules not reached when the evaluator refuses one", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, validationRuleChecksPerUser: { max: 3, windowMs: 60_000 } });
      const previous = server;
      server = limited;
      try {
        const org = await organization();
        const target = await configurationOf(org.id, org.accountUserId);
        const broken = { ...REGEX_RULE, pattern: fakeOttlEvaluatorMarker("invalid") };
        // Three reserved; the first is refused, so the two after it are given back: one spent.
        expectRefusal(await put(org.write, target, "logs", [broken, REGEX_RULE, LOG_RULE]), 400, "validation_rule_invalid");
        expect(validateRequests()).toHaveLength(1);
        expect((await put(org.write, target, "logs", [REGEX_RULE, LOG_RULE])).statusCode).toBe(200);
        expectRefusal(await put(org.write, target, "logs", [REGEX_RULE]), 429, "validation_rule_rate_limited");
      } finally {
        server = previous;
      }
    });

    /**
     * A server whose evaluator runs `during` once, on its first validate,
     * before answering: what another request did between the PUT's
     * pre-check and its transaction.
     */
    const serverWithFirstCheck = async (during: () => Promise<void>) => {
      let pending: (() => Promise<void>) | undefined = during;
      const client = evaluator.client;
      const hooked: OttlEvaluatorClient = {
        evaluate: (request, options) => client.evaluate(request, options),
        lint: (request, options) => client.lint(request, options),
        health: (options) => client.health(options),
        validate: async (request, options) => {
          const run = pending;
          pending = undefined;
          await run?.();
          return client.validate(request, options);
        },
      };
      return serverWith(TEST_RATE_LIMITS, hooked);
    };

    it("counts the cap again under the lock: rules a person added since the pre-check make it 409, nothing written", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.adminId, { published: true });
      const pipeline = await personsPipeline(target, org.adminId, "logs", 185);
      // 185 kept + 10 new fits at the pre-check; then a person adds 10 more while the rules are checked.
      const hooked = await serverWithFirstCheck(async () => {
        const at = new Date();
        await ownerDb
          .insertInto("validation_rules")
          .values(
            Array.from({ length: 10 }, (_, index) => ({
              organization_id: org.id,
              configuration_id: target.configurationId,
              configuration_version_id: target.versionId,
              validation_pipeline_id: pipeline.id,
              position: 186 + index,
              kind: "contains_text" as const,
              target: "output" as const,
              pattern: `late-${index}`,
              created_by_user_id: org.adminId,
              created_at: at,
              updated_at: at,
            })),
          )
          .execute();
      });
      const previous = server;
      server = hooked;
      try {
        const refused = await put(org.write, target, "logs", Array.from({ length: 10 }, () => REGEX_RULE));
        expectRefusal(refused, 409, "validation_rule_limit_reached");
        const stored = await storedRules(target);
        expect(stored).toHaveLength(195);
        expect(stored.every((rule) => !rule.isApiOwned)).toBe(true);
        const replacements = await ownerDb
          .selectFrom("audit_events")
          .select("id")
          .where("organization_id", "=", org.id)
          .where("action", "=", "validation_pipeline.rules_replaced")
          .execute();
        expect(replacements).toEqual([]);
      } finally {
        server = previous;
      }
    });

    it("finds a pipeline created since the pre-check under the lock, and adds to it: created false", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.adminId, { published: true });
      let madeId = "";
      const hooked = await serverWithFirstCheck(async () => {
        madeId = (await personsPipeline(target, org.adminId, "logs", 1)).id;
      });
      const previous = server;
      server = hooked;
      try {
        const response = await put(org.write, target, "logs", [REGEX_RULE]);
        expect(response.statusCode).toBe(200);
        expect(response.json<ReplacedBody>()).toMatchObject({ id: madeId, created: false, rulesReplaced: 0, rulesKept: 1 });
        expect((await storedRules(target)).map((rule) => [rule.position, rule.isApiOwned])).toEqual([
          [1, false],
          [2, true],
        ]);
      } finally {
        server = previous;
      }
    });

    it("lets a version appended from it carry the API's mark, so the next PUT there replaces the copies", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      await personsPipeline(target, org.accountUserId, "logs", 1);
      expect((await put(org.write, target, "logs", [TEXT_RULE, TEXT_RULE])).statusCode).toBe(200);
      const appended = await call("POST", ROUTE.versions, org.write, { configurationId: target.configurationId, payload: { yaml: YAML } });
      expect(appended.statusCode).toBe(201);
      const listed = await call("GET", ROUTE.list, org.read, { configurationId: target.configurationId, versionNumber: 2 });
      expect(listed.json<{ items: PipelineBody[] }>().items[0]!.rules.map((rule) => rule.isApiOwned)).toEqual([false, true, true]);
      const replaced = await call("PUT", ROUTE.put, org.write, {
        configurationId: target.configurationId,
        versionNumber: 2,
        pipelinePath: "logs",
        payload: { signal: "logs", rules: [TEXT_RULE] },
      });
      expect(replaced.json<ReplacedBody>()).toMatchObject({ versionNumber: 2, created: false, rulesReplaced: 2, rulesKept: 1 });
    });
  });
});
