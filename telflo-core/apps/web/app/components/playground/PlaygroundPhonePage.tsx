import type { ReactNode } from "react";
import { Link } from "react-router";
import { Monitor } from "lucide-react";
import { PLAYGROUND_SURFACE_CLASS, useEditorViewport, usePlaygroundSurface } from "~/lib/playground/surface.js";
import { cn } from "~/lib/utils.js";

export const PHONE_PAGE_TEXT = "The editor is best viewed on larger screens such as laptop or computer browsers.";

/** Where the phone page's link goes: the playground editor's back to the list, the public editor's to sign-in. */
export interface PhoneBackLink {
  to: string;
  label: string;
}

export const BACK_TO_PLAYGROUND: PhoneBackLink = { to: "/playground", label: "Back to playground" };
/** The public editor's (D36-1 decision 23): the app has no home page of its own, so sign-in, labelled so. */
export const BACK_TO_SIGN_IN: PhoneBackLink = { to: "/login", label: "Go to sign in" };

/*
 * The "best viewed on larger screens" page (D31-1 decision 16,
 * Ruling 276), in place of the full-screen editor and the blank public
 * editor below `md` (767 px and narrower): the logo, a monitor, its
 * sentence and one link back.
 */
export function PlaygroundPhonePage({ back }: { back: PhoneBackLink }) {
  return (
    <div className={cn(PLAYGROUND_SURFACE_CLASS, "flex min-h-screen items-center justify-center bg-gray-50 p-8 dark:bg-gray-900")}>
      <div className="max-w-sm space-y-5 text-center">
        <Link to={back.to} className="inline-flex items-center justify-center gap-2">
          <img src="/telflo-logo-dark.svg" alt="Telflo" className="h-8 w-auto dark:hidden" />
          <img src="/telflo-logo-full.svg" alt="Telflo" className="hidden h-8 w-auto dark:block" />
        </Link>
        <Monitor aria-hidden="true" className="mx-auto h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
        <p className="text-[13px] text-muted-foreground">{PHONE_PAGE_TEXT}</p>
        <Link to={back.to} className="inline-block text-[13px] text-brand hover:underline">
          {back.label}
        </Link>
      </div>
    </div>
  );
}

/*
 * The editors' frame (decisions 13 and 16, Preflight rulings 13 and 18),
 * for the full-screen playground editor (Task 2) and the blank public
 * editor (Task 5): a playground surface (masked as the signed-in shell),
 * which renders a neutral frame on the server and until the browser has
 * measured, then the phone page below `md` and `children` otherwise. So
 * Monaco never mounts on a phone, and nothing is validated there.
 */
export function PlaygroundEditorSurface({ back, children }: { back: PhoneBackLink; children: ReactNode }) {
  usePlaygroundSurface();
  const viewport = useEditorViewport();
  if (viewport === "phone") return <PlaygroundPhonePage back={back} />;
  if (viewport === "measuring") {
    return <div className={cn(PLAYGROUND_SURFACE_CLASS, "h-screen bg-gray-50 dark:bg-gray-900")} aria-busy="true" />;
  }
  return <>{children}</>;
}
