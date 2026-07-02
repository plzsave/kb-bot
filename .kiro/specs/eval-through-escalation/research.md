# Research & Design Decisions: eval-through-escalation

## Summary
- **Feature**: `eval-through-escalation`
- **Discovery Scope**: Extension / Refactor（orchestration 抽出＋eval 配線）
- **Key Findings**:
  - `kb-eval.ts` は `runAgent` 直呼びで `answer()` の A/B 昇格・404 フォールバックを通らない → 常に基本モデル。#40 の効果を測れない。
  - 昇格 orchestration は `answer()` 内にインライン（`runOnce`＋A/B＋`runAgentWithFallback`）。副作用（逐次表示・thinkingHard）はコールバックで外出しすれば純粋な orchestrator に抽出可能。
  - `escalation.test.ts` が `answer()` の model 列を固定 → behavior-preserving リファクタのガードになる。

## Research Log

### 昇格 orchestration の抽出可否
- **Context**: eval と answer() で昇格を共有するには何を切り出すか。
- **Sources Consulted**: `src/chat/core.ts`（`runAgentWithFallback` L102-117 / `runOnce` L183-198 / A/B ブロック L200-218）、`scripts/kb-eval.ts`（runAgent 直呼び）、`test/escalation.test.ts`。
- **Findings**: 純粋部分は「開始ティア決定→runAgentWithFallback→truncated なら modelHard 再実行」。副作用は逐次バッファ(`pending`/`lastEdit`)・`ui.thinkingHard` 表示のみ。→ `onDelta`/`onEscalate` コールバックで外出しすれば抽出できる。
- **Implications**: `runWithEscalation` を新設し `answer()` はコールバックを渡すだけ。eval はコールバック省略＋recordTool ツール注入。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks | Notes |
|--------|-------------|-----------|-------|-------|
| 共有関数抽出（採用） | orchestration を `runWithEscalation` に | drift 無し・両者同一挙動・テスト可 | answer() の behavior 保全に注意 | escalation.test がガード |
| eval に昇格複製 | eval 側で A/B を再実装 | core を触らない | production と drift | 却下 |
| eval を一律 hard | 全ケース modelHard で実行 | 実装容易 | per-question 昇格を反映せず floor↔ceiling が入替わるだけ | 却下 |

## Design Decisions

### Decision: 副作用はコールバック（onDelta/onEscalate）で呼び出し側に残す
- **Context**: `answer()` の逐次表示・thinkingHard・バッファリセットは Slack/Discord 表示に固有。
- **Selected Approach**: orchestrator は「どのティアで何回 runAgent するか」に限定。逐次は `onDelta`、B経路直前フックは `onEscalate`。
- **Rationale**: orchestrator をプラットフォーム非依存に保ち eval からも呼べる。answer() は挙動不変。
- **Trade-offs**: 呼び出し側にバッファ初期化責務が残る（onEscalate で実施）。

## Risks & Mitigations
- `answer()` の逐次バッファ初期化位置ズレによる表示回帰 → `escalation.test.ts`（final テキスト）＋手動 smoke。
- eval のツールトレース採点が壊れる → tools は従来どおり `recordTool` でラップして `runWithEscalation` に注入（採点ロジックは不変）。

## References
- `src/chat/core.ts`（抽出元）/ `scripts/kb-eval.ts`（配線先）/ `test/escalation.test.ts`（ガード）。
- `.kiro/specs/relevance-aware-escalation`（#40・startHard/`isSubstantiveTopHit` 提供）。
- メモリ: kb-bot-degradation-fix-deferred（kb:eval が escalation を通らない事実）。
