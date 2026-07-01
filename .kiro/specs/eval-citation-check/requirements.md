# Requirements Document

## Introduction

評価ハーネス（`scripts/kb-eval.ts` + `eval/cases.json`）に、回答の**出典（citation）**を客観採点する仕組みを追加する。非エンジニアが答えの正しさを自分で確かめる唯一の手段は出典であり、これは到達目標の軸 B′（正しくあり続ける）に対応する。`buildSystem`（`src/chat/core.ts`）は既に「やさしい説明→根拠（資料名/見出し、コードは `path:line`）」を回答に要求しているが、eval は**出典が実際に付いているかを検査していない**ため、出典要求が回帰しても検知できない。

本機能は、ケースの期待値 `expect` に「出典必須」の観点を追加し、回答本文に出典の**体裁**が含まれるかを判定する。先行の eval-scorecard（#28、実装済み）が用意した軸タグ（`axis`）・合否ゲート・スコアカードの枠の上に、`axis: "B"` の B′ ケースとして載る。判定は LLM ジャッジを使わず、回答本文に対する客観的なパターン照合に限定する。

## Boundary Context

- **In scope**: `scripts/kb-eval.ts` のケース期待値への「出典必須」観点の追加、回答本文に対する出典体裁（`.md` 資料名/見出し、またはコードの `path:line` 引用）の客観判定、「読んだファイルの path が回答本文にも引用されているか」の判定、`eval/cases.json` への B′ ケース（docs 由来・code 由来）の追加。対象は `scripts/kb-eval.ts` と `eval/cases.json`（追従が必要なら `eval/cases.sample.json`）。
- **Out of scope**: 本番コード `src/` の変更、出典が意味的に正しいか（実在・該当箇所か）を判定する LLM ジャッジ、回答が根拠に忠実か（幻覚の有無）の意味的検証、docs とコードの「ドリフト」検証（#30 が所有）、「次の一歩」など他の採点種別（#31 が所有）、新たな外部依存の追加。
- **Adjacent expectations**: eval-scorecard が提供する軸タグ・ゲート・スコアカードの枠と、既存採点の「指定された項目だけを検査する」方針・GitHub 未設定時の SKIP 挙動は本機能の前提として維持される。B′ ケースは `axis: "B"` としてこの枠に集計されることを期待する。

## Requirements

### Requirement 1: 出典体裁の検査（出典必須）
**Objective:** 評価基盤のメンテナとして、回答に出典の体裁が付いているかをケース単位で検査したい。そうすれば「出典を出す」到達目標（軸 B′）の回帰を客観的に検知できる。

#### Acceptance Criteria
1. Where ケースに「出典必須」（`citesSource`）が指定されている場合、the 評価ハーネス shall 最終回答本文に出典の体裁（`.md` 資料名/見出し、またはコードの `path:line` 引用）が含まれるかを検査する。
2. If 「出典必須」ケースの最終回答本文に出典の体裁が含まれない場合、then the 評価ハーネス shall そのケースをその観点で FAIL とし、他の FAIL と区別できる説明を出力する。
3. While 「出典必須」ケースの最終回答本文に出典の体裁が含まれている間、the 評価ハーネス shall 出典の観点では FAIL を生成しない。

### Requirement 2: 読んだファイルの行番号付き引用検査
**Objective:** 評価基盤のメンテナとして、コードが根拠になる質問で「実際に読んだファイルを回答が行番号付きで引用しているか」を検査したい。そうすれば根拠を読んだのに引用しない、または行番号なしで曖昧に触れるだけ（＝出典が確かめられない）の回答を検知できる。

#### Acceptance Criteria
1. When 「読んだ path の一致検査」（`readPathIncludes`）と「出典必須」（`citesSource`）が同一ケースで併用して指定される、the 評価ハーネス shall 読んだファイルの path が最終回答本文に `path:line` 形式（行番号付き）の出典として現れるかを検査する。
2. If 併用指定のケースで、読んだファイルの path を含む `path:line` 形式の引用が最終回答本文に現れない場合、then the 評価ハーネス shall そのケースを FAIL とする。
3. While 併用指定のケースで、読んだファイルの path を含む `path:line` 形式の引用が最終回答本文に現れている間、the 評価ハーネス shall その観点では FAIL を生成しない。

### Requirement 3: B′ 評価ケースの追加
**Objective:** 評価基盤のメンテナとして、出典必須の観点を実データで検証したい。そうすれば出典を満たさない回答が FAIL・満たす回答が PASS になることを回帰的に確認できる。

#### Acceptance Criteria
1. The 評価ハーネス shall docs 由来の B′ ケース（`axis: "B"`、既知の事実を問い、`answerIncludes` で正答を、`citesSource` で資料名の明示を要求する）を最低 1 件含む。
2. The 評価ハーネス shall code 由来の B′ ケース（`axis: "B"`、挙動仕様を問い、`source: "code"` と `readPathIncludes` に加え `citesSource` で `path:line` 引用を要求する）を最低 1 件含む。
3. When 追加した B′ ケースの出典要求を満たす回答が得られる、the 評価ハーネス shall そのケースを PASS とする。
4. If 追加した B′ ケースの出典要求を満たさない回答が得られる、then the 評価ハーネス shall そのケースを FAIL とする。

### Requirement 4: 既存ケースとの後方互換
**Objective:** 評価基盤のメンテナとして、出典検査の追加が既存の評価を壊さないことを保証したい。そうすれば安心して基盤を拡張できる。

#### Acceptance Criteria
1. When 既存の `eval/cases.json` の 7 ケースを修正なしで実行する、the 評価ハーネス shall それら全ケースを従来通り PASS とする。
2. Where ケースに「出典必須」（`citesSource`）が指定されていない場合、the 評価ハーネス shall 出典体裁の検査を行わず、そのケースの判定を従来と同一に保つ。
3. The 評価ハーネス shall 既存の `expect` フィールド（`toolsUsedAny` / `toolsUsedAll` / `source` / `argIncludes` / `readPathIncludes` / `answerIncludes` / `answerOmits`）の意味と「指定された項目だけを検査する」方針を変更しない。
4. The 評価ハーネス shall 新たな外部依存を追加しない。
5. When 型チェック（`bun run typecheck`）を実行する、the 評価ハーネス shall エラーなく完了する。
