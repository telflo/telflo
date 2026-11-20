import { useState, type ReactNode } from "react";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";
import {
  CheckboxField,
  DurationField,
  FormProvider,
  FormScope,
  formSource,
  MultiValueField,
  NumberField,
  SelectField,
  TextField,
  UNSHOWABLE_VALUE_MESSAGE,
  useForm,
  type FormSource,
} from "./form-context.js";
import { InlineAlert } from "./InlineAlert.js";
import { useAdjustments } from "./shared/AdjustmentAlert.js";
import { HeadersConfigSection } from "./shared/HeadersConfigSection.js";
import { RetryConfigSection } from "./shared/RetryConfigSection.js";
import { SendingQueueSection } from "./shared/SendingQueueSection.js";
import { TLSConfigSection } from "./shared/TLSConfigSection.js";
import { TLSInsecureCheckbox } from "./shared/TLSInsecureCheckbox.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The load-balancing exporter's form, over the form's fields: each field
 * writes its own key. Collector claims cite contrib v0.162.0,
 * `exporter/loadbalancingexporter`.
 *
 * - Fixed: an absent `resolver` or `protocol` shows as unset (never a
 *   throw); a resolver type is chosen from nothing, and the OTLP Protocol
 *   fields write `protocol.otlp` as they are typed.
 * - Fixed: Custom Attributes is held until its first attribute
 *   (`config.go:66-68` refuses `routing_key: attributes` without
 *   `routing_attributes`): the select shows it and Routing Attributes shows
 *   a held row; the first attribute writes `routing_key: attributes` and
 *   `routing_attributes: [typed]` in one change. Choosing another key, or
 *   leaving, drops the hold. The last attribute's Remove is disabled while
 *   `routing_key: attributes` is in the text, with the hint. Choosing a key
 *   other than attributes removes `routing_attributes` in the same change,
 *   with a toast (`config.go:70- 72` refuses them with another key).
 * - Changed: switching the resolver removes the other resolvers' blocks and
 *   writes the new one's seed in one change, with a toast
 *   (`loadbalancer.go:63-65`: one resolver only), rather than replacing the
 *   whole `resolver`. A block the text already has for the chosen resolver
 *   is kept.
 * - Fixed: Add Endpoint, Add Attribute and Add Port hold a row until
 *   something is typed (never `""` or `4317` items); Kubernetes ports are
 *   numeric rows written as typed (`[]int32`, `config.go`); removing the
 *   last port removes `ports` (each backend then gets 4317,
 *   `loadbalancer.go:191-194`). The last endpoint can't be removed
 *   (`resolver_static.go:36-37` refuses none).
 * - Changed: unset shows the collector's default as the placeholder and the
 *   hint: the routing key per signal (`trace_exporter.go:76-86`,
 *   `metrics_exporter.go:69-84`, `log_exporter.go:73-84`), DNS port 4317,
 *   interval 5s and timeout 1s (`resolver_dns.go:25-26`), Kubernetes timeout
 *   1m (`resolver_k8s.go:46`), AWS interval 30s and timeout 5s
 *   (`resolver_aws_cloud_map.go:26-27`), protocol timeout 5s (the OTLP
 *   exporter's `NewDefaultTimeoutConfig`). The top-level retry and queue are
 *   off while absent (`factory.go:41-54`: a zero `BackOffConfig`,
 *   `configoptional.Default` queue), the protocol's on (the OTLP exporter's
 *   defaults). The routing keys' labels say which signals take them,
 *   `randomness` is offered (`config.go:36`), and the copy covers the
 *   attributes hint, the gRPC insecure copy, the top-level timeout, the
 *   storage alert under OTLP Protocol (README: a persistent queue isn't
 *   supported there).
 */

const ROUTING_KEYS = [
  { value: "traceID", label: "Trace ID (traces, logs)" },
  { value: "service", label: "Service Name" },
  { value: "attributes", label: "Custom Attributes" },
  { value: "metric", label: "Metric Name (metrics only)" },
  { value: "resource", label: "Resource Attributes (metrics, logs)" },
  { value: "streamID", label: "Stream ID (metrics only)" },
  { value: "randomness", label: "Randomness (traces only)" },
] as const;

const ATTRIBUTES = "attributes";

export const REMOVED_ROUTING_ATTRIBUTES = "Removed routing_attributes: they're only used with the attributes routing key.";
export const LAST_ATTRIBUTE_HINT = "The attributes routing key needs at least one attribute.";

type ResolverType = "static" | "dns" | "k8s" | "aws_cloud_map";

const RESOLVERS: readonly { value: ResolverType; label: string; name: string; seed: Record<string, unknown> }[] = [
  { value: "static", label: "Static (Fixed Endpoints)", name: "static", seed: { hostnames: ["localhost:4317"] } },
  {
    value: "dns",
    label: "DNS (Dynamic Discovery)",
    name: "DNS",
    seed: { hostname: "otel-collectors.example.com", port: "4317", interval: "5s", timeout: "1s" },
  },
  { value: "k8s", label: "Kubernetes (K8s Service)", name: "Kubernetes", seed: { service: "otel-collector.monitoring", ports: [4317], timeout: "1s" } },
  {
    value: "aws_cloud_map",
    label: "AWS CloudMap",
    name: "AWS Cloud Map",
    seed: { namespace: "prod-telemetry", service_name: "otel-collectors", interval: "30s", timeout: "5s" },
  },
];

/** The toast for a resolver's block removed by the switch. */
export function removedResolverMessage(name: string): string {
  return `Removed the ${name} resolver's settings: the collector takes one resolver. Undo to restore them.`;
}

const COMPRESSIONS = [
  { value: "gzip", label: "gzip" },
  { value: "none", label: "none" },
] as const;

const HEALTH_STATUSES = ["HEALTHY", "UNHEALTHY", "ALL", "HEALTHY_OR_ELSE_ALL"].map((value) => ({ value, label: value }));

/** A scalar's text as written, or null for anything else. */
function scalarOf(view: ValueView): string | null {
  return view.kind === "scalar" ? (view.source ?? String(view.value)) : null;
}

/** Whether a list holds at least one item. */
function hasItems(view: ValueView): boolean {
  return view.kind === "list" && view.value.length > 0;
}

export function LoadBalancingExporterForm() {
  const form = useForm();
  const adjustments = useAdjustments();
  const routingKey = form.read(["routing_key"]);
  const keyText = scalarOf(routingKey);
  const attributes = form.read(["routing_attributes"]);
  // Custom Attributes held: the routing key as it was when it was held; a change drops it.
  const [heldOver, setHeldOver] = useState<string | null | undefined>(undefined);
  const keyNow = routingKey.kind === "absent" ? null : keyText;
  if (heldOver !== undefined && heldOver !== keyNow) setHeldOver(undefined);
  const holdingAttributes = heldOver !== undefined && heldOver === keyNow;
  const attributesKey = keyText === ATTRIBUTES;

  const chooseKey = (value: string) => {
    if (value === ATTRIBUTES) {
      if (hasItems(attributes)) form.set(["routing_key"], ATTRIBUTES);
      else setHeldOver(keyNow);
      return;
    }
    setHeldOver(undefined);
    const changes: ValueChange[] = [{ path: ["routing_key"], value }];
    if (attributes.kind !== "absent") {
      changes.push({ path: ["routing_attributes"], remove: true });
      adjustments.note([REMOVED_ROUTING_ATTRIBUTES], form.apply(changes));
    } else {
      form.apply(changes);
    }
  };

  // The routing key's select shows Custom Attributes while it is held.
  const keyForm: FormSource = holdingAttributes
    ? formSource(
        (path) => (path.length === 1 && path[0] === "routing_key" ? { kind: "scalar", value: ATTRIBUTES } : form.read(path)),
        form.apply,
        form.disabled,
      )
    : form;

  const resolverView = form.read(["resolver"]);
  const staticCount = form.read(["resolver", "static", "hostnames"]);

  return (
    <div className="space-y-4">
      <FormProvider form={keyForm}>
        <SelectField
          path={["routing_key"]}
          id="lb-routing-key"
          label="Routing Key"
          defaultValue="traceID (traces), service (metrics, logs)"
          placeholder=""
          description="traceID keeps every span of a trace on one backend."
          options={ROUTING_KEYS}
          onSelect={chooseKey}
        />
      </FormProvider>

      {(attributesKey || holdingAttributes) && (
        <ConfigField label="Routing Attributes" description="Supports pseudo-attributes: span.kind, span.name (traces); log.severity, log.body (logs).">
          <MultiValueField
            path={["routing_attributes"]}
            id="lb-routing-attributes"
            placeholder="e.g. span.kind"
            addButtonText="Add Attribute"
            holdEmpty
            vaultAware
            startHeld={holdingAttributes && !hasItems(attributes)}
            keepLast={attributesKey}
            keepLastHint={LAST_ATTRIBUTE_HINT}
            {...(holdingAttributes ? { alsoOnAppend: () => [{ path: ["routing_key"], value: ATTRIBUTES }] } : {})}
          />
        </ConfigField>
      )}

      <ConfigSection title="Resolver" defaultOpen {...(staticCount.kind === "list" ? { count: staticCount.value.length } : {})}>
        {resolverView.kind === "map" || resolverView.kind === "absent" ? (
          <Resolver />
        ) : (
          <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>
        )}
      </ConfigSection>

      <ConfigSection title="OTLP Protocol">
        <InlineAlert variant="info" title="No endpoint field">
          The resolver supplies each backend endpoint; these settings apply to every backend connection.
        </InlineAlert>
        <Block path={["protocol", "otlp"]}>
          <OtlpProtocol />
        </Block>
      </ConfigSection>

      <ConfigSection title="Advanced">
        <DurationField
          path={["timeout"]}
          id="lb-timeout"
          label="Top-Level Timeout"
          defaultValue="disabled"
          description="Load-balancer-level timeout. Applied after the protocol settings; both apply."
          placeholder="disabled"
        />

        <div>
          <h3 className="text-sm font-medium text-foreground mb-3">Top-Level Retry</h3>
          <RetryConfigSection path={["retry_on_failure"]} idPrefix="lb-" absentMeans="off-struct" />
        </div>

        <div>
          <h3 className="text-sm font-medium text-foreground mb-3">Top-Level Sending Queue</h3>
          <SendingQueueSection path={["sending_queue"]} idPrefix="lb-" absentMeans="off-optional" />
        </div>
      </ConfigSection>
    </div>
  );
}

/**
 * The fields under a block that may be absent, null or a mapping: they read
 * and write under it (a write makes it a mapping); anything else (a list, a
 * scalar) is read-only with `UNSHOWABLE_VALUE_MESSAGE`. Each level is checked,
 * so `protocol: 5` doesn't crash `protocol.otlp`.
 */
function Block({ path, children }: { path: ValuePath; children: ReactNode }) {
  const form = useForm();
  for (let depth = 1; depth <= path.length; depth++) {
    const view = form.read(path.slice(0, depth));
    if (view.kind === "absent") break;
    if (view.kind !== "map") return <p className="text-[11px] leading-4 text-muted-foreground">{UNSHOWABLE_VALUE_MESSAGE}</p>;
  }
  return <FormScope path={path}>{children}</FormScope>;
}

/** The resolver type and its fields, under `resolver` (a mapping or absent). */
function Resolver() {
  const form = useForm();
  const adjustments = useAdjustments();
  const present = RESOLVERS.filter((resolver) => form.read(["resolver", resolver.value]).kind !== "absent");
  // With several (refused, `loadbalancer.go:63-65`), the first shows; choosing another removes them all.
  const current = present[0]?.value;

  const choose = (next: ResolverType) => {
    if (next === current) return;
    const removed = present.filter((resolver) => resolver.value !== next);
    const changes: ValueChange[] = removed.map((resolver) => ({ path: ["resolver", resolver.value], remove: true }));
    const seed = RESOLVERS.find((resolver) => resolver.value === next)!.seed;
    if (!present.some((resolver) => resolver.value === next)) changes.push({ path: ["resolver", next], value: seed });
    const result = form.apply(changes);
    if (removed.length > 0) adjustments.note(removed.map((resolver) => removedResolverMessage(resolver.name)), result);
  };

  return (
    <>
      <ConfigField label="Resolver Type" htmlFor="lb-resolver-type" description="How backend instances are discovered.">
        <Select value={current ?? ""} onValueChange={(value) => choose(value as ResolverType)} disabled={form.disabled}>
          <SelectTrigger id="lb-resolver-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESOLVERS.map((resolver) => (
              <SelectItem key={resolver.value} value={resolver.value}>
                {resolver.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ConfigField>

      {current === "static" && (
        <Block path={["resolver", "static"]}>
          <ConfigField label="Backend Endpoints" description="Fixed backend list in host:port format.">
            <MultiValueField
              path={["hostnames"]}
              id="lb-static-hostnames"
              placeholder="e.g. backend-1:4317"
              addButtonText="Add Endpoint"
              holdEmpty
              vaultAware
              keepLast
            />
          </ConfigField>
          <InlineAlert variant="warn" title="No auto-recovery">
            The endpoint list is never re-resolved. Exports fail while every backend is unreachable.
          </InlineAlert>
        </Block>
      )}

      {current === "dns" && (
        <Block path={["resolver", "dns"]}>
          <TextField
            path={["hostname"]}
            id="lb-dns-hostname"
            label="Hostname"
            required
            description="Domain to resolve; A/AAAA records become backends."
            placeholder="e.g. otel-collectors.example.com"
          />
          <TextField path={["port"]} id="lb-dns-port" label="Port" defaultValue="4317" description="Applied to every resolved backend." />
          <DurationField path={["interval"]} id="lb-dns-interval" label="Refresh Interval" defaultValue="5s" description="How often DNS is re-resolved." />
          <DurationField path={["timeout"]} id="lb-dns-timeout" label="DNS Timeout" defaultValue="1s" />
        </Block>
      )}

      {current === "k8s" && (
        <Block path={["resolver", "k8s"]}>
          <TextField
            path={["service"]}
            id="lb-k8s-service"
            label="Service"
            required
            description="Format: service-name.namespace."
            placeholder="e.g. otel-collector.monitoring"
          />
          <ConfigField label="Ports" defaultValue="4317" description="Each port creates a separate backend per pod.">
            <MultiValueField
              path={["ports"]}
              id="lb-k8s-ports"
              placeholder="4317"
              addButtonText="Add Port"
              holdEmpty
              numeric
              emptyRemovesKey
            />
          </ConfigField>
          <DurationField path={["timeout"]} id="lb-k8s-timeout" label="Timeout" defaultValue="1m" description="Kubernetes API timeout." />
          <CheckboxField
            path={["return_hostnames"]}
            id="return_hostnames"
            label="Return Hostnames"
            labelClassName="text-sm font-normal cursor-pointer"
            description="Requires a headless Service and a StatefulSet."
            defaultChecked={false}
          />
        </Block>
      )}

      {current === "aws_cloud_map" && (
        <Block path={["resolver", "aws_cloud_map"]}>
          <TextField path={["namespace"]} id="lb-aws-namespace" label="Namespace" required placeholder="e.g. prod-telemetry" />
          <TextField
            path={["service_name"]}
            id="lb-aws-service-name"
            label="Service Name"
            required
            description="Registered service; resolution returns at most 100 hosts."
            placeholder="e.g. otel-collectors"
          />
          <NumberField
            path={["port"]}
            id="lb-aws-port"
            label="Port"
            description="Overrides the port from the CloudMap registration."
            placeholder="e.g. 4317"
          />
          <DurationField
            path={["interval"]}
            id="lb-aws-interval"
            label="Refresh Interval"
            defaultValue="30s"
            description="How often instances are re-discovered."
          />
          <DurationField path={["timeout"]} id="lb-aws-timeout" label="Timeout" defaultValue="5s" description="CloudMap API timeout." />
          <SelectField
            path={["health_status"]}
            id="lb-aws-health-status"
            label="Health Status Filter"
            placeholder="HEALTHY"
            options={HEALTH_STATUSES}
          />
        </Block>
      )}
    </>
  );
}

/** The OTLP exporter's settings every backend connection takes, under `protocol.otlp`. */
function OtlpProtocol() {
  const form = useForm();
  const tls = form.read(["tls"]);
  return (
    <>
      <DurationField
        path={["timeout"]}
        id="lb-protocol-timeout"
        label="Timeout"
        defaultValue="5s"
        description="Per-request timeout for each backend."
        placeholder="5s"
      />

      <SelectField path={["compression"]} id="lb-protocol-compression" label="Compression" placeholder="gzip" options={COMPRESSIONS} />

      <TLSConfigSection path={["tls"]} protocolLabel="OTLP" variant="client" />

      {tls.kind === "map" && <TLSInsecureCheckbox path={["tls", "insecure"]} protocol="grpc" />}

      <HeadersConfigSection path={["headers"]} />

      <RetryConfigSection path={["retry_on_failure"]} />

      <SendingQueueSection path={["sending_queue"]} />

      <InlineAlert variant="warn">A persistent queue (storage) isn't supported here; set it on the top-level queue.</InlineAlert>
    </>
  );
}
