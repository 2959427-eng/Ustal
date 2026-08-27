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
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api npm run db:migrate
docker compose -f docker-compose.prod.yml exec api npm run db:seed
docker compose -f docker-compose.prod.yml exec api npm run db:seed-admin
curl -fsS https://$API_DOMAIN/health
```

When using the EU relay, set:

```bash
AI_PROVIDER=openai
OPENAI_BASE_URL=https://ai-relay.example.com/v1
OPENAI_API_KEY=<same value as RELAY_CLIENT_TOKEN on the relay VPS>
```

Do not put the real OpenAI key on the main app server.

