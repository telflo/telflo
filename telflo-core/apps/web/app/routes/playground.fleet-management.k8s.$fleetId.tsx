import { redirect } from "react-router";
import type { Route } from "./+types/playground.fleet-management.k8s.$fleetId";

/*
 * The per-kind fleet path, `/playground/fleet-management/k8s/:fleetId`: the
 * platform has one fleet page for every type, so it redirects there, the id
 * as given (the page answers its own "not found" for one the sample doesn't
 * hold).
 */
export function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/playground/fleet-management/${encodeURIComponent(params.fleetId)}`);
}
