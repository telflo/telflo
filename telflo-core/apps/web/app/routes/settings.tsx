import { Bell, Bot, Building2, Code, Palette, User, type LucideIcon } from "lucide-react";
import { Outlet, redirect, useLocation, useNavigate } from "react-router";
import type { Route } from "./+types/settings";
import { Button } from "~/components/ui/button.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { useSite } from "~/lib/use-site.js";
import { cn } from "~/lib/utils.js";

/*
 * The Settings layout (ADR 0018). The Personal group comes first (D21
 * decision 29): Appearance, Account, Editor and Notifications, in that order,
 * each with its icon (no AI item: spec §3.6); Notifications only while the
 * site's TELFLO_EMAIL_NOTIFICATIONS is on (D36-1 decision 58, Q270: off, the
 * open source's default, its page is a 404 too). Then the Organization group
 * with its Organization item (D5 decision 11), shown for everyone, since
 * everyone can create an organization (decision 7), and Service Accounts
 * after it (D22 decision 41, the `Bot` icon), for admins of the active
 * organization only, a personal organization's owner included (its admin:
 * Preflight ruling 19), from `useCurrentUser()`'s role; it stays current on
 * an account's page (a prefix match). Billing and Payment arrive with D28.
 * The signed-in layout route supplies the shell and the session check, so
 * this neither wraps itself in AppLayout nor loads the user. The title is the
 * same on every page.
 */

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Settings - Telflo" },
    { name: "description", content: "Manage your Telflo settings and preferences" },
  ];
}

/** `/settings` has no page of its own: it goes to Appearance. */
export function loader({ request }: Route.LoaderArgs) {
  const { pathname } = new URL(request.url);
  if (pathname.replace(/\/+$/, "") === "/settings") throw redirect("/settings/appearance");
  return null;
}

type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Current on the pages under it too (an account's page under Service Accounts). */
  coversChildren?: true;
};

const PERSONAL_ITEMS: NavItem[] = [
  { path: "/settings/appearance", label: "Appearance", icon: Palette },
  { path: "/settings/account", label: "Account", icon: User },
  { path: "/settings/editor", label: "Editor", icon: Code },
];

const NOTIFICATIONS_ITEM: NavItem = { path: "/settings/notifications", label: "Notifications", icon: Bell };

const ORGANIZATION_ITEM: NavItem = { path: "/settings/organization", label: "Organization", icon: Building2 };

const SERVICE_ACCOUNTS_ITEM: NavItem = { path: "/settings/service-accounts", label: "Service Accounts", icon: Bot, coversChildren: true };

/**
 * The nav's groups: Notifications only with the site's switch on (Q270),
 * Service Accounts for an admin of the active organization only.
 */
function navGroups(isAdmin: boolean, emailNotifications: boolean): { label: string; items: NavItem[] }[] {
  return [
    { label: "Personal", items: emailNotifications ? [...PERSONAL_ITEMS, NOTIFICATIONS_ITEM] : PERSONAL_ITEMS },
    { label: "Organization", items: isAdmin ? [ORGANIZATION_ITEM, SERVICE_ACCOUNTS_ITEM] : [ORGANIZATION_ITEM] },
  ];
}

export default function SettingsRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = useCurrentUser()?.organization.role === "admin";
  const { emailNotifications } = useSite();

  const isActive = (item: NavItem) =>
    location.pathname === item.path || (item.coversChildren === true && location.pathname.startsWith(`${item.path}/`));

  return (
    <div className="flex h-full">
      {/* Left Sidebar Navigation */}
      <div className="w-52 bg-card border-r border-border flex flex-col">
        <div className="flex h-13 items-center border-b border-border px-4">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
            Settings
          </h2>
        </div>
        <nav className="flex-1 space-y-4 px-2 py-3">
          {navGroups(isAdmin, emailNotifications).map((group) => (
            <div key={group.label}>
              <h3 className="tf-label mb-1.5 px-2.5">{group.label}</h3>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item);
                  return (
                    <Button
                      key={item.path}
                      variant="ghost"
                      className={cn(
                        "relative h-8 w-full justify-start gap-1.5 rounded-[5px] px-2.5 text-left text-[13px] font-medium",
                        active
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                      onClick={() => {
                        void navigate(item.path);
                      }}
                    >
                      {active && (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                      )}
                      <Icon className="h-3.5 w-3.5" />
                      {item.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto px-5 py-5">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
