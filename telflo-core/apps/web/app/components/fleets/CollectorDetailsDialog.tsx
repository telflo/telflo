import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import type { Collector, CollectorGroup, FleetType, PublishedVersion } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { ApiError } from "~/lib/api-client.js";
import { collectorNodeName } from "~/lib/collectors.js";
import { isOrganizationGone, isTermsAcceptanceRequired } from "~/lib/configurations.js";
import { FLEET_READ_TIMEOUT_MS, isFleetGone } from "~/lib/fleets.js";
import { formatDateTime, formatRelativeTime } from "~/lib/format.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useOpeningReads } from "~/lib/hooks/use-opening-reads.js";
import { groupLabel } from "~/lib/kubernetes-groups.js";
import { UNNAMED_VARIABLE_GROUP, useVariableGroupNames } from "~/lib/variable-group-display.js";
import { readsFor } from "~/lib/workspace-reads.js";
import { CollectorAttributes } from "./CollectorAttributes.js";
import {
  ERROR_HISTORY_FAILED_MESSAGE,
  ERROR_HISTORY_PAGE_SIZE,
  ERROR_MESSAGE_LABEL,
  CollectorErrorHistory,
  type ErrorHistoryRead,
} from "./CollectorErrorHistory.js";
import { COLLECTOR_CONFIGURATION_LABELS, DRIFT_DOT_CLASSES, UNASSIGNED_COLLECTOR_MEANING } from "./CollectorConfigurationCell.js";
import { LIVENESS_DOT_CLASSES, LIVENESS_LABELS, LIVENESS_MEANINGS, StatusDot } from "./CollectorStatusCell.js";
import { CollectorTokenRow, type TokensRead } from "./CollectorTokenRow.js";
import { collectorAddress, servedForm, VERSION_MEANINGS } from "./CollectorsTable.js";
import { DRIFT_MEANINGS } from "./ConfigurationSyncCell.js";
import { PublishedVersionLink } from "./PublishedVersionLink.js";
import { NO_PINNED_WORDS, VariableGroupLink } from "./VariableGroupLink.js";

/*
 * A collector's details (D17b-1 decisions 22, 24, 25 and 32; Preflight
 * rulings 4, 11 and 17): a Dialog opened from the grid's Name button, the
 * collector's name its title and "Collector details" its description, a
 * two-column grid of `DetailRow`s. In the D17b-1 Parity Notes:
 *
 * - Shown at once from the grid's row, then refreshed from `GET
 *   …/collectors/{c}`; a 404 for the collector toasts "Collector not found",
 *   closes and reloads the grid and the fleet (`onCollectorGone`, so the
 *   strip and the total follow; a fleet found gone the same, without the
 *   toast: the grid's read shows "Fleet not found"); the organization's or
 *   the terms' refusal closes and revalidates the layout; any other failure
 *   keeps the row's data.
 * - Three reads on opening, the collector, the fleet's tokens (the Token
 *   row) and the first 20 errors, each under its own 10 s hang guard, and
 *   every read (a "Load more" too) aborted when the dialog closes; each
 *   opening is a new session (`useOpeningKey`), so nothing of an earlier
 *   one's reads reaches it.
 * - Rows: "UID"; Status from the server's `liveness` (Online, Warning,
 *   Unknown, Offline) and Configuration from its `drift` (In sync, …, Nothing
 *   assigned), as the grid's two columns (D17d-2 Ruling 55, the owner's Q58:
 *   Status had been the drift, the liveness a dot beside Last Seen), each
 *   with its meaning as text (a touch user sees no tooltip); Token by the
 *   opamp-server's rule (`CollectorTokenRow`); "Configuration name" (named so
 *   by Ruling 55, "Configuration" being the drift's row); Pin, Applied and
 *   Created (new); Last Seen's relative and full time as text, no dot. No
 *   collector-version drift colour (D19's).
 * - D20 (default 25): "Pinned variable group" (the collector's own, by name
 *   inside `ph-no-capture`, else "None: follows its group") and "Variable
 *   group" (the effective one: the pin's, else its group's, else
 *   "Organization values", opening each variable's value and where it comes
 *   from, `VariableGroupLink`), after Pin.
 * - Error (the controller's ruling after Task 5's review): the current
 *   apply's error (`effective.error`) in a `<pre>` inside `ph-no-capture`, at
 *   most 12rem tall and scrolling, focusable so a keyboard scrolls it (an
 *   apply error can run to kilobytes), named by the fixed "Error message"
 *   (never its text), else a dash. The error history keeps a collector's
 *   errors 30 days only, so a collector still failing an old apply would
 *   otherwise show "Failed" beside "No errors reported.".
 * - Then the error history and the reported attributes, each in
 *   `ph-no-capture` (new). Pin, Target Version and Effective Version show a
 *   published version as "{configurationName} @v{n}" (D17c-1 decision 46: the
 *   two version rows linked, the whole name, no tooltip) or their empty
 *   forms; no imported configuration (D16c decision 9: importing removed).
 *   Effective Version's meaning, the grid's Version tooltip's
 *   (`VERSION_MEANINGS`, D16c Ruling 21), is text under it, as Status's.
 * - No `title` attribute anywhere, and no collector, group or configuration
 *   name, address, attribute or error text in any attribute: text only, in
 *   the masked shell.
 * - On a Kubernetes-supervisor fleet (D17d-1 decision 23; Preflight ruling
 *   26): a **Node** row after UID, the reported `k8s.node.name`
 *   (`collectorNodeName`: an own key only) inside `ph-no-capture`, as the
 *   reported attributes, else a dash; the Group row names the Agent and the
 *   Cluster by their roles (`groupLabel`), a gateway by its name.
 * - The footer's "Edit collector" closes the details and hands the
 *   collector to `onEdit`: the tab opens the edit dialog
 *   (`EditCollectorDialog`).
 */

/** The refresh's 404 for the collector: its toast. */
export const COLLECTOR_NOT_FOUND_MESSAGE = "Collector not found";

/** A version reference the platform no longer holds (`version` null). */
export const DELETED_VERSION_WORDS = "A deleted configuration's version";

const APPLIED_WORDS: Record<NonNullable<Collector["effective"]>["status"], string> = {
  applied: "Applied",
  applying: "Applying",
  failed: "Failed",
};

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

/**
 * A published version reference: "{configurationName} @v{n}" linked to the
 * editor's version, the whole name and no tooltip (`PublishedVersionLink`
 * in a dialog: D17c-1 decision 46, Preflight ruling 32), or the deleted words
 * when the platform holds none.
 */
function VersionReference({ version }: { version: PublishedVersion | null }) {
  if (version === null) return <span className="text-muted-foreground">{DELETED_VERSION_WORDS}</span>;
  return <PublishedVersionLink version={version} variant="dialog" />;
}

/** Target Version: what resolves for the collector. */
function TargetVersion({ resolution }: { resolution: Collector["resolution"] }) {
  if (resolution === null) return DASH;
  return <VersionReference version={resolution.version} />;
}

/** Effective Version: what the collector was served (or found already running), its meaning under it (D16c Ruling 21). */
function EffectiveVersion({ served }: { served: Collector["served"] }) {
  return (
    <>
      {served === null ? DASH : <VersionReference version={served.version} />}
      <p className="mt-0.5 text-xs text-muted-foreground">{VERSION_MEANINGS[servedForm(served)]}</p>
    </>
  );
}

/** The Pin row's words (Preflight ruling 11): a version as "{configurationName} @v{n}", as the version rows (D17c-1 Preflight ruling 32). */
export function pinWords(pin: Collector["pin"]): string {
  if (pin === null) return "None: follows its group";
  if (pin.versionId === null || pin.version === null) return DELETED_VERSION_WORDS;
  return `${pin.version.configurationName} @v${pin.version.versionNumber}`;
}

/** A meaning as a sentence: its first letter capitalised, a full stop at its end. */
function sentence(meaning: string): string {
  return meaning.charAt(0).toUpperCase() + meaning.slice(1) + (meaning.endsWith(".") ? "" : ".");
}

/** The Status row's meaning, as text: the liveness's window, as the server reckons it. */
export function statusMeaning(liveness: Collector["liveness"]): string {
  return sentence(LIVENESS_MEANINGS[liveness]);
}

/** The Configuration row's meaning, as text: D17a's legend's, but for unassigned's (Preflight ruling 4). */
export function configurationMeaning(drift: Collector["drift"]): string {
  return sentence(drift === "unassigned" ? UNASSIGNED_COLLECTOR_MEANING : DRIFT_MEANINGS[drift]);
}

export interface CollectorDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The grid's row, shown at once; null renders nothing to read. */
  collector: Collector | null;
  /** The organization the collector was opened in. */
  organizationId: string;
  fleetId: string;
  /** The fleet's groups, for the Group row; null while none has been read (a dash). */
  groups: CollectorGroup[] | null;
  /** The fleet's type: a Kubernetes fleet's details add the Node row and name the Agent and the Cluster by role. */
  fleetType?: FleetType;
  /** The refresh found the collector (or the fleet) gone: the grid reads its page again, and the route its fleet. */
  onCollectorGone: () => void;
  /** The footer's "Edit collector": the details close and the edit dialog opens. */
  onEdit?: ((collector: Collector) => void) | undefined;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the host gives it back to the opener (D14b Ruling 46). */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: nothing of an earlier one's reads carries over. */
export function CollectorDetailsDialog(props: CollectorDetailsDialogProps) {
  const opening = useOpeningKey(props.open);
  return <CollectorDetailsSession key={opening} {...props} />;
}

function CollectorDetailsSession({
  open,
  onOpenChange,
  collector: row,
  organizationId,
  fleetId,
  groups,
  fleetType = "server",
  onCollectorGone,
  onEdit,
  onCloseAutoFocus,
}: CollectorDetailsDialogProps) {
  const { revalidate } = useRevalidator();
  const read = useOpeningReads(open, FLEET_READ_TIMEOUT_MS);
  const [refreshed, setRefreshed] = useState<Collector | null>(null);
  const [tokens, setTokens] = useState<TokensRead>({ state: "loading" });
  const [history, setHistory] = useState<ErrorHistoryRead>({ state: "loading" });
  const collectorId = row?.id ?? null;

  const readFirstErrors = useCallback(
    async (id: string) => {
      setHistory({ state: "loading" });
      const answer = await read((signal) =>
        readsFor(organizationId).getCollectorErrors(organizationId, fleetId, id, { limit: ERROR_HISTORY_PAGE_SIZE }, { signal }),
      );
      if (answer === null) return;
      setHistory(
        answer.ok
          ? { state: "read", errors: answer.value.errors, nextCursor: answer.value.nextCursor, loadingMore: false }
          : { state: "failed" },
      );
    },
    [read, organizationId, fleetId],
  );

  useEffect(() => {
    if (!open || collectorId === null) return;
    void read((signal) => readsFor(organizationId).getCollector(organizationId, fleetId, collectorId, { signal })).then((answer) => {
      if (answer === null) return;
      if (answer.ok) {
        setRefreshed(answer.value);
        return;
      }
      const { error } = answer;
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
        onOpenChange(false);
        void revalidate();
        return;
      }
      const collectorGone = error instanceof ApiError && error.code === "collector_not_found";
      if (collectorGone || isFleetGone(error)) {
        if (collectorGone) toast.error(COLLECTOR_NOT_FOUND_MESSAGE);
        onOpenChange(false);
        onCollectorGone();
      }
      // Any other failure keeps the row's data.
    });
    void read((signal) => readsFor(organizationId).getEnrollmentTokens(organizationId, fleetId, { signal })).then((answer) => {
      if (answer === null) return;
      setTokens(answer.ok ? { state: "read", tokens: answer.value.tokens } : { state: "failed" });
    });
    void readFirstErrors(collectorId);
    // One set of reads per opening: the session is keyed by it, and `open` turns false only to close it.
  }, [open]);

  const loadMore = async () => {
    if (collectorId === null || history.state !== "read" || history.nextCursor === null || history.loadingMore) return;
    const cursor = history.nextCursor;
    setHistory({ ...history, loadingMore: true });
    const answer = await read((signal) =>
      readsFor(organizationId).getCollectorErrors(organizationId, fleetId, collectorId, { limit: ERROR_HISTORY_PAGE_SIZE, cursor }, { signal }),
    );
    if (answer === null) return;
    if (answer.ok) {
      setHistory((current) =>
        current.state === "read"
          ? {
              state: "read",
              errors: [...current.errors, ...answer.value.errors],
              nextCursor: answer.value.nextCursor,
              loadingMore: false,
            }
          : current,
      );
      return;
    }
    toast.error(ERROR_HISTORY_FAILED_MESSAGE);
    setHistory((current) => (current.state === "read" ? { ...current, loadingMore: false } : current));
  };

  const shown = refreshed ?? row;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        {shown !== null && (
          <CollectorDetailsBody
            collector={shown}
            groups={groups}
            fleetType={fleetType}
            tokens={tokens}
            history={history}
            onRetryErrors={() => void readFirstErrors(shown.id)}
            onLoadMore={() => void loadMore()}
            onEdit={() => {
              if (onEdit === undefined) return;
              onOpenChange(false);
              onEdit(shown);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface CollectorDetailsBodyProps {
  collector: Collector;
  groups: CollectorGroup[] | null;
  fleetType: FleetType;
  tokens: TokensRead;
  history: ErrorHistoryRead;
  onRetryErrors: () => void;
  onLoadMore: () => void;
  onEdit: () => void;
}

function CollectorDetailsBody({
  collector,
  groups,
  fleetType,
  tokens,
  history,
  onRetryErrors,
  onLoadMore,
  onEdit,
}: CollectorDetailsBodyProps) {
  const now = Date.now();
  const address = collectorAddress(collector);
  const group = groups?.find((each) => each.id === collector.groupId);
  const groupName = group === undefined ? undefined : groupLabel(group, fleetType);
  const node = collectorNodeName(collector.reported.attributes);
  const configurationName = collector.resolution?.version?.configurationName ?? null;
  const { effective } = collector;
  const variableGroupNames = useVariableGroupNames([collector.pinnedVariableGroupId]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{collector.name}</DialogTitle>
        <DialogDescription>Collector details</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-2.5">
        <DetailRow label="IP Address">
          {address === null ? DASH : <span className="font-mono text-xs">{address}</span>}
        </DetailRow>
        <DetailRow label="Name">{collector.name}</DetailRow>
        <DetailRow label="UID">
          <span className="font-mono text-xs">{collector.instanceUid}</span>
        </DetailRow>
        {fleetType === "kubernetes-supervisor" && (
          <DetailRow label="Node">
            <div className="ph-no-capture">{node === null ? DASH : <span className="font-mono text-xs">{node}</span>}</div>
          </DetailRow>
        )}
        <DetailRow label="Group">{groupName === undefined ? DASH : groupName}</DetailRow>
        <DetailRow label="Status">
          <span className="inline-flex items-center gap-2">
            <StatusDot className={LIVENESS_DOT_CLASSES[collector.liveness]} />
            {LIVENESS_LABELS[collector.liveness]}
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground">{statusMeaning(collector.liveness)}</p>
        </DetailRow>
        <DetailRow label="Configuration">
          <span className="inline-flex items-center gap-2">
            <StatusDot className={DRIFT_DOT_CLASSES[collector.drift]} />
            {COLLECTOR_CONFIGURATION_LABELS[collector.drift]}
          </span>
          <p className="mt-0.5 text-xs text-muted-foreground">{configurationMeaning(collector.drift)}</p>
        </DetailRow>
        <DetailRow label="Token">
          <CollectorTokenRow tokenId={collector.enrollmentTokenId} tokens={tokens} now={now} />
        </DetailRow>
        <DetailRow label="Configuration name">{configurationName === null ? DASH : configurationName}</DetailRow>
        <DetailRow label="Pin">
          {collector.pin === null ? (
            <span className="text-muted-foreground">{pinWords(null)}</span>
          ) : (
            pinWords(collector.pin)
          )}
        </DetailRow>
        <DetailRow label="Pinned variable group">
          {collector.pinnedVariableGroupId === null ? (
            <span className="text-muted-foreground">{NO_PINNED_WORDS}</span>
          ) : (
            <span className="ph-no-capture">{variableGroupNames.get(collector.pinnedVariableGroupId) ?? UNNAMED_VARIABLE_GROUP}</span>
          )}
        </DetailRow>
        <DetailRow label="Variable group">
          <VariableGroupLink
            pinnedVariableGroupId={collector.pinnedVariableGroupId}
            groupVariableGroupId={group === undefined ? undefined : group.variableGroupId}
          />
        </DetailRow>
        <DetailRow label="Target Version">
          <TargetVersion resolution={collector.resolution} />
        </DetailRow>
        <DetailRow label="Effective Version">
          <EffectiveVersion served={collector.served} />
        </DetailRow>
        <DetailRow label="Applied">
          {effective === null ? DASH : `${APPLIED_WORDS[effective.status]} ${formatRelativeTime(effective.at, now)}`}
        </DetailRow>
        <DetailRow label="Collector">
          {collector.reported.collectorVersion === null ? (
            DASH
          ) : (
            <span className="font-mono text-xs">v{collector.reported.collectorVersion}</span>
          )}
        </DetailRow>
        <DetailRow label="Error">
          {effective === null || effective.error === null ? (
            DASH
          ) : (
            <div className="ph-no-capture">
              {/* Bounded: a long error scrolls in place; tabIndex lets a keyboard scroll it; a named group, not a landmark. */}
              <pre
                role="group"
                tabIndex={0}
                aria-label={ERROR_MESSAGE_LABEL}
                className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs"
              >
                {effective.error}
              </pre>
            </div>
          )}
        </DetailRow>
        <DetailRow label="Last Seen">
          {formatRelativeTime(collector.lastSeenAt, now)}
          <p className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(collector.lastSeenAt)}</p>
        </DetailRow>
        <DetailRow label="Created">{formatDateTime(collector.createdAt)}</DetailRow>
      </div>
      <CollectorErrorHistory history={history} onRetry={onRetryErrors} onLoadMore={onLoadMore} />
      <CollectorAttributes attributes={collector.reported.attributes} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onEdit}>
          <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
          Edit collector
        </Button>
      </DialogFooter>
    </>
  );
}
