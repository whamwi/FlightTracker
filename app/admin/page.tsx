import { redirect } from 'next/navigation'

/**
 * /admin has no page of its own, so it sends you to the one you actually wanted.
 *
 * There are four admin pages — reconcile, route-cache, no-activity, errors — and until now the
 * bare /admin was a 404 sitting behind a password prompt: you signed in, and then the site told
 * you there was nothing there. Reconcile is the one that gets opened, so that is where /admin goes.
 *
 * A TEMPORARY redirect, deliberately. 307 rather than 308 because this is a statement about which
 * admin page matters this month, not about where a resource has permanently moved — and browsers
 * cache a permanent redirect hard enough that changing the default later would mean asking people
 * to clear it.
 *
 * An index listing all four would be the other answer. It is not obviously better: whoever opens
 * /admin here already knows the four pages, and a menu between them and the one they wanted is a
 * click, not a service.
 */
export default function AdminIndex() {
  redirect('/admin/reconcile')
}
