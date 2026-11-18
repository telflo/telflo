import { ArrowLeft, Check, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Flow } from "@telflo/contracts";
import type { Route } from "./+types/app.flows.$slug";
import { fullLabelFor } from "~/components/collector/distribution-icons.js";
import { SignalBadges, SourceBadge } from "~/components/flows/FlowBadges.js";
import { UseFlowDialog } from "~/components/flows/UseFlowDialog.js";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { getFlow } from "~/lib/api-client.js";
import { fetchFlow } from "~/lib/api-client.server.js";
import { flowNotFound, isFlowNotFound, readInBrowser, signInRedirect } from "~/lib/flows/flow-loaders.js";
import { describeFlowRequirements } from "~/lib/flows/flow-requirements.js";
import { useOrgVariables } from "~/lib/org-variables.js";
import { canonicalMeta, publicWebUrlFrom } from "~/lib/seo.js";
import { findDistribution, useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";

/*
 * `/app/flows/:slug`, a flow's page in the signed-in gallery (ADR 0018; D12
 * decisions 5 and 13): the badges, the name and summary, "Use this flow" and
 * the source link, the description as plain paragraphs, "Before you use
 * this", the configuration with its collector, the tags, and its TechArticle
 * JSON-LD. Its rules (the D12 Parity Notes):
 * - no FlowsShell (Preflight ruling 18), and no signed-out "Open in the
 *   editor" (decision 14): the signed-in layout signs a visitor in first;
 * - the collector is the flow's own pin, always, never coerced to another
 *   distribution (decision 14). "Validated against" names the distribution
 *   with the catalogue's label (a built-in map, read before the catalogue
 *   is, as the server renders it);
 * - the canonical link, og:url and the JSON-LD's URLs follow
 *   TELFLO_PUBLIC_WEB_URL, left out without it (D4 decision 5); the
 *   publisher logo is `telflo-logo-full.svg` (Preflight ruling 14);
 * - while the browser refreshes an expired access token, the title is the
 *   gallery's until the flow is read;
 * - "Define these in your organization's variables" marks each name
 *   "defined" or "not defined" (D20 default 28; Preflight ruling 31), from
 *   the organization's variables' names (`useOrgVariables`, the picker's one
 *   shared read): no mark before the organization is known, while they
 *   are read, or when they couldn't be.
 *   A name is text, in the masked shell; the marks are fixed words.
 *
 * Replay (ADR 0024; the Global constraints): a flow's YAML is public, but it
 * is configuration text, so it sits inside the replay-blocked container
 * (`ph-no-capture`), as the editor's text does. The rest of the page's body
 * is text under the signed-in shell's mask, but for the source link, whose
 * `href` is the flow's source URL. The head carries the flow too: its name
 * in the title, its name and summary in the description, Open Graph,
 * Twitter and JSON-LD metas (with its author's name), and its address in
 * the canonical link and og:url; replay records the head unmasked, and
 * PostHog's pageview carries the title. Accepted (D12 Ruling 34): a flow is
 * Telflo's catalogue content, public once published, and a hidden one is
 * seen only by product admins. Nothing of a customer's own is there (the
 * editor's fixed title keeps configuration names out).
 */

/** Default 28's marks beside each organization variable a flow references. */
export const FLOW_VARIABLE_DEFINED = "defined";
export const FLOW_VARIABLE_NOT_DEFINED = "not defined";

export type FlowPageData = { status: "loaded"; flow: Flow } | { status: "refresh_needed" };

/** "View on GitHub" when it is GitHub: the host is all that can be told about an admin's link. */
function sourceLinkLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "github.com") return "View on GitHub";
    if (host === "gitlab.com") return "View on GitLab";
    return "View source";
  } catch {
    return "View source";
  }
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<FlowPageData> {
  let read: Awaited<ReturnType<typeof fetchFlow>>;
  try {
    read = await fetchFlow(request, params.slug);
  } catch (error) {
    if (isFlowNotFound(error)) throw flowNotFound();
    throw error;
  }
  switch (read.status) {
    case "signed_out": {
      // The layout's loader, run beside this one, redirects the same way.
      const { pathname, search } = new URL(request.url);
      throw signInRedirect(pathname, search);
    }
    case "refresh_needed":
      return { status: "refresh_needed" };
    case "loaded":
      return { status: "loaded", flow: read.data };
  }
}

/** The server loader's answer, or, when the access token had expired, the browser client's read. */
export async function clientLoader({ serverLoader, params }: Route.ClientLoaderArgs): Promise<FlowPageData> {
  const data = await serverLoader();
  if (data.status === "loaded") return data;
  return { status: "loaded", flow: (await readInBrowser(() => getFlow(params.slug))).flow };
}
clientLoader.hydrate = true as const;

/** The gallery's title, while the flow is still to be read. */
const WAITING_TITLE = "Flows — prebuilt OpenTelemetry Collector configs - Telflo";

export function meta({ loaderData: data, matches }: Route.MetaArgs) {
  if (!data) return [{ title: "Flow not found - Telflo" }];
  if (data.status !== "loaded") return [{ title: WAITING_TITLE }];
  const { flow } = data;
  const base = publicWebUrlFrom(matches);
  const path = `/app/flows/${flow.slug}`;
  return [
    { title: `${flow.name} - Telflo Flows` },
    { name: "description", content: flow.summary },
    { property: "og:title", content: flow.name },
    { property: "og:description", content: flow.summary },
    { property: "og:type", content: "article" },
    ...canonicalMeta(matches, path),
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: flow.name },
    { name: "twitter:description", content: flow.summary },
    {
      // TechArticle rather than SoftwareSourceCode: the page's value is the
      // explanation of the configuration, and the YAML its example.
      "script:ld+json": {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: flow.name,
        description: flow.summary,
        ...(base === undefined ? {} : { url: `${base}${path}` }),
        ...(flow.authorName ? { author: { "@type": "Person", name: flow.authorName } } : {}),
        publisher: {
          "@type": "Organization",
          name: "Telflo",
          ...(base === undefined
            ? {}
            : { logo: { "@type": "ImageObject", url: `${base}/telflo-logo-full.svg` } }),
        },
      },
    },
  ];
}

export default function FlowDetailPage({ loaderData }: Route.ComponentProps) {
  // Waiting on the client loader's refresh; the layout shows its placeholder meanwhile.
  if (loaderData.status !== "loaded") return null;
  return <FlowDetail flow={loaderData.flow} />;
}

function FlowDetail({ flow }: { flow: Flow }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { distributions } = useCollectorDistributions();
  const requirements = describeFlowRequirements(flow.yaml);
  const orgVariables = useOrgVariables();
  // Marked only once the active organization's names are read: before the user store has the organization (a full
  // page load's first render), while they load, or when they couldn't be, nothing is said.
  const marksKnown = orgVariables.known;
  const definedNames = new Set(orgVariables.names.map((variable) => variable.name));
  const distributionLabel = fullLabelFor(
    flow.collectorDistribution,
    findDistribution(distributions, flow.collectorDistribution)?.label,
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <article className="mx-auto max-w-3xl px-5 py-8">
        <Link
          to="/app/flows"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All flows
        </Link>

        <header className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <SignalBadges signals={flow.signals} />
            <SourceBadge source={flow.source} authorName={flow.authorName} />
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.01em] text-foreground">{flow.name}</h1>
          <p className="mt-2 text-[15px] leading-[1.55] text-muted-foreground">{flow.summary}</p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button onClick={() => setDialogOpen(true)}>Use this flow</Button>
            {/* Only when the flow has an external home: a link to nowhere is worse than none. */}
            {flow.sourceUrl && (
              <a
                href={flow.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {sourceLinkLabel(flow.sourceUrl)}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </header>

        {/* The description is only ever paragraphs, so blank lines split it; no renderer. */}
        <div className="mt-8 space-y-4">
          {flow.description.split("\n\n").map((paragraph, i) => (
            <p key={i} className="text-[14px] leading-[1.65] text-muted-foreground">
              {paragraph}
            </p>
          ))}
        </div>

        {(requirements.exporters.length > 0 || requirements.envVars.length > 0 || requirements.orgVars.length > 0) && (
          <section className="mt-8 rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-medium text-foreground">Before you use this</h2>
            {requirements.exporters.length > 0 && (
              <div className="mt-3">
                <p className="text-[12px] text-muted-foreground">Sends data to</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {requirements.exporters.map((exporter) => (
                    <Badge key={exporter} variant="outline">
                      {exporter}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {requirements.envVars.length > 0 && (
              <div className="mt-3">
                <p className="text-[12px] text-muted-foreground">You&apos;ll need to set these before it runs</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {requirements.envVars.map((variable) => (
                    <code
                      key={variable}
                      className="rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                    >
                      {variable}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {requirements.orgVars.length > 0 && (
              <div className="mt-3">
                <p className="text-[12px] text-muted-foreground">
                  Define these in your organization&apos;s variables — an unset one is delivered to the collector
                  as-is, not as an error
                </p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {requirements.orgVars.map((variable) => (
                    <span key={variable} className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5">
                      <code className="font-mono text-[11px] text-foreground">{variable}</code>
                      {marksKnown &&
                        (definedNames.has(variable) ? (
                          <span className="inline-flex items-center gap-0.5 text-[11px] text-pass">
                            <Check className="h-3 w-3" aria-hidden="true" />
                            {FLOW_VARIABLE_DEFINED}
                          </span>
                        ) : (
                          <span className="text-[11px] text-warn">{FLOW_VARIABLE_NOT_DEFINED}</span>
                        ))}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        <section className="mt-8">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">The configuration</h2>
            <Badge variant="outline">collector v{flow.collectorVersion}</Badge>
          </div>
          {/* `ph-no-capture`: replay blocks the configuration's text, as it blocks the editor's. */}
          <div className="ph-no-capture">
            <pre className="overflow-x-auto rounded-lg border border-border bg-card p-4 text-[12px] leading-[1.55]">
              <code className="font-mono text-foreground">{flow.yaml}</code>
            </pre>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            Validated against {distributionLabel} v{flow.collectorVersion}. Fill in the{" "}
            <code className="font-mono">${"{env:…}"}</code> placeholders before running it.
          </p>
        </section>

        {flow.tags.length > 0 && (
          <div className="mt-8 flex flex-wrap items-center gap-1.5 border-t border-border pt-4">
            {flow.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </article>

      <UseFlowDialog flow={flow} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
