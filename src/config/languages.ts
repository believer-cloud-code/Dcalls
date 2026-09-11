export interface DcallsLanguage {
  code: string;
  name: string;
  flag: string;
  speechLocale: string;
}

export const DCALLS_LANGUAGES: DcallsLanguage[] = [
  { code: 'en', name: 'English',    flag: '🇺🇸', speechLocale: 'en-US' },
  { code: 'es', name: 'Spanish',    flag: '🇪🇸', speechLocale: 'es-ES' },
  { code: 'fr', name: 'French',     flag: '🇫🇷', speechLocale: 'fr-FR' },
  { code: 'de', name: 'German',     flag: '🇩🇪', speechLocale: 'de-DE' },
  { code: 'zh', name: 'Chinese',    flag: '🇨🇳', speechLocale: 'zh-CN' },
  { code: 'ja', name: 'Japanese',   flag: '🇯🇵', speechLocale: 'ja-JP' },
  { code: 'ko', name: 'Korean',     flag: '🇰🇷', speechLocale: 'ko-KR' },
  { code: 'ar', name: 'Arabic',     flag: '🇸🇦', speechLocale: 'ar-SA' },
  { code: 'pt', name: 'Portuguese', flag: '🇵🇹', speechLocale: 'pt-BR' },
  { code: 'ru', name: 'Russian',    flag: '🇷🇺', speechLocale: 'ru-RU' },
  { code: 'it', name: 'Italian',    flag: '🇮🇹', speechLocale: 'it-IT' },
  { code: 'sw', name: 'Swahili',    flag: '🇰🇪', speechLocale: 'sw-KE' },
  { code: 'hi', name: 'Hindi',      flag: '🇮🇳', speechLocale: 'hi-IN' },
];

export const DEFAULT_LANGUAGE =
  DCALLS_LANGUAGES.find(language => language.code === 'en') ?? DCALLS_LANGUAGES[0];

export function getLanguageByCode(code: string): DcallsLanguage {
  return (
    DCALLS_LANGUAGES.find(language => language.code === code) ??
    DEFAULT_LANGUAGE
  );
}

export function getLanguageByName(name: string): DcallsLanguage {
  return (
    DCALLS_LANGUAGES.find(language => language.name === name) ??
    DEFAULT_LANGUAGE
  );
}

export const LANGUAGE_NAMES = DCALLS_LANGUAGES.map(language => language.name);
