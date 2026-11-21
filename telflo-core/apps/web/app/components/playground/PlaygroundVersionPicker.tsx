import { useId, useRef } from "react";
import { Lock } from "lucide-react";
import { iconFor, iconForDistribution, shortLabelFor } from "~/components/collector/distribution-icons.js";
import { collectorVersionText, DISTRIBUTION_LOCKED_TOOLTIP } from "~/components/editor/CollectorVersionSelect.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "~/components/ui/select.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip.js";
import { PLAYGROUND_CATALOGUE } from "~/lib/playground/catalogue.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { findDistribution } from "~/lib/stores/collector-catalogue-store.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/** The sign-up prompt's words for a pick of another version. */
export const OTHER_VERSION_LOCKED_ACTION = "validate against a different collector version";

/*
 * The playground's fixed collector picker, for the playground editor's toolbar
 * (`PlaygroundToolbar`) and the blank public editor's (`PublicEditorToolbar`),
 * in place of `CollectorVersionSelect` (whose options come from the catalog
 * store, never loaded here). It has the signed-in picker's look: "Collector:",
 * the configuration's distribution, read-only with its lock, and a dropdown of
 * the versions the build-time catalog offers for it (its deprecated versions
 * left out; the same versions `SCHEMA_CATALOGUE` gives schemas for), showing
 * the open version's pin. A pick of another version changes nothing: it opens
 * the sign-up prompt (`useLockedAction`) once the list has closed and given
 * the focus back to the trigger, the prompt's opener. Every string is the
 * catalog's or fixed.
 */
export function PlaygroundVersionPicker() {
  const distributionId = useEditorStore((state) => state.configuration?.collectorDistribution ?? null);
  const pin = useEditorStore((state) => state.collectorVersion);
  const locked = useLockedAction();
  const nameId = useId();
  const shownId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  // Another version picked: the prompt opens after the list has closed.
  const pickedOther = useRef(false);

  if (distributionId === null || pin === null) return null;

  const distribution = findDistribution(PLAYGROUND_CATALOGUE, distributionId);
  const offered = distribution?.versions ?? [];
  const isOffered = offered.some((offer) => offer.version === pin);
  const shown = collectorVersionText(pin, distribution !== undefined && !isOffered);
  const fullLabel = distribution?.label ?? distributionId;
  const shortLabel = shortLabelFor(distributionId, fullLabel);
  const DistributionMark = distribution ? iconFor(distribution.icon) : iconForDistribution(distributionId);

  return (
    <div className="flex shrink-0 items-center gap-1.5 pr-2">
      <span aria-hidden="true" className="hidden whitespace-nowrap text-xs text-muted-foreground 2xl:inline">
        Collector:
      </span>
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
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
      <Select
        value={pin}
        onValueChange={(picked) => {
          if (picked !== pin) pickedOther.current = true;
        }}
      >
        <SelectTrigger ref={trigger} className="h-7 w-auto min-w-28 font-mono text-xs" aria-labelledby={`${nameId} ${shownId}`}>
          <span id={shownId}>{shown}</span>
        </SelectTrigger>
        <SelectContent
          onCloseAutoFocus={() => {
            if (!pickedOther.current) return;
            pickedOther.current = false;
            locked?.(OTHER_VERSION_LOCKED_ACTION, trigger.current);
          }}
        >
          <SelectGroup>
            <SelectLabel className="text-xs">{fullLabel}</SelectLabel>
            {!isOffered && (
              <SelectItem value={pin} className="font-mono text-xs">
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
    </div>
  );
}
