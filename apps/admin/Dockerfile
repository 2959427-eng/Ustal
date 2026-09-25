FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/admin ./apps/admin
RUN npm ci --include=dev --no-audit --no-fund --legacy-peer-deps
# Next.js транспилирует workspace-пакеты (@ustal/database, @ustal/domain,
# @ustal/config, @ustal/validation, @ustal/queue) из TS-исходников сам (см.
# transpilePackages + resolve.extensionAlias в next.config.mjs — Фаза 8,
# architecture.md §5 п.21) — отдельно их собирать не нужно.
RUN npm run build -w @ustal/admin

FROM node:22-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4100
CMD ["sh", "-c", "node --import tsx --input-type=module -e 'import {loadEnv} from \"@ustal/config\"; loadEnv();' && exec npm run start -w @ustal/admin"]
