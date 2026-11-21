import { Plus, Trash2 } from "lucide-react";

import { ConfigField } from "../ConfigField.js";
import { FormScope, NumberField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "../form-context.js";
import { useCardKeys } from "./card-keys.js";
import { presenceOf, SectionHint, SectionToggle, UnshowableSectionHint } from "./section-toggle.js";
import { Button } from "~/components/ui/button.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The CORS section, over the form's fields. Bound to the `cors` block's path
 * under the form.
 *
 * Ticking the box writes `allowed_origins: []`, `allowed_headers: []` and
 * `max_age: 7200` as the block, unticking removes it, each one change.
 * The lists are written by item: Add appends an empty item, a row's
 * typing sets its item, Remove removes the item's lines.
 *
 * 0 can be entered as Max Age (it never removes the key), and unset shows
 * as unset. Unset, Max Age shows the collector's default, 0
 * (`confighttp.CORSConfig` at v0.162.0: no `Access-Control-Max-Age` header
 * is sent), not 7200. Ticking the box still writes 7200.
 */

export function CORSConfigSection({ path }: { path: ValuePath }) {
  const form = useForm();
  const state = presenceOf(form.read(path));

  const toggle = (
    <SectionToggle
      id="cors-enable"
      label="Enable CORS (HTTP only)"
      state={state}
      disabled={form.disabled}
      onToggle={(on) => {
        if (on) form.set(path, { allowed_origins: [], allowed_headers: [], max_age: 7200 });
        else form.remove(path);
      }}
    />
  );

  if (state !== "on") {
    return (
      <div className="space-y-1.5">
        {toggle}
        <SectionHint>Allow browser-based clients to send telemetry cross-origin.</SectionHint>
        {state === "unshowable" && <UnshowableSectionHint />}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/50 p-3">
      {toggle}

      <FormScope path={path}>
        {/* Allowed Origins */}
        <ConfigField label="Allowed Origins">
          <ItemList
            path={["allowed_origins"]}
            placeholder="e.g. https://*.example.com"
            removeLabel="Remove origin"
            emptyText="No origins configured"
            addText="Add Origin"
          />
        </ConfigField>

        {/* Allowed Headers */}
        <ConfigField label="Allowed Headers" description="Use * to allow any header.">
          <ItemList
            path={["allowed_headers"]}
            placeholder="e.g. X-Custom-Header"
            removeLabel="Remove header"
            emptyText="No headers configured"
            addText="Add Header"
          />
        </ConfigField>

        {/* Max Age */}
        <NumberField
          path={["max_age"]}
          id="cors-max-age"
          label="Max Age"
          defaultValue="0 (not sent)"
          description="How long browsers cache the preflight response, in seconds."
          placeholder="0"
        />
      </FormScope>
    </div>
  );
}

/** What a row shows of an item: its text as written, or null when it can't show it. */
function itemText(view: ValueView): string | null {
  if (view.kind === "absent") return "";
  if (view.kind !== "scalar") return null;
  const text = view.source ?? String(view.value);
  return /[\r\n]/.test(text) ? null : text;
}

/** One of the section's lists: a row per item, "No … configured" while empty, and the add button. */
function ItemList({
  path,
  placeholder,
  removeLabel,
  emptyText,
  addText,
}: {
  path: ValuePath;
  placeholder: string;
  /** A fixed label, never the value. */
  removeLabel: string;
  emptyText: string;
  addText: string;
}) {
  const form = useForm();
  const view = form.read(path);
  // Rows keyed by their items, so a Remove click can't land on the next item's row.
  const cards = useCardKeys(view.kind === "list" ? view.value : []);
  if (view.kind !== "absent" && view.kind !== "list") {
    return <SectionHint>{UNSHOWABLE_VALUE_MESSAGE}</SectionHint>;
  }
  const count = view.kind === "list" ? view.value.length : 0;

  return (
    <div className="space-y-2">
      {count > 0 ? (
        Array.from({ length: count }, (_item, index) => (
          <ItemRow
            key={cards.keys[index]}
            path={[...path, index]}
            placeholder={placeholder}
            removeLabel={removeLabel}
            onRemoved={() => cards.remove(index)}
          />
        ))
      ) : (
        <p className="text-[11px] leading-4 text-muted-foreground">{emptyText}</p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => form.set([...path, count], "")}
        className="w-full"
        disabled={form.disabled}
      >
        <Plus className="h-4 w-4 mr-2" />
        {addText}
      </Button>
    </div>
  );
}

/** A list item's row: its typing held and written to its item; Remove removes the item. */
function ItemRow({
  path,
  placeholder,
  removeLabel,
  onRemoved,
}: {
  path: ValuePath;
  placeholder: string;
  removeLabel: string;
  /** The item was removed: its row's key goes with it. */
  onRemoved: () => void;
}) {
  const form = useForm();
  const shown = itemText(form.read(path));
  const text = useHeldText(shown ?? "", (typed) => form.set(path, typed));
  return (
    <>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <VaultAwareInput
          value={text.value}
          onChange={(e) => text.change(e.target.value)}
          onBlur={text.flush}
          onKeyDown={(e) => text.handleKeyDown(e)}
          placeholder={placeholder}
          disabled={form.disabled || shown === null}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={removeLabel}
          onClick={() => {
            if (form.remove(path) === "written") onRemoved();
          }}
          disabled={form.disabled}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {shown === null && <SectionHint>{UNSHOWABLE_VALUE_MESSAGE}</SectionHint>}
    </>
  );
}
