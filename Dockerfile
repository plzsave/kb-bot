# bun ランタイム。1.x の最新安定を追従（パッチ固定はしない）。
FROM oven/bun:1 AS base
WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる。実行時は devDeps 不要なので --production。
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# アプリ本体
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# FTS インデックス／回答キャッシュの置き場（compose でボリュームマウントする）
ENV KB_DB_PATH=/app/data/kb.sqlite
RUN mkdir -p /app/data

# 起動時に R2 から取り込み→Bot 起動（FTS は派生物なので毎回再構築でよい）
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
