import { useEffect } from "react";

/**
 * Applies the app design-token scope class to <body> (so Radix portals —
 * dialogs, popovers, selects — inherit the app theme) for surfaces rendered
 * outside AppLayout: the auth screens (AuthShell). The playground and the
 * public editor use `usePlaygroundSurface` (lib/playground/surface.ts)
 * instead, which masks them too. AppLayout manages the class itself for
 * authenticated pages; these surfaces never nest inside it, so add/remove
 * pairs can't clobber each other.
 */
export function useTfAppSurface() {
  useEffect(() => {
    document.body.classList.add("tf-app");
    return () => {
      document.body.classList.remove("tf-app");
    };
  }, []);
}
