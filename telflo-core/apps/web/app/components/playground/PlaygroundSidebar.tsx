import { Link, useLocation } from "react-router";
import { BookOpen, Building2, Home, Lock, Rocket, Settings, Sparkles, Variable, type LucideIcon } from "lucide-react";
import { useLockedAction } from "~/lib/playground/context.js";
import { SAMPLE_ORGANIZATION_NAME } from "~/lib/playground/sample/types.js";
import { useDocsPage } from "~/lib/use-site.js";
import { cn } from "~/lib/utils.js";
import { PlaygroundThemeToggle } from "./PlaygroundThemeToggle.js";

/*
 * The playground's sidebar (D31-1 decision 9): the platform's signed-in
 * Sidebar's items, in its order, in the playground's own frame.
 * Configurations, Flows and Fleet go to the playground's pages; Variables,
 * Permissions, Settings and Learning are locked, each opening the sign-up
 * prompt with its own words. Below them the theme toggle (Settings is locked
 * here) and Docs; the footer is the sample workspace, "Acme Observability –
 * Sample workspace". No organization switcher, user menu or "Contact us"
 * (decision 26). Hidden below `md`: the shell's strip takes its place. The
 * `data-tour-step` anchors are the tour's (Preflight ruling 16).
 */

type NavItem = {
  icon: LucideIcon;
  label: string;
  tourStep: string;
} & ({ path: string; lockedAction?: undefined } | { path?: undefined; lockedAction: string });

/** The signed-in Sidebar's items (navItemsFor, for an admin), in its order. */
export const PLAYGROUND_NAV_ITEMS: readonly NavItem[] = [
  { icon: Home, label: "Configurations", tourStep: "sidebar-home", path: "/playground" },
  { icon: Sparkles, label: "Flows", tourStep: "sidebar-flows", path: "/playground/flows" },
  { icon: Variable, label: "Variables", tourStep: "sidebar-variables", lockedAction: "manage your organization's variables" },
  { icon: Rocket, label: "Fleet", tourStep: "sidebar-fleet-mgmt", path: "/playground/fleet-management" },
  { icon: Building2, label: "Permissions", tourStep: "sidebar-permissions", lockedAction: "manage your team's permissions" },
  { icon: Settings, label: "Settings", tourStep: "sidebar-settings", lockedAction: "change app settings" },
  { icon: BookOpen, label: "Learning", tourStep: "sidebar-learning", lockedAction: "read the learning library" },
];

const railItemBase =
  "relative w-full flex items-center gap-2.5 h-8 px-2.5 rounded-[5px] text-[13px] font-medium transition-colors duration-100";
const railItemInactive =
  "text-muted-foreground hover:text-foreground hover:bg-accent dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-white/[0.06]";
const railItemActive = "bg-accent text-foreground dark:bg-white/[0.08] dark:text-white";
const railItemLocked =
  "text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent dark:text-gray-500 dark:hover:text-gray-300 dark:hover:bg-white/[0.04]";

/** Whether `path` is the page shown: Configurations for the list (the editor is outside the shell), else by prefix. */
function isActivePath(pathname: string, path: string): boolean {
  const current = pathname.replace(/\/+$/, "");
  if (path === "/playground") return current === "/playground";
  return current === path || current.startsWith(`${path}/`);
}

export function PlaygroundSidebar() {
  const location = useLocation();
  const locked = useLockedAction();
  const docsHref = useDocsPage("docs");

  return (
    <div className="hidden h-full w-56 shrink-0 flex-col border-r border-border bg-card dark:border-gray-800 dark:bg-gray-900 md:flex">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center pl-3 pr-1.5">
        <Link to="/playground" aria-label="Playground home">
          <img src="/telflo-logo-dark.svg" alt="Telflo" className="h-7 w-auto dark:hidden" />
          <img src="/telflo-logo-full.svg" alt="Telflo" className="hidden h-7 w-auto dark:block" />
        </Link>
      </div>

      {/* Navigation */}
      <nav aria-label="Playground" className="flex-1 space-y-px overflow-y-auto px-2 py-2">
        <div className="tf-label px-2.5 pb-1.5 pt-1 dark:!text-gray-500">Workspace</div>
        {PLAYGROUND_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          if (item.path === undefined) {
            return (
              <button
                key={item.label}
                type="button"
                data-tour-step={item.tourStep}
                onClick={(event) => locked?.(item.lockedAction, event.currentTarget)}
                className={cn(railItemBase, railItemLocked)}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 truncate">{item.label}</span>
                <Lock aria-hidden="true" className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/60 dark:text-gray-600" />
              </button>
            );
          }
          const isActive = isActivePath(location.pathname, item.path);
          return (
            <Link
              key={item.label}
              to={item.path}
              data-tour-step={item.tourStep}
              aria-current={isActive ? "page" : undefined}
              className={cn(railItemBase, isActive ? railItemActive : railItemInactive)}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand dark:bg-blue-400" />
              )}
              <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Secondary: the theme, and the docs */}
      <div className="space-y-1 border-t border-border px-2 py-2 dark:border-gray-800">
        <PlaygroundThemeToggle className="mx-0.5" />
        {/* The site's docs (D36-1 decision 34): none when TELFLO_DOCS_URL is empty. */}
        {docsHref !== null && (
          <a href={docsHref} target="_blank" rel="noopener noreferrer" className={cn(railItemBase, railItemInactive)}>
            <BookOpen className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate">Docs</span>
          </a>
        )}
      </div>

      {/* Footer: the sample workspace */}
      <div className="border-t border-border px-2 py-2 dark:border-gray-800">
        <div className="flex h-10 w-full items-center gap-2.5 rounded-[5px] px-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] border border-border bg-muted dark:border-gray-700 dark:bg-gray-800">
            <span className="font-mono text-[11px] font-medium text-muted-foreground dark:text-gray-300">
              {SAMPLE_ORGANIZATION_NAME.charAt(0)}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-foreground dark:text-gray-200">{SAMPLE_ORGANIZATION_NAME}</div>
            <div className="truncate font-mono text-[11px] leading-tight text-muted-foreground dark:text-gray-500">
              Sample workspace
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
