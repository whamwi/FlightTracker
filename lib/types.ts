export type Flight = {
  iata_number:    string
  airline_name:   string
  airline_iata:   string
  country_flag:   string
  dep_iata:       string
  arr_iata:       string
  dep_time_utc:   string
  arr_time_utc:   string
  sched_dep_unix: number | null
  duration_min:   number
  status:         string
  actual_dep_utc:  string | null
  actual_arr_utc:  string | null
  revised_dep_utc: string | null
  revised_arr_utc: string | null
  aircraft_type:   string | null
  dep_terminal:    string | null
  dep_gate:        string | null
  arr_terminal:    string | null
  arr_gate:        string | null
  arr_baggage:     string | null
}

export type Airport = 'DAM' | 'ALP'
export type View    = 'arr' | 'dep'
