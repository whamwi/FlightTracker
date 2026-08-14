'use client'
import { useLocale } from '@/components/LocaleProvider'

/**
 * The two small pieces every flight card shows, in one place.
 *
 * They were written for the board and lived inside its page, so the map's side card had neither:
 * it printed bare times with no variance, and never showed the terminal, gate or belt the board
 * had been showing since 13 Aug. A reader comparing a flight on the two surfaces saw the same
 * flight described to two different depths.
 *
 * Self-contained colours rather than an imported palette. The board and the map each declare
 * their own `C`, with different members — the board has the wine pair this chip needs and the map
 * does not — and unifying two palettes is a larger change than these two components justify.
 */

const WINE_BG = '#F1E6E7'
const WINE_TX = '#7C2D36'
const EARLY_BG = '#E6EFEC'
const EARLY_TX = '#002623'
const MUTED   = '#8A8578'

/**
 * Minutes early or late, as a chip.
 *
 * Three elements, not one string, and dir=ltr on the wrapper. Bidi will not lay this out: under
 * dir=rtl it puts the Arabic letter rightmost and drops the lone sign at the far left, so "+6د"
 * and "د6+" rendered identically. Separate spans in a flex row are positioned by DOM order alone,
 * which is the only way to pin unit, number and sign — and keep them pinned for a minus or a
 * three-digit delay.
 */
export function DelayChip({ min }: { min: number | null | undefined }) {
  const locale = useLocale()
  if (!min || Math.abs(min) < 1) return null
  const isLate = min > 0
  const unit   = locale === 'ar' ? 'د' : 'm'
  return (
    <span dir="ltr" style={{ display: 'inline-flex',
      fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600,
      padding: '3px 5px', borderRadius: 5, lineHeight: 1,
      background: isLate ? WINE_BG : EARLY_BG,
      color: isLate ? WINE_TX : EARLY_TX,
    }}>
      {locale === 'ar' ? (
        <>
          <span>{unit}</span><span>{Math.abs(min)}</span><span>{isLate ? '+' : '-'}</span>
        </>
      ) : (isLate ? `+${min}${unit}` : `${min}${unit}`)}
    </span>
  )
}

/**
 * The small print about one journey: aircraft type, terminal, gate, belt.
 *
 * No separator characters. On the board this column is 89px wide on a phone, so the terminal
 * always wraps below the type, and any middot then leads the wrapped line and reads as a fault —
 * which it did twice, first from a joined string and then from separators bound to the item that
 * follows them, so they wrapped along with it. Whitespace separates instead, and every label but
 * the aircraft type already carries its own noun.
 *
 * Renders nothing when it has nothing, rather than adding an empty row to every card to say
 * nothing on most of them.
 */
export function MetaStrip({ items }: { items: { text: string | null | undefined; cls?: string }[] }) {
  const parts = items
    .map(i => ({ ...i, text: (i.text ?? '').trim() }))
    .filter(i => i.text)
  if (!parts.length) return null
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'baseline',
      gap: '2px 10px', maxWidth: '100%',
    }}>
      {parts.map((p, i) => (
        <span key={p.text + i} className={p.cls} style={{
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 10.5, color: MUTED,
          letterSpacing: '.04em', whiteSpace: 'nowrap',
        }}>{p.text}</span>
      ))}
    </div>
  )
}

/**
 * The ص / م beside a time, set as a label rather than as part of the number.
 *
 * The digits are monospace and bold so a column of times lines up and can be scanned; the meridiem
 * is neither of those things. At the same weight and size it competed with the figure it qualifies,
 * which is what it looked like before — so it takes the face used for airline names, at roughly
 * two-thirds the digits' size, and steps back.
 *
 * `size` because the surfaces set times very differently: 12px on the map's panel card, 20px on the
 * board. A fixed size would be a third of one and two-thirds of the other.
 */
export function Meridiem({ of, size = 8.5, color = MUTED }: { of: string; size?: number; color?: string }) {
  if (!of) return null
  return (
    <span style={{
      font: `500 ${size}px/1 'Instrument Sans',system-ui`,
      color, marginInlineStart: 3, whiteSpace: 'nowrap',
    }}>{of}</span>
  )
}
