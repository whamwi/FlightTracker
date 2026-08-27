import { translate } from './i18n.ts'
import { getActiveLocale } from './geo-data.ts'
/*
 * airlineNameFor comes from flight-popup, NOT geo-data — geo-data exports a different function
 * under the same name, taking a required fallback and returning a string rather than null. Both
 * are in scope in Map.tsx, and picking the wrong one here compiled everywhere except the one
 * call site that passes a single argument.
 */
import { airlineIataFor, airlineNameFor, RTL } from './flight-popup.ts'
import { airlineLogo, LOGO_WHITE_BG } from './airlines.ts'
import type { Overflight } from './overflight.ts'

/**
 * How an overflight is drawn — V2's marker and popup, extracted verbatim so V3 shows the same
 * aircraft in the same clothes.
 *
 * The alternative was a second overflight marker written from scratch, which is the mistake
 * already made once with the flight popup: the duplicate was poorer, and two maps that differ in
 * ways nobody chose confound the very comparison the v2/v3 toggle exists to make.
 */

/**
 * The marker: a slate disc, deliberately not the board's livery colours.
 *
 * An overflight is traffic passing over, not a flight anyone is waiting for, and it must not be
 * mistaken at a glance for one on the board.
 */
export function overflightIconHtml(trackDeg: number): string {
  return `<div style="width:26px;height:26px;background:#475569;border:2px solid rgba(255,255,255,.9);border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 6px rgba(0,0,0,.45)"><svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" style="transform:rotate(${trackDeg}deg)"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>`
}

/** The popup. V2's, verbatim — see the module note. */
export function overflightPopupHtml(a: Overflight, trackDeg: number): string {
  const cs = (a.flight ?? '').trim()
  const T  = (k: string) => translate(getActiveLocale(), k)
  const altNum  = typeof a.alt_baro === 'number' ? Math.round(a.alt_baro / 100) * 100 : null
  const altDisp = altNum != null ? altNum.toLocaleString() : '—'
  const spdDisp = a.gs ? Math.round(a.gs).toString() : '—'
  const acType  = a.t ?? null
  const reg     = a.r ?? null
  const aiata   = airlineIataFor(cs)
  const alName  = airlineNameFor(aiata)
  const logoUrl = aiata ? airlineLogo(aiata) : null
  const logoWhiteBg = aiata ? LOGO_WHITE_BG.has(aiata) : false
  // Header left: airline logo when known, else a rotated plane icon
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" style="width:46px;height:46px;border-radius:10px;object-fit:contain;${logoWhiteBg ? 'background:#fff;' : 'background:#1e293b;'}padding:4px;flex-shrink:0" onerror="this.src='https://images.flightsfrom.com/airlines/100/${aiata}_100px.png';this.onerror=null">`
    : `<div style="width:46px;height:46px;border-radius:10px;background:#1e293b;flex-shrink:0;display:flex;align-items:center;justify-content:center"><svg width="22" height="22" viewBox="0 0 24 24" fill="#64748b" style="transform:rotate(${trackDeg}deg)"><path d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>`
  // Primary line: airline name when known, else callsign
  const primaryLine = alName
    ? `<div style="font-size:14px;font-weight:700;color:#f9fafb;line-height:1.2;letter-spacing:-.01em">${alName}</div>
       <div style="font-size:11.5px;color:#9ca3af;margin-top:3px;font-variant-numeric:tabular-nums">${cs}${acType ? ' · ' + acType : ''}</div>`
    : `<div style="font-size:15px;font-weight:700;color:#f9fafb;line-height:1.2;letter-spacing:-.01em;font-variant-numeric:tabular-nums">${cs}</div>
       <div style="font-size:11px;color:#6b7280;margin-top:3px">${[acType, reg].filter(Boolean).join(' · ') || T('map.unknown_airline')}</div>`
  return `<div dir="${RTL() ? 'rtl' : 'ltr'}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;width:260px">
    <div style="display:flex;align-items:flex-start;gap:11px;padding:14px 14px 11px">
      ${logoHtml}
      <div style="flex:1;min-width:0;text-align:start">${primaryLine}</div>
      <span style="background:#0f172a;border:1px solid #334155;color:#94a3b8;font-size:9px;font-weight:700;padding:3px 8px;border-radius:99px;flex-shrink:0;letter-spacing:${RTL() ? 'normal' : '.04em'};white-space:nowrap;margin-top:1px">${RTL() ? T('map.overflight') : T('map.overflight').toUpperCase()}</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1px 1fr;background:#1f2937;border-radius:0 0 14px 14px">
      <div style="text-align:center;padding:14px 8px">
        <div style="font-size:9px;color:#4b5563;font-weight:700;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '.7px'};margin-bottom:6px">${T('map.altitude')}</div>
        <div style="font-size:22px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums;line-height:1">${altDisp}</div>
        <div style="font-size:10px;color:#6b7280;margin-top:4px">${T('unit.ft')}</div>
      </div>
      <div style="background:#374151"></div>
      <div style="text-align:center;padding:14px 8px">
        <div style="font-size:9px;color:#4b5563;font-weight:700;text-transform:uppercase;letter-spacing:${RTL() ? 'normal' : '.7px'};margin-bottom:6px">${T('map.speed')}</div>
        <div style="font-size:22px;font-weight:700;color:#f9fafb;font-variant-numeric:tabular-nums;line-height:1">${spdDisp}</div>
        <div style="font-size:10px;color:#6b7280;margin-top:4px">${T('unit.kt')}</div>
      </div>
    </div>
  </div>`
}
