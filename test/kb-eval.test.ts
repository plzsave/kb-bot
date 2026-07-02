import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countChunks, search } from "../src/kb/db.ts";
import {
  buildFixtureDb,
  buildScorecard,
  citationFails,
  evalCase,
  nextStepFails,
  NEXT_STEP_CUES,
  formatScorecard,
  overallPassed,
  statusLabel,
  validateCases,
  type CaseResult,
  type RawCase,
  type Scorecard,
} from "../scripts/kb-eval.ts";

function rawCase(overrides: Partial<RawCase>): RawCase {
  return {
    name: "c",
    question: "q",
    expect: {},
    ...overrides,
  };
}

function caseResult(overrides: Partial<CaseResult>): CaseResult {
  return {
    name: "c",
    gate: false,
    status: "PASS",
    fails: [],
    ...overrides,
  };
}

test("validateCases は有効な軸のみなら空配列を返す", () => {
  const cases: RawCase[] = [
    rawCase({ name: "a", axis: "A" }),
    rawCase({ name: "b", axis: "B" }),
    rawCase({ name: "c", axis: "C" }),
    rawCase({ name: "d", axis: "D" }),
    rawCase({ name: "s", axis: "safety" }),
  ];
  expect(validateCases(cases)).toEqual([]);
});

test("validateCases は無タグのみなら空配列を返す", () => {
  const cases: RawCase[] = [rawCase({ name: "a" }), rawCase({ name: "b" })];
  expect(validateCases(cases)).toEqual([]);
});

test("validateCases は不正な軸を含むと非空のエラー列を返す", () => {
  const cases: RawCase[] = [rawCase({ name: "bad", axis: "X" }), rawCase({ name: "ok", axis: "A" })];
  const errors = validateCases(cases);
  expect(errors.length).toBeGreaterThan(0);
  // エラー文に問題のケース名と不正値が含まれること（黙って集計に流さない）
  expect(errors.some((e) => e.includes("bad") && e.includes("X"))).toBe(true);
});

test("validateCases は不正な軸ごとにエラーを集める", () => {
  const cases: RawCase[] = [
    rawCase({ name: "bad1", axis: "X" }),
    rawCase({ name: "bad2", axis: "E" }),
  ];
  const errors = validateCases(cases);
  expect(errors.length).toBe(2);
});

test("validateCases は gate が真偽値なら許容する", () => {
  const cases: RawCase[] = [
    rawCase({ name: "g1", gate: true }),
    rawCase({ name: "g2", gate: false }),
    rawCase({ name: "g3" }), // gate 省略は false 扱い → エラーなし
  ];
  expect(validateCases(cases)).toEqual([]);
});

test("validateCases は gate が真偽値以外なら不正として報告する", () => {
  const cases: RawCase[] = [rawCase({ name: "bad", gate: "yes" as unknown })];
  const errors = validateCases(cases);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.some((e) => e.includes("bad"))).toBe(true);
});

test("validateCases は fixtures が文字列配列なら許容する（後方互換の拡張）", () => {
  const cases: RawCase[] = [
    rawCase({ name: "f1", fixtures: ["cache-ttl.md"] }),
    rawCase({ name: "f2", fixtures: ["a.md", "b.md"] }),
    rawCase({ name: "f3", fixtures: [] }), // 空配列も文字列配列（許容）
  ];
  expect(validateCases(cases)).toEqual([]);
});

test("validateCases は fixtures 未指定なら従来どおり通過する（後方互換）", () => {
  const cases: RawCase[] = [rawCase({ name: "a" }), rawCase({ name: "b", axis: "A" })];
  expect(validateCases(cases)).toEqual([]);
});

test("validateCases は fixtures が非配列なら不正として報告する", () => {
  const cases: RawCase[] = [rawCase({ name: "bad", fixtures: "cache-ttl.md" as unknown as string[] })];
  const errors = validateCases(cases);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.some((e) => e.includes("bad") && e.includes("fixtures"))).toBe(true);
});

test("validateCases は fixtures の要素が非文字列なら不正として報告する", () => {
  const cases: RawCase[] = [rawCase({ name: "bad", fixtures: [1] as unknown as string[] })];
  const errors = validateCases(cases);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.some((e) => e.includes("bad") && e.includes("fixtures"))).toBe(true);
});

test("eval/cases.sample.json は validateCases を通過する（軸/ゲートのサンプルが妥当）", () => {
  // サンプルに記す軸/ゲートの使用例が常に有効な値であることを保証する恒久ガード（Req 4.1 の境界外で、サンプルのみを検証）。
  const sample = JSON.parse(readFileSync(new URL("../eval/cases.sample.json", import.meta.url), "utf8")) as RawCase[];
  expect(validateCases(sample)).toEqual([]);
});

test("validateCases は入力を変更しない（純粋）", () => {
  const cases: RawCase[] = [rawCase({ name: "a", axis: "A", gate: true })];
  const snapshot = JSON.stringify(cases);
  validateCases(cases);
  expect(JSON.stringify(cases)).toBe(snapshot);
});

test("buildScorecard は軸別 pass/total を集計し、出現した軸のみ含める", () => {
  const results: CaseResult[] = [
    caseResult({ name: "a1", axis: "A", status: "PASS" }),
    caseResult({ name: "a2", axis: "A", status: "FAIL", fails: ["x"] }),
    caseResult({ name: "b1", axis: "B", status: "PASS" }),
  ];
  const sc = buildScorecard(results);
  // 出現した軸（A, B）のみ。C/D/safety は含めない。
  expect(sc.perAxis.map((t) => t.axis).sort()).toEqual(["A", "B"]);
  const a = sc.perAxis.find((t) => t.axis === "A");
  const b = sc.perAxis.find((t) => t.axis === "B");
  expect(a).toEqual({ axis: "A", pass: 1, total: 2 });
  expect(b).toEqual({ axis: "B", pass: 1, total: 1 });
});

test("buildScorecard は SKIP を軸別・evaluated・skipped で正しく扱う", () => {
  const results: CaseResult[] = [
    caseResult({ name: "a1", axis: "A", status: "PASS" }),
    caseResult({ name: "a2", axis: "A", status: "SKIP" }),
    caseResult({ name: "u1", status: "SKIP" }), // 無タグかつ SKIP
  ];
  const sc = buildScorecard(results);
  // SKIP は軸別 total に数えない（A は PASS の 1 件のみ）。
  expect(sc.perAxis.find((t) => t.axis === "A")).toEqual({ axis: "A", pass: 1, total: 1 });
  // evaluated は非 SKIP のみ（PASS 1 件）、skipped は 2 件。
  expect(sc.total).toEqual({ pass: 1, evaluated: 1, skipped: 2 });
});

test("buildScorecard は無タグを軸別に含めず総合のみに数える", () => {
  const results: CaseResult[] = [
    caseResult({ name: "u1", status: "PASS" }),
    caseResult({ name: "u2", status: "FAIL", fails: ["x"] }),
    caseResult({ name: "a1", axis: "A", status: "PASS" }),
  ];
  const sc = buildScorecard(results);
  // 無タグは perAxis に出てこない。
  expect(sc.perAxis.map((t) => t.axis)).toEqual(["A"]);
  // 総合は無タグ含めて評価済み 3 件・pass 2 件。
  expect(sc.total).toEqual({ pass: 2, evaluated: 3, skipped: 0 });
});

test("buildScorecard はゲートの FAIL/ERROR を記録し、SKIP ゲートと PASS ゲートを除外する", () => {
  const results: CaseResult[] = [
    caseResult({ name: "gFail", gate: true, status: "FAIL", fails: ["x"] }),
    caseResult({ name: "gErr", gate: true, status: "ERROR", fails: [] }),
    caseResult({ name: "gPass", gate: true, status: "PASS" }),
    caseResult({ name: "gSkip", gate: true, status: "SKIP" }), // SKIP は母数にも入れない
    caseResult({ name: "nonGate", gate: false, status: "FAIL", fails: ["y"] }),
  ];
  const sc = buildScorecard(results);
  // FAIL/ERROR のゲートのみを失敗一覧に。SKIP・PASS・非ゲートは含めない。
  expect(sc.gate.failed.sort()).toEqual(["gErr", "gFail"]);
  // 母数は評価済みゲート（FAIL+ERROR+PASS=3）。SKIP ゲートは除外。
  expect(sc.gate.total).toBe(3);
});

test("buildScorecard は axis と gate を直交として双方に計上する", () => {
  const results: CaseResult[] = [
    // safety 軸かつゲートの FAIL ケースは、軸別 tally とゲート母数の双方に計上される。
    caseResult({ name: "s1", axis: "safety", gate: true, status: "FAIL", fails: ["x"] }),
    caseResult({ name: "s2", axis: "safety", gate: true, status: "PASS" }),
  ];
  const sc = buildScorecard(results);
  // 軸別 tally: safety pass 1/total 2。
  expect(sc.perAxis.find((t) => t.axis === "safety")).toEqual({ axis: "safety", pass: 1, total: 2 });
  // ゲート母数 2、失敗一覧に FAIL の s1 のみ。
  expect(sc.gate.total).toBe(2);
  expect(sc.gate.failed).toEqual(["s1"]);
});

test("buildScorecard は軸・ゲート・無タグ・SKIP 混在を 1 パスで軸別/ゲート/総合に集計する", () => {
  // Req 3.2: 軸タグ・ゲート・無タグのケースが混在しても 1 回で軸別集計＋ゲート合否＋総合を出す。
  const results: CaseResult[] = [
    caseResult({ name: "a1", axis: "A", status: "PASS" }),
    caseResult({ name: "a2", axis: "A", status: "FAIL", fails: ["x"] }),
    caseResult({ name: "g1", axis: "safety", gate: true, status: "FAIL", fails: ["y"] }), // 軸×ゲート直交の失敗
    caseResult({ name: "g2", gate: true, status: "PASS" }), // ゲートのみ（無タグ）
    caseResult({ name: "u1", status: "PASS" }), // 無タグ
    caseResult({ name: "u2", status: "FAIL", fails: ["z"] }), // 無タグ
    caseResult({ name: "sB", axis: "B", status: "SKIP" }), // SKIP 軸は perAxis に出さない
    caseResult({ name: "sGate", gate: true, status: "SKIP" }), // SKIP ゲートは母数に入れない
    caseResult({ name: "sU", status: "SKIP" }), // 無タグ SKIP
  ];
  const sc = buildScorecard(results);
  // 軸別: 出現した非 SKIP 軸のみ（A, safety）。SKIP のみの B は現れない。
  expect(sc.perAxis.map((t) => t.axis)).toEqual(["A", "safety"]);
  expect(sc.perAxis.find((t) => t.axis === "A")).toEqual({ axis: "A", pass: 1, total: 2 });
  expect(sc.perAxis.find((t) => t.axis === "safety")).toEqual({ axis: "safety", pass: 0, total: 1 });
  // ゲート: 評価済みゲート（g1 FAIL, g2 PASS）が母数 2、SKIP ゲートは除外。失敗一覧は g1 のみ。
  expect(sc.gate).toEqual({ failed: ["g1"], total: 2 });
  // 総合: 評価済み 6（a1,a2,g1,g2,u1,u2）・pass 3（a1,g2,u1）・SKIP 3。
  expect(sc.total).toEqual({ pass: 3, evaluated: 6, skipped: 3 });
});

test("buildScorecard は入力を変更しない（純粋）", () => {
  const results: CaseResult[] = [
    caseResult({ name: "a1", axis: "A", gate: true, status: "PASS" }),
    caseResult({ name: "a2", axis: "A", status: "SKIP" }),
  ];
  const snapshot = JSON.stringify(results);
  buildScorecard(results);
  expect(JSON.stringify(results)).toBe(snapshot);
});

test("statusLabel はゲートの FAIL/ERROR に印を付けてスコア軸の FAIL と区別する", () => {
  // 非ゲートは素のステータスのまま。
  expect(statusLabel("FAIL", false)).toBe("FAIL");
  expect(statusLabel("ERROR", false)).toBe("ERROR");
  // ゲートの失敗（FAIL/ERROR）は印付きで区別可能に（Req 2.3）。
  expect(statusLabel("FAIL", true)).toBe("FAIL*");
  expect(statusLabel("ERROR", true)).toBe("ERROR*");
  // PASS/SKIP はゲートでも印を付けない（失敗ではないため）。
  expect(statusLabel("PASS", true)).toBe("PASS");
  expect(statusLabel("SKIP", true)).toBe("SKIP");
});

function scorecard(overrides: Partial<Scorecard>): Scorecard {
  return {
    perAxis: [],
    gate: { failed: [], total: 0 },
    monitor: { pass: 0, total: 0, failed: [] },
    total: { pass: 0, evaluated: 0, skipped: 0 },
    ...overrides,
  };
}

// --- monitor（非ゲート・情報表示）分類（eval-monitor-cases） ---

test("validateCases は monitor が真偽値なら許容し、非真偽値なら報告する", () => {
  expect(validateCases([rawCase({ name: "m1", monitor: true }), rawCase({ name: "m2", monitor: false })])).toEqual([]);
  const errors = validateCases([rawCase({ name: "bad", monitor: "yes" as unknown as boolean })]);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.some((e) => e.includes("bad") && e.includes("monitor"))).toBe(true);
});

test("buildScorecard は monitor ケースを別 tally に入れ、total/gate/perAxis を汚さない", () => {
  const results: CaseResult[] = [
    caseResult({ name: "s1", axis: "A", status: "PASS" }), // scored
    caseResult({ name: "m1", axis: "D", monitor: true, status: "FAIL", fails: ["x"] }), // monitor FAIL
    caseResult({ name: "m2", axis: "B", monitor: true, status: "PASS" }), // monitor PASS
  ];
  const sc = buildScorecard(results);
  // total（exit 母数）は scored のみ。monitor は含めない。
  expect(sc.total).toEqual({ pass: 1, evaluated: 1, skipped: 0 });
  // perAxis も scored のみ（D/B の monitor は出さない）。
  expect(sc.perAxis.map((t) => t.axis)).toEqual(["A"]);
  // monitor tally に PASS/FAIL が入る。
  expect(sc.monitor).toEqual({ pass: 1, total: 2, failed: ["m1"] });
});

test("overallPassed は monitor FAIL があっても gate/scored 全 PASS なら true", () => {
  const results: CaseResult[] = [
    caseResult({ name: "s1", status: "PASS" }),
    caseResult({ name: "m1", monitor: true, status: "FAIL", fails: ["x"] }),
  ];
  expect(overallPassed(buildScorecard(results))).toBe(true);
});

test("formatScorecard は monitor 行を pass/total と FAIL 名付きで出す（total>0 時のみ）", () => {
  const withMon = formatScorecard(scorecard({ monitor: { pass: 1, total: 2, failed: ["mFail"] }, total: { pass: 1, evaluated: 1, skipped: 0 } }));
  expect(withMon).toContain("モニタ（非ゲート）");
  expect(withMon).toContain("1/2");
  expect(withMon).toContain("mFail");
  // monitor が無ければ行は出ない（既存表示の後方互換）。
  expect(formatScorecard(scorecard({ total: { pass: 1, evaluated: 1, skipped: 0 } }))).not.toContain("モニタ");
});

test("eval/cases.json は集約ゲートの前提を満たす（構造ガード）", () => {
  // 旧ガード（soft ケースの monitor 隔離）は per-case ゲート時代の回避策で、集約ゲート導入により
  // 廃止（個別の揺れは集約が吸収する）。新ガードは集約ゲートが機能するための前提を守る:
  // (1) 定義が妥当、(2) 集約の分母が統計的に意味を持つ規模、(3) 安全ゲートに実メンバーがいる、
  // (4) 参照する fixture が実在する（ライブ実行前に typo を決定的に検出）。
  const cases = JSON.parse(
    readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"),
  ) as (RawCase & { fixtures?: string[]; gate?: boolean; monitor?: boolean })[];

  expect(validateCases(cases)).toEqual([]);

  // 集約の分母（scored ＝ 非 monitor）が minN 既定 30 を安全に上回る規模であること。
  const scored = cases.filter((c) => c.monitor !== true);
  expect(scored.length).toBeGreaterThanOrEqual(40);

  // 安全ゲートに実メンバー（gate:true の注入ケース）がいること（overallPassed が常に true にならない）。
  const gates = cases.filter((c) => c.gate === true);
  expect(gates.length).toBeGreaterThanOrEqual(3);

  // 参照 fixture の実在検査（buildFixtureDb は実行時に fail-fast するが、ここで先に決定的に落とす）。
  for (const c of cases) {
    for (const f of c.fixtures ?? []) {
      const p = new URL(`../eval/fixtures/${f}`, import.meta.url);
      expect({ file: f, exists: existsSync(p) }).toEqual({ file: f, exists: true });
    }
  }
});

test("overallPassed は評価済み全 PASS かつゲート失敗なしで true", () => {
  const sc = scorecard({
    perAxis: [{ axis: "A", pass: 2, total: 2 }],
    gate: { failed: [], total: 3 },
    total: { pass: 5, evaluated: 5, skipped: 0 },
  });
  expect(overallPassed(sc)).toBe(true);
});

test("overallPassed は runnable 全 PASS なら一部 SKIP でも true（SKIP 不整合の是正）", () => {
  const sc = scorecard({
    total: { pass: 5, evaluated: 5, skipped: 2 },
  });
  expect(overallPassed(sc)).toBe(true);
});

test("overallPassed はゲート失敗があれば他軸に関わらず false", () => {
  // スコア軸はすべて PASS（pass === evaluated）でも、ゲート失敗があれば不合格。
  const sc = scorecard({
    gate: { failed: ["gFail"], total: 2 },
    total: { pass: 5, evaluated: 5, skipped: 0 },
  });
  expect(overallPassed(sc)).toBe(false);
});

test("overallPassed は scored に FAIL があっても安全ゲート失敗が無ければ true（レポート専用）", () => {
  // ライブ eval はレポート専用。scored/monitor の pass/fail は exit を左右せず、
  // exit は安全ゲート（gate:true）失敗のみで決まる。非決定な単発採点で run が赤にならないための設計。
  const sc = scorecard({
    gate: { failed: [], total: 1 },
    total: { pass: 4, evaluated: 5, skipped: 0 }, // scored に 1 件 FAIL があるが…
  });
  expect(overallPassed(sc)).toBe(true); // 安全ゲート失敗が無いので合格
});

test("overallPassed は安全ゲート失敗があれば scored 全 PASS でも false（ハード合否は安全のみ）", () => {
  const sc = scorecard({
    gate: { failed: ["safety-injection"], total: 2 },
    total: { pass: 5, evaluated: 5, skipped: 0 },
  });
  expect(overallPassed(sc)).toBe(false);
});

test("formatScorecard は軸別行・ゲート行・総合 PASS 数を含む", () => {
  const sc = scorecard({
    perAxis: [
      { axis: "A", pass: 1, total: 2 },
      { axis: "safety", pass: 1, total: 1 },
    ],
    gate: { failed: ["gFail"], total: 3 },
    total: { pass: 5, evaluated: 7, skipped: 2 },
  });
  const out = formatScorecard(sc);
  // 軸別行: 各軸名と pass/total。
  expect(out.includes("A")).toBe(true);
  expect(out.includes("1/2")).toBe(true);
  expect(out.includes("safety")).toBe(true);
  // ゲート行: 失敗件数と失敗ケース名。
  expect(out.includes("gFail")).toBe(true);
  // 総合行: 評価済み基準の PASS 数（既存の総合 PASS 数を保持）と SKIP 数。
  expect(out.includes("5/7")).toBe(true);
  expect(out.includes("2 SKIP")).toBe(true);
});

test("formatScorecard はゲート失敗なしのとき失敗なしと分かる総合行を出す", () => {
  const sc = scorecard({
    perAxis: [{ axis: "A", pass: 2, total: 2 }],
    gate: { failed: [], total: 2 },
    total: { pass: 3, evaluated: 3, skipped: 0 },
  });
  const out = formatScorecard(sc);
  // 総合 PASS 数を保持。
  expect(out.includes("3/3")).toBe(true);
  // ゲート行が母数を示し、失敗ケース名は現れない。
  expect(out.includes("gFail")).toBe(false);
});

// --- citationFails（出典体裁の判定・純粋関数, Req 1/2/4） ---

test("citationFails は citesSource 未指定なら空配列（既存判定を変えない, Req 4.2）", () => {
  // フラグ未指定のケースは出典検査を一切しない（後方互換）。
  expect(citationFails({}, "根拠なしの回答")).toEqual([]);
  // 明示 false も同様に不作用。
  expect(citationFails({ citesSource: false }, "根拠なしの回答")).toEqual([]);
});

test("citationFails は citesSource:true + .md 資料名があれば空配列（Req 1.3 doc 側）", () => {
  expect(citationFails({ citesSource: true }, "詳細は auth.md を参照してください")).toEqual([]);
  // path 付きの .md も doc 引用として認める。
  expect(citationFails({ citesSource: true }, "根拠: docs/auth.md の該当節")).toEqual([]);
});

test("citationFails は citesSource:true + path:line があれば空配列（Req 1.3 code 側）", () => {
  expect(citationFails({ citesSource: true }, "実装は db.ts:42 にあります")).toEqual([]);
  expect(citationFails({ citesSource: true }, "参照 src/kb/db.ts:120 を確認")).toEqual([]);
});

test("citationFails は citesSource:true + 体裁なしなら指摘1件（Req 1.2）", () => {
  const fails = citationFails({ citesSource: true }, "根拠を示さない一般的な回答です");
  expect(fails.length).toBe(1);
});

test("citationFails は併用時に読んだ path の path:line 引用があれば空配列（Req 2.3）", () => {
  const fails = citationFails(
    { citesSource: true, readPathIncludes: "db.ts" },
    "検索は src/kb/db.ts:42 で行われます",
  );
  expect(fails).toEqual([]);
});

test("citationFails は併用時に行番号なし/無関係な引用のみなら指摘1件（Req 2.2）", () => {
  // 行番号なしの素の path 言及のみ → 厳格判定は通らない。
  const noLine = citationFails(
    { citesSource: true, readPathIncludes: "db.ts" },
    "実装は db.ts にあります",
  );
  expect(noLine.length).toBe(1);
  // 無関係な path:line のみ（読んだ path を含まない） → 通らない。
  const unrelated = citationFails(
    { citesSource: true, readPathIncludes: "db.ts" },
    "参照 other.ts:5 を確認",
  );
  expect(unrelated.length).toBe(1);
});

test("citationFails は体裁欠如と path 未引用で別文言を返す（既存 fail と区別可能, Req 1.2）", () => {
  const generic = citationFails({ citesSource: true }, "根拠なし");
  const strict = citationFails({ citesSource: true, readPathIncludes: "db.ts" }, "根拠なし");
  expect(generic[0]).not.toBe(strict[0]);
});

test("citationFails は入力を変更しない（純粋・Invariant）", () => {
  const expectObj = { citesSource: true, readPathIncludes: "db.ts" } as const;
  const snapshot = JSON.stringify(expectObj);
  citationFails(expectObj, "db.ts の説明");
  expect(JSON.stringify(expectObj)).toBe(snapshot);
});

// --- evalCase への出典採点の統合（Req 1.1 / 2.1 / 4.3） ---

test("evalCase は citesSource:true で出典体裁の無い回答に出典欠如の fail を含める（統合, Req 1.1）", () => {
  // citationFails が evalCase の採点に組み込まれている証明。
  const fails = evalCase({ citesSource: true }, [], "根拠を示さない一般的な回答です");
  expect(fails.some((f) => f.includes("出典必須"))).toBe(true);
});

test("evalCase は readPathIncludes+citesSource 併用で path:line 未引用なら出典 fail を含める（Req 2.1）", () => {
  // 読んだ path 自体は満たす（read_repo_file で db.ts を読了）が、本文に path:line 引用が無い。
  const calls = [{ name: "read_repo_file", input: { path: "src/kb/db.ts" }, output: "..." }];
  const fails = evalCase({ readPathIncludes: "db.ts", citesSource: true }, calls, "実装は db.ts にあります");
  expect(fails.some((f) => f.includes("出典必須"))).toBe(true);
  // readPathIncludes は満たしているため、read 未実施の既存 fail は混入しない（出典観点のみ）。
  expect(fails.some((f) => f.includes("read_repo_file"))).toBe(false);
});

test("evalCase は citesSource 未指定なら出典 fail を混入させず従来と同一（後方互換, Req 4.3）", () => {
  // answerIncludes だけ指定した従来ケース。出典体裁が無い回答でも出典 fail は増えない。
  const noCite = evalCase({ answerIncludes: ["結論"] }, [], "結論はこうです");
  expect(noCite).toEqual([]);
  expect(noCite.some((f) => f.includes("出典必須"))).toBe(false);
});

// --- nextStepFails（「次の一歩」の判定・純粋関数, Req 2.2/2.3/2.4） ---

test("nextStepFails は offersNextStep 未指定なら空配列（既存判定を変えない, Req 2.4）", () => {
  expect(nextStepFails({}, "見つかりませんでした")).toEqual([]);
  expect(nextStepFails({ offersNextStep: false }, "見つかりませんでした")).toEqual([]);
});

test("nextStepFails は offersNextStep:true + 手掛かり語ありで空配列（Req 2.1 正常系）", () => {
  expect(
    nextStepFails({ offersNextStep: true }, "見つかりませんでした。キーワードを足すと見つかるかもしれません。"),
  ).toEqual([]);
  expect(
    nextStepFails({ offersNextStep: true }, "該当資料が無いようです。資料を追加すれば答えられます。"),
  ).toEqual([]);
});

test("nextStepFails は bot 実出力の『次のステップ…お勧めします』型を検出する（回帰・実測ベース）", () => {
  // ライブ eval で観測した実際の未発見回答（次のステップ提示型）を採点器が拾えること。
  // 検出語彙が USAGE の具体策のみに退行すると、この正しい回答を取りこぼす（false negative）ため恒久ガード。
  const real =
    "該当する情報が見つかりませんでした。次のステップとして、リポジトリの構造を確認するか、プロダクト担当者に直接確認することをお勧めします。";
  expect(nextStepFails({ offersNextStep: true }, real)).toEqual([]);
});

test("nextStepFails は offersNextStep:true + 手掛かりなしなら欠如 fail 1件（Req 2.2/3.3）", () => {
  const fails = nextStepFails({ offersNextStep: true }, "ナレッジに見つかりませんでした。");
  expect(fails.length).toBe(1);
  expect(fails[0]).toContain("次の一歩");
});

test("NEXT_STEP_CUES は一般的な未発見文（手掛かり語なし）で誤検出しない（過剰一致回避, Req 2.3）", () => {
  // 手掛かり語彙を含まない素の「見つからない」応答では一致しないこと。
  const plain = "その情報は現在の知識ベースには存在しませんでした。";
  expect(NEXT_STEP_CUES.some((cue) => plain.includes(cue))).toBe(false);
});

test("nextStepFails は入力を変更しない（純粋・Invariant）", () => {
  const expectObj = { offersNextStep: true } as const;
  const snapshot = JSON.stringify(expectObj);
  nextStepFails(expectObj, "見つかりませんでした");
  expect(JSON.stringify(expectObj)).toBe(snapshot);
});

test("evalCase は offersNextStep:true で手掛かりの無い回答に次の一歩の fail を含める（統合, Req 2.1）", () => {
  const fails = evalCase({ offersNextStep: true }, [], "ナレッジに見つかりませんでした。");
  expect(fails.some((f) => f.includes("次の一歩"))).toBe(true);
});

test("evalCase は offersNextStep 未指定なら次の一歩 fail を混入させず従来と同一（後方互換, Req 4.1）", () => {
  const noNext = evalCase({ answerIncludes: ["結論"] }, [], "結論はこうです");
  expect(noNext).toEqual([]);
  expect(noNext.some((f) => f.includes("次の一歩"))).toBe(false);
});

// --- 本番ケース定義集の構造テスト（Req 3.1 / 3.2） ---

// --- buildFixtureDb（フィクスチャ隔離索引の組み立て, Req 2.1/2.2/2.4） ---

/** 一時 baseDir を作り、md ファイル群を書き込んで返す。呼び出し側が rmSync する。 */
function makeFixtures(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-eval-fixtures-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf8");
  }
  return dir;
}

test("buildFixtureDb はフィクスチャを索引し、その語で当該フィクスチャがヒットする（Req 2.1/2.4）", () => {
  const dir = makeFixtures({
    "cache-ttl.md": "# 回答キャッシュ\n\n回答キャッシュの有効期限（TTL）は 3600 秒です。",
  });
  const db = buildFixtureDb(["cache-ttl.md"], dir);
  try {
    // チャンク数が正（索引された）。
    expect(countChunks(db)).toBeGreaterThan(0);
    // フィクスチャの語でヒットし、docKey は相対パス。
    const hits = search(db, "回答キャッシュ 有効期限 TTL");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.docKey === "cache-ttl.md")).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildFixtureDb は複数フィクスチャをまとめて索引できる", () => {
  const dir = makeFixtures({
    "alpha.md": "# アルファ\n\nアルファ固有トークン zebracode を含む。",
    "beta.md": "# ベータ\n\nベータ固有トークン giraffecode を含む。",
  });
  const db = buildFixtureDb(["alpha.md", "beta.md"], dir);
  try {
    expect(search(db, "zebracode").some((h) => h.docKey === "alpha.md")).toBe(true);
    expect(search(db, "giraffecode").some((h) => h.docKey === "beta.md")).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildFixtureDb で得た 2 つの db は相互に内容が混ざらない（完全隔離, Req 2.2）", () => {
  const dir1 = makeFixtures({ "one.md": "# ワン\n\n固有トークン uniquetokenone を含む。" });
  const dir2 = makeFixtures({ "two.md": "# ツー\n\n固有トークン uniquetokentwo を含む。" });
  const db1 = buildFixtureDb(["one.md"], dir1);
  const db2 = buildFixtureDb(["two.md"], dir2);
  try {
    // db2 は db1 の内容を一切含まない（隔離）。
    expect(search(db2, "uniquetokenone")).toEqual([]);
    expect(search(db1, "uniquetokentwo")).toEqual([]);
    // それぞれのチャンク数は自分の doc のみを反映する。
    expect(countChunks(db1)).toBeGreaterThan(0);
    expect(countChunks(db2)).toBeGreaterThan(0);
    expect(search(db2, "uniquetokentwo").some((h) => h.docKey === "two.md")).toBe(true);
  } finally {
    db1.close();
    db2.close();
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("buildFixtureDb は解決を baseDir に固定し、cwd に依存しない（Issue 2）", () => {
  const dir = makeFixtures({ "anchored.md": "# 固定\n\n固有トークン anchoredtoken を含む。" });
  const db = buildFixtureDb(["anchored.md"], dir);
  try {
    // baseDir 配下の相対パス "anchored.md" が解決されて索引されている。
    expect(search(db, "anchoredtoken").some((h) => h.docKey === "anchored.md")).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildFixtureDb は存在しないフィクスチャで原因パスを添えて即エラー（fail-fast, Error Handling）", () => {
  const dir = makeFixtures({ "present.md": "# ある\n\n本文。" });
  try {
    let thrown: Error | undefined;
    try {
      buildFixtureDb(["missing.md"], dir);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // メッセージに解決した（不在の）パスを含む。
    expect(thrown?.message.includes("missing.md")).toBe(true);
    expect(thrown?.message.includes(dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 本番ケース定義集の構造テスト（Req 3.1 / 3.2） ---

test("eval/cases.json は docs 由来と code 由来の B′ ケースを各 1 件以上含む（構造ガード, Req 3.1/3.2）", () => {
  // 本番のケース定義集そのものを読み、B′（axis:"B" かつ citesSource:true）の
  // docs 由来・code 由来ケースが存在し続けることを恒久ガードする。
  // これらが削除/退行すれば出典採点の実データ検証が失われるため、ここで落とす。
  const cases = JSON.parse(
    readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"),
  ) as RawCase[];

  // Req 3.1: docs 由来 B′（axis:"B"・citesSource:true・source:"docs"）が 1 件以上。
  const docsBprime = cases.filter(
    (c) => c.axis === "B" && c.expect.citesSource === true && c.expect.source === "docs",
  );
  expect(docsBprime.length).toBeGreaterThanOrEqual(1);

  // Req 3.2: code 由来 B′（axis:"B"・citesSource:true・source:"code" かつ readPathIncludes 指定あり）が 1 件以上。
  const codeBprime = cases.filter(
    (c) =>
      c.axis === "B" &&
      c.expect.citesSource === true &&
      c.expect.source === "code" &&
      c.expect.readPathIncludes !== undefined,
  );
  expect(codeBprime.length).toBeGreaterThanOrEqual(1);
});

test("eval/cases.json は軸 D（次の一歩必須・推測禁止併記）ケースを 1 件以上含む（構造ガード, Req 3.1/3.4）", () => {
  // 未発見時に「次の一歩」を要求する軸 D ケースが存在し続けることを恒久ガードする。
  // guard の趣旨（無根拠推測の禁止）と両立させるため answerOmits の併記も必須とする。
  const cases = JSON.parse(
    readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"),
  ) as RawCase[];
  const dCases = cases.filter(
    (c) =>
      c.axis === "D" &&
      c.expect.offersNextStep === true &&
      Array.isArray(c.expect.answerOmits) &&
      c.expect.answerOmits.length > 0,
  );
  expect(dCases.length).toBeGreaterThanOrEqual(1);
});

// ---- 集約ゲート（統計的品質回帰検知）の決定的テスト ----
// per-case 合否は非決定でゲートにできない（#39-#42）。集約（合格率 vs 基準−band）に変えることで
// 個別の揺れをノイズとして吸収し「全体劣化」だけを赤にする。判定ロジック自体は純関数＝ここで固定。
import {
  parseBaseline,
  caseSetFingerprint,
  evaluatedScoredNames,
  aggregateVerdict,
  exitPassed,
  formatAggregate,
  type Baseline,
} from "../scripts/kb-eval.ts";

const mkResult = (name: string, status: "PASS" | "FAIL" | "SKIP" | "ERROR", monitor = false) => ({
  name,
  gate: false,
  monitor,
  status,
  fails: [] as string[],
});

const mkScorecard = (pass: number, evaluated: number, gateFailed: string[] = []) => ({
  perAxis: [],
  gate: { failed: gateFailed, total: gateFailed.length },
  monitor: { pass: 0, total: 0, failed: [] as string[] },
  total: { pass, evaluated, skipped: 0 },
});

test("caseSetFingerprint は順序非依存・重複除去で安定", () => {
  const a = caseSetFingerprint(["b", "a", "c"]);
  expect(caseSetFingerprint(["c", "a", "b"])).toBe(a);
  expect(caseSetFingerprint(["a", "b", "c", "a"])).toBe(a);
  expect(caseSetFingerprint(["a", "b"])).not.toBe(a);
});

test("evaluatedScoredNames は SKIP と monitor を除外する", () => {
  const names = evaluatedScoredNames([
    mkResult("a", "PASS"),
    mkResult("b", "FAIL"),
    mkResult("c", "SKIP"),
    mkResult("d", "PASS", true), // monitor
    mkResult("e", "ERROR"),
  ]);
  expect(names).toEqual(["a", "b", "e"]);
});

test("parseBaseline は正しい形のみ受理し、不正は null", () => {
  const ok = parseBaseline({ passRate: 0.9, evaluated: 60, caseSetHash: "abc", recordedAt: "2026-07-02" });
  expect(ok?.passRate).toBe(0.9);
  expect(parseBaseline(null)).toBeNull();
  expect(parseBaseline({ passRate: 1.5, evaluated: 60, caseSetHash: "abc" })).toBeNull();
  expect(parseBaseline({ passRate: 0.9, evaluated: 0, caseSetHash: "abc" })).toBeNull();
  expect(parseBaseline({ passRate: 0.9, evaluated: 60, caseSetHash: "" })).toBeNull();
});

const NAMES = ["a", "b", "c"];
const baselineFor = (passRate: number, names = NAMES): Baseline => ({
  passRate,
  evaluated: names.length,
  caseSetHash: caseSetFingerprint(names),
  recordedAt: "",
});

test("aggregateVerdict: minN 未満は insufficient-n（ゲート無効）", () => {
  const v = aggregateVerdict(mkScorecard(10, 10), NAMES, baselineFor(0.9), { band: 0.08, minN: 30 });
  expect(v.kind).toBe("insufficient-n");
});

test("aggregateVerdict: baseline 無しは no-baseline", () => {
  const v = aggregateVerdict(mkScorecard(50, 60), NAMES, null, { band: 0.08, minN: 30 });
  expect(v.kind).toBe("no-baseline");
});

test("aggregateVerdict: ケース集合が変わったら stale-baseline（誤比較しない）", () => {
  const v = aggregateVerdict(mkScorecard(50, 60), ["a", "b", "x"], baselineFor(0.9), { band: 0.08, minN: 30 });
  expect(v.kind).toBe("stale-baseline");
});

test("aggregateVerdict: 基準−band 以上なら pass・下回ったら fail", () => {
  const b = baselineFor(0.9);
  // 54/60 = 0.90 ≥ 0.82 → pass
  expect(aggregateVerdict(mkScorecard(54, 60), NAMES, b, { band: 0.08, minN: 30 }).kind).toBe("pass");
  // 48/60 = 0.80 < 0.82 → fail
  expect(aggregateVerdict(mkScorecard(48, 60), NAMES, b, { band: 0.08, minN: 30 }).kind).toBe("fail");
});

test("aggregateVerdict: 境界（ちょうど floor）は浮動小数の丸めでも pass", () => {
  // 0.9 - 0.08 = 0.8200000000000001（FP）。41/50 = 0.82 は「ちょうど floor」＝ pass であるべき。
  const names50 = Array.from({ length: 50 }, (_, i) => `c${i}`);
  const v = aggregateVerdict(mkScorecard(41, 50), names50, baselineFor(0.9, names50), { band: 0.08, minN: 30 });
  expect(v.kind).toBe("pass");
});

test("exitPassed: 安全ゲート失敗 or 集約 fail で false、判定不能系は true", () => {
  const scOk = mkScorecard(54, 60);
  const scGateFail = mkScorecard(54, 60, ["inj"]);
  expect(exitPassed(scOk, { kind: "pass", passRate: 0.9, floor: 0.82 })).toBe(true);
  expect(exitPassed(scOk, { kind: "fail", passRate: 0.7, floor: 0.82 })).toBe(false);
  expect(exitPassed(scGateFail, { kind: "pass", passRate: 0.9, floor: 0.82 })).toBe(false);
  expect(exitPassed(scOk, { kind: "no-baseline", passRate: 0.9 })).toBe(true);
  expect(exitPassed(scOk, { kind: "insufficient-n", evaluated: 10, minN: 30 })).toBe(true);
  expect(exitPassed(scOk, { kind: "stale-baseline", passRate: 0.9 })).toBe(true);
});

test("formatAggregate は各 verdict を区別できる行を返す", () => {
  expect(formatAggregate({ kind: "pass", passRate: 0.9, floor: 0.82 }, 0.08)).toContain("集約: PASS");
  expect(formatAggregate({ kind: "fail", passRate: 0.7, floor: 0.82 }, 0.08)).toContain("集約: FAIL");
  expect(formatAggregate({ kind: "no-baseline", passRate: 0.9 }, 0.08)).toContain("基準なし");
  expect(formatAggregate({ kind: "insufficient-n", evaluated: 10, minN: 30 }, 0.08)).toContain("判定なし");
  expect(formatAggregate({ kind: "stale-baseline", passRate: 0.9 }, 0.08)).toContain("基準が古い");
});
