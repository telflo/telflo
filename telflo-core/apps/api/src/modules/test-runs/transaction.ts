import type { ActorContext } from "../../database/context.js";
import type { ICollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import type { IConfigurationRepository } from "../configurations/repositories/configuration-repository.js";
import type { IConfigurationVersionRepository } from "../configurations/repositories/configuration-version-repository.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IMemberRepository } from "../organizations/repositories/member-repository.js";
import type { IActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import type { ITestDefinitionRepository } from "../test-suites/repositories/test-definition-repository.js";
import type { ITestTemplateRepository } from "../test-templates/repositories/test-template-repository.js";
import type { ITestInputFileRepository } from "./repositories/test-input-file-repository.js";
import type { ITestRunRepository } from "./repositories/test-run-repository.js";

/**
 * The repositories a unit of work of the testing endpoints uses, bound to
 * one transaction that carries the request's database context: the active
 * organization and its members (the lock and the membership's re-read, as
 * the configurations take them), the configurations and versions as the
 * caller sees them, the catalogue, the caller's own test files, the runs
 * and the suites' definitions they can see, the live templates (a run's
 * sources), and the audit trail.
 */
export interface TestRunsTransaction {
  organization: Pick<IActiveOrganizationRepository, "findActiveForShare">;
  members: Pick<IMemberRepository, "find">;
  configurations: Pick<IConfigurationRepository, "find">;
  versions: Pick<IConfigurationVersionRepository, "findSummary">;
  /** A YAML run's pin is the catalogue's defaults for what it doesn't name. */
  catalogue: Pick<ICollectorCatalogueRepository, "findVersionState" | "findDefaults" | "findDistributionDefault" | "listOffered">;
  files: ITestInputFileRepository;
  runs: ITestRunRepository;
  definitions: Pick<ITestDefinitionRepository, "findForRun">;
  templates: Pick<ITestTemplateRepository, "findLive">;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction in `context`'s database context,
 * and resolves with its result once the transaction commits. If `work`
 * rejects, the transaction rolls back and the rejection propagates.
 */
export type WithTestRunsTransaction = <Result>(
  context: ActorContext,
  work: (transaction: TestRunsTransaction) => Promise<Result>,
) => Promise<Result>;
