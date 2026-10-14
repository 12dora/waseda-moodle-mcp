// Fills [data-i18n] text and [data-i18n-placeholder] attributes from _locales.
export function applyI18n(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = chrome.i18n.getMessage(el.dataset.i18nPlaceholder);
  }
}
export const t = (key, subs) => chrome.i18n.getMessage(key, subs);
