/**
 * @license Apache-2.0
 * TitanX About page — branding, version, links, attribution.
 */

import { Divider, Typography, Button, Switch } from '@arco-design/web-react';
import { Github, Right } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';
import { useSettingsViewMode } from '../settingsViewContext';
import { isElectronDesktop, openExternalUrl } from '@/renderer/utils/platform';
import packageJson from '../../../../../../package.json';
import cesLogo from '@renderer/assets/logos/brand/app.png';

const AboutModalContent: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const isElectron = isElectronDesktop();

  const [includePrerelease, setIncludePrerelease] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('update.includePrerelease');
    setIncludePrerelease(saved === 'true');
  }, []);

  const handlePrereleaseChange = (val: boolean) => {
    setIncludePrerelease(val);
    localStorage.setItem('update.includePrerelease', String(val));
  };

  const openLink = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch (error) {
      console.log('Failed to open link:', error);
    }
  };

  const checkUpdate = () => {
    window.dispatchEvent(new CustomEvent('aionui-open-update-modal', { detail: { source: 'about' } }));
  };

  const linkItems = [
    {
      title: t('settings.helpDocumentation'),
      url: 'https://github.com/CES-Ltd/TitanX/wiki',
      icon: <Right theme='outline' size='16' />,
    },
    {
      title: t('settings.updateLog'),
      url: 'https://github.com/CES-Ltd/TitanX/releases',
      icon: <Right theme='outline' size='16' />,
    },
    {
      title: t('settings.feedback'),
      url: 'https://github.com/CES-Ltd/TitanX/issues',
      icon: <Right theme='outline' size='16' />,
    },
    {
      title: t('settings.officialWebsite'),
      url: 'https://cesltd.com',
      icon: <Right theme='outline' size='16' />,
    },
  ];

  return (
    <div className='flex flex-col h-full w-full'>
      <div
        className={classNames(
          'flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-24px',
          isPageMode && 'px-0 overflow-visible'
        )}
      >
        <div className='flex flex-col max-w-500px mx-auto'>
          {/* App Info Section */}
          <div className='flex flex-col items-center pb-24px'>
            {/* High-res CES logo */}
            <img
              src={cesLogo}
              alt='TitanX'
              className='w-80px h-80px object-contain mb-12px'
              style={{ borderRadius: 16 }}
            />
            <Typography.Title heading={3} className='text-24px font-bold text-t-primary mb-4px'>
              TitanX
            </Typography.Title>
            <Typography.Text className='text-13px text-t-secondary mb-8px text-center max-w-400px'>
              {t('settings.appDescription')}
            </Typography.Text>
            <Typography.Text className='text-11px text-t-quaternary mb-12px text-center italic'>
              {t('settings.appTagline')}
            </Typography.Text>
            <div className='flex items-center justify-center gap-8px mb-16px'>
              <span className='px-10px py-4px rd-6px text-13px bg-fill-2 text-t-primary font-500'>
                v{packageJson.version}
              </span>
              <div
                className='text-t-primary cursor-pointer hover:text-t-secondary transition-colors p-4px'
                onClick={() =>
                  openLink('https://github.com/CES-Ltd/TitanX').catch((error) =>
                    console.error('Failed to open link:', error)
                  )
                }
              >
                <Github theme='outline' size='20' />
              </div>
            </div>

            {/* Check Update Section */}
            {isElectron && (
              <div className='flex flex-col items-center gap-12px w-full max-w-300px bg-fill-2 p-16px rounded-lg'>
                <Button type='primary' long onClick={checkUpdate}>
                  {t('settings.checkForUpdates')}
                </Button>
                <div className='flex items-center justify-between w-full'>
                  <Typography.Text className='text-12px text-t-secondary'>
                    {t('settings.includePrereleaseUpdates')}
                  </Typography.Text>
                  <Switch size='small' checked={includePrerelease} onChange={handlePrereleaseChange} />
                </div>
              </div>
            )}
          </div>

          {/* Divider */}
          <Divider className='my-16px' />

          {/* Links Section */}
          <div className='flex flex-col gap-4px pt-8px'>
            {linkItems.map((item, index) => (
              <div
                key={index}
                className='flex items-center justify-between px-16px py-12px rd-8px hover:bg-fill-2 transition-all cursor-pointer group'
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openLink(item.url).catch((error) => console.error('Failed to open link:', error));
                }}
              >
                <Typography.Text className='text-14px text-t-primary'>{item.title}</Typography.Text>
                <div className='text-t-secondary group-hover:text-t-primary transition-colors'>{item.icon}</div>
              </div>
            ))}
          </div>

          {/* Attribution */}
          <Divider className='my-16px' />
          <div className='text-center pb-16px'>
            <Typography.Text className='text-11px text-t-quaternary'>
              Built on{' '}
              <span
                className='text-t-secondary cursor-pointer hover:underline'
                onClick={() => openLink('https://github.com/iOfficeAI/AionUi').catch(console.error)}
              >
                AionUI
              </span>{' '}
              &mdash; the open-source AI cowork platform
            </Typography.Text>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AboutModalContent;
