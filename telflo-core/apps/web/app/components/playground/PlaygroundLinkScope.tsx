import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useNavigate } from "react-router";

/**
 * A signed-in path's playground equivalent, or null for a link that should
 * behave as it is (D31-1 decision 26, Preflight ruling 20): a fleet's pages
 * (`/fleet-management…`), the editor (`/editor/{id}[/{versionId}]` → the
 * playground editor for that configuration), the flows gallery
 * (`/app/flows…`) and the configurations list (`/app`, the playground's
 * `/playground`: EditorUnavailable's "Back to configurations"; Ruling 288).
 * The path's query and fragment go with it.
 */
export function playgroundPathFor(href: string): string | null {
  if (!href.startsWith("/")) return null;
  const url = new URL(href, "http://playground.invalid");
  const { pathname, search, hash } = url;
  if (pathname === "/fleet-management" || pathname.startsWith("/fleet-management/")) {
    return `/playground${pathname}${search}${hash}`;
  }
  if (pathname === "/app" || pathname === "/app/") {
    return `/playground${search}${hash}`;
  }
  if (pathname === "/app/flows" || pathname.startsWith("/app/flows/")) {
    return `/playground${pathname.slice("/app".length)}${search}${hash}`;
  }
  if (pathname.startsWith("/editor/")) {
    const configurationId = pathname.split("/")[2];
    return configurationId ? `/playground/editor/${configurationId}` : "/playground/editor";
  }
  return null;
}

function mappedHrefFromEvent(event: ReactMouseEvent): string | null {
  const anchor = (event.target as HTMLElement).closest?.("a[href]");
  if (!anchor) return null;
  return playgroundPathFor(anchor.getAttribute("href") ?? "");
}

/*
 * `PlaygroundLinkScope` (ADR 0018): lets the playground reuse
 * the platform's components whose links go into signed-in pages
 * (FleetsTable's fleet links, TokenCell's, FleetHeader's, the editor's
 * published-version links) without forking them. A click on such a link is
 * caught in the capture phase and sent to the matching playground page; a
 * modified or middle click opens the mapped page in a new tab. The DOM
 * keeps the signed-in paths (parity).
 */
export function PlaygroundLinkScope({ children, className }: { children: ReactNode; className?: string }) {
  const navigate = useNavigate();

  return (
    <div
      className={className}
      onClickCapture={(event) => {
        const mapped = mappedHrefFromEvent(event);
        if (!mapped) return;
        event.preventDefault();
        event.stopPropagation();
        // Honour open-in-a-new-tab (cmd/ctrl/shift/alt-click).
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          window.open(mapped, "_blank", "noopener");
          return;
        }
        void navigate(mapped);
      }}
      onAuxClickCapture={(event) => {
        // A middle click fires auxclick, not click: without this it would open the signed-in page.
        if (event.button !== 1) return;
        const mapped = mappedHrefFromEvent(event);
        if (!mapped) return;
        event.preventDefault();
        event.stopPropagation();
        window.open(mapped, "_blank", "noopener");
      }}
    >
      {children}
    </div>
  );
}
