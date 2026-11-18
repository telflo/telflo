import { useRef, type ReactNode } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  CheckboxSetField,
  DurationField,
  emptiesBlock,
  FormProvider,
  formSource,
  NumberField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { CORSConfigSection } from "./shared/CORSConfigSection.js";
import { HeadersConfigSection } from "./shared/HeadersConfigSection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";

/*
 * The Datadog receiver's form (ADR 0018), over the form's fields
 * (D9d decision 2, D9b's contract): each field writes its own key. Collector
 * claims are contrib v0.162.0's `receiver/datadogreceiver` and core
 * v0.162.0's `config/confighttp` (`ServerConfig`, squashed, `config.go:25`).
 *
 * - Changed (decision 4): Read Timeout unset is "Default 0 (none)": the
 *   receiver's own `read_timeout` field (60s, `factory.go:42`) is never
 *   read; the server is built from `ServerConfig` (`receiver.go:244`), whose
 *   `ReadTimeout` (`server.go:525-527`) has no default
 *   (`server.go:143-167`). A typed value sets both fields (the same key).
 * - Changed: Endpoint isn't marked required: unset is `localhost:8126`
 *   (`factory.go:35`).
 * - Fixed (decision 4): Enable HTTP Keep-Alives wrote `keep_alives_enabled:
 *   false`, which v0.162.0 ignores (the `PrioritizeNewKeepalive` gate is
 *   beta, `server.go:197-241`): keep-alives stay on. Unticking writes
 *   `keepalive.enabled: false` (configoptional's `enabled: false` turns the
 *   section off); ticking removes it. Idle Timeout edits the flat
 *   `idle_timeout` while the text uses it and has no `keepalive` section,
 *   else `keepalive.idle_timeout`; it shows a flat `idle_timeout` whenever
 *   the text has one, which overrides `keepalive.idle_timeout` (even a zero
 *   one; the beta gate's `server.go:235-239`; final ruling F5). The box
 *   shows what the collector does: a flat `keep_alives_enabled: false`
 *   alone shows ticked, with `IGNORED_FLAT_HINT` (Ruling 47).
 * - Changed (decision 7): a write to either while a flat deprecated key
 *   (`keep_alives_enabled`, `idle_timeout`) is in the text moves it into
 *   `keepalive` in the same change (the collector refuses the old key
 *   beside a `keepalive` section, `server.go:225-227`), with `movedToast`;
 *   a flat `false` moved by another control's write ends with
 *   `NOW_OFF_TOAST` (Ruling 47). The control's own key is removed rather
 *   than moved (its change wins), with `removedToast` (final ruling F5).
 *   The last key removed from `keepalive` takes the block, also when the
 *   flat keys go with it (its default is the same, `server.go:148-154`;
 *   never `keepalive: {}`, final ruling F5).
 * - Changed (decisions 5, 6): Compression Algorithms offers the collector's
 *   set (`compression.go:28-29`): "none (uncompressed)" (`""`) and
 *   `x-snappy-framed` beside the other six; unset shows none ticked, with
 *   `COMPRESSION_HINT`; the first tick writes that item alone (ticking any
 *   accepts only those ticked).
 * - Kept: clearing the Authenticator Extension removes the whole `auth`
 *   block ("blank disables auth"); what is typed is trimmed.
 * - Security and the response headers: D9b's server TLS (HTTP), CORS and
 *   headers sections.
 *
 * Ids are fixed; no value reaches an attribute (decision 13).
 */

/** Compression Algorithms' hint (decision 5). */
export const COMPRESSION_HINT = "Default: all, uncompressed included. Ticking any accepts only those ticked.";

/** The move's toast (Preflight ruling 16). */
export const movedToast = (key: string) => `Moved ${key} into keepalive: the collector refuses the old key beside a keepalive block.`;

/**
 * The move's toast for a flat key the collector doesn't refuse beside
 * `keepalive` (`keep_alives_enabled: true`, a zero `idle_timeout`;
 * `server.go:217-227`; D9d Ruling 48c). Not a no-op for `idle_timeout`: a
 * zero flat one overrides `keepalive.idle_timeout` (`server.go:235-239`).
 */
export const movedNoOpToast = (key: string) => `Moved ${key} into keepalive.`;

/** A flat key the control's own change replaces, removed rather than moved (final ruling F5). */
export const removedToast = (key: string) => `Removed ${key}: the collector refuses it beside a keepalive block.`;

/** `removedToast` for a flat key the collector doesn't refuse beside `keepalive` (as `movedNoOpToast`). */
export const removedNoOpToast = (key: string) => `Removed ${key}.`;

/**
 * Under Keep-Alives while a flat `keep_alives_enabled: false` is the only
 * keep-alive setting (D9d Ruling 47): the collector ignores it at v0.162.0
 * (the beta gate `pkg.confighttp.PrioritizeNewKeepalive`,
 * `server.go:197-244`), so the box shows ticked.
 */
export const IGNORED_FLAT_HINT = "keep_alives_enabled: false is ignored by the collector; untick to turn keep-alives off.";

/** Appended to `movedToast("keep_alives_enabled")` when another control's write moves a flat `false` into `keepalive` (Ruling 47). */
export const NOW_OFF_TOAST = " Keep-alives are now off, as keep_alives_enabled said.";

/** The collector's set (`compression.go:28-29`), `""` first as an uncompressed body. */
export const COMPRESSION_ITEMS = [
  { value: "", label: "none (uncompressed)" },
  ...["gzip", "zstd", "zlib", "snappy", "deflate", "lz4", "x-snappy-framed"].map((value) => ({ value, label: value })),
];

const KEEPALIVE: ValuePath = ["keepalive"];

/** The server's flat deprecated keys (`server.go:108-111`), and their keys in `keepalive`. */
const FLAT_KEYS = [
  ["idle_timeout", "idle_timeout"],
  ["keep_alives_enabled", "enabled"],
] as const;

/** Go's `time.ParseDuration` grammar (`duration-input.tsx`'s): `0`, or signed number-and-unit runs. */
const GO_DURATION = /^[-+]?(?:0|(?:(?:\d+\.?\d*|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+)$/;

/**
 * Whether the collector accepts the flat key's value beside `keepalive`: it
 * refuses only a non-zero `idle_timeout` or `keep_alives_enabled: false`
 * (`server.go:217-227`), so `true`, or a zero duration (`0`, `0s`, `0m0s`).
 * A zero flat `idle_timeout` isn't a no-op, though: under the beta gate it
 * overrides `keepalive.idle_timeout` (`server.go:235-239`).
 */
function isAcceptedBeside(key: (typeof FLAT_KEYS)[number][0], value: unknown): boolean {
  if (key === "keep_alives_enabled") return value === true;
  if (typeof value === "number") return value === 0;
  if (typeof value !== "string" || !GO_DURATION.test(value)) return false;
  return (value.match(/\d+\.?\d*|\.\d+/g) ?? []).every((number) => Number(number) === 0);
}

/** A scalar's change as written: a number plain as typed, anything else as its value. */
function setAs(form: FormSource, from: ValuePath, to: ValuePath): ValueChange {
  const view = form.read(from);
  if (view.kind === "scalar" && typeof view.value === "number" && view.source !== undefined) return { path: to, plain: view.source };
  return { path: to, value: view.value };
}

/**
 * The fields under `prefix` (by default `keepalive`: Keep-Alives and, there,
 * Idle Timeout): a write under `keepalive` also moves each flat deprecated
 * key in the text into it, in the same change, with its toast (the
 * control's own key is removed instead); a change leaving `keepalive` with
 * no key removes it, flat keys removed with it or not. With the prefix `[]`
 * (Idle Timeout at the flat key) the fields write their keys as they are.
 * With `readFlat`, the fields read the flat keys (Idle Timeout's flat
 * `idle_timeout`, the one the collector uses) and write as the prefix says. One
 * element either way (D9d Ruling 48b), so a field whose key moves between
 * the two (a flat `idle_timeout` cleared) keeps its input, focus and caret.
 */
function KeepaliveScope({ prefix = KEEPALIVE, readFlat = false, children }: { prefix?: ValuePath; readFlat?: boolean; children: ReactNode }) {
  const form = useForm();
  const { note } = useAdjustments();
  const noteRef = useRef(note);
  noteRef.current = note;
  const atFlatKeys = prefix.length === 0;
  const scoped = formSource(
    (path) => form.read(readFlat ? path : [...prefix, ...path]),
    (changes) => {
      if (atFlatKeys) return form.apply(changes);
      const block = form.read(KEEPALIVE);
      const own = changes.map((change) => ({ ...change, path: [...KEEPALIVE, ...change.path] }));
      const moves: ValueChange[] = [];
      const moved: string[] = [];
      for (const [flat, key] of FLAT_KEYS) {
        if (form.read([flat]).kind === "absent") continue;
        moves.push({ path: [flat], remove: true });
        // The control's own change to the key wins (the flat key is removed); otherwise the flat value moves.
        const controlled = changes.some((change) => change.path[0] === key);
        if (!controlled) moves.push(setAs(form, [flat], [...KEEPALIVE, key]));
        // A flat `false` the collector ignored takes effect once it is in `keepalive` (Ruling 47).
        const nowOff = !controlled && key === "enabled" && form.read([flat]).value === false && form.read([...KEEPALIVE, key]).value !== false;
        // A key the collector doesn't refuse beside `keepalive` goes without the reason (Ruling 48c).
        const accepted = isAcceptedBeside(flat, form.read([flat]).value);
        const message = controlled
          ? (accepted ? removedNoOpToast : removedToast)(flat)
          : (accepted ? movedNoOpToast : movedToast)(flat);
        moved.push(nowOff ? `${message}${NOW_OFF_TOAST}` : message);
      }
      // Only flat keys removed, none moved in: a change emptying the block takes it (never `keepalive: {}`, final ruling F5).
      const movesIn = moves.some((change) => !("remove" in change));
      const pruned = !movesIn && emptiesBlock(block, changes);
      const result = form.apply(pruned ? [{ path: KEEPALIVE, remove: true }, ...moves] : [...own, ...moves]);
      if (moved.length > 0) noteRef.current(moved, result);
      return result;
    },
    form.disabled,
  );
  return <FormProvider form={scoped}>{children}</FormProvider>;
}

/**
 * Idle Timeout at the key the text uses: the flat `idle_timeout` while it is
 * there and `keepalive` isn't. Beside a `keepalive` section it writes
 * `keepalive.idle_timeout` (removing the flat key), and shows the flat key
 * while there is one: it overrides `keepalive.idle_timeout`, a zero one too
 * (`server.go:235-239`; final ruling F5).
 */
function IdleTimeout() {
  const form = useForm();
  const flatSet = form.read(["idle_timeout"]).kind !== "absent";
  const flat = flatSet && form.read(KEEPALIVE).kind === "absent";
  return (
    <KeepaliveScope prefix={flat ? [] : KEEPALIVE} readFlat={flatSet}>
      <DurationField path={["idle_timeout"]} id="datadog-idle-timeout-server" label="Idle Timeout" defaultValue="1m" />
    </KeepaliveScope>
  );
}

/**
 * Keep-Alives at `keepalive.enabled`, as the collector reads it: a flat
 * `keep_alives_enabled: false` with no `keepalive` section is ignored
 * (`server.go:197-244`), so the box shows ticked, with `IGNORED_FLAT_HINT`;
 * unticking writes `keepalive.enabled: false` with the move (Ruling 47).
 */
function KeepAlivesBox() {
  const form = useForm();
  const ignored = form.read(["keep_alives_enabled"]).value === false && form.read(KEEPALIVE).kind === "absent";
  return (
    <KeepaliveScope>
      <CheckboxField
        path={["enabled"]}
        id="datadog-keepalives"
        label="Enable HTTP Keep-Alives"
        defaultChecked={true}
        checkedRemoves
        rowClassName="flex items-center gap-2 pt-2"
        labelClassName="text-sm"
        {...(ignored ? { description: IGNORED_FLAT_HINT } : {})}
      />
    </KeepaliveScope>
  );
}

/** The authenticator's id, trimmed; cleared, the whole `auth` block goes. */
function AuthenticatorField() {
  const form = useForm();
  const formRef = useRef(form);
  formRef.current = form;
  const view = form.read(["auth", "authenticator"]);
  const shown = view.kind === "absent" ? "" : view.kind === "scalar" ? (view.source ?? String(view.value)) : null;
  const text = useHeldText(
    shown ?? "",
    (typed) => {
      const current = formRef.current;
      const value = typed.trim();
      if (value === "") {
        if (current.read(["auth"]).kind !== "absent") current.remove(["auth"]);
        return;
      }
      current.set(["auth", "authenticator"], value);
    },
    // After the pause only what reads back as typed: a space under the cursor stays until the field is left.
    { pause: (typed) => typed === typed.trim() },
  );
  return (
    <ConfigField label="Authenticator Extension" description="Name of a configured auth extension; blank disables auth." htmlFor="datadog-auth">
      <VaultAwareInput
        id="datadog-auth"
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder="e.g. bearertokenauth/datadog"
        disabled={form.disabled || shown === null}
      />
      {shown === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </ConfigField>
  );
}

export function DatadogReceiverForm() {
  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="datadog-endpoint"
        label="Endpoint"
        defaultValue="localhost:8126"
        description="Address to listen on; point the Agent's DD_APM_DD_URL here."
      />

      <DurationField path={["read_timeout"]} id="datadog-read-timeout" label="Read Timeout" defaultValue="0 (none)" placeholder="0s" />

      <NumberField
        path={["trace_id_cache_size"]}
        id="datadog-trace-cache"
        label="Trace ID Cache Size"
        defaultValue="100"
        description="LRU cache mapping 64-bit Datadog trace IDs to 128-bit."
      />

      <DurationField
        path={["idle_series_timeout"]}
        id="datadog-idle-timeout"
        label="Idle Series Timeout"
        defaultValue="0s (disabled)"
        placeholder="0s"
        description="Drop metric series from memory after this long without updates."
      />

      <DurationField
        path={["idle_series_cleanup_interval"]}
        id="datadog-idle-cleanup"
        label="Idle Series Cleanup Interval"
        defaultValue="5m"
        description="How often the idle-series sweep runs."
      />

      <ConfigSection title="Security">
        <TLSConfigSection path={["tls"]} protocolLabel="HTTP" variant="server" />

        <div className="border-t border-border pt-4">
          <CORSConfigSection path={["cors"]} />
        </div>

        <div className="border-t border-border pt-4">
          <AuthenticatorField />
        </div>
      </ConfigSection>

      <ConfigSection title="Performance: HTTP Server">
        <NumberField
          path={["max_request_body_size"]}
          id="datadog-max-body"
          label="Max Request Body Size"
          defaultValue="20971520 (20 MiB)"
          placeholder="20971520"
          description="Largest accepted request body, in bytes."
        />

        <CheckboxSetField
          path={["compression_algorithms"]}
          id="datadog-compression"
          label="Compression Algorithms"
          description={`Restrict which request encodings are accepted. · ${COMPRESSION_HINT}`}
          items={COMPRESSION_ITEMS}
          emptyRemovesKey
          className="grid grid-cols-3 gap-x-2 gap-y-1.5"
          labelClassName="text-sm"
        />

        <div className="grid grid-cols-2 gap-3">
          <DurationField path={["read_header_timeout"]} id="datadog-read-header" label="Read Header Timeout" defaultValue="1m" />

          <DurationField path={["write_timeout"]} id="datadog-write-timeout" label="Write Timeout" defaultValue="30s" />

          <IdleTimeout />
        </div>

        <KeepAlivesBox />

        <CheckboxField
          path={["include_metadata"]}
          id="datadog-include-metadata"
          label="Propagate Client Metadata Downstream"
          defaultChecked={false}
          labelClassName="text-sm"
        />

        <div className="border-t border-border pt-4">
          <HeadersConfigSection path={["response_headers"]} title="Response Headers" description="Added to every HTTP response." />
        </div>
      </ConfigSection>
    </div>
  );
}
