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
