import type { Route } from "./+types/library";
import { LibraryPage } from "~/components/library/LibraryPage.js";

/*
 * `/library`, the sidebar's Learning (D23-2 decisions 5, 54 and 56): its
 * title and description (fixed words, never a file's name). The signed-in
 * layout route supplies the shell (AppLayout), the session check and the
 * terms dialog.
 */

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Library - Telflo" }, { name: "description", content: "Download resources provided by Telflo" }];
}

export default function LibraryRoute() {
  return <LibraryPage />;
}
