import { useEffect, useState } from "react";
import { setAnalyticsMasked } from "~/lib/analytics.js";

/*
 * The playground's surfaces (D31-1 decisions 13 and 16, Preflight rulings
 * 13 and 18): the shell, the full-screen editor and the blank public
 * editor.
 */

/**
 * The classes a surface's root element carries, as AppLayout's root does:
 * `tf-app` (the app's design tokens) and `ph-mask` (session replay masks
 * all its text). The editor's text sits inside `ph-no-capture` as well.
 */
export const PLAYGROUND_SURFACE_CLASS = "tf-app ph-mask";

const BODY_CLASSES = ["tf-app", "ph-mask"] as const;

/** How many surfaces are mounted: the body's classes go when the last one does. */
let mounted = 0;

/**
 * A playground surface, masked like the signed-in shell (decision 13):
 * while it is mounted `<body>` carries `tf-app ph-mask` (Radix's portals,
 * dialogs, popovers and toasts, inherit the tokens and the mask) and
 * autocapture sends no text or attribute (`setAnalyticsMasked`, reference
 * counted); all of it is released on unmount. Counted, so a surface
 * mounting as another unmounts never strips the other's classes. Pair it
 * with `PLAYGROUND_SURFACE_CLASS` on the surface's root.
 */
export function usePlaygroundSurface(): void {
  useEffect(() => {
    mounted += 1;
    document.body.classList.add(...BODY_CLASSES);
    const releaseAnalyticsMask = setAnalyticsMasked(true);
    return () => {
      mounted -= 1;
      if (mounted === 0) document.body.classList.remove(...BODY_CLASSES);
      releaseAnalyticsMask();
    };
  }, []);
}

/** Below `md` (767 px and narrower): the phone breakpoint. */
export const PHONE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * Where the editors render (decision 16, Preflight ruling 18): `measuring`
 * on the server and until an effect has read the media query, then
 * `phone` or `wide`, following the window's width. An editor renders a
 * neutral frame while measuring and the phone page on a phone, so Monaco
 * never mounts on a phone and nothing is validated there.
 */
export function useEditorViewport(): "measuring" | "phone" | "wide" {
  const [viewport, setViewport] = useState<"measuring" | "phone" | "wide">("measuring");
  useEffect(() => {
    const query = window.matchMedia(PHONE_MEDIA_QUERY);
    const read = () => setViewport(query.matches ? "phone" : "wide");
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);
  return viewport;
}
