import type { ActorContext } from "../../database/context.js";
import type { IConfigurationRepository } from "../configurations/repositories/configuration-repository.js";
import type { IConfigurationVersionRepository } from "../configurations/repositories/configuration-version-repository.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IMemberRepository } from "../organizations/repositories/member-repository.js";
import type { IActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import type { ITestInputFileRepository } from "../test-runs/repositories/test-input-file-repository.js";
import type { ITestTemplateRepository } from "../test-templates/repositories/test-template-repository.js";
import type { ITestDefinitionInputRepository } from "./repositories/test-definition-input-repository.js";
import type { ITestDefinitionRepository } from "./repositories/test-definition-repository.js";
import type { ITestSuiteRepository } from "./repositories/test-suite-repository.js";

/**
 * The repositories a unit of work of the suites endpoints uses, bound to one
 * transaction that carries the request's database context: the active
 * organization and its members (the lock and the membership's re-read), the
 * configurations (read, and locked for a write: one lock order) and versions
 * as the caller sees them, the suites, definitions and inputs they can see,
 * the caller's own test files and the live templates (a definition's
 * sources), and the audit trail.
 */
export interface TestSuitesTransaction {
  organization: Pick<IActiveOrganizationRepository, "findActiveForShare">;
  members: Pick<IMemberRepository, "find">;
  configurations: Pick<IConfigurationRepository, "find" | "lockForUpdate">;
  versions: Pick<IConfigurationVersionRepository, "findSummary">;
  suites: ITestSuiteRepository;
  definitions: ITestDefinitionRepository;
  inputs: ITestDefinitionInputRepository;
  files: Pick<ITestInputFileRepository, "findOwn">;
  templates: ITestTemplateRepository;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction in `context`'s database context,
 * and resolves with its result once the transaction commits. If `work`
 * rejects, the transaction rolls back and the rejection propagates.
 */
export type WithTestSuitesTransaction = <Result>(
  context: ActorContext,
  work: (transaction: TestSuitesTransaction) => Promise<Result>,
) => Promise<Result>;
