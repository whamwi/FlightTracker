'use client'

/**
 * Carries the active locale to the pages, which are all client components.
 *
 * The locale is decided on the server — the middleware reads the /ar prefix and the layout
 * passes it down — so this holds it rather than deriving it. Deriving it in the browser would
 * mean the first paint is in the wrong language and then flips, which on a slow connection in
 * Damascus is worse than either language on its own.
 */

import { createContext, useContext } from 'react'
import { DEFAULT_LOCALE, translate, type Locale } from '@/lib/i18n'
import { setActiveLocale } from '@/lib/geo-data'

const LocaleCtx = createContext<Locale>(DEFAULT_LOCALE)

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  // Set during render, not in an effect: the module-level helpers that read it run while the
  // children below are rendering, so an effect would land a frame too late and paint the first
  // pass in the wrong language.
  setActiveLocale(locale)
  return <LocaleCtx.Provider value={locale}>{children}</LocaleCtx.Provider>
}

export const useLocale = (): Locale => useContext(LocaleCtx)

/** The translation function for the active locale. `const t = useT()` then `t('nav.flights')`. */
export function useT(): (key: string) => string {
  const locale = useContext(LocaleCtx)
  return (key: string) => translate(locale, key)
}

/**
 * Prefix a path for the active locale.
 *
 * English stays unprefixed so existing links, shares and search results keep working — there
 * is no /en. Arabic gets /ar. Every internal <Link> has to go through this or the language
 * silently resets on the first navigation.
 */
export function useHref(): (path: string) => string {
  const locale = useContext(LocaleCtx)
  return (path: string) => {
    if (locale === DEFAULT_LOCALE) return path
    return path === '/' ? `/${locale}` : `/${locale}${path}`
  }
}
