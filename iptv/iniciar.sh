#!/usr/bin/env bash
# Liga o servidor IPTV e, se o cloudflared estiver instalado, abre o acesso de qualquer lugar.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Instale o Node.js (https://nodejs.org) e rode de novo."; exit 1; }
if [ ! -f data/auth.json ] && [ ! -f .env ]; then
  echo "=== Primeira vez: crie o seu login ==="
  node set-login.js || exit 1
fi
export TRUST_PROXY=1
node server.js &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT INT TERM
if command -v cloudflared >/dev/null; then
  sleep 3
  echo
  echo "== Procure abaixo o endereço https://...trycloudflare.com e abra no celular/TV =="
  cloudflared tunnel --url http://localhost:8787
else
  echo
  echo "Servidor na rede Wi-Fi. Para acessar de qualquer lugar instale o cloudflared:"
  echo "  Mac: brew install cloudflared   |   Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  wait $SRV
fi
