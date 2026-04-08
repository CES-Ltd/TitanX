/**
 * @license Apache-2.0
 * Project Planner — calendar-based plan scheduling for teams.
 * Shows plans on day/week/month/year views, creates sprint tasks.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Tag, Modal, Form, Input, DatePicker, Select, Message, Spin, Empty } from '@arco-design/web-react';
import { Left, Plus, Refresh } from '@icon-park/react';
import { projectPlanner, type IProjectPlan } from '@/common/adapter/ipcBridge';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import MonthView from './MonthView';
import WeekView from './WeekView';
import DayView from './DayView';
import YearView from './YearView';

const { Option } = Select;
const FormItem = Form.Item;

type ViewMode = 'day' | 'week' | 'month' | 'year';

const COLORS = ['#165dff', '#00b42a', '#f53f3f', '#ff7d00', '#722ed1', '#eb2f96'];

const ProjectPlanner: React.FC = () => {
  const { t } = useTranslation();
  const { id: teamId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = user?.id ?? 'system_default_user';

  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<IProjectPlan[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [createVisible, setCreateVisible] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [editPlan, setEditPlan] = useState<IProjectPlan | null>(null);
  const [form] = Form.useForm();

  const loadPlans = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      // Load plans for a wide range (current year ±1)
      const year = currentDate.getFullYear();
      const fromDate = new Date(year - 1, 0, 1).getTime();
      const toDate = new Date(year + 1, 11, 31).getTime();
      const list = await projectPlanner.list.invoke({ teamId, fromDate, toDate });
      setPlans(list);
    } catch (err) {
      console.error('[ProjectPlanner] Failed:', err);
    } finally {
      setLoading(false);
    }
  }, [teamId, currentDate]);

  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  const handleCreatePlan = useCallback(async () => {
    try {
      const values = await form.validate();
      if (!teamId) return;
      await projectPlanner.create.invoke({
        teamId,
        userId,
        title: values.title,
        description: values.description,
        scheduledDate: new Date(values.scheduledDate).getTime(),
        scheduledTime: values.scheduledTime || undefined,
        durationMinutes: values.duration || 60,
        recurrence: values.recurrence || undefined,
        color: values.color || '#165dff',
      });
      Message.success('Plan created');
      setCreateVisible(false);
      form.resetFields();
      loadPlans();
    } catch (err) {
      if (err instanceof Error) Message.error(err.message);
    }
  }, [teamId, userId, form, loadPlans]);

  const handleDateClick = useCallback(
    (date: Date) => {
      setSelectedDate(date);
      form.setFieldsValue({ scheduledDate: date.toISOString().split('T')[0] });
      setCreateVisible(true);
    },
    [form]
  );

  const handlePlanClick = useCallback((plan: IProjectPlan) => {
    setEditPlan(plan);
  }, []);

  const handleMonthClick = useCallback(
    (month: number) => {
      setCurrentDate(new Date(currentDate.getFullYear(), month, 1));
      setViewMode('month');
    },
    [currentDate]
  );

  const navigateDate = useCallback(
    (dir: -1 | 1) => {
      const d = new Date(currentDate);
      if (viewMode === 'day') d.setDate(d.getDate() + dir);
      else if (viewMode === 'week') d.setDate(d.getDate() + 7 * dir);
      else if (viewMode === 'month') d.setMonth(d.getMonth() + dir);
      else d.setFullYear(d.getFullYear() + dir);
      setCurrentDate(d);
    },
    [currentDate, viewMode]
  );

  const formatTitle = (): string => {
    const opts: Intl.DateTimeFormatOptions =
      viewMode === 'year'
        ? { year: 'numeric' }
        : viewMode === 'month'
          ? { month: 'long', year: 'numeric' }
          : viewMode === 'week'
            ? { month: 'short', day: 'numeric', year: 'numeric' }
            : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    return currentDate.toLocaleDateString('en-US', opts);
  };

  if (loading) return <Spin className='flex justify-center mt-16' />;

  return (
    <div className='flex flex-col px-16px pt-8px' style={{ height: 'calc(100vh - 44px)', overflow: 'auto' }}>
      {/* Header */}
      <div className='flex items-center justify-between mb-8px shrink-0'>
        <div className='flex items-center gap-8px'>
          <Button type='text' icon={<Left size={16} />} onClick={() => navigate(`/team/${teamId}`)} />
          <span className='text-18px font-bold text-t-primary'>Project Planner</span>
        </div>
        <div className='flex items-center gap-6px'>
          {/* View mode toggle */}
          <div className='flex bg-fill-2 rd-6px p-1px'>
            {(['day', 'week', 'month', 'year'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type='button'
                className={`px-8px py-3px rd-5px text-11px border-none cursor-pointer transition-all ${viewMode === mode ? 'bg-white text-primary shadow-sm' : 'bg-transparent text-t-secondary hover:text-t-primary'}`}
                onClick={() => setViewMode(mode)}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
          {/* Navigation */}
          <Button size='small' onClick={() => navigateDate(-1)}>
            ←
          </Button>
          <Button size='small' onClick={() => setCurrentDate(new Date())}>
            Today
          </Button>
          <Button size='small' onClick={() => navigateDate(1)}>
            →
          </Button>
          <span className='text-13px font-medium text-t-primary min-w-120px text-center'>{formatTitle()}</span>
          {/* Actions */}
          <Button icon={<Refresh size={14} />} size='small' onClick={loadPlans} />
          <Button type='primary' size='small' icon={<Plus size={14} />} onClick={() => setCreateVisible(true)}>
            New Plan
          </Button>
        </div>
      </div>

      {/* Calendar View */}
      <div className='flex-1 min-h-0 overflow-hidden'>
        {viewMode === 'month' && (
          <MonthView
            currentDate={currentDate}
            plans={plans}
            onDateClick={handleDateClick}
            onPlanClick={handlePlanClick}
          />
        )}
        {viewMode === 'week' && (
          <WeekView
            currentDate={currentDate}
            plans={plans}
            onDateClick={handleDateClick}
            onPlanClick={handlePlanClick}
          />
        )}
        {viewMode === 'day' && (
          <DayView
            currentDate={currentDate}
            plans={plans}
            onHourClick={(date, hour) => {
              form.setFieldsValue({
                scheduledDate: date.toISOString().split('T')[0],
                scheduledTime: `${String(hour).padStart(2, '0')}:00`,
              });
              setCreateVisible(true);
            }}
            onPlanClick={handlePlanClick}
          />
        )}
        {viewMode === 'year' && <YearView currentDate={currentDate} plans={plans} onMonthClick={handleMonthClick} />}
      </div>

      {/* Create Plan Modal */}
      <Modal
        title='Create Plan'
        visible={createVisible}
        onOk={handleCreatePlan}
        onCancel={() => setCreateVisible(false)}
        unmountOnExit
        style={{ borderRadius: 12 }}
      >
        <Form form={form} layout='vertical'>
          <FormItem label='Title' field='title' rules={[{ required: true }]}>
            <Input placeholder='e.g., Sprint 3 — API refactor' />
          </FormItem>
          <FormItem label='Description' field='description'>
            <Input.TextArea autoSize={{ minRows: 2 }} placeholder='What this plan covers...' />
          </FormItem>
          <FormItem label='Date' field='scheduledDate' rules={[{ required: true }]}>
            <Input type='date' />
          </FormItem>
          <FormItem label='Time' field='scheduledTime'>
            <Input type='time' />
          </FormItem>
          <FormItem label='Duration (min)' field='duration'>
            <Select defaultValue={60}>
              <Option value={30}>30 min</Option>
              <Option value={60}>1 hour</Option>
              <Option value={120}>2 hours</Option>
              <Option value={240}>4 hours</Option>
              <Option value={480}>Full day</Option>
            </Select>
          </FormItem>
          <FormItem label='Recurrence' field='recurrence'>
            <Select allowClear placeholder='One-time'>
              <Option value='daily'>Daily</Option>
              <Option value='weekly'>Weekly</Option>
              <Option value='monthly'>Monthly</Option>
            </Select>
          </FormItem>
          <FormItem label='Color' field='color'>
            <div className='flex gap-4px'>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type='button'
                  className='w-24px h-24px rd-full border-2 border-solid cursor-pointer'
                  style={{
                    backgroundColor: c,
                    borderColor: 'transparent',
                  }}
                  onClick={() => form.setFieldsValue({ color: c })}
                />
              ))}
            </div>
          </FormItem>
        </Form>
      </Modal>

      {/* Plan Detail Modal */}
      <Modal
        title={editPlan?.title ?? 'Plan Details'}
        visible={!!editPlan}
        onCancel={() => setEditPlan(null)}
        footer={
          <div className='flex gap-4px'>
            <Button
              status='danger'
              onClick={async () => {
                if (editPlan) {
                  await projectPlanner.remove.invoke({ planId: editPlan.id });
                  setEditPlan(null);
                  loadPlans();
                }
              }}
            >
              Delete
            </Button>
            <Button
              onClick={async () => {
                if (editPlan) {
                  const newStatus = editPlan.status === 'active' ? 'paused' : 'active';
                  await projectPlanner.update.invoke({ planId: editPlan.id, updates: { status: newStatus } });
                  setEditPlan(null);
                  loadPlans();
                }
              }}
            >
              {editPlan?.status === 'active' ? 'Pause' : 'Activate'}
            </Button>
          </div>
        }
        style={{ borderRadius: 12 }}
      >
        {editPlan && (
          <div className='flex flex-col gap-8px'>
            <div className='flex items-center gap-6px'>
              <Tag color={editPlan.status === 'active' ? 'green' : editPlan.status === 'paused' ? 'orange' : 'gray'}>
                {editPlan.status}
              </Tag>
              {editPlan.recurrence && <Tag>{editPlan.recurrence}</Tag>}
              <Tag>{editPlan.durationMinutes} min</Tag>
            </div>
            {editPlan.description && <div className='text-13px text-t-secondary'>{editPlan.description}</div>}
            <div className='text-12px text-t-quaternary'>
              Scheduled: {new Date(editPlan.scheduledDate).toLocaleDateString()}
              {editPlan.scheduledTime ? ` at ${editPlan.scheduledTime}` : ' (all day)'}
            </div>
            {editPlan.sprintTaskIds.length > 0 && (
              <div className='mt-8px'>
                <div className='text-11px font-medium text-t-secondary mb-4px'>
                  Linked Sprint Tasks ({editPlan.sprintTaskIds.length})
                </div>
                {editPlan.sprintTaskIds.map((id) => (
                  <Tag key={id} size='small' className='mr-2px'>
                    {id}
                  </Tag>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default ProjectPlanner;
