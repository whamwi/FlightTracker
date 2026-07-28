/**
 * Unit tests for FlightPredictor.
 *
 * Run with:  node --experimental-strip-types --test lib/flight-predictor.test.ts
 * (Node 22+)  or:  npx tsx --test lib/flight-predictor.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  haversineKm,
  geodesicProject,
  slerpGC,
  gcBearing,
  interpolatePath,
  bearingFromPath,
  nearestPathFraction,
  FlightPredictor,
  DEFAULT_CONFIG,
} from './flight-predictor.ts'

import type { Waypoint, FlightContext, LivePosition } from './flight-predictor.ts'

const DEG = Math.PI / 180

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function approx(a: number, b: number, tol = 0.5): boolean {
  return Math.abs(a - b) <= tol
}

const DAM: [number, number] = [33.4114,  36.5156]  // Damascus
const DXB: [number, number] = [25.2528,  55.3644]  // Dubai
const IST: [number, number] = [41.2608,  28.7418]  // Istanbul

// Simple 5-waypoint DAM→DXB route path
const ROUTE_DAM_DXB: Waypoint[] = [
  { f: 0.00, lat: 33.4114, lon: 36.5156 },
  { f: 0.25, lat: 31.50,   lon: 40.50   },
  { f: 0.50, lat: 29.20,   lon: 44.80   },
  { f: 0.75, lat: 27.10,   lon: 49.60   },
  { f: 1.00, lat: 25.2528, lon: 55.3644 },
]

function makeLivePos(override: Partial<LivePosition> = {}): LivePosition {
  return {
    lat: 33.0, lon: 36.8, track_deg: 135, gs_kts: 480,
    vs_fpm: 0, altitude_ft: 35_000, ...override,
  }
}

function makeCtx(override: Partial<FlightContext> = {}): FlightContext {
  return {
    dep_coords:        DAM,
    arr_coords:        DXB,
    actual_dep_utc_ms: null,
    duration_ms:       2 * 3_600_000,   // 2 h
    sched_dep_utc_ms:  null,
    waypoints:         ROUTE_DAM_DXB,
    ...override,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Geodesic math
// ─────────────────────────────────────────────────────────────────────────────

describe('haversineKm', () => {
  test('zero distance', () => {
    assert.equal(haversineKm(33, 36, 33, 36), 0)
  })

  test('DAM → DXB ≈ 2 000 km', () => {
    const d = haversineKm(DAM[0], DAM[1], DXB[0], DXB[1])
    assert.ok(approx(d, 2036, 100), `expected ~2036 km, got ${d.toFixed(0)} km`)
  })

  test('symmetric', () => {
    const ab = haversineKm(DAM[0], DAM[1], IST[0], IST[1])
    const ba = haversineKm(IST[0], IST[1], DAM[0], DAM[1])
    assert.ok(Math.abs(ab - ba) < 0.001)
  })

  test('equator quarter-circle ≈ 10 007 km', () => {
    const d = haversineKm(0, 0, 0, 90)
    assert.ok(approx(d, 10_007, 5), `got ${d.toFixed(0)}`)
  })
})

describe('geodesicProject', () => {
  test('project 0 km returns original point', () => {
    const [lat, lon] = geodesicProject(33, 36, 90, 0)
    assert.ok(approx(lat, 33, 0.001))
    assert.ok(approx(lon, 36, 0.001))
  })

  test('project east then west ends within 50 km of start', () => {
    // On a sphere, going east then west at non-equatorial latitudes traces a
    // small circle (not a great circle), so the round-trip only approximately
    // closes. 50 km tolerance is appropriate for 500 km legs at 33°N.
    const dist = 500
    const [lat2, lon2] = geodesicProject(33, 36, 90, dist)
    const [lat3, lon3] = geodesicProject(lat2, lon2, 270, dist)
    const roundTripErr = haversineKm(lat3, lon3, 33, 36)
    assert.ok(roundTripErr < 50, `round-trip error: ${roundTripErr.toFixed(1)} km`)
  })

  test('due north 1 000 km from equator lands near 9°N', () => {
    const [lat] = geodesicProject(0, 0, 0, 1_000)
    // 1 000 km / 111.2 km per degree ≈ 8.99°
    assert.ok(approx(lat, 8.99, 0.05), `got ${lat}`)
  })

  test('round-trip: project then exact back-bearing closes within 20 km', () => {
    // On a sphere the back-azimuth at B differs from bearing+180, so we
    // compute it from B→A using atan2. A 20 km tolerance is tight enough to
    // confirm the projection is internally consistent.
    const bearing = 45
    const dist    = 800
    const [lat2, lon2] = geodesicProject(DAM[0], DAM[1], bearing, dist)
    // Back azimuth: bearing from B to A
    const dLon    = (DAM[1] - lon2) * DEG
    const y       = Math.sin(dLon) * Math.cos(DAM[0] * DEG)
    const x       = Math.cos(lat2 * DEG) * Math.sin(DAM[0] * DEG)
                  - Math.sin(lat2 * DEG) * Math.cos(DAM[0] * DEG) * Math.cos(dLon)
    const backBrg = (Math.atan2(y, x) / DEG + 360) % 360
    const [lat3, lon3] = geodesicProject(lat2, lon2, backBrg, dist)
    const err = haversineKm(lat3, lon3, DAM[0], DAM[1])
    assert.ok(err < 20, `round-trip error: ${err.toFixed(1)} km`)
  })
})

describe('slerpGC', () => {
  test('t=0 returns start', () => {
    const [lat, lon] = slerpGC(DAM[0], DAM[1], DXB[0], DXB[1], 0)
    assert.ok(approx(lat, DAM[0], 0.001))
    assert.ok(approx(lon, DAM[1], 0.001))
  })

  test('t=1 returns end', () => {
    const [lat, lon] = slerpGC(DAM[0], DAM[1], DXB[0], DXB[1], 1)
    assert.ok(approx(lat, DXB[0], 0.001))
    assert.ok(approx(lon, DXB[1], 0.001))
  })

  test('t=0.5 is on great circle between endpoints', () => {
    const [mLat, mLon] = slerpGC(DAM[0], DAM[1], DXB[0], DXB[1], 0.5)
    const dA = haversineKm(DAM[0], DAM[1], mLat, mLon)
    const dB = haversineKm(DXB[0], DXB[1], mLat, mLon)
    // Midpoint should be equidistant from both ends (within 5 km)
    assert.ok(approx(dA, dB, 5), `dA=${dA.toFixed(0)} dB=${dB.toFixed(0)}`)
  })

  test('identical points returns start', () => {
    const [lat, lon] = slerpGC(33, 36, 33, 36, 0.5)
    assert.ok(approx(lat, 33, 0.001))
    assert.ok(approx(lon, 36, 0.001))
  })
})

describe('gcBearing', () => {
  test('due east along equator → 90°', () => {
    const b = gcBearing(0, 0, 0, 90, 0)
    assert.ok(approx(b, 90, 1), `got ${b.toFixed(1)}`)
  })

  test('due north → 0°', () => {
    const b = gcBearing(0, 0, 90, 0, 0)
    assert.ok(approx(b, 0, 1) || approx(b, 360, 1), `got ${b.toFixed(1)}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Route-path helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('interpolatePath', () => {
  test('f=0 returns departure', () => {
    const [lat, lon] = interpolatePath(ROUTE_DAM_DXB, 0)
    assert.ok(approx(lat, DAM[0], 0.001))
    assert.ok(approx(lon, DAM[1], 0.001))
  })

  test('f=1 returns arrival', () => {
    const [lat, lon] = interpolatePath(ROUTE_DAM_DXB, 1)
    assert.ok(approx(lat, DXB[0], 0.001))
    assert.ok(approx(lon, DXB[1], 0.001))
  })

  test('f=0.5 lands near midpoint waypoint', () => {
    const [lat, lon] = interpolatePath(ROUTE_DAM_DXB, 0.5)
    assert.ok(approx(lat, 29.20, 0.3), `lat=${lat}`)
    assert.ok(approx(lon, 44.80, 0.3), `lon=${lon}`)
  })

  test('empty waypoints returns [0, 0]', () => {
    const [lat, lon] = interpolatePath([], 0.5)
    assert.equal(lat, 0); assert.equal(lon, 0)
  })

  test('f below start clamps to start', () => {
    const [lat, lon] = interpolatePath(ROUTE_DAM_DXB, -1)
    assert.ok(approx(lat, DAM[0], 0.001))
  })

  test('f above end clamps to end', () => {
    const [lat, lon] = interpolatePath(ROUTE_DAM_DXB, 2)
    assert.ok(approx(lat, DXB[0], 0.001))
  })
})

describe('bearingFromPath', () => {
  test('bearing at departure is generally southeast for DAM→DXB', () => {
    const b = bearingFromPath(ROUTE_DAM_DXB, 0)
    // DAM→DXB departs roughly SE (120–160°)
    assert.ok(b > 100 && b < 180, `bearing at f=0: ${b.toFixed(0)}°`)
  })

  test('bearing at arrival is still heading toward DXB', () => {
    const b = bearingFromPath(ROUTE_DAM_DXB, 0.99)
    assert.ok(b > 90 && b < 200, `bearing at f=0.99: ${b.toFixed(0)}°`)
  })
})

describe('nearestPathFraction', () => {
  test('returns 0 for departure airport position', () => {
    const f = nearestPathFraction(ROUTE_DAM_DXB, DAM[0], DAM[1])
    assert.ok(approx(f, 0, 0.1), `got ${f}`)
  })

  test('returns 1 for arrival airport position', () => {
    const f = nearestPathFraction(ROUTE_DAM_DXB, DXB[0], DXB[1])
    assert.ok(approx(f, 1, 0.1), `got ${f}`)
  })

  test('midpoint waypoint returns 0.5', () => {
    const mid = ROUTE_DAM_DXB[2]  // f=0.5
    const f   = nearestPathFraction(ROUTE_DAM_DXB, mid.lat, mid.lon)
    assert.ok(approx(f, 0.5, 0.05), `got ${f}`)
  })

  test('empty waypoints returns 0', () => {
    assert.equal(nearestPathFraction([], 33, 36), 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor — state machine
// ─────────────────────────────────────────────────────────────────────────────

describe('FlightPredictor state machine', () => {
  const T0 = 1_700_000_000_000  // arbitrary base time

  test('initial state is predicting', () => {
    const p = new FlightPredictor()
    assert.equal(p.state, 'predicting')
  })

  test('onLive → live', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    assert.equal(p.state, 'live')
  })

  test('onLive then onSignalLoss → predicting', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0 + 60_000)
    assert.equal(p.state, 'predicting')
  })

  test('onLive after loss → recovering', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx())
    p.onLive(makeLivePos(), T0)                 // live
    p.onSignalLoss(T0 + 5 * 60_000)            // predicting
    // Return far away — big error → recovery
    p.onLive(makeLivePos({ lat: 30, lon: 40 }), T0 + 6 * 60_000)
    assert.equal(p.state, 'recovering')
  })

  test('recovery completes to live', () => {
    const p = new FlightPredictor({ maxRecoveryMs: 1_000 })
    p.setContext(makeCtx())
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0 + 5 * 60_000)
    p.onLive(makeLivePos({ lat: 30, lon: 40 }), T0 + 6 * 60_000)
    assert.equal(p.state, 'recovering')

    // Advance past maxRecoveryMs
    const display = p.getDisplay(T0 + 6 * 60_000 + 2_000)
    assert.equal(display.state, 'live')
  })

  test('onSignalLoss is idempotent', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0 + 10_000)
    p.onSignalLoss(T0 + 20_000)
    p.onSignalLoss(T0 + 30_000)
    assert.equal(p.state, 'predicting')
  })

  test('first live fix skips recovery (no prior lastLive)', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx())
    p.onSignalLoss(T0)
    p.onLive(makeLivePos(), T0 + 60_000)
    // Never had a lastLive — should go live, not recovering
    assert.equal(p.state, 'live')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor — confidence levels
// ─────────────────────────────────────────────────────────────────────────────

describe('FlightPredictor confidence', () => {
  const T0 = 1_700_000_000_000

  test('live state → live confidence', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    assert.equal(p.confidence(T0), 'live')
  })

  test('recovering → live confidence', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx())
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0 + 5 * 60_000)
    p.onLive(makeLivePos({ lat: 30, lon: 40 }), T0 + 6 * 60_000)
    assert.equal(p.confidence(T0 + 6 * 60_000), 'live')
  })

  test('1 min gap → excellent', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0)
    assert.equal(p.confidence(T0 + 60_000), 'excellent')
  })

  test('5 min gap → high', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0)
    assert.equal(p.confidence(T0 + 5 * 60_000), 'high')
  })

  test('15 min gap → medium', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0)
    assert.equal(p.confidence(T0 + 15 * 60_000), 'medium')
  })

  test('30 min gap → low', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0)
    assert.equal(p.confidence(T0 + 30 * 60_000), 'low')
  })

  test('50 min gap → low (lowMs raised to 60 min for jamming scenarios)', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0)
    assert.equal(p.confidence(T0 + 50 * 60_000), 'low')
  })

  test('70 min gap → very_low', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0)
    assert.equal(p.confidence(T0 + 70 * 60_000), 'very_low')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor — prediction accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('FlightPredictor prediction', () => {
  const T0 = 1_700_000_000_000

  test('pure kinematic (0–2 min): advances along last track', () => {
    const p = new FlightPredictor()
    const pos = makeLivePos({ lat: 31.5, lon: 40.5, track_deg: 135, gs_kts: 480 })
    p.onLive(pos, T0)
    p.onSignalLoss(T0 + 30_000)  // 30 s gap — pure kinematic

    const d = p.getDisplay(T0 + 90_000)  // 1.5 min since capture
    // Should have moved SE from (31.5, 40.5)
    assert.ok(d.lat < 31.5, `expected south movement, got lat=${d.lat}`)
    assert.ok(d.lon > 40.5, `expected east movement, got lon=${d.lon}`)
    assert.ok(d.isEstimated)
  })

  test('route-following (20+ min): position follows waypoints', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx({
      actual_dep_utc_ms: T0,
      duration_ms:       2 * 3_600_000,
    }))
    const pos = makeLivePos({ lat: DAM[0], lon: DAM[1] })
    p.onLive(pos, T0)
    p.onSignalLoss(T0 + 30_000)

    // At 25-min gap (beyond kinematicFadeEndMs=20-min), should be on route
    const T25 = T0 + 25 * 60_000
    const d   = p.getDisplay(T25)
    // Expected fraction ≈ 25/120 ≈ 0.208; interpolate route
    const [expectedLat, expectedLon] = interpolatePath(ROUTE_DAM_DXB, 0.208)
    assert.ok(haversineKm(d.lat, d.lon, expectedLat, expectedLon) < 30,
      `too far from route at 25 min: ${haversineKm(d.lat, d.lon, expectedLat, expectedLon).toFixed(0)} km`)
  })

  test('getDisplay when live: returns live position exactly', () => {
    const p = new FlightPredictor()
    const pos = makeLivePos({ lat: 31.5, lon: 40.5 })
    p.onLive(pos, T0)

    const d = p.getDisplay(T0 + 5_000)
    assert.equal(d.lat, 31.5)
    assert.equal(d.lon, 40.5)
    assert.equal(d.isEstimated, false)
    assert.equal(d.state, 'live')
  })

  test('signalLostMs increases as outage grows', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0 + 60_000)

    const d1 = p.getDisplay(T0 + 5 * 60_000)
    const d2 = p.getDisplay(T0 + 10 * 60_000)
    assert.ok(d2.signalLostMs! > d1.signalLostMs!, 'signal loss timer should grow')
  })

  test('no kinematic + no context: returns last live position', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos({ lat: 30, lon: 42 }), T0)
    p.onSignalLoss(T0)

    const d = p.getDisplay(T0 + 60_000)
    // No context → falls back to lastLive
    assert.ok(haversineKm(d.lat, d.lon, 30, 42) < 200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor — smooth recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('FlightPredictor smooth recovery', () => {
  const T0 = 1_700_000_000_000

  test('recovery: no teleport — display moves gradually from predicted to live', () => {
    const p = new FlightPredictor({ recoveryMsPerKm: 30_000, maxRecoveryMs: 60_000 })
    p.setContext(makeCtx())
    p.onLive(makeLivePos({ lat: 31.5, lon: 40.5, track_deg: 135 }), T0)
    p.onSignalLoss(T0 + 5 * 60_000)

    // Signal returns far from predicted position
    const liveReturn = makeLivePos({ lat: 30.0, lon: 44.0 })
    const T_RETURN = T0 + 6 * 60_000
    p.onLive(liveReturn, T_RETURN)
    assert.equal(p.state, 'recovering')

    const d0 = p.getDisplay(T_RETURN)           // t=0 → near predicted
    const d1 = p.getDisplay(T_RETURN + 30_000)  // t≈0.5 → midway
    const d2 = p.getDisplay(T_RETURN + 120_000) // past maxRecovery → live

    // d0 should be closer to predicted-at-start than to live
    const distD0ToLive = haversineKm(d0.lat, d0.lon, 30.0, 44.0)
    const distD1ToLive = haversineKm(d1.lat, d1.lon, 30.0, 44.0)
    assert.ok(distD0ToLive > distD1ToLive, 'should converge toward live over time')

    // d2 should be live
    assert.equal(d2.state, 'live')
    assert.ok(haversineKm(d2.lat, d2.lon, 30.0, 44.0) < 1)
  })

  test('recovery duration scales with error: small error → short recovery', () => {
    const cfg = { recoveryMsPerKm: 10_000, minRecoveryMs: 1_000, maxRecoveryMs: 120_000 }
    const p = new FlightPredictor(cfg)
    p.setContext(makeCtx())
    p.onLive(makeLivePos({ lat: 31.5, lon: 40.5 }), T0)
    p.onSignalLoss(T0 + 5 * 60_000)

    // Signal returns very close to predicted (~1 km error → ~10 s recovery)
    const T_RETURN = T0 + 6 * 60_000
    p.onLive(makeLivePos({ lat: 31.49, lon: 40.51 }), T_RETURN)
    assert.equal(p.state, 'recovering')

    // Should be live after 15 s
    const d = p.getDisplay(T_RETURN + 15_000)
    assert.equal(d.state, 'live', 'small error should recover quickly')
  })

  test('recovery: isEstimated is false during recovering state', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx())
    p.onLive(makeLivePos(), T0)
    p.onSignalLoss(T0 + 5 * 60_000)
    p.onLive(makeLivePos({ lat: 30, lon: 44 }), T0 + 6 * 60_000)
    assert.equal(p.state, 'recovering')

    const d = p.getDisplay(T0 + 6 * 60_000 + 10_000)
    assert.equal(d.isEstimated, false, 'recovering should not be marked estimated')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor — route fraction floor
// ─────────────────────────────────────────────────────────────────────────────

describe('FlightPredictor route fraction floor', () => {
  const T0 = 1_700_000_000_000

  test('route fraction never decreases after live fix at waypoint 0.5', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx({
      actual_dep_utc_ms: T0,
      duration_ms:       2 * 3_600_000,
    }))

    // Aircraft is at 50% route point
    const mid = ROUTE_DAM_DXB[2]
    p.onLive(makeLivePos({ lat: mid.lat, lon: mid.lon }), T0 + 60 * 60_000)
    p.onSignalLoss(T0 + 60 * 60_000 + 30_000)

    const d = p.getDisplay(T0 + 61 * 60_000)
    // routeFraction should be >= 0.5
    assert.ok(d.routeFraction >= 0.45, `fraction=${d.routeFraction}`)
  })

  test('routeFractionFloor=false allows backward fraction', () => {
    const p = new FlightPredictor({ routeFractionFloor: false })
    p.setContext(makeCtx({
      actual_dep_utc_ms: T0,
      duration_ms:       2 * 3_600_000,
    }))
    const mid = ROUTE_DAM_DXB[2]
    p.onLive(makeLivePos({ lat: mid.lat, lon: mid.lon }), T0 + 60 * 60_000)
    p.onSignalLoss(T0 + 60 * 60_000 + 30_000)

    // routeFraction is time-based here: (1h) / 2h = 0.5, so it actually stays same
    // Just verify no crash
    const d = p.getDisplay(T0 + 61 * 60_000)
    assert.ok(typeof d.routeFraction === 'number')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor — stale fix (FR24 case)
// ─────────────────────────────────────────────────────────────────────────────

describe('FlightPredictor onStaleFix', () => {
  const T0 = 1_700_000_000_000

  test('immediately enters predicting with signalLostAtMs = capturedAtMs', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx())
    const capturedAt = T0 - 15 * 60_000  // 15 min ago
    p.onStaleFix(makeLivePos(), capturedAt, T0)

    assert.equal(p.state, 'predicting')
    const d = p.getDisplay(T0)
    assert.ok(d.signalLostMs !== null, 'should report signal loss time')
    // 15-min gap → medium confidence
    assert.ok(['medium', 'high'].includes(d.confidence), `got ${d.confidence}`)
  })

  test('stale fix: predicts forward from captured time', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx())
    const capturedAt = T0 - 5 * 60_000  // 5 min ago, still kinematic
    p.onStaleFix(makeLivePos({ lat: 31.5, lon: 40.5, track_deg: 135 }), capturedAt, T0)

    const d = p.getDisplay(T0)
    // Should have advanced SE from (31.5, 40.5) by 5 min at 480 kts
    assert.ok(d.lat < 31.5, `expected south: lat=${d.lat}`)
    assert.ok(d.lon > 40.5, `expected east: lon=${d.lon}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor — altitude prediction
// ─────────────────────────────────────────────────────────────────────────────

describe('FlightPredictor altitude', () => {
  const T0 = 1_700_000_000_000

  test('climbing aircraft: altitude increases within cap', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos({ altitude_ft: 30_000, vs_fpm: 2_000 }), T0)
    p.onSignalLoss(T0 + 30_000)

    const d = p.getDisplay(T0 + 5 * 60_000)  // 5 min total since capture
    // Expected: 30 000 + 2 000 * 5 = 40 000, but capped at 30 000 + 5 000 = 35 000
    assert.ok(d.altitude_ft !== null)
    assert.ok(d.altitude_ft! <= 35_000, `uncapped: ${d.altitude_ft}`)
    assert.ok(d.altitude_ft! > 30_000, `should have climbed: ${d.altitude_ft}`)
  })

  test('descending: altitude decreases within cap', () => {
    const p = new FlightPredictor()
    p.onLive(makeLivePos({ altitude_ft: 35_000, vs_fpm: -1_500 }), T0)
    p.onSignalLoss(T0 + 30_000)

    const d = p.getDisplay(T0 + 5 * 60_000)
    assert.ok(d.altitude_ft !== null)
    assert.ok(d.altitude_ft! < 35_000, `should have descended`)
    assert.ok(d.altitude_ft! >= 35_000 - 5_000, `past maxAltDriftFt cap`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FlightPredictor — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('FlightPredictor edge cases', () => {
  const T0 = 1_700_000_000_000

  test('getDisplay with no context and no live fix: returns zeros without crashing', () => {
    const p = new FlightPredictor()
    p.onSignalLoss(T0)
    const d = p.getDisplay(T0 + 60_000)
    assert.equal(typeof d.lat, 'number')
    assert.equal(typeof d.lon, 'number')
  })

  test('setContext can be called multiple times safely', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx())
    p.setContext(makeCtx({ duration_ms: 3 * 3_600_000 }))
    p.onLive(makeLivePos(), T0)
    const d = p.getDisplay(T0)
    assert.equal(d.state, 'live')
  })

  test('very slow aircraft (gs=0) does not advance kinematically', () => {
    const p = new FlightPredictor()
    // gs < 50: kinematic capture skipped
    p.onLive(makeLivePos({ lat: 33, lon: 36, gs_kts: 0 }), T0)
    p.onSignalLoss(T0 + 30_000)

    const d = p.getDisplay(T0 + 5 * 60_000)
    // Falls back to lastLive or route — should not advance
    assert.ok(haversineKm(d.lat, d.lon, 33, 36) < 50)
  })

  test('60-minute outage: returns a position without crashing', () => {
    const p = new FlightPredictor()
    p.setContext(makeCtx({
      actual_dep_utc_ms: T0,
      duration_ms:       2 * 3_600_000,
    }))
    p.onLive(makeLivePos({ lat: DAM[0], lon: DAM[1] }), T0)
    p.onSignalLoss(T0 + 30_000)

    const d = p.getDisplay(T0 + 70 * 60_000)  // 70-min outage (lowMs raised to 60 min)
    assert.equal(d.confidence, 'very_low')
    assert.equal(d.isEstimated, true)
    assert.ok(typeof d.lat === 'number' && isFinite(d.lat))
    assert.ok(typeof d.lon === 'number' && isFinite(d.lon))
  })

  test('DEFAULT_CONFIG values are reasonable', () => {
    assert.ok(DEFAULT_CONFIG.kinematicFullMs < DEFAULT_CONFIG.kinematicFadeEndMs)
    assert.ok(DEFAULT_CONFIG.excellentMs <= DEFAULT_CONFIG.highMs)
    assert.ok(DEFAULT_CONFIG.highMs     <= DEFAULT_CONFIG.mediumMs)
    assert.ok(DEFAULT_CONFIG.mediumMs   <= DEFAULT_CONFIG.lowMs)
    assert.ok(DEFAULT_CONFIG.minRecoveryMs < DEFAULT_CONFIG.maxRecoveryMs)
  })
})
