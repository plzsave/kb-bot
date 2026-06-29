import { expect, test } from "bun:test";
import { buildScorecard, validateCases, type CaseResult, type RawCase } from "../scripts/kb-eval.ts";

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

test("buildScorecard は入力を変更しない（純粋）", () => {
  const results: CaseResult[] = [
    caseResult({ name: "a1", axis: "A", gate: true, status: "PASS" }),
    caseResult({ name: "a2", axis: "A", status: "SKIP" }),
  ];
  const snapshot = JSON.stringify(results);
  buildScorecard(results);
  expect(JSON.stringify(results)).toBe(snapshot);
});
