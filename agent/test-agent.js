// Oracle agent tests: pure cross-check rules + end-to-end on a local chain.
// Run: node compile.js && node agent/test-agent.js
'use strict';
const assert = require('assert');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { parseBmkgPayload, parseUsgsPayload } = require('./sources');
const M = require('./match');
const chain = require('./chain');
const { collectSignatures } = require('./index');
const poolJ = require('../build/ParametricQuakePool.json');
const usdtJ = require('../build/MockUSDT.json');
const padang2009 = require('./fixtures/padang-2009.json');

let passed = 0;
const ok = (n) => { passed++; console.log('  ok  -', n); };
const E = (n) => ethers.parseEther(String(n));

// Payload shapes as served by data.bmkg.go.id and earthquake.usgs.gov (values synthetic)
const NOW = Date.parse('2026-10-01T06:00:00Z');
const bmkgPayload = { Infogempa: { gempa: [
  { Tanggal: '01 Okt 2026', Jam: '12:00:05 WIB', DateTime: '2026-10-01T05:00:05+00:00', Coordinates: '-1.05,99.90', Lintang: '1.05 LS', Bujur: '99.90 BT', Magnitude: '6.4', Kedalaman: '30 km', Wilayah: '45 km BaratDaya PADANG-SUMBAR', Potensi: 'Tidak berpotensi tsunami' },
  { Tanggal: '01 Okt 2026', Jam: '11:30:00 WIB', DateTime: '2026-10-01T04:30:00+00:00', Coordinates: '-8.50,118.00', Lintang: '8.50 LS', Bujur: '118.00 BT', Magnitude: '5.1', Kedalaman: '10 km', Wilayah: 'NTB' },
] } };
const usgsPayload = { features: [
  { id: 'us7000test1', properties: { mag: 6.2, time: Date.parse('2026-10-01T05:00:01Z'), place: 'Kepulauan Mentawai region', status: 'automatic' }, geometry: { coordinates: [99.80, -1.10, 25.3] } },
  { id: 'us7000test2', properties: { mag: 6.0, time: Date.parse('2026-10-01T05:20:00Z'), place: 'Banda Sea', status: 'automatic' }, geometry: { coordinates: [128.0, -6.0, 100] } },
  { id: 'us7000fresh', properties: { mag: 5.5, time: NOW - 5 * 60e3, place: 'fresh', status: 'automatic' }, geometry: { coordinates: [100, -1, 10] } },
] };

(async () => {
  console.log('\n[sources + cross-check]');
  const bmkg = parseBmkgPayload(bmkgPayload);
  const usgs = parseUsgsPayload(usgsPayload);
  assert.equal(bmkg.length, 2); assert.equal(bmkg[0].lat, -1.05); assert.equal(bmkg[0].depthKm, 30);
  assert.equal(usgs[0].lat, -1.10); assert.equal(usgs[0].lon, 99.80);
  assert.equal(parseBmkgPayload({ Infogempa: { gempa: bmkgPayload.Infogempa.gempa[0] } }).length, 1); // autogempa.json shape
  ok('BMKG (list + single object) and USGS payloads normalised');

  const res = M.crossCheck(bmkg, usgs, NOW);
  assert.equal(res.matched.length, 1);
  assert.equal(res.matched[0].usgs.id, 'us7000test1');
  assert(res.rejected.find((r) => r.usgs.id === 'us7000test2' && /no agreeing BMKG/.test(r.reason)));
  assert(res.rejected.find((r) => r.usgs.id === 'us7000fresh' && /too fresh/.test(r.reason)));
  ok('only the quake seen by BOTH agencies is confirmed; single-source and too-fresh events are held back');

  const bigMagGap = M.crossCheck(bmkg, [{ ...usgs[0], mag: 7.5 }], NOW);
  assert.equal(bigMagGap.matched.length, 0);
  ok('agencies disagreeing by > 0.7 magnitude -> not reported');

  const { report } = M.buildReport(res.matched[0]);
  assert.equal(report.magX10, 62);            // min(6.4, 6.2)
  assert.equal(report.latE4, -10500);         // BMKG location
  assert.equal(report.occurredAt, Math.floor(Date.parse('2026-10-01T05:00:01Z') / 1000));
  assert.equal(report.eventId, ethers.id('USGS:us7000test1'));
  ok('report uses the lower magnitude, BMKG location, USGS time');

  assert.equal(M.verifyProposal(report, res.matched).ok, true);
  const inflated = M.verifyProposal({ ...report, magX10: 70 }, res.matched);
  assert.equal(inflated.ok, false); assert(/inflated/.test(inflated.reason));
  assert.equal(M.verifyProposal({ ...report, latE4: report.latE4 + 5000 }, res.matched).ok, false);
  assert.equal(M.verifyProposal({ ...report, eventId: ethers.id('USGS:made-up') }, res.matched).ok, false);
  ok('attester refuses inflated magnitude, moved epicentre, and events it cannot see itself');

  console.log('\n[end-to-end on local chain]');
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, wallet: { deterministic: true, totalAccounts: 5 } }));
  const [owner, lp, sponsor, keeper] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const warp = async (s) => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
  const attesters = [0, 1, 2].map(() => ethers.Wallet.createRandom());
  const deploy = async (j, args) => { const c = await new ethers.ContractFactory(j.abi, j.bytecode, owner).deploy(...args); await c.waitForDeployment(); return c; };
  const token = await deploy(usdtJ, []);
  const poolC = await deploy(poolJ, [await token.getAddress(), 0, 600, true, attesters.map((a) => a.address), 2]);
  const pa = await poolC.getAddress();
  for (const s of [lp, sponsor]) {
    for (let i = 0; i < 2; i++) await (await token.connect(s).faucet(E(10000))).wait();
    await (await token.connect(s).approve(pa, ethers.MaxUint256)).wait();
  }
  const pool = chain.poolAt(pa, keeper); // keeper/relayer is just some account, no special rights
  await (await poolC.connect(lp).deposit(E(20000))).wait();

  const beneficiaries = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
  const DAY = 86400;
  // sponsor (e.g. Pemda / CSR) buys for residents who have no wallet of their own
  await (await poolC.connect(sponsor).buyPolicy(beneficiaries[0], M.E4(-0.9492), M.E4(100.3543), 100, 70, E(1000), 30 * DAY)).wait(); // Padang
  await (await poolC.connect(sponsor).buyPolicy(beneficiaries[1], M.E4(-0.6265), M.E4(100.1180), 75, 70, E(1000), 30 * DAY)).wait();  // Pariaman
  await (await poolC.connect(sponsor).buyPolicy(beneficiaries[2], M.E4(-6.2088), M.E4(106.8456), 100, 70, E(1000), 30 * DAY)).wait(); // Jakarta
  ok('sponsor bought 3 policies for wallet-less beneficiaries');

  // malicious proposer inflates the replay -> honest attesters refuse -> nothing on-chain
  const nowSec = (await provider.getBlock('latest')).timestamp;
  const honest = M.buildReplay(padang2009, nowSec).report;
  const forged = { ...honest, magX10: 85 };
  await assert.rejects(collectSignatures(pool, attesters, forged, async () => M.verifyReplay(forged, padang2009)), /0\/2 attesters signed/);
  ok('forged report (M8.5) gets 0 signatures');

  const sigs = await collectSignatures(pool, attesters, honest, async () => M.verifyReplay(honest, padang2009));
  await chain.submitReport(pool, honest, sigs);
  ok('replay of Padang 2009 signed 3/3 and submitted by an ordinary relayer');

  let k = await chain.runKeeper(pool, { log: () => {} });
  assert.equal(k.paid, 0);
  ok('keeper waits during challenge window');
  await warp(601);
  k = await chain.runKeeper(pool, { log: (m) => console.log('   ', m.trim()) });
  assert.equal(k.paid, 2);
  assert.equal(await token.balanceOf(beneficiaries[0]), E(1000));
  assert.equal(await token.balanceOf(beneficiaries[1]), E(1000));
  assert.equal(await token.balanceOf(beneficiaries[2]), 0n);
  ok('keeper paid Padang + Pariaman automatically, Jakarta not');
  k = await chain.runKeeper(pool, { log: () => {} });
  assert.equal(k.paid, 0);
  ok('keeper re-run is idempotent (no double payout)');

  console.log('\n[index survives restarts and RPC log pruning]');
  const live = await new chain.PoolIndex(pool).sync();
  const view = (ix) => JSON.stringify([[...ix.policies.values()].map((p) => [p.id, p.status, p.paidEvent || null, p.beneficiary]).sort(),
    [...ix.reports.values()].map((r) => [r.eventId, r.paidCount, String(r.paidAmount)]), String(ix.lp.deposited)]);
  // the explorer answers in Etherscan's format (hex strings); the RPC "forgets" everything before head
  const allLogs = await provider.getLogs({ address: pa, fromBlock: 0, toBlock: 'latest' });
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const q = new URL(url).searchParams;
    const page = allLogs.filter((l) => l.blockNumber >= +q.get('fromBlock') && l.blockNumber <= +q.get('toBlock'));
    const result = await Promise.all(page.map(async (l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: '0x' + l.blockNumber.toString(16),
      timeStamp: '0x' + (await provider.getBlock(l.blockNumber)).timestamp.toString(16), transactionHash: l.transactionHash, logIndex: '0x' + l.index.toString(16) })));
    return { json: async () => (result.length ? { status: '1', message: 'OK', result } : { status: '0', message: 'No records found', result: [] }) };
  };
  for (let i = 0; i < 205; i++) await provider.send('evm_mine', []); // explorer covers up to head - 200
  const head = await provider.getBlockNumber();
  const prunedRpc = { getLogs: async (f) => (f.fromBlock < head - 200 ? [] : provider.getLogs(f)), getBlock: (n) => provider.getBlock(n), send: (m, p) => provider.send(m, p) };
  const prunedPool = chain.poolAt(pa, keeper); Object.defineProperty(prunedPool.runner, 'provider', { value: prunedRpc, configurable: true });
  const file = require('path').join(require('os').tmpdir(), `arkus-index-${Date.now()}.json`);
  try {
    const blind = await new chain.PoolIndex(prunedPool).sync();
    assert.equal(blind.policies.size, 0); // what happened on the VPS after a restart
    const fresh = await new chain.PoolIndex(prunedPool, { file, explorer: chain.etherscanLogs({ apiKey: 'test' }) }).sync();
    assert.equal(view(fresh), view(live));
    ok('fresh index backfills history from the explorer when the RPC pruned old logs');
    const restarted = new chain.PoolIndex(prunedPool, { file });
    assert.equal(restarted.restored, true);
    assert.equal(view(await restarted.sync()), view(live));
    ok('restart resumes from the saved index file (no history scan, nothing lost)');
  } finally {
    global.fetch = realFetch;
    try { require('fs').unlinkSync(file); } catch {}
  }

  console.log(`\nALL ${passed} AGENT CHECKS PASSED`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
