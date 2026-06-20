import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

// 回答キャッシュ。まず完全一致（正規化後）で照会し、ヒットすれば LLM を呼ばずに返す＝最大の節約。
// 将来は意味的キャッシュ（埋め込み近傍）へ拡張余地。kb.sqlite に同居させる。

export function ensureCacheTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS answer_cache (
      key TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function normalize(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function keyFor(q: string): string {
  return createHash("sha256").update(normalize(q)).digest("hex");
}

export function getCachedAnswer(db: Database, question: string): string | null {
  const row = db.query("SELECT answer FROM answer_cache WHERE key = ?").get(keyFor(question)) as
    | { answer: string }
    | null;
  if (!row) return null;
  db.run("UPDATE answer_cache SET hits = hits + 1 WHERE key = ?", [keyFor(question)]);
  return row.answer;
}

export function putCachedAnswer(db: Database, question: string, answer: string): void {
  db.run(
    "INSERT OR REPLACE INTO answer_cache (key, question, answer, created_at, hits) VALUES (?, ?, ?, ?, 0)",
    [keyFor(question), question, answer, Date.now()],
  );
}
