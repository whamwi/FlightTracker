// OpenSky REST client — OAuth2 client credentials.
//
// Basic auth with the account username/password is no longer accepted. The API now
// issues 30-minute bearer tokens from a Keycloak token endpoint. The credentials are an
// *API client* pair created under the account's API tab — not the website login pair:
//
//   OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET
//
// Credits are charged per *request*, not per aircraft, so batching every tracked hex
// into one icao24 query is by far the cheapest shape: 1 credit however many hexes it
// carries. A bounding box costs 2–4 depending on area (see creditCost). Free tier is
// 4,000/day, 8,000 for an active feeder.

const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
const API_BASE = 'https://opensky-network.org/api'

const MS_TO_KTS = 1.94384
const M_TO_FT   = 3.28084

export interface StateVec {
  icao24:    string
  callsign:  string
  lat:       number
  lon:       number
  alt_ft:    number | null
  gs_kts:    number | null
  track:     number | null
  on_ground: boolean
}

// A failed query and an empty sky are different things, and the caller has to be able to
// tell them apart — conflating them is what made the old poller impossible to diagnose.
export interface StatesResult {
  ok:      boolean
  states:  StateVec[]
  error:   string | null
  credits: number
}

// Module scope, so a warm serverless instance reuses the token across invocations.
// At a 2-minute cron cadence most invocations hit a warm instance and cost no token call.
let cachedToken: { token: string; expiresAt: number } | null = null

export function hasCredentials(): boolean {
  return !!(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET)
}

export interface BBox { lamin: number; lomin: number; lamax: number; lomax: number }

export interface StatesQuery {
  /** Filter by transponder address. One credit for the whole list, however long. */
  icao24?: string[]
  /** Geographic filter. Costs 2–4 credits depending on area — see creditCost. */
  bbox?:   BBox
}

/** Credits a /states/all call costs, per the published table. */
export function creditCost(q: StatesQuery): number {
  if (!q.bbox) return 1   // icao24-only query
  const { lamin, lomin, lamax, lomax } = q.bbox
  const area = Math.abs(lamax - lamin) * Math.abs(lomax - lomin)
  if (!Number.isFinite(area)) return 4
  if (area <= 25)  return 1
  if (area <= 100) return 2
  if (area <= 400) return 3
  return 4
}

/**
 * Build the query string. `icao24` must be repeated once per address — the documented
 * form is `?icao24=3c6444&icao24=3e1bf9`, not a comma-separated list. The old poller
 * comma-joined them; that was never exercised, since its Basic auth was already rejected.
 */
function buildQuery(q: StatesQuery): string {
  const sp = new URLSearchParams()
  for (const hex of q.icao24 ?? []) sp.append('icao24', hex.toLowerCase())
  if (q.bbox) {
    sp.set('lamin', String(q.bbox.lamin))
    sp.set('lomin', String(q.bbox.lomin))
    sp.set('lamax', String(q.bbox.lamax))
    sp.set('lomax', String(q.bbox.lomax))
  }
  return sp.toString()
}

/**
 * Fetch a bearer token, reusing the cached one until 60 s before it expires.
 * `force` discards the cache — used once after a 401, since a token can be revoked
 * server-side before its nominal expiry.
 */
async function getToken(force = false): Promise<{ token: string | null; error: string | null }> {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) {
    return { token: cachedToken.token, error: null }
  }
  const client_id     = process.env.OPENSKY_CLIENT_ID
  const client_secret = process.env.OPENSKY_CLIENT_SECRET
  if (!client_id || !client_secret) {
    return { token: null, error: 'OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET not set' }
  }

  let res: Response
  try {
    res = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ grant_type: 'client_credentials', client_id, client_secret }),
      signal:  AbortSignal.timeout(10_000),
    })
  } catch (e) {
    cachedToken = null
    return { token: null, error: `token fetch failed: ${e}` }
  }

  if (!res.ok) {
    cachedToken = null
    const body = await res.text().catch(() => '')
    return { token: null, error: `token HTTP ${res.status}: ${body.slice(0, 200)}` }
  }

  const json = await res.json() as { access_token?: string; expires_in?: number }
  if (!json.access_token) {
    cachedToken = null
    return { token: null, error: 'token response had no access_token' }
  }

  // Tokens are documented as 30 min; trust expires_in when present, and renew a minute
  // early so a token cannot lapse between the check and the request that uses it.
  const ttlMs = (json.expires_in ?? 1800) * 1000
  cachedToken = { token: json.access_token, expiresAt: Date.now() + Math.max(ttlMs - 60_000, 30_000) }
  return { token: json.access_token, error: null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseState(s: any[]): StateVec | null {
  if (s[6] == null || s[5] == null) return null
  return {
    icao24:    (s[0] as string).toLowerCase(),
    callsign:  ((s[1] as string) || '').trim(),
    lat:       s[6] as number,
    lon:       s[5] as number,
    alt_ft:    s[7] != null ? Math.round((s[7] as number) * M_TO_FT)   : null,
    gs_kts:    s[9] != null ? Math.round((s[9] as number) * MS_TO_KTS) : null,
    track:     s[10] as number | null,
    on_ground: Boolean(s[8]),
  }
}

/**
 * Query /states/all. Retries exactly once on 401 with a freshly minted token, which is
 * the documented signal that the token expired; any other failure is reported, not retried.
 */
export async function queryStates(q: StatesQuery): Promise<StatesResult> {
  const credits = creditCost(q)
  const qs      = buildQuery(q)

  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, error } = await getToken(attempt > 0)
    if (!token) return { ok: false, states: [], error, credits: 0 }

    let res: Response
    try {
      res = await fetch(`${API_BASE}/states/all?${qs}`, {
        headers: {
          'User-Agent':    'FlightTracker/1.0',
          Authorization:   `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(12_000),
      })
    } catch (e) {
      return { ok: false, states: [], error: `fetch failed: ${e}`, credits: 0 }
    }

    if (res.status === 401 && attempt === 0) {
      cachedToken = null
      continue
    }
    if (res.status === 429) {
      return { ok: false, states: [], error: 'rate limited (429) — daily credits exhausted', credits }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, states: [], error: `HTTP ${res.status}: ${body.slice(0, 200)}`, credits }
    }

    const data = await res.json() as { states?: unknown[][] }
    const states = (data.states ?? []).flatMap(s => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = parseState(s as any[])
      return v ? [v] : []
    })
    return { ok: true, states, error: null, credits }
  }

  return { ok: false, states: [], error: 'unauthorized after token refresh', credits: 0 }
}
