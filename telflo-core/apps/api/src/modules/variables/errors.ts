import {
  ORGANIZATION_VARIABLES_MAXIMUM,
  VARIABLE_REFERENCE_TOO_LONG_MESSAGE,
  VARIABLES_UNAVAILABLE_MESSAGE,
  type VariableErrorCode,
  type VariableGroupInUseDetails,
  type VariableInUseDetails,
  type VariablesUndefinedDetails,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";
import { fieldDetail } from "../fleets/errors.js";

/*
 * The variables routes' refusals (the opamp-server's codes, plus
 * `variables_unavailable` when it can't be asked), each code one of the
 * contracts' VARIABLE_ERROR_CODES. The fleet routes' assignments and pins
 * answer `variable_group_not_found` and `variables_undefined` too. The
 * organization's (`organization_not_found`) are the organization module's,
 * so every route answers alike.
 *
 * Each message is the platform's own fixed words: never the opamp-server's
 * text, and never a variable's name, value or description, nor a variable
 * group's name or description (configuration text). Names and ids
 * travel only in a refusal's `details`, which no log line carries (a 4xx
 * AppError isn't logged: errors.ts).
 */

/** A variable the organization doesn't hold: an unknown id, another organization's, one deleted, or an id that isn't a canonical UUID (no call). */
export function variableNotFound(): AppError {
  return new AppError("variable_not_found" satisfies VariableErrorCode, "Variable not found", 404);
}

/**
 * A variable group the organization doesn't hold, alike for an id that
 * isn't a canonical UUID (no call): on its own routes, and named by a
 * collector group's or a collector's binding.
 */
export function variableGroupNotFound(): AppError {
  return new AppError("variable_group_not_found" satisfies VariableErrorCode, "Variable group not found", 404);
}

export function variableNameTaken(): AppError {
  return new AppError(
    "variable_name_taken" satisfies VariableErrorCode,
    "Another of the organization's variables has this name.",
    409,
  );
}

export function variableGroupNameTaken(): AppError {
  return new AppError(
    "variable_group_name_taken" satisfies VariableErrorCode,
    "Another of the organization's variable groups has this name.",
    409,
  );
}

/**
 * A variable's delete or rename while a published version a collector group
 * or a collector uses references its name: nothing changed. The details
 * name what uses it, the platform's names beside the ids (null where a
 * lookup found none), at most 100 entries with exact totals.
 */
export function variableInUse(details: VariableInUseDetails): AppError {
  return new AppError(
    "variable_in_use" satisfies VariableErrorCode,
    "A published version that a collector group or a collector uses references this variable: assign or pin another version first.",
    409,
    details,
  );
}

/** A variable group's delete while a collector group or a collector uses it: nothing deleted. */
export function variableGroupInUse(details: VariableGroupInUseDetails): AppError {
  return new AppError(
    "variable_group_in_use" satisfies VariableErrorCode,
    "A collector group or a collector uses this variable group: choose another for them first.",
    409,
    details,
  );
}

export function variableLimitReached(): AppError {
  return new AppError(
    "variable_limit_reached" satisfies VariableErrorCode,
    `The organization has ${ORGANIZATION_VARIABLES_MAXIMUM} variables, the most it may have.`,
    409,
  );
}

export function variableGroupLimitReached(): AppError {
  return new AppError(
    "variable_group_limit_reached" satisfies VariableErrorCode,
    "The organization has 100 variable groups, the most it may have.",
    409,
  );
}

/** A create naming the id of a variable with another name, value or description (a retry's id). */
export function variableConflict(): AppError {
  return new AppError("variable_conflict" satisfies VariableErrorCode, "A different variable already has this id.", 409);
}

/** A create naming the id of a variable group with another name or description. */
export function variableGroupConflict(): AppError {
  return new AppError("variable_group_conflict" satisfies VariableErrorCode, "A different variable group already has this id.", 409);
}

/**
 * A collector group's assignment, a collector's pin or the bulk pin of a
 * published version referencing names no variable of the organization has:
 * nothing changed. The details name them, at most 100, with their exact total.
 */
export function variablesUndefined(details: VariablesUndefinedDetails): AppError {
  return new AppError(
    "variables_undefined" satisfies VariableErrorCode,
    "The published version references organization variables that aren't defined: define them first.",
    422,
    details,
  );
}

/** The contracts' words, re-exported for the API's callers. */
export { VARIABLE_REFERENCE_TOO_LONG_MESSAGE, VARIABLES_UNAVAILABLE_MESSAGE };

/**
 * The one 503: the opamp-server down, slow, oversized, refusing the
 * secret, or answering what the API doesn't document. Its words are neutral:
 * a read's and a write's alike, the latter possibly after a change the
 * opamp-server made (a reply lost after its commit), which the words neither
 * claim nor deny. Validate's and a test run's queue answer the same 503.
 */
export function variablesUnavailable(): AppError {
  return new AppError("variables_unavailable" satisfies VariableErrorCode, VARIABLES_UNAVAILABLE_MESSAGE, 503);
}

/**
 * A publish whose text holds a live `${org:NAME}` to a name over 128
 * characters, which no variable can have, refused before anything is
 * written on either side; and the opamp-server's own 400 `invalid_request`
 * on a publish, its backstop (that code only). 400 `invalid_request`, its
 * details naming `yaml`. Never the name.
 */
export function variableReferenceTooLong(): AppError {
  return new AppError("invalid_request", VARIABLE_REFERENCE_TOO_LONG_MESSAGE, 400, [
    fieldDetail("yaml", VARIABLE_REFERENCE_TOO_LONG_MESSAGE),
  ]);
}
