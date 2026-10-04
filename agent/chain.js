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
 * Logs for a block range from a JSON-RPC endpoint that still keeps old logs (an archive / history
 * node, e.g. a NodeReal key). Same shape as etherscanLogs.
 */
function rpcLogs(url, { chainId = 97, step = 2000 } = {}) {
  const p = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
  return async (address, fromBlock, toBlock) => {
    const out = [];
    for (let from = fromBlock; from <= toBlock; from += step) {
      const logs = await p.getLogs({ address, fromBlock: from, toBlock: Math.min(toBlock, from + step - 1) });
      out.push(...logs.map((l) => ({ topics: [...l.topics], data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.index })));
    }
    return out;
  };
}

/**
 * Incremental index of every pool log. Scans only new blocks on each sync(), so a long-running
 * agent / web server does not re-scan the whole chain (BSC testnet makes ~1 block per second).
 *
 * Public BSC testnet RPCs keep only ~2 days of logs, and the keeper relies on this index to find the
 * policies to pay, so a fresh index must not depend on old logs:
 *   - `file`: the index is saved after every sync and a restart resumes from it;
 *   - `explorer`: a history source (archive RPC or explorer API) backfills a fresh index exactly;
 *   - otherwise the index is rebuilt from contract state (policies from storage, reports from the
 *     agent's snapshots in `snapshots`), marked incomplete, and the history source is retried later.
 */
class PoolIndex {
  constructor(pool, { fromBlock = 0, step = 4000, file = null, explorer = null, snapshots = null, log = () => {} } = {}) {
    this.pool = pool;
    this.provider = pool.runner.provider;
    this.fromBlock = fromBlock;
    this.next = fromBlock;
    this.step = step;
    this.file = file;
    this.explorer = explorer;
    this.snapshots = snapshots;
    this.log = log;
    this.policies = new Map(); // id -> policy
    this.reports = new Map();  // eventId -> report
    this.lp = { deposited: 0n, withdrawn: 0n };
    this.blockTimes = new Map();
    this.complete = true;      // false = rebuilt from state, logs before `next` were never seen
    this.historyTried = false; // try the history source once per process
    this.restored = file ? this.load() : false;
  }

  load() {
    try {
      const j = fromJson(fs.readFileSync(this.file, 'utf8'));
      // files from before the `complete` flag may come from a pruned RPC scan: rebuild those
      if (String(j.pool).toLowerCase() !== String(this.pool.target).toLowerCase() || typeof j.complete !== 'boolean') return false;
      Object.assign(this, { next: j.next, complete: j.complete, policies: new Map(j.policies), reports: new Map(j.reports), lp: j.lp });
      return true;
    } catch { return false; }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, toJson({ pool: this.pool.target, next: this.next, complete: this.complete,
      policies: [...this.policies], reports: [...this.reports], lp: this.lp }));
    fs.renameSync(tmp, this.file);
  }

  reset() {
    this.policies = new Map();
    this.reports = new Map();
    this.lp = { deposited: 0n, withdrawn: 0n };
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

  /** Exact history from the history source; false if there is none or it failed. */
  async backfill(address, head) {
    if (!this.explorer || this.historyTried || this.fromBlock >= head - 200) return false;
    this.historyTried = true;
    const to = head - 200; // explorers lag a few blocks; the RPC covers the rest
    let logs;
    try { logs = await this.explorer(address, this.fromBlock, to); } catch (e) {
      this.log(`index: WARNING history backfill failed (${e.message})`);
      return false;
    }
    this.reset();
    for (const l of logs) { if (l.timeStamp) this.blockTimes.set(l.blockNumber, l.timeStamp); await this.apply(l); }
    this.next = to + 1;
    this.complete = true;
    this.log(`index: backfilled ${logs.length} logs (blocks ${this.fromBlock}..${to}) from the history source`);
    return true;
  }

  /**
   * No log history: rebuild from contract state as of `head`. Policies come from storage, reports
   * from the agent's snapshots (checked against events()), and which report paid each closed policy
   * is re-derived with the contract's own rules. Payout tx hashes and premiums are unknown.
   */
  async rebuildFromState(head) {
    this.reset();
    const [n, waiting, cw, grace, nowTs] = await Promise.all([this.pool.nextPolicyId(), this.pool.waitingPeriod(), this.pool.challengeWindow(),
      this.pool.SETTLEMENT_GRACE(), this.provider.getBlock(head).then((b) => b.timestamp)]);
    const files = this.snapshots && fs.existsSync(this.snapshots) ? fs.readdirSync(this.snapshots).filter((f) => /^0x[0-9a-fA-F]{64}\.json$/.test(f)) : [];
    for (const f of files) {
      let snap;
      try { snap = JSON.parse(fs.readFileSync(path.join(this.snapshots, f), 'utf8')); } catch { continue; }
      const eventId = f.slice(0, -5).toLowerCase();
      const e = await this.pool.events(eventId);
      if (!e.exists) continue;
      this.reports.set(eventId, { eventId, magX10: Number(e.magX10), latE4: Number(e.latE4), lonE4: Number(e.lonE4), occurredAt: Number(e.occurredAt),
        sourcesHash: (snap.report && snap.report.sourcesHash) || null, simulated: e.simulated, reportedAt: Number(e.reportedAt), vetoed: e.vetoed,
        paidCount: 0, paidAmount: 0n, block: null, tx: snap.tx || null });
    }
    const byTime = [...this.reports.values()].sort((a, b) => a.reportedAt - b.reportedAt);
    for (let id = 1; id < Number(n); id++) {
      const p = await this.pool.policies(id);
      const pol = { id: String(id), sponsor: p.sponsor, beneficiary: p.beneficiary, latE4: Number(p.latE4), lonE4: Number(p.lonE4),
        radiusKm: Number(p.radiusKm), minMagX10: Number(p.minMagX10), coverage: p.coverage, premium: 0n, end: Number(p.end), status: 'active',
        boughtAt: Number(p.waitingUntil) - Number(waiting), block: null, tx: null };
      if (p.closed) {
        let by = null;
        for (const r of byTime) {
          if (r.vetoed || r.magX10 < pol.minMagX10 || r.occurredAt < Number(p.waitingUntil) || r.occurredAt > pol.end || r.reportedAt + Number(cw) > nowTs) continue;
          if (await this.pool.withinRadius(p.latE4, p.lonE4, r.latE4, r.lonE4, p.radiusKm)) { by = r; break; }
        }
        if (by) {
          Object.assign(pol, { status: 'paid', paidEvent: by.eventId, paidTx: null, paidAt: null });
          by.paidCount++; by.paidAmount += p.coverage;
        } else if (nowTs < pol.end + Number(grace)) {
          // release is only possible after end + grace, so this was a payout by a report we have no snapshot for
          Object.assign(pol, { status: 'paid', paidEvent: null, paidTx: null, paidAt: null });
        } else pol.status = 'expired';
      }
      this.policies.set(pol.id, pol);
    }
    this.next = head + 1;
    this.complete = false;
    this.log(`index: rebuilt from contract state (${this.policies.size} policies, ${this.reports.size} reports from snapshots); log history unavailable`);
  }

  async _sync() {
    const head = await this.head();
    const address = await this.pool.getAddress();
    const start = this.next;
    if (!this.restored || !this.complete) {
      const exact = await this.backfill(address, head);
      if (!exact && !this.restored) {
        // the RPC alone can still be complete when the pool is younger than its log retention
        let rpcOk = false;
        try { rpcOk = (await this.provider.getLogs({ address, fromBlock: this.fromBlock, toBlock: this.fromBlock })).length > 0; } catch {}
        if (!rpcOk && this.file) await this.rebuildFromState(head);
      }
      this.restored = true;
    }
    while (this.next <= head) {
      const to = Math.min(head, this.next + this.step - 1);
      const logs = await this.provider.getLogs({ address, fromBlock: this.next, toBlock: to });
      for (const l of logs) await this.apply(l);
      this.next = to + 1;
    }
    if (this.file && (this.next !== start || !this.restoredSaved)) { this.save(); this.restoredSaved = true; }
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

module.exports = { PoolIndex, etherscanLogs, rpcLogs, REPORT_TYPES, poolAt, domainFor, signReport, sortSignatures, isReported, submitReport, runKeeper, queryChunked };
