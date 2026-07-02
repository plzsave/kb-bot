# Requirements Document

## Introduction
#40 の事前昇格（A経路）は実測で過剰と判明（haiku 単独＋#39 で「低コスト化」に完答）。昇格の理屈を1本に統一するため A経路とその判定機構を撤去する。#39・B経路（truncated 救済）・404 フォールバック・eval レポート化・Slack 表回避は維持。詳細は brief.md 参照。

## Boundary Context
- **In scope**: A経路（`startHard`）と判定機構（`isSubstantiveTopHit`/`queryCoverage`/`REL_MIN_COVERAGE`）の撤去、呼び出し側（core/eval）とテストの整理。
- **Out of scope**: #39 プロンプト・B経路・404 フォールバック・eval レポート化(#43)・Slack 表回避(#44)・キャッシュ。維持する。

## Requirements

### Requirement 1: 事前昇格（A経路）の撤去
**Objective:** As a コストを気にする運用者, I want 挙動系質問を最初から高いモデルに送らないでほしい, so that 無駄な上位モデル呼び出しが無くなる

#### Acceptance Criteria
1. The `runWithEscalation` shall 常に基本モデルで開始し、事前昇格（開始時点での上位ティア選択）を行わない
2. While `canEscalate` かつ 応答が truncated, the `runWithEscalation` shall B経路として上位ティアで一度だけ再実行する（従来維持）
3. If 基本モデルが truncated せず完答, then the `runWithEscalation` shall 昇格せず基本モデルの回答を返す
4. The 変更 shall `isSubstantiveTopHit`/`queryCoverage`/`REL_MIN_COVERAGE`/`startHard` を撤去する（未使用の判定機構を残さない）

### Requirement 2: 維持すべき挙動の非回帰
**Objective:** As a 保守者, I want 撤去が元の不満対策・B経路・フォールバックを壊さないことを保証したい, so that 安全に取り込める

#### Acceptance Criteria
1. The 変更 shall #39（"見つからない"前にコードを確認）の指示を保持する（元の諦め対策は不変）
2. The 変更 shall B経路（truncated 救済）・404/退役フォールバック・eval レポート化・Slack 表回避を保持する
3. When `bun test`（`escalation.test` の B経路・未設定非昇格・404・fallback を含む）を実行, the プロジェクト shall それらを無改修で緑にする（`startHard` 引数の除去に伴う呼び出し更新は許容）
4. When `bun run typecheck` を実行, the プロジェクト shall 型エラーなく完了する
