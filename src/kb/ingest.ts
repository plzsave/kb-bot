import type { Database } from "bun:sqlite";
import { S3Client } from "../s3.ts";
import type { S3Config } from "../config.ts";
import { chunkMarkdown } from "./chunk.ts";
import { replaceDoc, countChunks, pruneDocsNotIn } from "./db.ts";

// R2/S3 から .md を列挙→取得→チャンク化→FTS5 へ投入する取り込みジョブ。
// 起動時や手動で実行する想定（インデックスは派生物なので何度流しても冪等）。

export interface IngestReport {
  files: number;
  chunks: number;
  skipped: string[]; // 取得/解析に失敗したキー
  removed: number; // S3 から消えた/除外され、索引から掃除した doc 数
}

// _stale/ 配下は kb-prune が隔離したナレッジ。検索から外すため索引対象から除外する。
export function isStaleKey(key: string): boolean {
  return key.startsWith("_stale/") || key.includes("/_stale/");
}

export async function ingest(db: Database, cfg: S3Config, log: (m: string) => void = () => {}): Promise<IngestReport> {
  const s3 = new S3Client(cfg);
  const all = await s3.listKeys();
  const mdKeys = all.filter((k) => k.toLowerCase().endsWith(".md") && !isStaleKey(k));
  log(`列挙: ${all.length} 件中 .md（_stale 除く）は ${mdKeys.length} 件`);

  let totalChunks = 0;
  const skipped: string[] = [];
  for (const key of mdKeys) {
    try {
      const md = await s3.get(key);
      const chunks = chunkMarkdown(md);
      replaceDoc(db, key, chunks);
      totalChunks += chunks.length;
      log(`  ✓ ${key} (${chunks.length} chunks)`);
    } catch (e) {
      skipped.push(key);
      log(`  ✗ ${key}: ${(e as Error).message}`);
    }
  }

  // 現存キー（取得失敗も含む＝S3 には在る）以外を索引から掃除し、S3 の現状に揃える。
  const removed = pruneDocsNotIn(db, mdKeys);
  if (removed > 0) log(`掃除: 索引から ${removed} 件の旧ドキュメントを削除`);

  return { files: mdKeys.length - skipped.length, chunks: totalChunks, skipped, removed };
}

export { countChunks };
