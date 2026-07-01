# Gap Analysis: eval-drift-tolerance

要件（`requirements.md`）と既存コードの差分を分析し、設計フェーズの意思決定材料をまとめる。結論は選ばず、選択肢と根拠・研究項目を提示する。

## 1. 現状調査（Current State）

### 評価ハーネス `scripts/kb-eval.ts`
- 起動時に **単一の共有 DB** を開く: `const db = openDb(dbPath())`（L353）。全ケースがこの 1 つの `db` を共有する。
- 各ケースで本番同等の前処理を組む: `search(db, c.question, TOP_K=5)` の結果を初期コンテキストに前置き（L384-386）＋ `buildSystem(github)`（L392）＋ ツール群 `searchKnowledgeTool(db)` と `githubTools(github)`（L378-381）。**FTS も search_knowledge ツールも同じ `db` を指す**。
- 採点は「指定項目だけ」検査する純粋関数群: `evalCase()`（L119-166、`source`/`answerIncludes`/`answerOmits`/`readPathIncludes` 等）＋ `citationFails()`（B′ 出典、L55-75、`citesSource`）。
- `needsGh` による SKIP（L365-375）: `source==="code"|"both"`、GH ツール期待、または `readPathIncludes` を持つケースは GitHub 未設定時に **自動 SKIP**。SKIP は集計・ゲート母数から除外（L232 系、eval-scorecard 実装済み）。
- ケース検証 `validateCases()`（L168-186）: `axis` は `A|B|C|D|safety` のみ許容。`gate` は boolean。

### ナレッジ層 `src/kb/`（再利用可能な部品が揃っている）
- `openDb(path)`（`db.ts` L18-32）: `new Database(path, { create: true })`。FTS5(`unicode61`) 仮想表を `IF NOT EXISTS` で作る。**新規パス（一時ファイル／`:memory:`）を渡せば空の索引が得られる**。
- `replaceDoc(db, docKey, chunks)`（L35-43）: doc 単位で索引を入れ替え。`chunkMarkdown()` 出力をそのまま投入できる。
- `chunkMarkdown(md)`（`chunk.ts` L35-48）: Markdown → `Chunk[]`（frontmatter 剥がし・見出しパンくず付き）。ingest と同じ経路。
- `search(db, query, limit)`（L73-83）: FTS5 + BM25。
- **ingest の実体**（`ingest.ts` L38-40）は `chunkMarkdown → replaceDoc` の 2 ステップ。フィクスチャ索引もこの 2 行で構築できる。

### 設定 `src/config.ts`
- `dbPath()`（L35-37）: `process.env.KB_DB_PATH ?? "./kb.sqlite"`。**環境変数でハーネス全体の DB パスを差し替え可能**。
- env は `KB_` プレフィックス規約（`KB_DB_PATH` / `KB_GITHUB_REPOS` 等）。

### 矛盾ペアの裏取り（コード側 Y の実在確認済み）
- **キャッシュ TTL**: `src/cache.ts` `TTL_MS` 既定 24h（L9-12、確認済み・コメントに明記）。既存ケースで未使用＝**重複が無く推奨**。
- **FTS トークナイザ**: `unicode61`（`src/kb/db.ts` L28、`src/kb/segment.ts`、steering `tech.md` にも「`trigram` は不採用」と明記）。ただし既存 `B′ code` ケース（`readPathIncludes:"db.ts"`, `answerIncludes:["unicode61"]`）と**トピックが重複**。
- **モデル退役時フォールバック**: 既存 `code` ケースと重複気味・相対的に不安定。非推奨。

## 2. 要件↔資産マップ（gap タグ: Missing / Unknown / Constraint）

| 要件 | 必要な技術要素 | 既存資産 | gap |
|---|---|---|---|
| R1 コード優先の採点 | `answerIncludes:[Y]`＋`answerOmits:[X]`＋`source:"code"`（+`readPathIncludes`） | `evalCase()` に全項目実装済み | 追加コード不要。ケース定義のみ |
| R1.5 軸 B′ タグ | `axis:"B"` を集計に載せる | `validateCases`/scorecard 実装済み | なし |
| R2.1 矛盾提示（stale doc を context へ） | フィクスチャ doc を FTS 前置き/`search_knowledge` に載せる | 共有 `db` は本番 KB のみ | **Missing**: フィクスチャを索引へ載せる経路 |
| R2.2/2.3 本番 KB 分離 | フィクスチャ用の隔離索引 | `openDb(新パス)`＋`replaceDoc`＋`chunkMarkdown` で構築可 | **Constraint**: 共有 `db` を全ケースが使う（L353） |
| R2.4 提示が必須条件 | フィクスチャが確実に context に入る | 隔離 db にフィクスチャのみ載せれば `search` は必ずヒット | 設計で担保 |
| R3 GitHub 未設定で SKIP | `needsGh` 規則 | `source:"code"`/`readPathIncludes` で自動 SKIP | なし（既存規則に自然に載る） |
| R4 矛盾ペアの妥当性 | X≠Y 明確・Y は安定実在 | TTL 24h / unicode61 で確認済み | 設計でペア確定（TTL 推奨） |
| R5 非回帰 | 既存ケース無改修 PASS・`src/` 不変・typecheck | 既存ケースは本番 `db` 依存 | **Constraint**: 全ケース共有 `db` を壊さない方式が必要 |

**中核の gap**: 「フィクスチャを本番 KB と分離したまま bot の context に提示する」経路が無い（Missing）。かつ、ハーネスが全ケースで単一 `db` を共有し、既存 `docs:` ケースは本番 KB の内容に依存する（Constraint）。この 2 点が方式選択を規定する。

## 3. 実装アプローチ選択肢

### Option A（推奨）: ケース単位のエフェメラル・フィクスチャ索引
ケースに任意フィールド（例 `fixtures`: `eval/fixtures/*.md` 参照 or インライン md）を追加。フィクスチャを持つケースだけ、ループ内で隔離 db（一時ファイル or `:memory:`）を `openDb` し `chunkMarkdown→replaceDoc` で seed、その db を **`search()` と `searchKnowledgeTool()` の両方**に渡す。フィクスチャ無しのケースは従来どおり共有本番 db を使う。GitHub コード（Y）は `githubTools` で常時参照可能。
- **どこを変えるか**: `scripts/kb-eval.ts` の実行ループ（L362-402）で「このケースが使う db」を分岐。`buildFixtureDb(fixtures)` ヘルパ追加。フィクスチャ md は `eval/fixtures/` に配置。
- ✅ 既存 `docs:` ケースは本番 db のまま＝**R5.1 を確実に満たす**。隔離 db にフィクスチャのみ→ `search` が必ずヒット＝**R2.4 を構造的に保証**。本番 KB 不変＝R2.2/2.3。本番同等の FTS 前処理を維持。`src/` 無改変（既存部品の呼び出しのみ）。
- ❌ ループにわずかな分岐追加。エフェメラル db のライフサイクル（生成/破棄）管理が要る。
- **Effort**: S–M / **Risk**: Low

### Option B: 別ケースファイル＋`KB_DB_PATH` 差し替え（別ラン）
`eval/cases.drift.json` を新設し、事前 seed した専用フィクスチャ DB を指す `KB_DB_PATH` で**別実行**する。`cases.json` は本番 db で従来どおり実行。
- ✅ 実行ループのコード変更が最小。分離が明快。
- ❌ 実行が 2 回に分かれる＋フィクスチャ DB の seed ステップ（ビルド）が要る。単一スコアカードに統合しづらい。運用手順が増える。issue が挙げた候補だが、本番 KB を混ぜないと drift ラン側で docs ケースは走れない。
- **Effort**: M / **Risk**: Medium（運用・CI 手順の複雑化）

### Option C: FTS を介さない直接コンテキスト注入
drift ケースだけ `search()` を通さず、stale フィクスチャ本文を初期プロンプトへ直接差し込む。
- ✅ 最も単純・決定的・完全隔離。索引構築不要。
- ❌ 「本番と同じ前処理」から乖離（検索経路を通らない）。`search_knowledge` ツールはフィクスチャを返さない＝矛盾提示が初期プロンプト限定。retrieval の忠実性が落ちる。
- **Effort**: S / **Risk**: Medium（本番挙動との乖離）

## 4. Effort / Risk サマリ
- 総合 **Effort: S–M**（1–4日）: 部品は全て既存、追加は「隔離索引の組み立て＋ケース定義」。
- 総合 **Risk: Low–Medium**: 最大のリスクは索引方式ではなく **LLM の非決定性**と採点の頑健性（下記）。

## 5. Research Needed（設計へ持ち越す論点）
1. **`answerOmits:[X]` の誤 FAIL リスク**: モデルが「X ではない／trigram は使っていない」と**否定形で X を言及**すると `answerOmits` が誤 FAIL する。対策候補: X を「否定文脈と両立しない値」に選ぶ／`answerOmits` を使わず `answerIncludes:[Y]`＋`source:"code"`＋`readPathIncludes` で担保する、等を設計で決定。
2. **矛盾ペアの最終確定**: TTL（`無期限` X ↔ `24h` Y、`cache.ts` 根拠、既存ケースと非重複＝推奨）を第一候補に、Y の安定性と X/Y の弁別性で確定。unicode61 は既存 B′ ケースと重複する点に注意。
3. **フィクスチャの格納形式**: `eval/fixtures/*.md`（ファイル参照）か cases.json インライン md か。`eval/` 配下閉じ込め（R2.3）は共通。
4. **隔離 db の実体**: 一時ファイル（tmp）か `:memory:` か。`openDb` は `create:true`＋WAL 設定。`:memory:` での WAL 無害性・後始末を確認。
5. **stale doc の質**: 「いかにも本物だが古い」体裁（R4.3）。X を明示し Y を含めないフィクスチャ本文の設計。
6. **ケース定義の後方互換**: 追加フィールド（`fixtures` 等）は任意で、既存 `RawCase`/`validateCases` を壊さないこと（R5.4）。

## 6. 設計フェーズへの推奨
- **推奨アプローチ**: **Option A（ケース単位エフェメラル索引）**。既存部品（`openDb`/`replaceDoc`/`chunkMarkdown`/`search`）の再利用で `src/` 無改変を保ちつつ、R2.4（矛盾の確実な提示）と R5.1（既存ケース非回帰）を構造的に両立できる。
- **主要な決定事項**: 矛盾ペア（TTL 推奨）、`answerOmits` を使うか否か（誤 FAIL 対策）、フィクスチャ格納形式、隔離 db 実体、ケース追加フィールドの型と検証。
- **持ち越し研究**: 上記 §5 の 1–6。特に #1（採点の頑健性）は設計で方式を固定すること。

---

# 設計フェーズ追記: Discovery(light) と Synthesis

拡張機能（既存 eval ハーネスへの追加）につき **light discovery** を実施。新規外部依存なし。以下は設計時に確定した意思決定（`design.md` の根拠）。

## 統合方式の確定（Option A を採用）
- **採用**: ケース単位のエフェメラル・フィクスチャ索引（gap 分析 Option A）。
- **却下**: Option B（`KB_DB_PATH` 全体差し替え＋別ラン）＝既存 `docs:` ケースが本番 KB を要し 2 ラン化する。Option C（FTS 非経由の直接注入）＝本番前処理から乖離し `search_knowledge` がフィクスチャを返さない。

## 実証（設計前に PoC 済み）
`bun -e` で確認済み（2026-07-01）:
- `openDb(":memory:")` + `replaceDoc(chunkMarkdown(md))` で in-memory 索引を構築でき、`search()` が stale フィクスチャを確実にヒットさせる（`docKey` 一致を確認）。
- 2 個目の `openDb(":memory:")` は 0 chunks ＝ **各 in-memory db は完全隔離**。本番 `./kb.sqlite` に一切触れない（R2.2/2.3 を構造的に担保）。
- `openDb` の `PRAGMA journal_mode = WAL` は `:memory:` では無害（SQLite が memory journal を維持、エラーなし）。

## Build vs Adopt
- **Adopt（再利用）**: `openDb` / `replaceDoc` / `countChunks`（`src/kb/db.ts`）、`chunkMarkdown`（`src/kb/chunk.ts`）、`search`（同）、`searchKnowledgeTool(db)`（`src/agent/tools.ts`）、`evalCase` / `citationFails` / `validateCases`（`scripts/kb-eval.ts`、既存 export）。
- **Build（新規・最小）**: (1) `buildFixtureDb(fixturePaths): Database`（in-memory 索引組み立て、`kb-eval.ts` に export = 既存の「テスト可能な純粋関数を export」パターンに従う）、(2) `RawCase`/`Case` への `fixtures?: string[]` 追加、(3) 実行ループでの db 分岐、(4) `eval/fixtures/*.md` と drift ケース定義。
- `src/` は**新規追加も改変もしない**（R5.2）。フィクスチャ索引ヘルパは `scripts/kb-eval.ts` 内に閉じ、フィクスチャ本文は `eval/` 配下（R2.3）。

## Simplification / Generalization
- **1 ドリフトケースに絞る**（キャッシュ TTL ペア）。要件は「≥1 ケース」。索引機構は `fixtures` 配列で N 件に自然拡張可能だが、実装は現要件が要る 1 ケースに留める（インターフェースだけ一般化）。
- **`answerOmits` を使わない**（研究項目 #1 の解決）。stale 値 X=「無期限」は、正答が「ドキュメントには無期限とあるが実際は…」と**否定文脈で X に言及**すると誤 FAIL する。よって X の不在検出には頼らず、`answerIncludes:["24"]` + `source:"code"` + `readPathIncludes:"cache.ts"` + `citesSource:true` で「コードを信頼源に採り Y を出典付きで述べた」ことを積極的に判定する。X を parrot した回答は「24」を欠き cache.ts を引用しない→ FAIL（R1.2 の "Y を欠く" 分岐に合致）。

## 確定した矛盾ペア
- **キャッシュ TTL**: doc X=「回答キャッシュは無期限（失効しない）」 ↔ code Y=「既定 24 時間で失効」。コード根拠 `src/cache.ts` `TTL_MS`（L9-12）。既存ケースと非重複、Y は安定した実在の定数（R4.1/4.2/4.3）。
- フィクスチャ本文と質問は FTS でトークンが重なるよう作成（in-memory 索引がフィクスチャのみを持つため、語の重なりがあれば必ず前置きされる。R2.4）。

## リスク / 持ち越し
- **LLM 非決定性**（最大リスク・索引方式とは独立）: live eval でモデルがコードを読まず stale doc を鵜呑みにすると FAIL。これは**検知したい挙動そのもの**であり設計上の欠陥ではない。
- **フィクスチャの語彙重なり不足**: 質問とフィクスチャのトークンが重ならないと前置きされない。→ `buildFixtureDb` + `search` のユニットテストで「フィクスチャが retrievable」を検証（資格情報不要）。
