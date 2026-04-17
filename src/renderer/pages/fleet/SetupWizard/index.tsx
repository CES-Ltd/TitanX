/**
 * @license Apache-2.0
 * SetupWizard — first-run modal that picks the fleet mode.
 *
 * Flow (3 screens):
 *   1. Welcome + three-card mode picker
 *   2. Mode-specific config (skipped for Regular):
 *        master → port + bind-all choice
 *        slave  → master URL + enrollment token (or "set up later")
 *   3. Confirmation + Launch button
 *
 * Modal is full-screen, mask-locked (no escape / outer click dismiss),
 * and only closable via completeSetup or cancel. The main app UI
 * renders behind it once it closes.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Message, Modal, Button, Input, Radio, InputNumber, Alert } from '@arco-design/web-react';
import { Computer, Server, Link } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { FleetMode, FleetSetupInput } from '@/common/types/fleetTypes';
import ModeCard from './ModeCard';

interface SetupWizardProps {
  visible: boolean;
  onComplete: () => void;
}

type Screen = 'pick' | 'configure' | 'done';

const HTTP_PREFIX_REGEX = /^https?:\/\//i;
const HTTP_INSECURE_REGEX = /^http:\/\//i;

const SetupWizard: React.FC<SetupWizardProps> = ({ visible, onComplete }) => {
  const { t } = useTranslation('fleet');
  const [screen, setScreen] = useState<Screen>('pick');
  const [mode, setMode] = useState<FleetMode | null>(null);
  const [masterPort, setMasterPort] = useState(8888);
  const [masterBindAll, setMasterBindAll] = useState(false);
  const [slaveMasterUrl, setSlaveMasterUrl] = useState('');
  const [slaveToken, setSlaveToken] = useState('');
  const [skipSlaveSetup, setSkipSlaveSetup] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setScreen('pick');
    setMode(null);
    setMasterPort(8888);
    setMasterBindAll(false);
    setSlaveMasterUrl('');
    setSlaveToken('');
    setSkipSlaveSetup(false);
    setSubmitting(false);
  }, []);

  const handleCancel = useCallback(async () => {
    // "Skip" button — write regular mode silently, skip setupCompletedAt
    setSubmitting(true);
    try {
      await ipcBridge.fleet.completeSetup.invoke({ mode: 'regular' });
      onComplete();
      reset();
    } catch (e) {
      Message.error(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [onComplete, reset]);

  const masterPortError = useMemo(() => {
    if (mode !== 'master') return null;
    if (!Number.isInteger(masterPort) || masterPort < 1 || masterPort > 65535) {
      return t('wizard.master.portInvalid');
    }
    return null;
  }, [mode, masterPort, t]);

  const slaveUrlError = useMemo(() => {
    if (mode !== 'slave' || skipSlaveSetup || slaveMasterUrl.length === 0) return null;
    if (!HTTP_PREFIX_REGEX.test(slaveMasterUrl)) return t('wizard.slave.urlInvalid');
    return null;
  }, [mode, skipSlaveSetup, slaveMasterUrl, t]);

  const slaveTokenError = useMemo(() => {
    if (mode !== 'slave' || skipSlaveSetup || slaveToken.length === 0) return null;
    if (slaveToken.length < 16) return t('wizard.slave.tokenShort');
    return null;
  }, [mode, skipSlaveSetup, slaveToken, t]);

  const canContinueFromConfigure =
    mode === 'master'
      ? masterPortError === null
      : mode === 'slave'
        ? skipSlaveSetup || (slaveUrlError === null && slaveTokenError === null)
        : true;

  const handlePickContinue = useCallback(() => {
    if (mode === null) return;
    if (mode === 'regular') {
      setScreen('done');
      return;
    }
    setScreen('configure');
  }, [mode]);

  const handleSubmit = useCallback(async () => {
    if (mode === null) return;
    setSubmitting(true);
    try {
      const payload: FleetSetupInput = { mode };
      if (mode === 'master') {
        payload.masterPort = masterPort;
        payload.masterBindAll = masterBindAll;
      }
      if (mode === 'slave' && !skipSlaveSetup) {
        if (slaveMasterUrl.length > 0) payload.slaveMasterUrl = slaveMasterUrl;
        if (slaveToken.length > 0) payload.slaveEnrollmentToken = slaveToken;
      }
      const result = await ipcBridge.fleet.completeSetup.invoke(payload);
      if (result.ok === false) {
        Message.error(result.error);
        setSubmitting(false);
        return;
      }
      setScreen('done');
      setSubmitting(false);
    } catch (e) {
      Message.error(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [mode, masterPort, masterBindAll, slaveMasterUrl, slaveToken, skipSlaveSetup]);

  const handleLaunch = useCallback(() => {
    onComplete();
    reset();
  }, [onComplete, reset]);

  return (
    <Modal visible={visible} maskClosable={false} closable={false} footer={null} title={null} style={{ width: 720 }}>
      <div className='p-6'>
        {screen === 'pick' && (
          <>
            <h1 className='text-2xl font-semibold mb-2 text-t-primary'>{t('wizard.title')}</h1>
            <p className='text-sm text-t-secondary mb-6'>{t('wizard.subtitle')}</p>

            <div className='grid grid-cols-3 gap-4 mb-6'>
              <ModeCard
                mode='regular'
                title={t('mode.regular.name')}
                description={t('mode.regular.description')}
                icon={<Computer theme='outline' size='24' />}
                selected={mode === 'regular'}
                onSelect={setMode}
              />
              <ModeCard
                mode='master'
                title={t('mode.master.name')}
                description={t('mode.master.description')}
                icon={<Server theme='outline' size='24' />}
                selected={mode === 'master'}
                onSelect={setMode}
              />
              <ModeCard
                mode='slave'
                title={t('mode.slave.name')}
                description={t('mode.slave.description')}
                icon={<Link theme='outline' size='24' />}
                selected={mode === 'slave'}
                onSelect={setMode}
              />
            </div>

            <div className='flex items-center justify-between'>
              <Button type='text' onClick={() => void handleCancel()} loading={submitting}>
                {t('wizard.cancel')}
              </Button>
              <Button type='primary' disabled={mode === null} onClick={handlePickContinue}>
                {t('wizard.continue')}
              </Button>
            </div>
          </>
        )}

        {screen === 'configure' && mode === 'master' && (
          <>
            <h1 className='text-xl font-semibold mb-2 text-t-primary'>{t('wizard.master.title')}</h1>
            <p className='text-sm text-t-secondary mb-6'>{t('wizard.master.subtitle')}</p>

            <div className='mb-5'>
              <label className='text-sm text-t-primary font-medium block mb-2'>{t('wizard.master.portLabel')}</label>
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
              <label className='text-sm text-t-primary font-medium block mb-2'>{t('wizard.master.bindLabel')}</label>
              <Radio.Group
                value={masterBindAll ? 'all' : 'local'}
                onChange={(value) => setMasterBindAll(value === 'all')}
                direction='vertical'
              >
                <Radio value='local'>
                  <div className='py-1'>
                    <div className='text-sm text-t-primary'>{t('wizard.master.bindLocalName')}</div>
                    <div className='text-xs text-t-tertiary'>{t('wizard.master.bindLocalDesc')}</div>
                  </div>
                </Radio>
                <Radio value='all'>
                  <div className='py-1'>
                    <div className='text-sm text-t-primary'>{t('wizard.master.bindAllName')}</div>
                    <div className='text-xs text-t-tertiary'>{t('wizard.master.bindAllDesc')}</div>
                  </div>
                </Radio>
              </Radio.Group>
            </div>

            {masterBindAll && <Alert type='info' content={t('wizard.master.firewallHint')} className='mb-5' showIcon />}

            <div className='flex items-center justify-between'>
              <Button type='text' onClick={() => setScreen('pick')}>
                {t('wizard.back')}
              </Button>
              <Button
                type='primary'
                disabled={!canContinueFromConfigure}
                loading={submitting}
                onClick={() => void handleSubmit()}
              >
                {t('wizard.continue')}
              </Button>
            </div>
          </>
        )}

        {screen === 'configure' && mode === 'slave' && (
          <>
            <h1 className='text-xl font-semibold mb-2 text-t-primary'>{t('wizard.slave.title')}</h1>
            <p className='text-sm text-t-secondary mb-6'>{t('wizard.slave.subtitle')}</p>

            <div className='mb-4'>
              <label className='text-sm text-t-primary font-medium block mb-2'>{t('wizard.slave.urlLabel')}</label>
              <Input
                value={slaveMasterUrl}
                onChange={setSlaveMasterUrl}
                disabled={skipSlaveSetup}
                placeholder={t('wizard.slave.urlPlaceholder')}
              />
              {slaveUrlError && <p className='text-xs text-danger mt-1'>{slaveUrlError}</p>}
              {slaveMasterUrl.length > 0 && HTTP_INSECURE_REGEX.test(slaveMasterUrl) && !skipSlaveSetup && (
                <p className='text-xs text-warning mt-1'>{t('wizard.slave.httpWarning')}</p>
              )}
            </div>

            <div className='mb-4'>
              <label className='text-sm text-t-primary font-medium block mb-2'>{t('wizard.slave.tokenLabel')}</label>
              <Input.Password
                value={slaveToken}
                onChange={setSlaveToken}
                disabled={skipSlaveSetup}
                placeholder={t('wizard.slave.tokenPlaceholder')}
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
              {t('wizard.slave.skipLater')}
            </label>

            <Alert type='info' content={t('wizard.slave.phaseANote')} className='mb-5' showIcon />

            <div className='flex items-center justify-between'>
              <Button type='text' onClick={() => setScreen('pick')}>
                {t('wizard.back')}
              </Button>
              <Button
                type='primary'
                disabled={!canContinueFromConfigure}
                loading={submitting}
                onClick={() => void handleSubmit()}
              >
                {t('wizard.continue')}
              </Button>
            </div>
          </>
        )}

        {screen === 'done' && (
          <>
            <div className='flex flex-col items-center text-center py-6'>
              <div className='w-16 h-16 rd-full bg-[rgba(var(--success-6),0.12)] flex items-center justify-center mb-4'>
                <svg viewBox='0 0 24 24' className='w-8 h-8' fill='none' stroke='rgb(var(--success-6))' strokeWidth='3'>
                  <path d='M5 13l4 4L19 7' strokeLinecap='round' strokeLinejoin='round' />
                </svg>
              </div>
              <h1 className='text-xl font-semibold mb-2 text-t-primary'>{t('wizard.done')}</h1>
              <p className='text-sm text-t-secondary mb-2'>
                {t('settings.currentLabel')}:{' '}
                <span className='font-medium text-t-primary'>{mode ? t(`mode.${mode}.name`) : ''}</span>
              </p>
              <p className='text-xs text-t-tertiary mb-6 max-w-400px'>{t('wizard.doneSubtitle')}</p>
              <Button type='primary' size='large' onClick={handleLaunch}>
                {t('wizard.launch')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default SetupWizard;
