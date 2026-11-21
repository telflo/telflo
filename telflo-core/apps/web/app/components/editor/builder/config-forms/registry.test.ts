import { describe, expect, it } from "vitest";

import { AttributesProcessorForm } from "./AttributesProcessorForm.js";
import { AWSS3ExporterForm } from "./AWSS3ExporterForm.js";
import { AWSS3ReceiverForm } from "./AWSS3ReceiverForm.js";
import { BatchProcessorForm } from "./BatchProcessorForm.js";
import { BasicAuthExtensionForm } from "./BasicAuthExtensionForm.js";
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
import { formFor, type ConfigForm } from "./registry.js";
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
import { findPaletteEntry } from "~/lib/graph/palette.js";
import { RENAMED_TYPES } from "~/lib/collector/renamed-types.js";
import { paletteSubType } from "~/lib/graph/parse.js";
import { COMPONENT_TYPES, type ComponentType } from "~/lib/graph/types.js";

/*
 * The form dispatch: by the component's type and its palette sub-type.
 * `otlp` is both a receiver's and an exporter's, each with its own form.
 */

const FORMS: readonly (readonly [ComponentType, string, ConfigForm])[] = [
  ["receiver", "otlp", OTLPReceiverForm],
  ["receiver", "k8s_cluster", K8sClusterReceiverForm],
  ["receiver", "k8s_events", K8sEventsReceiverForm],
  ["receiver", "k8sobjects", K8sObjectsReceiverForm],
  ["receiver", "kubeletstats", KubeletStatsReceiverForm],
  ["receiver", "hostmetrics", HostmetricsReceiverForm],
  ["receiver", "docker_stats", DockerStatsReceiverForm],
  ["receiver", "filelog", FilelogReceiverForm],
  ["receiver", "journald", JournaldReceiverForm],
  ["receiver", "syslog", SyslogReceiverForm],
  ["receiver", "fluentforward", FluentForwardReceiverForm],
  ["receiver", "netflow", NetflowReceiverForm],
  ["receiver", "prometheus", PrometheusReceiverForm],
  ["receiver", "statsd", StatsdReceiverForm],
  ["receiver", "jaeger", JaegerReceiverForm],
  ["receiver", "zipkin", ZipkinReceiverForm],
  ["receiver", "datadog", DatadogReceiverForm],
  ["receiver", "awss3", AWSS3ReceiverForm],
  ["processor", "attributes", AttributesProcessorForm],
  ["processor", "batch", BatchProcessorForm],
  ["processor", "cumulativetodelta", CumulativeToDeltaProcessorForm],
  ["processor", "groupbyattrs", GroupByAttrsProcessorForm],
  ["processor", "metricstransform", MetricsTransformProcessorForm],
  ["processor", "filter", FilterProcessorForm],
  ["processor", "k8sattributes", K8sAttributesProcessorForm],
  ["processor", "memory_limiter", MemoryLimiterForm],
  ["processor", "resource", ResourceProcessorForm],
  ["processor", "resourcedetection", ResourceDetectionProcessorForm],
  ["processor", "probabilistic_sampler", ProbabilisticSamplerForm],
  ["processor", "span", SpanProcessorForm],
  ["processor", "tail_sampling", TailSamplingForm],
  ["processor", "transform", TransformProcessorForm],
  ["processor", "logdedup", LogDedupProcessorForm],
  ["processor", "redaction", RedactionProcessorForm],
  ["exporter", "debug", DebugExporterForm],
  ["exporter", "otlp", OTLPExporterForm],
  ["exporter", "otlphttp", OTLPHTTPExporterForm],
  ["exporter", "loadbalancing", LoadBalancingExporterForm],
  ["exporter", "prometheus", PrometheusExporterForm],
  ["exporter", "prometheusremotewrite", PrometheusRemoteWriteExporterForm],
  ["exporter", "zipkin", ZipkinExporterForm],
  ["exporter", "datadog", DatadogExporterForm],
  ["exporter", "awss3", AWSS3ExporterForm],
  ["exporter", "clickhouse", ClickhouseExporterForm],
  ["exporter", "file", FileExporterForm],
  ["connector", "forward", ForwardConnectorForm],
  ["connector", "routing", RoutingConnectorForm],
  ["connector", "failover", FailoverConnectorForm],
  ["connector", "spanmetrics", SpanmetricsConnectorForm],
  ["extension", "basicauth", BasicAuthExtensionForm],
  ["extension", "bearertokenauth", BearerTokenAuthExtensionForm],
  ["extension", "file_storage", FileStorageExtensionForm],
  ["extension", "health_check", HealthCheckForm],
  ["extension", "oidc", OIDCAuthExtensionForm],
  ["extension", "opamp", OpAMPExtensionForm],
  ["extension", "pprof", PprofForm],
  ["extension", "zpages", ZPagesForm],
];

describe("formFor", () => {
  it.each(FORMS)("gives a %s %s its form", (type, subType, form) => {
    expect(formFor(type, subType)).toBe(form);
    // Every form is a palette entry's.
    expect(findPaletteEntry(type, subType)).toBeDefined();
  });

  it.each(FORMS)(
    "gives only a %s its %s form: the other types of that name keep the fallback, or have their own",
    (type, subType, form) => {
      for (const other of COMPONENT_TYPES.filter((t) => t !== type)) {
        const own = FORMS.find(([t, s]) => t === other && s === subType)?.[2];
        expect(formFor(other, subType)).toBe(own);
        expect(formFor(other, subType)).not.toBe(form);
      }
    },
  );

  it("gives the OTLP receiver and the OTLP gRPC exporter each its own form, and otlp_grpc / otlp_http the exporters'", () => {
    expect(formFor("receiver", "otlp")).toBe(OTLPReceiverForm);
    expect(formFor("exporter", "otlp")).toBe(OTLPExporterForm);
    expect(formFor("exporter", "otlp_grpc")).toBe(OTLPExporterForm);
    expect(formFor("exporter", "otlp_http")).toBe(OTLPHTTPExporterForm);
    expect(formFor("receiver", "otlphttp")).toBeUndefined();
  });

  it("gives the prometheus receiver and exporter each its own form, and prometheus_remote_write the remote write form", () => {
    expect(formFor("receiver", "prometheus")).toBe(PrometheusReceiverForm);
    expect(formFor("exporter", "prometheus")).toBe(PrometheusExporterForm);
    // exporter/prometheusremotewriteexporter/metadata.yaml:2-3 (v0.162.0): `prometheus_remote_write` is the current type.
    expect(RENAMED_TYPES.exporter.prometheus_remote_write).toBe("prometheusremotewrite");
    expect(formFor("exporter", "prometheus_remote_write")).toBe(PrometheusRemoteWriteExporterForm);
    expect(formFor("exporter", "prometheusremotewrite")).toBe(PrometheusRemoteWriteExporterForm);
    expect(formFor("receiver", "prometheusremotewrite")).toBeUndefined();
  });

  it("gives statsd, cumulativetodelta, metricstransform and groupbyattrs their forms, and the collector's cumulative_to_delta and metrics_transform the palette's", () => {
    expect(formFor("receiver", "statsd")).toBe(StatsdReceiverForm);
    expect(formFor("processor", "statsd")).toBeUndefined();
    // processor/cumulativetodeltaprocessor/metadata.yaml:2-3 and processor/metricstransformprocessor/metadata.yaml:2-3 (v0.162.0): the current types.
    expect(RENAMED_TYPES.processor.cumulative_to_delta).toBe("cumulativetodelta");
    expect(RENAMED_TYPES.processor.metrics_transform).toBe("metricstransform");
    expect(formFor("processor", "cumulative_to_delta")).toBe(CumulativeToDeltaProcessorForm);
    expect(formFor("processor", "cumulativetodelta")).toBe(CumulativeToDeltaProcessorForm);
    expect(formFor("processor", "metrics_transform")).toBe(MetricsTransformProcessorForm);
    expect(formFor("processor", "metricstransform")).toBe(MetricsTransformProcessorForm);
    expect(formFor("processor", "groupbyattrs")).toBe(GroupByAttrsProcessorForm);
    expect(findPaletteEntry("processor", paletteSubType("cumulative_to_delta", "processor"))?.subType).toBe("cumulativetodelta");
    expect(findPaletteEntry("processor", paletteSubType("metrics_transform", "processor"))?.subType).toBe("metricstransform");
  });

  it("gives jaeger, zipkin, probabilistic_sampler, span and spanmetrics their forms, the zipkin receiver and exporter each its own, and the collector's span_metrics the palette's", () => {
    expect(formFor("receiver", "jaeger")).toBe(JaegerReceiverForm);
    expect(formFor("receiver", "zipkin")).toBe(ZipkinReceiverForm);
    expect(formFor("exporter", "zipkin")).toBe(ZipkinExporterForm);
    expect(formFor("processor", "probabilistic_sampler")).toBe(ProbabilisticSamplerForm);
    expect(formFor("processor", "span")).toBe(SpanProcessorForm);
    expect(formFor("connector", "spanmetrics")).toBe(SpanmetricsConnectorForm);
    // connector/spanmetricsconnector/metadata.yaml:1-2 (v0.162.0): `type: span_metrics`, `deprecated_type: spanmetrics`.
    expect(RENAMED_TYPES.connector.span_metrics).toBe("spanmetrics");
    expect(formFor("connector", "span_metrics")).toBe(SpanmetricsConnectorForm);
    expect(findPaletteEntry("connector", paletteSubType("span_metrics", "connector"))?.subType).toBe("spanmetrics");
    expect(formFor("processor", "spanmetrics")).toBeUndefined();
    expect(formFor("connector", "span")).toBeUndefined();
  });

  it("gives transform and logdedup their forms, and the collector's log_dedup the palette's", () => {
    expect(formFor("processor", "transform")).toBe(TransformProcessorForm);
    expect(formFor("processor", "logdedup")).toBe(LogDedupProcessorForm);
    // processor/logdedupprocessor/metadata.yaml:2-3 (v0.162.0): `type: log_dedup`, `deprecated_type: logdedup`.
    expect(RENAMED_TYPES.processor.log_dedup).toBe("logdedup");
    expect(formFor("processor", "log_dedup")).toBe(LogDedupProcessorForm);
    expect(findPaletteEntry("processor", paletteSubType("log_dedup", "processor"))?.subType).toBe("logdedup");
    expect(formFor("connector", "transform")).toBeUndefined();
    expect(formFor("exporter", "log_dedup")).toBeUndefined();
  });

  it("gives redaction its form; the collector's type is redaction, not renamed (metadata.yaml:2)", () => {
    expect(formFor("processor", "redaction")).toBe(RedactionProcessorForm);
    expect(paletteSubType("redaction", "processor")).toBe("redaction");
    expect(formFor("exporter", "redaction")).toBeUndefined();
  });

  it("gives the datadog receiver and exporter each its own form; neither is renamed (the exporter's metadata.yaml:1, the receiver's :2)", () => {
    expect(formFor("receiver", "datadog")).toBe(DatadogReceiverForm);
    expect(formFor("exporter", "datadog")).toBe(DatadogExporterForm);
    expect(DatadogReceiverForm).not.toBe(DatadogExporterForm);
    expect(paletteSubType("datadog", "receiver")).toBe("datadog");
    expect(paletteSubType("datadog", "exporter")).toBe("datadog");
    expect(formFor("processor", "datadog")).toBeUndefined();
    expect(formFor("connector", "datadog")).toBeUndefined();
  });

  it("gives the S3 receiver and exporter each its own form, and the receiver's aws_s3 spelling the receiver's (receiver/awss3receiver/metadata.yaml:2-3, exporter/awss3exporter/metadata.yaml:1)", () => {
    expect(formFor("receiver", "awss3")).toBe(AWSS3ReceiverForm);
    expect(formFor("exporter", "awss3")).toBe(AWSS3ExporterForm);
    expect(formFor("receiver", "awss3")).not.toBe(formFor("exporter", "awss3"));
    expect(formFor("receiver", "aws_s3")).toBe(AWSS3ReceiverForm);
    // The rename is the receiver's only: an exporter spelled aws_s3, which the collector refuses, has no form.
    expect(paletteSubType("aws_s3", "receiver")).toBe("awss3");
    expect(paletteSubType("aws_s3", "exporter")).toBe("aws_s3");
    expect(formFor("exporter", "aws_s3")).toBeUndefined();
  });

  it("gives clickhouse and file their exporter forms; neither is renamed (metadata.yaml:1 each)", () => {
    expect(formFor("exporter", "clickhouse")).toBe(ClickhouseExporterForm);
    expect(formFor("exporter", "file")).toBe(FileExporterForm);
    expect(paletteSubType("clickhouse", "exporter")).toBe("clickhouse");
    expect(paletteSubType("file", "exporter")).toBe("file");
    expect(formFor("receiver", "file")).toBeUndefined();
  });

  it("gives the memory_limiter extension no form: the processor's isn't its", () => {
    expect(findPaletteEntry("extension", "memory_limiter")).toBeDefined();
    expect(formFor("extension", "memory_limiter")).toBeUndefined();
    expect(formFor("processor", "memory_limiter")).toBe(MemoryLimiterForm);
  });

  it("resolves a renamed spelling to its palette spelling's form in its own kind, for every renamed type, otlp_http included; another kind so spelled has none", () => {
    expect(RENAMED_TYPES.exporter.otlp_http).toBe("otlphttp");
    let renames = 0;
    for (const kind of COMPONENT_TYPES) {
      for (const [spelled, palette] of Object.entries(RENAMED_TYPES[kind])) {
        renames += 1;
        expect(formFor(kind, spelled)).toBe(formFor(kind, palette));
        // Every rename is kind-specific: an
        // `otlp_grpc` receiver or an `aws_s3` exporter is a type the collector doesn't have, so no form.
        for (const other of COMPONENT_TYPES.filter((type) => type !== kind)) {
          if (!Object.hasOwn(RENAMED_TYPES[other], spelled)) expect(formFor(other, spelled)).toBeUndefined();
        }
      }
    }
    expect(renames).toBeGreaterThan(0);
    expect(formFor("receiver", "otlp_grpc")).toBeUndefined();
    expect(formFor("receiver", "otlp")).toBe(OTLPReceiverForm);
  });

  it("gives a component without a form, or an unknown one, none", () => {
    // `count`, outside the palette, keeps the fallback.
    expect(formFor("processor", "count")).toBeUndefined();
    expect(formFor("receiver", "count")).toBeUndefined();
    expect(formFor("exporter", "no_such_exporter")).toBeUndefined();
    // Nothing inherited reads as a form.
    expect(formFor("processor", "constructor")).toBeUndefined();
    expect(formFor("extension", "__proto__")).toBeUndefined();
  });
});

/*
 * The Kubernetes, host and logs components' 13 forms are in `FORMS` above,
 * under their palette types. The collector's current names of three of them
 * (each a `deprecated_type` at v0.162.0) resolve to the palette's, and so to
 * its form.
 */
const D9C_TYPES: readonly (readonly [ComponentType, string])[] = [
  ["receiver", "k8s_cluster"],
  ["receiver", "k8s_events"],
  ["receiver", "k8sobjects"],
  ["receiver", "kubeletstats"],
  ["processor", "k8sattributes"],
  ["processor", "resourcedetection"],
  ["receiver", "hostmetrics"],
  ["receiver", "docker_stats"],
  ["receiver", "filelog"],
  ["receiver", "journald"],
  ["receiver", "syslog"],
  ["receiver", "fluentforward"],
  ["receiver", "netflow"],
];

describe("the Kubernetes, host and logs components' forms", () => {
  it.each(D9C_TYPES)("a %s %s is a palette entry, and its form is the one FORMS names", (type, subType) => {
    expect(findPaletteEntry(type, subType)).toBeDefined();
    const form = FORMS.find(([t, s]) => t === type && s === subType)?.[2];
    expect(form).toBeDefined();
    expect(formFor(type, subType)).toBe(form);
  });

  it.each([
    ["k8s_objects", "k8sobjects"],
    ["kubelet_stats", "kubeletstats"],
    ["host_metrics", "hostmetrics"],
  ])("resolves the collector's %s to the palette's %s: its entry and its form", (spelled, palette) => {
    expect(RENAMED_TYPES.receiver[spelled]).toBe(palette);
    expect(findPaletteEntry("receiver", paletteSubType(spelled, "receiver"))?.subType).toBe(palette);
    expect(formFor("receiver", spelled)).toBe(formFor("receiver", palette));
  });

  it("gives the collector's k8s_objects and kubelet_stats the Kubernetes forms", () => {
    expect(formFor("receiver", "k8s_objects")).toBe(K8sObjectsReceiverForm);
    expect(formFor("receiver", "kubelet_stats")).toBe(KubeletStatsReceiverForm);
    expect(formFor("receiver", "k8sobjects")).toBe(K8sObjectsReceiverForm);
    expect(formFor("receiver", "kubeletstats")).toBe(KubeletStatsReceiverForm);
  });

  it("gives the collector's host_metrics the Hostmetrics form, and docker_stats its form", () => {
    expect(formFor("receiver", "host_metrics")).toBe(HostmetricsReceiverForm);
    expect(formFor("receiver", "hostmetrics")).toBe(HostmetricsReceiverForm);
    expect(formFor("receiver", "docker_stats")).toBe(DockerStatsReceiverForm);
  });

  // receiver/filelogreceiver/metadata.yaml:2-3 and fluentforwardreceiver/metadata.yaml:2-3 (v0.162.0):
  // `file_log` and `fluent_forward` are the current types, the palette's their deprecated aliases.
  it("gives the collector's file_log and fluent_forward the logs receivers' forms", () => {
    expect(formFor("receiver", "file_log")).toBe(FilelogReceiverForm);
    expect(formFor("receiver", "fluent_forward")).toBe(FluentForwardReceiverForm);
    expect(formFor("receiver", "filelog")).toBe(FilelogReceiverForm);
    expect(formFor("receiver", "fluentforward")).toBe(FluentForwardReceiverForm);
    expect(formFor("receiver", "journald")).toBe(JournaldReceiverForm);
    expect(formFor("receiver", "syslog")).toBe(SyslogReceiverForm);
    expect(formFor("receiver", "netflow")).toBe(NetflowReceiverForm);
  });

  it("gives the collector's k8s_attributes and resource_detection the processors' forms", () => {
    expect(formFor("processor", "k8s_attributes")).toBe(K8sAttributesProcessorForm);
    expect(formFor("processor", "resource_detection")).toBe(ResourceDetectionProcessorForm);
    expect(formFor("processor", "k8sattributes")).toBe(K8sAttributesProcessorForm);
    expect(formFor("processor", "resourcedetection")).toBe(ResourceDetectionProcessorForm);
  });
});
