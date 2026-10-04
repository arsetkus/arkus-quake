// On-chain side: EIP-712 signing, report relay, and the keeper that pays eligible policies.
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { haversineKm } = require('./match');
const poolArtifact = require('../build/ParametricQuakePool.json');

const REPORT_TYPES = {
  QuakeReport: [
    { name: 'eventId', type: 'bytes32' },
    { name: 'magX10', type: 'uint16' },
    { name: 'latE4', type: 'int32' },
    { name: 'lonE4', type: 'int32' },
    { name: 'depthKm', type: 'uint16' },
    { name: 'occurredAt', type: 'uint64' },
    { name: 'sourcesHash', type: 'bytes32' },
    { name: 'simulated', type: 'bool' },
  ],
};

function poolAt(address, runner) {
  return new ethers.Contract(address, poolArtifact.abi, runner);
}

async function domainFor(pool) {
  const net = await pool.runner.provider.getNetwork();
  return { name: 'ParametricQuakePool', version: '1', chainId: net.chainId, verifyingContract: await pool.getAddress() };
}

/** One attester signs one report. In production each attester runs on its own machine. */
async function signReport(wallet, domain, report) {
  return { signer: wallet.address, sig: await wallet.signTypedData(domain, REPORT_TYPES, report) };
}

/** The contract requires signatures sorted by ascending signer address. */
function sortSignatures(list) {
  return [...list].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1)).map((x) => x.sig);
}

async function isReported(pool, eventId) {
  return (await pool.events(eventId)).exists;
}

async function submitReport(pool, report, sigs) {
  const tx = await pool.submitReport(report, sigs);
  return tx.wait();
}

/** Fetch logs in chunks (public BSC RPCs cap the block range per eth_getLogs call). */
async function queryChunked(contract, filter, fromBlock, toBlock, step = 4000) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += step) {
    const last = start + step - 1 >= toBlock;
    // last chunk goes to 'latest' so blocks mined after getBlockNumber() are not missed
    out.push(...(await contract.queryFilter(filter, start, last ? 'latest' : start + step - 1)));
  }
  return out;
}

/**
 * Logs from the block explorer (Etherscan API v2, which serves BscScan). Public BSC testnet RPCs only
 * keep about two days of logs, so history older than that has to come from here.
 * Returns (address, fromBlock, toBlock) => logs sorted by block and log index.
 */
function etherscanLogs({ apiKey, chainId = 97, url = 'https://api.etherscan.io/v2/api' }) {
  const hex = (v) => (v && v !== '0x' ? Number(v) : 0);
  return async (address, fromBlock, toBlock) => {
    const out = [];
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ chainid: String(chainId), module: 'logs', action: 'getLogs', address, fromBlock: String(fromBlock),
        toBlock: String(toBlock), page: String(page), offset: '1000', apikey: apiKey });
      const j = await (await fetch(`${url}?${q}`)).json();
      if (j.status !== '1') {
        if (/no records/i.test(j.message || '')) break;
        throw new Error('explorer logs: ' + (typeof j.result === 'string' ? j.result : j.message));
      }
      out.push(...j.result.map((l) => ({ topics: l.topics.filter(Boolean), data: l.data, blockNumber: hex(l.blockNumber),
        transactionHash: l.transactionHash, logIndex: hex(l.logIndex), timeStamp: hex(l.timeStamp) })));
      if (j.result.length < 1000) break;
    }
    return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  };
}

// JSON with bigints (coverage, premiums, LP totals)
const toJson = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? { $n: x.toString() } : x));
const fromJson = (s) => JSON.parse(s, (k, x) => (x && typeof x === 'object' && Object.keys(x).length === 1 && typeof x.$n === 'string' ? BigInt(x.$n) : x));

/**
 * Incremental index of every pool log. Scans only new blocks on each sync(), so a long-running
 * agent / web server does not re-scan the whole chain (BSC testnet makes ~1 block per second).
 * With `file` the index survives restarts; with `explorer` a fresh index backfills history the
 * RPC no longer serves (the keeper relies on this index to find policies to pay).
 */
class PoolIndex {
  constructor(pool, { fromBlock = 0, step = 4000, file = null, explorer = null, log = () => {} } = {}) {
    this.pool = pool;
    this.provider = pool.runner.provider;
    this.next = fromBlock;
    this.step = step;
    this.file = file;
    this.explorer = explorer;
    this.log = log;
    this.policies = new Map(); // id -> policy
    this.reports = new Map();  // eventId -> report
    this.lp = { deposited: 0n, withdrawn: 0n };
    this.blockTimes = new Map();
    this.restored = file ? this.load() : false;
  }

  load() {
    try {
      const j = fromJson(fs.readFileSync(this.file, 'utf8'));
      if (String(j.pool).toLowerCase() !== String(this.pool.target).toLowerCase()) return false;
      this.next = j.next;
      this.policies = new Map(j.policies);
      this.reports = new Map(j.reports);
      this.lp = j.lp;
      return true;
    } catch { return false; }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, toJson({ pool: this.pool.target, next: this.next, policies: [...this.policies], reports: [...this.reports], lp: this.lp }));
    fs.renameSync(tmp, this.file);
  }

  async head() {
    return Number(await this.provider.send('eth_blockNumber', []));
  }

  async blockTime(n) {
    if (!this.blockTimes.has(n)) this.blockTimes.set(n, (await this.provider.getBlock(n)).timestamp);
    return this.blockTimes.get(n);
  }

  sync() {
    // one sync at a time, concurrent callers share it (logs must be applied exactly once)
    if (!this._inflight) this._inflight = this._sync().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _sync() {
    const head = await this.head();
    const address = await this.pool.getAddress();
    const start = this.next;
    // fresh index: history from the explorer, stopping a little short of head (explorers lag a few blocks)
    if (this.explorer && !this.restored && this.next < head - 200) {
      const to = head - 200;
      let logs = null;
      try { logs = await this.explorer(address, this.next, to); } catch (e) {
        this.log(`index: WARNING explorer backfill failed (${e.message}); falling back to the RPC, older logs may be missing`);
      }
      if (logs) {
        for (const l of logs) { if (l.timeStamp) this.blockTimes.set(l.blockNumber, l.timeStamp); await this.apply(l); }
        this.log(`index: backfilled ${logs.length} logs (blocks ${this.next}..${to}) from the explorer`);
        this.next = to + 1;
      }
    }
    this.restored = true;
    while (this.next <= head) {
      const to = Math.min(head, this.next + this.step - 1);
      const logs = await this.provider.getLogs({ address, fromBlock: this.next, toBlock: to });
      for (const l of logs) await this.apply(l);
      this.next = to + 1;
    }
    if (this.file && this.next !== start) this.save();
    return this;
  }

  async apply(l) {
    let ev;
    try { ev = this.pool.interface.parseLog(l); } catch { return; }
    if (!ev) return;
    const a = ev.args;
    const at = { block: l.blockNumber, tx: l.transactionHash };
    switch (ev.name) {
      case 'PolicyBought':
        this.policies.set(a.policyId.toString(), {
          id: a.policyId.toString(), sponsor: a.sponsor, beneficiary: a.beneficiary,
          latE4: Number(a.latE4), lonE4: Number(a.lonE4), radiusKm: Number(a.radiusKm),
          minMagX10: Number(a.minMagX10), coverage: a.coverage, premium: a.premium, end: Number(a.end),
          status: 'active', boughtAt: await this.blockTime(l.blockNumber), ...at,
        });
        break;
      case 'PolicyPaid': {
        const p = this.policies.get(a.policyId.toString());
        if (p) Object.assign(p, { status: 'paid', paidEvent: a.eventId, paidTx: l.transactionHash, paidAt: await this.blockTime(l.blockNumber) });
        const r = this.reports.get(a.eventId);
        if (r) { r.paidCount++; r.paidAmount += a.amount; }
        break;
      }
      case 'PolicyReleased': {
        const p = this.policies.get(a.policyId.toString());
        if (p) p.status = 'expired';
        break;
      }
      case 'ReportSubmitted':
        this.reports.set(a.eventId, {
          eventId: a.eventId, magX10: Number(a.magX10), latE4: Number(a.latE4), lonE4: Number(a.lonE4),
          occurredAt: Number(a.occurredAt), sourcesHash: a.sourcesHash, simulated: a.simulated,
          reportedAt: await this.blockTime(l.blockNumber), vetoed: false, paidCount: 0, paidAmount: 0n, ...at,
        });
        break;
      case 'EventVetoed': {
        const r = this.reports.get(a.eventId);
        if (r) r.vetoed = true;
        break;
      }
      case 'Deposited': this.lp.deposited += a.amount; break;
      case 'Withdrawn': this.lp.withdrawn += a.amount; break;
      default: break;
    }
  }
}

/**
 * Keeper: for every non-vetoed report, take the still-active policies that pass a cheap off-chain
 * pre-filter, confirm with isEligible() (which enforces the challenge window, waiting period, expiry
 * and veto) and pay them with claimBatch(). Safe to crash/restart: state comes from chain logs.
 */
async function runKeeper(pool, { fromBlock = 0, index, batchSize = 50, log = console.log } = {}) {
  const idx = await (index || new PoolIndex(pool, { fromBlock })).sync();
  const active = [...idx.policies.values()].filter((p) => p.status === 'active');
  let totalPaid = 0;
  for (const r of idx.reports.values()) {
    if (r.vetoed) continue;
    const lat = r.latE4 / 1e4, lon = r.lonE4 / 1e4;
    // +2 km slack for the contract's flat-earth approximation
    const candidates = active.filter((p) => r.magX10 >= p.minMagX10 && haversineKm(p.latE4 / 1e4, p.lonE4 / 1e4, lat, lon) <= p.radiusKm + 2);
    const eligible = [];
    for (const p of candidates) if (await pool.isEligible(p.id, r.eventId)) eligible.push(p.id);
    for (let i = 0; i < eligible.length; i += batchSize) {
      const ids = eligible.slice(i, i + batchSize);
      const rc = await (await pool.claimBatch(r.eventId, ids)).wait();
      const paid = rc.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } }).filter((x) => x && x.name === 'PolicyPaid');
      totalPaid += paid.length;
      for (const p of paid) log(`  paid policy #${p.args.policyId} -> ${p.args.beneficiary} : ${ethers.formatEther(p.args.amount)}`);
    }
  }
  if (totalPaid) await idx.sync();
  return { reports: idx.reports.size, policies: idx.policies.size, paid: totalPaid };
}

module.exports = { PoolIndex, etherscanLogs, REPORT_TYPES, poolAt, domainFor, signReport, sortSignatures, isReported, submitReport, runKeeper, queryChunked };
