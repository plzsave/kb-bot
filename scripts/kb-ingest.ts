#!/usr/bin/env bun
// R2/S3 の md を取り込んで FTS5 インデックスを構築する。
//   bun run kb:ingest
import { loadS3Config, dbPath } from "../src/config.ts";
import { openDb } from "../src/kb/db.ts";
import { ingest, countChunks } from "../src/kb/ingest.ts";

const cfg = loadS3Config();
const db = openDb(dbPath());

const t0 = Date.now();
const report = await ingest(db, cfg, (m) => console.log(m));
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log("\n=== 取り込み完了 ===");
console.log(`成功 ${report.files} ファイル / 総チャンク ${report.chunks} / 失敗 ${report.skipped.length}`);
console.log(`インデックス総チャンク数: ${countChunks(db)} (DB: ${dbPath()}, ${secs}s)`);
if (report.skipped.length) console.log("失敗キー:", report.skipped.join(", "));
