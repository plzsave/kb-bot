# Design Document: eval-through-escalation

## Overview

**Purpose**: エスカレーション orchestration（A経路 startHard / B経路 truncated 救済 / 404 フォールバック）を `answer()` から共有関数 `runWithEscalation` に抽出し、`answer()` と `kb-eval.ts` の双方が同一ロジックを通るようにする。これにより eval が本番と同じ昇格経路で走り、#40 の効果を測れる（production 代表）。

**Users**: 評価基盤の保守者が kb:eval で production 相当の挙動を確認できる。回答コアの保守者は昇格ロジックを一箇所で保守できる。

**Impact**: `src/agent/escalation.ts`（新規）に orchestrator を置き、`src/chat/core.ts` の `answer()` はそれを呼ぶだけに変更（挙動不変）。`scripts/kb-eval.ts` は `modelHard` を取得し、本番と同じ `startHard` を計算して共有関数を `recordTool` ツールで呼ぶ。採点ロジック・昇格ポリシー・キャッシュ・プロンプトは不変。

### Goals
- A/B 経路＋404 フォールバックを行う単一の共有 orchestrator を提供（プラットフォーム非依存・ツール注入）。
- `answer()` の挙動を不変に保つ（`escalation.test.ts` 緑）。
- eval を昇格経由にし、使用ティア/昇格有無をトレース表示。ツールトレース採点は維持。

### Non-Goals
- 昇格の発火条件（`isSubstantiveTopHit`/startHard 定義, #40）・採点ロジック（`evalCase` 系）・キャッシュ・`buildSystem` の変更。
- 新規 eval ケース、昇格ポリシーのチューニング。

## Boundary Commitments

### This Spec Owns
- `src/agent/escalation.ts`: `runWithEscalation(...)`（+ `runAgentWithFallback` を core.ts から移設）。
- `src/chat/core.ts` `answer()` の該当ブロック（runOnce + A/B + fallback）を共有関数呼び出しへ置換。
- `scripts/kb-eval.ts` の昇格経由化とトレース表示。
- 上記の決定的テスト（`escalation.test.ts` の共有関数化への追従／新規単体テスト）。

### Out of Boundary
- `isSubstantiveTopHit`/`startHard` の判定基準（#40 が所有・再利用のみ）。
- `evalCase`/`citationFails`/`nextStepFails` の採点（eval-* 各スペック所有）。
- `buildSystem`・回答キャッシュ・`runAgent`（ツールループ本体）。

### Allowed Dependencies
- `src/agent/agent.ts`（`runAgent`, `RunAgentOpts`, `RunAgentResult`, `AgentTool`）、`src/llm/provider.ts`、`src/llm/errors.ts`（`isModelNotFoundError`）。
- `kb-eval.ts` は `createLlm`（modelHard）・`isSubstantiveTopHit`・`runWithEscalation` を利用。

### Revalidation Triggers
- `runWithEscalation` のシグネチャ変更 → `answer()`・eval・`escalation.test.ts` の再確認。
- A/B 経路・フォールバックのセマンティクス変更（本仕様では behavior-preserving）→ `escalation.test.ts` 再確認。

## Architecture

### Existing Architecture Analysis

`answer()`（`core.ts`）内のエスカレーションは 3 部品:
- `runAgentWithFallback(opts)`（private, L102-117）: `runAgent` 実行、404/退役なら `provider.defaultModel` で 1 回だけ再試行。
- `runOnce(m)`（L183-198）: 逐次バッファ（`pending`/`lastEdit`）をリセットし `runAgentWithFallback` を `onDelta` 付きで呼ぶ。
- A/B ブロック（L204-218）: `startHard`（`isSubstantiveTopHit` ベース）で開始ティア決定、`!startHard && canEscalate && truncated` で `ui.thinkingHard` 表示＋modelHard 再実行。

`kb-eval.ts` は `runAgent({provider, model, ...})` を直接呼び、この orchestration を通らない（＝昇格を測れない）。

本設計は orchestration を `runWithEscalation` に抽出し、答案の逐次表示・「考え中」表示は**コールバック**（`onDelta`/`onEscalate`）で呼び出し側に残す。ツールは呼び出し側が注入（`answer()` は本番ツール、eval は `recordTool` ラップ）。

### Architecture Pattern & Boundary Map

**Selected pattern**: orchestration の共有関数抽出（コールバックで副作用を呼び出し側に残す）。

```mermaid
graph TD
    subgraph shared[src/agent/escalation.ts]
      rwe[runWithEscalation: A/B + fallback]
      rf[runAgentWithFallback]
      rwe --> rf --> runAgent
    end
    answer[core.ts answer()] -->|本番ツール + onDelta/onEscalate| rwe
    eval[kb-eval.ts] -->|recordTool ツール + startHard| rwe
    startHard["startHard = canEscalate && github && !isSubstantiveTopHit(q,hits)（両者同一）"] --> answer
    startHard --> eval
```

**Key decisions**:
- 副作用（逐次表示・thinkingHard・バッファリセット）は `onDelta`/`onEscalate` コールバックで呼び出し側に残し、orchestrator は純粋に「どのティアで何回 runAgent するか」に集中。→ `answer()` は挙動不変、eval はコールバック省略。
- `startHard` は呼び出し側が計算して渡す（判定基準は #40 の `isSubstantiveTopHit`。eval も本番と同じ式を使う）。orchestrator は `startHard` と `canEscalate`（`modelHard` 有無から内部計算）だけを見る。
- `runAgentWithFallback` を escalation.ts に移設し private→共有。ログ接頭辞は `[escalation]` に統一。

### Technology Stack

| Layer | Choice | Role | Notes |
|-------|--------|------|-------|
| Orchestration | TypeScript on Bun (`src/agent/escalation.ts`) | `runWithEscalation`/`runAgentWithFallback` | 新規依存なし |
| 本番 | `src/chat/core.ts` | `answer()` が共有関数を呼ぶ（挙動不変） | コールバックで副作用保持 |
| Eval | `scripts/kb-eval.ts` | 昇格経由で実行＋トレース表示 | recordTool 維持 |
| Test | `bun test`（`escalation.test.ts` ほか） | 挙動不変・共有関数の単体 | フェイク provider |

## File Structure Plan

### New Files
- `src/agent/escalation.ts` —
  - `runAgentWithFallback(opts: RunAgentOpts)`（core.ts から移設）。
  - `export interface RunWithEscalationOpts`（provider, model, modelHard?, system, messages, tools, maxTurns?, startHard, onDelta?, onEscalate?）。
  - `export interface RunWithEscalationResult`（result, modelUsed, fellBack, escalated）。
  - `export async function runWithEscalation(opts): Promise<RunWithEscalationResult>` — `canEscalate = !!modelHard && modelHard!==model`。開始ティア（startHard?modelHard:model）で実行 → `!startHard && canEscalate && result.truncated` なら `onEscalate?.()` 後 modelHard 再実行。

### Modified Files
- `src/chat/core.ts` —
  - `runAgentWithFallback` を削除し escalation.ts から import。
  - `answer()` の `runOnce`＋A/B ブロックを `runWithEscalation({...})` 1 呼び出しへ置換。`onDelta` は従来の pending 追記、`onEscalate` は `pending=""; lastEdit=0; await handle.update(ui.thinkingHard)`。返る `escalated/modelUsed/fellBack` を従来ログに使用。挙動不変。
- `scripts/kb-eval.ts` —
  - `createLlm()` から `modelHard` も取得。
  - 各ケースで `startHard = !!modelHard && modelHard!==model && !!github && !isSubstantiveTopHit(c.question, hits)` を計算し、`runWithEscalation({provider, model, modelHard, system, messages, tools: recordTool 群, maxTurns, startHard})` を呼ぶ（`onDelta`/`onEscalate` なし）。
  - トレース行に使用ティア（modelUsed）と昇格有無（escalated）を付す。
- `test/escalation.test.ts` —
  - `answer()` 経由の既存テストは無改修で維持（挙動不変の確認）。必要なら `runWithEscalation` の直接単体テストを追加（startHard=true で hard 開始、truncated で B 昇格、404 フォールバック）。

## Requirements Traceability

| Requirement | Summary | Components | Interfaces | Flows |
|-------------|---------|------------|------------|-------|
| 1.1 | A/B+フォールバックの共有関数 | `runWithEscalation` | orchestrator | 昇格 |
| 1.2 | 注入 system/messages/tools で動作・非依存 | `runWithEscalation` | opts | — |
| 1.3 | onDelta/onEscalate コールバック | `runWithEscalation` | opts コールバック | 副作用外出し |
| 1.4 | 使用モデル/昇格/フォールバックを返す | `runWithEscalation` | `RunWithEscalationResult` | — |
| 2.1 | escalation.test 無改修で緑 | `answer()`(置換) | 挙動不変 | フェイク provider |
| 2.2 | ストリーム/thinkingHard 保持 | `answer()` | onDelta/onEscalate | 逐次表示 |
| 2.3 | 使用量ログ保持 | `answer()` | modelUsed/escalated/fellBack | ログ |
| 3.1 | eval が本番基準で startHard・共有関数経由 | `kb-eval.ts` | startHard 計算＋`runWithEscalation` | eval 実行 |
| 3.2 | KB_MODEL_HARD 設定時に難質問で hard 開始 | `kb-eval.ts` | startHard=true | eval |
| 3.3 | ツールトレース採点を維持 | `kb-eval.ts` | recordTool + evalCase | 採点 |
| 3.4 | 使用ティア/昇格をトレース表示 | `kb-eval.ts` | modelUsed/escalated 出力 | ログ |
| 3.5 | 未設定なら基本のみ | `runWithEscalation` | canEscalate=false | — |
| 4.1 | typecheck クリーン | 全体 | — | `bun run typecheck` |
| 4.2 | 既存テスト維持 | 全体 | — | `bun test` |
| 4.3 | ポリシー/採点/cache/buildSystem 不変 | （非変更） | — | — |

## Components and Interfaces

| Component | Domain/Layer | Intent | Req Coverage | Key Dependencies | Contracts |
|-----------|--------------|--------|--------------|------------------|-----------|
| `runWithEscalation` | agent orchestration | A/B+フォールバックの共有実行 | 1.1–1.4, 3.5 | `runAgent`（P0）, `runAgentWithFallback`（P0） | Service |
| `runAgentWithFallback`（移設） | agent orchestration | 404/退役フォールバック | 1.1 | `runAgent`, `isModelNotFoundError`（P0） | Service |
| `answer()`（置換） | 回答コア | 共有関数を呼び本番挙動維持 | 2.1–2.3 | `runWithEscalation`（P0） | — |
| `kb-eval.ts`（配線） | eval | 昇格経由で採点 | 3.1–3.5 | `runWithEscalation`, `isSubstantiveTopHit`（P0） | Batch |

### runWithEscalation

**Service Interface**
```typescript
export interface RunWithEscalationOpts {
  provider: LlmProvider;
  model: string;
  modelHard?: string;
  system: string;
  messages: LlmMessage[];
  tools: AgentTool[];
  maxTurns?: number;
  startHard: boolean;
  onDelta?: (text: string) => void;
  onEscalate?: () => void | Promise<void>; // B経路再実行の直前
}
export interface RunWithEscalationResult {
  result: RunAgentResult;
  modelUsed: string;
  fellBack: boolean;
  escalated: boolean;
}
export async function runWithEscalation(opts: RunWithEscalationOpts): Promise<RunWithEscalationResult>;
```
- **Preconditions**: `startHard` は呼び出し側が算定（true の場合 `modelHard` は非 undefined であること）。
- **Postconditions**: startHard 時は最初から modelHard で 1 回。非 startHard かつ canEscalate かつ truncated のとき `onEscalate` 後 modelHard で再実行。`escalated`/`modelUsed`/`fellBack` を返す。
- **Invariants**: 入力 opts を変更しない。ツールの実行順・tool_use_id 整合は `runAgent` に委譲。

**Implementation Notes**
- `answer()` は `onEscalate` で `pending=""; lastEdit=0; await handle.update(ui.thinkingHard)`、`onDelta` で `pending+=t; void flush(false)`。第一実行の初期化は既存の初期値で足りる。
- Risks: `answer()` の逐次バッファ初期化位置がズレると表示回帰。→ `escalation.test.ts` の final テキスト検査＋手動 smoke で担保。

## Error Handling
`runWithEscalation` は `runAgentWithFallback` の 404 処理を内包。それ以外の例外は呼び出し側（`answer()` の try/catch、eval の per-case try/catch）へ伝播（現状維持）。

## Testing Strategy

### Unit / 挙動不変（`bun test`・フェイク provider）
1. `escalation.test.ts` 既存 4 ケースが**無改修で緑**（B昇格・未設定非昇格・404 フォールバック・昇格×フォールバック両立）＝ `answer()` 挙動不変（Req 2.1）。
2.（任意）`runWithEscalation` 直接: `startHard=true` で最初から hard、`truncated` で B 昇格、404 で fallback を返す（Req 1.1/1.4）。
3. `bun test` 全体が緑（Req 4.2）、`bun run typecheck` クリーン（Req 4.1）。

### ライブ実行での実証（`bun run kb:eval`, 手動・課金あり）
4. `KB_MODEL_HARD` 設定時、実質空振りの B′ code/drift 系ケースが上位ティアで開始（トレースに escalated/modelUsed 表示）し、基本モデル単独時より安定して解けることを観測（Req 3.2/3.4）。
