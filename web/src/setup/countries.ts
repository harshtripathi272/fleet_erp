/**
 * What choosing a country fills in on "Set up a company": its currency, dialling code and main time zone, and how
 * it usually writes dates and numbers. These are starting points, each of which the person can change. Names come
 * from the browser, so nothing here needs translating.
 */

/** code, currency, dialling code, main time zone */
const TABLE = `AD EUR 376 Europe/Andorra|AE AED 971 Asia/Dubai|AF AFN 93 Asia/Kabul|AG XCD 1268 America/Antigua|AL ALL 355 Europe/Tirane|AM AMD 374 Asia/Yerevan|AO AOA 244 Africa/Luanda|AR ARS 54 America/Argentina/Buenos_Aires|AT EUR 43 Europe/Vienna|AU AUD 61 Australia/Sydney|AZ AZN 994 Asia/Baku|BA BAM 387 Europe/Sarajevo|BB BBD 1246 America/Barbados|BD BDT 880 Asia/Dhaka|BE EUR 32 Europe/Brussels|BF XOF 226 Africa/Ouagadougou|BG BGN 359 Europe/Sofia|BH BHD 973 Asia/Bahrain|BI BIF 257 Africa/Bujumbura|BJ XOF 229 Africa/Porto-Novo|BN BND 673 Asia/Brunei|BO BOB 591 America/La_Paz|BR BRL 55 America/Sao_Paulo|BS BSD 1242 America/Nassau|BT BTN 975 Asia/Thimphu|BW BWP 267 Africa/Gaborone|BY BYN 375 Europe/Minsk|BZ BZD 501 America/Belize|CA CAD 1 America/Toronto|CD CDF 243 Africa/Kinshasa|CF XAF 236 Africa/Bangui|CG XAF 242 Africa/Brazzaville|CH CHF 41 Europe/Zurich|CI XOF 225 Africa/Abidjan|CL CLP 56 America/Santiago|CM XAF 237 Africa/Douala|CN CNY 86 Asia/Shanghai|CO COP 57 America/Bogota|CR CRC 506 America/Costa_Rica|CU CUP 53 America/Havana|CV CVE 238 Atlantic/Cape_Verde|CY EUR 357 Asia/Nicosia|CZ CZK 420 Europe/Prague|DE EUR 49 Europe/Berlin|DJ DJF 253 Africa/Djibouti|DK DKK 45 Europe/Copenhagen|DM XCD 1767 America/Dominica|DO DOP 1809 America/Santo_Domingo|DZ DZD 213 Africa/Algiers|EC USD 593 America/Guayaquil|EE EUR 372 Europe/Tallinn|EG EGP 20 Africa/Cairo|ER ERN 291 Africa/Asmara|ES EUR 34 Europe/Madrid|ET ETB 251 Africa/Addis_Ababa|FI EUR 358 Europe/Helsinki|FJ FJD 679 Pacific/Fiji|FR EUR 33 Europe/Paris|GA XAF 241 Africa/Libreville|GB GBP 44 Europe/London|GD XCD 1473 America/Grenada|GE GEL 995 Asia/Tbilisi|GH GHS 233 Africa/Accra|GM GMD 220 Africa/Banjul|GN GNF 224 Africa/Conakry|GQ XAF 240 Africa/Malabo|GR EUR 30 Europe/Athens|GT GTQ 502 America/Guatemala|GW XOF 245 Africa/Bissau|GY GYD 592 America/Guyana|HK HKD 852 Asia/Hong_Kong|HN HNL 504 America/Tegucigalpa|HR EUR 385 Europe/Zagreb|HT HTG 509 America/Port-au-Prince|HU HUF 36 Europe/Budapest|ID IDR 62 Asia/Jakarta|IE EUR 353 Europe/Dublin|IL ILS 972 Asia/Jerusalem|IN INR 91 Asia/Kolkata|IQ IQD 964 Asia/Baghdad|IR IRR 98 Asia/Tehran|IS ISK 354 Atlantic/Reykjavik|IT EUR 39 Europe/Rome|JM JMD 1876 America/Jamaica|JO JOD 962 Asia/Amman|JP JPY 81 Asia/Tokyo|KE KES 254 Africa/Nairobi|KG KGS 996 Asia/Bishkek|KH KHR 855 Asia/Phnom_Penh|KM KMF 269 Indian/Comoro|KW KWD 965 Asia/Kuwait|KZ KZT 7 Asia/Almaty|LA LAK 856 Asia/Vientiane|LB LBP 961 Asia/Beirut|LK LKR 94 Asia/Colombo|LR LRD 231 Africa/Monrovia|LS LSL 266 Africa/Maseru|LT EUR 370 Europe/Vilnius|LU EUR 352 Europe/Luxembourg|LV EUR 371 Europe/Riga|LY LYD 218 Africa/Tripoli|MA MAD 212 Africa/Casablanca|MD MDL 373 Europe/Chisinau|ME EUR 382 Europe/Podgorica|MG MGA 261 Indian/Antananarivo|MK MKD 389 Europe/Skopje|ML XOF 223 Africa/Bamako|MM MMK 95 Asia/Yangon|MN MNT 976 Asia/Ulaanbaatar|MR MRU 222 Africa/Nouakchott|MT EUR 356 Europe/Malta|MU MUR 230 Indian/Mauritius|MV MVR 960 Indian/Maldives|MW MWK 265 Africa/Blantyre|MX MXN 52 America/Mexico_City|MY MYR 60 Asia/Kuala_Lumpur|MZ MZN 258 Africa/Maputo|NA NAD 264 Africa/Windhoek|NE XOF 227 Africa/Niamey|NG NGN 234 Africa/Lagos|NI NIO 505 America/Managua|NL EUR 31 Europe/Amsterdam|NO NOK 47 Europe/Oslo|NP NPR 977 Asia/Kathmandu|NZ NZD 64 Pacific/Auckland|OM OMR 968 Asia/Muscat|PA PAB 507 America/Panama|PE PEN 51 America/Lima|PG PGK 675 Pacific/Port_Moresby|PH PHP 63 Asia/Manila|PK PKR 92 Asia/Karachi|PL PLN 48 Europe/Warsaw|PT EUR 351 Europe/Lisbon|PY PYG 595 America/Asuncion|QA QAR 974 Asia/Qatar|RO RON 40 Europe/Bucharest|RS RSD 381 Europe/Belgrade|RU RUB 7 Europe/Moscow|RW RWF 250 Africa/Kigali|SA SAR 966 Asia/Riyadh|SC SCR 248 Indian/Mahe|SD SDG 249 Africa/Khartoum|SE SEK 46 Europe/Stockholm|SG SGD 65 Asia/Singapore|SI EUR 386 Europe/Ljubljana|SK EUR 421 Europe/Bratislava|SL SLE 232 Africa/Freetown|SN XOF 221 Africa/Dakar|SO SOS 252 Africa/Mogadishu|SR SRD 597 America/Paramaribo|SS SSP 211 Africa/Juba|SV USD 503 America/El_Salvador|SY SYP 963 Asia/Damascus|SZ SZL 268 Africa/Mbabane|TD XAF 235 Africa/Ndjamena|TG XOF 228 Africa/Lome|TH THB 66 Asia/Bangkok|TJ TJS 992 Asia/Dushanbe|TM TMT 993 Asia/Ashgabat|TN TND 216 Africa/Tunis|TR TRY 90 Europe/Istanbul|TT TTD 1868 America/Port_of_Spain|TW TWD 886 Asia/Taipei|TZ TZS 255 Africa/Dar_es_Salaam|UA UAH 380 Europe/Kyiv|UG UGX 256 Africa/Kampala|US USD 1 America/New_York|UY UYU 598 America/Montevideo|UZ UZS 998 Asia/Tashkent|VE VES 58 America/Caracas|VN VND 84 Asia/Ho_Chi_Minh|YE YER 967 Asia/Aden|ZA ZAR 27 Africa/Johannesburg|ZM ZMW 260 Africa/Lusaka|ZW ZWG 263 Africa/Harare`;

const COMMA_DECIMAL = "AD AL AM AR AT AZ BA BE BG BO BR BY CL CM CO CR CY CZ DE DK EC EE ES FI FR GE GR HR HU ID IS IT KZ LT LU LV MA MD ME MK NL NO PL PT PY RO RS RU SE SI SK TN TR UA UY UZ VE VN".split(" ");
const SPACE_THOUSANDS = "AL AM BG BY CZ EE FI FR GE HU KZ LT LV MD NO PL RU SE SK UA UZ ZA".split(" ");
const MONTH_FIRST = ["US", "PH", "BZ", "FM"];
const YEAR_FIRST = ["CN", "JP", "KR", "TW", "HU", "LT", "MN", "SE", "CA", "IR", "LK"];
const TWELVE_HOUR = "AU BD CA CO EG IN JO KE MX MY NZ PH PK SA SG US".split(" ");
const WEEK_SUNDAY = "AU BR BZ CA CN CO DO ET GT HK HN ID IL IN JM JP KE KH LA MM MX MZ NP PA PE PH PK PT PY SA SG SV TH TT TW US VE ZA ZW".split(" ");
const WEEK_SATURDAY = "AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" ");
const IMPERIAL = ["US", "LR", "MM"];
/** Where the financial year doesn't start in January. */
const YEAR_START: Record<string, number> = { AU: 7, BD: 7, BW: 4, CA: 4, EG: 7, GB: 4, HK: 4, IN: 4, JP: 4, KE: 7, LS: 4, MW: 4, NA: 3, NG: 1, NP: 7, NZ: 4, PK: 7, SG: 4, SZ: 4, TZ: 7, UG: 7, US: 1, ZA: 3, ZM: 1 };

export interface CountryDefaults {
  code: string;
  name: string;
  currency: string;
  timezone: string;
  dateFormat: string;
  fiscalYearStartMonth: number;
  style: { timeFormat: "24h" | "12h"; decimalSeparator: string; thousandsSeparator: string; firstDayOfWeek: string; phoneCountryCode: string; unitSystem: "metric" | "imperial" };
}

const regionName = new Intl.DisplayNames(["en"], { type: "region" });

export const COUNTRIES: CountryDefaults[] = TABLE.split("|").map((row) => {
  const [code, currency, dial, timezone] = row.split(" ") as [string, string, string, string];
  const decimal = COMMA_DECIMAL.includes(code) ? "," : ".";
  return {
    code, currency, timezone,
    name: regionName.of(code) ?? code,
    dateFormat: MONTH_FIRST.includes(code) ? "MM/DD/YYYY" : YEAR_FIRST.includes(code) ? "YYYY-MM-DD" : "DD/MM/YYYY",
    fiscalYearStartMonth: YEAR_START[code] ?? 1,
    style: {
      timeFormat: (TWELVE_HOUR.includes(code) ? "12h" : "24h") as "12h" | "24h",
      decimalSeparator: decimal,
      thousandsSeparator: SPACE_THOUSANDS.includes(code) ? " " : decimal === "," ? "." : ",",
      firstDayOfWeek: WEEK_SUNDAY.includes(code) ? "sunday" : WEEK_SATURDAY.includes(code) ? "saturday" : "monday",
      phoneCountryCode: `+${dial}`,
      unitSystem: (IMPERIAL.includes(code) ? "imperial" : "metric") as "imperial" | "metric",
    },
  };
}).sort((a, b) => a.name.localeCompare(b.name));

export const countryOf = (code: unknown) => COUNTRIES.find((c) => c.code === code);

/** Every currency the browser knows, with its name: "ZMW · Zambian kwacha". */
const currencyName = new Intl.DisplayNames(["en"], { type: "currency" });
export const CURRENCIES: { code: string; name: string }[] = ((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency") ?? [...new Set(COUNTRIES.map((c) => c.currency))].sort())
  .map((code) => ({ code, name: currencyName.of(code) ?? code }));
