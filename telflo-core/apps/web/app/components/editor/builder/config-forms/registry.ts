import type { ComponentType as ReactComponent } from "react";

import { AttributesProcessorForm } from "./AttributesProcessorForm.js";
import { AWSS3ExporterForm } from "./AWSS3ExporterForm.js";
import { AWSS3ReceiverForm } from "./AWSS3ReceiverForm.js";
import { BatchProcessorForm } from "./BatchProcessorForm.js";
import { BearerTokenAuthExtensionForm } from "./BearerTokenAuthExtensionForm.js";
import { ClickhouseExporterForm } from "./ClickhouseExporterForm.js";
import { CumulativeToDeltaProcessorForm } from "./CumulativeToDeltaProcessorForm.js";
import { DatadogExporterForm } from "./DatadogExporterForm.js";
import { DatadogReceiverForm } from "./DatadogReceiverForm.js";
import { DebugExporterForm } from "./DebugExporterForm.js";
import { DockerStatsReceiverForm } from "./DockerStatsReceiverForm.js";
import { FailoverConnectorForm } from "./FailoverConnectorForm.js";
import { FileExporterForm } from "./FileExporterForm.js";
import { FilelogReceiverForm } from "./FilelogReceiverForm.js";
import { FileStorageExtensionForm } from "./FileStorageExtensionForm.js";
import { FilterProcessorForm } from "./FilterProcessorForm.js";
import { FluentForwardReceiverForm } from "./FluentForwardReceiverForm.js";
import { ForwardConnectorForm } from "./ForwardConnectorForm.js";
import { GroupByAttrsProcessorForm } from "./GroupByAttrsProcessorForm.js";
import { HealthCheckForm } from "./HealthCheckForm.js";
import { HostmetricsReceiverForm } from "./HostmetricsReceiverForm.js";
import { JaegerReceiverForm } from "./JaegerReceiverForm.js";
import { JournaldReceiverForm } from "./JournaldReceiverForm.js";
import { K8sAttributesProcessorForm } from "./K8sAttributesProcessorForm.js";
import { K8sClusterReceiverForm } from "./K8sClusterReceiverForm.js";
import { K8sEventsReceiverForm } from "./K8sEventsReceiverForm.js";
import { K8sObjectsReceiverForm } from "./K8sObjectsReceiverForm.js";
import { KubeletStatsReceiverForm } from "./KubeletStatsReceiverForm.js";
import { LoadBalancingExporterForm } from "./LoadBalancingExporterForm.js";
import { LogDedupProcessorForm } from "./LogDedupProcessorForm.js";
import { MemoryLimiterForm } from "./MemoryLimiterForm.js";
import { MetricsTransformProcessorForm } from "./MetricsTransformProcessorForm.js";
import { NetflowReceiverForm } from "./NetflowReceiverForm.js";
import { OIDCAuthExtensionForm } from "./OIDCAuthExtensionForm.js";
import { OpAMPExtensionForm } from "./OpAMPExtensionForm.js";
import { OTLPExporterForm } from "./OTLPExporterForm.js";
import { OTLPHTTPExporterForm } from "./OTLPHTTPExporterForm.js";
import { OTLPReceiverForm } from "./OTLPReceiverForm.js";
import { PprofForm } from "./PprofForm.js";
import { ProbabilisticSamplerForm } from "./ProbabilisticSamplerForm.js";
import { PrometheusExporterForm } from "./PrometheusExporterForm.js";
import { PrometheusReceiverForm } from "./PrometheusReceiverForm.js";
import { PrometheusRemoteWriteExporterForm } from "./PrometheusRemoteWriteExporterForm.js";
import { RedactionProcessorForm } from "./RedactionProcessorForm.js";
import { ResourceDetectionProcessorForm } from "./ResourceDetectionProcessorForm.js";
import { ResourceProcessorForm } from "./ResourceProcessorForm.js";
import { RoutingConnectorForm } from "./RoutingConnectorForm.js";
import { SpanmetricsConnectorForm } from "./SpanmetricsConnectorForm.js";
import { SpanProcessorForm } from "./SpanProcessorForm.js";
import { StatsdReceiverForm } from "./StatsdReceiverForm.js";
import { SyslogReceiverForm } from "./SyslogReceiverForm.js";
import { TailSamplingForm } from "./TailSamplingForm.js";
import { TransformProcessorForm } from "./TransformProcessorForm.js";
import { ZipkinExporterForm } from "./ZipkinExporterForm.js";
import { ZipkinReceiverForm } from "./ZipkinReceiverForm.js";
import { ZPagesForm } from "./ZPagesForm.js";
import { paletteSubType } from "~/lib/graph/parse.js";
import type { ComponentType } from "~/lib/graph/types.js";

/*
 * Which form a component gets: by type and sub-type, never the sub-type
 * alone, so the `memory_limiter` extension doesn't get the processor's form.
 *
 * A form is found by the component's type and its palette sub-type: a
 * renamed spelling (`otlp_grpc`, `otlp_http`) resolves through
 * `paletteSubType` to the palette's, whose form it gets. A component with
 * no entry keeps the Configuration tab's fallback layout.
 *
 * A form takes no props: it reads and writes through the form hook's
 * source (`useForm`), which the Configuration tab provides for the selected
 * component. A form is added by adding its row to `FORMS` below, under its
 * type.
 */

/** A component's form: its fields read and write through `useForm()`. */
export type ConfigForm = ReactComponent;

const FORMS: Readonly<Record<ComponentType, Readonly<Record<string, ConfigForm>>>> = {
  receiver: {
    awss3: AWSS3ReceiverForm,
    datadog: DatadogReceiverForm,
    docker_stats: DockerStatsReceiverForm,
    filelog: FilelogReceiverForm,
    fluentforward: FluentForwardReceiverForm,
    hostmetrics: HostmetricsReceiverForm,
    jaeger: JaegerReceiverForm,
    journald: JournaldReceiverForm,
    k8s_cluster: K8sClusterReceiverForm,
    k8s_events: K8sEventsReceiverForm,
    k8sobjects: K8sObjectsReceiverForm,
    kubeletstats: KubeletStatsReceiverForm,
    netflow: NetflowReceiverForm,
    otlp: OTLPReceiverForm,
    prometheus: PrometheusReceiverForm,
    statsd: StatsdReceiverForm,
    syslog: SyslogReceiverForm,
    zipkin: ZipkinReceiverForm,
  },
  processor: {
    attributes: AttributesProcessorForm,
    batch: BatchProcessorForm,
    cumulativetodelta: CumulativeToDeltaProcessorForm,
    filter: FilterProcessorForm,
    groupbyattrs: GroupByAttrsProcessorForm,
    k8sattributes: K8sAttributesProcessorForm,
    logdedup: LogDedupProcessorForm,
    memory_limiter: MemoryLimiterForm,
    metricstransform: MetricsTransformProcessorForm,
    probabilistic_sampler: ProbabilisticSamplerForm,
    redaction: RedactionProcessorForm,
    resource: ResourceProcessorForm,
    resourcedetection: ResourceDetectionProcessorForm,
    span: SpanProcessorForm,
    tail_sampling: TailSamplingForm,
    transform: TransformProcessorForm,
  },
  exporter: {
    awss3: AWSS3ExporterForm,
    clickhouse: ClickhouseExporterForm,
    datadog: DatadogExporterForm,
    debug: DebugExporterForm,
    file: FileExporterForm,
    loadbalancing: LoadBalancingExporterForm,
    otlp: OTLPExporterForm,
    otlphttp: OTLPHTTPExporterForm,
    prometheus: PrometheusExporterForm,
    prometheusremotewrite: PrometheusRemoteWriteExporterForm,
    zipkin: ZipkinExporterForm,
  },
  connector: {
    failover: FailoverConnectorForm,
    forward: ForwardConnectorForm,
    routing: RoutingConnectorForm,
    spanmetrics: SpanmetricsConnectorForm,
  },
  extension: {
    bearertokenauth: BearerTokenAuthExtensionForm,
    file_storage: FileStorageExtensionForm,
    health_check: HealthCheckForm,
    oidc: OIDCAuthExtensionForm,
    opamp: OpAMPExtensionForm,
    pprof: PprofForm,
    zpages: ZPagesForm,
  },
};

/** The form for a component of `type` whose sub-type is `subType` (either spelling), if it has one. */
export function formFor(type: ComponentType, subType: string): ConfigForm | undefined {
  const forms = FORMS[type];
  const palette = paletteSubType(subType, type);
  return Object.hasOwn(forms, palette) ? forms[palette] : undefined;
}
