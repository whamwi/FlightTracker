'use client'

/**
 * The language switch that was already promised in the footer.
 *
 * `العربية · English` has been sitting on the board, destinations and airlines pages as a
 * plain span with no handler since before this — visible to every visitor and doing nothing.
 * This is the same text, wired.
 *
 * Switching preserves the current path and query, so someone reading a specific flight in
 * English lands on that flight in Arabic rather than back at the board. Losing your place is
 * what makes people not use a language switch twice.
 */

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@/lib/i18n'
import { useLocale } from './LocaleProvider'

const LABEL: Record<Locale, string> = { en: 'English', ar: 'العربية' }

export default function LanguageSwitch({ colour = '#A6A093' }: { colour?: string }) {
  const active   = useLocale()
  const pathname = usePathname()
  const params   = useSearchParams()

  /*
   * usePathname gives the URL the visitor sees, prefix and all — /ar/board, not the /board the
   * middleware rewrote it to. So the prefix has to come off before the other language's URL
   * can be built, or "English" on an Arabic page links straight back to itself.
   */
  const bare = LOCALES.reduce(
    (p, l) => (l !== DEFAULT_LOCALE && (p === `/${l}` || p.startsWith(`/${l}/`)) ? p.slice(l.length + 1) || '/' : p),
    pathname || '/',
  )

  const query = params.toString()
  const href = (l: Locale) => {
    const base = l === DEFAULT_LOCALE ? bare : `/${l}${bare === '/' ? '' : bare}`
    return query ? `${base}?${query}` : base
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {LOCALES.map((l, i) => (
        <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span style={{ color: colour, opacity: 0.5 }}>·</span>}
          {l === active ? (
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, fontWeight: 700,
              color: colour, opacity: 1,
            }}>{LABEL[l]}</span>
          ) : (
            <Link href={href(l)} prefetch={false} style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, fontWeight: 500,
              color: colour, opacity: 0.7, textDecoration: 'none',
            }}>{LABEL[l]}</Link>
          )}
        </span>
      ))}
    </span>
  )
}
