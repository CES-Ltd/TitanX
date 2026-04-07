/**
 * @license Apache-2.0
 * Task detail modal — full task view with chatter channel (@ mention comments).
 */

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Input, Tag, Select, Button, Message, Space, Divider } from '@arco-design/web-react';
import { SendOne } from '@icon-park/react';
import { sprintBoard, type ISprintTask } from '@/common/adapter/ipcBridge';

const { TextArea } = Input;
const { Option } = Select;

const STATUS_OPTIONS: ISprintTask['status'][] = ['backlog', 'todo', 'in_progress', 'review', 'done'];
const PRIORITY_OPTIONS: ISprintTask['priority'][] = ['low', 'medium', 'high', 'critical'];

type TaskDetailModalProps = {
  task: ISprintTask;
  agents: Array<{ slotId: string; agentName: string }>;
  visible: boolean;
  onClose: () => void;
  onUpdate: () => void;
};

const TaskDetailModal: React.FC<TaskDetailModalProps> = ({ task, agents, visible, onClose, onUpdate }) => {
  const { t } = useTranslation();
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleStatusChange = useCallback(
    async (newStatus: string) => {
      try {
        await sprintBoard.update.invoke({
          taskId: task.id,
          updates: { status: newStatus as ISprintTask['status'] },
        });
        onUpdate();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [task.id, onUpdate]
  );

  const handlePriorityChange = useCallback(
    async (newPriority: string) => {
      try {
        await sprintBoard.update.invoke({
          taskId: task.id,
          updates: { priority: newPriority as ISprintTask['priority'] },
        });
        onUpdate();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [task.id, onUpdate]
  );

  const handleAssigneeChange = useCallback(
    async (slotId: string) => {
      try {
        await sprintBoard.update.invoke({
          taskId: task.id,
          updates: { assigneeSlotId: slotId || undefined },
        });
        onUpdate();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [task.id, onUpdate]
  );

  const handleAddComment = useCallback(async () => {
    if (!commentText.trim()) return;
    setSubmitting(true);
    try {
      await sprintBoard.addComment.invoke({
        taskId: task.id,
        author: 'User',
        authorType: 'user',
        content: commentText.trim(),
      });
      setCommentText('');
      onUpdate();
      Message.success(t('sprint.commentAdded', 'Comment added'));
    } catch (err) {
      Message.error(String(err));
    } finally {
      setSubmitting(false);
    }
  }, [task.id, commentText, onUpdate, t]);

  return (
    <Modal
      title={
        <div className='flex items-center gap-8px'>
          <span className='font-mono text-12px text-t-quaternary'>{task.id}</span>
          <span>{task.title}</span>
        </div>
      }
      visible={visible}
      onCancel={onClose}
      footer={null}
      style={{ width: 640, borderRadius: '12px' }}
      unmountOnExit
    >
      {/* Description */}
      {task.description && (
        <div className='text-13px text-t-secondary mb-12px whitespace-pre-wrap'>{task.description}</div>
      )}

      {/* Fields */}
      <div className='flex flex-wrap gap-12px mb-12px'>
        <div className='flex items-center gap-6px'>
          <span className='text-12px text-t-quaternary'>{t('sprint.status', 'Status')}:</span>
          <Select size='small' value={task.status} onChange={handleStatusChange} style={{ width: 130 }}>
            {STATUS_OPTIONS.map((s) => (
              <Option key={s} value={s}>
                {s.replace('_', ' ')}
              </Option>
            ))}
          </Select>
        </div>
        <div className='flex items-center gap-6px'>
          <span className='text-12px text-t-quaternary'>{t('sprint.priority', 'Priority')}:</span>
          <Select size='small' value={task.priority} onChange={handlePriorityChange} style={{ width: 100 }}>
            {PRIORITY_OPTIONS.map((p) => (
              <Option key={p} value={p}>
                {p}
              </Option>
            ))}
          </Select>
        </div>
        <div className='flex items-center gap-6px'>
          <span className='text-12px text-t-quaternary'>{t('sprint.assignee', 'Assignee')}:</span>
          <Select
            size='small'
            value={task.assigneeSlotId ?? ''}
            onChange={handleAssigneeChange}
            allowClear
            style={{ width: 140 }}
          >
            {agents.map((a) => (
              <Option key={a.slotId} value={a.slotId}>
                {a.agentName}
              </Option>
            ))}
          </Select>
        </div>
      </div>

      {/* Labels */}
      {task.labels.length > 0 && (
        <div className='flex gap-4px mb-12px'>
          {task.labels.map((l) => (
            <Tag key={l} size='small' color='arcoblue'>
              {l}
            </Tag>
          ))}
        </div>
      )}

      <Divider style={{ margin: '12px 0' }} />

      {/* Chatter Channel — Comments with @ mentions */}
      <div className='text-13px font-medium text-t-primary mb-8px'>
        {t('sprint.chatter', 'Chatter')} 💬
        <span className='text-11px text-t-quaternary ml-4px'>
          {t('sprint.chatterHint', 'Use @agentName to tag agents')}
        </span>
      </div>

      {/* Comment list */}
      <div className='max-h-[250px] overflow-y-auto mb-8px'>
        {task.comments.length === 0 ? (
          <div className='text-12px text-t-quaternary text-center py-16px'>
            {t('sprint.noComments', 'No comments yet')}
          </div>
        ) : (
          task.comments.map((comment) => (
            <div key={comment.id} className='flex gap-8px mb-8px'>
              <div className='w-24px h-24px rd-full bg-fill-3 flex items-center justify-center shrink-0 text-10px'>
                {comment.authorType === 'agent' ? '🤖' : '👤'}
              </div>
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-4px mb-2px'>
                  <span className='text-12px font-medium text-t-primary'>{comment.author}</span>
                  <span className='text-10px text-t-quaternary'>
                    {new Date(comment.createdAt).toLocaleTimeString()}
                  </span>
                  <span className='text-10px font-mono text-t-quaternary'>{comment.id}</span>
                </div>
                <div className='text-12px text-t-secondary'>
                  {comment.content.split(/(@\w+)/g).map((part, i) =>
                    part.startsWith('@') ? (
                      <span key={i} className='text-primary font-medium'>
                        {part}
                      </span>
                    ) : (
                      <span key={i}>{part}</span>
                    )
                  )}
                </div>
                {comment.mentions.length > 0 && (
                  <div className='flex gap-2px mt-2px'>
                    {comment.mentions.map((m) => (
                      <Tag key={m} size='small' color='cyan'>
                        @{m}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Comment input */}
      <div className='flex gap-8px'>
        <TextArea
          value={commentText}
          onChange={setCommentText}
          placeholder={t('sprint.commentPlaceholder', 'Add a comment... Use @agentName to mention')}
          autoSize={{ minRows: 1, maxRows: 3 }}
          className='flex-1'
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              handleAddComment();
            }
          }}
        />
        <Button
          type='primary'
          icon={<SendOne size={14} />}
          loading={submitting}
          onClick={handleAddComment}
          disabled={!commentText.trim()}
        />
      </div>
    </Modal>
  );
};

export default TaskDetailModal;
