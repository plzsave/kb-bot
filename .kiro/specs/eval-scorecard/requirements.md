# Requirements Document

## Introduction

評価ハーネス（`scripts/kb-eval.ts` + `eval/cases.json`）を「目標到達度の測定基盤」に拡張する。
現状はルーティングとモノレポ深掘りが効くかをツール痕跡で総合採点するのみで、目標（非エンジニアの独力解決）への到達度を**評価軸ごと**に把握できない。本機能はケースを評価軸（A/B′/C/D/safety）でタグ付けして**軸別に集計**し、安全系などを**合否ゲート**として扱い、実行末尾に**スコアカード**（軸別集計＋ゲート合否＋総合）を表示する枠組みを提供する。

本機能は「枠（タグ／ゲート／集計）」のみを担う基盤であり、新しい採点種別（出典必須・忠実性・次の一歩）の中身は後続作業（#29/#31）が所有する。

## Boundary Context

- **In scope**: ケースへの評価軸タグ付け、軸別 pass/total 集計、合否ゲート指定とその全体合否への反映、実行末尾のスコアカード表示、終了コードへのゲート反映。対象は `scripts/kb-eval.ts` と `eval/cases.json`（および追従が必要なら `eval/cases.sample.json`）。
- **Out of scope**: 本番コード `src/` の変更、新しい採点種別の中身（出典必須・忠実性・次の一歩 = #29/#31）、新たな外部依存の追加、評価ケースそのもの（B′/D/safety ケース群）の追加。
- **Adjacent expectations**: 既存の採点ロジック（指定項目だけ検査する `expect` 評価）と GitHub 未設定時の SKIP 挙動は本機能の前提として維持される。後続の採点種別はこの軸タグ／ゲート／集計の枠の上に載ることを期待する。

## Requirements

### Requirement 1: 評価軸タグと軸別集計
**Objective:** 評価基盤のメンテナとして、各ケースを評価軸でタグ付けして軸別の合否を集計したい。そうすれば目標到達度を軸ごとに把握できる。

#### Acceptance Criteria
1. Where ケースに評価軸（`"A"|"B"|"C"|"D"|"safety"` のいずれか）が指定されている場合、the 評価ハーネス shall その軸のケースを当該軸の pass/total に集計する。
2. When 実行が終了する、the 評価ハーネス shall タグ付けされた全評価軸について軸別の pass/total を出力する。
3. Where ケースに評価軸が指定されていない場合、the 評価ハーネス shall そのケースを従来通り総合の集計のみに数え、いずれの軸別集計にも含めない。
4. If ケースに `"A"|"B"|"C"|"D"|"safety"` 以外の評価軸が指定されている場合、then the 評価ハーネス shall その不正な軸を検出してエラーとして報告し、誤った軸に黙って集計しない。

### Requirement 2: 合否ゲート
**Objective:** 評価基盤のメンテナとして、安全系などの重要ケースを合否ゲートとして扱いたい。そうすればゲートが 1 つでも落ちたら全体を不合格にできる。

#### Acceptance Criteria
1. Where ケースが合否ゲートとして指定されている場合、the 評価ハーネス shall そのケースをゲートケースとして扱う。
2. If ゲートケースのうち 1 つでも FAIL となった場合、then the 評価ハーネス shall 他軸の結果に関わらず全体を不合格とし、ゼロ以外の終了コードで終了する。
3. When ゲートケースが FAIL する、the 評価ハーネス shall その FAIL をスコア軸の FAIL と区別できる形で出力する。
4. While 全てのゲートケースが PASS している間、the 評価ハーネス shall 全体合否をスコア軸の結果のみに基づいて判定する。

### Requirement 3: スコアカード出力
**Objective:** 評価基盤のメンテナとして、1 回の実行末尾で全体像を把握したい。そうすれば軸別の到達度とゲート合否を一目で確認できる。

#### Acceptance Criteria
1. When 実行が終了する、the 評価ハーネス shall 軸別集計・ゲート合否・総合 PASS 数を含むスコアカードを末尾に表示する。
2. When 軸タグ・ゲート・無タグのケースが混在した状態で実行される、the 評価ハーネス shall それらを 1 回の実行で軸別集計＋ゲート合否＋総合として出力する。
3. The 評価ハーネス shall 既存の総合集計（総合 PASS 数）をスコアカード内に保持する。

### Requirement 4: 既存ケースとの後方互換
**Objective:** 評価基盤のメンテナとして、既存ケースが無改修のまま通り続けてほしい。そうすれば基盤拡張が既存の評価を壊さないと確信できる。

#### Acceptance Criteria
1. When 既存の `eval/cases.json` の 7 ケースを修正なしで実行する、the 評価ハーネス shall それら全ケースを PASS とする。
2. The 評価ハーネス shall 既存の `expect` フィールド（`toolsUsedAny` / `toolsUsedAll` / `source` / `argIncludes` / `readPathIncludes` / `answerIncludes` / `answerOmits`）の意味と「指定された項目だけを検査する」方針を変更しない。
3. The 評価ハーネス shall 新たな外部依存を追加しない。
4. When 型チェック（`bun run typecheck`）を実行する、the 評価ハーネス shall エラーなく完了する。

### Requirement 5: SKIP 挙動の維持とゲート判定からの除外
**Objective:** 評価基盤のメンテナとして、GitHub 未設定の環境差で誤って不合格にならないようにしたい。そうすれば SKIP が合否を歪めない。

#### Acceptance Criteria
1. While GitHub が未設定（`KB_GITHUB_REPOS` 未指定）である間、when GitHub を要するケースを実行する、the 評価ハーネス shall そのケースを従来通り SKIP する。
2. When ケースが SKIP される、the 評価ハーネス shall その SKIP をゲート判定に含めず、ゲート合否に影響させない。
3. When ケースが SKIP される、the 評価ハーネス shall その SKIP を軸別集計の pass/total に含めない。
