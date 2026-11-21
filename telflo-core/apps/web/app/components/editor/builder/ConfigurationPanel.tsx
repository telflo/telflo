import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { componentIcon, nodeAccentVar } from "./component-icons.js";
import { ConfigField } from "./config-forms/ConfigField.js";
import { ConfigSection } from "./config-forms/ConfigSection.js";
import { FormProvider, useComponentForm } from "./config-forms/form-context.js";
import { formFor } from "./config-forms/registry.js";
import { PipelineGroupConfigPanel } from "./PipelineGroupConfigPanel.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Textarea } from "~/components/ui/textarea.js";
import { OWN_KEYS_PROPS } from "~/hooks/useUndoRedo.js";
import { useHeldEdit } from "~/lib/editor/held-edits.js";
import { isSaveShortcut } from "~/lib/editor/unsaved-guard.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import { getComponentDocsUrl } from "~/lib/graph/otel-docs.js";
import { findPaletteEntry } from "~/lib/graph/palette.js";
import { boxTextReads, componentValueText, TextEditError } from "~/lib/graph/text-edits.js";
import type { ComponentType, OTelNode } from "~/lib/graph/types.js";
import { selectIsEditingLocked, useEditorStore, type EditorState } from "~/lib/stores/editor-store.js";

/*
 * The Configuration tab, without organization variables. Its states, in
 * order: the multi-selection summary, "No node selected", a pipeline group
 * (`PipelineGroupConfigPanel`), and a component: the identity header
 * (icon, label, Docs link, help text), then one of two layouts:
 * - a component with a form (`config-forms/registry.ts`, by its type and
 *   palette sub-type): the form, then the collapsed "Advanced: Instance &
 *   YAML" section holding the instance name and the Raw YAML box (260 px,
 *   "Edits sync with the form fields above.");
 * - a component without one, or whose value is neither a mapping nor empty
 *   (`otlp: [a]`, whose box is the way to fix it): the Raw YAML box
 *   (360 px) and the collapsed "Advanced" section with the instance name.
 * The form and the box both write the text, and each shows what the other
 * wrote on the next render. An undeclared component's form is disabled,
 * with `UNDECLARED_COMPONENT_MESSAGE` under the header, as text, once: its
 * box in "Advanced" doesn't say it again.
 *
 * Delete, Backspace and Cmd/Ctrl+D pressed anywhere in the tab are its
 * controls' own, never the canvas's (`OWN_KEYS_PROPS`).
 *
 * The YAML box shows the component's own text from the document, comments
 * included, and keeps what is typed. 300 ms after the typing stops, or
 * when the box loses focus, the component's value in the text becomes the
 * box's, if the box reads as a mapping or is empty; while it doesn't, a
 * message shows under the box as text (never a toast on every keystroke,
 * nor a dropped keystroke), and nothing is written. The box follows the
 * text when the component's value changes elsewhere (undo, the YAML tab's
 * Apply), never while the person is typing.
 *
 * A component the text names in a pipeline but doesn't declare has no value
 * to edit: its box is disabled, with a hint as text. A box that defines an
 * anchor the text defines elsewhere is refused (it would re-bind the text's
 * later aliases), and says so under the box, as text.
 *
 * The instance name keeps what is typed and renames the component once, on
 * blur or Enter; Escape puts the name back (a rename on every keystroke
 * would let a name typed through another instance's, "" on the way to a new
 * name, link the two and lose the component's own value). A committed name
 * equal to another instance's links them.
 *
 * An edit a field holds that the store doesn't have yet (a name not yet
 * committed, a box write waiting for its pause, or one refused) is a held
 * edit (`held-edits`), guarded as unsaved work is: Cmd/Ctrl+S in the field
 * commits it first and then reaches the page, whose save flushes every held
 * edit too; the field commits when it goes; and closing or reloading the
 * tab asks the browser's question. A navigation elsewhere in the app writes
 * every held edit before the page's navigation guard judges it,
 * blurred or not (Back), so the guard sees the change. Neither field ever
 * writes into a configuration loaded after its edit began.
 *
 * Labels, instance names and values are text only, never an attribute. While
 * the canvas is locked the fields are disabled, and on a published version,
 * whose tab opens for inspection.
 */

/** The message shown under the box. */
export const RAW_YAML_UNREADABLE_MESSAGE = "Raw YAML doesn't parse. Fix the syntax to apply the edit.";

/** Under the box of a component the text names but doesn't declare, which is disabled. */
export const UNDECLARED_COMPONENT_MESSAGE =
  "This component isn't declared in the YAML. Declare it in the YAML tab to edit it here.";

/** Under the box when its write is refused for an anchor name the text defines elsewhere. */
export const ANCHOR_CLASH_MESSAGE =
  "This YAML reuses an anchor name defined elsewhere in the configuration. Rename the anchor to apply the edit.";

/** Under the box of a component without a form. */
export const FALLBACK_BOX_HINT = "No form for this component yet. Edit its YAML directly.";

/** Under the box in a form's "Advanced: Instance & YAML" section. */
export const FORM_BOX_HINT = "Edits sync with the form fields above.";

/** How long after the last keystroke the box writes. */
export const BOX_WRITE_DELAY_MS = 300;

/** The multi-selection summary lists this many labels. */
const SUMMARY_LABELS = 5;

const TYPE_DOT_CLASSES: Readonly<Record<ComponentType, string>> = {
  receiver: "bg-node-receiver",
  processor: "bg-node-processor",
  exporter: "bg-node-exporter",
  connector: "bg-node-connector",
  extension: "bg-node-extension",
};

/** Renders the palette help text with `code` spans in mono. */
function renderInlineCode(text: string) {
  return text.split(/`([^`]+)`/g).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="font-mono text-[11px]">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function isComponentType(type: string): type is ComponentType {
  return Object.hasOwn(TYPE_DOT_CLASSES, type);
}

/**
 * The component's own text in the document, for the box: the text the
 * document was read from (in manual edit mode, the text from before the
 * typing), or nothing when the text can't be read or doesn't declare it.
 */
function storedBoxText(
  state: Pick<EditorState, "text" | "preEditText" | "isYamlEditing" | "document">,
  key: string,
): string {
  const text = state.isYamlEditing ? (state.preEditText ?? "") : state.text;
  if (state.document === null) return "";
  try {
    return componentValueText(text, key, state.document);
  } catch (error) {
    if (error instanceof TextEditError) return "";
    throw error;
  }
}

export function ConfigurationPanel() {
  // A wrapper that doesn't lay out, marking the tab's keys as its own.
  return (
    <div className="contents" {...OWN_KEYS_PROPS}>
      <PanelContent />
    </div>
  );
}

function PanelContent() {
  const selectedNode = useEditorStore((state) => state.selectedNode);
  const selectedNodes = useEditorStore((state) => state.selectedNodes);
  const loadCount = useEditorStore((state) => state.loadCount);

  // Multi-selection summary
  if (selectedNodes.length > 1) {
    return <SelectionSummary nodes={selectedNodes} />;
  }

  if (!selectedNode) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-[13px]">No node selected</p>
          <p className="text-xs mt-1 text-muted-foreground/70">Select a node to configure it</p>
        </div>
      </div>
    );
  }

  // Route pipeline group nodes to their dedicated config panel
  if (selectedNode.type === "pipelineGroup") {
    return <PipelineGroupConfigPanel />;
  }

  // Keyed by the load too: node ids restart with each configuration loaded, and a form's local state (an
  // empty held row, a pending filter side) mustn't pass to another text's component.
  return <ComponentConfiguration key={`${loadCount}:${selectedNode.id}`} node={selectedNode} />;
}

function SelectionSummary({ nodes }: { nodes: readonly OTelNode[] }) {
  const componentNodes = nodes.filter((n) => n.type !== "pipelineGroup");
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
      <div className="text-center space-y-3">
        <p className="text-[13px] font-medium text-foreground">{componentNodes.length} nodes selected</p>
        <div className="text-xs space-y-1">
          {componentNodes.slice(0, SUMMARY_LABELS).map((node) => (
            <div key={node.id} className="flex items-center gap-2 justify-center">
              <span
                className={`tf-dot ${isComponentType(node.data.componentType) ? TYPE_DOT_CLASSES[node.data.componentType] : TYPE_DOT_CLASSES.extension}`}
              />
              <span className="font-mono text-[11px]">{node.data.label}</span>
            </div>
          ))}
          {componentNodes.length > SUMMARY_LABELS && (
            <p className="text-muted-foreground/70">…and {componentNodes.length - SUMMARY_LABELS} more</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground/70 mt-4">Delete removes the selection, Ctrl+D duplicates it</p>
      </div>
    </div>
  );
}

function ComponentConfiguration({ node }: { node: OTelNode }) {
  const locked = useEditorStore(selectIsEditingLocked);
  const { componentType, componentSubType } = node.data;
  const type = isComponentType(componentType) ? componentType : undefined;
  const paletteEntry = type ? findPaletteEntry(type, componentSubType) : undefined;
  const HeaderIcon = componentIcon(componentType, componentSubType);
  const accentColor = type ? nodeAccentVar[type] : nodeAccentVar.extension;
  const docsUrl = type ? getComponentDocsUrl(type, componentSubType) : null;
  const form = useComponentForm(node.id);
  const Form = type ? formFor(type, componentSubType) : undefined;
  const valueKind = form.read([]).kind;
  const withForm = Form !== undefined && (valueKind === "map" || valueKind === "absent");
  const undeclared = node.data.declared === false;
  const nodeKey = componentKey(node.data) ?? "";

  const instanceNameField = (
    <ConfigField
      label="Instance Name"
      htmlFor="instance-name"
      description={`Appended to the YAML id as ${componentSubType}/<name>.`}
    >
      <InstanceNameInput nodeId={node.id} instanceName={node.data.instanceName ?? ""} disabled={locked} />
    </ConfigField>
  );

  return (
    // The component's settings, its instance name and its raw YAML are
    // configuration text: replay never records the panel (the playground's
    // or the signed-in editor's).
    <div className="flex-1 flex flex-col p-4 overflow-y-auto ph-no-capture">
      {/* Component identity header — mirrors the canvas node card: type-tinted
          icon chip, title, Docs link, then what the component actually does. */}
      <div className="mb-4 border-b border-border pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px]"
              style={{
                background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
                color: accentColor,
              }}
            >
              <HeaderIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>
            <h3 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
              {node.data.label}
            </h3>
          </div>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-6 shrink-0 items-center gap-1 rounded-[5px] px-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Docs
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {paletteEntry?.helpText && (
          <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{renderInlineCode(paletteEntry.helpText)}</p>
        )}
      </div>

      <div className="flex-1">
        {withForm ? (
          <>
            {undeclared && (
              <p className="mb-4 text-[11px] leading-4 text-muted-foreground">{UNDECLARED_COMPONENT_MESSAGE}</p>
            )}
            <FormProvider form={form}>
              <Form />
            </FormProvider>
            <ConfigSection title="Advanced: Instance & YAML" className="mt-4">
              {instanceNameField}
              <RawYamlBox
                nodeId={node.id}
                nodeKey={nodeKey}
                disabled={locked}
                undeclared={undeclared}
                explainUndeclared={false}
                heightClass="h-[260px]"
                hint={FORM_BOX_HINT}
              />
            </ConfigSection>
          </>
        ) : (
          <div className="space-y-4">
            <RawYamlBox
              nodeId={node.id}
              nodeKey={nodeKey}
              disabled={locked}
              undeclared={undeclared}
              explainUndeclared
              heightClass="h-[360px]"
              hint={FALLBACK_BOX_HINT}
            />
            <ConfigSection title="Advanced">{instanceNameField}</ConfigSection>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The instance name: a draft while it is typed, renamed once on blur or
 * Enter (or when the field goes, another node selected); Escape puts the
 * name back. Out of editing it shows the node's name, so an undo shows too.
 */
function InstanceNameInput({ nodeId, instanceName, disabled }: { nodeId: string; instanceName: string; disabled: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  /** The load the draft began in: a draft never renames a node of another configuration. */
  const draftLoad = useRef(0);

  const setDraftValue = (value: string | null) => {
    if (value !== null && draftRef.current === null) draftLoad.current = useEditorStore.getState().loadCount;
    draftRef.current = value;
    setDraft(value);
  };

  /** Renames to the draft, if one is waiting; the store does nothing for an unchanged name. */
  const commit = () => {
    const typed = draftRef.current;
    if (typed === null) return;
    setDraftValue(null);
    const store = useEditorStore.getState();
    if (store.loadCount === draftLoad.current) store.renameInstance(nodeId, typed);
  };
  // Held while it differs from the name; committed when the field goes (another node selected).
  useHeldEdit(draft !== null && draft !== instanceName, commit);

  return (
    <Input
      id="instance-name"
      // A component's name is configuration text: replay never records the field.
      className="ph-no-capture"
      value={draft ?? instanceName}
      onChange={(e) => setDraftValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // Committed before the key reaches the page, whose save then has the name.
        if (isSaveShortcut(e)) {
          commit();
        } else if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draftRef.current !== null) {
          e.preventDefault();
          setDraftValue(null);
        }
      }}
      placeholder="e.g. enricher, high-priority"
      disabled={disabled}
    />
  );
}

/**
 * The Raw YAML box. `synced` is the component's text the box
 * last agreed with: what it was filled from, or what its own write left in
 * the text. When the text's value differs from it, the value changed
 * elsewhere, and the box follows unless a write is waiting (the person is
 * typing).
 */
function RawYamlBox({
  nodeId,
  nodeKey,
  disabled,
  undeclared,
  explainUndeclared,
  heightClass,
  hint,
}: {
  nodeId: string;
  nodeKey: string;
  disabled: boolean;
  undeclared: boolean;
  /** Whether the box says why it's disabled when undeclared; under a form, the form's header says it once. */
  explainUndeclared: boolean;
  /** The heights: 360 px alone, 260 px under a form. */
  heightClass: "h-[360px]" | "h-[260px]";
  hint: string;
}) {
  const text = useEditorStore((state) => state.text);
  const preEditText = useEditorStore((state) => state.preEditText);
  const isYamlEditing = useEditorStore((state) => state.isYamlEditing);
  const document = useEditorStore((state) => state.document);
  const stored = useMemo(
    () => storedBoxText({ text, preEditText, isYamlEditing, document }, nodeKey),
    [text, preEditText, isYamlEditing, document, nodeKey],
  );

  const [draft, setDraft] = useState(stored);
  const [unreadable, setUnreadable] = useState(false);
  const [anchorClash, setAnchorClash] = useState(false);
  /** The box holds an edit the text doesn't have: waiting for its pause, or refused. */
  const [uncommitted, setUncommitted] = useState(false);
  const draftRef = useRef(stored);
  const synced = useRef(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The load the held edit began in, null while none is held: an edit never
   * writes into a configuration loaded since, whose nodes can
   * have the same ids, as the instance name's draft never renames one.
   */
  const editLoad = useRef<number | null>(null);

  useEffect(() => {
    if (stored === synced.current || timer.current !== null) return;
    synced.current = stored;
    draftRef.current = stored;
    editLoad.current = null;
    setDraft(stored);
    setUnreadable(false);
    setAnchorClash(false);
    setUncommitted(false);
  }, [stored]);

  /** Writes what the box holds, if it reads; otherwise says so and writes nothing. */
  const write = () => {
    const box = draftRef.current;
    if (editLoad.current !== useEditorStore.getState().loadCount) return;
    if (!boxTextReads(box)) {
      setUnreadable(true);
      setAnchorClash(false);
      return;
    }
    setUnreadable(false);
    const result = useEditorStore.getState().setComponentValue(nodeId, box);
    setAnchorClash(result === "anchor-clash");
    if (result !== "written") return;
    editLoad.current = null;
    setUncommitted(false);
    const after = useEditorStore.getState();
    const node = after.graph.nodes.find((n) => n.id === nodeId);
    synced.current = storedBoxText(after, node ? (componentKey(node.data) ?? nodeKey) : nodeKey);
  };

  /** Runs a waiting write now (a pause, the box losing focus, or another node selected). */
  const flush = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    write();
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Held until written; a write still waiting when the box goes (another node selected) is made then.
  useHeldEdit(uncommitted, flush);

  const handleChange = (value: string) => {
    editLoad.current ??= useEditorStore.getState().loadCount;
    draftRef.current = value;
    setDraft(value);
    setUncommitted(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), BOX_WRITE_DELAY_MS);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="raw-yaml" className="text-[13px] font-medium text-foreground">
        Raw YAML
      </Label>
      <Textarea
        id="raw-yaml"
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          // Written before the key reaches the page, whose save then has it.
          if (isSaveShortcut(e)) flush();
        }}
        disabled={disabled || undeclared}
        className={`font-mono text-xs ${heightClass}`}
      />
      {undeclared && explainUndeclared && (
        <p className="text-[11px] leading-4 text-muted-foreground">{UNDECLARED_COMPONENT_MESSAGE}</p>
      )}
      {unreadable && <p className="text-[11px] leading-4 text-fail">{RAW_YAML_UNREADABLE_MESSAGE}</p>}
      {anchorClash && <p className="text-[11px] leading-4 text-fail">{ANCHOR_CLASH_MESSAGE}</p>}
      <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p>
    </div>
  );
}
