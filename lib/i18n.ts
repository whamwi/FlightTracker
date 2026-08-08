/**
 * Arabic and English, with Arabic treated as a first language rather than a translation.
 *
 * Most of this product is language-neutral already — flight numbers, times, IATA codes, gates
 * and registrations read the same in both. So the dictionary is small by nature, and the rule
 * is: translate the chrome, never the data. A flight is RB444 in Arabic too.
 *
 * Names that live in the database — cities, countries, airlines — are not here. They come from
 * `airports.city_ar` and `airlines.name_ar` via /api/airports and /api/airlines, so the app,
 * the WhatsApp templates and the emails share one source rather than three copies.
 */

export const LOCALES = ['en', 'ar'] as const
export type Locale = typeof LOCALES[number]

export const DEFAULT_LOCALE: Locale = 'en'

export const isLocale = (v: string | null | undefined): v is Locale =>
  !!v && (LOCALES as readonly string[]).includes(v)

/** Text direction. Drives `dir` on <html>, which is what mirrors the flexbox layout. */
export const dirOf = (l: Locale): 'rtl' | 'ltr' => (l === 'ar' ? 'rtl' : 'ltr')

type Dict = Record<string, string>

const en: Dict = {
  // Nav
  'nav.flights':       'Flights',
  'nav.track':         'Track',
  // The pill on the board, distinct from the nav tab: it says what tapping it does.
  'nav.track_button':  'Track',
  'nav.track_aria':    'Track flights on the live map',
  'nav.destinations':  'Destinations',
  'nav.airlines':      'Airlines',
  'nav.news':          'News',
  'nav.search':        'Flight number, city or airline',

  // Board — days
  'day.yesterday':     'Yesterday',
  'day.today':         'Today',
  'day.tomorrow':      'Tomorrow',

  // Board — views
  'view.arrivals':     'Arrivals',
  'view.departures':   'Departures',
  'board.arrivals_for':   'Arrivals',
  'board.departures_for': 'Departures',
  'board.no_arrivals':    'No arrivals',
  'board.no_departures':  'No departures',
  'board.tomorrow_note':  "Tomorrow's flights show scheduled times only · Live data arrives on the day",
  'board.updated':        'Schedule data updated every 60s',

  // Status. The board's own vocabulary — kept short because it sits in a badge.
  'status.scheduled':  'Scheduled',
  'status.expected':   'Expected',
  'status.departed':   'Departed',
  'status.arrived':    'Arrived',
  'status.landed':     'Landed',
  'status.delayed':    'Delayed',
  'status.cancelled':  'Cancelled',
  'status.unknown':    'Unknown',
  'status.checkin':    'Check-in',
  'status.boarding':   'Boarding',
  'status.gate_closed':'Gate Closed',
  'status.en_route':   'En route',
  'status.approaching':'Approaching',
  'status.diverted':   'Diverted',
  'label.scheduled_time': 'Scheduled time',
  'label.today_prefix':   'Today',
  'label.departure':      'Departure',
  'label.arrival':        'Arrival',
  'label.left':           'left',
  'label.arriving':       'Arriving',
  'label.elapsed':        'elapsed',
  'label.flight_time':    'Flight time',
  'label.gate':           'Gate',
  'label.scheduled':      'Scheduled',
  'label.actual':         'Actual',
  'label.estimated':      'Estimated',
  'label.updated':        'Updated',
  'error.flight_not_found': 'Flight not found',
  'error.no_data_for':      'No data for',
  'error.today_or_yesterday': 'today or yesterday',
  'action.all_flights':     'All flights',

  // Card actions
  'action.share':      'Share',
  'action.pin':        'Pin',
  'action.pinned':     'Pinned',
  'action.view_flights': 'View flights',
  'action.view_routes':  'View routes',
  'action.open_track':   'Open Track',

  // Map
  'map.live':          'Live map',
  'map.in_air':        'flights in air',
  'map.tiles':         'Leaflet · light tiles',

  // Destinations / Airlines
  'dest.title':        'Destinations',
  'dest.count':        'destinations',
  'airlines.title':    'Airlines',
  'airlines.count':    'airlines',
  'airlines.per_week': 'flights / week',
  'region.all':        'All',
  'region.gulf':       'Middle East & Gulf',
  'region.europe':     'Europeans',
  'region.med':        'Med Eastern',
  'region.middle_east':'Middle East',
  'region.europe_full':'Europe',
  'region.other':      'Other',

  // Board controls
  'sort.by':           'Sort',
  'sort.scheduled':    'Scheduled time',
  'sort.airline_az':   'Airline A→Z',
  'filter.airline':    'Airline',
  'period.last_7_days':'last 7 days',
  'period.today':      'today',

  // The now-line chips
  'chip.in_air':       'in air',
  'chip.arrived':      'arrived',
  'chip.departed':     'departed',
  'chip.now':          'NOW',

  // Store buttons
  'store.app_store':   'App Store',
  'store.google_play': 'Google Play',

  // Alerts CTA
  'cta.follow_title':  'Follow a flight from anywhere',
  'cta.follow_body':   'Get delay and landing alerts for the flights your family is on — free, no account needed.',
}

const ar: Dict = {
  'nav.flights':       'الرحلات',
  'nav.track':         'تتبّع',
  'nav.track_button':  'تابع الرحلة',
  'nav.track_aria':    'تابع الرحلات على الخريطة المباشرة',
  'nav.destinations':  'الوجهات',
  'nav.airlines':      'شركات الطيران',
  'nav.news':          'الأخبار',
  'nav.search':        'رقم الرحلة أو المدينة أو شركة الطيران',

  'day.yesterday':     'أمس',
  'day.today':         'اليوم',
  'day.tomorrow':      'غداً',

  'view.arrivals':     'القادمة',
  'view.departures':   'المغادرة',
  'board.arrivals_for':   'الرحلات القادمة',
  'board.departures_for': 'الرحلات المغادرة',
  'board.no_arrivals':    'لا توجد رحلات قادمة',
  'board.no_departures':  'لا توجد رحلات مغادرة',
  'board.tomorrow_note':  'رحلات الغد تعرض المواعيد المجدولة فقط · البيانات المباشرة تصل في يومها',
  // English numerals throughout, including inside Arabic sentences — a standing rule, and it
  // matters most for times, where ١٠:١٥ against a departure board is actively confusing.
  'board.updated':        'تُحدَّث بيانات الجدول كل 60 ثانية',

  'status.scheduled':  'مجدولة',
  'status.expected':   'متوقعة',
  'status.departed':   'غادرت',
  'status.arrived':    'وصلت',
  'status.landed':     'هبطت',
  'status.delayed':    'متأخرة',
  'status.cancelled':  'ملغاة',
  'status.unknown':    'غير معروف',
  'status.checkin':    'تسجيل الوصول',
  'status.boarding':   'الصعود',
  'status.gate_closed':'أُغلقت البوابة',
  'status.en_route':   'في الطريق',
  'status.approaching':'تقترب',
  'status.diverted':   'حُوِّلت',
  'label.scheduled_time': 'الموعد المجدول',
  'label.today_prefix':   'اليوم',
  'label.departure':      'المغادرة',
  'label.arrival':        'الوصول',
  'label.left':           'متبقٍّ',
  'label.arriving':       'تقترب',
  'label.elapsed':        'مضت',
  'label.flight_time':    'زمن الرحلة',
  'label.gate':           'البوابة',
  'label.scheduled':      'المجدول',
  'label.actual':         'الفعلي',
  'label.estimated':      'المتوقع',
  'label.updated':        'آخر تحديث',
  'error.flight_not_found': 'لم يتم العثور على الرحلة',
  'error.no_data_for':      'لا توجد بيانات للرحلة',
  'error.today_or_yesterday': 'اليوم أو أمس',
  'action.all_flights':     'كل الرحلات',

  'action.share':      'مشاركة',
  'action.pin':        'تثبيت',
  'action.pinned':     'مثبّتة',
  'action.view_flights': 'عرض الرحلات',
  'action.view_routes':  'عرض الخطوط',
  'action.open_track':   'فتح التتبّع',

  'map.live':          'الخريطة المباشرة',
  'map.in_air':        'رحلات في الجو',
  'map.tiles':         'Leaflet · خرائط فاتحة',

  'dest.title':        'الوجهات',
  'dest.count':        'وجهة',
  'airlines.title':    'شركات الطيران',
  'airlines.count':    'شركة',
  'airlines.per_week': 'رحلة / أسبوع',
  'region.all':        'الكل',
  'region.gulf':       'الشرق الأوسط والخليج',
  'region.europe':     'أوروبا',
  'region.med':        'شرق المتوسط',
  'region.middle_east':'الشرق الأوسط',
  'region.europe_full':'أوروبا',
  'region.other':      'أخرى',

  'sort.by':           'حسب',
  'sort.scheduled':    'الوقت المجدول',
  'sort.airline_az':   'شركة الطيران أ→ي',
  'filter.airline':    'الخطوط الجوية',
  'period.last_7_days':'آخر 7 أيام',
  'period.today':      'اليوم',

  'chip.in_air':       'في الجو',
  'chip.arrived':      'وصلت',
  'chip.departed':     'غادرت',
  'chip.now':          'الآن',

  'store.app_store':   'آب ستور',
  'store.google_play': 'جوجل بلاي',

  'cta.follow_title':  'تابع رحلتك من أي مكان',
  'cta.follow_body':   'تنبيهات التأخير والهبوط للرحلات التي يسافر عليها أهلك — مجاناً وبدون حساب.',
}

const DICTS: Record<Locale, Dict> = { en, ar }

/**
 * Look up a key, falling back to English and then to the key itself.
 *
 * Returning the key rather than empty is deliberate: a missing translation should be obvious
 * on the page during development, not an invisible gap in the layout.
 */
export function translate(locale: Locale, key: string): string {
  return DICTS[locale]?.[key] ?? DICTS.en[key] ?? key
}

/**
 * The board's status vocabulary maps to dictionary keys here rather than in the page.
 *
 * The keys on the left are FR24's words as the board stores them; the right is ours. Keeping
 * the mapping beside the dictionary is what lets the test below assert that every status the
 * board can display has a translation — from the page it would be a second list to forget.
 */
export const STATUS_KEY: Record<string, string> = {
  Scheduled:    'status.scheduled',
  Expected:     'status.expected',
  CheckIn:      'status.checkin',
  Boarding:     'status.boarding',
  GateClosed:   'status.gate_closed',
  Departed:     'status.departed',
  'En Route':   'status.en_route',
  Approaching:  'status.approaching',
  Arrived:      'status.arrived',
  Landed:       'status.arrived',
  Cancelled:    'status.cancelled',
  Diverted:     'status.diverted',
  Delayed:      'status.delayed',
  Unknown:      'status.unknown',
}

/** Every key, for a coverage check in tests. */
export const ALL_KEYS = Object.keys(en)
