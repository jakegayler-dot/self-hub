// Expeditions (2026-10-31): the pure parts. Distances between places, the weather of a day at a place (Open-Meteo:
// the archive for past days, the forecast service for the last few days and the days ahead; no key), and what he
// logged in training each day of a trip.

const R_KM = 6371.0088;
function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Along the places in order (straight lines between them: as the crow flies, not the road).
function routeKm(places) {
  let km = 0;
  for (let i = 1; i < places.length; i++) km += haversineKm(places[i - 1], places[i]);
  return Math.round(km);
}
// The nearest place within maxKm of a point (a photo's GPS), or null.
function nearestPlace(places, lat, lon, maxKm = 5) {
  let best = null;
  for (const p of places) {
    const d = haversineKm(p, { lat, lon });
    if (d <= maxKm && (!best || d < best.d)) best = { p, d };
  }
  return best ? best.p : null;
}

// WMO weather codes, as Open-Meteo gives them, in words.
const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain',
  67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };
const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,wind_speed_10m_max,weather_code';
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// The archive runs about five days behind and the forecast service reaches back about three months and ahead about two
// weeks, so: older than 5 days, the archive; otherwise the forecast; more than 15 days ahead, nothing to ask.
function weatherUrl(lat, lon, date, today) {
  if (date > addDays(today, 15)) return null;
  const host = date < addDays(today, -5) ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  return `${host}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${date}&end_date=${date}&daily=${DAILY}&timezone=auto`;
}
function weatherFrom(data, date) {
  const d = data && data.daily;
  if (!d || !Array.isArray(d.time)) return null;
  const i = d.time.indexOf(date);
  if (i < 0) return null;
  const v = (k) => (d[k] && d[k][i] != null ? Number(d[k][i]) : null);
  const code = v('weather_code');
  const w = { high_c: v('temperature_2m_max'), low_c: v('temperature_2m_min'), precip_mm: v('precipitation_sum'), snow_cm: v('snowfall_sum'),
    wind_kmh: v('wind_speed_10m_max'), code, sky: code == null ? null : (WMO[code] || null) };
  return w.high_c == null && w.low_c == null ? null : w;
}

// What he logged on each day from..to: runs, rucks, swims and rows (conditioning), sessions finished, lifts and
// gymnastics by movement. rows = { conditioning, workouts, lifts, gymnastics } as the tables give them.
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const mmss = (s) => { s = Math.round(Number(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
function trainingByDay(rows, from, to) {
  const days = {};
  const at = (d) => { const k = ymd(d); if (k < from || k > to) return null; return (days[k] = days[k] || []); };
  for (const c of rows.conditioning || []) {
    const list = at(c.entry_date); if (!list) continue;
    const km = c.distance_m != null ? Number(c.distance_m) / 1000 : null;
    list.push({ kind: 'conditioning', text: [c.movement, km != null ? `${km >= 10 ? km.toFixed(1) : km.toFixed(2).replace(/0$/, '')} km` : null, c.duration_seconds ? `in ${mmss(c.duration_seconds)}` : null].filter(Boolean).join(' '), km });
  }
  for (const w of rows.workouts || []) {
    if (w.status !== 'done') continue;
    const list = at(w.workout_date); if (!list) continue;
    list.push({ kind: 'workout', text: `${w.title}${w.minutes ? ` (${w.minutes} min)` : ''}` });
  }
  const sets = {};
  for (const l of rows.lifts || []) { const k = ymd(l.entry_date); if (k < from || k > to) continue; (sets[k] = sets[k] || {})[l.lift] = (sets[k][l.lift] || 0) + 1; }
  for (const g of rows.gymnastics || []) { const k = ymd(g.entry_date); if (k < from || k > to) continue; (sets[k] = sets[k] || {})[g.movement] = (sets[k][g.movement] || 0) + 1; }
  for (const [k, by] of Object.entries(sets)) {
    (days[k] = days[k] || []).push({ kind: 'sets', text: Object.entries(by).map(([m, n]) => `${m} ${n} set${n === 1 ? '' : 's'}`).join(', ') });
  }
  return days;
}

module.exports = { haversineKm, routeKm, nearestPlace, weatherUrl, weatherFrom, trainingByDay, WMO, addDays };
