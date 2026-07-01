# Brief: eval-citation-check

## Source
GitHub issue #29

## Problem
非エンジニアが答えの正しさを自分で確かめる唯一の手段は**出典**である。`buildSystem`（`src/chat/core.ts` L31-39）は既に「やさしい説明→根拠（資料名/見出し、コードは path:line）」を要求しているが、eval ハーネスは**出典が実際に付いているかを検査していない**。そのため「出典を出す」という到達目標（軸 B′ = 正しくあり続ける）が回帰しても客観採点で検知できない。

## Current State
- `scripts/kb-eval.ts` の `Expect`（L22-37）は `toolsUsedAny` / `toolsUsedAll` / `source` / `argIncludes` / `readPathIncludes` / `answerIncludes` / `answerOmits` を持つが、出典の体裁を検査する項目が無い。
- `evalCase(expect, calls, answer)`（L81-124）は回答本文 `answer` を第 3 引数で受け取れるが、`answerIncludes`/`answerOmits` の単純な部分文字列一致にしか使っていない。
- 先行の eval-scorecard（#28、マージ済み）が軸タグ（`axis: "A"|"B"|"C"|"D"|"safety"`）・合否ゲート・スコアカードの**枠**を用意済み。B′ ケースはこの枠の上に載る前提。
- `eval/cases.json` の既存 7 ケースには B′（出典）を検査するケースが無い。

## Desired Outcome
- `expect.citesSource: true` を指定すると、最終回答に**出典の体裁**（`.md` ファイル名/見出し、またはコードの `path:line`）が含まれることを検査でき、含まれなければ FAIL する。
- コードが根拠になる質問では `readPathIncludes` と `citesSource` を併用し、「読んだ path が回答本文にも引用されているか」を検査できる。
- docs 由来・code 由来の B′ ケースが各 1 件以上あり、出典を満たさない回答が FAIL・満たす回答が PASS する。
- 既存 7 ケースは無改修で PASS し、`bun run typecheck` がクリーン。

## Approach
`Expect` に真偽値フィールド `citesSource?: boolean` を追加し、`evalCase()` に出典体裁の判定を 1 ブロック追加する。判定は LLM ジャッジを使わず、回答本文に対する**客観的なパターン照合**（`.md` を含む資料名/見出しの言及、または `path:line` 形式のコード引用の存在）で行う。`readPathIncludes` と併用された場合は、その path 文字列が回答本文にも現れるかを追加で確認する。既存採点の「指定された項目だけを検査する」方針を保ち、`citesSource` 未指定ケースには一切影響させない。`eval/cases.json` に `axis: "B"` の B′ ケース（docs 由来・code 由来）を追加する。本番コード `src/` は変更しない。

## Scope
- **In**:
  - `scripts/kb-eval.ts` の `Expect` に `citesSource` を追加
  - `evalCase()` に出典体裁の判定を追加（`.md` 資料名/見出し、またはコード `path:line`）
  - `readPathIncludes` × `citesSource` 併用時の「読んだ path が回答本文にも現れるか」の判定
  - `eval/cases.json` に B′ ケース追加（docs 由来 + code 由来、`axis: "B"`）
  - 必要なら `eval/cases.sample.json` の追従
- **Out**:
  - 本番コード `src/` の変更
  - 意味的な忠実性の LLM ジャッジ導入（別 issue に委ねる）
  - docs とコードの「ドリフト」検証（#30 が所有）
  - 「次の一歩」など他の採点種別（#31 が所有）
  - 軸タグ・ゲート・スコアカードの枠そのもの（#28 = eval-scorecard が所有・実装済み）

## Boundary Candidates
- **採点ロジックの拡張**: `Expect` 型 + `evalCase()` への `citesSource` 判定追加（回答本文に対する客観照合）
- **評価ケースの追加**: `eval/cases.json` への B′ ケース（docs/code）追加
- **併用セマンティクス**: `readPathIncludes` と `citesSource` を組み合わせた「読んだ path の本文引用」検査

## Out of Boundary
- 出典が「正しいか（実在・該当箇所か）」の意味的検証 — 本 spec は**体裁の有無**の客観判定までに限定する。
- 回答が根拠に忠実か（幻覚していないか）の LLM ジャッジ — 必要になれば別 issue。
- 軸別集計・ゲート・スコアカード表示の実装 — #28 が所有。

## Upstream / Downstream
- **Upstream**: eval-scorecard（#28、マージ済み）の軸タグ／ゲート／スコアカードの枠。`Expect`・`evalCase()`・`validateCases()`・`RawCase`/`Case` 型（`scripts/kb-eval.ts`）。`buildSystem` の出典要求（`src/chat/core.ts` L31-39）。
- **Downstream**: docs/コード ドリフト検証（#30）、次の一歩チェック（#31）が同じ `Expect`/`evalCase` 拡張パターンの上に載る想定。親マイルストーン #27（評価基盤）。

## Existing Spec Touchpoints
- **Extends**: なし（eval-scorecard は「枠」のみを所有し、本採点種別の中身は #29 が新規に所有する、と同 spec が明記）。同じファイル `scripts/kb-eval.ts` / `eval/cases.json` を触るが、責務境界は別。
- **Adjacent**: `eval-scorecard`（`.kiro/specs/eval-scorecard/`）。`Expect`/`evalCase`/`validateCases` の既存意味と「指定項目だけ検査」方針・SKIP 挙動を壊さないこと。

## Constraints
- 新たな外部依存を追加しない（客観的なパターン照合のみで実装）。
- 既存 7 ケースは無改修で PASS を維持（後方互換）。
- `citesSource` 未指定ケースの判定は不変。
- `bun run typecheck` がエラーなく完了すること。
- 出力は日本語（spec.json.language = ja）。
