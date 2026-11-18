import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { PLAYGROUND_SURFACE_CLASS, usePlaygroundSurface } from "~/lib/playground/surface.js";
import { cn } from "~/lib/utils.js";
import { PlaygroundBanner } from "./PlaygroundBanner.js";
import { PlaygroundLinkScope } from "./PlaygroundLinkScope.js";
import { PlaygroundSidebar } from "./PlaygroundSidebar.js";

/** The strip's pages below `md`, where the sidebar is hidden. */
const STRIP_ITEMS = [
  { label: "Configurations", path: "/playground" },
  { label: "Flows", path: "/playground/flows" },
  { label: "Fleet", path: "/playground/fleet-management" },
] as const;

function stripIsActive(pathname: string, path: string): boolean {
  const current = pathname.replace(/\/+$/, "");
  if (path === "/playground") return current === "/playground";
  return current === path || current.startsWith(`${path}/`);
}

/*
 * `PlaygroundShell` (ADR 0018; D31-1 decisions 9, 13, 16 and
 * 26): the signed-in shell's frame with no account behind it. The sidebar,
 * then the banner across the top, a strip of the live pages below `md`
 * (the sidebar is hidden there), and the page. The shell is a playground
 * surface (`usePlaygroundSurface`): `tf-app ph-mask` on its root and
 * `<body>`, autocapture masked, as AppLayout. Links inside reused
 * components go to the playground's pages (`PlaygroundLinkScope`). The
 * Toaster is root's. The provider (lock, visitor, dialogs) is the layout
 * route's, around it.
 */
export function PlaygroundShell({ children, onTakeTour }: { children: ReactNode; onTakeTour?: (() => void) | undefined }) {
  const location = useLocation();
  usePlaygroundSurface();

  return (
    <div className={cn(PLAYGROUND_SURFACE_CLASS, "flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900")}>
      <PlaygroundSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PlaygroundBanner onTakeTour={onTakeTour} />
        <nav aria-label="Playground pages" className="flex items-center gap-4 border-b border-border bg-card px-4 py-2 md:hidden">
          {STRIP_ITEMS.map((item) => {
            const active = stripIsActive(location.pathname, item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "text-[13px] font-medium text-brand"
                    : "text-[13px] font-medium text-muted-foreground hover:text-foreground"
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <main className="flex-1 overflow-auto">
          <PlaygroundLinkScope className="min-h-full">{children}</PlaygroundLinkScope>
        </main>
      </div>
    </div>
  );
}
