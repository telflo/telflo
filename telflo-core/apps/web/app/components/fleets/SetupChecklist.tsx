import { useEffect, useRef, useState, type Ref } from "react";
import { Check, X } from "lucide-react";
import type { CollectorGroup, FleetDetail } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { GROUPS_LOAD_FAILED_MESSAGE, useGroupsTab } from "~/lib/groups.js";
import { useReturnFocus, type FocusFallback } from "~/lib/hooks/use-return-focus.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { GroupDialog } from "./GroupDialog.js";

/*
 * A server fleet's setup checklist: three steps, between the stats strip
 * and the tabs. The route mounts it while the active fleet has no
 * collectors (the summary's count), or while the header's "Setup guide" has
 * reopened it.
 *
 * - "Set up this fleet", with "Disappears once your first collector
 *   connects", or, reopened, a close button "Hide setup guide"
 *   (`onDismiss`: the route puts the focus back on "Setup guide").
 * - **Assign a published version** (required, no "skip"): done once the
 *   Default group has a published version (every install entry here opens the
 *   Default group, which needs one; another group's version doesn't count);
 *   "Assign" opens the group dialog for the Default group. The checklist
 *   reads the fleet's groups itself (`useGroupsTab`, polled as the Groups
 *   tab, quiet: a read failing over groups shown never toasts, the Groups
 *   tab's toast is enough), and reads them again when `groupsChanged` moves
 *   (an assignment made in the install dialog); its own save calls
 *   `onGroupsChanged` (the Groups tab follows) and `onFleetChanged`. A first
 *   read that failed shows "Failed to load groups" under the step with "Try
 *   again".
 * - **Install a collector**: done once installing started in this visit
 *   (`installStarted`, the route's) or a collector exists; "Install" opens
 *   the install dialog for the Default group (`onInstall`).
 * - **First collector connects**: done once the fleet has a collector;
 *   after an install, "Listening for the first check-in…" with a spinner.
 * - The steps' done marks come from the data, never from clicks.
 * - Focus: the group dialog's close goes back to "Assign", else to
 *   `fallback` (the route's: the header's "Install collector").
 * - Names (the Default group's) appear only in the group dialog's title,
 *   as text.
 *
 * A Kubernetes-supervisor fleet's: the same card, shown and hidden alike,
 * its steps the Helm install's: **Assign published versions to your groups**
 * (done once any group has a published version; "Assign" chooses the Groups
 * tab, `onGroupsTab`, no dialog), **Install a group with Helm** (done once
 * installing started in this visit or a collector exists; "Install" opens
 * the Helm install dialog, `onInstall`), **First collector connects**
 * (worded for pods).
 */

export const CHECKLIST_TITLE = "Set up this fleet";
export const CHECKLIST_HINT = "Disappears once your first collector connects";

export const ASSIGN_STEP = {
  title: "Assign a published version",
  detail: "Give the Default group a published version: its collector version picks what to install, and its collectors run it.",
};
export const INSTALL_STEP = {
  title: "Install a collector",
  detail: "Generate a copy-paste install command and run it on a host.",
};
/** A Kubernetes-supervisor fleet's steps. */
export const KUBERNETES_ASSIGN_STEP = {
  title: "Assign published versions to your groups",
  detail: "Give the Agent, the Cluster or a gateway pool a published version on the Groups tab.",
};
export const KUBERNETES_INSTALL_STEP = {
  title: "Install a group with Helm",
  detail: "Download a group's values.yaml and run its helm upgrade --install against your cluster.",
};
export const KUBERNETES_CONNECT_STEP = {
  title: "First collector connects",
  detail: "Once the Helm release is installed, each pod's supervisor authenticates with the fleet token and appears in the Collectors tab.",
  waitingDetail: "Waiting for the first pod to check in. This page checks automatically every 15 seconds.",
  waitingLabel: "Listening for the first check-in…",
};

export const CONNECT_STEP = {
  title: "First collector connects",
  detail: "Once installed, the collector authenticates with the fleet token and appears in the Collectors tab, usually within a minute.",
  waitingDetail: "Waiting for the collector to connect. This page checks automatically every 15 seconds.",
  waitingLabel: "Listening for the first check-in…",
};

interface StepProps {
  index: number;
  title: string;
  detail: string;
  done: boolean;
  action?: { label: string; onClick: (from: HTMLElement) => void; ref?: Ref<HTMLButtonElement> } | undefined;
  waitingLabel?: string | undefined;
  /** Why the step's data couldn't be read: shown under its detail (its action then "Try again"). */
  problem?: string | undefined;
}

function Step({ index, title, detail, done, action, waitingLabel, problem }: StepProps) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      {done ? (
        <span className="mt-px flex h-4 w-4 items-center justify-center rounded-full bg-ok-soft">
          <Check className="h-3 w-3 text-ok" aria-hidden="true" />
          <span className="sr-only">Done:</span>
        </span>
      ) : (
        <span className="mt-px flex h-4 w-4 items-center justify-center rounded-full border border-border font-mono text-[10px] text-muted-foreground tabular-nums">
          {index}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p
          className={
            done
              ? "text-[13px] font-medium text-muted-foreground line-through decoration-muted-foreground/40"
              : "text-[13px] font-medium text-foreground"
          }
        >
          {title}
        </p>
        {!done && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
        {!done && problem !== undefined && <p className="mt-0.5 text-xs text-fail">{problem}</p>}
        {!done && waitingLabel !== undefined && (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
            />
            {waitingLabel}
          </div>
        )}
      </div>
      {!done && action !== undefined && (
        <Button
          ref={action.ref}
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={(event) => action.onClick(event.currentTarget)}
        >
          {action.label}
        </Button>
      )}
    </li>
  );
}

/** The sign-up prompt's words for a server fleet's "Assign" in the playground. */
export const ASSIGN_LOCKED_WORDS = "assign a configuration to a group";

export interface SetupChecklistProps {
  fleet: FleetDetail;
  /** Whether a reveal or a download succeeded in this visit (the route's). */
  installStarted: boolean;
  /** "Install": the route opens the install dialog for the Default group (a Kubernetes fleet's: the Helm dialog); `from` the button pressed. */
  onInstall: (from: HTMLElement) => void;
  /** A Kubernetes fleet's "Assign": the route chooses the Groups tab. */
  onGroupsTab?: (() => void) | undefined;
  /** Reopened from the header: the close button "Hide setup guide". Absent while the fleet has no collectors. */
  onDismiss?: (() => void) | undefined;
  /** A count the route moves when the groups changed elsewhere: the checklist reads them again. */
  groupsChanged: number;
  /** After the checklist's own assignment: the Groups tab reads its groups again. */
  onGroupsChanged: () => void;
  /** The route's `useFleet().reload`: after an assignment, and when a groups read finds the fleet gone. */
  onFleetChanged: () => void;
  /** Where the focus goes when the group dialog closes and "Assign" is gone. */
  fallback: FocusFallback;
}

export function SetupChecklist({
  fleet,
  installStarted,
  onInstall,
  onGroupsTab,
  onDismiss,
  groupsChanged,
  onGroupsChanged,
  onFleetChanged,
  fallback,
}: SetupChecklistProps) {
  // Quiet: a read failing over groups shown never toasts (the Groups tab's toasts it); with none, step 1 says so.
  const groupsRead = useGroupsTab(fleet.id, { onFleetGone: onFleetChanged, quiet: true });
  const { groups } = groupsRead;
  const organizationId = useCurrentUser()?.organization.id ?? null;

  // The groups changed elsewhere (the install dialog's Assign): read again. Not on the first render.
  const seenChange = useRef(groupsChanged);
  const { reload } = groupsRead;
  useEffect(() => {
    if (seenChange.current === groupsChanged) return;
    seenChange.current = groupsChanged;
    reload();
  }, [groupsChanged, reload]);

  const focus = useReturnFocus();
  const locked = useLockedAction();
  const installButton = useRef<HTMLButtonElement>(null);
  // The Default group's dialog, for the organization it was opened in; another organization closes it.
  const [assign, setAssign] = useState<{ group: CollectorGroup; organizationId: string } | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  if (assignOpen && assign !== null && assign.organizationId !== organizationId) setAssignOpen(false);

  const kubernetes = fleet.type === "kubernetes-supervisor";
  const defaultGroup = groups?.find((group) => group.isDefault) ?? null;
  // Every server install entry opens the Default group, and an install needs its published version; a Kubernetes
  // fleet's Helm dialog installs any group with one.
  const assigned = kubernetes ? (groups?.some((group) => group.assignedVersion !== null) ?? false) : defaultGroup?.assignedVersion != null;
  const connected = fleet.summary.collectors > 0;
  const installDone = installStarted || connected;
  const steps = kubernetes
    ? { assign: KUBERNETES_ASSIGN_STEP, install: KUBERNETES_INSTALL_STEP, connect: KUBERNETES_CONNECT_STEP }
    : { assign: ASSIGN_STEP, install: INSTALL_STEP, connect: CONNECT_STEP };

  return (
    <section aria-label="Fleet setup" className="rounded-lg border border-border bg-card px-4 py-2">
      <div className="flex items-center justify-between gap-2 border-b border-border py-2">
        <h2 className="tf-label">{CHECKLIST_TITLE}</h2>
        {onDismiss !== undefined ? (
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label="Hide setup guide"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">{CHECKLIST_HINT}</span>
        )}
      </div>
      <ol className="divide-y divide-border">
        <Step
          index={1}
          {...steps.assign}
          done={assigned}
          problem={groupsRead.failed ? GROUPS_LOAD_FAILED_MESSAGE : undefined}
          action={
            groupsRead.failed
              ? { label: "Try again", onClick: () => groupsRead.reload() }
              : kubernetes
              ? onGroupsTab !== undefined
                ? { label: "Assign", onClick: () => onGroupsTab() }
                : undefined
              : defaultGroup !== null && organizationId !== null
              ? {
                  label: "Assign",
                  onClick: (from) => {
                    // Locked in the playground: the sign-up prompt, not the group dialog. Install is the route's (locked there).
                    if (locked !== null) {
                      locked(ASSIGN_LOCKED_WORDS, from);
                      return;
                    }
                    focus.opened(from, () => installButton.current ?? fallback());
                    setAssign({ group: defaultGroup, organizationId });
                    setAssignOpen(true);
                  },
                }
              : undefined
          }
        />
        <Step index={2} {...steps.install} done={installDone} action={{ label: "Install", onClick: onInstall, ref: installButton }} />
        <Step
          index={3}
          title={steps.connect.title}
          detail={installDone ? steps.connect.waitingDetail : steps.connect.detail}
          done={connected}
          waitingLabel={installDone && !connected ? steps.connect.waitingLabel : undefined}
        />
      </ol>
      <GroupDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        group={assign?.group ?? null}
        organizationId={assign?.organizationId ?? ""}
        fleetId={fleet.id}
        onChanged={() => {
          reload();
          onGroupsChanged();
          onFleetChanged();
        }}
        onCloseAutoFocus={focus.returnFocus}
      />
    </section>
  );
}
