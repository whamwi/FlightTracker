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

/**
 * What a visitor with no language in their URL gets.
 *
 * Distinct from DEFAULT_LOCALE, which is a fact about the URL scheme: English is the
 * unprefixed one, so every link and search result that already exists keeps meaning what it
 * meant. This is a fact about the audience — someone arriving at the bare root of a Syrian
 * aviation site is more likely to want Arabic. Only the root consults it.
 */
export const ROOT_LOCALE: Locale = 'ar'

export const isLocale = (v: string | null | undefined): v is Locale =>
  !!v && (LOCALES as readonly string[]).includes(v)

export const SITE_URL = 'https://www.flysyria.app'

/**
 * The canonical and hreflang set for one page, given the URL the visitor is on.
 *
 * Every page exists at two addresses and each must claim itself. Pointing /ar at the English
 * URL — which is what the flight pages did — is not a hint that they are related, it is an
 * instruction to drop the Arabic one, and Google obeys it.
 *
 * x-default goes to English: it is the unprefixed URL, the one already shared and indexed, and
 * the sensible landing place for a reader whose language we do not have.
 */
export function alternatesFor(visiblePath: string) {
  // Read the prefix, do not infer it from whether the path changed: /en is a root alias for /,
  // so it rewrites like a prefixed path while being the English page.
  const prefix = `/${LOCALES.find(l => l !== DEFAULT_LOCALE) ?? 'ar'}`
  const isAr   = visiblePath === prefix || visiblePath.startsWith(`${prefix}/`)

  const bare   = isAr ? (visiblePath.slice(prefix.length) || '/')
               : visiblePath === '/en' ? '/'
               : visiblePath
  const suffix = bare === '/' ? '' : bare

  const en = `${SITE_URL}${suffix}`
  const ar = `${SITE_URL}${prefix}${suffix}`
  return {
    canonical: isAr ? ar : en,
    languages: { en, ar, 'x-default': en },
  }
}

/** Text direction. Drives `dir` on <html>, which is what mirrors the flexbox layout. */
export const dirOf = (l: Locale): 'rtl' | 'ltr' => (l === 'ar' ? 'rtl' : 'ltr')

/**
 * The tag to format dates under, for a reader of this locale.
 *
 * `ar-SY` gives the Levantine month names a Syrian reader actually uses — آب, not أغسطس — and
 * `-u-nu-latn` keeps the digits Latin, the house rule everywhere a number carries meaning. Plain
 * 'ar-SY' would render ٨ آب ٢٠٢٦.
 *
 * A tag rather than a formatter, because the three call sites want different parts of a date:
 * the day chip wants "13 Aug", the page heading wants a weekday too, the news list wants a year.
 * Only the locale decision is shared, and it is the part that was being got wrong — the board
 * had 'en-GB' hard-coded in both of its formatters, so the Arabic board read اليوم · 13 Aug.
 */
export const dateLocaleOf = (l: Locale): string => (l === 'ar' ? 'ar-SY-u-nu-latn' : 'en-GB')

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
  /*
   * Live phases. Only the ones with no equivalent already — the airborne pair deliberately has
   * no entry and reads from status.departed / status.in_air instead.
   *
   * The app's PhaseChip records why: the status badge said في الجو, the map popup said في الجو,
   * the NOW chip said في الجو, and the chip added last said في الطريق. A reader watching one
   * flight across three surfaces saw three vocabularies and reasonably assumed they meant
   * different things. These strings are copied from the app so the web cannot become a fourth.
   */
  'phase.taxiing':      'Taxi to take off',
  'phase.landed':       'Landed',
  'phase.taxi_to_gate': 'Taxi to gate',
  'phase.at_gate':      'At the gate',
  'phase.bags_on_belt': 'Bags on belt',
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
  // Same strings the app uses, so a passenger reading the board and then the phone
  // sees one vocabulary. 'label.terminal' is copied verbatim from the app's dictionary.
  'label.terminal':       'Terminal',
  'label.belt':           'Belt',
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
  'map.over_syria':    'Over Syria',
  'map.overflight':    'Overflight',
  'map.altitude':      'Altitude',
  'map.speed':         'Speed',
  'unit.ft':           'ft',
  'unit.kt':           'kt',
  'map.unknown_airline': 'Unknown airline',
  'map.no_signal':     'Schedule projection · no live signal',
  'map.signal_lost':   'Signal lost',
  'map.dead_reckoning':'Dead reckoning from',
  'status.signal_lost':'Signal Lost',
  'label.flown':       'flown',
  'label.next_day':    'Arrives the next day',
  'map.panel_title':   'Flights in air',
  // The panel only ever holds airborne flights, so Departed and En Route both say the same
  // thing here. Approaching keeps its own word — that one is telling you something new.
  'status.in_air':     'In air',
  'map.until_arrival': 'left',
  'map.arriving_soon': 'Arriving soon',
  'map.no_flights':    'No flights in air',
  'map.none_currently':'No flights currently in air',
  'map.sorted':        'sorted by arrival',
  'map.authority_photos': 'Authority Photos',
  'map.photo_alt':        'Aviation Authority photo',
  'action.view_all':      'view all',
  'action.previous':      'Previous',
  'action.next':          'Next',
  'action.close':         'Close',
  'label.of':             'of',
  'map.to':            'To:',
  'map.from':          'From:',
  'action.clear':          'Clear',
  'action.clear_selected': 'Clear selected flight',
  'action.close_panel':    'Close panel',

  // Destinations / Airlines
  'dest.title':        'Destinations',
  'airlines.title':    'Airlines',
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

  // Destinations
  'dest.loading':         'Loading destinations…',
  'dest.no_match':        'No destination matches',
  'dest.no_flights':      'No scheduled flights found',
  'dest.time_varies':     'time varies by day — tap a day',
  'dest.time_for_day':    'time for the selected day',
  'dest.search':          'Search a city or airline',
  'dest.search_aria':     'Search destinations',
  'action.clear_search':  'Clear search',
  'action.view':          'View',
  'region.all_full':      'All regions',
  'region.europe_turkey': 'Europe & Turkey',
  /*
   * Single-letter day chips, English in both languages.
   *
   * Arabic initials don't survive the reduction: الأحد and الاثنين both start with ا, as do
   * الأربعاء and الاثنين once you allow for the hamza, so any one-letter set has to reach past
   * the first letter for some days and not others — which is what made the first attempt read
   * wrong. Syrian Airlines' own Arabic booking calendar keeps the Latin abbreviations, and so
   * do the other carriers; the aria-label below carries the full Arabic name for anyone who
   * needs it spoken.
   */
  'dow.sun': 'S', 'dow.mon': 'M', 'dow.tue': 'T', 'dow.wed': 'W',
  'dow.thu': 'T', 'dow.fri': 'F', 'dow.sat': 'S',
  // Full names, for the day buttons' aria-label — the letter alone is useless read aloud.
  'dowfull.sun': 'Sunday',   'dowfull.mon': 'Monday', 'dowfull.tue': 'Tuesday',
  'dowfull.wed': 'Wednesday','dowfull.thu': 'Thursday','dowfull.fri': 'Friday',
  'dowfull.sat': 'Saturday',
  'a11y.departs': 'departs',

  // Airlines
  'airlines.search':      'Search airlines or a city',
  'airlines.search_aria': 'Search airlines',
  'airlines.loading':     'Loading airlines…',
  'airlines.no_match':    'No airline matches',
  'airlines.none':        'No airlines found',
  'airlines.from':        'From',
  'airlines.to':          'To',
  'region.all_airlines':  'All regions',
  'action.website':       'Website',

  // Counted nouns — see countLabel below. English needs two forms; Arabic needs five.
  'noun.dest.one':    'destination', 'noun.dest.other':    'destinations',
  'noun.airline.one': 'airline',     'noun.airline.other': 'airlines',
  'noun.flight.one':  'flight',      'noun.flight.other':  'flights',
  'noun.route.one':   'route',       'noun.route.other':   'routes',
  'noun.minute.one':  'minute',      'noun.minute.other':  'minutes',
  'noun.hour.one':    'hour',        'noun.hour.other':    'hours',
  // News
  'news.title':      'Aviation Authority Updates',
  'news.blurb':      'Photos and videos from the Syrian General Authority of Civil Aviation, alongside selected clips from the airlines flying Syria.',
  'news.authority':  'Syrian General Authority of Civil Aviation',
  'news.tab_videos': 'Videos',
  'news.tab_photos': 'Photos',
  'news.tab_all':    'All',
  'news.video':      'VIDEO',
  'news.photo':      'PHOTO',
  'news.empty':      'No media yet — the next sync will populate this page.',
  'news.load_more':  'Load more',
  'news.source':     'View original',
  'news.media_alt':  'SyrGACA media',
  'news.video_alt':  'SyrGACA video',
  'label.loading':   'Loading…',

  'label.week':       'week',
  'label.this_week':  'this week',
  'label.weekly':     '/ wk',
}

const ar: Dict = {
  'nav.flights':       'الرحلات',
  'nav.track':         'مسار الرحلات',
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

  // Feminine throughout, agreeing with الرحلة — the app's rule.
  'phase.taxiing':      'تستعد للإقلاع',
  'phase.landed':       'هبطت',
  'phase.taxi_to_gate': 'في الطريق إلى البوابة',
  'phase.at_gate':      'على البوابة',
  // حقائب rather than the app's أمتعة, following the belt label you corrected. The app still
  // says 'الأمتعة على السير' and should be aligned to whichever of the two you settle on.
  'phase.bags_on_belt': 'الحقائب على السير',
  'status.scheduled':  'مجدولة',
  'status.expected':   'متوقعة',
  'status.departed':   'أقلعت',
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
  'label.left':           'على الوصول',
  'label.arriving':       'تقترب',
  'label.elapsed':        'مضت',
  'label.flight_time':    'زمن الرحلة',
  'label.gate':           'البوابة',
  'label.terminal':       'مبنى',
  'label.belt':           'حقائب',
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
  'action.view_flights': 'تفاصيل الرحلات',
  'action.view_routes':  'تفاصيل الرحلات',
  'action.open_track':   'فتح التتبّع',

  'map.live':          'الخريطة المباشرة',
  'map.in_air':        'رحلات في الجو',
  'map.tiles':         'Leaflet · خرائط فاتحة',
  'map.over_syria':    'فوق الأجواء السورية',
  'map.overflight':    'عابرة',
  'map.altitude':      'الارتفاع',
  'map.speed':         'السرعة',
  'unit.ft':           'قدم',
  'unit.kt':           'عقدة',
  'map.unknown_airline': 'شركة غير معروفة',
  'map.no_signal':     'تقدير حسب الجدول · لا توجد إشارة مباشرة',
  'map.signal_lost':   'انقطعت الإشارة',
  'map.dead_reckoning':'تقدير المسار منذ',
  'status.signal_lost':'انقطعت الإشارة',
  'label.flown':       'مضت',
  'label.next_day':    'يصل في اليوم التالي',
  'map.panel_title':   'رحلات في الجو',
  'status.in_air':     'في الجو',
  'map.until_arrival': 'على الوصول',
  'map.arriving_soon': 'يقترب من الهبوط',
  'map.no_flights':    'لا توجد رحلات في الجو',
  'map.none_currently':'لا توجد رحلات في الجو حالياً',
  'map.sorted':        'مرتبة حسب الوصول',
  'map.authority_photos': 'صور الهيئة',
  'map.photo_alt':        'صورة من الهيئة العامة للطيران المدني',
  'action.view_all':      'عرض الكل',
  'action.previous':      'السابق',
  'action.next':          'التالي',
  'action.close':         'إغلاق',
  'label.of':             'من',
  'map.to':            'إلى:',
  'map.from':          'من:',
  'action.clear':          'مسح',
  'action.clear_selected': 'إلغاء تحديد الرحلة',
  'action.close_panel':    'إغلاق اللوحة',

  'dest.title':        'الوجهات',
  'airlines.title':    'شركات الطيران',
  'region.all':        'الكل',
  'region.gulf':       'الشرق الأوسط',
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
  'chip.departed':     'أقلعت',
  'chip.now':          'الآن',

  'store.app_store':   'آب ستور',
  'store.google_play': 'جوجل بلاي',

  'cta.follow_title':  'تابع رحلتك من أي مكان',
  'cta.follow_body':   'تنبيهات التأخير والهبوط للرحلات التي يسافر عليها أهلك — مجاناً وبدون حساب.',

  'dest.loading':         'جارٍ تحميل الوجهات…',
  'dest.no_match':        'لا توجد وجهة تطابق',
  'dest.no_flights':      'لا توجد رحلات مجدولة',
  'dest.time_varies':     'الوقت يختلف حسب اليوم — اختر يوماً',
  'dest.time_for_day':    'اختار اليوم لمعرفة وقت الرحلة',
  'dest.search':          'ابحث عن مدينة أو شركة طيران',
  'dest.search_aria':     'البحث في الوجهات',
  'action.clear_search':  'مسح البحث',
  'action.view':          'عرض',
  'region.all_full':      'كل الوجهات',
  'region.europe_turkey': 'أوروبا وتركيا',
  // Latin initials on purpose — see the note beside the English set.
  'dow.sun': 'S', 'dow.mon': 'M', 'dow.tue': 'T', 'dow.wed': 'W',
  'dow.thu': 'T', 'dow.fri': 'F', 'dow.sat': 'S',
  'dowfull.sun': 'الأحد',    'dowfull.mon': 'الاثنين', 'dowfull.tue': 'الثلاثاء',
  'dowfull.wed': 'الأربعاء', 'dowfull.thu': 'الخميس',  'dowfull.fri': 'الجمعة',
  'dowfull.sat': 'السبت',
  'a11y.departs': 'تقلع',

  'airlines.search':      'ابحث عن شركة طيران أو مدينة',
  'airlines.search_aria': 'البحث في شركات الطيران',
  'airlines.loading':     'جارٍ تحميل شركات الطيران…',
  'airlines.no_match':    'لا توجد شركة طيران تطابق',
  'airlines.none':        'لا توجد شركات طيران',
  'airlines.from':        'من',
  'airlines.to':          'إلى',
  'region.all_airlines':  'كل الشركات',
  'action.website':       'الموقع الإلكتروني',

  'noun.dest.zero':    'وجهات', 'noun.dest.one':    'وجهة', 'noun.dest.two':    'وجهتان',
  'noun.dest.few':     'وجهات', 'noun.dest.many':   'وجهة', 'noun.dest.other':  'وجهة',
  'noun.airline.zero': 'شركات', 'noun.airline.one': 'شركة', 'noun.airline.two': 'شركتان',
  'noun.airline.few':  'شركات', 'noun.airline.many':'شركة', 'noun.airline.other':'شركة',
  'noun.flight.zero':  'رحلات', 'noun.flight.one':  'رحلة', 'noun.flight.two':  'رحلتان',
  'noun.flight.few':   'رحلات', 'noun.flight.many': 'رحلة', 'noun.flight.other':'رحلة',
  'noun.route.zero':   'خطوط',  'noun.route.one':   'خط',   'noun.route.two':   'خطان',
  'noun.route.few':    'خطوط',  'noun.route.many':  'خط',   'noun.route.other': 'خط',
  'noun.minute.zero':  'دقائق', 'noun.minute.one':  'دقيقة','noun.minute.two':  'دقيقتان',
  'noun.minute.few':   'دقائق', 'noun.minute.many': 'دقيقة','noun.minute.other':'دقيقة',
  'noun.hour.zero':    'ساعات', 'noun.hour.one':    'ساعة', 'noun.hour.two':    'ساعتان',
  'noun.hour.few':     'ساعات', 'noun.hour.many':   'ساعة', 'noun.hour.other':  'ساعة',
  'news.title':      'أخبار الهيئة العامة للطيران المدني',
  'news.blurb':      'صور ومقاطع من الهيئة العامة للطيران المدني، إلى جانب مقاطع مختارة من شركات الطيران العاملة في سوريا.',
  'news.authority':  'الهيئة العامة للطيران المدني',
  'news.tab_videos': 'فيديو',
  'news.tab_photos': 'صور',
  'news.tab_all':    'الكل',
  'news.video':      'فيديو',
  'news.photo':      'صورة',
  'news.empty':      'لا توجد مواد بعد — ستظهر مع المزامنة القادمة.',
  'news.load_more':  'عرض المزيد',
  'news.source':     'المصدر',
  'news.media_alt':  'من هيئة الطيران المدني',
  'news.video_alt':  'مقطع من هيئة الطيران المدني',
  'label.loading':   'جارٍ التحميل…',

  'label.week':       'أسبوع',
  'label.this_week':  'هذا الأسبوع',
  'label.weekly':     'أسبوعيا',
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

export type PluralCat = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

/**
 * Which form of a counted noun the number takes.
 *
 * Arabic does not split at one the way English does. The number decides the noun's form:
 *
 *     1        وجهة      singular
 *     2        وجهتان    dual
 *     3–10     وجهات     plural
 *     11–99    وجهة      singular again
 *     100+     وجهة      singular
 *
 * So `10 وجهات` and `22 وجهة` are both correct, and no single string serves both — which is
 * what `10 وجهة` on the airline sheet was getting wrong. The categories are CLDR's, so the
 * rule stays recognisable to anyone who has met it before.
 */
export function pluralCategory(locale: Locale, n: number): PluralCat {
  if (locale !== 'ar') return n === 1 ? 'one' : 'other'
  const m100 = Math.abs(n) % 100
  if (n === 0) return 'zero'
  if (n === 1) return 'one'
  if (n === 2) return 'two'
  if (m100 >= 3 && m100 <= 10) return 'few'
  if (m100 >= 11 && m100 <= 99) return 'many'
  return 'other'
}

/**
 * The noun alone, in the form the count requires. `base` is a key prefix such as `noun.flight`.
 *
 * Falls back to `<base>.other` rather than to the key itself: English defines only `.one` and
 * `.other`, so the Arabic-only categories have to land somewhere sensible.
 */
export function countLabel(locale: Locale, n: number, base: string): string {
  const dict = DICTS[locale] ?? DICTS.en
  return dict[`${base}.${pluralCategory(locale, n)}`] ?? dict[`${base}.other`] ?? base
}

/**
 * The numeral, or nothing when the noun already carries the count.
 *
 * Arabic's dual is marked on the noun itself — رحلتان *is* "two flights" — so writing the 2
 * as well says it twice. Every other count needs the numeral.
 */
export const countNumber = (locale: Locale, n: number): string =>
  pluralCategory(locale, n) === 'two' ? '' : String(n)

/** The number and its noun: `34 flights`, `10 وجهات`, `22 وجهة`, `رحلتان`. */
export const counted = (locale: Locale, n: number, base: string): string =>
  [countNumber(locale, n), countLabel(locale, n, base)].filter(Boolean).join(' ')

/** Every key, for a coverage check in tests. */
export const ALL_KEYS = Object.keys(en)
