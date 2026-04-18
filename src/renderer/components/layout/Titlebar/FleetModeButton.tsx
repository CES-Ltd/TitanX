/**
 * @license Apache-2.0
 * FleetModeButton — titlebar control for switching between fleet modes
 * (regular / master / slave). Replaces the Settings-modal entry point
 * introduced in v1.9.26 because that modal ran into copy-fit issues at
 * common widths and buried a frequently-used control two clicks deep
 * (Settings → System → "Change mode…").
 *
 * Shape: mirrors `CavemanButton` — `Popover` + inline controls. The
 * popover is ~440px wide to fit the mode-specific config fields
 * inline (master port + bind-all toggle, slave URL + enrollment
 * token). Clicking "Save & restart" commits the change via
 * `ipcBridge.fleet.setMode` and then triggers `application.restart`
 * so the sidebar gating + router guards rebuild cleanly.
 *
 * Mode cards are collapsed into a single Radio column so the popover
 * fits side-by-side with the existing titlebar controls without
 * requiring a horizontal scroll on narrower windows.
 */

import React, { useCallback, useEffect, useState } from 'react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, InputNumber, Message, Popover, Radio, Tag, Tooltip } from '@arco-design/web-react';
import { Computer, Server, Link } from '@icon-park/react';
import { ipcBridge } from '@/common';
import type { FleetMode, FleetSetupInput } from '@/common/types/fleetTypes';

type Props = {
  iconSize: number;
  isMobile?: boolean;
};

const MODE_ICONS: Record<FleetMode, React.ReactNode> = {
  regular: <Computer theme='outline' size='14' />,
  master: <Server theme='outline' size='14' />,
  slave: <Link theme='outline' size='14' />,
};

const MODE_COLORS: Record<FleetMode, string | undefined> = {
  regular: undefined, // no glow for default mode
  master: 'blue',
  slave: 'green',
};

const FleetModeButton: React.FC<Props> = ({ iconSize, isMobile }) => {
  const { t } = useTranslation();
  const [currentMode, setCurrentMode] = useState<FleetMode>('regular');
  const [selectedMode, setSelectedMode] = useState<FleetMode>('regular');
  const [popVisible, setPopVisible] = useState(false);

  // Master-mode config fields
  const [masterPort, setMasterPort] = useState<number>(8888);
  const [masterBindAll, setMasterBindAll] = useState<boolean>(false);

  // Slave-mode config fields
  const [slaveMasterUrl, setSlaveMasterUrl] = useState<string>('');
  const [slaveToken, setSlaveToken] = useState<string>('');

  const [submitting, setSubmitting] = useState(false);

  // Sync current mode from the process every time the popover opens
  // so we never show stale state. Cheap call; IPC round-trip is <1ms.
  useEffect(() => {
    if (!popVisible) return;
    void ipcBridge.fleet.getMode.invoke().then((mode) => {
      setCurrentMode(mode);
      setSelectedMode(mode);
    });
  }, [popVisible]);

  const needsRestart = selectedMode !== currentMode;
  const slaveNeedsConfig =
    selectedMode === 'slave' && currentMode !== 'slave' && (slaveMasterUrl.length === 0 || slaveToken.length === 0);

  const handleApply = useCallback(async () => {
    setSubmitting(true);
    try {
      const payload: FleetSetupInput = { mode: selectedMode };
      if (selectedMode === 'master') {
        payload.masterPort = masterPort;
        payload.masterBindAll = masterBindAll;
      }
      if (selectedMode === 'slave') {
        if (slaveMasterUrl.length > 0) payload.slaveMasterUrl = slaveMasterUrl;
        if (slaveToken.length > 0) payload.slaveEnrollmentToken = slaveToken;
      }
      const result = await ipcBridge.fleet.setMode.invoke(payload);
      const outcome = result as { ok: boolean; error?: string };
      if (outcome.ok === false) {
        Message.error(outcome.error ?? 'Fleet mode change failed');
        setSubmitting(false);
        return;
      }
      // Mode changes restart — the router + sidebar gating is bound
      // to mode at boot, so in-place swap risks subtle inconsistencies.
      await ipcBridge.application.restart.invoke();
    } catch (e) {
      Message.error(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [selectedMode, masterPort, masterBindAll, slaveMasterUrl, slaveToken]);

  const isActive = currentMode !== 'regular';
  const glowColor = currentMode === 'master' ? '#3370FF' : currentMode === 'slave' ? '#00B42A' : undefined;

  const content = (
    <div style={{ width: 440, padding: 4 }}>
      <div className='flex items-center gap-2 mb-2' style={{ fontSize: 14, fontWeight: 600 }}>
        {MODE_ICONS[currentMode]}
        {t('fleet.topbar.title', { defaultValue: 'Fleet mode' })}
        {isActive && (
          <Tag size='small' color={MODE_COLORS[currentMode]}>
            {t(`fleet.mode.${currentMode}.name`, { defaultValue: currentMode })}
          </Tag>
        )}
      </div>
      <div className='text-11px text-t-tertiary mb-3'>
        {t('fleet.topbar.subtitle', {
          defaultValue: 'Switch between single-machine, organization master, and managed slave modes.',
        })}
      </div>

      <Radio.Group
        value={selectedMode}
        onChange={(v) => setSelectedMode(v as FleetMode)}
        direction='vertical'
        style={{ width: '100%' }}
      >
        {(['regular', 'master', 'slave'] as FleetMode[]).map((m) => (
          <Radio key={m} value={m}>
            <div className='flex items-start gap-2 py-1'>
              <span style={{ marginTop: 2 }}>{MODE_ICONS[m]}</span>
              <div className='flex-1 min-w-0'>
                <div className='text-13px font-medium'>{t(`fleet.mode.${m}.name`, { defaultValue: m })}</div>
                <div className='text-11px text-t-tertiary leading-tight'>
                  {t(`fleet.mode.${m}.description`, { defaultValue: '' })}
                </div>
              </div>
            </div>
          </Radio>
        ))}
      </Radio.Group>

      {/* Master-mode inline config */}
      {selectedMode === 'master' && (
        <div className='mt-3 p-2 bg-fill-2 rd-6px'>
          <div className='text-11px font-medium mb-1'>
            {t('fleet.wizard.master.portLabel', { defaultValue: 'Port' })}
          </div>
          <InputNumber
            value={masterPort}
            onChange={(v) => setMasterPort(typeof v === 'number' ? v : 8888)}
            min={1}
            max={65535}
            size='small'
            style={{ width: 140 }}
          />
          <div className='text-11px font-medium mt-2 mb-1'>
            {t('fleet.wizard.master.bindLabel', { defaultValue: 'Bind' })}
          </div>
          <Radio.Group
            value={masterBindAll ? 'all' : 'local'}
            onChange={(v) => setMasterBindAll(v === 'all')}
            size='small'
          >
            <Radio value='local'>
              <span className='text-12px'>
                {t('fleet.wizard.master.bindLocalName', { defaultValue: 'Localhost only' })}
              </span>
            </Radio>
            <Radio value='all'>
              <span className='text-12px'>
                {t('fleet.wizard.master.bindAllName', { defaultValue: 'All interfaces' })}
              </span>
            </Radio>
          </Radio.Group>
          {masterBindAll && (
            <Alert
              type='info'
              className='mt-2 text-11px'
              content={t('fleet.wizard.master.firewallHint', {
                defaultValue: 'Slaves on your network can reach this master. Check firewall rules.',
              })}
            />
          )}
        </div>
      )}

      {/* Slave-mode inline config — only shown when switching TO slave from
          a non-slave mode. Already-enrolled slaves just keep their state. */}
      {selectedMode === 'slave' && currentMode !== 'slave' && (
        <div className='mt-3 p-2 bg-fill-2 rd-6px space-y-2'>
          <div>
            <div className='text-11px font-medium mb-1'>
              {t('fleet.wizard.slave.urlLabel', { defaultValue: 'Master URL' })}
            </div>
            <Input
              value={slaveMasterUrl}
              onChange={setSlaveMasterUrl}
              size='small'
              placeholder='https://10.0.0.195:8888'
            />
          </div>
          <div>
            <div className='text-11px font-medium mb-1'>
              {t('fleet.wizard.slave.tokenLabel', { defaultValue: 'Enrollment token' })}
            </div>
            <Input.Password
              value={slaveToken}
              onChange={setSlaveToken}
              size='small'
              placeholder={t('fleet.wizard.slave.tokenPlaceholder', {
                defaultValue: 'Paste the one-time token from your admin',
              })}
            />
          </div>
        </div>
      )}

      {/* Action row — apply+restart when a change is pending, or dismiss */}
      <div className='mt-3 flex justify-end gap-2'>
        <Button size='small' onClick={() => setPopVisible(false)} disabled={submitting}>
          {t('fleet.topbar.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          size='small'
          type='primary'
          loading={submitting}
          disabled={!needsRestart || slaveNeedsConfig}
          onClick={() => void handleApply()}
        >
          {t('fleet.topbar.applyRestart', { defaultValue: 'Save & restart' })}
        </Button>
      </div>
      {needsRestart && (
        <div className='text-11px text-t-tertiary mt-2'>
          {t('fleet.topbar.restartHint', {
            defaultValue: 'Mode change requires a restart. Your teams and conversations are preserved.',
          })}
        </div>
      )}
    </div>
  );

  return (
    <Popover
      content={content}
      trigger='click'
      position='bottom'
      popupVisible={popVisible}
      onVisibleChange={setPopVisible}
    >
      <Tooltip
        content={
          isActive
            ? t('fleet.topbar.tooltipActive', {
                defaultValue: 'Fleet mode: {{mode}}',
                mode: t(`fleet.mode.${currentMode}.name`, { defaultValue: currentMode }),
              })
            : t('fleet.topbar.tooltip', { defaultValue: 'Fleet mode (Regular)' })
        }
        position='bottom'
        mini
      >
        <button
          type='button'
          className={classNames('app-titlebar__button', isMobile && 'app-titlebar__button--mobile')}
          aria-label='Fleet mode'
          style={isActive && glowColor ? { color: glowColor, filter: `drop-shadow(0 0 4px ${glowColor})` } : {}}
        >
          {/* Cast the icon size at render time so we don't stretch the 14px
              version defined in MODE_ICONS. */}
          {React.cloneElement(MODE_ICONS[currentMode] as React.ReactElement<{ size: string }>, {
            size: String(iconSize),
          })}
        </button>
      </Tooltip>
    </Popover>
  );
};

export default FleetModeButton;
