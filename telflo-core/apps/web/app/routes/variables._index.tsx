import { useRef, useState } from "react";
import { AlertCircle, FileText, Plus, Search } from "lucide-react";
import type { OrganizationVariable } from "@telflo/contracts";
import type { Route } from "./+types/variables._index";
import { DeleteVariableDialog } from "~/components/variables/DeleteVariableDialog.js";
import { SecretsWarning } from "~/components/variables/SecretsWarning.js";
import { VariableDialog } from "~/components/variables/VariableDialog.js";
import { VariablesTable, type VariableRowAction } from "~/components/variables/VariablesTable.js";
import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import {
  VARIABLES_LOAD_FAILED_MESSAGE,
  VARIABLES_NOTE_REFERENCE,
  matchesVariableSearch,
  useOrganizationVariablesList,
} from "~/lib/variables.js";

/*
 * `/variables`, the left nav's "Variables", with its columns and dialogs
 * (`components/variables/`):
 * - the warning under the header: not for secrets, which stay in
 *   `${env:NAME}`, since a test run fills these values in and keeps its
 *   Test YAML and the collector's logs with its results;
 * - "Add variable" in the header and in the empty state, "No organization
 *   variables yet"; "No variables match your search" when the search
 *   matches none; "Loading variables…" while the list is read, and a failed
 *   read says so with "Try again";
 * - the search, over name, description and value, runs in the browser over
 *   the one list (≤ 500): it is the page's state only, never in the URL (no
 *   `?q=`) or browser storage, and its input sits inside `ph-no-capture`
 *   (what is typed is configuration text); its placeholder and name are
 *   fixed words;
 * - the help card says `$` opens the picker;
 * - the title is fixed ("Variables - Telflo"), never a name.
 * An organization switch drops the search and closes the dialogs.
 */

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Variables - Telflo" }];
}

type OpenDialog = { kind: "add" } | { kind: VariableRowAction; variable: OrganizationVariable };

export default function VariablesPage() {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  // A switch starts the page over: no search, no dialog of the organization left.
  return organizationId === null ? null : <VariablesPageFor key={organizationId} organizationId={organizationId} />;
}

function VariablesPageFor({ organizationId }: { organizationId: string }) {
  const list = useOrganizationVariablesList();
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const open = (next: OpenDialog, from: HTMLElement | null) => {
    opener.current = from;
    setDialog(next);
    setDialogOpen(true);
  };

  // The focus goes back to the button that opened the dialog, while it is still on the page.
  const returnFocus = (event: Event) => {
    const from = opener.current;
    if (from !== null && from.isConnected) {
      event.preventDefault();
      from.focus();
    }
  };

  const variables = list.value;
  const shown = variables === null ? [] : variables.filter((variable) => matchesVariableSearch(variable, search));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="ph-no-capture relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Search variables"
            placeholder="Search variables..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-8"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button onClick={(event) => open({ kind: "add" }, event.currentTarget)}>
          <Plus className="h-4 w-4" />
          Add variable
        </Button>
      </div>

      <SecretsWarning>
        Test runs use these values in place of <code className="font-mono">{VARIABLES_NOTE_REFERENCE}</code>, and each run
        keeps its Test YAML and the collector&apos;s logs, values included, with its results.
      </SecretsWarning>

      {variables === null ? (
        list.failed ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-12 text-center">
            <p className="mb-3 text-[13px] text-muted-foreground">{VARIABLES_LOAD_FAILED_MESSAGE}</p>
            <Button variant="outline" onClick={list.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" className="rounded-lg border border-border bg-card py-12 text-center text-[13px] text-muted-foreground">
            Loading variables…
          </div>
        )
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-12 text-center">
          <FileText className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p className="mb-3 mt-2 text-[13px] text-muted-foreground">
            {variables.length === 0 ? "No organization variables yet" : "No variables match your search"}
          </p>
          {variables.length === 0 && (
            <Button variant="outline" onClick={(event) => open({ kind: "add" }, event.currentTarget)}>
              <Plus className="h-4 w-4" />
              Add variable
            </Button>
          )}
        </div>
      ) : (
        <VariablesTable variables={shown} onAction={(kind, variable, from) => open({ kind, variable }, from)} />
      )}

      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-card p-4">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="text-[13px]">
          <p className="mb-1 font-medium text-foreground">How variables work</p>
          <p className="text-muted-foreground">
            A variable holds a text value, such as a URL, a hostname or an environment&apos;s name, shared by your
            organization&apos;s configurations. In a configuration field, type{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">$</code> to pick one: it
            inserts <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{"${org:NAME}"}</code>,
            which each collector receives filled in with the value of its variable group, else the organization&apos;s.
          </p>
        </div>
      </div>

      <VariableDialog
        open={dialogOpen && (dialog?.kind === "add" || dialog?.kind === "edit")}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        variable={dialog?.kind === "edit" ? dialog.variable : null}
        onChanged={list.reload}
        onCloseAutoFocus={returnFocus}
      />
      <DeleteVariableDialog
        open={dialogOpen && dialog?.kind === "delete"}
        onOpenChange={setDialogOpen}
        organizationId={organizationId}
        variable={dialog?.kind === "delete" ? dialog.variable : null}
        onChanged={list.reload}
        onCloseAutoFocus={returnFocus}
      />
    </div>
  );
}
