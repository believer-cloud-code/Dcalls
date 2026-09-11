import { getDamaiResponse } from './gemini';
import { getLanguageByCode } from '../config/languages';

export function speechLangForCode(code: string): string {
  return getLanguageByCode(code).speechLocale;
}

/** Translate a short utterance for live call captions. Returns original text on failure. */
export async function translateUtterance(
  text: string,
  fromName: string,
  toName: string
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const prompt =
    `Translate this spoken phrase from ${fromName} to ${toName}. ` +
    `Reply with ONLY the translation — no quotes, labels, or explanation.\n\n` +
    trimmed;

  try {
    const result = await getDamaiResponse(prompt);
    return (result || trimmed).trim();
  } catch (error) {
    console.warn('Translation failed, showing original:', error);
    return trimmed;
  }
}
