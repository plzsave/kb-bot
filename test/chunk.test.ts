import { expect, test } from "bun:test";
import { chunkMarkdown } from "../src/kb/chunk.ts";

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
