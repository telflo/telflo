import { useId, useState } from "react";
import { useRevalidator } from "react-router";
import type { Collector, CollectorGroup, FleetType } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { ApiError, updateCollector } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { fleetRefusalMessage } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { groupLabel, groupsInFleetOrder } from "~/lib/kubernetes-groups.js";
import type { PacedResult } from "~/lib/paced-writes.js";
import { ALREADY_DELETED_WORDS, BulkProgress, BulkResults, NOT_ATTEMPTED_WORDS, useBulkRun } from "./BulkWriteRun.js";
import { GROUPS_UNREADABLE_WORDS } from "./EditCollectorDialog.js";

/*
 * "Move collectors": a Select of the fleet's groups (their ids its values,
 * never names), then each selected collector's `PATCH {groupId}`, one at a
 * time (`runPacedWrites`):
 *
 * - "Moving {i} of {n}…" with Stop ("Stopping…": the request in flight
 *   finishes, the rest aren't sent); a 429 waits out its `Retry-After`
 *   ("(waiting {s} seconds: too many requests)") and tries that collector
 *   again.
 * - A run that can't go on stops, the rest "Not attempted": an unknown
 *   outcome, the fleet or the target group gone
 *   (`collector_group_not_found`), the organization or the terms, the
 *   session ended. The organization's or the terms' refusal closes the
 *   dialog and revalidates the layout.
 * - At the end, "Moved {k}" and each other collector with its result:
 *   "Already deleted" (`collector_not_found`), "May or may not have moved"
 *   (an unknown outcome), "Not attempted", or the refusal's message.
 * - While it runs the dialog can't be closed: no Cancel, no X, Escape and
 *   outside clicks do nothing. After it, one Close (no X beside it); closed
 *   after a run, the grid reloads its page and the fleet (`onChanged`).
 * On a Kubernetes-supervisor fleet the Select names the Agent and the Cluster
 * by their roles, then the gateways (`groupLabel`, `groupsInFleetOrder`).
 * Names are text only, in the masked shell.
 */

export const MOVE_COLLECTOR_FAILED_MESSAGE = "Failed to move collector";
export const MOVE_UNKNOWN_WORDS = "May or may not have moved";

/** What became of a collector not moved. */
function moveResultWords(result: PacedResult<Collector>): string | null {
  switch (result.kind) {
    case "done":
      return null;
    case "gone":
      return ALREADY_DELETED_WORDS;
    case "unknown":
      return MOVE_UNKNOWN_WORDS;
    case "not_attempted":
      return NOT_ATTEMPTED_WORDS;
    case "refused":
      return result.message;
  }
}

/** Whether a refusal says the target group is gone: the rest would be refused the same way. */
function isTargetGroupGone(error: unknown): boolean {
  return error instanceof ApiError && error.code === "collector_group_not_found";
}

export interface BulkMoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected collectors, in the grid's order. */
  collectors: Collector[];
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The tab's groups; null when they can't be read (the bar keeps the dialog shut then). */
  groups: CollectorGroup[] | null;
  /** The fleet's type: a Kubernetes fleet's groups are named by role. */
  fleetType?: FleetType;
  /** Closed after a run: the grid reloads its page and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the host gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: no run, no result carried over. */
export function BulkMoveDialog(props: BulkMoveDialogProps) {
  const opening = useOpeningKey(props.open);
  return <BulkMoveSession key={opening} {...props} />;
}

function BulkMoveSession({
  open,
  onOpenChange,
  collectors,
  organizationId,
  fleetId,
  groups,
  fleetType = "server",
  onChanged,
  onCloseAutoFocus,
}: BulkMoveDialogProps) {
  const { revalidate } = useRevalidator();
  const groupId = useId();
  const [target, setTarget] = useState("");

  const closeAfterRun = () => {
    onOpenChange(false);
    onChanged();
  };

  const run = useBulkRun(open, organizationId, collectors, (results) => {
    const halted = results.find(
      (result) => result.kind === "refused" && (isOrganizationGone(result.error) || isTermsAcceptanceRequired(result.error)),
    );
    if (halted !== undefined) {
      closeAfterRun();
      void revalidate();
    }
  });
  const running = run.phase === "running";

  const close = () => {
    if (run.phase === "running") return;
    if (run.phase === "done") closeAfterRun();
    else onOpenChange(false);
  };

  const move = () => {
    if (target === "" || run.phase !== "confirm") return;
    const groupIdSent = target;
    run.start((collector, signal) => updateCollector(organizationId, fleetId, collector.id, { groupId: groupIdSent }, { signal }), {
      refusal: (error) => fleetRefusalMessage(error, MOVE_COLLECTOR_FAILED_MESSAGE),
      stopsOn: isTargetGroupGone,
    });
  };

  const count = collectors.length;
  const results = run.results ?? [];
  const moved = results.filter((result) => result.kind === "done").length;
  const others = results.flatMap((result) => {
    const words = moveResultWords(result);
    return words === null ? [] : [{ collector: result.item, words }];
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[90vh] max-w-md overflow-y-auto"
        onCloseAutoFocus={onCloseAutoFocus}
        // No X once the run starts: while it runs it can't be closed, and after it the footer's Close is the one way out.
        hideCloseButton={run.phase !== "confirm"}
        onEscapeKeyDown={(event) => {
          if (running) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (running) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Move collectors</DialogTitle>
          <DialogDescription>
            Move the {count === 1 ? "selected collector" : `${count} selected collectors`} to another of the fleet's groups,
            one at a time. A pinned collector's pin still decides what it runs.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {run.phase === "confirm" ? (
            <div className="grid gap-2">
              {groups === null ? (
                <>
                  <Label>Group</Label>
                  <p className="text-[13px] text-fail">{GROUPS_UNREADABLE_WORDS}</p>
                </>
              ) : (
                <>
                  <Label htmlFor={groupId}>Group</Label>
                  <Select
                    value={target}
                    onValueChange={(value) => {
                      if (value) setTarget(value);
                    }}
                  >
                    <SelectTrigger id={groupId}>
                      <SelectValue placeholder="Pick a group" />
                    </SelectTrigger>
                    <SelectContent>
                      {groupsInFleetOrder(groups, fleetType).map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {groupLabel(group, fleetType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>
          ) : run.phase === "running" ? (
            <BulkProgress verb="Moving" progress={run.progress} />
          ) : (
            <BulkResults summary={`Moved ${moved}`} others={others} />
          )}
        </div>

        <DialogFooter>
          {run.phase === "confirm" ? (
            <>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="button" onClick={move} disabled={target === "" || groups === null}>
                {`Move ${count}`}
              </Button>
            </>
          ) : run.phase === "running" ? (
            <Button type="button" variant="outline" onClick={run.stop} disabled={run.stopping}>
              {run.stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button type="button" onClick={close}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
