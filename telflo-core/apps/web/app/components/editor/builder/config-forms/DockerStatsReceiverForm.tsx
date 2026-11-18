import { useRef } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { DurationField, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { listLength } from "./shared/counts.js";
import { KeyValueMapField, type KeyValueNouns } from "./shared/KeyValueMapField.js";
import { StringListField } from "./shared/StringListField.js";
import { VaultAwareInput } from "~/components/ui/vault-aware-input.js";
import { useHeldText } from "~/lib/editor/held-text.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The Docker stats receiver's form (ADR 0018), over the form's fields (D9c
 * decision 2, D9b's contract): each field writes its own key.
 *
 * - API Version is a string (D9c decision 2): what is typed is written as a
 *   string, so `1.25` is written `"1.25"`. The collector reads a string
 *   there and refuses a float, with a hint to quote it
 *   (`internal/docker/config.go:34, 47-61` at contrib v0.162.0). A number
 *   already in the text (`api_version: 1.40`) shows as written, with
 *   `API_VERSION_NUMBER_HINT` under it (decision 4; Ruling 47), and typing
 *   writes a string even when the characters are the same: the change is
 *   the type (`useHeldText`'s `writeSame`). Focusing and leaving writes
 *   nothing.
 * - Copy (D9c decision 4, Appearance): the API Version hint says what the
 *   collector does with it unset: it pins 1.44
 *   (`receiver/dockerstatsreceiver/factory.go:32-33`, `receiver.go:28`); only
 *   an explicit empty version leaves the client unpinned
 *   (`internal/docker/docker.go:60-67`), which the form can't write
 *   (clearing removes the key); it doesn't auto-negotiate.
 * - The two label maps are `KeyValueMapField`'s `"staging"` layout, the
 *   `HeadersConfigSection` markup with `title={null}` (Preflight ruling 4),
 *   with their own nouns (decision 4), not "Header name", "Header value",
 *   "e.g. Authorization", "Add header", "Remove header".
 *   A key is renamed in place on blur or Enter, and a key another row has
 *   is refused under the row (D9b decision 4; never re-keyed on each
 *   keystroke, never overwriting a clash). The staging row's examples are the
 *   collector's own (`receiver/dockerstatsreceiver/config.go:22-35`). Both
 *   maps are `map[string]string` (`config.go:27, 35`).
 * - Excluded Images is D9b's `StringListField`: removing the last pattern
 *   removes the key, and a remove button says
 *   "Remove", never the pattern (D9b decision 10).
 * - Unset shows the collector's default (D9b decision 3): Endpoint
 *   `unix:///var/run/docker.sock` (`internal/docker/config.go:90-95`,
 *   `client.DefaultDockerHost`), Collection Interval `10s`, Timeout `5s`
 *   (`factory.go:29-31`), Initial Delay `1s` (core scraperhelper's
 *   `NewDefaultControllerConfig`), as the placeholders and hints say.
 *   Clearing a field removes its key.
 *
 * Ids are fixed (`docker-stats-…`); map rows are keyed by
 * index; no value reaches an attribute (decision 10).
 */

/** The hint under API Version (D9c decision 4, Appearance). */
export const API_VERSION_HINT = "Docker client API version to pin (1.25+). Default 1.44. Always a quoted string in YAML.";

/** Under API Version while the text holds a number there (Ruling 47; `internal/docker/config.go:47-61`). */
export const API_VERSION_NUMBER_HINT = "Written as a number; the collector needs a quoted string. Retype it to quote it.";

/** Container labels to metric labels: its rows' words (decision 4). */
export const CONTAINER_LABEL_NOUNS: KeyValueNouns = {
  key: "Container label",
  value: "Metric label",
  addLabel: "Add container label",
  removeLabel: "Remove container label",
  exists: "A label with this name already exists.",
  newKey: "e.g. io.kubernetes.container.name",
  newValue: "e.g. container_spec_name",
};

/** Environment variables to metric labels: its rows' words (decision 4). */
export const ENV_VAR_NOUNS: KeyValueNouns = {
  key: "Environment variable",
  value: "Metric label",
  addLabel: "Add environment variable",
  removeLabel: "Remove environment variable",
  exists: "A variable with this name already exists.",
  newKey: "e.g. APP_VERSION",
  newValue: "e.g. version",
};

/** A mapping's key count (`Object.keys(…).length`). */
function keyCount(view: ValueView): number {
  return view.kind === "map" ? Object.keys(view.value).length : 0;
}

export function DockerStatsReceiverForm() {
  const form = useForm();

  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="docker-stats-endpoint"
        label="Endpoint"
        defaultValue="unix:///var/run/docker.sock"
        description="Address of the Docker daemon."
        placeholder="e.g. unix:///var/run/docker.sock"
      />

      <InlineAlert variant="info">
        The collector needs read access to the Docker socket (mount /var/run/docker.sock into the container, and make sure
        the collector user can read it). Linux only; requires Docker API 1.25+.
      </InlineAlert>

      <ConfigSection title="Collection" defaultOpen>
        <DurationField
          path={["collection_interval"]}
          id="docker-stats-interval"
          label="Collection Interval"
          defaultValue="10s"
          description="How often container stats are gathered."
        />

        <DurationField
          path={["initial_delay"]}
          id="docker-stats-initial-delay"
          label="Initial Delay"
          defaultValue="1s"
          description="Wait before the first scrape."
        />

        <DurationField
          path={["timeout"]}
          id="docker-stats-timeout"
          label="Timeout"
          defaultValue="5s"
          description="Per-request timeout for Docker daemon queries."
        />

        <ApiVersionField />
      </ConfigSection>

      <ConfigSection title="Excluded Images" count={listLength(form.read(["excluded_images"]))}>
        <StringListField
          path={["excluded_images"]}
          label="Image Patterns"
          description="Containers whose image matches are skipped. Plain names, /regex/, globs, and !-prefixed negations."
          placeholder="e.g. undesired-container or /.*undesired.*/"
          emptyRemovesKey
        />
      </ConfigSection>

      <ConfigSection
        title="Container Labels to Metric Labels"
        count={keyCount(form.read(["container_labels_to_metric_labels"]))}
      >
        <KeyValueMapField
          path={["container_labels_to_metric_labels"]}
          layout="staging"
          nouns={CONTAINER_LABEL_NOUNS}
          title={null}
          description="Docker container label name → metric label key."
        />
      </ConfigSection>

      <ConfigSection title="Env Vars to Metric Labels" count={keyCount(form.read(["env_vars_to_metric_labels"]))}>
        <KeyValueMapField
          path={["env_vars_to_metric_labels"]}
          layout="staging"
          nouns={ENV_VAR_NOUNS}
          title={null}
          description="Container environment variable → metric label key."
        />
      </ConfigSection>

      <p className="text-[11px] leading-4 text-muted-foreground">
        Per-metric enable/disable toggles (metrics:) are available in the YAML editor.
      </p>
    </div>
  );
}

/**
 * API Version: a string, always (`1.25` is written "1.25"; the collector
 * refuses a float). `TextField`'s display and writes, and a number in the
 * text says so and is quoted by the next typing, the same characters
 * included (Ruling 47).
 */
function ApiVersionField() {
  const form = useForm();
  const path = ["api_version"];
  const view = form.read(path);
  const written = view.kind === "scalar" ? (view.source ?? String(view.value)) : null;
  // As `TextField` shows it: unset empty, a scalar as written, anything else (or a line break) not at all.
  const shown = view.kind === "absent" ? "" : written !== null && !/[\r\n]/.test(written) ? written : null;
  const number = view.kind === "scalar" && (typeof view.value === "number" || typeof view.value === "bigint");
  const formRef = useRef(form);
  formRef.current = form;
  const text = useHeldText(
    shown ?? "",
    (typed) => {
      if (typed === "") formRef.current.remove(path);
      else formRef.current.set(path, typed);
    },
    { writeSame: number },
  );
  return (
    <ConfigField label="API Version" htmlFor="docker-stats-api-version" description={API_VERSION_HINT}>
      <VaultAwareInput
        id="docker-stats-api-version"
        value={text.value}
        onChange={(e) => text.change(e.target.value)}
        onBlur={text.flush}
        onKeyDown={(e) => text.handleKeyDown(e)}
        placeholder="e.g. 1.25"
        disabled={form.disabled || shown === null}
      />
      {number && <p className="text-[11px] leading-4 text-muted-foreground">{API_VERSION_NUMBER_HINT}</p>}
      {shown === null && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </ConfigField>
  );
}
