import { expect, test } from "bun:test";
import { validateCases, type RawCase } from "../scripts/kb-eval.ts";

function rawCase(overrides: Partial<RawCase>): RawCase {
  return {
    name: "c",
    question: "q",
    expect: {},
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
