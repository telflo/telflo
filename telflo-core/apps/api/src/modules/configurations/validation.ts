import type {
  ConfigurationValidationError,
  ConfigurationValidationRequirement,
  ConfigurationValidationStatus,
} from "@telflo/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { ValidationLimiter } from "../../http/rate-limits.js";
import { OpampServerMisconfigurationError } from "../../opamp-server/client.js";
import type { OtelcolValidatorClient, ValidatorUnavailableReason } from "../../otelcol-validator/client.js";
import type {
  CollectorVersionState,
  ICollectorCatalogueRepository,
} from "../collector-catalogue/repositories/collector-catalogue-repository.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import {
  references,
  type IOrganizationVariables,
  type OrganizationVariablesRead,
} from "../test-runs/organization-variables.js";
import { collectorVersionRetired } from "../test-runs/errors.js";
import { variablesUnavailable } from "../variables/errors.js";
import {
  collectorDistributionUnknown,
  collectorVersionUnknown,
  configurationNotFound,
  configurationVersionNotFound,
  validationRateLimited,
  validationsInFlight,
  validationUnavailable,
} from "./errors.js";
import type { WithConfigurationTransaction } from "./service.js";

/*
 * A version's validation: the text the editor holds, checked by the collector
 * validator with the configuration's distribution and the version's pin, or
 * the tab's unsaved pick of another version of it.
 *
 * 1. The read, in one transaction as getVersion's, no lock: the
 *    configuration and the version are ones the caller can see (the draft
 *    rules: another member's draft is 404), and where the collector
 *    version stands in the catalog. It commits before anything else.
 * 2. A version the distribution doesn't have is 400
 *    `collector_version_unknown`.
 * 3. The person's limits: 60 checks a minute, a retired answer counted too,
 *    and two waiting on the validator at once; 429 `validation_rate_limited`
 *    with Retry-After.
 * 4. A deprecated version answers `retired`, the validator never asked
 *    (it holds only the offered ones).
 * 5. When the text references organization variables (a live
 *    `${org:NAME}`), their values are read from the opamp-server, outside
 *    any transaction, inside the person's in-flight slot; a read that
 *    fails is 503 `variables_unavailable`, the validator never asked. A
 *    text with none reads nothing.
 * 6. Then the validator is asked, outside any transaction, holding no
 *    connection, with the referenced names' values only: it fills them in
 *    before every check. Any failure of it is 503
 *    `validation_unavailable`.
 *
 * Nothing is stored and nothing is audited. The text, the organization's
 * values and names, the validator's answer and its secret never reach a log
 * line or an error's message: the log names ids, the distribution, the
 * version and the result's kind (with an unavailable's reason and status)
 * only.
 *
 * `validateText` checks a text that belongs to no configuration, for the
 * public API's `POST /validate`: the distribution and version named, else the
 * catalog's defaults (the default distribution, and the distribution's
 * default version). A distribution the catalog doesn't have is 400
 * `collector_distribution_unknown` (as is one with no default version when
 * the version is left out: a default is asked only then), a version it
 * doesn't have 400 `collector_version_unknown`, a retired one 400
 * `collector_version_retired`, each before any limit; then steps 3, 5 and 6
 * as above, the person's organization variables included.
 *
 * `validateAnonymousText` checks a text for the public API's open
 * `POST /validate/anonymous`: no actor, no organization. It resolves the
 * distribution and version as `validateText` does, with its three 400s, on
 * the plain database (the catalog is a global table), and never reads an
 * organization's variables: the validator is sent the text alone, so a
 * `${org:NAME}` stays as written (no opamp-server read; its only 503 is
 * `validation_unavailable`). Its limits are the route's, taken before it is
 * called (the anonymous validations', http/rate-limits.ts). It logs nothing
 * of its own but the validator's unavailability (the distribution, the
 * version and the reason); the text and the validator's errors are only
 * ever in its answer.
 */

export interface ValidationDependencies {
  withTransaction: WithConfigurationTransaction;
  validator: OtelcolValidatorClient;
  /** The organization's variables, which the opamp-server holds: test runs' read, shared. */
  variables: IOrganizationVariables;
  limiter: ValidationLimiter;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  /**
   * The catalog (a global table), on the plain database: `validateText`
   * checks a named distribution's existence there, whatever its versions;
   * `validateAnonymousText` reads all it needs there, outside any
   * organization's transaction.
   */
  catalogue: Pick<ICollectorCatalogueRepository, "listOffered" | "findDefaults" | "findDistributionDefault" | "findVersionState">;
}

/** What a validation asks for, as the contract parses it. */
export interface ValidationInput {
  /** The text, exactly as the editor holds it. Never logged. */
  yaml: string;
  /** The tab's unsaved pick; left out, the version's saved pin. */
  collectorVersion?: string | undefined;
}

/** What a text's validation asks for: the text, and the collector to check it with. */
export interface TextValidationInput {
  /** The text. Never logged. */
  yaml: string;
  /** Left out, the catalog's default distribution. */
  distribution?: string | undefined;
  /** Left out, the distribution's default version. */
  collectorVersion?: string | undefined;
}

/** A text's validation's answer (the public contract's PublicValidateResponse). */
export interface TextValidation {
  valid: boolean;
  collectorVersion: string;
  errors: ConfigurationValidationError[];
}

/** A validation's answer (the contract's ConfigurationValidationResponse). */
export interface ConfigurationValidation {
  status: ConfigurationValidationStatus;
  collectorVersion: string;
  errors: ConfigurationValidationError[];
  requirements: ConfigurationValidationRequirement[];
}

export interface IValidationService {
  /**
   * Checks `input.yaml` with the configuration's distribution at the
   * version named or saved. 404 `configuration_not_found` for a
   * configuration the caller can't see (a malformed id included), then 404
   * `configuration_version_not_found` for a version that isn't one of its
   * own; 400 `collector_version_unknown` for a collector version the
   * distribution doesn't have; 429 `validation_rate_limited`; 503
   * `variables_unavailable` when the organization's variables the text
   * references couldn't be read, and `validation_unavailable` when the
   * validator couldn't check it.
   */
  validateVersion(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    input: ValidationInput,
  ): Promise<ConfigurationValidation>;
  /**
   * Checks a text that belongs to no configuration with the distribution and
   * version named, or the catalog's defaults. 400
   * `collector_distribution_unknown`, `collector_version_unknown` or
   * `collector_version_retired`; 429 `validation_rate_limited`; 503
   * `variables_unavailable` and `validation_unavailable`, as validateVersion.
   */
  validateText(actor: Actor, organizationId: string, input: TextValidationInput): Promise<TextValidation>;
  /**
   * Checks a text for no one: as validateText, its three 400s and 503
   * `validation_unavailable` included, but with no actor, no organization, no
   * organization variables and no limit of its own (the caller's route admits
   * it first).
   */
  validateAnonymousText(input: TextValidationInput): Promise<TextValidation>;
}

/** The catalog's reads a text's validation resolves its collector with: a transaction's, or the plain database's. */
type CatalogueReads = Pick<ICollectorCatalogueRepository, "findDefaults" | "findDistributionDefault" | "findVersionState">;

/**
 * The distribution and version a text is checked with: the ones named, else
 * the catalog's defaults (a default version is asked only when the version
 * is left out), and the version's state. 400 `collector_distribution_unknown`
 * for a named distribution with no default when the version is left out.
 */
async function resolveTextTarget(
  catalogue: CatalogueReads,
  named: string | undefined,
  requestedVersion: string | undefined,
): Promise<{ distribution: string; collectorVersion: string; state: CollectorVersionState }> {
  let distribution: string;
  let collectorVersion: string;
  if (named === undefined) {
    const defaults = await catalogue.findDefaults();
    distribution = defaults.distribution;
    collectorVersion = requestedVersion ?? defaults.version;
  } else if (requestedVersion === undefined) {
    // A default is needed only when the version is left out.
    const pin = await catalogue.findDistributionDefault(named);
    if (pin === undefined) throw collectorDistributionUnknown();
    distribution = pin.distribution;
    collectorVersion = pin.version;
  } else {
    distribution = named;
    collectorVersion = requestedVersion;
  }
  const state = await catalogue.findVersionState(distribution, collectorVersion);
  return { distribution, collectorVersion, state };
}

/** A text's validation's answer, copied field by field: only what the contract carries reaches the response. */
function textAnswer(
  collectorVersion: string,
  result: { valid: boolean; errors: ReadonlyArray<{ message: string; componentPath: string | null }> },
): TextValidation {
  return {
    valid: result.valid,
    collectorVersion,
    errors: result.errors.map(({ message, componentPath }) => ({ message, componentPath })),
  };
}

/**
 * The reasons that mean a deployment to fix rather than a moment's trouble:
 * logged at error. Not `oversized_reply`: any member's text could once cause
 * one (5.1 MiB of requirements, 4.61 MiB of errors). The validator now
 * answers at most 2,290,356 bytes, under the client's 4 MiB, so one means a
 * validator without those bounds; still at warn, like the rest, since a
 * person's text can't be told from a deployment fault.
 */
const MISCONFIGURATION_REASONS: ReadonlySet<ValidatorUnavailableReason> = new Set(["unauthorized", "malformed_reply"]);

export function createValidationService(deps: ValidationDependencies): IValidationService {
  const { withTransaction, validator, variables, limiter, log, catalogue } = deps;

  /**
   * The values of the names `yaml` references live (the opamp-server's
   * `References`, test runs' port), in its order; nothing read when it
   * references none. 503 `variables_unavailable` when the opamp-server
   * can't answer (logged at warn with the client's reason), or its client
   * throws (a misconfiguration, logged at error with the client's message,
   * which names the operation and the fields only; anything else by its
   * name only, as the fleets module's calls are); an organization it
   * doesn't hold has no variables.
   */
  async function referencedValues(
    organizationId: string,
    yaml: string,
    ids: Record<string, string>,
  ): Promise<Map<string, string> | undefined> {
    const names = references(yaml);
    if (names.length === 0) return undefined;
    let read: OrganizationVariablesRead;
    try {
      read = await variables.read(organizationId);
    } catch (error) {
      const fields = { ...ids, result: "variables_unavailable" };
      if (error instanceof OpampServerMisconfigurationError) {
        log.error({ ...fields, error: error.message }, "the opamp-server's settings are wrong, or its answer isn't the API's");
      } else {
        log.error({ ...fields, error: error instanceof Error ? error.name : typeof error }, "reading the organization's variables threw");
      }
      throw variablesUnavailable();
    }
    if (read.kind === "unavailable") {
      log.warn(
        { ...ids, result: "variables_unavailable", reason: read.reason },
        "the organization's variables couldn't be read for a validation",
      );
      throw variablesUnavailable();
    }
    if (read.kind === "none") return undefined;
    const values = new Map<string, string>();
    for (const name of names) {
      const value = read.values.get(name);
      if (value !== undefined) values.set(name, value);
    }
    return values;
  }

  /**
   * Asks the validator, holding the person's admission, with the
   * organization's values for the names the text references; with no
   * organization (`undefined`, the anonymous text), the text alone and
   * nothing read. An unavailable answer is logged and 503
   * `validation_unavailable`.
   */
  async function askValidator(
    organizationId: string | undefined,
    target: { distribution: string; collectorVersion: string; yaml: string },
    ids: Record<string, string>,
    release: () => void,
  ): Promise<Extract<Awaited<ReturnType<OtelcolValidatorClient["validate"]>>, { kind: "checked" }>> {
    let result: Awaited<ReturnType<OtelcolValidatorClient["validate"]>>;
    try {
      const check = { distribution: target.distribution, version: target.collectorVersion, yaml: target.yaml };
      result =
        organizationId === undefined
          ? await validator.validate(check)
          : await validator.validate({ ...check, organizationVariables: await referencedValues(organizationId, target.yaml, ids) });
    } finally {
      release();
    }
    if (result.kind === "unavailable") {
      const fields = {
        ...ids,
        result: "unavailable",
        reason: result.reason,
        ...(result.status === undefined ? {} : { status: result.status }),
      };
      if (MISCONFIGURATION_REASONS.has(result.reason)) log.error(fields, "the collector validator can't be used");
      else log.warn(fields, "the collector validator is unavailable");
      throw validationUnavailable();
    }
    return result;
  }

  return {
    async validateText(actor, organizationId, input) {
      assertActiveOrganization(actor, organizationId);
      // The named distribution's existence, whatever its versions offer.
      const named = input.distribution;
      if (named !== undefined && !(await catalogue.listOffered()).some((distribution) => distribution.id === named)) {
        throw collectorDistributionUnknown();
      }
      const target = await withTransaction(actor.context, (transaction) =>
        resolveTextTarget(transaction.catalogue, named, input.collectorVersion),
      );
      // Committed: nothing below holds a transaction or a connection.

      const { distribution, collectorVersion, state } = target;
      const ids = { organizationId, distribution, collectorVersion };
      if (state === "unknown") throw collectorVersionUnknown();
      if (state === "deprecated") throw collectorVersionRetired();

      const admission = limiter.admit(actor.context.userId, { callsValidator: true });
      if (!admission.isAdmitted) {
        throw admission.reason === "per_minute"
          ? validationRateLimited(admission.retryAfterSeconds)
          : validationsInFlight(admission.retryAfterSeconds);
      }
      const result = await askValidator(
        actor.context.organizationId,
        { distribution, collectorVersion, yaml: input.yaml },
        ids,
        admission.release,
      );
      log.info({ ...ids, result: result.valid ? "valid" : "invalid" }, "text validated");
      return textAnswer(collectorVersion, result);
    },

    async validateAnonymousText(input) {
      // The named distribution's existence, whatever its versions offer, then the rest on the plain database.
      const named = input.distribution;
      if (named !== undefined && !(await catalogue.listOffered()).some((distribution) => distribution.id === named)) {
        throw collectorDistributionUnknown();
      }
      const { distribution, collectorVersion, state } = await resolveTextTarget(catalogue, named, input.collectorVersion);
      if (state === "unknown") throw collectorVersionUnknown();
      if (state === "deprecated") throw collectorVersionRetired();
      // No organization: the text alone, nothing read from the opamp-server. The route holds the admission.
      const ids = { distribution, collectorVersion };
      const result = await askValidator(undefined, { ...ids, yaml: input.yaml }, ids, () => undefined);
      return textAnswer(collectorVersion, result);
    },

    async validateVersion(actor, organizationId, configurationId, versionId, input) {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(configurationId);
      if (id === undefined) throw configurationNotFound();
      const canonicalVersionId = canonicalIdOf(versionId);

      const target: { distribution: string; collectorVersion: string; state: CollectorVersionState; versionId: string } =
        await withTransaction(actor.context, async (transaction) => {
          // The configuration first, so a deleted one is configuration_not_found
          // whatever the version, as getVersion's.
          const configuration = await transaction.configurations.find(id);
          if (!configuration) throw configurationNotFound();
          const version =
            canonicalVersionId === undefined
              ? undefined
              : await transaction.versions.findSummary(id, canonicalVersionId);
          if (!version) throw configurationVersionNotFound();
          // Always the configuration's distribution, never the browser's.
          const distribution = configuration.collectorDistribution;
          const collectorVersion = input.collectorVersion ?? version.collectorVersion;
          const state = await transaction.catalogue.findVersionState(distribution, collectorVersion);
          return { distribution, collectorVersion, state, versionId: version.id };
        });
      // Committed: nothing below holds a transaction or a connection.

      const { distribution, collectorVersion, state } = target;
      const ids = { configurationId: id, versionId: target.versionId, distribution, collectorVersion };
      if (state === "unknown") throw collectorVersionUnknown();

      const admission = limiter.admit(actor.context.userId, { callsValidator: state === "offered" });
      if (!admission.isAdmitted) {
        throw admission.reason === "per_minute"
          ? validationRateLimited(admission.retryAfterSeconds)
          : validationsInFlight(admission.retryAfterSeconds);
      }

      if (state === "deprecated") {
        log.info({ ...ids, result: "retired" }, "configuration version validated");
        return { status: "retired", collectorVersion, errors: [], requirements: [] };
      }

      const result = await askValidator(
        actor.context.organizationId,
        { distribution, collectorVersion, yaml: input.yaml },
        ids,
        admission.release,
      );

      const status = result.valid ? "valid" : "invalid";
      log.info({ ...ids, result: status }, "configuration version validated");
      return {
        status,
        collectorVersion,
        // Copied field by field: only what the contract carries reaches the response.
        errors: result.errors.map(({ message, componentPath }) => ({ message, componentPath })),
        requirements: result.requirements.map(({ category, title, description, componentPath }) => ({
          category,
          title,
          description,
          componentPath,
        })),
      };
    },
  };
}
