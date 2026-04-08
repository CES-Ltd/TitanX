/**
 * @license Apache-2.0
 * OpenTelemetry configuration types for TitanX observability.
 */

/** Telemetry exporter type */
export type TelemetryExporterType = 'otlp' | 'console' | 'none';

/** OTLP protocol type */
export type OtlpProtocol = 'http/protobuf' | 'grpc';

/** Log verbosity level */
export type TelemetryLogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

/** Full telemetry configuration */
export type TelemetryConfig = {
  /** Master toggle for all telemetry */
  enabled: boolean;
  /** Service name reported in traces/metrics */
  serviceName: string;
  /** Exporter backend */
  exporterType: TelemetryExporterType;
  /** OTLP collector endpoint (e.g., http://localhost:4318) */
  otlpEndpoint?: string;
  /** OTLP transport protocol */
  otlpProtocol: OtlpProtocol;
  /** Minimum log level to export */
  logLevel: TelemetryLogLevel;
  /** Trace sampling rate (0.0 - 1.0) */
  sampleRate: number;
  /** Enable distributed traces */
  enableTraces: boolean;
  /** Enable metrics collection */
  enableMetrics: boolean;
};

/** Default telemetry configuration */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: false,
  serviceName: 'titanx',
  exporterType: 'none',
  otlpEndpoint: 'http://localhost:4318',
  otlpProtocol: 'http/protobuf',
  logLevel: 'info',
  sampleRate: 1.0,
  enableTraces: true,
  enableMetrics: true,
};
