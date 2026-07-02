# Implementation Plan: remove-preescalation

- [x] 1. runWithEscalation から A経路（startHard）を撤去
  - `src/agent/escalation.ts` の `RunWithEscalationOpts.startHard` を削除し、常に基本モデルで開始→`canEscalate && truncated` のときだけ上位で再実行（B経路のみ）にする。`onDelta`/`onEscalate`/`runAgentWithFallback` は不変
  - コメントを「B経路のみ」に更新。`escalated` は「B経路で再実行したか」を表す
  - 基本モデルで完答なら非昇格・truncated 時のみ昇格、が関数単体で観察できる
  - _Requirements: 1.1, 1.2, 1.3_
  - _Boundary: src/agent/escalation.ts_

- [x] 2. 呼び出し側（core / eval）から startHard と判定機構を撤去
  - `src/chat/core.ts`: `isSubstantiveTopHit` import と `startHard`/`canEscalate` を削除し、`runWithEscalation` 呼び出しから `startHard` を外す（`onDelta`/`onEscalate` 維持）
  - `scripts/kb-eval.ts`: `isSubstantiveTopHit` import と `startHard`/`canEscalate` を削除し、呼び出しから `startHard` を外す。トレースのティア表示は維持
  - どちらも基本モデル開始・truncated 時のみ昇格になることを観察できる
  - _Depends: 1_
  - _Requirements: 1.1, 1.4, 2.2_
  - _Boundary: src/chat/core.ts, scripts/kb-eval.ts_

- [x] 3. db.ts の判定機構を撤去
  - `src/kb/db.ts` から `REL_MIN_COVERAGE`/`queryCoverage`/`isSubstantiveTopHit` を削除する（`buildMatchQuery` が使う `queryTerms` 等の import は維持）
  - 未使用の判定機構が残らないことを観察できる
  - _Depends: 2_
  - _Requirements: 1.4_
  - _Boundary: src/kb/db.ts_

- [x] 4. テスト整理と検証
  - `test/db.test.ts` の `queryCoverage`/`isSubstantiveTopHit` の import とテスト群を削除
  - `test/escalation.test.ts` の `startHard=true`（A経路）テストを削除し、他の `runWithEscalation` テストから `startHard` 引数を除去（B経路・未設定非昇格・404・onEscalate は維持）
  - `bun run typecheck` クリーン、`bun test` 緑
  - _Depends: 1, 2, 3_
  - _Requirements: 2.1, 2.3, 2.4_
  - _Boundary: test/db.test.ts, test/escalation.test.ts_
