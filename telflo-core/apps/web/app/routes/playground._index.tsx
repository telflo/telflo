import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { LayoutGrid, List, Plus, Search } from "lucide-react";
import {
  CONFIGURATION_SEARCH_MAXIMUM_LENGTH,
  CONFIGURATIONS_LIST_FILTERS,
  type Configuration,
  type ConfigurationsListFilter,
} from "@telflo/contracts";
import type { Route } from "./+types/playground._index";
import { ConfigurationCard } from "~/components/configurations/ConfigurationCard.js";
import { ConfigurationsTable } from "~/components/configurations/ConfigurationsTable.js";
import { useConsentPending } from "~/lib/use-consent-pending.js";
import { PlaygroundTourWelcomeDialog, shouldOfferPlaygroundTour } from "~/components/playground/PlaygroundTourWelcomeDialog.js";
import {
  consumePlaygroundTourStage,
  markPlaygroundTourCompleted,
  PLAYGROUND_TOUR_RESTART_EVENT,
  startPlaygroundListTour,
  stopPlaygroundTour,
} from "~/components/playground/playground-tour.js";
import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, playgroundMeta } from "~/lib/playground/meta.js";
import { listedConfigurations } from "~/lib/playground/sample-reads.js";
import { useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { readsFor } from "~/lib/workspace-reads.js";

/*
 * `/playground`, the sample workspace's configurations: the signed-in page's
 * card and table on the sample's ten, its header, view switch, search and
 * filter, the playground's way:
 * - the list is read through the seam (`readsFor`, the sample's visitor's
 *   organization), after mount: the sample's times are relative to now, so
 *   the server renders the spinner;
 * - search, Mine and Published filter the ten in the browser, so the header
 *   shows how many show; the search box is inside
 *   `ph-no-capture` (what a visitor types never reaches replay) and no
 *   address holds it;
 * - the view mode isn't remembered (nothing of the visitor's is stored);
 * - New configuration opens the blank playground editor, a card or Edit
 *   the playground editor on it; Delete opens the sign-up prompt;
 * - the distribution tags name the catalog the web was built with (no
 *   catalog request).
 * The `data-tour-step` anchors are the tour's. Once the list has arrived,
 * the page starts the tour's first stage when it is handed one (the
 * banner's "Take the tour" from another page; the restart event on this
 * one), or offers the tour to a first desktop visitor (a welcome dialog).
 * The tour starts on the grid with the search and the filter cleared, so
 * its steps point at the whole list and its first card.
 */

type ViewMode = "grid" | "list";

const FILTER_LABELS: Record<ConfigurationsListFilter, string> = {
  all: "All configurations",
  mine: "Mine",
  published: "Published",
};

function isListFilter(value: string): value is ConfigurationsListFilter {
  return (CONFIGURATIONS_LIST_FILTERS as readonly string[]).includes(value);
}

/** The sign-up prompt's words for Delete. */
export const DELETE_LOCKED_ACTION = "manage your own configurations";

export const handle = PLAYGROUND_HANDLE;

export function meta({ matches }: Route.MetaArgs) {
  return playgroundMeta(matches, PLAYGROUND_TITLES.configurations, "/playground");
}

export default function PlaygroundConfigurations() {
  const navigate = useNavigate();
  const visitor = useCurrentUser();
  const organizationId = visitor?.organization.id ?? null;
  const visitorId = visitor?.user.id ?? "";
  const locked = useLockedAction();
  const { distributions } = useCollectorDistributions();

  const [configurations, setConfigurations] = useState<Configuration[] | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ConfigurationsListFilter>("all");
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const loaded = configurations !== null;

  // The tour's list stage, with the page in its default state. The editor
  // stage opens the first configuration listed: the card its last step points at.
  const firstConfigurationId = useRef<string | undefined>(undefined);
  firstConfigurationId.current = configurations?.[0]?.id;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const beginListTour = useCallback(() => {
    // The grid, so "Let's open a sample" points at the first card.
    setViewMode("grid");
    setSearch("");
    setFilter("all");
    startPlaygroundListTour(
      (to) => void navigateRef.current(to),
      () => firstConfigurationId.current,
    );
  }, []);

  useEffect(() => {
    if (organizationId === null) return;
    let current = true;
    readsFor(organizationId)
      .getConfigurations(organizationId, { limit: 100 })
      .then(
        (page) => {
          if (current) setConfigurations(page.items);
        },
        () => {
          // The sample always answers; an empty list stands in should it not.
          if (current) setConfigurations([]);
        },
      );
    return () => {
      current = false;
    };
  }, [organizationId]);

  // Once the list has arrived and no cookie choice is still to make (the banner, modal too, would be covered): a
  // handed-over stage, else the first desktop visit's offer.
  const consentPending = useConsentPending();
  useEffect(() => {
    if (!loaded || consentPending) return;
    if (consumePlaygroundTourStage("list")) beginListTour();
    else if (shouldOfferPlaygroundTour()) setWelcomeOpen(true);
    return stopPlaygroundTour;
  }, [loaded, consentPending, beginListTour]);

  // The banner's "Take the tour" while this page is showing.
  useEffect(() => {
    const restart = () => {
      if (consumePlaygroundTourStage("list")) {
        setWelcomeOpen(false);
        beginListTour();
      }
    };
    window.addEventListener(PLAYGROUND_TOUR_RESTART_EVENT, restart);
    return () => window.removeEventListener(PLAYGROUND_TOUR_RESTART_EVENT, restart);
  }, [beginListTour]);

  const handleTakeTour = () => {
    markPlaygroundTourCompleted();
    setWelcomeOpen(false);
    beginListTour();
  };
  const handleSkipTour = () => {
    markPlaygroundTourCompleted();
    setWelcomeOpen(false);
  };

  const shown = useMemo(
    () => (configurations === null ? [] : listedConfigurations(configurations, { q: search, filter })),
    [configurations, search, filter],
  );

  const handleOpen = (configuration: Configuration) => {
    void navigate(`/playground/editor/${configuration.id}`);
  };
  const handleDelete = (_configuration: unknown, from?: HTMLElement) => locked?.(DELETE_LOCKED_ACTION, from);

  return (
    <div className="min-h-full bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="border-b border-border bg-card">
        <div className="flex h-[52px] items-center justify-between px-5">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">Configurations</h1>
            {configurations !== null && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {shown.length}
                {shown.length !== configurations.length && ` / ${configurations.length}`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`flex h-7 w-8 items-center justify-center rounded-[4px] transition-colors ${
                  viewMode === "grid" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                title="Grid view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`flex h-7 w-8 items-center justify-center rounded-[4px] transition-colors ${
                  viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                title="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </div>
            <Button onClick={() => void navigate("/playground/editor")} data-tour-step="new-config">
              <Plus className="h-4 w-4" />
              New configuration
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-5 py-4">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="ph-no-capture relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search configurations…"
              aria-label="Search configurations"
              maxLength={CONFIGURATION_SEARCH_MAXIMUM_LENGTH}
              className="pl-8"
            />
          </div>
          <Select
            value={filter}
            onValueChange={(value) => {
              if (isListFilter(value)) setFilter(value);
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Filter">
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              {CONFIGURATIONS_LIST_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {FILTER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {configurations === null ? (
          <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-border bg-card p-12 text-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">Loading configurations…</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-14 text-center">
            <Search className="h-5 w-5 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">Nothing matches your search or filter.</p>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-tour-step="config-list">
            {shown.map((configuration) => (
              <ConfigurationCard
                key={configuration.id}
                configuration={configuration}
                isOwn={configuration.createdBy?.userId === visitorId}
                canDelete
                onOpen={handleOpen}
                onDelete={handleDelete}
                distributions={distributions}
              />
            ))}
          </div>
        ) : (
          <div data-tour-step="config-list">
            <ConfigurationsTable
              configurations={shown}
              currentUserId={visitorId}
              canDelete={() => true}
              onOpen={handleOpen}
              onDelete={handleDelete}
              distributions={distributions}
            />
          </div>
        )}
      </div>

      <PlaygroundTourWelcomeDialog open={welcomeOpen} onTakeTour={handleTakeTour} onSkip={handleSkipTour} />
    </div>
  );
}
