import { useEffect } from "react";

/*
 * The editor's two guards for work not yet saved: Cmd/Ctrl+S, which the page
 * answers by saving, and the browser's `beforeunload` question when the tab
 * closes or reloads.
 */

/** Cmd/Ctrl+S: the page's save (the page listens on `window`; YamlEditor's Monaco has its own command). */
export function isSaveShortcut(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
}

/**
 * While `active`, closing or reloading the tab asks the browser's own
 * question. The page asks while the editor is
 * dirty; a field asks while it holds an edit the store doesn't have yet (the
 * store then reads clean). Listening only while active, so a clean page
 * leaves the page's unloading alone.
 */
export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [active]);
}
