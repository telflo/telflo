import { useCallback, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Bot, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH, type ApiToken, type ServiceAccount } from "@telflo/contracts";
import { ApiTokenRevealDialog } from "~/components/settings/ApiTokenRevealDialog.js";
import { ApiTokensTable } from "~/components/settings/ApiTokensTable.js";
import { CreateApiTokenDialog } from "~/components/settings/CreateApiTokenDialog.js";
import { RevokeApiTokenDialog } from "~/components/settings/RevokeApiTokenDialog.js";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { getApiTokens, getServiceAccount, isSessionEnded, renameServiceAccount } from "~/lib/api-client.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { isManagementLost, useLeaveManagement } from "~/lib/organizations.js";
import {
  API_TOKENS_REFRESH_FAILED_MESSAGE,
  SERVICE_ACCOUNT_LOAD_FAILED_MESSAGE,
  SERVICE_ACCOUNT_RENAME_FAILED_MESSAGE,
  SERVICE_ACCOUNT_RENAMED_MESSAGE,
  SERVICE_ACCOUNT_UNREADABLE,
  formatServiceAccountDate,
  serviceAccountFailureMessage,
  useServiceAccountRead,
} from "~/lib/service-accounts.js";

/*
 * A service account's page:
 *
 * - The back link "Service Accounts"; "Loading…"; "Service account not
 *   found." for `404 service_account_not_found`; a failed first read toasts
 *   "Failed to load service account" and says "The service account could
 *   not be loaded."
 * - The header: the name, the address in mono, "Rename"; Created, Created
 *   by, Tokens (the listed tokens' count).
 * - Rename: the field inside `ph-no-capture`, uncontrolled, prefilled by
 *   setting its `value` property from a ref as it opens (React writes a
 *   controlled input's value, or a `defaultValue`, into the `value`
 *   attribute). Save is enabled while a name is there. Success toasts "Service
 *   account renamed" and reads the page again.
 * - API Tokens: the account's tokens not revoked, newest first, with Name,
 *   Prefix (`tf_AbC12xYz…`), Access ("Read & Write" or "Read"), Expires (a
 *   date or "Never", and "Expired" by the API's clock), Last used (a date
 *   or "Never"), Created, and a Revoke per row named through
 *   `aria-labelledby` by "Revoke token" and the row's name cell (no
 *   `aria-label` holds the name). A plain `<table>`, ApiTokensTable,
 *   shared with the Account page's own tokens.
 * - "Create token" opens CreateApiTokenDialog; its reply's token is held in
 *   this page's state for ApiTokenRevealDialog alone, dropped however the
 *   reveal closes, and the list is read again then, not while the token is
 *   shown (a read that lost management while the reveal was open would
 *   navigate away with it). That read failing toasts "Token created, but
 *   the list could not refresh".
 * - The page is keyed by the organization and the account (the route's),
 *   so an answer for an account no longer shown lands nowhere.
 */

type AccountPage = { account: ServiceAccount; tokens: ApiToken[] };

function BackLink() {
  return (
    <Link
      to="/settings/service-accounts"
      className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Service Accounts
    </Link>
  );
}

export interface ServiceAccountDetailSectionProps {
  organizationId: string;
  serviceAccountId: string;
}

export function ServiceAccountDetailSection({ organizationId, serviceAccountId }: ServiceAccountDetailSectionProps) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<AccountPage> => {
      const [{ serviceAccount }, { items }] = await Promise.all([
        getServiceAccount(organizationId, serviceAccountId, { signal }),
        getApiTokens(organizationId, serviceAccountId, { signal }),
      ]);
      return { account: serviceAccount, tokens: items };
    },
    [organizationId, serviceAccountId],
  );
  const { read, reload } = useServiceAccountRead<AccountPage>(load, SERVICE_ACCOUNT_LOAD_FAILED_MESSAGE);

  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // The created token, from the create's reply, for the reveal alone.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiToken | null>(null);

  if (read.kind !== "read") {
    return (
      <div className="space-y-4">
        <BackLink />
        <p role={read.kind === "loading" ? "status" : undefined} className="py-8 text-center text-[13px] text-muted-foreground">
          {read.kind === "loading" ? "Loading…" : read.kind === "not_found" ? "Service account not found." : SERVICE_ACCOUNT_UNREADABLE}
        </p>
      </div>
    );
  }

  const { account, tokens } = read.value;
  return (
    <div className="space-y-4">
      <BackLink />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="break-all">{account.name}</span>
            </CardTitle>
            <CardDescription className="break-all font-mono text-xs">{account.email}</CardDescription>
          </div>
          <Button type="button" variant="outline" className="shrink-0 gap-1.5" onClick={() => setRenameFrom(account.name)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Rename
          </Button>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-3">
            <div>
              <dt className="tf-label">Created</dt>
              <dd className="tabular-nums">{formatServiceAccountDate(account.createdAt)}</dd>
            </div>
            <div>
              <dt className="tf-label">Created by</dt>
              <dd className="break-all">{account.createdBy?.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="tf-label">Tokens</dt>
              <dd className="tabular-nums">{tokens.length}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>API Tokens</CardTitle>
            <CardDescription>Bearer tokens that authenticate as this service account. A token is shown only once when created.</CardDescription>
          </div>
          <Button type="button" onClick={() => setCreateOpen(true)} className="shrink-0 gap-1.5">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Create token
          </Button>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">No tokens yet.</p>
          ) : (
            <ApiTokensTable tokens={tokens} onRevoke={setToRevoke} />
          )}
        </CardContent>
      </Card>

      <RenameServiceAccountDialog
        renameFrom={renameFrom}
        onClose={() => setRenameFrom(null)}
        organizationId={organizationId}
        serviceAccountId={serviceAccountId}
        onRenamed={() => {
          setRenameFrom(null);
          reload();
        }}
      />
      <CreateApiTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        organizationId={organizationId}
        serviceAccountId={serviceAccountId}
        onCreated={setRevealed}
        onUnknownOutcome={() => reload()}
      />
      <ApiTokenRevealDialog
        token={revealed}
        onClose={() => {
          setRevealed(null);
          reload(API_TOKENS_REFRESH_FAILED_MESSAGE);
        }}
      />
      <RevokeApiTokenDialog
        open={toRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setToRevoke(null);
        }}
        organizationId={organizationId}
        serviceAccountId={serviceAccountId}
        token={toRevoke}
        onRevoked={() => {
          setToRevoke(null);
          reload();
        }}
      />
    </div>
  );
}

interface RenameServiceAccountDialogProps {
  /** The name when Rename was pressed (the dialog's baseline), or null when closed. */
  renameFrom: string | null;
  onClose: () => void;
  organizationId: string;
  serviceAccountId: string;
  onRenamed: () => void;
}

/** Each opening is a new session, its field prefilled with the baseline. */
function RenameServiceAccountDialog(props: RenameServiceAccountDialogProps) {
  const opening = useOpeningKey(props.renameFrom !== null);
  return <RenameSession key={opening} {...props} />;
}

function RenameSession({ renameFrom, onClose, organizationId, serviceAccountId, onRenamed }: RenameServiceAccountDialogProps) {
  const id = useId();
  const leaveManagement = useLeaveManagement();
  const isStillCurrent = useStillCurrent(organizationId);
  const [hasName, setHasName] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // The baseline, read once as the field mounts: the property, never an attribute.
  const baseline = useRef(renameFrom);
  const prefill = useCallback((input: HTMLInputElement | null) => {
    if (input !== null && baseline.current !== null) input.value = baseline.current;
  }, []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current) return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (name === "") return;
    savingRef.current = true;
    setSaving(true);
    const sentIn = organizationId;
    try {
      await renameServiceAccount(sentIn, serviceAccountId, { name });
      if (!isStillCurrent(sentIn)) return;
      toast.success(SERVICE_ACCOUNT_RENAMED_MESSAGE);
      onRenamed();
    } catch (failure) {
      if (!isStillCurrent(sentIn) || isSessionEnded(failure)) return;
      if (isManagementLost(failure)) {
        onClose();
        leaveManagement(failure);
        return;
      }
      toast.error(serviceAccountFailureMessage(failure, SERVICE_ACCOUNT_RENAME_FAILED_MESSAGE));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const nameId = `${id}-name`;
  return (
    <Dialog
      open={renameFrom !== null}
      onOpenChange={(open) => {
        if (!open && !savingRef.current) onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Rename service account</DialogTitle>
            <DialogDescription>The name is how this identity appears in Telflo. Its tokens are unaffected.</DialogDescription>
          </DialogHeader>
          <div className="ph-no-capture space-y-1.5 py-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              ref={prefill}
              id={nameId}
              name="name"
              maxLength={SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH}
              autoComplete="off"
              autoFocus
              readOnly={saving}
              onInput={(event) => setHasName(event.currentTarget.value.trim() !== "")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !hasName}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
