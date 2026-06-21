import { expect, test } from "bun:test";
import { chunkMarkdown, stripFrontmatter } from "../src/kb/chunk.ts";

test("先頭 frontmatter は索引本文に含めない", () => {
  const md = `---\nsource: github-issue\nlabels: [bug, auth]\n---\n\n# Issue\n\n本文`;
  const chunks = chunkMarkdown(md);
  expect(chunks.length).toBe(1);
  expect(chunks[0]!.heading).toBe("Issue");
  expect(chunks[0]!.text).not.toContain("labels");
  expect(chunks[0]!.text).not.toContain("github-issue");
});

test("本文途中の --- (水平線) は frontmatter として誤除去しない", () => {
  const md = `# A\n\n前半\n\n---\n\n後半`;
  expect(stripFrontmatter(md)).toBe(md);
});

test("閉じ --- が無ければ frontmatter とみなさず素通し", () => {
  const md = `---\nsource: x\n# まだ閉じてない`;
  expect(stripFrontmatter(md)).toBe(md);
});

test("frontmatter 無しはそのまま", () => {
  const md = `# A\n\n本文`;
  expect(stripFrontmatter(md)).toBe(md);
});

test("見出し階層をパンくずとして各チャンクに残す", () => {
  const md = `# A\n\n本文a\n\n## B\n\n本文b`;
  const chunks = chunkMarkdown(md);
  expect(chunks.length).toBe(2);
  expect(chunks[0]!.heading).toBe("A");
  expect(chunks[1]!.heading).toBe("A > B");
  // 本文先頭にもパンくずが前置される
  expect(chunks[1]!.text.startsWith("A > B")).toBe(true);
});

test("コードフェンス内の # は見出し扱いしない", () => {
  const md = "# Title\n\n```\n# not a heading\n```\n";
  const chunks = chunkMarkdown(md);
  expect(chunks.length).toBe(1);
  expect(chunks[0]!.heading).toBe("Title");
});

test("空ドキュメントは空配列", () => {
  expect(chunkMarkdown("   \n\n  ")).toEqual([]);
});

test("通し番号 ord が連番になる", () => {
  const chunks = chunkMarkdown("# A\n\nx\n\n# B\n\ny");
  expect(chunks.map((c) => c.ord)).toEqual([0, 1]);
});
