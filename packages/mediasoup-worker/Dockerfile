# Stage 1: Install dependencies
FROM node:20-slim AS deps
WORKDIR /app

# pnpmのインストール
RUN npm install -g pnpm

# ルートのpnpm-workspace.yamlと各パッケージのpackage.jsonをコピー
COPY ../../pnpm-workspace.yaml .
COPY ../signaling-server/package.json ./packages/signaling-server/
COPY ./package.json ./packages/mediasoup-worker/

# 依存関係のみをインストール
RUN pnpm install --prod --frozen-lockfile

# Stage 2: Build the application
FROM node:20-slim AS runner
WORKDIR /app

# 前のステージからnode_modulesをコピー
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/mediasoup-worker/node_modules ./packages/mediasoup-worker/node_modules

# アプリケーションコードをコピー
COPY . .

EXPOSE 4000

CMD ["node", "worker.js"]