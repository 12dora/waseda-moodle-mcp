import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { UiLang } from '../api/types';
import { DICTIONARIES, type Lang, resolveLang, type Translate, translate } from './core';

export type { MessageKey } from './core';

const STORAGE_KEY = 'wmm.uiLang';

function readStored(): UiLang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'ja' || v === 'en' || v === 'zh-CN' || v === 'auto' ? v : null;
  } catch {
    return null;
  }
}

function browserLangs(): string[] {
  return typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language].filter(Boolean);
}

export interface I18n {
  lang: Lang;
  uiLang: UiLang;
  setUiLang: (v: UiLang) => void;
  t: Translate;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [uiLang, setUiLangState] = useState<UiLang>(() => readStored() ?? 'auto');
  const lang = resolveLang(uiLang, browserLangs());

  const setUiLang = useCallback((v: UiLang) => {
    setUiLangState(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // storage unavailable: setting still applies for this page load
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<I18n>(() => {
    const dict = DICTIONARIES[lang];
    return { lang, uiLang, setUiLang, t: (key, vars) => translate(dict, key, vars) };
  }, [lang, uiLang, setUiLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export function useT() {
  return useI18n().t;
}
