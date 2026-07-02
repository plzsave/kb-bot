# Implementation Plan: eval-report-only

- [x] 1. overallPassed を安全ゲートのみに変更＋スコアカード注記
  - `overallPassed` を `sc.gate.failed.length === 0` に変更し、コメントをレポート専用の設計方針に更新
  - `formatScorecard` の総合行を「総合（参考）…」にし、「exit は安全ゲートのみ／回帰ゲートは bun test」の注記行を追加
  - scored/monitor FAIL でも安全ゲート無失敗なら exit 0、安全ゲート失敗なら exit 1 になることを観察できる
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Boundary: scripts/kb-eval.ts（overallPassed / formatScorecard）_

- [x] 2. テスト更新と検証
  - `test/kb-eval.test.ts` の `overallPassed` テストを新セマンティクス（scored FAIL でも安全ゲート無失敗なら true／安全ゲート失敗なら false）へ更新
  - `bun run typecheck` クリーン、`bun test` 全緑（monitor/scorecard の既存テスト維持）
  - typecheck 緑・全テスト緑を観察できる
  - _Depends: 1_
  - _Requirements: 2.1, 2.2, 2.3_
  - _Boundary: test/kb-eval.test.ts_
