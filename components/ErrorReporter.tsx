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

/**
 * Report an error the code already caught.
 *
 * The listeners below only see what nothing handled, and the errors that matter most are
 * precisely the ones the app *does* handle — it catches them, shows the user a message, and
 * carries on, leaving no trace anywhere we can read. A user sent a screenshot of "TypeError:
 * Failed to fetch" on the map tonight and there was no matching row, because the map catches
 * that one and renders it as a toast.
 *
 * So anywhere a user is shown an error, call this too.
 */
export function reportHandledError(message: string, context?: Record<string, unknown>) {
  report('ERROR', message, null, context)
}

/**
 * Whether this browser's errors are worth recording.
 *
 * A developer's half-saved file is not a user's bug. With no check here, every error thrown
 * against a local dev server was written to the production table — including a
 * `photoUploadVisible is not defined` that existed for about a minute between two edits, was
 * never deployed, and still turned up in the log looking like a live fault on /airlines.
 *
 * Hostname rather than NODE_ENV: the reporter runs in the browser, and what matters is which
 * server the page came from, not how the bundle was built.
 */
function shouldReport(): boolean {
  const h = location.hostname
  return h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]' && !h.endsWith('.local')
}

/**
 * A failed fetch from a page nobody is looking at, or a phone with no signal, is a network
 * condition rather than a fault in the app.
 *
 * These were 8 of 14 rows in the table — enough to bury the one entry that was a real defect.
 * The event is still worth having, so it is recorded as OFFLINE rather than discarded: a rise
 * in them says something about the network our users are on, which is worth knowing separately
 * from a rise in errors.
 */
function isNetworkCondition(message: string): boolean {
  if (!/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return false
  return document.visibilityState === 'hidden' || !navigator.onLine
}

function report(kind: 'ERROR' | 'OFFLINE', message: string, stack?: string | null, extra?: Record<string, unknown>) {
  if (!shouldReport()) return
  if (kind === 'ERROR' && isNetworkCondition(message)) kind = 'OFFLINE'
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
        // Distinguishes "our server failed" from "this phone lost its connection", which is
        // the first question to ask about a failed fetch and cannot be answered afterwards.
        online: navigator.onLine,
        ...extra,
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
