import { useId, useState } from "react";
import { useNavigate } from "react-router";
import type { Flow } from "@telflo/contracts";
import type { Route } from "./+types/app.flows";
import { FlowPicker } from "~/components/flows/FlowPicker.js";
import { Switch } from "~/components/ui/switch.js";
import { getFlows } from "~/lib/api-client.js";
import { fetchFlows } from "~/lib/api-client.server.js";
import { readInBrowser, signInRedirect } from "~/lib/flows/flow-loaders.js";
import { canonicalMeta } from "~/lib/seo.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * `/app/flows`, the signed-in flows gallery. Its rules:
 * - no FlowsShell: the signed-in layout wraps the page in AppLayout, and
 *   signs a visitor without a session in first, back to this page
 *   afterwards;
 * - the canonical link and og:url follow TELFLO_PUBLIC_WEB_URL, left out
 *   without it;
 * - a product admin's gallery lists the published flows, as everyone's,
 *   until their "Show hidden flows" switch is on.
 *
 * The flows are read by the server loader with the visitor's cookie, so the
 * gallery is in the server's render; the API decides which (the hidden ones
 * too for a product admin, `published: false`). The switch is the page's own
 * state, off on every visit, in neither the address nor storage. An expired
 * access token can't be refreshed on the server, so the loader says so and the
 * client loader reads again through the browser client, whose interceptor
 * refreshes (the signed-in layout's pattern).
 */

export type FlowsGalleryData = { status: "loaded"; flows: Flow[] } | { status: "refresh_needed" };

const TITLE = "Flows — prebuilt OpenTelemetry Collector configs";
const DESCRIPTION =
  "Ready-to-run OpenTelemetry Collector configurations for cost control, sampling, Kubernetes, PII redaction, and migration. Open any flow in Telflo's visual editor.";

export function meta({ matches }: Route.MetaArgs) {
  return [
    { title: `${TITLE} - Telflo` },
    { name: "description", content: DESCRIPTION },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:type", content: "website" },
    ...canonicalMeta(matches, "/app/flows"),
    { name: "twitter:card", content: "summary_large_image" },
  ];
}

export async function loader({ request }: Route.LoaderArgs): Promise<FlowsGalleryData> {
  const read = await fetchFlows(request);
  switch (read.status) {
    case "signed_out": {
      // The layout's loader, run beside this one, redirects the same way.
      const { pathname, search } = new URL(request.url);
      throw signInRedirect(pathname, search);
    }
    case "refresh_needed":
      return { status: "refresh_needed" };
    case "loaded":
      return { status: "loaded", flows: read.data };
  }
}

/**
 * On hydration and every client-side navigation: the server loader's answer,
 * and when the access token had expired, the browser client's read, which
 * refreshes once (one refresh in flight with the layout's). A session that
 * is over sends the browser to sign in, as the layout's client loader does.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs): Promise<FlowsGalleryData> {
  const data = await serverLoader();
  if (data.status === "loaded") return data;
  return { status: "loaded", flows: (await readInBrowser(getFlows)).flows };
}
clientLoader.hydrate = true as const;

/**
 * The product admin's "Show hidden flows" switch, sized to the filter row's
 * controls. Its name is the visible static text it points to (no
 * flow's text in an attribute).
 */
function ShowHiddenFlowsSwitch({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (next: boolean) => void }) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 sm:ml-auto">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-labelledby={labelId} />
      <label id={labelId} htmlFor={id} className="cursor-pointer select-none text-[13px] text-muted-foreground">
        Show hidden flows
      </label>
    </div>
  );
}

export default function FlowsGalleryPage({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate();
  const isProductAdmin = useCurrentUser()?.isProductAdmin === true;
  const [showHidden, setShowHidden] = useState(false);
  // Waiting on the client loader's refresh; the layout shows its placeholder meanwhile.
  if (loaderData.status !== "loaded") return null;
  const flows = isProductAdmin && showHidden ? loaderData.flows : loaderData.flows.filter((flow) => flow.published);
  const toolbar = isProductAdmin ? <ShowHiddenFlowsSwitch checked={showHidden} onCheckedChange={setShowHidden} /> : null;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="mx-auto max-w-6xl px-5 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-[-0.01em] text-foreground">Flows</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-[1.5] text-muted-foreground">
            Prebuilt collector configurations, each solving one problem. Researched against the component docs,
            validated with the real collector binary, and ready to open in the editor.
          </p>
        </header>

        {flows.length === 0 ? (
          <>
            {toolbar && <div className="mb-4 flex justify-end">{toolbar}</div>}
            <div className="rounded-lg border border-dashed border-border py-14 text-center text-[13px] text-muted-foreground">
              No flows published yet.
            </div>
          </>
        ) : (
          <FlowPicker
            flows={flows}
            onSelect={(flow) => void navigate(`/app/flows/${flow.slug}`)}
            toolbar={toolbar}
          />
        )}
      </div>
    </div>
  );
}
