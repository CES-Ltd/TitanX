/**
 * @license Apache-2.0
 * Fleet page — master-only. Phase A placeholder.
 *
 * v1.9.26 ships only the mode infrastructure. The actual fleet features
 * (device roster, config sync, cost aggregation, forced updates) arrive
 * in v1.9.27+ per the phased plan in docs/tech/team.md.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { DataServer } from '@icon-park/react';

const FleetPage: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col items-center justify-center h-full min-h-400px w-full p-6 text-center'>
      <div className='flex items-center justify-center w-20 h-20 rd-full bg-[rgba(var(--primary-6),0.08)] mb-4'>
        <DataServer theme='outline' size='36' className='text-primary' />
      </div>
      <h1 className='text-xl font-semibold text-t-primary mb-2'>{t('fleet.master.placeholder.title')}</h1>
      <p className='text-sm text-t-secondary max-w-500px leading-relaxed'>{t('fleet.master.placeholder.body')}</p>
    </div>
  );
};

export default FleetPage;
