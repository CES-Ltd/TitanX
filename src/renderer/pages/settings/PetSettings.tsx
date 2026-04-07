/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Radio, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { systemSettings } from '@/common/adapter/ipcBridge';
import SettingsPageWrapper from './components/SettingsPageWrapper';
import PreferenceRow from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useSettingsViewMode } from '@/renderer/components/settings/SettingsModal/settingsViewContext';

const PET_THEMES = [
  { key: 'default', label: 'Default Blob', emoji: '🟣' },
  { key: 'cat', label: 'Cat', emoji: '🐱' },
  { key: 'wizard', label: 'Wizard', emoji: '🧙' },
  { key: 'robot', label: 'Robot', emoji: '🤖' },
  { key: 'ninja', label: 'Ninja', emoji: '🥷' },
];

const PetSettings: React.FC = () => {
  const [enabled, setEnabled] = useState(true);
  const [size, setSize] = useState(280);
  const [theme, setTheme] = useState('default');
  const [dnd, setDnd] = useState(false);
  const [confirmEnabled, setConfirmEnabled] = useState(true);
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';

  // Load initial values
  useEffect(() => {
    systemSettings.getPetEnabled
      .invoke()
      .then((val) => setEnabled(val))
      .catch(() => {});
  }, []);

  useEffect(() => {
    systemSettings.getPetTheme
      .invoke()
      .then((val) => setTheme(val))
      .catch(() => {});
  }, []);

  useEffect(() => {
    systemSettings.getPetSize
      .invoke()
      .then((val) => setSize(val))
      .catch(() => {});
  }, []);

  useEffect(() => {
    systemSettings.getPetDnd
      .invoke()
      .then((val) => setDnd(val))
      .catch(() => {});
  }, []);

  useEffect(() => {
    systemSettings.getPetConfirmEnabled
      .invoke()
      .then((val) => setConfirmEnabled(val))
      .catch(() => {});
  }, []);

  const handleEnabledChange = useCallback((checked: boolean) => {
    setEnabled(checked);
    systemSettings.setPetEnabled.invoke({ enabled: checked }).catch(() => {
      setEnabled(!checked);
    });
  }, []);

  const handleThemeChange = useCallback(
    (val: string) => {
      const prevTheme = theme;
      setTheme(val);
      systemSettings.setPetTheme.invoke({ theme: val }).catch(() => {
        setTheme(prevTheme);
      });
    },
    [theme]
  );

  const handleSizeChange = useCallback(
    (val: number) => {
      const prevSize = size;
      setSize(val);
      systemSettings.setPetSize.invoke({ size: val }).catch(() => {
        setSize(prevSize);
      });
    },
    [size]
  );

  const handleDndChange = useCallback((checked: boolean) => {
    setDnd(checked);
    systemSettings.setPetDnd.invoke({ dnd: checked }).catch(() => {
      setDnd(!checked);
    });
  }, []);

  const handleConfirmEnabledChange = useCallback((checked: boolean) => {
    setConfirmEnabled(checked);
    systemSettings.setPetConfirmEnabled.invoke({ enabled: checked }).catch(() => {
      setConfirmEnabled(!checked);
    });
  }, []);

  const preferenceItems = [
    {
      key: 'enabled',
      label: t('pet.enable'),
      component: <Switch checked={enabled} onChange={handleEnabledChange} />,
    },
    {
      key: 'theme',
      label: t('pet.theme', 'Character'),
      component: (
        <Radio.Group value={theme} onChange={handleThemeChange} disabled={!enabled}>
          {PET_THEMES.map((pt) => (
            <Radio key={pt.key} value={pt.key}>
              <span className='text-13px'>
                {pt.emoji} {pt.label}
              </span>
            </Radio>
          ))}
        </Radio.Group>
      ),
    },
    {
      key: 'size',
      label: t('pet.size'),
      component: (
        <Radio.Group value={size} onChange={handleSizeChange} disabled={!enabled}>
          <Radio value={200}>{t('pet.sizeSmall', { px: 200 })}</Radio>
          <Radio value={280}>{t('pet.sizeMedium', { px: 280 })}</Radio>
          <Radio value={360}>{t('pet.sizeLarge', { px: 360 })}</Radio>
        </Radio.Group>
      ),
    },
    {
      key: 'dnd',
      label: t('pet.dnd'),
      description: t('pet.dndDescription'),
      component: <Switch checked={dnd} onChange={handleDndChange} disabled={!enabled} />,
    },
    {
      key: 'confirmBubble',
      label: t('pet.confirmBubble'),
      description: t('pet.confirmBubbleDescription'),
      component: <Switch checked={confirmEnabled} onChange={handleConfirmEnabledChange} disabled={!enabled} />,
    },
  ];

  return (
    <SettingsPageWrapper>
      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <div className='space-y-16px'>
          <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px space-y-12px'>
            <div className='w-full flex flex-col divide-y divide-border-2'>
              {preferenceItems.map((item) => (
                <PreferenceRow key={item.key} label={item.label} description={item.description}>
                  {item.component}
                </PreferenceRow>
              ))}
            </div>
          </div>
        </div>
      </AionScrollArea>
    </SettingsPageWrapper>
  );
};

export default PetSettings;
