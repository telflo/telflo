import type { DragEvent } from "react";

import { writePaletteDrag } from "./canvas-handlers.js";
import { componentIcon, nodeAccentVar } from "./component-icons.js";
import { HelpPopover } from "~/components/ui/help-popover.js";
import { filterPaletteByAllowlist } from "~/lib/collector/distribution-allowlist.js";
import { componentPalette } from "~/lib/graph/palette.js";
import type { ComponentType, PaletteComponent } from "~/lib/graph/types.js";
import { usePlayground } from "~/lib/playground/context.js";
import { findSupportedComponents, useCollectorCatalogueStore } from "~/lib/stores/collector-catalogue-store.js";
import { selectIsEditingLocked, useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The component palette (D9a decision 10): the entries, in its five
 * sections with their counts, as chips the canvas takes by drag and drop.
 * The drag carries the static palette entry, never anything a person wrote
 * (`writePaletteDrag`).
 *
 * Only the components the open version's distribution supports (D13a
 * decision 6): the catalogue's `supportedComponents` for the
 * configuration's distribution and the pin on screen (a pick in the toolbar
 * changes it at once, saved or not), matched by `filterPaletteByAllowlist`.
 * Every entry for Contrib (null), and whenever the catalogue can't say
 * (unread, failed, or a pin it no longer offers): never an empty toolbox for
 * want of the catalogue. A section left with none is not shown. The filter is
 * the toolbox's only: components already on the canvas, or typed in the text,
 * stay. The palette doesn't read the catalogue itself; the editor page does
 * (`useCollectorDistributions`). Inside the playground (D31-1 decision 11,
 * Ruling 280) it shows every component, as the signed-in palette does before
 * its catalogue answers: a catalogue this tab read on a signed-in page is
 * never applied there.
 *
 * Palette chips mirror the canvas node cards: quiet hairline chips on the
 * card surface, the component type carried only by the icon's tint (the
 * same --color-node-* tokens the canvas rails use).
 *
 * While the canvas is locked (manual edit mode, or text it can't show) the
 * chips don't drag: the canvas under its overlay takes no drop. Nor on a
 * published version, which is read-only (D11b decision 4).
 */

const chipBox = "border-border bg-card hover:border-gray-300 hover:bg-accent dark:hover:border-gray-600";

/** The sections' headings, in the palette's order. */
export const PALETTE_SECTIONS: readonly { type: ComponentType; label: string }[] = [
  { type: "receiver", label: "Receivers" },
  { type: "processor", label: "Processors" },
  { type: "exporter", label: "Exporters" },
  { type: "extension", label: "Extensions" },
  { type: "connector", label: "Connectors" },
];

function onDragStart(event: DragEvent, entry: PaletteComponent) {
  writePaletteDrag(event.dataTransfer, entry);
}

export function ComponentPalette() {
  const locked = useEditorStore(selectIsEditingLocked);
  const distributionId = useEditorStore((state) => state.configuration?.collectorDistribution ?? null);
  const pin = useEditorStore((state) => state.collectorVersion);
  const inPlayground = usePlayground() !== null;
  const stored = useCollectorCatalogueStore((state) => findSupportedComponents(state.distributions, distributionId, pin));
  const supported = inPlayground ? null : stored;
  const shown = filterPaletteByAllowlist(componentPalette, supported);

  return (
    <div className="flex-1 p-3">
      {PALETTE_SECTIONS.map(({ type, label }) => {
        const items = shown.filter((entry) => entry.type === type);
        if (items.length === 0) return null;
        return (
          <div key={type} className="mb-5">
            <div className="mb-1.5 flex items-baseline justify-between px-0.5">
              <h3 className="tf-label">{label}</h3>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">{items.length}</span>
            </div>
            <div className="space-y-1">
              {items.map((item) => {
                const ItemIcon = componentIcon(item.type, item.subType);
                return (
                  <div
                    key={item.id}
                    draggable={!locked}
                    onDragStart={(event) => onDragStart(event, item)}
                    className={`group flex h-8 items-center gap-2 rounded-[5px] border px-2 transition-colors ${
                      locked ? "cursor-default opacity-60" : "cursor-grab active:cursor-grabbing"
                    } ${chipBox}`}
                  >
                    {/* currentColor wrapper: tints lucide strokes and the vendor marks' fills alike. */}
                    <span className="shrink-0" style={{ color: nodeAccentVar[item.type] }}>
                      <ItemIcon className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{item.label}</span>
                    <span
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onDragStart={(event) => event.preventDefault()}
                      draggable={false}
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                    >
                      <HelpPopover
                        label={`About ${item.label}`}
                        title={item.label}
                        triggerClassName="inline-flex items-center justify-center p-1 rounded-[4px] text-current opacity-50 hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
                        iconClassName="w-3.5 h-3.5"
                        align="end"
                        side="right"
                      >
                        {item.helpText}
                      </HelpPopover>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
