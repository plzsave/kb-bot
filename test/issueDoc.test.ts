import { expect, test } from "bun:test";
import {
  shouldInclude,
  buildUserPrompt,
  parseSummary,
  assembleMarkdown,
  issueDocKey,
  staleDocKey,
} from "../src/kb/issueDoc.ts";
import { isStaleKey } from "../src/kb/ingest.ts";
import { stripFrontmatter, chunkMarkdown } from "../src/kb/chunk.ts";
import type { RawIssue } from "../src/issues.ts";

function issue(over: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 42,
    title: "ログインが失敗する",
    body: "x".repeat(60),
    labels: [{ name: "bug" }],
    comments: 2,
    closed_at: "2025-03-01T00:00:00Z",
    updated_at: "2025-03-02T00:00:00Z",
    html_url: "https://github.com/o/r/issues/42",
    ...over,
  };
}

test("shouldInclude: 除外ラベル/コメント不足/短すぎ本文を弾く", () => {
  expect(shouldInclude(issue(), 1)).toBe(true);
  expect(shouldInclude(issue({ labels: [{ name: "wontfix" }] }), 1)).toBe(false);
  expect(shouldInclude(issue({ comments: 0 }), 1)).toBe(false);
  expect(shouldInclude(issue({ body: "短い" }), 1)).toBe(false);
});

test("parseSummary: 関連ファイル行を抽出し本文から除く / 前置きとフェンスに強い", () => {
  const raw =
    "```markdown\nはい、まとめます。\n## 症状\nログイン不可\n## 原因\nトークン失効\n## 解決策\n`src/auth.ts` を修正\n関連ファイル: `src/auth.ts`, src/session.ts\n```";
  const { body, relatedFiles } = parseSummary(raw);
  expect(body.startsWith("## 症状")).toBe(true);
  expect(body).not.toContain("関連ファイル");
  expect(body).not.toContain("まとめます");
  expect(relatedFiles).toEqual(["src/auth.ts", "src/session.ts"]);
});

test("parseSummary: 関連ファイルなし", () => {
  const { relatedFiles } = parseSummary("## 症状\nx\n関連ファイル: なし");
  expect(relatedFiles).toEqual([]);
});

test("assembleMarkdown: frontmatter は剥がせて本文は索引可能", () => {
  const md = assembleMarkdown({
    issue: issue(),
    repo: "o/r",
    body: "## 症状\nログイン不可\n\n## 原因\n不明\n\n## 解決策\n修正済み",
    relatedFiles: ["src/auth.ts"],
  });
  // frontmatter が先頭にある
  expect(md.startsWith("---\n")).toBe(true);
  expect(md).toContain("issue_number: 42");
  expect(md).toContain("related_files:\n  - src/auth.ts");
  // stripFrontmatter で剥がれ、本文だけ残る
  const stripped = stripFrontmatter(md);
  expect(stripped.startsWith("# Issue #42")).toBe(true);
  expect(stripped).not.toContain("issue_number");
  // chunk しても frontmatter のキーは索引本文に出ない
  const text = chunkMarkdown(md).map((c) => c.text).join("\n");
  expect(text).not.toContain("issue_number");
  expect(text).toContain("ログイン不可");
});

test("assembleMarkdown: related_files 空は [] 表記", () => {
  const md = assembleMarkdown({ issue: issue(), repo: "o/r", body: "## 症状\nx", relatedFiles: [] });
  expect(md).toContain("related_files: []");
});

test("assembleMarkdown: コロンを含むラベルはクォートされ YAML として有効", () => {
  const md = assembleMarkdown({
    issue: issue({ labels: [{ name: "priority: med" }, { name: "bug" }] }),
    repo: "o/r",
    body: "## 症状\nx",
    relatedFiles: [],
  });
  expect(md).toContain('labels: ["priority: med", "bug"]');
});

test("buildUserPrompt: 予算超過で中間コメントを間引く", () => {
  const big = (n: number) => ({ body: "z".repeat(5000), user: { login: `u${n}` }, created_at: "" });
  const comments = Array.from({ length: 10 }, (_, i) => big(i));
  const out = buildUserPrompt({ issue: issue(), comments }, 12_000);
  expect(out.length).toBeLessThanOrEqual(12_000);
  expect(out).toContain("中略");
});

test("issueDocKey / staleDocKey: prefix と _stale 整合", () => {
  expect(issueDocKey("", "o/r", 42)).toBe("knowledge/github-issues/o-r/42.md");
  expect(issueDocKey("kb/", "o/r", 42)).toBe("kb/knowledge/github-issues/o-r/42.md");
  const stale = staleDocKey("", "o/r", 42);
  expect(isStaleKey(stale)).toBe(true);
  expect(isStaleKey(issueDocKey("", "o/r", 42))).toBe(false);
});
