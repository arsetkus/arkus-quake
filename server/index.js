#!/usr/bin/env node
// One process runs everything, so all transactions share one relayer nonce sequence:
//   - oracle agent loop (BMKG+USGS -> attesters -> submit -> keeper)
//   - public dashboard + JSON API
//   - demo replay endpoint (rate limited)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const agent = require('../agent/index');
const chain = require('../agent/chain');
const { seedPolicies, readLabels, writeLabels, ensureBalance, DEMO_POLICIES, E } = require('../scripts/demo');
const usdtJ = require('../build/MockUSDT.json');

const PORT = parseInt(process.env.PORT || '3000', 10);
const POLL = agent.cfg.pollSec;
const REPLAY_COOLDOWN = parseInt(process.env.REPLAY_COOLDOWN_SECONDS || '300', 10);
const WEB = path.join(__dirname, '..', 'web');
const EXPLORER = 'https://testnet.bscscan.com';
// read-only RPC the browser uses before a wallet is connected (never expose RPC_URL: it may carry an API key)
const PUBLIC_RPC = process.env.PUBLIC_RPC_URL || 'https://bsc-testnet-rpc.publicnode.com';
const CHAIN = { name: 'BNB Smart Chain Testnet', chainId: 97, explorer: EXPLORER, rpc: PUBLIC_RPC };
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// ---------------------------------------------------------------- tx serialisation
let queue = Promise.resolve();
const serial = (fn) => {
  const p = queue.then(fn, fn);
  queue = p.catch(() => { try { agent.connect().relayer.reset(); } catch {} }); // resync nonce after a failed tx
  return p;
};

// ---------------------------------------------------------------- agent loop
const agentState = { startedAt: Date.now(), lastCycleAt: null, lastOk: null, lastError: null, lastResult: null };
async function loop() {
  try {
    agentState.lastResult = await serial(() => agent.cycle());
    agentState.lastOk = Date.now();
    agentState.lastError = null;
  } catch (e) {
    agentState.lastError = e.shortMessage || e.message;
    log('cycle error:', agentState.lastError);
  }
  agentState.lastCycleAt = Date.now();
  setTimeout(loop, POLL * 1000);
}

// ---------------------------------------------------------------- replay (demo)
const replay = { running: false, stage: 'idle', lastAt: 0, eventId: null, tx: null, error: null, claimsAt: null };
const REPLAY_TARGETS = ['Warga Padang', 'Warga Pariaman', 'Warga Painan', 'Warga Bukittinggi', 'Warga Tuapejat (Mentawai)'];

async function runReplay() {
  const { pool, relayer, index } = agent.connect();
  replay.running = true; replay.error = null; replay.eventId = null; replay.tx = null; replay.lastAt = Date.now();
  try {
    replay.stage = 'seeding';
    await index.sync();
    const labels = readLabels();
    const activeLabels = new Set([...index.policies.values()].filter((p) => p.status === 'active').map((p) => labels[p.id]));
    const missing = REPLAY_TARGETS.filter((l) => !activeLabels.has(l)); // replace only what the last demo paid out
    if (missing.length) {
      const token = new ethers.Contract(await pool.asset(), usdtJ.abi, relayer);
      // public users may have reserved most of the pool: top it up from the testnet faucet first
      const need = DEMO_POLICIES.filter((p) => missing.includes(p.label)).reduce((s, p) => s + E(p.coverage), 0n);
      const free = await pool.freeLiquidity();
      if (free < need) {
        const topUp = need - free + E(1000);
        await serial(async () => { await ensureBalance(token, relayer, await pool.getAddress(), topUp); await (await pool.deposit(topUp)).wait(); });
        log(`topped up pool liquidity by ${ethers.formatEther(topUp)} mUSDT for the demo`);
      }
      await serial(() => seedPolicies(pool, token, relayer, { only: missing }));
      log('re-seeded West Sumatra policies for the next demo');
    }
    replay.stage = 'signing';
    const res = await serial(() => agent.replay('padang-2009'));
    replay.eventId = res.eventId; replay.tx = res.tx;
    const cw = Number(await pool.challengeWindow());
    replay.claimsAt = Date.now() + cw * 1000;
    replay.stage = 'challenge';
    await new Promise((r) => setTimeout(r, (cw + 8) * 1000));
    replay.stage = 'paying';
    // the agent loop's keeper may pay first; either way, done = this event has payouts on-chain
    const paidCount = async () => { await index.sync(); return (index.reports.get(res.eventId) || {}).paidCount || 0; };
    let paid = await paidCount();
    for (let i = 0; i < 4 && paid === 0; i++) { // block time vs wall clock: retry a few times
      await serial(() => chain.runKeeper(pool, { index, log }));
      paid = await paidCount();
      if (!paid) await new Promise((r) => setTimeout(r, 10000));
    }
    replay.stage = 'done';
    if (!paid) replay.error = 'Belum ada polis yang terbayar. Keeper akan mencoba lagi di siklus oracle berikutnya.';
  } catch (e) {
    replay.error = e.shortMessage || e.message;
    replay.stage = 'error';
    log('replay error:', replay.error);
  } finally {
    replay.running = false;
  }
}

// ---------------------------------------------------------------- status
let cache = { at: 0, body: null };
const fmt = (v) => Number(ethers.formatEther(v));

async function buildStatus() {
  if (Date.now() - cache.at < 8000 && cache.body) return cache.body;
  const { pool, index, relayer, provider } = agent.connect();
  await index.sync();
  const [totalAssets, reserved, cw, threshold, attesterCount, lockUntil, gas, waiting] = await Promise.all([
    pool.totalAssets(), pool.reservedCoverage(), pool.challengeWindow(), pool.threshold(), pool.attesterCount(),
    pool.withdrawLockedUntil(), provider.getBalance(relayer.address), pool.waitingPeriod(),
  ]);
  const labels = readLabels();
  const policies = [...index.policies.values()].map((p) => ({
    id: p.id, label: labels[p.id] || null, lat: p.latE4 / 1e4, lon: p.lonE4 / 1e4, radiusKm: p.radiusKm,
    minMag: p.minMagX10 / 10, coverage: fmt(p.coverage), premium: fmt(p.premium), status: p.status,
    beneficiary: p.beneficiary, sponsor: p.sponsor, end: p.end, boughtAt: p.boughtAt, tx: p.tx,
    paidEvent: p.paidEvent || null, paidTx: p.paidTx || null, paidAt: p.paidAt || null,
  })).sort((a, b) => Number(b.id) - Number(a.id));
  const reports = [...index.reports.values()].map((r) => ({
    eventId: r.eventId, mag: r.magX10 / 10, lat: r.latE4 / 1e4, lon: r.lonE4 / 1e4, occurredAt: r.occurredAt,
    reportedAt: r.reportedAt, claimsOpenAt: r.reportedAt + Number(cw), simulated: r.simulated, vetoed: r.vetoed,
    sourcesHash: r.sourcesHash, tx: r.tx, paidCount: r.paidCount, paidAmount: fmt(r.paidAmount),
  })).sort((a, b) => b.reportedAt - a.reportedAt);
  const paidTotal = policies.filter((p) => p.status === 'paid').reduce((s, p) => s + p.coverage, 0);
  cache = {
    at: Date.now(),
    body: {
      now: Math.floor(Date.now() / 1000),
      chain: CHAIN,
      pool: {
        address: await pool.getAddress(), asset: await pool.asset(), totalAssets: fmt(totalAssets), reserved: fmt(reserved),
        free: fmt(totalAssets > reserved ? totalAssets - reserved : 0n), challengeWindow: Number(cw), threshold: Number(threshold),
        waitingPeriod: Number(waiting),
        attesterCount: Number(attesterCount), withdrawLockedUntil: Number(lockUntil),
        lpDeposited: fmt(index.lp.deposited),
      },
      totals: { policies: policies.length, active: policies.filter((p) => p.status === 'active').length, paid: paidTotal, reports: reports.length },
      relayer: { address: relayer.address, gasBnb: Number(ethers.formatEther(gas)) },
      agent: { ...agentState, pollSeconds: POLL },
      replay: { ...replay, cooldownSeconds: REPLAY_COOLDOWN, nextAllowedAt: replay.lastAt + REPLAY_COOLDOWN * 1000 },
      policies,
      reports,
    },
  };
  return cache.body;
}

// ---------------------------------------------------------------- setup mode (contracts not deployed yet)
const SETUP = !agent.cfg.pool;
async function setupStatus() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  const out = { setup: true, chain: CHAIN, relayer: null };
  if (env.RELAYER_KEY) {
    const address = new ethers.Wallet(env.RELAYER_KEY).address;
    let gasBnb = null;
    try { gasBnb = Number(ethers.formatEther(await new ethers.JsonRpcProvider(agent.cfg.rpc).getBalance(address))); } catch {}
    out.relayer = { address, gasBnb };
  }
  return out;
}

// ---------------------------------------------------------------- policy labels (sponsor-signed)
// Labels live off-chain (data/labels.json). Only the policy's sponsor may set one, once, proven by
// signing labelMessage() with the sponsoring wallet.
const labelMessage = (id, label) => `ARKUS: beri nama polis #${id}: ${label}`;
const DEMO_LABELS = new Set(DEMO_POLICIES.map((p) => p.label.toLowerCase()));

function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

async function setLabel(body) {
  const id = String(body.id || '');
  // normalised exactly like the browser does before signing, so the signature still matches
  const label = String(body.label || '').replace(/\s+/g, ' ').trim();
  if (!/^\d{1,9}$/.test(id)) return [400, 'id tidak valid'];
  if (label.length < 3 || label.length > 40) return [400, 'Nama 3 sampai 40 karakter'];
  if (/[\u0000-\u001f\u007f<>]/.test(label)) return [400, 'Nama tidak boleh berisi < atau >'];
  if (DEMO_LABELS.has(label.toLowerCase())) return [400, 'Nama itu dipakai polis demo'];
  const { index } = agent.connect();
  await index.sync();
  const p = index.policies.get(id);
  if (!p) return [404, 'Polis belum terbaca, coba lagi sebentar'];
  let signer;
  try { signer = ethers.verifyMessage(labelMessage(id, label), String(body.signature || '')); } catch { return [400, 'Tanda tangan tidak valid'] }
  if (signer.toLowerCase() !== p.sponsor.toLowerCase()) return [403, 'Hanya sponsor polis yang bisa memberi nama'];
  const labels = readLabels();
  if (labels[id]) return [409, 'Polis ini sudah punya nama'];
  labels[id] = label;
  writeLabels(labels);
  cache.at = 0;
  return [200, { ok: true, id, label }];
}

// ---------------------------------------------------------------- http
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (SETUP && url.pathname === '/api/status') return send(res, 200, await setupStatus());
    if (SETUP && url.pathname === '/api/health') return send(res, 200, { ok: true, setup: true });
    if (SETUP && url.pathname.startsWith('/api/')) return send(res, 503, { error: 'Kontrak belum di-deploy' });
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const body = await buildStatus();
      return send(res, 200, { ...body, replay: { ...replay, cooldownSeconds: REPLAY_COOLDOWN, nextAllowedAt: replay.lastAt + REPLAY_COOLDOWN * 1000 } });
    }
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, agent: agentState });
    if (url.pathname === '/api/label' && req.method === 'POST') {
      const [code, out] = await setLabel(await readBody(req));
      return send(res, code, typeof out === 'string' ? { error: out } : out);
    }
    if (url.pathname === '/api/replay' && req.method === 'POST') {
      if (replay.running) return send(res, 409, { error: 'Simulasi sedang berjalan' });
      const wait = replay.lastAt + REPLAY_COOLDOWN * 1000 - Date.now();
      if (wait > 0) return send(res, 429, { error: `Tunggu ${Math.ceil(wait / 1000)} detik lagi`, retryAfter: Math.ceil(wait / 1000) });
      runReplay(); cache.at = 0;
      return send(res, 202, { started: true });
    }
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(WEB, file);
    if (!full.startsWith(WEB) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, { error: 'not found' });
    return send(res, 200, fs.readFileSync(full), TYPES[path.extname(full)] || 'application/octet-stream');
  } catch (e) {
    log('http error', e.message);
    return send(res, 500, { error: e.shortMessage || e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  if (SETUP) return log(`SETUP MODE on http://127.0.0.1:${PORT}: POOL_ADDRESS empty, run scripts/deploy.js after funding the relayer`);
  log(`dashboard on http://127.0.0.1:${PORT}, agent polling every ${POLL}s`);
  loop();
});
