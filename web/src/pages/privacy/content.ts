import type { Lang } from '../../i18n/core';
import { en } from './en';
import { ja } from './ja';
import type { PrivacyDoc } from './types';
import { zhCN } from './zh-CN';

/** Effective date of docs/privacy.md (keep in sync when the policy changes). */
export const PRIVACY_EFFECTIVE_DATE = '2026-10-15';

export const PRIVACY_DOCS: Record<Lang, PrivacyDoc> = { en, ja, 'zh-CN': zhCN };
