FROM node:20-slim AS build
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps/admin ./apps/admin
RUN npm install --no-audit --no-fund --legacy-peer-deps
# Next.js транспилирует @ustal/database и @ustal/domain из TS-исходников сам
# (см. transpilePackages в next.config.mjs) — отдельно их собирать не нужно.
RUN npm run build -w @ustal/admin

FROM node:20-slim
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4100
CMD ["npm", "run", "start", "-w", "@ustal/admin"]
