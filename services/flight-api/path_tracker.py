"""
The website's marker mechanism, moved to the server.

A faithful port of lib/path-tracker.ts and lib/tracker-store.ts, not a reinterpretation. The
concept is the website's and has been in production for months: THE CORRIDOR OWNS THE POSITION,
and a fix only nudges the rate at which progress advances along it.

That is why the website never drew KNE591 at Queen Alia on 16 Aug while a bad FR24 row said it
was parked there — its marker was on the corridor at Damascus, on final, and it arrived. The
first version of this service picked the freshest fix instead, which is the APP's rule, and the
test map duly sat in Jordan and then jumped to Damascus.

Ported WITH backward correction, which the website's own copy does not currently have. Without
it `s` is monotonic — `clamp(s + v*dt, s, 1)` under a rate floor — so a tracker that runs ahead
of its aircraft cannot come back. Measured on identical inputs, a tracker seeded 298 km ahead
grew to 440 km over 40 polls in that version and closed to 61 km in this one. Same concept, one
bug fixed, and the fix is the app's.

STATE. Unlike geo.py this is deliberately stateful — progress and rate accumulate between polls,
which is the mechanism, not an accident of it. The service must therefore run as ONE process:
two instances would keep two trackers and the divergence we are removing would come straight
back. flight-api already holds state this way for hold_eta.
"""

from __future__ import annotations

import math

from geo import haversine_km, interpolate_path, bearing_from_path, _slerp, _num

KTS_TO_KM_PER_MS = 1.852 / 3_600_000
DEG = math.pi / 180
KM_PER_DEG = 111.194927
SYNTH_POINTS = 21


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def synthesize_path(dep, arr, n: int = SYNTH_POINTS) -> list[dict]:
    """A great circle as a waypoint list, for an OD pair with no recorded corridor."""
    out = []
    for i in range(n):
        t = i / (n - 1)
        lat, lon = _slerp(dep, arr, t)
        out.append({"f": t, "lat": lat, "lon": lon})
    return out


class PathGeometry:
    """
    A corridor, measured.

    `f` is the fraction stored on each waypoint; `sDist` is the fraction of actual DISTANCE
    flown. They are not the same, and conflating them is what makes an aircraft appear to
    accelerate through a bunched section of a route.
    """

    def __init__(self, wps: list[dict]):
        self.wps = wps
        self.cum = [0.0]
        acc = 0.0
        for i in range(len(wps) - 1):
            acc += haversine_km((wps[i]["lat"], wps[i]["lon"]),
                                (wps[i + 1]["lat"], wps[i + 1]["lon"]))
            self.cum.append(acc)
        self.total_km = acc

    @property
    def usable(self) -> bool:
        return len(self.wps) >= 2 and self.total_km > 0

    def to_path_f(self, s_dist: float) -> float:
        if not self.usable:
            return 0.0
        target = clamp(s_dist, 0, 1) * self.total_km
        lo, hi = 0, len(self.cum) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if self.cum[mid] <= target:
                lo = mid
            else:
                hi = mid
        span = self.cum[hi] - self.cum[lo]
        t = 0.0 if span < 1e-9 else (target - self.cum[lo]) / span
        return self.wps[lo]["f"] + t * (self.wps[hi]["f"] - self.wps[lo]["f"])

    def position_at(self, s_dist: float):
        return interpolate_path(self.wps, self.to_path_f(s_dist))

    def bearing_at(self, s_dist: float):
        return bearing_from_path(self.wps, self.to_path_f(s_dist))

    def project(self, lat: float, lon: float) -> tuple[float, float]:
        """Nearest point on the corridor: how far along, and how far off. Returns (s_dist, km)."""
        if not self.usable:
            return (0.0, float("inf"))
        best_s, best_km = 0.0, float("inf")
        for i in range(len(self.wps) - 1):
            a, b = self.wps[i], self.wps[i + 1]
            kx = math.cos(((a["lat"] + b["lat"]) / 2) * DEG) * KM_PER_DEG
            ax, ay = a["lon"] * kx, a["lat"] * KM_PER_DEG
            bx, by = b["lon"] * kx, b["lat"] * KM_PER_DEG
            px, py = lon * kx, lat * KM_PER_DEG
            dx, dy = bx - ax, by - ay
            len2 = dx * dx + dy * dy
            t = 0.0 if len2 < 1e-9 else clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)
            s_dist = (self.cum[i] + t * (self.cum[i + 1] - self.cum[i])) / self.total_km
            c = self.position_at(s_dist)
            km = haversine_km((lat, lon), c)
            if km < best_km:
                best_km, best_s = km, s_dist
        return (best_s, best_km)


DEFAULT_CONFIG = {
    "correction_horizon_ms": 5 * 60_000,
    "min_rate_factor": 0.5,
    "max_rate_factor": 1.6,
    "max_off_path_km": 40,
    "max_implied_gs_kts": 700,
    "initial_snap_window_ms": 5 * 60_000,
    "max_initial_snap_s": 0.15,
    "eta_rebuild_ms": 12 * 3_600_000,
    "backward_tolerance_s": 0.01,
    "backward_confirm_count": 2,
    "backward_correction_factor": 0.35,
    "divergence_count": 3,
    "min_remaining_ms": 60_000,
    "max_fix_age_ms": 30 * 60_000,
}


class PathTracker:
    """One flight's progress along its corridor. Values and thresholds are the website's."""

    def __init__(self, ctx: dict, now_ms: float, cfg: dict = DEFAULT_CONFIG):
        self.cfg = cfg
        self.ctx = dict(ctx)
        self.s = 0.0
        self.v = 0.0
        self.last_advance_ms = now_ms
        self.created_at_ms = now_ms
        self.last_accepted_fix: dict | None = None
        self.last_accepted_ms: float | None = None
        self.last_altitude_ft = None
        self.last_gs_kts = None
        self.has_accepted_fix = False
        self.backward_streak = 0
        self.pending_correction_s = 0.0
        self.chasing = False
        self.off_path_streak = 0
        self.mode = "path"
        self.rejects = {k: 0 for k in
                        ("off_path", "impossible_speed", "backward", "stale", "no_path")}

        stored = [v for v in (ctx.get("variants") or []) if v and len(v) >= 2]
        self.synthesized = not stored
        self.geos = ([PathGeometry(synthesize_path(ctx["dep_coords"], ctx["arr_coords"]))]
                     if self.synthesized else [PathGeometry(v) for v in stored])

        # Seed from elapsed time, exactly as the website does: a tracker created mid-flight starts
        # where the schedule says, not at the departure gate.
        if ctx.get("departed_at_ms") is not None:
            total = self._total_duration_ms()
            if total > 0:
                self.s = clamp((now_ms - ctx["departed_at_ms"]) / total, 0, 1)
        self.v = self._nominal_rate(now_ms)

    @property
    def geo(self) -> PathGeometry:
        return self.geos[0]

    def _total_duration_ms(self) -> float:
        dep, eta, dur = (self.ctx.get("departed_at_ms"), self.ctx.get("eta_ms"),
                         self.ctx.get("duration_ms"))
        if dep is not None and eta is not None and eta > dep:
            return eta - dep
        return dur or 0

    def _max_physical_rate(self) -> float:
        if not self.geo.usable:
            return float("inf")
        return (self.cfg["max_implied_gs_kts"] * KTS_TO_KM_PER_MS) / self.geo.total_km

    def _nominal_rate(self, now_ms: float) -> float:
        remaining_s = max(0.0, 1 - self.s)
        eta = self.ctx.get("eta_ms")
        if eta is not None:
            remaining_ms = max(eta - now_ms, self.cfg["min_remaining_ms"])
            rate = remaining_s / remaining_ms
        else:
            total = self._total_duration_ms()
            rate = 1 / total if total > 0 else 0
        return min(rate, self._max_physical_rate())

    def _rate_bounds(self, nominal: float) -> tuple[float, float]:
        # The floor yields while chasing, or a tracker that has to slow down cannot.
        lo = 0.0 if self.chasing else nominal * self.cfg["min_rate_factor"]
        hi = max(lo, min(nominal * self.cfg["max_rate_factor"], self._max_physical_rate()))
        return (lo, hi)

    def set_eta(self, eta_ms: float | None, now_ms: float) -> None:
        self.advance(now_ms)
        self.ctx["eta_ms"] = eta_ms
        self.v = self._nominal_rate(now_ms)

    def advance(self, now_ms: float) -> None:
        dt = now_ms - self.last_advance_ms
        self.last_advance_ms = now_ms
        if dt <= 0:
            return
        self.s = clamp(self.s + self.v * dt, self.s, 1)

        # Bleed off a backward correction rather than applying it at once: an aircraft that
        # jumped 100 km backwards on screen would be worse than one that is 100 km ahead.
        if self.pending_correction_s > 0:
            bleed = min(self.pending_correction_s,
                        self.pending_correction_s * (dt / self.cfg["correction_horizon_ms"]))
            self.s = clamp(self.s - bleed, 0, 1)
            self.pending_correction_s -= bleed
            if self.pending_correction_s < self.cfg["backward_tolerance_s"] / 100:
                self.pending_correction_s = 0.0

        lo, hi = self._rate_bounds(self._nominal_rate(now_ms))
        self.v = clamp(self.v, lo, hi)

    def _measured_rate(self, fix: dict) -> float | None:
        gs = _num(fix.get("gs_kts"))
        if gs is None or gs <= 0:
            return None
        if not (self.geo.total_km > 0):
            return None
        return min((gs * KTS_TO_KM_PER_MS) / self.geo.total_km, self._max_physical_rate())

    def _reject(self, reason: str, error_s=None) -> dict:
        self.rejects[reason] += 1
        return {"accepted": False, "reason": reason, "error_s": error_s}

    def apply_fix(self, fix: dict, now_ms: float) -> dict:
        """A fix corrects the RATE. It does not set the position — that is the whole idea."""
        self.advance(now_ms)
        if not self.geo.usable:
            return self._reject("no_path")
        if now_ms - fix["at_ms"] > self.cfg["max_fix_age_ms"]:
            return self._reject("stale")

        s_live, off_path_km = self.geo.project(fix["lat"], fix["lon"])

        # Too far off the corridor to be about this route at all.
        if off_path_km > self.cfg["max_off_path_km"]:
            self.off_path_streak += 1
            if self.off_path_streak >= self.cfg["divergence_count"]:
                self.mode = "diverged"
            return self._reject("off_path")

        # Two fixes implying an impossible ground speed: one of them is wrong, and the older one
        # has already been believed.
        if self.last_accepted_fix and self.last_accepted_ms is not None:
            dt_h = (fix["at_ms"] - self.last_accepted_ms) / 3_600_000
            if dt_h > 0:
                km = haversine_km((self.last_accepted_fix["lat"], self.last_accepted_fix["lon"]),
                                  (fix["lat"], fix["lon"]))
                if (km / 1.852) / dt_h > self.cfg["max_implied_gs_kts"]:
                    return self._reject("impossible_speed")
            else:
                return self._reject("stale")

        error_s = s_live - self.s
        corroborated_backward = False

        # One fix saying the aircraft is behind us is noise; two in a row is news.
        if self.has_accepted_fix and error_s < -self.cfg["backward_tolerance_s"]:
            self.backward_streak += 1
            if self.backward_streak < self.cfg["backward_confirm_count"]:
                return self._reject("backward", error_s)
            corroborated_backward = True
        else:
            self.backward_streak = 0
            self.chasing = False

        self.off_path_streak = 0
        self.mode = "path"
        self.last_accepted_fix = fix
        self.last_accepted_ms = fix["at_ms"]
        if fix.get("altitude_ft") is not None:
            self.last_altitude_ft = fix["altitude_ft"]
        if fix.get("gs_kts") is not None:
            self.last_gs_kts = fix["gs_kts"]

        # The first fix is believed rather than refused as backward, but only near startup and
        # only for a small disagreement — otherwise a bad first fix would define the flight.
        within_startup = now_ms - self.created_at_ms <= self.cfg["initial_snap_window_ms"]
        if not self.has_accepted_fix:
            self.has_accepted_fix = True
            if within_startup and abs(error_s) <= self.cfg["max_initial_snap_s"]:
                self.s = clamp(s_live, 0, 1)

        if corroborated_backward and s_live != self.s:
            self.pending_correction_s = min(-error_s * self.cfg["backward_correction_factor"], 1)
            self.chasing = True
            error_s = error_s * (1 - self.cfg["backward_correction_factor"])

        nominal = self._nominal_rate(now_ms)
        measured = self._measured_rate(fix)
        base = nominal if measured is None else measured
        target = base + error_s / self.cfg["correction_horizon_ms"]
        lo, hi = ((0.0, self._max_physical_rate()) if measured is not None
                  else self._rate_bounds(nominal))
        self.v = clamp(target, lo, hi)
        return {"accepted": True, "reason": None, "error_s": error_s}

    def position(self, now_ms: float) -> dict:
        self.advance(now_ms)
        has_path = self.geo.usable
        if has_path:
            lat, lon = self.geo.position_at(self.s)
            track = self.geo.bearing_at(self.s)
        else:
            a, b = self.ctx["dep_coords"], self.ctx["arr_coords"]
            lat = a[0] + (b[0] - a[0]) * self.s
            lon = a[1] + (b[1] - a[1]) * self.s
            track = None
        fix_age_ms = None if self.last_accepted_ms is None else now_ms - self.last_accepted_ms
        return {
            "lat": lat,
            "lon": lon,
            "track_deg": track,
            "route_fraction": self.s,
            "mode": self.mode,
            "is_estimated": fix_age_ms is None or fix_age_ms > self.cfg["correction_horizon_ms"],
            "fix_age_ms": fix_age_ms,
            "altitude_ft": self.last_altitude_ft,
            "ground_speed_kts": self.last_gs_kts,
        }


class TrackerStore:
    """
    One tracker per callsign, rebuilt when the flight underneath it changes.

    Rebuild rules are the website's: a different departure instant is a different leg, and
    progress is monotonic, so carrying the old tracker over would start the new flight wherever
    the previous one finished. An ETA that moves by more than half a day is a data change rather
    than a delay, and is also a rebuild.
    """

    def __init__(self, cfg: dict = DEFAULT_CONFIG):
        self.cfg = cfg
        self.trackers: dict[str, PathTracker] = {}
        self.last_fix_at: dict[str, float] = {}
        self.last_eta: dict[str, float | None] = {}
        self.last_departed: dict[str, float | None] = {}
        self.last_outcome: dict[str, dict] = {}

    def _new(self, f: dict, now_ms: float) -> PathTracker:
        return PathTracker({
            "variants": f.get("variants") or [],
            "dep_coords": f["dep_coords"],
            "arr_coords": f["arr_coords"],
            "departed_at_ms": f.get("departed_at_ms"),
            "eta_ms": f.get("eta_ms"),
            "duration_ms": f.get("duration_ms"),
        }, now_ms, self.cfg)

    def update(self, inputs: list[dict], now_ms: float) -> None:
        seen = set()
        for f in inputs:
            cs = f["callsign"]
            seen.add(cs)
            t = self.trackers.get(cs)

            if t is None:
                t = self._new(f, now_ms)
                self.trackers[cs] = t
                self.last_eta[cs] = f.get("eta_ms")
                self.last_departed[cs] = f.get("departed_at_ms")
            elif cs in self.last_departed and f.get("departed_at_ms") != self.last_departed[cs]:
                t = self._new(f, now_ms)
                self.trackers[cs] = t
                self.last_fix_at.pop(cs, None)
                self.last_outcome.pop(cs, None)
                self.last_eta[cs] = f.get("eta_ms")
                self.last_departed[cs] = f.get("departed_at_ms")
            elif f.get("eta_ms") != self.last_eta.get(cs):
                prev = self.last_eta.get(cs)
                shifted = abs(f["eta_ms"] - prev) if (prev is not None and f.get("eta_ms")) else 0
                if shifted > self.cfg["eta_rebuild_ms"]:
                    t = self._new(f, now_ms)
                    self.trackers[cs] = t
                    self.last_fix_at.pop(cs, None)
                    self.last_outcome.pop(cs, None)
                    self.last_departed[cs] = f.get("departed_at_ms")
                else:
                    t.set_eta(f.get("eta_ms"), now_ms)
                self.last_eta[cs] = f.get("eta_ms")

            fix = f.get("fix")
            if fix and fix.get("at_ms") != self.last_fix_at.get(cs):
                self.last_fix_at[cs] = fix["at_ms"]
                outcome = t.apply_fix(fix, now_ms)
                self.last_outcome[cs] = {**outcome, "at_ms": fix["at_ms"]}

        for cs in list(self.trackers):
            if cs not in seen:
                self.drop(cs)

    def position(self, callsign: str, now_ms: float) -> dict | None:
        t = self.trackers.get(callsign)
        return t.position(now_ms) if t else None

    def has(self, callsign: str) -> bool:
        return callsign in self.trackers

    def outcome(self, callsign: str) -> dict | None:
        return self.last_outcome.get(callsign)

    def drop(self, callsign: str) -> None:
        for d in (self.trackers, self.last_fix_at, self.last_eta,
                  self.last_departed, self.last_outcome):
            d.pop(callsign, None)
