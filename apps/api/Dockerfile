FROM node:22-slim
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npm install --no-audit --no-fund --legacy-peer-deps

# Пакеты (packages/*) — TS-исходники, запускаются напрямую через tsx (без
# отдельного шага компиляции dist — см. docs/architecture.md, раздел про
# MVP-прагматизм монорепозитория). typecheck остаётся гейтом в CI.
EXPOSE 4000
CMD ["npm", "run", "start", "-w", "@ustal/api"]
