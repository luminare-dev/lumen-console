import { de } from './de';
import { en } from './en';

export type Language = 'en' | 'de';
export type MessageKey = keyof typeof en;
export type MessageParams = Record<string, string | number>;
export type Translate = (key: MessageKey, params?: MessageParams) => string;

export const LANGUAGES: Language[] = ['en', 'de'];
const MESSAGES: Record<Language, Record<MessageKey, string>> = { en, de };

// A placeholder is a single-brace lower-case name: {count}, {host}.
const PLACEHOLDER = /\{([a-z]+)\}/g;

/** Picks the first supported language from the device's preferred language codes; else English. */
export function pickLanguage(preferred: readonly (string | null | undefined)[]): Language {
  for (const code of preferred) {
    const base = (code ?? '').toLowerCase().split(/[-_]/)[0];
    if ((LANGUAGES as string[]).includes(base)) return base as Language;
  }
  return 'en';
}

/**
 * Returns the translator for a language. A placeholder without a parameter stays in the text, so
 * a missing value is visible instead of silently dropped.
 */
export function translator(language: Language): Translate {
  const messages = MESSAGES[language];
  return (key, params = {}) =>
    (messages[key] ?? en[key]).replace(PLACEHOLDER, (match: string, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    );
}

/** Formats a date for the language (day, month, year). */
export function formatDate(iso: string | undefined, language: Language): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(language === 'de' ? 'de-AT' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Formats a date and time for the language. */
export function formatDateTime(iso: string | undefined, language: Language): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(language === 'de' ? 'de-AT' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Bytes with binary units (the panel counts 1 MiB as 1024 × 1024 bytes). */
export function formatBytes(bytes: number | undefined, language: Language): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(language === 'de' ? 'de-AT' : 'en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${units[unit]}`;
}

/** A duration in milliseconds as "3 h 25 min", "4 min" or "12 s". */
export function formatDuration(ms: number | undefined, language: Language): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const day = language === 'de' ? 'd' : 'd';
  if (d > 0) return `${d} ${day} ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

/** A limit in MiB as bytes text, or the word for unlimited when it is 0. */
export function formatMiB(mib: number, language: Language, unlimited: string): string {
  return mib > 0 ? formatBytes(mib * 1024 * 1024, language) : unlimited;
}

/** A number with one decimal for the language ("12.5" / "12,5"). */
export function formatNumber(value: number, language: Language, digits = 1): string {
  return value.toLocaleString(language === 'de' ? 'de-AT' : 'en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
