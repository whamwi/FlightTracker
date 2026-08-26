'use client'

import { PANEL } from './MapBox'
import { useLocale } from '@/components/LocaleProvider'
import type { BasemapKind } from '@/lib/basemap-attach'

/**
 * Which map to draw underneath, in the control stack below the airport legend.
 *
 * Two, not a list. The vector map is ours — OpenStreetMap data styled in the browser, no roads or
 * buildings, so the aircraft have a quiet surface to sit on. The grey one is Esri's raster canvas,
 * which is also the automatic fallback where WebGL is unavailable; offering it as a choice costs
 * nothing and gives a reader on a struggling device something to try. A third option would be a
 * menu, and nobody opens a flight tracker to browse basemaps.
 *
 * The labels say what the reader gets, not what the technology is. "Vector" and "Raster" are
 * facts about us; "Map" and "Plain" are facts about the picture.
 *
 * Desktop only, like the legend above it — see AirportLegend. On a phone the control stack
 * collapses to two header buttons, and the basemap is never the reason someone opened the map.
 */

/*
 * The default is the PLAIN one, and the second option is the fuller map.
 *
 * These read backwards at first glance — ours is the vector map we built, so calling it "Plain"
 * feels like underselling it. But the label has to describe what the reader is looking at, not
 * where it came from, and what they are looking at is deliberately bare: borders, seas and a
 * handful of capitals, with no roads, buildings or towns, so the aircraft have a quiet surface.
 * Esri's canvas carries far more — every provincial city across Turkey and Iran.
 *
 * So the plain map is the default and the detailed one is the alternative, which is the right way
 * round for a flight tracker and the wrong way round from the implementation's point of view.
 */
const OPTIONS: { kind: BasemapKind; label: { en: string; ar: string } }[] = [
  { kind: 'vector', label: { en: 'Plain', ar: 'بسيطة' } },
  { kind: 'grey',   label: { en: 'Map',   ar: 'خريطة' } },
]

export default function BasemapSwitcher({
  value, onChange,
}: {
  value: BasemapKind
  onChange: (kind: BasemapKind) => void
}) {
  /*
   * Pinned to the physical right in both languages, exactly as the legend is.
   *
   * The control stack aligns its children with flex-end — the *inline* end, which is the left in
   * Arabic. Left to itself this drifted to the far edge and came unstuck from the key above it.
   */
  const ar = useLocale() === 'ar'

  return (
    <div
      role="group"
      aria-label={ar ? 'نوع الخريطة' : 'Base map'}
      style={{
        background: PANEL.bg,
        border: `1px solid ${PANEL.border}`,
        borderRadius: 12,
        padding: 3,
        boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
        display: 'flex',
        flexDirection: 'row',
        // No `direction` override: the row follows the page, so Arabic reads the default first
        // from the right, as an Arabic reader expects. The mirroring is correct, not a fault —
        // the labels were what needed fixing.
        gap: 3,
        whiteSpace: 'nowrap',
        // As wide as its content, like the caption above it — not stretched to the stack.
        alignSelf: ar ? 'flex-start' : 'flex-end',
      }}
    >
      {OPTIONS.map(o => {
        const on = o.kind === value
        return (
          <button
            key={o.kind}
            type="button"
            onClick={() => onChange(o.kind)}
            aria-pressed={on}
            style={{
              appearance: 'none',
              border: 'none',
              cursor: on ? 'default' : 'pointer',
              borderRadius: 9,
              padding: '5px 12px',
              font: '600 12px/1 ui-sans-serif, system-ui, sans-serif',
              background: on ? PANEL.forest : 'transparent',
              color: on ? '#FFFFFF' : PANEL.forest,
              transition: 'background 120ms ease, color 120ms ease',
            }}
          >
            {ar ? o.label.ar : o.label.en}
          </button>
        )
      })}
    </div>
  )
}
