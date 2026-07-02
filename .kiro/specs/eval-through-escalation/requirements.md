# Requirements Document

## Introduction
`scripts/kb-eval.ts` は `runAgent` を直接呼び、`answer()` のエスカレーション（A経路 `startHard` / B経路 truncated 救済 / 404 フォールバック）を通らない。そのため eval は常に基本モデルで走り、#40 の事前昇格の効果を測れず、本番なら上位ティアで解ける難質問でも基本モデル単独のブレで FAIL する。eval が production を代表しないことが、評価の不安定さの構造的原因になっている。

本仕様は、エスカレーション orchestration を共有関数に抽出して `answer()` と eval の双方が同一ロジックを通るようにし、eval を**本番と同じ昇格経路**で走らせる。`answer()` の挙動は不変に保つ。昇格ポリシー自体（`isSubstantiveTopHit`/startHard の定義）と採点ロジックは変更しない。詳細は brief.md 参照。

## Boundary Context
- **In scope**:
  - エスカレーション orchestration（A/B 経路＋404 フォールバック）の共有関数への抽出
  - `answer()` を共有関数呼び出しへ置換（挙動不変）
  - eval を共有関数経由（昇格あり）で走らせ、使用ティア/昇格有無をトレース表示
- **Out of scope**:
  - 昇格の発火条件（`isSubstantiveTopHit`・startHard の定義）の変更（#40 が所有）
  - eval の採点判定ロジック（`evalCase`/`citationFails`/`nextStepFails`）と新規ケース
  - キャッシュ・`buildSystem`・プロンプト
- **Adjacent expectations**:
  - eval のツールトレース採点（`recordTool` による `toolsUsedAny` 等）は維持する
  - `escalation.test.ts` が固定する `answer()` の昇格/フォールバック挙動は不変

## Requirements

### Requirement 1: エスカレーション orchestration の共有化
**Objective:** As a 保守者, I want 昇格ロジックを `answer()` と eval で共有したい, so that 両者が同一挙動になり drift しない

#### Acceptance Criteria
1. The プロジェクト shall A経路（`startHard` 指定時に上位ティアで開始）・B経路（`canEscalate` かつ `truncated` で上位ティア再実行）・404/退役フォールバックを行う単一の共有関数を提供する
2. The 共有関数 shall 呼び出し側が注入する system・messages・tools・maxTurns に対して動作し、特定プラットフォーム（Slack/Discord）や eval に依存しない
3. The 共有関数 shall ストリーミング用の逐次コールバックと、B経路再実行の直前フック（呼び出し側で表示更新やバッファ初期化を行うため）を任意で受け取る
4. The 共有関数 shall 使用したモデル・昇格有無・フォールバック有無を呼び出し側へ返す

### Requirement 2: answer() の挙動不変
**Objective:** As a 保守者, I want 共有化リファクタが本番回答の挙動を変えないことを保証したい, so that 既存の昇格/フォールバックが回帰しない

#### Acceptance Criteria
1. When `escalation.test.ts` を実行, the プロジェクト shall 既存テスト（B昇格・未設定時非昇格・404 フォールバック・昇格×フォールバック両立）を無改修で緑にする
2. While ストリーミング応答中, the `answer()` shall 従来どおり逐次表示し、B経路再実行時に表示バッファをリセットして「考え中（上位ティア）」表示を出す
3. The `answer()` shall 従来どおりの使用量ログ（model/escalated/fellBack/truncated 等）を出力する

### Requirement 3: eval の昇格経由化
**Objective:** As a 評価基盤の保守者, I want eval を本番と同じ昇格経路で走らせたい, so that #40 の効果を測れ、eval が production を代表する

#### Acceptance Criteria
1. When eval を実行, the 評価ハーネス shall 本番と同じ基準（`canEscalate` かつ GitHub 有効かつ最上位ヒットが実質関連でない）で `startHard` を判定し、共有関数経由で回答を生成する
2. While `KB_MODEL_HARD` が設定されている, when 実質空振りの難質問ケースを実行, the 評価ハーネス shall 上位ティアで開始する
3. The 評価ハーネス shall ケースのツールトレース採点（`recordTool` による使用ツール記録と `evalCase` 判定）を維持する
4. The 評価ハーネス shall 各ケールの使用ティア/昇格有無をトレース出力に含める
5. While `KB_MODEL_HARD` が未設定, when eval を実行, the 評価ハーネス shall 従来どおり基本モデルのみで走る（昇格しない）

### Requirement 4: 既存資産の非回帰
**Objective:** As a 保守者, I want リファクタが既存の挙動・テスト・所有範囲を壊さないことを保証したい, so that 変更を安全に取り込める

#### Acceptance Criteria
1. When `bun run typecheck` を実行, the プロジェクト shall 型エラーなく完了する
2. When 既存テスト（`bun test`）を実行, the プロジェクト shall 既存テストを無改修で維持する
3. The 変更 shall 昇格の発火条件（`isSubstantiveTopHit`/startHard 定義）・採点ロジック（`evalCase` 系）・キャッシュ・`buildSystem` を改変しない
