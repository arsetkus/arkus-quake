#!/usr/bin/env node
// Idempotent deploy to BSC testnet. Re-run safely: every step is skipped once done.
//   1. generate relayer + 3 attester keys into .env (never printed)
//   2. wait for the relayer address to hold tBNB
//   3. deploy MockUSDT + ParametricQuakePool (demo: simulated replays allowed, 2-of-3 attesters)
//   4. LP deposit + demo policies around West Sumatra
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { seedPolicies, ensureBalance, E } = require('./demo');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const poolJ = require('../build/ParametricQuakePool.json');
const usdtJ = require('../build/MockUSDT.json');

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV)) return out;
  for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function setEnv(key, value) {
  let text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`;
  fs.writeFileSync(ENV, text, { mode: 0o600 });
  fs.chmodSync(ENV, 0o600);
}

(async () => {
  let env = readEnv();
  if (!env.RELAYER_KEY) { setEnv('RELAYER_KEY', ethers.Wallet.createRandom().privateKey); console.log('generated RELAYER_KEY'); }
  if (!env.ATTESTER_KEYS) { setEnv('ATTESTER_KEYS', [0, 1, 2].map(() => ethers.Wallet.createRandom().privateKey).join(',')); console.log('generated 3 ATTESTER_KEYS'); }
  env = readEnv();

  const rpc = env.RPC_URL || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';
  const provider = new ethers.JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  if (net.chainId !== 97n && process.env.ALLOW_ANY_CHAIN !== '1') throw new Error(`refusing to deploy to chainId ${net.chainId} (expected BSC testnet 97)`);
  const wallet = new ethers.Wallet(env.RELAYER_KEY, provider);
  const signer = new ethers.NonceManager(wallet);
  signer.address = wallet.address;
  const attesters = env.ATTESTER_KEYS.split(',').map((k) => new ethers.Wallet(k.trim()).address);

  const bal = await provider.getBalance(signer.address);
  console.log(`relayer ${signer.address} balance ${ethers.formatEther(bal)} tBNB`);
  if (bal < ethers.parseEther('0.03')) {
    console.log(`\nNEED_FUNDING: kirim minimal 0.05 tBNB (BSC testnet) ke ${signer.address}`);
    console.log('faucet: https://www.bnbchain.org/en/testnet-faucet  lalu jalankan lagi script ini.');
    process.exit(2);
  }

  let usdtAddr = env.USDT_ADDRESS;
  if (!usdtAddr) {
    const c = await new ethers.ContractFactory(usdtJ.abi, usdtJ.bytecode, signer).deploy();
    usdtAddr = (await c.deploymentTransaction().wait()).contractAddress;
    setEnv('USDT_ADDRESS', usdtAddr);
    console.log('MockUSDT', usdtAddr);
  }

  let poolAddr = env.POOL_ADDRESS;
  if (!poolAddr) {
    const challenge = parseInt(env.CHALLENGE_SECONDS || '180', 10);
    const c = await new ethers.ContractFactory(poolJ.abi, poolJ.bytecode, signer).deploy(usdtAddr, 0, challenge, true, attesters, 2);
    const rc = await c.deploymentTransaction().wait();
    poolAddr = rc.contractAddress;
    setEnv('POOL_CREATION_TX', rc.hash);
    setEnv('POOL_ADDRESS', poolAddr);
    setEnv('START_BLOCK', String(rc.blockNumber));
    console.log('ParametricQuakePool', poolAddr, 'block', rc.blockNumber, `challenge ${challenge}s`);
  }

  const pool = new ethers.Contract(poolAddr, poolJ.abi, signer);
  const token = new ethers.Contract(usdtAddr, usdtJ.abi, signer);

  if ((await pool.totalShares()) === 0n) {
    await ensureBalance(token, signer, poolAddr, E(40000));
    await (await pool.deposit(E(40000))).wait();
    console.log('LP deposit 40,000 mUSDT');
  }
  if ((await pool.nextPolicyId()) === 1n) {
    const ids = await seedPolicies(pool, token, signer);
    console.log('demo policies', ids.join(', '));
  }

  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'deployment.json'), JSON.stringify({
    chainId: Number(net.chainId), pool: poolAddr, poolCreationTx: readEnv().POOL_CREATION_TX || null, usdt: usdtAddr, relayer: signer.address, attesters,
    explorer: 'https://testnet.bscscan.com',
  }, null, 2));
  console.log('\nDEPLOY_OK pool', poolAddr);
})().catch((e) => { console.error('deploy failed:', e.shortMessage || e.message); process.exit(1); });
