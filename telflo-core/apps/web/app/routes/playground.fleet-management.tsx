import { useEffect } from "react";
import type { Route } from "./+types/playground.fleet-management";
import { consumePlaygroundTourStage, startPlaygroundFleetTour, stopPlaygroundTour } from "~/components/playground/playground-tour.js";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, playgroundMeta } from "~/lib/playground/meta.js";
import { useSignUpPath } from "~/lib/use-site.js";
import FleetManagementRoute from "./fleet-management.js";

/*
 * `/playground/fleet-management`, the sample workspace's fleet list (D31-1
 * decisions 8, 10 and 35; Preflight rulings 8, 9 and 20): the signed-in
 * list (`fleet-management.tsx`: its header, filter, FleetsTable and "Load
 * more") on the sample's four fleets, inside the playground's shell. No
 * StatsStrip and no usage figures, as the signed-in list (usage is D28's).
 *
 * - The rows are read through the seam: `useFleetsList` asks `readsFor` for
 *   the sample visitor's organization, so they come from the sample, never
 *   the API, and each 15 s poll rebuilds them ("last seen" stays fresh).
 *   The filter (All, Active, Archived) applies to the sample as the API's
 *   `status` does.
 * - "New Fleet" and a row's Rename, Archive and Delete open the sign-up
 *   prompt (locked at their openers, `useNewFleetDialogs` and
 *   `useFleetActionDialogs`); no dialog opens.
 * - A fleet's link (FleetsTable's, TokenCell's) keeps its signed-in path in
 *   the DOM and lands on the playground's page (the shell's link scope).
 * - The playground tour's last stage runs here when the editor's hands it
 *   over (decision 15), on the fleets' table inside the `fleet-table`
 *   wrapper (Preflight ruling 16).
 * The title is fixed and the canonical the page's own (decision 17).
 */

export const handle = PLAYGROUND_HANDLE;

export function meta({ matches }: Route.MetaArgs) {
  return playgroundMeta(matches, PLAYGROUND_TITLES.fleets, "/playground/fleet-management");
}

export default function PlaygroundFleets() {
  // The wrap-up's sign-up link (D36-1 decision 23): a string fixed per process, so the effect runs once.
  const signUp = useSignUpPath();
  useEffect(() => {
    if (consumePlaygroundTourStage("fleet")) startPlaygroundFleetTour(signUp);
    return stopPlaygroundTour;
  }, [signUp]);
  return (
    <div data-tour-step="fleet-table">
      <FleetManagementRoute />
    </div>
  );
}
