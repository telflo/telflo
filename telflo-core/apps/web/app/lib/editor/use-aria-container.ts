import { useState } from "react";

/**
 * Where every Monaco editor's screen-reader live region goes: Monaco appends
 * it to `<body>` unless given `ariaContainerElement`, and it announces the
 * text (Find reads a line out), outside the replay-blocked container.
 *
 * Monaco keeps ONE live region for the whole page (its aria module's
 * globals): each editor it creates with `ariaContainerElement` builds a new
 * region in that element and sends every later announcement there, from
 * every editor. So the element must outlive every editor: a host per editor,
 * taken out when its viewer closed, left the YAML editor announcing into a
 * detached node. There is one host, `monacoAriaHost()`, shared
 * by every Monaco and never removed. It is replay-blocked itself
 * (`ph-no-capture`), and the app shell puts it in the page once, in a
 * wrapper modal dialogs leave audible (`MonacoAriaHostSlot`, root.tsx).
 *
 * The host is an element React doesn't manage: Monaco deep-clones its
 * options, and React's own properties on an element it renders loop. None on
 * the server, where Monaco never mounts.
 */

let sharedHost: HTMLDivElement | undefined;

/** The one host for every Monaco's live region, made on first use; null on the server. */
export function monacoAriaHost(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (sharedHost === undefined) {
    const host = document.createElement("div");
    host.className = "ph-no-capture";
    host.setAttribute("data-monaco-aria-host", "");
    // Monaco adds a region for each editor it creates and announces in the
    // newest only (the last child): the older ones are dead, so they go.
    new MutationObserver(() => {
      while (host.childElementCount > 1) host.firstElementChild!.remove();
    }).observe(host, { childList: true });
    sharedHost = host;
  }
  return sharedHost;
}

/**
 * The app shell's callback ref (MonacoAriaHostSlot): puts the shared host in its
 * replay-blocked element. Never takes it out: an editor mounted anywhere
 * later announces into it.
 */
export function attachMonacoAriaHost(parent: HTMLElement | null): void {
  const host = monacoAriaHost();
  if (parent === null || host === null || host.parentElement === parent) return;
  parent.appendChild(host);
}

/** The host to pass Monaco as `ariaContainerElement`: the shared one. */
export function useAriaContainer(): { ariaHost: HTMLDivElement | null } {
  const [ariaHost] = useState(monacoAriaHost);
  return { ariaHost };
}
