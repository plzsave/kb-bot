import { expect, test } from "bun:test";
import { computeFlags, monthsAgoIso } from "../src/kb/prune.ts";
import { parseFrontmatter, assembleMarkdown, staleDocKey, staleKeyForKey, issueDocKey } from "../src/kb/issueDoc.ts";
import { isStaleKey } from "../src/kb/ingest.ts";
import type { RawIssue } from "../src/issues.ts";
import type { IssueMeta } from "../src/kb/issueDoc.ts";

const NOW = new Date("2026-06-21T00:00:00Z");
function meta(over: Partial<IssueMeta> = {}): IssueMeta {
  return { source: "github-issue", related_files: [], labels: [], closed_at: "2026-06-01T00:00:00Z", ...over };
}
const ctx = (over = {}) => ({
  now: NOW,
  ageYears: 2,
  unusedMonths: 6,
  usedRecently: false,
  missingFiles: [] as string[],
  ...over,
});

test("computeFlags: old は closed_at が ageYears 以上で立つ", () => {
  expect(computeFlags(meta({ closed_at: "2023-01-01T00:00:00Z" }), ctx()).flags).toContain("old");
  expect(computeFlags(meta({ closed_at: "2025-06-01T00:00:00Z" }), ctx()).flags).not.toContain("old");
});

test("computeFlags: unused は closed_at の猶予を満たし retrieved 記録が無いとき", () => {
  // 新しい issue（猶予未満）は usedRecently=false でも unused にしない
  expect(computeFlags(meta({ closed_at: "2026-06-01T00:00:00Z" }), ctx()).flags).not.toContain("unused");
  // 古く、かつ未使用なら unused
  expect(computeFlags(meta({ closed_at: "2024-01-01T00:00:00Z" }), ctx()).flags).toContain("unused");
  // 古くても直近使われていれば unused にしない
  expect(computeFlags(meta({ closed_at: "2024-01-01T00:00:00Z" }), ctx({ usedRecently: true })).flags).not.toContain(
    "unused",
  );
});

test("computeFlags: code_drift / reopened / 閾値集計", () => {
  const r = computeFlags(
    meta({ closed_at: "2023-01-01T00:00:00Z", reopened: true }),
    ctx({ missingFiles: ["a.ts"], usedRecently: true }), // unused を分離して old/code_drift/reopened を見る
  );
  expect(r.flags.sort()).toEqual(["code_drift", "old", "reopened"].sort());
  expect(r.flags.length >= 2).toBe(true);
});

test("computeFlags: closed_at 不正は old/unused を立てない", () => {
  expect(computeFlags(meta({ closed_at: undefined }), ctx()).flags).toEqual([]);
});

test("monthsAgoIso: now から月数ぶん過去", () => {
  expect(new Date(monthsAgoIso(NOW, 6)).getTime()).toBeLessThan(NOW.getTime());
});

// --- frontmatter の round-trip（assemble → parse）---
function issue(over: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 7,
    title: "T",
    body: "b",
    labels: [{ name: "priority: med" }, { name: "bug" }],
    comments: 1,
    closed_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
    html_url: "https://github.com/o/r/issues/7",
    ...over,
  };
}

test("parseFrontmatter: assembleMarkdown の出力を読み戻せる", () => {
  const md = assembleMarkdown({
    issue: issue(),
    repo: "o/r",
    body: "## 症状\nx",
    relatedFiles: ["src/a.ts", "src/b.ts"],
  });
  const m = parseFrontmatter(md)!;
  expect(m.issue_number).toBe(7);
  expect(m.repo).toBe("o/r");
  expect(m.reopened).toBe(false);
  expect(m.related_files).toEqual(["src/a.ts", "src/b.ts"]);
  expect(m.labels).toEqual(["priority: med", "bug"]); // コロン入りラベルも正しく
  expect(m.closed_at).toBe("2026-06-01T00:00:00Z");
});

test("parseFrontmatter: 空配列とフロントマターなし", () => {
  const md = assembleMarkdown({ issue: issue(), repo: "o/r", body: "## 症状\nx", relatedFiles: [] });
  expect(parseFrontmatter(md)!.related_files).toEqual([]);
  expect(parseFrontmatter("# 手書き\n\n本文")).toBeNull();
});

test("staleKeyForKey: issue の tombstone と一致し isStaleKey が拾う", () => {
  const key = issueDocKey("", "o/r", 7);
  expect(staleKeyForKey("", key)).toBe(staleDocKey("", "o/r", 7));
  expect(isStaleKey(staleKeyForKey("", key))).toBe(true);
  // prefix 付きでも整合
  const pk = issueDocKey("kb/", "o/r", 7);
  expect(staleKeyForKey("kb/", pk)).toBe(staleDocKey("kb/", "o/r", 7));
});
