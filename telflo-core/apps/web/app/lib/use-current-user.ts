import { useRouteLoaderData } from "react-router";
import { usePlaygroundVisitor } from "~/lib/playground/context.js";
import { useUserStore, type StoredCurrentUser } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";

/**
 * The signed-in user, for the sidebar and the signed-in pages. The store is
 * seeded from the layout loader in an effect, which never runs during server
 * rendering (the store is a module singleton, so writing it on the server
 * would leak one request's user into another's). Until then — on the server
 * and in the hydrating render — the layout's loader data stands in, so the
 * page is in the server-rendered markup and hydration matches it.
 *
 * Inside the playground (D31-1 decision 23, Preflight ruling 8) the sample
 * workspace's visitor comes first: the store outlives the signed-in layout,
 * so a signed-in visitor's real organization would otherwise reach the
 * reused hooks that read it.
 */
export function useCurrentUser(): StoredCurrentUser | null {
  const visitor = usePlaygroundVisitor();
  const stored = useUserStore((state) => state.current);
  const loaded = useRouteLoaderData<AppLayoutData>("routes/app-layout");
  const fromLoader = loaded?.status === "signed_in" ? loaded.currentUser : null;
  return visitor ?? stored ?? fromLoader;
}
