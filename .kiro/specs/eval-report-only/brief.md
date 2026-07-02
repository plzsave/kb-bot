# Brief: eval-report-only

## Source
kb-bot 回答劣化対処の一連（#39/#40/#41/#42）で判明した根本問題への対処。ユーザー指摘「eval 自体が破綻している」（2026-07-02）を受けた設計判断。関連メモリ: kb-bot-degradation-fix-deferred。

## Problem
ライブ `kb:eval` は単発の LLM 実行を自由文でキーワード採点し、その scored 全 PASS を pass/fail ゲートにしていた。LLM 出力は非決定なので、run ごとに別のケース（B′ code → drift → D …）が揺れて赤になる。ケースを monitor/scored に分類し直しても「次の run で別ケースが落ちる」whack-a-mole が続く。これが「eval が破綻している／何を確認しているか分からない」の正体。

## Desired Outcome
- ライブ `kb:eval` を **レポート専用**にする。exit は **安全ゲート（`gate:true`＝インジェクション/秘密漏洩の拒否）だけ**で判定し、scored/monitor（ルーティング・事実・出典・次の一歩・ドリフト）は情報表示で exit を左右しない。
- 回帰を止める**決定的ゲートは `bun test`**（非 LLM の純粋関数検証）であることを明確化する。
- これにより単発採点の非決定性で run が赤になる問題が構造的に止まる。

## Approach
1. `overallPassed(sc)` を `sc.gate.failed.length === 0`（安全ゲートのみ）に変更。scored の pass/fail は exit に含めない。
2. スコアカードの総合行を「参考」と明示し、「exit は安全ゲートのみ・回帰ゲートは bun test」の注記を追加。
3. 既存の overallPassed テストを新セマンティクスに更新（scored FAIL でも安全ゲート無失敗なら合格／安全ゲート失敗なら不合格）。

## Scope
- **In**: `overallPassed` のセマンティクス変更（安全ゲートのみ）／スコアカード注記／該当テスト更新。
- **Out**: 採点判定（`evalCase` 系）・monitor 分類（#42・表示に残す）・昇格・キャッシュ・`buildSystem`。ケースデータの追加/削除。

## Existing Spec Touchpoints
- **Extends**: `eval-scorecard`（#28）の `overallPassed` セマンティクスを「安全ゲートのみ」に再定義。
- **Adjacent**: `eval-monitor-cases`（#42・monitor 表示は維持）、`eval-drift-tolerance`（#30・drift ケース定義は不変。scored のままだが exit を左右しなくなる）。

## Constraints
- `bun run typecheck` クリーン。安全ゲートの hard-fail は維持。monitor 表示は維持。
- 決定的回帰ゲートは `bun test`（本変更で eval の位置づけを「確率的モニタ」に確定）。
