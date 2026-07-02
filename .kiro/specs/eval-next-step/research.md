# Research & Design Decisions: eval-next-step

## Summary
- **Feature**: `eval-next-step`
- **Discovery Scope**: Simple Addition / Extension（既存 `buildSystem` + `kb-eval.ts` への追記）
- **Key Findings**:
  - `evalCase(expect, calls, answer)` は「指定項目だけ検査」方針で、本文照合の前例（`answerIncludes`/`answerOmits`）と純粋関数抽出の前例（`citationFails`, #29）が既にある。→ `offersNextStep` は `citationFails` と同型に実装できる。
  - `Axis` 型に `"D"` は既存（#28 で追加済み）。軸タグ・ゲート・スコアカードの枠は無改変で `axis:"D"` を載せるだけでよい。
  - 未発見時の文言方針は `docs/USAGE.ja.md`「見つかりませんでした」節（対象名・キーワードを足す／言い換え／資料追加で答えられる）に既に定義済み。プロンプト追記と検出語彙はこれに一致させる。
  - `buildSystem` の未発見文は `base` 文字列 L29 の 1 箇所。既存 guard ケース（2099 売上, `answerOmits`）が未発見系の前例。

## Research Log

### 既存 eval 採点の拡張点
- **Context**: 「次の一歩」を既存採点にどう足すか。
- **Sources Consulted**: `scripts/kb-eval.ts`（`Expect` L25-42 / `evalCase` L124-170 / `citationFails` L58-78 / `DOC_CITATION`・`CODE_CITATION` L49-50）、`.kiro/specs/eval-citation-check/design.md`。
- **Findings**: `citationFails` が「`expect` のフラグが立つ時だけ検査し、偽/未指定なら `[]`」という非破壊パターンを確立済み。`evalCase` 末尾で `fails.push(...citationFails(...))` を呼ぶだけ。
- **Implications**: `nextStepFails` を同じ帯・同じ規約で追加し、`evalCase` 末尾に 1 行足すのが最小・最安全。

### 未発見時プロンプトの現状
- **Context**: どこに何を足せば [Safety]/[Output style] を弱めずに済むか。
- **Sources Consulted**: `src/chat/core.ts` `buildSystem`（L24-45）、`test/systemPrompt.test.ts`、`docs/USAGE.ja.md`。
- **Findings**: 未発見指示は `base` の 1 文（L29）。言語自動判別は別行（L26）で支配され、追記は文言連結のみで言語規則を壊さない。GitHub ブロック/operator extra 連結は別途で不変。
- **Implications**: L29 の直後に「次の一歩を 1 文添える」を英語で連結するのみ。`systemPrompt.test.ts` で追記の存在と既存文言の保持を回帰。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 純粋関数抽出（採用） | `nextStepFails(expect, answer)` を export し `evalCase` 末尾で呼ぶ | LLM/GitHub 非依存で `bun test` 回帰可・`citationFails` と同型 | 語彙 OR は意味的適切さまで測れない | tech.md「資格情報不要の純粋関数を test」に整合 |
| evalCase インライン | 採点分岐を直接追記 | 変更点が 1 箇所 | 単体テスト困難（ライブ依存）・既存分岐と混線 | 却下 |

## Design Decisions

### Decision: 「次の一歩」検出は語彙の複数語 OR（`NEXT_STEP_CUES`）
- **Context**: Req 2.3「過剰一致を避ける複数語 OR」。
- **Alternatives Considered**:
  1. 一般語（「確認」「情報」等）単独一致 — 過検出しやすく却下。
  2. LLM ジャッジ — Non-Goal（客観・無課金の単体テスト性を失う）。
- **Selected Approach**: USAGE.ja.md 方針に対応する複合的手掛かり語（例「キーワード」「対象名」「言い換え」「具体的に」「資料を追加」）の配列を持ち、いずれか一致で可とする。
- **Rationale**: 客観・決定的・無課金で回帰でき、既存 `citationFails` の検出規約定数（`DOC_CITATION` 等）と同じ運用に載る。
- **Trade-offs**: 意味的適切さは測れないが、それは Non-Goal。過検出/漏れは D ケース設計と単体テストで抑える。
- **Follow-up**: 語彙変更時は D ケースと `nextStepFails` テストを再確認（Revalidation Trigger）。

### Decision: 軸 D ケースは新規追加（既存 guard を改修しない）
- **Context**: Req 4.1「既存ケース無改修 PASS」と Req 3.4「guard と両立」。
- **Selected Approach**: 既存 guard（2099 売上）は触らず、`offersNextStep:true` + `answerOmits`（guard 同等）を持つ**新規**軸 D ケースを 1 件追加する。
- **Rationale**: 既存ケースの合否基準を変えず、guard の無根拠推測禁止と次の一歩要求を 1 ケースで両立実証できる。
- **Trade-offs**: ケースが 1 件増える（許容）。

## Risks & Mitigations
- 語彙 OR の過検出/漏れ — D ケースは手掛かりが明確に出る/出ない回答を誘発するよう設計し、決定的検証は `nextStepFails` 単体テストで担保。
- プロンプト追記が [Safety]/[Output style] を薄める — 追記は未発見文への 1 文連結に限定し、`systemPrompt.test.ts` で既存キーフレーズ保持を回帰。
- 既存未発見系ケース（guard, #29/#30 の一部）への波及 — 既存ケース無改修 PASS をライブ実行で確認（Req 4.1）。

## References
- `docs/USAGE.ja.md`「ナレッジに見つかりませんでした」節 — 次の一歩の文言方針の出所。
- `.kiro/specs/eval-citation-check/design.md` — `citationFails` の同型パターン（`offersNextStep`/`nextStepFails` の設計基準）。
- GitHub issue #31 / 親 #27 — 要求と受入基準の出所。
