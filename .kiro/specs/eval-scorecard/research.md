# Gap Analysis: eval-scorecard

## Summary
- **対象**: 既存の評価ハーネス `scripts/kb-eval.ts`（180 行・単一ファイル）への純粋な拡張。本番 `src/` は不変更。
- **適合度**: 要件は既存構造に自然に収まる。採点中核 `evalCase()`（純粋関数、L65-108）は不変のまま利用でき、追加は「軸/ゲートのタグ」「軸別・ゲート集計」「スコアカード出力」「終了コード判定」のみ。
- **主要ギャップ 1（終了コード）**: 現状 `process.exit(passed === cases.length ? 0 : 1)`（L180）は **SKIP を total に含める**ため、GitHub 未設定だと runnable 全 PASS でも exit 1 になりうる。要件 5（SKIP をゲート/集計から除外）の充足は、この total 基準を「評価済み（非 SKIP）」へ直すことを意味し、既存の潜在不整合の是正にもなる。
- **主要ギャップ 2（テスト容易性）**: 既存テストは全て `src/` から import しており、`scripts/` から import する前例が無い。kb-eval.ts はトップレベルで実行（実 LLM/GitHub 呼び出し）するため、純粋関数を `bun test` するには実行をエントリ限定にするガードが必要。
- **推奨**: Option A（既存ファイル拡張）＋集計/検証/合否/整形を同ファイル内の純粋関数として切り出し。Effort S / Risk Low。

## 1. Current State Investigation

### 関連資産
- `scripts/kb-eval.ts`（L1-180）: 唯一の対象。
  - 型 `Expect`（L22-37）/ `Case`（L39-43）/ `Call`（L45-49）。
  - `evalCase(expect, calls, answer): string[]`（L65-108）= 純粋採点。空配列なら PASS。**契約維持対象（Req 4.2）**。
  - `recordTool`（L52-61）= ツール呼び出しトレース。
  - main 相当はトップレベル（L110-180）: 読込→`createLlm`/`openDb`/`loadGitHub`→ループ（`needsGh` SKIP, L133-142）→逐次 `PASS/FAIL/SKIP/ERROR` 出力→`=== passed/total PASS ===`（L179）→`process.exit`（L180）。
- `eval/cases.json`（7 ケース: docs×4 / code×2 / guard×1）, `eval/cases.sample.json`（4 例）。

### 規約
- 相対 import＋`.ts` 拡張子、`import type`、`noUncheckedIndexedAccess`（steering tech.md）。
- テスト配置: `test/*.test.ts`、`bun test`。**全て `src/` から import**（`from "../scripts/"` は 0 件）。
- 純粋ロジックは純粋関数化してテスト（例 `src/kb/prune.ts` の `computeFlags`）。

### 統合面
- kb-eval.ts は `src/llm/factory.ts`・`src/agent/agent.ts`・`src/kb/db.ts`・`src/chat/core.ts` 等を import のみ（変更しない）。

## 2. Requirements Feasibility Analysis

| 要件 | 技術的必要事項 | 現状 | 区分 |
|---|---|---|---|
| 1.1-1.3 軸タグ・軸別集計 | `Case` に任意 `axis`、軸別カウント | 無し | Missing（追加） |
| 1.4 不正軸の検出 | 読込直後の検証＋早期終了 | 読込は `JSON.parse`＋catch のみ | Missing（追加） |
| 2.1-2.4 ゲート | `Case` に任意 `gate`、ゲート FAIL を全体不合格へ | 無し | Missing（追加） |
| 3.1-3.3 スコアカード | 軸別＋ゲート＋総合の末尾出力 | 総合のみ（L179） | Missing（追加・既存出力は保持） |
| 4.1-4.2 後方互換 | `evalCase`/`expect`/「指定項目だけ検査」不変、既存7ケース PASS | 既に成立 | Constraint |
| 4.3 外部依存なし | 標準ライブラリ＋Bun のみ | 成立可 | Constraint |
| 4.4 typecheck | strict 維持 | 成立 | Constraint |
| 5.1 SKIP 維持 | `needsGh` ロジック維持（L133-142） | 既存 | Constraint |
| 5.2-5.3 SKIP をゲート/集計から除外 | total を「評価済み」基準へ | 現状 total=cases.length（SKIP 込み, L180） | Constraint＋是正 |

複雑度シグナル: 純粋な集計/分類ロジック（外部統合なし）。アルゴリズム的に単純。

## 3. Implementation Approach Options

### Option A: 既存ファイル拡張（推奨）
`scripts/kb-eval.ts` 内に型追加（`axis?`/`gate?`）と純粋関数（検証・集計・合否・整形）を加え、main を関数化してエントリ実行をガード（`import.meta.main`）。
- ✅ 変更最小・既存パターン踏襲・スコープ（scripts のみ）に厳密一致。
- ✅ 集計/検証/合否を純粋関数化すれば `test/` から import して `bun test` 可能（steering のテスト容易性方針に合致）。
- ❌ 単一ファイルが多少肥大（180 行→推定 ~300 行）。許容範囲。

### Option B: 別ファイル新設（集計ロジックを切り出し）
集計/合否を `scripts/` 配下の別モジュールに分離。
- ✅ kb-eval.ts を薄く保てる。
- ❌ ファイル増・スコープ（issue は kb-eval.ts 指定）からやや逸脱。小規模機能には過剰分割。

### Option C: ハイブリッド
型・ループ結線は kb-eval.ts、純粋集計は別ファイル。
- ✅ テスト容易性は高い。
- ❌ 本機能規模では分割コストが利得を上回る。

## 4. テスト容易性ギャップ（Research Carry-forward）
- kb-eval.ts は import すると top-level の実行（`createLlm()` 等）まで走る恐れ。→ main を関数化し `if (import.meta.main) await main()` に実行を限定するのが最小解。`createLlm()` 等の副作用呼び出しは main 内に閉じる（top-level import 自体は定義のみで安全）。
- `test/` から `../scripts/kb-eval.ts` を import する前例は無いが、tsconfig は `scripts` を include 済みで型・解決上の障害は無い。新パターンとして許容可（test/ 追加は src/ 非変更で scope 外でない）。

## 5. Implementation Complexity & Risk
- **Effort: S（1–3 日）** — 既存パターン拡張、外部依存なし、統合は単一ファイル内。
- **Risk: Low** — 既知技術・スコープ明確・統合最小。唯一の注意点は (a) 既存出力フォーマット保持、(b) `import.meta.main` ガード漏れ防止、(c) total を評価済み基準にする際の後方互換確認。

## 設計フェーズへの申し送り
- **推奨アプローチ**: Option A。純粋関数（検証/集計/合否/整形）＋ `import.meta.main` ガード＋ main 関数化。
- **キー決定**: 終了コードは「評価済みに FAIL/ERROR 無し かつ ゲート FAIL 無し」で 0（Req 2.2/2.4/5.2 を単一条件で充足、SKIP→exit1 既存問題も是正）。
- **Research items**: `import.meta.main` を Bun で確認（テスト時 main 抑止の前提）。既存7ケースの GitHub 未設定実行で 5 PASS/2 SKIP・exit 0 となることを回帰確認。

## Design Synthesis（design フェーズ）

### 1. Generalization
- Req 1（軸別集計）・Req 2（ゲート）・Req 3（スコアカード）は「ケース結果列 `CaseResult[]` から派生状態 `Scorecard` を導く」という単一の集計問題の変種。これを `buildScorecard` 1 関数に一般化し、軸別・ゲート・総合を同一パスで算出する。インターフェースのみ一般化し、実装は現要件の範囲に留める。

### 2. Build vs. Adopt
- 集計・整形・合否は標準ライブラリで十分な単純ロジック。外部依存導入の必要なし（Req 4.3 と整合）。`evalCase` は既存資産を adopt（不変再利用）。

### 3. Simplification
- ゲート判定用の独立しきい値機構や設定ファイルは現要件に無いため作らない（投機的抽象の排除）。
- 集計を「純粋関数 4 つ＋結果モデル型」に集約し、別ファイル分離（Option B/C）は本規模では過剰として不採用。

## Design Decisions

### Decision: 副作用とコアの分離＋`import.meta.main` ガード
- **Context**: 純粋ロジックを `bun test` したいが、現 kb-eval.ts は import で実 LLM/GitHub が走る。
- **Alternatives**: (A) 同ファイル拡張＋ガード / (B) 別モジュール分離 / (C) ハイブリッド。
- **Selected**: A。検証/集計/合否/整形を純粋関数化し、エントリを `if (import.meta.main) await main()` に限定。
- **Rationale**: スコープ（scripts のみ）に厳密一致・既存パターン踏襲・テスト容易性確保。Bun で `import.meta.main` が直接実行時 `true`・import 時 `false` を確認済み。
- **Trade-offs**: 単一ファイルが ~300 行に増えるが許容範囲。
- **Follow-up**: ガード漏れ防止（実装レビュー必須項目）。

### Decision: 検証は生パース形状 `RawCase` に対して行う（design レビュー反映）
- **Context**: `Case.axis` を狭い `Axis` union にすると、`JSON.parse(...) as Case[]` 後の `validateCases` では不正軸の検出が型論理的に到達不能（dead check）に見え、Req 1.4 が骨抜きになる懸念。
- **Selected**: 読込直後は `RawCase`（`axis?: string` / `gate?: unknown`）で受け、`validateCases(raw): string[]` で軸/ゲートを検証 → 成功後に `Case[]` へ narrow。
- **Rationale**: 型と実行時のギャップを塞ぎ、strict/`noUncheckedIndexedAccess` 下でも不自然なキャストを避ける。
- **Follow-up**: narrow 箇所のテスト（不正軸でエラー収集・有効/無タグで成功）。

### Decision: `axis` と `gate` の直交性を明文化（design レビュー反映）
- **Context**: `safety` は軸値かつゲート概念。両フラグを持つケースの計上方法が未定義だと `buildScorecard` の解釈がぶれる。
- **Selected**: `axis` と `gate` は直交。両方を持つケースは軸別 tally とゲート母数の双方に計上。
- **Follow-up**: 軸＋ゲート併用ケースの `buildScorecard` テスト。

### Decision: 終了コード基準を「評価済み（非 SKIP）」へ
- **Context**: 現 `passed === cases.length` は SKIP を分母に含み、GitHub 未設定だと runnable 全 PASS でも非ゼロ終了になりうる。
- **Selected**: 全体合否 = 評価済み全 PASS かつ ゲート FAIL なし。SKIP は分母から除外。
- **Rationale**: Req 2.2/2.4/5.2 を単一条件で満たし、既存不整合も是正。ユーザー承認済み（design フェーズ承認に含む）。
- **Trade-offs**: 終了コードの出方が従来と変わる（SKIP 混在時に 0 を返しうる）が、これは正方向の是正。
- **Follow-up**: 既存 7 ケースの GitHub 未設定実行で 5 PASS/2 SKIP・exit 0 を回帰確認。
