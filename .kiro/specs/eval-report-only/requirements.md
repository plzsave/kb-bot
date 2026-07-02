# Requirements Document

## Introduction
ライブ `kb:eval` は単発 LLM 実行を自由文採点し scored 全 PASS を pass/fail ゲートにしていたため、非決定性で run ごとに別ケースが揺れて赤になる（#39–#42 で実証）。本仕様は `kb:eval` を**レポート専用**とし、exit を安全ゲート（`gate:true`）のみで判定する。回帰の決定的ゲートは `bun test`。詳細は brief.md 参照。

## Boundary Context
- **In scope**: `overallPassed` を安全ゲートのみに変更／スコアカードの注記／該当テスト更新。
- **Out of scope**: 採点判定（`evalCase` 系）・monitor 分類（#42・表示維持）・昇格・キャッシュ・`buildSystem`・ケースデータ増減。
- **Adjacent expectations**: monitor 表示（#42）と安全ゲートの hard-fail は維持。`bun test` が決定的ゲート。

## Requirements

### Requirement 1: レポート専用の exit 判定
**Objective:** As a 評価基盤の保守者, I want ライブ eval が非決定な scored の揺れで赤にならないようにしたい, so that eval がゲートとして信用でき、回帰は bun test で止める

#### Acceptance Criteria
1. When ライブ eval を実行, the 評価ハーネス shall exit（`overallPassed`）を安全ゲート（`gate:true`）失敗の有無のみで判定する
2. If scored/monitor ケースが FAIL するが安全ゲート失敗が無い, then the 評価ハーネス shall 合格（exit 0）とする
3. If 安全ゲートが FAIL する, then the 評価ハーネス shall 不合格（exit 1）とする
4. The スコアカード shall 総合行を参考表示とし、「exit は安全ゲートのみ・回帰ゲートは bun test」を明示する

### Requirement 2: 既存資産の非回帰
**Objective:** As a 保守者, I want 本変更が採点・表示・他スペックを壊さないことを保証したい, so that 安全に取り込める

#### Acceptance Criteria
1. When `bun run typecheck` を実行, the プロジェクト shall 型エラーなく完了する
2. When `bun test` を実行, the プロジェクト shall 全テストを緑にする（`overallPassed` の新セマンティクスに更新したテストを含む）
3. The 変更 shall 採点判定（`evalCase` 系）・monitor 表示（#42）・昇格・キャッシュ・`buildSystem`・ケースデータを改変しない
