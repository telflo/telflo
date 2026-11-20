import { useEffect, useState } from "react";
import type { Flow } from "@telflo/contracts";
import { getFlows } from "~/lib/api-client.js";

/** Where a read of the flows stands: under way (or not started), answered, or failed. */
export type FlowsReadStatus = "loading" | "loaded" | "failed";

export interface FlowsRead {
  /** The published flows, in the gallery's order; empty until answered, and after a failure. */
  flows: Flow[];
  status: FlowsReadStatus;
}

const LOADING: FlowsRead = { flows: [], status: "loading" };

/**
 * The flows for the create dialog's "Start from a flow": read once each time
 * `open` becomes true, through the browser client, so a flow a product admin
 * has just hidden or shown is as the API now says. The published ones only,
 * for a product admin too: the API lists the hidden ones to a product admin
 * (`published: false`), and they are left out here, so the browse step and
 * the start step's count never hold them. An answer that arrives after the
 * dialog closed is dropped.
 */
export function useFlowsWhenOpen(open: boolean): FlowsRead {
  const [read, setRead] = useState<FlowsRead>(LOADING);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRead(LOADING);
    getFlows().then(
      ({ flows }) => {
        if (!cancelled) setRead({ flows: flows.filter((flow) => flow.published), status: "loaded" });
      },
      () => {
        // A failed read leaves the list empty, so the browse step
        // says "No flows are available right now."; reopening reads again.
        if (!cancelled) setRead({ flows: [], status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);
  return read;
}
