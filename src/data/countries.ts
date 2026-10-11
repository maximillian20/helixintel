export type Country = {
  code: string;
  name: string;
  aliases: string[];
  exact: string[];
};

export const GLOBAL_CODE = 'GLOBAL';
export const UNKNOWN_CODE = 'UNKNOWN';

// ISO 3166-1 alpha-2 style codes: 193 UN member states plus the Holy See, Palestine, Kosovo and Taiwan.
// Aliases are matched case-insensitively as whole words; `exact` aliases are matched case-sensitively.
const countryRows: Array<[string, string, string[], string[]]> = [
  ['AF', 'Afghanistan', ['Afghan', 'Afghans', 'Kabul', 'Taliban'], []],
  ['AL', 'Albania', ['Albanian', 'Tirana'], []],
  ['DZ', 'Algeria', ['Algerian', 'Algiers'], []],
  ['AD', 'Andorra', ['Andorran'], []],
  ['AO', 'Angola', ['Angolan', 'Luanda'], []],
  ['AG', 'Antigua and Barbuda', ['Antigua', 'Barbuda'], []],
  ['AR', 'Argentina', ['Argentine', 'Argentinian', 'Buenos Aires'], []],
  ['AM', 'Armenia', ['Armenian', 'Yerevan'], []],
  ['AU', 'Australia', ['Australian', 'Australians', 'Canberra', 'Sydney', 'Melbourne'], []],
  ['AT', 'Austria', ['Austrian'], []],
  ['AZ', 'Azerbaijan', ['Azerbaijani', 'Baku'], []],
  ['BS', 'Bahamas', ['Bahamian', 'The Bahamas'], []],
  ['BH', 'Bahrain', ['Bahraini', 'Manama'], []],
  ['BD', 'Bangladesh', ['Bangladeshi', 'Dhaka'], []],
  ['BB', 'Barbados', ['Barbadian'], []],
  ['BY', 'Belarus', ['Belarusian', 'Minsk'], []],
  ['BE', 'Belgium', ['Belgian'], []],
  ['BZ', 'Belize', ['Belizean'], []],
  ['BJ', 'Benin', ['Beninese'], []],
  ['BT', 'Bhutan', ['Bhutanese', 'Thimphu'], []],
  ['BO', 'Bolivia', ['Bolivian'], []],
  ['BA', 'Bosnia and Herzegovina', ['Bosnia', 'Bosnian', 'Herzegovina', 'Sarajevo'], []],
  ['BW', 'Botswana', ['Botswanan', 'Gaborone'], []],
  ['BR', 'Brazil', ['Brazilian', 'Brazilians', 'Brasilia', 'Brasília', 'Sao Paulo', 'Rio de Janeiro'], []],
  ['BN', 'Brunei', ['Bruneian'], []],
  ['BG', 'Bulgaria', ['Bulgarian'], []],
  ['BF', 'Burkina Faso', ['Burkinabe', 'Ouagadougou'], []],
  ['BI', 'Burundi', ['Burundian', 'Bujumbura'], []],
  ['CV', 'Cape Verde', ['Cabo Verde'], []],
  ['KH', 'Cambodia', ['Cambodian', 'Phnom Penh'], []],
  ['CM', 'Cameroon', ['Cameroonian', 'Yaounde'], []],
  ['CA', 'Canada', ['Canadian', 'Canadians', 'Ottawa', 'Toronto'], []],
  ['CF', 'Central African Republic', ['Bangui'], []],
  ['TD', 'Chad', ['Chadian', 'N\'Djamena'], ['Chad']],
  ['CL', 'Chile', ['Chilean'], []],
  ['CN', 'China', ['Chinese', 'Beijing', 'Shanghai', 'Xinjiang', 'Tibet'], []],
  ['CO', 'Colombia', ['Colombian', 'Bogota', 'Bogotá'], []],
  ['KM', 'Comoros', ['Comorian'], []],
  ['CG', 'Republic of the Congo', ['Republic of Congo', 'Congo-Brazzaville', 'Brazzaville'], []],
  ['CD', 'Democratic Republic of the Congo', ['DR Congo', 'Democratic Republic of Congo', 'Congolese', 'Kinshasa', 'Goma', 'Kivu'], ['DRC']],
  ['CR', 'Costa Rica', ['Costa Rican'], []],
  ['CI', 'Ivory Coast', ['Cote d\'Ivoire', 'Côte d\'Ivoire', 'Ivorian', 'Abidjan'], []],
  ['HR', 'Croatia', ['Croatian', 'Zagreb'], []],
  ['CU', 'Cuba', ['Cuban', 'Havana'], []],
  ['CY', 'Cyprus', ['Cypriot', 'Nicosia'], []],
  ['CZ', 'Czechia', ['Czech Republic', 'Czech', 'Prague'], []],
  ['DK', 'Denmark', ['Danish', 'Copenhagen'], []],
  ['DJ', 'Djibouti', ['Djiboutian'], []],
  ['DM', 'Dominica', [], []],
  ['DO', 'Dominican Republic', ['Santo Domingo'], []],
  ['EC', 'Ecuador', ['Ecuadorian', 'Quito'], []],
  ['EG', 'Egypt', ['Egyptian', 'Egyptians', 'Cairo'], []],
  ['SV', 'El Salvador', ['Salvadoran', 'San Salvador'], []],
  ['GQ', 'Equatorial Guinea', ['Malabo'], []],
  ['ER', 'Eritrea', ['Eritrean', 'Asmara'], []],
  ['EE', 'Estonia', ['Estonian', 'Tallinn'], []],
  ['SZ', 'Eswatini', ['Swaziland', 'Swazi'], []],
  ['ET', 'Ethiopia', ['Ethiopian', 'Addis Ababa', 'Tigray', 'Amhara'], []],
  ['FJ', 'Fiji', ['Fijian'], []],
  ['FI', 'Finland', ['Finnish', 'Helsinki'], []],
  ['FR', 'France', ['French'], []],
  ['GA', 'Gabon', ['Gabonese', 'Libreville'], []],
  ['GM', 'Gambia', ['Gambian', 'Banjul'], []],
  ['GE', 'Georgia', ['Tbilisi', 'Republic of Georgia'], []],
  ['DE', 'Germany', ['German', 'Germans', 'Berlin'], []],
  ['GH', 'Ghana', ['Ghanaian', 'Accra'], []],
  ['GR', 'Greece', ['Greek', 'Athens'], []],
  ['GD', 'Grenada', ['Grenadian'], []],
  ['GT', 'Guatemala', ['Guatemalan'], []],
  ['GN', 'Guinea', ['Guinean', 'Conakry'], []],
  ['GW', 'Guinea-Bissau', ['Bissau'], []],
  ['GY', 'Guyana', ['Guyanese'], []],
  ['HT', 'Haiti', ['Haitian', 'Port-au-Prince'], []],
  ['HN', 'Honduras', ['Honduran', 'Tegucigalpa'], []],
  ['HU', 'Hungary', ['Hungarian', 'Budapest'], []],
  ['IS', 'Iceland', ['Icelandic', 'Reykjavik'], []],
  ['IN', 'India', ['Indian', 'Indians', 'New Delhi', 'Delhi', 'Mumbai', 'Kashmir'], []],
  ['ID', 'Indonesia', ['Indonesian', 'Jakarta'], []],
  ['IR', 'Iran', ['Iranian', 'Iranians', 'Tehran'], []],
  ['IQ', 'Iraq', ['Iraqi', 'Iraqis', 'Baghdad'], []],
  ['IE', 'Ireland', ['Irish', 'Dublin'], []],
  ['IL', 'Israel', ['Israeli', 'Israelis', 'Tel Aviv', 'Jerusalem'], ['IDF']],
  ['IT', 'Italy', ['Italian', 'Italians'], []],
  ['JM', 'Jamaica', ['Jamaican'], []],
  ['JP', 'Japan', ['Japanese', 'Tokyo'], []],
  ['JO', 'Jordan', ['Jordanian', 'Amman'], []],
  ['KZ', 'Kazakhstan', ['Kazakh', 'Astana'], []],
  ['KE', 'Kenya', ['Kenyan', 'Nairobi'], []],
  ['KI', 'Kiribati', [], []],
  ['KP', 'North Korea', ['North Korean', 'Pyongyang'], []],
  ['KR', 'South Korea', ['South Korean', 'Seoul'], []],
  ['XK', 'Kosovo', ['Kosovan', 'Pristina'], []],
  ['KW', 'Kuwait', ['Kuwaiti'], []],
  ['KG', 'Kyrgyzstan', ['Kyrgyz', 'Bishkek'], []],
  ['LA', 'Laos', ['Laotian', 'Vientiane'], []],
  ['LV', 'Latvia', ['Latvian', 'Riga'], []],
  ['LB', 'Lebanon', ['Lebanese', 'Beirut', 'Hezbollah'], []],
  ['LS', 'Lesotho', ['Basotho', 'Maseru'], []],
  ['LR', 'Liberia', ['Liberian', 'Monrovia'], []],
  ['LY', 'Libya', ['Libyan', 'Benghazi'], []],
  ['LI', 'Liechtenstein', [], []],
  ['LT', 'Lithuania', ['Lithuanian', 'Vilnius'], []],
  ['LU', 'Luxembourg', [], []],
  ['MG', 'Madagascar', ['Malagasy', 'Antananarivo'], []],
  ['MW', 'Malawi', ['Malawian', 'Lilongwe'], []],
  ['MY', 'Malaysia', ['Malaysian', 'Kuala Lumpur'], []],
  ['MV', 'Maldives', ['Maldivian'], []],
  ['ML', 'Mali', ['Malian', 'Bamako'], []],
  ['MT', 'Malta', ['Maltese', 'Valletta'], []],
  ['MH', 'Marshall Islands', [], []],
  ['MR', 'Mauritania', ['Mauritanian', 'Nouakchott'], []],
  ['MU', 'Mauritius', ['Mauritian'], []],
  ['MX', 'Mexico', ['Mexican', 'Mexicans'], []],
  ['FM', 'Micronesia', [], []],
  ['MD', 'Moldova', ['Moldovan', 'Chisinau'], []],
  ['MC', 'Monaco', [], []],
  ['MN', 'Mongolia', ['Mongolian', 'Ulaanbaatar'], []],
  ['ME', 'Montenegro', ['Montenegrin', 'Podgorica'], []],
  ['MA', 'Morocco', ['Moroccan', 'Rabat'], []],
  ['MZ', 'Mozambique', ['Mozambican', 'Cabo Delgado', 'Maputo'], []],
  ['MM', 'Myanmar', ['Burma', 'Burmese', 'Rohingya', 'Naypyidaw'], []],
  ['NA', 'Namibia', ['Namibian', 'Windhoek'], []],
  ['NR', 'Nauru', [], []],
  ['NP', 'Nepal', ['Nepalese', 'Kathmandu'], []],
  ['NL', 'Netherlands', ['Dutch', 'Holland', 'Amsterdam', 'The Hague', 'Rotterdam'], []],
  ['NZ', 'New Zealand', ['New Zealander'], []],
  ['NI', 'Nicaragua', ['Nicaraguan', 'Managua'], []],
  ['NE', 'Niger', ['Nigerien', 'Niamey'], []],
  ['NG', 'Nigeria', ['Nigerian', 'Nigerians', 'Abuja', 'Lagos'], []],
  ['MK', 'North Macedonia', ['Macedonia', 'Macedonian', 'Skopje'], []],
  ['NO', 'Norway', ['Norwegian', 'Oslo'], []],
  ['OM', 'Oman', ['Omani', 'Muscat'], []],
  ['PK', 'Pakistan', ['Pakistani', 'Pakistanis', 'Islamabad', 'Karachi'], []],
  ['PW', 'Palau', [], []],
  ['PS', 'Palestine', ['Palestinian', 'Palestinians', 'Palestinian territories', 'Gaza', 'Gazan', 'Rafah', 'Khan Younis', 'West Bank', 'Ramallah', 'Jenin', 'Hebron', 'Nablus', 'Hamas'], []],
  ['PA', 'Panama', ['Panamanian'], []],
  ['PG', 'Papua New Guinea', ['Port Moresby'], []],
  ['PY', 'Paraguay', ['Paraguayan', 'Asuncion'], []],
  ['PE', 'Peru', ['Peruvian'], []],
  ['PH', 'Philippines', ['Philippine', 'Filipino', 'Filipinos', 'Manila'], []],
  ['PL', 'Poland', ['Polish', 'Warsaw'], []],
  ['PT', 'Portugal', ['Portuguese', 'Lisbon'], []],
  ['QA', 'Qatar', ['Qatari', 'Doha'], []],
  ['RO', 'Romania', ['Romanian', 'Bucharest'], []],
  ['RU', 'Russia', ['Russian', 'Russians', 'Moscow', 'Kremlin'], []],
  ['RW', 'Rwanda', ['Rwandan', 'Kigali'], []],
  ['KN', 'Saint Kitts and Nevis', [], []],
  ['LC', 'Saint Lucia', [], []],
  ['VC', 'Saint Vincent and the Grenadines', [], []],
  ['WS', 'Samoa', ['Samoan'], []],
  ['SM', 'San Marino', [], []],
  ['ST', 'Sao Tome and Principe', [], []],
  ['SA', 'Saudi Arabia', ['Saudi', 'Riyadh', 'Jeddah'], []],
  ['SN', 'Senegal', ['Senegalese', 'Dakar'], []],
  ['RS', 'Serbia', ['Serbian', 'Belgrade'], []],
  ['SC', 'Seychelles', [], []],
  ['SL', 'Sierra Leone', ['Freetown'], []],
  ['SG', 'Singapore', ['Singaporean'], []],
  ['SK', 'Slovakia', ['Slovak', 'Bratislava'], []],
  ['SI', 'Slovenia', ['Slovenian', 'Ljubljana'], []],
  ['SB', 'Solomon Islands', [], []],
  ['SO', 'Somalia', ['Somali', 'Mogadishu', 'Al-Shabab'], []],
  ['ZA', 'South Africa', ['South African', 'Pretoria', 'Johannesburg', 'Cape Town'], []],
  ['SS', 'South Sudan', ['South Sudanese', 'Juba'], []],
  ['ES', 'Spain', ['Spanish', 'Madrid', 'Catalonia'], []],
  ['LK', 'Sri Lanka', ['Sri Lankan', 'Colombo'], []],
  ['SD', 'Sudan', ['Sudanese', 'Khartoum', 'Darfur', 'El Fasher'], []],
  ['SR', 'Suriname', ['Surinamese'], []],
  ['SE', 'Sweden', ['Swedish', 'Stockholm'], []],
  ['CH', 'Switzerland', ['Swiss'], []],
  ['SY', 'Syria', ['Syrian', 'Syrians', 'Damascus', 'Aleppo'], []],
  ['TW', 'Taiwan', ['Taiwanese', 'Taipei'], []],
  ['TJ', 'Tajikistan', ['Tajik', 'Dushanbe'], []],
  ['TZ', 'Tanzania', ['Tanzanian', 'Dodoma', 'Zanzibar'], []],
  ['TH', 'Thailand', ['Thai', 'Bangkok'], []],
  ['TL', 'Timor-Leste', ['East Timor', 'Dili'], []],
  ['TG', 'Togo', ['Togolese', 'Lome'], []],
  ['TO', 'Tonga', ['Tongan'], []],
  ['TT', 'Trinidad and Tobago', ['Trinidad'], []],
  ['TN', 'Tunisia', ['Tunisian', 'Tunis'], []],
  ['TR', 'Turkey', ['Turkish', 'Türkiye', 'Turkiye', 'Ankara', 'Istanbul'], []],
  ['TM', 'Turkmenistan', ['Turkmen'], []],
  ['TV', 'Tuvalu', [], []],
  ['UG', 'Uganda', ['Ugandan', 'Kampala'], []],
  ['UA', 'Ukraine', ['Ukrainian', 'Ukrainians', 'Kyiv', 'Kiev', 'Kharkiv', 'Odesa', 'Zaporizhzhia', 'Donetsk', 'Luhansk', 'Crimea'], []],
  ['AE', 'United Arab Emirates', ['Emirati', 'Abu Dhabi', 'Dubai'], ['UAE']],
  ['GB', 'United Kingdom', ['Britain', 'British', 'England', 'Scotland', 'Wales', 'Northern Ireland', 'London', 'Downing Street'], ['UK']],
  ['US', 'United States', ['Washington DC', 'White House', 'Pentagon', 'Capitol Hill'], ['US', 'U.S.', 'USA']],
  ['UY', 'Uruguay', ['Uruguayan', 'Montevideo'], []],
  ['UZ', 'Uzbekistan', ['Uzbek', 'Tashkent'], []],
  ['VU', 'Vanuatu', [], []],
  ['VA', 'Vatican City', ['Vatican', 'Holy See'], []],
  ['VE', 'Venezuela', ['Venezuelan', 'Caracas'], []],
  ['VN', 'Vietnam', ['Vietnamese', 'Hanoi'], []],
  ['YE', 'Yemen', ['Yemeni', 'Houthi', 'Houthis', 'Sanaa', 'Aden'], []],
  ['ZM', 'Zambia', ['Zambian', 'Lusaka'], []],
  ['ZW', 'Zimbabwe', ['Zimbabwean', 'Harare'], []],
];

export const countries: Country[] = countryRows.map(([code, name, aliases, exact]) => ({ code, name, aliases, exact }));

/** Alphabetically sorted by display name, without duplicates. */
export const sortedCountries: Country[] = [...countries].sort((a, b) => a.name.localeCompare(b.name, 'en'));

const countryByCodeMap = new Map(countries.map((country) => [country.code, country]));

export function countryName(code: string): string {
  if (code === GLOBAL_CODE) return 'Global';
  if (code === UNKNOWN_CODE) return 'Unknown';
  return countryByCodeMap.get(code)?.name ?? code;
}

export function isKnownCountryCode(code: string) {
  return code === GLOBAL_CODE || code === UNKNOWN_CODE || countryByCodeMap.has(code);
}

/** Phrases that contain a country name but do not refer to that country. They are removed before matching. */
const ignoredPhrases = ['Indian Ocean', 'New Mexico', 'New England', 'Guinea pig', 'Guinea pigs'];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRegex(phrase: string, caseSensitive: boolean, global: boolean) {
  const source = `(?<![A-Za-z])${escapeRegExp(phrase)}(?![A-Za-z])`;
  return new RegExp(source, `${caseSensitive ? '' : 'i'}${global ? 'g' : ''}`);
}

type Matcher = { code: string | null; phrase: string; test: RegExp; replace: RegExp };

const matchers: Matcher[] = [
  ...ignoredPhrases.map((phrase) => ({ code: null, phrase, caseSensitive: false })),
  ...countries.flatMap((country) => [
    ...[country.name, ...country.aliases].map((phrase) => ({ code: country.code, phrase, caseSensitive: false })),
    ...country.exact.map((phrase) => ({ code: country.code, phrase, caseSensitive: true })),
  ]),
]
  // Longest phrases first, so "South Sudan" is consumed before "Sudan" and "Papua New Guinea" before "Guinea".
  .sort((a, b) => b.phrase.length - a.phrase.length)
  .map(({ code, phrase, caseSensitive }) => ({
    code,
    phrase,
    test: phraseRegex(phrase, caseSensitive, false),
    replace: phraseRegex(phrase, caseSensitive, true),
  }));

/** Country codes named in the text, in order of first appearance. */
export function findCountryCodes(text: string): string[] {
  let remaining = text;
  const found: Array<{ code: string; index: number }> = [];
  for (const matcher of matchers) {
    const match = matcher.test.exec(remaining);
    if (!match) continue;
    if (matcher.code && !found.some((entry) => entry.code === matcher.code)) {
      found.push({ code: matcher.code, index: match.index });
    }
    remaining = remaining.replace(matcher.replace, (hit) => ' '.repeat(hit.length));
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.code);
}

const globalScopePattern = /\b(worldwide|around the world|across the world|all over the world|globally|global (?:crisis|pandemic|outbreak|hunger|famine|conflict|security|threat|health|climate)|pandemic|climate (?:change|crisis)|world leaders|international community)\b/i;

export function hasGlobalScope(text: string) {
  return globalScopePattern.test(text);
}
