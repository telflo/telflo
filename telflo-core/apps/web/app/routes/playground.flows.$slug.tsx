import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { PublishedFlow } from "@telflo/contracts";
import type { Route } from "./+types/playground.flows.$slug";
import { SignalBadges, SourceBadge } from "~/components/flows/FlowBadges.js";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { ApiError, getPublishedFlow } from "~/lib/api-client.js";
import { describeFlowRequirements } from "~/lib/flows/flow-requirements.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, playgroundMeta } from "~/lib/playground/meta.js";

/*
 * `/playground/flows/:slug`, a flow's page in the playground (ADR 0018;
 * D31-1 decisions 6 and 33): the badges, the name and summary, "Use this
 * flow", the description as plain paragraphs, "Before you use this" (the
 * exporters and the environment variables), the configuration with its pin,
 * read-only, and the tags. Its rules (the spec's Parity Notes):
 * - the flow is the flows table's, through the open slug read (decision 5),
 *   read in the BROWSER only, after mount (never a server loader, so its
 *   per-address limit counts the visitor). A slug the read doesn't answer
 *   (unknown or hidden: one 404, `flow_not_found`) is "Flow not found."; any
 *   other failure says so in fixed words, with "Try again";
 * - the pin is the flow's own, always, never coerced to another
 *   distribution (D12 decision 14); the provenance badge is the platform's
 *   (`SourceBadge`);
 * - "Use this flow" opens the playground's one sign-up prompt (decision 6,
 *   the lock at the button).
 *
 * Replay (ADR 0024, decision 39): the flow's YAML is public, but it is
 * configuration text, so it sits inside `ph-no-capture`, as on the
 * signed-in page; the rest is text inside the shell's mask. The title is
 * fixed words, never the flow's name (decision 17).
 */

/** The sign-up prompt's words for "Use this flow" (decision 6). */
export const USE_FLOW_LOCKED_ACTION = "start from this flow";

/** The words of a flow's page that couldn't be read. */
export const FLOW_NOT_FOUND = "Flow not found.";
export const FLOW_UNAVAILABLE = "This flow couldn't be loaded.";
export const FLOW_RATE_LIMITED = "Too many requests for a moment.";

type FlowPageState =
  | { status: "loading" }
  | { status: "loaded"; flow: PublishedFlow }
  | { status: "not_found" }
  | { status: "failed"; isRateLimited: boolean };

export const handle = PLAYGROUND_HANDLE;

export function meta({ matches, params }: Route.MetaArgs) {
  return playgroundMeta(matches, PLAYGROUND_TITLES.flow, `/playground/flows/${encodeURIComponent(params.slug)}`);
}

export default function PlaygroundFlow() {
  const slug = useParams().slug ?? "";
  const [state, setState] = useState<FlowPageState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    getPublishedFlow(slug).then(
      ({ flow }) => {
        if (current) setState({ status: "loaded", flow });
      },
      (error: unknown) => {
        if (!current) return;
        if (error instanceof ApiError && error.code === "flow_not_found") setState({ status: "not_found" });
        else setState({ status: "failed", isRateLimited: error instanceof ApiError && error.code === "rate_limited" });
      },
    );
    return () => {
      current = false;
    };
  }, [slug, attempt]);

  if (state.status === "loaded") return <FlowDetail flow={state.flow} />;

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900">
      <div className="mx-auto max-w-3xl px-5 py-14 text-center">
        {state.status === "loading" ? (
          <div className="flex flex-col items-center gap-2.5">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">Loading flow…</p>
          </div>
        ) : state.status === "not_found" ? (
          <>
            <p className="text-[13px] text-muted-foreground">{FLOW_NOT_FOUND}</p>
            <Link to="/playground/flows" className="mt-3 inline-block text-[13px] text-brand hover:underline">
              Back to flows
            </Link>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <p className="text-[13px] text-muted-foreground">{state.isRateLimited ? FLOW_RATE_LIMITED : FLOW_UNAVAILABLE}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
            <Link to="/playground/flows" className="text-[13px] text-brand hover:underline">
              Back to flows
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function FlowDetail({ flow }: { flow: PublishedFlow }) {
  const locked = useLockedAction();
  const requirements = describeFlowRequirements(flow.yaml);

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900">
      <article className="mx-auto max-w-3xl px-5 py-8">
        <Link
          to="/playground/flows"
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
          <div className="mt-5">
            {/* Locked at the button (decision 24): the playground has no account to own a copy. */}
            <Button onClick={(event) => locked?.(USE_FLOW_LOCKED_ACTION, event.currentTarget)}>Use this flow</Button>
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

        {(requirements.exporters.length > 0 || requirements.envVars.length > 0) && (
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
    </div>
  );
}
