# Brief: eval-drift-tolerance

## Source
GitHub issue #30

## Problem
開発・保守が継続するシステムでは docs が継続的に陳腐化し、コードだけが現実を反映する。`buildSystem`（`src/chat/core.ts` L36-39）は GitHub 有効時に「docs とコードが食い違ったらコードを優先（If the docs and the code disagree, prefer the code）」と指示しているが、**この規則が実際に発火するかを一度も検証していない**。古い doc と新しいコードが矛盾する状況を意図的に作らない限り、「開発・保守が継続するシステムでも正しくあり続ける」という中核目標（軸 B′ = ドリフト耐性）が回帰しても客観採点で検知できない。

## Current State
- ドリフト規則本体は存在する: `src/chat/core.ts` `buildSystem` の `[Important] ... treat the ACTUAL CODE as the source of truth ... If the docs and the code disagree, prefer the code.`（L36-39、確認済み）。GitHub 未設定時はこの規則自体が付与されない（`withGh` 分岐）。
- eval ハーネス `scripts/kb-eval.ts` は `openDb(dbPath())` と `search(db, ...)`（issue 記載の L122 / L151 付近）で**本番 KB を索引・検索**しており、矛盾フィクスチャを食わせる仕組みが無い。
- 採点基盤は整備済み: `Expect`（`toolsUsedAny` / `toolsUsedAll` / `source` / `argIncludes` / `readPathIncludes` / `answerIncludes` / `answerOmits` / `citesSource`）と `evalCase(expect, calls, answer)`。`citesSource`（軸 B′ 出典検査）は #36（eval-citation-check）で追加済み。軸タグ・合否ゲート・スコアカードの枠は #28（eval-scorecard）が実装済み。
- `eval/cases.json` の既存ケースはすべて `axis: "B"`。docs 古 × コード新の「矛盾」を突くケースは無い。
- 兄弟スペック `eval-citation-check`（#29）は自らの Out 欄で「docs とコードの『ドリフト』検証（#30 が所有）」と明示しており、本スペックはその未所有領域を担う。

## Desired Outcome
- 「ある事実について doc は古い値 X を述べ、実コードは現在値 Y を持つ」矛盾ケースが eval に追加され、bot が **Y を述べ・コード（`path:line`）を出典に挙げ・X を主張しない**なら PASS、doc の古い値 X を述べれば FAIL になる。
- 矛盾シナリオ用の **eval 専用フィクスチャ docs** と、それを索引した **eval 専用インデックス**が本番 KB と分離されており、本番 KB を汚さない。
- GitHub 未設定で実行した場合、本ケースは既存の `needsGh` 規則で SKIP され、誤った FAIL を出さない。
- 既存ケースは無改修で PASS し、`bun run typecheck` がクリーン。

## Approach
矛盾フィクスチャ（「いかにも本物だが古い」doc）を `eval/` 配下に閉じて用意し、それを索引した **eval 専用インデックスを本番 KB と別パスに構築**して `search()` に食わせる（具体方式＝一時 SQLite を別パスに作る／`KB_DB_PATH` 差し替え等は設計で確定）。矛盾ケースは `eval/cases.json`（または `eval/cases.drift.json`）に `axis: "B"` で追加し、採点は既存フィールドの組み合わせ（`answerIncludes: [Y]` かつ `answerOmits: [X]` かつ `source: "code"` または `readPathIncludes`）で行う。本番コード `src/` は変更しない。

**矛盾ペアの候補（設計で 1 つ確定）**:
- キャッシュ TTL: doc「無期限」(X) ↔ コード既定 24h(Y)。根拠 `src/cache.ts` `TTL_MS`（L9-12、確認済み）。**安定・明確で推奨**。
- 全文検索トークナイザ: doc「trigram を使う」(X) ↔ コードは `unicode61`(Y)。根拠 `src/kb/segment.ts` の FTS5(unicode61) コメント（確認済み）。
- 既定モデル退役時の挙動: doc と `runAgentWithFallback` 実装の差（相対的に不安定・非推奨）。

## Scope
- **In**:
  - 矛盾シナリオ用フィクスチャ docs（eval 専用、`eval/` 配下）
  - フィクスチャを索引する eval 専用インデックスの構築手段（本番 KB と別パス／別 DB。方式は設計で決定）
  - `eval/cases.json`（または `eval/cases.drift.json`）への矛盾ケース追加（`axis: "B"`、`source: "code"` 系採点）
  - GitHub 未設定時の SKIP（既存 `needsGh` 規則に載せる）
- **Out**:
  - 本番コード `src/` の変更（ドリフト規則 `buildSystem` 自体は検証対象であって改修対象ではない）
  - doc 陳腐化の自動検出（`kb-prune` 側）の改善
  - 出典体裁の検査そのもの（#29 = eval-citation-check が所有・`citesSource` 実装済み）
  - 軸タグ・合否ゲート・スコアカードの枠（#28 = eval-scorecard が所有・実装済み）

## Boundary Candidates
- **フィクスチャ + eval 専用インデックス**: 矛盾 doc の作成と、本番 KB と分離した索引・検索経路の組み立て（`scripts/kb-eval.ts` の `openDb`/`search` への差し込み点）
- **矛盾ケースの採点**: `eval/cases.json` への矛盾ケース追加と、既存 `Expect` フィールド（`answerIncludes`/`answerOmits`/`source`/`readPathIncludes`）による「コードを正答に採ったか」の判定

## Out of Boundary
- ドリフト規則（`buildSystem` の prefer-the-code）の文言変更・強化
- doc 側の陳腐化を自動検出・自動修正する仕組み
- 意味的忠実性の LLM ジャッジ導入

## Upstream / Downstream
- **Upstream**: #28 eval-scorecard（軸タグ・ゲート・スコアカードの枠、実装済み）／`scripts/kb-eval.ts` の索引・検索経路（`openDb`/`search`）／`src/chat/core.ts` の GitHub 有効時ドリフト規則
- **Downstream**: 親マイルストーン #27（評価基盤）。ドリフト耐性が客観採点対象になることで「開発・保守が継続するシステム」目標の回帰検知が可能になる

## Existing Spec Touchpoints
- **Extends**: なし（新規スペック）
- **Adjacent**: `eval-citation-check`（#29、`citesSource`・出典検査。矛盾ケースの採点で `readPathIncludes` と併用しうるが所有は分離）／`eval-scorecard`（#28、軸・ゲート枠）。両者の既存ケース・枠を改修しないこと

## Constraints
- 本番 KB（`kb.sqlite` 等）を汚さない。フィクスチャと索引は `eval/` 配下・別パスに閉じる
- フィクスチャ doc の X（古い値）とコードの Y（現在値）は明確に異なり、Y は安定した実在の事実であること
- GitHub 未設定時は SKIP（誤 FAIL を出さない）。既存ケースは無改修で PASS。`bun run typecheck` クリーン
