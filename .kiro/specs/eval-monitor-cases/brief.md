# Brief: eval-monitor-cases

## Source
kb-bot 回答劣化対処の follow-on。ライブ eval の役割分離（決定的ゲート=`bun test`、`kb:eval`=確率的モニタ）というユーザー判断（2026-07-02）に基づく。#27 評価基盤（本番自立度の測定）に該当。関連メモリ: kb-bot-degradation-fix-deferred。GitHub issue 未起票。

## Problem
ライブ `kb:eval` は soft な自由文性質（「次の一歩を出したか」＝`offersNextStep`、「出典を付けたか」＝`citesSource`）を**単発ライブ採点**するため、同じ質問でもモデルの言い回しが実行ごとに揺れ、run 間で FAIL したり PASS したりする（実測: D ケースは単独実行で PASS するのに eval 実行では FAIL）。現状は `overallPassed` が「評価済み全 PASS」を要求するため、こうした確率的ケースの 1 回の揺れで **eval 全体が exit 1** になり、ゲートとして信用できない（＝「何を確認しているか分からない」不安定さ）。

一方、コードルーティング系（source/toolsUsed/readPathIncludes）と事実トークン（unicode61 等）は #39/#40/#41 の昇格経由化で安定して PASS するようになった。決定的な保証は `bun test`（175 件）にある。

## Current State
- `scripts/kb-eval.ts`: ケースは `gate:true`（ハードゲート）と「無印＝scored（`overallPassed` の母数）」の 2 分類。`overallPassed = total.pass===total.evaluated && gate.failed 空`。
- soft テキスト系ケース: D 次の一歩（`offersNextStep`, #31/#38）、B′ 出典（`citesSource`, #29）。これらが scored 母数に入り、揺れると exit 1。
- スコアカード: `buildScorecard`/`formatScorecard`/`overallPassed`（純粋関数・`test/kb-eval.test.ts` で検証・#28 由来）。

## Desired Outcome
- 確率的 soft テキストケースを **monitor（非ゲート・情報表示）** に分類できる。monitor ケースは実行・採点・スコアカード表示されるが、**exit コード（`overallPassed`）には影響しない**。
- ゲート/scored（コードルーティング＋事実トークン＋安全ゲート）は従来どおり exit を左右する。
- 既存の gate/軸集計/スコアカードの挙動と `bun test` は不変（後方互換）。

## Approach
1. ケーススキーマに `monitor?: boolean` を追加（`validateCases` で真偽値検証）。
2. `buildScorecard` で monitor ケースを**別 tally**（`monitor: {pass,total,failed}`）に集計し、`total`（evaluated/pass）・`gate`・`perAxis` の母数から除外する。
3. `overallPassed` は現状式のまま（monitor を total から外すので自動的に非ゲート化）。`formatScorecard` に monitor 行を追加（情報表示）。
4. soft テキスト目的のケース（D 次の一歩・B′ 出典 2 件）に `monitor:true` を付す。コードルーティング/事実/ドリフト（"24" 等の安定トークン）/安全ゲートは据え置き。

## Scope
- **In**: `monitor` フラグ（スキーマ＋検証）／`buildScorecard`・`overallPassed`・`formatScorecard` の monitor 対応／該当ケースへの `monitor:true` 付与／それらの単体テスト。
- **Out**: 採点判定ロジック（`evalCase`/`citationFails`/`nextStepFails`）の変更。昇格・キャッシュ・プロンプト。per-check 粒度の monitor（ケース単位に限定）。

## Boundary Candidates
- スコアカード集計（`buildScorecard`/`overallPassed`/`formatScorecard`）
- ケーススキーマ検証（`RawCase`/`Case`/`validateCases`/`CaseResult`）
- 評価データ（`eval/cases.json` の該当ケースへの付与）

## Out of Boundary
- 採点判定（`evalCase` 系）＝eval-* 各スペック所有・不変
- per-check（ケース内の特定 expect だけ非ゲート）粒度＝将来必要なら別途
- 昇格（#40/#41）・キャッシュ・`buildSystem`

## Upstream / Downstream
- **Upstream**: `eval-scorecard`（#28・`buildScorecard`/`overallPassed`/`formatScorecard`/gate）を拡張。
- **Downstream**: これで `kb:eval` の exit が「安定した gate/scored ケース」のみで決まり、soft ケースは情報として並走。eval がゲートとして信用できるようになる。

## Existing Spec Touchpoints
- **Extends**: `eval-scorecard`（#28）のスコアカード/合否ロジックに monitor 分類を追加。
- **Adjacent**: `eval-next-step`（#31）・`eval-citation-check`（#29）のケースに `monitor:true` を付与（採点ロジックは不変）。

## Constraints
- 既存 gate/scored/軸集計/スコアカードの挙動を後方互換に保つ（monitor 未指定なら従来どおり）。
- `bun test` の既存 scorecard テストを無改修で緑。`bun run typecheck` クリーン。
