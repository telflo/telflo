import { useCallback, useEffect, useState } from "react";
import type { VariableGroup, VariablesUndefinedDetails } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { getConfigurationVersion, getVariableGroups } from "~/lib/api-client.js";
import type { OpeningRead } from "~/lib/hooks/use-opening-reads.js";
import { orgVariableReferences, useOrgVariables } from "~/lib/org-variables.js";
import {
  moreNamesText,
  seedVariableGroupNames,
  UNDEFINED_NAMES_LISTED,
  undefinedNames,
  VARIABLE_GROUP_NOT_LISTED_WORDS,
  VARIABLE_GROUPS_FAILED_MESSAGE,
} from "~/lib/variable-group-display.js";

/*
 * The fleet dialogs' variable group parts: the organization's variable groups
 * read at the dialog's opening (a snapshot: the list it offers never moves
 * while it is open), the "Variable group" Select over them, the group
 * dialogs' "Variables used" (the chosen version's names that no organization
 * variable has, before Save), and a 422 `variables_undefined`'s names.
 *
 * Privacy: a variable group's name and a variable's name are configuration
 * text. The whole Select sits inside `ph-no-capture`: its trigger, the
 * hidden native `<select>` Radix renders beside it inside the form (its
 * options hold the names as text), and its list (a portal: its own class);
 * its item values are ids or the fixed choices. The names listed sit
 * inside `ph-no-capture`, as text only. No attribute holds one.
 */

// ---------------------------------------------------------------------------
// The variable groups offered.

export interface OfferedVariableGroups {
  status: "loading" | "read" | "failed";
  /** The organization's variable groups, by name (the API's order), as the opening's read found them. */
  groups: VariableGroup[];
  /** Reads them again ("Try again"). */
  retry: () => void;
}

/** The organization's variable groups, read once at the opening (the dialog's session is keyed by it); its answer seeds the rows' names. */
export function useOfferedVariableGroups(open: boolean, read: OpeningRead, organizationId: string): OfferedVariableGroups {
  const [state, setState] = useState<Omit<OfferedVariableGroups, "retry">>({ status: "loading", groups: [] });
  const readGroups = useCallback(() => {
    setState({ status: "loading", groups: [] });
    void read((signal) => getVariableGroups(organizationId, { signal })).then((answer) => {
      if (answer === null) return;
      if (!answer.ok) {
        setState({ status: "failed", groups: [] });
        return;
      }
      seedVariableGroupNames(organizationId, answer.value);
      setState({ status: "read", groups: answer.value });
    });
  }, [read, organizationId]);
  useEffect(() => {
    if (open) readGroups();
    // One read per opening.
  }, [open]);
  return { ...state, retry: readGroups };
}

/** One of a Select's fixed choices: its item value (never an id) and its words. */
export interface FixedChoice {
  value: string;
  label: string;
}

export interface VariableGroupSelectProps {
  id: string;
  label: string;
  offered: OfferedVariableGroups;
  /** A fixed choice's value, or a variable group's id. */
  value: string;
  /** The choices before the variable groups ("None (organization values)", "Follow group (…)", "Leave as is"…). */
  fixed: readonly FixedChoice[];
  onChange: (value: string) => void;
  disabled: boolean;
}

/**
 * "Variable group": the fixed choices, then each variable group (its id the
 * item's value); a chosen id the list doesn't hold reads "A variable group no
 * longer listed", never blank. While the list is read, "Loading variable
 * groups…"; after a failure its words with "Try again" (nothing is sent for a
 * variable group meanwhile: the choice stays as it opened).
 */
export function VariableGroupSelect({ id, label, offered, value, fixed, onChange, disabled }: VariableGroupSelectProps) {
  if (offered.status !== "read") {
    return (
      <div className="ph-no-capture grid gap-2">
        <Label>{label}</Label>
        {offered.status === "loading" ? (
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading variable groups…
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-fail">{VARIABLE_GROUPS_FAILED_MESSAGE}</p>
            <Button type="button" variant="outline" size="sm" onClick={offered.retry} disabled={disabled}>
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  }
  const isFixed = fixed.some((choice) => choice.value === value);
  const listed = isFixed || offered.groups.some((group) => group.id === value);
  return (
    // The hidden native <select> Radix renders inside the form holds the names as its options' text: inside too.
    <div className="ph-no-capture grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next && next !== value) onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="ph-no-capture">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="ph-no-capture">
          {fixed.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
          {!listed && (
            <SelectItem value={value} disabled>
              {VARIABLE_GROUP_NOT_LISTED_WORDS}
            </SelectItem>
          )}
          {offered.groups.length > 0 && <SelectSeparator />}
          {offered.groups.map((group) => (
            <SelectItem key={group.id} value={group.id}>
              {group.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Variables used".

export const VARIABLES_USED_LABEL = "Variables used";
export const VARIABLES_USED_LOADING = "Checking the version's organization variables…";
export const VARIABLES_USED_FAILED = "The version's organization variables couldn't be checked.";
export const VARIABLES_USED_NONE = "This version uses no organization variables.";
export const VARIABLES_UNDEFINED_LEAD = "Not defined in your organization's variables:";
/** The hint under the names when the save would assign the version (the opamp-server's 422 then refuses it). */
export const VARIABLES_UNDEFINED_HINT = "Saving is refused until they are defined on the Variables page.";
/** The hint when the version is the one the group already has: the save doesn't assign it again. */
export const VARIABLES_UNDEFINED_ASSIGNED_HINT = "Define them on the Variables page.";

/** "Uses 3 organization variables, all defined." */
export function allDefinedWords(count: number): string {
  return `Uses ${count} organization variable${count === 1 ? "" : "s"}, all defined.`;
}

/** The chosen version's referenced names, read for the version they were read for. */
export interface VersionReferences {
  versionId: string | null;
  status: "idle" | "loading" | "read" | "failed";
  names: string[];
  retry: () => void;
}

/**
 * The chosen version's text read through `getConfigurationVersion(…, signal)`
 * under the dialog's opening reads, and its names extracted with the web's
 * `References` (`orgVariableReferences`). A new choice aborts the read under
 * way (its own signal, besides the opening's guard), and its late answer is
 * dropped.
 */
export function useVersionReferences(
  read: OpeningRead,
  organizationId: string,
  configurationId: string | null,
  versionId: string | null,
): VersionReferences {
  const [state, setState] = useState<Omit<VersionReferences, "retry">>({ versionId: null, status: "idle", names: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (configurationId === null || versionId === null) {
      setState({ versionId: null, status: "idle", names: [] });
      return;
    }
    let current = true;
    // This choice's own abort: a new choice (or the dialog closing) aborts it, besides the opening's guard.
    const choice = new AbortController();
    setState({ versionId, status: "loading", names: [] });
    void read((signal) => {
      if (signal.aborted) choice.abort();
      else signal.addEventListener("abort", () => choice.abort(), { once: true });
      return getConfigurationVersion(organizationId, configurationId, versionId, { signal: choice.signal });
    }).then((answer) => {
      if (!current || answer === null) return;
      setState(
        answer.ok
          ? { versionId, status: "read", names: orgVariableReferences(answer.value.version.yamlContent) }
          : { versionId, status: "failed", names: [] },
      );
    });
    return () => {
      current = false;
      choice.abort();
    };
  }, [read, organizationId, configurationId, versionId, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, retry };
}

/** A list of names, the first 100, then "… and N more" from the total. */
function NamesList({ names, total }: { names: readonly string[]; total: number }) {
  const shown = names.slice(0, UNDEFINED_NAMES_LISTED);
  const more = Math.max(0, total - shown.length);
  return (
    <>
      <ul className="mt-1 list-inside list-disc space-y-0.5 font-mono text-xs">
        {shown.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      {more > 0 && <p className="mt-1 text-xs">{moreNamesText(more)}</p>}
    </>
  );
}

/**
 * "Variables used" for the version chosen: the names it references that no
 * organization variable of that name has ("defined" is an organization
 * variable; a group override needs one), shown before Save. The names come
 * from the one shared read (`useOrgVariables`). A read under way says so; a
 * failure (the version's text, or the names) says it couldn't check, with
 * "Try again". Nothing for no version chosen.
 */
export function VariablesUsed({
  references,
  assigns,
  disabled,
}: {
  references: VersionReferences;
  /** Whether the save would assign the version chosen (it differs from the group's as it opened): only then is it refused. */
  assigns: boolean;
  disabled: boolean;
}) {
  const organization = useOrgVariables();
  // The names may be a minute old: the dialog's opening reads them again when they are (or after a failure), so a
  // variable just defined elsewhere isn't listed as undefined. Once per opening: the session is keyed.
  const { refresh } = organization;
  useEffect(() => {
    refresh();
  }, [refresh]);
  if (references.status === "idle") return null;
  const failed = references.status === "failed" || (organization.failed && references.status === "read");
  // Until the active organization's names are known (none yet in the user store counts), nothing is listed as undefined.
  const loading = !failed && (references.status === "loading" || !organization.known);
  const missing = loading || failed ? [] : undefinedNames(references.names, organization.names);
  return (
    <div className="grid gap-1">
      <p className="text-[13px] font-medium text-foreground">{VARIABLES_USED_LABEL}</p>
      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {VARIABLES_USED_LOADING}
        </p>
      ) : failed ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-fail">{VARIABLES_USED_FAILED}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (references.status === "failed") references.retry();
              organization.refresh();
            }}
          >
            Try again
          </Button>
        </div>
      ) : references.names.length === 0 ? (
        <p className="text-xs text-muted-foreground">{VARIABLES_USED_NONE}</p>
      ) : missing.length === 0 ? (
        <p className="text-xs text-muted-foreground">{allDefinedWords(references.names.length)}</p>
      ) : (
        <div className="ph-no-capture rounded-md border border-warn/25 bg-warn-soft p-3 text-[13px] text-warn" role="status">
          <p>{VARIABLES_UNDEFINED_LEAD}</p>
          <NamesList names={missing} total={missing.length} />
          <p className="mt-1 text-xs">{assigns ? VARIABLES_UNDEFINED_HINT : VARIABLES_UNDEFINED_ASSIGNED_HINT}</p>
        </div>
      )}
    </div>
  );
}

/** A 422 `variables_undefined`'s names (at most 100, then "… and N more" from `totalNames`), under the dialog's alert. */
export function UndefinedNamesRefused({ details }: { details: VariablesUndefinedDetails | null }) {
  if (details === null || details.names.length === 0) return null;
  return (
    <div className="ph-no-capture rounded-md border border-fail/25 bg-fail-soft p-3 text-[13px] text-fail">
      <p>{VARIABLES_UNDEFINED_LEAD}</p>
      <NamesList names={details.names} total={details.totalNames} />
    </div>
  );
}
