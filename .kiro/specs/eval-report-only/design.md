# Design Document: eval-report-only

## Overview
**Purpose**: ライブ `kb:eval` をレポート専用にし、exit を安全ゲート（`gate:true`）のみで判定する。単発 LLM 採点の非決定性で run が赤になる構造問題を解消する。決定的回帰ゲートは `bun test`。

**Impact**: `scripts/kb-eval.ts` の純粋関数 `overallPassed` を 1 箇所変更＋スコアカード注記。採点・monitor 分類・昇格・ケースデータは不変。

### Goals
- exit は `sc.gate.failed.length === 0`（安全ゲートのみ）。
- スコアカードで「参考／exit は安全ゲートのみ／回帰は bun test」を明示。
### Non-Goals
- 採点判定・monitor 分類の変更、ケース増減、`buildSystem`/昇格/キャッシュ。

## Boundary Commitments
- **This Spec Owns**: `overallPassed` のセマンティクス（安全ゲートのみ）と `formatScorecard` の注記、該当テスト更新。
- **Out of Boundary**: `evalCase`/`citationFails`/`nextStepFails`（採点）、`buildScorecard` の集計構造（monitor tally 等は #42 のまま）、ケースデータ。
- **Allowed Dependencies**: `Scorecard.gate`（既存）。
- **Revalidation Triggers**: `overallPassed` のセマンティクス変更（本件）→ CI/運用側の「eval を gate にしていた前提」の見直し。

## Architecture
`overallPassed(sc)` は eval 末尾で `process.exit(overallPassed(sc) ? 0 : 1)` に使われる純粋判定。従来 `total.pass===total.evaluated && gate.failed 空`。本設計は `gate.failed 空` のみに簡約し、scored/monitor を exit から外す。`buildScorecard` は不変（total/monitor tally はスコアカード表示に引き続き使う）。

## File Structure Plan
### Modified Files
- `scripts/kb-eval.ts` — `overallPassed` を `return sc.gate.failed.length === 0;` に変更（コメントを設計方針に更新）。`formatScorecard` の総合行を「総合（参考）…」にし、「exit は安全ゲートのみ／回帰ゲートは bun test」注記行を追加。
- `test/kb-eval.test.ts` — `overallPassed` の「scored FAIL でも安全ゲート無失敗なら true」「安全ゲート失敗なら false」テストへ更新。既存 formatScorecard テストは総合行の部分文字列一致で維持。

## Requirements Traceability
| Req | Summary | Component |
|-----|---------|-----------|
| 1.1 | exit は安全ゲートのみ | `overallPassed` |
| 1.2 | scored/monitor FAIL は exit 0 | `overallPassed` |
| 1.3 | 安全ゲート FAIL は exit 1 | `overallPassed` |
| 1.4 | スコアカード注記 | `formatScorecard` |
| 2.1 | typecheck | 全体 |
| 2.2 | bun test 緑（テスト更新含む） | `test/kb-eval.test.ts` |
| 2.3 | 採点/monitor/昇格/cache/buildSystem/データ 不変 | （非変更） |

## Testing Strategy
### Unit（`test/kb-eval.test.ts`, `bun test`）
1. `overallPassed`: 安全ゲート無失敗なら scored FAIL でも true（Req 1.2）。
2. `overallPassed`: 安全ゲート失敗なら scored 全 PASS でも false（Req 1.3）。
3. 既存 formatScorecard/buildScorecard/monitor テストが緑（総合行の部分文字列一致は維持, Req 2.2）。
### ライブ（`bun run kb:eval`, 手動）
4. scored/monitor に FAIL があっても安全ゲートが無ければ exit 0・スコアカードに参考/注記が出る（Req 1.2/1.4）。
