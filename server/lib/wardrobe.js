// The wardrobe (Jake, 2026-10-31: brought over from his wardrobe manager; his own clothes only). Pure functions:
// what to wear today from the weather at the farm and the day's plan, the gaps in the wardrobe, and the exports.

const CATS = ['Top', 'Bottom', 'Dress', 'Outerwear', 'Footwear', 'Accessory', 'Sleepwear'];
const SEASONS = ['Summer', 'Fall/Winter', 'Winter', 'All-Season', 'Unknown'];
const CONDITIONS = ['New', 'Like New', 'Excellent', 'Good', 'Fair', 'Used', 'Well Used'];
const STATUS = ['Wear', 'Repair', 'Retired', 'Wishlist'];
const STYLES = ['Casual', 'Smart Casual', 'Dress', 'Athletic', 'Farm', 'Loungewear', 'Formal'];
const OCCASIONS = { farm: 'Farm work', town: 'Town', dress: 'Dressed up', gym: 'Gym' };
const FIELDS = ['id', 'category', 'type', 'brand', 'colour', 'size', 'season', 'condition', 'style', 'warmth', 'notes', 'status'];
// The farm, near Star City, Saskatchewan.
const FARM = { lat: 52.87, lon: -104.35, tz: 'America/Regina' };

// ---- what each piece is ----
const isMid = (i) => i.category === 'Top' && /sweater|hoodie|quarter-zip|zip-up|fleece|cardigan|pullover/i.test(i.type);
const isBase = (i) => i.category === 'Top' && !isMid(i);
const isLongSleeve = (i) => /long sleeve|base layer|button|dress shirt|thermal/i.test(i.type);
const isShorts = (i) => i.category === 'Bottom' && /short|trunk/i.test(i.type);
const isSwim = (i) => /swim|board|surf/i.test(i.type);
const footKind = (i) => (/boot/i.test(i.type) ? 'boots' : /dress/i.test(i.type) ? 'dress' : /sandal|slide|flip/i.test(i.type) ? 'sandals' : 'sneakers');
// Warmth when the record doesn't say (1 light … 5 very warm).
function warmthOf(i) {
  if (i.warmth != null) return Number(i.warmth);
  if (i.category === 'Outerwear') return /parka|winter|down|insulated/i.test(i.type) ? 5 : 3;
  if (isMid(i)) return /knit|sweater/i.test(i.type) ? 4 : 3;
  if (/base layer|thermal/i.test(i.type)) return 2;
  if (isShorts(i)) return 1;
  if (i.category === 'Bottom') return 2;
  return isLongSleeve(i) ? 2 : 1;
}
const NEUTRAL = /^(black|faded black|white|cream|off-white|grey|gray|light grey|dark grey|charcoal|navy|navy blue|dark blue|blue|light blue|tan|khaki|beige|brown|light brown|dark brown|olive|denim|unknown)$/i;
const isNeutral = (i) => !i.colour || NEUTRAL.test(String(i.colour).trim()) || /\//.test(i.colour) && String(i.colour).split('/').every((c) => NEUTRAL.test(c.trim()));
const CONDITION_RANK = Object.fromEntries(CONDITIONS.map((c, k) => [c, k])); // 0 best … 6 worst

// ---- the weather ----
// From Open-Meteo's daily forecast (no key) for the farm: the day's numbers in °C, km/h, mm, cm.
function weatherFromOpenMeteo(data, date) {
  const d = data && data.daily;
  if (!d || !Array.isArray(d.time)) return null;
  const k = d.time.indexOf(date);
  if (k < 0) return null;
  const v = (key) => (Array.isArray(d[key]) && d[key][k] != null ? Number(d[key][k]) : null);
  return { date, high_c: v('temperature_2m_max'), low_c: v('temperature_2m_min'), feels_low_c: v('apparent_temperature_min'), feels_high_c: v('apparent_temperature_max'),
    precip_mm: v('precipitation_sum'), precip_chance: v('precipitation_probability_max'), snow_cm: v('snowfall_sum'), wind_kmh: v('wind_speed_10m_max'), code: v('weather_code'), source: 'Open-Meteo' };
}
const openMeteoUrl = (days = 3) => `https://api.open-meteo.com/v1/forecast?latitude=${FARM.lat}&longitude=${FARM.lon}&daily=temperature_2m_max,temperature_2m_min,apparent_temperature_min,apparent_temperature_max,precipitation_sum,precipitation_probability_max,snowfall_sum,wind_speed_10m_max,weather_code&timezone=${encodeURIComponent(FARM.tz)}&forecast_days=${days}`;

// The temperature to dress for: outside all day (farm, truck) the cold end; in town, between.
function dressTemp(w, occasion) {
  if (!w) return null;
  const lo = w.feels_low_c ?? w.low_c; const hi = w.feels_high_c ?? w.high_c;
  if (lo == null && hi == null) return null;
  if (lo == null) return hi; if (hi == null) return lo;
  return occasion === 'farm' ? lo + (hi - lo) * 0.3 : occasion === 'gym' ? hi : lo + (hi - lo) * 0.5;
}
// Warmth needed from each layer, by the temperature (°C).
function layersFor(t) {
  if (t == null) return { mid: false, outer: false, shorts: false, longSleeve: false, band: 'unknown' };
  if (t >= 22) return { mid: false, outer: false, shorts: true, longSleeve: false, band: 'hot', bottomWarmth: 1 };
  if (t >= 15) return { mid: false, outer: false, shorts: false, longSleeve: false, band: 'warm', bottomWarmth: 2 };
  if (t >= 7) return { mid: true, outer: false, shorts: false, longSleeve: false, band: 'cool', bottomWarmth: 2, midWarmth: 3 };
  if (t >= -3) return { mid: true, outer: true, shorts: false, longSleeve: true, band: 'cold', bottomWarmth: 3, midWarmth: 3, outerWarmth: 3 };
  return { mid: true, outer: true, shorts: false, longSleeve: true, band: 'freezing', bottomWarmth: 3, midWarmth: 4, outerWarmth: 5 };
}
const seasonFits = (i, t) => {
  const s = i.season || 'Unknown';
  if (s === 'All-Season' || s === 'Unknown' || t == null) return true;
  if (s === 'Summer') return t >= 12;
  if (s === 'Winter') return t < 5;
  return t < 18; // Fall/Winter
};
// What each occasion asks of a piece: its styles, and whether to save the good clothes (farm) or wear them (dress).
const WANT = {
  farm: { styles: ['Farm', 'Casual', 'Athletic'], condition: 'worst' },
  town: { styles: ['Casual', 'Smart Casual'], condition: 'best' },
  dress: { styles: ['Dress', 'Smart Casual', 'Formal'], condition: 'best' },
  gym: { styles: ['Athletic'], condition: 'any' },
};

// ---- today's outfit ----
// items: his wardrobe; worn: { item_id → last date worn }; date YYYY-MM-DD; w: the weather (or null);
// occasion: farm | town | dress | gym; session: { gym: bool, title } when he trains today.
function todaysOutfit({ items, worn = {}, date, weather: w = null, occasion = 'farm', session = null }) {
  const want = WANT[occasion] || WANT.farm;
  const t = dressTemp(w, occasion);
  const L = layersFor(t);
  const wearable = items.filter((i) => (i.status || 'Wear') === 'Wear');
  const daysSince = (i) => (worn[i.id] ? Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${worn[i.id]}T12:00:00Z`)) / 864e5) : 99);
  const seed = [...date].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const chosen = []; const notes = []; const missing = [];
  function score(i, role, target) {
    let s = 0;
    if (want.styles.includes(i.style)) s += 4 - want.styles.indexOf(i.style);
    else if (!i.style) s += 1;
    else s -= occasion === 'dress' || occasion === 'gym' ? 6 : 2;
    const cr = CONDITION_RANK[i.condition] ?? 3;
    if (want.condition === 'worst') s += cr * 0.5; else if (want.condition === 'best') s += (6 - cr) * 0.5;
    if (target != null) s -= Math.abs(warmthOf(i) - target) * 1.5;
    if (!seasonFits(i, t)) s -= 5;
    const ds = daysSince(i); if (ds < 3) s -= (3 - ds) * 3; // something different from the last couple of days
    if (/stain|rip|torn|hole/i.test(i.notes || '') && occasion !== 'farm') s -= 4; // stained clothes are for the farm
    if (/doesn'?t fit|too (big|small|long)/i.test(i.notes || '')) s -= 3;
    if (/sweat|jogger|track/i.test(i.type) && (occasion === 'town' || occasion === 'dress')) s -= 6; // not in town
    if (role === 'top' && t != null && t < -3 && /base layer|thermal/i.test(i.type)) s += 4; // a thermal under it all when it's freezing
    if (role === 'outer' && t != null && t < 3 && /vest|body warmer|gilet/i.test(`${i.type} ${i.notes || ''}`)) s -= 2; // sleeves, when it's cold
    // Colour: one statement piece at most, against neutrals.
    if (!isNeutral(i) && chosen.some((c) => !isNeutral(c.item))) s -= 3;
    s += ((seed + i.id.charCodeAt(i.id.length - 1)) % 7) * 0.05; // a little variety day to day
    return s;
  }
  function pick(role, pool, target) {
    const best = pool.map((i) => ({ i, s: score(i, role, target) })).sort((a, b) => b.s - a.s)[0];
    if (best) chosen.push({ role, item: best.i });
    else missing.push(role);
    return best && best.i;
  }
  if (occasion === 'gym') {
    pick('top', wearable.filter((i) => isBase(i) && i.style === 'Athletic'), 1);
    pick('bottom', wearable.filter((i) => i.category === 'Bottom' && i.style === 'Athletic' && !isSwim(i)), L.shorts ? 1 : 2);
    if (t != null && t < 10) pick('layer', wearable.filter((i) => isMid(i) && i.style === 'Athletic'), 3);
    pick('shoes', wearable.filter((i) => i.category === 'Footwear' && footKind(i) === 'sneakers'));
  } else {
    pick('top', wearable.filter((i) => isBase(i) && (!L.longSleeve || isLongSleeve(i) || !wearable.some((x) => isBase(x) && isLongSleeve(x)))), L.longSleeve ? 2 : 1);
    if (L.mid) pick('layer', wearable.filter(isMid), L.midWarmth);
    let bottoms = wearable.filter((i) => i.category === 'Bottom' && !isSwim(i) && (L.shorts && occasion !== 'dress' ? true : !isShorts(i)) && (occasion === 'farm' || i.style !== 'Athletic'));
    // Hot and not dressed up: shorts when he has a pair that suits the day.
    if (L.shorts && occasion !== 'dress' && bottoms.some(isShorts)) bottoms = bottoms.filter(isShorts);
    pick('bottom', bottoms, L.bottomWarmth);
    const wet = w && ((w.precip_chance ?? 0) >= 50 || (w.precip_mm ?? 0) >= 2 || (w.snow_cm ?? 0) > 0);
    const windy = w && (w.wind_kmh ?? 0) >= 30;
    if (L.outer || ((wet || windy) && t != null && t < 18)) {
      const outer = wearable.filter((i) => i.category === 'Outerwear');
      const o = pick('outer', outer, L.outerWarmth || 3);
      if (o && L.outerWarmth && warmthOf(o) < L.outerWarmth) notes.push(`${Math.round(t)}°C needs more than your ${o.type.toLowerCase()} (warmth ${warmthOf(o)} of 5): you have no winter coat.`);
      // A vest over a hoodie isn't enough on its own below freezing: say so once.
      if (o && /vest|body warmer|gilet/i.test(`${o.type} ${o.notes || ''}`) && t < -3) notes.push('A vest leaves your arms out in the cold: wear your warmest hoodie under it.');
    }
    const feet = wearable.filter((i) => i.category === 'Footwear');
    const kinds = occasion === 'dress' ? ['dress', 'sneakers'] : occasion === 'farm' ? (t != null && t < 3 ? ['boots', 'sneakers'] : ['boots', 'sneakers']) : L.shorts ? ['sandals', 'sneakers'] : ['sneakers', 'dress'];
    let shoe = null;
    for (const k of kinds) { shoe = feet.filter((i) => footKind(i) === k).sort((a, b) => daysSince(b) - daysSince(a))[0]; if (shoe) break; }
    if (shoe) chosen.push({ role: 'shoes', item: shoe }); else missing.push('shoes');
    if (occasion === 'farm' && !feet.some((i) => footKind(i) === 'boots')) notes.push('No work boots in the wardrobe: sneakers on the farm.');
    if (t != null && t < -3) {
      const acc = wearable.filter((i) => i.category === 'Accessory' && /toque|beanie|hat|glove|mitt|scarf|neck/i.test(i.type));
      if (!acc.length) notes.push(`At ${Math.round(t)}°C: a toque and gloves (you have none listed).`);
      else acc.forEach((a) => chosen.push({ role: 'accessory', item: a }));
    }
    if (occasion === 'dress') { const belt = wearable.find((i) => /belt/i.test(i.type) && i.style === 'Smart Casual'); if (belt) chosen.push({ role: 'belt', item: belt }); }
  }
  // Training today and dressed for something else: the gym kit to take.
  let gymKit = null;
  if (session && session.gym && occasion !== 'gym') {
    const k = todaysOutfit({ items, worn, date, weather: w, occasion: 'gym' });
    gymKit = { for: session.title || 'today\'s session', pieces: k.pieces, missing: k.missing };
  }
  if (t == null) notes.push('No forecast: dressed for a mild day.');
  return {
    date, occasion, occasion_label: OCCASIONS[occasion] || occasion, weather: w, dress_for_c: t == null ? null : Math.round(t), band: L.band,
    pieces: chosen.map(({ role, item }) => ({ role, id: item.id, type: item.type, brand: item.brand || null, colour: item.colour || null, warmth: warmthOf(item), last_worn: worn[item.id] || null })),
    missing, notes, gym_kit: gymKit,
  };
}

// ---- what the wardrobe is short of (for him and the stylist) ----
function gaps(items) {
  const w = items.filter((i) => (i.status || 'Wear') === 'Wear');
  const out = [];
  const outer = w.filter((i) => i.category === 'Outerwear');
  if (!outer.some((i) => warmthOf(i) >= 5)) out.push({ area: 'Winter coat', why: `Warmest outerwear is ${outer.length ? outer.map((i) => i.type.toLowerCase()).join(', ') : 'nothing'}; Saskatchewan winters reach −30°C.`, priority: 1 });
  const feet = w.filter((i) => i.category === 'Footwear');
  if (!feet.some((i) => footKind(i) === 'boots')) out.push({ area: 'Boots', why: 'No work or winter boots: only ' + (feet.map((i) => i.type.toLowerCase()).join(', ') || 'nothing') + '.', priority: 1 });
  if (!w.some((i) => /toque|beanie/i.test(i.type))) out.push({ area: 'Toque', why: 'None listed.', priority: 2 });
  if (!w.some((i) => /glove|mitt/i.test(i.type))) out.push({ area: 'Gloves', why: 'None listed.', priority: 2 });
  const bases = w.filter((i) => /base layer|thermal/i.test(i.type));
  if (bases.length < 2) out.push({ area: 'Base layers', why: `${bases.length} thermal base layer${bases.length === 1 ? '' : 's'}; two or three get a farm winter through a wash cycle.`, priority: 2 });
  const smart = w.filter((i) => i.category === 'Bottom' && /dress pants|chino/i.test(i.type) && !/doesn'?t fit|stain/i.test(i.notes || ''));
  if (smart.length < 2) out.push({ area: 'Smart trousers', why: `${smart.length} pair${smart.length === 1 ? '' : 's'} that fit and are clean.`, priority: 3 });
  const worn = w.filter((i) => /stain|rip|torn|hole|faded/i.test(i.notes || '') || i.condition === 'Well Used');
  if (worn.length) out.push({ area: 'Tired pieces', why: `${worn.length} stained, ripped or well-worn: farm clothes now, or replace (${worn.slice(0, 4).map((i) => i.type).join(', ')}${worn.length > 4 ? '…' : ''}).`, priority: 3 });
  return out;
}
function stats(items) {
  const count = (list, key) => { const m = {}; list.forEach((i) => { const v = i[key] || 'Unknown'; m[v] = (m[v] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const own = items.filter((i) => i.status !== 'Wishlist');
  const isGap = (i) => !i.brand || i.brand === 'Unknown' || !i.season || i.season === 'Unknown' || !i.style;
  return {
    total: own.length, by_category: count(own, 'category'), repair: own.filter((i) => i.status === 'Repair').map((i) => ({ id: i.id, type: i.type, notes: i.notes })),
    missing_info: own.filter(isGap).length, top_brand: count(own.filter((i) => i.brand && i.brand !== 'Unknown'), 'brand')[0] || null,
    top_style: count(own.filter((i) => i.style), 'style')[0] || null, top_colour: count(own.filter((i) => i.colour && i.colour !== 'Unknown'), 'colour')[0] || null,
    wishlist: items.filter((i) => i.status === 'Wishlist').length,
  };
}

// ---- ids, as his manager made them: T001, B014, A004… ----
const PREFIX = { Top: 'T', Bottom: 'B', Dress: 'D', Outerwear: 'O', Footwear: 'F', Accessory: 'A', Sleepwear: 'S' };
function nextId(category, ids, wishlist = false) {
  const p = (wishlist ? 'W' : '') + (PREFIX[category] || 'X');
  const have = new Set(ids);
  let n = 1;
  while (have.has(p + String(n).padStart(3, '0'))) n += 1;
  return p + String(n).padStart(3, '0');
}

// ---- exports (as his manager did them) ----
function toCsv(items) {
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [FIELDS.join(','), ...items.map((i) => FIELDS.map((f) => q(i[f])).join(','))].join('\n');
}
function toSql(items) {
  const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`);
  return `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, type TEXT NOT NULL, brand TEXT, colour TEXT, size TEXT, season TEXT,
    condition TEXT, style TEXT, warmth INTEGER CHECK (warmth BETWEEN 1 AND 5), notes TEXT, status TEXT, owner TEXT);
DELETE FROM items;
${items.map((i) => `INSERT INTO items (${FIELDS.join(', ')}, owner) VALUES (${FIELDS.map((f) => q(i[f])).join(', ')}, 'Jake');`).join('\n')}
`;
}

module.exports = { CATS, SEASONS, CONDITIONS, STATUS, STYLES, OCCASIONS, FIELDS, FARM, warmthOf, isMid, footKind, weatherFromOpenMeteo, openMeteoUrl, dressTemp, layersFor, todaysOutfit, gaps, stats, nextId, toCsv, toSql };
