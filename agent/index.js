#!/usr/bin/env node
// ARKUS quake oracle agent.
//   node agent/index.js once            one cycle: fetch BMKG+USGS -> cross-check -> sign -> submit -> keeper
//   node agent/index.js watch           loop forever (POLL_SECONDS)
//   node agent/index.js dry             fetch + cross-check only, prints what WOULD be reported (no keys needed)
//   node agent/index.js replay padang-2009   submit a simulated historical quake (demo pool only)
//   node agent/index.js keeper          only pay eligible policies
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { fetchBmkg, fetchUsgs } = require('./sources');
const { crossCheck, buildReport, verifyProposal, buildReplay, verifyReplay, DEFAULTS } = require('./match');
const chain = require('./chain');

// ---- tiny .env loader (no extra dependency)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const cfg = {
  rpc: env('RPC_URL', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'),
  pool: env('POOL_ADDRESS'),
  relayerKey: env('RELAYER_KEY'),
  attesterKeys: env('ATTESTER_KEYS', '').split(',').map((s) => s.trim()).filter(Boolean),
  fromBlock: parseInt(env('START_BLOCK', '0'), 10),
  pollSec: parseInt(env('POLL_SECONDS', '120'), 10),
  minMag: parseFloat(env('MIN_MAG', String(DEFAULTS.minMag))),
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dataDir = path.join(__dirname, 'data');

let conn = null;
function connect() {
  if (conn) return conn;
  if (!cfg.pool || !cfg.relayerKey) throw new Error('Set POOL_ADDRESS and RELAYER_KEY in .env');
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const wallet = new ethers.Wallet(cfg.relayerKey, provider);
  // local nonce tracking: public BSC RPCs are load-balanced and can return a stale pending nonce
  const relayer = new ethers.NonceManager(wallet);
  relayer.address = wallet.address;
  const attesters = cfg.attesterKeys.map((k) => new ethers.Wallet(k));
  const pool = chain.poolAt(cfg.pool, relayer);
  // the index is saved to disk (restarts resume where they left off); a fresh one backfills from the explorer
  const apiKey = env('BSCSCAN_API_KEY');
  if (!apiKey) log('note: BSCSCAN_API_KEY not set; a fresh index relies on the RPC, which keeps only recent logs');
  const index = new chain.PoolIndex(pool, {
    fromBlock: cfg.fromBlock, log,
    file: path.join(__dirname, '..', 'data', `index-${cfg.pool.toLowerCase()}.json`),
    explorer: apiKey ? chain.etherscanLogs({ apiKey, chainId: parseInt(env('CHAIN_ID', '97'), 10) }) : null,
  });
  conn = { provider, relayer, attesters, pool, index };
  return conn;
}

function saveSnapshot(eventId, payload) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, `${eventId}.json`), JSON.stringify(payload, null, 2));
}

async function observe() {
  const nowMs = Date.now();
  const [bmkg, usgs] = await Promise.all([fetchBmkg(), fetchUsgs({ sinceMs: nowMs - 7 * 86400e3, minMag: cfg.minMag })]);
  const res = crossCheck(bmkg, usgs, nowMs, { minMag: cfg.minMag });
  log(`BMKG ${bmkg.length} events, USGS ${usgs.length} events -> ${res.matched.length} confirmed by both`);
  return res;
}

/**
 * Proposer builds the report; every attester independently re-checks it before signing.
 * Here all attester keys live in one process for the demo; the verify() call is the same code each
 * attester would run on its own server against its own fetch.
 */
async function collectSignatures(pool, attesters, report, verify) {
  const domain = await chain.domainFor(pool);
  const threshold = Number(await pool.threshold());
  const signed = [];
  for (const w of attesters) {
    const v = await verify(w);
    if (!v.ok) { log(`  attester ${w.address.slice(0, 8)} REFUSED: ${v.reason}`); continue; }
    if (!(await pool.isAttester(w.address))) { log(`  ${w.address.slice(0, 8)} is not a registered attester`); continue; }
    signed.push(await chain.signReport(w, domain, report));
  }
  if (signed.length < threshold) throw new Error(`only ${signed.length}/${threshold} attesters signed`);
  return chain.sortSignatures(signed);
}

async function cycle({ submit = true } = {}) {
  let proposerView = { matched: [], rejected: [] };
  try {
    proposerView = await observe();
  } catch (e) {
    if (!submit) throw e;
    log('sources unavailable this cycle:', e.message); // keeper below still runs
  }
  for (const r of proposerView.rejected) if (r.reason !== 'too fresh, waiting for solutions to settle') log(`  skip ${r.usgs.id} M${r.usgs.mag} ${r.usgs.place}: ${r.reason}`);
  if (!submit) {
    for (const p of proposerView.matched) {
      const { report } = buildReport(p);
      log(`  WOULD REPORT ${p.usgs.id}: M${report.magX10 / 10} at ${report.latE4 / 1e4},${report.lonE4 / 1e4} (${p.bmkg.place}) dt=${p.dtSec}s dist=${p.distKm.toFixed(0)}km`);
    }
    return { matched: proposerView.matched.length, submitted: 0, paid: 0 };
  }
  const { pool, attesters, index, relayer } = connect();
  let submitted = 0;
  for (const pair of proposerView.matched) {
    const { report, snapshot } = buildReport(pair);
    if (await chain.isReported(pool, report.eventId)) continue;
    log(`new event ${pair.usgs.id} M${report.magX10 / 10} ${pair.bmkg.place}`);
    try {
      // each attester takes its own look at the sources (separate fetch)
      const sigs = await collectSignatures(pool, attesters, report, async () => verifyProposal(report, (await observe()).matched));
      const rc = await chain.submitReport(pool, report, sigs);
      saveSnapshot(report.eventId, { report: { ...report }, snapshot, place: pair.bmkg.place, tx: rc.hash });
      log(`  submitted, tx ${rc.hash}`);
      submitted++;
    } catch (e) {
      log(`  not submitted: ${e.shortMessage || e.message}`);
      relayer.reset();
    }
  }
  const k = await chain.runKeeper(pool, { index, log });
  if (k.paid) log(`keeper: ${k.reports} reports, ${k.policies} policies, paid ${k.paid}`);
  return { matched: proposerView.matched.length, submitted, paid: k.paid };
}

async function replay(name) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
  const { pool, provider, attesters } = connect();
  if (!(await pool.allowSimulated())) throw new Error('this pool was deployed with allowSimulated=false');
  const nowSec = (await provider.getBlock('latest')).timestamp;
  const { report, snapshot } = buildReplay(fixture, nowSec);
  log(`REPLAY ${fixture.name}: M${report.magX10 / 10} at ${report.latE4 / 1e4},${report.lonE4 / 1e4}`);
  const sigs = await collectSignatures(pool, attesters, report, async () => verifyReplay(report, fixture));
  const rc = await chain.submitReport(pool, report, sigs);
  saveSnapshot(report.eventId, { report: { ...report }, snapshot, place: fixture.bmkg.place, tx: rc.hash });
  log(`  submitted, tx ${rc.hash}. Claims open after the challenge window (${await pool.challengeWindow()} s); then run: keeper`);
  return { eventId: report.eventId, tx: rc.hash, report };
}

async function main() {
  const [cmd = 'once', arg] = process.argv.slice(2);
  if (cmd === 'dry') return cycle({ submit: false });
  if (cmd === 'once') return cycle();
  if (cmd === 'replay') return replay(arg || 'padang-2009');
  if (cmd === 'keeper') {
    const { pool, index } = connect();
    const k = await chain.runKeeper(pool, { index, log });
    return log(`keeper: ${k.reports} reports, ${k.policies} policies, paid ${k.paid}`);
  }
  if (cmd === 'watch') {
    for (;;) {
      try { await cycle(); } catch (e) { log('cycle error:', e.message); }
      await new Promise((r) => setTimeout(r, cfg.pollSec * 1000));
    }
  }
  throw new Error('unknown command ' + cmd);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { cycle, replay, collectSignatures, connect, cfg };
