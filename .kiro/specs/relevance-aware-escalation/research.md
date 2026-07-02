# Research & Design Decisions: relevance-aware-escalation

## Summary
- **Feature**: `relevance-aware-escalation`
- **Discovery Scope**: Extension（検索に純粋関数を追加＋`startHard` 差し替え）
- **Key Findings**:
  - `startHard`（`core.ts` L202）は `hits.length===0` 限定発火。`dropWeakHits`（`db.ts` L93 `i===0`）が最上位を無条件保持し、`buildMatchQuery` は内容語 OR 一致のため、無関係1件でも hits≥1 → 昇格が発火しない。
  - `segment.ts` の `queryTerms`（内容語抽出）・`indexTokens`（索引用トークン列）が既存にあり、関連性判定に再利用できる → コーパス非依存のカバレッジ指標を新規依存なしで作れる。
  - bm25 はコーパス非正規化（`dropWeakHits` のコメントも明記）→ 絶対しきい値は不採用、カバレッジ採用。

## Research Log

### 「実質空振り」をコーパス非依存に判定する方法
- **Context**: 生 bm25 の絶対しきい値は脆い（コーパス依存）。
- **Sources Consulted**: `src/kb/db.ts`（`search`/`dropWeakHits`/`buildMatchQuery`）、`src/kb/segment.ts`（`queryTerms`/`indexTokens`）、`src/chat/core.ts`（`startHard` L202）。
- **Findings**: FTS の OR 一致は「最低1語一致」を保証するので「1語以上一致」は無意味。質問の内容語のうち最上位ヒットが含む割合（カバレッジ）なら、コーパス非依存で「実質関連か」を測れる。
- **Implications**: `queryCoverage(query, text)` と `isSubstantiveTopHit(query, hits)` を純粋関数で追加し、`startHard` を「空 or カバレッジ不足」に。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 内容語カバレッジ（採用） | 質問内容語の top hit 含有率 | コーパス非依存・既存トークナイザ再利用・`bun test` 可 | しきい値はヒューリスティック | 既存 `queryTerms`/`indexTokens` を再利用 |
| bm25 絶対しきい値 | score の絶対値で判定 | 実装容易 | コーパス非正規化で脆い（コメントで明記） | 却下 |
| 埋め込み類似度 | ベクトル近傍 | 意味的に頑健 | 課金・依存増・Non-Goal | 却下 |

## Design Decisions

### Decision: しきい値 0.5・単一内容語は非昇格
- **Context**: FTS OR は最低1語一致を保証、単一語クエリは分母1。
- **Selected Approach**: カバレッジ ≥ 0.5 を substantive。単一内容語は一致時 1.0＝substantive（＝従来どおり昇格しない・非回帰）。
- **Rationale**: 半数以上の内容語を含めば実質関連という直感。定数化して単体テストで固定。
- **Trade-offs**: 過剰/過小昇格の余地。定数化で調整可能に。

## Risks & Mitigations
- しきい値ヒューリスティックの誤判定 — 定数化＋代表ケースの単体テストで固定。過剰昇格はコスト増だが correctness は損なわない。`canEscalate` 偽なら無効化されるため未設定環境は無影響。
- トークン化のズレ（英語/記号） — 判定・索引とも同じ `segment.ts` を用いるため整合。

## References
- `src/kb/db.ts` / `src/kb/segment.ts` / `src/chat/core.ts` — 実装対象と再利用元。
- `.kiro/specs/reduce-dead-ends`（#39）— 協調する第1弾（コード確認必須化）。
- メモリ: kb-bot-degradation-fix-deferred — 劣化対処プラン全体。
