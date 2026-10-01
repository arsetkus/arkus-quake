#!/usr/bin/env bash
# Install / update ARKUS Asuransi Gempa on Ubuntu (22.04/24.04). Idempotent: safe to re-run.
#   bash deploy/install.sh            (run from the uploaded project folder, as a sudo user)
# Shared-VPS safe: reuses an existing nginx or Caddy, never enables a firewall that was off,
# and picks a free local port.
set -euo pipefail
DOMAIN="${DOMAIN:-arkuss.app}"
APP=/opt/arkus-quake
SRC="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
UNIT_FILE=/etc/systemd/system/arkus-quake.service

port_busy() { sudo ss -ltnH "sport = :$1" | grep -q .; }

echo "==> packages"
# repo Caddy dari cloudsmith (kunci GPG expired) bikin apt-get update error: lepas
if [ -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  sudo rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "   removed broken caddy cloudsmith repo"
fi
sudo apt-get update -qq || echo "   (apt update warning ignored)"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y rsync python3 >/dev/null

# --- which web server owns :80/:443?
WEB=""
if systemctl is-active --quiet nginx; then WEB=nginx
elif systemctl is-active --quiet apache2; then WEB=apache
elif command -v caddy >/dev/null || ! port_busy 80; then WEB=caddy
fi
if [ -z "$WEB" ] || [ "$WEB" = apache ]; then
  echo "Port 80 dipakai program lain (bukan nginx/caddy):"; sudo ss -ltnp "sport = :80" || true
  echo "Kirim output ini ke Claude."; exit 3
fi
if [ "$WEB" = caddy ] && ! command -v caddy >/dev/null; then
  sudo apt-get install -y caddy   # paket resmi Ubuntu (universe)
fi
if [ "$WEB" = nginx ]; then sudo apt-get install -y certbot python3-certbot-nginx >/dev/null; fi
echo "   web server: $WEB"

echo "==> code -> $APP"
sudo mkdir -p "$APP" && sudo chown "$USER_NAME":"$USER_NAME" "$APP"
rsync -a --delete --exclude node_modules --exclude build --exclude .env --exclude data --exclude agent/data "$SRC"/ "$APP"/
cd "$APP"
npm install --omit=dev --no-audit --no-fund
node compile.js
[ -f .env ] || { cp .env.example .env; chmod 600 .env; }
grep -q '^CHALLENGE_SECONDS=' .env || echo 'CHALLENGE_SECONDS=180' >> .env

echo "==> service"
sudo systemctl stop arkus-quake 2>/dev/null || true
sleep 1
PORT=""
[ -f "$UNIT_FILE" ] && PORT="$(grep -oP 'PORT=\K[0-9]+' "$UNIT_FILE" || true)"
if [ -z "$PORT" ] || port_busy "$PORT"; then   # keep our old port unless another app took it
  PORT=""
  for p in 3000 3107 3217 3333; do port_busy "$p" || { PORT=$p; break; }; done
fi
[ -n "$PORT" ] || { echo "no free port"; exit 1; }
sudo tee "$UNIT_FILE" >/dev/null <<UNIT
[Unit]
Description=ARKUS Asuransi Gempa (oracle agent + dashboard)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP
Environment=NODE_ENV=production PORT=$PORT
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now arkus-quake
echo "   app on 127.0.0.1:$PORT"

echo "==> web ($DOMAIN via $WEB)"
if [ "$WEB" = caddy ]; then
  # only our own block between markers is touched; the package's default :80 demo site is dropped
  sudo DOMAIN="$DOMAIN" PORT="$PORT" python3 - <<'PY'
import os, re
p = '/etc/caddy/Caddyfile'
s = open(p).read() if os.path.exists(p) else ''
if '/usr/share/caddy' in s and 'BEGIN arkus-quake' not in s:
    s = ''  # untouched package default
s = re.sub(r'# BEGIN arkus-quake.*?# END arkus-quake\n?', '', s, flags=re.S)
d, port = os.environ['DOMAIN'], os.environ['PORT']
block = f"# BEGIN arkus-quake\n{d}, www.{d} {{\n\tencode gzip\n\treverse_proxy 127.0.0.1:{port}\n}}\n# END arkus-quake\n"
open(p, 'w').write(s.rstrip() + ('\n\n' if s.strip() else '') + block)
PY
  sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  sudo systemctl enable --now caddy >/dev/null 2>&1 || true
  sudo systemctl reload caddy || sudo systemctl restart caddy
else
  sudo tee /etc/nginx/sites-available/arkus-quake.conf >/dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  sudo ln -sf /etc/nginx/sites-available/arkus-quake.conf /etc/nginx/sites-enabled/arkus-quake.conf
  sudo nginx -t && sudo systemctl reload nginx
  sudo certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d "$DOMAIN" -d "www.$DOMAIN" \
    || echo "   certbot gagal (cek DNS/Cloudflare); situs tetap jalan di http"
fi

echo "==> firewall"
if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  sudo ufw allow 80/tcp >/dev/null; sudo ufw allow 443/tcp >/dev/null; echo "   ufw: 80/443 allowed"
else
  echo "   ufw inactive: tidak diubah (buka port 80/443 di security group Tencent Cloud)"
fi

echo "==> contracts (BSC testnet)"
set +e; node scripts/deploy.js; rc=$?; set -e
sudo systemctl restart arkus-quake   # picks up POOL_ADDRESS once deployed
sleep 4
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "service not healthy"; sudo journalctl -u arkus-quake -n 30 --no-pager; exit 1; }

echo "==> https check"
# Cloudflare Full (strict) gives 525 until the origin serves a valid cert on :443
TLS_OK=""
for i in $(seq 1 12); do
  curl -fsS -m 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null 2>&1 && { TLS_OK=1; break; }
  sleep 5
done
if [ -n "$TLS_OK" ]; then
  echo "   sertifikat $DOMAIN OK"
else
  echo "   TLS_FAIL: sertifikat $DOMAIN belum terbit."
  echo "   Di Cloudflare: set record arkuss.app & www ke 'DNS only' (awan abu-abu) atau matikan 'Always Use HTTPS',"
  echo "   jalankan installer lagi, lalu kembalikan ke Proxied + SSL Full (strict)."
  if [ "$WEB" = caddy ]; then sudo journalctl -u caddy -n 20 --no-pager | grep -iE 'error|challenge|obtain' || true; fi
fi
if [ $rc -eq 2 ]; then
  echo; echo "HOST_OK: https://$DOMAIN sudah online (mode setup)."
  echo "Isi tBNB ke alamat relayer di atas, lalu jalankan lagi: bash $SRC/deploy/install.sh"; exit 2
fi
[ $rc -eq 0 ] || exit $rc
echo "INSTALL_OK  https://$DOMAIN"
