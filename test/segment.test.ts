import { expect, test } from "bun:test";
import { indexTokens, queryTerms } from "../src/kb/segment.ts";

test("indexTokens は空白連結・小文字化する", () => {
  const out = indexTokens("認証はどうやる");
  expect(out).toContain("認証");
  expect(out.includes(" ")).toBe(true); // 分割されている
});

test("queryTerms は内容語を残し助詞を落とす", () => {
  const terms = queryTerms("認証はどうやる？");
  expect(terms).toContain("認証");
  expect(terms).not.toContain("は"); // 助詞は除去
});

test("queryTerms は単独ひらがな・記号のみを除去する", () => {
  const terms = queryTerms("の、。！");
  expect(terms).toEqual([]);
});

test("英語は空白区切りのまま内容語が残る", () => {
  const terms = queryTerms("where is the deploy target");
  expect(terms).toContain("deploy");
  expect(terms).toContain("target");
});
