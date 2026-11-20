import { Pencil, Trash2 } from "lucide-react";
import type { CollectorDistribution, Configuration } from "@telflo/contracts";
import { DistributionTag } from "~/components/collector/DistributionTag.js";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";

/*
 * A configuration's card:
 * - the name has no `title`: replay records attributes unmasked, so private
 *   data goes only in text;
 * - the Published/Draft badge is in the footer's left slot, not the header,
 *   so the footer's divider always draws; the distribution tag follows it
 *   there, its tooltip fixed text but for the catalogue's label;
 * - Delete shows only where it's allowed: the author's card, or any card for
 *   an admin;
 * - Enter and Space open the card only when the card itself has focus, not
 *   when they bubble up from Edit and Delete, so the keyboard can press
 *   Delete.
 * The card stays a `div role="button"`, not a link.
 */

interface ConfigurationCardProps {
  configuration: Configuration;
  /** Whether the signed-in member created it; others' cards show the creator's email. */
  isOwn: boolean;
  /** Whether the signed-in member may delete it: its author, or an admin. */
  canDelete: boolean;
  onOpen: (configuration: Configuration) => void;
  /** `from` the Delete pressed (the playground's prompt gives the focus back there). */
  onDelete: (configuration: Configuration, from?: HTMLElement) => void;
  /** The collector catalogue, for the distribution tag's label and mark; null while unread or failed. */
  distributions?: readonly CollectorDistribution[] | null;
}

export function ConfigurationCard({
  configuration,
  isOwn,
  canDelete,
  onOpen,
  onDelete,
  distributions = null,
}: ConfigurationCardProps) {
  return (
    // The whole card opens the editor (it already renders cursor-pointer);
    // inner controls stop propagation so they don't double-trigger.
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(configuration)}
      onKeyDown={(e) => {
        // Only the card's own keys: Enter or Space on Edit or Delete bubbles
        // here, and would otherwise open the editor instead of pressing them.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(configuration);
        }
      }}
      className="group flex h-full cursor-pointer flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-gray-300 dark:hover:border-gray-600"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {configuration.name}
        </h3>
      </div>
      {!isOwn && configuration.createdBy && (
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {configuration.createdBy.email}
        </p>
      )}

      {/* Description */}
      <div className="mt-2 flex-1">
        <p className="line-clamp-2 min-h-[2.25rem] text-[13px] leading-[1.4] text-muted-foreground">
          {configuration.description || "No description"}
        </p>
      </div>

      {/* Footer: the status badge left, actions surface on hover right. The
          divider draws over resting content, and the badge always is. */}
      <div className="mt-3 flex h-7 items-center justify-between border-t border-border pt-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <ConfigurationStatusBadge published={configuration.published} />
          <DistributionTag distributionId={configuration.collectorDistribution} distributions={distributions} />
        </div>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(configuration);
            }}
          >
            <Pencil className="!size-3.5" />
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-fail hover:bg-fail-soft hover:text-fail"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(configuration, e.currentTarget);
              }}
            >
              <Trash2 className="!size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The status badge, on cards and in the table's Status column: `Published`
 * (info) when at least one version is, else `Draft` (outline). Its text is the
 * visible word alone.
 */
export function ConfigurationStatusBadge({ published }: { published: boolean }) {
  return published ? (
    <Badge variant="info" className="shrink-0">
      Published
    </Badge>
  ) : (
    <Badge variant="outline" className="shrink-0">
      Draft
    </Badge>
  );
}
