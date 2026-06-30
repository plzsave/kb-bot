# Brief: eval-scorecard

## Problem
評価基盤の所有者（メンテナ／プロジェクト目標「非エンジニアの独力解決」到達度を測りたい人）が、
現在の eval では「ルーティングとモノレポ深掘りが効くか」をツール痕跡で採点できるだけで、
**目標到達度を軸別に測る**手段を持たない。後続の B′・D・安全ケースを載せる土台が無い。

## Current State
`scripts/kb-eval.ts` + `eval/cases.json` が存在する。
- 採点は `evalCase()`、型は `Expect`/`Case`（L22-43）。`expect` は「指定項目だけ検査」方針。
- 末尾は総合のみ集計し `=== passed/total PASS ===` を表示して `process.exit`（L178-180）。
- GitHub 未設定時は GitHub を要するケースを SKIP する（`needsGh`、L133-142）。
- 既存ケースは 7 件。軸タグ・合否ゲート・軸別集計の概念が無い。

## Desired Outcome
ケースを評価軸（A/B′/C/D/safety）でタグ付けでき、実行末尾に**軸別 pass/total** を出す。
`gate: true` のケースは**合否ゲート**として扱い、1 つでも FAIL なら全体を不合格（exit code 非 0）にする。
実行末尾に「軸別集計＋ゲート合否＋総合 PASS 数」を含む**スコアカード**を表示する。
既存 7 ケースは無改修で全 PASS を維持する。

## Approach
既存の `evalCase()`／「指定項目だけ検査」方針／`needsGh` SKIP 挙動はそのままに、
`Case` に任意フィールド `axis`・`gate` を追加する**枠の拡張**として実装する。新採点種別の中身は持ち込まない。
集計ループで軸別カウンタとゲート FAIL を別管理し、最後にスコアカードを出力、終了コードは
「スコア軸の全 PASS かつゲート全 PASS」で 0、いずれか欠ければ非 0 にする。SKIP はゲート判定に含めない。
外部依存の追加なし。理由: 後方互換を壊さず最小差分で「タグ／ゲート／集計」の土台だけを提供できるため。

## Scope
- **In**: `scripts/kb-eval.ts`（`Case`/`Expect` 型、`needsGh`、末尾集計・exit）、`eval/cases.json`、
  必要なら `eval/cases.sample.json` の追従。
- **Out**: 本番コード `src/` の変更、新しい採点種別の中身（出典必須・忠実性・次の一歩 = #29/#31）、外部依存の追加。

## Boundary Candidates
- ケース型の拡張（`axis`・`gate` フィールドと既存 `Expect` の不変維持）
- 集計・スコアカード出力ロジック（軸別カウント／ゲート FAIL とスコア FAIL の区別／総合）
- 終了コード判定（ゲート FAIL を最優先で非 0、SKIP は除外）

## Out of Boundary
- 新採点種別（出典必須・忠実性・次の一歩）の実装 → #29/#31 が所有
- 本番回答ロジック（`src/`）の挙動変更
- 評価ケースの中身そのもの（B′/D/safety ケースの追加）

## Upstream / Downstream
- **Upstream**: 既存 eval ハーネス（`scripts/kb-eval.ts`、`src/agent`・`src/chat/core.ts`・`src/kb/db.ts` を組み立てて実行）、`eval/cases.json` のスキーマ。
- **Downstream**: #29/#31（新採点種別）、および B′・D・安全ケース群がこの軸タグ／ゲート／集計基盤の上に乗る。

## Existing Spec Touchpoints
- **Extends**: なし（既存 spec なし。本リポジトリ初の spec）
- **Adjacent**: なし

## Constraints
- 後方互換：既存 `eval/cases.json` の 7 ケースを修正なしで全 PASS 維持。`expect` 既存フィールド
  （`toolsUsedAny`/`toolsUsedAll`/`source`/`argIncludes`/`readPathIncludes`/`answerIncludes`/`answerOmits`）と
  「指定項目だけ検査」方針は不変。
- `needsGh` による SKIP 挙動は維持し、SKIP はゲート判定に含めない（環境差で誤 fail させない）。
- `bun run typecheck` クリーン。外部依存追加なし。
- 軸は `"A"|"B"|"C"|"D"|"safety"`。`axis` 未指定ケースは従来通り総合のみに数える。
