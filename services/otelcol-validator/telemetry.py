"""OpenTelemetry self-instrumentation bootstrap for the collector validator.

The service-specific choices (service name, excluded health URL, whether to
instrument httpx) are arguments to :func:`setup_telemetry`, so another Python
service can copy the file unchanged.

Design rules:

* **No-op gate.** If ``OTEL_EXPORTER_OTLP_ENDPOINT`` is unset/empty we return
  immediately — no providers, no exporters, no background threads, no wrappers.
  The SDK otherwise defaults the endpoint to ``localhost:4317`` and spams
  connection errors forever. This keeps ``uvicorn --reload``, ``pytest``, and CI
  completely untouched unless an endpoint is explicitly configured.

Transport is OTLP over **gRPC** (port 4317). ``insecure`` is derived from the
endpoint scheme: ``http://`` → plaintext, ``https://`` → TLS.

* **Golden signals come from the collector, not the SDK.** RED/latency metrics
  are synthesized by the collector's ``spanmetrics`` connector from spans, so we
  actively *suppress* SDK-emitted ``http.server.*`` / ``http.client.*`` metrics
  (belt: a MeterProvider drop-View; braces: a NoOp meter on the HTTP
  instrumentors). Runtime/process metrics (CPU, memory, GC) are the metrics we
  keep.

* **Logs correlate automatically.** The contrib ``LoggingHandler`` (from
  ``opentelemetry-instrumentation-logging``; the ``opentelemetry-sdk`` one is
  deprecated) stamps the active span's ``trace_id`` / ``span_id`` onto each
  exported log record. Console output is preserved because we attach *after* the
  app has run ``logging.basicConfig``.
"""

from __future__ import annotations

import atexit
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# Guards against double-initialization when uvicorn --reload re-imports the app
# module (a second HTTPXClientInstrumentor().instrument() would warn/raise).
_STATE: dict[str, bool] = {"initialized": False}


def setup_telemetry(
    app: Any,
    *,
    default_service_name: str,
    excluded_urls: str,
    instrument_httpx: bool = False,
) -> None:
    """Initialize OTel tracing, metrics, and logs for a FastAPI app.

    Args:
        app: The FastAPI/Starlette application instance to instrument.
        default_service_name: Fallback ``service.name`` when ``OTEL_SERVICE_NAME``
            is not set in the environment.
        excluded_urls: Comma-separated regexes (``re.search`` against the full
            URL) of routes to leave untraced — the health endpoint hit every
            ~10-30s by Docker/DO probes.
        instrument_httpx: Instrument outbound httpx calls (client spans +
            ``traceparent`` propagation). Enable for a service that makes
            outbound HTTP calls (the validator makes none).
    """
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    if not endpoint:
        return  # the no-op gate — nothing is imported or started
    if _STATE["initialized"]:
        return
    _STATE["initialized"] = True

    from urllib.parse import urlparse

    # Imports live inside the gate so that unconfigured environments (tests, CI,
    # `uvicorn --reload` dev) never even load the SDK.
    from opentelemetry import metrics, trace
    from opentelemetry._logs import set_logger_provider
    from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
    from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
        OTLPMetricExporter,
    )
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.logging.handler import LoggingHandler
    from opentelemetry.instrumentation.system_metrics import SystemMetricsInstrumentor
    from opentelemetry.metrics import NoOpMeterProvider
    from opentelemetry.sdk._logs import LoggerProvider
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.metrics.view import DropAggregation, View
    from opentelemetry.sdk.resources import SERVICE_NAME, Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    # Silence the SDK's own logger from feeding the export→log→export loop: an
    # export failure must not emit a record that is itself exported.
    logging.getLogger("opentelemetry").setLevel(logging.WARNING)

    # service.name: an explicitly-passed default, which OTEL_SERVICE_NAME (via
    # the SDK's env resource detector) overrides when set. OTEL_RESOURCE_ATTRIBUTES
    # (deployment.environment, service.namespace, ...) is merged in automatically.
    resource = Resource.create({SERVICE_NAME: default_service_name})

    # The exporters read OTEL_EXPORTER_OTLP_ENDPOINT from env; we only derive
    # transport security from its scheme (http:// = plaintext, https:// = TLS)
    # and pass it explicitly so the choice does not depend on env-var defaults.
    insecure = urlparse(endpoint).scheme != "https"

    # --- Traces ---
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(insecure=insecure))
    )
    trace.set_tracer_provider(tracer_provider)

    # --- Metrics (runtime/process only; HTTP metrics dropped) ---
    drop_http_metrics = [
        View(instrument_name="http.server.*", aggregation=DropAggregation()),
        View(instrument_name="http.client.*", aggregation=DropAggregation()),
    ]
    meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[
            PeriodicExportingMetricReader(OTLPMetricExporter(insecure=insecure))
        ],
        views=drop_http_metrics,
    )
    metrics.set_meter_provider(meter_provider)
    # gVisor bug google/gvisor#12755 makes /proc/<pid>/io report a truncated
    # 'char' field instead of 'rchar', so psutil.io_counters() — and thus the
    # process.disk.io instrument callback — raises every collection cycle and
    # spams ERROR logs (DigitalOcean App Platform sandboxes with gVisor). Probe
    # once: keep the full default metric set where io_counters works, and drop
    # ONLY process.disk.io where it doesn't. Self-heals — the metric returns
    # automatically once the runtime's gVisor is patched. Defensive on the
    # private-constant import so telemetry setup can never crash the app.
    system_metrics_config = None  # None => SystemMetricsInstrumentor default set
    try:
        import psutil

        psutil.Process().io_counters()  # same read the process.disk.io callback makes
    except Exception:  # malformed /proc/<pid>/io on this runtime
        try:
            from opentelemetry.instrumentation.system_metrics import _DEFAULT_CONFIG

            system_metrics_config = dict(_DEFAULT_CONFIG)
            system_metrics_config.pop("process.disk.io", None)
        except ImportError:
            system_metrics_config = None  # fall back to default set; noise persists

    SystemMetricsInstrumentor(config=system_metrics_config).instrument(
        meter_provider=meter_provider
    )

    # --- Logs (exported over OTLP, correlated to the active span) ---
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter(insecure=insecure))
    )
    set_logger_provider(logger_provider)
    # Attach alongside the existing console handler installed by basicConfig.
    logging.getLogger().addHandler(
        LoggingHandler(level=logging.INFO, logger_provider=logger_provider)
    )

    # --- Auto-instrumentation ---
    # NoOp meter on the HTTP instrumentors so their duration/count metrics never
    # exist (spanmetrics owns those); their spans still flow to the real tracer.
    noop_meter_provider = NoOpMeterProvider()
    FastAPIInstrumentor.instrument_app(
        app,
        excluded_urls=excluded_urls,
        meter_provider=noop_meter_provider,
    )
    if instrument_httpx:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument(meter_provider=noop_meter_provider)
        # Once httpx is traced, its per-request INFO lines ("HTTP Request: ...")
        # are redundant with the client spans — quiet them so they don't also
        # ship as log records.
        logging.getLogger("httpx").setLevel(logging.WARNING)

    # Flush the final batch on normal interpreter exit.
    atexit.register(tracer_provider.shutdown)
    atexit.register(meter_provider.shutdown)
    atexit.register(logger_provider.shutdown)

    logger.info(
        "OpenTelemetry initialized (service=%s, endpoint=%s)",
        os.getenv("OTEL_SERVICE_NAME", default_service_name),
        endpoint,
    )
