import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { PublishedFlow } from "@telflo/contracts";
import type { Route } from "./+types/playground.flows";
import { FlowPicker } from "~/components/flows/FlowPicker.js";
import { Button } from "~/components/ui/button.js";
import { ApiError, getPublishedFlows } from "~/lib/api-client.js";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, playgroundMeta } from "~/lib/playground/meta.js";

/*
 * `/playground/flows`, the playground's flows gallery (ADR 0018; D31-1
 * decision 33), on the platform's FlowPicker and FlowCard with the
 * signed-in gallery's search and filters. Its rules (the spec's Parity
 * Notes):
 * - the flows are the flows table's published ones, through the open flow
 *   read (decision 5), never a copy in the bundle;
 * - they are read in the BROWSER only, after mount (decision 5, Preflight
 *   ruling 1): never a server loader, so the read's per-address limit
 *   counts the visitor, never the web server. The server renders the
 *   spinner;
 * - a read that fails says so in fixed words, with "Try again".
 * A card opens `/playground/flows/:slug`. A flow's name and summary are
 * text inside the shell's mask, never an attribute (ADR 0024).
 */

type GalleryState =
  | { status: "loading" }
  | { status: "loaded"; flows: PublishedFlow[] }
  | { status: "failed"; isRateLimited: boolean };

/** The words of a gallery that couldn't be read. */
export const FLOWS_UNAVAILABLE = "The flows couldn't be loaded.";
export const FLOWS_RATE_LIMITED = "Too many requests for a moment.";

export const handle = PLAYGROUND_HANDLE;

export function meta({ matches }: Route.MetaArgs) {
  return playgroundMeta(matches, PLAYGROUND_TITLES.flows, "/playground/flows");
}

export default function PlaygroundFlows() {
  const navigate = useNavigate();
  const [state, setState] = useState<GalleryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    let current = true;
    getPublishedFlows().then(
      ({ flows }) => {
        if (current) setState({ status: "loaded", flows });
      },
      (error: unknown) => {
        if (current) setState({ status: "failed", isRateLimited: error instanceof ApiError && error.code === "rate_limited" });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900">
      <div className="mx-auto max-w-6xl px-5 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-[-0.01em] text-foreground">Flows</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-[1.5] text-muted-foreground">
            Prebuilt collector configurations, each solving one problem. Start from one instead of an empty canvas — you
            get your own editable copy.
          </p>
        </header>

        {state.status === "loading" ? (
          <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-border bg-card p-12 text-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">Loading flows…</p>
          </div>
        ) : state.status === "failed" ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-14 text-center">
            <p className="text-[13px] text-muted-foreground">{state.isRateLimited ? FLOWS_RATE_LIMITED : FLOWS_UNAVAILABLE}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : state.flows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-14 text-center text-[13px] text-muted-foreground">
            No flows published yet.
          </div>
        ) : (
          <FlowPicker flows={state.flows} onSelect={(flow) => void navigate(`/playground/flows/${flow.slug}`)} />
        )}
      </div>
    </div>
  );
}
