# Research & Design Decisions: reduce-dead-ends

## Summary
- **Feature**: `reduce-dead-ends`
- **Discovery Scope**: Simple Addition / Extension（`buildSystem` プロンプト追記のみ）
- **Key Findings**:
  - `buildSystem` は `base`（常時）＋`withGh`（GitHub 有効時のみ）＋`[Operator instructions]` の合成。not-found 文（+#31 next-step）は `base`、コード優先指示は `withGh` にある。
  - 「未発見前のコード確認」は参照コードがある GitHub 有効時のみ意味を持つため、`withGh` に置けば Req 1.4（無効時は不適用）を**構造で**満たせる（文言分岐不要）。
  - 当初含めた「諦め回答の非キャッシュ化」は `dropWeakHits` が無関係ヒットを残し FTS 件数で実質空振りを判定できないため頑健にできない → A経路スコア化 follow-on へ移管（関連性スコア導入後に決定的化）。

## Research Log

### buildSystem の合成構造と not-found の所在
- **Context**: 「未発見前にコード確認」をどこに足せば無効時に漏れないか。
- **Sources Consulted**: `src/chat/core.ts` `buildSystem`（L23-46）、`test/systemPrompt.test.ts`。
- **Findings**: not-found + next-step は `base` L29（常時）。コード優先は `withGh` L38-39（GitHub 有効時のみ連結）。`withGh` への追記は GitHub 無効時に自動的に出ない。
- **Implications**: 追記先は `withGh`。`base` は無改変で #31 と非干渉。

### キャッシュ対処を分離した根拠
- **Context**: 「諦め回答をキャッシュしない」を本仕様に含めるか。
- **Findings**: found/not-found は FTS 件数・ツール使用では区別不能（未発見でもコードは読む）。FTS 0件ルールは `dropWeakHits`（最上位を無条件保持）のためほぼ発火せず実効性が低い。頑健な判定には retrieval 関連性スコアが必要。
- **Implications**: キャッシュ対処は A経路スコア化 follow-on スペックへ移管。本仕様は Req 1（コード確認必須化）に集中。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| withGh へ追記（採用） | GitHub 有効時ブロックに 1 文 | Req 1.4 を構造で保証・base 無改変・#31 非干渉 | 弱いモデルの追従は非決定（別領域） | — |
| base へ追記 | not-found 文へ直接追記 | 変更箇所が近い | GitHub 無効時にも「コード確認」を促し矛盾（Req 1.4 違反） | 却下 |

## Design Decisions

### Decision: 追記は条件付き（実装/挙動系・docs で不足時のみ）
- **Context**: Req 1.3（docs で足りれば強制しない）と既存 [Routing]。
- **Selected Approach**: 「実装・挙動・仕様・コスト系の質問で docs だけでは答えられない場合、not-found 前に実コードを確認」と条件付け。
- **Rationale**: 手順・ルール系（docs で足りる）に不要なコード探索を強制せず、コスト・レイテンシ増を避ける。
- **Trade-offs**: 文言がやや長くなるが挙動は的確。

## Risks & Mitigations
- 弱いモデルが指示に従わないことがある（ライブ非決定） — 本仕様はプロンプト内容の決定性のみ保証。追従率底上げは A経路スコア化・モデル設定 follow-on。効果測定は既存 eval（#30 drift 等）。
- #31 next-step 文言との干渉 — `base` を無改変にし `withGh` のみ追記、`systemPrompt.test` で両者保持を回帰。

## References
- `src/chat/core.ts` `buildSystem` — 追記対象。
- `.kiro/specs/eval-next-step`（#31）— not-found 文に同居する next-step の所有元。
- `.kiro/specs/eval-drift-tolerance`（#30）— コード優先の効果測定に使う既存 eval。
- メモリ: kb-bot-degradation-fix-deferred — 劣化対処プラン全体とキャッシュ移管の経緯。
