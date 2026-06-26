import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, replaceDoc, search, buildMatchQuery, countChunks, dropWeakHits, pruneDocsNotIn } from "../src/kb/db.ts";
import { chunkMarkdown } from "../src/kb/chunk.ts";
import { isStaleKey, isReservedKey } from "../src/kb/ingest.ts";

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

test("pruneDocsNotIn は keep 外の doc を消し、件数を返す", () => {
  const db = memDb();
  replaceDoc(db, "a.md", chunkMarkdown("# A\n\n認証の手順"));
  replaceDoc(db, "b.md", chunkMarkdown("# B\n\nデプロイの設定"));
  replaceDoc(db, "c.md", chunkMarkdown("# C\n\n課金の仕組み"));
  const removed = pruneDocsNotIn(db, ["a.md", "c.md"]);
  expect(removed).toBe(1); // b.md が消える
  expect(countChunks(db)).toBe(2);
  expect(search(db, "デプロイ", 5).length).toBe(0);
  expect(search(db, "認証", 5).length).toBeGreaterThan(0);
});

test("pruneDocsNotIn は keep 空なら全削除", () => {
  const db = memDb();
  replaceDoc(db, "a.md", chunkMarkdown("# A\n\n認証の手順"));
  expect(pruneDocsNotIn(db, [])).toBe(1);
  expect(countChunks(db)).toBe(0);
});

test("isStaleKey は _stale 配下を判定", () => {
  expect(isStaleKey("knowledge/_stale/github-issues/x-y/1.md")).toBe(true);
  expect(isStaleKey("_stale/1.md")).toBe(true);
  expect(isStaleKey("knowledge/github-issues/x-y/1.md")).toBe(false);
});

test("isReservedKey は _config 配下を判定（追加プロンプト等を索引から外す）", () => {
  expect(isReservedKey("_config/system-prompt.md")).toBe(true);
  expect(isReservedKey("knowledge/_config/system-prompt.md")).toBe(true);
  expect(isReservedKey("knowledge/system-prompt.md")).toBe(false);
});
