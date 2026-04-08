/**
 * @license Apache-2.0
 * Observability settings — full-page route for OpenTelemetry configuration.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Switch, Select, Input, Slider, Button, Message, Typography } from '@arco-design/web-react';
import { telemetry, type ITelemetryConfig } from '@/common/adapter/ipcBridge';

const { Title } = Typography;

const DEFAULT_CONFIG: ITelemetryConfig = {
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

const Row: React.FC<{ label: string; description?: string; children: React.ReactNode }> = ({
  label,
  description,
  children,
}) => (
  <div className='flex items-center justify-between gap-24px py-12px'>
    <div className='flex-1'>
      <div className='text-14px text-2'>{label}</div>
      {description && <div className='text-12px text-t-tertiary mt-2px'>{description}</div>}
    </div>
    <div className='flex-shrink-0'>{children}</div>
  </div>
);

const ObservabilitySettings: React.FC = () => {
  const [config, setConfig] = useState<ITelemetryConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void telemetry.getConfig.invoke().then((cfg) => {
      if (cfg) setConfig(cfg);
    });
  }, []);

  const updateField = useCallback(<K extends keyof ITelemetryConfig>(key: K, value: ITelemetryConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await telemetry.setConfig.invoke(config);
      Message.success('Telemetry configuration saved and applied');
    } catch {
      Message.error('Failed to save telemetry configuration');
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handleTestConnection = useCallback(async () => {
    if (!config.otlpEndpoint) {
      Message.warning('Enter an OTLP endpoint URL first');
      return;
    }
    try {
      const response = await fetch(config.otlpEndpoint, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (response.ok || response.status === 405) {
        Message.success(`Connected to ${config.otlpEndpoint}`);
      } else {
        Message.warning(`Endpoint returned status ${response.status}`);
      }
    } catch {
      Message.error(`Cannot reach ${config.otlpEndpoint}`);
    }
  }, [config.otlpEndpoint]);

  return (
    <div className='p-6' style={{ maxWidth: 720 }}>
      <Title heading={5} className='mb-4'>
        OpenTelemetry
      </Title>
      <Card>
        <div className='text-12px text-t-tertiary mb-16px'>
          Export traces and metrics to external observability platforms (Jaeger, Grafana, Datadog, etc.) for monitoring
          agent operations, tool calls, and policy decisions.
        </div>

        <Row label='Enable Telemetry' description='Master toggle for all OpenTelemetry instrumentation'>
          <Switch checked={config.enabled} onChange={(val) => updateField('enabled', val)} />
        </Row>

        <Row label='Service Name' description='Reported in all traces and metrics'>
          <Input
            value={config.serviceName}
            onChange={(val) => updateField('serviceName', val)}
            style={{ width: 180 }}
            placeholder='titanx'
          />
        </Row>

        <Row label='Exporter Type' description='Where to send telemetry data'>
          <Select
            value={config.exporterType}
            onChange={(val) => updateField('exporterType', val as ITelemetryConfig['exporterType'])}
            style={{ width: 180 }}
            options={[
              { label: 'OTLP (Collector)', value: 'otlp' },
              { label: 'Console', value: 'console' },
              { label: 'None', value: 'none' },
            ]}
          />
        </Row>

        {config.exporterType === 'otlp' && (
          <>
            <Row label='OTLP Endpoint' description='Collector URL (e.g., http://localhost:4318)'>
              <div className='flex gap-8px'>
                <Input
                  value={config.otlpEndpoint ?? ''}
                  onChange={(val) => updateField('otlpEndpoint', val)}
                  style={{ width: 240 }}
                  placeholder='http://localhost:4318'
                />
                <Button size='small' onClick={handleTestConnection}>
                  Test
                </Button>
              </div>
            </Row>

            <Row label='Protocol' description='OTLP transport protocol'>
              <Select
                value={config.otlpProtocol}
                onChange={(val) => updateField('otlpProtocol', val as ITelemetryConfig['otlpProtocol'])}
                style={{ width: 180 }}
                options={[
                  { label: 'HTTP/Protobuf', value: 'http/protobuf' },
                  { label: 'gRPC', value: 'grpc' },
                ]}
              />
            </Row>
          </>
        )}

        <Row label='Log Level' description='Minimum severity level to export'>
          <Select
            value={config.logLevel}
            onChange={(val) => updateField('logLevel', val as ITelemetryConfig['logLevel'])}
            style={{ width: 180 }}
            options={[
              { label: 'None', value: 'none' },
              { label: 'Error', value: 'error' },
              { label: 'Warning', value: 'warn' },
              { label: 'Info', value: 'info' },
              { label: 'Debug', value: 'debug' },
            ]}
          />
        </Row>

        <Row label='Sample Rate' description={`${Math.round(config.sampleRate * 100)}% of traces sampled`}>
          <Slider
            value={config.sampleRate * 100}
            onChange={(val) => updateField('sampleRate', (val as number) / 100)}
            min={0}
            max={100}
            step={5}
            style={{ width: 180 }}
          />
        </Row>

        <Row label='Enable Traces' description='Distributed tracing for agent operations'>
          <Switch checked={config.enableTraces} onChange={(val) => updateField('enableTraces', val)} />
        </Row>

        <Row label='Enable Metrics' description='Counters and histograms for tool calls, costs, etc.'>
          <Switch checked={config.enableMetrics} onChange={(val) => updateField('enableMetrics', val)} />
        </Row>

        <div className='flex justify-end mt-16px pt-12px border-t border-border-2'>
          <Button type='primary' loading={saving} onClick={handleSave}>
            Save & Apply
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default ObservabilitySettings;
