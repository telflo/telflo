import { useEffect } from "react";
import { setAnalyticsMasked } from "~/lib/analytics.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { Sidebar } from "./Sidebar.js";

interface AppLayoutProps {
  children: React.ReactNode;
}

/**
 * The signed-in shell. The layout route's loader supplies the user before
 * render, so there is nothing to wait for and no boot spinner. The
 * org-welcome tour is started by the layout route, which has the loader's
 * data it waits on. The Toaster lives in the root route, not here. While the
 * active organization is being switched, the page gives way to a spinner and
 * the sidebar stays.
 */
export function AppLayout({ children }: AppLayoutProps) {
  const isSwitchingOrganization = useUserStore((state) => state.isSwitchingOrganization);

  // Add app-layout (overflow handling) and tf-app (app design-token scope;
  // on <body> so Radix portals — dialogs, popovers, selects — inherit it)
  // classes to body. ph-mask, on the root and on <body> for the same
  // portals, has session replay mask all the app's text: emails,
  // organization names, pipelines. Autocapture doesn't read it, so it
  // sends no text or attributes while the app is shown; no attribute in
  // here may carry private data, since replay records attributes as they
  // are.
  useEffect(() => {
    document.body.classList.add("app-layout", "tf-app", "ph-mask");
    const releaseAnalyticsMask = setAnalyticsMasked(true);
    return () => {
      document.body.classList.remove("app-layout", "tf-app", "ph-mask");
      releaseAnalyticsMask();
    };
  }, []);

  return (
    <div className="tf-app ph-mask flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        {isSwitchingOrganization ? (
          <div className="flex items-center justify-center h-full">
            <div
              role="status"
              aria-label="Switching organization"
              className="animate-spin rounded-full h-5 w-5 border-2 border-muted-foreground/25 border-t-muted-foreground"
            />
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
