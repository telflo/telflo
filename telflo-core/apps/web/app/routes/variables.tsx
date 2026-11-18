import { Building2, Layers } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";
import { Button } from "~/components/ui/button.js";
import { cn } from "~/lib/utils.js";
import { VARIABLES_NOTE_REFERENCE } from "~/lib/variables.js";

/*
 * `/variables`, the Sidebar's "Variables" (D20 default 19; ADR 0018), not
 * named a vault, since nothing in it is secret (Q88), with its left nav
 * (Q106, Ruling 80; the panel Settings, Org admin and Product admin port):
 * "Variables" (the index) and "Variable groups" (`/variables/groups`, and a
 * group's page under it). Its items are links, not buttons calling navigate:
 * a link opens in a new tab and says which page is shown (`aria-current`).
 * The title, and the note under it (default 20: "Referenced in configurations
 * as `${org:NAME}`."), are fixed words; each page's warning says secrets stay
 * in `${env:NAME}`. The signed-in layout supplies the shell, its mask and its
 * terms dialog.
 *
 * Every address names ids only: the search stays in the page's state (no
 * `?q=`, nothing in the search params), and a variable group's page is
 * `/variables/groups/{id}`, never a name (decision 39).
 */

const NAV_ITEMS = [
  { label: "Variables", path: "/variables", icon: Building2 },
  { label: "Variable groups", path: "/variables/groups", icon: Layers },
] as const;

/** The pathname without a trailing slash. */
function normalized(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** "Variables" only on the index; "Variable groups" on the list and on a group's page. */
function isActiveItem(path: string, pathname: string): boolean {
  const current = normalized(pathname);
  return path === "/variables" ? current === "/variables" : current === path || current.startsWith(`${path}/`);
}

export default function VariablesLayout() {
  const { pathname } = useLocation();
  return (
    <div className="flex h-full">
      {/* Left Sidebar Navigation */}
      <div className="w-52 bg-card border-r border-border flex flex-col">
        <div className="flex h-13 items-center border-b border-border px-4">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">Variables</h2>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-3" aria-label="Variables pages">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActiveItem(item.path, pathname);
            return (
              <Button
                key={item.path}
                asChild
                variant="ghost"
                className={cn(
                  "relative h-8 w-full justify-start gap-1.5 rounded-[5px] px-2.5 text-left text-[13px] font-medium",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Link to={item.path} aria-current={active ? "page" : undefined}>
                  {active && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />}
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {item.label}
                </Link>
              </Button>
            );
          })}
        </nav>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-5 py-5">
          <header>
            <h1 className="text-xl font-semibold tracking-[-0.01em] text-foreground">Variables</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Referenced in configurations as <code className="font-mono text-foreground">{VARIABLES_NOTE_REFERENCE}</code>.
            </p>
          </header>
          <div className="pt-5">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
