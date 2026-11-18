import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { CSRF_HEADER_NAME } from "@telflo/contracts";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Server } from "node:http";
import type { FastifyHttpOptions, FastifyInstance } from "fastify";
import type { ServerDependencies } from "./dependencies.js";
import { registerErrorHandling, respondToFrameworkError } from "./errors.js";
import { createAfterResponseRunner } from "./http/after-response.js";
import { registerCsrfGuard } from "./http/csrf.js";
import { RATE_LIMITS, registerRateLimits } from "./http/rate-limits.js";
import { serializeRequest } from "./http/request-log.js";
import { registerAccountRoutes } from "./modules/account/routes.js";
import { registerCollectorCatalogueRoutes } from "./modules/collector-catalogue/routes.js";
import { registerConfigurationRoutes } from "./modules/configurations/routes.js";
import { registerFleetRoutes } from "./modules/fleets/routes.js";
import { registerFeedbackRoutes } from "./modules/feedback/routes.js";
import { registerFlowRoutes } from "./modules/flows/routes.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerIdentityRoutes } from "./modules/identity/routes.js";
import { registerLibraryFilesRoutes } from "./modules/library-files/routes.js";
import { registerOidcRoutes } from "./modules/oidc/routes.js";
import { registerOrganizationLogoRoutes } from "./modules/organizations/logo-routes.js";
import { createOpampRegistration } from "./modules/organizations/opamp-registration.js";
import { registerOrganizationRoutes } from "./modules/organizations/routes.js";
import { registerPasswordResetRoutes } from "./modules/password-resets/routes.js";
import { registerProductAdminFeedbackRoutes } from "./modules/product-admin/feedback-routes.js";
import { registerProductAdminsRoutes } from "./modules/product-admin/product-admins-routes.js";
import { registerProductAdminSettingsRoutes } from "./modules/product-admin/settings-routes.js";
import { registerProductAdminUsersRoutes } from "./modules/product-admin/users-routes.js";
import { registerPublicRouteGuard, registerPublicRouteVerification } from "./modules/public-api/route-guard.js";
import { registerPublicApiRoutes } from "./modules/public-api/routes.js";
import { registerQuickDeployRoutes } from "./modules/quick-deploy/routes.js";
import { registerSalesInquiryRoutes } from "./modules/sales-inquiries/routes.js";
import { createModuleServices } from "./modules/services.js";
import { registerServiceAccountRoutes } from "./modules/service-accounts/routes.js";
import { registerSessionRoutes } from "./modules/sessions/routes.js";
import { registerTestRunsRoutes } from "./modules/test-runs/routes.js";
import { registerTestSuitesRoutes } from "./modules/test-suites/routes.js";
import { registerTestTemplatesRoutes } from "./modules/test-templates/routes.js";
import { registerTestRegexesRoutes } from "./modules/test-regexes/routes.js";
import { registerValidationPipelinesRoutes } from "./modules/validation-pipelines/routes.js";
import { registerVariableRoutes } from "./modules/variables/routes.js";

/**
 * Wiring only — no business logic. Dependencies are passed in rather than
 * constructed here, so tests substitute an in-memory mailer without
 * intercepting modules.
 */
export function buildServer(deps: ServerDependencies): FastifyInstance {
  const options: FastifyHttpOptions<Server> = {
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // The OIDC callback's query holds the authorization code and state,
      // the configurations list's its search text, and a fleet route's a
      // collector's name or address, and a product-admin route's other
      // people's data (the Users search): the request's log lines leave them
      // out (D2c Preflight minor, D7 Preflight ruling 4, D16b Preflight
      // ruling 16, D29 decision 41).
      serializers: { req: serializeRequest },
      // A Postgres error's DETAIL and WHERE name the values of the row that
      // failed ("Failing row contains (…)", "Key (token_hash)=(…)"): a token's
      // hash, an address. Every logged error loses both, whichever table and
      // whichever log line; its code, constraint and message, which name no
      // values, stay (D6 Preflight ruling 4). Nothing else logs a property
      // of either name.
      redact: { paths: ["err.detail", "err.where"], remove: true },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    // Bodies need a ceiling.
    bodyLimit: 1_048_576,
    // A URL the router can't take (a malformed escape, a parameter over its
    // length): Fastify's own answer quotes the path back, and a
    // quick-deploy link's secret with it (D17c-2 Task 2's open point). Ours
    // answers the envelope's generic words and logs no URL.
    frameworkErrors: respondToFrameworkError,
  };
  // A hop count, never `true` (Ruling 39): `true` would believe any
  // X-Forwarded-For a client sends when nothing sits in front of the API.
  // Left unset at 0, so request.ip is the socket peer.
  //
  // Passed as a function, not a number: Fastify 5.12 treats a numeric
  // trustProxy as "trust nothing" (lib/request.js getTrustProxyFn), so the
  // number would be silently ignored. proxy-addr calls this with the hop
  // index counted from the socket peer (0), so trusting hops 0..n-1 is
  // exactly "n proxies sit in front of the API". That is safe only when the
  // API can't be reached except through those proxies; compose guarantees it
  // by not publishing the API's port.
  const trustedHops = deps.settings.trustProxyHops;
  if (trustedHops > 0) {
    options.trustProxy = (_address: string, hop: number) => hop < trustedHops;
  }
  const server = Fastify(options);
  // First, before any plugin, hook or route (D25 Rulings 163 and 164): no
  // request under /api/public/v1, in any spelling, is answered by a route
  // outside the public plugin's checks (the verification, run before every
  // other hook), and no such route registers (the guard).
  registerPublicRouteVerification(server);
  registerPublicRouteGuard(server);

  // Server-wide, set once here rather than by whichever route module happens
  // to be registered first: a Zod-schema route registered independently of
  // the identity module would otherwise validate nothing.
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  // The stack is same-origin (ADR 0017): the gateway serves the web app and
  // routes /api/ to this API, so a browser never makes a cross-origin call
  // and needs no CORS. This is ADR 0017's escape hatch for a deployment that
  // serves the API from a separate origin (VITE_TELFLO_API_URL): the client
  // sends `credentials: "include"`, which forbids a wildcard
  // Access-Control-Allow-Origin, so the one allowed origin is explicit. The
  // CSRF header must be listed, or a cross-origin client's preflight for any
  // state-changing request is refused. Naming allowedHeaders replaces the
  // plugin's default of echoing whatever the preflight asks for, so
  // content-type is listed too.
  void server.register(cors, {
    origin: [deps.settings.webOrigin],
    credentials: true,
    allowedHeaders: ["content-type", CSRF_HEADER_NAME],
  });
  void server.register(cookie);

  registerErrorHandling(server);
  // Before every route (D2a decision 6). Fastify queues root hooks in
  // registration order, so CORS headers are already on a refused response.
  registerCsrfGuard(server);
  // Per-route hooks, so they run after the CSRF guard: a refused request
  // doesn't spend the caller's budget (D2a decision 9).
  const rateLimiters = registerRateLimits(server, deps.rateLimits ?? RATE_LIMITS);
  // Defaulted once, here, so every module shares one clock and one runner.
  const runAfterResponse = deps.runAfterResponse ?? createAfterResponseRunner(server.log);
  // The opamp-server's registry, kept in step after each commit (D11a
  // decision 20), an organization's delete retried (D16b Preflight ruling
  // 14). At close, the deletes still pending are logged: their retries are
  // lost with the process.
  const opampRegistration = createOpampRegistration({ opampServer: deps.opampServer, runAfterResponse, log: server.log });
  server.addHook("onClose", async () => {
    opampRegistration.close();
  });
  const baseDeps = {
    ...deps,
    now: deps.now ?? (() => new Date()),
    runAfterResponse,
    opampRegistration,
  };
  // One instance of each data service (D25 decision 15, Preflight ruling 4),
  // shared by the browser routes and the public routes.
  const moduleDeps = { ...baseDeps, services: createModuleServices(baseDeps, rateLimiters, server.log) };
  registerHealthRoutes(server, deps.db);
  registerIdentityRoutes(server, moduleDeps, rateLimiters);
  registerSessionRoutes(server, moduleDeps, rateLimiters);
  // The account's own routes (D21 decision 20), after the session routes.
  registerAccountRoutes(server, moduleDeps, rateLimiters);
  registerPasswordResetRoutes(server, moduleDeps, rateLimiters);
  registerOidcRoutes(server, moduleDeps, rateLimiters);
  // After the session routes, which declare the request's authentication.
  registerOrganizationRoutes(server, moduleDeps, rateLimiters);
  // The organization's service accounts, for its admins (D22 decision 26).
  registerServiceAccountRoutes(server, moduleDeps);
  // The public surface, /api/public/v1/ (D22 decision 33): a service account's tf_ token, no session, no terms.
  registerPublicApiRoutes(server, moduleDeps, rateLimiters);
  registerConfigurationRoutes(server, moduleDeps);
  // The opamp-server's fleets, for every member (D16b decisions 6 and 13).
  registerFleetRoutes(server, moduleDeps);
  // The organization's variables and variable groups, for every member (D20 decision 37).
  registerVariableRoutes(server, moduleDeps);
  // The public download (D17c-2 decision 26, Preflight ruling 10): no session, its own limits and plain-text refusals.
  registerQuickDeployRoutes(server, moduleDeps, rateLimiters);
  // The public logo read (D23-2 decision 39): no session, its own per-IP limit and plain-text refusals.
  registerOrganizationLogoRoutes(server, moduleDeps, rateLimiters);
  registerCollectorCatalogueRoutes(server, moduleDeps);
  registerFlowRoutes(server, moduleDeps, rateLimiters);
  registerTestRunsRoutes(server, moduleDeps, rateLimiters);
  registerTestSuitesRoutes(server, moduleDeps, rateLimiters);
  registerTestTemplatesRoutes(server, moduleDeps, rateLimiters);
  // The library (D23-2 decisions 41 to 45): members read, product admins write; its link's public route has no session.
  registerLibraryFilesRoutes(server, moduleDeps, rateLimiters);
  registerTestRegexesRoutes(server, moduleDeps, rateLimiters);
  registerValidationPipelinesRoutes(server, moduleDeps);
  registerSalesInquiryRoutes(server, moduleDeps, rateLimiters);
  // Product administration across organizations (D29 decision 28): every route
  // [authenticate, requireProductAdmin], through the SystemRepository alone.
  registerProductAdminUsersRoutes(server, moduleDeps, rateLimiters);
  registerProductAdminsRoutes(server, moduleDeps, rateLimiters);
  registerProductAdminSettingsRoutes(server, moduleDeps, rateLimiters);
  registerProductAdminFeedbackRoutes(server, moduleDeps, rateLimiters);
  // "Contact us" (D29 decision 32): any signed-in person with the current terms.
  registerFeedbackRoutes(server, moduleDeps, rateLimiters);

  return server;
}
