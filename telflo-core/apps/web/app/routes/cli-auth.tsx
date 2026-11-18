import type { Route } from "./+types/cli-auth";
import { CliAuthPage } from "~/components/cli-auth/CliAuthPage.js";

/*
 * `/cli-auth`, `telflo login`'s browser side (D27 decisions 21 and 22;
 * Preflight ruling 15): inside the signed-in layout, which sends a
 * signed-out visitor to sign in and back (the fragment kept: Preflight
 * ruling 13). The title is fixed words: never the machine's name.
 */

export function meta(_args: Route.MetaArgs) {
  return [{ title: "CLI sign-in - Telflo" }];
}

export default function CliAuthRoute() {
  return <CliAuthPage />;
}
