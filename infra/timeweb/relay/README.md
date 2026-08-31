# USTAL OpenAI relay on Timeweb EU VPS

This service runs separately from the main USTAL backend. Use a small Timeweb Cloud server in Frankfurt or Amsterdam. The current deployment target is Amsterdam (`ustal-openai-relay-ams`).

## Files

- `docker-compose.yml` — Caddy reverse proxy.
- `Caddyfile` — TLS, health check, protected `/v1/*` proxy to OpenAI.
- `.env.example` — copy to `.env` and fill on the server.

## Deploy

```bash
cp .env.example .env
nano .env
bash ../scripts/deploy-relay.sh
bash ../scripts/verify-relay.sh
```

Security model:

- `OPENAI_API_KEY` in this folder is the real OpenAI key and stays only on the relay VPS.
- `RELAY_CLIENT_TOKEN` is a long random shared secret.
- Main USTAL app uses `OPENAI_BASE_URL=https://<relay-domain>/v1` and `OPENAI_API_KEY=<RELAY_CLIENT_TOKEN>`.
- Caddy rejects `/v1/*` without `Authorization: Bearer <RELAY_CLIENT_TOKEN>` and replaces it with the real OpenAI key upstream.
- If an authenticated `/v1/models` request returns OpenAI `invalid_api_key`, the relay authentication layer passed and the real key on the relay must be replaced.
