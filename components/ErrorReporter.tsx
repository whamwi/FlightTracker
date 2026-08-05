'use client'

import { useEffect } from 'react'

/**
 * Reports browser errors so a fault on someone else's phone is not invisible.
 *
 * Vercel's runtime logs cover the server and nothing else. Every bug found so far was found
 * because one person happened to be looking at the right screen at the right moment — which
 * does not scale past one person, and the audience is ~72% mobile on networks nobody here is
 * testing on.
 *
 * Two listeners, because they catch different things: `error` for thrown exceptions and for
 * assets that fail to load, `unhandledrejection` for a promise nobody caught — which is what a
 * failed fetch usually becomes.
 */

/** Reports per page load. A render loop throwing every frame must not become a DoS on ourselves. */
const MAX_PER_SESSION = 10

/** Silence duplicates: the same message repeating is one bug, not fifty. */
const seen = new Set<string>()
let sent = 0

/**
 * Distinguishes one broken session from many, and identifies nobody.
 *
 * Regenerated on every page load and stored nowhere. Twenty errors from one session look very
 * different from twenty sessions with one error each, and without this they are identical.
 */
const sessionId = Math.random().toString(36).slice(2, 10)

function report(kind: 'ERROR', message: string, stack?: string | null) {
  if (sent >= MAX_PER_SESSION) return
  const key = `${message}|${(stack ?? '').slice(0, 120)}`
  if (seen.has(key)) return
  seen.add(key)
  sent++

  // keepalive so a report survives the navigation that an error often triggers.
  fetch('/api/client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      platform: 'web',
      kind,
      message,
      stack: stack ?? null,
      path: location.pathname + location.search,
      session_id: sessionId,
      context: {
        ua: navigator.userAgent.slice(0, 300),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      },
    }),
  }).catch(() => {
    // A reporter that throws while reporting would be its own infinite loop.
  })
}

export default function ErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      report('ERROR', e.message || 'Unknown error', e.error?.stack ?? `${e.filename}:${e.lineno}:${e.colno}`)
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason
      report('ERROR',
        r instanceof Error ? r.message : `Unhandled rejection: ${String(r).slice(0, 200)}`,
        r instanceof Error ? r.stack : null)
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return null
}
