import { useCallback, useEffect, useState } from "react";
import type { OrganizationVariable, VariableGroupDetail } from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { getOrganizationVariables, getVariableGroup } from "~/lib/api-client.js";
import { FLEET_READ_TIMEOUT_MS } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useOpeningReads } from "~/lib/hooks/use-opening-reads.js";
import { useLockedAction } from "~/lib/playground/context.js";
import {
  effectiveVariableGroupId,
  NO_VARIABLE_GROUP_WORDS,
  ORGANIZATION_VALUE_SOURCE,
  ORGANIZATION_VALUES,
  resolvedVariables,
  UNNAMED_VARIABLE_GROUP,
  useNamesOrganization,
  useVariableGroupNames,
  type ResolutionLevel,
} from "~/lib/variable-group-display.js";

/*
 * A variable group named in a fleet screen: a button whose text is the
 * variable group's name ("Organization values" for none) opening a dialog
 * that lists every organization variable, the value it takes and where that
 * comes from. Its details:
 *
 * - A collector's (the grid, its details) resolves through two levels, as the
 *   poll does: its pinned variable group's override, then its collector
 *   group's variable group's, then the organization's value; a group's (the
 *   Groups tables, a group's details) through its own.
 * - The dialog reads at its opening (the variables, and each variable group
 *   named, under `useOpeningReads`' 10 s guard, aborted on close), with
 *   "Try again" after a failure.
 * - Its title and description are fixed words, never a name; the trigger
 *   has no `title`, its name its text.
 * - A collector whose group's variable group isn't known (the fleet's groups
 *   unread, or not holding its group) shows its pinned variable group's
 *   overrides, and says the group's variable group couldn't be read: every
 *   other row's value and source "Unknown", never the organization's value
 *   as if it applied (each row says where its value comes from).
 * - Privacy: the variable groups' names, and every variable's name,
 *   description and value, sit inside `ph-no-capture` as text only; no
 *   attribute holds one.
 */

export const VARIABLE_VALUES_TITLE = "Variable values";
export const COLLECTOR_VALUES_DESCRIPTION =
  "Each variable's value for this collector and where it comes from: its pinned variable group's override first, then its group's variable group's, then the organization's value.";
export const GROUP_VALUES_DESCRIPTION =
  "Each variable's value for this group's collectors and where it comes from: the variable group's override, else the organization's value. A collector with a pinned variable group takes that group's overrides first.";
export const VARIABLE_VALUES_FAILED_MESSAGE = "Failed to load variable values";
export const NO_VARIABLES_WORDS = "The organization has no variables yet.";

/** Where a value comes from, by level. */
export const PINNED_SOURCE = "Pinned variable group";
export const GROUP_SOURCE = "Group's variable group";
/** A group's own override: the Variable groups page's word. */
export const OVERRIDE_SOURCE = "Override";

/** The dialog's level rows' labels. */
export const PINNED_LEVEL_LABEL = "Pinned variable group";
export const GROUP_LEVEL_LABEL = "Group's variable group";
export const NO_PINNED_WORDS = "None: follows its group";
/** The group's variable group while the fleet's groups are unread (a collector's only). */
export const GROUP_LEVEL_UNKNOWN_WORDS = "Couldn't be read: the fleet's groups aren't loaded.";
/** A row's source when its value depends on the group's variable group, which isn't known. */
export const UNKNOWN_SOURCE = "Unknown";

const DASH = <span className="text-muted-foreground">—</span>;

export interface VariableGroupLinkProps {
  /** The collector group's variable group: null for none, undefined while the groups are unread. */
  groupVariableGroupId: string | null | undefined;
  /** A collector's pinned variable group (null for none); left out for a group's row. */
  pinnedVariableGroupId?: string | null;
}

/**
 * The sign-up prompt's words for the values in the playground: the dialog
 * reads the organization's variables, which the sample workspace doesn't
 * have (its Variables are locked too), so it opens the prompt instead and
 * makes no request.
 */
export const VARIABLE_VALUES_LOCKED_WORDS = "see your organization's variable values";

/** The cell: the variable group's name, or "Organization values", opening the values; a dash while it can't be known. */
export function VariableGroupLink({ groupVariableGroupId, pinnedVariableGroupId }: VariableGroupLinkProps) {
  const [open, setOpen] = useState(false);
  const locked = useLockedAction();
  const forCollector = pinnedVariableGroupId !== undefined;
  const effective = forCollector
    ? effectiveVariableGroupId({ pinnedVariableGroupId }, groupVariableGroupId === undefined ? undefined : { variableGroupId: groupVariableGroupId })
    : groupVariableGroupId;
  const names = useVariableGroupNames([effective]);
  if (effective === undefined) return DASH;
  const name = effective === null ? ORGANIZATION_VALUES : (names.get(effective) ?? UNNAMED_VARIABLE_GROUP);
  const named = effective !== null && names.has(effective);
  return (
    <>
      <button
        type="button"
        onClick={(event) => (locked !== null ? locked(VARIABLE_VALUES_LOCKED_WORDS, event.currentTarget) : setOpen(true))}
        className={`text-left text-[13px] hover:underline focus:underline focus:outline-none ${named ? "font-medium text-brand" : "text-muted-foreground"}`}
      >
        <span className="ph-no-capture">{name}</span>
      </button>
      <VariableValuesDialog
        open={open}
        onOpenChange={setOpen}
        pinnedVariableGroupId={forCollector ? (pinnedVariableGroupId ?? null) : undefined}
        groupVariableGroupId={forCollector ? groupVariableGroupId : (groupVariableGroupId ?? null)}
      />
    </>
  );
}

interface VariableValuesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A collector's pinned variable group (null for none); undefined for a group's values. */
  pinnedVariableGroupId: string | null | undefined;
  /** The collector group's variable group: null for none; undefined while it isn't known (a collector's groups unread). */
  groupVariableGroupId: string | null | undefined;
}

/** What the dialog read: the variables and each variable group named. */
interface ValuesRead {
  variables: OrganizationVariable[];
  pinned: VariableGroupDetail | null;
  group: VariableGroupDetail | null;
}

type ValuesState = { state: "loading" } | { state: "failed" } | { state: "read"; read: ValuesRead };

/** Each opening reads afresh. */
export function VariableValuesDialog(props: VariableValuesDialogProps) {
  const opening = useOpeningKey(props.open);
  return <VariableValuesSession key={opening} {...props} />;
}

function VariableValuesSession({ open, onOpenChange, pinnedVariableGroupId, groupVariableGroupId }: VariableValuesDialogProps) {
  // The shared names' organization (`useNamesOrganization`: none inside the playground, whose sample has no
  // variables to read; the trigger is locked there, and this session reads nothing).
  const organizationId = useNamesOrganization();
  const read = useOpeningReads(open, FLEET_READ_TIMEOUT_MS);
  const [values, setValues] = useState<ValuesState>({ state: "loading" });
  const forCollector = pinnedVariableGroupId !== undefined;
  const groupUnknown = groupVariableGroupId === undefined;

  const readValues = useCallback(() => {
    if (organizationId === null) {
      setValues({ state: "failed" });
      return;
    }
    setValues({ state: "loading" });
    void read(async (signal): Promise<ValuesRead> => {
      const detailOf = (id: string | null | undefined) =>
        id === null || id === undefined ? Promise.resolve(null) : getVariableGroup(organizationId, id, { signal });
      const [variables, pinned, group] = await Promise.all([
        getOrganizationVariables(organizationId, { signal }),
        detailOf(pinnedVariableGroupId),
        detailOf(groupVariableGroupId),
      ]);
      return { variables, pinned, group };
    }).then((answer) => {
      if (answer === null) return;
      setValues(answer.ok ? { state: "read", read: answer.value } : { state: "failed" });
    });
  }, [read, organizationId, pinnedVariableGroupId, groupVariableGroupId]);

  useEffect(() => {
    if (open) readValues();
    // One read per opening: the session is keyed by it.
  }, [open]);

  const levels = (shown: ValuesRead): ResolutionLevel[] => {
    const each: ResolutionLevel[] = [];
    if (shown.pinned !== null) each.push({ source: PINNED_SOURCE, overrides: shown.pinned.overrides });
    if (shown.group !== null) each.push({ source: forCollector ? GROUP_SOURCE : OVERRIDE_SOURCE, overrides: shown.group.overrides });
    return each;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{VARIABLE_VALUES_TITLE}</DialogTitle>
          <DialogDescription>{forCollector ? COLLECTOR_VALUES_DESCRIPTION : GROUP_VALUES_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        {values.state === "loading" ? (
          <p role="status" className="py-4 text-[13px] text-muted-foreground">
            Loading variable values…
          </p>
        ) : values.state === "failed" ? (
          <div className="flex items-center gap-2 py-4">
            <p className="text-[13px] text-fail">{VARIABLE_VALUES_FAILED_MESSAGE}</p>
            <Button type="button" variant="outline" size="sm" onClick={readValues}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="ph-no-capture grid gap-3">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-[13px]">
              {forCollector && (
                <>
                  <dt className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">{PINNED_LEVEL_LABEL}</dt>
                  <dd>{values.read.pinned?.variableGroup.name ?? <span className="text-muted-foreground">{NO_PINNED_WORDS}</span>}</dd>
                </>
              )}
              <dt className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">{GROUP_LEVEL_LABEL}</dt>
              <dd>
                {groupUnknown ? (
                  <span className="text-muted-foreground">{GROUP_LEVEL_UNKNOWN_WORDS}</span>
                ) : (
                  (values.read.group?.variableGroup.name ?? <span className="text-muted-foreground">{NO_VARIABLE_GROUP_WORDS}</span>)
                )}
              </dd>
            </dl>
            {values.read.variables.length === 0 ? (
              <p className="py-2 text-[13px] text-muted-foreground">{NO_VARIABLES_WORDS}</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="[&_tr]:border-b">
                  <tr className="border-b">
                    <th className="h-8 px-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Variable</th>
                    <th className="h-8 px-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Value</th>
                    <th className="h-8 px-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Source</th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {resolvedVariables(values.read.variables, levels(values.read)).map((resolved) => {
                    // Not taken from the pin, with the group's variable group unknown: its value can't be told.
                    const unknown = groupUnknown && resolved.source === ORGANIZATION_VALUE_SOURCE;
                    const row = unknown ? { ...resolved, source: UNKNOWN_SOURCE } : resolved;
                    return (
                    <tr key={row.variable.id} className="border-b align-top">
                      <td className="px-2 py-2">
                        <div className="break-all font-mono text-xs font-medium text-foreground">{row.variable.name}</div>
                        {row.variable.description !== null && (
                          <div className="mt-0.5 break-words text-xs text-muted-foreground">{row.variable.description}</div>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {unknown ? (
                          DASH
                        ) : (
                          <code className="block whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                            {row.value}
                          </code>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {row.source === ORGANIZATION_VALUE_SOURCE || unknown ? (
                          <span className="text-xs text-muted-foreground">{row.source}</span>
                        ) : (
                          <Badge variant="outline">{row.source}</Badge>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
