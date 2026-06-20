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
ENV KB_HEARTBEAT_FILE=/tmp/kb-bot.heartbeat
RUN mkdir -p /app/data

# 死活監視: Bot がハートビートファイルを更新し続けているか（90 秒以内）を確認する。
# クラッシュは exit→restart で拾えるが、ハング（イベントループ停止）はこれで検知できる。
# start-period はブートと初回取り込み（kb:ingest）の時間を見込む。
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD test "$(( $(date +%s) - $(stat -c %Y "${KB_HEARTBEAT_FILE:-/tmp/kb-bot.heartbeat}" 2>/dev/null || echo 0) ))" -lt 90

# 起動時に R2 から取り込み→Bot 起動（FTS は派生物なので毎回再構築でよい）
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
