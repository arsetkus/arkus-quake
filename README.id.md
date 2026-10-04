# Asuransi Parametrik Gempa — BNB Chain (prototype hackathon)

[English](README.md) · **Bahasa Indonesia** · Live: https://arkuss.app · Demo presentasi: https://arkuss.app/demo

Pool asuransi parametrik: sponsor (Pemda, CSR, diaspora) membelikan polis untuk warga. Kalau gempa dengan magnitudo ≥ ambang terjadi dalam radius polis, dana cair otomatis ke penerima tanpa klaim, tanpa survei. **Belum diaudit, bukan produk asuransi berizin.**

## Struktur

```
contracts/ParametricQuakePool.sol  pool, polis, laporan oracle (EIP-712, N-of-M attester), klaim
contracts/MockUSDT.sol             stablecoin testnet (faucet)
compile.js / test.js               compile + 25 test kontrak
agent/sources.js                   ambil & normalisasi feed BMKG + USGS
agent/match.js                     aturan cross-check, bikin laporan, verifikasi attester (deterministik, tanpa LLM)
agent/chain.js                     tanda tangan EIP-712, submit, keeper claimBatch
agent/index.js                     CLI agent
agent/fixtures/padang-2009.json    data replay demo
agent/test-agent.js                13 test agent (unit + end-to-end + indeks)
scripts/deploy.js                  deploy BSC testnet (idempotent): generate key, MockUSDT, pool, LP, polis demo
scripts/demo.js                    polis demo warga Sumbar
scripts/verify.js                  verifikasi source kontrak di BscScan (npm run verify)
deployments/bsc-testnet.json       alamat kontrak yang sedang live
server/index.js                    1 proses: oracle loop + dashboard + API + replay demo
web/index.html + web/app.js        dashboard publik (arkuss.app): beli polis, cek polis, LP via wallet
deploy/install.sh                  installer VPS Ubuntu: Node 20, Caddy (HTTPS), systemd, ufw
```

## Deploy ke VPS

```
scp -r asuransi-gempa ubuntu@VPS:~/
ssh ubuntu@VPS 'bash ~/asuransi-gempa/deploy/install.sh'
```
Run pertama berhenti dengan `NEED_FUNDING` + alamat relayer. Kirim ~0,1 tBNB ke alamat itu, lalu jalankan lagi.
Key relayer & attester dibuat di VPS (`/opt/arkus-quake/.env`, chmod 600) dan tidak pernah keluar dari server.
Log: `journalctl -u arkus-quake -f`. Cloudflare: SSL/TLS mode **Full (strict)**.

## Jalankan

```
npm install
npm test                 # compile + 25 test kontrak + 13 test agent
cp .env.example .env     # isi POOL_ADDRESS, RELAYER_KEY, ATTESTER_KEYS
npm run agent:dry        # cek BMKG+USGS live, tampilkan gempa yang AKAN dilaporkan (tanpa key)
npm run agent:watch      # loop: cross-check -> attester tanda tangan -> submit -> keeper bayar
npm run agent:replay     # demo: replay gempa Padang 2009 (hanya pool allowSimulated=true)
npm run agent:keeper     # bayar semua polis yang eligible
```

## Alur oracle

1. **Fetch**: BMKG (`autogempa`, `gempaterkini`, `gempadirasakan`) + USGS FDSN (kotak Indonesia ±3°, 7 hari).
2. **Cross-check**: gempa dilaporkan hanya kalau dua lembaga sepakat: Δwaktu ≤ 120 dtk, Δjarak ≤ 150 km, Δmagnitudo ≤ 0,7, umur ≥ 20 menit.
3. **Laporan konservatif**: magnitudo = yang **lebih kecil** dari dua lembaga, lokasi = BMKG, waktu = USGS, `eventId = keccak("USGS:"+id)`, `sourcesHash` = hash snapshot kedua sumber (disimpan di `agent/data/`).
4. **Attester verifikasi sendiri**: tiap attester mengambil data sendiri dan menolak tanda tangan kalau magnitudo dinaikkan, epicenter digeser > 30 km, atau gempanya tidak dia lihat.
5. **Relayer** (siapa saja) submit laporan + tanda tangan. Kontrak cek threshold, lalu masa challenge (guardian bisa veto).
6. **Keeper** baca log `PolicyBought` + `ReportSubmitted`, saring di off-chain, konfirmasi `isEligible()`, bayar `claimBatch()`. Stateless dan idempotent.

## Fix kontrak v0.2

- `SETTLEMENT_GRACE` 10 → 14 hari. Sebelumnya gempa di hari terakhir polis bisa dilaporkan di hari ke-7 + challenge 3 hari = pas 10 hari, jadi kolateral bisa di-release sebelum sempat diklaim.
- Withdraw LP dikunci sejak laporan diterima sampai challenge window + 2 hari. Sebelumnya LP bisa tarik dana di harga sebelum payout dan melempar kerugian ke LP lain.
- `deposit` tidak lagi bagi-nol kalau pool habis total.

## Batasan yang perlu diketahui (untuk Q&A juri)

- **Pencairan masih biner, belum bertingkat.** Polis cair 100% kalau gempa memenuhi ambang magnitudo di dalam radius, selain itu tidak cair sama sekali. Sponsor sudah bisa mengatur radius dan ambang per polis (premi dihitung `quotePremium`), tapi warga yang sedikit di luar radius tidak dapat apa-apa (*basis risk*). Versi berikutnya: pencairan bertingkat menurut jarak dan magnitudo, misalnya 100% dalam 50 km, 50% dalam 100 km, 25% dalam 150 km.
- Owner bisa ganti attester/threshold seketika. Untuk produksi: owner = multisig + timelock.
- Kalau keeper mati > 14 hari setelah polis berakhir, polis eligible bisa ter-release tanpa dibayar. Siapa pun bisa menjalankan keeper.
- Harga premi masih placeholder, belum aktuaria.
- Demo menyimpan semua key attester di satu proses. Produksi: tiap attester di server/lembaga berbeda.
- Penerima masih butuh alamat wallet (bisa dibuatkan custodial/embedded oleh frontend).
