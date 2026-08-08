'use client'

/**
 * The language switch.
 *
 * Two forms. `footer` keeps the wired-up `العربية · English` pair the footers already carried.
 * `toggle` is the header's: a single control showing the flag of the language you would move
 * to, because with exactly two languages a chooser is a list of one real option and a label
 * for where you already are.
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

/*
 * The flag stands for the language, not the country — there is no flag for a language, and
 * every choice here is a compromise. English takes the American flag because that is where
 * most of the English-reading audience is (16% of traffic, the largest single country after
 * Syria); Arabic takes Syria's, which for this site is the point rather than a compromise.
 */
const FLAG: Record<Locale, string> = { en: '🇺🇸', ar: '🇸🇾' }

/** The other language — with two of them, that is the whole of the choice. */
const otherThan = (l: Locale): Locale => (LOCALES.find((x) => x !== l) ?? DEFAULT_LOCALE)

function useSwitchHref() {
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
  return (l: Locale) => {
    const base = l === DEFAULT_LOCALE ? bare : `/${l}${bare === '/' ? '' : bare}`
    return query ? `${base}?${query}` : base
  }
}

/** Header form: one tap, showing where it takes you. */
export function LanguageToggle({ compact = false }: { compact?: boolean }) {
  const active = useLocale()
  const href   = useSwitchHref()
  const target = otherThan(active)

  return (
    <Link
      href={href(target)}
      prefetch={false}
      hrefLang={target}
      aria-label={LABEL[target]}
      title={LABEL[target]}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        height: 40, width: compact ? 40 : undefined, padding: compact ? 0 : '0 12px',
        borderRadius: 10, border: '1px solid #D5DFD0', background: '#FFFFFF',
        textDecoration: 'none', flexShrink: 0,
      }}
    >
      {/* Emoji flags render at the font's own size, so this is set rather than inherited. */}
      <span style={{ fontSize: 17, lineHeight: 1 }} aria-hidden>{FLAG[target]}</span>
      {!compact && (
        <span style={{ font: `600 13px/1 'Instrument Sans',system-ui`, color: '#4b5563', whiteSpace: 'nowrap' }}>
          {LABEL[target]}
        </span>
      )}
    </Link>
  )
}

/** Footer form: both languages named, the current one marked. */
export default function LanguageSwitch({ colour = '#A6A093' }: { colour?: string }) {
  const active = useLocale()
  const href   = useSwitchHref()

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {LOCALES.map((l, i) => (
        <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span style={{ color: colour, opacity: 0.5 }}>·</span>}
          <span style={{ fontSize: 13, lineHeight: 1 }} aria-hidden>{FLAG[l]}</span>
          {l === active ? (
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, fontWeight: 700,
              color: colour, opacity: 1,
            }}>{LABEL[l]}</span>
          ) : (
            <Link href={href(l)} prefetch={false} hrefLang={l} style={{
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, fontWeight: 500,
              color: colour, opacity: 0.7, textDecoration: 'none',
            }}>{LABEL[l]}</Link>
          )}
        </span>
      ))}
    </span>
  )
}
