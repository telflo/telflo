import { useId } from "react";
import { Info, Lock } from "lucide-react";
import type { CollectorVersionOffer } from "@telflo/contracts";
import { iconFor, iconForDistribution, shortLabelFor } from "~/components/collector/distribution-icons.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "~/components/ui/select.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { findDistribution, useCollectorCatalogueStore } from "~/lib/stores/collector-catalogue-store.js";
import { selectIsVersionPublished, useEditorStore } from "~/lib/stores/editor-store.js";

/** The locked distribution's tooltip: the spec's words (D13a decision 5). */
export const DISTRIBUTION_LOCKED_TOOLTIP = "Set when this configuration was created.";

/** The name of the mark that holds a deprecated pin's note (its tooltip): fixed text. */
export const DEPRECATION_NOTE_LABEL = "Deprecation note";

/** How a collector version is shown: `v0.162.0`, and `v0.155.0 (deprecated)` for a pin the catalogue retired (decision 4). */
export function collectorVersionText(version: string, deprecated: boolean): string {
  return `v${version}${deprecated ? " (deprecated)" : ""}`;
}

/*
 * The collector picker (D13a decisions 4, 5 and 8), at the
 * tail of the toolbar's left group: "Collector:", the configuration's
 * distribution, read-only, and the open version's collector version.
 *
 * - "Collector:" is shown on wide screens only, so the toolbar fits beside
 *   the sidebar (Ruling 34), and is hidden from assistive technology at
 *   every width: the picker's own name, "Collector version", says it, so it
 *   isn't read twice.
 * - The distribution is shown, never picked: its mark, its compact name and
 *   a lock, at full contrast (it is a fact about the configuration, not a
 *   control that's off). It is an image named "Distribution: {name} (locked
 *   at creation)" (the version picker's lock's pattern; Ruling 36), takes
 *   the focus, and on hover or focus its tooltip says "Set when this
 *   configuration was created." (the spec's words).
 * - The version is a dropdown of the versions the catalogue offers for the
 *   distribution, newest first (the API's order), each `v0.162.0` with its
 *   catalogue label (where it says more than that) and description, and the
 *   default marked "Default". A pick is on screen only: the version is
 *   unsaved (the store's `setCollectorVersion`; the toolbar's "Unsaved"),
 *   and Save stores it with the text.
 * - A deprecated pin is shown as `v0.155.0 (deprecated)` and kept: nothing
 *   changes it but a pick of another version (never silently moved to the
 *   newest; decision 4). The saved pin's deprecation is the
 *   server's (`collectorVersionDeprecated`, as fresh as the last load, save
 *   or re-read), never the catalogue's, read once with the page, which may
 *   not list a release a teammate picked since (Ruling 36); a pick's is the
 *   catalogue's. The catalogue's note follows it, behind an info mark that
 *   takes the focus and shows the note as its tooltip (as the
 *   distribution's lock does), so the keyboard reaches it even while the
 *   dropdown is disabled on a published version. While it is the pin it is
 *   listed first, with its note; once another is picked it is no longer
 *   offered, so it can't be picked again (Discard puts it back).
 * - On a published version it is read-only with the rest of the editor
 *   (D11b decision 4): the dropdown is disabled, and the store refuses a
 *   pick.
 * - Until the catalogue has been read (or when it couldn't be), the pin is
 *   shown as text, and the distribution by its id's mark and name.
 * There is no public picker and no ClickStack flag.
 *
 * Privacy (ADR 0024): every string here is the catalogue's (labels,
 * descriptions, notes), public data, so they may be in a tooltip or a name;
 * nothing a person typed (the configuration's name, a version's label) is in
 * any attribute.
 */
export function CollectorVersionSelect() {
  const distributionId = useEditorStore((state) => state.configuration?.collectorDistribution ?? null);
  const pin = useEditorStore((state) => state.collectorVersion);
  const savedPin = useEditorStore((state) => state.version?.collectorVersion ?? null);
  const savedPinDeprecated = useEditorStore((state) => state.version?.collectorVersionDeprecated ?? false);
  const savedPinNote = useEditorStore((state) => state.version?.collectorVersionDeprecatedNote ?? null);
  const isPublished = useEditorStore(selectIsVersionPublished);
  const distributions = useCollectorCatalogueStore((state) => state.distributions);
  const nameId = useId();
  const shownId = useId();

  if (distributionId === null || pin === null) return null;

  const distribution = findDistribution(distributions, distributionId);
  const offered: readonly CollectorVersionOffer[] = distribution?.versions ?? [];
  const isOffered = offered.some((offer) => offer.version === pin);
  // The saved pin's deprecation is the server's, fresher than the catalogue
  // read with the page; a pick's is the catalogue's (Ruling 36).
  const isSavedPin = pin === savedPin;
  const deprecated = isSavedPin ? savedPinDeprecated : distribution !== undefined && !isOffered;
  const note = deprecated && isSavedPin ? savedPinNote : null;
  const shown = collectorVersionText(pin, deprecated);

  const fullLabel = distribution?.label ?? distributionId;
  const shortLabel = shortLabelFor(distributionId, fullLabel);
  const DistributionMark = distribution ? iconFor(distribution.icon) : iconForDistribution(distributionId);

  return (
    <div className="flex shrink-0 items-center gap-1.5 pr-2">
      {/* The picker's name says it: hidden from assistive technology, and on narrower screens (Ruling 34). */}
      <span aria-hidden="true" className="hidden whitespace-nowrap text-xs text-muted-foreground 2xl:inline">
        Collector:
      </span>
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Read-only, not disabled; focusable, so the keyboard reaches what the tooltip says. */}
            <span
              role="img"
              tabIndex={0}
              aria-label={`Distribution: ${shortLabel} (locked at creation)`}
              className="flex h-7 min-w-0 cursor-default items-center gap-1.5 rounded-md px-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span aria-hidden="true" className="flex shrink-0">
                <DistributionMark className="h-4 w-4" />
              </span>
              <span className="truncate">{shortLabel}</span>
              <Lock aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64">
            {DISTRIBUTION_LOCKED_TOOLTIP}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span id={nameId} className="sr-only">
        Collector version
      </span>
      {distribution !== undefined && offered.length > 0 ? (
        <Select
          value={pin}
          onValueChange={(picked) => useEditorStore.getState().setCollectorVersion(picked)}
          disabled={isPublished}
        >
          <SelectTrigger
            className="h-7 w-auto min-w-28 font-mono text-xs"
            aria-labelledby={`${nameId} ${shownId}`}
          >
            <span id={shownId}>{shown}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel className="text-xs">{distribution.label}</SelectLabel>
              {!isOffered && (
                <SelectItem value={pin} className="font-mono text-xs" description={note ?? undefined}>
                  {shown}
                </SelectItem>
              )}
              {offered.map((offer) => (
                <SelectItem
                  key={offer.version}
                  value={offer.version}
                  className="font-mono text-xs"
                  description={offer.description ?? undefined}
                >
                  <span className="flex items-center gap-1.5">
                    {collectorVersionText(offer.version, false)}
                    {offer.label !== collectorVersionText(offer.version, false) && (
                      <span className="font-sans text-muted-foreground">{offer.label}</span>
                    )}
                    {offer.isDefault && (
                      <span className="rounded-[4px] border border-border px-1.5 py-px text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
                        Default
                      </span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        // The catalogue unread, or no versions offered: the pin as text.
        <span id={shownId} className="font-mono text-xs text-muted-foreground">
          {shown}
        </span>
      )}
      {note !== null && <DeprecationNote note={note} />}
    </div>
  );
}

/**
 * A deprecated pin's note (Ruling 36): an info mark named "Deprecation
 * note" that takes the focus, its tooltip the note, as the distribution's
 * lock explains itself. It is its own stop, so the keyboard reaches it while
 * the dropdown is disabled. The note is the catalogue's (public text).
 */
function DeprecationNote({ note }: { note: string }) {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            tabIndex={0}
            aria-label={DEPRECATION_NOTE_LABEL}
            className="flex h-7 shrink-0 cursor-default items-center rounded-md px-0.5 text-warn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Info aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          {note}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
