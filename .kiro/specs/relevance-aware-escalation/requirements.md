# Requirements Document

## Introduction
docs に無い難質問（コード探索が要る）で、最安ティアが search→read を完走できず「見つからない」で諦める劣化がある。事前昇格（A経路 `startHard`）はこれを救えるはずだが、`startHard` が `hits.length === 0` 限定で発火する一方、`dropWeakHits` は最上位ヒットを無条件に残すため、無関係な語一致1件でも `hits.length>=1` となり A経路が発火しない。

本仕様は「実質空振り（最上位ヒットが質問に実質無関係）」を**コーパス非依存**に検知し、`startHard` を「FTS 空 **または** 実質空振り」で発火させる。これにより難質問が最初から上位ティアで走り、#39（未発見前コード確認の必須化）と協調してコードを確実に探索する。諦め回答の非キャッシュ化・基本モデル底上げは対象外。詳細は brief.md 参照。

## Boundary Context
- **In scope**:
  - 検索側のコーパス非依存な関連性シグナル（クエリ内容語カバレッジ）の追加
  - `startHard`（A経路事前昇格）の「空 or 実質空振り」への拡張
  - 上記の決定的テスト
- **Out of scope**:
  - 諦め/未発見回答の非キャッシュ化（別 follow-on）
  - 基本モデル底上げ（`.env`・コード外）
  - B経路（`truncated` 救済）・`runAgentWithFallback`（退役フォールバック）の変更
  - `dropWeakHits`／`formatHits`（初期コンテキスト前置き）／`buildSystem`／eval 判定ロジックの変更
- **Adjacent expectations**:
  - 昇格の可否は既存 `canEscalate`（`KB_MODEL_HARD` 設定）に従う。未設定時は昇格しない（従来挙動）。
  - docs 優先ルーティングと初期コンテキストへの前置き内容は不変。

## Requirements

### Requirement 1: 実質空振りの検知による事前昇格
**Objective:** As a 非エンジニアの利用者, I want docs に無い難質問を最初から上位ティアで走らせてほしい, so that 弱いモデルが諦めずコードを探索し正答に届く

#### Acceptance Criteria
1. While GitHub 有効かつ昇格可能（`canEscalate`）, when FTS 初期コンテキストが空、または最上位ヒットが質問に実質無関係である（クエリ内容語カバレッジがしきい値未満）, the kb-bot shall 最初から上位ティアで回答を開始する
2. While 昇格可能, when 最上位ヒットが質問に実質関連する（カバレッジがしきい値以上）, the kb-bot shall 従来どおり基本ティアで開始する
3. The 関連性判定 shall コーパス非依存の指標（クエリ内容語のカバレッジ）で行い、生 bm25 の絶対しきい値に依存しない
4. While 昇格不可（`canEscalate` が偽＝`KB_MODEL_HARD` 未設定）, the kb-bot shall 事前昇格を行わず従来挙動を保つ
5. The 関連性判定 shall 純粋関数として実装し、資格情報・ネットワーク非依存で単体検証できる

### Requirement 2: 既存の検索・提示・ルーティングの保全
**Objective:** As a 保守者, I want 関連性シグナル導入が検索結果の提示やルーティングを変えないことを保証したい, so that docs/citation 系の既存挙動が回帰しない

#### Acceptance Criteria
1. The 関連性シグナル shall 事前昇格の判定にのみ用いられ、初期コンテキストへ前置きする内容（`formatHits` に渡すヒット集合）と `dropWeakHits` の枝刈り挙動を変更しない
2. When docs（初期コンテキストまたは知識検索）だけで十分に答えられる質問, the kb-bot shall 従来どおり基本ティアかつ docs 優先ルーティングで応答する
3. The B経路（`truncated` 時の上位ティア救済）と退役フォールバック（`runAgentWithFallback`）shall 変更されない

### Requirement 3: 既存資産の非回帰
**Objective:** As a 保守者, I want 本変更が既存の挙動・テスト・別スペックの所有範囲を壊さないことを保証したい, so that 変更を安全に取り込める

#### Acceptance Criteria
1. When `bun run typecheck` を実行, the プロジェクト shall 型エラーなく完了する
2. When 既存テスト（`bun test`）を実行, the プロジェクト shall 既存テストを無改修で維持する
3. The 変更 shall 回答キャッシュ・`buildSystem`・eval 判定ロジックを改変しない（各所有スペックの範囲を侵さない）
4. The 変更 shall `src/kb/db.ts`（関連性シグナル）と `src/chat/core.ts`（`startHard`）に限定する
