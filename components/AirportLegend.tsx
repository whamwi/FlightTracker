'use client'

import { PANEL } from './MapBox'
import { MARKER_ACCENT, type BoardAirport } from '@/lib/syria-airports'
import { cityFor } from '@/lib/geo-data'

/**
 * What the marker colours mean, under the photo box in the map's control stack.
 *
 * The map colours a flight by its provincial end — markerHub picks DEZ or ALP where either is an
 * endpoint, and Damascus otherwise — so the colour answers "which airport is this flight's Syrian
 * end", not "where is it going". Nothing on the map said so, and three colours with no key is a
 * puzzle rather than information.
 *
 * Desktop only. On a phone the control stack collapses to two header buttons and there is no room
 * for a key that is never the reason someone opened the map.
 *
 * The city name comes from cityFor, the same lookup the popups and the panel use, so it is the
 * full localised name — دمشق or Damascus — rather than the IATA code. One source, so the legend
 * cannot start disagreeing with the labels it explains.
 */

const ORDER: BoardAirport[] = ['DAM', 'ALP', 'DEZ']

export default function AirportLegend() {
  return (
    <div
      style={{
        background: PANEL.bg,
        border: `1px solid ${PANEL.border}`,
        borderRadius: 12,
        padding: '8px 11px 9px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        // Matches the boxes above it, so the stack reads as one column rather than three widths.
        minWidth: 132,
      }}
    >
      {ORDER.map(code => (
        <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            aria-hidden
            style={{
              width: 9, height: 9, borderRadius: 9,
              background: MARKER_ACCENT[code],
              flexShrink: 0,
              // The same white outline the plane markers carry, so the swatch reads as the marker
              // it stands for rather than as a bullet point.
              boxShadow: '0 0 0 1.5px #fff',
            }}
          />
          <span style={{ font: `600 11.5px/1.3 'Instrument Sans',system-ui`, color: PANEL.secondary }}>
            {cityFor(code)}
          </span>
        </div>
      ))}
    </div>
  )
}
