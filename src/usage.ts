import type { Database } from "bun:sqlite";

// ナレッジ検索ヒットの記録（retrieved ログ）。回答時に「どのファイルが検索上位に出たか」を
// ファイル単位で残し、kb-prune の unused 判定に使う。個人情報（質問文）は記録しない。
// ※「引用」ではなく「検索上位に retrieved された」記録（検索は毎回上位 N 件を返すため）。

export function ensureUsageTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_usage (
      file_path TEXT,
      served_at TEXT,
      PRIMARY KEY (file_path, served_at)
    )
  `);
}

/** 検索でヒットしたファイル群を記録する（fire-and-forget 用に never throw）。同一秒の重複は無視。 */
export function logUsage(db: Database, filePaths: Iterable<string>, at: Date = new Date()): void {
  try {
    const served = at.toISOString();
    const ins = db.query("INSERT OR IGNORE INTO knowledge_usage (file_path, served_at) VALUES (?, ?)");
    const tx = db.transaction(() => {
      for (const p of new Set(filePaths)) ins.run(p, served);
    });
    tx();
  } catch {
    /* 使用量ログの失敗は回答に影響させない */
  }
}

/** sinceIso 以降に該当ファイルが retrieved された記録があるか。 */
export function usedSince(db: Database, filePath: string, sinceIso: string): boolean {
  const row = db
    .query("SELECT 1 AS x FROM knowledge_usage WHERE file_path = ? AND served_at >= ? LIMIT 1")
    .get(filePath, sinceIso) as { x: number } | null;
  return row != null;
}
