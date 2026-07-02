# Research & Design Decisions: eval-monitor-cases

## Summary
- **Feature**: `eval-monitor-cases`
- **Discovery Scope**: Extension（`eval-scorecard` の合否/集計に monitor 分類を追加）
- **Key Findings**:
  - `overallPassed = total.pass===total.evaluated && gate.failed 空`。monitor ケースを `total`/`gate`/`perAxis` から除外すれば `overallPassed` 無改修で非ゲート化できる。
  - `gate` と同じ「per-case boolean → buildScorecard で別勘定」パターンで monitor を実装できる（`test/kb-eval.test.ts` が純粋関数を固定）。
  - 実測: D（次の一歩）は単独実行で PASS するのに eval 実行で FAIL＝単発ライブ採点の非決定性。code/事実系は #39/#40/#41 で安定。

## Research Log

### monitor を非ゲート化する最小変更点
- **Context**: soft ケースを exit から外しつつ表示は残す。
- **Sources Consulted**: `scripts/kb-eval.ts`（`buildScorecard` L276-326 / `overallPassed` L336-338 / `formatScorecard` / `validateCases` / `Scorecard`）、`test/kb-eval.test.ts`。
- **Findings**: buildScorecard で monitor を別 tally にし evaluated/pass/gate/perAxis から除外 → overallPassed は無改修で monitor を無視。
- **Implications**: `Scorecard.monitor` 追加＋buildScorecard に monitor 分岐＋formatScorecard に monitor 行。overallPassed 不変＝既存テスト緑。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks | Notes |
|--------|-------------|-----------|-------|-------|
| per-case monitor（採用） | ケース単位で非ゲート | gate と同型・単純・後方互換 | 混在ケースは丸ごと非ゲート | citation 主目的ケースは丸ごとで妥当 |
| per-check monitor | expect 単位で非ゲート | 粒度細かい | 実装複雑・採点ロジックに侵入 | Non-Goal・却下 |

## Design Decisions

### Decision: monitor 対象は「soft 自由文が主目的」のケース
- **Context**: 混在ケース（routing+citation）の扱い。
- **Selected Approach**: `offersNextStep` 主目的（D）と `citesSource` 主目的（B′ 出典 2 件）を monitor。ドリフト（"24" 主体の correctness）・plain routing・guard は据え置き。
- **Rationale**: routing 信号は plain code/docs ケースが重複してゲートするので、citation 主目的ケースを非ゲートにしても routing ゲートは失われない。
- **Trade-offs**: ドリフトの citesSource は soft だが correctness 主目的として残す（昇格でほぼ安定）。

## Risks & Mitigations
- monitor+gate 両指定の矛盾 → monitor 優先（非ゲート化）。安全ゲートに monitor を付けない運用＋付与ケースを限定。
- monitor 追加で既存テスト回帰 → monitor 未指定は従来どおり。overallPassed 不変。構造ガードで付与ケースを固定。

## References
- `scripts/kb-eval.ts`（拡張対象）/ `test/kb-eval.test.ts`（ガード）。
- `.kiro/specs/eval-scorecard`（#28・拡張元）/ `eval-next-step`（#31）/ `eval-citation-check`（#29）。
- メモリ: kb-bot-degradation-fix-deferred（eval 役割分離の判断）。
