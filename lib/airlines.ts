// Single source of truth for airline logos.
// Local overrides live in /public/airlines/; CDN fallback is flightsfrom.com.
// Add a key here whenever a new airline gets a custom logo in /public/airlines/.
export const AIRLINE_LOGOS: Record<string, string> = {
  XH:  '/airlines/XH.jpg',
  TK:  '/airlines/TK.jpg',
  EY:  '/airlines/EY.png',
  J9:  '/airlines/J9.png',
  FZ:  '/airlines/FZ.jpg',
  G9:  '/airlines/G9.png',
  '3L': '/airlines/G9.png',
}

// Logos with transparent backgrounds that need a white container on dark themes
export const LOGO_WHITE_BG = new Set(['J9', 'G9', '3L'])

export function airlineLogo(iata: string): string {
  return AIRLINE_LOGOS[iata] ?? `https://images.flightsfrom.com/airlines/100/${iata}_100px.png`
}
