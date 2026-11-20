import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  CreateFlowRequestSchema,
  FLOW_AUTHOR_NAME_MAXIMUM_LENGTH,
  FLOW_NAME_MAXIMUM_LENGTH,
  FLOW_SLUG_MAXIMUM_LENGTH,
  FLOW_SUMMARY_MAXIMUM_LENGTH,
  type Flow,
  type FlowLintFinding,
} from "@telflo/contracts";
import { Badge } from "~/components/ui/badge.js";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { Textarea } from "~/components/ui/textarea.js";
import { lintFlow } from "~/lib/api-client.js";
import { deriveSignals, isProductAdminRefusal, slugify, type FlowFields } from "~/lib/flows/flow-admin.js";
import { resolveFlowVersion } from "~/lib/flows/resolve-flow-version.js";
import { findDistribution, useCollectorDistributions } from "~/lib/stores/collector-catalogue-store.js";

/*
 * A flow's dialog, with its fields, limits, copy, messages and layout:
 * - the distributions and versions come from the collector catalogue the
 *   rest of the app reads; the version select offers the distribution's
 *   versions, newest first, and falls back to the catalogue's default
 *   (resolveFlowVersion). Editing a flow whose pin the catalogue no longer
 *   offers, the select shows that pin, marked, as its current choice;
 * - the signals are derived from the text (deriveSignals);
 * - the fields are checked against the API's contract before saving, so a
 *   refusal is the contract's sentence rather than "The request was not
 *   valid."; the slug field takes at most 80 characters;
 * - "Run security check" is the API's flow_lint, whose refusal (429 past 20
 *   a minute) shows the API's message; Save is never gated on it;
 * - the YAML textarea and the findings sit inside `ph-no-capture`: an admin
 *   may paste a secret, which is what the check is for. The YAML field
 *   stays a plain textarea.
 * A 403 `product_admin_required` from the check or the save goes to `/app`
 * (`onProductAdminLost`).
 */

interface FlowAdminDialogProps {
  open: boolean;
  /** The flow being edited, or null for a new one. */
  flow: Flow | null;
  onClose: () => void;
  /** Saves the dialog's fields: the page creates, or sends an edit's changes. */
  onSave: (fields: FlowFields) => Promise<void>;
  /** The caller is no longer a product admin (403 `product_admin_required`). */
  onProductAdminLost: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the page gives it back to the opener. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** What the version select shows beside a pin the catalogue no longer offers. */
export const NO_LONGER_OFFERED = "no longer offered";

/** The distribution a new flow starts with: the catalogue's default, or Contrib before it is read. */
const FALLBACK_DISTRIBUTION = "otelcol-contrib";

export function FlowAdminDialog({ open, flow, onClose, onSave, onProductAdminLost, onCloseAutoFocus }: FlowAdminDialogProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [yamlContent, setYamlContent] = useState("");
  const [collectorDistribution, setCollectorDistribution] = useState("");
  const [collectorVersion, setCollectorVersion] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [sourceUrl, setSourceUrl] = useState("");
  const [authorName, setAuthorName] = useState("");

  const [findings, setFindings] = useState<FlowLintFinding[] | null>(null);
  const [linting, setLinting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { distributions } = useCollectorDistributions(open);

  // A version belongs to its distribution, so the version options are the
  // selected distribution's, and the pick is resolved against them on every
  // render (resolveFlowVersion), never left from another distribution.
  const effectiveDistribution =
    collectorDistribution ||
    flow?.collectorDistribution ||
    distributions?.find((distribution) => distribution.isDefault)?.id ||
    FALLBACK_DISTRIBUTION;
  const selectedDistribution = findDistribution(distributions, effectiveDistribution);
  const offers = selectedDistribution?.versions ?? [];
  const effectiveVersion = resolveFlowVersion(
    collectorVersion,
    flow?.collectorDistribution,
    flow?.collectorVersion,
    effectiveDistribution,
    offers,
  );
  // The flow's own pin when the options don't hold it, shown as the current
  // choice: kept although the catalogue no longer offers it, and marked so;
  // unmarked while the catalogue is unread (or its read failed), when
  // nothing is known about it.
  const unlistedPin =
    effectiveVersion !== "" && !offers.some((offer) => offer.version === effectiveVersion) ? effectiveVersion : null;

  // Re-seed from the row being edited. The dialog instance is reused across
  // rows, so without this it shows the previously-opened flow.
  useEffect(() => {
    if (!open) return;
    setName(flow?.name ?? "");
    setSlug(flow?.slug ?? "");
    setSlugTouched(!!flow);
    setSummary(flow?.summary ?? "");
    setDescription(flow?.description ?? "");
    setTags((flow?.tags ?? []).join(", "));
    setYamlContent(flow?.yaml ?? "");
    setCollectorDistribution(flow?.collectorDistribution ?? "");
    setCollectorVersion(flow?.collectorVersion ?? "");
    setSortOrder(flow?.sortOrder ?? 0);
    setSourceUrl(flow?.sourceUrl ?? "");
    setAuthorName(flow?.authorName ?? "");
    setFindings(null);
    setError(null);
  }, [open, flow]);

  const signals = useMemo(() => deriveSignals(yamlContent), [yamlContent]);
  const blockers = (findings ?? []).filter((finding) => finding.severity === "block");
  const warnings = (findings ?? []).filter((finding) => finding.severity === "warn");

  const runLint = async () => {
    setLinting(true);
    setError(null);
    try {
      const result = await lintFlow(yamlContent);
      setFindings(result.findings);
    } catch (e) {
      if (isProductAdminRefusal(e)) {
        onProductAdminLost();
        return;
      }
      // The API's message, a 429's included.
      setError(e instanceof Error ? e.message : "Lint failed");
    } finally {
      setLinting(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    const effectiveSlug = slugTouched ? slug : slugify(name);
    if (!name.trim() || !effectiveSlug || !summary.trim() || !yamlContent.trim()) {
      setError("Name, slug, summary and YAML are all required.");
      return;
    }
    if (signals.length === 0) {
      setError("This config has no pipelines, so it would appear under no signal.");
      return;
    }
    // Mirrors the table's source-link check. Catching it here turns a refusal
    // into a sentence the author can act on.
    const trimmedUrl = sourceUrl.trim();
    if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl)) {
      setError("Source URL must start with http:// or https://");
      return;
    }
    const fields: FlowFields = {
      slug: effectiveSlug,
      name: name.trim(),
      summary: summary.trim(),
      description: description.trim() || summary.trim(),
      signals,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      yaml: yamlContent,
      collectorVersion: effectiveVersion,
      collectorDistribution: effectiveDistribution,
      sourceUrl: trimmedUrl || null,
      authorName: authorName.trim() || null,
      sortOrder,
    };
    // The API's own checks, here, so a refusal says which field and why (its
    // answer to a malformed request is only "The request was not valid.").
    const checked = CreateFlowRequestSchema.safeParse(fields);
    if (!checked.success) {
      setError(checked.error.issues[0]?.message ?? "Failed to save");
      return;
    }
    setSaving(true);
    try {
      await onSave(fields);
      onClose();
    } catch (e) {
      if (isProductAdminRefusal(e)) {
        onProductAdminLost();
        return;
      }
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{flow ? "Edit flow" : "New flow"}</DialogTitle>
          <DialogDescription>
            Published as <strong>Built by {authorName.trim() || "Telflo"}</strong> and visible to every user.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="flow-name">Name</Label>
              <Input
                id="flow-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
                placeholder="Log Volume Cost Control"
                maxLength={FLOW_NAME_MAXIMUM_LENGTH}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="flow-slug">URL slug</Label>
              <Input
                id="flow-slug"
                value={slugTouched ? slug : slugify(name)}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                placeholder="log-volume-cost-control"
                maxLength={FLOW_SLUG_MAXIMUM_LENGTH}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="flow-summary">Summary</Label>
            <Input
              id="flow-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="One line shown on the gallery card"
              maxLength={FLOW_SUMMARY_MAXIMUM_LENGTH}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="flow-description">Description</Label>
            <Textarea
              id="flow-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Long-form explanation shown on the detail page. Blank lines separate paragraphs."
              rows={4}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="flow-tags">Tags</Label>
              <Input id="flow-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="cost, logs" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="flow-distribution">Distribution</Label>
              <Select
                value={effectiveDistribution}
                onValueChange={(next) => {
                  setCollectorDistribution(next);
                  // Reset the pick so resolveFlowVersion resolves to the new
                  // distribution's default, instead of keeping a version that
                  // belongs to the old one.
                  setCollectorVersion("");
                }}
              >
                <SelectTrigger id="flow-distribution">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {(distributions ?? []).map((distribution) => (
                    <SelectItem key={distribution.id} value={distribution.id}>
                      {distribution.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="flow-version">Collector version</Label>
              <Select value={effectiveVersion} onValueChange={setCollectorVersion}>
                <SelectTrigger id="flow-version">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {offers.map((offer) => (
                    <SelectItem key={offer.version} value={offer.version}>
                      {offer.version}
                    </SelectItem>
                  ))}
                  {unlistedPin !== null && (
                    <SelectItem value={unlistedPin}>
                      {selectedDistribution === undefined ? unlistedPin : `${unlistedPin} · ${NO_LONGER_OFFERED}`}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="flow-order">Sort order</Label>
              <Input
                id="flow-order"
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="flow-source-url">Source link (optional)</Label>
              <Input
                id="flow-source-url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://github.com/org/repo/blob/main/config.yaml"
              />
              <p className="text-[12px] text-muted-foreground">
                Shown as a “View source” button on the flow's page. Leave blank and no link appears.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="flow-author">Author (optional)</Label>
              <Input
                id="flow-author"
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                placeholder="ClickStack"
                maxLength={FLOW_AUTHOR_NAME_MAXIMUM_LENGTH}
              />
              <p className="text-[12px] text-muted-foreground">
                For flows derived from someone else's config: badges the flow “Built by …” instead of the Telflo
                default.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="flow-yaml">Configuration YAML</Label>
              {/* Signals are derived, never typed — an author ticking boxes
                  gets it wrong, and the pipelines are unambiguous. */}
              <div className="flex items-center gap-1.5">
                {signals.length === 0 ? (
                  <span className="text-[12px] text-muted-foreground">no pipelines detected</span>
                ) : (
                  signals.map((signal) => (
                    <Badge key={signal} variant="outline">
                      {signal}
                    </Badge>
                  ))
                )}
              </div>
            </div>
            {/* `ph-no-capture`: replay blocks the configuration's text, which
                may hold a pasted secret. */}
            <div className="ph-no-capture">
              <Textarea
                id="flow-yaml"
                value={yamlContent}
                onChange={(e) => {
                  setYamlContent(e.target.value);
                  setFindings(null);
                }}
                placeholder={"receivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317"}
                rows={12}
                className="font-mono text-[12px]"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void runLint()} disabled={linting || !yamlContent.trim()}>
              <ShieldCheck className="h-4 w-4" />
              {linting ? "Checking…" : "Run security check"}
            </Button>
            {findings !== null && blockers.length === 0 && (
              <span className="text-[13px] text-ok">No blocking issues.</span>
            )}
          </div>

          {findings !== null && findings.length > 0 && (
            // The findings quote the configuration's keys and values: replay
            // blocks them as it blocks the text.
            <div className="ph-no-capture space-y-1.5 rounded-lg border border-border bg-card p-3">
              {[...blockers, ...warnings].map((finding, index) => (
                <div key={index} className="flex items-start gap-2 text-[12px]">
                  <AlertTriangle
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${finding.severity === "block" ? "text-fail" : "text-warn"}`}
                  />
                  <span>
                    <span className="font-mono text-muted-foreground">{finding.path}</span> {finding.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {error && <p className="text-[13px] text-fail">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : flow ? "Save changes" : "Create flow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
