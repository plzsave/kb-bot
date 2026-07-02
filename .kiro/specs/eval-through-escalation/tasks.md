# Implementation Plan: eval-through-escalation

- [x] 1. エスカレーション orchestration を共有モジュールに抽出
  - `src/agent/escalation.ts` を新設し、`runAgentWithFallback`（404/退役フォールバック）を `core.ts` から移設する（ログ接頭辞は `[escalation]` に統一）
  - A経路（`startHard` 指定時に上位ティアで開始）・B経路（`canEscalate` かつ `truncated` で上位ティア再実行）を行う `runWithEscalation(opts)` を実装する。`canEscalate` は `modelHard` 有無から内部計算。逐次コールバック `onDelta` と B経路直前フック `onEscalate` を任意で受ける
  - 戻り値に `result`・`modelUsed`・`escalated`・`fellBack` を含める。入力 opts を変更しない
  - `startHard=true` で最初から hard 実行・非 startHard かつ truncated で B 昇格・404 で fallback、という分岐を関数単体で観察できる
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.5_
  - _Boundary: src/agent/escalation.ts_

- [x] 2. answer() を共有関数呼び出しへ置換（挙動不変）
  - `core.ts` の `runAgentWithFallback` を削除し `escalation.ts` から import する
  - `answer()` の `runOnce`＋A/B ブロックを `runWithEscalation({...})` 1 呼び出しに置換する。`onDelta` は従来の逐次バッファ追記、`onEscalate` は逐次バッファのリセットと「考え中（上位ティア）」表示を行う
  - 返る `escalated`/`modelUsed`/`fellBack` を従来の使用量ログに用いる
  - ストリーム表示・thinkingHard・使用量ログが従来どおりで、既存挙動が保たれることを観察できる
  - _Depends: 1_
  - _Requirements: 2.2, 2.3, 4.3_
  - _Boundary: src/chat/core.ts（answer）_

- [x] 3. eval を昇格経由に配線＋トレース表示
  - `scripts/kb-eval.ts` で `createLlm()` から `modelHard` も取得し、各ケースで本番と同じ `startHard`（`canEscalate` かつ GitHub 有効かつ最上位ヒットが実質関連でない）を計算する
  - `runAgent` 直呼びを、`recordTool` でラップしたツール群を注入した `runWithEscalation` 呼び出しへ置換する（`onDelta`/`onEscalate` は渡さない）
  - トレース出力に使用ティア（`modelUsed`）と昇格有無（`escalated`）を含める。ツールトレース採点（`recordTool`＋`evalCase`）は維持する
  - `KB_MODEL_HARD` 設定時に実質空振りケースが上位ティアで開始し、トレースに昇格が現れることを観察できる
  - _Depends: 1_
  - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - _Boundary: scripts/kb-eval.ts_

- [ ] 4. テストと検証
  - `test/escalation.test.ts` の既存 4 ケースが無改修で緑であることを確認する（`answer()` 挙動不変, Req 2.1）。必要なら `runWithEscalation` の直接単体テストを追加する（startHard=true で hard 開始・truncated で B 昇格・404 fallback）
  - `bun run typecheck` が型エラーなく完了し、`bun test` の既存テストが無改修で緑
  - （手動・課金あり）`KB_MODEL_HARD` 設定で `bun run kb:eval` を実行し、実質空振りの B′ code/drift ケースが上位ティアで開始・トレースに昇格表示されることを観測する
  - typecheck 緑・既存非回帰・eval の昇格経由化を観察できる
  - _Depends: 1, 2, 3_
  - _Requirements: 2.1, 4.1, 4.2_
