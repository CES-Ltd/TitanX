/**
 * @license Apache-2.0
 * Agent Workflow Builder — node parameter editor (Phase 2.x).
 *
 * Side-drawer JSON editor for a selected workflow step. Edits are
 * local state; committing calls `onApply(newParameters)` and closes.
 * The parent propagates the change into the workflow's nodes array
 * and marks the workflow dirty.
 *
 * Intentionally minimal for Phase 2.x:
 *   - One monospace textarea with JSON.stringify/JSON.parse validation.
 *   - An Apply button (disabled until parse succeeds + differs from
 *     the original).
 *   - No per-handler schema form. A schema-aware form (one input
 *     per known `node.parameters` key, validated against the
 *     handler's declared types) lands as a Phase 3.x follow-up —
 *     today's JSON editor already unblocks operator tweaks on
 *     every handler, schema-known or not.
 *
 * Keyboard affordance — Cmd/Ctrl+Enter applies without clicking.
 * ESC (handled by Arco Drawer) cancels.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Drawer, Typography, Input, Button, Space, Message, Tag, Radio } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { getHandlerSchema } from './handlerParameterSchemas';
import NodeParameterForm from './NodeParameterForm';

type Props = {
  visible: boolean;
  /** The node currently selected. Drawer renders its type + params for edit. */
  node?: {
    id: string;
    type: string;
    name: string;
    parameters?: Record<string, unknown>;
  } | null;
  onClose: () => void;
  onApply: (nodeId: string, parameters: Record<string, unknown>) => void;
};

const NodeParameterDrawer: React.FC<Props> = ({ visible, node, onClose, onApply }) => {
  const { t } = useTranslation();
  const schema = node ? getHandlerSchema(node.type) : null;
  const [mode, setMode] = useState<'form' | 'json'>(schema && schema.fields.length > 0 ? 'form' : 'json');

  // Form state: the current edits, kept separately from the node so
  // cancel/close doesn't commit. JSON state mirrors it.
  const originalParams = useMemo(() => node?.parameters ?? {}, [node]);
  const [formParams, setFormParams] = useState<Record<string, unknown>>(originalParams);
  const [text, setText] = useState(JSON.stringify(originalParams, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  // Reset editor state whenever the selected node changes.
  useEffect(() => {
    const params = node?.parameters ?? {};
    setFormParams(params);
    setText(JSON.stringify(params, null, 2));
    setParseError(null);
    const nextSchema = node ? getHandlerSchema(node.type) : null;
    setMode(nextSchema && nextSchema.fields.length > 0 ? 'form' : 'json');
  }, [node?.id]);

  const handleApply = () => {
    if (!node) return;
    if (mode === 'form') {
      onApply(node.id, formParams);
      Message.success(t('agentWorkflows.editor.paramApplied', 'Node parameters updated'));
      onClose();
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Parameters must be a JSON object');
      }
      onApply(node.id, parsed as Record<string, unknown>);
      Message.success(t('agentWorkflows.editor.paramApplied', 'Node parameters updated'));
      onClose();
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  const dirty =
    mode === 'form'
      ? JSON.stringify(formParams) !== JSON.stringify(originalParams)
      : text !== JSON.stringify(originalParams, null, 2);

  const handleKey = (evt: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((evt.metaKey || evt.ctrlKey) && evt.key === 'Enter') {
      evt.preventDefault();
      handleApply();
    }
  };

  // When switching from form → JSON, serialize the latest form state
  // so the operator sees (and can further edit) their in-progress
  // changes. Reverse direction mirrors from text → formParams on
  // parse success; on failure we preserve the formParams view.
  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return;
    if (next === 'json') {
      setText(JSON.stringify(formParams, null, 2));
      setParseError(null);
    } else {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          setFormParams(parsed as Record<string, unknown>);
        }
      } catch {
        // leave formParams as-is
      }
    }
    setMode(next);
  };

  return (
    <Drawer
      title={
        node ? (
          <Space>
            <span>{node.name || node.id}</span>
            <Tag size='small' color='gray'>
              {node.type}
            </Tag>
          </Space>
        ) : (
          t('agentWorkflows.editor.title', 'Edit step parameters')
        )
      }
      visible={visible}
      onCancel={onClose}
      width={480}
      footer={
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>{t('agentWorkflows.editor.cancel', 'Cancel')}</Button>
          <Button type='primary' disabled={!dirty || (mode === 'json' && parseError !== null)} onClick={handleApply}>
            {t('agentWorkflows.editor.apply', 'Apply')}
          </Button>
        </Space>
      }
    >
      {node ? (
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          {schema && schema.fields.length > 0 ? (
            <Radio.Group
              type='button'
              size='mini'
              value={mode}
              onChange={(v: string) => switchMode(v as 'form' | 'json')}
            >
              <Radio value='form'>{t('agentWorkflows.editor.modeForm', 'Form')}</Radio>
              <Radio value='json'>{t('agentWorkflows.editor.modeJson', 'JSON')}</Radio>
            </Radio.Group>
          ) : null}
          {mode === 'form' && schema ? (
            <NodeParameterForm schema={schema} parameters={formParams} onChange={setFormParams} />
          ) : (
            <>
              <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                {t(
                  'agentWorkflows.editor.hint',
                  'Edit the node.parameters JSON below. Click Apply (or Cmd/Ctrl+Enter) to stage the change; use the Save button in the page header to persist.'
                )}
              </Typography.Text>
              <Input.TextArea
                value={text}
                onChange={(v) => {
                  setText(v);
                  try {
                    JSON.parse(v);
                    setParseError(null);
                  } catch (err) {
                    setParseError(err instanceof Error ? err.message : 'Invalid JSON');
                  }
                }}
                onKeyDown={handleKey}
                autoSize={{ minRows: 14, maxRows: 28 }}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              {parseError ? (
                <Typography.Text type='error' style={{ fontSize: 12 }}>
                  {parseError}
                </Typography.Text>
              ) : null}
            </>
          )}
        </Space>
      ) : null}
    </Drawer>
  );
};

export default NodeParameterDrawer;
