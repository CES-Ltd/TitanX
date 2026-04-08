/**
 * @license Apache-2.0
 * OpenTelemetry integration for TitanX.
 * Provides configurable tracing and metrics export to OTLP collectors,
 * console, or disabled mode. All instrumentation is opt-in via settings.
 *
 * OTel packages are dynamically imported — the app runs fine without them.
 * Install @opentelemetry/* packages to enable full telemetry.
 */

import type { TelemetryConfig } from './types';
import { DEFAULT_TELEMETRY_CONFIG } from './types';

// ── Lightweight span/metric interfaces (no OTel compile-time dependency) ─────

/** A lightweight span that works with or without the OTel SDK */
export type TitanSpan = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(code: 'ok' | 'error', message?: string): void;
  end(): void;
};

/** Counter metric */
export type TitanCounter = {
  add(value: number, attributes?: Record<string, string | number>): void;
};

/** Histogram metric */
export type TitanHistogram = {
  record(value: number, attributes?: Record<string, string | number>): void;
};

// ── No-op implementations (used when telemetry is disabled) ──────────────────

const noopSpan: TitanSpan = {
  setAttribute: () => {},
  setStatus: () => {},
  end: () => {},
};

const noopCounter: TitanCounter = { add: () => {} };
const noopHistogram: TitanHistogram = { record: () => {} };

// ── Internal state ───────────────────────────────────────────────────────────

let currentConfig: TelemetryConfig = { ...DEFAULT_TELEMETRY_CONFIG };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sdkInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let otelApi: any = null;

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize OpenTelemetry with the given configuration.
 * Dynamically imports OTel packages only when enabled.
 */
export async function initTelemetry(config: TelemetryConfig): Promise<void> {
  currentConfig = { ...config };

  if (!config.enabled || config.exporterType === 'none') {
    console.log('[Telemetry] Disabled — no-op instrumentation active');
    return;
  }

  try {
    // Dynamic require — avoids compile-time dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const api = require('@opentelemetry/api');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Resource } = require('@opentelemetry/resources');

    otelApi = api;

    const resource = new Resource({ 'service.name': config.serviceName });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkConfig: Record<string, any> = { resource };

    if (config.enableTraces && config.exporterType === 'otlp' && config.otlpEndpoint) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
      sdkConfig.traceExporter = new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` });
    } else if (config.enableTraces && config.exporterType === 'console') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-node');
      sdkConfig.traceExporter = new ConsoleSpanExporter();
    }

    if (config.enableMetrics && config.exporterType === 'otlp' && config.otlpEndpoint) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
      sdkConfig.metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${config.otlpEndpoint}/v1/metrics` }),
        exportIntervalMillis: 30_000,
      });
    }

    const sdk = new NodeSDK(sdkConfig);
    sdk.start();
    sdkInstance = sdk;

    console.log(
      `[Telemetry] Initialized: exporter=${config.exporterType}, traces=${config.enableTraces}, metrics=${config.enableMetrics}, endpoint=${config.otlpEndpoint ?? 'none'}`
    );
  } catch (err) {
    console.warn('[Telemetry] Failed to initialize OpenTelemetry SDK:', err);
    console.warn('[Telemetry] Falling back to no-op. Install @opentelemetry packages to enable.');
    otelApi = null;
    sdkInstance = null;
  }
}

/** Shut down the OpenTelemetry SDK gracefully (flush pending exports). */
export async function shutdownTelemetry(): Promise<void> {
  if (sdkInstance?.shutdown) {
    await sdkInstance.shutdown();
    sdkInstance = null;
  }
  otelApi = null;
  console.log('[Telemetry] Shut down');
}

/** Restart telemetry with a new configuration. */
export async function restartTelemetry(config: TelemetryConfig): Promise<void> {
  await shutdownTelemetry();
  await initTelemetry(config);
}

// ── Tracing API ──────────────────────────────────────────────────────────────

/** Start a new span. Returns a no-op span if telemetry is disabled. */
export function startSpan(
  tracerName: string,
  spanName: string,
  attributes?: Record<string, string | number>
): TitanSpan {
  if (!otelApi || !currentConfig.enabled || !currentConfig.enableTraces) {
    return noopSpan;
  }

  try {
    const tracer = otelApi.trace.getTracer(tracerName);
    const span = tracer.startSpan(spanName);

    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
    }

    return {
      setAttribute: (key: string, value: string | number | boolean) => span.setAttribute(key, value),
      setStatus: (code: 'ok' | 'error', message?: string) => {
        span.setStatus({
          code: code === 'ok' ? otelApi.SpanStatusCode.OK : otelApi.SpanStatusCode.ERROR,
          message,
        });
      },
      end: () => span.end(),
    };
  } catch {
    return noopSpan;
  }
}

// ── Metrics API ──────────────────────────────────────────────────────────────

const counterCache = new Map<string, TitanCounter>();
const histogramCache = new Map<string, TitanHistogram>();

/** Get or create a counter metric. */
export function getCounter(meterName: string, counterName: string, description?: string): TitanCounter {
  if (!otelApi || !currentConfig.enabled || !currentConfig.enableMetrics) {
    return noopCounter;
  }

  const cacheKey = `${meterName}:${counterName}`;
  const cached = counterCache.get(cacheKey);
  if (cached) return cached;

  try {
    const meter = otelApi.metrics.getMeter(meterName);
    const counter = meter.createCounter(counterName, { description });
    const wrapped: TitanCounter = {
      add: (value, attributes) => counter.add(value, attributes),
    };
    counterCache.set(cacheKey, wrapped);
    return wrapped;
  } catch {
    return noopCounter;
  }
}

/** Get or create a histogram metric. */
export function getHistogram(meterName: string, histogramName: string, description?: string): TitanHistogram {
  if (!otelApi || !currentConfig.enabled || !currentConfig.enableMetrics) {
    return noopHistogram;
  }

  const cacheKey = `${meterName}:${histogramName}`;
  const cached = histogramCache.get(cacheKey);
  if (cached) return cached;

  try {
    const meter = otelApi.metrics.getMeter(meterName);
    const histogram = meter.createHistogram(histogramName, { description });
    const wrapped: TitanHistogram = {
      record: (value, attributes) => histogram.record(value, attributes),
    };
    histogramCache.set(cacheKey, wrapped);
    return wrapped;
  } catch {
    return noopHistogram;
  }
}

/** Get the current telemetry configuration. */
export function getTelemetryConfig(): TelemetryConfig {
  return { ...currentConfig };
}

export { DEFAULT_TELEMETRY_CONFIG } from './types';
export type { TelemetryConfig } from './types';
