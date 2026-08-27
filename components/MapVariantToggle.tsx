'use client'

import { PANEL } from './MapBox'
import { MAP_VARIANTS, type MapVariant } from '@/lib/map-variant'

/**
 * Switches between the map being replaced and the one replacing it.
 *
 * Visible in production, not hidden behind a query string or a secret gesture. The bug that
 * justifies the rewrite — an arrived flight drawn over the Gulf — showed up on a real phone
 * during a real arrival, so the comparison has to be possible on the surface where it happens,
 * by whoever notices, without a laptop.
 *
 * Small and out of the way rather than clever. A hidden control keeps the screen clean and makes
 * the feature unusable by anyone who was not told about it, which for a two-week comparison is
 * the wrong trade.
 *
 * Named v2 and v3 on purpose, matching the app. There is no useful short label for "draws what
 * the server says" versus "guesses when the signal drops", and a wrong-but-friendly name would
 * be worse than a number that means nothing until explained.
 *
 * TEMPORARY — goes with lib/map-variant when V3 is the only map.
 */
export default function MapVariantToggle({
  value, onChange,
}: {
  value: MapVariant
  onChange: (v: MapVariant) => void
}) {
  return (
    <div
      role="group"
      aria-label="Map version"
      style={{
        /*
         * Bottom-right, above the zoom control — not in the top-right stack.
         *
         * That stack is the video box, the photo box and the airport key, and it changes height
         * as the boxes collapse; anything pinned below it either overlaps them or floats in the
         * middle of an empty map on a phone, where they are portalled into the header instead.
         * Down here the neighbours are fixed: zoom sits at 72 from the bottom, Over Syria beneath
         * it, and this clears both.
         */
        position: 'absolute',
        bottom: 120,
        right: 12,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'row',
        // Fixed order in both languages: the pair is v2 then v3 everywhere, because they are
        // version numbers rather than words and reversing them under RTL reads as a different map.
        direction: 'ltr',
        gap: 3,
        padding: 3,
        borderRadius: 9,
        background: PANEL.bg,
        border: `1px solid ${PANEL.border}`,
        boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
      }}
    >
      {MAP_VARIANTS.map(v => {
        const on = v === value
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={on}
            title={v === 'v2' ? 'Current map' : 'Server-authoritative map'}
            style={{
              appearance: 'none',
              border: 'none',
              cursor: on ? 'default' : 'pointer',
              borderRadius: 7,
              // Apple's minimum comfortable target, since this gets tapped repeatedly during a
              // comparison rather than once.
              minWidth: 44,
              padding: '5px 11px',
              font: '700 11px/1 ui-sans-serif, system-ui, sans-serif',
              background: on ? PANEL.forest : 'transparent',
              color: on ? '#FFFFFF' : PANEL.forest,
              transition: 'background 120ms ease, color 120ms ease',
            }}
          >
            {v}
          </button>
        )
      })}
    </div>
  )
}
