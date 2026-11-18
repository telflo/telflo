import type { Route } from "./+types/playground.fleet-management.$fleetId";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, playgroundMeta } from "~/lib/playground/meta.js";
import FleetRoute from "./fleet-management.$fleetId.js";

/*
 * `/playground/fleet-management/:fleetId`, a sample fleet's page (D31-1
 * decisions 8, 10 and 35; Preflight rulings 8, 9 and 20): the signed-in
 * fleet page (`fleet-management.$fleetId.tsx`), one page for every type of
 * fleet, its tab in `?tab=`, inside the playground's shell: the header, the
 * stats strip, and the tabs Collectors, Groups (a Kubernetes fleet's
 * Kubernetes groups) and Tokens with its install links and history.
 *
 * - Everything is read through the seam (`readsFor`, the sample visitor's
 *   organization): the fleet, its collectors and groups, a collector's
 *   details and error history, the tokens, their history and the install
 *   links come from the sample, never the API, each poll rebuilding them.
 * - Reads open: a collector's details, a group's details, an install link's
 *   View, the setup guide, search, the group filter and the sort.
 * - Every write is locked at its opener (decision 24, Preflight ruling 9):
 *   Rename, Archive, Delete, every install entry, a collector's edit,
 *   delete and the bulk actions, a group's create, edit and delete, every
 *   token and install link action, the checklist's Assign, and a variable
 *   group's values (the organization's variables, which the sample doesn't
 *   have): each opens the sign-up prompt with its own words, no dialog.
 * - An id the sample doesn't hold (or one that isn't a UUID) is the page's
 *   own "Fleet not found" (decision 25), never the API's.
 * - Links inside the reused components (the back link, a published
 *   version's) land on the playground's pages (the shell's link scope).
 * The title is fixed, never the fleet's label, and the canonical the page's
 * own (decision 17).
 */

export const handle = PLAYGROUND_HANDLE;

export function meta({ matches, params }: Route.MetaArgs) {
  return playgroundMeta(matches, PLAYGROUND_TITLES.fleet, `/playground/fleet-management/${encodeURIComponent(params.fleetId)}`);
}

export default function PlaygroundFleet() {
  return <FleetRoute />;
}
