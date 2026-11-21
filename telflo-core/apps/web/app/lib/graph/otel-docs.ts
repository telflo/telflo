import type { ComponentType } from "./types.js";

/* Official README for each component, split across the two collector repos.
 * Keyed `${type}/${subType}` because a subtype can exist as both a receiver
 * and an exporter (otlp, zipkin, datadog). */

const CORE =
  "https://github.com/open-telemetry/opentelemetry-collector/tree/main";
const CONTRIB =
  "https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main";

const DOCS_URLS: Record<string, string> = {
  // Receivers
  "receiver/otlp": `${CORE}/receiver/otlpreceiver`,
  "receiver/prometheus": `${CONTRIB}/receiver/prometheusreceiver`,
  "receiver/fluentforward": `${CONTRIB}/receiver/fluentforwardreceiver`,
  "receiver/docker_stats": `${CONTRIB}/receiver/dockerstatsreceiver`,
  "receiver/filelog": `${CONTRIB}/receiver/filelogreceiver`,
  "receiver/hostmetrics": `${CONTRIB}/receiver/hostmetricsreceiver`,
  "receiver/jaeger": `${CONTRIB}/receiver/jaegerreceiver`,
  "receiver/zipkin": `${CONTRIB}/receiver/zipkinreceiver`,
  "receiver/datadog": `${CONTRIB}/receiver/datadogreceiver`,
  "receiver/k8s_cluster": `${CONTRIB}/receiver/k8sclusterreceiver`,
  "receiver/k8s_events": `${CONTRIB}/receiver/k8seventsreceiver`,
  "receiver/k8sobjects": `${CONTRIB}/receiver/k8sobjectsreceiver`,
  "receiver/kubeletstats": `${CONTRIB}/receiver/kubeletstatsreceiver`,
  "receiver/journald": `${CONTRIB}/receiver/journaldreceiver`,
  "receiver/netflow": `${CONTRIB}/receiver/netflowreceiver`,
  "receiver/syslog": `${CONTRIB}/receiver/syslogreceiver`,
  "receiver/statsd": `${CONTRIB}/receiver/statsdreceiver`,
  "receiver/awss3": `${CONTRIB}/receiver/awss3receiver`,

  // Processors
  "processor/batch": `${CORE}/processor/batchprocessor`,
  "processor/memory_limiter": `${CORE}/processor/memorylimiterprocessor`,
  "processor/resource": `${CONTRIB}/processor/resourceprocessor`,
  "processor/attributes": `${CONTRIB}/processor/attributesprocessor`,
  "processor/filter": `${CONTRIB}/processor/filterprocessor`,
  "processor/probabilistic_sampler": `${CONTRIB}/processor/probabilisticsamplerprocessor`,
  "processor/tail_sampling": `${CONTRIB}/processor/tailsamplingprocessor`,
  "processor/k8sattributes": `${CONTRIB}/processor/k8sattributesprocessor`,
  "processor/redaction": `${CONTRIB}/processor/redactionprocessor`,
  "processor/cumulativetodelta": `${CONTRIB}/processor/cumulativetodeltaprocessor`,
  "processor/resourcedetection": `${CONTRIB}/processor/resourcedetectionprocessor`,
  "processor/transform": `${CONTRIB}/processor/transformprocessor`,
  "processor/logdedup": `${CONTRIB}/processor/logdedupprocessor`,
  "processor/span": `${CONTRIB}/processor/spanprocessor`,
  "processor/groupbyattrs": `${CONTRIB}/processor/groupbyattrsprocessor`,
  "extension/opamp": `${CONTRIB}/extension/opampextension`,
  "extension/bearertokenauth": `${CONTRIB}/extension/bearertokenauthextension`,
  "extension/oidc": `${CONTRIB}/extension/oidcauthextension`,
  "extension/basicauth": `${CONTRIB}/extension/basicauthextension`,
  "extension/memory_limiter": `${CORE}/extension/memorylimiterextension`,
  "processor/metricstransform": `${CONTRIB}/processor/metricstransformprocessor`,

  // Exporters
  "exporter/otlp": `${CORE}/exporter/otlpexporter`,
  "exporter/otlphttp": `${CORE}/exporter/otlphttpexporter`,
  "exporter/debug": `${CORE}/exporter/debugexporter`,
  "exporter/loadbalancing": `${CONTRIB}/exporter/loadbalancingexporter`,
  "exporter/zipkin": `${CONTRIB}/exporter/zipkinexporter`,
  "exporter/prometheus": `${CONTRIB}/exporter/prometheusexporter`,
  "exporter/prometheusremotewrite": `${CONTRIB}/exporter/prometheusremotewriteexporter`,
  "exporter/datadog": `${CONTRIB}/exporter/datadogexporter`,
  "exporter/clickhouse": `${CONTRIB}/exporter/clickhouseexporter`,
  "exporter/file": `${CONTRIB}/exporter/fileexporter`,
  "exporter/awss3": `${CONTRIB}/exporter/awss3exporter`,

  // Extensions
  "extension/health_check": `${CONTRIB}/extension/healthcheckextension`,
  "extension/pprof": `${CONTRIB}/extension/pprofextension`,
  "extension/zpages": `${CORE}/extension/zpagesextension`,
  "extension/file_storage": `${CONTRIB}/extension/storage/filestorage`,

  // Connectors
  "connector/spanmetrics": `${CONTRIB}/connector/spanmetricsconnector`,
  "connector/forward": `${CORE}/connector/forwardconnector`,
  "connector/routing": `${CONTRIB}/connector/routingconnector`,
  "connector/failover": `${CONTRIB}/connector/failoverconnector`,
};

export function getComponentDocsUrl(
  type: ComponentType,
  subType: string,
): string | null {
  return DOCS_URLS[`${type}/${subType}`] ?? null;
}
