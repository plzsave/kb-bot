# Brief: eval-next-step

## Source
GitHub issue #31（親: #27 評価基盤マイルストーン / 依存: #28）

## Problem
非エンジニアの「独力解決」が最も崩れるのは**答えられなかった時**。現状 `buildSystem` は未発見時に「推測せず、見つからない旨を述べよ」までしか指示しておらず、**次の一歩**（対象名・キーワードの補足を促す／言い換え／資料を足せば答えられる旨）を出す指示が無い。ただ「見つかりませんでした」で突き放すと利用者は結局エンジニアに聞きに行く＝自立失敗。加えて、その振る舞いを測る eval が無い（軸 D は #27 で「計測なし」）。

## Current State
- `src/chat/core.ts` `buildSystem`（L29）: `When you cannot find the fact, do not guess; state that you could not find it ...` で止まっている（次の一歩の指示なし）。
- `scripts/kb-eval.ts`: `Expect`（L22-37）/ `evalCase()`（L65-108）に「次の一歩」を採点する項目が無い。
- `eval/cases.json`: 軸 D のケースが無い。
- 参考 UI: `docs/USAGE.ja.md`「見つかりませんでした」節（聞き方を具体的に／資料追加で答えられる）と方針を一致させる。

## Desired Outcome
- ナレッジにもコードにも事実が無い質問で、回答が **(a) 見つからない旨** と **(b) 具体的な次の一歩** を含む。推測（断定的な作り話）はしない。
- `expect.offersNextStep: true` を指定したケースで「次の一歩」の有無を採点でき、突き放せば FAIL・次の一歩を返せば PASS になる軸 D ケースが存在する。
- 既存 7 ケースは全 PASS（後方互換）、`bun run typecheck` クリーン。

## Approach
最小介入の 2 点セット：
1. `buildSystem` の未発見指示（L29）に「次の一歩を 1 文添える」を**最小限**追記（[Safety] / [Output style] を弱めない・出力言語自動判別を保つ）。
2. `kb-eval.ts` の `Expect` に `offersNextStep` を追加し `evalCase()` で判定（過剰一致を避けるため複数語 OR の語彙リスト等の単純判定）。既存 guard ケース（`answerOmits: ["おそらく","推定では","と思われます"]`）と整合させる。
3. `eval/cases.json` に `axis: "D"` のケースを追加。

## Scope
- **In**: `buildSystem` への未発見時「次の一歩」最小追記 / `kb-eval.ts` の `Expect` 拡張（`offersNextStep`）と `evalCase()` 判定 / `eval/cases.json` の D ケース追加。
- **Out**: 「近い情報のサジェスト（部分ヒットの提示）」等の検索機能拡張（将来 A 軸）。ここは**未発見時の振る舞い**に限定。

## Boundary Candidates
- プロンプト側（`buildSystem` の未発見時ガイダンス）
- eval 採点側（`Expect` スキーマ + `evalCase()` 判定 + ケースデータ）

## Out of Boundary
- retrieval / 検索精度・部分ヒット提示（A 軸、将来）
- 昇格トリガやモデル構成の変更（別途、評価基盤の後）

## Upstream / Downstream
- **Upstream**: #28 eval-scorecard（軸タグ・合否ゲート・スコアカード基盤）に依存。
- **Downstream**: #27 マイルストーン完了。以降の A 軸（retrieval）改善や、「コードを見に行かせる」挙動改善を測る土台。

## Existing Spec Touchpoints
- **Extends**: なし（新規単一スコープ）。
- **Adjacent**: eval-scorecard / eval-citation-check / eval-drift-tolerance（`kb-eval.ts` の `Expect`/`evalCase()`/`cases.json` を共有 — 破壊しないこと）。

## Constraints
- 既存 7 ケースを壊さない。出力言語自動判別（質問と同じ言語）を保つ。[Safety]/[Output style] を弱めない。`bun run typecheck` クリーン。
