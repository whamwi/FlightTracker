'use client'

import { useEffect, useState } from 'react'
import { useT, useLocale } from '@/components/LocaleProvider'

/**
 * Tells a reader their tab is running old code, and lets them decide when to fix it.
 *
 * A browser keeps a tab's JavaScript for as long as the tab is open. On an audience that is 78%
 * mobile that is measured in days, and nothing on the page has ever said so. Twice on 15 Aug that
 * cost real time: a stale tab hid a phrase that had shipped hours earlier, and another showed
 * arrived markers piling up at Damascus in behaviour that had been replaced the previous day.
 * Both looked exactly like bugs in current code.
 *
 * Not an automatic reload. This is a live map — someone is watching a specific aircraft, or has a
 * popup open, and pulling the page out from under them to fix a problem they have not noticed is
 * worse than the staleness. It offers; they choose.
 *
 * Five minutes between checks. The point is that a tab open for hours eventually notices, not that
 * it notices in the first ten seconds, and this runs on every page.
 */
const CHECK_MS = 5 * 60 * 1000

export default function VersionCheck() {
  const [stale, setStale] = useState(false)
  const t = useT()
  const locale = useLocale()

  useEffect(() => {
    const mine = process.env.NEXT_PUBLIC_BUILD_ID
    // 'dev' is the local fallback: nothing to compare, and no banner while developing.
    if (!mine || mine === 'dev') return

    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' })
        if (!res.ok) return
        const { build } = await res.json()
        // Only a definite disagreement counts. A missing or malformed answer means the check
        // failed, not that the tab is stale — and a banner shown on a network blip would train
        // people to ignore it.
        if (!cancelled && build && build !== 'dev' && build !== mine) setStale(true)
      } catch { /* offline, or the deployment is mid-swap. Try again next time. */ }
    }

    check()
    const id = setInterval(check, CHECK_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!stale) return null

  const rtl = locale === 'ar'
  return (
    <button
      onClick={() => window.location.reload()}
      dir={rtl ? 'rtl' : 'ltr'}
      style={{
        position: 'fixed',
        // Bottom, not top: the map's own controls and the board's header live up there, and this
        // must never cover something a reader is using.
        bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 16px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.14)',
        background: '#1f2937',
        color: '#f9fafb',
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
        cursor: 'pointer',
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <span aria-hidden>↻</span>
      <span>{t('version.update_available')}</span>
    </button>
  )
}
