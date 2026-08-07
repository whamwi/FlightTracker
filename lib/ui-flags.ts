'use client'

/**
 * Things that are built and working but deliberately not on screen.
 *
 * A flag rather than deleted code: each of these is finished, and what changed is who is
 * looking at the site — not whether the feature works.
 */

import { useEffect, useState } from 'react'

const PHOTO_UPLOAD_KEY = 'flysyria_photo_upload'

/**
 * Whether the "Photo" upload button shows on the destination and airline cards.
 *
 * Off for everyone by default, since SyrGACA were given access — the control sits on a
 * public page, so leaving it on invites anyone reading the site to replace the artwork.
 *
 * Turn it on for one browser by visiting any page with `?photo=1`, off again with `?photo=0`.
 * The choice sticks in localStorage, so uploading no longer needs a deploy either side of it.
 *
 * IMPORTANT — this controls visibility, not access. /api/dest-images and /api/airline-images
 * still accept an unauthenticated POST, so anyone who reads the page source can upload with
 * or without a button. The switch below does not make that worse and does not fix it; gating
 * those two endpoints is separate work, and it has to change how we upload too.
 *
 * Returns false on the server and on the first client render, then flips after mount — the
 * button is not worth a hydration mismatch.
 */
export function usePhotoUploadVisible(): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      const param = new URLSearchParams(window.location.search).get('photo')
      if (param === '1') localStorage.setItem(PHOTO_UPLOAD_KEY, '1')
      if (param === '0') localStorage.removeItem(PHOTO_UPLOAD_KEY)
      setVisible(localStorage.getItem(PHOTO_UPLOAD_KEY) === '1')
    } catch {
      // Private browsing, or storage disabled — stay hidden.
    }
  }, [])

  return visible
}
