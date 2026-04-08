/**
 * @license Apache-2.0
 * Observability settings — configure OpenTelemetry tracing and metrics export.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Switch, Select, Input, Slider, Button, Message } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import type { ITelemetryConfig } from '@/common/adapter/ipcBridge';
import PreferenceRow from './SystemModalContent/PreferenceRow';

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

const ObservabilityModalContent: React.FC = () => {
  const [config, setConfig] = useState<ITelemetryConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void ipcBridge.telemetry.getConfig.invoke().then((cfg) => {
      if (cfg) setConfig(cfg);
    });
  }, []);

  const updateField = useCallback(<K extends keyof ITelemetryConfig>(key: K, value: ITelemetryConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await ipcBridge.telemetry.setConfig.invoke(config);
      Message.success('Telemetry configuration saved');
    } catch {
      Message.error('Failed to save telemetry configuration');
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handleTestConnection = useCallback(async () => {
    if (!config.otlpEndpoint) {
      Message.warning('Please enter an OTLP endpoint URL first');
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
    <div className='px-24px py-16px'>
      <div className='text-16px font-semibold text-2 mb-16px'>OpenTelemetry</div>
      <div className='text-12px text-t-tertiary mb-20px'>
        Export traces and metrics to external observability platforms (Jaeger, Grafana, Datadog, etc.)
      </div>

      <PreferenceRow label='Enable Telemetry' description='Master toggle for all OpenTelemetry instrumentation'>
        <Switch checked={config.enabled} onChange={(val) => updateField('enabled', val)} />
      </PreferenceRow>

      <PreferenceRow label='Service Name' description='Reported in all traces and metrics'>
        <Input
          value={config.serviceName}
          onChange={(val) => updateField('serviceName', val)}
          style={{ width: 160 }}
          placeholder='titanx'
        />
      </PreferenceRow>

      <PreferenceRow label='Exporter Type' description='Where to send telemetry data'>
        <Select
          value={config.exporterType}
          onChange={(val) => updateField('exporterType', val as ITelemetryConfig['exporterType'])}
          style={{ width: 160 }}
          options={[
            { label: 'OTLP (Collector)', value: 'otlp' },
            { label: 'Console', value: 'console' },
            { label: 'None', value: 'none' },
          ]}
        />
      </PreferenceRow>

      {config.exporterType === 'otlp' && (
        <>
          <PreferenceRow label='OTLP Endpoint' description='Collector URL (e.g., http://localhost:4318)'>
            <div className='flex gap-8px'>
              <Input
                value={config.otlpEndpoint ?? ''}
                onChange={(val) => updateField('otlpEndpoint', val)}
                style={{ width: 220 }}
                placeholder='http://localhost:4318'
              />
              <Button size='small' onClick={handleTestConnection}>
                Test
              </Button>
            </div>
          </PreferenceRow>

          <PreferenceRow label='Protocol' description='OTLP transport protocol'>
            <Select
              value={config.otlpProtocol}
              onChange={(val) => updateField('otlpProtocol', val as ITelemetryConfig['otlpProtocol'])}
              style={{ width: 160 }}
              options={[
                { label: 'HTTP/Protobuf', value: 'http/protobuf' },
                { label: 'gRPC', value: 'grpc' },
              ]}
            />
          </PreferenceRow>
        </>
      )}

      <PreferenceRow label='Log Level' description='Minimum severity level to export'>
        <Select
          value={config.logLevel}
          onChange={(val) => updateField('logLevel', val as ITelemetryConfig['logLevel'])}
          style={{ width: 160 }}
          options={[
            { label: 'None', value: 'none' },
            { label: 'Error', value: 'error' },
            { label: 'Warning', value: 'warn' },
            { label: 'Info', value: 'info' },
            { label: 'Debug', value: 'debug' },
          ]}
        />
      </PreferenceRow>

      <PreferenceRow label='Sample Rate' description={`${Math.round(config.sampleRate * 100)}% of traces sampled`}>
        <Slider
          value={config.sampleRate * 100}
          onChange={(val) => updateField('sampleRate', (val as number) / 100)}
          min={0}
          max={100}
          step={5}
          style={{ width: 160 }}
        />
      </PreferenceRow>

      <PreferenceRow label='Enable Traces' description='Distributed tracing for agent operations'>
        <Switch checked={config.enableTraces} onChange={(val) => updateField('enableTraces', val)} />
      </PreferenceRow>

      <PreferenceRow label='Enable Metrics' description='Counters and histograms for tool calls, costs, etc.'>
        <Switch checked={config.enableMetrics} onChange={(val) => updateField('enableMetrics', val)} />
      </PreferenceRow>

      <div className='flex justify-end mt-24px pt-16px border-t border-border-2'>
        <Button type='primary' loading={saving} onClick={handleSave}>
          Save & Apply
        </Button>
      </div>
    </div>
  );
};

export default ObservabilityModalContent;
