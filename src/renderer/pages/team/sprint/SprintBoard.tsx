/**
 * @license Apache-2.0
 * Agent Sprint Board — JIRA-like task management with swimlane and list views.
 * Accessed via /team/:id/sprint route.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button,
  Space,
  Spin,
  Empty,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Message,
  Radio,
} from '@arco-design/web-react';
import { Plus, Left, Viewfinder, ApplicationMenu } from '@icon-park/react';
import { sprintBoard, team as teamBridge, type ISprintTask } from '@/common/adapter/ipcBridge';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import SwimLaneView from './SwimLaneView';
import ListView from './ListView';
import TaskDetailModal from './TaskDetailModal';

const { Option } = Select;
const { TextArea } = Input;
const FormItem = Form.Item;

const SprintBoard: React.FC = () => {
  const { t } = useTranslation();
  const { id: teamId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? 'system_default_user';

  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<ISprintTask[]>([]);
  const [team, setTeam] = useState<{ name: string; agents: Array<{ slotId: string; agentName: string }> } | null>(null);
  const [viewMode, setViewMode] = useState<'swimlane' | 'list'>('swimlane');
  const [createVisible, setCreateVisible] = useState(false);
  const [selectedTask, setSelectedTask] = useState<ISprintTask | null>(null);
  const [form] = Form.useForm();

  const loadData = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      const [taskList, teamData] = await Promise.all([
        sprintBoard.list.invoke({ teamId }),
        teamBridge.get.invoke({ id: teamId }),
      ]);
      setTasks(taskList);
      if (teamData) {
        setTeam({
          name: teamData.name,
          agents: teamData.agents.map((a) => ({ slotId: a.slotId, agentName: a.agentName })),
        });
      }
    } catch (err) {
      console.error('[SprintBoard] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh: poll every 5 seconds to pick up agent-created tasks
  useEffect(() => {
    const interval = setInterval(() => {
      void loadData();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleCreateTask = useCallback(async () => {
    if (!teamId) return;
    try {
      const values = await form.validate();
      await sprintBoard.create.invoke({
        teamId,
        title: values.title,
        description: values.description,
        assigneeSlotId: values.assigneeSlotId || undefined,
        priority: values.priority || 'medium',
        storyPoints: values.storyPoints || undefined,
      });
      Message.success(t('sprint.taskCreated', 'Task created'));
      setCreateVisible(false);
      form.resetFields();
      loadData();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [teamId, form, loadData, t]);

  const handleStatusChange = useCallback(
    async (taskId: string, newStatus: ISprintTask['status']) => {
      try {
        await sprintBoard.update.invoke({ taskId, updates: { status: newStatus } });
        loadData();
      } catch (err) {
        Message.error(String(err));
      }
    },
    [loadData]
  );

  const handleTaskClick = useCallback(
    (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (task) setSelectedTask(task);
    },
    [tasks]
  );

  const handleTaskUpdate = useCallback(() => {
    loadData();
    // Refresh selected task
    if (selectedTask) {
      sprintBoard.get.invoke({ taskId: selectedTask.id }).then((updated) => {
        if (updated) setSelectedTask(updated);
      });
    }
  }, [loadData, selectedTask]);

  if (loading) return <Spin className='flex justify-center mt-8' />;

  const agents = team?.agents ?? [];

  return (
    <div className='flex flex-col px-16px pt-8px' style={{ height: 'calc(100vh - 44px)', overflow: 'auto' }}>
      {/* Header */}
      <div className='flex items-center justify-between mb-12px shrink-0'>
        <div className='flex items-center gap-12px'>
          <Button
            type='text'
            icon={<Left size={16} />}
            onClick={() => navigate(`/team/${teamId}`)}
            className='shrink-0'
          />
          <span className='text-18px font-bold text-t-primary'>
            {t('sprint.title', 'Agent Sprint')} — {team?.name}
          </span>
        </div>
        <Space>
          <Radio.Group value={viewMode} onChange={setViewMode} type='button' size='small'>
            <Radio value='swimlane'>
              <ApplicationMenu size={14} /> {t('sprint.swimlane', 'Board')}
            </Radio>
            <Radio value='list'>
              <Viewfinder size={14} /> {t('sprint.list', 'List')}
            </Radio>
          </Radio.Group>
          <Button type='primary' size='small' icon={<Plus size={14} />} onClick={() => setCreateVisible(true)}>
            {t('sprint.createTask', 'New Task')}
          </Button>
        </Space>
      </div>

      {/* Board content */}
      <div className='flex-1 min-h-0 overflow-hidden'>
        {tasks.length === 0 ? (
          <Empty description={t('sprint.empty', 'No tasks yet. Create your first sprint task.')} className='mt-16' />
        ) : viewMode === 'swimlane' ? (
          <SwimLaneView
            tasks={tasks}
            agents={agents}
            onTaskClick={handleTaskClick}
            onStatusChange={handleStatusChange}
          />
        ) : (
          <ListView tasks={tasks} agents={agents} onTaskClick={handleTaskClick} />
        )}
      </div>

      {/* Create Task Modal */}
      <Modal
        title={t('sprint.createTask', 'New Task')}
        visible={createVisible}
        onOk={handleCreateTask}
        onCancel={() => setCreateVisible(false)}
        style={{ borderRadius: '12px' }}
        unmountOnExit
      >
        <Form form={form} layout='vertical'>
          <FormItem label={t('sprint.title', 'Title')} field='title' rules={[{ required: true }]}>
            <Input placeholder={t('sprint.titlePlaceholder', 'Task title')} />
          </FormItem>
          <FormItem label={t('sprint.description', 'Description')} field='description'>
            <TextArea
              placeholder={t('sprint.descriptionPlaceholder', 'Describe the task...')}
              autoSize={{ minRows: 2 }}
            />
          </FormItem>
          <FormItem label={t('sprint.assignee', 'Assignee')} field='assigneeSlotId'>
            <Select allowClear placeholder={t('sprint.unassigned', 'Unassigned')}>
              {agents.map((a) => (
                <Option key={a.slotId} value={a.slotId}>
                  {a.agentName}
                </Option>
              ))}
            </Select>
          </FormItem>
          <FormItem label={t('sprint.priority', 'Priority')} field='priority' initialValue='medium'>
            <Select>
              <Option value='low'>Low</Option>
              <Option value='medium'>Medium</Option>
              <Option value='high'>High</Option>
              <Option value='critical'>Critical</Option>
            </Select>
          </FormItem>
          <FormItem label={t('sprint.points', 'Story Points')} field='storyPoints'>
            <InputNumber min={0} max={99} />
          </FormItem>
        </Form>
      </Modal>

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          agents={agents}
          visible
          onClose={() => setSelectedTask(null)}
          onUpdate={handleTaskUpdate}
        />
      )}
    </div>
  );
};

export default SprintBoard;
