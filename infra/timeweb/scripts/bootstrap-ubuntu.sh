#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash infra/timeweb/scripts/bootstrap-ubuntu.sh" >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git docker.io ufw

if ! apt-get install -y docker-compose-plugin; then
  compose_version="${COMPOSE_VERSION:-v2.29.7}"
  case "$(uname -m)" in
    x86_64 | amd64) compose_arch="x86_64" ;;
    aarch64 | arm64) compose_arch="aarch64" ;;
    *)
      echo "Unsupported architecture for Docker Compose fallback: $(uname -m)" >&2
      exit 1
      ;;
  esac

  install -d /usr/local/lib/docker/cli-plugins
  curl -fsSL \
    "https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-${compose_arch}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

systemctl enable --now docker

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

docker version >/dev/null
docker compose version >/dev/null

echo "Ubuntu host is ready for USTAL Docker deployment."
