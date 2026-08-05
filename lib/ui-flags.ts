/**
 * Things that are built and working but deliberately not on screen.
 *
 * A flag rather than deleted code: each of these is finished, and what changed is who is
 * looking at the site — not whether the feature works.
 */

/**
 * The "Photo" upload button on the destination and airline cards.
 *
 * Hidden since SyrGACA were given access. The control sits on a public page and posts
 * straight through, so anyone reading the site could replace the artwork on any destination
 * or airline — fine while the audience was one person, wrong now that it is not.
 *
 * IMPORTANT: this hides the button, not the capability. /api/dest-images and
 * /api/airline-images still accept an unauthenticated POST, so anyone who has seen the
 * request — or reads the page source — can still upload. Closing that needs the endpoints
 * themselves gated, which is a separate change because it also changes how *we* upload.
 */
export const PHOTO_UPLOAD_VISIBLE = false
