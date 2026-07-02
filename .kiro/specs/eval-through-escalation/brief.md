# Brief: eval-through-escalation

## Source
kb-bot 回答劣化対処の follow-on #3。#40（実質空振り昇格）の効果が eval に現れない問題への対処。#27 マイルストーンの評価基盤（本番自立度を正しく測る）に該当。関連メモリ: kb-bot-degradation-fix-deferred。GitHub issue 未起票。

## Problem
`scripts/kb-eval.ts` は `runAgent` を**直接**呼び、`answer()` のエスカレーション（A経路 startHard / B経路 truncated 救済 / 404 フォールバック）を通らない。そのため eval は常に基本モデル（haiku）で走り、**#40 の事前昇格の効果を一切測れない**。結果、B′ code/drift ケースが「本番なら上位ティアに昇格して解けるはず」の質問でも haiku 単独のブレで FAIL し、eval が production を代表しない（＝「何を確認しているか分からない」不安定さの構造的原因）。

## Current State
- 昇格ロジックは `src/chat/core.ts` の `answer()` 内にインライン: `runOnce` + A経路 `startHard`（`isSubstantiveTopHit`）+ B経路 truncated 救済 + `runAgentWithFallback`（404 退役フォールバック, private）。
- `scripts/kb-eval.ts`: `createLlm()` から `{provider, model}` のみ取得（`modelHard` 不使用）、`runAgent({provider, model, ...})` 直呼び。ツールは `recordTool` でラップしてトレース採点。
- ガード: `test/escalation.test.ts` が `answer()` の昇格/フォールバックの model 列をフェイク provider で固定。

## Desired Outcome
- eval が**本番と同じエスカレーション経路**を通って走る（A経路 startHard を同じ基準で判定し、必要なら modelHard で開始／truncated 救済／404 フォールバック）。
- eval のツールトレース採点（`recordTool` による `toolsUsedAny` 等）は維持する。
- `answer()` の挙動は不変（`escalation.test.ts` が緑のまま）。ケースごとに使用ティア/昇格有無をトレース表示できると尚良い。

## Approach
**エスカレーション orchestration を共有関数に抽出**（drift 防止）:
1. `answer()` 内の runOnce + A/B 経路 + `runAgentWithFallback` を、注入されたツール/system/messages に対して動く純粋な orchestrator `runWithEscalation(...)` として抽出（新モジュール `src/agent/escalation.ts`）。ストリーミング用 `onDelta` と B経路直前フック `onEscalate` をコールバックで受ける。
2. `answer()` はこの関数を呼ぶだけに変更（`onEscalate` で逐次バッファのリセット＋「考え中…」表示、`onDelta` で従来のストリーム。**挙動不変**）。
3. `kb-eval.ts` は `createLlm()` から `modelHard` も取り、本番と同じ `startHard`（`canEscalate && github && !isSubstantiveTopHit(q, hits)`）を計算し、`recordTool` でラップしたツールで `runWithEscalation` を呼ぶ。ケース行に使用ティア/昇格有無を表示。

（案の比較: (A) 共有抽出＝採用。(B) eval に昇格ロジックを複製＝drift リスクで却下。(C) eval を一律 hard ティアで走らせる＝per-question 昇格を反映せず floor→ceiling が入れ替わるだけで却下。）

## Scope
- **In**: `src/agent/escalation.ts`（`runWithEscalation` + `runAgentWithFallback` 移設）/ `answer()` の該当ブロックを共有関数呼び出しへ置換（挙動不変）/ `kb-eval.ts` を昇格経由に変更＋トレース表示 / それらのテスト。
- **Out**: 昇格ポリシー自体の変更（#40 で確定）。新規 eval ケース追加。キャッシュ。`buildSystem`。eval の採点判定ロジック（`evalCase`/`citationFails`/`nextStepFails`）。

## Boundary Candidates
- 共有エスカレーション orchestrator（`src/agent/escalation.ts`）
- `answer()` の呼び出し置換（`src/chat/core.ts`・挙動不変）
- eval の昇格経由化（`scripts/kb-eval.ts`）

## Out of Boundary
- 昇格の発火条件（`isSubstantiveTopHit`・startHard の定義）＝#40 が所有・再利用のみ
- 採点ロジック（`evalCase` 系）＝eval-* 各スペックが所有
- キャッシュ・`buildSystem`

## Upstream / Downstream
- **Upstream**: #40（`isSubstantiveTopHit`/startHard）、`runAgent`、`createLlm`（modelHard）。
- **Downstream**: これで kb:eval が production 代表になり、#39/#40 の効果測定とゲート判断が可能になる。

## Existing Spec Touchpoints
- **Extends**: なし（実装リファクタ＋eval 配線）。
- **Adjacent**: `relevance-aware-escalation`（#40・startHard 提供）、`eval-scorecard`/`eval-citation-check`/`eval-drift-tolerance`/`eval-next-step`（採点ロジック所有・不変）。

## Constraints
- `answer()` の挙動不変（`escalation.test.ts` を無改修で緑）。
- eval のツールトレース採点を維持。
- `bun run typecheck` クリーン、既存テストを壊さない。
