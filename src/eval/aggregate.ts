// ---- 集約ゲート（統計的な品質回帰検知）の純関数群 ----
// 個別ケースは揺れてよい。scored 全体の合格率を、記録した基準値（baseline）−許容幅（band）と
// 比較して「全体として劣化したか」だけを合否にする。N が大きいほど集約は安定する
// （N=60 で ±4pp 程度がノイズ床）。band はライブ 2 run の実測分散から較正する。
// 検出できるのは band を超える劣化のみ。微小劣化・単一ケースの合否は保証しない（原理的天井）。
import { createHash } from "node:crypto";
import type { CaseResult, Scorecard } from "./scorecard.ts";
import { overallPassed } from "./scorecard.ts";

/** 記録された基準値。ケース集合が変わると比較不能になるため fingerprint を持つ。 */
export interface Baseline {
  /** 基準の合格率（scored 評価済みベース、0..1）。 */
  passRate: number;
  /** 基準 run の評価済み scored ケース数。 */
  evaluated: number;
  /** 評価済み scored ケース名集合の指紋。集合が変わったら stale（要再基準化）。 */
  caseSetHash: string;
  /** 記録時刻（ISO 8601）。情報表示用。 */
  recordedAt: string;
}

/** baseline.json の緩い検証。形が不正なら null（無い扱い＝ゲートは無効・情報表示のみ）。純関数。 */
export function parseBaseline(raw: unknown): Baseline | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.passRate !== "number" || !(b.passRate >= 0 && b.passRate <= 1)) return null;
  if (typeof b.evaluated !== "number" || b.evaluated <= 0) return null;
  if (typeof b.caseSetHash !== "string" || b.caseSetHash === "") return null;
  return {
    passRate: b.passRate,
    evaluated: b.evaluated,
    caseSetHash: b.caseSetHash,
    recordedAt: typeof b.recordedAt === "string" ? b.recordedAt : "",
  };
}

/** ケース名集合の指紋（順序非依存・重複除去）。集合が同じなら run をまたいで安定。純関数。 */
export function caseSetFingerprint(names: string[]): string {
  const sorted = [...new Set(names)].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}

/** 集約の分母になる「評価済み scored」ケース名（SKIP/monitor を除く）。純関数。 */
export function evaluatedScoredNames(results: CaseResult[]): string[] {
  return results.filter((r) => r.status !== "SKIP" && !r.monitor).map((r) => r.name);
}

/** 集約ゲートの判定結果。fail のみ exit を赤にする（他は情報表示）。 */
export type AggregateVerdict =
  | { kind: "pass"; passRate: number; floor: number }
  | { kind: "fail"; passRate: number; floor: number }
  | { kind: "no-baseline"; passRate: number }
  | { kind: "insufficient-n"; evaluated: number; minN: number }
  | { kind: "stale-baseline"; passRate: number };

/**
 * 集約ゲート判定の純関数。
 * - 評価済みが minN 未満: 集約は統計的に無意味なので判定しない（insufficient-n。ゲート無効）。
 * - baseline 無し: 判定不能（no-baseline。--update-baseline での記録を促す）。
 * - ケース集合が baseline と不一致: 合格率の比較は無効（stale-baseline。ゲートをスキップし再基準化を要求。
 *   黙って古い基準と比較して誤った赤/緑を出すより、比較不能を明示する方が安全）。
 * - それ以外: passRate < baseline.passRate − band で fail。境界（ちょうど floor）は pass。
 *   浮動小数の丸め（例 0.9-0.08=0.8200…01）で境界が誤判定しないよう epsilon を持つ。
 * 副作用なし・入力不変。
 */
export function aggregateVerdict(
  sc: Scorecard,
  names: string[],
  baseline: Baseline | null,
  opts: { band: number; minN: number },
): AggregateVerdict {
  const evaluated = sc.total.evaluated;
  if (evaluated < opts.minN || evaluated === 0) {
    return { kind: "insufficient-n", evaluated, minN: opts.minN };
  }
  const passRate = sc.total.pass / evaluated;
  if (!baseline) return { kind: "no-baseline", passRate };
  if (caseSetFingerprint(names) !== baseline.caseSetHash) return { kind: "stale-baseline", passRate };
  const floor = baseline.passRate - opts.band;
  if (passRate + 1e-9 < floor) return { kind: "fail", passRate, floor };
  return { kind: "pass", passRate, floor };
}

/**
 * exit 全体の合否: 安全ゲート失敗なし かつ 集約が fail でない。
 * no-baseline / insufficient-n / stale-baseline は「判定不能」であり赤にしない
 * （基準が無い・比較不能な状態で CI を止めるとゲート導入自体が阻害されるため、情報表示に留める）。
 * 副作用なし。
 */
export function exitPassed(sc: Scorecard, verdict: AggregateVerdict): boolean {
  return overallPassed(sc) && verdict.kind !== "fail";
}

/** 集約ゲートの表示行（スコアカード末尾に追記する）。純関数。 */
export function formatAggregate(verdict: AggregateVerdict, band: number): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  switch (verdict.kind) {
    case "pass":
      return `  集約: PASS（合格率 ${pct(verdict.passRate)} ≥ 基準−band ${pct(verdict.floor)}）`;
    case "fail":
      return `  集約: FAIL（合格率 ${pct(verdict.passRate)} < 基準−band ${pct(verdict.floor)}）← 全体劣化`;
    case "no-baseline":
      return `  集約: 基準なし（合格率 ${pct(verdict.passRate)}。--update-baseline で記録すると次回からゲート有効）`;
    case "insufficient-n":
      return `  集約: 判定なし（評価済み ${verdict.evaluated} 件 < 最小 ${verdict.minN} 件。ケース拡充後に有効化）`;
    case "stale-baseline":
      return `  集約: 基準が古い（ケース集合が変更済み。合格率 ${pct(verdict.passRate)}。--update-baseline で再記録）`;
  }
}
