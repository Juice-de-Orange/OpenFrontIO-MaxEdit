/**
 * Translation lookup.
 *
 * Split out of client/Utils.ts so the renderer can label things without
 * importing that module, which reaches core/game/Game, core/Schemas and
 * core/game/DoomsdayClock. Translation is not a renderer concern, so it stays
 * client infrastructure the renderer is allowed to use -- unlike the number
 * formatting, which moved into the renderer itself.
 *
 * `getCachedLangSelector` travels with `translateText` rather than staying
 * behind: it resolves the <lang-selector> element the lookup reads from, and
 * separating them leaves every string silently falling back to its key.
 */

import IntlMessageFormat from "intl-messageformat";

/**
 * The part of <lang-selector> this module reads.
 *
 * Typed structurally rather than importing LangSelector, and that is the
 * whole point of the split: LangSelector reaches LanguageModal ->
 * ModalRouter -> Utils.ts -> core/game/Game, so a type-only import of it put
 * 56 simulation files back into the renderer's type graph even after every
 * direct core import was gone. The real element remains assignable.
 */
interface TranslationSource {
  readonly isConnected: boolean;
  readonly currentLang: string;
  readonly translations: Record<string, string> | undefined;
  readonly defaultTranslations: Record<string, string> | undefined;
}

export function formatDebugTranslation(
  key: string,
  params: Record<string, string | number>,
): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return key;
  const serializedParams = entries
    .map(([paramKey, value]) => `${paramKey}=${String(value)}`)
    .join(",");
  return `${key}::${serializedParams}`;
}

const EMPTY_TRANSLATION_PARAMS: Record<string, string | number> = {};

function getCachedLangSelector(): TranslationSource | null {
  const self = translateText as any;
  const cached = self.langSelector as TranslationSource | null | undefined;
  if (cached && cached.isConnected) return cached;

  const found = document.querySelector(
    "lang-selector",
  ) as TranslationSource | null;
  self.langSelector = found ?? null;
  return found;
}

export const translateText = (
  key: string,
  params?: Record<string, string | number>,
): string => {
  const self = translateText as any;
  self.formatterCache ??= new Map();
  self.lastLang ??= null;

  const langSelector = getCachedLangSelector();
  if (!langSelector) {
    return key;
  }

  const resolvedParams = params ?? EMPTY_TRANSLATION_PARAMS;

  if (langSelector.currentLang === "debug") {
    return formatDebugTranslation(key, resolvedParams);
  }

  const translations = langSelector.translations;
  const defaultTranslations = langSelector.defaultTranslations;
  if (!translations && !defaultTranslations) return key;

  if (self.lastLang !== langSelector.currentLang) {
    self.formatterCache.clear();
    self.lastLang = langSelector.currentLang;
  }

  let message = translations?.[key];
  const hasPrimaryTranslation = message !== undefined;

  message ??= defaultTranslations?.[key];

  if (message === undefined) return key;

  // Fast path: no params and no ICU placeholders.
  if (
    resolvedParams === EMPTY_TRANSLATION_PARAMS &&
    message.indexOf("{") === -1
  ) {
    return message;
  }

  try {
    const locale =
      !hasPrimaryTranslation && langSelector.currentLang !== "en"
        ? "en"
        : langSelector.currentLang;
    const cacheKey = `${key}:${locale}:${message}`;
    let formatter = self.formatterCache.get(cacheKey);

    if (!formatter) {
      formatter = new IntlMessageFormat(message, locale);
      self.formatterCache.set(cacheKey, formatter);
    }

    return formatter.format(resolvedParams) as string;
  } catch (e) {
    console.warn("ICU format error", e);
    return message;
  }
};
