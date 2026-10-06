// Participation panel: policyholders buy policies for themselves, residents check theirs, LPs deposit/withdraw.
// Runs after the dashboard script and reuses its globals ($, S, map, esc, nf, short, EXP, refresh).
'use strict';
(() => {
  const POOL_ABI = [
    'function quotePremium(uint16 minMagX10, uint16 radiusKm, uint128 coverage, uint64 duration) pure returns (uint256)',
    'function buyPolicy(address beneficiary, int32 latE4, int32 lonE4, uint16 radiusKm, uint16 minMagX10, uint128 coverage, uint64 duration) returns (uint256 id, uint256 premium)',
    'function deposit(uint256 amount) returns (uint256)',
    'function withdraw(uint256 shareAmount) returns (uint256)',
    'function shares(address) view returns (uint256)',
    'function totalShares() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
    'function freeLiquidity() view returns (uint256)',
    'function withdrawLockedUntil() view returns (uint64)',
    'event PolicyBought(uint256 indexed policyId, address indexed sponsor, address indexed beneficiary, int32 latE4, int32 lonE4, uint16 radiusKm, uint16 minMagX10, uint128 coverage, uint256 premium, uint64 end)',
  ];
  const TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function faucet(uint256 amount)',
  ];
  const BOX = { latMin: -12, latMax: 7, lonMin: 95, lonMax: 142 }; // same as the contract
  const TBNB_FAUCET = 'https://www.bnbchain.org/en/testnet-faucet';
  const E = (n) => ethers.parseEther(String(n));
  const U = (v) => nf.format(Number(ethers.formatEther(v)));
  const labelMessage = (id, label) => `ARKUS: beri nama polis #${id}: ${label}`;

  let rp = null, poolR = null, tokenR = null; // read-only, work without a wallet
  const W = { signer: null, addr: null };
  let pick = null, pickLayer = L.layerGroup().addTo(map), tab = 'buy', busy = false;

  // ---------------------------------------------------------------- helpers
  const REVERTS = {
    'pool undercollateralized': 'Dana bebas di pool tidak cukup untuk nilai cair ini. Kecilkan nilai cair.',
    'lat outside Indonesia box': 'Lokasi harus di wilayah Indonesia.',
    'lon outside Indonesia box': 'Lokasi harus di wilayah Indonesia.',
    'withdrawals locked: claims pending': 'Penarikan dikunci sampai masa klaim gempa terakhir selesai.',
    'funds reserved for policies': 'Sebagian dana sedang menjamin polis aktif. Tarik jumlah yang lebih kecil.',
    'bad shares': 'Jumlah melebihi bagian kamu di pool.',
  };
  function errText(e) {
    if (e && (e.code === 'ACTION_REJECTED' || e.code === 4001 || (e.info && e.info.error && e.info.error.code === 4001))) return 'Dibatalkan di wallet.';
    const raw = (e && (e.reason || (e.revert && e.revert.args && e.revert.args[0]) || (e.info && e.info.error && e.info.error.message) || e.shortMessage || e.message)) || String(e);
    for (const k of Object.keys(REVERTS)) if (raw.includes(k)) return REVERTS[k];
    if (/insufficient funds/i.test(raw)) return `Saldo tBNB untuk gas tidak cukup. Ambil gratis di <a href="${TBNB_FAUCET}" target="_blank" rel="noopener">faucet BNB testnet</a>.`;
    return esc(raw.slice(0, 220));
  }
  function say(el, html, kind = '') { const m = $(el); m.hidden = !html; m.className = 'msg ' + kind; m.innerHTML = html || ''; }
  const txLink = (h, t = 'lihat transaksi') => `<a target="_blank" rel="noopener" href="${EXP}/tx/${h}">${t}</a>`;
  const policyOf = (rc) => rc.logs.map((l) => { try { return poolR.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === 'PolicyBought');

  function initReaders(s) {
    if (rp) return;
    rp = new ethers.JsonRpcProvider(s.chain.rpc, s.chain.chainId, { staticNetwork: true });
    poolR = new ethers.Contract(s.pool.address, POOL_ABI, rp);
    tokenR = new ethers.Contract(s.pool.asset, TOKEN_ABI, rp);
  }

  // ---------------------------------------------------------------- wallet
  async function ensureChain() {
    const want = '0x' + S.chain.chainId.toString(16);
    if ((await window.ethereum.request({ method: 'eth_chainId' })) === want) return;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      const code = e.code || (e.data && e.data.originalError && e.data.originalError.code);
      if (code !== 4902) throw e;
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: want, chainName: S.chain.name, rpcUrls: [S.chain.rpc], blockExplorerUrls: [S.chain.explorer],
        nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
      }] });
    }
  }

  async function connect() {
    if (!S) return;
    if (!window.ethereum) {
      say(tab === 'lp' ? 'lMsg' : 'bMsg', 'Wallet tidak ditemukan. Pasang <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a>, atau buka situs ini dari browser di dalam aplikasi Trust Wallet / Binance Wallet.', 'bad');
      return false;
    }
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      await ensureChain();
      const bp = new ethers.BrowserProvider(window.ethereum);
      W.signer = await bp.getSigner();
      W.addr = await W.signer.getAddress();
      if (!$('cAddr').value) { $('cAddr').value = W.addr; drawCheck(); }
      if (!$('bBen').value) $('bBen').value = W.addr;
      await drawWallet();
      updateBuy(); drawLp();
      return true;
    } catch (e) {
      say(tab === 'lp' ? 'lMsg' : 'bMsg', errText(e), 'bad');
      return false;
    }
  }
  // a wallet signer is bound to one account and chain: rebuild it whenever they change
  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on('accountsChanged', () => { if (W.addr) connect(); });
    window.ethereum.on('chainChanged', () => { if (W.addr) connect(); });
  }
  const signerReady = async () => W.signer || (await connect()) && W.signer;

  async function drawWallet() {
    $('walletBtn').textContent = W.addr ? short(W.addr) : 'Hubungkan wallet';
    if (!W.addr) { $('wBar').hidden = true; return; }
    const [usdt, bnb] = await Promise.all([tokenR.balanceOf(W.addr), rp.getBalance(W.addr)]);
    $('wBar').hidden = false;
    $('wBar').innerHTML = `<span class="mono">${short(W.addr)}</span><span>${U(usdt)} mUSDT</span>`
      + `<span>${Number(ethers.formatEther(bnb)).toFixed(4)} tBNB</span>`
      + `<a id="wFaucet">+10.000 mUSDT testnet</a>`
      + (bnb < E('0.002') ? `<a href="${TBNB_FAUCET}" target="_blank" rel="noopener">ambil tBNB untuk gas</a>` : '')
      + `<a id="wWatch">tampilkan mUSDT di wallet</a>`;
    $('wFaucet').onclick = () => run('faucet', async () => {
      const tk = tokenR.connect(W.signer);
      const rc = await (await tk.faucet(E(10000))).wait();
      return `10.000 mUSDT testnet masuk. ${txLink(rc.hash)}`;
    }, tab === 'lp' ? 'lMsg' : 'bMsg');
    $('wWatch').onclick = () => window.ethereum.request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: S.pool.asset, symbol: 'mUSDT', decimals: 18 } } }).catch(() => {});
  }
  $('walletBtn').onclick = () => (W.addr ? drawWallet() : connect());

  // one transaction flow at a time; steps report progress into the message box
  async function run(name, fn, box) {
    if (busy) return;
    busy = true; updateBuy();
    say(box, 'Menunggu konfirmasi di wallet…');
    try { say(box, await fn((t) => say(box, t)), 'ok'); refresh(); }
    catch (e) { say(box, errText(e), 'bad'); }
    finally { busy = false; updateBuy(); drawWallet().catch(() => {}); drawLp(); }
  }

  async function ensureFunds(amount, step) {
    const tk = tokenR.connect(W.signer);
    for (let i = 0; i < 5 && (await tokenR.balanceOf(W.addr)) < amount; i++) {
      step('Saldo mUSDT kurang, mengambil 10.000 mUSDT testnet (konfirmasi di wallet)…');
      await (await tk.faucet(E(10000))).wait();
    }
    if ((await tokenR.allowance(W.addr, S.pool.address)) < amount) {
      step('Izinkan pool memakai mUSDT kamu (konfirmasi di wallet)…');
      await (await tk.approve(S.pool.address, amount)).wait();
    }
  }

  // ---------------------------------------------------------------- tabs
  $('tabs').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    tab = b.dataset.t;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('#joinCard [data-p]').forEach((p) => { p.hidden = p.dataset.p !== tab; });
    map.getContainer().classList.toggle('picking', tab === 'buy');
    if (tab === 'lp') drawLp();
    if (tab === 'check') drawCheck();
    if (tab === 'lp') drawLp();
  };
  map.getContainer().classList.add('picking');

  // ---------------------------------------------------------------- buy
  for (let m = 50; m <= 80; m += 5) $('bMag').add(new Option('M' + (m / 10).toFixed(1) + ' ke atas', m, false, m === 65));

  function drawPick() {
    pickLayer.clearLayers();
    if (!pick) return;
    const r = +$('bRad').value;
    L.circle([pick.lat, pick.lon], { radius: r * 1000, color: css('--warn'), weight: 2, dashArray: '6 5', fillOpacity: .08, interactive: false }).addTo(pickLayer);
    L.circleMarker([pick.lat, pick.lon], { radius: 5, color: css('--warn'), fillOpacity: 1, weight: 0, interactive: false }).addTo(pickLayer);
  }
  map.on('click', (e) => { if (tab === 'buy') setPick(e.latlng); });
  // existing policy areas swallow the click (they open a popup): while buying, treat it as a pick
  map.on('popupopen', (e) => {
    if (tab !== 'buy' || !(e.popup._source instanceof L.Circle)) return;
    map.closePopup(e.popup);
    setPick(e.popup.getLatLng());
  });
  function setPick(latlng) {
    const lat = +latlng.lat.toFixed(4), lon = +latlng.lng.toFixed(4);
    if (lat < BOX.latMin || lat > BOX.latMax || lon < BOX.lonMin || lon > BOX.lonMax) {
      say('bMsg', 'Lokasi harus di wilayah Indonesia.', 'bad'); return;
    }
    pick = { lat, lon };
    $('bLoc').className = 'loc set';
    $('bLoc').innerHTML = `<span class="mono">${lat.toFixed(4)}, ${lon.toFixed(4)}</span>`;
    say('bMsg', '');
    drawPick(); quote();
  }
  $('bRad').oninput = () => { $('bRadV').textContent = $('bRad').value + ' km'; drawPick(); quote(); };
  ['bMag', 'bDur', 'bCov'].forEach((id) => { $(id).oninput = quote; $(id).onchange = quote; });
  $('bBen').oninput = updateBuy;
  $('bBenMe').onclick = async (e) => { e.preventDefault(); if (await signerReady()) { $('bBen').value = W.addr; updateBuy(); } };

  let premium = null, qSeq = 0;
  function params() {
    const cov = Number($('bCov').value);
    return { radius: +$('bRad').value, magX10: +$('bMag').value, days: +$('bDur').value, cov, covOk: Number.isFinite(cov) && cov >= 1 };
  }
  async function quote() {
    if (!poolR) return;
    const p = params(), seq = ++qSeq;
    premium = null;
    if (!p.covOk) { $('bPrem').textContent = '–'; return updateBuy(); }
    $('bPrem').textContent = '…';
    try {
      const v = await poolR.quotePremium(p.magX10, p.radius, E(p.cov), p.days * 86400);
      if (seq !== qSeq) return; // a newer quote is on its way
      premium = v;
      $('bPrem').textContent = Number(ethers.formatEther(v)).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' mUSDT';
    } catch { if (seq === qSeq) $('bPrem').textContent = 'gagal memuat'; }
    updateBuy();
  }

  function updateBuy() {
    const b = $('bBuy'), p = params();
    const free = S ? S.pool.free : 0;
    $('bFree').textContent = S ? `maks ${nf.format(free)} mUSDT` : '';
    if (busy) { b.disabled = true; b.textContent = 'Memproses…'; return; }
    if (!W.addr) { b.disabled = false; b.textContent = 'Hubungkan wallet'; return; }
    b.disabled = true;
    if (!pick) b.textContent = 'Pilih lokasi di peta';
    else if (!p.covOk) b.textContent = 'Isi nilai cair';
    else if (p.cov > free) b.textContent = 'Nilai cair melebihi dana bebas pool';
    else if (!ethers.isAddress($('bBen').value.trim())) b.textContent = 'Isi alamat pemegang polis';
    else if (premium === null) b.textContent = 'Menghitung premi…';
    else { b.disabled = false; b.textContent = `Beli polis · ${Number(ethers.formatEther(premium)).toLocaleString('id-ID', { maximumFractionDigits: 2 })} mUSDT`; }
  }

  $('bBuy').onclick = async () => {
    if (!W.addr) return connect();
    const p = params(), at = pick, ben = ethers.getAddress($('bBen').value.trim()), prem = premium;
    const label = $('bLabel').value.replace(/\s+/g, ' ').trim(); // same normalisation as the server
    if (label && (label.length < 3 || /[<>]/.test(label))) return say('bMsg', 'Nama polis minimal 3 karakter, tanpa < atau >.', 'bad');
    run('buy', async (step) => {
      await ensureFunds(prem, step);
      step('Membeli polis (konfirmasi di wallet)…');
      const pool = poolR.connect(W.signer);
      const rc = await (await pool.buyPolicy(ben, Math.round(at.lat * 1e4), Math.round(at.lon * 1e4), p.radius, p.magX10, E(p.cov), p.days * 86400)).wait();
      const id = policyOf(rc).args.policyId.toString();
      let note = '';
      if (label) {
        try {
          step('Polis aktif. Tanda tangani nama polis (gratis, tanpa gas)…');
          const signature = await W.signer.signMessage(labelMessage(id, label));
          const r = await fetch('/api/label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, label, signature }) });
          if (!r.ok) note = `<br>Nama belum tersimpan: ${esc((await r.json().catch(() => ({}))).error || r.status)}`;
        } catch (e) { note = '<br>Nama tidak disimpan: ' + errText(e); }
      }
      pick = null; drawPick();
      $('bLoc').className = 'loc'; $('bLoc').textContent = 'Klik peta untuk memilih lokasi';
      $('bLabel').value = '';
      $('cAddr').value = ben;
      return `<b>Polis #${id} aktif.</b> Kalau gempa M${(p.magX10 / 10).toFixed(1)}+ terkonfirmasi dalam ${p.radius} km, ${nf.format(p.cov)} mUSDT langsung dikirim ke ${short(ben)}. ${txLink(rc.hash)}${note}`;
    }, 'bMsg');
  };

  // ---------------------------------------------------------------- check
  let balSeq = 0;
  function drawCheck() {
    if (!S) return;
    const a = $('cAddr').value.trim();
    if (!a) { $('cOut').innerHTML = '<p class="note">Masukkan alamat untuk melihat polis dan pembayaran yang diterima.</p>'; return; }
    if (!ethers.isAddress(a)) { $('cOut').innerHTML = '<p class="note">Alamat belum valid.</p>'; return; }
    const lo = a.toLowerCase();
    const mine = S.policies.filter((p) => p.beneficiary.toLowerCase() === lo || p.sponsor.toLowerCase() === lo);
    const tag = { active: '<span class="tag active">aktif</span>', paid: '<span class="tag paid">sudah dibayar</span>', expired: '<span class="tag expired">berakhir</span>',
      sim: '<span class="tag sim">dibayar (simulasi)</span>' };
    const sim = new Set(S.reports.filter((r) => r.simulated).map((r) => r.eventId));
    const date = (t) => new Date(t * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    $('cOut').innerHTML = `<p class="note" style="margin:0">Saldo mUSDT alamat ini: <b id="cBal">…</b></p>` + (mine.length ? mine.map((p) => {
      const role = p.beneficiary.toLowerCase() === lo ? (p.sponsor.toLowerCase() === lo ? 'pemegang polis' : 'penerima') : 'pembeli';
      return `<div class="pol"><div class="t"><a href="#" data-fly="${p.id}">${esc(p.label || 'Polis #' + p.id)}</a>${tag[p.status === 'paid' && sim.has(p.paidEvent) ? 'sim' : p.status]}</div>
        <div class="m">Nilai cair <b>${nf.format(p.coverage)} mUSDT</b> · gempa M${p.minMag.toFixed(1)}+ dalam ${p.radiusKm} km</div>
        <div class="m">${p.status === 'paid' ? `Dibayar ${p.paidAt ? date(p.paidAt) : ''} · ${txLink(p.paidTx)}` : 'Berlaku sampai ' + date(p.end)} · kamu: ${role}</div></div>`;
    }).join('') : '<p class="note">Belum ada polis untuk alamat ini.</p>');
    const seq = ++balSeq;
    tokenR.balanceOf(a).then((b) => { if (seq === balSeq && $('cBal')) $('cBal').textContent = U(b); }).catch(() => {});
  }
  $('cAddr').oninput = drawCheck;
  $('cOut').onclick = (e) => {
    const a = e.target.closest('[data-fly]'); if (!a) return;
    e.preventDefault();
    const p = S.policies.find((x) => x.id === a.dataset.fly);
    if (p) map.flyTo([p.lat, p.lon], 8);
  };

  // ---------------------------------------------------------------- LP
  let lp = null;
  async function drawLp() {
    if (!poolR || tab !== 'lp') return;
    try {
      const [ts, ta, free, lock, mine] = await Promise.all([poolR.totalShares(), poolR.totalAssets(), poolR.freeLiquidity(), poolR.withdrawLockedUntil(), W.addr ? poolR.shares(W.addr) : 0n]);
      lp = { ts, ta, free, lock: Number(lock), mine, value: ts > 0n ? (mine * ta) / ts : 0n };
      $('lTot').textContent = U(ta) + ' mUSDT';
      $('lFree').textContent = U(free) + ' mUSDT';
      $('lMine').textContent = W.addr ? `${U(lp.value)} mUSDT (${ts > 0n ? (Number((mine * 10000n) / ts) / 100).toFixed(2) : '0'}%)` : 'hubungkan wallet';
      const now = Math.floor(Date.now() / 1000);
      $('lLock').textContent = lp.lock > now ? 'dikunci sampai ' + new Date(lp.lock * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' WIB' : 'terbuka';
    } catch { /* RPC hiccup: keep last values */ }
  }
  $('lMax').onclick = (e) => { e.preventDefault(); if (lp && lp.value > 0n) $('lAmt').value = Math.floor(Number(ethers.formatEther(lp.value)) * 100) / 100; };
  $('lDep').onclick = async () => {
    if (!(await signerReady())) return;
    const amt = Number($('lAmt').value);
    if (!(amt > 0)) return say('lMsg', 'Isi jumlah setoran.', 'bad');
    run('deposit', async (step) => {
      await ensureFunds(E(amt), step);
      step('Menyetor ke pool (konfirmasi di wallet)…');
      const rc = await (await poolR.connect(W.signer).deposit(E(amt))).wait();
      return `${nf.format(amt)} mUSDT disetor ke pool. ${txLink(rc.hash)}`;
    }, 'lMsg');
  };
  $('lWd').onclick = async () => {
    if (!(await signerReady())) return;
    await drawLp();
    const amt = Number($('lAmt').value);
    if (!(amt > 0)) return say('lMsg', 'Isi jumlah penarikan.', 'bad');
    if (!lp || lp.mine === 0n) return say('lMsg', 'Wallet ini belum punya bagian di pool.', 'bad');
    // shares = amount * totalShares / totalAssets; within 0.01 of everything (the rounded "tarik semua") burns all shares
    const want = E(amt);
    const sh = want + E('0.01') >= lp.value ? lp.mine : (want * lp.ts) / lp.ta;
    run('withdraw', async () => {
      const rc = await (await poolR.connect(W.signer).withdraw(sh)).wait();
      return `Dana ditarik ke wallet kamu. ${txLink(rc.hash)}`;
    }, 'lMsg');
  };

  // ---------------------------------------------------------------- hook into the dashboard refresh
  window.afterDraw = (s) => {
    const first = !rp;
    initReaders(s);
    if (first) quote();
    updateBuy();
    if (tab === 'check') drawCheck();
  };
  if (S) window.afterDraw(S);
})();
