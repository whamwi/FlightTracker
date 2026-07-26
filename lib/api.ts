import { API_BASE } from './constants'
import type { Flight } from './types'

export async function fetchFlights(date: string): Promise<Flight[]> {
  const res = await fetch(`${API_BASE}/api/flightboard?date=${date}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json.flights ?? []
}
