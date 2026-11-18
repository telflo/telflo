import { useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { mayInviteFrom, type CurrentUserResponse, type RegistrationMode } from "@telflo/contracts";
import {
  Home,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Check,
  Variable,
  Building2,
  Rocket,
  BookOpen,
  Shield,
  Sparkles,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ContactUsDialog } from "~/components/feedback/ContactUsDialog.js";
import { OrganizationLogo } from "~/components/org/OrganizationLogo.js";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog.js";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover.js";
import { useSwitchOrganization } from "~/lib/organizations.js";
import { cn } from "~/lib/utils.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import { useUiStateStore } from "~/lib/stores/ui-state-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { LOGOUT_FAILED_MESSAGE, useLogout } from "~/lib/use-logout.js";
import { useDocsPage, useSite } from "~/lib/use-site.js";

/*
 * The signed-in sidebar (ADR 0018; the D2a Parity Notes' Appearance table):
 * telflo's logo files, an aria-label on the collapse button, and nav items
 * as links with aria-current. "Contact us" (D29 decision 40) opens
 * ContactUsDialog; its `title` only when the rail is collapsed, a fixed
 * word, as Docs'. The organization's logo (D23-2 decision 51) is an
 * `<img alt="">` inside `ph-no-capture`, never named by the organization,
 * and falls back to the initial if it fails to load. Variables is at
 * `/variables` (D20 default 19). Switching (D5) completes before going to
 * `/app`, rather than after; see useSwitchOrganization. While the editor
 * holds unsaved text, switching is refused, and so is Logout (D8 decision
 * 15).
 */

/* The rail follows the app theme: card surface in light, carbon/navy
 * rail in dark-family themes (dark: variants preserve the carbon look;
 * the navy token remap tints it navy). */
const railItemBase =
  "relative w-full flex items-center gap-2.5 h-8 px-2.5 rounded-[5px] text-[13px] font-medium transition-colors duration-100";
const railItemInactive =
  "text-muted-foreground hover:text-foreground hover:bg-accent dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-white/[0.06]";
const railItemActive =
  "bg-accent text-foreground dark:bg-white/[0.08] dark:text-white";

type NavItem = { icon: LucideIcon; label: string; path: string };

/**
 * The unsaved-changes acknowledgement: the switch, or the sign-out,
 * is refused, and there is no "anyway", since silently abandoning unsaved
 * YAML would be a data loss path. Closing the dialog is all it does.
 */
function UnsavedChangesRefusal({
  open,
  onOpenChange,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether the editor holds unsaved text, read when the person acts, as the
 * editor's navigation guard reads it. Anywhere but the editor it is clean:
 * the editor page forgets its text when it is left.
 */
function editorIsDirty(): boolean {
  return selectIsDirty(useEditorStore.getState());
}

/**
 * The nav items, in order, with their visibility rules evaluated
 * from the active organization's role: Fleet for any member, Permissions for
 * an admin; and Product Admin for a product admin (D12 decision 3), from
 * `/me`'s flag, which the layout re-seeds when an operator sets or clears it.
 * Permissions also needs an organization that may invite on this site: a
 * personal workspace shows it only while registration is open (D36-1
 * decision 57, Q269); `/org-admin` itself stays reachable by its address,
 * for invitations or members left from when the site was open.
 */
function navItemsFor(
  organization: CurrentUserResponse["organization"],
  isProductAdmin: boolean,
  registration: RegistrationMode,
): NavItem[] {
  const navItems: NavItem[] = [
    { icon: Home, label: "Configurations", path: "/app" },
    { icon: Sparkles, label: "Flows", path: "/app/flows" },
    // D20 default 19: "Variables", since nothing in it is secret (Q88).
    { icon: Variable, label: "Variables", path: "/variables" },
    // Every role is a membership of the active organization.
    { icon: Rocket, label: "Fleet", path: "/fleet-management" },
  ];
  if (organization.role === "admin" && mayInviteFrom(registration, organization.type)) {
    navItems.push({ icon: Building2, label: "Permissions", path: "/org-admin" });
  }
  if (isProductAdmin) {
    navItems.push({ icon: Shield, label: "Product Admin", path: "/product-admin" });
  }
  navItems.push({ icon: Settings, label: "Settings", path: "/settings" });
  navItems.push({ icon: BookOpen, label: "Learning", path: "/library" });
  return navItems;
}

export function Sidebar() {
  const location = useLocation();
  const logout = useLogout();
  const collapsed = useUiStateStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStateStore((s) => s.toggleSidebar);
  const current = useCurrentUser();
  const docsHref = useDocsPage("docs");
  const site = useSite();
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [switchRefusedOpen, setSwitchRefusedOpen] = useState(false);
  const [logoutRefusedOpen, setLogoutRefusedOpen] = useState(false);
  const [contactUsOpen, setContactUsOpen] = useState(false);
  const contactUsButton = useRef<HTMLButtonElement>(null);
  const switchTo = useSwitchOrganization();

  const organization = current?.organization ?? null;
  const organizations = current?.organizations ?? [];
  const userEmail = current?.user.email ?? null;

  // A failed logout leaves the session and the store intact and says so
  // (D2a Parity Notes); see useLogout. With unsaved text in the editor it
  // never starts: signing out first would meet the editor's navigation
  // guard, whose Save could only fail (D8 decision 15).
  const handleLogout = async () => {
    setOrgMenuOpen(false);
    if (editorIsDirty()) {
      setLogoutRefusedOpen(true);
      return;
    }
    if (!(await logout())) toast.error(LOGOUT_FAILED_MESSAGE);
  };

  // With unsaved text in the editor the switch is never sent: the person
  // saves first (D8 decision 15).
  const handleOrgSwitch = (organizationId: string) => {
    if (editorIsDirty()) {
      setSwitchRefusedOpen(true);
      return;
    }
    void switchTo(organizationId);
  };

  const isActivePath = (path: string) => {
    if (path === "/app") {
      return location.pathname === "/app";
    }
    return location.pathname.startsWith(path);
  };

  return (
    <div
      className={cn(
        "h-screen bg-card border-r border-border dark:bg-gray-900 dark:border-gray-800 flex flex-col transition-all duration-200 ease-out",
        collapsed ? "w-12" : "w-56",
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "h-12 flex items-center shrink-0",
          collapsed ? "justify-center" : "justify-between pl-3 pr-1.5",
        )}
      >
        {!collapsed && (
          <>
            <img
              src="/telflo-logo-dark.svg"
              alt="Telflo"
              className="h-7 w-auto dark:hidden"
            />
            <img
              src="/telflo-logo-full.svg"
              alt="Telflo"
              className="h-7 w-auto hidden dark:block"
            />
          </>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          className="p-1.5 rounded-[5px] text-muted-foreground hover:text-foreground hover:bg-accent dark:text-gray-500 dark:hover:text-gray-200 dark:hover:bg-white/[0.06] transition-colors"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className={cn("flex-1 overflow-y-auto py-2 space-y-px", collapsed ? "px-1.5" : "px-2")}>
        {!collapsed && (
          <div className="tf-label px-2.5 pb-1.5 pt-1 dark:!text-gray-500">
            Workspace
          </div>
        )}
        {organization &&
          navItemsFor(organization, current?.isProductAdmin === true, site.registration).map((item) => {
            const Icon = item.icon;
            const isActive = isActivePath(item.path);

            return (
              <Link
                key={item.path}
                to={item.path}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  railItemBase,
                  isActive ? railItemActive : railItemInactive,
                  collapsed && "justify-center px-0",
                )}
                title={collapsed ? item.label : undefined}
              >
                {isActive && !collapsed && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-brand dark:bg-blue-400" />
                )}
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                {!collapsed && <span className="min-w-0 truncate">{item.label}</span>}
              </Link>
            );
          })}
      </nav>

      {/* Secondary: docs + contact */}
      <div className={cn("py-2 space-y-px border-t border-border dark:border-gray-800", collapsed ? "px-1.5" : "px-2")}>
        {/* The site's docs (D36-1 decision 34): none when TELFLO_DOCS_URL is empty. */}
        {docsHref !== null && (
          <a
            href={docsHref}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(railItemBase, railItemInactive, collapsed && "justify-center px-0")}
            title={collapsed ? "Docs" : undefined}
          >
            <BookOpen className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            {!collapsed && <span className="min-w-0 truncate">Docs</span>}
          </a>
        )}
        <button
          ref={contactUsButton}
          type="button"
          onClick={() => setContactUsOpen(true)}
          className={cn(railItemBase, railItemInactive, collapsed && "justify-center px-0")}
          title={collapsed ? "Contact us" : undefined}
        >
          <MessageSquare className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {!collapsed && <span className="min-w-0 truncate">Contact us</span>}
        </button>
      </div>

      <ContactUsDialog open={contactUsOpen} onOpenChange={setContactUsOpen} returnFocusTo={contactUsButton} />

      {/* Footer: org switcher (logout lives inside its popover). Every
        * signed-in user has an organization (D1b), so it always renders. */}
      {organization && (
        <div className={cn("border-t border-border dark:border-gray-800 py-2", collapsed ? "px-1.5" : "px-2")}>
          <Popover open={orgMenuOpen} onOpenChange={setOrgMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-tour-step="org-switcher"
                className={cn(
                  "w-full flex items-center gap-2.5 rounded-[5px] text-left transition-colors h-10",
                  "hover:bg-accent dark:hover:bg-white/[0.06]",
                  collapsed ? "justify-center px-0" : "px-2",
                )}
                // Session replay records attributes as they are, so no
                // attribute here carries it: the tooltip says what the button
                // does, and the name is text, which replay masks (D4 Ruling
                // 16).
                title="Switch organization"
              >
                <OrganizationLogo
                  organization={organization}
                  imageClassName="h-6 w-6 rounded-[5px] object-contain shrink-0 bg-white/90 p-px"
                  fallback={
                    <div className="h-6 w-6 rounded-[5px] border border-border bg-muted dark:border-gray-700 dark:bg-gray-800 flex items-center justify-center shrink-0">
                      <span className="font-mono text-[11px] font-medium text-muted-foreground dark:text-gray-300">
                        {organization.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  }
                />
                {collapsed && <span className="sr-only">{organization.name}</span>}
                {!collapsed && (
                  <>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-foreground dark:text-gray-200 truncate">
                        {organization.name}
                      </div>
                    </div>
                    <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground dark:text-gray-500 shrink-0" />
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="right"
              align="end"
              className="w-64 p-1"
            >
              <div className="tf-label px-2 pt-1.5 pb-1">Account</div>
              <div className="px-2 pb-2 text-[13px] text-foreground truncate">
                {userEmail ?? "—"}
              </div>
              <div className="border-t border-border mb-1" />
              <div className="tf-label px-2 pt-1.5 pb-1">Organizations</div>
              {organizations.map((listed) => {
                const isCurrent = listed.id === organization.id;
                return (
                  <button
                    key={listed.id}
                    type="button"
                    onClick={() => {
                      setOrgMenuOpen(false);
                      if (!isCurrent) handleOrgSwitch(listed.id);
                    }}
                    className="w-full flex items-center gap-2.5 px-2 py-1 min-h-8 rounded-[5px] text-left hover:bg-accent transition-colors"
                  >
                    <OrganizationLogo
                      organization={listed}
                      imageClassName="h-5 w-5 rounded-[4px] object-contain shrink-0"
                      fallback={
                        <div className="h-5 w-5 rounded-[4px] border border-border bg-muted flex items-center justify-center shrink-0">
                          <span className="font-mono text-[10px] font-medium text-muted-foreground">
                            {listed.name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium truncate">
                        {listed.name}
                      </div>
                      {/* The user's own workspace, under its name as the version
                        * picker's detail line sits under a version's title. */}
                      {listed.type === "personal" && (
                        <div className="text-[10px] text-muted-foreground">Personal Org</div>
                      )}
                    </div>
                    {isCurrent && (
                      <Check className="h-3.5 w-3.5 text-brand shrink-0" />
                    )}
                  </button>
                );
              })}
              <div className="border-t border-border mt-1 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    void handleLogout();
                  }}
                  className="w-full flex items-center gap-2 px-2 h-8 rounded-[5px] text-left text-[13px] text-muted-foreground hover:text-fail hover:bg-fail-soft transition-colors"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Logout
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}

      <UnsavedChangesRefusal
        open={switchRefusedOpen}
        onOpenChange={setSwitchRefusedOpen}
        description="You have unsaved changes in the editor. Save them before switching organizations."
      />
      <UnsavedChangesRefusal
        open={logoutRefusedOpen}
        onOpenChange={setLogoutRefusedOpen}
        description="You have unsaved changes in the editor. Save them before signing out."
      />
    </div>
  );
}
