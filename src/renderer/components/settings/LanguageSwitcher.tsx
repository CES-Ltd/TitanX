import AionSelect from '@/renderer/components/base/AionSelect';
import type { SelectHandle } from '@arco-design/web-react/es/Select/interface';
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage } from '@/renderer/services/i18n';

const LANGUAGES = [
  { code: 'en-US', flag: '🇺🇸', name: 'English' },
  { code: 'zh-CN', flag: '🇨🇳', name: '简体中文' },
  { code: 'zh-TW', flag: '🇹🇼', name: '繁體中文' },
  { code: 'ja-JP', flag: '🇯🇵', name: '日本語' },
  { code: 'ko-KR', flag: '🇰🇷', name: '한국어' },
  { code: 'tr-TR', flag: '🇹🇷', name: 'Türkçe' },
  { code: 'es-ES', flag: '🇪🇸', name: 'Español' },
  { code: 'fr-FR', flag: '🇫🇷', name: 'Français' },
  { code: 'it-IT', flag: '🇮🇹', name: 'Italiano' },
  { code: 'hi-IN', flag: '🇮🇳', name: 'हिन्दी' },
];

const LanguageSwitcher: React.FC = () => {
  const { i18n } = useTranslation();
  const selectRef = useRef<SelectHandle>(null);

  const handleLanguageChange = useCallback((value: string) => {
    selectRef.current?.blur?.();

    const applyLanguage = () => {
      changeLanguage(value).catch((error: Error) => {
        console.error('Failed to change language:', error);
      });
    };

    if (typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(applyLanguage));
    } else {
      setTimeout(applyLanguage, 0);
    }
  }, []);

  return (
    <div className='flex items-center gap-8px'>
      <AionSelect ref={selectRef} className='w-200px' value={i18n.language} onChange={handleLanguageChange}>
        {LANGUAGES.map((lang) => (
          <AionSelect.Option key={lang.code} value={lang.code}>
            <span className='flex items-center gap-6px'>
              <span className='text-16px leading-none'>{lang.flag}</span>
              <span>{lang.name}</span>
            </span>
          </AionSelect.Option>
        ))}
      </AionSelect>
    </div>
  );
};

export default LanguageSwitcher;
