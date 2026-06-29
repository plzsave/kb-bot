# 技術スタック

## アーキテクチャ

単一の常駐プロセス（Socket Mode / Gateway で永続接続を張る）として動く Bot と、
スケジュール実行する複数の CLI バッチからなる。回答生成は「エージェントのツール利用ループ」で、
LLM が `search_knowledge`（FTS）と GitHub ツール群（tree/read/search）を呼びながら答えを組み立てる。

**レイヤリングの肝**：LLM プロバイダ差は中立インターフェース（`src/llm/provider.ts`）の裏に隠し、
agent ループと chat コアは中立型のみに依存する。特定 SDK の型を中立層へ持ち込まない。
コスト節約の中核（回答キャッシュ・FTS5 検索）は LLM API を一切触らない＝この層の外に置く。

## コア技術

- **言語**: TypeScript（strict、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`）
- **ランタイム**: Bun（`bun:sqlite`、`bun test`、`bun --watch` を全面採用）
- **プラットフォーム SDK**: `@slack/bolt`（Socket Mode）、`discord.js`（Gateway）
- **LLM SDK**: `@anthropic-ai/sdk` / `@google/genai` / `openai`（プロバイダごとのアダプタ）
- **ストレージ**: R2/S3（`aws4fetch` で素のアクセス）＋ SQLite（FTS5 索引・回答キャッシュ・usage ログ）
- **日本語検索**: `tiny-segmenter`（形態素分割）＋ FTS5 `unicode61`（`trigram` は不採用）

## 重要な技術的決定

- **埋め込み／ベクトル DB を使わない**：検索は FTS5/BM25 の全文検索。安価で運用が軽い。
- **日本語は TinySegmenter + unicode61**：`trigram` では 2 文字語（例「認証」）が拾えず、
  助詞が結合すると再現率が落ちたため検証の上で切り替えた。
- **モデル ID は人手管理の config**：価格は API で取れないため自動選択しない。dated snapshot ではなく
  エイリアス（例 `claude-haiku-4-5`）を使い、404 時はプロバイダ既定モデルへランタイムフォールバックする。
- **依存は最小限**：大きなフレームワークを避け、薄いアダプタと純粋関数で構成する。

## 開発標準

### 型安全
TypeScript strict 前提。`noUncheckedIndexedAccess` が有効なので配列・レコードアクセスは undefined 込みで扱う。

### テスト
`bun test`。テスト対象は資格情報不要の純粋関数が中心（チャンク分割・分割器・prune ロジック・LLM マッピング等）。
外部 I/O はテスト境界の外に置く設計にする。

### バージョン識別子
外部バージョンは記憶で書かない。npm は `bun add` / `bun add -d` で追加し、`package.json` に直書きしない。

## よく使うコマンド

```bash
bun install                # 依存導入
bun run start              # Slack 起動（または start:discord / dev / dev:discord）
bun run kb:ingest          # R2/S3 の .md を取り込み FTS5 索引化
bun run kb:search "..."    # BM25 検索結果の目視確認
bun run kb:issues          # 解決済み Issue → 正規化 Markdown（育てる）
bun run kb:prune           # 陳腐化候補のレポート（--apply で _stale/ へ退避）
bun run kb:eval            # ルーティング eval ハーネス（ライブ LLM + GitHub）
bun run typecheck          # tsc --noEmit
bun test                   # ユニットテスト
```

## デプロイ環境

Socket Mode は永続接続のため常駐が必須（Lambda 不可）。Docker 単一コンテナで VPS / Fly.io /
Railway / Render / ECS Fargate / 自宅サーバのいずれでも動く。`docker-entrypoint.sh` が起動時に
`kb:ingest` してから Bot を起動する。回答キャッシュは `/app/data` ボリュームで永続化する。

---
_標準とパターンを記述し、全依存を列挙しない_
