# Requirements Document

## Introduction
実物確認で見つかった 2 つの小改善: (1) 事前昇格しきい値 `REL_MIN_COVERAGE=0.5` が高く、答えが docs にある borderline 質問（cov≈0.4）まで昇格して無駄にコストがかかる。(2) bot が markdown 表を出すが Slack が描画せず崩れる。詳細は brief.md 参照。

## Boundary Context
- **In scope**: しきい値の値変更／`buildSystem` の出力スタイルへの表回避の追記／関連テスト。
- **Out of scope**: coverage 判定ロジック（#40）・eval・キャッシュ・A経路設計。
- **Adjacent expectations**: コード質問（低カバレッジ）の昇格は維持。[Safety]/#39/#31/言語自動判別は不変。

## Requirements

### Requirement 1: 過剰昇格の抑制（しきい値調整）
**Objective:** As a コストを気にする運用者, I want 答えが docs にある質問を無駄に昇格させたくない, so that 不要な上位モデル呼び出しを減らせる

#### Acceptance Criteria
1. The 事前昇格しきい値 shall borderline な docs 質問（内容語カバレッジ 0.34 以上）を実質関連とみなし昇格させない
2. The 事前昇格 shall 真の空振り（カバレッジ 0.34 未満・docs に答えが無いコード質問）では従来どおり昇格する
3. The 変更 shall coverage 指標（`queryCoverage`/`isSubstantiveTopHit`）の計算ロジックを変えず、しきい値の値のみを変更する

### Requirement 2: Slack で崩れない出力（表の回避）
**Objective:** As a 利用者, I want 回答が Slack で崩れずに読めてほしい, so that 表がパイプ記号の羅列にならない

#### Acceptance Criteria
1. The `buildSystem` の出力スタイル shall markdown の表を使わず箇条書き等で構造化するよう指示する（Slack 等が表を描画しないため）
2. The 追記 shall [Safety]・#39 のコード確認・#31 の next-step・出力言語自動判別の各既存文言/挙動を弱めない

### Requirement 3: 非回帰
**Objective:** As a 保守者, I want 変更が既存挙動・テストを壊さないことを保証したい, so that 安全に取り込める

#### Acceptance Criteria
1. When `bun run typecheck` を実行, the プロジェクト shall 型エラーなく完了する
2. When `bun test` を実行, the プロジェクト shall 既存テストを緑に保つ（しきい値変更で既存の `isSubstantiveTopHit` テストの判定は変わらない）
3. The 変更 shall `src/kb/db.ts`（しきい値）と `src/chat/core.ts`（出力スタイル）に限定する
