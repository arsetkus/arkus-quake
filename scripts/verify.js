#!/usr/bin/env node
// Verify the deployed contracts on BscScan testnet.
//   node scripts/verify.js [poolAddress] [usdtAddress]       (defaults: POOL_ADDRESS / USDT_ADDRESS in .env)
// Always writes build/verify/<Contract>.input.json + .args.txt for the manual web form
// (testnet.bscscan.com -> Contract -> Verify and Publish -> Solidity (Standard-Json-Input)).
// With BSCSCAN_API_KEY (an Etherscan API v2 key) in .env it also submits through the API.
'use strict';
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.etherscan.io/v2/api?chainid=97';
const COMPILER = 'v' + solc.version().replace('.Emscripten.clang', '');
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
// publicnode keeps tx history; the bnbchain data-seed nodes often do not
const RPC = process.env.VERIFY_RPC_URL || 'https://bsc-testnet-rpc.publicnode.com';
const KEY = process.env.BSCSCAN_API_KEY || env.BSCSCAN_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same source keys + settings as compile.js, so the metadata hash matches the deployed bytecode
function standardInput(file) {
  const sources = {};
  const add = (key, abs) => {
    if (sources[key]) return;
    const content = fs.readFileSync(abs, 'utf8');
    sources[key] = { content };
    for (const m of content.matchAll(/import\s+(?:\{[^}]*\}\s+from\s+)?"([^"]+)"/g)) {
      const imp = m[1].startsWith('.') ? path.posix.join(path.posix.dirname(key), m[1]) : m[1];
      add(imp, imp.startsWith('@') ? path.join(ROOT, 'node_modules', imp) : path.join(ROOT, 'contracts', imp));
    }
  };
  add(file, path.join(ROOT, 'contracts', file));
  return {
    language: 'Solidity', sources,
    settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 },
      // full output like Hardhat sends; BscScan reads more than bytecode.object (does not change the bytecode)
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'evm.methodIdentifiers', 'metadata'], '': ['ast'] } } },
  };
}

async function api(params, post) {
  const url = post ? API : `${API}&${new URLSearchParams({ ...params, apikey: KEY })}`;
  const res = await fetch(url, post
    ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, apikey: KEY }) }
    : undefined);
  return res.json();
}

// creationTx: tx hash, null = contract has no constructor args, undefined = look it up via the API
async function verify(provider, file, name, address, creationTx) {
  const input = standardInput(file);
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs[0].formattedMessage);
  const bytecode = out.contracts[file][name].evm.bytecode.object.toLowerCase();

  // constructor args = creation tx input after the init code; also proves source == deployed
  let args = '';
  if (creationTx === undefined && KEY) {
    const r = await api({ module: 'contract', action: 'getcontractcreation', contractaddresses: address });
    creationTx = r.status === '1' ? r.result[0].txHash : undefined;
  }
  if (creationTx) {
    const tx = await provider.getTransaction(creationTx);
    if (!tx) throw new Error(`${name}: creation tx ${creationTx} not found on ${RPC}`);
    const data = tx.data.slice(2).toLowerCase();
    if (!data.startsWith(bytecode)) throw new Error(`${name}: creation code differs from local source (compiled with other source/settings)`);
    args = data.slice(bytecode.length);
  } else if (creationTx === undefined) {
    throw new Error(`${name}: creation tx unknown; set poolCreationTx in deployments/bsc-testnet.json or BSCSCAN_API_KEY`);
  }

  const dir = path.join(ROOT, 'build', 'verify');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.input.json`), JSON.stringify(input));
  fs.writeFileSync(path.join(dir, `${name}.args.txt`), args);
  console.log(`${name} ${address}\n   compiler ${COMPILER}, license MIT, optimizer 200 runs, evm paris`);
  console.log(`   files: build/verify/${name}.input.json, build/verify/${name}.args.txt${args ? '' : ' (no constructor args)'}`);
  if (!KEY) return;

  const st = await api({ module: 'contract', action: 'getsourcecode', address });
  if (st.status === '1' && st.result[0].SourceCode) return console.log('   already verified');
  const sub = await api({
    module: 'contract', action: 'verifysourcecode', contractaddress: address, sourceCode: JSON.stringify(input),
    codeformat: 'solidity-standard-json-input', contractname: `${file}:${name}`, compilerversion: COMPILER,
    constructorArguements: args, licenseType: '3', // 3 = MIT
  }, true);
  if (sub.status !== '1') return console.log(`   submit failed: ${sub.result || sub.message}`);
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const c = await api({ module: 'contract', action: 'checkverifystatus', guid: sub.result });
    if (!/pending/i.test(c.result)) return console.log(`   ${c.result}`);
  }
  console.log('   still pending, check BscScan later');
}

(async () => {
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'bsc-testnet.json'), 'utf8'));
  const pool = process.argv[2] || env.POOL_ADDRESS || dep.pool;
  const usdt = process.argv[3] || env.USDT_ADDRESS || dep.usdt;
  const poolTx = pool.toLowerCase() === dep.pool.toLowerCase() ? dep.poolCreationTx : undefined;
  if (!KEY) console.log('BSCSCAN_API_KEY not set: only writing files for the manual web form\n');
  const provider = new ethers.JsonRpcProvider(RPC, 97, { staticNetwork: true });
  await verify(provider, 'ParametricQuakePool.sol', 'ParametricQuakePool', pool, poolTx);
  if (usdt) await verify(provider, 'MockUSDT.sol', 'MockUSDT', usdt, null);
})().catch((e) => { console.error('verify failed:', e.shortMessage || e.message); process.exit(1); });
