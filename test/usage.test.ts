import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureUsageTable, logUsage, usedSince } from "../src/usage.ts";

function memDb(): Database {
  const db = new Database(":memory:");
  ensureUsageTable(db);
  return db;
}

test("logUsage→usedSince: 記録した日時以降は true、未来境界は false", () => {
  const db = memDb();
  const at = new Date("2026-06-01T00:00:00Z");
  logUsage(db, ["a.md", "b.md"], at);
  expect(usedSince(db, "a.md", "2026-01-01T00:00:00Z")).toBe(true);
  expect(usedSince(db, "a.md", "2026-12-01T00:00:00Z")).toBe(false);
  expect(usedSince(db, "missing.md", "2026-01-01T00:00:00Z")).toBe(false);
});

test("logUsage: 同一ファイルの重複（同秒）は PK で 1 件に集約", () => {
  const db = memDb();
  const at = new Date("2026-06-01T00:00:00Z");
  logUsage(db, ["a.md", "a.md"], at);
  logUsage(db, ["a.md"], at);
  const n = (db.query("SELECT count(*) AS n FROM knowledge_usage").get() as { n: number }).n;
  expect(n).toBe(1);
});
