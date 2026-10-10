export type Place = {
  name: string;
  lat: number;
  lng: number;
  aliases: string[];
  exact?: string[];
};

export const places: Place[] = [
  { name: 'Ukraine', lat: 49, lng: 32, aliases: ['Ukraine', 'Ukrainian', 'Ukrainians', 'Kyiv', 'Kharkiv', 'Odesa', 'Zaporizhzhia', 'Donetsk', 'Crimea'] },
  { name: 'Russia', lat: 56, lng: 38, aliases: ['Russia', 'Russian', 'Russians', 'Moscow', 'Kremlin'] },
  { name: 'Belarus', lat: 53.7, lng: 28, aliases: ['Belarus', 'Belarusian', 'Minsk'] },
  { name: 'Moldova', lat: 47, lng: 28.5, aliases: ['Moldova', 'Moldovan'] },
  { name: 'Poland', lat: 52, lng: 19.5, aliases: ['Poland', 'Polish', 'Warsaw'] },
  { name: 'Israel', lat: 31.5, lng: 34.8, aliases: ['Israel', 'Israeli', 'Israelis', 'Tel Aviv', 'Jerusalem'] },
  { name: 'Gaza', lat: 31.4, lng: 34.4, aliases: ['Gaza', 'Gazan', 'Rafah', 'Khan Younis'] },
  { name: 'West Bank', lat: 32, lng: 35.3, aliases: ['West Bank', 'Ramallah', 'Jenin', 'Hebron', 'Nablus'] },
  { name: 'Lebanon', lat: 33.9, lng: 35.9, aliases: ['Lebanon', 'Lebanese', 'Beirut', 'Hezbollah'] },
  { name: 'Syria', lat: 35, lng: 38, aliases: ['Syria', 'Syrian', 'Syrians', 'Damascus', 'Aleppo'] },
  { name: 'Iraq', lat: 33, lng: 44, aliases: ['Iraq', 'Iraqi', 'Baghdad'] },
  { name: 'Iran', lat: 32, lng: 53, aliases: ['Iran', 'Iranian', 'Iranians', 'Tehran'] },
  { name: 'Yemen', lat: 15.5, lng: 48, aliases: ['Yemen', 'Yemeni', 'Houthi', 'Houthis', 'Sanaa'] },
  { name: 'Saudi Arabia', lat: 24, lng: 45, aliases: ['Saudi Arabia', 'Saudi', 'Riyadh'] },
  { name: 'Jordan', lat: 31, lng: 36.5, aliases: ['Jordan', 'Jordanian', 'Amman'] },
  { name: 'Turkey', lat: 39, lng: 35, aliases: ['Turkey', 'Turkish', 'Ankara', 'Istanbul', 'Türkiye'] },
  { name: 'Egypt', lat: 26.8, lng: 30.8, aliases: ['Egypt', 'Egyptian', 'Cairo'] },
  { name: 'Libya', lat: 27, lng: 17, aliases: ['Libya', 'Libyan', 'Tripoli'] },
  { name: 'Tunisia', lat: 34, lng: 9, aliases: ['Tunisia', 'Tunisian'] },
  { name: 'Algeria', lat: 28, lng: 2.6, aliases: ['Algeria', 'Algerian', 'Algiers'] },
  { name: 'Morocco', lat: 32, lng: -6, aliases: ['Morocco', 'Moroccan', 'Rabat'] },
  { name: 'South Sudan', lat: 7, lng: 30, aliases: ['South Sudan', 'South Sudanese', 'Juba'] },
  { name: 'Sudan', lat: 15.6, lng: 32.5, aliases: ['Sudan', 'Sudanese', 'Khartoum', 'Darfur', 'El Fasher'] },
  { name: 'Ethiopia', lat: 9, lng: 40, aliases: ['Ethiopia', 'Ethiopian', 'Addis Ababa', 'Tigray'] },
  { name: 'Eritrea', lat: 15.3, lng: 39.5, aliases: ['Eritrea', 'Eritrean'] },
  { name: 'Somalia', lat: 5, lng: 46, aliases: ['Somalia', 'Somali', 'Mogadishu'] },
  { name: 'Kenya', lat: 0, lng: 38, aliases: ['Kenya', 'Kenyan', 'Nairobi'] },
  { name: 'Uganda', lat: 1.4, lng: 32.3, aliases: ['Uganda', 'Ugandan', 'Kampala'] },
  { name: 'Rwanda', lat: -2, lng: 29.9, aliases: ['Rwanda', 'Rwandan', 'Kigali'] },
  { name: 'Burundi', lat: -3.4, lng: 29.9, aliases: ['Burundi', 'Burundian'] },
  { name: 'DR Congo', lat: -2.9, lng: 23.6, aliases: ['DR Congo', 'Democratic Republic of Congo', 'Democratic Republic of the Congo', 'Congolese', 'Kinshasa', 'Goma'], exact: ['DRC'] },
  { name: 'Central African Republic', lat: 6.6, lng: 20.9, aliases: ['Central African Republic', 'Bangui'] },
  { name: 'Chad', lat: 15, lng: 19, aliases: ['Chadian', "N'Djamena"], exact: ['Chad'] },
  { name: 'Niger', lat: 17, lng: 8, aliases: ['Niger', 'Nigerien', 'Niamey'] },
  { name: 'Nigeria', lat: 9, lng: 8, aliases: ['Nigeria', 'Nigerian', 'Nigerians', 'Abuja', 'Lagos'] },
  { name: 'Mali', lat: 17.5, lng: -4, aliases: ['Mali', 'Malian', 'Bamako'] },
  { name: 'Burkina Faso', lat: 12.3, lng: -1.5, aliases: ['Burkina Faso', 'Ouagadougou'] },
  { name: 'Cameroon', lat: 6, lng: 12.5, aliases: ['Cameroon', 'Cameroonian'] },
  { name: 'Ghana', lat: 7.9, lng: -1, aliases: ['Ghana', 'Ghanaian', 'Accra'] },
  { name: 'Senegal', lat: 14.5, lng: -14.5, aliases: ['Senegal', 'Senegalese', 'Dakar'] },
  { name: 'Angola', lat: -12.3, lng: 17.5, aliases: ['Angola', 'Angolan'] },
  { name: 'Mozambique', lat: -18.7, lng: 35, aliases: ['Mozambique', 'Mozambican', 'Cabo Delgado'] },
  { name: 'Zimbabwe', lat: -19, lng: 29, aliases: ['Zimbabwe', 'Zimbabwean', 'Harare'] },
  { name: 'Zambia', lat: -13.1, lng: 27.8, aliases: ['Zambia', 'Zambian'] },
  { name: 'Tanzania', lat: -6.4, lng: 34.9, aliases: ['Tanzania', 'Tanzanian'] },
  { name: 'Madagascar', lat: -19, lng: 47, aliases: ['Madagascar'] },
  { name: 'South Africa', lat: -29, lng: 24, aliases: ['South Africa', 'South African', 'Pretoria', 'Johannesburg'] },
  { name: 'Afghanistan', lat: 33.9, lng: 67.7, aliases: ['Afghanistan', 'Afghan', 'Afghans', 'Kabul', 'Taliban'] },
  { name: 'Pakistan', lat: 30, lng: 70, aliases: ['Pakistan', 'Pakistani', 'Islamabad'] },
  { name: 'India', lat: 22, lng: 79, aliases: ['India', 'Indian', 'Indians', 'New Delhi'] },
  { name: 'Bangladesh', lat: 23.7, lng: 90.4, aliases: ['Bangladesh', 'Bangladeshi', 'Dhaka'] },
  { name: 'Myanmar', lat: 21, lng: 96, aliases: ['Myanmar', 'Burma', 'Burmese', 'Rohingya'] },
  { name: 'Sri Lanka', lat: 7.9, lng: 80.7, aliases: ['Sri Lanka', 'Sri Lankan'] },
  { name: 'Nepal', lat: 28.4, lng: 84, aliases: ['Nepal', 'Nepalese', 'Kathmandu'] },
  { name: 'China', lat: 35, lng: 103, aliases: ['China', 'Chinese', 'Beijing'] },
  { name: 'Taiwan', lat: 23.7, lng: 121, aliases: ['Taiwan', 'Taiwanese', 'Taipei'] },
  { name: 'North Korea', lat: 40, lng: 127, aliases: ['North Korea', 'North Korean', 'Pyongyang'] },
  { name: 'South Korea', lat: 36.5, lng: 127.8, aliases: ['South Korea', 'South Korean', 'Seoul'] },
  { name: 'Japan', lat: 36, lng: 138, aliases: ['Japan', 'Japanese', 'Tokyo'] },
  { name: 'Philippines', lat: 12.9, lng: 122, aliases: ['Philippines', 'Philippine', 'Filipino', 'Manila'] },
  { name: 'Indonesia', lat: -2.5, lng: 118, aliases: ['Indonesia', 'Indonesian', 'Jakarta'] },
  { name: 'Thailand', lat: 15, lng: 101, aliases: ['Thailand', 'Thai', 'Bangkok'] },
  { name: 'Vietnam', lat: 16, lng: 106, aliases: ['Vietnam', 'Vietnamese', 'Hanoi'] },
  { name: 'Kazakhstan', lat: 48, lng: 68, aliases: ['Kazakhstan', 'Kazakh'] },
  { name: 'Armenia', lat: 40.2, lng: 45, aliases: ['Armenia', 'Armenian', 'Yerevan'] },
  { name: 'Azerbaijan', lat: 40.4, lng: 47.7, aliases: ['Azerbaijan', 'Azerbaijani', 'Baku'] },
  { name: 'Serbia', lat: 44, lng: 21, aliases: ['Serbia', 'Serbian', 'Belgrade'] },
  { name: 'Kosovo', lat: 42.6, lng: 20.9, aliases: ['Kosovo', 'Pristina'] },
  { name: 'Qatar', lat: 25.3, lng: 51.2, aliases: ['Qatar', 'Qatari', 'Doha'] },
  { name: 'United Arab Emirates', lat: 24, lng: 54, aliases: ['United Arab Emirates', 'Emirati', 'Abu Dhabi', 'Dubai'], exact: ['UAE'] },
  { name: 'Kuwait', lat: 29.3, lng: 47.5, aliases: ['Kuwait', 'Kuwaiti'] },
  { name: 'Oman', lat: 21, lng: 57, aliases: ['Oman', 'Omani'] },
  { name: 'Haiti', lat: 19, lng: -72.3, aliases: ['Haiti', 'Haitian', 'Port-au-Prince'] },
  { name: 'Cuba', lat: 21.5, lng: -79.5, aliases: ['Cuba', 'Cuban', 'Havana'] },
  { name: 'Venezuela', lat: 7, lng: -66, aliases: ['Venezuela', 'Venezuelan', 'Caracas'] },
  { name: 'Colombia', lat: 4.6, lng: -74, aliases: ['Colombia', 'Colombian', 'Bogota', 'Bogotá'] },
  { name: 'Ecuador', lat: -1.8, lng: -78, aliases: ['Ecuador', 'Ecuadorian', 'Quito'] },
  { name: 'Peru', lat: -9.2, lng: -75, aliases: ['Peru', 'Peruvian', 'Lima'] },
  { name: 'Brazil', lat: -10, lng: -52, aliases: ['Brazil', 'Brazilian', 'Brasilia', 'Brasília'] },
  { name: 'Argentina', lat: -34, lng: -64, aliases: ['Argentina', 'Argentine', 'Argentinian', 'Buenos Aires'] },
  { name: 'Chile', lat: -35.7, lng: -71.5, aliases: ['Chile', 'Chilean', 'Santiago'] },
  { name: 'Mexico', lat: 23, lng: -102, aliases: ['Mexico', 'Mexican', 'Mexicans'] },
  { name: 'Guatemala', lat: 15.5, lng: -90.3, aliases: ['Guatemala', 'Guatemalan'] },
  { name: 'Honduras', lat: 15, lng: -86.5, aliases: ['Honduras', 'Honduran'] },
  { name: 'Nicaragua', lat: 12.9, lng: -85, aliases: ['Nicaragua', 'Nicaraguan'] },
  { name: 'United States', lat: 39, lng: -98, aliases: ['United States', 'Washington DC', 'White House', 'Pentagon'], exact: ['US', 'U.S.', 'USA'] },
  { name: 'Canada', lat: 56, lng: -106, aliases: ['Canada', 'Canadian', 'Ottawa'] },
  { name: 'United Kingdom', lat: 54, lng: -2, aliases: ['United Kingdom', 'Britain', 'British', 'England', 'Scotland', 'Wales', 'London', 'Downing Street'], exact: ['UK'] },
  { name: 'France', lat: 46.6, lng: 2.5, aliases: ['France', 'French', 'Paris'] },
  { name: 'Germany', lat: 51, lng: 10, aliases: ['Germany', 'German', 'Germans', 'Berlin'] },
  { name: 'Spain', lat: 40, lng: -3.7, aliases: ['Spain', 'Spanish', 'Madrid'] },
  { name: 'Italy', lat: 42.8, lng: 12.8, aliases: ['Italy', 'Italian', 'Rome'] },
  { name: 'Greece', lat: 39, lng: 22, aliases: ['Greece', 'Greek', 'Athens'] },
  { name: 'Hungary', lat: 47, lng: 19.5, aliases: ['Hungary', 'Hungarian', 'Budapest'] },
  { name: 'Romania', lat: 45.9, lng: 25, aliases: ['Romania', 'Romanian', 'Bucharest'] },
  { name: 'Australia', lat: -25, lng: 134, aliases: ['Australia', 'Australian', 'Australians', 'Canberra'] },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type Matcher = { place: Place; test: RegExp; replace: RegExp };

const matchers: Matcher[] = places
  .flatMap((place) => [
    ...place.aliases.map((alias) => ({ place, alias, caseSensitive: false })),
    ...(place.exact ?? []).map((alias) => ({ place, alias, caseSensitive: true })),
  ])
  .sort((a, b) => b.alias.length - a.alias.length)
  .map(({ place, alias, caseSensitive }) => {
    const source = `(?<![A-Za-z])${escapeRegExp(alias)}(?![A-Za-z])`;
    const flags = caseSensitive ? '' : 'i';
    return { place, test: new RegExp(source, flags), replace: new RegExp(source, `${flags}g`) };
  });

/** Returns each known place named in the text (once per place). Longer names are consumed first, so "South Sudan" does not also count as "Sudan". */
export function findPlaces(text: string): Place[] {
  let remaining = text;
  const found = new Set<Place>();
  for (const matcher of matchers) {
    if (matcher.test.test(remaining)) {
      found.add(matcher.place);
      remaining = remaining.replace(matcher.replace, ' ');
    }
  }
  return [...found];
}
