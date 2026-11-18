import { useState } from "react";
import { useRevalidator } from "react-router";
import type { Collector, CollectorGroup, FleetType } from "@telflo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";
import { Button } from "~/components/ui/button.js";
import { deleteCollector } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { fleetRefusalMessage } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { helmUninstallsOf } from "~/lib/kubernetes-groups.js";
import type { PacedResult } from "~/lib/paced-writes.js";
import { BulkProgress, BulkResults, NOT_ATTEMPTED_WORDS, useBulkRun } from "./BulkWriteRun.js";
import { DELETE_COLLECTOR_FAILED_MESSAGE } from "./DeleteCollectorDialog.js";
import { BULK_UNINSTALL_WORDS, HelmUninstall } from "./HelmUninstall.js";

/*
 * "Delete collectors" (D17b-1 decisions 12, 14, 27 and 28; Preflight
 * rulings 4 and 13): an AlertDialog as a collector's delete
 * (`DeleteCollectorDialog`), with the count and Preflight ruling 4's lines,
 * worded for any of several ("If a collector keeps polling": the single
 * dialog's "the collector" names one); no import warning (D16c removed
 * importing). Then each collector's `DELETE`, one at a time
 * (`runPacedWrites`), as the bulk move's run:
 *
 * - "Deleting {i} of {n}…" with Stop; a 429 waits out its `Retry-After`
 *   and tries that collector again; an unknown outcome, the fleet gone, the
 *   organization or the terms, or the session ended stops the run, the rest
 *   "Not attempted" (the organization's or the terms' refusal closes the
 *   dialog and revalidates the layout).
 * - A `collector_not_found` counts as deleted.
 * - At the end, "Deleted {k}" and each other collector with its result:
 *   "May or may not have been deleted" (an unknown outcome), "Not
 *   attempted", or the refusal's message.
 * - While it runs the dialog can't be closed (Escape does nothing; no
 *   Cancel). Closed after a run, the grid reloads its page and the fleet.
 * "(else Default)" is gone from the body (D17d-1 Preflight ruling 29); a
 * Kubernetes-supervisor fleet's body is its pods' (decision 23), then
 * (D17d-2 decision 25; Preflight ruling 31) one box of `helm uninstall`s,
 * one per distinct group among the selected in the fleet's order (those it
 * can't name left out), snapshotted at the opening.
 * The selected collectors aren't named before the run; names in the
 * results are text only, in the masked shell (decision 32).
 */

export const DELETE_UNKNOWN_WORDS = "May or may not have been deleted";

/** Preflight ruling 4's consequences, for any of the selected collectors (D17d-1 Preflight ruling 29: no "(else Default)"). */
export const BULK_DELETE_CONSEQUENCES =
  "If a collector keeps polling, it enrolls again as a new collector: in the group it was installed into, unpinned, with no error history, and it is sent that group's published version if it has one. If that group has been deleted, it can't enroll again.";

/** A Kubernetes fleet's consequences (D17d-1 decision 23; Preflight ruling 29). */
export const KUBERNETES_BULK_DELETE_CONSEQUENCES = "Deleting a record just forgets it: a pod still running enrolls again on its next poll.";

/** "You are deleting the records of 3 collectors." */
export function deletingWords(count: number): string {
  return count === 1 ? "You are deleting the record of 1 collector." : `You are deleting the records of ${count} collectors.`;
}

/** What became of a collector not deleted; a collector already gone counts as deleted. */
function deleteResultWords(result: PacedResult<Collector>): string | null {
  switch (result.kind) {
    case "done":
    case "gone":
      return null;
    case "unknown":
      return DELETE_UNKNOWN_WORDS;
    case "not_attempted":
      return NOT_ATTEMPTED_WORDS;
    case "refused":
      return result.message;
  }
}

export interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected collectors, in the grid's order. */
  collectors: Collector[];
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The fleet's type: a Kubernetes fleet's body is its pods'. */
  fleetType?: FleetType;
  /** The tab's groups (null while unread): a Kubernetes fleet's uninstall lines name the selected collectors' groups' releases. */
  groups?: readonly CollectorGroup[] | null | undefined;
  /** Closed after a run: the grid reloads its page and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the host gives it back to the opener (D14b Ruling 46). */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: no run, no result carried over. */
export function BulkDeleteDialog(props: BulkDeleteDialogProps) {
  const opening = useOpeningKey(props.open);
  return <BulkDeleteSession key={opening} {...props} />;
}

function BulkDeleteSession({
  open,
  onOpenChange,
  collectors,
  organizationId,
  fleetId,
  fleetType = "server",
  groups = null,
  onChanged,
  onCloseAutoFocus,
}: BulkDeleteDialogProps) {
  const { revalidate } = useRevalidator();
  // The groups' uninstalls as the opening found them (a snapshot).
  const [uninstalls] = useState(() =>
    fleetType === "kubernetes-supervisor" && groups !== null ? helmUninstallsOf(collectors.map((each) => each.groupId), groups) : [],
  );

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

  const remove = () => {
    if (run.phase !== "confirm") return;
    run.start((collector, signal) => deleteCollector(organizationId, fleetId, collector.id, { signal }), {
      refusal: (error) => fleetRefusalMessage(error, DELETE_COLLECTOR_FAILED_MESSAGE),
    });
  };

  const count = collectors.length;
  const results = run.results ?? [];
  const deleted = results.filter((result) => result.kind === "done" || result.kind === "gone").length;
  const others = results.flatMap((result) => {
    const words = deleteResultWords(result);
    return words === null ? [] : [{ collector: result.item, words }];
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AlertDialogContent
        // A long results list scrolls within the window, as the other bulk dialogs.
        className="max-h-[90vh] overflow-y-auto"
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (running) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete collectors</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {deletingWords(count)}{" "}
                {fleetType === "kubernetes-supervisor" ? KUBERNETES_BULK_DELETE_CONSEQUENCES : BULK_DELETE_CONSEQUENCES}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {run.phase === "confirm" && <HelmUninstall words={BULK_UNINSTALL_WORDS} commands={uninstalls} bulk />}

        {run.phase === "running" && <BulkProgress verb="Deleting" progress={run.progress} />}
        {run.phase === "done" && <BulkResults summary={`Deleted ${deleted}`} others={others} />}

        <AlertDialogFooter>
          {run.phase === "confirm" ? (
            <>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  // Keep the dialog open while the run goes on; Close ends it.
                  event.preventDefault();
                  remove();
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {`Delete ${count}`}
              </AlertDialogAction>
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
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
