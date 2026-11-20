import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import type { CollectorGroup } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { COPY_FAILED_MESSAGE } from "~/lib/hooks/use-copied-text.js";
import { PublishedVersionCell } from "./GroupsTable.js";
import { VariableGroupLink } from "./VariableGroupLink.js";

/*
 * A group's details, opened by a row's "More". Its title the group's name,
 * its description "Group details", and the rows Name, Published version
 * ("Nothing assigned" with its meaning as text under it) and Collector Group
 * ID with its copy button, which toasts, and a "Variable group" row: the
 * group's variable group by name, else "Organization values", opening each
 * variable's value (`VariableGroupLink`). No `title` on the id; the name is
 * text in the masked shell only. The dialog shows the row as it was when
 * opened: the polls pause while it is open.
 */

export const COPIED_GROUP_ID_MESSAGE = "Copied collector group id";

/** One label/value row, two cells of the parent's grid. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      <div className="min-w-0 text-[13px] text-foreground">{children}</div>
    </>
  );
}

export interface GroupDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row opened; null renders nothing. */
  group: CollectorGroup | null;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the row's More. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

export function GroupDetailsDialog({ open, onOpenChange, group, onCloseAutoFocus }: GroupDetailsDialogProps) {
  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      toast.success(COPIED_GROUP_ID_MESSAGE);
    } catch {
      toast.error(COPY_FAILED_MESSAGE);
    }
  };

  return (
    <Dialog open={open && group !== null} onOpenChange={onOpenChange}>
      {group !== null && (
        <DialogContent className="max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{group.name}</DialogTitle>
            <DialogDescription>Group details</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-2.5">
            <DetailRow label="Name">{group.name}</DetailRow>
            <DetailRow label="Published version">
              <PublishedVersionCell group={group} withTooltip={false} />
            </DetailRow>
            <DetailRow label="Variable group">
              <VariableGroupLink groupVariableGroupId={group.variableGroupId} />
            </DetailRow>
            <DetailRow label="Collector Group ID">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs">{group.id}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label="Copy collector group id"
                  onClick={() => void copyId(group.id)}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </DetailRow>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
