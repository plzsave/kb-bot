# SPEC — kb-bot

> このファイルは**参照ハブ**。詳細な知識固定は `.kiro/steering/`(product / tech / structure)と
> `CLAUDE.md` が担う。ここには「再議論禁止の確定事項」の要約のみ置き、詳細は必ず参照先を読むこと。

## 目的

Slack / Discord 上で、Markdown ドキュメント(R2/S3)と実際の GitHub コードの**両方**を根拠に
出典付きで回答するナレッジ Bot。詳細: `.kiro/steering/product.md`

## 確定事項(再議論禁止)

- 埋め込み・ベクトル DB は使わない。検索は FTS5/BM25(`bun:sqlite`)
- 日本語検索は TinySegmenter + unicode61。`trigram` は検証の上で不採用
- ドキュメントとコードが食い違う場合は**コードを信頼源**とする
- LLM プロバイダ差は中立インターフェース(`src/llm/provider.ts`)の裏に隠す。
  特定 SDK の型を中立層へ持ち込まない
- モデル ID はエイリアスで人手管理。404 時はプロバイダ既定へランタイムフォールバック
- ランタイムは Bun。TypeScript strict + `noUncheckedIndexedAccess`
- 開発は軽量ループが既定。Kiro spec 駆動(`/kiro-*`)は**ユーザーが明示した時のみ**(CLAUDE.md 参照)

## スコープ外

- 埋め込みベースのセマンティック検索 / RAG パイプライン
- Lambda 等のサーバーレス常駐(Socket Mode が永続接続を要求)

## 参照先(詳細はこちらが正)

- 挙動ルール・PR フロー・eval 運用: `CLAUDE.md`
- プロダクト定義: `.kiro/steering/product.md`
- 技術決定・コマンド: `.kiro/steering/tech.md`
- コード構造: `.kiro/steering/structure.md`
- 人間向け検証手順: `CONTRIBUTING.md`

## 検証手順(E2E)

1. `bun run typecheck && bun test && bun run format:check`
2. LLM サーフェスを触った場合のみ `bun run kb:eval`(baseline 更新は人間の判断。勝手に `--update-baseline` しない)
