const solc = require('solc');
const fs = require('fs');
const path = require('path');

const sources = {};
for (const f of ['ParametricQuakePool.sol', 'MockUSDT.sol']) {
  sources[f] = { content: fs.readFileSync(path.join(__dirname, 'contracts', f), 'utf8') };
}
function findImports(p) {
  try { return { contents: fs.readFileSync(path.join(__dirname, 'node_modules', p), 'utf8') }; }
  catch (e) { return { error: 'not found ' + p }; }
}
const input = {
  language: 'Solidity', sources,
  settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } }
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
let failed = false;
for (const e of out.errors || []) {
  console.log(e.severity.toUpperCase() + ': ' + e.formattedMessage.split('\n')[0]);
  if (e.severity === 'error') failed = true;
}
if (failed) process.exit(1);
fs.mkdirSync('build', { recursive: true });
for (const f of Object.keys(out.contracts)) for (const c of Object.keys(out.contracts[f])) {
  if (!['ParametricQuakePool', 'MockUSDT'].includes(c)) continue;
  fs.writeFileSync(`build/${c}.json`, JSON.stringify({ abi: out.contracts[f][c].abi, bytecode: '0x' + out.contracts[f][c].evm.bytecode.object }));
  console.log(c, 'deployed size:', out.contracts[f][c].evm.deployedBytecode.object.length / 2, 'bytes');
}
console.log('COMPILE OK');
