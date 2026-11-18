import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { useTfAppSurface } from "~/hooks/useTfAppSurface.js";
import { setAnalyticsMasked } from "~/lib/analytics.js";

/**
 * Shared shell for the standalone auth screens (login, register, forgot/
 * reset password, accept-invite). Carries the `tf-app` scope class itself
 * since these pages render outside AppLayout.
 *
 * Left rail always sits on the dark end of the active theme's gray ramp,
 * matching the in-app sidebar. Its text classes are the ones Dark already
 * showed through app.css's `html.dark .text-gray-600` and `-700` remaps
 * (gray-400 and gray-300), so the rail reads the same in Light (D21
 * Preflight ruling 22, B4).
 *
 * The app has no home page of its own (D36-1 decisions 20 and 23): the
 * logo and `showHomeLink`'s link go to sign-in, and the rail names no
 * site.
 */
export function AuthShell({
  children,
  showHomeLink = false,
}: {
  children: ReactNode;
  showHomeLink?: boolean;
}) {
  // Also scope <body> so Radix portals (selects, dialogs) opened from auth
  // screens inherit the app tokens.
  useTfAppSurface();
  // ph-mask, on the root and on <body> for the same portals, has session
  // replay mask all these screens' text: addresses, organization names (D4
  // Ruling 14). Autocapture doesn't read it, so it sends no text or
  // attributes while these screens are shown (D4 Ruling 16); no attribute in
  // here may carry private data, since replay records attributes as they are.
  useEffect(() => {
    document.body.classList.add("ph-mask");
    const releaseAnalyticsMask = setAnalyticsMasked(true);
    return () => {
      document.body.classList.remove("ph-mask");
      releaseAnalyticsMask();
    };
  }, []);
  // No theme is applied here after the first paint: <html>'s class is already
  // in the server's HTML: these screens' routes are marked `handle = { theme:
  // "remembered" }`, so root's Layout renders the theme this browser was last
  // told (D21 decision 22; lib/theme.ts).

  return (
    <div className="tf-app ph-mask flex min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Brand rail */}
      <aside className="hidden w-[400px] shrink-0 flex-col justify-between border-r border-gray-800 bg-gray-900 p-8 lg:flex">
        <Link to="/login" className="self-start">
          <img src="/telflo-logo-full.svg" alt="Telflo" className="h-7 w-auto" />
        </Link>

        <div className="space-y-6">
          {/* Pipeline ledger — one row per signal, node-type colors */}
          <div
            aria-hidden
            className="select-none space-y-2 font-mono text-[11px] leading-5 text-gray-400"
          >
            {[
              { signal: "TRACES", stages: ["otlp", "tail_sampling", "otlphttp"] },
              { signal: "METRICS", stages: ["hostmetrics", "batch", "prometheus"] },
              { signal: "LOGS", stages: ["filelog", "transform", "kafka"] },
            ].map((row) => (
              <div key={row.signal} className="flex items-center gap-2">
                <span className="w-14 text-[10px] tracking-[0.1em] text-gray-400">
                  {row.signal}
                </span>
                {row.stages.map((stage, i) => (
                  <span key={stage} className="flex items-center gap-2">
                    {i > 0 && <span className="text-gray-300">▸</span>}
                    <span
                      className={
                        /* Fixed dark-variant node hues: the rail is always
                           dark, so these must not flip with html.dark. */
                        i === 0
                          ? "text-[#5f95ef]"
                          : i === 1
                            ? "text-[#a685ea]"
                            : "text-[#45b477]"
                      }
                    >
                      {stage}
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>

          <p className="max-w-[32ch] text-[13px] leading-relaxed text-gray-400">
            The control plane for OpenTelemetry collectors — build, test, and
            roll out pipeline configurations from one place.
          </p>
        </div>

        {/* Keeps the ledger and its line in the rail's middle, as the site's name below them once did. */}
        <div aria-hidden className="h-4" />
      </aside>

      {/* Form pane */}
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <img
            src="/telflo-logo-dark.svg"
            alt="Telflo"
            className="mx-auto mb-6 h-8 w-auto dark:hidden lg:hidden"
          />
          <img
            src="/telflo-logo-full.svg"
            alt="Telflo"
            className="mx-auto mb-6 hidden h-8 w-auto dark:block lg:!hidden"
          />
          {children}
          {showHomeLink && (
            <div className="mt-6 text-center">
              <Link
                to="/login"
                className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                ← Back to sign in
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
