# Gap Analysis: eval-citation-check

要件（`requirements.md`）と既存コード（`scripts/kb-eval.ts` + `eval/cases.json`）の差分を分析し、design 判断へ引き継ぐ。

## 分析サマリ

- **着地点は特定済み・拡張は既存パターンに素直に載る**: `evalCase()` は既に第 3 引数 `answer`（回答本文）を受け取っており、`answerIncludes`/`answerOmits` で本文照合する前例がある。`citesSource` の判定はこの直後にもう 1 ブロック足すだけ。
- **後方互換は構造的に担保されやすい**: 既存採点は「`expect` に指定された項目だけ検査」。`citesSource` 未指定なら新ブロックは何もしない → 既存 7 ケースと未指定ケースの判定は不変（Req 4.1/4.2）。
- **SKIP・ゲート・軸集計の枠は無改修で機能する**: code B′ ケースは `source:"code"` + `readPathIncludes` により既存の `needsGh` 判定で GitHub 未設定時に自動 SKIP される（Req 5 維持）。`axis:"B"` は `buildScorecard` がそのまま軸別集計する。
- **唯一の実質的な設計判断は「出典体裁の検出ヒューリスティック」**: 「`.md` 資料名/見出し」と「コード `path:line`」を客観照合する具体パターン。ここだけ design で確定が必要（下記 Research Needed）。
- **新規依存ゼロ・複雑度 S / リスク Low**: 純粋な文字列/正規表現照合のみ。外部依存も本番コード（`src/`）変更も不要。

## Requirement → Asset Map（gap タグ: Extend / Design-Decision / None）

| 要件 | 着地アセット | gap |
|---|---|---|
| Req 1: 出典体裁の検査 | `Expect` に `citesSource?: boolean` 追加（`kb-eval.ts` L22-37）＋ `evalCase()` に判定ブロック追加（L116-121 の後、`return fails` の前 L123） | **Extend** + **Design-Decision**（検出ヒューリスティック） |
| Req 1.2: FAIL を他と区別 | `evalCase` の `fails.push("<出典が無い旨>")`。既存同様 `fails[]` に日本語理由を積む前例あり | **Extend** |
| Req 2: 読んだ path の本文引用 | `citesSource` × `readPathIncludes` 併用時に「回答本文に path 文字列が現れるか」を追加照合。`readPathIncludes` の値は既存判定（L109-114）と同じフィールドを再利用 | **Extend** + **Design-Decision**（併用セマンティクスの決め） |
| Req 3.1: docs 由来 B′ ケース | `eval/cases.json` に 1 件追加（`axis:"B"`, `source:"docs"`, `answerIncludes`, `citesSource:true`） | **Extend**（データ） |
| Req 3.2: code 由来 B′ ケース | `eval/cases.json` に 1 件追加（`axis:"B"`, `source:"code"`, `readPathIncludes`, `citesSource:true`） | **Extend**（データ） |
| Req 3.3/3.4: 満たす/満たさないで PASS/FAIL | 判定は Req 1/2 の実装で自然に成立。実データでの PASS/FAIL 実証はライブ LLM 実行に依存 | **None**（設計上自明・実証は実行時） |
| Req 4.1: 既存 7 ケース無改修 PASS | 既存ケースは `citesSource` 未指定 → 新ブロック不作用 | **None**（回帰確認のみ） |
| Req 4.2: 未指定は判定不変 | `if (expect.citesSource) { ... }` でガード | **None** |
| Req 4.3: 既存 `expect` の意味不変 | 既存フィールドは触らず追記のみ | **None** |
| Req 4.4: 外部依存追加なし | 正規表現/文字列のみ | **None** |
| Req 4.5: `bun run typecheck` クリーン | optional boolean + ブロック追加。strict/`noUncheckedIndexedAccess` 下でも型安全 | **None** |

## 実装アプローチ

### Option A: 既存 `evalCase`/`Expect` を拡張（推奨）
`Expect` に `citesSource?: boolean` を足し、`evalCase()` 末尾（`return fails` 直前）に判定ブロックを 1 つ追加。`eval/cases.json` に B′ ケース 2 件を追記。
- ✅ 既存パターン（`answerIncludes` 等の本文照合）と完全に同型。差分最小・レビュー容易。
- ✅ SKIP/軸集計/ゲート/スコアカードの枠は無改修で機能。
- ✅ 「指定項目だけ検査」方針をそのまま維持 → 後方互換が構造的に保証される。
- ❌ `evalCase` が一段長くなる（現状 L81-124、許容範囲）。
- ❌ 検出ヒューリスティックの精度は design で詰める必要（誤検知/見逃しリスクは A/B/C 共通）。

### Option B: 出典判定を別ヘルパー関数に切り出す
検出ロジックを `citesSource(answer, opts): string[]`（または boolean+理由）として純粋関数に分離し、`evalCase` から呼ぶ。
- ✅ `buildScorecard`/`overallPassed` 等と同じ「純粋関数＋export でユニットテスト可能」の既存パターンに沿う。検出ヒューリスティックを `bun test` で単体検証できる（tech.md の「資格情報不要の純粋関数を test 対象」に合致）。
- ✅ `evalCase` の肥大化を避け、責務が明確。
- ❌ ファイル内に関数が 1 つ増える（軽微）。
- ⚠️ 実質 Option A の内部整理版。A と排他ではなく、A の中で「検出部を純粋関数に切り出す」と読むのが自然。

### Option C: 新ファイル/新モジュール化
出典検査を独立モジュールに切り出す。
- ❌ 単一の小判定にはオーバーエンジニアリング。`kb-eval.ts` 内で完結する規模であり不要。却下。

**推奨**: Option A をベースに、検出ヒューリスティックだけ Option B のように**純粋関数へ切り出して export**（`bun test` でヒューリスティックを回帰検証できるのが決め手）。本番コード非改変・既存枠再利用の方針に最も整合する。

## Research Needed（design フェーズで確定）

1. **出典体裁の検出ヒューリスティック**（最重要）:
   - docs 出典: 「`.md` を含む資料名」の検出は `/\S+\.md\b/` 系で妥当か。「見出し」の扱い（見出し文字列の照合をどこまで求めるか、あるいは `.md` ファイル名の言及で足りるとするか）。
   - code 出典: `path:line` の検出パターン（例 `/[\w./-]+\.\w+:\d+/`）。拡張子なし path や範囲表記（`:12-20`）を許容するか。
   - buildSystem（`src/chat/core.ts` L31-39）が実際に生成する出典文体に合わせ、**過検出（無関係な `.md` 言及を出典と誤認）と見逃し**のバランスを決める。
2. **Req 2 の併用セマンティクス**: `citesSource` 単独＝汎用体裁の有無、`readPathIncludes` 併用時＝「その path 文字列が回答本文にも現れる」を追加要求、という解釈で確定してよいか。FAIL 理由文の文言（体裁欠如 vs path 未引用を区別）。
3. **B′ ケースの具体題材**: docs 由来は既存 docs（例 `auth.md` の 90 日）を流用し `citesSource` を上乗せ。code 由来は既存の `unicode61`/フォールバック題材に `readPathIncludes`（例 `db.ts`）+ `citesSource` を上乗せする案。実在資料/コードに合わせて確定。

## Effort & Risk

- **Effort: S（1–3 日）** — 既存パターンの拡張・単一ファイル中心・データ追加のみ。ライブ実行での挙動確認を含めても小。
- **Risk: Low** — 新依存なし・本番コード非改変・後方互換が構造的に担保。唯一の不確実性は検出ヒューリスティックの精度だが、純粋関数化＋`bun test` で閉じられ、ケースは体裁に合わせて著者が調整できる。

## design フェーズへの引き継ぎ（推奨事項）

- **採用アプローチ**: Option A（既存拡張）＋検出ヒューリスティックを純粋関数として export（B の要素）。
- **確定すべき鍵**: 上記 Research Needed 1・2（検出正規表現と併用セマンティクス）。ここを Boundary Commitments として明文化する。
- **回帰の担保**: 既存 7 ケースの無改修 PASS と、検出ヒューリスティックの `bun test` 単体検証を design/tasks の検証項目に含める。

---

## Design Synthesis 結果（design フェーズ）

- **Generalization**: Req 1（出典体裁）と Req 2（読んだ path の本文引用）は「回答本文に対する出典照合」という同一問題の変種。単一の純粋関数 `citationFails(expect, answer)` に集約し、Req 2 は `readPathIncludes` 併用時の追加サブチェックとして自然に内包した（インターフェースで一般化、実装は現要件のみ）。
- **Build vs. Adopt**: 出典体裁の検出は正規表現 2 本（`DOC_CITATION`/`CODE_CITATION`）で足りる。外部の citation パーサ等は不要（Req 4.4 の「新規依存なし」とも整合）。判定は自作するが規模は極小。
- **Simplification**: 独立モジュール化（Option C）は却下。`kb-eval.ts` 内に純粋関数 1 つを追加するのみ。見出し（ファイル名を伴わないセクション名）の照合は客観検出が困難なため検出対象外とし、体裁は**ファイル名/path 形式に限定**（Non-Goal 化）。これにより過検出リスクと実装複雑度を抑える。

### 確定した検出規約（Boundary Commitment）
- doc 引用: `DOC_CITATION = /[\w./-]+\.md\b/`（例 `auth.md`, `docs/auth.md`）。
- code 引用: `CODE_CITATION = /[\w./-]+\.[A-Za-z0-9]+:\d+/`（例 `db.ts:42`, `src/kb/db.ts:120`）。
- `citesSource:true` かつ `readPathIncludes` 未指定: doc/code いずれの引用も無ければ体裁欠如 FAIL。
- `citesSource:true` かつ `readPathIncludes` 併用（code B′）: 汎用体裁ではなく**厳格判定**。回答本文中の `CODE_CITATION`（`path:line`）一致のうち、path 部分に `readPathIncludes` を含むものが 1 つ以上なければ「読んだ path が行番号付きで引用されていない」FAIL。厳格判定は汎用体裁を内包するため併用時は汎用チェックを重ねない。

### 設計レビュー（kiro-validate-design）での決定
- **Issue 1 の対応**: code 出典を厳格化。「読んだファイルを `path:line` 形式（行番号付き）で引用」を要求する（上記併用判定）。ユーザ選択により、無関係な `path:line` や行番号なしの素の path 言及では通らないようにした。requirements.md Req 2（見出し「読んだファイルの行番号付き引用検査」）へ反映済み。

### テスト可能性の決定
- `evalCase` は現状 export されておらずライブ実行依存。判定を純粋関数 `citationFails` に切り出して export し、`test/kb-eval.test.ts`（`bun test`・資格情報不要）で検出規約を回帰検証する（`buildScorecard` 等と同じ既存パターン）。

### リスク
- 過検出/見逃しは客観判定の本質的限界。B′ ケースは体裁が明確に出る/出ない回答を誘発するよう著者が設計して吸収する。
