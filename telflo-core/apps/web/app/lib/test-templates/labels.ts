import type { TestRunSignal } from "@telflo/contracts";
import { findPaletteEntry } from "~/lib/graph/palette.js";

/*
 * How a test template's receiver type and signal show: in the Templates step's
 * filters and details, and on the Test Templates admin page.
 */

/** Each signal's words: "Traces", "Logs", "Metrics". */
const SIGNAL_LABELS: ReadonlyMap<string, string> = new Map<TestRunSignal, string>([
  ["traces", "Traces"],
  ["logs", "Logs"],
  ["metrics", "Metrics"],
]);

/** The signals in the order the admin dialog offers them. */
export const TEMPLATE_SIGNALS_IN_ORDER = ["traces", "logs", "metrics"] as const satisfies readonly TestRunSignal[];

/** A receiver type as the palette labels it ("File Log"), else as it is. */
export function receiverTypeLabel(receiverType: string): string {
  return findPaletteEntry("receiver", receiverType)?.label ?? receiverType;
}

/** A signal by its words ("Traces"), else as it is. */
export function signalLabel(signal: string): string {
  return SIGNAL_LABELS.get(signal) ?? signal;
}
