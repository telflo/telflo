import { useCallback, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { Bot, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH, type ServiceAccount, type ServiceAccountsResponse } from "@telflo/contracts";
import { ApiReferenceNote } from "~/components/settings/ApiReferenceNote.js";
import { ServiceAccountDeleteDialog } from "~/components/settings/ServiceAccountDeleteDialog.js";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { createServiceAccount, getServiceAccounts, isSessionEnded } from "~/lib/api-client.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { isManagementLost, useLeaveManagement } from "~/lib/organizations.js";
import {
  SERVICE_ACCOUNT_CREATE_FAILED_MESSAGE,
  SERVICE_ACCOUNT_CREATED_MESSAGE,
  SERVICE_ACCOUNTS_LOAD_FAILED_MESSAGE,
  SERVICE_ACCOUNTS_UNREADABLE,
  formatServiceAccountDate,
  isServiceAccountRefusal,
  serviceAccountFailureMessage,
  useServiceAccountRead,
} from "~/lib/service-accounts.js";

/*
 * Settings › Service Accounts (D22 decisions 41, 42 and 49; ADR 0018):
 *
 * - The intro card "About service accounts", "deleting the old" now
 *   "revoking the old" (Q131), and D25's "API reference" link (default 14;
 *   decision 49): a plain `<a>` to the API's own page (ApiReferenceNote).
 * - The card "Service Accounts" with "Create service account"; the columns
 *   Name (a link to the account's page, by id), Created, Created by (the
 *   creator's address, or "—"), Tokens, and a Delete per row, named through
 *   `aria-labelledby` by "Delete service account" and the row's name cell
 *   (no `aria-label` holds the name). A plain `<table>`, as the
 *   fleet tables (Preflight ruling 30).
 * - "Loading…"; "No service accounts yet."; a failed first read toasts
 *   "Failed to load service accounts" and says "Service accounts could not
 *   be loaded." rather than the empty state (Preflight ruling 30).
 * - Create: the name typed inside `ph-no-capture`, uncontrolled (React
 *   writes a controlled input's value into its `value` attribute: Preflight
 *   ruling 25), read from the form on submit; Create is enabled once a name
 *   is typed. Success toasts "Service account created" and reads the list
 *   again; a refusal toasts its fixed message and keeps the dialog; an
 *   answer that never came reads the list again (the account may exist).
 * - A refusal saying management is lost leaves through `useLeaveManagement`.
 */

const HEAD_CLASS =
  "h-9 whitespace-nowrap px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground";
const CELL_CLASS = "px-3 py-2.5 align-middle";
const ROW_CLASS = "border-b transition-colors hover:bg-muted/40";

function ServiceAccountsIntro() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-gradient-to-br from-primary/[0.06] to-transparent">
      <div className="flex gap-3.5 p-4 sm:p-5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
          <Bot className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="space-y-2.5 text-[13px] leading-relaxed text-muted-foreground">
          <p className="text-sm font-medium text-foreground">About service accounts</p>
          <p>
            A service account is a machine identity in this organization. Anything it creates through the Telflo API belongs
            to it, so activity stays attributable to the integration rather than to a person.
          </p>
          <p>
            Each account holds one or more API tokens. Rotate a token by adding a new one and revoking the old, without
            changing who the API acts as.
          </p>
          <ApiReferenceNote />
          <p className="flex items-start gap-1.5 font-medium text-foreground">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
            <span>Tokens are credentials for service account access&mdash;treat them with care.</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export function ServiceAccountsSection({ organizationId }: { organizationId: string }) {
  const id = useId();
  const load = useCallback((signal: AbortSignal) => getServiceAccounts(organizationId, { signal }), [organizationId]);
  const { read, reload } = useServiceAccountRead<ServiceAccountsResponse>(load, SERVICE_ACCOUNTS_LOAD_FAILED_MESSAGE);
  const [createOpen, setCreateOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ServiceAccount | null>(null);

  return (
    <div className="space-y-4">
      <ServiceAccountsIntro />
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4" aria-hidden="true" />
              Service Accounts
            </CardTitle>
            <CardDescription>Machine identities for the Telflo public API, scoped to this organization.</CardDescription>
          </div>
          <Button type="button" onClick={() => setCreateOpen(true)} className="shrink-0 gap-1.5">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Create service account
          </Button>
        </CardHeader>
        <CardContent>
          {read.kind === "loading" ? (
            <p role="status" className="py-8 text-center text-[13px] text-muted-foreground">
              Loading…
            </p>
          ) : read.kind !== "read" ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">{SERVICE_ACCOUNTS_UNREADABLE}</p>
          ) : read.value.items.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">No service accounts yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="relative w-full overflow-auto">
                <table className="w-full caption-bottom text-[13px]">
                  <thead className="[&_tr]:border-b">
                    <tr className={ROW_CLASS}>
                      <th className={HEAD_CLASS}>Name</th>
                      <th className={HEAD_CLASS}>Created</th>
                      <th className={HEAD_CLASS}>Created by</th>
                      <th className={HEAD_CLASS}>Tokens</th>
                      <th className={HEAD_CLASS}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="[&_tr:last-child]:border-0">
                    {read.value.items.map((account) => {
                      const rowId = `${id}-service-account-${account.id}`;
                      return (
                        <tr key={account.id} className={ROW_CLASS}>
                          <td className={CELL_CLASS}>
                            <Link
                              id={`${rowId}-name`}
                              to={`/settings/service-accounts/${encodeURIComponent(account.id)}`}
                              className="font-medium text-primary underline-offset-2 hover:underline"
                            >
                              {account.name}
                            </Link>
                          </td>
                          <td className={CELL_CLASS}>
                            <span className="text-xs tabular-nums text-muted-foreground">{formatServiceAccountDate(account.createdAt)}</span>
                          </td>
                          <td className={CELL_CLASS}>
                            <span className="text-xs text-muted-foreground">{account.createdBy?.email ?? "—"}</span>
                          </td>
                          <td className={CELL_CLASS}>
                            <span className="text-xs tabular-nums">{account.tokenCount}</span>
                          </td>
                          <td className={CELL_CLASS}>
                            <div className="flex justify-end">
                              <span id={`${rowId}-delete`} className="sr-only" hidden>
                                Delete service account
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-fail"
                                aria-labelledby={`${rowId}-delete ${rowId}-name`}
                                onClick={() => setToDelete(account)}
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateServiceAccountDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        organizationId={organizationId}
        onCreated={() => reload()}
        onUnknownOutcome={() => reload()}
      />
      <ServiceAccountDeleteDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        organizationId={organizationId}
        target={toDelete}
        onDeleted={() => {
          setToDelete(null);
          reload();
        }}
      />
    </div>
  );
}

interface CreateServiceAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  /** After a create: the list reads again, for the server's columns. */
  onCreated: () => void;
  /** A create whose answer never came (no connection, a server error): the account may exist. */
  onUnknownOutcome: () => void;
}

/**
 * "Create service account" (decision 42): the name typed inside
 * ph-no-capture, never in an attribute. Each opening is a new session
 * (`useOpeningKey`): an empty field, Create disabled.
 */
function CreateServiceAccountDialog(props: CreateServiceAccountDialogProps) {
  const opening = useOpeningKey(props.open);
  return <CreateServiceAccountSession key={opening} {...props} />;
}

function CreateServiceAccountSession({ open, onOpenChange, organizationId, onCreated, onUnknownOutcome }: CreateServiceAccountDialogProps) {
  const id = useId();
  const leaveManagement = useLeaveManagement();
  const isStillCurrent = useStillCurrent(organizationId);
  const [hasName, setHasName] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  // Unclosable while it creates: the answer decides what happens next.
  const changeOpen = (next: boolean) => {
    if (!creatingRef.current) onOpenChange(next);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingRef.current) return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (name === "") return;
    creatingRef.current = true;
    setCreating(true);
    const sentIn = organizationId;
    try {
      await createServiceAccount(sentIn, { name });
      if (!isStillCurrent(sentIn)) return;
      onOpenChange(false);
      toast.success(SERVICE_ACCOUNT_CREATED_MESSAGE);
      onCreated();
    } catch (failure) {
      if (!isStillCurrent(sentIn) || isSessionEnded(failure)) return;
      if (isManagementLost(failure)) {
        onOpenChange(false);
        leaveManagement(failure);
        return;
      }
      toast.error(serviceAccountFailureMessage(failure, SERVICE_ACCOUNT_CREATE_FAILED_MESSAGE));
      if (!isServiceAccountRefusal(failure)) onUnknownOutcome();
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const nameId = `${id}-name`;
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create service account</DialogTitle>
            <DialogDescription>Give the account a name that says what uses it. You can add tokens to it afterwards.</DialogDescription>
          </DialogHeader>
          <div className="ph-no-capture space-y-1.5 py-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              name="name"
              maxLength={SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH}
              placeholder="e.g. CI pipeline"
              autoComplete="off"
              autoFocus
              readOnly={creating}
              onInput={(event) => setHasName(event.currentTarget.value.trim() !== "")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !hasName}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
