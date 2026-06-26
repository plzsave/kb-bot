import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

// 回答キャッシュ。まず完全一致（正規化後）で照会し、ヒットすれば LLM を呼ばずに返す＝最大の節約。
// 将来は意味的キャッシュ（埋め込み近傍）へ拡張余地。kb.sqlite に同居させる。
//
// TTL: ドキュメントやコードは更新されるため、古いキャッシュは陳腐化する。既定 24h で失効させ、
// 期限切れは照会時に削除する（再生成される）。KB_CACHE_TTL_HOURS=0 で無期限（失効しない）。
const TTL_MS = (() => {
  const h = Number(process.env.KB_CACHE_TTL_HOURS);
  return Number.isFinite(h) && h >= 0 ? h * 3_600_000 : 24 * 3_600_000;
})();

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

// キーは「namespace + 正規化質問」のハッシュ。namespace に provider:model を入れることで、
// KB_MODEL/プロバイダを切り替えた後に旧モデルが生成した回答が配信されるのを防ぐ
// （別 namespace＝別キー＝miss して新モデルで再生成される）。未指定なら "" で従来互換。
function keyFor(q: string, namespace: string): string {
  return createHash("sha256").update(`${namespace}\0${normalize(q)}`).digest("hex");
}

export function getCachedAnswer(db: Database, question: string, namespace = ""): string | null {
  const key = keyFor(question, namespace);
  const row = db.query("SELECT answer, created_at FROM answer_cache WHERE key = ?").get(key) as
    | { answer: string; created_at: number }
    | null;
  if (!row) return null;
  // 期限切れは失効させる（削除して miss 扱い＝次回再生成）。
  if (TTL_MS > 0 && Date.now() - row.created_at > TTL_MS) {
    db.run("DELETE FROM answer_cache WHERE key = ?", [key]);
    return null;
  }
  db.run("UPDATE answer_cache SET hits = hits + 1 WHERE key = ?", [key]);
  return row.answer;
}

export function putCachedAnswer(db: Database, question: string, answer: string, namespace = ""): void {
  db.run(
    "INSERT OR REPLACE INTO answer_cache (key, question, answer, created_at, hits) VALUES (?, ?, ?, ?, 0)",
    [keyFor(question, namespace), question, answer, Date.now()],
  );
}
