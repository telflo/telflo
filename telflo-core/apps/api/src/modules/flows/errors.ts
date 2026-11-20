import type { FlowErrorCode } from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The flows endpoints' own refusals. The shared ones are their modules':
 * `product_admin_required` is `requireProductAdmin`'s
 * (sessions/authenticate.ts), and a pin the catalogue doesn't offer is the
 * configurations' `collector_distribution_unknown` or
 * `collector_version_unknown` (configurations/errors.ts), so a flow's pin and
 * a configuration's are refused alike.
 */

/**
 * A slug or an id no flow has, an id that isn't a canonical UUID, and a
 * hidden flow read by anyone but a product admin, all alike: a hidden flow
 * doesn't exist for them.
 */
export function flowNotFound(): AppError {
  return new AppError("flow_not_found" satisfies FlowErrorCode, "Flow not found", 404);
}

/**
 * A create, or a change of slug, to a slug another flow has (uq_flows_slug):
 * found by the database's unique index, so two writes racing for one slug
 * end in exactly one of these. Nothing is written.
 */
export function flowSlugTaken(): AppError {
  return new AppError("flow_slug_taken" satisfies FlowErrorCode, "Another flow already has that slug.", 409);
}
