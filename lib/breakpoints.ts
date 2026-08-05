/**
 * What counts as a phone, in either orientation.
 *
 * Width alone gets this wrong, and it got it wrong in production: a Samsung S25 Ultra turned
 * sideways is about 900px across, so a `max-width: 767px` query stopped calling it a phone and
 * the map switched to its desktop behaviour — the video panel opening and playing by itself
 * every time the handset was rotated.
 *
 * Testing the short side makes the answer independent of orientation, which is what "phone"
 * means here. An iPad is 768 across at its narrowest and stays a tablet turned either way; no
 * phone is 600 tall in landscape.
 *
 * Kept in one place because the same question is asked from several: the map component, the
 * map page's panel-versus-strip choice, and the attribution corner. Three copies of a
 * breakpoint is three chances for them to disagree about what device someone is holding.
 */
export const PHONE_MQ = '(max-width: 767px), (max-height: 599px)'
