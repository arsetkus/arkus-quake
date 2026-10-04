// Human-readable location ("68 km barat daya Calang (laut)") for each on-chain report.
// On-chain reports only carry coordinates, so the place name is looked up, in order:
//   1. data/places.json cache          4. USGS by time + location (older quakes, English, translated)
//   2. the agent's saved snapshot      5. replay fixtures (simulated reports)
//   3. current BMKG feeds (coords + time)
// Lookups run in the background; until one succeeds the dashboard shows coordinates.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'places.json');
const SNAPSHOTS = path.join(ROOT, 'agent', 'data');
const FIXTURES = path.join(ROOT, 'agent', 'fixtures');
// felt-quake feed first: it has the most readable wording
const BMKG = ['gempadirasakan', 'gempaterkini', 'autogempa'].map((f) => `https://data.bmkg.go.id/DataMKG/TEWS/${f}.json`);
const RETRY_MS = 10 * 60 * 1000;

const DIRS = { N: 'utara', NNE: 'utara-timur laut', NE: 'timur laut', ENE: 'timur-timur laut', E: 'timur', ESE: 'timur-tenggara', SE: 'tenggara',
  SSE: 'selatan-tenggara', S: 'selatan', SSW: 'selatan-barat daya', SW: 'barat daya', WSW: 'barat-barat daya', W: 'barat', WNW: 'barat-barat laut',
  NW: 'barat laut', NNW: 'utara-barat laut' };

// "RUTENG-MANGGARAI-NTT" -> "Ruteng, Manggarai, NTT" (short tokens are province codes: keep them upper case)
const upperPlace = (t) => t.split('-').filter(Boolean).map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(', ');

/** BMKG / USGS wording -> short Indonesian place. Pure. */
function formatPlace(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const fixDir = (t) => t.replace(/\b[A-Z][A-Z0-9.]+(?:-[A-Z0-9.]+)+\b/g, upperPlace).replace(/\b(barat|timur)(daya|laut)\b/gi, '$1 $2')
    .replace(/^(\d+ km )((?:barat|timur|utara|selatan|tenggara|daya|laut)(?: (?:barat|timur|utara|selatan|tenggara|daya|laut))*)/i, (_, d, w) => d + w.toLowerCase());
  // gempadirasakan: "Pusat gempa berada di laut 68 km barat daya Calang"
  let m = s.match(/^pusat gempa berada di (laut|darat)\s+(.+)$/i);
  if (m) return `${fixDir(m[2])} (${m[1].toLowerCase()})`;
  // gempaterkini: "68 km BaratDaya CALANG-ACEHJAYA"
  m = s.match(/^(\d+ km) ([A-Za-z]+) ([A-Z0-9.\- ]+)$/);
  if (m) return `${m[1]} ${m[2].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} ${upperPlace(m[3])}`;
  // USGS: "45 km SSW of Ruteng, Indonesia"
  m = s.match(/^(\d+ km) ([NSEW]{1,3}) of (.+?)(, Indonesia)?$/);
  if (m && DIRS[m[2]]) return `${m[1]} ${DIRS[m[2]]} ${m[3]}`;
  return fixDir(s.replace(/, Indonesia$/, ''));
}

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'arkus-quake-dashboard/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const cache = readJson(CACHE, {});
const tried = new Map(); // eventId -> last failed attempt
let bmkg = { at: 0, list: [] };
let busy = false;

function save(eventId, place) {
  cache[eventId] = place;
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
}

async function bmkgEvents() {
  if (Date.now() - bmkg.at < 5 * 60 * 1000) return bmkg.list;
  const list = [];
  for (const url of BMKG) {
    try {
      const g = (await getJson(url)).Infogempa.gempa;
      for (const e of Array.isArray(g) ? g : [g]) {
        const [lat, lon] = String(e.Coordinates).split(',').map(Number);
        list.push({ lat, lon, timeMs: Date.parse(e.DateTime), place: e.Wilayah });
      }
    } catch { /* one feed down is fine */ }
  }
  bmkg = { at: Date.now(), list };
  return list;
}

const fixtures = () => fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(FIXTURES, f), null)).filter(Boolean);

async function lookup(r) {
  const lat = r.latE4 / 1e4, lon = r.lonE4 / 1e4, t = r.occurredAt * 1000;
  const snap = readJson(path.join(SNAPSHOTS, `${r.eventId}.json`), null);
  if (snap && snap.place) return snap.place;
  if (r.simulated) {
    const f = fixtures().find((x) => x.bmkg && Math.abs(x.bmkg.lat - lat) < 1e-3 && Math.abs(x.bmkg.lon - lon) < 1e-3);
    return f ? f.bmkg.place : '';
  }
  // report location is BMKG's own coordinates, report time is USGS's (seconds to minutes apart)
  const hit = (await bmkgEvents()).find((e) => Math.abs(e.lat - lat) < 1e-3 && Math.abs(e.lon - lon) < 1e-3 && Math.abs(e.timeMs - t) < 10 * 60 * 1000);
  if (hit) return hit.place;
  const q = new URLSearchParams({ format: 'geojson', starttime: new Date(t - 180e3).toISOString(), endtime: new Date(t + 180e3).toISOString(),
    latitude: String(lat), longitude: String(lon), maxradiuskm: '150' });
  const f = ((await getJson('https://earthquake.usgs.gov/fdsnws/event/1/query?' + q)).features || [])[0];
  return f ? f.properties.place : '';
}

/** Fill in missing places in the background (one lookup pass at a time). */
async function resolve(reports) {
  if (busy) return;
  busy = true;
  try {
    for (const r of reports) {
      if (cache[r.eventId] || Date.now() - (tried.get(r.eventId) || 0) < RETRY_MS) continue;
      try {
        const place = formatPlace(await lookup(r));
        if (place) save(r.eventId, place); else tried.set(r.eventId, Date.now());
      } catch { tried.set(r.eventId, Date.now()); }
    }
  } finally { busy = false; }
}

const placeOf = (eventId) => cache[eventId] || null;

module.exports = { formatPlace, resolve, placeOf };
