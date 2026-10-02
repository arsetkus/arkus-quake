// Demo data: policies around West Sumatra bought by a sponsor for wallet-less residents.
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const LABELS_FILE = path.join(__dirname, '..', 'data', 'labels.json');
const E = (n) => ethers.parseEther(String(n));
const E4 = (d) => Math.round(d * 1e4);

// radius / threshold chosen so a Padang-2009 replay pays some and visibly skips others
const DEMO_POLICIES = [
  { label: 'Warga Padang', lat: -0.9492, lon: 100.3543, radiusKm: 100, minMag: 6.5, coverage: 1000 },
  { label: 'Warga Pariaman', lat: -0.6265, lon: 100.118, radiusKm: 75, minMag: 6.5, coverage: 1000 },
  { label: 'Warga Painan', lat: -1.3511, lon: 100.5753, radiusKm: 150, minMag: 6.5, coverage: 750 },
  { label: 'Warga Bukittinggi', lat: -0.3056, lon: 100.3692, radiusKm: 75, minMag: 6.5, coverage: 750 },
  { label: 'Warga Tuapejat (Mentawai)', lat: -2.0333, lon: 99.5833, radiusKm: 100, minMag: 7.0, coverage: 1000 },
  { label: 'Warga Palu', lat: -0.8917, lon: 119.8707, radiusKm: 100, minMag: 6.5, coverage: 1000 },
];

function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); } catch { return {}; }
}

function writeLabels(labels) {
  fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true });
  fs.writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 2));
}

async function ensureBalance(token, signer, poolAddr, need) {
  const me = await signer.getAddress();
  let bal = await token.balanceOf(me);
  while (bal < need) {
    await (await token.connect(signer).faucet(E(10000))).wait();
    bal += E(10000);
  }
  if ((await token.allowance(me, poolAddr)) < need) await (await token.connect(signer).approve(poolAddr, ethers.MaxUint256)).wait();
}

/** Sponsor buys one 365-day policy per demo location; beneficiaries are fresh addresses (no wallet app needed). */
async function seedPolicies(pool, token, signer, { only } = {}) {
  const list = only ? DEMO_POLICIES.filter((p) => only.includes(p.label)) : DEMO_POLICIES;
  await ensureBalance(token, signer, await pool.getAddress(), E(500)); // premiums
  const labels = readLabels();
  const ids = [];
  for (const p of list) {
    const beneficiary = ethers.Wallet.createRandom().address;
    const rc = await (await pool.connect(signer).buyPolicy(beneficiary, E4(p.lat), E4(p.lon), p.radiusKm, Math.round(p.minMag * 10), E(p.coverage), 365 * 86400)).wait();
    const ev = rc.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === 'PolicyBought');
    const id = ev.args.policyId.toString();
    labels[id] = p.label;
    ids.push(id);
  }
  writeLabels(labels);
  return ids;
}

module.exports = { DEMO_POLICIES, seedPolicies, ensureBalance, readLabels, writeLabels, E };
