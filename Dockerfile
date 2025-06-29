FROM node:22.15.0-bookworm AS base
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++

COPY package.json ./
COPY package-lock.json* ./
COPY packages/ ./packages/

RUN npm ci --omit=dev || npm install --omit=dev

FROM base AS signaling_server_build

COPY --from=deps /app .

WORKDIR /app/packages/signaling-server

EXPOSE 3000
CMD ["node", "server.js"]


FROM base AS mediasoup_worker_build

COPY --from=deps /app .

WORKDIR /app/packages/mediasoup-worker

EXPOSE 4000
CMD ["node", "worker.js"]