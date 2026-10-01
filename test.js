// End-to-end test + reference for the oracle agent's signing step.
// Run:  npm install && npm test
const ganache = require('ganache');
const { ethers } = require('ethers');
const assert = require('assert');
const pool = require('./build/ParametricQuakePool.json');
const usdt = require('./build/MockUSDT.json');

const E = (n) => ethers.parseEther(String(n));
const E4 = (deg) => Math.round(deg * 1e4);
let passed = 0;
const ok = (name) => { passed++; console.log('  ok  -', name); };

async function expectRevert(p, substr, name) {
  try { await p; } catch (e) {
    const text = [e.message, e.reason, e.shortMessage, JSON.stringify(e.info || {}), JSON.stringify(e.error || {})].join(' ');
    assert(text.includes(substr), `${name}: expected "${substr}" but got: ${text.slice(0, 300)}`);
    ok(name); return;
  }
  assert.fail(`${name}: expected revert "${substr}" but tx succeeded`);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = (d) => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

(async () => {
  const eth = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 6 } });
  const provider = new ethers.BrowserProvider(eth);
  const [owner, lp, sponsor, citizen, other] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));
  const warp = async (s) => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
  const nowTs = async () => parseInt((await provider.send('eth_getBlockByNumber', ['latest', false])).timestamp, 16);
  const chainId = (await provider.getNetwork()).chainId;

  const attesters = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
  const outsider = ethers.Wallet.createRandom();

  const deploy = async (j, signer, args) => { const f = new ethers.ContractFactory(j.abi, j.bytecode, signer); const c = await f.deploy(...args); await c.waitForDeployment(); return c; };
  const token = await deploy(usdt, owner, []);
  // Demo pool: no waiting period, 10 min challenge window, simulated replays allowed, 2-of-3 attesters
  const demo = await deploy(pool, owner, [await token.getAddress(), 0, 600, true, attesters.map((a) => a.address), 2]);
  // Strict pool: 3-day waiting period, simulations disabled
  const strict = await deploy(pool, owner, [await token.getAddress(), 3 * 86400, 600, false, attesters.map((a) => a.address), 2]);
  const demoAddr = await demo.getAddress();

  for (let i = 0; i < 11; i++) await (await token.connect(lp).faucet(E(10000))).wait(); // 110,000 for the LP
  for (const s of [lp, sponsor, citizen]) {
    if (s !== lp) await (await token.connect(s).faucet(E(10000))).wait();
    await (await token.connect(s).approve(demoAddr, ethers.MaxUint256)).wait();
    await (await token.connect(s).approve(await strict.getAddress(), ethers.MaxUint256)).wait();
  }

  const typedSign = async (contract, report, wallets) => {
    const domain = { name: 'ParametricQuakePool', version: '1', chainId, verifyingContract: await contract.getAddress() };
    const types = { QuakeReport: [
      { name: 'eventId', type: 'bytes32' }, { name: 'magX10', type: 'uint16' }, { name: 'latE4', type: 'int32' },
      { name: 'lonE4', type: 'int32' }, { name: 'depthKm', type: 'uint16' }, { name: 'occurredAt', type: 'uint64' },
      { name: 'sourcesHash', type: 'bytes32' }, { name: 'simulated', type: 'bool' }] };
    const sigs = [];
    for (const w of wallets) sigs.push({ addr: w.address, sig: await w.signTypedData(domain, types, report) });
    sigs.sort((a, b) => (BigInt(a.addr) < BigInt(b.addr) ? -1 : 1));
    return sigs.map((s) => s.sig);
  };

  console.log('\n[geometry] on-chain distance check vs haversine');
  // Padang city and the 30 Sep 2009 epicentre (approx 0.73 S, 99.87 E)
  const padang = [-0.9492, 100.3543], epi = [-0.725, 99.867];
  const refKm = haversineKm(...padang, ...epi);
  console.log('  reference haversine distance:', refKm.toFixed(1), 'km');
  assert(await demo.withinRadius(E4(padang[0]), E4(padang[1]), E4(epi[0]), E4(epi[1]), Math.ceil(refKm) + 2));
  assert(!(await demo.withinRadius(E4(padang[0]), E4(padang[1]), E4(epi[0]), E4(epi[1]), Math.floor(refKm) - 2)));
  ok('boundary within +-2 km of haversine');
  const jakarta = [-6.2088, 106.8456];
  const refJkt = haversineKm(...jakarta, ...epi);
  assert(!(await demo.withinRadius(E4(jakarta[0]), E4(jakarta[1]), E4(epi[0]), E4(epi[1]), 300)));
  ok('Jakarta (' + refJkt.toFixed(0) + ' km away) is outside a 300 km radius');

  console.log('\n[liquidity]');
  await (await demo.connect(lp).deposit(E(100000))).wait();
  assert.equal(await demo.freeLiquidity(), E(100000));
  ok('LP deposit of 100,000 mUSDT, all free');

  console.log('\n[policies]');
  const DAY = 86400;
  const q = await demo.quotePremium(70, 100, E(1000), 30 * DAY);
  console.log('  premium for 1,000 coverage / 30 days:', ethers.formatEther(q), 'mUSDT (placeholder pricing)');
  const buy = async (signer, who, lat, lon, radius, mag, cov, days) => {
    const tx = await demo.connect(signer).buyPolicy(who, E4(lat), E4(lon), radius, mag, E(cov), days * DAY);
    const rc = await tx.wait();
    return Number(rc.logs.map((l) => { try { return demo.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === 'PolicyBought').args.policyId);
  };
  const polA = await buy(sponsor, await citizen.getAddress(), ...padang, 100, 70, 1000, 30); // sponsored for citizen
  const polB = await buy(citizen, await citizen.getAddress(), ...jakarta, 100, 70, 1000, 30);
  const polC = await buy(citizen, await citizen.getAddress(), ...padang, 100, 80, 1000, 30); // needs M8.0+
  assert.equal(await demo.reservedCoverage(), E(3000));
  ok('3 policies bought (A sponsored by a third party), 3,000 reserved');
  await expectRevert(demo.connect(lp).withdraw(E(100000) - 1000n), 'funds reserved', 'cannot withdraw reserved collateral');
  await expectRevert(demo.connect(citizen).buyPolicy(await citizen.getAddress(), E4(40), E4(10), 50, 70, E(10), 30 * DAY), 'outside Indonesia', 'policy outside Indonesia box rejected');
  await expectRevert(demo.connect(citizen).buyPolicy(await citizen.getAddress(), E4(-1), E4(100), 50, 70, E(1_000_000), 30 * DAY), 'undercollateralized', 'coverage above pool collateral is rejected');

  console.log('\n[oracle report]');
  const t = await nowTs();
  const report = { eventId: ethers.id('SIM-PADANG-2009-M7.6'), magX10: 76, latE4: E4(epi[0]), lonE4: E4(epi[1]), depthKm: 81,
    occurredAt: t, sourcesHash: ethers.id('bmkg+usgs raw payloads'), simulated: true };
  await expectRevert(demo.submitReport(report, await typedSign(demo, report, [attesters[0]])), 'not enough signatures', '1 of 2 signatures rejected');
  await expectRevert(demo.submitReport(report, await typedSign(demo, report, [attesters[0], outsider])), 'not an attester', 'non-attester signature rejected');
  const dup = await typedSign(demo, report, [attesters[0]]);
  await expectRevert(demo.submitReport(report, [dup[0], dup[0]]), 'unsorted or duplicate', 'duplicate signer rejected');
  const tampered = { ...report, magX10: 90 };
  await expectRevert(demo.submitReport(tampered, await typedSign(demo, report, [attesters[0], attesters[1]])), 'not an attester', 'tampered report fails signature check');
  await expectRevert(strict.submitReport(report, await typedSign(strict, report, [attesters[0], attesters[1]])), 'simulation disabled', 'simulated report rejected on strict pool');
  await (await demo.submitReport(report, await typedSign(demo, report, [attesters[0], attesters[2]]))).wait();
  ok('valid 2-of-3 report accepted');
  await expectRevert(demo.connect(lp).withdraw(1n), 'withdrawals locked', 'LP cannot exit right after a report (anti front-run)');
  await expectRevert(demo.submitReport(report, await typedSign(demo, report, [attesters[0], attesters[1]])), 'already reported', 'same event cannot be reported twice');

  console.log('\n[claims]');
  await expectRevert(demo.claim(polA, report.eventId), 'not eligible', 'claim blocked during challenge window');
  await warp(601);
  const before = await token.balanceOf(await citizen.getAddress());
  assert.equal(await demo.isEligible(polA, report.eventId), true);
  assert.equal(await demo.isEligible(polB, report.eventId), false);
  assert.equal(await demo.isEligible(polC, report.eventId), false);
  const paid = await demo.connect(other).claimBatch.staticCall(report.eventId, [polA, polB, polC]);
  assert.equal(paid, 1n);
  await (await demo.connect(other).claimBatch(report.eventId, [polA, polB, polC])).wait();
  assert.equal((await token.balanceOf(await citizen.getAddress())) - before, E(1000));
  ok('keeper batch: only policy A (Padang, M>=7.0) paid 1,000; B (too far) and C (needs M8.0) not');
  assert.equal(await demo.reservedCoverage(), E(2000));
  await expectRevert(demo.claim(polA, report.eventId), 'not eligible', 'no double payout');

  console.log('\n[guardian veto]');
  const t2 = await nowTs();
  const bad = { ...report, eventId: ethers.id('FALSE-ALARM'), occurredAt: t2 };
  await (await demo.submitReport(bad, await typedSign(demo, bad, [attesters[1], attesters[2]]))).wait();
  await (await demo.connect(owner).vetoEvent(bad.eventId)).wait();
  await warp(601);
  assert.equal(await demo.isEligible(polC, bad.eventId), false);
  ok('vetoed event pays nothing');
  await expectRevert(demo.connect(owner).vetoEvent(report.eventId), 'window closed', 'veto after window closed rejected');

  console.log('\n[waiting period + expiry]');
  const sa = await strict.getAddress();
  await (await strict.connect(lp).deposit(E(5000))).wait();
  await (await strict.connect(citizen).buyPolicy(await citizen.getAddress(), E4(padang[0]), E4(padang[1]), 100, 70, E(500), 10 * DAY)).wait();
  const t3 = await nowTs();
  const real = { eventId: ethers.id('REAL-EVENT-1'), magX10: 76, latE4: E4(epi[0]), lonE4: E4(epi[1]), depthKm: 20, occurredAt: t3, sourcesHash: ethers.id('x'), simulated: false };
  await (await strict.submitReport(real, await typedSign(strict, real, [attesters[0], attesters[1]]))).wait();
  await warp(601);
  assert.equal(await strict.isEligible(1, real.eventId), false);
  ok('quake inside the 3-day waiting period is NOT covered');
  await expectRevert(demo.releaseExpired(polB), 'grace period', 'collateral cannot be released early');
  await warp(30 * DAY + 11 * DAY);
  await expectRevert(demo.releaseExpired(polB), 'grace period', 'grace covers report age + challenge + claim window');
  await warp(4 * DAY);
  await (await demo.releaseExpired(polB, { gasLimit: 300000 })).wait();
  await (await demo.releaseExpired(polC, { gasLimit: 300000 })).wait();
  assert.equal(await demo.reservedCoverage(), 0n);
  ok('expired policies B and C release their 2,000 collateral');
  const lpShares = await demo.shares(await lp.getAddress());
  await (await demo.connect(lp).withdraw(lpShares)).wait();
  const lpBal = await token.balanceOf(await lp.getAddress());
  console.log('  LP final balance (started 110,000, deposited 100,000; pool paid out 1,000, earned premiums):', ethers.formatEther(lpBal));
  ok('LP withdraws after reserves are freed');

  console.log(`\nALL ${passed} CHECKS PASSED`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
