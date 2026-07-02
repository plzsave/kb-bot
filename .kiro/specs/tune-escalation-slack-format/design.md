# Design Document: tune-escalation-slack-format

## Overview
**Purpose**: 2 つの小改善 ―― (1) 事前昇格しきい値 `REL_MIN_COVERAGE` を 0.5→0.34 に下げて borderline docs 質問の過剰昇格を抑える、(2) `buildSystem` に「Slack 等で崩れる markdown 表を使わない」指示を追記。

**Impact**: `src/kb/db.ts` の定数 1 つと `src/chat/core.ts` の出力スタイル 1 文のみ。判定ロジック・eval・キャッシュは不変。

### Goals / Non-Goals
- Goal: 過剰昇格の削減（値変更のみ）と Slack 表崩れの解消。
- Non-Goal: coverage 指標ロジック・A経路設計（#40）・eval の変更。

## Boundary Commitments
- **This Spec Owns**: `REL_MIN_COVERAGE` の値、`buildSystem` [Output style] の表回避文、関連テスト。
- **Out of Boundary**: `queryCoverage`/`isSubstantiveTopHit` の計算、`startHard` 式、eval、キャッシュ、[Safety]/#39/#31 の既存文言。
- **Revalidation Triggers**: しきい値の再変更 → `isSubstantiveTopHit` テストと過剰昇格の実測再確認。

## File Structure Plan
### Modified Files
- `src/kb/db.ts` — `REL_MIN_COVERAGE` を `0.34` に変更（コメントで根拠: borderline docs 0.4 は据置・真の空振り≤0.2 は昇格を維持）。
- `src/chat/core.ts` — `buildSystem` の `base` の [Output style] 行に「Do not use Markdown tables (they render as raw pipes in Slack/Discord); use short bullet lists or plain lines instead.」を追記。既存の [Output style] 文と他ブロックは保持。
- `test/systemPrompt.test.ts` — 出力に表回避の指示が含まれ、既存キーフレーズが保持されることを検証。
- `test/db.test.ts` —（必要なら）しきい値近傍（cov≈0.4 が substantive、cov≈0.2 が非 substantive）の代表を確認。既存の高/低カバレッジ判定は不変。

## Requirements Traceability
| Req | Summary | Component |
|-----|---------|-----------|
| 1.1 | cov≥0.34 は昇格しない | `REL_MIN_COVERAGE` |
| 1.2 | cov<0.34 は昇格維持 | `REL_MIN_COVERAGE` |
| 1.3 | 判定ロジックは不変（値のみ） | `isSubstantiveTopHit`（非変更） |
| 2.1 | 表を使わない指示 | `buildSystem` [Output style] |
| 2.2 | 既存文言を弱めない | `buildSystem` |
| 3.1 | typecheck | 全体 |
| 3.2 | bun test 緑 | test |
| 3.3 | 変更は db.ts/core.ts 限定 | — |

## Testing Strategy
### Unit（`bun test`）
1. `systemPrompt`: 出力に「表を使わない（Slack で崩れる）」相当の指示が含まれ、[Safety]/[Output style]/#39/#31/言語の既存キーフレーズが保持される（Req 2.1/2.2）。
2. `db`: cov≈0.4 のケースが `isSubstantiveTopHit=true`（据置）、cov≈0.2 のケースが false（昇格）になることを、しきい値 0.34 で確認（Req 1.1/1.2）。既存の高/低カバレッジ判定は不変（Req 3.2）。
### オフライン実測（API 不要）
3. 「権限レベルの種類」(0.40) が据置、「低コスト化」(0.20)・「トークナイザ」(0.00) が昇格のままであることを coverage で確認。
### ライブ（手動・任意）
4. Slack で表を使わず箇条書きで崩れず表示されること。
