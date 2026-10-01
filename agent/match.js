// Deterministic cross-check of BMKG vs USGS, report building, and independent attester verification.
// No LLM in this path: every rule here is a plain, testable threshold.
'use strict';
const { ethers } = require('ethers');

const DEFAULTS = {
  maxTimeDiffSec: 120,   // BMKG vs USGS origin time
  maxDistKm: 150,        // BMKG vs USGS epicentre (agencies often differ by tens of km)
  maxMagDiff: 0.7,       // BMKG often reports a different magnitude type
  minMag: 4.0,           // contract MIN_POLICY_MAG_X10 = 40
  minAgeMin: 20,         // let automatic solutions settle before reporting
  maxAgeSec: 6 * 86400,  // contract MAX_REPORT_AGE = 7 days, keep 1 day margin
  // attester tolerances when checking someone else's proposal
  verifyMagTolX10: 2,
  verifyDistKm: 30,
  verifyTimeSec: 10,
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const E4 = (deg) => Math.round(deg * 1e4);
const eventIdFor = (usgsId) => ethers.id('USGS:' + usgsId);

/**
 * Pair every USGS event with the closest-in-time BMKG event that agrees on time, place and size.
 * An event seen by only one agency is NOT reported (needs two independent sources).
 */
function crossCheck(bmkg, usgs, nowMs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = { matched: [], rejected: [] };
  for (const u of usgs) {
    const ageSec = (nowMs - u.timeMs) / 1000;
    if (u.mag < o.minMag) continue;
    if (ageSec < o.minAgeMin * 60) { out.rejected.push({ usgs: u, reason: 'too fresh, waiting for solutions to settle' }); continue; }
    if (ageSec > o.maxAgeSec) continue;
    let best = null;
    for (const b of bmkg) {
      const dt = Math.abs(b.timeMs - u.timeMs) / 1000;
      if (dt > o.maxTimeDiffSec) continue;
      const dist = haversineKm(b.lat, b.lon, u.lat, u.lon);
      if (dist > o.maxDistKm) continue;
      if (Math.abs(b.mag - u.mag) > o.maxMagDiff + 1e-9) continue;
      if (!best || dt < best.dt) best = { b, dt, dist };
    }
    if (best) out.matched.push({ usgs: u, bmkg: best.b, dtSec: best.dt, distKm: best.dist });
    else out.rejected.push({ usgs: u, reason: 'no agreeing BMKG event' });
  }
  return out;
}

/** Canonical snapshot of the two source records. Its hash goes on-chain as the audit trail. */
function sourcesSnapshot(pair) {
  const pick = (e) => ({ source: e.source, id: e.id, timeMs: e.timeMs, lat: e.lat, lon: e.lon, depthKm: e.depthKm, mag: e.mag });
  return { bmkg: pick(pair.bmkg), usgs: pick(pair.usgs) };
}

/**
 * Report rules (conservative, protects the pool):
 *  - magnitude = the LOWER of the two agencies, rounded down to 0.1
 *  - location/depth = BMKG (official Indonesian authority)
 *  - time = USGS origin time (second precision)
 *  - eventId = keccak256("USGS:" + usgsId)
 */
function buildReport(pair) {
  const snapshot = sourcesSnapshot(pair);
  return {
    report: {
      eventId: eventIdFor(pair.usgs.id),
      magX10: Math.floor(Math.min(pair.bmkg.mag, pair.usgs.mag) * 10 + 1e-9),
      latE4: E4(pair.bmkg.lat),
      lonE4: E4(pair.bmkg.lon),
      depthKm: pair.bmkg.depthKm,
      occurredAt: Math.floor(pair.usgs.timeMs / 1000),
      sourcesHash: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(snapshot))),
      simulated: false,
    },
    snapshot,
  };
}

/**
 * An attester never signs blindly: it rebuilds the report from ITS OWN fetch of BMKG + USGS and
 * only signs if the proposal is within tolerance and never inflates the magnitude.
 * Returns { ok, reason }.
 */
function verifyProposal(report, ownMatched, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (report.simulated) return { ok: false, reason: 'simulated report must go through verifyReplay' };
  const mine = ownMatched.find((p) => eventIdFor(p.usgs.id) === report.eventId);
  if (!mine) return { ok: false, reason: 'event not confirmed by my own BMKG+USGS cross-check' };
  const own = buildReport(mine).report;
  if (report.magX10 > own.magX10 + 1) return { ok: false, reason: `magnitude inflated (${report.magX10} vs mine ${own.magX10})` };
  if (Math.abs(report.magX10 - own.magX10) > o.verifyMagTolX10) return { ok: false, reason: 'magnitude differs too much' };
  if (Math.abs(report.occurredAt - own.occurredAt) > o.verifyTimeSec) return { ok: false, reason: 'origin time differs' };
  const d = haversineKm(report.latE4 / 1e4, report.lonE4 / 1e4, own.latE4 / 1e4, own.lonE4 / 1e4);
  if (d > o.verifyDistKm) return { ok: false, reason: `location differs by ${d.toFixed(0)} km` };
  return { ok: true, reason: 'consistent with my own sources' };
}

/** Replay of a historical quake (testnet demo): same physics, time shifted to "now". */
function buildReplay(fixture, nowSec) {
  const pair = { bmkg: fixture.bmkg, usgs: fixture.usgs };
  const { report, snapshot } = buildReport(pair);
  return {
    report: {
      ...report,
      eventId: ethers.id(`REPLAY:${fixture.name}:${nowSec}`),
      occurredAt: nowSec,
      simulated: true,
    },
    snapshot: { ...snapshot, replayOf: fixture.name, note: fixture.note },
  };
}

function verifyReplay(report, fixture) {
  if (!report.simulated) return { ok: false, reason: 'not a replay' };
  const own = buildReport({ bmkg: fixture.bmkg, usgs: fixture.usgs }).report;
  if (report.magX10 !== own.magX10 || report.latE4 !== own.latE4 || report.lonE4 !== own.lonE4) {
    return { ok: false, reason: 'replay does not match the historical record' };
  }
  return { ok: true, reason: 'matches historical record' };
}

module.exports = { DEFAULTS, haversineKm, crossCheck, buildReport, verifyProposal, buildReplay, verifyReplay, eventIdFor, E4 };
