// Fetch + normalise earthquake feeds from BMKG (official Indonesian agency) and USGS.
// Normalised event: { source, id, timeMs, lat, lon, depthKm, mag, place, status }
'use strict';

const BMKG_FEEDS = [
  'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json',      // latest M5+ event
  'https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json',   // last 15 M5+ events
  'https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json', // last 15 felt events (can be < M5)
];

// Indonesia policy box (12S..7N, 95E..142E) widened by ~3 deg so quakes just outside
// the box that can still hit a 300 km radius are seen.
const USGS_BOX = { minlatitude: -15, maxlatitude: 10, minlongitude: 92, maxlongitude: 145 };

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'arkus-quake-oracle/0.1' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function num(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error('not a number: ' + v);
  return n;
}

/** BMKG record -> normalised event. Pure, unit-tested with fixtures. */
function normalizeBmkg(g) {
  const [lat, lon] = String(g.Coordinates).split(',').map(num);
  const timeMs = Date.parse(g.DateTime); // ISO with +00:00
  if (!Number.isFinite(timeMs)) throw new Error('bad BMKG DateTime: ' + g.DateTime);
  return {
    source: 'BMKG',
    id: `${g.DateTime}|${g.Coordinates}`, // BMKG has no event id; time+coords is unique
    timeMs,
    lat,
    lon,
    depthKm: Math.round(num(String(g.Kedalaman).replace(/km/i, '').trim())),
    mag: num(g.Magnitude),
    place: g.Wilayah || '',
    status: 'official',
  };
}

function parseBmkgPayload(json) {
  const g = json && json.Infogempa && json.Infogempa.gempa;
  if (!g) return [];
  return (Array.isArray(g) ? g : [g]).map(normalizeBmkg);
}

/** USGS GeoJSON feature -> normalised event. Pure. */
function normalizeUsgs(f) {
  const [lon, lat, depth] = f.geometry.coordinates;
  return {
    source: 'USGS',
    id: f.id,
    timeMs: f.properties.time,
    lat,
    lon,
    depthKm: Math.max(0, Math.round(depth)),
    mag: f.properties.mag,
    place: f.properties.place || '',
    status: f.properties.status || 'automatic',
  };
}

function parseUsgsPayload(json) {
  return ((json && json.features) || []).filter((f) => f && f.geometry && f.properties && f.properties.mag != null).map(normalizeUsgs);
}

async function fetchBmkg() {
  const all = [];
  const errors = [];
  for (const url of BMKG_FEEDS) {
    try { all.push(...parseBmkgPayload(await getJson(url))); } catch (e) { errors.push(e.message); }
  }
  if (all.length === 0 && errors.length) throw new Error('BMKG unreachable: ' + errors.join('; '));
  const seen = new Map();
  for (const e of all) seen.set(e.id, e); // feeds overlap
  return [...seen.values()];
}

async function fetchUsgs({ sinceMs, minMag }) {
  const q = new URLSearchParams({
    format: 'geojson',
    starttime: new Date(sinceMs).toISOString(),
    minmagnitude: String(minMag),
    orderby: 'time',
    ...Object.fromEntries(Object.entries(USGS_BOX).map(([k, v]) => [k, String(v)])),
  });
  return parseUsgsPayload(await getJson('https://earthquake.usgs.gov/fdsnws/event/1/query?' + q));
}

module.exports = { fetchBmkg, fetchUsgs, normalizeBmkg, normalizeUsgs, parseBmkgPayload, parseUsgsPayload, BMKG_FEEDS };
