import type { CollectorDistribution } from "@telflo/contracts";
import { findDistribution } from "~/lib/stores/collector-catalogue-store.js";
import { iconFor, iconForDistribution, shortLabelFor } from "./distribution-icons.js";

/** The tag's tooltip (D13a decision 10): fixed text but for the catalogue's label of the distribution. */
export function distributionTagTooltip(label: string): string {
  return `Built for ${label} — chosen when this configuration was created.`;
}

/**
 * The distribution tag, on the list's cards and in its Distribution column
 * (D13a decision 10): a quiet tag naming the distribution a configuration is
 * built for, its mark and its compact name, in the list's mono metadata style
 * (not a badge: the distribution is what it is, not a status). Its tooltip (a
 * `title`) says "Built for {label} — chosen when this configuration was
 * created.", where {label} is the catalogue's label of the distribution (its
 * id while the catalogue is unread): catalogue data, never the
 * configuration's name or anything a person typed, so no attribute carries
 * private data (ADR 0024).
 *
 * The mark is the catalogue's icon for the distribution, or found from its
 * id while the catalogue is unread; a distribution neither knows shows the
 * generic glyph and its id.
 */
export function DistributionTag({
  distributionId,
  distributions,
  className,
}: {
  /** The configuration's distribution (`otelcol-contrib`). */
  distributionId: string;
  /** The catalogue, null while it is unread or failed. */
  distributions: readonly CollectorDistribution[] | null;
  className?: string;
}) {
  const distribution = findDistribution(distributions, distributionId);
  const Icon = distribution ? iconFor(distribution.icon) : iconForDistribution(distributionId);
  const fullLabel = distribution?.label ?? distributionId;
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground ${className ?? ""}`}
      title={distributionTagTooltip(fullLabel)}
    >
      {/* The marks carry their own role="img" names, which would repeat the text. */}
      <span aria-hidden="true" className="flex shrink-0">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="truncate">{shortLabelFor(distributionId, fullLabel)}</span>
    </span>
  );
}
