import type { FastifyBaseLogger } from "fastify";
import type { ServerDependencies } from "../dependencies.js";
import type { RunAfterResponse } from "../http/after-response.js";
import type { RateLimiters } from "../http/rate-limits.js";
import { createConfigurationServices, type ConfigurationServices } from "./configurations/routes.js";
import { createFleetServices, type FleetServices } from "./fleets/routes.js";
import { createFlowServices, type FlowServices } from "./flows/routes.js";
import type { OpampRegistration } from "./organizations/opamp-registration.js";
import { createOrganizationServices, type OrganizationServices } from "./organizations/routes.js";
import { createTestRunsServices, type TestRunsServices } from "./test-runs/routes.js";
import { createValidationPipelineServices, type ValidationPipelineServices } from "./validation-pipelines/routes.js";
import { createVariableServices, type VariableServices } from "./variables/routes.js";

/*
 * The data services, one instance each: built once by buildServer and
 * handed to every module in `moduleDeps.services`, so the browser routes
 * and the public routes (`/api/public/v1/`) share them. Nothing is
 * doubled: a service's limiter is counted once per person whichever
 * surface calls it, and the test runs' copy places are resolved once. Each
 * area's construction is its module's own `create<Area>Services`.
 */

/** What every module's services are built from: buildServer's dependencies, with its clock, runner and registry. */
export interface ModuleServicesDependencies extends ServerDependencies {
  now: () => Date;
  runAfterResponse: RunAfterResponse;
  opampRegistration: OpampRegistration;
}

export interface ModuleServices {
  configurations: ConfigurationServices;
  fleets: FleetServices;
  flows: FlowServices;
  organizations: OrganizationServices;
  testRuns: TestRunsServices;
  validationPipelines: ValidationPipelineServices;
  variables: VariableServices;
}

/** Called once, by buildServer. */
export function createModuleServices(
  deps: ModuleServicesDependencies,
  rateLimiters: RateLimiters,
  log: FastifyBaseLogger,
): ModuleServices {
  return {
    configurations: createConfigurationServices(deps, rateLimiters, log),
    fleets: createFleetServices(deps, rateLimiters, log),
    flows: createFlowServices(deps),
    organizations: createOrganizationServices(deps, rateLimiters, log),
    testRuns: createTestRunsServices(deps, rateLimiters, log),
    validationPipelines: createValidationPipelineServices(deps, rateLimiters, log),
    variables: createVariableServices(deps, rateLimiters, log),
  };
}
