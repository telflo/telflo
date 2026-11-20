import { Pencil, Trash2 } from "lucide-react";
import type { CollectorDistribution, Configuration } from "@telflo/contracts";
import { DistributionTag } from "~/components/collector/DistributionTag.js";
import { Button } from "~/components/ui/button.js";
import { ConfigurationStatusBadge } from "./ConfigurationCard.js";

/*
 * The list view: the configurations columns, as plain table markup with the
 * Table primitives' classes (no @tanstack/react-table):
 * - the headers are plain, styled as sort buttons, and don't sort: the
 *   order is the API's;
 * - a Status column, after Owner, then a Distribution column: the
 *   distribution tag, its tooltip fixed text but for the catalogue's label;
 * - no "Untitled" fallback, since a name is required;
 * - Delete shows only where it's allowed: the author's row, or any row for
 *   an admin.
 * The name is a button, not a link.
 */

const HEAD_CLASS =
  "h-9 whitespace-nowrap px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

interface ConfigurationsTableProps {
  configurations: Configuration[];
  /** The signed-in user, whose own configurations are marked "(you)". */
  currentUserId: string;
  /** Whether the signed-in member may delete a configuration: its author, or an admin. */
  canDelete: (configuration: Configuration) => boolean;
  onOpen: (configuration: Configuration) => void;
  /** `from` the Delete pressed (the playground's prompt gives the focus back there). */
  onDelete: (configuration: Configuration, from?: HTMLElement) => void;
  /** The collector catalogue, for the Distribution column's labels and marks; null while unread or failed. */
  distributions?: readonly CollectorDistribution[] | null;
}

/** A column's date: the browser's own date format, "—" for none. */
function DateCell({ value }: { value: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground">
      {new Date(value).toLocaleDateString()}
    </span>
  );
}

export function ConfigurationsTable({
  configurations,
  currentUserId,
  canDelete,
  onOpen,
  onDelete,
  distributions = null,
}: ConfigurationsTableProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-[13px]">
          <thead className="[&_tr]:border-b">
            <tr className={ROW_CLASS}>
              <th className={HEAD_CLASS}>Name</th>
              <th className={HEAD_CLASS}>Owner</th>
              <th className={HEAD_CLASS}>Status</th>
              <th className={HEAD_CLASS}>Distribution</th>
              <th className={HEAD_CLASS}>Created</th>
              <th className={HEAD_CLASS}>Updated</th>
              <th className={HEAD_CLASS}>
                <div className="text-right">Actions</div>
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {configurations.map((config) => (
              <tr key={config.id} className={ROW_CLASS}>
                <td className={CELL_CLASS}>
                  <div>
                    <button
                      type="button"
                      onClick={() => onOpen(config)}
                      className="font-medium text-foreground text-left hover:underline"
                    >
                      {config.name}
                    </button>
                    {config.description && (
                      <div className="max-w-xs truncate text-xs text-muted-foreground">
                        {config.description}
                      </div>
                    )}
                  </div>
                </td>
                <td className={CELL_CLASS}>
                  {config.createdBy ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {config.createdBy.email}
                      {config.createdBy.userId === currentUserId && (
                        <span className="ml-1 text-muted-foreground/60">(you)</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className={CELL_CLASS}>
                  <ConfigurationStatusBadge published={config.published} />
                </td>
                <td className={CELL_CLASS}>
                  <DistributionTag distributionId={config.collectorDistribution} distributions={distributions} />
                </td>
                <td className={CELL_CLASS}>
                  <DateCell value={config.createdAt} />
                </td>
                <td className={CELL_CLASS}>
                  <DateCell value={config.updatedAt} />
                </td>
                <td className={CELL_CLASS}>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Edit"
                      onClick={() => onOpen(config)}
                    >
                      <Pencil className="!size-3.5" />
                    </Button>
                    {canDelete(config) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-fail hover:bg-fail-soft hover:text-fail"
                        title="Delete"
                        onClick={(event) => onDelete(config, event.currentTarget)}
                      >
                        <Trash2 className="!size-3.5" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
