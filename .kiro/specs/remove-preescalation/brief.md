# Brief: remove-preescalation

## Source
実測（2026-07-02）で #40 の事前昇格（A経路）が過剰と判明。ユーザー承認済み（A案）。関連メモリ: kb-bot-degradation-fix-deferred。

## Problem
昇格の理屈が2つ重複していた: (a) #39=「安いモデルでもコードを読んで答えろ」、(b) #40=A経路「docs に答えが無ければ最初から上位モデル」。kb-bot の挙動系質問は答えが常にコードにあり docs に無いため、#40 は**ほぼ全質問を昇格**させていた。しかし実測で **haiku 単独（#39あり・昇格なし）でも「低コスト化」に完答**でき、A経路の前提（haikuでは無理）は偽だった＝過剰昇格・無駄なコスト。

## Desired Outcome
昇格を **1 本の筋**に統一する: 「#39 で安いモデルがコードを読んで答える／本当に詰まった（ターン上限＝truncated）時だけ B経路で上位モデルに昇格」。事前昇格（A経路）とその判定機構（`isSubstantiveTopHit`/`queryCoverage`/`REL_MIN_COVERAGE`/`startHard`）を撤去する。#39・B経路・404フォールバック・eval レポート化・Slack表回避は維持。

## Approach
- `src/agent/escalation.ts`: `runWithEscalation` から `startHard` を撤去し、常に base で開始→`canEscalate && truncated` の時だけ上位で再実行（B経路のみ）。`onEscalate`（B経路直前フック）は維持。
- `src/chat/core.ts`: `startHard`/`canEscalate` と `isSubstantiveTopHit` import を撤去。`runWithEscalation` 呼び出しから `startHard` を外す。
- `scripts/kb-eval.ts`: 同様に `startHard`/`canEscalate`/import を撤去。トレースのティア表示（B経路昇格時のみ ↑）は維持。
- `src/kb/db.ts`: `REL_MIN_COVERAGE`/`queryCoverage`/`isSubstantiveTopHit` を撤去。
- テスト: A経路関連（db.test の coverage 系・escalation.test の startHard=true）を撤去。B経路・404・fallback テストは維持。

## Scope
- **In**: 上記5ファイル＋関連テストの撤去・整理。
- **Out**: #39（コード確認プロンプト）・B経路・404フォールバック・#43（eval レポート化）・#44 Slack表回避・キャッシュ。これらは維持。

## Existing Spec Touchpoints
- **Reverts/Supersedes**: `relevance-aware-escalation`(#40) の A経路と `tune-escalation-slack-format`(#44) のしきい値部分（Slack表回避は残す）。
- **Adjacent**: `eval-through-escalation`(#41)（B経路は維持・startHard 引数が消えるので呼び出し更新）。

## Constraints
- 元の不満（諦める）は #39 が防ぐため再発しない。escalation.test の B経路・404・fallback を無改修で緑に保つ（startHard 引数のみ除去）。`bun run typecheck` クリーン、`bun test` 緑。
