import { useCallback, useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { Configuration, ConfigurationVersionListItem, PublishedVersion } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { getConfigurations, getConfigurationVersions } from "~/lib/api-client.js";
import type { OpeningRead } from "~/lib/hooks/use-opening-reads.js";
import { VersionOptionLabel } from "./VersionOptionLabel.js";

/*
 * The pin picker, shared by Edit collector, bulk pin and New/Edit group: two
 * dependent Selects, Configuration then Version, a configuration chosen
 * selecting its newest version, "(group default)" marking the group's
 * assignment, over the platform's reads; a pin names a published version
 * only.
 *
 * - The Configuration Select lists the organization's published
 *   configurations, 100 a page (`filter=published`, newest update first, the
 *   API's order), with "Load more" below the Configuration Select while the
 *   API has a next page (each page resends the same filter: the cursor is
 *   positional). No search box: no read sends `q`. The current pin's (or
 *   assignment's) configuration and the configurations chosen are always
 *   offered. The Version Select reads one configuration's published versions
 *   (the versions route, highest number first), one read per configuration
 *   chosen.
 * - Every read runs under the dialog's opening (`useOpeningReads`: a 10 s
 *   hang guard each, all aborted when the dialog closes); an answer for a
 *   first read or a configuration since replaced is dropped.
 * - The configurations chosen live in the dialog
 *   (`useConfigurationPickerKept`): a guard, the list never dropping one (its
 *   first page is read again only after a failed read).
 * - Privacy: every Select's item values are ids, never names (Radix writes
 *   them into a hidden native `<select>` inside a form); configuration names
 *   and version labels are text only. The picker has no text input, so no
 *   attribute of it holds a name.
 */

/** A configuration read's failure, shown in place of the Selects and toasted by a failed "Load more". */
export const CONFIGURATIONS_FAILED_MESSAGE = "Failed to load configurations";
export const VERSIONS_FAILED_MESSAGE = "Failed to load versions";

/** How many configurations a read asks for. */
export const PICKER_PAGE_SIZE = 100;

/** The group's assignment marker. */
const GROUP_DEFAULT = "group default";

type ReadStatus = "loading" | "read" | "failed";

/** The published configurations shown, and where the next page starts. */
export interface ConfigurationsRead {
  status: ReadStatus;
  items: Configuration[];
  nextCursor: string | null;
  loadingMore: boolean;
  /** Reads the next page, appending each configuration once. */
  loadMore: () => void;
  /** Reads the first page again ("Try again"). */
  retry: () => void;
}

/** The organization's published configurations, read on opening. */
export function usePublishedConfigurations(open: boolean, read: OpeningRead, organizationId: string): ConfigurationsRead {
  const [state, setState] = useState<Omit<ConfigurationsRead, "loadMore" | "retry">>({
    status: "loading",
    items: [],
    nextCursor: null,
    loadingMore: false,
  });
  // The latest first read's number: a page answered for an older one is dropped.
  const latest = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const readFirst = useCallback(() => {
    const reading = ++latest.current;
    setState({ status: "loading", items: [], nextCursor: null, loadingMore: false });
    void read((signal) => getConfigurations(organizationId, { filter: "published", limit: PICKER_PAGE_SIZE }, { signal })).then(
      (answer) => {
        if (answer === null || reading !== latest.current) return;
        setState(
          answer.ok
            ? { status: "read", items: answer.value.items, nextCursor: answer.value.nextCursor, loadingMore: false }
            : { status: "failed", items: [], nextCursor: null, loadingMore: false },
        );
      },
    );
  }, [read, organizationId]);

  const loadMore = useCallback(() => {
    const shown = stateRef.current;
    if (shown.status !== "read" || shown.nextCursor === null || shown.loadingMore) return;
    const reading = latest.current;
    const { nextCursor } = shown;
    setState({ ...shown, loadingMore: true });
    void read((signal) =>
      getConfigurations(organizationId, { filter: "published", limit: PICKER_PAGE_SIZE, cursor: nextCursor }, { signal }),
    ).then((answer) => {
      if (answer === null || reading !== latest.current) return;
      if (!answer.ok) {
        toast.error(CONFIGURATIONS_FAILED_MESSAGE);
        setState((current) => ({ ...current, loadingMore: false }));
        return;
      }
      setState((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        const added = answer.value.items.filter((item) => !seen.has(item.id));
        return { ...current, items: [...current.items, ...added], nextCursor: answer.value.nextCursor, loadingMore: false };
      });
    });
  }, [read, organizationId]);

  useEffect(() => {
    if (open) readFirst();
    // One first read per opening: the dialog's session is keyed by it.
  }, [open]);

  return { ...state, loadMore, retry: readFirst };
}

/** One configuration's published versions, for the configuration they were read for. */
export interface VersionsRead {
  configurationId: string | null;
  status: ReadStatus | "idle";
  versions: ConfigurationVersionListItem[];
  retry: () => void;
}

/** The chosen configuration's published versions (the versions route), read once per configuration chosen. */
export function useConfigurationVersions(read: OpeningRead, organizationId: string, configurationId: string | null): VersionsRead {
  const [state, setState] = useState<Omit<VersionsRead, "retry">>({ configurationId: null, status: "idle", versions: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (configurationId === null) {
      setState({ configurationId: null, status: "idle", versions: [] });
      return;
    }
    let current = true;
    setState({ configurationId, status: "loading", versions: [] });
    void read((signal) => getConfigurationVersions(organizationId, configurationId, { filter: "published", signal })).then(
      (answer) => {
        if (!current || answer === null) return;
        setState(
          answer.ok
            ? { configurationId, status: "read", versions: answer.value.versions }
            : { configurationId, status: "failed", versions: [] },
        );
      },
    );
    return () => {
      current = false;
    };
  }, [read, organizationId, configurationId, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, retry };
}

/** A read's loading words, or its failure with "Try again". */
function ReadState({ loading, failed, onRetry, disabled }: { loading: string; failed: string | null; onRetry: () => void; disabled: boolean }) {
  if (failed === null) {
    return (
      <div role="status" className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
        />
        {loading}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <p className="text-[13px] text-fail">{failed}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={disabled}>
        Try again
      </Button>
    </div>
  );
}

/** A configuration chosen from a page: kept so the Select still names it. */
interface OfferedConfiguration {
  id: string;
  name: string;
}

/** What the configuration picker keeps across its unmounting (the Pin choice switched away and back). */
export interface ConfigurationPickerKept {
  /** Configurations chosen, offered even when the list no longer holds them. */
  chosen: OfferedConfiguration[];
  setChosen: Dispatch<SetStateAction<OfferedConfiguration[]>>;
}

/** The picker's kept state, held by the dialog: one per opening (the dialog's session is keyed by it). */
export function useConfigurationPickerKept(): ConfigurationPickerKept {
  const [chosen, setChosen] = useState<OfferedConfiguration[]>([]);
  return { chosen, setChosen };
}

export interface ConfigurationVersionPickerProps {
  configurations: ConfigurationsRead;
  versions: VersionsRead;
  configurationId: string | null;
  versionId: string | null;
  /** The current pin's version: its configuration is always offered. */
  pinned: PublishedVersion | null;
  /** The chosen group's assigned version, marked "(group default)"; null for none or when the groups are unknown. */
  groupDefault: PublishedVersion | null;
  onConfiguration: (configurationId: string) => void;
  onVersion: (versionId: string) => void;
  disabled: boolean;
  /** The dialog's `useConfigurationPickerKept`: the configurations chosen outlive the picker; its own when none. */
  kept?: ConfigurationPickerKept | undefined;
}

/** The Configuration and Version Selects, with "Load more" below the Configuration Select (no search box). */
export function ConfigurationVersionPicker({
  configurations,
  versions,
  configurationId,
  versionId,
  pinned,
  groupDefault,
  onConfiguration,
  onVersion,
  disabled,
  kept,
}: ConfigurationVersionPickerProps) {
  const id = useId();
  const own = useConfigurationPickerKept();
  const { chosen, setChosen } = kept ?? own;
  const offered: OfferedConfiguration[] = [];
  const seen = new Set<string>();
  const offer = (each: OfferedConfiguration) => {
    if (seen.has(each.id)) return;
    seen.add(each.id);
    offered.push(each);
  };
  if (pinned !== null) offer({ id: pinned.configurationId, name: pinned.configurationName });
  for (const each of chosen) offer(each);
  for (const each of configurations.items) offer({ id: each.id, name: each.name });

  const versionsShown = versions.configurationId === configurationId ? versions : null;

  return (
    <div className="grid gap-3">
      {configurations.status !== "read" ? (
        <ReadState
          loading="Loading configurations…"
          failed={configurations.status === "failed" ? CONFIGURATIONS_FAILED_MESSAGE : null}
          onRetry={configurations.retry}
          disabled={disabled}
        />
      ) : (
        <>
          {configurations.items.length === 0 && (
            <p className="text-xs text-muted-foreground">No published configurations.</p>
          )}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-configuration`}>Configuration</Label>
            <Select
              value={configurationId ?? ""}
              // Radix can emit an empty value while its items reconcile; no
              // item has one.
              onValueChange={(value) => {
                if (!value || value === configurationId) return;
                const picked = offered.find((each) => each.id === value);
                if (picked !== undefined) setChosen((current) => [picked, ...current.filter((each) => each.id !== value)]);
                onConfiguration(value);
              }}
              disabled={disabled}
            >
              <SelectTrigger id={`${id}-configuration`}>
                <SelectValue placeholder="Pick a configuration" />
              </SelectTrigger>
              <SelectContent>
                {offered.map((each) => (
                  <SelectItem key={each.id} value={each.id}>
                    {each.name}
                    {groupDefault !== null && each.id === groupDefault.configurationId ? ` (${GROUP_DEFAULT})` : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {configurations.nextCursor !== null && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={configurations.loadMore}
                  disabled={disabled || configurations.loadingMore}
                >
                  {configurations.loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {configurationId !== null && versionsShown?.status === "failed" ? (
        <ReadState loading="" failed={VERSIONS_FAILED_MESSAGE} onRetry={versions.retry} disabled={disabled} />
      ) : (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-version`}>Version</Label>
          <Select
            value={versionId ?? ""}
            onValueChange={(value) => {
              if (value && value !== versionId) onVersion(value);
            }}
            disabled={disabled || configurationId === null || versionsShown?.status !== "read"}
          >
            <SelectTrigger id={`${id}-version`}>
              <SelectValue placeholder={versionsShown?.status === "loading" ? "Loading versions…" : "Pick a version"} />
            </SelectTrigger>
            <SelectContent>
              {(versionsShown?.versions ?? []).map((version) => (
                <SelectItem key={version.id} value={version.id}>
                  <VersionOptionLabel
                    versionNumber={version.versionNumber}
                    label={version.label}
                    publishedAt={version.publishedAt}
                    marker={groupDefault !== null && version.id === groupDefault.versionId ? GROUP_DEFAULT : null}
                  />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {versionsShown?.status === "read" && versionsShown.versions.length === 0 && (
            <p className="text-xs text-muted-foreground">This configuration has no published version.</p>
          )}
        </div>
      )}
    </div>
  );
}
