#!/bin/sh
# 起動時に R2/S3 のナレッジを取り込んで FTS インデックスを作り、その後 Bot を起動する。
# FTS は R2 から導出する派生物なので、コンテナ起動のたびに作り直してよい。
# 永続ボリュームに既存インデックスがある場合などは KB_INGEST_ON_BOOT=false でスキップできる。
set -e

if [ "${KB_INGEST_ON_BOOT:-true}" = "true" ]; then
  echo "[entrypoint] ナレッジ取り込み開始（KB_INGEST_ON_BOOT=true）"
  bun run kb:ingest
else
  echo "[entrypoint] 取り込みをスキップ（KB_INGEST_ON_BOOT=false）"
fi

# KB_PLATFORM=slack(既定) / discord で起動先を選ぶ
case "${KB_PLATFORM:-slack}" in
  discord)
    echo "[entrypoint] Discord Bot 起動"
    exec bun run start:discord
    ;;
  *)
    echo "[entrypoint] Slack Bot 起動"
    exec bun run start
    ;;
esac
