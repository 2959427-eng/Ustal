#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash infra/timeweb/scripts/bootstrap-ubuntu.sh" >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git docker.io docker-compose-plugin ufw

systemctl enable --now docker

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

docker version >/dev/null
docker compose version >/dev/null

echo "Ubuntu host is ready for USTAL Docker deployment."
