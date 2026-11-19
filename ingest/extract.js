// Turns a headline/post into a crime type and candidate place names, using English and Malay keywords.
const TYPES = [
  ['murder', /\b(murder(ed)?|killed|stabbed to death|shot dead|bunuh|dibunuh|pembunuhan|maut ditikam|ditikam (sehingga )?maut|mati ditikam|ditembak mati|maut ditembak)\b/i],
  ['shooting', /\b(shot dead|shooting|gunman|gunmen|tembak|ditembak|tembakan)\b/i],
  ['kidnap', /\b(kidnap(ped|ping)?|abduct(ed|ion)?|culik|diculik|penculikan)\b/i],
  ['extortion', /\b(extort(ion|ed)?|peras ugut|ugut)\b/i],
  ['robbery', /\b(robbery|robbed|robbers?|armed gang|rompak|dirompak|rompakan|samun|disamun|penyamun)\b/i],
  ['snatch_theft', /\b(snatch theft|snatch thie(f|ves)|ragut|diragut|peragut)\b/i],
  ['break_in', /\b(break-?ins?|broken into|broke into|burglary|burgl(ed|ars?)|housebreak|pecah rumah|pecah masuk|dipecah masuk|dipecah|pecah cermin)\b/i],
  ['vehicle_theft', /\b(car theft|stolen (car|vehicle|motorcycle|motorbike)|curi (kereta|motosikal)|kenderaan dicuri)\b/i],
  ['assault', /\b(assault(ed)?|attacked|alleged attack|attack by|acid (attack|burns)|(di)?simbah asid|siram asid|beaten|slashed|stabbed|serang|diserang|dipukul|memukul|ditikam)\b/i],
  ['rape_sexual', /\b(rape[ds]?|molest(ed|ation)?|rogol|dirogol|cabul|dicabul)\b/i],
  ['theft', /\b(theft|stole|stolen|thie(f|ves)|curi|dicuri|pencuri|kecurian)\b/i],
  ['scam', /\b(scam(med|mer)?|fraud|cheat(ed|ing)?|macau scam|penipuan|ditipu|tipu)\b/i],
  ['drugs', /\b(drugs?|syabu|dadah|methamphetamine|heroin|ganja|ketum|ketamin|ketamine|cocaine|kokain|ecstasy|pil kuda|trafficking)\b/i],
  ['vandalism', /\b(vandal(ism|ised|ized)?|arson|torched|dibakar|khianat)\b/i],
  // Arrest stories that don't name the offence. Checked last so a specific type wins.
  ['police_case', /\b(nabbed|arrested|remanded|suspects?|dicekup|diberkas|ditahan polis|direman|suspek|tumpas)\b/i],
];

// Malay idioms that reuse crime words: "ragut 68 nyawa" (claimed 68 lives), "padang ragut"
// (grazing land), "ragut emas" (won gold), "cetak rompak" (piracy). Removed before classifying.
const IDIOMS = [
  /\bragut(kan)?\s+(\S+\s+){0,3}?nyawa\b/gi,
  /\bpadang\s+ragut\b/gi,
  /\bragut\s+(\S+\s+)?(emas|pingat|perak|gangsa|gelaran|kejuaraan|kemenangan|takhta|trofi|piala|mata|tempat)\b/gi,
  /\bcetak\s+rompak\b/gi,
  /\bkilled\s+off\b/gi,
  // "curi perhatian" (draws attention), "curi tumpuan", "curi hati" (wins hearts), "curi tulang" (skives),
  // "curi masa/peluang/start", "curi-curi" (on the sly), and the same with mencuri/dicuri.
  /\b(men|di|ter)?curi\s+(perhatian|tumpuan|hati|tulang|masa|peluang|start|pandang|lihat|dengar|ilmu|idea|limelight|show)\b/gi,
  /\bcuri-curi\b/gi,
  /\bpencuri\s+hati\b/gi,
  // "tikam belakang" (betrayal), "tikam ekor" (illegal lottery slang), "bunuh diri" (suicide, not a crime scene).
  /\b(di)?tikam\s+(dari\s+)?belakang\b/gi,
  /\btikam\s+ekor\b/gi,
  /\bbunuh\s+diri\b/gi,
  // English: "steal the show/spotlight", "daylight robbery" (overpriced), "highway robbery", "killing it", "killer app".
  /\b(steal|steals|stole|stealing)\s+the\s+(show|spotlight|limelight)\b/gi,
  /\b(daylight|highway)\s+robbery\b/gi,
  /\bkill(ing|ed)\s+it\b/gi,
  /\bkiller\s+(app|deal|feature|look)\b/gi,
];

// Political stories: party names, party events and politics sections. Acronyms are matched in capitals
// only, and names that are also ordinary words (Amanah = trust, as in "pecah amanah"; Bersatu = united;
// Warisan = heritage; Muda = young) only in capitals or with "Parti".
const POLITICAL = new RegExp([
  '\\b(PAS|UMNO|PKR|DAP|MCA|MIC|PBB|SUPP|PRS|PDP|PBS|UPKO|KDM|PSM|BN|PH|PN|GRS|AMANAH|BERSATU|WARISAN|PEJUANG|MUDA|PUTRA)\\b',
  '\\b(Barisan Nasional|Pakatan Harapan|Perikatan Nasional|Gabungan Parti Sarawak|Gabungan Rakyat Sabah|Perhimpunan Agung UMNO|Muktamar)\\b',
  '\\b[Pp]arti (Amanah|Bersatu|Pribumi|Warisan|Pejuang|Keadilan|Islam|Tindakan|Muda|Sosialis)\\b',
  '\\b([Pp]arti politik|political part(y|ies)|[Pp]ilihan [Rr]aya|PRN|PRK|by-election|state election|general election|[Cc]alon|ketua bahagian|division chief)\\b',
].join('|'));
const POLITICS_URL = /\/(politik|politics|politic|pilihan-raya|election)s?\//i;
const isPolitical = (title, summary = '', link = '') => POLITICAL.test(`${title} ${summary}`) || POLITICS_URL.test(link);

// Tallies over months or years ("2,097 police arrested since 2021") aren't incidents.
const AGGREGATE = /\b(since|sejak)\s+(19|20)\d{2}\b|\b(so far this year|this year alone|setakat ini|sepanjang tahun|bagi tempoh|statistik|statistics)\b/i;

// Follow-up stories (funerals, condolences) name places that aren't the crime scene.
const FOLLOW_UP = /\b(remains|burial|funeral|condolences?|tribute|laid to rest|jenazah|dikebumikan|disemadikan|pengebumian|takziah)\b/i;
const stripIdioms = t => IDIOMS.reduce((s, re) => s.replace(re, ' '), t);

// Words that look like places after "in/at/di" but aren't, or are too coarse for a 10 km map.
const STOP = new Set(['Malaysia', 'Court', 'Mahkamah', 'Parliament', 'Dewan', 'Police', 'Polis', 'Bukit Aman',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'The', 'A', 'An', 'Facebook', 'TikTok', 'Instagram', 'WhatsApp', 'Telegram', 'YouTube', 'Twitter', 'Shopee', 'Lazada', 'Semenanjung', 'Semenanjung Malaysia',
  'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu', 'Ahad', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'Oleh', 'Menurut', 'Katanya', 'Selain', 'Bagaimanapun', 'Sementara', 'Dalam', 'Pada', 'Taman']);
// Buildings named after a crime that aren't its scene: the court, the hospital, the police station.
const INSTITUTION = /^(Mahkamah|Court|Hospital|Universiti|University|Balai|IPD|Ibu Pejabat|Jabatan|Kementerian|Pejabat|Penjara|Lokap|Pusat Perubatan)\b/;
const STATES = new Set(['Selangor', 'Johor', 'Kedah', 'Kelantan', 'Terengganu', 'Pahang', 'Perak', 'Perlis', 'Pulau Pinang',
  'Penang', 'Melaka', 'Malacca', 'Negeri Sembilan', 'Sabah', 'Sarawak']);

// Countries and foreign cities, in English and Malay. A story set abroad must not be pinned in
// Malaysia via a place that shares the name ("Pisa", "Jalan Indonesia"). "Macau" is left out
// because "Macau scam" is a Malaysian scam type.
const FOREIGN_NAMES = ['Indonesia', 'Thailand', 'Singapore', 'Singapura', 'Brunei', 'Philippines', 'Filipina', 'Vietnam',
  'Cambodia', 'Kemboja', 'Myanmar', 'Laos', 'China', 'Hong Kong', 'Taiwan', 'Japan', 'Jepun', 'Korea', 'South Korea',
  'Korea Selatan', 'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Australia', 'New Zealand', 'United States',
  'US', 'USA', 'AS', 'Amerika', 'America', 'UK', 'United Kingdom', 'Britain', 'England', 'Scotland', 'Ireland', 'Dubai',
  'Saudi Arabia', 'Arab Saudi', 'Turkey', 'Turki', 'Mauritius', 'Africa', 'Afrika', 'South Africa', 'South African',
  'Afrika Selatan', 'Europe', 'Eropah', 'Itali', 'Italy', 'Sepanyol', 'Spain', 'Perancis', 'France', 'Jerman', 'Germany',
  'Rusia', 'Russia', 'Ukraine', 'Kanada', 'Canada', 'Iran', 'Iraq', 'Israel', 'Gaza', 'Palestin', 'Palestine', 'Lubnan',
  'Lebanon', 'Syria', 'Yaman', 'Yemen', 'Mesir', 'Egypt', 'Ethiopia', 'Nigeria', 'Brazil', 'Mexico', 'Belanda',
  'Netherlands', 'Switzerland', 'Sweden', 'Norway', 'Qatar', 'Jakarta', 'Bangkok', 'Batam', 'Medan', 'Bali', 'Surabaya',
  'Bandung', 'Aceh', 'Pattaya', 'Phuket', 'Hat Yai', 'Songkhla', 'Manila', 'Hanoi', 'Ho Chi Minh', 'Phnom Penh', 'Yangon',
  'Mumbai', 'Delhi', 'Dhaka', 'Karachi', 'Lahore', 'Rawalpindi', 'Makkah', 'Mecca', 'Madinah', 'Riyadh', 'Doha',
  'Abu Dhabi', 'Istanbul', 'Cappadocia', 'Kyiv', 'Dnipro', 'Moscow', 'Rome', 'Milan', 'Venice', 'London', 'Paris', 'Tokyo',
  'Osaka', 'Seoul', 'Beijing', 'Shanghai', 'Shenzhen', 'Guangzhou', 'Sydney', 'Melbourne', 'Perth', 'NSW', 'Auckland',
  'New York', 'Los Angeles', 'Texas', 'California', 'Tai Po', 'New Delhi', 'Serbia', 'Kenya', 'Chile', 'Peru',
  'Poland', 'Greece', 'Portugal', 'Belgium', 'Austria', 'Denmark', 'Finland', 'Afghanistan', 'Sudan', 'Libya', 'Jordan'];
const FOREIGN = new Set(FOREIGN_NAMES);
const FOREIGN_RE = new RegExp(`\\b(${FOREIGN_NAMES.map(n => n.replace(/ /g, '\\s+')).join('|')})\\b`);
// Any foreign name inside the phrase counts: "New Delhi", "Kota Bharu" is safe because neither word is listed.
const isForeign = p => FOREIGN.has(p) || FOREIGN_RE.test(p);
const mentionsForeign = text => FOREIGN_RE.test(text);

// Things that look like proper nouns but aren't places: money ("RM6mil"), numbers, agency acronyms.
const NOT_PLACE = /^(RM\s?\d|\d)|^[A-Z]{2,6}$/;
// Abbreviations that are places.
const ABBR = { KL: 'Kuala Lumpur', JB: 'Johor Bahru', PJ: 'Petaling Jaya', KK: 'Kota Kinabalu', KB: 'Kota Bharu',
  KLIA: 'Sepang', USJ: 'USJ, Subang Jaya', TTDI: 'Taman Tun Dr Ismail', PD: 'Port Dickson' };

const DAY_SUFFIX = /\s+(Isnin|Selasa|Rabu|Khamis|Jumaat|Sabtu|Ahad|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Semalam|Kelmarin|Pagi|Petang|Malam)(\s.*)?$/;
// Names that are a part of a town rather than a town: pair them with any town named in the same story.
const SUB_AREA = /^(Taman|Kampung|Kg|Seksyen|Desa|Bandar Baru|Pangsapuri|Flat|Apartment|Jalan|Lorong|Persiaran|Felda)\b/;

const MONTHS = 'Jan|Feb|Mar|Mac|Apr|May|Mei|Jun|Jul|Aug|Ogos|Sep|Oct|Okt|Nov|Dec|Dis';
const titleCase = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

function classify(text) {
  const t = stripIdioms(text);
  for (const [type, re] of TYPES) if (re.test(t)) return type;
  return null;
}

// The dateline at the start of a news summary, e.g. "SHAH ALAM, Oct 30 —" or "KAJANG: ...".
// It names where the story was filed, usually the nearest town.
// Harian Metro writes "Miri: …" or "Kota Kinabalu: …" in title case, right at the start of the article.
// Only accepted after the headline (headlines use "Kajian: …", "Video: …" as prefixes).
const TITLE_DATELINE = /\.\s((?:[A-Z][a-z']+)(?:\s[A-Z][a-z']+){0,2}):\s+[A-Z]/;
const NOT_DATELINE = /^(Update|Video|Kajian|Polis|Police|Exclusive|Eksklusif|Terkini|Foto|Gambar|Laporan|Report|Analysis|Opinion|Komentar|Note|Nota|Sumber|Source)\b/;

function datelineRaw(text) {
  const m = text.match(new RegExp(`(?:^|\\.\\s)([A-Z][A-Z .']{2,30}?)\\s*(?:,\\s*(?:\\d{1,2}\\s+)?(?:${MONTHS})|:|\\s[-–—]\\s)`));
  if (m) return m[1].trim();
  const t = text.match(TITLE_DATELINE);
  return t && !NOT_DATELINE.test(t[1]) ? t[1].trim() : null;
}

// True when the story was filed from abroad ("NEW DELHI – …", "Rome: …").
const foreignDateline = text => { const r = datelineRaw(text); return !!r && isForeign(titleCase(r)); };

function datelineTown(text) {
  // Forms: "SHAH ALAM, Oct 30 —", "JAKARTA, 30 Oktober –", "KAJANG: ...", "KUANTAN - ..." (Sinar Harian).
  const raw = datelineRaw(text);
  if (!raw) return null;
  const town = ABBR[raw] || titleCase(raw);
  return STOP.has(town) || STATES.has(town) || isForeign(town) ? null : town;
}

// Capitalised phrases after a location word: "in Taman Melawati", "di Seksyen 7", "di kuarters KLIA".
// Returns the most specific candidates first, each paired with the dateline town when there is one,
// then the dateline town on its own as the last resort.
function placeCandidates(text) {
  const town = datelineTown(text);
  const found = new Set();
  const re = /\b(?:in|at|near|di|dekat|kat|sekitar|kawasan|area)\s+(?:(?:kuarters|kawasan|perumahan|pangsapuri|apartmen|flat|kampung|pekan|bandar)\s+){0,2}((?:[A-Z][\w'-]+)(?:\s+(?:[A-Z][\w'-]+|\d+[A-Z]?))*)/g;
  let m;
  while ((m = re.exec(text))) {
    // Malay news writes the day right after the place: "di Sungai Siput Isnin" (on Monday).
    let phrase = m[1].trim().replace(DAY_SUFFIX, '').trim();
    phrase = ABBR[phrase] || phrase;
    // "di Pisa, Itali": the place is abroad.
    const after = text.slice(re.lastIndex).match(/^,\s*([A-Z][\w]+(?:\s+[A-Z][\w]+)?)/);
    if (after && isForeign(after[1])) continue;
    if (INSTITUTION.test(phrase)) continue;
    // Drop a trailing number only from multi-word names ("Jalan Ipoh 2"); keep "Seksyen 7", "SS 15".
    if (phrase.split(/\s+/).length > 2) phrase = phrase.replace(/\s+\d+[A-Z]?$/, '');
    if (phrase.length > 2 && !STOP.has(phrase) && !STATES.has(phrase) && !isForeign(phrase) &&
        !NOT_PLACE.test(phrase) && phrase !== town) {
      // "di Taman Orkid, Kluang": keep the town with the taman so a common name isn't matched elsewhere.
      if (after && !STOP.has(after[1]) && !INSTITUTION.test(after[1])) found.add(`${phrase}, ${ABBR[after[1]] || after[1]}`);
      found.add(phrase);
    }
  }
  const out = [];
  // "di Taman Orkid … di Sungai Siput": try the taman within that town first.
  const subs = [...found].filter(p => SUB_AREA.test(p) && !p.includes(','));
  const towns = [...found].filter(p => !SUB_AREA.test(p) && !p.includes(','));
  for (const sub of subs) for (const t of towns) out.push(`${sub}, ${t}`);
  for (const p of found) {
    if (town && !p.includes(town)) out.push(`${p}, ${town}`);
    out.push(p);
  }
  if (town) out.push(town);
  return { places: [...new Set(out)].slice(0, 5), named: found.size };
}

// A story is set abroad when it names a foreign place and no Malaysian place of its own.
// Also when the headline itself names a foreign place and no other place ("ditembak di sekolah rendah AS").
function isAbroad(text, named, title = '') {
  if (foreignDateline(text)) return true;
  if (named === 0 && mentionsForeign(text)) return true;
  return mentionsForeign(title) && placeCandidates(title).named === 0;
}

// Statements, policy and opinion pieces: their dateline is where the speaker was, not a crime scene.
const POLICY = /\b(Act|Akta|amendments?|pindaan|proposed|cadangan|policy|dasar|study|says|said|kata|berkata|minister|menteri|MP|Dewan Rakyat|Parlimen|urges|gesa|calls for|reveal)\b|\s[-–]\s[A-Z][a-z]+$/;

// ---------- Social posts ----------
// Posts are casual and often lowercase ("kena ragut kat cheras"), so as a fallback they're matched
// against a list of known towns. Town names that are also everyday Malay words are left out
// (nilai = value, papar = display, baling = throw, selama = during, pekan = town, bau = smell…).
const AMBIGUOUS_TOWNS = new Set(['song', 'bau', 'yan', 'sik', 'pekan', 'nilai', 'selama', 'papar', 'jeli', 'baling', 'dalat', 'bera',
  'marang', 'maran', 'raub', 'timur laut', 'barat daya', 'kerian', 'betong', 'tumpat']);
const EXTRA_TOWNS = ['kuala lumpur', 'kl', 'ampang', 'puchong', 'bangsar', 'kepong', 'setapak', 'bangi', 'cyberjaya', 'rawang',
  'seri kembangan', 'sri petaling', 'bukit jalil', 'damansara', 'mont kiara', 'sri hartamas', 'klang', 'johor bahru', 'jb', 'skudai',
  'george town', 'georgetown', 'butterworth', 'bukit mertajam', 'bayan lepas', 'seremban', 'melaka', 'malacca', 'ipoh', 'kuantan',
  'kota bharu', 'alor setar', 'sungai petani', 'kuching', 'kota kinabalu', 'kk', 'semenyih', 'kajang', 'cheras', 'shah alam',
  'subang', 'petaling jaya', 'pj', 'putrajaya', 'gombak', 'wangsa maju', 'sentul', 'brickfields', 'bukit bintang', 'chow kit',
  'masai', 'pasir gudang', 'kulai', 'nilai 3', 'banting', 'tanjung karang', 'sabak bernam', 'teluk intan', 'taiping', 'lumut'];
let TOWN_LIST = null;
function townList() {
  if (TOWN_LIST) return TOWN_LIST;
  let seeds = {};
  try { seeds = require('../data/police-districts.json'); } catch {}
  const names = [...Object.keys(seeds).filter(k => !k.startsWith('_')), ...EXTRA_TOWNS].filter(n => !AMBIGUOUS_TOWNS.has(n));
  // Longest first, so "kota kinabalu" wins over a shorter name inside it.
  TOWN_LIST = [...new Set(names)].sort((a, b) => b.length - a.length)
    .map(n => ({ name: n, re: new RegExp(`(^|[^a-z])${n.replace(/ /g, '\\s+')}([^a-z]|$)`, 'i') }));
  return TOWN_LIST;
}
const TOWN_ABBR = { kl: 'Kuala Lumpur', jb: 'Johor Bahru', pj: 'Petaling Jaya', kk: 'Kota Kinabalu', georgetown: 'George Town', malacca: 'Melaka' };
function knownTown(text) {
  for (const t of townList()) if (t.re.test(text)) return TOWN_ABBR[t.name] || t.name.replace(/\b\w/g, c => c.toUpperCase());
  return null;
}

// Posts that mention a crime word but don't report one: questions, advice, jokes, news commentary.
const SOCIAL_NOISE = /\b(is it safe|safe ke|selamat ke|any tips|tips|recommend|how to|macam mana nak|what should i do|apa patut|lol|haha|wkwk|meme|joke|gurau|movie|filem|drama|game|song)\b|\?\s*$/i;
// Signs the poster is describing something that happened to them or near them.
const FIRST_HAND = /\b(kena|kene|baru|tadi|semalam|just now|last night|yesterday|today|this morning|my|aku|saya|kami|kitorang|we were|i was|got)\b/i;

module.exports = { isPolitical, classify, placeCandidates, datelineTown, isAbroad, stripIdioms, FOLLOW_UP, AGGREGATE, SUB_AREA, POLICY,
  knownTown, SOCIAL_NOISE, FIRST_HAND };
