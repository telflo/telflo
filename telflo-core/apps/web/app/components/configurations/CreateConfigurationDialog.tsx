import { ArrowLeft, FilePlus2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  CONFIGURATION_DESCRIPTION_MAXIMUM_LENGTH,
  CONFIGURATION_NAME_MAXIMUM_LENGTH,
  type CollectorDistribution,
  type Configuration,
  type Flow,
} from "@telflo/contracts";
import { iconFor, iconForDistribution, shortLabelFor } from "~/components/collector/distribution-icons.js";
import { FlowPicker } from "~/components/flows/FlowPicker.js";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "~/components/ui/select.js";
import { Textarea } from "~/components/ui/textarea.js";
import { captureEvent } from "~/lib/analytics.js";
import { createConfiguration } from "~/lib/api-client.js";
import {
  configurationRefusalMessage,
  isOrganizationGone,
  isTermsAcceptanceRequired,
  useStillCurrent,
} from "~/lib/configurations.js";
import {
  FlowNotLoadableError,
  createConfigurationFromFlow,
  flowCopyPin,
  pinMovedSentence,
} from "~/lib/flows/instantiate-flow.js";
import { useFlowsWhenOpen } from "~/lib/flows/use-flows.js";
import { findDistribution, useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";

/*
 * Creating a configuration: the start, browse and name steps. The start step
 * offers a blank configuration or a flow; the browse step is the flows
 * picker; the name step names the copy:
 * - the flows are read each time the dialog opens, through the browser
 *   client, the published ones only, for a product admin too; a read that
 *   fails leaves the list empty, so the browse step says "No flows are
 *   available right now.";
 * - the blank path's distribution is a dropdown (a real dropdown, built for
 *   several distributions, with one today): each option its mark, the
 *   catalog's label and description, the default marked "Default", and the
 *   catalog's default preselected; under its label, a note that it is
 *   locked once the configuration is created. No collector version is sent:
 *   the server gives version 1 the distribution's default. While the
 *   catalog is unread nothing is offered, and a create then names no
 *   distribution, which is the catalog's default on the server; a catalog
 *   that couldn't be read says so, without naming its distribution (the
 *   page can't know it), and the create goes on. Reopening preselects the
 *   default again, so an abandoned pick never carries over;
 * - the flow path: the flow's name and summary prefilled, and in place of the
 *   dropdown the read-only `{mark} {short label} · collector v{version} — set
 *   by this flow`, with no lock note. A pin the catalog no longer offers
 *   moves the copy to the distribution's default version, which a sentence
 *   says; the copy is made by `createConfigurationFromFlow` (the flow's YAML,
 *   its graph, its pin and its slug);
 * - Create is enabled once the trimmed name isn't empty, checked after each
 *   keystroke lands, so the first character enables it and deleting the
 *   last one disables it;
 * - after a create the editor opens at `/editor/{id}`, and the dialog stays
 *   as it is, saying Creating… with Create and Back disabled, until the
 *   editor replaces the page, as the flow and playground dialogs do. Opening
 *   the editor can take seconds on a slow connection; were the dialog to
 *   close, or to offer Create again, in that time, a click or an Enter would
 *   create a second configuration, and the editor would move to it;
 * - a refusal says the API's message, anything else "Failed to create
 *   configuration"; a flow whose YAML can't be read says "This flow could not
 *   be loaded: …". A 404 `organization_not_found` closes the dialog and
 *   revalidates the layout instead: the page moves to the session's
 *   organization. So does a 403 `terms_acceptance_required`, with no toast:
 *   the layout's terms dialog opens, and the list reloads after Accept;
 * - Back, Cancel, Escape, an outside click and the close button do nothing
 *   while the create is under way, or once it has succeeded, as in the
 *   delete dialog, so a second create can't be started beside it;
 * - a create that answers after the dialog has unmounted, or after the
 *   organization changed, does nothing: it closes, navigates, toasts and
 *   captures nothing, so a fresh dialog open meanwhile keeps its text.
 * `config_created` is the PostHog event's name, kept for continuity; it
 * carries no properties, on either path: no flow's name or text reaches an
 * event.
 */

export const CREATE_FAILED_MESSAGE = "Failed to create configuration";

/** Under the Distribution label: the permanence note. */
export const DISTRIBUTION_LOCK_NOTE =
  "Which collector build this configuration is for. This is locked once the configuration is created.";

/** When the catalog couldn't be read: the create goes on, on the server's default. */
export const DISTRIBUTION_UNAVAILABLE_NOTE =
  "The distribution list couldn't be loaded, so this configuration will be created on the default distribution.";

/** The catalog's default distribution, else its first; undefined for an empty or unread one. */
function defaultDistribution(distributions: readonly CollectorDistribution[] | null): CollectorDistribution | undefined {
  return distributions?.find((distribution) => distribution.isDefault) ?? distributions?.[0];
}

interface CreateConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
}

/** The steps: how to start, the flows, and the name. */
type Step = "start" | "browse" | "name";

export function CreateConfigurationDialog({ open, onOpenChange, organizationId }: CreateConfigurationDialogProps) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [step, setStep] = useState<Step>("start");
  /** The flow the copy is made from; null on the blank path. */
  const [flow, setFlow] = useState<Flow | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Reentry guard: a double Enter, or Enter then a click, lands before the
  // state below has re-rendered, and would otherwise create twice.
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const isStillCurrent = useStillCurrent(organizationId);
  // Read when the dialog opens: once per page, and again after a failure.
  const { distributions, failed: catalogueFailed } = useCollectorDistributions(open);
  // Read when the dialog opens, so the start step can count them and the
  // browse step rarely waits.
  const flows = useFlowsWhenOpen(open);
  /** The distribution picked; null until the catalog has been read (then its default), and on each opening. */
  const [pickedDistribution, setPickedDistribution] = useState<string | null>(null);
  const shownDistribution =
    findDistribution(distributions, pickedDistribution) ?? defaultDistribution(distributions);

  // Reopening starts at the start step with empty fields, rather than an
  // abandoned attempt's. The reentry guard isn't reset: only the create
  // under way clears it, when it answers, so a dialog the page closed and
  // reopened meanwhile can't start a second one.
  useEffect(() => {
    if (open) {
      setStep("start");
      setFlow(null);
      setName("");
      setDescription("");
      setPickedDistribution(null);
    }
  }, [open]);

  const close = () => {
    if (!creatingRef.current) onOpenChange(false);
  };

  const onDialogOpenChange = (next: boolean) => {
    if (!next) close();
  };

  const backToStart = () => {
    if (!creatingRef.current) setStep("start");
  };

  const chooseBlank = () => {
    setFlow(null);
    setStep("name");
  };

  const chooseFlow = (selected: Flow) => {
    setFlow(selected);
    setName(selected.name);
    setDescription(selected.summary);
    setStep("name");
  };

  /** The request for the path chosen: the blank one, or a copy of the flow. */
  const send = (sentIn: string): Promise<Configuration> => {
    if (flow !== null) {
      return createConfigurationFromFlow({
        flow,
        organizationId: sentIn,
        name: name.trim(),
        description: description.trim(),
        distributions,
      }).then(({ configuration }) => configuration);
    }
    return createConfiguration(sentIn, {
      name: name.trim(),
      description: description.trim(),
      ...(shownDistribution === undefined ? {} : { collectorDistribution: shownDistribution.id }),
    }).then(({ configuration }) => configuration);
  };

  const create = async () => {
    if (creatingRef.current || !name.trim()) return;
    creatingRef.current = true;
    setCreating(true);
    const sentIn = organizationId;
    let created: Configuration;
    try {
      created = await send(sentIn);
    } catch (error) {
      creatingRef.current = false;
      setCreating(false);
      if (!isStillCurrent(sentIn)) return;
      if (isOrganizationGone(error) || isTermsAcceptanceRequired(error)) {
        onOpenChange(false);
        void revalidate();
        return;
      }
      toast.error(
        error instanceof FlowNotLoadableError ? error.message : configurationRefusalMessage(error, CREATE_FAILED_MESSAGE),
      );
      return;
    }
    // Still creating: the editor replaces this page, and with it the dialog.
    if (!isStillCurrent(sentIn)) {
      creatingRef.current = false;
      setCreating(false);
      return;
    }
    captureEvent("config_created");
    void navigate(`/editor/${created.id}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void create();
    }
  };

  if (step === "start") {
    return (
      <Dialog open={open} onOpenChange={onDialogOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New configuration</DialogTitle>
            <DialogDescription>Start from scratch, or from a prebuilt flow you can edit.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <StartOption
              icon={<FilePlus2 className="h-4 w-4" />}
              title="Blank configuration"
              subtitle="An empty canvas"
              onClick={chooseBlank}
            />
            <StartOption
              icon={<Sparkles className="h-4 w-4" />}
              title="Start from a flow"
              subtitle={
                flows.flows.length > 0 ? `${flows.flows.length} prebuilt configurations` : "Prebuilt configurations"
              }
              onClick={() => setStep("browse")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (step === "browse") {
    return (
      <Dialog open={open} onOpenChange={onDialogOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Start from a flow</DialogTitle>
            <DialogDescription>
              Prebuilt configurations, each solving one problem. You&apos;ll get your own editable copy.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            {flows.status === "loading" ? (
              <div className="flex justify-center py-10">
                <div
                  role="status"
                  aria-label="Loading flows"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
                />
              </div>
            ) : flows.flows.length === 0 ? (
              <p className="py-10 text-center text-[13px] text-muted-foreground">No flows are available right now.</p>
            ) : (
              <FlowPicker flows={flows.flows} onSelect={chooseFlow} compact selectedSlug={flow?.slug ?? null} />
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={backToStart}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onDialogOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Name Your Configuration</DialogTitle>
          <DialogDescription>
            {flow !== null
              ? `Based on ${flow.name}. Your copy is independent — editing it won't affect the flow.`
              : "Give your OpenTelemetry configuration a descriptive name"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="configuration-name" className="mb-2 block">
              Configuration Name
            </Label>
            <Input
              id="configuration-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g., Production Monitoring"
              autoFocus
              maxLength={CONFIGURATION_NAME_MAXIMUM_LENGTH}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="configuration-description" className="mb-2 block">
              Description
            </Label>
            <Textarea
              id="configuration-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Collects traces and metrics from production k8s cluster"
              rows={3}
              maxLength={CONFIGURATION_DESCRIPTION_MAXIMUM_LENGTH}
            />
          </div>
          {flow !== null ? (
            <FlowDistributionNote flow={flow} distributions={distributions} />
          ) : shownDistribution !== undefined && distributions !== null ? (
            <DistributionField
              distributions={distributions}
              selected={shownDistribution}
              onSelect={setPickedDistribution}
              disabled={creating}
            />
          ) : (
            catalogueFailed && (
              <p className="text-[12px] leading-[1.4] text-muted-foreground">{DISTRIBUTION_UNAVAILABLE_NOTE}</p>
            )
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={backToStart} disabled={creating}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            type="button"
            disabled={!name.trim() || creating}
            onClick={() => {
              void create();
            }}
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The flow path's distribution: no choice, the flow was built for one, so a
 * read-only line in place of the dropdown, `{mark} {short label} · collector
 * v{version} — set by this flow`, the mark and label from the catalog, else
 * from the id. The version is the one the copy gets: the flow's pin, or the
 * distribution's default when the catalog no longer offers it, which the
 * sentence under it says.
 */
function FlowDistributionNote({
  flow,
  distributions,
}: {
  flow: Flow;
  distributions: readonly CollectorDistribution[] | null;
}) {
  const catalogueRow = findDistribution(distributions, flow.collectorDistribution);
  const Icon = catalogueRow ? iconFor(catalogueRow.icon) : iconForDistribution(flow.collectorDistribution);
  const label = shortLabelFor(flow.collectorDistribution, catalogueRow?.label ?? flow.collectorDistribution);
  const pin = flowCopyPin(flow, distributions);
  const moved = pinMovedSentence(pin);
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <span aria-hidden="true" className="flex shrink-0">
          <Icon className="h-3.5 w-3.5" />
        </span>
        {label} · collector v{pin.version} — set by this flow
      </p>
      {moved !== null && <p className="text-[12px] leading-[1.4] text-muted-foreground">{moved}</p>}
    </div>
  );
}

/** One of the start step's two choices. */
function StartOption({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-gray-300 dark:hover:border-gray-600"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-foreground">{title}</span>
        <span className="block text-[12px] text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  );
}

/**
 * The create's Distribution dropdown: the trigger shows the picked
 * distribution's mark and compact name; each option its mark, the catalog's
 * label and description, the default marked. Every string is the catalog's
 * (catalog data may go anywhere); the options' values are the distributions'
 * ids.
 */
function DistributionField({
  distributions,
  selected,
  onSelect,
  disabled,
}: {
  distributions: readonly CollectorDistribution[];
  selected: CollectorDistribution;
  onSelect: (distributionId: string) => void;
  disabled: boolean;
}) {
  const SelectedIcon = iconFor(selected.icon);
  return (
    <div className="space-y-2">
      <Label htmlFor="configuration-distribution" className="mb-2 block">
        Distribution
      </Label>
      <p id="configuration-distribution-note" className="text-[12px] leading-[1.4] text-muted-foreground">
        {DISTRIBUTION_LOCK_NOTE}
      </p>
      <Select value={selected.id} onValueChange={onSelect} disabled={disabled}>
        <SelectTrigger id="configuration-distribution" aria-describedby="configuration-distribution-note">
          {/* A div, not a span: the trigger's `[&>span]:line-clamp-1` would stack the mark over the name. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="flex shrink-0">
              <SelectedIcon className="h-4 w-4" />
            </span>
            <span className="truncate">{shortLabelFor(selected.id, selected.label)}</span>
          </div>
        </SelectTrigger>
        <SelectContent>
          {distributions.map((distribution) => {
            const Icon = iconFor(distribution.icon);
            return (
              <SelectItem
                key={distribution.id}
                value={distribution.id}
                description={distribution.description ?? undefined}
              >
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="flex shrink-0">
                    <Icon className="h-4 w-4" />
                  </span>
                  {distribution.label}
                  {distribution.isDefault && (
                    <span className="rounded-[4px] border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
                      Default
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
