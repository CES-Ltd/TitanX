/**
 * @license Apache-2.0
 * TemplateLibraryPanel — master-only admin surface for curating which
 * local agent-gallery templates get published into the fleet config
 * bundle (Phase A v1.9.40).
 *
 * What it closes: Phase E shipped the pipe (master embeds template rows
 * in the config bundle → slaves ingest into agent_gallery with
 * source='master'), and the dashboard already shows adoption of
 * already-published templates. But there was no UI for the admin to
 * choose WHICH local templates to publish or unpublish in the first
 * place. This panel is that UI.
 *
 * Data flow:
 *   1. `ipcBridge.agentGallery.list({ userId: 'system_default_user' })`
 *      returns all gallery rows including the `publishedToFleet` flag
 *   2. The admin toggles Publish / Unpublish via a button per row
 *   3. Those IPCs call agentGallery.publishToFleet / unpublishFromFleet,
 *      which flip the DB flag AND bump `fleet_config_version` so slaves
 *      pull on the next 30s poll cycle
 *   4. After each toggle we re-fetch the list so the UI shows the new
 *      state immediately (and the FleetDashboard adoption table picks
 *      up the change on its own 60s refresh)
 *
 * Intentional non-goals:
 *   - Editing templates (that stays in the Agents Gallery page)
 *   - Creating master-source templates (gallery handles it; this is
 *     only about the publish flag)
 *   - Bulk select (adds complexity, single-row toggling matches the
 *     low-volume admin workflow of publishing a curated handful)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Message, Table, Tag, Popconfirm } from '@arco-design/web-react';
import { Refresh, Upload, Delete } from '@icon-park/react';
import { ipcBridge } from '@/common';
import type { IGalleryAgent } from '@/common/adapter/ipcBridge';

const DEFAULT_USER_ID = 'system_default_user';

const TemplateLibraryPanel: React.FC = () => {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<IGalleryAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await ipcBridge.agentGallery.list.invoke({ userId: DEFAULT_USER_ID });
      setAgents(data);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handlePublish = useCallback(
    async (agentId: string) => {
      setBusyId(agentId);
      try {
        const result = await ipcBridge.agentGallery.publishToFleet.invoke({ agentId });
        if (!result.ok) {
          Message.error(
            t('fleet.templateLibrary.publishFailed', {
              defaultValue: 'Publishing failed. Check server logs.',
            })
          );
          return;
        }
        Message.success(
          t('fleet.templateLibrary.published', {
            defaultValue: 'Template published — slaves will pick it up on next sync.',
          })
        );
        await refresh();
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t]
  );

  const handleUnpublish = useCallback(
    async (agentId: string) => {
      setBusyId(agentId);
      try {
        const result = await ipcBridge.agentGallery.unpublishFromFleet.invoke({ agentId });
        if (!result.ok) {
          Message.error(
            t('fleet.templateLibrary.unpublishFailed', {
              defaultValue: 'Unpublishing failed. Check server logs.',
            })
          );
          return;
        }
        Message.success(
          t('fleet.templateLibrary.unpublished', {
            defaultValue: 'Template unpublished — slaves will stop receiving it on next sync.',
          })
        );
        await refresh();
      } catch (err) {
        Message.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t]
  );

  // Filter: show local-origin agents only. Master-source templates
  // came FROM another master; republishing them would pollute the
  // source='master' lineage. Built-in agents are static so their
  // publish state is noise.
  const publishable = agents.filter((a) => a.source !== 'builtin' && a.source !== 'master');

  const columns = [
    {
      title: t('fleet.templateLibrary.table.name', { defaultValue: 'Template' }),
      key: 'name',
      render: (_: unknown, row: IGalleryAgent) => (
        <div className='flex flex-col'>
          <span className='font-medium'>{row.name}</span>
          <span className='text-11px text-t-tertiary'>{row.agentType}</span>
        </div>
      ),
    },
    {
      title: t('fleet.templateLibrary.table.category', { defaultValue: 'Category' }),
      dataIndex: 'category',
      key: 'category',
      render: (category: string) => category || '—',
    },
    {
      title: t('fleet.templateLibrary.table.status', { defaultValue: 'Status' }),
      key: 'publishedToFleet',
      render: (_: unknown, row: IGalleryAgent) =>
        row.publishedToFleet ? (
          <Tag color='green' size='small'>
            {t('fleet.templateLibrary.table.publishedTag', { defaultValue: 'Published' })}
          </Tag>
        ) : (
          <Tag size='small'>{t('fleet.templateLibrary.table.localTag', { defaultValue: 'Local only' })}</Tag>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 140,
      render: (_: unknown, row: IGalleryAgent) => {
        if (row.publishedToFleet) {
          return (
            <Popconfirm
              title={t('fleet.templateLibrary.unpublishConfirm.title', { defaultValue: 'Unpublish this template?' })}
              content={t('fleet.templateLibrary.unpublishConfirm.body', {
                defaultValue:
                  'Slaves will stop receiving updates for this template on their next 30-second config sync.',
              })}
              onOk={() => void handleUnpublish(row.id)}
            >
              <Button
                size='small'
                status='danger'
                icon={<Delete theme='outline' size='12' />}
                loading={busyId === row.id}
              >
                {t('fleet.templateLibrary.unpublishButton', { defaultValue: 'Unpublish' })}
              </Button>
            </Popconfirm>
          );
        }
        return (
          <Button
            size='small'
            type='primary'
            icon={<Upload theme='outline' size='12' />}
            loading={busyId === row.id}
            onClick={() => void handlePublish(row.id)}
          >
            {t('fleet.templateLibrary.publishButton', { defaultValue: 'Publish' })}
          </Button>
        );
      },
    },
  ];

  const hasAny = publishable.length > 0;

  return (
    <div className='bg-2 rd-16px overflow-hidden mt-4'>
      <div className='px-4 py-3 flex items-center justify-between border-b-1 border-border-2'>
        <div>
          <div className='text-14px font-medium'>
            {t('fleet.templateLibrary.title', { defaultValue: 'Template Library' })}
          </div>
          <div className='text-11px text-t-tertiary mt-1'>
            {t('fleet.templateLibrary.subtitle', {
              defaultValue: 'Publish local gallery templates to the fleet. Slaves pick up changes within 30 seconds.',
            })}
          </div>
        </div>
        <Button size='small' icon={<Refresh theme='outline' size='12' />} onClick={() => void refresh()}>
          {t('fleet.templateLibrary.refresh', { defaultValue: 'Refresh' })}
        </Button>
      </div>
      {!loading && !hasAny ? (
        <Empty
          className='py-6'
          description={t('fleet.templateLibrary.empty', {
            defaultValue: 'No local templates to publish. Create one in the Agents Gallery first.',
          })}
        />
      ) : (
        <Table
          columns={columns as never}
          data={publishable}
          loading={loading}
          rowKey='id'
          pagination={false}
          size='small'
        />
      )}
    </div>
  );
};

export default TemplateLibraryPanel;
