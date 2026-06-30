# プロジェクト構造

## 構成思想

関心ごとにディレクトリを分けるレイヤード構成。`src/` 配下を「機能ドメイン別のサブディレクトリ」で
まとめ、エントリポイント（`index.ts` / `discord.ts`）は **配線のみ**に徹する。ビジネスロジックは
ドメインモジュールに置き、エントリには置かない。バッチの実体は `src/` に、起動口は `scripts/` に分ける。

## ディレクトリパターン

### LLM プロバイダ層 (`src/llm/`)
**目的**: プロバイダ非依存の中立インターフェース（`provider.ts`）と各社アダプタ（`anthropic.ts` /
`gemini.ts` / `openai.ts`）、`factory.ts`、`errors.ts`。
**規則**: 中立層に特定 SDK の型を持ち込まない。差異はアダプタが吸収する。

### エージェント層 (`src/agent/`)
**目的**: ツール利用ループ（`agent.ts`）と、LLM に渡すツール群（`tools.ts` = FTS 検索、
`githubTools.ts` = tree/read/search）。

### ナレッジ層 (`src/kb/`)
**目的**: 取り込み・索引・検索・ライフサイクルの純粋ロジック（`chunk.ts` / `segment.ts` / `db.ts` /
`ingest.ts` / `issueDoc.ts` / `prune.ts`）。可能な限り副作用を持たない純粋関数にしてテスト可能に保つ。

### チャット層 (`src/chat/`)
**目的**: プラットフォーム非依存の回答コア（`core.ts`）と、プラットフォーム別の返信アダプタ
（`slack.ts` = mrkdwn、`discord.ts` = 2000 字分割）。コアは `ChatReply` 抽象に依存し、UI 差は端に寄せる。

### バッチ起動口 (`scripts/`)
**目的**: CLI のエントリ（`kb-ingest.ts` / `kb-search.ts` / `issue-to-kb.ts` / `kb-prune.ts` /
`kb-eval.ts` など）。ロジック本体は `src/` 側に置き、scripts は引数処理と呼び出しに徹する。

### 仕様ドキュメント (`docs/`)
**目的**: 個別ジョブの仕様書（`kb-prune-spec.md` 等）とエンドユーザ向けガイド（`USAGE.ja.md`）。

### テスト・サンプル・eval
`test/`（`*.test.ts`、`bun test`）、`samples/`（取り込み用サンプル `.md`）、`eval/`（ルーティング eval ケース）。

## 命名規則

- **ソースファイル**: キャメルケース（例 `githubTools.ts` / `issueDoc.ts`）。1 ファイル 1 関心。
- **テスト**: 対象名 + `.test.ts`（例 `prune.test.ts`）。
- **環境変数**: `KB_` プレフィックス（例 `KB_MODEL` / `KB_GITHUB_REPOS` / `KB_CACHE_TTL_HOURS`）。
- **CLI スクリプト**: ケバブケース（例 `kb-ingest.ts`）、`package.json` の `kb:*` に対応。

## インポート構成

```typescript
// 相対パス + .ts 拡張子付き（allowImportingTsExtensions / verbatimModuleSyntax）
import { search } from "./tools.ts";
import type { LlmProvider } from "../llm/provider.ts";
```

パスエイリアスは使わず相対 import。型のみの import は `import type` を使う（`verbatimModuleSyntax`）。

## コード構成の原則

- **依存方向**: エントリ → chat → agent → (llm / kb)。下位（llm/kb）が上位を知らない。
- **副作用の隔離**: 外部 I/O（R2/S3・GitHub・SQLite・LLM API）は専用モジュールに閉じ込め、
  ロジックは純粋関数に保ってテスト容易性を確保する。
- **抽象は端へ**: プロバイダ差・プラットフォーム差はアダプタ（端）に寄せ、コアは中立型のみに依存させる。

---
_パターンを記述し、ファイルツリーを列挙しない。パターンに従う新規ファイルは更新不要_
