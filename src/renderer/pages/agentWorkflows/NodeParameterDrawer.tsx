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

import React, { useEffect, useState } from 'react';
import { Drawer, Typography, Input, Button, Space, Message, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

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
  const original = node?.parameters ?? {};
  const [text, setText] = useState(JSON.stringify(original, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  // Reset editor state whenever the selected node changes.
  useEffect(() => {
    setText(JSON.stringify(node?.parameters ?? {}, null, 2));
    setParseError(null);
  }, [node?.id]);

  const handleApply = () => {
    if (!node) return;
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

  const dirty = text !== JSON.stringify(node?.parameters ?? {}, null, 2);

  const handleKey = (evt: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((evt.metaKey || evt.ctrlKey) && evt.key === 'Enter') {
      evt.preventDefault();
      handleApply();
    }
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
          <Button type='primary' disabled={!dirty || parseError !== null} onClick={handleApply}>
            {t('agentWorkflows.editor.apply', 'Apply')}
          </Button>
        </Space>
      }
    >
      {node ? (
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
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
        </Space>
      ) : null}
    </Drawer>
  );
};

export default NodeParameterDrawer;
