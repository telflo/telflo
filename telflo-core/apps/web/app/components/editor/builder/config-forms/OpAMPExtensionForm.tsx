import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import { DurationField, FormScope, TextField, UNSHOWABLE_VALUE_MESSAGE, useForm, type FormSource } from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { HeadersConfigSection } from "./shared/HeadersConfigSection.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import type { ValueChange } from "~/lib/graph/text-edits.js";

/*
 * The OpAMP extension's form, over the form's fields. The transport is `http`
 * while `server.http` is there, `ws` otherwise; the transport's fields write
 * their own key under `server.<transport>`, and nothing else under `server` is
 * touched.
 *
 * Fixed, so a person's own config isn't lost: switching the transport
 * renames `server.ws` to `server.http` (or back) in place, so the block
 * keeps its keys, their order and comments: `endpoint`, `tls`, `headers`,
 * `auth`, and anything else it holds. The collector's `ws` and `http` share
 * every key but `polling_interval`, which is http's only (`opampextension`
 * `commonFields` and `httpFields`, contrib v0.162.0), so switching to `ws`
 * also removes `polling_interval`; switching to `http` keeps everything, a
 * `polling_interval` the ws block held included (it now applies). One
 * change list, one undo entry. With no block to rename (no `server.ws`
 * yet), switching to http writes `server.http: {}`. A text holding both
 * blocks (which the collector refuses) shows http, and a switch to ws is
 * refused with a toast (the names clash).
 *
 * Capabilities store only deviations from the collector's defaults: a
 * box set back to its default removes its key, and the
 * last one removed takes `capabilities` with it. The defaults
 * (`createDefaultConfig`, contrib v0.162.0): reports effective config,
 * health and available components on; accepts restart command off. The
 * polling interval's default is 30s (`httpPollingIntervalDefault`).
 */

type Transport = "ws" | "http";

type CapabilityKey = "reports_effective_config" | "reports_health" | "reports_available_components" | "accepts_restart_command";

/** The transport the text holds: http while `server.http` is there, ws otherwise. */
function transportOf(server: Record<string, unknown> | undefined): Transport {
  return server !== undefined && Object.hasOwn(server, "http") ? "http" : "ws";
}

/** The changes that switch `current` to `next`: the block renamed in place; ws takes no polling interval. */
export function transportChanges(form: FormSource, current: Transport, next: Transport): ValueChange[] {
  const server = form.read(["server"]);
  const hasBlock = server.kind === "map" && Object.hasOwn(server.value, current);
  if (!hasBlock) return [{ path: ["server", next], value: {} }];
  const changes: ValueChange[] = [{ path: ["server", current], renameTo: next }];
  if (next === "ws") changes.push({ path: ["server", "ws", "polling_interval"], remove: true });
  return changes;
}

export function OpAMPExtensionForm() {
  const form = useForm();
  const server = form.read(["server"]);
  const serverShowable = server.kind === "map" || server.kind === "absent";
  const transport = transportOf(server.kind === "map" ? server.value : undefined);
  const block = form.read(["server", transport]);
  const blockShowable = serverShowable && (block.kind === "map" || block.kind === "absent");
  const headers = form.read(["server", transport, "headers"]);
  const headerCount = headers.kind === "map" ? Object.keys(headers.value).length : 0;

  const capabilities = form.read(["capabilities"]);
  const capabilityCount = capabilities.kind === "map" ? Object.keys(capabilities.value).length : 0;
  const restart = form.read(["capabilities", "accepts_restart_command"]);

  const switchTransport = (next: Transport) => {
    if (next === transport) return;
    form.apply(transportChanges(form, transport, next));
  };

  return (
    <div className="space-y-4">
      <ConfigField label="Transport" htmlFor="opamp-transport" description="Exactly one server transport must be configured.">
        <Select
          value={transport}
          onValueChange={(value) => switchTransport(value as Transport)}
          disabled={form.disabled || !serverShowable}
        >
          <SelectTrigger id="opamp-transport">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ws">WebSocket</SelectItem>
            <SelectItem value="http">HTTP (polling)</SelectItem>
          </SelectContent>
        </Select>
        {!blockShowable && <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
      </ConfigField>

      {blockShowable && (
        // Keyed by the transport: its fields address another block after a switch.
        <FormScope key={transport} path={["server", transport]}>
          <TextField
            path={["endpoint"]}
            id="opamp-endpoint"
            label="Server Endpoint"
            required
            description={
              transport === "ws" ? "OpAMP server websocket URL." : "OpAMP server HTTP URL, polled on an interval."
            }
            placeholder={
              transport === "ws" ? "e.g. wss://opamp-server:4320/v1/opamp" : "e.g. https://opamp-server:4320/v1/opamp"
            }
          />

          {transport === "http" && (
            <DurationField
              path={["polling_interval"]}
              id="opamp-polling-interval"
              label="Polling Interval"
              defaultValue="30s"
              description="How often the extension polls the OpAMP server."
              placeholder="30s"
            />
          )}

          <TextField
            path={["auth"]}
            id="opamp-auth"
            label="Auth Extension"
            description="ID of an auth extension (e.g. bearertokenauth) used to authenticate to the server."
            placeholder="e.g. bearertokenauth"
          />

          <ConfigSection title="Headers" count={headerCount}>
            <HeadersConfigSection path={["headers"]} title={null} description="Sent on every request to the OpAMP server." />
          </ConfigSection>
        </FormScope>
      )}

      <ConfigSection title="Identity">
        <TextField
          path={["instance_uid"]}
          id="opamp-instance-uid"
          label="Instance UID"
          description="UUIDv7 pinning the agent identity across restarts. Auto-generated when empty."
          placeholder="e.g. 01890a5d-ac96-774b-b103-c34d6b3f1234"
        />
      </ConfigSection>

      <ConfigSection title="Capabilities" defaultOpen={capabilityCount > 0}>
        {capabilities.kind !== "map" && capabilities.kind !== "absent" ? (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        ) : (
          <>
            <CapabilityBox
              capability="reports_effective_config"
              id="opamp-reports-effective-config"
              defaultChecked
              label="Report effective config to the server (collector default)"
            />
            <CapabilityBox
              capability="reports_health"
              id="opamp-reports-health"
              defaultChecked
              label="Report health to the server (collector default)"
            />
            <CapabilityBox
              capability="reports_available_components"
              id="opamp-reports-available-components"
              defaultChecked
              label="Report available components (collector default)"
            />
            <CapabilityBox
              capability="accepts_restart_command"
              id="opamp-accepts-restart"
              defaultChecked={false}
              label="Accept restart commands (SIGHUP; feature-gated, no Windows support)"
            />

            {restart.kind === "scalar" && restart.value === true && (
              <InlineAlert variant="warn">
                Restarting into an invalid config leaves the collector down until something else restarts it. Keep
                health checks in place and validate configs before applying them remotely.
              </InlineAlert>
            )}
          </>
        )}
      </ConfigSection>

      <p className="text-[11px] leading-4 text-muted-foreground">
        TLS settings, agent_description, and the supervisor-managed ppid fields are available in the YAML editor.
      </p>
    </div>
  );
}

/**
 * A capability's box: unset shows the collector's default. Ticking it away
 * from the default writes the key; back to the default removes the key, and
 * `capabilities` with its last key (only deviations are stored).
 */
function CapabilityBox({
  capability,
  id,
  label,
  defaultChecked,
}: {
  capability: CapabilityKey;
  id: string;
  label: string;
  defaultChecked: boolean;
}) {
  const form = useForm();
  const path = ["capabilities", capability];
  const view = form.read(path);
  const checked = view.kind === "absent" ? defaultChecked : typeof view.value === "boolean" ? view.value : null;

  const toggle = (next: boolean) => {
    if (next === checked) return;
    if (next !== defaultChecked) {
      form.set(path, next);
      return;
    }
    const capabilities = form.read(["capabilities"]);
    const others = capabilities.kind === "map" ? Object.keys(capabilities.value).filter((key) => key !== capability) : [];
    form.remove(others.length === 0 ? ["capabilities"] : path);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked ?? false}
          onCheckedChange={(next) => toggle(next === true)}
          disabled={form.disabled || checked === null}
        />
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </Label>
      </div>
      {checked === null && <p className="ml-6 text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>}
    </>
  );
}
