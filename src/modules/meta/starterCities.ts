/**
 * The main towns a transport company in these countries drives between, for the usual lists (#102): capitals,
 * ports, mining and industrial towns and the busy border towns, each with its region and rough position.
 * A country not here gets its cities as places are found by address (placeSearch.ts adds the city then).
 * Positions are town centres, good enough to start a map; a place's own pin is what trips use.
 */
type Town = [name: string, region: string, lat: number, lng: number];

export const STARTER_CITIES: Record<string, Town[]> = {
  KE: [
    ['Nairobi', 'Nairobi County', -1.2864, 36.8172], ['Mombasa', 'Mombasa County', -4.0435, 39.6682], ['Kisumu', 'Kisumu County', -0.0917, 34.768],
    ['Nakuru', 'Nakuru County', -0.3031, 36.08], ['Naivasha', 'Nakuru County', -0.7167, 36.4333], ['Eldoret', 'Uasin Gishu County', 0.5143, 35.2698],
    ['Thika', 'Kiambu County', -1.0332, 37.0693], ['Malaba', 'Busia County', 0.6346, 34.2797], ['Busia', 'Busia County', 0.4608, 34.1115],
    ['Namanga', 'Kajiado County', -2.545, 36.79],
  ],
  TZ: [
    ['Dar es Salaam', 'Dar es Salaam Region', -6.7924, 39.2083], ['Dodoma', 'Dodoma Region', -6.163, 35.7516], ['Arusha', 'Arusha Region', -3.3869, 36.683],
    ['Mwanza', 'Mwanza Region', -2.5164, 32.9175], ['Morogoro', 'Morogoro Region', -6.821, 37.6612], ['Mbeya', 'Mbeya Region', -8.9094, 33.4608],
    ['Tanga', 'Tanga Region', -5.0689, 39.0988], ['Tunduma', 'Songwe Region', -9.3, 32.7667], ['Isaka', 'Shinyanga Region', -3.9, 32.9333],
  ],
  UG: [
    ['Kampala', 'Central Region', 0.3476, 32.5825], ['Jinja', 'Eastern Region', 0.4244, 33.2042], ['Tororo', 'Eastern Region', 0.6928, 34.1809],
    ['Busia', 'Eastern Region', 0.4669, 34.09], ['Mbarara', 'Western Region', -0.6072, 30.6545], ['Gulu', 'Northern Region', 2.7724, 32.2881],
  ],
  RW: [
    ['Kigali', 'Kigali City', -1.9441, 30.0619], ['Huye', 'Southern Province', -2.5967, 29.7394], ['Rusizi', 'Western Province', -2.4846, 28.9075],
    ['Musanze', 'Northern Province', -1.4998, 29.635],
  ],
  ZM: [
    ['Lusaka', 'Lusaka Province', -15.4167, 28.2833], ['Ndola', 'Copperbelt Province', -12.9587, 28.6366], ['Kitwe', 'Copperbelt Province', -12.8024, 28.2132],
    ['Chililabombwe', 'Copperbelt Province', -12.3667, 27.8333], ['Kapiri Mposhi', 'Central Province', -13.9706, 28.6693], ['Livingstone', 'Southern Province', -17.8419, 25.8544],
    ['Solwezi', 'North-Western Province', -12.1833, 26.4], ['Nakonde', 'Muchinga Province', -9.3443, 32.7529],
  ],
  ZW: [
    ['Harare', 'Harare Province', -17.8292, 31.0522], ['Bulawayo', 'Bulawayo Province', -20.15, 28.5833], ['Mutare', 'Manicaland Province', -18.9707, 32.6709],
    ['Gweru', 'Midlands Province', -19.45, 29.8167], ['Beitbridge', 'Matabeleland South Province', -22.2167, 30.0], ['Chirundu', 'Mashonaland West Province', -16.0333, 28.85],
  ],
  MW: [
    ['Lilongwe', 'Central Region', -13.9626, 33.7741], ['Blantyre', 'Southern Region', -15.7861, 35.0058], ['Mzuzu', 'Northern Region', -11.4656, 34.0207],
    ['Mwanza', 'Southern Region', -15.6, 34.5167],
  ],
  MZ: [
    ['Maputo', 'Maputo City', -25.9692, 32.5732], ['Beira', 'Sofala Province', -19.8436, 34.8389], ['Nacala', 'Nampula Province', -14.5626, 40.6854],
    ['Nampula', 'Nampula Province', -15.1165, 39.2666], ['Tete', 'Tete Province', -16.1564, 33.5867], ['Ressano Garcia', 'Maputo Province', -25.4419, 31.9947],
  ],
  ZA: [
    ['Johannesburg', 'Gauteng', -26.2041, 28.0473], ['Pretoria', 'Gauteng', -25.7479, 28.2293], ['Durban', 'KwaZulu-Natal', -29.8587, 31.0218],
    ['Richards Bay', 'KwaZulu-Natal', -28.7807, 32.0383], ['Cape Town', 'Western Cape', -33.9249, 18.4241], ['Gqeberha', 'Eastern Cape', -33.9608, 25.6022],
    ['Bloemfontein', 'Free State', -29.0852, 26.1596], ['Musina', 'Limpopo', -22.35, 30.0333],
  ],
  BW: [
    ['Gaborone', 'South-East District', -24.6282, 25.9231], ['Francistown', 'North-East District', -21.17, 27.5078], ['Palapye', 'Central District', -22.55, 27.1333],
    ['Kazungula', 'Chobe District', -17.7833, 25.2667],
  ],
  NA: [
    ['Windhoek', 'Khomas Region', -22.5609, 17.0658], ['Walvis Bay', 'Erongo Region', -22.9576, 14.5053], ['Oshakati', 'Oshana Region', -17.7883, 15.7044],
    ['Katima Mulilo', 'Zambezi Region', -17.5, 24.2667],
  ],
  CD: [
    ['Kinshasa', 'Kinshasa', -4.4419, 15.2663], ['Matadi', 'Kongo Central', -5.8167, 13.45], ['Lubumbashi', 'Haut-Katanga', -11.6609, 27.4794],
    ['Likasi', 'Haut-Katanga', -10.9833, 26.7333], ['Kasumbalesa', 'Haut-Katanga', -12.2656, 27.7981], ['Kolwezi', 'Lualaba', -10.7148, 25.4667],
    ['Goma', 'North Kivu', -1.6792, 29.2228],
  ],
  ET: [
    ['Addis Ababa', 'Addis Ababa', 9.03, 38.74], ['Adama', 'Oromia', 8.54, 39.27], ['Dire Dawa', 'Dire Dawa', 9.6, 41.85],
    ['Bahir Dar', 'Amhara', 11.5936, 37.3908], ['Mekelle', 'Tigray', 13.4967, 39.4753], ['Galafi', 'Afar', 11.7167, 41.8333],
  ],
  NG: [
    ['Lagos', 'Lagos', 6.5244, 3.3792], ['Abuja', 'Federal Capital Territory', 9.0765, 7.3986], ['Kano', 'Kano', 12.0022, 8.592],
    ['Port Harcourt', 'Rivers', 4.8156, 7.0498], ['Ibadan', 'Oyo', 7.3775, 3.947], ['Onitsha', 'Anambra', 6.145, 6.785], ['Kaduna', 'Kaduna', 10.5222, 7.4383],
  ],
  GH: [
    ['Accra', 'Greater Accra', 5.6037, -0.187], ['Tema', 'Greater Accra', 5.6698, -0.0166], ['Kumasi', 'Ashanti', 6.6885, -1.6244],
    ['Takoradi', 'Western', 4.8845, -1.7554], ['Tamale', 'Northern', 9.4008, -0.8393],
  ],
};

/** "Nairobi County" → "NAIROBI-COUNTY": a code from a name, as the masters' codes allow. */
export const codeOf = (name: string) => name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toUpperCase().replace(/[\s_]+/g, '-');
