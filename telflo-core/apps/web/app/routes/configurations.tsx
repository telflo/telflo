import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { FileText, LayoutGrid, List, Plus, Search } from "lucide-react";
import {
  CONFIGURATION_SEARCH_MAXIMUM_LENGTH,
  CONFIGURATIONS_LIST_FILTERS,
  type Configuration,
  type ConfigurationsListFilter,
} from "@telflo/contracts";
import type { Route } from "./+types/configurations";
import { ConfigurationCard } from "~/components/configurations/ConfigurationCard.js";
import { ConfigurationsTable } from "~/components/configurations/ConfigurationsTable.js";
import { CreateConfigurationDialog } from "~/components/configurations/CreateConfigurationDialog.js";
import { DeleteConfigurationDialog } from "~/components/configurations/DeleteConfigurationDialog.js";
import { PlaygroundSaveDialog } from "~/components/configurations/PlaygroundSaveDialog.js";
import { Button } from "~/components/ui/button.js";
import { Input } from "~/components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { SEARCH_DELAY_MS, canDeleteConfiguration, useConfigurationsList } from "~/lib/configurations.js";
import { useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";
import { useSettled } from "~/lib/hooks/use-settled.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * `/app`, where sign-in lands: the Configurations page. Its rules:
 * - the list is paged and searched on the server: the search goes 300 ms
 *   after typing stops, the filter at once, and "Load more" below the grid
 *   or table fetches the next page (disabled while a new first page is under
 *   way). So the header has no count, which a paged list can't know;
 * - the filter (All configurations, Mine, Published) is the server's, sent
 *   with every page, and isn't remembered across visits;
 * - Delete shows only where it's allowed, for an admin too;
 * - the public editor's work is saved through one dialog, the playground's
 *   handoff (`PlaygroundSaveDialog`): with an edit the playground or the
 *   blank public editor staged in this browser, once the terms are
 *   accepted, "Save your playground configuration?";
 * - the collector catalog is read once, for the distribution tags' labels;
 *   a page whose read fails still lists, each tag naming its distribution
 *   by id;
 * - opening a configuration goes to `/editor/{id}`, and so does creating one;
 * - no "Please wait…" overlay: the dialogs say "Creating…" and "Deleting...";
 * - the terms dialog is the signed-in layout's, and the list waits for
 *   it (lib/configurations.ts);
 * - the view mode is kept under `telflo-configuration-view-mode`, read after
 *   mount, since the page is also rendered on the server; the first render is
 *   the grid.
 * The layout route supplies the shell, so the page doesn't wrap itself in
 * AppLayout. No attribute here carries a name, a description or an email:
 * they are text, which replay masks.
 */

type ViewMode = "grid" | "list";

/** The filter's options, in order, with their words. */
const FILTER_LABELS: Record<ConfigurationsListFilter, string> = {
  all: "All configurations",
  mine: "Mine",
  published: "Published",
};

function isListFilter(value: string): value is ConfigurationsListFilter {
  return (CONFIGURATIONS_LIST_FILTERS as readonly string[]).includes(value);
}

const VIEW_MODE_KEY = "telflo-configuration-view-mode";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "My Configurations - Telflo" },
    { name: "description", content: "Manage your OpenTelemetry Collector configurations" },
  ];
}

/** The stored view mode, or null when there is none or storage can't be read. */
function readViewMode(): ViewMode | null {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_KEY);
    return stored === "grid" || stored === "list" ? stored : null;
  } catch {
    return null;
  }
}

function writeViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Storage disabled: the choice lasts until the page is left.
  }
}

export default function ConfigurationsPage() {
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const currentUserId = currentUser?.user.id ?? "";
  const organizationId = currentUser?.organization.id ?? "";
  const role = currentUser?.organization.role;

  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ConfigurationsListFilter>("all");
  const [newConfigurationDialogOpen, setNewConfigurationDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [configurationToDelete, setConfigurationToDelete] = useState<Configuration | null>(null);

  // Another organization (a switch, or a removal elsewhere) closes the
  // dialogs: they were for the one before, and its configuration.
  const [dialogsOrganizationId, setDialogsOrganizationId] = useState(organizationId);
  if (dialogsOrganizationId !== organizationId) {
    setDialogsOrganizationId(organizationId);
    setNewConfigurationDialogOpen(false);
    setDeleteDialogOpen(false);
    setConfigurationToDelete(null);
  }

  const { distributions } = useCollectorDistributions();
  const settledSearch = useSettled(search, SEARCH_DELAY_MS);
  const list = useConfigurationsList({ search: settledSearch, filter });

  useEffect(() => {
    const stored = readViewMode();
    if (stored) setViewMode(stored);
  }, []);

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    writeViewMode(mode);
  };

  const handleOpen = (configuration: Configuration) => {
    void navigate(`/editor/${configuration.id}`);
  };

  const canDelete = (configuration: Configuration) => canDeleteConfiguration(configuration, currentUserId, role);

  const handleDeleteClick = (configuration: Configuration) => {
    setConfigurationToDelete(configuration);
    setDeleteDialogOpen(true);
  };

  if (list.items === null) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center gap-2.5 text-center">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-muted-foreground/25 border-t-muted-foreground" />
        <p className="text-[13px] text-muted-foreground">
          Loading configurations…
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-card border-b border-border">
        <div className="flex h-[52px] items-center justify-between px-5">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
              Configurations
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-md border border-border p-0.5">
              <button
                onClick={() => handleViewModeChange("grid")}
                className={`flex h-7 w-8 items-center justify-center rounded-[4px] transition-colors ${
                  viewMode === "grid"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Grid view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => handleViewModeChange("list")}
                className={`flex h-7 w-8 items-center justify-center rounded-[4px] transition-colors ${
                  viewMode === "list"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="List view"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            </div>
            <Button
              onClick={() => setNewConfigurationDialogOpen(true)}
              id="createNewConfigurationButton"
            >
              <Plus className="h-4 w-4" />
              New configuration
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-5 py-4">
        {/* Toolbar: search + filter */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search configurations…"
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
            <SelectTrigger className="w-full sm:w-40">
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

        {list.items.length === 0 && !list.isFiltered ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-14 text-center">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">
              No configurations yet.
            </p>
            <Button
              variant="outline"
              onClick={() => setNewConfigurationDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              New configuration
            </Button>
          </div>
        ) : list.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-14 text-center">
            <Search className="h-5 w-5 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">
              Nothing matches your search or filter.
            </p>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {list.items.map((config) => (
              <ConfigurationCard
                key={config.id}
                configuration={config}
                isOwn={config.createdBy?.userId === currentUserId}
                canDelete={canDelete(config)}
                onOpen={handleOpen}
                onDelete={handleDeleteClick}
                distributions={distributions}
              />
            ))}
          </div>
        ) : (
          <ConfigurationsTable
            configurations={list.items}
            currentUserId={currentUserId}
            canDelete={canDelete}
            onOpen={handleOpen}
            onDelete={handleDeleteClick}
            distributions={distributions}
          />
        )}

        {list.items.length > 0 && list.hasMore && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              onClick={list.loadMore}
              disabled={list.isLoadingMore || list.isStale}
            >
              {list.isLoadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>
      <CreateConfigurationDialog
        open={newConfigurationDialogOpen}
        onOpenChange={setNewConfigurationDialogOpen}
        organizationId={organizationId}
      />
      <DeleteConfigurationDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        configuration={configurationToDelete}
        organizationId={organizationId}
        onDeleted={list.reload}
      />
      <PlaygroundSaveDialog organizationId={organizationId} />
    </div>
  );
}
