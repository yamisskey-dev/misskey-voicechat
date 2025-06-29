# Stage 1: Install dependencies
FROM node:20-slim AS deps
WORKDIR /app

# pnpmのインストール
RUN npm install -g pnpm

# ルートのpnpm-workspace.yamlと各パッケージのpackage.jsonをコピー
COPY ../../pnpm-workspace.yaml .
COPY ../mediasoup-worker/package.json ./packages/mediasoup-worker/
COPY ./package.json ./packages/signaling-server/

# 依存関係のみをインストール
RUN pnpm install --prod --frozen-lockfile

# Stage 2: Build the application
FROM node:20-slim AS runner
WORKDIR /app

# 前のステージからnode_modulesをコピー
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/signaling-server/node_modules ./packages/signaling-server/node_modules

# アプリケーションコードをコピー
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]