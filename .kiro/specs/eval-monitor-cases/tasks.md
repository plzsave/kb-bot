# Implementation Plan: eval-monitor-cases

- [x] 1. monitor 分類のスキーマ・検証・集計を追加
  - `RawCase`/`Case` に `monitor` を追加し、`validateCases` で真偽値以外をケース名付きエラーにする（gate と同型）
  - `CaseResult` に `monitor` を、`Scorecard` に monitor tally（pass/total/failed）を追加する
  - `buildScorecard` で、非 SKIP かつ monitor のケースを monitor tally にのみ計上し、evaluated/pass/perAxis/gate には数えない（その後 continue）
  - monitor ケースが total/gate/perAxis に現れず monitor tally に入ること、monitor FAIL があっても gate/scored 全 PASS なら `overallPassed` が true になることを、純粋関数の単体で観察できる
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2_
  - _Boundary: scripts/kb-eval.ts（RawCase/Case/CaseResult/Scorecard/validateCases/buildScorecard）_

- [x] 2. スコアカード表示と実行ループの monitor 対応
  - `formatScorecard` に、monitor.total>0 のとき「モニタ（非ゲート）: pass/total」＋ FAIL 名を出す情報行を追加する（既存の軸/ゲート/総合行は保持）
  - 実行ループで `c.monitor ?? false` を読み、per-case ログに monitor 表示を付け、`CaseResult` に格納する
  - スコアカードに monitor 行が出て、monitor ケースが総合/ゲート行に混ざらないことを観察できる
  - _Depends: 1_
  - _Requirements: 2.3_
  - _Boundary: scripts/kb-eval.ts（formatScorecard / main ループ）_

- [x] 3. soft テキストケースへの monitor 付与
  - `eval/cases.json` の D 次の一歩（`offersNextStep`）と B′ 出典 2 件（`citesSource` 主目的）に `monitor:true` を付す
  - コードルーティング・事実（"24" 等）・ドリフト・安全ゲートのケースは monitor にしない（従来どおり exit を左右）
  - `eval/cases.sample.json` に `monitor:true` の記載例を追従追加する
  - 付与後、対象ケースが `monitor:true` で他は据え置きであることを観察できる
  - _Depends: 1_
  - _Requirements: 3.1, 3.2, 3.3_
  - _Boundary: eval/cases.json, eval/cases.sample.json_

- [ ] 4. テストと検証
  - `test/kb-eval.test.ts` に、`validateCases`（monitor 真偽値許容/非真偽値エラー）・`buildScorecard`（monitor が別 tally・total 非汚染）・`overallPassed`（monitor FAIL でも合格）・`formatScorecard`（monitor 行）・`cases.json` 構造ガード（D と出典が monitor:true）を追加する
  - 既存 scorecard/validateCases テストが無改修で緑であることを確認する
  - `bun run typecheck` が型エラーなく完了し、`bun test` が緑
  - （手動・課金あり）`bun run kb:eval` で、soft ケース FAIL 時も exit 0（gate/scored 全 PASS 時）・スコアカードに monitor 行が出ることを観測する
  - _Depends: 1, 2, 3_
  - _Requirements: 2.4, 4.1, 4.2, 4.3_
