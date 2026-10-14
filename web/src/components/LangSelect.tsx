import { useId } from 'react';
import type { UiLang } from '../api/types';
import { useI18n } from '../i18n';
import { LANG_NAMES, LANGS } from '../i18n/core';

/** Language picker. Without `onChange` it only changes the local (signed-out) preference. */
export function LangSelect({
  onChange,
  disabled,
  showLabel = true,
}: {
  onChange?: (v: UiLang) => void;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const { t, uiLang, setUiLang } = useI18n();
  const id = useId();
  return (
    <div className={showLabel ? 'field' : 'lang-inline'}>
      <label htmlFor={id} className={showLabel ? 'field-label' : 'sr-only'}>
        {t('settings.lang.title')}
      </label>
      <select
        id={id}
        className="input select"
        value={uiLang}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value as UiLang;
          if (onChange) onChange(v);
          else setUiLang(v);
        }}
      >
        <option value="auto">{t('settings.lang.auto')}</option>
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {LANG_NAMES[l]}
          </option>
        ))}
      </select>
    </div>
  );
}
