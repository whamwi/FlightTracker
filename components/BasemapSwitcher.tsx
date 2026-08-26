'use client'

import { useState } from 'react'
import { PANEL } from './MapBox'
import { useLocale } from '@/components/LocaleProvider'
import type { BasemapKind } from '@/lib/basemap-attach'

/**
 * What the map is drawn on, in the control stack below the airport legend.
 *
 * A collapsed icon that opens on hover or tap, rather than a row of buttons. The stack above it is
 * already a video box, a photo box and a colour key; a fourth permanent panel for something most
 * readers will never touch was too much furniture. The stacked-layers glyph is the convention every
 * map uses, so it needs no label of its own.
 *
 * ── What is offered, and what is not ──
 *
 * Two basemaps. The test page at services/flight-api/maptest.html carries four, because it is a
 * comparison bench; two of those have no business in front of readers. CARTO is watermarked — it is
 * the thing this whole change removed. OpenStreetMap's own style is the EDITING style, drawn to
 * make map data legible to mappers rather than to sit under aircraft, and it runs on the
 * Foundation's donated capacity, which a diaspora-wide site should not lean on.
 *
 * ── Cities, which is the reason this is more than a re-housing ──
 *
 * The label toggle is a real switch only on the vector map, where the place names are a layer we
 * own: they come off and the borders and coastlines stay. On Esri they are baked into the same
 * raster tile as the borders, so there is nothing to switch and the control disables itself rather
 * than pretending. That is the whole difference between rendering a map and receiving a picture of
 * one, expressed as one checkbox.
 *
 * Desktop only, like the legend above it. On a phone the stack collapses to two header buttons.
 */

const T = {
  layers:  { en: 'Map layers', ar: 'طبقات الخريطة' },
  plain:   { en: 'Plain',      ar: 'بسيطة' },
  map:     { en: 'Map',        ar: 'خريطة' },
  cities:  { en: 'Cities',     ar: 'المدن' },
  onlyPlain: { en: 'Plain map only', ar: 'الخريطة البسيطة فقط' },
}

/*
 * The default is the PLAIN one and the second option is the fuller map.
 *
 * These read backwards from the implementation's side — ours is the vector map we built, so
 * calling it "Plain" feels like underselling it. But a label describes what the reader is looking
 * at, and what they are looking at is deliberately bare: borders, seas and a few capitals, so the
 * aircraft have a quiet surface. Esri's canvas carries every provincial city across Turkey and Iran.
 */
const OPTIONS: { kind: BasemapKind; key: 'plain' | 'map' }[] = [
  { kind: 'vector', key: 'plain' },
  { kind: 'grey',   key: 'map' },
]

export default function BasemapSwitcher({
  value, onChange, cities, onCitiesChange, citiesAvailable,
}: {
  value: BasemapKind
  onChange: (kind: BasemapKind) => void
  cities: boolean
  onCitiesChange: (on: boolean) => void
  /** False once the vector map is not what is actually on screen — see BasemapOpts.onFallback. */
  citiesAvailable: boolean
}) {
  /*
   * Hover opens it, and a click pins it open.
   *
   * Hover alone is how Leaflet's own control behaves and is the lighter interaction, but it leaves
   * keyboard and touch with no way in. Pinning covers both without a second control.
   */
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hovered || pinned

  const ar = useLocale() === 'ar'
  const t = (k: keyof typeof T) => (ar ? T[k].ar : T[k].en)

  const citiesOn = cities && citiesAvailable

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: PANEL.bg,
        border: `1px solid ${PANEL.border}`,
        borderRadius: 12,
        boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
        overflow: 'hidden',
        // Sized to its content, like the key above it, and pinned to the physical right in both
        // languages — the stack aligns on the inline end, which in Arabic is the left.
        alignSelf: ar ? 'flex-start' : 'flex-end',
      }}
    >
      {!open ? (
        <button
          type="button"
          onClick={() => setPinned(true)}
          aria-label={t('layers')}
          aria-expanded={false}
          style={{
            appearance: 'none', border: 'none', background: 'transparent',
            cursor: 'pointer', display: 'block', padding: '7px 9px', lineHeight: 0,
            color: PANEL.forest,
          }}
        >
          <LayersIcon />
        </button>
      ) : (
        <div style={{ padding: '8px 10px 9px', minWidth: 128 }}>
          <div style={{
            font: `600 10px/1 ui-sans-serif, system-ui, sans-serif`,
            letterSpacing: '.04em', textTransform: 'uppercase',
            color: PANEL.forestMid, marginBottom: 7,
            textAlign: ar ? 'right' : 'left',
          }}>
            {t('layers')}
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', gap: 3, marginBottom: 8 }}>
            {OPTIONS.map(o => {
              const on = o.kind === value
              return (
                <button
                  key={o.kind}
                  type="button"
                  onClick={() => onChange(o.kind)}
                  aria-pressed={on}
                  style={{
                    appearance: 'none', border: 'none', flex: 1,
                    cursor: on ? 'default' : 'pointer',
                    borderRadius: 8, padding: '5px 10px',
                    font: '600 12px/1 ui-sans-serif, system-ui, sans-serif',
                    background: on ? PANEL.forest : 'transparent',
                    color: on ? '#FFFFFF' : PANEL.forest,
                    transition: 'background 120ms ease, color 120ms ease',
                  }}
                >
                  {t(o.key)}
                </button>
              )
            })}
          </div>

          <label
            title={citiesAvailable ? '' : t('onlyPlain')}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              flexDirection: ar ? 'row-reverse' : 'row',
              font: '500 12px/1 ui-sans-serif, system-ui, sans-serif',
              color: PANEL.forest,
              cursor: citiesAvailable ? 'pointer' : 'not-allowed',
              // Greyed rather than hidden: a control that vanishes on one basemap is a puzzle,
              // and the disabled state is itself the explanation of what raster cannot do.
              opacity: citiesAvailable ? 1 : 0.45,
            }}
          >
            <input
              type="checkbox"
              checked={citiesOn}
              disabled={!citiesAvailable}
              onChange={e => onCitiesChange(e.target.checked)}
              style={{ accentColor: PANEL.forest, width: 13, height: 13, margin: 0 }}
            />
            {t('cities')}
          </label>
        </div>
      )}
    </div>
  )
}

/** The stacked-sheets glyph every map uses for this. Inline so it inherits `color`. */
function LayersIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 2 8.5 12 14l10-5.5L12 3Z" />
      <path d="m2 15.5 10 5.5 10-5.5" />
      <path d="m2 12 10 5.5L22 12" />
    </svg>
  )
}
