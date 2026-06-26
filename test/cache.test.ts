import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureCacheTable, getCachedAnswer, putCachedAnswer } from "../src/cache.ts";

function memDb(): Database {
  const db = new Database(":memory:");
  ensureCacheTable(db);
  return db;
}

test("保存した回答を取得できる", () => {
  const db = memDb();
  putCachedAnswer(db, "デプロイ先は？", "ECS Fargate です");
  expect(getCachedAnswer(db, "デプロイ先は？")).toBe("ECS Fargate です");
});

test("未保存はnull", () => {
  expect(getCachedAnswer(memDb(), "未知")).toBeNull();
});

test("正規化（前後空白・大文字小文字・連続空白）で同一視する", () => {
  const db = memDb();
  putCachedAnswer(db, "Deploy Target", "答え");
  expect(getCachedAnswer(db, "  deploy   target  ")).toBe("答え");
});

test("namespace（provider:model）が異なれば別キー＝モデル切替後に旧回答を配信しない", () => {
  const db = memDb();
  putCachedAnswer(db, "デプロイ先は？", "haiku の答え", "anthropic:claude-haiku-4-5");
  // 同じ質問でも namespace が違えば miss（再生成される）
  expect(getCachedAnswer(db, "デプロイ先は？", "anthropic:claude-sonnet-4-6")).toBeNull();
  // 同じ namespace なら hit
  expect(getCachedAnswer(db, "デプロイ先は？", "anthropic:claude-haiku-4-5")).toBe("haiku の答え");
});

test("namespace 省略時は従来互換（空文字 namespace）で一致する", () => {
  const db = memDb();
  putCachedAnswer(db, "質問", "答え"); // namespace 省略
  expect(getCachedAnswer(db, "質問")).toBe("答え");
  expect(getCachedAnswer(db, "質問", "")).toBe("答え");
});

test("TTL（既定24h）を過ぎたキャッシュは失効する", () => {
  const db = memDb();
  putCachedAnswer(db, "古い質問", "古い答え");
  // created_at を 25 時間前に書き換える
  const old = Date.now() - 25 * 3_600_000;
  db.run("UPDATE answer_cache SET created_at = ?", [old]);
  expect(getCachedAnswer(db, "古い質問")).toBeNull(); // 失効
  // 失効時は削除される
  const n = (db.query("SELECT count(*) AS n FROM answer_cache").get() as { n: number }).n;
  expect(n).toBe(0);
});
