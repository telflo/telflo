import { useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { COPY_FAILED_MESSAGE } from "~/lib/hooks/use-copied-text.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { KUBERNETES_ROLE_LABELS, kubernetesRowName, kubernetesSettingsOf, type KubernetesGroupRow } from "~/lib/kubernetes-groups.js";
import { COPIED_GROUP_ID_MESSAGE } from "./GroupDetailsDialog.js";
import { PublishedVersionCell } from "./GroupsTable.js";
import { VariableGroupLink } from "./VariableGroupLink.js";

/*
 * A Kubernetes group's details, opened by a row's "More". Its title the row's
 * name (Agent, Cluster, or the gateway's name), its description "Group
 * details", and the rows Group (one row, as the Groups tab's one column: the
 * role's badge, then a gateway's name; the Agent and the Cluster their badge
 * alone), Namespace, Published version ("Nothing assigned" with its meaning
 * as text under it), Volumes (each host path, its mount path, its type and
 * whether read-only), Replicas (a gateway's, "—" otherwise) and Collector
 * Group ID with `GroupDetailsDialog`'s copy button ("—" for the Cluster
 * before its group exists). Settings Telflo can't read, or none saved, show
 * "—". A "Variable group" row comes after Published version: the group's
 * variable group by name, else "Organization values" (the Cluster before its
 * group exists too), opening each variable's value (`VariableGroupLink`).
 *
 * Privacy: the gateway's name, the namespace and the volumes' paths are
 * configuration text, shown inside `ph-no-capture`; no attribute holds
 * any. The dialog shows the row as it was when opened (a snapshot at the
 * opening), and the polls pause while it is open.
 */

/** One label/value row, two cells of the parent's grid. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      <div className="min-w-0 text-[13px] text-foreground">{children}</div>
    </>
  );
}

const DASH = <span className="text-muted-foreground">—</span>;

export interface KubernetesGroupDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row opened; null renders nothing. */
  row: KubernetesGroupRow | null;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the row's More. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening shows the row as it was then. */
export function KubernetesGroupDetailsDialog(props: KubernetesGroupDetailsDialogProps) {
  const opening = useOpeningKey(props.open);
  return <KubernetesGroupDetailsSession key={opening} {...props} />;
}

function KubernetesGroupDetailsSession({ open, onOpenChange, row: liveRow, onCloseAutoFocus }: KubernetesGroupDetailsDialogProps) {
  const [row] = useState(liveRow);
  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      toast.success(COPIED_GROUP_ID_MESSAGE);
    } catch {
      toast.error(COPY_FAILED_MESSAGE);
    }
  };

  if (row === null) return <Dialog open={false} onOpenChange={onOpenChange} />;
  const { group, role } = row;
  const settings = kubernetesSettingsOf(group).kubernetes;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{kubernetesRowName(row)}</DialogTitle>
          <DialogDescription>Group details</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[max-content_1fr] items-start gap-x-6 gap-y-2.5">
          <DetailRow label="Group">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline">{KUBERNETES_ROLE_LABELS[role]}</Badge>
              {role === "gateway" && group !== null && (
                <>
                  {" "}
                  <span className="ph-no-capture">{group.name}</span>
                </>
              )}
            </div>
          </DetailRow>
          <DetailRow label="Namespace">
            {settings === null ? DASH : <span className="ph-no-capture font-mono text-xs">{settings.namespace}</span>}
          </DetailRow>
          <DetailRow label="Published version">
            <PublishedVersionCell group={group} withTooltip={false} />
          </DetailRow>
          <DetailRow label="Variable group">
            <VariableGroupLink groupVariableGroupId={group?.variableGroupId ?? null} />
          </DetailRow>
          <DetailRow label="Volumes">
            {settings === null || settings.volumes.length === 0 ? (
              DASH
            ) : (
              <ul className="ph-no-capture grid gap-1">
                {settings.volumes.map((volume, index) => (
                  <li key={index} className="text-xs">
                    <span className="font-mono">
                      {volume.hostPath} → {volume.mountPath}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      ({volume.hostPathType}, {volume.readOnly ? "read-only" : "read-write"})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DetailRow>
          <DetailRow label="Replicas">{role === "gateway" && settings?.replicas !== undefined ? settings.replicas : DASH}</DetailRow>
          <DetailRow label="Collector Group ID">
            {group === null ? (
              DASH
            ) : (
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
            )}
          </DetailRow>
        </div>
      </DialogContent>
    </Dialog>
  );
}
