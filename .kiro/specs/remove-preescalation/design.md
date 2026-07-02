# Design Document: remove-preescalation

## Overview
**Purpose**: #40 の事前昇格（A経路）と判定機構を撤去し、昇格を「基本モデルで開始→truncated 時のみ B経路で上位」の1本に統一する。実測で haiku+#39 が挙動系質問に完答できることが根拠。

**Impact**: `escalation.ts`（`startHard` 撤去）＋呼び出し 2 箇所（core/eval）＋`db.ts`（判定機構撤去）＋テスト整理。#39・B経路・フォールバック・#43・#44 Slack 表回避は不変。

### Non-Goals
- #39 プロンプト・B経路・404 フォールバック・eval レポート化・Slack 表回避・キャッシュの変更。

## Boundary Commitments
- **This Spec Owns**: `runWithEscalation` の A経路除去、`db.ts` の `isSubstantiveTopHit`/`queryCoverage`/`REL_MIN_COVERAGE` 撤去、core/eval の呼び出し更新、関連テスト整理。
- **Out of Boundary**: `buildSystem`（#39/#44 表回避は保持）、B経路/フォールバックのセマンティクス、`overallPassed`(#43)。
- **Revalidation Triggers**: `runWithEscalation` シグネチャ変更 → core/eval/escalation.test の追従（本 PR で実施）。

## File Structure Plan
### Modified Files
- `src/agent/escalation.ts` — `RunWithEscalationOpts` から `startHard` を削除。`runWithEscalation` は常に `runOnce(model)` で開始し、`canEscalate && result.truncated` の時のみ `onEscalate?.()` 後に `runOnce(modelHard!)`。`escalated` は「B経路で再実行したか」。`onDelta`/`onEscalate`/`runAgentWithFallback` は不変。
- `src/chat/core.ts` — `isSubstantiveTopHit` import と `startHard`/`canEscalate` 変数を削除。`runWithEscalation({...})` から `startHard` を除く（`onDelta`/`onEscalate` は維持）。
- `scripts/kb-eval.ts` — `isSubstantiveTopHit` import と `startHard`/`canEscalate` を削除。`runWithEscalation` 呼び出しから `startHard` を除く。トレースのティア表示（`escalated` 時に `↑`）は維持。
- `src/kb/db.ts` — `REL_MIN_COVERAGE`/`queryCoverage`/`isSubstantiveTopHit` を削除。`indexTokens`/`queryTerms` の import は他で使われなければ整理（`buildMatchQuery` が `queryTerms` を使用中なので維持）。
- `test/db.test.ts` — `queryCoverage`/`isSubstantiveTopHit` の import とテスト群を削除。
- `test/escalation.test.ts` — `startHard=true`（A経路）テストを削除。他の `runWithEscalation` テストから `startHard` 引数を除去（B経路・未設定非昇格・404・onEscalate は維持）。

## Requirements Traceability
| Req | Summary | Component |
|-----|---------|-----------|
| 1.1 | 常に base 開始・事前昇格なし | `runWithEscalation` |
| 1.2 | truncated 時のみ B経路 | `runWithEscalation` |
| 1.3 | 完答なら非昇格 | `runWithEscalation` |
| 1.4 | 判定機構を撤去 | `db.ts`, core, eval |
| 2.1 | #39 保持 | `buildSystem`（非変更） |
| 2.2 | B経路/フォールバック/#43/#44 保持 | escalation/core |
| 2.3 | escalation.test 緑（引数更新のみ） | test |
| 2.4 | typecheck | 全体 |

## Testing Strategy
### Unit（`bun test`）
1. `escalation.test`: B経路（toolloop→truncated→hard）・`modelHard` 未設定で非昇格・404 フォールバック・onEscalate 呼び出しが緑（`startHard` 引数除去後）。A経路テストは削除。
2. `db.test`: coverage 系テスト削除後も既存 search/dropWeakHits 等が緑。
3. `bun run typecheck` クリーン。
### ライブ（手動・任意）
4. 「低コスト化」が基本モデル(haiku)のまま完答（事前昇格しない）。真に詰まる質問だけ B経路で昇格。
