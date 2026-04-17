/**
 * @license Apache-2.0
 * FleetModeSwitcher — modal for changing fleet mode post-install.
 *
 * Mirrors the SetupWizard's mode picker + per-mode config screens, but
 * with a different endpoint: mode change requires an app restart to
 * cleanly rebuild the UI tree (the sidebar gating changes, the router
 * guards flip, SWR caches would need a deep invalidation otherwise).
 *
 * Flow:
 *   1. Pick the new mode (pre-selected to current)
 *   2. Configure mode-specific fields (port / URL / token)
 *   3. Confirm + restart
 *
 * If the user picks the SAME mode they already have, the modal closes
 * without writing or restarting — no-op guard.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Button, Input, InputNumber, Message, Modal, Radio } from '@arco-design/web-react';
import { Computer, Server, Link } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { FleetConfig, FleetMode, FleetSetupInput } from '@/common/types/fleetTypes';
import ModeCard from './SetupWizard/ModeCard';

interface FleetModeSwitcherProps {
  visible: boolean;
  onClose: () => void;
  currentConfig: FleetConfig | undefined;
}

type Screen = 'pick' | 'configure' | 'confirm';

const HTTP_PREFIX_REGEX = /^https?:\/\//i;
const HTTP_INSECURE_REGEX = /^http:\/\//i;

const FleetModeSwitcher: React.FC<FleetModeSwitcherProps> = ({ visible, onClose, currentConfig }) => {
  const { t } = useTranslation();
  const currentMode: FleetMode = currentConfig?.mode ?? 'regular';
  const [screen, setScreen] = useState<Screen>('pick');
  const [selectedMode, setSelectedMode] = useState<FleetMode>(currentMode);
  const [masterPort, setMasterPort] = useState(currentConfig?.master?.port ?? 8888);
  const [masterBindAll, setMasterBindAll] = useState(currentConfig?.master?.bindAll ?? false);
  const [slaveMasterUrl, setSlaveMasterUrl] = useState(currentConfig?.slave?.masterUrl ?? '');
  const [slaveToken, setSlaveToken] = useState('');
  const [skipSlaveSetup, setSkipSlaveSetup] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset internal state when modal reopens (keeps re-use clean)
  const resetToCurrent = useCallback(() => {
    setScreen('pick');
    setSelectedMode(currentMode);
    setMasterPort(currentConfig?.master?.port ?? 8888);
    setMasterBindAll(currentConfig?.master?.bindAll ?? false);
    setSlaveMasterUrl(currentConfig?.slave?.masterUrl ?? '');
    setSlaveToken('');
    setSkipSlaveSetup(false);
    setSubmitting(false);
  }, [currentMode, currentConfig]);

  const handleClose = useCallback(() => {
    resetToCurrent();
    onClose();
  }, [onClose, resetToCurrent]);

  const masterPortError = useMemo(() => {
    if (selectedMode !== 'master') return null;
    if (!Number.isInteger(masterPort) || masterPort < 1 || masterPort > 65535) {
      return t('fleet.wizard.master.portInvalid');
    }
    return null;
  }, [selectedMode, masterPort, t]);

  const slaveUrlError = useMemo(() => {
    if (selectedMode !== 'slave' || skipSlaveSetup || slaveMasterUrl.length === 0) return null;
    if (!HTTP_PREFIX_REGEX.test(slaveMasterUrl)) return t('fleet.wizard.slave.urlInvalid');
    return null;
  }, [selectedMode, skipSlaveSetup, slaveMasterUrl, t]);

  const slaveTokenError = useMemo(() => {
    if (selectedMode !== 'slave' || skipSlaveSetup || slaveToken.length === 0) return null;
    if (slaveToken.length < 16) return t('fleet.wizard.slave.tokenShort');
    return null;
  }, [selectedMode, skipSlaveSetup, slaveToken, t]);

  const canProceedFromConfigure =
    selectedMode === 'master'
      ? masterPortError === null
      : selectedMode === 'slave'
        ? skipSlaveSetup || (slaveUrlError === null && slaveTokenError === null)
        : true;

  const handlePickContinue = useCallback(() => {
    // No-op guard: picking the same mode just closes.
    if (selectedMode === currentMode && selectedMode === 'regular') {
      handleClose();
      return;
    }
    if (selectedMode === 'regular') {
      setScreen('confirm');
      return;
    }
    setScreen('configure');
  }, [selectedMode, currentMode, handleClose]);

  const handleConfigureContinue = useCallback(() => {
    setScreen('confirm');
  }, []);

  const handleApply = useCallback(async () => {
    setSubmitting(true);
    try {
      const payload: FleetSetupInput = { mode: selectedMode };
      if (selectedMode === 'master') {
        payload.masterPort = masterPort;
        payload.masterBindAll = masterBindAll;
      }
      if (selectedMode === 'slave' && !skipSlaveSetup) {
        if (slaveMasterUrl.length > 0) payload.slaveMasterUrl = slaveMasterUrl;
        if (slaveToken.length > 0) payload.slaveEnrollmentToken = slaveToken;
      }
      const result = await ipcBridge.fleet.setMode.invoke(payload);
      if (result.ok === false) {
        Message.error(result.error);
        setSubmitting(false);
        return;
      }
      // Restart the app so the sidebar gating + router guards rebuild
      // cleanly. No point trying to hot-swap — mode changes are rare.
      await ipcBridge.application.restart.invoke();
    } catch (e) {
      Message.error(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [selectedMode, masterPort, masterBindAll, slaveMasterUrl, slaveToken, skipSlaveSetup]);

  return (
    <Modal
      visible={visible}
      maskClosable={false}
      onCancel={handleClose}
      footer={null}
      title={null}
      style={{ width: 720 }}
    >
      <div className='p-6'>
        {screen === 'pick' && (
          <>
            <h1 className='text-xl font-semibold mb-2 text-t-primary'>{t('fleet.settings.changeConfirm.title')}</h1>
            <p className='text-sm text-t-secondary mb-6'>{t('fleet.wizard.subtitle')}</p>

            <div className='grid grid-cols-3 gap-4 mb-6'>
              <ModeCard
                mode='regular'
                title={t('fleet.mode.regular.name')}
                description={t('fleet.mode.regular.description')}
                icon={<Computer theme='outline' size='24' />}
                selected={selectedMode === 'regular'}
                onSelect={setSelectedMode}
              />
              <ModeCard
                mode='master'
                title={t('fleet.mode.master.name')}
                description={t('fleet.mode.master.description')}
                icon={<Server theme='outline' size='24' />}
                selected={selectedMode === 'master'}
                onSelect={setSelectedMode}
              />
              <ModeCard
                mode='slave'
                title={t('fleet.mode.slave.name')}
                description={t('fleet.mode.slave.description')}
                icon={<Link theme='outline' size='24' />}
                selected={selectedMode === 'slave'}
                onSelect={setSelectedMode}
              />
            </div>

            <div className='flex items-center justify-between'>
              <Button type='text' onClick={handleClose}>
                {t('fleet.wizard.back')}
              </Button>
              <Button type='primary' onClick={handlePickContinue} disabled={submitting}>
                {t('fleet.wizard.continue')}
              </Button>
            </div>
          </>
        )}

        {screen === 'configure' && selectedMode === 'master' && (
          <>
            <h1 className='text-xl font-semibold mb-2 text-t-primary'>{t('fleet.wizard.master.title')}</h1>
            <p className='text-sm text-t-secondary mb-6'>{t('fleet.wizard.master.subtitle')}</p>

            <div className='mb-5'>
              <label className='text-sm text-t-primary font-medium block mb-2'>
                {t('fleet.wizard.master.portLabel')}
              </label>
              <InputNumber
                value={masterPort}
                onChange={(value) => setMasterPort(typeof value === 'number' ? value : 8888)}
                min={1}
                max={65535}
                style={{ width: 180 }}
              />
              {masterPortError && <p className='text-xs text-danger mt-1'>{masterPortError}</p>}
            </div>

            <div className='mb-5'>
              <label className='text-sm text-t-primary font-medium block mb-2'>
                {t('fleet.wizard.master.bindLabel')}
              </label>
              <Radio.Group
                value={masterBindAll ? 'all' : 'local'}
                onChange={(value) => setMasterBindAll(value === 'all')}
                direction='vertical'
              >
                <Radio value='local'>
                  <div className='py-1'>
                    <div className='text-sm text-t-primary'>{t('fleet.wizard.master.bindLocalName')}</div>
                    <div className='text-xs text-t-tertiary'>{t('fleet.wizard.master.bindLocalDesc')}</div>
                  </div>
                </Radio>
                <Radio value='all'>
                  <div className='py-1'>
                    <div className='text-sm text-t-primary'>{t('fleet.wizard.master.bindAllName')}</div>
                    <div className='text-xs text-t-tertiary'>{t('fleet.wizard.master.bindAllDesc')}</div>
                  </div>
                </Radio>
              </Radio.Group>
            </div>

            {masterBindAll && (
              <Alert type='info' content={t('fleet.wizard.master.firewallHint')} className='mb-5' showIcon />
            )}

            <div className='flex items-center justify-between'>
              <Button type='text' onClick={() => setScreen('pick')}>
                {t('fleet.wizard.back')}
              </Button>
              <Button type='primary' disabled={!canProceedFromConfigure} onClick={handleConfigureContinue}>
                {t('fleet.wizard.continue')}
              </Button>
            </div>
          </>
        )}

        {screen === 'configure' && selectedMode === 'slave' && (
          <>
            <h1 className='text-xl font-semibold mb-2 text-t-primary'>{t('fleet.wizard.slave.title')}</h1>
            <p className='text-sm text-t-secondary mb-6'>{t('fleet.wizard.slave.subtitle')}</p>

            <div className='mb-4'>
              <label className='text-sm text-t-primary font-medium block mb-2'>
                {t('fleet.wizard.slave.urlLabel')}
              </label>
              <Input
                value={slaveMasterUrl}
                onChange={setSlaveMasterUrl}
                disabled={skipSlaveSetup}
                placeholder={t('fleet.wizard.slave.urlPlaceholder')}
              />
              {slaveUrlError && <p className='text-xs text-danger mt-1'>{slaveUrlError}</p>}
              {slaveMasterUrl.length > 0 && HTTP_INSECURE_REGEX.test(slaveMasterUrl) && !skipSlaveSetup && (
                <p className='text-xs text-warning mt-1'>{t('fleet.wizard.slave.httpWarning')}</p>
              )}
            </div>

            <div className='mb-4'>
              <label className='text-sm text-t-primary font-medium block mb-2'>
                {t('fleet.wizard.slave.tokenLabel')}
              </label>
              <Input.Password
                value={slaveToken}
                onChange={setSlaveToken}
                disabled={skipSlaveSetup}
                placeholder={t('fleet.wizard.slave.tokenPlaceholder')}
              />
              {slaveTokenError && <p className='text-xs text-danger mt-1'>{slaveTokenError}</p>}
            </div>

            <label className='flex items-center gap-2 mb-5 cursor-pointer text-sm text-t-secondary'>
              <input
                type='checkbox'
                checked={skipSlaveSetup}
                onChange={(e) => setSkipSlaveSetup(e.target.checked)}
                className='cursor-pointer'
              />
              {t('fleet.wizard.slave.skipLater')}
            </label>

            <Alert type='info' content={t('fleet.wizard.slave.phaseANote')} className='mb-5' showIcon />

            <div className='flex items-center justify-between'>
              <Button type='text' onClick={() => setScreen('pick')}>
                {t('fleet.wizard.back')}
              </Button>
              <Button type='primary' disabled={!canProceedFromConfigure} onClick={handleConfigureContinue}>
                {t('fleet.wizard.continue')}
              </Button>
            </div>
          </>
        )}

        {screen === 'confirm' && (
          <>
            <h1 className='text-xl font-semibold mb-2 text-t-primary'>{t('fleet.settings.changeConfirm.title')}</h1>
            <p className='text-sm text-t-secondary mb-5'>{t('fleet.settings.changeConfirm.body')}</p>

            <div className='bg-fill-2 rd-8px p-3 mb-5'>
              <div className='text-xs text-t-tertiary mb-1'>{t('fleet.settings.currentLabel')}</div>
              <div className='text-sm text-t-primary font-medium mb-2'>
                {t(`fleet.mode.${currentMode}.name`)} → {t(`fleet.mode.${selectedMode}.name`)}
              </div>
            </div>

            <div className='flex items-center justify-between'>
              <Button type='text' onClick={handleClose} disabled={submitting}>
                {t('fleet.settings.changeConfirm.restartLater')}
              </Button>
              <Button type='primary' onClick={() => void handleApply()} loading={submitting}>
                {t('fleet.settings.changeConfirm.restartNow')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default FleetModeSwitcher;
