import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ConfigField } from "./ConfigField.js";
import { HeldNotices } from "./shared/AdjustmentAlert.js";
import { useCardKeys } from "./shared/card-keys.js";
import { isPrometheusDuration, PROMETHEUS_DURATION_MESSAGE } from "./shared/prometheus-duration.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { DurationInput } from "~/components/ui/duration-input.js";
import { Label } from "~/components/ui/label.js";
import { MultiValueInput } from "~/components/ui/multi-value-input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { Textarea } from "~/components/ui/textarea.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import { isGroup } from "~/lib/graph/canvas-operations.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import type { ParsedText } from "~/lib/graph/parse.js";
import { plainNumber, splitKey, TextEditError, writeValues, type ValueChange, type ValuePath } from "~/lib/graph/text-edits.js";
import { readValue, type ValueView } from "~/lib/graph/value-view.js";
import {
  CANT_EDIT_ON_CANVAS_MESSAGE,
  selectIsEditingLocked,
  TELEMETRY_BASE,
  useEditorStore,
  type ValuesResult,
} from "~/lib/stores/editor-store.js";

/*
 * The form hook and the fields.
 *
 * A form never holds the config. It reads each value from the text's document
 * through a `FormSource` (`read(path)`, `readValue` under the source's base)
 * and sends key-path changes (`apply`, and its shorthands). Two sources:
 * - `useComponentForm(nodeId)`: the component's value in the text; writes
 *   go through the store's `setComponentValues` (one entry per run of
 *   changes within 800 ms, "Update <label>"). Disabled while the canvas is
 *   locked (manual edit mode, a text the canvas can't show), on a published
 *   version, and for an undeclared component.
 * - `useTelemetryDraft(open)`: the Self-monitoring dialog's draft, taken
 *   from the text when the dialog opens. It is a copy of the text with the
 *   dialog's changes written into it by the same text edits, so its fields
 *   show what the text writes (`0750`, `${env:X}`) and its changes are kept
 *   in order: Apply sends them to the store's `setTelemetryValues`, which
 *   writes them into the text as the draft did (a draft reading as the text
 *   again writes nothing).
 *
 * Fields take a path under the source (`FormScope` prefixes one, for a
 * shared section bound to `protocols.grpc`), and follow these rules:
 * - a plain scalar that isn't a string shows its characters as written, a
 *   string its value; an explicit null shows as unset;
 * - unset shows empty, with the collector's default as the placeholder and
 *   in ConfigField's "Default <value>" hint (a checkbox shows its default
 *   ticked or not);
 * - a value the field can't show (a mapping or a list for a scalar; a line
 *   break in a one-line field; not a boolean for a checkbox) makes the
 *   field read-only, with `UNSHOWABLE_VALUE_MESSAGE` under it as text;
 * - a select shows a value outside its options as an extra option, as
 *   written.
 * Typing is held (`useHeldText`): written 300 ms after the last keystroke,
 * at once on blur or Enter, on Cmd/Ctrl+S, and when the field goes; only
 * when it differs from what the field shows. Clearing a field removes its
 * key (a `keepEmpty` text field, and `BareTextField`, write `""`: a list
 * item's keys and items stay). A number field
 * writes what was typed as a plain number when it reads as one (`0`,
 * `1e3`), a string otherwise (`${env:X}`); a duration field writes a
 * string, and shows an error only for what the collector refuses (still
 * writing it).
 *
 * Every field's `id` is fixed by the form; no value, label or path reaches
 * an attribute. No field sits inside a `<form>` element.
 *
 * More fields and options:
 * - `TextField`'s `datalist` (journald's priorities), fixed options under a
 *   fixed id; `EscapedTextField` (recombine's Combine With) shows a newline
 *   as `\n`, a carriage return as `\r`, a tab as `\t` and a backslash as `\\`;
 * - `CheckboxField`'s `uncheckedRemoves` (journald's true-or-removed boxes);
 * - `CheckboxSetField`, a list of fixed items as checkboxes, ticked when the
 *   list holds them; `RadioField`, native radios;
 * - held empty rows (`MultiValueField`'s `holdEmpty`): Add shows a row that
 *   isn't in the text; its first typing appends the item, and the row
 *   becomes the item's in place (same key, so focus and caret stay). Typed
 *   text is a held edit, as any field's; an empty held row is local state,
 *   dropped when it is left empty or the form goes (the Configuration tab
 *   is keyed by the load and the node). A row emptied and left is removed,
 *   never written `""`. `addValue` seeds a row instead (filelog's
 *   `/var/log/*.log`);
 * - `useCheckboxSet`, `CheckboxSetField`'s reading and writing for a form
 *   that lays its boxes out itself (resourcedetection's detector groups),
 *   and `BareSelectField`, a select with no label of its own (k8sattributes'
 *   rule sources and label cards);
 * - `CheckboxField`'s `describedClassName`, described box rows (hostmetrics'
 *   Include Virtual Filesystems and Divide by CPU Count);
 * - `TextField`'s and `CheckboxField`'s `excludes`, pairs the collector
 *   refuses together (csv's Header and Header Attribute, Lazy and Ignore
 *   quotes): typing in one removes the other, ticking one unticks the other,
 *   in the same change, with no alert (as filelog's multiline patterns);
 * - the logs receivers' options: `MultiValueField`'s `emptyRemovesKey` and
 *   row classes, `CheckboxField`'s `onToggle`, `disabled` and block
 *   classes, `TextField`'s `disabled`, `RadioField`'s `optionClassName`
 *   and `ignoreCase`.
 *
 * And: `FormScope`'s `prune`; `SelectField`'s `unsetOption`
 * (`UNSET_OPTION`, `__unset__`); `CheckboxField`'s `checkedRemoves`;
 * `CheckboxSetField`'s `""` item; `NumberField`'s `writeSame`;
 * `MultiValueField`'s `numeric` rows. The rest are in `shared/`:
 * `ListTextField` and `NumberListField`, `NativeSelectField`, held cards
 * (`useHeldItem`, `ItemScope`), `DimensionListField`, and the retry and
 * queue sections' `idPrefix` and `absentMeans`; and `DurationField`'s
 * `grammar: "prometheus"`.
 */

/**
 * A box in an `items-start` row beside a `text-sm` label and its description:
 * the label's first line is 20 px tall (`text-sm` keeps its own line height
 * in a `leading-none` block, as tailwind-merge drops the Label's
 * `leading-none`), so the 16 px box is moved down 2 px to sit centered on it,
 * not 2 px high.
 */
export const DESCRIBED_BOX = "mt-0.5";

/** Under a field whose value in the text it can't show. */
export const UNSHOWABLE_VALUE_MESSAGE = "This value is written in a form this field can't show. Edit it in the YAML below.";

export interface FormSource {
  /** What the text holds at `path` under the source's base. */
  read: (path: ValuePath) => ValueView;
  /** Writes `changes` in order (the store's contract): written, unchanged, or refused. */
  apply: (changes: readonly ValueChange[]) => ValuesResult;
  /** Sets `path` to a value (index `length` appends to a list). */
  set: (path: ValuePath, value: unknown) => ValuesResult;
  /** Sets `path` to a number as typed (`1e3`), written plain. */
  setPlain: (path: ValuePath, chars: string) => ValuesResult;
  /** Removes a key or a list item, by its lines. An item's removal writes held edits first. */
  remove: (path: ValuePath) => ValuesResult;
  /** Moves list item `from` of `listPath` to `to`, its lines as written. Writes held edits first. */
  move: (listPath: ValuePath, from: number, to: number) => ValuesResult;
  /** Renames the mapping key `path` in place; a clash is refused. */
  rename: (path: ValuePath, to: string) => ValuesResult;
  /** The form can't write: its fields are disabled. */
  disabled: boolean;
  /**
   * The component's key in the text (`connectors.routing/tenants`), on a
   * component's own source (`useComponentForm`) only: a form that needs its
   * component's name reads it from the source its fields are given
   * (routing's and failover's pipeline options).
   */
  componentKey?: string | undefined;
  /**
   * The component's node, on a component's own source only: `readLatest`
   * finds the component's key in the store by it, so a rename written since
   * this render (Instance Name's held edit, flushed) is followed.
   */
  nodeId?: string | undefined;
}

const ABSENT: ValueView = { kind: "absent", value: undefined };

/**
 * A source from its reads and its writes. A list item's removal or move
 * writes what fields hold first: a row's draft belongs to its index, which
 * the change shifts.
 */
export function formSource(
  read: (path: ValuePath) => ValueView,
  apply: (changes: readonly ValueChange[]) => ValuesResult,
  disabled: boolean,
): FormSource {
  return {
    read,
    apply,
    set: (path, value) => apply([{ path, value }]),
    setPlain: (path, plain) => apply([{ path, plain }]),
    remove: (path) => {
      if (typeof path[path.length - 1] === "number") flushHeldEdits();
      return apply([{ path, remove: true }]);
    },
    move: (listPath, from, to) => {
      flushHeldEdits();
      return apply([{ path: [...listPath, from], moveTo: to }]);
    },
    rename: (path, to) => apply([{ path, renameTo: to }]),
    disabled,
  };
}

const FormContext = createContext<FormSource | null>(null);

/** Gives the fields below their source. */
export function FormProvider({ form, children }: { form: FormSource; children: ReactNode }) {
  return <FormContext.Provider value={form}>{children}</FormContext.Provider>;
}

/** The source the fields read and write through. */
export function useForm(): FormSource {
  const form = useContext(FormContext);
  if (form === null) throw new Error("A form field is outside a FormProvider.");
  return form;
}

/**
 * The fields below address paths under `path` (a shared section bound to `protocols.grpc`).
 *
 * With `prune`, a change that leaves the scope's block (a mapping) with no
 * keys removes the block instead, in the same write: the file exporter's
 * `rotation`, which the collector reads as on while it exists, syslog's UDP
 * `async`. Only a block that held keys before the change is removed, so a
 * block the text had empty (`rotation: {}`) stays until a key typed into it
 * is cleared. A block holding a key no field shows still holds it after the
 * change, so it is never removed. Nested scopes prune each level: an inner
 * scope's removal of its block is a change to the outer block, which the
 * outer scope then removes in its place when that empties it.
 */
export function FormScope({ path, prune = false, children }: { path: ValuePath; prune?: boolean; children: ReactNode }) {
  const form = useForm();
  const prefixKey = JSON.stringify(path);
  const scoped = useMemo(() => {
    const prefix: ValuePath = JSON.parse(prefixKey) as ValuePath;
    return formSource(
      (inner) => form.read([...prefix, ...inner]),
      (changes) => {
        if (prune && emptiesBlock(form.read(prefix), changes)) return form.apply([{ path: prefix, remove: true }]);
        return form.apply(changes.map((change) => ({ ...change, path: [...prefix, ...change.path] })));
      },
      form.disabled,
    );
  }, [form, prefixKey, prune]);
  // The adjustment messages from below name their paths under the scope: passed on under its path.
  return (
    <FormProvider form={scoped}>
      <HeldNotices prefix={path}>{children}</HeldNotices>
    </FormProvider>
  );
}

/**
 * Whether `changes` (under the block) leave a mapping that held keys with
 * none: each change's first key is followed (a key removed, renamed or
 * set), and the keys the changes don't touch, shown by a field or not, are
 * still there.
 */
export function emptiesBlock(block: ValueView, changes: readonly ValueChange[]): boolean {
  if (block.kind !== "map") return false;
  const keys = new Set(Object.keys(block.value));
  if (keys.size === 0) return false;
  for (const change of changes) {
    const [first] = change.path;
    // The block itself set or removed: nothing to prune.
    if (first === undefined) return false;
    if (typeof first !== "string") return false;
    if ("remove" in change) {
      if (change.path.length === 1) keys.delete(first);
    } else if ("renameTo" in change) {
      if (change.path.length === 1 && keys.delete(first)) keys.add(change.renameTo);
    } else if (!("moveTo" in change)) {
      keys.add(first);
    }
  }
  return keys.size === 0;
}

// ── Sources ──

/** A component's form: its value in the text, written through the store. */
export function useComponentForm(nodeId: string): FormSource {
  const document = useEditorStore((state) => state.document);
  const locked = useEditorStore(selectIsEditingLocked);
  const node = useEditorStore((state) => state.graph.nodes.find((n) => n.id === nodeId));
  const key = node && !isGroup(node) ? componentKey(node.data) : undefined;
  const declared = node?.data.declared !== false;
  const disabled = locked || key === undefined || !declared;

  return useMemo(() => {
    const base = key === undefined ? null : splitKey(key);
    return {
      ...formSource(
        (path) => (document !== null && base !== null ? readValue(document, base, path) : ABSENT),
        (changes) => useEditorStore.getState().setComponentValues(nodeId, changes),
        disabled,
      ),
      componentKey: key,
      nodeId,
    };
  }, [document, key, disabled, nodeId]);
}

/**
 * What the text holds at `path` now, a write made since this render
 * included: a component's own source reads the store's text, any other
 * source its `read`. A button that flushes the fields' held edits and then
 * works out where to write (transform's templates, redaction's Quick Add, a
 * held card's write) reads the list this way, so a typed statement just
 * written is counted, not overwritten. The component's key is the store's
 * for the node now: an Instance Name typed and flushed by the same click
 * renamed it, and the key this render had names nothing, so the list would
 * read as empty and its first item be written over.
 */
export function readLatest(form: FormSource, path: ValuePath): ValueView {
  if (form.nodeId === undefined) return form.read(path);
  const { document, graph } = useEditorStore.getState();
  const node = graph.nodes.find((n) => n.id === form.nodeId);
  const key = node && !isGroup(node) ? componentKey(node.data) : undefined;
  return document !== null && key !== undefined ? readValue(document, splitKey(key), path) : ABSENT;
}

/** The Self-monitoring dialog's draft. */
export interface TelemetryDraft extends FormSource {
  /** The changes written into the draft since it was taken, in order: what Apply sends. */
  changes: readonly ValueChange[];
  /** Whether the draft reads differently from the text it was taken from. */
  changed: boolean;
  /** The text the draft was taken from: Apply writes only while the text is still this. */
  seed: string;
  /** Takes the draft again from the text as it is now, dropping its changes. */
  retake: () => void;
  /**
   * The draft's changes as they are now, a write made since this render
   * included: what Apply sends once it has flushed the held edits. `changes`
   * and `changed` are this render's.
   */
  latest: () => { changes: readonly ValueChange[]; changed: boolean };
}

interface DraftState {
  /** The text when the dialog opened, and the draft's text and its parse. */
  seed: string;
  text: string;
  document: ParsedText | null;
  changes: readonly ValueChange[];
}

function takeDraft(): DraftState {
  const { text, document } = useEditorStore.getState();
  return { seed: text, text, document, changes: [] };
}

/**
 * The dialog's draft: taken from the text each time `open` turns true, and
 * while open only by `retake` (Apply over a text that changed since). Its
 * fields read the draft; their changes are written into the draft's text (a
 * change the text edits can't write toasts `CANT_EDIT_ON_CANVAS_MESSAGE` and
 * is refused). Read-only while the canvas is locked, and when
 * `service.telemetry` is neither a mapping nor unset.
 *
 * Closed, the draft is kept, so the dialog's body shows it until Radix
 * unmounts it (no close animation today; a later one wouldn't blank it), but
 * it takes no write: a field flushing as it goes then writes nothing. Reads go
 * through the draft's ref, so a read after a write (a flush at Apply) sees it
 * before the next render.
 */
export function useTelemetryDraft(open: boolean): TelemetryDraft {
  const locked = useEditorStore(selectIsEditingLocked);
  const draftRef = useRef<DraftState | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [draft, setDraft] = useState<DraftState | null>(() => (open ? takeDraft() : null));
  const [wasOpen, setWasOpen] = useState(open);
  let current = draft;
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      current = takeDraft();
      setDraft(current);
    }
  }
  draftRef.current = current;

  return useMemo(() => {
    const read = (path: ValuePath): ValueView => {
      const state = draftRef.current;
      return state?.document ? readValue(state.document, TELEMETRY_BASE, path) : ABSENT;
    };
    const telemetry = current?.document ? readValue(current.document, TELEMETRY_BASE, []).kind : "absent";
    const disabled = locked || !current?.document || telemetry === "scalar" || telemetry === "list";
    const apply = (changes: readonly ValueChange[]): ValuesResult => {
      const state = draftRef.current;
      if (disabled || !openRef.current || state === null || state.document === null) return "refused";
      if (changes.length === 0) return "unchanged";
      let written: ReturnType<typeof writeValues>;
      try {
        written = writeValues(state.text, TELEMETRY_BASE, changes, state.document);
      } catch (error) {
        if (!(error instanceof TextEditError)) throw error;
        toast.error(CANT_EDIT_ON_CANVAS_MESSAGE);
        return "refused";
      }
      if (written.text === state.text) return "unchanged";
      const next = { ...state, text: written.text, document: written.document, changes: [...state.changes, ...changes] };
      draftRef.current = next;
      setDraft(next);
      return "written";
    };
    const retake = () => {
      const next = takeDraft();
      draftRef.current = next;
      setDraft(next);
    };
    const latest = () => {
      const state = draftRef.current;
      return { changes: state?.changes ?? [], changed: state !== null && state.text !== state.seed };
    };
    return {
      ...formSource(read, apply, disabled),
      changes: current?.changes ?? [],
      changed: current !== null && current.text !== current.seed,
      seed: current?.seed ?? "",
      retake,
      latest,
    };
  }, [current, locked]);
}

// ── Fields ──

/** What a one-line field shows: the text as written, or null when it can't show it. */
function scalarText(view: ValueView, multiline = false): string | null {
  if (view.kind === "absent") return "";
  if (view.kind !== "scalar") return null;
  const text = view.source ?? String(view.value);
  return !multiline && /[\r\n]/.test(text) ? null : text;
}

/** The hint under a field that can't show its value. */
function UnshowableHint() {
  return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
}

interface FieldProps {
  /** The key path under the form's source. */
  path: ValuePath;
  /** Fixed per field, never built from a value. */
  id: string;
  label: string;
  description?: string;
  /** The collector's default: the hint's "Default <value>", and the placeholder unless one is given. */
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
  /** Clearing writes `""` rather than removing the key (a list item's keys stay). */
  keepEmpty?: boolean;
}

/** The ConfigField a text-like field sits in, with the unshowable hint. */
function FieldFrame({
  field,
  unshowable,
  children,
}: {
  field: FieldProps;
  unshowable: boolean;
  children: ReactNode;
}) {
  return (
    <ConfigField
      label={field.label}
      htmlFor={field.id}
      {...(field.description !== undefined ? { description: field.description } : {})}
      {...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {})}
      {...(field.required !== undefined ? { required: field.required } : {})}
    >
      {children}
      {unshowable && <UnshowableHint />}
    </ConfigField>
  );
}

/** A one-line field's shown text and its held typing: cleared removes the key (or writes `""`), else `write`. */
function useTextField(
  path: ValuePath,
  multiline: boolean,
  write: (form: FormSource, typed: string) => void,
  keepEmpty = false,
  writeSame = false,
) {
  const form = useForm();
  const shown = scalarText(form.read(path), multiline);
  const formRef = useRef(form);
  formRef.current = form;
  const text = useHeldText(
    shown ?? "",
    (typed) => {
      const current = formRef.current;
      if (typed === "" && !keepEmpty) current.remove(path);
      else write(current, typed);
    },
    { writeSame },
  );
  return { form, text, unshowable: shown === null, readOnly: form.disabled || shown === null };
}

/**
 * A string, with the `$` picker (VaultAwareInput). A `datalist` offers fixed
 * suggestions (journald's priorities), under the fixed id
 * `<id>-options`; what is typed is written as typed.
 */
export function TextField({
  type = "text",
  datalist,
  excludes,
  disabled = false,
  ...field
}: FieldProps & {
  type?: "text" | "password" | "url";
  datalist?: readonly string[];
  /** A key the collector refuses beside this one: what is typed removes it in the same change. */
  excludes?: ValuePath;
  /** Disabled by the form (filelog's multiline pattern while the other is set). */
  disabled?: boolean;
}) {
  const { text, unshowable, readOnly } = useTextField(
    field.path,
    false,
    (form, typed) => {
      const changes: ValueChange[] = [{ path: field.path, value: typed }];
      if (excludes !== undefined && form.read(excludes).kind !== "absent") changes.push({ path: excludes, remove: true });
      form.apply(changes);
    },
    field.keepEmpty,
  );
  const listId = `${field.id}-options`;
  return (
    <FieldFrame field={field} unshowable={unshowable}>
      <VaultAwareInput
        id={field.id}
        type={type}
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder={field.placeholder ?? field.defaultValue}
        disabled={readOnly || disabled}
        className={field.className}
        {...(datalist ? { list: listId } : {})}
      />
      {datalist && (
        <datalist id={listId}>
          {datalist.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
    </FieldFrame>
  );
}

/**
 * A string shown with its escapes (recombine's Combine With): a newline shows
 * as `\n`, a carriage return as `\r`, a tab as `\t` and a backslash as `\\`.
 * What is typed is read back the same way (`\n`, `\r`, `\t`, `\\`; any other
 * backslash is itself), so typing `\n` writes a newline, which the text edits
 * write double-quoted (`"\n"`). A single-quoted `'\n'` (a backslash and an
 * `n`) shows `\\n`, and blurring it unchanged writes nothing. It reads the
 * scalar itself: a line break is what it shows, not a reason it can't; any
 * other control character has no escape here and makes the field read-only
 * with `UNSHOWABLE_VALUE_MESSAGE`.
 */
export function EscapedTextField(field: FieldProps) {
  const form = useForm();
  const view = form.read(field.path);
  const written = view.kind === "absent" ? "" : view.kind === "scalar" ? (view.source ?? String(view.value)) : null;
  // eslint-disable-next-line no-control-regex
  const shown = written === null || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(written) ? null : escapeText(written);
  const formRef = useRef(form);
  formRef.current = form;
  const text = useHeldText(shown ?? "", (typed) => {
    const current = formRef.current;
    if (typed === "" && !field.keepEmpty) current.remove(field.path);
    else current.set(field.path, unescapeText(typed));
  });
  return (
    <FieldFrame field={field} unshowable={shown === null}>
      <VaultAwareInput
        id={field.id}
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder={field.placeholder ?? field.defaultValue}
        disabled={form.disabled || shown === null}
        className={field.className}
      />
    </FieldFrame>
  );
}

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", "\\": "\\" };

/** A string as `EscapedTextField` shows it: a backslash, a newline, a carriage return and a tab escaped. */
export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

/** What `EscapedTextField` writes for typed text: `\n`, `\r`, `\t` and `\\` read back; any other backslash kept. */
export function unescapeText(typed: string): string {
  return typed.replace(/\\([nrt\\])/g, (_match, escaped: string) => ESCAPES[escaped]!);
}

/**
 * A number or a reference: what was typed, written plain when it reads as a number (0 included).
 *
 * With `writeSame`, what is typed is written even when it reads as what the
 * field shows: statsd's `socket_permissions` quoted (`"0622"`, which the
 * collector refuses) is retyped to write it plain, as docker_stats'
 * `api_version` is. The write is a text splice like any other.
 */
export function NumberField({ writeSame = false, ...field }: FieldProps & { writeSame?: boolean }) {
  const { text, unshowable, readOnly } = useTextField(
    field.path,
    false,
    (form, typed) => {
      if (plainNumber(typed) !== undefined) form.setPlain(field.path, typed);
      else form.set(field.path, typed);
    },
    false,
    writeSame,
  );
  return (
    <FieldFrame field={field} unshowable={unshowable}>
      <VaultAwareInput
        id={field.id}
        inputMode="decimal"
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder={field.placeholder ?? field.defaultValue}
        disabled={readOnly}
        className={field.className}
      />
    </FieldFrame>
  );
}

/**
 * A Go duration or a reference, written as a string; an error shows for what
 * the collector refuses.
 *
 * With `grammar: "prometheus"` (the prometheus receiver's scrape jobs), the
 * error shows for what Prometheus refuses, with its own copy
 * (`shared/prometheus-duration.ts`): `1d` and `1h30m` are taken, `1.5h` and
 * a bare number are not. Either way what was typed is written.
 */
export function DurationField({ grammar = "go", ...field }: FieldProps & { grammar?: "go" | "prometheus" }) {
  const { form, text, unshowable, readOnly } = useTextField(field.path, false, (current, typed) =>
    current.set(field.path, typed),
  );
  const prometheus = grammar === "prometheus";
  // A plain number in the text is nanoseconds to the collector, not an error (Prometheus reads its characters).
  const view = form.read(field.path);
  const numberInText = !prometheus && !text.held && view.kind === "scalar" && typeof view.value === "number";
  const invalid = prometheus ? !isPrometheusDuration(text.value) : numberInText ? false : undefined;
  return (
    <FieldFrame field={field} unshowable={unshowable}>
      <DurationInput
        id={field.id}
        value={text.value}
        onChange={(value) => text.change(value ?? "")}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder={field.placeholder ?? field.defaultValue}
        disabled={readOnly}
        className={field.className}
        invalid={invalid}
        {...(prometheus ? { message: PROMETHEUS_DURATION_MESSAGE } : {})}
      />
    </FieldFrame>
  );
}

/** Text over several lines; Enter is a new line, not a commit. */
export function TextareaField({ rows, ...field }: FieldProps & { rows?: number }) {
  const { text, unshowable, readOnly } = useTextField(field.path, true, (form, typed) => form.set(field.path, typed));
  return (
    <FieldFrame field={field} unshowable={unshowable}>
      <Textarea
        id={field.id}
        rows={rows}
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e, false)}
        placeholder={field.placeholder ?? field.defaultValue}
        disabled={readOnly}
        className={field.className}
      />
    </FieldFrame>
  );
}

/**
 * A value with no label of its own (a resource item's value, a filter
 * condition): its fixed `aria-label` names it. Clearing writes `""`: a
 * list item stays, and so does an item's value key. A
 * `multiline` field is a Textarea (Enter is a new line).
 */
export function BareTextField({
  path,
  id,
  ariaLabel,
  placeholder,
  multiline = false,
  rows,
  className,
  emptyRemoves = false,
}: {
  path: ValuePath;
  /** Fixed per field, never built from a value. */
  id?: string;
  /** Fixed, never a value. */
  ariaLabel?: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  className?: string;
  /** Clearing removes the key, as a labeled field's does, rather than writing `""` (time_parser's custom layout). */
  emptyRemoves?: boolean;
}) {
  const { text, unshowable, readOnly } = useTextField(path, multiline, (form, typed) => form.set(path, typed), !emptyRemoves);
  const shared = {
    id,
    value: text.value,
    onBlur: text.flush,
    placeholder,
    disabled: readOnly,
    className,
    ...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {}),
  };
  return (
    <>
      {multiline ? (
        <Textarea
          {...shared}
          rows={rows}
          onChange={(e) => text.change(e.target.value)}
          onKeyDown={(e) => text.handleKeyDown(e, false)}
        />
      ) : (
        <VaultAwareInput
          {...shared}
          onChange={(e) => text.change(e.target.value)}
          onKeyDown={(e) => text.handleKeyDown(e)}
        />
      )}
      {unshowable && <UnshowableHint />}
    </>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  /** Listed but can't be chosen (redaction's HMAC hashes without an `hmac_key`). A text holding it still shows it. */
  disabled?: boolean;
}

/**
 * The unset option's value, a sentinel. It is never written; a text value
 * with these characters shows as an extra option whose value is
 * `WRITTEN_OPTION`.
 */
export const UNSET_OPTION = "__unset__";

/** The value of an option showing a value the options don't have, where the value itself can't be the option's. */
export const WRITTEN_OPTION = "written-value";

/**
 * One of `options`, written at once as a string. Unset shows the
 * placeholder (the default's label); a value outside the options is shown
 * as an extra option, as written.
 *
 * With `unsetOption`, an option with that label is listed first and shown
 * while the key is unset; choosing it removes the key (or calls
 * `onUnset`). Its value is `UNSET_OPTION`, never written.
 *
 * For redaction's Hash Function, an option may be `disabled` (listed, not
 * choosable); with `ignoreCase`, the text matches an option in any case, as
 * the collector reads it (`SHA1` shows as SHA-1, as `RadioField`'s
 * `ignoreCase`), and a choice writes the option's value.
 */
export function SelectField({
  options,
  onSelect,
  unsetOption,
  onUnset,
  ignoreCase = false,
  itemClassName,
  ...field
}: FieldProps & {
  options: readonly SelectOption[];
  /** What choosing another option writes, in place of setting `path` to it (a resource item's action). */
  onSelect?: (value: string) => void;
  /** An option for "unset", listed first: shown while the key is unset, and choosing it removes the key. */
  unsetOption?: { label: string };
  /** What choosing the unset option writes, in place of removing the key. */
  onUnset?: () => void;
  /** The text matches an option in any case, as the collector reads it; a choice writes the option's value. */
  ignoreCase?: boolean;
  /** The fixed options' classes (the S3 storage classes and ACLs are `font-mono text-xs`). */
  itemClassName?: string;
}) {
  const form = useForm();
  const view = form.read(field.path);
  const shown = scalarText(view);
  const matched =
    shown === null || shown === ""
      ? undefined
      : options.find((option) => (ignoreCase ? option.value.toLowerCase() === shown.toLowerCase() : option.value === shown));
  const extra = shown !== null && shown !== "" && matched === undefined;
  // A written value that is the unset token's characters can't be its own option's value.
  const extraValue = unsetOption && shown === UNSET_OPTION ? WRITTEN_OPTION : shown;
  const shownOptions: readonly SelectOption[] = [
    ...(unsetOption ? [{ value: UNSET_OPTION, label: unsetOption.label }] : []),
    ...options,
    ...(extra && extraValue !== null ? [{ value: extraValue, label: shown }] : []),
  ];
  const selected =
    shown === null ? "" : view.kind === "absent" && unsetOption ? UNSET_OPTION : extra ? (extraValue ?? "") : (matched?.value ?? shown);
  const defaultLabel = options.find((option) => option.value === field.defaultValue)?.label ?? field.defaultValue;
  return (
    <FieldFrame field={field} unshowable={shown === null}>
      <Select
        value={selected}
        onValueChange={(value) => {
          if (value === selected) return;
          if (unsetOption && value === UNSET_OPTION) {
            if (onUnset) onUnset();
            else form.remove(field.path);
          } else if (onSelect) onSelect(value);
          else form.set(field.path, value);
        }}
        disabled={form.disabled || shown === null}
      >
        <SelectTrigger id={field.id} className={field.className}>
          <SelectValue placeholder={field.placeholder ?? defaultLabel} />
        </SelectTrigger>
        <SelectContent>
          {shownOptions.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              {...(option.disabled ? { disabled: true } : {})}
              {...(itemClassName !== undefined && options.includes(option) ? { className: itemClassName } : {})}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldFrame>
  );
}

/**
 * A select with no label of its own (k8sattributes' rule sources and the
 * label cards' From), as `SelectField` writes and shows it: at
 * once, a value outside the options as an extra option, unset as the
 * placeholder (the collector's default's label, where it has one), a value
 * it can't show read-only with `UNSHOWABLE_VALUE_MESSAGE`.
 */
export function BareSelectField({
  path,
  id,
  options,
  placeholder,
  className,
  onSelect,
  ariaLabel,
}: {
  path: ValuePath;
  /** Fixed per field, never built from a value. */
  id?: string;
  options: readonly SelectOption[];
  placeholder?: string;
  className?: string;
  onSelect?: (value: string) => void;
  /** Fixed, never a value: the select's name where no label names it (metricstransform's "Operation action"). */
  ariaLabel?: string;
}) {
  const form = useForm();
  const shown = scalarText(form.read(path));
  const extra = shown !== null && shown !== "" && !options.some((option) => option.value === shown);
  const shownOptions = extra ? [...options, { value: shown, label: shown }] : options;
  return (
    <>
      <Select
        value={shown ?? ""}
        onValueChange={(value) => {
          if (value === shown) return;
          if (onSelect) onSelect(value);
          else form.set(path, value);
        }}
        disabled={form.disabled || shown === null}
      >
        <SelectTrigger {...(id !== undefined ? { id } : {})} {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})} className={className}>
          <SelectValue {...(placeholder !== undefined ? { placeholder } : {})} />
        </SelectTrigger>
        <SelectContent>
          {shownOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {shown === null && <UnshowableHint />}
    </>
  );
}

/**
 * A boolean, written at once, as a checkbox row; unset shows the collector's
 * default. With `uncheckedRemoves`, unticking removes the key rather than
 * writing `false` (journald's boxes, which write `true` or nothing). With
 * `describedClassName`, the label and its description sit beside the box in
 * that block, as described rows (hostmetrics' Include Virtual Filesystems).
 * The logs forms' rows: `className` and `hintClassName` give the row's block
 * and its hint their classes (journald's and syslog's `space-y-1.5` blocks
 * with an unindented hint), `disabled` is the form's (syslog's Allow Skip PRI
 * Header under octet counting), and `onToggle` overrides the write, as
 * `SelectField`'s `onSelect` (filelog's Delete file after reading, with its
 * adjustment message).
 */
export function CheckboxField({
  path,
  id,
  label,
  description,
  defaultChecked,
  labelClassName = "text-sm font-medium",
  rowClassName = "flex items-center gap-2",
  describedClassName,
  descriptionClassName = "text-xs text-muted-foreground",
  uncheckedRemoves = false,
  checkedRemoves = false,
  excludes,
  className = "space-y-1",
  hintClassName = "ml-6 text-[11px] leading-4 text-muted-foreground",
  disabled = false,
  onToggle,
}: {
  path: ValuePath;
  id: string;
  label: string;
  /** The hint under the row (the attributes cache writes its default in it). */
  description?: ReactNode;
  /** The collector's default, shown while the key is unset. */
  defaultChecked: boolean;
  /** The label's classes (the shared sections' secondary rows are `text-xs text-muted-foreground`). */
  labelClassName?: string;
  /** The box and label's row (kubeletstats' rows are `flex items-start space-x-3`). */
  rowClassName?: string;
  /** The label and description's block beside the box (hostmetrics': `grid gap-1 leading-none`); the description then sits in it. */
  describedClassName?: string;
  /** The description's classes inside `describedClassName`'s block. */
  descriptionClassName?: string;
  /** Unticking removes the key rather than writing `false`. */
  uncheckedRemoves?: boolean;
  /**
   * Ticking removes the key rather than writing `true`: the default is true
   * (the S3 receiver's "Expect Telemetry Type in File Prefix"). Unticking
   * writes `false`.
   */
  checkedRemoves?: boolean;
  /** A box the collector refuses ticked beside this one: ticking this one unticks it (writes `false`) in the same change. */
  excludes?: ValuePath;
  /** The block holding the row and its hint. */
  className?: string;
  /** The hint under the row (not beside it). */
  hintClassName?: string;
  /** Disabled by the form, whatever the value. */
  disabled?: boolean;
  /** What a toggle writes, in place of setting `path` (it is called only for a change). */
  onToggle?: (next: boolean) => void;
}) {
  const form = useForm();
  const view = form.read(path);
  const checked = view.kind === "absent" ? defaultChecked : view.value === true || view.value === false ? view.value : null;
  const labelled = (
    <Label htmlFor={id} className={labelClassName}>
      {label}
    </Label>
  );
  const beside = describedClassName !== undefined;
  return (
    <div className={className}>
      <div className={rowClassName}>
        <Checkbox
          id={id}
          {...(beside ? { className: DESCRIBED_BOX } : {})}
          checked={checked ?? false}
          onCheckedChange={(next) => {
            if ((next === true) === checked) return;
            if (onToggle) {
              onToggle(next === true);
              return;
            }
            if ((next !== true && uncheckedRemoves) || (next === true && checkedRemoves)) {
              form.remove(path);
              return;
            }
            const changes: ValueChange[] = [{ path, value: next === true }];
            if (next === true && excludes !== undefined && form.read(excludes).value === true) changes.push({ path: excludes, value: false });
            form.apply(changes);
          }}
          disabled={form.disabled || checked === null || disabled}
        />
        {beside ? (
          <div className={describedClassName}>
            {labelled}
            {description && <p className={descriptionClassName}>{description}</p>}
          </div>
        ) : (
          labelled
        )}
      </div>
      {description && !beside && <p className={hintClassName}>{description}</p>}
      {checked === null && <p className={hintClassName}>{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </div>
  );
}

/** One of a `CheckboxSetField`'s fixed items. */
export interface CheckboxSetItem {
  /** What the list holds when it is ticked (a collector name, fixed by the form). */
  value: string;
  label: string;
  description?: string;
}

/**
 * A list of fixed items as checkboxes (node conditions, metric groups,
 * detectors): ticked while the list holds the item. Ticking appends it (an
 * empty `[]` takes it in block style); unticking removes its lines (each
 * of them, if it is there twice), and unticking the last leaves `[]` or
 * removes the key with `emptyRemovesKey`.
 *
 * An unset list shows `unsetShows` ticked (none by default: the form shows its
 * boxes, not the collector's default, which `defaultHint` names as "Default
 * <hint>"); its first toggle writes `unsetShows` with the change, which for
 * none is the item alone. Items the list holds that aren't fixed ones show
 * after them, ticked, labeled with the item as text, so they can be unticked
 * and are never lost. A list holding anything but plain scalars, or a value
 * that isn't a list, is read-only with `UNSHOWABLE_VALUE_MESSAGE`. Ids are
 * `<id>-<index>`, never an item.
 */
export function CheckboxSetField({
  path,
  id,
  label,
  description,
  items,
  defaultHint,
  unsetShows = [],
  emptyIsUnset = false,
  emptyRemovesKey = false,
  className = "grid grid-cols-2 gap-2",
  labelClassName = "text-sm font-normal cursor-pointer",
  rowClassName,
  describedClassName = "flex-1",
  descriptionClassName = "text-[11px] leading-4 text-muted-foreground",
}: {
  path: ValuePath;
  /** Fixed per field: each box is `<id>-<index>`. */
  id: string;
  label: string;
  description?: string;
  items: readonly CheckboxSetItem[];
  /** The collector's default, shown as "Default <hint>". */
  defaultHint?: string;
  /** What an unset list shows ticked (resourcedetection's hostname sources: dns, os). */
  unsetShows?: readonly string[];
  /**
   * An empty list shows as unset (`unsetShows` ticked, the hint), as the
   * collector reads it (resourcedetection's hostname sources: `[]` is dns, os).
   */
  emptyIsUnset?: boolean;
  /** Unticking the last item removes the key rather than leaving `[]`. */
  emptyRemovesKey?: boolean;
  /** The boxes' grid (two columns). */
  className?: string;
  /** A description-less item's label classes (k8sattributes' metadata is `text-xs font-mono`). */
  labelClassName?: string;
  /** Every row's classes, in place of the default (kubeletstats' rows are `flex items-start space-x-3`). */
  rowClassName?: string;
  /** A described item's label-and-description block (kubeletstats': `grid gap-1.5 leading-none`). */
  describedClassName?: string;
  /** A described item's description (kubeletstats': `text-xs text-muted-foreground`). */
  descriptionClassName?: string;
}) {
  const set = useCheckboxSet({ path, items: items.map((item) => item.value), unsetShows, emptyIsUnset, emptyRemovesKey });
  const shown: readonly CheckboxSetItem[] = [...items, ...set.extras.map((value) => ({ value, label: value }))];

  return (
    <ConfigField
      label={label}
      {...(description !== undefined ? { description } : {})}
      {...(defaultHint !== undefined ? { defaultValue: defaultHint } : {})}
    >
      <div className={className}>
        {shown.map((item, index) => {
          const boxId = `${id}-${index}`;
          const checked = set.isTicked(item.value);
          return (
            <div key={index} className={rowClassName ?? (item.description ? "flex items-start gap-2" : "flex items-center gap-2")}>
              <Checkbox
                id={boxId}
                {...(item.description ? { className: DESCRIBED_BOX } : {})}
                checked={checked}
                onCheckedChange={(next) => {
                  if ((next === true) !== checked) set.toggle(item.value, next === true);
                }}
                disabled={set.disabled}
              />
              {item.description ? (
                <div className={describedClassName}>
                  <Label htmlFor={boxId} className="cursor-pointer text-sm font-medium">
                    {item.label}
                  </Label>
                  <p className={descriptionClassName}>{item.description}</p>
                </div>
              ) : (
                <Label htmlFor={boxId} className={labelClassName}>
                  {item.label}
                </Label>
              )}
            </div>
          );
        })}
      </div>
      {set.unshowable && <UnshowableHint />}
    </ConfigField>
  );
}

/** What a set of checkboxes over a list shows and does: `CheckboxSetField`'s, for a form that lays its boxes out itself. */
export interface CheckboxSet {
  /** The list's items that aren't fixed ones, once each, in order: shown after the fixed ones, ticked. */
  extras: readonly string[];
  /** Whether the box for `value` is ticked (an unset list: `unsetShows`). */
  isTicked: (value: string) => boolean;
  /** Ticks or unticks `value`, as `CheckboxSetField` writes it. */
  toggle: (value: string, on: boolean) => void;
  /** The list holds something the boxes can't show, or isn't a list: read-only, with `UNSHOWABLE_VALUE_MESSAGE`. */
  unshowable: boolean;
  /** The boxes can't be changed (the form can't write, or the list can't be shown). */
  disabled: boolean;
  /** The list's items as written (none while unset), or null when it can't be shown. */
  values: readonly string[] | null;
}

/**
 * `CheckboxSetField`'s reading and writing, apart from its layout
 * (resourcedetection's detectors, in collapsible groups). `items` are the
 * fixed values.
 */
export function useCheckboxSet({
  path,
  items,
  unsetShows = [],
  emptyIsUnset = false,
  emptyRemovesKey = false,
}: {
  path: ValuePath;
  items: readonly string[];
  unsetShows?: readonly string[];
  emptyIsUnset?: boolean;
  emptyRemovesKey?: boolean;
}): CheckboxSet {
  const form = useForm();
  const view = form.read(path);
  // An item that is null (it reads as unset) can't be shown; `""` only when a fixed item is `""`.
  const held =
    view.kind === "list"
      ? view.value.map((_item, index) => {
          const item = form.read([...path, index]);
          return item.kind === "absent" ? null : scalarText(item);
        })
      : view.kind === "absent"
        ? []
        : null;
  const values = held?.every((value): value is string => value !== null && (value !== "" || items.includes(""))) ? held : null;
  // An empty list the collector reads as its default shows as unset; its first toggle replaces it, as unset's writes.
  const unset = view.kind === "absent" || (emptyIsUnset && view.kind === "list" && view.value.length === 0);
  const ticked = unset ? unsetShows : (values ?? []);
  const extras = (values ?? []).filter((value, index, all) => all.indexOf(value) === index && !items.includes(value));

  const toggle = (value: string, on: boolean) => {
    if (values === null) return;
    if (unset) {
      const next = on ? [...unsetShows.filter((item) => item !== value), value] : unsetShows.filter((item) => item !== value);
      if (next.length === 0 && emptyRemovesKey) return;
      form.set(path, next);
      return;
    }
    if (on) {
      form.set([...path, values.length], value);
      return;
    }
    const indices = values.flatMap((item, index) => (item === value ? [index] : []));
    if (indices.length === values.length && emptyRemovesKey) {
      form.remove(path);
      return;
    }
    // From the last, so each index still names its item.
    form.apply(indices.reverse().map((index) => ({ path: [...path, index], remove: true as const })));
  };

  return {
    extras,
    isTicked: (value) => ticked.includes(value),
    toggle,
    unshowable: values === null,
    disabled: form.disabled || values === null,
    values,
  };
}

export interface RadioOption {
  /** Fixed by the form: the only thing a radio's `value` attribute ever holds. */
  value: string;
  label: string;
}

/**
 * One of `options` as native radios (journald's Start At, syslog's transport
 * and protocol, netflow's scheme), written at once. Unset shows `defaultValue`
 * checked (the collector's default), or none where the collector has none. A
 * value outside the options checks none and makes the field read-only with
 * `UNSHOWABLE_VALUE_MESSAGE`: no radio is added for it, so a `value` attribute
 * only ever holds a fixed option. `onSelect` overrides the write, as
 * `SelectField`'s. The group's `name` and each radio's id (`<id>-<index>`) are
 * fixed.
 */
export function RadioField({
  options,
  onSelect,
  optionClassName,
  ignoreCase = false,
  ...field
}: Omit<FieldProps, "keepEmpty" | "placeholder"> & {
  options: readonly RadioOption[];
  /** What choosing another option writes, in place of setting `path` to it (syslog's transport). */
  onSelect?: (value: string) => void;
  /** Each option's label classes (netflow's: `text-[13px]`). */
  optionClassName?: string;
  /** The text matches an option in any case, as the collector reads it (syslog's protocol); a choice writes the option's value. */
  ignoreCase?: boolean;
}) {
  const form = useForm();
  const view = form.read(field.path);
  const text = view.kind === "absent" ? undefined : scalarText(view);
  const matches = (value: string, other: string | null | undefined) =>
    other !== null && other !== undefined && (ignoreCase ? value.toLowerCase() === other.toLowerCase() : value === other);
  const unshowable = text === null || (text !== undefined && !options.some((option) => matches(option.value, text)));
  const current = text ?? field.defaultValue;
  return (
    <ConfigField
      label={field.label}
      {...(field.description !== undefined ? { description: field.description } : {})}
      {...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {})}
      {...(field.required !== undefined ? { required: field.required } : {})}
    >
      <div className={field.className ?? "flex gap-4"}>
        {options.map((option, index) => (
          <label key={option.value} className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              id={`${field.id}-${index}`}
              name={field.id}
              value={option.value}
              checked={!unshowable && matches(option.value, current)}
              onChange={() => {
                if (matches(option.value, text)) return;
                if (onSelect) onSelect(option.value);
                else form.set(field.path, option.value);
              }}
              disabled={form.disabled || unshowable}
              className="h-4 w-4"
            />
            <span className={optionClassName}>{option.label}</span>
          </label>
        ))}
      </div>
      {unshowable && <UnshowableHint />}
    </ConfigField>
  );
}

/**
 * A list of strings, written by item: a row's typing sets its item, Add
 * appends `""` (or `addValue`, a seeded row such as `/var/log/*.log`), Remove
 * removes the item's lines. Unset shows no rows; a list holding anything but
 * plain scalars, or a value that isn't a list, can't be shown.
 *
 * With `holdEmpty`, Add shows a held row that isn't in the text: its first
 * typing is appended as the list's last item (after the pause, on blur or
 * Enter, on a save, or when the form goes), and the row becomes that item's
 * in place (the same key, so the input, its focus and its caret stay; rows
 * are keyed by their items). Left empty, the held row goes, as it does when
 * the list's length changes; a row emptied and left removes its item, never
 * writing `""`.
 *
 * The Kubernetes forms' own rows: `removeLabel` names the remove buttons
 * (a fixed label), `vaultAware` gives the rows the `$` picker, and
 * `sortable` (a fixed list name and context id) reorders the items by
 * drag, moving each item's own lines (`form.move`); the held row isn't
 * one of them.
 *
 * The logs forms' lists: with `emptyRemovesKey`, removing the
 * last item removes the key (filelog's and journald's lists), and the rows
 * take the form's classes (`inputClassName`, `addButtonClassName`,
 * `addIconClassName`).
 *
 * Numeric rows (load balancing's Kubernetes ports): with `numeric`, a row's
 * typing is written as a `NumberField`'s is, plain as typed when it reads
 * as a number (`4317`, `0x10E1`), a string otherwise (`${env:PORT}`); the
 * rows take `inputMode="decimal"`.
 *
 * Load balancing's lists: `keepLast` keeps the list's last item (its
 * Remove disabled, and emptying its row and leaving writes nothing), with
 * `keepLastHint` under the rows while it does; `alsoOnAppend` gives
 * changes written with an appended item, in the same write (the held
 * Custom Attributes routing key with its first attribute); `startHeld`
 * shows a held row from the start (Custom Attributes chosen: the
 * attributes' held row).
 *
 * cumulativetodelta's metric lists: `onEmptied` gives the changes removing
 * the last item writes in place of removing it (or the key): the list and
 * its side's `match_type` together, which the collector refuses apart
 * (`processor/cumulativetodeltaprocessor/config.go:64-67`).
 *
 * Transform's and logdedup's: `multiline` rows (a Textarea of that many rows,
 * Enter a new line; an item over several lines is shown, not unshowable:
 * transform's group statements), `emptyText` under no rows (transform's
 * conditions), and `locked` (typing and Add disabled, Remove still enabled:
 * logdedup's Include Fields while Exclude Fields has items, and the mirror).
 */
export function MultiValueField({
  path,
  id,
  label,
  placeholder,
  helpText,
  addButtonText,
  addValue,
  holdEmpty = false,
  removeLabel,
  vaultAware = false,
  sortable,
  emptyRemovesKey = false,
  inputClassName,
  addButtonClassName,
  addIconClassName,
  numeric = false,
  keepLast = false,
  keepLastHint,
  alsoOnAppend,
  startHeld = false,
  onEmptied,
  multiline,
  emptyText,
  locked = false,
}: {
  path: ValuePath;
  id?: string;
  label?: string;
  placeholder?: string;
  helpText?: string;
  addButtonText?: string;
  /** What Add appends (the seed), when the list doesn't hold empty rows. */
  addValue?: string;
  /** Add holds an empty row until something is typed in it; an emptied row is removed. */
  holdEmpty?: boolean;
  /** The remove buttons' fixed label ("Remove" by default). */
  removeLabel?: string;
  /** The rows have the `$` picker (VaultAwareInput). */
  vaultAware?: boolean;
  /** The items reorder by drag: the list's fixed name and its dnd context's fixed id. */
  sortable?: { list: string; contextId: string };
  /** Removing the last item removes the key rather than leaving `[]`. */
  emptyRemovesKey?: boolean;
  /** The rows' input classes, the Add button's and its icon's (MultiValueInput's). */
  inputClassName?: string;
  addButtonClassName?: string;
  addIconClassName?: string;
  /** Each row is a number or a reference, written plain as typed when it reads as a number. */
  numeric?: boolean;
  /** The last item stays: its Remove is disabled, and its row emptied writes nothing. */
  keepLast?: boolean;
  /** Under the rows while `keepLast` keeps the last item. */
  keepLastHint?: string;
  /** More changes for an append's write (after the item's). */
  alsoOnAppend?: () => ValueChange[];
  /** A held row shows from the start, as if Add had been clicked. */
  startHeld?: boolean;
  /** What removing the last item writes, in place of removing it (or the key). */
  onEmptied?: () => ValueChange[];
  /** Each row is a Textarea of this many rows: Enter is a new line, and an item over several lines is shown. */
  multiline?: number;
  /** Shown while there are no rows. */
  emptyText?: string;
  /** Typing and Add are disabled (another setting excludes the list); Remove isn't. */
  locked?: boolean;
}) {
  const form = useForm();
  const view = form.read(path);
  const items = view.kind === "absent" ? [] : view.kind === "list" ? view.value.map((_item, index) => form.read([...path, index])) : null;
  const values = items?.every((item) => item.kind === "scalar" || item.kind === "absent")
    ? items.map((item) => scalarText(item, multiline !== undefined))
    : null;
  const shown = values?.every((value): value is string => value !== null) ? values : null;
  /** The list's length when Add made the held row: it shows while the list still has that length. */
  const [heldAt, setHeldAt] = useState<number | null>(() => (startHeld && shown !== null ? shown.length : null));
  /** Sets item `index` to what was typed: plain when a numeric row reads as a number; an append with `alsoOnAppend`'s changes. */
  const setItem = (index: number, value: string) => {
    const change: ValueChange =
      numeric && plainNumber(value) !== undefined ? { path: [...path, index], plain: value } : { path: [...path, index], value };
    const appended = index === (shown?.length ?? -1) ? (alsoOnAppend?.() ?? []) : [];
    return form.apply([change, ...appended]);
  };
  // Rows keyed by their items: a Remove click can't land on the next item's row.
  const cards = useCardKeys(shown ?? []);
  // The held row belongs to the list as it was when Add made it: a change of
  // length (its own item written, or the list edited elsewhere) drops it, so
  // it never comes back.
  const length = shown?.length ?? -1;
  const [seenLength, setSeenLength] = useState(length);
  if (seenLength !== length) {
    setSeenLength(length);
    setHeldAt(null);
  }
  if (shown === null) {
    return (
      <div className="space-y-2">
        {label && <Label className="text-[13px] font-medium text-foreground">{label}</Label>}
        <UnshowableHint />
      </div>
    );
  }
  const holding = holdEmpty && heldAt === shown.length;
  const keepingLast = keepLast && shown.length === 1;
  /** Removes item `index` by its lines (the last one takes the key with it under `emptyRemovesKey`), and its row's key. */
  const removeItem = (index: number) => {
    if (keepingLast) return;
    if (onEmptied && shown.length === 1 && index === 0) {
      if (form.apply(onEmptied()) === "written") cards.remove(index);
      return;
    }
    if (form.remove(emptyRemovesKey && shown.length === 1 && index === 0 ? path : [...path, index]) === "written") cards.remove(index);
  };
  const input = (
    <MultiValueInput
      {...(label !== undefined ? { label } : {})}
      {...(id !== undefined ? { id } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(helpText !== undefined ? { helpText } : {})}
      {...(addButtonText !== undefined ? { addButtonText } : {})}
      values={holding ? [...shown, ""] : shown}
      // The held row takes the key its item will get: written, it is the same row.
      rowKeys={holding ? [...cards.keys, cards.next] : cards.keys}
      onValueChange={(index, value) => {
        if (index === shown.length) {
          // The held row: its first typing is the list's new last item.
          if (value === "") return;
          if (setItem(index, value) !== "refused") setHeldAt(null);
        } else if (holdEmpty && value === "") {
          removeItem(index);
        } else {
          setItem(index, value);
        }
      }}
      onAdd={() => {
        if (holdEmpty) setHeldAt(shown.length);
        else if (numeric && addValue !== undefined) setItem(shown.length, addValue);
        else form.set([...path, shown.length], addValue ?? "");
      }}
      onRemove={(index) => {
        // The held row goes, unwritten; any other row's item is removed.
        if (index === shown.length) setHeldAt(null);
        else removeItem(index);
      }}
      holdEmpty={holdEmpty}
      numeric={numeric}
      {...(removeLabel !== undefined ? { removeLabel } : {})}
      vaultAware={vaultAware}
      {...(inputClassName !== undefined ? { inputClassName } : {})}
      {...(addButtonClassName !== undefined ? { addButtonClassName } : {})}
      {...(addIconClassName !== undefined ? { addIconClassName } : {})}
      {...(sortable
        ? {
            sortable: {
              ...sortable,
              count: shown.length,
              onMove: (from: number, to: number) => {
                if (form.move(path, from, to) === "written") cards.move(from, to);
              },
            },
          }
        : {})}
      onRowBlur={(index) => {
        // Left empty, the held row goes (what it held was written just before, making it an item's row).
        if (index === shown.length) setHeldAt(null);
      }}
      disabled={form.disabled}
      {...(keepLast ? { canRemove: (index: number) => !(keepingLast && index < shown.length) } : {})}
      {...(multiline !== undefined ? { multiline } : {})}
      {...(emptyText !== undefined ? { emptyText } : {})}
      locked={locked}
    />
  );
  if (!(keepingLast && keepLastHint)) return input;
  return (
    <div className="space-y-2">
      {input}
      <p className="text-[11px] leading-4 text-muted-foreground">{keepLastHint}</p>
    </div>
  );
}
