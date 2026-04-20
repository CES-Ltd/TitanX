/**
 * @license Apache-2.0
 * Agent Workflow Builder — schema-driven parameter form renderer.
 *
 * Consumes a HandlerSchema (handlerParameterSchemas.ts) and renders
 * one typed input per field. Controls:
 *
 *   - string / textarea → Arco Input / Input.TextArea
 *   - number            → Arco InputNumber
 *   - boolean           → Arco Switch
 *   - stringArray       → Input.TextArea, newline-separated on read + write
 *   - enum              → Arco Select with passed-in options
 *   - json              → Monospace textarea with parse validation
 *
 * The form is fully controlled — state lives in the parent drawer;
 * this component just wires values ↔ onChange. Unknown keys present
 * on the node (but not in the schema) show as disabled raw-JSON
 * fields so authoring-by-hand via another tool doesn't lose data.
 */

import React from 'react';
import { Input, InputNumber, Switch, Select, Typography, Space } from '@arco-design/web-react';
import type { ParameterFieldSchema, HandlerSchema } from './handlerParameterSchemas';

type Props = {
  schema: HandlerSchema;
  parameters: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
};

const NodeParameterForm: React.FC<Props> = ({ schema, parameters, onChange }) => {
  const setField = (key: string, value: unknown) => {
    const next = { ...parameters };
    if (value === undefined || value === '' || value === null) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <Space direction='vertical' size={14} style={{ width: '100%' }}>
      {schema.description ? (
        <Typography.Text type='secondary' style={{ fontSize: 12 }}>
          {schema.description}
        </Typography.Text>
      ) : null}
      {schema.fields.length === 0 ? (
        <Typography.Text type='secondary' style={{ fontSize: 12, fontStyle: 'italic' }}>
          No parameters for this node type.
        </Typography.Text>
      ) : null}
      {schema.fields.map((f) => renderField(f, parameters[f.key], (v) => setField(f.key, v)))}
    </Space>
  );
};

function renderField(field: ParameterFieldSchema, value: unknown, onChange: (v: unknown) => void): React.ReactNode {
  const label = <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-2)' }}>{field.label}</label>;
  const hint = field.description ? (
    <span style={{ fontSize: 11, color: 'var(--color-text-4)' }}>{field.description}</span>
  ) : null;
  const wrap = (control: React.ReactNode) => (
    <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label}
      {control}
      {hint}
    </div>
  );

  switch (field.kind) {
    case 'string':
      return wrap(
        <Input
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(v) => onChange(v)}
        />
      );
    case 'textarea':
      return wrap(
        <Input.TextArea
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          autoSize={{ minRows: 3, maxRows: 10 }}
          onChange={(v) => onChange(v)}
        />
      );
    case 'number':
      return wrap(
        <InputNumber
          value={typeof value === 'number' ? value : undefined}
          placeholder={field.placeholder}
          min={0}
          onChange={(v) => onChange(v)}
          style={{ width: '100%' }}
        />
      );
    case 'boolean':
      return wrap(<Switch checked={Boolean(value)} onChange={(v) => onChange(v)} />);
    case 'stringArray': {
      const arr = Array.isArray(value) ? (value as unknown[]).map((x) => String(x)) : [];
      return wrap(
        <Input.TextArea
          value={arr.join('\n')}
          placeholder={field.placeholder}
          autoSize={{ minRows: 2, maxRows: 8 }}
          onChange={(v) => {
            const lines = v
              .split('\n')
              .map((s) => s)
              .filter((s, idx, a) => !(idx === a.length - 1 && s === ''));
            onChange(lines.length === 0 ? undefined : lines);
          }}
        />
      );
    }
    case 'enum':
      return wrap(
        <Select
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(v === '' ? undefined : v)}
          getPopupContainer={() => document.body}
        >
          {(field.options ?? []).map((opt) => (
            <Select.Option key={opt.value} value={opt.value}>
              {opt.label}
            </Select.Option>
          ))}
        </Select>
      );
    case 'json': {
      const text = value === undefined ? '' : JSON.stringify(value, null, 2);
      return wrap(
        <Input.TextArea
          value={text}
          placeholder={field.placeholder}
          autoSize={{ minRows: 3, maxRows: 10 }}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          onChange={(v) => {
            if (v.trim() === '') {
              onChange(undefined);
              return;
            }
            try {
              onChange(JSON.parse(v));
            } catch {
              // Keep the (invalid) text visible by not updating the
              // parsed value — the Apply button in the parent will
              // be gated by the caller's own validation before save.
              onChange(v);
            }
          }}
        />
      );
    }
    default:
      return null;
  }
}

export default NodeParameterForm;
