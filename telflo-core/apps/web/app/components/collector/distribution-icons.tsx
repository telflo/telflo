import type { ComponentType } from "react";
import { Box } from "lucide-react";
import { OtelIcon } from "./OtelIcon.js";

/*
 * The distribution icons and short labels, Contrib only: no ClickStack. Built
 * for several distributions all the same: another one is a row in each map,
 * and one the maps don't know yet shows the generic glyph and its catalog
 * label (or its id), never nothing.
 */

export type DistributionIcon = ComponentType<{ className?: string }>;

/**
 * The glyph for a distribution with no mark of its own: lucide's box (the
 * app's icon set, ISC), monochrome in the text's color.
 */
function GenericCollectorIcon({ className }: { className?: string }) {
  return <Box role="img" aria-label="Collector" className={className} />;
}

/** The catalog's icon keys (a distribution's `icon`) and their marks. */
const distributionIcons: Record<string, DistributionIcon> = {
  otel: OtelIcon,
};

/** A catalog icon key's mark; the generic glyph for an unknown, null or absent key. */
export function iconFor(key: string | null | undefined): DistributionIcon {
  if (!key) return GenericCollectorIcon;
  return distributionIcons[key] ?? GenericCollectorIcon;
}

/** A distribution id's icon key, for when the catalog hasn't been read (or failed). */
const iconKeyByDistribution: Record<string, string> = {
  "otelcol-contrib": "otel",
};

/** A distribution id's mark, through its icon key; the generic glyph for an unknown, null or absent id. */
export function iconForDistribution(distributionId: string | null | undefined): DistributionIcon {
  if (!distributionId) return GenericCollectorIcon;
  return iconFor(iconKeyByDistribution[distributionId]);
}

/**
 * The compact names the toolbar and the list show, where the catalog's
 * label ("OpenTelemetry Collector Contrib") is too long; the pickers' lists
 * show the full label.
 */
const distributionShortLabels: Record<string, string> = {
  "otelcol-contrib": "Otel Contrib",
};

/** A distribution id's compact name, or `fullLabel` when it has none. */
export function shortLabelFor(distributionId: string | null | undefined, fullLabel: string): string {
  if (!distributionId) return fullLabel;
  return distributionShortLabels[distributionId] ?? fullLabel;
}

/**
 * A distribution id's name for a sentence, for a page that has the id before
 * the catalog is read: the flow page's "Validated against …" prefers the
 * catalog's label and falls back to this, so the server's render names it
 * too.
 */
const distributionFullLabels: Record<string, string> = {
  "otelcol-contrib": "OpenTelemetry Collector Contrib",
};

/** A distribution id's name for a sentence: the catalog's `label` when given, else the known name, else the id. */
export function fullLabelFor(distributionId: string, catalogueLabel?: string): string {
  return catalogueLabel ?? distributionFullLabels[distributionId] ?? distributionId;
}
