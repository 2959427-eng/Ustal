FROM node:22-slim
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN npm install --no-audit --no-fund --legacy-peer-deps

# См. комментарий в apps/api/Dockerfile — worker тоже запускается через tsx.
CMD ["npm", "run", "start", "-w", "@ustal/worker"]
