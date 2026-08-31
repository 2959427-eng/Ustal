# USTAL app on Timeweb VPS

This compose stack runs the main USTAL backend:

- API (`apps/api`)
- worker (`apps/worker`)
- admin (`apps/admin`)
- PostgreSQL 16 with pgvector
- Caddy TLS reverse proxy

## Deploy

```bash
cp .env.example .env
nano .env
bash ../scripts/deploy-app.sh
bash ../scripts/verify-app-ai-route.sh
bash ../scripts/verify-app-storage.sh
```

When using the EU relay, set:

```bash
AI_PROVIDER=openai
OPENAI_BASE_URL=https://ai-relay.example.com/v1
OPENAI_API_KEY=<same value as RELAY_CLIENT_TOKEN on the relay VPS>
```

Do not put the real OpenAI key on the main app server.
