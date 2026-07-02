# Requirements Document

## Introduction
ライブ `kb:eval` は soft な自由文性質（次の一歩＝`offersNextStep`、出典＝`citesSource`）を単発ライブ採点するため、同じ質問でも言い回しが実行ごとに揺れ run 間でフレークする。現状は `overallPassed` が「評価済み全 PASS」を要求するので、この 1 回の揺れで eval 全体が exit 1 になり、ゲートとして信用できない。一方コードルーティング・事実トークンは #39/#40/#41 の昇格経由化で安定した。

本仕様は、確率的 soft テキストケースを **monitor（非ゲート・情報表示）** に分類できるようにする。monitor ケースは実行・採点・表示されるが exit コード（`overallPassed`）に影響しない。決定的ゲートは `bun test`、`kb:eval` は「安定した gate/scored ケースで exit を決め、soft ケースは並走モニタ」という役割分離を実現する。採点判定ロジック・昇格・キャッシュ・プロンプトは変更しない。詳細は brief.md 参照。

## Boundary Context
- **In scope**:
  - ケーススキーマへの `monitor` 分類の追加と検証
  - スコアカード集計・全体合否・整形の monitor 対応（exit から除外・情報表示）
  - 該当 soft テキストケースへの `monitor` 付与
- **Out of scope**:
  - 採点判定ロジック（`evalCase`/`citationFails`/`nextStepFails`）の変更
  - per-check 粒度（ケース内の特定 expect だけ非ゲート化）
  - 昇格（#40/#41）・回答キャッシュ・`buildSystem`
- **Adjacent expectations**:
  - 既存の gate（`gate:true`）・scored（無印）・軸集計・SKIP 除外の挙動は後方互換に保つ
  - `eval-next-step`（#31）・`eval-citation-check`（#29）の採点ロジックは不変（ケースに分類フラグを足すのみ）

## Requirements

### Requirement 1: monitor（非ゲート）分類
**Objective:** As a 評価基盤の保守者, I want 確率的 soft ケースを非ゲートに分類したい, so that 単発の言い回しの揺れで eval 全体が落ちない

#### Acceptance Criteria
1. The 評価ハーネス shall ケースを monitor として指定できる分類を提供する
2. When ケースが monitor 指定される, the 評価ハーネス shall そのケースを実行・採点・スコアカード表示するが、全体合否（exit コード）の母数から除外する
3. If monitor ケースが FAIL する, then the 評価ハーネス shall 全体合否を不合格にしない（exit を左右しない）
4. When 不正な monitor 値（真偽値以外）が指定される, the 評価ハーネス shall ケース名を添えたエラーとして検出する（既存の gate 検証と同様）

### Requirement 2: 既存の gate/scored/集計の後方互換
**Objective:** As a 評価基盤の保守者, I want monitor 追加が既存の合否・集計を変えないことを保証したい, so that 既存ケースと `bun test` が回帰しない

#### Acceptance Criteria
1. While monitor 未指定, the 評価ハーネス shall 従来どおり scored（`overallPassed` の母数）または gate として扱う
2. The 全体合否 shall 従来どおり「gate/scored の評価済みが全 PASS かつゲート失敗なし」で決まり、monitor はこの判定に含めない
3. The スコアカード shall 従来の軸別集計・ゲート行・総合行を保ち、monitor を別に情報表示する
4. When `bun test` の既存スコアカードテストを実行, the プロジェクト shall それらを無改修で緑にする

### Requirement 3: soft テキストケースの monitor 付与
**Objective:** As a 評価基盤の保守者, I want フレークする soft テキストケースを monitor にしたい, so that ゲートは安定したケースだけで決まる

#### Acceptance Criteria
1. The 評価データ shall 次の一歩（`offersNextStep`）を主目的とするケースを monitor に分類する
2. The 評価データ shall 出典（`citesSource`）を主目的とするケースを monitor に分類する
3. The 評価データ shall コードルーティング・事実トークン・ドリフト・安全ゲートのケースは monitor にせず従来どおり exit を左右する分類に保つ

### Requirement 4: 既存資産の非回帰
**Objective:** As a 保守者, I want 本変更が既存挙動・所有範囲を壊さないことを保証したい, so that 安全に取り込める

#### Acceptance Criteria
1. When `bun run typecheck` を実行, the プロジェクト shall 型エラーなく完了する
2. When 既存テスト（`bun test`）を実行, the プロジェクト shall 既存テストを無改修で維持する
3. The 変更 shall 採点判定（`evalCase` 系）・昇格・キャッシュ・`buildSystem` を改変しない
