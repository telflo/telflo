import type { CollectorVersionOffer } from "@telflo/contracts";

/*
 * Which collector version the flow admin dialog's version select shows. Its
 * fallback is the catalogue's default version, not the list's first; the
 * catalogue's default is never a deprecated one, and with no default
 * flagged the list's first (newest) stands in.
 */

/**
 * The version the select shows, given a pick already in flight, the flow
 * being edited (if any), the distribution selected in the dialog, and the
 * versions that distribution offers (newest first, never a deprecated one).
 *
 * Pure, so the distribution-scoping rule can be tested without mounting the
 * dialog: a version belongs to its distribution, so a flow's pin is only
 * consulted while the selected distribution is still the one the flow was
 * pinned to. Otherwise it is a leftover from the other distribution's
 * catalogue, and saving it would pair a distribution with a version it
 * doesn't have. In that case (or for a new flow, or a flow with no pin) the
 * selected distribution's default version wins.
 *
 * The flow's pin is kept even when the catalogue no longer offers it: an
 * edit that doesn't change the pin leaves it where it is.
 */
export function resolveFlowVersion(
  currentPick: string,
  flowDistribution: string | null | undefined,
  flowVersion: string | null | undefined,
  selectedDistribution: string,
  availableVersions: readonly Pick<CollectorVersionOffer, "version" | "isDefault">[],
): string {
  if (currentPick) return currentPick;

  const flowsOwnDistribution = flowDistribution || "otelcol-contrib";
  if (flowVersion && selectedDistribution === flowsOwnDistribution) {
    return flowVersion;
  }

  return (availableVersions.find((offer) => offer.isDefault) ?? availableVersions[0])?.version ?? "";
}
