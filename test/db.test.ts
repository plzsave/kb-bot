import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, replaceDoc, search, buildMatchQuery, countChunks, dropWeakHits } from "../src/kb/db.ts";
import { chunkMarkdown } from "../src/kb/chunk.ts";

// openDb はパス指定だが ":memory:" でインメモリ DB を開ける（資格情報・ファイル不要）。
function memDb(): Database {
  return openDb(":memory:");
}

test("buildMatchQuery は内容語をフレーズ化して OR で結ぶ", () => {
  const q = buildMatchQuery("認証はどうやる？");
  expect(q).toContain('"認証"');
  expect(q).toContain(" OR ");
});

test("buildMatchQuery は内容語ゼロなら null", () => {
  expect(buildMatchQuery("の、。")).toBeNull();
});

test("取り込み→検索で関連チャンクが最上位に来る", () => {
  const db = memDb();
  replaceDoc(db, "deploy.md", chunkMarkdown("# デプロイ\n\n本番は ECS Fargate で稼働します。"));
  replaceDoc(db, "auth.md", chunkMarkdown("# 認証\n\nログインは Google OIDC を使います。"));
  expect(countChunks(db)).toBe(2);

  const hits = search(db, "デプロイ先はどこ？", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.docKey).toBe("deploy.md");
});

test("dropWeakHits は最上位を残し、極端に弱い末尾を落とす", () => {
  const mk = (score: number) => ({ docKey: "d", heading: "", ord: 0, text: "", score });
  // 最上位 -6、-3 は残す、-0.1（絶対値が10%未満）は落とす
  const out = dropWeakHits([mk(-6), mk(-3), mk(-0.1)]);
  expect(out.map((h) => h.score)).toEqual([-6, -3]);
});

test("dropWeakHits は1件以下ならそのまま", () => {
  const mk = (score: number) => ({ docKey: "d", heading: "", ord: 0, text: "", score });
  expect(dropWeakHits([mk(-0.0001)]).length).toBe(1);
});

test("replaceDoc は同一 docKey を入れ替える（重複しない）", () => {
  const db = memDb();
  replaceDoc(db, "a.md", chunkMarkdown("# A\n\n初版"));
  replaceDoc(db, "a.md", chunkMarkdown("# A\n\n改訂版"));
  expect(countChunks(db)).toBe(1);
});
