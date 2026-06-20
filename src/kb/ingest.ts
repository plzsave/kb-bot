import type { Database } from "bun:sqlite";
import { S3Client } from "../s3.ts";
import type { S3Config } from "../config.ts";
import { chunkMarkdown } from "./chunk.ts";
import { replaceDoc, countChunks } from "./db.ts";

// R2/S3 から .md を列挙→取得→チャンク化→FTS5 へ投入する取り込みジョブ。
// 起動時や手動で実行する想定（インデックスは派生物なので何度流しても冪等）。

export interface IngestReport {
  files: number;
  chunks: number;
  skipped: string[]; // 取得/解析に失敗したキー
}

export async function ingest(db: Database, cfg: S3Config, log: (m: string) => void = () => {}): Promise<IngestReport> {
  const s3 = new S3Client(cfg);
  const all = await s3.listKeys();
  const mdKeys = all.filter((k) => k.toLowerCase().endsWith(".md"));
  log(`列挙: ${all.length} 件中 .md は ${mdKeys.length} 件`);

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

  return { files: mdKeys.length - skipped.length, chunks: totalChunks, skipped };
}

export { countChunks };
