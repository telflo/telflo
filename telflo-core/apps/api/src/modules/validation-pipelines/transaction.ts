import type { ActorContext } from "../../database/context.js";
import type { IConfigurationRepository } from "../configurations/repositories/configuration-repository.js";
import type { IConfigurationVersionRepository } from "../configurations/repositories/configuration-version-repository.js";
import type { IAuditRepository } from "../identity/repositories/audit-repository.js";
import type { IMemberRepository } from "../organizations/repositories/member-repository.js";
import type { IActiveOrganizationRepository } from "../organizations/repositories/organization-repository.js";
import type { IValidationPipelineRepository } from "./repositories/validation-pipeline-repository.js";
import type { IValidationRuleRepository } from "./repositories/validation-rule-repository.js";

/**
 * The repositories a unit of work of the validation pipelines endpoints
 * uses, bound to one transaction that carries the request's database
 * context: the active organization and its members (the lock and the
 * membership's re-read, D7 decision 9's), the configurations (read, and
 * locked for a write: one lock order) and versions as the caller sees them
 * (D11b decision 1), the validation pipelines and rules they can see, and
 * the audit trail.
 */
export interface ValidationPipelinesTransaction {
  organization: Pick<IActiveOrganizationRepository, "findActiveForShare">;
  members: Pick<IMemberRepository, "find">;
  configurations: Pick<IConfigurationRepository, "find" | "lockForUpdate">;
  versions: Pick<IConfigurationVersionRepository, "findSummary">;
  pipelines: IValidationPipelineRepository;
  rules: IValidationRuleRepository;
  audit: IAuditRepository;
}

/**
 * Runs `work` in one database transaction in `context`'s database context,
 * and resolves with its result once the transaction commits. If `work`
 * rejects, the transaction rolls back and the rejection propagates.
 */
export type WithValidationPipelinesTransaction = <Result>(
  context: ActorContext,
  work: (transaction: ValidationPipelinesTransaction) => Promise<Result>,
) => Promise<Result>;
